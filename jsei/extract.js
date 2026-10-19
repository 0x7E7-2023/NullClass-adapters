(function () {
    // 江苏电子信息职业学院教务适配器（正方新版 jwglxt；WebVPN 映射主机与校园网直连两个入口）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 JSEI/jsei_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 c4a35feb061a3f6db2d6c122927083c067c61309（2026-10-19）
    //   本校脚本最后一次修改 4570e79（2026-10-14）
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗让用户选学年与学期：上游先取一次课表首页生成两个选择框，再用 showSingleSelection 让用户选；
    //      这里直接读页面上的 #xnm / #xqm（用户自己切过的学期优先），页面上没有才去取一次课表首页读同样两个下拉框。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」（移植手册 §3 第 1 步）
    //   ③ 只取数：排课行（kbList）、集中实践课（sjkList）、节次时间、学期周次校历交出去；
    //      周次解析、节次解析与课程合并全部挪到 parse.js（CI 里跑得到的那一段）
    //   ④ 双入口不写死主机：上游按页面域名在两个写死的教务地址里二选一；这里一律用
    //      window.location.origin 拼同源相对路径 —— 页面在哪个主机上就在哪个主机取数。
    //      WebVPN 映射主机（登录页所在的 jwpd-443.webvpn.jsei.edu.cn）由 loginUrl 覆盖，
    //      校园网直连主机 jwpd.jsei.edu.cn 由 allowHosts 覆盖，两者都不必写进代码
    //   ⑤ 节次时间完全照上游：POST skxxMobile_cxRsdjc（菜单号 N2154），请求体 xnm / xqm / xqh_id=1
    //      （xqh_id 固定 1，与上游逐字一致）；取不到交 null，parse.js 回落到学校 11 节表并说明
    //   ⑥ 学期周次校历照上游：POST xskbcxZccx_cxZcByXnxq（N2154），请求体 xnm / xqm；取不到交 null
    //   ⑦ 请求头：每个请求统一带 Content-Type、X-Requested-With 与 Accept（上游课表请求只带 Content-Type）；
    //      课表请求体与上游逐字一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），参数值经 encodeURIComponent
    //   ⑧ 不再带出学生信息：排课行按字段白名单挑（kcmc / xm / cdmc / xqj / jcs / zcd / xqh_id），
    //      集中实践课只留 kcmc；响应里的 xsxx 之类一律不带走，也不进 fixture
    //
    // 取数方式：同源请求，最多四个，全部打在当前教务主机上（地址都由 window.location.origin 拼出来，
    // 不写死主机名）：
    //   ① GET  /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （已经开在课表页时跳过这一步）
    //   ② POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON）
    //   ③ POST /jwglxt/jzgl/skxxMobile_cxRsdjc.html?gnmkdm=N2154                   取节次时间（取不到就 null）
    //   ④ POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    var GNMKDM = 'N2151';
    var PERIOD_GNMKDM = 'N2154';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 正方新版的上下文路径是 /jwglxt；万一挂在前缀下（门户 / 网关），跟着当前地址里的那一段走
    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(JWLGXT + '/');
        if (at > 0) return originOf() + path.substring(0, at + JWLGXT.length);
        return originOf() + JWLGXT;
    }

    // 上游第一步就是「当前 URL 等于登录页就别导」，这里保留同样的提示（少一次注定失败的请求）
    function onLoginPage() {
        return String(window.location.pathname || '').indexOf('login_slogin.html') >= 0;
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

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，请求体照上游 JSEI 脚本原样）。
    // 这个接口一次性返回整学期的排课，没有分页参数；万一响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
        return post(jwBase() + '/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=' + GNMKDM, body)
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

    // 附加接口（节次时间 / 学期周次校历）：不是每个部署都有这两个菜单，失败一律交 null，
    // 让 parse.js 回落到内置节次时间与推算并在 warnings 里说明 —— 绝不因为附加接口挂掉就导不进课表。
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

    // 排课行按字段白名单挑：parse.js 只用到这七个字段，响应里其余内容（含学生个人信息）一律不带出
    var ROW_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd', 'xqh_id'];

    function pickRow(row) {
        var out = {};
        if (!row || typeof row !== 'object') return out;
        for (var i = 0; i < ROW_FIELDS.length; i++) {
            var value = row[ROW_FIELDS[i]];
            if (value === null || value === undefined) continue;
            out[ROW_FIELDS[i]] = value;
        }
        return out;
    }

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
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
                var picked = pickRow(source[i]);
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
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return Promise.all([
                // 节次时间：路径、菜单号与请求体照上游 JSEI 脚本（xqh_id 固定 1）
                optionalJson(jwBase() + '/jzgl/skxxMobile_cxRsdjc.html?gnmkdm=' + PERIOD_GNMKDM,
                    termBody + '&xqh_id=1'),
                optionalJson(jwBase() + '/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154', termBody)
            ]).then(function (extras) {
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText
                    },
                    today: localTodayIso(),
                    campusId: campusId,
                    raw: { kbList: rows, sjkList: practice },
                    total: totalOf(json),
                    periodTimes: extras[0],
                    calendar: extras[1]
                });
            });
        });
    });
})()
