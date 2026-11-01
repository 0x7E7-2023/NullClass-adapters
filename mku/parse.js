(function () {
    // 闽南科技学院（强智新版 layui）课表解析。
    // 移植自 shiguang_warehouse 的 MKU/mku.js（MIT，上游 adapters.yaml 的 maintainer 为 Mutx163）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 03d161a；本校脚本 80e30cf。
    // 周次切段、提醒汇总、载荷形状照已审计的 zsc（weeksIn）；课表字段按 MKU 上游的「老师 / 时间 / 地点」原文，不读旧版 font 标签。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 无逗号前置「(单)1-8周(双)9-16周」后一个标记归下一段；后置「1-8周(单)9-16周(双)」仍各跟各的；
    //   ② 「共 N 周」只剥备注；「第1-第8周」按一段；方括号里的单双标记要留下；
    //   ③ 节次优先用时间原文里的方括号，没有才用行首大节标题；
    //   ④ 节次时间优先按课表大节时间拆成每节 45 分钟、课间 10 分钟，对不上就用学校公布的 12 节；超出的补占位并提醒；
    //   ⑤ 总周数优先用周次接口的结束周；没有就按 20 周；课表比这更晚才抬高并提醒；
    //   ⑥ 开学日只在首页抬头的学期与要导入的学期一致时，按「第 N 周」从提取日回推；否则按最近的周一并提醒；
    //   ⑦ 教师、教室是「未知」「待定」「暂无」时留空，按类型汇总，到「编辑课程」里改，不写「学期管理」；
    //   ⑧ 拼进提醒的教务原文先截到 20 字，整条不超过 200 字。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，运行时没有页面）。
    var data = JSON.parse(__ncInput);
    var term = data.term || {};
    var rows = data.rows || [];

    // 学校公布的 12 节，与上游兜底表逐节一致（大节 08:00~09:40 等拆出来的结果）。
    var SLOT_TIMES = [
        '08:00-08:45', '08:55-09:40', '10:00-10:45', '10:55-11:40',
        '14:00-14:45', '14:55-15:40', '15:50-16:35', '16:45-17:30',
        '18:30-19:15', '19:25-20:10', '20:20-21:05', '21:15-22:00'
    ];
    var PERIOD_COUNT = SLOT_TIMES.length;
    var SECTION_MINUTES = 45;
    var BREAK_MINUTES = 10;
    var SCHOOL_NAME = '闽南科技学院';
    var MAX_PERIOD = 16;
    var FALLBACK_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_NAME_IN_WARNING = 20;
    var MAX_MINUTE = 23 * 60 + 59;

    var WEEK_PAREN = /^[周週]$/;
    var SERIAL_PAREN = /^\d{1,3}(\s*[-—~至,，、]\s*\d{1,3})*$/;
    var SEGMENT_SPLIT = /[\s,，、;；]+/;
    var BLANK_WORD = /^(未知|待定|暂无|无|未知教师|未知老师|未知地点)$/;

    var noNameBlocks = 0;
    var noWeekBlocks = 0;
    var noPeriodBlocks = 0;
    var overPeriodBlocks = 0;
    var droppedWeeks = 0;
    var ambiguousMarks = 0;
    var ambiguousSamples = [];
    var badTimes = 0;
    var droppedNames = [];
    var noTeacherCourses = [];
    var noRoomCourses = [];
    var warnings = [];

    function clipText(text, max) {
        var one = String(text);
        if (one.length <= max) return one;
        var head = one.substring(0, max - 1);
        var last = head.charCodeAt(head.length - 1);
        if (last >= 0xD800 && last <= 0xDBFF) head = head.substring(0, head.length - 1);
        return head + '…';
    }

    function pushWarning(message) {
        var text = clipText(message, MAX_WARNING_TEXT);
        if (warnings.indexOf(text) >= 0) return;
        warnings.push(text);
    }

    function finalWarnings() {
        if (warnings.length <= MAX_WARNINGS) return warnings;
        var kept = warnings.slice(0, MAX_WARNINGS - 1);
        var hidden = warnings.length - kept.length;
        kept.push(clipText('另有 ' + hidden + ' 条提醒未列出', MAX_WARNING_TEXT));
        return kept;
    }

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function mondayOf(isoDate) {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(clean(isoDate));
        if (!m) return null;
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        var back = (day.getDay() + 6) % 7;
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() - back));
    }

    function addDays(iso, delta) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!m) return null;
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() + delta));
    }

    function fieldOf(text, label) {
        var m = new RegExp(label + '[:：]\\s*([^;；]*)').exec(String(text || ''));
        return m ? clean(m[1]) : '';
    }

    function blankish(text) {
        var one = clean(text);
        if (!one) return true;
        return BLANK_WORD.test(one);
    }

    function pushWeek(out, week, oddOnly, evenOnly) {
        if (week < 1) return;
        if (week > MAX_WEEK) {
            droppedWeeks++;
            return;
        }
        if (oddOnly && week % 2 === 0) return;
        if (evenOnly && week % 2 === 1) return;
        out.push(week);
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

    function noteAmbiguous(segment) {
        ambiguousMarks++;
        var text = clean(segment);
        if (!text || ambiguousSamples.indexOf(text) >= 0) return;
        if (ambiguousSamples.length >= 3) return;
        ambiguousSamples.push(text);
    }

    // 周次串。无逗号前置标记归下一段；后置标记跟前一段。与 zsc 的 weeksIn 同一口径。
    function weeksIn(source) {
        var text = clean(source);
        if (!text) return [];
        text = text.replace(/[\[【][^\]】]*[\]】]/g, ' ');
        text = text.replace(/共\s*[0-9]+\s*周?/g, ' ');
        text = text.replace(/[（(]([^）)]*)[)）]/g, function (whole, inner) {
            var body = clean(inner);
            if (!body) return ' ';
            if (WEEK_PAREN.test(body)) return ' ';
            if (SERIAL_PAREN.test(body)) return ' ';
            return whole;
        });
        text = text.replace(/[（(]([单双])周?[)）](?=\s*[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return all;
            var seg = before.replace(/\s+$/, '').split(/[\s,，、;；]+/).pop();
            if (seg && /^[（(][单双]/.test(seg)) return ',' + all;
            return all;
        });
        text = text.replace(/([0-9])\s*周?\s*[（(]([单双])周?[)）](?=\s*[0-9])/g, '$1$2,');
        text = text.replace(/[～－−–—~至到]/g, '-');
        text = text.replace(/-\s*第\s*/g, '-');
        text = text.replace(/(\d)\s*-\s*(\d)/g, '$1-$2');
        var segments = text.split(SEGMENT_SPLIT);
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            if (!seg || /\d/.test(seg)) continue;
            if (seg.indexOf('单') < 0 && seg.indexOf('双') < 0) continue;
            var into = -1;
            for (var back = i - 1; back >= 0; back--) {
                if (/\d/.test(segments[back])) { into = back; break; }
            }
            for (var fwd = i + 1; into < 0 && fwd < segments.length; fwd++) {
                if (/\d/.test(segments[fwd])) { into = fwd; break; }
            }
            if (into < 0) continue;
            segments[into] = segments[into] + seg;
            segments[i] = '';
        }
        var weeks = [];
        for (var s = 0; s < segments.length; s++) {
            var segment = segments[s];
            if (!segment || !/\d/.test(segment)) continue;
            var oddOnly = segment.indexOf('单') >= 0;
            var evenOnly = segment.indexOf('双') >= 0;
            if (oddOnly && evenOnly) {
                noteAmbiguous(segment);
                oddOnly = false;
                evenOnly = false;
            } else if (!oddOnly && !evenOnly && segment.indexOf('隔') >= 0) {
                noteAmbiguous(segment);
            }
            var range = /(\d{1,2})\s*-\s*(\d{1,2})/.exec(segment);
            if (range) {
                var start = parseInt(range[1], 10);
                var end = parseInt(range[2], 10);
                for (var w = start; w <= end; w++) pushWeek(weeks, w, oddOnly, evenOnly);
                continue;
            }
            var single = /(\d{1,2})/.exec(segment);
            if (single) pushWeek(weeks, parseInt(single[1], 10), oddOnly, evenOnly);
        }
        return uniqueSorted(weeks);
    }

    function periodsIn(source) {
        var body = clean(source).replace(/[第节\s]/g, '').replace(/[（）()]/g, '')
            .replace(/[～－−–—~至到]/g, '-');
        if (!body) return null;
        var start = null;
        var end = null;
        function note(value) {
            if (!(value >= 1)) return;
            if (start === null || value < start) start = value;
            if (end === null || value > end) end = value;
        }
        var segments = body.split(/[,，]/);
        for (var i = 0; i < segments.length; i++) {
            var segment = segments[i];
            var range = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(segment);
            if (range) {
                note(parseInt(range[1], 10));
                note(parseInt(range[2], 10));
                continue;
            }
            if (/^\d{1,2}(\s*-\s*\d{1,2})+$/.test(segment)) {
                var ends = segment.split('-');
                note(parseInt(ends[0], 10));
                note(parseInt(ends[ends.length - 1], 10));
                continue;
            }
            if (!/^\d+$/.test(segment)) return null;
            if (segment.length >= 4 && segment.length % 2 === 0) {
                for (var k = 0; k < segment.length; k += 2) note(parseInt(segment.substring(k, k + 2), 10));
            } else {
                note(parseInt(segment, 10));
            }
        }
        if (start === null || end === null) return null;
        return { start: start, end: end };
    }

    function marksIn(inside) {
        var one = clean(inside);
        if (!one) return ' ';
        var odd = one.indexOf('单') >= 0;
        var even = one.indexOf('双') >= 0;
        if (odd && even) return '单双';
        if (odd) return '单';
        if (even) return '双';
        return ' ';
    }

    function splitSpec(text) {
        var body = clean(text);
        var periods = '';
        var weeks = clean(body.replace(/[\[【]\s*([^\]】]*)\s*[\]】]/g, function (whole, inside) {
            var one = clean(inside);
            if (!one) return ' ';
            if (periodsIn(one)) {
                if (!periods) periods = one;
                return whole;
            }
            return marksIn(one);
        }));
        return { weeks: weeks, periods: periods };
    }

    function periodsFromLabel(value) {
        var compact = clean(value).replace(/\s+/g, '');
        if (!compact) return null;
        var pair = /^第?(\d{1,2})[,，、\-—~至到](\d{1,2})节?$/.exec(compact);
        if (pair) {
            var a = parseInt(pair[1], 10);
            var b = parseInt(pair[2], 10);
            if (a < 1 || b < 1) return null;
            return a <= b ? { start: a, end: b } : { start: b, end: a };
        }
        var one = /^第(\d{1,2})节$/.exec(compact);
        if (!one) return null;
        var n = parseInt(one[1], 10);
        if (n < 1) return null;
        return { start: n, end: n };
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

    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(clean(code));
        if (!m) return '';
        if (m[3] === '1') return m[1] + '-' + m[2] + '学年第一学期';
        if (m[3] === '2') return m[1] + '-' + m[2] + '学年第二学期';
        if (m[3] === '3') return m[1] + '-' + m[2] + '学年第三学期';
        return m[1] + '-' + m[2] + '学年第' + m[3] + '学期';
    }

    function clockMinutes(text) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(clean(text));
        if (!m) {
            badTimes++;
            return 8 * 60;
        }
        var total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        if (total > MAX_MINUTE) {
            badTimes++;
            return MAX_MINUTE;
        }
        return total;
    }

    function clockText(minutes) {
        var value = minutes;
        if (value < 0) value = 0;
        if (value > MAX_MINUTE) value = MAX_MINUTE;
        return pad2(Math.floor(value / 60)) + ':' + pad2(value % 60);
    }

    function timePair(pair) {
        var parts = String(pair).split('-');
        var start = clockMinutes(parts[0]);
        var end = clockMinutes(parts[1]);
        if (end <= start) {
            end = start + 45;
            if (end > MAX_MINUTE) {
                end = MAX_MINUTE;
                start = MAX_MINUTE - 45;
            }
            badTimes++;
        }
        return { start: clockText(start), end: clockText(end) };
    }

    function placeholderPeriod(n) {
        var hour = 7 + n;
        return pad2(hour) + ':00-' + pad2(hour) + ':45';
    }

    function minutesOf(hhmm) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(clean(hhmm));
        if (!m) return null;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    // 课表大节时间能拆成 45 分钟一节、课间 10 分钟才采用；任何一行对不上就整表回落。
    function deriveSlots() {
        var slots = {};
        var count = 0;
        var sawRow = false;
        for (var r = 0; r < rows.length; r++) {
            var label = periodsFromLabel(rows[r].title);
            if (!label) continue;
            sawRow = true;
            var tm = /(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})/.exec(clean(rows[r].text));
            if (!tm) return { ok: false, reason: 'incomplete' };
            var blockStart = minutesOf(tm[1]);
            var blockEnd = minutesOf(tm[2]);
            if (blockStart === null || blockEnd === null) return { ok: false, reason: 'incomplete' };
            var n = label.end - label.start + 1;
            var span = blockEnd - blockStart;
            if (span !== SECTION_MINUTES * n + BREAK_MINUTES * (n - 1)) return { ok: false, reason: 'mismatch' };
            for (var i = 0; i < n; i++) {
                var start = blockStart + i * (SECTION_MINUTES + BREAK_MINUTES);
                slots[label.start + i] = clockText(start) + '-' + clockText(start + SECTION_MINUTES);
                count++;
            }
        }
        if (!count) return { ok: false, reason: sawRow ? 'incomplete' : 'missing' };
        return { ok: true, slots: slots };
    }

    function weekEndOf(raw) {
        var text = clean(raw);
        if (!text) return 0;
        var parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            return 0;
        }
        if (!parsed || typeof parsed.length !== 'number' || parsed.length < 1 || !parsed[0]) return 0;
        var end = Number(parsed[0].jszc);
        if (!(end > 0)) return 0;
        return Math.floor(end);
    }

    function namesText(names) {
        var shown = [];
        for (var i = 0; i < names.length && i < 3; i++) shown.push(clipText(names[i], MAX_NAME_IN_WARNING));
        return '例如 ' + shown.join('、') + (names.length > 3 ? ' 等' : '');
    }

    function noteDropped(name, teacher, reason) {
        if (droppedNames.length >= 5) return;
        var text = name ? clipText(name, MAX_NAME_IN_WARNING) : '(没认出课名)';
        if (teacher) text = text + '（' + clipText(teacher, MAX_NAME_IN_WARNING) + '）';
        droppedNames.push(text + '——' + reason);
    }

    function droppedText() {
        if (!droppedNames.length) return '';
        return '包含：' + droppedNames.join('；');
    }

    var order = [];
    var byCourse = {};

    function collectItem(item, day, defaultPeriods) {
        var name = clean(item && item.name);
        var info = String(item && item.info || '');
        var teacherText = fieldOf(info, '老师');
        if (!teacherText) teacherText = fieldOf(info, '教师');
        var teacher = blankish(teacherText) ? null : teacherText;
        if (!name) {
            noNameBlocks++;
            noteDropped('', teacher, '没认出课名');
            return;
        }
        var roomText = fieldOf(info, '地点');
        if (!roomText) roomText = fieldOf(info, '教室');
        var location = blankish(roomText) ? null : roomText;
        var timeText = fieldOf(info, '时间');
        if (!timeText) {
            noWeekBlocks++;
            noteDropped(name, teacher, '没认出周次与节次');
            return;
        }
        var spec = splitSpec(timeText);
        var periods = spec.periods ? periodsIn(spec.periods) : null;
        if (!periods) periods = defaultPeriods;
        if (!periods) {
            noPeriodBlocks++;
            noteDropped(name, teacher, '没认出节次');
            return;
        }
        if (periods.end > MAX_PERIOD) {
            overPeriodBlocks++;
            noteDropped(name, teacher, '节次超出 ' + MAX_PERIOD + ' 节');
            return;
        }
        var weeks = weeksIn(spec.weeks);
        if (!weeks.length) {
            noWeekBlocks++;
            noteDropped(name, teacher, '没认出周次');
            return;
        }
        var key = name + ' ' + (teacher || '');
        var course = byCourse[key];
        var runs = runsOf(weeks);
        for (var n = 0; n < runs.length; n++) {
            var run = runs[n];
            if (!course) {
                course = { name: name, teacher: teacher, note: null, blocks: [], seen: {} };
                byCourse[key] = course;
                order.push(key);
            }
            var block = {
                dayOfWeek: day,
                startPeriod: periods.start,
                endPeriod: periods.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: location
            };
            var blockKey = [block.dayOfWeek, block.startPeriod, block.endPeriod,
                block.startWeek, block.endWeek, block.weekType, block.location || ''].join('|');
            if (course.seen[blockKey]) continue;
            course.seen[blockKey] = true;
            course.blocks.push(block);
        }
    }

    for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri] || {};
        var rowPeriods = periodsFromLabel(row.title);
        var cells = row.cells || [];
        for (var c = 0; c < cells.length; c++) {
            var day = cells[c] && cells[c].day;
            if (typeof day !== 'number' || day < 1 || day > 7) continue;
            var items = cells[c].items || [];
            for (var p = 0; p < items.length; p++) collectItem(items[p], day, rowPeriods);
        }
    }

    if (order.length === 0) {
        var totalSkipped = noNameBlocks + noWeekBlocks + noPeriodBlocks + overPeriodBlocks;
        if (totalSkipped > 0) {
            var head = '本学期没有解析到任何课程：课表里的 ' + totalSkipped +
                ' 个上课安排都没能认出来（周次或节次的写法不认识，或节次超出 ' + MAX_PERIOD + ' 节）。';
            var tail = '请把教务页面的课表截图反馈给空课';
            var detail = droppedText();
            var room = MAX_WARNING_TEXT - head.length - tail.length - 1;
            if (detail && room > 1 && detail.length > room) detail = detail.substring(0, room - 1) + '…';
            throw new Error(head + (detail ? detail + ' ' : '') + tail);
        }
        throw new Error('本学期没有解析到任何课程：可能是还没排课，或教务页面改了结构（也可能登录状态已失效）');
    }

    var courses = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    for (var oi = 0; oi < order.length; oi++) {
        var item = byCourse[order[oi]];
        for (var bi = 0; bi < item.blocks.length; bi++) {
            if (item.blocks[bi].endWeek > maxWeek) maxWeek = item.blocks[bi].endWeek;
            if (item.blocks[bi].endPeriod > maxPeriod) maxPeriod = item.blocks[bi].endPeriod;
        }
        if (item.teacher === null) noTeacherCourses.push(item.name);
        for (var li = 0; li < item.blocks.length; li++) {
            if (item.blocks[li].location === null) {
                noRoomCourses.push(item.name);
                break;
            }
        }
        courses.push({ name: item.name, teacher: item.teacher, note: item.note, blocks: item.blocks });
    }

    var calendarWeeks = weekEndOf(data.weekAjax);
    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    var derived = deriveSlots();
    var periodTimes = [];
    var limit = maxPeriod > PERIOD_COUNT ? maxPeriod : PERIOD_COUNT;
    for (var pi = 1; pi <= limit; pi++) {
        var raw = null;
        if (derived.ok && derived.slots[pi]) raw = derived.slots[pi];
        else if (pi <= PERIOD_COUNT) raw = SLOT_TIMES[pi - 1];
        else raw = placeholderPeriod(pi);
        var pair = timePair(raw);
        periodTimes.push({ periodIndex: pi, start: pair.start, end: pair.end });
    }

    if (!data.now) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
    var termName = clean(term.name) || termNameFromCode(term.code);

    function headerWeek(show, code) {
        var text = clean(show);
        if (!text || !code) return 0;
        var sem = text.split(/\s+/)[0];
        var m = /第\s*(\d+)\s*周/.exec(text);
        if (sem !== clean(code) || !m) return -1;
        var n = parseInt(m[1], 10);
        if (!(n >= 1)) return -1;
        return n;
    }

    var weekNo = headerWeek(data.headerShow, term.code);
    var firstDay = mondayOf(data.now);
    if (!firstDay) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
    if (weekNo >= 1) {
        firstDay = addDays(firstDay, -(weekNo - 1) * 7);
    }

    if (!termName) {
        termName = SCHOOL_NAME + '当前学期';
        pushWarning('没能识别出学年学期，学期名已用「' + termName + '」占位，请在「学期管理」里改名');
    }
    if (data.screenTermMissing === true) {
        pushWarning('课表页上找不到学年学期，无法确认屏幕上的课表是哪一学期，导入的是「' +
            clipText(termName, MAX_NAME_IN_WARNING) + '」，请核对是否是要导入的那一学期');
    }
    if (weekNo >= 1) {
        // 抬头与学期一致，开学日按第 N 周回推，不必提醒
    } else if (weekNo < 0) {
        pushWarning('教务首页显示的学期和要导入的学期对不上，开学日期已按最近的周一（' +
            firstDay + '）推算，请在「学期管理」里核对');
    } else {
        pushWarning('开学日期无法从教务首页看出当前是第几周，已按最近的周一（' +
            firstDay + '）推算，请在「学期管理」里核对');
    }
    if (wantedWeeks > MAX_WEEK) {
        pushWarning('学期总周数算出来是 ' + wantedWeeks + ' 周，超过了上限 ' + MAX_WEEK +
            ' 周，已按 ' + MAX_WEEK + ' 周计，请在「学期管理」里核对');
    }
    if (calendarWeeks === 0) {
        if (maxWeek > FALLBACK_TOTAL_WEEKS) {
            pushWarning('学校没有给出本学期一共有多少周，课表里有到第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks +
                ' 周计，请在「学期管理」里核对');
        } else {
            pushWarning('学校没有给出本学期一共有多少周，已按 ' + FALLBACK_TOTAL_WEEKS + ' 周计，请在「学期管理」里核对');
        }
    } else if (totalWeeks > calendarWeeks) {
        pushWarning('课表里有到第 ' + maxWeek + ' 周的课，比学校校历的 ' + calendarWeeks +
            ' 周多，学期总周数已按 ' + totalWeeks + ' 周计，请在「学期管理」里核对');
    }
    if (!derived.ok && derived.reason === 'mismatch') {
        pushWarning('课表上的大节时间对不上每节 45 分钟、课间 10 分钟，已改用学校公布的节次时间，请在「学期管理」里核对');
    } else if (!derived.ok) {
        pushWarning('课表上没有完整的大节时间，已改用学校公布的节次时间，请在「学期管理」里核对');
    }
    if (maxPeriod > PERIOD_COUNT) {
        var extraText = maxPeriod > PERIOD_COUNT + 1
            ? '第 ' + (PERIOD_COUNT + 1) + ' 至 ' + maxPeriod + ' 节'
            : '第 ' + maxPeriod + ' 节';
        var extraStart = periodTimes[PERIOD_COUNT] ? periodTimes[PERIOD_COUNT].start : '';
        pushWarning('课表里有' + extraText + '，节次时间里没有这几节，已临时补上（' +
            extraStart + ' 起），请到「学期管理」里核对真实的上下课时间');
    }
    if (badTimes > 0) {
        pushWarning('节次时间里有 ' + badTimes + ' 处写法不对，已改为合理的时间，请在「学期管理」里核对上下课时间');
    }
    if (droppedWeeks > 0) {
        pushWarning('有 ' + droppedWeeks + ' 条周次超出 ' + MAX_WEEK + ' 周，这些周次没有导入');
    }
    if (noNameBlocks || noWeekBlocks || noPeriodBlocks || overPeriodBlocks) {
        var parts2 = [];
        if (noNameBlocks) parts2.push('没认出课名 ' + noNameBlocks + ' 个');
        if (noWeekBlocks) parts2.push('没认出周次 ' + noWeekBlocks + ' 个');
        if (noPeriodBlocks) parts2.push('没认出节次 ' + noPeriodBlocks + ' 个');
        if (overPeriodBlocks) parts2.push('节次超出 ' + MAX_PERIOD + ' 节 ' + overPeriodBlocks + ' 个');
        pushWarning('有 ' + (noNameBlocks + noWeekBlocks + noPeriodBlocks + overPeriodBlocks) +
            ' 个上课安排没能认出来，已跳过（' + parts2.join('，') + '）。教务页面的写法可能有变化，欢迎反馈。' +
            droppedText());
    }
    if (ambiguousMarks > 0) {
        var shownMarks = [];
        for (var mi = 0; mi < ambiguousSamples.length; mi++) {
            shownMarks.push(clipText(ambiguousSamples[mi], MAX_NAME_IN_WARNING));
        }
        var marks = shownMarks.length ? '（' + shownMarks.join('、') + '）' : '';
        pushWarning('有 ' + ambiguousMarks + ' 处周次里的单双标记认不出来' + marks +
            '，这些周次已按每周都上处理，请核对导入结果');
    }
    if (noTeacherCourses.length > 0) {
        pushWarning('有 ' + noTeacherCourses.length + ' 门课教务没有给任课教师，已留空（' + namesText(noTeacherCourses) +
            '），可在对应课程的「编辑课程」里补充');
    }
    if (noRoomCourses.length > 0) {
        pushWarning('有 ' + noRoomCourses.length + ' 门课教务没有给上课地点，已留空（' + namesText(noRoomCourses) +
            '），可在对应课程的「编辑课程」里补充');
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finalWarnings(),
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
