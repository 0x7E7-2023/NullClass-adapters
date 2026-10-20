(function () {
    // 中国海洋大学 教务适配器 —— 强智科技「教务管理系统」新版界面（学生端 /jsxsd/，教务主机 jwgl2024.ouc.edu.cn）。
    // 移植自 shiguang_warehouse 的 OUC/ouc_01.js（MIT，上游作者 anOsprey）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/OUC/adapters.yaml：adapter_name「中国海洋大学本科教务系统」，maintainer「anOsprey」，
    //   import_url = https://id.ouc.edu.cn/sso/login?service=https%3A%2F%2Fjwgl2024.ouc.edu.cn%2F
    // 上游快照 19a65bf（2026-10-19 拉取）；本校脚本最后一次修改 1f02b9f。
    //
    // 平台判据按脚本**实际请求的接口路径**（与上游 URL_COURSE / URL_CALENDAR 一致），不按注释：
    //   GET /jsxsd/xskb/xskb_list.do?viweType=0                    课表页（读学年学期下拉框；页面上已有就跳过这一步）
    //   GET /jsxsd/xskb/xskb_list.do?viweType=0&…&xnxq01id=..&zc=&kbjcmsid=..   指定学期的周课表（参数与上游 fetchCourses 一字不差）
    //   GET /jsxsd/jxzl/jxzl_query?xnxq01id=..                     教学周历（开学日与总周数；上游同样是 GET）
    //
    // 取数流程：
    //   ① 学期：当前页面有 select#xnxq01id 就取它的选中项（用户在页面上切到哪一学期，导入的就是哪一学期）；
    //      没有就 GET 一次课表页，取页面默认选中的那一学期。不弹窗让用户选学期；
    //   ② GET 周课表（作息方案 kbjcmsid 用上游写死的值；页面上的下拉框里根本没有这个值时，改用页面选中的那一项，并由 parse.js 提醒）；
    //   ③ GET 教学周历；取不到不致命，由 parse.js 兜底并提醒；
    //   ④ 校区作息：上游让用户在崂山/鱼山与西海岸之间选一次。这里照上游问一次（__ncSelect）；只有请求的是页面自己选中的作息方案时，
    //      方案名称、第一大节的上课时间才与学生相关，能明确判断就省掉提问；问不了或用户取消，交 null，由 parse.js 按崂山/鱼山的节次时间导入并提醒。
    //
    // 只读：不读账号和密码，只判断登录表单是否存在（不读它的值）；不写页面、不提交表单、不外发任何数据。
    // 页面地址只交协议、主机与路径，不交查询串。详见 AUDIT.md。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数、展开与块级声明关键字）；
    //   ② 不弹窗让用户从学期列表里选（上游 showSingleSelection）：学期取页面选中项；
    //   ③ 去掉上游的 showAlert / showToast / notifyTaskCompletion / saveCourseConfig / saveImportedCourses /
    //      savePresetTimeSlots 等界面与保存调用（脚本对页面只读）；
    //   ④ 课表只交原始结构（表头、每行每格的跨行跨列数、名称属性、课程卡片的课名与文字、表尾备注），
    //      星期、节次、周次、课名的解释全在 parse.js —— 那边 CI 里能真跑；教务页面里的其它文字一律不带出；
    //   ⑤ 校区作息：请求用上游写死的作息方案时照上游问一次；走了页面选中的方案且数据明确时才省掉提问；
    //   ⑥ 页面地址只交协议、主机与路径，不交查询串（查询串里可能带学号）；
    //   ⑦ 登录页、统一认证页（别的主机）上点提取：直接给大白话提示，不发任何请求。
    var HOST = 'jwgl2024.ouc.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    // 上游写死的作息方案编号（课表请求的 kbjcmsid）
    var KBJCMSID = '16FD8C2BE55E15F9E0630100007FF6B5';
    var LOGIN_HINT = '请先在页面里登录教务系统并打开「课表查询」，确认能看到课表再点提取';
    var LOGIN_TITLE = /登录/;
    var CAMPUS_ITEMS = ['崂山/鱼山校区', '西海岸校区'];
    var MAX_CARD_TEXT = 400;
    var MAX_FOOT = 20;

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
        var classes = ' ' + String((node && node.className) || '').replace(/\s+/g, ' ') + ' ';
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

    function spanOf(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return isNaN(value) ? 1 : value;
    }

    // 课程卡片：上游只读 li.courselists-item，课名在 .qz-hasCourse-title，「老师 / 时间 / 地点」从整张卡片的文字里取。
    // 这里交课名和整张卡片的文字（限长），字段的解释在 parse.js。
    function cardsOf(cell) {
        var items = cell.getElementsByTagName('li');
        var out = [];
        for (var i = 0; i < items.length; i++) {
            if (!hasClass(items[i], 'courselists-item')) continue;
            var title = firstByClass(items[i], 'qz-hasCourse-title');
            out.push({
                title: title ? clean(title.textContent) : '',
                text: clean(items[i].textContent).substring(0, MAX_CARD_TEXT)
            });
        }
        return out;
    }

    // 一个 td / th：跨行跨列数是 HTML 上的值（没有或不是数字时为 1），不在这里做网格占位，占位由 parse.js 做。
    // 课程格子（kbDataTd）只交卡片；其它格子（节次标签）交一小段文字，parse.js 靠它认第一大节的上课时间。
    function cellOf(node) {
        var name = attrOf(node, 'name');
        return {
            name: name,
            rowSpan: spanOf(node, 'rowspan'),
            colSpan: spanOf(node, 'colspan'),
            text: name === 'kbDataTd' ? '' : clean(node.textContent).substring(0, 80),
            cards: cardsOf(node)
        };
    }

    function rowCellsOf(tr, plain) {
        var out = [];
        var kids = childElements(tr);
        for (var i = 0; i < kids.length; i++) {
            var tag = tagOf(kids[i]);
            if (tag !== 'TD' && tag !== 'TH') continue;
            if (plain) {
                out.push({
                    rowSpan: spanOf(kids[i], 'rowspan'),
                    colSpan: spanOf(kids[i], 'colspan'),
                    text: clean(kids[i].textContent).substring(0, 40)
                });
            } else {
                out.push(cellOf(kids[i]));
            }
        }
        return out;
    }

    // 课表：表头（thead 第一行；没有 thead 就取第一行不带 qz-weeklyTable-tr 类名的行）、
    // 所有 tr.qz-weeklyTable-tr 的行（表头和表尾里的不算，与上游一致）、表尾的备注文字。
    function tableOf(table) {
        var trs = table.getElementsByTagName('tr');
        var headRow = null;
        var looseRow = null;
        var body = [];
        for (var t = 0; t < trs.length; t++) {
            var parentTag = tagOf(trs[t].parentNode);
            if (parentTag === 'TFOOT') continue;
            if (parentTag === 'THEAD') {
                if (!headRow) headRow = trs[t];
                continue;
            }
            if (hasClass(trs[t], 'qz-weeklyTable-tr')) {
                body.push(rowCellsOf(trs[t], false));
            } else if (!looseRow) {
                looseRow = trs[t];
            }
        }
        var foot = [];
        var foots = table.getElementsByTagName('tfoot');
        for (var f = 0; f < foots.length; f++) {
            var marks = allByClass(foots[f], 'qz-weeklyTable-detailtext');
            for (var m = 0; m < marks.length && foot.length < MAX_FOOT; m++) {
                foot.push(clean(marks[m].textContent).substring(0, 100));
            }
        }
        var head = headRow || looseRow;
        return { head: head ? rowCellsOf(head, true) : [], rows: body, foot: foot };
    }

    function weeklyTablesOf(doc) {
        var all = doc.getElementsByTagName('table');
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (hasClass(all[i], 'qz-weeklyTable')) out.push(all[i]);
        }
        return out;
    }

    // 教学周历：上游取 table.qz-weeklyTable，没有就取页面上的第一张表；只读每个格子的文字和 title 属性。
    function calendarOf(doc) {
        var tables = weeklyTablesOf(doc);
        var table = tables.length ? tables[0] : doc.getElementsByTagName('table')[0];
        if (!table) return null;
        var rows = [];
        var trs = table.getElementsByTagName('tr');
        for (var t = 0; t < trs.length; t++) {
            var cells = [];
            var kids = childElements(trs[t]);
            for (var k = 0; k < kids.length; k++) {
                var tag = tagOf(kids[k]);
                if (tag !== 'TD' && tag !== 'TH') continue;
                cells.push({ text: clean(kids[k].textContent).substring(0, 40), title: clean(attrOf(kids[k], 'title')).substring(0, 40) });
            }
            if (cells.length) rows.push(cells);
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

    function loginLike(doc) {
        return hasLoginForm(doc) || LOGIN_TITLE.test(titleOf(doc));
    }

    // 下拉框：只交选中值与选项（值、文字）。页面上没有这个下拉框交 null。
    function selectOf(doc, id) {
        var select = doc.getElementById(id);
        if (!select || !select.options) return null;
        var options = [];
        for (var i = 0; i < select.options.length; i++) {
            options.push({ value: String(select.options[i].value), label: clean(select.options[i].textContent) });
        }
        return { selected: String(select.value || ''), options: options };
    }

    function labelOf(select, value) {
        if (!select) return '';
        for (var i = 0; i < select.options.length; i++) {
            if (select.options[i].value === value) return select.options[i].label;
        }
        return '';
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
    function getCalendar(term) {
        return fetch(CALENDAR_PATH + '?xnxq01id=' + encodeURIComponent(term), {
            method: 'GET',
            credentials: 'same-origin'
        }).then(readPage).then(calendarOf).then(null, function () {
            return null;
        });
    }

    // 课表请求的地址：与上游 fetchCourses() 一字不差（xsflMapListJsonStr 的值是「讲课学时,实践学时,」）
    function scheduleUrl(term, mode) {
        return SCHEDULE_PATH + '?viweType=0&showallprint=0&showkchprint=0&showkink=0&showfzmprint=0' +
            '&baseUrl=%2Fjsxsd&xsflMapListJsonStr=' + encodeURIComponent('讲课学时,实践学时,') +
            '&xnxq01id=' + encodeURIComponent(term) + '&zc=&kbjcmsid=' + encodeURIComponent(mode);
    }

    // 第一大节的上课时间：第一行里第一个不是课程格子的格子，文字里的第一个「时:分」
    function firstClockOf(rows) {
        if (!rows.length) return '';
        for (var i = 0; i < rows[0].length; i++) {
            if (rows[0][i].name === 'kbDataTd') continue;
            var m = /(\d{1,2}):(\d{2})/.exec(rows[0][i].text);
            if (m) return pad2(parseInt(m[1], 10)) + ':' + m[2];
        }
        return '';
    }

    // 校区能不能从教务数据判断（与 parse.js 的 campusEvidence 同一口径，两处要一起改）。只在请求的是页面自己选中的作息方案时才用：
    // 作息方案的名称写了「西海岸」或「崂山」「鱼山」（只写一边才算），或第一大节 08:30 开始（只有西海岸的节次时间是这样）。
    // 第一大节 08:00 开始不能当作崂山、鱼山的证据：页面上的节次标签可能对所有校区都一样；它只用来和名称对质。
    // 名称与时间互相矛盾、或两者都没有说明，返回 null（这时问一次）。
    function campusEvidence(modeLabel, clock) {
        var byLabel = null;
        var west = /西海岸/.test(modeLabel);
        var home = /崂山|鱼山/.test(modeLabel);
        if (west && !home) byLabel = 'west';
        if (home && !west) byLabel = 'home';
        var byClock = null;
        if (clock === '08:30') byClock = 'west';
        if (clock === '08:00') byClock = 'home';
        if (byLabel && byClock && byLabel !== byClock) return null;
        if (byLabel) return byLabel;
        return byClock === 'west' ? 'west' : null;
    }

    // 判断不了才问一次（宿主不能提问、用户取消、提问报错，都交 asked:false / index:null，不让整次提取失败）
    function askCampus() {
        var capable = typeof __ncCapabilities !== 'undefined' && __ncCapabilities && __ncCapabilities.ask;
        if (!capable || typeof __ncSelect !== 'function') return Promise.resolve({ asked: false, index: null });
        return Promise.resolve().then(function () {
            return __ncSelect({
                title: '选择校区',
                message: '教务系统没有标明你所在的校区。请选你上课的校区，用来设置每节课的上下课时间' +
                    '（西海岸校区上午前四节的时间与崂山、鱼山校区不同）',
                items: CAMPUS_ITEMS,
                defaultIndex: 0
            });
        }).then(function (index) {
            var ok = typeof index === 'number' && index >= 0 && index < CAMPUS_ITEMS.length;
            return { asked: true, index: ok ? index : null };
        }, function () {
            return { asked: false, index: null };
        });
    }

    // 页面地址只交协议、主机与路径（查询串里可能带学号）
    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    // 学期来源：当前页面有学年学期下拉框就用它，否则取一次课表页
    function findSource() {
        var here = selectOf(document, 'xnxq01id');
        if (here && here.selected) {
            return Promise.resolve({ term: here, mode: selectOf(document, 'kbjcmsid') });
        }
        return getPage(SCHEDULE_PATH + '?viweType=0').then(function (first) {
            if (loginLike(first)) throw new Error('当前页面不是课表，' + LOGIN_HINT);
            var term = selectOf(first, 'xnxq01id');
            if (!term || !term.selected) {
                throw new Error('当前页面找不到学年学期的选项，可能停在外层框架或错误页面。' + LOGIN_HINT);
            }
            return { term: term, mode: selectOf(first, 'kbjcmsid') };
        });
    }

    // 作息方案：用上游写死的值；页面的下拉框里根本没有这个值时，改用页面选中的那一项（并标记，parse.js 会提醒）
    function chooseMode(mode) {
        if (mode && mode.options.length) {
            var found = false;
            for (var i = 0; i < mode.options.length; i++) {
                if (mode.options[i].value === KBJCMSID) found = true;
            }
            if (!found && mode.selected) return { value: mode.selected, fallback: true };
        }
        return { value: KBJCMSID, fallback: false };
    }

    function run() {
        if (window.location.host !== HOST) {
            return Promise.reject(new Error('请在中国海洋大学教务系统的页面里导入。' + LOGIN_HINT));
        }
        if (loginLike(document)) {
            return Promise.reject(new Error('当前页面不是课表，' + LOGIN_HINT));
        }
        return findSource().then(function (source) {
            var code = source.term.selected;
            var label = labelOf(source.term, code);
            var mode = chooseMode(source.mode);
            return getPage(scheduleUrl(code, mode.value)).then(function (page) {
                var tables = weeklyTablesOf(page);
                var table = tables.length ? tableOf(tables[0]) : null;
                var modeSelect = selectOf(page, 'kbjcmsid');
                var termSelect = selectOf(page, 'xnxq01id');
                var modeLabel = labelOf(modeSelect, modeSelect ? modeSelect.selected : '');
                var clock = table ? firstClockOf(table.rows) : '';
                return getCalendar(code).then(function (calendar) {
                    // 请求的是上游写死的作息方案时，名称和节次标签对所有人都一样，不能判校区，直接问
                    var evidence = mode.fallback ? campusEvidence(modeLabel, clock) : null;
                    var needAsk = !!table && evidence === null;
                    return (needAsk ? askCampus() : Promise.resolve({ asked: false, index: null })).then(function (campus) {
                        return JSON.stringify({
                            source: 'qz-jsxsd-weekly',
                            pageUrl: pageUrlOf(),
                            now: todayIso(),
                            loginTitle: LOGIN_TITLE.test(titleOf(page)),
                            loginForm: hasLoginForm(page),
                            term: { code: code, label: label },
                            echoTerm: termSelect ? termSelect.selected : null,
                            mode: {
                                requested: mode.value,
                                fallback: mode.fallback,
                                selected: modeSelect ? modeSelect.selected : null,
                                label: modeLabel,
                                clock: clock
                            },
                            campus: campus,
                            tableCount: tables.length,
                            table: table,
                            calendar: calendar
                        });
                    });
                });
            });
        });
    }

    return run();
})()
