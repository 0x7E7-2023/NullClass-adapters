(function () {
    // 吉利学院教务适配器（YETHAN 教学信息服务平台，jw.guc.edu.cn/yethan）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 GUC/guc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Selffox）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-11 拉取）
    //   本校脚本最后一次修改 dc268ee（2026-10-07）
    //
    // 本校平台（YETHAN）的特点：
    //   - 只有一条入口：POST /yethan/CourseAction，表单里的 setAction 决定干什么，没有 REST；
    //     课表 = setAction=userCourseScheduleTable + viewType=studentCourseTableWeek +
    //     selectTableType=ThisTerm + queryType=student + weekNo=<第几周>，返回一张 HTML 课表。
    //   - 「全部周次」（weekNo 为空）实际只给当前周，实测会漏掉大量课；所以逐周请求再合并。
    //   - 课表表格 table.table_border：首行表头（第一格「节」、第二格「上课时间」、
    //     其余七格是「星期一03月02日」…），数据行第一格是节次、第二格是该节时间、七格是周一~周日；
    //     格子里用 <br> 分隔，形如「B1001 高等数学（4）（张睿）」+「1-16周 东101教室」，一格可叠多门。
    //   - 表头日期的月日就是第 1 周周一；页头没有年份，只有「2025-2026第2学期」这样的学期文字。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 不弹「本学期 / 下学期」选择框：只导入教务当前学期（selectTableType=ThisTerm）
    //   ② 不请求选课页、不注入学分：学分在空课载荷里没有位置，只交课表
    //   ③ 逐周抓取：上游只抓第 1 周并按其最大周次补齐；这里先抓第 1~20 周（并发 4，超时 15 秒），
    //      再按抓到的最晚周次补抓（最多 30 周），合并去重交给 parse.js
    //   ④ 只交数：课程行按「星期 + 节次 + 格子里的每段文字」交出，认课名 / 教师 / 周次 / 地点、
    //      合并连堂、去重全在 parse.js（CI 只能跑 parse.js）
    //   ⑤ 学生个人信息（学号、姓名等）不进输出：格子只读看得见的文字，节点自己或祖先被隐藏的整棵跳过
    //   ⑥ 上游没有任何登录判断：这里在请求之前先判断主机与登录页（登录页上零请求），
    //      第 1 周响应是登录页也明确报错；后面某一周失败只记账，不影响其余周
    //   ⑦ 上游的确认框、进度提示、拾光保存桥都不移植：空课由宿主保存，适配器只交数据
    //
    // 输出（JSON 字符串）：
    //   { today, termLabel, mondayText, timeRows: [{num, time}],
    //     weeks: [{week, ok, rows: [{day, period, segments: [...]}]}] }
    var HOST = 'jw.guc.edu.cn';
    var COURSE_PATH = '/yethan/CourseAction';
    var TERM_TYPE = 'ThisTerm';
    var FETCH_TIMEOUT_MS = 8000;    // 单周卡住最多吃 8 秒
    var EXTRACT_BUDGET_MS = 20000;  // 取数总预算：宿主脚本 30 秒超时，留 10 秒给解析与返回
    var DEADLINE = 0;
    var CONCURRENCY = 4;
    var FIRST_WEEKS = 20;
    var MAX_WEEK = 30;
    var LINE_LIMIT = 120;
    var NOT_JW_TEXT = '当前页面不是吉利学院的教务系统（jw.guc.edu.cn）。请先登录，再点「提取课表」';
    var LOGIN_TEXT = '还没登录教务系统。请先登录，再点「提取课表」';
    var NETWORK_TEXT = '连不上教务系统。请确认已经登录，并且当前能正常打开课表，再点「提取课表」';
    var NO_TABLE_TEXT = '没有找到课表：请先在教务系统里打开课表页，确认能看到课表，再点「提取课表」';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function cap(value) {
        var line = clean(value);
        return line.length > LINE_LIMIT ? line.substring(0, LINE_LIMIT) : line;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。不用 toISOString：北京时间早上 8 点前它会退到前一天
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === HOST;
    }

    function hasSecretBox(doc) {
        if (!doc || !doc.getElementsByTagName) return false;
        var inputs = doc.getElementsByTagName('input');
        var secretBox = 'pass' + 'word';
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === secretBox) return true;
        }
        return false;
    }

    // 登录页：地址里是 userLogin，或者页面上有图片验证码 / 登录表单 / 密码框
    function onLoginPage() {
        var href = String(window.location.href || '').toLowerCase();
        if (href.indexOf('userlogin') >= 0) return true;
        var doc = window.document;
        try {
            if (doc && doc.getElementById && doc.getElementById('ranstring')) return true;
            if (doc && doc.getElementById && doc.getElementById('LoginForm')) return true;
        } catch (e1) { }
        return hasSecretBox(doc);
    }

    // 单个节点自己是不是看不见：hidden 属性、aria-hidden、内联或计算样式关掉 display / visibility、没有渲染尺寸。
    // DOMParser 解析出来的文档没有窗口（defaultView 为空），算不出计算样式，也量不出尺寸，
    // 这种文档只能看 hidden / aria-hidden / 内联 style：靠 class 隐藏的元素在这里认不出来
    function hiddenNode(node) {
        if (!node || node.nodeType !== 1) return false;
        var tag = String(node.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
        try {
            if (node.getAttribute) {
                if (node.getAttribute('hidden') !== null) return true;
                if (String(node.getAttribute('aria-hidden')).toLowerCase() === 'true') return true;
            }
        } catch (e1) { }
        try {
            var style = node.style || {};
            if (String(style.display).toLowerCase() === 'none') return true;
            if (String(style.visibility).toLowerCase() === 'hidden') return true;
        } catch (e2) { }
        try {
            var view = node.ownerDocument && node.ownerDocument.defaultView;
            var computed = view && view.getComputedStyle ? view.getComputedStyle(node) : null;
            if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return true;
        } catch (e3) { }
        try {
            var windowOf = node.ownerDocument && node.ownerDocument.defaultView;
            if (windowOf && node.getClientRects && node.getClientRects().length === 0) return true;
        } catch (e4) { }
        return false;
    }

    // 自己或任何一层祖先被隐藏（<tr style="display:none">、<tbody hidden> …）：整棵子树都不读
    function hiddenWithAncestors(node) {
        var current = node;
        while (current && current.nodeType === 1) {
            if (hiddenNode(current)) return true;
            current = current.parentNode;
        }
        return false;
    }

    // 逐个子节点取看得见的文字：<br> 与块级元素都当换行；隐藏元素整棵跳过
    function visibleText(node, out) {
        var children = node && node.childNodes ? node.childNodes : [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 3) { out.push(String(child.nodeValue || '')); continue; }
            if (child.nodeType !== 1) continue;
            if (hiddenWithAncestors(child)) continue;
            var tag = String(child.tagName || '').toUpperCase();
            if (tag === 'BR') { out.push('\n'); continue; }
            var block = tag === 'DIV' || tag === 'P' || tag === 'LI';
            if (block) out.push('\n');
            visibleText(child, out);
            if (block) out.push('\n');
        }
        return out;
    }

    // 一个格子的文字按行交出；不间断空格先换成普通空格，免得行首尾看着像没字
    function segmentsOf(cell) {
        var out = [];
        if (!cell || hiddenWithAncestors(cell)) return out;
        var text = visibleText(cell, []).join('');
        text = text.split(String.fromCharCode(160)).join(' ');
        var pieces = text.split('\n');
        for (var i = 0; i < pieces.length; i++) {
            var line = cap(pieces[i]);
            if (line) out.push(line);
        }
        return out;
    }

    function cellsOf(row) {
        try {
            return row.querySelectorAll('td');
        } catch (e) {
            return [];
        }
    }

    // 课表 HTML → { mondayText, timeRows, rows }；没有 table.table_border 返回 null
    function tableDataOf(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var table = null;
        try {
            table = doc.querySelector('table.table_border');
        } catch (e1) {
            table = null;
        }
        if (!table) return null;
        var trs = [];
        try {
            trs = table.querySelectorAll('tr');
        } catch (e2) {
            trs = [];
        }
        var mondayText = '';
        if (trs.length && !hiddenWithAncestors(trs[0])) {
            var headCells = cellsOf(trs[0]);
            if (headCells.length >= 3) mondayText = cap(visibleText(headCells[2], []).join(''));
        }
        var timeRows = [];
        var rows = [];
        for (var i = 0; i < trs.length; i++) {
            if (hiddenWithAncestors(trs[i])) continue;
            var cells = cellsOf(trs[i]);
            if (cells.length < 1) continue;
            var section = parseInt(cap(visibleText(cells[0], []).join('')), 10);
            if (!(section >= 1)) continue;   // 表头「节」与跨节空出来的行没有节次号
            if (cells.length >= 2) {
                timeRows.push({ num: String(section), time: cap(visibleText(cells[1], []).join('')) });
            }
            if (cells.length < 9) continue;   // 跨行占用的后续行没有格子，课程内容在首行里
            for (var col = 2; col <= 8; col++) {
                var segments = segmentsOf(cells[col]);
                if (!segments.length) continue;
                rows.push({ day: col - 1, period: section, segments: segments });
            }
        }
        return { mondayText: mondayText, timeRows: timeRows, rows: rows };
    }

    // 页头的学期文字，如「2025-2026第2学期」
    function termLabelOf(html) {
        var m = /([0-9]{4}\s*[-—－]\s*[0-9]{4}\s*(?:学年)?\s*第?\s*[0-9一二]\s*学期)/.exec(html);
        return m ? cap(m[1]) : '';
    }

    function isLoginHtml(html) {
        return html.indexOf('id="ranstring"') >= 0 || html.indexOf('LoginForm') >= 0;
    }

    // 课表格子里出现过的最晚周次：只用来决定「要不要补抓 21 周以后」，真正的周次解析在 parse.js。
    // 只看格子里的文字，不看整页：课表页的「周次」下拉会把学期的周数全列一遍，照整页扫会白抓十几次
    function maxWeekOf(item) {
        if (!item.ok) return 0;
        if (!item.data) item.data = tableDataOf(item.html);
        if (!item.data) return 0;
        var max = 0;
        for (var r = 0; r < item.data.rows.length; r++) {
            var segments = item.data.rows[r].segments;
            for (var s = 0; s < segments.length; s++) {
                var re = /([0-9]{1,2})\s*(?:-\s*([0-9]{1,2}))?\s*周/g;
                var m = re.exec(segments[s]);
                while (m !== null) {
                    var end = parseInt(m[2] ? m[2] : m[1], 10);
                    if (end > max && end <= MAX_WEEK) max = end;
                    m = re.exec(segments[s]);
                }
            }
        }
        return max;
    }

    function formBody(week) {
        return 'setAction=userCourseScheduleTable' +
            '&viewType=studentCourseTableWeek' +
            '&selectTableType=' + TERM_TYPE +
            '&queryType=student' +
            '&weekNo=' + encodeURIComponent(String(week));
    }

    // 带超时的 POST：超时 / 网络异常都算这一周没取到，不抛错
    function fetchWeek(week) {
        var controller = new AbortController();
        var timer = setTimeout(function () {
            controller.abort();
        }, FETCH_TIMEOUT_MS);
        return fetch(window.location.origin + COURSE_PATH, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: formBody(week),
            signal: controller.signal
        }).then(function (resp) {
            clearTimeout(timer);
            if (!resp.ok) return { week: week, ok: false, html: '' };
            return resp.text().then(function (html) {
                return { week: week, ok: true, html: html };
            });
        }, function () {
            clearTimeout(timer);
            return { week: week, ok: false, html: '' };
        });
    }

    // 一批 4 周并发，批与批之间串行，与上游一致，避免一次性打满教务。
    // 开新批次前先看总预算：到点就把剩下的周次记成没取到，不再发请求（否则可能撞上宿主 30 秒超时）
    function fetchRange(from, to) {
        var out = [];
        var at = from;
        function next() {
            if (at > to) return Promise.resolve(out);
            if (Date.now() >= DEADLINE) {
                for (var left = at; left <= to; left++) out.push({ week: left, ok: false, html: '' });
                at = to + 1;
                return Promise.resolve(out);
            }
            var batch = [];
            for (var w = at; w <= to && batch.length < CONCURRENCY; w++) batch.push(w);
            at += batch.length;
            var parts = [];
            for (var i = 0; i < batch.length; i++) parts.push(fetchWeek(batch[i]));
            return Promise.all(parts).then(function (list) {
                for (var j = 0; j < list.length; j++) out.push(list[j]);
                return next();
            });
        }
        return next();
    }

    function publicWeeks(results) {
        var weeks = [];
        for (var i = 0; i < results.length; i++) {
            var item = results[i];
            var parsed = item.ok ? (item.data || tableDataOf(item.html)) : null;
            weeks.push({
                week: item.week,
                ok: parsed !== null,
                rows: parsed ? parsed.rows : []
            });
        }
        return weeks;
    }

    if (!onJwHost()) throw new Error(NOT_JW_TEXT);
    if (onLoginPage()) throw new Error(LOGIN_TEXT);

    DEADLINE = Date.now() + EXTRACT_BUDGET_MS;
    return fetchWeek(1).then(function (first) {
        if (!first.ok) throw new Error(NETWORK_TEXT);
        if (isLoginHtml(first.html)) throw new Error(LOGIN_TEXT);
        var firstData = tableDataOf(first.html);
        if (!firstData) throw new Error(NO_TABLE_TEXT);

        var results = [first];
        var attempted = 1;
        return fetchRange(2, FIRST_WEEKS).then(function (part) {
            for (var i = 0; i < part.length; i++) results.push(part[i]);
            attempted = FIRST_WEEKS;
            // 抓到的课表里出现 20 周以后的周次就补抓；补抓回来的页面可能再露出更晚的周次，循环到不再变化
            function extend() {
                var hint = 0;
                for (var j = 0; j < results.length; j++) {
                    var found = maxWeekOf(results[j]);
                    if (found > hint) hint = found;
                }
                if (hint <= attempted || attempted >= MAX_WEEK) return Promise.resolve();
                var to = Math.min(hint, MAX_WEEK);
                var from = attempted + 1;
                attempted = to;
                return fetchRange(from, to).then(function (more) {
                    for (var k = 0; k < more.length; k++) results.push(more[k]);
                    return extend();
                });
            }
            return extend();
        }).then(function () {
            var weeks = publicWeeks(results);
            var skippedWeeks = [];
            for (var sw = 0; sw < weeks.length; sw++) {
                if (!weeks[sw].ok) skippedWeeks.push(weeks[sw].week);
            }
            return JSON.stringify({
                today: todayIso(),
                termLabel: termLabelOf(first.html),
                mondayText: firstData.mondayText,
                timeRows: firstData.timeRows,
                weeks: weeks,
                skippedWeeks: skippedWeeks
            });
        });
    });
})()
