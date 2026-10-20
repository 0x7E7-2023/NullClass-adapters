(function () {
    // 浙江万里学院教务适配器（正方新版 jwglxt；门户登录后进入教务，门户与教务不在同一主机）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 ZWU/zwu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19）
    //   本校脚本最后一次修改 bdb97ca（2026-10-14）
    // 移植改动（逐条对应 AUDIT.md 第 6 节）：
    //   ① 不弹窗让用户选学年与学期：上游用 fetchAcademicOptions 加 showSingleSelection；这里直接读页面上的 #xnm / #xqm
    //      （被 selected 标的那项优先，没有就取第一项），页面上读不到才去取一次课表页 HTML 读同样两个下拉框。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ② 只取数：排课行（kbList）、集中实践课（sjkList）、学期周次校历、今天的日期交出去；
    //      周次解析、节次解析、课程合并与节次时间全部挪到 parse.js（CI 里跑得到的那一段）
    //   ③ 不请求节次时间：上游注释写明「不再请求教务作息接口，作息时间由内置的冬令时/夏令时方案提供」，本件照做，
    //      冬令时 / 夏令时两张表写在 parse.js 里，由导入当天的月份选用
    //   ④ 地址不写死主机：上游写死 https://jw.zwu.edu.cn/jwglxt；这里一律用 window.location.origin 拼同源地址。
    //      门户主机由 manifest 的 loginUrl 覆盖，教务主机由 allowHosts 覆盖，两者都不必写进代码
    //   ⑤ 门户页 / 登录页判断：页面路径里没有 /jwglxt/ 就还在门户上，提示先进入教务；在 login_slogin.html 上提示先登录。
    //      两种情况都不发请求
    //   ⑥ 课表响应只交白名单字段：kbList 每行只留 kcmc / xm / cdmc / xqj / jcs / zcd，sjkList 只留 kcmc；
    //      响应里夹带的学生信息（xsxx、学号、姓名、学院等）一律不带出
    //   ⑦ 学期周次校历照上游：POST xskbcxZccx_cxZcByXnxq（N2154），请求体 xnm / xqm；取不到交 null，parse.js 推算开学日并写进 warnings
    //   ⑧ 请求头：每个请求统一带 Content-Type、X-Requested-With、Accept；课表请求体与上游逐字一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），
    //      参数值经 encodeURIComponent
    //
    // 取数方式：同源请求，最多三个，全部打在当前教务主机上（地址由 window.location.origin 拼出，不写死主机名）：
    //   ① GET  /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （已经开在课表页时跳过这一步）
    //   ② POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON）
    //   ③ POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    var GNMKDM = 'N2151';
    var CALENDAR_GNMKDM = 'N2154';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 上下文路径固定为 /jwglxt（上游的 BASE_URL 也是它）；主机跟着当前页面的 origin 走
    function jwBase() {
        return originOf() + JWLGXT;
    }

    function currentPath() {
        return String(window.location.pathname || '');
    }

    // 地址里没有 /jwglxt/ 说明还在学校门户上（门户与教务不同主机，门户页没有教务的接口）
    function onPortalPage() {
        return currentPath().indexOf(JWLGXT + '/') < 0;
    }

    // 上游第一步就是「当前 URL 等于登录页就别导」，这里保留同样的判断（少一次注定失败的请求）
    function onLoginPage() {
        return currentPath().indexOf('login_slogin.html') >= 0;
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

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，请求体照上游 ZWU 脚本原样）。
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

    // 校历接口：取不到（非 2xx、网络错误、不是 JSON）一律交 null，让 parse.js 推算开学日并在 warnings 里说明，
    // 绝不因为校历挂掉就导不进课表
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

    // 排课行按字段白名单挑：parse.js 只用到这六个字段，响应里其余内容（含学生个人信息）一律不带出
    var ROW_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];

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

    if (onPortalPage()) {
        throw new Error(
            '请先从学校门户进入教务系统，打开课表页后再点「提取课表」'
        );
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
            var i;
            for (i = 0; i < source.length; i++) rows.push(pickRow(source[i]));
            var practice = [];
            if (json.sjkList instanceof Array) {
                for (i = 0; i < json.sjkList.length; i++) {
                    var practiceName = textOf((json.sjkList[i] || {}).kcmc);
                    if (practiceName) practice.push({ kcmc: practiceName });
                }
            }
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return optionalJson(jwBase() + '/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=' + CALENDAR_GNMKDM, termBody)
                .then(function (calendar) {
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
                        calendar: calendar
                    });
                });
        });
    });
})()
