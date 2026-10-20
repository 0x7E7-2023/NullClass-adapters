(function () {
    // 梧州职业学院教务适配器（青果教务）—— 第二步：课表格子里的逐行文字 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 WZZY/wzzy_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf
    //
    // 上游在同一段脚本里弹窗、请求、用 DOMParser 找课表格子、拆周次、合并、保存、导入预设时间段；这里只做纯转换
    // （不碰页面、不发请求，CI 用 Rhino 实跑）。取数全部在 extract.js 里，交来的是
    //   { term: { xn, xq, source, name }, hasTable, cells: [ { d: 第几天, courses: [ [逐行文字…] … ], stray: 没有课程 div 的格子里的开头文字 } … ], dates: [ 'MM-DD' … ] }
    // 模板：周次解析、提醒汇总、H3 补节次取自批次十三的 jyvtc 与批次十的 swu（取数部分与它们不同构，见 AUDIT.md 第 3 节）。
    //
    // 移植改动（逐条对应 AUDIT.md 第 5 节）：
    //   ① 一个课程 div 的逐行文字是「课名 / 教师 / 周次[节次] / 地点」。上游要求至少 3 行、第 3 行含方括号才算，地点缺了写「未知地点」，
    //      缺教师时行数错位整条被静默丢掉；这里找第一个方括号里含数字的行当时间行，它前面第一行是课名、其余是教师（没有就是空），
    //      它后面第一行是地点（没有就是空），缺教师 / 缺地点照常导入，汇总进 warnings；找不到时间行的计数说明
    //   ② 周次：上游按逗号切段，每段含「单」「双」就只留奇 / 偶数，只认 1-16 这种写法；这里沿用 jyvtc / swu 的周次解析
    //      （「周」字、「第」、全角、「共 N 周」备注、教学班序号括号都认，单 / 双标记按位置归属），单独写的一周不受单 / 双影响（上游同口径）
    //   ③ 节次：上游取方括号里按「-」切开的第一个和最后一个数；这里同样取首尾，并认「第 1-2 节」「1-2,5-6」，读不出的计数说明
    //   ④ 合并：沿用上游的「同课名 / 教师 / 地点 / 星期 → 每周的节次集合 → 连续节次切段 → 同节次段的周次归到一起」，不丢任何一周
    //   ⑤ 节次时间：学校公布的 13 节（每节 40 分钟）逐节照抄上游；课表用到第 14 节及以后时按批次五统一修订 H3 顺推补齐
    //   ⑥ 开学日：上游从周课表里抠第一处「月-日」当第 1 周周一，再弹窗让用户确认；这里不能弹窗，改为要求日期是周一且落在合理的月份范围里
    //      （第一学期 7-10 月，第二学期次年 1-4 月），否则改按学期推算（第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一），
    //      无论读到还是推算，都在提醒里说清楚来源并请学生核对
    //   ⑦ 总周数：上游取课表里最大的周次；这里取 20 周与课表最大周次中较大者（最多 30），写进 warnings
    //   ⑧ 学期名用教务学期列表里的名字，取不到用 xn / xq 推出的「2026-2027学年第一学期」，再不行用「学校名 + 当前学期」
    //   ⑨ 读不出的内容不静默丢弃：找不到时间行、周次认不出、节次认不出、星期格位置超范围、格子有文字却没有课程 div，各自计数并写进 warnings
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var cells = Array.isArray(data.cells) ? data.cells : [];
    var dateTexts = Array.isArray(data.dates) ? data.dates : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据（本校节次 13 节）
    var SCHOOL_NAME = '梧州职业学院';   // 学期名兜底时用（不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 教务不给总周数，取 20 周（常见学期长度）与课表最大周次中较大者
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间补不上时顺推：下一节比上一节下课晚几分钟开始（统一修订 H3）
    var EXTEND_CLASS_MINUTES = 45; // 节次时间补不上时顺推：每节几分钟（统一修订 H3）

    // 学校节次时间（梧州职业学院）：上游 WZZY/wzzy_01.js 的 importPresetTimeSlots，13 节逐节照抄原值（每节 40 分钟）。
    var PERIOD_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:40' },
        { periodIndex: 2, start: '08:50', end: '09:30' },
        { periodIndex: 3, start: '09:50', end: '10:30' },
        { periodIndex: 4, start: '10:40', end: '11:20' },
        { periodIndex: 5, start: '11:30', end: '12:10' },
        { periodIndex: 6, start: '14:30', end: '15:10' },
        { periodIndex: 7, start: '15:20', end: '16:00' },
        { periodIndex: 8, start: '16:10', end: '16:50' },
        { periodIndex: 9, start: '17:00', end: '17:40' },
        { periodIndex: 10, start: '18:45', end: '19:25' },
        { periodIndex: 11, start: '19:35', end: '20:15' },
        { periodIndex: 12, start: '20:25', end: '21:05' },
        { periodIndex: 13, start: '21:15', end: '21:55' }
    ];

    var KIND_CN = { first: '一', second: '二' };
    // 推算开学日的锚点：第一学期多在 9 月初、第二学期多在 2 月下旬。
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到「第 1 周的第一天」那个周一（含当天）。
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' }
    };
    // 教务给出的开学日只在这个范围里才信（第一学期 7-10 月，第二学期次年 1-4 月）
    var KIND_WINDOW = {
        first: { fromMonth: 7, toMonth: 10, yearShift: 0 },
        second: { fromMonth: 1, toMonth: 4, yearShift: 1 }
    };

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 课名过长时截短，避免一个超长课名就把整条提醒撑破上限（载荷校验超了整包拒收）
    function shortName(name) {
        var line = text(name);
        return line.length > NAME_TEXT_LIMIT ? line.substring(0, NAME_TEXT_LIMIT - 1) + '…' : line;
    }

    // 字典里有多少个键（用对象当字典，ES5 下不引入 Set 之类）
    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
    }

    // 该日期所在周的周一（用 UTC 算，避免时区把日期挪一天）
    function mondayOnOrBefore(year, month, day) {
        var date = new Date(Date.UTC(year, month - 1, day));
        var offset = (date.getUTCDay() + 6) % 7;
        return new Date(date.getTime() - offset * 86400000);
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    // 分钟数写回 HH:mm（补时间用）
    function hhmmOf(total) {
        var h = Math.floor(total / 60);
        var m = total % 60;
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    }

    // 节次号（已升序）写成「第 9-12 节」「第 9 节」「第 9、11-12 节」这几种
    function sectionsText(list) {
        var runs = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) {
                j++;
            }
            runs.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + runs.join('、') + ' 节';
    }

    // ---------- warnings（载荷上限 20 条 × 200 字，超了整包会被拒，所以由这里统一收口） ----------
    var warnings = [];
    var droppedWarnings = 0;

    function warn(message) {
        var line = text(message);
        if (!line) return;
        // 单条超长直接截断（载荷校验是「超了就整包拒收」，截断至少还能让用户看到前半句）
        if (line.length > MAX_WARNING_TEXT) line = line.substring(0, MAX_WARNING_TEXT - 1) + '…';
        if (warnings.length >= MAX_WARNINGS) { droppedWarnings++; return; }
        warnings.push(line);
    }

    // ---------- 学期名与学期序号 ----------
    // extract.js 交来的 xn / xq：xn 是学年的起始年（2026），xq 是 0（第一学期）或 1（第二学期）（上游同一约定）
    var termYear = /^[0-9]{4}$/.test(text(term.xn)) ? parseInt(text(term.xn), 10) : 0;
    var termMatch = termYear > 0 && /^[01]$/.test(text(term.xq));
    var termKind = termMatch && text(term.xq) === '1' ? 'second' : 'first';

    function termName() {
        var given = text(term.name);
        if (given) return given.length > 40 ? given.substring(0, 40) : given;
        if (!termMatch) return SCHOOL_NAME + ' 当前学期';
        return termYear + '-' + (termYear + 1) + '学年第' + KIND_CN[termKind] + '学期';
    }

    // ---------- 开学日 ----------
    // 教务周课表里的日期 'MM-DD'（extract.js 交来的前几处，上游取第一处当第 1 周周一）：取第一个周一，
    // 年份按上游规则（第二学期是学年起始年 + 1，第一学期就是起始年），再核对落在合理的月份范围里。
    // 返回 { iso } 或 { bad: 原文 } 或 null（一个日期都没有）
    function startFromSchool() {
        if (!termMatch || !dateTexts.length) return null;
        var year = termYear + KIND_WINDOW[termKind].yearShift;
        for (var i = 0; i < dateTexts.length; i++) {
            var m = /^([0-9]{2})-([0-9]{2})$/.exec(text(dateTexts[i]));
            if (!m) continue;
            var month = parseInt(m[1], 10);
            var day = parseInt(m[2], 10);
            var date = new Date(Date.UTC(year, month - 1, day));
            if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;   // 2 月 30 日之类不存在的日期
            if (date.getUTCDay() !== 1) continue;                                          // 不是周一
            var win = KIND_WINDOW[termKind];
            if (month < win.fromMonth || month > win.toMonth) return { bad: year + '-' + m[1] + '-' + m[2] };
            return { iso: isoOf(date) };
        }
        return { bad: text(dateTexts[0]) };
    }

    // 教务没给 / 给的不可信时，按学期序号推算；推算结果一律写进 warnings。
    function estimateStart() {
        if (!termMatch) return null;
        var anchor = KIND_ANCHOR[termKind];
        return {
            iso: isoOf(mondayOnOrBefore(termYear + KIND_WINDOW[termKind].yearShift, anchor.month, anchor.day)),
            rule: anchor.rule
        };
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。逐段沿用批次十 swu / 批次十三 jyvtc 的 weeksOf：
    //   "1-16" / "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-16(单周)" / "1-3,5-9周" / "第1-第8周" / "1-3周 5-9周" / "1-8 单"
    // 要点：
    //   ① 「周」只是量词，不能拿它当分段边界，所以先把「周」整个删掉再切段；
    //   ② 单/双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走
    //      （前缀 "(单)1-8周,(双)9-16周" 里两个标记不能都并到前一段）；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的是教学班序号，整组摘掉；含非周次字的备注也摘掉，计数后写进 warnings；
    //   ④ 破折号连同两侧空白先归一，剩下的空白当分段符；「共 N 周」备注只剥备注本身；区间终点前的「第」去掉；
    //   ⑤ 单独写的一周（没有区间）不受单 / 双标记影响（上游：没有区间的段直接取数字）。
    var droppedWeeks = 0;    // 超出 1..MAX_WEEK 被丢掉的周次个数
    var orphanMarkers = 0;   // 带单/双标记但附近一个周次段都没有的段数
    var serialGroups = 0;    // 被摘掉的教学班序号括号个数（纯数字，不是周次）
    var noteGroups = 0;      // 被摘掉的备注括号个数（如「(3组)」，含非周次的字，不是周次）
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
        // 周次里常夹着「共8周」这类课程总周数备注，它不是上课周次，只剥备注本身；
        // 不能从第一个「共」一路删到行尾 —— 「1-8周(共8周),9-16周」后面的 9-16 周会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'，
        // "1 -16周(单)" / "1- 16周" / "1～16周" / "1至16周" 都归成标准形态。不要在这里删掉全部空白。
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 紧挨周次的单/双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上；
        //   这里先把 "(单)1" / "8周(单)" 直接折成 "单1" / "8单"，标记就跟着自己那一段走。
        //   前缀只认在段首：标记前面紧挨着数字或「周」（中间可有空白）时它是上一段的后缀，
        //   "1-8周(单) 9-16周(双)" 里的 "(单)" 不能被后面的 "9" 抢去当前缀；后缀后面紧跟下一段的数字时补一个逗号隔开
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            if (/[0-9周]\s*$/.test(whole.substring(0, offset))) return all;
            return mark;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var glue = /^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '';
            return digit + mark + glue;
        });
        // 括号先于删「周」逐组处理（全角括号已在上一步归成半角）：
        // 只有数字的（"(1)"、"(1-2)"、"(1,2)"）是教学班序号，整组摘掉；含非周次字的（"(3组)"、"(实验)"）是备注，也摘掉，另计一个数；
        // 其余（"(1-16周)"、"(单)"、"(双周)"）保留内容。每一组都换成逗号，不让两侧的数字粘在一起
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周第-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = shortName(all);
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');   // 剩下落单的括号字符（没有闭合）也换成逗号，不许直接删
        cleaned = cleaned.replace(/周/g, '');
        // 区间终点前的「第」（接受「第1-第8周」）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        // 剩下的空白当分段符折成逗号（fullWidthToHalf 已把全角逗号 / 顿号 / 分号折成半角逗号）
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (token) segments.push(token);
        }
        // 单/双自己成一段时并给最近的周次段（就近向前找，找不到再向后）
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
            // 「单」「双」都写了 = 每周都上（两边互相排除会让整段周次变空，那才是真丢数据）；
            // 这是个判断不是事实，所以计数后写进 warnings
            if (onlyOdd && onlyEven) { bothMarks++; onlyOdd = false; onlyEven = false; }
            var found = segment.match(/[0-9]+(?:[ ]*-[ ]*[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var isRange = bounds.length > 1;
                var start = parseInt(bounds[0], 10);
                var end = isRange ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                for (var week = start; week <= end; week++) {
                    // 单独写的一周不受单 / 双标记限制（上游：没有区间的段直接取数字）
                    if (isRange && onlyOdd && week % 2 === 0) continue;
                    if (isRange && onlyEven && week % 2 === 1) continue;
                    if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
                    if (!seen[week]) { seen[week] = true; weeks.push(week); }
                }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周（手册 §4.1）。
    // 一个上游 course 切出多段就写成多个 block，语义等价。
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

    // ---------- 节次 ----------
    // 方括号里的节次文本 → [ { start, end } … ]；读不出（含非节次的字、超出 1..MAX_PERIOD）返回 null。
    // 一段「3-4」取首尾两个数（上游：按「-」切开取第一个和最后一个），逗号 / 空白隔开的几段各自算
    function periodRangesOf(source) {
        var cleaned = fullWidthToHalf(text(source)).replace(/[第节]/g, ' ').replace(/\s*-\s*/g, '-');
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var ranges = [];
        for (var i = 0; i < tokens.length; i++) {
            var token = text(tokens[i]);
            if (!token) continue;
            if (!/^[0-9]+(?:-[0-9]+)*$/.test(token)) return null;
            var nums = token.split('-');
            var start = parseInt(nums[0], 10);
            var end = parseInt(nums[nums.length - 1], 10);
            if (!(start >= 1 && end >= start && end <= MAX_PERIOD)) return null;
            ranges.push({ start: start, end: end });
        }
        return ranges.length ? ranges : null;
    }

    // ---------- 一个课程 div 的逐行文字：「课名 / 教师 / 周次[节次] / 地点」 ----------
    // 时间行：第 2 行起第一个「方括号里含数字」的行（上游固定取第 3 行）；方括号前面是周次，括号后面若还有文字不算地点
    function timeLineOf(lines) {
        for (var i = 1; i < lines.length; i++) {
            var line = lines[i].replace(/［/g, '[').replace(/］/g, ']');
            var m = /^(.*)\[([^\[\]]*)\](.*)$/.exec(line);
            if (m && /[0-9]/.test(m[2])) return { index: i, weeks: m[1], sections: m[2], trailing: text(m[3]) };
        }
        return null;
    }

    // ---------- 逐格转换 ----------
    var missingTeacherCourses = {};   // 缺教师的课（按课名去重）
    var missingLocationCourses = {};  // 缺教室的课（按课名去重）
    var fieldSamples = [];            // 缺教师 / 缺教室的课名样例，最多 3 个，写进 warnings
    var unreadable = { time: 0, week: 0, section: 0 };   // 读不出来的课程条数（按原因）
    var unreadableSamples = [];       // 读不出来的课名样例，最多 3 条
    var trailingCount = 0;            // 时间行后面还跟着别的文字（或地点后还有别的行）的条数
    var trailingSample = '';
    var badDayCourses = 0;            // 所在格子的位置超出星期一到星期日的课数
    var strayCells = 0;               // 有文字却没有课程 div 的格子数
    var straySample = '';
    var anyContent = false;           // 整张表里有没有任何课程 div 或有文字的格子
    var maxWeek = 0;
    var maxPeriod = 0;

    var groups = [];                  // 同课名 / 教师 / 地点 / 星期的一组：{ name, teacher, location, day, matrix: 周次 → 节次集合 }
    var groupByKey = {};

    function noteUnreadable(reason, name) {
        unreadable[reason]++;
        var sample = shortName(name);
        if (unreadableSamples.length < 3 && unreadableSamples.indexOf(sample) < 0) unreadableSamples.push(sample);
    }

    function groupOf(name, teacher, location, day) {
        var key = 'k' + JSON.stringify([name, teacher, location, day]);
        var found = groupByKey[key];
        if (found) return found;
        found = { name: name, teacher: teacher, location: location, day: day, matrix: {} };
        groupByKey[key] = found;
        groups.push(found);
        return found;
    }

    for (var c0 = 0; c0 < cells.length; c0++) {
        var cell = cells[c0] || {};
        var courseLines = Array.isArray(cell.courses) ? cell.courses : [];
        if (!courseLines.length) {
            if (text(cell.stray)) {
                anyContent = true;
                strayCells++;
                if (!straySample) straySample = shortName(cell.stray);
            }
            continue;
        }
        anyContent = true;
        var day = parseInt(cell.d, 10);
        for (var k = 0; k < courseLines.length; k++) {
            var lines = [];
            var rawLines = Array.isArray(courseLines[k]) ? courseLines[k] : [];
            for (var rl = 0; rl < rawLines.length; rl++) {
                var one = text(rawLines[rl]);
                if (one) lines.push(one);
            }
            if (!lines.length) continue;
            var courseName = lines[0];
            if (!(day >= 1 && day <= 7)) { badDayCourses++; continue; }
            var timeLine = timeLineOf(lines);
            if (!timeLine) { noteUnreadable('time', courseName); continue; }
            var weeks = weeksOf(timeLine.weeks);
            if (!weeks.length) { noteUnreadable('week', courseName); continue; }
            var ranges = periodRangesOf(timeLine.sections);
            if (!ranges) { noteUnreadable('section', courseName); continue; }
            var teacher = text(lines.slice(1, timeLine.index).join('、'));
            var after = lines.slice(timeLine.index + 1);
            var location = after.length ? after[0] : '';
            var extra = timeLine.trailing || (after.length > 1 ? text(after.slice(1).join(' ')) : '');
            if (extra) {
                trailingCount++;
                if (!trailingSample) trailingSample = shortName(extra);
            }
            // 教师、地点没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
            // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
            if (!teacher) missingTeacherCourses['n' + courseName] = true;
            if (!location) missingLocationCourses['n' + courseName] = true;
            if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(courseName) < 0) {
                fieldSamples.push(courseName);
            }
            var group = groupOf(courseName, teacher, location, day);
            for (var rg = 0; rg < ranges.length; rg++) {
                for (var w = 0; w < weeks.length; w++) {
                    var perWeek = group.matrix[weeks[w]];
                    if (!perWeek) { perWeek = {}; group.matrix[weeks[w]] = perWeek; }
                    for (var s = ranges[rg].start; s <= ranges[rg].end; s++) perWeek[s] = true;
                }
            }
        }
    }

    // ---------- 合并（上游同一做法）：每组按周次排序，把当周的节次集合切成连续段，节次段相同的周次归到一起 ----------
    function numericAsc(a, b) { return a - b; }

    var courses = [];
    var courseByKey = {};

    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序
    function courseOf(name, teacher) {
        var key = 'k' + JSON.stringify([name, teacher || '']);
        var found = courseByKey[key];
        if (found) return found;
        found = { name: name, teacher: teacher || null, blocks: [] };
        courseByKey[key] = found;
        courses.push(found);
        return found;
    }

    for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        var weekKeys = [];
        for (var wk in g.matrix) {
            if (Object.prototype.hasOwnProperty.call(g.matrix, wk)) weekKeys.push(parseInt(wk, 10));
        }
        weekKeys.sort(numericAsc);
        var patterns = [];
        var patternByKey = {};
        for (var wi = 0; wi < weekKeys.length; wi++) {
            var sectionKeys = [];
            for (var sk in g.matrix[weekKeys[wi]]) {
                if (Object.prototype.hasOwnProperty.call(g.matrix[weekKeys[wi]], sk)) sectionKeys.push(parseInt(sk, 10));
            }
            sectionKeys.sort(numericAsc);
            var runStart = 0;
            for (var si = 0; si < sectionKeys.length; si++) {
                if (si === sectionKeys.length - 1 || sectionKeys[si + 1] !== sectionKeys[si] + 1) {
                    var pKey = sectionKeys[runStart] + '-' + sectionKeys[si];
                    var pattern = patternByKey[pKey];
                    if (!pattern) {
                        pattern = { start: sectionKeys[runStart], end: sectionKeys[si], weeks: [] };
                        patternByKey[pKey] = pattern;
                        patterns.push(pattern);
                    }
                    pattern.weeks.push(weekKeys[wi]);
                    runStart = si + 1;
                }
            }
        }
        var owner = courseOf(g.name, g.teacher);
        for (var pi = 0; pi < patterns.length; pi++) {
            var runs = runsOf(patterns[pi].weeks);
            for (var ri = 0; ri < runs.length; ri++) {
                if (runs[ri].end > maxWeek) maxWeek = runs[ri].end;
                if (patterns[pi].end > maxPeriod) maxPeriod = patterns[pi].end;
                owner.blocks.push({
                    dayOfWeek: g.day,
                    startPeriod: patterns[pi].start,
                    endPeriod: patterns[pi].end,
                    startWeek: runs[ri].start,
                    endWeek: runs[ri].end,
                    weekType: runs[ri].weekType,
                    location: g.location || null
                });
            }
        }
    }
    // 块的顺序固定为：星期、起始节次、结束节次、起始周
    for (var ci = 0; ci < courses.length; ci++) {
        courses[ci].blocks.sort(function (a, b) {
            return (a.dayOfWeek - b.dayOfWeek) || (a.startPeriod - b.startPeriod) ||
                (a.endPeriod - b.endPeriod) || (a.startWeek - b.startWeek);
        });
    }

    var name0 = termName();

    if (!data.hasTable) {
        throw new Error(
            '教务系统没有返回这个学期（' + name0 + '）的课表页：可能这个学期还没有排课，也可能登录状态已失效；' +
            '请在教务系统里确认能看到课表后再点「提取课表」'
        );
    }
    if (!anyContent) {
        throw new Error(
            '这个学期（' + name0 + '）在教务系统里还没有课；如果要导入别的学期，' +
            '请在教务页面里切换学期后再点「提取课表」'
        );
    }
    if (!courses.length) {
        throw new Error(
            '教务系统返回了课表，但没有一门课能读成课程（课表页面的格式可能改过）：' +
            '请把这个问题反馈给我们，并附上教务系统里课表页的截图'
        );
    }

    var payloadCourses = [];
    for (var pc = 0; pc < courses.length; pc++) {
        payloadCourses.push({
            name: courses[pc].name,
            teacher: courses[pc].teacher,
            note: null,
            blocks: courses[pc].blocks
        });
    }

    // ---------- 开学日 / 总周数 ----------
    var fromSchool = startFromSchool();
    var estimated = estimateStart();
    var firstDay = fromSchool && fromSchool.iso ? fromSchool.iso : (estimated ? estimated.iso : null);
    if (!firstDay) {
        // 学期的年份读不出来：没有任何依据推算开学日，宁可报错也不编一个
        throw new Error(
            '没能确定这个学期的开学日期，课表无法导入：请回到教务系统的课表页再点「提取课表」，' +
            '如果仍然这样，请把这个问题反馈给我们'
        );
    }

    // 教务不给总周数。取 20 周与课表最大周次中较大者；endWeek 超过 totalWeeks 会被载荷校验拒掉，所以必须放得下。
    var totalWeeks = SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }

    // ---------- 节次时间：学校公布 13 节；更靠后的节次从上一节下课后顺推（统一修订 H3：课间 5 分钟、每节 45 分钟，越过 23:59 就停） ----------
    var periodTimes = PERIOD_TIMES.slice(0);
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = periodTimes.length + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }

    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    var source = text(term.source);
    if (source === 'page') {
        warn(
            '只导入了教务页面上当前选中的学期（' + name0 +
            '）；要导入别的学期，请先在教务系统里切到那个学期再点「提取课表」'
        );
    } else if (source === 'list-first') {
        warn(
            '没能从教务页面读到当前学期，今天的日期对应的学期也不在教务系统的学期列表里，已导入列表里的第一个学期「' + name0 +
            '」；如果不是你要的学期，请在教务系统里切到那个学期再点「提取课表」'
        );
    } else {
        warn(
            '没能从教务页面读到当前学期，已按今天的日期判断为「' + name0 +
            '」；如果不是你要的学期，请在教务系统里切到那个学期再点「提取课表」'
        );
    }

    if (fromSchool && fromSchool.iso) {
        warn(
            '第 1 周的开始日期（' + firstDay + '）是从教务系统第 1 周的周课表里读出来的，' +
            '没法向你确认，请在学期管理里核对是不是学校实际的开学日'
        );
    } else if (fromSchool && fromSchool.bad) {
        warn(
            '教务系统周课表里读到的开学日期（' + fromSchool.bad + '）不是周一或不在合理的月份里，已不采用；第 1 周按「' +
            estimated.rule + '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日'
        );
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + estimated.rule +
            '」推算为 ' + firstDay + '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raisedBySchedule) {
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入' + (clamped ? '（最多 ' + MAX_WEEK + ' 周）' : '') + '，如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期总周数，已按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    if (bySequence.length) {
        warn(
            '课表用到了' + sectionsText(bySequence) + '，学校公布的节次时间没有覆盖，已补上：按上一节下课后课间 ' +
            EXTEND_BREAK_MINUTES + ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    var skippedCourses = unreadable.time + unreadable.week + unreadable.section;
    if (skippedCourses > 0) {
        var reasons = [];
        if (unreadable.time) reasons.push('找不到方括号里的节次 ' + unreadable.time + ' 条');
        if (unreadable.week) reasons.push('周次认不出或全超出 1-' + MAX_WEEK + ' 周 ' + unreadable.week + ' 条');
        if (unreadable.section) reasons.push('节次认不出 ' + unreadable.section + ' 条');
        var sampleTexts = [];
        for (var us = 0; us < unreadableSamples.length; us++) sampleTexts.push('「' + unreadableSamples[us] + '」');
        warn(
            '有 ' + skippedCourses + ' 条课程内容没能读成课程（' + reasons.join('、') + '），已跳过，例如 ' +
            sampleTexts.join('') + '：如发现少课请反馈'
        );
    }
    if (badDayCourses > 0) {
        warn(
            '有 ' + badDayCourses + ' 门课所在的格子超出了星期一到星期日的范围（认不出是星期几），这些课已跳过：如发现少课请反馈'
        );
    }
    if (strayCells > 0) {
        warn(
            '有 ' + strayCells + ' 个格子里有文字，但排版和预期不一样（如「' + straySample + '」），这些格子没有导入：如发现少课请反馈'
        );
    }
    // 缺教师 / 缺地点：课照常导入（对应项为空），但按类型汇总计数说出来，不静默
    var missingTeacher = countKeys(missingTeacherCourses);
    var missingLocation = countKeys(missingLocationCourses);
    if (missingTeacher > 0 || missingLocation > 0) {
        var fieldParts = [];
        if (missingTeacher > 0) fieldParts.push(missingTeacher + ' 门课没给上课教师');
        if (missingLocation > 0) fieldParts.push(missingLocation + ' 门课没给上课地点');
        var shownFieldNames = [];
        for (var fs = 0; fs < fieldSamples.length; fs++) shownFieldNames.push(shortName(fieldSamples[fs]));
        var emptyText = missingTeacher > 0 && missingLocation > 0
            ? '教师或地点暂时空着'
            : (missingTeacher > 0 ? '教师暂时空着' : '上课地点暂时空着');
        warn(
            '有 ' + fieldParts.join('、') + '（例如 ' + shownFieldNames.join('、') + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上'
        );
    }
    if (trailingCount > 0) {
        warn(
            '有 ' + trailingCount + ' 门课在节次或地点后面还有别的文字（如「' + trailingSample + '」），这部分没有导入'
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
            '有 ' + noteGroups + ' 处周次里的括号备注（如「' + noteSample + '」）不是周次，' +
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
