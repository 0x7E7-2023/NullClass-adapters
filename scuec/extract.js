(function () {
    // 中南民族大学教务适配器（webvpn.scuec.edu.cn 代理访问的正方 ASP.NET 课表页）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 SCUEC/scuec.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Zellon0w0）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 12952a3（2026-09-08，与任务卡一致）
    //
    // 本校课表页是服务端渲染的 <table class="CourseFormTable">：表头第 1、2 格是「时间 / 节次」，
    // 之后每天一列；每个数据行的第 2 格写「第N节 / 08:00~08:45」；课程格子里的多门课用 <hr> 分隔，
    // 每门课以 <br> 分行。表格末尾可能还有一张 <table class="NoFitCourse">（未安排时间的课程）。
    //
    // 移植改动（逐条对应 AUDIT.md §5）：
    //   ① 不弹确认框、不弹提示条，也不保存任何东西：上游用拾光的 showAlert / showToast /
    //      saveImportedCourses / savePresetTimeSlots / notifyTaskCompletion 完成整个导入，空课由宿主保存
    //   ② 不解析课名 / 教师 / 地点 / 周次 / 节次：这些判断与计算全部放到 parse.js（CI 只能跑 parse.js）；
    //      这里只按「行 → 每列的课程块（<hr> 分隔）→ 每个块的文字行（<br> 分行）」原样交出去
    //   ③ 每个格子只交看得见的文字：隐藏元素（display:none / visibility:hidden / hidden）整棵跳过；
    //      表头、行首「上午 / 下午」标签、表格以外的页面文字（姓名、学号、菜单）一概不读
    //   ④ 不发任何请求：上游本身就是纯 DOM 抓当前页，这里保持一致（没有 fetch / XHR）
    //   ⑤ 登录页 / 门户页先判断再取数：有密码框或路径像登录页就报登录页，零请求；
    //      没有课表表报「没有找到课表」，表在但结构不对（没有表头 / 没有节次列）单独报一句，不合并
    //   ⑥ 行 / 列合并：rowspan / colspan 只用来跳过被占用的列（与上游 pendingRowspans 一致），
    //      课程落在哪个数据行，就用那一行的节次做兜底（交给 parse.js 判断）
    //   ⑦ 个人信息的兜底：只挑课程格子、节次格子、未安排课程表的前三列，
    //      藏在格子里的学号 / 姓名 / 身份证号 / 手机号只要元素被隐藏就整棵跳过
    //
    // 输出：{ today, truncated,
    //         rows: [ { section: [行文字…], days: [ 课程块数组 | null, … ] } ],
    //         unscheduled: [ [课名行, 周次行, 教师行], … ] }
    //   一个「课程块」= 一个 <hr> 分隔出来的格子片段的可见文字行（按 <br> 分行，空行不占位）。
    //   days 按表头列顺序排列（第 0 项 = 周一），被上方 rowspan 占住的列交 null。
    var TABLE_SELECTOR = 'table.CourseFormTable';
    var NOFIT_SELECTOR = 'table.NoFitCourse';
    var LINE_LIMIT = 120;   // 单行最多留多少字（课名 / 周次都在前 120 字里）
    var MAX_LINES = 40;     // 一个课程块最多几行
    var MAX_BLOCKS = 20;    // 一个格子最多几门课
    var MAX_ROWS = 80;      // 课表最多读多少行
    var LOGIN_TEXT = '当前打开的是登录页。请先登录，再打开「学生个人课表」页面，然后点「提取课表」';
    var NO_TABLE_TEXT = '没有找到课表：请先在教务系统打开「学生个人课表」页面，确认页面上能看到课表，再点「提取课表」';
    var BROKEN_TEXT = '页面上的课表看起来不完整（没有表头或没有节次列）。请刷新「学生个人课表」页面后再点「提取课表」';

    var truncated = false;

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。不能用 toISOString：北京时间早上 8 点前它会退到前一天
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // 统一身份认证会重定向到一个带密码框的页面；只看有没有密码框，不读它的值
    function hasPasswordInput(doc) {
        if (!doc || !doc.getElementsByTagName) return false;
        var inputs = doc.getElementsByTagName('input');
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === 'password') return true;
        }
        return false;
    }

    // 登录 / 统一认证 / WebVPN 网关的登录入口都带这些路径片段
    function onLoginPath() {
        var path = String(window.location.pathname || '').toLowerCase();
        return path.indexOf('login') >= 0 || path.indexOf('/cas/') >= 0 || path.indexOf('/auth/') >= 0;
    }

    // 看不见的元素：hidden 属性、内联样式或计算后的样式把 display / visibility 关掉。整棵子树都不读
    function hiddenNode(node) {
        var tag = String(node.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
        try {
            if (node.getAttribute && node.getAttribute('hidden') !== null) return true;
        } catch (e) { return true; }
        try {
            var style = node.style || {};
            if (String(style.display).toLowerCase() === 'none') return true;
            if (String(style.visibility).toLowerCase() === 'hidden') return true;
            var computed = window.getComputedStyle ? window.getComputedStyle(node) : null;
            if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return true;
        } catch (e) { /* 算不出来就当看得见，不影响取数 */ }
        return false;
    }

    // 自己或任何一层祖先被隐藏就整格不读；当前活动文档里再量一次排版（移出屏幕之类）
    function hiddenWithAncestors(node) {
        var cur = node;
        while (cur && cur.nodeType === 1) {
            if (hiddenNode(cur)) return true;
            cur = cur.parentNode;
        }
        try {
            if (node.getClientRects && node.getClientRects().length === 0) return true;
        } catch (e) { /* 量不出来就当看得见 */ }
        return false;
    }

    // 逐个子节点走：文字 → onText，<br> → onLine，<hr> → onBreak，隐藏元素整棵跳过
    function walkVisible(node, onText, onLine, onBreak) {
        var children = node.childNodes || [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 3) { onText(String(child.nodeValue || '')); continue; }
            if (child.nodeType !== 1) continue;
            var tag = String(child.tagName || '').toUpperCase();
            if (tag === 'BR') { onLine(); continue; }
            if (tag === 'HR') { onBreak(); continue; }
            if (hiddenNode(child)) continue;
            walkVisible(child, onText, onLine, onBreak);
        }
    }

    function clip(line) {
        return line.length > LINE_LIMIT ? line.substring(0, LINE_LIMIT) : line;
    }

    // 一个格子的文字行（节次格用：<br> 分行，<hr> 也当换行）
    function linesOf(cell) {
        if (!cell || hiddenWithAncestors(cell)) return [];
        var lines = [];
        var buffer = '';
        function flush() {
            var line = clean(buffer);
            buffer = '';
            if (line) lines.push(clip(line));
        }
        walkVisible(cell, function (piece) { buffer += piece; }, flush, flush);
        flush();
        if (lines.length > MAX_LINES) { lines = lines.slice(0, MAX_LINES); truncated = true; }
        return lines;
    }

    // 一个课程格子的课程块（<hr> 分隔多门课，每门课按 <br> 分行）
    function blocksOf(cell) {
        if (!cell || hiddenWithAncestors(cell)) return [];
        var blocks = [];
        var lines = [];
        var buffer = '';
        function flushLine() {
            var line = clean(buffer);
            buffer = '';
            if (line) lines.push(clip(line));
        }
        function flushBlock() {
            flushLine();
            if (lines.length) blocks.push(lines);
            lines = [];
        }
        walkVisible(cell, function (piece) { buffer += piece; }, flushLine, flushBlock);
        flushBlock();
        if (blocks.length > MAX_BLOCKS) { blocks = blocks.slice(0, MAX_BLOCKS); truncated = true; }
        return blocks;
    }

    function hasNoFit(cell) {
        try {
            return !!(cell && cell.querySelector && cell.querySelector(NOFIT_SELECTOR));
        } catch (e) {
            return false;
        }
    }

    // 未安排时间的课程表：每行前三格是课名 / 周次 / 教师，原样交出前三格的文字行
    function unscheduledOf(container) {
        var table = null;
        try { table = container.querySelector(NOFIT_SELECTOR); } catch (e) { table = null; }
        if (!table) return [];
        var rows = table.querySelectorAll ? table.querySelectorAll('tr') : [];
        var list = [];
        for (var i = 0; i < rows.length && list.length < MAX_ROWS; i++) {
            var cells = rows[i].cells || [];
            if (cells.length < 3) continue;
            list.push([linesOf(cells[0]), linesOf(cells[1]), linesOf(cells[2])]);
        }
        return list;
    }

    function spanOf(cell, name) {
        var value = 1;
        try { value = Number(cell.getAttribute(name) || '1'); } catch (e) { value = 1; }
        return isNaN(value) || value < 1 ? 1 : value;
    }

    function scheduleData(table) {
        var rows = table.rows;
        if (!rows || rows.length < 2) throw new Error(BROKEN_TEXT);
        var headerCells = rows[0].cells || [];
        var dayCount = headerCells.length - 2;
        if (dayCount < 1) throw new Error(BROKEN_TEXT);

        var out = [];
        var unscheduled = [];
        var pending = [];
        var d;
        for (d = 0; d < dayCount; d++) pending.push(0);

        for (var r = 1; r < rows.length; r++) {
            if (out.length >= MAX_ROWS) { truncated = true; break; }
            var cells = rows[r].cells || [];
            var nofit = null;
            for (var c = 0; c < cells.length && !nofit; c++) {
                if (hasNoFit(cells[c])) nofit = cells[c];
            }
            if (nofit) { unscheduled = unscheduledOf(nofit); break; }
            if (cells.length < 3) continue;

            var days = [];
            for (d = 0; d < dayCount; d++) days.push(null);
            var pointer = 0;
            for (var day = 0; day < dayCount; day++) {
                if (pending[day] > 0) { pending[day]--; continue; }
                var cell = cells[2 + pointer];
                if (!cell) continue;
                pointer++;
                var blocks = blocksOf(cell);
                if (blocks.length) days[day] = blocks;
                var rowspan = spanOf(cell, 'rowspan');
                var colspan = spanOf(cell, 'colspan');
                if (rowspan > 1) {
                    for (var off = 0; off < colspan && day + off < dayCount; off++) {
                        if (pending[day + off] < rowspan - 1) pending[day + off] = rowspan - 1;
                    }
                }
                if (colspan > 1) day += colspan - 1;
            }
            out.push({ section: cells[1] ? linesOf(cells[1]) : [], days: days });
        }

        return { today: todayIso(), truncated: truncated, rows: out, unscheduled: unscheduled };
    }

    if (hasPasswordInput(window.document) || onLoginPath()) throw new Error(LOGIN_TEXT);

    var table = window.document.querySelector ? window.document.querySelector(TABLE_SELECTOR) : null;
    if (!table) throw new Error(NO_TABLE_TEXT);

    return JSON.stringify(scheduleData(table));
})()
