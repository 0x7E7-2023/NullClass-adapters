(function () {
    // 浙江树人学院（浙江树人大学）教务适配器（xk.jwc.zjsru.edu.cn）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 ZJSRU/zjsru_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 CagierAsh123）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 86ea7dd
    //
    // 本校是正方教务 ASP.NET WebForms 版：服务端渲染的课表页 xskbcx.aspx，
    // 表格为 <table id="Table1" class="schedule">，一个格子里可能并排多门课、以 <br> 分行，
    // 行首标签形如「周一第1,2节{第1-16周}」。登录走统一身份认证 CAS，教务首页会自动跳转。
    //
    // 移植改动（逐条对应 AUDIT.md §5）：
    //   ① 不弹确认框、不弹提示条，也不保存任何东西：上游用拾光的 showAlert / showToast /
    //      saveImportedCourses / savePresetTimeSlots / saveCourseConfig 完成整个导入，空课由宿主保存
    //   ② 不解析「周X第N节{周次}」行、不切课程、不去重、不合并：这些判断与计算全部放到 parse.js
    //      （CI 只能跑 parse.js）；这里只按格子交出行文本
    //   ③ 每个格子只交看得见的文字：隐藏元素（display:none / visibility:hidden / hidden）整棵跳过，
    //      每行截到 120 字，最多 60 行；表格以外的页面文字（姓名、学号、菜单）一概不读
    //   ④ 学期：上游弹窗让用户选学年学期，再用 __EVENTTARGET 回发切换。这里不弹窗、不回发：
    //      读课表文档里 select#xnd / select#xqd 的当前选中项（用户在教务里选好哪学期就导哪学期），
    //      读不到交 null，由 parse.js 按今天的日期推算并在提醒里说明
    //   ⑤ 校区：上游必问一次校区（决定用哪套节次时间）。这里先看课表格子里的文字能不能判断
    //      （只出现「杨汛桥」或只出现「拱宸桥」时直接定），判断不了才用 __ncSelect 问一次；
    //      提问桥不在、用户取消都按拱宸桥校区导入，由 parse.js 在提醒里说实话
    //   ⑥ 学号：上游优先取当前地址的 xh 参数，其次找教务菜单里 xh=xxxx 的链接，只用来拼本校同源课表页地址。
    //      这里照做，学号不进输出、不进报错
    //   ⑦ 登录页 / 统一认证页 / 非本校页面上点提取：先判断再取数，给大白话提示，不发请求
    //   ⑧ 取数：上游会自己再拉一次课表页（同源 GET xskbcx.aspx?xh=<学号>&type=1），
    //      基址由 location.pathname 推导，因此经 WebVPN 打开（/https/webvpn<hash>/xskbcx.aspx）时同样可用
    //
    // 取数方式：当前页就是课表页（含同源 iframe 嵌套）时直接读；否则发一次同源 GET 拉课表页，
    // 用 DOMParser 离线解析。登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ today, term: { year, semester, yearLabel, semesterLabel } | null,
    //         campus: { key, label, source }, cells: [ [行, 行, ...], ... ] }
    //   campus.source —— 'page'（从课表文字判断）/ 'user'（用户选的）/ 'default'（没确认，按拱宸桥）
    var TABLE_SELECTOR = 'table#Table1.schedule';
    var SCHEDULE_FILE = 'xskbcx.aspx';
    var LINE_LIMIT = 120;
    var MAX_LINES = 60;
    var CAMPUSES = [
        { key: 'gongchenqiao', label: '拱宸桥校区' },
        { key: 'yangxunqiao', label: '杨汛桥校区' }
    ];
    var LOGIN_TEXT = '当前打开的是登录页。请先登录统一身份认证，再打开「学生个人课表」页面，然后点「提取课表」';
    var NOT_JW_TEXT = '当前页面不是浙江树人学院的教务系统。请先登录，再打开「学生个人课表」页面，然后点「提取课表」';
    var TEACHER_TEXT = '当前打开的是教师课表，只能导入学生个人课表。请进入「学生个人课表」页面后再点「提取课表」';
    var NO_TABLE_TEXT = '没有找到课表：请先打开「学生个人课表」页面，确认页面上能看到课表，再点「提取课表」';
    var FETCH_FAIL_TEXT = '没取到课表页，可能是登录状态已失效。请重新登录统一身份认证，再点「提取课表」';

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

    // 教务主机只有 xk.jwc.zjsru.edu.cn；用户可能经学校 WebVPN 打开（主机形如 webvpn.zjsru.edu.cn），
    // 那种情况下请求打在 WebVPN 自己的同源路径上。学校其它站点（如 www）不是教务系统
    function onJwHost() {
        var host = String(window.location.hostname || '').toLowerCase();
        if (host === 'xk.jwc.zjsru.edu.cn') return true;
        return /(^|[.])webvpn[A-Za-z0-9-]*[.]zjsru[.]edu[.]cn$/.test(host);
    }

    function onLoginPath() {
        var path = String(window.location.pathname || '').toLowerCase();
        return path.indexOf('login') >= 0 || path.indexOf('/cas/') >= 0;
    }

    // 统一认证会重定向到一个带密码框的页面；只看有没有密码框，不读它的值
    function hasPasswordInput(doc) {
        if (!doc || !doc.getElementsByTagName) return false;
        var inputs = doc.getElementsByTagName('input');
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === 'password') return true;
        }
        return false;
    }

    // 教师课表：页面标题写「教师…课表」、且不是「学生…课表」。上游没有这条判断，见 AUDIT §9
    function looksTeacher(doc) {
        var title = '';
        try { title = clean(doc.title); } catch (e) { title = ''; }
        if (!title) return false;
        if (title.indexOf('学生') >= 0) return false;
        return title.indexOf('教师') >= 0 && title.indexOf('课表') >= 0;
    }

    // 同源的帧才读得到；跨域读 contentDocument 会抛异常，捕掉
    function frameDoc(frame) {
        try {
            if (frame.contentDocument) return frame.contentDocument;
            if (frame.contentWindow) return frame.contentWindow.document;
            return null;
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

    // 上游：当前文档 → 同源 iframe 一层。这里把 iframe 里再一层的 <iframe>/<frame> 也算上
    function findTable(doc) {
        var found = tableIn(doc);
        if (found) return found;
        var frames = doc.querySelectorAll ? doc.querySelectorAll('iframe, frame') : [];
        var i;
        for (i = 0; i < frames.length; i++) {
            var inner = frameDoc(frames[i]);
            if (!inner) continue;
            found = tableIn(inner);
            if (found) return found;
            var nested = inner.querySelectorAll ? inner.querySelectorAll('iframe, frame') : [];
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

    // 自己或任何一层祖先被隐藏就整格不读。
    // getClientRects 只在当前活动文档里量：DOMParser 解析出来的离线文档不排版，量出来永远是空的
    function hiddenWithAncestors(node) {
        var cur = node;
        while (cur && cur.nodeType === 1) {
            if (hiddenNode(cur)) return true;
            cur = cur.parentNode;
        }
        try {
            if (node.ownerDocument === window.document && node.getClientRects &&
                node.getClientRects().length === 0) return true;
        } catch (e) { /* 量不出来就当看得见 */ }
        return false;
    }

    // 一个格子的全部文字行（上游同：<br> 换成换行后逐行取，空行不占位）
    function linesOf(cell) {
        if (!cell || hiddenWithAncestors(cell)) return [];
        var pieces = visibleText(cell, []).join('').split('\n');
        var lines = [];
        for (var i = 0; i < pieces.length && lines.length < MAX_LINES; i++) {
            var line = clean(pieces[i]);
            if (!line) continue;
            lines.push(line.length > LINE_LIMIT ? line.substring(0, LINE_LIMIT) : line);
        }
        return lines;
    }

    // 上游遍历表格里的全部 td；rowspan 单元格在 DOM 里只属于一行，不会重复
    function cellsOf(table) {
        var tds = table.querySelectorAll('td');
        var cells = [];
        for (var i = 0; i < tds.length; i++) {
            var lines = linesOf(tds[i]);
            if (lines.length) cells.push(lines);
        }
        return cells;
    }

    // 下拉框的选中项；没有选中标记时取第一个有值的选项
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
        var semester = xqd && /^[123]$/.test(xqd.value) ? xqd.value : '';
        if (!year || !semester) return null;
        return {
            year: year,
            semester: semester,
            yearLabel: xnd ? xnd.label : '',
            semesterLabel: xqd ? xqd.label : ''
        };
    }

    // 学号只用来拼本校同源课表页地址：当前地址的 xh 参数 → 菜单里 xh= 的链接 → 整页 HTML 里的 xh= 文本
    function detectStudentId(doc) {
        try {
            var params = new URLSearchParams(window.location.search);
            var fromUrl = params.get('xh');
            if (fromUrl && /^[0-9]{4,}$/.test(fromUrl.trim())) return fromUrl.trim();
        } catch (e) { /* 老 WebView 没有 URLSearchParams 就从链接里找 */ }
        var anchors = doc.querySelectorAll ? doc.querySelectorAll('a[href*="xh="]') : [];
        for (var i = 0; i < anchors.length; i++) {
            var m = (anchors[i].getAttribute('href') || '').match(/[?&]xh=([0-9]{4,})/);
            if (m) return m[1];
        }
        var html = doc.documentElement ? String(doc.documentElement.innerHTML || '') : '';
        var m2 = html.match(/[?&]xh=([0-9]{4,})/);
        return m2 ? m2[1] : '';
    }

    // 课表页地址。基址取自当前路径，校内直连与 WebVPN 代理路径都适用
    function scheduleUrl(studentId) {
        var base = window.location.origin + String(window.location.pathname || '').replace(/[^/]*$/, '');
        var qs = studentId
            ? ('?xh=' + encodeURIComponent(studentId) + '&type=1')
            : '?type=1';
        return new URL(SCHEDULE_FILE + qs, base).toString();
    }

    function fetchDoc(url) {
        return fetch(url, { method: 'GET', credentials: 'include' }).then(function (res) {
            if (!res.ok) return null;
            return res.text();
        }).then(function (html) {
            if (html === null || html === undefined) return null;
            return new DOMParser().parseFromString(html, 'text/html');
        }, function () {
            return null;
        });
    }

    // 先看课表文字里只出现了哪个校区名；两个都有或都没有就判断不了
    function campusFromCells(cells) {
        var all = '';
        for (var i = 0; i < cells.length; i++) all += cells[i].join(' ');
        var gong = all.indexOf('拱宸桥') >= 0;
        var yang = all.indexOf('杨汛桥') >= 0;
        if (gong === yang) return null;
        return gong ? CAMPUSES[0] : CAMPUSES[1];
    }

    // 校区影响每门课的上课时间，判断不了就问一次；桥不在、用户取消、报错都按拱宸桥，parse.js 会提醒
    function askCampus() {
        if (typeof __ncCapabilities === 'undefined' || !__ncCapabilities || !__ncCapabilities.ask) {
            return Promise.resolve(null);
        }
        if (typeof __ncSelect !== 'function') return Promise.resolve(null);
        return __ncSelect({
            title: '请选择所在校区',
            message: '两个校区的节次时间不同，选错会让所有课的上课时间整体偏移。',
            items: ['拱宸桥校区', '杨汛桥校区'],
            defaultIndex: 0
        }).then(function (index) {
            if (typeof index !== 'number' || index < 0 || index >= CAMPUSES.length) return null;
            return CAMPUSES[index];
        }, function () {
            return null;
        });
    }

    function campusOf(cells) {
        var fromPage = campusFromCells(cells);
        if (fromPage) {
            return Promise.resolve({ key: fromPage.key, label: fromPage.label, source: 'page' });
        }
        return askCampus().then(function (picked) {
            if (picked) return { key: picked.key, label: picked.label, source: 'user' };
            return { key: CAMPUSES[0].key, label: CAMPUSES[0].label, source: 'default' };
        });
    }

    function payloadOf(doc, table) {
        var cells = cellsOf(table);
        return campusOf(cells).then(function (campus) {
            return JSON.stringify({
                today: todayIso(),
                term: termOf(doc),
                campus: campus,
                cells: cells
            });
        });
    }

    if (hasPasswordInput(window.document) || onLoginPath()) throw new Error(LOGIN_TEXT);
    if (!onJwHost()) throw new Error(NOT_JW_TEXT);

    // 当前页就是课表页：直接读，不发请求
    var liveTable = findTable(window.document);
    if (liveTable) {
        if (looksTeacher(window.document)) throw new Error(TEACHER_TEXT);
        return payloadOf(window.document, liveTable);
    }

    // 否则按当前路径推导基址，同源拉一次课表页
    var url = scheduleUrl(detectStudentId(window.document));
    return fetchDoc(url).then(function (doc) {
        if (!doc) throw new Error(FETCH_FAIL_TEXT);
        if (hasPasswordInput(doc)) throw new Error(LOGIN_TEXT);
        var table = findTable(doc);
        if (!table) throw new Error(NO_TABLE_TEXT);
        if (looksTeacher(doc)) throw new Error(TEACHER_TEXT);
        return payloadOf(doc, table);
    });
})()
