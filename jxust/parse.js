(function () {
    // 江西理工大学（强智 · 高校综合管理教务系统，学生端 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 JXUST/jxust.js（MIT，作者 星河欲转）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游核心是 parseWeeks() + parseCourseTable()：读 #kbtable 里每个格子的第二个 div（querySelectorAll('div')[1]）
    // 作为明细，按 font[title="老师"] / font[title="周次(节次)"] / font[title="教室"] 取字段；周次文本形如 "1-9,11-17(周)[01-02节]"。
    // 上游的坑逐条改掉，改不掉的都进 warnings，不静默：
    //   ① 单双周：上游去掉 "(周)" 与 "[..节]" 后按逗号切分，只有 "1-16" 这种段能展开成区间，其余段
    //      直接 parseInt 取第一个数字。"1-15(单周)" 因此只剩第 1 周，"2-16(双周)" 只剩第 2 周（不是「每周都上」）。
    //      这里认括号里外的单 / 双 / 单双周，单周、双周各成一段 ODD / EVEN；
    //   ② 括号里的纯数字（如 "(1)"）是序号，不是周次：忽略并计数，只剩序号的块跳过并出声；
    //   ③ 上游节次不读括号，只看行号（第 1 到 5 行依次为 1-2、3-4、5-6、7-8、9-10，之后的行直接跳过）；
    //      格内的 [03-04节] 之类只被当作噪声去掉。这里格内写了节次就用，认不出回落到所在行的节次标签；
    //      再不行，前 5 行按行号回落并出声；
    //   ④ 上游按格子序号硬算星期（第 j 个 td 就是周 j+1），节次列在前时整表错一天。这里按表头
    //      「星期一…星期日」的网格列对应（与 hynu 同一做法）；
    //   ⑤ 作息表照搬上游的 10 节；超出 1–10 节的节次进 warnings，不替教务猜时间；
    //   ⑥ 总周数默认 20，课表里有更晚的周次时抬高并说明（上游超了也不说）；
    //   ⑦ 周次上限 30（上游没有上限）：超过的周次截到第 30 周，并说明。
    //
    // 输入（extract.js 的输出）：
    //   { now: "2026-09-12", term: { code, name, source }, rows: [ [ { text, parts, col, span }, … ], … ] }
    // 纯函数：只做字符串与正则，CI 的 Rhino 里没有 DOM。
    var data = JSON.parse(__ncInput);
    var grid = data.rows || [];
    var term = data.term || {};

    // 作息表：上游 saveAppTimeSlots 写死的 10 节，逐条照搬
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:30', end: '09:15' },
        { periodIndex: 2, start: '09:20', end: '10:05' },
        { periodIndex: 3, start: '10:25', end: '11:10' },
        { periodIndex: 4, start: '11:15', end: '12:00' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:50', end: '15:35' },
        { periodIndex: 7, start: '15:55', end: '16:40' },
        { periodIndex: 8, start: '16:45', end: '17:30' },
        { periodIndex: 9, start: '19:00', end: '19:45' },
        { periodIndex: 10, start: '19:50', end: '20:35' }
    ];
    // 行号回落：没有节次标签、格子里也没写节次的课，前 5 行按上游的 sectionMap 对应
    var SECTIONS_BY_ROW = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];
    var DEFAULT_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;
    var MAX_PERIOD = 30;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;
    var SEP = String.fromCharCode(31);
    var DAY_OF = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7, '七': 7 };
    var PLACEHOLDER = /^(未知|待定|暂无|无)(教师|地点|教室|课程)?$/;

    var warnings = [];
    var issueKinds = [];
    var issueCount = {};
    var issueSamples = {};
    var courses = [];
    var courseByKey = {};
    var blockSeen = {};
    var maxWeek = 0;
    var serialTotal = 0;
    var blocksSeen = 0;
    var firstBlockName = '';

    // 整体提醒（学期、开学日推算、总周数这类）：直接进 warnings，排在前面，不会被块级问题挤掉
    function warn(message) {
        var text = String(message);
        if (text.length > MAX_WARNING_CHARS) text = text.substring(0, MAX_WARNING_CHARS - 1) + '…';
        warnings.push(text);
    }

    // 块级问题（某门课的周次、节次读不出等）：按类型计数，每类只留两个样本，最后合成一条
    function issue(kind, sample) {
        if (!issueCount[kind]) {
            issueCount[kind] = 0;
            issueSamples[kind] = [];
            issueKinds.push(kind);
        }
        issueCount[kind]++;
        if (sample && issueSamples[kind].length < 2) issueSamples[kind].push(clip(sample, 30));
    }

    function clip(value, max) {
        var text = String(value).replace(/\s+/g, ' ').trim();
        return text.length > max ? text.substring(0, max - 1) + '…' : text;
    }

    function samplesOf(kind) {
        var list = issueSamples[kind];
        if (!list.length) return '';
        var quoted = [];
        for (var i = 0; i < list.length; i++) quoted.push('「' + list[i] + '」');
        return '（如' + quoted.join('、') + '）';
    }

    function issueLine(kind) {
        var n = issueCount[kind];
        var s = samplesOf(kind);
        if (kind === 'noName') return '有 ' + n + ' 门课没有写课程名，已跳过';
        if (kind === 'rowNumber') return '有 ' + n + ' 门课的节次教务没写，也没有节次标签，已按所在行的行号对应' + s + '，请核对';
        if (kind === 'noPeriods') return '有 ' + n + ' 门课的节次认不出，已跳过' + s;
        if (kind === 'badBracket') return '有 ' + n + ' 门课的节次写法认不出，已按所在行的节次对应' + s + '，请核对';
        if (kind === 'discontinuous') return '有 ' + n + ' 门课的节次不连续，已按首尾节次记' + s;
        if (kind === 'beyondTimes') return '有 ' + n + ' 门课排在内置作息表（只有 1–' + PERIOD_TIMES.length + ' 节）以外的节次，时间请在学期管理里核对' + s;
        if (kind === 'clamped') return '有 ' + n + ' 门课的周次超过第 ' + MAX_WEEK + ' 周，已截到第 ' + MAX_WEEK + ' 周' + s;
        if (kind === 'badSeg') return '有 ' + n + ' 门课的周次里有段认不出，已忽略那几段' + s;
        if (kind === 'serialOnly') return '有 ' + n + ' 门课的周次只写了括号里的序号（如 (1)），没有周次，已跳过' + s;
        return '有 ' + n + ' 门课的周次没认出来，已跳过' + s;
    }

    // 整体提醒在前，块级类型各合成一条；总数仍 ≤ MAX_WARNINGS，超了最后一条写汇总
    function finishWarnings() {
        var lines = [];
        for (var i = 0; i < issueKinds.length; i++) lines.push(issueLine(issueKinds[i]));
        var room = MAX_WARNINGS - warnings.length;
        if (lines.length <= room) return warnings.concat(lines);
        var kept = warnings.concat(lines.slice(0, room - 1));
        kept.push('另有 ' + (lines.length - room + 1) + ' 类提示未显示，请以教务页面为准');
        return kept;
    }

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function decodeEntities(text) {
        return text.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&');
    }

    function plainOf(html) {
        return clean(decodeEntities(String(html).replace(/<[^>]*>/g, '')));
    }

    function uniqueSorted(list) {
        var sorted = list.slice().sort(function (a, b) { return a - b; });
        var out = [];
        for (var i = 0; i < sorted.length; i++) {
            if (i === 0 || sorted[i] !== sorted[i - 1]) out.push(sorted[i]);
        }
        return out;
    }

    // 取 <font title="…">…</font> 里的文字；title 原样匹配（上游用 老师 / 教室 / 周次(节次)）
    function fontText(html, title) {
        var at = html.indexOf('title="' + title + '"');
        if (at < 0) return '';
        var open = html.indexOf('>', at);
        var close = open < 0 ? -1 : html.indexOf('</font>', open);
        if (close < 0) return '';
        return plainOf(html.substring(open + 1, close));
    }

    // 占位文字（未知教师、暂无教室 …）一律当没有，写 null，不当真名真地点
    function realText(value) {
        var t = clean(value);
        if (!t || PLACEHOLDER.test(t)) return null;
        return t;
    }

    function teacherOf(html) {
        var raw = fontText(html, '老师') || fontText(html, '教师');
        return realText(raw.replace(/^任课教师\s*[:：]\s*/, ''));
    }

    // 课程名：块里第一行（第一个 br 之前），字体标签之前的部分；span 整段去掉，与上游一致
    function nameOf(html) {
        var line = html.split(/<br\s*\/?>/i)[0];
        var at = line.indexOf('<font');
        if (at >= 0) line = line.substring(0, at);
        line = line.replace(/<span[^>]*>[\s\S]*?<\/span>/gi, '');
        var name = plainOf(line);
        return name === '未知课程' ? '' : name;
    }

    // 一格里可能有几门课，中间用一串「-」分开
    function blocksOf(html) {
        var pieces = String(html).split(/-{10,}/);
        var out = [];
        for (var i = 0; i < pieces.length; i++) {
            var block = pieces[i].replace(/^(\s|&nbsp;|<br\s*\/?>)+/i, '').replace(/(\s|&nbsp;|<br\s*\/?>)+$/i, '');
            if (plainOf(block)) out.push(block);
        }
        return out;
    }

    // 单 / 双 / 单双周 → ODD / EVEN / ALL；其它返回 null
    function parityOf(text) {
        if (text.indexOf('单双') >= 0) return 'ALL';
        if (text.indexOf('单') >= 0) return 'ODD';
        if (text.indexOf('双') >= 0) return 'EVEN';
        return null;
    }

    // 周次文本 → { items: [{ week, type }], serial, bad, clamped }
    // 按段（逗号分开）认：每段的单 / 双标记括号里外都行；括号里的纯数字是序号，不是周次
    function weeksOf(text) {
        var out = { items: [], serial: 0, bad: [], clamped: false };
        var parts = String(text).replace(/\[[^\]]*\]/g, ' ').split(/[,，、]/);
        for (var p = 0; p < parts.length; p++) {
            var seg = clean(parts[p]);
            if (!seg) continue;
            var mark = null;
            var rest = seg.replace(/[(（]([^)）]*)[)）]/g, function (all, inner) {
                var t = clean(inner);
                if (/^\d+$/.test(t)) {
                    out.serial++;
                    return ' ';
                }
                var inside = parityOf(t);
                if (inside) mark = inside;
                return ' ';
            });
            var outside = parityOf(rest);
            if (outside) {
                mark = outside;
                rest = rest.replace(/单双|单|双/g, ' ');
            }
            rest = clean(rest.replace(/周/g, ''));
            if (!rest) {
                if (mark) out.bad.push(seg);
                continue;
            }
            var range = /^(\d+)(?:\s*[-－~～]\s*(\d+))?$/.exec(rest);
            if (!range) {
                out.bad.push(seg);
                continue;
            }
            var start = parseInt(range[1], 10);
            var end = range[2] ? parseInt(range[2], 10) : start;
            if (end < start) {
                out.bad.push(seg);
                continue;
            }
            var type = mark || 'ALL';
            if (end > MAX_WEEK) {
                out.clamped = true;
                end = MAX_WEEK;
            }
            for (var w = start; w <= end; w++) {
                if (w < 1) continue;
                if (type === 'ODD' && w % 2 === 0) continue;
                if (type === 'EVEN' && w % 2 === 1) continue;
                out.items.push({ week: w, type: type });
            }
        }
        return out;
    }

    // 把 [{ week, type }] 合成 startWeek / endWeek 段：ALL 按相邻周合并，ODD / EVEN 隔一周合并
    function runsOf(items) {
        var out = [];
        var order = ['ALL', 'ODD', 'EVEN'];
        for (var t = 0; t < order.length; t++) {
            var weeks = [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].type === order[t]) weeks.push(items[i].week);
            }
            weeks = uniqueSorted(weeks);
            var step = order[t] === 'ALL' ? 1 : 2;
            var start = null;
            var last = null;
            for (var k = 0; k < weeks.length; k++) {
                if (start === null) {
                    start = weeks[k];
                } else if (weeks[k] !== last + step) {
                    out.push({ startWeek: start, endWeek: last, weekType: order[t] });
                    start = weeks[k];
                }
                last = weeks[k];
            }
            if (start !== null) out.push({ startWeek: start, endWeek: last, weekType: order[t] });
        }
        return out;
    }

    // 节次文本 → 升序节次列表；认不出返回 null。认：01-02节 / 01-03 / 03-04-05 / 0102 / 030405 / 第9,10节 / 第3节。
    // 全角冒号先归成半角，「14:00-15:35」这类时间整段去掉，免得时间里的数字被当成节次；
    // 4 位及以上且偶数位的纯数字按两位一节拆开（0102 → 1、2；030405 → 3、4、5）；
    // 任何一个数超过 MAX_PERIOD、或区间缺一端，都整段认不出（不默默丢掉其中一个数）
    function periodsOf(text) {
        var t = clean(text).replace(/：/g, ':');
        t = t.replace(/\d{1,2}\s*:\s*\d{2}(\s*[-－~～]\s*\d{1,2}\s*:\s*\d{2})?/g, ' ');
        t = t.replace(/[第节]/g, '').trim();
        if (!/\d/.test(t)) return null;
        var list = [];
        var parts = t.split(/[,，、]/);
        for (var p = 0; p < parts.length; p++) {
            var seg = clean(parts[p]);
            var nums = seg.match(/\d+/g);
            if (!nums) return null;
            var isRange = /[-－~～]/.test(seg);
            if (nums.length > 1 && !isRange) return null;
            if (!isRange) {
                var run = nums[0];
                if (run.length >= 4 && run.length % 2 === 0) {
                    // 拆出来的两位数必须连续：2026 拆成 20、26 不是连堂，整段认不出
                    var pairs = [];
                    for (var k = 0; k < run.length; k += 2) pairs.push(parseInt(run.substring(k, k + 2), 10));
                    for (var q = 0; q < pairs.length; q++) {
                        if (pairs[q] < 1 || pairs[q] > MAX_PERIOD) return null;
                        if (q > 0 && pairs[q] !== pairs[q - 1] + 1) return null;
                        list.push(pairs[q]);
                    }
                } else {
                    var single = parseInt(run, 10);
                    if (single < 1 || single > MAX_PERIOD) return null;
                    list.push(single);
                }
                continue;
            }
            // 区间两端都得有数：「1-」「-3」缺一端认不出。两个数是起止（「01-03」= 第 1 到 3 节）；
            // 三个数以上是强智逐节列出的连排（「01-02-03」），必须逐个相差 1，「03-05-07」不是连堂
            if (nums.length < 2) return null;
            if (nums.length > 2) {
                for (var j = 1; j < nums.length; j++) {
                    if (parseInt(nums[j], 10) !== parseInt(nums[j - 1], 10) + 1) return null;
                }
            }
            var a = parseInt(nums[0], 10);
            var b = parseInt(nums[nums.length - 1], 10);
            if (a < 1 || b > MAX_PERIOD || b < a) return null;
            for (var n = a; n <= b; n++) list.push(n);
        }
        if (!list.length) return null;
        return uniqueSorted(list);
    }

    // 周次文本里方括号的内容（上游把节次放在 [xx-yy节] 里）
    function bracketOf(text) {
        var m = /\[([^\]]*)\]/.exec(String(text));
        return m ? m[1] : '';
    }

    function dayOf(text) {
        var m = /^(星期|周)([一二三四五六日天七])$/.exec(clean(text));
        return m ? DAY_OF[m[2]] : 0;
    }

    // 表头：找到一行里至少 4 个「星期x」标签，记下每个标签所在的网格列
    function headerOf(rowsIn) {
        for (var r = 0; r < rowsIn.length; r++) {
            var cols = [];
            for (var c = 0; c < rowsIn[r].length; c++) {
                var day = dayOf(rowsIn[r][c].text);
                if (day) cols.push({ day: day, col: rowsIn[r][c].col, span: rowsIn[r][c].span });
            }
            if (cols.length >= 4) return { row: r, cols: cols };
        }
        return null;
    }

    // 没有表头：按表格总列数推算，最右 7 列是周一到周日；总列数不足 7 就推不出
    function guessCols(rowsIn) {
        var width = 0;
        for (var r = 0; r < rowsIn.length; r++) {
            for (var c = 0; c < rowsIn[r].length; c++) {
                width = Math.max(width, rowsIn[r][c].col + rowsIn[r][c].span);
            }
        }
        if (width < 7) return null;
        var first = width >= 8 ? width - 7 : 0;
        var cols = [];
        for (var d = 1; d <= 7; d++) cols.push({ day: d, col: first + d - 1, span: 1 });
        return cols;
    }

    // 表头只认出一部分天（周六、周日的表头格是空的，或周末合成了一格）：认出来的天定下网格列，
    // 缺的天按列的顺序往右补（星期一所在列往右依次是星期一到星期日）。补出来的天记在 guessed 里
    function completeCols(found) {
        var byDay = [null, null, null, null, null, null, null, null];
        var d;
        for (d = 0; d < found.length; d++) byDay[found[d].day] = found[d];
        var anchor = 0;
        for (d = 1; d <= 7 && !anchor; d++) {
            if (byDay[d]) anchor = d;
        }
        var base = byDay[anchor].col - (anchor - 1);
        var out = [];
        var guessed = [false, false, false, false, false, false, false, false];
        for (d = 1; d <= 7; d++) {
            if (byDay[d]) {
                out.push(byDay[d]);
                continue;
            }
            var col = base + d - 1;
            var taken = false;
            for (var f = 0; f < found.length; f++) {
                if (found[f].col === col) taken = true;
            }
            if (col < 0 || taken) continue;
            out.push({ day: d, col: col, span: 1 });
            guessed[d] = true;
        }
        return { cols: out, guessed: guessed };
    }

    // 格子覆盖的星期列：合并格（如跨了周六、周日的「周末」）覆盖几天就算几天；覆盖不到星期列时返回空数组
    function daysAt(cols, col, span) {
        var out = [];
        for (var i = 0; i < cols.length; i++) {
            if (cols[i].col >= col && cols[i].col < col + span) out.push(cols[i].day);
        }
        return out;
    }

    function mondayOf(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        if (!m) throw new Error('提取日期无效：' + iso);
        var date = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        var back = (date.getDay() + 6) % 7;
        date = new Date(date.getFullYear(), date.getMonth(), date.getDate() - back);
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(code);
        if (!m) return '';
        var cn = { '1': '一', '2': '二', '3': '三' }[m[3]] || m[3];
        return m[1] + '-' + m[2] + '学年第' + cn + '学期';
    }

    // 学期名：教务给的文字优先；只有代码时拼「学校名 + 学年学期」；都没有才用通用名，并说明
    function termNameOf() {
        var name = clean(term.name);
        var code = clean(term.code);
        if (term.source === 'select-first') {
            warn('学期下拉框没有标出选中项，已取第一项「' + (name || code) + '」，请核对');
        }
        if (name) return name;
        var generated = termNameFromCode(code);
        if (generated) {
            warn('教务页面没给出学期名，已按学年学期代码生成「' + generated + '」，请核对');
            return '江西理工大学 ' + generated;
        }
        warn('没有认出学年学期，学期名与开学日都需要在学期管理里核对');
        return '江西理工大学课表';
    }

    // 对不上星期列的格子里若也有课：不导入，但要计入「一门课都没解析出来」的判断，免得误说成「还没排课」
    function countUnmatched(parts) {
        for (var p = 0; p < parts.length; p++) {
            var blocks = blocksOf(parts[p]);
            for (var b = 0; b < blocks.length; b++) {
                blocksSeen++;
                if (!firstBlockName) firstBlockName = nameOf(blocks[b]);
            }
        }
    }

    // 一门课的一个格子块：节次、周次、地点都在这里定，认不出的按 warnings 说清楚再跳过。
    // days 是格子覆盖的星期（合并格会有几天）：课记在每一天上，但提醒与计数只算一次
    function addBlock(html, days, labelPeriods, rowNumber) {
        var name = nameOf(html);
        blocksSeen++;
        if (!firstBlockName) firstBlockName = name;
        if (!name) {
            issue('noName');
            return;
        }
        var weeksText = fontText(html, '周次(节次)') || fontText(html, '周次');
        var teacher = teacherOf(html);
        var location = realText(fontText(html, '教室'));

        // 节次优先级：格子里方括号写的 > 所在行的节次标签 > 行号回落（前 5 行）
        // 方括号里写了却认不出：照样按标签或行号对应，但要说出来，不静默
        var bracket = bracketOf(weeksText);
        var periods = bracket ? periodsOf(bracket) : null;
        var bracketBad = !!bracket && !periods;
        if (!periods) periods = labelPeriods;
        var byRow = false;
        if (!periods && rowNumber < SECTIONS_BY_ROW.length) {
            periods = SECTIONS_BY_ROW[rowNumber];
            byRow = true;
        }
        if (!periods) {
            issue('noPeriods', name);
            return;
        }
        if (bracketBad) issue('badBracket', name);
        if (byRow) issue('rowNumber', name);
        var start = periods[0];
        var end = periods[periods.length - 1];
        if (end - start + 1 !== periods.length) issue('discontinuous', name);
        if (end > PERIOD_TIMES.length) issue('beyondTimes', name);

        var weeks = weeksOf(weeksText);
        serialTotal += weeks.serial;
        if (weeks.clamped) issue('clamped', name);
        var runs = runsOf(weeks.items);
        if (!runs.length) {
            issue(weeks.serial && !weeks.bad.length ? 'serialOnly' : 'noWeeks', name + '：' + (weeksText || '空'));
            return;
        }
        if (weeks.bad.length) issue('badSeg', name + '：' + weeks.bad.join('、'));

        var key = name + SEP + (teacher || '');
        var course = courseByKey[key];
        if (!course) {
            course = { name: name, teacher: teacher, note: null, blocks: [] };
            courseByKey[key] = course;
            courses.push(course);
        }
        for (var d = 0; d < days.length; d++) {
            for (var k = 0; k < runs.length; k++) {
                var block = {
                    dayOfWeek: days[d],
                    startPeriod: start,
                    endPeriod: end,
                    startWeek: runs[k].startWeek,
                    endWeek: runs[k].endWeek,
                    weekType: runs[k].weekType,
                    location: location
                };
                var seenKey = key + SEP + [days[d], start, end, block.startWeek, block.endWeek, block.weekType, location || ''].join(SEP);
                if (blockSeen[seenKey]) continue;
                blockSeen[seenKey] = true;
                course.blocks.push(block);
                if (block.endWeek > maxWeek) maxWeek = block.endWeek;
            }
        }
    }

    // ── 主流程 ──
    var header = headerOf(grid);
    var filled = header ? completeCols(header.cols) : null;
    var cols = header ? filled.cols : guessCols(grid);
    if (!cols && grid.length) {
        throw new Error('课表表格里找不到「星期一…星期日」表头，也推算不出星期列，无法解析');
    }
    if (!header && cols) {
        warn('没有找到「星期一…星期日」表头，已按表格最右 7 列推算星期，请核对课表');
    }
    var bodyStart = header ? header.row + 1 : 0;
    var bodyRows = 0;
    // 行标签只从第一个星期列左边、且没有课的格子里取；有课的格子绝不当标签
    var firstDayCol = 0;
    for (var fc = 0; cols && fc < cols.length; fc++) {
        if (fc === 0 || cols[fc].col < firstDayCol) firstDayCol = cols[fc].col;
    }
    // 有课内容、却对不上任何星期列的格子数：这些课没有导入，要说出来
    var unmatchedCells = 0;
    // 跨了几个星期列的合并格数：课会同时记在每一天，要提醒
    var spanCells = 0;
    for (var r = bodyStart; r < grid.length; r++) {
        var row = grid[r];
        var label = '';
        var c;
        for (c = 0; c < row.length; c++) {
            if (row[c].col < firstDayCol && !row[c].parts.length) label += ' ' + row[c].text;
        }
        var labelPeriods = periodsOf(label);
        var rowNumber = bodyRows;
        bodyRows++;
        for (c = 0; c < row.length; c++) {
            var days = daysAt(cols, row[c].col, row[c].span);
            if (!days.length) {
                if (row[c].parts.length) unmatchedCells++;
                countUnmatched(row[c].parts);
                continue;
            }
            if (days.length > 1 && row[c].parts.length) spanCells++;
            for (var p = 0; p < row[c].parts.length; p++) {
                var blocks = blocksOf(row[c].parts[p]);
                for (var b = 0; b < blocks.length; b++) {
                    addBlock(blocks[b], days, labelPeriods, rowNumber);
                }
            }
        }
    }

    if (filled) {
        var guessedDays = 0;
        for (var gd = 1; gd <= 7; gd++) {
            if (filled.guessed[gd]) guessedDays++;
        }
        var guessedBlocks = 0;
        for (var gi = 0; gi < courses.length; gi++) {
            for (var gb = 0; gb < courses[gi].blocks.length; gb++) {
                if (filled.guessed[courses[gi].blocks[gb].dayOfWeek]) guessedBlocks++;
            }
        }
        // 补推出来的天上一门课都没有，就没有会被算错的安排，不提醒（否则会写成「这 0 条安排…」）
        if (guessedDays > 0 && guessedBlocks > 0) {
            warn('星期表头只认出了 ' + header.cols.length + ' 天，剩下 ' + guessedDays + ' 天已按列的顺序推算：这 '
                + guessedBlocks + ' 条安排的星期可能不准，请核对');
        }
    }
    if (unmatchedCells > 0) {
        warn('有 ' + unmatchedCells + ' 个格子里有课，但对不上星期列，这几格的课没有导入，请核对');
    }
    if (spanCells > 0) {
        warn('有 ' + spanCells + ' 个格子跨了几个星期列（如合并的「周末」格），这几格的课已同时记在每一天，请核对');
    }

    var totalWeeks = DEFAULT_TOTAL_WEEKS;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        warn('课表里最晚是第 ' + maxWeek + ' 周，已把总周数从 ' + DEFAULT_TOTAL_WEEKS + ' 调到 ' + maxWeek + ' 周');
    }
    if (serialTotal > 0) warn('周次括号里的序号（如 (1)）已忽略 ' + serialTotal + ' 处，不当作周次');
    if (!courses.length) {
        // 一门课都没解析出来不能照样返回空课表：导入会把本地同名学期的课全部作废
        if (blocksSeen > 0) {
            throw new Error('课表里有 ' + blocksSeen + ' 门课一个都没能解析出来（如「' + (firstBlockName || '格式与预期不符') +
                '」）：教务页面结构可能已调整，欢迎反馈');
        }
        throw new Error('本学期没有解析到任何课程：可能是还没排课，或教务页面改了结构（也可能登录状态已失效）');
    }

    var termName = termNameOf();
    var firstDay = mondayOf(data.now);
    warn('开学日期教务页面没有给出，已按提取当天所在周的周一（' + firstDay + '）推算第 1 周，请在学期管理里核对');

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finishWarnings(),
        terms: [{
            name: termName,
            firstDay: firstDay,
            totalWeeks: totalWeeks,
            periodTimes: PERIOD_TIMES,
            courses: courses
        }]
    });
})()
