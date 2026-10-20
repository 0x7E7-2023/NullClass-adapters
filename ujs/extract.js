(function () {
    // 江苏大学教务适配器（正方教务新版，根路径部署，校内直连或经学校 WebVPN 的路径前缀访问）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 UJS/ujs_zhengfang_v9.0.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 洛初 Github@gongfuture）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf（2026-09-23；整个 UJS 目录最近一次改动是 4d7b1cc，那次只加了研究生脚本）
    // 移植改动（逐条对应 AUDIT.md §4）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗让用户选学年与学期：上游先弹开场提示，再弹学年、学期两个选择框（选项取自课表页的 #xnm / #xqm 下拉框，
    //      学期文本只有「1」「2」），这里直接读页面上的 #xnm / #xqm（被 selected 标的那项优先，没有就第一项）；
    //      页面上没有才去取一次课表首页读同样两个下拉框。要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ③ 主机不写死：上游的 buildApiUrl 用 window.location.origin 加 WebVPN 前缀（路径以 /http/<十六进制> 开头）拼地址，这里同样只打当前页面所在的主机；
    //      前缀取当前路径里 /kbcx/ 或 /xtgl/ 之前的那一段（直连为空，WebVPN 下是 /http/<十六进制>）。上游不带 vpn-… 查询串，这里也不带
    //   ④ 登录页与门户页不发请求：路径以 /sso/jziotlogin 结尾（上游 isLoginPage，直连与 WebVPN 两种入口都认）、或是 login_slogin.html、
    //      统一认证路径（/cas/、/authserver/）的，提示「请先登录」；路径里找不到 /kbcx/ 或 /xtgl/ 的（门户、WebVPN 首页）提示先进入教务系统，都不发请求
    //   ⑤ 夏令时 / 冬令时：上游弹「智能选择 / 夏令时 / 冬令时」再弹「是否更改」。这里不提问：parse.js 按 today（今天的日期）所在的季节自动选当季那张节次时间表
    //      （规则同上游 whetherSummerTimeSlot：4 月 7 日起至 10 月 7 日前为夏令时），另一季的差异与换季日期写进 warnings
    //   ⑥ 只取数：排课行（kbList）、集中实践课（sjkList）与每周起始日交出去（排课行只带白名单字段，见 ⑦）；
    //      周次解析、节次解析与课程合并全部挪到 parse.js（CI 里跑得到的那一段）。学期周次校历照上游取，也只留 parse.js 读的字段
    //   ⑦ 不再带出学生信息：排课行只带 kcmc / xm / cdmc / xqj / jcs / zcd 与备注用的 cxbjmc / xkbz，
    //      实践课只带 kcmc / qsjsz（课名与起止周，上游弹窗里列的就是它们；教师 jsxm 不带）；课表响应里夹带的学号、姓名、学院等一律不带走，也不进 fixture
    //   ⑧ 不请求节次时间：上游没有请求教务的节次时间接口，节次时间全部写死（按教学楼与夏 / 冬令时挑），这里同样不请求，节次时间放在 parse.js 里
    //   ⑨ 每周起始日：课表响应顶层的 qsxqj（1=周一…7=周日）原样交出，parse.js 按移植手册 §4.3 回退开学日
    //   ⑩ 本校教务页面加载的 zftal 脚本会改写 Array.prototype.filter / some / every（回调实参颠倒，上游为此自己写了 arrayFilter）：
    //      本文件不调用这三个方法，也不调用 trim（去首尾空白用正则），数组一律用普通 for 循环
    //   ⑪ 请求头：每个请求统一带 Content-Type、X-Requested-With 与 Accept；课表请求体与上游一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），
    //      参数值经 encodeURIComponent，数字不变。上游取课表首页的地址是 ?gnmkdm=N2151（没有 layout=default），这里照抄
    //
    // 取数方式：同源请求，最多三个（地址都由当前地址拼出来，不写死主机名与端口）：
    //   ① GET  <前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151        读当前学年学期（页面上已有 #xnm / #xqm 时跳过这一步）
    //   ② POST <前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151             取课表（JSON）
    //   ③ POST <前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154       取学期周次校历（取不到就 null）
    // 其中 <前缀> = 当前地址的 origin + /kbcx/ 或 /xtgl/ 之前的路径（直连为空，WebVPN 为 /http/<十六进制>）。
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';
    var GNMKDM_CALENDAR = 'N2154';

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

    // 去首尾空白、内部空白压成一个空格（不用 trim：教务页面的脚本会改写原型方法）
    function squeeze(value) {
        return asText(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    // 教务的路径前缀：当前路径里最早出现的 /kbcx/ 或 /xtgl/ 之前的那一段（WebVPN 下是 /http/<十六进制>，直连为空）。
    // 两个都没有（还停在门户、WebVPN 首页）返回 null，此时不发任何请求
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

    // 登录页：上游 isLoginPage 按路径结尾 /sso/jziotlogin 判断（直连与 WebVPN 都是）；另加正方自己的登录页与统一认证路径
    function onLoginPage() {
        var path = pathOf();
        var tail = '/sso/jziotlogin';
        if (path.length >= tail.length && path.substring(path.length - tail.length) === tail) return true;
        return path.indexOf('login_slogin.html') >= 0 || path.indexOf('/cas/') >= 0 || path.indexOf('/authserver/') >= 0;
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

    // 读一个学年学期字段：正常是下拉框（跳过 value 为空的占位项，被 selected 标记的那项优先，
    // 没标记就取第一项）；万一页面把它放在隐藏 input 里，就直接读 value（上游也是读 value 的）
    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options && selectEl.querySelectorAll) options = selectEl.querySelectorAll('option');
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
        return get(jwUrl(prefix, 'xskbcx_cxXskbcxIndex.html', GNMKDM))
            .then(function (html) {
                var doc = new DOMParser().parseFromString(asText(html), 'text/html');
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

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，参数照上游 UJS 脚本原样，带 kclbdm=）。
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

    // 附加接口（学期周次校历）：失败一律交 null，让 parse.js 推算开学日并在 warnings 里说明 —— 绝不因为它挂掉就导不进课表
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
    // cxbjmc（重修标记）与 xkbz（选课备注）只进课程备注；实践课的 qsjsz 是起止周（课程信息，不含个人信息）
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd', 'cxbjmc', 'xkbz'];
    var PRACTICE_FIELDS = ['kcmc', 'qsjsz'];

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

    // 校历也只交 parse.js 读的字段（裸数组，或套一层信封的数组）；其它一律不带出。
    // 信封的键与 parse.js 的 rowsIn 同一份口径
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
            '当前打开的是登录页。请先登录，再进入教务系统、打开「学生课表查询」，然后点「提取课表」'
        );
    }
    var prefix = prefixOf();
    if (prefix === null) {
        throw new Error(
            '请先登录并进入教务系统、打开「学生课表查询」后再点「提取课表」'
        );
    }

    return currentTerm(prefix).then(function (term) {
        return fetchTimetable(prefix, term).then(function (json) {
            // 只交出白名单字段；响应里夹带的学生信息（xsxx 等）一律不带出
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return optionalJson(jwUrl(prefix, 'xskbcxZccx_cxZcByXnxq.html', GNMKDM_CALENDAR), termBody)
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
                        calendar: slimRows(calendar, CALENDAR_FIELDS)
                    });
                });
        });
    });
})()
