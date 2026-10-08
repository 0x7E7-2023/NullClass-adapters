(function () {
    // 山东财经大学燕山学院 教务适配器 —— 强智科技「高校综合管理教务系统」（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 YSSDUFE/yssdufe_01.js（MIT，上游作者 星河欲转）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/YSSDUFE/adapters.yaml：adapter_name「山东财经大学燕山学院强智教务」，maintainer「星河欲转」，
    //   import_url = https://ysjw.sdufe.edu.cn:8081/jsxsd/
    //
    // 平台判据按脚本**实际请求的接口路径**，不按注释：
    //   GET  /jsxsd/jxzl/jxzl_query     教学周历页（学年学期下拉框 select#xnxq01id 在这里取选中项）
    //   POST /jsxsd/jxzl/jxzl_query     教学周历（开学日期与周号挂在 td[title] / 第一列上）
    //   POST /jsxsd/xskb/xskb_list.do   课表页（服务端渲染的 HTML，不是 JSON；容器 #kbtable、div.kbcontent）
    //
    // 取数方式（两级兜底）：
    //   ① 当前页面就有课表格子 → 直接用（用户此刻看到的那张，不多发课表请求）；
    //   ② 否则 POST /jsxsd/xskb/xskb_list.do，请求体与上游 requestCoursePage() 一字不差。
    // 学年学期：GET 教学周历页，取 id 或 name 含 xnxq 的下拉框（强智是 xnxq01id）的选中项（不弹窗）；页面上有课表时，以页面那份为准
    // （它就是屏幕上那一学期）。周历：POST /jsxsd/jxzl/jxzl_query，请求体 xnxq01id=<学期>（与上游一致）。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从列表里选学期（上游用 showSingleSelection 列出学期）：学期取页面下拉框的选中项；
    //   ② 不问冬令时 / 夏令时：本校上游用的是统一的 11 节作息（parse.js 的 SLOT_TIMES），季节作息的提问整段去掉；
    //   ③ 只交原始结构出去（学期 + 每格的网格列号 col / 跨列数 span / 原始 HTML + 周历的网格），
    //      周次 / 节次 / 课程名的解释全在 parse.js —— 那边 CI 里能真跑；
    //   ④ 去掉上游的 showAlert / showToast / notifyTaskCompletion 等界面调用（脚本对页面只读）；
    //   ⑤ 课程明细只读类名正好是 kbcontent 的 div（上游同样只读它，不读 kbcontent1 之类的简写副本）；
    //      同一格里两份明细若都带同一门课，parse.js 按块去重，不会算两次。
    //   ⑥ 页面地址只交协议、主机与路径，不交查询串（查询串里可能带学号）；课表页上找不到「学年学期」下拉框时，
    //      载荷带 screenTermMissing，由 parse.js 出一条提醒。
    //
    // 只请求当前页面同源的一台教务服务器（ysjw.sdufe.edu.cn:8081）的相对路径：不读账号密码、
    // 不写页面、不外发任何数据。详见 AUDIT.md。
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var LOGIN_HINT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';
    var CN_DATE = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?/;

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

    // 一格里的课程明细：强智把课程名 + 教师 / 周次(节次) / 教室写在类名正好是 kbcontent 的 div 里。
    // 只认这个类名（上游也只读它；kbcontent1 之类的简写副本不读）。同一格里若有两份明细都带着同一门课，
    // parse.js 按块去重，不会算两次。
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
        // withNode 只给周历用：它要读 td[title] 上的日期。课表那边不用，免得每个格子里
        // 都多一个空字段（原始 HTML 已经够长了）。
        if (withNode) cell.node = node;
        return cell;
    }

    function spanOfAttr(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return value >= 1 ? value : 1;
    }

    // carry[c] = 第 c 列还被前面某一行的 rowspan 占着几行（不含当前行）。
    // 每进一行先把占用的列标出来并把计数减 1；rowspan=2 的格子只在它自己那一行留下 td，
    // 它占住的列在下一行必须空出来，否则下一行的格子会整体左移一格 —— 课表的首列是节次列，
    // 它常被 rowspan 跨两行，正是靠 col 才对齐得回来（见 parse.js 的列映射）。
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

    // 课表容器：上游写死 #kbtable（强智的课表页用这个 id；教学周历页也用 #kbtable，那张表由 findCalendarTable 单独取）。
    // 认不出 #kbtable 就退一步找「最近一张含 .kbcontent 格子的表」—— 周历表一般没有 .kbcontent 格子，不会被误认。
    function findScheduleTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cell = doc.querySelector ? doc.querySelector('.kbcontent') : null;
        return cell ? closestTable(cell) : null;
    }

    // 课表：整张表还原成网格，每个格子带上**网格列号** col 与跨列数 span，表宽一起交出去。
    // 不能让 parse.js 拿「第几个 td」当星期几：首列是节次列、还有 rowspan/colspan。
    // 只交「有文字或有课程明细」的行（节次标签行照交，parse.js 靠它认无表头时的对齐）。
    function scheduleGrid(table) {
        var out = [];
        var width = 0;
        var trs = table.rows || table.getElementsByTagName('tr');
        var carry = [];
        for (var r = 0; r < trs.length; r++) {
            // carry 要跨行走：哪怕这一行最后不交出去，也要过一遍，否则后面的列号会错
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

    // 教学周历的容器：上游写死 #kbtable。认不出就找第一张有「2026年09月07日」（不带「日」的「2026年09月07」也认）这种 title 的表
    //（周历的日期挂在 td[title] 上）。
    function findCalendarTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cells = doc.getElementsByTagName('td');
        for (var i = 0; i < cells.length; i++) {
            if (CN_DATE.test(attrOf(cells[i], 'title'))) return closestTable(cells[i]);
        }
        return null;
    }

    // 周历：只交「有文字或有 title」的格子（空白的日子格没有信息），但保留网格列号 ——
    // parse.js 要靠列号认「星期几在哪一列」，再读第 1 周那一行。
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

    // 学年学期：课表页顶部的下拉框（强智是 select[id|name 含 xnxq]，值形如 2026-2027-1）。
    // 只读**选中项**：用户在页面上切到哪一学期，导入的就是哪一学期。
    // 这一段只管「学期」，只读下拉框的选中项。课表格子与周历格子另有入口（scheduleGrid、calendarGrid），
    // 读取面全部列在 AUDIT.md「读取面」一节。
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

    function requestText(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
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

    // 课表页的请求体：与上游 requestCoursePage() 一字不差（jx0404id 与空的 cj0701id / zc / demo 都留着）。
    // 没有 sfFD / wkbkc 这两个参数（那是移植模板带来的写法，本校上游没有）。
    function scheduleBody(code) {
        return 'jx0404id=&cj0701id=&zc=&demo=&xnxq01id=' + encodeURIComponent(code);
    }

    // 教学周历的请求体：与上游 requestSemesterDetailPage() 一致，只有 xnxq01id（没有模板里 20 组 xqt）。
    function calendarBody(code) {
        return 'xnxq01id=' + encodeURIComponent(code);
    }

    // 周历取不到（教务改了页面、或这一学期没有周历）不算致命：开学日期退回 parse.js 的备选口径或推算，
    // 并在 warnings 里说明。这里返回空网格而不是抛错。没有学期代码时不发请求。
    function fetchCalendar(code) {
        if (!code) return Promise.resolve({ found: false, rows: [] });
        return requestText(CALENDAR_PATH, calendarBody(code)).then(function (html) {
            var table = findCalendarTable(htmlDoc(html));
            var rows = table ? calendarGrid(table) : [];
            return { found: rows.length > 0, rows: rows };
        }, function () {
            return { found: false, rows: [] };
        });
    }

    // 学年学期：GET 教学周历页，取 id 或 name 含 xnxq 的下拉框（强智是 xnxq01id）的选中项，不弹窗。
    // 取不到（请求失败、页面没有这个下拉框）返回 { code: null, name: null }，由调用方退回课表页自己那份。
    function fetchTerm() {
        return fetch(CALENDAR_PATH, { method: 'GET', credentials: 'same-origin' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return { code: null, name: null };
            return response.text().then(function (html) {
                return readTerm(htmlDoc(html));
            });
        }, function () {
            return { code: null, name: null };
        });
    }

    var live = harvestPage(document);
    // 课表页上已有课程格子：用屏幕上的那份（学期也取它的，它就是用户看到的那一学期）；
    // 否则学期取 GET 教学周历页的选中项，再去请求课表。
    var onScreen = courseCells(live.rows) > 0;

    // 页面地址只交协议、主机与路径：查询串里可能带学号，不交（AUDIT.md §11 第 7 条）
    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function payloadOf(flight, calendar) {
        return JSON.stringify({
            source: 'qz-jsxsd',
            pageUrl: pageUrlOf(),
            now: todayIso(),
            term: flight.term,
            screenTermMissing: flight.screenTermMissing === true,
            cols: flight.cols,
            calendar: calendar,
            rows: flight.rows
        });
    }

    return fetchTerm().then(function (fetched) {
        var term = (onScreen && live.term.code) ? live.term : (fetched.code ? fetched : live.term);
        return fetchCalendar(term.code).then(function (calendar) {
            if (onScreen) {
                return payloadOf({ term: term, cols: live.cols, rows: live.rows, screenTermMissing: !live.term.code }, calendar);
            }
            if (!term.code) {
                throw new Error('找不到学年学期：课表页与教学周历页都没有「学年学期」下拉框。' + LOGIN_HINT);
            }
            return requestText(SCHEDULE_PATH, scheduleBody(term.code)).then(function (html) {
                var got = harvestPage(htmlDoc(html));
                if (courseCells(got.rows) === 0) {
                    throw new Error(
                        '教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT
                    );
                }
                return payloadOf({ term: term, cols: got.cols, rows: got.rows }, calendar);
            });
        });
    });
})()
