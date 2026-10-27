(function () {
    // 南方医科大学教务适配器（乘方智慧教务新版，zhjw.smu.edu.cn）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 SMU/smu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 NekoJackie）
    //   上游快照 7c9e1907635cb1c2d481b316e6f52d69dc77edff（2026-10-27 拉取）
    //   本校脚本最后一次修改 78c4b31
    //
    // 上游在同一段脚本里选学期、发请求、拼课程、存节次时间；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交出来的是教务行里 parse 用得到的十一个字段，外加学期、校历。
    // 通用部分（周次写法、同课合并、提醒限长、节次补齐）照同平台已审计的 gxmu（其通用部分来自 shxy / swu）；
    // 校区节次时间、教室周次（jxcdmc2）、校历与自定义时间核对按上游 SMU/smu_01.js 重写。
    //
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① 周次、教室、教师、节次的读法与上游一致：教室周次先看 jxcdmc2（「教室-周次」，上游的写法，有就用它的教室与周次，
    //      不再用 zc）；没有就周次取 zc、教室取 jxcdmc；教师取 teaxms，起止节次取 ps / pe，星期取 xq。
    //      在上游之外多认「1-16周」「(单)」「(双)」「第1-第8周」「共 N 周」这类写法（照 swu 的 weeksOf；上游只认逗号数字列表，
    //      这种写法上游会静默丢课），认不出的计数进提醒；
    //   ② 上游要求课名 / 星期 / 节次都在，缺了整行静默丢弃：这里按原因计数写进提醒；结束节次读不出时照上游当作与开始节次相同
    //      （单节课），读得出但小于开始节次的算节次不合法，一并计数提醒；
    //      教师、教室没有就留空，不写「未知教师」「不用场地」（那会被课表当成真名 / 真地点显示），按类型汇总进提醒；
    //   ③ 节次时间：上游按校区写死两张 13 节表（CAMPUS_CONFIG），这里照抄成 CAMPUSES；基础校区取课数最多的那个
    //      （并列取先出现的，没有校区编号取校本部），第 1-9 节两校不同，第 10-13 节两校相同。
    //      课表用到第 13 节之后时，在上一节下课后按课间 5 分钟、每节 40 分钟顺推，顺推越过 23:59 的如实说明（批次五统一修订 H3）；
    //   ④ 自定义时间：上游对开始节次 ≥10 的课直接用教务给的 qssj / jssj 当这门课的时间。课表的每门课只能按节次放，
    //      所以这里仍按节次表放入，并把「教务给的时间与节次表对不上」的课按课名汇总提醒（不静默，照 §4.4）；
    //   ⑤ 开学日与总周数：上游都不存，这里取教务校历（extract.js 交来的周次 + 日期）：校历里最早有日期的那一周的周一为开学日，
    //      校历的最大周次为总周数；取不到或不属于这个学期就推算，并写进 warnings（宁可推算说明，也不写错日期）；
    //   ⑥ 学期名取教务下拉框里的学年学期文字（「2026-2027学年第一学期」这种），读不出用「学校名 + 学年学期」，不拿适配器名当学期名；
    //   ⑦ 同课合并：上游只按「课名 | 星期 | 节次 | 周次 | 教师 | 地点」去掉完全相同的行，不合并。这里照 gxmu 补上两阶段合并
    //      （连续节次合并 + 同节次周次并集），先去掉完全相同的行；不丢课、不改任何一周的安排；
    //   ⑧ 校区不同的课：合并键不带校区，但两校第 1-9 节时间不同，这种课按基础校区的节次时间导入并提醒（名单里写明）；
    //   ⑨ 上游的导出流程（教务导入说明弹窗、学年学期弹窗、savePresetTimeSlots、saveCourseConfig、saveImportedCourses、
    //      showToast、notifyTaskCompletion）全部不移植：这些是「拾光」的桥能力，空课由宿主负责保存，适配器只交载荷。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据（本校节次 13 节）
    var SCHOOL_NAME = '南方医科大学';   // 学期名兜底时用（拿不到学年时「学校名 + 学年学期」，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 校历与教务都不给总周数时按 20 周给，并在提醒里说明
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 40; // 节次时间补不上时顺推：每节几分钟（本校一节 40 分钟）
    var CAMPUS_BASE = '00001';     // 教务数据里没有可认的校区编号时，按校本部节次时间（上游的默认）

    // 校区节次时间：上游 SMU/smu_01.js 的 CAMPUS_CONFIG，逐节照抄。每项是 [开始, 结束]，下标 0 对应第 1 节。
    var CAMPUSES = {
        '00001': {
            name: '校本部',
            periods: [
                ['08:00', '08:40'], ['08:45', '09:25'], ['09:50', '10:30'], ['10:35', '11:15'], ['11:20', '12:00'],
                ['14:30', '15:10'], ['15:15', '15:55'], ['16:15', '16:55'], ['17:00', '17:40'],
                ['19:30', '20:10'], ['20:15', '20:55'], ['21:00', '21:40'], ['21:45', '22:25']
            ]
        },
        '00009': {
            name: '顺德校区',
            periods: [
                ['08:30', '09:10'], ['09:15', '09:55'], ['10:20', '11:00'], ['11:05', '11:45'], ['11:50', '12:30'],
                ['14:00', '14:40'], ['14:45', '15:25'], ['15:45', '16:25'], ['16:30', '17:10'],
                ['19:30', '20:10'], ['20:15', '20:55'], ['21:00', '21:40'], ['21:45', '22:25']
            ]
        }
    };

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

    // 校区编号 → 校区节次时间。只认 CAMPUSES 里写了的编号（用 hasOwnProperty，免得 constructor 之类的字样串进来）
    function campusOf(code) {
        return Object.prototype.hasOwnProperty.call(CAMPUSES, code) ? CAMPUSES[code] : null;
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

    // 分钟数写回 HH:mm（补时间用）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return pad2(h) + ':' + pad2(m);
    }

    // 教务给的时间（qssj / jssj，形如「08:00」或「08:00:00」）→ HH:mm；读不出返回 null
    function timeOf(value) {
        var m = /^\s*([0-9]{1,2}):([0-9]{2})/.exec(text(value));
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var mi = parseInt(m[2], 10);
        if (h > 23 || mi > 59) return null;
        return pad2(h) + ':' + pad2(mi);
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

    // ---------- 学期名与学期类别 ----------
    // 学期名读的是下拉框文字（extract.js 交来的 term.label）：「2026-2027学年第一学期」这种。学年起始年从里面读；
    // 第二学期 / 短学期的判断也只看这段文字。读不出学年时开学日只能按今天所在周推算。
    var LABEL_YEAR = /(\d{4})\s*-\s*(\d{4})\s*学年/;

    function termLabel() {
        return text(term.label);
    }

    function termYear() {
        var m = LABEL_YEAR.exec(termLabel());
        return m ? parseInt(m[1], 10) : 0;
    }

    function termKind() {
        var label = termLabel();
        if (label.indexOf('第二') >= 0) return 'second';
        if (label.indexOf('短') >= 0 || label.indexOf('第三') >= 0) return 'third';
        return 'first';
    }

    // 学期名用教务自己的学年学期（手册 §4.7：别拿适配器名当学期名）：下拉框文字像「2026-2027学年第一学期」就直接用，
    // 否则退回「学校名 + 学年学期」
    function termName() {
        var label = termLabel();
        if (label.length <= 40 && label.indexOf('学年') >= 0 && label.indexOf('学期') >= 0) return label;
        return SCHOOL_NAME + ' 学年学期';
    }

    // 开学日推算（校历与教务都没给第 1 周日期时）：依赖学期类别的锚点，推算结果一律写进 warnings。
    function estimateStart(todayIso) {
        var kind = termKind();
        var year = termYear();
        if (!year) {
            // 学期名读不出学年时退回「今天所在周的周一」。这条分支依赖当天日期，不要写进 fixture 用例 —— 用例会随日期失效
            return { iso: weekStartOf(todayIso) || todayIso, rule: '今天所在周的周一' };
        }
        var anchor = KIND_ANCHOR[kind];
        var anchorIso = isoOf(new Date(Date.UTC(year + (kind === 'first' ? 0 : 1), anchor.month - 1, anchor.day)));
        return { iso: weekStartOf(anchorIso), rule: anchor.rule };
    }

    // 校历给的第 1 周日期万一是别的学期的，宁可按推算走 + 说出来，也不要悄悄写一个错日期：
    // 开学日错了整学期的课都会错位。判据：离这个学期的锚点日期不超过 45 天（读不出学年时不判）。
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

    // 校历（extract.js 交来的 [{zc, rq}]，取不到是 null）：maxWeek = 校历里最大的周次；
    // startIso = 有日期的周里最小的那一周（周次最小，同周取日期最早）的最早日期
    function calendarOf(list) {
        if (!(list instanceof Array)) return null;
        var info = { maxWeek: 0, startIso: null };
        var earliestWeek = Infinity;
        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            var week = intOf(text(item.zc));
            if (week === null) continue;
            if (week > info.maxWeek) info.maxWeek = week;
            var iso = isoOfAny(item.rq);
            if (!iso) continue;
            if (week < earliestWeek || (week === earliestWeek && iso < info.startIso)) {
                earliestWeek = week;
                info.startIso = iso;
            }
        }
        return info;
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
    var noteSample = '';     // 第一个备注括号的原文，写进提醒（用时截短）
    var bothMarks = 0;       // 同时写了「单」和「双」的段数（按每周都上处理，要说出来）
    var badRoomParts = 0;    // 教室周次（jxcdmc2）里认不出的段数

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
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 当前这一段本身以前缀标记开头（"(单)1-8周(双)9-16周" 里的第二个标记）时，它是后一段的前缀，前面补逗号隔开；
            // 否则仍是上一段的后缀（"1-8周(单)9-16周(双)"）
            var head = before.replace(/\s+$/, '').replace(/^.*[,\s]/, '');
            if (/^\([单双]/.test(head)) return ',' + mark;
            return all;
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
        // 区间终点前的「第」（教务常见写法「第1-第8周」）：去掉，否则区间会被拆成第 1 周与第 8 周两段
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
    // 一个教务行的周次切出多段就写成多个 block，语义等价。
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
    // 教务行的起止节次是 ps / pe 两个数字字段（上游 parseInt(raw.ps) / parseInt(raw.pe)）。
    // 开始节次读不出数字、小于 1、超出单日上限，或结束节次读得出却小于开始 / 超出上限，返回 null
    // （调用方计数进 warnings，不静默丢课；上游对结束小于开始不检查，这里多挡一道）。
    // 结束节次读不出数字时照上游当作只上开始那一节（guessed 标出来，调用方计数进 warnings）。
    function sectionsOf(row) {
        var start = intOf(text(row.ps));
        var end = intOf(text(row.pe));
        if (start === null || start < 1 || start > MAX_PERIOD) return null;
        if (end === null) return { start: start, end: start, guessed: true };
        if (end > MAX_PERIOD || end < start) return null;
        return { start: start, end: end, guessed: false };
    }

    // 两个校区在 [from, to] 这几节上时间是否不同（只比到第 9 节那种分歧处；超出表的不比）
    function periodsDiffer(a, b, from, to) {
        for (var k = from; k <= to && k <= b.periods.length && k <= a.periods.length; k++) {
            var x = a.periods[k - 1];
            var y = b.periods[k - 1];
            if (x[0] !== y[0] || x[1] !== y[1]) return true;
        }
        return false;
    }

    // 教室与周次（上游 jxcdmc2 的写法）：「A101-1,A101-2,B201-3」每一段是「教室-周次」，同一教室的周次归在一起。
    // 上游只要这个串能解析出任何一段，就用它的教室与周次、不再看 zc（这里照做）。
    // 返回 { groups: [{room, weeks}], bad }：bad 是认不出的段数；周次超出 1..MAX_WEEK 的丢掉并计入 droppedWeeks
    function roomWeekGroups(source) {
        var groups = [];
        var index = {};
        var bad = 0;
        var parts = text(source).split(',');
        for (var i = 0; i < parts.length; i++) {
            var part = text(parts[i]);
            if (!part) continue;
            var cut = part.lastIndexOf('-');
            if (cut < 0) { bad++; continue; }
            var room = text(part.substring(0, cut));
            var digits = text(part.substring(cut + 1));
            if (!/^[0-9]+$/.test(digits)) { bad++; continue; }
            var week = parseInt(digits, 10);
            if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
            var key = 'r' + room;
            if (!index[key]) {
                index[key] = { room: room, weeks: [] };
                groups.push(index[key]);
            }
            if (index[key].weeks.indexOf(week) < 0) index[key].weeks.push(week);
        }
        for (var g = 0; g < groups.length; g++) groups[g].weeks.sort(function (a, b) { return a - b; });
        return { groups: groups, bad: bad };
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
    var guessedCourses = {};   // 没给结束节次、按只上一节处理的课（按课名去重）
    var guessedSamples = [];   // 点名用的课名，最多 3 个
    var unknownCampusCourses = {};   // 校区编号本程序没有节次时间表的课（按课名去重）
    var unknownCampusSamples = [];
    var otherCampusCourses = {};     // 在另一校区上课、第 1-9 节时间与基础校区不同的课（按课名去重）
    var otherCampusSamples = [];
    var otherCampusName = '';
    var timeChecks = [];       // 开始节次 ≥10 且教务给了自定义时间的课：节次表算好后再核对
    var maxWeek = 0;
    var maxPeriod = 0;

    // ---------- 基础校区：课数最多的校区（并列取先出现的）；它的节次时间作整张课表的节次时间 ----------
    var votes = {};
    var voteOrder = [];
    for (var v = 0; v < rows.length; v++) {
        var code0 = text((rows[v] || {}).kkxqdm);
        if (!code0 || !campusOf(code0)) continue;
        if (!votes['k' + code0]) { votes['k' + code0] = 0; voteOrder.push(code0); }
        votes['k' + code0]++;
    }
    var baseCode = null;
    for (var b = 0; b < voteOrder.length; b++) {
        if (baseCode === null || votes['k' + voteOrder[b]] > votes['k' + baseCode]) baseCode = voteOrder[b];
    }
    var baseGuessed = baseCode === null;   // 没有一个认得出的校区编号
    if (baseGuessed) baseCode = CAMPUS_BASE;
    var base = campusOf(baseCode);

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

    // ---------- 同课合并（上游不合并，这里照 gxmu 补两阶段合并） ----------
    // 每行收成一条 entry（课程、教师、教室、星期、起止节次、周次集合）后套三步：
    //   0：完全相同的行只留一条（dropExactDuplicates）；
    //   阶段 1：名称、教师、教室、星期、周次都一样、且节次首尾相接的合成一条；
    //   阶段 2：名称、教师、教室、星期、起止节次都一样的，周次取并集。
    // 只合并首尾相接的节次，重叠的节次保持原样：不丢课、不改任何一周的安排。
    var entries = [];

    // 完全相同的行（课名、教师、教室、星期、起止节次、周次都一样）只留第一条：账本记下见过的，再遇到就丢。
    // 必须在阶段 1 之前做：阶段 1 只跟当前正在合并的那一条比，合并之后才出现的重复会漏网
    // （如 1-2、3-4、3-4：第三行与第二行相同，不先去重会得到 1-4 与 3-4 两块，在 3-4 节重叠）。
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

    var badRoomRows = 0;
    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};

        var name = text(row.kcmc);
        if (!name) { missing.name++; continue; }

        var day = intOf(text(row.xq));
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOf(row);
        if (!sections) { missing.period++; continue; }

        // 教室与周次：jxcdmc2 能读出就用它（上游的写法，同一门课可以按周分教室）；读不出再用 zc 与 jxcdmc
        var placed = roomWeekGroups(row.jxcdmc2);
        if (placed.bad) badRoomRows++;
        var places = [];
        if (placed.groups.length) {
            places = placed.groups;
        } else {
            var zcWeeks = weeksOf(row.zc);
            if (!zcWeeks.length) {
                missing.week++;
                var sample = text(row.zc);
                if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
                continue;
            }
            places = [{ room: text(row.jxcdmc), weeks: zcWeeks }];
        }

        // 校区：编号认不出就记下来（这门课按基础校区的节次时间导入）；与基础校区第 1-9 节时间不同的单独记
        var rowCode = text(row.kkxqdm);
        var rowCampus = rowCode ? campusOf(rowCode) : null;
        if (rowCode && !rowCampus) {
            if (!unknownCampusCourses['k' + name]) {
                unknownCampusCourses['k' + name] = true;
                if (unknownCampusSamples.length < 3) unknownCampusSamples.push(shortName(name));
            }
        }
        if (rowCampus && rowCode !== baseCode && periodsDiffer(rowCampus, base, sections.start, Math.min(sections.end, 9))) {
            if (!otherCampusCourses['k' + name]) {
                otherCampusCourses['k' + name] = true;
                if (otherCampusSamples.length < 3) otherCampusSamples.push(shortName(name));
                if (!otherCampusName) otherCampusName = rowCampus.name;
            }
        }

        // 自定义时间（上游只对开始节次 ≥10 的课用）：先记下，节次表算出来后再核对
        if (sections.start >= 10) {
            var qs = timeOf(row.qssj);
            var js = timeOf(row.jssj);
            if (qs || js) timeChecks.push({ name: name, start: sections.start, end: sections.end, qs: qs, js: js });
        }

        // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
        // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
        var teacher = text(row.teaxms);
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (sections.guessed) {
            if (!guessedCourses['n' + name] && guessedSamples.length < 3) guessedSamples.push(name);
            guessedCourses['n' + name] = true;
        }
        for (var pi = 0; pi < places.length; pi++) {
            var room = text(places[pi].room);
            if (!room) missingLocationCourses['n' + name] = true;
            if ((!teacher || !room) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
                fieldSamples.push(name);
            }
            entries.push({
                course: courseOf(name, teacher || null),
                name: name,
                teacher: teacher,
                location: room,
                day: day,
                start: sections.start,
                end: sections.end,
                weeks: places[pi].weeks
            });
        }
    }

    // 去完全相同的行 → 排序 → 阶段 1 → 再排序 → 阶段 2（前面多一步去重）
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
            teacher: courses[c].teacher || null,
            note: null,
            blocks: courses[c].blocks
        });
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var todayIsoValue = isoOfAny(data.today) || localTodayIso();
    var cal = calendarOf(data.calendar);
    var start = null;
    var startFromCalendar = false;
    var rejectedStart = null;
    if (cal && cal.startIso) {
        if (plausibleStart(cal.startIso)) {
            // 校历给的是第 1 周里最早的一天；仍按周一回退，保证开学日一定落在周一（每周从周一开始）
            start = { iso: weekStartOf(cal.startIso), rule: '校历' };
            startFromCalendar = true;
        } else {
            rejectedStart = cal.startIso;
        }
    }
    if (!startFromCalendar) start = estimateStart(todayIsoValue);

    // 总周数：校历的最大周次；校历没有就 20 周。课表里排到的更晚时抬高，并在提醒里说明
    var calTotal = cal && cal.maxWeek >= 1 && cal.maxWeek <= MAX_WEEK ? cal.maxWeek : null;
    var totalWeeks = calTotal || SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;
    if (totalWeeks < 1) totalWeeks = SCHOOL_TOTAL_WEEKS;

    // ---------- 节次时间：基础校区的节次表；课表用到更晚的节次时，在上一节下课后顺推，补不了如实说明 ----------
    var periodTimes = [];
    for (var pt = 0; pt < base.periods.length; pt++) {
        periodTimes.push({ periodIndex: pt + 1, start: base.periods[pt][0], end: base.periods[pt][1] });
    }
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        // 从上一节下课后顺推：课间 5 分钟、每节 40 分钟；顺推越过 23:59 就停，这一节起不再补
        var prevEnd = minutesOf(prev.end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // 教务给的上课时间与节次表对不上的课（上游按教务时间上课，这里只能按节次显示，要说出来）
    var timeMismatchCourses = {};
    var timeMismatchSamples = [];
    for (var t = 0; t < timeChecks.length; t++) {
        var check = timeChecks[t];
        var from = periodTimes[check.start - 1];
        var to = periodTimes[check.end - 1];
        if (!from || !to) continue;   // 节次表没覆盖到的，已在顺推提醒里说明
        if ((check.qs && check.qs !== from.start) || (check.js && check.js !== to.end)) {
            if (!timeMismatchCourses['k' + check.name]) {
                timeMismatchCourses['k' + check.name] = true;
                if (timeMismatchSamples.length < 3) timeMismatchSamples.push(shortName(check.name));
            }
        }
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    var source = text(term.source);
    if (source === 'page') {
        warn(
            '导入的是教务页面里选中的学期（' + shortName(name0) + '）；要导入别的学期，请先在教务页面里切换到那个学期，再点「提取课表」'
        );
    } else {
        warn(
            '导入的是教务系统默认的学期（' + shortName(name0) + '）；要导入别的学期，请先在教务课表页里切换到那个学期，再点「提取课表」'
        );
    }

    if (baseGuessed) {
        var unknownCodes = [];
        for (var uc = 0; uc < rows.length && unknownCodes.length < 1; uc++) {
            var rawCode = text((rows[uc] || {}).kkxqdm);
            if (rawCode && !campusOf(rawCode)) unknownCodes.push(shortName(rawCode));
        }
        if (unknownCodes.length) {
            warn(
                '课表里的校区编号（例如 ' + unknownCodes.join('、') + '）没有对应的节次时间，节次时间按「' + base.name +
                '」导入，请核对第 1-9 节的时间'
            );
        } else {
            warn('教务数据里没有校区编号，节次时间按「' + base.name + '」导入，请核对第 1-9 节的时间');
        }
    }
    var unknownCampusCount = countKeys(unknownCampusCourses);
    if (!baseGuessed && unknownCampusCount > 0) {
        warn(
            '有 ' + unknownCampusCount + ' 门课所在的校区没有对应的节次时间（例如 ' + unknownCampusSamples.join('、') +
            '），这几门课的节次时间按「' + base.name + '」导入，请核对'
        );
    }
    var otherCampusCount = countKeys(otherCampusCourses);
    if (otherCampusCount > 0) {
        warn(
            '有 ' + otherCampusCount + ' 门课在「' + otherCampusName + '」上课，节次时间按「' + base.name +
            '」导入，两校第 1-9 节的时间不同（例如 ' + otherCampusSamples.join('、') + '），这几门课的时间请核对'
        );
    }

    if (startFromCalendar) {
        warn('开学日期取自教务校历：第 1 周从 ' + start.iso + ' 开始，请在学期管理里核对');
    } else if (rejectedStart) {
        warn(
            '教务校历给出的开学日期（' + rejectedStart + '）不属于这个学期，已忽略；第 1 周按「' +
            start.rule + '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start.rule +
            '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (calTotal && !raisedBySchedule) {
        warn('学期总周数取自教务校历（' + totalWeeks + ' 周）');
    } else if (calTotal) {
        warn(
            '校历给出的学期总周数是 ' + calTotal + ' 周，课表里排到了第 ' + maxWeek + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + totalWeeks + ' 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (bySequence.length) {
        warn(
            '课表用到了' + sectionsText(bySequence) + '，学校公布的节次时间没有覆盖，已按上一节下课后课间 ' + EXTEND_BREAK_MINUTES +
            ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推补上，请在学期管理里核对节次时间'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    var timeMismatchCount = countKeys(timeMismatchCourses);
    if (timeMismatchCount > 0) {
        warn(
            '有 ' + timeMismatchCount + ' 门课（例如 ' + timeMismatchSamples.join('、') + '）教务给的上课时间与学校公布的节次时间不一样，' +
            '课表按节次显示，请以教务系统为准核对'
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
    var guessedCount = countKeys(guessedCourses);
    if (guessedCount > 0) {
        var guessedNames = [];
        for (var gn = 0; gn < guessedSamples.length; gn++) guessedNames.push(shortName(guessedSamples[gn]));
        warn(
            '有 ' + guessedCount + ' 门课没给结束节次（例如 ' + guessedNames.join('、') +
            '），已按只上开始的那一节导入，请核对这几门课的节次'
        );
    }
    if (badRoomRows > 0) {
        warn(
            '有 ' + badRoomRows + ' 门课的教室与周次写法读不懂（不是「教室-周次」），那几段已忽略，请核对这几门课的教室与周次'
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
})()
