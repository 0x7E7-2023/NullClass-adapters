(function () {
    // 天津理工大学教务适配器（金智 jwapp / 我的课表 wdkb）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 TJUT/tjut_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 f83288e，本校脚本最后一次修改 9ebcf41。
    // 输入是 extract.js 的 { term, today, courseRows, experimentRows, changeRows, periodRows }；
    // experimentRows / changeRows / periodRows 为 null 表示没取到（请求失败或返回不是课表 / 节次结构）。
    //
    // 移植改动：
    //   1. 理论课与实验课一起处理；实验课名为「课名 - 实验项目名」（上游同款），实验项目名为空时不加后缀。
    //   2. 同课名、教师、教室、星期的记录按周合并：同一周内相邻或重叠的节次合并成一段（上游同款，连堂合为一段），再按节次段取周次。
    //   3. SKZC 位串第 1 位对应第 1 周，按连续、单双切成极大段；第 31 周起丢弃并提醒。完全重复的原始行只算一次。
    //   4. 调课停课按 KBID 加上节次与原课对回。停课类（02）只去掉被停的周次；调到新时间的类型（01 / 03）
    //      只有新时间完整且通过校验才「去原周次 + 加新安排」，否则原课不动；类型不认得也原课不动。以上都进提醒。
    //   5. 教师取 SKJS 的第一个名字（去掉括号备注），SKJS 为空时用 JSM；「未知」「待定」「暂无」等占位词交空（null）。
    //   6. 节次时间：教务 jc.do 给出的有效表优先；取不到用上游写死的 11 节表并提醒；超出节次表的按统一修订 H3 顺推并提醒。
    //   7. 开学日取 XQKSRQ 并回退到同周周一；取不到用本机日期所在周的周一并提醒。总周数用 ZZC，缺失用 20 并提醒，课表更晚才抬高。
    //   8. 所有提醒走同一出口：课名截 20 字，每条 ≤200 字；超过 20 条时保留前 19 条，第 20 条写「另有 N 条」（N 为没显示的条数）。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var courseRows = Array.isArray(data.courseRows) ? data.courseRows : [];
    var experimentRows = Array.isArray(data.experimentRows) ? data.experimentRows : null;
    var changeRows = Array.isArray(data.changeRows) ? data.changeRows : null;
    var periodRows = Array.isArray(data.periodRows) ? data.periodRows : null;

    var SCHOOL = '天津理工大学';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var CLASS_MINUTES = 45;
    var BREAK_MINUTES = 5;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;
    var TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

    // 上游写死的 11 节表（DEFAULT_TIME_SLOTS，逐节照抄）。
    var DEFAULT_PERIODS = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:55', end: '15:40' },
        { periodIndex: 7, start: '16:10', end: '16:55' },
        { periodIndex: 8, start: '17:05', end: '17:50' },
        { periodIndex: 9, start: '18:30', end: '19:15' },
        { periodIndex: 10, start: '19:25', end: '20:10' },
        { periodIndex: 11, start: '20:20', end: '21:05' }
    ];

    var EMPTY_WORD = {
        '未知': true, '未知教师': true, '未知老师': true, '未知地点': true, '未知教室': true,
        '待定': true, '暂无': true, '暂无教师': true, '暂无老师': true, '暂无教室': true, '暂无地点': true
    };
    var XQ_CN = { '1': '一', '2': '二', '3': '三' };

    function has(dictionary, key) {
        return Object.prototype.hasOwnProperty.call(dictionary, key);
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
        return !valueText || has(EMPTY_WORD, valueText) ? null : valueText;
    }

    // 「张三（外聘）/李四」只取第一位，括号备注不算名字。
    function firstTeacher(raw) {
        var first = text(text(raw).split('/')[0]);
        first = text(first.replace(/[（(][^）)]*[）)]/g, ''));
        return realOrNull(first);
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
            if (has(dictionary, key)) count++;
        }
        return count;
    }

    var warnings = [];

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        warnings.push(line);
    }

    function termName() {
        var given = text(term.name);
        if (given) return given;
        var year = text(term.xn);
        var code = text(term.xq);
        if (/^[0-9]{4}-[0-9]{4}$/.test(year) && has(XQ_CN, code)) return year + '学年第' + XQ_CN[code] + '学期';
        return text(SCHOOL + ' ' + year + ' ' + code);
    }

    // 与上游 parseWeeksFromSkzc 一致：只看每个位置是不是字符 1，下标从第 1 周起。
    function weeksOf(bitmap) {
        var source = text(bitmap);
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

    // 升序周次切成极大段：连续为 ALL，隔一周为 ODD / EVEN。
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

    // ---- 课表行 ----
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var droppedWeeks = 0;
    var seenRows = {};
    var entries = [];

    function addRow(row) {
        row = row || {};
        var key = JSON.stringify([text(row.KBID), text(row.KCM), text(row.SYXMMC), text(row.SKJS), text(row.JSM),
            text(row.JASMC), text(row.SKXQ), text(row.KSJC), text(row.JSJC), text(row.SKZC)]);
        if (has(seenRows, key)) return;
        seenRows[key] = true;

        var name = text(row.KCM);
        var suffix = text(row.SYXMMC);
        if (name && suffix) name = name + ' - ' + suffix;
        if (!name || has(EMPTY_WORD, name) || name === '未知课程') {
            missing.name++;
            return;
        }
        var day = integerOf(row.SKXQ);
        if (!(day >= 1 && day <= 7)) {
            missing.day++;
            return;
        }
        var start = integerOf(row.KSJC);
        var end = integerOf(row.JSJC);
        if (!(start >= 1 && end >= start && end <= MAX_PERIOD)) {
            missing.period++;
            return;
        }
        var parsed = weeksOf(row.SKZC);
        droppedWeeks += parsed.dropped;
        if (!parsed.weeks.length) {
            missing.week++;
            return;
        }
        var teacher = text(row.SKJS) ? firstTeacher(row.SKJS) : firstTeacher(row.JSM);
        entries.push({
            kbId: text(row.KBID), name: name, teacher: teacher, location: realOrNull(row.JASMC),
            day: day, start: start, end: end, weeks: parsed.weeks
        });
    }

    for (var r = 0; r < courseRows.length; r++) addRow(courseRows[r]);
    for (var e = 0; experimentRows && e < experimentRows.length; e++) addRow(experimentRows[e]);

    // ---- 调课停课：与上游 applyCourseChanges 同口径，但对不上 / 不认得的都进提醒 ----
    // 停课类只去周次；调到新时间的类型（01 / 03）只在新时间完整且通过校验时才「去原周次 + 加新安排」；
    // 其余类型不认得，一律保持原课不动。
    var STOP_TYPES = { '02': true };
    var TIME_TYPES = { '01': true, '03': true };
    var applied = 0;
    var unmatched = [];
    var unknownType = [];
    var incompleteChanges = [];

    function applyChange(change) {
        change = change || {};
        var kbId = text(change.KBID);
        var label = shortName(text(change.KCM) || '未命名课程');
        var day = integerOf(change.SKXQ);
        var start = integerOf(change.KSJC);
        var end = integerOf(change.JSJC);
        var matched = [];
        if (kbId) {
            for (var i = 0; i < entries.length; i++) {
                var candidate = entries[i];
                if (candidate.kbId === kbId && candidate.day === day && candidate.start === start && candidate.end === end) {
                    matched.push(candidate);
                }
            }
        }
        if (!matched.length) {
            unmatched.push(label);
            return;
        }
        function dropWeeks(list, removed) {
            var changed = false;
            for (var m = 0; m < list.length; m++) {
                var before = list[m].weeks.length;
                list[m].weeks = list[m].weeks.filter(function (w) {
                    return removed.indexOf(w) < 0;
                });
                if (list[m].weeks.length < before) changed = true;
            }
            return changed;
        }

        var removed = weeksOf(change.SKZC).weeks;
        var type = text(change.TKLXDM);
        if (has(STOP_TYPES, type)) {
            if (dropWeeks(matched, removed)) applied++;
            return;
        }
        if (!has(TIME_TYPES, type)) {
            unknownType.push(label);
            return;
        }
        var fresh = weeksOf(change.XSKZC);
        var nDay = integerOf(change.XSKXQ);
        var nStart = integerOf(change.XKSJC);
        var nEnd = integerOf(change.XJSJC);
        var valid = !!(text(change.XSKZC) && text(change.XSKXQ) && text(change.XKSJC) && text(change.XJSJC)) &&
            fresh.weeks.length > 0 && nDay >= 1 && nDay <= 7 && nStart >= 1 && nEnd >= nStart && nEnd <= MAX_PERIOD;
        if (!valid) {
            incompleteChanges.push(label);
            return;
        }
        droppedWeeks += fresh.dropped;
        dropWeeks(matched, removed);
        var origin = matched[0];
        entries.push({
            kbId: kbId, name: text(change.KCM) || origin.name,
            teacher: firstTeacher(change.XSKJS) || firstTeacher(change.YSKJS),
            location: realOrNull(text(change.XJASMC) || text(change.JASMC)),
            day: nDay, start: nStart, end: nEnd, weeks: fresh.weeks
        });
        applied++;
    }

    for (var c = 0; changeRows && c < changeRows.length; c++) applyChange(changeRows[c]);
    entries = entries.filter(function (item) {
        return item.weeks.length > 0;
    });

    // ---- 同课合并：按周取节次段，同周相邻或重叠的段合并，再按段收周次 ----
    var groups = {};
    var groupList = [];
    for (var i2 = 0; i2 < entries.length; i2++) {
        var item = entries[i2];
        var gkey = JSON.stringify([item.name, item.teacher || '', item.location || '', item.day]);
        var group = groups[gkey];
        if (!group) {
            group = { name: item.name, teacher: item.teacher, location: item.location, day: item.day, weeksMap: {} };
            groups[gkey] = group;
            groupList.push(group);
        }
        for (var k = 0; k < item.weeks.length; k++) {
            var week = item.weeks[k];
            if (!group.weeksMap[week]) group.weeksMap[week] = [];
            group.weeksMap[week].push({ start: item.start, end: item.end });
        }
    }

    var slots = [];
    for (var g = 0; g < groupList.length; g++) {
        var grp = groupList[g];
        var weekKeys = Object.keys(grp.weeksMap).map(Number).sort(function (a, b) { return a - b; });
        var segMap = {};
        var segList = [];
        for (var q = 0; q < weekKeys.length; q++) {
            var wk = weekKeys[q];
            var parts = grp.weeksMap[wk].slice(0).sort(function (a, b) {
                return a.start - b.start || a.end - b.end;
            });
            var merged = [];
            var cur = { start: parts[0].start, end: parts[0].end };
            for (var pi = 1; pi < parts.length; pi++) {
                if (cur.end + 1 >= parts[pi].start) {
                    cur.end = Math.max(cur.end, parts[pi].end);
                } else {
                    merged.push(cur);
                    cur = { start: parts[pi].start, end: parts[pi].end };
                }
            }
            merged.push(cur);
            for (var mi = 0; mi < merged.length; mi++) {
                var skey = merged[mi].start + '-' + merged[mi].end;
                if (!has(segMap, skey)) {
                    segMap[skey] = { start: merged[mi].start, end: merged[mi].end, weeks: [] };
                    segList.push(segMap[skey]);
                }
                segMap[skey].weeks.push(wk);
            }
        }
        for (var sl = 0; sl < segList.length; sl++) {
            slots.push({
                name: grp.name, teacher: grp.teacher, location: grp.location, day: grp.day,
                start: segList[sl].start, end: segList[sl].end, weeks: segList[sl].weeks
            });
        }
    }

    if (!slots.length) {
        throw new Error('这个学期没有解析到任何课程：请在「我的课表」里确认个人课表已经显示，再重新提取');
    }

    slots.sort(function (a, b) {
        if (a.day !== b.day) return a.day - b.day;
        if (a.start !== b.start) return a.start - b.start;
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        if (a.end !== b.end) return a.end - b.end;
        var placeA = a.location || '';
        var placeB = b.location || '';
        if (placeA !== placeB) return placeA < placeB ? -1 : 1;
        var teacherA = a.teacher || '';
        var teacherB = b.teacher || '';
        return teacherA < teacherB ? -1 : (teacherA > teacherB ? 1 : 0);
    });

    var courseByKey = {};
    var courses = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    var missingTeacherNames = {};
    var missingLocationNames = {};
    var sampleNames = [];
    for (var s = 0; s < slots.length; s++) {
        var slot = slots[s];
        var ckey = JSON.stringify([slot.name, slot.teacher || '']);
        var course = courseByKey[ckey];
        if (!course) {
            course = { name: slot.name, teacher: slot.teacher, note: null, blocks: [] };
            courseByKey[ckey] = course;
            courses.push(course);
        }
        var runs = runsOf(slot.weeks);
        for (var rr = 0; rr < runs.length; rr++) {
            if (runs[rr].end > maxWeek) maxWeek = runs[rr].end;
            course.blocks.push({
                dayOfWeek: slot.day, startPeriod: slot.start, endPeriod: slot.end,
                startWeek: runs[rr].start, endWeek: runs[rr].end, weekType: runs[rr].weekType,
                location: slot.location
            });
        }
        if (slot.end > maxPeriod) maxPeriod = slot.end;
        if (!slot.teacher) missingTeacherNames['n' + slot.name] = true;
        if (!slot.location) missingLocationNames['n' + slot.name] = true;
        if ((!slot.teacher || !slot.location) && sampleNames.length < 3 && sampleNames.indexOf(slot.name) < 0) {
            sampleNames.push(slot.name);
        }
    }

    // ---- 提醒（顺序即展示顺序） ----
    var name0 = termName();
    if (text(term.selection) === 'current') {
        warn('已导入教务标记的当前学期（' + shortName(name0) + '）；要导入别的学期，目前无法选择，请核对学年学期');
    } else {
        warn('没能读到教务标记的当前学期，已按学期列表第 1 项导入（' + shortName(name0) + '），请核对学年学期');
    }

    var suppliedStart = text(term.startDate).substring(0, 10);
    var firstDay = mondayOf(suppliedStart);
    if (firstDay) {
        if (firstDay !== suppliedStart) {
            warn('教务给出的开学日期是 ' + suppliedStart + '，第 1 周已回退到同一周的周一 ' + firstDay + '，请在学期管理里核对');
        }
    } else {
        firstDay = mondayOf(text(data.today));
        if (!firstDay) throw new Error('没能确定开学日期：教务给出的日期和本机日期都无法识别');
        warn('没能从教务读到开学日期，第 1 周已按本机日期所在周的周一推算为 ' + firstDay + '，请在学期管理里核对');
    }

    var configured = integerOf(term.totalWeeks);
    var usedDefault = !(configured >= 1);
    var totalWeeks = usedDefault ? DEFAULT_WEEKS : Math.min(configured, MAX_WEEK);
    if (usedDefault) {
        warn('教务没有给出学期总周数，已按 20 周导入，请在学期管理里核对');
    } else if (configured > MAX_WEEK) {
        warn('教务给出的学期总周数超过 30 周，已按 30 周导入，请在学期管理里核对');
    }
    if (maxWeek > totalWeeks) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过原定的 ' + totalWeeks + ' 周，学期总周数已按 ' + maxWeek + ' 周导入，请在学期管理里核对');
        totalWeeks = maxWeek;
    }

    var periodTimes = schoolPeriods(periodRows);
    if (periodTimes) {
        warn('已按教务给出的节次时间导入（共 ' + periodTimes.length + ' 节），学校调整后请在学期管理里核对');
    } else {
        periodTimes = DEFAULT_PERIODS.slice(0);
        warn('没能从教务读到节次时间，已按默认的 11 节节次时间导入（第 1 节 08:00-08:45，第 11 节 20:20-21:05），请在学期管理里核对');
    }
    var filled = [];
    var uncoveredFrom = 0;
    var lastPeriod = periodTimes[periodTimes.length - 1];
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var nextStart = minutesOf(lastPeriod.end) + BREAK_MINUTES;
        var nextEnd = nextStart + CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) {
            uncoveredFrom = p;
            break;
        }
        lastPeriod = { periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) };
        periodTimes.push(lastPeriod);
        filled.push(p);
    }
    if (filled.length) {
        warn('课表用到了' + sectionsText(filled) + '，学校节次时间没有覆盖，已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    if (changeRows === null) {
        warn('没能取到调课 / 停课记录，课表没有扣除这些周次的变动，请以教务为准核对');
    }
    if (applied > 0) {
        warn('已按教务的调课 / 停课记录调整了 ' + applied + ' 条课表安排，请以教务为准核对');
    }
    for (var u = 0; u < unmatched.length; u++) {
        warn('调课 / 停课记录「' + unmatched[u] + '」没能对上课表（原课节次不一致或不在本学期），已忽略，请以教务为准核对');
    }
    for (var v = 0; v < unknownType.length; v++) {
        warn('调课记录「' + unknownType[v] + '」的类型没认出，原安排未改，请对照教务核对');
    }
    if (incompleteChanges.length > 0) {
        warn('有 ' + incompleteChanges.length + ' 条调课记录没能对上（例如「' + incompleteChanges[0] + '」），原安排未改，请对照教务核对');
    }

    if (experimentRows === null) {
        warn('没能读到实验课安排，已只导入理论课；有实验课的话请稍后重新提取');
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

    var missingTeacher = countKeys(missingTeacherNames);
    var missingLocation = countKeys(missingLocationNames);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shown = sampleNames.map(function (n) { return shortName(n); });
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shown.join('、') + '）：已照常导入，空着的项可在「编辑课程」里补上');
    }
    if (droppedWeeks > 0) warn('有 ' + droppedWeeks + ' 个周次超过第 30 周，超出的部分没有导入');

    if (warnings.length > MAX_WARNINGS) {
        var hidden = warnings.length - (MAX_WARNINGS - 1);
        warnings = warnings.slice(0, MAX_WARNINGS - 1);
        warnings.push('另有 ' + hidden + ' 条核对提示没有显示，请以教务为准核对');
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
            courses: courses
        }]
    });

    // 教务 jc.do 给出的节次表：必须从 1 连续编号、每节 HH:mm 合法且结束晚于开始，否则整表不用。
    function schoolPeriods(rows) {
        if (!rows || !rows.length) return null;
        var sorted = rows.slice(0).sort(function (a, b) {
            return integerOf((a || {}).DM) - integerOf((b || {}).DM);
        });
        var out = [];
        for (var i = 0; i < sorted.length; i++) {
            var item = sorted[i] || {};
            var idx = integerOf(item.DM);
            var from = text(item.KSSJ);
            var to = text(item.JSSJ);
            if (idx !== i + 1 || !TIME_PATTERN.test(from) || !TIME_PATTERN.test(to) || minutesOf(to) <= minutesOf(from)) {
                return null;
            }
            out.push({ periodIndex: idx, start: from, end: to });
        }
        return out;
    }
})()
