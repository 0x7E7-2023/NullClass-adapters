(function () {
    // 西华师范大学课表解析（树维 for-std 平台）—— extract.js 的原始数据 → 空课课表载荷。
    // 移植自 shiguang_warehouse 的 CWNU/cwnu.js（MIT，作者 Smoggy Ting）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //   上游快照：f83288e（2026-11-24），本校脚本最后一次修改：6275607（2026-11-21）
    //
    // 上游怎么给数据：datum 的 lessonList 是课程，scheduleList 是排课明细（一条 = 一门课在某个星期几、某个时段、
    // 某一周）。这里：
    //   · 排课明细按 (课程, 星期, 开始时间, 结束时间, 教室) 分组收集周次。上游的分组键没有教室这一维，
    //     同一时段两间教室的排课会被合并掉一间；这里多带上教室，两间都保留；
    //   · 排课时间 → 节次：先取落在排课时间范围内的节次（首节 = 第一个，末节 = 最后一个）；对不上的，
    //     取开始时间最接近的一节（差不超过 60 分钟），放入并提醒；离所有节都超过 60 分钟的，跳过并点名提醒；
    //   · 同一门课的所有时段合成一门课；同一节次段的周次取并集，再切成极大段（ALL / ODD / EVEN），一段一个 block。
    //
    // 本校的特别之处：
    //   · 排课记录直接给「第几周」（weekIndex）和「星期几」（weekday），不用日期换算周次；
    //     开学日只用来定第 1 周从哪天起（按上游 firstDayOfWeek 对齐到周一或周日，移植手册 §4.3）；
    //   · 节次时间上游写死两套（夏令 / 冬令），空课一次只能交一套：按开学日所在的季节选一套，
    //     并提醒另一套从哪天起生效，需要到时在「学期管理」里改节次时间。学期跨两段时写清切换日期；
    //   · 排课标记不是「公开」的课，上游不导入，这里也不导入，并在提醒里说明；
    //   · 开学日取不到就按提取当天所在周作为第 1 周，并提醒。
    //
    // 解析不了的排课记录一律计数进 warnings，不静默丢课。拿不到的教师、教室写 null，不写「未知」「暂无」。

    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var term = data.term || {};
    var meta = data.semesterMeta || {};
    var semesterCount = (data.semesters || []).length;
    var weekIndices = data.weekIndices || [];
    var lessonList = data.lessonList || [];
    var scheduleList = data.scheduleList || [];

    var SCHOOL_NAME = '西华师范大学';
    // 载荷校验：totalWeeks 最多 30；超过 30 周的安排放不进载荷，只能跳过（会进 warnings）
    var MAX_WEEKS = 30;
    // 排课时间与节次对不上时，开始时间相差在这个分钟数以内的，按最接近的一节放入（移植手册 §4.4）
    var NEAREST_MINUTES = 60;
    var SEP = String.fromCharCode(0);
    var DAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];
    // 教务页面上的占位词，交出去必须是 null
    var PLACEHOLDERS = ['未知', '未知教师', '未知地点', '未知教室', '待定', '暂无', '暂无教师', '暂无教室', '无', 'null', 'undefined'];

    // 上游写死的两套节次时间（cwnu.js 的 SLOTS_WINTER / SLOTS_SUMMER，逐节照抄）。
    // 夏令 05-01 ~ 09-30，冬令 10-01 ~ 次年 04-30；上午相同，夏令的下午与晚上比冬令晚半小时。
    var SLOTS_WINTER = [
        { periodIndex: 1, start: '08:00', end: '08:40' },
        { periodIndex: 2, start: '08:50', end: '09:30' },
        { periodIndex: 3, start: '09:45', end: '10:25' },
        { periodIndex: 4, start: '10:35', end: '11:15' },
        { periodIndex: 5, start: '11:25', end: '12:05' },
        { periodIndex: 6, start: '14:30', end: '15:10' },
        { periodIndex: 7, start: '15:20', end: '16:00' },
        { periodIndex: 8, start: '16:10', end: '16:50' },
        { periodIndex: 9, start: '17:00', end: '17:40' },
        { periodIndex: 10, start: '19:00', end: '19:40' },
        { periodIndex: 11, start: '19:50', end: '20:30' },
        { periodIndex: 12, start: '20:40', end: '21:20' }
    ];
    var SLOTS_SUMMER = [
        { periodIndex: 1, start: '08:00', end: '08:40' },
        { periodIndex: 2, start: '08:50', end: '09:30' },
        { periodIndex: 3, start: '09:45', end: '10:25' },
        { periodIndex: 4, start: '10:35', end: '11:15' },
        { periodIndex: 5, start: '11:25', end: '12:05' },
        { periodIndex: 6, start: '15:00', end: '15:40' },
        { periodIndex: 7, start: '15:50', end: '16:30' },
        { periodIndex: 8, start: '16:40', end: '17:20' },
        { periodIndex: 9, start: '17:30', end: '18:10' },
        { periodIndex: 10, start: '19:30', end: '20:10' },
        { periodIndex: 11, start: '20:20', end: '21:00' },
        { periodIndex: 12, start: '21:10', end: '21:50' }
    ];

    // 提醒有长度与条数上限（每条 ≤200 字、总共 ≤20 条）。课名、学期名、原文一律先截到 20 字。
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_NAME_TEXT = 20;
    var warnings = [];

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

    // 所有提醒都从这里进。先全部收下（去重），输出时统一截断、统一计数。
    function pushWarning(message) {
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

    // 占位词与空值 → null（教师、教室都用这一条）
    function placeholderOut(value) {
        var t = text(value);
        if (!t || PLACEHOLDERS.indexOf(t) >= 0) return null;
        return t;
    }

    // 教师：在占位词判断之后，括号备注（「张三（外聘）」）剥掉，不拆成第二位教师
    function cleanName(value) {
        var t = placeholderOut(value);
        if (!t) return null;
        t = t.replace(/[（(][^（）()]*[）)]/g, '').replace(/\s+/g, ' ').trim();
        return t || null;
    }

    // "2026-09-07" / "2026/9/7" / "2026-09-07 00:00:00" 都认；只取日期部分，不经过 Date，避免时区挪日期
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

    // 该日所在周的起始日：周日起始（上游 firstDayOfWeek = 7）或周一起始（缺省）
    function weekStartOf(day, sundayFirst) {
        var wd = weekdayOfDay(day);
        return sundayFirst ? day - (wd % 7) : day - (wd - 1);
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

    // 学年学期名：拿不到学期名时才用，由第 1 周的日期推出学年
    function inferTermName(day) {
        var iso = isoOfDay(day);
        var year = intOf(iso.slice(0, 4));
        var month = intOf(iso.slice(5, 7));
        if (month >= 8) return year + '-' + (year + 1) + '学年第一学期';
        if (month >= 2) return (year - 1) + '-' + year + '学年第二学期';
        return (year - 1) + '-' + year + '学年第一学期';
    }

    // ---------- 节次时间：按季节选一套 ----------
    // 季节以开学日为准（取不到就按提取当天）：5 月至 9 月是夏令，其余是冬令。
    var refDay = dayOf(meta.startDate);
    var fixedToday = dayOf(data.today);
    if (refDay === null) refDay = fixedToday !== null ? fixedToday : todayDay();
    var refIso = isoOfDay(refDay);
    var refYear = intOf(refIso.slice(0, 4));
    var refMonth = intOf(refIso.slice(5, 7));
    var summerNow = refMonth >= 5 && refMonth <= 9;
    var periodTimes = summerNow ? SLOTS_SUMMER : SLOTS_WINTER;
    var otherName = summerNow ? '冬令' : '夏令';
    var chosenName = summerNow ? '夏令' : '冬令';
    // 切换日：夏令之后是 10 月 1 日；冬令之后是次年 5 月 1 日（1–4 月的冬令在当年 5 月 1 日切到夏令）
    var switchDay;
    if (summerNow) {
        switchDay = dayOf(refYear + '-10-01');
    } else if (refMonth >= 10) {
        switchDay = dayOf((refYear + 1) + '-05-01');
    } else {
        switchDay = dayOf(refYear + '-05-01');
    }
    var switchIso = isoOfDay(switchDay);
    var switchText = intOf(switchIso.slice(5, 7)) + ' 月 ' + intOf(switchIso.slice(8, 10)) + ' 日';

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
    // 夏令、冬令的下午差半小时：时间对不上的一律算「近似」并提醒，包括整段落在范围内但首末节对不齐的情形
    // （例如冬令的 14:30-16:00 落在夏令表上只剩第 6 节），免得课被悄悄缩短。
    function sectionsOf(startMin, endMin) {
        var first = null;
        var last = null;
        var exact = true;
        for (var i = 0; i < units.length; i++) {
            if (units[i].start >= startMin && units[i].end <= endMin) {
                if (first === null) first = units[i];
                last = units[i];
            }
        }
        if (first !== null) {
            if (first.start !== startMin || last.end !== endMin) exact = false;
            return { start: first.indexNo, end: last.indexNo, approx: !exact };
        }
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
    var sundayFirst = meta.weekStartOnSunday === true;
    var startDay = dayOf(meta.startDate);
    var endDay = dayOf(meta.endDate);
    var firstDay;
    var firstSource;
    if (startDay !== null) {
        firstDay = weekStartOf(startDay, sundayFirst);
        firstSource = 'meta';
    } else {
        firstDay = weekStartOf(refDay, sundayFirst);
        firstSource = 'today';
    }

    // ---------- 学期名 ----------
    var termName = text(term.label);
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
    var hiddenLessons = [];
    for (var li = 0; li < lessonList.length; li++) {
        var lesson = lessonList[li] || {};
        var lessonKey = String(lesson.id);
        var lessonName = text(lesson.courseName);
        if (!lessonName) continue;
        var lessonTeachers = [];
        var rawTeachers = lesson.teachers || [];
        for (var lt = 0; lt < rawTeachers.length; lt++) {
            var tName = cleanName(rawTeachers[lt]);
            if (tName && lessonTeachers.indexOf(tName) === -1) lessonTeachers.push(tName);
        }
        lessonById[lessonKey] = { name: lessonName, teachers: lessonTeachers, flag: lesson.flag || null };
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
        // 教务标了「不公开」的课上游不导入：照做，但要说
        if (lessonInfo.flag && lessonInfo.flag !== 'publish') {
            if (hiddenLessons.indexOf(sLessonKey) === -1) hiddenLessons.push(sLessonKey);
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
        var place = placeholderOut(s.roomName);
        var rowTeacher = cleanName(s.personName) || (lessonInfo.teachers.length ? lessonInfo.teachers.join('、') : null);
        var groupKey = [sLessonKey, day, startHM, endHM, place || '', rowTeacher || ''].join(SEP);
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
                    section: sections.start === sections.end ? '第 ' + sections.start + ' 节' :
                        '第 ' + sections.start + '–' + sections.end + ' 节'
                };
            }
        }
        // 同一门课、不同教师是两条课程（载荷的课程只有一位教师）
        var courseKey = grp.lessonKey + SEP + (grp.teacher || '');
        if (!courseMap[courseKey]) {
            courseMap[courseKey] = { name: info.name, teacher: grp.teacher, slots: {}, slotOrder: [] };
            courseOrder.push(courseKey);
        }
        var course = courseMap[courseKey];
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
    var trimmedKeys = [];
    var noTeacherKeys = [];
    var noRoomKeys = [];
    for (var c = 0; c < courseOrder.length; c++) {
        var cObj = courseMap[courseOrder[c]];
        var blocks = [];
        for (var k2 = 0; k2 < cObj.slotOrder.length; k2++) {
            var slot = cObj.slots[cObj.slotOrder[k2]];
            slot.weeks.sort(function (a, b) { return a - b; });
            // 第 30 周以后的周裁掉，保留 ≤30 的部分；被裁过的课点名提醒
            var kept = [];
            for (var kw = 0; kw < slot.weeks.length; kw++) {
                if (slot.weeks[kw] <= MAX_WEEKS) kept.push(slot.weeks[kw]);
                else if (trimmedKeys.indexOf(courseOrder[c]) === -1) trimmedKeys.push(courseOrder[c]);
            }
            var runs = runsOf(kept);
            for (var r = 0; r < runs.length; r++) {
                var run = runs[r];
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
        var teacher = cObj.teacher || null;
        if (!teacher) noTeacherKeys.push(cObj.name);
        var anyRoomMissing = false;
        for (var bi = 0; bi < blocks.length; bi++) {
            if (!blocks[bi].location) anyRoomMissing = true;
        }
        if (anyRoomMissing) noRoomKeys.push(cObj.name);
        courses.push({
            name: cObj.name,
            teacher: teacher,
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
        if (scheduledLessons[lessonOrder[n]] !== true) {
            unscheduled.push(lessonById[lessonOrder[n]].name);
        }
    }

    // ---------- 总周数 ----------
    // 有校历用校历：开学日所在周起，到结束日为止的周数（含结束日所在的周）；没有结束日就用教务给的周次名单的最大周。
    // 都没有就按 20 周。课表里有比它更晚的周次，才抬到那一周，并提醒。课程的最大周不当作学期长度。
    var weekListMax = 0;
    for (var wl = 0; wl < weekIndices.length; wl++) {
        var wv = intOf(weekIndices[wl]);
        if (wv > weekListMax) weekListMax = wv;
    }
    var calendarWeeks = 0;
    var calendarSource = 'default';
    if (endDay !== null && endDay >= firstDay) {
        calendarWeeks = Math.ceil((endDay - firstDay + 1) / 7);
        calendarSource = 'calendar';
    } else if (weekListMax > 0) {
        calendarWeeks = weekListMax;
        calendarSource = 'weekList';
    }
    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : 20;
    var raised = maxWeek > totalWeeks;
    if (raised) totalWeeks = maxWeek;
    var clampedFrom = 0;
    if (totalWeeks > MAX_WEEKS) {
        clampedFrom = totalWeeks;
        totalWeeks = MAX_WEEKS;
    }

    // ---------- 核对提示（顺序：学期 → 开学日 → 节次 → 丢弃的 → 课程缺项 → 周数 → 学期名）----------
    if (term.pickedBy === 'first') {
        pushWarning('教务页面没有标出当前学期，已取学期列表里的第一个「' + clipName(termName) +
            '」；如果不对，请在教务页面上切到目标学期后重新提取。');
    }
    if (semesterCount > 1) {
        pushWarning('本次只导入了「' + clipName(termName) + '」（教务页面上当前打开的学期）；学期列表里还有 ' +
            (semesterCount - 1) + ' 个学期，需要哪一个就在教务页面上切过去再点「提取课表」。');
    }
    if (firstSource === 'today') {
        pushWarning('教务没有给出开学日期，已按今天所在的这一周（从 ' + isoOfDay(firstDay) +
            ' 起）作为第 1 周，请在学期管理里改成学校实际开学日。');
    }
    // 节次时间只能交一套：说清楚用的哪套、另一套从哪天起、学期跨不跨两段
    var spansTwo = startDay !== null && endDay !== null && switchDay > startDay && switchDay <= endDay;
    if (spansTwo) {
        pushWarning('本学期跨两段节次时间：' + switchText + '前按「' + chosenName + '节次时间」导入，' + switchText +
            '起学校改用「' + otherName + '节次时间」（下午和晚上差半小时）。空课只能导入一套，请到学期管理里改节次时间。');
    } else {
        pushWarning('教务页面不给节次时间，已按学校的「' + chosenName + '节次时间」导入第 1–12 节。' + switchText +
            '起学校改用「' + otherName + '节次时间」（下午和晚上差半小时），到时请在学期管理里改节次时间。');
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
    // 教务未公开安排的课：按类型汇总一条，点名最多 3 门（课名截 20 字）
    if (hiddenLessons.length) {
        var hiddenNames = [];
        for (var hl = 0; hl < hiddenLessons.length && hl < 3; hl++) {
            hiddenNames.push(clipName(lessonById[hiddenLessons[hl]].name));
        }
        pushWarning('另有 ' + hiddenLessons.length + ' 门课教务未公开安排，例如 ' + hiddenNames.join('、') +
            '，这些课没有导入。');
    }
    if (timeDropped.count > 0) {
        pushWarning('有 ' + timeDropped.count + ' 个上课时段离所有节次都超过 ' + NEAREST_MINUTES +
            ' 分钟，已跳过（涉及「' + timeDropped.names.map(clipName).join('、') + '」），请到教务页面核对原课表。');
    }
    if (approx.count > 0) {
        pushWarning('有 ' + approx.count + ' 个上课时段的时间与节次时间对不上，已按最接近的节次放入' +
            '（例如「' + clipName(approx.first.name) + '」周' + DAY_NAMES[approx.first.day] + ' ' + approx.first.startHM +
            '-' + approx.first.endHM + ' 放入' + approx.first.section + '），请在课表里核对。');
    }
    if (unscheduled.length) {
        pushWarning('另有 ' + unscheduled.length + ' 门课教务没有排上课时间，例如 ' +
            unscheduled.slice(0, 3).map(clipName).join('、') + '，这些课没有导入。');
    }
    if (noTeacherKeys.length) {
        pushWarning('有 ' + noTeacherKeys.length + ' 门课没有教师名，已留空，例如 ' +
            noTeacherKeys.slice(0, 3).map(clipName).join('、') + '。可在「编辑课程」里补上。');
    }
    if (noRoomKeys.length) {
        pushWarning('有 ' + noRoomKeys.length + ' 门课没有教室，已留空，例如 ' +
            noRoomKeys.slice(0, 3).map(clipName).join('、') + '。可在「编辑课程」里补上。');
    }
    if (trimmedKeys.length) {
        var trimmedNames = [];
        for (var tk = 0; tk < trimmedKeys.length && tk < 3; tk++) trimmedNames.push(clipName(courseMap[trimmedKeys[tk]].name));
        pushWarning('有 ' + trimmedKeys.length + ' 门课在第 ' + MAX_WEEKS + ' 周以后有安排，超出的周次没有导入，例如 ' +
            trimmedNames.join('、') + '。');
    }
    if (raised) {
        var why = calendarSource === 'calendar' ? '教务给的学期结束日期只能数出 ' + calendarWeeks + ' 周'
            : calendarSource === 'weekList' ? '教务给的周次只到第 ' + calendarWeeks + ' 周'
            : '教务没有给出学期结束日期，先按 20 周算';
        pushWarning(why + '，但课表里有安排落在第 ' + maxWeek + ' 周，学期总周数已按 ' + maxWeek + ' 周导入，请在学期管理里核对。');
    }
    if (clampedFrom) {
        pushWarning('教务给的学期跨了 ' + clampedFrom + ' 周，超过本应用的 ' + MAX_WEEKS +
            ' 周上限，学期总周数按 ' + MAX_WEEKS + ' 周导入。');
    }
    if (nameEstimated) {
        pushWarning('教务没有给出学期名称，已写成「' + termName + '」，可以在学期管理里改成你想要的名字。');
    }

    // 载荷校验：每条 ≤200 字、总共 ≤20 条。超过 20 条时，第 20 条换成汇总，写清没显示的条数。
    var finalWarnings = warnings;
    if (warnings.length > MAX_WARNINGS) {
        finalWarnings = warnings.slice(0, MAX_WARNINGS - 1);
        finalWarnings.push('另有 ' + (warnings.length - (MAX_WARNINGS - 1)) + ' 条提醒没有显示，请到教务页面核对原课表。');
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finalWarnings,
        terms: [
            {
                name: termName,
                firstDay: isoOfDay(firstDay),
                totalWeeks: totalWeeks,
                periodTimes: periodTimes.map(function (p) {
                    return { periodIndex: p.periodIndex, start: p.start, end: p.end };
                }),
                courses: courses
            }
        ]
    });
})()
