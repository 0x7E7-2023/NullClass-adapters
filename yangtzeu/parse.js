(function () {
    // 长江大学 教务适配器（树维 EAMS，jwc3 主机）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 YANGTZEU/yu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Jursin）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4；yu.js 最后改动 80e30cf（2026-09-23）
    //
    // 输入是 extract.js 交出来的学期字段和课表原文。不碰页面、不发请求。
    //
    // 移植改动：
    //   1. 新语法改成 ES5；学期响应不进本文件，也不执行取回来的代码
    //   2. 不再弹窗选学期：用当前页选中的学期编号，对不上再按日期
    //   3. 周次位图：下标 i 为 1 且 i 至少为 1 时是第 i 周；第 0 位是占位，为 1 也不产出第 0 周
    //   4. 节次不是表格行号。上游把行号映射成作息节次：1→1、2→2、3→4、4→5、5→7、6→8、7→3、8→6
    //      （第 3 节是午间，第 6 节是晚间）。连堂按映射后的节次合并，重复行并进同一段
    //   5. 节次时间用上游写死的 8 节；课用到更晚的节次时逐节补，补不上的如实说明
    //   6. 开学日、总周数：优先用学期起止日期；推算值写进提醒。总周数不超过 30
    //   7. 教师写成名单拼接表达式时，回看前面的教师名单；还原不了就留空，不当成姓名
    //   8. 课名行尾的纯数字括号（课程序号）去掉。缺教师、缺教室照常导入并汇总提醒
    //
    // 分隔符用 String.fromCharCode(0) 在运行时拼，文件里不放字面的空字符。

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);

    var SEP = String.fromCharCode(0);
    var MAX_TOTAL_WEEKS = 30;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;
    var DEFAULT_UNIT_COUNT = 8;
    var FALLBACK_TOTAL_WEEKS = 20;
    var SCHOOL_NAME = '长江大学';
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;

    // 上游 yu.js getPresetTimeSlots，逐节照抄。第 6 节注释写明部分课是 18:00-18:45。
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '09:35' },
        { periodIndex: 2, start: '10:05', end: '11:40' },
        { periodIndex: 3, start: '12:00', end: '13:35' },
        { periodIndex: 4, start: '14:00', end: '15:35' },
        { periodIndex: 5, start: '16:05', end: '17:40' },
        { periodIndex: 6, start: '17:45', end: '18:30' },
        { periodIndex: 7, start: '19:00', end: '20:35' },
        { periodIndex: 8, start: '20:45', end: '22:20' }
    ];

    // 空课默认 12 节，只在本校 8 节表不够、且这一节的开始不早于上一节结束时才借用。
    var DEFAULT_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:55', end: '15:40' },
        { periodIndex: 7, start: '16:00', end: '16:45' },
        { periodIndex: 8, start: '16:55', end: '17:40' },
        { periodIndex: 9, start: '18:30', end: '19:15' },
        { periodIndex: 10, start: '19:25', end: '20:10' },
        { periodIndex: 11, start: '20:20', end: '21:05' },
        { periodIndex: 12, start: '21:15', end: '22:00' }
    ];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function trimStr(value) {
        return String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '');
    }

    function intOf(value) {
        if (value === null || value === undefined || value === '') return null;
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function clip(value, max) {
        var s = text(value);
        if (s.length <= max) return s;
        return s.substring(0, max);
    }

    function isoOfDate(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
    }

    function mondayOfYmd(year, month, day) {
        return isoOfDate(mondayOnOrBefore(year, month, day));
    }

    function isoOfAny(value) {
        var s = text(value);
        if (!s) return null;
        var m = /^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})/.exec(s);
        if (!m) m = /([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})/.exec(s);
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function isoInValue(value, depth) {
        if (depth > 3 || value === null || value === undefined) return null;
        if (typeof value === 'string') return isoOfAny(value);
        if (typeof value === 'number') {
            if (value > 100000000000 && value < 4000000000000) {
                var date = new Date(value);
                if (!isNaN(date.getTime())) return isoOfDate(date);
            }
            return null;
        }
        if (typeof value === 'object') {
            var keys = Object.keys(value);
            for (var i = 0; i < keys.length; i++) {
                var found = isoInValue(value[keys[i]], depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function academicTermName(iso) {
        var year = parseInt(iso.substring(0, 4), 10);
        var month = parseInt(iso.substring(5, 7), 10);
        if (month >= 9) return year + '-' + (year + 1) + '学年第一学期';
        if (month >= 2) return (year - 1) + '-' + year + '学年第二学期';
        return (year - 1) + '-' + year + '学年第一学期';
    }

    function timeOf(value) {
        var m = /^([01]?[0-9]|2[0-3]):([0-5][0-9])/.exec(text(value));
        if (!m) return null;
        return (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2];
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    function cmpStr(a, b) {
        if (a === b) return 0;
        return a < b ? -1 : 1;
    }

    function cmpNum(a, b) {
        return a === b ? 0 : (a < b ? -1 : 1);
    }

    function mapSection(section) {
        if (section === 1) return 1;
        if (section === 2) return 2;
        if (section === 3) return 4;
        if (section === 4) return 5;
        if (section === 5) return 7;
        if (section === 6) return 8;
        if (section === 7) return 3;
        if (section === 8) return 6;
        return section;
    }

    var root = (data && typeof data === 'object') ? data : {};
    var rawSemesters = (root.semesters instanceof Array) ? root.semesters : [];
    var courseHtml = typeof root.courseHtml === 'string' ? root.courseHtml : '';
    var todayIso = isoOfAny(root.today) || localTodayIso();

    var allWarnings = [];

    function warn(message) {
        var line = String(message);
        if (line.length > MAX_WARNING_CHARS) line = line.substring(0, MAX_WARNING_CHARS - 1) + '…';
        allWarnings.push(line);
    }

    var semesters = [];
    var badSemesters = 0;
    for (var si = 0; si < rawSemesters.length; si++) {
        var rawSem = rawSemesters[si];
        if (!rawSem || typeof rawSem !== 'object') { badSemesters++; continue; }
        var semId = text(rawSem.id);
        if (!semId) { badSemesters++; continue; }
        semesters.push({
            id: semId,
            schoolYear: text(rawSem.schoolYear),
            term: text(rawSem.term),
            startDate: isoOfAny(rawSem.startDate) || isoInValue(rawSem.startDate, 0),
            endDate: isoOfAny(rawSem.endDate) || isoInValue(rawSem.endDate, 0)
        });
    }
    if (badSemesters > 0) {
        warn('教务返回的学期列表里有 ' + badSemesters + ' 条没能读懂，已跳过，请反馈');
    }
    if (!semesters.length) {
        warn('教务没有给出可用的学期列表，学期名、开学日与总周数都只能推算，请逐项核对');
    }

    var CN_TERM = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五' };

    function semesterLabel(termRaw) {
        var t = text(termRaw);
        if (!t) return '';
        if (t.indexOf('学期') >= 0) return t;
        if (CN_TERM[t]) return '第' + CN_TERM[t] + '学期';
        return '第' + t + '学期';
    }

    function semesterNameOf(sem) {
        if (!sem) return '';
        var label = semesterLabel(sem.term);
        var year = text(sem.schoolYear);
        if (year && label) return year + '学年' + label;
        return label || (year ? year + '学年' : '');
    }

    function cmpSemesterAsc(a, b) {
        if (a.schoolYear !== b.schoolYear) return cmpStr(a.schoolYear, b.schoolYear);
        var x = intOf(a.id);
        var y = intOf(b.id);
        if (x === null) x = 0;
        if (y === null) y = 0;
        return cmpNum(x, y);
    }

    var currentSemesterId = text(root.currentSemesterId);

    function pickCurrentSemester() {
        if (!semesters.length) return null;
        var sorted = semesters.slice(0).sort(cmpSemesterAsc);
        var i;
        if (currentSemesterId) {
            for (i = 0; i < sorted.length; i++) {
                if (sorted[i].id === currentSemesterId) return sorted[i];
            }
        }
        for (i = 0; i < sorted.length; i++) {
            var sem = sorted[i];
            if (sem.startDate && sem.endDate && sem.startDate <= todayIso && todayIso <= sem.endDate) return sem;
        }
        var picked = sorted[0];
        for (i = 0; i < sorted.length; i++) {
            if (sorted[i].startDate && sorted[i].startDate <= todayIso) picked = sorted[i];
        }
        return picked;
    }

    var current = pickCurrentSemester();
    var termName = semesterNameOf(current);
    var termNameFromEdu = !!(current && current.schoolYear && current.term);
    if (!termName) {
        termName = SCHOOL_NAME + ' ' + academicTermName(todayIso);
        warn('学期名教务没有提供，已按导入日期推算为「' + clip(termName, 20) + '」，如与实际不符可在学期管理里改名');
    } else if (!termNameFromEdu) {
        warn('学期名只取到一半，已拼成「' + clip(termName, 20) + '」，如与实际不符可在学期管理里改名');
    }

    function weeksBetween(startIso, endIso) {
        if (!startIso || !endIso || endIso < startIso) return null;
        var start = new Date(startIso + 'T00:00:00Z').getTime();
        var end = new Date(endIso + 'T00:00:00Z').getTime();
        var days = Math.round((end - start) / 86400000) + 1;
        var weeks = Math.ceil(days / 7);
        if (!(weeks >= 1)) return null;
        return weeks;
    }

    function anchorFromTermInfo(schoolYear, termText) {
        var m = /([0-9]{4})/.exec(text(schoolYear));
        var year = m ? parseInt(m[1], 10) : null;
        var t = text(termText);
        var isFirst = t === '1' || t.indexOf('一') >= 0;
        var isSecond = t === '2' || t.indexOf('二') >= 0;
        if (year === null) return null;
        if (isFirst) return { year: year, month: 9, day: 1, rule: '学年里的第一学期按 9 月 1 日所在周的周一算' };
        if (isSecond) return { year: year + 1, month: 2, day: 20, rule: '学年里的第二学期按次年 2 月 20 日所在周的周一算' };
        return null;
    }

    function anchorFromToday() {
        var today = new Date(todayIso + 'T00:00:00Z');
        var year = today.getUTCFullYear();
        var month = today.getUTCMonth() + 1;
        if (month >= 9) return { year: year, month: 9, day: 1, rule: '9 月以后按当年 9 月 1 日所在周的周一算' };
        if (month >= 2) return { year: year, month: 2, day: 20, rule: '2 月到 8 月按当年 2 月 20 日所在周的周一算' };
        return { year: year - 1, month: 9, day: 1, rule: '1 月按上一年 9 月 1 日所在周的周一算' };
    }

    var firstDay = null;
    var semesterWeeks = null;
    if (current && current.startDate) {
        firstDay = mondayOfYmd(
            parseInt(current.startDate.substring(0, 4), 10),
            parseInt(current.startDate.substring(5, 7), 10),
            parseInt(current.startDate.substring(8, 10), 10)
        );
        semesterWeeks = weeksBetween(current.startDate, current.endDate);
    }
    if (!firstDay) {
        var anchor = null;
        if (current) anchor = anchorFromTermInfo(current.schoolYear, current.term);
        if (!anchor) anchor = anchorFromToday();
        firstDay = mondayOfYmd(anchor.year, anchor.month, anchor.day);
        warn('教务没有给出开学日期，第 1 周按「' + anchor.rule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日');
    } else {
        warn('开学日期取自教务的学期起止日期：第 1 周从 ' + firstDay + ' 开始，请在学期管理里核对');
    }

    var RE_UNIT_COUNT = /var\s+unitCount\s*=\s*([0-9]+)\s*;/;
    var unitCountMatch = RE_UNIT_COUNT.exec(courseHtml);
    var unitCount = unitCountMatch ? parseInt(unitCountMatch[1], 10) : DEFAULT_UNIT_COUNT;
    var unitCountGuessed = !unitCountMatch;
    if (!(unitCount >= 1) || unitCount > 30) {
        unitCount = DEFAULT_UNIT_COUNT;
        unitCountGuessed = true;
    }

    function readCall(source, openIndex) {
        var depth = 1;
        var quote = '';
        var i;
        var ch;
        for (i = openIndex; i < source.length; i++) {
            ch = source.charAt(i);
            if (quote) {
                if (ch === '\\') { i++; continue; }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '(') depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0) return { argsText: source.substring(openIndex, i), end: i + 1 };
            }
        }
        return null;
    }

    function splitJsArgs(argsText) {
        var args = [];
        var curr = '';
        var depth = 0;
        var quote = '';
        var i;
        var ch;
        for (i = 0; i < argsText.length; i++) {
            ch = argsText.charAt(i);
            if (quote) {
                curr += ch;
                if (ch === '\\') {
                    if (i + 1 < argsText.length) { curr += argsText.charAt(i + 1); i++; }
                    continue;
                }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; curr += ch; continue; }
            if (ch === '(' || ch === '[' || ch === '{') { depth++; curr += ch; continue; }
            if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; curr += ch; continue; }
            if (ch === ',' && depth === 0) { args.push(curr); curr = ''; continue; }
            curr += ch;
        }
        args.push(curr);
        return args;
    }

    function argAt(args, index) {
        if (index >= args.length) return '';
        return trimStr(args[index]);
    }

    function isQuoted(token) {
        var t = trimStr(token);
        if (t.length < 2) return false;
        var first = t.charAt(0);
        return (first === '"' || first === "'") && t.charAt(t.length - 1) === first;
    }

    function unquoteJsLiteral(token) {
        var t = trimStr(token);
        if (!t) return '';
        if (t === 'null' || t === 'undefined') return '';
        if (isQuoted(t)) return t.substring(1, t.length - 1);
        return t;
    }

    function cleanCourseName(name) {
        return text(name).replace(/\([0-9.]+\)\s*$/, '');
    }

    var RE_TEACHER_NAME = /name\s*:\s*(?:"([^"]*)"|'([^']*)')/g;

    function teachersBefore(fullText, blockIndex, teacherExpr) {
        var namesToTry = [];
        var varMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\.join/.exec(trimStr(teacherExpr));
        if (varMatch) namesToTry.push(varMatch[1]);
        var hasActTeachers = false;
        var ni;
        for (ni = 0; ni < namesToTry.length; ni++) {
            if (namesToTry[ni] === 'actTeachers') hasActTeachers = true;
        }
        if (!hasActTeachers) namesToTry.push('actTeachers');
        var start = Math.max(0, blockIndex - 2200);
        var segment = fullText.substring(start, blockIndex);
        var n;
        for (n = 0; n < namesToTry.length; n++) {
            var re = new RegExp('var\\s+' + namesToTry[n] + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;', 'g');
            var m;
            var last = null;
            while ((m = re.exec(segment)) !== null) last = m[1];
            if (!last) continue;
            var names = [];
            RE_TEACHER_NAME.lastIndex = 0;
            var nm;
            while ((nm = RE_TEACHER_NAME.exec(last)) !== null) {
                var name = text(nm[1] || nm[2] || '');
                if (!name) continue;
                var seen = false;
                for (var i = 0; i < names.length; i++) if (names[i] === name) seen = true;
                if (!seen) names.push(name);
            }
            if (names.length) return names.join(',');
        }
        return '';
    }

    function weeksFromBitmap(bitmap) {
        var s = text(bitmap);
        var weeks = [];
        if (!s) return { weeks: weeks, zeroBit: false, badChars: 0 };
        var i;
        for (i = 1; i < s.length; i++) {
            if (s.charAt(i) === '1') weeks.push(i);
        }
        var badChars = 0;
        for (i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            if (ch !== '0' && ch !== '1') badChars++;
        }
        return { weeks: weeks, zeroBit: s.charAt(0) === '1', badChars: badChars };
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

    var entries = [];
    var zeroBitBitmaps = 0;
    var badBitmapChars = 0;
    var indexFromLiteral = 0;
    var teacherFromExpr = 0;
    var badActivities = 0;
    var droppedWeeks = 0;

    var activityRe = /(^|[^A-Za-z0-9_])activity\s*=\s*new\s+TaskActivity\s*\(/g;
    var activities = [];
    var activityMatch;
    while ((activityMatch = activityRe.exec(courseHtml)) !== null) {
        var openAt = activityMatch.index + activityMatch[0].length;
        var call = readCall(courseHtml, openAt);
        if (!call) continue;
        activities.push({ argsText: call.argsText, end: call.end, start: activityMatch.index });
        activityRe.lastIndex = call.end;
    }

    var RE_INDEX_VAR = /index\s*=\s*([0-9]+)\s*\*\s*unitCount\s*\+\s*([0-9]+)/g;
    var RE_INDEX_LITERAL = /index\s*=\s*([0-9]+)\s*;/g;

    for (var ai = 0; ai < activities.length; ai++) {
        var activity = activities[ai];
        var args = splitJsArgs(activity.argsText);
        if (args.length < 7) { badActivities++; continue; }

        var teacherRaw = argAt(args, 1);
        var teacher = '';
        if (teacherRaw && /\.join\s*\(/.test(teacherRaw)) {
            var resolvedTeacher = teachersBefore(courseHtml, activity.start, unquoteJsLiteral(teacherRaw));
            if (resolvedTeacher) {
                teacher = resolvedTeacher;
                teacherFromExpr++;
            }
        } else if (isQuoted(teacherRaw)) {
            teacher = text(unquoteJsLiteral(teacherRaw));
        } else if (teacherRaw && teacherRaw !== 'null' && teacherRaw !== 'undefined') {
            var ident = unquoteJsLiteral(teacherRaw);
            if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(ident)) teacher = text(ident);
        }

        var name = cleanCourseName(unquoteJsLiteral(argAt(args, 3)));
        if (!name) { badActivities++; continue; }

        var locationRaw = argAt(args, 5);
        var location = '';
        if (isQuoted(locationRaw)) location = text(unquoteJsLiteral(locationRaw));
        else if (locationRaw && locationRaw !== 'null' && locationRaw !== 'undefined') {
            var locIdent = unquoteJsLiteral(locationRaw);
            if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(locIdent)) location = text(locIdent);
        }

        var bitmapResult = weeksFromBitmap(unquoteJsLiteral(argAt(args, 6)));
        if (bitmapResult.zeroBit) zeroBitBitmaps++;
        badBitmapChars += bitmapResult.badChars;
        var weeks = bitmapResult.weeks;
        if (!weeks.length) { badActivities++; continue; }

        var kept = [];
        var droppedHere = 0;
        for (var w = 0; w < weeks.length; w++) {
            if (weeks[w] > MAX_TOTAL_WEEKS) droppedHere++;
            else kept.push(weeks[w]);
        }
        droppedWeeks += droppedHere;
        weeks = kept;
        if (!weeks.length) { badActivities++; continue; }

        var scopeEnd = ai + 1 < activities.length ? activities[ai + 1].start : courseHtml.length;
        var scopeText = courseHtml.substring(activity.end, scopeEnd);
        var sections = [];
        var usedLiteral = false;
        RE_INDEX_VAR.lastIndex = 0;
        var indexMatch;
        while ((indexMatch = RE_INDEX_VAR.exec(scopeText)) !== null) {
            var rawDay = parseInt(indexMatch[1], 10);
            var rawSection = parseInt(indexMatch[2], 10);
            if (rawDay < 0 || rawDay > 6) continue;
            if (rawSection < 0 || rawSection >= unitCount) continue;
            sections.push({ day: rawDay + 1, section: mapSection(rawSection + 1) });
        }
        if (!sections.length) {
            RE_INDEX_LITERAL.lastIndex = 0;
            while ((indexMatch = RE_INDEX_LITERAL.exec(scopeText)) !== null) {
                var value = parseInt(indexMatch[1], 10);
                var literalDay = Math.floor(value / unitCount);
                var literalSection = value - literalDay * unitCount;
                if (literalDay < 0 || literalDay > 6) continue;
                if (literalSection < 0 || literalSection >= unitCount) continue;
                sections.push({ day: literalDay + 1, section: mapSection(literalSection + 1) });
                usedLiteral = true;
            }
            if (usedLiteral && sections.length) indexFromLiteral++;
        }
        if (!sections.length) { badActivities++; continue; }

        for (var s = 0; s < sections.length; s++) {
            var sec = sections[s].section;
            if (sec < 1 || sec > 16) continue;
            entries.push({
                name: name,
                teacher: teacher,
                location: location || null,
                day: sections[s].day,
                startSection: sec,
                endSection: sec,
                weeks: weeks,
                weeksKey: weeks.join(',')
            });
        }
    }

    if (!entries.length) {
        throw new Error('没能从课表数据里解析出任何课程：可能这个学期还没排课，或教务系统改了课表的返回格式。请先在教务页面里确认能看到课，再点「提取课表」');
    }

    entries.sort(function (a, b) {
        return cmpStr(a.name, b.name) || cmpStr(a.teacher, b.teacher) ||
            cmpStr(a.location === null ? '' : a.location, b.location === null ? '' : b.location) ||
            cmpNum(a.day, b.day) || cmpStr(a.weeksKey, b.weeksKey) ||
            cmpNum(a.startSection, b.startSection);
    });

    var merged = [];
    for (var e = 0; e < entries.length; e++) {
        var item = entries[e];
        var prev = merged.length ? merged[merged.length - 1] : null;
        var same = prev && prev.name === item.name && prev.teacher === item.teacher &&
            prev.location === item.location && prev.day === item.day && prev.weeksKey === item.weeksKey;
        if (same && item.startSection <= prev.endSection + 1) {
            if (item.endSection > prev.endSection) prev.endSection = item.endSection;
        } else {
            merged.push({
                name: item.name,
                teacher: item.teacher,
                location: item.location,
                day: item.day,
                startSection: item.startSection,
                endSection: item.endSection,
                weeksKey: item.weeksKey,
                weeks: item.weeks
            });
        }
    }

    var maxPeriod = 1;
    var maxWeek = 0;
    for (e = 0; e < merged.length; e++) {
        if (merged[e].endSection > maxPeriod) maxPeriod = merged[e].endSection;
        for (var k = 0; k < merged[e].weeks.length; k++) {
            if (merged[e].weeks[k] > maxWeek) maxWeek = merged[e].weeks[k];
        }
    }

    var totalWeeks = semesterWeeks ? semesterWeeks : FALLBACK_TOTAL_WEEKS;
    var raised = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raised = true;
    }
    var clamped = false;
    if (totalWeeks > MAX_TOTAL_WEEKS) {
        totalWeeks = MAX_TOTAL_WEEKS;
        clamped = true;
    }

    var courseOrder = [];
    var byCourse = {};
    for (e = 0; e < merged.length; e++) {
        var unit = merged[e];
        var weeksInRange = [];
        for (k = 0; k < unit.weeks.length; k++) {
            if (unit.weeks[k] <= totalWeeks) weeksInRange.push(unit.weeks[k]);
        }
        if (!weeksInRange.length) continue;
        var key = unit.name + SEP + unit.teacher;
        if (!byCourse[key]) {
            byCourse[key] = {
                name: unit.name,
                teacher: unit.teacher || null,
                blocks: [],
                missingLocation: false
            };
            courseOrder.push(key);
        }
        if (unit.location === null) byCourse[key].missingLocation = true;
        var runs = runsOf(weeksInRange);
        for (var r = 0; r < runs.length; r++) {
            byCourse[key].blocks.push({
                dayOfWeek: unit.day,
                startPeriod: unit.startSection,
                endPeriod: unit.endSection,
                startWeek: runs[r].start,
                endWeek: runs[r].end,
                weekType: runs[r].weekType,
                location: unit.location
            });
        }
    }

    if (!courseOrder.length) {
        throw new Error('课表里的课程周次都超出了学期总周数，没能生成任何课程：请反馈这条课表');
    }

    var courses = [];
    var noTeacherNames = [];
    var noLocationNames = [];
    for (e = 0; e < courseOrder.length; e++) {
        var course = byCourse[courseOrder[e]];
        course.blocks.sort(function (a, b) {
            return cmpNum(a.dayOfWeek, b.dayOfWeek) || cmpNum(a.startPeriod, b.startPeriod) ||
                cmpNum(a.endPeriod, b.endPeriod) || cmpNum(a.startWeek, b.startWeek) ||
                cmpNum(a.endWeek, b.endWeek) || cmpStr(a.weekType, b.weekType) ||
                cmpStr(a.location === null ? '' : a.location, b.location === null ? '' : b.location);
        });
        if (!course.teacher && noTeacherNames.indexOf(course.name) < 0) noTeacherNames.push(course.name);
        if (course.missingLocation && noLocationNames.indexOf(course.name) < 0) noLocationNames.push(course.name);
        courses.push({ name: course.name, teacher: course.teacher, note: null, blocks: course.blocks });
    }

    var periodTimes = [];
    for (var p = 0; p < PERIOD_TIMES.length; p++) {
        periodTimes.push({
            periodIndex: PERIOD_TIMES[p].periodIndex,
            start: PERIOD_TIMES[p].start,
            end: PERIOD_TIMES[p].end
        });
    }
    var bySequence = [];
    var fromDefault = [];
    var uncoveredFrom = 0;
    for (p = PERIOD_TIMES.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var builtinSlot = DEFAULT_PERIOD_TIMES[p - 1];
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: builtinSlot.start, end: builtinSlot.end });
            fromDefault.push(p);
        } else {
            var nextEnd = prevEnd + EXTEND_BREAK_MINUTES + EXTEND_CLASS_MINUTES;
            if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
            periodTimes.push({
                periodIndex: p,
                start: hhmmOf(prevEnd + EXTEND_BREAK_MINUTES),
                end: hhmmOf(nextEnd)
            });
            bySequence.push(p);
        }
    }

    function sampleNames(list) {
        var shown = [];
        var i;
        var limit = list.length < 3 ? list.length : 3;
        for (i = 0; i < limit; i++) shown.push(clip(list[i], 20));
        var line = shown.join('、');
        if (list.length > 3) line += '，另有 ' + (list.length - 3) + ' 门';
        return line;
    }

    warn('只导入了教务系统当前选中的学期（' + clip(termName, 20) + '）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」');

    if (semesterWeeks) {
        var weekExtra = '';
        if (raised) weekExtra += '，课表里有更晚的周次，已按 ' + totalWeeks + ' 周导入';
        if (clamped) weekExtra += '，已按最多 ' + MAX_TOTAL_WEEKS + ' 周导入';
        warn('学期总周数取自教务的学期起止日期（' + semesterWeeks + ' 周）' + weekExtra + '，如与实际不符可在学期管理里改');
    } else if (raised) {
        warn('教务没有给出学期总周数，课表里有第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
    } else {
        warn('教务没有给出学期总周数，先按 ' + totalWeeks + ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    }

    warn('节次时间用的是学校公布的 8 节（第 1 节 08:00-09:35，第 6 节 17:45-18:30；少数晚间课可能是 18:00-18:45），这次没有从教务读到节次时间，请在学期管理里核对');

    if (unitCountGuessed) {
        warn('课表页面里没读到一天有几节课，已按 ' + unitCount + ' 节解析，节次可能与实际差几节，请核对课表');
    }
    if (zeroBitBitmaps > 0) {
        warn('有 ' + zeroBitBitmaps + ' 条排课的周次从第 0 周写起，课表里没有第 0 周，已忽略这一位，请核对周次');
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_TOTAL_WEEKS + ' 周，已丢掉');
    }
    if (badBitmapChars > 0) {
        warn('周次里有 ' + badBitmapChars + ' 个认不出的符号，已按没课处理，请核对周次');
    }
    if (badActivities > 0) {
        warn('有 ' + badActivities + ' 条排课没能读懂（缺课名、星期、节次或周次），已跳过，如发现少课请反馈');
    }
    if (indexFromLiteral > 0) {
        warn('有 ' + indexFromLiteral + ' 条排课的节次是算好的序号，已按一天 ' + unitCount + ' 节反推星期和节次，请核对');
    }
    if (teacherFromExpr > 0) {
        warn('有 ' + teacherFromExpr + ' 条排课的教师没有直接写名字，已从旁边的教师名单里还原，请核对');
    }
    if (noTeacherNames.length) {
        warn('有 ' + noTeacherNames.length + ' 门课没有教师，已留空，可在编辑课程里补上，例如 ' + sampleNames(noTeacherNames));
    }
    if (noLocationNames.length) {
        warn('有 ' + noLocationNames.length + ' 门课没有教室，已留空，可在编辑课程里补上，例如 ' + sampleNames(noLocationNames));
    }
    if (fromDefault.length || bySequence.length) {
        var fillParts = [];
        if (fromDefault.length) fillParts.push('第 ' + fromDefault.join('、') + ' 节用学校公布的节次时间补上');
        if (bySequence.length) {
            var seqText = [];
            for (var bi = 0; bi < bySequence.length; bi++) {
                var slot = null;
                for (var pj = 0; pj < periodTimes.length; pj++) {
                    if (periodTimes[pj].periodIndex === bySequence[bi]) slot = periodTimes[pj];
                }
                if (slot) seqText.push('第 ' + slot.periodIndex + ' 节 ' + slot.start + '-' + slot.end);
            }
            fillParts.push(seqText.join('、') + '，按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        }
        warn('课表用到了节次时间里没有的节次，已补上：' + fillParts.join('；') + '，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，再往后补会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    var warnings = allWarnings;
    if (allWarnings.length > MAX_WARNINGS) {
        warnings = allWarnings.slice(0, MAX_WARNINGS - 1);
        warnings.push('另有 ' + (allWarnings.length - MAX_WARNINGS + 1) + ' 条说明因为超出上限没有显示，请把这份课表反馈给我们');
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
