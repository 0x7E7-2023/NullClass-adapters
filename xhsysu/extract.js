(function () {
    // 广州新华学院教务适配器（正方教务 V9，根路径部署，统一认证 CAS 登录）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 XHSYSU/xhsysu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 58bff0b
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗让用户选学年与学期：上游先弹开场提示，再用两个 showSingleSelection 让用户点选（选项取自课表首页的 #xnm / #xqm 下拉框），
    //      这里直接读页面上的 #xnm / #xqm（被 selected 标的那项优先，没有就取第一项）；页面上读不到才去取一次课表首页读同样两个下拉框。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ③ 主机不写死：上游的请求都是站内相对路径（/kbcx/…），同源地址由 window.location.origin 加路径前缀拼出来。
    //      路径前缀 = 当前路径里 /kbcx/ 或 /xtgl/ 之前的那一段（校内直连为空；经 WebVPN 时是 /http/<十六进制>，上游也是保留这一段）。
    //      当前路径里两个都没有（学校门户、统一认证页等还没进教务的页面）不发任何请求，直接提示先进入教务系统
    //   ④ 登录页不发请求：上游的 isLoginPage 认 lyuapServer/login 与 /sso/lyiotlogin，这里照认，另加正方自己的 login_slogin.html，
    //      命中就抛「当前打开的是登录页」，不发请求（上游在这些页面只弹一个提示）
    //   ⑤ 只取数：排课行（kbList）、集中实践课（sjkList）与每周起始日（qsxqj）交出去（前两者只带白名单字段，见 ⑥）；
    //      周次解析、节次解析与课程合并全部挪到 parse.js（CI 里跑得到的那一段）
    //   ⑥ 不再带出学生信息：排课行只带 kcmc / xm / cdmc / xqj / jcs / zcd 六个字段，实践课只带 kcmc；
    //      课表响应里夹带的学号、姓名、学院等一律不带走，也不进 fixture
    //   ⑦ 不请求节次时间接口：上游只写死一张 14 节表（教务处「上课时间段一览表」），没有请求教务的节次时间，这里照上游，
    //      节次时间全部在 parse.js 里（逐节照抄上游）
    //   ⑧ 请求头：每个请求统一带 Content-Type、X-Requested-With 与 Accept（上游课表请求只带 Content-Type，校历请求才带 X-Requested-With）；
    //      课表请求体与上游逐字一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），参数值经 encodeURIComponent，数字不变
    //   ⑨ 会话失效时正方返回 200 + 登录页（或统一认证的跳转页）：先于 JSON 解析判断，单独提示；上游只会报「未找到课程数据」
    //   ⑩ 不用 filter / trim 等原型方法（有的正方页面会改写它们），去首尾空白用正则，筛数组用普通 for 循环
    //
    // 取数方式：同源请求，最多三个，全部打在当前教务页面所在的主机上（地址由 window.location 拼出来，不写死主机名与端口）：
    //   ① GET  <前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151            读当前学年学期
    //      （页面上已有 #xnm / #xqm 时跳过这一步）
    //   ② POST <前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                  取课表（JSON）
    //   ③ POST <前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154            取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成（统一认证），本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';
    var GNMKDM_CALENDAR = 'N2154';
    var NOT_IN_JW = '请先登录并进入教务系统，打开「信息查询 - 学生课表查询」后再点「提取课表」';
    var ON_LOGIN = '当前打开的是登录页（或登录后的跳转页）。请先登录，进入教务系统、打开「信息查询 - 学生课表查询」后再点「提取课表」';
    var EXPIRED = '登录状态已失效，请重新登录教务系统后再点「提取课表」';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function pathOf() {
        return String(window.location.pathname || '');
    }

    function asText(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    // 去首尾空白、内部空白压成一个空格（不用 trim：个别正方页面改写了它）
    function squeeze(value) {
        return asText(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function jsonOf(text) {
        try {
            return JSON.parse(asText(text));
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

    // 统一认证登录页（lyuapServer/login）、登录后的跳转页（/sso/lyiotlogin）与正方自己的登录页（login_slogin.html）：还没进到教务，不发请求
    function onLoginPage() {
        var href = asText(window.location.href);
        var path = pathOf();
        return href.indexOf('lyuapServer/login') >= 0 ||
            /\/sso\/lyiotlogin\/?$/.test(path) ||
            path.indexOf('login_slogin.html') >= 0;
    }

    // 教务的路径前缀：校内直连为空，经 WebVPN 是 /http/<十六进制>。
    // 取当前路径里最早出现的 /kbcx/ 或 /xtgl/，前面那一段就是前缀；两个都没有（学校门户、WebVPN 首页）返回 null，此时不发任何请求
    function prefixOf() {
        var path = pathOf();
        var at = -1;
        var marks = ['/kbcx/', '/xtgl/'];
        for (var i = 0; i < marks.length; i++) {
            var found = path.indexOf(marks[i]);
            if (found >= 0 && (at < 0 || found < at)) at = found;
        }
        if (at < 0) return null;
        return path.substring(0, at);
    }

    // 拼教务地址：<origin><前缀>/kbcx/<页面>?gnmkdm=…
    function jwUrl(prefix, page, menu) {
        return originOf() + prefix + '/kbcx/' + page + '?gnmkdm=' + menu;
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

    // 读一个学年学期下拉框：跳过 value 为空的占位项；被 selected 标记的那项优先，没标记就取第一项。
    // 万一页面把它放成没有 option 的 input，就直接读 value
    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options || !options.length) {
            var raw = asText(selectEl.value).replace(/\s+/g, '');
            return raw ? { value: raw, text: '' } : null;
        }
        var list = [];
        var picked = -1;
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var value = asText(option.value).replace(/\s+/g, '');
            if (!value) continue;
            if (option.selected && picked < 0) picked = list.length;
            list.push({ value: value, text: squeeze(option.textContent) });
        }
        if (!list.length) return null;
        return list[picked < 0 ? 0 : picked];
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
            throw new Error('这个页面里读不到学年学期：请先打开「信息查询 - 学生课表查询」，再点「提取课表」');
        }
        return get(jwUrl(prefix, 'xskbcx_cxXskbcxIndex.html', GNMKDM))
            .then(function (html) {
                var doc = new DOMParser().parseFromString(asText(html), 'text/html');
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

    function termBody(term) {
        return 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
    }

    // 课表接口（正方：POST 表单，参数照上游 XHSYSU 原样：xnm、xqm、kzlx=ck、xsdm=、kclbdm=）。一次性返回整学期排课，没有分页。
    // 会话失效时正方返回 200 + 登录页：先于 JSON 解析判断，单独提示
    function fetchTimetable(prefix, term) {
        var body = termBody(term) + '&kzlx=ck&xsdm=&kclbdm=';
        return post(jwUrl(prefix, 'xskbcx_cxXsgrkb.html', GNMKDM), body).then(function (text) {
            if (/login_slogin|lyuapServer|name=["']yhm["']/.test(asText(text))) {
                throw new Error(EXPIRED);
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

    // 附加接口（学期周次校历）：失败一律交 null，让 parse.js 推算开学日并写进 warnings，绝不因为它挂掉就导不进课表
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

    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（xsxx 学生信息之类）一律不带出
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];
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

    if (onLoginPage()) throw new Error(ON_LOGIN);
    var prefix = prefixOf();
    if (prefix === null) throw new Error(NOT_IN_JW);

    return currentTerm(prefix).then(function (term) {
        return fetchTimetable(prefix, term).then(function (json) {
            // 只交出白名单字段；响应里夹带的学生信息（xsxx 等）一律不带出
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            return optionalJson(jwUrl(prefix, 'xskbcxZccx_cxZcByXnxq.html', GNMKDM_CALENDAR), termBody(term))
                .then(function (calendar) {
                    return JSON.stringify({
                        term: {
                            xnm: term.xnm,
                            xqm: term.xqm,
                            xnmText: term.xnmText,
                            xqmText: term.xqmText
                        },
                        today: localTodayIso(),
                        qsxqj: json.qsxqj === undefined ? null : json.qsxqj,
                        raw: { kbList: rows, sjkList: practice },
                        total: totalOf(json),
                        calendar: calendar
                    });
                });
        });
    });
})()
