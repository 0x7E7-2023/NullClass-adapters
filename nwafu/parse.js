(function () {
    // 西北农林科技大学教务适配器（金智 jwapp / ehall 新门户「我的本研课表」wdkbby）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 NWAFU/nwafu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 123zhuzhu61）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945，本校脚本最后一次修改 177e7bb。
    // 输入是 extract.js 的 { term, today, rows }；每行只有课名、别名、教师、教室/教学楼、星期、节次、位串与周次文字。
    //
    // 移植改动：
    //   1. 周次先读 ZCMC 文字：逐段解析并取并集，兼容单双标记前置与后置两种写法；位串展开的 weeks 数组兜底；第 31 周起丢弃并提醒。
    //   2. 同课同教师同地点同星期同节次的周次取并集；连堂（下一节正好接着）且周次相同的合成一段；重复原始行先去重再计数。
    //   3. 课名按上游拼上 TYXMDM_DISPLAY；教师去重；地点按 JASMC/JAS → JXLDM_DISPLAY/JXLMC → XXXQMC 回落；占位词交 null。
    //   4. 开学日来自校历 XQKSRQ 并回退到周一；总周数用校历 ZZC，缺失用 20，更晚课周才抬高，超过 30 截断。
    //   5. 节次时间用学校冬令/夏令两套表，按今天日期选一套（05-01 至 09-30 用夏令）；第 12 节起按课间 10 分钟、每节 45 分钟顺推并提醒。
    //   6. 学期名用教务给的 MC，拿不到用学校名加学年学期；提醒原文截 20 字，统一出口限制为 20 条、每条 200 字。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var SCHOOL = '西北农林科技大学';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var CLASS_MINUTES = 45;
    var BREAK_MINUTES = 10;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;

    // 学校作息时间表：第 1-4 节冬夏相同，第 5 节起夏令提前半小时（上游 SLOTS_WINTER / SLOTS_SUMMER）。
    var PERIOD_TIMES_WINTER = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:55', end: '15:40' },
        { periodIndex: 7, start: '16:00', end: '16:45' },
        { periodIndex: 8, start: '16:55', end: '17:40' },
        { periodIndex: 9, start: '19:00', end: '19:45' },
        { periodIndex: 10, start: '19:50', end: '20:35' },
        { periodIndex: 11, start: '20:40', end: '21:25' }
    ];
    var PERIOD_TIMES_SUMMER = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:25', end: '16:10' },
        { periodIndex: 7, start: '16:30', end: '17:15' },
        { periodIndex: 8, start: '17:25', end: '18:10' },
        { periodIndex: 9, start: '19:30', end: '20:15' },
        { periodIndex: 10, start: '20:20', end: '21:05' },
        { periodIndex: 11, start: '21:10', end: '21:55' }
    ];

    var EMPTY_WORD = {
        '未知': true, '未知教师': true, '未知老师': true, '未知地点': true, '未知教室': true,
        '待定': true, '暂无': true, '暂无教师': true, '暂无老师': true, '暂无教室': true, '暂无地点': true
    };
    var XQ_CN = { '1': '一', '2': '二', '3': '三' };

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

    // "2026-2027-1" 拆成 { xn: "2026-2027", xq: "1" }
    function termCodes(dm) {
        var parts = text(dm).split('-');
        if (parts.length < 3) return null;
        var xn = parts[0] + '-' + parts[1];
        var xq = parts[2];
        if (!/^[0-9]{4}-[0-9]{4}$/.test(xn) || !/^[0-9]+$/.test(xq)) return null;
        return { xn: xn, xq: xq };
    }

    function termName() {
        var mc = text(term.mc);
        if (mc) return mc;
        var codes = termCodes(text(term.dm));
        if (codes) return SCHOOL + ' ' + codes.xn + '学年第' + (XQ_CN[codes.xq] || codes.xq) + '学期';
        return text(term.dm) ? SCHOOL + ' ' + text(term.dm) : SCHOOL + ' 课表';
    }

    // ZCMC 文字 → 周号数组。逐段解析并取并集；单双标记既可能写在段首，也可能写在段尾。
    // 兼容：1-16周、第1周至第8周、第1-第8周、1,3,5周、(单)1-8周、(双)9-16周、1-8周(单)9-16周(双)。
    function parseWeekText(value) {
        var source = text(value);
        if (!source) return [];
        // 「共 N 周」只是备注，只剥掉备注本身，别吞后面的真实周次段
        source = source.replace(/共\s*[0-9]+\s*周?/g, ' ');
        // 全角括号 / 顿号先归一，后面按半角处理
        source = source.replace(/（/g, '(').replace(/）/g, ')').replace(/、/g, ',').replace(/；/g, ';');
        // 「第3-4节」「(2-3节)」是节次不是周次：整段摘掉（ZCMC 有时把节次写在前面，不能连带截断后面的真实周次）
        source = source.replace(/[0-9]+\s*(?:[-~至到]\s*[0-9]+)?\s*节/g, ' ');
        // 括号里不是周次写法的（(3学分)、(实验) 等）整组摘掉；只留 (单)/(双)/(1-16周) 这类
        source = source.replace(/\(([^()]*)\)/g, function (all, inner) {
            var weekish = /^[\s0-9,\-~至到第单双周]+$/.test(inner) && /[0-9单双]/.test(inner);
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
            var pattern = /(\(\s*[单双]\s*周?\s*\))|([单双]\s*周)|([0-9]+\s*周?\s*(?:[-~至到]\s*第?\s*[0-9]+)?)/g;
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

    // ZCMC 文字优先，位串展开的 weeks 数组兜底；第 31 周起丢弃并计数。
    function weeksOfRow(row) {
        var weeks = parseWeekText(row.ZCMC);
        if (!weeks.length) {
            var array = Array.isArray(row.weeks) ? row.weeks : [];
            for (var i = 0; i < array.length; i++) {
                var number = integerOf(array[i]);
                if (number && number >= 1) weeks.push(number);
            }
            weeks = weeks.sort(function (a, b) { return a - b; });
        }
        var kept = [];
        var dropped = 0;
        var previous = 0;
        for (var j = 0; j < weeks.length; j++) {
            if (weeks[j] === previous) continue;
            previous = weeks[j];
            if (weeks[j] > MAX_WEEK) {
                dropped++;
            } else {
                kept.push(weeks[j]);
            }
        }
        return { weeks: kept, dropped: dropped };
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

    // 上游 cleanTeacher：按中英文逗号/顿号/分号拆开、去空、去重后重新拼。
    function cleanTeacher(value) {
        var raw = text(value);
        if (!raw) return '';
        var names = raw.split(/[,，、;；]/);
        var seen = {};
        var out = [];
        for (var i = 0; i < names.length; i++) {
            var name = text(names[i]);
            if (!name || seen['n' + name]) continue;
            seen['n' + name] = true;
            out.push(name);
        }
        return out.join(',');
    }

    // 上游 buildPosition：先看教室，再看教学楼，最后看校区。
    function positionOf(row) {
        var room = text(row.JASMC) || text(row.JAS);
        if (room) return room;
        var building = text(row.JXLDM_DISPLAY) || text(row.JXLMC);
        if (building) return building;
        return text(row.XXXQMC);
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

    function rememberFieldSample(name) {
        if (fieldSamples.length >= 3 || fieldSamples.indexOf(name) >= 0) return;
        fieldSamples.push(name);
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var rowKey = JSON.stringify([text(row.KCM), text(row.TYXMDM_DISPLAY), text(row.SKJS), text(row.JASMC),
            text(row.JAS), text(row.JXLDM_DISPLAY), text(row.JXLMC), text(row.XXXQMC), text(row.SKXQ),
            text(row.KSJC), text(row.JSJC), text(row.ZCMC), text(row.SKZC)]);
        if (seenRows[rowKey]) continue;
        seenRows[rowKey] = true;

        var baseName = text(row.KCM);
        if (!baseName || baseName === '未知' || baseName === '未知课程') {
            missing.name++;
            continue;
        }
        var alias = text(row.TYXMDM_DISPLAY);
        var name = alias ? baseName + '(' + alias + ')' : baseName;
        var day = integerOf(row.SKXQ);
        if (!(day >= 1 && day <= 7)) {
            missing.day++;
            continue;
        }
        var startPeriod = integerOf(row.KSJC);
        var endPeriod = integerOf(row.JSJC);
        if (!(startPeriod >= 1)) {
            missing.period++;
            continue;
        }
        if (!(endPeriod >= startPeriod) || endPeriod > MAX_PERIOD) {
            missing.period++;
            continue;
        }
        var parsedWeeks = weeksOfRow(row);
        droppedWeeks += parsedWeeks.dropped;
        if (!parsedWeeks.weeks.length) {
            missing.week++;
            continue;
        }
        var teacher = realOrNull(cleanTeacher(row.SKJS));
        var location = realOrNull(positionOf(row));
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

    // 连堂合并：同一门课、同一天、同一地点，下一节正好接着，且周次完全相同，才合成一段。
    // 不同周次的连堂保持两段（周次不同不能硬拼），同节次的重复行在 slotKey 阶段已并成并集。
    var groups = {};
    var groupKeys = [];
    var g;
    for (g = 0; g < slotList.length; g++) {
        var groupKey = JSON.stringify([slotList[g].name, slotList[g].teacher || '', slotList[g].location || '', slotList[g].day]);
        if (!groups[groupKey]) {
            groups[groupKey] = [];
            groupKeys.push(groupKey);
        }
        groups[groupKey].push(slotList[g]);
    }
    var mergedSlots = [];
    for (g = 0; g < groupKeys.length; g++) {
        var members = groups[groupKeys[g]];
        members.sort(function (a, b) { return a.start - b.start; });
        var current = null;
        for (var m = 0; m < members.length; m++) {
            var candidate = members[m];
            if (current && current.end + 1 === candidate.start &&
                    current.weeks.join(',') === candidate.weeks.join(',')) {
                current.end = candidate.end;
            } else {
                current = { name: candidate.name, teacher: candidate.teacher, location: candidate.location,
                    day: candidate.day, start: candidate.start, end: candidate.end,
                    weeks: candidate.weeks.slice(0) };
                mergedSlots.push(current);
            }
        }
    }

    mergedSlots.sort(function (a, b) {
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
    for (var s = 0; s < mergedSlots.length; s++) {
        var item = mergedSlots[s];
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
        throw new Error('这个学期没有解析到任何课程：请在「我的本研课表」里确认个人课表已经显示，再重新提取');
    }

    var name0 = termName();
    if (text(term.selection) === 'list') {
        warn('没能读到教务当前的学年学期，已按学期列表第 1 项导入（' + shortName(name0) + '），请核对学年学期');
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
        warn('没能从校历读到合法的开学日期，第 1 周已按本机日期所在周的周一推算为 ' + firstDay + '，请在学期管理里核对');
    }

    var configuredWeeks = integerOf(term.totalWeeks);
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
        warn('没能从校历读到学期总周数，已按 20 周导入' + (raised ? '；课表排到更晚的周，另按课表调整' : '') + '，请在学期管理里核对');
    }
    if (clampedWeeks) warn('校历给出的学期总周数超过 30 周，已按 30 周导入，请在学期管理里核对');
    if (raised) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过原定的 ' + configuredWeeks + ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对');
    }

    // 载荷只有一个节次时间表：按今天日期在冬令、夏令之间选一套。
    var todayText = text(data.today);
    var todayValid = utcOfIso(todayText) !== null;
    var month = todayValid ? parseInt(todayText.substring(5, 7), 10) : 0;
    var summer = month >= 5 && month <= 9;
    var periodTimes = (summer ? PERIOD_TIMES_SUMMER : PERIOD_TIMES_WINTER).slice(0);
    var firstSlot = periodTimes[0];
    var lastSlot = periodTimes[periodTimes.length - 1];
    var seasonText = summer ? '夏令' : '冬令';
    var timesText = '（第 1 节 ' + firstSlot.start + '-' + firstSlot.end + '，第 ' + lastSlot.periodIndex + ' 节 ' +
        lastSlot.start + '-' + lastSlot.end + '），学校调整后请在学期管理里核对';
    if (todayValid) {
        warn('已按今天日期（' + todayText + '）选用' + seasonText + '节次时间' + timesText);
    } else {
        warn('没能确认今天的日期，已按' + seasonText + '节次时间导入' + timesText);
    }

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

    if (filled.length) {
        warn('课表用到了' + sectionsText(filled) + '，学校节次时间没有覆盖，已按上一节下课后课间 10 分钟、每节 45 分钟顺推补上，请在学期管理里核对');
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
