(function () {
    // 曲靖师范学院教务适配器（金智 jwapp / 我的课表 wdkb）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 QJNU/qjnu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 ZGxudQ）
    //   上游快照 f83288e，本校脚本最后一次修改 29fd297（2026-11-21）。
    // 输入是 extract.js 的 { term, today, calendarRows, sectionRows, rows, experimentRows, changeRows }：
    //   rows 是整学期课表；experimentRows、changeRows 取不到时为 null（写提醒，不阻断导入）。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   1. 上游的选学期弹窗、缺项确认框不移植：当前学期由 extract 读教务或按本机日期推定，缺项写进 warnings。
    //   2. 周次按金智位串 SKZC：第 1 位对应第 1 周；「全周」「全部」展开到 max(20, 全部行的最大周)；
    //      认不出的写法按原文分组提醒、不静默丢课；位串里的周超过第 30 周的部分丢弃并提醒。
    //   3. 调课记录照上游顺序应用（接口倒序返回，先应用较早的）；找不到原课、写法认不出、缺新课位都进提醒。
    //   4. 节次时间读教务 jc.do；为空或前后矛盾则用上游内置的默认表并提醒；表外节次按统一修订 H3 逐节顺推并提醒。
    //   5. 上游把「自定义上课时间」带进课表；这里按 §4.4 只按节次放入，与节次时间不同的课程在提醒里点名。
    //   6. 连堂合并条件用「下一段开始 <= 上一段结束 + 1」，完全重复的原始行先去重。
    //   7. 教师括号备注（外聘、研究生等）丢掉后再拆分；教师 / 教室占位词交 null；
    //      提醒里的教务原文统一截到 20 字，整条 200 字以内，全部提醒最多 20 条。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var regularRows = arrayOf(data.rows);
    var experimentRows = data.experimentRows instanceof Array ? data.experimentRows : null;
    var changeRows = data.changeRows instanceof Array ? data.changeRows : null;
    var calendarRows = arrayOf(data.calendarRows);
    var sectionRows = arrayOf(data.sectionRows);

    var SCHOOL = '曲靖师范学院';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var CLASS_MINUTES = 45;
    var BREAK_MINUTES = 5;
    var DAY_END_MINUTES = 23 * 60 + 59;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;
    var CHANGE_TYPES = ['01', '02', '03'];
    // 上游内置的默认节次时间（教务没给完整节次表时使用）。
    var DEFAULT_SECTIONS = [
        ['08:30', '09:15'], ['09:25', '10:10'], ['10:30', '11:15'], ['11:25', '12:10'], ['14:30', '15:15'],
        ['15:25', '16:10'], ['16:30', '17:15'], ['17:25', '18:10'], ['19:30', '20:15'], ['20:25', '21:10']
    ];
    var EMPTY_WORD = {
        '未知': true, '未知教师': true, '未知老师': true, '未知地点': true, '未知教室': true,
        '待定': true, '暂无': true, '暂无教师': true, '暂无老师': true, '暂无教室': true, '暂无地点': true
    };
    var BITMAP = /^[01]+$/;
    var WHOLE_TERM = /^全(部)?(周)?$/;

    function arrayOf(value) {
        return value instanceof Array ? value : [];
    }

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function shortName(value) {
        var line = text(value);
        return line.length > NAME_LIMIT ? line.substring(0, NAME_LIMIT - 1) + '…' : line;
    }

    function realOrNull(value) {
        var valueText = text(value);
        return !valueText || EMPTY_WORD[valueText] ? null : valueText;
    }

    function integerOf(value) {
        if (value === null || value === undefined || text(value) === '') return null;
        var number = Number(value);
        if (!isFinite(number) || Math.floor(number) !== number) return null;
        return number;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function utcOfIso(iso) {
        var match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(iso);
        if (!match) return null;
        var year = parseInt(match[1], 10);
        var month = parseInt(match[2], 10);
        var day = parseInt(match[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
        return date.getTime();
    }

    // 所在周的周一；与开学日锚点对齐，不做月份取整。
    function mondayOf(iso) {
        var milliseconds = utcOfIso(iso);
        if (milliseconds === null) return null;
        var offset = (new Date(milliseconds).getUTCDay() + 6) % 7;
        return isoOf(new Date(milliseconds - offset * 86400000));
    }

    // 'HH:mm' / 'H:mm' / 'HHmm' / 'HH:mm:ss' → 'HH:mm'；不合法返回 null
    function hhmmOf(value) {
        var match = /^([0-9]{1,2}):?([0-9]{2})(:[0-9]{2})?$/.exec(text(value));
        if (!match) return null;
        var hour = parseInt(match[1], 10);
        var minute = parseInt(match[2], 10);
        if (hour > 23 || minute > 59) return null;
        return pad2(hour) + ':' + pad2(minute);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function clockOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    function countKeys(dictionary) {
        var count = 0;
        for (var key in dictionary) {
            if (Object.prototype.hasOwnProperty.call(dictionary, key)) count++;
        }
        return count;
    }

    function compare(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    // 提醒：每条先截到 200 字；超过 20 条时保留前 19 条，最后一条写明另有几条没显示。
    var warnings = [];

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        warnings.push(line);
    }

    function limitedWarnings() {
        if (warnings.length <= MAX_WARNINGS) return warnings;
        var kept = warnings.slice(0, MAX_WARNINGS - 1);
        kept.push('另有 ' + (warnings.length - kept.length) + ' 条核对提示超出上限未显示');
        return kept;
    }

    function sampleList(list) {
        var shown = [];
        for (var i = 0; i < list.length && i < 3; i++) shown.push(shortName(list[i]));
        return shown.join('、');
    }

    function sectionsText(list) {
        var parts = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            parts.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + parts.join('、') + ' 节';
    }

    // 学期名：先用教务给的文本；没有就按学期编号拼学年学期，编号认不出才用「学校名 原文」。
    function termName() {
        var provided = text(term.name);
        if (provided) return provided;
        var match = /^([0-9]{4}-[0-9]{4})-([0-9]+)$/.exec(text(term.code));
        if (match) {
            var index = parseInt(match[2], 10);
            var label = index === 1 ? '第一学期' : (index === 2 ? '第二学期' : '第' + index + '学期');
            return match[1] + '学年' + label;
        }
        return text(SCHOOL + ' ' + text(term.code));
    }

    // 教师：去掉括号备注（外聘、研究生、实验等）后再拆；斜杠后面的部分不要。
    function teacherOf(value) {
        var cleaned = text(value).replace(/[（(][^）)]*[）)]/g, '');
        var parts = cleaned.split(/[,，、;；]/);
        var names = [];
        for (var i = 0; i < parts.length; i++) {
            var name = text(text(parts[i]).split('/')[0]);
            if (name) names.push(name);
        }
        return names.join('、');
    }

    function joinName(course, experiment) {
        var parts = [];
        if (text(course)) parts.push(text(course));
        if (text(experiment)) parts.push(text(experiment));
        return parts.join(' - ');
    }

    // 周次位串：只看位置是不是字符 1，第 1 位是第 1 周；「全周」「全部」展开到 allTo 周。
    // 返回 kind：bitmap / all / bad（认不出）/ empty（空串）。超过第 30 周的周计入 dropped。
    function weeksOf(value, allTo) {
        var source = text(value);
        var result = { kind: 'empty', weeks: [], dropped: 0 };
        if (!source) return result;
        var i;
        if (BITMAP.test(source)) {
            result.kind = 'bitmap';
            for (i = 0; i < source.length; i++) {
                if (source.charAt(i) !== '1') continue;
                if (i + 1 > MAX_WEEK) result.dropped++;
                else result.weeks.push(i + 1);
            }
        } else if (WHOLE_TERM.test(source)) {
            result.kind = 'all';
            for (i = 1; i <= allTo; i++) {
                if (i > MAX_WEEK) result.dropped++;
                else result.weeks.push(i);
            }
        } else {
            result.kind = 'bad';
        }
        return result;
    }

    // 所有位串行里最大的周（「全周」展开用），至少 20。
    function bitmapMax(list, field) {
        var max = 0;
        for (var r = 0; r < list.length; r++) {
            var source = text((list[r] || {})[field]);
            if (!BITMAP.test(source)) continue;
            for (var i = 0; i < source.length; i++) {
                if (source.charAt(i) === '1' && i + 1 > max) max = i + 1;
            }
        }
        return max;
    }

    // 升序周次 → 极大段：步长 1 是每周，步长 2 是单周或双周，落单的一周算每周。
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2 ? 2 : 1;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j], weekType: 'ALL' };
            if (step === 2 && run.start !== run.end) run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    function unionWeeks(a, b) {
        var seen = {};
        var out = [];
        var all = a.concat(b);
        for (var i = 0; i < all.length; i++) {
            if (seen['w' + all[i]]) continue;
            seen['w' + all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    function intersects(a, b) {
        for (var i = 0; i < a.length; i++) {
            if (b.indexOf(a[i]) >= 0) return true;
        }
        return false;
    }

    function without(list, remove) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (remove.indexOf(list[i]) < 0) out.push(list[i]);
        }
        return out;
    }

    var FIELDS = ['KBID', 'KCM', 'SYXMMC', 'SKJS', 'JSM', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'KSSJ', 'JSSJ'];
    var allTo = Math.max(DEFAULT_WEEKS,
        bitmapMax(regularRows, 'SKZC'),
        bitmapMax(experimentRows || [], 'SKZC'),
        bitmapMax(changeRows || [], 'SKZC'),
        bitmapMax(changeRows || [], 'XSKZC'));

    var skipCounts = { name: 0, day: 0, period: 0 };
    var badWeekOrder = [];
    var badWeekCount = {};
    var droppedWeeks = 0;
    var courses = [];

    // 一条排课记录 → 课程。返回 { course } 或 { reason }：blank 静默跳过（空行 / 没有周次），其余进提醒。
    function buildCourse(row) {
        var name = joinName(row.KCM, row.SYXMMC);
        var day = integerOf(row.SKXQ);
        var start = integerOf(row.KSJC);
        var end = integerOf(row.JSJC);
        if (!name && !day && !start && !end) return { reason: 'blank' };
        if (!name) return { reason: 'name' };
        if (!(day >= 1 && day <= 7)) return { reason: 'day' };
        if (!(start >= 1 && end >= start && end <= MAX_PERIOD)) return { reason: 'period' };
        var parsed = weeksOf(row.SKZC, allTo);
        if (parsed.kind === 'bad') return { reason: 'week', sample: text(row.SKZC) };
        droppedWeeks += parsed.dropped;
        if (!parsed.weeks.length) return { reason: 'blank' };
        var teacher = realOrNull(teacherOf(row.SKJS)) || realOrNull(row.JSM);
        return {
            course: {
                sourceId: text(row.KBID),
                name: name,
                teacher: teacher,
                location: realOrNull(row.JASMC),
                day: day,
                start: start,
                end: end,
                weeks: parsed.weeks,
                startTime: hhmmOf(row.KSSJ),
                endTime: hhmmOf(row.JSSJ)
            }
        };
    }

    var seenRows = {};
    function ingest(list) {
        for (var r = 0; r < list.length; r++) {
            var row = list[r] || {};
            var rowKey = JSON.stringify(FIELDS.map(function (field) { return text(row[field]); }));
            if (seenRows[rowKey]) continue;
            seenRows[rowKey] = true;
            var built = buildCourse(row);
            if (built.course) {
                courses.push(built.course);
            } else if (built.reason === 'name') {
                skipCounts.name++;
            } else if (built.reason === 'day') {
                skipCounts.day++;
            } else if (built.reason === 'period') {
                skipCounts.period++;
            } else if (built.reason === 'week') {
                var sampleKey = 'w' + built.sample;
                if (!badWeekCount[sampleKey]) {
                    badWeekCount[sampleKey] = 0;
                    badWeekOrder.push(built.sample);
                }
                badWeekCount[sampleKey]++;
            }
        }
    }

    ingest(regularRows);
    ingest(experimentRows || []);

    // 调课：接口按申请时间倒序返回，先应用较早的变更。
    var changeUnknown = 0;
    var changeUnapplied = 0;
    var changeNewMissing = 0;
    var changeList = changeRows || [];
    for (var c = changeList.length - 1; c >= 0; c--) {
        var change = changeList[c] || {};
        var changeId = text(change.KBID);
        var changeType = text(change.TKLXDM);
        if (!changeId) continue;
        if (CHANGE_TYPES.indexOf(changeType) < 0) {
            changeUnknown++;
            continue;
        }
        var oldDay = integerOf(change.SKXQ);
        var oldStart = integerOf(change.KSJC);
        var oldEnd = integerOf(change.JSJC);
        var oldWeeks = weeksOf(change.SKZC, allTo);
        var affected = [];
        for (var k = 0; k < courses.length; k++) {
            var candidate = courses[k];
            if (candidate.sourceId === changeId && candidate.day === oldDay &&
                candidate.start === oldStart && candidate.end === oldEnd) {
                affected.push(candidate);
            }
        }
        var original = null;
        if (oldWeeks.kind !== 'bad') {
            for (var a = 0; a < affected.length && !original; a++) {
                if (intersects(affected[a].weeks, oldWeeks.weeks)) original = affected[a];
            }
        }
        if (!original) {
            changeUnapplied++;
            continue;
        }
        if (changeType !== '02') {
            var replaced = buildCourse({
                KBID: changeId,
                KCM: original.name,
                SKJS: text(change.XSKJS) || text(change.YSKJS) || (original.teacher || ''),
                JASMC: text(change.XJASMC) || text(change.JASMC) || (original.location || ''),
                SKXQ: change.XSKXQ,
                KSJC: change.XKSJC,
                JSJC: change.XJSJC,
                SKZC: change.XSKZC,
                KSSJ: change.XKSSJ,
                JSSJ: change.XJSSJ
            });
            if (replaced.course) courses.push(replaced.course);
            else changeNewMissing++;
        }
        for (var m = 0; m < affected.length; m++) {
            affected[m].weeks = without(affected[m].weeks, oldWeeks.weeks);
        }
    }

    // 实际排上课的课程（周次被调走或停课后为空的不算）。
    var active = [];
    for (var ai = 0; ai < courses.length; ai++) {
        if (courses[ai].weeks.length) active.push(courses[ai]);
    }
    if (!active.length) {
        throw new Error('这个学期没有解析到任何课程：请在「我的课表」里确认个人课表已经显示，再重新提取');
    }

    // 节次时间：只认合法、启停不倒挂、从 1 起连续的一组；否则用默认表。
    function readSections(list) {
        var byNumber = {};
        var count = 0;
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var number = integerOf(row.DM);
            var startClock = hhmmOf(row.KSSJ);
            var endClock = hhmmOf(row.JSSJ);
            if (!(number >= 1 && number <= MAX_PERIOD) || !startClock || !endClock) continue;
            if (minutesOf(startClock) >= minutesOf(endClock)) continue;
            var previous = byNumber['p' + number];
            if (previous && (previous.start !== startClock || previous.end !== endClock)) return null;
            byNumber['p' + number] = { periodIndex: number, start: startClock, end: endClock };
        }
        count = countKeys(byNumber);
        var periods = [];
        for (var n = 1; byNumber['p' + n]; n++) periods.push(byNumber['p' + n]);
        if (!periods.length || periods.length !== count) return null;
        for (var p = 1; p < periods.length; p++) {
            if (minutesOf(periods[p - 1].end) > minutesOf(periods[p].start)) return null;
        }
        return periods;
    }

    var onlinePeriods = sectionRows.length ? readSections(sectionRows) : null;
    var periods = onlinePeriods;
    if (!periods) {
        periods = [];
        for (var d = 0; d < DEFAULT_SECTIONS.length; d++) {
            periods.push({ periodIndex: d + 1, start: DEFAULT_SECTIONS[d][0], end: DEFAULT_SECTIONS[d][1] });
        }
    }

    // 合并：同课名、教师、教室、星期、节次段重叠或相邻的并成一段（同周次）。
    var slots = {};
    var slotList = [];
    for (var si = 0; si < active.length; si++) {
        var item = active[si];
        var slotKey = JSON.stringify([item.name, item.teacher || '', item.location || '', item.day, item.start, item.end]);
        if (!slots[slotKey]) {
            slots[slotKey] = {
                name: item.name, teacher: item.teacher, location: item.location, day: item.day,
                start: item.start, end: item.end, weeks: [], startTime: item.startTime, endTime: item.endTime
            };
            slotList.push(slots[slotKey]);
        }
        slots[slotKey].weeks = unionWeeks(slots[slotKey].weeks, item.weeks);
    }

    // 节次超出节次表时按统一修订 H3 逐节顺推（课间 5 分钟、每节 45 分钟）。
    var maxUsed = 0;
    for (var mu = 0; mu < slotList.length; mu++) {
        if (slotList[mu].end > maxUsed) maxUsed = slotList[mu].end;
    }
    var filled = [];
    var uncoveredFrom = 0;
    while (periods.length < maxUsed) {
        var lastEnd = minutesOf(periods[periods.length - 1].end);
        var nextStart = lastEnd + BREAK_MINUTES;
        var nextEnd = nextStart + CLASS_MINUTES;
        if (nextEnd > DAY_END_MINUTES) {
            uncoveredFrom = periods.length + 1;
            break;
        }
        periods.push({ periodIndex: periods.length + 1, start: clockOf(nextStart), end: clockOf(nextEnd) });
        filled.push(periods.length);
    }

    // 开学日、总周数：校历里与当前学年学期对应的一行优先，没有就用第一行。
    var calendar = calendarRows[0] || {};
    var termMatch = /^([0-9]{4}-[0-9]{4})-([0-9]+)$/.exec(text(term.code));
    if (termMatch) {
        for (var ci = 0; ci < calendarRows.length; ci++) {
            var candidate2 = calendarRows[ci] || {};
            if (text(candidate2.XN) === termMatch[1] && text(candidate2.XQ) === termMatch[2]) {
                calendar = candidate2;
                break;
            }
        }
    }

    var maxWeek = 0;
    var suppliedStart = text(calendar.XQKSRQ).substring(0, 10);
    var firstDay = mondayOf(suppliedStart);
    var firstDayGuessed = false;
    var firstDayShifted = false;
    if (firstDay) {
        firstDayShifted = firstDay !== suppliedStart;
    } else {
        firstDay = mondayOf(text(data.today));
        firstDayGuessed = true;
        if (!firstDay) throw new Error('没能确定开学日期：教务给出的日期和本机日期都无法识别');
    }

    var configuredWeeks = integerOf(calendar.ZZC);
    if (!(configuredWeeks >= 1)) configuredWeeks = integerOf(calendar.ZJXZC);
    var usedDefaultWeeks = !(configuredWeeks >= 1);
    if (usedDefaultWeeks) configuredWeeks = DEFAULT_WEEKS;
    var clampedWeeks = configuredWeeks > MAX_WEEK;
    if (clampedWeeks) configuredWeeks = MAX_WEEK;

    // 节次与周次都已定下，再整理成课程与极大段（maxWeek 在这里算出）。
    var merged = [];
    var mergeGroups = {};
    var mergeOrder = [];
    for (var gi = 0; gi < slotList.length; gi++) {
        var slot = slotList[gi];
        var groupKey = JSON.stringify([slot.name, slot.teacher || '', slot.location || '', slot.day, slot.weeks]);
        if (!mergeGroups[groupKey]) {
            mergeGroups[groupKey] = [];
            mergeOrder.push(groupKey);
        }
        mergeGroups[groupKey].push(slot);
    }
    for (var go = 0; go < mergeOrder.length; go++) {
        var group = mergeGroups[mergeOrder[go]].slice().sort(function (a, b) {
            return a.start - b.start || a.end - b.end;
        });
        var previous = null;
        for (var gj = 0; gj < group.length; gj++) {
            var part = group[gj];
            if (previous && part.start <= previous.end + 1) {
                previous.end = Math.max(previous.end, part.end);
            } else {
                previous = {
                    name: part.name, teacher: part.teacher, location: part.location, day: part.day,
                    start: part.start, end: part.end, weeks: part.weeks,
                    startTime: part.startTime, endTime: part.endTime
                };
                merged.push(previous);
            }
        }
    }
    merged.sort(function (a, b) {
        return a.day - b.day || a.start - b.start || compare(a.name, b.name) ||
            a.end - b.end || compare(a.location || '', b.location || '');
    });

    var courseByKey = {};
    var courseList = [];
    for (var mi = 0; mi < merged.length; mi++) {
        var piece = merged[mi];
        var courseKey = JSON.stringify([piece.name, piece.teacher || '']);
        var course = courseByKey[courseKey];
        if (!course) {
            course = { name: piece.name, teacher: piece.teacher, note: null, blocks: [] };
            courseByKey[courseKey] = course;
            courseList.push(course);
        }
        var runs = runsOf(piece.weeks);
        for (var ri = 0; ri < runs.length; ri++) {
            if (runs[ri].end > maxWeek) maxWeek = runs[ri].end;
            course.blocks.push({
                dayOfWeek: piece.day,
                startPeriod: piece.start,
                endPeriod: piece.end,
                startWeek: runs[ri].start,
                endWeek: runs[ri].end,
                weekType: runs[ri].weekType,
                location: piece.location
            });
        }
    }

    // ---- 提醒，按固定顺序写入 ----

    // 1. 学期来源
    var name0 = termName();
    if (text(term.source) === 'guess') {
        warn('没读到教务给出的当前学年学期，已按本机日期推定为 ' + shortName(name0) +
            (term.listed === true ? '（与学校公布的学期列表一致）' : '') + '，请在学期管理里核对');
    } else if (term.listed === false) {
        warn('当前学年学期不在学校公布的学期列表里（' + shortName(text(term.code) || name0) +
            '），已照常导入，请在教务系统里核对学期');
    }

    // 2. 实验课、调课记录取不到
    if (experimentRows === null) {
        warn('没能读到实验课安排，课表里可能缺少实验课，请在教务系统里核对');
    }
    if (changeRows === null) {
        warn('没能读到调课记录，如有调课，课表可能与教务不一致，请在教务系统里核对');
    }
    if (changeUnknown > 0) {
        warn('有 ' + changeUnknown + ' 条调课记录的类型认不出，已忽略，请在教务系统里核对');
    }
    if (changeUnapplied > 0) {
        warn('有 ' + changeUnapplied + ' 条调课记录找不到对应的原课或周次写法认不出，未能应用，请在教务系统里核对');
    }
    if (changeNewMissing > 0) {
        warn('有 ' + changeNewMissing + ' 条调课记录缺少新的上课时间或周次，已跳过，请在教务系统里核对');
    }

    // 3. 开学日
    if (firstDayGuessed) {
        warn('没能从教务读到合法的开学日期，第 1 周已按本机日期所在周的周一推算为 ' + firstDay + '，请在学期管理里核对');
    } else if (firstDayShifted) {
        warn('教务给出的开学日期是 ' + suppliedStart + '，第 1 周已回退到同一周的周一 ' + firstDay + '，请在学期管理里核对');
    }

    // 4. 总周数
    var totalWeeks = configuredWeeks;
    var raised = maxWeek > totalWeeks;
    if (raised) totalWeeks = maxWeek;
    if (usedDefaultWeeks) warn('教务没有给出有效的学期总周数，已按 20 周导入，请在学期管理里核对');
    if (clampedWeeks) warn('教务给出的学期总周数超过 30 周，已按 30 周导入，请在学期管理里核对');
    if (raised) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过原定的 ' + configuredWeeks + ' 周，学期总周数已按 ' + maxWeek + ' 周导入，请在学期管理里核对');
    }

    // 5. 节次时间
    if (!onlinePeriods) {
        if (sectionRows.length) {
            warn('教务给出的节次时间不完整或前后矛盾，已改用默认的节次时间，请在学期管理里核对');
        } else {
            warn('没能从教务读到节次时间，已改用默认的节次时间，请在学期管理里核对');
        }
    }
    if (filled.length) {
        warn('课表用到了学校节次时间没有覆盖的' + sectionsText(filled) +
            '，已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    // 6. 上课时间与节次时间不同（按节次放入）
    var customSeen = {};
    var customNames = [];
    for (var cu = 0; cu < slotList.length; cu++) {
        var cs = slotList[cu];
        if (!cs.startTime || !cs.endTime || cs.startTime >= cs.endTime) continue;
        if (!periods[cs.start - 1] || !periods[cs.end - 1]) continue;
        if (cs.startTime === periods[cs.start - 1].start && cs.endTime === periods[cs.end - 1].end) continue;
        if (!customSeen['n' + cs.name]) {
            customSeen['n' + cs.name] = true;
            customNames.push(cs.name);
        }
    }
    if (customNames.length) {
        warn('有 ' + customNames.length + ' 门课（例如 ' + sampleList(customNames) +
            '）的上课时间与节次时间不同，已按节次放入，请在教务系统里核对');
    }

    // 7. 数据不全跳过
    var skipped = skipCounts.name + skipCounts.day + skipCounts.period;
    if (skipped > 0) {
        var reasons = [];
        if (skipCounts.name) reasons.push('缺课程名 ' + skipCounts.name + ' 条');
        if (skipCounts.day) reasons.push('缺星期或星期不在 1-7 ' + skipCounts.day + ' 条');
        if (skipCounts.period) reasons.push('缺节次或节次超出 1-' + MAX_PERIOD + ' 节 ' + skipCounts.period + ' 条');
        warn('有 ' + skipped + ' 条课表安排数据不全（' + reasons.join('、') + '），已跳过，如发现少课请反馈');
    }

    // 8. 周次写法认不出（按原文分组，不静默丢课）
    for (var bw = 0; bw < badWeekOrder.length; bw++) {
        var badText = badWeekOrder[bw];
        warn('有 ' + badWeekCount['w' + badText] + ' 条课表的周次写法认不出（「' + shortName(badText) +
            '」），已跳过，请在教务系统里核对');
    }

    // 9. 超过第 30 周的周
    if (droppedWeeks > 0) warn('有 ' + droppedWeeks + ' 个周次超过第 30 周，超出的部分没有导入');

    // 10. 教师、教室缺失（按课名 + 教师去重计数）
    var missingTeacher = {};
    var missingLocation = {};
    var missingTeacherCount = 0;
    var missingLocationCount = 0;
    var missingNames = [];
    var missingNameSeen = {};
    for (var mt = 0; mt < slotList.length; mt++) {
        var ms = slotList[mt];
        var nameKey = JSON.stringify([ms.name, ms.teacher || '']);
        if (!ms.teacher && !missingTeacher[nameKey]) {
            missingTeacher[nameKey] = true;
            missingTeacherCount++;
        }
        if (!ms.location && !missingLocation[nameKey]) {
            missingLocation[nameKey] = true;
            missingLocationCount++;
        }
        if ((!ms.teacher || !ms.location) && !missingNameSeen['n' + ms.name]) {
            missingNameSeen['n' + ms.name] = true;
            missingNames.push(ms.name);
        }
    }
    var missingParts = [];
    if (missingTeacherCount > 0) missingParts.push(missingTeacherCount + ' 门课没给上课教师');
    if (missingLocationCount > 0) missingParts.push(missingLocationCount + ' 门课没给上课地点');
    if (missingParts.length) {
        warn('有 ' + missingParts.join('、') + '（例如 ' + sampleList(missingNames) +
            '）：已照常导入，空着的项可在「编辑课程」里补上');
    }

    if (!courseList.length) {
        throw new Error('这个学期没有解析到任何课程：请在「我的课表」里确认个人课表已经显示，再重新提取');
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: limitedWarnings(),
        terms: [{
            name: name0,
            firstDay: firstDay,
            totalWeeks: totalWeeks,
            periodTimes: periods,
            courses: courseList
        }]
    });
})()
