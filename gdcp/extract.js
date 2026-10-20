(function () {
    // 广东交通职业技术学院 教务适配器 —— 强智科技「高校综合管理教务系统」（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 GDCP/gdcp_02.js（MIT，上游作者 Haooz；作息与教学楼数据沿用同目录 gdcp_01.js，作者 小漫君）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/GDCP/adapters.yaml：GDCP_01「广东交通职业技术学院强智教务」（maintainer 小漫君，import_url https://cas.gdcp.edu.cn/），
    //   GDCP_02 同名（maintainer Haooz，import_url https://jw.gdcp.edu.cn/）。两份脚本请求的路径、请求体、选择器完全一致，
    //   区别只在校区的取法：01 弹窗问校区，02 按教学楼自动判断。本件移植 02，登录入口用 02 的 jw.gdcp.edu.cn。
    //   上游快照 19a65bf（2026-10-19 拉取），GDCP 目录最后一次修改 14032a1。
    //
    // 平台判据按脚本实际请求的接口路径，不按注释：
    //   GET  /jsxsd/xskb/xskb_list.do    课表页（读「学年学期」下拉框 #xnxq01id 与节次模式下拉框 #kbjcmsid）
    //   POST /jsxsd/xskb/xskb_list.do    整学期课表（服务端渲染的 HTML，不是 JSON；容器 #timetable、div.kbcontent）
    //   POST /jsxsd/jxzl/jxzl_query      教学周历（开学日期与周号）
    //
    // 取数方式：
    //   ① 当前页面就有课表格子、且没有选定某一周 → 直接用（用户此刻看到的那张，不多发课表请求）；
    //   ② 否则 GET 课表页读学期与节次模式（页面上已有就不发），再 POST 整学期课表，请求体与上游一字不差
    //      （cj0701id=&zc=&demo=&xnxq01id=<学期>&sfFD=1&kbjcmsid=<节次模式>）；
    //   ③ 两条路都再 POST 一次教学周历取开学日期与总周数，取不到不是致命错误，由 parse.js 推算并出提醒。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从列表里选学期（上游 showSingleSelection，默认项就是页面选中项）：学期取页面下拉框的选中项；
    //   ② 不弹窗问校区：校区由 parse.js 按教学楼判断（上游 02 同样不问）；
    //   ③ 只交原始结构出去（学期 + 每格的网格列号 col / 跨列数 span / 去掉悬浮详情后的原始 HTML + 周历的网格），
    //      周次 / 节次 / 课程名 / 校区的解释全在 parse.js —— 那边 CI 里能真跑；
    //   ④ 悬浮详情（.item-box）在复制出来的节点上摘掉，页面本身不动；每格只读第一个类名正好是 kbcontent 的 div（上游同样）；
    //   ⑤ 去掉上游的 showAlert / showToast / saveCourseConfig / savePresetTimeSlots / saveImportedCourses 等拾光界面调用；
    //   ⑥ 不在教务主机上、或停在登录页时直接报错，不发请求；
    //   ⑦ 选定了某一周的课表页不当整学期用（只显示那一周的课），改走 ②。
    //
    // 只请求当前页面同源的教务服务器（jw.gdcp.edu.cn）的相对路径：不读账号密码（只看登录页上有没有密码框）、
    // 不写页面、不外发任何数据。详见 AUDIT.md。
    var HOST = 'jw.gdcp.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var LOGIN_HINT = '请先登录教务系统并打开课表页面，确认页面上能看到课表再点「提取课表」';
    var NOT_JW = '当前页面不是教务系统。请先登录融合门户，打开「新教务系统」并进入课表页面，确认能看到课表再点「提取课表」';
    var ON_LOGIN = '当前是教务系统的登录页。请先登录，再进入课表页面，确认页面上能看到课表再点「提取课表」';
    var CN_DATE = /\d{4}\s*[-年]\s*\d{1,2}\s*[-月]\s*\d{1,2}/;

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

    function hasClass(node, name) {
        var classes = ' ' + String((node && node.className) || '').replace(/\s+/g, ' ') + ' ';
        return classes.indexOf(' ' + name + ' ') >= 0;
    }

    // 一格里的课程明细：强智把课程名 + 教师 / 周次(节次) / 教室 / 教学楼写在类名正好是 kbcontent 的 div 里。
    // 上游每格只读第一个这样的 div；明细里还嵌着悬浮详情（.item-box，内容与明细重复），在复制出来的节点上摘掉再取 HTML。
    function partsOf(cell) {
        var divs = cell.getElementsByTagName('div');
        for (var i = 0; i < divs.length; i++) {
            if (!hasClass(divs[i], 'kbcontent')) continue;
            var copy = divs[i].cloneNode(true);
            var boxes = copy.querySelectorAll ? copy.querySelectorAll('.item-box') : [];
            for (var b = 0; b < boxes.length; b++) {
                if (boxes[b].parentNode) boxes[b].parentNode.removeChild(boxes[b]);
            }
            var html = String(copy.innerHTML || '').trim();
            return html && html !== '&nbsp;' ? [html] : [];
        }
        return [];
    }

    // 格子的文字只在没有课程明细时才交（节次标签、星期表头要靠它认）；有明细的格子文字与明细重复，不交
    function cellOf(node, col, span, withNode) {
        var parts = partsOf(node);
        var text = node.textContent !== undefined ? node.textContent : node.innerText;
        var cell = { col: col, span: span, text: parts.length ? '' : clean(text), parts: parts };
        // withNode 只给周历用：它要读 td[title] 上的日期
        if (withNode) cell.node = node;
        return cell;
    }

    function spanOfAttr(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return value >= 1 ? value : 1;
    }

    // carry[c] = 第 c 列还被前面某一行的 rowspan 占着几行（不含当前行）。
    // 每进一行先把占用的列标出来并把计数减 1；rowspan 格子只在它自己那一行留下 td，它占住的列在下一行必须空出来，
    // 否则下一行的格子会整体左移一格 —— 课表的首列是节次列，它常被 rowspan 跨两行，正是靠 col 才对齐得回来。
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

    // 课表容器：上游写死 #timetable。认不出 #timetable 就退一步找 #kbtable（强智其它部署的 id），再找最近一张含 .kbcontent 格子的表。
    function findScheduleTable(doc) {
        var byId = doc.getElementById('timetable') || doc.getElementById('kbtable');
        if (byId) return byId;
        var cell = doc.querySelector ? doc.querySelector('.kbcontent') : null;
        return cell ? closestTable(cell) : null;
    }

    // 课表：整张表还原成网格，每个格子带上网格列号 col 与跨列数 span，表宽一起交出去。
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

    // 教学周历的容器：#kbtable；认不出就找第一张有日期 title 的表（周历的日期挂在 td[title] 上）；再不行取文档里第一张表（上游的做法）
    function findCalendarTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cells = doc.getElementsByTagName('td');
        for (var i = 0; i < cells.length; i++) {
            if (CN_DATE.test(attrOf(cells[i], 'title'))) return closestTable(cells[i]);
        }
        var tables = doc.getElementsByTagName('table');
        return tables.length ? tables[0] : null;
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

    // 学期代码的形状（2026-2027-1）；放宽到只要是安全字符，换了命名规则也不至于整个取不到
    function isTermCode(value) {
        return /^[0-9A-Za-z][0-9A-Za-z_-]{3,23}$/.test(value);
    }

    // 学年学期：课表页顶部的下拉框（强智是 select[id|name 含 xnxq]，值形如 2026-2027-1）。
    // 只读选中项：用户在页面上切到哪一学期，导入的就是哪一学期。取不到选中项时取第一个合规选项。
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
                if (!isTermCode(value)) continue;
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

    // 某个下拉框当前选中项的值（按 id 找）；没有这个下拉框返回 null
    function selectValue(doc, id) {
        var select = doc.getElementById(id);
        if (!select || tagOf(select) !== 'SELECT') return null;
        var options = select.options || [];
        for (var i = 0; i < options.length; i++) {
            if (options[i].selected) return clean(options[i].value);
        }
        return options.length ? clean(options[0].value) : '';
    }

    // 节次模式（#kbjcmsid）：上游把它原样带进请求体，空着就报错
    function readMode(doc) {
        var value = selectValue(doc, 'kbjcmsid');
        return value ? value : null;
    }

    // 页面上是不是选定了某一周（#zc 选了具体周次）：那样课表只显示那一周的课，不能当整学期用
    function weekFiltered(doc) {
        var value = selectValue(doc, 'zc');
        return value !== null && /^[0-9]+$/.test(value) && parseInt(value, 10) > 0;
    }

    function harvestPage(doc) {
        var table = findScheduleTable(doc);
        var grid = table ? scheduleGrid(table) : { cols: 0, rows: [] };
        return {
            term: readTerm(doc),
            mode: readMode(doc),
            filtered: weekFiltered(doc),
            cols: grid.cols,
            rows: grid.rows
        };
    }

    function htmlDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    // 只看登录页上有没有密码输入框，不读它的值
    function hasPasswordInput(doc) {
        var inputs = doc.getElementsByTagName('input');
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === 'password') return true;
        }
        return false;
    }

    function requestText(method, path, body) {
        var init = { method: method, credentials: 'same-origin' };
        if (body !== null) {
            init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            init.body = body;
        }
        return fetch(path, init).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('教务系统拒绝访问（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        });
    }

    // 课表页的请求体：与上游一字不差（上游 URLSearchParams 的顺序与空参数都留着）
    function scheduleBody(code, mode) {
        return 'cj0701id=&zc=&demo=&xnxq01id=' + encodeURIComponent(code) + '&sfFD=1&kbjcmsid=' + encodeURIComponent(mode);
    }

    // 教学周历的请求体：与上游一致，只有 xnxq01id
    function calendarBody(code) {
        return 'xnxq01id=' + encodeURIComponent(code);
    }

    // 周历取不到（教务改了页面、这一学期没有周历、返回的不是所选学期）不算致命：开学日期由 parse.js 推算并说明。
    // 这里返回空网格而不是抛错。没有学期代码时不发请求。上游要求返回页上的学期下拉框与所选学期一致，这里同样。
    function fetchCalendar(code) {
        if (!code) return Promise.resolve({ found: false, rows: [] });
        return requestText('POST', CALENDAR_PATH, calendarBody(code)).then(function (html) {
            var doc = htmlDoc(html);
            if (readTerm(doc).code !== code) return { found: false, rows: [] };
            var table = findCalendarTable(doc);
            var rows = table ? calendarGrid(table) : [];
            return { found: rows.length > 0, rows: rows };
        }, function () {
            return { found: false, rows: [] };
        });
    }

    // 课表页上读学期与节次模式（GET 课表页）
    function fetchPageInfo() {
        return requestText('GET', SCHEDULE_PATH, null).then(function (html) {
            var doc = htmlDoc(html);
            return { term: readTerm(doc), mode: readMode(doc) };
        });
    }

    // 页面地址只交协议、主机与路径：查询串里可能带学号，不交
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

    if (String(window.location.hostname).toLowerCase() !== HOST) throw new Error(NOT_JW);

    var live = harvestPage(document);
    // 课表页上已有课程格子、且没有选定某一周：用屏幕上的那份（学期也取它的，它就是用户看到的那一学期）
    var onScreen = courseCells(live.rows) > 0 && !live.filtered;
    if (!onScreen && courseCells(live.rows) === 0 && hasPasswordInput(document)) throw new Error(ON_LOGIN);

    if (onScreen) {
        var termStep = live.term.code
            ? Promise.resolve(live.term)
            : fetchPageInfo().then(function (info) { return info.term; }, function () { return { code: null, name: null }; });
        return termStep.then(function (term) {
            return fetchCalendar(term.code).then(function (calendar) {
                return payloadOf({ term: term, cols: live.cols, rows: live.rows, screenTermMissing: !live.term.code }, calendar);
            });
        });
    }

    var infoStep = (live.term.code && live.mode)
        ? Promise.resolve({ term: live.term, mode: live.mode })
        : fetchPageInfo().then(function (info) {
            return { term: live.term.code ? live.term : info.term, mode: live.mode || info.mode };
        });
    return infoStep.then(function (info) {
        if (!info.term.code || !info.mode) {
            throw new Error('教务页面里没找到「学年学期」或节次模式选项：' + LOGIN_HINT);
        }
        return requestText('POST', SCHEDULE_PATH, scheduleBody(info.term.code, info.mode)).then(function (html) {
            var got = harvestPage(htmlDoc(html));
            if (got.term.code && got.term.code !== info.term.code) {
                throw new Error('教务系统返回的课表不是所选学期（' + info.term.code + '）的，请在课表页选好学期后重试');
            }
            if (courseCells(got.rows) === 0) {
                throw new Error('教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
            }
            return fetchCalendar(info.term.code).then(function (calendar) {
                return payloadOf({ term: info.term, cols: got.cols, rows: got.rows }, calendar);
            });
        });
    });
})()
