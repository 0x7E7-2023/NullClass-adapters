(function () {
    // 重庆大学「智慧教务」（my.cqu.edu.cn，自研 REST 接口）适配器 —— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 CQU/cqu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 茵符草）
    //   上游快照 baf83fa（2026-11-09 拉取）；本校脚本最后一次修改 1fe584c（2026-08-23，升级桥接接口至 v2）
    // 输入是 extract.js 交出的 { term, today, startDate, maxWeek, periodTimes, rows }；
    //   每行只有 courseName / instructorName / position / roomName / weekDay / periodFormat / teachingWeek。
    //
    // 上游在同一段脚本里取数、拼课、存档；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里。parse.js 骨架取自已审计的 hueb（同为「教务取数 → 载荷」的移植件），
    // 取数路径、字段映射、学期选择与节次来源按上游 cqu.js 重写。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 周次：上游把 teachingWeek 位串按字符下标映射成第 N 周（第 1 位是第 1 周），这里照做；
    //      只认 '0' / '1'，出现别的字符就当作认不出（不猜、不静默丢），超出 1-30 周的位丢弃并计数。
    //   ② 节次：上游只认 "1-2" 与 "3" 两种写法，这里都接住，另容忍全角数字与「第…节」；
    //      超出 1-20 节的按不完整行计数，不硬塞进课表。
    //   ③ 教师：上游 instructorName.slice(0, indexOf('-')) 在没有 '-' 时会砍掉最后一个字（上游 bug），
    //      这里只在真有 '-' 时取前一段；'[主讲]' 这类角色标记先摘掉；「未知」「待定」「暂无」等占位词交 null。
    //   ④ 教室：上游 position 优先、没有再用 roomName，这里照做；占位词交 null。缺教师 / 缺教室照常导入并汇总提醒。
    //   ⑤ 开学日：上游把 beginDate 直接当开学日；空课要求第 1 周从周一开始，这里回退到那一周的周一（手册 §4.3）；
    //      教务没给才按学期锚点推算并写进提醒。
    //   ⑥ 总周数：上游用 maxWeek 接口；取不到时上游会整次失败。这里取不到就用课表里最晚的周并在提醒里说明
    //      （不静默用 20）；课表更晚时抬高总周数，超过 30 周按 30 周导入，都写进提醒。
    //   ⑦ 节次时间：上游用教务的 classPeriodVOS；取不到时用空课默认 12 节表（不是本校表，提醒里如实说明），
    //      课表用到更晚的节次时按批次五统一修订 H3 逐节补并提醒。
    //   ⑧ 学期名：上游没有学期名。这里优先用教务给的学年学期文本，其次用学年 + 学期代号拼，
    //      再次按开学日推学年学期，都用不上才用「重庆大学 第 X 学期」；不用适配器名。
    //   ⑨ 同课合并：先去掉完全相同的行，再合并首尾相接的节次，最后同节次取周次并集
    //      （与上游「一行一课」语义等价，只是不让同一门课在课表里重复出现）。
    //   ⑩ 上游的弹窗、保存桥、提示条、任务完成通知都不移植；载荷交给宿主保存。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '重庆大学';
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名 / 原文最多显示的字数
    var EXTEND_BREAK_MINUTES = 5;  // 作息表补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 作息表补不上时顺推：每节几分钟

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：教务没给节次时间时整张用它，
    // 课表用到的节次超出时也优先用同号的这一节（批次五统一修订 H3）。
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
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到第 1 周那一周的周一（含当天）。
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '夏季学期 = 7 月 1 日所在周的周一' }
    };

    // 「未知」「待定」「暂无」这类词不是教师名 / 教室名，交出去必须是 null（载荷校验也会拒）
    var EMPTY_WORD = {
        '未知': true, '未知教师': true, '未知老师': true, '未知教室': true, '未知地点': true,
        '待定': true, '暂无': true, '暂无教师': true, '暂无老师': true, '暂无教室': true, '暂无地点': true
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
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

    // 任意形态的日期 → ISO 日期（只认年月日，后面的时间部分忽略）
    function isoOfAny(value) {
        var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
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
    // 载荷校验要求 periodTimes 的时间必须是 HH:mm 且 00:00–23:59，写进去的越界时间会让整包被拒。
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
        // 单条超长直接截断（载荷校验是「超了就整包拒收」，截断至少还能让用户看到前半句）
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 周次：teachingWeek 位串 ----------
    // 上游把位串按字符下标映射成周次：第 1 个字符是第 1 周，字符 '1' 表示那一周上课。
    // 只认 '0' / '1'；出现别的字符说明写法变了，当作认不出，交给调用方跳过并提醒，不瞎猜。
    var droppedWeeks = 0;   // 超出 1..MAX_WEEK 被丢掉的周次个数

    function weeksOf(source) {
        var raw = text(source).replace(/\s+/g, '');
        if (!raw) return null;
        var seen = {};
        var weeks = [];
        for (var i = 0; i < raw.length; i++) {
            var ch = raw.charAt(i);
            if (ch !== '0' && ch !== '1') return null;
            if (ch !== '1') continue;
            var week = i + 1;
            if (week > MAX_WEEK) { droppedWeeks++; continue; }
            if (!seen[week]) { seen[week] = true; weeks.push(week); }
        }
        if (!weeks.length) return [];
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周（手册 §4.1）。
    // 一个上游课程切出多段就写成多个 block，语义等价。
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

    // ---------- 节次：periodFormat 是 "1-2"（连堂）或 "3"（单节） ----------
    // 超出 1-MAX_PERIOD 的按不完整行计数，不硬塞进课表（会让载荷校验拒收或把课排到不存在的节次）
    function sectionsOf(row) {
        var source = text(row.periodFormat);
        if (!source) return null;
        var cleaned = source
            .replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
            .replace(/[第节\s]/g, '');
        var range = /^([0-9]{1,2})-([0-9]{1,2})$/.exec(cleaned);
        if (range) {
            var from = parseInt(range[1], 10);
            var to = parseInt(range[2], 10);
            if (from > to) { var swap = from; from = to; to = swap; }
            if (from < 1 || to > MAX_PERIOD) return null;
            return { start: from, end: to };
        }
        if (/^[0-9]{1,2}$/.test(cleaned)) {
            var one = parseInt(cleaned, 10);
            if (one < 1 || one > MAX_PERIOD) return null;
            return { start: one, end: one };
        }
        return null;
    }

    // ---------- 教务的节次时间（extract.js 另取的，取不到就是 null） ----------
    // 一行一节：periodOrder = 节次，startTime / endTime = 起止时间。要求从第 1 节起连续、
    // 时间递增不重叠、且都落在 00:00–23:59 —— 不满足就当没取到（回落到默认表并说明），不猜。
    function periodTimesOf(value) {
        if (!(value instanceof Array) || !value.length) return null;
        var slots = [];
        for (var i = 0; i < value.length; i++) {
            var row = value[i] || {};
            var index = intOf(row.periodOrder);
            var start = timeOf(row.startTime);
            var end = timeOf(row.endTime);
            if (index === null || !start || !end) return null;
            if (minutesOf(start) >= minutesOf(end)) return null;
            slots.push({ periodIndex: index, start: start, end: end });
        }
        slots.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        var lastEnd = -1;
        for (var k = 0; k < slots.length; k++) {
            if (slots[k].periodIndex !== k + 1) return null;
            if (k > 0 && minutesOf(slots[k].start) < lastEnd) return null;
            lastEnd = minutesOf(slots[k].end);
        }
        return slots;
    }

    // ---------- 教师与教室 ----------
    // 教师：先摘掉「[主讲]」这类角色标记（同一平台的同类脚本也这么做），再按上游的 '-' 取前一段；
    // 占位词交 null（写「未知」会被课表当成真名）。括号里的备注（「张三（外聘）」）不拆成第二位教师。
    function teacherOf(value) {
        var raw = text(value).replace(/\[[^\]]*\]/g, '');
        var dash = raw.indexOf('-');
        if (dash >= 0) raw = text(raw.substring(0, dash));
        raw = text(raw);
        return !raw || EMPTY_WORD[raw] ? '' : raw;
    }

    function roomOf(row) {
        var raw = text(row.position) || text(row.roomName);
        return !raw || EMPTY_WORD[raw] ? '' : raw;
    }

    // ---------- 开学日与学期 ----------
    // 学期序号：教务的 term 可能是「1」「秋」「第一」这几种写法之一；认不出来返回空串
    function termKind() {
        var label = text(term.term);
        if (!label) return '';
        if (label.indexOf('一') >= 0 || label.indexOf('秋') >= 0 || label === '1') return 'first';
        if (label.indexOf('二') >= 0 || label.indexOf('春') >= 0 || label === '2') return 'second';
        if (label.indexOf('三') >= 0 || label.indexOf('夏') >= 0 || label === '3') return 'third';
        return '';
    }

    // 学年：教务的 year 可能是「2026-2027」或「2026」（后者按起始年补成区间）
    function yearLabel() {
        var label = text(term.year);
        if (/^[0-9]{4}-[0-9]{4}$/.test(label)) return label;
        if (/^[0-9]{4}$/.test(label)) return label + '-' + (parseInt(label, 10) + 1);
        return '';
    }

    function termYear() {
        var label = yearLabel();
        return /^[0-9]{4}/.test(label) ? parseInt(label.substring(0, 4), 10) : 0;
    }

    // 教务没给开学日时的推算（手册 §4.3：推算结果一律写进提醒）
    function estimateStart(todayIso) {
        var kind = termKind();
        var anchor = KIND_ANCHOR[kind];
        var year = termYear();
        if (!anchor || !year) {
            // 学年或学期序号读不出来时退回「今天的周一」；这条分支依赖当天日期，不进 fixture
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天的周一' };
        }
        return {
            iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), anchor.month, anchor.day)),
            rule: anchor.rule
        };
    }

    // 按开学日推学年学期：8 月-次年 1 月算第一学期，2-6 月算第二学期，7 月算夏季学期
    function termNameFromDate(iso) {
        var month = parseInt(iso.substring(5, 7), 10);
        var year = parseInt(iso.substring(0, 4), 10);
        if (month >= 8) return year + '-' + (year + 1) + '学年第一学期';
        if (month === 1) return (year - 1) + '-' + year + '学年第一学期';
        // 7 月对应夏季学期（与 KIND_ANCHOR.third 的 7 月 1 日锚点一致），别并进第二学期
        if (month === 7) return (year - 1) + '-' + year + '学年第三学期';
        return (year - 1) + '-' + year + '学年第二学期';
    }

    // 学期名：教务给的学年学期文本优先；没有就用学年 + 学期代号拼；再没有就按开学日推；
    // 什么都推不出才用「重庆大学 第 X 学期」（不用适配器名当学期名，手册 §4.7）。
    // 返回 { name, derived }，derived 为真表示名字不是教务原文，要写进提醒。
    function termName(startIso) {
        // 教务给的学年学期原文一律照用：像「2026夏」这种不含「学期」二字的也是学校自己的叫法，
        // 丢掉它再去推一个名字，提醒里还会反过来说「教务没有给学期名称」
        var explicit = text(term.name);
        if (explicit) return { name: explicit, derived: false };
        var kind = termKind();
        var year = yearLabel();
        if (year && kind) {
            return { name: year + '学年第' + KIND_CN[kind] + '学期', derived: false };
        }
        if (startIso) return { name: termNameFromDate(startIso), derived: true };
        return { name: SCHOOL_NAME + ' 第' + KIND_CN[kind || 'first'] + '学期', derived: true };
    }

    // ---------- 逐行转换 ----------
    var courses = [];
    var byName = {};
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    // 已导入、但教务没给上课教师 / 上课地点的课（按课名去重，提醒里说「N 门课」才准）
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];     // 这两类课里点名用的课名，最多 3 个
    var weekSamples = [];      // 认不出的周次位串，最多留 3 个，写进提醒方便反馈
    var maxWeek = 0;
    var maxPeriod = 0;

    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序；节次与周次先收成 entry，合并后再拆成 block
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

    // ---------- 同课合并 ----------
    // 每行收成一条 entry（课程、教师、教室、星期、起止节次、周次集合）后套三步：
    //   0：完全相同的行只留一条；
    //   阶段 1：名称、教师、教室、星期、周次都一样、且节次首尾相接（含重叠 / 重复行）的合成一条；
    //   阶段 2：名称、教师、教室、星期、起止节次都一样的，周次取并集。
    var entries = [];

    // 原始行先按内容去重：同一条排课在响应里重复出现时，缺教师 / 缺教室的计数与周次丢弃计数都不能被放大
    function rowKey(row) {
        return [
            text(row.courseName), text(row.instructorName), text(row.position),
            text(row.roomName), text(row.weekDay), text(row.periodFormat), text(row.teachingWeek)
        ].join('|');
    }

    function dropDuplicateRows(list) {
        var ledger = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var key = rowKey(row);
            if (ledger[key]) continue;
            ledger[key] = true;
            out.push(row);
        }
        return out;
    }

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

    function cmpText(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    function sameSlotDay(a, b) {
        return a.name === b.name && a.teacher === b.teacher && a.location === b.location && a.day === b.day;
    }

    function weeksKey(entry) {
        return entry.weeks.join(',');
    }

    function orderStageOne(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || cmpText(weeksKey(a), weeksKey(b)) || (a.start - b.start);
    }

    function orderStageTwo(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end);
    }

    function unionWeeks(a, b) {
        var all = a.concat(b);
        var have = {};
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (have[all[i]]) continue;
            have[all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    // 阶段 1（输入已按 orderStageOne 排好）。合并条件是「下一节不晚于上一节结束 + 1」：
    // 正好接着的连堂（1-2 + 3-4）与重复写了一遍的同一节（1-2 + 1-2）都能吸收，不留重叠块。
    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next)) {
                if (next.start <= current.end + 1) {
                    if (next.end > current.end) current.end = next.end;
                    continue;
                }
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    // 阶段 2（输入已按 orderStageTwo 排好）
    function mergeStageTwo(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && current.start === next.start && current.end === next.end) {
                current.weeks = unionWeeks(current.weeks, next.weeks);
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    var uniqueRows = dropDuplicateRows(rows);
    for (var r = 0; r < uniqueRows.length; r++) {
        var row = uniqueRows[r] || {};

        var name = text(row.courseName);
        if (!name) { missing.name++; continue; }

        var day = intOf(row.weekDay);
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOf(row);
        if (!sections) { missing.period++; continue; }

        var weeks = weeksOf(row.teachingWeek);
        if (weeks === null) {
            var sample = text(row.teachingWeek);
            if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
            missing.week++;
            continue;
        }
        if (!weeks.length) { missing.week++; continue; }

        // 教师、教室没有就留空（手册 §4.7：写「未知」会被当成真名显示）；缺了照常导入并汇总提醒
        var teacher = teacherOf(row.instructorName);
        var location = roomOf(row);
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
            start: sections.start,
            end: sections.end,
            weeks: weeks
        });
    }

    // 去完全相同的行 → 排序 → 阶段 1 → 再排序 → 阶段 2
    entries = dropExactDuplicates(entries);
    entries.sort(orderStageOne);
    var merged = mergeStageOne(entries);
    merged.sort(orderStageTwo);
    merged = mergeStageTwo(merged);

    // 合并后的每条 entry 按周次拆成 block（步长 2 → 单 / 双周，见 runsOf）
    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
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
            '请重新登录、打开自己的课表确认能看到课程后再点「提取课表」'
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

    // ---------- 开学日 / 学期名 / 总周数 ----------
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var apiStartIso = isoOfAny(data.startDate);
    var start;
    if (apiStartIso) {
        start = { iso: mondayOfIso(apiStartIso), rule: '教务系统', given: apiStartIso };
    } else {
        start = estimateStart(todayIso);
        start.given = null;
    }
    var nameInfo = termName(start.iso);
    var name0 = nameInfo.name;

    var apiMaxWeek = intOf(data.maxWeek);
    if (apiMaxWeek !== null && apiMaxWeek < 1) apiMaxWeek = null;
    var weeksMissing = apiMaxWeek === null;
    var totalWeeks = weeksMissing ? maxWeek : apiMaxWeek;
    var raisedBySchedule = totalWeeks < maxWeek;
    if (raisedBySchedule) totalWeeks = maxWeek;
    var clamped = totalWeeks > MAX_WEEK;
    if (clamped) totalWeeks = MAX_WEEK;

    // 分钟数写回 HH:mm（补时间用）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    // 节次号（已升序）写成「第 9-12 节」「第 9 节」「第 9、11-12 节」这几种
    function sectionsText(list) {
        var runsText = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) {
                j++;
            }
            runsText.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + runsText.join('、') + ' 节';
    }

    // ---------- 节次时间：教务的优先，取不到整张用默认 12 节表；课表用到的更晚节次逐节补 ----------
    var apiPeriodTimes = periodTimesOf(data.periodTimes);
    var usedDefault = !apiPeriodTimes;
    var periodTimes = usedDefault ? BUILTIN_PERIOD_TIMES.slice(0) : apiPeriodTimes.slice(0);
    var tableLength = periodTimes.length;
    var fromDefault = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = tableLength + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        var prevEnd = minutesOf(prev.end);
        var builtinSlot = BUILTIN_PERIOD_TIMES[p - 1];
        // 默认表有这一节、且它的开始不早于上一节下课，才用默认时间（否则会和上一节重叠甚至倒挂）
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: builtinSlot.start, end: builtinSlot.end });
            fromDefault.push(p);
            continue;
        }
        // 否则从上一节下课后顺推：课间 5 分钟、每节 45 分钟；顺推越过 23:59 就停，这一节起不再补
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    warn(
        '只导入了教务系统当前选中的学期（' + name0 +
        '）；要导入别的学期，请在教务系统里切到那个学期再点「提取课表」'
    );

    if (nameInfo.derived) {
        warn('教务系统没有给出学期名称，已按开学日期记为「' + shortName(name0) + '」，如与实际不符请在学期管理里改');
    }

    if (start.given) {
        var aligned = start.given !== start.iso;
        warn(
            '开学日期取自教务系统：第 1 周从 ' + start.iso + ' 开始' +
            (aligned ? '（教务系统给的日期是 ' + start.given + '，已对齐到那一周的周一）' : '') +
            '，请在学期管理里核对'
        );
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start.rule +
            '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (weeksMissing) {
        warn(
            '教务系统没有给出学期总周数，已按课表里最晚的第 ' + maxWeek +
            ' 周导入，如与实际不符可在学期管理里改'
        );
    } else if (raisedBySchedule) {
        warn(
            '教务系统写的学期总周数是 ' + apiMaxWeek + ' 周，课表里有第 ' + maxWeek + ' 周的课，已按 ' +
            totalWeeks + ' 周导入（否则第 ' + (apiMaxWeek + 1) + ' 周起的课放不下）'
        );
    } else if (clamped) {
        warn(
            '教务系统写的学期总周数超过 ' + MAX_WEEK + ' 周，已按 ' + MAX_WEEK +
            ' 周导入，如与实际不符可在学期管理里改'
        );
    }

    if (usedDefault) {
        warn(
            '教务系统没有给出节次时间，已按默认的 ' + BUILTIN_PERIOD_TIMES.length +
            ' 节节次时间导入（第 1 节 ' + BUILTIN_PERIOD_TIMES[0].start + '-' + BUILTIN_PERIOD_TIMES[0].end +
            '），时间可能与学校实际不符，请在学期管理里核对'
        );
    }
    if (fromDefault.length || bySequence.length) {
        var fillTexts = [];
        if (fromDefault.length) fillTexts.push(sectionsText(fromDefault) + '用默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromDefault.concat(bySequence).sort(function (a, b) { return a - b; });
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
        if (missing.week) reasons.push('缺周次（或认不出周次、周次全在 1-' + MAX_WEEK + ' 周之外）' + missing.week + ' 行');
        if (weekSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push(shortName(weekSamples[ws]));
            reasons.push('认不出的周次写法如「' + sampleTexts.join('」「') + '」');
        }
        warn(
            '有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
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
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    }

    // 兜底：真到了上限就说清楚（正常路径下这些计数永远是 0）
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
