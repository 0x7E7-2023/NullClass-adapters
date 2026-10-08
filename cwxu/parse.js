(function () {
    // 无锡学院教务适配器（正方新版 jwglxt 平台）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 CWXU/cwxu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 ewiro）
    //   上游快照 ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    //
    // 上游在同一段脚本里算周次、拼课程、存配置；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交出来的就是教务自己的行对象（kbList / sjkList / 校区作息 / 学期周次校历）。
    //
    // 移植改动（按移植手册 §4 与本批检查表逐条对照；上游 parseWeeks / parseSections 认的写法都要认）：
    //   ① 周次前缀与符号：「周数：」「周数:」前缀删掉，「第」字删掉；「，」「、」「；」「;」当逗号，
    //      全角「（」「）」当半角括号，「~」「～」「至」当区间连接号（周次与节次两处都认）
    //   ② 单/双标记位置不限：「1-16周(单)」「(单)1-16周」「1-16(单周)」「1-16周单」「单1-16周」都认，
    //      标记只跟它自己那一段走。上游 parseWeeks 也认这些位置（对单/双用 includes），这里保留并用 fixture 钉住；
    //      上游真会走错的是：「～」只取第 1 周；「(3)」「（3）」当成第 3 周；「(1-2)1-16周(双)」只得到 2 周；
    //      「1-3周 5-9周」只取第一段；「1-16周(单双周)」同段单双都写，周次为空、整门课被静默丢掉
    //   ③ 括号按内容分三种：纯数字是教学班序号（"(1)"、"(1-2)"），整段摘掉并计数，
    //      免得 "(1-2)" 被当成第 1-2 周；带「周」或单双的（"(1-16周)"、"(单)"）保留内容；
    //      其它字（"(3组)"）是备注，整段摘掉并提醒（见 weeksOf）
    //   ④ 必需字段是课名、星期（1-7）、节次、周次。缺任一就整行跳过，跳过的行按原因分类计数写进 warnings，不静默；
    //      上游 parseApiData 的丢课条件也就是这四项，而且是静默丢。缺教师或缺教室它不丢，而是填「未知」「待定」（见 ⑤）；
    //      这里教师与教室缺了照样导入，只留 null
    //   ⑤ 上游 teacher 缺省写「未知」、position 缺省写「待定」，这里一律留 null：
    //      课表会把占位词当成真名或真地点显示出来
    //   ⑥ 节次：上游只认 "a-b"（以及 "a~b" / "a至b"）且只取第一段；这里再认「第9-10节」、"1,2"、两位一拼的 "0102"，
    //      多段（"1-2,5-6"）按最大跨度放入并说明
    //   ⑦ 作息：优先取教务的校区作息，拿不到回落到上游 TIME_SLOTS（11 节）。课表用到作息表之后的节次时，
    //      内置 12 节表里有这一节且它不早于上一节下课才用内置时间，否则在上一节下课后顺推（课间 5 分钟、每节 45 分钟），
    //      顺推越过当天 23:59 就不再补；补过的节次都写进 warnings
    //   ⑧ 开学日与总周数：上游没有开学日，总周数是课表里的最大周次；这里优先取学期周次校历，
    //      取不到就推算开学日并如实说明，总周数取 20 周兜底、课表周次更大时抬高（都写进 warnings）
    //   ⑨ 学期名取教务下拉框的学年学期，不拿适配器名当学期名（手册 §4.7）
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var raw = data.raw || {};
    var rows = Array.isArray(raw.kbList) ? raw.kbList : [];
    var practiceRows = Array.isArray(raw.sjkList) ? raw.sjkList : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据（回落作息表只有 11 节，内置表 12 节）
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务校历取不到时的兜底总周数（上游没有固定总周数，这里按 20 周）
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字

    // 作息表（上游 CWXU/cwxu_01.js 的 TIME_SLOTS，11 节，与上游逐节一致；本校实际作息未知）。
    // 只在教务的作息接口取不到可用数据时使用，用了就写进 warnings。
    var SCHOOL_PERIOD_TIMES = [
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
        { periodIndex: 11, start: '20:35', end: '21:20' }
    ];

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到的节次超出作息表时
    // 用它把缺的节次补出来（载荷带了 periodTimes 时应用不会自己补），补不了就写进 warnings。
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
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到「第 1 周的第一天」那一周的周一（含当天），
    // 上游的 firstDayOfWeek = 1（周一）就是同一个意思。
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '夏季学期 = 7 月 1 日所在周的周一' }
    };

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

    // 任意形态的日期 → ISO 日期（只认年月日，后面的时间/星期部分忽略）
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

    // 分钟数 → "HH:mm"（顺推补时间用，调用方保证不超过 23:59）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    // 教务接口的返回可能是裸数组，也可能外面包一层对象（例如 rows、datas 这类信封字段）。
    // extract.js 原样交出来，这里按「最像行数组的那一层」找；找不到就返回空数组，
    // 调用方据此回落到推算并如实写进 warnings。
    function rowsIn(value) {
        if (Array.isArray(value)) return value;
        if (!value || typeof value !== 'object') return [];
        var keys = ['rows', 'datas', 'data', 'list', 'items', 'kbList'];
        var i;
        for (i = 0; i < keys.length; i++) {
            var known = rowsIn(value[keys[i]]);
            if (known.length) return known;
        }
        for (var key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            var found = rowsIn(value[key]);
            if (found.length) return found;
        }
        return [];
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

    // ---------- 学期名与学期序号 ----------
    // 优先看教务下拉框的文本（「一/二/三」），认不出来再看正方自己的学期代号
    // （正方 jwglxt：3 = 第一学期、12 = 第二学期、16 = 第三学期；个别部署写成 1 / 2）
    function termKind() {
        var label = text(term.xqmText);
        if (label.indexOf('二') >= 0) return 'second';
        if (label.indexOf('三') >= 0) return 'third';
        if (label.indexOf('一') >= 0) return 'first';
        var code = text(term.xqm);
        if (code === '12' || code === '2') return 'second';
        if (code === '16') return 'third';
        return 'first';
    }

    function termYear() {
        return /^[0-9]{4}$/.test(text(term.xnm)) ? parseInt(text(term.xnm), 10) : 0;
    }

    function yearLabel() {
        var label = text(term.xnmText);
        if (/^[0-9]{4}-[0-9]{2,4}$/.test(label)) return label;
        var year = termYear();
        if (year) return year + '-' + (year + 1);
        // 学年读不出来就返回空串，由 termName 改用学校名兜底
        return '';
    }

    // 学期名用教务自己的学年学期（手册 §4.7：别拿适配器名当学期名）；学年读不出来时用学校名 + 第几学期
    function termName() {
        var whole = text(term.xqmText);
        // 有的学校把整个「2026-2027学年第一学期」放进学期下拉框
        if (whole && whole.indexOf('学年') >= 0 && whole.indexOf('学期') >= 0) return whole;
        var year = yearLabel();
        if (!year) return '无锡学院第' + KIND_CN[termKind()] + '学期';
        return year + '学年第' + KIND_CN[termKind()] + '学期';
    }

    // 教务校历取不到时的开学日推算。依赖学期序号的锚点，推算结果一律写进 warnings。
    function estimateStart(todayIso) {
        var anchor = KIND_ANCHOR[termKind()];
        var kind = termKind();
        var year = termYear();
        if (!year) {
            // 学年读不出来（课表页被改过）时退回「今天的周一」。这条分支依赖当天日期，
            // 不要写进 fixture 用例 —— 用例会随日期失效
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天的周一' };
        }
        return {
            iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), anchor.month, anchor.day)),
            rule: anchor.rule
        };
    }

    // 校历万一给的是别的学期（例如接口忽略了 xnm / xqm），宁可按推算走 + 说出来，
    // 也不要悄悄写一个错日期：开学日错了整学期的课都会错位。
    function plausibleStart(iso) {
        var year = termYear();
        if (!year) return true;
        var kind = termKind();
        var anchor = KIND_ANCHOR[kind];
        var anchorYear = kind === 'first' ? year : year + 1;
        var target = Date.UTC(anchorYear, anchor.month - 1, anchor.day);
        var value = Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        );
        if (isNaN(target) || isNaN(value)) return true;
        return Math.abs(value - target) <= 45 * 86400000;
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。正方见到的写法：
    //   "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-16(单周)" / "1-3,5-9周" / "17周" / "1-3周 5-9周"
    //   / "周数：1-16周(单)" / "第1~16周" / "1至16周"
    // 四个必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单/双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //      万一标记自己成了一段（"1-16周,双"），并给最近的周次段，不丢；
    //   ③ 括号按内容分三种：纯数字是教学班序号（"(1)"、"(1-2)"），整段摘掉并计数；带「周」或单双的（"(1-16周)"、"(单)"）保留内容；其它字（"(3组)"）是备注，整段摘掉并提醒。括号在删「周」之前处理，剩下落单的括号换成逗号，不删（否则两侧数字会粘成 "1-161"）；
    //   ④ 空白两头都要顾：破折号**连同两侧的空白**先归一成半角 '-'（"1 -16周(单)"、"1- 16周" 这类
    //      区间带空格的写法，不归一就会被切段劈成两块）；剩下的空白**当分段符**折成逗号 ——
    //      "1-16周 双" 的标记自成一段、"1-3周 5-9周" 是两段。先全文删空白会把 "1-3周 5-9周"
    //      拼成 "1-35" → 1-30 全周，静默吞掉一段（本批统一口径，与 xawl 一致）。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单/双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3组)」，不是周次）
    var noteSample = '';     // 第一个备注括号的原文，写进提醒里给用户看
    var bothMarks = 0;       // 同时写了「单」和「双」的段数（按每周都上处理，要说出来）

    function fullWidthToHalf(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[，、；;]/g, ',')
            .replace(/[～~—－–至]/g, '-');
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // ① 「周数：」「周数:」前缀整段删掉（冒号全角半角都认）；「第」字删掉（「第1-16周」）
        cleaned = cleaned.replace(/周数\s*[:：]?/g, '').replace(/第/g, '');
        // ④ 第一步：破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'，
        //    "1 -16周(单)" / "1- 16周" / "1～16周" / "1至16周" 都归成标准形态。**不要在这里删掉全部空白**。
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 括号先于删「周」处理，按内容分三种（规则见上面 weeksOf 的文档注释 ③）：只有数字 / 区间 / 逗号 = 教学班序号，整组删并计数；
        // 含有数字、空白、逗号、连接号、单、双、周、第以外的字（如「(3组)」）= 备注，整组删并计数（写进提醒）；其余（如「(1-16周)」「(单)」）保留内容
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周第-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = all;
                return ',';
            }
            return ',' + inner + ',';
        });
        // 第 3 步：剩下落单的括号字符换成逗号，不许直接删（删了会让 "1-8周(9-12" 粘成 "1-89-12"，换成逗号得到 "1-8,9-12"）
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        // ④ 第二步：剩下的空白当分段符折成逗号（fullWidthToHalf 已把全角逗号 / 顿号 / 分号折成半角逗号）
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
        // 单/双自己成一段时并给最近的周次段（就近向前找，找不到再向后）
        for (i = 0; i < segments.length; i++) {
            if (/[0-9]/.test(segments[i])) continue;
            if (segments[i].indexOf('单') < 0 && segments[i].indexOf('双') < 0) continue;
            var into = -1;
            var near;
            for (near = i - 1; near >= 0; near--) {
                if (/[0-9]/.test(segments[near])) { into = near; break; }
            }
            for (near = i + 1; into < 0 && near < segments.length; near++) {
                if (/[0-9]/.test(segments[near])) { into = near; break; }
            }
            if (into < 0) { orphanMarkers++; continue; }
            segments[into] = segments[into] + segments[i];
            segments[i] = '';
        }
        var seen = {};
        var weeks = [];
        for (i = 0; i < segments.length; i++) {
            var segment = segments[i];
            if (!segment || !/[0-9]/.test(segment)) continue;
            var onlyOdd = segment.indexOf('单') >= 0;
            var onlyEven = segment.indexOf('双') >= 0;
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空，那才是真丢数据）；
            // 这是个判断不是事实，所以计数后写进 warnings
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:[ ]*-[ ]*[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                for (var week = start; week <= end; week++) {
                    if (onlyOdd && week % 2 === 0) continue;
                    if (onlyEven && week % 2 === 1) continue;
                    if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
                    if (!seen[week]) { seen[week] = true; weeks.push(week); }
                }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
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

    // ---------- 节次 ----------
    // 节次文本 → {start, end, sparse}；读不出来返回 null（调用方计数进 warnings，不静默丢课）。
    // 认得的写法：正方的 "1-2" / "3-4节" / "第9-10节" / "1,2"，以及个别部署把每节占两位拼成的
    // "0102"（= 第 1、2 节）。括号里的纯数字是序号不是节次，先摘掉。
    var sparseRows = 0;   // 节次写成多段（"1-2,5-6"）的行数
    function sectionsOf(row) {
        var source = text(row.jcs);
        if (!source) return null;
        var cleaned = fullWidthToHalf(source)
            .replace(/\([ ]*[0-9]+[ ]*\)/g, '')
            .replace(/节/g, '')
            .replace(/[ ]+/g, '');
        var pieces = cleaned.split(/,+/);
        var numbers = [];
        var i;
        for (i = 0; i < pieces.length; i++) {
            var piece = pieces[i];
            if (!piece) continue;
            var range = /^第?([0-9]{1,2})[-]([0-9]{1,2})$/.exec(piece);
            if (range) {
                var from = parseInt(range[1], 10);
                var to = parseInt(range[2], 10);
                if (to < from) { var swap = from; from = to; to = swap; }
                for (var n = from; n <= to; n++) numbers.push(n);
                continue;
            }
            if (/^第?[0-9]{1,2}$/.test(piece)) {
                numbers.push(parseInt(piece.replace(/[^0-9]/g, ''), 10));
                continue;
            }
            if (/^[0-9]{4}$/.test(piece)) {
                numbers.push(parseInt(piece.substring(0, 2), 10));
                numbers.push(parseInt(piece.substring(2), 10));
                continue;
            }
            return null;
        }
        if (!numbers.length) return null;
        var start = numbers[0];
        var end = numbers[0];
        var unique = [];
        var seen = {};
        for (i = 0; i < numbers.length; i++) {
            var value = numbers[i];
            if (value < start) start = value;
            if (value > end) end = value;
            if (!seen[value]) { seen[value] = true; unique.push(value); }
        }
        if (start < 1 || end > MAX_PERIOD) return null;
        unique.sort(function (a, b) { return a - b; });
        var sparse = false;
        for (i = 1; i < unique.length; i++) {
            if (unique[i] - unique[i - 1] !== 1) sparse = true;
        }
        if (sparse) sparseRows++;
        return { start: start, end: end, sparse: sparse };
    }

    // ---------- 教务的学期周次校历与作息时间（extract.js 另取的，取不到就是 null） ----------
    // 校历：一行一周，zs / zsmc = 第几周，日期字段各部署叫法不一（zrq / zcrq / rq / ksrq）
    function calendarInfo(value) {
        var list = rowsIn(value);
        var info = { firstIso: null, weeks: 0, rejectedIso: null };
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var week = intOf(row.zs);
            if (week === null) week = intOf(row.zsmc);
            var iso = isoOfAny(row.zrq) || isoOfAny(row.zcrq) || isoOfAny(row.rq) || isoOfAny(row.ksrq);
            if (week === null || week < 1 || !iso) continue;
            if (week > info.weeks) info.weeks = week;
            if (week === 1) {
                if (plausibleStart(iso)) info.firstIso = iso;
                else info.rejectedIso = iso;
            }
        }
        // 第 1 周日期被判为别的学期：这份校历整个作废，它给的周数也不能拿来定学期总周数
        if (!info.firstIso && info.rejectedIso) info.weeks = 0;
        return info;
    }

    // 作息：一行一节，jcmc / jc = 节次，qssj / jssj = 起止时间。要求从第 1 节起连续、
    // 时间递增不重叠、且都落在 00:00–23:59 —— 不满足就当没取到（回落到内置表并说明），不猜。
    function periodTimesOf(value) {
        var list = rowsIn(value);
        var slots = [];
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var index = intOf(row.jcmc);
            if (index === null) index = intOf(row.jc);
            var start = timeOf(row.qssj);
            var end = timeOf(row.jssj);
            if (index === null || !start || !end) return null;
            if (minutesOf(start) >= minutesOf(end)) return null;
            slots.push({ periodIndex: index, start: start, end: end });
        }
        if (!slots.length) return null;
        slots.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        var lastEnd = -1;
        for (var k = 0; k < slots.length; k++) {
            if (slots[k].periodIndex !== k + 1) return null;
            if (minutesOf(slots[k].start) < lastEnd) return null;
            lastEnd = minutesOf(slots[k].end);
        }
        return slots;
    }

    // ---------- 逐行转换 ----------
    var courses = [];
    var byName = {};
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var weekSamples = [];   // 没解析出周次的原始文本，最多留 3 个，写进 warnings 方便反馈
    var maxWeek = 0;
    var maxPeriod = 0;

    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + (teacher || '');
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, note: null, blocks: [], seen: {} };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};

        var name = text(row.kcmc);
        if (!name) { missing.name++; continue; }

        var day = intOf(row.xqj);
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOf(row);
        if (!sections) { missing.period++; continue; }

        var weeks = weeksOf(row.zcd);
        if (!weeks.length) {
            missing.week++;
            var sample = text(row.zcd);
            if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
            continue;
        }

        // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）
        var teacher = text(row.xm) || null;
        var location = text(row.cdmc) || null;
        var course = courseOf(name, teacher);

        var runs = runsOf(weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            var blockKey = day + '|' + sections.start + '|' + sections.end + '|' + run.start + '|' +
                run.end + '|' + run.weekType + '|' + (location || '');
            if (course.seen[blockKey]) continue;   // 完全重复的排课行：同一条安排只留一条
            course.seen[blockKey] = true;
            if (run.end > maxWeek) maxWeek = run.end;
            if (sections.end > maxPeriod) maxPeriod = sections.end;
            course.blocks.push({
                dayOfWeek: day,
                startPeriod: sections.start,
                endPeriod: sections.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: location
            });
        }
    }

    if (!courses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开「信息查询 - 学生课表查询」确认能看到课表后再试'
        );
    }

    // 去重用的 seen 是内部账本，不进载荷
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
    var calendar = calendarInfo(data.calendar);
    var apiPeriodTimes = periodTimesOf(data.periodTimes);

    var start;
    if (calendar.firstIso) {
        start = { iso: mondayOfIso(calendar.firstIso), rule: '教务校历' };
    } else {
        start = estimateStart(todayIso);
    }

    // 课表接口不给总周数（上游 cwxu_01.js 不写死总周数，直接取课表里的最大周次）。校历给得出就先用校历，
    // 取不到用 SCHOOL_TOTAL_WEEKS 兜底；但课表里更晚的周次必须放得下（endWeek 超过 totalWeeks 会被
    // 载荷校验拒掉），抬高时单独说明。
    var calendarWeeks = calendar.weeks > 0 ? calendar.weeks : 0;
    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }
    if (totalWeeks < 1) totalWeeks = SCHOOL_TOTAL_WEEKS;

    // ---------- 作息时间：教务的优先，课表用到的节次补齐 ----------
    // 作息表（教务给的，或本校内置的）之后、课表用到的每一节：内置表里有这一节、且它不早于上一节下课，就用内置表的时间；
    // 否则在上一节下课后顺推（课间 5 分钟、每节 45 分钟），顺推越过当天 23:59 就从这一节起不再补（课程照常导入）
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    var LAST_MINUTE = 23 * 60 + 59;
    var periodTimes = (apiPeriodTimes ? apiPeriodTimes : SCHOOL_PERIOD_TIMES).slice(0);
    var tableLength = periodTimes.length;
    var added = [];          // 补出来的节次：{ periodIndex, fromBuiltin }，按节次顺序
    var uncoveredFrom = 0;   // 顺推越过 23:59 时，从这一节起不再补
    for (var p = tableLength + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var builtin = BUILTIN_PERIOD_TIMES[p - 1];
        if (builtin && minutesOf(builtin.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: builtin.start, end: builtin.end });
            added.push({ periodIndex: p, fromBuiltin: true });
            continue;
        }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > LAST_MINUTE) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        added.push({ periodIndex: p, fromBuiltin: false });
    }


    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    warn(
        '只导入了教务系统当前选中的学期（' + name0 +
        '）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」'
    );

    if (calendar.firstIso) {
        warn('开学日期取自教务系统的学期周次校历：第 1 周从 ' + start.iso + ' 开始，请在学期管理里核对');
    } else if (calendar.rejectedIso) {
        warn(
            '教务校历给出的开学日期（' + calendar.rejectedIso + '）不属于这个学期，已忽略；第 1 周按「' +
            start.rule + '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start.rule +
            '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raisedBySchedule && calendarWeeks > 0) {
        warn(
            '教务校历写的一学期是 ' + calendarWeeks + ' 周，课表里有第 ' + maxWeek + ' 周的课，已按 ' +
            totalWeeks + ' 周导入（否则第 ' + (calendarWeeks + 1) + ' 周起的课放不下）'
        );
    } else if (raisedBySchedule) {
        // 校历没给周数或被作废：不能写「一学期是 0 周」
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过适配器内置的 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入，如与实际不符可在学期管理里改'
        );
    } else if (calendarWeeks > 0) {
        warn(
            '学期总周数取自教务校历（' + totalWeeks + ' 周）' +
            (clamped ? '，已按最多 ' + MAX_WEEK + ' 周导入' : '') + '，如与实际不符可在学期管理里改'
        );
    } else if (calendar.rejectedIso) {
        warn(
            '教务校历不属于这个学期（见上一条），学期总周数按适配器内置的 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期校历，学期总周数按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (!apiPeriodTimes) {
        warn(
            '教务系统没有给出节次时间，已按适配器内置的 ' + SCHOOL_PERIOD_TIMES.length +
            ' 节节次时间导入（第 1 节 ' + SCHOOL_PERIOD_TIMES[0].start + '-' + SCHOOL_PERIOD_TIMES[0].end +
            '），时间可能与学校实际作息不符，请在学期管理里核对'
        );
    }
    // 节次号：连续多节写成「第 9-12 节」，只有一节写「第 9 节」
    function sectionsText(from, to) {
        return from === to ? '第 ' + from + ' 节' : '第 ' + from + '-' + to + ' 节';
    }

    // 补了时间的节次：同一来源连续的节次合成一段，按节次顺序说明（只出现实际用到的那一种）
    if (added.length) {
        var notes = [];
        var runFrom = 0;
        var runEnd = 0;
        var runBuiltin = false;
        for (var a = 0; a <= added.length; a++) {
            var item = added[a];
            if (item && runFrom && item.fromBuiltin === runBuiltin && item.periodIndex === runEnd + 1) {
                runEnd = item.periodIndex;
                continue;
            }
            if (runFrom) {
                notes.push(sectionsText(runFrom, runEnd) +
                    (runBuiltin ? '用空课默认作息' : '按上一节下课后课间 5 分钟、每节 45 分钟顺推'));
            }
            if (item) { runFrom = item.periodIndex; runEnd = item.periodIndex; runBuiltin = item.fromBuiltin; }
        }
        warn(
            '课表用到了作息表里没有的' + sectionsText(tableLength + 1, added[added.length - 1].periodIndex) +
            '，已补上时间：' + notes.join('；') + '，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    // 取数是否取全：正方这个接口一次性返回整学期排课，本来没有分页；但响应里带了记录总数时
    // 必须对账 —— 取到的比总数少说明响应被截断/被挡了，要出声（手册：取不全要说）
    var reportedTotal = intOf(data.total);
    if (reportedTotal !== null && reportedTotal > rows.length) {
        warn(
            '教务系统说这个学期有 ' + reportedTotal + ' 条排课记录，实际只取到 ' + rows.length +
            ' 条，课表可能不完整，请重试或反馈'
        );
    }

    // 集中实践课：教务单独给的一批课，只有课名与起止周，没有星期节次，排不进周课表 —— 但不能吞掉
    var practiceNames = [];
    for (var q = 0; q < practiceRows.length; q++) {
        var practiceName = text(practiceRows[q] && practiceRows[q].kcmc);
        if (practiceName && practiceNames.indexOf(practiceName) < 0) practiceNames.push(practiceName);
    }
    if (practiceNames.length) {
        var shown = practiceNames.slice(0, 3).join('、');
        if (practiceNames.length > 3) shown = shown + ' 等';
        warn(
            '教务系统另外给了 ' + practiceNames.length + ' 门集中实践课（' + shown +
            '）：它们没有固定的星期与节次，排不进周课表，请自行在学期里添加'
        );
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 行');
        if (missing.period) reasons.push('缺节次（或节次超出 1-' + MAX_PERIOD + ' 节）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (weekSamples.length) reasons.push('认不出的周次写法如「' + weekSamples.join('」「') + '」');
        warn(
            '有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }
    if (serialGroups > 0) {
        warn(
            '有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，' +
            '已忽略，请核对这几门课的周次'
        );
    }
    if (noteGroups > 0) {
        warn(
            '有 ' + noteGroups + ' 处周次后面的括号备注（如「' + noteSample + '」）不是周次，已忽略'
        );
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    }
    if (orphanMarkers > 0) {
        warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次（教务数据写得不完整），这些标记已忽略');
    }
    if (bothMarks > 0) {
        warn(
            '有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对'
        );
    }
    if (sparseRows > 0) {
        warn(
            '有 ' + sparseRows + ' 行课表的节次写成了多段（例如「1-2,5-6」），已按最大跨度放入' +
            '（中间几节也算上），请核对'
        );
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
