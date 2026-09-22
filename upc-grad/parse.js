(function () {
    // extract.js 的输出 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 UPC/upc_graduate.js（MIT，作者 Haooz）：
    // parseWeeksText / parseCellText / mergeCourses / parseTermCalendar 的核心逻辑
    // 都在这里重写为 ES5 纯函数（不碰 DOM，CI 用 Rhino 能真跑）。
    var MAX_WEEK = 30; // core.model.MAX_TOTAL_WEEKS，越界周次直接丢弃并计数（见 stats.oversizeWeeks）
    var DEFAULT_TOTAL_WEEKS = 20;

    // 作息时间：与本科版 upc/parse.js 用的是同一张表（教务处公布，全校统一），
    // 上游脚本里的 UPC_TIME_SLOTS 就是这 12 条。
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:50', end: '09:35' },
        { periodIndex: 3, start: '09:55', end: '10:40' },
        { periodIndex: 4, start: '10:45', end: '11:30' },
        { periodIndex: 5, start: '11:35', end: '12:20' },
        { periodIndex: 6, start: '14:00', end: '14:45' },
        { periodIndex: 7, start: '14:50', end: '15:35' },
        { periodIndex: 8, start: '15:55', end: '16:40' },
        { periodIndex: 9, start: '16:45', end: '17:30' },
        { periodIndex: 10, start: '19:00', end: '19:45' },
        { periodIndex: 11, start: '19:50', end: '20:35' },
        { periodIndex: 12, start: '20:40', end: '21:25' }
    ];

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function uniqueSorted(weeks) {
        var seen = {};
        var out = [];
        for (var i = 0; i < weeks.length; i++) {
            var w = weeks[i];
            if (w >= 1 && !seen[w]) {
                seen[w] = true;
                out.push(w);
            }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    // 周次文本："2-12"、"14"、"15-16" 用 、或 , 分隔 → [2,3,...,12] 等（上游
    // parseWeeksText 原样移植）。超过 MAX_WEEK 的数字视为教务数据错误，丢弃并计数
    // （手册 §4.1 没规定这种情况，但「不静默丢」的原则同样适用——见 stats.oversizeWeeks）。
    function parseWeeksText(text, stats) {
        var raw = [];
        var parts = String(text || '').split(/、|,/);
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i].trim();
            if (!part) continue;
            var range = /^(\d+)-(\d+)$/.exec(part);
            if (range) {
                var lo = parseInt(range[1], 10);
                var hi = parseInt(range[2], 10);
                if (lo > hi) { var t = lo; lo = hi; hi = t; }
                for (var w = lo; w <= hi; w++) raw.push(w);
            } else if (/^\d+$/.test(part)) {
                raw.push(parseInt(part, 10));
            }
        }
        var weeks = uniqueSorted(raw);
        var kept = [];
        for (var k = 0; k < weeks.length; k++) {
            if (weeks[k] > MAX_WEEK) {
                stats.oversizeWeeks++;
            } else {
                kept.push(weeks[k]);
            }
        }
        return kept;
    }

    // 一格里的一门或多门课（用；分隔），每门课形如
    // "课名｛2-12周[教师:曹晓敏,地点:东廊302]｝" 或
    // "课名｛14周[教师:刘伟锋]、15-16周[教师:杨兴浩][地点:南堂201]｝"
    // （示例取自上游脚本注释）。同一门课可以有多个「周次[教师:...]」段，
    // 段内没写地点时，用整段里出现过的「最后一个 [地点:X]」兜底（commonRoom）。
    // 上游对完全无法识别的一段（没有任何「周[教师:...]」匹配上）直接丢弃整门课，
    // 这里同样丢，但计数进 stats.skippedParts，最终写进 warnings——不静默丢。
    function parseCellText(text, day, startSection, endSection, out, stats) {
        var parts = String(text || '').split('；');
        for (var p = 0; p < parts.length; p++) {
            var part = parts[p].trim();
            if (!part) continue;
            var braceIdx = part.indexOf('｛');
            if (braceIdx === -1) continue;
            var name = part.slice(0, braceIdx).replace(/\s+/g, ' ').trim();
            if (!name) continue;
            var closeIdx = part.lastIndexOf('｝');
            var body = part.slice(braceIdx + 1, closeIdx === -1 ? part.length : closeIdx);

            var commonRoom = null;
            var commonMatch = body.match(/\[地点:([^\]]+)\]/g);
            if (commonMatch && commonMatch.length > 0) {
                var lastMatch = /\[地点:([^\]]+)\]/.exec(commonMatch[commonMatch.length - 1]);
                commonRoom = lastMatch ? lastMatch[1].trim() : null;
            }

            var segRe = /([\d,\-、]+)周\s*\[教师:([^\]]+)\]/g;
            var seg;
            var found = false;
            while ((seg = segRe.exec(body)) !== null) {
                var weeks = parseWeeksText(seg[1], stats);
                if (weeks.length === 0) continue;
                var teacherBody = seg[2].trim();
                var commaIdx = teacherBody.search(/[,，]/);
                var teacher = (commaIdx === -1 ? teacherBody : teacherBody.slice(0, commaIdx)).trim();
                var roomMatch = /地点:([^\]]+)\]/.exec(seg[0]);
                var room = roomMatch ? roomMatch[1].trim() : commonRoom;
                out.push({
                    name: name,
                    teacher: teacher || null,
                    position: room || null,
                    day: day,
                    startSection: startSection,
                    endSection: endSection,
                    weeks: weeks
                });
                found = true;
            }
            if (!found) stats.skippedParts++;
        }
    }

    // 合并同名/同师/同地/同星期/同节次的条目，把周次并起来（上游 mergeCourses 原样移植）。
    function mergeCourses(entries) {
        var order = [];
        var map = {};
        for (var i = 0; i < entries.length; i++) {
            var c = entries[i];
            var key = c.name + '\u0000' + (c.teacher || '') + '\u0000' + (c.position || '') +
                '\u0000' + c.day + '\u0000' + c.startSection + '\u0000' + c.endSection;
            if (map[key]) {
                map[key].weeks = uniqueSorted(map[key].weeks.concat(c.weeks));
            } else {
                map[key] = {
                    name: c.name, teacher: c.teacher, position: c.position,
                    day: c.day, startSection: c.startSection, endSection: c.endSection,
                    weeks: c.weeks.slice()
                };
                order.push(key);
            }
        }
        var out = [];
        for (var j = 0; j < order.length; j++) out.push(map[order[j]]);
        return out;
    }

    // 周次集合 → 极大段（手册 §4.1）：步长 1 视作每周，步长 2 视作单/双周。
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

    // 提取时刻所在周的周一（本地日历算术，不依赖时区之外的假设）。
    function mondayOnOrBefore(isoDate) {
        var parts = isoDate.split('-');
        var y = parseInt(parts[0], 10);
        var mo = parseInt(parts[1], 10);
        var d = parseInt(parts[2], 10);
        var date = new Date(y, mo - 1, d);
        var dow = date.getDay(); // 0=周日..6=周六
        var back = (dow === 0) ? 6 : dow - 1;
        date.setDate(date.getDate() - back);
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    var data = JSON.parse(__ncInput);
    var cells = data.cells || [];
    var stats = { oversizeWeeks: 0, skippedParts: 0 };

    var rawEntries = [];
    for (var c = 0; c < cells.length; c++) {
        var cell = cells[c];
        parseCellText(cell.text, cell.day, cell.startSection, cell.endSection, rawEntries, stats);
    }
    var merged = mergeCourses(rawEntries);

    var order = [];
    var byCourse = {};
    var maxWeek = 0;
    var overflowSections = false;

    for (var m = 0; m < merged.length; m++) {
        var entry = merged[m];
        var key = entry.name + '\u0000' + (entry.teacher || '');
        if (!byCourse[key]) {
            byCourse[key] = { name: entry.name, teacher: entry.teacher, note: null, blocks: [] };
            order.push(key);
        }
        if (entry.endSection > 12) overflowSections = true;
        var runs = runsOf(entry.weeks);
        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            if (run.end > maxWeek) maxWeek = run.end;
            byCourse[key].blocks.push({
                dayOfWeek: entry.day,
                startPeriod: entry.startSection,
                endPeriod: entry.endSection,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: entry.position
            });
        }
    }

    if (order.length === 0) {
        throw new Error('课表中未解析到有效课程（格式无法识别），请确认页面是学期课表查询页');
    }

    var courses = [];
    for (var o = 0; o < order.length; o++) courses.push(byCourse[order[o]]);

    // 开学日期 / 总周数：优先用教学日历（cells[0]=周次号，cells[1..7]=星期日…星期六，
    // 每行一个周次；monday = 第 1 行「星期一」那一格），拿不到就推算并写 warnings（手册 §4.2）。
    var currentYear = parseInt(String(data.now || '').split('-')[0], 10);
    if (isNaN(currentYear)) currentYear = new Date().getFullYear();

    var firstDay = null;
    var totalWeeks = null;
    var firstDayWarningNeeded = false;
    var totalWeeksWarningNeeded = false;

    if (data.calendar && data.calendar.rows && data.calendar.rows.length) {
        var calRows = data.calendar.rows;
        var monday = calRows[0][1]; // 数组下标 1 = 星期一
        if (monday) {
            // 月份 <= 2 属于上一自然年，否则为当前年（与上游 parseTermCalendar 的 yearOf 一致）。
            var mondayYear = monday.month <= 2 ? currentYear - 1 : currentYear;
            firstDay = mondayYear + '-' + pad2(monday.month) + '-' + pad2(monday.day);
        }
        totalWeeks = calRows.length;
    }

    if (!firstDay) {
        if (!data.now) throw new Error('提取数据里缺少 now（提取时刻），无法推算开学日期');
        firstDay = mondayOnOrBefore(data.now);
        firstDayWarningNeeded = true;
    }

    var bumped = false;
    if (totalWeeks === null || totalWeeks < 1) {
        totalWeeks = maxWeek > 0 ? maxWeek : DEFAULT_TOTAL_WEEKS;
        totalWeeksWarningNeeded = true;
    } else if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        bumped = true;
    }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    // 学期名称：上游没有这个概念。优先用页面标题里认出来的「YYYY-YYYY学年第X学期」，
    // 认不出就按开学月份推算（8月及以后视为第一学期，否则视为上一学年第二学期），
    // 并在 warnings 里如实说明（手册 §4.7）。
    var termName = data.termHint;
    var termNameWarningNeeded = false;
    if (!termName) {
        var fdParts = firstDay.split('-');
        var fdYear = parseInt(fdParts[0], 10);
        var fdMonth = parseInt(fdParts[1], 10);
        var firstYear, half;
        if (fdMonth >= 8) {
            firstYear = fdYear;
            half = '第一学期';
        } else {
            firstYear = fdYear - 1;
            half = '第二学期';
        }
        termName = firstYear + '-' + (firstYear + 1) + '学年' + half;
        termNameWarningNeeded = true;
    }

    var warnings = [];
    if (stats.oversizeWeeks > 0) {
        warnings.push('有 ' + stats.oversizeWeeks + ' 个周次超过 ' + MAX_WEEK +
            ' 周上限被丢弃，请核对原始课表（可能是教务数据本身有误）');
    }
    if (stats.skippedParts > 0) {
        warnings.push('有 ' + stats.skippedParts + ' 处课程信息因格式无法识别被跳过，请核对原始课表');
    }
    if (overflowSections) {
        warnings.push('部分课程排在第 12 节之后，适配器内置作息表只到第 12 节，' +
            '这些课块没有具体上下课时间，请在「学期管理」里补充节次时间');
    }
    if (firstDayWarningNeeded) {
        warnings.push('开学日期无法从教学日历获取，已按提取当天（' + data.now +
            '）所在周的周一推算，请在「学期管理」里核对');
    }
    if (totalWeeksWarningNeeded) {
        warnings.push('教学日历未提供总周数，已按课表中出现的最大周次（第 ' + maxWeek +
            ' 周）设定，请在「学期管理」里核对');
    } else if (bumped) {
        warnings.push('课表中出现的最大周次（第 ' + maxWeek + ' 周）超过教学日历给出的总周数，' +
            '已放宽总周数以容纳所有课程，请核对是否有排课或日历数据错误');
    }
    if (termNameWarningNeeded) {
        warnings.push('教务页面没有直接给出学期名称，已按开学日期推算为「' + termName + '」，请核对');
    }

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
                periodTimes: PERIOD_TIMES,
                courses: courses
            }
        ]
    });
})()
