(function () {
    // 暨南大学教务适配器（金智教育 jwapp / 我的课表 wdkb）—— 原始数据到空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 JNU/jnu_01.js（MIT）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：03d161a；本校脚本最后提交 80e30cf。
    //
    // 纯转换：不碰页面、不发请求、不读挂钟。「今天」用 extract.js 交来的 today，用例可以复现。
    //
    // 移植改动（与 AUDIT.md 一致）：
    //   1. 上课时间 SKSJ 按空格拆成周次、星期、节次。周次文字要接住无逗号的前置单双标记、后置单双标记、
    //      「第1-第8周」、「共 N 周」备注（只剥备注本身）。
    //   2. 节次时间只用上游写明的珠海校区 13 节，并提醒只按珠海校区。不给其它校区编时间。
    //   3. 没有校历：开学日按 today 所在周的周一推算并提醒；总周数用 20，只有课表里有更晚的周才抬高并提醒。
    //   4. 教师、教室写成未知、待定、暂无时交 null。缺了照常导入，汇总进提醒。
    //   5. 同一门课、同一天、同一周次段，节次重叠或紧挨着的（下一节不晚于上一节结束再加 1）并成一段。
    //   6. 课表用到第 13 节以后，按课间 10 分钟、每节 45 分钟顺推，越过当天 23:59 的如实说明。
    //   7. 带进提醒的课名、周次原文截到 20 字，每条提醒不超过 200 字。
    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var rows = data.rows || [];
    var term = data.term || {};

    var SCHOOL = '暨南大学';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var CLASS_MINUTES = 45;
    var BREAK_MINUTES = 10;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;

    // 珠海校区节次时间，逐节照上游 jnu_01.js 里写死的 13 节。
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '12:40', end: '13:25' },
        { periodIndex: 6, start: '13:35', end: '14:20' },
        { periodIndex: 7, start: '14:30', end: '15:15' },
        { periodIndex: 8, start: '15:25', end: '16:10' },
        { periodIndex: 9, start: '16:20', end: '17:05' },
        { periodIndex: 10, start: '17:15', end: '18:00' },
        { periodIndex: 11, start: '19:00', end: '19:45' },
        { periodIndex: 12, start: '19:55', end: '20:40' },
        { periodIndex: 13, start: '20:50', end: '21:35' }
    ];

    var EMPTY_WORD = {
        '未知': true,
        '未知教师': true,
        '未知老师': true,
        '未知地点': true,
        '未知教室': true,
        '待定': true,
        '暂无': true,
        '暂无教师': true,
        '暂无老师': true,
        '暂无教室': true,
        '暂无地点': true,
        '无': true,
        '空': true
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function shortName(value) {
        var line = text(value);
        if (line.length <= NAME_LIMIT) return line;
        return line.substring(0, NAME_LIMIT - 1) + '…';
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

    function utcOfIso(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
        return date.getTime();
    }

    function mondayOf(iso) {
        var ms = utcOfIso(iso);
        if (ms === null) return null;
        var date = new Date(ms);
        var offset = (date.getUTCDay() + 6) % 7;
        return isoOf(new Date(ms - offset * 86400000));
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    function countKeys(dict) {
        var n = 0;
        var key;
        for (key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
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

    function termName() {
        var explicit = text(term.name);
        if (explicit) return explicit;
        var m = /^(\d{4})-(\d{4})-(\d{1,2})$/.exec(text(term.code));
        if (!m) {
            var code = text(term.code);
            return code ? (SCHOOL + ' ' + code) : SCHOOL;
        }
        var index = parseInt(m[3], 10);
        var label = index === 1 ? '第一学期' : (index === 2 ? '第二学期' : ('第' + index + '学期'));
        return SCHOOL + ' ' + m[1] + '-' + m[2] + '学年' + label;
    }

    function cleanName(value) {
        var name = text(value);
        if (!name || name === '未知' || name === '未知课程') return '';
        return name;
    }

    function cleanPlace(value) {
        var name = text(value);
        if (!name || EMPTY_WORD[name]) return null;
        return name;
    }

    function dayOf(token) {
        var t = text(token);
        if (t === '星期天' || t === '星期日' || t === '周日' || t === '周天') return 7;
        var names = ['一', '二', '三', '四', '五', '六'];
        var i;
        for (i = 0; i < names.length; i++) {
            if (t === '星期' + names[i] || t === '周' + names[i]) return i + 1;
        }
        return null;
    }

    function sectionsOf(source) {
        var s = text(source).replace(/[\[\]【】第节]/g, '').replace(/\s+/g, '');
        if (!s) return null;
        var m = /^(\d+)-(\d+)$/.exec(s);
        var start;
        var end;
        if (m) {
            start = parseInt(m[1], 10);
            end = parseInt(m[2], 10);
        } else {
            m = /^(\d+)$/.exec(s);
            if (!m) return null;
            start = parseInt(m[1], 10);
            end = start;
        }
        if (isNaN(start) || isNaN(end)) return null;
        if (end < start) { var swap = start; start = end; end = swap; }
        if (!(start >= 1)) return null;
        return { start: start, end: end };
    }

    // SKSJ：周次在前，星期居中，节次在后。周次本身可以带空格，所以按星期那个词切开，而不是只认三段。
    function parseSksj(source) {
        var raw = text(String(source).split(String.fromCharCode(12288)).join(' '));
        if (!raw) return null;
        var parts = raw.split(/\s+/);
        var dayIndex = -1;
        var day = null;
        var i;
        for (i = 0; i < parts.length; i++) {
            var found = dayOf(parts[i]);
            if (found) { dayIndex = i; day = found; break; }
        }
        if (dayIndex < 0) return null;
        var weekParts = [];
        for (i = 0; i < dayIndex; i++) weekParts.push(parts[i]);
        var sectionParts = [];
        for (i = dayIndex + 1; i < parts.length; i++) sectionParts.push(parts[i]);
        return {
            weekText: weekParts.join(' '),
            day: day,
            section: sectionsOf(sectionParts.join(''))
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
        // 「共 N 周」只剥备注本身，不能从「共」删到行尾，否则后面的真实周次会一起没掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 「第1-第8周」先去掉区间终点前的「第」，再去掉剩下的「第」，避免拆成第 1 周和第 8 周
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        cleaned = cleaned.replace(/第/g, '');
        // 无逗号的前置标记：本段自己以前置标记开头时，后面那个标记归下一段
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
        var tokens = cleaned.replace(/\s+/g, ',').split(/,+/);
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
            var found = segment.match(/[0-9]+(?:-[0-9]+)?/g) || [];
            var f;
            for (f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                if (end > 99) end = 99;
                var week;
                for (week = start; week <= end; week++) {
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
            if (step === 2 && run.start !== run.end) {
                run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            }
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    function mergeBlocks(blocks) {
        var copy = blocks.slice(0);
        copy.sort(function (a, b) {
            if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
            if (a.startWeek !== b.startWeek) return a.startWeek - b.startWeek;
            if (a.endWeek !== b.endWeek) return a.endWeek - b.endWeek;
            if (a.weekType < b.weekType) return -1;
            if (a.weekType > b.weekType) return 1;
            var la = a.location || '';
            var lb = b.location || '';
            if (la < lb) return -1;
            if (la > lb) return 1;
            return a.startPeriod - b.startPeriod;
        });
        var merged = [];
        var i;
        for (i = 0; i < copy.length; i++) {
            var block = copy[i];
            var prev = merged.length ? merged[merged.length - 1] : null;
            if (prev && prev.dayOfWeek === block.dayOfWeek && prev.weekType === block.weekType &&
                prev.startWeek === block.startWeek && prev.endWeek === block.endWeek &&
                (prev.location || '') === (block.location || '') &&
                block.startPeriod <= prev.endPeriod + 1) {
                if (block.startPeriod < prev.startPeriod) prev.startPeriod = block.startPeriod;
                if (block.endPeriod > prev.endPeriod) prev.endPeriod = block.endPeriod;
            } else {
                merged.push({
                    dayOfWeek: block.dayOfWeek,
                    startPeriod: block.startPeriod,
                    endPeriod: block.endPeriod,
                    startWeek: block.startWeek,
                    endWeek: block.endWeek,
                    weekType: block.weekType,
                    location: block.location
                });
            }
        }
        return merged;
    }

    function sectionsText(list) {
        var parts = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            parts.push(list[i] === list[j] ? String(list[i]) : (list[i] + '-' + list[j]));
            i = j + 1;
        }
        return '第 ' + parts.join('、') + ' 节';
    }

    var order = [];
    var byCourse = {};
    var maxWeek = 0;
    var maxPeriod = 0;
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var weekSamples = [];
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];

    function remember(name) {
        if (fieldSamples.length >= 3) return;
        var i;
        for (i = 0; i < fieldSamples.length; i++) {
            if (fieldSamples[i] === name) return;
        }
        fieldSamples.push(name);
    }

    var r;
    for (r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var name = cleanName(row.KCM);
        var sksj = text(row.SKSJ);
        if (!name && !sksj) continue;
        var slot = parseSksj(sksj);
        if (!name) { missing.name++; continue; }
        if (!slot) { missing.day++; continue; }
        if (!slot.section || slot.section.end > MAX_PERIOD) { missing.period++; continue; }
        var weeks = weeksOf(slot.weekText);
        if (!weeks.length) {
            missing.week++;
            if (weekSamples.length < 3 && slot.weekText) weekSamples.push(slot.weekText);
            continue;
        }
        var teacher = cleanPlace(row.SKJS);
        var location = cleanPlace(row.JASMC);
        var key = name + String.fromCharCode(1) + (teacher || '');
        if (!byCourse[key]) {
            byCourse[key] = { name: name, teacher: teacher, note: null, blocks: [] };
            order.push(key);
        }
        if (!teacher) missingTeacherCourses[key] = name;
        if (!location) missingLocationCourses[key] = name;
        if (!teacher || !location) remember(name);
        if (slot.section.end > maxPeriod) maxPeriod = slot.section.end;
        var runs = runsOf(weeks);
        var n;
        for (n = 0; n < runs.length; n++) {
            if (runs[n].end > maxWeek) maxWeek = runs[n].end;
            byCourse[key].blocks.push({
                dayOfWeek: slot.day,
                startPeriod: slot.section.start,
                endPeriod: slot.section.end,
                startWeek: runs[n].start,
                endWeek: runs[n].end,
                weekType: runs[n].weekType,
                location: location
            });
        }
    }

    if (!order.length) {
        throw new Error('没有解析到任何课程：请在「我的课表」里确认课表已经显示出来，再重新提取');
    }

    var courses = [];
    var c;
    for (c = 0; c < order.length; c++) {
        var item = byCourse[order[c]];
        item.blocks = mergeBlocks(item.blocks);
        courses.push(item);
    }

    var firstDay = mondayOf(text(data.today));
    if (!firstDay) throw new Error('没能确定开学日期：教务没有给出，本机日期也不合法');

    var totalWeeks = DEFAULT_WEEKS;
    var raised = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raised = true;
    }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    var periodTimes = PERIOD_TIMES.slice(0);
    var filled = [];
    var uncoveredFrom = 0;
    var p;
    for (p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + BREAK_MINUTES;
        var nextEnd = nextStart + CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        filled.push(p);
    }

    warn('节次时间只按珠海校区，其它校区请在学期管理里核对上课时间');
    warn('没能从教务取到开学日期，已按本机日期推算为 ' + firstDay + '（这一周的周一），请在学期管理里核对');
    if (raised) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过 ' + DEFAULT_WEEKS + ' 周，已按 ' + totalWeeks + ' 周导入，请在学期管理里核对');
    } else {
        warn('教务没有给出学期总周数，已按 ' + DEFAULT_WEEKS + ' 周导入，请在学期管理里核对');
    }
    if (filled.length) {
        warn('课表用到了' + sectionsText(filled) + '，学校公布的节次时间没有覆盖，已按上一节下课后课间 ' + BREAK_MINUTES + ' 分钟、每节 ' + CLASS_MINUTES + ' 分钟补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('缺星期 ' + missing.day + ' 行');
        if (missing.period) reasons.push('缺节次 ' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次 ' + missing.week + ' 行');
        if (weekSamples.length) reasons.push('认不出的周次如「' + shortName(weekSamples[0]) + '」');
        warn('有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') + '），已跳过，如发现少课请反馈');
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shown = [];
        var s;
        for (s = 0; s < fieldSamples.length; s++) shown.push(shortName(fieldSamples[s]));
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shown.join('、') + '）：已照常导入，' + emptyText + '，可在「编辑课程」里补上');
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处周次里的括号只写了纯数字（如「(1)」「(1-2)」），那是教学班序号不是周次，已忽略，请核对');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，已忽略，请核对');
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超过了第 ' + MAX_WEEK + ' 周，超出的部分没有导入');
    }
    if (orphanMarkers > 0) {
        warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次，已忽略');
    }
    if (bothMarks > 0) {
        warn('有 ' + bothMarks + ' 处周次里「单」「双」同时出现，已按每周都上处理，请核对');
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
                name: termName(),
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
