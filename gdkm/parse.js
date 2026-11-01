(function () {
    // 广东科贸职业学院（强智 · 新版周课表 /jsxsd/）课表解析。
    // 移植自 shiguang_warehouse 的 GDKM/GDKM.js（MIT，上游作者 qwwshs）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 03d161a；本校脚本 08b0e02。
    // 模板是已审计的 zsc。上游 parseWeeks() 只认「3-4,9-18周」这种数字段，括号里的单双会被留下来当普通文字，
    // 数字仍能读到，但单双标记本身不生效。本件改成 zsc 那套：每段各自判单双。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   1. 无逗号的前置单双「(单)1-8周(双)9-16周」后一个标记归下一段；后置「1-8周(单)9-16周(双)」仍各跟各的。
    //      单周收成奇数起止（1-8 单周是 1 到 7），双周收成偶数起止（9-16 双周是 10 到 16）；
    //   2. 「共 N 周」只剥备注本身；「第1-第8周」按一段读；
    //   3. 节次优先读时间文字里的方括号，没有方括号再用行首「(01、02小节)」或「第N，M节」，数字全部取值；
    //   4. 星期按格子顺序加跨行占位对齐（上游的 occupied 列），不按数组下标硬套；
    //   5. 同一门课、同一天、同一套周次，节次重叠或紧挨着的合成一段（含同一节的重复行）；
    //   6. 教师、教室写着未知、待定、暂无的当成没有，留空并汇总提醒，不去学期管理里改；
    //   7. 节次时间用上游写死的 12 节；用到更后的节次按占位补上并提醒；
    //   8. 总周数以教学周历为准，没有周历按 20 周，只有课表里出现更晚的周次才抬高；
    //   9. 开学日按上游的算法：第 1 周星期一的日号，配星期六格子里的月份；对不上就说明；
    //   10. 提醒里的教务原文先截到 20 字，每条不超过 200 字。
    //
    // 输入是 extract.js 交出来的结构（纯函数，没有页面）：
    //   { now, term: { code, name }, calendar: { weeks: [ { label, days } ] },
    //     rows: [ { sectionText, cells: [ { rowspan, items: [ { name, abbr } ] } ] } ] }
    var data = JSON.parse(__ncInput);

    // 学校公布的节次时间：12 节，照搬上游 saveAppTimeSlots()。
    // 第 6、8、10、12 节只有 30 分钟，这是上游写死的，不改。
    var SLOT_TIMES = [
        '08:30-09:10', '09:20-10:00', '10:20-11:00', '11:10-11:50',
        '14:00-14:40', '14:50-15:20', '15:30-16:10', '16:20-16:50',
        '18:30-19:10', '19:20-19:50', '20:00-20:40', '20:50-21:20'
    ];
    var PERIOD_COUNT = SLOT_TIMES.length;
    var SCHOOL_NAME = '广东科贸职业学院';
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
    var SEP = String.fromCharCode(1);

    var ambiguousMarks = 0;
    var ambiguousSamples = [];
    var droppedWeeks = 0;
    var noNameBlocks = 0;
    var noWeekBlocks = 0;
    var noPeriodBlocks = 0;
    var overPeriodBlocks = 0;
    var droppedNames = [];
    var badTimes = 0;
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

    function weekdayOf(isoDate) {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(clean(isoDate));
        if (!m) return -1;
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
    }

    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d+)$/.exec(clean(code));
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

    function namesText(names) {
        var shown = [];
        for (var i = 0; i < names.length && i < 3; i++) shown.push(clipText(names[i], MAX_NAME_IN_WARNING));
        return '例如 ' + shown.join('、') + (names.length > 3 ? ' 等' : '');
    }

    function noteDropped(name, reason) {
        if (droppedNames.length >= 5) return;
        var text = name ? clipText(name, MAX_NAME_IN_WARNING) : '(没认出课名)';
        droppedNames.push(text + '——' + reason);
    }

    function droppedText() {
        if (!droppedNames.length) return '';
        return '包含：' + droppedNames.join('；');
    }

    function noteAmbiguous(segment) {
        ambiguousMarks++;
        var text = clean(segment);
        if (!text || ambiguousSamples.indexOf(text) >= 0) return;
        if (ambiguousSamples.length >= 3) return;
        ambiguousSamples.push(text);
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

    // 周次串 → 周次数组。单双可以写在数字前、数字后，也可以不用逗号隔开。
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
                if (end < start) {
                    var swap = start;
                    start = end;
                    end = swap;
                }
                for (var w = start; w <= end; w++) pushWeek(weeks, w, oddOnly, evenOnly);
                continue;
            }
            var single = /(\d{1,2})/.exec(segment);
            if (single) pushWeek(weeks, parseInt(single[1], 10), oddOnly, evenOnly);
        }
        return uniqueSorted(weeks);
    }

    function periodsIn(source) {
        var body = clean(source).replace(/[第节\s]/g, '').replace(/[（）()]/g, '').replace(/[～－−–—~至到]/g, '-');
        if (!body) return null;
        var start = null;
        var end = null;
        function note(value) {
            if (!(value >= 1)) return;
            if (start === null || value < start) start = value;
            if (end === null || value > end) end = value;
        }
        var segments = body.split(/[,，、]/);
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

    function periodsFromLoose(text) {
        var src = String(text || '');
        var re = /(\d{1,2})/g;
        var found = re.exec(src);
        var start = null;
        var end = null;
        while (found) {
            var n = parseInt(found[1], 10);
            if (n >= 1) {
                if (start === null || n < start) start = n;
                if (end === null || n > end) end = n;
            }
            found = re.exec(src);
        }
        if (start === null) return null;
        return { start: start, end: end };
    }

    function periodsFromSpec(spec, rowLabel) {
        var text = String(spec || '');
        var open = text.indexOf('[');
        var openFull = text.indexOf('【');
        if (openFull >= 0 && (open < 0 || openFull < open)) open = openFull;
        if (open >= 0) {
            var close = text.indexOf(']', open);
            var closeFull = text.indexOf('】', open);
            if (closeFull >= 0 && (close < 0 || closeFull < close)) close = closeFull;
            var inside = close > open ? text.substring(open + 1, close) : text.substring(open + 1);
            var fromBracket = periodsIn(inside);
            if (fromBracket) return fromBracket;
        }
        return periodsIn(rowLabel) || periodsFromLoose(rowLabel);
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

    // 从「老师:张三;时间:…;地点:…」取一个字段。中英文冒号、分号都认。
    function fieldOf(text, key) {
        var src = String(text || '');
        var startIdx = -1;
        var marks = [key + ':', key + '：'];
        for (var i = 0; i < marks.length; i++) {
            startIdx = src.indexOf(marks[i]);
            if (startIdx >= 0) {
                startIdx += marks[i].length;
                break;
            }
        }
        if (startIdx < 0) return '';
        var endIdx = src.length;
        for (var k = startIdx; k < src.length; k++) {
            var ch = src.charAt(k);
            if (ch === ';' || ch === '；' || ch === '\n') {
                endIdx = k;
                break;
            }
        }
        return clean(src.substring(startIdx, endIdx));
    }

    function blankTeacher(text) {
        var t = clean(text);
        if (!t) return true;
        return t === '未知' || t === '未知教师' || t === '未知老师' || t === '待定' || t === '暂无' || t === '暂无教师' || t === '暂无老师' || t === '无' || t === '空';
    }

    function blankRoom(text) {
        var t = clean(text);
        if (!t) return true;
        return t === '未知' || t === '未知地点' || t === '未知教室' || t === '待定' || t === '暂无' || t === '暂无教室' || t === '暂无地点' || t === '无' || t === '空';
    }

    function weekKey(weeks) {
        return weeks.join(',');
    }

    function isoParts(year, month, day) {
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        var probe = new Date(year, month - 1, day);
        if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
        return year + '-' + pad2(month) + '-' + pad2(day);
    }

    // 8–12 月用学年的前一年，1–7 月用后一年。第二学期的 2 月不能再用起始年，否则会差一年。
    function yearForMonth(code, month) {
        var text = clean(code);
        var pair = /^(\d{4})\s*-\s*(\d{4})/.exec(text);
        if (pair) {
            var start = parseInt(pair[1], 10);
            var end = parseInt(pair[2], 10);
            if (end === start + 1) return month >= 8 ? start : end;
            return start;
        }
        var one = /^(\d{4})/.exec(text);
        return one ? parseInt(one[1], 10) : 0;
    }

    // 上游 getSchoolStartDate：第 1 周星期一的日号 + 星期六格子里的「M月D日」。
    // 星期一的数字比星期六大，说明星期一在上一个月。年份按调整后的月份取。
    function firstMondayFromCalendar(weeks, code) {
        for (var i = 0; i < weeks.length; i++) {
            if (!/^第\s*1\s*周$/.test(clean(weeks[i].label))) continue;
            var days = weeks[i].days || [];
            var mondayText = clean(days[0] || '');
            var saturdayText = clean(days[5] || '');
            var sat = /(\d{1,2})月(\d{1,2})日/.exec(saturdayText);
            if (!sat) return null;
            var month = parseInt(sat[1], 10);
            var satDay = parseInt(sat[2], 10);
            var dayMatch = /(\d{1,2})日/.exec(mondayText);
            var day = dayMatch ? parseInt(dayMatch[1], 10) : parseInt(mondayText, 10);
            if (!(day >= 1)) return null;
            if (day > satDay) {
                month = month - 1;
                if (month === 0) month = 12;
            }
            var year = yearForMonth(code, month);
            if (!year) return null;
            return isoParts(year, month, day);
        }
        return null;
    }

    function calendarWeekCount(weeks) {
        var max = 0;
        for (var i = 0; i < weeks.length; i++) {
            var m = /^第\s*(\d+)\s*周$/.exec(clean(weeks[i].label));
            if (!m) continue;
            var n = parseInt(m[1], 10);
            if (n > max) max = n;
        }
        return max;
    }

    var term = data.term || {};
    var termName = clean(term.name);
    if (!(termName.indexOf('学年') >= 0 || termName.indexOf('学期') >= 0)) {
        termName = termNameFromCode(term.code || term.name) || termName;
    }
    if (!termName) termName = '';

    var calendarWeeksList = (data.calendar && data.calendar.weeks) || [];
    var rawFirst = firstMondayFromCalendar(calendarWeeksList, term.code || term.name);
    var firstDay = rawFirst;
    var firstDayNote = '';
    if (firstDay && weekdayOf(firstDay) !== 1) {
        var aligned = mondayOf(firstDay);
        firstDayNote = '教务的教学周历里第 1 周的星期一写的是 ' + firstDay +
            '（那天不是星期一），开学日期已按它所在那一周的周一（' + aligned + '）对齐，请在「学期管理」里核对';
        firstDay = aligned;
    }
    if (!firstDay) {
        if (!data.now) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
        firstDay = mondayOf(data.now);
        if (!firstDay) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
        firstDayNote = '开学日期无法从教务获取（教学周历的表格结构认不出来），已按最近的周一（' +
            firstDay + '）推算，请在「学期管理」里核对';
    }

    var rows = data.rows || [];
    var occupied = {};
    var rawItems = [];
    var maxWeek = 0;
    var maxPeriod = 0;

    for (var r = 0; r < rows.length; r++) {
        var occupiedCols = occupied[r] || {};
        var cells = rows[r].cells || [];
        var col = 1;
        for (var c = 0; c < cells.length; c++) {
            while (occupiedCols[col]) col++;
            var day = col;
            var span = parseInt(cells[c].rowspan, 10);
            if (!(span >= 1)) span = 1;
            if (span > 1) {
                for (var rr = r + 1; rr < r + span; rr++) {
                    if (!occupied[rr]) occupied[rr] = {};
                    occupied[rr][col] = true;
                }
            }
            col++;
            if (day < 1 || day > 7) continue;
            var items = cells[c].items || [];
            for (var k = 0; k < items.length; k++) {
                var name = clean(items[k].name);
                var abbr = items[k].abbr || '';
                if (!name) {
                    noNameBlocks++;
                    noteDropped('', '没认出课名');
                    continue;
                }
                var teacherText = fieldOf(abbr, '老师');
                if (!teacherText) teacherText = fieldOf(abbr, '教师');
                var roomText = fieldOf(abbr, '地点');
                if (!roomText) roomText = fieldOf(abbr, '教室');
                var timeText = fieldOf(abbr, '时间');
                var weeks = weeksIn(timeText);
                if (!weeks.length) {
                    noWeekBlocks++;
                    noteDropped(name, '没认出周次');
                    continue;
                }
                var period = periodsFromSpec(timeText, rows[r].sectionText);
                if (!period) {
                    noPeriodBlocks++;
                    noteDropped(name, '没认出节次');
                    continue;
                }
                if (period.start > MAX_PERIOD || period.end > MAX_PERIOD) {
                    overPeriodBlocks++;
                    noteDropped(name, '节次超出范围');
                    continue;
                }
                var teacher = blankTeacher(teacherText) ? null : teacherText;
                var location = blankRoom(roomText) ? null : roomText;
                for (var wi = 0; wi < weeks.length; wi++) {
                    if (weeks[wi] > maxWeek) maxWeek = weeks[wi];
                }
                if (period.end > maxPeriod) maxPeriod = period.end;
                rawItems.push({
                    name: name,
                    teacher: teacher,
                    location: location,
                    day: day,
                    start: period.start,
                    end: period.end,
                    weeks: weeks,
                    key: name + SEP + (teacher || '') + SEP + (location || '') + SEP + day + SEP + weekKey(weeks)
                });
            }
        }
    }

    rawItems.sort(function (a, b) {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return a.start - b.start;
    });
    var merged = [];
    for (var mi = 0; mi < rawItems.length; mi++) {
        var cur = rawItems[mi];
        var prev = merged.length ? merged[merged.length - 1] : null;
        if (!prev || prev.key !== cur.key || cur.start > prev.end + 1) {
            merged.push({
                name: cur.name,
                teacher: cur.teacher,
                location: cur.location,
                day: cur.day,
                start: cur.start,
                end: cur.end,
                weeks: cur.weeks,
                key: cur.key
            });
        } else if (cur.end > prev.end) {
            prev.end = cur.end;
        }
    }

    var groups = [];
    var groupAt = {};
    var noTeacherCourses = [];
    var noRoomCourses = [];
    for (var gi = 0; gi < merged.length; gi++) {
        var item = merged[gi];
        var gk = item.name + SEP + (item.teacher || '');
        if (groupAt[gk] === undefined) {
            groupAt[gk] = groups.length;
            groups.push({ name: item.name, teacher: item.teacher, note: null, blocks: [] });
        }
        var runs = runsOf(item.weeks);
        for (var rn = 0; rn < runs.length; rn++) {
            groups[groupAt[gk]].blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: runs[rn].start,
                endWeek: runs[rn].end,
                weekType: runs[rn].weekType,
                location: item.location
            });
        }
    }

    if (!groups.length) throw new Error('没有找到课程。请确认已经打开本学期课表再点提取');

    groups.sort(function (a, b) {
        var da = a.blocks[0].dayOfWeek - b.blocks[0].dayOfWeek;
        if (da) return da;
        var sa = a.blocks[0].startPeriod - b.blocks[0].startPeriod;
        if (sa) return sa;
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return 0;
    });
    for (var gs = 0; gs < groups.length; gs++) {
        groups[gs].blocks.sort(function (a, b) {
            if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
            if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
            if (a.startWeek !== b.startWeek) return a.startWeek - b.startWeek;
            if (a.weekType < b.weekType) return -1;
            if (a.weekType > b.weekType) return 1;
            return 0;
        });
        if (!groups[gs].teacher && noTeacherCourses.indexOf(groups[gs].name) < 0) noTeacherCourses.push(groups[gs].name);
        for (var bi = 0; bi < groups[gs].blocks.length; bi++) {
            if (!groups[gs].blocks[bi].location && noRoomCourses.indexOf(groups[gs].name) < 0) {
                noRoomCourses.push(groups[gs].name);
            }
        }
    }

    var calendarWeeks = calendarWeekCount(calendarWeeksList);
    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    var periodTimes = [];
    for (var pi = 0; pi < SLOT_TIMES.length; pi++) {
        var pair = timePair(SLOT_TIMES[pi]);
        periodTimes.push({ periodIndex: pi + 1, start: pair.start, end: pair.end });
    }
    for (var extra = PERIOD_COUNT + 1; extra <= maxPeriod; extra++) {
        var placeholder = timePair(placeholderPeriod(extra));
        periodTimes.push({ periodIndex: extra, start: placeholder.start, end: placeholder.end });
    }

    if (!termName) {
        termName = SCHOOL_NAME + '当前学期';
        pushWarning('没能识别出学年学期，学期名已用「' + termName + '」占位，请在「学期管理」里改名');
    }
    if (firstDayNote) pushWarning(firstDayNote);
    if (wantedWeeks > MAX_WEEK) {
        pushWarning('学期总周数算出来是 ' + wantedWeeks + ' 周，超过了上限 ' + MAX_WEEK +
            ' 周，已按 ' + MAX_WEEK + ' 周计，请在「学期管理」里核对');
    }
    if (calendarWeeks === 0) {
        if (maxWeek > FALLBACK_TOTAL_WEEKS) {
            pushWarning('教务没有给出学期总周数，课表里有到第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks +
                ' 周计，请在「学期管理」里核对');
        } else {
            pushWarning('教务没有给出学期总周数，已按 ' + FALLBACK_TOTAL_WEEKS + ' 周计，请在「学期管理」里核对');
        }
    } else if (totalWeeks > calendarWeeks) {
        pushWarning('课表里有到第 ' + maxWeek + ' 周的课，比教务教学周历的 ' + calendarWeeks +
            ' 周多，学期总周数已按 ' + totalWeeks + ' 周计，请在「学期管理」里核对');
    }
    if (maxPeriod > PERIOD_COUNT) {
        var extraText = maxPeriod > PERIOD_COUNT + 1
            ? '第 ' + (PERIOD_COUNT + 1) + ' 至 ' + maxPeriod + ' 节'
            : '第 ' + maxPeriod + ' 节';
        pushWarning('课表里有' + extraText + '，节次时间里没有这几节，已临时补上（' +
            periodTimes[PERIOD_COUNT].start + ' 起），请到「学期管理」里核对真实的上下课时间');
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
            ' 个上课安排没能认出来，已跳过（' + parts2.join('，') + '）。' + droppedText());
    }
    if (ambiguousMarks > 0) {
        var shownMarks = [];
        for (var am = 0; am < ambiguousSamples.length; am++) {
            shownMarks.push(clipText(ambiguousSamples[am], MAX_NAME_IN_WARNING));
        }
        var marks = shownMarks.length ? '（' + shownMarks.join('、') + '）' : '';
        pushWarning('有 ' + ambiguousMarks + ' 处周次里的单双 / 隔周标记认不出来' + marks +
            '，这些周次已按「每周都上」处理，请核对导入结果');
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
                courses: groups
            }
        ]
    });
})()
