(function () {
    // 青岛农业大学综合教务管理系统（强智科技 · 学生端 /jsxsd/）课表提取。
    // 移植自 shiguang_warehouse 的 resources/QAU/qau_01.js（MIT，上游作者 ReGoMark）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    //   快照 commit ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    // 同目录 adapters.yaml：adapter_name「青岛农业大学综合教务管理系统（强智科技）」，
    //   只适用于青岛 / 平度 / 蓝谷三个校区的本科生个人课表。
    //
    // 取数方式：强智课表页返回服务端渲染的 HTML，所以是 DOM 抓取。
    //   同源 GET /jsxsd/xskb/xskb_list.do —— 与上游同一个接口、不带学期参数，
    //   教务默认给的就是当前学期。相对路径，落回当前页面所在的那台服务器；
    //   主机名只在 manifest.json 的 allowHosts 里出现，脚本里不写死。
    //
    // 移植改动：
    //   ① 不弹学期选择（上游 showSingleSelection + 再 POST 一次）：课表页自带的
    //      select#xnxq01id 选中项就是当前学期，只读它的 value 与文字，不发 POST；
    //   ② 校区改成 __ncSelect 问一次（同 zcmu 的写法）：三个校区作息不同。
    //      不问、问不到、用户取消，都由 parse.js 回落到青岛校区并写进 warnings；
    //   ③ 只交原始结构出去（学期 + 网格 cols/rows + 校区），课程名、教师、教室、
    //      周次、节次的解释全在 parse.js —— 那边 CI 里能真跑；
    //   ④ 去掉上游的 showToast / showAlert / getCourseConfig / saveCourseConfig /
    //      savePresetTimeSlots / saveImportedCourses / notifyTaskCompletion：
    //      保存是空课自己的事，脚本对页面只读；
    //   ⑤ pageUrl 只交路径（pathname），不交查询串（查询串里可能有学号）。
    //
    // 只请求当前页面同源的这一个教务接口：不读账号密码、不写页面、不外发数据、不埋点。
    var KB_PATH = '/jsxsd/xskb/xskb_list.do';
    var LOGIN_HINT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';
    var CAMPUSES = ['青岛校区', '平度校区', '蓝谷校区'];

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。只用于教务页面给不出开学日时推算第 1 周 —— 见 parse.js。
    // 不能用 toISOString：北京时间早上 8 点前它会退到前一天。
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function tagOf(node) {
        return String((node && node.tagName) || '').toUpperCase();
    }

    // 一格里的「明细」：强智把课程名 + 教师 / 周次(节次) / 教室放在 div.kbcontent 里，
    // 同一格放多门课时，几门课在同一个 div 里用一长串减号隔开（切开是 parse.js 的事）。
    // 同一格里可能有可见简写与 display:none 的完整版两份：有隐藏的就只取隐藏的那份；
    // 没有隐藏的就全取（多个 kbcontent 就是多门课，只取第一份会丢课）。
    function partsOf(cell) {
        var divs = cell.getElementsByTagName('div');
        var hidden = [];
        var any = [];
        for (var i = 0; i < divs.length; i++) {
            if (String(divs[i].className || '').indexOf('kbcontent') < 0) continue;
            any.push(divs[i]);
            var style = divs[i].getAttribute ? String(divs[i].getAttribute('style') || '') : '';
            if (style.indexOf('none') >= 0) hidden.push(divs[i]);
        }
        var picked = hidden.length ? hidden : any;
        var parts = [];
        for (var j = 0; j < picked.length; j++) {
            var html = String(picked[j].innerHTML || '').trim();
            if (html && html !== '&nbsp;') parts.push(html);
        }
        return parts;
    }

    function cellOf(cell, col, span) {
        var text = cell.textContent !== undefined ? cell.textContent : cell.innerText;
        return { col: col, span: span, text: clean(text), parts: partsOf(cell) };
    }

    function intAttr(node, name) {
        var raw = node && node.getAttribute ? node.getAttribute(name) : null;
        var value = parseInt(raw, 10);
        return isNaN(value) || value < 1 ? 1 : value;
    }

    // 把表格还原成二维网格：每个格子带上它在网格里的列号 col 与跨列数 span，表宽也交出去。
    // 不能让 parse.js 拿「第几个 td」当星期几 —— 强智的首列是「节次」列，它常常 rowspan
    // 跨两行，被跨掉的那一行里第一个 td 会落在 col 1，按数组下标算会整行错一天。
    // 合并单元格占的其它格子只占位、不复制内容；被跨掉又没有任何内容的行不交出去。
    function gridOf(table) {
        var grid = [];
        var trs = table.rows || table.getElementsByTagName('tr');
        for (var r = 0; r < trs.length; r++) {
            var line = grid[r] || (grid[r] = []);
            var col = 0;
            var kids = trs[r].children || [];
            for (var k = 0; k < kids.length; k++) {
                var node = kids[k];
                var tag = tagOf(node);
                if (tag !== 'TD' && tag !== 'TH') continue;
                while (line[col] !== undefined) col++;
                var rowSpan = intAttr(node, 'rowspan');
                var colSpan = intAttr(node, 'colspan');
                for (var dr = 0; dr < rowSpan; dr++) {
                    var target = grid[r + dr] || (grid[r + dr] = []);
                    for (var dc = 0; dc < colSpan; dc++) target[col + dc] = true;
                }
                line[col] = cellOf(node, col, colSpan);
                col += colSpan;
            }
        }
        var rows = [];
        var width = 0;
        for (var ri = 0; ri < grid.length; ri++) {
            var span = grid[ri] || [];
            var cells = [];
            var hasContent = false;
            for (var ci = 0; ci < span.length; ci++) {
                var cell = span[ci];
                if (cell === undefined || cell === true) continue;
                if (cell.col + cell.span > width) width = cell.col + cell.span;
                if (cell.text || cell.parts.length) hasContent = true;
                cells.push(cell);
            }
            if (!cells.length || !hasContent) continue;
            rows.push(cells);
        }
        return { rows: rows, cols: width };
    }

    // 课表容器：上游写死 #kbtable。兜底找「有 .kbcontent 格子的那张表」。
    function findTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cell = doc.querySelector ? doc.querySelector('.kbcontent') : null;
        if (!cell) return null;
        var node = cell;
        while (node && node.nodeType === 1) {
            if (tagOf(node) === 'TABLE') return node;
            node = node.parentNode;
        }
        return null;
    }

    // 有课内容的格子数：判断这一页算不算「拿到了课表」
    function courseCells(rows) {
        var count = 0;
        for (var r = 0; r < rows.length; r++) {
            for (var c = 0; c < rows[r].length; c++) {
                if (rows[r][c].parts.length) count++;
            }
        }
        return count;
    }

    var TERM_ID = /^\d{4}-\d{4}-\d$/;

    // 学期：页面上 select#xnxq01id 的选中项。文字是学期名（「2026-2027学年第一学期」之类，
    // 原样交出去）；value 形如 2026-2027-1 才留作学期号，认不出来就置空。
    // 没有选中项时取第一项（与上游 defaultIndex=0 一致）。页面上别的内容一律不读。
    function termFromSelect(doc) {
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length; i++) {
            var identity = String(selects[i].id || '') + ' ' + String(selects[i].name || '');
            if (identity.indexOf('xnxq') < 0) continue;
            var options = selects[i].options || [];
            var picked = null;
            for (var j = 0; j < options.length; j++) {
                if (options[j].selected) {
                    picked = options[j];
                    break;
                }
            }
            if (!picked) picked = options[0];
            if (!picked) return null;
            var code = clean(picked.value);
            return {
                code: TERM_ID.test(code) ? code : null,
                name: clean(picked.text || picked.textContent)
            };
        }
        return null;
    }

    function harvest(doc) {
        var table = findTable(doc);
        var grid = table ? gridOf(table) : { rows: [], cols: 0 };
        return {
            term: termFromSelect(doc) || { code: null, name: null },
            cols: grid.cols,
            rows: grid.rows
        };
    }

    // pageUrl 只交路径（pathname）：出问题时它能看出用户是从哪个入口进的教务。
    // 不带查询串 —— 查询串里可能有学号等个人信息。
    function payloadOf(flight, campus) {
        return JSON.stringify({
            source: 'qau-jsxsd-xskb',
            pageUrl: String(window.location.pathname),
            now: todayIso(),
            term: flight.term,
            campus: campus,
            cols: flight.cols,
            rows: flight.rows
        });
    }

    // 校区：三个校区的作息时间不同，问一次。只问校区本身，不问账号、密码或任何凭据。
    // 提问桥不可用（没有 __ncCapabilities.ask 或没有 __ncSelect）、用户取消、桥报错，
    // 一律 resolve null —— 由 parse.js 回落到青岛校区并写进 warnings。
    function askCampus() {
        var capable = typeof __ncCapabilities !== 'undefined' && __ncCapabilities && __ncCapabilities.ask;
        if (!capable || typeof __ncSelect !== 'function') return Promise.resolve(null);
        return Promise.resolve().then(function () {
            return __ncSelect({
                title: '选择校区',
                message: '青岛农业大学三个校区的作息时间不同，请选择你所在的校区，用来确定每节课的上下课时间。',
                items: CAMPUSES,
                defaultIndex: 0
            });
        }).then(function (index) {
            return typeof index === 'number' && CAMPUSES[index] ? CAMPUSES[index] : null;
        }, function () {
            return null;
        });
    }

    function htmlToDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    // 上游就是这一个 GET。相对路径 + same-origin：请求落回当前页面所在的那台服务器。
    function requestTimetable() {
        return fetch(KB_PATH, {
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

    return requestTimetable().then(function (html) {
        var got = harvest(htmlToDoc(html));
        if (courseCells(got.rows) === 0) {
            throw new Error(
                '教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT
            );
        }
        return askCampus().then(function (campus) {
            return payloadOf(got, campus);
        });
    });
})()
