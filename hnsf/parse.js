(function () {
    // 河南师范大学教务适配器（乘方教务，jwc.htu.edu.cn）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 HNSF/hnsf_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校目录最后一次修改 80e30cf
    //
    // 上游在同一段脚本里取数、拼课程、存节次时间；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交过来的是排课行里 parse 用得到的字段，外加学期、第 1 周日期和用户选的节次时间。
    //
    // 移植改动（周次与合并的写法照批次十已审计的 swu；逐条对得上 AUDIT.md）：
    //   ① 上游要求 kcmc / teaxms / jxcdmc / xq / ps / pe / zc 七个字段全部非空，缺一个整行丢弃（缺教师的课就这样不见了）：
    //      这里只要求课名 / 星期 / 节次 / 周次，教师与教室没有就留空，课照常导入并按类型汇总提醒，不静默丢课
    //   ② 周次：上游 zc 只认逗号分隔的数字列表，"1-16" 之类算 NaN 直接丢掉；这里在逗号列表之外还认区间、
    //      "第7周"、单 / 双标记（含挨着下一段与前面隔「第」的写法）、「共 N 周」备注（只剥备注本身），
    //      超出 1..30 周的周次丢弃并提醒
    //   ③ 周次集合按手册 §4.1 切成极大段：连续 → 每周，隔周且同奇偶 → 单周 / 双周，一门课可以有多个上课安排
    //   ④ 节次时间：上游写死三张 10 节表（建设东路 / 平原湖校区的非夏季作息与夏季作息、创新港校区），先后用两次弹窗问用户选哪张。
    //      这里由 extract.js 合成一次提问，用户选的那张随数据交过来；没选（没有提问桥 / 取消）时，若排课行带了上课起止时间，
    //      看哪张表与它们完全吻合就用哪张，判断不了就用第一张并提醒。排课行带了上课时间且与所用的表对不上时，如实提醒
    //   ⑤ 开学日：上游不取。这里用 extract.js 探到的第 1 周日期；探不到按学期推算（第一学期 = 9 月 1 日所在周的周一，
    //      第二学期 = 2 月 20 日所在周的周一），并写 warnings；探到的日期离推算值太远时当作取错了学期，也走推算
    //   ⑥ 总周数：教务不给，上游也没存；按 max(课表最晚周次, 20) 导入并提醒
    //   ⑦ 学期名：用教务学期下拉框里带「学年」「学期」的文本；没有就由学期代码推出「2025-2026学年第一学期」，推不出才用学校名
    //   ⑧ 课表用到的节次超出所用节次时间表（10 节）时，按批次五统一修订 H3 逐节补齐：空课默认节次表里同号的节次能接上就用它，
    //      接不上的在上一节下课后顺推（课间 5 分钟、每节 45 分钟），顺推越过 23:59 的如实说明
    //   ⑨ 同课合并：上游不合并。这里去掉完全相同的行，并把「课名、教师、教室、星期、起止节次都一样」的行的周次取并集
    //      （不改任何一周的安排）
    //   ⑩ 上游的导出流程（弹窗、saveImportedCourses / savePresetTimeSlots、showToast / notifyTaskCompletion）全部不移植：
    //      这些是「拾光」的桥能力，空课由宿主负责保存，适配器只交载荷
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = data.rows instanceof Array ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '河南师范大学';   // 学期名兜底时用（拿不到学年时「学校名 + 学期代码」，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给总周数，课表也排不满时的兜底
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟

    // 上游 HNSF/hnsf_01.js 里的三张 10 节表，逐节照抄原值：
    //   Non_summerTimeSlots → normal，SummerTimeSlots → summer，NewCampusTimeSlots → campus
    var TABLES = {
        normal: {
            label: '建设东路校区 / 平原湖校区 · 非夏季作息',
            times: [
                { periodIndex: 1, start: '08:00', end: '08:45' },
                { periodIndex: 2, start: '08:55', end: '09:40' },
                { periodIndex: 3, start: '10:10', end: '10:55' },
                { periodIndex: 4, start: '11:05', end: '11:50' },
                { periodIndex: 5, start: '14:30', end: '15:15' },
                { periodIndex: 6, start: '15:25', end: '16:10' },
                { periodIndex: 7, start: '16:40', end: '17:25' },
                { periodIndex: 8, start: '17:35', end: '18:20' },
                { periodIndex: 9, start: '19:30', end: '20:15' },
                { periodIndex: 10, start: '20:25', end: '21:10' }
            ]
        },
        summer: {
            label: '建设东路校区 / 平原湖校区 · 夏季作息',
            times: [
                { periodIndex: 1, start: '08:00', end: '08:45' },
                { periodIndex: 2, start: '08:55', end: '09:40' },
                { periodIndex: 3, start: '10:10', end: '10:55' },
                { periodIndex: 4, start: '11:05', end: '11:50' },
                { periodIndex: 5, start: '15:00', end: '15:45' },
                { periodIndex: 6, start: '15:55', end: '16:40' },
                { periodIndex: 7, start: '17:10', end: '17:55' },
                { periodIndex: 8, start: '18:05', end: '18:50' },
                { periodIndex: 9, start: '20:00', end: '20:45' },
                { periodIndex: 10, start: '20:55', end: '21:40' }
            ]
        },
        campus: {
            label: '创新港校区',
            times: [
                { periodIndex: 1, start: '08:30', end: '09:15' },
                { periodIndex: 2, start: '09:25', end: '10:10' },
                { periodIndex: 3, start: '10:30', end: '11:15' },
                { periodIndex: 4, start: '11:25', end: '12:10' },
                { periodIndex: 5, start: '14:00', end: '14:45' },
                { periodIndex: 6, start: '14:55', end: '15:40' },
                { periodIndex: 7, start: '16:00', end: '16:45' },
                { periodIndex: 8, start: '16:55', end: '17:40' },
                { periodIndex: 9, start: '18:40', end: '19:25' },
                { periodIndex: 10, start: '19:35', end: '20:20' }
            ]
        }
    };
    var TABLE_KEYS = ['normal', 'summer', 'campus'];

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到的节次超出所用的节次时间表时，
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

    var KIND_CN = { first: '一', second: '二', third: '三' };
    // 推算开学日的锚点：第一学期多在 9 月初、第二学期多在 2 月下旬、夏季学期 7 月初。
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到第 1 周的第一天（周一）。
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

    // 点名课名：最多 3 个，课名各自截短，用顿号连起来
    function sampleText(list) {
        var shown = [];
        for (var i = 0; i < list.length && i < 3; i++) shown.push(shortName(list[i]));
        return shown.join('、');
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

    function utcOf(iso) {
        return new Date(Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        ));
    }

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOf(iso) {
        if (!iso) return null;
        var date = utcOf(iso);
        var back = (date.getUTCDay() + 6) % 7;   // 周一 = 0 … 周日 = 6
        return isoOf(new Date(date.getTime() - back * 86400000));
    }

    function isMonday(iso) {
        return utcOf(iso).getUTCDay() === 1;
    }

    // 任意形态的日期 → ISO 日期（只认年月日，后面的时间 / 星期部分忽略）
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

    // ---------- 学期名与学期序号 ----------
    // 学期代码 = 学年起始年份 4 位 + 学期 2 位（01 第一学期 / 02 第二学期 / 03 夏季学期）
    var termCode = text(term.code).replace(/\s+/g, '');
    var termFromPage = text(term.source) === 'page';

    function termKind() {
        var m = /^[0-9]{4}([0-9]{2})$/.exec(termCode);
        if (!m) return null;
        if (m[1] === '01') return 'first';
        if (m[1] === '02') return 'second';
        if (m[1] === '03') return 'third';
        return null;
    }

    function termYear() {
        return /^[0-9]{6}$/.test(termCode) ? parseInt(termCode.substring(0, 4), 10) : 0;
    }

    // 学期名用教务自己的学年学期（手册 §4.7：别拿适配器名当学期名）
    function termName() {
        var label = text(term.name);
        if (label.indexOf('学年') >= 0 && label.indexOf('学期') >= 0) {
            return label.length > 40 ? label.substring(0, 40) : label;
        }
        var kind = termKind();
        var year = termYear();
        if (year && kind) return year + '-' + (year + 1) + '学年第' + KIND_CN[kind] + '学期';
        return SCHOOL_NAME + ' ' + (termCode || '学期');
    }

    // 开学日推算。学期序号认不出来时退回「今天所在周的周一」，这条分支依赖当天日期，不要写进 fixture
    function estimateStart(todayIso) {
        var kind = termKind();
        var year = termYear();
        if (!kind || !year) return { iso: mondayOf(todayIso) || todayIso, rule: '今天所在周的周一' };
        var anchor = KIND_ANCHOR[kind];
        var anchorIso = isoOf(new Date(Date.UTC(year + (kind === 'first' ? 0 : 1), anchor.month - 1, anchor.day)));
        return { iso: mondayOf(anchorIso), rule: anchor.rule };
    }

    // 教务给的第 1 周日期万一是别的学期的，宁可按推算走 + 说出来，也不要悄悄写一个错日期：开学日错了整学期的课都会错位
    function plausibleStart(iso) {
        var kind = termKind();
        var year = termYear();
        if (!kind || !year) return true;
        var anchor = KIND_ANCHOR[kind];
        var target = Date.UTC(year + (kind === 'first' ? 0 : 1), anchor.month - 1, anchor.day);
        return Math.abs(utcOf(iso).getTime() - target) <= 45 * 86400000;
    }

    // 第 1 周七天的日期 [{ xqmc, rq }]：取星期一那一天
    function weekOneInfo(list) {
        var info = { iso: null, rejected: null, adjusted: false };
        if (!(list instanceof Array)) return info;
        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            var label = text(item.xqmc);
            if (label !== '1' && label !== '一' && label !== '周一' && label !== '星期一') continue;
            var iso = isoOfAny(item.rq);
            if (!iso) continue;
            if (!plausibleStart(iso)) { info.rejected = iso; continue; }
            info.iso = iso;
            info.rejected = null;
            break;
        }
        // 标成「星期一」的日期实际不是周一：回退到当周周一再用，并说出来
        if (info.iso && !isMonday(info.iso)) {
            info.iso = mondayOf(info.iso);
            info.adjusted = true;
        }
        return info;
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。乘方教务的 zc 正常是逗号分隔的周次列表（"1,2,3,5"），
    // 这里照批次十 swu 的写法放宽，同时认：
    //   "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-16(单周)" / "1-3,5-9周" / "17周" / "1-3周 5-9周" / "第1-第8周"
    // 必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单 / 双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //      万一标记自己成了一段（"1-16周,双"），并给最近的周次段，不丢；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉，免得被当成第 1-2 周；
    //      含非周次字的（"(3组)"）也摘掉，计数后写进 warnings；其它（"(1-16周)"、"(单)"）保留内容；每组都换成逗号，数字不会粘连；
    //   ④ 空白两头都要顾：破折号连同两侧的空白先归一成半角 '-'（"1 -16周(单)"、"1- 16周"），
    //      剩下的空白当分段符折成逗号 —— "1-16周 双" 的标记自成一段、"1-3周 5-9周" 是两段。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单 / 双标记但附近一个周次段都没有的段数
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
        // 周次里常夹着「共8周」这类课程总周数备注，它不是上课周次，只剥备注本身；
        // 不能从第一个「共」一路删到行尾 —— 「1-8周(共8周),9-16周」后面的 9-16 周会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'。不要在这里删掉全部空白
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 紧挨周次的单 / 双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上；
        //   这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"，标记就跟着自己那一段走。
        //   前缀只认在段首：标记前面紧挨着数字或「周」（中间可有空白）时它是上一段的后缀，
        //   "1-8周(单) 9-16周(双)" 里的 "(单)" 不能被后面的 "9" 抢去当前缀；后缀后面紧跟下一段的数字时补一个逗号隔开
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            if (/[0-9周]\s*$/.test(whole.substring(0, offset))) return all;
            return mark;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var glue = /^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '';
            return digit + mark + glue;
        });
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
        // 区间终点前的「第」（"第1-第8周"）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
        // 单 / 双自己成一段时并给最近的周次段（就近向前找，找不到再向后）
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空，那才是真丢数据）；这是个判断不是事实，所以计数后写进 warnings
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

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周（手册 §4.1）。一行切出多段就写成多个 block，语义等价。
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

    // 不同周次上课地点不一样时，教务把它写在 jxcdmc2 里（"教室-周次,教室-周次"）；这里只数出有几个不同的教室
    function venuesOf(source) {
        var pieces = text(source).split(/[,，]/);
        var names = [];
        var seen = {};
        for (var i = 0; i < pieces.length; i++) {
            var m = /^(.*)-([0-9]+)$/.exec(text(pieces[i]));
            if (!m) continue;
            var venue = text(m[1]);
            if (!venue || seen['v' + venue]) continue;
            seen['v' + venue] = true;
            names.push(venue);
        }
        return names;
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
    var multiVenueCourses = {};
    var multiVenueNames = [];
    var timeChecks = [];       // 排课行里带的上课起止时间，用来核对所用的节次时间表
    var maxWeek = 0;
    var maxPeriod = 0;

    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序；上课安排先收成 entry，合并后再拆成 block
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

    var entries = [];

    // 完全相同的行（课名、教师、教室、星期、起止节次、周次都一样）只留第一条：账本记下见过的，再遇到就丢。
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

    function orderEntries(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end);
    }

    function sameSlot(a, b) {
        return a.name === b.name && a.teacher === b.teacher && a.location === b.location && a.day === b.day &&
            a.start === b.start && a.end === b.end;
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

    // 输入已按 orderEntries 排好：同一个上课安排（课名、教师、教室、星期、起止节次）的行，周次取并集
    function mergeSameSlot(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlot(current, next)) {
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

        var day = intOf(row.xq);
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var startPeriod = intOf(row.ps);
        var endPeriod = intOf(row.pe);
        if (startPeriod === null || endPeriod === null || startPeriod < 1 || endPeriod > MAX_PERIOD || startPeriod > endPeriod) {
            missing.period++;
            continue;
        }

        var weeks = weeksOf(row.zc);
        if (!weeks.length) {
            missing.week++;
            var sample = text(row.zc);
            if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
            continue;
        }

        // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
        // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
        var teacher = text(row.teaxms);
        var location = text(row.jxcdmc);
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
            fieldSamples.push(name);
        }
        if (venuesOf(row.jxcdmc2).length >= 2 && !multiVenueCourses['n' + name]) {
            multiVenueCourses['n' + name] = true;
            multiVenueNames.push(name);
        }
        var rowStart = timeOf(row.qssj);
        var rowEnd = timeOf(row.jssj);
        if (rowStart && rowEnd) {
            timeChecks.push({ name: name, start: startPeriod, end: endPeriod, from: rowStart, to: rowEnd });
        }
        entries.push({
            course: courseOf(name, teacher || null),
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            start: startPeriod,
            end: endPeriod,
            weeks: weeks
        });
    }

    // 去完全相同的行 → 排序 → 同一个上课安排的周次取并集
    entries = dropExactDuplicates(entries);
    entries.sort(orderEntries);
    var merged = mergeSameSlot(entries);

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
            '请重新登录、打开课表页面确认能看到课表后再试'
        );
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var weekOne = weekOneInfo(data.weekOne);
    var start;
    if (weekOne.iso) {
        start = { iso: weekOne.iso, rule: '教务系统给出的第 1 周日期' };
    } else {
        start = estimateStart(todayIso);
    }

    // 教务不给总周数（上游也没存）：按 max(课表最晚周次, 20) 导入，课表里更晚的周次必须放得下（endWeek 超过 totalWeeks 会被载荷校验拒掉）
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    // ---------- 节次时间：用户选的 → 按排课行的上课时间判断 → 第一张 ----------
    function mismatchesOf(key) {
        var times = TABLES[key].times;
        var names = [];
        var seenNames = {};
        for (var i = 0; i < timeChecks.length; i++) {
            var check = timeChecks[i];
            var first = times[check.start - 1];
            var last = times[check.end - 1];
            var bad = (first && first.start !== check.from) || (last && last.end !== check.to);
            if (bad && !seenNames['n' + check.name]) {
                seenNames['n' + check.name] = true;
                names.push(check.name);
            }
        }
        return names;
    }

    var tableKey = null;
    var tableHow = 'default';
    if (typeof data.timetable === 'string' && TABLES[data.timetable]) {
        tableKey = data.timetable;
        tableHow = 'chosen';
    } else if (timeChecks.length) {
        var fitting = [];
        for (var t = 0; t < TABLE_KEYS.length; t++) {
            if (!mismatchesOf(TABLE_KEYS[t]).length) fitting.push(TABLE_KEYS[t]);
        }
        if (fitting.length === 1) {
            tableKey = fitting[0];
            tableHow = 'rows';
        }
    }
    if (!tableKey) tableKey = 'normal';
    var table = TABLES[tableKey];
    var periodTimes = table.times.slice(0);
    var tableLength = periodTimes.length;

    // 分钟数写回 HH:mm（补时间用）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var mm = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
    }
    // 节次号（已升序）写成「第 9-12 节」「第 9 节」「第 9、11-12 节」这几种
    function sectionsText(list) {
        var spans = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) {
                j++;
            }
            spans.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + spans.join('、') + ' 节';
    }

    // 课表用到的更晚节次逐节补（批次五统一修订 H3）：补哪些、补不了哪些都进 warnings
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
        // 否则从上一节下课后顺推：课间 5 分钟、每节 45 分钟；顺推越过 23:59 就停，这一节起不再补
        if (!prev) { uncoveredFrom = p; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    if (termFromPage) {
        warn(
            '只导入了教务系统里当前的学期（' + name0 +
            '）；要导入别的学期，请先在教务系统的课表页面里切到那个学期，再点「提取课表」'
        );
    } else {
        warn(
            '没有从教务系统读到当前学期，已按今天的日期推算为 ' + name0 +
            '。如果这不是你要导入的学期，请先在教务系统的课表页面里切到正确的学期，再点「提取课表」'
        );
    }

    if (weekOne.iso) {
        warn(
            '开学日期取自教务系统：第 1 周从 ' + start.iso + ' 开始' +
            (weekOne.adjusted ? '（教务给的第 1 周周一不是周一，已回退到当周周一）' : '') + '，请在学期管理里核对'
        );
    } else if (weekOne.rejected) {
        warn(
            '教务系统给出的开学日期（' + weekOne.rejected + '）不属于这个学期，已忽略；第 1 周按「' +
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
            '教务系统没有给出学期总周数；课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS +
            ' 周，已按 ' + totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改'
        );
    }

    var firstSlot = table.times[0];
    var slotHead = '（第 1 节 ' + firstSlot.start + '-' + firstSlot.end + '）';
    if (tableHow === 'chosen') {
        warn(
            '教务系统没有提供节次时间，已按你选择的「' + table.label + '」导入' + slotHead +
            '，请与学校公布的节次时间核对，不一致可在学期管理里改'
        );
    } else if (tableHow === 'rows') {
        warn(
            '没有选择节次时间，已根据教务系统给出的上课时间判断为「' + table.label + '」' + slotHead +
            '，请与学校公布的节次时间核对，不一致可在学期管理里改'
        );
    } else {
        warn(
            '没有选择节次时间，已按「' + table.label + '」导入' + slotHead +
            '。校区或季节不同的话，上课时间会整体偏移，请与学校公布的节次时间核对，并在学期管理里改'
        );
    }

    // 排课行带了上课起止时间、却与所用的节次时间对不上：点名几门，并告诉用户哪一张表与教务给的时间一致
    if (timeChecks.length) {
        var badNames = mismatchesOf(tableKey);
        if (badNames.length) {
            var fitLabel = '';
            for (var q = 0; q < TABLE_KEYS.length && !fitLabel; q++) {
                if (TABLE_KEYS[q] !== tableKey && !mismatchesOf(TABLE_KEYS[q]).length) fitLabel = TABLES[TABLE_KEYS[q]].label;
            }
            warn(
                '有 ' + badNames.length + ' 门课教务系统给出的上课时间与导入的节次时间对不上（例如 ' + sampleText(badNames) + '）' +
                (fitLabel ? '；教务给的时间与「' + fitLabel + '」一致，可重新提取并改选节次时间' : '，请在学期管理里核对节次时间')
            );
        }
    }

    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
        warn(
            '课表用到了' + sectionsText(filledAll) + '，所用的节次时间没有覆盖，已补上：' + fillTexts.join('，') +
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
        if (missing.period) reasons.push('缺节次（或节次不合理）' + missing.period + ' 行');
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
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + sampleText(fieldSamples) + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上'
        );
    }
    if (multiVenueNames.length > 0) {
        warn(
            '有 ' + multiVenueNames.length + ' 门课在不同周次的上课地点不一样（例如 ' + sampleText(multiVenueNames) +
            '）：已按教务系统给出的主要地点导入，请核对各周的地点，可在「编辑课程」里改'
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
            '有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，' +
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

    // 合并用的 entry 与分组表都是内部数据，不进载荷
    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: null,
            blocks: courses[c].blocks
        });
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
