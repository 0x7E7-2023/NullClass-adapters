(function () {
    // 青岛农业大学（强智 · 高校综合管理教务系统 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 resources/QAU/qau_01.js（MIT，上游作者 ReGoMark）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游的核心是 extractCoursesFromDoc() + parseWeeks()：#kbtable 每个数据行的 th 写「第1,2节」，
    // 格子里 div.kbcontent 的明细按一长串减号切成多门课；课程名取第一个非空行，
    // font[title=老师] / font[title=教室] / font[title=周次(节次)] 取教师、教室、周次；
    // 同天同名同师同室同周、节次紧邻且合并后跨度不超过 4 节的，合并成一段。
    // 这里保持同一套字段来源与合并规则，改动如下（逐条理由见 AUDIT.md §3）：
    //   ① 星期按网格列号对齐（extract.js 每个格子带 col / span）：上游用 td 下标 j+1 当星期，
    //      首列「节次」常 rowspan 跨两行，被跨掉的那一行会整行错一天；
    //   ② 周次不再整串删括号：上游 parseWeeks() 先把所有括号内容删掉，"1-15(单周)" 就成了
    //      「每周都上」。这里认「周」字后面的单双（1-16周(单)）、数字前面的（(双)2-16周）、
    //      括号里的（1-16(单周)）；逗号分段各自判单双，空白也是分段符；「(周)」之后的周次不切掉，
    //      同一块里多个「周次」字段的周次取并集；
    //   ③ 括号里只有数字或数字区间的（(1)、(1-2)）是教学班序号，不是周次；(周) 是周字的正常写法；
    //   ④ 节次上限 MAX_PERIOD 在解析阶段夹住：越界的块点名进 warnings，不补出非法时刻；
    //   ⑤ 上游静默丢掉的块（没课名 / 没周次 / 没节次）全部计数并点名进 warnings；
    //      节次取不到的行也出声，不许静默丢课；
    //   ⑥ 去重键加上教师与教室：上游只看「星期 + 节次 + 课名 + 周次」，同名同时同周、
    //      不同教室的两门会被当成一门；
    //   ⑦ 校区由 extract.js 问来（data.campus）；问不到就回落青岛校区并写进 warnings；
    //   ⑧ 上游的「未知 / 待定 / 未知教师 / 未知地点」一律不抄，写成 null；「任课教师:」这类标签前缀去掉；
    //   ⑨ 总周数上游不给：默认 20 周，课表里有更靠后的周就抬高到那一周（上限 30），并 warnings；
    //   ⑩ 开学日上游不给：按提取当天所在周的周一推算，并 warnings；学期名取教务下拉框的文字，
    //      没有就用「学校名 + 学年学期」，不用适配器名。
    //   ⑪ 有课的格子落在不对应任何星期的列上（不是星期一至星期日的列）：计数并点名进 warnings，不静默丢课；
    //   ⑫ 节次：格子里方括号写的节次优先（那是这一格自己的写法），格子里没写才用行表头「第N,M节」；
    //      两者都有又对不上，以格子为准并出声。上游只看行表头。
    //
    // 输入是 extract.js 交出来的原始结构：
    //   { source, pageUrl, now: "2026-10-08", term: { code, name }, campus, cols: 8,
    //     rows: [ [ { col, span, text, parts: [原始 HTML] }, … ], … ] }
    // 这里不碰页面（CI 的 Rhino 里没有），全部按字符串 + 正则处理，是纯函数。
    var data = JSON.parse(__ncInput);
    var rows = data.rows || [];
    var term = data.term || {};

    // 三个校区的作息时间表（上游 CAMPUS_TIME_SLOTS 逐条照搬，字段改成本平台的 periodIndex/start/end）。
    // 三张表都是 11 节。
    var CAMPUS_PERIODS = {
        '青岛校区': [
            { periodIndex: 1, start: '08:00', end: '08:45' },
            { periodIndex: 2, start: '08:55', end: '09:40' },
            { periodIndex: 3, start: '09:55', end: '10:40' },
            { periodIndex: 4, start: '10:50', end: '11:35' },
            { periodIndex: 5, start: '11:35', end: '12:00' },
            { periodIndex: 6, start: '14:00', end: '14:45' },
            { periodIndex: 7, start: '14:55', end: '15:40' },
            { periodIndex: 8, start: '15:55', end: '16:40' },
            { periodIndex: 9, start: '16:50', end: '17:35' },
            { periodIndex: 10, start: '18:50', end: '19:35' },
            { periodIndex: 11, start: '19:45', end: '20:30' }
        ],
        '平度校区': [
            { periodIndex: 1, start: '08:30', end: '09:15' },
            { periodIndex: 2, start: '09:25', end: '10:10' },
            { periodIndex: 3, start: '10:20', end: '11:05' },
            { periodIndex: 4, start: '11:15', end: '12:00' },
            { periodIndex: 5, start: '12:00', end: '12:25' },
            { periodIndex: 6, start: '14:00', end: '14:45' },
            { periodIndex: 7, start: '14:55', end: '15:40' },
            { periodIndex: 8, start: '15:50', end: '16:35' },
            { periodIndex: 9, start: '16:45', end: '17:30' },
            { periodIndex: 10, start: '18:50', end: '19:35' },
            { periodIndex: 11, start: '19:45', end: '20:30' }
        ],
        '蓝谷校区': [
            { periodIndex: 1, start: '08:30', end: '09:15' },
            { periodIndex: 2, start: '09:20', end: '10:05' },
            { periodIndex: 3, start: '10:15', end: '11:00' },
            { periodIndex: 4, start: '11:05', end: '11:50' },
            { periodIndex: 5, start: '13:10', end: '13:55' },
            { periodIndex: 6, start: '14:00', end: '14:45' },
            { periodIndex: 7, start: '14:55', end: '15:40' },
            { periodIndex: 8, start: '15:45', end: '16:30' },
            { periodIndex: 9, start: '16:35', end: '17:20' },
            { periodIndex: 10, start: '18:30', end: '19:15' },
            { periodIndex: 11, start: '19:25', end: '20:15' }
        ]
    };
    var CAMPUS_NAMES = ['青岛校区', '平度校区', '蓝谷校区'];
    var DEFAULT_CAMPUS = '青岛校区';
    var PERIOD_COUNT = 11;

    // 节次上限：越过它一定是脏数据。占位时刻写成 pad2(7 + 节次)，第 16 节 = 23:00-23:45 是最后
    // 一个还在当天的档位；再往后补出来的就不是合法 HH:mm 了，载荷校验会整次拒收。
    var MAX_PERIOD = 16;

    // 学期总周数：上游不给，默认 20；课表里有更靠后的周就抬高（上限 MAX_WEEK）
    var DEFAULT_TOTAL_WEEKS = 20;
    // 载荷校验的总周数上限（1..30），超出的周次按脏数据丢弃并进 warnings
    var MAX_WEEK = 30;
    // 载荷校验的上限：警告 ≤20 条、每条 ≤200 字（中文按 String.length 算，1 字 = 1）
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    // 一个格子里放多门课时，教务用一长串减号分隔（上游是 /-{5,}\s*<br>/，这里不要求 <br>）
    var DASHES = /-{5,}/;
    // 上游 font[title="老师"] / font[title="教室"] / font[title="周次(节次)"]，逐字对齐
    var TEACHER_TITLE = /^老师$/;
    var ROOM_TITLE = /^教室$/;
    var WEEK_TITLE = /^周次/;
    var COURSE_TITLE = /^(课程|课程名称|课程名|科目)$/;
    // 上游写进去的占位词：一律不抄，写成 null
    var PLACEHOLDERS = ['未知', '待定', '未知教师', '未知地点'];
    // 教师字段可能带「任课教师:」这类标签前缀：前缀是标签不是名字，去掉；去掉后空串就写 null
    var TEACHER_PREFIX = /^(任课教师|授课教师|教师|老师)\s*[:：]\s*/;
    // 「周」字的括号：(周) 是周字的正常写法；(1)、(1-2) 是教学班序号。两种都不是周次本身
    var WEEK_PAREN = /^[周週]$/;
    var SERIAL_PAREN = /^\d{1,3}(\s*[-—~至,，、]\s*\d{1,3})*$/;
    // 单双标记也可能被空白切成独立一段（"1-16周 双"），分段时按空白一并切
    var SEGMENT_SPLIT = /[\s,，、;；]+/;

    var droppedWeeks = 0;
    var skippedBlocks = 0;
    var noPeriodBlocks = 0;
    var overPeriodBlocks = 0;
    // 认不出单双的周次串（「单双」同段、只有「隔周」没有单双字）：不猜，按每周处理并出声
    var ambiguousMarks = 0;
    var ambiguousSamples = [];
    // 被跳过的课程块（最多记 5 条，点名进 warnings）—— 不许静默丢课
    var droppedNames = [];
    var mergedCells = 0;
    var noSectionRows = 0;
    var noSectionSample = '';
    // 有课的格子对不上星期几：计数，并记一个课名做样本
    var unmappedCells = 0;
    var unmappedSample = '';
    // 格子里写的节次与行表头对不上：计数，并记一个课名做样本
    var mismatchBlocks = 0;
    var mismatchSample = '';

    // 载荷里的核对提示。一律经 pushWarning() 出去：每条 ≤ MAX_WARNING_TEXT 字，一共 ≤ MAX_WARNINGS 条。
    var warnings = [];

    // 按码位截断：别把代理对劈成半个，末尾留一个省略号
    function clipText(text, max) {
        var one = String(text);
        if (one.length <= max) return one;
        var head = one.substring(0, max - 1);
        var last = head.charCodeAt(head.length - 1);
        if (last >= 0xD800 && last <= 0xDBFF) head = head.substring(0, head.length - 1);
        return head + '…';
    }

    function pushWarning(message) {
        if (warnings.length >= MAX_WARNINGS) return;
        var text = clipText(message, MAX_WARNING_TEXT);
        if (warnings.indexOf(text) >= 0) return;
        warnings.push(text);
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

    // 提取时刻那一周的周一：firstDay 是第 1 周的第一天，按周一做一周之首（上游 QAU 脚本没有这个设置，这里固定周一）。
    // 不用 Date.parse：Rhino 对 ISO 串的支持不齐。
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

    // 明细 HTML 里的 <font title="…">文本</font>，按出现顺序返回。
    // 末尾的 </font> 允许缺失（教务页面的 font 偶尔不闭合），那时取到下一个 '<' 为止。
    function fontsOf(blockHtml) {
        var html = String(blockHtml);
        var re = /<font(?=[\s>])[^>]*title\s*=\s*["']?([^"'>]+)["']?[^>]*>([\s\S]*?)(?:<\/font>|(?=<)|$)/gi;
        var out = [];
        var m = re.exec(html);
        while (m) {
            out.push({ title: clean(m[1]), text: plainText(m[2]) });
            m = re.exec(html);
        }
        return out;
    }

    // 课程名：明细里第一个 <font> 之前的第一行文字，与上游「第一个非空行」等价。
    // 个别页面把课名也放进 font[title=课程]，补一个兜底。都没认出来返回空串，调用方计进 warnings。
    function nameOf(blockHtml) {
        var lines = String(blockHtml).split(/<font[\s>]/i)[0].split(/<br\s*\/?>/i);
        for (var i = 0; i < lines.length; i++) {
            var line = plainText(lines[i]);
            if (line) return line;
        }
        var fonts = fontsOf(blockHtml);
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

    function isPlaceholder(text) {
        return PLACEHOLDERS.indexOf(text) >= 0;
    }

    // 教师：去掉「任课教师:」之类的标签前缀后，空值或上游占位词 → null（不写「未知」，那会被当成真名显示）
    function teacherOf(fonts) {
        var text = titledText(fonts, TEACHER_TITLE).replace(TEACHER_PREFIX, '');
        if (!text || isPlaceholder(text)) return null;
        return text;
    }

    // 教室：同上。
    function roomOf(fonts) {
        var text = titledText(fonts, ROOM_TITLE);
        if (!text || isPlaceholder(text)) return null;
        return text;
    }

    // 「周次(节次)」字段的文本，本平台形如 "1-9,11-17(周)[01-02节]"，一个字段里两段周次用空白分开
    // （"1-3(周) 5-9(周)[01-02节]"）。整串都交给 weeksIn() 认周次（方括号、「(周)」都在那里去掉，
    // 单双写法 1-15(单周)、1-16周(单)、(双)2-16周 也在那里认）；这里只把方括号里的节次单独取出来兜底。
    // 「(周)」之后的内容不能切掉，否则第二段会静默丢失。
    function weekFieldOf(text) {
        var body = clean(text);
        var bracket = /[\[【]([^\]】]*)[\]】]/.exec(body);
        return { weeks: body, periods: bracket ? clean(bracket[1]) : '' };
    }

    // 行表头「第1,2节」：上游 /第([\d,]+)节/，取第一个数作起、最后一个数作止（第5节 → 5-5）。
    // 逗号、全角逗号、空白、连字符都当分隔符；认不出来返回 null。
    function sectionOf(text) {
        var m = /第\s*([\d,，\s-]+)节/.exec(clean(text));
        if (!m) return null;
        var nums = [];
        var parts = m[1].split(/[,，\s-]+/);
        for (var i = 0; i < parts.length; i++) {
            if (/^\d+$/.test(parts[i])) nums.push(parseInt(parts[i], 10));
        }
        if (!nums.length) return null;
        return { start: nums[0], end: nums[nums.length - 1] };
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

    // 认不出单双的周次串：记样本（最多 3 条）与总数，最后进 warnings
    function noteAmbiguous(segment) {
        ambiguousMarks++;
        var text = clean(segment);
        if (!text || ambiguousSamples.indexOf(text) >= 0) return;
        if (ambiguousSamples.length >= 3) return;
        ambiguousSamples.push(text);
    }

    // 周次串 → 周次数组。五种写法都要认：
    //   1-9,11-17(周)       「周」字写在括号里（本平台的主要形态，(周) 在 weeksIn 里去掉）
    //   1-16周(单) / 1-16周(双)   单双写在「周」字后面
    //   (单)1-16周 / (双)2-16周   单双写在数字前面
    //   1-16(单周)          单双与「周」字一起写在括号里
    //   1-3,5-9周           逗号分段混排，段与段各自判单双；空白也是分段符（1-3周 5-9周）
    // 括号里的纯数字 / 数字区间是教学班序号（(1)、(1-2)），整段抹掉，不当周次。
    function weeksIn(source) {
        var text = clean(source);
        if (!text) return [];
        // 区间分隔符先归一：全角波浪 ～、全角减 －、数学减 −、短破折 –、长破折 —、半角 ~、「至/到」
        text = text.replace(/[～－−–—~至到]/g, '-');
        // 方括号 / 【】里是节次，整段去掉，免得节次的数字被当成周次
        text = text.replace(/[\[【][^\]】]*[\]】]/g, ' ');
        // 括号逐个看：「周」字的正常写法与教学班序号整段抹掉，单双 / 其它写法留着（下面按段判）
        text = text.replace(/[（(]([^）)]*)[)）]/g, function (whole, inner) {
            var body = clean(inner);
            if (!body) return ' ';
            if (WEEK_PAREN.test(body)) return ' ';
            if (SERIAL_PAREN.test(body)) return ' ';
            return whole;
        });
        // 区间两端的空白吃掉（"1 - 16 周"），否则按空白分段时区间会被拆开
        text = text.replace(/(\d)\s*-\s*(\d)/g, '$1-$2');
        var segments = text.split(SEGMENT_SPLIT);
        // 被空白切成独立一段的单 / 双（"1-16周 双"）并给最近的周次段：并列标记不许丢
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
                // 「单双」两个标记同时出现：认不出到底上哪几周，按每周处理并出声
                noteAmbiguous(segment);
                oddOnly = false;
                evenOnly = false;
            } else if (!oddOnly && !evenOnly && segment.indexOf('隔') >= 0) {
                // 「隔周」要有上一周做基准才定得下来，光看这一段定不了
                noteAmbiguous(segment);
            }
            var range = /(\d{1,2})\s*-\s*(\d{1,2})/.exec(segment);
            if (range) {
                var start = parseInt(range[1], 10);
                var end = parseInt(range[2], 10);
                for (var week = start; week <= end; week++) pushWeek(weeks, week, oddOnly, evenOnly);
                continue;
            }
            var single = /(\d{1,2})/.exec(segment);
            if (single) pushWeek(weeks, parseInt(single[1], 10), oddOnly, evenOnly);
        }
        return uniqueSorted(weeks);
    }

    // 节次（方括号里的内容，只在 th 读不出节次时才用它兜底）："01-02节" / "1-2节" / "09,10节"
    // 返回 {start, end}，不判上限（上限由调用方判，超限的块要点名）
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
            var range = /^(\d{1,2})-(\d{1,2})$/.exec(segment);
            if (range) {
                note(parseInt(range[1], 10));
                note(parseInt(range[2], 10));
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

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单 / 双周
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

    var DAY_CHARS = '一二三四五六日天';

    function dayOfLabel(value) {
        var m = /(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/.exec(clean(value));
        if (!m) return 0;
        var at = DAY_CHARS.indexOf(m[1]);
        if (at >= 0) return m[1] === '天' ? 7 : at + 1;
        return parseInt(m[1], 10);
    }

    // 「节次」列的标签（"第1,2节" / "1-2" / "上午"）：只在表宽不足 8 列、要挪兜底窗口时用
    function isPeriodLabel(value) {
        return /(第\s*\d|\d\s*[-—~至]\s*\d|上午|下午|晚上|早晨|中午|节)/.test(clean(value));
    }

    // 「2026-2027-1」→「2026-2027学年第一学期」（教务下拉框没有文字时用它）
    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(clean(code));
        if (!m) return '';
        var names = ['', '第一学期', '第二学期', '第三学期'];
        return m[1] + '-' + m[2] + '学年' + (names[Number(m[3])] || ('第' + m[3] + '学期'));
    }

    function colOf(cell, index) {
        var col = cell ? cell.col : undefined;
        return (typeof col === 'number' && col >= 0) ? col : index;
    }

    function spanOf(cell) {
        var span = cell ? cell.span : undefined;
        return (typeof span === 'number' && span > 0) ? span : 1;
    }

    // 表宽 = 整张表用到的最大网格列数（把 colspan 算进去）。extract.js 交出来的 cols 最准。
    var tableWidth = Number(data.cols) || 0;
    for (var wr = 0; wr < rows.length; wr++) {
        for (var wc = 0; wc < rows[wr].length; wc++) {
            var endAt = colOf(rows[wr][wc], wc) + spanOf(rows[wr][wc]);
            if (endAt > tableWidth) tableWidth = endAt;
        }
    }

    // 星期表头：找「没有课程内容、且能认出 ≥4 个星期标签」的那一行，记下每个星期在第几列
    var headerRow = -1;
    var dayCol = [0, -1, -1, -1, -1, -1, -1, -1];
    var bestLabels = 0;
    var headerLabelCells = 0;
    for (var hr = 0; hr < rows.length; hr++) {
        var hasContent = false;
        var labelCells = 0;
        var cols = [0, -1, -1, -1, -1, -1, -1, -1];
        var labels = 0;
        for (var hc = 0; hc < rows[hr].length; hc++) {
            if (rows[hr][hc].parts && rows[hr][hc].parts.length) hasContent = true;
            var day = dayOfLabel(rows[hr][hc].text);
            if (day < 1 || day > 7) continue;
            labelCells++;
            if (cols[day] >= 0) continue;
            cols[day] = colOf(rows[hr][hc], hc);
            labels++;
        }
        if (hasContent || labels < 4) continue;
        if (labels > bestLabels) {
            bestLabels = labels;
            headerRow = hr;
            headerLabelCells = labelCells;
            dayCol = cols;
        }
    }

    // 无表头（或表头只认出几天）时，剩下的天按表宽推「整张表最后 7 列是周一到周日」；
    // 表宽不足 8 列时窗口从头开始，首格若是「节次」标签就往后挪一格
    var fallbackStart = tableWidth > 7 ? tableWidth - 7 : 0;
    if (tableWidth <= 7) {
        for (var fr = 0; fr < rows.length; fr++) {
            if (rows[fr].length && isPeriodLabel(rows[fr][0].text)) {
                fallbackStart = 1;
                break;
            }
        }
    }

    var dayColOf = [0, -1, -1, -1, -1, -1, -1, -1];
    var dayGuessed = [false, false, false, false, false, false, false, false];
    var usedCols = {};
    var guessedDays = 0;
    var unplacedDays = 0;
    var dd;
    for (dd = 1; dd <= 7; dd++) {
        if (dayCol[dd] >= 0) {
            dayColOf[dd] = dayCol[dd];
            usedCols[dayCol[dd]] = true;
        }
    }
    for (dd = 1; dd <= 7; dd++) {
        if (dayColOf[dd] >= 0) continue;
        var guess = fallbackStart + dd - 1;
        if (guess < 0 || (tableWidth > 0 && guess >= tableWidth) || usedCols[guess]) {
            unplacedDays++;
            continue;
        }
        dayColOf[dd] = guess;
        dayGuessed[dd] = true;
        usedCols[guess] = true;
        guessedDays++;
    }

    // 网格列号 → 星期几（列号认不出来返回 0，调用方跳过那个格子）
    function dayOfGridCol(col) {
        for (var d = 1; d <= 7; d++) {
            if (dayColOf[d] === col) return d;
        }
        return 0;
    }

    // 没有课名 / 周次 / 节次的块：点名（最多 5 条），不许静默丢课
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

    // 对不上星期几的有课格子：记下计数与第一个课名（没认出课名就不记样本，计数照加）
    function noteUnmappedCell(parts) {
        if (plainText(parts.join('')) === '') return;
        unmappedCells++;
        if (unmappedSample) return;
        for (var p = 0; p < parts.length; p++) {
            var blocks = String(parts[p]).split(DASHES);
            for (var b = 0; b < blocks.length; b++) {
                var name = nameOf(blocks[b]);
                if (name && !unmappedSample) unmappedSample = name;
            }
        }
    }

    // 行的节次：表头「第N,M节」在一行里没有课程内容的那个格子里。
    function rowSectionOf(row) {
        for (var c = 0; c < row.length; c++) {
            if (row[c].parts && row[c].parts.length) continue;
            var found = sectionOf(row[c].text);
            if (found) return found;
        }
        return null;
    }

    // 一个课程块 → 一条安排（entries，DOM 顺序）。读不出的块点名进 warnings，不静默丢。
    var entries = [];

    function readBlock(blockHtml, day, rowSection) {
        if (plainText(blockHtml) === '') return;
        var fonts = fontsOf(blockHtml);
        var name = nameOf(blockHtml);
        var teacher = teacherOf(fonts);
        if (!name) {
            skippedBlocks++;
            noteDropped('', teacher, '没认出课名');
            return;
        }
        // 周次：块里所有「周次」字段的周次取并集（只认第一个字段的话，第二段会静默丢掉）；
        // 节次兜底取第一个带方括号的字段
        var weekWeeks = [];
        var weekPeriods = '';
        for (var f = 0; f < fonts.length; f++) {
            if (!WEEK_TITLE.test(fonts[f].title) || !clean(fonts[f].text)) continue;
            var field = weekFieldOf(fonts[f].text);
            weekWeeks = weekWeeks.concat(weeksIn(field.weeks));
            if (!weekPeriods) weekPeriods = field.periods;
        }
        var weeks = uniqueSorted(weekWeeks);
        if (!weeks.length) {
            skippedBlocks++;
            noteDropped(name, teacher, '没认出周次');
            return;
        }
        // 节次：格子里方括号写的节次优先（那是这一格自己写的）；格子里没写才用行表头「第N,M节」。
        // 两者都有又对不上时以格子为准，下面记一笔、进 warnings
        var cellPeriods = weekPeriods ? periodsIn(weekPeriods) : null;
        var periods = cellPeriods || rowSection;
        if (!periods || periods.start < 1 || periods.end < periods.start) {
            noPeriodBlocks++;
            noteDropped(name, teacher, '没认出节次');
            return;
        }
        if (periods.end > MAX_PERIOD) {
            // 节次越过上限：按脏数据点名跳过（占位作息会补出非法时刻，不能照单收下）
            overPeriodBlocks++;
            noteDropped(name, teacher, '节次超出 ' + MAX_PERIOD + ' 节');
            return;
        }
        if (cellPeriods && rowSection && (cellPeriods.start !== rowSection.start || cellPeriods.end !== rowSection.end)) {
            mismatchBlocks++;
            if (!mismatchSample) mismatchSample = name;
        }
        entries.push({
            day: day,
            startSection: periods.start,
            endSection: periods.end,
            name: name,
            teacher: teacher,
            location: roomOf(fonts),
            weeks: weeks
        });
    }

    for (var ri = 0; ri < rows.length; ri++) {
        if (ri === headerRow) continue;
        var row = rows[ri];
        var rowSection = rowSectionOf(row);
        var rowHasCourse = false;
        for (var rc = 0; rc < row.length; rc++) {
            if (row[rc].parts && row[rc].parts.length) rowHasCourse = true;
        }
        if (!rowSection && rowHasCourse) {
            noSectionRows++;
            if (!noSectionSample) {
                var rowText = '';
                for (var rt = 0; rt < row.length; rt++) rowText += row[rt].text + ' ';
                noSectionSample = clipText(clean(rowText), 30);
            }
        }
        // 逐个格子按它自己的列号定位星期 —— 不按数组下标
        for (var ci = 0; ci < row.length; ci++) {
            var cell = row[ci];
            var parts = cell.parts || [];
            if (!parts.length) continue;
            var d = dayOfGridCol(colOf(cell, ci));
            if (d < 1) {
                noteUnmappedCell(parts);
                continue;
            }
            // 跨列的合并格：它的课只落在它覆盖的第一天（不复制到别的列去），但要出声
            if (spanOf(cell) > 1) mergedCells++;
            for (var p = 0; p < parts.length; p++) {
                var blocks = String(parts[p]).split(DASHES);
                for (var b = 0; b < blocks.length; b++) {
                    readBlock(blocks[b], d, rowSection);
                }
            }
        }
    }

    // 去重：同天、同节次、同课名、同教师、同教室、同周次的重复只留一条
    var seenEntry = {};
    var unique = [];
    for (var e = 0; e < entries.length; e++) {
        var en = entries[e];
        var dupKey = JSON.stringify([en.day, en.startSection, en.endSection, en.name,
            en.teacher, en.location, en.weeks]);
        if (seenEntry[dupKey]) continue;
        seenEntry[dupKey] = true;
        unique.push(en);
    }

    // 合并相邻节次（上游规则）：同天、同课名、同教师、同教室、同周次，节次紧邻，
    // 且合并后跨度不超过 4 节（(cur.endSection - prev.startSection) <= 3）。
    // 只跟同一组里最后一条比较 —— 同组内 DOM 顺序就是节次从小到大。
    function groupKeyOf(en) {
        return JSON.stringify([en.day, en.name, en.teacher, en.location, en.weeks]);
    }

    var merged = [];
    for (var u = 0; u < unique.length; u++) {
        var cur = unique[u];
        var groupKey = groupKeyOf(cur);
        var last = null;
        for (var mi = merged.length - 1; mi >= 0; mi--) {
            if (groupKeyOf(merged[mi]) === groupKey) {
                last = merged[mi];
                break;
            }
        }
        if (last && last.endSection + 1 === cur.startSection && (cur.endSection - last.startSection) <= 3) {
            last.endSection = cur.endSection;
        } else {
            merged.push({
                day: cur.day,
                startSection: cur.startSection,
                endSection: cur.endSection,
                name: cur.name,
                teacher: cur.teacher,
                location: cur.location,
                weeks: cur.weeks
            });
        }
    }

    // 课程：同课名 + 同教师算一门，教室与周次放在各自的 block 里；按第一次出现的顺序排
    var courseOrder = [];
    var courseByKey = {};
    for (var ki = 0; ki < merged.length; ki++) {
        var item = merged[ki];
        var courseKey = JSON.stringify([item.name, item.teacher]);
        var course = courseByKey[courseKey];
        if (!course) {
            course = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            courseByKey[courseKey] = course;
            courseOrder.push(course);
        }
        var runs = runsOf(item.weeks);
        for (var rn = 0; rn < runs.length; rn++) {
            course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.startSection,
                endPeriod: item.endSection,
                startWeek: runs[rn].start,
                endWeek: runs[rn].end,
                weekType: runs[rn].weekType,
                location: item.location
            });
        }
    }

    if (courseOrder.length === 0) {
        // 一个块都没解析出来：说清是「没课」还是「课都在解析时被跳过了」
        var totalSkipped = skippedBlocks + noPeriodBlocks + overPeriodBlocks;
        if (totalSkipped > 0) {
            throw new Error(clipText('本学期没有解析到任何课程：课表里有 ' + totalSkipped +
                ' 处课没能读出来（周次或节次的写法不认识，或节次超出 ' + MAX_PERIOD +
                ' 节）。' + droppedText() + ' 欢迎把课表截图反馈给空课', MAX_WARNING_TEXT));
        }
        throw new Error(
            '本学期没有解析到任何课程：可能是还没排课，或教务页面改了结构（也可能登录状态已失效）'
        );
    }

    var maxWeek = 0;
    var maxPeriod = 0;
    for (var oi = 0; oi < courseOrder.length; oi++) {
        var blocksOf = courseOrder[oi].blocks;
        for (var bi = 0; bi < blocksOf.length; bi++) {
            if (blocksOf[bi].endWeek > maxWeek) maxWeek = blocksOf[bi].endWeek;
            if (blocksOf[bi].endPeriod > maxPeriod) maxPeriod = blocksOf[bi].endPeriod;
        }
    }

    var totalWeeks = maxWeek > DEFAULT_TOTAL_WEEKS ? maxWeek : DEFAULT_TOTAL_WEEKS;
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    // 校区：extract.js 问来的。没拿到（提问桥不可用、用户取消、或名字认不出）回落青岛校区
    var campus = clean(data.campus);
    var campusFallback = CAMPUS_NAMES.indexOf(campus) < 0;
    if (campusFallback) campus = DEFAULT_CAMPUS;

    // 作息表：按校区取内置的 11 节表；超过 11 节时补占位条目（见 MAX_PERIOD 的注释）
    var baseTimes = CAMPUS_PERIODS[campus];
    var periodTimes = [];
    for (var pi = 0; pi < baseTimes.length; pi++) {
        periodTimes.push({
            periodIndex: baseTimes[pi].periodIndex,
            start: baseTimes[pi].start,
            end: baseTimes[pi].end
        });
    }
    for (var extra = PERIOD_COUNT + 1; extra <= maxPeriod; extra++) {
        periodTimes.push({
            periodIndex: extra,
            start: pad2(7 + extra) + ':00',
            end: pad2(7 + extra) + ':45'
        });
    }

    var termName = clean(term.name) || termNameFromCode(term.code);

    // extract.js 一定会带 now（提取时刻）；缺了就没法推算开学日，明确报错而不是瞎猜
    var firstDay = mondayOf(data.now);
    if (!firstDay) {
        throw new Error('没能获取到当前日期，无法推算开学日期，请重新导入');
    }

    // 推算 / 假定出来的东西逐条说清楚：这些值在库里和真值长得一模一样
    if (campusFallback) {
        pushWarning('没有选择校区，已按「青岛校区」的节次时间导入，如不符请在「学期管理」里修改');
    } else {
        pushWarning('已按「' + campus + '」的节次时间导入（教务页面不提供，三个校区的节次时间不同），' +
            '请到「学期管理」里核对');
    }
    pushWarning('开学日期无法从教务获取，已按最近的周一（' + firstDay + '）推算，请在「学期管理」里核对');
    pushWarning('教务页面不提供学期总周数：已按 ' + DEFAULT_TOTAL_WEEKS + ' 周起算，请在「学期管理」里核对');
    if (maxWeek > DEFAULT_TOTAL_WEEKS) {
        pushWarning('课表里有到第 ' + maxWeek + ' 周的课，超过了默认的 ' + DEFAULT_TOTAL_WEEKS +
            ' 周，学期总周数已按 ' + totalWeeks + ' 周计，请在「学期管理」里核对');
    }
    if (maxPeriod > PERIOD_COUNT) {
        pushWarning('课表里出现了节次时间里没有的第 ' + (PERIOD_COUNT + 1) + '-' + maxPeriod +
            ' 节，已暂按 ' + periodTimes[PERIOD_COUNT].start + ' 起的时间补上，请到「学期管理」里核对真实上下课时间');
    }
    if (!termName) {
        termName = '青岛农业大学学年学期';
        pushWarning('没能识别出学年学期名称，学期名暂用「青岛农业大学学年学期」，请在「学期管理」里改名');
    }
    if (skippedBlocks > 0 || noPeriodBlocks > 0 || overPeriodBlocks > 0) {
        var reasons = [];
        if (skippedBlocks > 0) reasons.push(skippedBlocks + ' 处课名或周次没认出');
        if (noPeriodBlocks > 0) reasons.push(noPeriodBlocks + ' 处没认出节次');
        if (overPeriodBlocks > 0) reasons.push(overPeriodBlocks + ' 处节次超出 ' + MAX_PERIOD + ' 节');
        pushWarning('有 ' + reasons.join('、') + '，这些课没有导入（教务页面可能有调整，欢迎反馈给空课）。' +
            droppedText());
    }
    if (noSectionRows > 0) {
        pushWarning('有 ' + noSectionRows + ' 行没认出节次标题（例：「' + noSectionSample +
            '」），这些行的课只能按格子里写的节次导入，请核对导入结果');
    }
    if (mismatchBlocks > 0) {
        pushWarning('有 ' + mismatchBlocks + ' 处课程的节次和所在行的节次对不上，已按格子里写的节次导入（例：「' +
            mismatchSample + '」），请核对导入结果');
    }
    if (droppedWeeks > 0) {
        pushWarning('有 ' + droppedWeeks + ' 个周次超出第 ' + MAX_WEEK + ' 周，已忽略');
    }
    if (ambiguousMarks > 0) {
        var marks = ambiguousSamples.length ? '（' + ambiguousSamples.join('、') + '）' : '';
        pushWarning('有 ' + ambiguousMarks + ' 处周次里的单双/隔周标记认不出来' + marks +
            '，这些周次已按「每周都上」处理，请核对导入结果');
    }
    if (bestLabels === 0) {
        pushWarning('课表里没找到星期几的标题，已按表格的列位置推算星期，课表可能整体错位，请核对导入结果');
    } else {
        if (guessedDays > 0) {
            pushWarning('课表标题里只认出了 ' + bestLabels + ' 个星期几，其余 ' + guessedDays +
                ' 天已按表格的列位置推算，请核对导入结果');
        }
        if (headerLabelCells > 7) {
            pushWarning('课表标题里出现了 ' + headerLabelCells +
                ' 个星期几，比一周的 7 天多：同一天以第一次出现的为准，请核对导入结果');
        }
    }
    if (unplacedDays > 0) {
        pushWarning('有 ' + unplacedDays + ' 天在课表里找不到对应的位置，这些天的课没有导入，请把课表截图反馈给空课');
    }
    if (unmappedCells > 0) {
        pushWarning('有 ' + unmappedCells + ' 处有课的格子对不上星期几，这些课没有导入' +
            (unmappedSample ? '（例：「' + unmappedSample + '」）' : '') + '，请核对导入结果');
    }
    if (mergedCells > 0) {
        pushWarning('有 ' + mergedCells + ' 个格子横跨了多天，格里的课只按它覆盖的「第一天」导入，请核对导入结果');
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
                courses: courseOrder
            }
        ]
    });
})()
