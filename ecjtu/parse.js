(function () {
    // 华东交通大学课表解析 —— 第二步：教务课表页的行文字 → 空课课表载荷。
    // 移植自 shiguang_warehouse 的 ECJTU/ecjtu_01.js（MIT，作者 glxgo）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //   上游快照 baf83fa；本校脚本提交 1fe584c（2026-08-23）
    // 上游的核心是 parseScheduleTable() + parseCourseLines() + mergeCourses()：
    // 一格一天，格子里每三门行一组「课名 / 教师@地点 / 周次 节次」。
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 不再要求格子里有「教师@地点」行（上游把没有 @ 的整格丢掉）：缺教师 / 缺教室照样导入，
    //      按类型汇总进提醒
    //   ② 节次列表按连续段拆安排：1,2,3 合成 1-3；同一天 1,3 拆成 1 节与 3 节两条
    //      （上游按首尾节次补满中间，1,3 会变成 1-3）
    //   ③ 周次兼容 1-8周 / 1-8,10-16 / (单)1-8周,(双)9-16周 / 第1周至第8周 / 裸数字；
    //      单双标记按逗号段各自判，无逗号的前置标记归下一段
    //   ④ 星期按表头列号对齐（上游把「第几个格子」当星期几）
    //   ⑤ 学期总周数默认 20，不把课表里出现的最大周当学期长度（上游取最大周）
    //   ⑥ 开学日按提取当天回退到周一推算，并写进提醒
    //   ⑦ 节次超出内置 10 节表时按「统一修订 H3」逐节补齐
    //
    // 这一步是纯转换：没有网络、没有 DOM（CI 的 Rhino 里两个都没有），只吃字符串和正则。
    var data = JSON.parse(__ncInput);
    if (!data || typeof data !== 'object') {
        throw new Error('没有拿到教务数据：请重新登录教务系统后再点「提取课表」');
    }
    var rows = data.rows || [];
    var term = data.term || {};

    // 学校节次时间：上游脚本 savePresetTimeSlots 里那张表，逐节照抄（10 节）。
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:05', end: '10:50' },
        { periodIndex: 4, start: '10:55', end: '11:40' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:25', end: '16:10' },
        { periodIndex: 7, start: '16:40', end: '17:25' },
        { periodIndex: 8, start: '17:35', end: '18:20' },
        { periodIndex: 9, start: '19:00', end: '19:45' },
        { periodIndex: 10, start: '19:55', end: '20:40' }
    ];
    // 空课默认的 12 节表：课表用到更晚的节次时，先用它补（H3：开始时间不早于上一节下课才用）
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
    var EXTEND_BREAK_MINUTES = 5;
    var EXTEND_CLASS_MINUTES = 45;
    var DEFAULT_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;
    var MAX_PERIOD = 30;
    var ZERO_WIDTH = new RegExp('[' + String.fromCharCode(8203, 8204, 8205, 65279) + ']', 'g');
    var NBSP = String.fromCharCode(160);

    var droppedWeeks = 0;
    var droppedSections = 0;
    var noName = 0;
    var noWeek = 0;
    var noPeriod = 0;
    var labelFilled = 0;
    var oddWeekTexts = [];
    var warnings = [];

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(ZERO_WIDTH, '')
            .replace(new RegExp(NBSP, 'g'), ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // 拼进提醒的教务原文一律截到 20 字，保证末尾「请核对…」不被 200 字上限切掉
    function shortName(value) {
        var text = clean(value);
        if (text.length > 20) return text.substring(0, 20) + '…';
        return text;
    }

    // 每条提醒的唯一出口：≤200 字
    function warn(message) {
        var text = String(message);
        if (text.length > 200) text = text.substring(0, 199) + '…';
        warnings.push(text);
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 提取时刻所在周的周一（§4.3：firstDay 是第 1 周的第一天，上游 firstDayOfWeek = 1）
    function mondayOf(isoDate) {
        var m = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})/.exec(clean(isoDate));
        if (!m) return null;
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        var back = (day.getDay() + 6) % 7;
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() - back));
    }

    function uniqueSorted(list) {
        var seen = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var value = list[i];
            if (value >= 1 && !seen[value]) {
                seen[value] = true;
                out.push(value);
            }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    function pushWeek(out, week, oddOnly, evenOnly) {
        if (isNaN(week) || week < 1) return;
        if (week > MAX_WEEK) {
            droppedWeeks++;
            return;
        }
        if (oddOnly && week % 2 === 0) return;
        if (evenOnly && week % 2 === 1) return;
        out.push(week);
    }

    // 无逗号的前置 / 后置单双标记：
    //   (单)1-8周(双)9-16周 —— 段首就有标记，后面那个标记属于下一段，前面补逗号；
    //   1-8周(单)9-16周(双) —— 段首没有标记，标记属于前一段，后面补逗号。
    function glueMarkers(text) {
        return text.replace(/[(（]?\s*([单双])\s*[)）]?\s*(?=[0-9])/g, function (all, mark, offset, source) {
            var before = source.substring(0, offset);
            if (!/[0-9)）]/.test(before)) return all;
            var lastChar = before.charAt(before.length - 1);
            if (lastChar === ',' || lastChar === '，' || lastChar === ';' || lastChar === '；') return all;
            var segStart = 0;
            for (var k = before.length - 1; k >= 0; k--) {
                var ch = before.charAt(k);
                if (ch === ',' || ch === '，' || ch === ';' || ch === '；') {
                    segStart = k + 1;
                    break;
                }
            }
            var seg = before.substring(segStart).replace(/\s+/g, '');
            if (/^[(（]?[单双]/.test(seg)) return ',' + all;
            return all + ',';
        });
    }

    // 周次文字 → 周次集合。四步预处理对应踩过的坑：
    //   ① 「共 N 周」只剥备注本身；
    //   ② 括号里的学分 / 学时 / 节次备注整组摘掉，但 (1-16周)、(单) 这类周次写法保留；
    //   ③ 串首的 (1) / (1-2) 是教学班序号，不是周次；节次写法「3-4节」整段摘掉；
    //   ④ 「第」「周」整字删掉，再把贴在一起的单双标记按段拆开。
    function weeksOf(source) {
        var text = clean(source);
        text = text.replace(/共\s*[0-9]+\s*周?/g, ' ');
        text = text.replace(/[（(]([^（）()]*)[)）]/g, function (whole, body) {
            if (/[学分时节课教程考试班组]/.test(body)) return ' ';
            if (/[0-9]/.test(body) || body.indexOf('单') >= 0 || body.indexOf('双') >= 0 ||
                body.indexOf('周') >= 0 || body.indexOf('第') >= 0 || /[-—~至到]/.test(body)) {
                return whole;
            }
            return ' ';
        });
        text = text.replace(/^\s*[(（]\s*[0-9]+\s*(?:[-—~至到]\s*[0-9]+\s*)?[)）]/, ' ');
        text = text.replace(/[（(]\s*[0-9]+\s*[)）]/g, ' ');
        text = text.replace(/[0-9]+\s*(?:[-—~至到]\s*[0-9]+)?\s*节/g, ' ');
        text = text.replace(/[至到]/g, '-');
        text = text.replace(/[第周]/g, '');
        text = glueMarkers(text);
        var tokens = text.split(/[,，;；\s]+/);
        var weeks = [];
        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (!token || !/[0-9]/.test(token)) continue;
            var oddOnly = token.indexOf('单') >= 0;
            var evenOnly = token.indexOf('双') >= 0;
            // 「单双周」两个标记同时出现 = 每周都上
            if (oddOnly && evenOnly) {
                oddOnly = false;
                evenOnly = false;
            }
            var numbers = token.match(/[0-9]+/g);
            if (!numbers || !numbers.length) continue;
            if (numbers.length > 2 && oddWeekTexts.length < 3) oddWeekTexts.push(token);
            var from = parseInt(numbers[0], 10);
            var to = numbers.length >= 2 ? parseInt(numbers[1], 10) : from;
            if (to < from) {
                var swap = from;
                from = to;
                to = swap;
            }
            for (var week = from; week <= to; week++) pushWeek(weeks, week, oddOnly, evenOnly);
        }
        return uniqueSorted(weeks);
    }

    // 周次集合 → 极大段（§4.1）：步长 1 每周，步长 2 单 / 双周
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

    // 节次列表 → 连续段；同一天不连续的两段各算一条安排
    function sectionRunsOf(text) {
        var numbers = String(text).match(/[0-9]+/g) || [];
        var list = [];
        for (var i = 0; i < numbers.length; i++) {
            var value = parseInt(numbers[i], 10);
            if (isNaN(value) || value < 1 || value > MAX_PERIOD) {
                droppedSections++;
                continue;
            }
            list.push(value);
        }
        list = uniqueSorted(list);
        var runs = [];
        var start = null;
        var prev = null;
        for (var j = 0; j < list.length; j++) {
            var current = list[j];
            if (start === null) {
                start = current;
                prev = current;
            } else if (current === prev + 1) {
                prev = current;
            } else {
                runs.push({ start: start, end: prev });
                start = current;
                prev = current;
            }
        }
        if (start !== null) runs.push({ start: start, end: prev });
        return runs;
    }

    // 周次文字的判断：括号里的备注（共 16 周、3 学分、第3-4节）先整组当空白，
    // 剩下的字符必须全是周次写法 —— 这样「2-16周(共16周)」能进，课名进不来。
    function isWeekText(text) {
        var rest = String(text).replace(/[（(][^（）()]*[)）]/g, ' ');
        if (!/[0-9]/.test(rest)) return false;
        return /^[0-9\s,，\-—~至到单双第周节]*$/.test(rest);
    }

    // 「周次 节次」行：前半段只能由周次字符组成，后半段只能是逗号分隔的节次号
    function specOf(line) {
        var m = /^(.*?)\s+(第?\s*[0-9]{1,2}(?:\s*[,，]\s*[0-9]{1,2})*)\s*$/.exec(line);
        if (!m) return null;
        var weekText = clean(m[1]);
        if (!isWeekText(weekText)) return null;
        return { weeks: weekText, sections: clean(m[2]) };
    }

    // 只有周次、没给节次的行：整行只由周次字符组成
    function weeksOnlyOf(line) {
        var text = clean(line);
        if (!isWeekText(text)) return null;
        return text;
    }

    // 行首的节次标签：「第1-2节」「1-2」「第9,10节」
    var PERIOD_LABEL = /^第?\s*[0-9]{1,2}\s*(?:[-—~,，至到]\s*[0-9]{1,2})*\s*节?$/;

    function rowPeriodsOf(row) {
        var limit = row.length < 2 ? row.length : 2;
        for (var c = 0; c < limit; c++) {
            for (var i = 0; i < row[c].length; i++) {
                var text = clean(row[c][i]);
                if (!PERIOD_LABEL.test(text)) continue;
                var runs = sectionRunsOf(text);
                if (runs.length === 1) return runs[0];
                if (runs.length > 1) return { start: runs[0].start, end: runs[runs.length - 1].end };
            }
        }
        return null;
    }

    var DAY_CHARS = '一二三四五六日天';

    function dayOfLabel(value) {
        var m = /(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/.exec(clean(value));
        if (!m) return 0;
        var at = DAY_CHARS.indexOf(m[1]);
        if (at >= 0) return m[1] === '天' ? 7 : at + 1;
        return parseInt(m[1], 10);
    }

    // 教师行：@ 前是教师、@ 后是地点；整行没有 @ 时按教师处理（与上游一致）
    function blankValue(value) {
        var text = clean(value);
        if (!text) return null;
        if (/^(未知|待定|暂无|无|未排|未安排)$/.test(text)) return null;
        if (/^(未知|待定|暂无|未排|未安排)(教师|老师|教室|地点|上课地点)$/.test(text)) return null;
        return text;
    }

    function teacherPlaceOf(line) {
        var text = clean(line);
        var at = text.indexOf('@');
        if (at < 0) return { teacher: blankValue(text), location: null };
        return {
            teacher: blankValue(text.substring(0, at)),
            location: blankValue(text.substring(at + 1))
        };
    }

    // ---------- 表头：找有 ≥4 个星期标签、且没有周次节次行的那一行 ----------
    var headerRow = -1;
    var headerWidth = 0;
    var bestLabels = 0;
    var dayCol = [0, -1, -1, -1, -1, -1, -1, -1];

    for (var hr = 0; hr < rows.length; hr++) {
        var hasSpec = false;
        var cols = [0, -1, -1, -1, -1, -1, -1, -1];
        var labels = 0;
        for (var hc = 0; hc < rows[hr].length; hc++) {
            var cellLines = rows[hr][hc] || [];
            for (var hl = 0; hl < cellLines.length; hl++) {
                if (specOf(cellLines[hl]) || weeksOnlyOf(cellLines[hl])) hasSpec = true;
            }
            var day = dayOfLabel(rows[hr][hc][0] || '');
            if (day >= 1 && day <= 7 && cols[day] < 0) {
                cols[day] = hc;
                labels++;
            }
        }
        if (hasSpec || labels < 4) continue;
        if (labels > bestLabels) {
            bestLabels = labels;
            headerRow = hr;
            headerWidth = rows[hr].length;
            dayCol = cols;
        }
    }

    // ---------- 逐行逐格解析 ----------
    var order = [];
    var byCourse = {};
    var lastPeriods = null;
    var shortRows = 0;

    function courseOf(name, teacher) {
        var key = '@' + name + '|' + (teacher || '');
        if (!byCourse[key]) {
            byCourse[key] = { name: name, teacher: teacher, buckets: [], index: {} };
            order.push(key);
        }
        return byCourse[key];
    }

    for (var ri = 0; ri < rows.length; ri++) {
        if (ri === headerRow) continue;
        var row = rows[ri] || [];
        // 标题行、图例行、备注行只有一两格（上游也是 cells.length < 2 直接跳过）：
        // 它们不是课程行，既不解析、也不计入「格子数比表头少」的提醒
        if (row.length < 7) continue;
        var ownPeriods = rowPeriodsOf(row);
        if (ownPeriods) lastPeriods = ownPeriods;
        var rowPeriods = ownPeriods || lastPeriods;

        var useHeaderCols = bestLabels >= 4 && row.length >= headerWidth;
        if (bestLabels >= 4 && !useHeaderCols) {
            for (var sc = 0; sc < row.length; sc++) {
                if (row[sc] && row[sc].length) {
                    shortRows++;
                    break;
                }
            }
        }
        var offset = useHeaderCols ? 0 : (row.length > 7 ? row.length - 7 : 0);

        for (var d = 1; d <= 7; d++) {
            var col = useHeaderCols ? dayCol[d] : (row.length >= 7 ? offset + d - 1 : d - 1);
            if (col < 0 || col >= row.length) continue;
            var lines = row[col] || [];
            for (var li = 0; li < lines.length; li++) {
                var spec = specOf(lines[li]);
                var weeksOnly = spec ? null : weeksOnlyOf(lines[li]);
                if (!spec && !weeksOnly) continue;

                var name = '';
                var teacherLine = '';
                var prev1 = li >= 1 ? lines[li - 1] : null;
                var prev2 = li >= 2 ? lines[li - 2] : null;
                var prev1IsSpec = prev1 ? !!(specOf(prev1) || weeksOnlyOf(prev1)) : true;
                var prev2IsSpec = prev2 ? !!(specOf(prev2) || weeksOnlyOf(prev2)) : true;

                if (li >= 2 && !prev1IsSpec && !prev2IsSpec) {
                    name = clean(prev2);
                    teacherLine = prev1;
                } else if (li >= 1 && !prev1IsSpec) {
                    name = clean(prev1);
                } else {
                    noName++;
                    continue;
                }
                if (!name) {
                    noName++;
                    continue;
                }

                var weeks = weeksOf(spec ? spec.weeks : weeksOnly);
                if (!weeks.length) {
                    noWeek++;
                    continue;
                }

                var runs = spec ? sectionRunsOf(spec.sections) : [];
                if (!runs.length) {
                    if (rowPeriods) {
                        runs = [{ start: rowPeriods.start, end: rowPeriods.end }];
                        labelFilled++;
                    } else {
                        noPeriod++;
                        continue;
                    }
                }

                var place = teacherPlaceOf(teacherLine);
                var course = courseOf(name, place.teacher);
                for (var sr = 0; sr < runs.length; sr++) {
                    var bucketKey = d + '|' + runs[sr].start + '|' + runs[sr].end + '|' + (place.location || '');
                    if (!course.index[bucketKey]) {
                        course.index[bucketKey] = {
                            day: d,
                            start: runs[sr].start,
                            end: runs[sr].end,
                            location: place.location,
                            weeks: []
                        };
                        course.buckets.push(course.index[bucketKey]);
                    }
                    for (var wi = 0; wi < weeks.length; wi++) course.index[bucketKey].weeks.push(weeks[wi]);
                }
            }
        }
    }

    if (!order.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，或教务页面结构有变化，' +
            '请确认教务系统的课表页能正常显示后再点「提取课表」'
        );
    }

    // ---------- 汇总成载荷课程 ----------
    var courses = [];
    var maxWeek = 0;
    var maxPeriod = 0;
    var missingTeacher = [];
    var missingRoom = [];

    for (var oi = 0; oi < order.length; oi++) {
        var built = byCourse[order[oi]];
        var blocks = [];
        var noRoom = false;
        for (var bi = 0; bi < built.buckets.length; bi++) {
            var bucket = built.buckets[bi];
            var weekRuns = runsOf(uniqueSorted(bucket.weeks));
            for (var wr = 0; wr < weekRuns.length; wr++) {
                blocks.push({
                    dayOfWeek: bucket.day,
                    startPeriod: bucket.start,
                    endPeriod: bucket.end,
                    startWeek: weekRuns[wr].start,
                    endWeek: weekRuns[wr].end,
                    weekType: weekRuns[wr].weekType,
                    location: bucket.location
                });
            }
            if (!bucket.location) noRoom = true;
        }
        blocks.sort(function (a, b) {
            return a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod ||
                a.startWeek - b.startWeek || a.endPeriod - b.endPeriod;
        });
        if (!blocks.length) continue;
        for (var bk = 0; bk < blocks.length; bk++) {
            if (blocks[bk].endWeek > maxWeek) maxWeek = blocks[bk].endWeek;
            if (blocks[bk].endPeriod > maxPeriod) maxPeriod = blocks[bk].endPeriod;
        }
        if (!built.teacher) missingTeacher.push(built.name);
        if (noRoom) missingRoom.push(built.name);
        courses.push({
            name: built.name,
            teacher: built.teacher,
            note: null,
            blocks: blocks
        });
    }

    // ---------- 总周数：默认 20，课表出现更晚的周才抬高 ----------
    var totalWeeks = maxWeek > DEFAULT_TOTAL_WEEKS ? maxWeek : DEFAULT_TOTAL_WEEKS;
    var raisedTotalWeeks = totalWeeks > DEFAULT_TOTAL_WEEKS;

    // ---------- 节次时间：内置 10 节；更晚的节次按 H3 逐节补 ----------
    var periodTimes = PERIOD_TIMES.slice(0);
    var fromBuiltin = [];
    var bySequence = [];
    var uncoveredFrom = 0;

    function minutesOf(value) {
        var m = /^([0-9]{1,2}):([0-9]{2})$/.exec(clean(value));
        if (!m) return -1;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

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

    for (var period = periodTimes.length + 1; period <= maxPeriod; period++) {
        var prev = periodTimes[periodTimes.length - 1];
        var prevEnd = prev ? minutesOf(prev.end) : -1;
        var builtinSlot = BUILTIN_PERIOD_TIMES[period - 1];
        if (builtinSlot && prev && minutesOf(builtinSlot.start) >= prevEnd) {
            periodTimes.push({ periodIndex: period, start: builtinSlot.start, end: builtinSlot.end });
            fromBuiltin.push(period);
            continue;
        }
        if (!prev) {
            uncoveredFrom = period;
            break;
        }
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) {
            uncoveredFrom = period;
            break;
        }
        periodTimes.push({ periodIndex: period, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(period);
    }

    // ---------- 开学日：教务不给，按提取当天回退到周一推算 ----------
    var firstDay = mondayOf(data.now);
    if (!firstDay) {
        throw new Error('提取数据里缺少提取日期，无法推算开学日期：请在课表页重新点「提取课表」');
    }

    // ---------- 学期名：教务给的 #term 选中项；没有就按学校名 + 学年学期生成 ----------
    function fallbackTermName(isoDate) {
        var m = /^([0-9]{4})-([0-9]{1,2})/.exec(clean(isoDate));
        if (!m) return '华东交通大学课表';
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        // 8 月到次年 1 月属于同一学年的第一学期，2 月到 7 月是第二学期
        var first = month >= 8 || month === 1;
        var startYear = month >= 8 ? year : year - 1;
        return '华东交通大学 ' + startYear + '-' + (startYear + 1) + ' 学年' + (first ? '第一学期' : '第二学期');
    }

    var termName = clean(term.name);
    if (/^请选择/.test(termName)) termName = '';
    if (!termName) {
        termName = fallbackTermName(data.now);
        warn('没能识别出学年学期名称，学期名已按「' + shortName(termName) + '」生成，请在「学期管理」里核对');
    }

    // ---------- 提醒：推算的、补齐的、缺的、丢的，逐类汇总 ----------
    warn('开学日期无法从教务获取，已按最近的周一（' + firstDay + '）推算，请在「学期管理」里核对');
    if (raisedTotalWeeks) {
        warn('课表里有第 ' + totalWeeks + ' 周的课：学期总周数已按 ' + totalWeeks +
            ' 周导入，请在「学期管理」里核对');
    } else {
        warn('教务页面不提供学期总周数：已按 ' + totalWeeks + ' 周导入（课表里最晚排到第 ' +
            maxWeek + ' 周），请在「学期管理」里核对');
    }
    warn('教务页面不提供节次时间：已按学校公布的 ' + PERIOD_TIMES.length +
        ' 节节次时间导入（第 1 节 ' + PERIOD_TIMES[0].start + '-' + PERIOD_TIMES[0].end +
        '），请在「学期管理」里核对');

    if (fromBuiltin.length || bySequence.length) {
        var fillTexts = [];
        if (fromBuiltin.length) fillTexts.push(sectionsText(fromBuiltin) + '用空课默认的节次时间');
        if (bySequence.length) {
            fillTexts.push(sectionsText(bySequence) + '按上一节下课后课间 ' + EXTEND_BREAK_MINUTES +
                ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推');
        }
        var filledAll = fromBuiltin.concat(bySequence).sort(function (a, b) { return a - b; });
        warn('课表用到了' + sectionsText(filledAll) + '，现有的节次时间没有覆盖，已补上：' +
            fillTexts.join('，') + '，请在「学期管理」里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }
    if (droppedWeeks > 0) {
        warn('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK +
            ' 周，已按脏数据丢弃（教务给出的周次不正常）');
    }
    if (droppedSections > 0) {
        warn('有 ' + droppedSections + ' 个节次超出 1-' + MAX_PERIOD +
            ' 节，已按脏数据丢弃（教务给出的节次不正常）');
    }
    if (labelFilled > 0) {
        warn('有 ' + labelFilled + ' 个上课安排页面没给节次（只有周次），已按所在行的节次补齐，请核对');
    }
    var skipped = noName + noWeek + noPeriod;
    if (skipped > 0) {
        var why = [];
        if (noName) why.push('缺课程名 ' + noName + ' 处');
        if (noWeek) why.push('缺周次 ' + noWeek + ' 处');
        if (noPeriod) why.push('缺节次 ' + noPeriod + ' 处');
        warn('有 ' + skipped + ' 处课程没能解析出来（' + why.join('、') +
            '），已跳过：教务页面结构可能已调整，欢迎反馈');
    }
    if (oddWeekTexts.length) {
        warn('有 ' + oddWeekTexts.length + ' 处周次写法没能完全识别（「' +
            shortName(oddWeekTexts.join('、')) + '」），已按能认出的部分导入，请核对');
    }
    if (missingTeacher.length) {
        warn('有 ' + missingTeacher.length + ' 门课没读到教师（例如 ' +
            shortNamesOf(missingTeacher) + '），已按空值导入，可在「编辑课程」里补上');
    }
    if (missingRoom.length) {
        warn('有 ' + missingRoom.length + ' 门课没读到教室（例如 ' +
            shortNamesOf(missingRoom) + '），已按空值导入，可在「编辑课程」里补上');
    }
    if (bestLabels < 4) {
        warn('课表里没找到星期表头，已按每行第 2 格到第 8 格依次对应周一到周日导入，请核对');
    } else if (shortRows > 0) {
        warn('有 ' + shortRows + ' 行格子数比表头少（节次标签被合并到了上一行），' +
            '已按每行最后 7 格对应周一到周日对齐，请核对这几天的课');
    }

    function shortNamesOf(list) {
        var picked = [];
        for (var i = 0; i < list.length && i < 3; i++) picked.push(shortName(list[i]));
        return picked.join('、');
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
