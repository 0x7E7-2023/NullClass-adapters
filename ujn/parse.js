(function () {
    // 济南大学教务适配器（正方教务 jwglxt 课表页 DOM）—— 第二步：原始数据转课表。
    //
    // 移植自 shiguang_warehouse 的 UJN/school.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT，作者 Moyu）
    //   上游快照 baf83fa；本校脚本最后一次修改 1fe584c。
    //
    // 移植改动：
    //   ① 纯函数、ES5；不访问页面、不联网，可在 Rhino 里回归。
    //   ② 星期与节次由上游的格子几何换算而来：节次取行号，星期取列号加半格错位修正；
    //      上游在错位函数只认两种行号、其余行会算出空值，这里按同一张表的另一半回退并提醒。
    //   ③ 周次先剥掉「(1-2节)」这类节次括号，再按多段、前后置单双、无逗号前置单双、
    //      「共 N 周」备注解析；认不出的写法不猜数字，整行跳过并汇总提醒。
    //   ④ 缺教师或教室不再丢课；「未知」「待定」「暂无」等占位文字写为空并汇总提醒；
    //      教师后面括号里的「外聘」「研究生」等备注不是第二个教师，剥掉。
    //   ⑤ 上游写死的 11 节节次时间逐节保留；表外节次按 H3 逐节顺推，跨出当天则说明。
    //   ⑥ 上游没有开学日与校历：总周数用 20，课表更晚才抬高；开学日按学期锚点推算并提醒。
    //   ⑦ 完全重复的格子先去掉，再解析、再计数；相邻或重叠节次吸收，同节次取周次并集。
    //   ⑧ 学期名取教务页面上的学年学期；所有提醒统一限长，教务原文先截到 20 字。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var page = text(data.page);
    var cells = Array.isArray(data.cells) ? data.cells : [];

    var MAX_WEEK = 30;
    var MAX_PERIOD = 20;
    var SCHOOL_NAME = '济南大学';
    var SCHOOL_TOTAL_WEEKS = 20;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;

    // 上游 UJN/school.js 的 11 节节次时间，逐节照抄（第 11 节上游就是 55 分钟）。
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:50' },
        { periodIndex: 2, start: '08:55', end: '09:45' },
        { periodIndex: 3, start: '10:15', end: '11:05' },
        { periodIndex: 4, start: '11:10', end: '12:00' },
        { periodIndex: 5, start: '14:00', end: '14:50' },
        { periodIndex: 6, start: '14:55', end: '15:45' },
        { periodIndex: 7, start: '16:15', end: '17:05' },
        { periodIndex: 8, start: '17:10', end: '18:00' },
        { periodIndex: 9, start: '19:00', end: '19:50' },
        { periodIndex: 10, start: '19:55', end: '20:45' },
        { periodIndex: 11, start: '20:50', end: '21:45' }
    ];

    var KIND_CN = { first: '一', second: '二', third: '三' };
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '夏季学期 = 7 月 1 日所在周的周一' }
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function shortName(value) {
        var line = text(value);
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
        var match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
        if (!match) return null;
        var month = parseInt(match[2], 10);
        var day = parseInt(match[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return match[1] + '-' + pad2(month) + '-' + pad2(day);
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

    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    function termKind() {
        var label = text(term.xqmText);
        if (label.indexOf('二') >= 0) return 'second';
        if (label.indexOf('三') >= 0) return 'third';
        if (label.indexOf('一') >= 0) return 'first';
        var code = text(term.xqm);
        if (code === '12' || code === '2') return 'second';
        if (code === '16') return 'third';
        return 'first';
    }

    function termYear() {
        return /^[0-9]{4}$/.test(text(term.xnm)) ? parseInt(text(term.xnm), 10) : 0;
    }

    function yearLabel() {
        var label = text(term.xnmText);
        if (/^[0-9]{4}-[0-9]{2,4}$/.test(label)) return label;
        var year = termYear();
        if (year) return year + '-' + (year + 1);
        return label;
    }

    var termNameKnown = true;

    function termName() {
        var explicit = text(term.name);
        if (explicit) return explicit;
        var whole = text(term.xqmText);
        if (whole && whole.indexOf('学年') >= 0 && whole.indexOf('学期') >= 0) return whole;
        var label = yearLabel();
        if (!termYear() && !/^[0-9]{4}-[0-9]{2,4}$/.test(label)) {
            termNameKnown = false;
            return SCHOOL_NAME + ' 课表';
        }
        return label + '学年' + '第' + KIND_CN[termKind()] + '学期';
    }

    function estimateStart(todayIso) {
        var kind = termKind();
        var year = termYear();
        if (!year) return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天的周一' };
        return {
            iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), KIND_ANCHOR[kind].month, KIND_ANCHOR[kind].day)),
            rule: KIND_ANCHOR[kind].rule
        };
    }

    var droppedWeeks = 0;
    var orphanMarkers = 0;
    var serialGroups = 0;
    var noteGroups = 0;
    var noteSample = '';
    var bothMarks = 0;

    function fullWidthToHalf(source) {
        return source.replace(/[０-９]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
        }).replace(/（/g, '(').replace(/）/g, ')')
            .replace(/[，、；;]/g, ',').replace(/[～~—－–至]/g, '-');
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 正方在周次同一行里还写节次，如「1-16周(1-2节)」：先整段剥掉，别当成周次备注
        cleaned = cleaned.replace(/[\(\[【][^\(\)\[\]【】]*节[^\(\)\[\]【】]*[\)\]】]/g, ' ');
        // 「共 N 周」只剥备注本身；放在全角转半角之后，全角数字才一起剥掉
        cleaned = cleaned.replace(/第\s*(?=[0-9])/g, '').replace(/共\s*[0-9]+\s*周?/g, '');
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
        cleaned = cleaned.replace(/[()]/g, ',').replace(/周/g, '');
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
            if (!/^[0-9单双\s-]+$/.test(segment)) continue;
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

    // 上游 offsetColByRow：行号减 2 后除 4 余 0 的格子前面多一个「上午 / 下午 / 晚上」标签，
    // 余 2 的没有。余 1 与余 3 的行上游没有给值（会算出空星期），这里按没有标签处理成 1，
    // 并计数提醒 —— 这两种行只在教务把课排在偶数节开始时出现。
    // 计数按「门课」（课名 + 教师）去重：同一门课可能占好几个格子。
    var inferredCourses = {};

    function geometryOf(cell) {
        var row = intOf(cell.row);
        var col = intOf(cell.col);
        if (row === null || col === null) return null;
        var rowSpan = intOf(cell.rowSpan);
        if (!(rowSpan >= 1)) rowSpan = 1;
        var start = row - 1;
        var end = row + rowSpan - 2;
        if (start < 1 || start > MAX_PERIOD || end < start) return null;
        var base = (row - 2) % 4;
        var offset;
        var guessed = false;
        if (base === 0) {
            offset = 0;
        } else if (base === 2) {
            offset = 1;
        } else {
            offset = 1;
            guessed = true;
        }
        var day = col - 1 + offset;
        if (day < 1 || day > 7) return null;
        return { day: day, start: start, end: end > MAX_PERIOD ? MAX_PERIOD : end, guessed: guessed };
    }

    var courses = [];
    var byName = {};

    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + (teacher || '');
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, note: null, blocks: [] };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    function cmpText(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
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

    var PLACEHOLDERS = { '未知': true, '待定': true, '暂无': true, '暂无教师': true, '暂无教室': true, '无': true, '空': true };

    function blankField(value) {
        var line = text(value);
        if (PLACEHOLDERS[line]) return '';
        return line;
    }

    // 教师后面括号里的「外聘」「研究生」「主讲」是备注，不是第二位教师。
    function teacherOf(value) {
        var line = blankField(value);
        if (!line) return '';
        var cut = line.search(/[（(]/);
        if (cut > 0) return text(line.substring(0, cut));
        return line;
    }

    function cleanName(value) {
        return text(value).replace(/[■☆★◆]/g, '').trim();
    }

    function dropDuplicateCells(list) {
        var ledger = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var cell = list[i] || {};
            var key = 'k' + JSON.stringify([cell.name, cell.weeks, cell.location, cell.teacher,
                cell.row, cell.col, cell.rowSpan, cell.colSpan]);
            if (ledger[key]) continue;
            ledger[key] = true;
            out.push(cell);
        }
        return out;
    }

    var entries = [];
    var missing = { name: 0, place: 0, week: 0 };
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var weekSamples = [];
    var defaultCourses = {};
    var defaultSamples = [];
    var maxWeek = 0;
    var maxPeriod = 0;

    var parseCells = dropDuplicateCells(cells);
    for (var r = 0; r < parseCells.length; r++) {
        var cell = parseCells[r];
        var name = cleanName(cell.name);
        if (!name) { missing.name++; continue; }
        var geometry = geometryOf(cell);
        if (!geometry) { missing.place++; continue; }
        var teacher = teacherOf(cell.teacher);
        var location = blankField(cell.location);
        var weeks = weeksOf(cell.weeks);
        if (!weeks.length) {
            if (!text(cell.weeks) && page === 'class') {
                // 上游：班级课表里只有一个 p 的格子不写周次，按 1-20 周全上
                for (var w = 1; w <= SCHOOL_TOTAL_WEEKS; w++) weeks.push(w);
                var dkey = 'k' + name + '|' + teacher;
                if (!defaultCourses[dkey]) {
                    defaultCourses[dkey] = true;
                    if (defaultSamples.length < 3) defaultSamples.push(name);
                }
            } else {
                missing.week++;
                var sample = text(cell.weeks);
                if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
                continue;
            }
        }
        if (geometry.guessed) inferredCourses['k' + name + '|' + teacher] = true;
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) fieldSamples.push(name);
        entries.push({
            course: courseOf(name, teacher || null),
            name: name,
            teacher: teacher,
            location: location,
            day: geometry.day,
            start: geometry.start,
            end: geometry.end,
            weeks: weeks
        });
    }

    entries.sort(orderStageOne);
    var merged = mergeStageOne(entries);
    merged.sort(orderStageTwo);
    merged = mergeStageTwo(merged);

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

    if (!courses.length) {
        throw new Error('这个页面里没有读到课程：请先在教务系统里选好学年和学期、点「查询」，看到课表后再点「提取课表」');
    }

    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: courses[c].note,
            blocks: courses[c].blocks
        });
    }

    var name0 = termName();
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var start = estimateStart(todayIso);
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var mm = total % 60;
        return pad2(h) + ':' + pad2(mm);
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

    var periodTimes = SCHOOL_PERIOD_TIMES.slice(0);
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

    warn('只导入了教务系统当前选中的学期（' + shortName(name0) + '）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」');
    if (!termNameKnown) {
        warn('没读到教务系统的学年学期，学期名暂用「' + SCHOOL_NAME + ' 课表」，请在学期管理里改成实际学期');
    }
    warn('教务课表页没有给出开学日期，第 1 周按「' + start.rule + '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日');
    if (raisedBySchedule) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
    } else {
        warn('教务系统没有给出学期校历，学期总周数按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    }

    warn('教务课表页没有给出节次时间，已按学校公布的 ' + SCHOOL_PERIOD_TIMES.length + ' 节节次时间导入（第 1 节 ' + SCHOOL_PERIOD_TIMES[0].start + '-' + SCHOOL_PERIOD_TIMES[0].end + '），请在学期管理里核对');
    if (bySequence.length) {
        warn('课表用到了' + sectionsText(bySequence) + '，现有的节次时间没有覆盖，已补上：' + sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }
    var defaultedCourses = countKeys(defaultCourses);
    if (defaultedCourses > 0) {
        var shownDefault = [];
        for (var d = 0; d < defaultSamples.length; d++) shownDefault.push(shortName(defaultSamples[d]));
        warn('有 ' + defaultedCourses + ' 门课教务没写周次（如「' + shownDefault.join('、') + '」），已按第 1-' +
            SCHOOL_TOTAL_WEEKS + ' 周导入，请核对这几门课的上课周次');
    }

    var skipped = missing.name + missing.place + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.place) reasons.push('格子位置算不出星期或节次 ' + missing.place + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (weekSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push(shortName(weekSamples[ws]));
            reasons.push('认不出的周次写法如「' + sampleTexts.join('」「') + '」');
        }
        warn('有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') + '），已跳过：教务数据不完整时会出现，如发现少课请反馈');
    }

    var inferredCourseCount = countKeys(inferredCourses);
    if (inferredCourseCount > 0) {
        warn('有 ' + inferredCourseCount + ' 门课的星期是按课表格子的位置推算出来的，请核对这几门课的上课星期');
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownFieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownFieldNames.push(shortName(fieldSamples[fs]));
        var emptyText = missingTeacher > 0 && missingLocation > 0 ? '教师或地点暂时空着' : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shownFieldNames.join('、') + '）：已照常导入，' + emptyText + '，可在「编辑课程」里补上');
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，已忽略，请核对这几门课的周次');
    }
    if (droppedWeeks > 0) warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    if (orphanMarkers > 0) warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次（教务数据写得不完整），这些标记已忽略');
    if (bothMarks > 0) warn('有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对');
    if (droppedWarnings > 0) warnings[MAX_WARNINGS - 1] = '另有 ' + (droppedWarnings + 1) + ' 条核对提示超出上限未显示';

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [{
            name: name0,
            firstDay: start.iso,
            totalWeeks: totalWeeks,
            periodTimes: periodTimes,
            courses: payloadCourses
        }]
    });
})()
