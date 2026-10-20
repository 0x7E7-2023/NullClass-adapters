(function () {
    // 济源职业技术学院教务适配器（青果教务）—— 第二步：课表表格行 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 JYVTC/jyvtc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf
    //
    // 上游在同一段脚本里弹窗、请求、用正则抠课表行、排序合并、保存、导入预设时间段；这里只做纯转换
    // （不碰页面、不发请求，CI 用 Rhino 实跑）。取数全部在 extract.js 里，交出来的是课表表格行里
    // 每一格的 { a: 单元格有没有属性, lead: 开头文字, ul: 格内第一个列表的纯文字（一行一门课）}。
    // 模板：周次解析、H3 补节次、合并两阶段、提醒汇总取自批次十的 swu 与批次九的 zwu（取数部分与它们不同构，见 AUDIT.md 第 5 节）。
    //
    // 移植改动（逐条对应 AUDIT.md 第 5 节）：
    //   ① 读行号：每个课表行的节次来自行里第一个「开头文字含数字」的单元格（上游同一条规则）；
    //      有属性的单元格共 9 个时第 3 到第 9 个是周一到周日，共 8 个时第 2 到第 8 个是周一到周日，其它个数认不出，计数后写进 warnings
    //   ② 一格里的一门课：「课名 教师 (周次 教室)」。上游正则要求三者齐全，缺教师或缺教室的整行静默丢掉；
    //      这里取最后一个以周次开头的括号：括号前面最后一个空白分隔的词是教师（没有空白就没有教师），
    //      括号里按「开头若干个像周次的词 = 周次，其余 = 教室」切开（教室里带空格也能保住），缺教师 / 缺教室照常导入，汇总进 warnings
    //   ③ 周次：上游只认「1-16」「1,3,5」和整串里的「单周」「双周」，写了「周」字就整段塌成空（Number("16周") 是 NaN）。
    //      这里沿用批次十 swu 的周次解析（「周」字、「第」、全角、「共 N 周」备注、教学班序号括号都认，单/双标记按位置归属）；
    //      整串里恰好只出现一个「单周」或「双周」时按上游口径对整串里每个区间生效，其余按位置归属
    //   ④ 节次时间：上游让用户在「夏季 / 非夏季」里二选一再保存预设时间段，这里按导入当天的月份自动选一套
    //      （5 至 9 月夏季，其余非夏季；上游没有写换季日期，这条是约定，提醒里如实说明），另一套逐节写进 warnings；
    //      课表用到第 11 节及以后时按批次五统一修订 H3 补齐
    //   ⑤ 开学日与总周数：课表页不给，开学日按学期推算（第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一），
    //      总周数取 20 周与课表最大周次中较大者，两条都写进 warnings
    //   ⑥ 合并：上游按「星期 / 课名 / 教师 / 教室 / 周次 / 节次」排序后合并连续节次（阶段 1）。这里先去掉完全相同的行，
    //      再做阶段 1，最后补一步「同课同节次周次取并集」（阶段 2，只是把相同安排拼成更少的上课安排，不改任何一周）
    //   ⑦ 学期名用 xnxq 推出的「2026-2027学年第一学期」；读不出时用「济源职业技术学院 当前学期」
    //   ⑧ 读不出的内容不静默丢弃：括号里找不到周次、缺课名、周次认不出的课、排版认不出的行，各自计数并点名写进 warnings
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据（本校节次 10 节）
    var SCHOOL_NAME = '济源职业技术学院';   // 学期名兜底时用（不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 课表页不给总周数，取 20 周（常见学期长度）与课表最大周次中较大者
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟
    var SUMMER_FIRST_MONTH = 5;    // 夏季节次时间的起止月份（约定，上游没写）：5 月到 9 月
    var SUMMER_LAST_MONTH = 9;

    // 学校节次时间（济源职业技术学院）：上游 JYVTC/jyvtc.js 的 Non_summerTimeSlots / SummerTimeSlots，10 节逐节照抄原值。
    // 第 1-4、9、10 节两套相同，第 5-8 节不同（第 7 节 44 分钟、第 8 节紧接第 7 节，都是上游原值）。
    var NON_SUMMER_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:25', end: '16:10' },
        { periodIndex: 7, start: '16:30', end: '17:14' },
        { periodIndex: 8, start: '17:15', end: '18:00' },
        { periodIndex: 9, start: '19:30', end: '20:14' },
        { periodIndex: 10, start: '20:15', end: '21:00' }
    ];
    var SUMMER_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '15:00', end: '15:45' },
        { periodIndex: 6, start: '15:55', end: '16:40' },
        { periodIndex: 7, start: '17:00', end: '17:44' },
        { periodIndex: 8, start: '17:45', end: '18:30' },
        { periodIndex: 9, start: '19:30', end: '20:14' },
        { periodIndex: 10, start: '20:15', end: '21:00' }
    ];

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到的节次超出学校节次时间时，
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

    var KIND_CN = { first: '一', second: '二' };
    // 推算开学日的锚点：第一学期多在 9 月初、第二学期多在 2 月下旬。
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到「第 1 周的第一天」那个周一（含当天）。
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' }
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

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

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
    // extract.js 交来的 xnxq 形如 2026-0（第一学期）/ 2026-1（第二学期），年份是学年的起始年（上游同一约定）
    var termMatch = /^([0-9]{4})-([01])$/.exec(text(term.xnxq));
    var termYear = termMatch ? parseInt(termMatch[1], 10) : 0;
    var termKind = termMatch && termMatch[2] === '1' ? 'second' : 'first';

    function termName() {
        if (!termMatch) return SCHOOL_NAME + ' 当前学期';
        return termYear + '-' + (termYear + 1) + '学年第' + KIND_CN[termKind] + '学期';
    }

    // 课表页不给开学日，只能按学期序号推算；推算结果一律写进 warnings。
    function estimateStart(todayIso) {
        if (!termYear) {
            // 学期读不出来时退回「今天所在周的周一」。这条分支依赖当天日期，不写进 fixture 用例 —— 用例会随日期失效
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天所在周的周一' };
        }
        var anchor = KIND_ANCHOR[termKind];
        return {
            iso: isoOf(mondayOnOrBefore(termYear + (termKind === 'first' ? 0 : 1), anchor.month, anchor.day)),
            rule: anchor.rule
        };
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。逐段沿用批次十 swu 的 weeksOf：
    //   "1-16" / "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-16(单周)" / "1-3,5-9周" / "第1-第8周" / "1-3周 5-9周"
    // 要点：
    //   ① 「周」只是量词，不能拿它当分段边界，所以先把「周」整个删掉再切段；
    //   ② 单/双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走
    //      （前缀 "(单)1-8周,(双)9-16周" 里两个标记不能都并到前一段）；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的是教学班序号，整组摘掉；含非周次字的备注也摘掉，计数后写进 warnings；
    //   ④ 破折号连同两侧空白先归一，剩下的空白当分段符；「共 N 周」备注只剥备注本身；区间终点前的「第」去掉。
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
        // 周次里常夹着「共8周」这类课程总周数备注，它不是上课周次，只剥备注本身；
        // 不能从第一个「共」一路删到行尾 —— 「1-8周(共8周),9-16周」后面的 9-16 周会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'，
        // "1 -16周(单)" / "1- 16周" / "1～16周" / "1至16周" 都归成标准形态。不要在这里删掉全部空白。
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 紧挨周次的单/双括号按相邻关系先归属，再交给下面的通用括号处理 ——
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
        // 区间终点前的「第」（接受「第1-第8周」）：去掉，否则区间会被拆成第 1 周与第 8 周两段
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

    // 上游口径：整串里恰好出现一个不在括号里的「单周」或「双周」（且没有别的单/双字）时，它对整串里每个区间生效
    // （上游 parseWeeks：整串含「单周」就只留奇数、含「双周」就只留偶数；单独写的一周如「10」不受影响）。
    // 做法：把这个词摘掉，再把标记补到每个区间后面，交给 weeksOf 去过滤。其余写法（括号标记、多个标记）按位置归属。
    function weeksOfCell(source) {
        var cleaned = text(source).replace(/共\s*[0-9]+\s*周?/g, ' ');
        var words = cleaned.match(/[单双]\s*周/g) || [];
        var marks = cleaned.match(/[单双]/g) || [];
        if (words.length !== 1 || marks.length !== 1 || /[(（]\s*[单双]/.test(cleaned)) return weeksOf(cleaned);
        var mark = words[0].charAt(0);
        var plain = fullWidthToHalf(cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-')).replace(/[单双]\s*周/g, ' ');
        var pieces = plain.split(/[,\s]+/);
        var out = [];
        for (var i = 0; i < pieces.length; i++) {
            if (!pieces[i]) continue;
            out.push(/[0-9]-第?[0-9]/.test(pieces[i]) ? pieces[i] + mark : pieces[i]);
        }
        return weeksOf(out.join(','));
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

    // ---------- 一格里的一行：「课名 教师 (周次 教室)」 ----------
    // 顶层括号分组（括号里再套括号算在外层组里）；没闭合的括号忽略
    function groupsOf(source) {
        var groups = [];
        var depth = 0;
        var startAt = -1;
        for (var i = 0; i < source.length; i++) {
            var ch = source.charAt(i);
            if (ch === '(' || ch === '（') {
                if (depth === 0) startAt = i;
                depth++;
            } else if (ch === ')' || ch === '）') {
                if (depth > 0) {
                    depth--;
                    if (depth === 0) groups.push({ start: startAt, end: i });
                }
            }
        }
        return groups;
    }

    var WEEKS_WORD = /^[0-9０-９第周单双,，、;；~～\-－—–至到()（）共]+$/;
    var WEEKS_JOINT = /[,，、;；~～\-－—–至到]$/;
    var WEEKS_STARTS_JOINT = /^[,，、;；~～\-－—–至到]/;
    var WEEKS_FUSED = /^([0-9０-９第,，、;；~～\-－—–至到共]+(?:[(（]?[单双]?周[)）]?|[(（][单双]周?[)）]))(.+)$/;

    // 括号里的内容切成 { weeks: 周次原文, location: 教室原文 }：
    // 开头连续的「像周次的词」是周次（第一个词必须带数字或单/双/周字；之后的词要带「周 / 单 / 双」字，
    // 或者前一个词以逗号 / 破折号结尾，或者还没出现过数字）；其余是教室。
    // 周次与教室之间没有空格但有「周」字（"1-16周A101"）也能切开。
    function splitInner(inner) {
        var tokens = text(inner).split(' ');
        var weeksTokens = [];
        var sawDigit = false;
        var prevJoint = false;
        var rest = [];
        var i = 0;
        for (; i < tokens.length; i++) {
            var token = tokens[i];
            if (!token) continue;
            if (WEEKS_WORD.test(token)) {
                var hasDigit = /[0-9０-９]/.test(token);
                var hasMark = /[周单双]/.test(token);
                if (weeksTokens.length === 0) {
                    if (!hasDigit && !hasMark) break;
                } else if (!(hasMark || !sawDigit || prevJoint || WEEKS_STARTS_JOINT.test(token))) {
                    break;
                }
                weeksTokens.push(token);
                sawDigit = sawDigit || hasDigit;
                prevJoint = WEEKS_JOINT.test(token);
                continue;
            }
            if (weeksTokens.length === 0) {
                var fused = WEEKS_FUSED.exec(token);
                if (fused) {
                    weeksTokens.push(fused[1]);
                    rest.push(fused[2]);
                    i++;
                }
            }
            break;
        }
        for (; i < tokens.length; i++) {
            if (tokens[i]) rest.push(tokens[i]);
        }
        return { weeks: weeksTokens.join(' '), location: text(rest.join(' ')) };
    }

    // 解析一行；认不出结构返回 { fail: 原因 }，原因：group = 括号里没有以周次开头的内容，name = 缺课程名
    function parseLine(line) {
        var source = text(line);
        var groups = groupsOf(source);
        var picked = null;
        for (var g = groups.length - 1; g >= 0; g--) {
            var inner = text(source.substring(groups[g].start + 1, groups[g].end));
            if (/^[0-9０-９第单双(（]/.test(inner)) {
                picked = { inner: inner, start: groups[g].start, end: groups[g].end };
                break;
            }
        }
        if (!picked) return { fail: 'group' };
        var before = text(source.substring(0, picked.start));
        var after = text(source.substring(picked.end + 1));
        var cut = before.lastIndexOf(' ');
        var name = cut > 0 ? text(before.substring(0, cut)) : before;
        var teacher = cut > 0 ? text(before.substring(cut + 1)) : '';
        if (!name) return { fail: 'name' };
        var parts = splitInner(picked.inner);
        return { name: name, teacher: teacher, weeksText: parts.weeks, location: parts.location, trailing: after };
    }

    // ---------- 逐行转换 ----------
    var missingTeacherCourses = {};   // 缺教师的课（按课名去重）
    var missingLocationCourses = {};  // 缺教室的课（按课名去重）
    var fieldSamples = [];            // 缺教师 / 缺教室的课名样例，最多 3 个，写进 warnings
    var unreadable = { group: 0, name: 0, week: 0 };   // 读不出来的课程内容条数（按原因）
    var unreadableSamples = [];       // 读不出来的原文样例，最多 3 条
    var trailingCount = 0;            // 括号后面还跟着别的文字的条数
    var trailingSample = '';
    var badLayoutRows = 0;            // 有课程内容、但排版认不出来的行数
    var maxWeek = 0;
    var maxPeriod = 0;

    var courses = [];
    var byName = {};

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

    function noteUnreadable(reason, original) {
        unreadable[reason]++;
        var sample = shortName(original);
        if (unreadableSamples.length < 3 && unreadableSamples.indexOf(sample) < 0) unreadableSamples.push(sample);
    }

    // ---------- 同课合并（对齐上游的连续节次合并，前面多一步去重、后面多一步周次并集） ----------
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

    // 行里第一个「开头文字含数字」的单元格给出节次（上游：行内第一个 <td> 后面、下一个标签前的文字里的第一串数字）
    function sectionOfRow(cells) {
        for (var i = 0; i < cells.length; i++) {
            var m = /([0-9]+)/.exec(text((cells[i] || {}).lead));
            if (m) return parseInt(m[1], 10);
        }
        return 0;
    }

    var anyContent = false;   // 整个响应里有没有任何一格带课程内容
    for (var r = 0; r < rows.length; r++) {
        var cells = Array.isArray((rows[r] || {}).cells) ? rows[r].cells : [];
        var hasContent = false;
        var attributed = [];
        for (var c0 = 0; c0 < cells.length; c0++) {
            var cell0 = cells[c0] || {};
            if (text(cell0.ul)) hasContent = true;
            if (cell0.a === 1) attributed.push(cell0);
        }
        if (!hasContent) continue;   // 没有任何课程内容的行（表头、分隔行）不算数
        anyContent = true;

        var section = sectionOfRow(cells);
        var dayCells = null;
        if (section >= 1 && section <= MAX_PERIOD) {
            // 有属性的单元格共 9 个：前两个是「上午 / 下午」之类的分组和节次；共 8 个：第一个是节次（上游同一规则）
            if (attributed.length === 9) dayCells = attributed.slice(2, 9);
            else if (attributed.length === 8) dayCells = attributed.slice(1, 8);
        }
        if (!dayCells) { badLayoutRows++; continue; }

        for (var d = 0; d < dayCells.length; d++) {
            var lines = String(dayCells[d].ul || '').split('\n');
            for (var li = 0; li < lines.length; li++) {
                var line = text(lines[li]);
                if (!line) continue;
                var parsed = parseLine(line);
                if (parsed.fail) { noteUnreadable(parsed.fail, line); continue; }
                var weeks = weeksOfCell(parsed.weeksText);
                if (!weeks.length) { noteUnreadable('week', line); continue; }
                if (parsed.trailing) {
                    trailingCount++;
                    if (!trailingSample) trailingSample = shortName(parsed.trailing);
                }
                // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
                // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
                if (!parsed.teacher) missingTeacherCourses['n' + parsed.name] = true;
                if (!parsed.location) missingLocationCourses['n' + parsed.name] = true;
                if ((!parsed.teacher || !parsed.location) && fieldSamples.length < 3 &&
                    fieldSamples.indexOf(parsed.name) < 0) {
                    fieldSamples.push(parsed.name);
                }
                entries.push({
                    course: courseOf(parsed.name, parsed.teacher || null),
                    name: parsed.name,
                    teacher: parsed.teacher,
                    location: parsed.location,
                    day: d + 1,
                    start: section,
                    end: section,
                    weeks: weeks
                });
            }
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

    var name0 = termName();

    if (!anyContent) {
        throw new Error(
            '这个学期（' + name0 + '）在教务系统里还没有课；如果要导入别的学期，' +
            '请在教务页面里切换学期后再点「提取课表」'
        );
    }
    if (!courses.length) {
        throw new Error(
            '教务系统返回了课表，但没有一门课能读成课程（课表页面的格式可能改过）：' +
            '请把这个问题反馈给我们，并附上教务系统里课表页的截图'
        );
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

    // ---------- 开学日 / 总周数 ----------
    var todayRaw = isoOfAny(data.today);
    var todayIso = todayRaw || localTodayIso();
    var start = estimateStart(todayIso);

    // 课表页不给总周数。取 20 周与课表最大周次中较大者；endWeek 超过 totalWeeks 会被载荷校验拒掉，所以必须放得下。
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    // ---------- 节次时间：按导入当天的月份选一套（5 至 9 月夏季，其余非夏季；今天读不到按非夏季） ----------
    var todayMonth = todayRaw ? parseInt(todayRaw.substring(5, 7), 10) : 0;
    var summer = todayMonth >= SUMMER_FIRST_MONTH && todayMonth <= SUMMER_LAST_MONTH;
    var seasonTable = summer ? SUMMER_PERIOD_TIMES : NON_SUMMER_PERIOD_TIMES;
    var otherTable = summer ? NON_SUMMER_PERIOD_TIMES : SUMMER_PERIOD_TIMES;
    var periodTimes = seasonTable.slice(0);
    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        var prevEnd = minutesOf(prev.end);
        var builtinSlot = BUILTIN_PERIOD_TIMES[p - 1];
        // 内置表有这一节、且它的开始不早于上一节下课，才用内置时间（否则会和上一节重叠甚至倒挂）
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: builtinSlot.start, end: builtinSlot.end });
            fromBuiltin.push(p);
            continue;
        }
        // 否则从上一节下课后顺推：课间 5 分钟、每节 45 分钟；顺推越过 23:59 就停，这一节起不再补
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // 另一套节次时间里与当前这套不同的节次，逐节写出来（学生换季时好改）
    function differingSlotsText() {
        var parts = [];
        for (var s = 0; s < seasonTable.length; s++) {
            if (seasonTable[s].start === otherTable[s].start && seasonTable[s].end === otherTable[s].end) continue;
            parts.push('第 ' + otherTable[s].periodIndex + ' 节 ' + otherTable[s].start + '-' + otherTable[s].end);
        }
        return parts.join('、');
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    if (text(term.source) === 'page') {
        warn(
            '只导入了教务页面上当前选中的学期（' + name0 +
            '）；要导入别的学期，请先在教务系统里切到那个学期再点「提取课表」'
        );
    } else {
        warn(
            '没能从教务页面读到当前学期，已按今天的日期判断为「' + name0 +
            '」；如果不是你要的学期，请在「学期管理」里核对学期名称，并把这个问题反馈给我们'
        );
    }

    warn(
        '教务系统没有给出开学日期，第 1 周按「' + start.rule +
        '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
    );

    if (raisedBySchedule) {
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    var seasonCn = summer ? '夏季' : '非夏季';
    var otherCn = summer ? '非夏季' : '夏季';
    warn(
        SCHOOL_NAME + '的节次时间分夏季和非夏季两套，只有第 5-8 节不同。' +
        (todayRaw ? '按今天的日期' : '今天的日期没有读到，先') + '用了' + seasonCn +
        '节次时间（夏季按 ' + SUMMER_FIRST_MONTH + '-' + SUMMER_LAST_MONTH + ' 月估计，具体换季日期以学校通知为准），换季后请在「学期管理」里改节次时间'
    );
    warn('另一套（' + otherCn + '）节次时间：' + differingSlotsText());

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

    var skippedLines = unreadable.group + unreadable.name + unreadable.week;
    if (skippedLines > 0) {
        var reasons = [];
        if (unreadable.group) reasons.push('括号里找不到周次 ' + unreadable.group + ' 条');
        if (unreadable.name) reasons.push('缺课程名 ' + unreadable.name + ' 条');
        if (unreadable.week) reasons.push('周次认不出或全超出 1-' + MAX_WEEK + ' 周 ' + unreadable.week + ' 条');
        var sampleTexts = [];
        for (var us = 0; us < unreadableSamples.length; us++) sampleTexts.push('「' + unreadableSamples[us] + '」');
        warn(
            '有 ' + skippedLines + ' 条课程内容没能读成课程（' + reasons.join('、') + '），已跳过，例如 ' +
            sampleTexts.join('') + '：如发现少课请反馈'
        );
    }
    if (badLayoutRows > 0) {
        warn(
            '有 ' + badLayoutRows + ' 行课表的排版和预期不一样（认不出是第几节或哪天的课），这些行里的课程已跳过：如发现少课请反馈'
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
    if (trailingCount > 0) {
        warn(
            '有 ' + trailingCount + ' 条课程在括号后面还有别的文字（如「' + trailingSample + '」），这部分没有导入'
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
