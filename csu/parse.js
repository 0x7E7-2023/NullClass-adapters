(function () {
    // 中南大学（强智 · 高校综合管理教务系统 /jsxsd/，老界面）课表解析
    // 移植自 shiguang_warehouse 的 CSU/csu.js（MIT，上游作者 GaLeKu）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //   上游快照 e15c627（2026-10-26 拉取），本校脚本最后一次修改 a7b9cdf。模板：hnptc。
    // 上游的核心：读 table#kbtable（第一行含「星期」表头的那张）每个格子里精确类名的 div.kbcontent，
    // 用「-----」（5 个以上减号）把一格里的几门课分开；课程名取块里第一段长度 ≥2 的文字行，font[title=老师|教师]、
    // font[title=教室|上课地点]、font[title=周次(节次)|周次|节次] 取教师、教室与周次，独立的 font[title=单双周] 并成括号并入周次；
    // 节次只认本行行首表头里的数字（「1－2」，全角连字符，取首尾），同格拼课共用本格节次、靠周次区分先后；
    // 开学日期与总周数来自教学周历（POST /jsxsd/jxzl/jxzl_query）：第一行第一个带日期的格子，它是星期日则每周从星期日起算，
    // 否则从周一起算；总周数取每行第一格整数的最大值；节次时间是校历「上课时间」的 10 节（上游写死）。这里保持同一套字段来源。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 周次逐段判单双：上游 parseWeeks() 对整串文字只判一次单双，「(单)1-8周,(双)9-16周」两个标记都在时按「不过滤」处理，
    //      「1-8周(单),9-16周」又把后一段也当单周；这里先分段、每段各自判，「(单)1-8周,(双)9-16周」「1-8周(单) 9-16周(双)」都认，
    //      共 N 周的备注只剥备注本身，区间终点前的「第」（第1-第8周）、教学班序号括号（(1)、(1-2)）、括号备注（(实验)）都不当周次；
    //   ② 上游缺教师 / 缺教室就写空串；这里留空（null），按类型汇总提醒，点名课名截 20 字；
    //   ③ 上游静默丢掉的块（没课名 / 没周次）与上游根本没有的情形（本行认不出节次、节次超范围）全部计数并点名；
    //   ④ 上游把连续节次的同一门课并成一条（第 4 节与第 5 节、第 8 节与第 9 节也会并）；这里照并，但不跨过中午和晚饭
    //      （第 4 与 5 节、第 8 与 9 节之间不并，与学校校历里「中午、晚饭不排课」一致）；
    //   ⑤ 课表用到的节次超出学校公布的 10 节时，上游整份不写节次时间；这里按「统一修订 H3」顺推补上节次时间并提醒；
    //   ⑥ 周历第 1 周第一个带日期的格子不是星期日也不是星期一时，上游把它原样当开学日（由应用回退到周一）；
    //      这里直接对齐到所在周的周一并提醒；周历取不到时按提取日期推算并出提醒（上游留给用户在软件里手动校准）；
    //      周历第一格是星期日时，开学日取这个星期日本身（每周从星期日起算），并提醒；
    //   ⑦ 学期总周数：周历优先，周历取不到才用课表里最晚的周次并提醒；课表里有更晚的周次时抬高到它；
    //   ⑧ 节次时间是校历「上课时间」写死的（上游同样），每次导入都出一条提醒请学生核对；
    //   ⑨ 星期不按「第几个格子」硬算：按表头里的星期名称对齐网格列（中南的星期日排在最前）；
    //      表头认不出星期几时直接报错，不按位置猜（猜了会整周错位）；
    //   ⑩ 不做上游没有的「简表 / 详表择优」：中南只读精确类名 kbcontent，kbcontent1 是隐藏的旧数据、不读。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，CI 的 Rhino 里没有 DOM）：
    //   { now: "2026-09-13", term: { code, name }, cols: 8,
    //     calendar: { found, rows: [ [ { col, text, title } ] ] },
    //     rows: [ [ { col, span, text, th, parts: [课程明细 HTML] } ] ] }
    //   parts 里的 HTML 已经去掉了一切不认识的元素，只留文字、换行与 font 的 title。
    var data = JSON.parse(__ncInput);
    var rows;
    var term = data.term || {};
    var calendarRows;

    var SCHOOL_NAME = '中南大学';

    // 学校校历公布的 10 节「上课时间」（逐节照抄上游 TIME_SLOTS；上游注释：2024-2025 起三学年一致，第九节前 17:40-19:00 为晚餐不排课）
    var SLOT_TIMES = [
        '08:00-08:45', '08:55-09:40', '10:00-10:45', '10:55-11:40',
        '14:00-14:45', '14:55-15:40', '16:00-16:45', '16:55-17:40',
        '19:00-19:45', '19:55-20:40'
    ];
    var PERIOD_COUNT = SLOT_TIMES.length;

    // 连续节次并成一条时不跨过的位置：第 4 节与第 5 节之间隔着中午（11:40 到 14:00），第 8 节与第 9 节之间隔着晚饭（17:40 到 19:00）
    var NO_MERGE_AFTER = { 4: true, 8: true };

    // 节次上限：越过它一定是脏数据（学校公布 10 节；更晚的节次按 H3 顺推补时间，顺推越过 23:59 就停）
    var MAX_PERIOD = 20;
    var EXTEND_BREAK_MINUTES = 5;   // 顺推补节次时间：课间
    var EXTEND_CLASS_MINUTES = 45;  // 顺推补节次时间：每节
    // 载荷校验的总周数上限（1..30）：超过 30 的周次按脏数据丢弃并出声
    var MAX_WEEK = 30;
    // 载荷校验的上限：警告 ≤20 条、每条 ≤200 字；点名的课名最多显示 20 字
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var MAX_MINUTE = 23 * 60 + 59;

    // 一格里放多门课时，教务用一长串减号分隔（上游要求 5 个以上，全角减号也认）
    var DASHES = /[-—–－]{5,}/;
    var TEACHER_KEYS = ['老师', '教师'];
    var ROOM_KEYS = ['教室', '上课地点'];
    var TEACHER_PREFIX = /^(任课教师|授课教师|教师|老师)\s*[:：]\s*/;
    var DAY_CHARS = '一二三四五六日天';
    var SEP = String.fromCharCode(1);

    // 计数：全部要进 warnings —— 一个都不许静默丢
    var noNameBlocks = 0;
    var noWeekBlocks = 0;
    var noPeriodBlocks = 0;
    var overPeriodBlocks = 0;
    var droppedWeeks = 0;
    var ambiguousMarks = 0;
    var ambiguousSamples = [];
    var serialGroups = 0;
    var noteGroups = 0;
    var noteSample = '';
    var orphanMarkers = 0;
    var mergedCells = 0;
    var unmappedCells = 0;
    var noColCells = 0;
    var droppedNames = [];
    var droppedTotal = 0;
    var missingTeacherNames = [];
    var missingRoomNames = [];

    // 没有网格列号的格子：跳过并计数（extract.js 总会交 col；缺了就不知道它在哪一天，不按数组下标猜）
    function withColOnly(grid) {
        var out = [];
        for (var r = 0; r < grid.length; r++) {
            var kept = [];
            for (var c = 0; c < grid[r].length; c++) {
                var col = grid[r][c] ? grid[r][c].col : undefined;
                if (typeof col === 'number' && col >= 0) kept.push(grid[r][c]);
                else noColCells++;
            }
            out.push(kept);
        }
        return out;
    }
    rows = withColOnly(data.rows || []);
    calendarRows = withColOnly((data.calendar && data.calendar.rows) || []);

    // 载荷里的核对提示。一律经 pushWarning() 出去：每条 ≤200 字（超了按码位截断加省略号）。
    // 一共 ≤20 条是载荷校验的硬上限：超过时由 finalWarnings() 收尾（前 19 条照常，第 20 条写成汇总），绝不静默丢。
    var warnings = [];

    function clipText(text, max) {
        var one = String(text);
        if (one.length <= max) return one;
        var head = one.substring(0, max - 1);
        var last = head.charCodeAt(head.length - 1);
        if (last >= 0xD800 && last <= 0xDBFF) head = head.substring(0, head.length - 1);
        return head + '…';
    }

    function pushWarning(message) {
        var text = clipText(message, MAX_WARNING_TEXT);
        if (warnings.indexOf(text) >= 0) return;
        warnings.push(text);
    }

    function finalWarnings() {
        if (warnings.length <= MAX_WARNINGS) return warnings;
        var kept = warnings.slice(0, MAX_WARNINGS - 1);
        var hidden = warnings.length - kept.length;
        kept.push(clipText('另有 ' + hidden + ' 条提醒未列出', MAX_WARNING_TEXT));
        return kept;
    }

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 提醒里点名的课名：截到 NAME_TEXT_LIMIT 字，整条提醒再过 pushWarning 的 200 字出口
    function shortName(name) {
        return clipText(clean(name), NAME_TEXT_LIMIT);
    }

    // 点名最多 3 个，超过的写「等」
    function namesText(list) {
        var shown = [];
        for (var i = 0; i < list.length && i < 3; i++) shown.push(shortName(list[i]));
        return shown.join('、') + (list.length > 3 ? ' 等' : '');
    }

    function addUnique(list, value) {
        if (list.indexOf(value) < 0) list.push(value);
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 某个日期所在那一周的周一。不用 Date.parse：Rhino 对 ISO 串的支持不齐。
    function mondayOf(isoDate) {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(clean(isoDate));
        if (!m) return null;
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        var back = (day.getDay() + 6) % 7;
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() - back));
    }

    function stripTags(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/<[^>]*>/g, '');
    }

    function decodeEntities(value) {
        return String(value)
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/g, '\'')
            .replace(/&amp;/gi, '&');
    }

    function plainText(value) {
        return clean(decodeEntities(stripTags(value)));
    }

    // 明细 HTML 里的 <font 属性>文本</font>，按出现顺序返回（title 属性可缺）。
    // 末尾的 </font> 允许缺失（教务页面的 <font> 偶尔不闭合），那时取到下一个 '<' 为止。
    var FONT_TAG = /<font\b([^>]*)>([\s\S]*?)(?:<\/font>|(?=<)|$)/gi;

    function fontsOf(blockHtml) {
        var html = String(blockHtml);
        var out = [];
        FONT_TAG.lastIndex = 0;
        var m = FONT_TAG.exec(html);
        while (m) {
            var title = /title\s*=\s*["']?([^"'>]*)["']?/i.exec(m[1]);
            out.push({ title: clean(title ? title[1] : ''), text: plainText(m[2]) });
            m = FONT_TAG.exec(html);
        }
        FONT_TAG.lastIndex = 0;
        return out;
    }

    // 课程名：上游取块里第一个换行之前的非空文本行（行里连 font 的文字一起算，长度 ≥2）；
    // 拼课第 2 段起以换行开头，首个换行之前是空的，要往后找。都没有就返回空串，调用方计数并点名。
    function nameOf(blockHtml) {
        var lines = String(blockHtml).split(/<br\s*\/?>/i);
        for (var i = 0; i < lines.length; i++) {
            var line = plainText(lines[i]);
            if (line.length >= 2) return line;
        }
        return '';
    }

    // 上游 pickText：按关键词顺序，找标题里含这个词、且文字非空的第一个 font
    function titledText(fonts, keys) {
        for (var k = 0; k < keys.length; k++) {
            for (var i = 0; i < fonts.length; i++) {
                if (fonts[i].title.indexOf(keys[k]) < 0) continue;
                var text = clean(fonts[i].text);
                if (text) return text;
            }
        }
        return '';
    }

    // 教师 / 教室拿不到就留空（null）：写「未知」会被当成真名显示
    function teacherOf(fonts) {
        var text = titledText(fonts, TEACHER_KEYS);
        if (!text) return null;
        // 「贺福利[副教授]」→「贺福利」（上游 cleanTeacher：职称方括号整段去掉）
        text = clean(text.replace(/[\[【][^\]】]*[\]】]/g, '').replace(TEACHER_PREFIX, ''));
        if (!text || text === '未知教师' || text === '未知') return null;
        return text;
    }

    function roomOf(fonts) {
        var text = clean(titledText(fonts, ROOM_KEYS));
        if (!text || text === '未知地点' || text === '未知') return null;
        return text;
    }

    // font[title="周次(节次)"] 的文本，本平台形如 "1-16(周)[01-02节]" / "1-8周(单)[03-04节]"：
    //   周次 = 方括号之外那一段，节次 = 方括号里面那一小段。
    // 有的页面把括号写成全角【】，或者压根没有方括号（整串都是周次），两种都认。
    // 方括号里的内容只有能读成节次时才算节次；读不成节次的整段去掉，但里面的单双标记要摘出来（"1-16周[单]" 不能塌成每周）。
    // bracket：文字里有没有方括号（上游给「带方括号」加 3 分）。
    function splitSpec(text) {
        var body = clean(text);
        var periods = '';
        var bracket = false;
        var weeks = clean(body.replace(/[\[【]\s*([^\]】]*)\s*[\]】]/g, function (whole, inside) {
            bracket = true;
            var one = clean(inside);
            if (!one) return ' ';
            if (periodsIn(one)) {
                if (!periods) periods = one;
                return whole;
            }
            return marksIn(one);
        }));
        return { weeks: weeks, periods: periods, bracket: bracket };
    }

    function marksIn(inside) {
        var one = clean(inside);
        if (!one) return ' ';
        var odd = one.indexOf('单') >= 0;
        var even = one.indexOf('双') >= 0;
        if (odd && even) return '单双';
        if (odd) return '单';
        if (even) return '双';
        return ' ';
    }

    // 一个课程块里的「周次(节次)」字段：上游 pickText(['周次(节次)', '周次', '节次'])，一个块里通常就一个，
    // 同一块里写两段也见过 —— 挨个读，不丢。标题含「周次」的 font 优先；没有时才看标题含「节次」的。
    // 独立的 font[title=单双周]：文字里有「单」或「双」就套上括号并入每一段周次串（上游 weeks += '(' + sd + ')'）。
    function specsOf(fonts) {
        var out = [];
        var onlyPeriods = '';
        var marks = '';
        for (var i = 0; i < fonts.length; i++) {
            var title = fonts[i].title;
            var text = clean(fonts[i].text);
            if (!text) continue;
            if (title.indexOf('单双') >= 0) {
                if (!marks && /[单双]/.test(text)) marks = text;
                continue;
            }
            var isWeek = title.indexOf('周次') >= 0;
            var isPeriodOnly = !isWeek && title.indexOf('节次') >= 0;
            if (!isWeek && !isPeriodOnly) continue;
            if (isPeriodOnly) {
                if (!onlyPeriods) onlyPeriods = text;
                continue;
            }
            out.push(splitSpec(text));
        }
        if (!out.length && onlyPeriods) out.push(splitSpec(onlyPeriods));
        if (marks) {
            for (var m = 0; m < out.length; m++) out[m].weeks = out[m].weeks + '(' + marks + ')';
        }
        return out;
    }

    // ---------- 周次 ----------
    // 周次解析里的计数先记在 st 里，等这条候选真的登记成一条安排了才并进全局计数：
    // 被丢掉的块（认不出节次、节次超范围）里的备注不能算进去
    function newStats() {
        return { serial: 0, notes: 0, noteSample: '', dropped: 0, orphan: 0, ambiguous: 0, samples: [] };
    }

    function addStats(st) {
        serialGroups += st.serial;
        noteGroups += st.notes;
        if (!noteSample && st.noteSample) noteSample = st.noteSample;
        droppedWeeks += st.dropped;
        orphanMarkers += st.orphan;
        ambiguousMarks += st.ambiguous;
        for (var i = 0; i < st.samples.length; i++) {
            if (ambiguousSamples.length < 3) addUnique(ambiguousSamples, st.samples[i]);
        }
    }

    function noteAmbiguous(segment, st) {
        st.ambiguous++;
        var text = clean(segment);
        if (!text || st.samples.indexOf(text) >= 0) return;
        if (st.samples.length >= 3) return;
        st.samples.push(text);
    }

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

    // 周次串 → 周次数组（去重、升序）。本平台的写法：
    //   1-16周(单) / (单)1-16周 / 1-16(单周) / 1-3,5-9周 / 1-8周(单),10-16周(双) / 1-16周 双 / 1-16(周) / 第3周 / 1-16周隔周
    //   「共 N 周」备注、区间终点前的「第」、括号里只有数字的教学班序号、括号里的其它备注，都不当周次。
    // 单双标记只跟它自己那一段走：「(单)」紧挨数字时先按相邻关系归属，再交给通用的括号处理。
    // 单双都写、或只写「隔周」定不下来上哪几周：按每周都上处理，但一定出声。
    function weeksIn(source, st) {
        var cleaned = clean(source);
        if (!cleaned) return [];
        // 方括号 / 【】里的是节次（"1-16周[01-02节]"）：整段去掉，免得节次的数字被当成周次
        cleaned = cleaned.replace(/[\[【][^\]】]*[\]】]/g, ' ');
        // 周次里常夹着「共8周」这类课程总周数备注，它不是上课周次，只剥备注本身：
        // 不能从第一个「共」一路删到行尾 —— 「1-8周(共8周),9-16周」后面的 9-16 周会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // 破折号（半角 / 全角 / 波浪 / 减号 / 「至」「到」）连同两侧空白先归成半角 '-'；不要在这里删掉全部空白
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 前缀写法 "(单)1-8周,(双)9-16周" 与 "(单)第1-第8周"（标记后面可以隔一个「第」）：标记只认在段首（字符串开头或分隔符之后）。
        // 标记前面紧挨着数字或「周」时它是上一段的后缀，"1-8周(单) 9-16周(双)" 里的 "(单)" 不能被后面的 "9" 抢去当前缀
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=第?\s*[0-9])/g, function (all, mark, offset, whole) {
            if (/[0-9周]\s*$/.test(whole.substring(0, offset))) return all;
            return mark;
        });
        // 后缀写法 "8周(单)"：折成 "8单"；后面紧跟下一段数字时补一个逗号隔开
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            var glue = /^\s*第?\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '';
            return digit + mark + glue;
        });
        // 括号逐组处理：只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉；含非周次字的（"(实验)"）是备注，也摘掉并另计；
        // 其余（"(周)"、"(单)"、"(1-16周)"）保留内容。每一组都换成逗号，不让两侧的数字粘在一起
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                st.serial++;
                return ',';
            }
            if (/[^0-9\s,单双周第-]/.test(inner)) {
                st.notes++;
                if (!st.noteSample) st.noteSample = all;
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        // 「第」字（第3周、区间终点前的「第1-第8周」）：全部去掉，否则「第1-第8」会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/第/g, '');
        var tokens = cleaned.replace(/\s+/g, ',').split(/[,]+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = clean(tokens[i]);
            if (token) segments.push(token);
        }
        // 单 / 双自己成一段（"1-16周 双"）时并给最近的周次段（先向前找，再向后）
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
            if (into < 0) { st.orphan++; continue; }
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
            if (onlyOdd && onlyEven) {
                noteAmbiguous(segment, st);
                onlyOdd = false;
                onlyEven = false;
            } else if (!onlyOdd && !onlyEven && segment.indexOf('隔') >= 0) {
                noteAmbiguous(segment, st);
            }
            var found = segment.match(/[0-9]+(?:-[0-9]+)?/g) || [];
            for (var f = 0; f < found.length; f++) {
                var bounds = found[f].split('-');
                var start = parseInt(bounds[0], 10);
                var end = bounds.length > 1 ? parseInt(bounds[1], 10) : start;
                if (isNaN(start) || isNaN(end)) continue;
                if (end < start) { var swap = start; start = end; end = swap; }
                for (var week = start; week <= end; week++) {
                    if (onlyOdd && week % 2 === 0) continue;
                    if (onlyEven && week % 2 === 1) continue;
                    if (week < 1 || week > MAX_WEEK) { st.dropped++; continue; }
                    if (!seen[week]) { seen[week] = true; weeks.push(week); }
                }
            }
        }
        weeks.sort(function (a, b) { return a - b; });
        return weeks;
    }

    // 节次：方括号里的内容。"01-02节" / "01-02小节" / "1-2节" / "0102节" / "030405节" / "09,10节" / "1、2节" / "第9,10节" 都认；
    // 连排的连字符（[01-02-03-04节]）取首尾。只负责读 min/max，不判上限（上限由调用方判，超限的块要点名）。
    function periodsIn(source) {
        var body = clean(source).replace(/[第节小\s]/g, '').replace(/[（）()]/g, '')
            .replace(/[～－−–—~至到]/g, '-');
        if (!body) return null;
        var start = null;
        var end = null;
        function note(value) {
            if (!(value >= 1)) return;
            if (start === null || value < start) start = value;
            if (end === null || value > end) end = value;
        }
        var segments = body.split(/[,，、;；]/);
        for (var i = 0; i < segments.length; i++) {
            var segment = segments[i];
            var range = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(segment);
            if (range) {
                note(parseInt(range[1], 10));
                note(parseInt(range[2], 10));
                continue;
            }
            if (/^\d{1,2}(\s*-\s*\d{1,2})+$/.test(segment)) {
                var ends = segment.split('-');
                note(parseInt(ends[0], 10));
                note(parseInt(ends[ends.length - 1], 10));
                continue;
            }
            if (/^\d+[.\/·|+&]\d+([.\/·|+&]\d+)*$/.test(segment)) {
                // 数字之间只隔着零散的标点（"1.2"、"1/2"）：同上游 match(/\d+/g) 的口径，取里面的全部数字
                var loose = segment.match(/\d+/g);
                for (var q = 0; q < loose.length; q++) note(parseInt(loose[q], 10));
                continue;
            }
            if (!/^\d+$/.test(segment)) return null;
            if (segment.length >= 4 && segment.length % 2 === 0) {
                for (var k = 0; k < segment.length; k += 2) note(parseInt(segment.substring(k, k + 2), 10));
            } else {
                note(parseInt(segment, 10));
            }
        }
        if (start === null || end === null) return null;
        return { start: start, end: end };
    }

    // 周次集合 → 极大段（移植手册 §4.1）：步长 1 视作每周，步长 2 视作单 / 双周
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

    // 「星期一」「周一」「礼拜一」都认。周历表的表头是单个字（日一二三四五六），所以另给一个只看单字的口径（allowBare）——
    // 只用在周历上：课表表头一律要求前缀，免得把某个只写着「一」字的格子当成星期表头。
    function dayOfLabel(value, allowBare) {
        var text = clean(value);
        var m = /(?:星期|周|礼拜)\s*([一二三四五六日天1-7])/.exec(text);
        if (!m) {
            if (!allowBare || text.length !== 1) return 0;
            var bare = DAY_CHARS.indexOf(text);
            if (bare < 0) return 0;
            return text === '天' ? 7 : bare + 1;
        }
        var at = DAY_CHARS.indexOf(m[1]);
        if (at >= 0) return m[1] === '天' ? 7 : at + 1;
        return parseInt(m[1], 10);
    }

    function colOf(cell) {
        return cell.col;
    }

    function spanOf(cell) {
        var span = cell ? cell.span : undefined;
        return (typeof span === 'number' && span >= 1) ? span : 1;
    }

    // 取「网格第 want 列」上的格子：一格覆盖 [col, col + span)，跨列的合并格在它覆盖到的每一列上都能取到
    function cellAtGridCol(row, want) {
        if (want < 0) return null;
        for (var i = 0; i < row.length; i++) {
            var start = colOf(row[i]);
            if (want >= start && want < start + spanOf(row[i])) return row[i];
        }
        return null;
    }

    // 「2026-2027-1」→「2026-2027学年第一学期」（教务只给了学期代码、或学期名就是代码时用它）
    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(clean(code));
        if (!m) return '';
        if (m[3] === '1') return m[1] + '-' + m[2] + '学年第一学期';
        if (m[3] === '2') return m[1] + '-' + m[2] + '学年第二学期';
        if (m[3] === '3') return m[1] + '-' + m[2] + '学年第三学期';
        return m[1] + '-' + m[2] + '学年第' + m[3] + '学期';
    }

    function minutesOf(text) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(clean(text));
        return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
    }

    function clockText(minutes) {
        return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
    }

    // 「课程块」的身份证：没有它就没法告诉用户哪一门课被跳过了（最多点名 3 个）
    function noteDropped(name, reason) {
        droppedTotal++;
        if (droppedNames.length >= 3) return;
        droppedNames.push((name ? shortName(name) : '(没认出课名)') + '——' + reason);
    }

    // ---- 星期表头：课表每一格按网格列号对齐星期 -------------------------------------
    // 表头行 = 没有课程明细、且能认出星期标签最多的那一行。中南的表头是「星期日、星期一…星期六」（星期日排在最前，上游 colToDay 同样按文字映射），
    // 所以只信表头里的文字，不按位置猜：认不出任何星期标签就直接报错（猜了会整周错位）。
    // 两本账分开记：cells 是带星期标签的格子数（同一天出现两次也算两个），labels 是认出来的不同天数（最多 7）。
    function findHeaderRow() {
        var best = { row: -1, labels: 0, cells: 0, cols: [0, -1, -1, -1, -1, -1, -1, -1] };
        for (var r = 0; r < rows.length; r++) {
            var hasContent = false;
            var cols = [0, -1, -1, -1, -1, -1, -1, -1];
            var labels = 0;
            var cells = 0;
            for (var c = 0; c < rows[r].length; c++) {
                if (rows[r][c].parts && rows[r][c].parts.length) hasContent = true;
                var day = dayOfLabel(rows[r][c].text, false);
                if (day < 1 || day > 7) continue;
                cells++;
                if (cols[day] >= 0) continue;
                cols[day] = colOf(rows[r][c]);
                labels++;
            }
            if (hasContent || labels < 1) continue;
            if (labels > best.labels) best = { row: r, labels: labels, cells: cells, cols: cols };
        }
        return best;
    }

    var header = findHeaderRow();
    if (header.row < 0) {
        throw new Error('课表顶部没有认出「星期几」的标题，没法确定每一列是星期几。请把教务页面的课表截图反馈给空课');
    }

    // 星期 d 落在网格第几列：只认表头给的列号；表头里没有这一天就不猜（进 warnings）
    var dayColOf = [0, -1, -1, -1, -1, -1, -1, -1];
    var unplacedDays = 0;
    var dd;
    for (dd = 1; dd <= 7; dd++) {
        if (header.cols[dd] >= 0) dayColOf[dd] = header.cols[dd];
        else unplacedDays++;
    }

    // ---- 本行行首表头里的节次：「1－2」「1-2」「1－2,3－4」（上游 parseSections：取全部数字的首尾）-----------------
    // extract.js 只把表头单元格（th）里的数字交出来（逗号连起来）；表头单元格优先，这一行没有 th 时看最左边那个没有课程的格子。
    // 数字太离谱（越过 MAX_PERIOD）照样交给调用方按「节次超范围」点名
    function rowSectionsOf(row) {
        var label = null;
        var i;
        for (i = 0; i < row.length; i++) {
            if (row[i].th === true) { label = row[i]; break; }
        }
        if (!label) {
            for (i = 0; i < row.length; i++) {
                if (row[i].parts && row[i].parts.length) continue;
                if (!label || colOf(row[i]) < colOf(label)) label = row[i];
            }
        }
        if (!label) return null;
        var text = clean(label.text);
        if (dayOfLabel(text, false)) return null;
        var nums = text.replace(/[０-９]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
        }).match(/\d+/g);
        if (!nums) return null;
        var first = parseInt(nums[0], 10);
        var last = parseInt(nums[nums.length - 1], 10);
        if (!(first >= 1) || !(last >= 1)) return null;
        return first <= last ? { start: first, end: last } : { start: last, end: first };
    }

    // ---- 主循环：逐格取课 ----------------------------------------------------------------
    var order = [];
    var byCourse = {};

    // 一格里的丢弃记录：同一格里同一个原因 + 同一个课名只记一次
    function dropOnce(cellDrops, name, reason) {
        var key = reason + SEP + name;
        if (cellDrops[key]) return;
        cellDrops[key] = true;
        if (reason === 'noName') {
            noNameBlocks++;
            noteDropped('', '没认出课名');
        } else if (reason === 'noWeek') {
            noWeekBlocks++;
            noteDropped(name, '没认出周次');
        } else if (reason === 'noPeriod') {
            noPeriodBlocks++;
            noteDropped(name, '没认出节次');
        } else {
            overPeriodBlocks++;
            noteDropped(name, '节次超出 ' + MAX_PERIOD + ' 节');
        }
    }

    // 一个课程块 → 零到多个候选（每个「周次(节次)」字段一个）。
    // 节次：上游只认本行行首表头里的数字（同格拼课共用本格节次，靠周次区分先后，绝不拆成不同节次）；
    // 本行认不出节次时才退而读周次字段方括号里写明的节次（上游没有这一步，读得出就比丢课好），都没有就计数并点名。
    function candidatesOfBlock(blockHtml, day, rowSections, cellDrops, out) {
        if (plainText(blockHtml) === '') return;    // 空块（只有 <br> / 减号）：不是课，也不算丢
        var fonts = fontsOf(blockHtml);
        var name = nameOf(blockHtml);
        if (!name) {
            dropOnce(cellDrops, '', 'noName');
            return;
        }
        var teacher = teacherOf(fonts);
        var location = roomOf(fonts);
        var specs = specsOf(fonts);
        if (!specs.length) {
            dropOnce(cellDrops, name, 'noWeek');
            return;
        }
        for (var s = 0; s < specs.length; s++) {
            var periods = rowSections ? { start: rowSections.start, end: rowSections.end } : null;
            if (!periods && specs[s].periods) periods = periodsIn(specs[s].periods);
            var st = newStats();
            var weeks = weeksIn(specs[s].weeks, st);
            if (!weeks.length) {
                dropOnce(cellDrops, name, 'noWeek');
                continue;
            }
            out.push({
                name: name,
                teacher: teacher,
                location: location,
                day: day,
                weeks: weeks,
                periods: periods,
                stats: st
            });
        }
    }

    function registerCandidate(item, cellDrops) {
        if (!item.periods) {
            dropOnce(cellDrops, item.name, 'noPeriod');
            return;
        }
        if (item.periods.end > MAX_PERIOD) {
            dropOnce(cellDrops, item.name, 'overPeriod');
            return;
        }
        addStats(item.stats);
        var key = item.name + SEP + (item.teacher || '');
        var course = byCourse[key];
        // 课程要等真产出一条安排才登记：不能在课表里留下一门「没有任何安排」的空课
        if (!course) {
            course = { name: item.name, teacher: item.teacher, entries: [], seen: {} };
            byCourse[key] = course;
            order.push(key);
        }
        var entry = {
            day: item.day,
            start: item.periods.start,
            end: item.periods.end,
            weeks: item.weeks,
            location: item.location
        };
        var entryKey = [entry.day, entry.start, entry.end, entry.weeks.join(','), entry.location || ''].join(SEP);
        if (course.seen[entryKey]) return;
        course.seen[entryKey] = true;
        course.entries.push(entry);
        if (!item.teacher) addUnique(missingTeacherNames, item.name);
        if (!item.location) addUnique(missingRoomNames, item.name);
    }

    for (var ri = 0; ri < rows.length; ri++) {
        if (ri === header.row) continue;
        var row = rows[ri];
        var rowSections = rowSectionsOf(row);
        var touched = [];
        var countedMerged = [];
        for (var d = 1; d <= 7; d++) {
            var cell = cellAtGridCol(row, dayColOf[d]);
            if (!cell) continue;
            if (touched.indexOf(cell) < 0) touched.push(cell);
            var parts = cell.parts || [];
            // 跨列的格子：它的课会落到它跨到的每一天（不复制就等于把课丢了，复制了就得说一声）
            if (parts.length && spanOf(cell) > 1 && countedMerged.indexOf(cell) < 0) {
                countedMerged.push(cell);
                mergedCells++;
            }
            var cellDrops = {};
            var candidates = [];
            for (var p = 0; p < parts.length; p++) {
                var blocks = String(parts[p]).split(DASHES);
                for (var b = 0; b < blocks.length; b++) candidatesOfBlock(blocks[b], d, rowSections, cellDrops, candidates);
            }
            for (var w = 0; w < candidates.length; w++) registerCandidate(candidates[w], cellDrops);
        }
        // 有课、却没有任何一天映射到它：表头 / 列号对不上时不能说丢就丢
        for (var mc = 0; mc < row.length; mc++) {
            if (row[mc].parts && row[mc].parts.length && touched.indexOf(row[mc]) < 0) unmappedCells++;
        }
    }

    if (order.length === 0) {
        // 一个块都没解析出来：要说清是「没课」还是「课都在解析时被跳过了」——后者是教务页面换了写法或数据有脏，不是没排课。
        if (droppedTotal > 0) {
            throw new Error(clipText('本学期没有解析到任何课程：课表里的 ' + droppedTotal +
                ' 个上课安排都没能认出来（周次或节次的写法不认识，或节次超出 ' + MAX_PERIOD +
                ' 节）。' + (droppedNames.length ? '包含：' + droppedNames.join('；') + '。' : '') +
                '请把教务页面的课表截图反馈给空课', MAX_WARNING_TEXT));
        }
        throw new Error(
            '本学期没有解析到任何课程：可能是还没排课，或教务页面改了结构（也可能登录状态已失效）'
        );
    }

    // ---- 合并（沿用上游 mergeAndDistinctCourses 的两步，以周次集合为单位）--------------------
    // 第一步：同一门课、同一天、同一教室、周次完全相同的相邻节次并成一条（第 4 节与第 5 节、第 8 节与第 9 节之间隔着饭点，不并；被包含的重复条也在这里去掉）。
    // 第二步：同一门课、同一天、同一节次、同一教室的几条，周次取并集。
    function mergeAdjacent(list) {
        var groups = {};
        var keys = [];
        var i;
        for (i = 0; i < list.length; i++) {
            var e = list[i];
            var k = [e.day, e.location || '', e.weeks.join(',')].join(SEP);
            if (!groups[k]) {
                groups[k] = [];
                keys.push(k);
            }
            groups[k].push(e);
        }
        var out = [];
        for (var g = 0; g < keys.length; g++) {
            var items = groups[keys[g]].slice(0);
            items.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
            var cur = null;
            for (i = 0; i < items.length; i++) {
                var item = items[i];
                if (!cur) {
                    cur = { day: item.day, start: item.start, end: item.end, weeks: item.weeks, location: item.location };
                    continue;
                }
                if (item.start >= cur.start && item.end <= cur.end) continue;
                if (item.start === cur.end + 1 && !NO_MERGE_AFTER[cur.end]) {
                    cur.end = item.end;
                    continue;
                }
                out.push(cur);
                cur = { day: item.day, start: item.start, end: item.end, weeks: item.weeks, location: item.location };
            }
            if (cur) out.push(cur);
        }
        return out;
    }

    function unionWeeks(list) {
        var groups = {};
        var keys = [];
        var i;
        for (i = 0; i < list.length; i++) {
            var e = list[i];
            var k = [e.day, e.start, e.end, e.location || ''].join(SEP);
            if (!groups[k]) {
                groups[k] = { day: e.day, start: e.start, end: e.end, weeks: [], location: e.location };
                keys.push(k);
            }
            for (var w = 0; w < e.weeks.length; w++) {
                if (groups[k].weeks.indexOf(e.weeks[w]) < 0) groups[k].weeks.push(e.weeks[w]);
            }
        }
        var out = [];
        for (var g = 0; g < keys.length; g++) {
            groups[keys[g]].weeks.sort(function (a, b) { return a - b; });
            out.push(groups[keys[g]]);
        }
        return out;
    }

    var maxWeek = 0;
    var maxPeriod = 0;
    for (var oi = 0; oi < order.length; oi++) {
        var held = byCourse[order[oi]];
        held.merged = unionWeeks(mergeAdjacent(held.entries));
        for (var ei = 0; ei < held.merged.length; ei++) {
            var me = held.merged[ei];
            if (me.end > maxPeriod) maxPeriod = me.end;
            if (me.weeks[me.weeks.length - 1] > maxWeek) maxWeek = me.weeks[me.weeks.length - 1];
        }
    }

    // ---- 组装课程 -------------------------------------------------------------------
    var courses = [];
    for (var ci2 = 0; ci2 < order.length; ci2++) {
        var item = byCourse[order[ci2]];
        var outBlocks = [];
        var blockSeen = {};
        for (var mi = 0; mi < item.merged.length; mi++) {
            var m2 = item.merged[mi];
            var runs = runsOf(m2.weeks);
            for (var rn = 0; rn < runs.length; rn++) {
                var block = {
                    dayOfWeek: m2.day,
                    startPeriod: m2.start,
                    endPeriod: m2.end,
                    startWeek: runs[rn].start,
                    endWeek: runs[rn].end,
                    weekType: runs[rn].weekType,
                    location: m2.location
                };
                var blockKey = [block.dayOfWeek, block.startPeriod, block.endPeriod, block.startWeek,
                    block.endWeek, block.weekType, block.location || ''].join(SEP);
                if (blockSeen[blockKey]) continue;
                blockSeen[blockKey] = true;
                outBlocks.push(block);
            }
        }
        outBlocks.sort(function (a, b) {
            return (a.dayOfWeek - b.dayOfWeek) || (a.startPeriod - b.startPeriod) ||
                (a.startWeek - b.startWeek) || (a.endWeek - b.endWeek);
        });
        courses.push({ name: item.name, teacher: item.teacher, note: null, blocks: outBlocks });
    }

    // ---- 教学周历：开学日期与学期总周数 ------------------------------------------------
    function firstCellOf(row) {
        if (!row || !row.length) return null;
        var first = row[0];
        for (var k = 1; k < row.length; k++) {
            if (colOf(row[k]) < colOf(first)) first = row[k];
        }
        return first;
    }

    // 周历日期「2026年09月07日」「2026年09月07」「2026-09-07」都认（上游正则两种分隔符都收）
    function isoOfCnDate(value) {
        var text = clean(value);
        var m = /(\d{4})\s*[-年]\s*(\d{1,2})\s*[-月]\s*(\d{1,2})/.exec(text);
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        // 日历日期要真存在（2027-02-31 会被载荷校验拒收，整次导入就白导了）
        var probe = new Date(year, month - 1, day);
        if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
            return null;
        }
        return year + '-' + pad2(month) + '-' + pad2(day);
    }

    // 开学日：上游 fetchSemesterInfo 取第一行（有 td 的第一行）里第一个带 title 日期的格子。
    // 这里取「第一格是周号的行」里、第一格以外第一个带日期的格子（title 优先、文字兜底），并带上这一行的周号：
    // 周号不是 1（第 1 周那一行整行没有日期）时，调用方按 (周号 - 1) x 7 天倒推回第 1 周并提醒。
    // 整份周历没有任何带周号的行时，取任意一行里第一个带日期的格子（weekNo 为 0），调用方同样提醒。找不到返回 null。
    function calendarFirstDate() {
        var r;
        var c;
        var iso;
        for (r = 0; r < calendarRows.length; r++) {
            var first = firstCellOf(calendarRows[r]);
            var num = first ? /^第?\s*(\d{1,3})\s*周?$/.exec(clean(first.text)) : null;
            if (!num) continue;
            var ordered = calendarRows[r].slice(0).sort(function (a, b) { return colOf(a) - colOf(b); });
            for (c = 0; c < ordered.length; c++) {
                if (ordered[c] === first) continue;
                iso = isoOfCnDate(ordered[c].title) || isoOfCnDate(ordered[c].text);
                if (iso) return { iso: iso, weekNo: parseInt(num[1], 10) };
            }
        }
        for (r = 0; r < calendarRows.length; r++) {
            for (c = 0; c < calendarRows[r].length; c++) {
                iso = isoOfCnDate(calendarRows[r][c].title) || isoOfCnDate(calendarRows[r][c].text);
                if (iso) return { iso: iso, weekNo: 0 };
            }
        }
        return null;
    }

    // 往前（后）推若干天，不用 Date.parse
    function shiftDays(isoDate, days) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
        return isoOf(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
    }

    // 周历里每一行第一个格子的整数（周号）的最大值：学期总周数至少要盖住它（上游同样取每行第一格的最大周号）
    function calendarWeekCount() {
        var max = 0;
        for (var r = 0; r < calendarRows.length; r++) {
            var first = firstCellOf(calendarRows[r]);
            if (!first) continue;
            var number = /^第?\s*(\d{1,3})\s*周?$/.exec(clean(first.text));
            if (!number) continue;
            var value = parseInt(number[1], 10);
            if (value > max) max = value;
        }
        return max;
    }

    var calendarWeeks = calendarWeekCount();
    // 总周数：有周历就用周历的周数；周历取不到才用课表里最晚的周次（上游同样）。
    // 课表里有更晚的周次才抬高到它（否则那一块的 endWeek 会超出 totalWeeks，载荷校验拒收）。超过 MAX_WEEK 的夹住并出声。
    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : maxWeek;
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    // ---- 节次时间：学校公布的 10 节，课表用到更晚的节次时再顺推（H3）--------------------
    var periodTimes = [];
    for (var pi = 0; pi < SLOT_TIMES.length; pi++) {
        var parts2 = SLOT_TIMES[pi].split('-');
        periodTimes.push({ periodIndex: pi + 1, start: parts2[0], end: parts2[1] });
    }
    var filledBySequence = [];
    var uncoveredFrom = 0;
    for (var extra = PERIOD_COUNT + 1; extra <= maxPeriod; extra++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > MAX_MINUTE) {
            uncoveredFrom = extra;
            break;
        }
        periodTimes.push({ periodIndex: extra, start: clockText(nextStart), end: clockText(nextEnd) });
        filledBySequence.push(extra);
    }

    if (!data.now) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
    var termName = '';
    var rawTermName = clean(term.name);
    if (rawTermName) termName = termNameFromCode(rawTermName) || rawTermName;
    else termName = termNameFromCode(term.code);

    // 开学日期的取法（依次）：① 周历第一行第一个带日期的格子（上游的口径）：它是星期日，每周就从星期日起算（上游 firstDayOfWeek=7），
    // 开学日取这个星期日本身；它是星期一，直接用；是别的星期几，对齐到所在周的周一并提醒；② 周历取不到，按提取时刻推算最近的周一。
    // 星期日起算与 ②、对齐都必须说明：推算值和真值在库里长得一模一样，不说用户就没有任何机会发现「现在第几周」是错的。
    var firstFound = calendarFirstDate();
    var firstDay = null;
    if (firstFound) {
        firstDay = firstFound.iso;
        if (firstFound.weekNo > 1) {
            firstDay = shiftDays(firstDay, -(firstFound.weekNo - 1) * 7);
            pushWarning('教务的教学周历里第 1 周没有日期，开学日期按第 ' + firstFound.weekNo + ' 周的日期（' + firstFound.iso +
                '）往前倒推到 ' + firstDay + '，请在「学期管理」里核对开学日期');
        } else if (firstFound.weekNo === 0) {
            pushWarning('教务的教学周历里认不出周次，开学日期是从周历里第一个日期（' + firstFound.iso +
                '）推出来的，不一定是第 1 周，请在「学期管理」里核对开学日期');
        }
    }
    var weekStartsOnSunday = false;
    if (firstDay) {
        var fm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(firstDay);
        var weekday = new Date(Number(fm[1]), Number(fm[2]) - 1, Number(fm[3])).getDay();
        if (weekday === 0) {
            weekStartsOnSunday = true;
        } else if (weekday !== 1) {
            var aligned = mondayOf(firstDay);
            pushWarning('教务的教学周历里第 1 周的第一个日期写的是 ' + firstDay +
                '（不是星期日也不是星期一），开学日期已按它所在那一周的周一（' + aligned +
                '）对齐，请在「学期管理」里核对');
            firstDay = aligned;
        }
    } else {
        firstDay = mondayOf(data.now);
        if (!firstDay) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');
        pushWarning('开学日期无法从教务获取（教学周历取不到或表格结构认不出来），已按最近的周一（' +
            firstDay + '）推算，请在「学期管理」里核对');
    }

    // ---- 逐条说清楚推算 / 假定 / 丢弃的东西（规范 §4 的 warnings）------------------------
    if (!termName) {
        termName = SCHOOL_NAME + '当前学期';
        pushWarning('没能识别出学年学期（课表页的「学年学期」下拉框认不出来），' +
            '学期名已用「' + termName + '」占位，请在「学期管理」里改名');
    }
    if (wantedWeeks > MAX_WEEK) {
        pushWarning('学期总周数算出来是 ' + wantedWeeks + ' 周，超过了上限 ' + MAX_WEEK +
            ' 周，已按 ' + MAX_WEEK + ' 周计，请在「学期管理」里核对');
    }
    if (calendarWeeks === 0) {
        pushWarning('教务没有给出学期总周数，已按课表里最晚的第 ' + maxWeek + ' 周计（共 ' + totalWeeks +
            ' 周），请在「学期管理」里核对');
    } else if (totalWeeks > calendarWeeks) {
        pushWarning('课表里有到第 ' + maxWeek + ' 周的课，比教务教学周历的 ' + calendarWeeks +
            ' 周多，学期总周数已按 ' + totalWeeks + ' 周计，请在「学期管理」里核对');
    }
    if (header.labels < 7) {
        pushWarning('课表顶部只认出了 ' + header.labels + ' 天的星期名称，其余 ' + unplacedDays +
            ' 天在课表里找不到位置，这几天的课没有导入，请核对导入结果');
    }
    if (header.cells > 7) {
        pushWarning('课表顶部出现了 ' + header.cells + ' 个星期名称，比星期一到星期日多：' +
            '同一天以第一次出现的为准，请核对导入结果');
    }
    if (weekStartsOnSunday) {
        pushWarning('教务的教学周历每周从星期日算起，第 1 周从 ' + firstDay + '（星期日）开始，周次按这个日子起算，请在「学期管理」里核对');
    }
    if (unmappedCells > 0) {
        pushWarning('有 ' + unmappedCells + ' 个格子里有课，但对不上星期几，这些课没有导入，请核对导入结果');
    }
    if (noColCells > 0) {
        pushWarning('有 ' + noColCells + ' 个格子无法确定它是星期几，已跳过，这些格子里的内容没有导入，请核对导入结果');
    }
    if (mergedCells > 0) {
        pushWarning('有 ' + mergedCells + ' 处课占了连续几天的格子，这些课被同时放进了这几天，请核对导入结果');
    }

    // 节次时间：学校公布的 10 节是上游写死的（上游同样），每次都请学生核对；
    // 课表用到学校公布的 10 节之外的节次时另说一声
    pushWarning('节次时间按学校校历公布的上课时间导入（2024-2025 学年起一致），学校如有调整，请在「学期管理」里核对');
    if (filledBySequence.length) {
        pushWarning('课表用到了第 ' + (PERIOD_COUNT + 1) + (filledBySequence.length > 1 ? ' 至 ' + filledBySequence[filledBySequence.length - 1] : '') +
            ' 节，学校公布的节次时间只有 ' + PERIOD_COUNT + ' 节，已按上一节下课后课间 ' + EXTEND_BREAK_MINUTES +
            ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推补上，请在「学期管理」里核对');
    }
    if (uncoveredFrom) {
        pushWarning('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }

    // 丢掉的块
    if (droppedTotal > 0) {
        var parts3 = [];
        if (noNameBlocks) parts3.push('没认出课名 ' + noNameBlocks + ' 个');
        if (noWeekBlocks) parts3.push('没认出周次 ' + noWeekBlocks + ' 个');
        if (noPeriodBlocks) parts3.push('没认出节次 ' + noPeriodBlocks + ' 个');
        if (overPeriodBlocks) parts3.push('节次超出 ' + MAX_PERIOD + ' 节 ' + overPeriodBlocks + ' 个');
        pushWarning('有 ' + droppedTotal + ' 个上课安排没能认出来，已跳过（' + parts3.join('，') + '）。' +
            '教务页面的写法可能有变化，欢迎反馈。包含：' + droppedNames.join('；'));
    }

    // 缺教师 / 缺教室：课照常导入（对应项为空），按类型汇总，不静默
    if (missingTeacherNames.length || missingRoomNames.length) {
        var fieldParts = [];
        if (missingTeacherNames.length) fieldParts.push(missingTeacherNames.length + ' 门课没给上课教师');
        if (missingRoomNames.length) fieldParts.push(missingRoomNames.length + ' 门课没给上课地点');
        var sampleNames = missingTeacherNames.slice(0);
        for (var sr = 0; sr < missingRoomNames.length; sr++) addUnique(sampleNames, missingRoomNames[sr]);
        var emptyText = missingTeacherNames.length && missingRoomNames.length
            ? '教师或地点暂时空着'
            : (missingTeacherNames.length ? '教师暂时空着' : '上课地点暂时空着');
        pushWarning('有 ' + fieldParts.join('、') + '（例如 ' + namesText(sampleNames) + '）：已照常导入，' +
            emptyText + '，可在「编辑课程」里补上');
    }

    // 周次写法里的备注
    if (serialGroups > 0) {
        pushWarning('有 ' + serialGroups + ' 处括号里只写了纯数字（如「(1)」「(1-2)」）：那是教学班序号不是周次，' +
            '已忽略，请核对这几门课的周次');
    }
    if (noteGroups > 0) {
        pushWarning('有 ' + noteGroups + ' 处周次里的括号备注（如「' + shortName(noteSample) + '」）不是周次，' +
            '已忽略，请核对这几门课的周次');
    }
    if (droppedWeeks > 0) {
        pushWarning('有 ' + droppedWeeks + ' 个周次超出 1-' + MAX_WEEK + ' 周，已丢弃（教务给出的周次不正常）');
    }
    if (orphanMarkers > 0) {
        pushWarning('有 ' + orphanMarkers + ' 处「单/双」标记找不到对应的周次（教务数据写得不完整），这些标记已忽略');
    }
    if (ambiguousMarks > 0) {
        var marks = ambiguousSamples.length ? '（' + ambiguousSamples.join('、') + '）' : '';
        pushWarning('有 ' + ambiguousMarks + ' 处周次里的单双 / 隔周标记认不出来' + marks +
            '，这些周次已按「每周都上」处理，请核对导入结果');
    }

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finalWarnings(),
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
