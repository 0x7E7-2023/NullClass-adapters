(function () {
    // 吉林化工大学教务适配器（乘方教务新版，jwxt.jluct.edu.cn）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 JLUCT/jluct_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 f83288e（2026-11-24 重新克隆）；本校脚本最后一次修改 f4e81dd（2026-11-18），已用 git log 核对一致
    //
    // 上游在同一段脚本里选学期、发请求、拼课、存节次时间；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里。周次写法、两阶段合并、提醒限长照同平台已审计的 lit（批次三十七）。
    //
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① 节次时间：上游写死「全校统一作息，共 12 节」，教务不给节次时间，所以用它（逐节照抄上游 TIME_SLOTS）；
    //      课表排到第 13 节起时按「统一修订 H3」顺推补齐并提醒（上游会按节次号找不到时间，这里不留空）；
    //   ② 开学日：上游从校历接口的第 1 周日期取（取最早一天）。这里取第一个有日期的周，倒推到第 1 周并取它所在的周一；
    //      第 1 周没有日期时按周号倒推并提醒；校历取不到，按学期锚点推算并提醒（上游会直接导入不带开学日的课表）；
    //   ③ 总周数：有校历用校历的最大周次（上游同）；没有用 20 周，课表里更晚的周次抬高并提醒；
    //   ④ 周次：zc 沿用 lit 的写法（上游只认纯数字列表，这里多认「1-16周」「(单)」「(双)」「第1-第8周」等，认不出的计数进提醒）；
    //   ⑤ 教室：jxcdmc2「教室-周次」按教室归并、一间教室一段（上游同）。上游的「教室名为空 → 不用场地」改为留空并计入缺地点；
    //      zc 里有而 jxcdmc2 里没有的周次上游会静默丢掉，这里保留并用主教室补上，对不上的课按类型汇总提醒；
    //   ⑥ 占位词：上游的「未知教师」「不用场地」改成留空（null），照常导入并按类型汇总提醒；教室占位词（待定、暂无）同样留空；
    //   ⑦ 教师括号里的备注（「张三（外聘）」「王五(研究生)」）不是教师名，去掉后再用；
    //   ⑧ 同课合并照 lit 的两阶段合并（完全相同的行去重，首尾相接或重叠的节次合并，同节次取周次并集）；
    //   ⑨ 上游的导出流程（弹窗、savePresetTimeSlots、saveImportedCourses、saveCourseConfig、showToast、notifyTaskCompletion）全部不移植：
    //      适配器只交载荷，保存由宿主负责；
    //   ⑩ 提醒的总数超过 20 条时，保留前 19 条，第 20 条写「另有 N 条」，N 是实际没有显示的条数（上游没有这一步）。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '吉林化工大学';  // 学期名兜底时用（不拿适配器名当学期名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 校历取不到时按 20 周给，并在提醒里说明
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名、教务原文最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟
    var PLACEHOLDERS = ['未知', '未知教师', '未知教室', '待定', '暂无', '暂无教师', '暂无教室', '不用场地'];

    // 学校统一作息（上游 TIME_SLOTS 逐节照抄，共 12 节）。教务不给节次时间，所以一直用它；未经真机核对
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:00', end: '10:45' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '13:30', end: '14:15' },
        { periodIndex: 6, start: '14:25', end: '15:10' },
        { periodIndex: 7, start: '15:30', end: '16:15' },
        { periodIndex: 8, start: '16:25', end: '17:10' },
        { periodIndex: 9, start: '18:00', end: '18:45' },
        { periodIndex: 10, start: '18:45', end: '19:30' },
        { periodIndex: 11, start: '19:45', end: '20:30' },
        { periodIndex: 12, start: '20:30', end: '21:15' }
    ];

    // 推算开学日的锚点：第一学期多在 9 月初、第二学期多在 2 月下旬、短学期 7 月初（校历取不到时才用）
    var KIND_ANCHOR = {
        first: { month: 9, day: 1 },
        second: { month: 2, day: 20 },
        third: { month: 7, day: 1 }
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 课名等教务原文过长时截短，避免一个超长名字就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    // 教务里的占位词（未知教师、待定、暂无……）写成空，交出去就是 null
    function cleanField(value) {
        var line = text(value);
        for (var i = 0; i < PLACEHOLDERS.length; i++) {
            if (line === PLACEHOLDERS[i]) return '';
        }
        return line;
    }

    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
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

    // 日期加减天数（用 UTC 算，避免时区把日期挪一天）
    function addDaysIso(iso, days) {
        var date = new Date(Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        ));
        return isoOf(new Date(date.getTime() + days * 86400000));
    }

    // 该日期所在周的周一（周一 = 1 … 周日 = 7）
    function weekStartOf(iso) {
        if (!iso) return null;
        var date = new Date(Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        ));
        var dayNo = (date.getUTCDay() + 6) % 7 + 1;
        return addDaysIso(iso, -((dayNo - 1 + 7) % 7));
    }

    // 任意形态的日期 → ISO 日期（只认年月日，后面的时间 / 星期部分忽略）
    function isoOfAny(value) {
        var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
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

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    // 分钟数写回 HH:mm（顺推节次时间用）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var mm = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
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

    // ---------- warnings ----------
    // 先全部收下来，最后统一出口：超过 20 条时保留前 19 条，第 20 条写「另有 N 条」，N 是实际没显示的条数
    var allWarnings = [];

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        allWarnings.push(line);
    }

    function warningsOut() {
        if (allWarnings.length <= MAX_WARNINGS) return allWarnings.slice(0);
        var shown = allWarnings.slice(0, MAX_WARNINGS - 1);
        shown.push(
            '另有 ' + (allWarnings.length - (MAX_WARNINGS - 1)) + ' 条核对提示没有显示，请逐门核对课程的教师、地点、周次与节次'
        );
        return shown;
    }

    // ---------- 学期名与学期序号 ----------
    // 学期值是教务自己的（上游把下拉框的 value 原样拼进请求体）：学期名与序号先看下拉框的文字
    //（「2025-2026学年第一学期」），文字里读不出再看值是不是「学年起始年 4 位 + 学期号 2 位」，都读不出才按提取当天推
    var TERM_LABEL = text(term.label);
    var TERM_CODE_PARTS = /^([0-9]{4})([0-9]{2})$/.exec(text(term.code));
    var TERM_SUFFIX = { first: '第一学期', second: '第二学期', third: '短学期' };
    var termGuessed = false;   // 学期序号 / 学年是按日期推的

    function kindOfLabel(label) {
        if (label.indexOf('第二学期') >= 0 || label.indexOf('春') >= 0) return 'second';
        if (label.indexOf('第一学期') >= 0 || label.indexOf('秋') >= 0) return 'first';
        if (label.indexOf('短学期') >= 0 || label.indexOf('夏') >= 0 || label.indexOf('第三学期') >= 0) return 'third';
        return '';
    }

    function kindOfCode() {
        if (!TERM_CODE_PARTS) return '';
        if (TERM_CODE_PARTS[2] === '01') return 'first';
        if (TERM_CODE_PARTS[2] === '02') return 'second';
        if (TERM_CODE_PARTS[2] === '03') return 'third';
        return '';
    }

    function yearOfLabel(label) {
        var m = /(20[0-9]{2})/.exec(label);
        return m ? parseInt(m[1], 10) : 0;
    }

    // 提取当天的日期推出的学期（只在上面两处都读不出时用）
    function guessFromToday() {
        var iso = isoOfAny(data.today) || localTodayIso();
        var year = parseInt(iso.substring(0, 4), 10);
        var month = parseInt(iso.substring(5, 7), 10);
        if (month >= 8) return { kind: 'first', year: year };
        if (month <= 1) return { kind: 'first', year: year - 1 };
        return { kind: 'second', year: year - 1 };
    }

    var TERM_KIND = kindOfLabel(TERM_LABEL) || kindOfCode();
    var TERM_YEAR = yearOfLabel(TERM_LABEL) || (TERM_CODE_PARTS ? parseInt(TERM_CODE_PARTS[1], 10) : 0);
    if (!TERM_KIND || !TERM_YEAR) {
        var guessedTerm = guessFromToday();
        if (!TERM_KIND) TERM_KIND = guessedTerm.kind;
        if (!TERM_YEAR) TERM_YEAR = guessedTerm.year;
        termGuessed = true;
    }

    // 学期名用教务自己的学年学期（别拿适配器名当学期名）：下拉框文字带学年或年份就直接用，
    // 否则用学期序号与学年拼；都是推出来的就退回「学校名 + 学年学期」
    function termName() {
        if (TERM_LABEL.length <= 40 && (TERM_LABEL.indexOf('学年') >= 0 || /20[0-9]{2}/.test(TERM_LABEL))) return TERM_LABEL;
        if (termGuessed) return SCHOOL_NAME + ' 学年学期';
        return TERM_YEAR + '-' + (TERM_YEAR + 1) + '学年' + TERM_SUFFIX[TERM_KIND];
    }

    // 校历某周最早有日期的那一天 → 该周的周一。校历若周日排在最前，这一天就是周日，周一是它的下一天（否则会早一周）
    function mondayOfRow(iso) {
        var date = new Date(Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        ));
        if (date.getUTCDay() === 0) return addDaysIso(iso, 1);
        return weekStartOf(iso);
    }

    // 校历取不到时的开学日推算：依赖学期序号的锚点，推算结果一律写进 warnings
    function estimateStart(todayIso) {
        var anchor = KIND_ANCHOR[TERM_KIND];
        if (!TERM_YEAR || !anchor) return weekStartOf(todayIso) || todayIso;
        var anchorIso = isoOf(new Date(Date.UTC(TERM_YEAR + (TERM_KIND === 'first' ? 0 : 1), anchor.month - 1, anchor.day)));
        return weekStartOf(anchorIso);
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。教务里常见的写法：
    //   "1,2,3"（上游的周号列表）/ "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-3,5-9周" / "第1-第8周" / "1-8周(共8周)"
    // 必须显式处理的几个坑（同 lit）：
    //   ① 「周」只是量词，先删掉再切段，否则「1-16周(单)」里的「(单)」会被切到另一段；
    //   ② 单 / 双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的是教学班序号，整组摘掉；含非周次字的是备注，也摘掉并计数；
    //   ④ 空白两头都要顾：破折号连同两侧空白先归一成半角 '-'，剩下的空白当分段符折成逗号。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单/双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3组)」，含非周次的字，不是周次）
    var noteSample = '';     // 第一个备注括号的原文（截短后写进提醒）
    var bothMarks = 0;       // 同时写了「单」和「双」的段数（按每周都上处理，要说出来）

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
        // 「共8周」这类课程总周数备注不是上课周次，只剥备注本身，不能从「共」一路删到行尾
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 紧挨周次的单 / 双括号按相邻关系先归属。前置写法 "(单)1-8周(双)9-16周" 里第二个标记归下一段：
        // 判断它所在的那一段（按逗号切，不按空白切，否则「(单) 1-8周 (双)」会被误认）是不是以前置标记开头
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            if (/^(?:第)?\([单双]/.test(before.replace(/\s+$/, '').split(',').pop())) return ',' + mark;
            return all;
        });
        // 后置写法 "1-8周(单)9-16周"：标记跟在前一段的数字后面
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var glue = /^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '';
            return digit + mark + glue;
        });
        // 括号先于删「周」逐组处理（全角括号已在上一步归成半角）
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
        cleaned = cleaned.replace(/[()]/g, ',');   // 落单的括号字符也换成逗号，不许直接删
        cleaned = cleaned.replace(/周/g, '');
        // 区间终点前的「第」（「第1-第8周」）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        // 剩下的空白当分段符折成逗号
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空，那才是真丢数据）
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

    function unionWeeks(a, b) {
        var all = a.concat(b);
        var have = {};
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (have[all[i]]) continue;
            have[all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    // 教务的分周次地点写在 jxcdmc2 里：「教室-周次,教室-周次」，每个周次一项（上游优先读它）。
    // 教室名里可能带「-」，周次取最后一个「-」后面的数字（同上游）。教室名为空的项地点留空（上游写成「不用场地」，这里不写）。
    // 周次超出 1..MAX_WEEK 的项丢弃并计数；认不出的项计数，由调用方决定要不要提醒
    function venueWeeksOf(source) {
        var out = { venues: [], unreadable: 0 };
        var index = {};
        var pieces = text(source).split(/[,，]/);
        for (var i = 0; i < pieces.length; i++) {
            var piece = text(pieces[i]);
            if (!piece) continue;
            var m = /^(.*)-([0-9]+)$/.exec(piece);
            if (!m) { out.unreadable++; continue; }
            var week = parseInt(m[2], 10);
            if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
            var room = cleanField(m[1]);
            var key = 'v' + room;
            var at = index[key];
            if (at === undefined) {
                at = out.venues.length;
                index[key] = at;
                out.venues.push({ room: room, weeks: [] });
            }
            out.venues[at].weeks.push(week);
        }
        for (var v = 0; v < out.venues.length; v++) out.venues[v].weeks = unionWeeks(out.venues[v].weeks, []);
        return out;
    }

    // 教师名：去掉括号备注（「张三（外聘）」「王五(研究生)」「李四[外聘]」），剩下的才是名字；占位词留空
    function teacherOf(value) {
        return cleanField(text(value).replace(/（[^）]*）|\([^)]*\)|\[[^\]]*\]/g, ''));
    }

    // 主教室：jxcdmc；占位词与空都留空（上游写「不用场地」，这里不写）
    function primaryLocation(row) {
        return cleanField(row.jxcdmc);
    }

    // ---------- 节次 ----------
    // 教务行的起止节次是 ps / pe 两个数字字段（上游 parseInt）。结束节次读不出时当作只上开始那一节（guessed 标出来并提醒）；
    // 读得出却小于开始、或超出上限，返回 null
    function sectionsOf(row) {
        var start = intOf(text(row.ps));
        var end = intOf(text(row.pe));
        if (start === null || start < 1 || start > MAX_PERIOD) return null;
        if (end === null) return { start: start, end: start, guessed: true };
        if (end > MAX_PERIOD || end < start) return null;
        return { start: start, end: end, guessed: false };
    }

    // ---------- 同课合并 ----------
    var courses = [];
    var byName = {};
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var missingTeacherCourses = {};     // 没给上课教师的课（按课名去重，提醒里说「N 门课」才准）
    var missingLocationCourses = {};    // 没给上课地点的课（按课名去重）
    var teacherSamples = [];            // 没给教师的课名，最多 3 个
    var locationSamples = [];           // 没给地点的课名，最多 3 个
    var weekSamples = [];               // 没解析出周次的原始文本，最多留 3 个
    var guessedCourses = {};            // 没给结束节次、按只上一节处理的课（按课名去重）
    var guessedSamples = [];
    var venueMismatchCourses = {};      // 分周次的地点与周次对不上、或有看不懂的部分的课（按课名去重）
    var venueMismatchNames = [];
    var maxWeek = 0;
    var maxPeriod = 0;

    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序；上课安排先收成 entry，合并后再拆成 block
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

    // 完全相同的行（课名、教师、地点、星期、起止节次、周次都一样）只留第一条
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

    function sameSlotDay(a, b) {
        return a.name === b.name && a.teacher === b.teacher && a.location === b.location && a.day === b.day;
    }

    function weeksKey(entry) {
        return entry.weeks.join(',');
    }

    function orderStageOne(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || cmpText(weeksKey(a), weeksKey(b)) || (a.start - b.start);
    }

    function orderStageTwo(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end);
    }

    // 阶段 1（输入已排好序）：同一上课安排、周次相同、节次首尾相接或重叠的合成一条（上游 cur.end + 1 >= start，同此）
    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next)) {
                if (next.start <= current.end + 1) {
                    if (next.end > current.end) current.end = next.end;
                    continue;
                }
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    // 阶段 2（输入已排好序）：起止节次都一样的，周次取并集（单周行与双周行并成每周）
    function mergeStageTwo(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && current.start === next.start && current.end === next.end) {
                current.weeks = unionWeeks(current.weeks, next.weeks);
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    var entries = [];
    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};

        var name = text(row.kcmc);
        if (!name) { missing.name++; continue; }

        var day = intOf(text(row.xq));
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOf(row);
        if (!sections) { missing.period++; continue; }

        // 上课安排 = 一组（地点, 周次）：jxcdmc2 读得出来就按它拆（上游优先读它），读不出来回落到 jxcdmc + zc。
        // zc 里有而 jxcdmc2 里没有的周次，上游是静默丢掉的；这里留下，地点用主教室
        var zcText = text(row.zc);
        var zcWeeks = weeksOf(row.zc);
        var split = venueWeeksOf(row.jxcdmc2);
        var plans = [];
        var mismatch = false;
        var v;
        var w;
        if (split.venues.length) {
            var inVenues = {};
            var inZc = {};
            for (w = 0; w < zcWeeks.length; w++) inZc[zcWeeks[w]] = true;
            for (v = 0; v < split.venues.length; v++) {
                plans.push({ location: split.venues[v].room, weeks: split.venues[v].weeks });
                for (w = 0; w < split.venues[v].weeks.length; w++) {
                    inVenues[split.venues[v].weeks[w]] = true;
                    if (zcWeeks.length && !inZc[split.venues[v].weeks[w]]) mismatch = true;
                }
            }
            var extraWeeks = [];
            for (w = 0; w < zcWeeks.length; w++) {
                if (!inVenues[zcWeeks[w]]) extraWeeks.push(zcWeeks[w]);
            }
            if (extraWeeks.length) {
                plans.push({ location: primaryLocation(row), weeks: extraWeeks });
                mismatch = true;
            }
            if (split.unreadable > 0 || (zcText && !zcWeeks.length)) mismatch = true;
        } else if (zcWeeks.length) {
            plans.push({ location: primaryLocation(row), weeks: zcWeeks });
        }
        if (!plans.length) {
            missing.week++;
            if (zcText && weekSamples.length < 3 && weekSamples.indexOf(zcText) < 0) weekSamples.push(zcText);
            continue;
        }
        if (mismatch && !venueMismatchCourses['n' + name] && venueMismatchNames.length < 3) {
            venueMismatchNames.push(name);
        }
        if (mismatch) venueMismatchCourses['n' + name] = true;

        // 教师、地点没有就让它是空的（写「未知」会被课表当成真名显示）；缺了也照常导入，按类型计数后汇总，不静默
        var teacher = teacherOf(row.teaxms);
        var lackLocation = false;
        for (v = 0; v < plans.length; v++) {
            if (!plans[v].location) lackLocation = true;
        }
        if (!teacher) {
            missingTeacherCourses['n' + name] = true;
            if (teacherSamples.length < 3 && teacherSamples.indexOf(name) < 0) teacherSamples.push(name);
        }
        if (lackLocation) {
            missingLocationCourses['n' + name] = true;
            if (locationSamples.length < 3 && locationSamples.indexOf(name) < 0) locationSamples.push(name);
        }
        if (sections.guessed) {
            if (!guessedCourses['n' + name] && guessedSamples.length < 3) guessedSamples.push(name);
            guessedCourses['n' + name] = true;
        }
        for (v = 0; v < plans.length; v++) {
            entries.push({
                course: courseOf(name, teacher || null),
                name: name,
                teacher: teacher,
                location: plans[v].location,
                day: day,
                start: sections.start,
                end: sections.end,
                weeks: plans[v].weeks
            });
        }
    }

    // 去完全相同的行 → 排序 → 阶段 1 → 再排序 → 阶段 2
    entries = dropExactDuplicates(entries);
    entries.sort(orderStageOne);
    var merged = mergeStageOne(entries);
    merged.sort(orderStageTwo);
    merged = mergeStageTwo(merged);

    // 合并后的每条 entry 按周次拆成 block（步长 2 → 单 / 双周）
    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            if (run.end > maxWeek) maxWeek = run.end;
            if (item.end > maxPeriod) maxPeriod = item.end;
            item.course.blocks.push({
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

    if (!courses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、在教务系统里确认能看到课表后再试'
        );
    }

    // ---------- 校历：开学日与总周数 ----------
    // 校历的「周号 + 当周日期」：取第一个有日期的周（周号最小、同周取最早的日期），按周号倒推到第 1 周，再取它所在的周一
    var calendarMissing = !data.calendar;   // 校历接口没取到（extract 交 null）
    var calWeeks = data.calendar && data.calendar.weeks instanceof Array ? data.calendar.weeks : [];
    var calMax = 0;
    var calFirstWeek = 0;
    var calFirstDate = '';
    for (var cw = 0; cw < calWeeks.length; cw++) {
        var cwItem = calWeeks[cw] || {};
        var wNo = intOf(text(cwItem.w));
        if (wNo === null || wNo < 1 || wNo > 99) continue;
        if (wNo > calMax) calMax = wNo;
        var cdays = cwItem.d instanceof Array ? cwItem.d : [];
        for (var cd = 0; cd < cdays.length; cd++) {
            var cdIso = isoOfAny(cdays[cd]);
            if (!cdIso) continue;
            if (!calFirstDate || wNo < calFirstWeek || (wNo === calFirstWeek && cdIso < calFirstDate)) {
                calFirstWeek = wNo;
                calFirstDate = cdIso;
            }
        }
    }
    var startFromCalendar = !!calFirstDate;
    var startIso = startFromCalendar
        ? addDaysIso(mondayOfRow(calFirstDate), -7 * (calFirstWeek - 1))
        : estimateStart(isoOfAny(data.today) || localTodayIso());
    var rebased = startFromCalendar && calFirstWeek !== 1;

    // 总周数：有校历用校历的最大周次（上游同）；没有用 20；课表里更晚的周次要放得下，超过 30 的按 30 收
    var totalWeeks = calMax > 0 ? calMax : SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }
    if (totalWeeks < 1) totalWeeks = SCHOOL_TOTAL_WEEKS;

    // ---------- 节次时间 ----------
    // 学校统一作息逐节照抄；课表用到的节次超出时按「统一修订 H3」顺推补齐并提醒
    var periodTimes = SCHOOL_PERIOD_TIMES.slice(0);
    var slotByIndex = {};
    var pIndex;
    for (pIndex = 0; pIndex < periodTimes.length; pIndex++) {
        slotByIndex['n' + periodTimes[pIndex].periodIndex] = periodTimes[pIndex];
    }
    var extendedFrom = [];
    var uncoveredFrom = 0;
    for (pIndex = 1; pIndex <= maxPeriod; pIndex++) {
        if (slotByIndex['n' + pIndex]) continue;
        var prev = slotByIndex['n' + (pIndex - 1)] || null;
        if (!prev) { uncoveredFrom = pIndex; break; }
        var nextStart = minutesOf(prev.end) + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        // 顺推越过 23:59 就停，这一节起不再补
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = pIndex; break; }
        var extended = { periodIndex: pIndex, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) };
        periodTimes.push(extended);
        slotByIndex['n' + pIndex] = extended;
        extendedFrom.push(pIndex);
    }

    // ---------- warnings（顺序固定：学期、开学日、总周数、节次时间，然后是课程层面的核对） ----------
    var source = text(term.source);
    var shownTerm = shortName(termName());
    if (source === 'page') {
        warn('导入的是教务页面里选中的学期（' + shownTerm + '）；要导入别的学期，请先在教务页面里切换到那个学期，再点「提取课表」');
    } else if (source === 'default') {
        warn('导入的是教务系统标记的当前学期（' + shownTerm + '）；要导入别的学期，请先在教务页面里切换到那个学期，再点「提取课表」');
    } else {
        warn('教务系统没有标出当前学期，导入的是学期列表里的第一项（' + shownTerm + '）；要导入别的学期，请先在教务页面里切换到那个学期，再点「提取课表」');
    }
    if (termGuessed) {
        warn('教务系统给的学期名里读不出学年和学期，已按当前日期推算学期，开学日期与总周数可能不准，请在学期管理里核对');
    }
    if (calendarMissing) {
        warn('没取到教务系统的校历，开学日期与总周数按学期推算，请在学期管理里核对');
    }
    if (!startFromCalendar) {
        warn('教务系统没有给出开学日期，已按学期推算为 ' + startIso + '，请在学期管理里把它改成学校实际开学日');
    } else if (rebased) {
        warn('校历的第 1 周没有日期，已按第 ' + calFirstWeek + ' 周的日期倒推开学日期为 ' + startIso + '，请在学期管理里核对');
    }
    if (clamped) {
        warn('校历显示学期有 ' + calMax + ' 周，超过 ' + MAX_WEEK + ' 周，已按 ' + MAX_WEEK + ' 周导入，如与实际不符可在学期管理里改');
    } else if (calMax === 0) {
        if (raisedBySchedule) {
            warn('教务系统没有给出学期总周数；课表里最晚排到第 ' + maxWeek + ' 周，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
        } else {
            warn('教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
        }
    } else if (raisedBySchedule) {
        warn('课表里最晚排到第 ' + maxWeek + ' 周，超过校历给出的 ' + calMax + ' 周，已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改');
    }

    var lastSlot = SCHOOL_PERIOD_TIMES[SCHOOL_PERIOD_TIMES.length - 1];
    warn(
        '节次时间按学校统一作息导入（共 ' + SCHOOL_PERIOD_TIMES.length + ' 节，第 1 节 ' + SCHOOL_PERIOD_TIMES[0].start + '-' +
        SCHOOL_PERIOD_TIMES[0].end + '，第 ' + lastSlot.periodIndex + ' 节 ' + lastSlot.start + '-' + lastSlot.end +
        '），与学校实际不符时请在学期管理里核对'
    );
    if (extendedFrom.length) {
        warn(
            '课表用到了' + sectionsText(extendedFrom) + '，现有的节次时间没有覆盖，已补上：' + sectionsText(extendedFrom) +
            '按前一节下课后课间 ' + EXTEND_BREAK_MINUTES + ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    if (missing.name) {
        warn('有 ' + missing.name + ' 行没有课程名，已跳过：教务数据不完整时会出现，如发现少课请反馈');
    }
    if (missing.day) {
        warn('有 ' + missing.day + ' 行的星期不在周一到周日之内，已跳过：教务数据不完整时会出现，如发现少课请反馈');
    }
    if (missing.period) {
        warn('有 ' + missing.period + ' 行的节次不合法（缺节次或超出 ' + MAX_PERIOD + ' 节），已跳过：如发现少课请反馈');
    }
    if (missing.week) {
        var weekShown = [];
        for (var ws = 0; ws < weekSamples.length; ws++) weekShown.push(shortName(weekSamples[ws]));
        warn(
            '有 ' + missing.week + ' 行的周次认不出或全部超出 1-' + MAX_WEEK + ' 周，已跳过' +
            (weekShown.length ? '（认不出的周次写法如「' + weekShown.join('」「') + '」）' : '') + '：如发现少课请反馈'
        );
    }

    // 缺教师 / 缺地点：课照常导入（对应项为空），按类型分别汇总，不静默
    var missingTeacher = countKeys(missingTeacherCourses);
    if (missingTeacher > 0) {
        var teacherShown = [];
        for (var ts = 0; ts < teacherSamples.length; ts++) teacherShown.push(shortName(teacherSamples[ts]));
        warn(
            '有 ' + missingTeacher + ' 门课没给上课教师（例如 ' + teacherShown.join('、') +
            '）：已照常导入，教师暂时空着，可在「编辑课程」里补上'
        );
    }
    var missingLocation = countKeys(missingLocationCourses);
    if (missingLocation > 0) {
        var locationShown = [];
        for (var ls = 0; ls < locationSamples.length; ls++) locationShown.push(shortName(locationSamples[ls]));
        warn(
            '有 ' + missingLocation + ' 门课没给上课地点（例如 ' + locationShown.join('、') +
            '）：已照常导入，地点暂时空着，可在「编辑课程」里补上'
        );
    }
    var venueMismatchCount = countKeys(venueMismatchCourses);
    if (venueMismatchCount > 0) {
        var venueShown = [];
        for (var vm = 0; vm < venueMismatchNames.length; vm++) venueShown.push(shortName(venueMismatchNames[vm]));
        warn(
            '有 ' + venueMismatchCount + ' 门课分周次的上课地点与周次对不上，或有看不懂的部分（例如 ' + venueShown.join('、') +
            '）：周次都已保留，对不上的用主要地点或留空，请在「编辑课程」里核对'
        );
    }
    var guessedCount = countKeys(guessedCourses);
    if (guessedCount > 0) {
        var guessedNames = [];
        for (var gn = 0; gn < guessedSamples.length; gn++) guessedNames.push(shortName(guessedSamples[gn]));
        warn(
            '有 ' + guessedCount + ' 门课没给结束节次（例如 ' + guessedNames.join('、') +
            '），已按只上开始的那一节导入，请核对这几门课的节次'
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
            '有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，' +
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
        warn('有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双)」），已按每周都上处理，请核对');
    }

    // 合并用的 entry 与分组表都是内部数据，不进载荷；本校教务没有课程备注，note 恒为 null
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
        warnings: warningsOut(),
        terms: [
            {
                name: termName(),
                firstDay: startIso,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
