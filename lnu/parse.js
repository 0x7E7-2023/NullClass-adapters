(function () {
    // 辽宁大学 教务适配器（URP 综合教务系统）—— 第二步：原始数据 → 空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 LNU/LNU_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 739C1AE2）
    //   上游快照 1dc0772（2026-10-17）；本校脚本最后一次修改 94c2bea（2026-08-30）、b0f05f7（2026-09-05）
    //
    // 输入是 extract.js 交来的 JSON 字符串（__ncInput）：
    //   { fetchedDate, term: { text, value, isDefault } | null, campus: "extract" | "chongshan" | "puhe" | "wusheng" | null,
    //     rq: "YYYYMMDD" | null, skzc: "数字串" | null, errorMessage, courses: [...], slots: [...] | null }
    //
    // 移植改动（相对上游脚本，逐条对应 AUDIT.md）：
    //   ① 周次：以 classWeek 位串为准（下标 i 为第 i+1 周）；位串缺失时退回 weekDescription 的文字写法（逗号分段，单双周各段自判）。
    //   ② 连续节数：上游缺失时当 2 节，照上游做，但计数写进提醒（这是推算的）。
    //   ③ 教师：照上游 cleanTeacher（* 换成空格、合并空白、去首尾）；空着就是 null（上游写「未知」）。
    //   ④ 教室：照上游 buildPosition（楼名、教室名以校区名开头时去掉重复的校区前缀），再加一步：教室名以楼名开头时去掉重复的楼名；全空就是 null（上游写「待定」）。
    //   ⑤ 作息：崇山 / 蒲河 / 武圣三张内置表逐节照抄上游；选「从教务提取」用教务的 jcsjbs；没选成按课程的校区名猜；都不行就不交节次时间。
    //   ⑥ 学期名：取教务下拉框选中项的文字；没有的话用「学校名 + 推算的学年学期」，并提醒。
    //   ⑦ 开学日与总周数：只在选中的是服务端默认学期（或没有下拉框）时用校历的 rq / skzc；否则不用，推算并提醒。
    //   ⑧ 节次超出作息表时逐节补齐（统一修订 H3，口径同 haut）：空课默认表里同一节不早于上一节下课就用它，否则顺推；补了哪些都写进提醒。
    //   ⑨ 去重：课名、教师、星期、节次、周次、教室完全相同的安排只留一条。
    //
    // 本文件是纯函数：同样的 __ncInput 永远得到同样的输出（CI 用 Rhino 跑它对 fixture）。
    var input = JSON.parse(__ncInput);
    if (!input || typeof input !== 'object') input = {};

    var MAX_TERM_WEEKS = 30;      // 规范：totalWeeks 必须落在 1..30
    var DEFAULT_TOTAL_WEEKS = 20;
    var DEFAULT_CONTINUING = 2;   // 上游：连续节数缺失时当 2 节
    var NAME_LIST_LIMIT = 3;      // 提醒里最多点名几门课
    var NAME_TEXT_LIMIT = 20;     // 提醒里每个课名最多显示的字数（超出截断并以「…」结尾）
    var MAX_WARNING_TEXT = 200;   // 单条提醒上限 200 字（载荷校验超了就整包拒收）
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;

    var CAMPUS_NAMES = { chongshan: '崇山校区', puhe: '蒲河校区', wusheng: '武圣校区' };
    var CAMPUS_KEYWORDS = { chongshan: '崇山', puhe: '蒲河', wusheng: '武圣' };

    // 节次时间：逐节照抄上游 CHONGSHAN_TIME_SLOTS / PUHE_TIME_SLOTS / WUSHENG_TIME_SLOTS
    var CHONGSHAN_PERIODS = [
        { periodIndex: 1, start: '08:00', end: '08:50' },
        { periodIndex: 2, start: '09:00', end: '09:50' },
        { periodIndex: 3, start: '10:10', end: '11:00' },
        { periodIndex: 4, start: '11:10', end: '12:00' },
        { periodIndex: 5, start: '13:30', end: '14:20' },
        { periodIndex: 6, start: '14:30', end: '15:20' },
        { periodIndex: 7, start: '15:40', end: '16:30' },
        { periodIndex: 8, start: '16:40', end: '17:30' },
        { periodIndex: 9, start: '18:00', end: '18:50' },
        { periodIndex: 10, start: '19:00', end: '19:50' },
        { periodIndex: 11, start: '20:10', end: '21:00' },
        { periodIndex: 12, start: '21:10', end: '22:00' }
    ];

    var PUHE_PERIODS = [
        { periodIndex: 1, start: '08:30', end: '09:15' },
        { periodIndex: 2, start: '09:20', end: '10:05' },
        { periodIndex: 3, start: '10:25', end: '11:10' },
        { periodIndex: 4, start: '11:15', end: '12:00' },
        { periodIndex: 5, start: '13:30', end: '14:15' },
        { periodIndex: 6, start: '14:20', end: '15:05' },
        { periodIndex: 7, start: '15:25', end: '16:10' },
        { periodIndex: 8, start: '16:15', end: '17:00' },
        { periodIndex: 9, start: '17:30', end: '18:15' },
        { periodIndex: 10, start: '18:20', end: '19:05' },
        { periodIndex: 11, start: '19:25', end: '20:10' },
        { periodIndex: 12, start: '20:15', end: '21:00' }
    ];

    var WUSHENG_PERIODS = [
        { periodIndex: 1, start: '08:00', end: '08:50' },
        { periodIndex: 2, start: '09:00', end: '09:50' },
        { periodIndex: 3, start: '10:10', end: '11:00' },
        { periodIndex: 4, start: '11:10', end: '12:00' },
        { periodIndex: 5, start: '13:30', end: '14:20' },
        { periodIndex: 6, start: '14:30', end: '15:20' },
        { periodIndex: 7, start: '15:30', end: '16:20' },
        { periodIndex: 8, start: '16:30', end: '17:20' },
        { periodIndex: 9, start: '18:00', end: '18:50' },
        { periodIndex: 10, start: '19:00', end: '19:50' },
        { periodIndex: 11, start: '20:10', end: '21:00' },
        { periodIndex: 12, start: '21:10', end: '22:00' }
    ];

    // H3 的空课默认节次表（与 haut 同一份），只用于课表节次超出作息表时逐节补齐
    var BUILTIN_PERIODS = [
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

    var warnings = [];
    // 每一条都限长：超过 200 字截断并以「…」结尾（条数上限 20 另计）
    function pushWarning(message) {
        if (warnings.length >= 20) return;
        var line = String(message);
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        warnings.push(line);
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function parseIsoDate(value) {
        var match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(textOf(value));
        if (!match) return null;
        var date = new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10));
        if (isNaN(date.getTime())) return null;
        return date;
    }

    // 校历的 YYYYMMDD：不合法（比如 20261340）就是 null
    function parseCompactDate(value) {
        var s = textOf(value);
        if (!/^\d{8}$/.test(s)) return null;
        var year = parseInt(s.substring(0, 4), 10);
        var month = parseInt(s.substring(4, 6), 10);
        var day = parseInt(s.substring(6, 8), 10);
        var date = new Date(year, month - 1, day);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
        return date;
    }

    // 第 1 周从「开学日所在周的周一」起算（空课的 firstDay 就是这么用的）
    function mondayOf(date) {
        var offset = (date.getDay() + 6) % 7;   // 周一=0 … 周日=6
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 教务没有学年学期时：按提取日期落在哪一学期命名（2–7 月算第二学期，8 月–次年 1 月算第一学期）。是推算值，写进提醒。
    function inferTermName(date) {
        var year = date.getFullYear();
        var month = date.getMonth() + 1;
        if (month >= 2 && month <= 7) return (year - 1) + '-' + year + '学年第二学期';
        return year + '-' + (year + 1) + '学年第一学期';
    }

    function weeksFromBits(bits) {
        var weeks = [];
        for (var i = 0; i < bits.length; i++) {
            if (bits.charAt(i) === '1') weeks.push(i + 1);
        }
        return weeks;
    }

    // "1-16周" / "1,3,5周" / "1-16周(双)" / "2-6周,10周"：按逗号（含全角）分段，单双周标志只在它自己那一段里生效
    function weeksFromText(source) {
        var weeks = [];
        var segments = textOf(source).split(/[,，;；]/);
        for (var i = 0; i < segments.length; i++) {
            var segment = segments[i];
            var onlyOdd = segment.indexOf('单') >= 0;
            var onlyEven = segment.indexOf('双') >= 0;
            var range = /(\d{1,2})\s*[-—~至]\s*(\d{1,2})/.exec(segment);
            if (range) {
                var start = parseInt(range[1], 10);
                var end = parseInt(range[2], 10);
                for (var w = start; w <= end; w++) {
                    if (onlyOdd && w % 2 === 0) continue;
                    if (onlyEven && w % 2 === 1) continue;
                    weeks.push(w);
                }
            } else {
                var single = /(\d{1,2})/.exec(segment);
                if (!single) continue;
                var one = parseInt(single[1], 10);
                if (onlyOdd && one % 2 === 0) continue;
                if (onlyEven && one % 2 === 1) continue;
                weeks.push(one);
            }
        }
        return weeks;
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

    // 周次集合 → 极大段：相邻差 1 视作每周，相邻差 2 视作单 / 双周
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j], weekType: 'ALL' };
            if (run.start !== run.end && step === 2) {
                run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
            }
            runs.push(run);
            i = j + 1;
        }
        return runs;
    }

    // 周次：以 classWeek 位串为准；位串缺失才退回 weekDescription（先当位串，再当文字写法）
    function weeksOf(place) {
        var bits = textOf(place.classWeek);
        if (/^[01]+$/.test(bits)) return uniqueSorted(weeksFromBits(bits));
        var desc = textOf(place.weekDescription);
        if (/^[01]{4,}$/.test(desc)) return uniqueSorted(weeksFromBits(desc));
        return uniqueSorted(weeksFromText(desc));
    }

    // 上游 cleanTeacher：* 换成空格、合并空白、去首尾；空着就是 null
    function cleanTeacher(value) {
        var s = textOf(value).replace(/\*/g, ' ');
        s = textOf(s);
        return s || null;
    }

    // 上游 buildPosition：楼名、教室名以校区名开头时去掉重复的校区前缀，再拼「校区 + 楼 + 教室」；全空就是 null
    function buildPosition(campus, building, room) {
        var campusPart = textOf(campus);
        var buildingPart = textOf(building);
        var roomPart = textOf(room);
        if (campusPart && buildingPart.indexOf(campusPart) === 0) {
            buildingPart = buildingPart.substring(campusPart.length);
        }
        if (campusPart && roomPart.indexOf(campusPart) === 0) {
            roomPart = roomPart.substring(campusPart.length);
        }
        // 教室名以楼名开头时，去掉教室名里重复的楼名（「文科楼101」在「文科楼」里只留「101」）
        if (buildingPart && roomPart.indexOf(buildingPart) === 0) {
            roomPart = roomPart.substring(buildingPart.length);
        }
        return textOf(campusPart + buildingPart + roomPart) || null;
    }

    // "0810" → "08:10"；"080000" → "08:00"；已经是 "08:10" 就原样返回
    function formatClock(value) {
        var s = textOf(value);
        if (!s || s.indexOf(':') >= 0) return s;
        if (/^\d{4}$/.test(s) || /^\d{6}$/.test(s)) return s.substring(0, 2) + ':' + s.substring(2, 4);
        return s;
    }

    function minutesOf(clock) {
        var match = /^(\d{1,2}):(\d{2})$/.exec(clock);
        if (!match) return -1;
        return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    }

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    // 教务的节次时间（jcsjbs）：读不出来的节次跳过并计数
    function buildSlotPeriods(slots) {
        var times = [];
        var broken = 0;
        if (!isArray(slots)) return { times: times, broken: 0 };
        for (var i = 0; i < slots.length; i++) {
            var slot = slots[i] || {};
            var index = intOf(slot.jc);
            var start = formatClock(slot.kssj);
            var end = formatClock(slot.jssj);
            var okStart = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(start);
            var okEnd = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(end);
            if (!(index >= 1) || !okStart || !okEnd || minutesOf(start) >= minutesOf(end)) {
                broken++;
                continue;
            }
            times.push({ periodIndex: index, start: start, end: end });
        }
        times.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        return { times: times, broken: broken };
    }

    // 上游 guessCampus 的口径：数各条安排的校区名，出现最多的那个决定校区（猜不出 → null）
    function guessCampus(courses) {
        var counts = {};
        for (var c = 0; c < courses.length; c++) {
            var places = courses[c].timeAndPlaceList || [];
            for (var p = 0; p < places.length; p++) {
                var campus = textOf(places[p].campusName);
                if (campus) counts[campus] = (counts[campus] || 0) + 1;
            }
        }
        var best = null;
        var bestCount = 0;
        var names = Object.keys(counts);
        for (var n = 0; n < names.length; n++) {
            if (counts[names[n]] > bestCount) {
                best = names[n];
                bestCount = counts[names[n]];
            }
        }
        if (!best) return null;
        var codes = ['chongshan', 'puhe', 'wusheng'];
        for (var i = 0; i < codes.length; i++) {
            if (best.indexOf(CAMPUS_KEYWORDS[codes[i]]) >= 0) return codes[i];
        }
        return null;
    }

    // 课名过长时截短，避免一个超长课名就把整条提醒撑破上限
    function shortName(name) {
        return name.length > NAME_TEXT_LIMIT ? name.substring(0, NAME_TEXT_LIMIT - 1) + '…' : name;
    }

    function nameList(names) {
        var shown = names.slice(0, NAME_LIST_LIMIT).map(shortName).join('、');
        if (names.length > NAME_LIST_LIMIT) return shown + ' 等 ' + names.length + ' 门';
        return shown;
    }

    // 节次号写成「9-12」「9」「9、11-12」：连续的合成一段，单节不写成「9-9」
    function sectionsText(list) {
        var parts = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            parts.push(j > i ? list[i] + '-' + list[j] : String(list[i]));
            i = j + 1;
        }
        return parts.join('、');
    }

    var apiError = textOf(input.errorMessage);
    if (apiError) throw new Error('教务系统返回：' + apiError);

    var fetched = parseIsoDate(input.fetchedDate);
    if (!fetched) fetched = new Date();   // extract.js 一定会带上提取日期；手写输入时按当天算

    var rawCourses = isArray(input.courses) ? input.courses : [];
    var byCourse = {};
    var order = [];
    var noSlotNames = [];         // 教务没排上课时间地点
    var brokenNames = [];         // 有安排，但星期 / 节次 / 周次读不出来
    var brokenPlaces = 0;
    var guessedNames = [];       // 没写连续节数、按 2 节算的课
    var guessedPlaces = 0;
    var droppedBlocks = 0;        // 周次越界、整条被丢掉的安排
    var clippedBlocks = 0;        // 周次越界、被截断的安排
    var droppedCourses = [];      // 截断后一条安排都不剩的课

    for (var k = 0; k < rawCourses.length; k++) {
        var course = rawCourses[k];
        if (!course || typeof course !== 'object') continue;
        var name = textOf(course.courseName);
        if (!name) continue;

        var places = isArray(course.timeAndPlaceList) ? course.timeAndPlaceList : [];
        if (!places.length) {
            if (noSlotNames.indexOf(name) < 0) noSlotNames.push(name);
            continue;
        }

        var teacher = cleanTeacher(course.attendClassTeacher);
        var key = name + String.fromCharCode(0) + (teacher || '');
        var blocks = [];
        var seen = {};

        for (var p = 0; p < places.length; p++) {
            var place = places[p] || {};
            var weeks = weeksOf(place);
            var day = intOf(place.classDay);
            var startPeriod = intOf(place.classSessions);
            if (!weeks.length || !(day >= 1 && day <= 7) || !(startPeriod >= 1)) {
                brokenPlaces++;
                continue;
            }
            var length = intOf(place.continuingSession);
            if (!(length >= 1)) {
                length = DEFAULT_CONTINUING;
                guessedPlaces++;
                if (guessedNames.indexOf(name) < 0) guessedNames.push(name);
            }
            var endPeriod = startPeriod + length - 1;
            var location = buildPosition(place.campusName, place.teachingBuildingName, place.classroomName);

            // 同课名、同教师、同星期、同节次、同周次、同教室的安排只留一条
            var placeKey = day + '|' + startPeriod + '|' + endPeriod + '|' + weeks.join(',') + '|' + (location || '');
            if (seen[placeKey]) continue;
            seen[placeKey] = true;

            var runs = runsOf(weeks);
            for (var r = 0; r < runs.length; r++) {
                blocks.push({
                    dayOfWeek: day,
                    startPeriod: startPeriod,
                    endPeriod: endPeriod,
                    startWeek: runs[r].start,
                    endWeek: runs[r].end,
                    weekType: runs[r].weekType,
                    location: location
                });
            }
        }

        if (!blocks.length) {
            if (brokenNames.indexOf(name) < 0) brokenNames.push(name);
            continue;
        }
        if (!byCourse[key]) {
            byCourse[key] = { name: name, teacher: teacher, note: null, blocks: [] };
            order.push(key);
        }
        for (var b = 0; b < blocks.length; b++) byCourse[key].blocks.push(blocks[b]);
    }

    if (!order.length) {
        if (brokenPlaces) {
            throw new Error('没有解析出任何课程：' + brokenPlaces +
                ' 条安排的星期、节次或周次读不出来，教务系统可能改了数据格式');
        }
        if (noSlotNames.length) {
            throw new Error('没有解析出任何课程：' + noSlotNames.length +
                ' 门课还没有排上课时间地点，等排课完成后再提取');
        }
        throw new Error('没有解析出任何课程：这个学期里没有查到你的课，' +
            '请确认所选学期有课，且页面停在课表页');
    }

    // 最大周次（截断之前）
    var maxWeek = 0;
    for (var c = 0; c < order.length; c++) {
        var courseBlocks = byCourse[order[c]].blocks;
        for (var i = 0; i < courseBlocks.length; i++) {
            if (courseBlocks[i].endWeek > maxWeek) maxWeek = courseBlocks[i].endWeek;
        }
    }

    // ---------- 学期：学期名、开学日、总周数 ----------
    var term = input.term && typeof input.term === 'object' ? input.term : null;
    // 没有下拉框 = 服务端默认就是当前学期；有下拉框则要看选中的是不是写了 selected 的那一项
    var termIsDefault = !term || term.isDefault === true;

    var termText = term ? textOf(term.text) : '';
    var termInferred = !termText;
    var termName = termText || ('辽宁大学 ' + inferTermName(fetched));

    var rqDate = parseCompactDate(input.rq);
    var calendarDate = termIsDefault ? rqDate : null;
    var rejectedRq = !termIsDefault && rqDate ? isoOf(rqDate) : null;
    var firstDay = isoOf(mondayOf(calendarDate || fetched));

    var skzc = termIsDefault ? intOf(input.skzc) : null;
    var calendarWeeks = skzc >= 1 && skzc <= MAX_TERM_WEEKS ? skzc : 0;

    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : (maxWeek >= 1 ? maxWeek : DEFAULT_TOTAL_WEEKS);
    var raisedBySchedule = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    var clamped = false;
    if (totalWeeks > MAX_TERM_WEEKS) { totalWeeks = MAX_TERM_WEEKS; clamped = true; }

    // ---------- 作息时间：选的校区 → 教务的 → 猜的 ----------
    var slotInfo = buildSlotPeriods(input.slots);
    var extractPeriods = slotInfo.times.length ? slotInfo.times : null;
    var chosen = null;
    if (input.campus === 'extract' || input.campus === 'chongshan' ||
        input.campus === 'puhe' || input.campus === 'wusheng') {
        chosen = input.campus;
    }
    var guessed = guessCampus(rawCourses);
    var tableCode = null;
    var source = 'none';
    if (chosen && chosen !== 'extract') {
        tableCode = chosen;
        source = 'chosen';
    } else if (chosen === 'extract') {
        source = 'extract';
    } else if (guessed) {
        tableCode = guessed;
        source = 'guessed';
    } else {
        source = 'fallback';
    }

    var periodTimes = null;
    if (tableCode) {
        periodTimes = (tableCode === 'chongshan' ? CHONGSHAN_PERIODS :
            (tableCode === 'puhe' ? PUHE_PERIODS : WUSHENG_PERIODS)).slice(0);
    } else if (extractPeriods) {
        periodTimes = extractPeriods.slice(0);
    }

    // 课表用到的最大节次
    var maxPeriod = 0;
    for (var c2 = 0; c2 < order.length; c2++) {
        var sectionBlocks = byCourse[order[c2]].blocks;
        for (var s = 0; s < sectionBlocks.length; s++) {
            if (sectionBlocks[s].endPeriod > maxPeriod) maxPeriod = sectionBlocks[s].endPeriod;
        }
    }

    // ---------- 节次超出作息表：逐节补齐（H3） ----------
    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    var lastIndex = periodTimes && periodTimes.length ? periodTimes[periodTimes.length - 1].periodIndex : 0;
    if (periodTimes) {
        for (var q = lastIndex + 1; q <= maxPeriod; q++) {
            var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
            var builtin = BUILTIN_PERIODS[q - 1];
            if (builtin && minutesOf(builtin.start) >= prevEnd) {
                periodTimes.push({ periodIndex: q, start: builtin.start, end: builtin.end });
                fromBuiltin.push(q);
                continue;
            }
            var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
            var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
            if (nextEnd > 23 * 60 + 59) { uncoveredFrom = q; break; }
            periodTimes.push({ periodIndex: q, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
            bySequence.push(q);
        }
    }

    // ---------- 截断与裁掉越界的安排 ----------
    var courses = [];
    for (var ci = 0; ci < order.length; ci++) {
        var course2 = byCourse[order[ci]];
        var kept = [];
        for (var bi = 0; bi < course2.blocks.length; bi++) {
            var block = course2.blocks[bi];
            if (block.startWeek > totalWeeks) {
                droppedBlocks++;
                continue;
            }
            if (block.endWeek > totalWeeks) {
                block.endWeek = totalWeeks;
                clippedBlocks++;
            }
            kept.push(block);
        }
        if (!kept.length) {
            droppedCourses.push(course2.name);
            continue;
        }
        course2.blocks = kept;
        courses.push(course2);
    }
    if (!courses.length) {
        throw new Error('课表里的安排周次都落在第 ' + totalWeeks + ' 周之后，无法放进一张课表');
    }

    // ---------- 提醒（顺序固定：学期、时间、补的、丢的） ----------
    if (rqDate && calendarDate) {
        var rqIso = isoOf(rqDate);
        if (rqIso !== firstDay) {
            pushWarning('教务给的开学日期（' + rqIso + '）不是周一，已对齐到当周周一 ' + firstDay +
                ' 作为第 1 周开始，请在「学期管理」里核对成学校实际开学日');
        } else {
            pushWarning('开学日期取自教务系统的校历：第 1 周从 ' + firstDay + ' 开始，请在「学期管理」里核对成学校实际开学日');
        }
    } else if (rejectedRq) {
        pushWarning('教务校历给出的开学日期（' + rejectedRq + '）不属于所选学期，已忽略；第 1 周按提取当天 ' +
            isoOf(fetched) + ' 所在周的周一推算为 ' + firstDay + '，请在「学期管理」里核对成学校实际开学日');
    } else {
        pushWarning('教务系统没有给出开学日期，第 1 周按提取当天 ' + isoOf(fetched) + ' 所在周的周一推算为 ' +
            firstDay + '，请在「学期管理」里核对成学校实际开学日');
    }

    if (termInferred) {
        pushWarning('学期名是推算的：教务没有给出学年学期，已按提取当天 ' + isoOf(fetched) + ' 推为「' +
            termName + '」，如与实际不符可在导入后重命名');
    }

    if (clamped) {
        pushWarning('课表里有第 ' + maxWeek + ' 周的课，超过了空课支持的最多 ' + MAX_TERM_WEEKS + ' 周，学期总周数按 ' +
            MAX_TERM_WEEKS + ' 周导入，超出的周次见后面的提醒');
    } else if (calendarWeeks > 0 && !raisedBySchedule) {
        pushWarning('学期总周数取自教务系统的校历（' + totalWeeks + ' 周），如与实际不符可在「学期管理」里改');
    } else if (raisedBySchedule && calendarWeeks > 0) {
        pushWarning('课表里有第 ' + maxWeek + ' 周的课，超过教务给的 ' + calendarWeeks + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入（否则第 ' + (calendarWeeks + 1) + ' 周起的课放不下），如与实际不符可在「学期管理」里改');
    } else if (!termIsDefault) {
        pushWarning('学期总周数按课表里出现的最大周次（' + maxWeek + ' 周）推定：教务给的周数只对应当前学期，' +
            '与所选学期对不上，已忽略；校历周数不同的话可在「学期管理」里改');
    } else {
        pushWarning('学期总周数按课表里出现的最大周次（' + maxWeek + ' 周）推定，教务没有给出总周数；' +
            '校历周数不同的话可在「学期管理」里改');
    }

    if (source === 'chosen') {
        pushWarning('节次时间用的是你选的「' + CAMPUS_NAMES[tableCode] + '」内置作息表，请在「学期管理」里核对是否与学校作息一致');
    } else if (source === 'guessed') {
        pushWarning('没能确定你所在的校区，已按课程的上课地点猜是「' + CAMPUS_NAMES[tableCode] +
            '」，节次时间用这个校区的内置作息表，猜错的话请在「学期管理」里改');
    } else if (source === 'extract' && periodTimes) {
        pushWarning('节次时间用的是教务系统给出的作息表，请在「学期管理」里核对是否与学校作息一致');
    } else if (source === 'extract') {
        pushWarning('你选的是教务系统给出的节次时间，但教务没有给出可用的时间，这份课表将按应用默认的节次时间显示，请在「学期管理」里设置节次时间');
    } else if (periodTimes) {
        pushWarning('没能确定你所在的校区，也猜不出，节次时间用教务系统给出的作息表，请在「学期管理」里核对');
    } else {
        pushWarning('没能确定你所在的校区，教务系统也没有给出可用的节次时间，这份课表将按应用默认的节次时间显示，请在「学期管理」里设置节次时间');
    }
    if (slotInfo.broken) {
        pushWarning('教务返回的作息时间里有 ' + slotInfo.broken + ' 节的时间格式读不出来，已跳过该节；其余照常，请在导入后核对上课时间');
    }

    if (fromBuiltin.length || bySequence.length) {
        var covered = [];
        if (fromBuiltin.length) covered.push('第 ' + sectionsText(fromBuiltin) + ' 节用空课默认作息');
        if (bySequence.length) {
            covered.push('第 ' + sectionsText(bySequence) + ' 节按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        }
        pushWarning('课表用到了作息表里没有的第 ' + (lastIndex + 1) +
            (maxPeriod > lastIndex + 1 ? '-' + maxPeriod : '') + ' 节，已补上时间：' +
            covered.join('，') + '，请在「学期管理」里核对');
    }
    if (uncoveredFrom) {
        pushWarning('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }

    if (guessedPlaces) {
        pushWarning('有 ' + guessedPlaces + ' 条安排没有写连续节数，已按连续 ' + DEFAULT_CONTINUING +
            ' 节导入（这是推算的），涉及：' + nameList(guessedNames) + '，请核对这些课的节次');
    }
    if (noSlotNames.length) {
        pushWarning('教务系统对 ' + noSlotNames.length + ' 门课还没有排上课时间地点（通常是还没排课），' +
            '已跳过：' + nameList(noSlotNames));
    }
    if (brokenNames.length || brokenPlaces) {
        var pieces = [];
        if (brokenNames.length) {
            pieces.push('有 ' + brokenNames.length + ' 门课一条安排都没解析出来，已跳过：' + nameList(brokenNames));
        }
        if (brokenPlaces) {
            pieces.push('另有 ' + brokenPlaces + ' 条安排的星期、节次或周次读不出来，已忽略');
        }
        pushWarning(pieces.join('；'));
    }
    if (clippedBlocks || droppedBlocks || droppedCourses.length) {
        var clipDetail = [];
        if (clippedBlocks) clipDetail.push(clippedBlocks + ' 条安排的周次被截断到第 ' + totalWeeks + ' 周');
        if (droppedBlocks) clipDetail.push(droppedBlocks + ' 条安排整条落在第 ' + totalWeeks + ' 周之后，已丢弃');
        if (droppedCourses.length) clipDetail.push('课程：' + nameList(droppedCourses));
        pushWarning('有安排的周次超出了空课支持的最大 ' + MAX_TERM_WEEKS + ' 周：' +
            clipDetail.join('，') + '，请核对教务里的周次写法');
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
                periodTimes: periodTimes || [],
                courses: courses
            }
        ]
    });
})()
