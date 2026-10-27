(function () {
    // 河北工程大学教务适配器（正方教务 v9，站点根路径部署，没有 /jwglxt 前缀）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 HEBEU/hebeu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Nanawwa）
    //   上游快照 e15c627（2026-10-26 拉取）
    //   本校脚本最后一次修改 25dc738（2026-10-15）
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数、块级声明关键字、Set / Map、展开符）
    //   ② 不弹窗让用户选学年与学期：上游先取一次课表首页生成「默认学期 / 更换学年学期」两级选择框；
    //      这里直接读页面上的 #xnm / #xqm（用户自己切过的学期优先），页面上没有才去取一次课表首页读同样两个下拉框。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ③ 只取数：排课行（kbList）、集中实践课（sjkList）、节次时间、学期校历交出去；
    //      周次、节次解析、开学日、总周数、节次覆盖检查与课程合并全部挪到 parse.js（CI 里跑得到的那一段）
    //   ④ 请求路径、方法、参数照上游：全部 POST 表单，站点根路径（没有 /jwglxt 前缀，地址由 window.location.origin 拼，
    //      上游 getBaseUrl 同样是 location.origin + '/'），课表请求体 xnm / xqm / kzlx=ck / xsdm= / kclbdm= / kclxdm= 逐字一致，
    //      菜单号课表 N2151、校历与节次时间 N2154；节次时间的 xqh_id 取第一门有校区号的课（没有就不带，上游同样）。
    //      校历与节次时间取不到交 null（上游会把失败写进提醒并回落到写死的节次表，这里由 parse.js 回落并提醒）
    //   ⑤ 不再带出学生信息：排课行按字段白名单挑（kcmc / xm / cdmc / xqj / jcs / jc / zcd / xqh_id），
    //      实践课只留 kcmc，节次时间只留 jcmc / qssj / jssj，校历只留 zs / zsmc / rq / zcrq / ksrq；
    //      课表响应里夹带的 xsxx（学号、姓名、学院等）一律不带走，也不进 fixture
    //   ⑥ 入口判断：上游只检查主机名以 hebeu.edu.cn 结尾，否则弹窗提示后退出。这里收紧为只在教务主机 jwglxxfwpt.hebeu.edu.cn 本身上取数
    //      （与 manifest 的 loginUrl 同源，allowHosts 为空），同校其它子域名（统一认证、门户）与第三方页面给大白话提示、不发请求；登录页同样提示。
    //      请求只发往当前页面的同源地址，不写死主机名（manifest 的 allowHosts 为空，教务主机就是 loginUrl 的主机）
    //   ⑦ 请求头：Content-Type、X-Requested-With 与 Accept 照上游；凭据用 same-origin（上游同样）
    //
    // 取数方式：同源请求，最多四个，全部打在当前教务主机上：
    //   ① GET  /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期（已经开在课表页时跳过这一步）
    //   ② POST /kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                       取课表（JSON）
    //   ③ POST /jzgl/skxxMobile_cxRsdjc.html?gnmkdm=N2154                    取节次时间（取不到就 null）
    //   ④ POST /kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                 取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';
    var PERIOD_GNMKDM = 'N2154';
    var JW_HOST = 'jwglxxfwpt.hebeu.edu.cn';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 河北工程大学的教务是站点根路径部署：地址就是「当前主机 + / + 路径」
    function jwUrl(path) {
        return originOf() + '/' + path;
    }

    // 上游：主机名要以 hebeu.edu.cn 结尾。这里按白名单口径收紧到教务主机本身（manifest 的 loginUrl 主机），
    // 同校的统一认证、门户等其它子域名不取数、不发请求
    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === JW_HOST;
    }

    function onLoginPage() {
        return String(window.location.pathname || '').indexOf('login_slogin.html') >= 0;
    }

    // 登录失效时教务会把请求重定向到登录页（HTTP 200 + 登录页 HTML），地址或标题能认出来
    function looksLikeLogin(url, text) {
        return /login_slogin/i.test(String(url || '')) ||
            /<title[^>]*>\s*(用户登录|统一身份认证)/.test(String(text || ''));
    }

    function request(url, method, body, accept) {
        var options = {
            method: method,
            credentials: 'same-origin',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': accept
            }
        };
        if (typeof body === 'string') {
            options.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
            options.body = body;
        }
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text().then(function (text) {
                if (looksLikeLogin(response.url, text)) {
                    throw new Error('登录已过期，请重新登录教务系统后再点「提取课表」');
                }
                return text;
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    function get(url) {
        return request(url, 'GET', null, 'text/html');
    }

    function post(url, body) {
        return request(url, 'POST', body, 'application/json');
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

    // 读一个学年学期字段：正常是下拉框（跳过 value 为空的占位项，被 selected 标记的那项优先，
    // 没标记就取第一项）；万一页面把它放在隐藏 input 里，就直接读 value（上游也是读 value 的）
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
                '这个页面里读不到学年学期：请先在教务系统里打开「个人课表查询」，再点「提取课表」'
            );
        }
        return get(jwUrl('kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default'))
            .then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开「个人课表查询」后再点「提取课表」'
                    );
                }
                return found;
            });
    }

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，请求体照上游 requestJw 的参数顺序原样）。
    // 这个接口一次性返回整学期的排课，没有分页参数；万一响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=&kclxdm=';
        return post(jwUrl('kbcx/xskbcx_cxXsgrkb.html?gnmkdm=' + GNMKDM), body).then(function (text) {
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

    // 附加接口（节次时间 / 学期周次校历）：失败一律交 null，让 parse.js 回落并在提醒里说明 ——
    // 绝不因为附加接口挂掉就导不进课表。
    function optionalJson(url, body) {
        return post(url, body).then(function (text) {
            return jsonOf(text);
        }, function () {
            return null;
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

    // 一律先"拆壳"：教务的列表可能是裸数组，也可能套一层（rows / datas / data / list / items / kbList）。
    // 外壳只在这里定义一次，"有没有数据"和"挑字段"共用
    function listIn(value) {
        if (value instanceof Array) return value;
        if (!value || typeof value !== 'object') return [];
        var keys = ['rows', 'datas', 'data', 'list', 'items', 'kbList'];
        for (var i = 0; i < keys.length; i++) {
            if (value[keys[i]] instanceof Array) return value[keys[i]];
        }
        return [];
    }

    function pickFields(row, fields) {
        var out = {};
        if (!row || typeof row !== 'object') return out;
        for (var i = 0; i < fields.length; i++) {
            var value = row[fields[i]];
            if (value === null || value === undefined) continue;
            out[fields[i]] = value;
        }
        return out;
    }

    function pickList(value, fields) {
        var list = listIn(value);
        var out = [];
        for (var i = 0; i < list.length; i++) out.push(pickFields(list[i], fields));
        return out;
    }

    // 排课行按字段白名单挑：parse.js 只用到这八个字段，响应里其余内容（含学生个人信息）一律不带出
    var ROW_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'jc', 'zcd', 'xqh_id'];
    var PERIOD_FIELDS = ['jcmc', 'qssj', 'jssj'];
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'rq', 'zcrq', 'ksrq'];

    if (!onJwHost()) {
        throw new Error(
            '当前页面还不是河北工程大学教务系统。请先登录教务系统，打开「个人课表查询」，然后点「提取课表」'
        );
    }
    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「个人课表查询」，然后点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            // 只交出排课行与实践课行；响应里夹带的学生信息（xsxx 等）一律不带出
            var source = json.kbList;
            var rows = [];
            var campusId = '';
            var i;
            for (i = 0; i < source.length; i++) {
                var picked = pickFields(source[i], ROW_FIELDS);
                var id = textOf(picked.xqh_id).replace(/\s+/g, '');
                if (id && !campusId) campusId = id;
                rows.push(picked);
            }
            var practice = [];
            if (json.sjkList instanceof Array) {
                for (i = 0; i < json.sjkList.length; i++) {
                    var practiceName = textOf((json.sjkList[i] || {}).kcmc);
                    if (practiceName) practice.push({ kcmc: practiceName });
                }
            }
            var result = function (periodRaw, calendarRaw) {
                var periodRows = pickList(periodRaw, PERIOD_FIELDS);
                var calendarRows = pickList(calendarRaw, CALENDAR_FIELDS);
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
                    periodTimes: periodRows.length ? periodRows : null,
                    calendar: calendarRows.length ? calendarRows : null
                });
            };
            // 没有排课行（未排课的学期）：上游直接提示「暂无课程」不再拉作息；这里同样不发附加请求，由 parse.js 报「没有课程」
            if (!rows.length) return result(null, null);
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            // 节次时间：xqh_id 取第一门有校区号的课；没有校区号就不带（上游同样）
            var periodBody = termBody + (campusId ? '&xqh_id=' + encodeURIComponent(campusId) : '');
            return Promise.all([
                optionalJson(jwUrl('jzgl/skxxMobile_cxRsdjc.html?gnmkdm=' + PERIOD_GNMKDM), periodBody),
                optionalJson(jwUrl('kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=' + PERIOD_GNMKDM), termBody)
            ]).then(function (extras) {
                return result(extras[0], extras[1]);
            });
        });
    });
})()
