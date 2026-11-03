(function () {
    // 中山大学（本科）教务适配器 —— 第二步：教务原始数据 → 空课课表载荷。纯函数，CI 用 Rhino 实跑，不碰页面、不发请求。
    //
    // 移植自 shiguang_warehouse 的 SYSU/sysu.js（上游快照 29498b0，本校脚本最后一次修改 80e30cf）。
    // 上游把解析、拼课、存配置写在同一段脚本里；这里 extract.js 只搬运，判断与拼课全放在这里。
    // 周次与提醒的骨架照模板 hueb，取数与字段映射按上游 sysu.js 重写。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 周次：上游只认「1-17」这一种区间，「(单)」「(双)」「共N周」「第N周」一律当数字处理，单双周会整段读错。
    //      这里逐个区间读标记：标记紧跟在区间后面就归那一段，标记在段首（前一段之后、没有逗号隔开的情况也算）就归下一段；
    //      「共N周」只剥备注本身；认不出的字进提醒
    //   ② 节次时间：上游写死 11 节表（TIME_SLOTS，逐节照抄）；教务没有作息接口，所以直接用它。超出 11 节的按统一修订 H3 补
    //   ③ 学期名：学年学期由 extract.js 按日期推算（上游是弹窗问用户），这里把它转成「2026-2027学年第一学期」；
    //      开学日取校历的 startTime，回退到那一周的周一（手册 §4.3）；校历取不到推算并写进提醒
    //   ④ 总周数：上游写死 20；这里同样 20，只有课表排到更晚的周才抬到那一周并提醒（不用课表的最大周当学期长度）
    //   ⑤ 同一门课同一时间的完全重复行只留一条（上游没有去重，同一条记录多次出现会叠两门课）
    //   ⑥ 上游没有读教师 / 教室的占位词：「未知」「暂无」「待定」这类一律交 null；教师括号里的备注（「（外聘）」等）先摘掉
    //   ⑦ 缺教师 / 缺教室照常导入（null），按课名去重计数写进提醒；缺星期、缺节次、缺课名的行跳过并计数，不静默
    //   ⑧ 课名去掉上游的「本(专必)」「本(公必)」类别前缀
    //   ⑨ 每条提醒走同一个限长出口（warn）：拼进去的课名、周次原文一律截到 20 字，整条不超过 200 字

    var SCHOOL_NAME = '中山大学';
    var MAX_WEEK = 30;              // 载荷校验：totalWeeks ∈ 1..30，周次只在这个区间里取
    var DEFAULT_TOTAL_WEEKS = 20;   // 上游写死的学期总周数（semesterTotalWeeks = 20）
    var MAX_PERIOD = 20;            // 单日节次上限：超过它一定是脏数据
    var MAX_WARNINGS = 20;          // 载荷校验：warnings ≤ 20 条
    var MAX_WARNING_TEXT = 200;     // 载荷校验：每条 ≤ 200 字
    var NAME_TEXT_LIMIT = 20;       // 提醒里点名的课名 / 周次原文最多显示的字数
    var EXTEND_BREAK_MINUTES = 5;   // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45;  // 节次时间补不上时顺推：每节几分钟
    var DAY_MINUTES = 24 * 60;

    // 学校节次时间：上游 SYSU/sysu.js 的 TIME_SLOTS，11 节，逐节照抄
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:20', end: '15:05' },
        { periodIndex: 6, start: '15:15', end: '16:00' },
        { periodIndex: 7, start: '16:30', end: '17:15' },
        { periodIndex: 8, start: '17:25', end: '18:10' },
        { periodIndex: 9, start: '19:00', end: '19:45' },
        { periodIndex: 10, start: '19:55', end: '20:40' },
        { periodIndex: 11, start: '20:50', end: '21:35' }
    ];

    // 空课内置节次表（12 节）：节次超出学校节次时间时，同号节次的开始不早于上一节下课就用它，否则顺推（统一修订 H3）
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

    // 推算开学日的锚点（只在校历取不到时用）：第一学期 9 月 1 日所在周的周一，第二学期 2 月 20 日所在周的周一
    var ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' }
    };

    // 教务里拿来表示「没有」的占位词：一律交 null
    var PLACEHOLDER = {
        '未知': true, '暂无': true, '待定': true, '无': true,
        '暂无教师': true, '暂无教室': true, '未知教师': true, '未知教室': true,
        '待定教师': true, '待定教室': true, '无教师': true, '无教室': true
    };

    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        // 每条提醒的唯一出口：超长直接截断（超了整包会被拒收）
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim().replace(/\/+$/, '').trim();
    }

    function shortName(value) {
        var s = text(value);
        return s.length > NAME_TEXT_LIMIT ? s.substring(0, NAME_TEXT_LIMIT) + '…' : s;
    }

    // 「例如 A、B、C」：最多点三个名字，多了加「等」
    function sampleOf(list) {
        var head = list.slice(0, 3).join('、');
        return list.length > 3 ? head + '等' : head;
    }

    function intOf(value) {
        var n = parseInt(text(value), 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    function minutesOf(hhmm) {
        var parts = String(hhmm).split(':');
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }

    function isoOfUtc(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    // 往前回退到当天或之前的周一（手册 §4.3：firstDayOfWeek 缺省为周一）
    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var back = (date.getUTCDay() + 6) % 7;
        date.setUTCDate(date.getUTCDate() - back);
        return isoOfUtc(date);
    }

    function isoFromText(value) {
        var m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text(value));
        if (!m) return null;
        return mondayOnOrBefore(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
    }

    // 课名：去掉上游的类别前缀「本(专必)」「本(公必)」
    function courseNameOf(value) {
        return text(value).replace(/^本\s*[(（][^)）]*[)）]/, '').trim();
    }

    // 教师：去掉括号里的备注（「张三（外聘）」→「张三」）；只剩备注或占位词的交 null
    function teacherOf(value) {
        var t = text(text(value).replace(/[（(][^）)]*[）)]/g, ''));
        return (t === '' || PLACEHOLDER[t] === true) ? null : t;
    }

    function placeOf(value) {
        var t = text(value);
        return (t === '' || PLACEHOLDER[t] === true) ? null : t;
    }

    // 全角 / 半角统一：数字、括号、分隔符、各种破折号
    function fullWidth(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[，、；;]/g, ',')
            .replace(/[～－—–~]/g, '-');
    }

    // 周次文字 → { weeks: 升序去重的周次, status: 'ok' | 'partial' | 'none', raw: 原文 }
    // 逐个区间读单双标记：标记紧跟在区间后面（中间没有逗号）归那一段；标记在段首（或前面隔着逗号）归下一段。
    // 「1-8周(单)9-16周(双)」「(单)1-8周,(双)9-16周」「(单)1-8周(双)9-16周」都读成 1-8 单 + 9-16 双。
    function weeksOf(raw) {
        var original = text(raw);
        var s = fullWidth(original);
        // 只有数字的括号是教学班序号（「(1)」「(1-2)」），整组摘掉，不当周次
        s = s.replace(/\(\s*[0-9\s,-]+\)/g, ' ');
        // 「共16周」是课程总周数备注，只剥备注本身（不能吞掉后面的周次）
        s = s.replace(/共\s*[0-9]+\s*周?/g, ' ');
        // 破折号连同两侧空白 → '-'；「至」「到」也当破折号
        s = s.replace(/\s*[-至到]\s*/g, '-');
        s = s.replace(/[周每第]/g, '');
        s = s.replace(/[()]/g, ' ');

        var leftover = s.replace(/([0-9]+)(?:-([0-9]+))?|([单双])|(,)/g, ' ').replace(/[\s-]/g, '');

        var tokens = [];
        var scan = /([0-9]+)(?:-([0-9]+))?|([单双])|(,)/g;
        var m = scan.exec(s);
        while (m !== null) {
            if (m[1]) {
                tokens.push({ kind: 'R', lo: parseInt(m[1], 10), hi: m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10), mark: '' });
            } else if (m[3]) {
                tokens.push({ kind: 'M', mark: m[3] });
            } else {
                tokens.push({ kind: 'C', mark: '' });
            }
            m = scan.exec(s);
        }

        // 标记归属：紧跟在一段后面（没有逗号、那段还没标过）→ 后缀，归前一段；否则 → 前置，归下一段
        var pending = '';
        var t;
        for (t = 0; t < tokens.length; t++) {
            var tok = tokens[t];
            if (tok.kind === 'M') {
                var prev = t > 0 ? tokens[t - 1] : null;
                if (prev && prev.kind === 'R' && prev.mark === '') prev.mark = tok.mark;
                else pending = tok.mark;
            } else if (tok.kind === 'R') {
                if (pending !== '' && tok.mark === '') tok.mark = pending;
                pending = '';
            }
        }

        var weeks = [];
        var seen = {};
        var dropped = 0;
        var used = false;
        for (t = 0; t < tokens.length; t++) {
            var range = tokens[t];
            if (range.kind !== 'R') continue;
            used = true;
            var lo = Math.min(range.lo, range.hi);
            var hi = Math.max(range.lo, range.hi);
            for (var w = lo; w <= hi; w++) {
                if (range.mark === '单' && w % 2 === 0) continue;
                if (range.mark === '双' && w % 2 === 1) continue;
                if (w < 1 || w > MAX_WEEK) { dropped++; continue; }
                if (seen[w] !== true) { seen[w] = true; weeks.push(w); }
            }
        }
        weeks.sort(function (a, b) { return a - b; });

        var status = 'none';
        if (weeks.length > 0) status = (leftover === '' && used) ? 'ok' : 'partial';
        return { weeks: weeks, status: status, raw: shortName(original), dropped: dropped };
    }

    // 周次集合 → 区间块：相邻差 1 是每周，差 2 是单周 / 双周（起点的奇偶决定类型）
    function blocksOf(weeks, day, from, to, location) {
        var out = [];
        var i = 0;
        while (i < weeks.length) {
            var step = i + 1 < weeks.length ? weeks[i + 1] - weeks[i] : 0;
            var j = i;
            if (step === 1 || step === 2) {
                while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            }
            var type = 'ALL';
            if (step === 2) type = weeks[i] % 2 === 1 ? 'ODD' : 'EVEN';
            out.push({
                dayOfWeek: day,
                startPeriod: from,
                endPeriod: to,
                startWeek: weeks[i],
                endWeek: weeks[j],
                weekType: type,
                location: location
            });
            i = j + 1;
        }
        return out;
    }

    function fixedPeriodAt(list, index) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].periodIndex === index) return list[i];
        }
        return null;
    }

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);

    var term = /^(\d{4})-([12])$/.exec(text(data.acadYear));
    if (!term) {
        throw new Error('学期信息读不出来：请重新打开教务系统的课表页，再点「提取课表」');
    }
    var startYear = parseInt(term[1], 10);
    var kind = term[2] === '2' ? 'second' : 'first';
    var name0 = startYear + '-' + (startYear + 1) + '学年' + (kind === 'second' ? '第二学期' : '第一学期');

    warn('这次导入的是按今天日期推算出的「' + name0 + '」（教务系统没有给出当前学期），请核对是不是你要的学期');

    // 开学日：校历给的 startTime 回退到那一周的周一；校历取不到就推算
    var firstDay = isoFromText(data.startDate);
    if (!firstDay) {
        var anchor = ANCHOR[kind];
        var anchorYear = kind === 'second' ? startYear + 1 : startYear;
        firstDay = mondayOnOrBefore(anchorYear, anchor.month, anchor.day);
        warn('教务系统没有给出开学日期，第 1 周按「' + anchor.rule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日');
        warn('教务系统也没有给出学期长度，学期总周数按 20 周导入，课表排到更晚的周时会自动加到那一周');
    }

    var rows = Object.prototype.toString.call(data.rows) === '[object Array]' ? data.rows : [];
    var courses = [];
    var seenCourse = {};
    var maxPeriod = 0;
    var maxWeek = 0;
    var weekNone = [];
    var weekPartial = [];
    var skipNoName = 0;
    var skipNoPeriod = [];
    var skipNoWeek = [];
    var missingTeacher = [];
    var missingTeacherSeen = {};
    var missingPlace = [];
    var missingPlaceSeen = {};

    var rawSeen = {};
    var droppedWeekCount = 0;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i] || {};
        var name = courseNameOf(row.courseName);
        var label = shortName(name);
        var day = intOf(row.week);
        var from = intOf(row.startClassTimes);
        var to = intOf(row.endClassTimes);
        var teacher = teacherOf(row.teachingStaffName);
        var location = placeOf(row.classPlace);

        // 先按记录内容去重，再计数：同一条记录重复出现只算一次，提醒里的数不被放大
        var rawKey = [name, day, from, to, teacher || '', location || '', text(row.timeDetail), text(row.startWeek)].join('|');
        if (rawSeen[rawKey] === true) continue;
        rawSeen[rawKey] = true;

        if (!name) { skipNoName++; continue; }
        if (!(day >= 1 && day <= 7) || !(from >= 1) || !(to >= from) || to > MAX_PERIOD) {
            skipNoPeriod.push(label);
            continue;
        }

        var parsed = weeksOf(row.timeDetail);
        var weeks = parsed.weeks;
        var weekNoteNone = false;
        if (weeks.length === 0) {
            var fallback = intOf(row.startWeek);
            if (!(fallback >= 1 && fallback <= MAX_WEEK)) {
                skipNoWeek.push(label);
                continue;
            }
            weeks = [fallback];
            weekNoteNone = true;
        }

        // 同课同时间同周次的完全重复行只留一条（不同写法读出同一结果的也算重复）
        var key = [name, teacher || '', location || '', day, from, to, weeks.join(',')].join('|');
        if (seenCourse[key] === true) continue;
        seenCourse[key] = true;

        droppedWeekCount += parsed.dropped;
        if (weekNoteNone) weekNone.push(label + '（周次原文「' + parsed.raw + '」）');
        else if (parsed.status !== 'ok') weekPartial.push(label + '（周次原文「' + parsed.raw + '」）');

        if (teacher === null && missingTeacherSeen[label] !== true) {
            missingTeacherSeen[label] = true;
            missingTeacher.push(label);
        }
        if (location === null && missingPlaceSeen[label] !== true) {
            missingPlaceSeen[label] = true;
            missingPlace.push(label);
        }

        if (to > maxPeriod) maxPeriod = to;
        if (weeks[weeks.length - 1] > maxWeek) maxWeek = weeks[weeks.length - 1];

        courses.push({
            name: name,
            teacher: teacher,
            note: null,
            blocks: blocksOf(weeks, day, from, to, location)
        });
    }

    // 节次时间：学校 11 节表；课表用到更晚的节次时按统一修订 H3 补（同号内置表能接上就用，接不上顺推）
    var periodTimes = [];
    var k;
    for (k = 0; k < SCHOOL_PERIOD_TIMES.length; k++) {
        periodTimes.push({
            periodIndex: SCHOOL_PERIOD_TIMES[k].periodIndex,
            start: SCHOOL_PERIOD_TIMES[k].start,
            end: SCHOOL_PERIOD_TIMES[k].end
        });
    }
    warn('节次时间用的是预先设好的 11 节表（第 1 节 08:00-08:45），如与学校实际不符请在学期管理里核对');

    var filled = [];
    var overflowFrom = 0;
    for (k = periodTimes.length + 1; k <= maxPeriod; k++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var builtin = fixedPeriodAt(BUILTIN_PERIOD_TIMES, k);
        var slot;
        if (builtin && minutesOf(builtin.start) >= prevEnd) {
            slot = { periodIndex: k, start: builtin.start, end: builtin.end };
        } else {
            var startMinutes = prevEnd + EXTEND_BREAK_MINUTES;
            var endMinutes = startMinutes + EXTEND_CLASS_MINUTES;
            if (endMinutes >= DAY_MINUTES) { overflowFrom = k; break; }
            slot = { periodIndex: k, start: hhmmOf(startMinutes), end: hhmmOf(endMinutes) };
        }
        periodTimes.push(slot);
        filled.push(k + ' 节 ' + slot.start + '-' + slot.end);
    }
    if (filled.length > 0) {
        warn('课表用到了超出学校节次时间的节次，已补上（第 ' + filled.join('、第 ') + '），补的时间不一定与学校一致，请在学期管理里核对');
    }
    if (overflowFrom > 0) {
        var overflowText = overflowFrom === maxPeriod
            ? '第 ' + overflowFrom + ' 节'
            : '第 ' + overflowFrom + '-' + maxPeriod + ' 节';
        warn(overflowText + '的时间补不上（顺推会超过当天 23:59），这几节课暂时没有时间，请在学期管理里补上');
    }

    var totalWeeks = DEFAULT_TOTAL_WEEKS;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        warn('课表里最晚排到第 ' + maxWeek + ' 周，已把学期总周数从 20 周调整为 ' + maxWeek + ' 周，请核对');
    }
    if (droppedWeekCount > 0) {
        warn('有 ' + droppedWeekCount + ' 个周次不在第 1-30 周之内，已忽略');
    }
    if (weekNone.length > 0) {
        warn('有 ' + weekNone.length + ' 门课的周次没看懂（例如 ' + sampleOf(weekNone) + '），暂按它们的开始周导入一周，请核对这些课的上课周次');
    }
    if (weekPartial.length > 0) {
        warn('有 ' + weekPartial.length + ' 门课的周次只认出一部分（例如 ' + sampleOf(weekPartial) + '），已按认出的部分导入，请核对这些课的上课周次');
    }
    if (skipNoName > 0) {
        warn('有 ' + skipNoName + ' 行课表没有课程名，已跳过');
    }
    if (skipNoPeriod.length > 0) {
        warn('有 ' + skipNoPeriod.length + ' 行课表缺星期或节次（例如 ' + sampleOf(skipNoPeriod) + '），没法放进课表，已跳过');
    }
    if (skipNoWeek.length > 0) {
        warn('有 ' + skipNoWeek.length + ' 行课表缺周次（例如 ' + sampleOf(skipNoWeek) + '），没法放进课表，已跳过');
    }
    if (missingTeacher.length > 0) {
        warn('有 ' + missingTeacher.length + ' 门课没给上课教师（例如 ' + sampleOf(missingTeacher) + '），已照常导入，教师暂时空着，可在「编辑课程」里补上');
    }
    if (missingPlace.length > 0) {
        warn('有 ' + missingPlace.length + ' 门课没给上课教室（例如 ' + sampleOf(missingPlace) + '），已照常导入，教室暂时空着，可在「编辑课程」里补上');
    }

    // 兜底：真到了上限就说清楚（正常路径下这一条不出现）
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
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
