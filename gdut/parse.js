(function () {
    // 广东工业大学教务适配器（Struts2 教务平台 xsgrkbcx 族）—— 第二步：原始排课行转成课表载荷。
    //
    // 移植自 shiguang_warehouse 的 GDUT/gdut.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 forer4433）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4（2026-11-01）
    //   本校脚本最后一次修改 933f6f0（2026-10-12）
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 节次时间照上游写死的 14 节逐节搬过来（第 1 节 08:30 到第 14 节 22:35）。用到更晚的节次时逐节补，补不了的写进提醒
    //   ② 开学日优先用教务第 1 周的周一；没有或明显不属于这个学期时，按学期代码推算并提醒。总周数取 20，课表更晚才抬高
    //   ③ 上游每行只有一个周次数字。相同课、相同节次的多行合并成连续周或单双周。数字之外的周次文字也认得
    //      （单双标记、第几周、共 N 周备注），认不出的计数提醒，不静默丢课
    //   ④ 节次照上游：偶数位数字每两位一节（0102 是第 1 到 2 节）。逗号、区间也认得。不连续的按首尾跨度放入并提醒
    //   ⑤ 缺教师、缺教室照常导入，记为空并按类型汇总。写成未知、待定、暂无、暂无教师、暂无教室的也记为空
    //   ⑥ 这一步不访问网络、不碰页面
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    if (!data || typeof data !== 'object') {
        throw new Error('没有拿到教务数据：请重新登录教务系统后再点「提取课表」');
    }
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;
    var MAX_PERIOD = 20;
    var SCHOOL_NAME = '广东工业大学';
    var SCHOOL_TOTAL_WEEKS = 20;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var TERM_TEXT_LIMIT = 30;
    var SAMPLE_COUNT = 3;
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    var SEP = String.fromCharCode(1);

    // 上游 setPresetTimeSlots，14 节，逐节照抄
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:30', end: '09:15' },
        { periodIndex: 2, start: '09:20', end: '10:05' },
        { periodIndex: 3, start: '10:25', end: '11:10' },
        { periodIndex: 4, start: '11:15', end: '12:00' },
        { periodIndex: 5, start: '13:50', end: '14:35' },
        { periodIndex: 6, start: '14:40', end: '15:25' },
        { periodIndex: 7, start: '15:30', end: '16:15' },
        { periodIndex: 8, start: '16:30', end: '17:15' },
        { periodIndex: 9, start: '17:20', end: '18:05' },
        { periodIndex: 10, start: '18:30', end: '19:15' },
        { periodIndex: 11, start: '19:20', end: '20:05' },
        { periodIndex: 12, start: '20:10', end: '20:55' },
        { periodIndex: 13, start: '21:00', end: '21:45' },
        { periodIndex: 14, start: '21:50', end: '22:35' }
    ];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    function shortName(name, limit) {
        var line = text(name);
        var max = limit || NAME_TEXT_LIMIT;
        return line.length > max ? line.substring(0, max - 1) + '…' : line;
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

    function utcOfIso(iso) {
        var matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!matched) return null;
        var ms = Date.UTC(parseInt(matched[1], 10), parseInt(matched[2], 10) - 1, parseInt(matched[3], 10));
        return isNaN(ms) ? null : ms;
    }

    function mondayOf(iso) {
        var ms = utcOfIso(iso);
        if (ms === null) return null;
        var date = new Date(ms);
        var offset = (date.getUTCDay() + 6) % 7;
        return isoOf(new Date(ms - offset * 86400000));
    }

    function isoOfAny(value) {
        var matched = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
        if (!matched) return null;
        var month = parseInt(matched[2], 10);
        var day = parseInt(matched[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return matched[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    function codePointOf(value) {
        if (!(value > 0) || value > 0x10ffff) return '';
        if (value <= 0xffff) return String.fromCharCode(value);
        var rest = value - 0x10000;
        return String.fromCharCode(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff));
    }

    function decodeEntities(value) {
        if (value === null || value === undefined) return '';
        var out = String(value);
        if (out.indexOf('&') < 0) return out;
        out = out
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&apos;/gi, "'");
        out = out
            .replace(/&#x([0-9a-f]{1,5});/gi, function (all, hex) { return codePointOf(parseInt(hex, 16)); })
            .replace(/&#(\d{1,6});/g, function (all, dec) { return codePointOf(parseInt(dec, 10)); });
        return out.replace(/&amp;/gi, '&');
    }

    var code = text(term.code);

    function termParts() {
        var matched = /^(\d{4})0?([12])$/.exec(code);
        if (!matched) matched = /^(\d{4})\D+\d{4}\D+0?([12])$/.exec(code);
        if (!matched) return null;
        return { year: parseInt(matched[1], 10), kind: matched[2] === '1' ? 'first' : 'second' };
    }

    function termName() {
        var explicit = text(term.name);
        if (explicit) return explicit;
        if (code) return SCHOOL_NAME + ' ' + code;
        return SCHOOL_NAME + ' 课表';
    }

    function anchorOf(parts) {
        if (parts.kind === 'first') return { iso: parts.year + '-09-01', rule: '第一学期 = 9 月 1 日所在周的周一' };
        return { iso: (parts.year + 1) + '-02-20', rule: '第二学期 = 2 月 20 日所在周的周一' };
    }

    function plausibleFirstDay(iso) {
        var parts = termParts();
        if (!parts) return true;
        var target = utcOfIso(anchorOf(parts).iso);
        var value = utcOfIso(iso);
        if (target === null || value === null) return true;
        return Math.abs(value - target) <= 45 * 86400000;
    }

    function findMondayIso(node, depth) {
        if (!node || typeof node !== 'object' || depth > 4) return null;
        if (node.xqmc !== undefined && node.rq !== undefined) {
            var weekday = text(node.xqmc);
            if (weekday === '1' || weekday === '周一' || weekday === '一' || weekday === '星期一') {
                var iso = isoOfAny(node.rq);
                if (iso && plausibleFirstDay(iso)) return iso;
            }
            return null;
        }
        for (var key in node) {
            if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
            var found = findMondayIso(node[key], depth + 1);
            if (found) return found;
        }
        return null;
    }

    function firstDayFromDates(info) {
        if (!info || typeof info !== 'object') return null;
        var scopes = [];
        if (info[1]) scopes.push(info[1]);
        scopes.push(info);
        for (var i = 0; i < scopes.length; i++) {
            var found = findMondayIso(scopes[i], 0);
            if (found) return found;
        }
        return null;
    }

    function estimateStart() {
        var parts = termParts();
        if (parts) {
            var anchor = anchorOf(parts);
            return { iso: mondayOf(anchor.iso), rule: anchor.rule };
        }
        var today = text(data.today);
        var base = mondayOf(today);
        if (base) return { iso: base, rule: '今天所在周的周一' };
        return { iso: mondayOf('2000-01-03') || '2000-01-03', rule: '无法判断学期' };
    }

    var droppedWeeks = 0;
    var orphanMarkers = 0;
    var serialGroups = 0;
    var noteGroups = 0;
    var noteSample = '';
    var bothMarks = 0;

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
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        cleaned = cleaned.replace(/第/g, '');
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            var segmentHead = before.substring(before.lastIndexOf(',') + 1);
            if (/^\s*\([单双]/.test(segmentHead)) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            return digit + mark + (/^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '');
        });
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = all;
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        var tokens = cleaned.replace(/\s+/g, ',').split(/,+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
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
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:-[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                if (end > 99) end = 99;
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

    // 上游每行的 zc 是一个周次数字。纯数字只算这一周；其余交给文字解析（单双、第、共 N 周）
    function weeksFromValue(raw) {
        if (typeof raw === 'number' && isFinite(raw) && raw === Math.floor(raw)) {
            if (raw > MAX_WEEK) { droppedWeeks++; return []; }
            if (raw < 1) return [];
            return [raw];
        }
        var line = text(raw);
        if (/^[0-9]+$/.test(line)) {
            var n = parseInt(line, 10);
            if (n > MAX_WEEK) { droppedWeeks++; return []; }
            if (n < 1) return [];
            return [n];
        }
        return weeksOf(line);
    }

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

    var sparseRows = 0;

    function pushNumbers(piece, numbers) {
        if (!piece) return true;
        var range = /^([0-9]{1,2})-([0-9]{1,2})$/.exec(piece);
        if (range) {
            var from = parseInt(range[1], 10);
            var to = parseInt(range[2], 10);
            if (to < from) { var swap = from; from = to; to = swap; }
            for (var n = from; n <= to; n++) numbers.push(n);
            return true;
        }
        // 偶数位纯数字：每两位一节。0102 是第 1、2 节，010203 是第 1 到 3 节，10 是第 10 节
        if (/^[0-9]+$/.test(piece) && piece.length >= 2 && piece.length % 2 === 0) {
            for (var i = 0; i < piece.length; i += 2) {
                numbers.push(parseInt(piece.substring(i, i + 2), 10));
            }
            return true;
        }
        if (/^[0-9]{1,2}$/.test(piece)) {
            numbers.push(parseInt(piece, 10));
            return true;
        }
        return false;
    }

    function sectionsOf(source) {
        var cleaned = fullWidthToHalf(text(source)).replace(/[第节\s]/g, '');
        if (!cleaned) return null;
        var pieces = cleaned.split(/,+/);
        var numbers = [];
        var i;
        for (i = 0; i < pieces.length; i++) {
            if (!pushNumbers(pieces[i], numbers)) return null;
        }
        if (!numbers.length) return null;
        var first = numbers[0];
        var last = numbers[0];
        var unique = {};
        var count = 0;
        for (i = 0; i < numbers.length; i++) {
            if (numbers[i] < first) first = numbers[i];
            if (numbers[i] > last) last = numbers[i];
            if (!unique[numbers[i]]) { unique[numbers[i]] = true; count++; }
        }
        if (first < 1 || last > MAX_PERIOD) return null;
        return { start: first, end: last, sparse: count !== last - first + 1 };
    }

    var order = [];
    var byCourse = {};
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var weekSamples = [];
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    var EMPTY_VALUE = /^(未知|待定|暂无教师|暂无教室|暂无|无)$/;

    function cleanField(value) {
        var line = text(decodeEntities(value));
        return EMPTY_VALUE.test(line) ? '' : line;
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var name = text(decodeEntities(row.kcmc));
        if (!name) { missing.name++; continue; }
        var day = intOf(row.xq);
        if (day === null || day < 1 || day > 7) { missing.day++; continue; }
        var sections = sectionsOf(row.jcdm);
        if (!sections) { missing.period++; continue; }
        var weeks = weeksFromValue(row.zc);
        if (!weeks.length) {
            missing.week++;
            if (weekSamples.length < 1 && text(row.zc)) weekSamples.push(text(row.zc));
            continue;
        }
        var teacher = cleanField(row.teaxms) || null;
        var location = cleanField(row.jxcdmc) || null;
        var key = name + SEP + (teacher || '');
        var course = byCourse[key];
        if (!course) {
            course = { name: name, teacher: teacher, note: null, slots: {}, slotOrder: [] };
            byCourse[key] = course;
            order.push(key);
        }
        if (!teacher) {
            missingTeacherCourses[key] = true;
            if (fieldSamples.length < SAMPLE_COUNT && fieldSamples.indexOf(name) < 0) fieldSamples.push(name);
        }
        if (!location) {
            missingLocationCourses[key] = true;
            if (fieldSamples.length < SAMPLE_COUNT && fieldSamples.indexOf(name) < 0) fieldSamples.push(name);
        }
        if (sections.sparse) sparseRows++;
        var slotKey = day + '|' + sections.start + '|' + sections.end + '|' + (location || '');
        var slot = course.slots[slotKey];
        if (!slot) {
            slot = { day: day, start: sections.start, end: sections.end, location: location, seen: {}, weeks: [] };
            course.slots[slotKey] = slot;
            course.slotOrder.push(slotKey);
        }
        for (var w = 0; w < weeks.length; w++) {
            if (!slot.seen[weeks[w]]) {
                slot.seen[weeks[w]] = true;
                slot.weeks.push(weeks[w]);
            }
        }
        if (sections.end > maxPeriod) maxPeriod = sections.end;
    }

    var termText = shortName(termName(), TERM_TEXT_LIMIT);

    if (rows.length === 0) {
        throw new Error('教务系统里「' + termText + '」还没有排课数据。请打开教务「我的课表」，确认能看到课程后再点「提取课表」');
    }
    if (order.length === 0) {
        throw new Error('这学期的课表里没有解析出任何课程：可能是课表还没发布，或教务系统改了数据格式');
    }

    var payloadCourses = [];
    for (var c = 0; c < order.length; c++) {
        var item = byCourse[order[c]];
        var blocks = [];
        for (var s = 0; s < item.slotOrder.length; s++) {
            var slotItem = item.slots[item.slotOrder[s]];
            slotItem.weeks.sort(function (a, b) { return a - b; });
            var runs = runsOf(slotItem.weeks);
            for (var n = 0; n < runs.length; n++) {
                if (runs[n].end > maxWeek) maxWeek = runs[n].end;
                blocks.push({
                    dayOfWeek: slotItem.day,
                    startPeriod: slotItem.start,
                    endPeriod: slotItem.end,
                    startWeek: runs[n].start,
                    endWeek: runs[n].end,
                    weekType: runs[n].weekType,
                    location: slotItem.location
                });
            }
        }
        payloadCourses.push({ name: item.name, teacher: item.teacher, note: null, blocks: blocks });
    }

    var firstDay = firstDayFromDates(data.dateInfo);
    var firstDayFromSchool = !!firstDay;
    var startRule = '';
    if (!firstDay) {
        var estimate = estimateStart();
        firstDay = estimate.iso;
        startRule = estimate.rule;
    }

    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    var periodTimes = PERIOD_TIMES.slice(0);
    var fromDefault = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
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

    var source = text(term.source);
    if (source === 'auto') {
        warn('按当前日期推算导入了「' + termText + '」。要导入别的学期，请先打开教务「我的课表」，切到那个学期后再点「提取课表」');
    } else {
        warn('只导入了「' + termText + '」；要导入别的学期，请先在教务「我的课表」页面里切到那个学期再点「提取课表」');
    }
    if (data.truncated) {
        warn('课表记录比较多，只导入了前 2000 条，请打开教务课表核对有没有少课');
    }
    if (firstDayFromSchool) {
        warn('开学日期取自教务系统的第 1 周日期：' + firstDay + '，请在学期管理里核对');
    } else {
        warn('教务系统没有给出开学日期，第 1 周按「' + startRule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日');
    }
    if (raisedBySchedule) {
        warn('教务系统没有给出学期总周数；课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
    } else {
        warn('教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    }
    if (fromDefault.length || bySequence.length) {
        var fillTexts = [];
        if (fromDefault.length) fillTexts.push(sectionsText(fromDefault) + '用学校公布的节次时间接上');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromDefault.concat(bySequence).sort(function (a, b) { return a - b; });
        warn('课表用到了' + sectionsText(filledAll) + '，学校公布的节次时间没有覆盖，已补上：' + fillTexts.join('，') + '，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 行');
        if (missing.period) reasons.push('缺节次（或节次超出 1-' + MAX_PERIOD + ' 节）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (weekSamples.length) reasons.push('认不出的周次写法如「' + shortName(weekSamples[0]) + '」');
        warn('有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') + '），已跳过：教务数据不完整时会出现，如发现少课请反馈');
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownNames.push(shortName(fieldSamples[fs]));
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shownNames.join('、') + '）：已照常导入，' + emptyText + '，可在「编辑课程」里补上');
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处周次里的括号只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，已忽略，请核对这几门课的周次');
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
    if (sparseRows > 0) {
        warn('有 ' + sparseRows + ' 行课表的节次不连续（例如「01,02,05」），已按最大跨度放入（中间几节也算上），请核对');
    }
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
                name: termName(),
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
