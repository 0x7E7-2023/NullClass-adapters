(function () {
    // 浙江工商职业技术学院教务适配器（青果教务）—— 第二步：课程格逐行文字转换为课表。
    // 移植自 shiguang_warehouse 的 ZJBTI/zjbti.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 LanRhyme）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e；本校脚本最后一次修改 72967b1
    // 输入仅为 extract.js 的白名单对象：term、hasTable、cells、dates。本文件无页面与网络访问。
    // 模板 wzzy：周次切段、周次到极大段、按周节次矩阵合并、提醒限长和 H3 补节次。
    // 本校差异：单独一周也按单双标记过滤；12 节节次时间逐节照上游；其余改动见 AUDIT.md。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var cells = Array.isArray(data.cells) ? data.cells : [];
    var dateTexts = Array.isArray(data.dates) ? data.dates : [];

    var MAX_WEEK = 30;
    var MAX_PERIOD = 999;         // 只用于挡住异常超大区间；21 节及以后照常保留课程。
    var SCHOOL_NAME = '浙江工商职业技术学院';
    var SCHOOL_TOTAL_WEEKS = 20;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;

    // 上游 importPresetTimeSlots 的 12 节，逐节照抄。
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:30', end: '09:15' },
        { periodIndex: 2, start: '09:20', end: '10:05' },
        { periodIndex: 3, start: '10:20', end: '11:05' },
        { periodIndex: 4, start: '11:10', end: '11:55' },
        { periodIndex: 5, start: '13:10', end: '13:55' },
        { periodIndex: 6, start: '14:00', end: '14:45' },
        { periodIndex: 7, start: '15:00', end: '15:45' },
        { periodIndex: 8, start: '15:50', end: '16:35' },
        { periodIndex: 9, start: '16:40', end: '17:25' },
        { periodIndex: 10, start: '18:20', end: '19:05' },
        { periodIndex: 11, start: '19:10', end: '19:55' },
        { periodIndex: 12, start: '20:00', end: '20:45' }
    ];

    var KIND_CN = { first: '一', second: '二' };
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' }
    };
    var KIND_WINDOW = {
        first: { fromMonth: 7, toMonth: 10, yearShift: 0 },
        second: { fromMonth: 1, toMonth: 4, yearShift: 1 }
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function fieldText(value) {
        var clean = text(value);
        return /^(未知|待定|暂无|未知教师|未知地点|暂无教师|暂无教室)$/.test(clean) ? '' : clean;
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

    var termYear = /^[0-9]{4}$/.test(text(term.xn)) ? parseInt(text(term.xn), 10) : 0;
    var termMatch = termYear > 0 && /^[01]$/.test(text(term.xq));
    var termKind = termMatch && text(term.xq) === '1' ? 'second' : 'first';

    function termName() {
        var given = text(term.name);
        if (given) return given.length > 40 ? given.substring(0, 40) : given;
        if (!termMatch) return SCHOOL_NAME + ' 当前学期';
        return termYear + '-' + (termYear + 1) + '学年第' + KIND_CN[termKind] + '学期';
    }

    function startFromSchool() {
        if (!termMatch || !dateTexts.length) return null;
        var year = termYear + KIND_WINDOW[termKind].yearShift;
        for (var i = 0; i < dateTexts.length; i++) {
            var m = /^([0-9]{2})-([0-9]{2})$/.exec(text(dateTexts[i]));
            if (!m) continue;
            var month = parseInt(m[1], 10);
            var day = parseInt(m[2], 10);
            var date = new Date(Date.UTC(year, month - 1, day));
            if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
            if (date.getUTCDay() !== 1) continue;
            var win = KIND_WINDOW[termKind];
            if (month < win.fromMonth || month > win.toMonth) return { bad: year + '-' + m[1] + '-' + m[2] };
            return { iso: isoOf(date) };
        }
        return { bad: text(dateTexts[0]) };
    }

    function estimateStart() {
        if (!termMatch) return null;
        var anchor = KIND_ANCHOR[termKind];
        return {
            iso: isoOf(mondayOnOrBefore(termYear + KIND_WINDOW[termKind].yearShift, anchor.month, anchor.day)),
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

    // 周次逐段解析；与 wzzy 的关键差异是单独一周也按本校上游的单双条件过滤。
    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (/[0-9周]\s*$/.test(before)) {
                var segment = before.split(',').pop();
                if (!/^\s*\([单双](?:周)?\)/.test(segment)) return all;
            }
            return (offset > 0 ? ',' : '') + mark;
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
                if (!noteSample) noteSample = shortName(all);
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
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

    function periodRangesOf(source) {
        var cleaned = fullWidthToHalf(text(source)).replace(/[第节]/g, ' ').replace(/\s*-\s*/g, '-');
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var ranges = [];
        for (var i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (!token) continue;
            if (!/^[0-9]+(?:-[0-9]+)*$/.test(token)) return null;
            var nums = token.split('-');
            var start = parseInt(nums[0], 10);
            var end = parseInt(nums[nums.length - 1], 10);
            if (!(start >= 1 && end >= start && end <= MAX_PERIOD)) return null;
            ranges.push({ start: start, end: end });
        }
        return ranges.length ? ranges : null;
    }

    function timeLineOf(lines) {
        for (var i = 1; i < lines.length; i++) {
            var line = lines[i].replace(/［/g, '[').replace(/］/g, ']');
            var m = /^(.*)\[([^\[\]]*)\](.*)$/.exec(line);
            if (m && /[0-9]/.test(m[2])) return { index: i, weeks: m[1], sections: m[2], trailing: text(m[3]) };
        }
        return null;
    }

    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var unreadable = { time: 0, week: 0, section: 0 };
    var unreadableSamples = [];
    var trailingCount = 0;
    var trailingSample = '';
    var badDayCourses = 0;
    var strayCells = 0;
    var anyContent = false;
    var maxWeek = 0;
    var maxPeriod = 0;
    var usedPeriods = {};
    var groups = [];
    var groupByKey = {};

    function noteUnreadable(reason, name) {
        unreadable[reason]++;
        var sample = shortName(name);
        if (unreadableSamples.length < 3 && unreadableSamples.indexOf(sample) < 0) unreadableSamples.push(sample);
    }

    function groupOf(name, teacher, location, day) {
        var key = 'k' + JSON.stringify([name, teacher, location, day]);
        var found = groupByKey[key];
        if (found) return found;
        found = { name: name, teacher: teacher, location: location, day: day, matrix: {} };
        groupByKey[key] = found;
        groups.push(found);
        return found;
    }

    for (var c0 = 0; c0 < cells.length; c0++) {
        var cell = cells[c0] || {};
        var courseLines = Array.isArray(cell.courses) ? cell.courses : [];
        if (!courseLines.length) {
            if (cell.stray) {
                anyContent = true;
                strayCells++;
            }
            continue;
        }
        anyContent = true;
        var day = parseInt(cell.d, 10);
        for (var k = 0; k < courseLines.length; k++) {
            var lines = [];
            var rawLines = Array.isArray(courseLines[k]) ? courseLines[k] : [];
            for (var rl = 0; rl < rawLines.length; rl++) {
                var one = text(rawLines[rl]);
                if (one) lines.push(one);
            }
            if (!lines.length) continue;
            var courseName = lines[0];
            if (!(day >= 1 && day <= 7)) { badDayCourses++; continue; }
            var timeLine = timeLineOf(lines);
            if (!timeLine) { noteUnreadable('time', courseName); continue; }
            var weeks = weeksOf(timeLine.weeks);
            if (!weeks.length) { noteUnreadable('week', courseName); continue; }
            var ranges = periodRangesOf(timeLine.sections);
            if (!ranges) { noteUnreadable('section', courseName); continue; }
            var teacher = fieldText(lines.slice(1, timeLine.index).join('、'));
            var after = lines.slice(timeLine.index + 1);
            var location = after.length ? fieldText(after[0]) : '';
            var extra = timeLine.trailing || (after.length > 1 ? text(after.slice(1).join(' ')) : '');
            if (extra) {
                trailingCount++;
                if (!trailingSample) trailingSample = shortName(extra);
            }
            if (!teacher) missingTeacherCourses['n' + courseName] = true;
            if (!location) missingLocationCourses['n' + courseName] = true;
            if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(courseName) < 0) {
                fieldSamples.push(courseName);
            }
            var group = groupOf(courseName, teacher, location, day);
            for (var rg = 0; rg < ranges.length; rg++) {
                for (var s = ranges[rg].start; s <= ranges[rg].end; s++) usedPeriods[s] = true;
                for (var w = 0; w < weeks.length; w++) {
                    var perWeek = group.matrix[weeks[w]];
                    if (!perWeek) { perWeek = {}; group.matrix[weeks[w]] = perWeek; }
                    for (var ps = ranges[rg].start; ps <= ranges[rg].end; ps++) perWeek[ps] = true;
                }
            }
        }
    }

    function numericAsc(a, b) { return a - b; }
    var courses = [];
    var courseByKey = {};

    function courseOf(name, teacher) {
        var key = 'k' + JSON.stringify([name, teacher || '']);
        var found = courseByKey[key];
        if (found) return found;
        found = { name: name, teacher: teacher || null, blocks: [] };
        courseByKey[key] = found;
        courses.push(found);
        return found;
    }

    // 与上游一致：同课名、教师、地点、星期合成每周节次集合，再按连续节次与周次切段。
    for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        var weekKeys = [];
        for (var wk in g.matrix) {
            if (Object.prototype.hasOwnProperty.call(g.matrix, wk)) weekKeys.push(parseInt(wk, 10));
        }
        weekKeys.sort(numericAsc);
        var patterns = [];
        var patternByKey = {};
        for (var wi = 0; wi < weekKeys.length; wi++) {
            var sectionKeys = [];
            for (var sk in g.matrix[weekKeys[wi]]) {
                if (Object.prototype.hasOwnProperty.call(g.matrix[weekKeys[wi]], sk)) sectionKeys.push(parseInt(sk, 10));
            }
            sectionKeys.sort(numericAsc);
            var runStart = 0;
            for (var si = 0; si < sectionKeys.length; si++) {
                if (si === sectionKeys.length - 1 || sectionKeys[si + 1] !== sectionKeys[si] + 1) {
                    var pKey = sectionKeys[runStart] + '-' + sectionKeys[si];
                    var pattern = patternByKey[pKey];
                    if (!pattern) {
                        pattern = { start: sectionKeys[runStart], end: sectionKeys[si], weeks: [] };
                        patternByKey[pKey] = pattern;
                        patterns.push(pattern);
                    }
                    pattern.weeks.push(weekKeys[wi]);
                    runStart = si + 1;
                }
            }
        }
        var owner = courseOf(g.name, g.teacher);
        for (var pi = 0; pi < patterns.length; pi++) {
            var runs = runsOf(patterns[pi].weeks);
            for (var ri = 0; ri < runs.length; ri++) {
                if (runs[ri].end > maxWeek) maxWeek = runs[ri].end;
                if (patterns[pi].end > maxPeriod) maxPeriod = patterns[pi].end;
                owner.blocks.push({
                    dayOfWeek: g.day,
                    startPeriod: patterns[pi].start,
                    endPeriod: patterns[pi].end,
                    startWeek: runs[ri].start,
                    endWeek: runs[ri].end,
                    weekType: runs[ri].weekType,
                    location: g.location || null
                });
            }
        }
    }
    for (var ci = 0; ci < courses.length; ci++) {
        courses[ci].blocks.sort(function (a, b) {
            return (a.dayOfWeek - b.dayOfWeek) || (a.startPeriod - b.startPeriod) ||
                (a.endPeriod - b.endPeriod) || (a.startWeek - b.startWeek);
        });
    }

    var name0 = termName();
    if (!data.hasTable) {
        throw new Error('教务系统没有返回这个学期（' + shortName(name0) + '）的课表页：可能这个学期还没有排课，也可能登录状态已失效；请在教务系统里确认能看到课表后再点「提取课表」');
    }
    if (!anyContent) {
        throw new Error('这个学期（' + shortName(name0) + '）在教务系统里还没有课；如果要导入别的学期，请在教务页面里切换学期后再点「提取课表」');
    }
    if (!courses.length) {
        throw new Error('教务系统返回了课表，但没有一门课能读成课程（课表页面的格式可能改过）：请把这个问题反馈给我们，并附上教务系统里课表页的截图');
    }

    var payloadCourses = [];
    for (var pc = 0; pc < courses.length; pc++) {
        payloadCourses.push({
            name: courses[pc].name,
            teacher: courses[pc].teacher,
            note: null,
            blocks: courses[pc].blocks
        });
    }

    var fromSchool = startFromSchool();
    var estimated = estimateStart();
    var firstDay = fromSchool && fromSchool.iso ? fromSchool.iso : (estimated ? estimated.iso : null);
    if (!firstDay) {
        throw new Error('没能确定这个学期的开学日期，课表无法导入：请回到教务系统的课表页再点「提取课表」，如果仍然这样，请把这个问题反馈给我们');
    }

    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    var periodTimes = PERIOD_TIMES.slice(0);
    var bySequence = [];
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) break;
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }
    var uncoveredPeriods = [];
    for (var used in usedPeriods) {
        if (Object.prototype.hasOwnProperty.call(usedPeriods, used)) {
            var usedIndex = parseInt(used, 10);
            if (!periodTimes[usedIndex - 1]) uncoveredPeriods.push(usedIndex);
        }
    }
    uncoveredPeriods.sort(numericAsc);

    var source = text(term.source);
    var warningTermName = shortName(name0);
    if (source === 'page') {
        warn('只导入了教务页面上当前选中的学期（' + warningTermName + '）；要导入别的学期，请先在教务系统里切到那个学期再点「提取课表」');
    } else if (source === 'list-first') {
        warn('没能从教务页面读到当前学期，今天的日期对应的学期也不在教务系统的学期列表里，已导入列表里的第一个学期「' + warningTermName + '」；如果不是你要的学期，请在教务系统里切到那个学期再点「提取课表」');
    } else {
        warn('没能从教务页面读到当前学期，已按今天的日期判断为「' + warningTermName + '」；如果不是你要的学期，请在教务系统里切到那个学期再点「提取课表」');
    }

    if (fromSchool && fromSchool.iso) {
        warn('第 1 周的开始日期（' + firstDay + '）是从教务系统第 1 周的周课表里读出来的，没法向你确认，请在学期管理里核对是不是学校实际的开学日');
    } else if (fromSchool && fromSchool.bad) {
        warn('教务系统周课表里读到的开学日期（' + shortName(fromSchool.bad) + '）不是周一或不在合理的月份里，已不采用；第 1 周按「' + estimated.rule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日');
    } else {
        warn('教务系统没有给出开学日期，第 1 周按「' + estimated.rule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日');
    }

    if (raisedBySchedule) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' + totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') + '，如与实际不符可在学期管理里改');
    } else {
        warn('教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    }

    var usedFilled = [];
    for (var bf = 0; bf < bySequence.length; bf++) {
        if (usedPeriods[bySequence[bf]]) usedFilled.push(bySequence[bf]);
    }
    if (usedFilled.length) {
        warn('课表用到了' + sectionsText(usedFilled) + '，学校公布的节次时间没有覆盖，已补上：按上一节下课后课间 ' + EXTEND_BREAK_MINUTES + ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推，请在学期管理里核对');
    }
    if (uncoveredPeriods.length) {
        warn('课表用到了' + sectionsText(uncoveredPeriods) + '，这些节次的时间无法顺推（会越过当天 23:59），课程已导入，请在学期管理里补上');
    }

    var skippedCourses = unreadable.time + unreadable.week + unreadable.section;
    if (skippedCourses > 0) {
        var reasons = [];
        if (unreadable.time) reasons.push('找不到方括号里的节次 ' + unreadable.time + ' 条');
        if (unreadable.week) reasons.push('周次认不出或全超出 1-' + MAX_WEEK + ' 周 ' + unreadable.week + ' 条');
        if (unreadable.section) reasons.push('节次认不出 ' + unreadable.section + ' 条');
        var sampleTexts = [];
        for (var us = 0; us < unreadableSamples.length; us++) sampleTexts.push('「' + unreadableSamples[us] + '」');
        warn('有 ' + skippedCourses + ' 条课程内容没能读成课程（' + reasons.join('、') + '），已跳过，例如 ' + sampleTexts.join('') + '：如发现少课请反馈');
    }
    if (badDayCourses > 0) {
        warn('有 ' + badDayCourses + ' 门课所在的格子超出了星期一到星期日的范围（认不出是星期几），这些课已跳过：如发现少课请反馈');
    }
    if (strayCells > 0) {
        warn('有 ' + strayCells + ' 个格子里有可见文字，但排版和预期不一样，这些格子没有导入：如发现少课请反馈');
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownFieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownFieldNames.push(shortName(fieldSamples[fs]));
        var emptyText = missingTeacher > 0 && missingLocation > 0 ? '教师或地点暂时空着' : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shownFieldNames.join('、') + '）：已照常导入，' + emptyText + '，可在「编辑课程」里补上');
    }
    if (trailingCount > 0) {
        warn('有 ' + trailingCount + ' 门课在节次或地点后面还有别的文字（如「' + trailingSample + '」），这部分没有导入');
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + noteSample + '」）不是周次，已忽略，请核对这几门课的周次');
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
        terms: [{
            name: name0,
            firstDay: firstDay,
            totalWeeks: totalWeeks,
            periodTimes: periodTimes,
            courses: payloadCourses
        }]
    });
})()
