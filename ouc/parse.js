(function () {
    // 中国海洋大学（强智科技「教务管理系统」新版界面 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 OUC/ouc_01.js（MIT，上游作者 anOsprey）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 19a65bf（2026-10-19 拉取）；本校脚本最后一次修改 1f02b9f。
    // 上游的核心是 parseWeeks()（周次与单双周）、mergeAndDistinctCourses()（同课合并）、parseCourseItem()（课程卡片）、
    // parseTimetableToModel()（周课表）、parseCalendarRows() / deriveMondayFromRow()（教学周历）与两张写死的校区节次时间表
    //（LAOSHAN_TIME_SLOTS / WEST_COAST_TIME_SLOTS）。这里照同样的判据重写，并降到 ES5。
    // 周课表的网格还原、同课合并、节次补齐的写法照已审计的同族件 nefu（同为强智新版界面）；周次写法照 hueb / swu。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 单张卡片坏了不整表失败，也不静默丢（上游：读不到周次的卡片返回 null 悄悄丢掉；读不到节次的卡片悄悄当成第 1 节）：
    //      课名或时间读不出、周次或节次写法认不出、周次过滤后没有有效周次 → 这张卡跳过，按类型计数并点名；
    //   ② 周次写法比上游多认：「(单)1-8周,(双)9-16周」这类每段各带标记、「1-8周(单) 9-16周」后缀紧挨下一段、
    //      「第1-第8周」、「共 N 周」备注（只剥备注本身）、节次列表「[1,2,5节]」拆成连续几块。上游只读第一段周次；
    //   ③ 校区节次时间：上游每次都弹窗问；这里照上游问（由 extract.js 问一次），只有请求的是页面自己选中的作息方案时，
    //      才用方案名称和第一大节的上课时间做明确判断、省掉提问；问不了或用户取消，按崂山/鱼山校区导入并提醒；
    //   ④ 开学日：上游从教学周历第 1 周那一行的「M月D日」格推出周一，年份在学年的起止年里按星期几对出来；这里同样，
    //      但日期必须落在学期的合理区间里（第一学期在起始年 8–10 月等），并多认「yyyy年M月D日」与星期日排第一列的周历；
    //      推出多个不同的周一、或一个都推不出，才按提取时刻推算最近的周一，并提醒；
    //   ⑤ 总周数：上游取周历里最大的「第 N 周」；这里同样，取不到有兜底（课表最大周次、20 周）并提醒，课表周次更大则抬高；
    //   ⑥ 周次上限 30（载荷规范），超过的周次截掉并计数提醒；
    //   ⑦ 教师、地点拿不到留空（null），不写「未知」，按类型汇总提醒；
    //   ⑧ 课表用到第 13 节及以后时，在上一节下课后顺推补上节次时间（课间 5 分钟、每节 45 分钟），越过 23:59 的如实说明（批次五统一修订 H3）；
    //   ⑨ 表尾的备注项目（未排具体星期和节次）不导入，提醒里点名；
    //   ⑩ 同课合并沿用 nefu 的按周拆开再合并：只合并同一周内相邻或重叠的节次，不把部分周的调课扩到整学期。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，CI 的 Rhino 里没有 DOM），形状见 AUDIT.md 第 4 节：
    //   { source, pageUrl, now, loginForm, loginTitle, term, echoTerm, mode, campus, tableCount, table, calendar }
    var data = JSON.parse(__ncInput);

    // 校区节次时间：上游写死的两张 12 节表，逐节照抄（西海岸校区只有第 1–4 节不同，第 5–12 节与崂山、鱼山校区相同）。
    var HOME_TIMES = [
        { start: '08:00', end: '08:50' },
        { start: '09:00', end: '09:50' },
        { start: '10:10', end: '11:00' },
        { start: '11:10', end: '12:00' },
        { start: '13:30', end: '14:20' },
        { start: '14:30', end: '15:20' },
        { start: '15:30', end: '16:20' },
        { start: '16:30', end: '17:20' },
        { start: '17:30', end: '18:20' },
        { start: '18:30', end: '19:20' },
        { start: '19:30', end: '20:20' },
        { start: '20:30', end: '21:20' }
    ];
    var WEST_TIMES = [
        { start: '08:30', end: '09:20' },
        { start: '09:25', end: '10:15' },
        { start: '10:30', end: '11:20' },
        { start: '11:25', end: '12:15' },
        HOME_TIMES[4], HOME_TIMES[5], HOME_TIMES[6], HOME_TIMES[7],
        HOME_TIMES[8], HOME_TIMES[9], HOME_TIMES[10], HOME_TIMES[11]
    ];
    var SLOT_COUNT = HOME_TIMES.length;
    // 顺推（统一修订 H3）：课间 5 分钟、每节 45 分钟
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    // 载荷规范的周次上限是 30
    var MAX_WEEK = 30;
    var SECTION_LIMIT = 48;
    // 没有周历周数、课表里也没有周次时的兜底总周数（上游是 totalWeeks || 20）
    var FALLBACK_TOTAL_WEEKS = 20;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_MINUTE = 23 * 60 + 59;
    var SCHOOL_NAME = '中国海洋大学';
    var LOGIN_TEXT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';
    var HEADER_DAY = /^(?:星期|周)?([一二三四五六日天])$/;
    var DAY_CHARS = '一二三四五六日天';
    var TERM_CODE = /^\d{4}-\d{4}-\d$/;

    // 计数：一个都不许静默丢，全部进 warnings
    var noNameBlocks = 0;
    var noTimeBlocks = 0;
    var noWeekBlocks = 0;
    var droppedWeeks = 0;
    var bothMarks = 0;
    var droppedNames = [];
    var missingTeacherNames = {};
    var missingLocationNames = {};
    var missingTeacherOrder = [];
    var missingLocationOrder = [];

    // 载荷里的核对提示。**一律经 pushWarning() 出去**：每条 ≤200 字（超了按码位截断加省略号）。
    // 一共 ≤20 条是载荷校验的硬上限：超过时由 finalWarnings() 收尾（前 19 条照常，第 20 条写成汇总），绝不静默丢。
    var warnings = [];

    function clipText(text, max) {
        var one = String(text);
        if (one.length <= max) return one;
        var head = one.substring(0, max - 1);
        var last = head.charCodeAt(head.length - 1);
        if (last >= 0xD800 && last <= 0xDBFF) head = head.substring(0, head.length - 1);
        return head + '…';
    }

    function pushWarning(message) {
        var text = clipText(message, MAX_WARNING_TEXT);
        if (warnings.indexOf(text) >= 0) return;
        warnings.push(text);
    }

    function finalWarnings() {
        if (warnings.length <= MAX_WARNINGS) return warnings;
        var kept = warnings.slice(0, MAX_WARNINGS - 1);
        var hidden = warnings.length - kept.length;
        kept.push(clipText('另有 ' + hidden + ' 条提醒未列出', MAX_WARNING_TEXT));
        return kept;
    }

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 某个日期所在那一周的周一。不用 Date.parse：Rhino 对 ISO 串的支持不齐。
    function mondayOf(isoDate) {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(clean(isoDate));
        if (!m) return null;
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        var back = (day.getDay() + 6) % 7;
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() - back));
    }

    // 「2026-2027-1」→「2026-2027学年第一学期」
    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(clean(code));
        if (!m) return '';
        if (m[3] === '1') return m[1] + '-' + m[2] + '学年第一学期';
        if (m[3] === '2') return m[1] + '-' + m[2] + '学年第二学期';
        if (m[3] === '3') return m[1] + '-' + m[2] + '学年第三学期';
        return m[1] + '-' + m[2] + '学年第' + m[3] + '学期';
    }

    // 「HH:mm」→ 分钟数；不合法（或超过 23:59）返回 -1
    function clockMinutes(text) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(clean(text));
        if (!m) return -1;
        var hour = parseInt(m[1], 10);
        var minute = parseInt(m[2], 10);
        if (hour > 23 || minute > 59) return -1;
        return hour * 60 + minute;
    }

    function clockText(minutes) {
        var value = minutes;
        if (value < 0) value = 0;
        if (value > MAX_MINUTE) value = MAX_MINUTE;
        return pad2(Math.floor(value / 60)) + ':' + pad2(value % 60);
    }

    // 节次写法「1-5,7-8」「1、2」「01-02」展开成升序、不重复的数字。写法不对或越界返回 null（由调用方决定跳过哪张卡）
    function numbersOf(value, maximum) {
        var source = clean(value).replace(/\s/g, '').replace(/[，、]/g, ',').replace(/[－−–—~～]/g, '-');
        if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(source)) return null;
        var seen = {};
        var out = [];
        var parts = source.split(',');
        for (var i = 0; i < parts.length; i++) {
            var bounds = parts[i].split('-');
            var a = parseInt(bounds[0], 10);
            var b = bounds.length > 1 ? parseInt(bounds[1], 10) : a;
            if (a < 1 || b < a || b > maximum) return null;
            for (var n = a; n <= b; n++) {
                if (!seen[n]) {
                    seen[n] = true;
                    out.push(n);
                }
            }
        }
        out.sort(function (x, y) { return x - y; });
        return out;
    }

    // 升序数字拆成连续区间：[1,2,5] → [[1,2],[5,5]]
    function rangesOf(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var last = out[out.length - 1];
            if (last && list[i] === last[1] + 1) last[1] = list[i];
            else out.push([list[i], list[i]]);
        }
        return out;
    }

    // 升序周次拆成极大段（移植手册 §4.1）：连续 → ALL；隔周且起点为奇数 → ODD；隔周且起点为偶数 → EVEN；落单 → ALL
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j] };
            if (run.start === run.end || step === 1) run.weekType = 'ALL';
            else run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // ---------- 周次 ----------
    // 周次文本 → { bad, weeks, over, both }。认得的写法（上游只读第一段，这里整串读）：
    //   "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-16(单)周" / "1-16单周" / "1-3,5-9周" / "17周" / "1-3周 5-9周" / "第1-第8周" / "1-8周(共8周)"
    // 必须显式处理的坑（同族件审计抓到过的）：
    //   ① 「周」只是量词，不能拿它当分段边界；单/双标记只跟它自己那一段走。前缀写法「(单)1-8周,(双)9-16周」与
    //      后缀写法「1-8周(单) 9-16周(双)」里，标记前面紧挨数字或「周」时是上一段的后缀，不能被后面的数字抢去当前缀；
    //   ② 区间终点前的「第」（「第1-第8周」）整个去掉，否则区间会被拆成两端两周；
    //   ③ 「共 N 周」备注只剥备注本身，不能从「共」一路删到行尾；
    //   ④ 剩下认不出的括号（「(1)」「(3组)」）、多余字符一律当「写法认不出」（bad），不猜、不静默吞掉；
    //   ⑤ 单双都写了 = 每周都上（互相排除会让整段周次变空），计数后提醒；区间写反（16-1）当写法认不出。
    function fullWidthToHalf(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[，、；;]/g, ',');
    }

    function weeksOf(source) {
        var bad = false;
        var cleaned = clean(source);
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'。不要在这里删掉全部空白
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        cleaned = cleaned.replace(/第/g, '');
        // 紧挨周次的单/双括号按相邻关系先归属：「(单)1」→「单1」，「8周(单)」→「8单」（后缀后面紧跟下一段数字时补逗号隔开）
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            if (/[0-9周]\s*$/.test(whole.substring(0, offset))) return all;
            return mark;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            return digit + mark + (/^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '');
        });
        // 剩下的括号：只含数字的（「(1)」教学班序号）与含别的字的（「(3组)」）认不出；「(周)」「(1-16周)」「(单)」保留内容
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9,\-\s]+$/.test(inner) || /[^0-9,\-\s单双周]/.test(inner)) {
                bad = true;
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, function () {
            bad = true;
            return ',';
        });
        cleaned = cleaned.replace(/周/g, '');
        var tokens = cleaned.replace(/\s+/g, ',').split(',');
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            if (tokens[i]) segments.push(tokens[i]);
        }
        // 单/双自己成一段时并给最近的周次段（就近向前找，找不到再向后）
        for (i = 0; i < segments.length; i++) {
            if (/[0-9]/.test(segments[i])) continue;
            if (!/^[单双]+$/.test(segments[i])) continue;
            var into = -1;
            var near;
            for (near = i - 1; near >= 0; near--) {
                if (/[0-9]/.test(segments[near])) { into = near; break; }
            }
            for (near = i + 1; into < 0 && near < segments.length; near++) {
                if (/[0-9]/.test(segments[near])) { into = near; break; }
            }
            if (into < 0) continue;
            segments[into] = segments[into] + segments[i];
            segments[i] = '';
        }
        var seen = {};
        var weeks = [];
        var over = 0;
        var both = 0;
        for (i = 0; i < segments.length; i++) {
            var segment = segments[i];
            if (!segment) continue;
            var parts = /^([单双]*)([0-9]+)(?:-([0-9]+))?([单双]*)$/.exec(segment);
            if (!parts) {
                bad = true;
                continue;
            }
            var marks = parts[1] + parts[4];
            var onlyOdd = marks.indexOf('单') >= 0;
            var onlyEven = marks.indexOf('双') >= 0;
            if (onlyOdd && onlyEven) {
                both++;
                onlyOdd = false;
                onlyEven = false;
            }
            var start = parseInt(parts[2], 10);
            var end = parts[3] === undefined || parts[3] === '' ? start : parseInt(parts[3], 10);
            if (end < start) {
                bad = true;
                continue;
            }
            for (var week = start; week <= end; week++) {
                if (onlyOdd && week % 2 === 0) continue;
                if (onlyEven && week % 2 === 1) continue;
                if (week < 1 || week > MAX_WEEK) { over++; continue; }
                if (!seen[week]) { seen[week] = true; weeks.push(week); }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return { bad: bad, weeks: weeks, over: over, both: both };
    }

    // 时间串「周次[节次节]」→ 周次与节次。认不出返回 { error: 'time' }；过滤后没有周次 { error: 'week' }。
    function timeOf(text) {
        var m = /^(.*?)\[([^\[\]]*)\]$/.exec(clean(text));
        if (!m) return { error: 'time' };
        var sections = numbersOf(m[2].replace(/[第节]/g, ''), SECTION_LIMIT);
        var parsed = weeksOf(m[1]);
        if (!sections || parsed.bad) return { error: 'time' };
        if (!parsed.weeks.length) return { error: 'week' };
        return { weeks: parsed.weeks, over: parsed.over, both: parsed.both, ranges: rangesOf(sections) };
    }

    // 「课程名（老师）——原因」的点名（最多 5 个）：提醒里要说清是哪一门被跳过了
    function noteDropped(name, teacher, reason) {
        if (droppedNames.length >= 5) return;
        // 名字各截到 20 字，免得一条提醒被名单撑满
        var text = clipText(name || '(没认出课名)', 20);
        if (teacher) text = text + '（' + clipText(teacher, 20) + '）';
        droppedNames.push(text + '——' + reason);
    }

    function droppedText() {
        if (!droppedNames.length) return '';
        return '包含：' + droppedNames.join('；');
    }

    // 单个星期字 → 1..7（「日」「天」都是星期日）
    function dayOfLabel(value) {
        var m = HEADER_DAY.exec(clean(value));
        if (!m) return 0;
        var at = DAY_CHARS.indexOf(m[1]);
        if (at < 0) return 0;
        return m[1] === '天' ? 7 : at + 1;
    }

    // 卡片文字里的三个字段：老师 / 时间 / 地点。每个字段取到下一个标签（或分号）为止，同一个标签只认第一次出现。
    function fieldsOf(card) {
        var text = clean(card.text);
        var title = clean(card.title);
        if (title && text.indexOf(title) === 0) text = text.substring(title.length);
        var labelRe = /(老师|时间|地点)\s*[:：]/g;
        var marks = [];
        var found;
        while ((found = labelRe.exec(text)) !== null) {
            marks.push({ label: found[1], from: found.index, to: found.index + found[0].length });
        }
        var out = { 老师: null, 时间: null, 地点: null };
        for (var i = 0; i < marks.length; i++) {
            if (out[marks[i].label] !== null) continue;
            var stop = i + 1 < marks.length ? marks[i + 1].from : text.length;
            var value = text.substring(marks[i].to, stop);
            var cut = value.search(/[;；]/);
            if (cut >= 0) value = value.substring(0, cut);
            out[marks[i].label] = clean(value);
        }
        return out;
    }

    // ---- 登录页 / 返回内容核对 -----------------------------------------------------------
    if (data.loginForm === true || data.loginTitle === true) {
        throw new Error('当前页面不是课表，' + LOGIN_TEXT);
    }
    var termInfo = data.term || {};
    var termCode = clean(termInfo.code);
    if (!termCode) {
        throw new Error('找不到学年学期的选项，可能停在外层框架、登录页或错误页面。' + LOGIN_TEXT);
    }
    if (clean(data.echoTerm) && clean(data.echoTerm) !== termCode) {
        throw new Error('教务返回的课表与查询的学期对不上，请稍后重试');
    }
    var modeInfo = data.mode || {};
    var table = data.table;
    if (!table || !data.tableCount) {
        throw new Error('没有找到周课表，请确认已打开「课表查询」页面，并且选好了学期。' + LOGIN_TEXT);
    }
    if (data.tableCount > 1) {
        pushWarning('教务页面上有 ' + data.tableCount + ' 张周课表，只导入了第一张，请核对导入结果');
    }
    if (modeInfo.fallback === true) {
        pushWarning('教务系统的作息方案选项和预期不同，已改用页面当前选中的「' + clipText(clean(modeInfo.label), 30) +
            '」，请核对导入的课表是否完整');
    } else if (clean(modeInfo.selected) && clean(modeInfo.selected) !== clean(modeInfo.requested)) {
        pushWarning('教务返回的课表用的作息方案与预期不同，请核对导入的课表是否完整');
    }

    // ---- 周课表的网格 --------------------------------------------------------------------
    // 按 rowSpan / colSpan 占位还原网格（跨行的格子会让下一行少一格）；课程格子是 name 为 kbDataTd 的格子，
    // 它所在的网格列决定星期几。越界、重叠、跨列都报错，不猜星期。
    var rows = table.rows || [];
    if (!rows.length) {
        throw new Error('课表里没有节次行，无法识别');
    }
    var occupied = {};
    var dayCells = [];
    var colSeen = {};
    var dayCols = [];
    for (var r = 0; r < rows.length; r++) {
        var column = 0;
        var rowCells = rows[r] || [];
        for (var k = 0; k < rowCells.length; k++) {
            var cell = rowCells[k];
            while (occupied[r + ':' + column]) column++;
            var height = cell.rowSpan;
            var width = cell.colSpan;
            if (!(height >= 1) || !(width >= 1) || r + height > rows.length || width > 20) {
                throw new Error('课表格子的跨行或跨列对不上，无法还原课表，请把课表截图反馈给空课');
            }
            for (var rr = r; rr < r + height; rr++) {
                for (var cc = column; cc < column + width; cc++) {
                    if (occupied[rr + ':' + cc]) throw new Error('课表格子互相重叠，无法还原课表，请把课表截图反馈给空课');
                    occupied[rr + ':' + cc] = true;
                }
            }
            if (cell.name === 'kbDataTd') {
                if (width !== 1) throw new Error('课程格子的结构变了，无法识别，请把课表截图反馈给空课');
                dayCells.push({ col: column, cards: cell.cards || [] });
                if (!colSeen[column]) {
                    colSeen[column] = true;
                    dayCols.push(column);
                }
            }
            column += width;
        }
    }
    if (!dayCols.length) {
        throw new Error('课表里没有课程格子，无法识别，请确认已打开「课表查询」页面');
    }
    dayCols.sort(function (x, y) { return x - y; });

    // 星期：优先用表头（每个课程列正好对到一个不重复的星期标题）；认不全就按课程列从左到右依次当作星期一到星期日（正好 7 列时），
    // 并提醒；列数不是 7 又没有表头，无法判断星期，报错。
    var headDays = {};
    var headCol = 0;
    var head = table.head || [];
    for (var hi = 0; hi < head.length; hi++) {
        if (head[hi].colSpan === 1) headDays[headCol] = dayOfLabel(head[hi].text);
        headCol += head[hi].colSpan >= 1 ? head[hi].colSpan : 1;
    }
    var colDay = {};
    var headerOk = true;
    var daySeen = {};
    for (var dc = 0; dc < dayCols.length; dc++) {
        var headDay = headDays[dayCols[dc]] || 0;
        if (!headDay || daySeen[headDay]) headerOk = false;
        daySeen[headDay] = true;
        colDay[dayCols[dc]] = headDay;
    }
    if (!headerOk) {
        if (dayCols.length !== 7) {
            throw new Error('课表表头和预期不一样：必须能明确认出星期一至星期日');
        }
        for (var oc = 0; oc < 7; oc++) colDay[dayCols[oc]] = oc + 1;
        pushWarning('课表顶部没有认出星期几的标题，已按课表从左到右依次当作星期一到星期日，请核对导入结果');
    }

    // ---- 课程卡片 ------------------------------------------------------------------------
    // 每张卡：课名读不出、时间读不出 → 跳过；时间串认不出 / 没有有效周次 → 跳过，按类型计数并点名。教师、地点读不到留空。
    var records = [];
    var recordSeen = {};
    var maxPeriod = 0;
    for (var ci = 0; ci < dayCells.length; ci++) {
        var cards = dayCells[ci].cards;
        for (var cj = 0; cj < cards.length; cj++) {
            var name = clean(cards[cj].title);
            var fields = fieldsOf(cards[cj]);
            var teacher = fields['老师'] ? fields['老师'] : null;
            var position = fields['地点'] ? fields['地点'] : null;
            if (!name) {
                noNameBlocks++;
                noteDropped('', teacher, '没认出课名');
                continue;
            }
            if (!fields['时间']) {
                noTimeBlocks++;
                noteDropped(name, teacher, '周次或节次的写法没认出来');
                continue;
            }
            var parsed = timeOf(fields['时间']);
            if (parsed.error === 'time') {
                noTimeBlocks++;
                noteDropped(name, teacher, '周次或节次的写法没认出来');
                continue;
            }
            if (parsed.error === 'week') {
                noWeekBlocks++;
                noteDropped(name, teacher, '没有有效周次');
                continue;
            }
            droppedWeeks += parsed.over;
            bothMarks += parsed.both;
            if (!teacher && !missingTeacherNames['k:' + name]) {
                missingTeacherNames['k:' + name] = true;
                missingTeacherOrder.push(name);
            }
            if (!position && !missingLocationNames['k:' + name]) {
                missingLocationNames['k:' + name] = true;
                missingLocationOrder.push(name);
            }
            for (var rg = 0; rg < parsed.ranges.length; rg++) {
                var start2 = parsed.ranges[rg][0];
                var end2 = parsed.ranges[rg][1];
                if (end2 > maxPeriod) maxPeriod = end2;
                var record = {
                    name: name,
                    teacher: teacher,
                    position: position,
                    day: colDay[dayCells[ci].col],
                    startSection: start2,
                    endSection: end2,
                    weeks: parsed.weeks.slice()
                };
                var key = JSON.stringify([name, teacher, position, record.day, start2, end2, parsed.weeks]);
                if (recordSeen[key]) continue;
                recordSeen[key] = true;
                records.push(record);
            }
        }
    }

    // ---- 同课合并（上游 mergeAndDistinctCourses 的口径，写法照 nefu）：同名、同老师、同地点、同星期，
    //      先按周拆开，每周内合并相邻或重叠的节次，再把节次相同的周收拢，最后每组周次切成极大段。
    function textCompare(x, y) {
        var a = x || '';
        var b = y || '';
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    }

    function compareEntries(a, b) {
        return (a.day - b.day) || (a.startSection - b.startSection) || (a.endSection - b.endSection) ||
            textCompare(a.name, b.name) || textCompare(a.teacher, b.teacher) ||
            textCompare(a.position, b.position) || (a.startWeek - b.startWeek);
    }

    function mergeRecords(list) {
        var groups = {};
        var order = [];
        var i;
        for (i = 0; i < list.length; i++) {
            var rec = list[i];
            var gkey = JSON.stringify([rec.name, rec.teacher, rec.position, rec.day]);
            if (!groups[gkey]) {
                groups[gkey] = { rec: rec, weeks: {} };
                order.push(gkey);
            }
            var group = groups[gkey];
            for (var w = 0; w < rec.weeks.length; w++) {
                var wk = String(rec.weeks[w]);
                if (!group.weeks[wk]) group.weeks[wk] = [];
                group.weeks[wk].push([rec.startSection, rec.endSection]);
            }
        }
        var entries = [];
        for (var o = 0; o < order.length; o++) {
            var g = groups[order[o]];
            var weekKeys = Object.keys(g.weeks).sort(function (x, y) { return Number(x) - Number(y); });
            var sigs = {};
            var sigOrder = [];
            for (var wi = 0; wi < weekKeys.length; wi++) {
                var intervals = g.weeks[weekKeys[wi]].slice().sort(function (x, y) {
                    return x[0] - y[0] || x[1] - y[1];
                });
                var merged = [];
                for (var ii2 = 0; ii2 < intervals.length; ii2++) {
                    var last = merged[merged.length - 1];
                    if (last && intervals[ii2][0] <= last[1] + 1) {
                        last[1] = Math.max(last[1], intervals[ii2][1]);
                    } else {
                        merged.push([intervals[ii2][0], intervals[ii2][1]]);
                    }
                }
                for (var mi = 0; mi < merged.length; mi++) {
                    var sig = merged[mi][0] + ':' + merged[mi][1];
                    if (!sigs[sig]) {
                        sigs[sig] = { start: merged[mi][0], end: merged[mi][1], weeks: [] };
                        sigOrder.push(sig);
                    }
                    sigs[sig].weeks.push(Number(weekKeys[wi]));
                }
            }
            for (var si2 = 0; si2 < sigOrder.length; si2++) {
                var part = sigs[sigOrder[si2]];
                var runs = runsOf(part.weeks);
                for (var rn = 0; rn < runs.length; rn++) {
                    entries.push({
                        name: g.rec.name,
                        teacher: g.rec.teacher,
                        position: g.rec.position,
                        day: g.rec.day,
                        startSection: part.start,
                        endSection: part.end,
                        startWeek: runs[rn].start,
                        endWeek: runs[rn].end,
                        weekType: runs[rn].weekType
                    });
                }
            }
        }
        entries.sort(compareEntries);
        return entries;
    }

    if (!records.length) {
        var skippedAll = noNameBlocks + noTimeBlocks + noWeekBlocks;
        if (skippedAll > 0) {
            throw new Error(clipText('本学期没有解析到任何课程：课表里的 ' + skippedAll +
                ' 个上课安排都没能认出来（周次或节次的写法不认识，或没有有效周次）。' +
                droppedText() + ' 请把教务页面的课表截图反馈给空课', MAX_WARNING_TEXT));
        }
        throw new Error('本学期没有解析到任何课程：可能是还没排课，或教务页面改了结构（也可能登录状态已失效）');
    }

    var entries = mergeRecords(records);
    var courseMap = {};
    var courseOrder = [];
    for (var ei = 0; ei < entries.length; ei++) {
        var entry = entries[ei];
        var ckey = JSON.stringify([entry.name, entry.teacher]);
        if (!courseMap[ckey]) {
            courseMap[ckey] = { name: entry.name, teacher: entry.teacher, note: null, blocks: [] };
            courseOrder.push(ckey);
        }
        courseMap[ckey].blocks.push({
            dayOfWeek: entry.day,
            startPeriod: entry.startSection,
            endPeriod: entry.endSection,
            startWeek: entry.startWeek,
            endWeek: entry.endWeek,
            weekType: entry.weekType,
            location: entry.position
        });
    }
    var courses = [];
    var maxWeek = 0;
    for (var oi = 0; oi < courseOrder.length; oi++) {
        var item = courseMap[courseOrder[oi]];
        for (var bi = 0; bi < item.blocks.length; bi++) {
            if (item.blocks[bi].endWeek > maxWeek) maxWeek = item.blocks[bi].endWeek;
        }
        courses.push(item);
    }

    // ---- 校区与节次时间 --------------------------------------------------------------------
    // 校区能不能从教务数据判断（与 extract.js 的 campusEvidence 同一口径，两处要一起改）。只在请求的是页面自己选中的作息方案时才用：
    // 作息方案的名称写了「西海岸」或「崂山」「鱼山」（只写一边才算），或第一大节 08:30 开始（只有西海岸的节次时间是这样）。
    // 第一大节 08:00 开始不能当作崂山、鱼山的证据：页面上的节次标签可能对所有校区都一样；它只用来和名称对质。
    // 名称与时间互相矛盾、或两者都没有说明，返回 null（这时用提问的结果）。
    function campusEvidence(modeLabel, clock) {
        var byLabel = null;
        var west = /西海岸/.test(modeLabel);
        var home = /崂山|鱼山/.test(modeLabel);
        if (west && !home) byLabel = 'west';
        if (home && !west) byLabel = 'home';
        var byClock = null;
        if (clock === '08:30') byClock = 'west';
        if (clock === '08:00') byClock = 'home';
        if (byLabel && byClock && byLabel !== byClock) return null;
        if (byLabel) return byLabel;
        return byClock === 'west' ? 'west' : null;
    }

    // 只有请求的是页面自己选中的作息方案（fallback）时，方案名称和节次标签才与学生相关；
    // 请求的是上游写死的编号时，这两个值对所有人都一样，不能拿来判校区，一律用提问的结果。
    var campus = modeInfo.fallback === true ? campusEvidence(clean(modeInfo.label), clean(modeInfo.clock)) : null;
    var campusDefaulted = false;
    if (!campus) {
        var asked = data.campus || {};
        if (asked.index === 1) campus = 'west';
        else if (asked.index === 0) campus = 'home';
        else {
            campus = 'home';
            campusDefaulted = true;
        }
    }
    var baseTimes = campus === 'west' ? WEST_TIMES : HOME_TIMES;
    var periodTimes = [];
    for (var bp = 0; bp < baseTimes.length; bp++) {
        periodTimes.push({ periodIndex: bp + 1, start: baseTimes[bp].start, end: baseTimes[bp].end });
    }
    // 课表用到第 13 节及以后：在上一节下课后顺推（统一修订 H3），越过 23:59 就停，停下的节次写进提醒（课程照常导入）
    var fillFrom = 0;
    var fillTo = 0;
    var uncoveredFrom = 0;
    for (var fp = SLOT_COUNT + 1; fp <= maxPeriod; fp++) {
        var prevEnd = clockMinutes(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > MAX_MINUTE) {
            uncoveredFrom = fp;
            break;
        }
        periodTimes.push({ periodIndex: fp, start: clockText(nextStart), end: clockText(nextEnd) });
        if (!fillFrom) fillFrom = fp;
        fillTo = fp;
    }

    // ---- 教学周历：开学日期与学期总周数（上游 parseCalendarRows / deriveMondayFromRow / fetchCalendarInfo）----------
    // 每行：找到「第 N 周」标签格，它后面的格子依次是星期一到星期日（上游的假定）。
    function compact(value) {
        return String(value === null || value === undefined ? '' : value).replace(/\s+/g, '');
    }

    function calendarRowsOf(raw) {
        var out = [];
        for (var r2 = 0; r2 < raw.length; r2++) {
            var cells = raw[r2] || [];
            var labelAt = -1;
            var week = 0;
            for (var c2 = 0; c2 < cells.length && labelAt < 0; c2++) {
                var text = compact(cells[c2].text);
                // 第一格（上游只认它）写「第 N 周」或只写数字；别的格子必须整格就是「第 N 周」
                var m;
                if (c2 === 0) m = /第(\d{1,3})周/.exec(text) || /^(\d{1,3})$/.exec(text);
                else m = /^第(\d{1,3})周$/.exec(text);
                if (m) {
                    labelAt = c2;
                    week = parseInt(m[1], 10);
                }
            }
            if (labelAt < 0 || week < 1) continue;
            out.push({ week: week, cells: cells.slice(labelAt + 1) });
        }
        return out;
    }

    var calendarRows = data.calendar && data.calendar.rows ? calendarRowsOf(data.calendar.rows) : [];

    // 学期的合理区间：第一学期的开学日在学年起始年的 8–10 月，第二学期在后一年的 1–4 月，第三学期在后一年的 6–9 月。
    // 周历格子里的日期只有落在这个区间里才算数（周日排第一列时，8月31日 配上「星期一排第一列」再加一年也能凑出星期，
    // 但那是下一年的 8 月，不在区间里）。学期代码认不出时只收带年份的日期。
    function termWindow() {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(termCode);
        if (!m) return null;
        var year = parseInt(m[1], 10);
        if (m[3] === '1') return { year: year, from: 8, to: 10 };
        if (m[3] === '2') return { year: year + 1, from: 1, to: 4 };
        if (m[3] === '3') return { year: year + 1, from: 6, to: 9 };
        return null;
    }

    // 一个周历格子里的日期：「9月1日」「9月1」「2026年9月1日」（文字或 title 属性）。认不出返回 null
    function dateOfCell(cell) {
        var sources = [compact(cell.text), compact(cell.title)];
        for (var s = 0; s < sources.length; s++) {
            var m = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?/.exec(sources[s]);
            if (m) return { year: m[1] ? parseInt(m[1], 10) : 0, month: parseInt(m[2], 10), day: parseInt(m[3], 10) };
        }
        return null;
    }

    // 第 1 周那一行推出开学日的周一：「列序（星期一排第一列 / 星期日排第一列）× 格子」全部试一遍，
    // 只收日期在学期区间里、且日期的星期几与列序对得上的组合（日期的星期几是真的）；
    // 所有合法组合推出同一个周一才采用，推出多个不同的周一或一个都没有，返回 null（由调用方推算并提醒）。
    function mondayFromRow(cells) {
        var win = termWindow();
        var layouts = [{ monday: 0, first: 1 }, { monday: 1, first: 0 }];
        var found = {};
        var count = 0;
        var only = null;
        for (var l = 0; l < layouts.length; l++) {
            for (var idx = 0; idx < cells.length && idx < 7; idx++) {
                var date = dateOfCell(cells[idx]);
                if (!date) continue;
                var year = date.year || (win ? win.year : 0);
                if (!year) continue;
                if (win && (year !== win.year || date.month < win.from || date.month > win.to)) continue;
                var d = new Date(year, date.month - 1, date.day);
                if (d.getFullYear() !== year || d.getMonth() !== date.month - 1 || d.getDate() !== date.day) continue;
                if (d.getDay() !== (idx + layouts[l].first) % 7) continue;
                var monday = isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (idx - layouts[l].monday)));
                if (!found[monday]) {
                    found[monday] = true;
                    count++;
                    only = monday;
                }
            }
        }
        return count === 1 ? only : null;
    }

    var calendarWeeks = 0;
    var firstDay = null;
    for (var cr = 0; cr < calendarRows.length; cr++) {
        if (calendarRows[cr].week > calendarWeeks) calendarWeeks = calendarRows[cr].week;
        if (calendarRows[cr].week === 1 && !firstDay) firstDay = mondayFromRow(calendarRows[cr].cells);
    }

    // 总周数：周历给出的最大周号优先；周历没有就按课表最大周次，最后才是兜底的 20 周。
    // 课表里有更晚的周次就抬高到它（不然那一块的结束周会超出总周数，载荷会被拒收）。
    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : (maxWeek > 0 ? maxWeek : FALLBACK_TOTAL_WEEKS);
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    // 开学日期：周历第 1 周那一行（真实值）；取不到就按提取时刻推算最近的周一 —— 推算值和真值在库里长得一模一样，必须说明。
    if (!firstDay) {
        firstDay = mondayOf(data.now);
        if (!firstDay) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
        pushWarning('开学日期无法从教务获取（教学周历没有取到、认不出或日期对不上），已按最近的周一（' + firstDay + '）推算，请在「学期管理」里核对');
    }

    // ---- 学期名：教务给的学年学期文字 → 学期代码拼出的名字 → 都没有才用占位并提醒 ----------------
    var termLabel = clean(termInfo.label);
    var termName = '';
    if (termLabel && TERM_CODE.test(termLabel)) termName = termNameFromCode(termLabel);
    else if (termLabel) termName = termLabel;
    if (!termName && TERM_CODE.test(termCode)) termName = termNameFromCode(termCode);
    if (!termName) {
        termName = SCHOOL_NAME + '当前学期';
        pushWarning('没能识别出学年学期的名字，学期名已用「' + termName + '」占位，请在「学期管理」里改名');
    }

    // ---- 其它提醒 ------------------------------------------------------------------------------
    if (campusDefaulted) {
        pushWarning('教务系统没有标明校区，节次时间按崂山/鱼山校区导入；西海岸校区上午前四节的时间不同，请在「学期管理」里核对节次时间');
    }
    if (fillTo > 0) {
        pushWarning('课表用到了第 ' + (fillFrom === fillTo ? String(fillFrom) : fillFrom + '–' + fillTo) +
            ' 节，学校公布的节次时间只有 ' + SLOT_COUNT + ' 节，这几节已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在「学期管理」里核对');
    }
    if (uncoveredFrom > 0) {
        pushWarning('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }

    var remarks = [];
    var foot = table.foot || [];
    for (var fi = 0; fi < foot.length; fi++) {
        if (clean(foot[fi])) remarks.push(clean(foot[fi]));
    }
    if (remarks.length) {
        var sample = remarks.slice(0, 3).map(function (text) { return '「' + clipText(text, 30) + '」'; }).join('、');
        pushWarning('教务课表里有 ' + remarks.length + ' 项备注没排具体星期和节次（如' + sample +
            '），这些内容没有导入，请在教务系统里查看');
    }

    if (calendarWeeks === 0) {
        var how = maxWeek > 0 ? ('课表里的最大周次（' + maxWeek + ' 周）') : (FALLBACK_TOTAL_WEEKS + ' 周');
        pushWarning('教务没有给出学期总周数，已按' + how + '计，请在「学期管理」里核对');
    }
    if (wantedWeeks > MAX_WEEK) {
        pushWarning('学期总周数算出来是 ' + wantedWeeks + ' 周，超过了上限 ' + MAX_WEEK + ' 周，已按 ' + MAX_WEEK + ' 周计，请在「学期管理」里核对');
    } else if (totalWeeks > baseWeeks) {
        pushWarning('课表里有到第 ' + maxWeek + ' 周的课，比学期的 ' + baseWeeks + ' 周多，学期总周数已按 ' + totalWeeks +
            ' 周计，请在「学期管理」里核对');
    }
    if (droppedWeeks > 0) {
        pushWarning('有 ' + droppedWeeks + ' 个周次超出 1–' + MAX_WEEK + ' 周，这些周次没有导入');
    }
    if (bothMarks > 0) {
        pushWarning('有 ' + bothMarks + ' 处周次里「单」「双」同时出现，已按每周都上处理，请核对导入结果');
    }

    var skipped = noNameBlocks + noTimeBlocks + noWeekBlocks;
    if (skipped > 0) {
        var skipParts = [];
        if (noNameBlocks) skipParts.push('没认出课名 ' + noNameBlocks + ' 个');
        if (noTimeBlocks) skipParts.push('周次或节次写法没认出 ' + noTimeBlocks + ' 个');
        if (noWeekBlocks) skipParts.push('没有有效周次 ' + noWeekBlocks + ' 个');
        pushWarning('有 ' + skipped + ' 个上课安排没能导入（' + skipParts.join('，') + '）。教务页面的写法可能有变化，欢迎反馈。' +
            droppedText());
    }

    function namesText(list) {
        var shown = [];
        for (var n = 0; n < list.length && n < 3; n++) shown.push(clipText(list[n], 20));
        return shown.join('、');
    }
    if (missingTeacherOrder.length || missingLocationOrder.length) {
        var gaps = [];
        if (missingTeacherOrder.length) gaps.push(missingTeacherOrder.length + ' 门课没给上课教师');
        if (missingLocationOrder.length) gaps.push(missingLocationOrder.length + ' 门课没给上课地点');
        var gapNames = [];
        var gapSeen = {};
        var gapPool = missingTeacherOrder.concat(missingLocationOrder);
        for (var gp = 0; gp < gapPool.length; gp++) {
            if (gapSeen['k:' + gapPool[gp]]) continue;
            gapSeen['k:' + gapPool[gp]] = true;
            gapNames.push(gapPool[gp]);
        }
        pushWarning('有 ' + gaps.join('、') + '（例如 ' + namesText(gapNames) + '）：已照常导入，空着的部分可在对应课程的「编辑课程」里补上');
    }

    var term = {
        name: termName,
        firstDay: firstDay,
        totalWeeks: totalWeeks,
        periodTimes: periodTimes,
        courses: courses
    };

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finalWarnings(),
        terms: [term]
    });
})()
