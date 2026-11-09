(function () {
    // 西南交通大学（扬华学堂，yhxt.swjtu.edu.cn）教务适配器 —— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 SWJTU/swjtu_yhxt.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Weedy233）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-09 与 origin/main 对齐）
    //   本校目录最后一次修改 481949f
    //
    // 上游在同一段脚本里取数、拼课程、存节次时间；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交过来的是每门课的原始时间段文字、两位教师名与校区，外加学期与提取当天日期。
    //
    // 移植改动（周次与合并的写法照批次十已审计的 swu / hnsf；逐条对得上 AUDIT.md §5）：
    //   ① 上游要求课名、教师、星期、节次、周次都在，教师写成「未指定」；这里教师缺失交 null，
    //      课照常导入并按类型汇总提醒，不静默丢课，也不把「未指定」「未知」当真名
    //   ② 每段上课文字按「星期 + 第 x-y 节」切开，前面那截交给统一的周次解析（weeksOf），
    //      因此「(单)1-8周,(双)9-16周」「第1-第8周」「共16周」这些写法都能接住；上游只认单一的单/双标记
    //   ③ 周次集合按手册 §4.1 切成极大段：连续 → 每周，隔周且同奇偶 → 单周 / 双周
    //   ④ 节次时间：照上游写死的 13 节表逐节照抄，不问用户；课表用到的节次超出 13 节时按统一修订 H3 顺推补齐
    //   ⑤ 开学日：接口与上游都不给，按学期推算（第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一）并提醒
    //   ⑥ 总周数：上游写死 19（SWJTU_SEMESTER_TOTAL_WEEKS）；课表排得更晚才抬高，并提醒
    //   ⑦ 学期名：用课表页面上读到的学期文字；读不到按今天的日期推算，并提醒
    //   ⑧ 同课合并：上游不合并。这里去掉完全相同的行，并把「课名、教师、教室、星期、起止节次都一样」的周次取并集
    //   ⑨ 上游的导出流程（弹窗、saveImportedCourses / savePresetTimeSlots、showToast / notifyTaskCompletion）不移植：
    //      这些是「拾光」的桥能力，空课由宿主负责保存，适配器只交载荷
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var items = data.courses instanceof Array ? data.courses : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据
    var SCHOOL_NAME = '西南交通大学';  // 学期名兜底时用（拿不到学年学期时「学校名 + 学期」，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 19;   // 上游 SWJTU_SEMESTER_TOTAL_WEEKS
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟

    // 上游 SWJTU_TIME_SLOTS 的 13 节，逐节照抄原值（顺序与时间都不要改）
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:50', end: '09:35' },
        { periodIndex: 3, start: '09:50', end: '10:35' },
        { periodIndex: 4, start: '10:40', end: '11:25' },
        { periodIndex: 5, start: '11:30', end: '12:15' },
        { periodIndex: 6, start: '14:00', end: '14:45' },
        { periodIndex: 7, start: '14:50', end: '15:35' },
        { periodIndex: 8, start: '15:40', end: '16:25' },
        { periodIndex: 9, start: '16:40', end: '17:25' },
        { periodIndex: 10, start: '17:30', end: '18:15' },
        { periodIndex: 11, start: '19:30', end: '20:15' },
        { periodIndex: 12, start: '20:20', end: '21:05' },
        { periodIndex: 13, start: '21:10', end: '21:55' }
    ];

    var DAY_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    var KIND_CN = { first: '一', second: '二', third: '三' };
    // 推算开学日的锚点：第一学期多在 9 月初、第二学期多在 2 月下旬、夏季学期 7 月初。
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到第 1 周的第一天（周一）。
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '夏季学期 = 7 月 1 日所在周的周一' }
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 课名过长时截短，避免一个超长课名就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    // 字典里有多少个键（用对象当字典，ES5 下不引入 Set 之类）
    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
    }

    // 点名课名：最多 3 个，课名各自截短，用顿号连起来
    function sampleText(list) {
        var shown = [];
        for (var i = 0; i < list.length && i < 3; i++) shown.push(shortName(list[i]));
        return shown.join('、');
    }

    function addSample(list, value) {
        var line = text(value);
        if (!line || list.length >= 3 || list.join('|').indexOf(line) >= 0) return;
        list.push(line);
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

    // 任意形态的日期 → ISO 日期（只认年月日）
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
        // 单条超长直接截断（载荷校验是「超了就整包拒收」，截断至少还能让用户看到前半句）
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 学期名、学期序号与开学日 ----------
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var termSource = text(term.source) === 'page' ? 'page' : 'none';
    var termKind = '';
    var termYear = 0;

    if (term.kind === 'first' || term.kind === 'second' || term.kind === 'third') termKind = term.kind;
    if (/^[0-9]{4}$/.test(String(term.year))) termYear = parseInt(term.year, 10);

    // 学期文字里带学年学期时（如「2026-2027学年第一学期」）也能认出序号与学年
    function termFromText(value) {
        var m = /(20[0-9]{2})\s*[-－—–~至]\s*(20[0-9]{2})\s*学年\s*度?\s*第?\s*([一二三123])\s*学期/.exec(text(value));
        if (!m) return null;
        var year = parseInt(m[1], 10);
        if (parseInt(m[2], 10) !== year + 1) return null;
        var marks = { '一': 'first', '1': 'first', '二': 'second', '2': 'second', '三': 'third', '3': 'third' };
        var kind = marks[m[3]];
        if (!kind) return null;
        return { year: year, kind: kind };
    }

    // 按今天的日期推算学期：8 月到次年 1 月是第一学期（1 月算上一学年），2 到 7 月是第二学期
    function termByDate(iso) {
        var year = parseInt(iso.substring(0, 4), 10);
        var month = parseInt(iso.substring(5, 7), 10);
        if (month >= 8) return { year: year, kind: 'first' };
        if (month <= 1) return { year: year - 1, kind: 'first' };
        return { year: year - 1, kind: 'second' };
    }

    if (!termKind || !termYear) {
        var fromText = termFromText(text(term.name));
        if (fromText) {
            if (!termKind) termKind = fromText.kind;
            if (!termYear) termYear = fromText.year;
        }
    }
    if (!termKind || !termYear) {
        var byDate = termByDate(todayIso);
        if (!termKind) termKind = byDate.kind;
        if (!termYear) termYear = byDate.year;
    }

    // 学期名用教务自己的学年学期（手册 §4.7：别拿适配器名当学期名）
    function termName() {
        var label = text(term.name);
        if (label.indexOf('学年') >= 0 && label.indexOf('学期') >= 0) {
            return label.length > 40 ? label.substring(0, 40) : label;
        }
        if (termYear && termKind) return termYear + '-' + (termYear + 1) + '学年第' + KIND_CN[termKind] + '学期';
        return SCHOOL_NAME + ' 学期';
    }

    // 开学日推算。学期序号认不出来时退回「今天所在周的周一」
    function estimateStart() {
        if (!termKind || !termYear) return { iso: mondayOf(todayIso) || todayIso, rule: '今天所在周的周一' };
        var anchor = KIND_ANCHOR[termKind];
        var anchorIso = isoOf(new Date(Date.UTC(termYear + (termKind === 'first' ? 0 : 1), anchor.month - 1, anchor.day)));
        return { iso: mondayOf(anchorIso), rule: anchor.rule };
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。照批次十 swu / hnsf 的写法，同时认：
    //   "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-3,5-9周" / "17周" / "1-3周 5-9周" / "第1-第8周" / "共16周,1-15周(单)"
    // 必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单 / 双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //      万一标记自己成了一段（"1-16周,双"），并给最近的周次段，不丢；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉；
    //      含非周次字的（"(3组)"）也摘掉，计数后写进 warnings；其它（"(1-16周)"、"(单)"）保留内容；每组都换成逗号；
    //   ④ 空白两头都要顾：破折号连同两侧的空白先归一成半角 '-'，剩下的空白当分段符折成逗号。
    var droppedWeeks = 0;
    var orphanMarkers = 0;
    var serialGroups = 0;
    var noteGroups = 0;
    var noteSample = '';
    var bothMarks = 0;

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
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 「共8周」是课程总周数备注，不是上课周次，只剥备注本身；放在全角转半角之后，全角数字也一起剥掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 紧挨周次的单 / 双括号按相邻关系先归属：前缀写法里两个标记都并到前一段会把 1-16 周都读成每周都上
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            if (/^\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var glue = /^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '';
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
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
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

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周（手册 §4.1）
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

    // ---------- 上课文字 ----------
    // 上游的正则只认「周次段 + 星期 + 第 x-y 节」，周次段是一条死板的子表达式，前缀单双标记会被漏掉。
    // 这里改成先认「星期 + 第 x-y 节」，把这一段前面、上一段后面的文字整体交给 weeksOf —— 写法放宽了，语义不变。
    // 全角数字、全角连字符先归一：本校的格子文字混着中英文标点，直接按半角写正则会把整行漏掉
    function normalizeClassTime(value) {
        var line = text(value);
        line = line.replace(/[０-９]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 65248);
        });
        return line.replace(/[－—–~～至到]/g, '-');
    }

    function groupsOf(classTime) {
        var source = normalizeClassTime(classTime);
        var out = [];
        if (!source) return out;
        // 起止节次两侧都可能带「第」：「第1-第2节」「第1至第2节」
        var pattern = /(?:星期|周)\s*([一二三四五六日天])\s*第?\s*([0-9]+)\s*(?:-\s*第?\s*([0-9]+))?\s*节/g;
        var lastEnd = 0;
        var match = pattern.exec(source);
        while (match !== null) {
            var head = source.substring(lastEnd, match.index);
            var start = parseInt(match[2], 10);
            out.push({
                weeksText: head,
                day: DAY_MAP[match[1]] || 0,
                start: start,
                end: match[3] ? parseInt(match[3], 10) : start
            });
            lastEnd = pattern.lastIndex;
            match = pattern.exec(source);
        }
        return out;
    }

    // ---------- 教师 / 地点 ----------
    // 「未知」「待定」「暂无」「暂无教师」「暂无教室」「未指定」「无」都不是真名，交出去必须是空
    var PLACEHOLDERS = {
        '未知': 1, '待定': 1, '暂无': 1, '暂无教师': 1, '暂无教室': 1,
        '未指定': 1, '未安排': 1, '无': 1, 'null': 1, 'undefined': 1
    };

    function meaningful(value) {
        var line = text(value);
        if (!line) return '';
        if (PLACEHOLDERS[line] || PLACEHOLDERS[line.toLowerCase()]) return '';
        return line;
    }

    // 与上游 buildTeacher 一致：staffName 与 staffNameOther 按逗号 / 顿号 / 分号拆开，去重后交给宿主
    function teacherOf(item) {
        var names = [];
        var seen = {};
        var fields = [item.staffName, item.staffNameOther];
        for (var i = 0; i < fields.length; i++) {
            var pieces = text(fields[i]).split(/[,，、;；]/);
            for (var j = 0; j < pieces.length; j++) {
                var name = meaningful(pieces[j]);
                if (!name || seen['n' + name]) continue;
                seen['n' + name] = true;
                names.push(name);
            }
        }
        return names.join(',');
    }

    // ---------- 逐条转换 ----------
    var courses = [];
    var byName = {};
    var missing = { name: 0, period: 0, week: 0, text: 0 };
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var weekSamples = [];
    var textSamples = [];
    var noTimeCourses = {};
    var noTimeNames = [];
    var lostCourses = {};
    var lostNames = [];
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

    var entries = [];

    // 完全相同的行（课名、教师、教室、星期、起止节次、周次都一样）只留第一条
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
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end);
    }

    function sameSlot(a, b) {
        return a.name === b.name && a.teacher === b.teacher && a.location === b.location && a.day === b.day &&
            a.start === b.start && a.end === b.end;
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

    // 输入已按 orderEntries 排好：同一个上课安排（课名、教师、教室、星期、起止节次）的行，周次取并集
    function mergeSameSlot(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlot(current, next)) {
                current.weeks = unionWeeks(current.weeks, next.weeks);
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    for (var r = 0; r < items.length; r++) {
        var item = items[r] || {};
        var name = text(item.courseName);
        if (!name) { missing.name++; continue; }

        var slots = item.slots instanceof Array ? item.slots : [];
        var teacher = teacherOf(item);
        var campus = meaningful(item.campusName);
        var valid = [];
        var hasText = false;

        for (var s = 0; s < slots.length; s++) {
            var classTime = text(slots[s] && slots[s].classTime);
            if (!classTime) continue;
            hasText = true;
            var location = meaningful(slots[s].classPlace) || campus;
            var groups = groupsOf(classTime);
            if (!groups.length) {
                missing.text++;
                addSample(textSamples, classTime);
                continue;
            }
            for (var g = 0; g < groups.length; g++) {
                var group = groups[g];
                if (isNaN(group.start) || isNaN(group.end) || group.start < 1 || group.end > MAX_PERIOD || group.start > group.end) {
                    missing.period++;
                    continue;
                }
                var weeks = weeksOf(group.weeksText);
                if (!weeks.length) {
                    missing.week++;
                    addSample(weekSamples, group.weeksText);
                    continue;
                }
                valid.push({
                    day: group.day,
                    start: group.start,
                    end: group.end,
                    weeks: weeks,
                    location: location
                });
            }
        }

        if (!valid.length) {
            if (hasText) {
                lostCourses['n' + name] = true;
                if (lostNames.length < 3) lostNames.push(name);
            } else {
                noTimeCourses['n' + name] = true;
                if (noTimeNames.length < 3) noTimeNames.push(name);
            }
            continue;
        }

        // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
        // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
        if (!teacher) {
            missingTeacherCourses['n' + name] = true;
            if (fieldSamples.length < 3 && fieldSamples.join('|').indexOf(name) < 0) fieldSamples.push(name);
        }
        var hasLocation = false;
        for (var v = 0; v < valid.length; v++) {
            if (valid[v].location) hasLocation = true;
        }
        if (!hasLocation) {
            missingLocationCourses['n' + name] = true;
            if (fieldSamples.length < 3 && fieldSamples.join('|').indexOf(name) < 0) fieldSamples.push(name);
        }

        for (v = 0; v < valid.length; v++) {
            entries.push({
                course: courseOf(name, teacher || null),
                name: name,
                teacher: teacher,
                location: valid[v].location,
                day: valid[v].day,
                start: valid[v].start,
                end: valid[v].end,
                weeks: valid[v].weeks
            });
        }
    }

    // 去完全相同的行 → 排序 → 同一个上课安排的周次取并集
    entries = dropExactDuplicates(entries);
    entries.sort(orderEntries);
    var merged = mergeSameSlot(entries);

    // 合并后的每条 entry 按周次拆成 block（步长 2 → 单 / 双周，见 runsOf）
    for (var m = 0; m < merged.length; m++) {
        var record = merged[m];
        var runs = runsOf(record.weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            if (run.end > maxWeek) maxWeek = run.end;
            if (record.end > maxPeriod) maxPeriod = record.end;
            record.course.blocks.push({
                dayOfWeek: record.day,
                startPeriod: record.start,
                endPeriod: record.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: record.location || null
            });
        }
    }

    if (!courses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开课表页面确认能看到课表后再试'
        );
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var start = estimateStart();

    // 上游写死 19 周；课表排得更晚时抬高到那一周（endWeek 超过 totalWeeks 会被载荷校验拒掉）
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }

    // ---------- 节次时间（照上游写死的表，不问用户；更晚的节次按 H3 顺推） ----------
    var periodTimes = SCHOOL_PERIOD_TIMES.slice(0);
    var tableLength = periodTimes.length;
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = tableLength + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        var nextStart = minutesOf(prev.end) + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
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

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    if (termSource === 'page') {
        warn(
            '只导入了教务系统里当前的学期（' + shortName(name0) +
            '）；要导入别的学期，请先在教务系统的课表页面里切到那个学期，再点「提取课表」'
        );
    } else {
        warn(
            '没有从教务系统读到当前学期，已按今天的日期推算为 ' + shortName(name0) +
            '。如果这不是你要导入的学期，请先在教务系统的课表页面里切到正确的学期，再点「提取课表」'
        );
    }

    warn(
        '教务系统没有给出开学日期，第 1 周按「' + start.rule +
        '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
    );

    if (raisedBySchedule) {
        warn(
            '教务系统没有给出学期总周数；课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS +
            ' 周，已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改'
        );
    }

    var firstSlot = SCHOOL_PERIOD_TIMES[0];
    warn(
        '教务系统没有提供节次时间，已按学校公布的时间导入（第 1 节 ' + firstSlot.start + '-' + firstSlot.end +
        '），如与学校公布的不一致，可在学期管理里改'
    );

    if (bySequence.length) {
        warn(
            '课表用到了' + sectionsText(bySequence) + '，所用的节次时间没有覆盖，已按上一节下课后课间 ' +
            EXTEND_BREAK_MINUTES + ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    // 数据不全的行：按原因分类计数，认不出的原文点几个出来，方便用户核对
    var skipped = missing.name + missing.period + missing.week + missing.text;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 门');
        if (missing.period) reasons.push('节次不合理 ' + missing.period + ' 处');
        if (missing.week) {
            var weekTexts = [];
            for (var ws = 0; ws < weekSamples.length; ws++) weekTexts.push(shortName(weekSamples[ws]));
            reasons.push('周次认不出来 ' + missing.week + ' 处' +
                (weekTexts.length ? '（如「' + weekTexts.join('」「') + '」）' : ''));
        }
        if (missing.text) {
            var rawTexts = [];
            for (var ts = 0; ts < textSamples.length; ts++) rawTexts.push(shortName(textSamples[ts]));
            reasons.push('上课时间写法认不出来 ' + missing.text + ' 处' +
                (rawTexts.length ? '（如「' + rawTexts.join('」「') + '」）' : ''));
        }
        warn(
            '有 ' + skipped + ' 处课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }

    // 整门课都没有可用的上课时间：这些课没有导入，按「教务没给时间」和「时间写法认不出来」分开说
    var noTime = countKeys(noTimeCourses);
    var lost = countKeys(lostCourses);
    if (noTime > 0 || lost > 0) {
        var timeParts = [];
        if (noTime > 0) timeParts.push('教务系统没给 ' + noTime + ' 门');
        if (lost > 0) timeParts.push('时间写法认不出来 ' + lost + ' 门');
        var timeSample = lostNames.concat(noTimeNames);
        warn(
            '有 ' + (noTime + lost) + ' 门课没有可用的上课时间（' + timeParts.join('、') +
            (timeSample.length ? '，例如 ' + sampleText(timeSample) : '') +
            '）：这些课没有导入，请在教务系统的课表页面核对'
        );
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），但按类型汇总计数说出来，不静默
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
        warn(
            '有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对'
        );
    }

    // 兜底：真到了上限就说清楚（正常路径下这些计数永远是 0）
    if (droppedWarnings > 0) {
        warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';
    }

    // 合并用的 entry 与分组表都是内部数据，不进载荷
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
                firstDay: start.iso,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
