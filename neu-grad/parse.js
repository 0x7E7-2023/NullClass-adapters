(function () {
    // 东北大学（研究生）教务适配器（金智教育研究生系统 gsapp 平台）—— 原始数据 → 空课课表载荷
    //
    // 移植自 shiguang_warehouse 的 NEU/neuyjs.js（MIT，上游作者 Vera-zero）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //
    // 这一段是纯转换（不碰 DOM、不发请求），能在 CI 里用 Rhino 跑回归。
    //
    // 移植改动（与上游的语义差异）：
    //   ① 周次：上游 parseWeeks(ZCBH) 直接产出显式周次数组（'1' 的位置 = 上课周），
    //      原样存进 courses[].weeks，导入时按数组逐周画格子。空课载荷要的是
    //      (startWeek, endWeek, weekType)，这里排序去重后切成极大段：步长 1 记 ALL，
    //      步长 2 记 ODD/EVEN，落单一周单独成段（移植手册 §4.1）。上游没有这一层，
    //      不存在「丢周」的风险——位串本身就是显式的，不需要像文本周次那样解析。
    //   ② 学期：上游靠用户手输学年 + 手选学期，两者都没有校验来源，选错学期整张课表
    //      就是别的学期的。这里在 extract.js 里按本机日期推算（同一套猜测规则），
    //      推算结果**总是**进 warnings——上游没有「当前学期」接口可以验证它，
    //      不像本科 neu 那样能先查接口、查不到才猜。
    //   ③ 开学日：上游的 config **完全没有** semesterStartDate 字段（对比本科 neu，
    //      那边至少有校历接口可以尽力而为）。这里只能按「最近的周一」推算，
    //      **必然**写进 warnings（手册 §4.2：推算值和真值长得一样，必须如实说明）。
    //   ④ 每周起始日：上游 config.firstDayOfWeek 硬编码为 7（周日）。空课的载荷靠
    //      firstDay 的星期几决定列对齐，而 XQ 字段是**绝对**星期（1 = 周一，与本科
    //      neu 的 dayOfWeek 同义，金智体系通用口径）——若照抄把 firstDay 退到周日，
    //      整学期的课会偏。这里不采用 firstDayOfWeek=7，firstDay 统一推算到周一
    //      （详见 AUDIT.md）。
    //   ⑤ 总周数：上游 config.semesterTotalWeeks 硬编码为 18（该校研究生学期的经验值，
    //      没有接口数据支持）。这里把 18 当**兜底**，实际观测到的周次（ZCBH 位串长度 /
    //      课表里出现的最大周）比 18 大就用观测值，避免把真实存在的课裁掉。
    //   ⑥ 作息时间：上游的 jcList（DM/KSSJ/JSSJ）**是教务接口自己返回的**，不是像
    //      本科 neu 那样需要额外请求或猜——这一点上游反而更简单，原样映射即可。
    //   ⑦ 自定义时间 isCustomTime：上游字段固定写 false、从不使用，没有移植的必要
    //      （空课载荷没有这个概念，见移植手册 §4.4，这里连该字段都不产出）。
    var data = JSON.parse(typeof __ncInput !== 'undefined' ? __ncInput : '{}');
    var jgList = Object.prototype.toString.call(data.jgList) === '[object Array]' ? data.jgList : [];
    var jcList = Object.prototype.toString.call(data.jcList) === '[object Array]' ? data.jcList : [];
    var term = data.term || {};

    var MAX_WEEKS = 30;
    var FALLBACK_WEEKS = 18; // 上游 config.semesterTotalWeeks 的硬编码经验值，当兜底
    var MAX_WARNINGS = 20;
    var MAX_WARNING_CHARS = 200;
    var KEY_SEP = String.fromCharCode(0);

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

    // KSSJ / JSSJ 是形如 830、1650 的整数（时*100+分），上游 formatTime 就是这么拆的。
    // 越界（小时>23 或分钟>59）一律判非法，绝不写进 periodTimes（规范 §4：非法时间
    // 会让整个载荷被拒，宁可不要这一节）。
    function hhmmFromInt(value) {
        var n = intOf(value);
        if (n === null || n < 0) return null;
        var h = Math.floor(n / 100);
        var mi = n % 100;
        if (h > 23 || mi > 59) return null;
        return pad2(h) + ':' + pad2(mi);
    }

    function clip(value) {
        var s = String(value);
        return s.length > MAX_WARNING_CHARS ? s.substring(0, MAX_WARNING_CHARS - 3) + '...' : s;
    }

    function sampleOf(list, limit) {
        var shown = [];
        for (var i = 0; i < list.length && i < limit; i++) shown.push(list[i]);
        var s = shown.join('、');
        if (list.length > limit) s += ' 等 ' + list.length + ' 处';
        return s;
    }

    // 'yyyy-MM-dd' → 该日期所在周的周一（含当天）。输入是 extract.js 捕获的「提取时刻」
    // 日期（term.extractedOn），不在这里调 new Date()——parse.js 要在 CI 里被 Rhino
    // 对同一份 fixture 反复重放，必须是纯函数（规范 §5.2），日期只能从输入来。
    function mondayOnOrBefore(iso) {
        var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
        if (!match) return null;
        var year = parseInt(match[1], 10);
        var month = parseInt(match[2], 10);
        var day = parseInt(match[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        if (isNaN(date.getTime())) return null;
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
            return null;
        }
        var offset = (date.getUTCDay() + 6) % 7;
        var monday = new Date(date.getTime() - offset * 86400000);
        return monday.getUTCFullYear() + '-' + pad2(monday.getUTCMonth() + 1) + '-' + pad2(monday.getUTCDate());
    }

    function isBitString(s) {
        return /^[01]+$/.test(s);
    }

    // item.ZCBH 是「第 i 位 = 第 i+1 周」的位串（上游 parseWeeks 的原始编码）。
    // 调用方先用 isBitString 判过合法性，这里只管把 '1' 的位置转成周次。
    function weeksFromBits(bits) {
        var weeks = [];
        for (var i = 0; i < bits.length; i++) {
            if (bits.charAt(i) === '1') weeks.push(i + 1);
        }
        return weeks;
    }

    // 周次集合（升序去重）→ 极大段：步长 1 记 ALL，步长 2 记 ODD/EVEN，落单一周单独成段
    // （移植手册 §4.1）。位串本身已经升序去重，这里仍然按通用算法切，不假设输入干净。
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

    // 学期代码形如 20261（4 位起始学年 + 1 位学期号）→「2026-2027学年第一学期」。
    // 上游没有学期名，只能自己拼；不用适配器名当学期名（移植手册 §4.7）。
    function termNameFrom(code) {
        var match = /^(\d{4})(\d)$/.exec(String(code));
        if (!match) return '';
        var startYear = parseInt(match[1], 10);
        var index = parseInt(match[2], 10);
        var label = index === 1 ? '第一学期' : (index === 2 ? '第二学期' : ('第' + index + '学期'));
        return startYear + '-' + (startYear + 1) + '学年' + label;
    }

    var warnings = [];
    var badBits = [];
    var skipped = 0;
    var droppedWeeks = 0;

    var order = [];
    var byCourse = {};
    var maxWeek = 0;
    var maxBits = 0;
    var maxEndPeriod = 0;

    function clampWeeks(weeks) {
        var kept = [];
        for (var i = 0; i < weeks.length; i++) {
            if (weeks[i] <= MAX_WEEKS) kept.push(weeks[i]);
            else droppedWeeks++;
        }
        return kept;
    }

    for (var i = 0; i < jgList.length; i++) {
        var row = jgList[i] || {};
        var name = text(row.KCMC);
        var teacher = text(row.JGJSXM) || null;
        var location = text(row.JASMC) || null;
        var day = intOf(row.XQ);
        var startPeriod = intOf(row.KSJCDM);
        var endPeriod = intOf(row.JSJCDM);
        var bits = text(row.ZCBH);

        // 完全空白的占位行（课名 / 星期 / 周次位串都没有）不算「被丢掉的课」
        if (!name && !day && !bits) continue;

        var bitsValid = isBitString(bits);
        var rawWeeks = bitsValid ? weeksFromBits(bits) : [];
        if (rawWeeks.length && bits.length > maxBits) maxBits = bits.length;

        if (bits && !bitsValid) {
            // 非纯 0/1 的位串认不出来（与「合法但全零 = 这门课这学期没有排任何一周」区分开，
            // 后者不是脏数据，只是走通用的「没有周次」分支，不进 badBits）
            badBits.push(bits);
            skipped++;
            continue;
        }

        var weeks = clampWeeks(rawWeeks);
        if (!weeks.length) {
            skipped++;
            continue;
        }

        if (!name || !(day >= 1 && day <= 7) || !(startPeriod >= 1) || !(endPeriod >= startPeriod)) {
            skipped++;
            continue;
        }
        if (endPeriod > maxEndPeriod) maxEndPeriod = endPeriod;

        var key = name + KEY_SEP + (teacher || '');
        if (!byCourse[key]) {
            byCourse[key] = { name: name, teacher: teacher, note: null, blocks: [] };
            order.push(key);
        }

        var runs = runsOf(weeks);
        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            if (run.end > maxWeek) maxWeek = run.end;
            byCourse[key].blocks.push({
                dayOfWeek: day,
                startPeriod: startPeriod,
                endPeriod: endPeriod,
                startWeek: run.start,
                endWeek: run.end,
                weekType: run.weekType,
                location: location
            });
        }
    }

    var termCode = text(term.code);
    if (order.length === 0) {
        var hint = droppedWeeks > 0
            ? '：课表里的周次都超过了 ' + MAX_WEEKS + ' 周（课表数据的上限），放不进空课'
            : '：可能是还没排课，或教务系统改了课表的数据格式。请在教务页面里确认课表已经显示出来再重试';
        throw new Error('没解析到任何课程' + (termCode ? '（学期代码 ' + termCode + '）' : '') + hint);
    }

    // ---- 作息时间：jcList 的 DM / KSSJ / JSSJ 是教务接口自己给的，原样映射 --------
    function periodTimesFrom(list) {
        var out = [];
        var seen = {};
        var bad = 0;
        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            var index = intOf(item.DM);
            var start = hhmmFromInt(item.KSSJ);
            var end = hhmmFromInt(item.JSSJ);
            if (!(index >= 1) || index > MAX_WEEKS || !start || !end || !(start < end) || seen[index]) {
                if (item.DM !== undefined || item.KSSJ !== undefined) bad++;
                continue;
            }
            seen[index] = true;
            out.push({ periodIndex: index, start: start, end: end });
        }
        out.sort(function (a, b) { return a.periodIndex - b.periodIndex; });
        return { times: out, bad: bad };
    }

    var table = periodTimesFrom(jcList);
    var periodTimes = table.times;
    var periodNote = null;

    if (!periodTimes.length) {
        periodNote = '作息时间未能从教务获取，节次时间将使用空课的默认值，请在学期设置里核对';
    } else if (maxEndPeriod > periodTimes[periodTimes.length - 1].periodIndex) {
        periodNote = '教务的作息表只到第 ' + periodTimes[periodTimes.length - 1].periodIndex +
            ' 节，课表里却用到第 ' + maxEndPeriod + ' 节，已改用空课的默认节次时间，请在学期设置里核对';
        periodTimes = [];
    } else if (table.bad > 0) {
        periodNote = '教务作息表里有 ' + table.bad + ' 个节次的时间认不出来，已跳过，请在学期设置里核对';
    }

    // ---- 学期元信息 ----------------------------------------------------------
    // 学期代码没有接口可以核验，只要是 extract.js 猜出来的就必须说明（见头部改动 ②）
    if (text(term.source) === 'guess') {
        warnings.push('学期代码 ' + termCode + ' 是按本机日期推算的（教务没有可查询的「当前学期」接口），请核对导入的是不是本学期');
    }
    if (periodNote) warnings.push(periodNote);

    // 开学日没有任何数据来源，永远按「提取时刻所在周的周一」推算（见头部改动 ③）。
    // extractedOn 缺失/非法说明 extract.js 没按契约填字段，属于内部数据异常，直接拒绝
    // 而不是悄悄拿一个不知道对不对的日期垫上——这种输入不该在真实流程里出现。
    var firstDay = mondayOnOrBefore(text(term.extractedOn));
    if (!firstDay) {
        throw new Error('输入缺少有效的 extractedOn（提取时刻日期），无法推算开学日：内部数据异常');
    }
    warnings.push('开学日期无法从教务获取，已按最近的周一推算，请在学期管理里核对');

    // 总周数：位串长度（= 教务眼里的学期周数）优先；拿不到就退到观测到的最大周。
    // 上游 config.semesterTotalWeeks=18 当兜底下限——只有前几周的课不该把总周数
    // 直接截到那几周（学期本来就更长，后面的周只是这份课表没排课）。
    var totalWeeks = maxBits > 0 ? maxBits : maxWeek;
    if (!(totalWeeks >= 1)) totalWeeks = FALLBACK_WEEKS;
    if (totalWeeks < FALLBACK_WEEKS) totalWeeks = FALLBACK_WEEKS;
    if (totalWeeks < maxWeek) totalWeeks = maxWeek;
    if (totalWeeks > MAX_WEEKS) totalWeeks = MAX_WEEKS;

    if (droppedWeeks > 0) {
        warnings.push('有 ' + droppedWeeks + ' 个周次超出 ' + MAX_WEEKS + ' 周（课表数据的上限），没有导入');
    }
    if (skipped > 0) {
        warnings.push('有 ' + skipped + ' 条排课记录缺少课名、星期、节次或周次，没有导入');
    }
    if (badBits.length) {
        warnings.push('有 ' + badBits.length + ' 段周次位串认不出来（' + sampleOf(badBits, 3) + '），相关排课没有导入');
    }

    var clipped = [];
    for (var k = 0; k < warnings.length && k < MAX_WARNINGS; k++) clipped.push(clip(warnings[k]));

    var courses = [];
    for (var c = 0; c < order.length; c++) courses.push(byCourse[order[c]]);

    var termName = termNameFrom(termCode) || '教务导入';

    var termPayload = { name: termName, firstDay: firstDay, totalWeeks: totalWeeks };
    if (periodTimes.length) termPayload.periodTimes = periodTimes;
    termPayload.courses = courses;

    return JSON.stringify({
        specVersion: 1,
        kind: 'schedule',
        ocrAssisted: false,
        warnings: clipped,
        terms: [termPayload]
    });
})()
