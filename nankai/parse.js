(function () {
    // 南开大学（研究生）教务适配器 —— 第二步：把 extract.js 交出来的逐周课程链接文字
    // 变成空课课表载荷（不碰 DOM、不联网，CI 用 Rhino 真跑）。
    //
    // 移植自 shiguang_warehouse 的 NANKAI/nankai.js（MIT，上游作者 Cure）：
    //   parseCourseAnchor / parseTimetableDoc 的字段解释（课名 / 节次 / 教师 / 地点，
    //   「没有独立教师行时第一行其实是地点」的判断）、guessStartDate（按学期规则的开学日推算）、
    //   NKU_FALLBACK_TIME_SLOTS（14 节兜底节次时间）、mergeAndDistinctCourses（拾光官方
    //   《课程合并与去重函数》的参考实现，跨周合并 / 连续节次合并 / 完全去重）都在这里用 ES5 重写。
    //
    // 与上游的差别（详见 AUDIT.md）：
    //   ① 周次不再从格子里读：抓的是第 N 周，这条记录就属于第 N 周（上游 crawlAllWeeks 的原子化语义）；
    //   ② 合并前先做「完全相同的行只留一条」，避免同一条记录跨周重复出现把缺教师 / 缺教室的提醒放大；
    //   ③ 教师 / 地点拿不到时交 null，不写「未知」「待定」（上游写死 "待定"）；
    //   ④ 总周数取自教务页面的周次列表，不再用课表里出现的最大周（上游用最大周）；
    //   ⑤ 课表用到第 14 节之后的节次时按「统一修订 H3」顺推补齐并提醒。
    var MAX_WEEK = 30;                 // 载荷上限：totalWeeks 1..30
    var MAX_PERIOD = 20;               // 节次号上限（防止脏数据把补节次的循环拉长）
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var DEFAULT_TOTAL_WEEKS = 20;
    var EXTEND_BREAK_MINUTES = 5;      // H3 顺推：课间 5 分钟
    var EXTEND_CLASS_MINUTES = 45;     // H3 顺推：每节 45 分钟
    var SEP = String.fromCharCode(0);  // 复合键分隔符（不写字面 NUL，避免编辑器落成真字节）

    // 兜底节次时间：与上游 NKU_FALLBACK_TIME_SLOTS 逐节一致（页面正文解析失败时才用）
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '12:00', end: '12:45' },
        { periodIndex: 6, start: '12:55', end: '13:40' },
        { periodIndex: 7, start: '14:00', end: '14:45' },
        { periodIndex: 8, start: '14:55', end: '15:40' },
        { periodIndex: 9, start: '16:00', end: '16:45' },
        { periodIndex: 10, start: '16:55', end: '17:40' },
        { periodIndex: 11, start: '18:30', end: '19:15' },
        { periodIndex: 12, start: '19:25', end: '20:10' },
        { periodIndex: 13, start: '20:20', end: '21:05' },
        { periodIndex: 14, start: '21:15', end: '22:00' }
    ];

    // 地点行的特征（上游 parseCourseAnchor 同款）：没有独立教师行时，节次行后第一行就是地点
    var LOCATION_HINT = /楼|室|馆|场地|校区|通知|待定/;

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function cmpText(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    // 课名过长时截短，避免一个超长课名就把整条提醒撑破 200 字上限
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    function hasOwn(dict, key) {
        return Object.prototype.hasOwnProperty.call(dict, key);
    }

    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (hasOwn(dict, key)) n++;
        }
        return n;
    }

    // 占位词不是真教师 / 真地点（「未知」「暂无」「待定」「无教师」等一律当没有）
    function isPlaceholder(value) {
        var line = text(value);
        if (!line) return true;
        return /^(未知|暂无|待定|无)(教师|老师|教室|地点|校区|场地)?$/.test(line);
    }

    function minutesOf(value) {
        var match = /^(\d{2}):(\d{2})$/.exec(text(value));
        return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
    }

    function hhmmOf(minutes) {
        return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function uniqueSorted(weeks) {
        var seen = {};
        var out = [];
        for (var i = 0; i < weeks.length; i++) {
            var w = weeks[i];
            if (w >= 1 && w <= MAX_WEEK && !seen['w' + w]) {
                seen['w' + w] = true;
                out.push(w);
            }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    // 周次集合 → 极大段（移植手册 §4.1）：步长 1 视作每周，步长 2 视作单/双周
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j] };
            if (run.start === run.end || step === 1) run.weekType = 'ALL';
            else run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // 一条课程链接 -> 原子记录；认不出（没有课名 / 没有节次 / 星期或周次越界）返回 null
    function parseAnchor(entry) {
        var day = Number(entry.day);
        var week = Number(entry.week);
        if (!(day >= 1 && day <= 7) || !(week >= 1 && week <= MAX_WEEK)) return null;

        var lines = entry.lines || [];
        var name = text(entry.name);
        if (!name && lines.length) name = text(lines[0]);
        name = name.replace(/^[|\s]+/, '');
        if (!name) return null;

        // 「第X节 -- 第Y节」所在行
        var sectionIdx = -1;
        for (var i = 0; i < lines.length; i++) {
            if (/第\s*\d+\s*节/.test(lines[i])) { sectionIdx = i; break; }
        }
        if (sectionIdx < 0) return null;

        var numbers = [];
        var pattern = /第\s*(\d+)\s*节/g;
        var match;
        while ((match = pattern.exec(lines[sectionIdx])) !== null) {
            var number = parseInt(match[1], 10);
            if (number >= 1 && number <= MAX_PERIOD) numbers.push(number);
        }
        if (!numbers.length) return null;

        // 教师 / 地点紧跟节次行；有的课没有独立教师行，这时第一行其实是地点
        var teacher = text(lines[sectionIdx + 1] || '');
        var location = text(lines[sectionIdx + 2] || '');
        if (!location && LOCATION_HINT.test(teacher)) {
            location = teacher;
            teacher = '';
        }
        if (isPlaceholder(teacher)) teacher = null;
        if (isPlaceholder(location)) location = null;

        return {
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            start: Math.min.apply(null, numbers),
            end: Math.max.apply(null, numbers),
            weeks: [week]
        };
    }

    function sameExceptSections(a, b) {
        return a.name === b.name && (a.teacher || '') === (b.teacher || '') &&
            (a.location || '') === (b.location || '') && a.day === b.day;
    }

    // 上游 mergeAndDistinctCourses 的三步，按移植手册与批次十八 / 十九的口径重写：
    //   0：完全相同的行只留一条（先做，避免跨周重复把后面的计数放大）；
    //   1：课名 / 教师 / 地点 / 星期 / 周次都一样、节次首尾相接或重叠的合成一条
    //      （用「下一节开头 <= 上一节结尾 + 1」，同一节的重复行也吸收，不另起一段）；
    //   2：课名 / 教师 / 地点 / 星期 / 起止节次都一样的，周次取并集。
    function mergeRecords(records) {
        var ledger = {};
        var unique = [];
        for (var i = 0; i < records.length; i++) {
            var r = records[i];
            var key = 'r' + [r.name, r.teacher || '', r.location || '', r.day, r.start, r.end, r.weeks.join(',')].join(SEP);
            if (ledger[key]) continue;
            ledger[key] = true;
            unique.push(r);
        }
        if (!unique.length) return [];

        unique.sort(function (a, b) {
            return cmpText(a.name, b.name) || cmpText(a.teacher || '', b.teacher || '') ||
                cmpText(a.location || '', b.location || '') || (a.day - b.day) ||
                (a.weeks[0] - b.weeks[0]) || (a.start - b.start);
        });

        var stage1 = [];
        var current = unique[0];
        for (var u = 1; u < unique.length; u++) {
            var next = unique[u];
            var sameWeek = sameExceptSections(current, next) && current.weeks.join(',') === next.weeks.join(',');
            if (sameWeek && next.start <= current.end + 1) {
                if (next.end > current.end) current.end = next.end;
                if (next.start < current.start) current.start = next.start;
            } else {
                stage1.push(current);
                current = next;
            }
        }
        stage1.push(current);

        stage1.sort(function (a, b) {
            return cmpText(a.name, b.name) || cmpText(a.teacher || '', b.teacher || '') ||
                cmpText(a.location || '', b.location || '') || (a.day - b.day) ||
                (a.start - b.start) || (a.end - b.end);
        });

        var merged = [];
        var head = stage1[0];
        for (var s = 1; s < stage1.length; s++) {
            var item = stage1[s];
            var sameSection = sameExceptSections(head, item) &&
                head.start === item.start && head.end === item.end;
            if (sameSection) {
                head.weeks = head.weeks.concat(item.weeks);
            } else {
                merged.push(head);
                head = item;
            }
        }
        merged.push(head);
        return merged;
    }

    // 学期名：学年 + 学期都尽量用教务下拉框里的文字；拿不到才按学期代号补
    function yearWordOf(label, code) {
        var line = text(label);
        if (/学年/.test(line)) return line;
        var match = /^(\d{4})\s*[-~～至]\s*(\d{4})$/.exec(line);
        if (match) return line + '学年';
        match = /(\d{4})/.exec(line) || /(\d{4})/.exec(text(code));
        if (match) return match[1] + '-' + (parseInt(match[1], 10) + 1) + '学年';
        return '';
    }

    function termWordOf(label, code) {
        var line = text(label);
        if (line && !/^\d+$/.test(line)) return /学期/.test(line) ? line : line + '学期';
        var source = text(code) || line;
        var last = source.charAt(source.length - 1);
        if (last === '2') return '第二学期';
        if (last === '3') return '第三学期';
        return '第一学期';
    }

    // 学期代号最后一位：11 = 第一学期、12 = 第二学期、13 = 短学期（上游 NKU_TERM_BASE 同义，
    // 兼容个别部署写成 1 / 2 / 3）
    function termRuleOf(code) {
        var line = text(code);
        var last = line.charAt(line.length - 1);
        if (last === '2') return { month: 2, day: 20, offset: 1, rule: '2 月 20 日之后最近的周一' };
        if (last === '3') return { month: 7, day: 1, offset: 0, rule: '7 月 1 日之后最近的周一' };
        return { month: 9, day: 1, offset: 0, rule: '9 月 1 日之后最近的周一' };
    }

    // ---------- 主流程 ----------
    var data;
    try {
        data = JSON.parse(__ncInput);
    } catch (e) {
        throw new Error('提取到的课表数据无法识别，请重新登录后再试');
    }

    var term = data.term || {};
    var rawCourses = data.courses || [];

    var records = [];
    var skipped = 0;
    var skippedSample = '';
    for (var c = 0; c < rawCourses.length; c++) {
        var record = parseAnchor(rawCourses[c]);
        if (record) {
            records.push(record);
        } else {
            skipped++;
            if (!skippedSample) {
                var sampleLines = rawCourses[c].lines || [];
                skippedSample = shortName(sampleLines.length ? sampleLines[0] : rawCourses[c].name);
            }
        }
    }
    if (!records.length) {
        throw new Error('课表中未解析到有效课程（格式无法识别），请确认页面是「个人课表」页');
    }

    var merged = mergeRecords(records);

    // 按「课名 + 教师」归档成课程；同一门课的不同节次 / 星期写成多个课块
    var courseOrder = [];
    var byCourse = {};
    var missingTeacher = {};
    var missingLocation = {};
    var fieldSamples = [];
    var maxWeek = 0;
    var maxPeriod = 0;

    for (var m = 0; m < merged.length; m++) {
        var entry = merged[m];
        var courseKey = 'c' + entry.name + SEP + (entry.teacher || '');
        if (!byCourse[courseKey]) {
            byCourse[courseKey] = { name: entry.name, teacher: entry.teacher, note: null, blocks: [] };
            courseOrder.push(courseKey);
        }
        var course = byCourse[courseKey];
        if (!entry.teacher) missingTeacher['t' + entry.name] = true;
        if (!entry.location) missingLocation['l' + entry.name] = true;
        if ((!entry.teacher || !entry.location) && fieldSamples.length < 8) {
            if (fieldSamples.indexOf(entry.name) < 0) fieldSamples.push(entry.name);
        }
        if (entry.end > maxPeriod) maxPeriod = entry.end;

        var runs = runsOf(uniqueSorted(entry.weeks));
        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            if (run.end > maxWeek) maxWeek = run.end;
            course.blocks.push({
                dayOfWeek: entry.day,
                startPeriod: entry.start,
                endPeriod: entry.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: entry.location
            });
        }
    }

    // 课块顺序固定：星期 → 起始节 → 起始周
    var courses = [];
    for (var o = 0; o < courseOrder.length; o++) {
        var item = byCourse[courseOrder[o]];
        item.blocks.sort(function (a, b) {
            return (a.dayOfWeek - b.dayOfWeek) || (a.startPeriod - b.startPeriod) ||
                (a.startWeek - b.startWeek) || (a.endWeek - b.endWeek);
        });
        courses.push(item);
    }

    // ---------- 开学日期：教务不给，按学期规则推算（上游 guessStartDate 同义） ----------
    var nowText = text(data.now);
    var nowMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nowText);
    var nowDate = nowMatch ? new Date(Number(nowMatch[1]), Number(nowMatch[2]) - 1, Number(nowMatch[3])) : new Date();
    var currentYear = nowDate.getFullYear();

    var yearMatch = /(\d{4})/.exec(text(term.xn)) || /(\d{4})/.exec(text(term.xnLabel));
    var baseYear = yearMatch ? parseInt(yearMatch[1], 10) : currentYear;
    var rule = termRuleOf(term.xj);
    var startDate = new Date(baseYear + rule.offset, rule.month - 1, rule.day);
    var weekday = startDate.getDay();               // 0=周日..6=周六
    if (weekday !== 1) startDate.setDate(startDate.getDate() + ((8 - weekday) % 7));
    var firstDay = isoOf(startDate);

    // ---------- 学期名 ----------
    var yearWord = yearWordOf(term.xnLabel, term.xn);
    var termWord = termWordOf(term.xjLabel, term.xj);
    var termNameGuessed = false;
    if (!yearWord) {
        yearWord = currentYear + '-' + (currentYear + 1) + '学年';
        termNameGuessed = true;
    }
    var termName = yearWord + termWord;
    if (termNameGuessed) termName = '南开大学（研究生）' + termName;

    // ---------- 总周数：教务页面的周次列表 ----------
    var weekList = [];
    var rawWeeks = data.weeks || [];
    for (var w = 0; w < rawWeeks.length; w++) {
        var weekNumber = Number(rawWeeks[w]);
        if (weekNumber >= 1 && weekNumber <= MAX_WEEK && weekList.indexOf(weekNumber) < 0) weekList.push(weekNumber);
    }
    weekList.sort(function (a, b) { return a - b; });

    var totalWeeks = weekList.length ? weekList[weekList.length - 1] : 0;
    var totalWeeksDefault = false;
    var totalWeeksBumped = false;
    if (!totalWeeks) {
        totalWeeks = DEFAULT_TOTAL_WEEKS;
        totalWeeksDefault = true;
    }
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        totalWeeksBumped = true;
    }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    // ---------- 节次时间：教务页面的优先，取不到整张用上面的 14 节表；超出部分按 H3 顺推 ----------
    var schoolSlots = data.timeSlots || [];
    var usedBuiltin = !schoolSlots.length;
    var periodTimes = [];
    var sourceSlots = usedBuiltin ? SCHOOL_PERIOD_TIMES : schoolSlots;
    for (var s = 0; s < sourceSlots.length; s++) {
        periodTimes.push({
            periodIndex: s + 1,
            start: text(sourceSlots[s].start),
            end: text(sourceSlots[s].end)
        });
    }

    var filled = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        if (!prev) { uncoveredFrom = p; break; }
        var nextStart = minutesOf(prev.end) + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        filled.push(p);
    }

    // ---------- warnings（同一出口：单条 ≤200 字、总数 ≤20 条） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    function sectionsText(list, unit) {
        var parts = [];
        for (var i = 0; i < list.length && i < 4; i++) parts.push(list[i]);
        return '第 ' + parts.join('、') + (list.length > 4 ? ' 等' : ' ') + unit;
    }

    var skippedWeeks = Number(data.skippedWeeks) || 0;
    var failedWeeks = [];
    var rawFailed = data.failedWeeks || [];
    for (var f = 0; f < rawFailed.length; f++) {
        var failed = Number(rawFailed[f]);
        if (failed >= 1) failedWeeks.push(failed);
    }
    if (failedWeeks.length) {
        warn('有 ' + failedWeeks.length + ' 周的课表没有取到（' + sectionsText(failedWeeks, '周') +
            '），这些周可能漏了课，请重试或反馈');
    }

    if (skipped > 0) {
        warn('有 ' + skipped + ' 处课程信息格式无法识别' +
            (skippedSample ? '（例如「' + shortName(skippedSample) + '」）' : '') +
            '，这些课没有导入，请核对原始课表');
    }

    var missingTeacherCount = countKeys(missingTeacher);
    var missingLocationCount = countKeys(missingLocation);
    if (missingTeacherCount > 0 || missingLocationCount > 0) {
        var fieldParts = [];
        if (missingTeacherCount > 0) fieldParts.push(missingTeacherCount + ' 门课没有给出上课教师');
        if (missingLocationCount > 0) fieldParts.push(missingLocationCount + ' 门课没有给出上课地点');
        var shownNames = [];
        for (var fn = 0; fn < fieldSamples.length && fn < 3; fn++) shownNames.push(shortName(fieldSamples[fn]));
        warn('有 ' + fieldParts.join('、') +
            (shownNames.length ? '（例如 ' + shownNames.join('、') + '）' : '') +
            '：已照常导入，相应内容暂时空着，可在「编辑课程」里补上');
    }

    if (skippedWeeks) {
        warn('教务系统给出了 ' + skippedWeeks + ' 个超过 ' + MAX_WEEK +
            ' 周的周次，没有抓取（可能超出了本学期范围）');
    }

    warn('教务系统没有给出开学日期，已按「' + rule.rule + '」推算第 1 周从 ' + firstDay +
        ' 开始，请在「学期管理」里核对成学校实际开学日');

    if (totalWeeksDefault) {
        warn('教务页面的周次列表里没有可用的周次，学期总周数已按 ' + DEFAULT_TOTAL_WEEKS +
            ' 周导入，请在「学期管理」里核对');
    } else if (totalWeeksBumped) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过学期总周数，已按 ' + totalWeeks +
            ' 周导入，请在「学期管理」里核对');
    }

    if (usedBuiltin) {
        warn('教务系统没有给出节次时间，已按学校公布的 ' + SCHOOL_PERIOD_TIMES.length +
            ' 节节次时间导入（第 1 节 ' + SCHOOL_PERIOD_TIMES[0].start + '-' + SCHOOL_PERIOD_TIMES[0].end +
            '），如与实际安排不符，请在「学期管理」里核对');
    }
    if (filled.length) {
        warn('课表用到了' + sectionsText(filled, '节') +
            '，节次时间没有覆盖，已按上一节下课后课间 ' + EXTEND_BREAK_MINUTES + ' 分钟、每节 ' +
            EXTEND_CLASS_MINUTES + ' 分钟顺推补上，请在「学期管理」里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }

    if (text(term.source) === 'first') {
        warn('教务系统没有预选学年学期，已按学期列表的第一项「' + shortName(termName) +
            '」导入，请在「学期管理」里核对');
    }
    if (termNameGuessed) {
        warn('教务页面没有给出学年，学期名按当前学年推成「' + shortName(termName) + '」，请核对');
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
                name: termName,
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
