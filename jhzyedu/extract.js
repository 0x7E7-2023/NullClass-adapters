(function () {
    // 江西航空职业技术学院教务适配器（正方教务 V9 平台）—— 第一步：只取数，把教务的原始数据里解析要用的字段交出去。
    //
    // 移植自 shiguang_warehouse 的 JHZYEDU/zhengfang.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 JN）
    //   上游快照 ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    // 移植改动：
    //   ⓪ 本校是根路径部署（上游请求直接是 /kbcx/…，没有 /xtgl、/jwglxt 之类的前缀）：
    //      地址前缀不再硬拼任何固定路径，只跟当前页面地址里 /xtgl/ 或 /kbcx/ 之前的那一段走（正常为空）
    //   ① ES6 → ES5（异步改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗问「学年 + 第几学期」：上游要用户手填起始学年（默认今年）再选第一/第二学期，
    //      这里直接读页面上的 #xnm / #xqm（用户自己切过的学期优先），页面上没有才去取一次
    //      课表首页读同样两个下拉框 —— 上游本来也要把学年学期换算成 xnm / xqm 代号，
    //      这里只是不再打断用户（移植手册 §3 第 1 步：自动取当前学期；要别的学期，
    //      用户在教务页面里切一下再点「提取课表」）
    //   ③ 只取数：排课行（kbList）、集中实践课（sjkList）、校区作息、学期周次校历交出去，每行只留解析要用的字段；
    //      周次解析、节次解析与课程合并全部挪到 parse.js（CI 里跑得到的那一段）
    //   ④ 多取两个同模块的只读接口：校区作息与学期周次校历（上游本校脚本只请求课表一条，作息是写死的表；
    //      这两条取自同族正方脚本：作息路径与菜单号照 WENHUA/wenhua_01.js、NBUT/nbut.js，周次校历路径与菜单号 N2154
    //      照 GDOU/gdouyj.js 等 27 份正方脚本）。正方这两个接口不是每个部署都装了菜单，
    //      取不到就交 null，parse.js 会回落到推算与内置作息表，并在 warnings 里如实说明
    //   ⑤ 不再带出学生信息：每类只留解析要用的字段（课表行 6 个、实践课 2 个、作息 4 个、校历 6 个），
    //      课表响应里夹带的 xsxx 之类一律不带走，也不进 fixture
    //
    // 取数方式：同源请求，最多四个，全部打在本校教务主机上（地址都由 window.location.origin 拼出来，
    // 不写死主机名；路径都是根路径，前缀见 jwBase）：
    //   ① GET  /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （已经开在课表页时跳过这一步）
    //   ② POST /kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON）
    //   ③ POST /kbcx/xskbcx_cxRjc.html?gnmkdm=N2151                         取校区作息（取不到就 null）
    //   ④ POST /kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 本校是根路径部署，上下文路径为空（说明：本校不是 /jwglxt 部署，所以这里不拼任何固定前缀）。
    // 万一挂在网关前缀下，当前地址里 /xtgl/ 或 /kbcx/ 之前的那一段就是前缀，原样跟着走；都找不到就直接用 origin
    function jwBase() {
        var path = String(window.location.pathname || '');
        var marks = ['/xtgl/', '/kbcx/'];
        var at = -1;
        for (var i = 0; i < marks.length; i++) {
            var hit = path.indexOf(marks[i]);
            if (hit >= 0 && (at < 0 || hit < at)) at = hit;
        }
        return at >= 0 ? originOf() + path.substring(0, at) : originOf();
    }

    // 本适配器的登录页判断是移植时加的：上游 JHZYEDU/zhengfang.js 没有判断登录页的代码，只有提示文字：开场提示（第 116 行，本适配器已删去）和两处报错提示（第 183、187 行）。当前地址是登录页就直接报错，省得发一次注定失败的请求
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

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，参数照上游 JHZYEDU 脚本原样）。
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

    // 附加接口（校区作息 / 学期周次校历）：不是每个部署都有这两个菜单，失败一律交 null，
    // 让 parse.js 回落到推算与内置作息表并在 warnings 里说明 —— 绝不因为附加接口挂掉就导不进课表。
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

    // 只留解析要用的字段（约束 5）：响应里夹带的学生个人信息不进载荷，也就不会被带出 extract.js
    var COURSE_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];
    var PRACTICE_FIELDS = ['kcmc', 'zcd'];
    var PERIOD_FIELDS = ['jc', 'jcmc', 'qssj', 'jssj'];
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'zrq', 'zcrq', 'rq', 'ksrq'];

    function keepFields(list, keys) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var kept = {};
            for (var k = 0; k < keys.length; k++) {
                if (row[keys[k]] !== undefined) kept[keys[k]] = row[keys[k]];
            }
            out.push(kept);
        }
        return out;
    }

    // 作息与校历的返回可能是裸数组，也可能套一层信封；找法与 parse.js 的 rowsIn 一致，找不到就是空数组
    function rowsOf(value) {
        if (Array.isArray(value)) return value;
        if (!value || typeof value !== 'object') return [];
        var keys = ['rows', 'datas', 'data', 'list', 'items', 'kbList'];
        var i;
        for (i = 0; i < keys.length; i++) {
            var known = rowsOf(value[keys[i]]);
            if (known.length) return known;
        }
        for (var key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            var found = rowsOf(value[key]);
            if (found.length) return found;
        }
        return [];
    }

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            // 校区编号要从原始行里取（载荷根上的 campusId 要用）；之后每类只留解析要用的字段（见上面的 *_FIELDS），响应里夹带的学生信息（xsxx 等）一律不带出
            var rows = json.kbList;
            var practice = json.sjkList instanceof Array ? json.sjkList : [];
            var campusId = '';
            for (var i = 0; i < rows.length; i++) {
                var id = textOf((rows[i] || {}).xqh_id).replace(/\s+/g, '');
                if (id) { campusId = id; break; }
            }
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return Promise.all([
                // 菜单号照上游同族正方脚本的实际写法：作息挂课表菜单 N2151、周次校历挂 N2154
                optionalJson(jwBase() + '/kbcx/xskbcx_cxRjc.html?gnmkdm=' + GNMKDM,
                    termBody + '&xqh_id=' + encodeURIComponent(campusId)),
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
                    raw: { kbList: keepFields(rows, COURSE_FIELDS), sjkList: keepFields(practice, PRACTICE_FIELDS) },
                    total: totalOf(json),
                    periodTimes: extras[0] === null ? null : keepFields(rowsOf(extras[0]), PERIOD_FIELDS),
                    calendar: extras[1] === null ? null : keepFields(rowsOf(extras[1]), CALENDAR_FIELDS)
                });
            });
        });
    });
})()
