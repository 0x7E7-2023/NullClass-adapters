(function () {
    // 南方科技大学教学管理与服务平台（TIS）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 SUSTECH/sustech.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 yusancky）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945，本校脚本最后一次修改 80bedee。
    // 输入是 extract.js 的 { term, today, currentWeek, slots, rows }；每行只有 KEY、课名、教师、地点、
    // 起止节次、ZC 位图与 SKSJ（英文授课时是 SKSJ_EN）多行文本。
    //
    // 移植改动：
    //   1. 周次：ZC 位图按「下标即周次」展开，并用 SKSJ 里声明的周次校准位数偏移（上游同样两种解释择优）；
    //      SKSJ 的周次文字支持多段取并集、单双标记前置与后置、第 N 周写法、共 N 周备注剥离；第 31 周起丢弃并计数。
    //   2. 课名、教师、地点按上游从 SKSJ 多行文本里取（SKSJ 为空时读英文授课的 SKSJ_EN），行里的同名字段只作兜底；
    //      班级行丢掉；占位词交 null。
    //   3. 节次时间用教务给的（xj / kssj / jssj），拿不到回落到上游写死的南科大常规节次表并提醒；
    //      超出表尾的按课间 10 分钟、每节 50 分钟顺推。
    //   4. 开学日按教务的当前教学周往回推算；当前教学周拿不到时按本机日期所在周周一推算并提醒。
    //   5. 总周数默认 20 周（上游写死 18，本系列统一按 20），只有课表排得更晚才抬高，超过 30 截断。
    //   6. 同课同教师同地点同星期的重复行先并周次，再按连堂合并；提醒原文截 20 字，统一出口 20 条、每条 200 字。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = Array.isArray(data.rows) ? data.rows : [];

    var SCHOOL = '南方科技大学';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var CLASS_MINUTES = 50;
    var BREAK_MINUTES = 10;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;

    // 上游 FALLBACK_TIME_SLOTS：教务没给节次时间时的南科大常规节次（12 节，逐节照抄上游）。
    var FALLBACK_SLOTS = [
        { periodIndex: 1, start: '08:00', end: '08:50' },
        { periodIndex: 2, start: '09:00', end: '09:50' },
        { periodIndex: 3, start: '10:20', end: '11:10' },
        { periodIndex: 4, start: '11:20', end: '12:10' },
        { periodIndex: 5, start: '14:00', end: '14:50' },
        { periodIndex: 6, start: '15:00', end: '15:50' },
        { periodIndex: 7, start: '16:20', end: '17:10' },
        { periodIndex: 8, start: '17:20', end: '18:10' },
        { periodIndex: 9, start: '19:00', end: '19:50' },
        { periodIndex: 10, start: '20:00', end: '20:50' },
        { periodIndex: 11, start: '21:20', end: '22:10' },
        { periodIndex: 12, start: '22:20', end: '23:10' }
    ];

    var EMPTY_WORD = {
        '未知': true, '未知课程': true, '未知教师': true, '未知老师': true, '未知地点': true, '未知教室': true,
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

    // 依次取第一个不是空、也不是「未知」「待定」这类占位词的值。
    function firstReal() {
        for (var i = 0; i < arguments.length; i++) {
            var value = realOrNull(arguments[i]);
            if (value) return value;
        }
        return null;
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

    // 去掉一对包裹的中括号：[教师甲] -> 教师甲
    function unwrap(value) {
        return String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '')
            .replace(/^\[/, '')
            .replace(/\]$/, '')
            .replace(/^\s+|\s+$/g, '');
    }

    // 提取一行里所有 [xxx] 的内容
    function bracketGroups(line) {
        var groups = [];
        var pattern = /\[([^\]]*)\]/g;
        var matched = pattern.exec(String(line));
        while (matched !== null) {
            groups.push(text(matched[1]));
            matched = pattern.exec(String(line));
        }
        return groups;
    }

    // 含数字又含「周」才算周次文字；「第3-4节」「思想道德-09班-中文」都不算。
    function isWeekText(value) {
        var line = text(value);
        return line.indexOf('周') >= 0 && /[0-9]/.test(line);
    }

    function isSectionText(value) {
        return /[0-9]\s*(?:[-~至到]\s*[0-9]+)?\s*节/.test(text(value));
    }

    // 周次文字 → 周号数组。逐段解析并取并集；单双标记既可能写在段首，也可能写在段尾。
    // 兼容：1-16周、第1周至第8周、第1-第8周、1,3,5周、(单)1-8周、(双)9-16周、1-8周(单)9-16周(双)。
    function parseWeekText(value) {
        var source = text(value);
        if (!source) return [];
        // 「共 N 周」只是备注，只剥掉备注本身，别吞后面的真实周次段
        source = source.replace(/共\s*[0-9]+\s*周?/g, ' ');
        // 全角括号 / 顿号先归一，后面按半角处理
        source = source.replace(/（/g, '(').replace(/）/g, ')').replace(/、/g, ',').replace(/；/g, ';');
        // 「第3-4节」「(2-3节)」是节次不是周次：整段摘掉，不能连带截断后面的真实周次
        source = source.replace(/第?[0-9]+\s*(?:[-~至到]\s*第?\s*[0-9]+)?\s*节/g, ' ');
        // 括号里不是周次写法的（(3学分)、(实验) 等）整组摘掉；只留 (单)/(双)/(1-16周) 这类
        source = source.replace(/\(([^()]*)\)/g, function (all, inner) {
            var weekish = /^[\s0-9,\-~至到第单双周]+$/.test(inner) && /[0-9单双]/.test(inner);
            return weekish ? ' ' + all + ' ' : ' ';
        });

        var weeks = [];
        var seen = {};
        // 按逗号分段：每段各自判单双（段首标记管本段后面，段尾标记管紧挨着的前一段）
        var segments = source.split(/[,;]/);
        var si;
        for (si = 0; si < segments.length; si++) collectSegment(segments[si]);
        return weeks.sort(function (a, b) { return a - b; });

        function collectSegment(segment) {
            var pattern = /(\(\s*[单双]\s*周?\s*\))|([单双]\s*周)|([0-9]+\s*周?\s*(?:[-~至到]\s*第?\s*[0-9]+)?)/g;
            var tokens = [];
            var match;
            while ((match = pattern.exec(segment)) !== null) {
                if (match[1] || match[2]) {
                    tokens.push({ marker: (match[1] || match[2]).indexOf('单') >= 0 ? 1 : 2 });
                } else {
                    tokens.push({ range: match[3] });
                }
            }
            if (!tokens.length) return;
            var prefixStyle = !!tokens[0].marker;
            var current = 0;
            var i;
            for (i = 0; i < tokens.length; i++) {
                var token = tokens[i];
                if (token.marker) {
                    if (prefixStyle) current = token.marker;
                    continue;
                }
                var parity = current;
                if (!prefixStyle) {
                    parity = 0;
                    if (i + 1 < tokens.length && tokens[i + 1].marker) parity = tokens[i + 1].marker;
                }
                var rangeMatch = /([0-9]+)\s*周?\s*(?:[-~至到]\s*第?\s*([0-9]+))?/.exec(token.range);
                if (!rangeMatch) continue;
                var start = parseInt(rangeMatch[1], 10);
                var end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start;
                if (!(start > 0)) continue;
                if (!(end >= start) || end - start > 60) end = start;
                for (var week = start; week <= end; week++) {
                    if (parity === 1 && week % 2 === 0) continue;
                    if (parity === 2 && week % 2 === 1) continue;
                    if (seen['w' + week]) continue;
                    seen['w' + week] = true;
                    weeks.push(week);
                }
            }
        }
    }

    // ZC 是 0/1 位图，实测下标即周次（下标 0 未使用）。上游同时算出「周次 = 下标」与
    // 「周次 = 下标 + 1」两种解释，用 SKSJ 里声明的周次校准，声明为空时按「周次 = 下标」。
    function buildWeeks(bitmap, shift) {
        var weeks = [];
        for (var i = 0; i < bitmap.length; i++) {
            if (bitmap.charAt(i) === '1') {
                var week = i + 1 - shift;
                if (week > 0) weeks.push(week);
            }
        }
        return weeks;
    }

    function overlapOf(weeks, declared) {
        var set = {};
        var i;
        for (i = 0; i < weeks.length; i++) set['w' + weeks[i]] = true;
        var score = 0;
        for (i = 0; i < declared.length; i++) {
            if (set['w' + declared[i]]) score++;
        }
        return score;
    }

    function bitmapWeeks(value, declared) {
        var bitmap = text(value).replace(/[^01]/g, '');
        if (!/^[01]+$/.test(bitmap)) return declared;
        var plain = buildWeeks(bitmap, 1);
        if (!declared.length) return plain;
        var shifted = buildWeeks(bitmap, 0);
        return overlapOf(shifted, declared) > overlapOf(plain, declared) ? shifted : plain;
    }

    function weeksOfRow(row, declared) {
        var weeks = bitmapWeeks(row.ZC, declared);
        var kept = [];
        var dropped = 0;
        var previous = 0;
        for (var i = 0; i < weeks.length; i++) {
            var week = weeks[i];
            if (week === previous) continue;
            previous = week;
            if (week > MAX_WEEK) dropped++;
            else if (week >= 1) kept.push(week);
        }
        return { weeks: kept, dropped: dropped };
    }

    // SKSJ 形如：
    //   思想道德与法治
    //   [兰美荣]
    //   [思想道德与法治-09班-中文]
    //   [1-16周][智华楼207][9-10节]
    function parseScheduleText(value) {
        var raw = String(value === null || value === undefined ? '' : value)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '\n');
        var pieces = raw.split('\n');
        var lines = [];
        var i;
        for (i = 0; i < pieces.length; i++) {
            var line = text(pieces[i]);
            if (line) lines.push(line);
        }
        var result = { name: '', teacher: '', position: '', weeks: [] };
        if (!lines.length) return result;
        result.name = unwrap(lines[0]);
        for (i = 1; i < lines.length; i++) {
            var current = lines[i];
            var groups = bracketGroups(current);
            if (isWeekText(current) || isSectionText(current)) {
                if (!result.weeks.length) {
                    var weekParts = [];
                    for (var g = 0; g < groups.length; g++) {
                        if (isWeekText(groups[g]) && !isSectionText(groups[g])) weekParts.push(groups[g]);
                    }
                    // 没有中括号的整行才当周次读，免得把「二教202」这类地点当成第 202 周
                    if (!weekParts.length && !groups.length && isWeekText(current)) weekParts.push(current);
                    if (weekParts.length) result.weeks = parseWeekText(weekParts.join(','));
                }
                if (!result.position) {
                    for (var p = 0; p < groups.length; p++) {
                        var part = groups[p];
                        if (!part) continue;
                        if (isWeekText(part) || isSectionText(part)) continue;
                        if (part.indexOf('班') >= 0) continue;
                        if (part === result.name) continue;
                        if (result.name && (part.indexOf(result.name) >= 0 || result.name.indexOf(part) >= 0)) continue;
                        result.position = unwrap(part);
                        break;
                    }
                }
                continue;
            }
            var plain = unwrap(current);
            if (!result.teacher && plain && plain !== result.name && plain.indexOf('班') < 0) {
                result.teacher = plain;
            }
        }
        return result;
    }

    // "2026-2027" + "1" → 学期名里用的中文说法
    function termName() {
        var label = text(term.label);
        if (label) return label;
        var xn = text(term.xn);
        var xq = text(term.xq);
        if (!/^[0-9]{4}-[0-9]{4}$/.test(xn) || !/^[0-9]+$/.test(xq)) {
            var guess = guessTermCodes();
            if (!guess) return SCHOOL + ' 课表';
            xn = guess.xn;
            xq = guess.xq;
        }
        return SCHOOL + ' ' + xn + '学年第' + (XQ_CN[xq] || xq) + '学期';
    }

    // 教务没给学年学期时，按今天的日期推一个：1 月属上一年第 1 学期，2-7 月属第 2 学期，8-12 月属第 1 学期。
    function guessTermCodes() {
        var todayText = text(data.today);
        if (utcOfIso(todayText) === null) return null;
        var year = parseInt(todayText.substring(0, 4), 10);
        var month = parseInt(todayText.substring(5, 7), 10);
        if (month === 1) return { xn: (year - 1) + '-' + year, xq: '1' };
        if (month >= 2 && month <= 7) return { xn: (year - 1) + '-' + year, xq: '2' };
        return { xn: year + '-' + (year + 1), xq: '1' };
    }

    function termIsFallback() {
        if (text(term.label)) return false;
        return !(/^[0-9]{4}-[0-9]{4}$/.test(text(term.xn)) && /^[0-9]+$/.test(text(term.xq)));
    }

    function hhmmOfText(value) {
        var raw = text(value);
        var matched = /^([0-9]{1,2}):([0-9]{2})$/.exec(raw);
        if (!matched) return '';
        var hour = parseInt(matched[1], 10);
        var minute = parseInt(matched[2], 10);
        if (hour > 23 || minute > 59) return '';
        return pad2(hour) + ':' + pad2(minute);
    }

    // 教务给的节次时间；xj 是节次号，起止时间不合法或重复的节次不用。
    function periodTimesOf(list) {
        var array = Array.isArray(list) ? list : [];
        var seen = {};
        var out = [];
        for (var i = 0; i < array.length; i++) {
            var item = array[i] || {};
            var number = integerOf(item.xj);
            var start = hhmmOfText(item.kssj);
            var end = hhmmOfText(item.jssj);
            if (!(number >= 1) || number > MAX_PERIOD) continue;
            if (!start || !end) continue;
            if (minutesOf(start) >= minutesOf(end)) continue;
            if (seen['p' + number]) continue;
            seen['p' + number] = true;
            out.push({ periodIndex: number, start: start, end: end });
        }
        out.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        return out;
    }

    function fallbackPeriodTimes() {
        var out = [];
        for (var i = 0; i < FALLBACK_SLOTS.length; i++) {
            out.push({
                periodIndex: FALLBACK_SLOTS[i].periodIndex,
                start: FALLBACK_SLOTS[i].start,
                end: FALLBACK_SLOTS[i].end
            });
        }
        return out;
    }

    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2 ? 2 : 1;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var run = { start: weeks[i], end: weeks[j], weekType: 'ALL' };
            if (step === 2 && run.start !== run.end) run.weekType = run.start % 2 === 1 ? 'ODD' : 'EVEN';
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

    // 上游 cleanTeacher：按中英文逗号、顿号、分号拆开、去空、去重后重新拼（括注留在名字里，不拆成第二位教师）。
    function cleanTeacher(value) {
        var raw = text(value);
        if (!raw) return '';
        var names = raw.split(/[,，、;；]/);
        var seen = {};
        var out = [];
        for (var i = 0; i < names.length; i++) {
            var name = text(names[i]);
            if (!name || seen['n' + name]) continue;
            seen['n' + name] = true;
            out.push(name);
        }
        return out.join(',');
    }

    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];
    var droppedWeeks = 0;
    var slots = {};
    var slotList = [];
    var seenRows = {};
    var maxWeek = 0;
    var maxPeriod = 0;

    function rememberFieldSample(name) {
        if (fieldSamples.length >= 3 || fieldSamples.indexOf(name) >= 0) return;
        fieldSamples.push(name);
    }

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var rowKey = JSON.stringify([text(row.KEY), text(row.KCMC), text(row.SKJS), text(row.SKDD),
            text(row.KSJC), text(row.JSJC), text(row.ZC), text(row.SKSJ), text(row.SKSJ_EN)]);
        if (seenRows[rowKey]) continue;
        seenRows[rowKey] = true;

        // 与上游一致：中文授课文本为空时读英文授课文本
        var detail = parseScheduleText(text(row.SKSJ) ? row.SKSJ : row.SKSJ_EN);
        var name = firstReal(detail.name, row.KCMC);
        if (!name) {
            missing.name++;
            continue;
        }
        // KEY 形如 xq1_jc5：xq 后面是星期；jc 只是课表网格行号，不是节次
        var keyMatch = /xq([0-9]+)_jc([0-9]+)/i.exec(text(row.KEY));
        var day = integerOf(keyMatch ? keyMatch[1] : null);
        if (!(day >= 1 && day <= 7)) {
            missing.day++;
            continue;
        }
        var startPeriod = integerOf(row.KSJC);
        if (!(startPeriod >= 1)) startPeriod = integerOf(keyMatch ? keyMatch[2] : null);
        var endPeriod = integerOf(row.JSJC);
        if (!(endPeriod >= startPeriod)) endPeriod = startPeriod;
        if (!(startPeriod >= 1) || startPeriod > MAX_PERIOD || endPeriod > MAX_PERIOD) {
            missing.period++;
            continue;
        }
        var parsedWeeks = weeksOfRow(row, detail.weeks);
        droppedWeeks += parsedWeeks.dropped;
        if (!parsedWeeks.weeks.length) {
            missing.week++;
            continue;
        }
        var teacher = firstReal(cleanTeacher(detail.teacher), cleanTeacher(row.SKJS));
        var location = firstReal(detail.position, row.SKDD);
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if (!teacher || !location) rememberFieldSample(name);

        var slotKey = JSON.stringify([name, teacher || '', location || '', day, startPeriod, endPeriod]);
        var slot = slots[slotKey];
        if (!slot) {
            slot = { name: name, teacher: teacher, location: location, day: day,
                start: startPeriod, end: endPeriod, weeks: [] };
            slots[slotKey] = slot;
            slotList.push(slot);
        }
        slot.weeks = unionWeeks(slot.weeks, parsedWeeks.weeks);
    }

    // 连堂合并：同一门课、同一天、同一教师同地点，下一段不晚于上一段结束的下一节，且周次完全相同，才合成一段。
    // 同一节的重复行在 slotKey 阶段已并成并集；周次不同的连堂保持两段。
    var groups = {};
    var groupKeys = [];
    var g;
    for (g = 0; g < slotList.length; g++) {
        var groupKey = JSON.stringify([slotList[g].name, slotList[g].teacher || '', slotList[g].location || '', slotList[g].day]);
        if (!groups[groupKey]) {
            groups[groupKey] = [];
            groupKeys.push(groupKey);
        }
        groups[groupKey].push(slotList[g]);
    }
    var mergedSlots = [];
    for (g = 0; g < groupKeys.length; g++) {
        var members = groups[groupKeys[g]];
        members.sort(function (a, b) { return a.start - b.start; });
        var current = null;
        for (var m = 0; m < members.length; m++) {
            var candidate = members[m];
            if (current && candidate.start <= current.end + 1 &&
                    current.weeks.join(',') === candidate.weeks.join(',')) {
                if (candidate.end > current.end) current.end = candidate.end;
            } else {
                current = { name: candidate.name, teacher: candidate.teacher, location: candidate.location,
                    day: candidate.day, start: candidate.start, end: candidate.end,
                    weeks: candidate.weeks.slice(0) };
                mergedSlots.push(current);
            }
        }
    }

    mergedSlots.sort(function (a, b) {
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
    for (var s = 0; s < mergedSlots.length; s++) {
        var item = mergedSlots[s];
        var courseKey = JSON.stringify([item.name, item.teacher || '']);
        var course = courseByKey[courseKey];
        if (!course) {
            course = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            courseByKey[courseKey] = course;
            courses.push(course);
        }
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            if (runs[k].end > maxWeek) maxWeek = runs[k].end;
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
        throw new Error('这个学期没有读到任何课程：请在教务系统里确认该学期的课表已经公布，再重新提取');
    }

    var name0 = termName();
    if (termIsFallback()) {
        warn('没能读到教务的学年学期，学期名已按今天的日期推算，请在学期管理里核对');
    }

    // 开学日：优先按教务的当前教学周往回推；周次拿不到就退回本机日期所在周的周一。
    var todayText = text(data.today);
    var todayMonday = mondayOf(todayText);
    if (!todayMonday) throw new Error('没能确定开学日期：没有读到可用的日期，请重新登录后再试');
    var currentWeek = integerOf(data.currentWeek);
    var firstDay = '';
    if (currentWeek >= 1 && currentWeek <= MAX_WEEK) {
        firstDay = isoOf(new Date(utcOfIso(todayMonday) - (currentWeek - 1) * 7 * 86400000));
        if (utcOfIso(firstDay) > utcOfIso(todayMonday)) {
            firstDay = todayMonday;
            warn('教务给的当前教学周不在合理范围，第 1 周已按本机日期所在周的周一推算为 ' + firstDay + '，请在学期管理里核对');
        } else {
            warn('第 1 周周一已按教务的当前教学周（第 ' + currentWeek + ' 周）往回推算为 ' + firstDay + '，请在学期管理里核对');
        }
    } else {
        firstDay = todayMonday;
        warn('没能读到教务的当前教学周，第 1 周已按本机日期所在周的周一推算为 ' + firstDay + '，请在学期管理里核对');
    }

    var configuredWeeks = DEFAULT_WEEKS;
    var totalWeeks = configuredWeeks;
    var raised = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raised = true;
    }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    warn('没能从教务读到学期总周数，已按 20 周导入' + (raised ? '；课表排到更晚的周，另按课表调整' : '') + '，请在学期管理里核对');
    if (raised) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过原定的 ' + configuredWeeks + ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对');
    }

    var serverSlots = periodTimesOf(data.slots);
    var periodTimes = serverSlots.length ? serverSlots : fallbackPeriodTimes();

    var lastSlot = periodTimes[periodTimes.length - 1];
    var filled = [];
    var uncoveredFrom = 0;
    for (var p = lastSlot.periodIndex + 1; p <= maxPeriod; p++) {
        var previousSlot = periodTimes[periodTimes.length - 1];
        var nextStart = minutesOf(previousSlot.end) + BREAK_MINUTES;
        var nextEnd = nextStart + CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) {
            uncoveredFrom = p;
            break;
        }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        filled.push(p);
    }

    var firstSlot = periodTimes[0];
    var timeRange = '（第 ' + firstSlot.periodIndex + ' 节 ' + firstSlot.start + '-' + firstSlot.end +
        '，第 ' + lastSlot.periodIndex + ' 节 ' + lastSlot.start + '-' + lastSlot.end + '）';
    if (!serverSlots.length) {
        warn('没能读到教务的节次时间，已按学校公布的常规节次时间导入' + timeRange + '，学校调整后请在学期管理里核对');
    }
    if (filled.length) {
        warn('课表用到了' + sectionsText(filled) + '，学校节次时间没有覆盖，已按上一节下课后课间 10 分钟、每节 50 分钟顺推补上，请在学期管理里核对');
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
    if (droppedWeeks > 0) warn('有 ' + droppedWeeks + ' 个周次超过第 30 周，超出的部分没有导入');
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
