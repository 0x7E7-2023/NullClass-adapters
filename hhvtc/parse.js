(function () {
    // 怀化职业技术学院教务适配器（青果教务，隐藏课表详情）—— 第二步：原始详情 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 HHVTC/hhvt.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03 对齐 origin/main），本校脚本最后一次修改 80e30cf
    //
    // 输入为 { today, details }；每项详情只有 name / teacher / timeText / location 四个白名单字段。
    // 本文件不访问页面、不请求网络、不提问，全部转换均可在 Rhino 中重放。
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 上课时间「[周次]星期[起止节次]」在此解析；星期几、周一至周日与裸汉字星期均兼容，节次必须有效；周次支持多段、单双周与「共 N 周」备注。
    //   ② 周次显式集合按连续、单周、双周极大段转换；同课同教师同地点同星期同节次先合并周次，完全重复详情先去重。
    //   ③ 教师与地点的「未知」「待定」「暂无」等占位词转为 null；缺失课程照常导入并按类型汇总提醒。
    //   ④ 上游未提供学年学期、开学日与校历：按提取日期推学年学期，按 9 月 1 日或 2 月 20 日所在周推开学日，总周数先取 20；全部明确提醒。
    //   ⑤ 上游夏秋与冬春两张 8 节表逐节保留，按提取月份自动选择，不再弹窗；另一季节不混入同一张表。
    //   ⑥ 超出第 8 节时按课间 5 分钟、每节 45 分钟逐节顺推，不能落在当天内的节次保留课程但不补时间，并提醒。
    //   ⑦ 数据不全的详情不静默丢弃，按缺课程名、星期、节次、周次汇总；无法识别的周次原文截短后提醒；一格内连着写多个节次段时只导入第一段并计数提醒。
    //   ⑧ 所有提醒统一经过 200 字与 20 条收口，拼入的课名、学期名和周次原文先截到 20 字。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var details = Array.isArray(data.details) ? data.details : [];

    var SCHOOL_NAME = '怀化职业技术学院';
    var MAX_WEEK = 30;
    var MAX_PERIOD = 20;
    var DEFAULT_TOTAL_WEEKS = 20;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    var DAY_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    var BLANK_WORDS = { '未知': true, '待定': true, '暂无': true, '暂无教师': true, '暂无教室': true };

    // 上游 HHVT_TIME_SLOTS_SUMMER，5 月 1 日起，逐节照抄。
    var SUMMER_TIMES = [
        { periodIndex: 1, start: '08:10', end: '08:55' },
        { periodIndex: 2, start: '09:05', end: '09:50' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:25', end: '16:10' },
        { periodIndex: 7, start: '16:20', end: '17:05' },
        { periodIndex: 8, start: '17:15', end: '18:00' }
    ];
    // 上游 HHVT_TIME_SLOTS_WINTER，10 月 1 日起，逐节照抄。
    var WINTER_TIMES = [
        { periodIndex: 1, start: '08:20', end: '09:05' },
        { periodIndex: 2, start: '09:15', end: '10:00' },
        { periodIndex: 3, start: '10:20', end: '11:05' },
        { periodIndex: 4, start: '11:15', end: '12:00' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:55', end: '15:40' },
        { periodIndex: 7, start: '15:50', end: '16:35' },
        { periodIndex: 8, start: '16:45', end: '17:30' }
    ];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function shortName(value) {
        var line = text(value);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    function realOrNull(value) {
        var line = text(value);
        return !line || BLANK_WORDS.hasOwnProperty(line) ? null : line;
    }

    function countKeys(dict) {
        var count = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) count++;
        }
        return count;
    }

    function pad2(number) {
        return (number < 10 ? '0' : '') + number;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
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

    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // 上游没有学期文字与开学日，只能以提取日期为锚点；所有推算值都在提醒中说明。
    function termInfo(todayIso) {
        var today = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text(todayIso)) ? text(todayIso) : localTodayIso();
        var year = parseInt(today.substring(0, 4), 10);
        var month = parseInt(today.substring(5, 7), 10);
        var academicYear = month >= 8 ? year : year - 1;
        var first = month >= 8 || month <= 1;
        var startYear = first ? academicYear : academicYear + 1;
        var anchorMonth = first ? 9 : 2;
        var anchorDay = first ? 1 : 20;
        return {
            today: today,
            month: month,
            name: SCHOOL_NAME + ' ' + academicYear + '-' + (academicYear + 1) + '学年第' + (first ? '一' : '二') + '学期',
            firstDay: isoOf(mondayOnOrBefore(startYear, anchorMonth, anchorDay)),
            anchorRule: first ? '9 月 1 日所在那周的周一' : '2 月 20 日所在那周的周一'
        };
    }

    var droppedWeekRanges = 0;
    var orphanMarkers = 0;
    var serialGroups = 0;
    var noteGroups = 0;
    var noteSample = '';
    var bothMarks = 0;

    function fullWidthToHalf(source) {
        return source.replace(/[０-９]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
        }).replace(/（/g, '(').replace(/）/g, ')').replace(/[，、；;]/g, ',').replace(/[～~—－–至]/g, '-');
    }

    // 周次文字 → 去重升序集合。前置与后置单双标记分别归属相邻周次段。
    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        cleaned = cleaned.replace(/第/g, '');
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            if (/^\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
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
            if (/[^0-9\s,单双周第-]/.test(inner)) {
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
            if (text(tokens[i])) segments.push(text(tokens[i]));
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
            segments[into] += segments[i];
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
                var from = Math.max(1, start);
                var to = Math.min(MAX_WEEK, end);
                if (from !== start || to !== end) droppedWeekRanges++;
                for (var week = from; week <= to; week++) {
                    if (onlyOdd && week % 2 === 0) continue;
                    if (onlyEven && week % 2 === 1) continue;
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
        var all = a.concat(b);
        var seen = {};
        var result = [];
        for (var i = 0; i < all.length; i++) {
            if (seen[all[i]]) continue;
            seen[all[i]] = true;
            result.push(all[i]);
        }
        return result.sort(function (x, y) { return x - y; });
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

    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var multiSegment = 0;
    var weekSamples = [];
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var slots = {};
    var slotList = [];
    var seenDetails = {};
    var maxWeek = 0;
    var maxPeriod = 0;

    // 先按完整白名单内容去重，再解析与计数，重复详情不会放大提醒。
    for (var r = 0; r < details.length; r++) {
        var detail = details[r] || {};
        var rawName = text(detail.name);
        var rawTeacher = text(detail.teacher);
        var rawTime = text(detail.timeText);
        var rawLocation = text(detail.location);
        var detailKey = JSON.stringify([rawName, rawTeacher, rawTime, rawLocation]);
        if (seenDetails[detailKey]) continue;
        seenDetails[detailKey] = true;

        if (!rawName) { missing.name++; continue; }
        var dayMatch = /\[([^\]]*)\]\s*(?:星期|周)?([一二三四五六日天])/.exec(rawTime);
        if (!dayMatch) { missing.day++; continue; }
        var afterDay = rawTime.substring(dayMatch.index + dayMatch[0].length);
        var sectionMatch = /\[\s*([0-9]{1,2})\s*(?:-\s*([0-9]{1,2}))?\s*节\s*\]/.exec(afterDay);
        if (!sectionMatch) { missing.period++; continue; }
        var startPeriod = parseInt(sectionMatch[1], 10);
        var endPeriod = sectionMatch[2] ? parseInt(sectionMatch[2], 10) : startPeriod;
        if (startPeriod < 1 || startPeriod > endPeriod || endPeriod > MAX_PERIOD) { missing.period++; continue; }
        // 一格里的时间只解析第一段；若后面还跟着第二个节次段，必须数出来提醒，不能静默丢课。
        if (/\[\s*[0-9]{1,2}\s*(?:-\s*[0-9]{1,2})?\s*节\s*\]/.test(
                afterDay.substring(sectionMatch.index + sectionMatch[0].length))) {
            multiSegment++;
        }
        var weeks = weeksOf(dayMatch[1]);
        if (!weeks.length) {
            missing.week++;
            if (text(dayMatch[1]) && weekSamples.length < 3 && weekSamples.indexOf(text(dayMatch[1])) < 0) {
                weekSamples.push(text(dayMatch[1]));
            }
            continue;
        }

        var teacher = realOrNull(rawTeacher);
        var location = realOrNull(rawLocation);
        if (!teacher) missingTeacherCourses['n' + rawName] = true;
        if (!location) missingLocationCourses['n' + rawName] = true;
        if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(rawName) < 0) fieldSamples.push(rawName);

        var slotKey = JSON.stringify([rawName, teacher || '', location || '', DAY_MAP[dayMatch[2]], startPeriod, endPeriod]);
        var slot = slots[slotKey];
        if (!slot) {
            slot = { name: rawName, teacher: teacher, location: location, day: DAY_MAP[dayMatch[2]],
                start: startPeriod, end: endPeriod, weeks: [] };
            slots[slotKey] = slot;
            slotList.push(slot);
        }
        slot.weeks = unionWeeks(slot.weeks, weeks);
    }

    var courseByKey = {};
    var payloadCourses = [];
    for (var s = 0; s < slotList.length; s++) {
        var item = slotList[s];
        var courseKey = JSON.stringify([item.name, item.teacher || '']);
        var course = courseByKey[courseKey];
        if (!course) {
            course = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            courseByKey[courseKey] = course;
            payloadCourses.push(course);
        }
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            if (run.end > maxWeek) maxWeek = run.end;
            course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item.location
            });
        }
        if (item.end > maxPeriod) maxPeriod = item.end;
    }

    if (!payloadCourses.length) {
        throw new Error('这个课表页没有解析到任何课程：可能当前学期还没排课，也可能打开的不是本人的课表查询页。请确认能看到课程后再试');
    }

    var term0 = termInfo(data.today);
    var totalWeeks = DEFAULT_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }

    var summer = term0.month >= 5 && term0.month <= 9;
    var periodTimes = (summer ? SUMMER_TIMES : WINTER_TIMES).slice(0);
    var sequential = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var previousEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var nextStart = previousEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        sequential.push(p);
    }

    warn('教务课表页没有给出可读取的学年学期和开学日期，已按提取当天推为「' + shortName(term0.name) +
        '」，第 1 周按「' + term0.anchorRule + '」推算为 ' + term0.firstDay + '，请在学期管理里核对');
    if (raisedBySchedule) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过 ' + DEFAULT_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
    } else {
        warn('教务系统没有给出学期校历，学期总周数按 ' + DEFAULT_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    }
    warn('已按提取当天（' + term0.today + '）选择' + (summer ? '夏秋季（5 月至 9 月）' : '冬春季（10 月至次年 4 月）') +
        '节次时间；学校调整或查询其他学期时可能不同，请在学期管理里核对');
    if (sequential.length) {
        warn('课表用到了' + sectionsText(sequential) + '，学校节次时间只列到第 8 节，已按上一节下课后课间 5 分钟、' +
            '每节 45 分钟顺推补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间' +
            '（课程已导入），请在学期管理里补上');
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 条');
        if (missing.day) reasons.push('缺星期或星期无法识别 ' + missing.day + ' 条');
        if (missing.period) reasons.push('缺节次或节次超出 1-' + MAX_PERIOD + ' 节 ' + missing.period + ' 条');
        if (missing.week) reasons.push('缺周次或周次全超出 1-' + MAX_WEEK + ' 周 ' + missing.week + ' 条');
        warn('有 ' + skipped + ' 条课表安排数据不全（' + reasons.join('、') + '），已跳过：教务数据不完整时会出现，如发现少课请反馈');
    }
    if (multiSegment > 0) {
        warn('有 ' + multiSegment + ' 条课程时间在一个格子里连着写了多个节次段，只导入了第一段，后面的节次段没有导入：' +
            '请对照教务系统确认，如发现少课请把这条时间原文反馈给我们');
    }
    if (weekSamples.length) {
        var sampleTexts = [];
        for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push('「' + shortName(weekSamples[ws]) + '」');
        warn('认不出的周次写法有：' + sampleTexts.join('、') + '，这些时段没有导入，请对照教务系统手动添加');
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var fieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) fieldNames.push(shortName(fieldSamples[fs]));
        warn('有 ' + fieldParts.join('、') + '（例如 ' + fieldNames.join('、') + '）：已照常导入，空着的项可在「编辑课程」里补上');
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处周次括号里只写了数字，已按教学班序号忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，已忽略，请核对这几门课的周次');
    }
    if (droppedWeekRanges > 0) {
        warn('有 ' + droppedWeekRanges + ' 处周次区间超出 1-' + MAX_WEEK + ' 周，超出部分已丢弃，请对照教务系统核对');
    }
    if (orphanMarkers > 0) {
        warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次，这些标记已忽略，请对照教务系统核对');
    }
    if (bothMarks > 0) {
        warn('有 ' + bothMarks + ' 处周次里「单」「双」同时出现，已按每周都上处理，请对照教务系统核对');
    }
    if (droppedWarnings > 0) {
        warnings[MAX_WARNINGS - 1] = '另有 ' + (droppedWarnings + 1) + ' 条核对提示超出上限未显示';
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [{
            name: term0.name,
            firstDay: term0.firstDay,
            totalWeeks: totalWeeks,
            periodTimes: periodTimes,
            courses: payloadCourses
        }]
    });
})()
