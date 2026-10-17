(function () {
    // 大连理工大学课表解析（树维 for-std 平台）—— extract.js 的原始数据 → 空课课表载荷。
    // 移植自 shiguang_warehouse 的 DLUT/dlut_01.js（MIT，作者 dffzcqs78694）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //   上游快照：1dc0772（2026-10-17），本校脚本最后一次修改：0de4191（2026-09-17）
    //
    // 上游怎么给数据：datum 的 lessonList 是课程，scheduleList 是排课明细（一条 = 一门课在某个星期几、
    // 某个时段、某一周）。这里：
    //   · 排课明细按 (课程, 星期, 开始时间, 结束时间, 教室) 分组收集周次。上游的分组键没有教室这一维，
    //     同一时段两间教室的排课会被合并掉一间；这里多带上教室，两间都保留；
    //   · 排课时间 → 节次：取落在排课时间范围内的节次（首节 = 第一个，末节 = 最后一个，上游的做法）；
    //     对不上的，按移植手册 §4.4 取开始时间最接近的一节（差不超过 60 分钟）放入并提醒；
    //     离所有节都超过 60 分钟的，跳过并点名提醒；
    //   · 同一门课的所有时段合成一门课；同一节次段的周次取并集，再切成极大段（ALL / ODD / EVEN），一段一个 block。
    //
    // 上游写死、这里改成能取就取的几处（取不到才回退，回退必进 warnings）：
    //   · 开学日：学期接口的 startDate，回退到所在周的周一（移植手册 §4.3）；没有就用排课记录里最早的日期推算；
    //   · 作息表：timetable-layout 的 courseUnitList；没有或格式不对，整张改用上游内置的 12 节；
    //   · 总周数：校历起止日期（上游的 ceil 写法）与课表最大周次取大者。
    //
    // 解析不了的排课记录一律计数进 warnings，不静默丢课。拿不到的教师、教室写 null，不写「未知」。

    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var term = data.term || {};
    var meta = data.semesterMeta || {};
    var semesterCount = intOf(data.semesterCount) || 0;
    var lessonList = data.lessonList || [];
    var scheduleList = data.scheduleList || [];
    var courseUnitList = data.courseUnitList || [];

    var SCHOOL_NAME = '大连理工大学';
    // 载荷校验的硬上限：超过 30 周的安排放不进载荷，只能跳过（会进 warnings）
    var MAX_WEEKS = 30;
    // 排课时间与节次对不上时，开始时间相差在这个分钟数以内的，按最接近的一节放入（移植手册 §4.4：差 ≤1 小时）
    var NEAREST_MINUTES = 60;
    var SEP = String.fromCharCode(0);
    var DAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];

    // 上游内置的作息表（dlut_01.js 的 FALLBACK_TIME_SLOTS，12 节，逐节照抄）。
    // 只在教务没有给出可用的节次时间时使用，用了必须说。
    var BUILTIN_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:50', end: '09:35' },
        { periodIndex: 3, start: '10:05', end: '10:50' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '13:30', end: '14:15' },
        { periodIndex: 6, start: '14:20', end: '15:05' },
        { periodIndex: 7, start: '15:35', end: '16:20' },
        { periodIndex: 8, start: '16:25', end: '17:10' },
        { periodIndex: 9, start: '18:00', end: '18:45' },
        { periodIndex: 10, start: '18:50', end: '19:35' },
        { periodIndex: 11, start: '19:40', end: '20:25' },
        { periodIndex: 12, start: '20:30', end: '21:15' }
    ];

    var warnings = [];

    // 给学生看的提醒有长度与条数上限（载荷校验：每条 ≤200 字、总共 ≤20 条）。
    // 超长截断并以「…」结尾；课名单个也截短，免得几门长课名把一条提醒撑爆。
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

    // "2026-09-07" / "2026/9/7" / "2026-09-07 00:00:00" / "2026-09-07T00:00:00" 都认；
    // 只取日期部分，不经过 Date，避免时区把日期挪一天
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

    // 该日所在周的周一（每周起始日 = 周一，移植手册 §4.3）
    function mondayOf(day) {
        return day - (weekdayOfDay(day) - 1);
    }

    function todayDay() {
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

    // 上课学期名：拿不到学期名时才用，由第 1 周的日期推出学年
    function inferTermName(day) {
        var iso = isoOfDay(day);
        var year = intOf(iso.slice(0, 4));
        var month = intOf(iso.slice(5, 7));
        if (month >= 8) return year + '-' + (year + 1) + '学年第一学期';
        if (month >= 2) return (year - 1) + '-' + year + '学年第二学期';
        return (year - 1) + '-' + year + '学年第一学期';
    }

    // ---------- 节次时间 ----------
    // 教务给的作息表必须完整可用：每节 HH:mm 合法、结束晚于开始、节次号从 1 连续。有一处不对就整张弃用。
    var periodTimes = null;
    var periodsSource = 'api';
    if (!courseUnitList.length) {
        periodsSource = 'missing';
    } else {
        var apiTable = [];
        var apiOk = true;
        for (var u = 0; u < courseUnitList.length; u++) {
            var unit = courseUnitList[u] || {};
            var idx = intOf(unit.indexNo);
            var unitStart = fmtTime(unit.startTime);
            var unitEnd = fmtTime(unit.endTime);
            if (!(idx >= 1) || !unitStart || !unitEnd || minutesOf(unitStart) >= minutesOf(unitEnd)) {
                apiOk = false;
                break;
            }
            apiTable.push({ periodIndex: idx, start: unitStart, end: unitEnd });
        }
        if (apiOk) {
            apiTable.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
            for (var k = 0; k < apiTable.length; k++) {
                if (apiTable[k].periodIndex !== k + 1) {
                    apiOk = false;
                    break;
                }
            }
        }
        if (apiOk) {
            periodTimes = apiTable;
        } else {
            periodsSource = 'invalid';
        }
    }
    if (!periodTimes) periodTimes = BUILTIN_PERIOD_TIMES.slice(0);

    var units = [];
    for (var pIdx = 0; pIdx < periodTimes.length; pIdx++) {
        units.push({
            indexNo: periodTimes[pIdx].periodIndex,
            start: minutesOf(periodTimes[pIdx].start),
            end: minutesOf(periodTimes[pIdx].end)
        });
    }

    // 排课时间 → 节次段。先取落在排课时间范围内的节次（首节 = 第一个，末节 = 最后一个）；
    // 一节都对不上，取开始时间最接近的一节（差不超过 NEAREST_MINUTES）；都超过的返回 null。
    function sectionsOf(startMin, endMin) {
        var first = null;
        var last = null;
        for (var i = 0; i < units.length; i++) {
            if (units[i].start >= startMin && units[i].end <= endMin) {
                if (first === null) first = units[i].indexNo;
                last = units[i].indexNo;
            }
        }
        if (first !== null) return { start: first, end: last, approx: false };
        var best = null;
        var bestGap = Infinity;
        for (var j = 0; j < units.length; j++) {
            var gap = Math.abs(units[j].start - startMin);
            if (gap < bestGap) {
                bestGap = gap;
                best = units[j];
            }
        }
        if (best && bestGap <= NEAREST_MINUTES) return { start: best.indexNo, end: best.indexNo, approx: true };
        return null;
    }

    // ---------- 开学日 ----------
    var startDay = dayOf(meta.startDate);
    var endDay = dayOf(meta.endDate);
    var firstDay = null;
    var firstSource = 'meta';
    var startAligned = false;
    if (startDay !== null) {
        firstDay = mondayOf(startDay);
        startAligned = firstDay !== startDay;
    }
    if (firstDay === null) {
        // 回退：排课记录里最早的日期，和它的 weekIndex 一起推算第 1 周
        var earliest = null;
        for (var e = 0; e < scheduleList.length; e++) {
            var se = scheduleList[e] || {};
            var seDay = dayOf(se.date);
            var seWeek = intOf(se.weekIndex);
            if (seDay === null || !(seWeek >= 1)) continue;
            if (earliest === null || seDay < earliest.day) earliest = { day: seDay, week: seWeek };
        }
        if (earliest) {
            firstDay = mondayOf(earliest.day) - (earliest.week - 1) * 7;
            firstSource = 'schedule';
        } else {
            firstDay = mondayOf(todayDay());
            firstSource = 'today';
        }
    }

    // ---------- 学期名 ----------
    var termName = text(term.label) || text(meta.nameZh);
    var nameEstimated = false;
    if (!termName) {
        termName = SCHOOL_NAME + ' ' + inferTermName(firstDay);
        nameEstimated = true;
    }

    // ---------- 课程名单 ----------
    if (!scheduleList.length) {
        throw new Error('教务没有返回任何排课记录：这个学期可能还没排课，或者教务系统换了页面或格式');
    }
    var lessonById = {};
    var lessonOrder = [];
    for (var li = 0; li < lessonList.length; li++) {
        var lesson = lessonList[li] || {};
        var lessonKey = String(lesson.id);
        var lessonName = text(lesson.courseName);
        if (!lessonName) continue;
        var lessonTeachers = [];
        var rawTeachers = lesson.teachers || [];
        for (var lt = 0; lt < rawTeachers.length; lt++) {
            var tName = text(rawTeachers[lt]);
            if (tName && lessonTeachers.indexOf(tName) === -1) lessonTeachers.push(tName);
        }
        lessonById[lessonKey] = { name: lessonName, teachers: lessonTeachers };
        lessonOrder.push(lessonKey);
    }

    // ---------- 排课明细 → 分组 ----------
    var skip = { lesson: 0, day: 0, time: 0, weeks: 0 };
    var scheduledLessons = {};
    var groupOrder = [];
    var groups = {};
    for (var si = 0; si < scheduleList.length; si++) {
        var s = scheduleList[si] || {};
        var sLessonKey = String(s.lessonId);
        scheduledLessons[sLessonKey] = true;
        var lessonInfo = lessonById[sLessonKey];
        if (!lessonInfo) {
            skip.lesson++;
            continue;
        }
        var day = intOf(s.weekday);
        if (!(day >= 1 && day <= 7)) {
            skip.day++;
            continue;
        }
        var startHM = fmtTime(s.startTime);
        var endHM = fmtTime(s.endTime);
        if (!startHM || !endHM || minutesOf(startHM) >= minutesOf(endHM)) {
            skip.time++;
            continue;
        }
        var week = intOf(s.weekIndex);
        if (!(week >= 1)) {
            skip.weeks++;
            continue;
        }
        var place = text(s.roomName) || text(s.customPlace) || null;
        var rowTeacher = text(s.personName) || lessonInfo.teachers.join('、') || null;
        var groupKey = [sLessonKey, day, startHM, endHM, place || ''].join(SEP);
        if (!groups[groupKey]) {
            groups[groupKey] = {
                lessonKey: sLessonKey,
                day: day,
                startHM: startHM,
                endHM: endHM,
                place: place,
                teacher: rowTeacher,
                weeks: []
            };
            groupOrder.push(groupKey);
        }
        groups[groupKey].weeks.push(week);
    }

    // ---------- 分组 → 节次段 → 课程（同一节次段的周次取并集）----------
    var courseMap = {};
    var courseOrder = [];
    var timeDropped = { count: 0, names: [] };
    var approx = { count: 0, first: null };
    for (var g = 0; g < groupOrder.length; g++) {
        var grp = groups[groupOrder[g]];
        var info = lessonById[grp.lessonKey];
        var sections = sectionsOf(minutesOf(grp.startHM), minutesOf(grp.endHM));
        if (!sections) {
            timeDropped.count++;
            if (timeDropped.names.length < 3 && timeDropped.names.indexOf(info.name) === -1) {
                timeDropped.names.push(info.name);
            }
            continue;
        }
        if (sections.approx) {
            approx.count++;
            if (!approx.first) {
                approx.first = {
                    name: info.name,
                    day: grp.day,
                    startHM: grp.startHM,
                    endHM: grp.endHM,
                    section: sections.start
                };
            }
        }
        if (!courseMap[grp.lessonKey]) {
            courseMap[grp.lessonKey] = { name: info.name, teachers: [], slots: {}, slotOrder: [] };
            courseOrder.push(grp.lessonKey);
        }
        var course = courseMap[grp.lessonKey];
        if (grp.teacher && course.teachers.indexOf(grp.teacher) === -1) course.teachers.push(grp.teacher);
        var slotKey = [grp.day, sections.start, sections.end, grp.place || ''].join(SEP);
        if (!course.slots[slotKey]) {
            course.slots[slotKey] = {
                day: grp.day,
                startPeriod: sections.start,
                endPeriod: sections.end,
                location: grp.place,
                weeks: []
            };
            course.slotOrder.push(slotKey);
        }
        var slotWeeks = course.slots[slotKey].weeks;
        for (var wi = 0; wi < grp.weeks.length; wi++) {
            if (slotWeeks.indexOf(grp.weeks[wi]) === -1) slotWeeks.push(grp.weeks[wi]);
        }
    }

    // ---------- 节次段 → 周次段 → 课程 ----------
    var courses = [];
    var maxWeek = 0;
    var outOfRange = 0;
    for (var c = 0; c < courseOrder.length; c++) {
        var cObj = courseMap[courseOrder[c]];
        var blocks = [];
        for (var k2 = 0; k2 < cObj.slotOrder.length; k2++) {
            var slot = cObj.slots[cObj.slotOrder[k2]];
            slot.weeks.sort(function (a, b) { return a - b; });
            var runs = runsOf(slot.weeks);
            for (var r = 0; r < runs.length; r++) {
                var run = runs[r];
                if (run.end > MAX_WEEKS) {
                    outOfRange++;
                    continue;
                }
                if (run.end > maxWeek) maxWeek = run.end;
                blocks.push({
                    dayOfWeek: slot.day,
                    startPeriod: slot.startPeriod,
                    endPeriod: slot.endPeriod,
                    startWeek: run.start,
                    endWeek: run.end,
                    weekType: run.weekType,
                    location: slot.location
                });
            }
        }
        if (!blocks.length) continue;
        blocks.sort(function (a, b) {
            if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
            if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
            if (a.endPeriod !== b.endPeriod) return a.endPeriod - b.endPeriod;
            return a.startWeek - b.startWeek;
        });
        courses.push({
            name: cObj.name,
            teacher: cObj.teachers.length ? cObj.teachers.join('、') : null,
            note: null,
            blocks: blocks
        });
    }
    if (!courses.length) {
        throw new Error('教务返回了 ' + scheduleList.length +
            ' 条排课记录，但都解析不出课程（教务数据格式可能变了），请反馈');
    }

    // 没有任何排课记录的课：不导入，点名提醒
    var unscheduled = [];
    for (var n = 0; n < lessonOrder.length; n++) {
        if (scheduledLessons[lessonOrder[n]] !== true) unscheduled.push(lessonById[lessonOrder[n]].name);
    }

    // ---------- 总周数 ----------
    // 校历：上游写法 ceil(ceil(相差天数) / 7)，相差天数是整数天数
    var calendarWeeks = 0;
    if (startDay !== null && endDay !== null && endDay > startDay) {
        calendarWeeks = Math.ceil((endDay - startDay) / 7);
    }
    // 课表里有比校历更晚的周次：校历给短了，按课表抬上去，并写进 warnings
    var raised = calendarWeeks > 0 && maxWeek > calendarWeeks;
    var totalWeeks = calendarWeeks;
    if (maxWeek > totalWeeks) totalWeeks = maxWeek;
    var weeksSource;
    if (calendarWeeks > 0) {
        weeksSource = raised ? 'raised' : 'calendar';
    } else {
        weeksSource = totalWeeks > 0 ? 'schedule' : 'default';
    }
    if (totalWeeks < 1) totalWeeks = 20;
    var clampedFrom = 0;
    if (totalWeeks > MAX_WEEKS) {
        clampedFrom = totalWeeks;
        totalWeeks = MAX_WEEKS;
    }

    // ---------- 核对提示（顺序：学期 → 开学日 → 丢弃的 → 节次 → 周数 → 学期名）----------
    if (term.pickedBy === 'first') {
        pushWarning('教务页面没有标出当前学期，已取学期列表里的第一个「' + termName +
            '」；如果不对，请在教务页面上切到目标学期后重新提取。');
    }
    if (semesterCount > 1) {
        pushWarning('本次只导入了「' + termName + '」（教务页面上当前打开的学期）；学期列表里还有 ' +
            (semesterCount - 1) + ' 个学期，需要哪一个就在教务页面上切过去再点「提取课表」。');
    }
    if (startAligned) {
        pushWarning('教务给的开学日期（' + isoOfDay(startDay) + '）不是周一，已对齐到当周周一 ' +
            isoOfDay(firstDay) + ' 作为第 1 周的起点，请在学期管理里核对。');
    }
    if (firstSource === 'schedule') {
        pushWarning('教务没有给出开学日期，已按排课日期推算第 1 周为 ' + isoOfDay(firstDay) +
            '（周一），请在学期管理里核对成学校实际开学日。');
    } else if (firstSource === 'today') {
        pushWarning('教务没有给出开学日期，也没有排课日期可以推算，已按本周周一 ' + isoOfDay(firstDay) +
            ' 作为第 1 周，请在学期管理里改成学校实际开学日。');
    }
    var skippedTotal = skip.lesson + skip.day + skip.time + skip.weeks;
    if (skippedTotal > 0) {
        var reasons = [];
        if (skip.lesson) reasons.push('找不到课程名 ' + skip.lesson + ' 条');
        if (skip.day) reasons.push('星期不对 ' + skip.day + ' 条');
        if (skip.time) reasons.push('上课时间不对 ' + skip.time + ' 条');
        if (skip.weeks) reasons.push('没有周次 ' + skip.weeks + ' 条');
        pushWarning('教务返回的排课记录里有 ' + skippedTotal + ' 条解析不了，已跳过（' +
            reasons.join('、') + '）；如发现少了课，请到教务页面核对原课表。');
    }
    if (timeDropped.count > 0) {
        pushWarning('有 ' + timeDropped.count + ' 个上课时段离所有节次都超过 ' + NEAREST_MINUTES +
            ' 分钟，已跳过（涉及「' + timeDropped.names.map(clipName).join('、') + '」），请到教务页面核对原课表。');
    }
    if (approx.count > 0) {
        pushWarning('有 ' + approx.count + ' 个上课时段的时间与节次时间对不上，已按开始时间最接近的一节放入' +
            '（例如「' + clipName(approx.first.name) + '」周' + DAY_NAMES[approx.first.day] + ' ' + approx.first.startHM +
            '-' + approx.first.endHM + ' 放入第 ' + approx.first.section + ' 节），请在课表里核对。');
    }
    if (unscheduled.length) {
        pushWarning('另有 ' + unscheduled.length + ' 门课教务没有排上课时间，例如 ' +
            unscheduled.slice(0, 3).map(clipName).join('、') + '，这些课没有导入。');
    }
    if (outOfRange > 0) {
        pushWarning('有 ' + outOfRange + ' 段安排在第 ' + MAX_WEEKS + ' 周以后，超出本应用支持的 ' + MAX_WEEKS +
            ' 周，已跳过。');
    }
    if (periodsSource === 'missing') {
        pushWarning('教务系统没有给出节次时间，第 1~' + BUILTIN_PERIOD_TIMES.length +
            ' 节的上下课时间按内置的作息表导入，请在学期管理里核对。');
    } else if (periodsSource === 'invalid') {
        pushWarning('教务给的节次时间有异常（时间对不上或节次不连续），已整张改用内置的 ' +
            BUILTIN_PERIOD_TIMES.length + ' 节作息表，请在学期管理里核对。');
    }
    if (weeksSource === 'schedule') {
        pushWarning('教务没有给出学期结束日期，学期总周数按课程里最晚的周次取为 ' + totalWeeks +
            ' 周，请在学期管理里核对。');
    } else if (weeksSource === 'default') {
        pushWarning('教务没有给出学期起止日期，也没有课程周次，学期总周数先按 20 周导入，请在学期管理里核对。');
    } else if (weeksSource === 'raised') {
        pushWarning('教务给的学期起止日期只能数出 ' + calendarWeeks + ' 周，但课表里有安排落在第 ' + maxWeek +
            ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对。');
    }
    if (clampedFrom) {
        pushWarning('教务给的学期起止日期跨了 ' + clampedFrom + ' 周，超过本应用的 ' + MAX_WEEKS +
            ' 周上限，学期总周数按 ' + MAX_WEEKS + ' 周导入。');
    }
    if (nameEstimated) {
        pushWarning('教务没有给出学期名称，已写成「' + termName + '」，可以在学期管理里改成你想要的名字。');
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
