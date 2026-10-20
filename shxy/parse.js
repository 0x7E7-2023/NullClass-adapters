(function () {
    // 绥化学院教务适配器（乘方智慧教务，jwgl.shxy.edu.cn）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 SHXY/shxy.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf
    //
    // 上游在同一段脚本里问学年学期、发请求、拼课程、存节次时间；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交出来的是教务行里 parse 用得到的八个字段，外加学期代码、第 1 周日期与校区。
    // 通用部分（周次写法、同课合并、提醒限长、节次补齐）照批次十已审计的 swu；取数与按教室拆课按上游 SHXY/shxy.js 重写。
    //
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① 按教室拆课：上游 jxcdmc2 形如「教室-周次,教室-周次,…」，逐段按最后一个「-」切成教室与周次，同一教室的周次归到一起，
    //      每个教室一条课；课表周次取自这里（不看 zc）。移植时补了三处上游没有的防护：周次必须是 1-30 的整数
    //      （上游 Number("101") 会把「A-101」这种没带周次的教室名读成第 101 周）；教室名为空照常导入（地点留空，不写「未知地点」）；
    //      zc 里有、jxcdmc2 里没有的周次，用 jxcdmc 的教室补上，不静默丢周；
    //   ② jxcdmc2 读不出任何一段（上游「兜底方案」）时：周次取 zc，教室取 jxcdmc。上游只把 zc 当逗号分隔的数字列表读；
    //      这里在此之外还认「1-16周」「(单)」「(双)」「第1-第8周」「共 N 周」这类常见写法（照 swu 的 weeksOf），认不出的计数进提醒；
    //   ③ 上游要求课名 / 星期 / 起止节次都在，缺了整行静默丢弃，开始节次大于结束节次也静默丢弃：这里按原因计数写进提醒；
    //      教师、教室没有就留空，不写「未知教师」「未知地点」（那会被课表当成真名显示），按类型汇总进提醒；
    //   ④ 节次时间：上游让用户选「老校区（厚德楼）/新校区（崇德楼）」，各写死一张 10 节表（逐节照抄成 OLD_PERIOD_TIMES /
    //      NEW_PERIOD_TIMES）。校区先看上课教室（全是厚德楼 / 全是崇德楼），判断不了再看 extract.js 问到的答案，
    //      都没有就按上游默认的老校区，提醒里说明用了哪个校区；课表用到第 10 节之后时，空课默认 12 节表里同号且接得上的就用它，
    //      接不上的在上一节下课后顺推，顺推越过 23:59 的如实说明（批次五统一修订 H3）；
    //   ⑤ 开学日与总周数上游没存：开学日取教务的第 1 周日期（extract.js 另取的 getDatesOfWeek，同平台 CMC 脚本在用），
    //      取不到才推算并写 warnings（宁可推算说明，也不写错日期）；总周数按「不少于 20 周、不早于课表最晚周次」给并说明；
    //   ⑥ 学期名取教务下拉框里的学年学期文字，读不出用学期代码拼「YYYY-YYYY学年第N学期」，不拿适配器名当学期名；
    //   ⑦ 同课合并：上游不合并（同一门课的连续节次、同节次不同周次都是各自一条）。这里照 swu 补上两阶段合并
    //      （连续节次合并 + 同节次周次并集），先去掉完全相同的行；不丢课、不改任何一周的安排；
    //   ⑧ 上游的导出流程（开场弹窗、学年学期弹窗、saveImportedCourses、savePresetTimeSlots、showToast、notifyTaskCompletion）
    //      全部不移植：这些是「拾光」的桥能力，空课由宿主负责保存，适配器只交载荷。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据（本校节次 10 节）
    var SCHOOL_NAME = '绥化学院';       // 学期名兜底时用（拿不到学年时「学校名 + 学年学期」，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给学期总周数，上游也没存；按 20 周给并在提醒里说明
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟

    // 老校区（厚德楼）节次时间：上游 SHXY/shxy.js 的 CampusTimeSlots["老校区(厚德楼)"]，逐节照抄原值。
    var OLD_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:10', end: '08:55' },
        { periodIndex: 2, start: '09:00', end: '09:45' },
        { periodIndex: 3, start: '10:15', end: '11:00' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '13:45', end: '14:30' },
        { periodIndex: 6, start: '14:35', end: '15:20' },
        { periodIndex: 7, start: '15:40', end: '16:25' },
        { periodIndex: 8, start: '16:30', end: '17:15' },
        { periodIndex: 9, start: '18:30', end: '19:15' },
        { periodIndex: 10, start: '19:20', end: '20:05' }
    ];

    // 新校区（崇德楼）节次时间：上游 CampusTimeSlots["新校区(崇德楼)"]，逐节照抄原值。
    // 与老校区只有第 3、4、7、8 节不同（10:30-11:15、11:20-12:05、15:55-16:40、16:45-17:30）。
    var NEW_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:10', end: '08:55' },
        { periodIndex: 2, start: '09:00', end: '09:45' },
        { periodIndex: 3, start: '10:30', end: '11:15' },
        { periodIndex: 4, start: '11:20', end: '12:05' },
        { periodIndex: 5, start: '13:45', end: '14:30' },
        { periodIndex: 6, start: '14:35', end: '15:20' },
        { periodIndex: 7, start: '15:55', end: '16:40' },
        { periodIndex: 8, start: '16:45', end: '17:30' },
        { periodIndex: 9, start: '18:30', end: '19:15' },
        { periodIndex: 10, start: '19:20', end: '20:05' }
    ];

    var CAMPUSES = [
        { name: '老校区（厚德楼）', times: OLD_PERIOD_TIMES },
        { name: '新校区（崇德楼）', times: NEW_PERIOD_TIMES }
    ];

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到的节次超出节次时间表时，
    // 内置表里有这一节、且开始不早于上一节下课，就用它的时间；接不上的按顺推补（载荷带了 periodTimes 时应用不会自己补）。
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

    // 推算开学日的锚点：第一学期多在 9 月初、第二学期多在 2 月下旬、短学期 7 月初。
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到「第 1 周的第一天」（这里每周从周一开始）。
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '短学期 = 7 月 1 日所在周的周一' }
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

    // 该日期所在周的周一（教务 xq 1..7 = 周一..周日）：从该日往回数到周一（用 UTC 算，避免时区把日期挪一天）
    function weekStartOf(iso) {
        var weekday = 1;
        if (!iso) return null;
        var date = new Date(Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        ));
        var dayNo = (date.getUTCDay() + 6) % 7 + 1;   // 周一 = 1 … 周日 = 7
        var back = (dayNo - weekday + 7) % 7;
        return isoOf(new Date(date.getTime() - back * 86400000));
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

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    // 教务接口的返回可能是裸数组，也可能套一层信封（{rows:[]} / {code:0,datas:{…}}）。
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
    // 学期代码 = 学年起始年份 4 位 + 学期号 2 位（01 第一学期 / 02 第二学期 / 03 短学期），与上游拼 xnxqdm 的写法一致
    var TERM_PARTS = /^([0-9]{4})([0-9]{2})$/.exec(text(term.code));
    var TERM_SUFFIX = { '01': '第一学期', '02': '第二学期', '03': '短学期' };

    function termKind() {
        if (!TERM_PARTS) return 'first';
        if (TERM_PARTS[2] === '02') return 'second';
        if (TERM_PARTS[2] === '03') return 'third';
        return 'first';
    }

    function termYear() {
        return TERM_PARTS ? parseInt(TERM_PARTS[1], 10) : 0;
    }

    // 学期名用教务自己的学年学期（手册 §4.7：别拿适配器名当学期名）：下拉框文字像「2026-2027学年第一学期」就直接用，
    // 否则用学期代码拼；代码也不对才退回「学校名 + 学年学期」
    function termName() {
        var label = text(term.label);
        if (label.length <= 40 && label.indexOf('学年') >= 0 && label.indexOf('学期') >= 0) return label;
        var year = termYear();
        var suffix = TERM_PARTS ? TERM_SUFFIX[TERM_PARTS[2]] : '';
        if (!year || !suffix) return SCHOOL_NAME + ' 学年学期';
        return year + '-' + (year + 1) + '学年' + suffix;
    }

    // 开学日推算（教务没给第 1 周日期时）：依赖学期序号的锚点，推算结果一律写进 warnings。
    function estimateStart(todayIso) {
        var kind = termKind();
        var anchor = KIND_ANCHOR[kind];
        var year = termYear();
        if (!year) {
            // 学期代码读不出来时退回「今天所在周的周一」。这条分支依赖当天日期，不要写进 fixture 用例 —— 用例会随日期失效
            return { iso: weekStartOf(todayIso) || todayIso, rule: '今天所在周的周一' };
        }
        var anchorIso = isoOf(new Date(Date.UTC(year + (kind === 'first' ? 0 : 1), anchor.month - 1, anchor.day)));
        return { iso: weekStartOf(anchorIso), rule: anchor.rule };
    }

    // 教务给的第 1 周日期万一是别的学期的，宁可按推算走 + 说出来，也不要悄悄写一个错日期：
    // 开学日错了整学期的课都会错位。判据：离这个学期的锚点日期不超过 45 天。
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
    // 周次文本 → 周次集合（去重、升序）。教务里常见的写法：
    //   "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-16(单周)" / "1-3,5-9周" / "17周" / "1-3周 5-9周"
    // 四个必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单/双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //      万一标记自己成了一段（"1-16周,双"），并给最近的周次段，不丢；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉，免得被当成第 1-2 周；
    //      含非周次字的（"(3组)"）也摘掉，计数后写进 warnings；其它（"(1-16周)"、"(单)"）保留内容；每组都换成逗号，数字不会粘连；
    //   ④ 空白两头都要顾：破折号**连同两侧的空白**先归一成半角 '-'（"1 -16周(单)"、"1- 16周" 这类
    //      区间带空格的写法，不归一就会被切段劈成两块）；剩下的空白**当分段符**折成逗号 ——
    //      "1-16周 双" 的标记自成一段、"1-3周 5-9周" 是两段。先全文删空白会把 "1-3周 5-9周"
    //      拼成 "1-35" → 1-30 全周，静默吞掉一段（本批统一口径，与 xawl 一致）。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单/双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3组)」，含非周次的字，不是周次）
    var noteSample = '';     // 第一个备注括号的原文，写进提醒
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
        // 同批统一修正：周次里常夹着「共8周」这类课程总周数备注，它不是上课周次，只剥备注本身；
        // 不能从第一个「共」一路删到行尾 —— 「1-8周(共8周),9-16周」后面的 9-16 周会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // ④ 第一步：破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'，
        //    "1 -16周(单)" / "1- 16周" / "1～16周" / "1至16周" 都归成标准形态。**不要在这里删掉全部空白**。
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 同批统一修正（模板缺陷）：紧挨周次的单/双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上；
        //   这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"，标记就跟着自己那一段走
        //   前缀只认在段首（字符串开头或分隔符之后）：标记前面紧挨着数字或「周」（中间可有空白）时它是上一段的后缀，
        //   "1-8周(单) 9-16周(双)" 里的 "(单)" 不能被后面的 "9" 抢去当前缀；后缀后面紧跟下一段的数字时补一个逗号隔开
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            if (/[0-9周]\s*$/.test(whole.substring(0, offset))) return all;
            return mark;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var glue = /^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '';
            return digit + mark + glue;
        });
        // 括号先于删「周」逐组处理（全角括号已在上一步归成半角）：
        // 只有数字的（"(1)"、"(1-2)"、"(1,2)"）是教学班序号，整组摘掉；含非周次字的（"(3组)"、"(实验)"）是备注，也摘掉，另计一个数；
        // 其余（"(1-16周)"、"(单)"、"(双周)"）保留内容。每一组都换成逗号，不让两侧的数字粘在一起
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
        cleaned = cleaned.replace(/[()]/g, ',');   // 剩下落单的括号字符（没有闭合）也换成逗号，不许直接删
        cleaned = cleaned.replace(/周/g, '');
        // 区间终点前的「第」（上游接受「第1-第8周」）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
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
    // 教务行的起止节次是 ps / pe 两个数字字段（上游 Number(raw.ps) / Number(raw.pe)）。读不出数字、小于 1、超出单日上限、
    // 或开始晚于结束，返回 null（调用方计数进 warnings，不静默丢课；上游对最后一种静默丢弃）。
    function sectionsOf(row) {
        var start = intOf(text(row.ps));
        var end = intOf(text(row.pe));
        if (start === null || end === null) return null;
        if (start < 1 || end > MAX_PERIOD || start > end) return null;
        return { start: start, end: end };
    }

    // ---------- 教室与周次（jxcdmc2：「教室-周次,教室-周次,…」） ----------
    // 逐段按最后一个「-」切成教室与周次（教室名里自己带「-」也不怕，如「实验楼A-3-5」= 教室「实验楼A-3」第 5 周）。
    // 周次必须是 1..MAX_WEEK 的整数：上游 Number() 会把没带周次的教室名「A-101」读成第 101 周，这里认不出就跳过这一段，
    // 由调用方用 zc 补周次；写了周次但超出范围的，计入「超出周数上限」。
    var ROOM_PIECE = /^(.*?)\s*-\s*([0-9]{1,3})$/;

    function roomPiecesOf(source) {
        var parts = text(source).split(/[,，]/);
        var pieces = [];
        for (var i = 0; i < parts.length; i++) {
            var part = text(parts[i]);
            if (!part) continue;
            var m = ROOM_PIECE.exec(part);
            if (!m) continue;
            var week = parseInt(m[2], 10);
            if (m[2].length > 2 || week < 1 || week > MAX_WEEK) {
                if (m[2].length <= 2) droppedWeeks++;   // 三位数当作教室名里的编号，不是周次，直接跳过
                continue;
            }
            pieces.push({ room: text(m[1]), week: week });
        }
        return pieces;
    }

    // 把一周归到某个教室名下（同名教室的周次归在一起，教室按首次出现的顺序排）
    function addRoomWeek(groups, order, room, week) {
        var key = 'r' + room;
        if (!groups[key]) {
            groups[key] = { room: room, weeks: [] };
            order.push(key);
        }
        groups[key].weeks.push(week);
    }

    // ---------- 教务给的第 1 周日期（extract.js 另取的 getDatesOfWeek，取不到就是 null） ----------
    // 一行一天：xqmc = 星期几（"1" = 周一），rq = 日期。第 1 周的周一就是开学日。
    function startFromDates(value) {
        var list = rowsIn(value);
        var info = { iso: null, rejected: null };
        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            var weekday = text(item.xqmc);
            if (weekday !== '1' && weekday !== '周一' && weekday !== '一') continue;
            var iso = isoOfAny(item.rq);
            if (!iso) continue;
            if (plausibleStart(iso)) info.iso = iso;
            else info.rejected = iso;
            break;
        }
        return info;
    }

    // ---------- 校区（决定整张节次时间表） ----------
    // 先看上课教室（与 extract.js 的 campusOfRows 同一口径，两处要一起改）：教室里只出现「厚德」（老校区）
    // 或只出现「崇德」（新校区）才算；两边都有或都没有返回 null。
    function campusOfRooms() {
        var old = false;
        var fresh = false;
        for (var i = 0; i < rows.length; i++) {
            var room = text((rows[i] || {}).jxcdmc) + ' ' + text((rows[i] || {}).jxcdmc2);
            if (room.indexOf('厚德') >= 0) old = true;
            if (room.indexOf('崇德') >= 0) fresh = true;
        }
        if (old && !fresh) return 0;
        if (fresh && !old) return 1;
        return null;
    }

    // ---------- 逐行转换 ----------
    var courses = [];
    var byName = {};
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    // 已导入、但教务没给上课教师 / 上课地点的课（按课名去重，提醒里说「N 门课」才准）
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];     // 这两类课里点名用的课名，最多 3 个
    var weekSamples = [];      // 没解析出周次的原始文本，最多留 3 个，写进 warnings 方便反馈
    var mismatchCourses = {};  // 教室记录里的周次不在课程周次里的课（按课名去重）
    var mismatchSamples = [];  // 点名用的课名，最多 3 个
    var maxWeek = 0;
    var maxPeriod = 0;

    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序；节次与周次先收成 entry，合并后再拆成 block
    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + (teacher || '');
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, blocks: [] };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    // ---------- 同课合并（对齐上游 mergeAndDistinctCourses 的两阶段语义） ----------
    // 每行收成一条 entry（课程、教师、教室、星期、起止节次、周次集合）后套三步：
    //   0：完全相同的行只留一条（dropExactDuplicates）；
    //   阶段 1：名称、教师、教室、星期、周次都一样、且节次首尾相接的合成一条；
    //   阶段 2：名称、教师、教室、星期、起止节次都一样的，周次取并集。
    // 只合并首尾相接的节次，重叠的节次保持原样（上游也是这么做的）：不丢课、不改任何一周的安排。
    var entries = [];

    // 完全相同的行（课名、教师、教室、星期、起止节次、周次都一样）只留第一条：账本记下见过的，再遇到就丢。
    // 必须在阶段 1 之前做：阶段 1 只跟当前正在合并的那一条比，合并之后才出现的重复会漏网
    // （如 1-2、3-4、3-4：第三行与第二行相同，不先去重会得到 1-4 与 3-4 两块，在 3-4 节重叠）。
    // 完全相同的两行是同一个上课安排，去掉它不算丢课。
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

    // 阶段 1（输入已按 orderStageOne 排好）
    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next)) {
                if (current.end + 1 === next.start) { current.end = next.end; continue; }
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

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};

        var name = text(row.kcmc);
        if (!name) { missing.name++; continue; }

        var day = intOf(text(row.xq));
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOf(row);
        if (!sections) { missing.period++; continue; }

        // 周次与教室：jxcdmc2 逐段写了「教室-周次」就按它来（上游的主路径），课表周次取自这里；
        // zc 里有、jxcdmc2 里没有的周次用 jxcdmc 的教室补上，不静默丢周；jxcdmc2 一段都读不出来，周次取 zc、教室取 jxcdmc（上游兜底）
        var zcWeeks = weeksOf(row.zc);
        var pieces = roomPiecesOf(row.jxcdmc2);
        var rowRoom = text(row.jxcdmc);
        var groups = {};
        var groupOrder = [];
        var covered = {};
        var pk;
        for (pk = 0; pk < pieces.length; pk++) {
            addRoomWeek(groups, groupOrder, pieces[pk].room, pieces[pk].week);
            covered[pieces[pk].week] = true;
        }
        if (pieces.length && zcWeeks.length) {
            var inZc = {};
            var zk;
            for (zk = 0; zk < zcWeeks.length; zk++) inZc[zcWeeks[zk]] = true;
            var mismatch = false;
            for (pk = 0; pk < pieces.length; pk++) {
                if (!inZc[pieces[pk].week]) mismatch = true;
            }
            if (mismatch) {
                if (!mismatchCourses['n' + name] && mismatchSamples.length < 3) mismatchSamples.push(name);
                mismatchCourses['n' + name] = true;
            }
        }
        for (var zw = 0; zw < zcWeeks.length; zw++) {
            if (!covered[zcWeeks[zw]]) addRoomWeek(groups, groupOrder, rowRoom, zcWeeks[zw]);
        }
        if (!groupOrder.length) {
            missing.week++;
            var sample = text(row.zc);
            if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
            continue;
        }

        // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
        // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
        var teacher = text(row.teaxms);
        if (!teacher) missingTeacherCourses['n' + name] = true;
        var course = courseOf(name, teacher || null);
        for (var gk = 0; gk < groupOrder.length; gk++) {
            var group = groups[groupOrder[gk]];
            if (!group.room) missingLocationCourses['n' + name] = true;
            if ((!teacher || !group.room) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
                fieldSamples.push(name);
            }
            entries.push({
                course: course,
                name: name,
                teacher: teacher,
                location: group.room,
                day: day,
                start: sections.start,
                end: sections.end,
                weeks: unionWeeks(group.weeks, [])
            });
        }
    }

    // 去完全相同的行 → 排序 → 阶段 1 → 再排序 → 阶段 2（与上游 mergeAndDistinctCourses 的两阶段一致，前面多一步去重）
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
            '请重新登录、在教务系统里确认能看到课表后再试'
        );
    }

    // 合并用的 entry 与分组表都是内部数据，不进载荷；本校教务没有课程备注，note 恒为 null
    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: null,
            blocks: courses[c].blocks
        });
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var startInfo = startFromDates(data.dates);
    var start;
    if (startInfo.iso) {
        // 教务给的是第 1 周周一的日期；仍按周一回退一次，保证开学日一定落在周一
        start = { iso: weekStartOf(startInfo.iso), rule: '教务系统' };
    } else {
        start = estimateStart(todayIso);
    }

    // 教务不给学期总周数（上游也没存）。不能早于课表里最晚的周次（endWeek 超过 totalWeeks 会被载荷校验拒掉），
    // 抬高时单独说明。
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;
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

    // ---------- 校区与节次时间：教室判断 → 提问的答案 → 上游默认的老校区；课表用到更晚的节次逐节补，补不了如实说明 ----------
    var campusIndex = campusOfRooms();
    var campusBasis = 'rooms';
    if (campusIndex === null) {
        var asked = data.campus || {};
        if (asked.index === 0 || asked.index === 1) {
            campusIndex = asked.index;
            campusBasis = 'asked';
        } else {
            campusIndex = 0;
            campusBasis = 'default';
        }
    }
    var campus = CAMPUSES[campusIndex];
    var periodTimes = campus.times.slice(0);
    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prev = periodTimes.length ? periodTimes[periodTimes.length - 1] : null;
        var prevEnd = prev ? minutesOf(prev.end) : -1;
        var builtinSlot = BUILTIN_PERIOD_TIMES[p - 1];
        // 内置表有这一节、且它的开始不早于上一节下课，才用内置时间（否则会和上一节重叠甚至倒挂）
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: builtinSlot.start, end: builtinSlot.end });
            fromBuiltin.push(p);
            continue;
        }
        // 否则从上一节下课后顺推：课间 5 分钟、每节 45 分钟；顺推越过 23:59 就停，这一节起不再补
        if (!prev) { uncoveredFrom = p; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    var source = text(term.source);
    if (source === 'page') {
        warn(
            '导入的是教务页面里选中的学期（' + name0 + '）；要导入别的学期，请先在教务页面里切换到那个学期，再点「提取课表」'
        );
    } else if (source === 'default') {
        warn(
            '导入的是教务系统默认的学期（' + name0 + '）；要导入别的学期，请先在教务课表页里切换到那个学期，再点「提取课表」'
        );
    } else if (source === 'user') {
        warn('导入的是你选的学期（' + name0 + '）');
    } else {
        warn(
            '没能从教务系统读到当前学期，已按当前日期推算为 ' + name0 +
            '；如果不对，请先在教务课表页里切换到要导入的学期，再点「提取课表」'
        );
    }

    if (startInfo.iso) {
        warn('开学日期取自教务系统：第 1 周从 ' + start.iso + ' 开始，请在学期管理里核对');
    } else if (startInfo.rejected) {
        warn(
            '教务系统给出的开学日期（' + startInfo.rejected + '）不属于这个学期，已忽略；第 1 周按「' +
            start.rule + '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start.rule +
            '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raisedBySchedule) {
        warn(
            '教务系统没有给出学期总周数，课表里最晚排到第 ' + maxWeek + ' 周，超过 ' + SCHOOL_TOTAL_WEEKS +
            ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (campusBasis === 'rooms') {
        warn(
            '你的课都排在' + (campusIndex === 0 ? '厚德楼' : '崇德楼') + '，节次时间已按' + campus.name +
            '导入；两个校区第 3、4、7、8 节的时间不同，如不是你所在的校区，请在学期管理里核对节次时间'
        );
    } else if (campusBasis === 'asked') {
        warn('节次时间已按你选的' + campus.name + '导入；两个校区第 3、4、7、8 节的时间不同');
    } else {
        warn(
            '没能确定你所在的校区，节次时间先按' + campus.name +
            '导入；另一个校区（新校区 / 崇德楼）第 3、4、7、8 节的时间不同，如你不在老校区，请在学期管理里核对节次时间'
        );
    }
    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
        warn(
            '课表用到了' + sectionsText(filledAll) + '，学校公布的节次时间没有覆盖，已补上：' + fillTexts.join('，') +
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
        if (missing.period) reasons.push('缺节次（或节次不合法）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
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
    var mismatchCount = countKeys(mismatchCourses);
    if (mismatchCount > 0) {
        var mismatchNames = [];
        for (var mn = 0; mn < mismatchSamples.length; mn++) mismatchNames.push(shortName(mismatchSamples[mn]));
        warn(
            '有 ' + mismatchCount + ' 门课的教室记录里有课程周次之外的周次（例如 ' + mismatchNames.join('、') +
            '），已按教室记录里的周次导入，请核对这几门课的周次'
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
            '有 ' + noteGroups + ' 处周次里的括号备注（如「' + noteSample + '」）不是周次，' +
            '已忽略，请核对这几门课的周次'
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
