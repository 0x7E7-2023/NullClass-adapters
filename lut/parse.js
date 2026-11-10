(function () {
    // 兰州理工大学教务适配器（金智 jwapp / 我的课表 wdkb）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 LUT/LUT.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Colton）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945，本校脚本最后一次修改 f1de9c2。
    // 输入是 extract.js 的 { term, today, rows }；每行只有 KCM / SKJS / JASMC / SKXQ / KSJC / JSJC / ZCMC。
    //
    // 移植改动：
    //   1. ZCMC 是周次文本：认「全周」「全部」、单 / 双标记（前置、后置、无逗号前置）、
    //      数字与「至 / 到 / 短横线」区间、逗号多段、「第 1-第 8 周」、「共 N 周」备注；
    //      全周行等全部行读完再展开到 max(默认 20 周, 其余行出现的最大周)，不参与「更晚抬高」。
    //   2. 按段判单双：单 / 双标记只跟它自己那一段，不退化成一整学期每周都上。
    //   3. 同课同教师同地点同星期同节次取周次并集；完全重复的行先去重再计数；连堂不合并。
    //   4. 学期只有教务给的 DM，没有开学日与总周数：开学日按本机日期所在周的周一推算，
    //      总周数默认 20 周，课表更晚才抬高，均如实写进提醒。
    //   5. 节次时间逐节照上游 10 节表；更晚节次按统一修订 H3 补并提醒。
    //   6. 提醒原文截 20 字，统一出口限制为 20 条、每条 200 字。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var SCHOOL = '兰州理工大学';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;

    // 上游 LUT_TIME_SLOTS，逐节照抄
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:50' },
        { periodIndex: 2, start: '09:00', end: '09:50' },
        { periodIndex: 3, start: '10:10', end: '11:00' },
        { periodIndex: 4, start: '11:10', end: '12:00' },
        { periodIndex: 5, start: '14:30', end: '15:20' },
        { periodIndex: 6, start: '15:30', end: '16:20' },
        { periodIndex: 7, start: '16:40', end: '17:30' },
        { periodIndex: 8, start: '17:40', end: '18:30' },
        { periodIndex: 9, start: '19:30', end: '20:20' },
        { periodIndex: 10, start: '20:30', end: '21:20' }
    ];

    // 空课自己的 12 节表，只在 H3 补节次时参考（同一节的开始不早于上一节下课才用它）
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

    var EMPTY_WORD = {
        '未知': true, '未知教师': true, '未知老师': true, '未知地点': true, '未知教室': true,
        '待定': true, '暂无': true, '暂无教师': true, '暂无老师': true, '暂无教室': true, '暂无地点': true
    };
    var XQ_CN = { '1': '一', '2': '二', '3': '三' };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function shortName(value) {
        var line = text(value);
        return line.length > NAME_LIMIT ? line.substring(0, NAME_LIMIT - 1) + '…' : line;
    }

    function realOrNull(value) {
        var valueText = text(value);
        return !valueText || EMPTY_WORD[valueText] ? null : valueText;
    }

    function integerOf(value) {
        if (value === null || value === undefined || text(value) === '') return null;
        var number = Number(value);
        if (!isFinite(number) || Math.floor(number) !== number) return null;
        return number;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    function utcOfIso(iso) {
        var match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(iso);
        if (!match) return null;
        var year = parseInt(match[1], 10);
        var month = parseInt(match[2], 10);
        var day = parseInt(match[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
        return date.getTime();
    }

    function mondayOf(iso) {
        var milliseconds = utcOfIso(iso);
        if (milliseconds === null) return null;
        var date = new Date(milliseconds);
        var offset = (date.getUTCDay() + 6) % 7;
        return isoOf(new Date(milliseconds - offset * 86400000));
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    function countKeys(dictionary) {
        var count = 0;
        for (var key in dictionary) {
            if (Object.prototype.hasOwnProperty.call(dictionary, key)) count++;
        }
        return count;
    }

    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) {
            droppedWarnings++;
            return;
        }
        warnings.push(line);
    }

    function termName() {
        var dm = text(term.dm);
        var match = /^([0-9]{4})-([0-9]{4})-([0-9]+)$/.exec(dm);
        if (match && XQ_CN[match[3]]) return match[1] + '-' + match[2] + '学年第' + XQ_CN[match[3]] + '学期';
        return text(SCHOOL + ' ' + dm);
    }

    // ---------- 周次文本 ----------
    var droppedWeeks = 0;   // 超出 1..30 被丢掉的周次个数
    var fullWeekRows = 0;   // 写了「全周 / 全部」的行数
    var bothMarks = 0;      // 同一段里单、双都写了（按每周都上处理，要说出来）
    var noteGroups = 0;     // 周次括号里认不出的备注个数
    var noteSample = '';

    function pushWeeks(into, start, end, oddOnly, evenOnly) {
        if (!(start >= 1) || !(end >= start)) return;
        for (var week = start; week <= end; week++) {
            if (oddOnly && week % 2 === 0) continue;
            if (evenOnly && week % 2 === 1) continue;
            if (week > MAX_WEEK) { droppedWeeks++; continue; }
            if (into.indexOf(week) < 0) into.push(week);
        }
    }

    function sortedWeeks(list) {
        return list.sort(function (a, b) { return a - b; });
    }

    // 上游的「全周 / 全部」：范围要等其他行都读完再定（见 fullAnchor）
    function isFullWeek(source) {
        var cleaned = text(source);
        return cleaned.indexOf('全周') >= 0 || cleaned.indexOf('全部') >= 0;
    }

    function weeksOf(source) {
        var cleaned = text(source);
        if (!cleaned) return [];
        // 全角数字与全角括号先归一，各种逗号统一
        cleaned = cleaned.replace(/[０-９]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
        });
        cleaned = cleaned.replace(/[，、；;]/g, ',');
        // 方括号里的是节次之类的附加信息，整段去掉
        cleaned = cleaned.replace(/\[[^\]]*\]|【[^】]*】/g, ' ');
        // 「共 N 周」只是备注，只剥备注本身，不吞后面的周次段
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, ' ');
        // 括号逐组看：括号里本身是周次的（(1-16周)、（第1-16周）、(1-16)）去掉括号、保留里面的周次；
        // 纯数字 / 数字逗号列表是教学班序号，整组去掉；单 / 双标记整组保留；其余是备注，去掉并计数
        cleaned = cleaned.replace(/[（(]([^）)]*)[)）]/g, function (whole, inner) {
            var body = text(inner);
            if (!body) return ' ';
            var bare = body.replace(/[周週第]/g, '').replace(/\s+/g, '');
            if (!bare) return ' ';
            var weekLike = /^[0-9]{1,3}([-～~—－–至到,，、][0-9]{1,3})*$/.test(bare);
            if (weekLike && (/[周週第]/.test(body) || /[-～~—－–至到]/.test(bare))) return ',' + body + ',';
            if (weekLike) return ' ';
            if (/^[单双周週]+$/.test(body)) return whole;
            noteGroups++;
            if (!noteSample) noteSample = shortName(whole);
            return ' ';
        });
        // 无逗号的前置单双：「(单)1-8周(双)9-16周」里第二个标记归下一段，前面补逗号；
        // 本段不是以前置标记开头时不动（那是后置标记，留给下一步）
        cleaned = cleaned.replace(/[（(]([单双])周?[)）](?=\s*[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9周]\s*$/.test(before)) return all;
            var segment = before.replace(/\s+$/, '').split(/[\s,，、;；]+/).pop();
            if (segment && /^[（(][单双]/.test(segment)) return ',' + all;
            return all;
        });
        // 无逗号的后置单双：「1-8周(单)9-16周(双)」标记跟前面那一段，并补逗号隔开下一段
        cleaned = cleaned.replace(/([0-9])\s*周?\s*[（(]([单双])周?[)）](?=\s*[0-9])/g, '$1$2,');
        // 区间符号两边数字后面的「周」先去掉（「第1周至第8周」「1周至8周」），
        // 否则「周」要到后面才换成逗号，区间会被拆成两个单周
        cleaned = cleaned.replace(/([0-9])\s*周\s*(?=[-～~—－–至到])/g, '$1');
        // 区间符号统一成半角短横线
        cleaned = cleaned.replace(/[～－−–—~至到]/g, '-');
        // 「第1-第8周」终点前的「第」只是量词
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        cleaned = cleaned.replace(/([0-9])\s*-\s*([0-9])/g, '$1-$2');
        cleaned = cleaned.replace(/第/g, '');
        // 「周」只是量词，换成逗号，免得两段周次数字粘在一起；单双标记所在括号留到分段后再归位
        cleaned = cleaned.replace(/周/g, ',');
        // 一个数字都没有（例如只写「单周」）：按整学期过滤单双，与上游一致
        if (!/[0-9]/.test(cleaned)) {
            var onlyOdd0 = cleaned.indexOf('单') >= 0;
            var onlyEven0 = cleaned.indexOf('双') >= 0;
            if (!onlyOdd0 && !onlyEven0) return [];
            var weeks0 = [];
            pushWeeks(weeks0, 1, MAX_WEEK, onlyOdd0, onlyEven0);
            return weeks0;
        }
        var tokens = cleaned.replace(/\s+/g, ',').split(/,+/);
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
            if (into < 0) { segments[i] = ''; continue; }
            segments[into] = segments[into] + segments[i];
            segments[i] = '';
        }
        var weeks = [];
        for (i = 0; i < segments.length; i++) {
            var segment = segments[i];
            if (!segment || !/[0-9]/.test(segment)) continue;
            var onlyOdd = segment.indexOf('单') >= 0;
            var onlyEven = segment.indexOf('双') >= 0;
            if (onlyOdd && onlyEven) {
                bothMarks++;
                onlyOdd = false;
                onlyEven = false;
            }
            var found = segment.match(/[0-9]+(?:-[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) {
                    var swap = start;
                    start = end;
                    end = swap;
                }
                pushWeeks(weeks, start, end, onlyOdd, onlyEven);
            }
        }
        return sortedWeeks(weeks);
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
        var seen = {};
        var out = [];
        var all = a.concat(b);
        for (var i = 0; i < all.length; i++) {
            if (seen[all[i]]) continue;
            seen[all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

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

    // ---------- 逐行转换 ----------
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var weekSamples = [];
    var slots = {};
    var slotList = [];
    var seenRows = {};
    var pendingFull = [];   // 写了「全周 / 全部」的行，等全部行读完后按锚点展开
    var maxNonFullWeek = 0;
    var maxPeriod = 0;

    function rememberFieldSample(name) {
        if (fieldSamples.length >= 3 || fieldSamples.indexOf(name) >= 0) return;
        fieldSamples.push(name);
    }

    function rememberWeekSample(source) {
        if (weekSamples.length >= 3) return;
        var line = shortName(source);
        if (weekSamples.indexOf(line) >= 0) return;
        weekSamples.push(line);
    }

    function addSlot(name, teacher, location, day, startPeriod, endPeriod, weeks) {
        var slotKey = JSON.stringify([name, teacher || '', location || '', day, startPeriod, endPeriod]);
        var slot = slots[slotKey];
        if (!slot) {
            slot = { name: name, teacher: teacher, location: location, day: day,
                start: startPeriod, end: endPeriod, weeks: [] };
            slots[slotKey] = slot;
            slotList.push(slot);
        }
        slot.weeks = unionWeeks(slot.weeks, weeks);
    }

    // 教师 / 教室的缺失只统计真正导入的行（含全周行）；因缺周次被跳过的行不算
    function rememberFields(name, teacher, location) {
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if (!teacher || !location) rememberFieldSample(name);
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var rowKey = JSON.stringify([text(row.KCM), text(row.SKJS), text(row.JASMC), text(row.SKXQ),
            text(row.KSJC), text(row.JSJC), text(row.ZCMC)]);
        if (seenRows[rowKey]) continue;
        seenRows[rowKey] = true;

        var name = text(row.KCM);
        if (!name || name === '未知' || name === '未知课程') {
            missing.name++;
            continue;
        }
        var day = integerOf(row.SKXQ);
        if (!(day >= 1 && day <= 7)) {
            missing.day++;
            continue;
        }
        var startPeriod = integerOf(row.KSJC);
        var endPeriod = integerOf(row.JSJC);
        if (!(startPeriod >= 1 && endPeriod >= startPeriod && endPeriod <= MAX_PERIOD)) {
            missing.period++;
            continue;
        }
        var teacher = realOrNull(row.SKJS);
        var location = realOrNull(row.JASMC);

        if (isFullWeek(row.ZCMC)) {
            rememberFields(name, teacher, location);
            pendingFull.push({ name: name, teacher: teacher, location: location, day: day,
                start: startPeriod, end: endPeriod });
            continue;
        }
        var weeks = weeksOf(row.ZCMC);
        if (!weeks.length) {
            missing.week++;
            if (text(row.ZCMC)) rememberWeekSample(row.ZCMC);
            continue;
        }
        rememberFields(name, teacher, location);
        if (weeks[weeks.length - 1] > maxNonFullWeek) maxNonFullWeek = weeks[weeks.length - 1];
        addSlot(name, teacher, location, day, startPeriod, endPeriod, weeks);
    }

    // 「全周」的范围 = max(默认 20 周, 其余行出现的最大周)；全周行不参与「课表更晚」的判断
    var fullAnchor = DEFAULT_WEEKS;
    if (maxNonFullWeek > fullAnchor) fullAnchor = maxNonFullWeek;
    fullWeekRows = pendingFull.length;
    for (var q = 0; q < pendingFull.length; q++) {
        var fullWeeks = [];
        pushWeeks(fullWeeks, 1, fullAnchor, false, false);
        addSlot(pendingFull[q].name, pendingFull[q].teacher, pendingFull[q].location,
            pendingFull[q].day, pendingFull[q].start, pendingFull[q].end, fullWeeks);
    }

    // 上游响应顺序不固定；按星期、开始节次、课名排序，连堂仍是不同段
    slotList.sort(function (a, b) {
        if (a.day !== b.day) return a.day - b.day;
        if (a.start !== b.start) return a.start - b.start;
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        if (a.end !== b.end) return a.end - b.end;
        var placeA = a.location || '';
        var placeB = b.location || '';
        return placeA < placeB ? -1 : (placeA > placeB ? 1 : 0);
    });

    var courseByKey = {};
    var courses = [];
    for (var s = 0; s < slotList.length; s++) {
        var item = slotList[s];
        var courseKey = JSON.stringify([item.name, item.teacher || '']);
        var course = courseByKey[courseKey];
        if (!course) {
            course = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            courseByKey[courseKey] = course;
            courses.push(course);
        }
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: runs[k].start,
                endWeek: runs[k].end,
                weekType: runs[k].weekType,
                location: item.location
            });
        }
        if (item.end > maxPeriod) maxPeriod = item.end;
    }

    if (!courses.length) {
        throw new Error('这个学期没有解析到任何课程：请在「我的课表」里确认个人课表已经显示，再重新提取');
    }

    // ---------- 提醒（顺序固定：学期、开学日、总周数、节次时间、丢了什么） ----------
    var name0 = termName();
    warn('已导入教务系统当前标记的学期（' + shortName(name0) + '）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」');

    var firstDay = mondayOf(text(data.today));
    if (!firstDay) throw new Error('没能确定开学日期：本机日期无法识别，请重新登录后再试');
    warn('教务系统没有给出开学日期，第 1 周已按本机日期所在周的周一 ' + firstDay + ' 推算，请在学期管理里核对成学校实际开学日');

    var totalWeeks = DEFAULT_WEEKS;
    var raised = false;
    if (maxNonFullWeek > totalWeeks) {
        totalWeeks = maxNonFullWeek;
        raised = true;
    }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;
    if (raised) {
        warn('课表排到了第 ' + maxNonFullWeek + ' 周，超过了默认的 ' + DEFAULT_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入，请在学期管理里核对');
    } else if (maxNonFullWeek > 0) {
        warn('教务系统没有给出学期总周数，已按 ' + DEFAULT_WEEKS + ' 周导入（课表里最晚排到第 ' + maxNonFullWeek +
            ' 周），如与实际不符可在学期管理里改');
    } else {
        warn('教务系统没有给出学期总周数，已按 ' + DEFAULT_WEEKS + ' 周导入，如与实际不符可在学期管理里改');
    }
    if (fullWeekRows > 0) {
        if (fullAnchor > DEFAULT_WEEKS) {
            warn('有 ' + fullWeekRows + ' 条课程安排标为全周，已按课表覆盖到的第 1-' + fullAnchor + ' 周导入');
        } else {
            warn('有 ' + fullWeekRows + ' 条课程安排标为全周，已按默认的 ' + DEFAULT_WEEKS + ' 周导入');
        }
    }

    // ---------- 节次时间：上游写死的 10 节；更晚的按统一修订 H3 补 ----------
    var periodTimes = PERIOD_TIMES.slice(0);
    var fromDefault = [];
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var previous = periodTimes[periodTimes.length - 1];
        var previousEnd = minutesOf(previous.end);
        var builtin = DEFAULT_PERIOD_TIMES[p - 1];
        // 空课默认表有这一节、且它的开始不早于上一节下课，才用它（否则会和上一节重叠甚至倒挂）
        if (builtin && minutesOf(builtin.start) >= previousEnd) {
            periodTimes.push({ periodIndex: p, start: builtin.start, end: builtin.end });
            fromDefault.push(p);
            continue;
        }
        var nextStart = previousEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) {
            uncoveredFrom = p;
            break;
        }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    warn('已按学校公布的 ' + PERIOD_TIMES.length + ' 节节次时间导入（第 1 节 ' + PERIOD_TIMES[0].start + '-' +
        PERIOD_TIMES[0].end + '，第 ' + PERIOD_TIMES.length + ' 节 ' + PERIOD_TIMES[PERIOD_TIMES.length - 1].start +
        '-' + PERIOD_TIMES[PERIOD_TIMES.length - 1].end + '），学校调整后请在学期管理里核对');
    if (fromDefault.length || bySequence.length) {
        var fillTexts = [];
        if (fromDefault.length) fillTexts.push(sectionsText(fromDefault) + '用默认的节次时间');
        if (bySequence.length) fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 5 分钟、每节 45 分钟顺推');
        var filledAll = fromDefault.concat(bySequence).sort(function (x, y) { return x - y; });
        warn('课表用到了' + sectionsText(filledAll) + '，学校节次时间没有覆盖，已补上：' + fillTexts.join('，') +
            '，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 条');
        if (missing.day) reasons.push('缺星期或星期不在 1-7 ' + missing.day + ' 条');
        if (missing.period) reasons.push('缺节次或节次超出 1-' + MAX_PERIOD + ' 节 ' + missing.period + ' 条');
        if (missing.week) reasons.push('缺周次或周次全超出 1-' + MAX_WEEK + ' 周 ' + missing.week + ' 条');
        if (weekSamples.length) reasons.push('周次原文如「' + weekSamples.join('」「') + '」');
        warn('有 ' + skipped + ' 条课表安排数据不全（' + reasons.join('、') + '），已跳过，如发现少课请反馈');
    }

    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shown = [];
        for (var f = 0; f < fieldSamples.length; f++) shown.push(shortName(fieldSamples[f]));
        warn('有 ' + fieldParts.join('、') + '（例如 ' + shown.join('、') + '）：已照常导入，空着的项可在「编辑课程」里补上');
    }
    if (droppedWeeks > 0) warn('有 ' + droppedWeeks + ' 个周次超过第 ' + MAX_WEEK + ' 周，超出的部分没有导入');
    if (noteGroups > 0) {
        warn('周次说明里有 ' + noteGroups + ' 处认不出的备注（例如 ' + noteSample + '），这些备注没有带进课表，周次按其余文字导入');
    }
    if (bothMarks > 0) warn('有 ' + bothMarks + ' 处周次同时写了单周和双周，已按每周都上导入，请在学期管理里核对');
    if (droppedWarnings > 0) warnings[MAX_WARNINGS - 1] = '另有 ' + droppedWarnings + ' 条核对提示超出上限未显示';

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [{
            name: name0,
            firstDay: firstDay,
            totalWeeks: totalWeeks,
            periodTimes: periodTimes,
            courses: courses
        }]
    });
})()
