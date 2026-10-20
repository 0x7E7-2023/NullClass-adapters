(function () {
    // 南京信息职业技术学院教务适配器（正方教务 jwglxt，教务主机 jw.njcit.cn，统一认证入口）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 NJCIT/njcit.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 astraumbra）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取，2026-10-20 复核）
    //   本校脚本最后一次修改 73e176e
    // 移植改动（逐条对应 AUDIT.md「与模板的差异」与「上游里删掉 / 改掉的东西」）：
    //   ① 不弹窗让用户选学年与学期：上游弹两个选择框（选项取自课表页的 #xnm / #xqm 下拉框）。这里直接读页面上的下拉框：
    //      被 selected 标的那项优先，没有就取第一项；页面上读不到才去取一次课表首页读同样两个下拉框。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」（移植手册 §3 第 1 步）
    //   ② 主机不写死：上游用 /jwglxt/... 绝对路径（落在当前页面的主机上）；这里改由 window.location.origin 拼出同源地址，
    //      /jwglxt 之前若还有前缀则原样保留
    //   ③ 登录页与统一认证页不发请求：路径在 /sso/ 下（统一认证入口 /sso/lyiotlogin 等）或是 login_slogin.html，直接提示先登录；
    //      其余页面照上游「教务任意页面都可以提取」的口径直接取数。课表响应同时含「登录」和「密码」视为登录页（报登录状态失效）
    //   ④ 只取数、只交白名单字段：排课行 kbList 只留 kcmc / xm / cdmc / xqj / jcs / zcd / xqh_id 七个字段，
    //      集中实践课 sjkList 只留 kcmc；响应里夹带的学生信息（xsxx、学号、姓名、学院等）一律不带出，也不进 fixture
    //   ⑤ 节次时间：上游请求 cxRjc（体 xnm / xqm / xqh_id，校区写死 01），只读 jcmc / qssj / jssj。这里照样请求，
    //      校区号改取课表行里的 xqh_id（没有才用上游的 01）；取不到交 null，parse.js 整张改用空课默认的 12 节表并写进 warnings
    //   ⑥ 学期周次校历（cxZcByXnxq，菜单号 N2154）上游本来就取，只读 zs / zsmc / rq；取不到交 null，parse.js 推算开学日并说明
    //   ⑦ 交出 qsxqj（课表响应顶层的每周起始日，1=周一…7=周日），parse.js 按移植手册 §4.3 回退开学日（上游不用它，缺省按周一）
    //   ⑧ 每个请求统一带 Content-Type、X-Requested-With 与 Accept（上游只有部分请求带）；请求体参数值经 encodeURIComponent，数字不变
    //   ⑨ 上游文件头说明：本校教务页面加载的 zftal-ui 脚本会改坏 Array.prototype.filter / some / every 和 String.prototype.trim。
    //      本文件一律不用这四个方法（去首尾空白用正则，遍历用下标循环），和上游同样的处理
    //
    // 取数方式：同源请求，最多四个（全部打在当前教务主机上，地址都由 window.location.origin 拼出来）：
    //   ① GET  /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （页面上已有下拉框时跳过）
    //   ② POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON，必需）
    //   ③ POST /jwglxt/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151                         取节次时间（取不到就 null）
    //   ④ POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    var MENU_SCHEDULE = 'N2151';   // 课表页、课表、节次时间（上游写死）
    var MENU_CALENDAR = 'N2154';   // 学期周次校历（上游写死）
    var DEFAULT_CAMPUS = '01';     // 课表行里读不到校区号时用上游的 01
    var LOGIN_HINT = '请先登录教务系统，再点「提取课表」';

    // 课表行只留 parse.js 用得到的字段（xqh_id 是校区号，只用来拼节次时间请求，不含个人信息）
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd', 'xqh_id'];
    var PRACTICE_FIELDS = ['kcmc'];
    var PERIOD_FIELDS = ['jcmc', 'qssj', 'jssj'];
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'rq'];

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 教务上下文：/jwglxt 之前若还有一段前缀，原样保留；当前路径不在 /jwglxt 下时（上游的做法）直接用 origin + /jwglxt
    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(JWLGXT + '/');
        if (at > 0) return originOf() + path.substring(0, at + JWLGXT.length);
        return originOf() + JWLGXT;
    }

    function pageUrl(page, menu, extra) {
        return jwBase() + '/kbcx/' + page + '?gnmkdm=' + menu + (extra || '');
    }

    // 统一认证页（/sso/…）或正方登录页：还没进到教务，不发请求，直接提示
    function notLoggedInPage() {
        var path = String(window.location.pathname || '');
        return path.indexOf('login_slogin.html') >= 0 || /^\/sso(\/|$)/.test(path);
    }

    function isLoginPage(text) {
        return text.indexOf('登录') >= 0 && text.indexOf('密码') >= 0;
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
        if (body !== undefined) options.body = body;
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）：' +
                    '登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    function get(url) {
        return request(url, 'GET');
    }

    function post(url, body) {
        return request(url, 'POST', body);
    }

    // 去首尾空白：本校页面会把 String.prototype.trim 改成「删掉所有空白」，所以这里不用 trim，用正则
    function stripEnds(value) {
        return String(value).replace(/^\s+|\s+$/g, '');
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return stripEnds(String(value).replace(/\s+/g, ' '));
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

    // 读一个学年学期字段：正常是下拉框（跳过 value 为空的占位项，被 selected 标记的那项优先，没标记就取第一项）；
    // 万一页面把它放在隐藏 input 里，就直接读 value
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
            if (option.selected && picked < 0) picked = list.length;
            list.push({ value: value, text: textOf(option.textContent) });
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
            return Promise.reject(new Error(
                '这个页面里读不到学年学期：请先在教务系统里打开「信息查询 - 学生课表查询」，再点「提取课表」'
            ));
        }
        return get(pageUrl('xskbcx_cxXskbcxIndex.html', MENU_SCHEDULE, '&layout=default')).then(function (html) {
            var found = readTermFromDoc(new DOMParser().parseFromString(String(html), 'text/html'));
            if (!found) {
                throw new Error(
                    '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                    '请重新登录并打开「信息查询 - 学生课表查询」后再点「提取课表」'
                );
            }
            return found;
        });
    }

    // 课表（正方：POST 表单，xnm 学年 + xqm 学期代号，请求体照上游：xnm / xqm / kzlx=ck，不带 xsdm、kclbdm）。
    // 一次性返回整学期排课，没有分页；响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck';
        return post(pageUrl('xskbcx_cxXsgrkb.html', MENU_SCHEDULE), body).then(function (text) {
            if (isLoginPage(text)) {
                throw new Error('登录状态已失效：教务系统返回了登录页，请重新登录后再点「提取课表」');
            }
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

    // 附加请求（节次时间 / 学期周次校历）：不是每个部署都有，失败一律交 null，
    // 让 parse.js 回落到空课默认节次时间并在 warnings 里说明 —— 绝不因为附加请求挂掉就导不进课表
    function optionalJson(url, body) {
        return post(url, body).then(function (text) {
            return jsonOf(text);
        }, function () {
            return null;
        });
    }

    // 响应外壳只在这里判断一次（上游：必须是数组）；「有没有数据」与「挑字段」用同一份行数组
    function pickRows(json, fields) {
        if (!(json instanceof Array) || !json.length) return null;
        return pickFields(json, fields);
    }

    // 只按白名单留字段；响应里其它字段（学生信息 xsxx 之类）一律不带出
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

    // 校区号：课表行里第一个非空的 xqh_id（只留字母数字，免得拼进请求体出岔子），没有就用上游的 01
    function campusOf(rows) {
        for (var i = 0; i < rows.length; i++) {
            var id = textOf((rows[i] || {}).xqh_id).replace(/[^A-Za-z0-9_-]/g, '');
            if (id) return id;
        }
        return DEFAULT_CAMPUS;
    }

    if (notLoggedInPage()) {
        throw new Error(LOGIN_HINT);
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            var campus = campusOf(json.kbList);
            return Promise.all([
                optionalJson(pageUrl('xskbcx_cxRjc.html', MENU_SCHEDULE), termBody + '&xqh_id=' + encodeURIComponent(campus))
                    .then(function (raw) { return pickRows(raw, PERIOD_FIELDS); }),
                optionalJson(pageUrl('xskbcxZccx_cxZcByXnxq.html', MENU_CALENDAR), termBody)
                    .then(function (raw) { return pickRows(raw, CALENDAR_FIELDS); })
            ]).then(function (extras) {
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText
                    },
                    today: localTodayIso(),
                    qsxqj: json.qsxqj === undefined ? null : json.qsxqj,
                    raw: {
                        kbList: pickFields(json.kbList, KB_FIELDS),
                        sjkList: pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS)
                    },
                    total: totalOf(json),
                    periodTimes: extras[0],
                    calendar: extras[1]
                });
            });
        });
    });
})()
