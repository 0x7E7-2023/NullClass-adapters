(function () {
    // 广西机电职业技术学院教务适配器（正方教务 V9 Mobile API）—— 第一步：只取数。
    // 移植自 shiguang_warehouse 的 GXCME/gxcme.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT，作者 Haooz）
    //   上游快照 29498b0；本校脚本最后一次修改 80e30cf。
    // 移植改动：
    //   ① 改为 ES5 与 Promise 链；删除拾光弹窗、保存和提示桥。
    //   ② 学年学期不再弹窗询问，优先读当前页 #xnm/#xqm，缺省时读上游课表首页。
    //   ③ 课表路径、N2154 菜单与 xnm/xqm/kzlx=ck 请求体严格照本校 Mobile API。
    //   ④ 请求全部使用当前同源地址，支持 /jwglxt 前的网关路径；登录页与门户页不发请求。
    //   ⑤ 排课行只交 kcmc/xm/cdmc/xqj/jcs/zcd，实践课只交 kcmc；学生信息不带出。
    //   ⑥ 周次、节次、合并与学期计算全部放到 parse.js；校历失败交空值供推算。
    //   ⑦ 上游固定 14 节时间由 parse.js 使用，不额外请求模板学校的节次时间地址。
    var JWLGXT = '/jwglxt';
    var GNMKDM = 'N2154';
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];
    var PRACTICE_FIELDS = ['kcmc'];

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(JWLGXT + '/');
        if (at > 0) return originOf() + path.substring(0, at + JWLGXT.length);
        return originOf() + JWLGXT;
    }

    function onLoginOrPortalPage() {
        var host = String(window.location.hostname || '').toLowerCase();
        var path = String(window.location.pathname || '');
        if (host === 'sso.gxcme.edu.cn') return true;
        if (path.indexOf('login') >= 0 || path.indexOf('/sso/') >= 0) return true;
        if (host === 'nportal.gxcme.edu.cn' && (path === '' || path === '/' || path.indexOf('/portal') === 0)) return true;
        return false;
    }

    function looksLikeLogin(url, body) {
        var href = String(url || '');
        var text = String(body || '');
        if (href.indexOf('login') >= 0) return true;
        if (text.indexOf('统一身份认证') >= 0) return true;
        return text.indexOf('用户登录') >= 0 && text.indexOf('密码') >= 0;
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
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再点「提取课表」');
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

    function jsonOf(value) {
        try {
            return JSON.parse(String(value));
        } catch (e) {
            return null;
        }
    }

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
    }

    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options && selectEl.querySelectorAll) options = selectEl.querySelectorAll('option');
        if (!options || !options.length) {
            var raw = String(selectEl.value === null || selectEl.value === undefined ? '' : selectEl.value).replace(/\s+/g, '');
            return raw ? { value: raw, text: '' } : null;
        }
        var list = [];
        var picked = -1;
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var value = String(option.value === null || option.value === undefined ? '' : option.value).replace(/\s+/g, '');
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
            throw new Error('这个页面里读不到学年学期：请先在教务系统里打开「信息查询 - 学生课表查询」，再点「提取课表」');
        }
        return get(jwBase() + '/kbcx/xskbcxZccx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default')
            .then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error('没读到学年学期：登录状态可能已失效，或教务系统改了课表页。请重新登录并打开「信息查询 - 学生课表查询」后再点「提取课表」');
                }
                return found;
            });
    }

    function termBody(term) {
        return 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
    }

    function fetchTimetable(term) {
        return post(jwBase() + '/kbcx/xskbcxMobile_cxXsKb.html?gnmkdm=' + GNMKDM,
            termBody(term) + '&kzlx=ck').then(function (value) {
            var json = jsonOf(value);
            if (!json || typeof json !== 'object' || !(json.kbList instanceof Array)) {
                throw new Error('教务系统没有返回课表数据（返回的内容格式不对）：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            return json;
        });
    }

    function pickCalendar(value) {
        if (value instanceof Array) return pickFields(value, ['zs', 'zsmc', 'zrq', 'zcrq', 'rq', 'ksrq']);
        if (!value || typeof value !== 'object') return null;
        var out = {};
        var keys = ['rows', 'datas', 'data', 'list', 'items'];
        for (var i = 0; i < keys.length; i++) {
            if (value[keys[i]] && typeof value[keys[i]] === 'object') out[keys[i]] = pickCalendar(value[keys[i]]);
        }
        return out;
    }

    function optionalCalendar(term) {
        return post(jwBase() + '/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154', termBody(term))
            .then(function (value) { return pickCalendar(jsonOf(value)); }, function () { return null; });
    }

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

    function totalOf(json) {
        var keys = ['total', 'totalResult', 'totalCount', 'count'];
        for (var i = 0; i < keys.length; i++) {
            var value = json[keys[i]];
            if (typeof value === 'number' && isFinite(value) && value >= 0) return value;
            if (typeof value === 'string' && /^[0-9]+$/.test(value)) return parseInt(value, 10);
        }
        return null;
    }

    if (onLoginOrPortalPage()) {
        throw new Error('当前打开的是登录页或门户页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」');
    }

    return currentTerm().then(function (term) {
        return Promise.all([fetchTimetable(term), optionalCalendar(term)]).then(function (results) {
            var json = results[0];
            return JSON.stringify({
                term: {
                    xnm: term.xnm,
                    xqm: term.xqm,
                    xnmText: term.xnmText,
                    xqmText: term.xqmText
                },
                today: localTodayIso(),
                raw: {
                    kbList: pickFields(json.kbList, KB_FIELDS),
                    sjkList: pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS)
                },
                total: totalOf(json),
                calendar: results[1]
            });
        });
    });
})()
