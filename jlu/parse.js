(function () {
    // 吉林大学教务适配器（金智 jwapp /「我的课表」wdkb 应用）—— 第二步：纯转换。
    //
    // 移植自 shiguang_warehouse 的 JLU/JLU_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Leimeng52mc）
    //   上游快照 baf83fa（2026-11-09 对齐）；本校脚本最后一次修改 ca9632c。
    // 输入是 extract.js 交出来的 { term, today, rowTotal, calendarRows, sectionRows, rows, changeRows, undeterminedRows }，
    // 每个行对象都只有白名单字段。这一段不碰 DOM、不发请求、不读挂钟，CI 可以用 Rhino 跑回归。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   1. 周次照上游 parseWeeksFromSkzc：SKZC 第 1 位对应第 1 周，字符 1 表示上课；连续、单双、孤立与空洞切成极大段，
    //      第 31 周起丢弃并提醒。位串是位串，不套用「(单)1-8周」这类文字周次的解析。
    //   2. 调课 / 停课照上游 applyCourseChanges：按 KBID 匹配原课，停课去掉 SKZC 里的周次；新周次、星期、节次齐全时另排一条，
    //      同一排课位（含教室）已存在则并入周次；全部周次被去掉的课删掉。补强：对不上原课的、只删没排的、
    //      新时间不合规的记录都计数提醒（上游静默跳过）。
    //   3. 教师照上游 cleanTeacher：按英文逗号分段、每段取斜杠前的姓名（工号不算教师），去重后连接，拿不到交 null；
    //      教室拿不到交 null；缺教师 / 缺教室照常导入，按类型汇总提醒。
    //   4. 节次时间照上游 parseTimeSlots 读教务（只取启用的节次）；取不到交空表，由应用用默认节次时间并提醒；
    //      课表用到节次时间表没有覆盖的节次时，按统一修订 H3 逐节顺推补齐并提醒。
    //   5. 开学日与总周数照上游 parseSemesterCalendar 读校历，开学日回退到同一周的周一；取不到时开学日按本机日期推算、
    //      总周数用 20，课表排得更晚才抬高，都写进提醒。
    //   6. 未定时间课程只在提醒里点名（课名截 20 字）不导入；学期名用教务给的文本，拿不到用「吉林大学 + 学年学期」。
    //   7. 原始重复行先按内容去重再解析、再计数；提醒统一一个出口，每条最多 200 字、最多 20 条。
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var rows = data.rows instanceof Array ? data.rows : [];
    var changeRows = data.changeRows instanceof Array ? data.changeRows : null;
    var calendarRows = data.calendarRows instanceof Array ? data.calendarRows : [];
    var sectionRows = data.sectionRows instanceof Array ? data.sectionRows : [];
    var undeterminedRows = data.undeterminedRows instanceof Array ? data.undeterminedRows : [];

    var SCHOOL = '吉林大学';
    var MAX_WEEK = 30;
    var DEFAULT_WEEKS = 20;
    var MAX_PERIOD = 20;
    var CLASS_MINUTES = 45;
    var BREAK_MINUTES = 5;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_LIMIT = 20;

    var EMPTY_WORD = {
        '未知': true, '未知教师': true, '未知老师': true, '未知地点': true, '未知教室': true,
        '待定': true, '暂无': true, '暂无教师': true, '暂无老师': true, '暂无教室': true, '暂无地点': true
    };

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

    function intOf(value) {
        if (value === null || value === undefined || text(value) === '') return null;
        var number = Number(value);
        if (!isFinite(number) || Math.floor(number) !== number) return null;
        return number;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 'yyyy-MM-dd'（后面允许跟时间）→ 'yyyy-MM-dd'；形状不对返回 null
    function isoDayOf(value) {
        var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(text(value));
        return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
    }

    // 该日期所在周的周一；非法日期（如 2026-02-31）返回 null，不悄悄顺延
    function mondayOf(iso) {
        var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text(iso));
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
        var offset = (date.getUTCDay() + 6) % 7;
        var monday = new Date(date.getTime() - offset * 86400000);
        return monday.getUTCFullYear() + '-' + pad2(monday.getUTCMonth() + 1) + '-' + pad2(monday.getUTCDate());
    }

    // 'HH:mm' / 'H:mm' / 'HH:mm:ss' → 'HH:mm'；不合法返回 null
    function hhmmOf(value) {
        var m = /^([0-9]{1,2}):([0-9]{2})(:[0-9]{2})?$/.exec(text(value));
        if (!m) return null;
        var hour = parseInt(m[1], 10);
        var minute = parseInt(m[2], 10);
        if (hour > 23 || minute > 59) return null;
        return pad2(hour) + ':' + pad2(minute);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function clockOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    // ---------- 提醒：所有提醒都走这一个出口，统一限长、限条数 ----------
    var warnings = [];
    var omittedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) {
            omittedWarnings++;
            return;
        }
        warnings.push(line);
    }

    // ---------- 周次 ----------
    // 与上游 parseWeeksFromSkzc 一致：只看每个字符是不是 1，下标从第 1 周起，长度可变。
    function weeksOf(bitmap) {
        var source = bitmap === null || bitmap === undefined ? '' : String(bitmap);
        var weeks = [];
        var dropped = 0;
        for (var i = 0; i < source.length; i++) {
            if (source.charAt(i) !== '1') continue;
            if (i + 1 > MAX_WEEK) dropped++;
            else weeks.push(i + 1);
        }
        return { weeks: weeks, dropped: dropped };
    }

    function unionWeeks(a, b) {
        var seen = {};
        var out = [];
        var all = a.concat(b);
        for (var i = 0; i < all.length; i++) {
            if (seen['w' + all[i]]) continue;
            seen['w' + all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    // 升序周次 → 极大段：步长 1 是每周，步长 2 是单周或双周，落单的一周算每周
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

    // ---------- 教师 ----------
    // 上游 cleanTeacher：按英文逗号分段、每段取斜杠前的姓名（"姓名/工号" 的工号不是教师）。
    // 括号里的备注（如「张三（外聘）」）留在姓名里，不拆成第二位教师；占位词与空段丢掉。
    function teacherOf(raw) {
        var parts = text(raw).split(',');
        var names = [];
        for (var i = 0; i < parts.length; i++) {
            var name = text(parts[i].split('/')[0]);
            if (!name || EMPTY_WORD[name]) continue;
            if (names.indexOf(name) < 0) names.push(name);
        }
        return names.length ? names.join('、') : null;
    }

    // ---------- 一、课表行 → 排课条目 ----------
    // 条目 = 一条排课：{ kbId, name, teacher, location, day, start, end, weeks[] }
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    var droppedWeeks = 0;
    var entries = [];
    var seenRows = {};

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};
        var name = text(row.KCM);
        var bits = text(row.SKZC);
        var day = intOf(row.SKXQ);
        var start = intOf(row.KSJC);
        var end = intOf(row.JSJC);

        // 整行都空的占位行不是「被丢掉的课」，不计入跳过数
        if (!name && !bits && !text(row.SKXQ) && !text(row.KSJC) && !text(row.JSJC)) continue;

        // 同一份数据重复出现时先去重，避免提醒计数被放大
        var rowKey = JSON.stringify([text(row.KBID), name, text(row.SKJS), text(row.JASMC),
            text(row.SKXQ), text(row.KSJC), text(row.JSJC), bits]);
        if (seenRows[rowKey]) continue;
        seenRows[rowKey] = true;

        if (!name || name === '未知' || name === '未知课程') {
            missing.name++;
            continue;
        }
        if (!(day >= 1 && day <= 7)) {
            missing.day++;
            continue;
        }
        if (!(start >= 1 && end >= start && end <= MAX_PERIOD)) {
            missing.period++;
            continue;
        }
        var parsed = weeksOf(bits);
        droppedWeeks += parsed.dropped;
        if (!parsed.weeks.length) {
            missing.week++;
            continue;
        }
        entries.push({
            kbId: text(row.KBID),
            name: name,
            teacher: teacherOf(row.SKJS),
            location: realOrNull(row.JASMC),
            day: day,
            start: start,
            end: end,
            weeks: parsed.weeks
        });
    }

    // ---------- 二、调课 / 停课 ----------
    var changeFetchFailed = changeRows === null;
    var appliedChanges = 0;
    var removeOnly = 0;
    var unmatchedChanges = 0;
    var invalidChanges = 0;

    function keepWeeks(weeks) {
        var kept = [];
        for (var i = 0; i < weeks.length; i++) {
            if (weeks[i] <= MAX_WEEK) kept.push(weeks[i]);
        }
        return kept;
    }

    if (changeRows) {
        var seenChanges = {};
        for (var ci = 0; ci < changeRows.length; ci++) {
            var change = changeRows[ci] || {};
            // 同一条调课、停课记录重复出现时只应用一次，否则「已调整 N 处」会被放大
            var changeKey = JSON.stringify([text(change.KBID), text(change.SKZC), text(change.XSKZC),
                text(change.XSKXQ), text(change.XKSJC), text(change.XJSJC), text(change.XJASMC), text(change.XSKJS)]);
            if (seenChanges[changeKey]) continue;
            seenChanges[changeKey] = true;
            var kbId = text(change.KBID);
            var affected = [];
            if (kbId) {
                for (var ei = 0; ei < entries.length; ei++) {
                    if (entries[ei].kbId === kbId) affected.push(entries[ei]);
                }
            }
            if (!affected.length) {
                unmatchedChanges++;
                continue;
            }

            var applied = false;
            var moved = false;

            // 1. 停课：从原课剔除这次被调走的周次（上游用 includes，这里用下标查找）
            var removeWeeks = weeksOf(text(change.SKZC)).weeks;
            if (removeWeeks.length) {
                for (var ai = 0; ai < affected.length; ai++) {
                    var before = affected[ai].weeks.length;
                    var kept = [];
                    for (var wi = 0; wi < affected[ai].weeks.length; wi++) {
                        if (removeWeeks.indexOf(affected[ai].weeks[wi]) < 0) kept.push(affected[ai].weeks[wi]);
                    }
                    if (kept.length < before) applied = true;
                    affected[ai].weeks = kept;
                }
            }

            // 2. 调课：新周次、星期、节次齐全就落位；缺字段的按停课处理（上游口径）
            var newWeeks = weeksOf(text(change.XSKZC)).weeks;
            var newDay = intOf(change.XSKXQ);
            var newStart = intOf(change.XKSJC);
            var newEnd = intOf(change.XJSJC);
            if (newWeeks.length && newDay && newStart && newEnd) {
                if (!(newDay >= 1 && newDay <= 7) || !(newStart >= 1) || !(newEnd >= newStart) || newEnd > MAX_PERIOD) {
                    invalidChanges++;
                } else {
                    newWeeks = keepWeeks(newWeeks);
                    if (newWeeks.length) {
                        var newLocation = realOrNull(text(change.XJASMC) || text(change.JASMC));
                        var existing = null;
                        for (var mi = 0; mi < entries.length; mi++) {
                            var one = entries[mi];
                            if (one.kbId === kbId && one.day === newDay && one.start === newStart &&
                                one.end === newEnd && one.location === newLocation) {
                                existing = one;
                                break;
                            }
                        }
                        if (existing) {
                            existing.weeks = unionWeeks(existing.weeks, newWeeks);
                        } else {
                            entries.push({
                                kbId: kbId,
                                name: text(change.KCM) || affected[0].name,
                                teacher: teacherOf(change.XSKJS) || teacherOf(change.YSKJS) || affected[0].teacher,
                                location: newLocation,
                                day: newDay,
                                start: newStart,
                                end: newEnd,
                                weeks: newWeeks
                            });
                        }
                        moved = true;
                        applied = true;
                    }
                }
            }

            if (applied) {
                appliedChanges++;
                if (!moved) removeOnly++;
            }
        }
    }

    // ---------- 三、合并成课程与排课块 ----------
    var slots = {};
    var slotOrder = [];
    for (var si = 0; si < entries.length; si++) {
        var entry = entries[si];
        if (!entry.weeks.length) continue;
        var slotKey = JSON.stringify([entry.name, entry.teacher || '', entry.location || '',
            entry.day, entry.start, entry.end]);
        var slot = slots[slotKey];
        if (!slot) {
            slot = {
                name: entry.name, teacher: entry.teacher, location: entry.location,
                day: entry.day, start: entry.start, end: entry.end, weeks: []
            };
            slots[slotKey] = slot;
            slotOrder.push(slotKey);
        }
        slot.weeks = unionWeeks(slot.weeks, entry.weeks);
    }

    var slotList = [];
    for (var so = 0; so < slotOrder.length; so++) slotList.push(slots[slotOrder[so]]);
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

    var courseIndex = {};
    var courseOrder = [];
    var seenBlocks = {};
    var maxWeek = 0;
    var maxPeriod = 0;
    var minPeriod = 0;

    for (var li = 0; li < slotList.length; li++) {
        var item = slotList[li];
        var courseKey = JSON.stringify([item.name, item.teacher || '']);
        var course = courseIndex[courseKey];
        if (!course) {
            course = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            courseIndex[courseKey] = course;
            courseOrder.push(courseKey);
        }
        var runs = runsOf(item.weeks);
        for (var ri = 0; ri < runs.length; ri++) {
            var blockKey = JSON.stringify([courseKey, item.day, item.start, item.end,
                runs[ri].start, runs[ri].end, runs[ri].weekType, item.location || '']);
            if (seenBlocks[blockKey]) continue;
            seenBlocks[blockKey] = true;
            if (runs[ri].end > maxWeek) maxWeek = runs[ri].end;
            if (item.end > maxPeriod) maxPeriod = item.end;
            if (!minPeriod || item.start < minPeriod) minPeriod = item.start;
            course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: runs[ri].start,
                endWeek: runs[ri].end,
                weekType: runs[ri].weekType,
                location: item.location
            });
        }
    }

    if (!courseOrder.length) {
        throw new Error('这个学期没有解析到任何课程：'
            + (appliedChanges > 0 && entries.length > 0
                ? '按教务系统里的调课、停课记录调整后，本学期没有剩下的课，请在教务系统里核对'
                : '可能是本学期还没排课，请在「我的课表」里确认个人课表已经显示，再重新提取'));
    }

    var courses = [];
    for (var co = 0; co < courseOrder.length; co++) courses.push(courseIndex[courseOrder[co]]);

    // ---------- 四、学期名、开学日、总周数 ----------
    function termName() {
        var provided = text(term.name);
        if (provided) return provided;
        var m = /^([0-9]{4}-[0-9]{4})-([0-9]+)$/.exec(text(term.code));
        if (m) {
            var index = parseInt(m[2], 10);
            var label = index === 1 ? '第一学期' : (index === 2 ? '第二学期' : '第' + index + '学期');
            return SCHOOL + ' ' + m[1] + '学年' + label;
        }
        return SCHOOL;
    }

    var school = termName();

    var calendar = calendarRows[0] || {};
    var suppliedStart = isoDayOf(calendar.XQKSRQ);
    var firstDay = mondayOf(suppliedStart);
    if (firstDay) {
        if (firstDay !== suppliedStart) {
            warn('教务给出的开学日期是 ' + suppliedStart + '，第 1 周已回退到同一周的周一 ' + firstDay + '，请在学期管理里核对');
        }
    } else {
        firstDay = mondayOf(text(data.today));
        if (!firstDay) throw new Error('没能确定开学日期：教务给出的日期和本机日期都无法识别');
        warn('没能从教务读到合法的开学日期，第 1 周已按本机日期所在周的周一推算为 ' + firstDay + '，请在学期管理里核对');
    }

    var configuredWeeks = intOf(calendar.ZZC);
    var usedDefaultWeeks = !(configuredWeeks >= 1);
    if (usedDefaultWeeks) configuredWeeks = DEFAULT_WEEKS;
    var clampedWeeks = false;
    if (configuredWeeks > MAX_WEEK) {
        configuredWeeks = MAX_WEEK;
        clampedWeeks = true;
    }
    var totalWeeks = configuredWeeks;
    var raised = false;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        raised = true;
    }
    if (totalWeeks > MAX_WEEK) totalWeeks = MAX_WEEK;

    if (usedDefaultWeeks) {
        warn('教务没有给出有效的学期总周数，已按 20 周导入' + (raised ? '；课表排到更晚的周，另按课表调整' : '') + '，请在学期管理里核对');
    }
    if (clampedWeeks) warn('教务给出的学期总周数超过 30 周，已按 30 周导入，请在学期管理里核对');
    if (raised) {
        warn('课表里有第 ' + maxWeek + ' 周的课，超过原定的 ' + configuredWeeks + ' 周，学期总周数已按 ' + totalWeeks + ' 周导入，请在学期管理里核对');
    }

    // ---------- 五、节次时间：读教务启用的节次；表外节次按 H3 顺推 ----------
    var periodTimes = [];
    var sectionSeen = {};
    for (var pi = 0; pi < sectionRows.length; pi++) {
        var section = sectionRows[pi] || {};
        if (Number(section.SFSY) !== 1) continue;
        var number = intOf(section.DM);
        var sectionStart = hhmmOf(section.KSSJ);
        var sectionEnd = hhmmOf(section.JSSJ);
        if (!(number >= 1) || !sectionStart || !sectionEnd || minutesOf(sectionStart) >= minutesOf(sectionEnd)) continue;
        if (sectionSeen['p' + number]) continue;
        sectionSeen['p' + number] = true;
        periodTimes.push({ periodIndex: number, start: sectionStart, end: sectionEnd });
    }
    periodTimes.sort(function (a, b) { return a.periodIndex - b.periodIndex; });

    if (!periodTimes.length) {
        warn('没能从教务取到学校的节次时间，已用应用默认的节次时间，课程的节次时间可在学期管理里核对');
    } else if (maxPeriod > 0) {
        var filled = [];
        var uncoveredFrom = 0;
        var byIndex = {};
        for (var bi = 0; bi < periodTimes.length; bi++) byIndex['p' + periodTimes[bi].periodIndex] = periodTimes[bi];
        var lastEnd = null;
        for (var pti = 0; pti < periodTimes.length; pti++) {
            if (periodTimes[pti].periodIndex < minPeriod) lastEnd = minutesOf(periodTimes[pti].end);
        }
        for (var p = minPeriod; p <= maxPeriod; p++) {
            if (byIndex['p' + p]) {
                lastEnd = minutesOf(byIndex['p' + p].end);
                continue;
            }
            if (lastEnd === null) {
                uncoveredFrom = p;
                break;
            }
            var nextStart = lastEnd + BREAK_MINUTES;
            var nextEnd = nextStart + CLASS_MINUTES;
            if (nextEnd > 23 * 60 + 59) {
                uncoveredFrom = p;
                break;
            }
            var made = { periodIndex: p, start: clockOf(nextStart), end: clockOf(nextEnd) };
            periodTimes.push(made);
            byIndex['p' + p] = made;
            lastEnd = nextEnd;
            filled.push(p);
        }
        periodTimes.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        if (filled.length) {
            warn('课表用到了学校节次时间没有覆盖的' + sectionsText(filled) + '，已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在学期管理里核对');
        }
        if (uncoveredFrom) {
            warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
        }
    }

    // ---------- 六、其余提醒 ----------
    if (changeFetchFailed) {
        warn('没能取到教务系统里的调课、停课记录，课表可能没有反映最近的调整，请在教务系统里核对');
    }
    if (appliedChanges > 0) {
        warn('已按教务系统里的调课、停课记录调整了 ' + appliedChanges + ' 处上课安排'
            + (removeOnly > 0 ? '（其中 ' + removeOnly + ' 处只去掉了原来的上课周次，没有排新的上课时间）' : '')
            + '，请核对调整后的课表');
    }
    if (unmatchedChanges > 0) {
        warn('有 ' + unmatchedChanges + ' 条调课、停课记录没能对上课表里原来的课，没有应用，请在教务系统里核对');
    }
    if (invalidChanges > 0) {
        warn('有 ' + invalidChanges + ' 条调课记录给的新上课时间不完整或不合规，没有按新时间排课，请在教务系统里核对');
    }

    // 未定时间课程：上游只提醒不导入；按课名去重，点名前 3 门，课名截 20 字
    if (undeterminedRows.length) {
        var undeterminedNames = [];
        var undeterminedSeen = {};
        var undeterminedCount = 0;
        for (var ui = 0; ui < undeterminedRows.length; ui++) {
            var undeterminedName = text((undeterminedRows[ui] || {}).KCM);
            var undeterminedKey = 'n' + undeterminedName;
            if (undeterminedSeen[undeterminedKey]) continue;
            undeterminedSeen[undeterminedKey] = true;
            undeterminedCount++;
            if (undeterminedName && undeterminedNames.length < 3) undeterminedNames.push(shortName(undeterminedName));
        }
        warn('另有 ' + undeterminedCount + ' 门课程上课时间暂未确定，没有导入'
            + (undeterminedNames.length ? '（例如 ' + undeterminedNames.join('、') + '）' : '')
            + '，时间确定后请重新提取');
    }

    var rowTotal = intOf(data.rowTotal);
    if (rowTotal !== null && rowTotal > rows.length) {
        warn('教务系统说这个学期有 ' + rowTotal + ' 条排课记录，实际只取到 ' + rows.length + ' 条，课表可能不完整，请重新提取或反馈');
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
    if (droppedWeeks > 0) warn('有 ' + droppedWeeks + ' 个周次超过第 30 周，超出的部分没有导入');

    var missingTeacher = 0;
    var missingLocation = 0;
    var samples = [];
    for (var cj = 0; cj < courses.length; cj++) {
        var one = courses[cj];
        var lacksTeacher = !one.teacher;
        var lacksLocation = false;
        for (var bk = 0; bk < one.blocks.length; bk++) {
            if (!one.blocks[bk].location) lacksLocation = true;
        }
        if (lacksTeacher) missingTeacher++;
        if (lacksLocation) missingLocation++;
        if ((lacksTeacher || lacksLocation) && samples.length < 3 && samples.indexOf(shortName(one.name)) < 0) {
            samples.push(shortName(one.name));
        }
    }
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        warn('有 ' + fieldParts.join('、') + '（例如 ' + samples.join('、') + '）：已照常导入，空着的项可在「编辑课程」里补上');
    }

    if (omittedWarnings > 0) warnings[MAX_WARNINGS - 1] = '另有 ' + omittedWarnings + ' 条核对提示超出上限未显示';

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: warnings,
        terms: [{
            name: school,
            firstDay: firstDay,
            totalWeeks: totalWeeks,
            periodTimes: periodTimes,
            courses: courses
        }]
    });
})()
