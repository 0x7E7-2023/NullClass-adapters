(function () {
    // 湖北民族大学教务适配器（jwgl.hbmzu.edu.cn/edu，自研 MVC 教务）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 HBMZU/hbmzu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Haooz）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 77e9b23
    //
    // 上游在同一段脚本里读表格、拼课程、拉实验课表、推开学日；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑）。
    // extract.js 交过来的是理论课表格子（星期 + 节次原文 + 各 span 原文）与实验课表按周的结果。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① span 归属：上游用「哪个 span 长得像周次」来定名 / 教室 / 周次 / 教师，这里照搬到 parse.js；
    //      比上游放宽了周次写法（多段、前置 / 后置单双、第1-第8周、共 N 周只剥备注）
    //   ② 周次切段：上游给的是周次数组，这里按手册 §4.1 切成极大段（连续 → 每周，隔周且同奇偶 → 单周 / 双周）
    //   ③ 合并：上游按「课名 + 教师 + 教室 + 星期 + 首末节」并周次；这里先做同样的并集，再把相邻节次
    //      （下一节首节不晚于上一节末节加一）且周次相同的段并成一段
    //   ④ 教师、教室缺了照常导入（null），按类型汇总写进提醒；上游缺哪个整门课就没了
    //   ⑤ 实验课表按周的结果：某一周没取到只写进提醒，理论课表照常导入；学号不在这里、也不进任何文字
    //   ⑥ 开学日：上游明确没有开学日期来源；这里按今天的日期回退到本周周一（手册 §4.2），并在提醒里说明是推算的
    //   ⑦ 总周数：上游从实验课表第 1 周取 totalWeeks 用来翻页，但不作为学期长度；这里按公共口径取 20，
    //      课表里出现更晚的周就抬高并提醒，最多 30
    //   ⑧ 节次时间：逐节照抄上游的 12 节表；课表用到表外的节次时按批次五统一修订 H3 逐节补齐并提醒
    //   ⑨ 学期名：实验入口页给了学年与学期就用它拼；拿不到按今天的日期推算，并冠上学校名（不用适配器名）
    //   ⑩ 上游的 showAlert / showToast / saveImportedCourses / savePresetTimeSlots / notifyTaskCompletion
    //      全部不移植，空课由宿主保存，适配器只交载荷
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var rows = data.rows instanceof Array ? data.rows : [];
    var labWeeks = data.labWeeks instanceof Array ? data.labWeeks : [];
    var labStatus = text(data.labStatus);
    var labReason = text(data.labReason);

    var SEP = String.fromCharCode(0);   // 复合键分隔符：源码里不出现控制字符、也不出现转义序列
    var MAX_WEEK = 30;                  // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;                // 单日节次上限：超过它一定是脏数据
    var SCHOOL_TOTAL_WEEKS = 20;        // 教务不给学期总周数，课表也排不满时的兜底
    var MAX_WARNINGS = 20;              // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;         // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;           // 提醒里点名的课名 / 原文最多显示的字数
    var EXTEND_BREAK_MINUTES = 5;       // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45;      // 节次时间补不上时顺推：每节几分钟
    var SCHOOL_NAME = '湖北民族大学';    // 学期名兜底用（拿不到学年学期时「学校名 + 学年学期」，不用适配器名）

    // 上游 HBMZU/hbmzu.js 的 HBMZU_TIME_SLOTS，逐节照抄原值（12 节，含午间 / 晚间）
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:50', end: '09:35' },
        { periodIndex: 3, start: '10:05', end: '10:50' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '14:00', end: '14:45' },
        { periodIndex: 6, start: '14:50', end: '15:35' },
        { periodIndex: 7, start: '16:05', end: '16:50' },
        { periodIndex: 8, start: '16:55', end: '17:40' },
        { periodIndex: 9, start: '18:30', end: '19:15' },
        { periodIndex: 10, start: '19:20', end: '20:05' },
        { periodIndex: 11, start: '20:15', end: '21:00' },
        { periodIndex: 12, start: '21:05', end: '21:50' }
    ];

    // 空课内置节次表（:core:model 的 DefaultPeriodTimes，12 节）：课表用到的节次超出所用的节次时间表时，
    // 内置表里有这一节、且开始不早于上一节下课，就用它的时间；接不上的按顺推补
    var BUILTIN_PERIOD_TIMES = [
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

    var KIND_CN = { 1: '一', 2: '二' };

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

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
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
    // 周次文本 → 周次集合（去重、升序）。上游只认「3-14周」「3-13单周」「4-14双周」，这里照批次十 swu 放宽，同时认：
    //   "1-16周" / "1-16周(单)" / "(单)1-8周,(双)9-16周" / "1-3,5-9周" / "17周" / "第1-第8周" / 全角数字与标点
    // 必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单 / 双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉；
    //      含非周次字的（"(3组)"）也摘掉，计数后写进 warnings；其它（"(1-16周)"、"(单)"）保留内容；
    //   ④ 空白两头都要顾：破折号连同两侧的空白先归一成半角 '-'，剩下的空白当分段符折成逗号。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单 / 双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3组)」）
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
            .replace(/[～~—－–至]/g, '-');
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 「共8周」是课程总周数备注，不是上课周次，只剥备注本身；不要照抄上游会吞掉后面真实周次的写法
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 紧挨周次的单 / 双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上；
        //   这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"，标记就跟着自己那一段走。
        //   前缀只认在段首：标记前面紧挨着数字或「周」（中间可有空白）时它是上一段的后缀
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return mark;
            // 夹在两段中间的标记：本段以前置标记开头时它是下一段的前缀，补逗号隔开；否则仍是上一段的后缀
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
        cleaned = cleaned.replace(/[()]/g, ',');   // 剩下落单的括号字符（没有闭合）也换成逗号
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
            // 「单」「双」都写了 = 每周都上；这是个判断不是事实，所以计数后写进 warnings
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

    // ---------- 节次原文 ----------
    // 「上午1-2节」「晚上11-12节」「第3节」「1~2节」→ 首末两节。认不出返回 null
    function parseSection(source) {
        var t = fullWidthToHalf(text(source));
        var m = /([0-9]+)\s*-\s*([0-9]+)/.exec(t);
        var start;
        var end;
        if (m) {
            start = parseInt(m[1], 10);
            end = parseInt(m[2], 10);
        } else {
            var nums = t.match(/[0-9]+/g) || [];
            if (!nums.length) return null;
            start = parseInt(nums[0], 10);
            end = parseInt(nums[nums.length - 1], 10);
        }
        if (start > end) { var swap = start; start = end; end = swap; }
        if (!(start >= 1) || !(end <= MAX_PERIOD)) return null;
        return { start: start, end: end };
    }

    // 某个 span 是不是周次文本：有数字，且带「周」或单 / 双标记；教室 / 楼 / 区 / 室 / 场 / 馆 一律不算
    function looksLikeWeeks(value) {
        var t = fullWidthToHalf(text(value)).replace(/\s+/g, '');
        if (!/[0-9]/.test(t)) return false;
        if (/[教楼室区场馆]/.test(t)) return false;
        return t.indexOf('周') >= 0 || t.indexOf('单') >= 0 || t.indexOf('双') >= 0;
    }

    // 教师 / 教室写成占位词的一律当没给（手册 §4.7：写「未知」会被课表当成真名显示）
    function placeholder(value) {
        return /^(未知|待定|暂无|无)(上课)?(教师|老师|教室|地点|校区)?$/.test(value);
    }

    // ---------- 逐条转换 ----------
    var entries = [];                     // 通过校验的上课安排（理论 + 实验）
    var missing = { name: 0, day: 0, period: 0, week: 0 };   // 理论课表被跳过的行
    var rowSamples = [];                  // 认不出的节次 / 周次原文，最多留 3 个
    var labMissing = { name: 0, day: 0, period: 0, week: 0 };
    var labFailedWeeks = [];              // 实验课表没取到的周
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];

    function addRowSample(value) {
        var sample = text(value);
        if (!sample || rowSamples.length >= 3 || rowSamples.indexOf(sample) >= 0) return;
        rowSamples.push(shortName(sample));
    }

    function acceptEntry(name, teacher, location, day, start, end, weeks) {
        if (placeholder(teacher)) teacher = '';
        if (placeholder(location)) location = '';
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
            fieldSamples.push(name);
        }
        entries.push({
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            start: start,
            end: end,
            weeks: weeks
        });
    }

    // 理论课表：首 span 是课名；从第 2 个 span 起找周次，它前一个是教室（没有就空）、后一个是教师（没有就空）。
    // 与上游一致；先按整行原文去重，再去计数与解析，免得同一格重复出现时提醒被放大
    var seenRows = {};
    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var spans = [];
        var rawSpans = row.spans instanceof Array ? row.spans : [];
        for (var s = 0; s < rawSpans.length; s++) {
            var span = text(rawSpans[s]);
            if (span) spans.push(span);
        }
        var rowKey = 'r' + JSON.stringify([intOf(row.day), text(row.section), spans]);
        if (seenRows[rowKey] === true) continue;
        seenRows[rowKey] = true;

        var day = intOf(row.day);
        if (!spans.length || !text(spans[0])) { missing.name++; continue; }
        if (!(day >= 1 && day <= 7)) { missing.day++; addRowSample(row.section); continue; }
        var section = parseSection(row.section);
        if (!section) { missing.period++; addRowSample(row.section); continue; }
        var weekIndex = -1;
        for (var w = 1; w < spans.length; w++) {
            if (looksLikeWeeks(spans[w])) { weekIndex = w; break; }
        }
        if (weekIndex < 0) { missing.week++; addRowSample(spans.join(' ')); continue; }
        var weeks = weeksOf(spans[weekIndex]);
        if (!weeks.length) { missing.week++; addRowSample(spans[weekIndex]); continue; }

        var location = weekIndex >= 2 ? text(spans[weekIndex - 1]) : '';
        var teacher = weekIndex + 1 < spans.length ? text(spans[weekIndex + 1]) : '';
        acceptEntry(text(spans[0]), teacher, location, day, section.start, section.end, weeks);
    }

    // 实验课表：每条 lesson 只认白名单字段；缺课名 / 星期 / 节次 / 周次计数后跳过。
    // 同一内容在多周响应里重复出现时先去重，避免提醒里的条数被放大
    var seenLab = {};
    for (var lw = 0; lw < labWeeks.length; lw++) {
        var weekItem = labWeeks[lw];
        if (!weekItem || typeof weekItem !== 'object') continue;
        var itemWeek = intOf(weekItem.week);
        if (weekItem.ok !== true) {
            if (itemWeek && itemWeek >= 1) labFailedWeeks.push(itemWeek);
            continue;
        }
        var lessons = weekItem.lessons instanceof Array ? weekItem.lessons : [];
        for (var l = 0; l < lessons.length; l++) {
            var lesson = lessons[l];
            if (!lesson || typeof lesson !== 'object') continue;
            var labName = text(lesson.name);
            var labDay = intOf(lesson.day);
            var labStart = intOf(lesson.start);
            var labPeriod = intOf(lesson.period);
            if (!(labPeriod >= 1)) labPeriod = 1;
            var labWeek = intOf(lesson.week);
            if (!(labWeek >= 1)) labWeek = itemWeek;
            var labKey = 'l' + JSON.stringify([labName, text(lesson.teacher), text(lesson.location), labDay, labStart, labPeriod, labWeek]);
            if (seenLab[labKey] === true) continue;
            seenLab[labKey] = true;

            if (!labName) { labMissing.name++; continue; }
            if (!(labDay >= 1 && labDay <= 7)) { labMissing.day++; continue; }
            var labEnd = labStart + labPeriod - 1;
            if (!(labStart >= 1) || !(labEnd <= MAX_PERIOD)) { labMissing.period++; continue; }
            if (!(labWeek >= 1)) { labMissing.week++; continue; }
            if (labWeek > MAX_WEEK) { droppedWeeks++; continue; }
            acceptEntry(labName, text(lesson.teacher), text(lesson.location), labDay, labStart, labEnd, [labWeek]);
        }
    }

    if (!entries.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开「理论课表」查询页面确认能看到课表后再试'
        );
    }

    // ---------- 合并与去重 ----------
    // 第一步与上游 mergeCourses 同口径：课名 + 教师 + 教室 + 星期 + 首末节相同的，周次取并集
    function unionWeeks(a, b) {
        var seen = {};
        var out = [];
        var i;
        for (i = 0; i < a.length; i++) {
            if (!seen[a[i]]) { seen[a[i]] = true; out.push(a[i]); }
        }
        for (i = 0; i < b.length; i++) {
            if (!seen[b[i]]) { seen[b[i]] = true; out.push(b[i]); }
        }
        out.sort(function (x, y) { return x - y; });
        return out;
    }

    var byLayout = {};
    var layoutOrder = [];
    for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        var layoutKey = 'u' + entry.name + SEP + entry.teacher + SEP + entry.location + SEP + entry.day + SEP + entry.start + SEP + entry.end;
        if (byLayout[layoutKey]) {
            byLayout[layoutKey].weeks = unionWeeks(byLayout[layoutKey].weeks, entry.weeks);
        } else {
            byLayout[layoutKey] = {
                name: entry.name,
                teacher: entry.teacher,
                location: entry.location,
                day: entry.day,
                start: entry.start,
                end: entry.end,
                weeks: entry.weeks.slice(0)
            };
            layoutOrder.push(layoutKey);
        }
    }

    // 第二步：同课名、同教师、同教室、同星期、同周次的相邻节次（首尾相接或重叠）并成一段。
    // 分组键含周次，单周段与双周段不会被并成「每周都上」
    var groups = {};
    var groupOrder = [];
    var merged = [];
    var gi;
    for (gi = 0; gi < layoutOrder.length; gi++) {
        var layout = byLayout[layoutOrder[gi]];
        var groupKey = 'g' + layout.name + SEP + layout.teacher + SEP + layout.location + SEP + layout.day + SEP + layout.weeks.join(',');
        if (!groups[groupKey]) {
            groups[groupKey] = [];
            groupOrder.push(groupKey);
        }
        groups[groupKey].push(layout);
    }
    for (gi = 0; gi < groupOrder.length; gi++) {
        var list = groups[groupOrder[gi]];
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

    function cmpText(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    function orderEntries(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end) ||
            cmpText(a.weeks.join(','), b.weeks.join(','));
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
    var term = data.term || {};
    var termYear = /^[0-9]{4}$/.test(text(term.year)) ? parseInt(text(term.year), 10) : 0;
    var termSemester = text(term.semester) === '1' ? 1 : (text(term.semester) === '2' ? 2 : 0);
    var fromPage = termYear > 0 && termSemester > 0;
    var effYear;
    var effKind;
    if (fromPage) {
        effYear = termYear;
        effKind = termSemester;
    } else {
        // 读不到学年学期：8 月到次年 1 月是第一学期，2 到 7 月是第二学期
        var todayYear = parseInt(todayIso.substring(0, 4), 10);
        var month = parseInt(todayIso.substring(5, 7), 10);
        if (month >= 8) { effYear = todayYear; effKind = 1; }
        else if (month <= 1) { effYear = todayYear - 1; effKind = 1; }
        else { effYear = todayYear - 1; effKind = 2; }
    }
    var name0 = (fromPage ? '' : SCHOOL_NAME + ' ') + effYear + '-' + (effYear + 1) + '学年第' + KIND_CN[effKind] + '学期';

    // 上游明确没有开学日期来源（脚本注释：无开学日期接口）；按今天的日期回退到本周周一，并如实说明
    var firstDay = mondayOf(todayIso) || todayIso;

    // 上游把实验课表第 1 周的 totalWeeks 当翻页上限；学期总周数按公共口径取 20，课表更晚才抬高
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    // ---------- 节次时间（逐节照抄上游；表外节次按 H3 补） ----------
    var periodTimes = [];
    for (var pt = 0; pt < PERIOD_TIMES.length; pt++) {
        periodTimes.push({ periodIndex: PERIOD_TIMES[pt].periodIndex, start: PERIOD_TIMES[pt].start, end: PERIOD_TIMES[pt].end });
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
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prev = periodTimes.length ? periodTimes[periodTimes.length - 1] : null;
        var prevEnd = prev ? minutesOf(prev.end) : -1;
        var builtinSlot = BUILTIN_PERIOD_TIMES[p - 1];
        // 内置表有这一节、且它的开始不早于上一节下课，才用内置时间（否则会和上一节重叠甚至倒挂）
        if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: p, start: builtinSlot.start, end: builtinSlot.end });
            fromBuiltin.push(p);
            continue;
        }
        // 否则从上一节下课后顺推：课间 5 分钟、每节 45 分钟；顺推越过 23:59 就停
        if (!prev) { uncoveredFrom = p; break; }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    if (fromPage) {
        warn(
            '只导入了教务系统里当前的学期（' + name0 +
            '）；要导入别的学期，请先在教务系统里切到那个学期，再点「提取课表」'
        );
    } else {
        warn(
            '没有从教务系统读到当前学期，已按今天的日期推算为 ' + name0 +
            '。如果这不是你要导入的学期，请先在教务系统里切到正确的学期，再点「提取课表」'
        );
    }

    warn(
        '开学日期教务系统没有给出，第 1 周已按今天所在那一周的周一（' + firstDay +
        '）推算，请在「学期管理」里核对成学校实际开学日'
    );

    if (raisedBySchedule) {
        warn(
            '教务系统没有给出学期总周数；课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS +
            ' 周，已按 ' + totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS + ' 周导入（课表里最晚排到第 ' + maxWeek +
            ' 周），如与实际不符可在学期管理里改'
        );
    }

    var firstSlot = PERIOD_TIMES[0];
    warn(
        '已按学校公布的节次时间导入（第 1 节 ' + firstSlot.start + '-' + firstSlot.end +
        '），请与实际上课时间核对，不一致可在学期管理里改'
    );

    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
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

    var skippedRows = missing.name + missing.day + missing.period + missing.week;
    if (skippedRows > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('星期认不出 ' + missing.day + ' 行');
        if (missing.period) reasons.push('节次认不出 ' + missing.period + ' 行');
        if (missing.week) reasons.push('周次认不出 ' + missing.week + ' 行');
        if (rowSamples.length) reasons.push('原文如「' + rowSamples.join('」「') + '」');
        warn(
            '有 ' + skippedRows + ' 行课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }

    var skippedLab = labMissing.name + labMissing.day + labMissing.period + labMissing.week;
    if (skippedLab > 0) {
        var labReasons = [];
        if (labMissing.name) labReasons.push('缺课程名 ' + labMissing.name + ' 条');
        if (labMissing.day) labReasons.push('星期认不出 ' + labMissing.day + ' 条');
        if (labMissing.period) labReasons.push('节次认不出 ' + labMissing.period + ' 条');
        if (labMissing.week) labReasons.push('周次认不出 ' + labMissing.week + ' 条');
        warn(
            '实验课表有 ' + skippedLab + ' 条记录信息不全（' + labReasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }

    if (labStatus === 'no-entry') {
        if (labReason === 'structure') {
            warn('实验课表没能打开（打开实验课表页时没找到学号、学年或学期，可能是登录过期或页面改版），这次只导入了理论课表，可在教务系统里打开实验课表后再试');
        } else {
            warn('实验课表没能打开（教务系统没有返回该页面），这次只导入了理论课表，可在教务系统里打开实验课表后再试');
        }
    } else if (labStatus === 'first-week-failed') {
        warn('实验课表第 1 周没有取到，这次没有导入实验课表，理论课表已照常导入');
        labFailedWeeks = [];
    }

    if (labFailedWeeks.length > 0) {
        labFailedWeeks.sort(function (a, b) { return a - b; });
        var weekSamples = [];
        for (var fw = 0; fw < labFailedWeeks.length && fw < 5; fw++) weekSamples.push(String(labFailedWeeks[fw]));
        var weekTail = labFailedWeeks.length > 5 ? ' 周等' : ' 周';
        warn(
            '实验课表有 ' + labFailedWeeks.length + ' 周没有取到（第 ' + weekSamples.join('、') + weekTail +
            '）：理论课表已照常导入，可在教务系统里重新打开实验课表后再试'
        );
    }

    if (data.labTruncated === true) {
        warn('实验课表只取到第 ' + MAX_WEEK + ' 周：教务给出的实验周数更多，后面的周没有导入，如发现少课请反馈');
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
