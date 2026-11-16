(function () {
    // 洛阳理工学院教务适配器（乘方智慧教务，lljw.lit.edu.cn）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 LIT/lit_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 小漫君）
    //   上游快照 1dc9ac6（2026-11-16 拉取）；本校脚本最后一次修改 9751f72（2026-09-07），已用 git log 核对一致
    //
    // 上游在同一段脚本里选学期、发请求、拼课程、存节次时间；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交出来的是教务行里 parse 用得到的字段，外加学期与节次时间。
    // 模板：同平台已审计的 nenu（乘方智慧教务新版，批次十七）—— 周次写法、两阶段合并、提醒限长、节次补齐、
    // 学期与开学日推算都照它；按周次换教室（jxcdmc2）与排课行自带的上课时间照同平台已审计的 sdipct（批次十五）。
    //
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① 周次取 zc（上游按逗号分隔的数字列表读），在上游之外多认「1-16周」「(单)」「(双)」「第1-第8周」
    //      「共 N 周」这类写法（照 nenu 的 weeksOf），认不出的计数进提醒；
    //   ② 教室：主教室取 jxcdmc；按周次分的地点取 jxcdmc2（「教室-周次,教室-周次」，可省略教室名沿用上一间），
    //      按教室归并周次、一间教室一段（上游同上）。zc 里有、jxcdmc2 里没有的周次上游会静默丢掉，
    //      这里保留并用主教室补上，对不上的课按类型汇总提醒；
    //   ③ 上游的「未知教师 / 待定地点」占位词改成留空（null）：缺教师、缺教室照常导入并按类型汇总提醒；
    //      教师取 teaxms，空则取上游的备用字段 pkr，方括号里的备注（「张三[外聘]」）按上游去掉；
    //      bapjxcd 为 1 表示这门课不需要场地，地点写「不用场地」（上游同）；
    //   ④ 节次时间：上游从课表页源码的 businessHours 逐节读；取不到时上游整个导入失败，
    //      这里回落空课默认的 12 节并提醒；课表用到的节次超出时按「统一修订 H3」逐节补齐并说明；
    //   ⑤ 排课行自带的上课时间（qssj / jssj）：上游把它当「自定义时间」。空课的课表按节次放课，
    //      所以这里只用来核对节次时间，对不上的课点名提醒，仍按节次导入（照 sdipct）；
    //   ⑥ 开学日与总周数上游没存：能确定学期时按学期锚点（第一学期 = 9 月 1 日所在周的周一、
    //      第二学期 = 2 月 20 日所在周的周一）推算，确定不了才退回提取当天所在周的周一；
    //      总周数按「不少于 20 周、不早于课表最晚周次」给，两者都写进提醒；
    //   ⑦ 学期名取教务下拉框里的学年学期文字，读不出用学期代码拼，再不行用「学校名 + 学年学期」；
    //   ⑧ 同课合并照 nenu 的两阶段合并（先去掉完全相同的行，再合并首尾相接的节次、同节次取周次并集）；
    //   ⑨ 上游的导出流程（学期选择弹窗、savePresetTimeSlots、saveImportedCourses、showToast、
    //      notifyTaskCompletion）全部不移植：适配器只交载荷，保存由宿主负责。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '洛阳理工学院';   // 学期名兜底时用（不拿适配器名当学期名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给学期总周数，上游也没存；按 20 周给并在提醒里说明
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：教务的节次时间整张取不到时用它；
    // 课表用到的节次超出教务节次时间时，内置表里有这一节、且开始不早于前面已有时段的下课，就用它的时间；
    // 接不上的按顺推补（载荷带了 periodTimes 时应用不会自己补）
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
        first: { month: 9, day: 1 },
        second: { month: 2, day: 20 },
        third: { month: 7, day: 1 }
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 课名等教务原文过长时截短，避免一个超长名字就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

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
        if (!iso) return null;
        var date = new Date(Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        ));
        var dayNo = (date.getUTCDay() + 6) % 7 + 1;   // 周一 = 1 … 周日 = 7
        var back = (dayNo - 1 + 7) % 7;
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

    // "08:10" / "8:10" / "08:10:00" → "08:10"；认不出来（含 24:00、85:45 这类）返回 null。
    // 载荷校验要求 periodTimes 的时间必须是 HH:mm 且 00:00–23:59，写进去的越界时间会让整包被拒。
    function timeOf(value) {
        var m = /^([01]?[0-9]|2[0-3]):([0-5][0-9])/.exec(text(value));
        if (!m) return null;
        return (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2];
    }

    // 交出去的可能是裸数组，也可能套一层信封（{rows:[]} / {data:[]}）。沿用模板的宽容读法，
    // 找不到就返回空数组，调用方据此回落到默认并如实写进 warnings。
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
    // 学期值是教务自己的（上游把下拉框的 value 原样拼进请求体）：学期名与序号先看下拉框的文字
    //（「2026-2027学年第一学期」），文字里读不出再看值是不是「学年起始年 4 位 + 学期号 2 位」，都读不出才按提取当天推
    var TERM_LABEL = text(term.label);
    var TERM_CODE_PARTS = /^([0-9]{4})([0-9]{2})$/.exec(text(term.code));
    var TERM_SUFFIX = { first: '第一学期', second: '第二学期', third: '短学期' };
    var termGuessed = false;   // 学期序号 / 学年是按日期推的

    function kindOfLabel(label) {
        if (label.indexOf('第二学期') >= 0 || label.indexOf('春') >= 0) return 'second';
        if (label.indexOf('第一学期') >= 0 || label.indexOf('秋') >= 0) return 'first';
        if (label.indexOf('短学期') >= 0 || label.indexOf('夏') >= 0 || label.indexOf('第三学期') >= 0) return 'third';
        return '';
    }

    function kindOfCode() {
        if (!TERM_CODE_PARTS) return '';
        if (TERM_CODE_PARTS[2] === '01') return 'first';
        if (TERM_CODE_PARTS[2] === '02') return 'second';
        if (TERM_CODE_PARTS[2] === '03') return 'third';
        return '';
    }

    function yearOfLabel(label) {
        var m = /(20[0-9]{2})/.exec(label);
        return m ? parseInt(m[1], 10) : 0;
    }

    // 提取当天的日期推出的学期（只在上面两处都读不出时用）
    function guessFromToday() {
        var iso = isoOfAny(data.today) || localTodayIso();
        var year = parseInt(iso.substring(0, 4), 10);
        var month = parseInt(iso.substring(5, 7), 10);
        if (month >= 8) return { kind: 'first', year: year };
        if (month <= 1) return { kind: 'first', year: year - 1 };
        return { kind: 'second', year: year - 1 };
    }

    var TERM_KIND = kindOfLabel(TERM_LABEL) || kindOfCode();
    var TERM_YEAR = yearOfLabel(TERM_LABEL) || (TERM_CODE_PARTS ? parseInt(TERM_CODE_PARTS[1], 10) : 0);
    if (!TERM_KIND || !TERM_YEAR) {
        var guessedTerm = guessFromToday();
        if (!TERM_KIND) TERM_KIND = guessedTerm.kind;
        if (!TERM_YEAR) TERM_YEAR = guessedTerm.year;
        termGuessed = true;
    }

    // 学期名用教务自己的学年学期（手册 §4.7：别拿适配器名当学期名）：下拉框文字带学年或年份就直接用，
    // 否则用学期序号与学年拼；都是推出来的就退回「学校名 + 学年学期」
    function termName() {
        if (TERM_LABEL.length <= 40 && (TERM_LABEL.indexOf('学年') >= 0 || /20[0-9]{2}/.test(TERM_LABEL))) return TERM_LABEL;
        if (termGuessed) return SCHOOL_NAME + ' 学年学期';
        return TERM_YEAR + '-' + (TERM_YEAR + 1) + '学年' + TERM_SUFFIX[TERM_KIND];
    }

    // 开学日推算（教务没给第 1 周日期）：依赖学期序号的锚点，推算结果一律写进 warnings。
    function estimateStart(todayIso) {
        var kind = TERM_KIND;
        var anchor = KIND_ANCHOR[kind];
        var year = TERM_YEAR;
        if (!year) {
            // 学期读不出来时退回「提取当天所在周的周一」。这条分支依赖当天日期，不写进 fixture 用例
            return { iso: weekStartOf(todayIso) || todayIso };
        }
        var anchorIso = isoOf(new Date(Date.UTC(year + (kind === 'first' ? 0 : 1), anchor.month - 1, anchor.day)));
        return { iso: weekStartOf(anchorIso) };
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。教务里常见的写法：
    //   "1,2,3"（本校的周号数组）/ "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-3,5-9周" / "第1-第8周"
    // 四个必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单/双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉；
    //      含非周次字的（"(3组)"）也摘掉并计数；其它（"(1-16周)"、"(单)"）保留内容；每组都换成逗号，数字不会粘连；
    //   ④ 空白两头都要顾：破折号连同两侧空白先归一成半角 '-'，剩下的空白当分段符折成逗号。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单/双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3组)」，含非周次的字，不是周次）
    var noteSample = '';     // 第一个备注括号的原文（截短后写进提醒）
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
        // 「共8周」这类课程总周数备注不是上课周次，只剥备注本身；
        // 不能从第一个「共」一路删到行尾 —— 「1-8周(共8周),9-16周」后面的 9-16 周会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'。不要在这里删掉全部空白
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 紧挨周次的单/双括号按相邻关系先归属：前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，
        // 会把 1-16 周都读成每周都上；这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 夹在两段中间的前置标记（「(单)1-8周(双)9-16周」的第二个，含「第(单)...」）：本段以标记开头时它归下一段
            if (/^(?:第)?\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var glue = /^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '';
            return digit + mark + glue;
        });
        // 括号先于删「周」逐组处理（全角括号已在上一步归成半角）
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
        cleaned = cleaned.replace(/[()]/g, ',');   // 落单的括号字符也换成逗号，不许直接删
        cleaned = cleaned.replace(/周/g, '');
        // 区间终点前的「第」（教务常见写法「第1-第8周」）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        // 剩下的空白当分段符折成逗号（fullWidthToHalf 已把全角逗号 / 顿号 / 分号折成半角逗号）
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空，那才是真丢数据）
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

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周（手册 §4.1）
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

    // 教务把按周次分的上课地点写在 jxcdmc2 里："教室-周次,教室-周次"，每个周次一项（上游优先读它）。
    // 教室名里可能带「-」，周次取最后一个「-」后面的数字（与上游一致）；没写教室名时沿用上一间（上游同）。
    // 周次超出 1..MAX_WEEK 的项丢弃并计数；认不出的项计数，由调用方决定要不要提醒
    function venueWeeksOf(source) {
        var out = { venues: [], unreadable: 0 };
        var index = {};
        var lastRoom = '';
        var pieces = text(source).split(/[,，]/);
        for (var i = 0; i < pieces.length; i++) {
            var piece = text(pieces[i]);
            if (!piece) continue;
            var m = /^(.*)-([0-9]+)$/.exec(piece);
            if (!m) { out.unreadable++; continue; }
            var week = parseInt(m[2], 10);
            if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
            var room = text(m[1]);
            if (room) lastRoom = room;
            if (!lastRoom) { out.unreadable++; continue; }
            var at = index['v' + lastRoom];
            if (at === undefined) {
                at = out.venues.length;
                index['v' + lastRoom] = at;
                out.venues.push({ room: lastRoom, weeks: [] });
            }
            out.venues[at].weeks.push(week);
        }
        for (var v = 0; v < out.venues.length; v++) out.venues[v].weeks = unionWeeks(out.venues[v].weeks, []);
        return out;
    }

    // 教师名里方括号的内容是备注（「张三[外聘]」），不是名字的一部分，按上游去掉
    function teacherOf(value) {
        return text(text(value).replace(/\[[^\]]*\]/g, ''));
    }

    // 主教室：jxcdmc；没有且 bapjxcd 为 1 表示这门课不需要场地（上游同）；都没有就留空
    function primaryLocation(row) {
        var primary = text(row.jxcdmc);
        if (primary) return primary;
        if (text(row.bapjxcd) === '1') return '不用场地';
        return '';
    }

    // ---------- 节次 ----------
    // 教务行的起止节次是 ps / pe 两个数字字段（上游 parseInt(record.ps) / parseInt(record.pe)）。
    // 结束节次读不出时当作只上开始那一节（guessed 标出来并提醒）；读得出却小于开始、或超出上限，返回 null
    function sectionsOf(row) {
        var start = intOf(text(row.ps));
        var end = intOf(text(row.pe));
        if (start === null || start < 1 || start > MAX_PERIOD) return null;
        if (end === null) return { start: start, end: start, guessed: true };
        if (end > MAX_PERIOD || end < start) return null;
        return { start: start, end: end, guessed: false };
    }

    // ---------- 同课合并 ----------
    var courses = [];
    var byName = {};
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    // 已导入、但教务没给上课教师 / 上课地点的课（按课名去重，提醒里说「N 门课」才准）
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];     // 这两类课里点名用的课名，最多 3 个
    var weekSamples = [];      // 没解析出周次的原始文本，最多留 3 个
    var guessedCourses = {};   // 没给结束节次、按只上一节处理的课（按课名去重）
    var guessedSamples = [];
    var venueMismatchCourses = {};   // 分周次的上课地点与周次对不上、或有看不懂的部分的课（按课名去重）
    var venueMismatchNames = [];
    var timeChecks = [];       // 排课行带的上课起止时间，用来核对节次时间
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

    // 完全相同的行（课名、教师、教室、星期、起止节次、周次都一样）只留第一条：是同一个上课安排，去掉不算丢课
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

    // 阶段 1（输入已按 orderStageOne 排好）：同一上课安排、周次相同、节次首尾相接（含重叠）的合成一条
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

    // 阶段 2（输入已按 orderStageTwo 排好）：起止节次都一样的，周次取并集
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

    var entries = [];
    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};

        var name = text(row.kcmc);
        if (!name) { missing.name++; continue; }

        var day = intOf(text(row.xq));
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOf(row);
        if (!sections) { missing.period++; continue; }

        // 上课安排 = 一组（地点, 周次）：jxcdmc2 读得出来就按它拆（上游优先读它），读不出来回落到 jxcdmc + zc。
        // zc 里有而 jxcdmc2 里没有的周次，上游是静默丢掉的；这里留下，地点用主教室
        var zcText = text(row.zc);
        var zcWeeks = weeksOf(row.zc);
        var split = venueWeeksOf(row.jxcdmc2);
        var plans = [];
        var mismatch = false;
        var v;
        var w;
        if (split.venues.length) {
            var inVenues = {};
            var inZc = {};
            for (w = 0; w < zcWeeks.length; w++) inZc[zcWeeks[w]] = true;
            for (v = 0; v < split.venues.length; v++) {
                plans.push({ location: split.venues[v].room, weeks: split.venues[v].weeks });
                for (w = 0; w < split.venues[v].weeks.length; w++) {
                    inVenues[split.venues[v].weeks[w]] = true;
                    if (zcWeeks.length && !inZc[split.venues[v].weeks[w]]) mismatch = true;
                }
            }
            var extraWeeks = [];
            for (w = 0; w < zcWeeks.length; w++) {
                if (!inVenues[zcWeeks[w]]) extraWeeks.push(zcWeeks[w]);
            }
            if (extraWeeks.length) {
                plans.push({ location: primaryLocation(row), weeks: extraWeeks });
                mismatch = true;
            }
            if (split.unreadable > 0 || (zcText && !zcWeeks.length)) mismatch = true;
        } else if (zcWeeks.length) {
            plans.push({ location: primaryLocation(row), weeks: zcWeeks });
        }
        if (!plans.length) {
            missing.week++;
            if (zcText && weekSamples.length < 3 && weekSamples.indexOf(zcText) < 0) weekSamples.push(zcText);
            continue;
        }
        if (mismatch && !venueMismatchCourses['n' + name] && venueMismatchNames.length < 3) {
            venueMismatchNames.push(name);
        }
        if (mismatch) venueMismatchCourses['n' + name] = true;

        // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
        // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
        var teacher = teacherOf(row.teaxms) || teacherOf(row.pkr);
        var lackLocation = false;
        for (v = 0; v < plans.length; v++) {
            if (!plans[v].location) lackLocation = true;
        }
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (lackLocation) missingLocationCourses['n' + name] = true;
        if ((!teacher || lackLocation) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
            fieldSamples.push(name);
        }
        if (sections.guessed) {
            if (!guessedCourses['n' + name] && guessedSamples.length < 3) guessedSamples.push(name);
            guessedCourses['n' + name] = true;
        }
        var rowStart = timeOf(row.qssj);
        var rowEnd = timeOf(row.jssj);
        if (rowStart && rowEnd) {
            timeChecks.push({ name: name, start: sections.start, end: sections.end, from: rowStart, to: rowEnd });
        }
        for (v = 0; v < plans.length; v++) {
            entries.push({
                course: courseOf(name, teacher || null),
                name: name,
                teacher: teacher,
                location: plans[v].location,
                day: day,
                start: sections.start,
                end: sections.end,
                weeks: plans[v].weeks
            });
        }
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
            '请重新登录、在教务系统里确认能看到课表后再试'
        );
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var start = estimateStart(todayIso);

    // 教务不给学期总周数（上游也没存）：按 max(课表最晚周次, 20) 导入，课表里更晚的周次必须放得下
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }
    if (totalWeeks < 1) totalWeeks = SCHOOL_TOTAL_WEEKS;

    // ---------- 节次时间 ----------
    // 教务给的（课表页源码里的 businessHours，一行一节：jcdm = 节次，qssj / jssj = 起止时间）优先，逐节照抄：
    // 时间读不懂或结束不晚于开始的行不收；同一节号重复且时间一样只留一条，时间不一样（不知道用哪个）不猜，整张当没取到。
    // reason：none = 什么都没给，bad = 没有一行可用，conflict = 同一节有两个时间
    function periodTablesOf(value) {
        var list = rowsIn(value);
        var result = { slots: [], byIndex: {}, reason: list.length ? 'bad' : 'none' };
        if (!list.length) return result;
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var index = intOf(row.jcdm);
            var start = timeOf(row.qssj);
            var end = timeOf(row.jssj);
            if (index === null || index < 1 || index > MAX_PERIOD || !start || !end) continue;
            if (minutesOf(start) >= minutesOf(end)) continue;
            var known = result.byIndex['n' + index];
            if (known) {
                if (known.start === start && known.end === end) continue;
                result.reason = 'conflict';
                result.slots = [];
                result.byIndex = {};
                return result;
            }
            known = { periodIndex: index, start: start, end: end };
            result.byIndex['n' + index] = known;
            result.slots.push(known);
        }
        result.slots.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        if (!result.slots.length) result.reason = 'bad';
        return result;
    }

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

    var tables = periodTablesOf(data.hours);
    var usedBuiltin = !tables.slots.length;
    var periodTimes = usedBuiltin ? BUILTIN_PERIOD_TIMES.slice(0) : tables.slots.slice(0);
    var slotByIndex = {};
    var pIndex;
    for (pIndex = 0; pIndex < periodTimes.length; pIndex++) {
        slotByIndex['n' + periodTimes[pIndex].periodIndex] = periodTimes[pIndex];
    }
    // 课表用到的节次里，节次时间没有覆盖的逐节补（批次五统一修订 H3）：补哪些、补不了哪些都进 warnings
    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (pIndex = 1; pIndex <= maxPeriod; pIndex++) {
        if (slotByIndex['n' + pIndex]) continue;
        var prev = null;
        for (var back = pIndex - 1; back >= 1; back--) {
            if (slotByIndex['n' + back]) { prev = slotByIndex['n' + back]; break; }
        }
        var prevEnd = prev ? minutesOf(prev.end) : -1;
        var builtinSlot = BUILTIN_PERIOD_TIMES[pIndex - 1];
        // 内置表有这一节、且它的开始不早于前一节下课，才用内置时间（否则会和前一节重叠甚至倒挂）
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            var filled = { periodIndex: pIndex, start: builtinSlot.start, end: builtinSlot.end };
            periodTimes.push(filled);
            slotByIndex['n' + pIndex] = filled;
            fromBuiltin.push(pIndex);
            continue;
        }
        // 否则从上一节下课后顺推：课间 5 分钟、每节 45 分钟；顺推越过 23:59 就停，这一节起不再补
        if (!prev) { uncoveredFrom = pIndex; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = pIndex; break; }
        var extended = { periodIndex: pIndex, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) };
        periodTimes.push(extended);
        slotByIndex['n' + pIndex] = extended;
        bySequence.push(pIndex);
    }

    // 排课行带的上课时间与节次时间对不上的课（按课名去重，点名最多 3 个）
    var rowTimeNames = [];
    var rowTimeCourses = {};
    for (var tc = 0; tc < timeChecks.length; tc++) {
        var check = timeChecks[tc];
        var first = slotByIndex['n' + check.start];
        var last = slotByIndex['n' + check.end];
        var bad = (first && first.start !== check.from) || (last && last.end !== check.to);
        if (bad && !rowTimeCourses['n' + check.name]) {
            rowTimeCourses['n' + check.name] = true;
            if (rowTimeNames.length < 3) rowTimeNames.push(check.name);
        }
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    var source = text(term.source);
    var shownTerm = shortName(name0);
    if (source === 'page') {
        warn(
            '导入的是教务页面里选中的学期（' + shownTerm + '）；要导入别的学期，请先在教务页面里切换到那个学期，再点「提取课表」'
        );
    } else if (source === 'default') {
        warn(
            '导入的是教务系统默认的学期（' + shownTerm + '）；要导入别的学期，请先在教务课表页里切换到那个学期，再点「提取课表」'
        );
    } else {
        warn('导入的是教务系统里当前的学期（' + shownTerm + '）；要导入别的学期，请先在教务页面里切换到那个学期，再点「提取课表」');
    }
    if (termGuessed) {
        warn('教务系统给的学期名里读不出学年和学期，已按当前日期推算学期，开学日期与总周数可能不准，请在学期管理里核对');
    }

    warn(
        '教务系统没有给出开学日期，已按学期推算为 ' + start.iso +
        '，请在学期管理里把它改成学校实际开学日'
    );

    if (raisedBySchedule) {
        warn(
            '教务系统没有给出学期总周数；课表里最晚排到第 ' + maxWeek + ' 周，超过 ' + SCHOOL_TOTAL_WEEKS +
            ' 周，已按 ' + totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (usedBuiltin) {
        var builtinLast = BUILTIN_PERIOD_TIMES[BUILTIN_PERIOD_TIMES.length - 1];
        var whyBuiltin = tables.reason === 'conflict'
            ? '教务系统给的节次时间里同一节有两个不同的时间，无法判断用哪个'
            : '教务系统没有给出可用的节次时间';
        warn(
            whyBuiltin + '，已按空课默认的 ' + BUILTIN_PERIOD_TIMES.length + ' 节节次时间导入（第 1 节 ' +
            BUILTIN_PERIOD_TIMES[0].start + '-' + BUILTIN_PERIOD_TIMES[0].end + '、第 ' + builtinLast.periodIndex + ' 节 ' +
            builtinLast.start + '-' + builtinLast.end + '），时间可能与学校实际不符，请在学期管理里核对'
        );
    }
    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
        if (bySequence.length) {
            fillTexts.push(
                sectionsText(bySequence) + '按前一节下课后课间 ' + EXTEND_BREAK_MINUTES + ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推'
            );
        }
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
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

    // 排课行带了上课起止时间、却与导入的节次时间对不上（多半是单独调过时间的课）：点名几门，课照节次导入
    var rowTimeCount = countKeys(rowTimeCourses);
    if (rowTimeCount > 0) {
        var rowTimeShown = [];
        for (var rt = 0; rt < rowTimeNames.length; rt++) rowTimeShown.push(shortName(rowTimeNames[rt]));
        warn(
            '有 ' + rowTimeCount + ' 门课教务系统给出的上课时间与导入的节次时间对不上（例如 ' + rowTimeShown.join('、') +
            '）：已按节次导入，请与教务系统核对这几门课的上课时间'
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
    var venueMismatchCount = countKeys(venueMismatchCourses);
    if (venueMismatchCount > 0) {
        var venueShown = [];
        for (var vm = 0; vm < venueMismatchNames.length; vm++) venueShown.push(shortName(venueMismatchNames[vm]));
        warn(
            '有 ' + venueMismatchCount + ' 门课分周次的上课地点与它的周次对不上，或有看不懂的部分（例如 ' +
            venueShown.join('、') + '）：两边的周次都已保留，没分到地点的周次用主要地点，请在「编辑课程」里核对'
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
