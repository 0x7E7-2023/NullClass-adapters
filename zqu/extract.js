(function () {
    // 肇庆学院教务适配器（URP 系 xsgrkbcx 族，jwgl.zqu.edu.cn，校外经 WebVPN 或校内直连）—— 第一步：只取数，把教务的原始排课记录交出去。
    //
    // 移植自 shiguang_warehouse 的 ZQU/zqu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 NoobLLiu，见上游文件头「维护者」）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03 对齐 origin/main）
    //   本校脚本最后一次修改 09432b1（XingYES 提交）
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① ES6 → ES5：异步写法改成 then 链，去掉模板串、箭头函数、解构、块级声明关键字、展开运算、Set / Map
    //   ② 地址不写死：上游 siteBase 只截 xsgrkbcx! 之前的一段，停在门户页时会退回到域名根，这里改成：经 WebVPN 打开时取 /https/<加密串>/ 这一段
    //      作为站点根（同源，不跨主机）；校内直连时取 jwgl.zqu.edu.cn 的根；其余页面（WebVPN 门户、统一认证页、别的站）一律大白话提示，不发请求
    //   ③ 不弹窗选学期：上游一律弹「选择学期」。这里先读当前页面上的 #xnxqdm（用户正开着「我的课表」页时，读的就是他此刻选中的学期）；
    //      页面上没有就取一次学期列表页，读标了 selected 的那一项；一项都没标时取列表第一项，并在提醒里说明（source: first），不再问用户
    //   ④ 上游的 kb 数据请求是 GET xsgrkbcx!getKbRq.action?xnxqdm=…&zc=&xsdm=（zc 为空即整学期），这里照搬；
    //      上游注释说「不限周次时不返回日期数组」，但代码要求数组长度 ≥ 2 并取 data[0]，这里照代码办（data[0] 不是数组时当作没有记录）
    //   ⑤ 开学日：上游是用 zc=1 再请求一次、弹窗让用户确认。这里只把 zc=1 的响应里 xqmc / rq 两个键留下交给 parse.js，不弹窗；
    //      探不到（失败、非 JSON、超长）只交空，由 parse.js 推算并在提醒里说明，用户可在学期管理里改
    //   ⑥ 只留 kcmc / teaxms / jxcdmc / xq / zc / jcdm2 / jcdm 七个字段，其余（学号、姓名、院系、班级等）一律不带出；每字段限 300 字，对象 / 数组类直接丢
    //   ⑦ 上游的浏览器测试分支（prompt / alert / console）与 showToast / showSingleSelection / showAlert / saveCourseConfig /
    //      savePresetTimeSlots / saveImportedCourses / notifyTaskCompletion 全部不移植；上游的 mergeAndDistinctCourses、collectCourses 挪到 parse.js
    //   ⑧ 登录页判断：页面上有密码输入框就直接提示先登录，不发请求（只看有没有，不读它的值）
    //
    // 取数方式：同源请求，最多三个，全部拼在站点根之下（与 loginUrl 同源或 WebVPN 同源，allowHosts 只为 WebVPN 主机声明）：
    //   ① GET <根>xsgrkbcx!getXsgrbkList.action                        学期列表页（页面上已有 #xnxqdm 时跳过）
    //   ② GET <根>xsgrkbcx!getKbRq.action?xnxqdm=<学期代码>&zc=&xsdm=  整学期排课记录（JSON，data[0] 为记录数组）
    //   ③ GET <根>xsgrkbcx!getKbRq.action?xnxqdm=<学期代码>&zc=1&xsdm= 第 1 周日期（JSON，data[1] 为七天的 xqmc / rq；探测，失败即放弃）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ term: { code, name, source }, today, dateInfo, rows: [ { kcmc, teaxms, jxcdmc, xq, zc, jcdm2, jcdm } ] }
    //   term.source —— page（读的是页面上用户选中的学期）/ default（学期列表里标了 selected 的那一项，或只有一项）/
    //                  first（没有任何标记，取了列表第一项）

    var LIST_PAGE = 'xsgrkbcx!getXsgrbkList.action';
    var DATA_API = 'xsgrkbcx!getKbRq.action';
    var DIRECT_HOST = 'jwgl.zqu.edu.cn';   // 校内直连的主机（与 loginUrl 同）
    var MAX_PAGE_BODY = 3000000;   // 列表页 / 课表数据超过 3M 字符就不认
    var MAX_DATE_BODY = 200000;    // 日期响应超过这个长度就不认
    var MAX_FIELD_TEXT = 300;      // 每个字段最多带出的字数
    var FIELDS = ['kcmc', 'teaxms', 'jxcdmc', 'xq', 'zc', 'jcdm2', 'jcdm'];
    var NOT_IN_JW = '请先登录教务系统，打开「我的课表」后再点「提取课表」';
    var ON_LOGIN = '当前打开的是登录页。请先登录教务系统，打开「我的课表」后再点「提取课表」';
    var NOT_IN_PAGE = '请先进入教务系统（校外请经 WebVPN 打开教务系统，校内直接打开即可），打开「我的课表」后再点「提取课表」';
    var NO_DATA = '教务系统没有返回课表数据：登录状态可能已失效，请重新登录后再点「提取课表」';

    function asText(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function trimText(value) {
        return asText(value).replace(/^\s+|\s+$/g, '');
    }

    function pad2(value) {
        return (value < 10 ? '0' : '') + value;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function fail(message) {
        return Promise.reject(new Error(message));
    }

    function ignoreFailure(promise) {
        return promise.then(function (value) { return value; }, function () { return null; });
    }

    function jsonOrNull(body, maxLength) {
        if (typeof body !== 'string' || body.length === 0 || body.length > maxLength) return null;
        try {
            return JSON.parse(body);
        } catch (e) {
            return null;
        }
    }

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 站点根：经 WebVPN 打开时是 /https/<加密串>/（同源）；校内直连是 jwgl.zqu.edu.cn 的根；其余页面抛大白话提示，不发请求
    // 统一认证页的路径段（authserver / login / cas）：两种渠道共用这一个判断，命中就当登录页，不发请求
    function isAuthPath(path) {
        return /(^|\/)(authserver|login|cas)(\/|\.|$)/i.test(path);
    }

    function siteRoot() {
        var loc = window.location;
        var path = String(loc.pathname || '');
        var vpn = /^\/https?\/[^\/]+\//.exec(path);
        if (vpn) {
            if (isAuthPath(path.substring(vpn[0].length))) throw new Error(ON_LOGIN);
            return originOf() + vpn[0];
        }
        if (String(loc.hostname || '') === DIRECT_HOST) {
            if (isAuthPath(path)) throw new Error(ON_LOGIN);
            return originOf() + '/';
        }
        throw new Error(NOT_IN_PAGE);
    }

    // 读一个 <select id="xnxqdm">：live 为 true 表示是当前页面上的（用 selectedIndex，反映用户此刻的选择），
    // 否则是解析出来的列表页（只认写了 selected 属性的项 —— 离线文档里「第一项默认选中」不是教务的标记）
    function termsOf(select, live) {
        var items = [];
        var marked = -1;
        if (!select || typeof select.querySelectorAll !== 'function') return null;
        var options = select.querySelectorAll('option');
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var code = trimText(option.value !== undefined ? option.value : option.getAttribute('value'));
            if (!code) continue;
            var name = trimText(option.textContent);
            var isMarked = live ? (select.selectedIndex === i) : option.hasAttribute('selected');
            if (isMarked && marked < 0) marked = items.length;
            items.push({ code: code, name: name });
        }
        return items.length ? { items: items, marked: marked } : null;
    }

    function getText(url) {
        return fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'text/html, application/json, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：请先登录，打开「我的课表」后再点「提取课表」');
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效，请重新登录后再点「提取课表」');
        });
    }

    function fetchTermList(root) {
        return getText(root + LIST_PAGE).then(function (html) {
            if (typeof html !== 'string' || html.length > MAX_PAGE_BODY) throw new Error(NOT_IN_JW);
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var found = termsOf(doc.getElementById('xnxqdm'), false);
            if (!found) throw new Error(NOT_IN_JW);
            return found;
        });
    }

    // 取到可选学期：{ items, marked, live }。页面上有下拉框就直接用，不发请求
    function loadTerms(root) {
        var live = termsOf(document.getElementById('xnxqdm'), true);
        if (live) {
            live.live = true;
            return Promise.resolve(live);
        }
        return fetchTermList(root).then(function (found) {
            found.live = false;
            return found;
        });
    }

    // 标了 selected 的直接用；只有一项也直接用；都没标就取第一项（并在提醒里说明），不再问用户
    function chooseTerm(found) {
        var items = found.items;
        if (found.marked >= 0) {
            return { term: items[found.marked], source: found.live ? 'page' : 'default' };
        }
        if (items.length === 1) return { term: items[0], source: 'default' };
        return { term: items[0], source: 'first' };
    }

    function pickRow(item) {
        var out = {};
        for (var i = 0; i < FIELDS.length; i++) {
            var value = item ? item[FIELDS[i]] : null;
            if (value === null || value === undefined || typeof value === 'object') continue;
            var line = asText(value);
            out[FIELDS[i]] = line.length > MAX_FIELD_TEXT ? line.substring(0, MAX_FIELD_TEXT) : line;
        }
        return out;
    }

    // 整学期排课记录：zc 为空即不限周次。上游代码要求响应是数组且长度 ≥ 2，records 取 data[0]
    function fetchRows(root, code) {
        return getText(root + DATA_API + '?xnxqdm=' + encodeURIComponent(code) + '&zc=&xsdm=').then(function (body) {
            var data = jsonOrNull(body, MAX_PAGE_BODY);
            if (!data || typeof data.length !== 'number' || data.length < 2) throw new Error(NO_DATA);
            var list = Array.isArray(data[0]) ? data[0] : [];
            var rows = [];
            for (var i = 0; i < list.length; i++) rows.push(pickRow(list[i]));
            return rows;
        });
    }

    // 日期响应里只留 parse.js 要认的两个键（xqmc 星期、rq 日期），其余整棵丢掉；对象 / 数组的层级照旧，
    // parse.js 靠它区分「第 1 周」那一层
    function pickDates(node, depth) {
        if (!node || typeof node !== 'object' || depth > 4) return null;
        if (node.xqmc !== undefined && node.rq !== undefined) {
            return { xqmc: asText(node.xqmc), rq: asText(node.rq) };
        }
        var out = {};
        var any = false;
        for (var key in node) {
            if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
            var picked = pickDates(node[key], depth + 1);
            if (picked) { out[key] = picked; any = true; }
        }
        return any ? out : null;
    }

    function fetchDates(root, code) {
        var request = getText(root + DATA_API + '?xnxqdm=' + encodeURIComponent(code) + '&zc=1&xsdm=').then(function (body) {
            return pickDates(jsonOrNull(body, MAX_DATE_BODY), 0);
        });
        return ignoreFailure(request);
    }

    var loginFields = document.querySelectorAll ? document.querySelectorAll('input[type="password"]') : [];
    if (loginFields && loginFields.length > 0) return fail(ON_LOGIN);

    var root;
    try {
        root = siteRoot();
    } catch (e) {
        return fail(e.message);
    }

    return loadTerms(root).then(chooseTerm).then(function (chosen) {
        var code = chosen.term.code;
        return Promise.all([fetchRows(root, code), fetchDates(root, code)]).then(function (result) {
            return JSON.stringify({
                term: { code: code, name: chosen.term.name, source: chosen.source },
                today: isoOf(new Date()),
                dateInfo: result[1],
                rows: result[0]
            });
        });
    });
})()
