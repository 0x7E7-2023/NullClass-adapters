(function () {
    // 北京工商大学（强智旧版 /jsxsd/ 课表页）课表解析。
    // 移植自 shiguang_warehouse 的 BTBU/btbu.js（MIT，上游作者 lztttt）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 29498b0；本校脚本最后一次修改 80e30cf（批量合并，提交者不是作者）。模板是已审计的 csuft（周次、提醒、合并沿用）。
    // 保留上游的 13 节节次时间、表头定星期、行首「N~M节」兜底、卡片拆课名 / 教师 / 周次 / 教室、编号在课名前的兜底；
    // 周次逐段判单双（含无逗号前置、后置），超出 13 节按 H3 顺推补齐，所有推算与丢课都汇总提醒。
    // 输入：{ now, term: { code, name, picked }, calendar: { weeks: [{ label, days }] }（可空）, rows: [...] }
    //   picked 为 selected（页面标出当前学期）或 first（取了列表第一项）；
    //   pieces 里 t 为空的是课名候选，其它 t 是 font 的 title 原文（extract 已按白名单挑过）；text 只在没有课表格子的表头 / 行首格上有。
    var data = JSON.parse(__ncInput);

    var SLOT_TIMES = [
        '08:00-08:45', '08:50-09:35', '09:50-10:35', '10:40-11:25', '11:30-12:15',
        '13:40-14:25', '14:30-15:15', '15:30-16:15', '16:20-17:05', '17:10-17:55',
        '18:45-19:30', '19:35-20:20', '20:25-21:10'
    ];
    var SCHOOL_NAME = '北京工商大学';
    var EXTRA_GAP = 5;          // H3：超出节次表时，课间 5 分钟、每节 45 分钟顺推，越过 23:59 就停
    var EXTRA_LEN = 45;
    var MAX_MINUTE = 23 * 60 + 59;
    var FALLBACK_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_NAME_IN_WARNING = 20;
    var MAX_DROPPED_SHOWN = 3;
    var WEEK_PAREN = /^[周週]$/;
    var SERIAL_PAREN = /^\d{1,3}(\s*[-—~至,，、]\s*\d{1,3})*$/;
    var SEGMENT_SPLIT = /[\s,，、;；]+/;
    var CJK = /[一-龥]/;
    var WEEKDAY = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    var SEP = String.fromCharCode(1);

    var ambiguousMarks = 0;
    var ambiguousSamples = [];
    var droppedWeeks = 0;
    var noWeekBlocks = 0;
    var noPeriodBlocks = 0;
    var overPeriodBlocks = 0;
    var droppedNames = [];
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

    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d+)$/.exec(clean(code));
        if (!m) return '';
        if (m[3] === '1') return m[1] + '-' + m[2] + '学年第一学期';
        if (m[3] === '2') return m[1] + '-' + m[2] + '学年第二学期';
        if (m[3] === '3') return m[1] + '-' + m[2] + '学年第三学期';
        return m[1] + '-' + m[2] + '学年第' + m[3] + '学期';
    }

    function clockText(minutes) {
        var value = minutes;
        if (value < 0) value = 0;
        if (value > MAX_MINUTE) value = MAX_MINUTE;
        return pad2(Math.floor(value / 60)) + ':' + pad2(value % 60);
    }

    function clockMinutes(text) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(clean(text));
        return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
    }

    // 上游写死的 13 节，逐节照抄
    function fixedSlots() {
        var out = [];
        for (var i = 0; i < SLOT_TIMES.length; i++) {
            var parts = SLOT_TIMES[i].split('-');
            out.push({ periodIndex: i + 1, start: parts[0], end: parts[1] });
        }
        return out;
    }

    // H3 补齐的节次，接在第 13 节之后；能补到哪一节，由 23:59 决定
    function extraSlots() {
        var out = [];
        var prevEnd = clockMinutes(SLOT_TIMES[SLOT_TIMES.length - 1].split('-')[1]);
        for (var n = SLOT_TIMES.length + 1; ; n++) {
            var start = prevEnd + EXTRA_GAP;
            var end = start + EXTRA_LEN;
            if (end > MAX_MINUTE) break;
            out.push({ periodIndex: n, start: clockText(start), end: clockText(end) });
            prevEnd = end;
        }
        return out;
    }

    function namesText(names) {
        var shown = [];
        for (var i = 0; i < names.length && i < 3; i++) shown.push(clipText(names[i], MAX_NAME_IN_WARNING));
        return '例如 ' + shown.join('、') + (names.length > 3 ? ' 等' : '');
    }

    function noteDropped(name, reason) {
        if (droppedNames.length >= MAX_DROPPED_SHOWN) return;
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

    // 周次串 → 周次数组。单双可以写在数字前、数字后，也可以不用逗号隔开；「共 N 周」只剥备注。
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

    // 方括号里的节次：[01-02节] → 1..2，[03-04-05节] → 3..5，[01,02] → 1..2
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

    // 周次数组 → 连续段；隔一周的段是单周或双周
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

    // 教室重复楼栋名：「树人楼(树人楼北502)」→「树人楼(北502)」
    function dedupePosition(text) {
        var one = clean(text);
        var match = /^(.+?)\s*[（(]\s*\1\s*(.+?)[）)]\s*$/.exec(one);
        return match ? match[1] + '(' + match[2] + ')' : one;
    }

    // 教师括号里的备注（外聘、研究生、实验、主讲）不是教师名，去掉后再判空；不拆成第二位教师
    function teacherOf(text) {
        var t = clean(String(text || '').replace(/[（(][^）)]*[）)]/g, ''));
        return blankTeacher(t) ? null : t;
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

    // 行首「1~2节」标签的节次范围，没有 [节次] 括号时用它兜底
    function sectionsFromLabel(label) {
        var m = /(\d+)\s*[~～]\s*(\d+)\s*节/.exec(String(label || ''));
        if (!m) return null;
        return { start: parseInt(m[1], 10), end: parseInt(m[2], 10) };
    }

    function periodOf(time, rowSec) {
        var m = /[\[【]([^\]】]*)[\]】]/.exec(String(time || ''));
        var found = m ? periodsIn(m[1]) : null;
        return found || rowSec;
    }

    function weekdayFromText(text) {
        var m = /(?:星期|周)\s*([一二三四五六日天])/.exec(String(text || ''));
        return m ? WEEKDAY[m[1]] : 0;
    }

    function spanOf(td) {
        var n = parseInt(td && td.span, 10);
        return n >= 1 ? n : 1;
    }

    // 表头前 4 行定 列号 → 星期几（考虑 colspan）；上游不论命中几列都照用，这里同样
    function buildDayMap(rows) {
        var map = {};
        for (var r = 0; r < rows.length && r < 4; r++) {
            var tds = rows[r].tds || [];
            var col = 0;
            for (var c = 0; c < tds.length; c++) {
                var day = weekdayFromText(tds[c].text);
                if (day && map[col] === undefined) map[col] = day;
                col += spanOf(tds[c]);
            }
            if (Object.keys(map).length >= 2) break;
        }
        return map;
    }

    // 课名判断与编号清理：照上游 cleanCourseName 的顺序
    function cleanCourseName(text) {
        var name = clean(text);
        if (!name) return '';
        name = name.replace(/课程编号\s*[:：]?\s*[A-Z0-9]+/gi, '');
        name = name.replace(/^[A-Za-z]{1,6}\d{2,10}[A-Za-z]?(?=[一-龥\s（(])\s*/, '');
        name = name.replace(/^[A-Za-z0-9]{8,16}(?=[一-龥（(])/, function (m) {
            return /\d/.test(m) ? '' : m;
        });
        name = name.replace(/^\d{5,12}(?=[一-龥\s（(])\s*/, '');
        name = name.replace(/[（(][0-9A-Za-z]{5,16}[)）]\s*$/, '');
        name = name.replace(/([一-龥）)])(\d{5,12}[A-Za-z]?)\s*$/, '$1');
        return clean(name);
    }

    // 纯编号（不含中文）：北工商形如 080901C4S2007、纯数字 01110037
    function isPureCourseCode(text) {
        if (CJK.test(text)) return false;
        if (/^\d{6,16}$/.test(text)) return true;
        return /^[A-Z0-9]{6,16}$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text);
    }

    function newItem(name, day, rowSec) {
        return { name: name, teacher: '', time: '', room: '', day: day, rowSec: rowSec };
    }

    // 一个课表格子里的文字片段 → 课程卡片（照上游 parseCellInto 的状态机）
    function parseCell(pieces, day, rowSec, out) {
        var current = null;
        var pendingCode = null;
        function pushCurrent() {
            if (current) out.push(current);
            current = null;
        }
        for (var j = 0; j < pieces.length; j++) {
            var piece = pieces[j] || {};
            var title = String(piece.t || '');
            var text = clean(piece.x);
            if (!title) {
                if (!text || /^[-—\s]+$/.test(text)) {
                    // 同格两门课之间的「------」分隔线：结算上一门
                    pushCurrent();
                    pendingCode = null;
                    continue;
                }
                var name = cleanCourseName(text);
                if (name && CJK.test(name)) {
                    pushCurrent();
                    current = newItem(name, day, rowSec);
                    pendingCode = null;
                } else if (name && isPureCourseCode(name)) {
                    // 编号在课名之前单独出现：先暂存；课程已开始时的编号只是附加信息
                    if (!current) pendingCode = name;
                }
            } else if (title.indexOf('课程') !== -1 && title.indexOf('周次') === -1 && title.indexOf('二维码') === -1) {
                var courseName = cleanCourseName(text);
                if (courseName) {
                    pushCurrent();
                    current = newItem(courseName, day, rowSec);
                }
                pendingCode = null;
            } else {
                if (!current && pendingCode) current = newItem(pendingCode, day, rowSec);
                pendingCode = null;
                if (current) {
                    if (title.indexOf('教师') !== -1 || title.indexOf('老师') !== -1) current.teacher = text;
                    else if (title.indexOf('周次') !== -1) current.time = text;
                    else if (title.indexOf('教室') !== -1) current.room = text;
                }
            }
        }
        pushCurrent();
    }

    // ---------- 开学日与周历（照 csuft） ----------

    // 8–12 月用学年起始年，1–7 月用结束年（第二学期的 2 月不能用起始年）
    function yearForMonth(code, month) {
        var pair = /^(\d{4})\s*-\s*(\d{4})/.exec(clean(code));
        if (!pair) return 0;
        var start = parseInt(pair[1], 10);
        var end = parseInt(pair[2], 10);
        if (end === start + 1) return month >= 8 ? start : end;
        return start;
    }

    function isoParts(year, month, day) {
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        var probe = new Date(year, month - 1, day);
        if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
        return year + '-' + pad2(month) + '-' + pad2(day);
    }

    function weekdayOf(isoDate) {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(clean(isoDate));
        if (!m) return -1;
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
    }

    // 第 1 周任意一个带月日的格子都能当锚点；格子是第 d 天（0 起，星期一为 0），就往回推 d 天
    function firstMondayFromCalendar(weeks, code) {
        for (var i = 0; i < weeks.length; i++) {
            if (!/^第\s*1\s*周$/.test(clean(weeks[i].label))) continue;
            var days = weeks[i].days || [];
            for (var d = 0; d < days.length && d < 7; d++) {
                var text = clean(days[d]);
                var full = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(text);
                var md = /(\d{1,2})\s*月\s*(\d{1,2})/.exec(text);
                if (!full && !md) continue;
                var year = full ? parseInt(full[1], 10) : yearForMonth(code, parseInt(md[1], 10));
                var month = full ? parseInt(full[2], 10) : parseInt(md[1], 10);
                var day = full ? parseInt(full[3], 10) : parseInt(md[2], 10);
                if (!year) return null;
                var anchor = new Date(year, month - 1, day - d);
                if (isNaN(anchor.getTime())) return null;
                return isoParts(anchor.getFullYear(), anchor.getMonth() + 1, anchor.getDate());
            }
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

    // 周历取不到时按学期号推算：第 1 学期取 9 月 1 日所在周的周一，第 2 学期取 2 月 20 日所在周的周一，
    // 第 3 学期（夏季小学期）取 7 月 1 日所在周的周一（学年的后一年），免得夏季学期推到前一年 9 月
    function fallbackStart(code) {
        var termNo = (/^\d{4}-\d{4}-(\d)$/.exec(clean(code)) || [])[1];
        var month = termNo === '2' ? 2 : (termNo === '3' ? 7 : 9);
        var date = termNo === '2' ? 20 : 1;
        var year = yearForMonth(code, month) || parseInt(String(data.now || '').slice(0, 4), 10);
        var day = mondayOf(isoParts(year, month, date));
        if (!day) throw new Error('无法推算开学日期，请重新导入');
        return { day: day, rule: month + ' 月 ' + date + ' 日所在周的周一' };
    }

    // ---------- 主流程 ----------

    var term = data.term || {};
    var termName = clean(term.name);
    if (!(termName.indexOf('学年') >= 0 || termName.indexOf('学期') >= 0)) {
        termName = termNameFromCode(term.code) || termName;
    }

    var calendarWeeksList = (data.calendar && data.calendar.weeks) || [];
    var calendarWeeks = calendarWeekCount(calendarWeeksList);
    var firstDay = firstMondayFromCalendar(calendarWeeksList, term.code || term.name);
    var firstDayNote = '';
    if (firstDay && weekdayOf(firstDay) !== 1) {
        var aligned = mondayOf(firstDay);
        firstDayNote = '教务的教学周历里第 1 周的星期一写的是 ' + firstDay +
            '（那天不是星期一），开学日期已按它所在那一周的周一（' + aligned + '）对齐，请在「学期管理」里核对';
        firstDay = aligned;
    }
    if (!firstDay) {
        var fb = fallbackStart(term.code);
        firstDay = fb.day;
        firstDayNote = '没取到教务的周历，开学日按 ' + fb.rule + '推算为 ' + firstDay + '，请在「学期管理」里核对';
    }

    var rows = data.rows || [];
    var dayOf = buildDayMap(rows);
    var found = [];
    for (var r = 0; r < rows.length; r++) {
        var tds = rows[r].tds || [];
        var rowSec = sectionsFromLabel(tds.length ? tds[0].text : '');
        var col = 0;
        for (var c = 0; c < tds.length; c++) {
            var divs = tds[c].divs || [];
            for (var d = 0; d < divs.length; d++) {
                if (divs[d].hidden) continue; // 教务渲染的隐藏副本与可见格重复，跳过
                var day = dayOf[col] !== undefined ? dayOf[col] : col + 1;
                if (day < 1 || day > 7) continue;
                parseCell(divs[d].pieces || [], day, rowSec, found);
            }
            col += spanOf(tds[c]);
        }
    }

    var extras = extraSlots();
    var available = SLOT_TIMES.length + extras.length;
    var maxWeek = 0;
    var maxPeriod = 0;
    var placed = [];
    for (var f = 0; f < found.length; f++) {
        var item = found[f];
        var weeks = weeksIn(item.time);
        if (!weeks.length) {
            noWeekBlocks++;
            noteDropped(item.name, '没认出周次');
            continue;
        }
        var period = periodOf(item.time, item.rowSec);
        if (!period) {
            noPeriodBlocks++;
            noteDropped(item.name, '没认出节次');
            continue;
        }
        if (period.end > available) {
            overPeriodBlocks++;
            noteDropped(item.name, '节次超出可补的范围');
            continue;
        }
        var roomText = dedupePosition(item.room);
        for (var wi = 0; wi < weeks.length; wi++) {
            if (weeks[wi] > maxWeek) maxWeek = weeks[wi];
        }
        if (period.end > maxPeriod) maxPeriod = period.end;
        var teacher = teacherOf(item.teacher);
        var location = blankRoom(roomText) ? null : roomText;
        placed.push({
            name: item.name,
            teacher: teacher,
            location: location,
            day: item.day,
            start: period.start,
            end: period.end,
            weeks: weeks,
            key: item.name + SEP + (teacher || '') + SEP + (location || '') + SEP + item.day + SEP + weekKey(weeks)
        });
    }

    // 同一门课、同一天、同一套周次，节次重叠或相接（起点不大于上一段终点加 1）合成一段
    placed.sort(function (a, b) {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return a.start - b.start;
    });
    var merged = [];
    for (var mi = 0; mi < placed.length; mi++) {
        var cur = placed[mi];
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
        var m = merged[gi];
        var gk = m.name + SEP + (m.teacher || '');
        if (groupAt[gk] === undefined) {
            groupAt[gk] = groups.length;
            groups.push({ name: m.name, teacher: m.teacher, note: null, blocks: [] });
        }
        var runs = runsOf(m.weeks);
        for (var rn = 0; rn < runs.length; rn++) {
            groups[groupAt[gk]].blocks.push({
                dayOfWeek: m.day,
                startPeriod: m.start,
                endPeriod: m.end,
                startWeek: runs[rn].start,
                endWeek: runs[rn].end,
                weekType: runs[rn].weekType,
                location: m.location
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

    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    var periodTimes = fixedSlots();
    for (var e = 0; e < extras.length && extras[e].periodIndex <= maxPeriod; e++) periodTimes.push(extras[e]);

    if (!termName) {
        termName = SCHOOL_NAME + '当前学期';
        pushWarning('没能识别出学年学期，学期名已用「' + termName + '」占位，请在「学期管理」里改名');
    }
    if (term.picked === 'first') {
        pushWarning('教务页面没有标出当前学期，已按列表第一项「' + clipText(termName, MAX_NAME_IN_WARNING) +
            '」导入，请核对；不对的话重新打开「课表查询」选中学期后再导入');
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
    if (maxPeriod > SLOT_TIMES.length) {
        var from = SLOT_TIMES.length + 1;
        var extraText = maxPeriod > from ? '第 ' + from + ' 至 ' + maxPeriod + ' 节' : '第 ' + maxPeriod + ' 节';
        pushWarning('课表里有' + extraText + '，节次时间里没有这几节，已临时补上（' +
            periodTimes[SLOT_TIMES.length].start + ' 起），请到「学期管理」里核对真实的上下课时间');
    }
    if (droppedWeeks > 0) {
        pushWarning('有 ' + droppedWeeks + ' 条周次超出 ' + MAX_WEEK + ' 周，这些周次没有导入');
    }
    if (noWeekBlocks || noPeriodBlocks || overPeriodBlocks) {
        var parts = [];
        if (noWeekBlocks) parts.push('没认出周次 ' + noWeekBlocks + ' 个');
        if (noPeriodBlocks) parts.push('没认出节次 ' + noPeriodBlocks + ' 个');
        if (overPeriodBlocks) parts.push('节次超出可补的范围 ' + overPeriodBlocks + ' 个');
        pushWarning('有 ' + (noWeekBlocks + noPeriodBlocks + overPeriodBlocks) +
            ' 个上课安排没能认出来，已跳过（' + parts.join('，') + '）。' + droppedText());
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
