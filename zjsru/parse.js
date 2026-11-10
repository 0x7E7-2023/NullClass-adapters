(function () {
    // 浙江树人学院（浙江树人大学）教务适配器（xk.jwc.zjsru.edu.cn）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 ZJSRU/zjsru_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 CagierAsh123）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 86ea7dd
    //
    // 上游在同一段脚本里读表格、切课程、拼周次、推开学日；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑）。
    // extract.js 交过来的是学期下拉框的值、校区的判定结果，以及每个课程格子的文字行。
    //
    // 移植改动（周次写法照批次十已审计的 swu / hnsf，逐条对得上 AUDIT.md）：
    //   ① 格子切分：按「周X第N节{周次}」锚点切，锚点上一行是课名，后面两行依次是教师、教室（与上游一致）；
    //      一格并排多门课、以 <br> 分行时逐门切出来
    //   ② 周次：花括号里的写法（第1-16周 / 第2-16周|双周 / 第1-5,7-9周）全部接住；
    //      花括号外还有文字时也读（上游正则只认花括号，没有花括号的周次会被整门丢掉）
    //   ③ 去重与合并：完全相同的行先去重；同名、同教师、同地点、同星期、同周次的相邻节次合并
    //      （首尾相接或重叠），单周行与双周行不会被并成「每周都上」
    //   ④ 教师、教室缺了照常导入（null），按类型汇总写进提醒；上游缺哪个整门课就没了
    //   ⑤ 学期名：用教务下拉框的文字（学年 + 第几学期）；拿不到就由学年与学期号推，再拿不到用学校名
    //   ⑥ 开学日：上游明确不给（semesterStartDate 留空）；这里按第一学期 9 月 1 日 / 第二学期 3 月 2 日 /
    //      第 3 学期（短）7 月 1 日所在周的周一推算，并在提醒里说明是推算的
    //   ⑦ 总周数：上游是 max(18, 课表最晚周)；这里按公共口径 max(课表最晚周, 20)，最多 30，抬高时提醒
    //   ⑧ 节次时间：逐节照抄上游 ZJSRU_CAMPUS_TIME_SLOTS 的两套 12 节表（拱宸桥 / 杨汛桥），
    //      按 extract.js 判断的校区选一套；课表用到表外的节次时按批次五统一修订 H3 逐节补齐并提醒
    //   ⑨ 上游的 saveImportedCourses / savePresetTimeSlots / saveCourseConfig / showToast /
    //      notifyTaskCompletion 全部不移植，空课由宿主保存，适配器只交载荷
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var campusData = data.campus || {};
    var cells = data.cells instanceof Array ? data.cells : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给总周数时的兜底（上游写 18 周下限，20 已覆盖）
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名 / 原文最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟

    // 上游 ZJSRU_CAMPUS_TIME_SLOTS，逐节照抄原值（两套 12 节表）。
    // 杨汛桥校区不设第 5 节：上游虚拟 11:35-12:15 占位，保证上午第 6 节仍落在 6 号上（课表按全校统一节次返回）
    var CAMPUS_TIMES = {
        gongchenqiao: {
            label: '拱宸桥校区',
            slots: [
                { number: 1, startTime: '08:10', endTime: '08:50' },
                { number: 2, startTime: '09:00', endTime: '09:40' },
                { number: 3, startTime: '09:55', endTime: '10:35' },
                { number: 4, startTime: '10:45', endTime: '11:25' },
                { number: 5, startTime: '11:35', endTime: '12:15' },
                { number: 6, startTime: '13:30', endTime: '14:10' },
                { number: 7, startTime: '14:20', endTime: '15:00' },
                { number: 8, startTime: '15:10', endTime: '15:50' },
                { number: 9, startTime: '16:00', endTime: '16:40' },
                { number: 10, startTime: '18:10', endTime: '18:50' },
                { number: 11, startTime: '19:00', endTime: '19:40' },
                { number: 12, startTime: '19:50', endTime: '20:30' }
            ]
        },
        yangxunqiao: {
            label: '杨汛桥校区',
            slots: [
                { number: 1, startTime: '08:30', endTime: '09:10' },
                { number: 2, startTime: '09:15', endTime: '09:55' },
                { number: 3, startTime: '10:10', endTime: '10:50' },
                { number: 4, startTime: '10:55', endTime: '11:35' },
                { number: 5, startTime: '11:35', endTime: '12:15' },
                { number: 6, startTime: '13:30', endTime: '14:10' },
                { number: 7, startTime: '14:15', endTime: '14:55' },
                { number: 8, startTime: '15:05', endTime: '15:45' },
                { number: 9, startTime: '15:50', endTime: '16:30' },
                { number: 10, startTime: '18:00', endTime: '18:40' },
                { number: 11, startTime: '18:45', endTime: '19:25' },
                { number: 12, startTime: '19:30', endTime: '20:10' }
            ]
        }
    };

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到的节次超出所用的节次时间表时，
    // 内置表里有这一节、且开始不早于上一节下课，就用它的时间；接不上的按顺推补
    var BUILTIN_PERIOD_TIMES = [
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

    var DAY_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    var KIND_CN = { 1: '一', 2: '二', 3: '三' };

    // 课表行首标签：「周一第1,2节{第1-16周}」。上游要求整行完全匹配，这里允许花括号之外再带周次文字
    var ANCHOR_RE = /^周\s*([一二三四五六日天])\s*第\s*([0-9]+(?:\s*,\s*[0-9]+)*)\s*节\s*(.*)$/;
    var BRACE_RE = /\{([^}]*)\}/;

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 课名、学期名、原文过长时截短，避免一个超长字符串就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
    }

    // 点名：最多 3 个，各自截短，用顿号连起来
    function sampleText(list) {
        var shown = [];
        for (var i = 0; i < list.length && i < 3; i++) shown.push(shortName(list[i]));
        return shown.join('、');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function utcOf(iso) {
        return new Date(Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        ));
    }

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOf(iso) {
        if (!iso) return null;
        var date = utcOf(iso);
        var back = (date.getUTCDay() + 6) % 7;   // 周一 = 0 … 周日 = 6
        return isoOf(new Date(date.getTime() - back * 86400000));
    }

    function isoOfAny(value) {
        var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    // 分钟数写回 HH:mm（补时间用）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var mm = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
    }

    // ---------- warnings（载荷上限 20 条 × 200 字，超了整包会被拒，所以由这里统一收口） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        // 单条超长直接截断（超长会让整包被拒收，截断至少还能让用户看到前半句）
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。树人的周次写在花括号里，正常是「第1-16周」「第2-16周|双周」，
    // 这里照批次十 swu 的写法放宽，同时认：
    //   "1-16周" / "1-16周(单)" / "(单)1-8周,(双)9-16周" / "1-3,5-9周" / "17周" / "第1-第8周" / 全角数字与标点
    // 必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单 / 双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉；
    //      含非周次字的（"(3组)"）也摘掉，计数后写进 warnings；其它（"(1-16周)"、"(单)"）保留内容；
    //   ④ 空白两头都要顾：破折号连同两侧的空白先归一成半角 '-'，剩下的空白当分段符折成逗号。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单 / 双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3组)」，含非周次的字，不是周次）
    var noteSample = '';     // 第一个备注括号的原文，写进提醒
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
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'。不要在这里删掉全部空白
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 「共8周」是课程总周数备注，不是上课周次，只剥备注本身；放在全角转半角之后，全角数字也一起剥掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 紧挨周次的单 / 双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上；
        //   这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"，标记就跟着自己那一段走。
        //   前缀只认在段首：标记前面紧挨着数字或「周」（中间可有空白）时它是上一段的后缀
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 夹在两段中间的标记：本段以前置标记开头时它是下一段的前缀，补逗号隔开；
            // 否则仍是上一段的后缀
            if (/^\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var glue = /^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '';
            return digit + mark + glue;
        });
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周第-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = all;
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');   // 剩下落单的括号字符（没有闭合）也换成逗号，不许直接删
        cleaned = cleaned.replace(/周/g, '');
        // 区间终点前的「第」（"第1-第8周"）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空，那才是真丢数据）；这是个判断不是事实，所以计数后写进 warnings
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

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周（手册 §4.1）。一行切出多段就写成多个 block，语义等价。
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

    // ---------- 课表格子 ----------
    // "周一第1,2节{第1-16周}" / "周二第8,9节{第2-16周|双周}"。
    // 节次只取首末两节（与上游 Math.min / Math.max 一致）；周次优先读花括号里的部分，
    // 没有花括号时读「节」后面的文字 —— 节次里的数字不能被当成周次。
    function parseAnchor(line) {
        var m = ANCHOR_RE.exec(text(line));
        if (!m) return null;
        var sections = [];
        var parts = m[2].split(',');
        var bad = false;
        for (var i = 0; i < parts.length; i++) {
            var n = parseInt(parts[i], 10);
            if (isNaN(n) || n < 1 || n > MAX_PERIOD) { bad = true; break; }
            sections.push(n);
        }
        if (bad) sections = [];
        sections.sort(function (a, b) { return a - b; });
        var tail = m[3] || '';
        var brace = BRACE_RE.exec(tail);
        var weekText = brace ? brace[1] : tail;
        return {
            day: DAY_MAP[m[1]] || 0,
            sections: sections,
            weeks: weeksOf(weekText)
        };
    }

    // ---------- 逐格转换 ----------
    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序
    var courses = [];
    var byName = {};
    var missing = { name: 0, period: 0, week: 0 };
    var timeSamples = [];      // 认不出的行原文，最多留 3 个，写进 warnings 方便反馈
    var sparseSections = 0;    // 把不相邻的几节写在同一行里的行数（按首末节之间的范围导入，要说出来）
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var maxWeek = 0;
    var maxPeriod = 0;

    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + (teacher || '');
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, blocks: [] };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    // 教师 / 教室写成占位词的一律当没给（手册 §4.7：写「未知」会被课表当成真名显示）
    function placeholder(value) {
        return /^(未知|待定|暂无|无)(上课)?(教师|老师|教室|地点)?$/.test(value);
    }

    function addTimeSample(value) {
        var sample = text(value);
        if (!sample || timeSamples.length >= 3 || timeSamples.indexOf(sample) >= 0) return;
        timeSamples.push(sample);
    }

    var entries = [];

    for (var ci = 0; ci < cells.length; ci++) {
        var lines = cells[ci] instanceof Array ? cells[ci] : [];
        var anchors = [];
        var i;
        for (i = 0; i < lines.length; i++) {
            if (ANCHOR_RE.test(text(lines[i]))) anchors.push(i);
        }
        for (var a = 0; a < anchors.length; a++) {
            var k = anchors[a];
            var parsed = parseAnchor(lines[k]);
            var name = text(lines[k - 1]);
            // 上一行本身又是「周X第N节」说明这一门缺课名：不拿节次行当课名
            if (!name || ANCHOR_RE.test(name)) { missing.name++; continue; }
            if (!parsed || !parsed.sections.length) { missing.period++; addTimeSample(lines[k]); continue; }
            if (!parsed.weeks.length) { missing.week++; addTimeSample(lines[k]); continue; }

            // 本门课的附加行：下一门课的课名行为界（与上游 slice(k+1, stop) 一致）
            var stop = (a + 1 < anchors.length) ? anchors[a + 1] - 1 : lines.length;
            var rest = lines.slice(k + 1, Math.max(k + 1, stop));
            var teacher = text(rest[0]);
            var location = text(rest[1]);
            if (placeholder(teacher)) teacher = '';
            if (placeholder(location)) location = '';
            if (!teacher) missingTeacherCourses['n' + name] = true;
            if (!location) missingLocationCourses['n' + name] = true;
            if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
                fieldSamples.push(name);
            }

            var first = parsed.sections[0];
            var last = parsed.sections[parsed.sections.length - 1];
            if (last - first + 1 !== parsed.sections.length) sparseSections++;

            entries.push({
                course: courseOf(name, teacher || null),
                name: name,
                teacher: teacher,
                location: location,
                day: parsed.day,
                start: first,
                end: last,
                weeks: parsed.weeks
            });
        }
    }

    // 完全相同的行只留第一条：同一上课安排重复出现，去掉不算丢课
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
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    function orderEntries(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end) ||
            cmpText(a.weeks.join(','), b.weeks.join(','));
    }

    // 与上游 mergeAndDistinctCourses 同口径：同名、同教师、同地点、同星期、同周次的相邻节次合并成一段（首尾相接或重叠）。
    // 分组键含周次，单周行与双周行不会被并成每周都上；分组的先后取第一次出现的顺序
    var groupOrder = [];
    var groups = {};
    entries = dropExactDuplicates(entries);
    for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        var groupKey = 'g' + entry.name + '|' + entry.teacher + '|' + entry.location + '|' + entry.day + '|' + entry.weeks.join(',');
        if (!groups[groupKey]) {
            groups[groupKey] = [];
            groupOrder.push(groupKey);
        }
        groups[groupKey].push(entry);
    }
    var merged = [];
    for (var gi = 0; gi < groupOrder.length; gi++) {
        var list = groups[groupOrder[gi]];
        list.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
        var current = null;
        for (var li = 0; li < list.length; li++) {
            var next = list[li];
            if (current && next.start <= current.end + 1) {
                if (next.end > current.end) current.end = next.end;
                continue;
            }
            current = {
                course: next.course,
                name: next.name,
                teacher: next.teacher,
                location: next.location,
                day: next.day,
                start: next.start,
                end: next.end,
                weeks: next.weeks
            };
            merged.push(current);
        }
    }
    merged.sort(orderEntries);

    // 合并后的每条 entry 按周次拆成 block（步长 2 → 单 / 双周，见 runsOf）
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
                location: item.location || null
            });
        }
    }

    if (!courses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开「学生个人课表」页面确认能看到课表后再试'
        );
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var termYear = /^\d{4}$/.test(text(term.year)) ? parseInt(text(term.year), 10) : 0;
    var termSemester = 0;
    if (text(term.semester) === '1') termSemester = 1;
    else if (text(term.semester) === '2') termSemester = 2;
    else if (text(term.semester) === '3') termSemester = 3;

    // 学年学期：页面读到的优先；读不全就按今天的日期判断（8 月到次年 1 月是第一学期，2 到 7 月是第二学期）
    function effectiveTerm() {
        if (termYear && termSemester) return { year: termYear, kind: termSemester, fromPage: true };
        var todayYear = parseInt(todayIso.substring(0, 4), 10);
        var month = parseInt(todayIso.substring(5, 7), 10);
        if (month >= 8) return { year: todayYear, kind: 1, fromPage: false };
        if (month <= 1) return { year: todayYear - 1, kind: 1, fromPage: false };
        return { year: todayYear - 1, kind: 2, fromPage: false };
    }

    function termName(eff) {
        var yearLabel = text(term.yearLabel);
        var semesterLabel = text(term.semesterLabel);
        // 学期名优先用教务下拉框自己的文字（手册 §4.7：别拿适配器名当学期名）
        if (eff.fromPage && semesterLabel.indexOf('学期') >= 0) {
            var head = yearLabel;
            if (!head || head.indexOf(String(eff.year)) < 0) head = eff.year + '-' + (eff.year + 1) + '学年';
            else if (head.indexOf('学年') < 0) head = head + '学年';
            var name = head + semesterLabel;
            return name.length > 40 ? name.substring(0, 40) : name;
        }
        return eff.year + '-' + (eff.year + 1) + '学年第' + KIND_CN[eff.kind] + '学期';
    }

    // 开学日推算（手册 §4.3：回退到那一周的周一）。上游明确不给开学日，只声明「各学期开学日不是固定公式」：
    //   第一学期 9 月 1 日 / 第二学期次年 3 月 2 日 / 第 3 学期（短）次年 7 月 1 日
    function estimateStart(eff) {
        var anchorIso;
        var rule;
        if (eff.kind === 2) {
            anchorIso = isoOf(new Date(Date.UTC(eff.year + 1, 2, 2)));
            rule = '第二学期 = 3 月 2 日所在周的周一';
        } else if (eff.kind === 3) {
            anchorIso = isoOf(new Date(Date.UTC(eff.year + 1, 6, 1)));
            rule = '第 3 学期（短学期）= 7 月 1 日所在周的周一';
        } else {
            anchorIso = isoOf(new Date(Date.UTC(eff.year, 8, 1)));
            rule = '第一学期 = 9 月 1 日所在周的周一';
        }
        return { iso: mondayOf(anchorIso), rule: rule };
    }

    var eff = effectiveTerm();
    var name0 = termName(eff);
    var start = estimateStart(eff);

    // 教务不给总周数：按 max(课表最晚周次, 20) 导入，课表里更晚的周次必须放得下
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    // ---------- 节次时间（按校区选一套，逐节照抄上游；表外节次按 H3 补） ----------
    var campusKey = text(campusData.key) === 'yangxunqiao' ? 'yangxunqiao' : 'gongchenqiao';
    var campus = CAMPUS_TIMES[campusKey];
    var campusSource = text(campusData.source);

    var periodTimes = [];
    for (var pt = 0; pt < campus.slots.length; pt++) {
        periodTimes.push({
            periodIndex: campus.slots[pt].number,
            start: campus.slots[pt].startTime,
            end: campus.slots[pt].endTime
        });
    }
    var tableLength = periodTimes.length;
    var publishedCount = tableLength;   // 学校公布的那几节；后面补出来的不计入这条提醒

    // 节次号（已升序）写成「第 9-12 节」「第 9 节」「第 9、11-12 节」这几种
    function sectionsText(list) {
        var spans = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) {
                j++;
            }
            spans.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + spans.join('、') + ' 节';
    }

    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = tableLength + 1; p <= maxPeriod; p++) {
        var prev = periodTimes.length ? periodTimes[periodTimes.length - 1] : null;
        var prevEnd = prev ? minutesOf(prev.end) : -1;
        var builtinSlot = BUILTIN_PERIOD_TIMES[p - 1];
        // 内置表有这一节、且它的开始不早于上一节下课，才用内置时间（否则会和上一节重叠甚至倒挂）
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: builtinSlot.start, end: builtinSlot.end });
            fromBuiltin.push(p);
            continue;
        }
        // 否则从上一节下课后顺推：课间 5 分钟、每节 45 分钟；顺推越过 23:59 就停，这一节起不再补
        if (!prev) { uncoveredFrom = p; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    if (eff.fromPage) {
        warn(
            '只导入了教务系统里当前的学期（' + name0 +
            '）；要导入别的学期，请先在「学生个人课表」页面里切到那个学期，再点「提取课表」'
        );
    } else {
        warn(
            '没有从教务系统读到当前学期，已按今天的日期推算为 ' + name0 +
            '。如果这不是你要导入的学期，请先在「学生个人课表」页面里切到正确的学期，再点「提取课表」'
        );
    }

    warn(
        '教务系统没有给出开学日期，第 1 周按「' + start.rule + '」推算为 ' + start.iso +
        '，请在学期管理里核对成学校实际开学日'
    );

    var firstSlot = periodTimes[0];
    if (campusSource === 'default') {
        warn(
            '没能确认你所在的校区，已按' + campus.label + '的节次时间导入（第 1 节 ' +
            firstSlot.start + '-' + firstSlot.end + '）；如果不在' + campus.label +
            '，可在学期管理里改节次时间'
        );
    } else if (campusSource === 'user') {
        warn(
            '已按你选择的' + campus.label + '的节次时间导入（第 1 节 ' + firstSlot.start + '-' +
            firstSlot.end + '，共 ' + publishedCount + ' 节），请与实际上课时间核对，不一致可在学期管理里改'
        );
    } else {
        warn(
            '已按课表里显示的' + campus.label + '的节次时间导入（第 1 节 ' + firstSlot.start + '-' +
            firstSlot.end + '，共 ' + publishedCount + ' 节），请与实际上课时间核对，不一致可在学期管理里改'
        );
    }

    if (raisedBySchedule) {
        warn(
            '教务系统没有给出学期总周数；课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS +
            ' 周，已按 ' + totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
        warn(
            '课表用到了' + sectionsText(filledAll) + '，节次时间表里没有这些节次，已补上：' + fillTexts.join('，') +
            '，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    var skipped = missing.name + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.period) reasons.push('缺节次（或节次不合理）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (timeSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < timeSamples.length; ws++) sampleTexts.push(shortName(timeSamples[ws]));
            reasons.push('认不出的行如「' + sampleTexts.join('」「') + '」');
        }
        warn(
            '有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），但按类型汇总计数说出来，不静默
    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + sampleText(fieldSamples) + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上'
        );
    }

    if (sparseSections > 0) {
        warn(
            '有 ' + sparseSections + ' 行把不相邻的几节写在同一格里（如「第 1,3 节」），已按首末两节之间的范围（第 1-3 节）导入，请核对上课时间'
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
            '有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，' +
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
        warn(
            '有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对'
        );
    }

    // 兜底：真到了上限就说清楚（正常路径下这些计数永远是 0）
    if (droppedWarnings > 0) {
        warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';
    }

    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: null,
            blocks: courses[c].blocks
        });
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
