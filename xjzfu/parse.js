(function () {
    // 新疆政法学院教务适配器（金智教育 jwapp / homeapp 平台）—— 原始数据 → 空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 XJZFU/xjzfu.js（MIT，上游作者 jesse-s4）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：main @ ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    //
    // 这一段是纯转换（不碰 DOM、不发请求、不弹窗），所以能在 CI 里用 Rhino 跑回归。
    //
    // 移植改动（与上游的语义差异，逐条列在这里）：
    //   ① 周次：上游只认 week 位串（下标 i = 第 i+1 周）。这里同样以位串为准；位串缺失、不是 0/1 串，或全是 0（一周都没选）时，
    //      才退回 weeksAndTeachers 里「/」前面的周次文字（如「1-16周」）。文字也认不出就进 warnings，不静默丢课。
    //   ② 教师：上游取 weeksAndTeachers 里带「[主讲]」的名字，按 ; 与 / 切开、去重后用「、」连接。这里照做；
    //      拿不到就留 null，不写「未知」「待定」。
    //   ③ 教室：上游用 placeName。这里照做，拿不到留 null。
    //   ④ 作息表：上游把 11 节的新疆作息（10:00 起）写死在脚本里。这里照抄成常量，并且只写到课表实际用到的
    //      最大节次（上游口径）。课表用到第 12 节以上时不写 periodTimes，应用补默认节次表，并进 warnings。
    //   ⑤ 开学日：上游直接取学期周次接口第一项的 startDate。这里照旧取，但按移植手册 §4.3 回退到当周周一
    //      （firstDayOfWeek = 1）；拿不到则按最近的周一推算，并进 warnings。
    //   ⑥ 总周数：上游取学期周次接口的项数。这里照做；超过 30 的截到 30 并进 warnings；取不到则按课表里的
    //      位串长度推算（没有任何含 1 的位串时才用最大周次），并进 warnings；课表周次超过总周数时，总周数抬到最大周次，同样进 warnings。
    //   ⑦ 学期：上游让用户手选。这里用教务标出的当前学期（selected）；没有标出时取列表第一项，并进 warnings。
    //      学期名用教务的 itemName，拿不到用「新疆政法学院 + 学年学期」。
    //   ⑧ 上游把课程、时间段、学期配置分三次推给宿主，这里合成一个课表载荷。认不出的周次片段、
    //      超出 30 周的周次、缺字段的排课都进 warnings，不静默丢。
    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var rows = Object.prototype.toString.call(data.rows) === '[object Array]' ? data.rows : [];
    var term = data.term || {};

    // 载荷校验要求 totalWeeks 落在 1..30（规范 §4）
    var MAX_WEEKS = 30;
    var FALLBACK_WEEKS = 20;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;
    var SCHOOL_NAME = '新疆政法学院';

    // 上游 generateTimeSlots 里的 standardSchedule，逐节照抄。
    var STANDARD_PERIODS = [
        { periodIndex: 1, start: '10:00', end: '10:45' },
        { periodIndex: 2, start: '10:50', end: '11:35' },
        { periodIndex: 3, start: '11:50', end: '12:35' },
        { periodIndex: 4, start: '12:40', end: '13:25' },
        { periodIndex: 5, start: '13:30', end: '14:15' },
        { periodIndex: 6, start: '16:00', end: '16:45' },
        { periodIndex: 7, start: '16:50', end: '17:35' },
        { periodIndex: 8, start: '17:50', end: '18:35' },
        { periodIndex: 9, start: '18:40', end: '19:25' },
        { periodIndex: 10, start: '20:30', end: '21:15' },
        { periodIndex: 11, start: '21:20', end: '22:05' }
    ];

    // 复合键的分隔符：用 fromCharCode 拼出来，源码里不出现转义序列 ——
    // 反斜杠 + u0000 那种写法会被某些编辑器落成**真的 NUL 字节**，让整个文件变成二进制
    // （移植手册 §3 第 2 步）。运行时值不变。
    var KEY_SEP = String.fromCharCode(0);

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

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    // 校验：任何写进 periodTimes 的时间必须是 HH:mm 且落在 00:00–23:59。
    // 24:00 / 85:45 这类会让**整个载荷被拒**（不是跳过一节），所以宁可不要这一节。
    function hhmm(value) {
        var match = /^([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?$/.exec(text(value));
        if (!match) return null;
        var h = parseInt(match[1], 10);
        var mi = parseInt(match[2], 10);
        if (h > 23 || mi > 59) return null;
        return pad2(h) + ':' + pad2(mi);
    }

    // 'yyyy-MM-dd' → 该日期所在周的周一（含当天）。移植手册 §4.3：我们数周次前先把
    // 开学日回退到 firstDayOfWeek（缺省 1 = 周一）那天，直接拿开学日当第 1 周会把
    // 整学期的课偏几天。
    function mondayOnOrBefore(iso) {
        var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
        if (!match) return null;
        var year = parseInt(match[1], 10);
        var month = parseInt(match[2], 10);
        var day = parseInt(match[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (isNaN(date.getTime())) return null;
        // 非法日期（如 2026-02-31）会被 Date 归一化成下个月，拒绝而不是悄悄顺延
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
            return null;
        }
        var offset = (date.getUTCDay() + 6) % 7;
        var monday = new Date(date.getTime() - offset * 86400000);
        return monday.getUTCFullYear() + '-' + pad2(monday.getUTCMonth() + 1) + '-' + pad2(monday.getUTCDate());
    }

    // 校历取不到（extract 交出的 firstDay 为 null，或日期认不出）时走这里：取导入当天所在周的周一。
    // 这是正常路径，不是输入被改坏；同时会进「开学日期无法从教务获取，已按最近的周一推算」那条提醒。
    // 它也保证载荷永远合法（firstDay 是必填项）。
    function currentMondayIso() {
        var now = new Date();
        var offset = (now.getDay() + 6) % 7;
        var monday = new Date(now.getTime() - offset * 86400000);
        return monday.getFullYear() + '-' + pad2(monday.getMonth() + 1) + '-' + pad2(monday.getDate());
    }

    // item.week 是「第 i 位 = 第 i+1 周」的位串（上游 XJZFU 读的就是它）。不是位串就返回空数组。
    function weeksFromBits(bits) {
        var weeks = [];
        if (!/^[01]+$/.test(bits)) return weeks;
        for (var i = 0; i < bits.length; i++) {
            if (bits.charAt(i) === '1') weeks.push(i + 1);
        }
        return weeks;
    }

    function uniqueSorted(weeks) {
        var seen = {};
        var out = [];
        for (var i = 0; i < weeks.length; i++) {
            var w = weeks[i];
            if (w >= 1 && !seen[w]) {
                seen[w] = true;
                out.push(w);
            }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    // 单个周次片段 → 周次数组。四种写法都要认：
    //   「1-16周(单)」（标记在「周」后）、「(单)1-16周」（标记在前）、
    //   「1-16(单周)」（标记在括号里）、「1-3,5-9周」（混排，逗号在上一层切）
    // 外加「1-16周」「6周」「第1-8周」「1至16周」这些同义写法。
    // **括号里的纯数字/数字区间不是周次**（检查表第 2 条）：那是教学班序号，
    // 必须在拼周次数字**之前整组删掉** —— 只删括号符号会把它粘进周次数字里
    // （「(1)1-16周」粘成 11-16、「1-16周(1)」粘成 1-161），拼完再删更救不回来。
    // 认不出的片段记进 notes.bad（**不静默丢**），返回空数组。
    function weeksFromSegment(seg, notes) {
        var raw = text(seg);
        if (!raw) return [];
        var s = raw.replace(/第/g, '');
        var odd = s.indexOf('单') >= 0;
        var even = s.indexOf('双') >= 0;
        var withoutIndex = s.replace(/[（(][ ]*[0-9]+([ ]*[-–—~至][ ]*[0-9]+)?[ ]*[）)]/g, ' ');
        var body = withoutIndex.replace(/[（）()]/g, '')
            .replace(/周/g, '')
            .replace(/[单双]/g, '')
            .replace(/[–—~至]/g, '-')
            .replace(/\s/g, '');
        if (!/^[0-9-]+$/.test(body)) {
            notes.bad.push(raw);
            return [];
        }
        var range = /^([0-9]+)-([0-9]+)$/.exec(body);
        if (range) {
            var from = parseInt(range[1], 10);
            var to = parseInt(range[2], 10);
            var out = [];
            for (var i = from; i <= to; i++) {
                if (odd && i % 2 === 0) continue;
                if (even && i % 2 === 1) continue;
                out.push(i);
            }
            // 「1-1周(双)」这种：区间合法但被单双标记筛空了，记一笔
            if (!out.length) notes.bad.push(raw);
            return out;
        }
        var single = /^([0-9]+)$/.exec(body);
        if (!single) {
            notes.bad.push(raw);
            return [];
        }
        var n = parseInt(single[1], 10);
        // 「3周(双)」这类单双标记与明写周次矛盾的：周次是明写的，保留它（丢掉等于
        // 凭空少上一节课），但要留痕。
        if ((odd && n % 2 === 0) || (even && n % 2 === 1)) notes.conflict.push(raw);
        return [n];
    }

    function weeksFromText(source, notes) {
        var parts = text(source).split(/[,，、;；/]/);
        var weeks = [];
        for (var i = 0; i < parts.length; i++) {
            weeks = weeks.concat(weeksFromSegment(parts[i], notes));
        }
        return uniqueSorted(weeks);
    }

    // 周次集合（升序去重）→ 极大段。步长 1 视作每周，步长 2 视作单/双周，落单的一周
    // 单独成段（见移植手册 §4.1 的表）。一个片段因此可能产出多个 block。
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

    // 学期编号形如 2026-2027-1 → 「2026-2027学年第一学期」。
    // 教务给了学期名（kb/xnxq 的 itemName）就用教务的 —— 别拿适配器名当学期名。
    function termNameFrom(code) {
        var match = /^(\d{4})-(\d{4})-(\d{1,2})$/.exec(String(code));
        if (!match) return '';
        var index = parseInt(match[3], 10);
        var label = '第' + index + '学期';
        if (index === 1) label = '第一学期';
        else if (index === 2) label = '第二学期';
        else if (index === 3) label = '第三学期';
        return match[1] + '-' + match[2] + '学年' + label;
    }

    function clip(value) {
        var s = String(value);
        return s.length > MAX_WARNING_CHARS ? s.substring(0, MAX_WARNING_CHARS - 3) + '...' : s;
    }

    function sampleOf(list, limit) {
        var shown = [];
        for (var i = 0; i < list.length && i < limit; i++) shown.push(list[i]);
        var s = shown.join('、');
        if (list.length > limit) s += ' 等 ' + list.length + ' 处';
        return s;
    }

    var warnings = [];
    var notes = { bad: [], conflict: [] };

    var order = [];
    var byCourse = {};
    var maxWeek = 0;
    var maxBits = 0;
    var skipped = 0;
    var droppedWeeks = 0;
    var maxEndPeriod = 0;

    // 超出 30 周（载荷上限）的周次丢在这里，丢了多少条会进 warnings
    function clampWeeks(weeks) {
        var kept = [];
        for (var i = 0; i < weeks.length; i++) {
            if (weeks[i] <= MAX_WEEKS) kept.push(weeks[i]);
            else droppedWeeks++;
        }
        return kept;
    }

    // 教师 = weeksAndTeachers 里带「[主讲]」的名字（上游 parseTeacher 同口径：按 ; 与 / 切开、去重、用「、」连接）。
    // 辅讲、只有周次的段一律不取。拿不到返回 null。
    function teacherOf(str) {
        var names = [];
        var seen = {};
        var parts = text(str).split(';');
        for (var p = 0; p < parts.length; p++) {
            var sections = parts[p].split('/');
            for (var q = 0; q < sections.length; q++) {
                var match = /([^[\]]+)\[主讲\]/.exec(sections[q]);
                if (!match) continue;
                var teacherName = text(match[1]);
                if (teacherName && !seen[teacherName]) {
                    seen[teacherName] = true;
                    names.push(teacherName);
                }
            }
        }
        return names.length ? names.join('、') : null;
    }

    // 周次文字 = weeksAndTeachers 里「/」前面那一段。带教师标记或没有数字的不是周次，返回空串。
    function weekTextOf(str) {
        var head = text(str).split('/')[0];
        if (head.indexOf('[') >= 0 || !/[0-9]/.test(head)) return '';
        return head;
    }

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i] || {};
        var name = text(row.courseName);
        var day = intOf(row.dayOfWeek);
        var startPeriod = intOf(row.beginSection);
        var endPeriod = intOf(row.endSection);
        var bits = text(row.week);
        var bitWeeks = weeksFromBits(bits);
        var weeksAndTeachers = text(row.weeksAndTeachers);

        // 位串长度就是教务眼里的学期周数（同平台口径），只在它是含 1 的位串时才算
        if (bitWeeks.length && bits.length > maxBits) maxBits = bits.length;

        // 完全空白的占位行（课名 / 星期 / 教师周次 / 位串都没有）不是「被丢掉的课」
        if (!name && !day && !weeksAndTeachers && !bitWeeks.length) continue;

        var weeks = clampWeeks(bitWeeks);
        // 位串缺失、不是位串，或全为 0（bitWeeks 为空）时退回周次文字；文字里认不出的片段进 warnings
        if (!bitWeeks.length) {
            var localNotes = { bad: [], conflict: [] };
            weeks = clampWeeks(weeksFromText(weekTextOf(weeksAndTeachers), localNotes));
            notes.bad = notes.bad.concat(localNotes.bad);
            notes.conflict = notes.conflict.concat(localNotes.conflict);
        }

        var teacher = teacherOf(weeksAndTeachers);
        var location = text(row.placeName) || null;

        // 课名是载荷的必填项（规范 §4）：空课名的记录必须挡在这里 ——
        // 放进去会让**整个载荷**被校验拒绝（不是跳过这一门）。
        if (!name || !(day >= 1 && day <= 7) || !(startPeriod >= 1) || !(endPeriod >= startPeriod) || !weeks.length) {
            skipped++;
            continue;
        }
        if (endPeriod > maxEndPeriod) maxEndPeriod = endPeriod;

        var key = name + KEY_SEP + (teacher || '');
        if (!byCourse[key]) {
            byCourse[key] = { name: name, teacher: teacher, note: null, blocks: [] };
            order.push(key);
        }

        var runs = runsOf(weeks);
        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            if (run.end > maxWeek) maxWeek = run.end;
            byCourse[key].blocks.push({
                dayOfWeek: day,
                startPeriod: startPeriod,
                endPeriod: endPeriod,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: location
            });
        }
    }

    var termCode = text(term.code);
    if (order.length === 0) {
        // 有课但全被周次上限挡掉时，别把原因说成「教务改了格式」
        var hint = droppedWeeks > 0
            ? '：课表里的周次都超过了 ' + MAX_WEEKS + ' 周（课表数据的上限），放不进空课'
            : '：可能是还没排课，或教务系统改了课表的数据格式。请在教务页面里确认课表已经显示出来再重试';
        throw new Error('没解析到任何课程' + (termCode ? '（学期编号 ' + termCode + '）' : '') + hint);
    }

    // ---- 作息时间 ------------------------------------------------------------
    // 只写到课表用到的最大节次（上游口径）。课表用到的节次超出标准作息表时整张表都不写：
    // 应用会补默认节次表，绝不写一份只覆盖一部分、或对不上课表的作息。
    var periodTimes = [];
    var periodNote = null;
    if (maxEndPeriod > STANDARD_PERIODS.length) {
        periodNote = '课表里有第 ' + maxEndPeriod + ' 节，超出了学校作息表的 ' + STANDARD_PERIODS.length +
            ' 节，节次时间没有写入，已用空课的默认节次时间，请在学期管理里核对';
    } else {
        for (var k = 0; k < STANDARD_PERIODS.length && STANDARD_PERIODS[k].periodIndex <= maxEndPeriod; k++) {
            var slot = STANDARD_PERIODS[k];
            var start = hhmm(slot.start);
            var end = hhmm(slot.end);
            if (start && end && start < end) {
                periodTimes.push({ periodIndex: slot.periodIndex, start: start, end: end });
            }
        }
    }

    // ---- 学期元信息 ----------------------------------------------------------
    var termSource = text(term.source);
    if (termSource === 'guess') {
        warnings.push('学期编号 ' + termCode + ' 是按本机日期推算的（没能从教务获取），请核对导入的是不是本学期');
    } else if (termSource === 'api-first') {
        warnings.push('教务没有标出当前学期，已按学期列表第一项（' + (text(term.name) || termCode) +
            '）导入，请核对导入的是不是本学期');
    }
    if (periodNote) warnings.push(periodNote);

    var firstDay = mondayOnOrBefore(term.firstDay);
    var firstDayGuessed = !firstDay || text(term.firstDaySource) === 'guess';
    if (!firstDay) firstDay = mondayOnOrBefore(currentMondayIso());
    if (firstDayGuessed) {
        warnings.push('开学日期无法从教务获取，已按最近的周一推算，请在学期管理里核对');
    }

    // 教务给的学期总周数（学期周次接口的项数）。小于 1 当作没给；超过 30 截到 30 并说明。
    var calendarWeeks = intOf(term.totalWeeks);
    if (calendarWeeks !== null && calendarWeeks < 1) calendarWeeks = null;
    if (calendarWeeks !== null && calendarWeeks > MAX_WEEKS) {
        warnings.push('教务给的学期总周数是 ' + calendarWeeks + ' 周，超过了 ' + MAX_WEEKS + ' 周的上限，已按 ' +
            MAX_WEEKS + ' 周导入，请核对');
        calendarWeeks = MAX_WEEKS;
    }

    var totalWeeks = calendarWeeks;
    if (totalWeeks === null) totalWeeks = maxBits > 0 ? maxBits : maxWeek;
    if (!(totalWeeks >= 1)) totalWeeks = FALLBACK_WEEKS;
    if (totalWeeks < maxWeek) totalWeeks = maxWeek;
    if (totalWeeks > MAX_WEEKS) totalWeeks = MAX_WEEKS;
    if (calendarWeeks === null) {
        warnings.push('学期总周数无法从教务获取，已按课表的周次推算为 ' + totalWeeks + ' 周，请核对');
    }

    if (droppedWeeks > 0) {
        warnings.push('有 ' + droppedWeeks + ' 个周次超出 ' + MAX_WEEKS + ' 周（课表数据的上限），没有导入');
    }
    if (skipped > 0) {
        warnings.push('有 ' + skipped + ' 条排课记录缺少课名、星期、节次或周次，没有导入');
    }
    if (notes.bad.length) {
        warnings.push('有 ' + notes.bad.length + ' 段周次认不出来（' + sampleOf(notes.bad, 3) + '），相关排课没有导入');
    }
    if (notes.conflict.length) {
        warnings.push('有 ' + notes.conflict.length + ' 段周次的单双周标记与周次本身矛盾（' + sampleOf(notes.conflict, 3) +
            '），已按该周次本身导入，请核对');
    }
    if (calendarWeeks !== null && maxWeek > calendarWeeks) {
        warnings.push('教务给的学期总周数是 ' + calendarWeeks + ' 周，但课表里有第 ' + maxWeek +
            ' 周的课，已按 ' + totalWeeks + ' 周导入，请核对');
    }

    var clipped = [];
    for (var w = 0; w < warnings.length && w < MAX_WARNINGS; w++) clipped.push(clip(warnings[w]));

    var courses = [];
    for (var c = 0; c < order.length; c++) courses.push(byCourse[order[c]]);

    // 学期名：教务给的 itemName 优先；拿不到用「学校名 + 学年学期」，不用适配器名
    var termName = text(term.name) || (SCHOOL_NAME + ' ' + (termNameFrom(termCode) || '教务导入'));

    // periodTimes 缺省时应用会补默认节次表（规范 §4），所以拿不到就整个字段不写
    var termPayload = { name: termName, firstDay: firstDay, totalWeeks: totalWeeks };
    if (periodTimes.length) termPayload.periodTimes = periodTimes;
    termPayload.courses = courses;

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: clipped,
        terms: [termPayload]
    });
})()

