(function () {
    // 吉利学院教务适配器（YETHAN 教学信息服务平台，jw.guc.edu.cn/yethan）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 GUC/guc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Selffox）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-11 拉取）
    //   本校脚本最后一次修改 dc268ee（2026-10-07）
    //
    // 上游在同一段脚本里逐周取数、解析表格、切周次、拼课程；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑）。
    // extract.js 交过来的是每个格子按行拆开的文字、课表表头日期、节次时间列与各周结果。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 周次：上游的 parseWeeks 先删括号再切逗号，单 / 双标记与「(1-16周)」都会读错；
    //      这里照批次十已审计的 swu / 批次三十三的 bjtu 写法，按逗号分段各自归属单双、剥「共 N 周」备注、
    //      认「第1-第8周」与全角标点，并把混进周次的节次（第3-4节）整段摘掉
    //   ② 课程行：上游按「最后一行是周次、上面是课名」配对；这里逐段消费「课名行 + 周次地点行」，
    //      配不上时只记账不吞掉后面的课；课名里的课程编号前缀去掉，末尾括号纯数字视为课名版本号
    //   ③ 合并去重：同一门课在多周响应里重复出现，先去重再计数；同名、同教师、同地点、同星期、同周次的
    //      相邻节次合并成一段（首尾相接或重叠），与上游一致
    //   ④ 教师 / 地点缺了照常导入（null）并按类型汇总提醒；写成「未知」「待定」「暂无」「NoRoom」的当没给
    //   ⑤ 学期：教务页头的「2025-2026第2学期」直接拼成学期名；读不到按今天的日期推算并冠学校名
    //   ⑥ 开学日：表头「星期一03月02日」的月日就是第 1 周周一；年份先按学期的第二 / 第一年，
    //      拿不到学期时按距离今天最近、且星期对得上的年份推定，都提醒
    //   ⑦ 总周数：教务不给学期总周数，按 20 周；课表更晚才抬高，最多 30
    //   ⑧ 节次时间：逐节取课表「上课时间」列；不合法或读不到就用上游写死的 11 节表并提醒；
    //      课表用到表外节次时按批次五统一修订 H3 逐节补齐并提醒
    //   ⑨ 上游的学期选择弹窗、学分注入、确认框、保存桥全部不移植：学分在空课载荷里没有位置，
    //      空课由宿主保存，适配器只交载荷
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var weeksInput = data.weeks instanceof Array ? data.weeks : [];
    var timeRows = data.timeRows instanceof Array ? data.timeRows : [];
    var termLabel = text(data.termLabel);
    var mondayText = text(data.mondayText);

    var SEP = String.fromCharCode(0);   // 复合键分隔符：源码里不出现控制字符、也不出现转义序列
    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给学期总周数时的兜底
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名 / 原文最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟
    var SCHOOL_NAME = '吉利学院';

    // 上游 GUC/guc.js 的 TIME_SLOTS，逐节照抄原值（11 节）：课表页读不到节次时间时整表用它，
    // 课表用到表外节次时也用它补
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:20', end: '09:05' },
        { periodIndex: 2, start: '09:10', end: '09:55' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:00', end: '11:45' },
        { periodIndex: 5, start: '11:50', end: '12:35' },
        { periodIndex: 6, start: '14:20', end: '15:05' },
        { periodIndex: 7, start: '15:10', end: '15:55' },
        { periodIndex: 8, start: '16:10', end: '16:55' },
        { periodIndex: 9, start: '17:00', end: '17:45' },
        { periodIndex: 10, start: '19:00', end: '19:45' },
        { periodIndex: 11, start: '19:50', end: '20:35' }
    ];

    var KIND_CN = { 1: '一', 2: '二' };
    var NOTE_WORDS = /^(实验|实践|上机|实习|实训|理论|主讲|外聘|研究生|必修|选修|考试|考查|设计|其他|上|下|一|二|三|四|五|六|口语|听力|双语|全英|中文)$/;

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 课名、原文过长时截短，避免一个超长字符串就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
    }

    // 点名：最多 3 个，各自截短，用顿号连起来
    function sampleText(list) {
        var shown = [];
        for (var i = 0; i < list.length && i < 3; i++) shown.push(shortName(list[i]));
        return shown.join('、');
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

    function utcOf(iso) {
        return new Date(Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        ));
    }

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOf(iso) {
        if (!iso) return null;
        var date = utcOf(iso);
        var back = (date.getUTCDay() + 6) % 7;   // 周一 = 0 … 周日 = 6
        return isoOf(new Date(date.getTime() - back * 86400000));
    }

    function isoOfAny(value) {
        var m = /^([0-9]{4})[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // 「HH:mm」→ 分钟数。用 split 取时分，不许按位置 substring：一位小时（「9:10」）会算错
    function minutesOf(hhmm) {
        var parts = text(hhmm).split(':');
        if (parts.length < 2) return NaN;
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }

    // 分钟数写回 HH:mm（补时间用）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var mm = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
    }

    // ---------- warnings（载荷上限 20 条 × 200 字，超了整包会被拒，所以由这里统一收口） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        // 单条超长直接截断（超长会让整包被拒收，截断至少还能让用户看到前半句）
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 周次 ----------
    // 周次原文 → 周次集合（去重、升序）。上游只认「19周」「1-5,7-9周」，这里照批次十 swu 与批次三十三 bjtu 放宽：
    //   "1-16周" / "1-16周(单)" / "(单)1-8周,(双)9-16周" / "(单)1-8周(双)9-16周" / "1-3,5-9周" /
    //   "17周" / "第1-第8周" / "第1周至第8周" / 全角数字与标点
    // 必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单 / 双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉；
    //      含非周次字的（"(3学分)"）也摘掉，计数后写进 warnings；其它（"(1-16周)"、"(单)"）保留内容；
    //   ④ 空白两头都要顾：破折号连同两侧的空白先归一成半角 '-'，剩下的空白当分段符折成逗号；
    //   ⑤ 周次文字里混着节次（「第3-4节,1-16周」）时节次整段摘掉，后面还有真实周次，不许在这里截断。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单 / 双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3学分)」，含非周次的字，不是周次）
    var noteSample = '';     // 第一个备注括号的原文，写进提醒
    var bothMarks = 0;       // 同时写了「单」和「双」的段数（按每周都上处理，要说出来）

    function fullWidthToHalf(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[，、；;]/g, ',')
            .replace(/[～~—－–至到]/g, '-');
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 节次写进了周次文字：整段摘掉，不许在这里截断（后面还有真实周次）。
        // 放在归一之后，全角的「第３-４节」与「第3至4节」都已经变成「第3-4节」，一次就能吃整段
        cleaned = cleaned.replace(/第?\s*[0-9]+\s*(?:-\s*[0-9]+\s*)?节/g, ',');
        // 「共8周」是课程总周数备注，不是上课周次，只剥备注本身；放在全角转半角之后，全角数字也一起剥掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 紧挨周次的单 / 双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上；
        //   这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"，标记就跟着自己那一段走。
        //   前缀只认在段首：标记前面紧挨着数字或「周」（中间可有空白）时它是上一段的后缀
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 夹在两段中间的标记：本段以前置标记开头时它是下一段的前缀，补逗号隔开；
            // 否则仍是上一段的后缀
            if (/^\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var rest = whole.substring(offset + all.length);
            var head = whole.substring(0, offset).split(',').pop();
            // 没有逗号的连写（"(单)1-8周(双)9-16周"）：本段已经有另一种标记、后面还接着周次时，
            // 这个标记是下一段的前缀，不许并进本段（并进来就成了每周都上）
            if (/^\s*[0-9]/.test(rest) && (head.indexOf('单') >= 0 || head.indexOf('双') >= 0)) {
                return digit + ',' + mark;
            }
            var glue = /^\s*[0-9]/.test(rest) ? ',' : '';
            return digit + mark + glue;
        });
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周第-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = all;
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');   // 剩下落单的括号字符（没有闭合）也换成逗号，不许直接删
        cleaned = cleaned.replace(/周/g, '');
        // 区间终点前的「第」（"第1-第8周"）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
        // 单 / 双自己成一段时并给最近的周次段（就近向前找，找不到再向后）
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空，那才是真丢数据）；这是个判断不是事实，所以计数后写进 warnings
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:[ ]*-[ ]*[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
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

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周（手册 §4.1）。一行切出多段就写成多个 block，语义等价。
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

    // 教师 / 地点写成占位词的一律当没给（手册 §4.7：写「未知」会被课表当成真名显示）
    function placeholder(value) {
        var t = text(value);
        if (!t) return true;
        if (/^(none|noroom|no room|n\/a)$/i.test(t)) return true;
        return /^(未知|待定|暂无|无)(上课)?(教师|老师|教室|地点)?$/.test(t);
    }

    // 课名行，如「B3001 体育与健康（4）（张睿）」：末尾一组括号里是教师；纯数字括号是课名版本号，
    // 「（实验）」「（主讲）」这类是备注，都不能当教师。首词「字母 + 数字」是课程编号，去掉
    function parseCourseLine(line) {
        var t = text(line);
        if (!t) return null;
        var name = t;
        var teacher = '';
        // 末尾的一组括号（允许里面再套一层，如「张三（外聘）」）；全角 / 半角都认
        var m = /[（(]([^（）()]*(?:[（(][^（）()]*[)）][^（）()]*)*)[）)]$/.exec(t);
        if (m) {
            var candidate = text(m[1]);
            var restored = text(candidate.replace(/[（(][^（）()]*[)）]$/, ''));
            // 「（3学分）」「（32学时）」是课程信息，不是教师
            var isCredit = /[0-9]/.test(candidate) && /(学分|学时)/.test(candidate);
            var isNote = NOTE_WORDS.test(candidate) || (restored ? NOTE_WORDS.test(restored) : false) || isCredit;
            if (candidate && !/^[0-9]+$/.test(candidate) && !isNote && restored) {
                teacher = restored;
                name = text(t.substring(0, t.length - m[0].length));
            }
        }
        var tokens = name.split(/\s+/);
        if (tokens.length > 1 && /^[A-Za-z]*[0-9]+$/.test(tokens[0])) {
            tokens.shift();
        }
        name = text(tokens.join(' '));
        if (!name) return null;
        return { name: name, teacher: teacher };
    }

    // 一格里的「周次 + 地点」行，如「1-5,7-9,11-16周 L255教室」。
    // 用最后一个「周」切：多段周次（1-8周,9-16周）与「第1周至第8周」都不会被切掉后半段
    function splitWeeksPlace(segment) {
        var t = text(segment);
        var at = t.lastIndexOf('周');
        if (at < 0) return null;
        var end = at + 1;
        var tail = t.substring(end);
        // 紧跟在「周」后面的单 / 双标记算周次，不算地点
        var mark = /^\s*[（(]\s*[单双]\s*周?\s*[)）]/.exec(tail);
        if (mark) end += mark[0].length;
        return { weeksText: t.substring(0, end), place: text(t.substring(end)) };
    }

    // 地点开头紧跟「周」的括号备注 / 教学班序号（「(3学分)」「(1)」）摘掉，不能并进地点；
    // 只摘开头、且括号里是纯数字或学分 / 学时 / 周次这类备注词，真实地点里的括号（如「(东区)A101」）保留
    var PLACE_NOTE = /(学分|学时|周次?|节次?|学期)/;

    function placeOf(raw) {
        var t = text(raw).replace(/^[）)]+/, '').replace(/[（(]+$/, '');
        t = text(t);
        while (t) {
            var m = /^[（(]([^（）()]*)[)）]\s*/.exec(t);
            if (!m) break;
            var inner = text(m[1]);
            var isSerial = /^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner);
            var isNote = PLACE_NOTE.test(inner) && /[0-9]/.test(inner);
            if (!isSerial && !isNote) break;
            if (isSerial) {
                serialGroups++;
            } else {
                noteGroups++;
                if (!noteSample) noteSample = m[0];
            }
            t = text(t.substring(m[0].length));
        }
        return t;
    }

    // ---------- 逐格转换 ----------
    var entries = [];
    // 没取到的周次：HTTP 失败、返回登录页、没有表格，以及 extract.js 因取数预算到点而没发的周次
    var skippedWeeks = {};
    var skipWeekList = [];

    function noteSkippedWeek(value) {
        var n = intOf(value);
        if (!(n >= 1 && n <= MAX_WEEK)) return;
        if (skippedWeeks['w' + n]) return;
        skippedWeeks['w' + n] = true;
        skipWeekList.push(n);
    }
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var weekSamples = [];
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];

    function addSample(value) {
        var sample = text(value);
        if (!sample || weekSamples.length >= 3 || weekSamples.indexOf(sample) >= 0) return;
        weekSamples.push(sample);
    }

    var allRows = [];
    for (var wi = 0; wi < weeksInput.length; wi++) {
        var weekItem = weeksInput[wi] || {};
        var weekNo = intOf(weekItem.week);
        if (weekItem.ok !== true) {
            noteSkippedWeek(weekNo);
            continue;
        }
        var rowsOfWeek = weekItem.rows instanceof Array ? weekItem.rows : [];
        for (var ri = 0; ri < rowsOfWeek.length; ri++) allRows.push(rowsOfWeek[ri]);
    }

    var skippedInput = data.skippedWeeks instanceof Array ? data.skippedWeeks : [];
    for (var swi = 0; swi < skippedInput.length; swi++) noteSkippedWeek(skippedInput[swi]);

    // 同一格在多周响应里重复出现，去重要在计数之前，否则提醒里的条数会被放大
    var seenRows = {};
    for (var r = 0; r < allRows.length; r++) {
        var row = allRows[r] || {};
        var segments = [];
        var rawSegments = row.segments instanceof Array ? row.segments : [];
        for (var s = 0; s < rawSegments.length; s++) {
            var seg = text(rawSegments[s]);
            if (seg) segments.push(seg);
        }
        var rowKey = 'r' + JSON.stringify([intOf(row.day), intOf(row.period), segments]);
        if (seenRows[rowKey] === true) continue;
        seenRows[rowKey] = true;

        var day = intOf(row.day);
        var period = intOf(row.period);
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }
        if (!(period >= 1 && period <= MAX_PERIOD)) { missing.period++; continue; }
        if (!segments.length) { missing.name++; continue; }

        // 一格形如「课名行 + 周次地点行」，可叠多门；逐段消费，配不上时只记账，
        // 下一段仍可能是另一门课的课名行
        var j = 0;
        while (j < segments.length) {
            var info = parseCourseLine(segments[j]);
            if (!info) { missing.name++; j++; continue; }
            if (j + 1 >= segments.length) { missing.week++; addSample(segments[j]); break; }
            var split = splitWeeksPlace(segments[j + 1]);
            if (!split) {
                missing.week++;
                addSample(segments[j + 1]);
                if (j + 1 === segments.length - 1) break;
                j++;
                continue;
            }
            var weeks = weeksOf(split.weeksText);
            if (!weeks.length) {
                // 有数字才当「认不出的周次行」吃掉两段；没有数字（如课名「周易概论」）留给下一轮，
                // 否则会把后面那门课连同它的周次一起吞掉
                var badWeeks = /[0-9]/.test(split.weeksText);
                missing.week++;
                addSample(badWeeks ? split.weeksText : segments[j]);
                j += badWeeks ? 2 : 1;
                continue;
            }

            var teacher = text(info.teacher);
            var location = placeOf(split.place);
            if (placeholder(teacher)) teacher = '';
            if (placeholder(location)) location = '';
            if (!teacher) missingTeacherCourses['n' + info.name] = true;
            if (!location) missingLocationCourses['n' + info.name] = true;
            if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(info.name) < 0) {
                fieldSamples.push(info.name);
            }
            entries.push({
                name: info.name,
                teacher: teacher,
                location: location,
                day: day,
                start: period,
                end: period,
                weeks: weeks
            });
            j += 2;
        }
    }

    if (!entries.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开教务系统的课表页确认能看到课表后再试'
        );
    }

    // 完全相同的安排只留第一条（上游保存前同样按内容去重）：同一条重复出现，去掉不算丢课
    function dropExactDuplicates(list) {
        var ledger = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var key = 'k' + JSON.stringify([entry.name, entry.teacher, entry.location, entry.day, entry.start, entry.end, entry.weeks]);
            if (ledger[key]) continue;
            ledger[key] = true;
            out.push(entry);
        }
        return out;
    }

    function cmpText(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    function orderEntries(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end) ||
            cmpText(a.weeks.join(','), b.weeks.join(','));
    }

    // 连堂合并：同名、同教师、同地点、同星期、同周次的相邻节次合并成一段（首尾相接或重叠，下一节开始不晚于上一节结束加一）。
    // 分组键含周次，单周行与双周行不会被并成每周都上；分组的先后取第一次出现的顺序
    var groupOrder = [];
    var groupDict = {};
    entries = dropExactDuplicates(entries);
    for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        var groupKey = 'g' + entry.name + SEP + entry.teacher + SEP + entry.location + SEP + entry.day + SEP + entry.weeks.join(',');
        if (!groupDict[groupKey]) {
            groupDict[groupKey] = [];
            groupOrder.push(groupKey);
        }
        groupDict[groupKey].push(entry);
    }
    var merged = [];
    for (var gi = 0; gi < groupOrder.length; gi++) {
        var list = groupDict[groupOrder[gi]];
        list.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
        var current = null;
        for (var li = 0; li < list.length; li++) {
            var next = list[li];
            if (current && next.start <= current.end + 1) {
                if (next.end > current.end) current.end = next.end;
                continue;
            }
            current = {
                name: next.name,
                teacher: next.teacher,
                location: next.location,
                day: next.day,
                start: next.start,
                end: next.end,
                weeks: next.weeks
            };
            merged.push(current);
        }
    }
    merged.sort(orderEntries);

    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序
    var courses = [];
    var byName = {};
    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + (teacher || '');
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, blocks: [] };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    // 合并后的每条安排按周次拆成 block（步长 2 → 单 / 双周，见 runsOf）
    var maxWeek = 0;
    var maxPeriod = 0;
    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        var course = courseOf(item.name, item.teacher || null);
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            if (run.end > maxWeek) maxWeek = run.end;
            if (item.end > maxPeriod) maxPeriod = item.end;
            course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item.location || null
            });
        }
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var todayIso = isoOfAny(data.today) || localTodayIso();

    // 学期：页头的「2025-2026第2学期」直接拼；读不到按今天的日期判断
    // （8 月到次年 1 月是第一学期，2 到 7 月是第二学期），并在提醒里说明是推算的
    function effectiveTerm() {
        var matched = /([0-9]{4})\s*[-—－]\s*([0-9]{4})\s*(?:学年)?\s*第?\s*([一二12])\s*学期/.exec(termLabel);
        if (matched) {
            var y1 = parseInt(matched[1], 10);
            var y2 = parseInt(matched[2], 10);
            var kind = (matched[3] === '一' || matched[3] === '1') ? 1 : 2;
            if (y2 === y1 + 1) return { start: y1, kind: kind, fromPage: true };
        }
        var todayYear = parseInt(todayIso.substring(0, 4), 10);
        var month = parseInt(todayIso.substring(5, 7), 10);
        if (month >= 8) return { start: todayYear, kind: 1, fromPage: false };
        if (month <= 1) return { start: todayYear - 1, kind: 1, fromPage: false };
        return { start: todayYear - 1, kind: 2, fromPage: false };
    }

    function termName(eff) {
        return eff.start + '-' + (eff.start + 1) + '学年第' + KIND_CN[eff.kind] + '学期';
    }

    var eff = effectiveTerm();
    var name0 = (eff.fromPage ? '' : SCHOOL_NAME + ' ') + termName(eff);

    // 开学日：表头「星期一03月02日」的月日就是第 1 周周一。
    // 年份优先按学期（第一学期取学年首年、第二学期取次年）；没有学期时按距离今天最近、
    // 且那一天真实的星期与表头「星期几」对得上的年份推定（表头只有月日，没有年份）
    function pageStart() {
        var m = /([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日/.exec(mondayText);
        if (!m) return null;
        var month = parseInt(m[1], 10);
        var day = parseInt(m[2], 10);
        if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
        var guessedYear = !eff.fromPage;
        var year;
        if (eff.fromPage) {
            year = eff.kind === 1 ? eff.start : eff.start + 1;
        } else {
            var todayYear = parseInt(todayIso.substring(0, 4), 10);
            var nowutc = Date.UTC(
                todayYear,
                parseInt(todayIso.substring(5, 7), 10) - 1,
                parseInt(todayIso.substring(8, 10), 10)
            );
            var best = todayYear;
            var bestDiff = null;
            for (var i = -1; i <= 1; i++) {
                var y = todayYear + i;
                var diff = Math.abs(Date.UTC(y, month - 1, day) - nowutc);
                if (bestDiff === null || diff < bestDiff) { bestDiff = diff; best = y; }
            }
            year = best;
            var label = /星期([一二三四五六日天])/.exec(mondayText);
            if (label) {
                var want = label[1] === '天' ? 6 : '一二三四五六日'.indexOf(label[1]);
                if (want >= 0) {
                    for (var j = -1; j <= 1; j++) {
                        var cand = todayYear + j;
                        var weekday = new Date(Date.UTC(cand, month - 1, day)).getUTCDay();
                        if ((weekday + 6) % 7 === want) { year = cand; break; }
                    }
                }
            }
        }
        var iso = year + '-' + pad2(month) + '-' + pad2(day);
        var aligned = mondayOf(iso) || iso;
        return { iso: aligned, monthDay: m[0], guessedYear: guessedYear };
    }

    var pageFirst = pageStart();
    var firstDay = pageFirst ? pageFirst.iso : (mondayOf(todayIso) || todayIso);

    // 总周数：教务不给学期总周数，按公共口径取 20，课表更晚才抬高，最多 30
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    // ---------- 节次时间（逐节取课表「上课时间」列；不合法或读不到就用上游写死的 11 节；表外节次按 H3 补） ----------
    var periodTimes = [];
    var takenPeriods = {};
    for (var tr = 0; tr < timeRows.length; tr++) {
        var slotRow = timeRows[tr] || {};
        var slotIndex = intOf(slotRow.num);
        // 一位或两位小时都接住，但小时必须 0-23、分钟必须 0-59；「09:60」不是合法时间，整行不用
        var slotTime = /^([0-9]{1,2})\s*:\s*([0-9]{1,2})\s*-\s*([0-9]{1,2})\s*:\s*([0-9]{1,2})$/.exec(text(slotRow.time));
        if (!(slotIndex >= 1 && slotIndex <= MAX_PERIOD)) continue;
        if (!slotTime) continue;
        var slotStartH = parseInt(slotTime[1], 10);
        var slotStartM = parseInt(slotTime[2], 10);
        var slotEndH = parseInt(slotTime[3], 10);
        var slotEndM = parseInt(slotTime[4], 10);
        if (slotStartH > 23 || slotStartM > 59 || slotEndH > 23 || slotEndM > 59) continue;
        var slotStart = pad2(slotStartH) + ':' + pad2(slotStartM);
        var slotEnd = pad2(slotEndH) + ':' + pad2(slotEndM);
        if (minutesOf(slotEnd) <= minutesOf(slotStart)) continue;
        if (takenPeriods['p' + slotIndex]) continue;
        takenPeriods['p' + slotIndex] = true;
        periodTimes.push({ periodIndex: slotIndex, start: slotStart, end: slotEnd });
    }
    periodTimes.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
    // 上游 isValidTimeSlots 的口径：节次必须从 1 连续、开始早于结束、相邻不重叠，否则整表不用
    var hasSlotTable = periodTimes.length > 0;
    for (var st = 0; hasSlotTable && st < periodTimes.length; st++) {
        if (periodTimes[st].periodIndex !== st + 1) { hasSlotTable = false; break; }
        if (st > 0 && minutesOf(periodTimes[st].start) < minutesOf(periodTimes[st - 1].end)) {
            hasSlotTable = false;
            break;
        }
    }
    if (!hasSlotTable) {
        periodTimes = [];
        for (var bi = 0; bi < SCHOOL_PERIOD_TIMES.length; bi++) {
            periodTimes.push({
                periodIndex: SCHOOL_PERIOD_TIMES[bi].periodIndex,
                start: SCHOOL_PERIOD_TIMES[bi].start,
                end: SCHOOL_PERIOD_TIMES[bi].end
            });
        }
    }

    // 节次号（已升序）写成「第 9-12 节」「第 9 节」「第 9、11-12 节」这几种
    function sectionsText(list) {
        var spans = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) {
                j++;
            }
            spans.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + spans.join('、') + ' 节';
    }

    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    if (periodTimes.length && periodTimes[periodTimes.length - 1].periodIndex < maxPeriod) {
        var lastGiven = periodTimes[periodTimes.length - 1].periodIndex;
        for (var p = lastGiven + 1; p <= maxPeriod; p++) {
            var prev = periodTimes.length ? periodTimes[periodTimes.length - 1] : null;
            var prevEnd = prev ? minutesOf(prev.end) : -1;
            var builtinSlot = SCHOOL_PERIOD_TIMES[p - 1];
            // 学校公布的表有这一节、且它的开始不早于上一节下课，才用它的时间（否则会和上一节重叠甚至倒挂）
            if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
                periodTimes.push({ periodIndex: p, start: builtinSlot.start, end: builtinSlot.end });
                fromBuiltin.push(p);
                continue;
            }
            // 否则从上一节下课后顺推：课间 5 分钟、每节 45 分钟；顺推越过 23:59 就停，这一节起不再补
            if (!prev) { uncoveredFrom = p; break; }
            var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
            var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
            if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
            periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
            bySequence.push(p);
        }
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    if (eff.fromPage) {
        warn(
            '只导入了教务系统里当前的学期（' + name0 +
            '）；要导入别的学期，请先在教务系统里切换到那个学期，再点「提取课表」'
        );
    } else {
        warn(
            '没有从教务系统读到当前学期，已按今天的日期推算为 ' + name0 +
            '。如果这不是你要导入的学期，请先在教务系统里切换到正确的学期，再点「提取课表」'
        );
    }

    if (pageFirst) {
        warn(
            '开学日按课表第 1 周表头的「' + shortName(pageFirst.monthDay) + '」导入为 ' + firstDay +
            (pageFirst.guessedYear ? '（年份按日期与星期推定）' : '') + '，请在学期管理里核对'
        );
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周已按今天所在那一周的周一（' + firstDay +
            '）推算，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raisedBySchedule) {
        warn(
            '教务系统没有给出学期总周数；课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS +
            ' 周，已按 ' + totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') +
            '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (hasSlotTable) {
        warn(
            '已按教务系统的节次时间导入（第 ' + periodTimes[0].periodIndex + ' 节 ' + periodTimes[0].start + '-' +
            periodTimes[0].end + '），请与实际上课时间核对，不一致可在学期管理里改'
        );
    } else {
        warn(
            '没有从课表里读到节次时间，已按学校公布的节次时间导入（第 ' + periodTimes[0].periodIndex + ' 节 ' +
            periodTimes[0].start + '-' + periodTimes[0].end + '），请在学期管理里核对'
        );
    }

    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用学校公布的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
        warn(
            '课表用到了' + sectionsText(filledAll) + '，节次时间表里没有这些节次，已补上：' + fillTexts.join('，') +
            '，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    if (skipWeekList.length > 0) {
        skipWeekList.sort(function (a, b) { return a - b; });
        var weekShown = [];
        for (var fw = 0; fw < skipWeekList.length && fw < 5; fw++) weekShown.push(String(skipWeekList[fw]));
        var weekTail = skipWeekList.length > 5 ? ' 周等' : ' 周';
        warn(
            '有 ' + skipWeekList.length + ' 周课表没有取到（第 ' + weekShown.join('、') + weekTail +
            '）：课表可能不完整，请稍后重新点「提取课表」再试一次'
        );
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 处');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 处');
        if (missing.period) reasons.push('缺节次（或节次不合理）' + missing.period + ' 处');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 处');
        if (weekSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push(shortName(weekSamples[ws]));
            reasons.push('认不出的原文如「' + sampleTexts.join('」「') + '」');
        }
        warn(
            '有 ' + skipped + ' 处课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }

    // 缺教师 / 缺地点：课照常导入（对应项为空），但按类型汇总计数说出来，不静默
    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + sampleText(fieldSamples) + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上'
        );
    }

    if (serialGroups > 0) {
        warn(
            '有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，' +
            '已忽略，请核对这几门课的周次'
        );
    }
    if (noteGroups > 0) {
        warn(
            '有 ' + noteGroups + ' 处括号里的备注（如「' + shortName(noteSample) + '」）不是周次，' +
            '已忽略，请核对这几门课的周次'
        );
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    }
    if (orphanMarkers > 0) {
        warn('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次（教务数据写得不完整），这些标记已忽略');
    }
    if (bothMarks > 0) {
        warn(
            '有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对'
        );
    }

    // 兜底：真到了上限就说清楚（正常路径下这些计数永远是 0）
    if (droppedWarnings > 0) {
        warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';
    }

    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: null,
            blocks: courses[c].blocks
        });
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [
            {
                name: name0,
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
