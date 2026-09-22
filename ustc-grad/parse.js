(function () {
    // extract.js 的输出 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 resources/USTC/ustc_01.js 里的 parseWeekText /
    // parseDateTimePlace / buildCoursesFromText / computeSemesterConfig 几个函数
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT，上游作者 hydrofluoric07）
    //
    // 移植改动：
    //   ① 【存疑，已在 AUDIT.md 记录】上游 computeSemesterConfig 把 config.firstDayOfWeek 写死成
    //      7（周日），而 semesterStartDate 又是 mondayOf(...) 算出来的周一——按移植手册 §4.3 的
    //      公式，firstDay 要把 semesterStartDate 往前回退到「星期几 = firstDayOfWeek」的那一天，
    //      也就是往前一天（周日）。本科 ustc 适配器（jw.ustc.edu.cn，for-std 平台）的注释也独立
    //      写着「USTC 一周从周日开始」，两个适配器结论一致，因此本文件按“开学周的周日”作为
    //      firstDay，而不是直接用算出来的周一。没有真实教务数据核对这一天的偏移，标记为存疑。
    //   ② 上游按“时间分段 × 周次分段”产出一条条独立的排课记录；本文件按 (课程名, 教师) 分组，
    //      把每条记录的周次数组切成 (startWeek, endWeek, weekType) 段，合成 blocks[]（移植手册 §4.1）。
    //   ③ 上游对“时间分段与周次分段数对不上”“解析不出时间地点”“解析不出周次”这几种情况要么
    //      吞掉整门课、要么用并集顶上且不留痕迹；本文件全部落一条 warnings，且区分成不同措辞
    //      （移植手册 §4.7：不要悄悄丢课）。
    //   ④ 教室解析不到时留空（null），不写“未知地点”这类占位字面量（移植手册 §4.7）。
    //   ⑤ 新增：周次超过空课支持的 30 周上限时丢弃超出部分并写 warnings（上游没有这个防线）。
    //   ⑥ 作息时间表沿用本科 ustc 适配器同一份 13 节制作息（同校统一作息，教务处公布）。

    var MAX_WARNINGS = 20;
    var warnings = [];

    function pushWarn(msg) {
        if (warnings.length >= MAX_WARNINGS) return;
        if (msg.length > 200) msg = msg.slice(0, 199) + '…';
        warnings.push(msg);
    }

    function text(value) {
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

    // 按日历日期运算（UTC 起算），避免本地时区/夏令时把日期挪到前一天。
    function epochDayOf(value) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
        if (!m) return null;
        var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        var millis = Date.UTC(y, mo - 1, d);
        var dt = new Date(millis);
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
        return millis / 86400000;
    }

    function isoOfDay(epochDay) {
        var dt = new Date(epochDay * 86400000);
        return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
    }

    function weekdayOfEpoch(epochDay) {
        return new Date(epochDay * 86400000).getUTCDay() || 7; // 1..7，周一~周日
    }

    function mondayEpochOf(epochDay) {
        return epochDay - (weekdayOfEpoch(epochDay) - 1);
    }

    function currentEpochDay() {
        var now = new Date();
        return epochDayOf(now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()));
    }

    function uniqueSorted(nums) {
        var seen = {};
        var out = [];
        for (var i = 0; i < nums.length; i++) {
            var n = nums[i];
            if (n >= 1 && !seen[n]) {
                seen[n] = true;
                out.push(n);
            }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    // "1-16周" / "1-8,10-16周" / "1-15(单)" / "2-16周(双)" / "3,5,7" 等
    function parseWeekText(str) {
        var weeks = [];
        var parts = text(str).split(/[,，]/);
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i].trim();
            if (!part) continue;
            var parity = part.indexOf('单') >= 0 ? 'odd' : (part.indexOf('双') >= 0 ? 'even' : null);
            var range = /(\d+)\s*[~\-—–]\s*(\d+)/.exec(part);
            var lo, hi;
            if (range) {
                lo = parseInt(range[1], 10);
                hi = parseInt(range[2], 10);
            } else {
                var single = /\d+/.exec(part);
                if (!single) continue;
                lo = hi = parseInt(single[0], 10);
            }
            if (isNaN(lo) || isNaN(hi)) continue;
            var from = Math.min(lo, hi), to = Math.max(lo, hi);
            for (var w = from; w <= to; w++) {
                if (parity === 'odd' && w % 2 === 0) continue;
                if (parity === 'even' && w % 2 === 1) continue;
                weeks.push(w);
            }
        }
        return uniqueSorted(weeks);
    }

    // "GT-C102: 2(6,7,8);G3-113: 3(2,3,4)" -> [{room:"GT-C102",day:2,sections:[6,7,8]}, ...]
    function parseDateTimePlace(str) {
        var out = [];
        var segs = text(str).split(/[;；]/);
        for (var s = 0; s < segs.length; s++) {
            var seg = segs[s].trim();
            if (!seg) continue;
            var room = (seg.split(':')[0] || '').trim() || null;
            var re = /(\d+)\s*\(\s*([\d,，\-~\s]+?)\s*\)/g;
            var m;
            while ((m = re.exec(seg)) !== null) {
                var day = parseInt(m[1], 10);
                if (!(day >= 1 && day <= 7)) continue;
                var sections = [];
                var secParts = m[2].split(/[,，]/);
                for (var p = 0; p < secParts.length; p++) {
                    var sp = secParts[p].trim();
                    if (!sp) continue;
                    var r = /^(\d+)\s*[-~]\s*(\d+)$/.exec(sp);
                    if (r) {
                        for (var k = parseInt(r[1], 10); k <= parseInt(r[2], 10); k++) sections.push(k);
                    } else {
                        var n = parseInt(sp, 10);
                        if (!isNaN(n)) sections.push(n);
                    }
                }
                if (sections.length) out.push({ room: room, day: day, sections: sections });
            }
        }
        return out;
    }

    var PERIOD_TIMES = [
        { periodIndex: 1, start: '07:50', end: '08:35' },
        { periodIndex: 2, start: '08:40', end: '09:25' },
        { periodIndex: 3, start: '09:45', end: '10:30' },
        { periodIndex: 4, start: '10:35', end: '11:20' },
        { periodIndex: 5, start: '11:25', end: '12:10' },
        { periodIndex: 6, start: '14:00', end: '14:45' },
        { periodIndex: 7, start: '14:50', end: '15:35' },
        { periodIndex: 8, start: '15:55', end: '16:40' },
        { periodIndex: 9, start: '16:45', end: '17:30' },
        { periodIndex: 10, start: '17:35', end: '18:20' },
        { periodIndex: 11, start: '19:30', end: '20:15' },
        { periodIndex: 12, start: '20:20', end: '21:05' },
        { periodIndex: 13, start: '21:10', end: '21:55' }
    ];

    // 周次数组 -> 连续段。步长 1 视作每周，步长 2 视作单/双周，单周段用 ALL。
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

    var data = JSON.parse(__ncInput);
    var term = data.term || {};
    var rows = data.rows || [];

    // ---- 逐行：时间地点分段 × 周次分段 配对，产出「时间段」条目（未按课程分组） ----
    var segments = [];

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var name = text(row.KCMC) || '未知课程';

        var teacherRaw = text(row.RKJS);
        var teacherParts = teacherRaw ? teacherRaw.split(/[,，、]/) : [];
        var teachers = [];
        for (var tp = 0; tp < teacherParts.length; tp++) {
            var tn = teacherParts[tp].trim();
            if (tn) teachers.push(tn);
        }
        var teacher = teachers.length ? teachers.join('、') : null;

        var segs = parseDateTimePlace(row.PKSJDD);
        if (!segs.length) {
            pushWarn('课程「' + name + '」无法解析上课时间地点（' + text(row.PKSJDD) + '），已跳过');
            continue;
        }

        var weekSegs = [];
        var rawWeekSegs = text(row.ZCMC).split(/[;；]/);
        for (var ws = 0; ws < rawWeekSegs.length; ws++) {
            if (rawWeekSegs[ws].trim()) weekSegs.push(rawWeekSegs[ws]);
        }
        if (!weekSegs.length) {
            pushWarn('课程「' + name + '」缺少周次信息，已跳过');
            continue;
        }

        var allWeeks = null;
        var mismatchWarned = false;
        var overflowWarned = false;

        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            var weeks;
            if (weekSegs.length === segs.length) {
                weeks = parseWeekText(weekSegs[i]);
            } else if (weekSegs.length === 1) {
                weeks = parseWeekText(weekSegs[0]);
            } else {
                if (!allWeeks) {
                    var union = [];
                    for (var u = 0; u < weekSegs.length; u++) {
                        var uw = parseWeekText(weekSegs[u]);
                        for (var ui = 0; ui < uw.length; ui++) union.push(uw[ui]);
                    }
                    allWeeks = uniqueSorted(union);
                }
                weeks = allWeeks;
                if (!mismatchWarned) {
                    pushWarn('课程「' + name + '」时间分段与周次分段数不一致，周次可能不准确');
                    mismatchWarned = true;
                }
            }

            var withinLimit = [];
            var overflow = false;
            for (var fw = 0; fw < weeks.length; fw++) {
                if (weeks[fw] <= 30) withinLimit.push(weeks[fw]);
                else overflow = true;
            }
            if (overflow && !overflowWarned) {
                pushWarn('课程「' + name + '」有周次超出空课支持的 30 周上限，已丢弃超出部分');
                overflowWarned = true;
            }
            weeks = withinLimit;

            if (!weeks.length) {
                pushWarn('课程「' + name + '」的时间分段「' + (seg.room || '') + '」无法解析周次，已跳过该时间段');
                continue;
            }

            // 连续节次合并为一段
            var sorted = seg.sections.slice().sort(function (a, b) { return a - b; });
            var start = sorted[0], prev = sorted[0];
            var flush = function (end) {
                segments.push({
                    name: name, teacher: teacher, location: seg.room,
                    day: seg.day, startPeriod: start, endPeriod: end, weeks: weeks
                });
            };
            for (var k = 1; k < sorted.length; k++) {
                if (sorted[k] !== prev + 1) { flush(prev); start = sorted[k]; }
                prev = sorted[k];
            }
            flush(prev);
        }
    }

    // ---- 去重 ----
    var seen = {};
    var deduped = [];
    for (var d = 0; d < segments.length; d++) {
        var sgm = segments[d];
        var key = [sgm.name, sgm.teacher || '', sgm.location || '', sgm.day, sgm.startPeriod, sgm.endPeriod, sgm.weeks.join(',')].join('|');
        if (seen[key]) continue;
        seen[key] = true;
        deduped.push(sgm);
    }

    // ---- 按 (课程名, 教师) 分组，周次数组切成 (startWeek,endWeek,weekType) 段 ----
    var courseOrder = [];
    var courseMap = {};
    var maxWeek = 0;
    for (var e = 0; e < deduped.length; e++) {
        var sg = deduped[e];
        var ckey = sg.name + '\u0000' + (sg.teacher || '');
        if (!courseMap[ckey]) {
            courseMap[ckey] = { name: sg.name, teacher: sg.teacher, note: null, blocks: [] };
            courseOrder.push(ckey);
        }
        var runs = runsOf(sg.weeks);
        for (var ri = 0; ri < runs.length; ri++) {
            var run = runs[ri];
            if (run.end > maxWeek) maxWeek = run.end;
            courseMap[ckey].blocks.push({
                dayOfWeek: sg.day,
                startPeriod: sg.startPeriod,
                endPeriod: sg.endPeriod,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: sg.location
            });
        }
    }

    var courses = [];
    for (var co = 0; co < courseOrder.length; co++) courses.push(courseMap[courseOrder[co]]);

    if (!courses.length) {
        throw new Error('未解析到课程，请确认该学期已排课');
    }

    var totalWeeks = intOf(term.zs);
    if (!(totalWeeks >= 1)) totalWeeks = maxWeek;
    if (maxWeek > totalWeeks) totalWeeks = maxWeek;
    if (!(totalWeeks >= 1)) totalWeeks = 18;
    if (totalWeeks > 30) totalWeeks = 30;

    var firstDay;
    var rawEpoch = epochDayOf(term.startDateRaw);
    if (rawEpoch !== null) {
        firstDay = isoOfDay(mondayEpochOf(rawEpoch) - 1);
    } else {
        var fallbackEpoch = currentEpochDay();
        firstDay = isoOfDay(mondayEpochOf(fallbackEpoch) - 1);
        pushWarn('开学日期无法从教务获取，已按最近的周日推算，请在学期管理里核对');
    }

    var result = {
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        terms: [
            {
                name: text(term.mc) || '教务导入',
                firstDay: firstDay,
                totalWeeks: totalWeeks,
                periodTimes: PERIOD_TIMES,
                courses: courses
            }
        ]
    };
    if (warnings.length) result.warnings = warnings;
    return JSON.stringify(result);
})()
