(function () {
    // 广东科学技术职业学院课表适配器（网上办事大厅 wbdt.gdit.edu.cn 的课表 JSON 接口）—— 第二步：教务原始排课 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 GDIT/gdit.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03）；本校脚本最后一次修改 80e30cf（批量合并提交）
    //
    // 这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑）；取数在 extract.js 里。
    // 移植改动（逐条对应 AUDIT.md §4）：
    //   ① 周次：接口给的是数字区间 startWeek~endWeek，singleDoubleWeek 1 = 单周、2 = 双周、0 或空 = 每周；
    //      单双标记直接变成 weekType（ODD / EVEN / ALL），不再从周次文字里拆
    //   ② 节次：festivals 可以是「1-2」「01-02」「1-2,5-6」「1」；每一段连续节次单独出一个时间块，不再只取第一段；
    //      上游只认 /(\d+)-(\d+)/，「1-2,5-6」的第二段会静默丢掉
    //   ③ 节次时间：上游 setPresetTimeSlots 写死 11 节表，逐节照抄；课表用到第 12 节及以后，按统一修订 H3 顺推补齐并提醒，
    //      顺推越过 23:59 的节次不导入并提醒
    //   ④ 缺课名 / 星期 / 节次 / 周次的记录：上游 try/catch 静默跳过，这里计数写进提醒，不静默丢课
    //   ⑤ 教师、教室：缺失或写成「未知」「待定」「暂无」「暂无教师」「暂无教室」时交 null，按课名汇总提醒，不丢课
    //   ⑥ 完全相同的排课记录只留一条（接口偶尔会重复返回同一行）
    //   ⑦ 学期名取 extract.js 推算出的学年学期（「2026-2027学年第1学期」），不用适配器名；
    //      开学日上游没有给，这里按「第 1 学期 = 9 月 1 日所在周的周一、第 2 学期 = 2 月 20 日所在周的周一」推算并提醒（手册 §4.3）
    //   ⑧ 总周数：没有校历，按 20 周导入（手册 §4.4）；课表里最晚的周次超过 20 时抬到那一周并提醒
    //   ⑨ 上游的弹窗 / 写入 / toast / notifyTaskCompletion 全部不移植：空课由宿主保存，适配器只交载荷

    // 学校作息：上游 GDIT/gdit.js 的 setPresetTimeSlots 写死的 11 节表，逐节照抄
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:10', end: '08:55' },
        { periodIndex: 2, start: '09:05', end: '09:50' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:25', end: '16:10' },
        { periodIndex: 7, start: '16:30', end: '17:15' },
        { periodIndex: 8, start: '17:25', end: '18:10' },
        { periodIndex: 9, start: '19:10', end: '19:55' },
        { periodIndex: 10, start: '20:05', end: '20:50' },
        { periodIndex: 11, start: '21:00', end: '21:45' }
    ];

    var SCHOOL_NAME = '广东科学技术职业学院';
    var MAX_WEEK = 30;              // 载荷校验：totalWeeks ∈ 1..30，周次只在这个区间里取
    var DEFAULT_TOTAL_WEEKS = 20;   // 没有校历时的学期总周数（手册 §4.4）
    var MAX_PERIOD = 20;            // 节次写到 20 以上一定是脏数据
    var BREAK_MINUTES = 5;          // 节次时间补齐（H3）：课间 5 分钟
    var CLASS_MINUTES = 45;         // 节次时间补齐（H3）：每节 45 分钟
    var DAY_END_MINUTES = 23 * 60 + 59;
    var MAX_WARNINGS = 20;          // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;     // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;       // 提醒里点名的课名最多 20 字
    var PLACEHOLDERS = { '未知': true, '待定': true, '暂无': true, '暂无教师': true, '暂无教室': true };

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var meta = data.meta || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];
    var todayIso = String(data.today || '');

    var warnings = [];
    var droppedWarnings = 0;

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 每条提醒都从这里出去：单条超长截断，超过条数的计入「另有 N 条」
    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    function shortName(name) {
        return name.length > NAME_TEXT_LIMIT ? name.substring(0, NAME_TEXT_LIMIT) + '…' : name;
    }

    // 点名最多 3 门课，课名各截到 20 字
    function nameList(names) {
        var parts = [];
        for (var i = 0; i < names.length && i < 3; i++) parts.push(shortName(names[i]));
        return parts.join('、') + (names.length > 3 ? ' 等' : '');
    }

    function intOf(value) {
        if (typeof value === 'number') return isFinite(value) && value === Math.floor(value) ? value : null;
        var s = text(value);
        return /^[0-9]+$/.test(s) ? parseInt(s, 10) : null;
    }

    // 教师 / 教室：空或占位词一律 null（不许写「未知」「暂无」之类进载荷）
    function plainOrNull(value) {
        var s = text(value);
        if (!s || Object.prototype.hasOwnProperty.call(PLACEHOLDERS, s)) return null;
        return s;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    function minutesOf(hhmm) {
        var parts = hhmm.split(':');
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }

    // 某天所在周的周一（周一开始），返回 yyyy-MM-dd
    function mondayOf(year, month, day) {
        var d = new Date(year, month - 1, day);
        var back = (d.getDay() + 6) % 7;
        d = new Date(year, month - 1, day - back);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    // 节次写法：「1-2」「01-02」「1-2,5-6」「1」…；返回连续节次段的列表，写不懂的整条返回 []（计入缺节次）
    function sectionRuns(value) {
        var pieces = text(value).split(/[^0-9\-]+/);
        var has = {};
        var nums = [];
        for (var i = 0; i < pieces.length; i++) {
            if (!pieces[i]) continue;
            var m = /^([0-9]+)(?:-([0-9]+))?$/.exec(pieces[i]);
            if (!m) return [];
            var a = parseInt(m[1], 10);
            var b = m[2] ? parseInt(m[2], 10) : a;
            if (a < 1 || b < a || b > MAX_PERIOD) return [];
            for (var n = a; n <= b; n++) {
                if (!has[n]) { has[n] = true; nums.push(n); }
            }
        }
        nums.sort(function (x, y) { return x - y; });
        var runs = [];
        for (var j = 0; j < nums.length; j++) {
            var last = runs.length ? runs[runs.length - 1] : null;
            if (last && nums[j] === last.end + 1) last.end = nums[j];
            else runs.push({ start: nums[j], end: nums[j] });
        }
        return runs;
    }

    if (meta.success !== true) {
        var reason = text(meta.message).substring(0, 40);
        throw new Error('网上办事大厅没有返回课表' + (reason ? '：' + reason : '') + '。请确认已登录，再点「提取课表」');
    }
    if (!rows.length) {
        throw new Error('这个学期没有查到课表：可能还没排课，或登录状态已失效。请确认已登录，再点「提取课表」');
    }

    // ---------- 学期名与开学日 ----------
    var schoolYearOk = /^[0-9]{4}-[0-9]{4}$/.test(String(term.schoolYear || ''));
    var secondTerm = String(term.semester) === '2';
    if (!schoolYearOk || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(todayIso)) {
        throw new Error('没读到学年学期或日期：请重新打开课程表页面，再点「提取课表」');
    }
    var yearParts = term.schoolYear.split('-');
    var termName = term.schoolYear + '学年第' + (secondTerm ? '2' : '1') + '学期';
    var firstDay = secondTerm
        ? mondayOf(parseInt(yearParts[1], 10), 2, 20)
        : mondayOf(parseInt(yearParts[0], 10), 9, 1);
    var ruleText = secondTerm ? '第 2 学期 = 2 月 20 日所在周的周一' : '第 1 学期 = 9 月 1 日所在周的周一';

    // ---------- 逐条整理排课 ----------
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var clippedRows = 0;     // 周次有一部分超出 1..30，已截到范围内
    var unknownMarks = 0;    // 单双周标记既不是 1 也不是 2 也不是 0
    var missingTeacher = {};
    var missingLocation = {};
    var entries = [];
    var i;

    for (i = 0; i < rows.length; i++) {
        var row = rows[i] || {};
        var name = text(row.courseName);
        var day = intOf(row.weekDay);
        var runs = sectionRuns(row.festivals);
        var first = intOf(row.startWeek);
        var last = intOf(row.endWeek);
        if (!name) { missing.name++; continue; }
        if (day === null || day < 1 || day > 7) { missing.day++; continue; }
        if (!runs.length) { missing.period++; continue; }
        if (first === null || last === null || first > last) { missing.week++; continue; }
        var lo = Math.max(first, 1);
        var hi = Math.min(last, MAX_WEEK);
        if (lo > hi) { missing.week++; continue; }
        if (lo !== first || hi !== last) clippedRows++;

        var mark = text(row.singleDoubleWeek);
        var weekType = 'ALL';
        if (mark === '1') weekType = 'ODD';
        else if (mark === '2') weekType = 'EVEN';
        else if (mark !== '' && mark !== '0') unknownMarks++;

        // 单 / 双周的两端必须同为单 / 双数（校验要求）：端点不合要求就往里收一周，周集合不变
        if (weekType === 'ODD') { if (lo % 2 === 0) lo++; if (hi % 2 === 0) hi--; }
        if (weekType === 'EVEN') { if (lo % 2 === 1) lo++; if (hi % 2 === 1) hi--; }
        if (lo > hi) { missing.week++; continue; }

        var teacher = plainOrNull(row.userName);
        var location = plainOrNull(row.placeName);
        if (teacher === null) missingTeacher[name] = true;
        if (location === null) missingLocation[name] = true;

        for (var r = 0; r < runs.length; r++) {
            entries.push({
                name: name, teacher: teacher, location: location, day: day,
                start: runs[r].start, end: runs[r].end, lo: lo, hi: hi, weekType: weekType
            });
        }
    }

    // ---------- 节次时间：11 节照抄；课表用到更晚的节次，按 H3 顺推补齐，补不了的不导入 ----------
    var maxUsed = 0;
    for (i = 0; i < entries.length; i++) {
        if (entries[i].end > maxUsed) maxUsed = entries[i].end;
    }
    var periodTimes = PERIOD_TIMES.slice(0);
    for (var p = PERIOD_TIMES.length + 1; p <= maxUsed; p++) {
        var startMin = minutesOf(periodTimes[periodTimes.length - 1].end) + BREAK_MINUTES;
        var endMin = startMin + CLASS_MINUTES;
        if (endMin > DAY_END_MINUTES) break;
        periodTimes.push({ periodIndex: p, start: hhmmOf(startMin), end: hhmmOf(endMin) });
    }

    var kept = [];
    var keptMax = 0;
    for (i = 0; i < entries.length; i++) {
        if (entries[i].end > periodTimes.length) { missing.period++; continue; }
        kept.push(entries[i]);
        if (entries[i].end > keptMax) keptMax = entries[i].end;
    }
    // 节次时间只留到真正用上的那一节（被丢掉的记录不算）
    periodTimes = periodTimes.slice(0, Math.max(PERIOD_TIMES.length, keptMax));

    // ---------- 合并进课程（同课名 + 同教师为一门课），完全相同的记录只留一条 ----------
    var courses = [];
    var byCourse = {};
    var seen = {};
    var maxWeek = 0;
    for (i = 0; i < kept.length; i++) {
        var e = kept[i];
        var dedupeKey = JSON.stringify([e.name, e.teacher, e.location, e.day, e.start, e.end, e.lo, e.hi, e.weekType]);
        if (seen[dedupeKey]) continue;
        seen[dedupeKey] = true;
        if (e.hi > maxWeek) maxWeek = e.hi;
        var courseKey = JSON.stringify([e.name, e.teacher]);
        var course = byCourse[courseKey];
        if (!course) {
            course = { name: e.name, teacher: e.teacher, note: null, blocks: [] };
            byCourse[courseKey] = course;
            courses.push(course);
        }
        course.blocks.push({
            dayOfWeek: e.day,
            startPeriod: e.start,
            endPeriod: e.end,
            startWeek: e.lo,
            endWeek: e.hi,
            weekType: e.weekType,
            location: e.location
        });
    }

    if (!courses.length) {
        throw new Error('这个学期的课表记录都不完整，没有可以导入的课程。请到教务系统核对这学期的排课后再试');
    }

    // ---------- 提醒（按类型汇总，点名课名已截字） ----------
    warn(
        '学期按今天（' + todayIso + '）推算为「' + termName + '」（9 月至次年 2 月为第 1 学期，3 至 8 月为第 2 学期）。' +
        '这个导入方式不能选学期，如果不是你要的学期，请先核对再使用'
    );
    warn(
        '网上办事大厅没有给出开学日期，第 1 周按「' + ruleText + '」推算为 ' + firstDay +
        '，请在学期管理里核对成学校实际开学日'
    );
    if (maxWeek > DEFAULT_TOTAL_WEEKS) {
        warn('学期总周数没有从教务取到，课表里最晚排到第 ' + maxWeek + ' 周，已把学期总周数调到 ' + maxWeek + ' 周，请在学期管理里核对');
    } else {
        warn('学期总周数没有从教务取到，按 20 周导入，如学校的学期长度不同，请在学期管理里核对');
    }
    warn(
        '网上办事大厅没有提供节次时间，已按本校常用的 11 节节次时间导入（第 1 节 08:10-08:55，第 11 节 21:00-21:45），' +
        '请在学期管理里核对成学校实际的节次时间'
    );
    if (periodTimes.length > PERIOD_TIMES.length) {
        warn(
            '课表用到了第 ' + (PERIOD_TIMES.length + 1) + '-' + periodTimes.length + ' 节，超出上面 11 节，' +
            '已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在学期管理里核对节次时间'
        );
    }
    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        warn('有 ' + skipped + ' 条排课记录缺课名、星期、节次或周次，没有导入（这些记录在教务系统里不完整，可到教务系统核对）');
    }
    if (clippedRows > 0) {
        warn('有 ' + clippedRows + ' 条排课的周次超出第 1-' + MAX_WEEK + ' 周，已截到这个范围内导入');
    }
    if (unknownMarks > 0) {
        warn('有 ' + unknownMarks + ' 条排课的单双周标记看不懂，这些课按每周都上导入，请核对');
    }
    var mt = Object.keys(missingTeacher);
    if (mt.length) {
        warn('有 ' + mt.length + ' 门课没给上课教师（例如 ' + nameList(mt) + '）：已照常导入，教师暂时空着，可在「编辑课程」里补上');
    }
    var ml = Object.keys(missingLocation);
    if (ml.length) {
        warn('有 ' + ml.length + ' 门课没给上课地点（例如 ' + nameList(ml) + '）：已照常导入，地点暂时空着，可在「编辑课程」里补上');
    }
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
                totalWeeks: maxWeek > DEFAULT_TOTAL_WEEKS ? maxWeek : DEFAULT_TOTAL_WEEKS,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
