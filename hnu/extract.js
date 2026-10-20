(function () {
    // 湖南大学 教务适配器 —— 强智科技「教务管理系统」新版界面（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 HNU/hnu_01.js（MIT，上游作者 星河欲转）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/HNU/adapters.yaml：adapter_name「湖南大学强智教务」，maintainer「星河欲转」，
    //   import_url = http://hdjw.hnu.edu.cn/jsxsd/sso.jsp
    // 上游快照 19a65bf（2026-10-19）；本校脚本最后一次修改 dd65c99。
    //
    // 平台判据按脚本**实际请求的接口路径**（与上游 URL_SEMESTER / URL_COURSE 一致），不按注释：
    //   GET  /jsxsd/jxzl/jxzl_query                       教学周历页（学年学期下拉框 #xnxq01id；页面当前没有可用学期时才取）
    //   GET  /jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=<学期>   课表页（table.qz-weeklyTable，课程详情在 tooltip 里）
    //   POST /jsxsd/jxzl/jxzl_query   请求体只有 xnxq01id=<学期>   教学周历（开学日期与周数，表 #dataTable）
    //
    // 取数流程：
    //   ① 学期：用户正停在课表页或教学周历页、且页面的学年学期下拉框有合法选中项时，就用这一项（用户看到哪一学期就导入哪一学期）；
    //      否则 GET 教学周历页，取下拉框的选中项（上游弹窗时的默认项）。不弹窗问学期；
    //   ② GET 课表页（带学期）；
    //   ③ POST 教学周历；取不到不算致命，parse.js 兜底并提醒。
    //
    // 只读：不读账号和密码，只判断登录表单是否存在（不读它的值）；不写页面、不提交表单、不外发任何数据。
    // 页面地址只交协议、主机与路径，不交查询串。详见 AUDIT.md。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从学期列表里选（上游 showSingleSelection）：学期取页面当前选中项，不弹窗；
    //   ② 去掉上游的 showAlert、showToast、notifyTaskCompletion、saveCourseConfig、savePresetTimeSlots、saveImportedCourses
    //      等界面与保存调用（脚本对页面只读；保存由应用负责）；
    //   ③ 课表只交原始结构（表头、每行每格的跨行跨列数、是否节次标签、课程详情里老师 / 地点 / 时间三项的文字），
    //      星期、节次、周次、课名的解释与合并全在 parse.js —— 那边 CI 里能真跑；课程详情按字段白名单挑，其余文字不交；
    //   ④ 教学周历只交周号标签与每格的日期文字（上游在这里就地算出开学日与总周数，现在交给 parse.js 算）；
    //   ⑤ 请求用页面同源的相对路径（上游写死 https://hdjw.hnu.edu.cn）；请求前先确认页面主机，被重定向走了就报登录已失效；
    //   ⑥ 页面地址只交协议、主机与路径，不交查询串。
    var HOST = 'hdjw.hnu.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var LOGIN_HINT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';
    var TERM_CODE = /^\d{4}-\d{4}-\d$/;
    var DETAIL_PREFIX = /^(老师|地点|时间)\s*[:：]/;
    var TEXT_CLIP = 60;

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function clip(text, max) {
        var one = String(text);
        return one.length > max ? one.substring(0, max) : one;
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

    function childElements(node) {
        var out = [];
        var kids = node.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            if (kids[i].nodeType === 1) out.push(kids[i]);
        }
        return out;
    }

    function cellChildren(tr) {
        var out = [];
        var kids = childElements(tr);
        for (var i = 0; i < kids.length; i++) {
            var tag = tagOf(kids[i]);
            if (tag === 'TD' || tag === 'TH') out.push(kids[i]);
        }
        return out;
    }

    // 跨行跨列数：没有或不是数字时为 1，0 原样交出（由 parse.js 报错）
    function spanOf(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return isNaN(value) ? 1 : value;
    }

    // 课程详情：上游只读 .qz-tooltip li.qz-toolitiplists 里的课名 .qz-tooltipContent-title
    // 与 .qz-tooltipContent-detailitem（「老师：…」「地点：…」「时间：…」）。其余详情文字不交。
    function cardsOf(cell) {
        var items = cell.querySelectorAll('.qz-tooltip li.qz-toolitiplists');
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var title = items[i].querySelector('.qz-tooltipContent-title');
            var details = [];
            var nodes = items[i].querySelectorAll('.qz-tooltipContent-detailitem');
            for (var k = 0; k < nodes.length; k++) {
                var text = clean(nodes[k].textContent);
                if (DETAIL_PREFIX.test(text)) details.push(text);
            }
            out.push({ title: title ? clean(title.textContent) : '', details: details });
        }
        return out;
    }

    // 上游判据：name="timeTd" 或带类 qz-weeklyTable-label 的格子是节次标签
    function isLabel(td) {
        return attrOf(td, 'name') === 'timeTd' || hasClass(td, 'qz-weeklyTable-label');
    }

    function cellOf(td) {
        var label = isLabel(td);
        return {
            label: label,
            rowSpan: spanOf(td, 'rowspan'),
            colSpan: spanOf(td, 'colspan'),
            // 格子里有没有可见文字（只交有无，不交文字：tooltip 里还有学号、班级等不在白名单里的内容）
            hasText: !label && clean(td.textContent) !== '',
            cards: label ? [] : cardsOf(td)
        };
    }

    // 课表：表头（上游读 thead 里所有 th / td）与所有 tbody 的行。上游取页面里第一张 table.qz-weeklyTable，
    // 这里全部交出，由 parse.js 挑表头认得出星期的那一张。
    function tableOf(table) {
        var head = [];
        var headCells = table.querySelectorAll('thead tr th, thead tr td');
        for (var h = 0; h < headCells.length; h++) {
            head.push({ text: clip(clean(headCells[h].textContent), 40) });
        }
        var body = [];
        var trs = table.querySelectorAll('tbody tr');
        for (var t = 0; t < trs.length; t++) {
            var cells = [];
            var tds = cellChildren(trs[t]);
            for (var k = 0; k < tds.length; k++) cells.push(cellOf(tds[k]));
            body.push(cells);
        }
        return { head: head, body: body };
    }

    function tablesOf(doc) {
        var all = doc.querySelectorAll('table.qz-weeklyTable');
        var out = [];
        for (var i = 0; i < all.length; i++) out.push(tableOf(all[i]));
        return out;
    }

    // 教学周历（上游 fetchSemesterInfo）：表 #dataTable，每个周一行；节次标签格 td.qz-weeklyTable-label 写「第N周」，
    // 其余格子是当周每天的日期（「09月07日」，没有年份）。只交每行的周号标签与各格的文字 / title，不做任何计算。
    function calendarOf(doc) {
        var table = doc.getElementById('dataTable');
        if (!table) return null;
        var rows = [];
        var trs = table.querySelectorAll('tbody tr');
        for (var t = 0; t < trs.length; t++) {
            var tds = cellChildren(trs[t]);
            if (!tds.length) continue;
            var label = '';
            var cells = [];
            for (var k = 0; k < tds.length; k++) {
                if (hasClass(tds[k], 'qz-weeklyTable-label')) {
                    if (!label) label = clip(clean(tds[k].textContent), 20);
                    continue;
                }
                cells.push({
                    text: clip(clean(tds[k].textContent), TEXT_CLIP),
                    title: clip(clean(attrOf(tds[k], 'title')), 40)
                });
            }
            rows.push({ label: label, cells: cells });
        }
        return { rows: rows };
    }

    function titleOf(doc) {
        var titles = doc.getElementsByTagName('title');
        return titles.length ? clean(titles[0].textContent) : '';
    }

    // 登录表单：只看元素是否存在，不读它们的值
    function hasLoginForm(doc) {
        return !!(doc.getElementById('userAccount') || doc.getElementById('userPassword'));
    }

    // 页面标题很短且带「登录」：登录页（正常课表页的标题不会这么短）
    function loginTitle(doc) {
        var title = titleOf(doc);
        return title.length > 0 && title.length <= 12 && /登录/.test(title);
    }

    function loginLike(doc) {
        return hasLoginForm(doc) || loginTitle(doc);
    }

    // 学年学期下拉框的当前选中项（上游 fetchSemesterList：没有 selected 的取第一项）。值不是「2025-2026-2」这种写法就当没有。
    // fetched 为真（页面是我们请求回来的）时，所有选项都没有 selected 属性 = 教务没有标出当前学期，取第一项并带 assumed，
    // 由 parse.js 提醒；用户正看着的页面不算（下拉框可能是用户自己选的，选中状态不在属性里）。
    function termOfSelect(doc, fetched) {
        var select = doc.getElementById('xnxq01id');
        if (!select || !select.options || !select.options.length) return null;
        var at = select.selectedIndex;
        if (at < 0) at = 0;
        var marked = false;
        for (var i = 0; i < select.options.length; i++) {
            if (select.options[i].hasAttribute('selected')) marked = true;
        }
        var option = select.options[at];
        var code = clean(option.value);
        if (!TERM_CODE.test(code)) return null;
        return { code: code, label: clean(option.textContent), assumed: !!fetched && !marked };
    }

    // 用户正停在课表页或教学周历页（路径在 /jsxsd/xskb/ 或 /jsxsd/jxzl/ 下）：这两页的下拉框才是「当前学期」
    function onTermPage() {
        var path = String(window.location.pathname || '');
        return path.indexOf('/jsxsd/xskb/') === 0 || path.indexOf('/jsxsd/jxzl/') === 0;
    }

    function hostOf(url) {
        var m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || ''));
        return m ? m[1].toLowerCase() : HOST;
    }

    function readPage(response) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('教务系统拒绝访问（代码 ' + response.status + '）：' + LOGIN_HINT);
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

    function getPage(path) {
        return fetch(path, { method: 'GET', credentials: 'same-origin' }).then(readPage, function () {
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        });
    }

    // 教学周历取不到不致命：返回 null，parse.js 用兜底口径并提醒
    function postCalendar(code) {
        return fetch(CALENDAR_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'xnxq01id=' + encodeURIComponent(code),
            credentials: 'same-origin'
        }).then(readPage).then(calendarOf).then(null, function () {
            return null;
        });
    }

    // 页面地址只交协议、主机与路径（查询串里可能带学号）
    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function payloadOf(doc, term, calendar) {
        return {
            source: 'qz-jsxsd-hnu',
            pageUrl: pageUrlOf(),
            now: todayIso(),
            loginTitle: loginTitle(doc),
            loginForm: hasLoginForm(doc),
            term: term,
            tables: tablesOf(doc),
            calendar: calendar
        };
    }

    function currentTerm() {
        var onPage = onTermPage() ? termOfSelect(document) : null;
        if (onPage) return Promise.resolve(onPage);
        return getPage(CALENDAR_PATH).then(function (doc) {
            if (loginLike(doc)) throw new Error('登录已失效，请重新登录。' + LOGIN_HINT);
            return termOfSelect(doc, true);
        });
    }

    function run() {
        if (window.location.host !== HOST) {
            return Promise.reject(new Error('请在湖南大学教务系统中执行导入。' + LOGIN_HINT));
        }
        if (loginLike(document)) {
            return Promise.reject(new Error('当前页面不是课表，' + LOGIN_HINT));
        }
        return currentTerm().then(function (term) {
            if (!term) throw new Error('找不到学年学期的选项，' + LOGIN_HINT);
            // 上游 requestCoursePage：viweType=0（拼写照抄）与 xnxq01id
            var path = SCHEDULE_PATH + '?viweType=0&xnxq01id=' + encodeURIComponent(term.code);
            return getPage(path).then(function (page) {
                if (loginLike(page)) throw new Error('登录已失效，请重新登录。' + LOGIN_HINT);
                return postCalendar(term.code).then(function (calendar) {
                    return JSON.stringify(payloadOf(page, term, calendar));
                });
            });
        });
    }

    return run();
})()
