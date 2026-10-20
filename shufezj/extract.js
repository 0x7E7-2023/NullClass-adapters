(function () {
    // 上海财经大学浙江学院教务适配器（正方教务，jwglxt 根路径部署，无 WebVPN，教务主机与登录页同源）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SHUFEZJ/shufezj.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 ZnonEn）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf（2026-09-23）
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗让用户选学年与学期：上游先弹「请输入起始学年」的输入框，再弹「第 1 / 第 2 学期」的选择框，学期码在 3 与 1、12 与 2 之间换着试。
    //      这里直接读页面上的 #xnm / #xqm（被 selected 标的那项优先，没有就取第一项），页面上没有才去取一次课表首页读同样两个下拉框。
    //      学期码就是下拉框的值，不再换着试（AUDIT 有说明）。要导入别的学期，在教务页面里切一下再点「提取课表」（移植手册 §3 第 1 步）
    //   ③ 地址不写死主机、不带学号：请求全部打在当前页面所在的主机上（window.location.origin），路径前缀取 /kbcx/ 之前那段（本校为空）。
    //      上游从当前地址里读 su（学号）拼进课表地址，这里不照搬：学号不进任何请求，也不进交出去的数据
    //   ④ 课表主备接口，顺序照上游：先 xskbcx_cxXsKb；拿不到非空 kbList（网络错误、非 2xx、不是 JSON、没有 kbList、kbList 为空）再打 xskbcx_cxXsgrkb（同样的请求体）。
    //      交出去的数据带 source 字段（"cxXsKb" / "cxXsgrkb"）说明用的是哪个接口，只给冒烟与审计看，parse.js 不据此分支
    //   ⑤ 只取数：排课行（kbList）、集中实践课（sjkList）交出去（前者只带白名单字段，见 ⑥）；另多取两个附加接口：
    //      节次时间（cxRjc，菜单号 N2151，带 xqh_id 校区）与学期周次校历（cxZcByXnxq，菜单号 N2154）。
    //      取到就用，取不到交 null，parse.js 回落到本校的 13 节表与开学日推算，并在 warnings 里说明。
    //      周次解析、节次解析与课程合并全部放在 parse.js（CI 里跑得到的那一段）
    //   ⑥ 不再带出学生信息：排课行只带 kcmc / xm / cdmc / xqj / jcs / zcd / xqh_id 七个字段，实践课只带 kcmc；
    //      附加接口同样只认顶层数组并按字段白名单挑（节次时间 jcmc / jc / qssj / jssj，校历 zs / zsmc / zrq / zcrq / rq / ksrq），信封对象一律当没取到；
    //      课表响应里夹带的学生信息（xsxx、学号、姓名、学院等）一律不带走
    //   ⑦ 请求头：每个请求统一带 Content-Type、X-Requested-With 与 Accept；课表请求体与上游一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），参数值经 encodeURIComponent，数字不变
    //
    // 取数方式：同源请求，最多五个（地址由 window.location.origin 加上路径前缀拼出来，不写死主机名，也不写死端口）：
    //   ① GET  <前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default   读当前学年学期（已经开在课表页时跳过）
    //   ② POST <前缀>/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151                         取课表（JSON）；拿不到非空 kbList 才走 ③
    //   ③ POST <前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                       课表备用接口（同样的请求体）
    //   ④ POST <前缀>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151                          取节次时间（取不到就 null）
    //   ⑤ POST <前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                 取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 教务的路径前缀：本校是根路径部署，前缀为空。取当前路径里最早出现的 /kbcx/ 或 /xtgl/，前面那一段就是前缀；
    // 两个都没有（还在门户页、没进教务）返回 null，此时不发任何请求
    function prefixOf() {
        var path = String(window.location.pathname || '');
        var at = -1;
        var marks = ['/kbcx/', '/xtgl/'];
        for (var i = 0; i < marks.length; i++) {
            var found = path.indexOf(marks[i]);
            if (found >= 0 && (at < 0 || found < at)) at = found;
        }
        if (at < 0) return null;
        return path.substring(0, at);
    }

    // 拼教务地址：<前缀>/kbcx/<页面>?gnmkdm=…[附加参数]
    function jwUrl(page, menu, extra) {
        return originOf() + prefixOf() + '/kbcx/' + page + '?gnmkdm=' + menu + (extra || '');
    }

    // 登录页 / CAS 统一认证页（路径含 login_slogin.html 或 /cas/，或主机以 ty. 开头）：不发请求，给大白话提示
    function loginHint() {
        var path = String(window.location.pathname || '');
        var host = String(window.location.hostname || '');
        if (path.indexOf('login_slogin.html') >= 0 || path.indexOf('/cas/') >= 0 || /^ty\./.test(host)) {
            return '当前打开的是登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」';
        }
        return '';
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

    // 课表响应的外壳只在这里定义一次：对象且 kbList 是数组（为空也算「是课表响应」，由调用方再看有没有行）
    function isTimetable(json) {
        return !!json && typeof json === 'object' && json.kbList instanceof Array;
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
        return get(jwUrl('xskbcx_cxXskbcxIndex.html', GNMKDM, '&layout=default'))
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

    function notTimetableError() {
        return new Error(
            '教务系统没有返回课表数据（返回的内容格式不对）：' +
            '登录状态可能已失效，请重新登录后再点「提取课表」'
        );
    }

    // 课表：先打主接口 xskbcx_cxXsKb；拿不到非空 kbList（网络错误、非 2xx、不是 JSON、没有 kbList、kbList 为空）就打备用接口
    // xskbcx_cxXsgrkb（同样的请求体，照上游的回落顺序）。备用接口若也拿不到合法的课表外壳：
    // 主接口给的是合法但为空的 kbList，就以它为准（学期确实没排课，交给 parse.js 说明）；否则报大白话错误。
    // 这个接口一次性返回整学期的排课，没有分页参数；万一响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
        var primaryUrl = jwUrl('xskbcx_cxXsKb.html', GNMKDM);
        var backupUrl = jwUrl('xskbcx_cxXsgrkb.html', GNMKDM);

        function fromBackup(emptyJson) {
            return post(backupUrl, body).then(function (text) {
                var json = jsonOf(text);
                if (isTimetable(json)) return { json: json, source: 'cxXsgrkb' };
                if (emptyJson) return { json: emptyJson, source: 'cxXsKb' };
                throw notTimetableError();
            }, function (error) {
                if (emptyJson) return { json: emptyJson, source: 'cxXsKb' };
                throw error;
            });
        }

        return post(primaryUrl, body).then(function (text) {
            var json = jsonOf(text);
            if (isTimetable(json) && json.kbList.length) return { json: json, source: 'cxXsKb' };
            return fromBackup(isTimetable(json) ? json : null);
        }, function () {
            return fromBackup(null);
        });
    }

    // 附加接口（节次时间 / 学期周次校历）：不是每个部署都有这两个菜单，失败一律交 null，
    // 让 parse.js 回落到内置节次时间与推算并在 warnings 里说明 —— 绝不因为附加接口挂掉就导不进课表。
    // 响应只认顶层数组（正方这两个接口就是一行一条的数组），按字段白名单挑；信封对象或非数组一律当没取到
    function optionalRows(url, body, fields) {
        return post(url, body).then(function (text) {
            var json = jsonOf(text);
            return json instanceof Array ? pickFields(json, fields) : null;
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
    // xqh_id 是校区号，只用来拼节次时间请求，不含个人信息
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd', 'xqh_id'];
    var PRACTICE_FIELDS = ['kcmc'];
    // 节次时间行与校历行的白名单（parse.js 只读这些字段）
    var PERIOD_FIELDS = ['jcmc', 'jc', 'qssj', 'jssj'];
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

    var loginMessage = loginHint();
    if (loginMessage) {
        throw new Error(loginMessage);
    }
    if (prefixOf() === null) {
        throw new Error(
            '请先进入教务系统、打开课表页后再点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (picked) {
            var json = picked.json;
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
                // 菜单号照同族正方脚本的实际写法（如 WENHUA/wenhua_01.js）：节次时间挂课表菜单 N2151、周次校历挂 N2154
                optionalRows(jwUrl('xskbcx_cxRjc.html', GNMKDM),
                    termBody + '&xqh_id=' + encodeURIComponent(campusId), PERIOD_FIELDS),
                optionalRows(jwUrl('xskbcxZccx_cxZcByXnxq.html', 'N2154'), termBody, CALENDAR_FIELDS)
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
                    source: picked.source,
                    raw: { kbList: rows, sjkList: practice },
                    total: totalOf(json),
                    periodTimes: extras[0],
                    calendar: extras[1]
                });
            });
        });
    });
})()
