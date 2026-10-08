(function () {
    // 南京信息工程大学教务适配器（金智教育 WIS / jwapp 平台）—— 原始数据 → 空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 NUIST/nuist.js（MIT，上游作者 wild0408）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：ff72d1f（2026-10-08）
    //
    // 这一段是纯转换（不碰 DOM、不发请求、不读挂钟时间），所以能在 CI 里用 Rhino 跑回归。
    // 「今天」由 extract.js 交进来（data.today），开学日的推算只看它，fixture 因此可以复现。
    //
    // 与上游的语义差异（逐条说明见 AUDIT.md）：
    //   ① 周次：上游是逐周列表，这里切成极大段（ALL / ODD / EVEN）。
    //   ② 教师 / 教室：拿不到就留 null，不写「未知」「待定」；多名教师以「、」连接、去重，含数字的片段（工号）不算教师。
    //   ③ 节次时间：优先用教务 jc.do 给的作息；任一行不合法就整表回落本校 12 节，并写进 warnings。
    //   ④ 周次超过 30 的丢弃并计数；总周数超过 30 按 30 导入；都进 warnings。
    //   ⑤ 开学日：校历没有就按「今天所在周的周一」推算，并写进 warnings。
    //   ⑥ 不静默丢课：缺课名、星期、节次、周次的行计入跳过数并写进 warnings。
    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var rows = data.rows || [];
    var term = data.term || {};

    // 载荷校验要求 totalWeeks ∈ 1..30（规范 §4）
    var MAX_WEEKS = 30;

    // 本校作息（12 节），jc.do 取不到或不合法时回落到这里。
    // 上游注释称「已由接口确认」，我们没有实际接口数据可以核对，见 AUDIT.md。
    var DEFAULT_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '13:45', end: '14:30' },
        { periodIndex: 6, start: '14:40', end: '15:25' },
        { periodIndex: 7, start: '15:55', end: '16:40' },
        { periodIndex: 8, start: '16:50', end: '17:35' },
        { periodIndex: 9, start: '18:45', end: '19:30' },
        { periodIndex: 10, start: '19:40', end: '20:25' },
        { periodIndex: 11, start: '20:35', end: '21:20' },
        { periodIndex: 12, start: '21:25', end: '22:00' }
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

    // 日期前缀 yyyy-MM-dd（后面允许跟时间，如 '2026-02-25 00:00:00'）→ 'yyyy-MM-dd'；形状不对返回 null
    function isoDayOf(value) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
        return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
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

    // 学期编号 2026-2027-1 → 「2026-2027学年第一学期」；形状不对返回 ''
    function termNameFrom(code) {
        var m = /^(\d{4})-(\d{4})-(\d{1,2})$/.exec(String(code));
        if (!m) return '';
        var index = parseInt(m[3], 10);
        var label = index === 1 ? '第一学期' : (index === 2 ? '第二学期' : '第' + index + '学期');
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

    // 教师：多名用 / 、, ， ; ； 分隔的，拆开后丢掉空片段与含数字的片段（教务 SKJS 常写成「姓名/工号」，工号不是教师），去重后以「、」连接；拿不到就是 null
    function teacherOf(raw) {
        var names = [];
        text(raw).split(/[\/、,，;；]/).forEach(function (part) {
            var name = text(part);
            if (!name || /\d/.test(name)) return;
            if (names.indexOf(name) < 0) names.push(name);
        });
        return names.length ? names.join('、') : null;
    }

    // 教室：「教室（校区）」；只有校区就用校区名；都没有是 null
    function locationOf(row) {
        var room = text(row.JASMC);
        var campus = text(row.XXXQDM_DISPLAY);
        if (room && campus) return room + '（' + campus + '）';
        return room || campus || null;
    }

    // 节次时间：接受 0800 与 08:00 两种写法，统一成 HH:mm；不合法返回 null
    function normTime(raw) {
        var m = /^(\d{1,2}):?(\d{2})$/.exec(text(raw));
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var min = parseInt(m[2], 10);
        if (h > 23 || min > 59) return null;
        return pad2(h) + ':' + pad2(min);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
    }

    // 教务节次表校验。返回 null 表示没有给出节次（空表）；返回 false 表示有行不合法；返回数组表示可用。
    // 合法的条件：节次号从 1 起连续、每节的时间是合法 HH:mm、结束晚于开始。
    function periodTimesFrom(slotRows) {
        if (!slotRows.length) return null;
        var slots = [];
        for (var i = 0; i < slotRows.length; i++) {
            var n = intOf(slotRows[i].DM);
            var start = normTime(slotRows[i].KSSJ);
            var end = normTime(slotRows[i].JSSJ);
            if (!(n >= 1) || !start || !end || minutesOf(end) <= minutesOf(start)) return false;
            slots.push({ periodIndex: n, start: start, end: end });
        }
        slots.sort(function (a, b) {
            return a.periodIndex - b.periodIndex;
        });
        for (var k = 0; k < slots.length; k++) {
            if (slots[k].periodIndex !== k + 1) return false;
        }
        return slots;
    }

    // ---- 作息 ----------------------------------------------------------------

    var periodTimes = periodTimesFrom(data.timeSlotRows || []);
    var timeWarning = null;
    if (periodTimes === null) {
        periodTimes = DEFAULT_PERIOD_TIMES;
        timeWarning = '没能从教务取到节次时间，已按本校 12 节的内置作息导入，请核对上课时间';
    } else if (periodTimes === false) {
        periodTimes = DEFAULT_PERIOD_TIMES;
        timeWarning = '教务给的节次时间有不合法的地方（格式不对、结束不晚于开始，或节次号不连续），已整表改用本校 12 节的内置作息，请核对上课时间';
    }

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

        // 位串长度就是教务眼里的学期周数（上游口径），只在它确实是位串时才算
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

    var calendarWeeks = calendarRow ? intOf(calendarRow.ZZC) : null;
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

    // ---- warnings（顺序固定：学期、开学日、总周数、节次、节次超表、跳过、周次丢弃）----

    var warnings = [];
    [
        termWarning,
        firstDayWarning,
        totalGuessWarning,
        clampWarning,
        belowWarning,
        timeWarning,
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
    var termName = text(term.name) || (termLabel ? '南京信息工程大学 ' + termLabel : '南京信息工程大学');

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
