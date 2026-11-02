(function () {
    // 江苏师范大学教务适配器 —— 强智旧版表格（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 JSNU/JSNU_01.js（MIT，上游作者 dezige131）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 03d161a；本校脚本最后一次修改 1fe584c。模板是已审计的 xaut。
    // 上游 import_url 是学校门户；实际课表请求为同源 /jsxsd/xskb/xskb_list.do，
    // 本件使用该校强智入口 sdjw.jsnu.edu.cn，并只接受这台主机的课表页面。
    // 当前页有课表就直接读，否则 GET 课表页；学期只读下拉框选中项，不弹窗、不换学期。
    // 只交学期、网格列号、行首文字和课程明细；周次与节次全在 parse.js。
    // 删除拾光提示与保存桥，去除 item-box，页面地址不带查询串，登录页和门户不发请求。
    // 不读账号密码、不写页面、不外发任何数据。详见 AUDIT.md。
    var JW_HOST = 'sdjw.jsnu.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var LOGIN_HINT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
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

    // 登录页 / 统一认证页 / 门户页 / 教务首页：不发请求，给大白话提示。
    // 强智的 /jsxsd/ 根路径、index、login、xk/LoginToXk 都是登录表单。
    // 学校教务入口本身是站点根路径（协议是 http），同样不发请求。
    // 主机不是本校教务时相对路径会打到别处，同样不发。只看地址，不读页面上的任何输入框。
    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host !== JW_HOST) {
            return '当前打开的不是江苏师范大学教务系统。请先登录教务系统，再打开「课表查询」，然后点提取';
        }
        if (path === '/' || path === '' || /^\/jsxsd\/?$/.test(path) || /^\/jsxsd\/(index|login|xk\/log)/.test(path)) {
            return '当前打开的是登录页。请先登录教务系统，再打开「课表查询」，然后点提取';
        }
        return '';
    }

    // 去掉 class 含 item-box 的块（上游在读课名前删掉它）。不用词边界转义，避免写文件时被吃掉。
    function stripItemBox(html) {
        return String(html).replace(/<div\b[^>]*class\s*=\s*["'][^"']*item-box[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');
    }

    // 一格里的课程明细：强智把课程名 + 教师 / 周次(节次) / 教室写在类名正好是 kbcontent 的 div 里。
    // 只认这个类名（上游也只读它；kbcontent1 之类的简写副本不读）。
    function partsOf(cell) {
        var divs = cell.getElementsByTagName('div');
        var parts = [];
        for (var i = 0; i < divs.length; i++) {
            var classes = ' ' + String(divs[i].className || '').replace(/\s+/g, ' ') + ' ';
            if (classes.indexOf(' kbcontent ') < 0) continue;
            var html = stripItemBox(String(divs[i].innerHTML || '')).trim();
            if (html && html !== '&nbsp;') parts.push(html);
        }
        return parts;
    }

    function textOf(node) {
        // 在副本上删 item-box 再读文字。副本不插回页面，避免把二维码或学号写进格子的 text。
        var copy = node.cloneNode ? node.cloneNode(true) : node;
        if (copy !== node && copy.querySelectorAll) {
            var boxes = copy.querySelectorAll('.item-box');
            for (var i = boxes.length - 1; i >= 0; i--) {
                var parent = boxes[i].parentNode;
                if (parent) parent.removeChild(boxes[i]);
            }
        }
        var text = copy.textContent !== undefined ? copy.textContent : copy.innerText;
        return clean(text);
    }

    function cellOf(node, col, span) {
        return { col: col, span: span, text: textOf(node), parts: partsOf(node) };
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

    // 课表容器：上游写死 #timetable。认不出就退到 #kbtable，再退到最近一张含 .kbcontent 的表。
    function findScheduleTable(doc) {
        var byId = doc.getElementById('timetable');
        if (byId) return byId;
        byId = doc.getElementById('kbtable');
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

    // 学年学期：课表页顶部的下拉框（强智是 select[id|name 含 xnxq]，值形如 2026-2027-1）。
    // 只读选中项。页面上有课表时，以页面那份为准。
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

    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function payloadOf(flight) {
        return JSON.stringify({
            source: 'qz-jsxsd',
            pageUrl: pageUrlOf(),
            now: todayIso(),
            term: flight.term,
            screenTermMissing: flight.screenTermMissing === true,
            cols: flight.cols,
            calendar: { found: false, rows: [] },
            rows: flight.rows
        });
    }

    var hint = loginHint();
    if (hint) throw new Error(hint);

    var live = harvestPage(document);
    var onScreen = courseCells(live.rows) > 0;

    if (onScreen) {
        return payloadOf({
            term: live.term.code ? live.term : { code: null, name: null },
            cols: live.cols,
            rows: live.rows,
            screenTermMissing: !live.term.code
        });
    }

    return fetch(SCHEDULE_PATH, { method: 'GET', credentials: 'same-origin' }).then(function (response) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('教务系统拒绝访问（' + response.status + '）：' + LOGIN_HINT);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
        }
        return response.text().then(function (html) {
            var got = harvestPage(htmlDoc(html));
            if (!got.term.code) {
                throw new Error('找不到学年学期：课表页没有「学年学期」下拉框。' + LOGIN_HINT);
            }
            if (courseCells(got.rows) === 0) {
                throw new Error('教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
            }
            return payloadOf({ term: got.term, cols: got.cols, rows: got.rows });
        });
    }, function () {
        throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
    });
})()
