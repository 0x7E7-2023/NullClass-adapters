(function () {
    // 河北农业大学教务适配器（金智 jwapp / 我的课表 wdkb）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 HEBAU/hebau.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 baf83fa，本校脚本最后一次修改 c60b8f7（2026-10-08）。
    // 输入是 extract.js 的 { term, today, calendarRows, sectionRows, rows }；
    // 每行只有 KCM / SKJS / JASMC / SKXQ / KSJC / JSJC / SKZC。
    //
    // 移植改动：
    //   1. SKZC 位串第 1 位对应第 1 周；按连续、单周、双周切成极大段，第 31 周起丢弃并提醒。
    //   2. 同课同教师同地点同星期同节次取周次并集，连堂不合并；重复原始行先去重再计数。
    //   3. 教师教室占位词交空，缺了照常导入并按类型汇总；不完整行跳过但计数提醒。
    //   4. 当前学期由 extract 读教务或按日期推算；学期列表核对结果写进提醒，不静默。
    //   5. 开学日与总周数读校历 XQKSRQ / ZZC / ZJXZC；缺失时开学日回退周一、总周数用 20，更晚课周才抬高。
    //   6. 节次时间读教务 jc.do；取不到交空表由应用用默认节次时间；表外节次按统一修订 H3 逐节顺推。
    //   7. 学期名用教务给的文本，拿不到用「学校名 + 学年学期」；提醒原文截 20 字，统一出口限 20 条、每条 200 字。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = data.rows instanceof Array ? data.rows : [];
    var calendarRows = data.calendarRows instanceof Array ? data.calendarRows : [];
    var sectionRows = data.sectionRows instanceof Array ? data.sectionRows : [];

    var SCHOOL = '河北农业大学';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var CLASS_MINUTES = 45;
    var BREAK_MINUTES = 5;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;

    var EMPTY_WORD = {
        '未知': true, '未知教师': true, '未知老师': true, '未知地点': true, '未知教室': true,
        '待定': true, '暂无': true, '暂无教师': true, '暂无老师': true, '暂无教室': true, '暂无地点': true
    };

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

    function mondayOf(iso) {
        var milliseconds = utcOfIso(iso);
        if (milliseconds === null) return null;
        var date = new Date(milliseconds);
        var offset = (date.getUTCDay() + 6) % 7;
        return isoOf(new Date(milliseconds - offset * 86400000));
    }

    // 'HH:mm' / 'H:mm' / 'HH:mm:ss' → 'HH:mm'；不合法返回 null
    function hhmmOf(value) {
        var match = /^([0-9]{1,2}):([0-9]{2})(:[0-9]{2})?$/.exec(text(value));
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

    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) {
            droppedWarnings++;
            return;
        }
        warnings.push(line);
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

    // 与上游 parseWeeks 一致：只看每个位置是不是字符 1，下标从第 1 周起。
    function weeksOf(bitmap) {
        var source = bitmap === null || bitmap === undefined ? '' : String(bitmap);
        var weeks = [];
        var dropped = 0;
        for (var i = 0; i < source.length; i++) {
            if (source.charAt(i) !== '1') continue;
            if (i + 1 > MAX_WEEK) {
                dropped++;
            } else {
                weeks.push(i + 1);
            }
        }
        return { weeks: weeks, dropped: dropped };
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

    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var droppedWeeks = 0;
    var slots = {};
    var slotList = [];
    var seenRows = {};
    var maxWeek = 0;
    var maxPeriod = 0;
    var minPeriod = 0;

    function rememberFieldSample(name) {
        if (fieldSamples.length >= 3 || fieldSamples.indexOf(shortName(name)) >= 0) return;
        fieldSamples.push(shortName(name));
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var rowKey = JSON.stringify([text(row.KCM), text(row.SKJS), text(row.JASMC), text(row.SKXQ),
            text(row.KSJC), text(row.JSJC), text(row.SKZC)]);
        if (seenRows[rowKey]) continue;
        seenRows[rowKey] = true;

        var name = text(row.KCM);
        if (!name || name === '未知' || name === '未知课程') {
            missing.name++;
            continue;
        }
        var day = integerOf(row.SKXQ);
        if (!(day >= 1 && day <= 7)) {
            missing.day++;
            continue;
        }
        var startPeriod = integerOf(row.KSJC);
        var endPeriod = integerOf(row.JSJC);
        if (!(startPeriod >= 1 && endPeriod >= startPeriod && endPeriod <= MAX_PERIOD)) {
            missing.period++;
            continue;
        }
        var parsedWeeks = weeksOf(row.SKZC);
        droppedWeeks += parsedWeeks.dropped;
        if (!parsedWeeks.weeks.length) {
            missing.week++;
            continue;
        }
        var teacher = realOrNull(row.SKJS);
        var location = realOrNull(row.JASMC);
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if (!teacher || !location) rememberFieldSample(name);

        var slotKey = JSON.stringify([name, teacher || '', location || '', day, startPeriod, endPeriod]);
        var slot = slots[slotKey];
        if (!slot) {
            slot = { name: name, teacher: teacher, location: location, day: day,
                start: startPeriod, end: endPeriod, weeks: [] };
            slots[slotKey] = slot;
            slotList.push(slot);
        }
        slot.weeks = unionWeeks(slot.weeks, parsedWeeks.weeks);
    }

    // 与上游合并顺序一致：星期、开始节次、课名；连堂保持不同段。
    slotList.sort(function (a, b) {
        if (a.day !== b.day) return a.day - b.day;
        if (a.start !== b.start) return a.start - b.start;
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        if (a.end !== b.end) return a.end - b.end;
        var placeA = a.location || '';
        var placeB = b.location || '';
        return placeA < placeB ? -1 : (placeA > placeB ? 1 : 0);
    });

    var courseByKey = {};
    var courses = [];
    for (var s = 0; s < slotList.length; s++) {
        var item = slotList[s];
        var courseKey = JSON.stringify([item.name, item.teacher || '']);
        var course = courseByKey[courseKey];
        if (!course) {
            course = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            courseByKey[courseKey] = course;
            courses.push(course);
        }
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            if (runs[k].end > maxWeek) maxWeek = runs[k].end;
            course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: runs[k].start,
                endWeek: runs[k].end,
                weekType: runs[k].weekType,
                location: item.location
            });
        }
        if (item.end > maxPeriod) maxPeriod = item.end;
        if (!minPeriod || item.start < minPeriod) minPeriod = item.start;
    }

    if (!courses.length) {
        throw new Error('这个学期没有解析到任何课程：请在「我的课表」里确认个人课表已经显示，再重新提取');
    }

    var name0 = termName();

    // 当前学期怎么来的：教务给的、还是按本机日期推的；在不在学期列表里。都如实说。
    if (text(term.source) === 'guess') {
        warn('没读到教务给出的当前学年学期，已按本机日期推定为 ' + shortName(name0)
            + (term.listed === true ? '（与学校公布的学期列表一致）' : '') + '，请在学期管理里核对');
    } else if (term.listed === false) {
        warn('当前学年学期不在学校公布的学期列表里（' + shortName(text(term.code) || name0) + '），已照常导入，请在教务系统里核对学期');
    }

    // 校历：优先取与当前学年学期对应的一行，认不出来才用第一行。
    var calendar = calendarRows[0] || {};
    var termMatch = /^([0-9]{4}-[0-9]{4})-([0-9]+)$/.exec(text(term.code));
    if (termMatch) {
        for (var ci = 0; ci < calendarRows.length; ci++) {
            var candidate = calendarRows[ci] || {};
            if (text(candidate.XN) === termMatch[1] && text(candidate.XQ) === termMatch[2]) {
                calendar = candidate;
                break;
            }
        }
    }

    var suppliedStart = text(calendar.XQKSRQ).substring(0, 10);
    var firstDay = mondayOf(suppliedStart);
    if (firstDay) {
        if (firstDay !== suppliedStart) {
            warn('教务给出的开学日期是 ' + suppliedStart + '，第 1 周已回退到同一周的周一 ' + firstDay + '，请在学期管理里核对');
        }
    } else {
        firstDay = mondayOf(text(data.today));
        if (!firstDay) throw new Error('没能确定开学日期：教务给出的日期和本机日期都无法识别');
        warn('没能从教务读到合法的开学日期，第 1 周已按本机日期所在周的周一推算为 ' + firstDay + '，请在学期管理里核对');
    }

    var configuredWeeks = integerOf(calendar.ZZC);
    if (!(configuredWeeks >= 1)) configuredWeeks = integerOf(calendar.ZJXZC);
    var usedDefaultWeeks = !(configuredWeeks >= 1);
    if (usedDefaultWeeks) configuredWeeks = DEFAULT_WEEKS;
    var clampedWeeks = false;
    if (configuredWeeks > MAX_WEEK) {
        configuredWeeks = MAX_WEEK;
        clampedWeeks = true;
    }
    var totalWeeks = configuredWeeks;
    var raised = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raised = true;
    }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    if (usedDefaultWeeks) {
        warn('教务没有给出有效的学期总周数，已按 20 周导入' + (raised ? '；课表排到更晚的周，另按课表调整' : '') + '，请在学期管理里核对');
    }
    if (clampedWeeks) warn('教务给出的学期总周数超过 30 周，已按 30 周导入，请在学期管理里核对');
    if (raised) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过原定的 ' + configuredWeeks + ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对');
    }

    // 节次时间：只认合法、启停时间不倒挂的节次，同一节取第一次出现的。
    var periodTimes = [];
    var sectionSeen = {};
    for (var si = 0; si < sectionRows.length; si++) {
        var section = sectionRows[si] || {};
        var sectionNumber = integerOf(section.DM);
        var sectionStart = hhmmOf(section.KSSJ);
        var sectionEnd = hhmmOf(section.JSSJ);
        if (!(sectionNumber >= 1 && sectionNumber <= MAX_PERIOD)) continue;
        if (!sectionStart || !sectionEnd || minutesOf(sectionStart) >= minutesOf(sectionEnd)) continue;
        if (sectionSeen['p' + sectionNumber]) continue;
        sectionSeen['p' + sectionNumber] = true;
        periodTimes.push({ periodIndex: sectionNumber, start: sectionStart, end: sectionEnd });
    }
    periodTimes.sort(function (a, b) { return a.periodIndex - b.periodIndex; });

    if (!periodTimes.length) {
        warn('没能从教务取到学校的节次时间，已用应用默认的节次时间，课程的节次时间可在学期管理里核对');
    } else if (maxPeriod > 0) {
        var filled = [];
        var uncoveredFrom = 0;
        var byIndex = {};
        var pi;
        for (pi = 0; pi < periodTimes.length; pi++) byIndex['p' + periodTimes[pi].periodIndex] = periodTimes[pi];
        var lastEnd = null;
        for (pi = 0; pi < periodTimes.length; pi++) {
            if (periodTimes[pi].periodIndex < minPeriod) lastEnd = minutesOf(periodTimes[pi].end);
        }
        for (var p = minPeriod; p <= maxPeriod; p++) {
            if (byIndex['p' + p]) {
                lastEnd = minutesOf(byIndex['p' + p].end);
                continue;
            }
            if (lastEnd === null) {
                uncoveredFrom = p;
                break;
            }
            var nextStart = lastEnd + BREAK_MINUTES;
            var nextEnd = nextStart + CLASS_MINUTES;
            if (nextEnd > 23 * 60 + 59) {
                uncoveredFrom = p;
                break;
            }
            var made = { periodIndex: p, start: clockOf(nextStart), end: clockOf(nextEnd) };
            periodTimes.push(made);
            byIndex['p' + p] = made;
            lastEnd = nextEnd;
            filled.push(p);
        }
        periodTimes.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        if (filled.length) {
            warn('课表用到了学校节次时间没有覆盖的' + sectionsText(filled) + '，已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在学期管理里核对');
        }
        if (uncoveredFrom) {
            warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
        }
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 条');
        if (missing.day) reasons.push('缺星期或星期不在 1-7 ' + missing.day + ' 条');
        if (missing.period) reasons.push('缺节次或节次超出 1-' + MAX_PERIOD + ' 节 ' + missing.period + ' 条');
        if (missing.week) reasons.push('缺周次或周次全超出 1-' + MAX_WEEK + ' 周 ' + missing.week + ' 条');
        warn('有 ' + skipped + ' 条课表安排数据不全（' + reasons.join('、') + '），已跳过，如发现少课请反馈');
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + fieldSamples.join('、') + '）：已照常导入，空着的项可在「编辑课程」里补上');
    }
    if (droppedWeeks > 0) warn('有 ' + droppedWeeks + ' 个周次超过第 30 周，超出的部分没有导入');
    if (droppedWarnings > 0) warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';

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
            courses: courses
        }]
    });
})()
