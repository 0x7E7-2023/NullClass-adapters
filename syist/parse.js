(function () {
    // 沈阳科技学院教务适配器（金智教育 WIS / jwapp 平台，wdkb「我的课表」应用）—— 原始数据 → 空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 SYIST/syist_01.js（MIT，上游 maintainer 星河欲转）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：19a65bf（2026-10-19）；本校脚本最后一次修改：80e30cf
    //
    // 这一段是纯转换（不碰 DOM、不发请求、不读挂钟时间），所以能在 CI 里用 Rhino 跑回归。
    // 「今天」由 extract.js 交进来（data.today），开学日的推算只看它，fixture 因此可以复现。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 周次：上游把 SKZC 位串展开成逐周数组；这里切成极大段（ALL / ODD / EVEN），落单的一周单独成段。
    //   ② 调课 / 停课：照上游 applyCourseChanges 的口径（按 KBID + 星期 + 起止节次对回原来的课，去掉 SKZC 里的周次；
    //      TKLXDM 为 01 / 03 且给了新的周次、星期、节次时，另排一条新的课），并做了三处补强：
    //      记录按申请时间从早到晚处理（连续两次调同一节课时第二次才对得上）、对不上原课的记录计数提醒、
    //      只去掉了原课而没有排新时间的计数提醒；上游对这几种情形都是静默跳过。
    //   ③ 教师 / 教室：上游取 SKJS 按斜杠切开的第一段（没有 SKJS 用 JSM）、教室缺省写「待定」；这里教师保留全部
    //      （去掉工号、去重；SKJS 里一个名字都没有时改用 JSM），拿不到就留 null，教室同样留 null，按类型汇总进提醒
    //      （上游的「待定」会被当成真教室显示）。
    //   ④ 实验课：上游把实验课表行（SYXMMC 实验项目名）和理论课混在一起，课名拼成「课名 - 实验项目」；这里同样拼，
    //      但实验项目名为空时就用课名（上游会拼出「课名 - 」）。实验课表没取到时写进提醒（上游只在控制台留话）。
    //   ⑤ 节次时间：优先用教务节次接口给的（任何一行不合法就整表回落），取不到回落上游写死的 12 节（45 分钟一节）；
    //      课表用到更晚的节次时，按上一节下课后课间 10 分钟、每节 45 分钟逐节顺推补齐，越过 23:59 就停，
    //      补了哪些都写进提醒（批次五统一修订 H3）。
    //   ⑥ 开学日 / 总周数：校历取教务的 XQKSRQ / ZZC（开学日回退到那一周的周一，上游原样保存、不回退）；校历取不到时
    //      开学日按本机日期推算（上游没有这种回落）、总周数用上游的 20（课表更晚就抬高），都写进提醒。
    //   ⑦ 合并：上游的两阶段合并（连续节次、同节次的周次）这里照做——同一门课、同教师、同教室、同星期、同节次的周次并集，
    //      再把周次段相同、节次首尾相接的合成一段（1-2 节 + 3-4 节 → 1-4 节）；完全重复的排课只留一份。
    //   ⑧ 不静默丢课：缺课名 / 星期 / 节次 / 周次的行、超出 30 周的周次，计数写进提醒。
    //
    // 输入（extract.js 交出来的教务原始数据）：
    //   { term: { code, name, source }, today, rowTotal,
    //     rows:           [ 理论课表行 ],
    //     experimentRows: [ 实验课表行 ] 或 null（没取到）,
    //     changeRows:     [ 调课记录 ] 或 null（没取到）,
    //     calendarRows:   [ 校历行 ],
    //     timeSlotRows:   [ 节次行 ] }
    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var rows = data.rows instanceof Array ? data.rows : [];
    var experimentRows = data.experimentRows instanceof Array ? data.experimentRows : null;
    var changeRows = data.changeRows instanceof Array ? data.changeRows : null;
    var calendarRows = data.calendarRows instanceof Array ? data.calendarRows : [];
    var timeSlotRows = data.timeSlotRows instanceof Array ? data.timeSlotRows : [];
    var term = data.term || {};

    var SCHOOL_NAME = '沈阳科技学院';
    var MAX_WEEKS = 30;              // 载荷校验要求 totalWeeks 在 1..30
    var DEFAULT_TOTAL_WEEKS = 20;    // 上游 fetchSemesterConfig 里取不到时写死的总周数
    var MAX_PERIOD = 20;             // 单日节次上限：超过它一定是脏数据
    var MAX_WARNINGS = 20;           // 载荷校验：warnings 最多 20 条
    var MAX_WARNING_TEXT = 200;      // 载荷校验：每条最多 200 字
    var NAME_TEXT_LIMIT = 20;        // 提醒里点名的课名最多显示的字数
    var EXTEND_BREAK_MINUTES = 10;   // 顺推补节次：课间几分钟（上游节次表里最常见的课间）
    var EXTEND_CLASS_MINUTES = 45;   // 顺推补节次：每节几分钟（上游每节 45 分钟）

    // 教务节次接口取不到或不合法时用的备用节次时间（12 节），逐节照抄上游 DEFAULT_TIME_SLOTS
    var DEFAULT_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:20', end: '09:05' },
        { periodIndex: 2, start: '09:10', end: '09:55' },
        { periodIndex: 3, start: '10:10', end: '10:55' },
        { periodIndex: 4, start: '11:00', end: '11:45' },
        { periodIndex: 5, start: '13:30', end: '14:15' },
        { periodIndex: 6, start: '14:20', end: '15:05' },
        { periodIndex: 7, start: '15:15', end: '16:00' },
        { periodIndex: 8, start: '16:05', end: '16:50' },
        { periodIndex: 9, start: '17:20', end: '18:05' },
        { periodIndex: 10, start: '18:15', end: '19:00' },
        { periodIndex: 11, start: '19:10', end: '19:55' },
        { periodIndex: 12, start: '20:05', end: '20:50' }
    ];

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

    // 课名过长时截短，免得一个超长课名把整条提醒撑破 200 字的上限（超了整次导入被拒）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    // ---------- 提醒：所有提醒都从这一个出口走，统一限长、限条数 ----------
    var warnings = [];
    var omittedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS - 1) { omittedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 日期 ----------

    // 日期前缀 yyyy-MM-dd（后面允许跟时间，如 '2026-02-25 00:00:00'）→ 'yyyy-MM-dd'；形状不对返回 null
    function isoDayOf(value) {
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
        return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
    }

    // 'yyyy-MM-dd' → 该日期所在周的周一（周一原样返回）。非法日期（如 2026-02-31）返回 null，不悄悄顺延到下个月。
    function mondayOnOrBefore(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
            return null;
        }
        var offset = (date.getUTCDay() + 6) % 7;
        var monday = new Date(date.getTime() - offset * 86400000);
        return monday.getUTCFullYear() + '-' + pad2(monday.getUTCMonth() + 1) + '-' + pad2(monday.getUTCDate());
    }

    // ---------- 周次 ----------

    // SKZC 位串：第 i 位（从 0 起）为 1 表示第 i+1 周。不是位串就返回 null。
    function weeksFromBits(bits) {
        if (!/^[01]+$/.test(bits)) return null;
        var weeks = [];
        for (var i = 0; i < bits.length; i++) {
            if (bits.charAt(i) === '1') weeks.push(i + 1);
        }
        return weeks;
    }

    // 升序周次集合 → 极大段。步长 1 是每周（ALL）；步长 2 是单周或双周（ODD / EVEN，由起始周的奇偶决定）；落单的一周记为 ALL。
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

    // ---------- 学期 ----------

    // 学期编号 2026-2027-1 → 「2026-2027学年第一学期」；形状不对返回 ''
    function termNameFrom(code) {
        var m = /^(\d{4})-(\d{4})-(\d{1,2})$/.exec(String(code));
        if (!m) return '';
        var index = parseInt(m[3], 10);
        var label = index === 1 ? '第一学期' : (index === 2 ? '第二学期' : '第' + index + '学期');
        return m[1] + '-' + m[2] + '学年' + label;
    }

    // 校历：extract.js 是按学期编号拆出的 XN、XQ 去问的，教务只会返回这个学期的行（上游直接取第一行）。
    // 行里若带了 XN / XQ，必须和学期编号对得上才算；没带的就认（请求已经限定了学期）。找不到返回 null，按没有校历处理。
    function findCalendarRow(list, code) {
        var parts = code.split('-');
        if (parts.length < 3) return null;
        for (var i = 0; i < list.length; i++) {
            var one = list[i] || {};
            var year = text(one.XN);
            var index = text(one.XQ);
            if (year && year !== parts[0] + '-' + parts[1]) continue;
            if (index && intOf(index) !== intOf(parts[2])) continue;
            return one;
        }
        return null;
    }

    // ---------- 教师 ----------

    // 多名用 / 、, ， ; ； 分隔，拆开后丢掉空片段与含数字的片段（SKJS 常写成「姓名/工号」，工号不是教师），
    // 去重后以「、」连接；拿不到就是 null
    function teacherOf(raw) {
        var names = [];
        var parts = text(raw).split(/[\/、,，;；]/);
        for (var i = 0; i < parts.length; i++) {
            var name = text(parts[i]);
            if (!name || /\d/.test(name)) continue;
            if (names.indexOf(name) < 0) names.push(name);
        }
        return names.length ? names.join('、') : null;
    }

    // ---------- 节次时间 ----------

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    // 节次时间：接受 0800 与 08:00 两种写法，统一成 HH:mm；不合法返回 null
    function normTime(raw) {
        var m = /^(\d{1,2}):?(\d{2})$/.exec(text(raw));
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var min = parseInt(m[2], 10);
        if (h > 23 || min > 59) return null;
        return pad2(h) + ':' + pad2(min);
    }

    // 教务节次表校验。返回 null 表示没有给出节次（空表）；返回 false 表示有行不合法；返回数组表示可用。
    // 合法的条件：节次号从 1 起连续、每节的时间是合法 HH:mm、结束晚于开始。
    function periodTimesFrom(slotRows) {
        if (!slotRows.length) return null;
        var slots = [];
        for (var i = 0; i < slotRows.length; i++) {
            var one = slotRows[i] || {};
            var n = intOf(one.DM);
            var start = normTime(one.KSSJ);
            var end = normTime(one.JSSJ);
            if (!(n >= 1) || !start || !end || minutesOf(end) <= minutesOf(start)) return false;
            slots.push({ periodIndex: n, start: start, end: end });
        }
        slots.sort(function (a, b) {
            return a.periodIndex - b.periodIndex;
        });
        for (var k = 0; k < slots.length; k++) {
            if (slots[k].periodIndex !== k + 1) return false;
        }
        return slots;
    }

    // 节次号（已升序）写成「第 13-14 节」「第 13 节」「第 13、15 节」这几种
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

    // 上课地点：就是教室名（上游同样只用教室名）；没有教室是 null
    function locationOf(room) {
        return text(room) || null;
    }

    // 课名：实验课行带实验项目名（SYXMMC），拼成「课名 - 实验项目」（上游口径）；没有项目名就是课名
    function courseNameOf(row) {
        var base = text(row.KCM);
        var project = text(row.SYXMMC);
        if (base && project) return base + ' - ' + project;
        return base || project;
    }

    // ---------- 一、课表行（理论 + 实验）→ 条目 ----------
    // 条目 = 一条排课：{ kbId, name, teacher(已整理，可空), room(原文), day, start, end, weeks[] }

    var entries = [];
    var skipped = 0;        // 缺课名 / 星期不合法 / 节次不合法 / 没有周次（含周次不是位串）
    var droppedWeeks = 0;   // 超出 30 周的周次

    function keepWeeks(weeks) {
        var kept = [];
        for (var i = 0; i < weeks.length; i++) {
            if (weeks[i] <= MAX_WEEKS) kept.push(weeks[i]);
            else droppedWeeks++;
        }
        return kept;
    }

    var allRows = rows.concat(experimentRows || []);
    for (var i = 0; i < allRows.length; i++) {
        var row = allRows[i] || {};
        var name = courseNameOf(row);
        var bits = text(row.SKZC);
        var day = intOf(row.SKXQ);
        var startPeriod = intOf(row.KSJC);
        var endPeriod = intOf(row.JSJC);

        // 课名、星期、周次都空的占位行不是「被丢掉的课」，不计入跳过数
        if (!name && !bits && !text(row.SKXQ)) continue;

        var rawWeeks = weeksFromBits(bits);

        if (!name || !(day >= 1 && day <= 7) || !(startPeriod >= 1) || !(endPeriod >= startPeriod) ||
            endPeriod > MAX_PERIOD || !rawWeeks || !rawWeeks.length) {
            skipped++;
            continue;
        }

        var weeks = keepWeeks(rawWeeks);
        if (!weeks.length) continue;

        entries.push({
            kbId: text(row.KBID),
            name: name,
            teacher: teacherOf(row.SKJS) || teacherOf(row.JSM),
            room: text(row.JASMC),
            day: day,
            start: startPeriod,
            end: endPeriod,
            weeks: weeks
        });
    }

    // ---------- 二、调课 / 停课 ----------

    // 记录按申请时间从早到晚处理：连续两次调同一节课时，第二次的「原时间」是第一次排出来的新时间。
    // 只有每条记录都带申请时间才排序（字符串比较，教务的时间格式是 yyyy-MM-dd HH:mm:ss）；否则保持教务给的顺序。
    function orderedChanges(list) {
        var items = [];
        var allDated = true;
        for (var k = 0; k < list.length; k++) {
            items.push({ index: k, change: list[k] || {} });
            if (!text((list[k] || {}).SQSJ)) allDated = false;
        }
        if (allDated) {
            items.sort(function (a, b) {
                var ta = text(a.change.SQSJ);
                var tb = text(b.change.SQSJ);
                if (ta < tb) return -1;
                if (ta > tb) return 1;
                return a.index - b.index;
            });
        }
        var out = [];
        for (var m = 0; m < items.length; m++) out.push(items[m].change);
        return out;
    }

    var changeFetchFailed = changeRows === null;
    var appliedChanges = 0;    // 真正改动了课表的记录数
    var removeOnly = 0;        // 其中只去掉了原来的周次、没有排新时间的
    var unmatchedChanges = 0;  // 对不上原来的课，没有应用
    var roomKept = 0;          // 调课后没给新教室，沿用了原来的教室

    if (changeRows) {
        var ordered = orderedChanges(changeRows);
        for (var ci = 0; ci < ordered.length; ci++) {
            var change = ordered[ci];
            var kbId = text(change.KBID);
            var cDay = intOf(change.SKXQ);
            var cStart = intOf(change.KSJC);
            var cEnd = intOf(change.JSJC);

            var affected = [];
            if (kbId) {
                for (var ei = 0; ei < entries.length; ei++) {
                    var entry = entries[ei];
                    if (entry.kbId === kbId && entry.day === cDay && entry.start === cStart && entry.end === cEnd) {
                        affected.push(entry);
                    }
                }
            }
            if (!affected.length) {
                unmatchedChanges++;
                continue;
            }

            var applied = false;
            var removeWeeks = weeksFromBits(text(change.SKZC)) || [];
            if (removeWeeks.length) {
                for (var ai = 0; ai < affected.length; ai++) {
                    var kept = [];
                    for (var wi = 0; wi < affected[ai].weeks.length; wi++) {
                        if (removeWeeks.indexOf(affected[ai].weeks[wi]) < 0) kept.push(affected[ai].weeks[wi]);
                    }
                    if (kept.length < affected[ai].weeks.length) applied = true;
                    affected[ai].weeks = kept;
                }
            }

            var moved = false;
            var kind = text(change.TKLXDM);
            if ((kind === '01' || kind === '03') && text(change.XSKZC) && text(change.XSKXQ) &&
                text(change.XKSJC) && text(change.XJSJC)) {
                var newWeeks = weeksFromBits(text(change.XSKZC)) || [];
                var nDay = intOf(change.XSKXQ);
                var nStart = intOf(change.XKSJC);
                var nEnd = intOf(change.XJSJC);
                if (newWeeks.length && nDay >= 1 && nDay <= 7 && nStart >= 1 && nEnd >= nStart && nEnd <= MAX_PERIOD) {
                    newWeeks = keepWeeks(newWeeks);
                    if (newWeeks.length) {
                        var newRoom = text(change.XJASMC);
                        if (!newRoom) {
                            newRoom = text(change.JASMC) || affected[0].room;
                            if (newRoom) roomKept++;
                        }
                        // 课名沿用原课的（实验课的课名带着实验项目，记录里的 KCM 只有课名）
                        entries.push({
                            kbId: kbId,
                            name: affected[0].name,
                            teacher: teacherOf(change.XSKJS) || teacherOf(change.YSKJS) || affected[0].teacher,
                            room: newRoom,
                            day: nDay,
                            start: nStart,
                            end: nEnd,
                            weeks: newWeeks
                        });
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
    // 先按（课程、星期、节次、教室）把周次并成一个集合再切段（上游阶段 2），
    // 再把周次段相同、节次首尾相接的合成一段（上游阶段 1）。完全重复的排课在并集里自然只剩一份。

    var courseIndex = {};
    var courseOrder = [];
    var groupIndex = {};
    var groupOrder = [];

    for (var ni = 0; ni < entries.length; ni++) {
        var item = entries[ni];
        if (!item.weeks.length) continue;
        var location = locationOf(item.room);
        var courseKey = JSON.stringify([item.name, item.teacher || '']);
        if (!courseIndex[courseKey]) {
            courseIndex[courseKey] = { name: item.name, teacher: item.teacher, note: null, blocks: [] };
            courseOrder.push(courseKey);
        }
        var groupKey = JSON.stringify([courseKey, item.day, item.start, item.end, location]);
        var group = groupIndex[groupKey];
        if (!group) {
            group = { courseKey: courseKey, day: item.day, start: item.start, end: item.end, location: location, weekSet: {} };
            groupIndex[groupKey] = group;
            groupOrder.push(groupKey);
        }
        for (var gw = 0; gw < item.weeks.length; gw++) group.weekSet[item.weeks[gw]] = true;
    }

    for (var gi = 0; gi < groupOrder.length; gi++) {
        var one = groupIndex[groupOrder[gi]];
        var groupWeeks = [];
        for (var w = 1; w <= MAX_WEEKS; w++) {
            if (one.weekSet[w]) groupWeeks.push(w);
        }
        var runs = runsOf(groupWeeks);
        for (var ri = 0; ri < runs.length; ri++) {
            courseIndex[one.courseKey].blocks.push({
                dayOfWeek: one.day,
                startPeriod: one.start,
                endPeriod: one.end,
                startWeek: runs[ri].start,
                endWeek: runs[ri].end,
                weekType: runs[ri].weekType,
                location: one.location
            });
        }
    }

    // 同一门课里，星期、周次段、教室都相同且节次首尾相接的两块合成一块；反复合并到不能再合为止
    function mergeAdjacent(blocks) {
        var changed = true;
        while (changed) {
            changed = false;
            for (var a = 0; a < blocks.length && !changed; a++) {
                for (var b = 0; b < blocks.length; b++) {
                    if (a === b) continue;
                    var x = blocks[a];
                    var y = blocks[b];
                    if (x.dayOfWeek === y.dayOfWeek && x.startWeek === y.startWeek && x.endWeek === y.endWeek &&
                        x.weekType === y.weekType && x.location === y.location && x.endPeriod + 1 === y.startPeriod) {
                        x.endPeriod = y.endPeriod;
                        blocks.splice(b, 1);
                        changed = true;
                        break;
                    }
                }
            }
        }
    }

    var maxWeek = 0;
    var maxPeriod = 0;
    for (var mi = 0; mi < courseOrder.length; mi++) {
        var mergedCourse = courseIndex[courseOrder[mi]];
        mergeAdjacent(mergedCourse.blocks);
        for (var mb = 0; mb < mergedCourse.blocks.length; mb++) {
            if (mergedCourse.blocks[mb].endWeek > maxWeek) maxWeek = mergedCourse.blocks[mb].endWeek;
            if (mergedCourse.blocks[mb].endPeriod > maxPeriod) maxPeriod = mergedCourse.blocks[mb].endPeriod;
        }
    }

    if (courseOrder.length === 0) {
        throw new Error('没有解析到任何课程' + (droppedWeeks > 0
            ? '：课表里的周次都超过了第 ' + MAX_WEEKS + ' 周（应用最多支持 ' + MAX_WEEKS + ' 周）'
            : (appliedChanges > 0
                ? '：按教务系统里的调课、停课记录调整后，本学期没有剩下的课'
                : '：可能是本学期还没排课。请在教务页面里确认课表已经显示出来，再重新提取')));
    }

    // ---------- 四、学期与开学日 ----------

    var code = text(term.code);
    if (text(term.source) === 'guess') {
        warn('没能从教务获取当前学期，已按本机日期推算为 ' + (termNameFrom(code) || code) + '，请核对导入的是不是本学期');
    }

    var calendarRow = findCalendarRow(calendarRows, code);
    var firstDay = mondayOnOrBefore(isoDayOf(calendarRow && calendarRow.XQKSRQ));
    if (!firstDay) {
        firstDay = mondayOnOrBefore(text(data.today));
        if (!firstDay) throw new Error('没能确定开学日期：教务没有给出，本机日期也不合法');
        warn('没能从教务取到开学日期，已按本机日期推算为 ' + firstDay + '（当前周的周一），请在学期管理里核对');
    }

    // ---------- 五、总周数 ----------

    var calendarWeeks = calendarRow ? intOf(calendarRow.ZZC) : null;
    var calendarKnown = calendarWeeks !== null && calendarWeeks >= 1;
    var totalWeeks = calendarKnown ? calendarWeeks : DEFAULT_TOTAL_WEEKS;
    var clampedWeeks = totalWeeks > MAX_WEEKS;
    if (clampedWeeks) totalWeeks = MAX_WEEKS;
    var raised = totalWeeks < maxWeek;
    if (raised) totalWeeks = maxWeek;

    if (clampedWeeks) {
        warn('教务给的学期总周数是 ' + calendarWeeks + ' 周，超过了应用支持的 ' + MAX_WEEKS + ' 周，已按 ' +
            MAX_WEEKS + ' 周导入，请核对');
    } else if (raised && calendarKnown) {
        warn('教务给的学期总周数是 ' + calendarWeeks + ' 周，但课表里有第 ' + maxWeek + ' 周的课，已按 ' +
            totalWeeks + ' 周导入，请在学期管理里核对');
    } else if (raised) {
        warn('没能从教务取到学期总周数，课表里最晚排到第 ' + maxWeek + ' 周，已按 ' + totalWeeks +
            ' 周导入，如与实际不符可在学期管理里改');
    } else if (!calendarKnown) {
        warn('没能从教务取到学期总周数，已按 ' + DEFAULT_TOTAL_WEEKS + ' 周导入，如与实际不符可在学期管理里改');
    }

    // ---------- 六、节次时间：教务给的优先，取不到回落备用的 12 节；课表用到更晚的节次时逐节顺推补齐 ----------

    var periodTimes = periodTimesFrom(timeSlotRows);
    if (periodTimes === null) {
        periodTimes = DEFAULT_PERIOD_TIMES.slice(0);
        warn('没能从教务取到节次时间，已改用备用的节次时间（第 1 节 ' + DEFAULT_PERIOD_TIMES[0].start + ' 开始，共 ' +
            DEFAULT_PERIOD_TIMES.length + ' 节），请核对上课时间');
    } else if (periodTimes === false) {
        periodTimes = DEFAULT_PERIOD_TIMES.slice(0);
        warn('教务给的节次时间有不合法的地方（格式不对、结束不晚于开始，或节次号不连续），已整表改用备用的节次时间（共 ' +
            DEFAULT_PERIOD_TIMES.length + ' 节），请核对上课时间');
    }
    var knownPeriods = periodTimes.length;
    var extended = [];
    var uncoveredFrom = 0;
    for (var p = knownPeriods + 1; p <= maxPeriod; p++) {
        var prev = periodTimes[periodTimes.length - 1];
        var nextStart = minutesOf(prev.end) + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        extended.push(p);
    }
    if (extended.length) {
        warn('学校公布的节次时间只到第 ' + knownPeriods + ' 节，课表用到了' + sectionsText(extended) +
            '，已按上一节下课后课间 ' + EXTEND_BREAK_MINUTES + ' 分钟、每节 ' + EXTEND_CLASS_MINUTES +
            ' 分钟顺推补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间' +
            '（课程已导入），请在学期管理里补上');
    }

    // ---------- 七、其余提醒 ----------

    if (experimentRows === null) {
        warn('没能取到教务系统里的实验课安排，课表里可能缺少实验课，请在教务系统里核对');
    }
    if (changeFetchFailed) {
        warn('没能取到教务系统里的调课、停课记录，课表可能没有反映最近的调整，请在教务系统里核对');
    }
    if (appliedChanges > 0) {
        warn('已按教务系统里的调课、停课记录调整了 ' + appliedChanges + ' 处上课安排' +
            (removeOnly > 0 ? '（其中 ' + removeOnly + ' 处只去掉了原来的上课周次，没有排新的上课时间）' : '') +
            '，请核对调整后的课表');
    }
    if (unmatchedChanges > 0) {
        warn('有 ' + unmatchedChanges + ' 条调课、停课记录没能对上课表里原来的课，没有应用，请在教务系统里核对');
    }
    if (roomKept > 0) {
        warn('有 ' + roomKept + ' 条调课记录没给调课后的教室，暂时沿用了原来的教室，请核对');
    }

    var rowTotal = intOf(data.rowTotal);
    if (rowTotal !== null && rowTotal > rows.length) {
        warn('教务系统说这个学期有 ' + rowTotal + ' 条排课记录，实际只取到 ' + rows.length +
            ' 条，课表可能不完整，请重新提取或反馈');
    }
    if (skipped > 0) {
        warn('有 ' + skipped + ' 条排课记录缺少课名、星期、节次或周次（或节次不在 1-' + MAX_PERIOD + ' 之间），没有导入');
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超过了第 ' + MAX_WEEKS + ' 周，超出的部分没有导入');
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），按类型汇总计数、点名课名截 20 字，不静默
    var missingTeacher = 0;
    var missingLocation = 0;
    var samples = [];
    for (var ci2 = 0; ci2 < courseOrder.length; ci2++) {
        var summary = courseIndex[courseOrder[ci2]];
        var lacksLocation = false;
        for (var bi = 0; bi < summary.blocks.length; bi++) {
            if (!summary.blocks[bi].location) lacksLocation = true;
        }
        var lacksTeacher = !summary.teacher;
        if (lacksTeacher) missingTeacher++;
        if (lacksLocation) missingLocation++;
        if ((lacksTeacher || lacksLocation) && samples.length < 3 && samples.indexOf(shortName(summary.name)) < 0) {
            samples.push(shortName(summary.name));
        }
    }
    if (missingTeacher > 0 || missingLocation > 0) {
        var parts = [];
        if (missingTeacher > 0) parts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) parts.push(missingLocation + ' 门课没给上课地点');
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn('有 ' + parts.join('、') + '（例如 ' + samples.join('、') + '）：已照常导入，' + emptyText +
            '，可在「编辑课程」里补上');
    }

    // 兜底：提醒真到了上限就说清楚（正常路径下用不到）
    if (omittedWarnings > 0) {
        warnings.push('还有 ' + omittedWarnings + ' 条提示没有显示（最多 ' + MAX_WARNINGS + ' 条）');
    }

    var courses = [];
    for (var cj = 0; cj < courseOrder.length; cj++) courses.push(courseIndex[courseOrder[cj]]);

    var termLabel = termNameFrom(code);
    var termName = text(term.name) || (termLabel ? SCHOOL_NAME + ' ' + termLabel : SCHOOL_NAME);

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
