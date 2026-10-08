(function () {
    // 上海电力大学教务适配器（树维 EAMS 平台）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 SHIEP/SHIEP.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游 maintainer zt11125）
    //   上游快照 ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    //   上游文件头写明：本脚本改自本仓库中天津农学院（TJAU）的适配脚本（作者：星河欲转）
    //
    // 上游这一段的核心逻辑（原样移植的骨架）：
    //   ① powerSplit：按顶层逗号切 TaskActivity 的参数（括号深度 + 引号状态感知）
    //   ② 按 activity = new TaskActivity 分块：教师取第 2 个参数，课名取第 4 个、教室取第 6 个、
    //      周次位图取第 7 个（上游 args[1] / args[3] / args[5] / args[6]）
    //   ③ index = 星期 * unitCount + 节次（两个数都从 0 起算，所以各 +1）
    //   ④ mergeContinuousLessons：把「课名|教师|地点|星期」相同、节次连续的活动并成一个课程块
    //
    // 移植改动（逐条对照移植手册 §4 与批次四检查表，依据见 AUDIT.md）：
    //   ① ES6 → ES5：去掉模板串、箭头函数、块级声明关键字、扩展运算符、Array.from / Set / endsWith
    //   ② 周次位图下标即周次（本批统一口径）：bitmap[i] 为 "1" 且 i >= 1 → 第 i 周。
    //      下标 0 是占位符：为 "1" 时不产出第 0 周，写 warnings
    //   ③ 课程名：沿用上游 stripCourseNo 的规则，只摘末尾一组「半角括号 + 课程号」（整数或小数）。
    //      不摘全角括号，也不限位数（上游注释明确要保留「大学英语C读写（1）」）
    //   ④ 教师只认字面量。上游直接取 args[1]；若它是 teachers.join(",") 这类表达式，
    //      上游会把表达式文本当教师名。本件判为读不到：教师留 null，写 warnings（手册 §4.7）
    //   ⑤ 教室保留括号内容（上游也不删）；拿不到就留 null，不写「未知地点」
    //   ⑥ unitCount：课表响应里读；读不到用课表页的 unitCountPage；都读不到用上游缺省 13。
    //      后两种都写 warnings（批次四检查表 4）
    //   ⑦ 两种定位写法都认：index = 3*unitCount+2; 与已算好的 index = 62;（后者用 unitCount 换算，
    //      换算不了就计数 + warn，不猜）。全程不用 eval
    //   ⑧ 作息表：上游 SHIEP.js 内置的 13 节，逐节原样搬过来（第 1 节 08:20-09:05）。
    //      课表用到第 14 节及以后时，课保留、节次保留，但写 warnings 说明没有时间，不补时间
    //   ⑨ 学期名用教务给的「学年 + 第几学期」；拿不到就用「上海电力大学 + 学年」，不用适配器名
    //   ⑩ 开学日：取选中学期起始日期所在周的周一；拿不到就按学期锚点推算，并写 warnings
    //   ⑪ 上游的 showToast / saveImportedCourses / savePresetTimeSlots 等桥调用全部没有移植；
    //      本文件不碰页面、不发请求（CI 用 Rhino 实跑的那一段）

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var html = typeof data.courseTable === 'string' ? data.courseTable : '';
    var sem = data.semester && typeof data.semester === 'object' ? data.semester : null;
    // extract.js 交出来的课表页 unitCount（课表响应里没有时的第二来源）
    var pageUnit = typeof data.unitCountPage === 'number' && data.unitCountPage >= 1 && data.unitCountPage <= 60
        ? data.unitCountPage : null;

    var SEP = String.fromCharCode(0);        // 复合键分隔符：用 fromCharCode 取，源码里不出现控制字符
    var BACKSLASH = String.fromCharCode(92); // 判引号转义用，源码里不出现转义序列

    var MAX_WEEK = 30;              // 载荷校验：totalWeeks ∈ 1..30，startWeek/endWeek ∈ 1..totalWeeks
    var MAX_PERIOD = 20;            // 单日节次上限：超过它一定是脏数据
    var DEFAULT_UNIT_COUNT = 13;    // 上游 SHIEP.js 的缺省值（两处来源都读不到时用，同时进 warnings）
    var FALLBACK_TOTAL_WEEKS = 20;  // 教务不给学期起止日期时的总周数
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;

    // 上海电力大学作息：**上游 SHIEP/SHIEP.js 内置的那张 13 节表**，逐条原样搬过来（第 1 节 08:20-09:05）。
    // 上游没有向教务请求作息，这张表就是上游作者写死的值 —— 带进载荷的同时必须写进 warnings 说明没跟教务核对过。
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:20', end: '09:05' },
        { periodIndex: 2, start: '09:10', end: '09:55' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:00', end: '11:45' },
        { periodIndex: 5, start: '11:50', end: '12:30' },
        { periodIndex: 6, start: '13:20', end: '14:05' },
        { periodIndex: 7, start: '14:10', end: '14:55' },
        { periodIndex: 8, start: '15:10', end: '15:55' },
        { periodIndex: 9, start: '16:00', end: '16:45' },
        { periodIndex: 10, start: '16:50', end: '17:30' },
        { periodIndex: 11, start: '18:15', end: '19:00' },
        { periodIndex: 12, start: '19:05', end: '19:50' },
        { periodIndex: 13, start: '19:55', end: '20:35' }
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

    // "08:20" / "08:20:00" → "08:20"；认不出来（含 24:00 这种越界）返回 null
    function timeOf(value) {
        var m = /^([01]?\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.exec(text(value));
        if (!m) return null;
        return (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2];
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
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

    // ---------- 计数器（每一个被兜住的情况都要计数，最后汇总成 warnings，不许静默丢） ----------
    var exprTeacherHits = 0;     // 教师字段是表达式、没取到教师名的活动数
    var exprNameHits = 0;        // 课名字段是表达式（只取其中的字符串字面量）的活动数
    var serialSuffixHits = 0;    // 课程名末尾摘掉了课程号的课数
    var zeroBitHits = 0;         // 周次位图第 0 位为 1 的活动数
    var outOfRangeWeeks = 0;     // 位图里超过第 30 周的周次个数
    var emptyBitmaps = 0;        // 位图缺失、或一个 1 都没有的活动数
    var bareIndexes = 0;         // 已算好的 index = 62; 形态（已用 unitCount 换算）的次数
    var bareWithoutUnit = 0;     // 上面那种，但 unitCount 也没有 → 无法换算，只能计数 + warn
    var strayIndexes = 0;        // 换算出的星期或节次超出 1..7 / 1..MAX_PERIOD 的定位数
    var blocksWithoutIndex = 0;  // TaskActivity 块里没有任何可用定位的块数
    var shortBlocks = 0;         // TaskActivity 参数不是 7 个（或括号结构认不出）的块数
    var namelessBlocks = 0;      // 课名为空的块数
    var unitCountSource = 'response';  // 'response' 课表响应里读到；'page' 课表页上读到；'default' 上游缺省
    var unitCountUsed = DEFAULT_UNIT_COUNT;

    // ---------- TaskActivity 参数切分（上游 powerSplit 的 ES5 写法） ----------
    // 按顶层逗号切：括号深度为 0 且不在引号里时才算分隔符。返回的是修整过空白的原始段，
    // 清洗（去引号、null）放到使用点。这样才分得清「"张三"」（字面量）与 teachers.join(",")（表达式）；
    // 上游两者都当成教师名直接用，这是本件与上游的一处差别（见 AUDIT.md §3）
    function cleanArg(s) {
        var value = text(s);
        if (value === 'null' || value === 'undefined') return null;
        return text(value.replace(/^["']|["']$/g, ''));
    }

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

    // 整段是一个引号字面量才算字面量；"a" + b 这类拼接一律按表达式处理
    function isLiteralArg(raw) {
        return /^"[^"]*"$|^'[^']*'$/.test(text(raw));
    }

    function isNullArg(raw) {
        var s = text(raw);
        return s === '' || s === 'null' || s === 'undefined';
    }

    // 教师：只认字面量；表达式（teachers.join(",") 之类）与空值都留空，表达式另计数
    function teacherOfArg(raw) {
        if (isNullArg(raw)) return '';
        var s = text(raw);
        if (isLiteralArg(s)) return cleanArg(s);
        exprTeacherHits++;
        return '';
    }

    // 课名：字面量直接用；表达式只取其中的字符串字面量（courseName + "（实验）" → 「（实验）」）
    function nameOfArg(raw) {
        if (isNullArg(raw)) return '';
        var s = text(raw);
        if (isLiteralArg(s)) return cleanArg(s);
        var literals = s.match(/"[^"]*"|'[^']*'/g) || [];
        var joined = '';
        var i;
        for (i = 0; i < literals.length; i++) joined += cleanArg(literals[i]);
        exprNameHits++;
        return joined;
    }

    // ---------- 课程名：上游 stripCourseNo 的规则 ----------
    // 只摘末尾一组「半角括号 + 数字（整数或小数）」，即课程号：「大学物理(2)」→「大学物理」，
    // 「高等数学A(1)(2800001.32)」→「高等数学A(1)」（上游只摘一组，保留的 (1) 见 AUDIT.md §4 与待定项）。
    // 全角括号、课程名自带的括号（体育1(篮球)）原样保留
    function courseNameOf(raw) {
        var name = text(raw);
        var stripped = text(name.replace(/\s*\(\s*\d+(?:\.\d+)?\s*\)\s*$/, ''));
        if (stripped && stripped !== name) {
            serialSuffixHits++;
            return stripped;
        }
        return name;
    }

    // ---------- 位图周次 ----------
    // 位图下标 i 就是第 i 周，**下标 0 是占位符**：为 "1" 时不产出第 0 周（那会让载荷校验拒掉整包），写 warnings
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
    // unitCount：课表响应 → 课表页 → 上游缺省 13（后两种都进 warnings）。
    // 「已算好的 index = 62;」形态只认前两种来源换算，缺省值不用来换算（那会是猜）
    function readUnitCount(source) {
        var m = /(^|[^A-Za-z0-9_])unitCount\s*=\s*(\d{1,3})/.exec(source);
        if (!m) return null;
        var n = parseInt(m[2], 10);
        return n >= 1 && n <= 60 ? n : null;
    }

    function pushLesson(lessons, name, teacher, location, day, period, weeks) {
        if (day < 1 || day > 7 || period < 1 || period > MAX_PERIOD) {
            strayIndexes++;
            return;
        }
        lessons.push({
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            period: period,
            weeks: weeks
        });
    }

    function parseTaskActivities(source) {
        var lessons = [];
        var known = readUnitCount(source);
        var trusted = known || pageUnit;
        if (known) {
            unitCountSource = 'response';
            unitCountUsed = known;
        } else if (pageUnit) {
            unitCountSource = 'page';
            unitCountUsed = pageUnit;
        } else {
            unitCountSource = 'default';
            unitCountUsed = DEFAULT_UNIT_COUNT;
        }
        // 上游按 activity = new TaskActivity 切块（替代 TJAU 的 var teachers = 切块）
        var blocks = source.split(/activity\s*=\s*new\s+TaskActivity/);
        var i;
        for (i = 1; i < blocks.length; i++) {
            var block = blocks[i];
            var argsMatch = /^\s*\(([\s\S]*?)\)\s*;/.exec(block);
            if (!argsMatch) {
                shortBlocks++;
                continue;
            }
            var args = powerSplit(argsMatch[1]);
            if (args.length < 7) {
                shortBlocks++;
                continue;
            }
            // 上游：args[1] 教师 / args[3] 课名 / args[5] 教室 / args[6] 周次位图
            var teacherName = teacherOfArg(args[1]);
            var courseName = courseNameOf(nameOfArg(args[3]));
            if (!courseName) {
                namelessBlocks++;
                continue;
            }
            var locationValue = cleanArg(args[5]);
            var location = locationValue ? locationValue : '';
            var weeks = weeksOfBitmap(cleanArg(args[6]));

            // 定位一：index = 星期 * unitCount + 节次;（上游的写法，两个数都从 0 起算，各 +1）
            var located = 0;
            var idxRegex = /index\s*=\s*(\d+)\s*\*\s*unitCount\s*\+\s*(\d+)\s*;/g;
            var m;
            while ((m = idxRegex.exec(block)) !== null) {
                located++;
                pushLesson(lessons, courseName, teacherName, location,
                    parseInt(m[1], 10) + 1, parseInt(m[2], 10) + 1, weeks);
            }

            // 定位二：index = 62;（已算好的线性下标：星期 * unitCount + 节次，用 trusted 换算）
            var rest = block.replace(/index\s*=\s*\d+\s*\*\s*unitCount\s*\+\s*\d+\s*;/g, '');
            var bareRegex = /index\s*=\s*(\d+)\s*;/g;
            while ((m = bareRegex.exec(rest)) !== null) {
                located++;
                if (!trusted) {
                    bareWithoutUnit++;
                    continue;
                }
                var linear = parseInt(m[1], 10);
                bareIndexes++;
                pushLesson(lessons, courseName, teacherName, location,
                    Math.floor(linear / trusted) + 1, (linear % trusted) + 1, weeks);
            }

            if (!located) blocksWithoutIndex++;
        }
        return lessons;
    }

    // ---------- 上游的 mergeContinuousLessons（原样移植成确定性的写法） ----------
    // 上游用 Set / Array.from / 对象键序 / localeCompare，这里换成显式数组与码位比较，
    // 保证 Rhino 与 V8 给出同一份结果。语义不变：
    //   每周 → 该周上这门课的节次集合 → 同一周里连续的节次并成一段（1-2 节 + 3-4 节 → 1-4 节）→
    //   同一段节次把这些周合起来（1-8 周 + 9-16 周 → 1-16 周）
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
            // 第 N 周 → 这一周上这门课的节次集合（等价于上游的 Set，但顺序确定）
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

    // 周次集合 → 极大段（手册 §4.1）：步长 1 是每周、步长 2 是单/双周；只有两周以上的步长 2 段才记成 ODD / EVEN
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

    // ---------- 课程与 block ----------
    var merged = mergeContinuousLessons(parseTaskActivities(html));

    // 课程顺序按「课名 + 教师」排序（不依赖对象键序）；块的顺序在下面按固定元组排
    var courseOrder = [];
    var byCourse = {};
    var i2;
    for (i2 = 0; i2 < merged.length; i2++) {
        var item = merged[i2];
        var courseKey = item.name + SEP + item.teacher;
        if (!byCourse[courseKey]) {
            byCourse[courseKey] = { name: item.name, teacher: item.teacher, note: null, blocks: [], seen: {} };
            courseOrder.push(courseKey);
        }
    }
    courseOrder.sort();

    var maxWeek = 0;
    var maxPeriod = 0;
    for (i2 = 0; i2 < merged.length; i2++) {
        var entry = merged[i2];
        var course = byCourse[entry.name + SEP + entry.teacher];
        var runList = runsOf(entry.weeks);
        var r;
        for (r = 0; r < runList.length; r++) {
            var run = runList[r];
            if (run.end > maxWeek) maxWeek = run.end;
            if (entry.endSection > maxPeriod) maxPeriod = entry.endSection;
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
    for (i2 = 0; i2 < courseOrder.length; i2++) {
        var built = byCourse[courseOrder[i2]];
        built.blocks.sort(function (a, b) {
            return cmpNum(a.dayOfWeek, b.dayOfWeek) || cmpNum(a.startPeriod, b.startPeriod) ||
                cmpNum(a.endPeriod, b.endPeriod) || cmpNum(a.startWeek, b.startWeek) ||
                cmpNum(a.endWeek, b.endWeek) || cmpStr(a.weekType, b.weekType) ||
                cmpStr(a.location || '', b.location || '');
        });
        courses.push({
            name: built.name,
            teacher: built.teacher ? built.teacher : null,
            note: built.note,
            blocks: built.blocks
        });
    }

    if (!courses.length) {
        throw new Error(
            '没有从教务返回的课表里解析出课程（响应 ' + html.length + ' 个字符）：' +
            '可能这个学期还没排课，也可能登录状态已失效。请重新登录、在教务页面里确认能看到课表后再点「提取课表」'
        );
    }

    // ---------- 学期名 ----------
    var KIND_CN = { '1': '一', '2': '二', '3': '三', '4': '四' };

    // 学期名用教务自己的「学年 + 第几学期」（手册 §4.7：别拿适配器名当学期名）
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

    // 学期序号（第几学期）：标签是 1 / 2，或带「第一学期」「第二学期」字样才认得出，认不出返回空串
    function termKindOf() {
        var label = sem ? text(sem.rawName) : '';
        if (hasOwn(KIND_CN, label)) return KIND_CN[label];
        if (label.indexOf('第二学期') >= 0) return KIND_CN['2'];
        if (label.indexOf('第一学期') >= 0) return KIND_CN['1'];
        return '';
    }

    // 教务没给学期名时的代替：「上海电力大学 + 学年 + 第一/第二学期」，学期序号认不出就写「（学期未知）」（会写 warnings）
    // 学年取教务学年文本，没有就按今天推
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
        if (!year) return '上海电力大学' + (kind ? ' 第' + kind + '学期（学年未知）' : '（学年学期未知）');
        return '上海电力大学 ' + year + '学年' + (kind ? '第' + kind + '学期' : '（学期未知）');
    }

    var calendarName = termNameOf();
    var nameFallback = !calendarName;
    var name0 = calendarName || fallbackNameOf();

    // ---------- 开学日 / 总周数 ----------
    // 开学日：选中学期的起始日期所在周的周一（手册 §4.3）；拿不到就按学期锚点推算（warnings 必写）
    var calendarStart = sem ? isoOfAny(sem.startDate) : null;
    var calendarEnd = sem ? isoOfAny(sem.endDate) : null;
    var startYear = sem && /^[0-9]{4}/.test(text(sem.schoolYear))
        ? parseInt(text(sem.schoolYear).substring(0, 4), 10) : 0;
    var semLabel = sem ? text(sem.rawName) : '';
    var isSecond = semLabel === '2' || semLabel.indexOf('第二学期') >= 0;
    var startInfo;
    if (calendarStart) {
        startInfo = {
            iso: mondayOfIso(calendarStart),
            rule: '教务给的学期起始日期（' + calendarStart + '）所在周的周一',
            source: '教务'
        };
    } else {
        var todayStart = isoOfAny(data.today);
        var academicYear = startYear || (todayStart ? parseInt(todayStart.substring(0, 4), 10) : new Date().getUTCFullYear());
        startInfo = {
            iso: isoOf(mondayOnOrBefore(academicYear + (isSecond ? 1 : 0), isSecond ? 2 : 9, isSecond ? 20 : 1)),
            rule: (isSecond ? '第二学期 2 月 20 日' : '第一学期 9 月 1 日') + '所在周的周一（' + academicYear + ' 学年）',
            source: '推算'
        };
    }

    // 总周数：教务给了学期起止日期就用它的周数，否则用缺省 20；课表里更晚的周次必须放得下（否则整包被拒），抬高时单独说明
    var calendarWeeks = 0;
    var clampedWeeks = false;
    if (calendarStart && calendarEnd) {
        var from = epochOfIso(mondayOfIso(calendarStart));
        var to = epochOfIso(calendarEnd);
        if (from !== null && to !== null && to >= from) {
            calendarWeeks = Math.ceil((Math.floor((to - from) / 86400000) + 1) / 7);
        }
        if (calendarWeeks > MAX_WEEK) {
            calendarWeeks = MAX_WEEK;
            clampedWeeks = true;
        }
        if (calendarWeeks < 1) calendarWeeks = 0;
    }
    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raisedBySchedule = true;
    }

    // ---------- 作息时间（上游内置的 13 节；课表用到更晚的节次时不补时间） ----------
    var periodTimes = [];
    var badSlots = 0;
    var i3;
    for (i3 = 0; i3 < SCHOOL_PERIOD_TIMES.length; i3++) {
        var slot = SCHOOL_PERIOD_TIMES[i3];
        var slotStart = timeOf(slot.start);
        var slotEnd = timeOf(slot.end);
        if (!slotStart || !slotEnd || minutesOf(slotStart) >= minutesOf(slotEnd)) {
            badSlots++;
            continue;
        }
        periodTimes.push({ periodIndex: slot.periodIndex, start: slotStart, end: slotEnd });
    }
    var tableLength = periodTimes.length;

    // ---------- warnings ----------
    var allWarnings = [];

    function warn(message) {
        var line = String(message);
        if (line.length > MAX_WARNING_CHARS) line = line.substring(0, MAX_WARNING_CHARS - 1) + '…';
        allWarnings.push(line);
    }

    // 给学生看的日期写成「2026 年 8 月 31 日」，不写 yyyy-MM-dd
    function cnDateOf(iso) {
        var p = iso.split('-');
        return p[0] + ' 年 ' + parseInt(p[1], 10) + ' 月 ' + parseInt(p[2], 10) + ' 日';
    }

    var BASES = {
        current: '教务系统标出的当前学期',
        date: '起止日期包含今天的那个学期',
        latest: '起始日期最晚的那个学期',
        last: '学期列表里的最后一项',
        page: '课表页上标出的学期'
    };

    warn(
        '只导入了教务系统的一个学期（' + name0 + '，按' + (BASES[sem && sem.source] || '教务给出的学期') +
        '自动选中）。要导入别的学期，请在教务页面里切到那个学期，再点「提取课表」。'
    );
    if (nameFallback) {
        warn('教务没有给出学期名，已用「' + name0 + '」代替，请在学期管理里改成实际学期名' + (termKindOf() ? '' : '；也看不出是第几学期，请核对是哪个学期') + '。');
    }

    if (startInfo.source === '教务') {
        warn('第 1 周从 ' + cnDateOf(startInfo.iso) + '开始，依据是教务给出的学期开始日期，请在学期管理里核对成学校实际开学日。');
    } else {
        warn('教务没有给出这个学期的开始日期，已推算第 1 周从 ' + cnDateOf(startInfo.iso) + '开始，请在学期管理里核对成学校实际开学日。');
    }

    var weeksText = calendarWeeks < 1
        ? '教务没有给出学期起止日期，总周数暂按 ' + FALLBACK_TOTAL_WEEKS + ' 周计算'
        : clampedWeeks
            ? '教务给出的学期起止日期超过 ' + MAX_WEEK + ' 周，总周数按 ' + MAX_WEEK + ' 周计算'
            : '教务给出的学期起止日期算出总周数为 ' + calendarWeeks + ' 周';
    if (raisedBySchedule) {
        warn(
            weeksText + '，但课表里有第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks +
            ' 周导入（否则那几周的课放不下），如与实际不符请在学期管理里改。'
        );
    } else {
        warn(weeksText + '，如与实际不符请在学期管理里改。');
    }

    warn(
        '教务系统没有提供节次时间，已使用上海电力大学默认的节次时间（共 ' + tableLength + ' 节，第 1 节 ' +
        SCHOOL_PERIOD_TIMES[0].start + '~' + SCHOOL_PERIOD_TIMES[0].end + '），如与学校实际不符请在学期管理里改。'
    );

    if (unitCountSource === 'page') {
        warn('课表里没写每天有几节课，已按课表页上的 ' + unitCountUsed + ' 节换算课程所在的节次，请核对。');
    } else if (unitCountSource === 'default') {
        warn('课表里和课表页上都没写每天有几节课，已按默认的 ' + DEFAULT_UNIT_COUNT + ' 节换算课程所在的节次。如果课表整体错位，请反馈。');
    }
    if (bareWithoutUnit > 0) {
        warn(
            '有 ' + bareWithoutUnit + ' 处课程的上课时间在教务里只写了一个数字，课表里又没写每天有几节课，无法换算成星期和节次，' +
            '这些课没有导进来，请反馈。'
        );
    } else if (bareIndexes > 0) {
        warn('有 ' + bareIndexes + ' 处课程的上课时间在教务里只写了一个数字，已按每天的节次数换算成星期与节次，请核对。');
    }
    if (strayIndexes > 0) {
        warn('有 ' + strayIndexes + ' 处课程的上课时间换算后超出正常范围（星期 1~7、节次 1~' + MAX_PERIOD + '），这些课没有导进来，请反馈。');
    }
    if (blocksWithoutIndex > 0) {
        warn('有 ' + blocksWithoutIndex + ' 个上课安排读不出上课时间，这些课没有导进来，请反馈。');
    }
    if (shortBlocks > 0) {
        warn('有 ' + shortBlocks + ' 个上课安排的内容和预期不一样（教务系统可能改版了），这些课没有导进来，请反馈。');
    }
    if (namelessBlocks > 0) {
        warn('有 ' + namelessBlocks + ' 个上课安排读不出课程名，这些课没有导进来，请反馈。');
    }
    if (zeroBitHits > 0) {
        warn('有 ' + zeroBitHits + ' 个上课安排的周次数据有一处不正常，已忽略那一处，请在导入预览里核对这些课的周次。');
    }
    if (outOfRangeWeeks > 0) {
        warn('有 ' + outOfRangeWeeks + ' 个周次超出 1~' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）。');
    }
    if (emptyBitmaps > 0) {
        warn('有 ' + emptyBitmaps + ' 个上课安排没有任何可用的周次，这些课没有导进来，请反馈。');
    }
    if (serialSuffixHits > 0) {
        warn('有 ' + serialSuffixHits + ' 个课程名末尾带有英文括号的数字（如「大学物理(2)」），已去掉这部分；中文括号的内容（如「大学英语C读写（1）」）原样保留，请核对。');
    }
    if (exprNameHits > 0) {
        warn('有 ' + exprNameHits + ' 个课程名是教务页面上拼接出来的，已只取其中的文字部分，请核对。');
    }
    if (exprTeacherHits > 0) {
        warn('有 ' + exprTeacherHits + ' 个上课安排的任课教师读不出来，已留空，请核对。');
    }
    if (maxPeriod > tableLength) {
        var beyond = tableLength + 1 === maxPeriod
            ? '第 ' + maxPeriod + ' 节' : '第 ' + (tableLength + 1) + '~' + maxPeriod + ' 节';
        warn('课表用到第 ' + maxPeriod + ' 节，而节次时间只到第 ' + tableLength + ' 节：' + beyond + '的课保留了节次，但没有开始和结束时间，请在学期管理里补上节次时间。');
    }
    if (badSlots > 0) {
        warn('节次时间里有 ' + badSlots + ' 节的时间不合法，已丢弃这些节次，请反馈。');
    }

    var warnings = allWarnings;
    if (allWarnings.length > MAX_WARNINGS) {
        warnings = allWarnings.slice(0, MAX_WARNINGS - 1);
        warnings.push('另有 ' + (allWarnings.length - MAX_WARNINGS + 1) + ' 条说明因为超出上限没有显示，请把这份课表反馈给我们');
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

