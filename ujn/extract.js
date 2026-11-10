(function () {
    // 济南大学教务适配器（正方教务 jwglxt 课表页，页面里已经画好的表格）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 UJN/school.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT，作者 Moyu）
    //   上游快照 baf83fa；本校脚本最后一次修改 1fe584c。
    //
    // 移植改动：
    //   ① 删掉上游的弹窗（「班级课表还是个人课表」）与按菜单号 N214505 / N253508 点击跳转：
    //      宿主没有点击菜单的能力。不在两种支持的课表页时直接给出提示，零请求。
    //   ② 上游把读页面与解析揉在一个自执行脚本里。这里按手册切开：课名、周次原文、教室原文、
    //      教师原文，加格子的行号 / 列号 / 跨行 / 跨列，原样交出去；星期、节次、周次全部在 parse.js。
    //   ③ 取文字改用 textContent（上游用 innerText，依赖版面与可见性）；单元格里只取 .title
    //      与按顺序的几行文字，浮层、提示、脚本里的学号姓名等一概不碰。
    //   ④ 不发任何网络请求、不写页面、不点击、不提交表单、不读 Cookie 与本地存储。
    //
    // 两种页面靠地址区分（与上游一致）：
    //   个人课表 /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html → #innerContainer #table1 div.timetable_con
    //   班级课表 /jwglxt/kbdy/bjkbdy_cxBjkbdyIndex.html  → #table1.tab-pane>.timetable1 div.timetable_con

    var PERSONAL_PATH = '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html';
    var CLASS_PATH = '/jwglxt/kbdy/bjkbdy_cxBjkbdyIndex.html';
    var SSO_HOST = 'sso.ujn.edu.cn';

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function textOfNode(node) {
        if (!node) return '';
        return text(node.textContent);
    }

    function pathNow() {
        return String(window.location.pathname || '');
    }

    function pageKind() {
        var path = pathNow();
        if (path.indexOf(PERSONAL_PATH) >= 0) return 'personal';
        if (path.indexOf(CLASS_PATH) >= 0) return 'class';
        return null;
    }

    function onLoginPage() {
        var host = String(window.location.hostname || '').toLowerCase();
        var path = pathNow();
        if (host === SSO_HOST) return true;
        if (path.indexOf('login') >= 0) return true;
        return path.indexOf('/sso/') >= 0;
    }

    // 上游用 item.closest('td')；旧 WebView 不一定有 closest，这里手写等价的一层向上找。
    function closestCell(node) {
        var current = node;
        while (current && current.nodeType === 1) {
            if (String(current.tagName).toUpperCase() === 'TD') return current;
            current = current.parentNode;
        }
        return null;
    }

    function intOr(value, fallback) {
        var n = parseInt(value, 10);
        return isNaN(n) ? fallback : n;
    }

    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options || !options.length) {
            var raw = text(selectEl.value);
            return raw ? { value: raw.replace(/\s+/g, ''), text: '' } : null;
        }
        var list = [];
        var picked = -1;
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var value = text(option.value).replace(/\s+/g, '');
            if (!value) continue;
            if (option.selected && picked < 0) picked = list.length;
            list.push({ value: value, text: textOfNode(option) });
        }
        if (!list.length) return null;
        if (picked < 0) picked = 0;
        return { value: list[picked].value, text: list[picked].text };
    }

    // 课表页顶部的学年 / 学期下拉框（正方各页面同 id）；读不到就交空值，学期名与开学日由 parse.js 决定。
    function pageTerm() {
        var year = readSelect(document.querySelector('#xnm'));
        var season = readSelect(document.querySelector('#xqm'));
        if (!year && !season) return null;
        return {
            xnm: year ? year.value : '',
            xqm: season ? season.value : '',
            xnmText: year ? year.text : '',
            xqmText: season ? season.text : ''
        };
    }

    // 个人课表：三个 p 依次是周次、教室、教师，各取其中最后一个元素（上游取 lastElementChild）。
    function lastElementText(p) {
        if (!p) return '';
        var last = p.lastElementChild;
        return textOfNode(last || p);
    }

    // 班级课表：一个 p 里先有个标签元素，后面紧跟真正的内容（上游取 firstElementChild.nextSibling）。
    function textAfterLabel(p) {
        if (!p) return '';
        var label = p.firstElementChild;
        if (!label) return textOfNode(p);
        var rest = label.nextSibling;
        if (!rest) return '';
        return text(rest.textContent);
    }

    function collectCells(kind) {
        var selector = kind === 'personal'
            ? '#innerContainer #table1 div.timetable_con'
            : '#table1.tab-pane>.timetable1 div.timetable_con';
        var nodes;
        try {
            nodes = document.querySelectorAll(selector);
        } catch (e) {
            nodes = [];
        }
        var cells = [];
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var td = closestCell(node);
            if (!td) continue;
            var tr = td.parentNode;
            if (!tr) continue;
            var lines = node.querySelectorAll('p');
            var weeks = '';
            var location = '';
            var teacher = '';
            if (kind === 'personal') {
                weeks = lastElementText(lines[0]);
                location = lastElementText(lines[1]);
                teacher = lastElementText(lines[2]);
            } else if (lines.length !== 1) {
                weeks = textAfterLabel(lines[2]);
                location = textAfterLabel(lines[3]);
                teacher = textAfterLabel(lines[4]);
            }
            cells.push({
                name: textOfNode(node.querySelector('.title')),
                weeks: weeks,
                location: location,
                teacher: teacher,
                row: intOr(tr.rowIndex, -1),
                col: intOr(td.cellIndex, -1),
                rowSpan: intOr(td.rowSpan, 1),
                colSpan: intOr(td.colSpan, 1)
            });
        }
        return cells;
    }

    var kind = pageKind();
    if (!kind) {
        if (onLoginPage()) {
            throw new Error('当前打开的是登录页。请先登录教务系统，再打开「信息查询 - 个人课表查询」或「班级课表查询」，看到课表后点「提取课表」');
        }
        throw new Error('这个页面不是课表页。请打开「信息查询 - 个人课表查询」或「班级课表查询」，看到课表后点「提取课表」');
    }

    var now = new Date();
    var month = now.getMonth() + 1;
    var day = now.getDate();

    return JSON.stringify({
        page: kind,
        term: pageTerm(),
        today: now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day,
        cells: collectCells(kind)
    });
})()
