(function () {
    // 湖南科技大学 教务适配器 —— 强智科技「高校综合管理教务系统」（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 HNUST/HNUST_01.js（MIT，上游作者 dezige131）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/HNUST/adapters.yaml：adapter_name「湖南科技大学适配教务」，maintainer「dezige131」，
    //   import_url = https://kdjw.hnust.edu.cn/ ，说明里要求用企业微信登录。
    // 上游快照 7c9e190；本校脚本最后一次修改 80e30cf（2026-09-23）。任务卡写的是 03d161a，对不上，以 git log 为准。
    // 模板是已审计的 zsc（强智 /jsxsd/）。本校上游只请求课表页，没有教学周历。
    //
    // 平台判据按脚本实际请求的路径，不按注释：
    //   GET /jsxsd/xskb/xskb_list.do   课表页（表格 id 是 timetable，明细在 div.kbcontent）
    // 上游在用户改选学期时才会 POST 同一地址，请求体只有 xnxq01id。这里不弹窗改学期，所以不发这次 POST。
    //
    // 取数方式：
    //   ① 当前页已经有课表格子 → 直接用（用户此刻看到的那张）；
    //   ② 否则 GET 课表页。
    // 学年学期只读下拉框 #xnxq01id（id 或 name 含 xnxq）的选中项，不弹窗。
    // 节次时间有夏季、非夏季两套，页面上看不出来，问一次；问不到就交给 parse.js 按非夏季并提醒。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从列表里选学期：学期取下拉框的选中项；
    //   ② 两套节次时间不沿用上游的拾光弹窗，改问一次；取消或问不了都交 null；
    //   ③ 只交原始结构出去（学期、季节选择、每格的网格列号与原始 HTML），周次和节次的解释全在 parse.js；
    //   ④ 去掉上游的 showAlert / showToast / saveImportedCourses / savePresetTimeSlots / notifyTaskCompletion；
    //   ⑤ 课程明细只读类名正好是 kbcontent 的 div；
    //   ⑥ 页面地址只交协议、主机与路径，不交查询串；课表页上找不到学年学期下拉框时带 screenTermMissing；
    //   ⑦ 首页、登录页、统一认证页上点提取：不发请求，提示用企业微信登录后再打开课表。
    //
    // 只请求当前页同源的相对路径：不读账号密码、不写页面、不外发任何数据。详见 AUDIT.md。
    var JW_HOST = 'kdjw.hnust.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var LOGIN_HINT = '请先用企业微信登录教务系统，打开「课表查询」，确认能看到课表再点提取';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。教务给不出开学日时由 parse.js 用它推算第 1 周的周一。
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

    // 首页 / 登录页 / 统一认证页：不发请求。本校登录走企业微信，这里不自己做登录。
    // 只看地址，不读页面上的任何输入框。
    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host !== JW_HOST) {
            return '当前打开的不是湖南科技大学教务系统。请先用企业微信登录，再打开「课表查询」，然后点提取';
        }
        if (path === '/' || path === '') {
            return '当前打开的是教务首页。请先用企业微信登录，再打开「课表查询」，然后点提取';
        }
        if (/login|cas|weixin|wechat|wwopen/.test(path) || /^\/jsxsd\/?$/.test(path) || /^\/jsxsd\/(index|xk\/log)/.test(path)) {
            return '当前打开的是登录页。请先用企业微信登录教务系统，再打开「课表查询」，然后点提取';
        }
        return '';
    }

    // 一格里的课程明细：只认类名正好是 kbcontent 的 div（简写副本不读）。
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

    function cellOf(node, col, span) {
        var text = node.textContent !== undefined ? node.textContent : node.innerText;
        return { col: col, span: span, text: clean(text), parts: partsOf(node) };
    }

    function spanOfAttr(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return value >= 1 ? value : 1;
    }

    // carry[c] = 第 c 列还被前面某一行的 rowspan 占着几行（不含当前行）。
    function cellsOfRow(row, carry) {
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
            out.push(cellOf(kids[i], col, span));
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

    // 课表容器：上游写死表格 id timetable。认不出再找最近一张含课表明细的表。
    function findScheduleTable(doc) {
        var byId = doc.getElementById('timetable');
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
            var cells = cellsOfRow(trs[r], carry);
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

    function courseCells(rows) {
        var count = 0;
        for (var r = 0; r < rows.length; r++) {
            for (var c = 0; c < rows[r].length; c++) {
                if (rows[r][c].parts.length) count++;
            }
        }
        return count;
    }

    // 学年学期：只读选中项。值形如 2026-2027-1。
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

    // 夏季 / 非夏季看不出来，又会改掉全部上课时间，所以问一次。问不了或取消都交 null。
    function askSeason() {
        if (typeof __ncCapabilities === 'undefined' || !__ncCapabilities || !__ncCapabilities.ask) {
            return Promise.resolve(null);
        }
        if (typeof __ncSelect !== 'function') return Promise.resolve(null);
        return __ncSelect({
            title: '选择节次时间',
            message: '学校有夏季和非夏季两套节次时间，下午和晚上差半小时。请按你现在用的那一套选，选错会让上课时间整体偏移。',
            items: [
                '非夏季（第 5 节 14:00 上课）',
                '夏季（第 5 节 14:30 上课）'
            ],
            defaultIndex: 0
        }).then(function (index) {
            if (index === 0 || index === 1) return index;
            return null;
        });
    }

    var hint = loginHint();
    if (hint) throw new Error(hint);

    var live = harvestPage(document);
    var onScreen = courseCells(live.rows) > 0;

    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function payloadOf(flight, missing, season) {
        return JSON.stringify({
            source: 'qz-jsxsd',
            pageUrl: pageUrlOf(),
            now: todayIso(),
            term: flight.term,
            screenTermMissing: missing === true,
            season: season,
            cols: flight.cols,
            rows: flight.rows
        });
    }

    function finish(flight, missing) {
        return askSeason().then(function (season) {
            return payloadOf(flight, missing, season);
        });
    }

    if (onScreen) return finish(live, !live.term.code);

    return requestGet(SCHEDULE_PATH).then(function (html) {
        var got = harvestPage(htmlDoc(html));
        if (courseCells(got.rows) === 0) {
            if (!got.term.code) {
                throw new Error('找不到学年学期：课表页没有「学年学期」下拉框。' + LOGIN_HINT);
            }
            throw new Error('教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
        }
        return finish(got, !got.term.code);
    });
})()
