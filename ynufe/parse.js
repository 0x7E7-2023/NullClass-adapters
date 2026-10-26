(function () {
    // 云南财经大学（强智 · 高校综合管理教务系统 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 YNUFE/ynufe.js（MIT，上游作者 AxelPLN）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //   上游快照 e15c627（2026-10-26 拉取），本校脚本最后一次修改 7a4c0f7。模板：hnptc。
    // 上游的核心：读 #kbtable 每个格子里的 div.kbcontent，用「-----」（5 个以上减号）把一格里的几门课分开；
    // 每段第一行有字的文本是课程名，font[title=老师]、font[title=教室]、font[title=周次(节次)]（形如「1-18(周)[06-07节]」）取教师、教室、周次与节次；
    // 没有教室标题时，非首行里「隐藏 font + 可见文字」的那一行当教室；星期优先取 div 的 name（哈希-星期-序号）里的星期，没有才用列序号；
    // 开学日期与总周数来自教学周历（POST /jsxsd/jxzl/jxzl_query）；节次时间是龙泉校区 14 节 / 安宁校区 13 节两张写死的表，
    // 按校区选一张（校区由 extract.js 判断，见它的说明）。这里保持同一套字段来源。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 周次逐段判单双：上游 getWeeks() 的单双标记只跟「周」字后面紧挨着的一个字走，「(单)1-8周」这类前缀写法认不出；
    //      这里先分段、每段各自判，「(单)1-8周,(双)9-16周」「1-8周(单) 9-16周(双)」都认，共 N 周的备注只剥备注本身，
    //      区间终点前的「第」（第1-第8周）、教学班序号括号（(1)、(1-2)）、括号备注（(实验)）都不当周次；
    //   ② 上游缺教师写「未知教师」、缺教室写「未知地点」：这里留空，按类型汇总提醒，点名课名截 20 字；
    //   ③ 上游静默丢掉的块（没课名 / 没周次 / 没节次 / 节次超范围）全部计数并点名；节次写不出来时取本行表头里的「N-M节」，再没有才丢；
    //   ④ 课表用到的节次超出学校公布的节数（龙泉 14 节、安宁 13 节）时，上游照用不补节次时间；这里按「统一修订 H3」顺推补上节次时间并提醒；
    //   ⑤ 开学日期不是星期一时对齐到所在周的周一并出提醒（上游原样采用第一个带日期的格子）；周历取不到时按提取日期推算并出提醒（上游不写开学日）；
    //   ⑥ 学期总周数：周历优先；周历取不到才用课表里最晚的周次并提醒（上游取不到给 20 周）；
    //   ⑦ 节次时间按校区写死（上游同样）：每次导入都出一条提醒，说清按哪个校区、怎么判断的，请学生核对；
    //   ⑧ 星期：按表头里的星期名称对齐网格列；格子上有教务标注的星期（上游优先用它）就以它为准，和所在列对不上时提醒；
    //   ⑨ 同一格里同一门课的重复段（完全相同的块）只留一条，课名与周次相同、教师和教室一方为空的块视为同一门课取非空的一方；
    //   ⑩ 上游把一个 div 里的课（节次取最小到最大）、以及「课名 + 教师 + 地点 + 星期 + 节次」相同的课合并周次；这里同样把同一门课同一天同一节次同一教室的周次取并集，
    //      不额外把相邻节次并成一条（上游也不并）。
    //
    // 输入是 extract.js 交出来的原始结构（纯函数，CI 的 Rhino 里没有 DOM）：
    //   { now: "2026-09-13", term: { code, name }, campus: { id: "longquan" | "anning", how }, cols: 8,
    //     calendar: { found, rows: [ [ { col, text, title } ] ] },
    //     rows: [ [ { col, span, text, th, parts: [课程明细 HTML], hints: [教务标注的星期，0 表示没有] } ] ] }
    //   parts 里的 HTML 已经去掉了悬浮详情与多余属性，只留 font 的 title。
    var data = JSON.parse(__ncInput);
    var rows;
    var term = data.term || {};
    var calendarRows;

    var SCHOOL_NAME = '云南财经大学';

    // 学校的节次时间（逐节照抄上游 generateTimeSlots；上游没有标注来源与学年）：龙泉校区 14 节、安宁校区 13 节。
    // 龙泉校区第 10 节只有 20 分钟（18:10-18:30），与别的节差得很多，但上游原样如此，这里照抄，靠每次导入的核对提醒兜底
    var LONGQUAN_TIMES = [
        '08:00-08:40', '08:50-09:30', '10:00-10:40', '10:50-11:30', '11:40-12:20',
        '14:30-15:10', '15:20-16:00', '16:30-17:10', '17:20-18:00', '18:10-18:30',
        '19:00-19:40', '19:50-20:30', '20:50-21:30', '21:40-22:20'
    ];
    var ANNING_TIMES = [
        '08:20-09:00', '09:10-09:50', '10:10-10:50', '11:00-11:40', '11:50-12:30',
        '14:00-14:40', '14:50-15:30', '15:40-16:20', '16:40-17:20', '17:30-18:10',
        '19:00-19:40', '19:50-20:30', '20:40-21:20'
    ];
    // extract.js 判断校区的结果：id 只认 anning，其余（含没给）都按龙泉（上游默认）；how 说明是怎么判断出来的，用来写提醒
    var campus = data.campus || {};
    var isAnning = campus.id === 'anning';
    var campusName = isAnning ? '安宁校区' : '龙泉校区';
    var SLOT_TIMES = isAnning ? ANNING_TIMES : LONGQUAN_TIMES;
    var PERIOD_COUNT = SLOT_TIMES.length;

    // 节次上限：越过它一定是脏数据（学校公布 13 / 14 节；更晚的节次按 H3 顺推补时间，顺推越过 23:59 就停）
    var MAX_PERIOD = 20;
    var EXTEND_BREAK_MINUTES = 10;  // 顺推补节次时间：课间（学校的课间多是 10 分钟）
    var EXTEND_CLASS_MINUTES = 40;  // 顺推补节次时间：每节（学校每节 40 分钟）
    // 载荷校验的总周数上限（1..30）：超过 30 的周次按脏数据丢弃并出声
    var MAX_WEEK = 30;
    // 载荷校验的上限：警告 ≤20 条、每条 ≤200 字；点名的课名最多显示 20 字
    var MAX_WARNINGS = 20;
    var MAX_WARNING_TEXT = 200;
    var NAME_TEXT_LIMIT = 20;
    var MAX_MINUTE = 23 * 60 + 59;

    // 一格里放多门课时，教务用一长串减号分隔（上游 /-----+/，5 个以上；全角减号也认）
    var DASHES = /[-—–－]{5,}/;
    var TEACHER_KEYS = ['教师', '老师'];
    var ROOM_KEYS = ['教室', '地点'];
    var COURSE_TITLE = /^(课程|课程名称|课程名|科目)$/;
    var TEACHER_PREFIX = /^(任课教师|授课教师|教师|老师)\s*[:：]\s*/;
    var DAY_CHARS = '一二三四五六日天';
    var SEP = String.fromCharCode(1);
    var VOID_TAGS = { BR: true, HR: true, IMG: true, INPUT: true, META: true, LINK: true, WBR: true };

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
    var hintConflicts = 0;
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

    // 和 plainText 一样，但换行标签先换成空格（不然「课名<br>教师」会粘成一串）
    function spacedText(value) {
        return plainText(String(value).replace(/<br\s*\/?>/gi, ' '));
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

    // 块里最外层（不在任何标签里面）的文字段，按出现顺序返回；标签用深度数出来，空标签（换行等）不算深度。
    // 与上游「holder.childNodes 里的文本节点」同一个口径：嵌在 font 里的文字不算。
    function topLevelTexts(blockHtml) {
        var tokens = String(blockHtml).split(/(<[^>]*>)/);
        var depth = 0;
        var out = [];
        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (!token) continue;
            if (token.charAt(0) === '<') {
                var tag = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)/.exec(token);
                if (!tag) continue;
                if (VOID_TAGS[tag[2].toUpperCase()] || /\/\s*>$/.test(token)) continue;
                if (tag[1]) {
                    if (depth > 0) depth--;
                } else {
                    depth++;
                }
            } else if (depth === 0) {
                out.push(token);
            }
        }
        return out;
    }

    // 课程名：上游取块里第一段带汉字的裸文本节点。
    // 兜底一：第一个 font 之前的第一行文字（课名里没有汉字的情形）；兜底二：第一个不带 title 的 font；
    // 兜底三：显式标了课程名的字段。都没有就返回空串，调用方计数并点名。
    function nameOf(blockHtml, fonts) {
        var i;
        var texts = topLevelTexts(blockHtml);
        for (i = 0; i < texts.length; i++) {
            var text = clean(decodeEntities(texts[i]));
            if (text && /[一-龥]/.test(text)) return text;
        }
        var lines = String(blockHtml).split(/<font\b/i)[0].split(/<br\s*\/?>/i);
        for (i = 0; i < lines.length; i++) {
            var line = plainText(lines[i]);
            if (line) return line;
        }
        for (i = 0; i < fonts.length; i++) {
            if (fonts[i].title === '' && fonts[i].text) return fonts[i].text;
        }
        for (i = 0; i < fonts.length; i++) {
            if (COURSE_TITLE.test(fonts[i].title) && fonts[i].text) return fonts[i].text;
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
        text = clean(text.replace(TEACHER_PREFIX, ''));
        if (!text || text === '未知教师' || text === '未知') return null;
        return text;
    }

    // 教室末尾偶尔带着「[01-02]节」这样的节次尾巴（上游同样剥掉）
    function roomOf(fonts) {
        var text = clean(titledText(fonts, ROOM_KEYS).replace(/\[\s*\d+\s*-\s*\d+\s*\]\s*节?$/, ''));
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

    // 一个课程块里的「周次(节次)」字段：一个块里通常就一个，同一块里写两段也见过 —— 挨个读，不丢。
    // 上游 pickText(['周次', '节次'])：标题含「周次」的 font 优先；没有时才看标题含「节次」的
    function specsOf(fonts) {
        var out = [];
        var onlyPeriods = '';
        for (var i = 0; i < fonts.length; i++) {
            var title = fonts[i].title;
            var text = clean(fonts[i].text);
            if (!text) continue;
            var isWeek = title.indexOf('周次') >= 0;
            var isPeriodOnly = !isWeek && title.indexOf('节次') >= 0;
            if (!isWeek && !isPeriodOnly) continue;
            if (isPeriodOnly) {
                if (!onlyPeriods) onlyPeriods = text;
                continue;
            }
            out.push(splitSpec(text));
        }
        if (out.length && !out[0].periods && onlyPeriods) {
            out[0].periods = onlyPeriods;
            out[0].bracket = true;
        }
        return out;
    }

    // 块里没有任何带标题的周次字段（上游这时拿整块文字去解析周次）：去掉课名后，在文字里找形如「1-16(周)」「1-8,10-16周(单)」的一段。
    // 前面紧挨着字母 / 数字 / 汉字的不算（教室「A101」里的 101 不是周次）
    var WEEK_IN_TEXT = /(^|[^0-9A-Za-z一-龥])([0-9][0-9,，、\s~至到第-]*[(（]?\s*周[)）]?(?:\s*[(（][单双][)）])?)/;

    function fallbackSpecs(blockHtml, name) {
        var text = spacedText(blockHtml);
        var at = text.indexOf(name);
        if (at >= 0) text = clean(text.substring(0, at) + ' ' + text.substring(at + name.length));
        var found = WEEK_IN_TEXT.exec(text);
        if (!found) return [];
        return [{ weeks: found[2], periods: '', bracket: false }];
    }

    // 整块文字里第一个读得出节次的方括号（上游：周次字段里没有方括号时，把整块文字里第一个方括号补上）
    function bracketPeriods(blockHtml) {
        var text = spacedText(blockHtml);
        var pattern = /[\[【]([^\]】]*)[\]】]/g;
        var m = pattern.exec(text);
        while (m) {
            var got = periodsIn(m[1]);
            if (got) return got;
            m = pattern.exec(text);
        }
        return null;
    }

    // ---------- 周次 ----------
    // 周次解析里的计数先记在 st 里，等这条候选在同格归并里胜出了才并进全局计数：
    // 同一格里重复的同一门课各解析一遍，不能把同一个备注数两次
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

    // ---- 本行表头里的节次：「第1-2节」「01~02节」（上游 th 里的 (\d+)[~-](\d+)节；这里再认「小节」）-----------------
    // 表头单元格（th）优先；这一行没有 th 时看最左边那个没有课程的格子
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
        var m = /(\d+)\s*[~～\-—]\s*(\d+)\s*小?节/.exec(clean(label.text));
        return m ? { start: parseInt(m[1], 10), end: parseInt(m[2], 10) } : null;
    }

    // ---- 主循环：逐格取课 ----------------------------------------------------------------
    var order = [];
    var byCourse = {};

    // 一格里的丢弃记录：同一格里重复的同一门课，同一个原因 + 同一个课名只记一次
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

    // 一个课程块 → 零到多个候选（每个「周次(节次)」字段一个）。同格里重复的候选稍后在 mergeCandidates 里归并。
    function candidatesOfBlock(blockHtml, day, rowSections, cellDrops, out) {
        if (plainText(blockHtml) === '') return;    // 空块（只有 <br> / 减号）：不是课，也不算丢
        var fonts = fontsOf(blockHtml);
        var name = nameOf(blockHtml, fonts);
        if (!name) {
            dropOnce(cellDrops, '', 'noName');
            return;
        }
        var teacher = teacherOf(fonts);
        var location = roomOf(fonts);
        var specs = specsOf(fonts);
        if (!specs.length) specs = fallbackSpecs(blockHtml, name);
        if (!specs.length) {
            dropOnce(cellDrops, name, 'noWeek');
            return;
        }
        for (var s = 0; s < specs.length; s++) {
            var periods = specs[s].periods ? periodsIn(specs[s].periods) : null;
            var bracket = specs[s].bracket;
            if (!periods && !bracket) {
                periods = bracketPeriods(blockHtml);
                if (periods) bracket = true;
            }
            var st = newStats();
            var weeks = weeksIn(specs[s].weeks, st);
            if (!weeks.length) {
                dropOnce(cellDrops, name, 'noWeek');
                continue;
            }
            var explicit = !!periods;
            if (!periods && rowSections) periods = { start: rowSections.start, end: rowSections.end };
            out.push({
                explicit: explicit,
                name: name,
                teacher: teacher,
                location: location,
                day: day,
                weeks: weeks,
                periods: periods,
                stats: st,
                score: (teacher ? 4 : 0) + (bracket ? 3 : 0) + (location ? 1 : 0) +
                    (periods && periods.end > periods.start ? 1 : 0)
            });
        }
    }

    // 同一格里重复候选的归并（模板 hnptc 为简表 / 详表两份明细设计，本校只有一份明细，但同格里完全相同或残缺的重复段照样归并）。
    // 这个键太粗也太细：① 不含教师和节次，同格里「课名、周次、教室都相同」的两门课（教师不同）、
    // 或同一门课的两个节次段（[01-02节] 与 [03-04节]）会被并成一条，另一条被静默丢掉；
    // ② 含教室，一方缺教室时同一门课不并，多出一条空教室的重复课。
    // 这里改成「相容」判断：课名和周次相同，教师、教室任何一方为空或两边相同，两边的节次都是教务明写的（方括号里读出来的）时必须相同；
    // 节次是从本行表头补的不参与比较。并起来的候选取分数高的那条，教师 / 教室 / 节次空着的用另一方的补上。
    // 先处理明写节次的候选，再处理其余的（后者并进第一个相容的组，没有相容的才自己留着）。
    function sameOrEmpty(a, b) {
        return !a || !b || a === b;
    }

    function samePeriods(a, b) {
        return a.start === b.start && a.end === b.end;
    }

    function compatible(group, item) {
        if (group.name !== item.name || group.weekKey !== item.weeks.join(',')) return false;
        if (!sameOrEmpty(group.teacher, item.teacher) || !sameOrEmpty(group.location, item.location)) return false;
        if (group.explicit && item.explicit && !samePeriods(group.periods, item.periods)) return false;
        return true;
    }

    function mergeCandidates(list) {
        var groups = [];
        var pass;
        var i;
        var g;
        for (pass = 0; pass < 2; pass++) {
            for (i = 0; i < list.length; i++) {
                var item = list[i];
                if ((pass === 0) !== (item.explicit === true)) continue;
                var found = null;
                for (g = 0; g < groups.length && !found; g++) {
                    if (compatible(groups[g], item)) found = groups[g];
                }
                if (!found) {
                    groups.push({
                        name: item.name,
                        weekKey: item.weeks.join(','),
                        best: item,
                        teacher: item.teacher || null,
                        location: item.location || null,
                        periods: item.periods,
                        explicit: item.explicit === true,
                        first: i
                    });
                    continue;
                }
                if (item.score > found.best.score) found.best = item;
                if (!found.teacher && item.teacher) found.teacher = item.teacher;
                if (!found.location && item.location) found.location = item.location;
                if (!found.periods && item.periods) found.periods = item.periods;
                if (i < found.first) found.first = i;
            }
        }
        groups.sort(function (a, b) { return a.first - b.first; });
        var out = [];
        for (g = 0; g < groups.length; g++) {
            var best = groups[g].best;
            out.push({
                name: best.name,
                teacher: groups[g].teacher,
                location: groups[g].location,
                day: best.day,
                weeks: best.weeks,
                periods: groups[g].periods,
                stats: best.stats,
                score: best.score
            });
        }
        return out;
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

    // 逐格取课。星期：格子上有教务标注的星期（extract.js 的 hints，上游优先用它）就以它为准；没有标注才按网格列对应的星期。
    // 标注与所在列对不上时照标注放，并计数提醒。跨列的格子（没有标注时）会落到它跨到的每一天，同样提醒。
    for (var ri = 0; ri < rows.length; ri++) {
        if (ri === header.row) continue;
        var row = rows[ri];
        var rowSections = rowSectionsOf(row);
        for (var ci = 0; ci < row.length; ci++) {
            var cell = row[ci];
            var parts = cell.parts || [];
            if (!parts.length) continue;
            var colDays = [];
            for (var d = 1; d <= 7; d++) {
                if (cellAtGridCol(row, dayColOf[d]) === cell) colDays.push(d);
            }
            var hints = cell.hints || [];
            var candByDay = {};
            var dropsByDay = {};
            var mapped = false;
            var duplicated = false;
            for (var p = 0; p < parts.length; p++) {
                var hint = (typeof hints[p] === 'number' && hints[p] >= 1 && hints[p] <= 7) ? hints[p] : 0;
                var targets = hint ? [hint] : colDays;
                if (hint && colDays.length && colDays.indexOf(hint) < 0) hintConflicts++;
                if (targets.length) mapped = true;
                if (!hint && targets.length > 1) duplicated = true;
                var blocks = String(parts[p]).split(DASHES);
                for (var t = 0; t < targets.length; t++) {
                    var day = targets[t];
                    if (!candByDay[day]) {
                        candByDay[day] = [];
                        dropsByDay[day] = {};
                    }
                    for (var b = 0; b < blocks.length; b++) candidatesOfBlock(blocks[b], day, rowSections, dropsByDay[day], candByDay[day]);
                }
            }
            // 有课、却没有任何一天映射到它：表头 / 列号对不上时不能说丢就丢
            if (!mapped) unmappedCells++;
            if (duplicated) mergedCells++;
            for (var dd2 = 1; dd2 <= 7; dd2++) {
                if (!candByDay[dd2]) continue;
                var winners = mergeCandidates(candByDay[dd2]);
                for (var w = 0; w < winners.length; w++) registerCandidate(winners[w], dropsByDay[dd2]);
            }
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

    // ---- 合并（沿用上游 convertCoursesToStandardFormat 之后的合并）-----------------------------
    // 同一门课、同一天、同一节次、同一教室的几条，周次取并集。上游不把相邻节次并成一条，这里也不并。
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
        held.merged = unionWeeks(held.entries);
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

    // 开学日期的备选口径（周历里找不到「星期一」格时用）：上游取第 1 周那一行的第二个格子；
    // 这里取第 1 周那一行里第一个带日期的格子，没有第 1 周这一行才取按行序第一个带日期的格子
    function calendarFirstTitled() {
        var r;
        var c;
        var iso;
        for (r = 0; r < calendarRows.length; r++) {
            var first = firstCellOf(calendarRows[r]);
            if (!first || !/^第?\s*1\s*周?$/.test(clean(first.text))) continue;
            for (c = 0; c < calendarRows[r].length; c++) {
                if (calendarRows[r][c] === first) continue;
                iso = isoOfCnDate(calendarRows[r][c].title) || isoOfCnDate(calendarRows[r][c].text);
                if (iso) return iso;
            }
        }
        for (r = 0; r < calendarRows.length; r++) {
            for (c = 0; c < calendarRows[r].length; c++) {
                iso = isoOfCnDate(calendarRows[r][c].title) || isoOfCnDate(calendarRows[r][c].text);
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
    // 总周数：有周历就用周历的周数；周历取不到才用课表里最晚的周次（上游同样）。
    // 课表里有更晚的周次才抬高到它（否则那一块的 endWeek 会超出 totalWeeks，载荷校验拒收）。超过 MAX_WEEK 的夹住并出声。
    var baseWeeks = calendarWeeks > 0 ? calendarWeeks : maxWeek;
    var wantedWeeks = Math.max(baseWeeks, maxWeek);
    var totalWeeks = Math.min(wantedWeeks, MAX_WEEK);

    // ---- 节次时间：按校区的节次时间表，课表用到更晚的节次时再顺推（H3）--------------------
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

    // 开学日期的取法（依次）：① 周历第 1 周那一行的「星期一」格（真实值）；② 周历里第 1 周那一行第一个带日期的格子（上游的口径），
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
    if (hintConflicts > 0) {
        pushWarning('有 ' + hintConflicts + ' 处课的星期与它在课表里所在的列对不上，已按教务标注的星期放，请核对导入结果');
    }
    if (mergedCells > 0) {
        pushWarning('有 ' + mergedCells + ' 处课占了连续几天的格子，这些课被同时放进了这几天，请核对导入结果');
    }

    // 节次时间：按校区写死的两张表（上游同样），每次都说清按哪个校区、怎么判断的，请学生核对
    var campusNote = {
        anning: '教务里安宁校区的课表有课，节次时间按安宁校区的上课作息导入',
        bothDefault: '你的课表里龙泉校区和安宁校区的课都有（没能询问你），节次时间按安宁校区的上课作息导入，如果你主要在龙泉校区上课请核对',
        asked: '节次时间按你选的' + campusName + '的上课作息导入',
        noAnning: '教务里安宁校区的课表没有课，节次时间按龙泉校区的上课作息导入',
        probeFailed: '没能确认你所在的校区，节次时间按龙泉校区的上课作息导入，如果你在安宁校区上课请核对',
        noOption: '教务里没有标明校区，节次时间按龙泉校区的上课作息导入，如果你在安宁校区上课请核对'
    };
    var campusText = campusNote[campus.how] || ('节次时间按' + campusName + '的上课作息导入');
    pushWarning(campusText + '，学校如有调整，请在「学期管理」里核对');
    if (filledBySequence.length) {
        pushWarning('课表用到了第 ' + (PERIOD_COUNT + 1) + (filledBySequence.length > 1 ? ' 至 ' + filledBySequence[filledBySequence.length - 1] : '') +
            ' 节，' + campusName + '公布的节次时间只有 ' + PERIOD_COUNT + ' 节，已按上一节下课后课间 ' + EXTEND_BREAK_MINUTES +
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
