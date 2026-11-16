(function () {
    // 重庆城市科技学院课表解析 —— 第二步：教务课表页的表格文字 → 空课课表载荷。
    // 移植自 shiguang_warehouse 的 CQCST/cqcst_01.js（MIT，上游作者 Mutx163）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //   上游快照 1dc9ac6（2026-11-16 拉取），本校脚本最后一次修改 1fe584c（2026-08-23）。模板：ecjtu；
    //   表格网格对齐参考 hnptc。
    // 上游的核心：读 #kbtable / .table_border 这张表，跳过第一行表头，按「倒数第 7 列是周一」把格子算到星期几；
    // 一格里的几门课用 5 个以上连字符分开，每块的行是「课名 / 教师 / 周次(单双)[01-02节] / 地点」；
    // 周次整串只判一次单双，节次取方括号里的首尾节次。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 周次逐段判单双：上游对整串只判一次，「(单)1-8周,(双)9-16周」会把后一段也当单周；
    //      这里先分段、每段各自判，前置 / 后置 / 无逗号紧挨下一段的写法都认，共 N 周的备注只剥备注本身；
    //      整段写在括号里的周次（(1-16周)、（第1-16周））一并认，分隔符认 ,，、;；
    //   ② 缺教师 / 缺地点交 null（上游写「未知」「未知地点」），按类型汇总提醒，点名课名截 20 字；
    //   ③ 上游 lines.length < 3 直接丢块：这里认得出课名与周次就收下（缺教师 / 缺地点不影响导入），
    //      认不出的块按处计数并点名，不静默丢；
    //   ④ 星期优先按表头里的星期名称对齐网格列（上游一律按倒数第 7 列），两者不一致按表头为准并提醒；
    //   ⑤ 节次时间先读课表页左侧节次列里的时间（如 08:00-08:45），没有就回落应用自带的 12 节并提醒；
    //   ⑥ 开学日与总周数本页没有：开学日按提取当天回退到周一推算，总周数默认 20（课表排得更晚才抬高），各出一条提醒；
    //   ⑦ 课表用到的节次超出节次时间表时，按「统一修订 H3」逐节顺推补齐并提醒；
    //   ⑧ 同门课重复格按「课名 + 星期 + 节次 + 周次」去重（上游同样去重）；
    //   ⑨ 表头 / 图例 / 备注行不当课程行（ecjtu「短行」口径）：一格且没有周次节次的、整行星期名的表头行都跳过；
    //      教师 / 地点只在「有周次特征」时才丢（整行周次[节次] 或带「周」字），1-101 这类数字连字符地点照认。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，CI 的 Rhino 里没有 DOM）：
    //   { now: "2026-11-16", term: { code, name }, cols: 8,
    //     rows: [ [ { col, span, text } ] ] }
    //   text 是一格的可见文字（多行用换行分隔），课与课之间用 5 个以上连字符分隔。
    var data = JSON.parse(__ncInput);
    if (!data || typeof data !== 'object') {
        throw new Error('没有拿到教务数据：请重新登录教务系统后再点「提取课表」');
    }
    var rows = data.rows || [];
    var term = data.term || {};

    var SCHOOL_NAME = '重庆城市科技学院';

    // 应用自带的 12 节节次时间：课表页没有给出节次时间时用它（与模板 ecjtu / qfnu 同一张表）
    var FALLBACK_PERIOD_TIMES = [
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
    var PERIOD_COUNT = FALLBACK_PERIOD_TIMES.length;
    var DEFAULT_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;      // 载荷校验的总周数上限（1..30），越过的周次按脏数据丢弃并出声
    var MAX_PERIOD = 20;    // 越过它一定是脏数据（更晚的节次按 H3 顺推补时间，越过 23:59 就停）
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var ZERO_WIDTH = new RegExp('[' + String.fromCharCode(8203, 8204, 8205, 65279) + ']', 'g');
    var NBSP = String.fromCharCode(160);

    // 计数与点名：同一类问题只出一条提醒，点名最多 3 个课名
    var warnings = [];
    var droppedWeeks = 0;
    var droppedSections = 0;
    var noNameBlocks = 0;
    var noWeekBlocks = 0;
    var unrecognizedNames = [];
    var missingTeacher = [];
    var missingRoom = [];

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(ZERO_WIDTH, '')
            .replace(new RegExp(NBSP, 'g'), ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 拼进提醒的教务原文一律截到 20 字，保证末尾「请核对…」不被 200 字上限切掉
    function shortName(value) {
        var text = clean(value);
        if (text.length > 20) return text.substring(0, 20) + '…';
        return text;
    }

    // 每条提醒的唯一出口：≤200 字。本适配器的提醒条数有固定上限（十来条），不会触到 20 条
    function warn(message) {
        var text = String(message);
        if (text.length > MAX_WARNING_TEXT) text = text.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) return;
        warnings.push(text);
    }

    function shortNamesOf(list) {
        var picked = [];
        for (var i = 0; i < list.length && i < 3; i++) picked.push(shortName(list[i]));
        return picked.join('、');
    }

    function noteUnrecognized(name) {
        if (unrecognizedNames.length >= 3) return;
        unrecognizedNames.push(name ? shortName(name) : '没认出课名');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 提取时刻所在周的周一（移植手册 §4.3：firstDay 是第 1 周的第一天）
    function mondayOf(isoDate) {
        var m = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})/.exec(clean(isoDate));
        if (!m) return null;
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        var back = (day.getDay() + 6) % 7;
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() - back));
    }

    function minutesOf(value) {
        var m = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/.exec(clean(value));
        if (!m) return -1;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    function clockText(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    function uniqueSorted(list) {
        var seen = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var value = list[i];
            if (value >= 1 && !seen[value]) {
                seen[value] = true;
                out.push(value);
            }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    function pushWeek(out, week, oddOnly, evenOnly) {
        if (isNaN(week) || week < 1) return;
        if (week > MAX_WEEK) {
            droppedWeeks++;
            return;
        }
        if (oddOnly && week % 2 === 0) return;
        if (evenOnly && week % 2 === 1) return;
        out.push(week);
    }

    // 无逗号的前置 / 后置单双标记：
    //   (单)1-8周(双)9-16周 —— 段首就有标记，后面那个标记属于下一段，前面补逗号；
    //   1-8周(单)9-16周(双) —— 段首没有标记，标记属于前一段，后面补逗号。
    function glueMarkers(text) {
        return text.replace(/[(（]?\s*([单双])\s*[)）]?\s*(?=[0-9])/g, function (all, mark, offset, source) {
            var before = source.substring(0, offset);
            if (!/[0-9)）]/.test(before)) return all;
            var lastChar = before.charAt(before.length - 1);
            if (/[,，;；、]/.test(lastChar)) return all;
            var segStart = 0;
            for (var k = before.length - 1; k >= 0; k--) {
                var ch = before.charAt(k);
                if (/[,，;；、]/.test(ch)) {
                    segStart = k + 1;
                    break;
                }
            }
            var seg = before.substring(segStart).replace(/\s+/g, '');
            if (/^[(（]?[单双]/.test(seg)) return ',' + all;
            return all + ',';
        });
    }

    // 周次文字 → 周次集合。四步预处理对应踩过的坑：
    //   ① 「共 N 周」只剥备注本身；
    //   ② 括号里的学分 / 学时 / 节次备注整组摘掉，但 (1-16周)、(单) 这类周次写法保留；
    //   ③ 串首的 (1) / (1-2) 是教学班序号，不是周次；节次写法「3-4节」整段摘掉；
    //   ④ 「第」「周」整字删掉，再把贴在一起的单双标记按段拆开，然后逐段判单双。
    function weeksOf(source) {
        var text = clean(source);
        text = text.replace(/共\s*[0-9]+\s*周?/g, ' ');
        text = text.replace(/[（(]([^（）()]*)[)）]/g, function (whole, body) {
            if (/[学分时节课教程考试班组]/.test(body)) return ' ';
            if (/[0-9]/.test(body) || body.indexOf('单') >= 0 || body.indexOf('双') >= 0 ||
                body.indexOf('周') >= 0 || body.indexOf('第') >= 0 || /[-—~至到]/.test(body)) {
                return whole;
            }
            return ' ';
        });
        text = text.replace(/^\s*[(（]\s*[0-9]+\s*(?:[-—~至到]\s*[0-9]+\s*)?[)）]/, ' ');
        text = text.replace(/[（(]\s*[0-9]+\s*[)）]/g, ' ');
        text = text.replace(/[0-9]+\s*(?:[-—~至到]\s*[0-9]+)?\s*节/g, ' ');
        text = text.replace(/[至到]/g, '-');
        text = text.replace(/[第周]/g, '');
        text = glueMarkers(text);
        var tokens = text.split(/[,，、;；\s]+/);
        var weeks = [];
        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (!token || !/[0-9]/.test(token)) continue;
            var oddOnly = token.indexOf('单') >= 0;
            var evenOnly = token.indexOf('双') >= 0;
            // 「单双周」两个标记同时出现 = 每周都上
            if (oddOnly && evenOnly) {
                oddOnly = false;
                evenOnly = false;
            }
            var numbers = token.match(/[0-9]+/g);
            if (!numbers || !numbers.length) continue;
            var from = parseInt(numbers[0], 10);
            var to = numbers.length >= 2 ? parseInt(numbers[1], 10) : from;
            if (to < from) {
                var swap = from;
                from = to;
                to = swap;
            }
            for (var week = from; week <= to; week++) pushWeek(weeks, week, oddOnly, evenOnly);
        }
        return uniqueSorted(weeks);
    }

    // 周次集合 → 极大段（移植手册 §4.1）：步长 1 每周，步长 2 单 / 双周
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j], weekType: 'ALL' };
            if (step === 2 && run.start !== run.end) {
                run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            }
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // 周次文字的判断：括号里是周次写法（(1-16周)、(单)）就展开后一起判，其余备注（共 16 周、3 学分）
    // 整组当空白；剩下的字符必须全是周次写法 —— 这样「(1-16周)」「1-8周(单)、9-16周(双)」能进，课名进不来。
    function isWeekText(text) {
        var rest = String(text)
            .replace(/共\s*[0-9]+\s*周?/g, ' ')
            .replace(/[（(]([^（）()]*)[)）]/g, function (whole, body) {
                if (/[学分时节课教程考试班组]/.test(body)) return ' ';
                if (/[0-9]/.test(body) || body.indexOf('单') >= 0 || body.indexOf('双') >= 0 ||
                    body.indexOf('周') >= 0 || body.indexOf('第') >= 0 || /[-—~至到]/.test(body)) {
                    return ' ' + body + ' ';
                }
                return ' ';
            });
        if (!/[0-9]/.test(rest)) return false;
        return /^[0-9\s,，、;；\-—~至到单双第周节]*$/.test(rest);
    }

    // 「周次(单双)[节次]」：方括号里是节次，前面是周次写法；方括号后面同一行的剩余文字是地点（上游只认下一行）
    var WEEK_LINE = /[\[［]\s*([0-9]{1,2}(?:\s*[-—~至到]\s*[0-9]{1,2})?)\s*节\s*[\]］]/;

    function weekSpecOf(line) {
        var text = clean(line);
        var m = WEEK_LINE.exec(text);
        if (!m) return null;
        var before = clean(text.substring(0, m.index));
        var after = clean(text.substring(m.index + m[0].length));
        var weeksText = before.replace(/[\[［][^\]］]*[\]］]/g, ' ');
        if (!isWeekText(weeksText)) return null;
        return { weeksText: weeksText, sectionsText: clean(m[1]), tail: after };
    }

    // 占位词不是教师 / 教室：「未知」「待定」「暂无」「未知地点」都交 null
    function blankValue(value) {
        var text = clean(value);
        if (!text) return null;
        if (/^(未知|待定|暂无|无|未排|未安排)$/.test(text)) return null;
        if (/^(未知|待定|暂无|未排|未安排)(教师|老师|教室|地点|上课地点)$/.test(text)) return null;
        return text;
    }

    // 周次特征：整行就是「周次[节次]」，或带「周」字的周次写法。
    // 不能只靠 isWeekText："1-101" 这类教室 / 地点也全是数字与连字符，会被误当周次丢掉。
    function looksLikeWeekText(value) {
        var text = clean(value);
        return !!weekSpecOf(text) || (text.indexOf('周') >= 0 && isWeekText(text));
    }

    var DAY_CHARS = '一二三四五六日天';

    function dayOfLabel(value) {
        var m = /(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/.exec(clean(value));
        if (!m) return 0;
        var at = DAY_CHARS.indexOf(m[1]);
        if (at >= 0) return m[1] === '天' ? 7 : at + 1;
        return parseInt(m[1], 10);
    }

    function splitLines(text) {
        var pieces = String(text).split(/\r\n|\r|\n/);
        var out = [];
        for (var i = 0; i < pieces.length; i++) {
            var line = clean(pieces[i]);
            if (line) out.push(line);
        }
        return out;
    }

    function spanOf(cell) {
        var span = cell ? cell.span : undefined;
        return (typeof span === 'number' && span >= 1) ? span : 1;
    }

    // 取网格第 want 列上的格子：跨列的合并格在它覆盖到的列上都能取到
    function cellAtGridCol(row, want) {
        if (want < 0) return null;
        for (var i = 0; i < row.length; i++) {
            var start = row[i].col || 0;
            if (want >= start && want < start + spanOf(row[i])) return row[i];
        }
        return null;
    }

    // ---- 星期表头：没有课程的、能认出 ≥4 个星期标签的那一行（标签最多的一行胜出）----
    function findHeaderRow() {
        var best = { row: -1, labels: 0, cols: [0, -1, -1, -1, -1, -1, -1, -1] };
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r] || [];
            var hasCourse = false;
            var cols = [0, -1, -1, -1, -1, -1, -1, -1];
            var labels = 0;
            for (var c = 0; c < row.length; c++) {
                if (weekSpecOf(row[c].text)) hasCourse = true;
                var day = dayOfLabel(row[c].text);
                if (day < 1 || day > 7 || cols[day] >= 0) continue;
                cols[day] = row[c].col || 0;
                labels++;
            }
            if (hasCourse || labels < 4) continue;
            if (labels > best.labels) best = { row: r, labels: labels, cols: cols };
        }
        return best;
    }

    var header = findHeaderRow();
    var tableCols = Math.max(0, Math.floor(Number(data.cols) || 0));
    for (var tr = 0; tr < rows.length; tr++) {
        var prow = rows[tr] || [];
        for (var pc = 0; pc < prow.length; pc++) {
            var edge = (prow[pc].col || 0) + spanOf(prow[pc]);
            if (edge > tableCols) tableCols = edge;
        }
    }

    // 无表头兜底：整张表最后 7 列依次是星期一到星期日（上游「倒数第 7 列是周一」同义）
    var fallbackStart = tableCols > 7 ? tableCols - 7 : 0;

    // 星期 d 落在网格第几列：① 表头认出了这个天 → 用表头给的列号；② 否则按最后 7 列推；
    // ③ 推出来的列已经被别的天占了、或超出表宽 → 不猜，宁可少认一天（进提醒）。
    var dayCol = [0, -1, -1, -1, -1, -1, -1, -1];
    var usedCols = {};
    var guessedDays = 0;
    var unplacedDays = 0;
    var mismatchDays = 0;
    var d;
    for (d = 1; d <= 7; d++) {
        if (header.labels >= 4 && header.cols[d] >= 0) {
            dayCol[d] = header.cols[d];
            usedCols[dayCol[d]] = true;
            if (tableCols > 7 && dayCol[d] !== fallbackStart + d - 1) mismatchDays++;
        }
    }
    for (d = 1; d <= 7; d++) {
        if (dayCol[d] >= 0) continue;
        var guess = fallbackStart + d - 1;
        if (guess < 0 || (tableCols > 0 && guess >= tableCols) || usedCols[guess]) {
            unplacedDays++;
            continue;
        }
        dayCol[d] = guess;
        usedCols[guess] = true;
        guessedDays++;
    }

    // ---- 课表页左侧节次列里的时间：一行里只有一个单节次号与一个时间范围时记下来 ----
    var TIME_RANGE = /([01]?[0-9]|2[0-3]):([0-5][0-9])\s*[-—~至到]\s*([01]?[0-9]|2[0-3]):([0-5][0-9])/;
    var PERIOD_ONLY = /^第?\s*([0-9]{1,2})\s*节?$/;

    function collectPageTimes() {
        var map = {};
        var firstDayCol = tableCols;
        for (var i = 1; i <= 7; i++) {
            if (dayCol[i] >= 0 && dayCol[i] < firstDayCol) firstDayCol = dayCol[i];
        }
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r] || [];
            var ranges = [];
            var labels = [];
            for (var c = 0; c < row.length; c++) {
                if ((row[c].col || 0) >= firstDayCol) continue;
                var text = clean(row[c].text);
                var m = TIME_RANGE.exec(text);
                if (m) {
                    ranges.push({
                        start: pad2(parseInt(m[1], 10)) + ':' + m[2],
                        end: pad2(parseInt(m[3], 10)) + ':' + m[4]
                    });
                }
                var pm = PERIOD_ONLY.exec(text);
                if (pm) labels.push(parseInt(pm[1], 10));
            }
            if (ranges.length !== 1 || labels.length !== 1) continue;
            var period = labels[0];
            if (period < 1 || period > MAX_PERIOD || map[period]) continue;
            if (minutesOf(ranges[0].start) < 0 || minutesOf(ranges[0].end) <= minutesOf(ranges[0].start)) continue;
            map[period] = ranges[0];
        }
        return map;
    }

    // ---- 解析一格：先用 5 个以上连字符切块，再逐块认课名 / 教师 / 周次 / 节次 / 地点 ----
    var seenBlocks = {};
    var order = [];
    var byCourse = {};
    var maxWeek = 0;
    var maxPeriod = 0;

    function addBlock(name, teacher, day, start, end, weeks, location) {
        var uid = name + '|' + day + '|' + start + '|' + end + '|' + weeks.join(',');
        if (seenBlocks[uid]) return;
        seenBlocks[uid] = true;
        var key = '@' + name + '|' + (teacher || '');
        var course = byCourse[key];
        if (!course) {
            course = { name: name, teacher: teacher, buckets: [] };
            byCourse[key] = course;
            order.push(key);
        }
        var runs = runsOf(weeks);
        for (var i = 0; i < runs.length; i++) {
            course.buckets.push({
                dayOfWeek: day,
                startPeriod: start,
                endPeriod: end,
                startWeek: runs[i].start,
                endWeek: runs[i].end,
                weekType: runs[i].weekType,
                location: location
            });
        }
        if (end > maxPeriod) maxPeriod = end;
        if (weeks[weeks.length - 1] > maxWeek) maxWeek = weeks[weeks.length - 1];
    }

    function parseBlock(blockText, day) {
        var lines = splitLines(blockText);
        var wi = -1;
        var spec = null;
        var i;
        for (i = 0; i < lines.length; i++) {
            var found = weekSpecOf(lines[i]);
            if (found) {
                wi = i;
                spec = found;
                break;
            }
        }
        // 上游：行数不足 4 时把整块按空白再拆一次（「课名 教师 1-16(单)[01-02节] 教室」写在一行）
        if (wi < 0) {
            var tokens = clean(blockText).split(/\s+/);
            for (i = 0; i < tokens.length; i++) {
                var foundInToken = weekSpecOf(tokens[i]);
                if (foundInToken) {
                    lines = tokens;
                    wi = i;
                    spec = foundInToken;
                    break;
                }
            }
        }
        if (wi < 0) {
            noWeekBlocks++;
            noteUnrecognized(lines.length ? lines[0] : clean(blockText));
            return;
        }
        if (wi === 0) {
            noNameBlocks++;
            noteUnrecognized('');
            return;
        }
        var name = clean(lines[0]).replace(/[\[［][^\]］]*[\]］]/g, '').trim();
        if (!name) {
            noNameBlocks++;
            noteUnrecognized('');
            return;
        }
        var teacher = wi >= 2 ? blankValue(lines[1]) : null;
        if (teacher && looksLikeWeekText(teacher)) teacher = null;

        var location = null;
        if (spec.tail) location = blankValue(spec.tail);
        if (!location && wi + 1 < lines.length) location = blankValue(lines[wi + 1]);
        if (location && looksLikeWeekText(location)) location = null;

        var weeks = weeksOf(spec.weeksText);
        if (!weeks.length) {
            noWeekBlocks++;
            noteUnrecognized(name);
            return;
        }

        var numbers = spec.sectionsText.match(/[0-9]+/g) || [];
        var sections = [];
        for (i = 0; i < numbers.length; i++) {
            var value = parseInt(numbers[i], 10);
            if (isNaN(value) || value < 1 || value > MAX_PERIOD) {
                droppedSections++;
                continue;
            }
            sections.push(value);
        }
        sections = uniqueSorted(sections);
        if (!sections.length) {
            droppedSections++;
            return;
        }
        addBlock(name, teacher, day, sections[0], sections[sections.length - 1], weeks, location);
    }

    // 表头 / 图例 / 备注行不是课程行（ecjtu「短行当课程行」修正的移植；本适配器的行是稀疏的，
    // 只交有字的格，所以按「一格且没有周次节次」判，不能照抄 ecjtu 的 <7 格）：
    //   · 只有一格的标题 / 图例 / 备注行；
    //   · 整行非空字全是星期名 —— 表头只认出 1-3 个星期标题时 findHeaderRow 不认它，这里兜住。
    function rowHasWeekSpec(row) {
        for (var i = 0; i < row.length; i++) {
            var lines = splitLines(row[i].text);
            for (var k = 0; k < lines.length; k++) {
                if (weekSpecOf(lines[k])) return true;
            }
        }
        return false;
    }

    function headerLikeRow(row) {
        var labels = 0;
        for (var i = 0; i < row.length; i++) {
            var lines = splitLines(row[i].text);
            var isDay = lines.length === 1 && dayOfLabel(lines[0]) >= 1;
            if (!isDay) {
                for (var k = 0; k < lines.length; k++) {
                    if (weekSpecOf(lines[k])) return false;
                }
                continue;
            }
            labels++;
        }
        return labels > 0;
    }

    for (var ri = 0; ri < rows.length; ri++) {
        if (ri === header.row) continue;
        var row = rows[ri] || [];
        if ((row.length < 2 && !rowHasWeekSpec(row)) || headerLikeRow(row)) continue;
        for (var dd = 1; dd <= 7; dd++) {
            var cell = cellAtGridCol(row, dayCol[dd]);
            if (!cell || spanOf(cell) !== 1) continue;
            var cellText = String(cell.text || '');
            if (!cellText) continue;
            var blocks = cellText.split(/-{5,}/);
            for (var bi = 0; bi < blocks.length; bi++) {
                // 不把换行折成空格：块里的行结构是「课名 / 教师 / 周次节次 / 地点」的判据
                var block = String(blocks[bi]).replace(/^\s+|\s+$/g, '');
                if (!block) continue;
                parseBlock(block, dd);
            }
        }
    }

    if (!order.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，或教务页面结构有变化，' +
            '请确认教务系统的「学期理论课表」页面能正常显示后再点「提取课表」'
        );
    }

    // ---- 汇总成载荷课程 ----
    var courses = [];
    for (var oi = 0; oi < order.length; oi++) {
        var built = byCourse[order[oi]];
        var blocks = built.buckets.slice(0);
        blocks.sort(function (a, b) {
            return a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod ||
                a.startWeek - b.startWeek || a.endPeriod - b.endPeriod;
        });
        if (!blocks.length) continue;
        var noRoom = false;
        for (var bk = 0; bk < blocks.length; bk++) {
            if (!blocks[bk].location) noRoom = true;
        }
        if (!built.teacher) missingTeacher.push(built.name);
        if (noRoom) missingRoom.push(built.name);
        courses.push({
            name: built.name,
            teacher: built.teacher,
            note: null,
            blocks: blocks
        });
    }

    // ---- 总周数：默认 20，课表出现更晚的周才抬高 ----
    var totalWeeks = maxWeek > DEFAULT_TOTAL_WEEKS ? maxWeek : DEFAULT_TOTAL_WEEKS;
    var raisedTotalWeeks = totalWeeks > DEFAULT_TOTAL_WEEKS;

    // ---- 节次时间：课表页给的就用；没给的用应用自带的 12 节；更晚的节次按 H3 顺推 ----
    var pageTimes = collectPageTimes();
    var fromPage = false;
    for (var pageKey in pageTimes) {
        fromPage = true;
        break;
    }
    var fallbackFilled = 0;
    var periodTimes = [];
    var p;
    for (p = 1; p <= PERIOD_COUNT; p++) {
        if (fromPage && pageTimes[p]) {
            periodTimes.push({ periodIndex: p, start: pageTimes[p].start, end: pageTimes[p].end });
        } else {
            var fb = FALLBACK_PERIOD_TIMES[p - 1];
            periodTimes.push({ periodIndex: p, start: fb.start, end: fb.end });
            if (fromPage) fallbackFilled++;
        }
    }
    var filledBySequence = [];
    var uncoveredFrom = 0;
    for (p = PERIOD_COUNT + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        var prevEnd = minutesOf(prev.end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (prevEnd < 0 || nextEnd > 23 * 60 + 59) {
            uncoveredFrom = p;
            break;
        }
        periodTimes.push({ periodIndex: p, start: clockText(nextStart), end: clockText(nextEnd) });
        filledBySequence.push(p);
    }

    // ---- 开学日：本页没有，按提取当天回退到周一推算 ----
    var firstDay = mondayOf(data.now);
    if (!firstDay) {
        throw new Error('提取数据里缺少提取日期，无法推算开学日期：请在课表页重新点「提取课表」');
    }

    // ---- 学期名：教务给的学年学期；拿不到用学校名 + 学年学期 ----
    function termNameFromCode(code) {
        var m = /^([0-9]{4})-([0-9]{4})-([0-9])$/.exec(clean(code));
        if (!m) return '';
        var suffix = m[3] === '1' ? '第一学期' : (m[3] === '2' ? '第二学期' : '第' + m[3] + '学期');
        return m[1] + '-' + m[2] + '学年' + suffix;
    }

    function termNameFromDate(isoDate) {
        var m = /^([0-9]{4})-([0-9]{1,2})/.exec(clean(isoDate));
        if (!m) return '';
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var first = month >= 8 || month === 1;
        var startYear = month >= 8 ? year : year - 1;
        return SCHOOL_NAME + ' ' + startYear + '-' + (startYear + 1) + ' 学年' + (first ? '第一学期' : '第二学期');
    }

    var termName = clean(term.name);
    if (/^请选择/.test(termName) || /^--/.test(termName)) termName = '';
    if (!termName) termName = termNameFromCode(term.code);
    if (!termName) {
        termName = termNameFromDate(data.now);
        if (termName) {
            warn('没能识别出学年学期名称，学期名已按「' + shortName(termName) + '」生成，请在「学期管理」里核对');
        }
    }
    if (!termName) termName = SCHOOL_NAME + '课表';

    // ---- 提醒：推算的、补齐的、缺的、丢的，逐类汇总 ----
    warn('开学日期无法从教务获取，已按最近的周一（' + firstDay + '）推算，请在「学期管理」里核对');
    if (raisedTotalWeeks) {
        warn('课表里有第 ' + totalWeeks + ' 周的课：学期总周数已按 ' + totalWeeks +
            ' 周导入，请在「学期管理」里核对');
    } else {
        warn('教务页面不提供学期总周数：已按 ' + totalWeeks + ' 周导入（课表里最晚排到第 ' +
            maxWeek + ' 周），请在「学期管理」里核对');
    }
    if (fromPage) {
        warn('节次时间取自课表页的节次列' +
            (fallbackFilled > 0 ? '，页面没有给出的节次用应用自带的时间补齐' : '') +
            '，请核对是否与学校实际上下课时间一致');
    } else {
        warn('教务页面没有给出节次时间，已按应用自带的 ' + PERIOD_COUNT +
            ' 节节次时间导入（第 1 节 ' + FALLBACK_PERIOD_TIMES[0].start + '-' + FALLBACK_PERIOD_TIMES[0].end +
            '），与学校实际上下课时间不同时请在「学期管理」里改成学校的节次时间');
    }
    if (filledBySequence.length) {
        var fillFrom = filledBySequence[0];
        var fillTo = filledBySequence[filledBySequence.length - 1];
        warn('课表用到了第 ' + fillFrom + (fillTo > fillFrom ? ' 至 ' + fillTo : '') +
            ' 节，现有节次时间没有覆盖，已按上一节下课后课间 ' + EXTEND_BREAK_MINUTES +
            ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推补上，请在「学期管理」里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK +
            ' 周，已按脏数据丢弃（教务给出的周次不正常）');
    }
    if (droppedSections > 0) {
        warn('有 ' + droppedSections + ' 个节次超出 1-' + MAX_PERIOD +
            ' 节，已按脏数据丢弃（教务给出的节次不正常）');
    }
    var unrecognized = noNameBlocks + noWeekBlocks;
    if (unrecognized > 0) {
        warn('有 ' + unrecognized + ' 处课程没能解析出来（例如「' + unrecognizedNames.join('、') +
            '」），已跳过：教务页面结构可能已调整，欢迎反馈');
    }
    if (missingTeacher.length) {
        warn('有 ' + missingTeacher.length + ' 门课没读到教师（例如 ' +
            shortNamesOf(missingTeacher) + '），已按空值导入，可在「编辑课程」里补上');
    }
    if (missingRoom.length) {
        warn('有 ' + missingRoom.length + ' 门课没读到教室（例如 ' +
            shortNamesOf(missingRoom) + '），已按空值导入，可在「编辑课程」里补上');
    }
    if (header.labels < 4) {
        warn('课表顶部没有认出星期几的标题，已按课表最右边 7 列依次对应星期一到星期日导入，请核对');
    } else if (unplacedDays > 0 || guessedDays > 0) {
        warn('课表顶部只认出了部分星期标题，其余已按课表最右边 7 列推断，请核对');
    } else if (mismatchDays > 0) {
        warn('课表顶部的星期标题与课表最右边 7 列对不上，已按标题对齐，请核对');
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
