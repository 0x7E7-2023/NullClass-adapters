(function () {
    // 山东水利职业学院教务适配器（树维 EAMS 平台）—— 第二步：extract.js 交出来的数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 SDWCVC/sdwcvc_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游 maintainer 小漫君）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取，2026-10-20 复核）
    //   本校脚本最后一次修改 494e3ce
    //   上游文件头写明：周次位图、逐周合并、日期校验复用 ZUA/zua.js（沿用 HFNU/hfnu.js），教学周历的英文日期格式参考 HIIT/hiit_01.js。
    //
    // 上游把取数与解析揉在同一个自执行脚本里；这里只做纯转换（不碰页面、不发请求，CI 里用 Rhino 实跑），
    // 取数全部在 extract.js。解析骨架（参数切分、位图、逐周合并、教学周历）语义照上游，逐条改动见下。
    // 解析骨架以同族的 xatu（树维 EAMS，1.1.0）与 zua 为底，课表页的读法对照本校上游改写。
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」一节）：
    //   ① ES6 → ES5：去掉模板串、箭头函数、展开运算符、块级声明关键字、集合类型与 Array.from 这类非 ES5 结构
    //      （上游的周次矩阵用了 61 个集合）。合并语义不变，实现换成等价的对象结构
    //   ② 不弹窗选学期：用 extract.js 给的当前学期；学期名从学期列表里按 id 查（上游同一份列表），查不到按导入日期推并说明
    //   ③ 上游遇到任何一处结构对不上就整次报错（教师声明、课程活动、周次位图、校历与学期不符等）。这里能读多少读多少，
    //      读不懂的按类型汇总写进提醒，不静默丢课、不猜节次数
    //   ④ 节次时间：上游写死的学校统一作息（第 1～10 节），照抄；课表用到第 10 节以后的节次时，上游直接报错，
    //      这里按「统一修订 H3」逐节补（空课默认节次表里同号且接得上的用它，否则顺推），补了哪些、补不了哪些都写进提醒
    //   ⑤ 教学周历：上游要求「起始日必须是周一、周次 1..60、学期与所选学期一致」否则报错。这里起始日不是周一就回退到那一周的周一并说明；
    //      总周数超过 30（载荷上限）按 30 并说明；学期对不上、读不出时不用，改按学期名推算开学日并说明
    //   ⑥ 周次位图下标即周次，下标 0 是占位符（上游同口径）；0 位为 1 时不产出第 0 周，只写提醒。超过 30 周的周次
    //      （上游允许到 60）超出载荷上限，丢弃并说明
    //   ⑦ 课程名：上游先删尾部括号再删尾部 sup 标签，顺序反了会让带标签的课名留着课程代码。这里先删标签、再只删
    //      「明显是课程代码」的尾部括号（体育(3)、高等数学A(一) 这类保留），理由与 xatu 相同，见 AUDIT.md
    //   ⑧ 教师 / 教室拿不到就留空（null），按类型汇总写进提醒；不用占位词
    //   ⑨ index 赋值除上游的「N * unitCount + M」外，也认「N * 14 + M」和已算好的裸数字（裸数字要有 unitCount 才能反推）；
    //      读不懂的计数后写进提醒。上游遇到节次超过 unitCount 直接报错，这里计数丢弃并说明
    //   ⑩ 排序改成与引擎无关的确定性比较（上游用 localeCompare，Rhino 与 V8 的结果未必一致，而 fixture 逐数组比对）
    //   ⑪ 提醒与报错全部改成大白话（docs/ux-writing.md）；点名课名截 20 字，整条不超 200 字
    //   ⑫ 教师按活动取：每条活动先看自己前面有没有 actTeachers 声明（上游只取整块第一个），没有沿用上一条的，整块都没有才用块头的 teachers

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var digest = rawText(data.courseDigest);
    var calendarTerm = rawText(data.calendarTerm);
    var calendarRange = rawText(data.calendarRange);
    var todayIso = text(data.today);
    var semesterId = text(data.semesterId);

    // 复合键分隔符取 NUL。用 String.fromCharCode 取，源码里不出现控制字符
    var SEP = String.fromCharCode(0);
    var NBSP = String.fromCharCode(160);

    var SCHOOL_NAME = '山东水利职业学院';
    var MAX_WEEK = 30;            // 载荷校验：startWeek / endWeek / totalWeeks ∈ 1..30
    var MAX_DAY = 7;
    var MAX_PERIOD = 30;          // 单日节次上限，超过它一定是脏数据
    var MAX_WARNING_CHARS = 200;
    var MAX_WARNINGS = 20;
    var NAME_LIMIT = 20;          // 提醒里点名的课名最多显示的字数
    var NAMES_SHOWN = 3;          // 提醒里最多点名几门课
    var FALLBACK_TOTAL_WEEKS = 20;
    var EXTEND_BREAK_MINUTES = 5;   // 节次时间补不上时顺推：课间
    var EXTEND_CLASS_MINUTES = 45;  // 节次时间补不上时顺推：每节

    // 学校统一作息（山东水利职业学院，第 1～10 节）：上游 SDWCVC_TIME_SLOTS 逐节照抄
    // （学校官网「作息时间」公布，https://www.sdwcvc.edu.cn/ggfw/zxsj.htm）。
    // 上游没有向教务请求节次时间，这张表是脚本作者对学校的了解，所以载荷里要写明它不是从教务读的。
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:15', end: '09:00' },
        { periodIndex: 2, start: '09:10', end: '09:55' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:25', end: '16:10' },
        { periodIndex: 7, start: '16:20', end: '17:05' },
        { periodIndex: 8, start: '17:15', end: '18:00' },
        { periodIndex: 9, start: '19:30', end: '20:15' },
        { periodIndex: 10, start: '20:25', end: '21:10' }
    ];

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到第 10 节以后的节次时，
    // 同号的节次开始不早于上一节下课就用它，否则顺推（载荷带了节次时间时应用不会自己补）。
    var HOST_PERIOD_TIMES = [
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

    var MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    var KIND_CN = { '1': '一', '2': '二', '3': '三', '4': '四' };
    var WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    // ---------- 小工具 ----------
    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    function rawText(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function stripTags(html) {
        return rawText(html)
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;|&#160;|&#x0*A0;/gi, ' ')
            .split(NBSP).join(' ');
    }

    function cmpStr(a, b) {
        if (a === b) return 0;
        return a < b ? -1 : 1;
    }

    function cmpNum(a, b) {
        return a === b ? 0 : (a < b ? -1 : 1);
    }

    function clip(name) {
        var value = text(name);
        return value.length > NAME_LIMIT ? value.substring(0, NAME_LIMIT) + '…' : value;
    }

    // 点名几门课：「A」「B」「C」 + 超出时的「等」
    function namesText(names) {
        var shown = [];
        for (var i = 0; i < names.length && i < NAMES_SHOWN; i++) shown.push('「' + clip(names[i]) + '」');
        return shown.join('、') + (names.length > NAMES_SHOWN ? ' 等' : '');
    }

    // ---------- 提醒：同一个出口（去重、每条 ≤200 字、总数 ≤20 条） ----------
    var warnings = [];

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_CHARS) line = line.substring(0, MAX_WARNING_CHARS - 1) + '…';
        if (warnings.indexOf(line) >= 0) return;
        if (warnings.length >= MAX_WARNINGS - 1) {
            var tail = '另有几条提醒没有显示；如发现课表有误，请反馈给我们';
            if (warnings.indexOf(tail) < 0) warnings.push(tail);
            return;
        }
        warnings.push(line);
    }

    // ---------- 日期 ----------
    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    // 数字年月日 → ISO 日期；用 UTC 构造再逐项回比，2 月 30 日这类假日期会被拒（同上游 normalizeNumericDate）
    function isoFromNumbers(year, month, day) {
        var y = parseInt(year, 10);
        var m = parseInt(month, 10);
        var d = parseInt(day, 10);
        if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
        var date = new Date(Date.UTC(y, m - 1, d));
        if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return null;
        return isoOf(date);
    }

    function utcOfIso(iso) {
        return Date.UTC(parseInt(iso.substring(0, 4), 10), parseInt(iso.substring(5, 7), 10) - 1, parseInt(iso.substring(8, 10), 10));
    }

    // 星期几：1 = 周一 … 7 = 周日
    function weekdayOfIso(iso) {
        var wd = new Date(utcOfIso(iso)).getUTCDay();
        return wd === 0 ? 7 : wd;
    }

    function mondayOnOrBefore(iso) {
        return isoOf(new Date(utcOfIso(iso) - (weekdayOfIso(iso) - 1) * 86400000));
    }

    // "08:15" / "8:15:00" → "08:15"；认不出来（含 24:00 这种越界）返回 null
    function timeOf(value) {
        var m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(text(value));
        if (!m) return null;
        return (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2];
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(minutes) {
        return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
    }

    // ---------- TaskActivity 参数切分（上游 powerSplit，语义原样保留） ----------
    function cleanArg(s) {
        var value = rawText(s).replace(/^\s+|\s+$/g, '');
        if (value === 'null') return null;
        return value.replace(/^["']|["']$/g, '');
    }

    function powerSplit(paramsRaw) {
        var source = rawText(paramsRaw);
        var args = [];
        var current = '';
        var depth = 0;
        var inQuote = false;
        var quoteChar = '';
        for (var i = 0; i < source.length; i++) {
            var ch = source.charAt(i);
            if ((ch === '"' || ch === "'") && (i === 0 || source.charAt(i - 1) !== '\\')) {
                if (!inQuote) { inQuote = true; quoteChar = ch; }
                else if (ch === quoteChar) { inQuote = false; }
            }
            if (!inQuote) {
                if (ch === '(' || ch === '[' || ch === '{') depth++;
                if (ch === ')' || ch === ']' || ch === '}') depth--;
            }
            if (ch === ',' && depth === 0 && !inQuote) {
                args.push(cleanArg(current));
                current = '';
            } else {
                current += ch;
            }
        }
        args.push(cleanArg(current));
        return args;
    }

    // 教师声明里的姓名：按出现顺序、去重，用逗号连起来（上游 parseTeacherName）
    function teacherNamesOf(fragment) {
        var re = /\bname\s*:\s*(?:"([^"]*)"|'([^']*)')/g;
        var names = [];
        var m;
        while ((m = re.exec(rawText(fragment))) !== null) {
            var name = text(m[1] !== undefined ? m[1] : m[2]);
            if (name && names.indexOf(name) < 0) names.push(name);
        }
        return names.join(',');
    }

    // ---------- 课程名（⑦） ----------
    // 尾部括号里的内容是不是「课程代码」：纯 ASCII、带数字，并且够长（4 位以上）或带 . - _ 分隔。
    // 短数字（「体育(3)」）、单个字母、中文（「高等数学A(一)」）一律当课程名的一部分保留。
    function isCourseCode(inner) {
        var s = text(inner);
        if (!/^[A-Za-z0-9._\-]+$/.test(s)) return false;
        if (!/[0-9]/.test(s)) return false;
        return s.length >= 4 || /[._\-]/.test(s);
    }

    function courseNameOf(raw) {
        var name = text(rawText(raw).replace(/<sup\b[^>]*>[\s\S]*?<\/sup>\s*$/i, '').replace(/<[^>]*>/g, ''));
        var m = /\(([^()]*)\)$/.exec(name);
        if (m && m.index > 0 && isCourseCode(m[1])) return text(name.substring(0, m.index));
        return name;
    }

    // ---------- 周次位图（⑥） ----------
    var zeroBitSeen = false;
    var droppedOverflowWeeks = 0;
    var junkBitmapChars = 0;

    function weeksOfBitmap(bitmap) {
        var s = rawText(bitmap);
        var weeks = [];
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            if (ch !== '0' && ch !== '1') { junkBitmapChars++; continue; }
            if (ch !== '1') continue;
            if (i === 0) { zeroBitSeen = true; continue; }
            if (i > MAX_WEEK) { droppedOverflowWeeks++; continue; }
            weeks.push(i);
        }
        return weeks;
    }

    // 周次集合 → 极大段（手册 §4.1）：步长 1 视作每周、步长 2 视作单周 / 双周、落单的一周是 ALL
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

    // ---------- index 赋值（⑨） ----------
    // 「index = 5 * unitCount + 2;」或「index = 5 * 14 + 2;」→ 星期 5 + 1、节次 2 + 1；
    // 「index = 62;」（已算好）→ 用 unitCount 反推，没有 unitCount 就读不了。一律正则解析，不执行任何取回来的代码。
    var RE_INDEX = /\bindex\s*=\s*(?:(\d+)\s*\*\s*(?:unitCount|(\d+))\s*\+\s*(\d+)|(\d+))\s*;/g;

    function indexesOf(scope, unitCount) {
        var out = [];
        var re = new RegExp(RE_INDEX.source, 'g');
        var m;
        while ((m = re.exec(rawText(scope))) !== null) {
            if (m[4] !== undefined) {
                if (!(unitCount >= 1)) { out.push({ unreadable: true }); continue; }
                var linear = parseInt(m[4], 10);
                out.push({ day: Math.floor(linear / unitCount) + 1, section: (linear % unitCount) + 1 });
            } else {
                out.push({ day: parseInt(m[1], 10) + 1, section: parseInt(m[3], 10) + 1 });
            }
        }
        return out;
    }

    // ---------- 课表页：教师声明、TaskActivity、index（上游 parseTaskActivities 的语义） ----------
    var unitCountMatch = /\bunitCount\s*=\s*(\d+)\s*;/.exec(digest);
    var unitCount = unitCountMatch ? parseInt(unitCountMatch[1], 10) : null;
    if (!(unitCount >= 1 && unitCount <= MAX_PERIOD)) unitCount = null;

    var activitiesFound = 0;
    var activitiesSkipped = 0;       // 参数不足 7 个
    var activitiesWithoutWeeks = 0;  // 周次位图里一位都没有
    var droppedIndex = 0;            // 没有 index 赋值，或裸数字的 index 因为缺 unitCount 读不了
    var droppedDay = 0;
    var droppedSection = 0;
    var unnamedCourses = 0;
    var rawLessons = [];

    // 一段代码里最后一个 actTeachers 声明的姓名；没有声明返回 null，声明了但是空的返回空串
    function lastActTeachersOf(segment) {
        var re = /actTeachers\s*=\s*\[([\s\S]*?)\]\s*;/g;
        var last = null;
        var m;
        while ((m = re.exec(rawText(segment))) !== null) last = m[1];
        return last === null ? null : teacherNamesOf(last);
    }

    function collectActivities() {
        // 上游按「var teachers =」切块：教师声明在活动前面。上游取整块里第一个 actTeachers 的姓名给块里所有活动；
        // 这里每条活动先看自己前面（上一条活动之后）有没有 actTeachers，有就用它，没有沿用上一条的，
        // 整块都没有 actTeachers 才退到块头 teachers 声明里的姓名（⑫）
        var blocks = digest.split(/var\s+teachers\s*=/);
        for (var i = 0; i < blocks.length; i++) {
            var block = blocks[i];
            var headTeacher = '';
            if (i > 0) {
                var head = /^\s*\[([\s\S]*?)\]\s*;/.exec(block);
                headTeacher = head ? teacherNamesOf(head[1]) : '';
            }
            var carriedTeacher = null;
            var re = /new\s+TaskActivity\s*\(([\s\S]*?)\)\s*;/g;
            var found = [];
            var m;
            while ((m = re.exec(block)) !== null) {
                found.push({ argsRaw: m[1], start: m.index, end: re.lastIndex });
            }
            for (var a = 0; a < found.length; a++) {
                activitiesFound++;
                var args = powerSplit(found[a].argsRaw);
                if (args.length < 7) { activitiesSkipped++; continue; }

                var name = courseNameOf(args[3]);
                if (!name) { name = '未知课程'; unnamedCourses++; }
                var ownTeacher = lastActTeachersOf(block.substring(a > 0 ? found[a - 1].end : 0, found[a].start));
                if (ownTeacher !== null) carriedTeacher = ownTeacher;
                var blockTeacher = carriedTeacher !== null ? carriedTeacher : headTeacher;
                var position = text(args[5]) || null;
                var weeks = weeksOfBitmap(args[6]);
                if (!weeks.length) { activitiesWithoutWeeks++; continue; }

                // index 属于这一条活动之后、下一条活动之前的那段代码
                var nextStart = a + 1 < found.length ? found[a + 1].start : block.length;
                var indexes = indexesOf(block.substring(found[a].end, nextStart), unitCount);
                var usable = 0;
                for (var k = 0; k < indexes.length; k++) {
                    if (indexes[k].unreadable) { droppedIndex++; continue; }
                    var day = indexes[k].day;
                    var section = indexes[k].section;
                    if (!(day >= 1 && day <= MAX_DAY)) { droppedDay++; continue; }
                    if (!(section >= 1 && section <= MAX_PERIOD) || (unitCount !== null && section > unitCount)) { droppedSection++; continue; }
                    usable++;
                    rawLessons.push({
                        name: name,
                        teacher: blockTeacher,
                        position: position,
                        day: day,
                        startSection: section,
                        endSection: section,
                        weeks: weeks
                    });
                }
                if (!indexes.length) droppedIndex++;
            }
        }
    }

    // ---------- 全局合并（上游 mergeContinuousLessons 的语义，实现换成 ES5 对象） ----------
    // 先按（课名|教师|教室|星期）分组，逐周记下占用的节次，再把每周里连续的节次合并成块。
    function mergeContinuous(lessons) {
        var order = [];
        var groups = {};
        var i;
        var j;
        var k;

        for (i = 0; i < lessons.length; i++) {
            var lesson = lessons[i];
            var key = lesson.name + SEP + lesson.teacher + SEP + (lesson.position || '') + SEP + lesson.day;
            if (!groups[key]) {
                groups[key] = { name: lesson.name, teacher: lesson.teacher, position: lesson.position, day: lesson.day, cells: {} };
                order.push(key);
            }
            var group = groups[key];
            for (j = 0; j < lesson.weeks.length; j++) {
                var week = lesson.weeks[j];
                var row = group.cells[week];
                if (!row) { row = {}; group.cells[week] = row; }
                for (k = lesson.startSection; k <= lesson.endSection; k++) row[k] = true;
            }
        }

        var merged = [];
        for (var g = 0; g < order.length; g++) {
            var item = groups[order[g]];
            var blockMap = {};
            var blockOrder = [];
            for (var week2 = 1; week2 <= MAX_WEEK; week2++) {
                var line = item.cells[week2];
                if (!line) continue;
                var sections = [];
                for (var s = 1; s <= MAX_PERIOD; s++) {
                    if (line[s]) sections.push(s);
                }
                if (!sections.length) continue;
                var start = sections[0];
                var prev = sections[0];
                for (var x = 1; x < sections.length; x++) {
                    var curr = sections[x];
                    if (curr === prev + 1) { prev = curr; continue; }
                    var keyDone = start + '-' + prev;
                    if (!blockMap[keyDone]) { blockMap[keyDone] = []; blockOrder.push(keyDone); }
                    blockMap[keyDone].push(week2);
                    start = curr;
                    prev = curr;
                }
                var keyLast = start + '-' + prev;
                if (!blockMap[keyLast]) { blockMap[keyLast] = []; blockOrder.push(keyLast); }
                blockMap[keyLast].push(week2);
            }
            for (var b = 0; b < blockOrder.length; b++) {
                var parts = blockOrder[b].split('-');
                merged.push({
                    name: item.name,
                    teacher: item.teacher,
                    position: item.position,
                    day: item.day,
                    startSection: parseInt(parts[0], 10),
                    endSection: parseInt(parts[1], 10),
                    weeks: blockMap[blockOrder[b]]
                });
            }
        }

        // 上游按（星期、起始节、课名、教室）排；这里把次级键补齐，结果与排序算法的稳定性无关
        merged.sort(function (a, b) {
            return cmpNum(a.day, b.day) || cmpNum(a.startSection, b.startSection) || cmpStr(a.name, b.name) ||
                cmpStr(a.position || '', b.position || '') || cmpNum(a.endSection, b.endSection) ||
                cmpNum(a.weeks[0], b.weeks[0]) || cmpStr(a.teacher, b.teacher);
        });
        return merged;
    }

    // ---------- 学期列表（只查当前学期的名字） ----------
    function semesterNameOf(optionsHtml, id) {
        var re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
        var m;
        while ((m = re.exec(rawText(optionsHtml))) !== null) {
            var value = /\bvalue\s*=\s*["']?(\d+)/i.exec(m[1]);
            if (value && value[1] === id) return text(stripTags(m[2])).replace(/ /g, '-');
        }
        return '';
    }

    // 「2025-2026-1」→「2025-2026学年第一学期」；别的写法原样用（过长截断）
    function termTitleOf(raw) {
        var m = /^(\d{4})-(\d{4})-(\d+)$/.exec(raw);
        if (!m) return raw.length > 40 ? raw.substring(0, 40) : raw;
        return m[1] + '-' + m[2] + '学年第' + (KIND_CN[m[3]] || m[3]) + '学期';
    }

    function todayParts() {
        var year;
        var month;
        if (/^\d{4}-\d{2}/.test(todayIso)) {
            year = parseInt(todayIso.substring(0, 4), 10);
            month = parseInt(todayIso.substring(5, 7), 10);
        } else {
            var now = new Date();
            year = now.getFullYear();
            month = now.getMonth() + 1;
        }
        return { year: year, month: month };
    }

    function todayAcademicName() {
        var t = todayParts();
        if (t.month >= 9 || t.month === 1) {
            var start = t.month === 1 ? t.year - 1 : t.year;
            return start + '-' + (start + 1) + '学年第一学期';
        }
        return (t.year - 1) + '-' + t.year + '学年第二学期';
    }

    // ---------- 教学周历（⑤，上游 parseCalendarInfo） ----------
    // extract.js 只交两样：「学年度 / 学期」后面那一格的文字（上游拿它跟所选学期核对）和「起 ~ 止 (总周数)」那一段
    function calendarOf(term, range) {
        var plain = text(range);
        if (!plain) return null;
        var termLabel = text(term).replace(/ /g, '-');
        var start = null;
        var end = null;
        var weeks = 0;
        var en = /([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\s*~\s*([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\s*\((\d+)\)/.exec(plain);
        if (en) {
            var m1 = MONTHS[en[1]];
            var m2 = MONTHS[en[4]];
            if (m1 && m2) {
                start = isoFromNumbers(en[3], m1, en[2]);
                end = isoFromNumbers(en[6], m2, en[5]);
                weeks = parseInt(en[7], 10);
            }
        } else {
            var num = /(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\s*(?:~|～|至|到)\s*(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\s*[（(]\s*(\d+)\s*[)）]/.exec(plain);
            if (num) {
                start = isoFromNumbers(num[1], num[2], num[3]);
                end = isoFromNumbers(num[4], num[5], num[6]);
                weeks = parseInt(num[7], 10);
            }
        }
        if (!start || !end || end < start || !(weeks >= 1)) return { termLabel: termLabel, usable: false };
        return { termLabel: termLabel, usable: true, start: start, end: end, weeks: weeks };
    }

    // 没有可用的教学周历时按学期名推算开学日：第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一
    function guessedFirstDay(nameRaw) {
        var m = /^(\d{4})-(\d{4})-(\d+)$/.exec(nameRaw);
        var year = null;
        var autumn = true;
        var rule = '';
        if (m && (m[3] === '1' || m[3] === '2')) {
            autumn = m[3] === '1';
            year = parseInt(autumn ? m[1] : m[2], 10);
            rule = autumn ? '第一学期 = 9 月 1 日所在周的周一' : '第二学期 = 2 月 20 日所在周的周一';
        } else {
            var t = todayParts();
            autumn = !(t.month >= 2 && t.month <= 8);
            year = autumn ? (t.month === 1 ? t.year - 1 : t.year) : t.year;
            rule = '没有学期信息，按 ' + year + (autumn ? ' 年 9 月 1 日' : ' 年 2 月 20 日') + '所在周的周一';
        }
        var anchor = year + '-' + (autumn ? '09-01' : '02-20');
        return { iso: mondayOnOrBefore(anchor), rule: rule };
    }

    // ---------- 主流程 ----------
    if (!text(digest)) {
        throw new Error(
            '教务系统没有返回课表：登录状态可能已失效。请从统一认证门户重新打开「教务系统」，在课表页里确认能看到课，再点「提取课表」'
        );
    }

    collectActivities();
    var merged = mergeContinuous(rawLessons);

    if (!merged.length) {
        throw new Error(
            '这个学期没有读到任何课程' +
            (activitiesFound > 0 ? '（课表里有 ' + activitiesFound + ' 条上课安排，都没法读出星期、节次或周次）' : '') +
            '。可能是这个学期还没排课；如果教务系统里能看到课，请反馈给我们'
        );
    }

    // ---------- 组装课程与上课时段 ----------
    var courseOrder = [];
    var courseMap = {};
    var maxWeek = 0;
    var maxPeriodUsed = 0;
    var noTeacher = {};
    var noTeacherNames = [];
    var noRoom = {};
    var noRoomNames = [];

    for (var i = 0; i < merged.length; i++) {
        var item = merged[i];
        var key = item.name + SEP + item.teacher;
        if (!courseMap[key]) {
            courseMap[key] = { name: item.name, teacher: item.teacher || null, note: null, blocks: [] };
            courseOrder.push(key);
        }
        if (!item.teacher && !noTeacher['k' + item.name]) { noTeacher['k' + item.name] = true; noTeacherNames.push(item.name); }
        if (!item.position && !noRoom['k' + item.name]) { noRoom['k' + item.name] = true; noRoomNames.push(item.name); }
        if (item.endSection > maxPeriodUsed) maxPeriodUsed = item.endSection;
        var runs = runsOf(item.weeks);
        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            if (run.end > maxWeek) maxWeek = run.end;
            courseMap[key].blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.startSection,
                endPeriod: item.endSection,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item.position || null
            });
        }
    }

    var courses = [];
    for (var c = 0; c < courseOrder.length; c++) courses.push(courseMap[courseOrder[c]]);

    // ---------- 学期名 ----------
    var semesterNameRaw = semesterId ? semesterNameOf(data.semesterOptions, semesterId) : '';
    var termName = semesterNameRaw ? termTitleOf(semesterNameRaw) : '';
    var termNameGuessed = false;
    if (!termName) {
        termName = SCHOOL_NAME + ' ' + todayAcademicName();
        termNameGuessed = true;
    }

    // ---------- 开学日与总周数 ----------
    var calendar = calendarOf(calendarTerm, calendarRange);
    var calendarRejected = false;
    if (calendar && calendar.usable && calendar.termLabel && semesterNameRaw && calendar.termLabel !== semesterNameRaw) {
        calendarRejected = true;
        calendar = null;
    }
    var calendarUsable = !!(calendar && calendar.usable);

    var firstDay;
    var alignedFrom = null;
    var guess = null;
    if (calendarUsable) {
        firstDay = mondayOnOrBefore(calendar.start);
        if (firstDay !== calendar.start) alignedFrom = calendar.start;
    } else {
        guess = guessedFirstDay(semesterNameRaw);
        firstDay = guess.iso;
    }

    var calendarWeeksRaw = calendarUsable ? calendar.weeks : 0;
    var calendarWeeks = calendarWeeksRaw;
    var calendarWeeksClamped = false;
    if (calendarWeeks > MAX_WEEK) { calendarWeeks = MAX_WEEK; calendarWeeksClamped = true; }
    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : (maxWeek >= 1 ? maxWeek : FALLBACK_TOTAL_WEEKS);
    var raisedBySchedule = false;
    if (totalWeeks < maxWeek) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    // ---------- 节次时间：学校公布的 10 节；课表用到更晚的节次时逐节补（H3） ----------
    var periodTimes = [];
    for (var p0 = 0; p0 < SCHOOL_PERIOD_TIMES.length; p0++) {
        var s0 = timeOf(SCHOOL_PERIOD_TIMES[p0].start);
        var e0 = timeOf(SCHOOL_PERIOD_TIMES[p0].end);
        if (s0 && e0 && minutesOf(s0) < minutesOf(e0)) {
            periodTimes.push({ periodIndex: SCHOOL_PERIOD_TIMES[p0].periodIndex, start: s0, end: e0 });
        }
    }
    var tableLength = periodTimes.length;
    var fromHost = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = tableLength + 1; p <= maxPeriodUsed; p++) {
        var prev = periodTimes.length ? periodTimes[periodTimes.length - 1] : null;
        var prevEnd = prev ? minutesOf(prev.end) : -1;
        var hostSlot = HOST_PERIOD_TIMES[p - 1];
        if (hostSlot && minutesOf(hostSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: hostSlot.start, end: hostSlot.end });
            fromHost.push(p);
            continue;
        }
        if (!prev) { uncoveredFrom = p; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    function sectionsText(list) {
        var runsText = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            runsText.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + runsText.join('、') + ' 节';
    }

    // ---------- 提醒（顺序固定：最要紧的在前） ----------
    if (termNameGuessed) {
        warn('教务系统没有给出学期名，已按导入日期推成「' + termName + '」，请到学期管理里核对');
    }
    warn('这次导入的是教务系统当前学期（' + termName + '）的课表；其它学期暂时不能导入');

    if (calendarUsable) {
        warn('开学日期取自教务系统的教学周历：第 1 周从 ' + firstDay + ' 开始，请在学期管理里核对');
        if (alignedFrom) {
            warn(
                '教学周历写的起始日 ' + alignedFrom + '（' + WEEKDAY_CN[weekdayOfIso(alignedFrom)] +
                '）不是周一，第 1 周已按那一周的周一 ' + firstDay + ' 开始，请在学期管理里核对'
            );
        }
    } else if (calendarRejected) {
        warn(
            '教务系统返回的教学周历不是这个学期的，已忽略；开学日期按「' + guess.rule + '」推算为 ' + firstDay +
            '，请在学期管理里核对成学校实际开学日'
        );
    } else {
        warn(
            '教务系统没有给出可用的教学周历，开学日期按「' + guess.rule + '」推算为 ' + firstDay +
            '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (calendarWeeks > 0) {
        if (raisedBySchedule) {
            warn(
                '教学周历写的一学期是 ' + calendarWeeks + ' 周，但课表里有第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks +
                ' 周导入（否则那几周的课放不下），请在学期管理里核对'
            );
        } else if (calendarWeeksClamped) {
            warn(
                '教学周历写的一学期是 ' + calendarWeeksRaw + ' 周，应用最多支持 ' + MAX_WEEK + ' 周，已按 ' + MAX_WEEK +
                ' 周导入，如与实际不符可在学期管理里改'
            );
        } else {
            warn('学期总周数取自教务系统的教学周历（' + calendarWeeks + ' 周），如与实际不符可在学期管理里改');
        }
    } else {
        warn(
            '教务系统没有给出学期总周数，已按课表里最晚的第 ' + totalWeeks + ' 周导入，如校历不同请在学期管理里调整'
        );
    }

    warn(
        '节次时间用的是学校公布的节次时间（共 ' + tableLength + ' 节，第 1 节 ' + periodTimes[0].start + '-' +
        periodTimes[0].end + '），不是从教务系统读取的，请对照学校通知核对'
    );
    if (fromHost.length || bySequence.length) {
        var fillTexts = [];
        if (fromHost.length) fillTexts.push(sectionsText(fromHost) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromHost.concat(bySequence);
        filledAll.sort(function (a, b) { return a - b; });
        warn('课表用到了' + sectionsText(filledAll) + '，学校公布的节次时间没有覆盖，已补上：' + fillTexts.join('，') + '，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    if (noTeacherNames.length) {
        warn(
            '有 ' + noTeacherNames.length + ' 门课教务系统没有给出教师（' + namesText(noTeacherNames) +
            '），已按空导入；教师可以在对应课程的「编辑课程」里补上'
        );
    }
    if (noRoomNames.length) {
        warn(
            '有 ' + noRoomNames.length + ' 门课教务系统没有给出教室（' + namesText(noRoomNames) +
            '），已按空导入；教室可以在对应课程的「编辑课程」里补上'
        );
    }
    if (unnamedCourses > 0) {
        warn('有 ' + unnamedCourses + ' 条上课安排没有课名，已按「未知课程」导入，请到教务系统核对');
    }

    var skippedReasons = [];
    if (activitiesSkipped) skippedReasons.push('信息不全 ' + activitiesSkipped + ' 条');
    if (activitiesWithoutWeeks) skippedReasons.push('没有上课周次 ' + activitiesWithoutWeeks + ' 条');
    if (droppedIndex) skippedReasons.push('读不出星期和节次 ' + droppedIndex + ' 处');
    if (droppedDay) skippedReasons.push('星期超出周一到周日 ' + droppedDay + ' 处');
    if (droppedSection) skippedReasons.push('节次超出范围 ' + droppedSection + ' 处');
    if (skippedReasons.length) {
        warn('有上课安排没能导入（' + skippedReasons.join('、') + '），请在教务系统里核对课表');
    }
    var reported = parseInt(data.activityCount, 10);
    if (reported > activitiesFound) {
        warn('教务系统的课表里有 ' + reported + ' 条上课安排，只读到 ' + activitiesFound + ' 条，请核对课表');
    }

    if (zeroBitSeen) {
        warn('有课程标了「第 0 周」上课，这一周已忽略，请在导入预览里核对周次');
    }
    if (droppedOverflowWeeks > 0) {
        warn('有 ' + droppedOverflowWeeks + ' 个周次超出第 1-' + MAX_WEEK + ' 周，已忽略，请核对课表');
    }
    if (junkBitmapChars > 0) {
        warn('有课程的上课周次里有 ' + junkBitmapChars + ' 处读不懂的标记，已跳过，请核对周次');
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [
            {
                name: termName,
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
