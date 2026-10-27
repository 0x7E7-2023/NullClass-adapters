(function () {
    // 广东海洋大学（校外通道）教务适配器（正方教务 V9 新版 jwglxt，经学校零信任通道访问）—— 第二步：教务原始数据 → 空课课表载荷。
    //
    // 移植自 shiguang_warehouse 的 GDOU/gdou2.js（与 gdou.js 逻辑一致；本文件除这段文件头外与 jw-adapters/gdou/parse.js 逐字相同，以后跟进上游一处改两件）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Mccurtain）
    //   上游快照 e15c6274ac347c9642da890504651a9b4e374391（2026-10-26 拉取；首次移植时的快照是 19a65bf）
    //   本校脚本 gdou2.js 由 3976cfa 新增（2026-10-25，PR #892，作者 Mccurtain，上游版本号 1.0）
    //   同目录的阳江校区脚本 gdouyj.js / gdouyj2.js 不在本件范围内
    //
    // 上游在同一段脚本里算周次、拼课程、存配置；这里只做纯转换（不碰页面、不发请求，CI 用 Rhino 实跑），
    // 取数全部在 extract.js 里，交出来的是教务行对象里 parse 用得到的字段（kbList / sjkList），外加学期周次校历。
    //
    // 移植改动（按移植手册 §4 与本批检查表逐条对照）：
    //   ① 周次写法全认：「1-16周(单)」（标记在「周」后）、「(单)1-16周」（标记在最前）、「1-16(单周)」（标记在括号里、后面没有「周」字）、
    //      「1-3,5-9周」（混排）、「第1-第8周」（区间终点前带「第」）。上游逐个逗号段只取第一个区间、只认半角的「(单)」「(双)」，
    //      「1-4周 6-8周」这类空格分段只读到前一段，全角括号的「（单）」整个标记丢掉，这里都接住
    //   ② 括号里的纯数字是教学班序号（"(1)"、"(1-2)"），整组摘掉再找周次，免得被当成第 1-2 周；
    //      含非周次字的括号（"(3组)"）是备注，也摘掉并写进 warnings（检查表 2）
    //   ③ 上游已经允许教师、教室为空，只要求课名 / 星期 / 节次 / 周次齐全；这里同样，缺教师或缺教室的课照常导入（对应项为空，
    //      手册 §4.7），按类型汇总计数写进 warnings，跳过的行按原因分类计数写进 warnings，不静默
    //   ④ 节次从 "1-2" 放宽到 "第9-10节" / "1,2" / 两位一拼的 "0102"（上游的节次格式正则认不出后两种），
    //      多段（"1-2,5-6"）按最大跨度放入并说明
    //   ⑤ 开学日与总周数：上游从学期周次校历（cxZcByXnxq）取第 1 周日期（zrq → zcrq → rq → ksrq，日期写法认「-」「/」「.」「年月日」），
    //      总周数取「校历周数」与「课表最大周次」中较大者；这里同样，开学日再回退到那一周的周一（手册 §4.3），校历取不到才推算并写 warnings；
    //      上游找不到第 1 周时拿第一行顶替，这里不顶替，宁可推算也不写错日期
    //   ⑥ 节次时间：上游写死 10 节（TimeSlots）、不请求教务的节次时间接口；这里同样不请求，直接用这 10 节（逐节照抄），
    //      并在 warnings 里说明是本校固定的；课表用到第 11 节及以后时，在上一节下课后顺推（课间 5 分钟、每节 45 分钟），
    //      顺推越过 23:59 的如实说明（批次五统一修订 H3）
    //   ⑦ 连堂特殊时间：上游给指定教学楼 / 室外场地的第 3-4 节、第 7-8 节打 isCustomTime（10:05-11:35、16:25-17:50）。
    //      载荷没有按课自定义时间的字段（手册 §4.4），所以课照节次导入，另用一条提醒说清楚有几门课、例子和这两段时间。
    //      上游弹窗问校区（湖光 / 海滨）来决定哪些场地算数；这里不问（一条提醒不值得每次弹窗），始终按两个校区规则的并集判断
    //      上游在合并之前逐行打标、合并后只撤销不新增；这里只在合并之后按最终节次区间判断（行 3 与行 4 分开写的同一节连堂也算）
    //   ⑧ 课名规范化：上游 normalizeCourseName 把开头括号里的标签挪到末尾（「（公选）大学英语」→「大学英语(公选)」），照搬
    //   ⑨ 学期名取教务下拉框的学年学期，不拿适配器名当学期名（手册 §4.7）；读不出学年时用「广东海洋大学 第 X 学期」
    //   ⑩ 同课合并：照上游 mergeAndDistinctCourses 的两阶段（连续节次合并 + 同节次周次并集），合并前先去掉完全相同的行
    //      （dropExactDuplicates；上游只跟当前合并中的那条比，漏掉合并后才出现的重复行，这里修正）。
    //      见 mergeStageOne / mergeStageTwo。先把每行收成 entry 再合并，不丢课、不改任何一周的安排
    //   ⑪ 上游的导出流程（开场弹窗、学年学期与校区选择弹窗、saveImportedCourses / saveCourseConfig / savePresetTimeSlots、
    //      showToast / notifyTaskCompletion）全部不移植：这些是「拾光」的桥能力，空课由宿主负责保存，适配器只交载荷
    //   ⑫ 1.1.0 跟进上游 3976cfa：室外场地关键词由「球场」改为「场」（上游 outdoorKeywords），匹克场、运动场、田径场等不含「球」字的场地也算室外场地
    var data = JSON.parse(typeof __ncInput === 'undefined' ? '{}' : __ncInput);
    var term = data.term || {};
    var raw = data.raw || {};
    var rows = Array.isArray(raw.kbList) ? raw.kbList : [];
    var practiceRows = Array.isArray(raw.sjkList) ? raw.sjkList : [];

    var MAX_WEEK = 30;             // 载荷校验：totalWeeks ∈ 1..30，周次也只在这个区间里取
    var MAX_PERIOD = 20;           // 单日节次上限：超过它一定是脏数据（本校 10 节，更晚的节次顺推）
    var SCHOOL_NAME = '广东海洋大学';   // 学期名兜底时用（拿不到学年时「学校名 + 学期」，不用适配器名）
    var SCHOOL_TOTAL_WEEKS = 20;   // 上游配置里的学期总周数（config.semesterTotalWeeks = 20），校历取不到时用它
    var MAX_WARNINGS = 20;         // 载荷校验：warnings ≤20 条
    var MAX_WARNING_TEXT = 200;    // 载荷校验：每条 ≤200 字
    var NAME_TEXT_LIMIT = 20;      // 提醒里点名的课名最多显示的字数（超出截断并以「…」结尾）
    var EXTEND_BREAK_MINUTES = 5;  // 节次时间顺推：下一节比上一节下课晚几分钟开始
    var EXTEND_CLASS_MINUTES = 45; // 节次时间顺推：每节几分钟

    // 本校节次时间（广东海洋大学）：上游 GDOU/gdou.js 的 TimeSlots 那 10 节，逐节照抄原值。
    // 上游不请求教务的节次时间接口，这里也不取；导入时 warnings 会说明节次时间是本校固定的。
    var SCHOOL_PERIOD_TIMES = [
        { periodIndex: 1, start: '08:10', end: '08:55' },
        { periodIndex: 2, start: '09:00', end: '09:45' },
        { periodIndex: 3, start: '10:15', end: '11:00' },
        { periodIndex: 4, start: '11:05', end: '11:50' },
        { periodIndex: 5, start: '14:30', end: '15:15' },
        { periodIndex: 6, start: '15:20', end: '16:05' },
        { periodIndex: 7, start: '16:30', end: '17:15' },
        { periodIndex: 8, start: '17:20', end: '18:05' },
        { periodIndex: 9, start: '19:30', end: '20:15' },
        { periodIndex: 10, start: '20:25', end: '21:10' }
    ];

    // 连堂特殊时间（上游 SPECIAL_TIME_BLOCKS）：指定场地的这两段连堂不按上面的节次时间上课
    var SPECIAL_BLOCKS = [
        { start: 3, end: 4, from: '10:05', to: '11:35' },
        { start: 7, end: 8, from: '16:25', to: '17:50' }
    ];

    // 特殊场地（上游 CAMPUS_CONFIGS 里湖光、海滨两个校区的规则并集）：venues 是整栋楼（教室文本里包含即命中，
    // 如「实验楼」命中「实验楼301」「网球场（实验楼东面）」；广学楼、明德楼属湖光，实验楼属海滨），
    // patterns 是楼名简写（海滨「实」+房间号 = 实验楼简写，如「实506-1计算机（2）室」），outdoor 是海滨的室外场地关键词（「场」通用覆盖网球场 / 匹克场 / 田径场等各类场地，方向词覆盖「XX（实验楼东面）」这类括号写法）；
    // venueText 是写进提醒里的场地说法
    var SPECIAL_VENUES = {
        venues: ['广学楼', '明德楼', '实验楼'],
        patterns: [/^实[0-9]/],
        outdoor: ['场', '东面', '南面', '西面', '北面'],
        venueText: '广学楼、明德楼、实验楼及球场等室外场地'
    };

    var KIND_CN = { first: '一', second: '二', third: '三' };
    // 推算开学日的锚点：第一学期多在 9 月初、第二学期多在 2 月下旬、夏季学期 7 月初。
    // 别把锚点直接当 firstDay：手册 §4.3 要求回退到「第 1 周的第一天」那一周的周一（含当天）。
    var KIND_ANCHOR = {
        first: { month: 9, day: 1, rule: '第一学期 = 9 月 1 日所在周的周一' },
        second: { month: 2, day: 20, rule: '第二学期 = 2 月 20 日所在周的周一' },
        third: { month: 7, day: 1, rule: '夏季学期 = 7 月 1 日所在周的周一' }
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

    // 字典里有多少个键（用对象当字典，不引入集合类）
    function countKeys(dict) {
        var n = 0;
        for (var key in dict) {
            if (Object.prototype.hasOwnProperty.call(dict, key)) n++;
        }
        return n;
    }

    function intOf(value) {
        var n = parseInt(value, 10);
        return isNaN(n) ? null : n;
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

    // 任意形态的日期 → ISO 日期（只认年月日，后面的时间/星期/区间后半段忽略）。
    // 上游 normalizeStartDate 认「-」「/」「.」和中文「年月日」分隔，且不要求出现在开头，这里照办
    function isoOfAny(value) {
        var m = /(^|[^0-9])([0-9]{4})[-/.年]([0-9]{1,2})[-/.月]([0-9]{1,2})/.exec(text(value));
        if (!m) return null;
        var month = parseInt(m[3], 10);
        var day = parseInt(m[4], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[2] + '-' + pad2(month) + '-' + pad2(day);
    }

    function mondayOfIso(iso) {
        if (!iso) return null;
        return isoOf(mondayOnOrBefore(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10),
            parseInt(iso.substring(8, 10), 10)
        ));
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function minutesOf(hhmm) {
        return parseInt(hhmm.substring(0, 2), 10) * 60 + parseInt(hhmm.substring(3, 5), 10);
    }

    // 教务接口的返回可能是裸数组，也可能套一层信封（{rows:[]} / {code:0,datas:{…}}）。
    // 校历在 extract.js 里已经收成白名单数组，这里仍按「最像行数组的那一层」找（多一层防护）；找不到就返回空数组，
    // 调用方据此回落到推算并如实写进 warnings。
    function rowsIn(value) {
        if (Array.isArray(value)) return value;
        if (!value || typeof value !== 'object') return [];
        var keys = ['rows', 'datas', 'data', 'list', 'items', 'kbList'];
        var i;
        for (i = 0; i < keys.length; i++) {
            var known = rowsIn(value[keys[i]]);
            if (known.length) return known;
        }
        for (var key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            var found = rowsIn(value[key]);
            if (found.length) return found;
        }
        return [];
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
    // 优先看教务下拉框的文本（「一/二/三」），认不出来再看正方自己的学期代号
    // （正方 jwglxt：3 = 第一学期、12 = 第二学期、16 = 第三学期；个别部署写成 1 / 2）
    function termKind() {
        var label = text(term.xqmText);
        if (label.indexOf('二') >= 0) return 'second';
        if (label.indexOf('三') >= 0) return 'third';
        if (label.indexOf('一') >= 0) return 'first';
        var code = text(term.xqm);
        if (code === '12' || code === '2') return 'second';
        if (code === '16') return 'third';
        return 'first';
    }

    function termYear() {
        return /^[0-9]{4}$/.test(text(term.xnm)) ? parseInt(text(term.xnm), 10) : 0;
    }

    function yearLabel() {
        var label = text(term.xnmText);
        if (/^[0-9]{4}-[0-9]{2,4}$/.test(label)) return label;
        var year = termYear();
        if (year) return year + '-' + (year + 1);
        return label || text(term.xnm);
    }

    // 学期名用教务自己的学年学期（手册 §4.7：别拿适配器名当学期名）
    function termName() {
        var explicit = text(term.name);
        if (explicit) return explicit;
        var whole = text(term.xqmText);
        // 有的学校把整个「2026-2027学年第一学期」放进学期下拉框
        if (whole && whole.indexOf('学年') >= 0 && whole.indexOf('学期') >= 0) return whole;
        var label = yearLabel();
        // 学年读不出来（xnm 为空或不是年份，下拉框文本也不是「YYYY-YYYY」）：学校名 + 学期，不用适配器名
        if (!termYear() && !/^[0-9]{4}-[0-9]{2,4}$/.test(label)) {
            return SCHOOL_NAME + ' 第' + KIND_CN[termKind()] + '学期';
        }
        return label + '学年第' + KIND_CN[termKind()] + '学期';
    }

    // 教务校历取不到时的开学日推算。依赖学期序号的锚点，推算结果一律写进 warnings。
    function estimateStart(todayIso) {
        var anchor = KIND_ANCHOR[termKind()];
        var kind = termKind();
        var year = termYear();
        if (!year) {
            // 学年读不出来（课表页被改过）时退回「今天的周一」。这条分支依赖当天日期，
            // 不要写进 fixture 用例 —— 用例会随日期失效
            return { iso: mondayOfIso(todayIso) || todayIso, rule: '今天的周一' };
        }
        return {
            iso: isoOf(mondayOnOrBefore(year + (kind === 'first' ? 0 : 1), anchor.month, anchor.day)),
            rule: anchor.rule
        };
    }

    // 校历万一给的是别的学期（例如接口忽略了 xnm / xqm），宁可按推算走 + 说出来，
    // 也不要悄悄写一个错日期：开学日错了整学期的课都会错位。
    function plausibleStart(iso) {
        var year = termYear();
        if (!year) return true;
        var kind = termKind();
        var anchor = KIND_ANCHOR[kind];
        var anchorYear = kind === 'first' ? year : year + 1;
        var target = Date.UTC(anchorYear, anchor.month - 1, anchor.day);
        var value = Date.UTC(
            parseInt(iso.substring(0, 4), 10),
            parseInt(iso.substring(5, 7), 10) - 1,
            parseInt(iso.substring(8, 10), 10)
        );
        if (isNaN(target) || isNaN(value)) return true;
        return Math.abs(value - target) <= 45 * 86400000;
    }

    // ---------- 周次 ----------
    // 周次文本 → 周次集合（去重、升序）。正方 V9 常见的写法：
    //   "1-16周" / "1-16周(单)" / "(单)1-16周" / "1-16(单周)" / "1-3,5-9周" / "17周" / "1-3周 5-9周"
    // 四个必须显式处理的坑：
    //   ① 「周」只是量词，不能拿它当分段边界：「1-16周(单)」里紧跟「周」的「(单)」会被切到另一段，
    //      单双标记整段丢掉 —— 这门课就退化成「每周都上」而且一声不吭。所以先把「周」整个删掉再切段；
    //   ② 单/双标记有三种位置（括号里跟在「周」后、括号里在最前、跟在数字后），标记只跟它自己那一段走；
    //      万一标记自己成了一段（"1-16周,双"），并给最近的周次段，不丢；
    //   ③ 括号先于删「周」逐组判断：括号里只有数字的（"(1)"、"(1-2)"）是教学班序号，整组摘掉，免得被当成第 1-2 周；
    //      含非周次字的（"(3组)"）也摘掉，计数后写进 warnings；其它（"(1-16周)"、"(单)"）保留内容；每组都换成逗号，数字不会粘连；
    //   ④ 空白两头都要顾：破折号**连同两侧的空白**先归一成半角 '-'（"1 -16周(单)"、"1- 16周" 这类
    //      区间带空格的写法，不归一就会被切段劈成两块）；剩下的空白**当分段符**折成逗号 ——
    //      "1-16周 双" 的标记自成一段、"1-3周 5-9周" 是两段。先全文删空白会把 "1-3周 5-9周"
    //      拼成 "1-35" → 1-30 全周，静默吞掉一段（本批统一口径，与 xawl 一致）。
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
        // 同批统一修正：周次里常夹着「共8周」这类课程总周数备注，它不是上课周次，只剥备注本身；
        // 不能从第一个「共」一路删到行尾 —— 「1-8周(共8周),9-16周」后面的 9-16 周会被一起吞掉
        cleaned = cleaned.replace(/共\s*[0-9]+\s*周?/g, '');
        // ④ 第一步：破折号（半角 / 全角 / 波浪 / 减号 / 汉字「至」「到」）连同两侧空白 → 半角 '-'，
        //    "1 -16周(单)" / "1- 16周" / "1～16周" / "1至16周" 都归成标准形态。**不要在这里删掉全部空白**。
        cleaned = cleaned.replace(/\s*[-～－−–—~至到]\s*/g, '-');
        cleaned = fullWidthToHalf(cleaned);
        // 同批统一修正（模板缺陷）：紧挨周次的单/双括号按相邻关系先归属，再交给下面的通用括号处理 ——
        //   标记前面紧挨着数字或「周」（中间只隔空白）时是后缀，归前一段；只有在段首（开头或分隔符之后）才是下一段的前缀。
        //   所以必须先处理后缀：先处理前缀的话，"1-8周(单) 9-16周(双)" 里第一个「(单)」后面跟着数字，
        //   会被当成「9-16周」的前缀，读成 1-8 每周 + 9-16 单双错位；
        //   前缀写法 "(单)1-8周,(双)9-16周" 里两个标记都并到前一段，会把 1-16 周都读成每周都上。
        //   后缀折成 "8单,"（带逗号，免得紧邻的下一段 "9-16" 粘在后面），前缀折成 "单9"，标记就跟着自己那一段走
        cleaned = cleaned.replace(/([0-9])\s*周?\s*\(([单双])(?:周)?\)/g, function (all, digit, mark, offset, whole) {
            // 无逗号前置单双标记修正：标记所在的这一段本身以前置标记开头时（"(单)1-8周(双)9-16周"），它是下一段的前缀，不折成后缀
            if (/^\([单双]/.test(whole.substring(0, offset + all.indexOf('(')).replace(/\s+$/, '').split(/[,\s]+/).pop())) return all;
            return digit + mark + ',';
        });
        cleaned = cleaned.replace(/\(([单双])(?:周)?\)\s*(?=[0-9])/g, function (all, mark, offset, whole) {
            // 无逗号前置单双标记修正：标记前面紧挨数字或「周」时是上一步留下的前缀（夹在两段中间），前面补逗号隔开两段
            if (/[0-9周]\s*$/.test(whole.substring(0, offset))) return ',' + mark;
            return mark;
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
                if (!noteSample) noteSample = all;
                return ',';
            }
            return ',' + inner + ',';
        });
        cleaned = cleaned.replace(/[()]/g, ',');   // 剩下落单的括号字符（没有闭合）也换成逗号，不许直接删
        cleaned = cleaned.replace(/周/g, '');
        // 区间终点前的「第」（「第1-第8周」）：去掉，否则区间会被拆成第 1 周与第 8 周两段
        cleaned = cleaned.replace(/-\s*第\s*/g, '-');
        // ④ 第二步：剩下的空白当分段符折成逗号（fullWidthToHalf 已把全角逗号 / 顿号 / 分号折成半角逗号）
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
    // 节次文本 → {start, end, sparse}；读不出来返回 null（调用方计数进 warnings，不静默丢课）。
    // 认得的写法：正方的 "1-2" / "3-4节" / "第9-10节" / "1,2"，以及个别部署把每节占两位拼成的
    // "0102"（= 第 1、2 节）。括号里的纯数字是序号不是节次，先摘掉。
    var sparseRows = 0;   // 节次写成多段（"1-2,5-6"）的行数
    function sectionsOf(row) {
        var source = text(row.jcs);
        if (!source) return null;
        var cleaned = fullWidthToHalf(source)
            .replace(/\([ ]*[0-9]+[ ]*\)/g, '')
            .replace(/节/g, '')
            .replace(/[ ]+/g, '');
        var pieces = cleaned.split(/,+/);
        var numbers = [];
        var i;
        for (i = 0; i < pieces.length; i++) {
            var piece = pieces[i];
            if (!piece) continue;
            var range = /^第?([0-9]{1,2})[-]([0-9]{1,2})$/.exec(piece);
            if (range) {
                var from = parseInt(range[1], 10);
                var to = parseInt(range[2], 10);
                if (to < from) { var swap = from; from = to; to = swap; }
                for (var n = from; n <= to; n++) numbers.push(n);
                continue;
            }
            if (/^第?[0-9]{1,2}$/.test(piece)) {
                numbers.push(parseInt(piece.replace(/[^0-9]/g, ''), 10));
                continue;
            }
            if (/^[0-9]{4}$/.test(piece)) {
                numbers.push(parseInt(piece.substring(0, 2), 10));
                numbers.push(parseInt(piece.substring(2), 10));
                continue;
            }
            return null;
        }
        if (!numbers.length) return null;
        var start = numbers[0];
        var end = numbers[0];
        var unique = [];
        var seen = {};
        for (i = 0; i < numbers.length; i++) {
            var value = numbers[i];
            if (value < start) start = value;
            if (value > end) end = value;
            if (!seen[value]) { seen[value] = true; unique.push(value); }
        }
        if (start < 1 || end > MAX_PERIOD) return null;
        unique.sort(function (a, b) { return a - b; });
        var sparse = false;
        for (i = 1; i < unique.length; i++) {
            if (unique[i] - unique[i - 1] !== 1) sparse = true;
        }
        if (sparse) sparseRows++;
        return { start: start, end: end, sparse: sparse };
    }

    // ---------- 教务的学期周次校历（extract.js 另取的，取不到就是 null） ----------
    // 校历：一行一周，zs / zsmc = 第几周，日期字段各部署叫法不一（zrq / zcrq / rq / ksrq）
    function calendarInfo(value) {
        var list = rowsIn(value);
        var info = { firstIso: null, weeks: 0, rejectedIso: null };
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var week = intOf(row.zs);
            if (week === null) week = intOf(row.zsmc);
            var iso = isoOfAny(row.zrq) || isoOfAny(row.zcrq) || isoOfAny(row.rq) || isoOfAny(row.ksrq);
            if (week === null || week < 1 || !iso) continue;
            if (week > info.weeks) info.weeks = week;
            if (week === 1) {
                if (plausibleStart(iso)) info.firstIso = iso;
                else info.rejectedIso = iso;
            }
        }
        return info;
    }

    // ---------- 连堂特殊时间 ----------
    // 教室文本是否命中特殊场地（整栋楼 / 楼名简写 / 室外关键词，任一即可）
    function isSpecialVenue(place) {
        var where = text(place);
        if (!where) return false;
        var i;
        for (i = 0; i < SPECIAL_VENUES.venues.length; i++) {
            if (where.indexOf(SPECIAL_VENUES.venues[i]) >= 0) return true;
        }
        for (i = 0; i < SPECIAL_VENUES.patterns.length; i++) {
            if (SPECIAL_VENUES.patterns[i].test(where)) return true;
        }
        for (i = 0; i < SPECIAL_VENUES.outdoor.length; i++) {
            if (where.indexOf(SPECIAL_VENUES.outdoor[i]) >= 0) return true;
        }
        return false;
    }

    // 节次区间恰好是一段连堂特殊时间（第 3-4 节或第 7-8 节）就返回那一段，否则 null
    function specialBlockOf(start, end) {
        for (var i = 0; i < SPECIAL_BLOCKS.length; i++) {
            if (SPECIAL_BLOCKS[i].start === start && SPECIAL_BLOCKS[i].end === end) return SPECIAL_BLOCKS[i];
        }
        return null;
    }

    // 上游 normalizeCourseName：开头括号里的标签（「（公选）大学英语」）挪到末尾（「大学英语(公选)」）；
    // 括号后面没有课名的保持原样
    function normalizeCourseName(rawName) {
        var name = text(rawName);
        var m = /^[（(]([^（）()]+)[）)]\s*/.exec(name);
        if (!m) return name;
        var rest = name.substring(m[0].length);
        if (!rest) return name;
        return rest + '(' + m[1] + ')';
    }

    // ---------- 逐行转换 ----------
    var courses = [];
    var byName = {};
    var missing = { name: 0, day: 0, period: 0, week: 0 };
    // 已导入、但教务没给上课教师 / 上课地点的课（按课名去重，提醒里说「N 门课」才准）
    var missingTeacherCourses = {};
    var missingLocationCourses = {};
    var fieldSamples = [];     // 这两类课里点名用的课名，最多 3 个
    var weekSamples = [];   // 没解析出周次的原始文本，最多留 3 个，写进 warnings 方便反馈
    var maxWeek = 0;
    var maxPeriod = 0;

    // 课程按「名称 + 教师」归档，顺序取第一次出现的顺序；节次与周次先收成 entry，合并后再拆成 block
    function courseOf(name, teacher) {
        var bucket = byName['k' + name];
        if (!bucket) { bucket = {}; byName['k' + name] = bucket; }
        var key = 't' + (teacher || '');
        var found = bucket[key];
        if (found) return found;
        found = { name: name, teacher: teacher, note: null, blocks: [] };
        bucket[key] = found;
        courses.push(found);
        return found;
    }

    // ---------- 同课合并（对齐上游 mergeAndDistinctCourses 的两阶段语义） ----------
    // 每行收成一条 entry（课程、教师、教室、星期、起止节次、周次集合）后套三步：
    //   0：完全相同的行只留一条（dropExactDuplicates）；
    //   阶段 1：名称、教师、教室、星期、周次都一样、且节次首尾相接的合成一条；
    //   阶段 2：名称、教师、教室、星期、起止节次都一样的，周次取并集。
    // 只合并首尾相接的节次，重叠的节次保持原样（上游也是这么做的）：不丢课、不改任何一周的安排。
    var entries = [];

    // 完全相同的行（课名、教师、教室、星期、起止节次、周次都一样）只留第一条：账本记下见过的，再遇到就丢。
    // 必须在阶段 1 之前做：阶段 1 只跟当前正在合并的那一条比，合并之后才出现的重复会漏网
    // （如 1-2、3-4、3-4：第三行与第二行相同，不先去重会得到 1-4 与 3-4 两块，在 3-4 节重叠）。
    // 完全相同的两行是同一个上课安排，去掉它不算丢课。
    function dropExactDuplicates(list) {
        var ledger = {};
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var key = 'k' + JSON.stringify([entry.name, entry.teacher, entry.location, entry.day, entry.start, entry.end, entry.weeks]);
            if (ledger[key]) continue;
            ledger[key] = true;
            out.push(entry);
        }
        return out;
    }

    function cmpText(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }

    function sameSlotDay(a, b) {
        return a.name === b.name && a.teacher === b.teacher && a.location === b.location && a.day === b.day;
    }

    function weeksKey(entry) {
        return entry.weeks.join(',');
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
        var all = a.concat(b);
        var have = {};
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (have[all[i]]) continue;
            have[all[i]] = true;
            out.push(all[i]);
        }
        return out.sort(function (x, y) { return x - y; });
    }

    // 阶段 1（输入已按 orderStageOne 排好）
    function mergeStageOne(list) {
        var out = [];
        var current = null;
        for (var i = 0; i < list.length; i++) {
            var next = list[i];
            if (current && sameSlotDay(current, next) && weeksKey(current) === weeksKey(next)) {
                if (current.end + 1 === next.start) { current.end = next.end; continue; }
            }
            if (current) out.push(current);
            current = next;
        }
        if (current) out.push(current);
        return out;
    }

    // 阶段 2（输入已按 orderStageTwo 排好）
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

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || {};

        var name = normalizeCourseName(row.kcmc);
        if (!name) { missing.name++; continue; }

        var day = intOf(row.xqj);
        if (!(day >= 1 && day <= 7)) { missing.day++; continue; }

        var sections = sectionsOf(row);
        if (!sections) { missing.period++; continue; }

        var weeks = weeksOf(row.zcd);
        if (!weeks.length) {
            missing.week++;
            var sample = text(row.zcd);
            if (sample && weekSamples.length < 3 && weekSamples.indexOf(sample) < 0) weekSamples.push(sample);
            continue;
        }

        // 教师、教室没有就让它是空的（手册 §4.7：写「未知」会被课表当成真名显示）；
        // 缺了也照常导入，按类型计数后汇总写进 warnings，不静默
        var teacher = text(row.xm);
        var location = text(row.cdmc);
        if (!teacher) missingTeacherCourses['n' + name] = true;
        if (!location) missingLocationCourses['n' + name] = true;
        if ((!teacher || !location) && fieldSamples.length < 3 && fieldSamples.indexOf(name) < 0) {
            fieldSamples.push(name);
        }
        entries.push({
            course: courseOf(name, teacher || null),
            name: name,
            teacher: teacher,
            location: location,
            day: day,
            start: sections.start,
            end: sections.end,
            weeks: weeks
        });
    }

    // 去完全相同的行 → 排序 → 阶段 1 → 再排序 → 阶段 2（与上游 mergeAndDistinctCourses 的两阶段一致，前面多一步去重）
    entries = dropExactDuplicates(entries);
    entries.sort(orderStageOne);
    var merged = mergeStageOne(entries);
    merged.sort(orderStageTwo);
    merged = mergeStageTwo(merged);

    // 合并后的每条 entry 按周次拆成 block（步长 2 → 单 / 双周，见 runsOf）
    var specialCourses = {};       // 命中连堂特殊时间的课（按课名去重）
    var specialNames = [];         // 提醒里点名用，按出现顺序
    for (var m = 0; m < merged.length; m++) {
        var item = merged[m];
        if (specialBlockOf(item.start, item.end) && isSpecialVenue(item.location) && !specialCourses['n' + item.name]) {
            specialCourses['n' + item.name] = true;
            specialNames.push(item.name);
        }
        var runs = runsOf(item.weeks);
        for (var k = 0; k < runs.length; k++) {
            var run = runs[k];
            if (run.end > maxWeek) maxWeek = run.end;
            if (item.end > maxPeriod) maxPeriod = item.end;
            item.course.blocks.push({
                dayOfWeek: item.day,
                startPeriod: item.start,
                endPeriod: item.end,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: item.location || null
            });
        }
    }

    if (!courses.length) {
        throw new Error(
            '这个学期没有解析到任何课程：可能还没排课，也可能登录状态已失效。' +
            '请重新登录、打开「信息查询 - 学生课表查询」确认能看到课表后再试'
        );
    }

    // 合并用的 entry 与分组表都是内部数据，不进载荷
    var payloadCourses = [];
    for (var c = 0; c < courses.length; c++) {
        payloadCourses.push({
            name: courses[c].name,
            teacher: courses[c].teacher,
            note: courses[c].note,
            blocks: courses[c].blocks
        });
    }

    // ---------- 学期名 / 开学日 / 总周数 ----------
    var name0 = termName();
    var todayIso = isoOfAny(data.today) || localTodayIso();
    var calendar = calendarInfo(data.calendar);
    // 第 1 周日期被判为「不属于这个学期」时，这份校历是别的学期的，周数也一并作废，不拿来定学期总周数
    var calendarRejected = !calendar.firstIso && !!calendar.rejectedIso;
    if (calendarRejected) calendar.weeks = 0;

    var start;
    if (calendar.firstIso) {
        start = { iso: mondayOfIso(calendar.firstIso), rule: '教务校历' };
    } else {
        start = estimateStart(todayIso);
    }

    // 正文接口不给总周数（上游直接写死 20）。校历给得出就先用校历，但课表里更晚的周次
    // 必须放得下（endWeek 超过 totalWeeks 会被载荷校验拒掉），抬高时单独说明。
    var calendarWeeks = calendar.weeks > 0 ? calendar.weeks : 0;
    var totalWeeks = calendarWeeks > 0 ? calendarWeeks : SCHOOL_TOTAL_WEEKS;
    var raisedBySchedule = false;
    var clamped = false;
    if (maxWeek > totalWeeks) { totalWeeks = maxWeek; raisedBySchedule = true; }
    if (totalWeeks > MAX_WEEK) { totalWeeks = MAX_WEEK; clamped = true; }
    if (totalWeeks < 1) totalWeeks = SCHOOL_TOTAL_WEEKS;

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

    // ---------- 节次时间：本校 10 节（固定，逐节照抄上游）；课表用到第 11 节及以后时，在上一节下课后顺推（统一修订 H3） ----------
    var periodTimes = SCHOOL_PERIOD_TIMES.slice(0);
    var tableLength = periodTimes.length;
    var bySequence = [];
    var uncoveredFrom = 0;
    for (var p = tableLength + 1; p <= maxPeriod; p++) {
        var prevEnd = minutesOf(periodTimes[periodTimes.length - 1].end);
        // 课间 5 分钟、每节 45 分钟顺推；顺推越过 23:59 就停，这一节起不再补
        var nextStart = prevEnd + EXTEND_BREAK_MINUTES;
        var nextEnd = nextStart + EXTEND_CLASS_MINUTES;
        if (nextEnd > 23 * 60 + 59) { uncoveredFrom = p; break; }
        periodTimes.push({ periodIndex: p, start: hhmmOf(nextStart), end: hhmmOf(nextEnd) });
        bySequence.push(p);
    }


    // ---------- warnings（顺序固定：算出来的、猜出来的、丢掉的都要说清楚） ----------
    warn(
        '只导入了教务系统当前选中的学期（' + name0 +
        '）；要导入别的学期，请在教务页面里切到那个学期再点「提取课表」'
    );

    if (calendar.firstIso) {
        warn('开学日期取自教务系统的学期周次校历：第 1 周从 ' + start.iso + ' 开始，请在学期管理里核对');
    } else if (calendar.rejectedIso) {
        warn(
            '教务校历给出的开学日期（' + calendar.rejectedIso + '）不属于这个学期，已忽略；第 1 周按「' +
            start.rule + '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    } else {
        warn(
            '教务系统没有给出开学日期，第 1 周按「' + start.rule +
            '」推算为 ' + start.iso + '，请在学期管理里核对成学校实际开学日'
        );
    }

    if (raisedBySchedule && calendarWeeks > 0) {
        warn(
            '教务校历写的一学期是 ' + calendarWeeks + ' 周，课表里有第 ' + maxWeek + ' 周的课，已按 ' +
            totalWeeks + ' 周导入（否则第 ' + (calendarWeeks + 1) + ' 周起的课放不下）'
        );
    } else if (raisedBySchedule) {
        warn(
            '课表里有第 ' + maxWeek + ' 周的课，超过 ' + SCHOOL_TOTAL_WEEKS + ' 周，学期总周数已按 ' +
            totalWeeks + ' 周导入，如与实际不符可在学期管理里改'
        );
    } else if (calendarWeeks > 0) {
        warn(
            '学期总周数取自教务校历（' + totalWeeks + ' 周）' +
            (clamped ? '，已按最多 ' + MAX_WEEK + ' 周导入' : '') + '，如与实际不符可在学期管理里改'
        );
    } else if (calendarRejected) {
        warn(
            '教务校历不属于这个学期（见上一条），学期总周数按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    } else {
        warn(
            '教务系统没有给出学期校历，学期总周数按 ' + SCHOOL_TOTAL_WEEKS +
            ' 周导入（课表里最晚排到第 ' + maxWeek + ' 周），如与实际不符可在学期管理里改'
        );
    }

    // 节次时间没有从教务系统取（本校不请求节次时间），按本校固定的 10 节导入，这一点每次都说清楚
    var lastSlot = SCHOOL_PERIOD_TIMES[SCHOOL_PERIOD_TIMES.length - 1];
    warn(
        '节次时间没有从教务系统取，已按本校固定的 ' + SCHOOL_PERIOD_TIMES.length + ' 节时间导入（第 1 节 ' +
        SCHOOL_PERIOD_TIMES[0].start + '-' + SCHOOL_PERIOD_TIMES[0].end + '、第 ' + lastSlot.periodIndex + ' 节 ' +
        lastSlot.start + '-' + lastSlot.end + '），与学校实际不符时请在学期管理里核对'
    );
    if (bySequence.length) {
        warn(
            '课表用到了' + sectionsText(bySequence) + '，本校固定的节次时间没有覆盖，' +
            '已按上一节下课后课间 5 分钟、每节 45 分钟顺推补上，请在学期管理里核对'
        );
    }
    if (uncoveredFrom) {
        warn(
            '课表用到了第 ' + uncoveredFrom + ' 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上'
        );
    }

    // 连堂特殊时间：这几门课已按节次导入，但学校给指定场地的第 3-4 节、第 7-8 节另排了上课时间，课表里显示的节次时间会有出入
    if (specialNames.length) {
        var specialShown = [];
        for (var sn = 0; sn < specialNames.length && sn < 3; sn++) specialShown.push(shortName(specialNames[sn]));
        var rangeTexts = [];
        var blockTexts = [];
        for (var sb = 0; sb < SPECIAL_BLOCKS.length; sb++) {
            var block = SPECIAL_BLOCKS[sb];
            var rangeText = '第 ' + block.start + '-' + block.end + ' 节';
            rangeTexts.push(rangeText);
            blockTexts.push(rangeText + ' ' + block.from + '-' + block.to);
        }
        warn(
            '有 ' + specialNames.length + ' 门课（例如 ' + specialShown.join('、') + '）在' +
            SPECIAL_VENUES.venueText +
            '上' + rangeTexts.join('或') + '：学校给这两段连堂另排了上课时间（' + blockTexts.join('、') +
            '），与课表里显示的节次时间略有出入，请以学校实际为准'
        );
    }

    // 取数是否取全：正方这个接口一次性返回整学期排课，本来没有分页；但响应里带了记录总数时
    // 必须对账 —— 取到的比总数少说明响应被截断/被挡了，要出声（手册：取不全要说）
    var reportedTotal = intOf(data.total);
    if (reportedTotal !== null && reportedTotal > rows.length) {
        warn(
            '教务系统说这个学期有 ' + reportedTotal + ' 条排课记录，实际只取到 ' + rows.length +
            ' 条，课表可能不完整，请重试或反馈'
        );
    }

    // 集中实践课：教务单独给的一批课，只有课名与起止周，没有星期节次，排不进周课表 —— 但不能吞掉
    var practiceNames = [];
    for (var q = 0; q < practiceRows.length; q++) {
        var practiceName = text(practiceRows[q] && practiceRows[q].kcmc);
        if (practiceName && practiceNames.indexOf(practiceName) < 0) practiceNames.push(practiceName);
    }
    if (practiceNames.length) {
        var shownNames = [];
        for (var pn = 0; pn < practiceNames.length && pn < 3; pn++) {
            shownNames.push(shortName(practiceNames[pn]));
        }
        var shown = shownNames.join('、');
        if (practiceNames.length > 3) shown = shown + ' 等';
        warn(
            '教务系统另外给了 ' + practiceNames.length + ' 门集中实践课（' + shown +
            '）：它们没有固定的星期与节次，排不进周课表，请自行在学期里添加'
        );
    }

    var skipped = missing.name + missing.day + missing.period + missing.week;
    if (skipped > 0) {
        var reasons = [];
        if (missing.name) reasons.push('缺课程名 ' + missing.name + ' 行');
        if (missing.day) reasons.push('缺星期（或星期不在 1-7）' + missing.day + ' 行');
        if (missing.period) reasons.push('缺节次（或节次超出 1-' + MAX_PERIOD + ' 节）' + missing.period + ' 行');
        if (missing.week) reasons.push('缺周次（或周次全超出 1-' + MAX_WEEK + ' 周）' + missing.week + ' 行');
        if (weekSamples.length) {
            var sampleTexts = [];
            for (var ws = 0; ws < weekSamples.length; ws++) sampleTexts.push(shortName(weekSamples[ws]));
            reasons.push('认不出的周次写法如「' + sampleTexts.join('」「') + '」');
        }
        warn(
            '有 ' + skipped + ' 行课表数据不全（' + reasons.join('、') +
            '），已跳过：教务数据不完整时会出现，如发现少课请反馈'
        );
    }
    // 缺教师 / 缺教室：课照常导入（对应项为空），但按类型汇总计数说出来，不静默
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
    if (sparseRows > 0) {
        warn(
            '有 ' + sparseRows + ' 行课表的节次写成了多段（例如「1-2,5-6」），已按最大跨度放入' +
            '（中间几节也算上），请核对'
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
                firstDay: start.iso,
                totalWeeks: totalWeeks,
                periodTimes: periodTimes,
                courses: payloadCourses
            }
        ]
    });
})()
