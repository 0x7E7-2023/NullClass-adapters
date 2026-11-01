(function () {
    // 仲恺农业工程学院 教务适配器 —— 强智科技「高校综合管理教务系统」（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 ZHKU/zhku_lc6464.js（MIT，上游作者 lc6464）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/ZHKU/adapters.yaml：adapter_name「强智教务 - 学期理论课表」，maintainer「lc6464」，
    //   import_url = https://edu-admin.zhku.edu.cn/
    // 上游快照 03d161a；本校脚本最后一次修改 22ac6bc。
    // 模板是已审计的 zsc（强智 /jsxsd/，课表格子与周历网格同构）。本校上游用 GET 而不是 POST，
    // 节次时间按校区从起始时刻推出来，主机只可能是 edu-admin.zhku.edu.cn。
    //
    // 平台判据按脚本实际请求的路径，不按注释：
    //   GET /jsxsd/xskb/xskb_list.do                 当前学期理论课表（页面上没有课表时才请求）
    //   GET /jsxsd/jxzl/jxzl_query?xnxq01id=<学期>  教学周历
    //   GET /jsxsd/framework/xsMain_new.htmlx       首页时间模式，用来判断海珠 / 白云校区
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户选学年学期：学期取课表页下拉框的选中项；
    //   ② 校区先读首页时间模式；读不出来才问一次海珠还是白云（节次时间差一截，不问会导错上课时间）；
    //   ③ 只交原始结构出去（学期、校区、每格的网格列号 / 跨列数 / 原始 HTML、周历网格），
    //      周次、节次、教室整理、网络课过滤都在 parse.js；
    //   ④ 去掉上游的弹窗、提示、保存配置（脚本对页面只读）；
    //   ⑤ 登录页和带登录表单的页面不发请求，也不读密码框；
    //   ⑥ 页面地址只交协议、主机与路径，不交查询串。
    //
    // 只请求当前页面同源的教务（edu-admin.zhku.edu.cn）的相对路径。详见 AUDIT.md。
    var JW_HOST = 'edu-admin.zhku.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var CAMPUS_PATH = '/jsxsd/framework/xsMain_new.htmlx';
    var LOGIN_HINT = '请先在页面里登录教务系统并打开「学期理论课表」，确认能看到课表再点提取';
    var CN_DATE = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?/;

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

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

    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host !== JW_HOST || (path.indexOf('/jsxsd/') !== 0 && path !== '/jsxsd')) {
            return '当前打开的不是仲恺农业工程学院教务系统。请先登录教务系统，再打开「学期理论课表」，然后点提取';
        }
        if (/^\/jsxsd\/?$/.test(path) || /^\/jsxsd\/(index|login|xk\/log)/.test(path)) {
            return '当前打开的是登录页。请先登录教务系统，再打开「学期理论课表」，然后点提取';
        }
        return '';
    }

    // 只看表单的 id 和提交地址，不读用户名、密码或任何输入框。
    function hasLoginForm(doc) {
        var forms = doc.getElementsByTagName('form');
        for (var i = 0; i < forms.length; i++) {
            var id = String(forms[i].id || '');
            var action = attrOf(forms[i], 'action');
            if (id === 'loginForm' && action.indexOf('Logon.do') >= 0 && action.indexOf('method=logon') >= 0) {
                return true;
            }
        }
        return false;
    }

    function partsOf(cell) {
        var divs = cell.getElementsByTagName('div');
        var parts = [];
        for (var i = 0; i < divs.length; i++) {
            var classes = ' ' + String(divs[i].className || '').replace(/\s+/g, ' ') + ' ';
            if (classes.indexOf(' kbcontent ') < 0) continue;
            var html = String(divs[i].innerHTML || '').trim();
            if (html && html !== '&nbsp;') parts.push(html);
        }
        return parts;
    }

    function cellOf(node, col, span, withNode) {
        var text = node.textContent !== undefined ? node.textContent : node.innerText;
        var cell = { col: col, span: span, text: clean(text), parts: partsOf(node) };
        if (withNode) cell.node = node;
        return cell;
    }

    function spanOfAttr(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return value >= 1 ? value : 1;
    }

    function cellsOfRow(row, carry, withNode) {
        var out = [];
        var kids = row.children || [];
        var occupied = {};
        for (var k = 0; k < carry.length; k++) {
            if (carry[k] > 0) {
                occupied[k] = true;
                carry[k] = carry[k] - 1;
            }
        }
        var col = 0;
        for (var i = 0; i < kids.length; i++) {
            var tag = tagOf(kids[i]);
            if (tag !== 'TD' && tag !== 'TH') continue;
            while (occupied[col]) col++;
            var span = spanOfAttr(kids[i], 'colspan');
            var rowspan = spanOfAttr(kids[i], 'rowspan');
            out.push(cellOf(kids[i], col, span, withNode));
            if (rowspan > 1) {
                for (var s = 0; s < span; s++) carry[col + s] = rowspan - 1;
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

    function findScheduleTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cell = doc.querySelector ? doc.querySelector('.kbcontent') : null;
        return cell ? closestTable(cell) : null;
    }

    function scheduleGrid(table) {
        var out = [];
        var width = 0;
        var trs = table.rows || table.getElementsByTagName('tr');
        var carry = [];
        for (var r = 0; r < trs.length; r++) {
            var cells = cellsOfRow(trs[r], carry, false);
            for (var w = 0; w < cells.length; w++) {
                if (cells[w].col + cells[w].span > width) width = cells[w].col + cells[w].span;
            }
            var keep = false;
            for (var c = 0; c < cells.length; c++) {
                if (cells[c].text || cells[c].parts.length) {
                    keep = true;
                    break;
                }
            }
            if (keep) out.push(cells);
        }
        return { cols: width, rows: out };
    }

    function findCalendarTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cells = doc.getElementsByTagName('td');
        for (var i = 0; i < cells.length; i++) {
            if (CN_DATE.test(attrOf(cells[i], 'title'))) return closestTable(cells[i]);
        }
        return null;
    }

    function calendarGrid(table) {
        var out = [];
        var trs = table.rows || table.getElementsByTagName('tr');
        var carry = [];
        for (var r = 0; r < trs.length; r++) {
            var cells = cellsOfRow(trs[r], carry, true);
            var keep = [];
            for (var c = 0; c < cells.length; c++) {
                var item = { col: cells[c].col };
                if (cells[c].text) item.text = cells[c].text;
                var title = clean(attrOf(cells[c].node, 'title'));
                if (title) item.title = title;
                if (item.text || item.title) keep.push(item);
            }
            if (keep.length) out.push(keep);
        }
        return out;
    }

    function courseCells(rows) {
        var count = 0;
        for (var r = 0; r < rows.length; r++) {
            for (var c = 0; c < rows[r].length; c++) {
                if (rows[r][c].parts.length) count++;
            }
        }
        return count;
    }

    function readTerm(doc) {
        var code = null;
        var name = null;
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length && !code; i++) {
            var identity = String(selects[i].id || '') + ' ' + String(selects[i].name || '');
            if (identity.indexOf('xnxq') < 0) continue;
            var options = selects[i].options || [];
            var firstCode = null;
            var firstName = null;
            for (var j = 0; j < options.length; j++) {
                var value = clean(options[j].value);
                if (!/^\d{4}-\d{4}-\d$/.test(value)) continue;
                if (firstCode === null) {
                    firstCode = value;
                    firstName = clean(options[j].text);
                }
                if (options[j].selected) {
                    code = value;
                    name = clean(options[j].text);
                }
            }
            if (!code && firstCode) {
                code = firstCode;
                name = firstName;
            }
        }
        return { code: code, name: name };
    }

    function harvestPage(doc) {
        var table = findScheduleTable(doc);
        var grid = table ? scheduleGrid(table) : { cols: 0, rows: [] };
        return { term: readTerm(doc), cols: grid.cols, rows: grid.rows };
    }

    function htmlDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    function requestGet(url) {
        return fetch(url, {
            method: 'GET',
            credentials: 'same-origin'
        }).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('教务系统拒绝访问（' + response.status + '）：' + LOGIN_HINT);
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        });
    }

    function fetchCalendar(code) {
        if (!code) return Promise.resolve({ found: false, rows: [] });
        var url = CALENDAR_PATH + '?xnxq01id=' + encodeURIComponent(code);
        return requestGet(url).then(function (html) {
            var table = findCalendarTable(htmlDoc(html));
            var rows = table ? calendarGrid(table) : [];
            return { found: rows.length > 0, rows: rows };
        }, function () {
            return { found: false, rows: [] };
        });
    }

    // 首页 li[name=kbjcmsid]：带 layui-this 的第一项是海珠（默认），第二项是白云。
    function campusFromDoc(doc) {
        var nodes = doc.querySelectorAll ? doc.querySelectorAll('li[name="kbjcmsid"]') : [];
        if (!nodes || nodes.length < 2) return null;
        var active = -1;
        for (var i = 0; i < nodes.length; i++) {
            var cls = ' ' + String(nodes[i].className || '').replace(/\s+/g, ' ') + ' ';
            if (cls.indexOf(' layui-this ') >= 0) {
                active = i;
                break;
            }
        }
        if (active === 0) return 'haizhu';
        if (active === 1) return 'baiyun';
        if (active >= 0) {
            var text = clean(nodes[active].textContent !== undefined ? nodes[active].textContent : nodes[active].innerText);
            if (text.indexOf('白云') >= 0) return 'baiyun';
            if (text.indexOf('默认') >= 0) return 'haizhu';
        }
        return null;
    }

    function askCampus() {
        if (typeof __ncCapabilities === 'undefined' || !__ncCapabilities || !__ncCapabilities.ask) {
            return Promise.resolve(null);
        }
        if (typeof __ncSelect !== 'function') return Promise.resolve(null);
        return __ncSelect({
            title: '选择校区',
            message: '海珠校区和白云校区的上下课时间不一样。请按你实际上课的校区选，选错会让上课时间整体偏移。',
            items: [
                '海珠校区（第 1 节 08:00 上课）',
                '白云校区（第 1 节 08:40 上课）'
            ],
            defaultIndex: 0
        }).then(function (index) {
            if (index === 0) return 'haizhu';
            if (index === 1) return 'baiyun';
            return null;
        }, function () {
            return null;
        });
    }

    function resolveCampus() {
        return requestGet(CAMPUS_PATH).then(function (html) {
            var found = campusFromDoc(htmlDoc(html));
            if (found) return found;
            return askCampus();
        }, function () {
            return askCampus();
        });
    }

    var hint = loginHint();
    if (hint) throw new Error(hint);
    if (hasLoginForm(document)) {
        throw new Error('当前打开的是登录页。请先登录教务系统，再打开「学期理论课表」，然后点提取');
    }

    var live = harvestPage(document);
    var onScreen = courseCells(live.rows) > 0;

    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function payloadOf(flight, calendar, campus) {
        return JSON.stringify({
            source: 'qz-jsxsd',
            pageUrl: pageUrlOf(),
            now: todayIso(),
            term: flight.term,
            screenTermMissing: flight.screenTermMissing === true,
            campus: campus,
            cols: flight.cols,
            calendar: calendar,
            rows: flight.rows
        });
    }

    function finish(flight) {
        return fetchCalendar(flight.term && flight.term.code).then(function (calendar) {
            return resolveCampus().then(function (campus) {
                return payloadOf(flight, calendar, campus);
            });
        });
    }

    if (onScreen) {
        return finish({ term: live.term, cols: live.cols, rows: live.rows, screenTermMissing: !live.term.code });
    }

    return requestGet(SCHEDULE_PATH).then(function (html) {
        var got = harvestPage(htmlDoc(html));
        if (courseCells(got.rows) === 0) {
            if (!got.term.code) {
                throw new Error('找不到学年学期：课表页没有「学年学期」下拉框。' + LOGIN_HINT);
            }
            throw new Error('教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
        }
        return finish({ term: got.term, cols: got.cols, rows: got.rows, screenTermMissing: !got.term.code });
    });
})()
