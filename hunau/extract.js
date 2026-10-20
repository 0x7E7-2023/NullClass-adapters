(function () {
    // 湖南农业大学教务适配器 —— 强智科技「高校综合管理教务系统」学生端（/jsxsd/），只支持经学校 WebVPN（webvpn.hunau.edu.cn）访问。
    // 第一步：只取数，把教务的原始数据原样交出去，解释全在 parse.js。
    //
    // 移植自 shiguang_warehouse 的 HUNAU/hunau_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 salt-fishes）
    // 上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a，本校脚本最后一次修改 6b6fee4。详见 AUDIT.md。
    //
    // 取数方式（与上游一致：按当前页面路径里 /jsxsd/ 之前的那段当前缀，即 WebVPN 的 /https/<十六进制>）：
    //   ① GET  <前缀>/jsxsd/xskb/xskb_list.do               读「学年学期」下拉框 #xnxq01id 的默认项（只有当前页面就是本人学期课表页
    //                                                          /jsxsd/xskb/ 下、且有该下拉框或屏幕上已有课表时才跳过；班级 / 教室 / 教师
    //                                                          课表等其它页面上的课表和下拉框一律不用）
    //   ② GET  <前缀>/jsxsd/xskb/xskb_list.do?xnxq01id=<学期>  取课表页（页面上已有课表、或 ① 返回的页面就带着本学期课表时跳过）
    //   ③ POST <前缀>/jsxsd/xskb/xskb_list.do                体 xnxq01id=<学期>&sfFD=1，② 的返回里没有课表表格时才发
    //   ④ POST <前缀>/jsxsd/jxzl/jxzl_query                  体 xnxq01id=<学期>，教学周历（取第 1 周的日期当开学日），失败不影响取课表
    // 全部是页面同源的相对路径，登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗问学期（上游用单选框列出所有学期）：取页面上「学年学期」下拉框的选中项（用户切到哪一学期就导入哪一学期）；
    //      下拉框没有标出选中项时取第一项，由 parse.js 提醒
    //   ③ 只交原始结构：课表按网格还原（每格的列号 col / 跨列数 span / 明细 HTML），行标签与星期表头的短文字，
    //      教学周历按网格交出日期格；周次 / 节次 / 课名 / 节次时间的解释与合并全在 parse.js（CI 里能真跑）
    //   ④ 上游把格内的两份内容（类名 kbcontent 的明细、kbcontent1 的简表）混在一起择优；这里分开交（parts / briefParts），
    //      parse.js 优先用明细，简表只补明细里没有的
    //   ⑤ 上游从课表行标题（如「第一大节 08:00-09:40」）推节次时间：这里把行标签的短文字交给 parse.js 去推
    //   ⑥ 上游在不是 /jsxsd/ 路径下弹框提示：这里先查主机与路径，不在本校教务系统里、或停在登录页 / 入口页上
    //      就直接报大白话提示，不发任何请求；页面上有账号 / 密码输入框也不发
    //   ⑦ 上游的 showAlert / showToast / saveCourseConfig / savePresetTimeSlots / saveImportedCourses / notifyTaskCompletion
    //      等界面调用全部去掉（保存由应用负责）
    //   ⑧ 交出的对象只有 parse.js 用得到的字段：提取日期、学期、课表格子、周历日期格（页面地址、查询串、页面其它文字都不交）
    var WEBVPN_HOST = 'webvpn.hunau.edu.cn';
    var JSXSD = '/jsxsd/';
    var KB_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var MAX_PAGE_BODY = 3000000;   // 课表页 / 周历页超过这个长度就不认
    var TEXT_MAX_LENGTH = 40;      // 非课格子的文字最多交这么长
    var CN_DATE = /\d{4}\s*[-年]\s*\d{1,2}\s*[-月]\s*\d{1,2}/;
    var FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };
    var LOGIN_HINT = '请先登录学校的 WebVPN，进入教务系统并打开学期理论课表，确认能看到课表再点「提取课表」';
    var NOT_JW_TEXT = '请通过学校 WebVPN（' + WEBVPN_HOST + '）登录教务系统、打开学期理论课表后再点「提取课表」';
    var OUTSIDE_TEXT = '当前还没有进入教务系统（这里是 WebVPN 或统一认证页面）。' + LOGIN_HINT;
    var LOGIN_TEXT = '当前打开的是教务系统的登录页或入口页。' + LOGIN_HINT;
    var EXPIRED_TEXT = '登录状态已失效，请重新登录。' + LOGIN_HINT;

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function clip(text, max) {
        var one = String(text);
        return one.length > max ? one.substring(0, max) : one;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。教务给不出开学日时由 parse.js 用它推算第 1 周。
    // 不能用 toISOString：北京时间早上 8 点前它会退到前一天。
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function tagOf(node) {
        return String((node && node.tagName) || '').toUpperCase();
    }

    function attrOf(node, name) {
        return node && node.getAttribute ? String(node.getAttribute(name) || '') : '';
    }

    function spanOfAttr(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return value >= 1 ? value : 1;
    }

    // ---------- 当前页面在哪 ----------
    // 'jw'      —— WebVPN 主机上、路径里有 /jsxsd/ 的教务内页：可以取数，前缀 = /jsxsd/ 之前那段；
    //              onKbPage 为真表示当前页就是本人学期课表页（/jsxsd/xskb/ 下），只有这种页面上的课表和学期下拉框才直接用
    // 'login'   —— 教务系统的根路径 / 登录页 / 单点登录页
    // 'outside' —— WebVPN 主机上但路径里没有 /jsxsd/（WebVPN 首页、登录页等）
    // 'other'   —— 别的主机（含校内直连的教务主机、别校域名：本件只支持 WebVPN）

    function locate() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        if (host !== WEBVPN_HOST) return { kind: 'other' };
        var path = String(loc.pathname || '');
        var lower = path.toLowerCase();
        if (lower.substring(lower.length - 6) === '/jsxsd') {
            path += '/';
            lower += '/';
        }
        var at = lower.indexOf(JSXSD);
        if (at < 0) return { kind: 'outside' };
        var rest = lower.substring(at + JSXSD.length);
        if (rest === '' || rest.indexOf('login') >= 0 || rest.indexOf('sso') === 0) return { kind: 'login' };
        return { kind: 'jw', prefix: path.substring(0, at), onKbPage: rest.indexOf('xskb/') === 0 };
    }

    // 页面上有账号 / 密码输入框就是登录页。只看有没有这个输入框，不读它的值
    function hasLoginForm(doc) {
        if (!doc) return false;
        if (doc.getElementById && (doc.getElementById('userAccount') || doc.getElementById('userPassword'))) return true;
        return !!(doc.querySelector && doc.querySelector('input[type="password"]'));
    }

    // ---------- 课表表格 ----------
    // 一格里的课程明细：强智把课程名 + 教师 / 周次(节次) / 教室写在类名是 kbcontent（明细）或 kbcontent1（简表）的 div 里。
    // 类名按词比对，kbcontent 与 kbcontent1 分开交
    function hasClassName(node, name) {
        var classes = ' ' + String(node.className || '').replace(/\s+/g, ' ') + ' ';
        return classes.indexOf(' ' + name + ' ') >= 0;
    }

    function partsOf(cell, name) {
        var divs = cell.getElementsByTagName('div');
        var parts = [];
        for (var i = 0; i < divs.length; i++) {
            if (!hasClassName(divs[i], name)) continue;
            var html = String(divs[i].innerHTML || '').trim();
            if (html && html.replace(/&nbsp;/gi, '').trim() !== '') parts.push(html);
        }
        return parts;
    }

    // 非课格子（表头、节次标签、备注行）的文字只留 parse 用得到的两种：「星期x」，以及带数字或「节」的短标签
    // （如「第一大节 08:00-09:40」「第3-4节」）；跨了几列的格子（备注行、合并格）一律不交文字
    function keepText(text, span) {
        if (span !== 1) return false;
        if (/^(星期|周)[一二三四五六日天七]$/.test(text)) return true;
        return text.length <= TEXT_MAX_LENGTH && /[0-9节]/.test(text);
    }

    function cellOf(node, col, span) {
        var parts = partsOf(node, 'kbcontent');
        var briefParts = partsOf(node, 'kbcontent1');
        var text = '';
        if (!parts.length && !briefParts.length) {
            var raw = node.textContent !== undefined ? node.textContent : node.innerText;
            text = clean(raw);
            if (!keepText(text, span)) text = '';
        }
        return { col: col, span: span, text: text, parts: parts, briefParts: briefParts };
    }

    // 逐行还原网格列：carry[c] 记着第 c 列还被上面几行的跨行格子占着几行。
    // 占着的列跳过（并消耗一行），剩下的格子依次落到空列上。
    function gridRow(row, carry, make) {
        var out = [];
        var occupied = {};
        for (var k = 0; k < carry.length; k++) {
            if (carry[k] > 0) {
                occupied[k] = true;
                carry[k] = carry[k] - 1;
            }
        }
        var col = 0;
        var kids = row.children || [];
        for (var i = 0; i < kids.length; i++) {
            var tag = tagOf(kids[i]);
            if (tag !== 'TD' && tag !== 'TH') continue;
            while (occupied[col]) col++;
            var span = spanOfAttr(kids[i], 'colspan');
            var rowSpan = spanOfAttr(kids[i], 'rowspan');
            out.push(make(kids[i], col, span));
            if (rowSpan > 1) {
                for (var s = 0; s < span; s++) carry[col + s] = rowSpan - 1;
            }
            col += span;
        }
        return out;
    }

    function closestTable(el) {
        var node = el;
        while (node && node.nodeType === 1) {
            if (tagOf(node) === 'TABLE') return node;
            node = node.parentNode;
        }
        return null;
    }

    // 课表容器：强智新旧版本分别用 #timetable 与 #kbtable（上游同样两个都认）；都没有就找最近一张含 kbcontent 格子的表
    function findTimetableTable(doc) {
        var byId = doc.getElementById('timetable') || doc.getElementById('kbtable');
        if (byId) return byId;
        var cell = doc.querySelector ? doc.querySelector('.kbcontent, .kbcontent1') : null;
        return cell ? closestTable(cell) : null;
    }

    // 只保留有文字或有课程明细的行，但每行都先走一遍还原，跨行标记才不会错位
    function timetableRows(table) {
        var out = [];
        var carry = [];
        var trs = table.rows || table.getElementsByTagName('tr');
        for (var r = 0; r < trs.length; r++) {
            var cells = gridRow(trs[r], carry, cellOf);
            for (var c = 0; c < cells.length; c++) {
                if (cells[c].text || cells[c].parts.length || cells[c].briefParts.length) {
                    out.push(cells);
                    break;
                }
            }
        }
        return out;
    }

    // 有课内容的格子数：判断这一页算不算「拿到了课表」
    function courseCells(rows) {
        var count = 0;
        for (var r = 0; r < rows.length; r++) {
            for (var c = 0; c < rows[r].length; c++) {
                if (rows[r][c].parts.length || rows[r][c].briefParts.length) count++;
            }
        }
        return count;
    }

    // 学年学期：下拉框（id 或 name 含 xnxq，强智是 xnxq01id），值形如 2026-2027-1。
    // fetched 为真（页面是我们请求回来的）：所有选项都没有 selected 属性 = 教务没有标出当前学期，取第一项并标 select-first；
    // 屏幕上的页面不算（下拉框可能是用户自己选的，选中状态不在属性里）。
    function readTerm(doc, fetched) {
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length; i++) {
            var identity = String(selects[i].id || '') + ' ' + String(selects[i].name || '');
            if (identity.indexOf('xnxq') < 0) continue;
            var options = selects[i].options || [];
            var marked = false;
            var code = null;
            var name = null;
            var firstCode = null;
            var firstName = null;
            for (var j = 0; j < options.length; j++) {
                if (options[j].hasAttribute && options[j].hasAttribute('selected')) marked = true;
                var value = clean(options[j].value);
                if (!/^\d{4}-\d{4}-\d$/.test(value)) continue;
                if (firstCode === null) {
                    firstCode = value;
                    firstName = clean(options[j].text);
                }
                if (options[j].selected && (!fetched || options[j].hasAttribute('selected'))) {
                    code = value;
                    name = clean(options[j].text);
                }
            }
            if (code) return { code: code, name: name, source: 'select-selected' };
            if (firstCode) return { code: firstCode, name: firstName, source: fetched && !marked ? 'select-first' : 'select-selected' };
        }
        return { code: null, name: null, source: 'none' };
    }

    function harvestPage(doc, fetched) {
        var table = findTimetableTable(doc);
        var rows = table ? timetableRows(table) : [];
        return { hasTable: !!table, term: readTerm(doc, fetched), rows: rows };
    }

    // ---------- 教学周历 ----------
    // 周历：首列是周次，其余格子是当周每天的日期（日期挂在 td 的 title 上，如 2026年08月31；有的部署写成格子文字）。
    // 只交有文字或有 title 的格子，保留网格列号：parse.js 要靠列号认「星期一在哪一列」
    function calendarCell(node, col) {
        var item = { col: col };
        var text = clip(clean(node.textContent), 20);
        if (text) item.text = text;
        var title = clip(clean(attrOf(node, 'title')), 40);
        if (title) item.title = title;
        return item;
    }

    function findCalendarTable(doc) {
        var tables = doc.getElementsByTagName('table');
        for (var t = 0; t < tables.length; t++) {
            var cells = tables[t].getElementsByTagName('td');
            for (var i = 0; i < cells.length; i++) {
                if (CN_DATE.test(attrOf(cells[i], 'title'))) return tables[t];
            }
        }
        return tables.length ? tables[0] : null;
    }

    function calendarRows(table) {
        var out = [];
        var carry = [];
        var trs = table.rows || table.getElementsByTagName('tr');
        for (var r = 0; r < trs.length; r++) {
            var cells = gridRow(trs[r], carry, function (node, col) { return calendarCell(node, col); });
            var keep = [];
            for (var c = 0; c < cells.length; c++) {
                if (cells[c].text || cells[c].title) keep.push(cells[c]);
            }
            if (keep.length) out.push(keep);
        }
        return out;
    }

    // ---------- 请求 ----------
    function htmlDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    function request(method, url, body) {
        var options = { method: method, credentials: 'include' };
        if (method === 'POST') {
            options.headers = FORM_HEADERS;
            options.body = body;
        }
        return fetch(url, options).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('教务系统拒绝访问（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效，或网络不通。' + LOGIN_HINT);
        }).then(function (text) {
            if (text.length > MAX_PAGE_BODY) throw new Error('教务系统返回的内容异常（过长），请重新登录后再点「提取课表」');
            return text;
        });
    }

    // 页面（课表页）请求：返回收集好的页面；登录页（有账号 / 密码输入框）报登录已失效
    function requestPage(method, url, body) {
        return request(method, url, body).then(function (text) {
            var doc = htmlDoc(text);
            if (hasLoginForm(doc) && !findTimetableTable(doc)) throw new Error(EXPIRED_TEXT);
            return harvestPage(doc, true);
        });
    }

    // 周历取不到（教务改了页面、这一学期没有周历）不算致命：交空，开学日由 parse.js 推算并说明
    function fetchCalendar(jwUrl, term) {
        return request('POST', jwUrl(CALENDAR_PATH), 'xnxq01id=' + encodeURIComponent(term.code)).then(function (text) {
            var table = findCalendarTable(htmlDoc(text));
            var rows = table ? calendarRows(table) : [];
            return { found: rows.length > 0, rows: rows };
        }, function () {
            return { found: false, rows: [] };
        });
    }

    function payloadOf(term, page, calendar) {
        return JSON.stringify({
            now: todayIso(),
            term: term,
            calendar: calendar,
            rows: page.rows
        });
    }

    function run(where) {
        var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
        function jwUrl(path) {
            return origin + where.prefix + path;
        }

        // 取到课表页后收尾：没有课表 / 课表是空的报错，有就取周历再交出去
        function finish(term, page) {
            if (!page || !page.hasTable) {
                throw new Error('教务返回的页面里没有课表（' + term.code + '）。' + LOGIN_HINT);
            }
            if (courseCells(page.rows) === 0) {
                throw new Error('教务返回的课表是空的（' + term.code + '）：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
            }
            return fetchCalendar(jwUrl, term).then(function (calendar) {
                return payloadOf(term, page, calendar);
            });
        }

        // 优先 GET 带学期参数；返回里没有课表表格再退回 POST 表单（与上游一致）
        function fetchTimetable(term) {
            var url = jwUrl(KB_PATH) + '?xnxq01id=' + encodeURIComponent(term.code);
            return requestPage('GET', url, null).then(function (got) {
                if (got.hasTable) return got;
                return requestPage('POST', jwUrl(KB_PATH), 'xnxq01id=' + encodeURIComponent(term.code) + '&sfFD=1');
            });
        }

        function needTerm(term) {
            if (!term.code) throw new Error('找不到「学年学期」下拉框，没法确定要导入哪一学期。' + LOGIN_HINT);
            return term;
        }

        // 只有本人学期课表页（/jsxsd/xskb/ 下）上的课表和学期下拉框才直接用；班级 / 教室 / 教师课表等其它页面
        // （哪怕页面上也有课表表格和 xnxq01id 下拉框）一律不用，去取本人的 xskb_list.do
        var live = where.onKbPage ? harvestPage(document, false) : { hasTable: false, term: { code: null, name: null, source: 'none' }, rows: [] };

        // 屏幕上已有课表：直接用（用户此刻看到的那张，不多发课表请求）；学期取屏幕上下拉框的选中项，
        // 屏幕上找不到下拉框就取教务默认学期，由 parse.js 提醒
        if (courseCells(live.rows) > 0) {
            if (live.term.code) return finish(live.term, live);
            return requestPage('GET', jwUrl(KB_PATH), null).then(function (first) {
                var term = needTerm(first.term);
                term.source = 'page-default';
                return finish(term, live);
            });
        }

        // 当前页是本人学期课表页、且下拉框有合法选中项：用户看着哪一学期就导入哪一学期
        if (where.onKbPage && live.term.code) {
            return fetchTimetable(live.term).then(function (page) {
                return finish(live.term, page);
            });
        }

        // 其余情况：GET 一次课表页读默认学期；这一页本身带着本学期课表就直接用，不再多发
        return requestPage('GET', jwUrl(KB_PATH), null).then(function (first) {
            var term = needTerm(first.term);
            if (courseCells(first.rows) > 0) return finish(term, first);
            return fetchTimetable(term).then(function (page) {
                return finish(term, page);
            });
        });
    }

    return Promise.resolve().then(function () {
        var where = locate();
        if (where.kind === 'other') throw new Error(NOT_JW_TEXT);
        if (where.kind === 'outside') throw new Error(OUTSIDE_TEXT);
        if (where.kind === 'login') throw new Error(LOGIN_TEXT);
        if (hasLoginForm(document) && !findTimetableTable(document)) throw new Error(LOGIN_TEXT);
        return run(where);
    });
})()
