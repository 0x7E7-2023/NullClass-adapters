(function () {
    // 广西科技师范学院（强智科技「教务管理系统」新版界面 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 GXSTNU/gxstnu_01.js（MIT，上游作者 CikeSeven）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 1dc9ac6（2026-11-16）；本校脚本最后一次修改 e2e5a21。
    // 上游的核心是 parseWeeks()（周次）、parseTimeText()（方括号里的节次）、parseHeaderDays()（星期表头）、
    // readCourseItem()（tooltip 里的课程详情）、cleanTeacher() / cleanPosition()（教师职称与地点写法）、
    // parseTimetableToModel()（按跨行跨列还原网格）、mergeAndDistinctCourses()（同课合并）、
    // parseSemesterInfo()（开学日与最大周次）和写死的 12 节节次时间。这里照同样的判据重写，并降到 ES5。
    // 模板是湖南大学件（hnu，同为强智新版界面 table.qz-weeklyTable），网格还原、同课合并、教学周历的兜底沿用 hnu；
    // 课程详情、教师 / 地点清理、节次时间（写死 12 节）、开学日（周历格子只有月日、年份按学期代码推）按本校上游重写。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 单个上课安排坏了不整表失败：课名读不出、没有时间、周次或节次写法认不出、单双周写不出有效周次 → 这一条跳过，
    //      按类型计数并点名；表头、网格这类结构问题仍整体报错；
    //   ② 周次写法比上游宽：上游只认「1-8,10-16周」，「单 / 双」标记（1-16单周、1-16周(单)、(单)1-8周,(双)9-16周）被它悄悄丢掉，
    //      整门课退化成每周都上。这里认全，标记跟着自己那一段走；「共 N 周」备注只剥备注本身；认不出的写法不猜、跳过并提醒；
    //   ③ 节次写成多段（[1-2,5-6节]）时，上游取最小到最大（会把 3-4 节也算进去），这里拆成多段；
    //   ④ 教师去掉职称与括号备注（「张三讲师（高校）」→「张三」），地点把建筑与房间拼起来（上游 cleanTeacher / cleanPosition）；
    //      「未知」「待定」「暂无」之类的占位词当没有，留空（null）并按类型汇总提醒；
    //   ⑤ 节次时间：上游写死 12 节，照抄；课表用到第 13 节及以后时，按「统一修订 H3」在上一节下课后顺推并提醒；
    //   ⑥ 开学日：上游取周历第 1 周里第一个带日期的格子、年份由学期代码推（第 1 学期取前一年、否则取后一年），
    //      再按列号倒推该行第一天。这里取第 1 周前 7 个日期格子、要求逐天连续，第一天是星期日或星期一直接采用；
    //      其它星期几对齐到周一并提醒；取不到按提取时刻所在的周一推算并提醒；
    //   ⑦ 周次超出 1-30（含第 0 周）的丢弃并计数提醒（上游静默丢）；
    //   ⑧ 一格里有内容却没认出课程详情（页面结构变了）时计数提醒，不静默；
    //   ⑨ 同课合并沿用 hnu 的按周拆开再合并（只合并同一周内相邻或重叠的节次，重复行也被吸收），切段输出照移植手册 §4.1；
    //   ⑩ 每次都在提醒里说明本次导入的是哪个学期（上游弹窗选学期，这里不弹窗）。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，CI 的 Rhino 里没有 DOM），形状见 AUDIT.md 第 4 节：
    //   { source, pageUrl, now, loginTitle, loginForm, term: { code, label, assumed },
    //     tables: [ { head: [ { text } ], body: [ [ { label, rowSpan, colSpan, hasText, cards: [ { title, details } ] } ] ] } ],
    //     calendar: { rows: [ { label, cells: [ { text, title } ] } ] } 或 null }
    var data = JSON.parse(__ncInput);

    // 学校节次时间（广西科技师范学院）：上游 TIME_SLOTS 写死的 12 节，逐节照抄
    var SCHOOL_PERIOD_TIMES = [
        { start: '08:20', end: '09:00' },
        { start: '09:05', end: '09:45' },
        { start: '09:55', end: '10:35' },
        { start: '10:45', end: '11:25' },
        { start: '11:30', end: '12:10' },
        { start: '14:30', end: '15:10' },
        { start: '15:15', end: '15:55' },
        { start: '16:10', end: '16:50' },
        { start: '16:55', end: '17:35' },
        { start: '19:30', end: '20:10' },
        { start: '20:15', end: '20:55' },
        { start: '21:00', end: '21:40' }
    ];
    var SCHOOL_SLOT_COUNT = SCHOOL_PERIOD_TIMES.length;
    // 顺推：课间 5 分钟、每节 45 分钟（与统一修订 H3 一致）
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    // 载荷规范的周次上限是 30
    var MAX_WEEK = 30;
    // 单日节次上限：超过它一定是脏数据（学校 12 节，更晚的节次顺推）
    var MAX_PERIOD = 20;
    // 没有周历时的兜底总周数（上游 semesterTotalWeeks = totalWeeks || 20）
    var FALLBACK_TOTAL_WEEKS = 20;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var MAX_MINUTE = 23 * 60 + 59;
    var SCHOOL_NAME = '广西科技师范学院';
    var LOGIN_TEXT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';
    var HEADER_DAY = /(?:星期|周)([一二三四五六日天])/;
    var DAY_CHARS = '一二三四五六日天';
    var TERM_CODE = /^\d{4}-\d{4}-\d$/;
    var DETAIL_FIELD = /^(老师|地点|时间)\s*[:：]\s*([\s\S]*)$/;
    // 教师职称（上游 TEACHER_TITLES，长的放前面：「张三讲师（高校）」只留「张三」）
    var TEACHER_TITLES = [
        '助理研究员', '高级工程师', '高级实验师', '助理实验师', '副研究员',
        '研究员', '实验师', '工程师', '副教授', '教授', '讲师', '助教', '其他', '其它'
    ];
    // 教师 / 地点写成这些占位词时当没有（公共说明：拿不到就留空，不能交「未知」）
    var PLACEHOLDER = /^(未知|待定|暂无|无|未知教师|未知老师|未知地点|未知教室|暂无教师|暂无老师|暂无地点|暂无教室)$/;
    // 一段上课时间：周次文字 + 方括号里的节次（「1-16周 [1-2节]」；上游也接受方括号里不写「节」的「[1-2]」）
    var TIME_PIECE = /([^\[\]]*)\[([^\[\]]*?)节?\]/g;
    // 周次里的一段：可选的前缀单 / 双、起止周、可选的后缀单 / 双（「周」字随处可有）
    var WEEK_SEGMENT = /^([单双]{1,2})?周?\s*([0-9]{1,3})(?:-([0-9]{1,3}))?\s*周?\s*([单双]{1,2})?周?/;

    // 计数：一个都不许静默丢，全部进 warnings
    var noNameBlocks = 0;
    var noTimeBlocks = 0;
    var noWeekBlocks = 0;
    var droppedWeeks = 0;
    var serialGroups = 0;
    var noteGroups = 0;
    var noteSample = '';
    var bothMarks = 0;
    var mergedCells = 0;
    var unreadCells = 0;
    var droppedNames = [];
    var droppedTotal = 0;

    // 载荷里的核对提示。**一律经 pushWarning() 出去**：每条 ≤200 字（超了按码位截断加省略号）。
    // 一共 ≤20 条是载荷校验的硬上限：超过时由 finalWarnings() 收尾（前 19 条照常，第 20 条写成汇总），绝不静默丢。
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

    function finalWarnings() {
        if (warnings.length <= MAX_WARNINGS) return warnings;
        var kept = warnings.slice(0, MAX_WARNINGS - 1);
        var hidden = warnings.length - kept.length;
        kept.push(clipText('另有 ' + hidden + ' 条提醒未列出', MAX_WARNING_TEXT));
        return kept;
    }

    // 提醒里点名的课名：截到 20 字
    function shortName(name) {
        return clipText(clean(name), NAME_TEXT_LIMIT);
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

    var WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

    // 「2026-2027-1」→「2026-2027学年第一学期」
    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(clean(code));
        if (!m) return '';
        if (m[3] === '1') return m[1] + '-' + m[2] + '学年第一学期';
        if (m[3] === '2') return m[1] + '-' + m[2] + '学年第二学期';
        if (m[3] === '3') return m[1] + '-' + m[2] + '学年第三学期';
        return m[1] + '-' + m[2] + '学年第' + m[3] + '学期';
    }

    // 「HH:mm」→ 分钟数
    function clockMinutes(text) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(clean(text));
        if (!m) return -1;
        var hour = parseInt(m[1], 10);
        var minute = parseInt(m[2], 10);
        if (hour > 23 || minute > 59) return -1;
        return hour * 60 + minute;
    }

    function clockText(minutes) {
        var value = minutes;
        if (value < 0) value = 0;
        if (value > MAX_MINUTE) value = MAX_MINUTE;
        return pad2(Math.floor(value / 60)) + ':' + pad2(value % 60);
    }

    function fullWidthToHalf(source) {
        return String(source)
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/：/g, ':')
            .replace(/[，、；;]/g, ',')
            .replace(/[～~—－–−至到]/g, '-');
    }

    // 升序数字拆成连续区间：[1,2,5] → [[1,2],[5,5]]
    function rangesOf(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var last = out[out.length - 1];
            if (last && list[i] === last[1] + 1) last[1] = list[i];
            else out.push([list[i], list[i]]);
        }
        return out;
    }

    // ---------- 教师与地点（上游 cleanTeacher / cleanPosition）----------
    // 教师按逗号拆开，去掉括号备注与职称（「张三讲师（高校）」→「张三」），去重后用逗号连起来。
    function cleanTeacher(source) {
        var parts = clean(source).split(/[,，、]+/);
        var out = [];
        var seen = {};
        for (var i = 0; i < parts.length; i++) {
            var original = clean(parts[i]);
            if (!original) continue;
            var name = original.replace(/[（(][^（）()]*[)）]/g, '').replace(/\s+/g, ' ').trim();
            for (var t = 0; t < TEACHER_TITLES.length; t++) {
                var title = TEACHER_TITLES[t];
                if (name.length - title.length >= 2 && name.substring(name.length - title.length) === title) {
                    name = clean(name.substring(0, name.length - title.length));
                    break;
                }
            }
            if (!name) name = original;
            if (!seen[name]) {
                seen[name] = true;
                out.push(name);
            }
        }
        return out.join(',');
    }

    // 地点（上游 cleanPosition）：「科教楼(西3-201-计算机基础实验室（12）)」→「科教楼西3-201-计算机基础实验室（12）」。
    // 括号里为空就只留建筑名；房间已经带建筑名就不再重复。半角 / 全角括号都认。
    function cleanPosition(source) {
        var text = clean(source);
        var m = /^([^()（）]*)[（(]([\s\S]*)[)）]$/.exec(text);
        if (!m) return text;
        var building = clean(m[1]);
        var room = clean(m[2]);
        if (!room) return building;
        if (!building) return room;
        if (room.length >= building.length && room.substring(0, building.length) === building) return room;
        return building + room;
    }

    // 占位词（「未知」「待定」「暂无」…）当没有
    function realValue(value) {
        var text = clean(value);
        return text && !PLACEHOLDER.test(text) ? text : null;
    }

    // 升序周次拆成极大段（移植手册 §4.1）：连续 → ALL；隔周且起点为奇数 → ODD；隔周且起点为偶数 → EVEN；落单 → ALL
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j] };
            if (run.start === run.end || step === 1) run.weekType = 'ALL';
            else run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // ---------- 周次 ----------
    // 周次文字 → 周次集合（升序、不重复）。认得的写法：
    //   "1-16" / "1-16周" / "1-8,10-16周" / "1-16单周" / "1-16周(单)" / "1-16(单周)" / "(单)1-8周,(双)9-16周" /
    //   "第1-第8周" / "1-8周(共8周),9-16周" / "17周"
    // 要点（批次七、八审计真抓到过的错）：
    //   ① 单 / 双标记跟着自己那一段走：标记紧挨在前一段的数字或「周」后面时是前一段的后缀（「1-8周(单) 9-16周(双)」），
    //      其余写在数字前面的是后一段的前缀。不能把「周」当分段边界，也不能把前缀并到上一段；
    //   ② 「共 N 周」备注只剥备注本身，不能从「共」一路删到行尾（会把后面真实的周次段一起吞掉）；
    //   ③ 「第」字不是分段符：「第1-第8周」是 1 到 8 周，不是 1 和 8 两周；
    //   ④ 括号：纯数字（「(1)」「(1,2)」）是教学班序号，整组摘掉并计数；带别的字（「(3组)」）是备注，摘掉并计数；
    //      其余保留内容。摘掉的括号换成逗号，不让两侧数字粘在一起；
    //   ⑤ 整段文字必须被完全认出来，剩下认不出的字就是整条跳过，不去猜。
    // 返回 { weeks, over, both, serial, notes, sample } 或 { error: 'time' | 'week' }
    function weeksOf(source) {
        var text = clean(source);
        if (!text) return { error: 'time' };
        var result = { weeks: [], over: 0, both: 0, serial: 0, notes: 0, sample: '' };
        text = fullWidthToHalf(text);
        text = text.replace(/共\s*[0-9]+\s*周?/g, ',');
        text = text.replace(/\s*-\s*/g, '-');
        text = text.replace(/第/g, '');
        // 周次文字里混进来的节次（「第3-4节,1-16周」）：数字加「节」整段摘除，别遇到「节」就当整条认不出
        text = text.replace(/[0-9]+(?:\s*-\s*[0-9]+)?\s*节/g, ',');
        text = text.replace(/\(([^()]*)\)/g, function (all, inner) {
            var body = inner.replace(/\s+/g, '');
            if (/^[单双]{1,2}周?$/.test(body)) return body.replace('周', '');
            if (!/[0-9单双]/.test(body)) return ',';
            if (/^[0-9,-]+$/.test(body)) {
                result.serial++;
                return ',';
            }
            if (/^[0-9,-]+周$/.test(body)) return ',' + body + ',';
            result.notes++;
            if (!result.sample) result.sample = all;
            return ',';
        });
        text = text.replace(/[()]/g, ',');
        var seen = {};
        var rest = text;
        var count = 0;
        while (true) {
            rest = rest.replace(/^[,\s]+/, '');
            if (!rest) break;
            var m = WEEK_SEGMENT.exec(rest);
            if (!m) return { error: 'time' };
            rest = rest.substring(m[0].length);
            count++;
            var trailing = m[4] || '';
            // 本段以标记开头时，紧挨着的后一个标记属于下一段（「(单)1-8周(双)9-16周」），不能被本段吞掉；
            // 「1-8周(单)9-16周(双)」这种后置写法仍归本段。标记与下一段的数字之间可能夹着空格或逗号
            // （「(双) 9-16周」「(双)，9-16周」），一并吞掉，否则标记会被当成本段的后缀。
            var gap = m[1] && trailing ? /^[\s,，]*周?/.exec(rest) : null;
            if (gap && /^[0-9]/.test(rest.substring(gap[0].length))) {
                rest = trailing + rest.substring(gap[0].length);
                trailing = '';
            }
            var marks = (m[1] || '') + trailing;
            var hasOdd = marks.indexOf('单') >= 0;
            var hasEven = marks.indexOf('双') >= 0;
            // 单双都写了 = 每周都上（互相排除会让整段变空，那才是真丢数据），计数提醒
            if (hasOdd && hasEven) {
                result.both++;
                hasOdd = false;
                hasEven = false;
            }
            var a = parseInt(m[2], 10);
            var b = m[3] ? parseInt(m[3], 10) : a;
            if (b < a) {
                var swap = a;
                a = b;
                b = swap;
            }
            for (var w = a; w <= b; w++) {
                if (hasOdd && w % 2 === 0) continue;
                if (hasEven && w % 2 === 1) continue;
                if (w < 1 || w > MAX_WEEK) {
                    result.over++;
                    continue;
                }
                if (!seen[w]) {
                    seen[w] = true;
                    result.weeks.push(w);
                }
            }
        }
        if (!count) return { error: 'time' };
        if (!result.weeks.length) return { error: 'week' };
        result.weeks.sort(function (x, y) { return x - y; });
        return result;
    }

    // 节次文字 → 区间列表 [[起, 止], ...]。认得 "1-2" / "01-02" / "1,2" / "1-2,5-6" / "第3-4"；认不出或越界返回 null
    function sectionsOf(source) {
        var text = fullWidthToHalf(clean(source)).replace(/第/g, '').replace(/节/g, '').replace(/\s+/g, '');
        if (!/^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$/.test(text)) return null;
        var seen = {};
        var list = [];
        var parts = text.split(',');
        for (var i = 0; i < parts.length; i++) {
            var bounds = parts[i].split('-');
            var a = parseInt(bounds[0], 10);
            var b = bounds.length > 1 ? parseInt(bounds[1], 10) : a;
            if (a < 1 || b < a || b > MAX_PERIOD) return null;
            for (var n = a; n <= b; n++) {
                if (!seen[n]) {
                    seen[n] = true;
                    list.push(n);
                }
            }
        }
        list.sort(function (x, y) { return x - y; });
        return rangesOf(list);
    }

    // 时间文字（「1-16周 [1-2节]」，可连着写几段）→ { pieces: [ { weeks, ranges } ], over, both, serial, notes, sample } 或 { error }
    function timeOf(source) {
        var text = clean(source);
        var pieces = [];
        var total = { over: 0, both: 0, serial: 0, notes: 0, sample: '' };
        var end = 0;
        var m;
        TIME_PIECE.lastIndex = 0;
        while ((m = TIME_PIECE.exec(text)) !== null) {
            // 两段之间不许夹着认不出的字（正则会跳过它们，不核对就是静默丢）
            if (m.index !== end) return { error: 'time' };
            end = TIME_PIECE.lastIndex;
            var w = weeksOf(m[1]);
            if (w.error) return { error: w.error };
            var ranges = sectionsOf(m[2]);
            if (!ranges) return { error: 'time' };
            pieces.push({ weeks: w.weeks, ranges: ranges });
            total.over += w.over;
            total.both += w.both;
            total.serial += w.serial;
            total.notes += w.notes;
            if (!total.sample && w.sample) total.sample = w.sample;
        }
        if (!pieces.length || clean(text.substring(end))) return { error: 'time' };
        total.pieces = pieces;
        return total;
    }

    // 「课程名 老师」的点名（最多 2 个）：提醒里要说清是哪一门被跳过了。
    // 只列 2 个是为了让整条提醒不靠最后的硬截断也 ≤200 字（课名、教师各截 20/10 字，后面还有几种原因的文字）。
    function noteDropped(name, teacher, reason) {
        droppedTotal++;
        if (droppedNames.length >= 2) return;
        var text = shortName(name || '(没认出课名)');
        if (teacher) text = text + '（' + clipText(clean(teacher), 10) + '）';
        droppedNames.push(text + '——' + reason);
    }

    function droppedText() {
        if (!droppedNames.length) return '';
        return '包含：' + droppedNames.join('；') + (droppedTotal > droppedNames.length ? ' 等' : '');
    }

    // 单个星期字 → 1..7（「日」「天」都是星期日）
    function dayOfChar(ch) {
        var at = DAY_CHARS.indexOf(ch);
        if (at < 0 || ch.length !== 1) return 0;
        return ch === '天' ? 7 : at + 1;
    }

    function dayOfHeader(text) {
        var m = HEADER_DAY.exec(clean(text));
        return m ? dayOfChar(m[1]) : 0;
    }

    // ---------- 登录页、学期 ----------
    if (data.loginForm === true || data.loginTitle === true) {
        throw new Error('当前页面不是课表，' + LOGIN_TEXT);
    }
    var termData = data.term || {};
    var termCode = clean(termData.code);
    if (!TERM_CODE.test(termCode)) {
        throw new Error('找不到学年学期，' + LOGIN_TEXT);
    }
    // 周历格子只有月日，年份按学期代码推（上游 parseSemesterInfo：第 1 学期取前一个年份，其余取后一个年份）
    var termYear = 0;
    var termParts = termCode.split('-');
    if (termParts.length === 3) {
        termYear = parseInt(termParts[2], 10) === 1 ? parseInt(termParts[0], 10) : parseInt(termParts[1], 10);
    }

    // ---------- 课表表格：表头能明确认出星期一至星期日各一次的那一张 ----------
    var tables = data.tables || [];
    if (!tables.length) {
        throw new Error('没有找到课表，' + LOGIN_TEXT);
    }

    // 表头里认得出星期的格子，按出现顺序就是正文第 1..7 列对应的星期（第 0 列是节次标签）。恰好 7 个且互不相同才算
    function headDaysOf(table) {
        var found = [];
        var seenDay = {};
        var heads = table.head || [];
        for (var h = 0; h < heads.length; h++) {
            var day = dayOfHeader(heads[h].text);
            if (!day) continue;
            if (seenDay[day]) return null;
            seenDay[day] = true;
            found.push(day);
        }
        return found.length === 7 ? found : null;
    }

    var usable = [];
    for (var ti = 0; ti < tables.length; ti++) {
        var headDays = headDaysOf(tables[ti]);
        if (headDays) usable.push({ table: tables[ti], days: headDays });
    }
    if (!usable.length) {
        throw new Error('课表表头和预期不一样：必须能明确认出星期一至星期日');
    }
    var table = usable[0].table;
    var days = usable[0].days;
    var extraTables = usable.length - 1;

    var rows = table.body || [];
    if (!rows.length) {
        throw new Error('课表里没有节次行，无法识别');
    }

    // 网格（上游 parseTimetableToModel）：按 rowSpan / colSpan 占位还原 8 列（第 0 列节次标签 + 7 天）；
    // 越界、重叠、某行不满 8 列都报错，不猜星期
    var grid = [];
    for (var gr = 0; gr < rows.length; gr++) {
        var line = [];
        for (var gc = 0; gc < 8; gc++) line.push(null);
        grid.push(line);
    }
    var cells = [];
    for (var r = 0; r < rows.length; r++) {
        var column = 0;
        var rowCells = rows[r] || [];
        for (var k = 0; k < rowCells.length; k++) {
            var cell = rowCells[k];
            while (column < 8 && grid[r][column]) column++;
            var height = cell.rowSpan;
            var width = cell.colSpan;
            if (height < 1 || width < 1 || r + height > rows.length || column + width > 8) {
                throw new Error('课表格子的跨行或跨列对不上，无法还原课表，请把课表截图反馈给空课');
            }
            for (var rr = r; rr < r + height; rr++) {
                for (var cc = column; cc < column + width; cc++) {
                    if (grid[rr][cc]) throw new Error('课表格子互相重叠，无法还原课表，请把课表截图反馈给空课');
                    grid[rr][cc] = cell;
                }
            }
            if (column === 0) {
                if (!cell.label || width !== 1) {
                    throw new Error('节次标签的结构变了，无法识别，请把课表截图反馈给空课');
                }
            } else {
                if (cell.label) {
                    throw new Error('课表里出现了不在第一列的节次标签，无法识别，请把课表截图反馈给空课');
                }
                var cellDays = [];
                for (var dc = column; dc < column + width; dc++) cellDays.push(days[dc - 1]);
                var cards = cell.cards || [];
                if (cards.length && width > 1) mergedCells++;
                if (!cards.length && cell.hasText === true) unreadCells++;
                if (cards.length) cells.push({ days: cellDays, cards: cards });
            }
            column += width;
        }
        var filled = 0;
        for (var fc = 0; fc < 8; fc++) {
            if (grid[r][fc]) filled++;
        }
        if (filled !== 8) {
            throw new Error('有一行课表不完整，无法判断每节课在星期几，请把课表截图反馈给空课');
        }
    }

    // ---------- 课程详情（上游 parseCellAtomic）----------
    // 每条：课名 + 「老师：…」「地点：…」「时间：…」。读不出课名、没有时间、周次或节次写法认不出 → 跳过、计数、点名。
    var records = [];
    var recordSeen = {};
    var noTeacherNames = {};
    var noPlaceNames = {};
    var noTeacherCount = 0;
    var noPlaceCount = 0;
    var sampleNames = [];
    var maxPeriod = 0;
    for (var ci = 0; ci < cells.length; ci++) {
        var items = cells[ci].cards;
        for (var cj = 0; cj < items.length; cj++) {
            var name = clean(items[cj].title);
            var teacher = null;
            var position = null;
            var timeText = null;
            var details = items[cj].details || [];
            var gotTeacher = false;
            var gotPlace = false;
            for (var dj = 0; dj < details.length; dj++) {
                var field = DETAIL_FIELD.exec(clean(details[dj]));
                if (!field) continue;
                var value = clean(field[2]);
                if (field[1] === '老师' && !gotTeacher) {
                    gotTeacher = true;
                    teacher = realValue(cleanTeacher(value));
                } else if (field[1] === '地点' && !gotPlace) {
                    gotPlace = true;
                    // 上游：地点是「()」（只有括号）时当作没有
                    position = realValue(cleanPosition(value));
                } else if (field[1] === '时间' && timeText === null) {
                    timeText = value;
                }
            }
            if (!name) {
                noNameBlocks++;
                noteDropped('', teacher, '没有课名');
                continue;
            }
            if (timeText === null) {
                noTimeBlocks++;
                noteDropped(name, teacher, '没有上课时间');
                continue;
            }
            var parsed = timeOf(timeText);
            if (parsed.error === 'time') {
                noTimeBlocks++;
                noteDropped(name, teacher, '周次或节次的写法没认出来');
                continue;
            }
            if (parsed.error === 'week') {
                noWeekBlocks++;
                noteDropped(name, teacher, '没有有效周次');
                continue;
            }
            droppedWeeks += parsed.over;
            bothMarks += parsed.both;
            serialGroups += parsed.serial;
            noteGroups += parsed.notes;
            if (!noteSample && parsed.sample) noteSample = parsed.sample;
            // 按「课名 + 教师」去重再计数（同一门课占两格不能报成两门）
            var courseKey = JSON.stringify([name, teacher]);
            if (!teacher) {
                if (!noTeacherNames[courseKey]) {
                    noTeacherNames[courseKey] = true;
                    noTeacherCount++;
                    if (sampleNames.indexOf(name) < 0) sampleNames.push(name);
                }
            }
            if (!position) {
                if (!noPlaceNames[courseKey]) {
                    noPlaceNames[courseKey] = true;
                    noPlaceCount++;
                    if (sampleNames.indexOf(name) < 0) sampleNames.push(name);
                }
            }
            for (var pi = 0; pi < parsed.pieces.length; pi++) {
                var piece = parsed.pieces[pi];
                for (var rg = 0; rg < piece.ranges.length; rg++) {
                    var start2 = piece.ranges[rg][0];
                    var end2 = piece.ranges[rg][1];
                    if (end2 > maxPeriod) maxPeriod = end2;
                    for (var di = 0; di < cells[ci].days.length; di++) {
                        var record = {
                            name: name,
                            teacher: teacher,
                            position: position,
                            day: cells[ci].days[di],
                            startSection: start2,
                            endSection: end2,
                            weeks: piece.weeks.slice()
                        };
                        var key = JSON.stringify([name, teacher, position, record.day, start2, end2, piece.weeks]);
                        if (recordSeen[key]) continue;
                        recordSeen[key] = true;
                        records.push(record);
                    }
                }
            }
        }
    }

    // ---- 同课合并（上游 mergeAndDistinctCourses）：同名、同老师、同地点、同星期，先按周拆开，每周内合并相邻或重叠的节次，
    //      再把节次相同的周收拢，最后每组周次切成极大段。
    function textCompare(x, y) {
        var a = x || '';
        var b = y || '';
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    }

    function compareEntries(a, b) {
        return (a.day - b.day) || (a.startSection - b.startSection) || (a.endSection - b.endSection) ||
            textCompare(a.name, b.name) || textCompare(a.teacher, b.teacher) ||
            textCompare(a.position, b.position) || (a.startWeek - b.startWeek);
    }

    function mergeRecords(list) {
        var groups = {};
        var order = [];
        var i;
        for (i = 0; i < list.length; i++) {
            var rec = list[i];
            var gkey = JSON.stringify([rec.name, rec.teacher, rec.position, rec.day]);
            if (!groups[gkey]) {
                groups[gkey] = { rec: rec, weeks: {} };
                order.push(gkey);
            }
            var group = groups[gkey];
            for (var w = 0; w < rec.weeks.length; w++) {
                var wk = String(rec.weeks[w]);
                if (!group.weeks[wk]) group.weeks[wk] = [];
                group.weeks[wk].push([rec.startSection, rec.endSection]);
            }
        }
        var entries = [];
        for (var o = 0; o < order.length; o++) {
            var g = groups[order[o]];
            var weekKeys = Object.keys(g.weeks).sort(function (x, y) { return Number(x) - Number(y); });
            var sigs = {};
            var sigOrder = [];
            for (var wi = 0; wi < weekKeys.length; wi++) {
                var intervals = g.weeks[weekKeys[wi]].slice().sort(function (x, y) {
                    return x[0] - y[0] || x[1] - y[1];
                });
                var merged = [];
                for (var ii2 = 0; ii2 < intervals.length; ii2++) {
                    var last = merged[merged.length - 1];
                    if (last && intervals[ii2][0] <= last[1] + 1) {
                        last[1] = Math.max(last[1], intervals[ii2][1]);
                    } else {
                        merged.push([intervals[ii2][0], intervals[ii2][1]]);
                    }
                }
                for (var mi = 0; mi < merged.length; mi++) {
                    var sig = merged[mi][0] + ':' + merged[mi][1];
                    if (!sigs[sig]) {
                        sigs[sig] = { start: merged[mi][0], end: merged[mi][1], weeks: [] };
                        sigOrder.push(sig);
                    }
                    sigs[sig].weeks.push(Number(weekKeys[wi]));
                }
            }
            for (var si2 = 0; si2 < sigOrder.length; si2++) {
                var part = sigs[sigOrder[si2]];
                var runs = runsOf(part.weeks);
                for (var rn = 0; rn < runs.length; rn++) {
                    entries.push({
                        name: g.rec.name,
                        teacher: g.rec.teacher,
                        position: g.rec.position,
                        day: g.rec.day,
                        startSection: part.start,
                        endSection: part.end,
                        startWeek: runs[rn].start,
                        endWeek: runs[rn].end,
                        weekType: runs[rn].weekType
                    });
                }
            }
        }
        entries.sort(compareEntries);
        return entries;
    }

    var skipped = noNameBlocks + noTimeBlocks + noWeekBlocks;
    if (!records.length) {
        if (skipped > 0) {
            throw new Error(clipText('本学期没有解析到任何课程：课表里的 ' + skipped +
                ' 个上课安排都没能认出来（没有课名或上课时间，或周次、节次的写法不认识）。' +
                droppedText() + ' 请把教务页面的课表截图反馈给空课', MAX_WARNING_TEXT));
        }
        if (unreadCells > 0) {
            throw new Error('本学期没有解析到任何课程：课表里有 ' + unreadCells +
                ' 个格子有内容，但认不出课程信息，可能是教务页面改了结构，请把课表截图反馈给空课');
        }
        throw new Error('本学期没有解析到任何课程：可能是还没排课，或教务页面改了结构（也可能登录状态已失效）');
    }

    var entries = mergeRecords(records);
    var courseMap = {};
    var courseOrder = [];
    for (var ei = 0; ei < entries.length; ei++) {
        var entry = entries[ei];
        var ckey = JSON.stringify([entry.name, entry.teacher]);
        if (!courseMap[ckey]) {
            courseMap[ckey] = { name: entry.name, teacher: entry.teacher, note: null, blocks: [] };
            courseOrder.push(ckey);
        }
        courseMap[ckey].blocks.push({
            dayOfWeek: entry.day,
            startPeriod: entry.startSection,
            endPeriod: entry.endSection,
            startWeek: entry.startWeek,
            endWeek: entry.endWeek,
            weekType: entry.weekType,
            location: entry.position
        });
    }
    var courses = [];
    var maxWeek = 0;
    for (var oi = 0; oi < courseOrder.length; oi++) {
        var item = courseMap[courseOrder[oi]];
        for (var bi = 0; bi < item.blocks.length; bi++) {
            if (item.blocks[bi].endWeek > maxWeek) maxWeek = item.blocks[bi].endWeek;
        }
        courses.push(item);
    }

    // ---------- 节次时间：写死的 12 节（逐节照抄上游）；用到第 13 节及以后时，在上一节下课后顺推（统一修订 H3）----------
    var periodTimes = [];
    for (var sp = 0; sp < SCHOOL_PERIOD_TIMES.length; sp++) {
        periodTimes.push({ periodIndex: sp + 1, start: SCHOOL_PERIOD_TIMES[sp].start, end: SCHOOL_PERIOD_TIMES[sp].end });
    }
    var filledPeriods = [];
    var uncoveredFrom = 0;
    for (var fp = SCHOOL_SLOT_COUNT + 1; fp <= maxPeriod; fp++) {
        var prevEnd = clockMinutes(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > MAX_MINUTE) {
            uncoveredFrom = fp;
            break;
        }
        periodTimes.push({ periodIndex: fp, start: clockText(nextStart), end: clockText(nextEnd) });
        filledPeriods.push(fp);
    }

    // ---------- 教学周历：开学日期与学期总周数（上游 fetchSemesterInfo）----------
    // 周历的表：每个周一行，行首标签写「第N周」，其余格子是当周每天的日期（「09月07日」，没有年份）。
    var calendarRows = data.calendar && data.calendar.rows ? data.calendar.rows : [];

    function weekNumberOf(label) {
        var text = clean(label);
        var m = /第\s*([0-9]+)\s*周/.exec(text) || /^([0-9]+)$/.exec(text);
        return m ? parseInt(m[1], 10) : 0;
    }

    // 一个格子里的日期 → { year, month, day }。优先认 title 或文字里带年份的写法，其次「MM月DD日」+
    // 学期代码推出的年份（上游的推法：第 1 学期取前一年、第 2 学期取后一年）；日期要真存在，认不出返回 null
    function dateOfCell(cell) {
        var text = clean(cell.title) + ' ' + clean(cell.text);
        var year = 0;
        var month = 0;
        var day = 0;
        var m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
        if (!m) m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
        if (m) {
            year = parseInt(m[1], 10);
            month = parseInt(m[2], 10);
            day = parseInt(m[3], 10);
        } else {
            m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
            if (!m) return null;
            month = parseInt(m[1], 10);
            day = parseInt(m[2], 10);
            year = termYear;
        }
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        var probe = new Date(Date.UTC(year, month - 1, day));
        if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
        return { year: year, month: month, day: day };
    }

    var calendarWeeks = 0;
    var week1Row = null;
    for (var cr = 0; cr < calendarRows.length; cr++) {
        var weekNo = weekNumberOf(calendarRows[cr].label);
        if (weekNo > calendarWeeks) calendarWeeks = weekNo;
        if (weekNo === 1 && !week1Row) week1Row = calendarRows[cr];
    }

    // 第 1 周那一行：找到第一个带完整日期的格子（该校周历工作日格子只有日号「07」，只有周末格子写「09月12日」），
    // 它在行内的位置就是距这一周第一天几天，据此倒推出每周的第一天（与上游 parseSemesterInfo 的 col - firstCol 同一口径）。
    var calendarFirst = null;
    if (week1Row) {
        var rowCells2 = week1Row.cells || [];
        for (var wc = 0; wc < rowCells2.length; wc++) {
            var one = dateOfCell(rowCells2[wc]);
            if (one) {
                calendarFirst = { date: one, offset: wc };
                break;
            }
        }
    }

    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    // 开学日期的取法（依次）：① 周历第 1 周里第一个带日期的格子，按它在行内的位置倒推出这一周的第一天（真实值）；
    // ② 取不到（没有周历、没有第 1 周、第 1 周没有完整日期），按提取时刻推算最近的周一。②必须说明：
    // 推算值和真值在库里长得一模一样。每周从星期几算起由 firstDay 的星期几决定（移植手册 §4.3），不强行改成周一。
    var firstDay = null;
    var firstWeekday = -1;
    if (calendarFirst) {
        var firstDate = new Date(Date.UTC(calendarFirst.date.year, calendarFirst.date.month - 1, calendarFirst.date.day));
        firstDate.setUTCDate(firstDate.getUTCDate() - calendarFirst.offset);
        firstDay = firstDate.getUTCFullYear() + '-' + pad2(firstDate.getUTCMonth() + 1) + '-' + pad2(firstDate.getUTCDate());
        firstWeekday = firstDate.getUTCDay();
    } else {
        firstDay = mondayOf(data.now);
        if (!firstDay) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
        pushWarning('开学日期无法从教务获取（教学周历没有取到第 1 周的日期），已按最近的周一（' + firstDay + '）推算，请在「学期管理」里核对');
    }

    // ---------- 学期名：教务给的学年学期文字 → 学期代码拼出的名字 ----------
    var termLabel = clean(termData.label);
    var termName = '';
    if (termLabel && TERM_CODE.test(termLabel)) termName = termNameFromCode(termLabel);
    else if (termLabel) termName = termLabel;
    if (!termName) termName = termNameFromCode(termCode);
    if (!termName) termName = SCHOOL_NAME + '当前学期';

    // ---------- 提醒 ----------
    var lastSlot = SCHOOL_PERIOD_TIMES[SCHOOL_PERIOD_TIMES.length - 1];
    if (termData.assumed === true) {
        pushWarning('教务页面没有标出当前是哪一学期，已按学期下拉框的第一项（' + shortName(termName) + '）导入，请核对是不是要导入的学期');
    } else {
        pushWarning('本次导入的学期是「' + shortName(termName) + '」，如需其它学期请先在教务系统里切换再点提取');
    }
    pushWarning('节次时间没有从教务系统读取，已按学校公布的 ' + SCHOOL_SLOT_COUNT + ' 节时间导入（第 1 节 ' +
        SCHOOL_PERIOD_TIMES[0].start + '-' + SCHOOL_PERIOD_TIMES[0].end + '，第 ' + SCHOOL_SLOT_COUNT + ' 节 ' +
        lastSlot.start + '-' + lastSlot.end + '），与实际不符时请在「学期管理」里核对');
    if (firstWeekday >= 0 && firstWeekday !== 1) {
        pushWarning('教务的教学周历每周从' + WEEKDAY_NAMES[firstWeekday] + '算起，第 1 周从 ' + firstDay + ' 开始，周次按这个日子起算，请在「学期管理」里核对');
    }
    if (filledPeriods.length) {
        var fillText = filledPeriods.length === 1 ? ('第 ' + filledPeriods[0] + ' 节') :
            ('第 ' + filledPeriods[0] + '-' + filledPeriods[filledPeriods.length - 1] + ' 节');
        pushWarning('课表用到了' + fillText + '，学校公布的节次时间只到第 ' + SCHOOL_SLOT_COUNT +
            ' 节，已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在「学期管理」里核对');
    }
    if (uncoveredFrom > 0) {
        pushWarning('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }
    if (calendarWeeks === 0) {
        pushWarning('教务没有给出学期总周数，已按 ' + FALLBACK_TOTAL_WEEKS + ' 周计' +
            (maxWeek > FALLBACK_TOTAL_WEEKS ? '（课表里有到第 ' + maxWeek + ' 周的课，已抬高到 ' + totalWeeks + ' 周）' : '') +
            '，请在「学期管理」里核对');
    }
    if (wantedWeeks > MAX_WEEK) {
        pushWarning('学期总周数算出来是 ' + wantedWeeks + ' 周，超过了上限 ' + MAX_WEEK + ' 周，已按 ' + MAX_WEEK + ' 周计，请在「学期管理」里核对');
    } else if (calendarWeeks > 0 && totalWeeks > calendarWeeks) {
        pushWarning('课表里有到第 ' + maxWeek + ' 周的课，比教务教学周历的 ' + calendarWeeks +
            ' 周多，学期总周数已按 ' + totalWeeks + ' 周计，请在「学期管理」里核对');
    }
    if (extraTables > 0) {
        pushWarning('页面里有 ' + (extraTables + 1) + ' 张课表，只导入了第一张，请核对导入结果');
    }
    if (skipped > 0) {
        var skipParts = [];
        if (noNameBlocks) skipParts.push('没有课名 ' + noNameBlocks + ' 个');
        if (noTimeBlocks) skipParts.push('没有上课时间或周次、节次写法没认出 ' + noTimeBlocks + ' 个');
        if (noWeekBlocks) skipParts.push('没有有效周次 ' + noWeekBlocks + ' 个');
        pushWarning('有 ' + skipped + ' 个上课安排没能导入（' + skipParts.join('，') + '）。教务页面的写法可能有变化，欢迎反馈。' +
            droppedText());
    }
    if (noTeacherCount > 0 || noPlaceCount > 0) {
        var lackParts = [];
        if (noTeacherCount > 0) lackParts.push(noTeacherCount + ' 门课没给上课教师');
        if (noPlaceCount > 0) lackParts.push(noPlaceCount + ' 门课没给上课地点');
        var shownNames = [];
        for (var sn = 0; sn < sampleNames.length && sn < 3; sn++) shownNames.push(shortName(sampleNames[sn]));
        var emptyText = noTeacherCount > 0 && noPlaceCount > 0 ? '教师或地点暂时空着' :
            (noTeacherCount > 0 ? '教师暂时空着' : '上课地点暂时空着');
        pushWarning('有 ' + lackParts.join('、') + '（例如 ' + shownNames.join('、') + '）：已照常导入，' + emptyText +
            '，可在「编辑课程」里补上');
    }
    if (droppedWeeks > 0) {
        pushWarning('有 ' + droppedWeeks + ' 个周次不在 1-' + MAX_WEEK + ' 周内（含第 0 周），这些周次没有导入');
    }
    if (serialGroups > 0) {
        pushWarning('有 ' + serialGroups + ' 处周次后面的括号里只写了数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        pushWarning('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，已忽略，请核对这几门课的周次');
    }
    if (bothMarks > 0) {
        pushWarning('有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对');
    }
    if (mergedCells > 0) {
        pushWarning('有 ' + mergedCells + ' 处课占了连续几天的格子，这些课被同时放进了这几天，请核对导入结果');
    }
    if (unreadCells > 0) {
        pushWarning('课表里有 ' + unreadCells + ' 个格子有内容，但认不出课程信息，这些格子没有导入，请对照教务系统核对');
    }

    var term = {
        name: termName,
        firstDay: firstDay,
        totalWeeks: totalWeeks,
        periodTimes: periodTimes,
        courses: courses
    };

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finalWarnings(),
        terms: [term]
    });
})()
