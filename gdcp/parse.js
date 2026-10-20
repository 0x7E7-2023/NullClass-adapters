(function () {
    // 广东交通职业技术学院（强智 · 高校综合管理教务系统 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 GDCP/gdcp_02.js（MIT，上游作者 Haooz；该脚本的作息数据与解析沿用同目录 gdcp_01.js，作者 小漫君）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //   上游快照 19a65bf（2026-10-19 拉取），GDCP 目录最后一次修改 14032a1。
    // 上游的核心：读 #timetable 每个格子里的 div.kbcontent，用「----------」把一格里的几门课分开；
    // 课程名取不带 title 的 font，font[title=教师] / font[title=周次(节次)] / font[title=教室] / font[title=教学楼] 取教师、周次与节次、教室、教学楼；
    // 开学日期与总周数来自教学周历（POST /jsxsd/jxzl/jxzl_query）。这里保持同一套字段来源。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 周次逐段判单双：上游 parseWeeksAndSections() 对整串文字只判一次单双，「1-8周(单),9-16周」会把后一段也当单周；
    //      这里先分段、每段各自判，「(单)1-8周,(双)9-16周」「1-8周(单) 9-16周(双)」都认，共 N 周的备注只剥备注本身，
    //      区间终点前的「第」（第1-第8周）、教学班序号括号（(1)、(1-2)）、括号备注（(实验)）都不当周次；
    //   ② 校区作息：上游 gdcp_02 按教学楼自动判断校区，第 3、4 节分「早班 10:10 起」「晚班 10:30 起」两套；
    //      空课的载荷只有一张全学期统一的节次时间，不能给单门课另设时间。这里同样按教学楼判断校区，
    //      人数多的一套写进节次时间，另一套的课照常导入并用一条提醒点名（课名截 20 字）；
    //   ③ 教学楼名里带校区后缀（「09号楼（天河）」）时，按它直接定校区；上游把后缀丢掉再靠计数猜；
    //   ④ 校区拿不准的情形不再让整次导入失败（上游 throw）：教学楼不在学校公布的名单里、没写教学楼，都照常导入并出提醒；
    //   ⑤ 上游把连续节次的同一门课并成一条（并到第 4 节与第 5 节也会并）；这里照并，但不跨过中午（第 4 节与第 5 节之间不并）；
    //   ⑥ 课表用到的节次超出学校公布的 12 节时，上游直接报错；这里按「统一修订 H3」顺推补上节次时间并提醒；
    //   ⑦ 第 7-8、9-10、11-12 节学校各算一整段连堂：上游给课程写自定义起止时间，载荷没有这个字段，
    //      这三段在节次时间里首尾相接（与上游预设的节次时间一致），只占半段的课用一条提醒点名；
    //   ⑧ 上游静默丢掉的块（没课名 / 没周次 / 没节次 / 节次超范围）全部计数并点名；缺教师 / 缺教室照常导入并汇总提醒；
    //   ⑨ 开学日期不是星期一时对齐到所在周的周一并出提醒（上游直接报错）；周历取不到时按提取日期推算并出提醒（上游报错）。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，CI 的 Rhino 里没有 DOM）：
    //   { source, pageUrl, now: "2026-09-13", term: { code, name }, screenTermMissing, cols: 8,
    //     calendar: { found, rows: [ [ { col, text, title } ] ] },
    //     rows: [ [ { col, span, text, parts: [原始 HTML] } ] ] }
    //   parts 里的 HTML 已经去掉了悬浮详情（.item-box）。pageUrl 只含协议、主机与路径（不含查询串），parse.js 不读它。
    var data = JSON.parse(__ncInput);
    var rows;
    var term = data.term || {};
    var calendarRows;

    var SCHOOL_NAME = '广东交通职业技术学院';

    // 学校《各校区上课作息时间表（新）》：12 节，每小节 40 分钟，逐节照抄上游 GDCP_TIME_SLOTS。
    // 第 7-8、9-10、11-12 节各是一整段 80 分钟连堂，所以第 7 节与第 8 节、第 9 节与第 10 节、第 11 节与第 12 节首尾相接。
    var SLOT_TIMES = [
        '08:30-09:10', '09:15-09:55', '10:10-10:50', '10:55-11:35',
        '14:15-14:55', '15:00-15:40', '15:55-16:35', '16:35-17:15',
        '18:05-18:45', '18:45-19:25', '19:40-20:20', '20:20-21:00'
    ];
    // 晚班的第 3、4 节（上游 GDCP_LATE_MORNING），其余节次与早班相同
    var LATE_SLOTS = { 3: '10:30-11:10', 4: '11:15-11:55' };
    var PERIOD_COUNT = SLOT_TIMES.length;

    // 校区与楼栋名单（逐项照抄上游 GDCP_CAMPUSES）。early：第 3、4 节 10:10 起；late：第 3、4 节 10:30 起。
    // 轨道楼未列入学校原表，上游注明用户确认按早班算。国际校区名单之外的「其他区域」按晚班算。
    var CAMPUSES = [
        { name: '天河校区', mark: '天河', early: ['9号楼', '10号楼', '12号楼', '图书馆', '公路楼', '汽车实训楼', '轨道楼'], late: ['2号楼', '运动场'] },
        { name: '花都校区', mark: '花都', early: ['1号楼', '图书馆'], late: ['10号楼', '15号楼', '16号楼', '运动场'] },
        { name: '国际校区', mark: '国际', early: ['教学楼', '运动场'], late: [] },
        { name: '清远校区', mark: '清远', early: ['厚德楼', '明德楼', '立业楼', '创新楼', '求是楼', '笃实楼'], late: ['融新楼', '融创楼', '运动场', '体育馆'] }
    ];

    // 连续节次并成一条时不跨过的位置：第 4 节与第 5 节之间隔着中午（11:35 到 14:15）
    var NO_MERGE_AFTER = { 4: true };
    // 学校把这三段各算一整段连堂：从第 8、10、12 节开始，或到第 7、9、11 节结束的课只占了半段
    var BLOCK_START_INSIDE = { 8: true, 10: true, 12: true };
    var BLOCK_END_INSIDE = { 7: true, 9: true, 11: true };

    // 节次上限：越过它一定是脏数据（学校公布 12 节；更晚的节次按 H3 顺推补时间，顺推越过 23:59 就停）
    var MAX_PERIOD = 20;
    var EXTEND_BREAK_MINUTES = 5;   // 顺推补节次时间：课间
    var EXTEND_CLASS_MINUTES = 45;  // 顺推补节次时间：每节
    // 没有周历周数时的兜底总周数（上游 semesterTotalWeeks 取周历首列最大周号，这里取不到才 20）
    var FALLBACK_TOTAL_WEEKS = 20;
    // 载荷校验的总周数上限（1..30）：超过 30 的周次按脏数据丢弃并出声
    var MAX_WEEK = 30;
    // 载荷校验的上限：警告 ≤20 条、每条 ≤200 字；点名的课名最多显示 20 字
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var MAX_MINUTE = 23 * 60 + 59;

    // 一格里放多门课时，教务用一长串减号分隔（上游要求 10 个以上并紧跟换行，这里放宽到 5 个以上，全角减号也认）
    var DASHES = /-{5,}|－{5,}/;
    var TEACHER_TITLE = /^(老师|教师|任课教师|授课教师|教师姓名)$/;
    var ROOM_TITLE = /^(教室|上课地点|上课教室|地点|教室名称)$/;
    var BUILDING_TITLE = /^教学楼$/;
    var COURSE_TITLE = /^(课程|课程名称|课程名|科目)$/;
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

    // 提醒里点名的课名 / 楼名：截到 NAME_TEXT_LIMIT 字，整条提醒再过 pushWarning 的 200 字出口
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

    // 课程名：上游取第一个不带 title 的 font（querySelector('font:not([title])')）。
    // 兜底一：第一个 font 之前的第一行裸文本（强智的另一种写法）；兜底二：显式标了课程名的字段。都没有就返回空串，调用方计数并点名。
    function nameOf(blockHtml, fonts) {
        var i;
        for (i = 0; i < fonts.length; i++) {
            if (fonts[i].title === '' && fonts[i].text) return fonts[i].text;
        }
        var lines = String(blockHtml).split(/<font\b/i)[0].split(/<br\s*\/?>/i);
        for (i = 0; i < lines.length; i++) {
            var line = plainText(lines[i]);
            if (line) return line;
        }
        for (i = 0; i < fonts.length; i++) {
            if (COURSE_TITLE.test(fonts[i].title) && fonts[i].text) return fonts[i].text;
        }
        return '';
    }

    function titledText(fonts, pattern) {
        for (var i = 0; i < fonts.length; i++) {
            if (!pattern.test(fonts[i].title)) continue;
            var text = clean(fonts[i].text);
            if (text) return text;
        }
        return '';
    }

    // 教师 / 教室拿不到就留空（null）：写「未知」会被当成真名显示
    function teacherOf(fonts) {
        var text = titledText(fonts, TEACHER_TITLE);
        if (!text) return null;
        text = clean(text.replace(TEACHER_PREFIX, ''));
        if (!text || text === '未知教师' || text === '未知') return null;
        return text;
    }

    function roomOf(fonts) {
        var text = titledText(fonts, ROOM_TITLE);
        if (!text || text === '未知地点' || text === '未知') return null;
        return text;
    }

    function buildingOf(fonts) {
        return titledText(fonts, BUILDING_TITLE);
    }

    // font[title="周次(节次)"] 的文本，本平台形如 "1-16(周)[01-02节]" / "1-8周(单)[03-04节]"：
    //   周次 = 方括号之外那一段，节次 = 方括号里面那一小段。
    // 有的页面把括号写成全角【】，或者压根没有方括号（整串都是周次），两种都认。
    // 方括号里的内容只有能读成节次时才算节次；读不成节次的整段去掉，但里面的单双标记要摘出来（"1-16周[单]" 不能塌成每周）。
    function splitSpec(text) {
        var body = clean(text);
        var periods = '';
        var weeks = clean(body.replace(/[\[【]\s*([^\]】]*)\s*[\]】]/g, function (whole, inside) {
            var one = clean(inside);
            if (!one) return ' ';
            if (periodsIn(one)) {
                if (!periods) periods = one;
                return whole;
            }
            return marksIn(one);
        }));
        return { weeks: weeks, periods: periods };
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

    // 一个课程块里的「周次(节次)」字段：一个块里通常就一个，同一格里写两段也见过 —— 挨个读，不丢。
    function specsOf(fonts) {
        var out = [];
        var onlyPeriods = '';
        for (var i = 0; i < fonts.length; i++) {
            var title = fonts[i].title;
            var text = clean(fonts[i].text);
            if (!text) continue;
            var isWeek = title.indexOf('周次') >= 0;
            var isPeriodOnly = !isWeek && /^节次$/.test(title);
            if (!isWeek && !isPeriodOnly) continue;
            if (isPeriodOnly) {
                if (!onlyPeriods) onlyPeriods = text;
                continue;
            }
            out.push(splitSpec(text));
        }
        if (out.length && !out[0].periods && onlyPeriods) out[0].periods = onlyPeriods;
        return out;
    }

    // ---------- 周次 ----------
    function noteAmbiguous(segment) {
        ambiguousMarks++;
        var text = clean(segment);
        if (!text || ambiguousSamples.indexOf(text) >= 0) return;
        if (ambiguousSamples.length >= 3) return;
        ambiguousSamples.push(text);
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
    function weeksIn(source) {
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
                serialGroups++;
                return ',';
            }
            if (/[^0-9\s,单双周第-]/.test(inner)) {
                noteGroups++;
                if (!noteSample) noteSample = all;
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
            if (onlyOdd && onlyEven) {
                noteAmbiguous(segment);
                onlyOdd = false;
                onlyEven = false;
            } else if (!onlyOdd && !onlyEven && segment.indexOf('隔') >= 0) {
                noteAmbiguous(segment);
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
                    if (week < 1 || week > MAX_WEEK) { droppedWeeks++; continue; }
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

    // 首列是不是「节次」列（"第1-2节" / "1-2" / "第3节" / "0102"）
    function isPeriodLabel(value) {
        return /^第?\s*\d{1,2}\s*([-—~至]\s*\d{1,2})?\s*节?$/.test(clean(value));
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

    // 表宽 = 整张表用到的最大网格列数（把 colspan 算进去）。无表头兜底的窗口起点要用它，不能用某一行的格子数
    function gridWidthOf(allRows) {
        var width = Math.max(0, Math.floor(Number(data.cols) || 0));
        for (var r = 0; r < allRows.length; r++) {
            var row = allRows[r] || [];
            for (var c = 0; c < row.length; c++) {
                var end = colOf(row[c]) + spanOf(row[c]);
                if (end > width) width = end;
            }
        }
        return width;
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
    // 表头行 = 没有课程明细、且能认出 ≥4 个星期标签的那一行。两本账分开记：cells 是带星期标签的格子数
    // （同一天出现两次也算两个），labels 是认出来的不同天数（最多 7）。
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
            if (hasContent || labels < 4) continue;
            if (labels > best.labels) best = { row: r, labels: labels, cells: cells, cols: cols };
        }
        return best;
    }

    var header = findHeaderRow();
    var tableCols = gridWidthOf(rows);

    // 无表头兜底：整张表最后 7 列依次是星期一到星期日。表宽 ≤7 列时先看看首列是不是节次标签列
    var fallbackStart = tableCols > 7 ? tableCols - 7 : 0;
    if (tableCols <= 7) {
        for (var fr = 0; fr < rows.length; fr++) {
            if (rows[fr].length && isPeriodLabel(rows[fr][0].text)) {
                fallbackStart = 1;
                break;
            }
        }
    }

    // 星期 d 落在网格第几列：① 表头认出了这个天 → 用表头给的列号；② 否则按表宽推（最后 7 列）；
    // ③ 推出来的列已经被别的天占了、或超出表宽 → 不猜，宁可少认一天（进 warnings）。
    var dayColOf = [0, -1, -1, -1, -1, -1, -1, -1];
    var usedCols = {};
    var guessedDays = 0;
    var unplacedDays = 0;
    var dd;
    for (dd = 1; dd <= 7; dd++) {
        if (header.labels >= 4 && header.cols[dd] >= 0) {
            dayColOf[dd] = header.cols[dd];
            usedCols[dayColOf[dd]] = true;
        }
    }
    for (dd = 1; dd <= 7; dd++) {
        if (dayColOf[dd] >= 0) continue;
        var guess = fallbackStart + dd - 1;
        if (guess < 0 || (tableCols > 0 && guess >= tableCols) || usedCols[guess]) {
            unplacedDays++;
            continue;
        }
        dayColOf[dd] = guess;
        usedCols[guess] = true;
        guessedDays++;
    }

    // ---- 主循环：逐格取课 ----------------------------------------------------------------
    var order = [];
    var byCourse = {};

    function collectBlock(blockHtml, day) {
        if (plainText(blockHtml) === '') return;    // 空块（只有 <br> / 减号）：不是课，也不算丢
        var fonts = fontsOf(blockHtml);
        var name = nameOf(blockHtml, fonts);
        if (!name) {
            noNameBlocks++;
            noteDropped('', '没认出课名');
            return;
        }
        var teacher = teacherOf(fonts);
        var location = roomOf(fonts);
        var building = buildingOf(fonts);
        var specs = specsOf(fonts);
        if (!specs.length) {
            noWeekBlocks++;
            noteDropped(name, '没认出周次与节次');
            return;
        }
        for (var s = 0; s < specs.length; s++) {
            var periods = specs[s].periods ? periodsIn(specs[s].periods) : null;
            if (!periods) {
                noPeriodBlocks++;
                noteDropped(name, '没认出节次');
                continue;
            }
            if (periods.end > MAX_PERIOD) {
                overPeriodBlocks++;
                noteDropped(name, '节次超出 ' + MAX_PERIOD + ' 节');
                continue;
            }
            var weeks = weeksIn(specs[s].weeks);
            if (!weeks.length) {
                noWeekBlocks++;
                noteDropped(name, '没认出周次');
                continue;
            }
            var key = name + SEP + (teacher || '');
            var course = byCourse[key];
            // 课程要等真产出一条安排才登记：不能在课表里留下一门「没有任何安排」的空课
            if (!course) {
                course = { name: name, teacher: teacher, entries: [], seen: {} };
                byCourse[key] = course;
                order.push(key);
            }
            var entry = {
                day: day,
                start: periods.start,
                end: periods.end,
                weeks: weeks,
                location: location,
                building: building
            };
            var entryKey = [day, periods.start, periods.end, weeks.join(','), location || '', building].join(SEP);
            if (course.seen[entryKey]) continue;
            course.seen[entryKey] = true;
            course.entries.push(entry);
            if (!teacher) addUnique(missingTeacherNames, name);
            if (!location) addUnique(missingRoomNames, name);
        }
    }

    for (var ri = 0; ri < rows.length; ri++) {
        if (ri === header.row) continue;
        var row = rows[ri];
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
            for (var p = 0; p < parts.length; p++) {
                var blocks = String(parts[p]).split(DASHES);
                for (var b = 0; b < blocks.length; b++) collectBlock(blocks[b], d);
            }
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
    // 第一步：同一门课、同一天、同一教室与教学楼、周次完全相同的相邻节次并成一条（第 4 节与第 5 节之间隔着中午，不并；被包含的重复条也在这里去掉）。
    // 第二步：同一门课、同一天、同一节次、同一教室与教学楼的几条，周次取并集。
    function mergeAdjacent(list) {
        var groups = {};
        var keys = [];
        var i;
        for (i = 0; i < list.length; i++) {
            var e = list[i];
            var k = [e.day, e.location || '', e.building, e.weeks.join(',')].join(SEP);
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
                    cur = { day: item.day, start: item.start, end: item.end, weeks: item.weeks, location: item.location, building: item.building };
                    continue;
                }
                if (item.start >= cur.start && item.end <= cur.end) continue;
                if (item.start === cur.end + 1 && !NO_MERGE_AFTER[cur.end]) {
                    cur.end = item.end;
                    continue;
                }
                out.push(cur);
                cur = { day: item.day, start: item.start, end: item.end, weeks: item.weeks, location: item.location, building: item.building };
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
            var k = [e.day, e.start, e.end, e.location || '', e.building].join(SEP);
            if (!groups[k]) {
                groups[k] = { day: e.day, start: e.start, end: e.end, weeks: [], location: e.location, building: e.building };
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
    var allEntries = [];
    for (var oi = 0; oi < order.length; oi++) {
        var held = byCourse[order[oi]];
        held.merged = unionWeeks(mergeAdjacent(held.entries));
        for (var ei = 0; ei < held.merged.length; ei++) {
            var me = held.merged[ei];
            me.courseName = held.name;
            allEntries.push(me);
            if (me.end > maxPeriod) maxPeriod = me.end;
            if (me.weeks[me.weeks.length - 1] > maxWeek) maxWeek = me.weeks[me.weeks.length - 1];
        }
    }

    // ---- 校区与第 3、4 节的上课时间 ---------------------------------------------------
    // 学校给第 3、4 节排了两套时间（早班 10:10 起、晚班 10:30 起），哪一套取决于教学楼所在的校区。
    // 做法照上游 gdcp_02：按教学楼名单统计各校区得票，票最多的就是上课校区；人数多的一套写进节次时间，另一套的课提醒。
    function venueOf(building) {
        var raw = clean(building).replace(/[【】]/g, '');
        var mark = null;
        var m = /[（(]\s*(天河|花都|国际|清远)\s*(?:校区)?\s*[）)]\s*$/.exec(raw);
        if (m) {
            mark = m[1];
            raw = clean(raw.substring(0, m.index));
        }
        raw = raw.replace(/^0+([0-9]+号楼)$/, '$1').replace(/^操场$/, '运动场');
        return { venue: raw, mark: mark };
    }

    function nameMatches(venue, name) {
        return venue === name || venue.indexOf(name + '（') === 0 || venue.indexOf(name + '(') === 0;
    }

    function inList(list, venue) {
        for (var i = 0; i < list.length; i++) {
            if (nameMatches(venue, list[i])) return true;
        }
        return false;
    }

    function listedIn(campus, venue) {
        return inList(campus.early, venue) || inList(campus.late, venue);
    }

    function campusByMark(mark) {
        for (var i = 0; i < CAMPUSES.length; i++) {
            if (CAMPUSES[i].mark === mark) return CAMPUSES[i];
        }
        return null;
    }

    // 这个校区里这栋楼的第 3、4 节走哪一套；国际校区名单之外的「其他区域」是学校表格明确规定的第二套（晚班）；其余认不出返回 null
    function groupIn(campus, venue) {
        if (inList(campus.early, venue)) return 'early';
        if (inList(campus.late, venue)) return 'late';
        if (campus.name === '国际校区') return 'late';
        return null;
    }

    var overlapping = [];
    var votes = {};
    var ei2;
    for (ei2 = 0; ei2 < allEntries.length; ei2++) {
        var entry2 = allEntries[ei2];
        entry2.vinfo = entry2.building ? venueOf(entry2.building) : null;
        if (entry2.start <= 4 && entry2.end >= 3) overlapping.push(entry2);
        if (!entry2.vinfo) continue;
        if (entry2.vinfo.mark) {
            var marked = campusByMark(entry2.vinfo.mark);
            votes[marked.name] = (votes[marked.name] || 0) + 1;
            continue;
        }
        for (var ci = 0; ci < CAMPUSES.length; ci++) {
            if (listedIn(CAMPUSES[ci], entry2.vinfo.venue)) votes[CAMPUSES[ci].name] = (votes[CAMPUSES[ci].name] || 0) + 1;
        }
    }

    var pickedCampus = null;
    var bestVotes = 0;
    var cj;
    for (cj = 0; cj < CAMPUSES.length; cj++) {
        if ((votes[CAMPUSES[cj].name] || 0) > bestVotes) {
            bestVotes = votes[CAMPUSES[cj].name];
            pickedCampus = CAMPUSES[cj];
        }
    }
    var tiedCampuses = [];
    for (cj = 0; cj < CAMPUSES.length; cj++) {
        if (bestVotes > 0 && votes[CAMPUSES[cj].name] === bestVotes) tiedCampuses.push(CAMPUSES[cj]);
    }

    // 一门课（一段安排）的第 3、4 节属于哪一套：带校区后缀的按后缀；没带的优先按上课校区；
    // 这栋楼不在上课校区的名单里、却在别的校区的名单里时，按第一个列了它的校区；都不是就认不出（null）
    function groupOfEntry(entry, campus) {
        var info = entry.vinfo;
        if (!info) return null;
        var own = null;
        if (info.mark) own = campusByMark(info.mark);
        else if (campus && listedIn(campus, info.venue)) own = campus;
        else {
            for (var i = 0; i < CAMPUSES.length; i++) {
                if (listedIn(CAMPUSES[i], info.venue)) {
                    own = CAMPUSES[i];
                    break;
                }
            }
        }
        if (!own) own = campus;
        if (!own) return null;
        return groupIn(own, info.venue);
    }

    function groupsFor(campus) {
        var out = [];
        for (var i = 0; i < overlapping.length; i++) out.push(groupOfEntry(overlapping[i], campus));
        return out;
    }

    var groups = groupsFor(pickedCampus);
    var tieMatters = false;
    for (var tc = 0; tc < tiedCampuses.length && tiedCampuses.length > 1; tc++) {
        var other = groupsFor(tiedCampuses[tc]);
        for (var og = 0; og < other.length; og++) {
            if (other[og] !== groups[og]) tieMatters = true;
        }
    }

    var earlyCount = 0;
    var lateCount = 0;
    for (var gi = 0; gi < groups.length; gi++) {
        if (groups[gi] === 'early') earlyCount++;
        else if (groups[gi] === 'late') lateCount++;
    }
    // 第 3、4 节的节次时间取人数多的一套；一样多、或一个都没有时用早班（上游同样的口径）
    var majority = lateCount > earlyCount ? 'late' : 'early';
    var minorityNames = [];
    var minorityVenues = [];
    var unknownNames = [];
    var unknownVenues = [];
    for (gi = 0; gi < overlapping.length; gi++) {
        var ov = overlapping[gi];
        if (groups[gi] === null) {
            addUnique(unknownNames, ov.courseName);
            if (ov.vinfo) addUnique(unknownVenues, ov.vinfo.venue);
        } else if (groups[gi] !== majority) {
            addUnique(minorityNames, ov.courseName);
            addUnique(minorityVenues, ov.vinfo.venue);
        }
    }

    // 只占半段连堂的课（第 8、10、12 节开始，或第 7、9、11 节结束）
    var halfBlockNames = [];
    for (var hb = 0; hb < allEntries.length; hb++) {
        if (BLOCK_START_INSIDE[allEntries[hb].start] || BLOCK_END_INSIDE[allEntries[hb].end]) {
            addUnique(halfBlockNames, allEntries[hb].courseName);
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

    // 周历的表头是单字（日一二三四五六），认不出来就不按位置取开学日期 —— 按位置猜会差一整周
    function calendarHeader() {
        var best = null;
        var bestLabels = 0;
        for (var r = 0; r < calendarRows.length; r++) {
            var cols = [0, -1, -1, -1, -1, -1, -1, -1];
            var labels = 0;
            for (var c = 0; c < calendarRows[r].length; c++) {
                var day = dayOfLabel(calendarRows[r][c].text, true);
                if (day < 1 || day > 7 || cols[day] >= 0) continue;
                cols[day] = colOf(calendarRows[r][c]);
                labels++;
            }
            if (labels > bestLabels) {
                bestLabels = labels;
                best = cols;
            }
        }
        return bestLabels >= 4 ? best : null;
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

    // 第 1 周那一行的「星期一」格：日期在 td[title] 上，有的部署写成格子文字，两种都读（上游同样 title 优先、文字兜底）
    function calendarFirstMonday() {
        var headerCols = calendarHeader();
        if (!headerCols || headerCols[1] < 0) return null;
        for (var r = 0; r < calendarRows.length; r++) {
            var row = calendarRows[r];
            var first = firstCellOf(row);
            if (!first) continue;
            if (!/^第?\s*1\s*周?$/.test(clean(first.text))) continue;
            var cell = cellAtGridCol(row, headerCols[1]);
            if (!cell) continue;
            var iso = isoOfCnDate(cell.title) || isoOfCnDate(cell.text);
            if (iso) return iso;
        }
        return null;
    }

    // 开学日期的备选口径（周历里找不到「星期一」格时用）：按行序取第一个带日期的格子
    function calendarFirstTitled() {
        for (var r = 0; r < calendarRows.length; r++) {
            for (var c = 0; c < calendarRows[r].length; c++) {
                var iso = isoOfCnDate(calendarRows[r][c].title);
                if (iso) return iso;
            }
        }
        return null;
    }

    // 备选口径的日期 → 周一。第一个带日期的格子常是星期日（属于上一周的末尾），那就取它后面一天；其余按所在那一周的周一对齐
    function mondayFromTitled(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        var day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (day.getDay() === 0) {
            return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1));
        }
        return mondayOf(iso);
    }

    // 周历里每一行第一个格子的整数（周号）的最大值：学期总周数至少要盖住它（上游同样取每行第一格的最大周号）
    function calendarWeekCount() {
        var max = 0;
        for (var r = 0; r < calendarRows.length; r++) {
            var first = firstCellOf(calendarRows[r]);
            if (!first) continue;
            var number = /^(\d{1,3})$/.exec(clean(first.text));
            if (!number) continue;
            var value = parseInt(number[1], 10);
            if (value > max) max = value;
        }
        return max;
    }

    var calendarWeeks = calendarWeekCount();
    // 总周数：有周历就用周历的周数；课表里有更晚的周次才抬高到它（否则那一块的 endWeek 会超出 totalWeeks，载荷校验拒收）。
    // 没有周历才按兜底的 20 周。超过 MAX_WEEK 的夹住并出声。
    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    // ---- 节次时间：学校公布的 12 节（第 3、4 节取人数多的一套），课表用到更晚的节次时再顺推（H3）--------------------
    var periodTimes = [];
    for (var pi = 0; pi < SLOT_TIMES.length; pi++) {
        var pair = (majority === 'late' && LATE_SLOTS[pi + 1]) ? LATE_SLOTS[pi + 1] : SLOT_TIMES[pi];
        var parts2 = pair.split('-');
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

    // 开学日期的取法（依次）：① 周历第 1 周那一行的「星期一」格（真实值）；② 周历里第一个带日期的格子，
    // 对齐到第 1 周的周一；③ 都认不出来，按提取时刻推算最近的周一。②③ 必须说明：推算值和真值在库里
    // 长得一模一样，不说用户就没有任何机会发现「现在第几周」是错的。
    var firstDay = calendarFirstMonday();
    var titledDay = firstDay ? null : calendarFirstTitled();
    if (firstDay) {
        var aligned = mondayOf(firstDay);
        if (aligned && aligned !== firstDay) {
            pushWarning('教务的教学周历里第 1 周的星期一写的是 ' + firstDay +
                '（那天不是星期一），开学日期已按它所在那一周的周一（' + aligned +
                '）对齐，请在「学期管理」里核对');
            firstDay = aligned;
        }
    } else if (titledDay) {
        firstDay = mondayFromTitled(titledDay);
        if (firstDay !== titledDay) {
            pushWarning('教务的教学周历没有标出第 1 周的星期一，开学日期已由第一个日期格（' + titledDay +
                '）对齐为周一（' + firstDay + '），请在「学期管理」里核对');
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
    if (data.screenTermMissing === true) {
        pushWarning('课表页上找不到「学年学期」下拉框，无法确认屏幕上的课表是哪一学期，' +
            '导入的是教务默认选中的学期（' + termName + '），请核对是否是要导入的那一学期');
    }
    if (wantedWeeks > MAX_WEEK) {
        pushWarning('学期总周数算出来是 ' + wantedWeeks + ' 周，超过了上限 ' + MAX_WEEK +
            ' 周，已按 ' + MAX_WEEK + ' 周计，请在「学期管理」里核对');
    }
    if (calendarWeeks === 0) {
        if (maxWeek > FALLBACK_TOTAL_WEEKS) {
            pushWarning('教务没有给出学期总周数，课表里有到第 ' + maxWeek + ' 周的课，已按 ' + totalWeeks +
                ' 周计，请在「学期管理」里核对');
        } else {
            pushWarning('教务没有给出学期总周数，已按 ' + FALLBACK_TOTAL_WEEKS + ' 周计，请在「学期管理」里核对');
        }
    } else if (totalWeeks > calendarWeeks) {
        pushWarning('课表里有到第 ' + maxWeek + ' 周的课，比教务教学周历的 ' + calendarWeeks +
            ' 周多，学期总周数已按 ' + totalWeeks + ' 周计，请在「学期管理」里核对');
    }
    if (header.labels === 0) {
        pushWarning('课表顶部没有认出星期几的标题，已按课表最右边 7 列推断为星期一到星期日' +
            (tableCols > 0 ? '（本表共 ' + tableCols + ' 列）' : '') +
            '，课表可能整体错位，请核对导入结果');
    } else {
        if (header.labels < 7) {
            pushWarning('课表顶部只认出了 ' + header.labels + ' 天的星期名称，其余 ' + guessedDays +
                ' 天按课表最右边 7 列推断，请核对导入结果');
        }
        if (header.cells > 7) {
            pushWarning('课表顶部出现了 ' + header.cells + ' 个星期名称，比星期一到星期日多：' +
                '同一天以第一次出现的为准，请核对导入结果');
        }
    }
    if (unplacedDays > 0) {
        pushWarning('有 ' + unplacedDays + ' 天在课表里找不到对应的位置，这几天的课没有导入，请核对导入结果');
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

    // 节次时间：课表用到学校公布的 12 节之外的节次
    if (filledBySequence.length) {
        pushWarning('课表用到了第 ' + (PERIOD_COUNT + 1) + (filledBySequence.length > 1 ? ' 至 ' + filledBySequence[filledBySequence.length - 1] : '') +
            ' 节，学校公布的节次时间只有 ' + PERIOD_COUNT + ' 节，已按上一节下课后课间 ' + EXTEND_BREAK_MINUTES +
            ' 分钟、每节 ' + EXTEND_CLASS_MINUTES + ' 分钟顺推补上，请在「学期管理」里核对');
    }
    if (uncoveredFrom) {
        pushWarning('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，' +
            '这些节次没有补上时间（课程已导入），请在「学期管理」里补上');
    }

    // 校区与第 3、4 节的上课时间
    var startText = majority === 'late' ? '10:30' : '10:10';
    if (overlapping.length && pickedCampus) {
        var timeText = '第 3、4 节按 ' + startText + ' 起的节次时间导入，请核对';
        if (tiedCampuses.length < 2) {
            pushWarning('根据教学楼判断你在' + pickedCampus.name + '上课，' + timeText);
        } else if (tieMatters) {
            // 票数平局、而且平局的几个校区给这些课的第 3、4 节排了不同的时间：先按名单里靠前的校区算，要说出来
            var tiedNames = [];
            for (var tn = 0; tn < tiedCampuses.length; tn++) tiedNames.push(tiedCampuses[tn].name);
            pushWarning('课表里的教学楼在' + tiedNames.join('、') + '都有，分不清你在哪个校区上课，先按' +
                pickedCampus.name + '计算，' + timeText);
        } else {
            pushWarning('根据教学楼，' + timeText);
        }
    }
    if (minorityNames.length) {
        var venueShown = [];
        for (var mv = 0; mv < minorityVenues.length && mv < 3; mv++) venueShown.push(shortName(minorityVenues[mv]));
        var otherText = majority === 'late' ? '10:10-10:50、10:55-11:35' : '10:30-11:10、11:15-11:55';
        pushWarning('有 ' + minorityNames.length + ' 门课（例如 ' + namesText(minorityNames) + '）在 ' +
            venueShown.join('、') + (minorityVenues.length > 3 ? ' 等' : '') + ' 上第 3、4 节：学校给这些楼的上课时间是 ' + otherText +
            '，与导入的节次时间不同，请以学校实际为准');
    }
    if (unknownNames.length) {
        var unknownShown = [];
        for (var uv = 0; uv < unknownVenues.length && uv < 3; uv++) unknownShown.push(shortName(unknownVenues[uv]));
        pushWarning('有 ' + unknownNames.length + ' 门课（例如 ' + namesText(unknownNames) + '）的第 3、4 节分不出是哪一套上课时间（' +
            (unknownShown.length ? '教学楼 ' + unknownShown.join('、') + ' 不在学校公布的各楼名单里' : '没有写教学楼') +
            '），已按 ' + startText + ' 起的节次时间导入，请核对');
    }
    if (halfBlockNames.length) {
        pushWarning('有 ' + halfBlockNames.length + ' 门课（例如 ' + namesText(halfBlockNames) +
            '）的节次从第 8、10、12 节开始或到第 7、9、11 节结束：学校把第 7-8、9-10、11-12 节各当作一整段连堂上课' +
            '（15:55-17:15、18:05-19:25、19:40-21:00），请以整段时间为准');
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
