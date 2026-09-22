(function () {
    // 成都信息工程大学教务适配器（本科实践教学平台）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 CUIT/cuit_bk_new.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 igugyj(Pfolg)）
    //   上游快照 fa7cbc2ea116e5ffd082a9fe8cb7bdf4407a8713（2026-09-22）
    //   上游 adapters.yaml：adapter_id "CUIT_01"、adapter_name "成都信息工程大学本科实践教学平台"、
    //   asset_js_path "cuit_bk_new.js"、import_url "https://ywtb.cuit.edu.cn/"
    //   （同目录还有 CUIT_02 = 教务管理系统 cuit_bk_old.js，已移植在 jw-adapters/cuit/，与本件无关）
    //
    // 这一台教务接口本身就返回**扁平数组**（每行一条课表安排，字段名清楚：courseName /
    // teacherName / location / weekDay / sections / weeks / startTime / endTime），
    // 不像 jw-adapters/cuit（教务管理系统）那样要在 HTML 里认内嵌 JS 块、也不用位图解码 ——
    // 周次本来就是显式数组（手册 §4.1 的「上游给的是显式周次数组」这一类），
    // 所以本件比 jw-adapters/cuit 简单很多，不需要那么多正则。
    //
    // 移植改动（逐条）：
    //   ① ES6 → ES5：去掉模板串、箭头函数、块级声明关键字、可选链。
    //   ② 周次数组 → (startWeek, endWeek, weekType) 按手册 §4.1 切段（排序去重后取极大段）；
    //      一行数据切出多段就写成多个 block。
    //   ③ 开学日：上游 importConfig() 只对字符串 "2025-2026" + "第一学期" 特判成
    //      "2025-09-01"，其余一律写死 "2026-02-23"、总周数写死 20 —— 这两个值只在上游写
    //      脚本那一刻对，过了那一学期就是错的（也没有任何 warnings 提示用户这是猜的）。
    //      本移植不背这个包袱：改成按学期名（"YYYY-YYYY学年第N学期"）推算「学期锚点所在周的
    //      周一」（第一学期 = 当年 9 月 1 日所在周一，第二学期 = 次年 2 月 20 日所在周一，
    //      与 jw-adapters/cuit 同一套锚点），并且**在 warnings 里如实说明是推算值**（手册 §4.2）。
    //   ④ 总周数：上游写死 20。本件改成按课表里出现的最晚周次推算（课表数据本身就有显式
    //      weeks 数组，不需要猜），同样在 warnings 里说明来源。
    //   ⑤ 学期名：extract.js 在三种取法都失败时把 semester 留空（不像上游那样冒充一个
    //      写死的学期字符串），这里对应地在拿不到规范学期名时使用占位名并写 warnings。
    //   ⑥ 自定义时间（手册 §4.4）：上游对每一行都不管三七二十一取
    //      item.sections[0]/[last]，没有 sections 时也硬当成第 1 节。本件按手册的规则来：
    //      有 sections 就按 sections 的最小/最大节次放课；没有 sections 但有 startTime，
    //      按开始时间在内置作息表里找最接近的一节（差 ≤1 小时）；两者都没有就跳过这门课
    //      并写 warnings，不悄悄当成「第 1 节」。
    //   ⑦ 教师 / 教室拿不到一律留空（null），不写「未知」（手册 §4.7）。
    //   ⑧ 周次上限：位图/数组里出现超过 30 周的一律截断到 30（起始周本身超过 30 的整段丢弃），
    //      都写进 warnings，不悄悄丢课；一门课的全部周次都因此被丢光时，这门课不出现在
    //      载荷里，并单独计数写一条 warnings（不能让用户以为这门课本来就没排）。
    //   ⑨ 作息时间：上游的 importTimeSlots() 与 jw-adapters/cuit 的内置表数值完全一致
    //      （同一所学校），原样搬过来；载荷不写 periodTimes 之外的额外信息，只把这张表
    //      写进 warnings 供核对（理由同 jw-adapters/cuit：上游本来就是作息与课程分两份）。
    //   ⑩ 上游的 showToast / showAlert / shiguangBridge* 系列回调全部没有移植。

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var semesterLabel = text(data.semester);
    var rows = (data.raw && data.raw.rows instanceof Array) ? data.raw.rows : [];

    var SEP = String.fromCharCode(0);   // 复合键分隔符：源码里不出现控制字符、也不出现转义序列
    var MAX_WEEK = 30;                  // 载荷校验：totalWeeks ∈ 1..30，startWeek/endWeek ∈ 1..totalWeeks
    var MAX_SECTION = 20;               // 单行节次的合理性上限：超过它一定是脏数据
    var CUSTOM_TIME_TOLERANCE_MIN = 60; // 手册 §4.4：没有节次时按开始时间就近匹配，差 ≤1 小时才认
    var SEMESTER_PREFIX = '成都信息工程大学';
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;

    // 学校作息（成都信息工程大学）：与 jw-adapters/cuit 的内置表完全一致（同一所学校），
    // 取自上游 cuit_bk_new.js 的 importTimeSlots() 预设表，原样搬过来。
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:20', end: '09:05' },
        { periodIndex: 2, start: '09:15', end: '10:00' },
        { periodIndex: 3, start: '10:20', end: '11:05' },
        { periodIndex: 4, start: '11:15', end: '12:00' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:55', end: '15:40' },
        { periodIndex: 7, start: '15:50', end: '16:35' },
        { periodIndex: 8, start: '16:45', end: '17:30' },
        { periodIndex: 9, start: '17:40', end: '18:25' },
        { periodIndex: 10, start: '19:30', end: '20:15' },
        { periodIndex: 11, start: '20:25', end: '21:10' },
        { periodIndex: 12, start: '21:20', end: '22:05' }
    ];

    // 推算开学日的锚点：第一学期多在 9 月初，第二学期多在 2 月下旬（与 jw-adapters/cuit 同锚点）。
    var KIND_CN = { first: '一', second: '二', third: '三' };
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 次年 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '夏季学期 = 7 月 1 日所在周的周一' }
    };

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

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
    }

    function isoOfAny(value) {
        var s = text(value);
        var m = /^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})/.exec(s);
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

    // 确定性的比较函数：不用 localeCompare（fixture 是逐数组比对的）
    function cmpStr(a, b) {
        if (a === b) return 0;
        return a < b ? -1 : 1;
    }

    function cmpNum(a, b) {
        return a === b ? 0 : (a < b ? -1 : 1);
    }

    // ---------- 学期名与开学日锚点 ----------
    // 学期名形如「2026-2027学年第一学期」时原样使用；识别不出年份/学期序号时只用来猜锚点，
    // 猜不到年份则整体退回「今天的周一」（见 estimateStart 的兜底分支）。
    function parseSemesterLabel(label) {
        var yearMatch = /([0-9]{4})-([0-9]{4})/.exec(label);
        var kind = 'first';
        if (/第二学期|下学期/.test(label)) kind = 'second';
        else if (/第三学期|夏季学期|小学期/.test(label)) kind = 'third';
        return {
            year: yearMatch ? parseInt(yearMatch[1], 10) : null,
            kind: kind
        };
    }

    function termName() {
        if (semesterLabel && semesterLabel.indexOf('学期') >= 0) return semesterLabel;
        return SEMESTER_PREFIX + '学期';
    }

    function estimateStart(todayIso) {
        var parsed = parseSemesterLabel(semesterLabel);
        if (!parsed.year) {
            // 学期名读不出年份时退回「今天的周一」。这条分支依赖当天日期，不写进 fixture 用例。
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天的周一（没有从页面读到可识别的学期名称）' };
        }
        var anchor = KIND_ANCHOR[parsed.kind];
        var anchorYear = parsed.kind === 'first' ? parsed.year : parsed.year + 1;
        return { iso: isoOf(mondayOnOrBefore(anchorYear, anchor.month, anchor.day)), rule: anchor.rule };
    }

    // ---------- 就近匹配节次（手册 §4.4：只有自定义时间没有节次时用） ----------
    function minutesOfHHMM(value) {
        var m = /^([0-9]{1,2}):([0-9]{2})/.exec(text(value));
        if (!m) return null;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    function nearestPeriod(startTimeRaw) {
        var minutes = minutesOfHHMM(startTimeRaw);
        if (minutes === null) return null;
        var best = null;
        var bestDiff = CUSTOM_TIME_TOLERANCE_MIN + 1;
        var i;
        for (i = 0; i < SCHOOL_PERIOD_TIMES.length; i++) {
            var periodMinutes = minutesOfHHMM(SCHOOL_PERIOD_TIMES[i].start);
            if (periodMinutes === null) continue;
            var diff = Math.abs(periodMinutes - minutes);
            if (diff <= CUSTOM_TIME_TOLERANCE_MIN && diff < bestDiff) {
                bestDiff = diff;
                best = SCHOOL_PERIOD_TIMES[i].periodIndex;
            }
        }
        return best;
    }

    // ---------- 周次数组归一化 + 切段（手册 §4.1） ----------
    function normalizeWeeks(arr) {
        var seen = {};
        var out = [];
        var i;
        for (i = 0; i < arr.length; i++) {
            var n = intOf(arr[i]);
            if (n === null || n < 1 || seen[n]) continue;
            seen[n] = true;
            out.push(n);
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    function normalizeSections(arr) {
        var seen = {};
        var out = [];
        var i;
        for (i = 0; i < arr.length; i++) {
            var n = intOf(arr[i]);
            if (n === null || n < 1 || n > MAX_SECTION || seen[n]) continue;
            seen[n] = true;
            out.push(n);
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周。
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

    // ---------- 逐行读数 ----------
    var emptyName = 0;        // 课程名读不出来
    var dayOutOfRange = 0;    // weekDay 不在 1..7
    var noWeeks = 0;          // weeks 数组为空（或全部无效）
    var noSections = 0;       // 既没有 sections，开始时间也匹配不到作息表任何一节
    var customTimeMatched = 0; // 没有 sections，靠开始时间就近匹配到节次
    var weeksClamped = 0;     // 周次段超过 30 周，截断保留
    var weeksDropped = 0;     // 周次段起始周本身超过 30 周，整段丢弃
    var coursesDroppedEmpty = 0; // 因周次全部超出 1-30 周，整门课没有剩下任何有效周次

    var items = [];
    var maxWeekRaw = 0;
    var r;
    for (r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var name = text(row.courseName);
        if (!name) { emptyName++; continue; }

        var day = intOf(row.weekDay);
        if (day === null || day < 1 || day > 7) { dayOutOfRange++; continue; }

        var weeks = normalizeWeeks(row.weeks instanceof Array ? row.weeks : []);
        if (weeks.length === 0) { noWeeks++; continue; }
        if (weeks[weeks.length - 1] > maxWeekRaw) maxWeekRaw = weeks[weeks.length - 1];

        var sections = normalizeSections(row.sections instanceof Array ? row.sections : []);
        var startSection;
        var endSection;
        if (sections.length > 0) {
            startSection = sections[0];
            endSection = sections[sections.length - 1];
        } else {
            var matched = nearestPeriod(row.startTime);
            if (matched === null) { noSections++; continue; }
            startSection = matched;
            endSection = matched;
            customTimeMatched++;
        }

        items.push({
            name: name,
            teacher: text(row.teacherName) || null,
            location: text(row.location) || null,
            day: day,
            startSection: startSection,
            endSection: endSection,
            weeks: weeks
        });
    }

    if (items.length === 0) {
        throw new Error(
            '教务返回的课表数据里没有解析到任何课程：可能是这个学期还没排课，也可能课程行的字段' +
            '（课程名 / 星期 / 周次 / 节次）都读不出来，请反馈'
        );
    }

    // ---------- 分组成课程 + 周次切段成 block ----------
    var courseOrder = [];
    var courseByKey = {};
    var maxPeriod = 0;
    var i;
    for (i = 0; i < items.length; i++) {
        var item = items[i];
        var key = item.name + SEP + (item.teacher || '');
        if (!courseByKey[key]) {
            courseByKey[key] = { name: item.name, teacher: item.teacher, note: null, blocks: [], seen: {} };
            courseOrder.push(key);
        }
        var course = courseByKey[key];
        var runs = runsOf(item.weeks);
        var r2;
        for (r2 = 0; r2 < runs.length; r2++) {
            var run = runs[r2];
            if (run.end > MAX_WEEK) {
                if (run.start > MAX_WEEK) { weeksDropped++; continue; }
                run.end = MAX_WEEK;
                weeksClamped++;
            }
            if (item.endSection > maxPeriod) maxPeriod = item.endSection;
            var blockKey = item.day + '|' + item.startSection + '|' + item.endSection + '|' +
                run.start + '|' + run.end + '|' + run.weekType + '|' + (item.location || '');
            if (course.seen[blockKey]) continue;
            course.seen[blockKey] = true;
            course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.startSection,
                endPeriod: item.endSection,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item.location
            });
        }
    }

    var courses = [];
    for (i = 0; i < courseOrder.length; i++) {
        var built = courseByKey[courseOrder[i]];
        if (built.blocks.length === 0) { coursesDroppedEmpty++; continue; }
        built.blocks.sort(function (a, b) {
            return cmpNum(a.dayOfWeek, b.dayOfWeek) || cmpNum(a.startPeriod, b.startPeriod) ||
                cmpNum(a.endPeriod, b.endPeriod) || cmpNum(a.startWeek, b.startWeek) ||
                cmpNum(a.endWeek, b.endWeek) || cmpStr(a.weekType, b.weekType) ||
                cmpStr(a.location || '', b.location || '');
        });
        courses.push(built);
    }

    if (courses.length === 0) {
        throw new Error(
            '解析到的课程全部因为周次超出 1-30 周被丢弃：如果这不是预期结果，请反馈'
        );
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var hasRecognizedSemester = !!(semesterLabel && semesterLabel.indexOf('学期') >= 0);
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var start = estimateStart(todayIso);

    var totalWeeksCapped = maxWeekRaw > MAX_WEEK;
    var totalWeeks = totalWeeksCapped ? MAX_WEEK : maxWeekRaw;
    if (totalWeeks < 1) totalWeeks = 1; // 理论上到不了这里（items 非空即 maxWeekRaw≥1），兜底避免越界

    // ---------- warnings（顺序固定；上限 20 条 / 每条 200 字） ----------
    var warnings = [];
    function warn(message) {
        var line = String(message);
        if (line.length > MAX_WARNING_CHARS) line = line.substring(0, MAX_WARNING_CHARS - 1) + '…';
        warnings.push(line);
    }

    warn(
        '只导入了教务系统当前选中的学期（' + name0 +
        '）；要导入别的学期，请在「本科实践教学（管理）平台」切换学期后再点「提取课表」'
    );

    if (!hasRecognizedSemester) {
        warn(
            '没有从页面读到规范的学期名称（形如「2026-2027学年第一学期」），已用占位名称「' +
            name0 + '」，请在学期管理里改成实际的学期名'
        );
    }

    warn(
        '教务接口不返回学期起止日期，第 1 周按「' + start.rule + '」推算为 ' + start.iso +
        '，请在学期管理里核对成学校实际开学日'
    );

    warn(
        '学期总周数是适配器按课表里出现的最晚周次（第 ' + maxWeekRaw + ' 周）推算的（教务接口不返回' +
        '学期起止日期）' + (totalWeeksCapped ? '，已按载荷上限 ' + MAX_WEEK + ' 周截断' : '') +
        '，如与实际不符可在学期管理里改'
    );

    warn(
        '作息时间用的是适配器内置的成都信息工程大学 ' + SCHOOL_PERIOD_TIMES.length +
        ' 节作息表（第 1 节 ' + SCHOOL_PERIOD_TIMES[0].start + '-' + SCHOOL_PERIOD_TIMES[0].end +
        '），不是从教务页面读的，请对照教务处公布的作息核对'
    );

    if (customTimeMatched > 0) {
        warn(
            '有 ' + customTimeMatched + ' 门课的原始数据里没有给出节次编号，已按上课开始时间就近匹配到' +
            '作息表的相应节次（差在 1 小时以内），请在导入预览里核对节次'
        );
    }
    if (noSections > 0) {
        warn(
            '有 ' + noSections + ' 门课既没有节次编号、开始时间也匹配不到作息表任何一节，已跳过，请反馈'
        );
    }
    if (dayOutOfRange > 0) {
        warn('有 ' + dayOutOfRange + ' 行课表数据的星期字段超出周一至周日，已跳过');
    }
    if (noWeeks > 0) {
        warn('有 ' + noWeeks + ' 门课的周次数据为空（或全部无效），已跳过，请反馈');
    }
    if (emptyName > 0) {
        warn('有 ' + emptyName + ' 行课表数据没有课程名称，已跳过，请反馈');
    }
    if (weeksClamped > 0) {
        warn('有 ' + weeksClamped + ' 段周次超出 1-' + MAX_WEEK + ' 周，已截断到 ' + MAX_WEEK + ' 周');
    }
    if (weeksDropped > 0) {
        warn(
            '有 ' + weeksDropped + ' 段周次的起始周本身就超过 ' + MAX_WEEK + ' 周，已整段丢弃'
        );
    }
    if (coursesDroppedEmpty > 0) {
        warn(
            '有 ' + coursesDroppedEmpty + ' 门课的全部周次都超出 1-' + MAX_WEEK +
            ' 周，已整门跳过（不是教务没排这门课，是周次数据超出了本适配器能处理的范围），请反馈'
        );
    }
    if (maxPeriod > SCHOOL_PERIOD_TIMES.length) {
        warn(
            '课表里用到第 ' + maxPeriod + ' 节，而内置作息表只到第 ' + SCHOOL_PERIOD_TIMES.length +
            ' 节：超出部分的时间交给应用的内建时间表，请核对作息'
        );
    }

    var finalWarnings = warnings;
    if (warnings.length > MAX_WARNINGS) {
        finalWarnings = warnings.slice(0, MAX_WARNINGS - 1);
        finalWarnings.push(
            '另有 ' + (warnings.length - MAX_WARNINGS + 1) + ' 条说明因为超出上限没有显示，请把这份课表反馈给我们'
        );
    }

    var outCourses = [];
    for (i = 0; i < courses.length; i++) {
        outCourses.push({
            name: courses[i].name,
            teacher: courses[i].teacher,
            note: null,
            blocks: courses[i].blocks
        });
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finalWarnings,
        terms: [
            {
                name: name0,
                firstDay: start.iso,
                totalWeeks: totalWeeks,
                periodTimes: [],
                courses: outCourses
            }
        ]
    });
})()
