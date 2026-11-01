(function () {
    // 中国石油大学（北京）教务适配器（树维 for-std）—— 原始数据转课表。
    // 移植自 shiguang_warehouse 的 CUP/cup_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 larryyan）
    //   上游快照：03d161a，本校脚本提交 80e30cf（合并提交，提交者不是作者）
    //
    // 上游一条 activities 记录就是一门课在某个星期、一段节次、一组周次。
    // weekIndexes 一般是整数数组；写成「(单)1-8周(双)9-16周」这类文字时也要读对。
    // 节次时间先用教务给出的 courseUnitList。缺号或没盖住课表用到的节次时，只补缺的那几节
    // （上一节下课后课间 5 分钟、每节 45 分钟），否则课表格子会把更高的节次裁掉。补上的写进提醒。
    // 总周数：校历优先；没有校历用 20；只有课表排得更晚才抬高，并写进提醒。
    // 算出来的开学日、抬高的周数、缺教师、缺教室、补不上的节次，都要告诉学生。

    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var term = data.term || {};
    var meta = data.semesterMeta || {};
    var semesters = data.semesters || [];
    var activities = data.activities || [];
    var courseUnitList = data.courseUnitList || [];

    var MAX_WEEKS = 30;
    var DEFAULT_TOTAL_WEEKS = 20;
    var SCHOOL = '中国石油大学（北京）';
    var DAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];
    var KEY_SEP = String.fromCharCode(0);

    var warnings = [];
    var droppedWeeks = 0;
    var orphanMarkers = 0;
    var serialGroups = 0;
    var noteGroups = 0;
    var noteSample = '';
    var bothMarks = 0;
    var badWeekValues = 0;
    var unparsedWeeks = 0;
    var unparsedSample = '';

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function clip(value) {
        var s = text(value);
        if (s.length > 20) return s.slice(0, 20) + '…';
        return s;
    }

    function pushWarn(message) {
        if (message.length > 200) message = message.slice(0, 200);
        warnings.push(message);
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOfDate(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function isoOf(value) {
        var raw = text(value);
        if (!raw) return null;
        var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw);
        if (m) return m[1] + '-' + pad2(intOf(m[2])) + '-' + pad2(intOf(m[3]));
        return null;
    }

    function partsOf(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(iso));
        if (!m) return null;
        return [intOf(m[1]), intOf(m[2]), intOf(m[3])];
    }

    function weekdayOf(iso) {
        var p = partsOf(iso);
        if (!p) return null;
        var date = new Date(p[0], p[1] - 1, p[2]);
        if (isNaN(date.getTime())) return null;
        if (date.getFullYear() !== p[0] || date.getMonth() !== p[1] - 1 || date.getDate() !== p[2]) return null;
        var jsDay = date.getDay();
        return jsDay === 0 ? 7 : jsDay;
    }

    function minusDays(iso, days) {
        var p = partsOf(iso);
        if (!p) return null;
        var date = new Date(p[0], p[1] - 1, p[2]);
        date.setDate(date.getDate() - days);
        return isoOfDate(date);
    }

    function weekStartOf(iso, firstDayOfWeek) {
        var weekday = weekdayOf(iso);
        if (weekday === null) return null;
        return minusDays(iso, (weekday - firstDayOfWeek + 7) % 7);
    }

    function pinnedToday() {
        var pinned = isoOf(data.today);
        if (pinned) return pinned;
        return isoOfDate(new Date());
    }

    function todayWeekStart(firstDayOfWeek) {
        var today = pinnedToday();
        var weekday = weekdayOf(today);
        if (weekday === null) return null;
        return minusDays(today, (weekday - firstDayOfWeek + 7) % 7);
    }

    function weeksBetween(startIso, endIso) {
        var a = partsOf(startIso);
        var b = partsOf(endIso);
        if (!a || !b) return null;
        var days = Math.round(
            (new Date(b[0], b[1] - 1, b[2]).getTime() - new Date(a[0], a[1] - 1, a[2]).getTime()) / 86400000
        );
        if (!(days >= 0)) return null;
        return Math.ceil((days + 1) / 7);
    }

    function inferTermName(iso) {
        var p = partsOf(iso);
        if (!p) return null;
        var year = p[0];
        if (p[1] >= 8) return year + '-' + (year + 1) + '学年第一学期';
        if (p[1] >= 2) return (year - 1) + '-' + year + '学年第二学期';
        return (year - 1) + '-' + year + '学年第一学期';
    }

    function fmtTime(value) {
        var raw = text(value);
        if (!raw) return null;
        var withColon = /^(\d{1,2}):(\d{2})/.exec(raw);
        var digits;
        if (withColon) {
            digits = pad2(intOf(withColon[1])) + withColon[2];
        } else {
            digits = raw.replace(/[^0-9]/g, '');
            if (digits.length === 3) digits = '0' + digits;
            if (digits.length === 6) digits = digits.slice(0, 4);
            if (digits.length !== 4) return null;
        }
        var hour = intOf(digits.slice(0, 2));
        var minute = intOf(digits.slice(2, 4));
        if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null;
        return pad2(hour) + ':' + pad2(minute);
    }

    function minutesOf(hhmm) {
        return intOf(hhmm.slice(0, 2)) * 60 + intOf(hhmm.slice(3, 5));
    }

    function hhmmOf(total) {
        var hour = Math.floor(total / 60);
        var minute = total - hour * 60;
        return pad2(hour) + ':' + pad2(minute);
    }

    function sectionsOf(nums) {
        return '第 ' + nums.join('、') + ' 节';
    }

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

    // 周次文字。无逗号的「(单)1-8周(双)9-16周」：本段以标记开头时，后一个标记归下一段。
    // 「1-8周(单)9-16周(双)」仍是后置标记。「共 N 周」只剥备注本身。
    function weeksFromText(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        cleaned = cleaned.replace(/第/g, '');
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            var chunk = before.replace(/\s+$/, '').split(/[,，]+/).pop();
            if (/^[（(]?[单双]/.test(chunk)) return ',' + mark;
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
                    if (week < 1 || week > MAX_WEEKS) { droppedWeeks++; continue; }
                    if (!seen[week]) { seen[week] = true; weeks.push(week); }
                }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    function weeksFromList(source) {
        var out = [];
        var seen = {};
        for (var i = 0; i < source.length; i++) {
            var week = intOf(source[i]);
            if (week === null || week < 1) {
                badWeekValues++;
                continue;
            }
            if (week > MAX_WEEKS) {
                droppedWeeks++;
                continue;
            }
            if (seen[week] === true) continue;
            seen[week] = true;
            out.push(week);
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    function weeksOf(act) {
        var raw = act.weekIndexes;
        if (isArray(raw)) return weeksFromList(raw);
        if (typeof raw === 'number') return weeksFromList([raw]);
        if (typeof raw === 'string' && text(raw)) {
            var parsed = weeksFromText(raw);
            if (!parsed.length) {
                unparsedWeeks++;
                if (!unparsedSample) unparsedSample = raw;
            }
            return parsed;
        }
        return [];
    }

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

    function placeholder(value) {
        var s = text(value);
        return s === '未知' || s === '未知地点' || s === '待定' || s === '暂无'
            || s === '暂无教师' || s === '暂无教室';
    }

    function cleanTeacher(value) {
        var cleaned = text(String(value === null || value === undefined ? '' : value)
            .replace(/\(\d+\)/g, '')
            .replace(/\[\d+\]/g, '')
            .replace(/（\d+）/g, ''));
        if (!cleaned || placeholder(cleaned)) return '';
        return cleaned;
    }

    function teachersOf(act) {
        var raw = act.teachers;
        var out = [];
        var i;
        if (typeof raw === 'string') {
            var parts = raw.split(/[、,，;\/]/);
            for (i = 0; i < parts.length; i++) {
                var one = cleanTeacher(parts[i]);
                if (one && out.indexOf(one) === -1) out.push(one);
            }
        } else if (isArray(raw)) {
            for (i = 0; i < raw.length; i++) {
                var item = raw[i];
                var name = '';
                if (item && typeof item === 'object') name = cleanTeacher(item.name || item.personName || item.teacherName || '');
                else name = cleanTeacher(item);
                if (name && out.indexOf(name) === -1) out.push(name);
            }
        }
        return out.length ? out.join(',') : null;
    }

    function locationOf(act) {
        var room = text(act.room);
        if (placeholder(room)) room = '';
        if (!room) {
            room = text(act.building);
            if (placeholder(room)) room = '';
        }
        var campus = text(act.campus);
        if (placeholder(campus)) campus = '';
        if (room && campus && room.indexOf(campus) === -1) return campus + ' ' + room;
        if (room) return room;
        if (campus) return campus;
        return null;
    }

    function quotedNames(names) {
        var shown = names.length < 3 ? names.length : 3;
        var parts = [];
        for (var i = 0; i < shown; i++) parts.push('「' + clip(names[i]) + '」');
        var body = parts.join('、');
        if (names.length > shown) body += '，另有 ' + (names.length - shown) + ' 门';
        return body;
    }

    var startIso = isoOf(meta.startDate);
    var endIso = isoOf(meta.endDate);
    var firstDayOfWeek = intOf(meta.firstDayOfWeek);
    if (!(firstDayOfWeek >= 1 && firstDayOfWeek <= 7)) {
        firstDayOfWeek = meta.weekStartOnSunday === true ? 7 : 1;
    }

    var firstDayEstimated = false;
    var firstDay = null;
    if (startIso) firstDay = weekStartOf(startIso, firstDayOfWeek);
    if (!firstDay) {
        firstDay = todayWeekStart(firstDayOfWeek);
        firstDayEstimated = true;
    }

    var termName = text(term.label) || text(meta.nameZh) || text(meta.name);
    var nameEstimated = false;
    if (!termName) {
        var inferred = inferTermName(startIso) || inferTermName(firstDay);
        termName = inferred ? (SCHOOL + inferred) : (SCHOOL + '本学期');
        nameEstimated = true;
    }
    function termShown() {
        return nameEstimated ? termName : clip(termName);
    }

    if (!isArray(activities) || !activities.length) {
        throw new Error('教务没有返回任何排课记录。这个学期可能还没排课，请到课表页面核对后再提取。');
    }

    var order = [];
    var byCourse = {};
    var maxWeek = 0;
    var maxPeriodUsed = 0;
    var skip = { name: 0, day: 0, unit: 0, weeks: 0 };

    for (var i = 0; i < activities.length; i++) {
        var act = activities[i] || {};
        var name = text(act.courseName);
        if (!name) { skip.name++; continue; }
        var day = intOf(act.weekday);
        if (!(day >= 1 && day <= 7)) { skip.day++; continue; }
        var startPeriod = intOf(act.startUnit);
        var endPeriod = intOf(act.endUnit);
        if (!(startPeriod >= 1) || !(endPeriod >= startPeriod)) { skip.unit++; continue; }
        var hadWeekText = typeof act.weekIndexes === 'string' && text(act.weekIndexes);
        var weeks = weeksOf(act);
        if (!weeks.length) {
            if (!hadWeekText) skip.weeks++;
            continue;
        }
        var teacher = teachersOf(act);
        var location = locationOf(act);
        var courseKey = name + KEY_SEP + (teacher || '');
        if (!byCourse[courseKey]) {
            byCourse[courseKey] = { name: name, teacher: teacher, slots: {}, slotOrder: [] };
            order.push(courseKey);
        }
        var course = byCourse[courseKey];
        var slotKey = [day, startPeriod, endPeriod, location || ''].join('|');
        if (!course.slots[slotKey]) {
            course.slots[slotKey] = {
                day: day,
                startPeriod: startPeriod,
                endPeriod: endPeriod,
                location: location,
                weeks: []
            };
            course.slotOrder.push(slotKey);
        }
        var slotWeeks = course.slots[slotKey].weeks;
        for (var w = 0; w < weeks.length; w++) {
            if (slotWeeks.indexOf(weeks[w]) === -1) slotWeeks.push(weeks[w]);
        }
        if (endPeriod > maxPeriodUsed) maxPeriodUsed = endPeriod;
    }

    if (!order.length) {
        throw new Error('教务返回了 ' + activities.length + ' 条排课记录，但都缺少课程名、星期、节次或周次，读不出课程。请到课表页面核对。');
    }

    var courses = [];
    var missingTeachers = [];
    var missingRooms = [];
    for (var c = 0; c < order.length; c++) {
        var courseData = byCourse[order[c]];
        var blocks = [];
        var roomMissing = false;
        for (var s = 0; s < courseData.slotOrder.length; s++) {
            var slot = courseData.slots[courseData.slotOrder[s]];
            if (!slot.location) roomMissing = true;
            slot.weeks.sort(function (a, b) { return a - b; });
            var runs = runsOf(slot.weeks);
            for (var r = 0; r < runs.length; r++) {
                var run = runs[r];
                if (run.end > maxWeek) maxWeek = run.end;
                blocks.push({
                    dayOfWeek: slot.day,
                    startPeriod: slot.startPeriod,
                    endPeriod: slot.endPeriod,
                    startWeek: run.start,
                    endWeek: run.end,
                    weekType: run.weekType,
                    location: slot.location
                });
            }
        }
        if (!blocks.length) continue;
        blocks.sort(function (a, b) {
            if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
            if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
            if (a.endPeriod !== b.endPeriod) return a.endPeriod - b.endPeriod;
            return a.startWeek - b.startWeek;
        });
        if (!courseData.teacher && missingTeachers.indexOf(courseData.name) === -1) missingTeachers.push(courseData.name);
        if (roomMissing && missingRooms.indexOf(courseData.name) === -1) missingRooms.push(courseData.name);
        courses.push({
            name: courseData.name,
            teacher: courseData.teacher,
            note: null,
            blocks: blocks
        });
    }

    if (!courses.length) {
        throw new Error('排课记录里的上课周次都超出了可以导入的范围，没有读出课程。请到课表页面核对。');
    }

    var calendarWeeks = firstDayEstimated ? null : weeksBetween(firstDay, endIso);
    var hasCalendar = calendarWeeks >= 1 && calendarWeeks <= MAX_WEEKS;
    var totalWeeks = hasCalendar ? calendarWeeks : DEFAULT_TOTAL_WEEKS;
    var raised = maxWeek > totalWeeks;
    if (raised) totalWeeks = maxWeek;
    if (totalWeeks > MAX_WEEKS) totalWeeks = MAX_WEEKS;

    var periodTimes = [];
    var seenPeriods = {};
    for (var u = 0; u < courseUnitList.length; u++) {
        var unit = courseUnitList[u] || {};
        var periodIndex = intOf(unit.indexNo || unit.index || unit.periodIndex);
        var periodStart = fmtTime(unit.startTime || unit.start);
        var periodEnd = fmtTime(unit.endTime || unit.end);
        if (!(periodIndex >= 1) || !periodStart || !periodEnd) continue;
        if (minutesOf(periodStart) >= minutesOf(periodEnd)) continue;
        if (seenPeriods[periodIndex] === true) continue;
        seenPeriods[periodIndex] = true;
        periodTimes.push({ periodIndex: periodIndex, start: periodStart, end: periodEnd });
    }
    periodTimes.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    var byIndex = {};
    var publishedMax = 0;
    var ui;
    for (ui = 0; ui < periodTimes.length; ui++) {
        byIndex[periodTimes[ui].periodIndex] = periodTimes[ui];
        if (periodTimes[ui].periodIndex > publishedMax) publishedMax = periodTimes[ui].periodIndex;
    }
    var needMax = publishedMax > maxPeriodUsed ? publishedMax : maxPeriodUsed;
    var gapFilled = [];
    var tailFilled = [];
    var uncoveredFrom = 0;
    var synthesizedAll = false;
    var backwardFailed = false;
    var dp;
    var prevSlot;
    var nextStartMin;
    var nextEndMin;
    if (needMax >= 1 && (byIndex[1] || publishedMax === 0)) {
        var dense = [];
        if (publishedMax === 0) synthesizedAll = true;
        for (dp = 1; dp <= needMax; dp++) {
            if (byIndex[dp]) {
                dense.push(byIndex[dp]);
                continue;
            }
            prevSlot = dense.length ? dense[dense.length - 1] : null;
            nextStartMin = prevSlot ? (minutesOf(prevSlot.end) + EXTEND_BREAK_MINUTES) : (8 * 60);
            nextEndMin = nextStartMin + EXTEND_CLASS_MINUTES;
            if (nextEndMin > 23 * 60 + 59) {
                uncoveredFrom = dp;
                break;
            }
            dense.push({
                periodIndex: dp,
                start: hhmmOf(nextStartMin),
                end: hhmmOf(nextEndMin)
            });
            if (!synthesizedAll && dp <= publishedMax) gapFilled.push(dp);
            else if (!synthesizedAll) tailFilled.push(dp);
        }
        periodTimes = dense;
    } else if (needMax >= 1) {
        var firstKnown = publishedMax;
        var fk;
        for (fk = 1; fk <= publishedMax; fk++) {
            if (byIndex[fk]) { firstKnown = fk; break; }
        }
        var backward = [];
        var cursorStart = minutesOf(byIndex[firstKnown].start);
        var bp;
        var backEnd;
        var backStart;
        for (bp = firstKnown - 1; bp >= 1; bp--) {
            backEnd = cursorStart - EXTEND_BREAK_MINUTES;
            backStart = backEnd - EXTEND_CLASS_MINUTES;
            if (backStart < 0) { backwardFailed = true; break; }
            backward.unshift({
                periodIndex: bp,
                start: hhmmOf(backStart),
                end: hhmmOf(backEnd)
            });
            cursorStart = backStart;
        }
        if (!backwardFailed) {
            var denseBack = backward;
            var fp;
            for (fp = 1; fp < firstKnown; fp++) gapFilled.push(fp);
            for (fp = firstKnown; fp <= needMax; fp++) {
                if (byIndex[fp]) {
                    denseBack.push(byIndex[fp]);
                    continue;
                }
                prevSlot = denseBack[denseBack.length - 1];
                nextStartMin = minutesOf(prevSlot.end) + EXTEND_BREAK_MINUTES;
                nextEndMin = nextStartMin + EXTEND_CLASS_MINUTES;
                if (nextEndMin > 23 * 60 + 59) { uncoveredFrom = fp; break; }
                denseBack.push({ periodIndex: fp, start: hhmmOf(nextStartMin), end: hhmmOf(nextEndMin) });
                if (fp <= publishedMax) gapFilled.push(fp);
                else tailFilled.push(fp);
            }
            periodTimes = denseBack;
        }
    }

    if (term.pickedBy === 'first') {
        pushWarn('教务页面没有标出当前学期，已导入列表里的第一个「' + termShown() +
            '」。如果不对，请在教务页面切到要导入的学期后再提取。');
    }
    var otherTerms = 0;
    for (var si = 0; si < semesters.length; si++) {
        if (String(semesters[si].id) !== String(term.id)) otherTerms++;
    }
    if (otherTerms > 0) {
        pushWarn('本次只导入了「' + termShown() + '」。学期列表里还有 ' + otherTerms +
            ' 个学期，要导入别的学期请在教务页面切过去再点「提取课表」。');
    }
    if (firstDayEstimated) {
        pushWarn('开学日期教务系统没有给出，已按最近的周' + DAY_NAMES[firstDayOfWeek] +
            '推算为 ' + firstDay + '。它决定现在是第几周，请在学期管理里核对。');
    }
    var skippedTotal = skip.name + skip.day + skip.unit + skip.weeks;
    if (skippedTotal > 0) {
        var reasons = [];
        if (skip.name) reasons.push('缺课程名 ' + skip.name + ' 条');
        if (skip.day) reasons.push('缺星期 ' + skip.day + ' 条');
        if (skip.unit) reasons.push('缺节次 ' + skip.unit + ' 条');
        if (skip.weeks) reasons.push('缺周次 ' + skip.weeks + ' 条');
        pushWarn('有 ' + skippedTotal + ' 条排课记录读不了，已跳过（' + reasons.join('、') +
            '）。如发现少了课，请到课表页面核对。');
    }
    if (badWeekValues > 0) {
        pushWarn('有 ' + badWeekValues + ' 个周次不是有效的上课周，已忽略。如发现某门课周次不对，请到课表页面核对。');
    }
    if (unparsedWeeks > 0) {
        pushWarn('有 ' + unparsedWeeks + ' 条排课的周次认不出来（例如「' + clip(unparsedSample) +
            '」），这些安排没导入，请到课表页面核对。');
    }
    if (bothMarks > 0) {
        pushWarn('有 ' + bothMarks + ' 处周次同时写了单周和双周，已按每周都上处理，请到课表页面核对。');
    }
    if (noteGroups > 0) {
        pushWarn('周次里有 ' + noteGroups + ' 处备注（例如「' + clip(noteSample) +
            '」）已略过，不影响上课周次。如发现周次不对，请到课表页面核对。');
    }
    if (droppedWeeks > 0) {
        pushWarn('有 ' + droppedWeeks + ' 个上课周次超出 1 到 ' + MAX_WEEKS + ' 周，已跳过。');
    }
    if (orphanMarkers > 0) {
        pushWarn('有 ' + orphanMarkers + ' 处单双周标记旁边没有周次，已忽略。如发现周次不对，请到课表页面核对。');
    }
    if (!hasCalendar && !raised) {
        pushWarn('教务系统没有给出可用的学期校历，学期总周数按 20 周导入（课表最晚排到第 ' + maxWeek +
            ' 周）。如与学校安排不符，请在学期管理里改。');
    }
    if (!hasCalendar && raised) {
        pushWarn('教务系统没有给出可用的学期校历，原本按 20 周导入，但课表排到第 ' + maxWeek +
            ' 周，学期总周数已改为 ' + totalWeeks + ' 周，请在学期管理里核对。');
    }
    if (hasCalendar && raised) {
        pushWarn('教务系统给出的学期起止只能数出 ' + calendarWeeks + ' 周，但课表排到第 ' + maxWeek +
            ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对。');
    }
    if (missingTeachers.length) {
        pushWarn('有 ' + missingTeachers.length + ' 门课没有教师（例如' + quotedNames(missingTeachers) +
            '），可在这门课的「编辑课程」里补上。');
    }
    if (missingRooms.length) {
        pushWarn('有 ' + missingRooms.length + ' 门课没有教室（例如' + quotedNames(missingRooms) +
            '），可在这门课的「编辑课程」里补上。');
    }
    if (synthesizedAll && periodTimes.length) {
        pushWarn('教务系统没有给出节次时间，已从第 1 节 ' + periodTimes[0].start +
            ' 起按课间 5 分钟、每节 45 分钟补到第 ' + periodTimes[periodTimes.length - 1].periodIndex +
            ' 节，请在学期管理里核对。');
    }
    if (gapFilled.length) {
        pushWarn('教务的节次时间缺了' + sectionsOf(gapFilled) +
            '，缺的这几节已按上一节下课后课间 5 分钟、每节 45 分钟补上，其余节次用的是教务给出的时间，请在学期管理里核对。');
    }
    if (tailFilled.length) {
        pushWarn('课表用到了' + sectionsOf(tailFilled) +
            '，学校公布的节次时间没有覆盖，已补上：' + sectionsOf(tailFilled) +
            '按上一节下课后课间 5 分钟、每节 45 分钟顺推，请在学期管理里核对。');
    }
    if (uncoveredFrom) {
        pushWarn('课表用到了第 ' + uncoveredFrom +
            ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上。');
    }
    if (backwardFailed) {
        pushWarn('教务的节次时间不是从第 1 节开始，按课间往前补会早于 0 点，前面的空节没有补，更高的节次在课表上可能对不齐，请在学期管理里核对。');
    }
    if (nameEstimated) {
        pushWarn('教务系统没有给出学期名称，已写成「' + termName + '」，可以在学期管理里改成你想要的名字。');
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
