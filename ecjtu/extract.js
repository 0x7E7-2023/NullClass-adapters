(function () {
    // 华东交通大学教务适配器（教务系统自带的课表页 DOM 表格）
    // 移植自 shiguang_warehouse 的 ECJTU/ecjtu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 glxgo）
    //   上游快照 baf83fa；本校脚本提交 1fe584c（2026-08-23）
    // 取数方式：教务课表页 #courseSche 是一张服务端渲染的 HTML 表，一格一天，
    // 格子里的文字按「课名 / 教师@地点 / 周次 节次」三行一组排列。
    // 三个来源，按代价从小到大：
    //   ① 当前页面（含同源 iframe）已有 #courseSche → 直接用，不发请求
    //   ② GET /Schedule/Schedule_getUserSchedume.action?item=0207
    //   ③ 同地址 ?item=0205，再不行用无参数地址；返回的 HTML 里有 #courseSche 才用
    // 地址一律用当前页面的 origin 拼（只请求同源），manifest 的 allowHosts 为空。
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① ES6 改成 ES5：去掉箭头函数、模板串、块级变量声明、异步函数与 Map / Set
    //   ② 删掉上游的确认弹窗、toast、保存调用；只取数，课表由空课自己的导入流程处理
    //   ③ 不再要求课程格子里一定有「教师@地点」行（上游没有 @ 的整格丢弃），
    //      每格的每一行文字原样交出去，缺教师 / 缺教室由 parse.js 记账并提醒
    //   ④ 交出去的是 {now, term, rows}：rows 是每个格子的行文字数组，
    //      星期列、周次、节次、课程合并全部交给 parse.js（CI 能真跑的那一段）
    //   ⑤ 登录页 / 需要登录的页面零请求：/index.action 上或带密码输入框的页面直接提示
    //   ⑥ 三个备用地址都没拿到课表时，把「教务系统返回错误（代码 N）」与
    //      「返回了页面但页面里没有课表」分成两种提示，不混成一句
    // 只请求本校教务主机：不读账号密码、不写页面、不外发任何数据。
    var SCHEDULE_PATHS = [
        '/Schedule/Schedule_getUserSchedume.action?item=0207',
        '/Schedule/Schedule_getUserSchedume.action?item=0205',
        '/Schedule/Schedule_getUserSchedume.action'
    ];
    var LOGIN_HINT = '请先登录教务系统（https://jwxt.ecjtu.edu.cn/index.action），' +
        '打开「我的课表 / 个人课表」页面，确认能看到课表后再点「提取课表」';
    var ZERO_WIDTH = new RegExp('[' + String.fromCharCode(8203, 8204, 8205, 65279) + ']', 'g');
    var NBSP = String.fromCharCode(160);

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(ZERO_WIDTH, '')
            .replace(new RegExp(NBSP, 'g'), ' ')
            .replace(/\s+/g, ' ')
            .trim();
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

    // 一格里的文字按行拆开。活页面优先用 innerText（会排除隐藏元素）；
    // DOMParser 造出来的惰性文档里 innerText 等于 textContent、拿不到换行，
    // 这时改从 innerHTML 把 br / 块级标签换成换行再剥标签。
    function linesOf(cell) {
        var html = cell && cell.innerHTML !== undefined ? String(cell.innerHTML) : '';
        var raw = '';
        try {
            raw = cell && cell.innerText !== undefined ? String(cell.innerText) : '';
        } catch (e) {
            raw = '';
        }
        var text;
        if (raw.indexOf('\n') >= 0 || (html.indexOf('<br') < 0 && !/<\/(p|div|li|tr)>/i.test(html))) {
            text = raw || (cell && cell.textContent !== undefined ? String(cell.textContent) : '');
        } else {
            // 惰性文档拿不到 innerText 的换行，只能从 innerHTML 还原；先把 display:none 的元素
            // 整段去掉（活页面里 innerText 本来就不含它们，这里保持一致，免得把隐藏文字交出去）
            html = html.replace(/<([a-zA-Z][a-zA-Z0-9]*)[^>]*style\s*=\s*("[^"]*display\s*:\s*none[^"]*"|'[^']*display\s*:\s*none[^']*')[^>]*>[\s\S]*?<\/\1>/gi, '');
            text = decodeEntities(html
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/(p|div|li|tr)>/gi, '\n')
                .replace(/<[^>]*>/g, ''));
        }
        var pieces = String(text).split(/\r\n|\r|\n/);
        var out = [];
        for (var i = 0; i < pieces.length; i++) {
            var line = clean(pieces[i]);
            if (line) out.push(line);
        }
        return out;
    }

    function readTerm(doc) {
        var select = doc.querySelector ? doc.querySelector('#term') : doc.getElementById('term');
        if (!select) return {};
        var code = clean(select.value);
        var name = '';
        var options = select.options || [];
        var picked = null;
        var i;
        for (i = 0; i < options.length; i++) {
            if (options[i].selected) picked = options[i];
        }
        if (!picked && select.selectedIndex >= 0 && options[select.selectedIndex]) {
            picked = options[select.selectedIndex];
        }
        if (picked) {
            name = clean(picked.text !== undefined && picked.text !== null ? picked.text : picked.textContent);
        }
        return { code: code, name: name };
    }

    // 只读 #courseSche 这张表：每一行交出一个「每格若干行文字」的数组。
    // 表头与星期列由 parse.js 认，这里不猜。
    function harvest(doc) {
        var rows = [];
        var table = doc.getElementById('courseSche');
        if (table) {
            var trs = table.rows || table.getElementsByTagName('tr');
            for (var r = 0; r < trs.length; r++) {
                var kids = trs[r].children || [];
                var cells = [];
                for (var c = 0; c < kids.length; c++) {
                    var tag = String((kids[c] && kids[c].tagName) || '').toUpperCase();
                    if (tag !== 'TD' && tag !== 'TH') continue;
                    cells.push(linesOf(kids[c]));
                }
                if (cells.length) rows.push(cells);
            }
        }
        return { term: readTerm(doc), rows: rows };
    }

    // 当前页及其同源 iframe 里找课表页（跨域 iframe 访问会抛错，跳过）
    function findScheduleDoc(win, depth) {
        if (!win || depth > 3) return null;
        try {
            if (win.document && win.document.getElementById('courseSche')) return win.document;
        } catch (e) {
            return null;
        }
        var frames = null;
        try {
            frames = win.frames;
        } catch (e2) {
            return null;
        }
        if (!frames) return null;
        for (var i = 0; i < frames.length; i++) {
            var found = findScheduleDoc(frames[i], depth + 1);
            if (found) return found;
        }
        return null;
    }

    // 登录页判断：/index.action 上没有课表结构，或页面上有密码输入框（只看有没有，不读值）。
    function isLoginPage(doc) {
        var path = '';
        try {
            path = String((window.location && window.location.pathname) || '');
        } catch (e) {
            path = '';
        }
        if (/\/index\.action$/i.test(path)) return true;
        if (doc && doc.querySelector && doc.querySelector('input[type=password]')) return true;
        return false;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取当天日期。只用于教务给不出开学日时推算第 1 周，不是页面内容。
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function originOf() {
        var loc = window.location;
        if (!loc) return '';
        var origin = loc.origin;
        if (!origin && loc.protocol) origin = String(loc.protocol) + '//' + String(loc.host);
        return String(origin || '');
    }

    function payloadOf(flight) {
        return JSON.stringify({
            now: todayIso(),
            term: flight.term,
            rows: flight.rows
        });
    }

    var live = findScheduleDoc(window, 0);
    if (live) return payloadOf(harvest(live));

    if (isLoginPage(document)) {
        throw new Error(LOGIN_HINT);
    }

    var base = originOf();
    var hostName = '';
    try {
        hostName = String((window.location && window.location.hostname) || '').toLowerCase();
    } catch (e) {
        hostName = '';
    }
    if (!(hostName === 'ecjtu.edu.cn' || /(^|[.])ecjtu[.]edu[.]cn$/.test(hostName))) {
        throw new Error('当前页面不是华东交通大学教务系统：' + LOGIN_HINT);
    }

    var index = 0;
    var lastStatus = 0;
    var gotHtml = false;

    function tryNext() {
        if (index >= SCHEDULE_PATHS.length) return null;
        var url = base + SCHEDULE_PATHS[index];
        index++;
        return fetch(url, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                lastStatus = response.status;
                return tryNext();
            }
            return response.text().then(function (html) {
                gotHtml = true;
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                if (doc.getElementById('courseSche')) return doc;
                return tryNext();
            });
        }, function () {
            return tryNext();
        });
    }

    return tryNext().then(function (doc) {
        if (doc) return payloadOf(harvest(doc));
        if (gotHtml) {
            throw new Error(
                '教务系统返回的页面里没有找到课表：' + LOGIN_HINT
            );
        }
        if (lastStatus) {
            throw new Error(
                '教务系统返回错误（代码 ' + lastStatus + '）：登录状态可能已失效，' + LOGIN_HINT
            );
        }
        throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
    });
})()
