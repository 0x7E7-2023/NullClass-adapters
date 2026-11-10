(function () {
    // 山东轻工职业学院教务适配器（jedu 教务 JSON 接口）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 SDLIVC/sdlivc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 赛博丁真）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945，本校脚本最后一次修改 1fe584c。
    // 输入是 extract.js 的 { today, rows }；每行只有课名、教师、星期、周次文字、停开标记、地点与节次。
    //
    // 移植改动：
    //   1. 周次文字逐段解析并取并集：兼容 1-8、1-8,10-16、第1周至第8周、(单)1-8周,(双)9-16周、
    //      无逗号的 (单)1-8周(双)9-16周 与后置的 1-8周(单)9-16周(双)；单双按逗号分段各自判。
    //   2. stopCourse 不是 NO 的停开记录跳过并出声；重复原始行先去重再计数。
    //   3. 同课同教师同地点同星期同节次取周次并集；连堂保持两段。
    //   4. 星期 mon..sun 映射 1..7；节次读 eduLesson.startLesson / endLesson。
    //   5. 上游没有节次时间表：按默认 12 节节次时间导入并提醒；更晚节次按统一修订 H3 顺推。
    //   6. 没有校历：开学日按本机日期所在周的周一推算并提醒；总周数默认 20，课表更晚才抬高。
    //   7. 学期名拿不到教务文本：按今天的日期推算学年学期并提醒；提醒原文截 20 字，统一出口限制 20 条、每条 200 字。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var SCHOOL = '山东轻工职业学院';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var CLASS_MINUTES = 45;
    var BREAK_MINUTES = 5;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;

    // 空课默认节次时间（与应用默认节次表一致：12 节，每节 45 分钟、课间 10 分钟）。
    // 上游只声明每节 45 分钟、课间 10 分钟，没有各节的具体时刻，故整表照应用默认。
    var DEFAULT_PERIOD_TIMES = [
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

    var DAY_MAP = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
    var XQ_CN = { '1': '一', '2': '二' };
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

    // 地点先看 placeName，占位词或空白再看 nameIncludeNum；两个都不能用才交空。
    function placeOf(place) {
        var name = realOrNull(place.placeName);
        if (name) return name;
        return realOrNull(place.nameIncludeNum);
    }

    // 教务没给学年学期：1 月属上一学年第一学期，2-7 月属上一学年第二学期，8-12 月属当年第一学期。
    function termNameOf(todayIso) {
        var year = parseInt(todayIso.substring(0, 4), 10);
        var month = parseInt(todayIso.substring(5, 7), 10);
        var xn;
        var xq;
        if (month === 1) {
            xn = (year - 1) + '-' + year;
            xq = '1';
        } else if (month >= 2 && month <= 7) {
            xn = (year - 1) + '-' + year;
            xq = '2';
        } else {
            xn = year + '-' + (year + 1);
            xq = '1';
        }
        return SCHOOL + ' ' + xn + '学年第' + XQ_CN[xq] + '学期';
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

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
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

    // 周次文字 → 周号数组。逐段解析并取并集；单双标记既可能写在段首，也可能写在段尾。
    // 兼容：1-8、1-8,10-16、第1周至第8周、第1-第8周、1,3,5周、(单)1-8周、(双)9-16周、
    //       (单)1-8周(双)9-16周、1-8周(单)9-16周(双)、1-16周(1-16周)。
    function parseWeekText(value) {
        var source = text(value);
        if (!source) return [];
        // 「共 N 周」只是备注，只剥掉备注本身，别吞后面的真实周次段
        source = source.replace(/共\s*[0-9]+\s*周?/g, ' ');
        // 全角括号 / 顿号先归一，后面按半角处理
        source = source.replace(/（/g, '(').replace(/）/g, ')').replace(/、/g, ',').replace(/；/g, ';');
        // 「第3-4节」「(2-3节)」是节次不是周次：整段摘掉（周次文字前面常带节次，不能连带截断后面的真实周次）
        source = source.replace(/[0-9]+\s*(?:[-~至到]\s*[0-9]+)?\s*节/g, ' ');
        // 括号里是周次写法（(单)/(双)/(1-16周)）就保留；纯数字组号 (1)、(1-2) 与备注 (3学分)、(实验) 整组摘掉
        source = source.replace(/\(([^()]*)\)/g, function (all, inner) {
            var weekish = /[周单双]/.test(inner) && /^[\s0-9,\-~至到第单双周]+$/.test(inner);
            return weekish ? ' ' + all + ' ' : ' ';
        });

        var weeks = [];
        var seen = {};
        // 按逗号分段：每段各自判单双（段首标记管本段后面，段尾标记管紧挨着的前一段）
        var segments = source.split(/[,;]/);
        var si;
        for (si = 0; si < segments.length; si++) collectSegment(segments[si]);
        return weeks.sort(function (a, b) { return a - b; });

        function collectSegment(segment) {
            var pattern = /(\(\s*[单双]\s*周?\s*\))|([单双]\s*周?)|([0-9]+\s*周?\s*(?:[-~至到]\s*第?\s*[0-9]+)?)/g;
            var tokens = [];
            var match;
            while ((match = pattern.exec(segment)) !== null) {
                if (match[1] || match[2]) {
                    tokens.push({ marker: (match[1] || match[2]).indexOf('单') >= 0 ? 1 : 2 });
                } else {
                    tokens.push({ range: match[3] });
                }
            }
            if (!tokens.length) return;
            var prefixStyle = !!tokens[0].marker;
            var current = 0;
            var i;
            for (i = 0; i < tokens.length; i++) {
                var token = tokens[i];
                if (token.marker) {
                    if (prefixStyle) current = token.marker;
                    continue;
                }
                var parity = current;
                if (!prefixStyle) {
                    parity = 0;
                    if (i + 1 < tokens.length && tokens[i + 1].marker) parity = tokens[i + 1].marker;
                }
                var rangeMatch = /([0-9]+)\s*周?\s*(?:[-~至到]\s*第?\s*([0-9]+))?/.exec(token.range);
                if (!rangeMatch) continue;
                var start = parseInt(rangeMatch[1], 10);
                var end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start;
                if (!(start > 0)) continue;
                if (!(end >= start) || end - start > 60) end = start;
                for (var week = start; week <= end; week++) {
                    if (parity === 1 && week % 2 === 0) continue;
                    if (parity === 2 && week % 2 === 1) continue;
                    if (seen['w' + week]) continue;
                    seen['w' + week] = true;
                    weeks.push(week);
                }
            }
        }
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
        var seen = {};
        var out = [];
        var all = a.concat(b);
        for (var i = 0; i < all.length; i++) {
            if (seen[all[i]]) continue;
            seen[all[i]] = true;
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
    var stoppedRecords = 0;
    var slots = {};
    var slotList = [];
    var seenRows = {};
    var maxWeek = 0;
    var maxPeriod = 0;

    function rememberFieldSample(name) {
        if (fieldSamples.length >= 3 || fieldSamples.indexOf(name) >= 0) return;
        fieldSamples.push(name);
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var place = row.eduPlace || {};
        var lesson = row.eduLesson || {};
        var rowKey = JSON.stringify([text(row.courseName), text(row.teacherName), text(row.week),
            text(row.weekList), text(row.stopCourse), text(place.placeName), text(place.nameIncludeNum),
            text(lesson.startLesson), text(lesson.endLesson)]);
        if (seenRows[rowKey]) continue;
        seenRows[rowKey] = true;

        // 上游：stopCourse 不是 NO 的记录整条跳过（停开课）。
        if (text(row.stopCourse) !== 'NO') {
            stoppedRecords++;
            continue;
        }

        var name = text(row.courseName);
        if (!name) {
            missing.name++;
            continue;
        }
        var day = DAY_MAP[text(row.week).toLowerCase()] || null;
        if (!day) {
            missing.day++;
            continue;
        }
        var startPeriod = integerOf(lesson.startLesson);
        var endPeriod = integerOf(lesson.endLesson);
        if (!(startPeriod >= 1 && endPeriod >= startPeriod && endPeriod <= MAX_PERIOD)) {
            missing.period++;
            continue;
        }
        var parsedWeeks = parseWeekText(row.weekList);
        var keptWeeks = [];
        var previous = 0;
        for (var w = 0; w < parsedWeeks.length; w++) {
            if (parsedWeeks[w] === previous) continue;
            previous = parsedWeeks[w];
            if (parsedWeeks[w] > MAX_WEEK) {
                droppedWeeks++;
            } else {
                keptWeeks.push(parsedWeeks[w]);
            }
        }
        if (!keptWeeks.length) {
            missing.week++;
            continue;
        }
        var teacher = realOrNull(row.teacherName);
        var location = placeOf(place);
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
        slot.weeks = unionWeeks(slot.weeks, keptWeeks);
    }

    // 上游 mergeCourses 最终按星期、开始节次、课名排序；连堂保持不同段。
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
    }

    if (!courses.length) {
        throw new Error('这个学期没有解析到任何课程：请确认已打开当前学期的课表，再重新提取');
    }

    var todayText = text(data.today);
    var firstDay = mondayOf(todayText);
    if (!firstDay) throw new Error('没能确定开学日期：本机日期读不出来，请检查设备日期后再试');
    warn('学期名是按今天的日期推算的，请在学期管理里核对');
    warn('教务系统没有给出开学日期，第 1 周已按本机日期所在周的周一 ' + firstDay + ' 推算，请在学期管理里核对');

    var totalWeeks = DEFAULT_WEEKS;
    var raised = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raised = true;
    }
    if (raised) {
        warn('教务系统没有给出学期总周数，已按 20 周导入；课表里有第 ' + maxWeek +
            ' 周的课，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对');
    } else {
        warn('教务系统没有给出学期总周数，已按 20 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改');
    }

    var periodTimes = DEFAULT_PERIOD_TIMES.slice(0);
    var filled = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var nextStart = minutesOf(periodTimes[periodTimes.length - 1].end) + BREAK_MINUTES;
        var nextEnd = nextStart + CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) {
            uncoveredFrom = p;
            break;
        }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        filled.push(p);
    }

    warn('教务系统没有给出节次时间，已按默认的 ' + DEFAULT_PERIOD_TIMES.length +
        ' 节节次时间导入（第 1 节 ' + DEFAULT_PERIOD_TIMES[0].start + '-' + DEFAULT_PERIOD_TIMES[0].end +
        '），可能与学校实际安排不符，请在学期管理里核对');
    if (filled.length) {
        warn('课表用到了' + sectionsText(filled) + '，现有的节次时间没有覆盖，已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
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
        var shown = [];
        for (var f = 0; f < fieldSamples.length; f++) shown.push(shortName(fieldSamples[f]));
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shown.join('、') + '）：已照常导入，空着的项可在「编辑课程」里补上');
    }
    if (stoppedRecords > 0) {
        warn('有 ' + stoppedRecords + ' 条记录教务标记为停开，没有导入');
    }
    if (droppedWeeks > 0) warn('有 ' + droppedWeeks + ' 个周次超过第 30 周，超出的部分没有导入');
    if (droppedWarnings > 0) warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [{
            name: termNameOf(todayText),
            firstDay: firstDay,
            totalWeeks: totalWeeks,
            periodTimes: periodTimes,
            courses: courses
        }]
    });
})()
