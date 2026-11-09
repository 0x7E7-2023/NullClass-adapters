(function () {
    // 同济大学「1 系统」教务适配器（学校自研 REST 接口，https://1.tongji.edu.cn/api）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 TONGJI/tongji_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Linho1219）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-09 拉取）
    //   本校脚本在快照里的最后一次修改 1fe584ccf60553688e7759cd8070baf5caae66ed（2026-08-23，refactor: 升级桥接接口至v2）
    //
    // 上游在同一段脚本里判登录、选学期、取课表、存配置；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交出来的是 parse 用得到的字段：学期名、日历详情里的开学日与逐节时间、课表行。
    //
    // 移植改动（逐条对应 AUDIT.md §4）：
    //   ① 删掉「是否使用当前学期」选择弹窗：直接采用教务当前学期（currentTermCalendar）；当前学期读不到时，
    //      退一步用学期列表的第一项并在 warnings 里如实说明（上游会让用户选）
    //   ② 周次改成读数字数组（上游 weeks 本来就是数组），去重、排序后按极大段切成 block；
    //      超出 1-30 的周次与读不出来的元素丢弃并计数，不许静默
    //   ③ 教师：照上游的 removeId 去掉教师名后的教学工号括号（"(1001)"），多位教师仍用逗号分隔；
    //      全角括号与顿号先归一。剥完为空、或写着「未知」「待定」「暂无」时交 null（上游会原样带出）
    //   ④ 教室：roomIdI18n 优先，为空时用上游注释里点了名的 roomLable（拼写错误的字段名，以代码为准）；
    //      两者都为空或写着占位词时交 null
    //   ⑤ 缺教师 / 缺教室的课照常导入，按课名去重后汇总写进 warnings（上游不检查这两项）
    //   ⑥ 节次时间：照上游从 detail 的 noWeekendWorkTimes 读，number 按数组下标 +1；取不到时用空课默认 12 节，
    //      并把「用的是默认节次时间」写进 warnings。课表用到更晚的节次时按批次统一修订 H3 逐节补并说明
    //   ⑦ 开学日：detail 的 beginDay 回退到那一周的周一（手册 §4.3）；取不到按学期锚点推算并写 warnings
    //   ⑧ 总周数：detail 里找得到就用它；找不到按内置 20 周，课表里有更晚的周次才抬高并说明，不拿课表最大周直接当学期长度
    //   ⑨ 上游的导出流程（开场弹窗、saveImportedCourses / savePresetTimeSlots / saveCourseConfig、
    //      showToast / notifyTaskCompletion）全部不移植：空课由宿主负责保存，适配器只交载荷
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var detail = data.detail || {};
    var rows = Array.isArray(data.courses) ? data.courses : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks 与周次都在 1..30
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '同济大学';   // 学期名兜底时用（拿不到学年时「学校名 + 学期」，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务没给学期总周数时的内置值（公共说明 §本批共性 7）
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名 / 学期名最多显示的字数
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：课间几分钟
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）。
    // 本校上游没有写死的节次表，教务的 noWeekendWorkTimes 取不到时整张用它；课表用到更晚的节次时按 H3 补。
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

    var KIND_CN = { first: '一', second: '二', third: '三' };
    // 推算开学日的锚点：第一学期多在 9 月初、第二学期多在 2 月下旬、夏季学期 7 月初。
    // 锚点当天不一定就是入学日，按手册 §4.3 回退到那一周的周一。
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '夏季学期 = 7 月 1 日所在周的周一' }
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 课名过长时截短，避免一个超长课名就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    // 字典里有多少个键（用对象当字典，ES5 下不引入 Set 之类）
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

    // 任意形态的日期 → ISO 日期（只认年月日，后面的时间 / 时区部分忽略；
    // 上游 beginDay 形如 2026-09-07T00:00:00+08:00，这里正好取前三段）
    function isoOfAny(value) {
        var m = /^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})/.exec(text(value));
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

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // "08:10" / "08:10:00" → "08:10"；认不出来（含 24:00、85:45 这类）返回 null。
    // 载荷校验要求 periodTimes 的时间必须是 HH:mm 且 00:00–23:59。
    function timeOf(value) {
        var m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(text(value));
        if (!m) return null;
        return (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2];
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
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

    // ---------- 学期名与学期序号 ----------
    function termKind() {
        var label = text(term.name);
        if (label.indexOf('二') >= 0 || label.indexOf('春') >= 0) return 'second';
        if (label.indexOf('三') >= 0 || label.indexOf('夏') >= 0) return 'third';
        return 'first';
    }

    function termYear() {
        var m = /([0-9]{4})\s*[-~至—–]\s*[0-9]{4}/.exec(text(term.name));
        return m ? parseInt(m[1], 10) : 0;
    }

    // 学期名用教务自己的学年学期文本（手册 §4.7）；只给了「第一学期」这种短名时补上学校名
    function termName() {
        var label = text(term.name);
        if (label) {
            if (label.indexOf('学年') >= 0 || /^[0-9]{4}/.test(label)) return label;
            return SCHOOL_NAME + ' ' + label;
        }
        return SCHOOL_NAME + ' 第' + KIND_CN[termKind()] + '学期';
    }

    // 教务没给开学日时的推算。依赖学期序号的锚点，推算结果一律写进 warnings。
    function estimateStart(todayIso) {
        var kind = termKind();
        var year = termYear();
        if (!year) {
            // 学年读不出来时退回「今天的周一」。这条分支依赖当天日期，
            // 用例里给的是输入里的 today，不是真实时间
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天的周一' };
        }
        return {
            iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), KIND_ANCHOR[kind].month, KIND_ANCHOR[kind].day)),
            rule: KIND_ANCHOR[kind].rule
        };
    }

    // ---------- 教师 / 教室 ----------
    // 「未知」「待定」「暂无」这类占位词不是真名，交出去会被课表当成教师 / 教室显示（手册 §4.7）
    function isPlaceholder(value) {
        return /^(未知|待定|暂无|暂无教师|暂无教室|未安排|待安排|无)$/.test(text(value));
    }

    function normalizeMarks(source) {
        return source
            .replace(/[（]/g, '(')
            .replace(/[）]/g, ')')
            .replace(/[、，；;]/g, ',');
    }

    // 照上游 removeId：去掉教师名后的教学工号括号（"(1001)"），多位教师仍用逗号分隔。
    // 上游对 "(1001)," 替换成 ", "，末尾的 "(1001)" 直接删；这里先归一全角括号与顿号再照做
    function teacherOf(value) {
        var name = text(value);
        if (!name) return '';
        name = normalizeMarks(name)
            .replace(/\([0-9]+\)$/, '')
            .replace(/\([0-9]+\),/g, ', ')
            .replace(/^[,\s]+/, '')
            .replace(/[,\s]+$/, '');
        name = text(name);
        if (!name || isPlaceholder(name)) return '';
        return name;
    }

    function locationOf(value) {
        var place = text(value);
        if (!place || isPlaceholder(place)) return '';
        return place;
    }

    // ---------- 周次（本校是数字数组，不是位串也不是文字） ----------
    var droppedWeeks = 0;   // 读不出来或超出 1..MAX_WEEK 的周次个数

    function weeksOfValue(value) {
        var out = [];
        var seen = {};
        if (!Array.isArray(value)) return out;
        for (var i = 0; i < value.length; i++) {
            var week = intOf(value[i]);
            if (week === null || week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
            if (!seen[week]) { seen[week] = true; out.push(week); }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周（手册 §4.1）。
    // 一个上游 course 切出多段就写成多个 block，语义等价。
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

    // ---------- 教务的逐节时间（detail.noWeekendWorkTimes，下标 +1 就是节次号） ----------
    // 要求每节起止都能认出来、结束晚于开始、且和上一节不重叠；不满足就当没取到（回落到空课默认 12 节并说明），不猜。
    function periodTimesOf(value) {
        if (!Array.isArray(value)) return null;
        var slots = [];
        for (var i = 0; i < value.length; i++) {
            var item = value[i] || {};
            var start = timeOf(item.beginTime);
            var end = timeOf(item.endTime);
            if (!start || !end) return null;
            if (minutesOf(start) >= minutesOf(end)) return null;
            if (slots.length && minutesOf(start) < minutesOf(slots[slots.length - 1].end)) return null;
            slots.push({ periodIndex: i + 1, start: start, end: end });
        }
        return slots.length ? slots : null;
    }

    // ---------- 逐行转换 ----------
    var courses = [];
    var byName = {};
    var entries = [];
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    // 已导入、但教务没给上课教师 / 上课地点的课（按课名去重，提醒里说「N 门课」才准）
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var weekSamples = [];    // 没解析出周次的原始内容，最多留 3 个
    var noTimeNames = [];    // 教务里只有课程名、没有任何上课安排的课，最多留 3 个
    var noTimeCourses = 0;
    var maxWeek = 0;
    var maxPeriod = 0;

    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序
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

    function weeksSample(value) {
        if (Array.isArray(value)) {
            var parts = [];
            for (var i = 0; i < value.length && i < 8; i++) parts.push(text(value[i]));
            return parts.join(',');
        }
        return text(value);
    }

    for (var r = 0; r < rows.length; r++) {
        var courseRow = rows[r] || {};
        var name = text(courseRow.courseName);
        var slots = Array.isArray(courseRow.timeTableList) ? courseRow.timeTableList : [];
        if (!slots.length) {
            if (name) {
                noTimeCourses++;
                if (noTimeNames.length < 3 && noTimeNames.indexOf(name) < 0) noTimeNames.push(name);
            } else {
                missing.name++;
            }
            continue;
        }
        for (var s = 0; s < slots.length; s++) {
            var slot = slots[s] || {};
            if (!name) { missing.name++; continue; }

            var day = intOf(slot.dayOfWeek);
            if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

            var start = intOf(slot.timeStart);
            var end = intOf(slot.timeEnd);
            if (start === null || end === null || start < 1 || end < start || end > MAX_PERIOD) {
                missing.period++;
                continue;
            }

            var weeks = weeksOfValue(slot.weeks);
            if (!weeks.length) {
                missing.week++;
                var sample = weeksSample(slot.weeks);
                if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
                continue;
            }

            // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
            // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
            var teacher = teacherOf(slot.teacherName);
            var location = locationOf(slot.roomIdI18n) || locationOf(slot.roomLable);
            if (!teacher) missingTeacherCourses['n' + name] = true;
            if (!location) missingLocationCourses['n' + name] = true;
            if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
                fieldSamples.push(name);
            }

            entries.push({
                course: courseOf(name, teacher || null),
                name: name,
                teacher: teacher,
                location: location,
                day: day,
                start: start,
                end: end,
                weeks: weeks
            });
        }
    }

    // 完全相同的行（课名、教师、教室、星期、起止节次、周次都一样）只留第一条：
    // 教务逐周 / 逐页返回时同一条记录会重复出现，先按内容去重，后面「有 N 处」的计数才不会被放大
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

    entries = dropExactDuplicates(entries);

    for (var m = 0; m < entries.length; m++) {
        var item = entries[m];
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
            '请重新登录、在「1 系统」里确认能看到课表后再点「提取课表」'
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
    var beginIso = isoOfAny(detail.beginDay);
    var apiPeriodTimes = periodTimesOf(detail.times);

    var start;
    if (beginIso) {
        start = { iso: mondayOfIso(beginIso), rule: '教务系统给出的开学日期所在周的周一' };
    } else {
        start = estimateStart(todayIso);
    }

    var apiWeeks = intOf(detail.totalWeeks);
    var usedCalendarWeeks = apiWeeks !== null && apiWeeks >= 1 && apiWeeks <= MAX_WEEK;
    var totalWeeks = usedCalendarWeeks ? apiWeeks : SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }
    if (totalWeeks < 1) totalWeeks = SCHOOL_TOTAL_WEEKS;

    // 分钟数写回 HH:mm（补时间用）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    // 节次号（已升序）写成「第 9-12 节」「第 9 节」「第 9、11-12 节」这几种
    function sectionsText(list) {
        var runs = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) {
                j++;
            }
            runs.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + runs.join('、') + ' 节';
    }

    // ---------- 节次时间：教务的优先，取不到整张用空课默认 12 节；更晚的节次逐节补，补不了如实说明 ----------
    var usedBuiltin = !apiPeriodTimes;
    var periodTimes = usedBuiltin ? BUILTIN_PERIOD_TIMES.slice(0) : apiPeriodTimes.slice(0);
    var tableLength = periodTimes.length;
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
        if (!prev) { uncoveredFrom = p; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    if (term.fromList) {
        warn(
            '教务系统没有给出当前学期，已按学期列表的第一项（' + shortName(name0) +
            '）导入；如不是要导入的学期，请在教务系统里切换到目标学期后再点「提取课表」'
        );
    } else {
        warn(
            '已按教务系统的当前学期（' + shortName(name0) +
            '）导入；要导入别的学期，请在教务系统里切换到那个学期后再点「提取课表」'
        );
    }

    if (beginIso && beginIso !== start.iso) {
        warn(
            '教务系统给的开学日期 ' + beginIso + ' 不是周一，第 1 周按所在周的周一 ' + start.iso +
            ' 计算，请在学期管理里核对'
        );
    } else if (beginIso) {
        warn('开学日期取自教务系统：第 1 周从 ' + start.iso + ' 开始，请在学期管理里核对');
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start.rule +
            '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raisedBySchedule && usedCalendarWeeks) {
        warn(
            '教务系统写的学期总周数是 ' + apiWeeks + ' 周，课表里有第 ' + maxWeek + ' 周的课，已按 ' +
            totalWeeks + ' 周导入（否则第 ' + (apiWeeks + 1) + ' 周起的课放不下）'
        );
    } else if (raisedBySchedule) {
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入，如与实际不符可在学期管理里改'
        );
    } else if (usedCalendarWeeks) {
        warn(
            '学期总周数取自教务系统（' + totalWeeks + ' 周）' +
            (clamped ? '，已按最多 ' + MAX_WEEK + ' 周导入' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (usedBuiltin) {
        warn(
            '教务系统没有给出节次时间，已按空课的默认 ' + BUILTIN_PERIOD_TIMES.length +
            ' 节节次时间导入（第 1 节 ' + BUILTIN_PERIOD_TIMES[0].start + '-' + BUILTIN_PERIOD_TIMES[0].end +
            '），时间可能与学校实际不符，请在学期管理里核对'
        );
    }
    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
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
        if (missing.week) reasons.push('缺周次（或周次全读不出来）' + missing.week + ' 行');
        if (weekSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push(shortName(weekSamples[ws]));
            reasons.push('读不出来的周次如「' + sampleTexts.join('」「') + '」');
        }
        warn(
            '有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }

    if (noTimeCourses > 0) {
        var noTimeShown = [];
        for (var nt = 0; nt < noTimeNames.length; nt++) noTimeShown.push(shortName(noTimeNames[nt]));
        warn(
            '教务系统里有 ' + noTimeCourses + ' 门课没有上课安排（例如 ' + noTimeShown.join('、') +
            '）：没有星期与节次，排不进周课表，请自行在学期里添加'
        );
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），但按类型汇总计数说出来，不静默
    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownFieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownFieldNames.push(shortName(fieldSamples[fs]));
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + shownFieldNames.join('、') + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上'
        );
    }

    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次读不出来或超出 1-' + MAX_WEEK + ' 周，已忽略（教务给出的周次不正常）');
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
                name: name0,
                firstDay: start.iso,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
