(function () {
    // 苏州大学选课系统适配器（xk.suda.edu.cn）—— 第一步：只取数，把教务页面上的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SUDA/suda.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 BernardYan2357）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-09 拉取）
    //   本校脚本最后一次修改 1fe584c
    //
    // 本校是服务端渲染的 JSP 课表页：<table id="Table1" class="schedule"> 的每个格子里放一个 <a>，
    // <a> 的文字按行是「课程名 / 时间行 / 教师 / 地点」（上游按 <br> 切行后取前四行）。
    // 时间行形如「周一第3,4,5节{第1-17周}」「周二第8,9节{第2-16周|双周}」。
    //
    // 移植改动（逐条对应 AUDIT.md §4）：
    //   ① 不弹确认框、不弹提示条，也不保存任何东西：上游用拾光的 showAlert / showToast /
    //      saveImportedCourses / savePresetTimeSlots / saveCourseConfig 完成整个导入，空课由宿主保存，这里只交数据
    //   ② 不解析时间行、不拼课程、不去重、不合并：这些判断与计算全部放到 parse.js（CI 只能跑 parse.js）；
    //      这里只按行搬运「课程名 / 时间行 / 教师 / 地点」四个字段
    //   ③ 每个格子只交前四行、每行最多 120 字；被隐藏起来的元素（display:none / visibility:hidden / hidden）
    //      整棵跳过，格子里藏着的学号、姓名之类不会被带出（上游直接读 innerHTML，会一起交出去）
    //   ④ 学期：读课表所在文档的 select#xnd（学年）与 select#xqd（第几学期），读不到交 null，
    //      由 parse.js 按今天的日期推算并在提醒里说明（上游只用来推开学日，推不出就交 null）
    //   ⑤ 开学日：上游按「第一学期 9 月 1 日 / 第二学期次年 3 月 2 日」写死并直接当学期开始日；
    //      这里只交学期与学年，由 parse.js 按手册 §4.3 回退到那一周的周一，并提醒这是推算的
    //   ⑥ 课表表格：上游只认 table#Table1.schedule，先在当前文档找，再找同源的 iframe（含一层嵌套）；
    //      这里照做，并把 <frame> 一起算上（老 JSP 页面常用框架集），跨域读不到的帧跳过
    //   ⑦ 上游没有任何登录页判断：这里在发任何读操作之前，先判断当前页是不是选课系统的登录页 / 别的网站，
    //      给出大白话提示（这两种情况都不碰页面内容）
    //
    // 取数方式：**不发任何网络请求**。所有数据都从用户已经打开的课表页面上读（只读，不写 DOM、不改表单、不提交）。
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ term: { year, semester, yearLabel, semesterLabel } | null, today, rows: [...] }
    //   term.year / term.semester —— 学年下拉框值里的 4 位年份、学期下拉框的 1 或 2；读不全为 null
    //   term.yearLabel / term.semesterLabel —— 两个下拉框选中项的文字（原样，如「2026-2027」「第一学期」）
    //   rows[] —— 每个课程格子的前四行：name 课程名、time 时间行、teacher 教师、location 地点（缺的为空串）
    var HOST = 'xk.suda.edu.cn';
    var TABLE_SELECTOR = 'table#Table1.schedule';
    var LINE_LIMIT = 120;   // 每个字段最多交出的字数
    var LOGIN_TEXT = '当前打开的是登录页。请先登录选课系统，再打开「学生个人课表」页面，然后点「提取课表」';
    var NOT_JW_TEXT = '当前页面不是苏州大学的选课系统（xk.suda.edu.cn）。请先登录，再打开「学生个人课表」页面，然后点「提取课表」';
    var NO_TABLE_TEXT = '没有找到课表：请先打开「学生个人课表」页面，确认页面上能看到课表，再点「提取课表」';

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

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === HOST;
    }

    // 登录页：根路径（选课系统的入口就是登录页），或路径里含 login。只看路径，不看查询串
    function onLoginPage() {
        var path = String(window.location.pathname || '');
        if (path === '/' || path === '') return true;
        return path.toLowerCase().indexOf('login') >= 0;
    }

    // 同源的帧才读得到；跨域读 contentDocument 会抛异常，捕掉
    function frameDoc(frame) {
        try {
            if (frame.contentDocument) return frame.contentDocument;
            return frame.contentWindow ? frame.contentWindow.document : null;
        } catch (e) {
            return null;
        }
    }

    function tableIn(doc) {
        try {
            return doc && doc.querySelector ? doc.querySelector(TABLE_SELECTOR) : null;
        } catch (e) {
            return null;
        }
    }

    // 上游：当前文档 → 同源 iframe → iframe 里再一层 iframe。这里多认 <frame>，其余一致
    function findTable() {
        var doc = window.document;
        var found = tableIn(doc);
        if (found) return found;
        var frames = doc.querySelectorAll('iframe, frame');
        var i;
        for (i = 0; i < frames.length; i++) {
            var inner = frameDoc(frames[i]);
            if (!inner) continue;
            found = tableIn(inner);
            if (found) return found;
            var nested = inner.querySelectorAll('iframe, frame');
            for (var j = 0; j < nested.length; j++) {
                var nestedDoc = frameDoc(nested[j]);
                if (!nestedDoc) continue;
                found = tableIn(nestedDoc);
                if (found) return found;
            }
        }
        return null;
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

    // 逐个子节点取看得见的文字：<br> 是换行，隐藏元素整棵跳过，&nbsp; 当空格
    function visibleText(node, out) {
        var children = node.childNodes || [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 3) {
                out.push(String(child.nodeValue || ''));
                continue;
            }
            if (child.nodeType !== 1) continue;
            if (String(child.tagName || '').toUpperCase() === 'BR') { out.push('\n'); continue; }
            if (hiddenNode(child)) continue;
            visibleText(child, out);
        }
        return out;
    }

    // 自己或任何一层祖先被隐藏 / 根本没渲染出来（祖先 display:none 时 getClientRects 为空）
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

    // 一个课程格子的前四行（上游同：课程名 / 时间行 / 教师 / 地点）；空行不占位
    function linesOf(anchor) {
        if (!anchor) return [];
        if (hiddenWithAncestors(anchor)) return [];
        var pieces = visibleText(anchor, []).join('').split('\n');
        var lines = [];
        for (var i = 0; i < pieces.length && lines.length < 4; i++) {
            var line = clean(pieces[i]);
            if (!line) continue;
            lines.push(line.length > LINE_LIMIT ? line.substring(0, LINE_LIMIT) : line);
        }
        return lines;
    }

    function rowsOf(table) {
        var anchors = table.querySelectorAll('a');
        var rows = [];
        for (var i = 0; i < anchors.length; i++) {
            var lines = linesOf(anchors[i]);
            // 只有课程格子里才有两行以上（课程名 + 时间行）；表头、工具条上的链接不认
            if (lines.length < 2) continue;
            rows.push({
                name: lines[0],
                time: lines[1],
                teacher: lines[2] || '',
                location: lines[3] || ''
            });
        }
        return rows;
    }

    // 下拉框的选中项；没有选中标记时取第一个有值的选项（与上游读 value 的口径一致）
    function selectedOf(doc, id) {
        var select = doc && doc.getElementById ? doc.getElementById(id) : null;
        if (!select) return null;
        var options = select.querySelectorAll ? select.querySelectorAll('option') : (select.options || []);
        var picked = null;
        var first = null;
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var value = clean(option.value);
            if (!value) continue;
            var item = { value: value, label: clean(option.textContent) };
            if (!first) first = item;
            var chosen = option.selected === true || (option.hasAttribute && option.hasAttribute('selected'));
            if (chosen && !picked) picked = item;
        }
        return picked || first;
    }

    // 学年学期读不全（缺学年或缺第几学期）就交 null：宁可按今天的日期推算并提醒，也不猜一个错的开学日
    function termOf(doc) {
        if (!doc) return null;
        var xnd = selectedOf(doc, 'xnd');
        var xqd = selectedOf(doc, 'xqd');
        var yearMatch = xnd ? /(\d{4})/.exec(xnd.value) : null;
        var year = yearMatch ? yearMatch[1] : '';
        var semester = xqd && /^[12]$/.test(xqd.value) ? xqd.value : '';
        if (!year || !semester) return null;
        return {
            year: year,
            semester: semester,
            yearLabel: xnd ? xnd.label : '',
            semesterLabel: xqd ? xqd.label : ''
        };
    }

    if (!onJwHost()) throw new Error(NOT_JW_TEXT);
    if (onLoginPage()) throw new Error(LOGIN_TEXT);
    var table = findTable();
    if (!table) throw new Error(NO_TABLE_TEXT);
    var doc = table.ownerDocument || window.document;
    return JSON.stringify({
        term: termOf(doc),
        today: todayIso(),
        rows: rowsOf(table)
    });
})()
