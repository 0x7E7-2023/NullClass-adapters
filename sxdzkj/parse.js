(function () {
    // 山西电子科技学院教务适配器（青果教务）—— 第二步：纯函数，把 extract.js 交出的课程行解析成课表载荷。
    //
    // 移植自 shiguang_warehouse 的 SXDZKJ/sxdzkj.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 REnss3536；任务卡写星河欲转，以 adapters.yaml 的 maintainer 为准）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4（2026-11-01 与 origin/main 对齐）
    //   本校脚本最后一次修改 80e30cf（2026-09-23）
    //
    // 模板是已审计的青果件 nynu（南阳师范学院）。取数层不同构（本校是课表查询页的表格，上课时间地点写在第 11 列），
    // 周次解析、提醒限长、缺教师 / 缺教室汇总、连堂合并、补节次沿用 nynu（周次函数来自 jxfu / jyvtc）。
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」）：
    //   1. 一行可有多段上课安排，用分号分开。星期和节次在「三[7-8]」这种写法里，周次在它前面，教室在它后面
    //   2. 周次文字沿用 nynu 的 weeksOf（含无逗号前置单双、第1-第8周、共 N 周只剥备注）
    //   3. 教师 / 教室拿不到，或写成未知、待定、暂无，就是空；按类型汇总进提醒
    //   4. 节次时间用上游写死的 10 节（学校公布的时间），超出的按统一修订 H3 顺推，并在提醒里说明
    //   5. 开学日：上游不给。按学期推算（第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一）并提醒
    //   6. 合并：先去掉完全相同的行，再把同一门课节次首尾相接或重叠（下一节起点不晚于上一节终点加 1）的合成一块，最后周次取并集
    //   7. 带进提醒的教务原文先截到 20 字，每条提醒不超过 200 字

    var SCHOOL_NAME = '山西电子科技学院';
    var SCHOOL_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;
    var MAX_PERIOD = 20;
    var NAME_TEXT_LIMIT = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_WARNINGS = 20;
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;

    // 上游 importPresetTimeSlots 写死的 10 节，逐节照抄。课表用到第 11 节及以后时按顺推补
    // （载荷带了 periodTimes 时应用不会自己补）。
    var BUILTIN_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:50' },
        { periodIndex: 2, start: '09:00', end: '09:50' },
        { periodIndex: 3, start: '10:10', end: '11:00' },
        { periodIndex: 4, start: '11:10', end: '12:00' },
        { periodIndex: 5, start: '14:00', end: '14:50' },
        { periodIndex: 6, start: '15:00', end: '15:50' },
        { periodIndex: 7, start: '16:10', end: '17:00' },
        { periodIndex: 8, start: '17:10', end: '18:00' },
        { periodIndex: 9, start: '19:00', end: '19:50' },
        { periodIndex: 10, start: '20:00', end: '20:50' }
    ];

    var KIND_CN = { first: '一', second: '二' };
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' }
    };

    var data;
    try {
        data = JSON.parse(__ncInput);
    } catch (e) {
        throw new Error('教务系统返回的课表内容读不出来，请重新登录后再点「提取课表」');
    }
    if (!data || typeof data !== 'object') data = {};
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
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

    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
    }

    function isoOfAny(value) {
        var matched = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
        if (!matched) return null;
        var month = parseInt(matched[2], 10);
        var day = parseInt(matched[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return matched[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function mondayOfIso(iso) {
        if (!iso) return null;
        return isoOf(mondayOnOrBefore(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10),
            parseInt(iso.substring(8, 10), 10)
        ));
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
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

    var termYear = intOf(term.xn);
    if (termYear === null || termYear < 2000 || termYear > 2100) termYear = null;
    var termKind = text(term.xq) === '0' ? 'first' : (text(term.xq) === '1' ? 'second' : null);
    if (!termYear) termKind = null;

    function termName() {
        if (!termYear || !termKind) return SCHOOL_NAME + ' 当前学期';
        return termYear + '-' + (termYear + 1) + '学年第' + KIND_CN[termKind] + '学期';
    }

    function estimateStart(todayIso) {
        if (!termYear || !termKind) {
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天所在周的周一' };
        }
        var anchor = KIND_ANCHOR[termKind];
        var year = termYear + (termKind === 'first' ? 0 : 1);
        return {
            iso: isoOf(mondayOnOrBefore(year, anchor.month, anchor.day)),
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

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        cleaned = cleaned.replace(/第/g, '');
        // 无逗号的前置单双：本段自己以前缀标记开头时，后一个标记归下一段（前面补逗号）
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

    // 整串里恰好一个不在括号里的「单周」或「双周」时，只对区间生效（单独的一周不受影响）
    function weeksOfCell(source) {
        var cleaned = text(source).replace(/共\s*[0-9]+\s*周?/g, ' ');
        var words = cleaned.match(/[单双]\s*周/g) || [];
        var marks = cleaned.match(/[单双]/g) || [];
        if (words.length !== 1 || marks.length !== 1 || /[(（]\s*[单双]/.test(cleaned)) return weeksOf(cleaned);
        var mark = words[0].charAt(0);
        var plain = fullWidthToHalf(cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-')).replace(/[单双]\s*周/g, ' ');
        var pieces = plain.split(/[,\s]+/);
        var out = [];
        for (var i = 0; i < pieces.length; i++) {
            if (!pieces[i]) continue;
            out.push(/[0-9]-第?[0-9]/.test(pieces[i]) ? pieces[i] + mark : pieces[i]);
        }
        return weeksOf(out.join(','));
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

    function blankToNull(value) {
        var line = text(value);
        if (!line) return null;
        if (/^(未知|暂无|待定|无)(教师|老师|地点|教室)?$/.test(line)) return null;
        return line;
    }

    var DAY_OF = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

    function stripCode(value) {
        return text(String(value === null || value === undefined ? '' : value).replace(/\[[^\]]*\]/g, ''));
    }

    // 一段安排：周次文字 + 星期[起-止节] + 教室。一格里用分号隔开的多段各算一条。
    function sessionsOf(schedule) {
        var pieces = text(schedule).split(/[；;]/);
        var sessions = [];
        var p;
        for (p = 0; p < pieces.length; p++) {
            var piece = text(pieces[p]);
            if (!piece) continue;
            var mark = /([一二三四五六日天])\s*[\[［]\s*(\d+)\s*(?:[-~～至到]\s*(\d+))?\s*[\]］]/.exec(piece);
            if (!mark) {
                sessions.push({ bad: true, raw: piece });
                continue;
            }
            var start = parseInt(mark[2], 10);
            var end = mark[3] ? parseInt(mark[3], 10) : start;
            if (end < start) { var swap = start; start = end; end = swap; }
            sessions.push({
                bad: false,
                weekSrc: text(piece.substring(0, mark.index)),
                day: DAY_OF[mark[1]] || 0,
                start: start,
                end: end,
                location: text(piece.substring(mark.index + mark[0].length)),
                raw: piece
            });
        }
        return sessions;
    }

    var courses = [];
    var byName = {};
    var entries = [];
    var unreadable = { name: 0, time: 0 };
    var unreadableSamples = [];
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var missingAnyCourses = {};
    var fieldSamples = [];

    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + (teacher || '');
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, blocks: [] };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    function noteUnreadable(reason, original) {
        unreadable[reason]++;
        var sample = shortName(original);
        if (unreadableSamples.length < 3 && unreadableSamples.indexOf(sample) < 0) unreadableSamples.push(sample);
    }

    function noteMissing(dict, name) {
        dict[name] = true;
        missingAnyCourses[name] = true;
        if (fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) fieldSamples.push(name);
    }

    var anyContent = rows.length > 0;
    for (var b = 0; b < rows.length; b++) {
        var row = rows[b] || {};
        var schedule = text(row.schedule);
        var rawName = stripCode(row.name);
        var rawTeacher = stripCode(row.teacher);
        if (!rawName && !rawTeacher && !schedule) continue;
        var name = rawName;
        if (!name) {
            noteUnreadable('name', schedule || rawTeacher || '未命名');
            continue;
        }
        var sessions = sessionsOf(schedule);
        if (!sessions.length) {
            noteUnreadable('time', schedule || name);
            continue;
        }
        var teacher = blankToNull(rawTeacher);
        var s;
        for (s = 0; s < sessions.length; s++) {
            var session = sessions[s];
            if (session.bad || !session.day || session.start < 1 || session.end > MAX_PERIOD || !session.weekSrc) {
                noteUnreadable('time', session.raw || schedule);
                continue;
            }
            var weeks = weeksOfCell(session.weekSrc);
            if (!weeks.length) {
                noteUnreadable('time', session.raw || schedule);
                continue;
            }
            var location = blankToNull(session.location);
            if (!teacher) noteMissing(missingTeacherCourses, name);
            if (!location) noteMissing(missingLocationCourses, name);
            entries.push({
                name: name,
                teacher: teacher,
                location: location,
                day: session.day,
                start: session.start,
                end: session.end,
                weeks: weeks,
                course: courseOf(name, teacher)
            });
        }
    }

    function cmpText(a, b) {
        var left = a || '';
        var right = b || '';
        return left < right ? -1 : (left > right ? 1 : 0);
    }

    function sameSlotDay(a, b) {
        return a.name === b.name && a.teacher === b.teacher && a.location === b.location && a.day === b.day;
    }

    function weeksKey(entry) {
        return entry.weeks.join(',');
    }

    function orderStageOne(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || cmpText(weeksKey(a), weeksKey(b)) || (a.start - b.start);
    }

    function orderStageTwo(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end);
    }

    function unionWeeks(a, b) {
        var all = a.concat(b);
        var have = {};
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (have[all[i]]) continue;
            have[all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    function dropExactDuplicates(list) {
        var ledger = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var key = 'k' + JSON.stringify([entry.name, entry.teacher, entry.location, entry.day, entry.start, entry.end, entry.weeks]);
            if (ledger[key]) continue;
            ledger[key] = true;
            out.push(entry);
        }
        return out;
    }

    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next) && next.start <= current.end + 1) {
                if (next.end > current.end) current.end = next.end;
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    function mergeStageTwo(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && current.start === next.start && current.end === next.end) {
                current.weeks = unionWeeks(current.weeks, next.weeks);
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    var stageOne = dropExactDuplicates(entries).sort(orderStageOne);
    var merged = mergeStageTwo(mergeStageOne(stageOne).sort(orderStageTwo));

    var maxWeek = 0;
    var maxPeriod = 0;
    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            if (run.end > maxWeek) maxWeek = run.end;
            if (item.end > maxPeriod) maxPeriod = item.end;
            item.course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item.location || null
            });
        }
    }

    var name0 = termName();
    if (!anyContent) {
        throw new Error(
            '这个学期（' + name0 + '）在教务系统里还没有课；如果要导入别的学期，' +
            '请在教务页面里切换学期后再点「提取课表」'
        );
    }
    if (!courses.length) {
        throw new Error(
            '教务系统返回了课表，但没有一门课能读成课程（课表页面的格式可能改过）：' +
            '请把教务页面的课表截图反馈给空课'
        );
    }

    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: null,
            blocks: courses[c].blocks
        });
    }

    var todayRaw = isoOfAny(data.today);
    var todayIso = todayRaw || localTodayIso();
    var start = estimateStart(todayIso);

    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    var periodTimes = BUILTIN_PERIOD_TIMES.slice(0);
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        var prevEnd = minutesOf(prev.end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    if (text(term.source) === 'page') {
        warn(
            '只导入了教务页面上当前选中的学期（' + name0 +
            '）；要导入别的学期，请先在教务系统里切到那个学期再点「提取课表」'
        );
    } else {
        warn(
            '没能从教务页面读到当前学期，已按今天的日期判断为「' + name0 +
            '」；如果不是你要的学期，请在「学期管理」里核对学期名称，并把这个问题反馈给我们'
        );
    }

    warn(
        '教务系统没有给出开学日期，第 1 周按「' + start.rule +
        '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
    );

    if (raisedBySchedule) {
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    warn(
        '已按学校公布的节次时间导入（第 1 节 ' + BUILTIN_PERIOD_TIMES[0].start + '-' + BUILTIN_PERIOD_TIMES[0].end +
        '，第 ' + BUILTIN_PERIOD_TIMES.length + ' 节 ' +
        BUILTIN_PERIOD_TIMES[BUILTIN_PERIOD_TIMES.length - 1].start + '-' +
        BUILTIN_PERIOD_TIMES[BUILTIN_PERIOD_TIMES.length - 1].end +
        '），请在「学期管理」里核对'
    );

    if (bySequence.length) {
        warn(
            '课表用到了' + sectionsText(bySequence) + '，学校公布的节次时间只到第 ' + BUILTIN_PERIOD_TIMES.length +
            ' 节，已补上：' + sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推，请在「学期管理」里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    var skipped = unreadable.name + unreadable.time;
    if (skipped > 0) {
        var reasons = [];
        if (unreadable.name) reasons.push('缺课程名 ' + unreadable.name + ' 条');
        if (unreadable.time) reasons.push('上课时间认不出 ' + unreadable.time + ' 条');
        var sampleTexts = [];
        for (var us = 0; us < unreadableSamples.length; us++) sampleTexts.push('「' + unreadableSamples[us] + '」');
        warn(
            '有 ' + skipped + ' 条课程内容没能读成课程（' + reasons.join('、') + '），已跳过，例如 ' +
            sampleTexts.join('') + '：如发现少课请反馈'
        );
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownFieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownFieldNames.push(shortName(fieldSamples[fs]));
        var extraField = countKeys(missingAnyCourses) - fieldSamples.length;
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        var extraText = extraField > 0 ? '，另有 ' + extraField + ' 门未列出' : '';
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + shownFieldNames.join('、') + extraText + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上'
        );
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」）：那是教学班序号不是周次，已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，已忽略，请核对这几门课的周次');
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
        terms: [
            {
                name: name0,
                firstDay: start.iso,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
