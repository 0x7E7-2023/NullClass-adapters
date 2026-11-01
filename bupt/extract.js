(function () {
    // 北京邮电大学 教务适配器 —— 强智科技学生端 /jsxsd/。
    // 移植自 shiguang_warehouse 的 BUPT/bupt_01.js（MIT，上游 adapters.yaml 的 maintainer 为 cstkn；
    //   任务卡记作者星河欲转）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 03d161a；本校脚本最后一次修改 80e30cf。
    // 模板是已审计的 zsc（强智 /jsxsd/ 的周次与课表网格解析）。本校上游只解析已经打开的学期理论课表，
    // 不请求任何接口。这里同样只读当前页（含同源 iframe），不发课表请求，也不发教学周历请求。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹确认框、不弹失败框（上游 alertUser）；认不出课表或课表是空的，直接抛大白话；
    //   ② 登录页、统一认证页、门户页、别的主机：不发请求，直接提示；
    //   ③ 只交原始结构（学期下拉框选中项、网格、行首节次时刻、实验课表被跳过的块数）；
    //      周次 / 节次 / 课名的解释全在 parse.js；
    //   ④ 类名带 sykb2 的实验课表块不交出去（上游同样跳过），只交跳过的块数；
    //   ⑤ 页面地址只交协议、主机与路径，不交查询串；
    //   ⑥ 不读账号、姓名、证件号，也不把课表格子以外的页面文字交出去。
    //
    // 只读当前页：不读账号密码、不写页面、不外发任何数据。详见 AUDIT.md。
    var JW_HOST = 'jwgl.bupt.edu.cn';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。教务不给开学日时由 parse.js 用它推算第 1 周的周一。
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

    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host !== JW_HOST) {
            return '当前打开的不是北京邮电大学教务系统。请先登录教务系统，再打开「学期理论课表」，然后点提取';
        }
        if (/^\/jsxsd\/?$/.test(path) || /^\/jsxsd\/(index|login|xk\/log)/.test(path)) {
            return '当前打开的是登录页。请先登录教务系统，再打开「学期理论课表」，然后点提取';
        }
        return '';
    }

    var skippedLab = 0;

    // 只认类名正好含 kbcontent 的 div。带 sykb2 的是实验课表，上游不导，这里也不交原文，只计数。
    function partsOf(cell) {
        var divs = cell.getElementsByTagName('div');
        var parts = [];
        for (var i = 0; i < divs.length; i++) {
            var classes = ' ' + String(divs[i].className || '').replace(/\s+/g, ' ') + ' ';
            if (classes.indexOf(' kbcontent ') < 0) continue;
            if (classes.indexOf(' sykb2 ') >= 0) {
                skippedLab++;
                continue;
            }
            var html = String(divs[i].innerHTML || '').trim();
            if (html && html !== '&nbsp;') parts.push(html);
        }
        return parts;
    }

    // 格子的可见文字会交给 parse.js 认表头和行首节次。实验课表和简写副本的文字不能混进来。
    function cellText(node) {
        var clone = node.cloneNode(true);
        var divs = clone.getElementsByTagName('div');
        var drop = [];
        for (var i = 0; i < divs.length; i++) {
            var classes = ' ' + String(divs[i].className || '').replace(/\s+/g, ' ') + ' ';
            if (classes.indexOf(' kbcontent1 ') >= 0 || classes.indexOf(' sykb2 ') >= 0) drop.push(divs[i]);
        }
        for (var j = 0; j < drop.length; j++) {
            if (drop[j].parentNode) drop[j].parentNode.removeChild(drop[j]);
        }
        var text = clone.textContent !== undefined ? clone.textContent : clone.innerText;
        return clean(text);
    }

    function cellOf(node, col, span) {
        return { col: col, span: span, text: cellText(node), parts: partsOf(node) };
    }

    function spanOfAttr(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return value >= 1 ? value : 1;
    }

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

    // 行首节次时刻。上游只认「以节次数字开头、后面带 HH:mm-HH:mm」的表头，这里同一条规则。
    // 一位数的小时补成两位，免得解析端看到不合法的时刻。
    function padClock(text) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(text);
        if (!m) return text;
        return pad2(parseInt(m[1], 10)) + ':' + m[2];
    }

    function slotsOf(table) {
        var out = [];
        var seen = {};
        var trs = table.rows || table.getElementsByTagName('tr');
        for (var r = 0; r < trs.length; r++) {
            var header = null;
            var kids = trs[r].children || [];
            for (var k = 0; k < kids.length; k++) {
                if (tagOf(kids[k]) === 'TH') {
                    header = kids[k];
                    break;
                }
            }
            if (!header) continue;
            var text = clean(header.textContent);
            var match = /^(\d+).*?(\d{1,2}:\d{2})-(\d{1,2}:\d{2})/.exec(text);
            if (!match) continue;
            var number = parseInt(match[1], 10);
            if (!number || seen[number]) continue;
            seen[number] = true;
            out.push({ period: number, start: padClock(match[2]), end: padClock(match[3]) });
        }
        return out;
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

    function findScheduleDocument() {
        if (document.getElementById && document.getElementById('kbtable')) return document;
        var frames = document.getElementsByTagName('iframe');
        for (var i = 0; i < frames.length; i++) {
            try {
                var frameDoc = frames[i].contentDocument;
                if (!frameDoc && frames[i].contentWindow) frameDoc = frames[i].contentWindow.document;
                if (frameDoc && frameDoc.getElementById && frameDoc.getElementById('kbtable')) return frameDoc;
            } catch (e) {
                // 跨域 iframe 读不到，跳过。
            }
        }
        return null;
    }

    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    var hint = loginHint();
    if (hint) throw new Error(hint);

    var doc = findScheduleDocument();
    if (!doc) {
        throw new Error('请不要在教务系统主页直接提取。请先进入「学期理论课表」页面，等课表加载完成后再点提取');
    }

    var table = doc.getElementById('kbtable');
    var grid = scheduleGrid(table);
    if (courseCells(grid.rows) === 0) {
        throw new Error('当前页面没有解析到课程。请确认已经打开「学期理论课表」，并且课表里能看到课程后再点提取');
    }

    var term = readTerm(doc);
    return JSON.stringify({
        source: 'bupt-page',
        pageUrl: pageUrlOf(),
        now: todayIso(),
        term: term,
        screenTermMissing: !term.code,
        cols: grid.cols,
        calendar: { found: false, rows: [] },
        slots: slotsOf(table),
        skippedLab: skippedLab,
        rows: grid.rows
    });
})()
