(function () {
    // 临沂大学教务适配器（正方教务 V9，jwglxt，经学校 WebVPN 访问）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 LYU/lyu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 7c9e1907635cb1c2d481b316e6f52d69dc77edff（2026-10-27 拉取）
    //   本校脚本最后一次修改 80e30cf5990f1166210b8af6b72bed71667232ca（2026-09-23，仓库整理提交，脚本内容更早）
    // 移植改动（逐条对应 AUDIT.md「移植改动」）：
    //   ① 不弹窗选学年学期：上游先弹两个选择框（选项取自课表页的 #xnm / #xqm），这里直接读页面上当前选中的学年学期；
    //      页面上没有才取一次课表首页，读同样两个下拉框（上游也是读这两个下拉框，只是中间多了一步选择）
    //   ② 不在教务的 /jwglxt/ 课表页上取数（登录页、门户页、统一认证页都在别的路径下）：直接给一句大白话提示，不发请求
    //   ③ 请求地址与参数照上游逐字保留：根路径 /jwglxt/... 加 enlink-vpn 参数，不按 WebVPN 路径前缀改写（理由见 AUDIT.md）
    //   ④ 只取数：排课行只带 kcmc / xm / cdmc / xqj / jcs / zcd 六个字段，校历只带周次与日期字段，响应里其它字段一律不带出
    //   ⑤ 学期周次校历（N2154）上游本来就取，照旧（同样按裸数组读）；取不到交 null，parse.js 推算开学日并在提醒里说明
    //   ⑥ 请求头统一带 Content-Type、X-Requested-With、Accept（上游课表请求只带 Content-Type），
    //      参数值经 encodeURIComponent，数字不变
    //   ⑦ 上游的开场弹窗、进度提示、saveImportedCourses / saveCourseConfig 等「拾光」桥能力全部不移植，适配器只交载荷
    //
    // 取数方式：同源请求，最多三个，地址与上游逐字一致（只打在当前教务主机上）：
    //   ① GET  /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&enlink-vpn  读当前学年学期（页面上已有下拉框时跳过）
    //   ② POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151&enlink-vpn       取课表（JSON）
    //   ③ POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154&enlink-vpn 取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var INDEX_URL = '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&enlink-vpn';
    var COURSE_URL = '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151&enlink-vpn';
    var CALENDAR_URL = '/jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154&enlink-vpn';

    // 只在教务的 /jwglxt/ 页面上取数；登录页（login_slogin.html）、门户页、统一认证页都不在这个路径下，不发请求
    function onSchoolPage() {
        var path = String(window.location.pathname || '');
        return path.indexOf('/jwglxt/') >= 0 && path.indexOf('login_slogin.html') < 0;
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
    // 没标记就取第一项，与上游一致）；万一页面把它放在隐藏 input 里，就直接读 value
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
        return get(INDEX_URL).then(function (html) {
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

    // 课表接口：POST 表单，参数与上游逐字一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=）。
    // 一次性返回整学期的排课；万一响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(termBody) {
        return post(COURSE_URL, termBody + '&kzlx=ck&xsdm=&kclbdm=').then(function (text) {
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

    // 校历接口取不到不影响课表：失败一律交 null，让 parse.js 推算开学日并在提醒里说明，绝不因为它挂掉就导不进课表
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

    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（学生信息等）一律不带出
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];

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

    // 校历与上游一样按裸数组读（不是数组就当没取到）；只留开学日与周次字段，其它字段一律不带出
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'rq', 'zcrq', 'zrq', 'ksrq'];

    function calendarOf(json) {
        return Array.isArray(json) ? pickFields(json, CALENDAR_FIELDS) : null;
    }

    if (!onSchoolPage()) {
        throw new Error(
            '当前页面不是教务系统的课表页（可能是登录页、门户页或统一认证页）。' +
            '请先登录教务系统，打开「信息查询 - 学生课表查询」，再点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
        return Promise.all([
            fetchTimetable(termBody),
            optionalJson(CALENDAR_URL, termBody)
        ]).then(function (parts) {
            var json = parts[0];
            return JSON.stringify({
                term: {
                    xnm: term.xnm,
                    xqm: term.xqm,
                    xnmText: term.xnmText,
                    xqmText: term.xqmText
                },
                today: localTodayIso(),
                raw: { kbList: pickFields(json.kbList, KB_FIELDS) },
                total: totalOf(json),
                calendar: calendarOf(parts[1])
            });
        });
    });
})()
