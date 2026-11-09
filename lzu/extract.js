(function () {
    // 兰州大学本科生教务适配器（URP 系 jwk.lzu.edu.cn/academic）—— 第一步：只取数，把当前课表页的结构交出去。
    //
    // 移植自 shiguang_warehouse 的 LZU/lzu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 yalerove）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-09 与 origin/main 对齐）
    //   本校脚本最后一次修改 63e312d（2026-09-04）
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① 上游是「拾光」的整段流程（弹窗确认、四套策略、周次与节次解析、合并去重、存节次时间、showToast）；
    //      这里只把课表页的结构交出去，解析、周次、节次、合并、开学日、总周数、提醒全部挪到 parse.js（CI 里能真跑）
    //   ② 交出去四种结构：表头节次时间、含星期表头的课表表格、td[id*="_"] 里的课程格（URP 标准网格）、
    //      与课表有关的表格行和正文行；策略选择与字段拼装都在 parse.js
    //   ③ iframe / frame 同源递归穿透照上游；跨域框架读不到就跳过（不报错）
    //   ④ 不读、不存、不发任何账号信息；交出去的每一行先过一遍：出现学号 / 姓名 / 身份证 / 手机号等字样的行整行不交，
    //      含星期表头之外的表格（例如学生信息表）不交，正文也只交与课表有关的行（上游是把整页 innerText 拿去解析）
    //   ⑤ 登录页判断：页面上有密码输入框就直接报错，不发请求、不读它的值
    //   ⑥ 不发任何网络请求：本校课表就在当前页面与同源框架里，没有 JSON 课表接口
    //   ⑦ 上游的 showAlert / showToast / console 输出与「拾光」的桥调用（saveImportedCourses / savePresetTimeSlots /
    //      saveCourseConfig / notifyTaskCompletion）全部不移植
    //
    // 输出：{ today, headerSlots, tables, urpCells, listRows, textLines, truncated }
    //   headerSlots —— 表头里带节次时间的 th：[{ id, text }]，由 parse.js 认节次号与起止时间
    //   tables      —— 只放含「周一..周日」表头的表：[{ rows: [ [ { id, lines } ] ] }]，lines 是按 <br> 分好的行
    //   urpCells    —— td[id*="_"] 里的 .class_div > p 文本：[{ id, divs: [ [文本] ] }]
    //   listRows    —— 与课表有关的 tr（含它前面那行课程信息行）：[ [单元格文本] ]
    //   textLines   —— 与课表有关的正文行（含学期名那一行）：[文本]
    //   truncated   —— 页面过大被截断时交 true，由 parse.js 提醒

    var MAX_LINE = 300;          // 单个格子里一行文字最多带出的字数
    var MAX_TABLES = 30;         // 最多看 30 张表
    var MAX_TABLE_ROWS = 400;    // 单张表最多 400 行
    var MAX_TEXT_LINES = 4000;   // 正文最多 4000 行
    var MAX_LIST_ROWS = 1200;    // 表格行最多 1200 行
    var MAX_URP_TDS = 500;       // td[id*="_"] 最多看 500 个
    var MAX_DIVS = 12;           // 一个课程格里最多 12 个 .class_div
    var MAX_PS = 12;             // 一个 .class_div 里最多 12 个 p
    var MAX_DOCS = 8;            // 最多穿透 8 层/个同源框架
    var MAX_HEADER_SLOTS = 40;   // 表头节次最多 40 条
    // 关键词后面必须跟冒号才是「学号：…」这类字段名；「民族理论与民族政策」「性别与社会」这种课名不能被当成个人信息删掉
    var PII_LINE = /(学号|姓名|身份证|手机号|考生号|准考证|性别|籍贯|民族|政治面貌|出生日期)\s*[:：]/;
    var PII_BARE = /^[0-9]{8,}[0-9Xx]?$/;
    var COURSEISH = /(周|星期|节|课程号|课程名|学时|讲课|教室|教师|学年)/;
    var DAYS = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    var NOT_IN_JW = '请先登录教务系统，打开「学生课表」页面后再点「提取课表」';
    var ON_LOGIN = '当前打开的是登录页。请先登录教务系统，打开「学生课表」页面后再点「提取课表」';

    var truncated = false;

    function asText(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function squash(value) {
        return asText(value).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    function pad2(value) {
        return (value < 10 ? '0' : '') + value;
    }

    // 个人信息与超长行都在这一个出口处理：带个人信息字样的行整行不交，超长的截断并记下 truncated
    function safeLine(value) {
        var line = squash(value);
        if (!line || PII_LINE.test(line) || PII_BARE.test(line)) return '';
        if (line.length > MAX_LINE) {
            truncated = true;
            line = line.substring(0, MAX_LINE);
        }
        return line;
    }

    // 自己或任何一层祖先被隐藏 / 没渲染出来（祖先 display:none 时 getClientRects 为空）
    function hiddenElement(node) {
        if (!node || node.nodeType !== 1) return false;
        var tag = String(node.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
        try {
            if (node.getAttribute) {
                if (node.getAttribute('hidden') !== null) return true;
                if (String(node.getAttribute('aria-hidden')).toLowerCase() === 'true') return true;
            }
        } catch (e) { }
        try {
            var style = node.style || {};
            if (String(style.display).toLowerCase() === 'none') return true;
            if (String(style.visibility).toLowerCase() === 'hidden') return true;
        } catch (e) { }
        try {
            var view = node.ownerDocument && node.ownerDocument.defaultView;
            var computed = view && view.getComputedStyle ? view.getComputedStyle(node) : null;
            if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return true;
        } catch (e) { }
        try {
            if (node.getClientRects && node.getClientRects().length === 0) return true;
        } catch (e) { }
        return false;
    }

    // 逐个子节点取看得见的文字：<br> 当换行，隐藏元素整棵跳过
    function visibleText(node, out) {
        var children = node && node.childNodes ? node.childNodes : [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 3) { out.push(String(child.nodeValue || '')); continue; }
            if (child.nodeType !== 1) continue;
            if (String(child.tagName || '').toUpperCase() === 'BR') { out.push('\n'); continue; }
            if (hiddenElement(child)) continue;
            visibleText(child, out);
        }
        return out;
    }

    function decodeSeg(value) {
        return asText(value)
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    }

    // 一个格子的文字：有 <br> 就按 <br> 分行（上游同做法），没有整格当一行（保留嵌套 span 之间的空格）
    function linesOf(cell) {
        var out = [];
        if (!cell) return out;
        if (hiddenElement(cell)) return out;
        var pieces = visibleText(cell, []).join('').split('\n');
        for (var i = 0; i < pieces.length; i++) {
            var line = safeLine(pieces[i]);
            if (line) out.push(line);
        }
        return out;
    }

    function dayOf(value) {
        var key = squash(value).replace(/星期|礼拜|周/g, '');
        return DAYS[key] || 0;
    }

    // 表头格可能有两行（「周一」+ 日期），逐行认
    function dayOfLines(lines) {
        for (var i = 0; i < lines.length; i++) {
            var day = dayOf(lines[i]);
            if (day) return day;
        }
        return 0;
    }

    // 同源 iframe / frame 递归穿透（上游 allDocuments 的做法）；跨域框架取 contentDocument 会抛错，跳过
    function allDocuments() {
        var docs = [];
        var walk = function (doc) {
            if (!doc || docs.length >= MAX_DOCS) return;
            for (var i = 0; i < docs.length; i++) {
                if (docs[i] === doc) return;
            }
            docs.push(doc);
            var frames;
            try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
            for (var j = 0; j < frames.length; j++) {
                try {
                    if (frames[j].contentDocument) walk(frames[j].contentDocument);
                } catch (e) { /* 跨域框架读不到，跳过 */ }
            }
        };
        walk(document);
        return docs;
    }

    function collectHeaderSlots(docs) {
        var out = [];
        for (var d = 0; d < docs.length; d++) {
            var ths;
            try { ths = docs[d].querySelectorAll('th'); } catch (e) { continue; }
            for (var i = 0; i < ths.length && out.length < MAX_HEADER_SLOTS; i++) {
                var id = asText(ths[i].id);
                var line = safeLine(visibleText(ths[i], []).join(''));
                if (!line) continue;
                if (id.indexOf('0_') !== 0 && !/第[0-9]{1,2}节/.test(line)) continue;
                if (!/[0-9]{1,2}:[0-5][0-9]/.test(line)) continue;
                out.push({ id: id, text: line });
            }
        }
        return out;
    }

    function hasDayHeader(rows) {
        for (var r = 0; r < rows.length; r++) {
            var count = 0;
            for (var c = 0; c < rows[r].length; c++) {
                if (dayOfLines(rows[r][c].lines)) count++;
            }
            if (count >= 5) return true;
        }
        return false;
    }

    // 只交含星期表头的表：学生信息表、成绩表之类不会命中
    function collectTables(docs) {
        var tables = [];
        for (var d = 0; d < docs.length && tables.length < MAX_TABLES; d++) {
            var ts;
            try { ts = docs[d].querySelectorAll('table'); } catch (e) { continue; }
            for (var i = 0; i < ts.length && tables.length < MAX_TABLES; i++) {
                var trs;
                try { trs = ts[i].querySelectorAll('tr'); } catch (e) { continue; }
                if (trs.length > MAX_TABLE_ROWS) truncated = true;
                var rows = [];
                for (var r = 0; r < trs.length && r < MAX_TABLE_ROWS; r++) {
                    var cells = [];
                    var tds;
                    try { tds = trs[r].querySelectorAll('td, th'); } catch (e) { tds = []; }
                    for (var c = 0; c < tds.length; c++) {
                        cells.push({ id: asText(tds[c].id), lines: linesOf(tds[c]) });
                    }
                    rows.push(cells);
                }
                if (!hasDayHeader(rows)) continue;
                if (tables.length >= MAX_TABLES) { truncated = true; break; }
                tables.push({ rows: rows });
            }
        }
        return tables;
    }

    function collectUrpCells(docs) {
        var out = [];
        var seen = 0;
        for (var d = 0; d < docs.length; d++) {
            var tds;
            try { tds = docs[d].querySelectorAll('td'); } catch (e) { continue; }
            for (var i = 0; i < tds.length; i++) {
                if (seen >= MAX_URP_TDS) { truncated = true; break; }
                seen++;
                var id = asText(tds[i].id);
                if (id.indexOf('_') < 0) continue;
                var divs = [];
                var homes;
                try { homes = tds[i].querySelectorAll('.class_div'); } catch (e) { homes = []; }
                for (var j = 0; j < homes.length && divs.length < MAX_DIVS; j++) {
                    var ps;
                    try { ps = homes[j].querySelectorAll('p'); } catch (e) { ps = []; }
                    var texts = [];
                    for (var k = 0; k < ps.length && texts.length < MAX_PS; k++) {
                        var line = safeLine(visibleText(ps[k], []).join(' '));
                        if (line) texts.push(line);
                    }
                    if (texts.length) divs.push(texts);
                }
                if (divs.length) out.push({ id: id, divs: divs });
            }
        }
        return out;
    }

    function rowText(tr) {
        var texts = [];
        var tds;
        try { tds = tr.querySelectorAll('td, th'); } catch (e) { tds = []; }
        for (var i = 0; i < tds.length; i++) {
            var lines = linesOf(tds[i]);
            var line = lines.length ? squash(lines.join(' ')) : safeLine(visibleText(tds[i], []).join(' '));
            if (line) texts.push(line);
        }
        return texts;
    }

    // 一行里是否同时有「课程号样式」和「非数字文字」：学生信息表的纯数字 / 身份证号行不会命中
    function looksCourseInfo(value) {
        var tokens = squash(value).split(' ');
        var hasCode = false;
        var hasText = false;
        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (!token) continue;
            if (/^[0-9]{3,}[A-Za-z]*(\([0-9]+\))?$/.test(token) && token.length <= 12) hasCode = true;
            else if (/[^0-9.\-]/.test(token)) hasText = true;
        }
        return hasCode && hasText;
    }

    // 只有纯数字的长串（身份证号、手机号、学号）不是课表内容
    function bareNumber(value) {
        return /^[0-9]{8,}[0-9Xx]?$/.test(squash(value));
    }

    // 表格行：课表有关的行（含 周/星期/节 等）以及它前面那行课程信息行（课程号 + 课名 + 教师可能不带周次）
    function collectRows(docs) {
        var rows = [];
        for (var d = 0; d < docs.length; d++) {
            var trs;
            try { trs = docs[d].querySelectorAll('tr'); } catch (e) { continue; }
            for (var i = 0; i < trs.length && rows.length < MAX_LIST_ROWS; i++) {
                rows.push(rowText(trs[i]));
            }
            if (rows.length >= MAX_LIST_ROWS) { truncated = true; break; }
        }
        var kept = [];
        for (var r = 0; r < rows.length; r++) {
            var here = squash(rows[r].join(' '));
            var next = r + 1 < rows.length ? squash(rows[r + 1].join(' ')) : '';
            if (here && COURSEISH.test(here)) { kept.push(rows[r]); continue; }
            if (here && next && COURSEISH.test(next) && looksCourseInfo(here)) kept.push(rows[r]);
        }
        return kept;
    }

    function collectText(docs) {
        var lines = [];
        for (var d = 0; d < docs.length && lines.length < MAX_TEXT_LINES; d++) {
            var body = docs[d].body;
            var raw = '';
            try { raw = body && body.innerText ? String(body.innerText) : (body ? String(body.textContent) : ''); } catch (e) { raw = ''; }
            var parts = raw.replace(/\r\n|\r/g, '\n').split('\n');
            for (var i = 0; i < parts.length && lines.length < MAX_TEXT_LINES; i++) {
                var line = safeLine(parts[i]);
                if (line && !bareNumber(line)) lines.push(line);
            }
        }
        if (lines.length >= MAX_TEXT_LINES) truncated = true;
        var kept = [];
        for (var k = 0; k < lines.length; k++) {
            var next = k + 1 < lines.length ? lines[k + 1] : '';
            if (COURSEISH.test(lines[k])) kept.push(lines[k]);
            else if (next && COURSEISH.test(next) && looksCourseInfo(lines[k])) kept.push(lines[k]);
        }
        return kept;
    }

    var loginFields = document.querySelectorAll ? document.querySelectorAll('input[type="password"]') : [];
    if (loginFields && loginFields.length > 0) {
        return Promise.reject(new Error(ON_LOGIN));
    }
    if (!document.body) {
        return Promise.reject(new Error(NOT_IN_JW));
    }

    var now = new Date();
    var today = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    var docs = allDocuments();

    return JSON.stringify({
        today: today,
        headerSlots: collectHeaderSlots(docs),
        tables: collectTables(docs),
        urpCells: collectUrpCells(docs),
        listRows: collectRows(docs),
        textLines: collectText(docs),
        truncated: truncated
    });
})()
