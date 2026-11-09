(function () {
    // 华南师范大学教务适配器（正方教务 V9，jwglxt，走 https）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SCNU/scnu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 YewFence）
    //   上游快照 baf83fa（任务卡；仓库 HEAD）。本校脚本最后一次修改见报告（任务卡写 2e1e720，
    //   本地快照 git log 给出的是 344f0e5，以快照为准）
    // 移植改动：
    //   ① ES6 改成 ES5（异步写法改成 then 链；注释里也不写箭头函数、反引号、块级声明关键字）
    //   ② 不弹窗选学年学期：上游弹两次窗（学年、学期）。这里直接读页面上的 #xnm / #xqm
    //      （用户自己切过的学期优先），页面上没有才取一次课表首页（菜单号 N253508）
    //   ③ 只取数：排课行、未排课程名单、校区作息、学期周次校历交出去（只带白名单字段）；
    //      周次、节次、合并全部挪到 parse.js
    //   ④ 排课行带 kcmc / xm / cdmc / xqmc / xqh_id / xqj / xqjmc / jcs / zcd / xslxbj；
    //      未排课程只带 kcmc；作息只带 jcdm / jcmc / jc / qssj / jssj / sksj；
    //      校历只带 zs / zsmc / rq / zrq / zcrq / ksrq。课表响应里的学生信息一律不带走
    //   ⑤ 校区：上游按每个校区各取一份作息，再弹窗让用户挑默认校区。这里按课程行里各校区的
    //      行数自动挑行数最多的那个（并列取先出现的），只取它的作息，不弹窗。
    //      一条行都没有校区编号时不猜，作息交 null，由 parse.js 提醒
    //   ⑥ 请求体照上游：课表多带 kzlx / xsdm / kclbdm / kclxdm；作息多带 xqh_id；校历只带学年学期
    //   ⑦ 三个接口的地址与参数照上游代码，不在 POST 地址上附加菜单号（上游如此）
    //   ⑧ 登录页、单点跳转页，以及不是教务主机的页面：只给提示，不发请求
    //
    // 取数方式：同源请求，地址都由当前页面的源拼出来，不写死协议和主机名：
    //   ① GET  /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508&layout=default  读当前学年学期
    //      （页面上已经有下拉框时跳过）
    //   ② POST /kbcx/xskbcx_cxXsgrkb.html          取课表
    //   ③ POST /kbcx/xskbcx_cxRjc.html             取选中校区的作息（取不到或没有上课时间就 null）
    //   ④ POST /kbcx/xskbcxZccx_cxZcByXnxq.html    取学期周次校历（取不到就 null）
    // 登录全程由用户在页面里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N253508';
    var JW_HOST = 'jwxt.scnu.edu.cn';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 本校教务部署在站点根路径（登录入口 /xtgl/...、上游脚本的 /kbcx/... 都是根路径），
    // 不能再拼 /jwglxt，否则真机上四个请求都会 404
    function jwBase() {
        return originOf();
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === JW_HOST;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '');
        return path.indexOf('login_slogin.html') >= 0 || path.indexOf('/sso/') >= 0;
    }

    function looksLikeLogin(url, text) {
        var href = String(url || '');
        var body = String(text || '');
        if (href.indexOf('login_slogin') >= 0) return true;
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
        return get(jwBase() + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default')
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

    // 课表接口：参数照上游 scnu.js 原样（kzlx=ck 与三个空的筛选条件）
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=&kclxdm=';
        return post(jwBase() + '/kbcx/xskbcx_cxXsgrkb.html', body)
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

    // 上游按校区 id 取作息。这里只取课程行数最多的那个校区（不弹窗问）
    function campusListOf(rows) {
        var order = [];
        var byId = {};
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i] || {};
            var id = textOf(row.xqh_id).replace(/\s+/g, '');
            if (!id) continue;
            if (!byId[id]) {
                byId[id] = { id: id, name: '', rows: 0 };
                order.push(byId[id]);
            }
            byId[id].rows++;
            if (!byId[id].name) byId[id].name = textOf(row.xqmc);
        }
        return order;
    }

    function dominantCampus(list) {
        var best = null;
        for (var i = 0; i < list.length; i++) {
            if (!best || list[i].rows > best.rows) best = list[i];
        }
        return best;
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

    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqmc', 'xqh_id', 'xqj', 'xqjmc', 'jcs', 'zcd', 'xslxbj'];
    var PRACTICE_FIELDS = ['kcmc'];
    var PERIOD_FIELDS = ['jcdm', 'jcmc', 'jc', 'qssj', 'jssj', 'sksj'];
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'rq', 'zrq', 'zcrq', 'ksrq'];

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

    if (!onJwHost()) {
        throw new Error(
            '当前打开的不是华南师范大学教务系统。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            var campuses = campusListOf(rows);
            var campus = dominantCampus(campuses);
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            var periodPromise = campus
                ? optionalJson(jwBase() + '/kbcx/xskbcx_cxRjc.html',
                    termBody + '&xqh_id=' + encodeURIComponent(campus.id))
                : Promise.resolve(null);
            return Promise.all([
                periodPromise,
                optionalJson(jwBase() + '/kbcx/xskbcxZccx_cxZcByXnxq.html', termBody)
            ]).then(function (extras) {
                var periodRows = periodListUsable(extras[0]) ? slimList(extras[0], PERIOD_FIELDS) : null;
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText
                    },
                    today: localTodayIso(),
                    campusId: campus ? campus.id : '',
                    campusName: campus ? campus.name : '',
                    campuses: campuses,
                    raw: { kbList: rows, sjkList: practice },
                    total: totalOf(json),
                    periodTimes: periodRows,
                    calendar: slimList(extras[1], CALENDAR_FIELDS)
                });
            });
        });
    });
})()
