(function () {
    // 上海师范大学教务适配器（树维 EAMS 平台）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 SHNU/shnu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游 maintainer FaQxD233）
    //   上游快照 ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    //
    // 上游这一段的核心（移植保留）：
    //   ① 按 activity = new TaskActivity( 分块；教师取自本块**前一段**末尾的 actTeachers 名字
    //   ② 引号字段依次取课程名 [1]、位图 [4]（不符时找首个 0/1 串）、教室 [3]（位图前一项）
    //   ③ index = 星期 * unitCount + 节次（两个数都从 0 起算，各 +1）
    //   ④ 同课连续节次合并、同节次周次合并
    //
    // 移植改动（逐条对照 AUDIT.md §3）：
    //   ① ES6 → ES5；不做动态求值，不用集合类，也不用 Array 的静态方法
    //   ② 教师只从本活动前一段的 actTeachers 取名字（同上游）；取不到留空（null），不写「未知教师」（上游写「未知教师」）
    //   ③ 课程名只摘末尾一对 ASCII 括号（同上游），摘掉的次数写进 warnings
    //   ④ 教室去掉 ASCII 括号内容（同上游），去掉的次数写进 warnings；拿不到留空（null）
    //   ⑤ 周次位图下标即周次：第 0 位为 1 时跳过并计数；超过第 30 周的丢弃并计数（不截到 30）
    //   ⑥ unitCount：课表响应 → 页面 unitCountPage → 缺省 14；后两种都写进 warnings
    //   ⑦ 作息表是上游 SHNU_TIME_SLOTS 的 14 节，逐条照搬；课表用到更晚的节次时写进 warnings
    //   ⑧ 学期名用教务的「学年 + 第几学期」；缺失时用「上海师范大学 当前学期」并写进 warnings
    //   ⑨ 开学日取教务给的学期起始日期所在周的周一；取不到时按学期锚点推算（第一学期 9 月 1 日、第二学期 2 月 20 日所在周的周一），并写进 warnings
    //   ⑩ 不弹框、不推作息、不发桥调用（上游的 showToast / saveImportedCourses 等全部没移植）

    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var html = typeof data.courseTable === 'string' ? data.courseTable : '';
    var sem = data.semester && typeof data.semester === 'object' ? data.semester : null;
    var pageUnitCount = typeof data.unitCountPage === 'number' ? data.unitCountPage : null;

    var SEP = String.fromCharCode(0);   // 复合键分隔符：用 fromCharCode 取，源码里不出现控制字符
    var MAX_WEEK = 30;                  // 载荷校验：totalWeeks ∈ 1..30
    var MAX_PERIOD = 20;                // 单日节次上限：超过它一定是脏数据
    var DEFAULT_UNIT_COUNT = 14;        // 上游 SHNU/shnu.js 的缺省值
    var FALLBACK_TOTAL_WEEKS = 20;      // 教务没给学期结束日期时的总周数
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;

    // 上海师范大学作息：上游 SHNU/shnu.js 的 SHNU_TIME_SLOTS（14 节，逐条照搬）。
    // 上游没有向教务请求作息，这张表是脚本作者写死的值，所以必须写进 warnings（见 AUDIT.md §4）
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:50', end: '09:30' },
        { periodIndex: 3, start: '09:45', end: '10:30' },
        { periodIndex: 4, start: '10:35', end: '11:15' },
        { periodIndex: 5, start: '11:25', end: '12:10' },
        { periodIndex: 6, start: '13:00', end: '13:45' },
        { periodIndex: 7, start: '13:50', end: '14:30' },
        { periodIndex: 8, start: '14:45', end: '15:30' },
        { periodIndex: 9, start: '15:35', end: '16:15' },
        { periodIndex: 10, start: '16:25', end: '17:10' },
        { periodIndex: 11, start: '18:00', end: '18:45' },
        { periodIndex: 12, start: '18:50', end: '19:30' },
        { periodIndex: 13, start: '19:40', end: '20:25' },
        { periodIndex: 14, start: '20:30', end: '21:10' }
    ];

    var KIND_CN = { '1': '一', '2': '二', '3': '三', '4': '四' };
    var BASES = {
        current: '教务学期日历标出的当前学期',
        date: '起止日期包含今天的那个学期',
        latest: '起始日期最晚的那个学期',
        last: '学期列表里的最后一项',
        page: '课表页上当前选中的学期'
    };

    // 计数器：每一种「没导进来 / 改了写法」的情况都数一次，最后统一写进 warnings（不静默丢）
    var counts = {
        skipArgs: 0,      // TaskActivity 引号字段不足 5 个
        noName: 0,        // 课程名为空
        noBitmap: 0,      // 找不到周次位图
        zeroBit: 0,       // 位图第 0 位为 1（占位符，忽略）
        outWeeks: 0,      // 周次超过 30（丢弃）
        emptyBitmap: 0,   // 位图没有可导入的周次
        noIndex: 0,       // 课程块里没有 index 定位
        stray: 0,         // 星期或节次超出范围
        parenCourse: 0,   // 课程名末尾括号被摘掉
        parenPlace: 0     // 教室括号内容被去掉
    };

    // ---------- 小工具 ----------
    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function isoOfAny(value) {
        var m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function epochOfIso(iso) {
        return Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        );
    }

    // 所在周的周一（周一为一周之始）
    function mondayOfIso(iso) {
        var epoch = epochOfIso(iso);
        var offset = (new Date(epoch).getUTCDay() + 6) % 7;
        return isoOf(new Date(epoch - offset * 86400000));
    }

    function cmpNum(a, b) {
        return a === b ? 0 : (a < b ? -1 : 1);
    }

    // 上游 SHNU_TIME_SLOTS 的时间都已是合法 HH:mm；这里仍逐条校验，不合法的节次直接丢弃
    function validSlot(slot) {
        var re = /^([01]\d|2[0-3]):([0-5]\d)$/;
        if (!re.test(slot.start) || !re.test(slot.end)) return false;
        return slot.start < slot.end;
    }

    // ---------- 课程名 / 教室 里的括号 ----------
    // 课程名：只摘末尾一对 ASCII 括号（上游 courseName.replace(/\([^)]*\)\s*$/, "")）
    function courseNameOf(raw) {
        var name = text(raw);
        var stripped = text(name.replace(/\([^)]*\)\s*$/, ''));
        if (stripped && stripped !== name) counts.parenCourse++;
        return stripped;
    }

    // 教室：去掉 ASCII 括号内容（上游 position.replace(/\(.*?\)/g, "")）；去完为空则留空
    function placeOf(raw) {
        var place = text(raw);
        var stripped = text(place.replace(/\([^)]*\)/g, ''));
        if (stripped !== place) counts.parenPlace++;
        return stripped;
    }

    // ---------- 教师：只从本活动前一段的 actTeachers 取 ----------
    function teacherOf(prevBlock) {
        var names = [];
        var re;
        var m;
        var assigns = prevBlock.match(/actTeachers\s*=\s*\[[\s\S]*?\]/g);
        if (assigns && assigns.length) {
            re = /name\s*:\s*"([^"]*)"/g;
            while ((m = re.exec(assigns[assigns.length - 1])) !== null) names.push(text(m[1]));
        }
        if (!names.length) {
            var elems = prevBlock.match(/actTeachers\[\d+\]\s*=\s*\{[^}]*\}/g) || [];
            var k;
            for (k = 0; k < elems.length; k++) {
                re = /name\s*:\s*"([^"]*)"/g;
                while ((m = re.exec(elems[k])) !== null) names.push(text(m[1]));
            }
        }
        var kept = [];
        var i;
        for (i = 0; i < names.length; i++) {
            if (names[i]) kept.push(names[i]);
        }
        return kept.length ? kept.join(',') : null;
    }

    // ---------- 周次位图：下标即周次，下标 0 是占位符 ----------
    function weeksOf(bitmap) {
        var weeks = [];
        var i;
        for (i = 0; i < bitmap.length; i++) {
            if (bitmap.charAt(i) !== '1') continue;
            if (i === 0) {
                counts.zeroBit++;
                continue;
            }
            if (i > MAX_WEEK) {
                counts.outWeeks++;
                continue;
            }
            weeks.push(i);
        }
        if (!weeks.length) counts.emptyBitmap++;
        return weeks;
    }

    // ---------- 解析课表 HTML 里的 TaskActivity ----------
    function readUnitCount(source) {
        var m = /unitCount\s*=\s*(\d{1,3})/.exec(source);
        if (!m) return null;
        var n = parseInt(m[1], 10);
        return n >= 1 && n <= 60 ? n : null;
    }

    function parseTaskActivities(source, unitCount) {
        var lessons = [];
        var blocks = source.split(/activity\s*=\s*new\s+TaskActivity\s*\(/);
        var i;
        var j;
        for (i = 1; i < blocks.length; i++) {
            var block = blocks[i];
            var teacher = teacherOf(blocks[i - 1]);

            var argsMatch = /^([\s\S]*?)\)\s*;/.exec(block);
            if (!argsMatch) {
                counts.skipArgs++;
                continue;
            }
            var raws = argsMatch[1].match(/"([^"]*)"/g) || [];
            var quoted = [];
            for (j = 0; j < raws.length; j++) quoted.push(raws[j].substring(1, raws[j].length - 1));
            if (quoted.length < 5) {
                counts.skipArgs++;
                continue;
            }

            var name = courseNameOf(quoted[1]);
            if (!name) {
                counts.noName++;
                continue;
            }

            // 位图：优先第 5 个引号字段；不符时取首个形如 0/1 串（6 位以上）的字段
            var bitmapIdx = 4;
            if (!/^[01]+$/.test(quoted[4])) {
                bitmapIdx = -1;
                for (j = 0; j < quoted.length; j++) {
                    if (/^[01]{6,}$/.test(quoted[j])) {
                        bitmapIdx = j;
                        break;
                    }
                }
                if (bitmapIdx < 0) {
                    counts.noBitmap++;
                    continue;
                }
            }
            var place = quoted[3] || '';
            if (bitmapIdx > 0 && bitmapIdx !== 4) place = quoted[bitmapIdx - 1] || place;
            var location = placeOf(place) || null;

            var weeks = weeksOf(quoted[bitmapIdx]);
            if (!weeks.length) continue;

            // 定位：index = 星期 * unitCount + 节次;（上游只认这一种写法）
            var idxRegex = /index\s*=\s*(\d+)\s*\*\s*unitCount\s*\+\s*(\d+)\s*;/g;
            var located = 0;
            var m;
            while ((m = idxRegex.exec(block)) !== null) {
                located++;
                var day = parseInt(m[1], 10) + 1;
                var period = parseInt(m[2], 10) + 1;
                if (day < 1 || day > 7 || period < 1 || period > MAX_PERIOD) {
                    counts.stray++;
                    continue;
                }
                lessons.push({ name: name, teacher: teacher, location: location, day: day, period: period, weeks: weeks });
            }
            if (!located) counts.noIndex++;
        }
        return lessons;
    }

    // ---------- 同课连续节次合并（逻辑同上游 mergeContinuousLessons，换成确定性的数组写法） ----------
    function addBlock(blockMap, blockOrder, group, start, end, week) {
        var key = group.name + SEP + (group.teacher || '') + SEP + (group.location || '') + SEP +
            group.day + SEP + start + SEP + end;
        if (!blockMap[key]) {
            blockMap[key] = {
                name: group.name,
                teacher: group.teacher,
                location: group.location,
                day: group.day,
                startPeriod: start,
                endPeriod: end,
                weeks: []
            };
            blockOrder.push(key);
        }
        if (blockMap[key].weeks.indexOf(week) < 0) blockMap[key].weeks.push(week);
    }

    function mergeLessons(lessons) {
        var groups = {};
        var order = [];
        var i;
        var j;
        var k;
        for (i = 0; i < lessons.length; i++) {
            var lesson = lessons[i];
            var gkey = lesson.name + SEP + (lesson.teacher || '') + SEP + (lesson.location || '') + SEP + lesson.day;
            if (!groups[gkey]) {
                groups[gkey] = { name: lesson.name, teacher: lesson.teacher, location: lesson.location, day: lesson.day, items: [] };
                order.push(gkey);
            }
            groups[gkey].items.push(lesson);
        }
        order.sort();

        var out = [];
        for (i = 0; i < order.length; i++) {
            var group = groups[order[i]];
            // 第 N 周 → 这一周上这门课占的节次（数组下标即节次）
            var cells = {};
            var weekNos = [];
            for (j = 0; j < group.items.length; j++) {
                var item = group.items[j];
                for (k = 0; k < item.weeks.length; k++) {
                    var w = item.weeks[k];
                    if (!cells[w]) {
                        cells[w] = [];
                        weekNos.push(w);
                    }
                    cells[w][item.period] = true;
                }
            }
            weekNos.sort(cmpNum);

            var blockMap = {};
            var blockOrder = [];
            for (j = 0; j < weekNos.length; j++) {
                var row = cells[weekNos[j]];
                var p = 1;
                while (p <= MAX_PERIOD) {
                    if (!row[p]) {
                        p++;
                        continue;
                    }
                    var start = p;
                    while (p + 1 <= MAX_PERIOD && row[p + 1]) p++;
                    addBlock(blockMap, blockOrder, group, start, p, weekNos[j]);
                    p++;
                }
            }
            for (j = 0; j < blockOrder.length; j++) out.push(blockMap[blockOrder[j]]);
        }
        return out;
    }

    // 周次集合 → 极大段：步长 1 是每周，步长 2 是单/双周
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

    // ---------- 主流程 ----------
    var unitCount = readUnitCount(html);
    var unitCountSource = 'response';
    if (!unitCount && pageUnitCount && pageUnitCount >= 1 && pageUnitCount <= 60) {
        unitCount = pageUnitCount;
        unitCountSource = 'page';
    }
    if (!unitCount) {
        unitCount = DEFAULT_UNIT_COUNT;
        unitCountSource = 'default';
    }

    var merged = mergeLessons(parseTaskActivities(html, unitCount));

    var courseMap = {};
    var courseOrder = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    var i2;
    for (i2 = 0; i2 < merged.length; i2++) {
        var entry = merged[i2];
        var ckey = entry.name + SEP + (entry.teacher || '');
        if (!courseMap[ckey]) {
            courseMap[ckey] = { name: entry.name, teacher: entry.teacher || null, note: null, blocks: [], seen: {} };
            courseOrder.push(ckey);
        }
        var course = courseMap[ckey];
        var runList = runsOf(entry.weeks);
        var r;
        for (r = 0; r < runList.length; r++) {
            var run = runList[r];
            if (run.end > maxWeek) maxWeek = run.end;
            if (entry.endPeriod > maxPeriod) maxPeriod = entry.endPeriod;
            var bkey = entry.day + '|' + entry.startPeriod + '|' + entry.endPeriod + '|' +
                run.start + '|' + run.end + '|' + run.weekType + '|' + (entry.location || '');
            if (course.seen[bkey]) continue;
            course.seen[bkey] = true;
            course.blocks.push({
                dayOfWeek: entry.day,
                startPeriod: entry.startPeriod,
                endPeriod: entry.endPeriod,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: entry.location
            });
        }
    }
    courseOrder.sort();

    var courses = [];
    for (i2 = 0; i2 < courseOrder.length; i2++) {
        var built = courseMap[courseOrder[i2]];
        built.blocks.sort(function (a, b) {
            return cmpNum(a.dayOfWeek, b.dayOfWeek) || cmpNum(a.startPeriod, b.startPeriod) ||
                cmpNum(a.endPeriod, b.endPeriod) || cmpNum(a.startWeek, b.startWeek);
        });
        courses.push({ name: built.name, teacher: built.teacher, note: null, blocks: built.blocks });
    }

    if (!courses.length) {
        throw new Error(
            '没有从教务返回的课表里解析出课程（响应 ' + html.length + ' 个字符）：' +
            '可能这个学期还没排课，也可能登录状态已失效。请重新登录、在教务页面里确认能看到课表后再点「提取课表」'
        );
    }

    // ---------- 开学日推算（没有学期起始日期时才用，同模板 tjau；手册 §4.2） ----------
    // 第一学期取 9 月 1 日、第二学期取 2 月 20 日，所在周的周一作为第 1 周。
    // 学年优先取教务的 schoolYear；学期序号（rawName 为 1 / 2，或含「第一学期」「第二学期」）读不出时，
    // 按提取当天的月份判断：2–7 月为第二学期，其余为第一学期
    function todayOf(value) {
        var iso = isoOfAny(value);
        if (iso) return iso;
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function anchorOf(semester) {
        var label = semester ? text(semester.rawName) : '';
        var year = semester ? text(semester.schoolYear) : '';
        var today = todayOf(data.today);
        var todayYear = parseInt(today.substring(0, 4), 10);
        var todayMonth = parseInt(today.substring(5, 7), 10);
        var kind = '';
        if (label === '1' || label.indexOf('第一学期') >= 0) kind = '1';
        if (label === '2' || label.indexOf('第二学期') >= 0) kind = '2';
        var term = 1;
        if (kind === '2' || (!kind && todayMonth >= 2 && todayMonth <= 7)) term = 2;
        var schoolStart = /^[0-9]{4}/.test(year) ? parseInt(year.substring(0, 4), 10) : 0;
        var startYear;
        if (schoolStart) {
            startYear = term === 2 ? schoolStart + 1 : schoolStart;
        } else if (term === 2) {
            startYear = todayMonth >= 8 ? todayYear + 1 : todayYear;
        } else {
            startYear = todayMonth >= 8 ? todayYear : todayYear - 1;
        }
        var anchor = startYear + (term === 2 ? '-02-20' : '-09-01');
        var basis = schoolStart ? '学年 ' + year : '提取当天 ' + today;
        if (!kind) basis += '，学期序号没有读到，按提取当天的月份判断';
        return {
            monday: mondayOfIso(anchor),
            rule: term === 2 ? '第二学期 2 月 20 日' : '第一学期 9 月 1 日',
            basis: basis
        };
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var calendarStart = sem ? isoOfAny(sem.startDate) : null;
    var calendarEnd = sem ? isoOfAny(sem.endDate) : null;
    var anchorInfo = null;
    var firstDay;
    if (calendarStart) {
        firstDay = mondayOfIso(calendarStart);
    } else {
        anchorInfo = anchorOf(sem);
        firstDay = anchorInfo.monday;
    }

    var termName = null;
    if (sem) {
        var label = text(sem.rawName);
        var year = text(sem.schoolYear);
        if (label && label.indexOf('学期') >= 0) {
            termName = label;
        } else if (year && KIND_CN[label]) {
            termName = year + '学年第' + KIND_CN[label] + '学期';
        }
    }
    var nameFallback = termName === null;
    if (nameFallback) termName = '上海师范大学 当前学期';

    var calendarWeeks = 0;
    if (calendarEnd) {
        var days = Math.floor((epochOfIso(calendarEnd) - epochOfIso(firstDay)) / 86400000) + 1;
        calendarWeeks = Math.ceil(days / 7);
    }
    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var clampedWeeks = false;
    if (totalWeeks > MAX_WEEK) {
        totalWeeks = MAX_WEEK;
        clampedWeeks = true;
    }
    var raisedWeeks = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raisedWeeks = true;
    }

    // ---------- 作息时间 ----------
    var periodTimes = [];
    var badSlots = 0;
    var i3;
    for (i3 = 0; i3 < SCHOOL_PERIOD_TIMES.length; i3++) {
        var slot = SCHOOL_PERIOD_TIMES[i3];
        if (!validSlot(slot)) {
            badSlots++;
            continue;
        }
        periodTimes.push({ periodIndex: slot.periodIndex, start: slot.start, end: slot.end });
    }
    var tableLength = SCHOOL_PERIOD_TIMES.length;

    // ---------- warnings ----------
    var warnings = [];

    function warn(message) {
        var line = String(message);
        if (line.length > MAX_WARNING_CHARS) line = line.substring(0, MAX_WARNING_CHARS - 1) + '…';
        warnings.push(line);
    }

    warn(
        '只导入了教务系统的一个学期（' + termName + '，按' +
        (sem && BASES[sem.source] ? BASES[sem.source] : '课表页上当前选中的学期') +
        '自动选中）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」'
    );
    if (nameFallback) {
        warn('教务没有给出学年与学期名，学期名暂用「上海师范大学 当前学期」，请在学期管理里改成实际名称');
    }
    if (anchorInfo) {
        warn(
            '教务没有给出开学日期，开学日按「' + anchorInfo.rule + '」推算（依据' + anchorInfo.basis + '）：' +
            '所在周的周一为 ' + firstDay + '，不是教务给的，请在学期管理里核对成学校实际开学日'
        );
    } else {
        warn('开学日期取自教务给的学期起始日期（' + calendarStart + '）所在周的周一：' + firstDay + '，请在学期管理里核对成学校实际开学日');
    }
    if (calendarWeeks > 0) {
        warn('学期总周数用的是教务给出的学期起止日期（' + calendarWeeks + ' 周），如与实际不符可在学期管理里改');
    } else {
        warn('教务没有给出学期结束日期，学期总周数暂用 ' + FALLBACK_TOTAL_WEEKS + ' 周，请在学期管理里核对');
    }
    if (clampedWeeks) {
        warn('按教务给的起止日期算，学期超过了 ' + MAX_WEEK + ' 周，已按 ' + MAX_WEEK + ' 周导入，如学校学期更长请在学期管理里改');
    }
    if (raisedWeeks) {
        warn('课表里有第 ' + maxWeek + ' 周的课，学期总周数已提高到 ' + totalWeeks + ' 周，请在学期管理里核对');
    }
    warn(
        '作息时间用的是应用内置的上海师范大学 ' + tableLength + ' 节作息表（不是从教务系统读的），' +
        '如与学校实际作息不符请在学期管理里改'
    );
    if (unitCountSource === 'page') {
        warn('课表页没写每天有几节课，已按页面上的 ' + unitCount + ' 节换算课程所在的星期和节次，请核对课表是否错位');
    } else if (unitCountSource === 'default') {
        warn('课表页没写每天有几节课，已按 ' + DEFAULT_UNIT_COUNT + ' 节换算课程所在的星期和节次，请核对课表是否错位');
    }
    if (counts.skipArgs > 0) {
        warn('有 ' + counts.skipArgs + ' 条课程安排的数据格式和预期不符，这些课没有导进来，请反馈');
    }
    if (counts.noName > 0) {
        warn('有 ' + counts.noName + ' 条课程安排没有课程名，这些课没有导进来，请反馈');
    }
    if (counts.noBitmap > 0) {
        warn('有 ' + counts.noBitmap + ' 条课程安排找不到周次信息，这些课没有导进来，请反馈');
    }
    if (counts.noIndex > 0) {
        warn('有 ' + counts.noIndex + ' 条课程安排没有能识别的上课时间，这些课没有导进来，请反馈');
    }
    if (counts.stray > 0) {
        warn('有 ' + counts.stray + ' 条课程安排的星期或节次超出范围，已跳过，请反馈');
    }
    if (counts.zeroBit > 0) {
        warn('有 ' + counts.zeroBit + ' 条课程安排的周次里出现了第 0 周，已忽略，请核对这些课的周次');
    }
    if (counts.outWeeks > 0) {
        warn('有 ' + counts.outWeeks + ' 处课超出了学期最多 ' + MAX_WEEK + ' 周（第 ' + (MAX_WEEK + 1) + ' 周及以后），已略去，请核对');
    }
    if (counts.emptyBitmap > 0) {
        warn('有 ' + counts.emptyBitmap + ' 条课程安排没有可导入的周次，这些课已跳过');
    }
    if (counts.parenCourse > 0) {
        warn('有 ' + counts.parenCourse + ' 个课程名末尾的括号已摘掉（例如「高等数学(1)」→「高等数学」），请核对');
    }
    if (counts.parenPlace > 0) {
        warn('有 ' + counts.parenPlace + ' 个教室名里的括号内容已去掉（例如「综合楼B101(东)」→「综合楼B101」），请核对');
    }
    if (maxPeriod > tableLength) {
        warn(
            '课表里用到第 ' + maxPeriod + ' 节，但作息时间只到第 ' + tableLength + ' 节，' +
            '第 ' + (tableLength + 1) + ' 节及之后没有时间，请在学期管理里补上'
        );
    }
    if (badSlots > 0) {
        warn('作息时间里有 ' + badSlots + ' 节的时间格式不对，已忽略这些节次，请反馈');
    }

    if (warnings.length > MAX_WARNINGS) {
        warnings = warnings.slice(0, MAX_WARNINGS - 1);
        warnings.push('另有说明因为超出上限没有显示，请把这份课表反馈给我们');
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
                courses: courses
            }
        ]
    });
})()
