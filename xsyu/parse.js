(function () {
    // 西安石油大学 · 超星（chaoxing）教务适配器 —— 纯转换段（第二步）。
    //
    // 移植自 shiguang_warehouse 的 XSYU/xsyu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT，维护者 dr1am1）
    // 上游快照 7c9e190；本校脚本最后一次修改 be8d720（2026-10-25）。
    // 移植改动（逐条与 AUDIT.md §4 对应）：
    //   ① 上游 parseCourseData / mergeAndDistinctCourses / cleanTeacherName / parseWeeks / buildTimeSlots 的逻辑照搬，
    //      只是输出改成空课的结构：每门课 blocks 里的一条 = 星期 + 节次段 + 周次段（startWeek / endWeek / weekType）；
    //   ② 周次：上游只认逗号数字。这里另认区间（1-16）、「第」字、「共 N 周」备注（只剥备注本身）、
    //      单 / 双标记在前、在后、在括号里三种写法，并修掉「段首标记被并到上一段」（(单)1-8周,(双)9-16周）
    //      与「无逗号的前置标记」（(单)1-8周(双)9-16周）两个坑；
    //   ③ 节次时间：教务的（jcsjszList）优先；取不到按上课校区名用上游写死的校区表；校区名也没有就用空课默认 12 节；
    //      课表用到的节次超出所用的表时，逐节补齐并提醒（统一修订 H3）；
    //   ④ 开学日、学期总周数优先用教务周次表（zclist）；教务给的日期对不上学期时作废，推算的值一律写进提醒；
    //   ⑤ 教师 / 教室为空、或是「待定」「未知」这类占位词，一律写 null（上游会写「待定」）；缺教师 / 缺教室按课程汇总提醒；
    //   ⑥ 学分（上游的 xf）不带进载荷：本应用的课程载荷没有这个字段；
    //   ⑦ 上游 FALLBACK_SLOTS 的「默认校区」别名不照搬：认不出的校区名不猜，走默认节次时间并提醒。
    //
    // 输入：extract.js 的原样输出。输出：空课课表载荷（specVersion 1）。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var rows = data.rows;
    var term = data.term || {};
    var campusIn = data.campus || {};
    var askedCampus = data.askedCampus || null;
    var slotsIn = data.slots || [];
    var weekIn = data.weeks || [];

    var MAX_WEEK = 30;          // 载荷校验：周次 1..30
    var MIN_TOTAL_WEEKS = 20;   // 教务没给总周数时用（与上游 semesterTotalWeeks 的兜底一致）
    var MAX_PERIOD = 20;        // 单日节次上限：超过一定是脏数据
    var MAX_WARNINGS = 20;      // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200; // 载荷校验：每条 ≤200 字
    var MAX_NAME = 20;          // 课名、校区名、学期名拼进提醒时截到 20 字
    var EXTEND_BREAK_MINUTES = 5;   // 节次表补不上时顺推：课间 5 分钟
    var EXTEND_CLASS_MINUTES = 45;  // 节次表补不上时顺推：每节 45 分钟
    var CALENDAR_TOLERANCE_DAYS = 45; // 教务给的开学日与学期锚点相差超过它，判为别的学期的校历
    var KEY_SEP = String.fromCharCode(0); // 字典键的分隔符（课名里不会出现）

    // 空课默认节次时间（12 节）：教务没给节次时间、校区名也认不出时整张用它；课表节次超出所用的表时逐节补
    var DEFAULT_PERIOD_TEXT = [
        '08:00-08:45', '08:55-09:40', '10:00-10:45', '10:55-11:40',
        '14:00-14:45', '14:55-15:40', '16:00-16:45', '16:55-17:40',
        '18:30-19:15', '19:25-20:10', '20:20-21:05', '21:15-22:00'
    ];

    // 上游 FALLBACK_SLOTS 的三个校区：教务没给节次时间时按校区名用（上游写死的表，逐节对照上游抄录）
    var CAMPUS_PERIOD_TEXT = {
        '雁塔校区': ['08:00-08:50', '09:00-09:50', '10:20-11:00', '11:10-12:00', '14:30-15:20',
            '15:30-16:20', '16:40-17:30', '17:40-18:30', '19:30-20:20', '20:30-21:20'],
        '明德校区': ['08:00-08:50', '09:00-09:50', '10:10-11:00', '11:10-12:00', '14:30-15:20',
            '15:30-16:20', '16:40-17:30', '17:40-18:30', '19:30-20:20', '20:30-21:20'],
        '鄠邑校区': ['08:20-09:05', '09:15-10:00', '10:20-11:05', '11:15-12:00', '14:00-14:45',
            '14:55-15:40', '16:00-16:45', '16:55-17:40', '19:00-19:45', '19:55-20:40']
    };

    // 占位词：写进课表会被当成真的名字 / 教室，一律按「没有」处理
    var PLACEHOLDERS = ['待定', '未知', '暂无', '无', 'null', 'undefined', '--'];
    // 职称：「王建国（副教授）」里的职称不是老师名
    var TITLE_RE = /(教授|讲师|助教|研究员|工程师|实验师|教练)$/;

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function pad2(value) {
        return (value < 10 ? '0' : '') + value;
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 拼进提醒的课名 / 校区名 / 学期名：超过 20 字截短，省得整条提醒超长（超长会整次拒收）
    function shortName(value) {
        var s = textOf(value);
        return s.length > MAX_NAME ? s.substring(0, MAX_NAME - 1) + '…' : s;
    }

    var warnings = [];

    // 所有提醒都走这一个出口：整条 ≤200 字，总数 ≤20 条
    function warn(message) {
        var line = textOf(message);
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length < MAX_WARNINGS) warnings.push(line);
    }

    // 课名 / 教师 / 教室在教务接口里是 HTML 片段：块级标签换成空格，其余标签去掉，再还原常见实体
    function htmlText(value) {
        if (value === null || value === undefined) return '';
        var s = String(value)
            .replace(/<\s*br\s*\/?\s*>/gi, ' ')
            .replace(/<\s*\/\s*(p|div|li|tr|td|th|h[1-6])\s*>/gi, ' ')
            .replace(/<[^>]*>/g, '');
        s = s.replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/gi, '&');
        return s.replace(/\s+/g, ' ').trim();
    }

    function plainOrNull(value) {
        var s = htmlText(value);
        if (!s || PLACEHOLDERS.indexOf(s) >= 0) return null;
        return s;
    }

    // 教师名：「<a>张三</a>,<a>李四</a>」；畸形的「<a>赵六</a>,(,<a>钱七</a>,)」里括号内容是有效教师（上游同款，取出来）；
    // 职称括号（「王建国（副教授）」）的内容按职称丢掉。去重后用逗号拼接。
    function teacherOf(value) {
        var base = htmlText(value);
        var inner = [];
        var outside = base.replace(/[(（]([^()（）]*)[)）]/g, function (whole, group) {
            group.split(/[,，、;；]/).forEach(function (part) {
                var name = part.trim();
                if (name && name.length <= 12) inner.push(name);
            });
            return ',';
        });
        var names = [];
        var seen = {};
        var parts = outside.split(/[,，、;；]/).concat(inner);
        for (var i = 0; i < parts.length; i++) {
            var name = parts[i].trim();
            if (!name || TITLE_RE.test(name) || PLACEHOLDERS.indexOf(name) >= 0) continue;
            if (hasOwn(seen, name)) continue;
            seen[name] = true;
            names.push(name);
        }
        return names.length ? names.join(',') : null;
    }

    // 只认纯整数："3" / "03" 可以，"3-4" / "第3节" / "" 都不行（不悄悄读成 3）
    function intOf(value) {
        if (value === null || value === undefined) return null;
        var s = String(value).replace(/\s+/g, '');
        if (!/^[0-9]{1,3}$/.test(s)) return null;
        return parseInt(s, 10);
    }

    // "8:00" / "08:00:00" → "08:00"；不合法返回 null
    function timeOf(value) {
        var m = /^([0-9]{1,2}):([0-9]{2})(:[0-9]{2})?$/.exec(textOf(value));
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var mi = parseInt(m[2], 10);
        if (h > 23 || mi > 59) return null;
        return pad2(h) + ':' + pad2(mi);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    // "08:00-08:45" 的列表 → [{periodIndex, start, end}]
    function slotsFromText(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var parts = list[i].split('-');
            out.push({ periodIndex: i + 1, start: parts[0], end: parts[1] });
        }
        return out;
    }

    // 教务节次时间：从 1 连续、每节有开始有结束、不重叠；不合格整张不用（返回 null）
    function serverSlotsOf(list) {
        if (!Array.isArray(list) || !list.length) return null;
        var slots = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            var number = intOf(item.jc);
            var start = timeOf(item.kssj);
            var end = timeOf(item.jssj);
            if (number && start && end) slots.push({ periodIndex: number, start: start, end: end });
        }
        slots.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        for (var k = 0; k < slots.length; k++) {
            var ok = slots[k].periodIndex === k + 1 &&
                minutesOf(slots[k].end) > minutesOf(slots[k].start) &&
                (k === 0 || minutesOf(slots[k].start) >= minutesOf(slots[k - 1].end));
            if (!ok) return null;
        }
        return slots.length ? slots : null;
    }

    // ---------- 周次 ----------

    var droppedWeeks = 0;   // 超出 1..30 的周次（计数上报）
    var noiseGroups = 0;    // 括号备注（教学班序号、「(3组)」之类，没有计入周次）
    var noiseSample = '';   // 第一处备注的原文，写进提醒（截 20 字）
    var orphanMarks = 0;    // 单 / 双标记没有依附到任何周次段（已忽略）

    function markInto(target, mark) {
        if (mark === '单') target.odd = true;
        else target.even = true;
        return target;
    }

    // 周次串 → 升序去重的周次数组。写法：「1,3,5」「1-16」「1-16周(双)」「(单)1-8周,(双)9-16周」「1-8周(单)9-16周(双)」「1-8周 9-16周」「第1-第8周」「1-8周(共8周),9-16周」
    function weeksOf(source) {
        var raw = String(source === null || source === undefined ? '' : source);
        // 「共8周」是课程总周数备注：只剥备注本身，不从它删到行尾（会把后面的真实周次一起吞掉）
        raw = raw.replace(/共\s*[0-9]+\s*周?/g, '');
        // 剥备注后剩下的空括号去掉
        raw = raw.replace(/[(（]\s*[)）]/g, '');
        // 「第」只是读法：「第1-第8周」→「1-8周」
        raw = raw.replace(/第\s*(?=[0-9])/g, '');
        // 破折号连同两侧空白归成半角「-」
        raw = raw.replace(/\s*[-—–~～至到]\s*/g, '-');
        // 括号：只有数字的（「(1)」「(1-2)」）是教学班序号，整组摘掉并计数；含别的字的备注（「(3组)」）也摘掉并计数；
        // 其余（「(1-16周)」「(单)」「(双周)」）保留内容，去掉括号本身。括号不换成逗号，免得把前置标记和数字隔开
        raw = raw.replace(/[(（]([^()（）]*)[)）]/g, function (whole, inner) {
            var body = inner.replace(/\s+/g, '');
            if (/^[0-9,，\-]*$/.test(body) || /[^0-9,，\-周单双]/.test(body)) {
                noiseGroups++;
                if (!noiseSample) noiseSample = whole;
                return ',';
            }
            return inner;
        });
        raw = raw.replace(/[()（）]/g, ',');
        raw = raw.replace(/周/g, '');

        // 切成 数字段 / 单双标记 / 分隔符 三类记号
        var tokens = [];
        var re = /([0-9]{1,3})(?:-([0-9]{1,3}))?|([单双])|[^0-9单双]+/g;
        var m;
        while ((m = re.exec(raw)) !== null) {
            if (m[1] !== undefined) {
                tokens.push({
                    kind: 'num',
                    from: parseInt(m[1], 10),
                    to: m[2] !== undefined ? parseInt(m[2], 10) : parseInt(m[1], 10),
                    odd: false,
                    even: false
                });
            } else if (m[3] !== undefined) {
                tokens.push({ kind: 'mark', mark: m[3] });
            } else {
                tokens.push({ kind: 'sep' });
            }
        }

        // 把单双标记归到数字段上：
        //   - 标记紧贴在数字段后面（「1-16周(双)」「1-8周(单)9-16周(双)」）→ 归前面那一段；
        //   - 本段以标记开头（「(单)1-8周(双)9-16周」）→ 前一个标记归后面那一段，后一个标记才是它的后缀；
        //   - 标记前后都没有数字（「1-16 单」）→ 归最近的前一段；都没有就计数忽略。
        var numbers = [];
        var pending = null;
        var atRunStart = true;
        var runFirstIsMark = false;
        var lastNum = null;
        for (var i = 0; i < tokens.length; i++) {
            var tk = tokens[i];
            if (tk.kind === 'sep') {
                pending = null;
                atRunStart = true;
                runFirstIsMark = false;
                continue;
            }
            if (tk.kind === 'num') {
                if (pending) {
                    tk.odd = pending.odd;
                    tk.even = pending.even;
                    pending = null;
                }
                numbers.push(tk);
                lastNum = tk;
                atRunStart = false;
                continue;
            }
            if (atRunStart) runFirstIsMark = true;
            var prevNum = i > 0 && tokens[i - 1].kind === 'num';
            var nextNum = i + 1 < tokens.length && tokens[i + 1].kind === 'num';
            if (nextNum && !(prevNum && !runFirstIsMark)) {
                pending = markInto(pending || { odd: false, even: false }, tk.mark);
            } else if (prevNum) {
                markInto(tokens[i - 1], tk.mark);
            } else if (lastNum) {
                markInto(lastNum, tk.mark);
            } else {
                orphanMarks++;
            }
            atRunStart = false;
        }

        // 展开成周次；区间才按单 / 双过滤（单个周次写了标记也保留，不让它凭空消失）
        var seen = {};
        var weeks = [];
        for (var n = 0; n < numbers.length; n++) {
            var seg = numbers[n];
            var lo = Math.min(seg.from, seg.to);
            var hi = Math.max(seg.from, seg.to);
            var ranged = lo !== hi;
            var unfiltered = seg.odd === seg.even;
            // 上限 40 步只防脏数据（如「1-2026」）把数组撑爆
            for (var w = lo; w <= hi && w < lo + 40; w++) {
                if (ranged && !unfiltered && seg.odd && w % 2 === 0) continue;
                if (ranged && !unfiltered && seg.even && w % 2 === 1) continue;
                if (w < 1 || w > MAX_WEEK) {
                    droppedWeeks++;
                    continue;
                }
                if (hasOwn(seen, w)) continue;
                seen[w] = true;
                weeks.push(w);
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    // 周次集合 → 极大段。步长 1 视作每周，步长 2 视作单 / 双周
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

    // 码位比较（不用 localeCompare：Node 与 CI 的 Rhino 对中文排序可能不同）
    function compareText(left, right) {
        var a = left === null || left === undefined ? '' : String(left);
        var b = right === null || right === undefined ? '' : String(right);
        if (a === b) return 0;
        return a < b ? -1 : 1;
    }

    function sectionsText(list) {
        var runs = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            runs.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + runs.join('、') + ' 节';
    }

    function examplesOf(names) {
        return '例如 ' + names.slice(0, 3).map(shortName).join('、') + (names.length > 3 ? ' 等' : '');
    }

    // ---------- 学期与开学日 ----------

    function parseTermCode(code) {
        var matched = /^([0-9]{4})-([0-9]{4})-([12])$/.exec(textOf(code));
        if (!matched) return null;
        return { startYear: parseInt(matched[1], 10), semester: parseInt(matched[3], 10) };
    }

    function termNameOf(info) {
        return info.startYear + '-' + (info.startYear + 1) + '学年' + (info.semester === 1 ? '第一学期' : '第二学期');
    }

    // 开学日锚点：第一学期 9 月 1 日，第二学期次年 2 月 20 日（推算用，也用来判断教务给的校历是不是这个学期的）
    function anchorOf(info) {
        return info.semester === 2 ? new Date(info.startYear + 1, 1, 20) : new Date(info.startYear, 8, 1);
    }

    // 「之后的第一个周一」（含当天）
    function firstMondayOnOrAfter(date) {
        var shift = (8 - date.getDay()) % 7;
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() + shift);
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function dateOf(value) {
        var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(textOf(value));
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var d = new Date(year, month - 1, day);
        if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
        return d;
    }

    function daysBetween(a, b) {
        return Math.round((a.getTime() - b.getTime()) / 86400000);
    }

    // ---------- 主流程 ----------

    if (!rows || !Array.isArray(rows)) {
        throw new Error('提取数据里没有课表行：教务系统的返回格式可能变了');
    }

    var info = parseTermCode(term.code);
    if (!info) {
        throw new Error('没能认出这个学年学期（' + shortName(term.code) + '），请在教务页面里重新选择学期后再点「提取课表」');
    }

    var skipped = 0;
    var items = [];
    var campusTally = {};
    var campusOrder = [];

    for (var index = 0; index < rows.length; index++) {
        var row = rows[index] || {};

        var campusKey = textOf(row.xqid) || textOf(row.xqmc);
        if (campusKey) {
            if (!hasOwn(campusTally, 'k:' + campusKey)) {
                campusTally['k:' + campusKey] = { name: textOf(row.xqmc), rows: 0 };
                campusOrder.push('k:' + campusKey);
            }
            campusTally['k:' + campusKey].rows += 1;
        }

        var name = htmlText(row.kcmc);
        var day = intOf(row.xingqi);
        var section = intOf(row.djc);
        var weeks = weeksOf(row.zcstr);

        if (!name || !(day >= 1 && day <= 7) || !(section >= 1 && section <= MAX_PERIOD) || !weeks.length) {
            skipped++;
            continue;
        }

        items.push({
            name: name,
            teacher: teacherOf(row.tmc),
            location: plainOrNull(row.croommc),
            day: day,
            section: section,
            weeks: weeks,
            weeksKey: weeks.join(','),
            order: index
        });
    }

    // 上课校区：课程最多的那个（与 extract.js 挑请求用的校区是同一条规则）；跨校区时提醒
    var campusList = [];
    for (var c = 0; c < campusOrder.length; c++) campusList.push(campusTally[campusOrder[c]]);
    campusList.sort(function (a, b) { return b.rows - a.rows; });

    if (!items.length) {
        throw new Error('没有解析到任何课程：收到了 ' + rows.length + ' 行课表数据，' +
            '但都缺少课名 / 星期 / 节次 / 周次（教务系统的数据格式可能变了）');
    }

    // 排序：星期 → 周次 → 课名 → 教师 → 教室 → 节次，同一门课的连堂记录相邻；最后按原始行序兜底
    items.sort(function (a, b) {
        return (a.day - b.day) ||
            compareText(a.weeksKey, b.weeksKey) ||
            compareText(a.name, b.name) ||
            compareText(a.teacher, b.teacher) ||
            compareText(a.location, b.location) ||
            (a.section - b.section) ||
            (a.order - b.order);
    });

    // 连堂合并：星期 / 课名 / 教师 / 教室 / 周次都相同且节次连续 → 合成一段
    var merged = [];
    var i = 0;
    while (i < items.length) {
        var current = items[i];
        var endSection = current.section;
        var j = i + 1;
        while (j < items.length) {
            var next = items[j];
            if (next.day === current.day &&
                next.name === current.name &&
                next.teacher === current.teacher &&
                next.location === current.location &&
                next.weeksKey === current.weeksKey &&
                next.section <= endSection + 1) {
                endSection = Math.max(endSection, next.section);
                j++;
            } else {
                break;
            }
        }
        merged.push({
            name: current.name,
            teacher: current.teacher,
            location: current.location,
            day: current.day,
            startPeriod: current.section,
            endPeriod: endSection,
            weeks: current.weeks
        });
        i = j;
    }

    // 课程归并：同名同教师的多段进同一门课的 blocks；完全相同的块只留一条
    var order = [];
    var byCourse = {};
    var blockSeen = {};
    var maxWeek = 0;
    var maxPeriod = 0;

    for (var m2 = 0; m2 < merged.length; m2++) {
        var item = merged[m2];
        var key = item.name + KEY_SEP + (item.teacher || '');
        if (!hasOwn(byCourse, key)) {
            byCourse[key] = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            order.push(key);
        }
        if (item.endPeriod > maxPeriod) maxPeriod = item.endPeriod;
        var runs = runsOf(item.weeks);
        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            if (run.end > maxWeek) maxWeek = run.end;
            var blockKey = key + KEY_SEP + [item.day, item.startPeriod, item.endPeriod, run.start, run.end,
                run.weekType, item.location === null ? '' : item.location].join(KEY_SEP);
            if (hasOwn(blockSeen, blockKey)) continue;
            blockSeen[blockKey] = true;
            byCourse[key].blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.startPeriod,
                endPeriod: item.endPeriod,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item.location
            });
        }
    }

    var courses = [];
    for (var o = 0; o < order.length; o++) courses.push(byCourse[order[o]]);

    // ---------- 节次时间 ----------

    var campusName = textOf(campusIn.xqmc) || textOf(askedCampus);
    var fromAsk = !textOf(campusIn.xqmc) && !!textOf(askedCampus);
    var serverTimes = serverSlotsOf(slotsIn);
    var source;
    var table;
    if (serverTimes) {
        source = 'server';
        table = serverTimes;
    } else if (hasOwn(CAMPUS_PERIOD_TEXT, campusName)) {
        source = 'campus';
        table = slotsFromText(CAMPUS_PERIOD_TEXT[campusName]);
    } else {
        source = 'default';
        table = slotsFromText(DEFAULT_PERIOD_TEXT);
    }

    // 课表用到的节次超出所用的表：空课默认表里同号的那一节，只在它的开始不早于上一节下课时才用；
    // 否则在上一节下课后课间 5 分钟、每节 45 分钟顺推；越过 23:59 就停（课照常导入，这些节次没有时间）
    var defaultSlots = slotsFromText(DEFAULT_PERIOD_TEXT);
    var fromDefault = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = table.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(table[table.length - 1].end);
        var defaultSlot = defaultSlots[p - 1];
        if (defaultSlot && minutesOf(defaultSlot.start) >= prevEnd) {
            table.push({ periodIndex: p, start: defaultSlot.start, end: defaultSlot.end });
            fromDefault.push(p);
        } else {
            var nextEnd = prevEnd + EXTEND_BREAK_MINUTES + EXTEND_CLASS_MINUTES;
            if (nextEnd > 23 * 60 + 59) {
                uncoveredFrom = p;
                break;
            }
            table.push({
                periodIndex: p,
                start: hhmmOf(prevEnd + EXTEND_BREAK_MINUTES),
                end: hhmmOf(nextEnd)
            });
            bySequence.push(p);
        }
    }

    // ---------- 开学日与总周数 ----------

    var anchor = anchorOf(info);
    var ruleText = info.semester === 2 ? '2 月 20 日之后的第一个周一' : '9 月 1 日之后的第一个周一';

    var firstWeek = null;
    for (var z = 0; z < weekIn.length; z++) {
        if (intOf((weekIn[z] || {}).zc) === 1) {
            firstWeek = weekIn[z];
            break;
        }
    }
    var calendarDay = null;
    var rejectedDay = '';
    if (firstWeek) {
        var firstDate = dateOf(firstWeek.minrq);
        if (firstDate && Math.abs(daysBetween(firstDate, anchor)) <= CALENDAR_TOLERANCE_DAYS) {
            calendarDay = firstDate;
        } else if (firstDate) {
            rejectedDay = isoOf(firstDate);
        }
    }
    // 校历给的开学日对不上学期时，整份校历（含周数）一起作废
    var calendarTotal = rejectedDay ? 0 : weekIn.length;
    var firstDay = calendarDay ? isoOf(calendarDay) : isoOf(firstMondayOnOrAfter(anchor));

    var total = calendarTotal || MIN_TOTAL_WEEKS;
    var clamped = total > MAX_WEEK;
    if (clamped) total = MAX_WEEK;
    var raised = maxWeek > total;
    if (raised) total = maxWeek;

    var termText = textOf(term.text);
    var termName = termText || ('西安石油大学 ' + termNameOf(info));

    // ---------- 提醒（凡是推算的、猜的、丢掉的，都在这里说清楚） ----------

    warn('只导入了教务系统里当前选中的学期（' + shortName(termName) +
        '）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」');

    if (campusList.length > 1) {
        var topName = campusList[0].name ? shortName(campusList[0].name) : '（名称未知）';
        warn('本学期课程分布在 ' + campusList.length + ' 个校区，节次时间按课程最多的「' + topName +
            '」写入，其余校区的课请核对');
    }

    if (!calendarDay) {
        if (rejectedDay) {
            warn('教务校历给出的开学日期（' + rejectedDay + '）不属于这个学期，已忽略；第 1 周按「' + ruleText +
                '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日');
        } else {
            warn('教务系统没有给出开学日期，第 1 周按「' + ruleText + '」推算为 ' + firstDay +
                '，请在学期管理里核对成学校实际开学日');
        }
    }

    if (clamped) {
        warn('教务校历写的一学期超过 ' + MAX_WEEK + ' 周，已按 ' + MAX_WEEK + ' 周导入');
    } else if (raised && calendarTotal) {
        warn('教务校历写的一学期是 ' + calendarTotal + ' 周，课表里有第 ' + maxWeek + ' 周的课，已按 ' + total +
            ' 周导入（否则第 ' + (calendarTotal + 1) + ' 周起的课放不下）');
    } else if (raised) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过 ' + MIN_TOTAL_WEEKS + ' 周，学期总周数已按 ' + total +
            ' 周导入，如与实际不符可在学期管理里改');
    } else if (calendarTotal) {
        warn('学期总周数取自教务校历（' + total + ' 周），如与实际不符可在学期管理里改');
    } else if (rejectedDay) {
        warn('教务校历不属于这个学期（见上一条），学期总周数按 ' + MIN_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改');
    } else {
        warn('教务系统没有给出学期总周数，按 ' + MIN_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改');
    }

    if (source === 'default') {
        warn('教务系统没有给出节次时间' +
            (campusName ? '，也没有「' + shortName(campusName) + '」的现成节次时间' : '') +
            '，已按默认的 12 节节次时间导入（第 1 节 08:00-08:45），时间可能与学校实际作息不符，请在学期管理里核对');
    } else if (source === 'campus') {
        warn(fromAsk
            ? '教务没有给出节次时间，已按你选择的「' + shortName(campusName) + '」写入，请在学期管理里核对'
            : '教务没有给出节次时间，已按「' + shortName(campusName) + '」写入，请在学期管理里核对');
    }

    if (fromDefault.length || bySequence.length) {
        var fillTexts = [];
        if (fromDefault.length) fillTexts.push(sectionsText(fromDefault) + '用默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromDefault.concat(bySequence).sort(function (a, b) { return a - b; });
        warn('课表用到了节次时间表里没有的' + sectionsText(filledAll) + '，已补上时间：' +
            fillTexts.join('，') + '，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间' +
            '（课程已导入），请在学期管理里补上');
    }

    if (droppedWeeks) {
        warn('有 ' + droppedWeeks + ' 个周次超出第 1 至 ' + MAX_WEEK + ' 周的范围，已忽略（教务数据里的异常值）');
    }
    if (noiseGroups) {
        warn('周次里有 ' + noiseGroups + ' 处括号备注（例如「' + shortName(noiseSample) +
            '」）没有计入周次，请核对课表');
    }
    if (orphanMarks) {
        warn('有 ' + orphanMarks + ' 处单双周标记没有依附到具体的周次，已忽略，请核对课表');
    }
    if (skipped) {
        warn('有 ' + skipped + ' 行课表数据缺少课名、星期、节次或周次，已跳过（可能是临时调整之类的记录）');
    }

    var noTeacher = [];
    var noLocation = [];
    for (var q = 0; q < courses.length; q++) {
        var course = courses[q];
        if (!course.teacher) noTeacher.push(course.name);
        for (var b = 0; b < course.blocks.length; b++) {
            if (course.blocks[b].location === null) {
                noLocation.push(course.name);
                break;
            }
        }
    }
    if (noTeacher.length) {
        warn('有 ' + noTeacher.length + ' 门课没有教师信息（' + examplesOf(noTeacher) +
            '），教师可在本门课的「编辑课程」里补充');
    }
    if (noLocation.length) {
        warn('有 ' + noLocation.length + ' 门课没有教室信息（' + examplesOf(noLocation) +
            '），教室可在本门课的「编辑课程」里补充');
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
                totalWeeks: total,
                periodTimes: table,
                courses: courses
            }
        ]
    });
})()
