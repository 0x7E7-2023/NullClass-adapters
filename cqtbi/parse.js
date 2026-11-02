(function () {
    // 重庆工商职业学院（强智 jsxsd）课表解析；移植自 CQTBI/cqtbi.js（MIT，作者 Haooz）。
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 03d161a；本校脚本 17f7499。输入只含课程卡片原文与周历配置。
    // 周次、连续节次、课程合并、开学日和提醒都在这里纯转换，不访问页面或网络。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var MAX_WEEK = 30;
    var MAX_PERIOD = 12;
    var MAX_WARNINGS = 20;
    var SEP = String.fromCharCode(1);
    var warnings = [];
    var droppedWeeks = 0;
    var missing = { name: 0, day: 0, week: 0, period: 0 };
    var droppedSamples = [];
    var noTeacher = [];
    var noRoom = [];

    var SLOT_PAIRS = [
        '08:00-08:40', '08:50-09:30', '09:40-10:20', '10:40-11:20',
        '11:30-12:10', '14:00-14:40', '14:50-15:30', '15:40-16:20',
        '16:40-17:20', '17:30-18:10', '19:00-19:40', '19:50-20:30'
    ];

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function clip(value, max) {
        var text = String(value);
        return text.length <= max ? text : text.substring(0, max - 1) + '…';
    }

    function warn(message) {
        var line = clip(clean(message), 200);
        if (warnings.indexOf(line) < 0) warnings.push(line);
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function mondayOf(value) {
        var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(value));
        if (!match) return null;
        var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
        var back = (date.getDay() + 6) % 7;
        return isoOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() - back));
    }

    function termName() {
        var match = /^(\d{4})-(\d{4})-(\d)$/.exec(clean(data.termCode));
        if (!match) return '重庆工商职业学院当前学期';
        var kind = match[3] === '1' ? '一' : (match[3] === '2' ? '二' : '三');
        return match[1] + '-' + match[2] + '学年第' + kind + '学期';
    }

    function pushWeek(out, week, odd, even) {
        if (week < 1) return;
        if (week > MAX_WEEK) { droppedWeeks++; return; }
        if (odd && week % 2 === 0) return;
        if (even && week % 2 === 1) return;
        out.push(week);
    }

    function weeksOf(source) {
        var text = clean(source)
            .replace(/星期[一二三四五六日天]/g, '')
            .replace(/[（(]全部[)）]/g, '')
            .replace(/\s*[～~—－–—至到]\s*/g, '-')
            .replace(/[，、；;]/g, ',')
            .replace(/周/g, '')
            .replace(/第/g, '');
        text = text.replace(/[（(]([单双])周?[)）](?=\s*[0-9])/g, function (all, mark, offset, whole) {
            var before = whole.substring(0, offset);
            if (!/[0-9]\s*$/.test(before)) return all;
            var segment = before.replace(/\s+$/, '').split(/[\s,，、;；]+/).pop();
            if (segment && /^[（(][单双]/.test(segment)) return ',' + all;
            return all;
        });
        text = text.replace(/([0-9])\s*[（(]([单双])[)）]\s*(?=[0-9])/g, '$1$2,');
        var tokens = text.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i].replace(/[（）()]/g, '');
            if (token) segments.push(token);
        }
        for (i = 0; i < segments.length; i++) {
            if (/\d/.test(segments[i]) || (segments[i].indexOf('单') < 0 && segments[i].indexOf('双') < 0)) continue;
            var into = -1;
            for (var back = i - 1; back >= 0; back--) {
                if (/\d/.test(segments[back])) { into = back; break; }
            }
            for (var forward = i + 1; into < 0 && forward < segments.length; forward++) {
                if (/\d/.test(segments[forward])) { into = forward; break; }
            }
            if (into >= 0) {
                segments[into] += segments[i];
                segments[i] = '';
            }
        }
        var seen = {};
        var weeks = [];
        for (i = 0; i < segments.length; i++) {
            var segment = segments[i];
            if (!/\d/.test(segment)) continue;
            var odd = segment.indexOf('单') >= 0 && segment.indexOf('双') < 0;
            var even = segment.indexOf('双') >= 0 && segment.indexOf('单') < 0;
            var found = segment.match(/\d+(?:-\d+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (end < start) { var swap = start; start = end; end = swap; }
                for (var week = start; week <= end; week++) {
                    var before = weeks.length;
                    pushWeek(weeks, week, odd, even);
                    if (weeks.length > before) seen[week] = true;
                }
            }
        }
        var unique = [];
        for (var key in seen) if (Object.prototype.hasOwnProperty.call(seen, key)) unique.push(Number(key));
        unique.sort(function (a, b) { return a - b; });
        return unique;
    }

    function periodsOf(source) {
        var found = clean(source).match(/\d+/g);
        if (!found || !found.length) return null;
        var values = [];
        var seen = {};
        for (var i = 0; i < found.length; i++) {
            var value = parseInt(found[i], 10);
            if (!(value >= 1 && value <= MAX_PERIOD) || seen[value]) return null;
            if (i > 0 && value !== values[i - 1] + 1) return null;
            seen[value] = true;
            values.push(value);
        }
        return { start: values[0], end: values[values.length - 1] };
    }

    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2 ? 2 : 1;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            runs.push({
                start: weeks[i],
                end: weeks[j],
                weekType: step === 2 && j > i ? (weeks[i] % 2 ? 'ODD' : 'EVEN') : 'ALL'
            });
            i = j + 1;
        }
        return runs;
    }

    function blank(value, kind) {
        var text = clean(value);
        if (kind === 'teacher') text = text.replace(/^教师\s*[:：]/, '');
        if (!text || /^(未知|待定|暂无|无)(教师|老师|地点|教室)?$/.test(text)) return null;
        return text;
    }

    function noteDropped(item, reason) {
        if (droppedSamples.length >= 3) return;
        droppedSamples.push(clip(clean(item.name) || '(没认出课名)', 20) + '——' + reason);
    }

    var items = Array.isArray(data.items) ? data.items : [];
    var merged = [];
    var mergeAt = {};
    var maxWeek = 0;
    for (var i = 0; i < items.length; i++) {
        var item = items[i] || {};
        var name = clean(item.name);
        if (!name) { missing.name++; noteDropped(item, '没认出课名'); continue; }
        var day = parseInt(item.day, 10);
        if (!(day >= 1 && day <= 7)) { missing.day++; noteDropped(item, '星期无效'); continue; }
        var weeks = weeksOf(item.weekText);
        if (!weeks.length) { missing.week++; noteDropped(item, '没认出周次'); continue; }
        var periods = periodsOf(item.sectionsText);
        if (!periods) { missing.period++; noteDropped(item, '节次缺失、不连续或超出 12 节'); continue; }
        var teacher = blank(item.teacherText, 'teacher');
        var room = blank(item.roomText, 'room');
        if (!teacher && noTeacher.indexOf(name) < 0) noTeacher.push(name);
        if (!room && noRoom.indexOf(name) < 0) noRoom.push(name);
        for (var w = 0; w < weeks.length; w++) if (weeks[w] > maxWeek) maxWeek = weeks[w];
        var key = [name, teacher || '', room || '', day, periods.start, periods.end].join(SEP);
        if (mergeAt[key] !== undefined) {
            var target = merged[mergeAt[key]];
            var union = target.weeks.concat(weeks);
            var seen = {};
            target.weeks = [];
            for (var u = 0; u < union.length; u++) {
                if (!seen[union[u]]) { seen[union[u]] = true; target.weeks.push(union[u]); }
            }
            target.weeks.sort(function (a, b) { return a - b; });
        } else {
            mergeAt[key] = merged.length;
            merged.push({ name: name, teacher: teacher, room: room, day: day, periods: periods, weeks: weeks });
        }
    }

    if (!merged.length) throw new Error('没有找到可导入的课程，请确认课表包含课名、星期、周次和连续节次');

    var groups = [];
    var groupAt = {};
    for (i = 0; i < merged.length; i++) {
        var row = merged[i];
        var groupKey = row.name + SEP + (row.teacher || '');
        if (groupAt[groupKey] === undefined) {
            groupAt[groupKey] = groups.length;
            groups.push({ name: row.name, teacher: row.teacher, note: null, blocks: [] });
        }
        var runs = runsOf(row.weeks);
        for (var r = 0; r < runs.length; r++) {
            groups[groupAt[groupKey]].blocks.push({
                dayOfWeek: row.day,
                startPeriod: row.periods.start,
                endPeriod: row.periods.end,
                startWeek: runs[r].start,
                endWeek: runs[r].end,
                weekType: runs[r].weekType,
                location: row.room
            });
        }
    }
    groups.sort(function (a, b) {
        if (a.blocks[0].dayOfWeek !== b.blocks[0].dayOfWeek) return a.blocks[0].dayOfWeek - b.blocks[0].dayOfWeek;
        if (a.blocks[0].startPeriod !== b.blocks[0].startPeriod) return a.blocks[0].startPeriod - b.blocks[0].startPeriod;
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    for (i = 0; i < groups.length; i++) {
        groups[i].blocks.sort(function (a, b) {
            if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
            if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
            if (a.startWeek !== b.startWeek) return a.startWeek - b.startWeek;
            return a.weekType < b.weekType ? -1 : (a.weekType > b.weekType ? 1 : 0);
        });
    }

    var calendar = data.calendar || {};
    var firstDay = mondayOf(calendar.firstDate);
    if (firstDay) {
        if (firstDay !== calendar.firstDate) warn('周历首个日期 ' + calendar.firstDate + ' 不是周一，开学日已对齐到该周周一 ' + firstDay + '，请核对');
    } else {
        firstDay = mondayOf(data.today);
        if (!firstDay) throw new Error('无法确定开学日期，请重新打开课表后再提取');
        warn('课表页没有可用的周历日期，开学日已按提取日所在周的周一（' + firstDay + '）推算，请在学期管理里核对');
    }
    var calendarWeeks = parseInt(calendar.totalWeeks, 10);
    if (!(calendarWeeks >= 1 && calendarWeeks <= MAX_WEEK)) calendarWeeks = 0;
    var totalWeeks = calendarWeeks || Math.max(20, maxWeek);
    if (maxWeek > totalWeeks) {
        warn('周历只有 ' + totalWeeks + ' 周，课表有第 ' + maxWeek + ' 周的课，总周数已抬高到 ' + maxWeek + ' 周，请核对');
        totalWeeks = maxWeek;
    }
    if (!calendarWeeks) warn('课表页没有可用的总周数，已按课表与 20 周默认值取较大者（' + totalWeeks + ' 周），请核对');

    var periodTimes = [];
    for (i = 0; i < SLOT_PAIRS.length; i++) {
        var pair = SLOT_PAIRS[i].split('-');
        periodTimes.push({ periodIndex: i + 1, start: pair[0], end: pair[1] });
    }
    warn('节次时间按上游的重庆工商职业学院 12 节表导入（第 1 节 08:00-08:40），未做真机核对，请在学期管理里核对');
    if (!/^\d{4}-\d{4}-\d$/.test(clean(data.termCode))) warn('没能识别学年学期，学期名使用占位名称，请在学期管理里改名');
    if (droppedWeeks) warn('有 ' + droppedWeeks + ' 个周次超出 ' + MAX_WEEK + ' 周，未导入');
    var skipped = missing.name + missing.day + missing.week + missing.period;
    if (skipped) {
        warn('有 ' + skipped + ' 个课程卡片已跳过：缺课名 ' + missing.name + '、星期无效 ' + missing.day +
            '、周次无法识别 ' + missing.week + '、节次无效 ' + missing.period + '。包含：' + droppedSamples.join('；'));
    }
    if (noTeacher.length) warn('有 ' + noTeacher.length + ' 门课没有教师信息，已留空（' + noTeacher.slice(0, 3).join('、') + (noTeacher.length > 3 ? ' 等' : '') + '）');
    if (noRoom.length) warn('有 ' + noRoom.length + ' 门课没有上课地点，已留空（' + noRoom.slice(0, 3).join('、') + (noRoom.length > 3 ? ' 等' : '') + '）');

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings.slice(0, MAX_WARNINGS),
        terms: [{
            name: termName(),
            firstDay: firstDay,
            totalWeeks: totalWeeks,
            periodTimes: periodTimes,
            courses: groups
        }]
    });
})()
