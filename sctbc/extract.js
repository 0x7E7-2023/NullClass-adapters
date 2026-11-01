(function () {
    // 四川工商职业技术学院教务适配器（正方教务 V9，网站根路径，走 http）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SCTBC/sctbc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Violet；adapters.yaml 维护者 dclindev）
    //   上游快照 03d161a。本校脚本最后一次修改 94ce818
    //   （git log 对该文件的最近一次提交；其后的快照提交没有再改这个文件）
    // 移植改动：
    //   ① ES6 改成 ES5（异步写法改成 then 链；注释里也不写箭头函数、反引号、块级声明关键字）
    //   ② 不弹窗、不跳转：上游用桥确认后再选学年、选学期。这里只读当前页或课表首页上教务已经选中的学期，不弹窗
    //   ③ 部署在网站根上，不拼 /jwglxt/。地址由当前页面的源拼出来，不写死协议，也不改成 https
    //   ④ 只取数：排课行、集中实践课名单、节次时间、校历各周交出去（只带白名单字段）；
    //      周次、节次、合并、开学日、总周数全部挪到 parse.js
    //   ⑤ 排课行带 kcmc / xm / cdmc / xqj / xqjmc / jcs / zcd；实践课只带 kcmc；
    //      节次时间只带 jcdm / jcmc / jc / qssj / jssj / sksj；
    //      校历只带 zs / zsmc / rq / zcrq / ksrq。课表响应里的学号、姓名等一律不带走
    //   ⑥ 节次时间请求菜单号 N2151，请求体带 kzlx=ck 以及三个空的筛选项（与上游一致）。
    //      列表里只有节次号、没有任何上课时间时，当成没取到（交 null）
    //   ⑦ 课表是 POST kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151，请求体是 xnm、xqm、kzlx=ck
    //   ⑧ 校历是 POST kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154，请求体只有 xnm、xqm。取不到交 null
    //   ⑨ 登录页、路径里带 /sso/ 的页面、统一认证主机：只给提示，不发请求。统一认证主机只用来认出登录页，不加入允许名单
    //
    // 取数方式：同源请求：
    //   ① GET  /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151  读当前学年学期（页面上已经有下拉框时跳过）
    //   ② POST /kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151         取课表
    //   ③ POST /kbcx/xskbcx_cxRjc.html?gnmkdm=N2151         取节次时间（取不到或没有上课时间就 null）
    //   ④ POST /kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154 取校历各周（取不到就 null）
    // 登录全程由用户在页面里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM_KB = 'N2151';
    var GNMKDM_XL = 'N2154';
    var JW_HOST = 'jw.sctbc.edu.cn';
    var CAS_HOST = 'cas.sctbc.edu.cn';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 本校教务挂在网站根上，不跟 /jwglxt 这段路径走
    function jwBase() {
        return originOf();
    }

    function hostName() {
        return String(window.location.hostname || '').toLowerCase();
    }

    function onJwHost() {
        return hostName() === JW_HOST;
    }

    function onCasPage() {
        return hostName() === CAS_HOST;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '');
        return path.indexOf('login_slogin.html') >= 0 || path.indexOf('/sso/') >= 0;
    }

    function looksLikeLogin(url, text) {
        var href = String(url || '');
        var body = String(text || '');
        if (href.indexOf('login_slogin') >= 0) return true;
        if (href.indexOf(CAS_HOST) >= 0) return true;
        if (body.indexOf('统一身份认证') >= 0) return true;
        if (body.indexOf('用户登录') >= 0 && body.indexOf('密码') >= 0) return true;
        return false;
    }

    function request(url, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*'
            }
        };
        if (typeof body === 'string') options.body = body;
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text().then(function (text) {
                if (looksLikeLogin(response.url, text)) {
                    throw new Error('登录已过期，请重新登录教务系统，再点「提取课表」');
                }
                return text;
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    function get(url) {
        return request(url, 'GET', null);
    }

    function post(url, body) {
        return request(url, 'POST', body);
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
    }

    function jsonOf(text) {
        try {
            return JSON.parse(String(text));
        } catch (e) {
            return null;
        }
    }

    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options && selectEl.querySelectorAll) options = selectEl.querySelectorAll('option');
        if (!options || !options.length) {
            var raw = String(selectEl.value === null || selectEl.value === undefined ? '' : selectEl.value)
                .replace(/\s+/g, '');
            return raw ? { value: raw, text: '' } : null;
        }
        var list = [];
        var picked = -1;
        var i;
        for (i = 0; i < options.length; i++) {
            var option = options[i];
            var value = String(option.value === null || option.value === undefined ? '' : option.value)
                .replace(/\s+/g, '');
            if (!value) continue;
            var label = String(option.textContent === null || option.textContent === undefined ? '' : option.textContent)
                .replace(/\s+/g, ' ').trim();
            if (option.selected && picked < 0) picked = list.length;
            list.push({ value: value, text: label });
        }
        if (!list.length) return null;
        if (picked < 0) picked = 0;
        return { value: list[picked].value, text: list[picked].text };
    }

    function readTermFromDoc(doc) {
        if (!doc || !doc.querySelector) return null;
        var year = readSelect(doc.querySelector('#xnm'));
        var season = readSelect(doc.querySelector('#xqm'));
        if (!year || !season) return null;
        return { xnm: year.value, xqm: season.value, xnmText: year.text, xqmText: season.text };
    }

    function currentTerm() {
        var onPage = readTermFromDoc(window.document);
        if (onPage) return Promise.resolve(onPage);
        if (typeof DOMParser === 'undefined') {
            throw new Error(
                '这个页面里读不到学年学期：请先在教务系统里打开「信息查询 - 学生课表查询」，再点「提取课表」'
            );
        }
        return get(jwBase() + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM_KB)
            .then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开「信息查询 - 学生课表查询」后再点「提取课表」'
                    );
                }
                return found;
            });
    }

    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm) + '&kzlx=ck';
        return post(jwBase() + '/kbcx/xskbcx_cxXsKb.html?gnmkdm=' + GNMKDM_KB, body)
            .then(function (text) {
                var json = jsonOf(text);
                if (!json || typeof json !== 'object' || !(json.kbList instanceof Array)) {
                    throw new Error(
                        '教务系统没有返回课表数据（返回的内容格式不对）：' +
                        '登录状态可能已失效，请重新登录后再点「提取课表」'
                    );
                }
                return json;
            });
    }

    function optionalJson(url, body) {
        return post(url, body).then(function (text) {
            return jsonOf(text);
        }, function () {
            return null;
        });
    }

    function listOf(value) {
        if (value instanceof Array) return value;
        if (value && typeof value === 'object' && value.data instanceof Array) return value.data;
        return null;
    }

    function periodRowHasTime(row) {
        if (!row || typeof row !== 'object') return false;
        if (row.qssj && row.jssj) return true;
        if (row.kssj && row.jssj) return true;
        var sk = row.sksj;
        return typeof sk === 'string' && /\d{1,2}:\d{2}/.test(sk) && sk.indexOf('-') >= 0;
    }

    // 只有节次号、没有上课时间的列表不算可用，否则会把没有上课时间的列表误当成可用的节次时间交出去
    function periodListUsable(value) {
        var list = listOf(value);
        if (!list || !list.length) return false;
        for (var i = 0; i < list.length; i++) {
            if (periodRowHasTime(list[i])) return true;
        }
        return false;
    }

    function fetchPeriodTimes(periodBody) {
        return optionalJson(jwBase() + '/kbcx/xskbcx_cxRjc.html?gnmkdm=' + GNMKDM_KB, periodBody)
            .then(function (first) {
                if (periodListUsable(first)) return first;
                return null;
            });
    }

    function fetchCalendar(termBody) {
        return optionalJson(jwBase() + '/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=' + GNMKDM_XL, termBody)
            .then(function (value) {
                return slimList(value, CAL_FIELDS);
            });
    }

    function totalOf(json) {
        var keys = ['total', 'totalResult', 'totalCount', 'count'];
        for (var i = 0; i < keys.length; i++) {
            var value = json[keys[i]];
            if (typeof value === 'number' && isFinite(value) && value >= 0) return value;
            if (typeof value === 'string' && /^[0-9]+$/.test(value)) return parseInt(value, 10);
        }
        return null;
    }

    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'xqjmc', 'jcs', 'zcd'];
    var PRACTICE_FIELDS = ['kcmc'];
    var PERIOD_FIELDS = ['jcdm', 'jcmc', 'jc', 'qssj', 'jssj', 'sksj'];
    var CAL_FIELDS = ['zs', 'zsmc', 'rq', 'zcrq', 'ksrq', 'zrq'];

    function pickFields(list, fields) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var kept = {};
            for (var j = 0; j < fields.length; j++) {
                if (row[fields[j]] !== undefined) kept[fields[j]] = row[fields[j]];
            }
            out.push(kept);
        }
        return out;
    }

    function slimList(value, fields) {
        var list = listOf(value);
        if (!list) return null;
        return pickFields(list, fields);
    }

    if (onCasPage() || onLoginPage()) {
        throw new Error(
            '当前打开的是登录页。请先登录四川工商职业技术学院教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }

    if (!onJwHost()) {
        throw new Error(
            '当前打开的不是四川工商职业技术学院教务系统。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            var periodBody = termBody + '&kzlx=ck&xsdm=&kclbdm=&kclxdm=';
            return Promise.all([
                fetchPeriodTimes(periodBody),
                fetchCalendar(termBody)
            ]).then(function (extras) {
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText
                    },
                    today: localTodayIso(),
                    raw: { kbList: rows, sjkList: practice },
                    total: totalOf(json),
                    periodTimes: slimList(extras[0], PERIOD_FIELDS),
                    calendar: extras[1]
                });
            });
        });
    });
})()
