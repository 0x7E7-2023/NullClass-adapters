(function () {
    // 南京师范大学教务适配器（金智教育 jwapp / wdkb「我的课表」）—— 原始数据 → 空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 NJNU/njnu.js（MIT，上游维护者 aryunm）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：19a65bf（2026-10-19），本校脚本最后一次修改 80e30cf
    //
    // 这一段是纯转换（不碰 DOM、不发请求、不读挂钟时间），所以能在 CI 里用 Rhino 跑回归。
    // 「今天」由 extract.js 交进来（data.today），开学日的推算只看它，fixture 因此可以复现。
    // 移植过来的核心逻辑：
    //   ① SKZC「0/1 位串」→ 周次数组（上游 parseWeeksFromSkzc）；
    //   ② 单行课表 → 课程（上游 parseSingleCourse：教师取 SKJS 的第一段、节次直接用 KSJC / JSJC）；
    //   ③ 调课 / 停课记录应用到课表上（上游 applyCourseChanges）：按 KBID + 星期 + 起止节次找到原课，
    //      把记录里的 SKZC 周次从原课里减掉；调课类型（TKLXDM 为 01 或 03）且给了新周次 / 星期 / 节次时，
    //      另排一门新课（教师、教室缺了就沿用调课前的：先记录里的原教师 / 原教室，再退到被调的那门课）。
    //      记录按教务给的顺序逐条应用，后面的记录可以匹配前面新排出来的课，与上游一致；
    //   ④ 节次时间：上游 importPresetTimeSlots 写死的 12 节表。
    //
    // 移植改动（与上游的语义差异，逐条说明见 AUDIT.md）：
    //   ① 周次：上游发逐周数组，这里切成极大段（ALL / ODD / EVEN），落单的一周记为 ALL。
    //   ② 教师 / 教室：上游教师缺了写空串、教室缺了写「待定」；这里一律留 null，不写占位词。
    //      教师多名时上游只留第一个，这里全留（按斜杠、顿号、逗号、分号拆开，含数字的片段是工号，丢掉，去重后用「、」连接）。
    //   ③ 学年学期：上游弹窗让用户填；这里用 extract.js 读到的教务当前学期，读不到按本机日期推算并写进提醒。
    //   ④ 总周数：上游写死 20；这里优先用教务校历的总周数 ZZC，没有再用 20，课表里有更晚的周次就抬高，都写进提醒。
    //   ⑤ 开学日：上游取不到只弹提示、留空；这里按「今天所在周的周一」推算并写进提醒；教务给的开学日不是周一时对齐到周一并说明。
    //   ⑥ 不静默丢课：缺课名 / 星期 / 节次 / 周次、周次编码不是位串、对不上原课的调课记录，都分类计数写进提醒。
    //   ⑦ 节次超出 12 节：按「统一修订 H3」逐节顺推补时间并说明；顺推越过 23:59 的不补，课照常导入。
    //   ⑧ 上游的弹窗、提示、保存课程 / 配置 / 节次时间的桥调用全部不移植，宿主负责保存。
    //
    // 输入（extract.js 交出来的教务原始数据）：
    //   { term: { code, name, source }, today: 'yyyy-MM-dd',
    //     rows: [ 课表行 ], changeRows: [ 调课记录 ] 或 null（没取到）, calendarRows: [ 校历行 ] }
    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var rows = data.rows || [];
    var term = data.term || {};
    var calendarRows = data.calendarRows || [];
    var changeRows = Object.prototype.toString.call(data.changeRows) === '[object Array]' ? data.changeRows : null;

    var SCHOOL_NAME = '南京师范大学';  // 学期名兜底用（不用适配器名）
    var MAX_WEEKS = 30;               // 载荷校验要求 totalWeeks ∈ 1..30（规范 §4）
    var DEFAULT_TOTAL_WEEKS = 20;     // 上游 semesterTotalWeeks 写死的 20，校历没给总周数时用
    var MAX_PERIOD = 20;              // 单日节次上限：超过它一定是脏数据
    var MAX_WARNINGS = 20;            // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;       // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;         // 提醒里点名的课名最多显示的字数
    var NAME_SAMPLES = 3;             // 提醒里最多点几个课名
    var EXTEND_BREAK_MINUTES = 5;     // 补节次时间：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45;    // 补节次时间：每节几分钟

    // 本校节次时间（12 节），取自上游 importPresetTimeSlots 的写死表，逐节照抄
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:40' },
        { periodIndex: 2, start: '08:45', end: '09:25' },
        { periodIndex: 3, start: '09:40', end: '10:20' },
        { periodIndex: 4, start: '10:35', end: '11:15' },
        { periodIndex: 5, start: '11:20', end: '12:00' },
        { periodIndex: 6, start: '13:30', end: '14:10' },
        { periodIndex: 7, start: '14:15', end: '14:55' },
        { periodIndex: 8, start: '15:10', end: '15:50' },
        { periodIndex: 9, start: '15:55', end: '16:35' },
        { periodIndex: 10, start: '18:30', end: '19:10' },
        { periodIndex: 11, start: '19:20', end: '20:00' },
        { periodIndex: 12, start: '20:10', end: '20:50' }
    ];

    // ---- 提醒：统一出口，限长限条数 -------------------------------------------

    var warnings = [];
    var omittedWarnings = 0;

    function pushWarning(message) {
        var one = String(message);
        if (one.length > MAX_WARNING_TEXT) one = one.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS - 1) {
            omittedWarnings++;
            return;
        }
        warnings.push(one);
    }

    // ---- 小工具 --------------------------------------------------------------

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 课名过长时截短，避免一个超长课名把整条提醒撑破上限（超了整包拒收）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    // 点名用的课名列表：最多 NAME_SAMPLES 个，各自截短，超出的用「等」
    function sampleText(names) {
        var shown = [];
        for (var i = 0; i < names.length && i < NAME_SAMPLES; i++) shown.push(shortName(names[i]));
        return shown.join('、') + (names.length > NAME_SAMPLES ? ' 等' : '');
    }

    function addSample(list, name) {
        var n = text(name);
        if (n && list.indexOf(n) < 0) list.push(n);
    }

    // 日期前缀 yyyy-MM-dd（后面允许跟时间，如 '2026-09-07 00:00:00'）→ 'yyyy-MM-dd'；形状不对返回 null
    function isoDayOf(value) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
        return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
    }

    // 'yyyy-MM-dd' → 该日期所在周的周一（周一原样返回）。
    // 非法日期（如 2026-02-31）返回 null，不悄悄顺延到下个月。
    function mondayOnOrBefore(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
            return null;
        }
        var offset = (date.getUTCDay() + 6) % 7;
        var monday = new Date(date.getTime() - offset * 86400000);
        return monday.getUTCFullYear() + '-' + pad2(monday.getUTCMonth() + 1) + '-' + pad2(monday.getUTCDate());
    }

    function isBits(bits) {
        return /^[01]+$/.test(bits);
    }

    // SKZC 位串：第 i 位（从 0 起）为 1 表示第 i+1 周。不是位串就返回空数组。
    function weeksFromBits(bits) {
        var weeks = [];
        if (!isBits(bits)) return weeks;
        for (var i = 0; i < bits.length; i++) {
            if (bits.charAt(i) === '1') weeks.push(i + 1);
        }
        return weeks;
    }

    // 升序周次集合 → 极大段。步长 1 是每周（ALL）；步长 2 是单周或双周（ODD / EVEN，由起始周奇偶决定）；落单的一周记为 ALL。
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j] };
            if (run.start === run.end || step === 1) {
                run.weekType = 'ALL';
            } else {
                run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            }
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // 学期编号 2026-2027-1 → 「2026-2027学年第一学期」；形状不对返回 ''
    function termNameFrom(code) {
        var m = /^(\d{4})-(\d{4})-(\d{1,2})$/.exec(String(code));
        if (!m) return '';
        var index = parseInt(m[3], 10);
        var label = index === 1 ? '第一学期' : (index === 2 ? '第二学期' : '第' + index + '学期');
        return m[1] + '-' + m[2] + '学年' + label;
    }

    // 教师：多名用 / 、 , ， ; ； 分隔的，拆开后丢掉空片段与含数字的片段（教务 SKJS 常写成「姓名/工号」，工号不是教师），去重后以「、」连接；拿不到就是 null
    function teacherOf(raw) {
        var names = [];
        text(raw).split(/[\/、,，;；]/).forEach(function (part) {
            var name = text(part);
            if (!name || /\d/.test(name)) return;
            if (names.indexOf(name) < 0) names.push(name);
        });
        return names.length ? names.join('、') : null;
    }

    // 校历：按学期编号拆出 XN、XQ，找对得上的那一行；教务没回 XN / XQ 时照上游口径取第一行；其余情况按没有校历处理
    function calendarRowOf(list, code) {
        var parts = code.split('-');
        if (parts.length < 3) return null;
        var xn = parts[0] + '-' + parts[1];
        for (var i = 0; i < list.length; i++) {
            if (text(list[i].XN) === xn && intOf(list[i].XQ) === intOf(parts[2])) return list[i];
        }
        if (list.length && !text(list[0].XN) && !text(list[0].XQ)) return list[0];
        return null;
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
    }

    // 节次号（已升序）写成「第 13-15 节」「第 13 节」「第 13、15-16 节」这几种
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

    // ---- 逐行转换课表 --------------------------------------------------------

    // item = 一次上课安排：{ name, teacher, location, day, start, end, weeks[], kbId }
    var items = [];
    var skipped = 0;       // 缺课名 / 星期 / 节次 / 周次
    var badBits = 0;       // 周次编码不是 0/1 位串
    var droppedWeeks = 0;  // 超出 30 周的周次

    // 周次去掉超出上限的部分并计数
    function capWeeks(weeks) {
        var kept = [];
        for (var w = 0; w < weeks.length; w++) {
            if (weeks[w] <= MAX_WEEKS) kept.push(weeks[w]);
            else droppedWeeks++;
        }
        return kept;
    }

    function validSlot(day, start, end) {
        return day >= 1 && day <= 7 && start >= 1 && end >= start && end <= MAX_PERIOD;
    }

    for (var i = 0; i < rows.length; i++) {
        var row = rows[i] || {};
        var name = text(row.KCM);
        var bits = text(row.SKZC);

        // 课名、星期、周次都空的占位行不是「被丢掉的课」，不计入跳过数
        if (!name && !bits && !text(row.SKXQ)) continue;

        var day = intOf(row.SKXQ);
        var startPeriod = intOf(row.KSJC);
        var endPeriod = intOf(row.JSJC);
        if (!name || !validSlot(day, startPeriod, endPeriod)) { skipped++; continue; }
        if (bits && !isBits(bits)) { badBits++; continue; }
        var rawWeeks = weeksFromBits(bits);
        if (!rawWeeks.length) { skipped++; continue; }

        var weeks = capWeeks(rawWeeks);
        if (!weeks.length) continue;

        items.push({
            name: name,
            teacher: teacherOf(row.SKJS),
            location: text(row.JASMC) || null,
            day: day,
            start: startPeriod,
            end: endPeriod,
            weeks: weeks,
            kbId: text(row.KBID)
        });
    }

    // ---- 应用调课 / 停课记录 --------------------------------------------------

    var appliedChanges = 0;     // 真正改了课表的记录数
    var unmatchedChanges = 0;   // 找不到原课的记录数
    var unmatchedNames = [];
    var unplacedChanges = 0;    // 调课类型但没给完整新时间：只停了原课，没排新课
    var badChangeBits = 0;      // 记录里的周次编码不是位串
    var inheritedChanges = 0;   // 新教师或新教室没给，沿用了调课前的

    function isMoveType(code) {
        return code === '01' || code === '03';
    }

    function applyChange(change) {
        var kbId = text(change.KBID);
        var day = intOf(change.SKXQ);
        var start = intOf(change.KSJC);
        var end = intOf(change.JSJC);

        var matched = [];
        if (kbId) {
            for (var m = 0; m < items.length; m++) {
                if (items[m].kbId === kbId && items[m].day === day && items[m].start === start && items[m].end === end) {
                    matched.push(items[m]);
                }
            }
        }
        // 与上游一致：找不到原课的记录整条不处理（包括新排的那一段）；只是不静默，计数写进提醒
        if (!matched.length) {
            unmatchedChanges++;
            addSample(unmatchedNames, change.KCM);
            return;
        }

        var applied = false;
        var removeBits = text(change.SKZC);
        if (removeBits && !isBits(removeBits)) badChangeBits++;
        var removeWeeks = weeksFromBits(removeBits);
        if (removeWeeks.length) {
            for (var k = 0; k < matched.length; k++) {
                var before = matched[k].weeks.length;
                matched[k].weeks = matched[k].weeks.filter(function (w) {
                    return removeWeeks.indexOf(w) < 0;
                });
                if (matched[k].weeks.length < before) applied = true;
            }
        }

        if (isMoveType(text(change.TKLXDM))) {
            var newBits = text(change.XSKZC);
            if (newBits && !isBits(newBits)) badChangeBits++;
            var newWeeks = capWeeks(weeksFromBits(newBits));
            var newDay = intOf(change.XSKXQ);
            var newStart = intOf(change.XKSJC);
            var newEnd = intOf(change.XJSJC);
            if (newWeeks.length && validSlot(newDay, newStart, newEnd)) {
                var newTeacher = teacherOf(change.XSKJS);
                var newRoom = text(change.XJASMC);
                if (!newTeacher || !newRoom) inheritedChanges++;
                items.push({
                    name: text(change.KCM) || matched[0].name,
                    teacher: newTeacher || teacherOf(change.YSKJS) || matched[0].teacher,
                    location: newRoom || text(change.JASMC) || matched[0].location,
                    day: newDay,
                    start: newStart,
                    end: newEnd,
                    weeks: newWeeks,
                    kbId: kbId
                });
                applied = true;
            } else {
                unplacedChanges++;
            }
        }
        if (applied) appliedChanges++;
    }

    if (changeRows) {
        for (var c = 0; c < changeRows.length; c++) applyChange(changeRows[c] || {});
    }
    items = items.filter(function (item) {
        return item.weeks.length > 0;
    });

    if (items.length === 0) {
        throw new Error('没有解析到任何课程' + (droppedWeeks > 0
            ? '：课表里的周次都超过了第 ' + MAX_WEEKS + ' 周（应用最多支持 ' + MAX_WEEKS + ' 周）'
            : (text(term.source) === 'guess'
                ? '：当前学期是按本机日期推算的，可能不是本学期，请在教务页面确认课表已经显示出来，再重新提取'
                : '：可能是这个学期还没排课，请在教务页面确认课表已经显示出来，再重新提取')));
    }

    // ---- 拼课程与时间块 ------------------------------------------------------

    var order = [];
    var byCourse = {};
    var maxWeek = 0;
    var maxPeriod = 0;
    var missingTeacherNames = [];
    var missingLocationNames = [];

    for (var n = 0; n < items.length; n++) {
        var item = items[n];
        var key = JSON.stringify([item.name, item.teacher || '']);
        if (!byCourse[key]) {
            byCourse[key] = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            order.push(key);
        }
        if (item.end > maxPeriod) maxPeriod = item.end;
        if (!item.teacher) addSample(missingTeacherNames, item.name);
        if (!item.location) addSample(missingLocationNames, item.name);

        var runs = runsOf(item.weeks);
        for (var r = 0; r < runs.length; r++) {
            if (runs[r].end > maxWeek) maxWeek = runs[r].end;
            byCourse[key].blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: runs[r].start,
                endWeek: runs[r].end,
                weekType: runs[r].weekType,
                location: item.location
            });
        }
    }

    // ---- 学期与开学日 --------------------------------------------------------

    var code = text(term.code);
    var termLabel = termNameFrom(code);
    var termGuessed = text(term.source) === 'guess';

    var calendarRow = calendarRowOf(calendarRows, code);
    var rawFirstDay = calendarRow ? isoDayOf(calendarRow.XQKSRQ) : null;
    var firstDay = mondayOnOrBefore(rawFirstDay);
    var firstDayGuessed = false;
    var firstDayShifted = false;
    if (!firstDay) {
        firstDay = mondayOnOrBefore(text(data.today));
        if (!firstDay) throw new Error('没能确定开学日期：教务没有给出，本机日期也不合法');
        firstDayGuessed = true;
    } else if (firstDay !== rawFirstDay) {
        firstDayShifted = true;
    }

    // ---- 总周数 --------------------------------------------------------------

    var calendarWeeks = calendarRow ? intOf(calendarRow.ZZC) : null;
    if (calendarWeeks !== null && calendarWeeks < 1) calendarWeeks = null;
    var totalWeeks = calendarWeeks !== null ? calendarWeeks : DEFAULT_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (totalWeeks < maxWeek) {
        totalWeeks = maxWeek;
        raisedBySchedule = true;
    }
    var clamped = false;
    if (totalWeeks > MAX_WEEKS) {
        totalWeeks = MAX_WEEKS;
        clamped = true;
    }

    // ---- 节次时间：12 节写死表；课表用到更晚的节次时逐节顺推补（统一修订 H3） ----

    var periodTimes = PERIOD_TIMES.slice(0);
    var tableLength = periodTimes.length;
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = tableLength + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        var nextStart = minutesOf(prev.end) + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        // 顺推越过 23:59 就停，这一节起不再补（课照常导入）
        if (nextEnd > 23 * 60 + 59) {
            uncoveredFrom = p;
            break;
        }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---- warnings（顺序固定：学期、开学日、总周数、调课、节次、丢弃、缺项）----

    if (termGuessed) {
        pushWarning('没能从教务获取当前学期，已按本机日期推算为 ' + (termLabel || code) + '，请核对导入的是不是本学期');
    }
    if (firstDayGuessed) {
        pushWarning('没能从教务取到开学日期，已按本机日期推算为 ' + firstDay + '（当前周的周一），请在学期管理里核对');
    } else if (firstDayShifted) {
        pushWarning('教务给的开学日期 ' + rawFirstDay + ' 不是周一，第 1 周已按所在周的周一 ' + firstDay + ' 计算，请在学期管理里核对');
    }
    if (calendarWeeks === null) {
        pushWarning('教务没有给出学期总周数，' + (raisedBySchedule
            ? '课表里有第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks + ' 周导入'
            : '已按 ' + totalWeeks + ' 周导入') + '，如与实际不符可在学期管理里改');
    } else if (raisedBySchedule) {
        pushWarning('教务给的学期总周数是 ' + calendarWeeks + ' 周，课表里有第 ' + maxWeek + ' 周的课，已按 ' +
            totalWeeks + ' 周导入，请在学期管理里核对');
    }
    if (clamped) {
        pushWarning('学期总周数超过了 ' + MAX_WEEKS + ' 周，已按 ' + MAX_WEEKS + ' 周导入，请在学期管理里核对');
    }

    if (changeRows === null) {
        pushWarning('没能取到教务的调课、停课记录，课表按原定排课导入，近期的调课、停课可能没有体现，请对照教务系统核对');
    } else if (appliedChanges > 0) {
        pushWarning('已按教务的调课、停课记录调整课表（共 ' + appliedChanges + ' 条），请核对调课后的上课时间');
    }
    if (unmatchedChanges > 0) {
        pushWarning('有 ' + unmatchedChanges + ' 条调课、停课记录对不上课表里的原课（例如 ' + sampleText(unmatchedNames) +
            '），没有应用，请对照教务系统核对');
    }
    if (unplacedChanges > 0) {
        pushWarning('有 ' + unplacedChanges + ' 条调课记录没给出完整的新上课时间，只停掉了原来的课，没有排新课，请对照教务系统核对');
    }
    if (inheritedChanges > 0) {
        pushWarning('有 ' + inheritedChanges + ' 条调课记录没给出新的教师或教室，已沿用调课前的，请核对');
    }
    if (badChangeBits > 0) {
        pushWarning('有 ' + badChangeBits + ' 处调课记录的周次格式认不出，相关部分没有应用，请对照教务系统核对');
    }

    if (bySequence.length) {
        pushWarning('课表用到了' + sectionsText(bySequence) + '，学校公布的节次时间只有 ' + tableLength +
            ' 节，这几节已按上一节下课后课间 ' + EXTEND_BREAK_MINUTES + ' 分钟、每节 ' + EXTEND_CLASS_MINUTES +
            ' 分钟顺推补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        pushWarning('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    if (skipped > 0) {
        pushWarning('有 ' + skipped + ' 条排课记录缺少课名、星期、节次或周次（或节次超出第 ' + MAX_PERIOD + ' 节），没有导入');
    }
    if (badBits > 0) {
        pushWarning('有 ' + badBits + ' 条排课记录的周次格式认不出，没有导入，请对照教务系统核对');
    }
    if (droppedWeeks > 0) {
        pushWarning('有 ' + droppedWeeks + ' 个周次超过了第 ' + MAX_WEEKS + ' 周，超出的部分没有导入');
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），按类型汇总计数、点名限长，不静默
    if (missingTeacherNames.length > 0 || missingLocationNames.length > 0) {
        var parts = [];
        var samples = [];
        if (missingTeacherNames.length > 0) parts.push(missingTeacherNames.length + ' 门课没给上课教师');
        if (missingLocationNames.length > 0) parts.push(missingLocationNames.length + ' 门课没给上课地点');
        for (var s = 0; s < missingTeacherNames.length; s++) addSample(samples, missingTeacherNames[s]);
        for (var t = 0; t < missingLocationNames.length; t++) addSample(samples, missingLocationNames[t]);
        var emptyText = missingTeacherNames.length > 0 && missingLocationNames.length > 0
            ? '教师或地点暂时空着'
            : (missingTeacherNames.length > 0 ? '教师暂时空着' : '上课地点暂时空着');
        pushWarning('有 ' + parts.join('、') + '（例如 ' + sampleText(samples) + '）：已照常导入，' + emptyText +
            '，可在「编辑课程」里补上');
    }
    if (omittedWarnings > 0) {
        warnings.push('还有 ' + omittedWarnings + ' 条提示没有显示（最多 ' + MAX_WARNINGS + ' 条）');
    }

    var courses = [];
    for (var o = 0; o < order.length; o++) courses.push(byCourse[order[o]]);

    var termName = text(term.name) || (termLabel ? SCHOOL_NAME + ' ' + termLabel : SCHOOL_NAME);

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [
            {
                name: termName,
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
