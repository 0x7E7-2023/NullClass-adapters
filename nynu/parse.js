(function () {
    // 南阳师范学院教务适配器（青果教务，经学校 VPN）—— 第二步：纯函数，把 extract.js 交出的课程块解析成课表载荷。
    //
    // 移植自 shiguang_warehouse 的 NYNU/nynu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 7c9e1907635cb1c2d481b316e6f52d69dc77edff（2026-10-27 拉取）
    //   本校脚本最后一次修改 80e30cf
    //
    // 模板是已审计的青果件 jyvtc（济源职业技术学院）。取数层不同构（本校是 weekly 块加 VPN 前缀，不是 mykb 表格），
    // 周次解析、提醒限长、缺教师 / 缺教室汇总、连堂合并、补节次沿用 jyvtc，并补上批次十八 jxfu 的无逗号前置单双标记归属。
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」）：
    //   1. 一块一门课：id 形如 weekly03_1 的星期是 3（上游同一条规则）；节次和周次从「上课时间」里的两对方括号读取
    //   2. 周次文字沿用 jxfu 的 weeksOf（含无逗号前置单双、第1-第8周、共 N 周只剥备注）
    //   3. 教师 / 教室拿不到就是空，不写「未知」；按类型汇总进提醒
    //   4. 节次时间：上游没有从教务读，也没有写死的表。整张用常用的 12 节，超出的按统一修订 H3 顺推，并在提醒里说明
    //   5. 开学日：上游不给。按学期推算（第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一）并提醒
    //   6. 合并：先去掉完全相同的块，再把同一门课节次首尾相接或重叠（下一节起点不晚于上一节终点加 1）的合成一块，最后周次取并集
    //   7. 带进提醒的教务原文先截到 20 字，每条提醒不超过 200 字

    var SCHOOL_NAME = '南阳师范学院';
    var SCHOOL_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;
    var MAX_PERIOD = 20;
    var NAME_TEXT_LIMIT = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_WARNINGS = 20;
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;

    // 空课常用节次时间（:core:model 的 DefaultPeriodTimes，12 节）。上游没有本校节次表，整张用它；
    // 课表用到第 13 节及以后时，接不上的按顺推补（载荷带了 periodTimes 时应用不会自己补）。
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
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' }
    };

    var data;
    try {
        data = JSON.parse(__ncInput);
    } catch (e) {
        throw new Error('教务系统返回的课表内容读不出来，请重新登录后再点「提取课表」');
    }
    if (!data || typeof data !== 'object') data = {};
    var term = data.term || {};
    var blocks = Array.isArray(data.blocks) ? data.blocks : [];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

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

    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
    }

    function isoOfAny(value) {
        var matched = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
        if (!matched) return null;
        var month = parseInt(matched[2], 10);
        var day = parseInt(matched[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return matched[1] + '-' + pad2(month) + '-' + pad2(day);
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

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

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

    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    var termYear = intOf(term.xn);
    if (termYear === null || termYear < 2000 || termYear > 2100) termYear = null;
    var termKind = text(term.xq) === '0' ? 'first' : (text(term.xq) === '1' ? 'second' : null);
    if (!termYear) termKind = null;

    function termName() {
        if (!termYear || !termKind) return SCHOOL_NAME + ' 当前学期';
        return termYear + '-' + (termYear + 1) + '学年第' + KIND_CN[termKind] + '学期';
    }

    function estimateStart(todayIso) {
        if (!termYear || !termKind) {
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天所在周的周一' };
        }
        var anchor = KIND_ANCHOR[termKind];
        var year = termYear + (termKind === 'first' ? 0 : 1);
        return {
            iso: isoOf(mondayOnOrBefore(year, anchor.month, anchor.day)),
            rule: anchor.rule
        };
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
        // 无逗号的前置单双：本段自己以前缀标记开头时，后一个标记归下一段（前面补逗号）
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
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
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

    // 整串里恰好一个不在括号里的「单周」或「双周」时，只对区间生效（单独的一周不受影响）
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

    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j], weekType: 'ALL' };
            if (step === 2 && run.start !== run.end) run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    function blankToNull(value) {
        var line = text(value);
        if (!line) return null;
        if (/^(未知|暂无|待定|无)(教师|老师|地点|教室)?$/.test(line)) return null;
        return line;
    }

    function fieldOf(lines, label) {
        var found = null;
        for (var i = 0; i < lines.length; i++) {
            var line = text(String(lines[i]).replace(/<[^>]*>/g, ''));
            if (line.indexOf(label) !== 0) continue;
            found = text(line.substring(label.length).replace(/^[：:]/, ''));
        }
        return found;
    }

    function timeParts(timeText) {
        var source = text(timeText);
        var groups = [];
        var re = /[\[［]([^\[\]［］]*)[\]］]/g;
        var matched;
        while ((matched = re.exec(source))) groups.push(matched[1]);
        var section = null;
        var weekSrc = null;
        for (var i = 0; i < groups.length; i++) {
            var group = groups[i];
            var sectionMatch = /(\d+)\s*(?:[-~～至到]\s*(\d+))?\s*节/.exec(group);
            if (sectionMatch && !section && group.indexOf('周') < 0) {
                var start = parseInt(sectionMatch[1], 10);
                var end = sectionMatch[2] ? parseInt(sectionMatch[2], 10) : start;
                if (end < start) { var swap = start; start = end; end = swap; }
                section = { start: start, end: end };
                continue;
            }
            if (weekSrc === null && (group.indexOf('周') >= 0 || /[0-9]/.test(group))) weekSrc = group;
        }
        return { section: section, weekSrc: weekSrc };
    }

    var courses = [];
    var byName = {};
    var entries = [];
    var unreadable = { name: 0, time: 0 };
    var unreadableSamples = [];
    var badLayout = 0;
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var missingAnyCourses = {};
    var fieldSamples = [];

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

    function noteMissing(dict, name) {
        dict[name] = true;
        missingAnyCourses[name] = true;
        if (fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) fieldSamples.push(name);
    }

    var anyContent = blocks.length > 0;
    for (var b = 0; b < blocks.length; b++) {
        var block = blocks[b] || {};
        var lines = Array.isArray(block.lines) ? block.lines : [];
        var idMatch = /^weekly0?(\d+)_(\d+)$/.exec(text(block.id));
        var day = idMatch ? parseInt(idMatch[1], 10) : 0;
        var name = blankToNull(fieldOf(lines, '课程名称'));
        var timeText = fieldOf(lines, '上课时间');
        if (!idMatch || day < 1 || day > 7) {
            if (name || timeText) badLayout++;
            continue;
        }
        if (!name) {
            noteUnreadable('name', timeText || text(block.id));
            continue;
        }
        var parts = timeParts(timeText);
        if (!timeText || !parts.section || !parts.weekSrc) {
            noteUnreadable('time', timeText || name);
            continue;
        }
        if (parts.section.start < 1 || parts.section.end > MAX_PERIOD) {
            noteUnreadable('time', timeText);
            continue;
        }
        var weeks = weeksOfCell(parts.weekSrc);
        if (!weeks.length) {
            noteUnreadable('time', timeText);
            continue;
        }
        var teacher = blankToNull(fieldOf(lines, '任课教师'));
        var location = blankToNull(fieldOf(lines, '上课地点'));
        if (!teacher) noteMissing(missingTeacherCourses, name);
        if (!location) noteMissing(missingLocationCourses, name);
        entries.push({
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            start: parts.section.start,
            end: parts.section.end,
            weeks: weeks,
            course: courseOf(name, teacher)
        });
    }

    function cmpText(a, b) {
        var left = a || '';
        var right = b || '';
        return left < right ? -1 : (left > right ? 1 : 0);
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

    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next) && next.start <= current.end + 1) {
                if (next.end > current.end) current.end = next.end;
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

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

    var stageOne = dropExactDuplicates(entries).sort(orderStageOne);
    var merged = mergeStageTwo(mergeStageOne(stageOne).sort(orderStageTwo));

    var maxWeek = 0;
    var maxPeriod = 0;
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

    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: null,
            blocks: courses[c].blocks
        });
    }

    var todayRaw = isoOfAny(data.today);
    var todayIso = todayRaw || localTodayIso();
    var start = estimateStart(todayIso);

    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    var periodTimes = BUILTIN_PERIOD_TIMES.slice(0);
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        var prevEnd = minutesOf(prev.end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

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

    warn(
        '教务系统没有给出节次时间，已按常用的 ' + BUILTIN_PERIOD_TIMES.length +
        ' 节节次时间导入（第 1 节 ' + BUILTIN_PERIOD_TIMES[0].start + '-' + BUILTIN_PERIOD_TIMES[0].end +
        '，第 ' + BUILTIN_PERIOD_TIMES.length + ' 节 ' +
        BUILTIN_PERIOD_TIMES[BUILTIN_PERIOD_TIMES.length - 1].start + '-' +
        BUILTIN_PERIOD_TIMES[BUILTIN_PERIOD_TIMES.length - 1].end +
        '），请在「学期管理」里核对'
    );

    if (bySequence.length) {
        warn(
            '课表用到了' + sectionsText(bySequence) + '，常用节次时间只到第 ' + BUILTIN_PERIOD_TIMES.length +
            ' 节，已补上：' + sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推，请在「学期管理」里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    var skipped = unreadable.name + unreadable.time;
    if (skipped > 0) {
        var reasons = [];
        if (unreadable.name) reasons.push('缺课程名 ' + unreadable.name + ' 条');
        if (unreadable.time) reasons.push('上课时间认不出 ' + unreadable.time + ' 条');
        var sampleTexts = [];
        for (var us = 0; us < unreadableSamples.length; us++) sampleTexts.push('「' + unreadableSamples[us] + '」');
        warn(
            '有 ' + skipped + ' 条课程内容没能读成课程（' + reasons.join('、') + '），已跳过，例如 ' +
            sampleTexts.join('') + '：如发现少课请反馈'
        );
    }
    if (badLayout > 0) {
        warn(
            '有 ' + badLayout + ' 处课表的排版和预期不一样（认不出是星期几），这些内容已跳过：如发现少课请反馈'
        );
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownFieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownFieldNames.push(shortName(fieldSamples[fs]));
        var extraField = countKeys(missingAnyCourses) - fieldSamples.length;
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        var extraText = extraField > 0 ? '，另有 ' + extraField + ' 门未列出' : '';
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + shownFieldNames.join('、') + extraText + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上'
        );
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」）：那是教学班序号不是周次，已忽略，请核对这几门课的周次');
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
