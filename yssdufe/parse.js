(function () {
    // 山东财经大学燕山学院（强智 · 高校综合管理教务系统 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 YSSDUFE/yssdufe_01.js（MIT，上游作者 星河欲转）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游的核心是 parseTimetableToModel() + parseWeeks()：读 #kbtable 每个格子里 div.kbcontent 的明细，
    // 课程名取第一个非空文本，font[title=老师|教师] / font[title=教室] / font[title=周次(节次)] 取教师、
    // 教室、周次与节次；开学日期与总周数来自教学周历（上游 fetchSemesterInfo()）。这里保持同一套字段来源。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 单双周不再丢：上游 parseWeeks() 是 weekStr.split('(')[0]，而 '(' 后面正是单双标记，
    //      "1-15(单周)[01-02节]" 会被读成每周都上。本件按「逗号 / 空白分段、每段各自判单双」重写，
    //      四种写法都认，认不出的按每周处理并进 warnings；
    //   ② 括号里只有数字 / 数字区间的是教学班序号（(1)、(1-2)），不当周次；
    //   ③ 星期按**网格列号**对齐（extract.js 交出 col / span），不按「第几个 td 就是星期几」；
    //   ④ 节次认逗号写法（[09,10节]）与两位连堂（[030405节]），节次超过 MAX_PERIOD（16 节）的块跳过并计数；
    //   ⑤ 上游的 mergeAndDistinctCourses() 不照搬：不按名字排序合并相邻节次，只去掉完全相同的重复块；
    //   ⑥ 上游静默丢掉的块（没课名 / 没周次 / 没节次 / 节次超范围）全部计数，其中前 5 个点名进 warnings；
    //   ⑦ 教师 / 教室拿不到就留空（null）；上游写「未知教师」「未知地点」，那会被当成真名显示；
    //   ⑧ 作息只有一张统一的 11 节表（上游 saveAppTimeSlots 的统一表），不问冬令时 / 夏令时；
    //   ⑨ 学期取课表页「学年学期」下拉框的选中项，不弹窗让用户从列表里选学期；
    //   ⑩ 学期名：教务的名称 → 学期代码拼的「2026-2027学年第一学期」→ 都没有才用「学校名当前学期」占位并出提醒；
    //   ⑪ 没有网格列号的格子跳过并计数（不按下标猜列）；课表页没有学年学期下拉框时出一条提醒。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，CI 的 Rhino 里没有 DOM）：
    //   { source, pageUrl, now: "2026-09-13", term: { code, name }, cols: 8,
    //     calendar: { found, rows: [ [ { col, text, title } ] ] },
    //     rows: [ [ { col, span, text, parts: [原始 HTML] } ] ] }
    //   pageUrl 只含协议、主机与路径（不含查询串，查询串里可能带学号）；
    //   screenTermMissing 为真：课表页上没有「学年学期」下拉框，屏幕上的课表属于哪一学期无法确认（见下面的提醒）。
    var data = JSON.parse(__ncInput);
    var rows;
    var term = data.term || {};
    var calendarRows;

    // 学校作息时间：11 节，一张统一的表（不分冬令时 / 夏令时）。数值照搬上游 saveAppTimeSlots()
    // 的统一作息表；相邻节次多数首尾相接（1-2 节 09:15、3-4 节 11:05、5-6 节 14:15、
    // 7-8 节 16:05、9-10 节 19:15），第 11 节是 100 分钟的晚间档（20:10-21:50）。
    var SLOT_TIMES = [
        '08:30-09:15', '09:15-10:00', '10:20-11:05', '11:05-11:50',
        '13:30-14:15', '14:15-15:00', '15:20-16:05', '16:05-16:50',
        '18:30-19:15', '19:15-20:00', '20:10-21:50'
    ];
    var PERIOD_COUNT = SLOT_TIMES.length;

    // 学期名的占位用的学校名：教务没给学期名时用「学校名 + 学年学期」；连学期代码也没有才用「学校名 + 当前学期」
    var SCHOOL_NAME = '山东财经大学燕山学院';

    // 节次上限：越过它一定是脏数据。这个数与占位公式是一对 —— 占位时刻写成 pad2(7 + 节次)，
    // 第 16 节 = 23:00-23:45 是最后一个还落在当天的档位，再往后补出来的就不是 HH:mm 了，
    // 而 JwPayloadCodec 的时间正则只收 00:00-23:59，那样的载荷整次导入都会被拒收。
    var MAX_PERIOD = 16;
    // 没有周历周数时的兜底总周数。上游是 semesterTotalWeeks = totalWeeks || 20（totalWeeks 取周历首列的最大周号，取不到才是 20）
    var FALLBACK_TOTAL_WEEKS = 20;
    // 载荷校验的总周数上限（1..30）：超过 30 的周次按脏数据丢弃并出声
    var MAX_WEEK = 30;
    // 载荷校验的上限：警告 ≤20 条、每条 ≤200 字（JwSchedulePayload.MAX_WARNINGS /
    // MAX_WARNING_TEXT，中文按 String.length 算，1 字 = 1）
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var MAX_MINUTE = 23 * 60 + 59;

    // 一个格子里放多门课时，教务用一长串减号分隔（上游写死 21/22 个，这里放宽到 5 个以上，
    // 全角减号也认）
    var DASHES = /-{5,}|－{5,}/;
    var TEACHER_TITLE = /^(老师|教师|任课教师|授课教师|教师姓名)$/;
    var ROOM_TITLE = /^(教室|上课地点|上课教室|地点|教室名称)$/;
    var COURSE_TITLE = /^(课程|课程名称|课程名|科目)$/;
    var TEACHER_PREFIX = /^(任课教师|授课教师|教师|老师)\s*[:：]\s*/;
    // 周次串里的括号：只有「周」字的一种是周字的正常写法（1-16(周)），
    // 只有数字 / 数字区间的一种是教学班序号（(1)、(1-2)），两种都不是单双标记
    var WEEK_PAREN = /^[周週]$/;
    var SERIAL_PAREN = /^\d{1,3}(\s*[-—~至,，、]\s*\d{1,3})*$/;
    // 周次串里的分段符：逗号 / 顿号 / 分号 / 空白（"1-16周 双" 的单双标记会被空白切成独立一段）
    var SEGMENT_SPLIT = /[\s,，、;；]+/;
    var DAY_CHARS = '一二三四五六日天';

    // 计数：全部要进 warnings —— 一个都不许静默丢
    var noNameBlocks = 0;
    var noWeekBlocks = 0;
    var noPeriodBlocks = 0;
    var overPeriodBlocks = 0;
    var droppedWeeks = 0;
    var ambiguousMarks = 0;
    var ambiguousSamples = [];
    var mergedCells = 0;
    var unmappedCells = 0;
    var noColCells = 0;
    var badTimes = 0;
    var droppedNames = [];

    // 没有网格列号的格子：跳过并计数（extract.js 总会交 col；缺了就不知道它在哪一天，不按数组下标猜）
    function withColOnly(grid) {
        var out = [];
        for (var r = 0; r < grid.length; r++) {
            var kept = [];
            for (var c = 0; c < grid[r].length; c++) {
                var col = grid[r][c] ? grid[r][c].col : undefined;
                if (typeof col === 'number' && col >= 0) kept.push(grid[r][c]);
                else noColCells++;
            }
            out.push(kept);
        }
        return out;
    }
    rows = withColOnly(data.rows || []);
    calendarRows = withColOnly((data.calendar && data.calendar.rows) || []);

    // 载荷里的核对提示。**一律经 pushWarning() 出去**：每条 ≤200 字（超了按码位截断加省略号）。
    // 一共 ≤20 条是载荷校验的硬上限：超过时由 finalWarnings() 收尾（前 19 条照常，第 20 条写成汇总），绝不静默丢。
    // 警告是给用户看的，宁可短，也不能把载荷本身弄坏。
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

    // 收尾：不超过 MAX_WARNINGS 条原样给出；超过时前 MAX_WARNINGS - 1 条照常，最后一条写成「另有 N 条提醒未列出」，
    // N 是没列出的条数。超上限不静默截断。
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

    // 某个日期所在那一周的周一。不用 Date.parse：Rhino 对 ISO 串的支持不齐。
    function mondayOf(isoDate) {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(clean(isoDate));
        if (!m) return null;
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        var back = (day.getDay() + 6) % 7;
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() - back));
    }

    function stripTags(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/<[^>]*>/g, '');
    }

    function decodeEntities(value) {
        return String(value)
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/g, '\'')
            .replace(/&amp;/gi, '&');
    }

    function plainText(value) {
        return clean(decodeEntities(stripTags(value)));
    }

    // 明细 HTML 里的 <font 属性>文本</font>，按出现顺序返回（title 属性可缺）。
    // 末尾的 </font> 允许缺失（教务页面的 <font> 偶尔不闭合），那时取到下一个 '<' 为止。
    var FONT_TAG = /<font\b([^>]*)>([\s\S]*?)(?:<\/font>|(?=<)|$)/gi;

    function fontsOf(blockHtml) {
        var html = String(blockHtml);
        var out = [];
        var m = FONT_TAG.exec(html);
        while (m) {
            var title = /title\s*=\s*["']?([^"'>]*)["']?/i.exec(m[1]);
            out.push({ title: clean(title ? title[1] : ''), text: plainText(m[2]) });
            m = FONT_TAG.exec(html);
        }
        FONT_TAG.lastIndex = 0;
        return out;
    }

    // 课程名：明细里第一个 <font> 之前的第一个非空文本行 —— 与上游「第一个非空文本节点」基本一致，差别是只在第一个 <font> 之前找（上游会越过 font 继续找）
    //（教务页面里课名就是 font 前面那段裸文本）。兜底一：没有 title 属性的 <font>
    //（移植时带进来的模板做法，YSSDUFE 上游没有这一步）；兜底二：显式标了课程名的字段（本件新增，上游没有）。
    // 都没认出来就返回空串，调用方会把它计数并点名（不静默丢）。
    function nameOf(blockHtml) {
        var html = String(blockHtml);
        var lines = html.split(/<font\b/i)[0].split(/<br\s*\/?>/i);
        for (var i = 0; i < lines.length; i++) {
            var line = plainText(lines[i]);
            if (line) return line;
        }
        var bare = /<font\b([^>]*)>([\s\S]*?)(?:<\/font>|(?=<)|$)/gi;
        var m = bare.exec(html);
        while (m) {
            if (!/title\s*=/i.test(m[1])) {
                var text = plainText(m[2]);
                if (text) return text;
            }
            m = bare.exec(html);
        }
        var fonts = fontsOf(html);
        for (var f = 0; f < fonts.length; f++) {
            if (COURSE_TITLE.test(fonts[f].title) && fonts[f].text) return fonts[f].text;
        }
        return '';
    }

    function titledText(fonts, pattern) {
        for (var i = 0; i < fonts.length; i++) {
            if (!pattern.test(fonts[i].title)) continue;
            var text = clean(fonts[i].text);
            if (text) return text;
        }
        return '';
    }

    // 上游把「任课教师:」前缀去掉，取不到就写「未知教师」。我们的 teacher / location 允许为空，
    // 空着比写「未知」好（「未知」会当成真名显示）。
    function teacherOf(fonts) {
        var text = titledText(fonts, TEACHER_TITLE);
        if (!text) return null;
        text = clean(text.replace(TEACHER_PREFIX, ''));
        if (!text || text === '未知教师' || text === '未知') return null;
        return text;
    }

    function roomOf(fonts) {
        var text = titledText(fonts, ROOM_TITLE);
        if (!text || text === '未知地点' || text === '未知') return null;
        return text;
    }

    // font[title="周次(节次)"] 的文本，本平台形如 "1-16周(单)[01-02节]"：
    //   周次 = 方括号**之外**那一段，节次 = 方括号里面那一小段。
    // 有的页面把括号写成全角【】，或者压根没有方括号（整串都是周次），两种都认。
    // 方括号里的内容只有能读成节次时才算节次 —— 读不成节次就把方括号整段去掉只当周次看，
    // **但里面的单双标记必须摘出来**：从前是无条件整段删掉，于是 "1-16周[单]"
    //（正是这句注释点名的写法）会塌成 "1-16周"，单周标记一声不吭地没了 → 每周都上。
    // 一个字段里可能有两段方括号（"1-16周[单][01-02节]"）：挨段看，读得成节次的当节次
    //（取第一段读得成的），读不成的只摘出单 / 双标记 —— replace 按位置就地留标记，
    // 标记自然绑到最近的那一段周次上（"1-8周[双],10-16周[单]" 两段各判各的）。
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

    // 方括号里读不成节次的那一段，只把单 / 双标记摘出来（其余整段丢掉）。
    // 两个标记都写了（"[单双]"）就原样留下两个 —— 让 weeksIn 判成「认不出」并按周处理 + 出声，
    // 与 "(单双)" 的写法一个口径，不许静默。
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

    // 一个课程块里的「周次(节次)」字段：本平台一个块里就一个，但同一格里写两段
    //（1-8周[…] / 10-16周[…]）也见过 —— 挨个读，不丢。只有「节次」字段的补给它前面那一段。
    function specsOf(blockHtml) {
        var fonts = fontsOf(blockHtml);
        var out = [];
        var onlyPeriods = '';
        for (var i = 0; i < fonts.length; i++) {
            var title = fonts[i].title;
            var text = clean(fonts[i].text);
            if (!text) continue;
            var isWeek = title.indexOf('周次') >= 0;
            var isPeriodOnly = !isWeek && /^节次$/.test(title);
            if (!isWeek && !isPeriodOnly) continue;
            if (isPeriodOnly) {
                if (!onlyPeriods) onlyPeriods = text;
                continue;
            }
            out.push(splitSpec(text));
        }
        if (out.length && !out[0].periods && onlyPeriods) out[0].periods = onlyPeriods;
        return out;
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

    // 认不出单双的周次段：记样本（最多 3 条）与总数，最后进 warnings
    function noteAmbiguous(segment) {
        ambiguousMarks++;
        var text = clean(segment);
        if (!text || ambiguousSamples.indexOf(text) >= 0) return;
        if (ambiguousSamples.length >= 3) return;
        ambiguousSamples.push(text);
    }

    // 周次串 → 周次数组。本平台**自己的**写法（四种都要认，见文件头 ①②）：
    //   1-16周(单)        单双写在「周」字后面（本平台的主要形态，上游正是在这里丢标记）
    //   (单)1-16周        单双写在数字前面
    //   1-16(单周)        单双写在括号里
    //   1-3,5-9周         多段混排，每段**各自**判单双
    //   1-8周(单),10-16周(双)   两段的单双不一样（先分段再判，不许被前一段带走）
    //   双周2-16 / 1-16周 双     单双标在数字前面、或被空白切成独立一段
    //   1-16周(1) / (1-2)1-16周  括号里只有数字 / 数字区间的是教学班序号，不是周次
    //   1-16(周)          「周」字写在括号里（正常形态，不能当序号否掉）
    //   第3周 / 1-16周(单双) / 1-16周隔周
    // 最后一种（单双两个标记同时出现、或只写「隔周」）定不下来上哪几周：按「每周都上」处理，
    // 但**一定出声**（noteAmbiguous），不许静默改写。
    function weeksIn(source) {
        var text = clean(source);
        if (!text) return [];
        // 方括号 / 【】里的是节次（"1-16周[01-02节]"）：整段去掉，免得节次的数字被当成周次
        text = text.replace(/[\[【][^\]】]*[\]】]/g, ' ');
        // 括号逐个看：只有「周」字的、只有数字 / 数字区间的整段抹掉，其余（单双标记）留着
        text = text.replace(/[（(]([^）)]*)[)）]/g, function (whole, inner) {
            var body = clean(inner);
            if (!body) return ' ';
            if (WEEK_PAREN.test(body)) return ' ';
            if (SERIAL_PAREN.test(body)) return ' ';
            return whole;
        });
        // 区间分隔符**先归一**：全角波浪 ～(U+FF5E)、全角减 －(U+FF0D)、数学减 −(U+2212)、
        // en dash –、em dash —、ASCII ~、以及「至 / 到」一律当 '-' 使。
        // 不归一的话下面取区间的字符类收不到它们，会落到「单数字回退」把 "1～16周"
        // 静默读成「只上第 1 周」（w1-1），一声不吭。
        text = text.replace(/[～－−–—~至到]/g, '-');
        // 区间两端的空白吃掉（"1 - 16 周"）：按空白分段时区间才不会被拆成两个周次
        text = text.replace(/(\d)\s*-\s*(\d)/g, '$1-$2');
        var segments = text.split(SEGMENT_SPLIT);
        // 被空白切成独立一段的单 / 双（"1-16周 双"）并回最近的周次段：并列标记不许丢
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
            // 分隔符已经归一到 '-'（见上面），这里只认 '-'：再多收字符反而会漏掉没归一的新写法
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

    // 节次：方括号里的内容。"01-02节" / "1-2节" / "0102节" / "030405节" / "09,10节" / "第9,10节"
    // 都认；上游只 split('-') 取首尾两个数，逗号写法（[09,10节]）里没有 '-'，上游整块丢掉（节次取成 0）。
    // 连排的连字符（[09-10-11节]、[01-02-03-04节]）同样取首尾：上游 split('-') 取的也是首尾。
    // 这里只负责读 min/max，**不判上限** —— 上限由调用方判，因为超限的块要按「节次超出」
    // 跳过并点名（读出来是 78 节的脏数据要能说清是哪一门课）。
    function periodsIn(source) {
        // 与 weeksIn 同一套分隔符归一：节次里同样会写全角波浪 / 全角减 / 数学减 / en dash / 「至」
        //（"01～02节"），不归一就整段读不成节次，那个块会被当成「没认出节次」跳过
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

    // 周次集合 → 极大段（移植手册 §4.1）：步长 1 视作每周，步长 2 视作单 / 双周
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

    // 「星期一」「周一」「礼拜一」都认。周历表的表头是**单个字**（日一二三四五六），
    // 所以另给一个只看单字的口径（allowBare）—— 只用在周历上：课表表头一律要求前缀，
    // 免得把某个只写着「一」字的格子当成星期表头。
    function dayOfLabel(value, allowBare) {
        var text = clean(value);
        var m = /(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/.exec(text);
        if (!m) {
            if (!allowBare || text.length !== 1) return 0;
            var bare = DAY_CHARS.indexOf(text);
            if (bare < 0) return 0;
            return text === '天' ? 7 : bare + 1;
        }
        var at = DAY_CHARS.indexOf(m[1]);
        if (at >= 0) return m[1] === '天' ? 7 : at + 1;
        return parseInt(m[1], 10);
    }

    // 首列是不是「节次」列（"第1-2节" / "1-2" / "第3节" / "0102"）
    function isPeriodLabel(value) {
        return /^第?\s*\d{1,2}\s*([-—~至]\s*\d{1,2})?\s*节?$/.test(clean(value));
    }

    // 格子所在的**网格列号**：extract.js 交出来的 col（colspan / rowspan 都算进去了）。
    // 没有 col 的格子已在 withColOnly() 里跳过并计数，走到这里的都有 col，不再按下标回退。
    function colOf(cell) {
        return cell.col;
    }

    function spanOf(cell) {
        var span = cell ? cell.span : undefined;
        return (typeof span === 'number' && span >= 1) ? span : 1;
    }

    // 取「网格第 want 列」上的格子：一格覆盖 [col, col + span)，跨列的合并格在它覆盖到的每一列
    // 上都能取到（合并格里的课会落到它跨的每一天，这种情况进 warnings 说明）。
    function cellAtGridCol(row, want) {
        if (want < 0) return null;
        for (var i = 0; i < row.length; i++) {
            var start = colOf(row[i]);
            if (want >= start && want < start + spanOf(row[i])) return row[i];
        }
        return null;
    }

    // 表宽 = 整张表用到的最大网格列数（把 colspan 算进去）。无表头兜底的窗口起点要用它，
    // **不能**用某一行的格子数：行中部有合并格时那一行会少一个格子，按格子数算会整行错一天。
    function gridWidthOf(allRows) {
        var width = Math.max(0, Math.floor(Number(data.cols) || 0));
        for (var r = 0; r < allRows.length; r++) {
            var row = allRows[r] || [];
            for (var c = 0; c < row.length; c++) {
                var end = colOf(row[c]) + spanOf(row[c]);
                if (end > width) width = end;
            }
        }
        return width;
    }

    // 「2026-2027-1」→「2026-2027学年第一学期」（教务只给了学期代码时用它）
    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(clean(code));
        if (!m) return '';
        if (m[3] === '1') return m[1] + '-' + m[2] + '学年第一学期';
        if (m[3] === '2') return m[1] + '-' + m[2] + '学年第二学期';
        if (m[3] === '3') return m[1] + '-' + m[2] + '学年第三学期';
        return m[1] + '-' + m[2] + '学年第' + m[3] + '学期';
    }

    // 时刻一律过这里：越界的分钟数夹进 00:00-23:59（JwPayloadCodec 的时间正则只收这个范围），
    // 夹一次记一次数、最后进 warnings。内置作息表与占位公式本来都合法，这里是纵深防御 ——
    // 真出现 24:00 / 85:45 这种值时宁可按最后一刻夹住，也不能让整次导入被拒收。
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
            // 载荷要求 start < end：把 end 抬到 start 之后 45 分钟，抬不动就整对退回一个安全档
            end = start + 45;
            if (end > MAX_MINUTE) {
                end = MAX_MINUTE;
                start = MAX_MINUTE - 45;
            }
            badTimes++;
        }
        return { start: clockText(start), end: clockText(end) };
    }

    // 占位时刻：第 n 节（n > 11，教务临时加的时段）写成 pad2(7 + n):00 - :45。
    // 第 16 节 = 23:00-23:45 是最后一个还落在当天的档位 —— MAX_PERIOD 卡在 16 就是为了这个。
    function placeholderPeriod(n) {
        var hour = 7 + n;
        return pad2(hour) + ':00-' + pad2(hour) + ':45';
    }

    // 「课程块」的身份证：没有它就没法告诉用户哪一门课被跳过了
    function noteDropped(name, teacher, reason) {
        if (droppedNames.length >= 5) return;
        var text = name || '(没认出课名)';
        if (teacher) text = text + '（' + teacher + '）';
        droppedNames.push(text + '——' + reason);
    }

    function droppedText() {
        if (!droppedNames.length) return '';
        return '包含：' + droppedNames.join('；');
    }

    // ---- 星期表头：课表每一格按**网格列号**对齐星期 -------------------------------------
    // 表头行 = 没有课程明细、且能认出 ≥4 个星期标签的那一行。列号用格子自带的 col，
    // 没有 col 的旧 fixture / 手写输入退回它在数组里的下标（这两者在「首列是节次列」的表里
    // 差一格，正是要修的那处）。两本账分开记：cells 是**带星期标签的格子数**（同一天出现两次
    // 也算两个），labels 是**认出来的不同天数**（最多 7）—— 前者用来报「表被拉宽了」。
    function findHeaderRow() {
        var best = { row: -1, labels: 0, cells: 0, cols: [0, -1, -1, -1, -1, -1, -1, -1] };
        for (var r = 0; r < rows.length; r++) {
            var hasContent = false;
            var cols = [0, -1, -1, -1, -1, -1, -1, -1];
            var labels = 0;
            var cells = 0;
            for (var c = 0; c < rows[r].length; c++) {
                if (rows[r][c].parts && rows[r][c].parts.length) hasContent = true;
                var day = dayOfLabel(rows[r][c].text, false);
                if (day < 1 || day > 7) continue;
                cells++;
                if (cols[day] >= 0) continue;
                cols[day] = colOf(rows[r][c]);
                labels++;
            }
            if (hasContent || labels < 4) continue;
            if (labels > best.labels) best = { row: r, labels: labels, cells: cells, cols: cols };
        }
        return best;
    }

    var header = findHeaderRow();
    var tableCols = gridWidthOf(rows);

    // 无表头兜底：整张表**最后 7 列**依次是星期一到星期日。表宽 ≤7 列时先看看首列是不是
    // 节次标签列（是的话 7 列窗口会混进它，往后挪一格）。
    var fallbackStart = tableCols > 7 ? tableCols - 7 : 0;
    if (tableCols <= 7) {
        for (var fr = 0; fr < rows.length; fr++) {
            if (rows[fr].length && isPeriodLabel(rows[fr][0].text)) {
                fallbackStart = 1;
                break;
            }
        }
    }

    // 星期 d 落在网格第几列：
    //   ① 表头认出了这个天 → 用表头给的列号（最稳）；
    //   ② 表头没认出（或压根没有表头）→ 按表宽推（最后 7 列）；
    //   ③ 推出来的列已经被别的天占了、或超出表宽 → **不猜**，宁可少认一天（进 warnings）。
    var dayColOf = [0, -1, -1, -1, -1, -1, -1, -1];
    var usedCols = {};
    var guessedDays = 0;
    var unplacedDays = 0;
    var dd;
    for (dd = 1; dd <= 7; dd++) {
        if (header.labels >= 4 && header.cols[dd] >= 0) {
            dayColOf[dd] = header.cols[dd];
            usedCols[dayColOf[dd]] = true;
        }
    }
    for (dd = 1; dd <= 7; dd++) {
        if (dayColOf[dd] >= 0) continue;
        var guess = fallbackStart + dd - 1;
        if (guess < 0 || (tableCols > 0 && guess >= tableCols) || usedCols[guess]) {
            unplacedDays++;
            continue;
        }
        dayColOf[dd] = guess;
        usedCols[guess] = true;
        guessedDays++;
    }

    // ---- 主循环：逐格取课 ----------------------------------------------------------------
    var order = [];
    var byCourse = {};

    function collectBlock(blockHtml, day) {
        if (plainText(blockHtml) === '') return;    // 空块（只有 <br> / 减号）：不是课，也不算丢
        var fonts = fontsOf(blockHtml);
        var name = nameOf(blockHtml);
        var teacher = teacherOf(fonts);
        if (!name) {
            noNameBlocks++;
            noteDropped('', teacher, '没认出课名');
            return;
        }
        var location = roomOf(fonts);
        var specs = specsOf(blockHtml);
        if (!specs.length) {
            noWeekBlocks++;
            noteDropped(name, teacher, '没认出周次与节次');
            return;
        }
        for (var s = 0; s < specs.length; s++) {
            var periods = specs[s].periods ? periodsIn(specs[s].periods) : null;
            if (!periods) {
                noPeriodBlocks++;
                noteDropped(name, teacher, '没认出节次');
                continue;
            }
            if (periods.end > MAX_PERIOD) {
                // 节次越过上限（[17-18节]、或被切成 12/34/56/78 的脏数据）：按「节次超出」处理。
                // **不能**照单收下 —— 占位作息会补出 24:00 这种非法时刻，载荷校验一拒，整次导入就白导了。
                overPeriodBlocks++;
                noteDropped(name, teacher, '节次超出 ' + MAX_PERIOD + ' 节');
                continue;
            }
            var weeks = weeksIn(specs[s].weeks);
            if (!weeks.length) {
                noWeekBlocks++;
                noteDropped(name, teacher, '没认出周次');
                continue;
            }
            var key = name + ' ' + (teacher || '');
            var course = byCourse[key];
            var runs = runsOf(weeks);
            for (var n = 0; n < runs.length; n++) {
                var run = runs[n];
                // 课程要等真产出一条安排才登记：不能在课表里留下一门「没有任何安排」的空课
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
                    block.startWeek, block.endWeek, block.weekType,
                    block.location || ''].join('|');
                if (course.seen[blockKey]) continue;
                course.seen[blockKey] = true;
                course.blocks.push(block);
            }
        }
    }

    for (var ri = 0; ri < rows.length; ri++) {
        if (ri === header.row) continue;
        var row = rows[ri];
        var touched = [];
        var countedMerged = [];
        for (var d = 1; d <= 7; d++) {
            var cell = cellAtGridCol(row, dayColOf[d]);
            if (!cell) continue;
            if (touched.indexOf(cell) < 0) touched.push(cell);
            var parts = cell.parts || [];
            // 跨列的格子：它的课会落到它跨到的每一天（不复制就等于把课丢了，复制了就得说一声）
            if (parts.length && spanOf(cell) > 1 && countedMerged.indexOf(cell) < 0) {
                countedMerged.push(cell);
                mergedCells++;
            }
            for (var p = 0; p < parts.length; p++) {
                var blocks = String(parts[p]).split(DASHES);
                for (var b = 0; b < blocks.length; b++) collectBlock(blocks[b], d);
            }
        }
        // 有课、却没有任何一天映射到它：表头 / 列号对不上时**不能说丢就丢**
        for (var mc = 0; mc < row.length; mc++) {
            if (row[mc].parts && row[mc].parts.length && touched.indexOf(row[mc]) < 0) unmappedCells++;
        }
    }

    if (order.length === 0) {
        // 一个块都没解析出来：要说清是「没课」还是「课都在解析时被跳过了」——
        // 后者是教务页面换了写法或数据有脏（比如节次超出 16 节），不是没排课。
        var totalSkipped = noNameBlocks + noWeekBlocks + noPeriodBlocks + overPeriodBlocks;
        if (totalSkipped > 0) {
            throw new Error(clipText('本学期没有解析到任何课程：课表里的 ' + totalSkipped +
                ' 个上课安排都没能认出来（周次或节次的写法不认识，或节次超出 ' + MAX_PERIOD +
                ' 节）。' + droppedText() + ' 请把教务页面的课表截图反馈给空课', MAX_WARNING_TEXT));
        }
        throw new Error(
            '本学期没有解析到任何课程：可能是还没排课，或教务页面改了结构（也可能登录状态已失效）'
        );
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
        courses.push({
            name: item.name,
            teacher: item.teacher,
            note: item.note,
            blocks: item.blocks
        });
    }

    // ---- 教学周历：开学日期与学期总周数 ------------------------------------------------
    function firstCellOf(row) {
        if (!row || !row.length) return null;
        var first = row[0];
        for (var k = 1; k < row.length; k++) {
            if (colOf(row[k]) < colOf(first)) first = row[k];
        }
        return first;
    }

    // 周历的表头是**单字**（日一二三四五六），认不出来就不取开学日期 —— 按位置猜的话，
    // 开学日期会错一整周，而它在库里和真值长得一模一样。
    function calendarHeader() {
        var best = null;
        var bestLabels = 0;
        for (var r = 0; r < calendarRows.length; r++) {
            var cols = [0, -1, -1, -1, -1, -1, -1, -1];
            var labels = 0;
            for (var c = 0; c < calendarRows[r].length; c++) {
                var day = dayOfLabel(calendarRows[r][c].text, true);
                if (day < 1 || day > 7 || cols[day] >= 0) continue;
                cols[day] = colOf(calendarRows[r][c]);
                labels++;
            }
            if (labels > bestLabels) {
                bestLabels = labels;
                best = cols;
            }
        }
        return bestLabels >= 4 ? best : null;
    }

    // 周历日期「2026年09月07日」与「2026年09月07」都认：上游读周历用的是 ^(\d{4})年(\d{2})月(\d{2})$（不带「日」），
    // 同平台的周历 title 也有不带「日」的写法。认不出来，开学日就只能按提取时刻推算（见下面「开学日期的取法」）。
    function isoOfCnDate(value) {
        var text = clean(value);
        var m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
        if (!m) m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        // 日历日期要真存在（2027-02-31 会被载荷校验拒收，整次导入就白导了）
        var probe = new Date(year, month - 1, day);
        if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
            return null;
        }
        return year + '-' + pad2(month) + '-' + pad2(day);
    }

    // 第 1 周那一行的「星期一」格：日期在 td[title] 上（形如 2026年09月07日，「日」字可有可无），
    // 有的部署写成格子文字，两种都读。
    function calendarFirstMonday() {
        var headerCols = calendarHeader();
        if (!headerCols || headerCols[1] < 0) return null;
        for (var r = 0; r < calendarRows.length; r++) {
            var row = calendarRows[r];
            var first = firstCellOf(row);
            if (!first) continue;
            if (!/^第?\s*1\s*周?$/.test(clean(first.text))) continue;
            var cell = cellAtGridCol(row, headerCols[1]);
            if (!cell) continue;
            var iso = isoOfCnDate(cell.title) || isoOfCnDate(cell.text);
            if (iso) return iso;
        }
        return null;
    }

    // 开学日期的备选口径（周历里找不到「星期一」格时用）：按行序取第一个带日期的 td，
    // 与上游 fetchSemesterInfo() 取的是同一个格子。
    function calendarFirstTitled() {
        for (var r = 0; r < calendarRows.length; r++) {
            for (var c = 0; c < calendarRows[r].length; c++) {
                var iso = isoOfCnDate(calendarRows[r][c].title);
                if (iso) return iso;
            }
        }
        return null;
    }

    // 备选口径的日期 → 周一。周历按「日一二…六」排时，第一个带日期的格子常是星期日（它属于
    // 上一个周的末尾，第 1 周是它之后的周一开始），那就取它后面一天；其余按所在那一周的周一对齐。
    // 上游直接拿这个格子当开学日（它是星期日）；宿主再按每周起始日（周一）回退，整学期会差一周。
    function mondayFromTitled(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (day.getDay() === 0) {
            return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1));
        }
        return mondayOf(iso);
    }

    // 周历里每一行第一个格子的整数（周号）的最大值：学期总周数至少要盖住它。
    // 与上游 fetchSemesterInfo() 基本一致（上游用 parseInt 取每行第一个 td，这里只认纯数字）。
    function calendarWeekCount() {
        var max = 0;
        for (var r = 0; r < calendarRows.length; r++) {
            var first = firstCellOf(calendarRows[r]);
            if (!first) continue;
            var number = /^(\d{1,3})$/.exec(clean(first.text));
            if (!number) continue;
            var value = parseInt(number[1], 10);
            if (value > max) max = value;
        }
        return max;
    }

    var calendarWeeks = calendarWeekCount();
    // 总周数：有周历就用周历的周数；课表里有更晚的周次才抬高到它（课表里有第 21 周的课而总周数只有 20，
    // 那一块的 endWeek 就超出了 totalWeeks，载荷校验会拒收）。没有周历才按兜底的 20 周。超过 MAX_WEEK 的夹住并出声（见下面）。
    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    // 作息表：内置 11 节 + 占位（课表里出现 >11 节时）。不补的话那些课会画到课表外面去。
    var periodTimes = [];
    for (var pi = 0; pi < SLOT_TIMES.length; pi++) {
        var pair = timePair(SLOT_TIMES[pi]);
        periodTimes.push({ periodIndex: pi + 1, start: pair.start, end: pair.end });
    }
    for (var extra = PERIOD_COUNT + 1; extra <= maxPeriod; extra++) {
        var placeholder = timePair(placeholderPeriod(extra));
        periodTimes.push({ periodIndex: extra, start: placeholder.start, end: placeholder.end });
    }

    if (!data.now) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
    var termName = clean(term.name) || termNameFromCode(term.code);

    // 开学日期的取法（依次）：① 周历第 1 周那一行的「星期一」格（真实值）；② 周历里第一个带日期的格子，
    // 对齐到第 1 周的周一；③ 都认不出来，按提取时刻推算最近的周一。②③ **必须说明**：推算值和真值在库里
    // 长得一模一样，不说用户就没有任何机会发现「现在第几周」是错的。
    var firstDay = calendarFirstMonday();
    var titledDay = firstDay ? null : calendarFirstTitled();
    if (firstDay) {
        var aligned = mondayOf(firstDay);
        if (aligned && aligned !== firstDay) {
            pushWarning('教务的教学周历里第 1 周的星期一写的是 ' + firstDay +
                '（那天不是星期一），开学日期已按它所在那一周的周一（' + aligned +
                '）对齐，请在「学期管理」里核对');
            firstDay = aligned;
        }
    } else if (titledDay) {
        firstDay = mondayFromTitled(titledDay);
        if (firstDay !== titledDay) {
            pushWarning('教务的教学周历没有标出第 1 周的星期一，开学日期已由第一个日期格（' + titledDay +
                '）对齐为周一（' + firstDay + '），请在「学期管理」里核对');
        }
    } else {
        firstDay = mondayOf(data.now);
        if (!firstDay) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
        pushWarning('开学日期无法从教务获取（教学周历的表格结构认不出来），已按最近的周一（' +
            firstDay + '）推算，请在「学期管理」里核对');
    }

    // ---- 逐条说清楚推算 / 假定 / 丢弃的东西（规范 §4 的 warnings）------------------------
    // 学期名：教务给的名称 → 由学期代码拼出的「2026-2027学年第一学期」 → 两者都没有才用「学校名当前学期」占位并出提醒
    if (!termName) {
        termName = SCHOOL_NAME + '当前学期';
        pushWarning('没能识别出学年学期（课表页的「学年学期」下拉框认不出来，教学周历页也没有学期代码），' +
            '学期名已用「' + termName + '」占位，请在「学期管理」里改名');
    }
    if (data.screenTermMissing === true) {
        pushWarning('课表页上找不到「学年学期」下拉框，无法确认屏幕上的课表是哪一学期，' +
            '导入的是教学周历页选中的学期（' + termName + '），请核对是否是要导入的那一学期');
    }
    if (wantedWeeks > MAX_WEEK) {
        pushWarning('学期总周数算出来是 ' + wantedWeeks + ' 周，超过了上限 ' + MAX_WEEK +
            ' 周，已按 ' + MAX_WEEK + ' 周计，请在「学期管理」里核对');
    }
    // 总周数的提醒：周历给出周数就用它（课表有更晚的周次才抬高，并说明）；周历没给出周数才按 20 周计，并说明
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
    if (header.labels === 0) {
        pushWarning('课表顶部没有认出星期几的标题，已按课表最右边 7 列推断为星期一到星期日' +
            (tableCols > 0 ? '（本表共 ' + tableCols + ' 列）' : '') +
            '，课表可能整体错位，请核对导入结果');
    } else {
        if (header.labels < 7) {
            pushWarning('课表顶部只认出了 ' + header.labels + ' 天的星期名称，其余 ' + guessedDays +
                ' 天按课表最右边 7 列推断，请核对导入结果');
        }
        if (header.cells > 7) {
            pushWarning('课表顶部出现了 ' + header.cells + ' 个星期名称，比星期一到星期日多：' +
                '同一天以第一次出现的为准，请核对导入结果');
        }
    }
    if (unplacedDays > 0) {
        pushWarning('有 ' + unplacedDays + ' 天在课表里找不到对应的位置，这几天的课没有导入，请核对导入结果');
    }
    if (unmappedCells > 0) {
        pushWarning('有 ' + unmappedCells + ' 个格子里有课，但对不上星期几，这些课没有导入，请核对导入结果');
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
    if (noColCells > 0) {
        pushWarning('有 ' + noColCells + ' 个格子无法确定它是星期几，已跳过，这些格子里的内容没有导入，请核对导入结果');
    }
    if (mergedCells > 0) {
        pushWarning('有 ' + mergedCells + ' 处课占了连续几天的格子，这些课被同时放进了这几天，请核对导入结果');
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
        // 被跳过的上课安排按名字点名（最多 5 个）—— 名单可能很长，pushWarning 会把它截到 200 字以内
        pushWarning('有 ' + (noNameBlocks + noWeekBlocks + noPeriodBlocks + overPeriodBlocks) +
            ' 个上课安排没能认出来，已跳过（' + parts2.join('，') + '）。教务页面的写法可能有变化，欢迎反馈。' +
            droppedText());
    }
    if (ambiguousMarks > 0) {
        var marks = ambiguousSamples.length ? '（' + ambiguousSamples.join('、') + '）' : '';
        pushWarning('有 ' + ambiguousMarks + ' 处周次里的单双 / 隔周标记认不出来' + marks +
            '，这些周次已按「每周都上」处理，请核对导入结果');
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
