(function () {
    // 西安建筑科技大学（树维 for-std 平台）—— 取数结果转空课课表载荷。
    // 移植自 shiguang_warehouse 的 XAUAT/xauat.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Alph4rc、ZionPu）
    //   上游快照：f83288e，本校脚本最后一次修改 893854b（2026-11-20，PR #941）；1.0.1 跟进其中的周次 / 节次修复
    //
    // 本校教务按「具体日期」给排课：scheduleList 每条 = 一门课在某一天、某个时段、某个教室。
    // 所以这里先按开学日把日期换算成「第几周 + 星期几」，跨学期的日期丢弃并计数。
    //   · 每周起始日：学期接口给 weekStartOnSunday 时以周日为第一天，否则周一；开学日先回退到当周起始日；
    //   · 开学日：学期起止接口的 startDate；没有就用最早一条排课日期推算（上游做法，假设最早一节课在第 1 周），推算了一定写进提醒；
    //   · 周次：采用教务给的 weekIndex；与日期算出的周次对不上的计数进提醒（以教务为准）；
    //   · 节次：有作息表（timetable-layout）就用教务的节次（跳过不合法的行并计数提醒）；课时段的起止节按
    //     开始 / 结束时间落进的那节取，落不进取最接近的一节（差 ≤60 分钟），首尾不对齐节次边界的计数提醒；
    //     没有作息表就按课表里实际出现的开始时间排节次（推导出来的一定要说）；
    //   · 同一周同一时间有多间教室：并排写出并提醒（上游同样合并）；教师缺失时回落到课程名单里的教师名；
    //   · 总周数：校历优先；没有校历用 20；课表排得更晚才抬高；上下限 16~25 周，动了就提醒；
    //   · 读不了的排课、跨学期的日期、没排上课时间的课、缺教师、缺教室，一律计数进提醒，不静默丢。

    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var term = data.term || {};
    var meta = data.semesterMeta || {};
    var semesters = data.semesters || [];
    var lessonList = data.lessonList || [];
    var scheduleList = data.scheduleList || [];
    var courseUnitList = data.courseUnitList || [];

    var SCHOOL_NAME = '西安建筑科技大学';
    var MAX_WEEKS = 25;
    var MIN_WEEKS = 16;
    var DEFAULT_TOTAL_WEEKS = 20;
    var NEAREST_MINUTES = 60;
    var SEP = String.fromCharCode(0);
    // 每周第一天：1 = 周一，7 = 周日（学期接口 weekStartOnSunday 为真时用周日）
    var weekStartDow = meta.weekStartOnSunday === true ? 7 : 1;
    var DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    var warnings = [];
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_NAME_TEXT = 20;

    function clipText(value, max) {
        var one = String(value);
        if (one.length <= max) return one;
        var head = one.substring(0, max - 1);
        var last = head.charCodeAt(head.length - 1);
        if (last >= 0xD800 && last <= 0xDBFF) head = head.substring(0, head.length - 1);
        return head + '…';
    }

    function clipName(name) {
        return clipText(name, MAX_NAME_TEXT);
    }

    function pushWarning(message) {
        if (warnings.length >= MAX_WARNINGS) return;
        var warning = clipText(message, MAX_WARNING_TEXT);
        if (warnings.indexOf(warning) >= 0) return;
        warnings.push(warning);
    }

    // ---------- 小工具 ----------
    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // "2026-09-07" / "2026/9/7" / "2026-09-07 00:00:00" 都认；只取日期部分，不经过 Date，避免时区挪一天
    function isoOf(value) {
        var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(text(value));
        if (!m) return null;
        return m[1] + '-' + pad2(intOf(m[2])) + '-' + pad2(intOf(m[3]));
    }

    // 日期 → 距 1970-01-01 的天数（纯整数运算）；日期不合法（2025-02-31）返回 null
    function dayOf(value) {
        var iso = isoOf(value);
        if (!iso) return null;
        var y = intOf(iso.slice(0, 4));
        var mo = intOf(iso.slice(5, 7));
        var d = intOf(iso.slice(8, 10));
        var millis = Date.UTC(y, mo - 1, d);
        var check = new Date(millis);
        if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
        return Math.round(millis / 86400000);
    }

    function isoOfDay(day) {
        var date = new Date(day * 86400000);
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    // 1=周一 … 7=周日
    function weekdayOfDay(day) {
        return ((new Date(day * 86400000).getUTCDay() + 6) % 7) + 1;
    }

    // 该日所在周的第一天（周一，或学期说以周日开头时的周日）；移植手册 §4.3
    function weekStartOf(day) {
        return day - ((weekdayOfDay(day) - weekStartDow + 7) % 7);
    }

    function todayDay() {
        var pinned = dayOf(data.today);
        if (pinned !== null) return pinned;
        var now = new Date();
        return dayOf(now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()));
    }

    // "08:00" / "8:00" / "0800" / 800 / 1800 → "HH:mm"；认不出返回 null
    function fmtTime(value) {
        var raw = text(value);
        if (!raw) return null;
        var withColon = /^(\d{1,2}):(\d{2})/.exec(raw);
        var digits;
        if (withColon) {
            digits = pad2(intOf(withColon[1])) + withColon[2];
        } else {
            digits = raw.replace(/[^0-9]/g, '');
            if (digits.length === 3) digits = '0' + digits;
            if (digits.length === 6) digits = digits.slice(0, 4);
            if (digits.length !== 4) return null;
        }
        var hour = intOf(digits.slice(0, 2));
        var minute = intOf(digits.slice(2, 4));
        if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null;
        return pad2(hour) + ':' + pad2(minute);
    }

    function minutesOf(hhmm) {
        return intOf(hhmm.slice(0, 2)) * 60 + intOf(hhmm.slice(3, 5));
    }

    // 两个日期之间含两端共几周（用第 1 周的周一作起点）
    function weeksBetween(startDay, endDay) {
        if (startDay === null || endDay === null || endDay < startDay) return null;
        return Math.ceil((endDay - startDay + 1) / 7);
    }

    // 周次集合 → 极大段。步长 1 = 每周，步长 2 = 单/双周，落单的周单算（weekType=ALL）。
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j] };
            if (run.start === run.end || step === 1) {
                run.weekType = 'ALL';
            } else {
                run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            }
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // 拿不到学期名时才用：由第 1 周的日期推出学年学期
    function inferTermName(day) {
        var iso = isoOfDay(day);
        var year = intOf(iso.slice(0, 4));
        var month = intOf(iso.slice(5, 7));
        if (month >= 8) return year + '-' + (year + 1) + '学年第一学期';
        if (month >= 2) return (year - 1) + '-' + year + '学年第二学期';
        return (year - 1) + '-' + year + '学年第一学期';
    }

    // 教师、教室写成占位词时一律当作空
    function placeholder(value) {
        var s = text(value);
        if (!s) return true;
        return /^(未知|暂无|待定|无)(教师|老师|教室|地点)?$/.test(s);
    }

    // 教师名字后面的括号备注（外聘、主讲之类）不是名字的一部分；单条记录只有一个教师
    function cleanPerson(value) {
        var s = text(value);
        var tail = /[（(][^（）()]*[）)]\s*$/;
        while (tail.test(s)) s = text(s.replace(tail, ''));
        if (placeholder(s)) return null;
        return s;
    }

    function cleanPlace(value) {
        var s = text(value);
        if (placeholder(s)) return null;
        return s;
    }

    function namesPhrase(names) {
        var shown = names.length < 3 ? names.length : 3;
        var parts = [];
        for (var i = 0; i < shown; i++) parts.push('「' + clipName(names[i]) + '」');
        var body = parts.join('、');
        if (names.length > shown) body += '，另有 ' + (names.length - shown) + ' 门';
        return body;
    }

    function addName(list, name) {
        if (list.indexOf(name) === -1) list.push(name);
    }

    // ---------- 开学日 ----------
    var startDay = dayOf(meta.startDate);
    var endDay = dayOf(meta.endDate);
    var firstDay = null;
    var firstSource = 'meta';
    var startAligned = false;
    if (startDay !== null) {
        firstDay = weekStartOf(startDay);
        startAligned = firstDay !== startDay;
    }
    if (firstDay === null) {
        // 上游 deriveSemesterStartDate：取最早一条排课日期、回退到所在周周一，只在「最早一节课在第 1 周」时成立
        var earliest = null;
        for (var e = 0; e < scheduleList.length; e++) {
            var eDay = dayOf((scheduleList[e] || {}).date);
            if (eDay === null) continue;
            if (earliest === null || eDay < earliest) earliest = eDay;
        }
        if (earliest !== null) {
            firstDay = weekStartOf(earliest);
            firstSource = 'schedule';
        } else {
            firstDay = weekStartOf(todayDay());
            firstSource = 'today';
        }
    }

    // ---------- 学期名 ----------
    var termName = text(term.label);
    var nameEstimated = false;
    if (!termName) {
        termName = SCHOOL_NAME + ' ' + inferTermName(firstDay);
        nameEstimated = true;
    }
    function termShown() {
        return nameEstimated ? termName : clipName(termName);
    }

    // ---------- 课程名单 ----------
    if (!lessonList.length) {
        throw new Error('教务没有返回本学期的课程名单。请确认已登录，并打开课表页面后再提取。');
    }
    if (!scheduleList.length) {
        throw new Error('教务没有返回任何排课记录。这个学期可能还没排课，请到课表页面核对后再提取。');
    }
    var lessonById = {};
    var lessonOrder = [];
    var lessonTeachers = {};
    for (var li = 0; li < lessonList.length; li++) {
        var lesson = lessonList[li] || {};
        var lessonName = text(lesson.courseName);
        if (!lessonName) continue;
        var lessonKey0 = String(lesson.id);
        if (lessonById[lessonKey0]) continue;
        lessonById[lessonKey0] = lessonName;
        lessonOrder.push(lessonKey0);
        // 课程名单里的教师名：排课上没写教师时回落用（占位词、括号备注同样处理）
        var listedNames = lesson.teacherNames || [];
        var cleanListed = [];
        for (var ln = 0; ln < listedNames.length; ln++) {
            var listedName = cleanPerson(listedNames[ln]);
            if (listedName) addName(cleanListed, listedName);
        }
        lessonTeachers[lessonKey0] = cleanListed;
    }
    if (!lessonOrder.length) {
        throw new Error('教务返回的课程名单里没有课程名，读不出课程。请到课表页面核对后再提取。');
    }

    // ---------- 排课明细：日期换算周次、去重、过滤 ----------
    var skip = { lesson: 0, date: 0, time: 0 };
    var beforeStart = 0;
    var tooLate = 0;
    var weekDiff = 0;
    var scheduledLessons = {};
    var seenRow = {};
    var rows = [];
    for (var si = 0; si < scheduleList.length; si++) {
        var s = scheduleList[si] || {};
        var courseKey = String(s.lessonId);
        // 同一条记录重复出现时只算一条，去重要在计数之前，否则提醒里的条数会被放大
        var rawKey = [courseKey, String(s.date), String(s.startTime), String(s.endTime),
            String(s.personName), String(s.room)].join(SEP);
        if (seenRow[rawKey] === true) continue;
        seenRow[rawKey] = true;
        var courseName = lessonById[courseKey];
        if (!courseName) {
            skip.lesson++;
            continue;
        }
        scheduledLessons[courseKey] = true;
        var dateDay = dayOf(s.date);
        if (dateDay === null) {
            skip.date++;
            continue;
        }
        var startHM = fmtTime(s.startTime);
        var endHM = fmtTime(s.endTime);
        if (!startHM || !endHM || minutesOf(startHM) >= minutesOf(endHM)) {
            skip.time++;
            continue;
        }
        var week = Math.floor((dateDay - firstDay) / 7) + 1;
        if (week < 1) {
            beforeStart++;
            continue;
        }
        if (week > MAX_WEEKS) {
            tooLate++;
            continue;
        }
        // 周次以教务给的 weekIndex 为准；与日期算出的周次对不上的计数进提醒（跨学期判断仍看日期）
        var wIdx = intOf(s.weekIndex);
        if (wIdx !== null && wIdx >= 1 && wIdx !== week) {
            weekDiff++;
            week = wIdx;
            if (week > MAX_WEEKS) {
                tooLate++;
                continue;
            }
        }
        var teacher = cleanPerson(s.personName);
        var place = cleanPlace(s.room) || cleanPlace(s.customPlace);
        rows.push({
            lessonKey: courseKey,
            name: courseName,
            day: weekdayOfDay(dateDay),
            week: week,
            startHM: startHM,
            endHM: endHM,
            teacher: teacher,
            place: place
        });
    }

    if (!rows.length) {
        var reasons = [];
        if (skip.lesson) reasons.push(skip.lesson + ' 条对不上课程名单');
        if (skip.date) reasons.push(skip.date + ' 条日期读不出');
        if (skip.time) reasons.push(skip.time + ' 条上课时间读不出');
        if (beforeStart) reasons.push(beforeStart + ' 条日期在开学日之前');
        if (tooLate) reasons.push(tooLate + ' 条日期超出学期末');
        throw new Error('教务返回了 ' + scheduleList.length + ' 条排课记录，但没有一条能导入' +
            (reasons.length ? '（' + reasons.join('、') + '）' : '') +
            '。请到课表页面核对后再提取。');
    }

    // ---------- 节次时间 ----------
    // 教务作息表（courseUnitList）：逐行检查，跳过不合法的行（节次号 < 1、时间读不出、开始不早于结束，
    // 如 0 号的休息行），用剩下的合法节次。合法节次号必须从 1 连续，否则整张不用；合法节次为空则回落。
    var layoutTable = [];
    var layoutSkipped = [];
    for (var lu = 0; lu < courseUnitList.length; lu++) {
        var lUnit = courseUnitList[lu] || {};
        var lIdx = intOf(lUnit.indexNo);
        var lStart = fmtTime(lUnit.startTime);
        var lEnd = fmtTime(lUnit.endTime);
        if (!(lIdx >= 1) || !lStart || !lEnd || minutesOf(lStart) >= minutesOf(lEnd)) {
            if (lIdx >= 1) layoutSkipped.push(lIdx);
            continue;
        }
        layoutTable.push({ periodIndex: lIdx, start: lStart, end: lEnd });
    }
    var layoutOk = layoutTable.length > 0;
    if (layoutOk) {
        layoutTable.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        for (var lk = 0; lk < layoutTable.length; lk++) {
            if (layoutTable[lk].periodIndex !== lk + 1) {
                layoutOk = false;
                break;
            }
        }
    }
    var layoutInvalid = courseUnitList.length > 0 && !layoutOk;

    // 没有可用作息表时：同一个开始时间算一节，下课时间取这一天里最晚的一个，有出入的计数进提醒
    var periodTimes = [];
    var periodOfStart = {};
    var endConflict = 0;
    if (layoutOk) {
        periodTimes = layoutTable;
    } else {
        var endOfStart = {};
        var startList = [];
        var conflictStarts = {};
        for (var pi = 0; pi < rows.length; pi++) {
            var st = rows[pi].startHM;
            var en = rows[pi].endHM;
            if (!endOfStart[st]) {
                endOfStart[st] = en;
                startList.push(st);
                continue;
            }
            if (endOfStart[st] !== en) {
                conflictStarts[st] = true;
                if (minutesOf(en) > minutesOf(endOfStart[st])) endOfStart[st] = en;
            }
        }
        for (var ck in conflictStarts) {
            if (conflictStarts.hasOwnProperty(ck)) endConflict++;
        }
        startList.sort();
        for (var pj = 0; pj < startList.length; pj++) {
            periodOfStart[startList[pj]] = pj + 1;
            periodTimes.push({ periodIndex: pj + 1, start: startList[pj], end: endOfStart[startList[pj]] });
        }
    }

    // 课时段 → 起止节次。起始节 = 开始时间落在其 [start, end] 内的那节，落不进就取开始时间最接近的一节；
    // 结束节同理按结束时间取。两端都要找到（差 ≤ NEAREST_MINUTES）且起 ≤ 止，否则返回 null，由调用方跳过并点名。
    // approx = 首尾没有正好对齐节次边界（要提醒）。没有作息表时只是把开始时间换成推导出的节次。
    function nodeOf(hm, useEnd) {
        var t = minutesOf(hm);
        for (var i = 0; i < periodTimes.length; i++) {
            var a = minutesOf(periodTimes[i].start);
            var b = minutesOf(periodTimes[i].end);
            if (t >= a && t <= b) return periodTimes[i];
        }
        var best = null;
        var bestGap = Infinity;
        for (var j = 0; j < periodTimes.length; j++) {
            var edge = minutesOf(useEnd ? periodTimes[j].end : periodTimes[j].start);
            var gap = Math.abs(edge - t);
            if (gap < bestGap) {
                bestGap = gap;
                best = periodTimes[j];
            }
        }
        return best && bestGap <= NEAREST_MINUTES ? best : null;
    }

    function sectionsOf(startHM, endHM) {
        if (!layoutOk) {
            var derived = periodOfStart[startHM];
            return { start: derived, end: derived, approx: false };
        }
        var startNode = nodeOf(startHM, false);
        var endNode = nodeOf(endHM, true);
        if (!startNode || !endNode || startNode.periodIndex > endNode.periodIndex) return null;
        var aligned = startNode.start === startHM && endNode.end === endHM;
        return { start: startNode.periodIndex, end: endNode.periodIndex, approx: !aligned };
    }

    // ---------- 排课明细 → 一格（同一课、同一天、同一时间、同一周）----------
    // 同一格多间教室并排写出（教务没标明你在哪间，上游也是这样合并的）；格里没有教师就回落到课程名单的教师。
    var cells = {};
    var cellOrder = [];
    for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri];
        var cellKey = [row.lessonKey, row.day, row.startHM, row.endHM, row.week].join(SEP);
        if (!cells[cellKey]) {
            cells[cellKey] = {
                lessonKey: row.lessonKey,
                name: row.name,
                day: row.day,
                startHM: row.startHM,
                endHM: row.endHM,
                week: row.week,
                rooms: [],
                teachers: []
            };
            cellOrder.push(cellKey);
        }
        var cell = cells[cellKey];
        if (row.place) addName(cell.rooms, row.place);
        if (row.teacher) addName(cell.teachers, row.teacher);
    }

    // ---------- 格 → 节次段 → 分组（同一节次段、同一教室组合的周次并集）----------
    var groups = {};
    var groupOrder = [];
    var parallelNames = [];
    var sectionDropped = { count: 0, names: [] };
    var approxNames = [];
    for (var ci2 = 0; ci2 < cellOrder.length; ci2++) {
        var cl = cells[cellOrder[ci2]];
        var sections = sectionsOf(cl.startHM, cl.endHM);
        if (!sections) {
            sectionDropped.count++;
            if (sectionDropped.names.length < 3) addName(sectionDropped.names, cl.name);
            continue;
        }
        if (sections.approx) addName(approxNames, cl.name);
        if (cl.rooms.length > 1) addName(parallelNames, cl.name);
        var cellPlace = cl.rooms.length ? cl.rooms.join('/') : null;
        var cellTeachers = cl.teachers.length ? cl.teachers : (lessonTeachers[cl.lessonKey] || []);
        var groupKey = [cl.lessonKey, cl.day, cl.startHM, cl.endHM, cellPlace || ''].join(SEP);
        if (!groups[groupKey]) {
            groups[groupKey] = {
                lessonKey: cl.lessonKey,
                name: cl.name,
                day: cl.day,
                startPeriod: sections.start,
                endPeriod: sections.end,
                place: cellPlace,
                teachers: [],
                weeks: []
            };
            groupOrder.push(groupKey);
        }
        var grp = groups[groupKey];
        for (var cti = 0; cti < cellTeachers.length; cti++) addName(grp.teachers, cellTeachers[cti]);
        if (grp.weeks.indexOf(cl.week) === -1) grp.weeks.push(cl.week);
    }

    var courseMap = {};
    var courseOrder = [];
    var maxWeek = 0;
    for (var gi = 0; gi < groupOrder.length; gi++) {
        var g = groups[groupOrder[gi]];
        if (!courseMap[g.lessonKey]) {
            courseMap[g.lessonKey] = { name: g.name, teachers: [], slots: {}, slotOrder: [] };
            courseOrder.push(g.lessonKey);
        }
        var course = courseMap[g.lessonKey];
        for (var ti = 0; ti < g.teachers.length; ti++) addName(course.teachers, g.teachers[ti]);
        var slotKey = [g.day, g.startPeriod, g.endPeriod, g.place || ''].join(SEP);
        if (!course.slots[slotKey]) {
            course.slots[slotKey] = {
                day: g.day,
                startPeriod: g.startPeriod,
                endPeriod: g.endPeriod,
                place: g.place,
                weeks: []
            };
            course.slotOrder.push(slotKey);
        }
        var slotWeeks = course.slots[slotKey].weeks;
        for (var wi = 0; wi < g.weeks.length; wi++) {
            if (slotWeeks.indexOf(g.weeks[wi]) === -1) slotWeeks.push(g.weeks[wi]);
        }
    }

    // ---------- 课程 → block ----------
    var courses = [];
    var missingTeachers = [];
    var missingRooms = [];
    for (var ci = 0; ci < courseOrder.length; ci++) {
        var cObj = courseMap[courseOrder[ci]];
        var blocks = [];
        var roomMissing = false;
        for (var sk = 0; sk < cObj.slotOrder.length; sk++) {
            var slot = cObj.slots[cObj.slotOrder[sk]];
            if (!slot.place) roomMissing = true;
            slot.weeks.sort(function (a, b) { return a - b; });
            var runs = runsOf(slot.weeks);
            for (var rr = 0; rr < runs.length; rr++) {
                var run = runs[rr];
                if (run.end > maxWeek) maxWeek = run.end;
                blocks.push({
                    dayOfWeek: slot.day,
                    startPeriod: slot.startPeriod,
                    endPeriod: slot.endPeriod,
                    startWeek: run.start,
                    endWeek: run.end,
                    weekType: run.weekType,
                    location: slot.place
                });
            }
        }
        if (!blocks.length) continue;
        blocks.sort(function (a, b) {
            if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
            if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
            return a.startWeek - b.startWeek;
        });
        if (!cObj.teachers.length) addName(missingTeachers, cObj.name);
        if (roomMissing) addName(missingRooms, cObj.name);
        courses.push({
            name: cObj.name,
            teacher: cObj.teachers.length ? cObj.teachers.join('、') : null,
            note: null,
            blocks: blocks
        });
    }
    if (!courses.length) {
        if (sectionDropped.count) {
            throw new Error('教务返回的排课时间都对不上节次时间，没有读出课程。请到课表页面核对后再提取。');
        }
        throw new Error('教务返回的排课记录里都没有可导入的周次，没有读出课程。请到课表页面核对后再提取。');
    }

    // 名单里有、课表里没有排课的课：不导入，点名提醒
    var unscheduled = [];
    for (var ui = 0; ui < lessonOrder.length; ui++) {
        if (scheduledLessons[lessonOrder[ui]] !== true) unscheduled.push(lessonById[lessonOrder[ui]]);
    }

    // ---------- 总周数 ----------
    var calendarWeeks = 0;
    if (firstSource === 'meta' && endDay !== null) {
        var counted = weeksBetween(firstDay, endDay);
        if (counted !== null && counted >= 1) calendarWeeks = counted;
    }
    var totalWeeks = calendarWeeks >= 1 ? calendarWeeks : DEFAULT_TOTAL_WEEKS;
    var hasCalendar = calendarWeeks >= 1;
    var raised = maxWeek > totalWeeks;
    if (raised) totalWeeks = maxWeek;
    var clampedLow = 0;
    if (totalWeeks < MIN_WEEKS) {
        clampedLow = totalWeeks;
        totalWeeks = MIN_WEEKS;
    }
    var clampedHigh = 0;
    if (totalWeeks > MAX_WEEKS) {
        clampedHigh = totalWeeks;
        totalWeeks = MAX_WEEKS;
    }

    // ---------- 提醒（顺序：学期 → 开学日 → 丢弃的 → 节次 → 周数 → 教师教室 → 学期名）----------
    if (term.pickedBy === 'first') {
        pushWarning('教务页面没有标出当前学期，已导入学期列表里的第一个「' + termShown() +
            '」。如果不对，请在教务页面切到要导入的学期后再提取。');
    }
    var otherTerms = 0;
    for (var sj = 0; sj < semesters.length; sj++) {
        if (String(semesters[sj].id) !== String(term.id)) otherTerms++;
    }
    if (otherTerms > 0) {
        pushWarning('本次只导入了「' + termShown() + '」。学期列表里还有 ' + otherTerms +
            ' 个学期，要导入别的学期请在教务页面切过去再点「提取课表」。');
    }
    if (startAligned) {
        pushWarning('教务给的开学日期（' + isoOfDay(startDay) + '）不是' + DAY_NAMES[weekStartDow] + '，已对齐到当周' +
            DAY_NAMES[weekStartDow] + ' ' + isoOfDay(firstDay) + ' 作为第 1 周的起点，请在学期管理里核对。');
    }
    if (firstSource === 'schedule') {
        pushWarning('教务没有给出开学日期，已按最早的排课日期推算第 1 周从 ' + isoOfDay(firstDay) +
            '（' + DAY_NAMES[weekStartDow] + '）开始，请在学期管理里核对成学校实际开学日。');
    } else if (firstSource === 'today') {
        pushWarning('教务没有给出开学日期，也没有排课日期可以推算，已按本周' + DAY_NAMES[weekStartDow] + ' ' +
            isoOfDay(firstDay) + ' 作为第 1 周，请在学期管理里改成学校实际开学日。');
    }
    var skippedTotal = skip.lesson + skip.date + skip.time;
    if (skippedTotal > 0) {
        var reasons = [];
        if (skip.lesson) reasons.push('找不到对应课程 ' + skip.lesson + ' 条');
        if (skip.date) reasons.push('日期不对 ' + skip.date + ' 条');
        if (skip.time) reasons.push('上课时间不对 ' + skip.time + ' 条');
        pushWarning('教务返回的排课记录里有 ' + skippedTotal + ' 条读不了，已跳过（' + reasons.join('、') +
            '）。如发现少了课，请到课表页面核对。');
    }
    if (beforeStart > 0) {
        pushWarning('有 ' + beforeStart + ' 条排课日期在开学日期之前（可能是别的学期），已跳过。如发现少了课，请到课表页面核对。');
    }
    if (tooLate > 0) {
        pushWarning('有 ' + tooLate + ' 条排课落在第 ' + MAX_WEEKS + ' 周之后（可能是别的学期），已跳过。如发现少了课，请到课表页面核对。');
    }
    if (weekDiff > 0) {
        pushWarning('有 ' + weekDiff + ' 条排课的日期算出的周次和教务给的周次对不上，已按教务给的周次导入，请到课表页面核对。');
    }
    if (sectionDropped.count > 0) {
        pushWarning('有 ' + sectionDropped.count + ' 个上课时段离所有节次都超过 ' + NEAREST_MINUTES +
            ' 分钟，已跳过（涉及' + namesPhrase(sectionDropped.names) + '），请到课表页面核对。');
    }
    if (approxNames.length > 0) {
        pushWarning('有 ' + approxNames.length + ' 门课的上课时间与节次时间对不上，已按最接近的节次放入（例如「' +
            clipName(approxNames[0]) + '」），请在课表页面核对。');
    }
    if (layoutOk && layoutSkipped.length > 0) {
        pushWarning('作息表里有 ' + layoutSkipped.length + ' 节的上下课时间读不出（第 ' + layoutSkipped.join('、') +
            ' 节），已跳过，其余节次照常使用，请在学期管理里核对上下课时间。');
    }
    if (parallelNames.length) {
        pushWarning('有 ' + parallelNames.length + ' 门课同一周同一时间排了多间教室，教务没标明你在哪间，已把教室并排写出（例如' +
            namesPhrase(parallelNames) + '），请在这门课的「编辑课程」里按实际情况修改。');
    }
    if (unscheduled.length) {
        pushWarning('另有 ' + unscheduled.length + ' 门课教务没有排上课时间（例如' + namesPhrase(unscheduled) +
            '），这些课没有导入。');
    }
    if (!layoutOk) {
        if (layoutInvalid) {
            pushWarning('教务给的节次时间格式不对，已按课表里每节课实际出现的开始时间排出 ' + periodTimes.length +
                ' 节（最早 ' + periodTimes[0].start + ' 开始），请在学期管理里核对上下课时间。');
        } else {
            pushWarning('教务系统没有给出节次时间，已按课表里每节课实际出现的开始时间排出 ' + periodTimes.length +
                ' 节（最早 ' + periodTimes[0].start + ' 开始），请在学期管理里核对上下课时间。');
        }
    }
    if (endConflict > 0) {
        pushWarning('有 ' + endConflict + ' 个开始时间的下课时间在课表里前后不一致，课表按最晚的下课时间显示，请到课表页面核对。');
    }
    if (raised && hasCalendar) {
        pushWarning('教务系统给出的学期起止日期只能数出 ' + calendarWeeks + ' 周，但课表排到第 ' + maxWeek +
            ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对。');
    } else if (raised) {
        pushWarning('教务系统没有给出可用的学期校历，原本按 20 周导入，但课表排到第 ' + maxWeek +
            ' 周，学期总周数已改为 ' + totalWeeks + ' 周，请在学期管理里核对。');
    } else if (!hasCalendar) {
        pushWarning('教务系统没有给出可用的学期校历，学期总周数按 20 周导入（课表最晚排到第 ' + maxWeek +
            ' 周）。如与学校安排不符，请在学期管理里改。');
    }
    if (clampedLow) {
        pushWarning('按教务数据算出的学期总周数只有 ' + clampedLow + ' 周，不足本应用最少的 ' + MIN_WEEKS +
            ' 周，已按 ' + MIN_WEEKS + ' 周导入，请在学期管理里核对。');
    }
    if (clampedHigh) {
        pushWarning('按教务数据算出的学期总周数是 ' + clampedHigh + ' 周，超过本应用支持的 ' + MAX_WEEKS +
            ' 周，已按 ' + MAX_WEEKS + ' 周导入。');
    }
    if (missingTeachers.length) {
        pushWarning('有 ' + missingTeachers.length + ' 门课没有教师（例如' + namesPhrase(missingTeachers) +
            '），可在这门课的「编辑课程」里补上。');
    }
    if (missingRooms.length) {
        pushWarning('有 ' + missingRooms.length + ' 门课没有教室（例如' + namesPhrase(missingRooms) +
            '），可在这门课的「编辑课程」里补上。');
    }
    if (nameEstimated) {
        pushWarning('教务系统没有给出学期名称，已写成「' + termName + '」，可以在学期管理里改成你想要的名字。');
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [
            {
                name: termName,
                firstDay: isoOfDay(firstDay),
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
