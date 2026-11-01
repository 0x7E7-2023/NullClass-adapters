(function () {
    // 北京师范大学珠海校区教务适配器（青果 KINGOSOFT）—— 第二步：纯函数，把 extract.js 交出的课程行解析成课表载荷。
    //
    // 移植自 shiguang_warehouse 的 BNUZH/school.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Sue Yin，维护者 sbVAN）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4（2026-11-01）
    //   本校脚本最后一次修改 03aa24c
    //
    // 模板是已审计的青果件 nynu（南阳师范学院）。取数层不同构（本校是列表课表加开学日、节次时间，不是 weekly 块），
    // 周次解析、提醒限长、缺教师 / 缺教室汇总、连堂合并、补节次沿用 nynu，并保留无逗号前置单双标记的归属。
    //
    // 交来的数据：
    //   { term: { xn, xq, source, name }, today, hasTable, rows: [ { name, teacher, time } ], badRows, dates: [ 'MM-DD' ], slots: [ { n, start, end } ] }
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」）：
    //   1. 上课时间原文形如「1-16周 三[7-8] 丽泽楼C202(140)」，可多段用逗号分开。星期和节次从「日[节]」读取，周次交给 weeksOf
    //   2. 周次文字沿用 nynu 的 weeksOf（含无逗号前置单双、后置单双、第1-第8周、共 N 周只剥备注）
    //   3. 教师 / 教室拿不到，或写了「未知」「待定」「暂无」，就是空。地点末尾的人数括号去掉
    //   4. 节次时间优先用教务公布的；没有或不是从第 1 节连续排下来，就用学校公布的 12 节（与上游兜底逐节一致）。超出的按统一修订 H3 顺推
    //   5. 开学日优先用第 1 周周课表里的周一；读不到或不是合理的周一时按学期推算，并提醒
    //   6. 总周数先按 20。只有课表最大周比 20 更晚才抬高。不把最大周当成学期长度
    //   7. 合并：先去掉完全相同的行，再把同一门课节次首尾相接或重叠（下一节起点不晚于上一节终点加 1）的合成一块，最后周次取并集
    //   8. 带进提醒的教务原文先截到 20 字，每条提醒不超过 200 字。自己生成的学期名不截

    var SCHOOL_NAME = '北京师范大学珠海校区';
    var SCHOOL_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;
    var MAX_PERIOD = 20;
    var NAME_TEXT_LIMIT = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_WARNINGS = 20;
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;

    // 教务没公布节次时间时的 12 节，逐节照抄上游 FALLBACK_TIME_SLOTS（2026-2027 学年秋季学期）
    var FALLBACK_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '13:30', end: '14:15' },
        { periodIndex: 6, start: '14:25', end: '15:10' },
        { periodIndex: 7, start: '15:30', end: '16:15' },
        { periodIndex: 8, start: '16:25', end: '17:10' },
        { periodIndex: 9, start: '18:00', end: '18:45' },
        { periodIndex: 10, start: '18:55', end: '19:40' },
        { periodIndex: 11, start: '19:50', end: '20:35' },
        { periodIndex: 12, start: '20:45', end: '21:30' }
    ];

    var DAY_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    var KIND_CN = { first: '一', second: '二' };
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' }
    };
    var KIND_WINDOW = {
        first: { fromMonth: 7, toMonth: 10, yearShift: 0 },
        second: { fromMonth: 1, toMonth: 4, yearShift: 1 }
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
    var dateTexts = Array.isArray(data.dates) ? data.dates : [];
    var rawSlots = Array.isArray(data.slots) ? data.slots : [];

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

    var termYear = /^[0-9]{4}$/.test(text(term.xn)) ? parseInt(text(term.xn), 10) : 0;
    var termMatch = termYear > 0 && /^[01]$/.test(text(term.xq));
    var termKind = termMatch && text(term.xq) === '1' ? 'second' : 'first';

    function termName() {
        var given = text(term.name);
        if (given) return given.length > 40 ? given.substring(0, 40) : given;
        if (!termMatch) return SCHOOL_NAME + ' 当前学期';
        return termYear + '-' + (termYear + 1) + '学年第' + KIND_CN[termKind] + '学期';
    }

    // 教务给的学期名进提醒时截到 20 字；自己生成的学期名不截
    function warnTermName() {
        if (text(term.name)) return shortName(term.name);
        return termName();
    }

    function startFromSchool() {
        if (!termMatch || !dateTexts.length) return null;
        var year = termYear + KIND_WINDOW[termKind].yearShift;
        for (var i = 0; i < dateTexts.length; i++) {
            var m = /^([0-9]{2})-([0-9]{2})$/.exec(text(dateTexts[i]));
            if (!m) continue;
            var month = parseInt(m[1], 10);
            var day = parseInt(m[2], 10);
            var date = new Date(Date.UTC(year, month - 1, day));
            if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
            if (date.getUTCDay() !== 1) continue;
            var win = KIND_WINDOW[termKind];
            if (month < win.fromMonth || month > win.toMonth) return { bad: year + '-' + m[1] + '-' + m[2] };
            return { iso: isoOf(date) };
        }
        return { bad: shortName(dateTexts[0]) };
    }

    function estimateStart() {
        if (!termMatch) return null;
        var anchor = KIND_ANCHOR[termKind];
        return {
            iso: isoOf(mondayOnOrBefore(termYear + KIND_WINDOW[termKind].yearShift, anchor.month, anchor.day)),
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
        // 「周」换成逗号再切段。直接删掉会把「1-4周5-8周」粘成「1-45」
        cleaned = cleaned.replace(/周/g, ',');
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

    function cleanLocation(value) {
        var line = text(value).replace(/\([0-9]+\)$/, '').replace(/（[0-9]+）$/, '');
        return blankToNull(line);
    }

    function blocksOfTime(timeText) {
        var source = text(timeText);
        var pieces = source.split(/[,，]/);
        var blocks = [];
        var pending = '';
        var failed = 0;
        for (var i = 0; i < pieces.length; i++) {
            var piece = text(pending ? pending + ',' + pieces[i] : pieces[i]);
            pending = '';
            if (!piece) { failed++; continue; }
            var anchor = /([一二三四五六日天])\s*[\[［]\s*([0-9]{1,2})(?:\s*[-—~～－–至到]\s*([0-9]{1,2}))?\s*[\]］]/.exec(piece);
            if (!anchor) {
                pending = piece;
                continue;
            }
            var day = DAY_MAP[anchor[1]];
            var start = parseInt(anchor[2], 10);
            var end = anchor[3] ? parseInt(anchor[3], 10) : start;
            if (end < start) { var swap = start; start = end; end = swap; }
            blocks.push({
                day: day,
                start: start,
                end: end,
                weekSrc: text(piece.substring(0, anchor.index)),
                location: text(piece.substring(anchor.index + anchor[0].length))
            });
        }
        if (pending) failed++;
        return { blocks: blocks, failed: failed };
    }

    function clockOk(value) {
        return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(text(value));
    }

    // 教务给了节次时间就用教务的。中间缺了几节只补那几节，不把整张表换成写死的 12 节。
    // 第 1 节都没有，或某一行时刻不合法，才整张不用。
    function schoolSlots(list) {
        if (!list || !list.length) return null;
        var map = {};
        var max = 0;
        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            var n = parseInt(item.n, 10);
            if (!n || n < 1 || n > MAX_PERIOD || !clockOk(item.start) || !clockOk(item.end)) return null;
            if (minutesOf(text(item.start)) >= minutesOf(text(item.end))) return null;
            map[n] = { periodIndex: n, start: text(item.start), end: text(item.end) };
            if (n > max) max = n;
        }
        if (!map[1]) return null;
        var out = [];
        var gaps = [];
        for (var p = 1; p <= max; p++) {
            if (map[p]) {
                out.push(map[p]);
                continue;
            }
            var prev = out[out.length - 1];
            var nextStart = minutesOf(prev.end) + EXTEND_BREAK_MINUTES;
            var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
            if (nextEnd > 23 * 60 + 59) return null;
            out.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
            gaps.push(p);
        }
        return { times: out, gaps: gaps };
    }

    var courses = [];
    var byName = {};
    var entries = [];
    var unreadable = { time: 0 };
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

    function noteUnreadable(original) {
        unreadable.time++;
        var sample = shortName(original);
        if (unreadableSamples.length < 3 && unreadableSamples.indexOf(sample) < 0) unreadableSamples.push(sample);
    }

    function noteMissing(dict, name) {
        dict[name] = true;
        missingAnyCourses[name] = true;
        if (fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) fieldSamples.push(name);
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var name = text(row.name);
        var timeText = text(row.time);
        if (!name) {
            noteUnreadable(timeText || '未命名');
            continue;
        }
        var parsed = blocksOfTime(timeText);
        if (!parsed.blocks.length) {
            noteUnreadable(timeText || name);
            continue;
        }
        var teacher = blankToNull(text(row.teacher).replace(/[;；]/g, '、'));
        var pushed = 0;
        for (var bi = 0; bi < parsed.blocks.length; bi++) {
            var block = parsed.blocks[bi];
            if (!block.day || block.start < 1 || block.end > MAX_PERIOD) {
                noteUnreadable(timeText);
                continue;
            }
            var weeks = weeksOf(block.weekSrc);
            if (!weeks.length) {
                noteUnreadable(timeText);
                continue;
            }
            var location = cleanLocation(block.location);
            if (!teacher) noteMissing(missingTeacherCourses, name);
            if (!location) noteMissing(missingLocationCourses, name);
            entries.push({
                name: name,
                teacher: teacher,
                location: location,
                day: block.day,
                start: block.start,
                end: block.end,
                weeks: weeks,
                course: courseOf(name, teacher)
            });
            pushed++;
        }
        if (!pushed || parsed.failed) noteUnreadable(timeText || name);
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
        var weekRuns = runsOf(item.weeks);
        for (var k = 0; k < weekRuns.length; k++) {
            var run = weekRuns[k];
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
    var shownName = warnTermName();
    if (!data.hasTable && !rows.length) {
        throw new Error(
            '教务系统返回了内容，但没有一门课能读成课程（课表页面的格式可能改过）：' +
            '请把这个问题反馈给我们，并附上教务系统里课表页的截图'
        );
    }
    if (!rows.length) {
        throw new Error(
            '这个学期（' + name0 + '）在教务系统里还没有课；如果要导入别的学期，' +
            '请在教务页面里切换学期后再点「提取课表」'
        );
    }
    if (!courses.length) {
        throw new Error(
            '教务系统返回了课表，但没有一门课能读成课程（课表页面的格式可能改过）：' +
            '请把这个问题反馈给我们，并附上教务系统里课表页的截图'
        );
    }

    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        if (!courses[c].blocks.length) continue;
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: null,
            blocks: courses[c].blocks
        });
    }
    if (!payloadCourses.length) {
        throw new Error(
            '教务系统返回了课表，但没有一门课能读成课程（课表页面的格式可能改过）：' +
            '请把这个问题反馈给我们，并附上教务系统里课表页的截图'
        );
    }

    var fromSchool = startFromSchool();
    var estimated = estimateStart();
    var firstDay = (fromSchool && fromSchool.iso) ? fromSchool.iso : (estimated ? estimated.iso : '2026-09-07');

    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    var usedFallback = false;
    var gapPeriods = [];
    var builtSlots = schoolSlots(rawSlots);
    var periodTimes;
    if (!builtSlots) {
        periodTimes = FALLBACK_PERIOD_TIMES.slice(0);
        usedFallback = true;
    } else {
        periodTimes = builtSlots.times;
        gapPeriods = builtSlots.gaps;
    }
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

    var source = text(term.source);
    if (source === 'page') {
        warn(
            '只导入了教务页面上当前选中的学期（' + shownName +
            '）；要导入别的学期，请先在教务系统里切到那个学期再点「提取课表」'
        );
    } else if (source === 'current') {
        warn(
            '已按教务系统给出的当前学期导入（' + shownName +
            '）；要导入别的学期，请先在教务系统里切到那个学期再点「提取课表」'
        );
    } else if (source === 'list-first') {
        warn(
            '没能从教务页面读到当前学期，今天的日期对应的学期也不在学期列表里，已导入列表里的第一个学期「' + shownName +
            '」；如果不是你要的学期，请在教务系统里切到那个学期再点「提取课表」'
        );
    } else {
        warn(
            '没能从教务页面读到当前学期，已按今天的日期判断为「' + shownName +
            '」；如果不是你要的学期，请在教务系统里切到那个学期再点「提取课表」'
        );
    }

    if (fromSchool && fromSchool.iso) {
        warn(
            '第 1 周的开始日期（' + firstDay + '）是从教务系统第 1 周的周课表里读出来的，' +
            '没法向你确认，请在学期管理里核对是不是学校实际的开学日'
        );
    } else if (fromSchool && fromSchool.bad) {
        warn(
            '教务系统周课表里读到的开学日期（' + fromSchool.bad + '）不是周一或不在合理的月份里，已不采用；第 1 周按「' +
            estimated.rule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日'
        );
    } else if (estimated) {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + estimated.rule +
            '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日'
        );
    }

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

    if (usedFallback) {
        var last = FALLBACK_PERIOD_TIMES[FALLBACK_PERIOD_TIMES.length - 1];
        warn(
            '没能从教务系统读到节次时间，已按学校公布的节次时间导入（第 1 节 ' + FALLBACK_PERIOD_TIMES[0].start +
            '-' + FALLBACK_PERIOD_TIMES[0].end + '，第 ' + FALLBACK_PERIOD_TIMES.length + ' 节 ' +
            last.start + '-' + last.end + '），请在「学期管理」里核对'
        );
    }
    if (gapPeriods.length) {
        warn(
            '教务的节次时间缺了' + sectionsText(gapPeriods) +
            '，缺的这几节已按上一节下课后课间 5 分钟、每节 45 分钟补上，其余节次用的是教务给出的时间，请在「学期管理」里核对'
        );
    }
    if (bySequence.length) {
        warn(
            '课表用到了' + sectionsText(bySequence) + '，学校公布的节次时间没有覆盖，已补上：' +
            sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推，请在「学期管理」里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    if (unreadable.time > 0) {
        var sampleTexts = [];
        for (var us = 0; us < unreadableSamples.length; us++) sampleTexts.push('「' + unreadableSamples[us] + '」');
        warn(
            '有 ' + unreadable.time + ' 条课程内容没能读成课程（上课时间认不出），已跳过，例如 ' +
            sampleTexts.join('') + '：如发现少课请反馈'
        );
    }
    var badRows = parseInt(data.badRows, 10);
    if (badRows > 0) {
        warn('有 ' + badRows + ' 行课表认不出课程（排版和预期不一样），这些行已跳过：如发现少课请反馈');
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
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
