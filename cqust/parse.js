(function () {
    // 重庆科技大学教务适配器（树维 EAMS，/eams/）—— 第二步：纯转换。
    // 移植自 shiguang_warehouse 的 CQUST/cqust_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 yuexps）
    //   上游快照：baf83fa（2026-11-10），本校脚本最后提交 3d15335（2026-09-16）
    //
    // 输入是 extract.js 交出来的原始数据：课表页 HTML 全文、学期列表原文、当前学期号、取数当天日期。
    // 本文件不发请求、不读页面、不问用户 —— CI 用 Rhino 实跑。
    //
    // 课表页 HTML 里每门课写成 activity = new TaskActivity(...)，参数位置照上游与同族 EAMS 件：
    //   第 2 个是教师、第 4 个是课程名、第 6 个是教室、第 7 个是周次位图；
    //   后面的 activity.index = 天*unitCount + 节; 给出星期与节次（都从 0 起）。
    // 参数可能写成变量或 xxx.join(...)，就地读出不执行（不许动态执行远程代码）。
    //
    // 与上游不同的地方（对应 AUDIT.md 第 5 节）：
    //   ① 周次位图之外也认中文周次（「1-16周」「(单)1-8周(双)9-16周」），位图为主。
    //   ② 连堂合并用「相邻节次、周次完全一样」，同一节的重复行不会另起一段；周次只部分重合的各留一段。
    //   ③ 节次时间优先读课表页面里「第 N 节 HH:MM-HH:MM」的格子，读不到回落到学校公布的 11 节表并提醒。
    //   ④ 「未安排时间任务列表」里的课（集中实践等）课表排不下，只计数提醒，不编造星期节次。
    //   ⑤ 缺教师 / 缺教室照常导入（null），按课程汇总提醒。
    //   ⑥ 学期名取学期列表原文里当前学期那条；开学日按学年学期推算并提醒；总周数 20，课表更晚才抬高。

    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var html = data.courseHtml === null || data.courseHtml === undefined ? '' : String(data.courseHtml);
    var semesterRaw = data.semesterRaw === null || data.semesterRaw === undefined ? '' : String(data.semesterRaw);
    var semesterId = tidy(data.semesterId);

    var SCHOOL = '重庆科技大学';
    var DEFAULT_UNIT_COUNT = 12;
    var DEFAULT_TOTAL_WEEKS = 20;
    var MAX_TOTAL_WEEKS = 30;
    var MAX_PERIODS = 30;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_NAME_SHOWN = 20;
    var BITMAP_RE = /^[01]{10,60}$/;
    // 课程名末尾的课程代码「(A1234)」「(D1200440.18)」不是课名的一部分
    var COURSE_CODE_RE = /\s*\(\s*[A-Za-z0-9._-]+\s*\)\s*$/;
    var BACKSLASH = String.fromCharCode(92);

    // 重庆科技大学上课时间（抄上游写死的 11 节表；教务页面优先，读不到才用它）
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:30', end: '09:15' },
        { periodIndex: 2, start: '09:25', end: '10:10' },
        { periodIndex: 3, start: '10:30', end: '11:15' },
        { periodIndex: 4, start: '11:25', end: '12:10' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:55', end: '15:40' },
        { periodIndex: 7, start: '16:00', end: '16:45' },
        { periodIndex: 8, start: '16:55', end: '17:40' },
        { periodIndex: 9, start: '19:00', end: '19:45' },
        { periodIndex: 10, start: '19:55', end: '20:40' },
        { periodIndex: 11, start: '20:50', end: '21:35' }
    ];
    // 超出节次表时按上游的课时设置顺推（统一修订 H3）
    var CLASS_MINUTES = 45;
    var BREAK_MINUTES = 10;

    var warnings = [];

    function warn(message) {
        if (warnings.length >= MAX_WARNINGS) return;
        var line = String(message);
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.indexOf(line) >= 0) return;
        warnings.push(line);
    }

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function tidy(value) {
        return text(value).replace(/\s+/g, ' ').trim();
    }

    // 教务原文拼进提醒前一律截到 20 字，免得靠最后 200 字硬截断把「请核对」那半句切掉
    function clip(value) {
        var s = tidy(value);
        if (s.length > MAX_NAME_SHOWN) return s.substring(0, MAX_NAME_SHOWN - 1) + '…';
        return s;
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
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tidy(value));
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

    // 第 1 周从周一算起（移植手册 §4.3：别把学期开始日直接当 firstDay）
    function mondayIso(date) {
        return isoOf(shiftDays(date, -((date.getDay() + 6) % 7)));
    }

    function numbersOf(values, max, unit) {
        var head = [];
        for (var i = 0; i < values.length && i < max; i++) head.push(values[i]);
        if (values.length > head.length) return head.join('、') + ' 等 ' + values.length + ' ' + unit;
        return head.join('、') + (unit ? ' ' + unit : '');
    }

    function quotedNames(names) {
        var shown = names.length < 3 ? names.length : 3;
        var parts = [];
        for (var i = 0; i < shown; i++) parts.push('「' + clip(names[i]) + '」');
        var body = parts.join('、');
        if (names.length > shown) body += '，另有 ' + (names.length - shown) + ' 门';
        return body;
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

    // 位图：第 i 位是 '1' 就是第 i 周（下标 0 是占位符，不产出第 0 周，与上游一致）
    function weeksFromBitmap(bits) {
        var out = [];
        var length = bits.length > 60 ? 60 : bits.length;
        for (var i = 1; i < length; i++) {
            if (bits.charAt(i) === '1') out.push(i);
        }
        return { weeks: out };
    }

    function fullWidthToHalf(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[，、；;]/g, ',')
            .replace(/[～~—－–]/g, '-');
    }

    // 中文周次。「(单)1-8周(双)9-16周」这种没逗号的：本段以标记开头时，后一个标记归下一段。
    // 「1-8周(单)9-16周(双)」是后置标记。「共 N 周」只剥备注。「第1-第8周」按 1-8。
    // 混在周次里的节次（「第3-4节」）整段摘掉，学分之类的括号整组算备注。
    function weeksFromText(source) {
        var cleaned = tidy(source);
        if (!cleaned) return [];
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, ' ');
        cleaned = cleaned.replace(/[0-9]+\s*[-~－−–—至到]?\s*[0-9]*\s*节/g, ' ');
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
            var token = tidy(tokens[i]);
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
            var found = segment.match(/[0-9]+(?:\s*-\s*[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = intOf(bounds[0]);
                var end = bounds.length > 1 ? intOf(bounds[1]) : start;
                if (start === null || end === null) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                for (var week = start; week <= end; week++) {
                    if (onlyOdd && week % 2 === 0) continue;
                    if (onlyEven && week % 2 === 1) continue;
                    if (week < 1 || week > MAX_TOTAL_WEEKS) { droppedWeeks++; continue; }
                    if (!seen[week]) { seen[week] = true; weeks.push(week); }
                }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    function weeksOf(raw) {
        var value = tidy(raw);
        if (!value) return { weeks: [], mode: 'empty' };
        if (BITMAP_RE.test(value)) {
            return { weeks: weeksFromBitmap(value).weeks, mode: 'bitmap' };
        }
        return { weeks: weeksFromText(value), mode: 'text' };
    }

    // 周次集合 → 极大段（连着的 ALL，隔周的 ODD / EVEN，落单一周 ALL）
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

    // ── 课表页内嵌脚本的解析（只读，不执行） ──────────────────────────────────

    function matchPair(source, openIndex, openChar, closeChar) {
        var depth = 0;
        var quote = '';
        for (var i = openIndex; i < source.length; i++) {
            var ch = source.charAt(i);
            if (quote) {
                if (ch === BACKSLASH) { i++; continue; }
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

    function splitArgs(raw) {
        var args = [];
        var current = '';
        var quote = '';
        var depth = 0;
        for (var i = 0; i < raw.length; i++) {
            var ch = raw.charAt(i);
            if (quote) {
                current += ch;
                if (ch === BACKSLASH) {
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

    function unescapeChar(ch) {
        if (ch === 'n') return String.fromCharCode(10);
        if (ch === 't') return String.fromCharCode(9);
        if (ch === 'r') return String.fromCharCode(13);
        return ch;
    }

    // 从 from 处读一个字符串字面量或数组字面量（new Array(...) 也算）
    function readValueAt(source, from) {
        var i = from;
        while (i < source.length && /\s/.test(source.charAt(i))) i++;
        var ch = source.charAt(i);
        if (ch === '"' || ch === "'") {
            var out = '';
            i++;
            while (i < source.length) {
                var c = source.charAt(i);
                if (c === BACKSLASH) {
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

    function isWordChar(ch) {
        return /[A-Za-z0-9_$]/.test(ch);
    }

    // 就近取变量最后一次赋值（在 pos 之前）。只认字符串与数组两种形态。
    function varAt(source, name, pos) {
        var best = null;
        var from = 0;
        while (true) {
            var at = source.indexOf(name, from);
            if (at < 0) break;
            from = at + name.length;
            if (at > 0 && isWordChar(source.charAt(at - 1))) continue;
            if (isWordChar(source.charAt(at + name.length))) continue;
            var after = at + name.length;
            while (after < source.length && /\s/.test(source.charAt(after))) after++;
            if (source.charAt(after) !== '=') continue;
            if (source.charAt(after + 1) === '=') continue;
            if (pos >= 0 && at >= pos) break;
            var value = readValueAt(source, after + 1);
            if (value) best = value;
        }
        return best;
    }

    function stringAfterKey(element, key) {
        var from = 0;
        while (true) {
            var at = element.indexOf(key, from);
            if (at < 0) return '';
            from = at + key.length;
            if (at > 0 && isWordChar(element.charAt(at - 1))) continue;
            var after = at + key.length;
            while (after < element.length && /\s/.test(element.charAt(after))) after++;
            if (element.charAt(after) !== ':') continue;
            var value = readValueAt(element, after + 1);
            if (value && value.kind === 'string') return value.value;
            return '';
        }
    }

    // 数组字面量里的名字：["张三","李四"] 或 [{name:"张三"},...] 两种写法都认
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
            var name = stringAfterKey(element, 'name');
            if (name) names.push(name);
        }
        return names;
    }

    // 一个参数实参 → 字符串。剥不开的返回 resolved:false（调用方必须出声，不许把表达式原文当值）
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
        // actTeachers.join(",") / teachers.map(...).join(",")：只看最前面那个标识符
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
        return { value: '', resolved: false };
    }

    function cleanCourseName(name) {
        return tidy(name).replace(COURSE_CODE_RE, '');
    }

    function placeholder(value) {
        var s = tidy(value);
        return s === '未知' || s === '未知地点' || s === '待定' || s === '暂无' ||
            s === '暂无教师' || s === '暂无教室' || s === '无';
    }

    function cleanTeacher(value) {
        var cleaned = tidy(value)
            .replace(/\(\s*[0-9]+\s*\)/g, '')
            .replace(/（\s*[0-9]+\s*）/g, '');
        if (!cleaned || placeholder(cleaned)) return '';
        return cleaned;
    }

    // 教师按课件给的那串拆开；括号里的备注（外聘、主讲）不是第二位教师，跟着原名字走
    function teachersOf(raw) {
        var out = [];
        var parts = tidy(raw).split(/[,，、;；\/]/);
        for (var i = 0; i < parts.length; i++) {
            var one = cleanTeacher(parts[i]);
            if (one && out.indexOf(one) === -1) out.push(one);
        }
        return out.length ? out.join(',') : null;
    }

    function unitCountOf(source) {
        var m = /(?:^|[^A-Za-z0-9_])unitCount\s*=\s*([0-9]{1,3})\s*[;,]/.exec(source);
        var count = m ? intOf(m[1]) : null;
        if (count === null || count < 1 || count > MAX_PERIODS) return null;
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

    // 一段脚本里所有的 index 赋值 → {day, period}（都从 1 起）
    function indexesIn(segment, unitCount) {
        var found = [];
        var spans = [];
        var m;
        var re = /index\s*=\s*([0-9]{1,3})\s*\*\s*unitCount\s*\+\s*([0-9]{1,3})\s*;/g;
        while ((m = re.exec(segment)) !== null) {
            spans.push([m.index, m.index + m[0].length]);
            found.push({ day: intOf(m[1]) + 1, period: intOf(m[2]) + 1, at: m.index });
        }
        var rePlain = /index\s*=\s*([0-9]{1,5})\s*;/g;
        while ((m = rePlain.exec(segment)) !== null) {
            if (inSpans(spans, m.index)) continue;
            var linear = intOf(m[1]);
            found.push({
                day: Math.floor(linear / unitCount) + 1,
                period: (linear % unitCount) + 1,
                at: m.index
            });
        }
        found.sort(function (a, b) { return a.at - b.at; });
        return found;
    }

    // ── 节次时间 ──────────────────────────────────────────────────────────────

    function isHhmm(value) {
        return /^([01]\d|2[0-3]):[0-5]\d$/.test(tidy(value));
    }

    function minutesOf(value) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(tidy(value));
        if (!m) return -1;
        return intOf(m[1]) * 60 + intOf(m[2]);
    }

    function hhmmOf(minutes) {
        return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
    }

    var CN_DIGITS = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

    function periodNumber(label) {
        var raw = tidy(label);
        if (/^[0-9]{1,2}$/.test(raw)) return intOf(raw);
        if (raw === '十一') return 11;
        if (raw === '十二') return 12;
        if (raw.length === 1 && CN_DIGITS[raw]) return CN_DIGITS[raw];
        return null;
    }

    // 课表页面里「第 N 节 08:30-09:15」这类格子（同族 EAMS 件 hpu 的读法）。一个格子里两样都要有才算。
    function pageTimesFromHtml(source) {
        var out = [];
        var seen = {};
        var cells = String(source || '').split(/<\/t[dh]>/i);
        for (var i = 0; i < cells.length; i++) {
            var chunk = cells[i].replace(/<[^>]*>/g, ' ');
            var label = /第\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*节/.exec(chunk);
            if (!label) continue;
            var times = /([0-9]{1,2}:[0-9]{2})\s*[-~—–至]\s*([0-9]{1,2}:[0-9]{2})/.exec(chunk);
            if (!times) continue;
            var index = periodNumber(label[1]);
            if (!(index >= 1 && index <= MAX_PERIODS) || seen[index]) continue;
            if (!isHhmm(times[1]) || !isHhmm(times[2])) continue;
            if (minutesOf(times[1]) >= minutesOf(times[2])) continue;
            seen[index] = true;
            out.push({ periodIndex: index, start: times[1], end: times[2] });
        }
        out.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        return out;
    }

    // ── 学期列表 ──────────────────────────────────────────────────────────────

    function semestersFromRaw(raw) {
        var out = [];
        var re = /\{[^{}]*\}/g;
        var m;
        while ((m = re.exec(String(raw || ''))) !== null) {
            var body = m[0];
            var id = /(?:^|[{,\s])id\s*:\s*["']?([0-9]+)["']?/.exec(body);
            if (!id) continue;
            var year = /schoolYear\s*:\s*["']([^"']*)["']/.exec(body);
            var name = /(?:^|[{,\s])name\s*:\s*["']([^"']*)["']/.exec(body);
            out.push({ id: id[1], schoolYear: year ? tidy(year[1]) : '', name: name ? tidy(name[1]) : '' });
        }
        return out;
    }

    var CN_TERMS = { '1': '第一学期', '2': '第二学期', '3': '第三学期', '4': '第四学期' };

    function termLabelOf(value) {
        var s = tidy(value);
        if (!s) return '';
        if (/^第?[0-9一二三四五六七八九]{1,2}学期$/.test(s)) {
            return s.indexOf('第') === 0 ? s : '第' + s;
        }
        if (CN_TERMS[s]) return CN_TERMS[s];
        return s;
    }

    function termIndexOf(value) {
        var s = tidy(value);
        if (/二|2/.test(s)) return 2;
        return 1;
    }

    // 困难：教务不给开学日。按学年学期的常见校历锚点推（秋季 9 月 7 日、春季 2 月 22 日所在周的周一）
    function firstDayOf(schoolYear, termIndex, today) {
        var years = String(schoolYear || '').match(/[0-9]{4}/g) || [];
        var year = null;
        if (termIndex === 2) {
            if (years[1]) year = intOf(years[1]);
            else if (years[0]) year = intOf(years[0]) + 1;
        } else if (years[0]) {
            year = intOf(years[0]);
        }
        if (year === null) {
            var nowYear = today.getFullYear();
            var month = today.getMonth() + 1;
            if (termIndex === 2) year = month >= 8 ? nowYear + 1 : nowYear;
            else year = month >= 8 ? nowYear : nowYear - 1;
        }
        var anchor = termIndex === 2 ? new Date(year, 1, 22) : new Date(year, 8, 7);
        return mondayIso(anchor);
    }

    // 「未安排时间任务列表」：教务排了课但没给时间的（集中实践等），课表里排不下
    function unarrangedNames(source) {
        var full = String(source || '');
        var at = full.indexOf('未安排时间任务列表');
        if (at < 0) return [];
        var tableStart = full.indexOf('<table', at);
        if (tableStart < 0) return [];
        var tableEnd = full.indexOf('</table>', tableStart);
        if (tableEnd < 0) return [];
        var body = full.substring(tableStart, tableEnd);
        var rows = body.split(/<tr[^>]*>/i);
        var names = [];
        for (var i = 1; i < rows.length; i++) {
            var cells = rows[i].split(/<t[dh][^>]*>/i);
            var values = [];
            for (var c = 1; c < cells.length; c++) {
                values.push(tidy(String(cells[c]).replace(/<[^>]*>/g, ' ')));
            }
            if (values.length < 8) continue;
            if (!/^[0-9]+$/.test(values[0])) continue;
            if (values[2]) names.push(values[2]);
        }
        return names;
    }

    // ── 主流程 ────────────────────────────────────────────────────────────────

    if (!tidy(html)) {
        throw new Error('教务系统没有返回课表数据。请确认已经登录并打开「我的课表」，再点「提取课表」。');
    }
    if (html.indexOf('TaskActivity') < 0) {
        throw new Error('教务系统返回的页面里没有课程数据。这个学期可能还没排课，请回到课表页面核对后再试。');
    }

    var unitCount = unitCountOf(html);
    if (unitCount === null) {
        unitCount = DEFAULT_UNIT_COUNT;
        warn('课表页面里没有读到这学期一天排几节，已按每天 ' + DEFAULT_UNIT_COUNT + ' 节计算，请在导入预览里核对节次。');
    }

    var noteGroups = 0;
    var noteSample = '';
    var bothMarks = 0;
    var droppedWeeks = 0;
    var orphanMarkers = 0;

    var entries = activityEntries(html);
    var records = [];
    var unreadableShape = 0;
    var unreadableName = 0;
    var unreadableTeacher = 0;
    var unreadableRoom = 0;
    var unreadableWeeks = 0;
    var emptyWeeks = 0;
    var noIndex = 0;
    var suspended = 0;
    var periodOutOfRange = 0;
    var textWeeksSeen = false;

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
        var teacherArg = resolveArg(args[1], html, entry.start);
        if (!teacherArg.resolved) unreadableTeacher++;
        var roomArg = resolveArg(args[5], html, entry.start);
        if (!roomArg.resolved) unreadableRoom++;
        var weeksArg = resolveArg(args[6], html, entry.start);
        if (!weeksArg.resolved) {
            unreadableWeeks++;
            continue;
        }
        var parsedWeeks = weeksOf(weeksArg.value);
        if (parsedWeeks.mode === 'text') textWeeksSeen = true;
        if (!parsedWeeks.weeks.length) {
            emptyWeeks++;
            continue;
        }
        var room = tidy(roomArg.value);
        // 「停课」是教务用来标临时停课的一格，不是教室
        if (room === '停课') {
            suspended++;
            continue;
        }
        if (placeholder(room)) room = '';
        var segmentEnd = e + 1 < entries.length ? entries[e + 1].start : html.length;
        var segment = html.substring(entry.end, segmentEnd);
        var marshal = segment.search(/table[0-9]+\s*\.\s*marshalTable/);
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
                teacher: teachersOf(teacherArg.resolved ? teacherArg.value : ''),
                room: room,
                day: spot.day,
                period: spot.period,
                weeks: parsedWeeks.weeks
            });
        }
    }

    if (periodOutOfRange) {
        warn('有 ' + periodOutOfRange + ' 个节次落在 1-' + unitCount + ' 节之外（或星期超出周一到周日），已跳过，请核对课表。');
    }
    if (suspended) {
        warn('有 ' + suspended + ' 门课教务标了「停课」，已跳过；如果这门课其实要上，请到课表页面核对。');
    }
    if (noIndex) {
        warn('有 ' + noIndex + ' 门课在课表页面里没有对应的上课节次，已跳过，请核对课表。');
    }
    if (emptyWeeks) {
        warn('有 ' + emptyWeeks + ' 门课的周次是空的或认不出来，已跳过，请到课表页面核对。');
    }
    if (unreadableWeeks) {
        warn('有 ' + unreadableWeeks + ' 门课的周次写法没能读出，已跳过，请到课表页面核对。');
    }
    if (unreadableName) {
        warn('有 ' + unreadableName + ' 门课的课程名没能读出，已跳过，请到课表页面核对。');
    }
    if (unreadableTeacher) {
        warn('有 ' + unreadableTeacher + ' 门课的教师没能读出，已留空，可在「编辑课程」里补上。');
    }
    if (unreadableRoom) {
        warn('有 ' + unreadableRoom + ' 门课的教室没能读出，已留空，可在「编辑课程」里补上。');
    }
    if (unreadableShape) {
        warn('有 ' + unreadableShape + ' 门课的排课信息不完整，没能读出，已跳过，请到课表页面核对。');
    }
    if (textWeeksSeen) {
        warn('有课程的周次是文字写的（如「1-16周」「单周」），已按文字读出，请在导入预览里核对周次。');
    }
    if (bothMarks) {
        warn('有 ' + bothMarks + ' 处周次同时写了单周和双周，已按每周都上处理，请核对课表。');
    }
    if (noteGroups) {
        warn('周次里有 ' + noteGroups + ' 处备注（例如「' + clip(noteSample) + '」）已略过，不影响上课周次。');
    }
    if (droppedWeeks) {
        warn('有 ' + droppedWeeks + ' 个上课周次超出 1 到 ' + MAX_TOTAL_WEEKS + ' 周，已跳过。');
    }
    if (orphanMarkers) {
        warn('有 ' + orphanMarkers + ' 处单双周标记旁边没有周次，已忽略，请核对课表。');
    }

    if (!records.length) {
        throw new Error('教务返回了 ' + entries.length + ' 门课，但都缺少课程名、星期、节次或周次，读不出课表。请到课表页面核对后再提取。');
    }

    // ── 合并：课程名 + 教师 → 天 / 教室 → 相邻节次（周次重合才并）→ 周次段 ──
    var courseOrder = [];
    var courseMap = {};
    var i;
    for (i = 0; i < records.length; i++) {
        var record = records[i];
        var courseKey = record.name + '|' + record.teacher;
        var course = courseMap[courseKey];
        if (!course) {
            course = { name: record.name, teacher: record.teacher, cells: {}, cellOrder: [] };
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

    // 周次集合完全相同（都排过序）才算同一段连堂
    function sameWeeks(a, b) {
        if (a.length !== b.length) return false;
        for (var n = 0; n < a.length; n++) {
            if (a[n] !== b[n]) return false;
        }
        return true;
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
                    var running = [];
                    var x;
                    for (x = at; x <= forward; x++) {
                        var runWeeks = uniqueSorted(group.periods[periods[x]]);
                        for (var y = 0; y < runWeeks.length; y++) running.push(runWeeks[y]);
                    }
                    running = uniqueSorted(running);
                    // 相邻节次、周次完全一样才并成连堂；部分重合不并，各留一段
                    if (!sameWeeks(running, uniqueSorted(group.periods[periods[forward + 1]]))) break;
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

    // 不用 localeCompare（Rhino 与 V8 对中文的排序未必一致，fixture 是逐数组比对的）
    function compareText(a, b) {
        var left = String(a);
        var right = String(b);
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
    }

    // ── 节次时间：教务页面优先，读不到回落学校公布的 11 节表 ─────────────────
    var pageTimes = pageTimesFromHtml(html);
    var baseTimes = pageTimes.length ? pageTimes : SCHOOL_PERIOD_TIMES;
    var periodTimes = [];
    var timedPeriods = {};
    var badSlots = [];
    for (i = 0; i < baseTimes.length; i++) {
        var slot = baseTimes[i];
        if (!isHhmm(slot.start) || !isHhmm(slot.end) || minutesOf(slot.start) >= minutesOf(slot.end)) {
            badSlots.push(slot.periodIndex);
            continue;
        }
        if (timedPeriods[slot.periodIndex]) continue;
        timedPeriods[slot.periodIndex] = true;
        periodTimes.push({ periodIndex: slot.periodIndex, start: slot.start, end: slot.end });
    }

    var maxPeriodUsed = 0;
    for (i = 0; i < courses.length; i++) {
        for (var b = 0; b < courses[i].blocks.length; b++) {
            if (courses[i].blocks[b].endPeriod > maxPeriodUsed) maxPeriodUsed = courses[i].blocks[b].endPeriod;
        }
    }
    var filledPeriods = [];
    var missingPeriods = [];
    for (var period = 1; period <= maxPeriodUsed; period++) {
        if (timedPeriods[period]) continue;
        var previous = null;
        for (var pi = 0; pi < periodTimes.length; pi++) {
            if (periodTimes[pi].periodIndex === period - 1) previous = periodTimes[pi];
        }
        var startAt = previous ? minutesOf(previous.end) + BREAK_MINUTES : -1;
        if (!previous || startAt + CLASS_MINUTES > 23 * 60 + 59) {
            missingPeriods.push(period);
            continue;
        }
        periodTimes.push({ periodIndex: period, start: hhmmOf(startAt), end: hhmmOf(startAt + CLASS_MINUTES) });
        timedPeriods[period] = true;
        filledPeriods.push(period);
    }
    periodTimes.sort(function (a, b) { return a.periodIndex - b.periodIndex; });

    if (badSlots.length) {
        warn('第 ' + numbersOf(badSlots, 6, '节') + '的上下课时间不完整（开始不早于结束），已丢弃，这几节不会显示上下课时间。');
    }
    if (pageTimes.length) {
        warn('节次时间取自教务系统的课表页面（第 1 节 ' + pageTimes[0].start + '-' + pageTimes[0].end +
            '，共 ' + pageTimes.length + ' 节），请在学期管理里核对。');
    } else {
        warn('教务系统没有给出节次时间，已按学校公布的节次时间导入（第 1 节 ' + SCHOOL_PERIOD_TIMES[0].start + '-' +
            SCHOOL_PERIOD_TIMES[0].end + '，共 ' + SCHOOL_PERIOD_TIMES.length + ' 节），请在学期管理里核对。');
    }
    if (filledPeriods.length) {
        warn('第 ' + numbersOf(filledPeriods, 6, '节') + '没有上下课时间，已按上一节下课后课间 ' +
            BREAK_MINUTES + ' 分钟、每节 ' + CLASS_MINUTES + ' 分钟顺推，请在学期管理里核对。');
    }
    if (missingPeriods.length) {
        warn('第 ' + numbersOf(missingPeriods, 6, '节') + '没有上下课时间，课表里这几节不会显示时间，请在学期管理里补上。');
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
    if (noTeacher.length) {
        warn('有 ' + noTeacher.length + ' 门课没有教师（例如' + quotedNames(noTeacher) + '），已照常导入，可在「编辑课程」里补上。');
    }
    if (noRoom.length) {
        warn('有 ' + noRoom.length + ' 门课有上课安排没写教室（例如' + quotedNames(noRoom) + '），已照常导入，教室暂时空着。');
    }

    var unarranged = unarrangedNames(html);
    if (unarranged.length) {
        warn('有 ' + unarranged.length + ' 门课教务没有安排上课时间（例如' + quotedNames(unarranged) +
            '），课表里排不下，没有导入，请到课表页面核对。');
    }

    // ── 学期名 / 开学日 / 总周数 ─────────────────────────────────────────────
    var today = parseIso(data.today) || new Date();
    var semesters = semestersFromRaw(semesterRaw);
    var picked = null;
    for (i = 0; i < semesters.length; i++) {
        if (semesterId && String(semesters[i].id) === String(semesterId)) {
            picked = semesters[i];
            break;
        }
    }

    var termIndex = picked ? termIndexOf(picked.name) : (today.getMonth() + 1 >= 8 ? 1 : 2);
    var termName = '';
    var nameFromSchool = false;
    if (picked && picked.schoolYear) {
        termName = picked.schoolYear + '学年' + termLabelOf(picked.name);
        nameFromSchool = true;
    }
    var firstDay = firstDayOf(picked ? picked.schoolYear : '', termIndex, today);
    if (!nameFromSchool) {
        var years = String(firstDay).substring(0, 4);
        var other = termIndex === 2 ? String(intOf(years) - 1) + '-' + years : years + '-' + String(intOf(years) + 1);
        termName = SCHOOL + other + '学年' + (termIndex === 2 ? '第二学期' : '第一学期');
    }

    var maxWeek = 0;
    for (i = 0; i < courses.length; i++) {
        for (var bi = 0; bi < courses[i].blocks.length; bi++) {
            if (courses[i].blocks[bi].endWeek > maxWeek) maxWeek = courses[i].blocks[bi].endWeek;
        }
    }
    var totalWeeks = DEFAULT_TOTAL_WEEKS;
    var raised = maxWeek > totalWeeks;
    if (raised) totalWeeks = maxWeek;
    var clamped = false;
    if (totalWeeks > MAX_TOTAL_WEEKS) {
        totalWeeks = MAX_TOTAL_WEEKS;
        clamped = true;
    }
    if (clamped) {
        for (i = 0; i < courses.length; i++) {
            for (var cb = 0; cb < courses[i].blocks.length; cb++) {
                var block = courses[i].blocks[cb];
                if (block.endWeek > totalWeeks) block.endWeek = totalWeeks;
                if (block.startWeek > totalWeeks) block.startWeek = totalWeeks;
            }
        }
        warn('课表里出现了超过 ' + MAX_TOTAL_WEEKS + ' 周的周次，已按 ' + totalWeeks + ' 周截断，请核对课表。');
    }

    if (!nameFromSchool) {
        warn('教务系统没有给出学期名称，已写成「' + termName + '」，可以在学期管理里改成你想要的名字。');
    } else {
        warn('只导入了教务系统当前选中的学期（' + clip(termName) + '）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」。');
    }
    warn('开学日期教务系统没有给出，已按学期推算为 ' + firstDay + '（第 1 周从周一算起），请在学期管理里核对。');
    if (!raised) {
        warn('教务系统没有给出学期总周数，已按 ' + totalWeeks + ' 周导入（课表最晚排到第 ' + maxWeek +
            ' 周），如与学校安排不符，请在学期管理里改。');
    } else {
        warn('教务系统没有给出学期总周数，原本按 ' + DEFAULT_TOTAL_WEEKS + ' 周导入，但课表排到第 ' + maxWeek +
            ' 周，学期总周数已改为 ' + totalWeeks + ' 周，请在学期管理里核对。');
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
