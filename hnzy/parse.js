(function () {
    // 河南职业技术学院教务适配器（学校自建课表服务）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 HNZY/hnzy.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 一颗）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03 拉取）
    //   本校脚本最后一次修改 80e30cf（批量合并提交，提交者不是作者）
    //
    // 上游在同一段脚本里取数、算周次、合并、保存。这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑）。
    // 输入是 extract.js 交出来的 { term, today, failedWeeks, rows }：rows 只带课名、教师、教室、星期、起止节次、周次文字。
    //
    // 移植改动（逐条见 AUDIT.md「与上游的差异」）：
    //   ① 周次：上游 parseWeeks 不认「(单)」「(双)」，「1-16周(单)」会被读成每周都上；这里按标记归属读
    //      （前置「(单)1-8周(双)9-16周」、后置「1-8周(单),9-16周(双)」、「共 N 周」备注、括号序号与备注都照顾到）；
    //   ② 同一门课在不同周换了教室：按「课名 + 教师 + 教室 + 星期 + 起止节次」分组，周次取并集，教室不同的分开成两块；
    //   ③ 相邻节次且周次集合相同的合并（<= 结束 + 1，允许重叠与首尾相接），完全相同的行只留一条；
    //   ④ 缺课名 / 星期 / 节次 / 周次的行计数跳过，写进提醒；缺教师 / 缺教室照常导入（null），按课名汇总计数；
    //   ⑤ 节次时间照抄上游的 12 节写死表（「大节」拆成两段，逐节对照）；超出 12 节按「统一修订 H3」顺推并提醒；
    //   ⑥ 开学日：教务接口没有校历，按学期推算（第一学期 9 月初、第二学期 2 月下旬）并提醒核对；
    //      总周数：没有校历时取上游写死的 20 周，课表里有更晚的周次就抬高并提醒；
    //   ⑦ 学期名：教务给的学年与学期拼成「2026-2027学年第一学期」；学年读不出时用「学校名 + 学期」，不用适配器名；
    //   ⑧ 单周请求失败：提醒点名周次（extract.js 已记下），不静默丢周；
    //   ⑨ 上游的 saveImportedCourses / savePresetTimeSlots / showToast / notifyTaskCompletion 不移植：空课由宿主保存，适配器只交载荷。

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];
    var failedWeeks = Array.isArray(data.failedWeeks) ? data.failedWeeks : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据（上游写死 12 节，顺推最多到这里）
    var SCHOOL_NAME = '河南职业技术学院';   // 学年读不出来时的学期名兜底（学校名 + 学期）
    var SCHOOL_TOTAL_WEEKS = 20;   // 上游写死的学期周数（没有校历接口）
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数
    var EXTEND_BREAK_MINUTES = 5;  // 节次超出写死表时顺推：课间 5 分钟
    var EXTEND_CLASS_MINUTES = 45; // 节次超出写死表时顺推：每节 45 分钟

    // 上游 HNZY/hnzy.js importPresetTimeSlots 写死的 12 节表（「大节」的两段），逐节照抄
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:30', end: '09:15' },
        { periodIndex: 2, start: '09:15', end: '10:00' },
        { periodIndex: 3, start: '10:20', end: '11:05' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:20', end: '15:05' },
        { periodIndex: 6, start: '15:05', end: '15:50' },
        { periodIndex: 7, start: '16:10', end: '16:55' },
        { periodIndex: 8, start: '16:55', end: '17:40' },
        { periodIndex: 9, start: '18:00', end: '18:45' },
        { periodIndex: 10, start: '18:45', end: '19:00' },
        { periodIndex: 11, start: '19:00', end: '19:45' },
        { periodIndex: 12, start: '19:45', end: '20:30' }
    ];

    // 开学日推算的锚点：别直接当 firstDay，要回退到那一周的周一（与 hueb 同口径）
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '第三学期 = 7 月 1 日所在周的周一' }
    };

    var KIND_CN = { first: '一', second: '二', third: '三' };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 教师 / 教室写成这些占位文字时当作没有（载荷里必须是 null，不许写「未知」「暂无」）
    var PLACEHOLDERS = { '未知': true, '待定': true, '暂无': true, '暂无教师': true, '暂无教室': true };
    function realOrEmpty(value) {
        var t = text(value);
        return Object.prototype.hasOwnProperty.call(PLACEHOLDERS, t) ? '' : t;
    }

    // 课名过长时截短，避免一个超长课名撑破提醒上限
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

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
    }

    function mondayOfIso(iso) {
        return isoOf(mondayOnOrBefore(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10),
            parseInt(iso.substring(8, 10), 10)
        ));
    }

    function isoOfAny(value) {
        var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
        if (!m) return null;
        return m[1] + '-' + pad2(parseInt(m[2], 10)) + '-' + pad2(parseInt(m[3], 10));
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return pad2(h) + ':' + pad2(m);
    }

    // 节次号（已升序）写成「第 9-12 节」「第 9、11-12 节」
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

    // ---------- warnings（上限 20 条 × 200 字，超了整包会被拒，所以统一由 warn 收口） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 学期名与开学日 ----------
    function termKind() {
        var label = text(term.termLabel);
        if (label.indexOf('二') >= 0 || label === '2') return 'second';
        if (label.indexOf('三') >= 0 || label === '3') return 'third';
        return 'first';
    }

    function termYear() {
        var m = /^(\d{4})/.exec(text(term.yearLabel));
        return m ? parseInt(m[1], 10) : 0;
    }

    // 学期名：教务给的学年 + 学期文字（「2026-2027学年第一学期」）；学年读不出来用「学校名 + 学期」
    function termName() {
        var year = text(term.yearLabel);
        var label = text(term.termLabel) || '当前学期';
        if (label.indexOf('学期') < 0) label = label + '学期';
        if (!year) return SCHOOL_NAME + ' ' + label;
        if (year.indexOf('学年') < 0) year = year + '学年';
        return year + label;
    }

    // 教务没有校历：按学期推算第 1 周的周一。依赖学期序号与学年，结果一律写进提醒
    function estimateStart(todayValue) {
        var year = termYear();
        var kind = termKind();
        if (!year) {
            return { iso: mondayOfIso(todayValue), rule: '今天所在周的周一' };
        }
        var anchor = KIND_ANCHOR[kind];
        return {
            iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), anchor.month, anchor.day)),
            rule: anchor.rule
        };
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。认的写法：「1-16周」「1-16周(单)」「(单)1-16周」「1-16(单周)」
    // 「1-3,5-9周」「1-8周(单)9-16周(双)」「(单)1-8周(双)9-16周」「第1-第8周」「1 - 16周」，以及「共 N 周」备注（只剥备注本身）。
    //   ① 「周」只是量词，先删掉再切段，「(单)」「(双)」才能跟着自己那一段走；
    //   ② 括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉，免得被当成第 1-2 周；含非周次字的（"(3组)"）是备注，也摘掉并计数；
    //   ③ 单 / 双标记有三种位置，前置标记（段首）归下一段，后置标记归上一段；标记自己成段时并给最近的周次段；
    //   ④ 破折号连同两侧空白归一成半角 '-'，剩下的空白当分段符（不删空白，否则 "1-3周 5-9周" 会变成 1-35）。
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
            .replace(/[～~—－–至到]/g, '-');
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // 「共 8 周」之类的课程总周数备注只剥备注本身，不能从「共」删到行尾
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 第 1 步：破折号连同两侧空白归一成半角 '-'；「第1-第8周」里的「第」也要去掉
        cleaned = cleaned.replace(/第\s*(?=[0-9])/g, '');
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 紧挨数字的单 / 双括号：前置（段首）归后一段，后置归前一段
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 第二个前置标记夹在两段中间（「(单)1-8周(双)9-16周」）：它属于下一段，补逗号隔开
            if (/^\([单双]/.test(before.replace(/\s+$/, '').split(/[,\s]+/).pop())) return ',' + mark;
            return all;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            return digit + mark + (/^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '');
        });
        // 括号逐组处理：纯数字是序号、含非周次字是备注，都摘掉；其余保留内容；每组换成逗号
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
        // 第 2 步：剩下的空白当分段符
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
        // 单 / 双自己成段：并给最近的周次段（先向前找，再向后找）
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
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:-[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var from = parseInt(bounds[0], 10);
                var to = bounds.length > 1 ? parseInt(bounds[1], 10) : from;
                if (isNaN(from) || isNaN(to)) continue;
                if (to < from) { var swap = from; from = to; to = swap; }
                for (var week = from; week <= to; week++) {
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

    function unionWeeks(a, b) {
        var seenWeek = {};
        var out = [];
        var all = a.concat(b);
        for (var i = 0; i < all.length; i++) {
            if (seenWeek[all[i]]) continue;
            seenWeek[all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    // 周次集合 → 极大段：步长 1 为每周，步长 2 为单周 / 双周
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

    function weeksKey(weeks) {
        return weeks.join(',');
    }

    // ---------- 逐行转换 ----------
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var weekSamples = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    var entries = [];
    var entryByKey = {};

    // 逐周响应里同一条记录会在多个周重复出现：先按记录内容去重，再解析与计数，提醒里的计数才是「门 / 行」而不是「周」
    var rawSeen = {};
    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var rawKey = JSON.stringify([
            text(row.courseName), text(row.day), text(row.startSection), text(row.endSection),
            text(row.weeks), text(row.teacherName), text(row.classRoom)
        ]);
        if (rawSeen[rawKey]) continue;
        rawSeen[rawKey] = true;

        var name = text(row.courseName);
        if (!name) { missing.name++; continue; }

        var day = intOf(row.day);
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var start = intOf(row.startSection);
        var end = intOf(row.endSection);
        if (start === null || end === null || start < 1 || end < start || end > MAX_PERIOD) {
            missing.period++;
            continue;
        }

        var weeks = weeksOf(row.weeks);
        if (!weeks.length) {
            missing.week++;
            var sample = text(row.weeks);
            if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
            continue;
        }

        // 教师、教室没有就留空（null），照常导入，按课名计数后汇总写进提醒；占位文字（未知、暂无……）也当没有
        var teacher = realOrEmpty(row.teacherName);
        var location = realOrEmpty(row.classRoom);
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
            fieldSamples.push(name);
        }

        // 同一行在不同周重复出现（逐周请求的结果）：完全相同的节次与教室只留一条，周次取并集
        var key = JSON.stringify([name, teacher, location, day, start, end]);
        if (entryByKey[key]) {
            entryByKey[key].weeks = unionWeeks(entryByKey[key].weeks, weeks);
            continue;
        }
        entryByKey[key] = {
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            start: start,
            end: end,
            weeks: weeks
        };
        entries.push(entryByKey[key]);
    }

    // 相邻或重叠的节次、且周次集合相同 → 合并成一条（反复合并到不再变化，顺序无关）
    var merged = entries.slice(0);
    var changed = true;
    while (changed) {
        changed = false;
        for (var i = 0; i < merged.length && !changed; i++) {
            for (var j = i + 1; j < merged.length && !changed; j++) {
                var a = merged[i];
                var b = merged[j];
                if (a.name !== b.name || a.teacher !== b.teacher || a.location !== b.location || a.day !== b.day) continue;
                if (weeksKey(a.weeks) !== weeksKey(b.weeks)) continue;
                if (b.start > a.end + 1 || a.start > b.end + 1) continue;
                a.start = Math.min(a.start, b.start);
                a.end = Math.max(a.end, b.end);
                merged.splice(j, 1);
                changed = true;
            }
        }
    }

    // 课程按「课名 + 教师」归档，顺序取第一次出现的顺序
    var courses = [];
    var courseByKey = {};
    function courseOf(courseName, courseTeacher) {
        var key = JSON.stringify([courseName, courseTeacher || '']);
        if (!courseByKey[key]) {
            courseByKey[key] = { name: courseName, teacher: courseTeacher || null, note: null, blocks: [] };
            courses.push(courseByKey[key]);
        }
        return courseByKey[key];
    }

    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        var course = courseOf(item.name, item.teacher);
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

    for (var c = 0; c < courses.length; c++) {
        courses[c].blocks.sort(function (x, y) {
            return (x.dayOfWeek - y.dayOfWeek) || (x.startPeriod - y.startPeriod) || (x.startWeek - y.startWeek);
        });
    }

    if (!courses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开「课表」页面确认能看到课表后再试'
        );
    }

    // ---------- 开学日 / 总周数 ----------
    var start0 = estimateStart(isoOfAny(data.today) || localTodayIso());
    var firstDay = start0.iso;

    // 教务没有校历，周数按上游写死的 20 周；课表里更晚的周次必须放得下（endWeek 超过 totalWeeks 会被拒收），抬高时单独说明
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raised = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raised = true; }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    // ---------- 节次时间：上游写死的 12 节；课表用到更晚的节次，按 H3 顺推补，越过 23:59 的说明 ----------
    var periodTimes = SCHOOL_PERIOD_TIMES.slice(0);
    var extended = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        extended.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    var name0 = termName();
    // 教务原文拼进提醒前都截到 20 字（shortName），末尾的「请核对…」不能被硬截断吃掉
    if (term.picked === 'flag') {
        warn('导入的是教务系统标为当前的学期（' + shortName(name0) + '），请核对后再使用');
    } else if (term.picked === 'date') {
        warn(
            '教务系统没有标出当前学期，已按今天的日期选择导入 ' + shortName(term.yearLabel) + ' 学年第 ' +
            term.dateNo + ' 学期，请核对是不是要导入的学期'
        );
    } else if (term.picked === 'yearfallback') {
        warn(
            '没找到与今天日期对应的学年，已导入列表里的第一个学年 ' + shortName(term.yearLabel) + ' 学年第 ' +
            term.dateNo + ' 学期，请核对是不是要导入的学期'
        );
    } else {
        warn('没有标出当前学期，也对不上今天的日期，已取列表第一项「' + shortName(name0) + '」，请核对是不是要导入的学期');
    }

    if (!term.yearLabel || !termYear()) {
        warn('没有读出学年，开学日期按今天所在的周推算，请在学期管理里改成学校实际开学日');
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start0.rule + '」推算为 ' + firstDay +
            '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raised) {
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过默认的 ' + SCHOOL_TOTAL_WEEKS +
            ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期周数，学期总周数按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }
    if (data.capHit) {
        warn(
            '课表里出现第 ' + MAX_WEEK + ' 周及以后的课，本次最多取到第 ' + MAX_WEEK + ' 周，之后的周次没有导入，请核对'
        );
    }

    warn(
        '节次时间用的是学校的 12 节表（第 1 节 ' + SCHOOL_PERIOD_TIMES[0].start + '-' +
        SCHOOL_PERIOD_TIMES[0].end + '，第 12 节 ' + SCHOOL_PERIOD_TIMES[11].start + '-' +
        SCHOOL_PERIOD_TIMES[11].end + '），请在学期管理里核对是否与学校实际的节次时间一致'
    );

    if (extended.length) {
        warn(
            '课表用到了' + sectionsText(extended) + '，现有的节次时间没有覆盖，已按上一节下课后课间 5 分钟、' +
            '每节 45 分钟顺推补上，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    var failed = [];
    for (var fw = 0; fw < failedWeeks.length; fw++) {
        var weekNo = intOf(failedWeeks[fw]);
        if (weekNo !== null) failed.push(weekNo);
    }
    failed.sort(function (x, y) { return x - y; });
    if (failed.length) {
        warn(
            '第 ' + failed.join('、') + ' 周的课表没有取到（教务系统没有响应或返回错误），这几周的课可能不全，' +
            '请稍后重新提取一次'
        );
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 行');
        if (missing.period) reasons.push('缺节次（或节次超出 1-' + MAX_PERIOD + ' 节）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (weekSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push(shortName(weekSamples[ws]));
            reasons.push('认不出的周次写法如「' + sampleTexts.join('」「') + '」');
        }
        warn('有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') + '），已跳过，如发现少课请反馈');
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），按类型计数（按课名去重）并点名
    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownFieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownFieldNames.push(shortName(fieldSamples[fs]));
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + shownFieldNames.join('、') + '）：已照常导入，' +
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
        warn('有 ' + bothMarks + ' 处周次里「单」「双」同时出现（如「1-16周(单双周)」），已按每周都上处理，请核对');
    }

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
                name: name0,
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: courses
            }
        ]
    });
})()
