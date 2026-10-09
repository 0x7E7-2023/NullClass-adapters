(function () {
    // 西安交通大学教务适配器（金智教育 WIS / jwapp 平台，wdkb 应用）—— 原始数据 → 空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 XJTU/xjtu.js（MIT，上游 maintainer SDPD、TiaoFeng）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：c586957（2026-10-08）
    //
    // 这一段是纯转换（不碰 DOM、不发请求），所以能在 CI 里用 Rhino 跑回归。
    // 「今天」由 extract.js 交进来（data.today），季节与开学日的推算只看它，fixture 因此可以复现。
    //
    // 与上游的语义差异（逐条说明见 AUDIT.md）：
    //   ① 周次：上游是逐周数组，这里切成极大段（ALL / ODD / EVEN）。
    //   ② 教师 / 教室：拿不到就留 null，不写「未知教师」「未知地点」；多名教师以「、」连接、去重，含数字的片段（工号）不算教师。
    //   ③ 教室：JASMC 优先，为空才用校区名（与上游同序）；都没有是 null。
    //   ④ 作息：本校没有可用的节次时间接口（见 extract.js 注释），用内置的两张表；5 月 1 日到 10 月 1 日走夏季、
    //      其余走冬季，按 data.today 的月份选。
    //   ⑤ 总周数：优先用教学周数 ZJXZC，没有才用含考试周的总周数 ZZC（上游同序）。
    //   ⑥ 周次超过 30 的丢弃并计数；总周数超过 30 按 30 导入；都进 warnings。
    //   ⑦ 开学日：校历没有就按「今天所在周的周一」推算，并写进 warnings。
    //   ⑧ 不静默丢课：缺课名、星期、节次、周次的行计入跳过数；教务报的记录总数多于实际取到的行数也写进 warnings。
    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var term = data.term || {};
    var rows = data.rows || [];

    // 载荷校验要求 totalWeeks ∈ 1..30（规范 §4）
    var MAX_WEEKS = 30;

    // 本校作息（教务处公布，11 节，每节 50 分钟）。与上游 XJTU/xjtu.js 的两张表逐字相同。
    // 5 月 1 日到 10 月 1 日走夏季，其余走冬季；按 data.today 的月份在这两张里选（今天由 extract.js 交进来，fixture 因此可复现）。
    var SUMMER_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:50' },
        { periodIndex: 2, start: '09:00', end: '09:50' },
        { periodIndex: 3, start: '10:10', end: '11:00' },
        { periodIndex: 4, start: '11:10', end: '12:00' },
        { periodIndex: 5, start: '14:30', end: '15:20' },
        { periodIndex: 6, start: '15:30', end: '16:20' },
        { periodIndex: 7, start: '16:40', end: '17:30' },
        { periodIndex: 8, start: '17:40', end: '18:30' },
        { periodIndex: 9, start: '19:40', end: '20:30' },
        { periodIndex: 10, start: '20:40', end: '21:30' },
        { periodIndex: 11, start: '21:40', end: '22:30' }
    ];
    var WINTER_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:50' },
        { periodIndex: 2, start: '09:00', end: '09:50' },
        { periodIndex: 3, start: '10:10', end: '11:00' },
        { periodIndex: 4, start: '11:10', end: '12:00' },
        { periodIndex: 5, start: '14:00', end: '14:50' },
        { periodIndex: 6, start: '15:00', end: '15:50' },
        { periodIndex: 7, start: '16:10', end: '17:00' },
        { periodIndex: 8, start: '17:10', end: '18:00' },
        { periodIndex: 9, start: '19:10', end: '20:00' },
        { periodIndex: 10, start: '20:10', end: '21:00' },
        { periodIndex: 11, start: '21:10', end: '22:00' }
    ];

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

    // 日期前缀 yyyy-MM-dd（后面允许跟时间，如 '2026-09-07 00:00:00'）→ 'yyyy-MM-dd'；形状不对返回 null
    function isoDayOf(value) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
        return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
    }

    // data.today 的月份（1~12）；不是 yyyy-MM-dd 就返回 null，季节回落一律按冬季处理
    function monthOfIso(value) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[2], 10);
        return (month >= 1 && month <= 12) ? month : null;
    }

    // 'yyyy-MM-dd' → 该日期所在周的周一（周一原样返回）。
    // 非法日期（如 2026-02-31）返回 null，不悄悄顺延到下个月。
    function mondayOnOrBefore(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
            return null;
        }
        var offset = (date.getUTCDay() + 6) % 7;
        var monday = new Date(date.getTime() - offset * 86400000);
        return monday.getUTCFullYear() + '-' + pad2(monday.getUTCMonth() + 1) + '-' + pad2(monday.getUTCDate());
    }

    // SKZC 位串：第 i 位（从 0 起）为 1 表示第 i+1 周。不是位串就返回空数组。
    function weeksFromBits(bits) {
        var weeks = [];
        if (!/^[01]+$/.test(bits)) return weeks;
        for (var i = 0; i < bits.length; i++) {
            if (bits.charAt(i) === '1') weeks.push(i + 1);
        }
        return weeks;
    }

    // 升序周次集合 → 极大段。步长 1 是每周（ALL）；步长 2 是单周或双周（ODD / EVEN，由起始周奇偶决定）；落单的一周记为 ALL。
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

    // 学期编号 2026-2027-1 → 「2026-2027学年第一学期」；3 是本校的夏季小学期；形状不对返回 ''
    function termNameFrom(code) {
        var m = /^(\d{4})-(\d{4})-(\d{1,2})$/.exec(String(code));
        if (!m) return '';
        var index = parseInt(m[3], 10);
        var label = index === 1 ? '第一学期' : (index === 2 ? '第二学期' : (index === 3 ? '夏季小学期' : '第' + index + '学期'));
        return m[1] + '-' + m[2] + '学年' + label;
    }

    // 校历：按学期编号拆出 XN、XQ，找对得上的那一行；找不到返回 null，按没有校历处理
    function findCalendarRow(rows, code) {
        var parts = code.split('-');
        if (parts.length < 3) return null;
        for (var i = 0; i < rows.length; i++) {
            if (text(rows[i].XN) === parts[0] + '-' + parts[1] && intOf(rows[i].XQ) === intOf(parts[2])) return rows[i];
        }
        return null;
    }

    // 教师：多名用 / 、, ， ; ； 分隔的，拆开后丢掉空片段与含数字的片段（教务常写成「姓名/工号」，工号不是教师），去重后以「、」连接；拿不到就是 null
    function teacherOf(raw) {
        var names = [];
        text(raw).split(/[\/、,，;；]/).forEach(function (part) {
            var name = text(part);
            if (!name || /\d/.test(name)) return;
            if (names.indexOf(name) < 0) names.push(name);
        });
        return names.length ? names.join('、') : null;
    }

    // 教室：JASMC 优先，为空才退到校区名；都没有是 null
    function locationOf(row) {
        var room = text(row.JASMC);
        if (room) return room;
        var campus = text(row.XXXQDM_DISPLAY);
        return campus || null;
    }

    // ---- 作息 ----------------------------------------------------------------

    // 上游两张表按季节分：5~9 月是夏季，其余是冬季（冬季作息也用于 data.today 不可用的情况）
    var todayMonth = monthOfIso(data.today);
    var isSummer = todayMonth !== null && todayMonth >= 5 && todayMonth <= 9;
    var periodTimes = isSummer ? SUMMER_PERIOD_TIMES : WINTER_PERIOD_TIMES;

    // ---- 逐行转换 ------------------------------------------------------------

    var order = [];
    var byCourse = {};
    var maxWeek = 0;
    var maxBits = 0;
    var skipped = 0;
    var droppedWeeks = 0;
    var outOfTable = 0;

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var name = text(row.KCM);
        var day = intOf(row.SKXQ);
        var startPeriod = intOf(row.KSJC);
        var endPeriod = intOf(row.JSJC);
        var bits = text(row.SKZC);

        // 课名、星期、周次都空的占位行不是「被丢掉的课」，不计入跳过数
        if (!name && !bits && !text(row.SKXQ)) continue;

        // 位串长度就是教务眼里的学期周数（金智位图口径；本件的上游不用长度，见 AUDIT §7），只在它确实是位串时才算
        if (/^[01]+$/.test(bits) && bits.length > maxBits) maxBits = bits.length;

        var rawWeeks = weeksFromBits(bits);
        if (!name || !(day >= 1 && day <= 7) || !(startPeriod >= 1) ||
            !(endPeriod >= startPeriod) || !rawWeeks.length) {
            skipped++;
            continue;
        }

        var weeks = [];
        for (var w = 0; w < rawWeeks.length; w++) {
            if (rawWeeks[w] <= MAX_WEEKS) weeks.push(rawWeeks[w]);
            else droppedWeeks++;
        }
        if (!weeks.length) continue;

        if (endPeriod > periodTimes.length) outOfTable++;

        var teacher = teacherOf(row.SKJS);
        var location = locationOf(row);
        var key = JSON.stringify([name, teacher || '']);
        if (!byCourse[key]) {
            byCourse[key] = { name: name, teacher: teacher, note: null, blocks: [] };
            order.push(key);
        }

        var runs = runsOf(weeks);
        for (var r = 0; r < runs.length; r++) {
            if (runs[r].end > maxWeek) maxWeek = runs[r].end;
            byCourse[key].blocks.push({
                dayOfWeek: day,
                startPeriod: startPeriod,
                endPeriod: endPeriod,
                startWeek: runs[r].start,
                endWeek: runs[r].end,
                weekType: runs[r].weekType,
                location: location
            });
        }
    }

    if (order.length === 0) {
        throw new Error('没有解析到任何课程' + (droppedWeeks > 0
            ? '：课表里的周次都超过了第 ' + MAX_WEEKS + ' 周（应用最多支持 ' + MAX_WEEKS + ' 周）'
            : '：请在教务页面确认课表已经显示出来，再重新提取'));
    }

    // ---- 学期与开学日 --------------------------------------------------------

    var code = text(term.code);
    var termWarning = text(term.source) === 'guess'
        ? '没能从教务获取当前学期，已按本机日期推算为 ' + (termNameFrom(code) || code) + '，请核对导入的是不是本学期'
        : null;

    var calendarRow = findCalendarRow(data.calendarRows || [], code);
    var firstDay = mondayOnOrBefore(isoDayOf(calendarRow && calendarRow.XQKSRQ));
    var firstDayWarning = null;
    if (!firstDay) {
        firstDay = mondayOnOrBefore(text(data.today));
        if (!firstDay) throw new Error('没能确定开学日期：教务没有给出，本机日期也不合法');
        firstDayWarning = '没能从教务取到开学日期，已按本机日期推算为 ' + firstDay + '（当前周的周一），请在学期管理里核对';
    }

    // ---- 总周数 --------------------------------------------------------------

    // 教学周数 ZJXZC 优先；没有才用含考试周的总周数 ZZC（上游同序）。两者都没有就按课表推算。
    var calendarWeeks = null;
    if (calendarRow) {
        var teachingWeeks = intOf(calendarRow.ZJXZC);
        calendarWeeks = (teachingWeeks !== null && teachingWeeks >= 1) ? teachingWeeks : intOf(calendarRow.ZZC);
    }
    var guessedWeeks = calendarWeeks === null || calendarWeeks < 1;
    var rawTotal = guessedWeeks ? (maxBits > 0 ? maxBits : maxWeek) : calendarWeeks;
    var totalWeeks = rawTotal;
    if (totalWeeks > MAX_WEEKS) totalWeeks = MAX_WEEKS;
    var belowMaxWeek = totalWeeks < maxWeek;
    if (belowMaxWeek) totalWeeks = maxWeek;

    var totalGuessWarning = guessedWeeks
        ? '没能从教务取到总周数，已按课表推算为 ' + rawTotal + ' 周，请核对'
        : null;
    var clampWarning = rawTotal > MAX_WEEKS
        ? '总周数 ' + rawTotal + ' 周超过了 ' + MAX_WEEKS + ' 周，已按 ' + MAX_WEEKS + ' 周导入，请核对'
        : null;
    // 只在教务确实给了总周数时才说「教务给的」，且打印教务的原值（totalWeeks 已经被抬高，不能用）；推算的总周数不提这句
    var belowWarning = belowMaxWeek && !guessedWeeks
        ? '教务给的学期总周数是 ' + calendarWeeks + ' 周，课表里有第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks + ' 周导入，请在学期管理里核对'
        : null;

    // 记录总数对账：教务报了总数却只取到更少的行，课表可能不完整
    var rowTotal = intOf(data.rowTotal);
    var rowTotalWarning = rowTotal !== null && rowTotal > rows.length
        ? '教务系统说这个学期有 ' + rowTotal + ' 条排课记录，实际只取到 ' + rows.length + ' 条，课表可能不完整，请重新提取或反馈'
        : null;

    // ---- warnings（顺序固定：学期、开学日、总周数、记录总数、节次超表、跳过、周次丢弃）----

    var warnings = [];
    [
        termWarning,
        firstDayWarning,
        totalGuessWarning,
        clampWarning,
        belowWarning,
        rowTotalWarning,
        outOfTable > 0
            ? '有 ' + outOfTable + ' 条排课的节次超出了作息表（共 ' + periodTimes.length + ' 节），已保留，请核对上课时间'
            : null,
        skipped > 0
            ? '有 ' + skipped + ' 条排课记录缺少课名、星期、节次或周次，没有导入'
            : null,
        droppedWeeks > 0
            ? '有 ' + droppedWeeks + ' 个周次超过了第 ' + MAX_WEEKS + ' 周，超出的部分没有导入'
            : null
    ].forEach(function (message) {
        if (message) warnings.push(message);
    });

    var courses = [];
    for (var c = 0; c < order.length; c++) courses.push(byCourse[order[c]]);

    var termLabel = termNameFrom(code);
    var termName = text(term.name) || (termLabel ? '西安交通大学 ' + termLabel : '西安交通大学');

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
