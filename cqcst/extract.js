(function () {
    // 重庆城市科技学院教务适配器（强智科技「高校综合管理教务系统」学生端 /cqdxcskjxy_jsxsd/，课表页的 DOM 表格）。
    // 移植自 shiguang_warehouse 的 CQCST/cqcst_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Mutx163）
    // 上游 resources/CQCST/adapters.yaml：CQCST_01「重庆城市科技学院强智适配」，maintainer「Mutx163」，
    //   import_url = http://jw.cqcst.edu.cn/cqdxcskjxy_jsxsd/
    // 上游快照 1dc9ac6（2026-11-16 拉取），本校脚本最后一次修改 1fe584c（2026-08-23）。模板：ecjtu（同为「只解析当前页 DOM 表格」），
    //   表格网格与周次处理参考 hnptc。
    //
    // 取数方式（与上游一致，零请求）：
    //   课表表格：#kbtable → .table_border → 任意含「星期」两字的 table；找不到就报「请先打开学期理论课表」。
    //   上游只在当前页面读表，不请求任何接口，所以 allowHosts 为空，这里也不发任何网络请求。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹确认框、不调拾光界面的 toast / 保存 / 结束通知：只交数，导入由空课自己的流程处理；
    //   ② 只交原始结构（提取时刻 + 学期下拉框 + 表格网格），一格多课怎么拆、周次 / 节次 / 单双周 / 星期怎么算全在 parse.js（CI 能真跑）；
    //   ③ 表格还原成网格：每格带网格列号 col 与跨列数 span，rowspan 占住的列在后续行空出来，避免左上角节次列把星期算错；
    //   ④ 格子文字只交看得见的文字（活页面用 innerText，本身不含隐藏元素），带学号 / 姓名 / 身份证 / 手机号字样的行整行不读；
    //      属性、悬浮层、脚本、输入框的值一概不读，页面本身不改；
    //   ⑤ 学年学期取页面上 id 或 name 含 xnxq 的下拉框选中项（强智的学期选择），不弹窗问用户；
    //   ⑥ 登录页 / 不是课表页时给大白话提示，不发请求；
    //   ⑦ 表格里一行课都没有（空课表）不在这里报错，交给 parse.js 统一提示（CI 里能验）。
    var NOT_SCHEDULE = '当前页面不是课表页。请先登录教务系统，打开「学期理论课表」页面，确认页面上能看到课表再点「提取课表」';
    var ON_LOGIN = '当前是教务系统的登录页。请先登录，再打开「学期理论课表」页面，确认页面上能看到课表再点「提取课表」';
    var TEXT_LIMIT = 40;
    var CELL_LINE_LIMIT = 100;
    var CELL_ROWS_LIMIT = 40;
    // 带这些字样的行不是课程内容（课表页偶尔把学生信息塞在表格里），整行不交出去
    var PERSONAL = /姓名|学号|身份证|考生号|手机号|联系电话/;
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

    function limited(value, max) {
        var text = clean(value);
        return text.length > max ? text.substring(0, max) : text;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取当天日期（本地）。教务不给开学日时由 parse.js 用它推算第 1 周。
    // 不能用 toISOString：北京时间早上 8 点前它会退到前一天。
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function tagOf(node) {
        return String((node && node.tagName) || '').toUpperCase();
    }

    function attrOf(node, name) {
        try {
            return node && node.getAttribute ? node.getAttribute(name) : null;
        } catch (e) {
            return null;
        }
    }

    function spanOfAttr(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return value >= 1 ? value : 1;
    }

    function closestTable(el) {
        var node = el;
        while (node && node.nodeType === 1) {
            if (tagOf(node) === 'TABLE') return node;
            node = node.parentNode;
        }
        return null;
    }

    // 一格里的可见文字。innerText 不含 display:none / hidden 的元素与脚本；
    // 拿不到 innerText 时退到 textContent（本适配器只在活页面上跑，这一点只是兜底）。
    function cellText(node) {
        var raw = '';
        try {
            raw = node && node.innerText !== undefined ? String(node.innerText) : '';
        } catch (e) {
            raw = '';
        }
        if (!raw) raw = node && node.textContent !== undefined ? String(node.textContent) : '';
        var pieces = String(raw).split(/\r\n|\r|\n/);
        var out = [];
        for (var i = 0; i < pieces.length && out.length < CELL_ROWS_LIMIT; i++) {
            var line = clean(pieces[i]);
            if (!line) continue;
            if (PERSONAL.test(line)) continue;
            out.push(line.length > CELL_LINE_LIMIT ? line.substring(0, CELL_LINE_LIMIT) : line);
        }
        return out.join('\n');
    }

    // 课表表格：上游 #kbtable → .table_border → 任意 table，最后要求表里有「星期」。
    // #kbtable 在强智里通常就是课表；.table_border 可能是表格本身也可能是它的容器，两种都认。
    function isScheduleTable(node) {
        if (!node || tagOf(node) !== 'TABLE') return false;
        var text = node.textContent !== undefined ? String(node.textContent) : '';
        return text.indexOf('星期') >= 0;
    }

    function findTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (isScheduleTable(byId)) return byId;
        var byClass = doc.querySelector ? doc.querySelector('.table_border') : null;
        if (byClass) {
            if (isScheduleTable(byClass)) return byClass;
            var inside = byClass.getElementsByTagName ? byClass.getElementsByTagName('table') : [];
            for (var i = 0; i < inside.length; i++) {
                if (isScheduleTable(inside[i])) return inside[i];
            }
            var near = closestTable(byClass);
            if (isScheduleTable(near)) return near;
        }
        var tables = doc.getElementsByTagName('table');
        for (var j = 0; j < tables.length; j++) {
            if (isScheduleTable(tables[j])) return tables[j];
        }
        return null;
    }

    // 整张表还原成网格。carry[c] 记第 c 列还被前面某一行的 rowspan 占着几行；
    // 每进一行先把占住的列标出来，rowspan 格子只在它自己那一行留下 td，否则后面的格子会整体左移。
    function gridOf(table) {
        var rows = [];
        var width = 0;
        var trs = table.rows || table.getElementsByTagName('tr');
        var carry = [];
        for (var r = 0; r < trs.length; r++) {
            var occupied = {};
            for (var k = 0; k < carry.length; k++) {
                if (carry[k] > 0) {
                    occupied[k] = true;
                    carry[k] = carry[k] - 1;
                }
            }
            var kept = [];
            var col = 0;
            var kids = trs[r].children || [];
            for (var i = 0; i < kids.length; i++) {
                var tag = tagOf(kids[i]);
                if (tag !== 'TD' && tag !== 'TH') continue;
                while (occupied[col]) col++;
                var span = spanOfAttr(kids[i], 'colspan');
                var rowspan = spanOfAttr(kids[i], 'rowspan');
                var text = cellText(kids[i]);
                if (col + span > width) width = col + span;
                // 跨列的合并格（备注行、跨天标题）不交出去：强智的课程格是一天一格，
                // 合并格里常是整行备注，可能带姓名学号；列号照算，不影响其它格
                if (text && span === 1) kept.push({ col: col, span: span, text: text });
                if (rowspan > 1) {
                    for (var s = 0; s < span; s++) carry[col + s] = rowspan - 1;
                }
                col += span;
            }
            // 没有任何文字的表格行（纯空白分隔行）不必交出去；grid 列号已经算过，后续行不会错
            if (kept.length) rows.push(kept);
        }
        return { cols: width, rows: rows };
    }

    // 学年学期：强智页面顶部是 select[id|name 含 xnxq]，读选中项的文字与值（不读其它表单）
    function readTerm(doc) {
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length; i++) {
            var id = String(attrOf(selects[i], 'id') || '') + '|' + String(attrOf(selects[i], 'name') || '');
            if (id.toLowerCase().indexOf('xnxq') < 0) continue;
            var options = selects[i].options || [];
            var picked = null;
            var j;
            for (j = 0; j < options.length; j++) {
                if (options[j].selected) picked = options[j];
            }
            if (!picked && selects[i].selectedIndex >= 0) picked = options[selects[i].selectedIndex];
            return {
                code: limited(selects[i].value, TEXT_LIMIT),
                name: picked ? limited(picked.text !== undefined && picked.text !== null ? picked.text : picked.textContent, TEXT_LIMIT) : ''
            };
        }
        return { code: '', name: '' };
    }

    function hasPasswordInput(doc) {
        try {
            return !!(doc.querySelector && doc.querySelector('input[type=password]'));
        } catch (e) {
            return false;
        }
    }

    var table = findTable(document);
    if (!table) {
        throw new Error(hasPasswordInput(document) ? ON_LOGIN : NOT_SCHEDULE);
    }

    var grid = gridOf(table);
    return JSON.stringify({
        now: todayIso(),
        term: readTerm(document),
        cols: grid.cols,
        rows: grid.rows
    });
})()
