(function () {
    // 江西飞行学院教务适配器（Struts2 教务平台 xsgrkbcx 族）—— 第二步：教务原始排课行 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 JXFU/JXFU_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 dezige131）
    //   上游快照 e15c6274ac347c9642da890504651a9b4e374391（2026-10-26 拉取）
    //   本校脚本最后一次修改 80e30cf（2026-09-23，仓库整理提交）
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① 节次时间照上游写死的 11 节表逐节搬过来（第 1 节 08:00 … 第 11 节 21:35 下课），随载荷交出；
    //      课表用到第 11 节之后的节次时，照批次五统一修订 H3 逐节补（空课默认节次表接得上就用，接不上按课间 5 分钟、每节 45 分钟顺推，
    //      越过 23:59 就停），补了哪些、哪些补不了都写进提醒
    //   ② 上游完全没有开学日与总周数，而空课的课表必须有开学日：优先用 extract.js 探到的第 1 周日期；探不到就按学期代码推算
    //      （第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一）并在提醒里说明；总周数取 20 周，课表更晚就抬高，同样说明
    //   ③ 周次解析重写：上游只认「逗号分隔的数字与 a-b 区间」，遇到别的写法（单双周、「第」「周」字、括号备注、「共 N 周」）会得到 NaN 或整门课丢掉；
    //      这里认得更宽，认不出的计数写进提醒，不静默丢课
    //   ④ 上游的"缺周次 / 缺节次就丢掉整行"改为计数写进提醒；上游把缺教师写成「未知」、缺教室写成「待定」，这里记为空并按类型汇总提醒
    //   ⑤ 上游去重只认完全相同的行（天、节次、课名、周次串）；这里先按"课名 + 教师 + 星期 + 节次 + 地点"归并同一时段，再把周次合并成并集，
    //      切成连续段 / 单双周段，不改任何一周的安排
    //   ⑥ 上游的导出流程（浏览器测试分支、saveImportedCourses / saveCourseConfig / savePresetTimeSlots、
    //      showToast / notifyTaskCompletion）全部不移植：这些是「拾光」的桥能力，空课由宿主负责保存，适配器只交载荷
    //
    // 这一步是纯转换：没有任何网络与 DOM 访问，所以能（也只在）CI 里用 Rhino 真跑。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    if (!data || typeof data !== 'object') {
        throw new Error('没有拿到教务数据：请重新登录教务系统后再点「提取课表」');
    }
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '江西飞行学院';   // 学期名兜底时用（学校名 + 学期代码，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给总周数：取 20 周，课表更晚就抬高
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数
    var TERM_TEXT_LIMIT = 30;      // 提醒里点名的学期名最多显示的字数
    var SAMPLE_COUNT = 3;          // 提醒里"例如"最多列几门课
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间顺推：每节几分钟
    var SEP = String.fromCharCode(1);

    // 学校的节次时间（上游 JXFU_01.js 的 getPresetTimeSlots，共 11 节，逐节搬过来）
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:55', end: '15:40' },
        { periodIndex: 7, start: '15:55', end: '16:40' },
        { periodIndex: 8, start: '16:50', end: '17:35' },
        { periodIndex: 9, start: '19:00', end: '19:45' },
        { periodIndex: 10, start: '19:55', end: '20:40' },
        { periodIndex: 11, start: '20:50', end: '21:35' }
    ];

    // 空课默认节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到第 11 节之后的节次时，接得上才用它补
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

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    // 课名过长时截短，避免一个超长课名就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name, limit) {
        var line = text(name);
        var max = limit || NAME_TEXT_LIMIT;
        return line.length > max ? line.substring(0, max - 1) + '…' : line;
    }

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

    function utcOfIso(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!m) return null;
        var ms = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        return isNaN(ms) ? null : ms;
    }

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOf(iso) {
        var ms = utcOfIso(iso);
        if (ms === null) return null;
        var date = new Date(ms);
        var offset = (date.getUTCDay() + 6) % 7;
        return isoOf(new Date(ms - offset * 86400000));
    }

    function isoOfAny(value) {
        var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    var warnings = [];
    var droppedWarnings = 0;

    // 所有提醒都走这一个出口：整条限长，条数封顶
    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // 教务数据里偶尔带 HTML 实体：纯字符串解码（parse.js 在 CI 里跑，没有 document 可用）
    function codePointOf(value) {
        if (!(value > 0) || value > 0x10ffff) return '';
        if (value <= 0xffff) return String.fromCharCode(value);
        var rest = value - 0x10000;
        return String.fromCharCode(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff));
    }

    function decodeEntities(value) {
        if (value === null || value === undefined) return '';
        var out = String(value);
        if (out.indexOf('&') < 0) return out;
        out = out
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&apos;/gi, "'");
        out = out
            .replace(/&#x([0-9a-f]{1,5});/gi, function (all, hex) { return codePointOf(parseInt(hex, 16)); })
            .replace(/&#(\d{1,6});/g, function (all, dec) { return codePointOf(parseInt(dec, 10)); });
        return out.replace(/&amp;/gi, '&');   // &amp; 最后解，免得 "&amp;lt;" 被解成 "<"
    }

    // ---------- 学期名、学期代码、开学日 ----------
    var code = text(term.code);

    // 学期代码 → { year, kind }：认 "202501"（学年起始年 + 两位学期号）与 "2025-2026-1"；认不出返回 null
    function termParts() {
        var m = /^(\d{4})0?([12])$/.exec(code);
        if (!m) m = /^(\d{4})\D+\d{4}\D+0?([12])$/.exec(code);
        if (!m) return null;
        return { year: parseInt(m[1], 10), kind: m[2] === '1' ? 'first' : 'second' };
    }

    function termName() {
        var explicit = text(term.name);
        if (explicit) return explicit;
        if (code) return SCHOOL_NAME + ' ' + code;
        return SCHOOL_NAME + ' 课表';
    }

    // 校历给的第 1 周周一是否属于这个学期：与推算锚点差 45 天以上就当成别的学期
    function anchorOf(parts) {
        if (parts.kind === 'first') return { iso: parts.year + '-09-01', rule: '第一学期 = 9 月 1 日所在周的周一' };
        return { iso: (parts.year + 1) + '-02-20', rule: '第二学期 = 2 月 20 日所在周的周一' };
    }

    function plausibleFirstDay(iso) {
        var parts = termParts();
        if (!parts) return true;
        var target = utcOfIso(anchorOf(parts).iso);
        var value = utcOfIso(iso);
        if (target === null || value === null) return true;
        return Math.abs(value - target) <= 45 * 86400000;
    }

    // 日期响应是「某周的星期几 → 日期」。先看 [1]（第 1 周）那一层，再看整棵树；只认星期一
    function findMondayIso(node, depth) {
        if (!node || typeof node !== 'object' || depth > 4) return null;
        if (node.xqmc !== undefined && node.rq !== undefined) {
            var weekday = text(node.xqmc);
            if (weekday === '1' || weekday === '周一' || weekday === '一' || weekday === '星期一') {
                var iso = isoOfAny(node.rq);
                if (iso && plausibleFirstDay(iso)) return iso;
            }
            return null;
        }
        for (var key in node) {
            if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
            var found = findMondayIso(node[key], depth + 1);
            if (found) return found;
        }
        return null;
    }

    function firstDayFromDates(info) {
        if (!info || typeof info !== 'object') return null;
        var scopes = [];
        if (info[1]) scopes.push(info[1]);
        scopes.push(info);
        for (var i = 0; i < scopes.length; i++) {
            var found = findMondayIso(scopes[i], 0);
            if (found) return found;
        }
        return null;
    }

    // 探不到开学日时的推算；推算结果一律写进提醒
    function estimateStart() {
        var parts = termParts();
        if (parts) {
            var anchor = anchorOf(parts);
            return { iso: mondayOf(anchor.iso), rule: anchor.rule };
        }
        var today = text(data.today);
        var base = mondayOf(today);
        if (base) return { iso: base, rule: '今天所在周的周一' };
        return { iso: mondayOf('2000-01-03') || '2000-01-03', rule: '无法判断学期' };
    }

    // ---------- 周次 ----------
    // 教务的 zcs 是逗号分隔的周次串（"2,3,4,7,8"）；上游也接受 a-b 区间。这里再多认单双周、「第」「周」字、括号备注和「共 N 周」
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单/双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字）
    var noteGroups = 0;      // 被摘掉的备注括号个数（含非周次的字）
    var noteSample = '';     // 第一个备注括号的原文
    var bothMarks = 0;       // 同时写了「单」和「双」的段数

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
        // 「共 N 周」是课程总周数备注，只剥备注本身；不能从「共」一路删到行尾，后面的真实周次段会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 「至」「到」）连同两侧空白归成半角 '-'，不要在这里删掉全部空白
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 区间终点前的「第」（"第1-第8周"）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        cleaned = cleaned.replace(/第/g, '');
        // 紧挨周次的单/双括号按相邻关系先归属：前缀写法 "(单)1-8周,(双)9-16周" 的标记跟着自己那一段走；
        // 标记夹在两段中间（前面紧挨数字或「周」、后面紧跟数字）时要判断归属：当前这一段本身以前缀标记开头
        // （"(单)1-8周(双)9-16周" 里的第二个标记）时，它是后一段的前缀，前面补逗号隔开；否则仍是上一段的后缀（"1-8周(单)9-16周(双)"）
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            var segmentHead = before.substring(before.lastIndexOf(',') + 1);
            if (/^\s*\([单双]/.test(segmentHead)) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            return digit + mark + (/^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '');
        });
        // 括号逐组处理：纯数字的是教学班序号，整组摘掉；含非周次字的是备注，摘掉并计数；其余保留内容；每组都换成逗号
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = all;
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        var tokens = cleaned.replace(/\s+/g, ',').split(/,+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
        // 单/双自己成一段时并给最近的周次段（先向前找，找不到再向后）
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空）；这是判断不是事实，计数后写进提醒
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:-[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                if (end > 99) end = 99;    // 防止 "1-99999999" 这类脏数据空转
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
    // 教务的 jcdm2 是逗号分隔的节次码（"05,06" 或 "10"）；上游取第一个和最后一个。认得的写法再加 "0506"（每节占两位拼成）与带「第」「节」字的
    var sparseRows = 0;   // 节次不连续（"01,02,05"）的行数：按首末节整段放入，要说出来
    function sectionsOf(source) {
        var cleaned = fullWidthToHalf(text(source)).replace(/[第节\s]/g, '');
        if (!cleaned) return null;
        var pieces = cleaned.split(/,+/);
        var numbers = [];
        var i;
        for (i = 0; i < pieces.length; i++) {
            var piece = pieces[i];
            if (!piece) continue;
            var range = /^([0-9]{1,2})-([0-9]{1,2})$/.exec(piece);
            if (range) {
                var from = parseInt(range[1], 10);
                var to = parseInt(range[2], 10);
                if (to < from) { var swap = from; from = to; to = swap; }
                for (var n = from; n <= to; n++) numbers.push(n);
                continue;
            }
            if (/^[0-9]{1,2}$/.test(piece)) {
                numbers.push(parseInt(piece, 10));
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
        var first = numbers[0];
        var last = numbers[0];
        var unique = {};
        var count = 0;
        for (i = 0; i < numbers.length; i++) {
            if (numbers[i] < first) first = numbers[i];
            if (numbers[i] > last) last = numbers[i];
            if (!unique[numbers[i]]) { unique[numbers[i]] = true; count++; }
        }
        if (first < 1 || last > MAX_PERIOD) return null;
        return { start: first, end: last, sparse: count !== last - first + 1 };
    }

    // ---------- 逐行转换 ----------
    var order = [];
    var byCourse = {};
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var weekSamples = [];
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    var EMPTY_VALUE = /^(未知|暂无|待定|无)$/;

    function cleanField(value) {
        var line = text(decodeEntities(value));
        return EMPTY_VALUE.test(line) ? '' : line;
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};

        var name = text(decodeEntities(row.kcmc));
        if (!name) { missing.name++; continue; }

        var day = intOf(row.xq);
        if (day === null || day < 1 || day > 7) { missing.day++; continue; }

        var sections = sectionsOf(row.jcdm2);
        if (!sections) { missing.period++; continue; }

        var weeks = weeksOf(row.zcs);
        if (!weeks.length) {
            missing.week++;
            if (weekSamples.length < 1 && text(row.zcs)) weekSamples.push(text(row.zcs));
            continue;
        }

        var teacher = cleanField(row.teaxms) || null;
        var location = cleanField(row.jxcdmcs) || null;
        var key = name + SEP + (teacher || '');
        var course = byCourse[key];
        if (!course) {
            course = { name: name, teacher: teacher, note: null, slots: {}, slotOrder: [] };
            byCourse[key] = course;
            order.push(key);
        }
        if (!teacher) {
            missingTeacherCourses[key] = true;
            if (fieldSamples.length < SAMPLE_COUNT && fieldSamples.indexOf(name) < 0) fieldSamples.push(name);
        }
        if (!location) {
            missingLocationCourses[key] = true;
            if (fieldSamples.length < SAMPLE_COUNT && fieldSamples.indexOf(name) < 0) fieldSamples.push(name);
        }
        if (sections.sparse) sparseRows++;

        // 同一时段（星期 + 节次 + 地点）的多行把周次合并成并集
        var slotKey = day + '|' + sections.start + '|' + sections.end + '|' + (location || '');
        var slot = course.slots[slotKey];
        if (!slot) {
            slot = { day: day, start: sections.start, end: sections.end, location: location, seen: {}, weeks: [] };
            course.slots[slotKey] = slot;
            course.slotOrder.push(slotKey);
        }
        for (var w = 0; w < weeks.length; w++) {
            if (!slot.seen[weeks[w]]) {
                slot.seen[weeks[w]] = true;
                slot.weeks.push(weeks[w]);
            }
        }
        if (sections.end > maxPeriod) maxPeriod = sections.end;
    }

    var termText = shortName(termName(), TERM_TEXT_LIMIT);

    if (rows.length === 0) {
        throw new Error('教务系统里「' + termText + '」还没有排课数据：可能这学期的课表还没发布，也可能不是你要导入的学期。请在教务页面里切到你要导入的学期后再点「提取课表」');
    }
    if (order.length === 0) {
        throw new Error('这学期的课表里没有解析出任何课程：可能是课表还没发布，或教务系统改了数据格式');
    }

    var payloadCourses = [];
    for (var c = 0; c < order.length; c++) {
        var item = byCourse[order[c]];
        var blocks = [];
        for (var s = 0; s < item.slotOrder.length; s++) {
            var slotItem = item.slots[item.slotOrder[s]];
            slotItem.weeks.sort(function (a, b) { return a - b; });
            var runs = runsOf(slotItem.weeks);
            for (var n = 0; n < runs.length; n++) {
                if (runs[n].end > maxWeek) maxWeek = runs[n].end;
                blocks.push({
                    dayOfWeek: slotItem.day,
                    startPeriod: slotItem.start,
                    endPeriod: slotItem.end,
                    startWeek: runs[n].start,
                    endWeek: runs[n].end,
                    weekType: runs[n].weekType,
                    location: slotItem.location
                });
            }
        }
        payloadCourses.push({ name: item.name, teacher: item.teacher, note: null, blocks: blocks });
    }

    // 开学日：优先用探到的第 1 周日期，探不到按学期代码推算
    var firstDay = firstDayFromDates(data.dateInfo);
    var firstDayFromSchool = !!firstDay;
    var startRule = '';
    if (!firstDay) {
        var estimate = estimateStart();
        firstDay = estimate.iso;
        startRule = estimate.rule;
    }

    // 总周数：教务不给，取 20 周，课表里有更晚的周次就抬高
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    // ---------- 节次时间：学校的 11 节表；课表用到更晚的节次逐节补，补不了如实说明（统一修订 H3） ----------
    var periodTimes = PERIOD_TIMES.slice(0);
    var fromDefault = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var defaultSlot = DEFAULT_PERIOD_TIMES[p - 1];
        if (defaultSlot && minutesOf(defaultSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: defaultSlot.start, end: defaultSlot.end });
            fromDefault.push(p);
            continue;
        }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // 节次号（已升序）写成「第 12-13 节」「第 12 节」「第 12、14 节」这几种
    function sectionsText(list) {
        var parts = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            parts.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + parts.join('、') + ' 节';
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    var source = text(term.source);
    if (source === 'first') {
        warn('教务系统没有标出当前学期，已导入学期列表里的第一项「' + termText + '」，请核对；要导入别的学期，请先在教务「我的课表」页面里切到那个学期再点「提取课表」');
    } else {
        warn('只导入了「' + termText + '」；要导入别的学期，请先在教务「我的课表」页面里切到那个学期再点「提取课表」');
    }

    if (firstDayFromSchool) {
        warn('开学日期取自教务系统的第 1 周日期：' + firstDay + '，请在学期管理里核对');
    } else {
        warn('教务系统没有给出开学日期，第 1 周按「' + startRule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日');
    }

    if (raisedBySchedule) {
        warn('教务系统没有给出学期总周数；课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
    } else {
        warn('教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    }

    if (fromDefault.length || bySequence.length) {
        var fillTexts = [];
        if (fromDefault.length) fillTexts.push(sectionsText(fromDefault) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromDefault.concat(bySequence).sort(function (a, b) { return a - b; });
        warn('课表用到了' + sectionsText(filledAll) + '，学校公布的节次时间没有覆盖，已补上：' + fillTexts.join('，') + '，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 行');
        if (missing.period) reasons.push('缺节次（或节次超出 1-' + MAX_PERIOD + ' 节）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (weekSamples.length) reasons.push('认不出的周次写法如「' + shortName(weekSamples[0]) + '」');
        warn('有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') + '），已跳过：教务数据不完整时会出现，如发现少课请反馈');
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），按类型汇总计数
    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownNames.push(shortName(fieldSamples[fs]));
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shownNames.join('、') + '）：已照常导入，' + emptyText + '，可在「编辑课程」里补上');
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处周次里的括号只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，已忽略，请核对这几门课的周次');
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
        warn('有 ' + sparseRows + ' 行课表的节次不连续（例如「01,02,05」），已按最大跨度放入（中间几节也算上），请核对');
    }

    // 兜底：真到了上限就说清楚（正常路径下这个计数永远是 0）
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
                name: termName(),
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
