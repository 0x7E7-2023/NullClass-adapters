(function () {
    // 沈阳建筑大学教务系统（树维 EAMS 平台，111.117.146.166/eams）适配器 —— 第二步：纯转换。
    //
    // 上游 shiguang_warehouse 没有本校适配，这是空课自己写的（2026-11-03，用真实账号抓包核对）。
    // 结构模板是已审计的同平台件 uestc（电子科技大学，树维 EAMS），在它的基础上改了下面几处：
    //   ① 教师：本校课表脚本里 TaskActivity 的教师参数是 actTeacherName.join(',')，名字在前面的
    //      actTeachers 数组里（循环 push 进去）。这里照页面脚本的逻辑就地读 actTeachers / teachers：
    //      「不在 teachers 名单里、且 lab 为 true」的算助教，从教师里剔掉；剔完没人时才用第一个助教的名字。
    //   ② 课程名末尾的课程代码「(A040399)」去掉；教室末尾的「(沈阳建筑大学)」去掉。
    //   ③ 节次时间用学校公布的 10 节作息（学校官方公众号新生指南，与学生课表截图逐节一致）；第 3、4 节
    //      在四、五层教室的晚 10 分钟，载荷表达不了按楼层分的时间，写进提醒。第 11 节起顺推并提醒。
    //   ④ 开学日：本校学期日历接口（/eams/base/calendar-info.action）对学生返回 403，改用教务首页的
    //      「2026第秋季学期 10 教学周」倒推（extract.js 只交这一行文字）；读不到或学期对不上时按季节推算并提醒。
    //   ⑤ 学期名：学期列表里是「schoolYear:"2026", name:"秋季"」（自然年 + 季节），拼成「2026年秋季学期」。
    //   ⑥ TaskActivity 第 11 个参数是实验项目名（如「氧化还原反应」），载荷没有逐次备注字段，不导入。
    //   ⑦ 缺教师 / 缺教室按课程汇总写进提醒（uestc 没有这一条）。
    //
    // 输入是 extract.js 交出来的原始数据，本文件不发任何请求、不读 DOM、不问用户 —— CI 用 Rhino 实跑。
    //
    // 以下沿用 uestc 的已审计口径（详见 uestc/parse.js 文件头）：周次位图 bitmap[i] 为 '1' 且 i >= 1 即第 i 周；
    // 参数表达式就地剥开、剥不开就留空并出声、绝不动态求值；index 两种写法都用正则读；
    // 课程按「课程名 + 教师」聚合、天 / 教室分组、相邻节次周次重合度 ≥ 30% 才合并。
    var data = JSON.parse(__ncInput);
    var html = data.courseHtml === null || data.courseHtml === undefined ? '' : String(data.courseHtml);
    var calendarHtml = data.calendarHtml === null || data.calendarHtml === undefined ? '' : String(data.calendarHtml);
    var semesterRaw = data.semesterRaw === null || data.semesterRaw === undefined ? '' : String(data.semesterRaw);
    var semesterId = text(data.semesterId);

    var DEFAULT_UNIT_COUNT = 12;
    var DEFAULT_TOTAL_WEEKS = 20;
    var MAX_TOTAL_WEEKS = 30;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var TERM_NAME_PREFIX = '沈阳建筑大学 ';
    var BITMAP_RE = /^[01]{20,54}$/;
    var COURSE_CODE_RE = /\s*\([A-Z]{1,3}\d+(?:\.[\w.]+)?\)\s*$/;
    var CAMPUS_SUFFIX_RE = /\s*[(（]沈阳建筑大学[)）]\s*$/;
    var SEMESTER_NAME_RE = /20\d{2}\s*[-—~至]\s*20\d{2}\s*学年\s*第?\s*[0-9一二三四五六七八九]{1,2}\s*学期/;

    // 沈阳建筑大学上课作息（学校官方公众号「沈阳建筑大学」新生指南公布，2026 年学生课表截图逐节核对一致）。
    // 第 3、4 节按一、二、三层教室的时间；四、五层晚 10 分钟（10:10-10:55、11:10-11:55），见提醒。
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '09:00', end: '09:45' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '11:00', end: '11:45' },
        { periodIndex: 5, start: '13:30', end: '14:15' },
        { periodIndex: 6, start: '14:30', end: '15:15' },
        { periodIndex: 7, start: '15:30', end: '16:15' },
        { periodIndex: 8, start: '16:30', end: '17:15' },
        { periodIndex: 9, start: '18:30', end: '19:15' },
        { periodIndex: 10, start: '19:30', end: '20:15' }
    ];
    // 第 11 节起学校没公布：沿用本校课间 15 分钟、每节 45 分钟顺推（统一修订 H3）
    var EXTRA_BREAK_MINUTES = 15;
    var CLASS_MINUTES = 45;

    var warnings = [];

    function warn(message) {
        if (warnings.length >= MAX_WARNINGS) return;
        var line = String(message);
        if (warnings.indexOf(line) >= 0) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        warnings.push(line);
    }

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function tidy(value) {
        return text(value).replace(/\s+/g, ' ').trim();
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function parseIso(value) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
        if (!m) return null;
        var year = intOf(m[1]);
        var month = intOf(m[2]);
        var day = intOf(m[3]);
        if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
        return new Date(year, month - 1, day);
    }

    function shiftDays(date, days) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
    }

    // 每周起始日 = 周一（firstDayOfWeek 的缺省值），所以第 1 周的日期回退到那一周的周一
    // （移植手册 §4.3：别把学期开始日直接当 firstDay 用）
    function mondayIso(date) {
        return isoOf(shiftDays(date, -((date.getDay() + 6) % 7)));
    }

    function numbersOf(values, max, unit) {
        var head = [];
        for (var i = 0; i < values.length && i < max; i++) head.push(values[i]);
        if (values.length > head.length) return head.join('、') + ' 等 ' + values.length + ' ' + unit;
        return head.join('、') + (unit ? ' ' + unit : '');
    }

    function isArrayValue(value) {
        return !!value && typeof value === 'object' && typeof value.length === 'number' &&
            typeof value.push === 'function';
    }

    // ── 周次 ──────────────────────────────────────────────────────────────────

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

    // 本批统一口径：bitmap[i] === '1' 且 i >= 1 → 第 i 周；下标 0 是占位符（为 '1' 也不产出第 0 周）
    function weeksFromBitmap(bits) {
        var out = [];
        var length = bits.length > 54 ? 54 : bits.length;
        var zeroBit = bits.charAt(0) === '1';
        for (var i = 1; i < length; i++) {
            if (bits.charAt(i) === '1') out.push(i);
        }
        return { weeks: out, zeroBit: zeroBit };
    }

    function pushWeek(out, week, type) {
        if (!(week >= 1)) return;
        if (type === 'ODD' && week % 2 === 0) return;
        if (type === 'EVEN' && week % 2 === 1) return;
        out.push(week);
    }

    // 中文周次描述："连1-16" / "单3-17" / "双2-8" / "1-3,5-9周" / "3、5、7周"。
    // **单 / 双 优先于连续区间**（见文件头 ④：上游那段正则的先后顺序会让单双周失效）。
    function weeksFromChinese(source) {
        var cleaned = tidy(source).replace(/第/g, '').replace(/周/g, '');
        var parts = cleaned.split(/[,，、;；]/);
        var weeks = [];
        for (var i = 0; i < parts.length; i++) {
            var part = tidy(parts[i]);
            if (!part) continue;
            var type = /双/.test(part) ? 'EVEN' : (/单/.test(part) ? 'ODD' : 'ALL');
            var range = /(\d{1,2})\s*[-—–−－~～至到]\s*(\d{1,2})/.exec(part);
            if (range) {
                var start = parseInt(range[1], 10);
                var end = parseInt(range[2], 10);
                if (start > end) {
                    var swap = start;
                    start = end;
                    end = swap;
                }
                for (var w = start; w <= end; w++) pushWeek(weeks, w, type);
                continue;
            }
            var numbers = part.match(/\d{1,2}/g);
            if (!numbers) continue;
            for (var n = 0; n < numbers.length; n++) pushWeek(weeks, parseInt(numbers[n], 10), type);
        }
        return uniqueSorted(weeks);
    }

    // args[6]：位图还是中文描述，由内容决定（上游 /^[01]{20,54}$/ 这道门）
    function weeksOf(raw) {
        var value = tidy(raw);
        if (!value) return { weeks: [], mode: 'empty' };
        if (BITMAP_RE.test(value)) {
            var parsed = weeksFromBitmap(value);
            return { weeks: parsed.weeks, mode: 'bitmap', zeroBit: parsed.zeroBit };
        }
        return { weeks: weeksFromChinese(value), mode: 'chinese' };
    }

    // 周次集合 → 极大段（连续段 ALL，隔周段 ODD / EVEN，落单一周 ALL）
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j] };
            if (run.start === run.end || step === 1) {
                run.weekType = 'ALL';
            } else {
                run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            }
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // ── HTML 里那段内嵌 JS 的解析 ──────────────────────────────────────────────

    function matchPair(source, openIndex, openChar, closeChar) {
        var depth = 0;
        var quote = '';
        for (var i = openIndex; i < source.length; i++) {
            var ch = source.charAt(i);
            if (quote) {
                if (ch === '\\') { i++; continue; }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === openChar) depth++;
            else if (ch === closeChar) {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function unescapeChar(ch) {
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        if (ch === 'r') return '\r';
        if (ch === 'b') return '\b';
        if (ch === 'f') return '\f';
        if (ch === '') return '';
        return ch;
    }

    function splitArgs(raw) {
        var args = [];
        var current = '';
        var quote = '';
        var depth = 0;
        for (var i = 0; i < raw.length; i++) {
            var ch = raw.charAt(i);
            if (quote) {
                current += ch;
                if (ch === '\\') {
                    if (i + 1 < raw.length) { current += raw.charAt(i + 1); i++; }
                    continue;
                }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
            if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
            if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue; }
            if (ch === ',' && depth === 0) { args.push(current); current = ''; continue; }
            current += ch;
        }
        if (tidy(current) !== '' || args.length === 0) args.push(current);
        return args;
    }

    // 从 from 处读一个字符串字面量 / 数组字面量（new Array(...) 也算）
    function readValueAt(source, from) {
        var i = from;
        while (i < source.length && /\s/.test(source.charAt(i))) i++;
        var ch = source.charAt(i);
        if (ch === '"' || ch === "'") {
            var out = '';
            i++;
            while (i < source.length) {
                var c = source.charAt(i);
                if (c === '\\') {
                    if (i + 1 >= source.length) break;
                    out += unescapeChar(source.charAt(i + 1));
                    i += 2;
                    continue;
                }
                if (c === ch) return { kind: 'string', value: out, end: i + 1 };
                out += c;
                i++;
            }
            return null;
        }
        if (ch === '[') {
            var close = matchPair(source, i, '[', ']');
            if (close < 0) return null;
            return { kind: 'array', body: source.substring(i + 1, close), end: close + 1 };
        }
        var head = /^new\s+Array\s*\(/.exec(source.substring(i, i + 16));
        if (head) {
            var end = matchPair(source, i + head[0].length - 1, '(', ')');
            if (end < 0) return null;
            return { kind: 'array', body: source.substring(i + head[0].length, end), end: end + 1 };
        }
        return null;
    }

    // 数组字面量里的名字：["张三","李四"] 或 [{name:"张三",...}] 两种写法都认
    function namesFromArrayBody(body) {
        var elements = splitArgs(body);
        var names = [];
        for (var i = 0; i < elements.length; i++) {
            var element = tidy(elements[i]);
            if (!element) continue;
            var literal = readValueAt(element, 0);
            if (literal && literal.kind === 'string' && tidy(element.substring(literal.end)) === '') {
                if (literal.value) names.push(literal.value);
                continue;
            }
            var re = /name\s*:\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
            var m;
            while ((m = re.exec(element)) !== null) {
                var inner = readValueAt(m[1], 0);
                if (inner && inner.kind === 'string' && inner.value) names.push(inner.value);
            }
        }
        return names;
    }

    // 就近取变量最后一次赋值（在 pos 之前）。只认字符串与数组两种形态。
    function varAt(source, name, pos) {
        var re = new RegExp('(?:\\bvar\\s+)?\\b' + name + '\\s*=\\s*', 'g');
        var best = null;
        var m;
        while ((m = re.exec(source)) !== null) {
            if (pos >= 0 && m.index >= pos) break;
            var value = readValueAt(source, re.lastIndex);
            if (value) {
                best = value;
                re.lastIndex = value.end;
            } else if (re.lastIndex <= m.index) {
                re.lastIndex = m.index + 1;
            }
        }
        return best;
    }

    function piecesOfConcat(raw) {
        var s = tidy(raw);
        if (s.indexOf('+') < 0) return null;
        var re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\+|[A-Za-z_$][\w$]*|\s+)/g;
        var pieces = [];
        var consumed = 0;
        var m;
        while ((m = re.exec(s)) !== null) {
            if (m.index !== consumed) return null;
            consumed = m.index + m[0].length;
            var token = m[0];
            if (token === '+' || /^\s+$/.test(token)) continue;
            if (token.charAt(0) === '"' || token.charAt(0) === "'") {
                var literal = readValueAt(token, 0);
                if (!literal || literal.kind !== 'string') return null;
                pieces.push({ kind: 'string', value: literal.value });
            } else {
                pieces.push({ name: token });
            }
        }
        if (consumed !== s.length || !pieces.length) return null;
        return pieces;
    }

    // 一个参数实参 → 字符串。剥不开的表达式返回 resolved:false（调用方必须出声，不许把表达式原文当值）
    function resolveArg(raw, source, pos) {
        var token = tidy(raw);
        if (!token || token === 'null' || token === 'undefined') return { value: '', resolved: true };
        var literal = readValueAt(token, 0);
        if (literal && literal.kind === 'string' && tidy(token.substring(literal.end)) === '') {
            return { value: literal.value, resolved: true };
        }
        if (literal && literal.kind === 'array' && tidy(token.substring(literal.end)) === '') {
            var inline = namesFromArrayBody(literal.body);
            return inline.length ? { value: inline.join(','), resolved: true } : { value: '', resolved: false };
        }
        // xxx.join(",") / actTeachers.map(...).join(",")：只看最前面那个标识符
        var member = /^([A-Za-z_$][\w$]*)\s*\./.exec(token);
        if (member) {
            var scoped = varAt(source, member[1], pos);
            if (scoped && scoped.kind === 'string') return { value: scoped.value, resolved: true };
            if (scoped && scoped.kind === 'array') {
                var listed = namesFromArrayBody(scoped.body);
                if (listed.length) return { value: listed.join(','), resolved: true };
            }
            return { value: '', resolved: false };
        }
        var bare = /^[A-Za-z_$][\w$]*$/.exec(token);
        if (bare) {
            var value = varAt(source, bare[0], pos);
            if (value && value.kind === 'string') return { value: value.value, resolved: true };
            if (value && value.kind === 'array') {
                var names = namesFromArrayBody(value.body);
                if (names.length) return { value: names.join(','), resolved: true };
            }
            return { value: '', resolved: false };
        }
        var pieces = piecesOfConcat(token);
        if (pieces) {
            var out = '';
            for (var i = 0; i < pieces.length; i++) {
                var piece = pieces[i];
                if (piece.kind === 'string') { out += piece.value; continue; }
                var resolvedValue = varAt(source, piece.name, pos);
                if (resolvedValue && resolvedValue.kind === 'string') { out += resolvedValue.value; continue; }
                if (resolvedValue && resolvedValue.kind === 'array') {
                    out += namesFromArrayBody(resolvedValue.body).join(',');
                    continue;
                }
                return { value: '', resolved: false };
            }
            return { value: out, resolved: true };
        }
        return { value: '', resolved: false };
    }

    // 课程名末尾的课程代码："大学物理Ⅱ(D1200440.18)" → "大学物理Ⅱ"（上游 cleanCourseName 同款；
    // 只删半角括号里的代码，全角括号的课名如「高等数学（二）」留着）
    function cleanCourseName(name) {
        return tidy(name).replace(COURSE_CODE_RE, '');
    }

    // 教室末尾的「(沈阳建筑大学)」是校区名，不是教室的一部分
    function cleanRoom(room) {
        return tidy(room).replace(CAMPUS_SUFFIX_RE, '');
    }

    // 数组字面量 [{id:17601,name:"某某",lab:true}, ...] → [{id, name, lab}]；不是数组返回 null
    function teacherObjectsOf(value) {
        if (!value || value.kind !== 'array') return null;
        var out = [];
        var elements = splitArgs(value.body);
        for (var i = 0; i < elements.length; i++) {
            var element = tidy(elements[i]);
            if (!element) continue;
            // 教师名里不会有转义字符，直接取引号里的内容
            var nameMatch = /(?:^|[{,\s])name\s*:\s*(?:"([^"]*)"|'([^']*)')/.exec(element);
            if (!nameMatch) continue;
            var name = tidy(nameMatch[1] || nameMatch[2] || '');
            if (!name) continue;
            var idMatch = /(?:^|[{,\s])id\s*:\s*["']?([\w-]+)["']?/.exec(element);
            var labMatch = /(?:^|[{,\s])lab\s*:\s*(true|false)/.exec(element);
            out.push({ id: idMatch ? idMatch[1] : '', name: name, lab: labMatch ? labMatch[1] === 'true' : false });
        }
        return out;
    }

    // 本校教师参数 actTeacherName.join(',')：照页面脚本，助教 = actTeachers 里「不在 teachers 名单
    // （id、name、lab 都相同）且 lab 为 true」的人，从教师里剔掉；剔完一个不剩才用第一个助教的名字。
    function sjzuTeachersAt(source, pos) {
        var acts = teacherObjectsOf(varAt(source, 'actTeachers', pos));
        if (acts === null) return { value: '', resolved: false };
        var listed = teacherObjectsOf(varAt(source, 'teachers', pos)) || [];
        var names = [];
        var assistant = '';
        for (var i = 0; i < acts.length; i++) {
            var inList = false;
            for (var j = 0; j < listed.length; j++) {
                if (listed[j].id === acts[i].id && listed[j].name === acts[i].name && listed[j].lab === acts[i].lab) {
                    inList = true;
                    break;
                }
            }
            if (!inList && acts[i].lab) {
                if (!assistant) assistant = acts[i].name;
                continue;
            }
            if (names.indexOf(acts[i].name) < 0) names.push(acts[i].name);
        }
        if (!names.length && assistant) names.push(assistant);
        return { value: names.join(','), resolved: true };
    }

    function unitCountOf(source) {
        var m = /\bvar\s+unitCount\s*=\s*(\d{1,3})\s*;/.exec(source);
        if (!m) m = /\bunitCount\s*=\s*(\d{1,3})\s*[;,]/.exec(source);
        var count = m ? intOf(m[1]) : null;
        if (count === null || count < 1 || count > 30) return null;
        return count;
    }

    function activityEntries(source) {
        var re = /new\s+TaskActivity\s*\(/g;
        var out = [];
        var m;
        while ((m = re.exec(source)) !== null) {
            var open = re.lastIndex - 1;
            var close = matchPair(source, open, '(', ')');
            if (close < 0) break;
            out.push({ start: m.index, end: close + 1, content: source.substring(open + 1, close) });
            re.lastIndex = close + 1;
        }
        return out;
    }

    function inSpans(spans, at) {
        for (var i = 0; i < spans.length; i++) {
            if (at >= spans[i][0] && at < spans[i][1]) return true;
        }
        return false;
    }

    // 一段内嵌 JS 里所有的 index 赋值 → {day, period}（day / period 都是 1 起）
    function indexesIn(segment, unitCount) {
        var found = [];
        var spans = [];
        var m;
        var re = /index\s*=\s*(\d{1,3})\s*\*\s*unitCount\s*\+\s*(\d{1,3})\s*;/g;
        while ((m = re.exec(segment)) !== null) {
            var day = parseInt(m[1], 10);
            var period = parseInt(m[2], 10);
            spans.push([m.index, m.index + m[0].length]);
            found.push({ day: day + 1, period: period + 1, at: m.index });
        }
        // 已经算好的线性下标（"index = 62;"）—— 同样用正则解析，不许 eval
        var rePlain = /index\s*=\s*(\d{1,5})\s*;/g;
        while ((m = rePlain.exec(segment)) !== null) {
            if (inSpans(spans, m.index)) continue;
            var linear = parseInt(m[1], 10);
            found.push({
                day: Math.floor(linear / unitCount) + 1,
                period: (linear % unitCount) + 1,
                at: m.index
            });
        }
        found.sort(function (a, b) { return a.at - b.at; });
        return found;
    }

    // ── 学期日历 / 学期列表 ───────────────────────────────────────────────────

    // 学期日历（/eams/base/calendar-info.action）：页面里写着
    // 「开始/结束日期：2026-09-07~2027-01-10(20)」—— 20 是总周数
    function parseCalendar(source) {
        var body = String(source || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;|&#160;/gi, ' ')
        var m = /(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*[~～—–-]\s*(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})\s*\(\s*(\d{1,2})\s*\)/.exec(body);
        if (!m) return null;
        var start = parseIso(intOf(m[1]) + '-' + pad2(intOf(m[2])) + '-' + pad2(intOf(m[3])));
        var end = parseIso(intOf(m[4]) + '-' + pad2(intOf(m[5])) + '-' + pad2(intOf(m[6])));
        var weeks = intOf(m[7]);
        if (!start || !end || end < start) return null;
        if (weeks === null || weeks < 1 || weeks > MAX_TOTAL_WEEKS) return null;
        return { start: isoOf(start), end: isoOf(end), weeks: weeks };
    }

    function pushSemester(out, entry) {
        if (!entry || typeof entry !== 'object') return;
        var id = entry.id === null || entry.id === undefined ? '' : String(entry.id).replace(/\s+/g, '');
        if (!/^\d+$/.test(id)) return;
        out.push({
            id: id,
            schoolYear: tidy(entry.schoolYear),
            name: tidy(entry.name)
        });
    }

    // 学期列表原文是**内嵌在页面里的 JS 对象字面量**（键没引号），不是 JSON —— 上游 7 个脚本
    // 用 Function("return (...)") 求值（属于动态执行远程代码，本批明令不抄），DLMU 用正则。
    // 这里先试 JSON.parse，失败再按对象字面量逐段正则取字段（两处都不执行远程代码）。
    function semestersFromRaw(raw) {
        var out = [];
        if (!raw) return out;
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        if (parsed && typeof parsed === 'object' && parsed.semesters && typeof parsed.semesters === 'object') {
            for (var key in parsed.semesters) {
                if (!Object.prototype.hasOwnProperty.call(parsed.semesters, key)) continue;
                var list = parsed.semesters[key];
                if (!isArrayValue(list)) continue;
                for (var i = 0; i < list.length; i++) pushSemester(out, list[i]);
            }
            return out;
        }
        var re = /\{[^{}]*\}/g;
        var m;
        while ((m = re.exec(raw)) !== null) {
            var body = m[0];
            var id = /\bid\s*:\s*["']?(\d+)["']?/.exec(body);
            if (!id) continue;
            var year = /schoolYear\s*:\s*["']([^"']*)["']/.exec(body);
            var name = /(?:^|[{,\s])name\s*:\s*["']([^"']*)["']/.exec(body);
            pushSemester(out, {
                id: id[1],
                schoolYear: year ? year[1] : '',
                name: name ? name[1] : ''
            });
        }
        return out;
    }

    function semesterIdFromRaw(raw) {
        var m = /\bsemesterId\s*:\s*["']?(\d+)["']?/.exec(String(raw || ''));
        return m ? m[1] : '';
    }

    function termLabelOf(value) {
        var s = tidy(value);
        if (!s) return '';
        if (/^第.*学期$/.test(s)) return s;
        if (/^\d{1,2}$/.test(s)) {
            var map = { '1': '第一学期', '2': '第二学期', '3': '第三学期', '4': '第四学期' };
            return map[s] || ('第' + s + '学期');
        }
        if (/^[一二三四五六七八九]{1,2}$/.test(s)) return '第' + s + '学期';
        return s;
    }

    // 学期名：① 教务页面上学期组件的文字（教务自己写的最准）② 学期列表原文里对应的那一条
    // ③ 都没有才按导入日期推算（并写进 warnings）。**不用适配器名当学期名。**
    function termNameOf() {
        var list = semestersFromRaw(semesterRaw);
        var id = semesterId || semesterIdFromRaw(semesterRaw);
        var picked = null;
        for (var i = 0; i < list.length; i++) {
            if (id && list[i].id === id) { picked = list[i]; break; }
        }
        // 学期列表里查得到「自然年 + 季节」就始终带上：开学日要拿它核对首页教学周属于哪个学期（不管学期名取自哪里）
        var season = picked && picked.schoolYear && /^(春季|夏季|秋季|冬季)$/.test(picked.name) ? picked.name : '';
        var schoolYear = season ? picked.schoolYear : '';
        var onPage = tidy(data.semesterLabel);
        if (onPage && SEMESTER_NAME_RE.test(onPage)) {
            return { name: tidy(SEMESTER_NAME_RE.exec(onPage)[0]), source: 'page', schoolYear: schoolYear, season: season };
        }
        if (season) {
            return { name: schoolYear + '年' + season + '学期', source: 'semesters', schoolYear: schoolYear, season: season };
        }
        if (picked) {
            var label = termLabelOf(picked.name);
            var joined = tidy(picked.schoolYear + '学年' + label);
            if (picked.schoolYear && label) return { name: joined, source: 'semesters' };
        }
        return { name: '', source: 'none' };
    }

    function guessedTermName(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        if (month >= 8) return year + '年秋季学期';
        if (month === 1) return (year - 1) + '年秋季学期';
        return year + '年春季学期';
    }

    // 教务首页那一行「2026第秋季学期 10 教学周」：取数当天是第几教学周。
    // 学期（年份 + 季节）和导入的学期对不上时不用它（学生可能在课表页切到了别的学期）。
    function teachWeekOf(raw, term) {
        var m = /(\d{4})\s*年?\s*第?\s*(春季|夏季|秋季|冬季)\s*学期\s*(\d{1,2})\s*教学周/.exec(tidy(raw));
        if (!m) return null;
        var week = intOf(m[3]);
        if (!(week >= 1 && week <= MAX_TOTAL_WEEKS)) return null;
        // 核对不了导入的是哪个学期时（学期列表没取到）照用首页教学周：课表页默认选中的就是当前学期
        if (!term || !term.schoolYear || !term.season) return { week: week, schoolYear: m[1], season: m[2] };
        if (m[1] !== term.schoolYear || m[2] !== term.season) return { other: m[1] + '年' + m[2] + '学期' };
        return { week: week };
    }

    // 读不到教学周时按季节推算：秋季取 9 月 1 日所在周的周一，春季取 3 月 1 日所在周的周一
    function seasonStartOf(term) {
        var year = term ? intOf(term.schoolYear) : null;
        if (!(year >= 2000 && year <= 2100)) return null;
        if (term.season === '秋季') return { iso: mondayIso(new Date(year, 8, 1)), rule: year + ' 年 9 月 1 日所在周的周一' };
        if (term.season === '春季') return { iso: mondayIso(new Date(year, 2, 1)), rule: year + ' 年 3 月 1 日所在周的周一' };
        return null;
    }

    // ── 课表解析 ──────────────────────────────────────────────────────────────

    if (!html) {
        throw new Error('教务系统没有返回课表数据：请确认已登录并打开「我的课表」，再点「提取课表」');
    }
    if (html.indexOf('TaskActivity') < 0) {
        throw new Error(
            '教务系统返回的课表里没有课程数据（响应里没有 TaskActivity）：' +
            '登录状态可能已失效，请重新登录并打开「我的课表」后再点「提取课表」'
        );
    }

    var unitCount = unitCountOf(html);
    if (unitCount === null) {
        unitCount = DEFAULT_UNIT_COUNT;
        warn('课表页里没有读到节次数（var unitCount），已按 ' + DEFAULT_UNIT_COUNT + ' 节计算 —— 节次数是猜的，请在导入预览里核对节次');
    }

    var entries = activityEntries(html);
    var records = [];
    var unreadableShape = 0;
    var unreadableName = 0;
    var unreadableTeacher = 0;
    var unreadableRoom = 0;
    var unreadableWeeks = 0;
    var noIndex = 0;
    var suspended = 0;
    var periodOutOfRange = 0;
    var zeroBitSeen = false;
    var chineseSeen = false;
    var emptyWeeks = 0;

    for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        var args = splitArgs(entry.content);
        if (args.length < 7) {
            unreadableShape++;
            continue;
        }
        var nameArg = resolveArg(args[3], html, entry.start);
        var courseName = cleanCourseName(nameArg.value);
        if (!courseName) {
            if (!nameArg.resolved) unreadableName++; else unreadableShape++;
            continue;
        }
        var teacherArg = /^actTeacherName\s*\.\s*join\s*\(/.test(tidy(args[1]))
            ? sjzuTeachersAt(html, entry.start)
            : resolveArg(args[1], html, entry.start);
        if (!teacherArg.resolved) unreadableTeacher++;
        var roomArg = resolveArg(args[5], html, entry.start);
        if (!roomArg.resolved) unreadableRoom++;
        var weeksArg = resolveArg(args[6], html, entry.start);
        var weeks = [];
        if (weeksArg.resolved) {
            var parsedWeeks = weeksOf(weeksArg.value);
            weeks = parsedWeeks.weeks;
            if (parsedWeeks.mode === 'bitmap' && parsedWeeks.zeroBit) zeroBitSeen = true;
            if (parsedWeeks.mode === 'chinese') chineseSeen = true;
        } else {
            unreadableWeeks++;
            continue;
        }
        if (!weeks.length) {
            emptyWeeks++;
            continue;
        }
        var room = cleanRoom(roomArg.value);
        // 「停课」是教务用来标临时停课的一格：上游把它从正常记录里排除，这里同样跳过并计数
        if (room === '停课') {
            suspended++;
            continue;
        }
        var segmentEnd = e + 1 < entries.length ? entries[e + 1].start : html.length;
        var segment = html.substring(entry.end, segmentEnd);
        var marshal = segment.search(/table\d+\s*\.\s*marshalTable/);
        if (marshal >= 0) segment = segment.substring(0, marshal);
        var indexes = indexesIn(segment, unitCount);
        if (!indexes.length) {
            noIndex++;
            continue;
        }
        for (var k = 0; k < indexes.length; k++) {
            var spot = indexes[k];
            if (!(spot.day >= 1 && spot.day <= 7) || !(spot.period >= 1 && spot.period <= unitCount)) {
                periodOutOfRange++;
                continue;
            }
            records.push({
                name: courseName,
                teacher: teacherArg.resolved ? tidy(teacherArg.value) : '',
                room: room,
                day: spot.day,
                period: spot.period,
                weeks: weeks
            });
        }
    }

    if (periodOutOfRange) {
        warn('有 ' + periodOutOfRange + ' 个节次落在 1-' + unitCount + ' 节之外（或星期超出 1-7），已跳过，请核对课表');
    }
    if (suspended) {
        warn('有 ' + suspended + ' 门课标记为「停课」，已跳过（教务用它表示临时停课）');
    }
    if (noIndex) {
        warn('有 ' + noIndex + ' 条课程记录没有对应的节次（index 赋值），已跳过，请核对课表');
    }
    if (emptyWeeks) {
        warn('有 ' + emptyWeeks + ' 条课程记录的周次解析结果为空（位图全是 0 或描述认不出），已跳过，请核对课表');
    }
    if (unreadableWeeks) {
        warn('有 ' + unreadableWeeks + ' 条课程记录的周次写成了脚本表达式，没能解析出来，已跳过，请反馈');
    }
    if (unreadableName) {
        warn('有 ' + unreadableName + ' 条课程记录的课程名写成了脚本表达式，没能解析出来，已跳过，请反馈');
    }
    if (unreadableTeacher) {
        warn('有 ' + unreadableTeacher + ' 条课程记录的教师写成了脚本表达式，没能解析出来，教师已留空，请核对');
    }
    if (unreadableRoom) {
        warn('有 ' + unreadableRoom + ' 条课程记录的教室写成了脚本表达式，没能解析出来，教室已留空，请核对');
    }
    if (unreadableShape) {
        warn('有 ' + unreadableShape + ' 条 TaskActivity 的参数个数不足 7，没能解析，已跳过，请反馈');
    }
    if (zeroBitSeen) {
        warn('周次位图第 0 位为 1，与同族约定的占位符不符，已按忽略处理（不产出「第 0 周」），请在导入预览里核对周次');
    }
    if (chineseSeen) {
        warn('有课程记录的周次是中文描述（如「连1-16」「单3-17」）而不是位图，已按单/双周与区间解析；上游脚本的同一段代码会丢掉单双标记，请重点核对周次');
    }

    if (!records.length) {
        throw new Error(
            '本学期没有解析到任何课程：' +
            'TaskActivity ' + entries.length + ' 条 / 可用的节次记录 0 条' +
            '（缺课程名 ' + (unreadableName + unreadableShape) + ' 条，缺周次 ' + (emptyWeeks + unreadableWeeks) + ' 条，' +
            '缺节次 ' + noIndex + ' 条，节次越界 ' + periodOutOfRange + ' 条）。' +
            '要么这个学期确实还没排课，要么教务系统改了课表页的格式'
        );
    }

    // ── 合并：课程名 + 教师 → 天 / 教室分组 → 相邻节次（周次重合度 ≥ 30%）→ 周次段 ──
    var courseOrder = [];
    var courseMap = {};
    var i;
    for (i = 0; i < records.length; i++) {
        var record = records[i];
        var courseKey = record.name + '|' + record.teacher;
        var course = courseMap[courseKey];
        if (!course) {
            course = {
                name: record.name,
                teacher: record.teacher,
                note: null,
                blocks: [],
                cells: {},
                cellOrder: []
            };
            courseMap[courseKey] = course;
            courseOrder.push(courseKey);
        }
        var cellKey = record.day + '|' + record.room;
        var cell = course.cells[cellKey];
        if (!cell) {
            cell = { day: record.day, room: record.room, periods: {}, order: [] };
            course.cells[cellKey] = cell;
            course.cellOrder.push(cellKey);
        }
        var bucket = cell.periods[record.period];
        if (!bucket) {
            bucket = [];
            cell.periods[record.period] = bucket;
            cell.order.push(record.period);
        }
        for (var w = 0; w < record.weeks.length; w++) bucket.push(record.weeks[w]);
    }

    var courses = [];
    for (var c = 0; c < courseOrder.length; c++) {
        var current = courseMap[courseOrder[c]];
        var blocks = [];
        for (var g = 0; g < current.cellOrder.length; g++) {
            var group = current.cells[current.cellOrder[g]];
            var periods = group.order.slice(0);
            periods.sort(function (a, b) { return a - b; });
            var at = 0;
            while (at < periods.length) {
                var forward = at;
                while (forward + 1 < periods.length && periods[forward + 1] === periods[forward] + 1) {
                    var running = {};
                    var x;
                    for (x = at; x <= forward; x++) {
                        var runWeeks = uniqueSorted(group.periods[periods[x]]);
                        for (var y = 0; y < runWeeks.length; y++) running[runWeeks[y]] = true;
                    }
                    var nextWeeks = uniqueSorted(group.periods[periods[forward + 1]]);
                    var intersect = 0;
                    var unionMap = {};
                    for (var key in running) {
                        if (!Object.prototype.hasOwnProperty.call(running, key)) continue;
                        unionMap[key] = true;
                        if (containsValue(nextWeeks, parseInt(key, 10))) intersect++;
                    }
                    for (x = 0; x < nextWeeks.length; x++) unionMap[nextWeeks[x]] = true;
                    var unionCount = 0;
                    for (var u in unionMap) {
                        if (Object.prototype.hasOwnProperty.call(unionMap, u)) unionCount++;
                    }
                    var ratio = unionCount > 0 ? intersect / unionCount : 0;
                    if (ratio < 0.3) break;
                    forward++;
                }
                var mergedWeeks = [];
                for (var p = at; p <= forward; p++) {
                    var list = uniqueSorted(group.periods[periods[p]]);
                    for (var q = 0; q < list.length; q++) mergedWeeks.push(list[q]);
                }
                mergedWeeks = uniqueSorted(mergedWeeks);
                var runs = runsOf(mergedWeeks);
                for (var r = 0; r < runs.length; r++) {
                    blocks.push({
                        dayOfWeek: group.day,
                        startPeriod: periods[at],
                        endPeriod: periods[forward],
                        startWeek: runs[r].start,
                        endWeek: runs[r].end,
                        weekType: runs[r].weekType,
                        location: group.room ? group.room : null
                    });
                }
                at = forward + 1;
            }
        }
        blocks.sort(function (a, b) {
            return (a.dayOfWeek - b.dayOfWeek) || (a.startPeriod - b.startPeriod) ||
                (a.endPeriod - b.endPeriod) || (a.startWeek - b.startWeek) ||
                (a.endWeek - b.endWeek) || compareText(a.weekType, b.weekType) ||
                compareText(a.location || '', b.location || '');
        });
        courses.push({
            name: current.name,
            teacher: current.teacher ? current.teacher : null,
            note: null,
            blocks: blocks
        });
    }

    function containsValue(list, value) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] === value) return true;
        }
        return false;
    }

    // 不用 localeCompare（Rhino 与 V8 对中文的排序结果未必一致，而 fixture 是逐数组比对的）
    function compareText(a, b) {
        var left = String(a);
        var right = String(b);
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
    }

    // ── 节次时间（上游内置表，逐条校验） ──────────────────────────────────────
    var periodTimes = [];
    var badSlots = [];
    var timedPeriods = {};
    for (i = 0; i < PERIOD_TIMES.length; i++) {
        var slot = PERIOD_TIMES[i];
        if (!isHhmm(slot.start) || !isHhmm(slot.end) || minutesOf(slot.start) >= minutesOf(slot.end)) {
            badSlots.push(slot.periodIndex);
            continue;
        }
        periodTimes.push({ periodIndex: slot.periodIndex, start: slot.start, end: slot.end });
        timedPeriods[slot.periodIndex] = true;
    }

    function isHhmm(value) {
        return /^([01]\d|2[0-3]):[0-5]\d$/.test(text(value));
    }

    function minutesOf(value) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(text(value));
        if (!m) return -1;
        return intOf(m[1]) * 60 + intOf(m[2]);
    }

    var maxPeriodUsed = 0;
    for (i = 0; i < courses.length; i++) {
        for (var b = 0; b < courses[i].blocks.length; b++) {
            if (courses[i].blocks[b].endPeriod > maxPeriodUsed) maxPeriodUsed = courses[i].blocks[b].endPeriod;
        }
    }
    var missingPeriods = [];
    var filledPeriods = [];
    for (var period = 1; period <= maxPeriodUsed; period++) {
        if (timedPeriods[period]) continue;
        var previous = null;
        for (var pi = 0; pi < periodTimes.length; pi++) {
            if (periodTimes[pi].periodIndex === period - 1) previous = periodTimes[pi];
        }
        var startAt = previous ? minutesOf(previous.end) + EXTRA_BREAK_MINUTES : -1;
        if (!previous || startAt + CLASS_MINUTES > 23 * 60 + 59) {
            missingPeriods.push(period);
            continue;
        }
        periodTimes.push({ periodIndex: period, start: hhmmOf(startAt), end: hhmmOf(startAt + CLASS_MINUTES) });
        timedPeriods[period] = true;
        filledPeriods.push(period);
    }

    function hhmmOf(minutes) {
        return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
    }
    if (badSlots.length) {
        warn('内置作息表里第 ' + numbersOf(badSlots, 6, '节') + '的时间不合法（不是 HH:mm 或结束不晚于开始），已丢弃，这几节不会显示上下课时间');
    }
    if (missingPeriods.length) {
        warn('第 ' + numbersOf(missingPeriods, 6, '节') + '的上下课时间不在内置作息表里，课表里这几节不会显示上下课时间');
    }
    warn('节次时间按沈阳建筑大学公布的上课时间导入（第 1 节 ' + PERIOD_TIMES[0].start + '-' + PERIOD_TIMES[0].end +
        '，共 ' + PERIOD_TIMES.length + ' 节）；第 3、4 节在四、五层教室上课的晚 10 分钟（10:10、11:10 开始），请核对');
    if (filledPeriods.length) {
        warn('第 ' + numbersOf(filledPeriods, 6, '节') + '学校没有公布上下课时间，已按上一节下课后课间 ' + EXTRA_BREAK_MINUTES +
            ' 分钟、每节 ' + CLASS_MINUTES + ' 分钟顺推，请核对');
    }

    // 缺教师 / 缺教室：照常导入（null），按课程汇总出声
    var noTeacher = [];
    var noRoom = [];
    for (i = 0; i < courses.length; i++) {
        if (!courses[i].teacher && noTeacher.indexOf(courses[i].name) < 0) noTeacher.push(courses[i].name);
        for (var rb = 0; rb < courses[i].blocks.length; rb++) {
            if (!courses[i].blocks[rb].location && noRoom.indexOf(courses[i].name) < 0) noRoom.push(courses[i].name);
        }
    }
    function examplesOf(names) {
        var head = [];
        for (var k = 0; k < names.length && k < 3; k++) {
            var n = names[k];
            head.push(n.length > 20 ? n.substring(0, 19) + '…' : n);
        }
        return head.join('、');
    }
    if (noTeacher.length) {
        warn('有 ' + noTeacher.length + ' 门课教务没写任课教师（例如 ' + examplesOf(noTeacher) + '），已照常导入，可在「编辑课程」里补上');
    }
    if (noRoom.length) {
        warn('有 ' + noRoom.length + ' 门课有上课安排没写教室（例如 ' + examplesOf(noRoom) + '），已照常导入，教室暂时空着');
    }

    // ── 学期名 / 开学日 / 总周数 ─────────────────────────────────────────────
    var now = parseIso(data.today) || new Date();
    var calendar = parseCalendar(calendarHtml);

    var maxWeek = 0;
    for (i = 0; i < courses.length; i++) {
        for (var bi = 0; bi < courses[i].blocks.length; bi++) {
            if (courses[i].blocks[bi].endWeek > maxWeek) maxWeek = courses[i].blocks[bi].endWeek;
        }
    }

    var totalWeeks = calendar ? calendar.weeks : DEFAULT_TOTAL_WEEKS;
    var totalFrom = calendar ? 'calendar' : 'default';
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        totalFrom = calendar ? 'calendar+table' : 'table';
    }
    var clamped = false;
    if (totalWeeks > MAX_TOTAL_WEEKS) {
        totalWeeks = MAX_TOTAL_WEEKS;
        clamped = true;
    }
    if (!(totalWeeks >= 1)) {
        totalWeeks = DEFAULT_TOTAL_WEEKS;
        totalFrom = 'default';
    }
    if (clamped) {
        for (i = 0; i < courses.length; i++) {
            for (var cb = 0; cb < courses[i].blocks.length; cb++) {
                var block = courses[i].blocks[cb];
                if (block.endWeek > totalWeeks) block.endWeek = totalWeeks;
                if (block.startWeek > totalWeeks) block.startWeek = totalWeeks;
            }
        }
        warn('课表里出现了超过 ' + MAX_TOTAL_WEEKS + ' 周的周次，已按 ' + totalWeeks + ' 周截断，请核对课表');
    }

    var term = termNameOf();
    var teach = teachWeekOf(data.teachWeek, term);
    var firstDay;
    if (calendar) {
        firstDay = mondayIso(parseIso(calendar.start));
        warn('开学日期取自教务系统的学期日历（学期从 ' + calendar.start + ' 开始），第 1 周按每周起始日周一算作 ' +
            firstDay + '，请在学期管理里核对');
    } else if (teach && teach.week) {
        firstDay = isoOf(shiftDays(parseIso(mondayIso(now)), -7 * (teach.week - 1)));
        warn('开学日期按教务首页「当前第 ' + teach.week + ' 教学周」倒推，第 1 周从 ' + firstDay + ' 开始，请在学期管理里核对');
    } else {
        var season = seasonStartOf(term);
        firstDay = season ? season.iso : mondayIso(now);
        var why = teach && teach.other
            ? '教务首页的当前教学周属于' + teach.other + '，不是这个学期'
            : '没读到教务首页的当前教学周';
        warn(why + '，开学日期按' + (season ? '「' + season.rule + '」' : '最近的周一') + '推算为 ' + firstDay + '，请在学期管理里核对');
    }

    if (totalFrom === 'calendar') {
        warn('学期总周数取自教务系统的学期日历（' + totalWeeks + ' 周），如与实际不符可在学期管理里改');
    } else if (totalFrom === 'calendar+table') {
        warn('学期总周数按课表里最晚的第 ' + maxWeek + ' 周抬高到 ' + totalWeeks + ' 周（学期日历只给了 ' +
            calendar.weeks + ' 周），请在学期管理里核对');
    } else {
        warn('学期总周数教务没有提供，已按 ' + totalWeeks + ' 周计（内置值 ' + DEFAULT_TOTAL_WEEKS +
            ' 周' + (maxWeek > DEFAULT_TOTAL_WEEKS ? '，并按课表里最晚的第 ' + maxWeek + ' 周抬高' : '') + '），如校历不同请在学期管理里调整');
    }

    var termName;
    if (term.source === 'none' && teach && teach.schoolYear) {
        termName = teach.schoolYear + '年' + teach.season + '学期';
        warn('没读到教务的学期列表，学期名按教务首页的当前学期写为「' + termName + '」，如与实际不符可在学期管理里改名');
    } else if (term.source === 'none') {
        termName = TERM_NAME_PREFIX + guessedTermName(now);
        warn('学期名教务没有提供，已按导入日期推算为「' + termName + '」，如与实际不符可在学期管理里改名');
    } else {
        termName = term.name;
    }
    warn('只导入了教务系统当前选中的那个学期（' + termName + '）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」');

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
