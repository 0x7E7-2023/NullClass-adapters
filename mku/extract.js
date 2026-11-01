(function () {
    // 闽南科技学院 教务适配器 —— 强智科技新版 layui（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 MKU/mku.js（MIT，上游 adapters.yaml 的 maintainer 为 Mutx163）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/MKU/adapters.yaml：adapter_name「闽南科技学院教务系统」，import_url = https://jwgl.mku.edu.cn/ ，maintainer「Mutx163」。
    // 上游快照 03d161a；本校脚本最后一次修改 80e30cf。
    // 周次、提醒和载荷的写法照已审计的 zsc；课表页面结构和取数地址按 MKU 上游，不用 zsc 的旧表格（kbtable / kbcontent）。
    //
    // 平台判据按脚本实际请求的路径，不按注释：
    //   GET /jsxsd/xskb/xskb_list.do?viweType=0&zc=&cj0701id=          个人课表（当前页没有课表表格时才请求；不带学期参数，教务渲染当前学期）
    //   GET /jsxsd/xskb/jxzlzc_xnxq_ajax?xnxq01id=<学期代码>           学期周次范围（原文交给 parse.js）
    //   GET /jsxsd/framework/xsMainV.htmlx                            首页抬头里的「学年学期 第N周」（只取这一小段文字）
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗选学期：读课表页下拉框 #xnxq01id 的选中项；
    //   ② 去掉上游的确认框、提示、保存节次和保存课程；
    //   ③ 只交原始结构：学期、每行大节标题与整格文字、每门课的课名和「老师/时间/地点」原文、周次接口原文、首页抬头原文；
    //   ④ 节次怎么拆、周次怎么切、开学日怎么推，全部放在 parse.js；
    //   ⑤ 登录页、统一认证页、门户页上点提取：不发请求；
    //   ⑥ 页面地址只交协议、主机与路径，不交查询串；
    //   ⑦ 不读姓名、学号、身份证号、手机号。
    //
    // 只请求当前页面同源的教务（jwgl.mku.edu.cn）的相对路径。详见 AUDIT.md。
    var JW_HOST = 'jwgl.mku.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do?viweType=0&zc=&cj0701id=';
    var WEEK_PATH = '/jsxsd/xskb/jxzlzc_xnxq_ajax?xnxq01id=';
    var HOME_PATH = '/jsxsd/framework/xsMainV.htmlx';
    var LOGIN_HINT = '请先登录教务系统，打开「个人课表」，确认能看到课再点提取';

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

    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host !== JW_HOST) {
            return '当前打开的不是闽南科技学院教务系统。请先登录教务系统，再打开「个人课表」，然后点提取';
        }
        if (path === '/' || /^\/jsxsd\/?$/.test(path) || /^\/jsxsd\/(index|login|xk\/log)/.test(path)) {
            return '当前打开的是登录页。请先登录教务系统，再打开「个人课表」，然后点提取';
        }
        if (path.indexOf('/jsxsd/') !== 0) {
            return '当前打开的不是课表页。请先打开「个人课表」，然后点提取';
        }
        return '';
    }

    function buildGrid(table) {
        var grid = [];
        var trs = table.rows || table.getElementsByTagName('tr');
        for (var r = 0; r < trs.length; r++) {
            if (!grid[r]) grid[r] = [];
            var col = 0;
            var cells = trs[r].cells || [];
            for (var i = 0; i < cells.length; i++) {
                while (grid[r][col]) col++;
                var td = cells[i];
                var rowSpan = td.rowSpan || 1;
                var colSpan = td.colSpan || 1;
                for (var dr = 0; dr < rowSpan; dr++) {
                    if (!grid[r + dr]) grid[r + dr] = [];
                    for (var dc = 0; dc < colSpan; dc++) grid[r + dr][col + dc] = td;
                }
                col += colSpan;
            }
        }
        return grid;
    }

    function rowMeta(tr) {
        var labelCell = tr.cells && tr.cells[0];
        if (!labelCell) return null;
        var titleEl = labelCell.querySelector ? labelCell.querySelector('.index-title') : null;
        var titleText = titleEl ? clean(titleEl.textContent) : '';
        if (!/^(\d+)(?:\s*[-~]\s*(\d+))?$/.test(titleText)) return null;
        return { title: titleText, text: clean(labelCell.textContent) };
    }

    function itemsOf(td) {
        var out = [];
        var lis = td.getElementsByTagName('li');
        for (var i = 0; i < lis.length; i++) {
            var nameEl = null;
            var infoEl = null;
            var nodes = lis[i].getElementsByTagName('div');
            for (var n = 0; n < nodes.length; n++) {
                var cls = ' ' + String(nodes[n].className || '').replace(/\s+/g, ' ') + ' ';
                if (cls.indexOf(' qz-hascourse-title ') >= 0 || cls.indexOf(' qz-hasCourse-title ') >= 0) nameEl = nodes[n];
                if (cls.indexOf(' qz-hascourse-abbrinfo ') >= 0 || cls.indexOf(' qz-hasCourse-abbrinfo ') >= 0) infoEl = nodes[n];
            }
            if (!nameEl || !infoEl) continue;
            var name = clean(nameEl.textContent);
            var info = clean(infoEl.textContent);
            if (!name || !info) continue;
            out.push({ name: name, info: info });
        }
        return out;
    }

    function readTerm(doc) {
        var code = null;
        var name = null;
        var select = doc.getElementById ? doc.getElementById('xnxq01id') : null;
        if (!select) return { code: null, name: null };
        var options = select.options || [];
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
        return { code: code, name: name };
    }

    function harvest(doc) {
        var term = readTerm(doc);
        var sample = doc.querySelector ? doc.querySelector('td[name="kbDataTd"]') : null;
        if (!sample) return { term: term, rows: [], courseCount: 0, hasTable: false };
        var table = sample;
        while (table && String(table.tagName || '').toUpperCase() !== 'TABLE') table = table.parentNode;
        if (!table) return { term: term, rows: [], courseCount: 0, hasTable: false };
        var grid = buildGrid(table);
        var trs = table.rows || table.getElementsByTagName('tr');
        var rows = [];
        var courseCount = 0;
        var seen = [];
        for (var r = 0; r < trs.length; r++) {
            var meta = rowMeta(trs[r]);
            if (!meta) continue;
            var cells = [];
            for (var day = 1; day <= 7; day++) {
                var td = grid[r] && grid[r][day];
                if (!td || seen.indexOf(td) >= 0) continue;
                seen.push(td);
                var items = itemsOf(td);
                if (!items.length) continue;
                courseCount += items.length;
                cells.push({ day: day, items: items });
            }
            rows.push({ title: meta.title, text: meta.text, cells: cells });
        }
        return { term: term, rows: rows, courseCount: courseCount, hasTable: true };
    }

    function htmlDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    function requestText(url) {
        return fetch(url, { method: 'GET', credentials: 'same-origin' }).then(function (response) {
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

    function fetchWeek(code) {
        if (!code) return Promise.resolve('');
        return fetch(WEEK_PATH + encodeURIComponent(code), { method: 'GET', credentials: 'same-origin' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return '';
            return response.text();
        }, function () {
            return '';
        });
    }

    function fetchHeader() {
        return fetch(HOME_PATH, { method: 'GET', credentials: 'same-origin' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return '';
            return response.text().then(function (html) {
                var m = String(html).match(/id="headerShowTime"[^>]*>\s*([^<]+?)\s*</);
                return m ? clean(m[1]) : '';
            });
        }, function () {
            return '';
        });
    }

    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function payloadOf(flight, weekAjax, headerShow) {
        return JSON.stringify({
            source: 'qz-jsxsd-layui',
            pageUrl: pageUrlOf(),
            now: todayIso(),
            term: flight.term,
            screenTermMissing: !flight.term.code,
            weekAjax: weekAjax || '',
            headerShow: headerShow || '',
            rows: flight.rows
        });
    }

    function finish(flight) {
        if (!flight.hasTable) throw new Error('没有看到课表。' + LOGIN_HINT);
        if (!flight.courseCount) throw new Error('教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
        return fetchWeek(flight.term.code).then(function (weekAjax) {
            return fetchHeader().then(function (headerShow) {
                return payloadOf(flight, weekAjax, headerShow);
            });
        });
    }

    var hint = loginHint();
    if (hint) throw new Error(hint);

    var live = harvest(document);
    if (live.courseCount > 0) return finish(live);
    // 当前页已经是课表（有格子）但一门课都没有：这就是这一学期的空课表，不要再去拉不带学期的默认课表。
    if (live.hasTable) return finish(live);
    return requestText(SCHEDULE_PATH).then(function (html) {
        return finish(harvest(htmlDoc(html)));
    });
})()
