(function () {
    // 兰州大学本科生教务适配器（URP 系 jwk.lzu.edu.cn/academic）—— 第二步：页面结构 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 LZU/lzu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 yalerove）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-09 与 origin/main 对齐）
    //   本校脚本最后一次修改 63e312d（2026-09-04）
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① 四种取课策略按上游代码的顺序依次尝试、取第一个有课的：行列网格（策略 C）→ URP 标准网格（策略 A）→
    //      表格行（策略 B）→ 正文行（策略 B2）。解析从页面查询改成吃 extract.js 交出来的纯数据，CI 里能真跑
    //   ② 节次时间：先认页面表头里带时间的那一格（上游只在策略 A 成功时读，这里每种策略都读）；读不到回落到
    //      上游写死的兰大秋季 11 节表，并在提醒里说明用的是秋季节次时间、请核对
    //   ③ 开学日与学期名：上游完全没有（它把开学日留空）。这里从页面文字里认「20xx-20xx 学年第一/第二学期」，
    //      认不到按今天的日期推断学期，再按第一学期 = 9 月 1 日所在周的周一、第二学期 = 2 月 20 日所在周的周一推算，
    //      一律写进提醒；总周数取 20，课表更晚就抬高（最多 30）
    //   ④ 周次、节次解析重写：认单双周（含无逗号的前置标记）、「第」「周」字、括号备注、「共 N 周」、
    //      全角数字与各种破折号；认不出的计数写进提醒，不静默丢课
    //   ⑤ 上游缺教师 / 缺教室给空串、教室默认写「未知地点」，这里一律记成 null 并按类型汇总提醒
    //   ⑥ 上游按「课名 + 教师 + 地点 + 星期 + 周次」分组后把相邻节次合并；这里同样合并相邻节次与完全重复的行
    //      （含同日同节的重复行），但只在周次集合完全相同的时候合并，不把不同的周次拼成一段
    //   ⑦ 课表用到第 11 节之后的节次时照统一修订 H3 逐节补（空课默认节次表接得上就用，接不上按课间 5 分钟、
    //      每节 45 分钟顺推，越过 23:59 就停），补了哪些、哪些补不了都写进提醒
    //   ⑧ 上游的 showAlert / showToast / saveImportedCourses / savePresetTimeSlots / saveCourseConfig /
    //      notifyTaskCompletion 全部不移植：空课由宿主保存，只交载荷
    //
    // 这一步是纯转换：没有任何网络与页面访问，所以能（也只在）CI 里用 Rhino 真跑。

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    if (!data || typeof data !== 'object') {
        throw new Error('没有拿到教务数据：请重新登录教务系统后再点「提取课表」');
    }

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '兰州大学';     // 学期名兜底时用（学校名 + 学年学期，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给总周数：取 20 周，课表更晚就抬高
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数
    var TERM_TEXT_LIMIT = 20;      // 提醒里点名的学期名最多显示的字数
    var SAMPLE_COUNT = 3;          // 提醒里"例如"最多列几门课
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间顺推：每节几分钟
    var SEP = String.fromCharCode(1);

    // 学校的节次时间（上游 LZU_TIME_SLOTS，兰大秋季作息，校教〔2014〕4号，共 11 节，逐节搬过来）
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:30', end: '09:15' },
        { periodIndex: 2, start: '09:25', end: '10:10' },
        { periodIndex: 3, start: '10:30', end: '11:15' },
        { periodIndex: 4, start: '11:25', end: '12:10' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:25', end: '16:10' },
        { periodIndex: 7, start: '16:30', end: '17:15' },
        { periodIndex: 8, start: '17:25', end: '18:10' },
        { periodIndex: 9, start: '19:00', end: '19:45' },
        { periodIndex: 10, start: '19:55', end: '20:40' },
        { periodIndex: 11, start: '20:50', end: '21:35' }
    ];

    // 空课默认节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到第 11 节之后的节次时，接得上才用它补
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

    var DAY_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    // 课名 / 学期名过长时截短，避免一个超长名字就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name, limit) {
        var line = text(name);
        var max = limit || NAME_TEXT_LIMIT;
        return line.length > max ? line.substring(0, max - 1) + '…' : line;
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function utcOfIso(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!m) return null;
        var ms = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        return isNaN(ms) ? null : ms;
    }

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOf(iso) {
        var ms = utcOfIso(iso);
        if (ms === null) return null;
        var date = new Date(ms);
        var offset = (date.getUTCDay() + 6) % 7;
        return isoOf(new Date(ms - offset * 86400000));
    }

    function isoOfAny(value) {
        var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    function normalizeHhMm(value) {
        var m = /^([0-9]{1,2}):([0-5][0-9])$/.exec(text(value));
        if (!m) return null;
        var hour = parseInt(m[1], 10);
        if (hour > 23) return null;
        return pad2(hour) + ':' + m[2];
    }

    var warnings = [];
    var droppedWarnings = 0;

    // 所有提醒都走这一个出口：整条限长，条数封顶
    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // 教务数据里偶尔带 HTML 实体：纯字符串解码（parse.js 在 CI 里跑，没有 document 可用）
    function codePointOf(value) {
        if (!(value > 0) || value > 0x10ffff) return '';
        if (value <= 0xffff) return String.fromCharCode(value);
        var rest = value - 0x10000;
        return String.fromCharCode(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff));
    }

    function decodeEntities(value) {
        if (value === null || value === undefined) return '';
        var out = String(value);
        if (out.indexOf('&') < 0) return out;
        out = out
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&apos;/gi, "'");
        out = out
            .replace(/&#x([0-9a-f]{1,5});/gi, function (all, hex) { return codePointOf(parseInt(hex, 16)); })
            .replace(/&#(\d{1,6});/g, function (all, dec) { return codePointOf(parseInt(dec, 10)); });
        return out.replace(/&amp;/gi, '&');   // &amp; 最后解，免得 "&amp;lt;" 被解成 "<"
    }

    // ---------- 周次 ----------
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单/双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字）
    var noteGroups = 0;      // 被摘掉的备注括号个数（含非周次的字）
    var noteSample = '';     // 第一个备注括号的原文
    var bothMarks = 0;       // 同时写了「单」和「双」的段数
    var weekSamples = [];    // 认不出的周次原文（最多一条，提醒里截 20 字）

    function fullWidthToHalf(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[，、；;]/g, ',')
            .replace(/[～~—－–至]/g, '-');
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // 「共 N 周」是课程总周数备注，只剥备注本身；不能从「共」一路删到行尾，后面的真实周次段会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 「至」「到」）连同两侧空白归成半角 '-'，不要在这里删掉全部空白
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 区间终点前的「第」（"第1-第8周"）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        cleaned = cleaned.replace(/第/g, '');
        // 紧挨周次的单/双括号按相邻关系先归属：前缀写法 "(单)1-8周,(双)9-16周" 的标记跟着自己那一段走；
        // 标记夹在两段中间（前面紧挨数字或「周」、后面紧跟数字）时要判断归属：当前这一段本身以前缀标记开头
        // （"(单)1-8周(双)9-16周" 里的第二个标记）时，它是后一段的前缀，前面补逗号隔开；否则仍是上一段的后缀
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            var segmentHead = before.substring(before.lastIndexOf(',') + 1);
            if (/^\s*\([单双]/.test(segmentHead)) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            return digit + mark + (/^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '');
        });
        // 括号逐组处理：纯数字的是教学班序号，整组摘掉；含非周次字的是备注，摘掉并计数；其余保留内容；每组都换成逗号
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = all;
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        var tokens = cleaned.replace(/\s+/g, ',').split(/,+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
        // 单/双自己成一段时并给最近的周次段（先向前找，找不到再向后）
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空）；这是判断不是事实，计数后写进提醒
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:-[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                if (end > 99) end = 99;    // 防止 "1-99999999" 这类脏数据空转
                for (var week = start; week <= end; week++) {
                    if (onlyOdd && week % 2 === 0) continue;
                    if (onlyEven && week % 2 === 1) continue;
                    if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
                    if (!seen[week]) { seen[week] = true; weeks.push(week); }
                }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    // 周次文字读不出来时留一条原文，提醒里点名（截 20 字）
    function weeksFrom(source) {
        var weeks = weeksOf(source);
        if (!weeks.length && text(source) && weekSamples.length < 1) {
            weekSamples.push(shortName(source));
        }
        return weeks;
    }

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周
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

    // ---------- 节次 ----------
    // 上游 parseSections：去「节」「第」「上午」「下午」「晚上」「晚」后，先认 a-b，再认「12」「34」这类相邻两位
    function sectionsOf(source) {
        var cleaned = fullWidthToHalf(text(source)).replace(/[节第上午下午晚上晚\s]/g, '');
        if (!cleaned) return null;
        var range = /([0-9]{1,2})\s*-\s*([0-9]{1,2})/.exec(cleaned);
        if (range) {
            var from = parseInt(range[1], 10);
            var to = parseInt(range[2], 10);
            if (from > to) { var swap = from; from = to; to = swap; }
            if (from < 1 || to > MAX_PERIOD) return null;
            return { start: from, end: to };
        }
        var single = /([0-9]+)/.exec(cleaned);
        if (!single) return null;
        var digits = single[1];
        if (digits.length === 2 && parseInt(digits.charAt(1), 10) === parseInt(digits.charAt(0), 10) + 1) {
            return { start: parseInt(digits.charAt(0), 10), end: parseInt(digits.charAt(1), 10) };
        }
        var n = parseInt(digits, 10);
        if (n < 1 || n > MAX_PERIOD) return null;
        return { start: n, end: n };
    }

    // 从一段文字里认出节次（"晚9-11节" "上午12节" "第1-2节"）；用于课程格里逐行分类
    function sectionFromText(value) {
        var line = text(value);
        if (!line) return null;
        var m = /((?:上午|下午|晚上|晚|第)?\s*[0-9]{1,2}\s*[-—–~～至]\s*[0-9]{1,2}\s*节|(?:上午|下午|晚上|晚|第)?\s*[0-9]{1,2}\s*节)/.exec(line);
        if (!m) return null;
        return sectionsOf(m[1]);
    }

    function dayFromText(value) {
        var key = text(value).replace(/星期|礼拜|周/g, '');
        return DAY_MAP[key] || 0;
    }

    function dayFromLines(lines) {
        if (!Array.isArray(lines)) return 0;
        for (var i = 0; i < lines.length; i++) {
            var day = dayFromText(lines[i]);
            if (day) return day;
        }
        return 0;
    }

    // ---------- 学期名与开学日 ----------
    // 页面上的「2025-2026 学年第一学期」「2025-2026学年秋季学期」；认不出就用今天的日期推断
    var TERM_RE = /((20[0-9]{2})\s*[-—–~～至]\s*(20[0-9]{2})\s*学年\s*(?:第\s*)?([一二12])\s*学期)/;
    var TERM_ALT = /((20[0-9]{2})\s*[-—–~～至]\s*(20[0-9]{2})\s*学年\s*(秋|春)季?\s*学期)/;

    function termFromLine(line) {
        var m = TERM_RE.exec(line);
        if (m) {
            return {
                name: text(m[1]),
                year: parseInt(m[2], 10),
                kind: (m[4] === '一' || m[4] === '1') ? 'first' : 'second'
            };
        }
        m = TERM_ALT.exec(line);
        if (m) {
            return { name: text(m[1]), year: parseInt(m[2], 10), kind: m[4] === '秋' ? 'first' : 'second' };
        }
        return null;
    }

    function findTerm() {
        var i;
        var j;
        var k;
        var lines = Array.isArray(data.textLines) ? data.textLines : [];
        for (i = 0; i < lines.length; i++) {
            var found = termFromLine(text(lines[i]));
            if (found) return found;
        }
        var rows = Array.isArray(data.listRows) ? data.listRows : [];
        for (i = 0; i < rows.length; i++) {
            if (!Array.isArray(rows[i])) continue;
            for (j = 0; j < rows[i].length; j++) {
                var fromRow = termFromLine(text(rows[i][j]));
                if (fromRow) return fromRow;
            }
        }
        var tables = Array.isArray(data.tables) ? data.tables : [];
        for (i = 0; i < tables.length; i++) {
            var trows = tables[i] && tables[i].rows;
            if (!Array.isArray(trows)) continue;
            for (j = 0; j < trows.length; j++) {
                var cells = trows[j] || [];
                for (k = 0; k < cells.length; k++) {
                    var cellLines = cells[k] && cells[k].lines;
                    if (!Array.isArray(cellLines)) continue;
                    for (var l = 0; l < cellLines.length; l++) {
                        var fromCell = termFromLine(text(cellLines[l]));
                        if (fromCell) return fromCell;
                    }
                }
            }
        }
        return null;
    }

    // 今天在哪一学期：8 月到次年 1 月算第一学期，2 月到 7 月算第二学期
    function inferParts(todayIso) {
        var m = /^([0-9]{4})-([0-9]{2})/.exec(text(todayIso));
        var year;
        var month;
        if (m) {
            year = parseInt(m[1], 10);
            month = parseInt(m[2], 10);
        } else {
            var now = new Date();
            year = now.getUTCFullYear();
            month = now.getUTCMonth() + 1;
        }
        if (month >= 8) return { year: year, kind: 'first' };
        if (month <= 1) return { year: year - 1, kind: 'first' };
        if (month <= 6) return { year: year - 1, kind: 'second' };
        return { year: year, kind: 'first' };  // 7 月放暑假，按下一学年第一学期算
    }

    // ---------- 策略 C：行列网格（兰大 showTimetable 学生课表） ----------
    function joinLines(cell) {
        if (!cell || !Array.isArray(cell.lines)) return '';
        return text(cell.lines.join(' '));
    }

    function tableDayColumns(rows) {
        for (var r = 0; r < rows.length; r++) {
            var cells = rows[r] || [];
            var map = {};
            var count = 0;
            for (var c = 0; c < cells.length; c++) {
                var day = dayFromLines(cells[c] && cells[c].lines);
                if (day) { map[c] = day; count++; }
            }
            if (count >= 5) return { headerRow: r, colDay: map };
        }
        return null;
    }

    function cellDay(cell, fallback) {
        var m = /^([1-7])-/.exec(text(cell && cell.id));
        return m ? parseInt(m[1], 10) : fallback;
    }

    // "&lt;&lt;数学物理方法Ⅰ&gt;&gt;;2" → "数学物理方法Ⅰ"；去掉课程号后缀，但保留课名里的数字
    function cleanCourseName(value) {
        var name = text(value).replace(/&lt;|&gt;/g, '').replace(/<</g, '');
        var cut = name.indexOf('>>');
        if (cut >= 0) name = name.substring(0, cut);
        name = name.replace(/[;；][0-9]*\s*$/, '');
        return text(name);
    }

    function isBuildingLike(value) {
        return /(堂|楼|馆|室|区|操场)/.test(value) || /[A-Za-z]+\s*[0-9]+/.test(value);
    }

    function parseCourseCell(lines, day, fallbackSection) {
        var out = [];
        var cur = null;
        var flush = function () {
            if (cur) out.push(cur);
            cur = null;
        };
        for (var i = 0; i < lines.length; i++) {
            var line = text(lines[i]);
            if (!line) continue;
            var secL = /周/.test(line) ? null : sectionFromText(line);
            var isNameLine = line.indexOf('>>') >= 0 || line.indexOf('<<') >= 0 ||
                (!cur && !/周|学时|讲课|堂|楼|馆|节/.test(line) && line.length <= 40 && !/^[0-9]/.test(line));
            if (isNameLine) {
                flush();
                cur = {
                    name: cleanCourseName(line), teacher: '', location: '',
                    day: day, start: null, end: null, weeks: []
                };
            } else if (cur) {
                if (secL) {
                    cur.start = secL.start;
                    cur.end = secL.end;
                } else if (/[0-9]+周|全周|单周|双周/.test(line)) {
                    var more = weeksFrom(line);
                    for (var w = 0; w < more.length; w++) {
                        if (cur.weeks.indexOf(more[w]) < 0) cur.weeks.push(more[w]);
                    }
                    cur.weeks.sort(function (a, b) { return a - b; });
                } else if (/学时|讲课|备注|实践/.test(line) || /^[0-9]{1,2}:[0-9]{2}/.test(line)) {
                    // 备注 / 上课时间行，跳过
                } else if (isBuildingLike(line)) {
                    cur.location = line;
                } else {
                    cur.teacher = text((cur.teacher ? cur.teacher + ' ' : '') + line);
                }
            }
        }
        flush();
        for (var k = 0; k < out.length; k++) {
            if (!out[k].start && fallbackSection) {
                out[k].start = fallbackSection.start;
                out[k].end = fallbackSection.end;
            }
        }
        return out;
    }

    function strategyGrid() {
        var tables = Array.isArray(data.tables) ? data.tables : [];
        var out = [];
        for (var t = 0; t < tables.length; t++) {
            var rows = tables[t] && tables[t].rows;
            if (!Array.isArray(rows) || !rows.length) continue;
            var dayInfo = tableDayColumns(rows);
            if (!dayInfo) continue;
            var carriedSection = null;
            for (var r = dayInfo.headerRow + 1; r < rows.length; r++) {
                var cells = rows[r] || [];
                // 行节次：找不含「周」、内容短、含 节 / 时间 的标签格（课程格都含周次，不会误判）
                var rowSection = null;
                var c;
                for (c = 0; c < cells.length; c++) {
                    var label = joinLines(cells[c]);
                    if (!label || label.length > 60 || /周/.test(label)) continue;
                    if (!/节|^[0-9]{1,2}:[0-9]{2}/.test(label)) continue;
                    rowSection = sectionFromText(label);
                    if (rowSection) break;
                }
                if (!rowSection) rowSection = carriedSection; else carriedSection = rowSection;
                if (!rowSection) continue;
                for (c = 0; c < cells.length; c++) {
                    var cell = cells[c];
                    var txt = joinLines(cell);
                    if (!txt || txt.length < 4) continue;
                    if (/^(&nbsp;|\s|-|—|・|\.)*$/.test(txt)) continue;
                    var looksCourse = /<<|>>/.test(txt) || (/周/.test(txt) && !dayFromLines(cell.lines));
                    if (!looksCourse) continue;
                    var day = cellDay(cell, dayInfo.colDay[c] || 0);
                    var blocks = parseCourseCell(Array.isArray(cell.lines) ? cell.lines : [], day, rowSection);
                    for (var b = 0; b < blocks.length; b++) out.push(blocks[b]);
                }
            }
        }
        return out;
    }

    // ---------- 策略 A：URP 标准网格（td[id="星期_序号"] 里的 .class_div） ----------
    function strategyUrp() {
        var tds = Array.isArray(data.urpCells) ? data.urpCells : [];
        var out = [];
        for (var t = 0; t < tds.length; t++) {
            var id = text(tds[t] && tds[t].id);
            var idParts = id.split('_');
            if (idParts.length !== 2) continue;
            var day = parseInt(idParts[0], 10);
            if (isNaN(day) || day < 1 || day > 7) continue;
            var divs = tds[t] && tds[t].divs;
            if (!Array.isArray(divs)) continue;
            for (var d = 0; d < divs.length; d++) {
                var p = divs[d];
                if (!Array.isArray(p) || p.length < 5) continue;
                // 兼容两种结构：教师 / 周次 / 节次 / 地点 在 p[1..4] 或 p[2..5]
                var teacherIdx = 2;
                var weekIdx = 3;
                var secIdx = 4;
                var posIdx = 5;
                var p1 = text(p[1]);
                if (p1 && !/[0-9]/.test(p1) && p1.indexOf('周') < 0 && p1.length < 10) {
                    teacherIdx = 1;
                    weekIdx = 2;
                    secIdx = 3;
                    posIdx = 4;
                }
                var name = text(p[0]);
                if (!name) continue;
                var weeks = weeksFrom(p[weekIdx]);
                if (!weeks.length) continue;
                var sec = sectionsOf(p[secIdx]);
                if (!sec) continue;
                out.push({
                    name: name,
                    teacher: text(p[teacherIdx] || ''),
                    location: text(p[posIdx] || ''),
                    day: day,
                    start: sec.start,
                    end: sec.end,
                    weeks: weeks
                });
            }
        }
        return out;
    }

    // ---------- 策略 B：课程列表（表格行） ----------
    // 排课字符串形如: "1-18周全周 星期一 下午56节 天山堂A504"
    var WEEK_DAY_RE = new RegExp('([第]?[-0-9,，–—]+周(?:全周|单周|双周)?)\\s*(星期[一二三四五六日天]|周[一二三四五六日天])\\s*((?:上午|下午|晚上|晚)?\\s*[0-9]+(?:[-–—~～至][0-9]+)?节)\\s*(\\S+)');
    var WEEK_DAY_RE_NO_POS = new RegExp('([第]?[-0-9,，–—]+周(?:全周|单周|双周)?)\\s*(星期[一二三四五六日天]|周[一二三四五六日天])\\s*((?:上午|下午|晚上|晚)?\\s*[0-9]+(?:[-–—~～至][0-9]+)?节)');

    function tokensOf(cells) {
        var out = [];
        for (var i = 0; i < cells.length; i++) {
            var parts = text(cells[i]).split(' ');
            for (var j = 0; j < parts.length; j++) {
                if (parts[j]) out.push(parts[j]);
            }
        }
        return out;
    }

    // 课程号特征: 形如 2402003 / 1402401b / 101402001(3)
    function findCourseInfo(tokens) {
        var codeIdx = -1;
        var i;
        for (i = 0; i < tokens.length; i++) {
            if (/^[0-9]{3,}[a-zA-Z]*(\([0-9]+\))?$/.test(tokens[i]) && tokens[i].length <= 12) {
                codeIdx = i;
                break;
            }
        }
        if (codeIdx < 0) return null;
        for (i = codeIdx + 1; i < tokens.length; i++) {
            if (/^[0-9.\-]+$/.test(tokens[i]) || tokens[i].indexOf('周') >= 0) continue;
            var teacher = text(tokens[i + 1] || '');
            // 下一个词是排课信息时不是教师（例如只有课名没有教师的那一行）
            if (/周|星期|节|^[0-9]/.test(teacher)) teacher = '';
            return { name: tokens[i], teacher: teacher.replace(/\*+/g, ' ') };
        }
        return null;
    }

    function allSchedules(value) {
        var out = [];
        var re = new RegExp(WEEK_DAY_RE.source, 'g');
        var m;
        while ((m = re.exec(value)) !== null) {
            var weeks = weeksFrom(m[1]);
            var day = dayFromText(m[2]);
            var sec = sectionsOf(m[3]);
            if (weeks.length && day && sec) {
                out.push({ weeks: weeks, day: day, start: sec.start, end: sec.end, location: text(m[4]) });
            }
            if (m[0].length === 0) re.lastIndex++;
        }
        return out;
    }

    function strategyList() {
        var rows = Array.isArray(data.listRows) ? data.listRows : [];
        var out = [];
        var pending = null;
        for (var r = 0; r < rows.length; r++) {
            var cells = Array.isArray(rows[r]) ? rows[r] : [];
            var rowText = text(cells.join(' '));
            var info = findCourseInfo(tokensOf(cells));
            if (info) pending = info;
            if (!pending) continue;
            var scheds = allSchedules(rowText);
            for (var s = 0; s < scheds.length; s++) {
                out.push({
                    name: pending.name,
                    teacher: pending.teacher,
                    location: scheds[s].location,
                    day: scheds[s].day,
                    start: scheds[s].start,
                    end: scheds[s].end,
                    weeks: scheds[s].weeks
                });
            }
        }
        return out;
    }

    // ---------- 策略 B2：正文行 ----------
    function scheduleFromText(line, nextLine) {
        var m = WEEK_DAY_RE.exec(line);
        if (m) {
            var weeks = weeksFrom(m[1]);
            var day = dayFromText(m[2]);
            var sec = sectionsOf(m[3]);
            if (weeks.length && day && sec) {
                return { weeks: weeks, day: day, start: sec.start, end: sec.end, location: text(m[4]) };
            }
            return null;
        }
        m = WEEK_DAY_RE_NO_POS.exec(line);
        if (m) {
            var weeks2 = weeksFrom(m[1]);
            var day2 = dayFromText(m[2]);
            var sec2 = sectionsOf(m[3]);
            if (!weeks2.length || !day2 || !sec2) return null;
            var rest = text(line.substring(line.indexOf(m[3]) + m[3].length));
            var location = rest ? rest.split(' ')[0] : '';
            if (!location) location = text(nextLine).split(' ')[0] || '';
            return { weeks: weeks2, day: day2, start: sec2.start, end: sec2.end, location: location };
        }
        return null;
    }

    function strategyText() {
        var lines = Array.isArray(data.textLines) ? data.textLines : [];
        var out = [];
        var pending = null;
        for (var i = 0; i < lines.length; i++) {
            var line = text(lines[i]);
            var nextLine = text(lines[i + 1] || '');
            var info = findCourseInfo(line.split(' '));
            var sched = scheduleFromText(line, nextLine);
            if (info) {
                pending = info;
                if (sched) pushSchedule(out, info, sched);
            } else if (pending && sched) {
                pushSchedule(out, pending, sched);
            }
        }
        return out;
    }

    function pushSchedule(out, info, sched) {
        out.push({
            name: info.name,
            teacher: info.teacher,
            location: sched.location,
            day: sched.day,
            start: sched.start,
            end: sched.end,
            weeks: sched.weeks
        });
    }

    // ---------- 归一化与合并 ----------
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var EMPTY_VALUE = /^(未知|暂无|待定|无|未知地点|未知教室|暂无地点|暂无教室)$/;

    function cleanField(value) {
        var line = text(decodeEntities(value));
        return EMPTY_VALUE.test(line) ? '' : line;
    }

    function normalizeBlock(raw) {
        if (!raw) return null;
        var name = text(decodeEntities(raw.name));
        if (!name) { missing.name++; return null; }
        var day = intOf(raw.day);
        if (day === null || day < 1 || day > 7) { missing.day++; return null; }
        var start = intOf(raw.start);
        var end = intOf(raw.end);
        if (start === null || start < 1) { missing.period++; return null; }
        if (end === null || end < start) end = start;
        if (start > MAX_PERIOD) { missing.period++; return null; }
        if (end > MAX_PERIOD) end = MAX_PERIOD;
        var rawWeeks = Array.isArray(raw.weeks) ? raw.weeks : [];
        var weeks = [];
        for (var i = 0; i < rawWeeks.length; i++) {
            var w = intOf(rawWeeks[i]);
            if (w === null || w < 1 || w > MAX_WEEK) continue;
            if (weeks.indexOf(w) < 0) weeks.push(w);
        }
        if (!weeks.length) { missing.week++; return null; }
        weeks.sort(function (a, b) { return a - b; });
        return {
            name: name,
            teacher: cleanField(raw.teacher),
            location: cleanField(raw.location),
            day: day,
            start: start,
            end: end,
            weeks: weeks
        };
    }

    function mergeBlocks(list) {
        var courses = {};
        var courseOrder = [];
        var i;
        var j;
        for (i = 0; i < list.length; i++) {
            var b = normalizeBlock(list[i]);
            if (!b) continue;
            var courseKey = b.name + SEP + (b.teacher || '');
            var course = courses[courseKey];
            if (!course) {
                course = { name: b.name, teacher: b.teacher, slots: [], slotIndex: {} };
                courses[courseKey] = course;
                courseOrder.push(courseKey);
            }
            // 同一时段（星期 + 节次 + 地点）的多行把周次合并成并集
            var slotKey = b.day + '|' + b.start + '|' + b.end + '|' + (b.location || '');
            var slot = course.slotIndex[slotKey];
            if (!slot) {
                slot = { day: b.day, start: b.start, end: b.end, location: b.location, seen: {}, weeks: [] };
                course.slotIndex[slotKey] = slot;
                course.slots.push(slot);
            }
            for (j = 0; j < b.weeks.length; j++) {
                if (!slot.seen[b.weeks[j]]) {
                    slot.seen[b.weeks[j]] = true;
                    slot.weeks.push(b.weeks[j]);
                }
            }
        }
        // 相邻节次合并：同课名、同教师、同地点、同星期、周次集合完全一致（含同日同节的重复行）
        for (i = 0; i < courseOrder.length; i++) {
            var item = courses[courseOrder[i]];
            var groups = {};
            var groupOrder = [];
            for (j = 0; j < item.slots.length; j++) {
                var s = item.slots[j];
                s.weeks.sort(function (x, y) { return x - y; });
                var gkey = s.day + '|' + (s.location || '') + '|' + s.weeks.join(',');
                if (!groups[gkey]) {
                    groups[gkey] = [];
                    groupOrder.push(gkey);
                }
                groups[gkey].push(s);
            }
            item.blocks = [];
            for (j = 0; j < groupOrder.length; j++) {
                var grp = groups[groupOrder[j]];
                grp.sort(function (x, y) { return x.start - y.start; });
                var cur = { day: grp[0].day, start: grp[0].start, end: grp[0].end, location: grp[0].location, weeks: grp[0].weeks };
                var made = [];
                for (var k = 1; k < grp.length; k++) {
                    if (grp[k].start <= cur.end + 1) {
                        if (grp[k].end > cur.end) cur.end = grp[k].end;
                    } else {
                        made.push(cur);
                        cur = { day: grp[k].day, start: grp[k].start, end: grp[k].end, location: grp[k].location, weeks: grp[k].weeks };
                    }
                }
                made.push(cur);
                for (var m = 0; m < made.length; m++) item.blocks.push(made[m]);
            }
            item.blocks.sort(function (x, y) {
                if (x.day !== y.day) return x.day - y.day;
                if (x.start !== y.start) return x.start - y.start;
                return x.end - y.end;
            });
        }
        return { courses: courses, order: courseOrder };
    }

    // ---------- 跑策略：按上游代码的顺序，取第一个有课的 ----------
    var strategies = [
        { name: 'grid', run: strategyGrid },
        { name: 'urp', run: strategyUrp },
        { name: 'list', run: strategyList },
        { name: 'text', run: strategyText }
    ];
    var picked = null;
    var used = '';
    for (var st = 0; st < strategies.length; st++) {
        var candidate = strategies[st].run();
        if (candidate && candidate.length) {
            picked = candidate;
            used = strategies[st].name;
            break;
        }
    }

    var anyData = (Array.isArray(data.tables) && data.tables.length) ||
        (Array.isArray(data.urpCells) && data.urpCells.length) ||
        (Array.isArray(data.listRows) && data.listRows.length) ||
        (Array.isArray(data.textLines) && data.textLines.length);
    if (!anyData) {
        throw new Error('没有在页面上找到课表数据：请先登录教务系统，打开「学生课表」页面（网格或列表视图）后再点「提取课表」');
    }
    if (!picked || !picked.length) {
        throw new Error('没有从当前页面里认出任何课程：请确认打开的是「学生课表」页面，或先在教务里切换到要导入的学期再点「提取课表」');
    }
    var merged = mergeBlocks(picked);
    if (!merged.order.length) {
        throw new Error('没有从当前页面里认出任何课程：请确认打开的是「学生课表」页面，或先在教务里切换到要导入的学期再点「提取课表」');
    }

    // ---------- 节次时间：页面表头优先，读不到用学校公布的秋季表 ----------
    var pageSlots = [];
    var rawSlots = Array.isArray(data.headerSlots) ? data.headerSlots : [];
    var slotByNumber = {};
    for (var rs = 0; rs < rawSlots.length; rs++) {
        var rawSlot = rawSlots[rs] || {};
        var slotLine = text(rawSlot.text);
        var number = null;
        var idMatch = /^0_([0-9]{1,2})$/.exec(text(rawSlot.id));
        if (idMatch) number = parseInt(idMatch[1], 10);
        if (number === null) {
            var numMatch = /第\s*([0-9]{1,2})\s*节/.exec(slotLine);
            if (numMatch) number = parseInt(numMatch[1], 10);
        }
        if (number === null || number < 1) continue;
        var times = slotLine.match(/[0-9]{1,2}:[0-5][0-9]/g) || [];
        if (times.length < 2) continue;
        var slotStart = normalizeHhMm(times[0]);
        var slotEnd = normalizeHhMm(times[1]);
        if (!slotStart || !slotEnd || minutesOf(slotStart) >= minutesOf(slotEnd)) continue;
        if (slotByNumber[number]) continue;
        slotByNumber[number] = { periodIndex: number, start: slotStart, end: slotEnd };
    }
    var slotKeyList = [];
    for (var slotKey in slotByNumber) {
        if (Object.prototype.hasOwnProperty.call(slotByNumber, slotKey)) slotKeyList.push(parseInt(slotKey, 10));
    }
    slotKeyList.sort(function (a, b) { return a - b; });
    for (var sk = 0; sk < slotKeyList.length; sk++) pageSlots.push(slotByNumber[slotKeyList[sk]]);

    // 页面表头只给出部分节次时（常见是只渲染了当前时段），缺的节次用学校公布的表补齐，
    // 不能整张换成页面那几条——否则第 1 节的课在应用里没有上下课时间
    var periodTimes = [];
    var fromSchoolTable = !pageSlots.length;
    var filledFromSchool = [];
    if (fromSchoolTable) {
        periodTimes = PERIOD_TIMES.slice(0);
    } else {
        var lastPageSlot = pageSlots[pageSlots.length - 1].periodIndex;
        for (var pi = 1; pi <= lastPageSlot; pi++) {
            var hitSlot = null;
            for (var pj = 0; pj < pageSlots.length; pj++) {
                if (pageSlots[pj].periodIndex === pi) { hitSlot = pageSlots[pj]; break; }
            }
            if (hitSlot) { periodTimes.push(hitSlot); continue; }
            if (pi <= PERIOD_TIMES.length) {
                periodTimes.push(PERIOD_TIMES[pi - 1]);
                filledFromSchool.push(pi);
            } else {
                break;
            }
        }
    }

    var payloadCourses = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    var missingTeacherCourses = 0;
    var missingLocationCourses = 0;
    var fieldSamples = [];
    var c;
    var p;
    var n;
    for (c = 0; c < merged.order.length; c++) {
        var course = merged.courses[merged.order[c]];
        if (!course.teacher) {
            missingTeacherCourses++;
            if (fieldSamples.length < SAMPLE_COUNT && fieldSamples.indexOf(course.name) < 0) fieldSamples.push(course.name);
        }
        var hasLocation = false;
        for (p = 0; p < course.blocks.length; p++) {
            if (course.blocks[p].location) hasLocation = true;
        }
        if (!hasLocation) {
            missingLocationCourses++;
            if (fieldSamples.length < SAMPLE_COUNT && fieldSamples.indexOf(course.name) < 0) fieldSamples.push(course.name);
        }
        var blocks = [];
        for (p = 0; p < course.blocks.length; p++) {
            var block = course.blocks[p];
            if (block.end > maxPeriod) maxPeriod = block.end;
            var runs = runsOf(block.weeks);
            for (n = 0; n < runs.length; n++) {
                if (runs[n].end > maxWeek) maxWeek = runs[n].end;
                blocks.push({
                    dayOfWeek: block.day,
                    startPeriod: block.start,
                    endPeriod: block.end,
                    startWeek: runs[n].start,
                    endWeek: runs[n].end,
                    weekType: runs[n].weekType,
                    location: block.location || null
                });
            }
        }
        payloadCourses.push({ name: course.name, teacher: course.teacher || null, note: null, blocks: blocks });
    }

    // 课表用到学校节次表之后的节次时，照统一修订 H3 逐节补
    var lastIndex = periodTimes.length ? periodTimes[periodTimes.length - 1].periodIndex : 0;
    var fromDefault = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (p = lastIndex + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var defaultSlot = DEFAULT_PERIOD_TIMES[p - 1];
        if (defaultSlot && minutesOf(defaultSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: defaultSlot.start, end: defaultSlot.end });
            fromDefault.push(p);
            continue;
        }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // 节次号（已升序）写成「第 12-13 节」「第 12 节」「第 12、14 节」这几种
    function sectionsText(list) {
        var parts = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            parts.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + parts.join('、') + ' 节';
    }

    // ---------- 学期名与开学日 ----------
    var term = findTerm();
    var parts = term ? { year: term.year, kind: term.kind } : inferParts(data.today);
    var termName = term
        ? term.name
        : (SCHOOL_NAME + ' ' + parts.year + '-' + (parts.year + 1) + ' 学年' + (parts.kind === 'first' ? '第一学期' : '第二学期'));
    termName = text(termName);
    var rule = parts.kind === 'first' ? '第一学期 = 9 月 1 日所在周的周一' : '第二学期 = 2 月 20 日所在周的周一';
    var anchor = parts.kind === 'first' ? (parts.year + '-09-01') : ((parts.year + 1) + '-02-20');
    var firstDay = mondayOf(anchor) || mondayOf(isoOfAny(data.today) || '') || '2000-01-03';

    // 总周数：教务不给，取 20 周，课表里有更晚的周次就抬高
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    if (term) {
        warn('只导入了「' + shortName(termName, TERM_TEXT_LIMIT) + '」；要导入别的学期，请先在教务「学生课表」页面切到那个学期再点「提取课表」');
    } else {
        warn('教务页面没有给出学期名称，已按今天的日期推断为「' + shortName(termName, TERM_TEXT_LIMIT) + '」，请核对；要导入别的学期，请先在教务「学生课表」页面切到那个学期再点「提取课表」');
    }
    warn('教务页面没有给出开学日期，第 1 周按「' + rule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日');
    if (raisedBySchedule) {
        warn('教务页面没有给出学期总周数；课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
    } else {
        warn('教务页面没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    }
    if (filledFromSchool.length) {
        warn('教务页面只给出了部分节次的上下课时间，' + sectionsText(filledFromSchool) +
            '用的是学校公布的秋季节次时间，春季学期可能不同，请核对');
    }
    if (fromSchoolTable) {
        warn('教务页面没有给出节次时间，已按学校公布的秋季节次时间导入（第 1 节 ' + PERIOD_TIMES[0].start + ' 开始、第 ' + PERIOD_TIMES[PERIOD_TIMES.length - 1].periodIndex + ' 节 ' + PERIOD_TIMES[PERIOD_TIMES.length - 1].end + ' 结束）：春季学期的上课时间可能不同，请核对');
    }
    if (fromDefault.length || bySequence.length) {
        var fillTexts = [];
        if (fromDefault.length) fillTexts.push(sectionsText(fromDefault) + '用空课默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromDefault.concat(bySequence).sort(function (a, b) { return a - b; });
        warn('课表用到了' + sectionsText(filledAll) + '，学校公布的节次时间没有覆盖，已补上：' + fillTexts.join('，') + '，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }
    if (data.truncated) {
        warn('这个页面的内容过多，只读取了前一部分：如果发现少了课，请先在教务里把课表切换成网格视图再试');
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 行');
        if (missing.period) reasons.push('缺节次（或节次超出 1-' + MAX_PERIOD + ' 节）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (weekSamples.length) reasons.push('认不出的周次写法如「' + shortName(weekSamples[0]) + '」');
        warn('有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') + '），已跳过：教务数据不完整时会出现，如发现少课请反馈');
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），按类型汇总计数
    if (missingTeacherCourses > 0 || missingLocationCourses > 0) {
        var fieldParts = [];
        if (missingTeacherCourses > 0) fieldParts.push(missingTeacherCourses + ' 门课没给上课教师');
        if (missingLocationCourses > 0) fieldParts.push(missingLocationCourses + ' 门课没给上课地点');
        var shownNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownNames.push(shortName(fieldSamples[fs]));
        var emptyText = missingTeacherCourses > 0 && missingLocationCourses > 0
            ? '教师或地点暂时空着'
            : (missingTeacherCourses > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shownNames.join('、') + '）：已照常导入，' + emptyText + '，可在「编辑课程」里补上');
    }
    if (serialGroups > 0) {
        warn('有 ' + serialGroups + ' 处周次里的括号只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        warn('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，已忽略，请核对这几门课的周次');
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    }
    if (orphanMarkers > 0) {
        warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次（教务数据写得不完整），这些标记已忽略');
    }
    if (bothMarks > 0) {
        warn('有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对');
    }

    // 兜底：真到了上限就说清楚（正常路径下这个计数永远是 0）
    if (droppedWarnings > 0) {
        warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';
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
                courses: payloadCourses
            }
        ]
    });
})()
