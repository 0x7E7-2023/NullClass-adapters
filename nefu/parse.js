(function () {
    // 东北林业大学（强智科技「教务管理系统」新版界面 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 NEFU/nefu.js（MIT，上游作者 Chr0n0stasis）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游的核心是 metadata()（学期、作息模式、周次三个下拉框）、headerMap()（星期表头）、parseDocument()（网格与课程卡片）、
    // parseTime()（周次、单双周、节次）、mergeCourses()（同课合并）。这里照同样的判据重写，并降到 ES5。
    // 开学日与总周数的取法照模板件 yssdufe 的教学周历逻辑。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 单张卡片坏了不整表失败（上游一张坏卡就整次失败）：课名或老师 / 时间 / 地点读不出、周次或节次写法认不出、
    //      单双周标记自相矛盾、周次过滤后没有有效周次、节次不在本作息模式里 → 这张卡跳过，按类型计数并点名；
    //      表头、网格、课程卡片容器这类结构问题仍整体报错；
    //   ② 节次时间（上游不导入作息，它沿用应用里原有的学期设置）：用每大节的行标签「(1、2小节) 08:00~09:35」
    //      推出每一节的起止时间；推不全就不交节次时间（应用用默认节次时间），并提醒；
    //   ③ 开学日与总周数（上游不取教学周历）：照 yssdufe 的周历逻辑取，取不到有兜底（周次下拉框最大值、课表最大周次）并提醒；
    //   ④ 周次上限 30（载荷规范），上游允许到 60：超过 30 的周次截掉并计数提醒；
    //   ⑤ 表尾的备注项目（未排具体星期和节次）不导入，提醒里点名；
    //   ⑥ 去掉上游「仅导入课程，保留原有作息和学期设置」的提醒；
    //   ⑦ 教师、地点拿不到留空（null），不写「未知」；
    //   ⑧ 同课合并沿用上游的按周拆开再合并：只合并同一周内相邻或重叠的节次，不把部分周的调课扩到整学期；
    //      切段输出照移植手册 §4.1，切成极大段（ALL / ODD / EVEN）。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，CI 的 Rhino 里没有 DOM），形状见 AUDIT.md 第 4 节：
    //   { source, pageUrl, now, loginForm, loginTitle, request, selects, tables: [ { head, body, foot } ], calendar }
    var data = JSON.parse(__ncInput);

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节，数值照抄移植件 haut 的 BUILTIN_PERIOD_TIMES）。
    // 节次时间整张推不出来、而课表用到了第 13 节及以上时，交出这 12 节，第 13 节起按下面的补时间循环顺推。
    var BUILTIN_PERIOD_TIMES = [
        { start: '08:00', end: '08:45' },
        { start: '08:55', end: '09:40' },
        { start: '10:00', end: '10:45' },
        { start: '10:55', end: '11:40' },
        { start: '14:00', end: '14:45' },
        { start: '14:55', end: '15:40' },
        { start: '16:00', end: '16:45' },
        { start: '16:55', end: '17:40' },
        { start: '18:30', end: '19:15' },
        { start: '19:25', end: '20:10' },
        { start: '20:20', end: '21:05' },
        { start: '21:15', end: '22:00' }
    ];
    var DEFAULT_SLOT_COUNT = BUILTIN_PERIOD_TIMES.length;
    // 顺推：课间 5 分钟、每节 45 分钟（与 haut 的补时间循环一致）
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    // 载荷规范的周次上限是 30；上游允许到 60，超过 30 的周次截掉并提醒
    var MAX_WEEK = 30;
    var WEEK_LIMIT = 60;
    var SECTION_LIMIT = 48;
    // 没有周历、没有周次下拉框、课表里也没有周次时的兜底总周数（照 yssdufe）
    var FALLBACK_TOTAL_WEEKS = 20;
    // 每大节内相邻两节之间的课间（分钟）
    var BREAK_MINUTES = 5;
    // 大节内每一节至少多少分钟才算数，否则整张节次时间不交
    var MIN_SLOT_MINUTES = 20;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_MINUTE = 23 * 60 + 59;
    var SCHOOL_NAME = '东北林业大学';
    var MODE_NAME = '本部';
    var LOGIN_TEXT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';

    // 行标签：「第一大节 (1、2小节) 08:00~09:35」→ 小节号与这一大节的起止时间（时间可能没有）
    var ROW_SECTIONS = /[（(]([\d、,，\s]+)小节[)）]/;
    var ROW_CLOCK = /(\d{2}:\d{2})\s*[~～\-]\s*(\d{2}:\d{2})/;
    // 卡片详情：老师:…;时间:…;地点:…
    var CARD_FIELDS = /^老师[:：](.*?)[;；]时间[:：](.*?)[;；]地点[:：](.*)$/;
    // 时间串（去掉空白后）：周次列表、可选单双（写在「周」前，或括号里写在后面）、节次列表
    var TIME_TEXT = /^([\d,，、\-－–—~～]+)(单|双)?周(?:[（(](单|双)周?[)）])?\[([\d,，、\-－–—~～]+)节\]$/;
    var HEADER_DAY = /^(?:星期|周)([一二三四五六日天])$/;
    var DAY_CHARS = '一二三四五六日天';
    var COUNT_TEXT = /^\d+$/;
    var TERM_CODE = /^\d{4}-\d{4}-\d$/;

    // 计数：一个都不许静默丢，全部进 warnings
    var noNameBlocks = 0;
    var noTimeBlocks = 0;
    var parityBlocks = 0;
    var noWeekBlocks = 0;
    var sectionOutBlocks = 0;
    var droppedWeeks = 0;
    var droppedNames = [];

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

    // 「2026年09月07日」与「2026年09月07」都认。认不出返回 null
    function isoOfCnDate(value) {
        var text = clean(value);
        var m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
        if (!m) m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        // 日历日期要真存在（2027-02-31 会被载荷校验拒收，整次导入就白导了）
        var probe = new Date(year, month - 1, day);
        if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
        return year + '-' + pad2(month) + '-' + pad2(day);
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

    // 「1-5,7-8」「1、2」这类写法展开成升序、不重复的数字。写法不对或越界返回 null（由调用方决定跳过哪张卡）
    function numbersOf(value, maximum) {
        var source = clean(value).replace(/\s/g, '').replace(/[，、]/g, ',').replace(/[－–—~～]/g, '-');
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

    // 时间串 → 周次与节次。认不出返回 { error: 'time' }；单双矛盾 { error: 'parity' }；过滤后没有周次 { error: 'week' }。
    // 超过 30 周的周次截掉，计入 over（卡片保留时才计入 droppedWeeks）。
    function timeOf(text) {
        var compact = clean(text).replace(/\s/g, '');
        var m = TIME_TEXT.exec(compact);
        if (!m) return { error: 'time' };
        var weeks = numbersOf(m[1], WEEK_LIMIT);
        var sections = numbersOf(m[4], SECTION_LIMIT);
        if (!weeks || !sections) return { error: 'time' };
        if (m[2] && m[3] && m[2] !== m[3]) return { error: 'parity' };
        var parity = m[2] || m[3] || '';
        var kept = [];
        var over = 0;
        for (var i = 0; i < weeks.length; i++) {
            if (parity && weeks[i] % 2 !== (parity === '单' ? 1 : 0)) continue;
            if (weeks[i] > MAX_WEEK) {
                over++;
                continue;
            }
            kept.push(weeks[i]);
        }
        if (!kept.length) return { error: 'week' };
        return { weeks: kept, over: over, ranges: rangesOf(sections) };
    }

    // 「课程名 老师 地点」的点名（最多 5 个）：提醒里要说清是哪一门被跳过了
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
    function dayOfChar(ch) {
        var at = DAY_CHARS.indexOf(ch);
        if (at < 0 || ch.length !== 1) return 0;
        return ch === '天' ? 7 : at + 1;
    }

    // 周历的表头是单字（bare 为真时认）；课表表头要求「星期X」或「周X」
    function dayOfLabel(value, bare) {
        var text = clean(value);
        if (bare) return dayOfChar(text);
        var m = HEADER_DAY.exec(text);
        return m ? dayOfChar(m[1]) : 0;
    }

    // ---- 三个下拉框与请求是否对得上 -----------------------------------------------------
    function selectOfData(name) {
        return data.selects && data.selects[name] ? data.selects[name] : null;
    }

    function optionLabel(select, value) {
        for (var i = 0; i < select.options.length; i++) {
            if (select.options[i].value === value) return clean(select.options[i].label);
        }
        return '';
    }

    if (data.loginForm === true || data.loginTitle === true) {
        throw new Error('当前页面不是课表，' + LOGIN_TEXT);
    }
    var semesterSel = selectOfData('xnxq01id');
    var modeSel = selectOfData('kbjcmsid');
    var weekSel = selectOfData('zc');
    if (!semesterSel || !modeSel || !weekSel) {
        throw new Error('找不到学年学期、作息模式或周次的选项，可能停在外层框架、登录页或错误页面。' + LOGIN_TEXT);
    }
    var request = data.request || {};
    if (String(request.xnxq01id) !== semesterSel.selected ||
        String(request.kbjcmsid) !== modeSel.selected ||
        String(request.zc || '') !== weekSel.selected) {
        throw new Error('教务返回的课表与查询的学期、作息或周次对不上，请稍后重试');
    }

    // ---- 课表表格：必须恰好一张 -----------------------------------------------------------
    var tables = data.tables || [];
    if (tables.length !== 1) {
        throw new Error('没有找到唯一的正式周课表，不能当作空课表处理，请确认已打开「课表查询」页面');
    }
    var table = tables[0];

    // 表头：8 格，第 1 格不是星期，其余 7 格正好是星期一到星期日各一次，没有合并
    var heads = table.head || [];
    var days = [];
    for (var h = 0; h < heads.length; h++) {
        days.push(dayOfLabel(heads[h].text, false));
    }
    var daySeen = {};
    var headerOk = heads.length === 8 && days[0] === 0;
    for (var hd = 1; headerOk && hd < 8; hd++) {
        if (!days[hd] || daySeen[days[hd]]) headerOk = false;
        daySeen[days[hd]] = true;
    }
    if (!headerOk) {
        throw new Error('课表表头和预期不一样：必须能明确认出星期一至星期日');
    }
    for (var hm = 0; hm < heads.length; hm++) {
        if (heads[hm].colSpan !== 1 || heads[hm].rowSpan !== 1) {
            throw new Error('课表表头有合并的格子，暂时不支持，请把课表截图反馈给空课');
        }
    }

    var rows = table.body || [];
    if (!rows.length) {
        throw new Error('课表里没有节次行，无法识别');
    }

    // 网格（上游 parseDocument）：按 rowSpan / colSpan 占位还原 8 列；越界、重叠、某行不满 8 列都报错，不猜星期
    var grid = [];
    for (var gr = 0; gr < rows.length; gr++) {
        var line = [];
        for (var gc = 0; gc < 8; gc++) line.push(null);
        grid.push(line);
    }
    var teaching = [];
    var allSections = {};
    var sectionRows = {};
    var repeatedSection = false;
    var tableMaxSection = 0;
    var cells = [];
    for (var r = 0; r < rows.length; r++) {
        var column = 0;
        var rowCells = rows[r] || [];
        for (var k = 0; k < rowCells.length; k++) {
            var cell = rowCells[k];
            while (column < 8 && grid[r][column]) column++;
            var height = cell.rowSpan;
            var width = cell.colSpan;
            if (height < 1 || r + height > rows.length || column + width > 8) {
                throw new Error('课表格子的跨行或跨列对不上，无法还原课表，请把课表截图反馈给空课');
            }
            for (var rr = r; rr < r + height; rr++) {
                for (var cc = column; cc < column + width; cc++) {
                    if (grid[rr][cc]) throw new Error('课表格子互相重叠，无法还原课表，请把课表截图反馈给空课');
                    grid[rr][cc] = cell;
                }
            }
            if (column === 0) {
                if (cell.name !== 'timeTd' || width !== 1 || height !== 1) {
                    throw new Error('节次标签的结构变了，无法识别');
                }
                var sectionMatch = ROW_SECTIONS.exec(clean(cell.text));
                var sections = sectionMatch ? numbersOf(sectionMatch[1], SECTION_LIMIT) : null;
                if (!sections) throw new Error('无法读取节次行里的小节编号，请把课表截图反馈给空课');
                for (var si = 0; si < sections.length; si++) {
                    if (sectionRows[sections[si]] !== undefined && sectionRows[sections[si]] !== r) repeatedSection = true;
                    sectionRows[sections[si]] = r;
                    allSections[sections[si]] = true;
                    if (sections[si] > tableMaxSection) tableMaxSection = sections[si];
                }
                var clock = ROW_CLOCK.exec(clean(cell.text));
                teaching.push({
                    sections: sections,
                    startTime: clock ? clock[1] : null,
                    endTime: clock ? clock[2] : null
                });
            } else {
                if (cell.name !== 'kbDataTd' || width !== 1) {
                    throw new Error('课程格子的结构变了，无法识别，请把课表截图反馈给空课');
                }
                cells.push({ day: days[column], lists: cell.lists || [] });
            }
            column += width;
        }
        var filled = 0;
        for (var fc = 0; fc < 8; fc++) {
            if (grid[r][fc]) filled++;
        }
        if (filled !== 8) {
            throw new Error('有一行课表不完整，无法判断每节课在星期几，请把课表截图反馈给空课');
        }
    }

    // ---- 节次时间：由每大节的行标签推出 --------------------------------------------------
    // 一行（大节）有 n 个小节、起止 S~E：n=1 时这一节就是 S–E；n≥2 时每节 p = floor((E−S−5×(n−1))/n) 分钟，
    // 第 i 节（从 0 数）开始 S + i×(p+5)，结束开始 + p，最后一节的结束改成 E。
    // 推不出来（时间没写、小节号重复、不连续覆盖 1..最大节、p < 20）整张不交，返回 null。
    function periodTimesOf(blocks) {
        var owner = {};
        var max = 0;
        var b;
        for (b = 0; b < blocks.length; b++) {
            for (var s = 0; s < blocks[b].sections.length; s++) {
                var sec = blocks[b].sections[s];
                if (owner[sec]) return null;
                owner[sec] = true;
                if (sec > max) max = sec;
            }
        }
        for (var n = 1; n <= max; n++) {
            if (!owner[n]) return null;
        }
        var out = [];
        for (b = 0; b < blocks.length; b++) {
            var block = blocks[b];
            if (!block.startTime || !block.endTime) return null;
            var start = clockMinutes(block.startTime);
            var end = clockMinutes(block.endTime);
            if (start < 0 || end < 0 || end <= start) return null;
            var count = block.sections.length;
            var each = Math.floor((end - start - BREAK_MINUTES * (count - 1)) / count);
            if (count > 1 && each < MIN_SLOT_MINUTES) return null;
            for (var i = 0; i < count; i++) {
                var slotStart = start + i * (each + BREAK_MINUTES);
                var slotEnd = i === count - 1 ? end : slotStart + each;
                if (slotEnd <= slotStart) return null;
                out.push({ periodIndex: block.sections[i], start: clockText(slotStart), end: clockText(slotEnd) });
            }
        }
        out.sort(function (x, y) { return x.periodIndex - y.periodIndex; });
        return out;
    }

    var periodTimes = repeatedSection ? null : periodTimesOf(teaching);
    var hasSplitRow = false;
    for (var tb = 0; tb < teaching.length; tb++) {
        if (teaching[tb].sections.length > 1) hasSplitRow = true;
    }
    // 推不出来、且课表最大节次 ≤12：整张不交（应用用默认节次，提醒见下面）。
    // 推不出来、且课表最大节次 >12：交出内置 12 节，第 13 节起顺推补上；越过 23:59 就停，停下的节次写进提醒。
    var defaultUsed = false;
    var fillFrom = 0;
    var fillTo = 0;
    var uncoveredFrom = 0;
    if (!periodTimes && tableMaxSection > DEFAULT_SLOT_COUNT) {
        defaultUsed = true;
        periodTimes = [];
        for (var bp = 0; bp < BUILTIN_PERIOD_TIMES.length; bp++) {
            periodTimes.push({ periodIndex: bp + 1, start: BUILTIN_PERIOD_TIMES[bp].start, end: BUILTIN_PERIOD_TIMES[bp].end });
        }
        for (var fp = DEFAULT_SLOT_COUNT + 1; fp <= tableMaxSection; fp++) {
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
    }

    // ---- 课程卡片 ------------------------------------------------------------------------
    // 每张卡：课名与「老师:…;时间:…;地点:…」读不出 → 跳过；时间串认不出 / 单双矛盾 / 没有有效周次 / 节次不在作息表里 → 跳过。
    var records = [];
    var recordSeen = {};
    for (var ci = 0; ci < cells.length; ci++) {
        var lists = cells[ci].lists;
        if (lists.length !== 1) {
            throw new Error('课程格子里的课程列表个数不对，无法识别，请把课表截图反馈给空课');
        }
        var items = lists[0].items || [];
        for (var ii = 0; ii < items.length; ii++) {
            if (!items[ii].course) {
                throw new Error('课程格子里出现了不认识的课程卡片结构，请把课表截图反馈给空课');
            }
        }
        var declared = lists[0].size;
        if (declared !== null && declared !== undefined &&
            (!COUNT_TEXT.test(String(declared)) || Number(declared) !== items.length)) {
            throw new Error('教务页面标的课程数与卡片数对不上，无法识别，请把课表截图反馈给空课');
        }
        for (var cj = 0; cj < items.length; cj++) {
            var name = clean(items[cj].title);
            var fields = CARD_FIELDS.exec(clean(items[cj].abbr));
            if (!name || !fields) {
                noNameBlocks++;
                noteDropped(name, '', '课名或老师、时间、地点没认出来');
                continue;
            }
            var teacher = clean(fields[1]) || null;
            var position = clean(fields[3]) || null;
            var parsed = timeOf(fields[2]);
            if (parsed.error === 'time') {
                noTimeBlocks++;
                noteDropped(name, teacher, '周次或节次的写法没认出来');
                continue;
            }
            if (parsed.error === 'parity') {
                parityBlocks++;
                noteDropped(name, teacher, '单双周标记自相矛盾');
                continue;
            }
            if (parsed.error === 'week') {
                noWeekBlocks++;
                noteDropped(name, teacher, '没有有效周次');
                continue;
            }
            var outside = false;
            for (var ro = 0; ro < parsed.ranges.length; ro++) {
                for (var so = parsed.ranges[ro][0]; so <= parsed.ranges[ro][1]; so++) {
                    if (!allSections[so]) outside = true;
                }
            }
            if (outside) {
                sectionOutBlocks++;
                noteDropped(name, teacher, '节次不在本作息模式的行标签里');
                continue;
            }
            droppedWeeks += parsed.over;
            for (var rg = 0; rg < parsed.ranges.length; rg++) {
                var start2 = parsed.ranges[rg][0];
                var end2 = parsed.ranges[rg][1];
                var record = {
                    name: name,
                    teacher: teacher,
                    position: position,
                    day: cells[ci].day,
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

    // ---- 同课合并（上游 mergeCourses）：同名、同老师、同地点、同星期，先按周拆开，每周内合并相邻或重叠的节次，
    //      再把节次相同的周收拢，最后每组周次切成极大段。
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
        var skippedAll = noNameBlocks + noTimeBlocks + parityBlocks + noWeekBlocks + sectionOutBlocks;
        if (skippedAll > 0) {
            throw new Error(clipText('本学期没有解析到任何课程：课表里的 ' + skippedAll +
                ' 个上课安排都没能认出来（周次或节次的写法不认识、单双周自相矛盾，或节次不在作息表里）。' +
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

    // ---- 教学周历：开学日期与学期总周数（照模板 yssdufe）--------------------------------
    // 周历的表头是**单字**（日一二三四五六），表头认不出就不取开学日期 —— 按位置猜的话，开学日期会错一整周。
    function calendarRowsOf(raw) {
        var out = [];
        var carry = [];
        for (var r2 = 0; r2 < raw.length; r2++) {
            var occupied = {};
            for (var c2 = 0; c2 < carry.length; c2++) {
                if (carry[c2] > 0) {
                    occupied[c2] = true;
                    carry[c2] = carry[c2] - 1;
                }
            }
            var row = [];
            var col = 0;
            for (var k2 = 0; k2 < raw[r2].length; k2++) {
                while (occupied[col]) col++;
                var c3 = raw[r2][k2];
                row.push({ col: col, text: clean(c3.text), title: clean(c3.title) });
                if (c3.rowSpan > 1) {
                    for (var s2 = 0; s2 < c3.colSpan; s2++) carry[col + s2] = c3.rowSpan - 1;
                }
                col += c3.colSpan;
            }
            out.push(row);
        }
        return out;
    }

    var calendarRows = data.calendar && data.calendar.rows ? calendarRowsOf(data.calendar.rows) : [];

    function calendarHeaderCols() {
        var best = null;
        var bestLabels = 0;
        for (var r3 = 0; r3 < calendarRows.length; r3++) {
            var cols = [0, -1, -1, -1, -1, -1, -1, -1];
            var labels = 0;
            for (var c4 = 0; c4 < calendarRows[r3].length; c4++) {
                var day = dayOfLabel(calendarRows[r3][c4].text, true);
                if (day < 1 || day > 7 || cols[day] >= 0) continue;
                cols[day] = calendarRows[r3][c4].col;
                labels++;
            }
            if (labels > bestLabels) {
                bestLabels = labels;
                best = cols;
            }
        }
        return bestLabels >= 4 ? best : null;
    }

    function firstCellOf(row) {
        var first = null;
        for (var k3 = 0; k3 < row.length; k3++) {
            if (!first || row[k3].col < first.col) first = row[k3];
        }
        return first;
    }

    function cellAtCol(row, col) {
        for (var k4 = 0; k4 < row.length; k4++) {
            if (row[k4].col === col) return row[k4];
        }
        return null;
    }

    // 第 1 周那一行的「星期一」格里的日期
    function calendarFirstMonday(cols) {
        if (!cols || cols[1] < 0) return null;
        for (var r4 = 0; r4 < calendarRows.length; r4++) {
            var row = calendarRows[r4];
            var first = firstCellOf(row);
            if (!first || !/^第?\s*1\s*周?$/.test(clean(first.text))) continue;
            var cell = cellAtCol(row, cols[1]);
            if (!cell) continue;
            var iso = isoOfCnDate(cell.title) || isoOfCnDate(cell.text);
            if (iso) return iso;
        }
        return null;
    }

    // 备选口径：按行序取第一个带日期的格子
    function calendarFirstTitled() {
        for (var r5 = 0; r5 < calendarRows.length; r5++) {
            for (var c5 = 0; c5 < calendarRows[r5].length; c5++) {
                var iso = isoOfCnDate(calendarRows[r5][c5].title);
                if (iso) return iso;
            }
        }
        return null;
    }

    // 备选口径的日期 → 周一：周历按「日一二…六」排时，第一个带日期的格子常是星期日，那就取它后面一天
    function mondayFromTitled(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (day.getDay() === 0) return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1));
        return mondayOf(iso);
    }

    // 周历里每行第一个格子的纯数字周号的最大值
    function calendarWeekCount() {
        var max = 0;
        for (var r6 = 0; r6 < calendarRows.length; r6++) {
            var first = firstCellOf(calendarRows[r6]);
            if (!first) continue;
            var number = /^(\d{1,3})$/.exec(clean(first.text));
            if (!number) continue;
            var value = parseInt(number[1], 10);
            if (value > max) max = value;
        }
        return max;
    }

    var calendarWeeks = calendarWeekCount();
    var zcMax = 0;
    for (var zi = 0; zi < weekSel.options.length; zi++) {
        var zv = clean(weekSel.options[zi].value);
        if (/^\d{1,2}$/.test(zv) && parseInt(zv, 10) > zcMax) zcMax = parseInt(zv, 10);
    }

    // 总周数：周历给出的周数优先；周历没有就看周次下拉框的最大周次，再没有按课表最大周次，最后才是兜底的 20 周。
    // 课表里有更晚的周次就抬高到它（不然那一块的结束周会超出总周数，载荷会被拒收）。
    var baseWeeks = calendarWeeks > 0 ? calendarWeeks :
        (zcMax > 0 ? zcMax : (maxWeek > 0 ? maxWeek : FALLBACK_TOTAL_WEEKS));
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    // 开学日期的取法（依次）：① 周历第 1 周的星期一格（真实值）；② 周历里第一个带日期的格子，对齐到周一；
    // ③ 都没有，按提取时刻推算最近的周一。②③ 必须说明：推算值和真值在库里长得一模一样。
    var firstDay = calendarFirstMonday(calendarHeaderCols());
    var titledDay = firstDay ? null : calendarFirstTitled();
    if (firstDay) {
        var aligned = mondayOf(firstDay);
        if (aligned && aligned !== firstDay) {
            pushWarning('教务的教学周历里第 1 周的星期一写的是 ' + firstDay + '（那天不是星期一），开学日期已按它所在那一周的周一（' +
                aligned + '）对齐，请在「学期管理」里核对');
            firstDay = aligned;
        }
    } else if (titledDay) {
        firstDay = mondayFromTitled(titledDay);
        if (firstDay !== titledDay) {
            pushWarning('教务的教学周历没有标出第 1 周的星期一，开学日期已由第一个日期格（' + titledDay +
                '）对齐为周一（' + firstDay + '），请在「学期管理」里核对');
        }
    } else {
        firstDay = mondayOf(data.now);
        if (!firstDay) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
        pushWarning('开学日期无法从教务获取（教学周历没有取到），已按最近的周一（' + firstDay + '）推算，请在「学期管理」里核对');
    }

    // ---- 学期名：教务给的学年学期文字 → 学期代码拼出的名字 → 都没有才用占位并提醒 ----------------
    var termCode = clean(semesterSel.selected);
    var termLabel = optionLabel(semesterSel, semesterSel.selected);
    var termName = '';
    if (termLabel && TERM_CODE.test(termLabel)) termName = termNameFromCode(termLabel);
    else if (termLabel) termName = termLabel;
    if (!termName && TERM_CODE.test(termCode)) termName = termNameFromCode(termCode);
    if (!termName) {
        termName = SCHOOL_NAME + '当前学期';
        pushWarning('没能识别出学年学期的名字，学期名已用「' + termName + '」占位，请在「学期管理」里改名');
    }

    // ---- 作息模式、备注、节次时间、周次等提醒 -----------------------------------------------
    var modeLabel = optionLabel(modeSel, modeSel.selected);
    if (modeLabel !== MODE_NAME) {
        pushWarning('教务的作息模式里没有「' + MODE_NAME + '」，已改用当前选中的「' + modeLabel +
            '」，节次时间请在「学期管理」里核对');
    }

    var remarks = [];
    var foot = table.foot || [];
    for (var fi = 0; fi < foot.length; fi++) {
        if (clean(foot[fi])) remarks.push(clean(foot[fi]));
    }
    if (remarks.length) {
        var sample = remarks.slice(0, 3).map(function (text) { return '「' + text + '」'; }).join('、');
        pushWarning('教务课表里有 ' + remarks.length + ' 项备注没排具体星期和节次（如' + sample +
            '），这些内容没有导入，请在教务系统里查看');
    }

    if (defaultUsed) {
        pushWarning('教务课表的节次时间没能读全，第 1–' + DEFAULT_SLOT_COUNT +
            ' 节改用空课默认的节次时间（不是教务给的），请在「学期管理」里核对上下课时间');
        if (fillTo > 0) {
            pushWarning('课表用到了第 ' + (fillFrom === fillTo ? String(fillFrom) : fillFrom + '–' + fillTo) +
                ' 节，这几节没有时间，已按第 ' + DEFAULT_SLOT_COUNT + ' 节下课后课间 5 分钟、每节 45 分钟顺推补上，请在「学期管理」里核对');
        }
        if (uncoveredFrom > 0) {
            pushWarning('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
                '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
        }
    } else if (periodTimes) {
        if (hasSplitRow) pushWarning('每大节内的小节时间是按课间 5 分钟推算的，请在「学期管理」里核对');
    } else {
        pushWarning('教务课表的节次时间没能读全，节次时间没有导入，应用将按默认节次时间显示，请在「学期管理」里核对上下课时间');
    }

    if (calendarWeeks === 0) {
        var how = zcMax > 0 ? ('周次选项的最大值（' + zcMax + ' 周）') :
            (maxWeek > 0 ? ('课表里的最大周次（' + maxWeek + ' 周）') : (FALLBACK_TOTAL_WEEKS + ' 周'));
        pushWarning('教务没有给出学期总周数，已按' + how + '计，请在「学期管理」里核对');
    }
    if (wantedWeeks > MAX_WEEK) {
        pushWarning('学期总周数算出来是 ' + wantedWeeks + ' 周，超过了上限 ' + MAX_WEEK + ' 周，已按 ' + MAX_WEEK + ' 周计，请在「学期管理」里核对');
    } else if (totalWeeks > baseWeeks) {
        pushWarning('课表里有到第 ' + maxWeek + ' 周的课，比学期的 ' + baseWeeks + ' 周多，学期总周数已按 ' + totalWeeks +
            ' 周计，请在「学期管理」里核对');
    }
    if (droppedWeeks > 0) {
        pushWarning('有 ' + droppedWeeks + ' 个周次超出 ' + MAX_WEEK + ' 周，这些周次没有导入');
    }

    var skipped = noNameBlocks + noTimeBlocks + parityBlocks + noWeekBlocks + sectionOutBlocks;
    if (skipped > 0) {
        var skipParts = [];
        if (noNameBlocks) skipParts.push('课名或老师、时间、地点没认出 ' + noNameBlocks + ' 个');
        if (noTimeBlocks) skipParts.push('周次或节次写法没认出 ' + noTimeBlocks + ' 个');
        if (parityBlocks) skipParts.push('单双周标记自相矛盾 ' + parityBlocks + ' 个');
        if (noWeekBlocks) skipParts.push('没有有效周次 ' + noWeekBlocks + ' 个');
        if (sectionOutBlocks) skipParts.push('节次不在作息表里 ' + sectionOutBlocks + ' 个');
        pushWarning('有 ' + skipped + ' 个上课安排没能导入（' + skipParts.join('，') + '）。教务页面的写法可能有变化，欢迎反馈。' +
            droppedText());
    }

    var term = {
        name: termName,
        firstDay: firstDay,
        totalWeeks: totalWeeks,
        courses: courses
    };
    if (periodTimes) term.periodTimes = periodTimes;

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finalWarnings(),
        terms: [term]
    });
})()
