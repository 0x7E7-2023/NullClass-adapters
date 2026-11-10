(function () {
    // 北方工业大学教务适配器（正方教务 jsxsd，jwxtbk.ncut.edu.cn）—— 第二步：课表页上的原始内容 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 NCUT/ncut_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 EnderHCO3）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 与 origin/main 对齐）
    //   本校脚本最后一次修改 1fe584c（已用 git log -1 -- resources/NCUT/ncut_01.js 核对一致）
    //
    // 上游在同一段脚本里既取数又算周次、拼课程、存配置；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交出来的是课表页上的行（首格节次区间与起止时间、各天的课程格）、
    // 周次下拉框里的日期清单与学年学期。
    //
    // 移植改动（按移植手册 §4 与批次三十三公共说明逐条对照）：
    //   ① 周次：上游只认「一个区间 + 单/双周字样」，这里用同族已审的强解析 —— 多段（"1-3,5-9周"）、
    //      单双标记的前置 / 后置 / 括号里、无逗号前置（"(单)1-8周(双)9-16周"）、「共 N 周」备注、
    //      全角数字与各种破折号、方括号（"[1-16周]"）、括号里的教学班序号与备注，全部照模板处理。
    //      上游读不出的写法会让整门课被静默丢掉（上游那段 return [] 之后直接 return）。
    //   ② 节次时间：上游每行首格只取首、末两节 —— 本节开始时间 + 45 分钟当首节下课，
    //      整段结束时间 − 45 分钟当末节开始，每节固定 45 分钟；这里照抄这套算法。
    //      一行跨 3 节及以上时中间几节页面上本来就没有，按「统一修订 H3」补齐并提醒（先按上一节下课后顺推，
    //      顺推会压到下一节已知时间时就不补并如实说明）；课表用到表外的更晚节次也按 H3 补。
    //   ③ 开学日与总周数：#week 下拉框的值就是每周日期，第一个有效日期当第 1 周、有效项个数当总周数（上游同）；
    //      开学日按手册 §4.3 回退到那一周的周一。页面上没有这个下拉框时按学期锚点推算并提醒。
    //   ④ 学期名：上游不存学期名。这里优先用页面上的学年学期下拉框，读不到就用开学日推出学年 + 学期序号
    //      （手册 §4.7：别拿适配器名当学期名）。
    //   ⑤ 课程：td.kb-cell 的列序 1..7 就是星期（一个格子里可以有好几门课，逐门收）；
    //      .person-class 里 h3 a 是课名，第 2/3/4 个 li 是周次 / 教师 / 教室。li 不足 4 个的格子跳过并计数，
    //      不静默丢；教师与教室没有就留空（手册 §4.7），按类型汇总进提醒。
    //   ⑥ 合并：照同族模板的两阶段（连续节次合并 + 同节次周次并集），合并前先去完全相同的行；
    //      合并条件用「下一节不晚于本节 + 1」（含重叠与重复行，批次十九的教训），不丢课、不改任何一周的安排。
    //   ⑦ 上游的导出流程（saveImportedCourses / saveCourseConfig / savePresetTimeSlots / showToast /
    //      notifyTaskCompletion）与出错时静默吞掉，都不移植：空课由宿主保存，适配器只交载荷。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var week = data.week || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '北方工业大学';   // 学期名兜底时用
    var SCHOOL_TOTAL_WEEKS = 20;   // 页面上没有周次下拉框时的学期总周数
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var SECTION_MINUTES = 45;      // 本校每节固定 45 分钟（上游写死）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表页上没读到节次时间时整张用它；
    // 课表用到表外的更晚节次时，内置表里有这一节、且开始不早于上一节下课，就用它的时间（统一修订 H3）
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
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到「第 1 周的第一天」那一周的周一（含当天）。
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

    // "08:10" / "8:10" / "08:10:00" → "08:10"；认不出来（含 24:00、85:45 这类）返回 null。
    // 载荷校验要求 periodTimes 的时间必须是 HH:mm 且 00:00–23:59，写进去的越界时间会让整包被拒。
    function timeOf(value) {
        var m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(text(value));
        if (!m) return null;
        return (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2];
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
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

    // ---------- 学期序号与学期名 ----------
    // 优先看学期下拉框的文本（「一/二/三」），认不出来再看正方自己的学期代号
    // （正方教务的学期代号常见写法：3 = 第一学期、12 = 第二学期、16 = 第三学期；个别部署写成 1 / 2）
    function termKindFromPage() {
        var label = text(term.xqmText);
        if (label.indexOf('二') >= 0) return 'second';
        if (label.indexOf('三') >= 0) return 'third';
        if (label.indexOf('一') >= 0) return 'first';
        var code = text(term.xqm);
        if (code === '12' || code === '2') return 'second';
        if (code === '16') return 'third';
        return '';
    }

    // 页面上没有学期下拉框时，按开学日所在的月份判第几学期：2-7 月是第二学期，其余是第一学期
    function termKindFromMonth(iso) {
        var month = parseInt(iso.substring(5, 7), 10);
        if (month >= 2 && month <= 7) return 'second';
        return 'first';
    }

    function termYear() {
        return /^[0-9]{4}$/.test(text(term.xnm)) ? parseInt(text(term.xnm), 10) : 0;
    }

    // 学年读不出来就按开学日推：第一学期从开学那年算起，第二学期从上一年的 9 月起算
    function academicYear(startIso, kind) {
        var fromPage = termYear();
        if (fromPage) return fromPage;
        var year = parseInt(startIso.substring(0, 4), 10);
        if (isNaN(year)) return 0;
        return kind === 'first' ? year : year - 1;
    }

    // 学期名用教务自己的学年学期（手册 §4.7：别拿适配器名当学期名）
    function termName(startIso, kind) {
        var explicit = text(term.name);
        if (explicit) return explicit;
        var whole = text(term.xqmText);
        // 有的学校把整个「2026-2027学年第一学期」放进学期下拉框
        if (whole && whole.indexOf('学年') >= 0 && whole.indexOf('学期') >= 0) return whole;
        var year = academicYear(startIso, kind);
        if (!year) return SCHOOL_NAME + ' 第' + KIND_CN[kind] + '学期';
        return year + '-' + (year + 1) + '学年第' + KIND_CN[kind] + '学期';
    }

    // 页面上没有周次下拉框时的开学日推算。推算结果一律写进 warnings。
    function estimateStart(todayIso, kind) {
        var anchor = KIND_ANCHOR[kind];
        var year = termYear();
        if (!year) {
            // 学年读不出来时退回「今天的周一」。这条分支依赖当天日期，不要写进 fixture 用例
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天的周一' };
        }
        return {
            iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), anchor.month, anchor.day)),
            rule: anchor.rule
        };
    }

    // 教务页面只显示某一周的课时，导入会漏掉其它周：宁可报错也不悄悄少课（上游的说明也要求切到「全部」）
    var oldWeek = text(week.selected);
    if (week.hasAll && oldWeek && oldWeek !== 'all') {
        throw new Error(
            '教务页面现在只显示一周的课（' + shortName(text(week.selectedText) || oldWeek) + '），导入会漏掉其它周。' +
            '请把课表上方的周次切到「全部」，再点「提取课表」'
        );
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。正方常见的写法：
    //   "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-16(单周)" / "1-3,5-9周" / "17周" / "1-3周 5-9周" / "[1-16周]"
    // 四个必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单/双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //      万一标记自己成了一段（"1-16周,双"），并给最近的周次段，不丢；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉，免得被当成第 1-2 周；
    //      含非周次字的（"(3组)"）也摘掉，计数后写进 warnings；其它（"(1-16周)"、"(单)"）保留内容；每组都换成逗号，数字不会粘连；
    //   ④ 空白两头都要顾：破折号**连同两侧的空白**先归一成半角 '-'；剩下的空白**当分段符**折成逗号 ——
    //      "1-16周 双" 的标记自成一段、"1-3周 5-9周" 是两段。先全文删空白会把 "1-3周 5-9周"
    //      拼成 "1-35" → 1-30 全周，静默吞掉一段。
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
            .replace(/[～~—－–—至到]/g, '-');
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // 上游用方括号包周次，方形括号不是周次内容，直接去掉
        cleaned = cleaned.split('[').join('').split(']').join('');
        // 周次里常夹着「共8周」这类课程总周数备注，它不是上课周次，只剥备注本身；
        // 不能从第一个「共」一路删到行尾 —— 「1-8周(共8周),9-16周」后面的 9-16 周会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // ④ 第一步：破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'，
        //    "1 -16周(单)" / "1- 16周" / "1～16周" / "1至16周" 都归成标准形态。**不要在这里删掉全部空白**。
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 紧挨周次的单/双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上；
        //   这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"，标记就跟着自己那一段走
        //   前缀只认在段首（字符串开头或分隔符之后）：标记前面紧挨着数字或「周」（中间可有空白）时它是上一段的后缀，
        //   "1-8周(单) 9-16周(双)" 里的 "(单)" 不能被后面的 "9" 抢去当前缀；后缀后面紧跟下一段的数字时补一个逗号隔开
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 夹在两段中间的标记：本段以前置标记开头时（「(单)1-8周(双)9-16周」的第二个标记）它是下一段的前缀，补逗号隔开；
            // 否则仍是上一段的后缀（「1-8周(单)9-16周(双)」）
            if (/^\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            return digit + mark + (/^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '');
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
        // 终点前的「第」（「第1-第8周」）会让区间断成两截，逐段匹配前先去掉；
        // 括号备注在上一段已经摘走，所以提醒里仍能写原文
        cleaned = cleaned.replace(/第/g, '');
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
                for (var value = start; value <= end; value++) {
                    if (onlyOdd && value % 2 === 0) continue;
                    if (onlyEven && value % 2 === 1) continue;
                    if (value < 1 || value > MAX_WEEK) { droppedWeeks++; continue; }
                    if (!seen[value]) { seen[value] = true; weeks.push(value); }
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

    // ---------- 节次时间（课表页每行首格的两个 p） ----------
    // 上游算法：本节开始时间 + 45 分钟当首节下课，整段结束时间 − 45 分钟当末节开始；
    // 一行只产出首、末两节，每节固定 45 分钟。中间几节页面上没有，按 H3 补（见下面 fillGap / fillTail）。
    var slotMap = {};
    var slotConflict = 0;

    function addSlot(index, startMinutes, endMinutes) {
        if (!(index >= 1 && index <= MAX_PERIOD)) return;
        if (isNaN(startMinutes) || isNaN(endMinutes)) return;
        if (endMinutes <= startMinutes) return;
        if (startMinutes < 0 || endMinutes > 23 * 60 + 59) return;
        var startText = hhmmOf(startMinutes);
        var endText = hhmmOf(endMinutes);
        var key = 'p' + index;
        var found = slotMap[key];
        if (found) {
            // 同一节给出两种时间：留第一次出现的，计数后提醒（不静默改时间）
            if (found.start !== startText || found.end !== endText) slotConflict++;
            return;
        }
        slotMap[key] = { periodIndex: index, start: startText, end: endText };
    }

    // 一行的节次区间与整段起止时间；读不出来返回 null（调用方按「这一行没有节次时间」计数）
    function spanOf(row) {
        var first = intOf(row.first);
        var last = intOf(row.last);
        if (first === null || last === null) return null;
        if (first < 1 || first > MAX_PERIOD || last < 1 || last > MAX_PERIOD) return null;
        if (first > last) { var swap = first; first = last; last = swap; }
        var start = timeOf(row.start);
        var end = timeOf(row.end);
        if (!start || !end) return null;
        var beginMinutes = minutesOf(start);
        var endMinutes = minutesOf(end);
        if (endMinutes <= beginMinutes) return null;
        return { first: first, last: last, begin: beginMinutes, end: endMinutes };
    }

    // ---------- 逐行转换 ----------
    var courses = [];
    var byName = {};
    var missing = { name: 0, short: 0, day: 0, week: 0 };
    var noTimeRows = 0;        // 有课程格但整行没有节次时间（上游同样跳过，但这里要计数说出来）
    // 已导入、但教务没给上课教师 / 上课地点的课（按课名去重，提醒里说「N 门课」才准）
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];     // 这两类课里点名用的课名，最多 3 个
    var weekSamples = [];      // 没解析出周次的原始文本，最多留 3 个，写进 warnings 方便反馈
    var maxWeek = 0;
    var maxPeriod = 0;

    // 「未知」「暂无」「待定」「暂无教师」「暂无教室」这类占位词不是真名，交出去必须是空
    function realValue(value) {
        var line = text(value);
        if (!line) return '';
        var bare = line.replace(/[()（）\s]/g, '');
        if (/^(未知|暂无|待定|未定|无|空)(教师|老师|教室|地点)?$/.test(bare)) return '';
        return line;
    }

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

    // ---------- 同课合并（对齐同族模板的两阶段语义） ----------
    // 每行收成一条 entry（课程、教师、教室、星期、起止节次、周次集合）后套三步：
    //   0：完全相同的行只留一条（dropExactDuplicates）；
    //   阶段 1：名称、教师、教室、星期、周次都一样、且下一节不晚于本节 + 1 的合成一条（含重叠与重复行）；
    //   阶段 2：名称、教师、教室、星期、起止节次都一样的，周次取并集。
    // 不丢课、不改任何一周的安排。
    var entries = [];

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
                // 「下一节不晚于本节 + 1」：正好接着、重叠、重复行都并进来（批次十九的教训）
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

    var r;
    var k;
    for (r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var span = spanOf(row);
        var days = Array.isArray(row.days) ? row.days : [];
        if (!span) noTimeRows++;
        for (var d = 0; d < days.length; d++) {
            var dayEntry = days[d] || {};
            var day = intOf(dayEntry.day);
            var list = Array.isArray(dayEntry.courses) ? dayEntry.courses : [];
            for (k = 0; k < list.length; k++) {
                var item = list[k] || {};
                if (!span) continue;
                var name = text(item.name);
                if (!name) { missing.name++; continue; }
                var liCount = intOf(item.li);
                // 上游：li 不足 4 个的格子直接 return（周次 / 教师 / 教室至少要有三项）
                if (liCount !== null && liCount < 4) { missing.short++; continue; }
                if (!(day >= 1 && day <= 7)) { missing.day++; continue; }
                var weeks = weeksOf(item.weeks);
                if (!weeks.length) {
                    missing.week++;
                    var sample = text(item.weeks);
                    if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
                    continue;
                }
                // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
                // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
                var teacher = realValue(item.teacher);
                var location = realValue(item.location);
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
                    start: span.first,
                    end: span.last,
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
        var entry = merged[m];
        var runs = runsOf(entry.weeks);
        for (var ri = 0; ri < runs.length; ri++) {
            var run = runs[ri];
            if (run.end > maxWeek) maxWeek = run.end;
            if (entry.end > maxPeriod) maxPeriod = entry.end;
            entry.course.blocks.push({
                dayOfWeek: entry.day,
                startPeriod: entry.start,
                endPeriod: entry.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: entry.location || null
            });
        }
    }

    if (!courses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录，打开「我的课表」确认能看到课表后再试'
        );
    }

    // 合并用的 entry 与分组表都是内部数据，不进载荷
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
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var weekValues = Array.isArray(week.values) ? week.values : [];
    var pageFirstIso = null;
    for (var wv = 0; wv < weekValues.length && !pageFirstIso; wv++) {
        pageFirstIso = isoOfAny(weekValues[wv]);
    }
    var pageWeeks = weekValues.length;   // 周次下拉框里有效的日期项个数（上游拿它当学期总周数）

    var kind = termKindFromPage() || termKindFromMonth(pageFirstIso || todayIso);
    var start;
    if (pageFirstIso) {
        start = { iso: mondayOfIso(pageFirstIso), rule: '教务系统课表页上的周次列表' };
    } else {
        start = estimateStart(todayIso, kind);
    }
    kind = termKindFromPage() || termKindFromMonth(start.iso);
    var name0 = termName(start.iso, kind);

    // 课表页给出周数就用它，但课表里更晚的周次必须放得下（endWeek 超过 totalWeeks 会被载荷校验拒掉），
    // 抬高时单独说明
    var totalWeeks = pageWeeks > 0 ? pageWeeks : SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }
    if (totalWeeks < 1) totalWeeks = SCHOOL_TOTAL_WEEKS;

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

    // ---------- 节次时间表：课表页给的优先，缺的 / 表外的按 H3 补，补不了如实说明 ----------
    // 先把每行的首、末两节按上游算法摊进表里：本节开始 + 45 分钟是首节下课，整段结束 − 45 分钟是末节开始
    for (r = 0; r < rows.length; r++) {
        var slotSpan = spanOf(rows[r] || {});
        if (!slotSpan) continue;
        addSlot(slotSpan.first, slotSpan.begin, slotSpan.begin + SECTION_MINUTES);
        addSlot(slotSpan.last, slotSpan.end - SECTION_MINUTES, slotSpan.end);
    }

    var tableMax = 0;
    for (var si = 1; si <= MAX_PERIOD; si++) {
        if (slotMap['p' + si] && si > tableMax) tableMax = si;
    }
    var periodTimes = [];
    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    var gapSlots = [];        // 页面上本来就没有、顺推也塞不进下一节已知时间的节次
    var usedBuiltin = tableMax === 0;

    if (usedBuiltin) {
        for (var bi = 0; bi < BUILTIN_PERIOD_TIMES.length; bi++) {
            periodTimes.push({
                periodIndex: BUILTIN_PERIOD_TIMES[bi].periodIndex,
                start: BUILTIN_PERIOD_TIMES[bi].start,
                end: BUILTIN_PERIOD_TIMES[bi].end
            });
        }
    }

    function lastEndMinutes() {
        if (!periodTimes.length) return -1;
        return minutesOf(periodTimes[periodTimes.length - 1].end);
    }

    // 表外的更晚节次：内置表里有这一节、开始不早于上一节下课就用它，接不上按上一节下课后顺推
    function fillTail(index) {
        var prevEnd = lastEndMinutes();
        var builtinSlot = BUILTIN_PERIOD_TIMES[index - 1];
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: index, start: builtinSlot.start, end: builtinSlot.end });
            fromBuiltin.push(index);
            return true;
        }
        if (prevEnd < 0) { uncoveredFrom = index; return false; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = index; return false; }
        periodTimes.push({ periodIndex: index, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(index);
        return true;
    }

    // 页面上缺的中间节次：从上一节下课后顺推；顺推会压到下一节已知时间就宁可空着（空着的如实提醒）
    function fillGap(index, nextKnownStart) {
        var prevEnd = lastEndMinutes();
        if (prevEnd < 0) return false;
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) return false;
        if (nextKnownStart >= 0 && nextEnd > nextKnownStart) return false;
        periodTimes.push({ periodIndex: index, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(index);
        return true;
    }

    if (!usedBuiltin) {
        for (var gp = 1; gp <= tableMax; gp++) {
            var known = slotMap['p' + gp];
            if (known) { periodTimes.push(known); continue; }
            // 后面最近的一个已知节次，用来判断顺推会不会压到它
            var nextKnown = -1;
            for (var nn = gp + 1; nn <= tableMax; nn++) {
                if (slotMap['p' + nn]) { nextKnown = minutesOf(slotMap['p' + nn].start); break; }
            }
            if (!fillGap(gp, nextKnown)) gapSlots.push(gp);
        }
    }
    // 表没补齐（中间有空着的节次）时不再往后接，免得接在空档后面
    if (usedBuiltin || periodTimes.length >= tableMax) {
        for (var ep = periodTimes.length + 1; ep <= maxPeriod; ep++) {
            if (!fillTail(ep)) break;
        }
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    warn(
        '只导入了教务系统当前显示的学期（' + shortName(name0) +
        '）；要导入别的学期，请回到教务系统把学期切到那一个，再点「提取课表」'
    );

    if (pageFirstIso) {
        warn('开学日期取自教务系统课表页上的周次列表：第 1 周从 ' + start.iso + ' 开始，请在学期管理里核对');
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start.rule +
            '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raisedBySchedule && pageWeeks > 0) {
        warn(
            '课表页上的周次列表有 ' + pageWeeks + ' 周，课表里有第 ' + maxWeek + ' 周的课，已按 ' +
            totalWeeks + ' 周导入（否则第 ' + (pageWeeks + 1) + ' 周起的课放不下）'
        );
    } else if (raisedBySchedule) {
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入，如与实际不符可在学期管理里改'
        );
    } else if (pageWeeks > 0) {
        warn(
            '学期总周数取自课表页上的周次列表（' + totalWeeks + ' 周）' +
            (clamped ? '，已按最多 ' + MAX_WEEK + ' 周导入' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期周次，学期总周数按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (usedBuiltin) {
        warn(
            '课表页上没有读到节次时间，已按空课默认的节次时间导入（第 1 节 ' +
            BUILTIN_PERIOD_TIMES[0].start + '-' + BUILTIN_PERIOD_TIMES[0].end + '），请在学期管理里核对'
        );
    }
    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
        warn(
            '节次时间表里的' + sectionsText(filledAll) + '没有时间，已补上：' + fillTexts.join('，') +
            '，请在学期管理里核对'
        );
    }
    if (gapSlots.length) {
        warn(
            '节次时间表里的' + sectionsText(gapSlots) + '没有时间：页面上这几节的时间推不出来，' +
            '这些节次上的课时间可能不准（课程已导入），请在学期管理里补上'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }
    if (slotConflict > 0) {
        warn(
            '有 ' + slotConflict + ' 处同一节次给出了两种时间，已按第一次出现的导入，请在学期管理里核对'
        );
    }

    var skipped = missing.name + missing.short + missing.day + missing.week + noTimeRows;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 处');
        if (missing.short) reasons.push('课程格子里的信息少于 4 项 ' + missing.short + ' 处');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 处');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 处');
        if (noTimeRows) reasons.push('没有节次时间的课表行 ' + noTimeRows + ' 行');
        if (weekSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push(shortName(weekSamples[ws]));
            reasons.push('认不出的周次写法如「' + sampleTexts.join('」「') + '」');
        }
        warn(
            '有 ' + skipped + ' 处课表数据不全（' + reasons.join('、') +
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
})()
