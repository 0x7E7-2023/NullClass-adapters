(function () {
    // 湖南农业大学（强智 · 高校综合管理教务系统，学生端 /jsxsd/）课表解析
    // 移植自 shiguang_warehouse 的 HUNAU/hunau_01.js（MIT，作者 salt-fishes）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse   上游快照 19a65bf，本校脚本最后修改 6b6fee4
    // 上游核心是 parseTimeSlots() + parseWeeksAndSections() + collectCellCandidates() + mergeCellCandidates() +
    // parseTimetable() + parseCalendar() + mergeAndDistinctCourses()：读课表 table 里每格的 div.kbcontent / div.kbcontent1，
    // 课名取格内第一段文字，font[title*=教师|老师] / [title*=教室|地点] / [title*=周次|节次] 取教师、教室、周次与节次，
    // 周次文本形如 "1-16(周)[01-02节]"；节次时间从行标题（"第一大节 08:00-09:40"）推，开学日来自教学周历。
    // 上游的坑逐条改掉，改不掉的都进 warnings，不静默：
    //   ① 单双周：上游在整段文字里只要出现「双」就把所有周都按双周过滤（出现「单」同理），多段混排
    //      "(单)1-8周,(双)9-16周" 会被整体当成双周。这里单 / 双标记只跟着自己那一段走
    //      （前缀贴后段、后缀贴前段，含后缀挨着下一段的情形）；
    //   ② 周次里的「共 N 周」备注只剥备注本身，不删到行尾；「第1-第8周」「1至8周」「1～8周」「全角数字」都认；
    //      括号里的纯数字（如 "(1)"）是序号不是周次，忽略并计数；其它括号备注忽略并说明；
    //   ③ 上游缺教师 / 教室时写「未知教师」「未知地点」。这里教师 / 教室缺了写 null 并按类型汇总提醒（指向「编辑课程」）；
    //   ④ 上游节次读不出、周次读不出时整块静默跳过。这里节次读不出先回落到所在行的节次（第 N 大节 = 第 2N-1、2N 节），
    //      再不行计数提醒后跳过；周次读不出同样计数提醒，不静默；
    //   ⑤ 上游按 td 序号硬算星期。这里按表头「星期一…星期日」的网格列对应，表头只认出一部分时按列序补齐并提醒；
    //   ⑥ 上游把明细（kbcontent）与简表（kbcontent1）混在一起按课名 + 周次 + 教室择优，教室不同就会留下两份。
    //      这里同一格里优先用明细，简表里课名和周次都与某个明细块相同的整块丢掉，简表独有的块照常导入；
    //   ⑦ 教师姓名后连写的职称（"何龙姣讲师""周小红其他"）逐个去掉，多人逗号分隔；教室末尾的 "[01-02]节" 去掉（都是上游的做法）；
    //   ⑧ 节次时间：照上游，优先用课表行标题里写的时间（每个大节 2 小节，第二小节的结束 = 大节结束），
    //      页面给的行数不足 6 节或前后对不上时回落上游写死的 12 节表；页面没写到的节次用写死表补并提醒；
    //      课表用到第 13 节及以后时按统一修订 H3 逐节顺推（课间 10 分钟、每节 45 分钟），越过 23:59 的补不了并提醒；
    //   ⑨ 总周数默认 20（上游），课表里有更晚的周次时抬高并说明；周次上限 30，超出的周忽略并说明；
    //   ⑩ 开学日：教学周历第 1 周那一行、星期一那一列的日期；表头认不出时按上游取该行第二格并对齐到周一；都没有就按提取当天推算，一律说明。
    //
    // 输入（extract.js 的输出）：
    //   { now: "2026-09-12", term: { code, name, source },
    //     calendar: { found, rows: [ [ { col, text, title } ] ] },
    //     rows: [ [ { text, parts, briefParts, col, span }, … ], … ] }
    // 纯函数：只做字符串与正则，CI 的 Rhino 里没有 DOM。
    var data = JSON.parse(__ncInput);
    var grid = data.rows || [];
    var term = data.term || {};
    var calendarRows = (data.calendar && data.calendar.rows) || [];

    var SCHOOL_NAME = '湖南农业大学';

    // 节次时间：上游 HUNAU_FALLBACK_TIME_SLOTS 写死的 12 节，逐节照搬
    var FALLBACK_TIMES = [
        { periodIndex: 1, start: '08:00', end: '08:45' },
        { periodIndex: 2, start: '08:55', end: '09:40' },
        { periodIndex: 3, start: '10:05', end: '10:50' },
        { periodIndex: 4, start: '11:00', end: '11:45' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:25', end: '16:10' },
        { periodIndex: 7, start: '16:35', end: '17:20' },
        { periodIndex: 8, start: '17:30', end: '18:15' },
        { periodIndex: 9, start: '19:30', end: '20:15' },
        { periodIndex: 10, start: '20:25', end: '21:10' },
        { periodIndex: 11, start: '21:20', end: '22:05' },
        { periodIndex: 12, start: '22:15', end: '23:00' }
    ];
    var CLASS_MINUTES = 45;         // 上游 HUNAU_CLASS_DURATION：每节几分钟
    var BREAK_MINUTES = 10;         // 上游 HUNAU_BREAK_DURATION：课间几分钟
    var MIN_PAGE_SLOTS = 6;         // 上游：课表行标题推出的节次不到 6 节就回落写死表
    var DEFAULT_TOTAL_WEEKS = 20;
    var MAX_WEEK = 30;
    var MAX_PERIOD = 30;
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;
    var NAME_LIMIT = 20;            // 提醒里点名的课名最多显示的字数
    var DAY_END = 23 * 60 + 59;
    var SEP = String.fromCharCode(31);
    var DAY_OF = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7, '七': 7 };
    var CN_DIGIT = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    var PLACEHOLDER = /^(未知|待定|暂无|无)(教师|地点|教室|课程)?$/;
    // 教师姓名后连写的职称（上游 cleanTeacher 的清单与顺序）
    var TEACHER_TITLES = ['其他正高级', '其他副高级', '其他中级', '其他初级', '副教授', '教授', '副研究员', '研究员',
        '高级实验师', '实验师', '高级工程师', '工程师', '高级技师', '技师', '讲师', '助教', '其他'];

    var warnings = [];
    var issueKinds = [];
    var issueCount = {};
    var issueSamples = {};
    var entries = [];
    var courseList = [];
    var courseByKey = {};
    var serialTotal = 0;
    var blocksSeen = 0;
    var firstBlockName = '';
    var missingTeacher = {};
    var missingLocation = {};
    var missingSamples = [];

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function clip(value, max) {
        var text = clean(value);
        return text.length > max ? text.substring(0, max - 1) + '…' : text;
    }

    // 提醒里点名的课名：截到 20 字
    function shortName(name) {
        return clip(name, NAME_LIMIT);
    }

    // 所有提醒共用的限长出口：整条 ≤200 字
    function capLine(message) {
        var text = String(message);
        return text.length > MAX_WARNING_CHARS ? text.substring(0, MAX_WARNING_CHARS - 1) + '…' : text;
    }

    // 整体提醒（学期、开学日推算、总周数、节次时间这类）：进 warnings，排在前面，不会被块级问题挤掉
    function warn(message) {
        warnings.push(capLine(message));
    }

    // 块级问题（某门课的周次、节次读不出等）：按类型计数，每类只留两个样本，最后合成一条
    function issue(kind, sample) {
        if (!issueCount[kind]) {
            issueCount[kind] = 0;
            issueSamples[kind] = [];
            issueKinds.push(kind);
        }
        issueCount[kind]++;
        if (!sample) return;
        var list = issueSamples[kind];
        if (list.length < 2 && list.indexOf(sample) < 0) list.push(sample);
    }

    function samplesOf(kind) {
        var list = issueSamples[kind];
        if (!list.length) return '';
        var quoted = [];
        for (var i = 0; i < list.length; i++) quoted.push('「' + list[i] + '」');
        return '（如' + quoted.join('、') + '）';
    }

    function issueLine(kind) {
        var n = issueCount[kind];
        var s = samplesOf(kind);
        if (kind === 'noName') return '有 ' + n + ' 门课没有写课程名，已跳过';
        if (kind === 'noPeriods') return '有 ' + n + ' 门课的节次教务没写清，也没有节次标签可对应，已跳过' + s;
        if (kind === 'badBracket') return '有 ' + n + ' 门课的节次写法认不出，已按所在行的节次对应' + s + '，请核对';
        if (kind === 'discontinuous') return '有 ' + n + ' 门课的节次不连续，已按首尾节次记' + s;
        if (kind === 'clamped') return '有 ' + n + ' 门课的周次超出第 1–' + MAX_WEEK + ' 周的范围，超出的周已忽略' + s;
        if (kind === 'badSeg') return '有 ' + n + ' 门课的周次里有段认不出，已忽略那几段' + s;
        if (kind === 'serialOnly') return '有 ' + n + ' 门课的周次只写了括号里的序号（如 (1)），没有周次，已跳过' + s;
        if (kind === 'weekNote') return '有 ' + n + ' 门课的周次里带括号备注，备注不是周次，已忽略' + s + '，请核对周次';
        if (kind === 'bothMarks') return '有 ' + n + ' 门课的周次里「单」「双」同时出现，已按每周都上处理' + s + '，请核对';
        return '有 ' + n + ' 门课的周次没认出来，已跳过' + s;
    }

    // 缺教师 / 缺教室：课照常导入，按类型汇总（点名课名截 20 字，最多 3 个）
    function missingLine() {
        var teachers = 0;
        var locations = 0;
        var key;
        for (key in missingTeacher) {
            if (missingTeacher.hasOwnProperty(key)) teachers++;
        }
        for (key in missingLocation) {
            if (missingLocation.hasOwnProperty(key)) locations++;
        }
        if (!teachers && !locations) return '';
        var parts = [];
        if (teachers) parts.push(teachers + ' 门课没给上课教师');
        if (locations) parts.push(locations + ' 门课没给上课地点');
        var empty = teachers && locations ? '教师或地点暂时空着' : (teachers ? '教师暂时空着' : '上课地点暂时空着');
        var shown = [];
        for (var i = 0; i < missingSamples.length; i++) shown.push(shortName(missingSamples[i]));
        return '有 ' + parts.join('、') + '（例如 ' + shown.join('、') + '）：已照常导入，' + empty + '，可在「编辑课程」里补上';
    }

    // 整体提醒在前，块级类型各合成一条；每条都过限长出口；总数仍 ≤ MAX_WARNINGS，超了最后一条写汇总
    function finishWarnings() {
        var lines = [];
        var missing = missingLine();
        if (missing) lines.push(missing);
        for (var i = 0; i < issueKinds.length; i++) lines.push(issueLine(issueKinds[i]));
        var out = warnings.slice();
        var room = MAX_WARNINGS - out.length;
        var shown = lines.length <= room ? lines : lines.slice(0, room - 1);
        for (var j = 0; j < shown.length; j++) out.push(capLine(shown[j]));
        if (lines.length > room) out.push('另有 ' + (lines.length - room + 1) + ' 类提示未显示，请以教务页面为准');
        return out;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function decodeEntities(text) {
        return text.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&');
    }

    function plainOf(html) {
        return clean(decodeEntities(String(html).replace(/<[^>]*>/g, '')));
    }

    function uniqueSorted(list) {
        var sorted = list.slice().sort(function (a, b) { return a - b; });
        var out = [];
        for (var i = 0; i < sorted.length; i++) {
            if (i === 0 || sorted[i] !== sorted[i - 1]) out.push(sorted[i]);
        }
        return out;
    }

    // 明细 HTML 里的 <font 属性>文本</font>，按出现顺序返回（title 属性可缺，单双引号都认）。
    // 末尾的 </font> 允许缺失（教务页面的 <font> 偶尔不闭合），那时取到下一个 '<' 为止。
    function fontsOf(html) {
        var pattern = /<font\b([^>]*)>([\s\S]*?)(?:<\/font>|(?=<)|$)/gi;
        var out = [];
        var m = pattern.exec(html);
        while (m) {
            var title = /title\s*=\s*["']?([^"'>]*)["']?/i.exec(m[1]);
            out.push({ title: clean(title ? title[1] : ''), text: plainOf(m[2]) });
            m = pattern.exec(html);
        }
        return out;
    }

    // 上游 pickText：按给定的标题关键字依次找 title 含该关键字、且有文字的第一个 font
    function pickText(fonts, keys) {
        for (var k = 0; k < keys.length; k++) {
            for (var i = 0; i < fonts.length; i++) {
                if (fonts[i].title.indexOf(keys[k]) >= 0 && fonts[i].text) return fonts[i].text;
            }
        }
        return '';
    }

    // 占位文字（未知教师、暂无教室 …）一律当没有，写 null，不当真名真地点
    function realText(value) {
        var t = clean(value);
        if (!t || PLACEHOLDER.test(t)) return null;
        return t;
    }

    // 上游 cleanTeacher：多人以逗号 / 顿号 / 分号 / 斜杠分隔，逐个去掉连写在姓名后的职称
    function stripTitle(name) {
        var value = clean(name);
        for (var i = 0; i < TEACHER_TITLES.length; i++) {
            var title = TEACHER_TITLES[i];
            if (value.length > title.length && value.substring(value.length - title.length) === title) {
                return clean(value.substring(0, value.length - title.length));
            }
        }
        return value;
    }

    function teacherOf(fonts) {
        var raw = clean(pickText(fonts, ['教师', '老师'])).replace(/^任课教师\s*[:：]\s*/, '');
        var names = raw.split(/[,，、;；\/]+/);
        var kept = [];
        for (var i = 0; i < names.length; i++) {
            var one = stripTitle(names[i]);
            if (one) kept.push(one);
        }
        return realText(kept.join(','));
    }

    // 教室：末尾的 "[01-02]节" 去掉（上游做法）
    function locationOf(fonts) {
        var raw = pickText(fonts, ['教室', '地点']).replace(/\[\s*\d+\s*-\s*\d+\s*\]\s*节?$/, '');
        return realText(raw);
    }

    // 课程名：块里第一行（第一个 br 之前），字体标签之前的部分；span 整段去掉
    function nameOf(html) {
        var lines = html.split(/<font\b/i)[0].split(/<br\s*\/?>/i);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/<span[^>]*>[\s\S]*?<\/span>/gi, '');
            var name = plainOf(line);
            if (name) return name === '未知课程' ? '' : name;
        }
        return '';
    }

    // 一格里可能有几门课，中间用一串「-」分开（上游：6 个及以上的 - 或长破折号）
    function blocksOf(html) {
        var pieces = String(html).split(/[-—–]{6,}/);
        var out = [];
        for (var i = 0; i < pieces.length; i++) {
            var block = pieces[i].replace(/^(\s|&nbsp;|<br\s*\/?>)+/i, '').replace(/(\s|&nbsp;|<br\s*\/?>)+$/i, '');
            if (plainOf(block)) out.push(block);
        }
        return out;
    }

    // ---------- 周次 ----------
    // 周次文本 → { weeks: [升序去重], serial, notes, noteSample, both, dropped, bad: [认不出的段] }
    // 认的写法："1-16" / "1-16周" / "1-16(周)" / "1-15(单周)" / "(单)1-8周,(双)9-16周" / "1-8周(单) 9-16周(双)" /
    // "第1-第8周" / "1,3,5" / "1-8周(共8周),9-16周"。要点：
    //   ① 单 / 双标记先按相邻关系归属再切段：前缀（紧跟在段首）贴后一段，后缀（紧跟在数字或「周」后）贴前一段；
    //      标记前面紧挨着数字或「周」时它是上一段的后缀，不能被后面的数字抢去当前缀；
    //   ② 括号逐组判断：纯数字的（"(1)"、"(1-2)"）是序号，整组摘掉并计数；含别的字的（"(3组)"）是备注，摘掉并计数；
    //      其余（"(周)"、"(单周)"、"(1-16周)"）保留内容；每组都换成逗号，两侧的数字不会粘在一起；
    //   ③ 「共 N 周」只剥备注本身，不删到行尾；
    //   ④ 区间两端的空白归一，剩下的空白当分段符（"1-3周 5-9周" 是两段，不会拼成 1-35）。
    function fullWidthToHalf(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[，、；;]/g, ',')
            .replace(/[～~—－–−至到]/g, '-');
    }

    function weeksOf(source) {
        var out = { weeks: [], serial: 0, notes: 0, noteSample: '', both: 0, dropped: false, bad: [] };
        var cleaned = String(source || '').replace(/[\[【][^\]】]*[\]】]/g, ' ');
        cleaned = fullWidthToHalf(cleaned);
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, ' ');
        cleaned = cleaned.replace(/第/g, '');
        cleaned = cleaned.replace(/\s*-\s*/g, '-');
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            if (/[0-9周]\s*$/.test(whole.substring(0, offset))) return all;
            return mark;
        });
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            return digit + mark + (/^\s*[0-9]/.test(whole.substring(offset + all.length)) ? ',' : '');
        });
        cleaned = cleaned.replace(/\(([^()]*)\)/g, function (all, inner) {
            if (/^[0-9\s,-]+$/.test(inner) && /[0-9]/.test(inner)) {
                out.serial++;
                return ',';
            }
            if (/[^0-9\s,单双周-]/.test(inner)) {
                out.notes++;
                if (!out.noteSample) out.noteSample = clip(all, 20);
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');
        cleaned = cleaned.replace(/周/g, '');
        var tokens = cleaned.replace(/\s+/g, ',').split(/,+/);
        var segments = [];
        var i;
        for (i = 0; i < tokens.length; i++) {
            var token = clean(tokens[i]);
            if (token) segments.push(token);
        }
        // 单 / 双自己成一段时并给最近的周次段（就近向前找，找不到再向后；整个周次里一个数字都没有时，标记丢掉，那门课按周次没认出来处理）
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
            if (into < 0) { segments[i] = ''; continue; }
            segments[into] = segments[into] + segments[i];
            segments[i] = '';
        }
        var seen = {};
        for (i = 0; i < segments.length; i++) {
            var segment = segments[i];
            if (!segment) continue;
            var odd = segment.indexOf('单') >= 0;
            var even = segment.indexOf('双') >= 0;
            if (odd && even) {
                out.both++;
                odd = false;
                even = false;
            }
            var range = /^([0-9]+)(?:-([0-9]+))?$/.exec(segment.replace(/[单双]/g, ''));
            if (!range) {
                out.bad.push(segment);
                continue;
            }
            var start = parseInt(range[1], 10);
            var end = range[2] ? parseInt(range[2], 10) : start;
            if (end < start) {
                out.bad.push(segment);
                continue;
            }
            if (start < 1 || end > MAX_WEEK) out.dropped = true;
            for (var week = Math.max(start, 1); week <= Math.min(end, MAX_WEEK); week++) {
                if (odd && week % 2 === 0) continue;
                if (even && week % 2 === 1) continue;
                seen[week] = true;
            }
        }
        for (var w = 1; w <= MAX_WEEK; w++) {
            if (seen[w]) out.weeks.push(w);
        }
        return out;
    }

    // 周次集合 → 极大段：步长 1 视作每周，步长 2 视作单周 / 双周
    function runsOf(weeks) {
        var runs = [];
        var i = 0;
        while (i < weeks.length) {
            var step = 1;
            if (i + 1 < weeks.length && weeks[i + 1] - weeks[i] === 2) step = 2;
            var j = i;
            while (j + 1 < weeks.length && weeks[j + 1] - weeks[j] === step) j++;
            var weekType = 'ALL';
            if (step === 2 && weeks[i] !== weeks[j]) weekType = weeks[i] % 2 === 1 ? 'ODD' : 'EVEN';
            runs.push({ startWeek: weeks[i], endWeek: weeks[j], weekType: weekType });
            i = j + 1;
        }
        return runs;
    }

    // ---------- 节次 ----------
    // 节次文本 → 升序节次列表；认不出返回 null。认：01-02节 / 01-03 / 03-04-05 / 0102 / 030405 / 第9,10节 / 第3节。
    // 全角冒号先归成半角，「14:00-15:35」这类时间整段去掉，免得时间里的数字被当成节次；
    // 4 位及以上且偶数位的纯数字按两位一节拆开（0102 → 1、2；030405 → 3、4、5）；
    // 任何一个数超过 MAX_PERIOD、或区间缺一端，都整段认不出（不默默丢掉其中一个数）
    function periodsOf(text) {
        var t = clean(text).replace(/：/g, ':');
        t = t.replace(/\d{1,2}\s*:\s*\d{2}(\s*[-－~～]\s*\d{1,2}\s*:\s*\d{2})?/g, ' ');
        t = t.replace(/[第节]/g, '').trim();
        if (!/\d/.test(t)) return null;
        var list = [];
        var parts = t.split(/[,，、]/);
        for (var p = 0; p < parts.length; p++) {
            var seg = clean(parts[p]);
            var nums = seg.match(/\d+/g);
            if (!nums) return null;
            var isRange = /[-－~～]/.test(seg);
            if (nums.length > 1 && !isRange) return null;
            if (!isRange) {
                var run = nums[0];
                if (run.length >= 4 && run.length % 2 === 0) {
                    // 拆出来的两位数必须连续：2026 拆成 20、26 不是连堂，整段认不出
                    var pairs = [];
                    for (var k = 0; k < run.length; k += 2) pairs.push(parseInt(run.substring(k, k + 2), 10));
                    for (var q = 0; q < pairs.length; q++) {
                        if (pairs[q] < 1 || pairs[q] > MAX_PERIOD) return null;
                        if (q > 0 && pairs[q] !== pairs[q - 1] + 1) return null;
                        list.push(pairs[q]);
                    }
                } else {
                    var single = parseInt(run, 10);
                    if (single < 1 || single > MAX_PERIOD) return null;
                    list.push(single);
                }
                continue;
            }
            // 区间两端都得有数：「1-」「-3」缺一端认不出。两个数是起止（「01-03」= 第 1 到 3 节）；
            // 三个数以上是强智逐节列出的连排（「01-02-03」），必须逐个相差 1，「03-05-07」不是连堂
            if (nums.length < 2) return null;
            if (nums.length > 2) {
                for (var j = 1; j < nums.length; j++) {
                    if (parseInt(nums[j], 10) !== parseInt(nums[j - 1], 10) + 1) return null;
                }
            }
            var a = parseInt(nums[0], 10);
            var b = parseInt(nums[nums.length - 1], 10);
            if (a < 1 || b > MAX_PERIOD || b < a) return null;
            for (var n = a; n <= b; n++) list.push(n);
        }
        if (!list.length) return null;
        return uniqueSorted(list);
    }

    // 周次文本里方括号的内容（节次放在 [xx-yy节] 里）
    function bracketOf(text) {
        var m = /[\[【]([^\]】]*)[\]】]/.exec(String(text));
        return m ? m[1] : '';
    }

    // 周次字段里没有方括号时，上游到整块文字里找第一个方括号当节次。这里只认读得成节次的那一个
    // （课名里的 "[实验]" 之类不当节次）
    function readableBracket(text) {
        var pattern = /[\[【]([^\]】]*)[\]】]/g;
        var m = pattern.exec(String(text));
        while (m) {
            if (periodsOf(m[1])) return m[1];
            m = pattern.exec(String(text));
        }
        return '';
    }

    // 「第N大节」的 N：阿拉伯数字或中文数字（一…九、十、十一…九十九）；认不出返回 0
    function cnToInt(text) {
        if (/^[0-9]+$/.test(text)) return parseInt(text, 10);
        var ten = text.indexOf('十');
        if (ten < 0) return CN_DIGIT[text] || 0;
        var head = text.substring(0, ten);
        var tail = text.substring(ten + 1);
        var tens = head ? (CN_DIGIT[head] || 0) : 1;
        var ones = tail ? (CN_DIGIT[tail] || 0) : 0;
        if (!tens || (tail && !ones)) return 0;
        return tens * 10 + ones;
    }

    function bigIndexOf(label) {
        var m = /第\s*([一二三四五六七八九十0-9]+)\s*大节/.exec(label);
        return m ? cnToInt(m[1]) : 0;
    }

    // 行标签的节次：有括号（「第一大节(01,02小节)」）先读括号里的，读不出再读整段（「第3-4节」），
    // 再读「第N大节」（上游：第 N 大节 = 第 2N-1、2N 节）
    function labelPeriodsOf(label) {
        var m = /[(（]([^)）]*)[)）]/.exec(label);
        var inner = m ? periodsOf(m[1]) : null;
        if (inner) return inner;
        var whole = periodsOf(label);
        if (whole) return whole;
        var big = bigIndexOf(label);
        return big >= 1 && big * 2 <= MAX_PERIOD ? [big * 2 - 1, big * 2] : null;
    }

    function dayOf(text) {
        var m = /^(星期|周)([一二三四五六日天七])$/.exec(clean(text));
        return m ? DAY_OF[m[2]] : 0;
    }

    // ---------- 表头与星期列 ----------
    // 表头：找到一行里至少 4 个「星期x」标签，记下每个标签所在的网格列
    function headerOf(rowsIn) {
        for (var r = 0; r < rowsIn.length; r++) {
            var cols = [];
            for (var c = 0; c < rowsIn[r].length; c++) {
                var day = dayOf(rowsIn[r][c].text);
                if (day) cols.push({ day: day, col: rowsIn[r][c].col, span: rowsIn[r][c].span });
            }
            if (cols.length >= 4) return { row: r, cols: cols };
        }
        return null;
    }

    // 没有表头：按表格总列数推算，最右 7 列是周一到周日；总列数不足 7 就推不出
    function guessCols(rowsIn) {
        var width = 0;
        for (var r = 0; r < rowsIn.length; r++) {
            for (var c = 0; c < rowsIn[r].length; c++) {
                width = Math.max(width, rowsIn[r][c].col + rowsIn[r][c].span);
            }
        }
        if (width < 7) return null;
        var first = width >= 8 ? width - 7 : 0;
        var cols = [];
        for (var d = 1; d <= 7; d++) cols.push({ day: d, col: first + d - 1, span: 1 });
        return cols;
    }

    // 表头只认出一部分天（周六、周日的表头格是空的，或周末合成了一格）：认出来的天定下网格列，
    // 缺的天按列的顺序往右补（星期一所在列往右依次是星期一到星期日）。补出来的天记在 guessed 里
    function completeCols(found) {
        var byDay = [null, null, null, null, null, null, null, null];
        var d;
        for (d = 0; d < found.length; d++) byDay[found[d].day] = found[d];
        var anchor = 0;
        for (d = 1; d <= 7 && !anchor; d++) {
            if (byDay[d]) anchor = d;
        }
        var base = byDay[anchor].col - (anchor - 1);
        var out = [];
        var guessed = [false, false, false, false, false, false, false, false];
        for (d = 1; d <= 7; d++) {
            if (byDay[d]) {
                out.push(byDay[d]);
                continue;
            }
            var col = base + d - 1;
            var taken = false;
            for (var f = 0; f < found.length; f++) {
                if (found[f].col === col) taken = true;
            }
            if (col < 0 || taken) continue;
            out.push({ day: d, col: col, span: 1 });
            guessed[d] = true;
        }
        return { cols: out, guessed: guessed };
    }

    // 格子覆盖的星期列：合并格（如跨了周六、周日的「周末」格）覆盖几天就算几天；覆盖不到星期列时返回空数组
    function daysAt(cols, col, span) {
        var out = [];
        for (var i = 0; i < cols.length; i++) {
            if (cols[i].col >= col && cols[i].col < col + span) out.push(cols[i].day);
        }
        return out;
    }

    // ---------- 学期与开学日 ----------
    function mondayOf(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        if (!m) throw new Error('提取日期无效：' + iso);
        var date = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        var back = (date.getDay() + 6) % 7;
        date = new Date(date.getFullYear(), date.getMonth(), date.getDate() - back);
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function nextDayOf(iso) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
        var date = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10) + 1);
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function termNameFromCode(code) {
        var m = /^(\d{4})-(\d{4})-(\d)$/.exec(code);
        if (!m) return '';
        var cn = { '1': '一', '2': '二', '3': '三' }[m[3]] || m[3];
        return m[1] + '-' + m[2] + '学年第' + cn + '学期';
    }

    // 学期名：教务给的文字优先；教务给的只是代码（2026-2027-1）时写成「2026-2027学年第一学期」；
    // 只有代码时拼同样的文字；都没有才用「学校名课表」，并说明
    function termNameOf() {
        var name = clean(term.name);
        var code = clean(term.code);
        if (term.source === 'select-first') {
            warn('学期下拉框没有标出选中项，已取第一项「' + clip(name || code, 40) + '」，请核对是不是要导入的学期');
        } else if (term.source === 'page-default') {
            warn('课表页上找不到学年学期下拉框，无法确认屏幕上的课表是哪一学期，学期名按教务默认学期「' +
                clip(name || code, 40) + '」写，请核对');
        }
        if (name && !/^\d{4}-\d{4}-\d$/.test(name)) return clip(name, 60);
        var generated = termNameFromCode(name || code);
        if (generated) return generated;
        warn('没有认出学年学期，学期名与开学日都需要在学期管理里核对');
        return SCHOOL_NAME + '课表';
    }

    // 教学周历的日期格：「2026年08月31」「2026年08月31日」「2026-08-31」都认；日期要真存在
    function isoOfCnDate(value) {
        var text = clean(value);
        var m = /(\d{4})\s*[-年]\s*(\d{1,2})\s*[-月]\s*(\d{1,2})/.exec(text);
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var probe = new Date(year, month - 1, day);
        if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
        return year + '-' + pad2(month) + '-' + pad2(day);
    }

    function calendarDayOf(text) {
        var t = clean(text);
        var m = /(?:星期|周)\s*([一二三四五六日天])/.exec(t);
        var ch = m ? m[1] : (t.length === 1 ? t : '');
        return ch && DAY_OF[ch] ? DAY_OF[ch] : 0;
    }

    // 周历表头里「星期一」所在的网格列；表头（单字「日一二…」或「星期一…」）认出不到 4 天就当没有，不按位置猜
    function calendarMondayCol() {
        var best = -1;
        var bestLabels = 0;
        for (var r = 0; r < calendarRows.length; r++) {
            var labels = 0;
            var monday = -1;
            var seen = {};
            for (var c = 0; c < calendarRows[r].length; c++) {
                var day = calendarDayOf(calendarRows[r][c].text);
                if (!day || seen[day]) continue;
                seen[day] = true;
                labels++;
                if (day === 1) monday = calendarRows[r][c].col;
            }
            if (labels > bestLabels) {
                bestLabels = labels;
                best = monday;
            }
        }
        return bestLabels >= 4 ? best : -1;
    }

    function cellAtCol(row, want) {
        for (var i = 0; i < row.length; i++) {
            if (row[i].col === want) return row[i];
        }
        return null;
    }

    // 第 1 周那一行：最左格的文字是 1（「1」「第1周」）
    function calendarWeekOneRow() {
        for (var r = 0; r < calendarRows.length; r++) {
            var row = calendarRows[r];
            if (!row.length) continue;
            var first = row[0];
            for (var k = 1; k < row.length; k++) {
                if (row[k].col < first.col) first = row[k];
            }
            if (/^第?\s*1\s*周?$/.test(clean(first.text))) return { row: row, first: first };
        }
        return null;
    }

    function cellDate(cell) {
        if (!cell) return null;
        return isoOfCnDate(cell.title) || isoOfCnDate(cell.text);
    }

    // 开学日期的取法（依次）：① 周历第 1 周那一行、「星期一」那一列的日期（真实值）；
    // ② 表头认不出时，按上游取该行第二格的日期，对齐到第 1 周的周一（星期日 → 次日，其余 → 所在周的周一）；
    // ③ 都没有，按提取当天推算最近的周一。②③必须说明：推算值和真值在库里长得一模一样，不说用户就没有机会发现。
    function firstDayOf() {
        var weekOne = calendarWeekOneRow();
        if (weekOne) {
            var mondayCol = calendarMondayCol();
            if (mondayCol >= 0) {
                var exact = cellDate(cellAtCol(weekOne.row, mondayCol));
                if (exact) {
                    var aligned = mondayOf(exact);
                    if (aligned !== exact) {
                        warn('教务的教学周历里第 1 周的星期一写的是 ' + exact + '（那天不是星期一），开学日期已按它所在那一周的周一（' +
                            aligned + '）对齐，请在学期管理里核对');
                    }
                    return aligned;
                }
            }
            var second = cellDate(cellAtCol(weekOne.row, weekOne.first.col + 1));
            if (second) {
                var d = new Date(parseInt(second.substring(0, 4), 10), parseInt(second.substring(5, 7), 10) - 1,
                    parseInt(second.substring(8, 10), 10));
                var guess = d.getDay() === 0 ? nextDayOf(second) : mondayOf(second);
                warn('教务的教学周历没有标出星期几的表头，开学日期按第 1 周那一行的第一个日期格（' + second + '）推算为 ' +
                    guess + '，请在学期管理里核对');
                return guess;
            }
        }
        var today = mondayOf(data.now);
        warn('开学日期无法从教务的教学周历获取，已按提取当天所在周的周一（' + today + '）推算第 1 周，请在学期管理里核对');
        return today;
    }

    // 对不上星期列的格子里若也有课：不导入，但要计入「一门课都没解析出来」的判断，免得误说成「还没排课」
    function countUnmatched(parts) {
        for (var p = 0; p < parts.length; p++) {
            var blocks = blocksOf(parts[p]);
            for (var b = 0; b < blocks.length; b++) {
                blocksSeen++;
                if (!firstBlockName) firstBlockName = nameOf(blocks[b]);
            }
        }
    }

    // ---------- 课程块 ----------
    function courseOf(name, teacher) {
        var key = name + SEP + (teacher || '');
        var course = courseByKey[key];
        if (!course) {
            course = { name: name, teacher: teacher, note: null, blocks: [] };
            courseByKey[key] = course;
            courseList.push(course);
        }
        return course;
    }

    // 一门课的一个格子块：节次、周次、地点都在这里定，认不出的按 warnings 说清楚再跳过。
    // days 是格子覆盖的星期（合并格会有几天）：课记在每一天上，但提醒与计数只算一次。
    // brief 为真：这是简表（kbcontent1）里的块；seen 记着同一格里明细块的「课名 + 周次」，简表块与它们相同就整块丢掉
    // （同一门课的简表副本，不计数、不提醒），简表独有的块照常导入
    function addBlock(html, days, labelPeriods, brief, seen) {
        var name = nameOf(html);
        var fonts = fontsOf(html);
        var weeksText = pickText(fonts, ['周次', '节次']);
        var weeks = weeksOf(weeksText);
        var key = name + SEP + weeks.weeks.join(',');
        if (brief && (!name || seen[key])) return;
        if (!brief) seen[key] = true;
        blocksSeen++;
        if (!firstBlockName) firstBlockName = name;
        if (!name) {
            issue('noName');
            return;
        }
        var teacher = teacherOf(fonts);
        var location = locationOf(fonts);

        // 节次优先级：方括号写的（周次字段里没有就到整块文字里找一个读得成的）> 所在行的节次。方括号里写了却认不出：
        // 照样按行对应，但要说出来；两者都没有就跳过并说明，不按行号猜
        var bracket = bracketOf(weeksText);
        if (!bracket) bracket = readableBracket(plainOf(html));
        var periods = bracket ? periodsOf(bracket) : null;
        var bracketBad = !!bracket && !periods;
        if (!periods) periods = labelPeriods;
        if (!periods) {
            issue('noPeriods', shortName(name));
            return;
        }
        if (bracketBad) issue('badBracket', shortName(name));
        var start = periods[0];
        var end = periods[periods.length - 1];
        if (end - start + 1 !== periods.length) issue('discontinuous', shortName(name));

        serialTotal += weeks.serial;
        var weekSample = shortName(name) + '：' + clip(weeksText || '空', 20);
        if (!weeks.weeks.length) {
            issue(weeks.serial && !weeks.bad.length ? 'serialOnly' : 'noWeeks', weekSample);
            return;
        }
        if (weeks.dropped) issue('clamped', shortName(name));
        if (weeks.bad.length) issue('badSeg', shortName(name) + '：' + clip(weeks.bad.join('、'), 20));
        if (weeks.notes) issue('weekNote', shortName(name) + '：' + weeks.noteSample);
        if (weeks.both) issue('bothMarks', shortName(name));

        if (!teacher) missingTeacher['n' + name] = true;
        if (!location) missingLocation['n' + name] = true;
        if ((!teacher || !location) && missingSamples.length < 3 && missingSamples.indexOf(name) < 0) {
            missingSamples.push(name);
        }

        var course = courseOf(name, teacher);
        for (var d = 0; d < days.length; d++) {
            entries.push({
                course: course,
                name: name,
                teacher: teacher || '',
                location: location || '',
                day: days[d],
                start: start,
                end: end,
                weeks: weeks.weeks
            });
        }
    }

    // ---------- 同课合并（对齐上游 mergeAndDistinctCourses 的语义，前面多一步去重） ----------
    // 0：完全相同的行只留一条；
    // 阶段 1：名称、教师、教室、星期、周次都一样、且节次首尾相接的合成一条；
    // 阶段 2：名称、教师、教室、星期、起止节次都一样的，周次取并集。
    // 只合并首尾相接的节次，重叠的节次保持原样：不丢课、不改任何一周的安排。
    function weeksKey(entry) {
        return entry.weeks.join(',');
    }

    function dropExactDuplicates(list) {
        var ledger = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            var key = 'k' + JSON.stringify([e.name, e.teacher, e.location, e.day, e.start, e.end, e.weeks]);
            if (ledger[key]) continue;
            ledger[key] = true;
            out.push(e);
        }
        return out;
    }

    function cmpText(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    function sameSlotDay(a, b) {
        return a.name === b.name && a.teacher === b.teacher && a.location === b.location && a.day === b.day;
    }

    function orderStageOne(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || cmpText(weeksKey(a), weeksKey(b)) || (a.start - b.start);
    }

    function orderStageTwo(a, b) {
        return cmpText(a.name, b.name) || cmpText(a.teacher, b.teacher) || cmpText(a.location, b.location) ||
            (a.day - b.day) || (a.start - b.start) || (a.end - b.end);
    }

    function unionWeeks(a, b) {
        return uniqueSorted(a.concat(b));
    }

    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next) && current.end + 1 === next.start) {
                current.end = next.end;
                continue;
            }
            if (current) out.push(current);
            current = {
                course: next.course, name: next.name, teacher: next.teacher, location: next.location,
                day: next.day, start: next.start, end: next.end, weeks: next.weeks
            };
        }
        if (current) out.push(current);
        return out;
    }

    function mergeStageTwo(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && current.start === next.start && current.end === next.end) {
                current.weeks = unionWeeks(current.weeks, next.weeks);
                continue;
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    // ---------- 主流程 ----------
    var header = headerOf(grid);
    var filled = header ? completeCols(header.cols) : null;
    var cols = header ? filled.cols : guessCols(grid);
    if (!cols && grid.length) {
        throw new Error('课表表格里找不到「星期一…星期日」表头，也推算不出星期列，无法解析');
    }
    if (!header && cols) {
        warn('没有找到「星期一…星期日」表头，已按表格最右 7 列推算星期，请核对课表');
    }
    var bodyStart = header ? header.row + 1 : 0;
    // 行标签只从第一个星期列左边、且没有课的格子里取；有课的格子绝不当标签
    var firstDayCol = 0;
    for (var fc = 0; cols && fc < cols.length; fc++) {
        if (fc === 0 || cols[fc].col < firstDayCol) firstDayCol = cols[fc].col;
    }
    // 有课内容、却对不上任何星期列的格子数：这些课没有导入，要说出来
    var unmatchedCells = 0;
    // 跨了几个星期列的合并格数：课会同时记在每一天，要提醒
    var spanCells = 0;
    // 行标签里写着的节次时间（「第一大节 08:00-09:40」），交给后面推每节的上课时间
    var labelTexts = [];
    for (var r = bodyStart; r < grid.length; r++) {
        var row = grid[r];
        var label = '';
        var c;
        for (c = 0; c < row.length; c++) {
            if (row[c].col < firstDayCol && !row[c].parts.length && !(row[c].briefParts || []).length) label += ' ' + row[c].text;
        }
        label = clean(label);
        if (label) labelTexts.push(label);
        var labelPeriods = labelPeriodsOf(label);
        for (c = 0; c < row.length; c++) {
            var detail = row[c].parts || [];
            var brief = row[c].briefParts || [];
            var days = daysAt(cols, row[c].col, row[c].span);
            if (!days.length) {
                if (detail.length || brief.length) unmatchedCells++;
                countUnmatched(detail.length ? detail : brief);
                continue;
            }
            if (days.length > 1 && (detail.length || brief.length)) spanCells++;
            var seen = {};
            var p;
            var b;
            var blocks;
            for (p = 0; p < detail.length; p++) {
                blocks = blocksOf(detail[p]);
                for (b = 0; b < blocks.length; b++) addBlock(blocks[b], days, labelPeriods, false, seen);
            }
            for (p = 0; p < brief.length; p++) {
                blocks = blocksOf(brief[p]);
                for (b = 0; b < blocks.length; b++) addBlock(blocks[b], days, labelPeriods, true, seen);
            }
        }
    }

    // 去完全相同的行 → 排序 → 阶段 1 → 再排序 → 阶段 2，然后按周次拆成块
    var merged = dropExactDuplicates(entries);
    merged.sort(orderStageOne);
    merged = mergeStageOne(merged);
    merged.sort(orderStageTwo);
    merged = mergeStageTwo(merged);
    var maxWeek = 0;
    var maxPeriod = 0;
    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            item.course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: runs[k].startWeek,
                endWeek: runs[k].endWeek,
                weekType: runs[k].weekType,
                location: item.location || null
            });
            if (runs[k].endWeek > maxWeek) maxWeek = runs[k].endWeek;
        }
        if (item.end > maxPeriod) maxPeriod = item.end;
    }

    if (filled) {
        var guessedDays = 0;
        for (var gd = 1; gd <= 7; gd++) {
            if (filled.guessed[gd]) guessedDays++;
        }
        var guessedBlocks = 0;
        for (var gi = 0; gi < courseList.length; gi++) {
            for (var gb = 0; gb < courseList[gi].blocks.length; gb++) {
                if (filled.guessed[courseList[gi].blocks[gb].dayOfWeek]) guessedBlocks++;
            }
        }
        // 补推出来的天上一门课都没有，就没有会被算错的安排，不提醒（否则会写成「这 0 条安排…」）
        if (guessedDays > 0 && guessedBlocks > 0) {
            warn('星期表头只认出了 ' + header.cols.length + ' 天，剩下 ' + guessedDays + ' 天已按列的顺序推算：这 '
                + guessedBlocks + ' 条安排的星期可能不准，请核对');
        }
    }
    if (unmatchedCells > 0) {
        warn('有 ' + unmatchedCells + ' 个格子里有课，但对不上星期列，这几格的课没有导入，请核对');
    }
    if (spanCells > 0) {
        warn('有 ' + spanCells + ' 个格子跨了几个星期列（如合并的「周末」格），这几格的课已同时记在每一天，请核对');
    }

    var totalWeeks = DEFAULT_TOTAL_WEEKS;
    if (maxWeek > totalWeeks) {
        totalWeeks = maxWeek;
        warn('课表里最晚是第 ' + maxWeek + ' 周，已把总周数从 ' + DEFAULT_TOTAL_WEEKS + ' 调到 ' + maxWeek + ' 周');
    }
    if (serialTotal > 0) warn('周次括号里的序号（如 (1)）已忽略 ' + serialTotal + ' 处，不当作周次');
    if (!courseList.length) {
        // 一门课都没解析出来不能照样返回空课表：导入会把本地同名学期的课全部作废
        if (blocksSeen > 0) {
            throw new Error('课表里有 ' + blocksSeen + ' 门课一个都没能解析出来（如「' + shortName(firstBlockName || '格式与预期不符') +
                '」）：教务页面结构可能已调整，欢迎反馈');
        }
        throw new Error('本学期没有解析到任何课程：可能是还没排课，或教务页面改了结构（也可能登录状态已失效）');
    }

    // ---------- 节次时间 ----------
    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    function hhmmOf(total) {
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    }

    // 节次号（已升序）写成「第 13-14 节」「第 13 节」这几种
    function sectionsText(list) {
        var runsText = [];
        var i = 0;
        while (i < list.length) {
            var j = i;
            while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
            runsText.push(list[i] === list[j] ? String(list[i]) : list[i] + '-' + list[j]);
            i = j + 1;
        }
        return '第 ' + runsText.join('、') + ' 节';
    }

    // 行标签里写的「第N大节 HH:MM-HH:MM」→ 每个大节 2 个小节（上游按时长反推小节数，课表其余部分都按每大节 2 节，
    // 反推出来不是 2 的行不采用）：第 2N-1 节从大节开始起算 45 分钟，第 2N 节到大节结束为止、也是 45 分钟
    function pageSlots() {
        var slots = {};
        var count = 0;
        var rejected = 0;
        for (var i = 0; i < labelTexts.length; i++) {
            var big = bigIndexOf(labelTexts[i]);
            if (!big) continue;
            var times = labelTexts[i].match(/(\d{1,2}):(\d{2})/g);
            if (!times || times.length < 2) continue;
            var startText = /(\d{1,2}):(\d{2})/.exec(times[0]);
            var endText = /(\d{1,2}):(\d{2})/.exec(times[1]);
            var from = parseInt(startText[1], 10) * 60 + parseInt(startText[2], 10);
            var to = parseInt(endText[1], 10) * 60 + parseInt(endText[2], 10);
            var span = to - from;
            var smallCount = Math.max(1, Math.round((span + BREAK_MINUTES) / (CLASS_MINUTES + BREAK_MINUTES)));
            if (to > DAY_END || startText[2] > 59 || endText[2] > 59 || smallCount !== 2 || span < 2 * CLASS_MINUTES || big * 2 > MAX_PERIOD) {
                rejected++;
                continue;
            }
            if (!slots[big * 2 - 1]) count++;
            if (!slots[big * 2]) count++;
            slots[big * 2 - 1] = { periodIndex: big * 2 - 1, start: hhmmOf(from), end: hhmmOf(from + CLASS_MINUTES) };
            slots[big * 2] = { periodIndex: big * 2, start: hhmmOf(to - CLASS_MINUTES), end: hhmmOf(to) };
        }
        return { slots: slots, count: count, rejected: rejected };
    }

    // 页面时间表 + 写死表补缺口（1..12），连成一张从第 1 节起不断档的表；前后不递增就返回 null
    function mergedTable(page) {
        var table = [];
        var filledFromFallback = [];
        for (var n = 1; n <= MAX_PERIOD; n++) {
            var slot = page.slots[n];
            if (!slot && n <= FALLBACK_TIMES.length) {
                slot = FALLBACK_TIMES[n - 1];
                filledFromFallback.push(n);
            }
            if (!slot) break;
            if (table.length && minutesOf(slot.start) < minutesOf(table[table.length - 1].end)) return null;
            table.push({ periodIndex: n, start: slot.start, end: slot.end });
        }
        return { table: table, filled: filledFromFallback };
    }

    var slotInfo = pageSlots();
    var periodTimes = null;
    var fallbackWhy = '';
    var filledSections = [];
    if (slotInfo.count >= MIN_PAGE_SLOTS) {
        var mergedSlots = mergedTable(slotInfo);
        if (mergedSlots) {
            periodTimes = mergedSlots.table;
            for (var fi = 0; fi < mergedSlots.filled.length; fi++) {
                if (mergedSlots.filled[fi] <= maxPeriod) filledSections.push(mergedSlots.filled[fi]);
            }
        } else {
            fallbackWhy = 'conflict';
        }
    } else {
        fallbackWhy = 'missing';
    }
    if (!periodTimes) {
        periodTimes = FALLBACK_TIMES.slice(0);
        var lastSlot = FALLBACK_TIMES[FALLBACK_TIMES.length - 1];
        var fallbackText = '已按学校公布的 ' + FALLBACK_TIMES.length + ' 节时间导入（第 1 节 ' + FALLBACK_TIMES[0].start + '-' +
            FALLBACK_TIMES[0].end + '、第 ' + lastSlot.periodIndex + ' 节 ' + lastSlot.start + '-' + lastSlot.end + '），与实际不符时请在学期管理里核对';
        warn(fallbackWhy === 'conflict' ? '课表页上写的节次时间前后对不上，' + fallbackText : '课表页没有给出完整的节次时间，' + fallbackText);
    } else if (filledSections.length) {
        warn('课表页没有写' + sectionsText(filledSections) + '的上课时间，已按学校公布的节次时间补上，请在学期管理里核对');
    }
    // 课表用到的节次超出节次时间表（统一修订 H3）：在上一节下课后顺推，越过 23:59 的补不了
    var extended = [];
    var uncoveredFrom = 0;
    for (var pi = periodTimes.length + 1; pi <= maxPeriod; pi++) {
        var prev = periodTimes[periodTimes.length - 1];
        var nextStart = minutesOf(prev.end) + BREAK_MINUTES;
        var nextEnd = nextStart + CLASS_MINUTES;
        if (nextEnd > DAY_END) {
            uncoveredFrom = pi;
            break;
        }
        periodTimes.push({ periodIndex: pi, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        extended.push(pi);
    }
    if (extended.length) {
        warn('课表用到了' + sectionsText(extended) + '，学校公布的节次时间没有覆盖，已按上一节下课后课间 ' +
            BREAK_MINUTES + ' 分钟、每节 ' + CLASS_MINUTES + ' 分钟顺推补上，请在学期管理里核对');
    }
    if (uncoveredFrom) {
        warn('课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上');
    }

    var termName = termNameOf();
    var firstDay = firstDayOf();

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: finishWarnings(),
        terms: [{
            name: termName,
            firstDay: firstDay,
            totalWeeks: totalWeeks,
            periodTimes: periodTimes,
            courses: courseList
        }]
    });
})()
