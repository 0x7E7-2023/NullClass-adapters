(function () {
    // 天津城建大学 教务适配器（URP 综合教务系统）—— 第二步：原始数据 → 空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 TCU/tcu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 星河欲转）
    //   上游快照 e15c627（2026-10-26）；本校脚本最后一次修改 80e30cf
    //
    // 输入是 extract.js 交来的 JSON 字符串（__ncInput）：
    //   { fetchedDate, term: { text, isDefault } | null, rq: "YYYYMMDD" | null, skzc: "数字串" | null,
    //     slots: [ { jc, kssj, jssj } ] | null,
    //     courses: [ { courseName, attendClassTeacher, timeAndPlaceList: [ {…} ] } ] }
    //
    // 移植改动（相对上游脚本，逐条对应 AUDIT.md）：
    //   ① 周次：classWeek 位串（下标 i 为第 i+1 周），与上游一致；位串缺失或全 0 的安排计数写进提醒，不静默丢。
    //   ② 同课合并：上游每条安排各成一门课；这里先去完全重复的行，再把节次首尾相接的合成一条、同节次的周次取并集（沿用同族 aufe 的两阶段）。
    //   ③ 教师：上游把「* 」直接删掉，多位教师的名字会连成一串；这里按「*」分开，用「、」连接。缺了就是空，汇总提醒。
    //   ④ 地点：照上游「教学楼 + 教室」直接拼（上游不带校区名）；全空为空，汇总提醒。
    //   ⑤ 连续节数：上游缺失时得到无效节次；这里按 1 节导入（只确定知道起始节），计数提醒。
    //   ⑥ 学期：上游弹窗问学年和学期；这里取课表页下拉框选中的学期（没有下拉框就是教务默认的当前学期）。
    //      教务的开学日（rq）与总周数（skzc）只对应教务默认的学期，选了别的学期时不用，推算并提醒。
    //   ⑦ 开学日：上游不设开学日；这里取 rq 对齐到当周周一，提醒核对；取不到就按提取当天所在周的周一推算并提醒。
    //   ⑧ 总周数：上游写死 20 周；这里取校历的 skzc，取不到按课表最大周次推定（没有课表周次才用 20），并提醒。
    //   ⑨ 节次时间：读教务给的 jcsjbs（jc / kssj / jssj）；上游没有写死的表，取不到就按应用默认的节次时间显示并提醒。
    //   ⑩ 节次超出教务的节次时间时逐节补齐（统一修订 H3）：空课默认的节次时间同一节不早于上一节下课就用它，否则顺推；补了哪些都提醒。
    //
    // 本文件是纯函数：同样的 __ncInput 永远得到同样的输出（CI 用 Rhino 跑它对 fixture）。
    var input = JSON.parse(__ncInput);
    if (!input || typeof input !== 'object') input = {};

    var SCHOOL_NAME = '天津城建大学';   // 学期名兜底时用（「学校名 + 学年学期」）
    var MAX_TERM_WEEKS = 30;      // 规范：totalWeeks 必须落在 1..30
    var DEFAULT_TOTAL_WEEKS = 20; // 上游写死 semesterTotalWeeks = 20；这里只在连课表周次也没有时才用
    var MAX_PERIOD = 20;          // 单日节次上限：超过它一定是脏数据
    var GUESSED_LENGTH = 1;       // 连续节数缺失时按几节导入
    var NAME_LIST_LIMIT = 3;      // 提醒里最多点名几门课
    var NAME_TEXT_LIMIT = 20;     // 提醒里每个课名最多显示的字数（超出截断并以「…」结尾）
    var MAX_WARNINGS = 20;        // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;   // 载荷校验：单条提醒 ≤200 字
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;

    // 空课默认的节次时间（与 haut / lnu 同一份），只用于课表节次超出教务的节次时间时逐节补齐
    var BUILTIN_PERIODS = [
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

    // ---------- warnings（载荷上限 20 条 × 200 字，超了整包会被拒，所以由这里统一收口） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function warn(message) {
        var line = textOf(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
    }

    function parseIsoDate(value) {
        var match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(textOf(value));
        if (!match) return null;
        var date = new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10));
        if (isNaN(date.getTime())) return null;
        return date;
    }

    // 校历的 YYYYMMDD：不合法（比如 20261340）就是 null
    function parseCompactDate(value) {
        var s = textOf(value);
        if (!/^\d{8}$/.test(s)) return null;
        var year = parseInt(s.substring(0, 4), 10);
        var month = parseInt(s.substring(4, 6), 10);
        var day = parseInt(s.substring(6, 8), 10);
        var date = new Date(year, month - 1, day);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
        return date;
    }

    // 第 1 周从「开学日所在周的周一」起算（空课的 firstDay 就是这么用的）
    function mondayOf(date) {
        var offset = (date.getDay() + 6) % 7;   // 周一=0 … 周日=6
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 教务没有学年学期时：按提取日期落在哪一学期命名（2–7 月算第二学期；8 月–次年 1 月算第一学期，1 月属于上一学年）。
    // 是推算值，写进提醒。
    function inferTermName(date) {
        var year = date.getFullYear();
        var month = date.getMonth() + 1;
        if (month >= 2 && month <= 7) return (year - 1) + '-' + year + '学年第二学期';
        if (month === 1) return (year - 1) + '-' + year + '学年第一学期';
        return year + '-' + (year + 1) + '学年第一学期';
    }

    // 学期下拉框的文字常带「(当前)」之类的标记，不属于学期名
    function termLabel(value) {
        var s = textOf(value).replace(/[（(]\s*当前[^）)]*[）)]/g, '').replace(/当前/g, '');
        return textOf(s);
    }

    // classWeek 位串：下标 i 为第 i+1 周；不是纯 0/1 就当读不出来
    function weeksOf(bits) {
        var s = textOf(bits);
        if (!/^[01]+$/.test(s)) return [];
        var weeks = [];
        for (var i = 0; i < s.length; i++) {
            if (s.charAt(i) === '1') weeks.push(i + 1);
        }
        return weeks;
    }

    // 周次集合 → 极大段：相邻差 1 视作每周，相邻差 2 视作单 / 双周
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j], weekType: 'ALL' };
            if (run.start !== run.end && step === 2) {
                run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            }
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // 教师：「张三* 李四*」这类写法按「*」拆开，用「、」连接；空着就是空串
    function cleanTeacher(value) {
        var parts = textOf(value).split('*');
        var names = [];
        for (var i = 0; i < parts.length; i++) {
            var one = textOf(parts[i]);
            if (one) names.push(one);
        }
        return names.join('、');
    }

    // 上游的「教学楼 + 教室」直接拼；全空为空串
    function buildPosition(place) {
        return textOf(textOf(place.teachingBuildingName) + textOf(place.classroomName));
    }

    // "0810" → "08:10"；"080000" → "08:00"；已经是 "8:10" / "08:10" 就补齐成两位小时
    function formatClock(value) {
        var s = textOf(value);
        if (!s) return '';
        if (/^\d{4}$/.test(s) || /^\d{6}$/.test(s)) s = s.substring(0, 2) + ':' + s.substring(2, 4);
        var match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
        return match ? pad2(parseInt(match[1], 10)) + ':' + match[2] : '';
    }

    function minutesOf(clock) {
        var match = /^(\d{1,2}):(\d{2})$/.exec(clock);
        if (!match) return -1;
        return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    }

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return pad2(h) + ':' + pad2(m);
    }

    // 教务的节次时间（jcsjbs）：节次号取 jc，开始 kssj、结束 jssj；读不出来或节次号重复的跳过并计数
    function buildSlotPeriods(slots) {
        var times = [];
        var broken = 0;
        var seen = {};
        if (!isArray(slots)) return { times: times, broken: 0 };
        for (var i = 0; i < slots.length; i++) {
            var slot = slots[i] || {};
            var index = intOf(slot.jc);
            var start = formatClock(slot.kssj);
            var end = formatClock(slot.jssj);
            if (!(index >= 1) || !start || !end || minutesOf(start) >= minutesOf(end) || seen['p' + index]) {
                broken++;
                continue;
            }
            seen['p' + index] = true;
            times.push({ periodIndex: index, start: start, end: end });
        }
        times.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        return { times: times, broken: broken };
    }

    // 课名过长时截短，避免一个超长课名就把整条提醒撑破上限
    function shortName(name) {
        var line = textOf(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    function nameList(names) {
        var shown = [];
        for (var i = 0; i < names.length && i < NAME_LIST_LIMIT; i++) shown.push(shortName(names[i]));
        if (names.length > NAME_LIST_LIMIT) return shown.join('、') + ' 等 ' + names.length + ' 门';
        return shown.join('、');
    }

    // 节次号（已升序）写成「第 9-12 节」「第 9 节」「第 9、11-12 节」
    function sectionsText(list) {
        var parts = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            parts.push(j > i ? list[i] + '-' + list[j] : String(list[i]));
            i = j + 1;
        }
        return '第 ' + parts.join('、') + ' 节';
    }

    function keysOf(dict) {
        var out = [];
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) out.push(dict[key]);
        }
        return out;
    }

    var fetched = parseIsoDate(input.fetchedDate);
    if (!fetched) fetched = new Date();   // extract.js 一定会带上提取日期；手写输入时按当天算

    // ---------- 逐门课、逐条安排转换 ----------
    var rawCourses = isArray(input.courses) ? input.courses : [];
    var courses = [];             // 归档后的课（名称 + 教师）
    var byName = {};
    var entries = [];             // 每条安排：课程、教师、地点、星期、起止节次、周次集合
    var noPlaceNames = {};        // 教务没排上课时间地点的课
    var brokenNames = {};         // 有安排，但星期 / 节次 / 周次读不出来、一条都没留下的课
    var brokenPlaces = 0;         // 星期 / 节次 / 周次读不出来而被忽略的安排
    var nameless = 0;             // 没有课程名而被跳过的课
    var guessedNames = {};        // 没写连续节数、按 1 节导入的课
    var guessedPlaces = 0;
    var missingTeacherCourses = {};
    var missingLocationCourses = {};

    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + teacher;
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, blocks: [] };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    for (var k = 0; k < rawCourses.length; k++) {
        var raw = rawCourses[k];
        if (!raw || typeof raw !== 'object') continue;
        var name = textOf(raw.courseName);
        if (!name) { nameless++; continue; }

        var places = isArray(raw.timeAndPlaceList) ? raw.timeAndPlaceList : [];
        if (!places.length) { noPlaceNames['n' + name] = name; continue; }

        var teacher = cleanTeacher(raw.attendClassTeacher);
        var kept = 0;
        for (var p = 0; p < places.length; p++) {
            var place = places[p] || {};
            var weeks = weeksOf(place.classWeek);
            var day = intOf(place.classDay);
            var startPeriod = intOf(place.classSessions);
            if (!weeks.length || !(day >= 1 && day <= 7) || !(startPeriod >= 1)) {
                brokenPlaces++;
                continue;
            }
            var length = intOf(place.continuingSession);
            var guessed = false;
            if (!(length >= 1)) {
                length = GUESSED_LENGTH;
                guessed = true;
            }
            var endPeriod = startPeriod + length - 1;
            if (endPeriod > MAX_PERIOD) {
                brokenPlaces++;
                continue;
            }
            if (guessed) {
                guessedPlaces++;
                guessedNames['n' + name] = name;
            }
            var location = buildPosition(place);
            if (!teacher) missingTeacherCourses['n' + name] = name;
            if (!location) missingLocationCourses['n' + name] = name;
            entries.push({
                course: courseOf(name, teacher),
                name: name,
                teacher: teacher,
                location: location,
                day: day,
                start: startPeriod,
                end: endPeriod,
                weeks: weeks
            });
            kept++;
        }
        if (!kept) brokenNames['n' + name] = name;
    }

    // ---------- 同课合并（对齐上游 mergeAndDistinctCourses 的两阶段语义） ----------
    //   0：完全相同的行只留一条（上游阶段 1 的「完全重复：跳过」，这里提前做，免得合并后才出现的重复漏网）；
    //   阶段 1：课名、教师、地点、星期、周次都一样、且节次首尾相接的合成一条（1-2 节 + 3-4 节 → 1-4 节）；
    //   阶段 2：课名、教师、地点、星期、起止节次都一样的，周次取并集（1-8 周 + 9-16 周 → 1-16 周）。
    // 只合并首尾相接的节次，重叠的节次保持原样：不丢课、不改任何一周的安排。
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

    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next) &&
                current.end + 1 === next.start) {
                current.end = next.end;
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

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

    entries = dropExactDuplicates(entries);
    entries.sort(orderStageOne);
    var merged = mergeStageOne(entries);
    merged.sort(orderStageTwo);
    merged = mergeStageTwo(merged);

    // 合并后的每条按周次拆成 block（步长 2 → 单 / 双周）；同时记下最大周次与最大节次
    var maxWeek = 0;
    var maxPeriod = 0;
    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        var runs = runsOf(item.weeks);
        for (var r = 0; r < runs.length; r++) {
            if (runs[r].end > maxWeek) maxWeek = runs[r].end;
            if (item.end > maxPeriod) maxPeriod = item.end;
            item.course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: runs[r].start,
                endWeek: runs[r].end,
                weekType: runs[r].weekType,
                location: item.location || null
            });
        }
    }

    var withBlocks = [];
    for (var c0 = 0; c0 < courses.length; c0++) {
        if (courses[c0].blocks.length) withBlocks.push(courses[c0]);
    }
    if (!withBlocks.length) {
        if (brokenPlaces) {
            throw new Error('没有解析出任何课程：' + brokenPlaces +
                ' 条安排的星期、节次或周次读不出来，教务系统可能改了数据格式');
        }
        if (countKeys(noPlaceNames)) {
            throw new Error('没有解析出任何课程：' + countKeys(noPlaceNames) +
                ' 门课还没有排上课时间地点，等排课完成后再提取');
        }
        throw new Error('没有解析出任何课程：这个学期里没有查到你的课，' +
            '请确认所选学期有课，且页面停在教务系统的课表页');
    }

    // ---------- 学期：学期名、开学日、总周数 ----------
    var term = input.term && typeof input.term === 'object' ? input.term : null;
    // 没有下拉框 = 服务端默认就是当前学期；有下拉框则要看选中的是不是写了 selected 的那一项
    var termIsCurrent = !term || term.isDefault === true;
    var termText = term ? termLabel(term.text) : '';
    var termInferred = !termText;
    var termName = termText || (SCHOOL_NAME + ' ' + inferTermName(fetched));

    // 教务的开学日（rq）与总周数（skzc）只对应教务默认的学期
    var rqDate = parseCompactDate(input.rq);
    var calendarDate = termIsCurrent ? rqDate : null;
    var rejectedRq = !termIsCurrent && rqDate ? isoOf(rqDate) : null;
    var firstDay = isoOf(mondayOf(calendarDate || fetched));

    var zsRaw = textOf(input.skzc);
    var zs = termIsCurrent ? intOf(zsRaw) : null;
    var calendarWeeks = zs >= 1 && zs <= MAX_TERM_WEEKS ? zs : 0;
    var zsUnusable = termIsCurrent && !!zsRaw && !calendarWeeks;

    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : (maxWeek >= 1 ? maxWeek : DEFAULT_TOTAL_WEEKS);
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    var clamped = false;
    if (totalWeeks > MAX_TERM_WEEKS) { totalWeeks = MAX_TERM_WEEKS; clamped = true; }

    // ---------- 节次时间：教务的；课表用到更晚的节次逐节补（H3） ----------
    var slotInfo = buildSlotPeriods(input.slots);
    var periodTimes = slotInfo.times.slice(0);
    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    var lastIndex = periodTimes.length ? periodTimes[periodTimes.length - 1].periodIndex : 0;
    if (periodTimes.length) {
        for (var q = lastIndex + 1; q <= maxPeriod; q++) {
            var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
            var builtin = BUILTIN_PERIODS[q - 1];
            // 空课默认的节次时间有这一节、且开始不早于上一节下课，才用它（否则会和上一节重叠甚至倒挂）
            if (builtin && minutesOf(builtin.start) >= prevEnd) {
                periodTimes.push({ periodIndex: q, start: builtin.start, end: builtin.end });
                fromBuiltin.push(q);
                continue;
            }
            var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
            var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
            if (nextEnd > 23 * 60 + 59) { uncoveredFrom = q; break; }
            periodTimes.push({ periodIndex: q, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
            bySequence.push(q);
        }
    }

    // ---------- 周次超出总周数：截断 / 丢弃（只在总周数被压到 30 周时发生） ----------
    var payloadCourses = [];
    var droppedBlocks = 0;
    var clippedBlocks = 0;
    var droppedCourses = [];
    for (var ci = 0; ci < withBlocks.length; ci++) {
        var course = withBlocks[ci];
        var keptBlocks = [];
        for (var bi = 0; bi < course.blocks.length; bi++) {
            var block = course.blocks[bi];
            if (block.startWeek > totalWeeks) {
                droppedBlocks++;
                continue;
            }
            if (block.endWeek > totalWeeks) {
                block.endWeek = totalWeeks;
                clippedBlocks++;
            }
            keptBlocks.push(block);
        }
        if (!keptBlocks.length) {
            droppedCourses.push(course.name);
            continue;
        }
        payloadCourses.push({
            name: course.name,
            teacher: course.teacher || null,
            note: null,
            blocks: keptBlocks
        });
    }
    if (!payloadCourses.length) {
        throw new Error('课表里的安排周次都落在第 ' + totalWeeks + ' 周之后，无法放进一张课表');
    }

    // ---------- 提醒（顺序固定：开学日、学期、总周数、节次时间、补的、猜的、丢的、缺的） ----------
    if (rqDate && calendarDate) {
        var rqIso = isoOf(rqDate);
        if (rqIso !== firstDay) {
            warn('教务给的开学日期（' + rqIso + '）不是周一，已对齐到当周周一 ' + firstDay +
                ' 作为第 1 周开始，请在「学期管理」里核对成学校实际开学日');
        } else {
            warn('开学日期取自教务系统的校历：第 1 周从 ' + firstDay + ' 开始，请在「学期管理」里核对成学校实际开学日');
        }
    } else if (rejectedRq) {
        warn('教务校历给出的开学日期（' + rejectedRq + '）只对应当前学期，不属于所选学期，已忽略；第 1 周按提取当天 ' +
            isoOf(fetched) + ' 所在周的周一推算为 ' + firstDay + '，请在「学期管理」里核对成学校实际开学日');
    } else {
        warn('教务系统没有给出开学日期，第 1 周按提取当天 ' + isoOf(fetched) + ' 所在周的周一推算为 ' +
            firstDay + '，请在「学期管理」里核对成学校实际开学日');
    }

    if (termInferred) {
        warn('学期名是推算的：教务没有给出学年学期，已按提取当天 ' + isoOf(fetched) + ' 推为「' +
            termName + '」，如与实际不符可在导入后重命名');
    }
    if (!termIsCurrent && !termInferred) {
        warn('导入的是「' + termName + '」的课表，它不是教务默认显示的学期；' +
            '如果不是你要的学期，请先在教务系统的课表页里选好学期，再点「提取课表」');
    }

    if (clamped) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过了空课支持的最多 ' + MAX_TERM_WEEKS + ' 周，学期总周数按 ' +
            MAX_TERM_WEEKS + ' 周导入，超出的周次见后面的提醒');
    } else if (calendarWeeks > 0 && !raisedBySchedule) {
        warn('学期总周数取自教务系统（' + totalWeeks + ' 周），如与实际不符可在「学期管理」里改');
    } else if (raisedBySchedule && calendarWeeks > 0) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过教务给的 ' + calendarWeeks + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入（否则第 ' + (calendarWeeks + 1) + ' 周起的课放不下），如与实际不符可在「学期管理」里改');
    } else if (!termIsCurrent) {
        warn('学期总周数按课表里出现的最大周次（' + maxWeek + ' 周）推定：教务给的周数只对应当前学期，' +
            '与所选学期对不上，已忽略；校历周数不同的话可在「学期管理」里改');
    } else if (zsUnusable) {
        warn('教务给的学期总周数（' + zsRaw + '）不在 1-' + MAX_TERM_WEEKS + ' 周之内，已忽略；学期总周数按课表里出现的最大周次（' +
            maxWeek + ' 周）推定，校历周数不同的话可在「学期管理」里改');
    } else {
        warn('学期总周数按课表里出现的最大周次（' + maxWeek + ' 周）推定，教务没有给出总周数；' +
            '校历周数不同的话可在「学期管理」里改');
    }

    if (!periodTimes.length) {
        warn('教务系统没有给出可用的节次时间，这份课表将按应用默认的节次时间显示，请在「学期管理」里设置节次时间');
    }
    if (slotInfo.broken) {
        warn('教务返回的节次时间里有 ' + slotInfo.broken + ' 节的时间读不出来或节次重复，已跳过该节；其余照常，请在导入后核对上课时间');
    }
    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
        warn('课表用到了' + sectionsText(filledAll) + '，教务给的节次时间没有覆盖，已补上：' +
            fillTexts.join('，') + '，请在「学期管理」里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }

    if (guessedPlaces) {
        warn('有 ' + guessedPlaces + ' 条安排没有写连续节数，已按 ' + GUESSED_LENGTH +
            ' 节导入（这是推算的），涉及：' + nameList(keysOf(guessedNames)) + '，请核对这些课的节次');
    }
    var noPlaceList = keysOf(noPlaceNames);
    if (noPlaceList.length) {
        warn('教务系统对 ' + noPlaceList.length + ' 门课还没有排上课时间地点（通常是还没排课），' +
            '已跳过：' + nameList(noPlaceList));
    }
    var brokenList = keysOf(brokenNames);
    if (brokenList.length || brokenPlaces || nameless) {
        var pieces = [];
        if (brokenList.length) {
            pieces.push('有 ' + brokenList.length + ' 门课一条安排都没解析出来，已跳过：' + nameList(brokenList));
        }
        if (brokenPlaces) {
            pieces.push('共有 ' + brokenPlaces + ' 条安排的星期、节次或周次读不出来，已忽略');
        }
        if (nameless) {
            pieces.push('另有 ' + nameless + ' 门课没有课程名，已跳过');
        }
        warn(pieces.join('；'));
    }
    if (clippedBlocks || droppedBlocks || droppedCourses.length) {
        var clipDetail = [];
        if (clippedBlocks) clipDetail.push(clippedBlocks + ' 条安排的周次被截断到第 ' + totalWeeks + ' 周');
        if (droppedBlocks) clipDetail.push(droppedBlocks + ' 条安排整条落在第 ' + totalWeeks + ' 周之后，已丢弃');
        if (droppedCourses.length) clipDetail.push('课程：' + nameList(droppedCourses));
        warn('有安排的周次超出了空课支持的最大 ' + MAX_TERM_WEEKS + ' 周：' +
            clipDetail.join('，') + '，请核对教务里的周次写法');
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），按类型汇总计数说出来，不静默
    var missingTeacherList = keysOf(missingTeacherCourses);
    var missingLocationList = keysOf(missingLocationCourses);
    if (missingTeacherList.length || missingLocationList.length) {
        var fieldParts = [];
        var sampleNames = [];
        var sources = [missingTeacherList, missingLocationList];
        for (var si = 0; si < sources.length; si++) {
            for (var sj = 0; sj < sources[si].length && sampleNames.length < NAME_LIST_LIMIT; sj++) {
                if (sampleNames.indexOf(sources[si][sj]) < 0) sampleNames.push(sources[si][sj]);
            }
        }
        var shownSamples = [];
        for (var sk = 0; sk < sampleNames.length; sk++) shownSamples.push(shortName(sampleNames[sk]));
        if (missingTeacherList.length) fieldParts.push(missingTeacherList.length + ' 门课没给上课教师');
        if (missingLocationList.length) fieldParts.push(missingLocationList.length + ' 门课没给上课地点');
        var emptyText = missingTeacherList.length && missingLocationList.length ?
            '教师或地点暂时空着' : (missingTeacherList.length ? '教师暂时空着' : '上课地点暂时空着');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shownSamples.join('、') + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上');
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
                name: termName,
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
