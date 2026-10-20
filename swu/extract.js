(function () {
    // 西南大学教务适配器（正方教务新版 jwglxt，部署在 /jwglxt 下，从办事大厅门户进入）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SWU/swu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 小漫君）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 91c79f1（2026-10-15）
    // 移植改动（逐条对应 AUDIT.md §4）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗让用户选学年与学期：上游用 showSingleSelection 让用户点选（选项取自课表页的 #xnm / #xqm 下拉框），
    //      这里直接读页面上的 #xnm / #xqm（被 selected 标的那项优先，没有就第一项）；页面上没有才去取一次课表首页读同样两个下拉框。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ③ 主机不写死：上游把 https://jw.swu.edu.cn 与 /jwglxt 写进了每一条请求。这里的同源地址由 window.location.origin 拼出来；
    //      当前地址在 /jwglxt/ 之前若还有一段前缀（WebVPN 的 /http/<十六进制>、/https/<主机名>），原样保留（上游 buildApiUrl 也是这么做的）
    //   ④ 门户页与登录页不发请求：当前路径里没有 /jwglxt/（停在办事大厅或统一认证页）就抛提示「请先从办事大厅进入…」；
    //      路径含 login_slogin.html 就抛「请先登录」。上游在这种页面上会拼出 origin + /jwglxt 再去请求，必然失败
    //   ⑤ WebVPN 查询串：当前地址的查询串里若有 vpn-数字-o数字-… 片段，沿用到课表请求地址上；没有就不带，不造默认值
    //   ⑥ 只取数：排课行（kbList）、集中实践课（sjkList）、校区、学期周次校历、节次时间与每周起始日交出去（前两者只带白名单字段，见 ⑦）；
    //      周次解析、节次解析与课程合并全部挪到 parse.js（CI 里跑得到的那一段）
    //   ⑦ 不再带出学生信息：排课行只带 kcmc / xm / cdmc / xqj / jcs / zcd / xqh_id 与备注用的 cxbjmc / xkbz，
    //      实践课只带 kcmc；课表响应里夹带的学号、姓名、学院等一律不带走，也不进 fixture。zcd（周次原文）照常交出，
    //      但不进课程备注（周次已经在上课安排里）
    //   ⑧ 上游没有请求节次时间接口，写死 14 节表。这里多取一个作息接口（cxRjc，菜单号 N2151，带 xqh_id 校区；
    //      写法照模板 hueb 与同族正方脚本）：取到就用教务的节次时间，取不到交 null，parse.js 回落到上游那张 14 节表并在 warnings 里说明
    //   ⑨ 每周起始日：课表响应顶层的 qsxqj（1=周一…7=周日）原样交出，parse.js 按移植手册 §4.3 回退开学日
    //   ⑩ 请求头：每个请求统一带 Content-Type、X-Requested-With 与 Accept；课表请求体与上游一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），
    //      参数值经 encodeURIComponent，数字不变
    //
    // 取数方式：同源请求，最多四个（地址都由当前地址拼出来，不写死主机名与端口）：
    //   ① GET  <base>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （已经开在课表页时跳过这一步）
    //   ② POST <base>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON）
    //   ③ POST <base>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151                        取节次时间（取不到就 null）
    //   ④ POST <base>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154               取学期周次校历（取不到就 null）
    // 其中 <base> = 当前地址的 origin + /jwglxt 之前的路径前缀 + /jwglxt；登录全程由用户在 WebView 里手工完成，
    // 本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    var GNMKDM = 'N2151';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 教务上下文路径 /jwglxt 之前的那一段（WebVPN 前缀）原样保留；当前地址里找不到 /jwglxt/ 说明还没进到教务，返回 null
    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(JWLGXT + '/');
        if (at < 0) return null;
        return originOf() + path.substring(0, at + JWLGXT.length);
    }

    // WebVPN 查询串：当前地址的查询串里若有 vpn-数字-o数字-… 片段（到 & 或结尾为止），沿用到教务请求上；没有就不带
    function vpnPart() {
        var search = String(window.location.search || '');
        var m = /(^|[?&])(vpn-[0-9]+-o[0-9]+-[^&#]*)/.exec(search);
        return m ? m[2] + '&' : '';
    }

    // 拼教务地址：<base>/kbcx/<页面>?[vpn 片段&]gnmkdm=…[附加参数]
    function jwUrl(base, page, menu, extra) {
        return base + '/kbcx/' + page + '?' + vpnPart() + 'gnmkdm=' + menu + (extra || '');
    }

    // 登录页 / 门户页：不发请求，直接给大白话提示
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

    function currentTerm(base) {
        var onPage = readTermFromDoc(window.document);
        if (onPage) return Promise.resolve(onPage);
        if (typeof DOMParser === 'undefined') {
            throw new Error(
                '这个页面里读不到学年学期：请先在教务系统里打开「信息查询 - 学生课表查询」，再点「提取课表」'
            );
        }
        return get(jwUrl(base, 'xskbcx_cxXskbcxIndex.html', GNMKDM, '&layout=default'))
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

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，参数照上游 SWU 脚本原样，带 kclbdm=）。
    // 这个接口一次性返回整学期的排课，没有分页参数；万一响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(base, term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
        return post(jwUrl(base, 'xskbcx_cxXsgrkb.html', GNMKDM), body)
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
    // 让 parse.js 回落到推算与内置节次时间并在 warnings 里说明 —— 绝不因为附加接口挂掉就导不进课表。
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

    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（学生信息 xsxx 之类）一律不带出；
    // xqh_id 是校区号，只用来拼节次时间请求；cxbjmc（重修标记）与 xkbz（选课备注）只进课程备注
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd', 'xqh_id', 'cxbjmc', 'xkbz'];
    var PRACTICE_FIELDS = ['kcmc'];

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

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }
    var base = jwBase();
    if (!base) {
        throw new Error(
            '请先从办事大厅进入教务系统、打开「学生课表查询」后再点「提取课表」'
        );
    }

    return currentTerm(base).then(function (term) {
        return fetchTimetable(base, term).then(function (json) {
            // 只交出白名单字段；响应里夹带的学生信息（xsxx 等）一律不带出
            var rawRows = json.kbList;
            var campusId = '';
            for (var i = 0; i < rawRows.length; i++) {
                var id = textOf((rawRows[i] || {}).xqh_id).replace(/\s+/g, '');
                if (id) { campusId = id; break; }
            }
            var rows = pickFields(rawRows, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return Promise.all([
                optionalJson(jwUrl(base, 'xskbcx_cxRjc.html', GNMKDM),
                    termBody + '&xqh_id=' + encodeURIComponent(campusId)),
                optionalJson(jwUrl(base, 'xskbcxZccx_cxZcByXnxq.html', 'N2154'), termBody)
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
                    qsxqj: json.qsxqj === undefined ? null : json.qsxqj,
                    raw: { kbList: rows, sjkList: practice },
                    total: totalOf(json),
                    periodTimes: extras[0],
                    calendar: extras[1]
                });
            });
        });
    });
})()
