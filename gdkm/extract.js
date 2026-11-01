(function () {
    // 广东科贸职业学院 教务适配器 —— 强智科技新版周课表（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 GDKM/GDKM.js（MIT，上游作者 qwwshs）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/GDKM/adapters.yaml：adapter_name「广东科贸职业学院强智教务」，maintainer「qwwshs」。
    // 上游快照 03d161a；本校脚本最后一次修改 08b0e02。
    // 模板是已审计的 zsc（强智 /jsxsd/）。zsc 读的是 div.kbcontent 网格，本校上游读的是
    // table.qz-weeklyTable 里的 li.courselists-item，取数路径按 GDKM.js 重写，不照抄 zsc 的接口。
    //
    // 平台判据按脚本实际请求的路径（与上游一致），不按注释：
    //   GET /jsxsd/jxzl/jxzl_query                                          教学周历（开学日、周数、当前学期）
    //   GET /jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=<学期>&zc=        课表页（整学期，周次参数为空）
    // 上游把这两处写成 https 绝对地址，主机都是 jw.gdkm.edu.cn。这里改成当前页同源的相对路径，
    // 这样只可能打到登录页那台主机。参数名 viweType 是上游原文，少了一个字母，保持不动。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   1. 不弹窗选学年学期（上游 showSingleSelection）：学期取教学周历页下拉框的当前选中项；
    //   2. 去掉上游的提示框、吐司、保存课程和保存节次时间（脚本对页面只读，节次时间在 parse.js）；
    //   3. 只交原始结构：学期代码与名称、周历每行的周次标签和日期格文字、课表每格的跨行数和卡片文字。
    //      周次、节次、开学日的解释全在 parse.js；
    //   4. 登录页、统一认证页、门户页上点提取：不发请求，直接给大白话提示；
    //   5. 页面地址只交协议、主机和路径，不交查询串；卡片以外的文字（学号、姓名等）不读取。
    //
    // 只请求当前页面同源的教务。不读账号，不写页面，不外发任何数据。详见 AUDIT.md。
    var JW_HOST = 'jw.gdkm.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var LOGIN_HINT = '请先登录教务系统，再打开「课表查询」，然后点提取';

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

    function hasClass(node, name) {
        var classes = ' ' + String(node.className || '').replace(/\s+/g, ' ') + ' ';
        return classes.indexOf(' ' + name + ' ') >= 0;
    }

    function allByClass(node, name) {
        var all = node.getElementsByTagName('*');
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (hasClass(all[i], name)) out.push(all[i]);
        }
        return out;
    }

    function firstByClass(node, name) {
        var found = allByClass(node, name);
        return found.length ? found[0] : null;
    }

    function childElements(node) {
        var out = [];
        var kids = node.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            if (kids[i].nodeType === 1) out.push(kids[i]);
        }
        return out;
    }

    // 登录页 / 统一认证页 / 学校主页：不发请求。只看地址，不读输入框。
    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host !== JW_HOST) {
            return '当前打开的不是广东科贸职业学院教务系统。' + LOGIN_HINT;
        }
        if (path === '/' || path === '' || /^\/jsxsd\/?$/.test(path) || /^\/jsxsd\/(index|login|xk\/log)/.test(path)) {
            return '当前打开的是登录页。' + LOGIN_HINT;
        }
        return '';
    }

    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function hostOf(url) {
        var m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || ''));
        return m ? m[1].split(':')[0].toLowerCase() : '';
    }

    function titleOf(doc) {
        var titles = doc.getElementsByTagName('title');
        return titles.length ? clean(titles[0].textContent) : '';
    }

    // 课程卡片只留课名和「老师 / 时间 / 地点」原文。是不是卡片由类名判断，解释留给 parse.js。
    function cardOf(node) {
        if (tagOf(node) !== 'LI' || !hasClass(node, 'courselists-item')) return null;
        var title = firstByClass(node, 'qz-hasCourse-title');
        var abbr = firstByClass(node, 'qz-hasCourse-abbrinfo');
        return {
            name: title ? clean(title.textContent) : '',
            abbr: abbr ? clean(abbr.textContent) : ''
        };
    }

    function itemsOf(td) {
        var lists = td.getElementsByTagName('li');
        var out = [];
        for (var i = 0; i < lists.length; i++) {
            var card = cardOf(lists[i]);
            if (card) out.push(card);
        }
        return out;
    }

    function spanOf(node) {
        var value = parseInt(attrOf(node, 'rowspan'), 10);
        return value >= 1 ? value : 1;
    }

    function rowOf(tr) {
        var sectionText = '';
        var cells = [];
        var kids = childElements(tr);
        for (var i = 0; i < kids.length; i++) {
            if (tagOf(kids[i]) !== 'TD') continue;
            var name = attrOf(kids[i], 'name');
            if (name === 'timeTd' && !sectionText) sectionText = clean(kids[i].textContent);
            if (name === 'kbDataTd') {
                cells.push({ rowspan: spanOf(kids[i]), items: itemsOf(kids[i]) });
            }
        }
        return { sectionText: sectionText, cells: cells };
    }

    function findTimetable(doc) {
        var tables = doc.getElementsByTagName('table');
        var best = null;
        var bestCount = -1;
        for (var i = 0; i < tables.length; i++) {
            var tds = tables[i].getElementsByTagName('td');
            var count = 0;
            for (var k = 0; k < tds.length; k++) {
                if (attrOf(tds[k], 'name') === 'kbDataTd') count++;
            }
            if (count > bestCount) {
                best = tables[i];
                bestCount = count;
            }
        }
        return bestCount > 0 ? best : null;
    }

    function timetableOf(doc) {
        var table = findTimetable(doc);
        if (!table) return [];
        var bodies = table.getElementsByTagName('tbody');
        var scope = bodies.length ? bodies : [table];
        var rows = [];
        for (var b = 0; b < scope.length; b++) {
            var trs = scope[b].getElementsByTagName('tr');
            for (var t = 0; t < trs.length; t++) {
                if (scope[b] !== table && trs[t].parentNode !== scope[b]) continue;
                var row = rowOf(trs[t]);
                if (row.cells.length || row.sectionText) rows.push(row);
            }
        }
        return rows;
    }

    // 教学周历：第 N 周那一行的标签，以及按从左到右的日期格文字（星期一在第 1 格）。
    function calendarOf(doc) {
        var trs = doc.getElementsByTagName('tr');
        var weeks = [];
        for (var i = 0; i < trs.length; i++) {
            var labelNode = firstByClass(trs[i], 'qz-weeklyTable-label');
            if (!labelNode) continue;
            var inner = firstByClass(labelNode, 'td-cell');
            var days = [];
            var tds = trs[i].getElementsByTagName('td');
            for (var k = 0; k < tds.length; k++) {
                if (tds[k].parentNode !== trs[i]) continue;
                if (hasClass(tds[k], 'qz-weeklyTable-normalDay')) days.push(clean(tds[k].textContent));
            }
            weeks.push({ label: clean((inner || labelNode).textContent), days: days });
        }
        return { weeks: weeks };
    }

    function termOf(doc) {
        var select = doc.getElementById('xnxq01id');
        if (!select || !select.options) return null;
        var chosen = null;
        for (var i = 0; i < select.options.length; i++) {
            var opt = select.options[i];
            if (opt.selected || attrOf(opt, 'selected') !== '') chosen = opt;
        }
        if (!chosen && select.value) {
            for (var j = 0; j < select.options.length; j++) {
                if (String(select.options[j].value) === String(select.value)) chosen = select.options[j];
            }
        }
        if (!chosen) return null;
        var code = clean(chosen.value);
        if (!code) return null;
        return { code: code, name: clean(chosen.textContent) || code };
    }

    function readResponse(response) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('教务系统拒绝访问（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        if (hostOf(response.url) && hostOf(response.url) !== JW_HOST) {
            throw new Error('登录已失效。' + LOGIN_HINT);
        }
        return response.text().then(function (html) {
            return new DOMParser().parseFromString(html, 'text/html');
        });
    }

    function getDoc(url) {
        return fetch(url, { method: 'GET', credentials: 'same-origin' }).then(readResponse, function () {
            throw new Error('连不上教务系统。' + LOGIN_HINT);
        });
    }

    function countItems(rows) {
        var n = 0;
        for (var r = 0; r < rows.length; r++) {
            var cells = rows[r].cells || [];
            for (var c = 0; c < cells.length; c++) n += (cells[c].items || []).length;
        }
        return n;
    }

    function run() {
        var hint = loginHint();
        if (hint) return Promise.reject(new Error(hint));
        return getDoc(CALENDAR_PATH).then(function (calendarDoc) {
            if (titleOf(calendarDoc).indexOf('登录') >= 0 && !termOf(calendarDoc)) {
                throw new Error('登录已失效。' + LOGIN_HINT);
            }
            var term = termOf(calendarDoc);
            if (!term) throw new Error('当前页面找不到学年学期。' + LOGIN_HINT);
            var query = SCHEDULE_PATH + '?viweType=0&xnxq01id=' + encodeURIComponent(term.code) + '&zc=';
            return getDoc(query).then(function (page) {
                if (titleOf(page).indexOf('登录') >= 0 && !findTimetable(page)) {
                    throw new Error('登录已失效。' + LOGIN_HINT);
                }
                var rows = timetableOf(page);
                if (!countItems(rows)) throw new Error('没有找到课程。请确认已经打开本学期课表再点提取');
                return JSON.stringify({
                    source: 'qz-jsxsd',
                    pageUrl: pageUrlOf(),
                    now: todayIso(),
                    term: term,
                    calendar: calendarOf(calendarDoc),
                    rows: rows
                });
            });
        });
    }

    return run();
})()
