(function () {
    // 黑龙江大学本科选课系统适配器（xsxk.hlju.edu.cn，JSON 接口）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 HLJU/hlju_bachelor.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03 对齐 origin/main），本校脚本最后一次修改 80e30cf
    //
    // 上游在同一段脚本里取数、解析、存库；这里只做纯转换（CI 用 Rhino 实跑：没有 DOM、没有 fetch），
    // 取数全在 extract.js。输入是 { term, today, kbList }，kbList 每行只带 SKSJ / KEY / KSJC / JSJC 四个字段。
    //
    // 移植改动（逐条对应 AUDIT.md §4）：
    //   ① 课名去掉教学班序号「【001】」：上游把第一行整行当课名，同一门课分班就会变成好几门课。
    //   ② 教师 / 地点的占位写法（未知、待定、暂无……）交 null，不当真名写进课表（公共说明 8）。
    //   ③ 周次文字沿用模板 hueb 的解析（单双标记归属、「共 N 周」只剥备注、括号里的教学班序号、「第1-8周」等）。
    //      上游的周次正则只认「1-16周」「1,4-8双」，「(单)1-8周」这类写法会整段丢掉或退化成每周都上。
    //   ④ 第二行不一定是教师行：上游从第 3 行起才找周次与地点，第 2 行若是周次行就整行跳过；这里从第 2 行起都读。
    //   ⑤ 节次用 KSJC / JSJC 两个数字（同上游）；SKSJ 里的「第X-Y节」文字行可缺，这里不读它。
    //   ⑥ 周次以 SKSJ 里的文字为准（同上游）。ZC 位图上游代码不读，这里也不读（见 AUDIT §5）。
    //   ⑦ 节次时间用上游写死的 12 节表（上游注释提到的 queryxqkjsj 接口，代码里并没有调用，这里也不调用）；
    //      课表用到更晚的节次，从上一节下课后顺推（课间 5 分钟、每节 45 分钟）并提醒（统一修订 H3）。
    //   ⑧ 开学日：上游没有校历，也没有开学日。这里按学期序号推算（一学期取 9 月 1 日所在周的周一，二学期取 2 月 20 日所在周的周一，
    //      三学期取 7 月 1 日所在周的周一），并在提醒里说明；总周数先用 20 周，课表排到更晚的周次才抬高。
    //   ⑨ 学期名用接口给的学年（XN）与学期序号（XQ）：「2026-2027学年第一学期」；拿不到就「学校名 + 原文」，不用适配器名。
    //   ⑩ 同课合并：按「课名 + 教师 + 地点 + 星期 + 起止节次」归并，周次取并集（同上游 mergeCourses）。
    //      上游只合并节次完全相同的行，连堂（1-2 与 3-4）保持两段，这里也不合并。
    //   ⑪ 上游的导入流程（开场弹窗、提示条、saveImportedCourses、savePresetTimeSlots、通知完成）全部不移植：
    //      空课由宿主保存，适配器只交载荷。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.kbList) ? data.kbList : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '黑龙江大学';   // 学期名兜底时用（拿不到学年时「学校名 + 原文」，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 上游没有校历、也不给总周数，照上游 20 周
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的教务原文（课名、周次原文、学期名等）最多留的字数
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间不够时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间不够时顺推：每节几分钟

    // 上游 HLJU_BACHELOR_TIME_SLOTS（12 节，2026-2027 第一学期）：逐节照抄
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:50', end: '09:35' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:50', end: '11:35' },
        { periodIndex: 5, start: '13:30', end: '14:15' },
        { periodIndex: 6, start: '14:20', end: '15:05' },
        { periodIndex: 7, start: '15:30', end: '16:15' },
        { periodIndex: 8, start: '16:20', end: '17:05' },
        { periodIndex: 9, start: '18:30', end: '19:15' },
        { periodIndex: 10, start: '19:20', end: '20:05' },
        { periodIndex: 11, start: '20:10', end: '20:55' },
        { periodIndex: 12, start: '21:00', end: '21:45' }
    ];

    var XQ_CN = { '1': '一', '2': '二', '3': '三' };
    // 推算开学日的锚点（接口没有开学日）。规则写给学生看，所以用大白话
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '9 月初（9 月 1 日所在那周的周一）' },
        second: { month: 2, day: 20, rule: '2 月下旬（2 月 20 日所在那周的周一）' },
        third: { month: 7, day: 1, rule: '7 月初（7 月 1 日所在那周的周一）' }
    };
    // 教师 / 地点写成这些占位词时交 null（公共说明 8）
    var BLANK_WORDS = { '未知': true, '待定': true, '暂无': true, '暂无教师': true, '暂无教室': true };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 教务原文拼进提醒前截到 20 字（超出以「…」结尾），保证每条提醒都不超 200 字
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    // 教师 / 地点：空或占位词一律 null，不许当真名写进课表
    function realOrNull(value) {
        var t = text(value);
        return !t || BLANK_WORDS.hasOwnProperty(t) ? null : t;
    }

    // 字典里有多少个键（用对象当字典，ES5 下不引入 Set / Map）
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

    function mondayIso(iso) {
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

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    // ---------- warnings（载荷上限 20 条 × 200 字，超了整包会被拒，所以由这里统一收口） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        // 单条超长直接截断（超了整包拒收；截断至少还能让用户看到前半句）
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 学期名 / 学期序号 / 开学日推算 ----------
    // XQ：1 = 第一学期，2 = 第二学期，3 = 第三学期（夏季）；接口里的 XQ 就是这个序号（上游 xq 参数同值）
    function termKind() {
        var code = text(term.xq);
        if (code === '2') return 'second';
        if (code === '3') return 'third';
        return 'first';
    }

    // XN 形如「2026-2027」，取前一个年份
    function termYear() {
        var m = /^([0-9]{4})-[0-9]{4}$/.exec(text(term.xn));
        return m ? parseInt(m[1], 10) : 0;
    }

    function termName() {
        var year = text(term.xn);
        var code = text(term.xq);
        if (termYear() && XQ_CN[code]) return year + '学年第' + XQ_CN[code] + '学期';
        return text(SCHOOL_NAME + ' ' + year + ' ' + code);
    }

    // 接口没有开学日：按学期序号推算，结果一律写进 warnings（不猜、不静默）
    function estimateStart(todayIso) {
        var kind = termKind();
        var year = termYear();
        if (!year) return { iso: mondayIso(todayIso), rule: '今天所在周的周一' };
        var anchor = KIND_ANCHOR[kind];
        // 二、三学期在次年（2026-2027 的第二学期是 2027 年 2 月）
        return { iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), anchor.month, anchor.day)), rule: anchor.rule };
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。常见的写法：
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
        // 「第1-第8周」「第1-8周」里的「第」只是量词：先删掉，否则「1-第8」连不成区间，两端各读成一周（批次十 swu 的坑）
        cleaned = cleaned.replace(/第/g, '');
        // 同批统一修正（模板缺陷）：紧挨周次的单/双括号按相邻关系先归属，再交给下面的通用括号处理 ——
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
    // 上游只用 KSJC / JSJC 两个数字；起止节次要在 1..MAX_PERIOD 之间，且起不晚于止
    function sectionsOfRow(row) {
        var start = intOf(row.KSJC);
        var end = intOf(row.JSJC);
        if (!start || !end || start < 1 || start > end || end > MAX_PERIOD) return null;
        return { start: start, end: end };
    }

    // 节次号（已升序）写成「第 9-12 节」「第 9 节」「第 9、11-12 节」这几种
    function sectionsText(list) {
        var runs = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            runs.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + runs.join('、') + ' 节';
    }

    // ---------- 课程文本 ----------
    // 上游格式：课程名【001】\n[教师]\n[周次][地点]\n第X-Y节（节次行可能缺失，这里不读它）
    // 一个 SKSJ 里可以有好几段「[周次][地点]」（每段是一个上课安排），这里每段返回一个 segment
    function parseCourseText(source) {
        var lines = [];
        var raw = String(source === null || source === undefined ? '' : source).split(String.fromCharCode(10));
        for (var i = 0; i < raw.length; i++) {
            var line = text(raw[i]);
            if (line) lines.push(line);
        }
        if (!lines.length) return { exam: false, name: '', teacher: null, segments: [] };
        // 考试记录（【……考试】开头）不是上课安排，跳过（上游同样跳过）
        if (lines[0].indexOf('考试】') !== -1) return { exam: true };

        // 课名去掉行尾的教学班序号「【001】」
        var name = text(lines[0].replace(/【[^【】]*】\s*$/, ''));

        // 教师行：第 2 行是「[…]」、方括号里没有数字、且不是纯标记（单 / 双 / 单周 / 双周）才算教师。
        // 不能用「含不含周字」判断：「周」是常见姓氏（[周九]），「单」「双」也是（[单某]）
        var teacher = null;
        var teacherLine = lines.length > 1 && /^\[[^\]0-9]+\]$/.test(lines[1]) && !/^\[(单|双|单周|双周)\]$/.test(lines[1]);
        if (teacherLine) teacher = realOrNull(lines[1].slice(1, -1));

        // 周次与地点：含「周」的 [..] 开一段周次，同一行紧跟的 [..] 是这段的地点（地点可能嵌套方括号，整段取出）；
        // 之后单独一行的 [..] 补给当前段的地点；纯标记行（[单] 之类）并入当前段的周次
        var segments = [];
        var current = null;
        for (var k = teacherLine ? 2 : 1; k < lines.length; k++) {
            var item = lines[k];
            var m = /\[([^\]]*周[^\]]*)\]/.exec(item);
            if (m) {
                current = { weekText: m[1], position: null };
                segments.push(current);
                var rest = item.slice(item.indexOf(m[0]) + m[0].length).trim();
                var inside = /^\[(.*)\]$/.exec(rest);
                if (inside) current.position = realOrNull(inside[1]);
                continue;
            }
            var marker = /^\[(单|双|单周|双周)\]$/.exec(item);
            if (marker) {
                if (!current) { current = { weekText: '', position: null }; segments.push(current); }
                current.weekText += marker[1];
                continue;
            }
            var bare = /^\[(.+)\]$/.exec(item);
            if (bare) {
                if (!current) { current = { weekText: '', position: null }; segments.push(current); }
                if (!current.position) current.position = realOrNull(bare[1]);
            }
        }
        return { exam: false, name: name, teacher: teacher, segments: segments };
    }

    // 两个周次集合取并集（升序、去重）
    function unionWeeks(a, b) {
        var all = a.concat(b);
        var seen = {};
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (seen[all[i]]) continue;
            seen[all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    // ---------- 逐行转换 ----------
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var noPosition = 0;            // KEY 为 bz：劳动教育等没有星期与节次的记录
    var exams = 0;                 // 考试记录条数（不导入）
    var weekSamples = [];          // 认不出的周次原文，最多留 3 个
    var missingTeacherCourses = {};  // 没有教师的课名（按课名去重，提醒里说「N 门课」才准）
    var missingLocationCourses = {}; // 没有地点的课名
    var fieldSamples = [];         // 缺教师或缺地点的课名，最多 3 个，提醒里点名
    var slots = {};                // 同课同时间的一条记录，周次在这里取并集
    var slotList = [];
    var maxWeek = 0;
    var maxPeriod = 0;

    var seenRows = {};             // 同一行（SKSJ、星期、节次全同）只处理一次：重复行不重复计数、不重复提醒
    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var rowKey = JSON.stringify([text(row.SKSJ), text(row.KEY), text(row.KSJC), text(row.JSJC)]);
        if (seenRows[rowKey]) continue;
        seenRows[rowKey] = true;

        var parsed = parseCourseText(row.SKSJ);
        if (parsed.exam) { exams++; continue; }
        var key = text(row.KEY);
        if (key === 'bz') { noPosition++; continue; }

        if (!parsed.name) { missing.name++; continue; }

        var dayMatch = /xq([0-9]+)/.exec(key);
        var day = dayMatch ? parseInt(dayMatch[1], 10) : 0;
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOfRow(row);
        if (!sections) { missing.period++; continue; }

        // 没有任何周次行的，当成一段空周次（照常计数为缺周次）
        if (!parsed.segments.length) parsed.segments.push({ weekText: '', position: null });
        for (var g = 0; g < parsed.segments.length; g++) {
            var seg = parsed.segments[g];
            var weeks = weeksOf(seg.weekText);
            if (!weeks.length) {
                missing.week++;
                var sample = text(seg.weekText);
                if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
                continue;
            }

            var teacherName = parsed.teacher;
            var place = seg.position;
            if (!teacherName) missingTeacherCourses['n' + parsed.name] = true;
            if (!place) missingLocationCourses['n' + parsed.name] = true;
            if ((!teacherName || !place) && fieldSamples.length < 3 && fieldSamples.indexOf(parsed.name) < 0) {
                fieldSamples.push(parsed.name);
            }

            var slotKey = JSON.stringify([parsed.name, teacherName || '', place || '', day, sections.start, sections.end]);
            var slot = slots[slotKey];
            if (!slot) {
                slot = { name: parsed.name, teacher: teacherName, location: place, day: day,
                    start: sections.start, end: sections.end, weeks: [] };
                slots[slotKey] = slot;
                slotList.push(slot);
            }
            slot.weeks = unionWeeks(slot.weeks, weeks);
        }
    }

    // 按「课名 + 教师」归档成课程，块按上课时间顺序放进去；周次集合按 runsOf 拆成 ALL / ODD / EVEN 段
    var courseByKey = {};
    var payloadCourses = [];
    for (var s = 0; s < slotList.length; s++) {
        var item2 = slotList[s];
        var courseKey = JSON.stringify([item2.name, item2.teacher || '']);
        var course = courseByKey[courseKey];
        if (!course) {
            course = { name: item2.name, teacher: item2.teacher, note: null, blocks: [] };
            courseByKey[courseKey] = course;
            payloadCourses.push(course);
        }
        var runs = runsOf(item2.weeks);
        for (var k2 = 0; k2 < runs.length; k2++) {
            var run = runs[k2];
            if (run.end > maxWeek) maxWeek = run.end;
            course.blocks.push({
                dayOfWeek: item2.day,
                startPeriod: item2.start,
                endPeriod: item2.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item2.location
            });
        }
        if (item2.end > maxPeriod) maxPeriod = item2.end;
    }

    if (!payloadCourses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录后打开课表查询页，确认能看到课表再试'
        );
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var todayIso = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text(data.today)) ? text(data.today) : localTodayIso();
    var start = estimateStart(todayIso);
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    // ---------- 节次时间：写死的 12 节表；课表用到更晚的节次，从上一节下课后顺推，顺推不过当天 23:59 ----------
    var periodTimes = SCHOOL_PERIOD_TIMES.slice(0);
    var sequential = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        sequential.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    warn('只导入了教务系统标记为当前的学期（' + shortName(name0) +
        '）；要导入别的学期，请等教务系统切到那个学期后再点「提取课表」');

    warn('教务系统没有给出开学日期，第 1 周按「' + start.rule + '」推算为 ' + start.iso +
        '，请在学期管理里核对成学校实际开学日');

    if (raisedBySchedule) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
    } else {
        warn('教务系统没有给出学期校历，学期总周数按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    }

    warn('已按学校 2026-2027 学年第一学期的节次时间导入（第 1 节 08:00-08:45，第 12 节 21:00-21:45），' +
        '其他学期或学校调整后可能不同，请在学期管理里核对');

    if (sequential.length) {
        warn('课表用到了' + sectionsText(sequential) + '，学校节次时间没有覆盖，已按上一节下课后课间 5 分钟、' +
            '每节 45 分钟顺推补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间' +
            '（课程已导入），请在学期管理里补上');
    }

    if (exams > 0) {
        warn('有 ' + exams + ' 条考试安排没有导入，这里只导入平时上课的课表');
    }
    if (noPosition > 0) {
        warn('有 ' + noPosition + ' 条没有星期和节次的记录（如劳动教育）没有导入，它们不排进周课表');
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 条');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 条');
        if (missing.period) reasons.push('缺节次（或节次超出 1-' + MAX_PERIOD + ' 节）' + missing.period + ' 条');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 条');
        warn('有 ' + skipped + ' 条课表安排数据不全（' + reasons.join('、') + '），已跳过：教务数据不完整时会出现，如发现少课请反馈');
    }
    if (weekSamples.length) {
        var sampleTexts = [];
        for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push('「' + shortName(weekSamples[ws]) + '」');
        warn('认不出的周次写法有：' + sampleTexts.join('、') + '，这些时段没有导入，请对照教务系统手动添加');
    }

    // 缺教师 / 缺地点：课照常导入（对应项为空），但按类型汇总计数说出来，不静默
    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var fieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) fieldNames.push(shortName(fieldSamples[fs]));
        warn('有 ' + fieldParts.join('、') + '（例如 ' + fieldNames.join('、') + '）：已照常导入，' +
            '空着的项可在「编辑课程」里补上');
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，' +
            '已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，' +
            '已忽略，请核对这几门课的周次');
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    }
    if (orphanMarkers > 0) {
        warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次（教务数据写得不完整），这些标记已忽略');
    }
    if (bothMarks > 0) {
        warn('有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对');
    }

    // 兜底：真到了上限就说清楚（正常路径下这个计数永远是 0）
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
