(function () {
    // 广州华立学院教务适配器（正方教务 jwglxt，教务主机 jw.hualixy.edu.cn，统一认证或正方直登）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 HUALIXY/hualixy.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 小漫君）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取，2026-10-20 复核）
    //   本校脚本最后一次修改 80e30cf（2026-09-23）
    // 移植改动（逐条对应 AUDIT.md「移植改动」一节）：
    //   ① 不弹窗让用户选学年与学期：上游弹两个选择框（选项取自课表页的 #xnm / #xqm 下拉框）。这里直接读页面上的下拉框：
    //      被 selected 标的那项优先，没有就取第一项；页面上读不到才去取一次课表首页读同样两个下拉框。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」（移植手册 §3 第 1 步）
    //   ② 两个菜单号依次尝试（上游 GNMKDMS = N2151、N253508，顺序照旧）：课表首页与课表两条请求先用 N2151，
    //      失败（网络错误、非 2xx、不是 JSON / 不是课表、返回了登录页）再用 N253508；两个都失败才报错。
    //      课表用哪个菜单号成功，校历与节次时间就用同一个菜单号
    //   ③ 主机不写死：全部由 window.location.origin 拼出同源地址，WebVPN 的 /http/<hex> 前缀原样保留；
    //      当前查询串里有 vpn-数字-o数字-… 片段就沿用，没有就不带
    //   ④ 登录页与门户页不发请求：路径不在 /jwglxt/ 下（统一认证页 /sso/ddlogin 等）或是 login_slogin.html，直接提示先登录；
    //      响应文本同时含「登录」和「密码」视为登录页（上游的判断，照搬）
    //   ⑤ 只取数、只交白名单字段：排课行 kbList 只留 kcmc / xm / cdmc / xqj / jcs / zcd 六个字段，
    //      集中实践课 sjkList 只留 kcmc；响应里夹带的学生信息（xsxx、学号、姓名、学院等）一律不带出，也不进 fixture
    //   ⑥ 节次时间：上游只从 cxRjc 读，读不到就跳过作息导入，没有内置表。这里照样请求 cxRjc（请求体不带 xqh_id），
    //      取到且 parse.js 校验通过就用教务的；取不到交 null，parse.js 整张改用空课默认的 12 节表并写进 warnings
    //   ⑦ 学期周次校历（cxZcByXnxq）上游本来就取，照旧；取不到交 null，parse.js 推算开学日并说明
    //   ⑧ 交出 qsxqj（课表响应顶层的每周起始日，1=周一…7=周日），parse.js 按移植手册 §4.3 回退开学日
    //   ⑨ 每个请求统一带 Content-Type、X-Requested-With 与 Accept（上游只有部分请求带）；请求体参数值经 encodeURIComponent，数字不变
    //
    // 取数方式：同源请求，最多五个（全部打在当前教务主机上，地址都由 window.location.origin 拼出来）：
    //   ① GET  /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （页面上已有下拉框时跳过；失败再试 N253508）
    //   ② POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON，必需）
    //   ③ POST /jwglxt/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151                         取节次时间（取不到就 null）
    //   ④ POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2151                取学期周次校历（取不到就 null）
    // 上面 ①②③④ 里的 N2151 是默认值：② 用 N253508 成功时，③ ④ 跟着换成 N253508。
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    // 课表相关接口的模块号：先 N2151，不成功再 N253508（上游 GNMKDMS，顺序照旧）
    var GNMKDMS = ['N2151', 'N253508'];
    var LOGIN_HINT = '请先登录教务系统，再点「提取课表」';

    // 课表行只留 parse.js 用得到的字段（xqh_id 等不留：节次时间请求不带校区号）
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];
    var PRACTICE_FIELDS = ['kcmc'];
    var PERIOD_FIELDS = ['jcdm', 'jcmc', 'qssj', 'jssj', 'sksj'];
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'zrq', 'zcrq', 'rq', 'ksrq'];

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 教务上下文：/jwglxt 之前若还有一段前缀（WebVPN 的 /http/<hex>），原样保留。调用前已确认路径在 /jwglxt/ 下
    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(JWLGXT + '/');
        return originOf() + path.substring(0, at) + JWLGXT;
    }

    // 查询串里的 WebVPN 片段（vpn-数字-o数字-…）：有就沿用，没有就不带
    function vpnPart() {
        var search = String(window.location.search || '');
        var m = /(^|[?&])(vpn-[0-9]+-o[0-9]+-[^&#]*)/.exec(search);
        return m ? m[2] + '&' : '';
    }

    // 拼接教务接口地址：<上下文>/kbcx/<页面>?[vpn 片段&]gnmkdm=<菜单号>[附加参数]
    function pageUrl(page, menu, extra) {
        return jwBase() + '/kbcx/' + page + '?' + vpnPart() + 'gnmkdm=' + menu + (extra || '');
    }

    // 路径不在教务系统里（统一认证页、门户页，或正方登录页）：不发请求，直接提示
    function notInJwglxt() {
        var path = String(window.location.pathname || '');
        return path.indexOf('login_slogin.html') >= 0 || path.indexOf(JWLGXT + '/') < 0;
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

    // 两个菜单号依次试：make(menu) 成功就停；失败（reject）换下一个；两个都失败抛最后一个的原因
    function tryMenus(make, index) {
        var at = index || 0;
        return make(GNMKDMS[at]).then(null, function (error) {
            if (at + 1 >= GNMKDMS.length) throw error;
            return tryMenus(make, at + 1);
        });
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
            return Promise.reject(new Error(
                '这个页面里读不到学年学期：请先在教务系统里打开「信息查询 - 学生课表查询」，再点「提取课表」'
            ));
        }
        return tryMenus(function (menu) {
            return get(pageUrl('xskbcx_cxXskbcxIndex.html', menu, '&layout=default')).then(function (html) {
                var found = readTermFromDoc(new DOMParser().parseFromString(String(html), 'text/html'));
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开「信息查询 - 学生课表查询」后再点「提取课表」'
                    );
                }
                return found;
            });
        });
    }

    // 课表（正方：POST 表单，xnm 学年 + xqm 学期代号，请求体照上游，带 kclbdm=）。
    // 一次性返回整学期排课，没有分页；响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
        return tryMenus(function (menu) {
            return post(pageUrl('xskbcx_cxXsgrkb.html', menu), body).then(function (text) {
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
                return { menu: menu, json: json };
            });
        });
    }

    // 附加接口（节次时间 / 学期周次校历）：不是每个部署都有，失败一律交 null，
    // 让 parse.js 回落到内置节次时间并在 warnings 里说明 —— 绝不因为附加接口挂掉就导不进课表
    function optionalJson(url, body) {
        return post(url, body).then(function (text) {
            return jsonOf(text);
        }, function () {
            return null;
        });
    }

    // 响应外壳只在这里判断一次：裸数组，或者 { data: [...] }。
    // 「有没有数据」与「挑字段」都用它拿到的同一份行数组，外壳不一致就不会既没兜底又丢数据
    function pickRows(json, fields) {
        var list = null;
        if (json instanceof Array) list = json;
        else if (json && typeof json === 'object' && json.data instanceof Array) list = json.data;
        if (!list || !list.length) return null;
        return pickFields(list, fields);
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

    if (notInJwglxt()) {
        throw new Error(LOGIN_HINT);
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (result) {
            var menu = result.menu;
            var json = result.json;
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return Promise.all([
                // 节次时间与校历用课表成功时的同一个菜单号；请求体照上游（不带 xqh_id）
                optionalJson(pageUrl('xskbcx_cxRjc.html', menu), termBody + '&kzlx=ck&xsdm=&kclbdm=&kclxdm=')
                    .then(function (raw) { return pickRows(raw, PERIOD_FIELDS); }),
                optionalJson(pageUrl('xskbcxZccx_cxZcByXnxq.html', menu), termBody)
                    .then(function (raw) { return pickRows(raw, CALENDAR_FIELDS); })
            ]).then(function (extras) {
                var rawFirstDay = json.qsxqj === undefined ? null : json.qsxqj;
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText
                    },
                    gnmkdm: menu,
                    today: localTodayIso(),
                    qsxqj: rawFirstDay,
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
