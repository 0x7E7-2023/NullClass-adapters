(function () {
    // 北部湾大学教务适配器（新一代金智「智慧教务」resourceapi）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 BBGU/bbgu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（提交 29498b0，2026-11-03）
    //   本校脚本最后一次修改 80e30cf
    // 纯转换骨架（周次 / 节次 / 合并 / 节次补齐 / 提醒限长）借自已审计件 hueb（正方平台，与本校平台不同），取数与字段映射按上游 bbgu.js 重写。
    //
    // 上游在同一段脚本里算周次、拼课程、存配置；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑）。
    // 输入（extract.js 交出来的）：term（学年 / 学期名 / 起止日期）、pick（选学期的方式）、today、
    // periodLists（节次时间，取不到是 null）、raw.rows（课表行，只带白名单字段）。
    //
    // 移植改动（按移植手册 §4 与本批检查表逐条对照）：
    //   ① 字段映射：courseName → 课名，instructorName → 教师，roomName + campusName → 教室（上游拼成「教室（校区）」），
    //      weekDay → 星期，periodFormat → 节次（如 "10-11"），teachingWeekFormat → 周次（如 "1-4,6-9"）
    //   ② 周次：上游只认 "1-4,6-9" 这种；这里用 hueb 的周次解析（同时认 (单)/(双)、「第」、括号备注），
    //      认不出的周次原文写进提醒，课不静默丢
    //   ③ 教师 / 教室：「未知」「待定」「暂无」等一律当没有（交出去是 null）；缺了照常导入，按类型汇总写进提醒。
    //      上游缺教师会写「未知」、缺教室会写「待定」，这两处都改成 null
    //   ④ 节次时间：优先用 get-large-period 的各组（上游是把各组拼在一起用的）；取不到或不合规整张用默认表并提醒。
    //      上游没有写死的节次表，所以这里的默认表是空课自己的 12 节表（与 hueb 同一张），不是学校的
    //   ⑤ 学期：取教务标为当前的学期（pick = active）；没有标的按今天的日期选（pick = date）；都选不出取第一个（pick = first），
    //      三种都写进提醒，学期名用教务给的学年与学期（「2026-2027学年第一学期」），不弹窗、不用适配器名
    //   ⑥ 开学日与总周数：开学日取教务学期的开始日期（回退到那一周的周一，手册 §4.3）；总周数按开始到结束日期算，
    //      取不到就 20 周；课表里有更晚的周就抬到那一周并提醒（不再调用上游的最大周次接口）
    //   ⑦ 同课合并（完全相同行去重 → 节次首尾相接合并 → 同节次周次并集）与 hueb 同一套两阶段
    //   ⑧ 上游的弹窗、保存、提示桥（showAlert、saveImportedCourses、saveCourseConfig、savePresetTimeSlots 等）不移植
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var raw = data.raw || {};
    var rows = Array.isArray(raw.rows) ? raw.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '北部湾大学';    // 学期名兜底时用（拿不到学年时「学校名 + 学期」，不用适配器名）
    var DEFAULT_TOTAL_WEEKS = 20;  // 学期总周数：教务没给起止日期时用 20 周（与上游一致）
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名、教务原文最多显示的字数
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟

    // 默认节次表（空课自己的 12 节表，逐节照 hueb 的同一张表）：教务没给节次时间时用，并在提醒里说明
    var DEFAULT_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:55', end: '15:40' },
        { periodIndex: 7, start: '16:00', end: '16:45' },
        { periodIndex: 8, start: '16:55', end: '17:40' },
        { periodIndex: 9, start: '18:30', end: '19:15' },
        { periodIndex: 10, start: '19:25', end: '20:10' },
        { periodIndex: 11, start: '20:20', end: '21:05' },
        { periodIndex: 12, start: '21:15', end: '22:00' }
    ];

    var KIND_CN = { first: '一', second: '二', third: '三' };
    // 没有起止日期时的开学日推算锚点（只用来估，结果一律写进提醒）
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '秋季学期一般 9 月初开学' },
        second: { month: 2, day: 20, rule: '春季学期一般 2 月下旬开学' },
        third: { month: 7, day: 1, rule: '夏季学期一般 7 月初开学' }
    };
    // 教师 / 教室写成这些词，等同于没有（交出去是 null）
    var NO_TEACHER = { '未知': 1, '待定': 1, '暂无': 1, '暂无教师': 1 };
    var NO_PLACE = { '未知': 1, '待定': 1, '暂无': 1, '暂无教室': 1 };

    // ---------- 通用小工具 ----------
    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 教务原文过长时截短（课名、学期名、校区名、周次原文都经过这里），避免撑破整条提醒的 200 字上限
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    // 字典里有多少个键（用对象当字典，ES5 下不引入 Set / Map）
    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
    }

    // 年-月-日 → ISO 日期（只认年月日，后面的时间部分忽略）；认不出返回 null
    function isoOfAny(value) {
        var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function mondayOfIso(iso) {
        if (!iso) return null;
        return isoOf(mondayOnOrBefore(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10),
            parseInt(iso.substring(8, 10), 10)
        ));
    }

    function daysOf(iso) {
        return Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        );
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // "08:10" / "08:10:00" → "08:10"；认不出（含 24:00、85:45）返回 null。载荷要求 HH:mm 且 00:00–23:59
    function timeOf(value) {
        var m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(text(value));
        if (!m) return null;
        return (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2];
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    // 节次号（已升序）写成「第 9-12 节」「第 9、11-12 节」
    function sectionsText(list) {
        var runs = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            runs.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + runs.join('、') + ' 节';
    }

    // ---------- warnings（载荷上限 20 条 × 200 字，超了整包会被拒，所以由这里统一收口） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 学期名、学期序号、开学日、总周数 ----------
    // 学期序号：教务的学期名「春」= 第二学期，「夏」= 第三学期，其余（「秋」）= 第一学期（与上游把非春季都当秋季一致）
    function termKind() {
        var label = text(term.term);
        if (label.indexOf('春') >= 0) return 'second';
        if (label.indexOf('夏') >= 0) return 'third';
        return 'first';
    }

    // 学年起始年：「2026-2027」或「2026」→ 2026；读不出返回 0
    function termYear() {
        var m = /^([0-9]{4})(-[0-9]{4})?$/.exec(text(term.year));
        return m ? parseInt(m[1], 10) : 0;
    }

    function termName() {
        var year = text(term.year);
        var kind = termKind();
        if (/^[0-9]{4}-[0-9]{4}$/.test(year)) return year + '学年第' + KIND_CN[kind] + '学期';
        if (/^[0-9]{4}$/.test(year)) return year + '-' + (parseInt(year, 10) + 1) + '学年第' + KIND_CN[kind] + '学期';
        // 学年读不出来：学校名 + 学期，不用适配器名
        return SCHOOL_NAME + ' 第' + KIND_CN[kind] + '学期';
    }

    // 教务没给起止日期时的开学日推算：依赖学期序号的锚点，推算结果一律写进提醒
    function estimateStart(todayIso) {
        var kind = termKind();
        var year = termYear();
        if (!year) return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天所在的那一周' };
        var anchor = KIND_ANCHOR[kind];
        return {
            iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), anchor.month, anchor.day)),
            rule: anchor.rule
        };
    }

    // 学期起止日期 → 学期覆盖的周数（不满一周按一周算）；日期不通或结束早于开始返回 0
    function weeksBetween(beginIso, endIso) {
        if (!beginIso || !endIso) return 0;
        var days = Math.round((daysOf(endIso) - daysOf(beginIso)) / 86400000);
        if (isNaN(days) || days < 0) return 0;
        return Math.ceil((days + 1) / 7);
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。教务写法：「1-4,6-9」、「1-16周(单)」、「(单)1-16周」、「1-8周(单),9-16周(双)」、
    // 「第1-第8周」、「1-3,5-9周」等。要点（沿用 hueb 的已审计写法）：
    //   ① 「周」「第」只是量词，先删掉再切段；「共 N 周」备注只剥备注本身，不吞后面的周次段；
    //   ② 单 / 双标记只跟它自己那一段走（前置、后置、无逗号的前置都要读对）；
    //   ③ 括号里只有数字的（"(1)"）是教学班序号整组摘掉；含非周次字的（"(3组)"）也摘掉并计数写进提醒；
    //   ④ 破折号连同两侧空白归一成 '-'，剩下的空白当分段符。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单/双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数
    var noteGroups = 0;      // 被摘掉的备注括号个数
    var noteSample = '';     // 第一个备注括号的原文，写进提醒（截短）
    var bothMarks = 0;       // 同时写了「单」和「双」的段数（按每周都上处理，要说出来）

    function fullWidthToHalf(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[，、；;]/g, ',')
            .replace(/[～~—－–至]/g, '-');
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // 「共8周」是课程总周数备注，只剥备注本身
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 「第1-第8周」里的「第」只是量词，删掉，免得终点被拆成两个周
        cleaned = cleaned.replace(/第/g, '');
        // 破折号（半角 / 全角 / 波浪 / 至 / 到）连同两侧空白 → 半角 '-'
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 紧挨周次的单 / 双括号先归属：前置「(单)1-8周,(双)9-16周」与后置「1-8周(单),9-16周(双)」都要读对
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 夹在两段中间的前置标记（「(单)1-8周(双)9-16周」的第二个）：本段以前置标记开头时它归下一段
            if (/^\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            return digit + mark + (/^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '');
        });
        // 括号逐组处理：只有数字的是教学班序号，整组摘掉；含非周次字的是备注，也摘掉另计；其余保留内容
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周第-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = shortName(all);
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        // 剩下的空白当分段符
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
        // 单 / 双自己成一段时并给最近的周次段（就近向前找，找不到再向后）
        for (i = 0; i < segments.length; i++) {
            if (/[0-9]/.test(segments[i])) continue;
            if (segments[i].indexOf('单') < 0 && segments[i].indexOf('双') < 0) continue;
            var into = -1;
            var near;
            for (near = i - 1; near >= 0; near--) {
                if (/[0-9]/.test(segments[near])) { into = near; break; }
            }
            for (near = i + 1; into < 0 && near < segments.length; near++) {
                if (/[0-9]/.test(segments[near])) { into = near; break; }
            }
            if (into < 0) { orphanMarkers++; continue; }
            segments[into] = segments[into] + segments[i];
            segments[i] = '';
        }
        var seen = {};
        var weeks = [];
        for (i = 0; i < segments.length; i++) {
            var segment = segments[i];
            if (!segment || !/[0-9]/.test(segment)) continue;
            var onlyOdd = segment.indexOf('单') >= 0;
            var onlyEven = segment.indexOf('双') >= 0;
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:[ ]*-[ ]*[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                for (var week = start; week <= end; week++) {
                    if (onlyOdd && week % 2 === 0) continue;
                    if (onlyEven && week % 2 === 1) continue;
                    if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
                    if (!seen[week]) { seen[week] = true; weeks.push(week); }
                }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j], weekType: 'ALL' };
            if (step === 2 && run.start !== run.end) {
                run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            }
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // ---------- 节次 ----------
    // 节次文本 → {start, end, sparse}；读不出返回 null（调用方计数进提醒，不静默丢课）。
    // 认「1-2」「3-4」「1,2」「第9-10节」，以及每节两位拼成的「0102」；括号里的纯数字是序号，先摘掉。
    var sparseRows = 0;   // 节次写成多段（"1-2,5-6"）的行数
    function sectionsOf(source) {
        var cleaned = fullWidthToHalf(text(source))
            .replace(/\([ ]*[0-9]+[ ]*\)/g, '')
            .replace(/节/g, '')
            .replace(/[ ]+/g, '');
        if (!cleaned) return null;
        var pieces = cleaned.split(/,+/);
        var numbers = [];
        var i;
        for (i = 0; i < pieces.length; i++) {
            var piece = pieces[i];
            if (!piece) continue;
            var range = /^第?([0-9]{1,2})[-]([0-9]{1,2})$/.exec(piece);
            if (range) {
                var from = parseInt(range[1], 10);
                var to = parseInt(range[2], 10);
                if (to < from) { var swap = from; from = to; to = swap; }
                for (var n = from; n <= to; n++) numbers.push(n);
                continue;
            }
            if (/^第?[0-9]{1,2}$/.test(piece)) {
                numbers.push(parseInt(piece.replace(/[^0-9]/g, ''), 10));
                continue;
            }
            if (/^[0-9]{4}$/.test(piece)) {
                numbers.push(parseInt(piece.substring(0, 2), 10));
                numbers.push(parseInt(piece.substring(2), 10));
                continue;
            }
            return null;
        }
        if (!numbers.length) return null;
        var start = numbers[0];
        var end = numbers[0];
        var unique = [];
        var seenNo = {};
        for (i = 0; i < numbers.length; i++) {
            var value = numbers[i];
            if (value < start) start = value;
            if (value > end) end = value;
            if (!seenNo[value]) { seenNo[value] = true; unique.push(value); }
        }
        if (start < 1 || end > MAX_PERIOD) return null;
        unique.sort(function (a, b) { return a - b; });
        var sparse = false;
        for (i = 1; i < unique.length; i++) {
            if (unique[i] - unique[i - 1] !== 1) sparse = true;
        }
        if (sparse) sparseRows++;
        return { start: start, end: end, sparse: sparse };
    }

    // ---------- 教师 / 教室 ----------
    // 教师：去掉方括号「[主讲]」与圆括号备注「（外聘）」（备注不是名字，不拆第二位教师），分号换成顿号；
    // 空、或「未知 / 待定 / 暂无」一律 null
    function teacherOf(source) {
        var cleaned = String(source === null || source === undefined ? '' : source)
            .replace(/\[[^\]]*\]/g, '')
            .replace(/[(（][^)）]*[)）]/g, '')
            .replace(/[;；]+/g, '、');
        cleaned = text(cleaned).replace(/^[、\s]+|[、\s]+$/g, '');
        if (!cleaned || NO_TEACHER[cleaned]) return null;
        return cleaned;
    }

    // 教室：教室 +（校区）；只有其一用其一；都没有或写成「未知 / 待定」返回 null
    function placeOf(room, campus) {
        var r = text(room);
        var c = text(campus);
        if (NO_PLACE[r]) r = '';
        if (NO_PLACE[c]) c = '';
        if (r && c) return r + '（' + c + '）';
        return r || c || null;
    }

    // ---------- 节次时间 ----------
    // 教务接口给的各组（periodLists）拼在一起：同号同时间的去重；编号要从 1 连续、时间递增不重叠，
    // 同一节两种时间、或不连续，都说不清 → 返回 null（当没取到，用默认表并提醒），不猜
    function periodTimesOf(lists) {
        if (!lists || !lists.length) return null;
        var byIndex = {};
        var maxIndex = 0;
        for (var g = 0; g < lists.length; g++) {
            var list = Array.isArray(lists[g]) ? lists[g] : [];
            for (var i = 0; i < list.length; i++) {
                var row = list[i] || {};
                var index = intOf(row.smallPeriod);
                var start = timeOf(row.startTime);
                var end = timeOf(row.endTime);
                if (index === null || index < 1 || !start || !end) return null;
                if (minutesOf(start) >= minutesOf(end)) return null;
                var value = start + '-' + end;
                if (byIndex[index] !== undefined && byIndex[index] !== value) return null;
                byIndex[index] = value;
                if (index > maxIndex) maxIndex = index;
            }
        }
        if (!maxIndex) return null;
        var slots = [];
        var lastEnd = -1;
        for (var k = 1; k <= maxIndex; k++) {
            if (byIndex[k] === undefined) return null;
            var parts = byIndex[k].split('-');
            if (minutesOf(parts[0]) < lastEnd) return null;
            lastEnd = minutesOf(parts[1]);
            slots.push({ periodIndex: k, start: parts[0], end: parts[1] });
        }
        return slots;
    }

    // ---------- 同课合并（与 hueb 同一套两阶段语义） ----------
    var byName = {};
    var courses = [];
    var entries = [];

    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + (teacher || '');
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, note: null, blocks: [] };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    // 完全相同的行只留第一条（阶段 1 之前做，否则合并后才出现的重复会漏网）
    function dropExactDuplicates(list) {
        var ledger = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var key = 'k' + JSON.stringify([entry.name, entry.teacher, entry.location, entry.day, entry.start, entry.end, entry.weeks]);
            if (ledger[key]) continue;
            ledger[key] = true;
            out.push(entry);
        }
        return out;
    }

    function cmpText(a, b) {
        var x = a === null ? '' : String(a);
        var y = b === null ? '' : String(b);
        return x < y ? -1 : (x > y ? 1 : 0);
    }

    function sameSlotDay(a, b) {
        return a.name === b.name && a.teacher === b.teacher && a.location === b.location && a.day === b.day;
    }

    function weeksKey(entry) {
        return entry.weeks.join(',');
    }

    function orderStageOne(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || cmpText(weeksKey(a), weeksKey(b)) || (a.start - b.start);
    }

    function orderStageTwo(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end);
    }

    function unionWeeks(a, b) {
        var all = a.concat(b);
        var have = {};
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (have[all[i]]) continue;
            have[all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    // 阶段 1：同课、同周次、节次首尾相接（end + 1 === start）合成一条；重复行已先去掉
    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next)) {
                if (current.end + 1 === next.start) { current.end = next.end; continue; }
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    // 阶段 2：同课、同节次的，周次取并集
    function mergeStageTwo(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && current.start === next.start && current.end === next.end) {
                current.weeks = unionWeeks(current.weeks, next.weeks);
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    // ---------- 逐行转换（先按内容去重，再解析、再计数） ----------
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var missingTeacherCourses = {};   // 没给上课教师的课（按课名去重，提醒里说「N 门课」才准）
    var missingLocationCourses = {};  // 没给上课教室的课
    var fieldSamples = [];            // 这两类课里点名用的课名，最多 3 个（截短）
    var weekSamples = [];             // 没解析出周次的原始文本，最多 3 个（截短）
    var maxWeek = 0;
    var maxPeriod = 0;
    var rowSeen = {};

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var rowKey = 'k' + JSON.stringify([row.courseName, row.instructorName, row.roomName, row.campusName,
            row.weekDay, row.periodFormat, row.teachingWeekFormat]);
        if (rowSeen[rowKey]) continue;
        rowSeen[rowKey] = true;

        var name = text(row.courseName);
        if (!name) { missing.name++; continue; }

        var day = intOf(row.weekDay);
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOf(row.periodFormat);
        if (!sections) { missing.period++; continue; }

        var weeks = weeksOf(row.teachingWeekFormat);
        if (!weeks.length) {
            missing.week++;
            var sample = shortName(row.teachingWeekFormat);
            if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
            continue;
        }

        var teacher = teacherOf(row.instructorName);
        var location = placeOf(row.roomName, row.campusName);
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(shortName(name)) < 0) {
            fieldSamples.push(shortName(name));
        }
        entries.push({
            course: courseOf(name, teacher),
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            start: sections.start,
            end: sections.end,
            weeks: weeks
        });
    }

    entries = dropExactDuplicates(entries);
    entries.sort(orderStageOne);
    var merged = mergeStageOne(entries);
    merged.sort(orderStageTwo);
    merged = mergeStageTwo(merged);

    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            if (run.end > maxWeek) maxWeek = run.end;
            if (item.end > maxPeriod) maxPeriod = item.end;
            item.course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item.location
            });
        }
    }

    if (!courses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开课表页确认能看到课表后再试'
        );
    }

    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: courses[c].note,
            blocks: courses[c].blocks
        });
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var beginIso = isoOfAny(term.beginDate);
    var endIso = isoOfAny(term.endDate);
    // 和开学日同一起点（开学那周的周一），否则开学日不是周一时总周数会少算一周
    var calendarWeeks = weeksBetween(mondayOfIso(beginIso), endIso);

    var start;
    if (beginIso) {
        start = { iso: mondayOfIso(beginIso), rule: '教务给的学期开始日期' };
    } else {
        start = estimateStart(todayIso);
    }

    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : DEFAULT_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    // ---------- 节次时间：教务给的优先；取不到整张用默认表；课表用到的更晚节次逐节补，补不了如实说明 ----------
    var apiPeriodTimes = periodTimesOf(data.periodLists);
    var usedDefault = !apiPeriodTimes;
    var periodTimes = usedDefault ? DEFAULT_PERIOD_TIMES.slice(0) : apiPeriodTimes.slice(0);
    var tableLength = periodTimes.length;
    var fromDefault = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = tableLength + 1; p <= maxPeriod; p++) {
        var prev = periodTimes.length ? periodTimes[periodTimes.length - 1] : null;
        var prevEnd = prev ? minutesOf(prev.end) : -1;
        var builtinSlot = DEFAULT_PERIOD_TIMES[p - 1];
        // 默认表有这一节、且它的开始不早于上一节下课，才用默认时间（否则会和上一节重叠甚至倒挂）
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: builtinSlot.start, end: builtinSlot.end });
            fromDefault.push(p);
            continue;
        }
        // 否则从上一节下课后顺推；顺推越过 23:59 就停，这一节起不再补
        if (!prev) { uncoveredFrom = p; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---------- 提醒（顺序固定：选了哪个学期、开学日、总周数、节次时间、丢了什么） ----------
    var pickWarn = {
        active: '已导入教务系统标为当前的学期「' + shortName(name0) + '」；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」',
        date: '教务系统没有标出当前学期，已按今天的日期选了「' + shortName(name0) +
            '」，请核对是不是这个学期；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」',
        first: '教务系统没有标出当前学期，今天也不在任何一个学期里，先导入了列表里第一个学期「' + shortName(name0) +
            '」，请核对是不是这个学期；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」'
    };
    warn(pickWarn[data.pick] || pickWarn.first);

    if (beginIso) {
        warn('开学日期取自教务系统给的学期开始日期：第 1 周从 ' + start.iso + ' 开始，请在学期管理里核对');
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start.rule + '」推算为 ' + start.iso +
            '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raisedBySchedule && calendarWeeks > 0) {
        warn(
            '学期起止日期算出 ' + calendarWeeks + ' 周，课表里有第 ' + maxWeek + ' 周的课，' +
            '已把学期总周数改为 ' + totalWeeks + ' 周（否则那几周的课放不下）'
        );
    } else if (raisedBySchedule) {
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过了默认的 ' + DEFAULT_TOTAL_WEEKS +
            ' 周，学期总周数已改为 ' + totalWeeks + ' 周，如与实际不符可在学期管理里改'
        );
    } else if (calendarWeeks > 0) {
        warn(
            '学期总周数按教务给的学期起止日期算为 ' + totalWeeks + ' 周' +
            (clamped ? '，已按最多 ' + MAX_WEEK + ' 周导入' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出可用的学期起止日期，学期总周数按 ' + DEFAULT_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (usedDefault) {
        warn(
            '教务系统没有给出节次时间，已按默认的 ' + DEFAULT_PERIOD_TIMES.length +
            ' 节时间导入（第 1 节 ' + DEFAULT_PERIOD_TIMES[0].start + '-' + DEFAULT_PERIOD_TIMES[0].end +
            '），时间可能与学校实际不符，请在学期管理里核对'
        );
    }
    if (fromDefault.length || bySequence.length) {
        var fillTexts = [];
        if (fromDefault.length) fillTexts.push(sectionsText(fromDefault) + '用默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromDefault.concat(bySequence).sort(function (a, b) { return a - b; });
        warn(
            '课表用到了' + sectionsText(filledAll) + '，现有的节次时间没有覆盖，已补上：' + fillTexts.join('，') +
            '，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 行');
        if (missing.period) reasons.push('缺节次（或节次超出 1-' + MAX_PERIOD + ' 节）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (weekSamples.length) {
            reasons.push('认不出的周次写法如「' + weekSamples.join('」「') + '」');
        }
        warn(
            '有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }
    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课教室');
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或教室暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '教室暂时空着');
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + fieldSamples.join('、') + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上'
        );
    }
    if (serialGroups > 0) {
        warn(
            '有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，' +
            '已忽略，请核对这几门课的周次'
        );
    }
    if (noteGroups > 0) {
        warn(
            '有 ' + noteGroups + ' 处周次里的括号备注（如「' + noteSample + '」）不是周次，' +
            '已忽略，请核对这几门课的周次'
        );
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    }
    if (orphanMarkers > 0) {
        warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次（教务数据写得不完整），这些标记已忽略');
    }
    if (bothMarks > 0) {
        warn('有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对');
    }
    if (sparseRows > 0) {
        warn(
            '有 ' + sparseRows + ' 行课表的节次写成了多段（例如「1-2,5-6」），已按最大跨度放入' +
            '（中间几节也算上），请核对'
        );
    }

    // 兜底：真到了上限就说清楚（正常路径下这些计数永远是 0）
    if (droppedWarnings > 0) {
        warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [
            {
                name: name0,
                firstDay: start.iso,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
