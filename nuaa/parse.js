(function () {
    // 南京航空航天大学教务适配器（树维 EAMS 平台）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 NUAA/nuaa_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游 maintainer kemi-20）
    //   上游快照 ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    //
    // 上游这一段的骨架（照搬）：
    //   ① powerSplit(参数串)：按顶层逗号切 TaskActivity 的参数（括号深度 + 引号状态感知）
    //   ② 按 var teachers = 分块：教师取自 actTeachers 的 name；课名、教室、位图取自 TaskActivity 的参数
    //   ③ index = 星期 * unitCount + 单元（两个数都从 0 起算，所以各 +1）
    //   ④ mergeContinuousLessons：课名|教师|教室|星期相同、节次连续的活动并成一个课程块
    //
    // 移植改动（逐条对照 AUDIT.md §4）：
    //   ① ES6 → ES5（模板串、箭头函数、块级声明、扩展运算符、Array.from / Set / endsWith 全部去掉）
    //   ② 参数位次：课名 args[3]、教室 args[6]、位图 args[7]（上游同款）
    //   ③ 节次映射（上游 mapSection）：单元 1-4 → 第 1-4 节；单元 5、6（午一 / 午二）不导入，
    //      逐门点名进 warnings；单元 7-13 → 第 5-11 节。其余数字判为越界，计数并 warn
    //   ④ 课程名原样保留：只 trim，不切括号，也不摘末尾序号（模板 tjau 的上游用 split('(')[0]，会切掉「(一)」之类；NUAA 上游只 trim，本件与它一致）
    //   ⑤ 教室：照上游去掉括号内容再 trim；去掉之后为空就留空（null），不写「未知地点」
    //   ⑥ 教师：先取 actTeachers 的 name；取不到时 args[1] 是字符串字面量就用它（照模板 tjau），
    //      是表达式（如 teachers.join(",")）则留空（null）并计数提醒；不写「未知教师」
    //   ⑦ 位图：下标 i 即第 i 周。第 0 位为 1 不产出第 0 周（那一位是占位符），计数并 warn；
    //      超过第 30 周的位丢弃并 warn（载荷上限 30 周）
    //   ⑧ 两种定位都认：index = 星期*unitCount+单元 与已算好的 index = N（后者用 unitCount 换算）
    //   ⑨ unitCount：课表响应里读；读不到用页面上的 unitCountPage；都没有用缺省 13，并 warn
    //   ⑩ 作息表整学期只用一张：有教室含「天目湖」的安排 → 天目湖表，否则 → 明故宫/将军路表；
    //      两种都出现时按天目湖表导入并额外提醒核对
    //   ⑪ 不用 eval：学期日历在 extract.js 里只做字面量扫描，本文件只读它交出来的 semester 对象
    //   ⑫ 开学日：优先用选中学期的起始日期，回退到那一周的周一；拿不到就按第一学期 9 月 1 日、
    //      第二学期 2 月 20 日所在周的周一推算，推算一定写进 warnings
    //   ⑬ 上游的 showSingleSelection（选学期弹窗）、showToast、saveImportedCourses、savePresetTimeSlots
    //      全部没有移植；本文件是纯函数（CI 用 Rhino 实跑的就是这一段）

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var html = typeof data.courseTable === 'string' ? data.courseTable : '';
    var sem = data.semester && typeof data.semester === 'object' ? data.semester : null;

    var SEP = String.fromCharCode(0);        // 复合键分隔符：用 fromCharCode 取，源码里不出现控制字符
    var BACKSLASH = String.fromCharCode(92); // 判引号转义用，源码里不出现转义序列

    var MAX_WEEK = 30;              // 载荷校验：totalWeeks ∈ 1..30，startWeek/endWeek ∈ 1..totalWeeks
    var MAX_UNIT = 13;              // 单元编号 1-13（5、6 是午间）；14 以上在这套作息里没有对应节次
    var DEFAULT_UNIT_COUNT = 13;    // 课表响应和页面上都读不到 unitCount 时的缺省值，同时进 warnings
    var FALLBACK_TOTAL_WEEKS = 20;  // 教务不给学期起止日期时的总周数
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;

    // 作息表：逐条对照上游 nuaa_01.js 的 getTimeSlots（官方校历，11 节，不含午一 / 午二）
    var TIANMUHU_TIMES = [
        ['08:30', '09:20'], ['09:25', '10:15'], ['10:30', '11:20'], ['11:25', '12:15'],
        ['14:00', '14:50'], ['14:55', '15:45'], ['16:00', '16:50'], ['16:55', '17:45'],
        ['18:45', '19:35'], ['19:40', '20:30'], ['20:35', '21:25']
    ];
    var OTHER_TIMES = [
        ['08:00', '08:50'], ['08:55', '09:45'], ['10:15', '11:05'], ['11:10', '12:00'],
        ['14:00', '14:50'], ['14:55', '15:45'], ['16:15', '17:05'], ['17:10', '18:00'],
        ['18:45', '19:35'], ['19:40', '20:30'], ['20:35', '21:25']
    ];

    // ---------- 小工具 ----------
    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
    }

    function mondayOfIso(iso) {
        if (!iso) return null;
        return isoOf(mondayOnOrBefore(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10),
            parseInt(iso.substring(8, 10), 10)
        ));
    }

    function epochOfIso(iso) {
        if (!iso) return null;
        return Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        );
    }

    function isoOfAny(value) {
        var m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function cmpNum(a, b) {
        return a === b ? 0 : (a < b ? -1 : 1);
    }

    function cmpStr(a, b) {
        if (a === b) return 0;
        return a < b ? -1 : 1;
    }

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    // ---------- warnings（全部经 warn 收口：单条截断、总数封顶） ----------
    var allWarnings = [];

    function warn(message) {
        var line = String(message);
        if (line.length > MAX_WARNING_CHARS) line = line.substring(0, MAX_WARNING_CHARS - 1) + '…';
        allWarnings.push(line);
    }

    // ---------- TaskActivity 参数切分（上游 powerSplit 的 ES5 写法，返回清洗前的原始段） ----------
    // 按顶层逗号切：括号 / 方括号 / 花括号深度为 0 且不在引号里时才算分隔符。
    // 返回的是原始段（只 trim），清洗放到使用点，这样「表达式」与「字面量」才分得开。
    function powerSplit(paramsRaw) {
        var args = [];
        var current = '';
        var depth = 0;
        var inQuote = false;
        var quoteChar = '';
        var i;
        for (i = 0; i < paramsRaw.length; i++) {
            var ch = paramsRaw.charAt(i);
            if ((ch === '"' || ch === "'") && (i === 0 || paramsRaw.charAt(i - 1) !== BACKSLASH)) {
                if (!inQuote) {
                    inQuote = true;
                    quoteChar = ch;
                } else if (ch === quoteChar) {
                    inQuote = false;
                }
            }
            if (!inQuote) {
                if (ch === '(' || ch === '[' || ch === '{') depth++;
                if (ch === ')' || ch === ']' || ch === '}') depth--;
            }
            if (ch === ',' && depth === 0 && !inQuote) {
                args.push(text(current));
                current = '';
            } else {
                current += ch;
            }
        }
        args.push(text(current));
        return args;
    }

    // 去掉两端的引号；字面量 null 变成 null
    function cleanArg(raw) {
        if (raw === null || raw === undefined) return null;
        var value = text(raw);
        if (value === 'null' || value === 'undefined') return null;
        return value.replace(/^["']|["']$/g, '');
    }

    function isLiteralArg(raw) {
        var s = text(raw);
        if (!s) return false;
        var first = s.charAt(0);
        return first === '"' || first === "'";
    }

    var exprNameHits = 0;    // 课名写成表达式（只能取其中的字符串字面量）的活动数

    // 课名：字面量照取；表达式（如 courseName + "（实验）"）只取其中的字符串字面量并计数
    function nameOfArg(raw) {
        var s = text(raw);
        if (!s || s === 'null') return '';
        if (isLiteralArg(s)) return text(cleanArg(s) || '');
        var literals = s.match(/["'][^"']*["']/g) || [];
        exprNameHits++;
        var joined = '';
        var i;
        for (i = 0; i < literals.length; i++) joined += cleanArg(literals[i]) || '';
        return text(joined);
    }

    // 教师：actTeachers 取不到时才看 args[1]（照模板 tjau）：字符串字面量照取；表达式留空并计数
    var exprTeacherHits = 0;  // actTeachers 缺失且 args[1] 是表达式的活动数（教师留空，单独提醒）

    function teacherOfArg(raw) {
        var s = text(raw);
        if (!s) return '';
        if (isLiteralArg(s)) return text(cleanArg(s));
        exprTeacherHits++;
        return '';
    }

    // 教室：照上游去掉括号内容再 trim（replace(/\(.*?\)/g, "")）；去掉之后为空就留空
    function locationOf(raw) {
        return text(String(raw === null || raw === undefined ? '' : raw).replace(/\(.*?\)/g, ''));
    }

    // ---------- 周次位图 ----------
    var zeroBitHits = 0;      // 位图第 0 位为 1 的活动数（占位符，不产出第 0 周）
    var outOfRangeWeeks = 0;  // 位图里超过第 30 周的周次个数（载荷上限，丢弃）
    var emptyBitmaps = 0;     // 位图缺失、或一个 1 都没有的活动数

    // 位图下标 i 就是第 i 周；下标 0 是占位符（同族 uestc / hpu / hunnu / zua / zzvcae 的共同约定）。
    // 上游 for (j = 0; ...) push(j) 会把第 0 位产出为「第 0 周」，整包会被载荷校验拒掉，所以这里跳过并计数。
    function weeksOfBitmap(bitmap) {
        var weeks = [];
        var seen = {};
        var raw = String(bitmap === null || bitmap === undefined ? '' : bitmap);
        var i;
        for (i = 0; i < raw.length; i++) {
            if (raw.charAt(i) !== '1') continue;
            if (i === 0) {
                zeroBitHits++;
                continue;
            }
            if (i > MAX_WEEK) {
                outOfRangeWeeks++;
                continue;
            }
            if (!seen[i]) {
                seen[i] = true;
                weeks.push(i);
            }
        }
        if (!weeks.length) emptyBitmaps++;
        weeks.sort(cmpNum);
        return weeks;
    }

    // ---------- 解析课表 HTML 里的 TaskActivity ----------
    var unitCountUnread = false;  // 课表响应和页面上都没有 unitCount，用了缺省值
    var noonNames = [];           // 节次落在午间（单元 5、6）而被丢弃的课程名，按出现顺序去重
    var noonSeen = {};
    var strayIndexes = 0;         // 换算出来的星期或单元超出范围的定位数
    var bareIndexes = 0;          // 已算好的 index = N 形态（用 unitCount 换算了）的定位数
    var blocksWithoutIndex = 0;   // TaskActivity 没有任何可用定位的块数
    var noTeacherHits = 0;        // 教师留空的活动数（含 args[1] 为表达式的，那部分另计 exprTeacherHits）
    var noNameHits = 0;           // 课名为空、只能跳过的活动数

    function readUnitCount(source) {
        var m = /unitCount\s*=\s*(\d{1,3})/.exec(String(source === null || source === undefined ? '' : source));
        if (!m) return null;
        var n = parseInt(m[1], 10);
        if (!(n >= 1 && n <= 60)) return null;
        return n;
    }

    // 单元（系统节次，1 起）→ 官方节次：1-4 原样；7-13 减 2；5、6 与越界返回 0（由调用方处理）
    function periodOfUnit(unit) {
        if (unit >= 1 && unit <= 4) return unit;
        if (unit >= 7 && unit <= MAX_UNIT) return unit - 2;
        return 0;
    }

    function noteNoon(name) {
        if (hasOwn(noonSeen, name)) return;
        noonSeen[name] = true;
        noonNames.push(name);
    }

    function addSlot(lessons, name, teacher, location, campus, day, unit, weeks) {
        if (!name || !weeks.length) return;
        if (unit === 5 || unit === 6) {
            noteNoon(name);
            return;
        }
        var period = periodOfUnit(unit);
        if (day < 1 || day > 7 || !period) {
            strayIndexes++;
            return;
        }
        lessons.push({
            name: name,
            teacher: teacher,
            location: location,
            campus: campus,
            day: day,
            period: period,
            weeks: weeks
        });
    }

    function parseTaskActivities(source, unitCount) {
        var lessons = [];
        var blocks = source.split(/var\s+teachers\s*=/);
        var i;
        for (i = 1; i < blocks.length; i++) {
            var block = blocks[i];
            var teacherMatch = /actTeachers\s*=\s*\[\s*\{[\s\S]*?name:\s*"(.*?)"/.exec(block);
            var teacher = teacherMatch ? text(teacherMatch[1]) : '';

            var activityMatch = /new\s+TaskActivity\(([\s\S]*?)\);/.exec(block);
            if (!activityMatch) continue;

            var args = powerSplit(activityMatch[1]);
            if (!teacher) teacher = teacherOfArg(args[1]);
            if (!teacher) noTeacherHits++;

            var name = nameOfArg(args[3]);
            if (!name) noNameHits++;
            var locRaw = cleanArg(args[6]);
            var location = locationOf(locRaw);
            var campus = /天目湖/.test(locRaw === null ? '' : locRaw);
            var weeks = weeksOfBitmap(cleanArg(args[7]));

            var located = 0;
            var m;
            // 定位一：index = 星期 * unitCount + 单元;（下标都从 0 起，各 +1）
            var formA = /index\s*=\s*(\d+)\s*\*\s*unitCount\s*\+\s*(\d+)\s*;/g;
            while ((m = formA.exec(block)) !== null) {
                located++;
                addSlot(lessons, name, teacher, location, campus,
                    parseInt(m[1], 10) + 1, parseInt(m[2], 10) + 1, weeks);
            }

            // 定位二：index = 62;（已算好的线性下标，用 unitCount 换算成星期与单元）
            var rest = block.replace(/index\s*=\s*\d+\s*\*\s*unitCount\s*\+\s*\d+\s*;/g, '');
            var bare = /index\s*=\s*(\d+)\s*;/g;
            while ((m = bare.exec(rest)) !== null) {
                located++;
                bareIndexes++;
                var linear = parseInt(m[1], 10);
                addSlot(lessons, name, teacher, location, campus,
                    Math.floor(linear / unitCount) + 1, (linear % unitCount) + 1, weeks);
            }

            if (!located) blocksWithoutIndex++;
        }
        return lessons;
    }

    // ---------- 合并（上游 mergeContinuousLessons，确定性的 ES5 写法） ----------
    // 语义与上游一致：每周 → 该周上这门课的节次集合 → 同一周里连续的节次并成一段（1-2 节 + 3-4 节 → 1-4 节）→
    // 同一段节次把这些周合起来（1-8 周 + 9-16 周 → 1-16 周）。上游用 Set / 对象键序，这里换成显式数组与码位比较，
    // 保证 Rhino 与 V8 给出同一份结果（fixture 是逐数组比对的）
    function mergeContinuousLessons(lessons) {
        if (!lessons || !lessons.length) return [];

        var groupOrder = [];
        var groups = {};
        var i;
        for (i = 0; i < lessons.length; i++) {
            var lesson = lessons[i];
            var key = lesson.name + SEP + lesson.teacher + SEP + lesson.location + SEP + lesson.day;
            if (!groups[key]) {
                groups[key] = {
                    name: lesson.name,
                    teacher: lesson.teacher,
                    location: lesson.location,
                    day: lesson.day,
                    periods: [],
                    weeks: []
                };
                groupOrder.push(key);
            }
            groups[key].periods.push(lesson.period);
            groups[key].weeks.push(lesson.weeks);
        }
        groupOrder.sort();

        var blockMap = {};
        var blockOrder = [];
        for (i = 0; i < groupOrder.length; i++) {
            var group = groups[groupOrder[i]];
            // 第 N 周 → 这一周上这门课的节次集合
            var weekNumbers = [];
            var cells = {};
            var j;
            var k;
            for (j = 0; j < group.periods.length; j++) {
                var weeks = group.weeks[j];
                for (k = 0; k < weeks.length; k++) {
                    var week = weeks[k];
                    if (week < 1 || week > MAX_WEEK) continue;
                    if (!cells[week]) {
                        cells[week] = {};
                        weekNumbers.push(week);
                    }
                    cells[week][group.periods[j]] = true;
                }
            }
            weekNumbers.sort(cmpNum);

            for (j = 0; j < weekNumbers.length; j++) {
                var weekNo = weekNumbers[j];
                var periods = [];
                for (var p in cells[weekNo]) {
                    if (hasOwn(cells[weekNo], p)) periods.push(parseInt(p, 10));
                }
                periods.sort(cmpNum);
                var start = periods[0];
                var prev = periods[0];
                for (k = 1; k < periods.length; k++) {
                    if (periods[k] === prev + 1) {
                        prev = periods[k];
                        continue;
                    }
                    addBlock(blockMap, blockOrder, group, start, prev, weekNo);
                    start = periods[k];
                    prev = periods[k];
                }
                addBlock(blockMap, blockOrder, group, start, prev, weekNo);
            }
        }

        var out = [];
        for (i = 0; i < blockOrder.length; i++) {
            var item = blockMap[blockOrder[i]];
            out.push({
                name: item.name,
                teacher: item.teacher,
                location: item.location,
                day: item.day,
                startSection: item.start,
                endSection: item.end,
                weeks: item.weeks
            });
        }
        return out;
    }

    function addBlock(blockMap, blockOrder, group, start, end, week) {
        var key = group.name + SEP + group.teacher + SEP + group.location + SEP + group.day + SEP +
            start + SEP + end;
        if (!blockMap[key]) {
            blockMap[key] = {
                name: group.name,
                teacher: group.teacher,
                location: group.location,
                day: group.day,
                start: start,
                end: end,
                weeks: []
            };
            blockOrder.push(key);
        }
        if (blockMap[key].weeks.indexOf(week) < 0) blockMap[key].weeks.push(week);
    }

    // 周次集合 → 极大段：步长 1 是每周、步长 2 是单/双周
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

    // ---------- 节次与课程 ----------
    var unitCount = readUnitCount(html);
    if (!unitCount && typeof data.unitCountPage === 'number' && data.unitCountPage >= 1 && data.unitCountPage <= 60) {
        unitCount = data.unitCountPage;
    }
    if (!unitCount) {
        unitCount = DEFAULT_UNIT_COUNT;
        unitCountUnread = true;
    }

    var lessons = parseTaskActivities(html, unitCount);
    var merged = mergeContinuousLessons(lessons);

    // 作息表二选一（整学期一张）：有教室含「天目湖」的安排 → 天目湖表；否则 → 明故宫/将军路表
    var tianmuhuCount = 0;
    var otherCount = 0;
    var li;
    for (li = 0; li < lessons.length; li++) {
        if (lessons[li].campus) tianmuhuCount++;
        else otherCount++;
    }

    var courseOrder = [];
    var byCourse = {};
    var mi;
    for (mi = 0; mi < merged.length; mi++) {
        var mergedItem = merged[mi];
        var courseKey = mergedItem.name + SEP + mergedItem.teacher;
        if (!byCourse[courseKey]) {
            byCourse[courseKey] = { name: mergedItem.name, teacher: mergedItem.teacher, blocks: [], seen: {} };
            courseOrder.push(courseKey);
        }
    }
    courseOrder.sort();

    var maxWeek = 0;
    for (mi = 0; mi < merged.length; mi++) {
        var entry = merged[mi];
        var course = byCourse[entry.name + SEP + entry.teacher];
        var runList = runsOf(entry.weeks.slice().sort(cmpNum));
        var r;
        for (r = 0; r < runList.length; r++) {
            var run = runList[r];
            if (run.end > maxWeek) maxWeek = run.end;
            var blockKey = entry.day + '|' + entry.startSection + '|' + entry.endSection + '|' +
                run.start + '|' + run.end + '|' + run.weekType + '|' + entry.location;
            if (course.seen[blockKey]) continue;   // 完全重复的安排只留一条
            course.seen[blockKey] = true;
            course.blocks.push({
                dayOfWeek: entry.day,
                startPeriod: entry.startSection,
                endPeriod: entry.endSection,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: entry.location ? entry.location : null
            });
        }
    }

    var courses = [];
    for (mi = 0; mi < courseOrder.length; mi++) {
        var built = byCourse[courseOrder[mi]];
        built.blocks.sort(function (a, b) {
            return cmpNum(a.dayOfWeek, b.dayOfWeek) || cmpNum(a.startPeriod, b.startPeriod) ||
                cmpNum(a.endPeriod, b.endPeriod) || cmpNum(a.startWeek, b.startWeek) ||
                cmpNum(a.endWeek, b.endWeek) || cmpStr(a.weekType, b.weekType) ||
                cmpStr(a.location || '', b.location || '');
        });
        courses.push({
            name: built.name,
            teacher: built.teacher ? built.teacher : null,
            note: null,
            blocks: built.blocks
        });
    }

    if (!courses.length) {
        throw new Error(
            '没有从教务返回的课表里解析出课程（响应 ' + html.length + ' 个字符）：' +
            '可能这个学期还没排课，也可能登录状态已失效。请重新登录、在教务页面里确认能看到课表后再点「提取课表」'
        );
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var KIND_CN = { '1': '一', '2': '二', '3': '三', '4': '四' };

    // 学期序号（第几学期）：标签是 1-4，或带「第一学期」这类字样才认得出；认不出返回空串
    function termKindOf() {
        var label = sem ? text(sem.rawName) : '';
        if (hasOwn(KIND_CN, label)) return KIND_CN[label];
        var m = /第([一二三四])学期/.exec(label);
        return m ? m[1] : '';
    }

    // 学期名用教务自己的「学年 + 第几学期」：rawName 含「学期」时，以年份开头就原样用，否则补「<学年>学年」前缀；
    // rawName 是 1-4 时拼成「<学年>学年第X学期」；其余（空、5、春……）返回空串，由 fallbackNameOf 代替
    function termNameOf() {
        if (sem) {
            var label = text(sem.rawName);
            var year = text(sem.schoolYear);
            if (label && label.indexOf('学期') >= 0) {
                if (/^[0-9]{4}/.test(label)) return label;
                return year ? year + '学年' + label : '';
            }
            if (year && hasOwn(KIND_CN, label)) return year + '学年第' + KIND_CN[label] + '学期';
        }
        return '';
    }

    // 教务给不出可用的学期名时的代替：「南京航空航天大学 <学年>学年第X学期」，学期序号认不出就写「（学期未知）」；
    // 学年取教务学年文本，没有就按今天推（调用方会写 warnings）
    function fallbackNameOf() {
        var year = sem ? text(sem.schoolYear) : '';
        if (!year) {
            var todayIso = isoOfAny(data.today);
            if (todayIso) {
                var y = parseInt(todayIso.substring(0, 4), 10);
                year = y + '-' + (y + 1);
            }
        }
        var kind = termKindOf();
        var tail = kind ? '第' + kind + '学期' : '（学期未知）';
        return (year ? '南京航空航天大学 ' + year + '学年' : '南京航空航天大学') + tail;
    }

    var calendarName = termNameOf();
    var nameFallback = !calendarName;
    var name0 = calendarName || fallbackNameOf();

    // 开学日：选中学期的起始日期 → 回退到那一周的周一；拿不到就按学期锚点推算（推算必进 warnings）
    var calendarStart = sem ? isoOfAny(sem.startDate) : null;
    var calendarEnd = sem ? isoOfAny(sem.endDate) : null;
    var startInfo;
    var academicYear = sem && /^[0-9]{4}/.test(text(sem.schoolYear))
        ? parseInt(text(sem.schoolYear).substring(0, 4), 10) : 0;
    if (calendarStart) {
        startInfo = {
            iso: mondayOfIso(calendarStart),
            rule: '教务给的学期起始日期（' + calendarStart + '）所在周的周一',
            source: '教务'
        };
    } else {
        var todayIso = isoOfAny(data.today);
        if (!academicYear && todayIso) academicYear = parseInt(todayIso.substring(0, 4), 10);
        if (!academicYear) academicYear = new Date().getUTCFullYear();
        var isSecond = termKindOf() === '二';
        startInfo = {
            iso: isoOf(mondayOnOrBefore(academicYear + (isSecond ? 1 : 0), isSecond ? 2 : 9, isSecond ? 20 : 1)),
            rule: (isSecond ? '第二学期 2 月 20 日' : '第一学期 9 月 1 日') +
                '所在周的周一（' + academicYear + ' 学年）',
            source: '推算'
        };
    }

    // 总周数：教务给了学期起止日期就用它的周数，否则用缺省 20；课表里更晚的周次放得下（抬高时单独说明）；
    // 最后不超过载荷上限 30（截断时单独说明）
    var calendarWeeks = 0;
    if (calendarStart && calendarEnd) {
        var from = epochOfIso(mondayOfIso(calendarStart));
        var to = epochOfIso(calendarEnd);
        if (from !== null && to !== null && to >= from) {
            calendarWeeks = Math.ceil((Math.floor((to - from) / 86400000) + 1) / 7);
        }
    }
    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clampedWeeks = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raisedBySchedule = true;
    }
    if (totalWeeks > MAX_WEEK) {
        totalWeeks = MAX_WEEK;
        clampedWeeks = true;
    }
    if (totalWeeks < 1) totalWeeks = FALLBACK_TOTAL_WEEKS;

    // ---------- 作息时间（整学期一张） ----------
    var useTianmuhu = tianmuhuCount > 0;
    var timeRows = useTianmuhu ? TIANMUHU_TIMES : OTHER_TIMES;
    var periodTimes = [];
    var pi;
    for (pi = 0; pi < timeRows.length; pi++) {
        periodTimes.push({ periodIndex: pi + 1, start: timeRows[pi][0], end: timeRows[pi][1] });
    }

    // ---------- warnings（顺序即输出顺序） ----------
    function warnNames(prefix, names) {
        var line = '';
        var k;
        for (k = 0; k < names.length; k++) {
            var piece = line ? '、' + names[k] : names[k];
            if (line && (prefix + line + piece).length > 150) {
                warn(prefix + line);
                line = names[k];
            } else {
                line += piece;
            }
        }
        if (line) warn(prefix + line);
    }

    var BASES = {
        page: '由课表页上当前选中的学期给出',
        current: '由教务学期日历标出的当前学期给出',
        date: '由起止日期包含今天的那个学期给出',
        latest: '由起始日期最晚的那个学期给出',
        last: '由学期列表里的最后一项给出'
    };

    warn(
        '只导入了一个学期（' + name0 + '，' + (BASES[sem && sem.source] || '由教务给出') + '）；' +
        '要导入别的学期，请在教务页面里切到那个学期再点「提取课表」'
    );
    if (nameFallback) {
        warn('教务没有给出可识别的学期名，已按「' + name0 + '」导入，请在学期管理里核对');
    }

    if (startInfo.source === '教务') {
        warn('开学日期取自' + startInfo.rule + '：' + startInfo.iso + '，请在学期管理里核对成学校实际开学日');
    } else {
        warn(
            '教务没有给出这个学期的起止日期，第 1 周按「' + startInfo.rule + '」推算为 ' + startInfo.iso +
            '，请在学期管理里核对成学校实际开学日'
        );
    }

    var weeksSource = calendarWeeks > 0
        ? ('教务给出的学期起止日期（' + calendarWeeks + ' 周）')
        : ('适配器内置的 ' + FALLBACK_TOTAL_WEEKS + ' 周（教务没有给出学期起止日期）');
    if (raisedBySchedule) {
        warn(
            '学期总周数按' + weeksSource + '算，但课表里有第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks +
            ' 周导入（否则那几周的课放不下），如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '学期总周数按' + weeksSource + (clampedWeeks ? '，超过导入上限 30 周，已截到 30 周' : '') +
            '，如与实际不符可在学期管理里改'
        );
    }

    if (useTianmuhu) {
        warn(
            '作息时间用的是天目湖校区作息表（课表里有 ' + tianmuhuCount + ' 条安排的教室含「天目湖」），' +
            '如与学校实际作息不符请在学期管理里改'
        );
    } else {
        warn(
            '作息时间用的是明故宫/将军路校区作息表（课表里没有教室含「天目湖」的安排），' +
            '如与学校实际作息不符请在学期管理里改'
        );
    }
    if (useTianmuhu && otherCount > 0) {
        warn(
            '课表里同时有天目湖校区（' + tianmuhuCount + ' 条安排）和其他校区或教室为空（' + otherCount +
            ' 条安排）的课，一学期只能用一张作息表，已统一按天目湖作息表导入；其他校区课程的节次时间可能不准，请核对'
        );
    }

    if (unitCountUnread) {
        warn('课表页没写每天有几节课，已按 ' + DEFAULT_UNIT_COUNT + ' 节换算课程所在的节次，请核对；如果课表整体错位，请反馈');
    }
    if (bareIndexes > 0) {
        warn('有 ' + bareIndexes + ' 条上课安排的时间写法与其他不同，已换算成星期与节次，请核对');
    }
    if (strayIndexes > 0) {
        warn('有 ' + strayIndexes + ' 条上课安排的时间超出了课表能容纳的范围（星期或节次对不上），已跳过，请反馈');
    }
    if (blocksWithoutIndex > 0) {
        warn('有 ' + blocksWithoutIndex + ' 条上课安排没有写明上课时间，已跳过，请反馈');
    }
    if (zeroBitHits > 0) {
        warn('有 ' + zeroBitHits + ' 条上课安排的周次里多出一个第 0 周，这一项不是真实周次，已忽略，请在导入预览里核对这些课的周次');
    }
    if (outOfRangeWeeks > 0) {
        warn('有 ' + outOfRangeWeeks + ' 个周次超过第 ' + MAX_WEEK + ' 周（超出导入上限），已丢弃，请核对');
    }
    if (emptyBitmaps > 0) {
        warn('有 ' + emptyBitmaps + ' 条上课安排没有标明上课周次，已跳过');
    }
    warnNames('有 ' + noonNames.length + ' 门课排在午间（第 5、6 个时段），本校作息里没有对应节次，未导入：', noonNames);
    if (exprNameHits > 0) {
        warn('有 ' + exprNameHits + ' 条上课安排的课程名是教务用拼接方式生成的，导入的只是其中的文字，请核对课程名');
    }
    if (noNameHits > 0) {
        warn('有 ' + noNameHits + ' 条上课安排取不到课程名，已跳过，请反馈');
    }
    var plainNoTeacher = noTeacherHits - exprTeacherHits;  // 拼接形态已单独提醒，这里只计真正没有教师的
    if (exprTeacherHits > 0) {
        warn('有 ' + exprTeacherHits + ' 条上课安排的任课老师是拼接出来的，无法读出名字，老师一栏已留空');
    }
    if (plainNoTeacher > 0) {
        warn('有 ' + plainNoTeacher + ' 条上课安排没有查到任课老师，老师一栏已留空');
    }

    var warnings = allWarnings;
    if (allWarnings.length > MAX_WARNINGS) {
        warnings = allWarnings.slice(0, MAX_WARNINGS - 1);
        warnings.push(
            '另有 ' + (allWarnings.length - MAX_WARNINGS + 1) + ' 条说明因为超出上限没有显示，请把这份课表反馈给我们'
        );
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [
            {
                name: name0,
                firstDay: startInfo.iso,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
