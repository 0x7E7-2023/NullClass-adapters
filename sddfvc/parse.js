(function () {
    // 山东药品食品职业学院教务适配器（移动端逐周课表）—— 第二步：纯转换。
    // 移植自 shiguang_warehouse 的 SDDFVC/sddfvc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e；本校脚本最后修改 14cb2ca
    // 模板 wzzy 仅提供周次极大段、按周矩阵合并、提醒限长等通用思路；取数与记录结构不同构。
    // 移植改动：逐周内容先按完整记录去重；课名按第一个 # 两侧是否含「班」处理；
    // 槽位 1/3/5/7/9/11 映射第 1～6 节；周次按 dsz=1/2 过滤单双周；
    // 周历给出总周数与第 1 周日期，缺失时推算并提醒；失败周、未知槽位、坏周次均汇总提醒；
    // 缺教师或教室保留课程并置空；学校公布的 6 节时间逐节照抄上游。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var calendar = Array.isArray(data.calendar) ? data.calendar : [];
    var responses = Array.isArray(data.responses) ? data.responses : [];
    var failedWeeks = Array.isArray(data.failedWeeks) ? data.failedWeeks : [];
    var SCHOOL_NAME = '山东药品食品职业学院';
    var MAX_WEEK = 30;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var SECTION_MAP = { '1': 1, '3': 2, '5': 3, '7': 4, '9': 5, '11': 6 };
    var PLACEHOLDER = /^(未知|未知教师|未知教室|未知地点|待定|暂无|暂无教师|暂无教室|无)$/;
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:30', end: '10:00' },
        { periodIndex: 2, start: '10:15', end: '11:45' },
        { periodIndex: 3, start: '13:30', end: '15:00' },
        { periodIndex: 4, start: '15:15', end: '16:45' },
        { periodIndex: 5, start: '19:00', end: '19:30' },
        { periodIndex: 6, start: '20:00', end: '20:45' }
    ];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function shortName(value) {
        var line = text(value);
        return line.length > 20 ? line.substring(0, 19) + '…' : line;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function mondayOnOrBefore(date) {
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
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

    function countKeys(dict) {
        var count = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) count++;
        }
        return count;
    }

    function sampleNames(dict) {
        var out = [];
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key) && out.length < 3) out.push(shortName(key.substring(1)));
        }
        return out;
    }

    // 与上游 extractCourseName 一致：只看第一个 # 的两侧；两侧都含或都不含「班」时保留完整原文。
    function courseName(raw) {
        var source = text(raw);
        if (!source) return '';
        var at = source.indexOf('#');
        if (at < 0) return source;
        var left = source.substring(0, at);
        var right = source.substring(at + 1);
        var leftClass = left.indexOf('班') >= 0;
        var rightClass = right.indexOf('班') >= 0;
        if (leftClass && !rightClass) return text(right);
        if (rightClass && !leftClass) return text(left);
        return source;
    }

    var droppedWeeks = 0;
    var badWeekParts = 0;
    function weeksOf(source, parityValue) {
        var cleaned = text(source).replace(/[，、；]/g, ',');
        var parity = parseInt(parityValue, 10);
        var seen = {};
        var weeks = [];
        if (!cleaned) { badWeekParts++; return weeks; }
        var parts = cleaned.split(',');
        for (var i = 0; i < parts.length; i++) {
            var part = text(parts[i]);
            if (!part) continue;
            var match = /^([0-9]+)\s*(?:-\s*([0-9]+))?$/.exec(part);
            if (!match) { badWeekParts++; continue; }
            var start = parseInt(match[1], 10);
            var end = match[2] ? parseInt(match[2], 10) : start;
            if (end < start) { badWeekParts++; continue; }
            for (var week = start; week <= end; week++) {
                if (parity === 1 && week % 2 === 0) continue;
                if (parity === 2 && week % 2 === 1) continue;
                if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
                if (!seen[week]) { seen[week] = true; weeks.push(week); }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2 ? 2 : 1;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j], weekType: 'ALL' };
            if (step === 2 && run.start !== run.end) run.weekType = run.start % 2 ? 'ODD' : 'EVEN';
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    var groups = [];
    var groupByKey = {};
    var seenDetails = {};
    var emptySeen = {};
    var missingTeacher = {};
    var missingLocation = {};
    var fieldSamples = {};
    var badDay = 0;
    var unknownSlot = 0;
    var noName = 0;
    var noWeeks = 0;
    var noDetail = 0;
    var skippedSamples = {};
    var maxWeek = 0;

    function noteSkipped(name) {
        if (name) skippedSamples['n' + name] = true;
    }

    function groupOf(name, teacher, location, day) {
        var key = JSON.stringify([name, teacher, location, day]);
        if (groupByKey[key]) return groupByKey[key];
        var group = { name: name, teacher: teacher, location: location, day: day, matrix: {} };
        groupByKey[key] = group;
        groups.push(group);
        return group;
    }

    // 同一明细会在逐周响应里反复出现。先按内容去重，再解析和计数，避免重复课与放大的提醒。
    for (var r = 0; r < responses.length; r++) {
        var entries = responses[r] && Array.isArray(responses[r].entries) ? responses[r].entries : [];
        for (var e = 0; e < entries.length; e++) {
            var entry = entries[e] || {};
            var details = Array.isArray(entry.details) ? entry.details : [];
            if (!details.length) {
                // 排课项没有明细时一条也进不了课；同一格子在每周响应里重复，按内容去重后只计一次。
                var emptyKey = JSON.stringify([entry.day, entry.slot, entry.rawName]);
                if (!emptySeen[emptyKey]) {
                    emptySeen[emptyKey] = true;
                    noDetail++;
                    noteSkipped(courseName(entry.rawName));
                }
                continue;
            }
            for (var d = 0; d < details.length; d++) {
                var detail = details[d] || {};
                var rawKey = JSON.stringify([
                    entry.day, entry.slot, entry.rawName, detail.weeks,
                    detail.parity, detail.teacher, detail.location
                ]);
                if (seenDetails[rawKey]) continue;
                seenDetails[rawKey] = true;
                var name = courseName(entry.rawName);
                if (!name) { noName++; continue; }
                var day = parseInt(entry.day, 10);
                if (!(day >= 1 && day <= 7)) { badDay++; continue; }
                var section = SECTION_MAP[text(entry.slot)];
                if (!section) { unknownSlot++; noteSkipped(name); continue; }
                var weeks = weeksOf(detail.weeks, detail.parity);
                if (!weeks.length) { noWeeks++; noteSkipped(name); continue; }
                var teacher = text(detail.teacher);
                var location = text(detail.location);
                if (PLACEHOLDER.test(teacher)) teacher = '';
                if (PLACEHOLDER.test(location)) location = '';
                if (!teacher) missingTeacher['n' + name] = true;
                if (!location) missingLocation['n' + name] = true;
                if (!teacher || !location) fieldSamples['n' + name] = true;
                var group = groupOf(name, teacher, location, day);
                for (var w = 0; w < weeks.length; w++) {
                    if (weeks[w] > maxWeek) maxWeek = weeks[w];
                    if (!group.matrix[weeks[w]]) group.matrix[weeks[w]] = {};
                    group.matrix[weeks[w]][section] = true;
                }
            }
        }
    }

    var courses = [];
    var courseByKey = {};
    function courseOf(name, teacher) {
        var key = JSON.stringify([name, teacher]);
        if (courseByKey[key]) return courseByKey[key];
        var course = { name: name, teacher: teacher || null, note: null, blocks: [] };
        courseByKey[key] = course;
        courses.push(course);
        return course;
    }

    for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        var weekKeys = [];
        for (var weekKey in group.matrix) {
            if (Object.prototype.hasOwnProperty.call(group.matrix, weekKey)) weekKeys.push(parseInt(weekKey, 10));
        }
        weekKeys.sort(function (a, b) { return a - b; });
        var patterns = [];
        var patternByKey = {};
        for (var wi = 0; wi < weekKeys.length; wi++) {
            var sectionKeys = [];
            for (var sectionKey in group.matrix[weekKeys[wi]]) {
                if (Object.prototype.hasOwnProperty.call(group.matrix[weekKeys[wi]], sectionKey)) {
                    sectionKeys.push(parseInt(sectionKey, 10));
                }
            }
            sectionKeys.sort(function (a, b) { return a - b; });
            var runStart = 0;
            for (var si = 0; si < sectionKeys.length; si++) {
                if (si === sectionKeys.length - 1 || sectionKeys[si + 1] !== sectionKeys[si] + 1) {
                    var patternKey = sectionKeys[runStart] + '-' + sectionKeys[si];
                    if (!patternByKey[patternKey]) {
                        patternByKey[patternKey] = { start: sectionKeys[runStart], end: sectionKeys[si], weeks: [] };
                        patterns.push(patternByKey[patternKey]);
                    }
                    patternByKey[patternKey].weeks.push(weekKeys[wi]);
                    runStart = si + 1;
                }
            }
        }
        var owner = courseOf(group.name, group.teacher);
        for (var p = 0; p < patterns.length; p++) {
            var runs = runsOf(patterns[p].weeks);
            for (var ri = 0; ri < runs.length; ri++) {
                owner.blocks.push({
                    dayOfWeek: group.day,
                    startPeriod: patterns[p].start,
                    endPeriod: patterns[p].end,
                    startWeek: runs[ri].start,
                    endWeek: runs[ri].end,
                    weekType: runs[ri].weekType,
                    location: group.location || null
                });
            }
        }
    }
    for (var c = 0; c < courses.length; c++) {
        courses[c].blocks.sort(function (a, b) {
            return (a.dayOfWeek - b.dayOfWeek) || (a.startPeriod - b.startPeriod) ||
                (a.endPeriod - b.endPeriod) || (a.startWeek - b.startWeek) ||
                (a.endWeek - b.endWeek) || (a.weekType < b.weekType ? -1 : (a.weekType > b.weekType ? 1 : 0));
        });
    }

    var termName = text(term.name);
    if (!termName) termName = SCHOOL_NAME + ' 当前学期';
    if (!courses.length) {
        throw new Error('没有读到能导入的课程：可能课表尚未发布、各周课表为空，或课表格式已经变化；请在教务系统确认能看到课程后再试');
    }

    // 学期名给出起止两个自然年：第一学期用起始年，第二学期用结束年；第一学期 1～6 月的周次已经跨到下一自然年。
    // 日期统一回退到周一，符合空课第 1 周从周一开始的约定。这两条月份调整是移植件自加，上游没有。
    var yearMatch = /([0-9]{4})\s*-\s*([0-9]{4})/.exec(termName);
    var termKind = /第二学期/.test(termName) ? 'second' : 'first';

    function weekNumberOf(value) {
        var source = text(value);
        if (!/^[0-9]+$/.test(source)) return 0;
        var number = parseInt(source, 10);
        return number >= 1 ? number : 0;
    }

    function calendarDateOf(item) {
        if (!yearMatch) return null;
        var match = /^([0-9]{1,2})\/([0-9]{1,2})$/.exec(text(item && item.startDate));
        if (!match) return null;
        var month = parseInt(match[1], 10);
        var day = parseInt(match[2], 10);
        var year = parseInt(yearMatch[1], 10) + (termKind === 'second' ? 1 : 0);
        if (termKind === 'first' && month <= 6) year++;
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
        return date;
    }

    var schoolDate = null;
    var schoolDateNote = '';
    var firstCandidate = null;
    var firstWeekNumber = 0;
    for (var cal = 0; cal < calendar.length; cal++) {
        var weekNumber = weekNumberOf(calendar[cal] && calendar[cal].id);
        var candidate = calendarDateOf(calendar[cal]);
        if (!weekNumber || !candidate) continue;
        if (!firstCandidate || weekNumber < firstWeekNumber) {
            firstCandidate = candidate;
            firstWeekNumber = weekNumber;
        }
        if (weekNumber === 1) break;
    }
    if (firstCandidate) {
        if (firstWeekNumber !== 1) {
            firstCandidate = new Date(firstCandidate.getTime() - (firstWeekNumber - 1) * 7 * 86400000);
            schoolDateNote = 'missing-first';
        }
        var aligned = mondayOnOrBefore(firstCandidate);
        schoolDate = isoOf(aligned);
        if (isoOf(firstCandidate) !== schoolDate && !schoolDateNote) schoolDateNote = 'aligned';
    }
    if (!schoolDate && yearMatch) {
        var anchorYear = parseInt(yearMatch[1], 10) + (termKind === 'second' ? 1 : 0);
        var anchor = termKind === 'second' ? { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' } :
            { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' };
        schoolDate = isoOf(mondayOnOrBefore(new Date(Date.UTC(anchorYear, anchor.month - 1, anchor.day))));
        schoolDateNote = 'estimated';
    }
    if (!schoolDate) {
        throw new Error('没能确定学期和开学日期：请回到教务课表页重新进入，再点「提取课表」');
    }

    // 总周数按真实周号和日期跨度计算，不能用列表长度或下标：缺第 1 周或中间缺号都不会缩短校历。
    function calendarWeekCount() {
        var byNumbers = 0;
        var byDates = 0;
        var startMatch = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(schoolDate);
        var startTime = Date.UTC(parseInt(startMatch[1], 10), parseInt(startMatch[2], 10) - 1, parseInt(startMatch[3], 10));
        for (var i = 0; i < calendar.length; i++) {
            var number = weekNumberOf(calendar[i] && calendar[i].id);
            if (number > byNumbers) byNumbers = number;
            var date = calendarDateOf(calendar[i]);
            if (!date) continue;
            var mondayTime = mondayOnOrBefore(date).getTime();
            if (mondayTime < startTime) continue;
            var fromDate = Math.floor((mondayTime - startTime) / (7 * 86400000)) + 1;
            if (fromDate > byDates) byDates = fromDate;
        }
        return { weeks: Math.max(byNumbers, byDates), source: byDates > byNumbers ? 'dates' : 'calendar' };
    }

    var calendarTotal = calendarWeekCount();
    var totalWeeks = calendarTotal.weeks >= 1 ? calendarTotal.weeks : 20;
    var totalNote = calendarTotal.weeks >= 1 ? calendarTotal.source : 'fallback';
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        totalNote = calendarTotal.weeks >= 1 ? 'raised' : 'fallback-raised';
    }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; totalNote = 'clamped'; }

    warn('已按教务系统标注的当前学期「' + shortName(termName) + '」导入；要导入别的学期，请先在教务系统里切换后再点「提取课表」');
    if (schoolDateNote === 'estimated') {
        warn('教务系统没有给出可用的开学日期，第 1 周按「' + anchor.rule + '」推算为 ' + schoolDate + '，请在学期管理里核对');
    } else if (schoolDateNote === 'missing-first') {
        warn('教务周次列表没有第 1 周，已按首个周次的开始日期和周号倒推，并回退到周一 ' + schoolDate + '，请在学期管理里核对');
    } else if (schoolDateNote === 'aligned') {
        warn('教务第 1 周不是从周一开始，已回退到周一 ' + schoolDate + ' 作为第 1 周开始日期，请在学期管理里核对');
    } else {
        warn('第 1 周开始日期（' + schoolDate + '）来自教务周次列表，请在学期管理里核对');
    }
    if (totalNote === 'fallback') {
        warn('教务系统没有给出可用的学期总周数，已按 20 周导入；如与实际不符请在学期管理里修改');
    } else if (totalNote === 'dates') {
        warn('教务周次缺少完整周号，已按周历日期跨度计算为 ' + totalWeeks + ' 周，请在学期管理里核对');
    } else if (totalNote === 'raised') {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过教务周次列表，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对');
    } else if (totalNote === 'fallback-raised') {
        warn('教务系统没有给出可用的学期总周数；课表最晚排到第 ' + maxWeek + ' 周，已按 ' + totalWeeks + ' 周导入，请在学期管理里核对');
    } else if (totalNote === 'clamped') {
        warn('教务周历或课表超过 ' + MAX_WEEK + ' 周，学期总周数已按 ' + MAX_WEEK + ' 周导入，请在学期管理里核对');
    }
    if (failedWeeks.length) {
        var failedText = [];
        var failedShown = failedWeeks.length < 10 ? failedWeeks.length : 10;
        for (var f = 0; f < failedShown; f++) failedText.push(text(failedWeeks[f]));
        warn('第 ' + failedText.join('、') +
            (failedWeeks.length > failedShown ? ' 等共 ' + failedWeeks.length + ' 周' : ' 周') +
            '课表获取失败，这些周可能有课程未导入，请重新提取；如仍失败请反馈');
    }
    if (badDay) warn('有 ' + badDay + ' 条课程记录认不出上课星期，已跳过；如发现少课请反馈');
    var skipped = noName + unknownSlot + noWeeks + noDetail;
    if (skipped) {
        var reasons = [];
        if (noName) reasons.push('没有课名 ' + noName + ' 条');
        if (unknownSlot) reasons.push('节次位置认不出 ' + unknownSlot + ' 条');
        if (noWeeks) reasons.push('周次认不出 ' + noWeeks + ' 条');
        if (noDetail) reasons.push('没有排课明细 ' + noDetail + ' 条');
        var skippedNames = sampleNames(skippedSamples);
        warn('有 ' + skipped + ' 条课程记录没能导入（' + reasons.join('、') + '）' +
            (skippedNames.length ? '，例如 ' + skippedNames.join('、') : '') + '；如发现少课请反馈');
    }
    var teacherCount = countKeys(missingTeacher);
    var locationCount = countKeys(missingLocation);
    if (teacherCount || locationCount) {
        var fields = [];
        if (teacherCount) fields.push(teacherCount + ' 门课没给教师');
        if (locationCount) fields.push(locationCount + ' 门课没给教室');
        var fieldNames = sampleNames(fieldSamples);
        warn('有 ' + fields.join('、') + '（例如 ' + fieldNames.join('、') + '）：已照常导入，对应内容暂时空着，可在「编辑课程」里补上');
    }
    if (badWeekParts) warn('有 ' + badWeekParts + ' 段周次写法认不出，已忽略这些写法；请核对是否少课');
    if (droppedWeeks) warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃；请核对教务课表');
    if (droppedWarnings) warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [{
            name: termName,
            firstDay: schoolDate,
            totalWeeks: totalWeeks,
            periodTimes: PERIOD_TIMES,
            courses: courses
        }]
    });
})()
