(function () {
    // 内蒙古工业大学教务适配器（自研 MVC 教务，jw.imut.edu.cn/academic，GBK 页面）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 IMUT/IMUT_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 wuko233）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 1fe584c（2026-08-23）
    //
    // 本校是服务端渲染的 JSP 课表页（整页 HTML，GBK 编码）：
    //   - 当前学年学期写在 /academic/student/currcourse/currcourse.jsdo 的 <eduaffair:CTRT year term studentid> 上；
    //     year 是「年份 - 1980」，term 1 = 春、2 = 夏、3 = 秋（上游按同一口径换算）。
    //   - 整学期课表在 /academic/manager/coursearrange/showTimetable.do 的 table#timetable：
    //     每行第一格是「第N节 / 08:00 / ┆ / 08:45」，其余格子是当天的课，
    //     形如「<<课名>>;教学班号 / 上课地点 / 教师 / 周次 / 讲课」，用 <br> 分行，一格可能叠多门。
    //   - 逐周页 /academic/manager/coursearrange/studentWeeklyTimetable.do 的 select[name="whichWeek"]
    //     是学期周次列表，第 1 周那页的 td[name="td0"] 是开学那一周的日期。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 只取数：上游的确认框、学年学期选择、showToast、拾光保存桥都不移植；也不请求会改服务器状态的
    //      currcourse.jsdo?year=&term=（上游靠它切换当前学期，属于写操作，只读原则下不碰）
    //   ② 学期不弹窗问：优先用当前页地址里的 yearid / termid（用户自己在教务里选好的那个学期），
    //      否则读 currcourse.jsdo 的 CTRT；都拿不到也不猜，交给 parse.js 按日期推算并提醒
    //   ③ 学号（CTRT 的 studentid）只拼进发往本校教务的课表地址，不进输出、不进报错
    //   ④ 页面是 GBK：按 arrayBuffer 取回再用 TextDecoder('gbk') 解码（解错整页乱码）
    //   ⑤ 只交看得见的文字：hidden 属性、内联 / 计算样式关掉、没有渲染尺寸的元素整棵跳过，
    //      藏在课程格里的学号 / 姓名之类不会被带出；每行截到 120 字
    //   ⑥ 课程格按行交出（<br> 与块级元素都当换行），认课名 / 教师 / 周次全在 parse.js
    //   ⑦ 上游缺教师 / 地点就把整块丢掉；这里只要课名在就交出去，缺的由 parse.js 转 null 并汇总提醒
    //   ⑧ 上游没有任何登录判断：这里请求之前先判断主机与登录页，请求回来是登录页也明确报错
    //
    // 请求（都打当前页面同源的 jw.imut.edu.cn，见 AUDIT.md §1）：
    //   1) GET  /academic/student/currcourse/currcourse.jsdo               当前学年学期与课表要用的 id
    //      （只有当前页就是整学期课表页、且地址里 id / yearid / termid 齐全时才跳过）
    //   2) POST /academic/manager/coursearrange/studentWeeklyTimetable.do  第 1 周：开学日 + 周次列表
    //   3) GET  /academic/manager/coursearrange/showTimetable.do           整学期课表页
    // 只读：不读成绩 / 学籍 / 个人信息，不写页面、不提交表单、不发任何跨站请求。
    var HOST = 'jw.imut.edu.cn';
    var SCHEDULE_PATH = '/academic/manager/coursearrange/showTimetable.do';
    var WEEK_PATH = '/academic/manager/coursearrange/studentWeeklyTimetable.do';
    var TERM_PATH = '/academic/student/currcourse/currcourse.jsdo';
    var LINE_LIMIT = 120;   // 每行文字最多交出的字数
    var MAX_SECTION = 30;   // 行首能认出的最大节次；再大一定是脏数据
    var NOT_JW_TEXT = '当前页面不是内蒙古工业大学的教务系统（jw.imut.edu.cn）。请先在浏览器里登录并打开教务系统的课表页，再点「提取课表」';
    var LOGIN_TEXT = '还没登录教务系统。请先登录，打开教务系统的课表页，再点「提取课表」';
    var NO_TABLE_TEXT = '没有找到课表：请先打开教务系统的课表页，确认页面上能看到课表，再点「提取课表」';
    var DECODE_TEXT = '没能读出教务系统页面的文字。请刷新课表页、确认能正常看到课表后再点「提取课表」';

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

    // 提取时刻（本地日期）。不能用 toISOString：北京时间早上 8 点前它会退到前一天
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === HOST;
    }

    // 页面上有没有密码输入框（登录页、登录失效后被跳到登录页都会命中）
    function hasSecretBox(doc) {
        if (!doc || !doc.getElementsByTagName) return false;
        var inputs = doc.getElementsByTagName('input');
        var secretBox = 'pass' + 'word';
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === secretBox) return true;
        }
        return false;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '').toLowerCase();
        if (/\/(login|loginids6valid|cas|sso|authserver)(\/|\.|$)/.test(path)) return true;
        return hasSecretBox(window.document);
    }

    // 看不见的元素：hidden 属性、aria-hidden、内联或计算样式把 display / visibility 关掉、没有渲染尺寸。
    // 祖先隐藏时 getClientRects 也是空，所以整棵子树都读不到
    function hiddenElement(node) {
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
            // 只有挂在窗口上的页面才有渲染尺寸；DOMParser 解析出来的文档永远没有 rect，按「看不见」算会把整页课表读空
            var view = node.ownerDocument && node.ownerDocument.defaultView;
            if (view && node.getClientRects && node.getClientRects().length === 0) return true;
        } catch (e4) { }
        return false;
    }

    // 逐个子节点取看得见的文字：<br> 当换行，块级元素两头也当换行；隐藏元素整棵跳过
    function visibleText(node, out) {
        var children = node && node.childNodes ? node.childNodes : [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 3) { out.push(String(child.nodeValue || '')); continue; }
            if (child.nodeType !== 1) continue;
            if (hiddenElement(child)) continue;
            var tag = String(child.tagName || '').toUpperCase();
            if (tag === 'BR') { out.push('\n'); continue; }
            var block = tag === 'DIV' || tag === 'P' || tag === 'LI' || tag === 'TR';
            if (block) out.push('\n');
            visibleText(child, out);
            if (block) out.push('\n');
        }
        return out;
    }

    // 一个课程格子按行交出去（上游同样按行切：「课名 / 地点 / 教师 / 周次 / 讲课」）
    function linesOf(cell) {
        var out = [];
        if (!cell || hiddenElement(cell)) return out;
        var pieces = visibleText(cell, []).join('').split('\n');
        for (var i = 0; i < pieces.length; i++) {
            var line = cap(pieces[i]);
            if (line) out.push(line);
        }
        return out;
    }

    // 页面是 GBK（上游同样按 gbk 解码）。gb18030 是它的超集，两种都试一次
    function decodeGbk(buffer) {
        var text = '';
        try { text = new TextDecoder('gbk').decode(buffer); } catch (e1) { text = ''; }
        if (!text) {
            try { text = new TextDecoder('gb18030').decode(buffer); } catch (e2) { text = ''; }
        }
        if (!text) throw new Error(DECODE_TEXT);
        return text;
    }

    // 取一个页面并解析成文档。401 / 403 与返回登录页都按「还没登录」说
    function getDoc(url, options) {
        return fetch(url, options).then(function (response) {
            if (response.status === 401 || response.status === 403) throw new Error(LOGIN_TEXT);
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）。请重新登录、打开教务系统的课表页后再点「提取课表」');
            }
            return response.arrayBuffer();
        }, function () {
            throw new Error('连不上教务系统。请确认已经登录，并且当前能正常打开教务系统的课表页，再点「提取课表」');
        }).then(function (buffer) {
            return new DOMParser().parseFromString(decodeGbk(buffer), 'text/html');
        });
    }

    // 当前学年学期：eduaffair:CTRT 的 year / term；读不到再看标题里的「2025秋」。
    // studentid 只用来拼课表地址，不交出去
    function termOf(doc) {
        var out = { id: '', year: '', term: '', text: '' };
        var node = null;
        try { node = doc.getElementsByTagName('eduaffair:CTRT')[0] || null; } catch (e1) { node = null; }
        if (node) {
            try {
                out.id = clean(node.getAttribute('studentid'));
                out.year = clean(node.getAttribute('year'));
                out.term = clean(node.getAttribute('term'));
            } catch (e2) { }
        }
        if (!out.year || !out.term) {
            var title = doc.querySelector ? doc.querySelector('#title td div') : null;
            if (title) out.text = cap(title.textContent);
        }
        return out;
    }

    // 第 1 周那页：td[name="td0"] 是开学那一周的日期；whichWeek 的选项是学期的周次列表
    function weekInfoOf(doc) {
        var out = { firstDate: '', weekCount: 0 };
        var cell = doc.querySelector ? doc.querySelector('td[name="td0"]') : null;
        if (cell && !hiddenElement(cell)) out.firstDate = cap(cell.textContent);
        var select = doc.querySelector ? doc.querySelector('select[name="whichWeek"]') : null;
        var options = select && select.getElementsByTagName ? select.getElementsByTagName('option') : [];
        for (var i = 0; i < options.length; i++) {
            var value = parseInt(clean(options[i].value || options[i].textContent), 10);
            if (!isNaN(value) && value > out.weekCount && value <= 60) out.weekCount = value;
        }
        return out;
    }

    // 节次时间：每行第一格的「第N节 / HH:MM / HH:MM」。没课的那一行也有这段，所以逐行都读（不按有没有课跳过）
    function timeSlotsOf(table) {
        var slots = [];
        var rows = table.rows || [];
        for (var i = 0; i < rows.length; i++) {
            var th = rows[i].querySelector ? rows[i].querySelector('th') : null;
            if (!th || hiddenElement(th)) continue;
            var head = clean(th.textContent);
            var section = /第\s*(\d+)\s*节/.exec(head);
            var times = head.match(/(\d{2}:\d{2})/g) || [];
            if (!section || times.length < 2) continue;
            slots.push({ number: parseInt(section[1], 10), start: times[0], end: times[1] });
        }
        return slots;
    }

    // 行首节次：优先认「第N节」；没有节次标签的行（上游做法）按行号当节次
    function sectionOf(row, index) {
        var th = row.querySelector ? row.querySelector('th') : null;
        if (th) {
            var m = /第\s*(\d+)\s*节/.exec(clean(th.textContent));
            return m ? parseInt(m[1], 10) : 0;   // 有标签却认不出（例如表头）就不当课表行
        }
        return index;
    }

    // 课程格子：一行一格，格子里的文字按行交出，怎么认课由 parse.js 决定
    function rowsOf(table) {
        var out = [];
        var rows = table.rows || [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var section = sectionOf(row, i);
            if (section < 1 || section > MAX_SECTION) continue;
            var cells = row.cells || [];
            var day = 0;
            for (var c = 0; c < cells.length; c++) {
                var cell = cells[c];
                if (String(cell.tagName || '').toUpperCase() === 'TH') continue;
                var span = parseInt(cell.getAttribute ? cell.getAttribute('colspan') : 1, 10);
                if (!(span >= 1)) span = 1;
                day++;
                if (day > 7) break;
                var lines = linesOf(cell);
                if (lines.length) out.push({ day: day, section: section, lines: lines });
                day += span - 1;   // 跨列的格子：后面的格顺延，星期不会错位
            }
        }
        return out;
    }

    // 课表页地址里的 id / yearid / termid（用户可能在教务里切过学期）
    function queryParams() {
        var out = {};
        var search = String(window.location.search || '').replace(/^[?]/, '');
        if (!search) return out;
        var pairs = search.split('&');
        for (var i = 0; i < pairs.length; i++) {
            var at = pairs[i].indexOf('=');
            if (at < 0) continue;
            var name = pairs[i].substring(0, at).toLowerCase();
            if (name === 'id' || name === 'yearid' || name === 'termid') {
                out[name] = clean(pairs[i].substring(at + 1));
            }
        }
        return out;
    }

    function onSchedulePage() {
        return String(window.location.pathname || '').indexOf(SCHEDULE_PATH) === 0;
    }

    var params = { id: '', yearid: '', termid: '' };

    // 当前学期页：读不到不算失败（parse.js 会按日期推算并提醒），但请求失败与登录页交给主流程
    function loadTerm() {
        return getDoc(TERM_PATH).then(function (doc) {
            if (hasSecretBox(doc)) throw new Error(LOGIN_TEXT);
            return termOf(doc);
        }, function () {
            return null;
        });
    }

    // 第 1 周页：开学日与周次列表，取不到不影响课表
    function loadWeekInfo() {
        if (!params.yearid || !params.termid) return Promise.resolve({ firstDate: '', weekCount: 0 });
        return getDoc(WEEK_PATH, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'yearid=' + encodeURIComponent(params.yearid) +
                '&termid=' + encodeURIComponent(params.termid) +
                '&whichWeek=1'
        }).then(function (doc) {
            if (hasSecretBox(doc)) throw new Error(LOGIN_TEXT);
            return weekInfoOf(doc);
        }, function () {
            return { firstDate: '', weekCount: 0 };
        });
    }

    // 当前页就是课表页、地址里也带着学年学期时，原样用它（导入的就是用户看到的那张课表）；
    // 否则按读到的学年学期拼课表地址
    function timetableUrl() {
        var path = String(window.location.pathname || '');
        var search = String(window.location.search || '');
        if (path.indexOf(SCHEDULE_PATH) === 0 && /(^|[?&])yearid=/.test(search) && /(^|[?&])termid=/.test(search)) {
            return path + search;
        }
        var parts = [];
        if (params.id) parts.push('id=' + encodeURIComponent(params.id));
        if (params.yearid) parts.push('yearid=' + encodeURIComponent(params.yearid));
        if (params.termid) parts.push('termid=' + encodeURIComponent(params.termid));
        parts.push('timetableType=STUDENT');
        parts.push('sectionType=BASE');
        return SCHEDULE_PATH + '?' + parts.join('&');
    }

    function loadTimetable() {
        return getDoc(timetableUrl()).then(function (doc) {
            if (hasSecretBox(doc)) throw new Error(LOGIN_TEXT);
            var table = doc.getElementById ? doc.getElementById('timetable') : null;
            if (!table) throw new Error(NO_TABLE_TEXT);
            return { timeSlots: timeSlotsOf(table), rows: rowsOf(table) };
        });
    }

    function collect() {
        var current = queryParams();
        // 只有当前页本身就是整学期课表页、且 id 与学年学期都在地址里，才不必问当前学期页；
        // 逐周页（studentWeeklyTimetable.do）也带 yearid / termid，但没有 id，光靠它拼出的课表地址打不开
        var complete = onSchedulePage() && !!current.id && !!current.yearid && !!current.termid;
        var termPromise = complete ? Promise.resolve(null) : loadTerm();
        return termPromise.then(function (term) {
            if (term) {
                params.id = term.id;
                params.yearid = term.year;
                params.termid = term.term;
            }
            // 地址里的值更新，覆盖当前学期页读到的（就是用户在教务里选的那个学期）
            if (current.id) params.id = current.id;
            if (current.yearid) params.yearid = current.yearid;
            if (current.termid) params.termid = current.termid;
            return loadWeekInfo().then(function (week) {
                return loadTimetable().then(function (result) {
                    return JSON.stringify({
                        year: params.yearid,
                        term: params.termid,
                        termText: term ? term.text : '',
                        today: todayIso(),
                        firstClassDate: week.firstDate,
                        weekCount: week.weekCount,
                        timeSlots: result.timeSlots,
                        rows: result.rows
                    });
                });
            });
        });
    }

    if (!onJwHost()) throw new Error(NOT_JW_TEXT);
    if (onLoginPage()) throw new Error(LOGIN_TEXT);
    return collect();
})()
