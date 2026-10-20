(function () {
    // 广东海洋大学（本部）教务适配器（正方教务 V9 新版 jwglxt，根路径部署）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 GDOU/gdou.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Mccurtain）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取，2026-10-20 复核）
    //   本校脚本最后一次修改 0ed4caa（2026-10-08）
    //   同目录的阳江校区脚本 gdouyj.js / gdouyj2.js 不在本件范围内
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗让用户选学年与学期：上游先弹两个选择框（选项取自课表页的 #xnm / #xqm 下拉框，读不到才用写死的学期码 3 / 12），
    //      这里直接读页面上的 #xnm / #xqm（被 selected 标的那项优先，没有就取第一项）；页面上读不到才去取一次课表首页读同样两个下拉框，
    //      取到的页面里也读不到就报错，不再用写死的学期码。要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ③ 主机不写死：上游把 https://jw.gdou.edu.cn 写进每一条请求。这里全部由 window.location.origin 加上当前路径里
    //      /kbcx/ 或 /xtgl/ 之前的那一段前缀拼出同源地址（直连时前缀为空；经网关访问时原样保留）。
    //      当前地址里找不到这两个标志（门户首页、统一认证页）就不发任何请求，直接提示先进入教务系统
    //   ④ 只取数：排课行（kbList）只带 kcmc / xm / cdmc / xqj / jcs / zcd 六个字段，集中实践课（sjkList）只带课名，学期周次校历照取；
    //      响应里夹带的学生信息（xsxx、学号、姓名、学院等）一律不带出；周次、节次解析与课程合并全部挪到 parse.js
    //   ⑤ 不请求节次时间：上游不用教务的节次时间接口，直接把写死的 10 节表存成预设；这里同样不请求，
    //      节次时间用 parse.js 里的本校 10 节表，交出去的数据里也没有 periodTimes
    //   ⑥ 请求头：每个请求统一带 Content-Type、X-Requested-With 与 Accept（上游课表请求只带 Content-Type）；
    //      课表请求体与上游逐字一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），参数值经 encodeURIComponent，数字不变
    //   ⑦ 上游的开场弹窗、校区选择弹窗、saveImportedCourses / saveCourseConfig / savePresetTimeSlots、showToast / notifyTaskCompletion 全部不移植
    //
    // 取数方式：同源请求，最多三个，全部打在当前教务页面所在的主机上（地址由 window.location.origin 加上路径前缀拼出来，
    // 不写死主机名，也不写死端口）。<前缀> 直连时为空：
    //   ① GET  <前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （页面上已有 #xnm / #xqm 时跳过这一步）
    //   ② POST <前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON）
    //   ③ POST <前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';
    var GNMKDM_CALENDAR = 'N2154';
    var NOT_IN_JW = '请先登录并进入教务系统，打开「学生课表查询」后再点「提取课表」';
    var ON_LOGIN = '当前打开的是登录页，请先登录，再进入教务系统、打开「学生课表查询」后点「提取课表」';
    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function pathOf() {
        return String(window.location.pathname || '');
    }

    // 登录页：正方自己的登录页（login_slogin.html），还没进到教务，不发请求
    function onLoginPage() {
        return pathOf().indexOf('login_slogin.html') >= 0;
    }

    // 教务的路径前缀：取当前路径里最早出现的 /kbcx/ 或 /xtgl/，前面那一段就是前缀（直连为空串，经网关访问时原样保留）。
    // 两个标志都没有（门户首页、统一认证页）返回 null，调用方直接报错、不发请求
    function prefixOf() {
        var path = pathOf();
        var marks = ['/kbcx/', '/xtgl/'];
        var at = -1;
        for (var i = 0; i < marks.length; i++) {
            var found = path.indexOf(marks[i]);
            if (found >= 0 && (at < 0 || found < at)) at = found;
        }
        if (at < 0) return null;
        return path.substring(0, at);
    }

    // 拼教务地址：<前缀>/kbcx/<页面>?gnmkdm=…[附加参数]
    function jwUrl(prefix, page, menu, extra) {
        return originOf() + prefix + '/kbcx/' + page + '?gnmkdm=' + menu + (extra || '');
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
            return response.text();
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

    function currentTerm(prefix) {
        var onPage = readTermFromDoc(window.document);
        if (onPage) return Promise.resolve(onPage);
        if (typeof DOMParser === 'undefined') {
            throw new Error(
                '这个页面里读不到学年学期：请先在教务系统里打开「学生课表查询」，再点「提取课表」'
            );
        }
        return get(jwUrl(prefix, 'xskbcx_cxXskbcxIndex.html', GNMKDM, '&layout=default'))
            .then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开「学生课表查询」后再点「提取课表」'
                    );
                }
                return found;
            });
    }

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，参数照上游 GDOU 脚本原样，带 kclbdm=）。
    // 这个接口一次性返回整学期的排课，没有分页参数；万一响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(prefix, term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
        return post(jwUrl(prefix, 'xskbcx_cxXsgrkb.html', GNMKDM), body)
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

    // 附加接口（学期周次校历）：不是每个部署都有这个菜单，失败一律交 null，
    // 让 parse.js 回落到推算并在 warnings 里说明 —— 绝不因为附加接口挂掉就导不进课表。
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

    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（学生信息 xsxx 之类）一律不带出
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];
    var PRACTICE_FIELDS = ['kcmc'];
    // 校历一行一周：第几周（zs / zsmc）与日期（上游依次认 zrq / zcrq / rq / ksrq）
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'zrq', 'zcrq', 'rq', 'ksrq'];

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

    // 校历响应：正常是一行一周的数组；个别部署套一层 data / list / rows / datas / items。
    // 外壳只在这里定义一次，交给 parse.js 的永远是只带白名单字段的数组（认不出外壳交 null）
    function calendarRows(value) {
        var list = value instanceof Array ? value : null;
        if (!list && value && typeof value === 'object') {
            var keys = ['data', 'list', 'rows', 'datas', 'items'];
            for (var i = 0; i < keys.length; i++) {
                if (value[keys[i]] instanceof Array) { list = value[keys[i]]; break; }
            }
        }
        if (!list) return null;
        var objects = [];
        for (var j = 0; j < list.length; j++) {
            if (list[j] && typeof list[j] === 'object') objects.push(list[j]);
        }
        return pickFields(objects, CALENDAR_FIELDS);
    }

    if (onLoginPage()) {
        throw new Error(ON_LOGIN);
    }
    var prefix = prefixOf();
    if (prefix === null) {
        throw new Error(NOT_IN_JW);
    }

    return currentTerm(prefix).then(function (term) {
        return fetchTimetable(prefix, term).then(function (json) {
            // 只交出白名单字段；响应里夹带的学生信息（xsxx 等）一律不带出
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return optionalJson(jwUrl(prefix, 'xskbcxZccx_cxZcByXnxq.html', GNMKDM_CALENDAR), termBody).then(function (calendar) {
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
                    calendar: calendarRows(calendar)
                });
            });
        });
    });
})()
