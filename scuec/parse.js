(function () {
    // 中南民族大学教务适配器（webvpn.scuec.edu.cn 代理访问的正方 ASP.NET 课表页）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 SCUEC/scuec.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Zellon0w0）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 12952a3（2026-09-08，与任务卡一致）
    //
    // 上游在同一段脚本里读表格、切课程、拼周次、算节次时间；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑）。
    // extract.js 交过来的是每行的节次一格文字、每列课程格子的课程块，以及未安排课程表的前三列。
    //
    // 移植改动（周次写法照批次十已审计的 swu / hnsf 与批次十八已审计的 jxfu，逐条对得上 AUDIT.md）：
    //   ① 格子切分：上游按 <hr> 切课程块、<br> 切行；这里 extract.js 已经切好，本文件只管字段：
    //      课名在第一行、周次与节次跟在课名后面、教师与地点在后面几行（与上游 parseSingleCourse 一致）
    //   ② 周次：上游只认第一行里第一个「1-16周」片段，多段与括号里的整段周次会丢；这里把节次整段摘除后
    //      把整段文字交给 weeksOf（支持 (单)1-8周,(双)9-16周、第1周至第8周、共 N 周只剥备注、括号整段周次）
    //   ③ 节次：课程行里写了「第1-2节」就用它；没写就用所在行的节次；都没有但有自定义上课时间的，
    //      按手册 §4.4 找最接近的一节；实在没有就跳过并计数（不许静默丢课）
    //   ④ 教师、教室缺了照常导入（null），按类型汇总写进提醒；上游缺哪个仍保留整门课，但会把「待定」当真值
    //   ⑤ 去重与合并：完全相同的行先去重；同名、同教师、同地点、同星期、同周次的相邻节次合并
    //      （首尾相接或重叠），单周行与双周行不会被并成「每周都上」
    //   ⑥ 学期名：上游没有学期概念。教务不给学期文本，这里按今天的日期推算学年学期，
    //      学期名写成「学校名 + 学年学期」（手册 §4.7 不许用适配器名），并写进提醒
    //   ⑦ 开学日：上游明确不给（semesterStartDate 留空）；这里按第一学期 9 月 1 日 / 第二学期次年 3 月 2 日
    //      所在周的周一推算，并在提醒里说明是推算的
    //   ⑧ 总周数：上游没有。这里按公共口径 max(课表最晚周, 20)，最多 30，抬高时提醒
    //   ⑨ 节次时间：上游 generateTimeSlots 先从课表页每一行的节次格读「第N节 + 08:00~08:45」，
    //      读不到回落到它写死的 11 节表；这里照做，课表用到表外节次时按批次五统一修订 H3 逐节补齐并提醒
    //   ⑩ 未安排时间的课程：上游给 day = 0、节次 0（我们放不进课表），这里改成点名提醒，不静默吞掉
    //   ⑪ 上游的 showAlert / showToast / saveImportedCourses / savePresetTimeSlots / notifyTaskCompletion
    //      全部不移植，空课由宿主保存，适配器只交载荷
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var rows = data.rows instanceof Array ? data.rows : [];
    var unscheduled = data.unscheduled instanceof Array ? data.unscheduled : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给总周数时的兜底
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名 / 原文最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟
    var NEAREST_PERIOD_MINUTES = 60; // 只有自定义上课时间时，找最接近的一节，差值上限
    var SCHOOL_NAME = '中南民族大学';  // 学期名兜底时用（「学校名 + 学年学期」，不用适配器名）
    var KIND_CN = { 1: '一', 2: '二' };

    // 上游 generateTimeSlots 写死的兜底表（课表页上没有节次时间时用它），逐节照抄原值
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '14:10', end: '14:55' },
        { periodIndex: 6, start: '15:05', end: '15:50' },
        { periodIndex: 7, start: '16:00', end: '16:45' },
        { periodIndex: 8, start: '16:55', end: '17:40' },
        { periodIndex: 9, start: '18:40', end: '19:25' },
        { periodIndex: 10, start: '19:30', end: '20:15' },
        { periodIndex: 11, start: '20:20', end: '21:05' }
    ];

    // 课程行里的节次：「(第1-2节)」与「第3节」都认；也用来把节次从周次文字里整段摘除
    var SECTION_NUM_RE = /第\s*([0-9]+(?:\s*[,，、\-~至]\s*[0-9]+)*)\s*节/;
    // 周次文字的起点（课名在这里结束）：第1-16周、1-8周、第1周至第8周 都算。
    // 紧挨周次前面的单 / 双标记也属于周次文本：「高等数学(单)1-8周」的课名是「高等数学」，
    // 标记不能留在课名里，否则课名带括号还丢掉单周
    var WEEK_START_RE = /(?:[（(]\s*[单双]\s*周?\s*[）)]\s*)?第?\s*[0-9]+(?:\s*[-~至到]\s*第?\s*[0-9]+)?\s*周/;
    // 自定义上课时间：「(08:00-09:40)」
    var CUSTOM_TIME_RE = /[（(]?\s*([0-9]{1,2}:[0-9]{2})\s*[-~至]\s*([0-9]{1,2}:[0-9]{2})\s*[）)]?/;
    // 长得像教室编号的附加文字按地点处理，别当成人名：A305 / B12 / 1-101 / 10-305 / C-203 / A305-1
    var ROOM_CODE_RE = /^(?:[A-Za-z]{0,3}[0-9]{1,4}(?:\s*[-－]\s*[0-9]{1,4})?|[A-Za-z]{1,3}\s*[-－]\s*[0-9]{1,4})$/;

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function linesText(lines) {
        if (!(lines instanceof Array)) return '';
        var parts = [];
        for (var i = 0; i < lines.length; i++) parts.push(text(lines[i]));
        return text(parts.join(' '));
    }

    // 课名、学期名、原文过长时截短，避免一个超长字符串就把整条提醒撑破上限（载荷校验超了整包拒收）
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

    // 点名：最多 3 个，各自截短，用顿号连起来
    function sampleText(list) {
        var shown = [];
        for (var i = 0; i < list.length && i < 3; i++) shown.push(shortName(list[i]));
        return shown.join('、');
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
        var mm = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
    }

    function fullWidthToHalf(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/：/g, ':')
            .replace(/[，、；;]/g, ',')
            .replace(/[～~—－–至]/g, '-');
    }

    // ---------- warnings（载荷上限 20 条 × 200 字，超了整包会被拒，所以由这里统一收口） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        // 单条超长直接截断（超长会让整包被拒收，截断至少还能让用户看到前半句）
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。本校的周次写法与模板（浙江树人学院，正方 WebForms）同族，
    // 这里沿用批次十 swu 起的写法，同时认：
    //   "1-16周" / "1-16周(单)" / "(单)1-8周,(双)9-16周" / "1-3,5-9周" / "17周" / "第1-第8周" / 全角数字与标点
    // 必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单 / 双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //      没有逗号的前置写法「(单)1-8周(双)9-16周」里，第二个标记属于下一段，不能并给上一段；
    //   ③ 「第3-4节」「(2-3节)」是节次不是周次，整段摘掉；括号里不是周次写法的（"(3学分)"）整组摘掉并计数；
    //   ④ 括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉；
    //   ⑤ 空白两头都要顾：破折号连同两侧的空白先归一成半角 '-'，剩下的空白当分段符折成逗号。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单 / 双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3学分)」，含非周次的字，不是周次）
    var noteSample = '';     // 第一个备注括号的原文，写进提醒
    var bothMarks = 0;       // 同时写了「单」和「双」的段数（按每周都上处理，要说出来）

    // 节次不是周次：连括号一起整段摘掉，不能遇到「节」就截断（后面还有真实周次段）。
    // 括号里只写了节次时（"(第1-2节)"）会剩下一个空括号，也一并摘掉 ——
    // 空括号留着会让后面判断「本段是不是以前置单双标记开头」时看走眼，把下一个标记并给上一段
    function stripSections(value) {
        var line = String(value);
        line = line.replace(/[（(]\s*第\s*[0-9]+(?:\s*[,，、\-~至]\s*[0-9]+)*\s*节\s*[）)]/g, ' ');
        // 课名正好截在左括号前时（"课名(第1-2节)(单)1-8周"），前括号不在这一段里，连后括号一起摘掉
        line = line.replace(/第?\s*[0-9]+(?:\s*[,，、\-~至]\s*[0-9]+)*\s*节\s*[）)]/g, ' ');
        line = line.replace(/第?\s*[0-9]+(?:\s*[,，、\-~至]\s*[0-9]+)*\s*节/g, ' ');
        line = line.replace(/\(\s*\)/g, ' ');
        return line;
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'。不要在这里删掉全部空白
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 「共8周」是课程总周数备注，不是上课周次，只剥备注本身；放在全角转半角之后，全角数字也一起剥掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        cleaned = stripSections(cleaned);
        // 紧挨周次的单 / 双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上；
        //   这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"，标记就跟着自己那一段走。
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 夹在两段中间的标记：本段以前置标记开头时它是下一段的前缀，补逗号隔开；
            // 否则仍是上一段的后缀
            if (/^\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
            return all;
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空，那才是真丢数据）；这是个判断不是事实，所以计数后写进提醒
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:[ ]*-[ ]*[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                if (end > 99) end = 99;   // 防止 "1-99999999" 这类脏数据空转
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

    // 只在文字里真的出现周次写法时才解析：「1-101」这类教室编号、学分数字不许被当成周次。
    // 自定义上课时间「(08:10-08:55)」先摘掉，不然它的括号会被当成周次里的备注
    function weekTextOf(value) {
        var line = text(value);
        if (line.indexOf('周') < 0 && line.indexOf('单') < 0 && line.indexOf('双') < 0) return [];
        line = line.replace(new RegExp(CUSTOM_TIME_RE.source, 'g'), ' ');
        return weeksOf(line);
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

    // ---------- 节次时间（先从课表页读，读不到回落上游写死的 11 节表） ----------
    // 节次文字 → 节次号列表。「第1-4节」是连续四节、「第1,3节」是两节（后面按不相邻处理）
    function sectionNumbers(value) {
        var m = SECTION_NUM_RE.exec(text(value));
        if (!m) return [];
        var groups = m[1].split(/[,，、]/);
        var numbers = [];
        for (var i = 0; i < groups.length; i++) {
            var bounds = text(groups[i]).split(/[-~至]/);
            var from = parseInt(bounds[0], 10);
            var to = bounds.length > 1 ? parseInt(bounds[1], 10) : from;
            if (isNaN(from) || isNaN(to)) continue;
            if (to < from) { var swap = from; from = to; to = swap; }
            if (to > MAX_PERIOD) to = MAX_PERIOD;
            for (var n = from; n <= to; n++) {
                if (n >= 1 && numbers.indexOf(n) < 0) numbers.push(n);
            }
        }
        numbers.sort(function (a, b) { return a - b; });
        return numbers;
    }

    function timeRangeOf(value) {
        var m = CUSTOM_TIME_RE.exec(text(value));
        if (!m) return null;
        var start = m[1];
        var end = m[2];
        if (start.length === 4) start = '0' + start;
        if (end.length === 4) end = '0' + end;
        if (minutesOf(start) >= minutesOf(end)) return null;
        return { start: start, end: end };
    }

    // 课表页上真正给了时间的节次单独留一份：提醒里说的是这一批，后面补齐的不许混进去
    var pageSlots = [];
    var slotSeen = {};
    for (var ri = 0; ri < rows.length; ri++) {
        var label = linesText(rows[ri].section);
        var labelNumbers = sectionNumbers(label);
        var labelTime = timeRangeOf(label);
        // 与上游同口径：一行的节次格只给一个节次号时才算一节的时间；给了多个节次号的行不当节次表用
        if (labelNumbers.length === 1 && labelTime && !slotSeen['p' + labelNumbers[0]]) {
            slotSeen['p' + labelNumbers[0]] = true;
            pageSlots.push({ periodIndex: labelNumbers[0], start: labelTime.start, end: labelTime.end });
        }
    }
    pageSlots.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
    var periodFromPage = pageSlots.length > 0;
    var periodTimes = [];
    var si;
    if (periodFromPage) {
        for (si = 0; si < pageSlots.length; si++) {
            periodTimes.push({ periodIndex: pageSlots[si].periodIndex, start: pageSlots[si].start, end: pageSlots[si].end });
        }
    } else {
        for (si = 0; si < SCHOOL_PERIOD_TIMES.length; si++) {
            periodTimes.push({
                periodIndex: SCHOOL_PERIOD_TIMES[si].periodIndex,
                start: SCHOOL_PERIOD_TIMES[si].start,
                end: SCHOOL_PERIOD_TIMES[si].end
            });
        }
    }
    var publishedCount = periodFromPage ? pageSlots.length : periodTimes.length;

    function tableHasPeriod(index) {
        for (var i = 0; i < periodTimes.length; i++) {
            if (periodTimes[i].periodIndex === index) return true;
        }
        return false;
    }

    // 没有节次、只有上课时间的课按最接近的一节放入；页面没给时间的节次后面会用学校公布的时间补上，这里也比一遍
    function nearestPeriod(hhmm) {
        var target = minutesOf(hhmm);
        var best = 0;
        var bestDiff = NEAREST_PERIOD_MINUTES + 1;
        var i;
        for (i = 0; i < periodTimes.length; i++) {
            var diff = Math.abs(minutesOf(periodTimes[i].start) - target);
            if (diff < bestDiff) { bestDiff = diff; best = periodTimes[i].periodIndex; }
        }
        for (i = 0; i < SCHOOL_PERIOD_TIMES.length; i++) {
            if (tableHasPeriod(SCHOOL_PERIOD_TIMES[i].periodIndex)) continue;
            var gapDiff = Math.abs(minutesOf(SCHOOL_PERIOD_TIMES[i].start) - target);
            if (gapDiff < bestDiff) { bestDiff = gapDiff; best = SCHOOL_PERIOD_TIMES[i].periodIndex; }
        }
        return best;
    }

    // ---------- 课程格子 → 课程 / 上课安排 ----------
    var entries = [];
    var missing = { name: 0, period: 0, week: 0 };
    var skippedSamples = [];
    var sparseRows = 0;
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    var customTimeRows = 0;    // 写了自定义上课时间、但也有节次的行数（按节次导入）
    var pickedByTime = {};     // 没有节次、只有上课时间，按最接近的一节放进去的课程（按课名去重）
    var skippedByTime = {};    // 没有节次、只有上课时间，又对不上任何节次的课程（按课名去重）

    // 教师 / 教室写成占位词的一律当没给（手册 §4.7：写「未知」会被课表当成真名显示）
    function placeholder(value) {
        return /^(未知|待定|暂无|无)(上课)?(教师|老师|教室|地点)?$/.test(value);
    }

    function addSample(value) {
        var sample = text(value);
        if (!sample || skippedSamples.length >= 3 || skippedSamples.indexOf(sample) >= 0) return;
        skippedSamples.push(sample);
    }

    function firstIndex(re, value) {
        var m = re.exec(value);
        return m ? m.index : -1;
    }

    // 一个课程块（extract.js 按 <hr> 切好、<br> 分好行的文字）→ 一条上课安排
    function parseCourse(lines, day, fallbackStart, fallbackEnd) {
        if (!(lines instanceof Array) || !lines.length) return;
        var firstLine = text(lines[0]);
        if (!firstLine) return;

        var weekIndex = firstIndex(WEEK_START_RE, firstLine);
        var sectionIndex = firstIndex(SECTION_NUM_RE, firstLine);
        var timeIndex = firstIndex(CUSTOM_TIME_RE, firstLine);
        var nameEnd = firstLine.length;
        if (weekIndex >= 0 && weekIndex < nameEnd) nameEnd = weekIndex;
        if (sectionIndex >= 0 && sectionIndex < nameEnd) nameEnd = sectionIndex;
        if (timeIndex >= 0 && timeIndex < nameEnd) nameEnd = timeIndex;

        var name = text(firstLine.substring(0, nameEnd));
        name = name.replace(/\[\s*[0-9]+\s*\]\s*$/, '');    // 末尾的 [01] 是教学班序号
        name = name.replace(/[（(【\[「\s]+$/, '');          // 截在括号前时留下的左括号
        name = text(name);
        if (!name) { missing.name++; addSample(firstLine); return; }

        // 周次：课名之后的整段文字（节次先摘掉），认不出再往后几行找；认不出来就计数跳过
        var tail = firstLine.substring(nameEnd);
        tail = stripSections(tail);
        tail = tail.replace(new RegExp(CUSTOM_TIME_RE.source, 'g'), ' ');
        var weeks = weekTextOf(tail);
        var weekLine = -1;
        if (!weeks.length) {
            for (var li = 1; li < lines.length; li++) {
                var probe = weekTextOf(lines[li]);
                if (probe.length) { weeks = probe; weekLine = li; break; }
            }
        }
        if (!weeks.length) { missing.week++; addSample(firstLine); return; }

        // 节次：课程块里写的（可能在课名同一行，也可能在下一行的周次前面）→ 所在行的 → 自定义上课时间最接近的一节
        var detail = linesText(lines);
        var sections = sectionNumbers(detail);
        var customTime = timeRangeOf(detail);
        var start;
        var end;
        if (sections.length) {
            start = sections[0];
            end = sections[sections.length - 1];
            if (customTime) customTimeRows++;
            if (sections.length > 1 && end - start + 1 !== sections.length) sparseRows++;
        } else if (fallbackStart > 0) {
            start = fallbackStart;
            end = fallbackEnd;
        } else if (customTime) {
            var nearest = nearestPeriod(customTime.start);
            if (!nearest) { skippedByTime['n' + name] = true; addSample(firstLine); return; }
            start = nearest;
            end = nearest;
            pickedByTime['n' + name] = true;
        } else {
            missing.period++;
            addSample(firstLine);
            return;
        }
        if (start < 1 || end > MAX_PERIOD || end < start) { missing.period++; addSample(firstLine); return; }

        // 教师 / 地点：带「楼馆场室厅」的那行是地点（没有时按第二行）；剩下第一行是教师
        var rest = [];
        for (var rj = 0; rj < lines.length; rj++) {
            if (rj === 0 || rj === weekLine) continue;
            rest.push(text(lines[rj]));
        }
        var location = '';
        var locationIndex = -1;
        var lj;
        for (lj = 0; lj < rest.length; lj++) {
            if (/[楼馆场室厅]/.test(rest[lj])) { location = rest[lj]; locationIndex = lj; break; }
        }
        // 没有「楼馆场室厅」时看有没有像教室编号的（A305 / 1-101 / C-203）：编号是地点，不是人名
        if (locationIndex < 0) {
            for (lj = 0; lj < rest.length; lj++) {
                if (ROOM_CODE_RE.test(rest[lj])) { location = rest[lj]; locationIndex = lj; break; }
            }
        }
        if (locationIndex < 0 && rest.length >= 2) { location = rest[1]; locationIndex = 1; }
        var teacher = '';
        for (var lk = 0; lk < rest.length; lk++) {
            if (lk === locationIndex) continue;
            teacher = rest[lk];
            break;
        }
        if (placeholder(teacher)) teacher = '';
        if (placeholder(location)) location = '';

        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
            fieldSamples.push(name);
        }

        entries.push({
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            start: start,
            end: end,
            weeks: weeks
        });
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var days = row.days instanceof Array ? row.days : [];
        var rowNumbers = sectionNumbers(linesText(row.section));
        var fallbackStart = rowNumbers.length ? rowNumbers[0] : 0;
        var fallbackEnd = rowNumbers.length ? rowNumbers[rowNumbers.length - 1] : 0;
        for (var day = 0; day < days.length; day++) {
            var blocks = days[day] instanceof Array ? days[day] : [];
            for (var b = 0; b < blocks.length; b++) {
                parseCourse(blocks[b], day + 1, fallbackStart, fallbackEnd);
            }
        }
    }

    // 完全相同的行只留第一条：同一上课安排重复出现，去掉不算丢课
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
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end) ||
            cmpText(a.weeks.join(','), b.weeks.join(','));
    }

    // 同名、同教师、同地点、同星期、同周次的相邻节次合并成一段（首尾相接或重叠）。
    // 分组键含周次，单周行与双周行不会被并成每周都上；分组的先后取第一次出现的顺序
    var groupOrder = [];
    var groups = {};
    entries = dropExactDuplicates(entries);
    for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        var groupKey = 'g' + entry.name + '|' + entry.teacher + '|' + entry.location + '|' + entry.day + '|' + entry.weeks.join(',');
        if (!groups[groupKey]) {
            groups[groupKey] = [];
            groupOrder.push(groupKey);
        }
        groups[groupKey].push(entry);
    }
    var merged = [];
    for (var gi = 0; gi < groupOrder.length; gi++) {
        var list = groups[groupOrder[gi]];
        list.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
        var current = null;
        for (var li2 = 0; li2 < list.length; li2++) {
            var next = list[li2];
            if (current && next.start <= current.end + 1) {
                if (next.end > current.end) current.end = next.end;
                continue;
            }
            current = {
                name: next.name,
                teacher: next.teacher,
                location: next.location,
                day: next.day,
                start: next.start,
                end: next.end,
                weeks: next.weeks
            };
            merged.push(current);
        }
    }
    merged.sort(orderEntries);

    if (!merged.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开「学生个人课表」页面确认能看到课表后再试'
        );
    }

    // 课程按「名称 + 教师」归档（顺序取合并后的第一条）
    var courses = [];
    var byName = {};
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

    // 合并后的每条 entry 按周次拆成 block（步长 2 → 单 / 双周，见 runsOf）
    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        var course = courseOf(item.name, item.teacher || null);
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            if (run.end > maxWeek) maxWeek = run.end;
            if (item.end > maxPeriod) maxPeriod = item.end;
            course.blocks.push({
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

    // ---------- 学期名 / 开学日 / 总周数（教务都没给，按今天的日期推算并提醒） ----------
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var todayYear = parseInt(todayIso.substring(0, 4), 10);
    var todayMonth = parseInt(todayIso.substring(5, 7), 10);
    // 8 月到次年 1 月是第一学期（学年从 8 月所在年算起），2 到 7 月是上一学年的第二学期
    var effKind = (todayMonth >= 8 || todayMonth <= 1) ? 1 : 2;
    var effYear = effKind === 1 ? (todayMonth >= 8 ? todayYear : todayYear - 1) : todayYear - 1;
    var termName = SCHOOL_NAME + ' ' + effYear + '-' + (effYear + 1) + '学年第' + KIND_CN[effKind] + '学期';

    var startIso;
    var startRule;
    if (effKind === 2) {
        startIso = mondayOf(isoOf(new Date(Date.UTC(effYear + 1, 2, 2))));
        startRule = '第二学期 = 3 月 2 日所在周的周一';
    } else {
        startIso = mondayOf(isoOf(new Date(Date.UTC(effYear, 8, 1))));
        startRule = '第一学期 = 9 月 1 日所在周的周一';
    }

    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    // ---------- 节次补齐：课表里用到的每一节都要有时间 ----------
    // 从第 1 节到「课表用到的最大节次」和「课表页给了时间的最大节次」里更靠后的那一节，
    // 凡是还没有时间的节都逐节补：先用学校公布的 11 节表（它的开始不早于上一节下课才用，避免重叠倒挂），
    // 学校表里没有、或者接不上，才从上一节下课后顺推（课间 5 分钟、每节 45 分钟）。
    // 应用对没有时间的节次会套通用默认时间，和本校作息不一样，学生看到的就是错时间，所以必须补齐。
    var fromSchool = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    var tableLast = 0;
    var ti;
    for (ti = 0; ti < periodTimes.length; ti++) {
        if (periodTimes[ti].periodIndex > tableLast) tableLast = periodTimes[ti].periodIndex;
    }
    var ceiling = maxPeriod > tableLast ? maxPeriod : tableLast;
    var prevEnd = -1;
    for (var p = 1; p <= ceiling; p++) {
        if (tableHasPeriod(p)) {
            for (ti = 0; ti < periodTimes.length; ti++) {
                if (periodTimes[ti].periodIndex === p) { prevEnd = minutesOf(periodTimes[ti].end); break; }
            }
            continue;
        }
        var schoolSlot = SCHOOL_PERIOD_TIMES[p - 1];
        if (schoolSlot && minutesOf(schoolSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: schoolSlot.start, end: schoolSlot.end });
            fromSchool.push(p);
            prevEnd = minutesOf(schoolSlot.end);
            continue;
        }
        if (prevEnd < 0) { uncoveredFrom = p; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
        prevEnd = nextEnd;
    }
    periodTimes.sort(function (a, b) { return a.periodIndex - b.periodIndex; });

    // 节次号（已升序）写成「第 9~12 节」「第 9 节」「第 9、11~12 节」这几种
    function sectionsText(list) {
        var spans = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            spans.push(list[i] === list[j] ? String(list[i]) : list[i] + '~' + list[j]);
            i = j + 1;
        }
        return '第 ' + spans.join('、') + ' 节';
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    warn(
        '没有从教务系统读到当前学期，已按今天的日期推算为 ' + termName +
        '。如果这不是你要导入的学期，请先在教务系统里切到正确的学期，再点「提取课表」；学期名也可以在学期管理里改'
    );

    warn(
        '教务系统没有给出开学日期，第 1 周按「' + startRule + '」推算为 ' + startIso +
        '，请在学期管理里核对成学校实际开学日'
    );

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

    var firstSlot = periodFromPage ? pageSlots[0] : periodTimes[0];
    if (periodFromPage) {
        warn(
            '已按课表页上显示的节次时间导入（第 ' + firstSlot.periodIndex + ' 节 ' + firstSlot.start + '~' +
            firstSlot.end + '，共 ' + publishedCount + ' 节），请与实际上课时间核对，不一致可在学期管理里改'
        );
    } else {
        warn(
            '课表页上没有显示节次时间，已按学校公布的节次时间导入（第 ' + firstSlot.periodIndex + ' 节 ' +
            firstSlot.start + '~' + firstSlot.end + '，共 ' + publishedCount + ' 节），请与实际上课时间核对，不一致可在学期管理里改'
        );
    }

    if (fromSchool.length) {
        var fromSchoolSorted = fromSchool.slice().sort(function (a, b) { return a - b; });
        warn(
            '另有 ' + fromSchool.length + ' 节的节次时间用了学校公布的时间（' + sectionsText(fromSchoolSorted) +
            '），不一致可在学期管理里改'
        );
    }
    if (bySequence.length) {
        warn(
            '课表用到了' + sectionsText(bySequence) + '，节次时间表里没有这些节次，已按上一节下课后课间 5 分钟、每节 45 分钟顺推，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    var skipped = missing.name + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.period) reasons.push('缺节次（或节次不合理）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1~' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (skippedSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < skippedSamples.length; ws++) sampleTexts.push(shortName(skippedSamples[ws]));
            reasons.push('认不出的行如「' + sampleTexts.join('」「') + '」');
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

    if (sparseRows > 0) {
        warn(
            '有 ' + sparseRows + ' 行把不相邻的几节写在同一格里（如「第 1、3 节」），已按首末两节之间的范围（第 1~3 节）导入，请核对上课时间'
        );
    }

    if (customTimeRows > 0) {
        warn('有 ' + customTimeRows + ' 行还写了与节次时间对不上的上课时间，已按节次导入，请核对上课时间');
    }
    var pickedCount = countKeys(pickedByTime);
    var skippedTimeCount = countKeys(skippedByTime);
    if (pickedCount > 0) {
        warn('有 ' + pickedCount + ' 门课没有写节次、只写了上课时间，已按最接近的一节放入，请核对上课时间');
    }
    if (skippedTimeCount > 0) {
        warn('有 ' + skippedTimeCount + ' 门课只写了上课时间、对不上任何节次，已跳过，请在「编辑课程」里自己添加');
    }

    // 未安排时间的课程：教务给不出星期与节次，我们的课表放不下，点名说出来，不许静默吞掉
    var unscheduledNames = [];
    for (var u = 0; u < unscheduled.length; u++) {
        var item2 = unscheduled[u] instanceof Array ? unscheduled[u] : [];
        var unscheduledName = text(linesText(item2[0]));
        if (unscheduledName) unscheduledNames.push(unscheduledName);
    }
    if (unscheduledNames.length) {
        warn(
            '教务系统里有 ' + unscheduledNames.length + ' 门课还没排上课时间（例如 ' + sampleText(unscheduledNames) +
            '），课表里放不下，请在「编辑课程」里自己添加'
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
        warn('有 ' + droppedWeeks + ' 个周次超出 1~' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    }
    if (orphanMarkers > 0) {
        warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次（教务数据写得不完整），这些标记已忽略');
    }
    if (bothMarks > 0) {
        warn(
            '有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对'
        );
    }
    if (data.truncated) {
        warn('页面上的内容太多，课表只读取了一部分，请核对是否少了课');
    }

    // 兜底：真到了上限就说清楚（正常路径下这些计数永远是 0）
    if (droppedWarnings > 0) {
        warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';
    }

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
                name: termName,
                firstDay: startIso,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
