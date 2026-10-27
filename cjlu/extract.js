(function () {
    // 中国计量大学教务适配器（正方新版教务，根路径部署 /xtgl/ 等）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 CJLU/cjlu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，维护者 salt-fishes, ying-ck；
    //   adapters.yaml 注释：原脚本 ying-ck，salt-fishes 按正方 v9 规范重构）
    //   上游快照 e15c627（2026-10-26 拉取）
    //   本校脚本最后一次修改 274a351（2026-10-02）
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉箭头函数、块级声明关键字、Set / Map、展开运算符）
    //   ② 不弹窗让用户选学年与学期：上游取一次课表首页生成选择框再弹窗；这里直接读页面上的 #xnm / #xqm
    //      （用户自己切过的学期优先），页面上没有才去取一次课表首页读同样两个下拉框。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ③ 只取数：排课行、集中实践课、各校区节次时间、学期校历交出去；周次、节次、校区时间对比、合并、
    //      补节次全部挪到 parse.js
    //   ④ 校区作息：上游只取课表里出现的第一个校区的节次时间；这里每个出现过的校区各取一次交出去，
    //      由 parse.js 自动取课数最多的校区作基础并对其它校区的课出提醒。课表里一个校区号都没有时，
    //      照上游不带 xqh_id 取一次
    //   ⑤ 请求路径、方法、参数照上游：三个接口全是 POST + 表单体，查询串里带菜单号（课表 N2151、校历与节次时间 N2154），
    //      课表首页是 GET；校历与节次时间取不到交 null（上游会把失败写进提醒并回落内置节次，这里同样降级，说明由 parse.js 给）
    //   ⑥ 不再带出学生信息：排课行按字段白名单挑（kcmc / xm / cdmc / xqj / jcs / jc / zcd / xqh_id / xqmc），
    //      实践课只留 kcmc，节次时间只留 jcmc / qssj / jssj，校历只留 zs / zsmc / rq / zcrq / ksrq；响应里其余内容一律不交出
    //   ⑦ 入口判断：上游只看主机名是否以 cjlu.edu.cn 结尾；这里要求主机正好是教务 jwxt.cjlu.edu.cn（与登录入口同源），
    //      统一认证页（authserver.cjlu.edu.cn）、学校官网等其它主机，以及教务自己的登录页 / 单点登录跳转页，
    //      都给大白话提示，不发请求。模块根地址的切法照上游 getBaseUrl（从当前路径里最早出现的模块目录处切开）
    //   ⑧ 上游没有的学期回显核对也不加：课表接口的响应不再读 xsxx（上游也没有读）
    //
    // 取数方式：同源请求，最多 3 + 校区数个（上限 6 个校区）：
    //   ① GET  <模块根>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default   读当前学年学期（已经开在课表页时跳过）
    //   ② POST <模块根>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151   表单 xnm、xqm、kzlx=ck、xsdm、kclbdm、kclxdm   取课表（JSON）
    //   ③ POST <模块根>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154   表单 xnm、xqm   取学期校历（取不到就 null）
    //   ④ POST <模块根>/jzgl/skxxMobile_cxRsdjc.html?gnmkdm=N2154   表单 xnm、xqm、xqh_id   每个校区取一次节次时间（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成（统一认证），本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';
    var PERIOD_GNMKDM = 'N2154';
    var JW_HOST = 'jwxt.cjlu.edu.cn';
    var MODULE_MARKERS = ['/xtgl/', '/kbcx/', '/jzgl/'];
    var MAX_CAMPUS = 6;

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 模块根地址（不带结尾斜杠）：当前路径里最早出现的模块目录之前的部分；一个都没有就是站点根
    function jwBase() {
        var path = String(window.location.pathname || '');
        var cut = -1;
        for (var i = 0; i < MODULE_MARKERS.length; i++) {
            var at = path.indexOf(MODULE_MARKERS[i]);
            if (at >= 0 && (cut < 0 || at < cut)) cut = at;
        }
        return originOf() + (cut >= 0 ? path.substring(0, cut) : '');
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === JW_HOST;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '');
        return path.indexOf('login_slogin.html') >= 0 || path.indexOf('/sso/') >= 0;
    }

    function looksLikeLogin(url, text) {
        return /authserver\/|login_slogin/i.test(String(url || '')) ||
            /<title[^>]*>\s*统一身份认证/.test(String(text || ''));
    }

    // 请求：html 页面（GET）与 JSON 接口（POST 表单）共用。
    // 接口回的不是 JSON 时，正文里出现登录页的字样就按"登录过期"处理（上游同样）
    function request(method, url, bodyText, kind) {
        var headers = { 'X-Requested-With': 'XMLHttpRequest' };
        var options = { method: method, credentials: 'include', headers: headers };
        if (kind === 'json') {
            headers['Accept'] = 'application/json';
        } else {
            headers['Accept'] = 'text/html';
        }
        if (method === 'POST') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
            options.body = bodyText;
        }
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text().then(function (text) {
                var notJson = !/^\s*[\[{]/.test(text);
                if (looksLikeLogin(response.url, text) ||
                    (kind === 'json' && notJson && /login_slogin|用户登录|统一身份认证/.test(text))) {
                    throw new Error('登录已过期，请重新登录教务系统，再点「提取课表」');
                }
                return text;
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    function query(params) {
        var parts = [];
        for (var i = 0; i < params.length; i++) {
            parts.push(params[i][0] + '=' + encodeURIComponent(params[i][1]));
        }
        return parts.join('&');
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
    // 没标记就取第一项）；万一页面把它放在隐藏 input 里，就直接读 value
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
                '这个页面里读不到学年学期：请先在教务系统里打开个人课表，再点「提取课表」'
            );
        }
        return request('GET', jwBase() + '/kbcx/xskbcx_cxXskbcxIndex.html?' +
            query([['gnmkdm', GNMKDM], ['layout', 'default']]), '', 'html')
            .then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开个人课表后再点「提取课表」'
                    );
                }
                return found;
            });
    }

    // 课表接口：一次性返回整学期的排课。参数照上游 runImportFlow 原样
    function fetchTimetable(term) {
        var url = jwBase() + '/kbcx/xskbcx_cxXsgrkb.html?' + query([['gnmkdm', GNMKDM]]);
        var body = query([
            ['xnm', term.xnm], ['xqm', term.xqm],
            ['kzlx', 'ck'], ['xsdm', ''], ['kclbdm', ''], ['kclxdm', '']
        ]);
        return request('POST', url, body, 'json').then(function (text) {
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

    // 附加请求（校历 / 各校区节次时间）：失败一律交 null，让 parse.js 回落并在提醒里说明 —— 绝不因为它们挂掉就导不进课表
    function optionalJson(path, params) {
        var url = jwBase() + path + '?' + query([['gnmkdm', PERIOD_GNMKDM]]);
        return request('POST', url, query(params), 'json').then(function (text) {
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

    // 排课行按字段白名单挑：parse.js 只用到这几个字段，响应里其余内容（含学生个人信息）一律不带出
    var ROW_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'jc', 'zcd', 'xqh_id', 'xqmc'];
    var PERIOD_FIELDS = ['jcmc', 'qssj', 'jssj'];
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'rq', 'zcrq', 'ksrq'];

    if (!onJwHost()) {
        throw new Error(
            '当前页面还不是教务系统。请先登录中国计量大学教务系统（统一认证登录后会回到教务），' +
            '打开「个人课表查询」后再点「提取课表」'
        );
    }
    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「个人课表查询」，然后点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            // 只交出排课行与实践课行；响应里夹带的学生信息一律不带出
            var source = json.kbList;
            var rows = [];
            var campusIds = [];
            var seenCampus = {};
            var i;
            for (i = 0; i < source.length; i++) {
                var picked = pickFields(source[i], ROW_FIELDS);
                var id = textOf(picked.xqh_id).replace(/\s+/g, '');
                if (id && !seenCampus['c' + id] && campusIds.length < MAX_CAMPUS) {
                    seenCampus['c' + id] = true;
                    campusIds.push(id);
                }
                rows.push(picked);
            }
            var practice = [];
            if (json.sjkList instanceof Array) {
                for (i = 0; i < json.sjkList.length; i++) {
                    var practiceName = textOf((json.sjkList[i] || {}).kcmc);
                    if (practiceName) practice.push({ kcmc: practiceName });
                }
            }
            // 课表里一个校区号都没有时，照上游不带 xqh_id 取一次节次时间（交出去的校区号是空串）
            var askIds = campusIds.length ? campusIds : [''];
            var jobs = [
                optionalJson('/kbcx/xskbcxZccx_cxZcByXnxq.html', [['xnm', term.xnm], ['xqm', term.xqm]])
            ];
            for (i = 0; i < askIds.length; i++) {
                var params = [['xnm', term.xnm], ['xqm', term.xqm]];
                if (askIds[i]) params.push(['xqh_id', askIds[i]]);
                jobs.push(optionalJson('/jzgl/skxxMobile_cxRsdjc.html', params));
            }
            return Promise.all(jobs).then(function (results) {
                var periodTimes = [];
                for (var k = 0; k < askIds.length; k++) {
                    var slotRows = pickList(results[k + 1], PERIOD_FIELDS);
                    periodTimes.push({ campusId: askIds[k], rows: slotRows.length ? slotRows : null });
                }
                var calendarRows = pickList(results[0], CALENDAR_FIELDS);
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
                    periodTimes: periodTimes,
                    calendar: calendarRows.length ? calendarRows : null
                });
            });
        });
    });
})()
