(function () {
    // 东北林业大学 教务适配器 —— 强智科技「教务管理系统」新版界面（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 NEFU/nefu.js（MIT，上游作者 Chr0n0stasis）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/NEFU/adapters.yaml：adapter_name「东北林业大学本部本科生院」，maintainer「Chr0n0stasis」，
    //   import_url = https://jwxt.nefu.edu.cn/jsxsd/
    // 上游快照 1dc0772（2026-10-17）；本校脚本最后一次修改 247e1e1（2026-09-28）。
    //
    // 平台判据按脚本**实际请求的接口路径**（与上游 PATH 一致），不按注释：
    //   GET  /jsxsd/xskb/xskb_list.do?viweType=0                             课表页（默认学期、作息模式、周次）
    //   GET  /jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=..&kbjcmsid=..&zc=  指定查询条件的课表页
    //   POST /jsxsd/jxzl/jxzl_query   请求体只有 xnxq01id=<学期>             教学周历（本件新增，只为开学日与总周数）
    //
    // 取数流程：
    //   ① GET 课表页（不带查询参数），读学期、作息模式两个下拉框的当前值；不弹窗，学期就是页面默认选中的那一学期；
    //      作息模式取文字正好是「本部」的那一项，没有就用当前值（parse.js 会提醒）；
    //   ② GET 同一页面，带上学期 / 作息模式 / 周次（周次为空 = 整学期）；
    //   ③ POST 教学周历；取不到不算致命，parse.js 兜底并提醒。
    //
    // 只读：不读账号和密码，只判断登录表单是否存在（不读它的值）；不写页面、不提交表单、不外发任何数据。
    // 页面地址只交协议、主机与路径，不交查询串。详见 AUDIT.md。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从学期列表里选（上游 showSingleSelection）：学期取页面默认选中项；
    //   ② 去掉上游的 showToast、notifyTaskCompletion、saveImportedCourses 等界面与保存调用（脚本对页面只读）；
    //   ③ 课表只交原始结构（表头、每行每格的跨行跨列数、名称属性、文字、课程卡片的结构），
    //      星期、节次、周次、课名的解释全在 parse.js —— 那边 CI 里能真跑；
    //   ④ 新增：教学周历（上游没有），用来取开学日与总周数；
    //   ⑤ 去掉上游「仅导入课程，保留原有作息和学期设置」的提醒，改由 parse.js 给出本件自己的提醒；
    //   ⑥ 页面地址只交协议、主机与路径，不交查询串（查询串里可能带学号）。
    var HOST = 'jwxt.nefu.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var MODE_NAME = '本部';
    var LOGIN_HINT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';
    var LOGIN_TITLE = /登录/;
    var CN_DATE = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?/;

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。教务给不出开学日时由 parse.js 用它推算。
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
        var classes = ' ' + String(node.className || '').replace(/\s+/g, ' ') + ' ';
        return classes.indexOf(' ' + name + ' ') >= 0;
    }

    // 后代里所有带这个类名的元素（按文档顺序）
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

    function childrenNamed(node, tag) {
        var out = [];
        var kids = childElements(node);
        for (var i = 0; i < kids.length; i++) {
            if (tagOf(kids[i]) === tag) out.push(kids[i]);
        }
        return out;
    }

    function closestTable(node) {
        var at = node;
        while (at && at.nodeType === 1) {
            if (tagOf(at) === 'TABLE') return at;
            at = at.parentNode;
        }
        return null;
    }

    function spanOf(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return isNaN(value) ? 1 : value;
    }

    // 课程卡片：只交结构和文字。课名在 .qz-hasCourse-title，「老师:…;时间:…;地点:…」在 .qz-hasCourse-abbrinfo。
    // 是不是课程卡片（li.courselists-item）由 parse.js 判断，这里照实交出 course 布尔值。
    function cardOf(node) {
        var title = firstByClass(node, 'qz-hasCourse-title');
        var abbr = firstByClass(node, 'qz-hasCourse-abbrinfo');
        return {
            course: tagOf(node) === 'LI' && hasClass(node, 'courselists-item'),
            title: title ? clean(title.textContent) : '',
            abbr: abbr ? clean(abbr.textContent) : ''
        };
    }

    // 格子里的课程列表：上游只读 ul[name="kbdataUl"]。个数、kbdatasize 属性原样交出，由 parse.js 核对。
    function listsOf(node) {
        var uls = node.getElementsByTagName('ul');
        var out = [];
        for (var i = 0; i < uls.length; i++) {
            if (attrOf(uls[i], 'name') !== 'kbdataUl') continue;
            var items = [];
            var kids = childElements(uls[i]);
            for (var k = 0; k < kids.length; k++) items.push(cardOf(kids[k]));
            out.push({ size: uls[i].getAttribute('kbdatasize'), items: items });
        }
        return out;
    }

    // 一个 td / th：跨行跨列数是 HTML 上的值（没有或不是数字时为 1），不在这里做网格占位，占位由 parse.js 做
    function cellOf(node) {
        return {
            name: attrOf(node, 'name'),
            rowSpan: spanOf(node, 'rowspan'),
            colSpan: spanOf(node, 'colspan'),
            text: clean(node.textContent),
            lists: listsOf(node)
        };
    }

    function rowCellsOf(tr) {
        var out = [];
        var kids = childElements(tr);
        for (var i = 0; i < kids.length; i++) {
            var tag = tagOf(kids[i]);
            if (tag === 'TD' || tag === 'TH') out.push(cellOf(kids[i]));
        }
        return out;
    }

    // 课表：表头第一行、所有 tbody 的行（按顺序拼成一个数组）、表尾的备注文字。
    function tableOf(table) {
        var heads = childrenNamed(table, 'THEAD');
        var headRow = heads.length ? childrenNamed(heads[0], 'TR')[0] : null;
        var body = [];
        var bodies = childrenNamed(table, 'TBODY');
        for (var b = 0; b < bodies.length; b++) {
            var trs = childrenNamed(bodies[b], 'TR');
            for (var t = 0; t < trs.length; t++) body.push(rowCellsOf(trs[t]));
        }
        var foot = [];
        var foots = table.getElementsByTagName('tfoot');
        for (var f = 0; f < foots.length; f++) {
            var marks = allByClass(foots[f], 'qz-weeklyTable-detailtext');
            for (var m = 0; m < marks.length; m++) foot.push(clean(marks[m].textContent));
        }
        return { head: headRow ? rowCellsOf(headRow) : [], body: body, foot: foot };
    }

    function tablesOf(doc) {
        var all = doc.getElementsByTagName('table');
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (hasClass(all[i], 'qz-weeklyTable')) out.push(tableOf(all[i]));
        }
        return out;
    }

    // 教学周历的表：先认 #kbtable，认不出就找第一个带「2026年09月07日」这类 title 的格子所在的表（日期挂在 td[title] 上）。
    function findCalendarTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cells = doc.getElementsByTagName('td');
        for (var i = 0; i < cells.length; i++) {
            if (CN_DATE.test(attrOf(cells[i], 'title'))) return closestTable(cells[i]);
        }
        return null;
    }

    function calendarOf(doc) {
        var table = findCalendarTable(doc);
        if (!table) return null;
        var rows = [];
        var trs = table.getElementsByTagName('tr');
        for (var t = 0; t < trs.length; t++) {
            var cells = [];
            var kids = childElements(trs[t]);
            for (var k = 0; k < kids.length; k++) {
                var tag = tagOf(kids[k]);
                if (tag !== 'TD' && tag !== 'TH') continue;
                cells.push({
                    rowSpan: spanOf(kids[k], 'rowspan'),
                    colSpan: spanOf(kids[k], 'colspan'),
                    text: clean(kids[k].textContent),
                    title: clean(attrOf(kids[k], 'title'))
                });
            }
            rows.push(cells);
        }
        return { rows: rows };
    }

    function titleOf(doc) {
        var titles = doc.getElementsByTagName('title');
        return titles.length ? clean(titles[0].textContent) : '';
    }

    function hasLoginForm(doc) {
        return !!(doc.getElementById('userAccount') || doc.getElementById('userPassword'));
    }

    // 下拉框：只交选中值与选项（值、文字）。缺了这个下拉框交 null，由 parse.js 报错。
    function selectOf(doc, id) {
        var select = doc.getElementById(id);
        if (!select) return null;
        var options = [];
        for (var i = 0; i < select.options.length; i++) {
            options.push({ value: String(select.options[i].value), label: clean(select.options[i].textContent) });
        }
        return { selected: String(select.value), options: options };
    }

    // 作息模式：文字正好是「本部」的那一项；没有就用当前选中的那一项
    function chooseMode(select) {
        for (var i = 0; i < select.options.length; i++) {
            if (select.options[i].label === MODE_NAME) return select.options[i].value;
        }
        return select.selected;
    }

    function hostOf(url) {
        var m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || ''));
        return m ? m[1].toLowerCase() : HOST;
    }

    function readPage(response) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('教务系统拒绝访问（' + response.status + '）：' + LOGIN_HINT);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
        }
        // 被重定向到别的主机（一般是统一身份认证页）：登录已经失效
        if (hostOf(response.url) !== HOST) {
            throw new Error('登录已失效，请重新登录。' + LOGIN_HINT);
        }
        return response.text().then(function (html) {
            return new DOMParser().parseFromString(html, 'text/html');
        });
    }

    function getPage(url) {
        return fetch(url, { method: 'GET', credentials: 'same-origin' }).then(readPage, function () {
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        });
    }

    // 教学周历取不到不致命：返回 null，parse.js 用兜底口径并提醒
    function postCalendar(term) {
        return fetch(CALENDAR_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'xnxq01id=' + encodeURIComponent(term),
            credentials: 'same-origin'
        }).then(readPage).then(calendarOf).then(null, function () {
            return null;
        });
    }

    function loginLike(doc) {
        return hasLoginForm(doc) || LOGIN_TITLE.test(titleOf(doc));
    }

    // 页面地址只交协议、主机与路径（查询串里可能带学号）
    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function payloadOf(doc, request, calendar) {
        return {
            source: 'qz-jsxsd',
            pageUrl: pageUrlOf(),
            now: todayIso(),
            loginTitle: LOGIN_TITLE.test(titleOf(doc)),
            loginForm: hasLoginForm(doc),
            request: request,
            selects: {
                xnxq01id: selectOf(doc, 'xnxq01id'),
                kbjcmsid: selectOf(doc, 'kbjcmsid'),
                zc: selectOf(doc, 'zc')
            },
            tables: tablesOf(doc),
            calendar: calendar
        };
    }

    function run() {
        if (window.location.host !== HOST) {
            return Promise.reject(new Error('请在东北林业大学教务系统中执行导入。' + LOGIN_HINT));
        }
        return getPage(SCHEDULE_PATH + '?viweType=0').then(function (first) {
            if (loginLike(first)) throw new Error('当前页面不是课表，' + LOGIN_HINT);
            var semester = selectOf(first, 'xnxq01id');
            var mode = selectOf(first, 'kbjcmsid');
            if (!semester || !semester.selected || !mode) {
                throw new Error('当前页面找不到学年学期或作息模式的选项，' + LOGIN_HINT);
            }
            var modeValue = chooseMode(mode);
            var query = '?viweType=0&xnxq01id=' + encodeURIComponent(semester.selected) +
                '&kbjcmsid=' + encodeURIComponent(modeValue) + '&zc=';
            return getPage(SCHEDULE_PATH + query).then(function (page) {
                var request = { xnxq01id: semester.selected, kbjcmsid: modeValue, zc: '' };
                return postCalendar(semester.selected).then(function (calendar) {
                    return JSON.stringify(payloadOf(page, request, calendar));
                });
            });
        });
    }

    return run();
})()
