(function () {
    // 广东药科大学教务适配器（正方教务，jwglxt 根路径，经学校 WebVPN 访问）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 GDPU/gdpu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf（2026-09-23）
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗问学年、不问学期：上游用 showPrompt 让用户输入起始学年，用 showSingleSelection 选学期，并把学期码写死成 3 / 12。
    //      这里直接读课表页上的 #xnm / #xqm（被 selected 标的那项优先，没有就第一项）；页面上读不到才去取一次课表首页 HTML
    //   ③ 地址不写死：上游把 WebVPN 映射地址 https://webvpn.gdpu.edu.cn/http/<十六进制>/ 与查询串 vpn-12-o1-jwsys.gdpu.edu.cn 写进了每条请求。
    //      这里由当前页面地址拼出 <base>（取 /kbcx/ 或 /xtgl/ 之前的那一段，WebVPN 下即 /http/<十六进制>），
    //      WebVPN 查询串沿用当前地址里的 vpn-… 片段，找不到才用上游那个
    //   ④ 只取数：排课行（kbList）、集中实践课（sjkList）、校区作息、学期周次校历交出去；周次、节次、课程合并全部挪到 parse.js
    //   ⑤ 不再带出学生信息：排课行只带 kcmc / xm / cdmc / xqj / jcs / zcd / xqh_id，实践课只带 kcmc，
    //      作息只带 jcmc / jc / qssj / jssj，校历只带 zs / zsmc / zrq / zcrq / rq / ksrq；
    //      课表响应里夹带的 xsxx（学号、姓名、学院等）一律不带出，也不进 fixture
    //   ⑥ 上游没有作息接口：两个校区的节次时间是写死在脚本里的两张 15 节表，按弹窗选的校区取。
    //      这里多取一个作息接口（cxRjc，菜单号 N2151，带 xqh_id）：取到非空数组就交出去；取不到，且宿主能提问，就用 __ncSelect 问一次校区，
    //      把选的下标交给 parse.js；问不了就交 null，parse.js 按广州、云浮校区的表导入并写进 warnings
    //   ⑦ 上游 config 里的 defaultClassDuration / defaultBreakDuration / firstDayOfWeek 不移植（载荷没有这些概念，每周起始日按手册 §4 处理）
    //   ⑧ 请求头：每个请求统一带 Content-Type、X-Requested-With 与 Accept；课表请求体与上游一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），参数值经 encodeURIComponent
    //
    // 取数方式：同源请求，最多四个，全部打在当前教务页面所在的主机上（地址由 window.location 拼出来，不写死主机名）：
    //   ① GET  <base>/kbcx/xskbcx_cxXskbcxIndex.html?[vpn&]gnmkdm=N2151&layout=default   读当前学年学期（页面上已有就跳过）
    //   ② POST <base>/kbcx/xskbcx_cxXsgrkb.html?[vpn&]gnmkdm=N2151                       取课表（JSON）
    //   ③ POST <base>/kbcx/xskbcx_cxRjc.html?[vpn&]gnmkdm=N2151                          取校区作息（取不到就 null）
    //   ④ POST <base>/kbcx/xskbcxZccx_cxZcByXnxq.html?[vpn&]gnmkdm=N2154                 取学期周次校历（取不到就 null）
    //   [vpn&] 只在经 WebVPN 打开时带上（当前地址的路径以 /http/ 或 /https/ 开头）。
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';
    var CALENDAR_MENU = 'N2154';
    // 上游写死的 WebVPN 查询串片段；当前地址里找不到 vpn-… 片段时用它
    var VPN_FALLBACK = 'vpn-12-o1-jwsys.gdpu.edu.cn';
    var CAMPUS_ITEMS = ['广州、云浮校区', '中山校区'];

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 经 WebVPN 打开时，路径以 /http/ 或 /https/ 开头（上游的映射地址就是这个形状）
    function viaWebVpn() {
        return /^\/https?\//.test(String(window.location.pathname || ''));
    }

    // WebVPN 查询串片段：从当前地址的查询串里找形如 vpn-数字-o数字-…（到 & 或结尾）的那一段，找不到用上游的写法
    function vpnQuery() {
        var search = String(window.location.search || '');
        var match = /(^|[?&])(vpn-[0-9]+-o[0-9]+-[^&]+)/.exec(search);
        return match ? match[2] : VPN_FALLBACK;
    }

    // 教务的 base：当前地址里最早出现的 /kbcx/ 或 /xtgl/ 之前那一段（WebVPN 下是 /http/<十六进制>，正常部署为空）。
    // 找不到这两个标记，说明停在 WebVPN 首页或统一认证页之类的地方，抛大白话提示，不发请求
    function jwBase() {
        var path = String(window.location.pathname || '');
        var cut = -1;
        var marks = ['/kbcx/', '/xtgl/'];
        for (var i = 0; i < marks.length; i++) {
            var at = path.indexOf(marks[i]);
            if (at >= 0 && (cut < 0 || at < cut)) cut = at;
        }
        if (cut < 0) {
            throw new Error('请先进入教务系统、打开课表页后再点「提取课表」');
        }
        return originOf() + path.substring(0, cut);
    }

    // 拼教务地址：路径、菜单号、附加参数；经 WebVPN 时把 vpn 片段放在最前面
    function kbcxUrl(page, menu, extra) {
        var query = [];
        if (viaWebVpn()) query.push(vpnQuery());
        query.push('gnmkdm=' + menu);
        if (extra) query.push(extra);
        return jwBase() + '/kbcx/' + page + '?' + query.join('&');
    }

    // 登录页判断：照上游 isLoginPage()（href 含 lyuapServer/login），另加一条 login_slogin.html（正方自己的登录页）
    function onLoginPage() {
        var href = String(window.location.href || '');
        var path = String(window.location.pathname || '');
        return href.indexOf('lyuapServer/login') >= 0 || path.indexOf('login_slogin.html') >= 0;
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

    function jsonOf(text) {
        try {
            return JSON.parse(String(text));
        } catch (e) {
            return null;
        }
    }

    // 读一个学年学期字段：正常是下拉框（跳过 value 为空的占位项，被 selected 标记的那项优先，没标记就取第一项）；
    // 万一页面把它放在隐藏 input 里，就直接读 value（上游也是读 value 的）
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
        return get(kbcxUrl('xskbcx_cxXskbcxIndex.html', GNMKDM, 'layout=default'))
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

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，参数照上游 GDPU 脚本原样，带 kclbdm=）。
    // 这个接口一次性返回整学期的排课，没有分页参数；万一响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
        return post(kbcxUrl('xskbcx_cxXsgrkb.html', GNMKDM), body)
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

    // 附加接口（校区作息 / 学期周次校历）：不是每个部署都有这两个菜单，失败一律交 null，
    // 让 parse.js 回落到校区节次时间表 / 推算开学日并在 warnings 里说明 —— 绝不因为附加接口挂掉就导不进课表
    function optionalJson(url, body) {
        return post(url, body).then(function (text) {
            return jsonOf(text);
        }, function () {
            return null;
        });
    }

    // 作息接口的返回：非空数组，或套了一层信封的非空数组（具体校验留给 parse.js，这里只判断「有没有东西」）
    function hasPeriodRows(json) {
        if (json instanceof Array) return json.length > 0;
        if (!json || typeof json !== 'object') return false;
        var keys = ENVELOPE_KEYS; // 与下面 slimRows 同一份口径（与 parse.js 一致）
        for (var i = 0; i < keys.length; i++) {
            if (json[keys[i]] instanceof Array && json[keys[i]].length > 0) return true;
        }
        return false;
    }

    // 教务没给节次时间时问一次校区（宿主不能提问、用户取消、报错，都交 null，不让整次提取失败）
    function askCampus() {
        var capable = typeof __ncCapabilities !== 'undefined' && __ncCapabilities && __ncCapabilities.ask;
        if (!capable || typeof __ncSelect !== 'function') return Promise.resolve(null);
        return Promise.resolve().then(function () {
            return __ncSelect({
                title: '选择校区',
                message: '教务系统没有给出节次时间，选你上课的校区，用来设置每节课的上下课时间',
                items: CAMPUS_ITEMS,
                defaultIndex: 0
            });
        }).then(function (index) {
            return typeof index === 'number' && index >= 0 && index < CAMPUS_ITEMS.length ? index : null;
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

    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（学生信息 xsxx 之类）一律不带出；
    // xqh_id 是校区号，只用来拼作息请求并随行交出，不含个人信息
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd', 'xqh_id'];
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

    // 作息与校历也只交 parse.js 读的字段（裸数组，或套一层信封的数组）；其它一律不带出
    var PERIOD_FIELDS = ['jcmc', 'jc', 'qssj', 'jssj'];
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'zrq', 'zcrq', 'rq', 'ksrq'];
    var ENVELOPE_KEYS = ['rows', 'datas', 'data', 'list', 'items', 'kbList'];

    function slimRows(value, fields) {
        if (value instanceof Array) return pickFields(value, fields);
        if (!value || typeof value !== 'object') return null;
        for (var i = 0; i < ENVELOPE_KEYS.length; i++) {
            var list = value[ENVELOPE_KEYS[i]];
            if (list instanceof Array) {
                var wrapped = {};
                wrapped[ENVELOPE_KEYS[i]] = pickFields(list, fields);
                return wrapped;
            }
        }
        return null;
    }

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }
    // 不在教务里（门户首页之类）就在这里抛出提示，不发任何请求
    jwBase();

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
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
                optionalJson(kbcxUrl('xskbcx_cxRjc.html', GNMKDM), termBody + '&xqh_id=' + encodeURIComponent(campusId)),
                optionalJson(kbcxUrl('xskbcxZccx_cxZcByXnxq.html', CALENDAR_MENU), termBody)
            ]).then(function (extras) {
                var periodTimes = extras[0];
                var asked = hasPeriodRows(periodTimes) ? Promise.resolve(null) : askCampus();
                return asked.then(function (campusChoice) {
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
                        periodTimes: slimRows(periodTimes, PERIOD_FIELDS),
                        campusChoice: campusChoice,
                        calendar: slimRows(extras[1], CALENDAR_FIELDS)
                    });
                });
            });
        });
    });
})()
