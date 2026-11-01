(function () {
    // 茂名职业技术学院教务适配器（正方教务，部署在网站根上，走 https）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 MMPT/mmpt.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，adapters.yaml 维护者「一颗」）
    //   上游快照 03d161a。本校脚本最后一次修改 80e30cf
    //   （git log 对该文件的最近一次提交；与任务卡一致）
    // 移植改动：
    //   ① ES6 改成 ES5（异步写法改成 then 链；注释里也不写箭头函数、反引号、块级声明关键字）
    //   ② 不弹窗问学年学期。先读当前页的学年、学期下拉；没有再取一次课表首页。首页也没有时按月份推算，并交给下一步提醒
    //   ③ 课表数据里没有校区。用提问桥问一次南校区或北校区。取消或桥不可用时按南校区，并交 campusChosen=false
    //   ④ 不请求节次接口，不请求校历。节次时间在下一步按所选校区套用学校公布的两套时间
    //   ⑤ 地址在网站根上，不加教务上下文路径。课程接口是学生个人课表，不是另一所学校的课表名
    //   ⑥ 只取数：排课行、集中实践课名单、学期、校区选择交出去（只带白名单字段）。周次、节次、合并全部挪到 parse.js
    //   ⑦ 排课行带 kcmc / xm / cdmc / xqj / xqjmc / jcs / jc / zcd（本校上游读 jc，正方多数写 jcs，两个都留）
    //   ⑧ 请求体与上游一致：学年、学期，以及课程类型 ck、空的学生代码与课程类别代码
    //   ⑨ 登录页、单点跳转页，以及不是本校教务主机的页面：只给提示，不发请求。上游用来认页面的另一域名不请求、也不放进允许主机
    //
    // 取数方式：同源请求，地址都由当前页面的源拼出来，不写死协议和主机名：
    //   ① GET  /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default   读当前学年学期（页面上已有下拉时跳过）
    //   ② POST /kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                        取课表
    // 登录全程由用户在页面里手工完成，本脚本不读、不存、不上报任何账号信息。
    // 校区提问在取到课表之后只问一次。

    var GNMKDM = 'N2151';
    var JW_HOST = 'jwc.mmpt.edu.cn';
    var CAMPUS_LABELS = ['南校区', '北校区'];

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === JW_HOST;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '');
        return path.indexOf('login_slogin.html') >= 0 || path.indexOf('/sso/') >= 0;
    }

    function looksLikeLogin(url, text) {
        var href = String(url || '');
        var body = String(text || '');
        if (href.indexOf('login_slogin') >= 0) return true;
        if (body.indexOf('统一身份认证') >= 0) return true;
        if (body.indexOf('用户登录') >= 0 && body.indexOf('密码') >= 0) return true;
        return false;
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
            return response.text().then(function (text) {
                if (looksLikeLogin(response.url, text)) {
                    throw new Error('登录已过期，请重新登录教务系统，再点「提取课表」');
                }
                return text;
            });
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
        return { xnm: year.value, xqm: season.value, xnmText: year.text, xqmText: season.text, inferred: false };
    }

    // 8 月到次年 1 月算第一学期（学期代码 3），2 月到 7 月算第二学期（学期代码 12）。
    // 学年：8 月到 12 月用当年，1 月到 7 月用上一年。只在页面和下拉都没有时用，并标记 inferred。
    function termFromMonth() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var year = now.getFullYear();
        var xnm;
        var xqm;
        var seasonText;
        if (month >= 8) {
            xnm = String(year);
            xqm = '3';
            seasonText = '第一学期';
        } else if (month <= 1) {
            xnm = String(year - 1);
            xqm = '3';
            seasonText = '第一学期';
        } else {
            xnm = String(year - 1);
            xqm = '12';
            seasonText = '第二学期';
        }
        var startYear = parseInt(xnm, 10);
        return {
            xnm: xnm,
            xqm: xqm,
            xnmText: startYear + '-' + (startYear + 1),
            xqmText: seasonText,
            inferred: true
        };
    }

    function currentTerm() {
        var onPage = readTermFromDoc(window.document);
        if (onPage) return Promise.resolve(onPage);
        return get(originOf() + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default')
            .then(function (html) {
                var found = null;
                if (typeof DOMParser !== 'undefined') {
                    var doc = new DOMParser().parseFromString(String(html), 'text/html');
                    found = readTermFromDoc(doc);
                }
                if (found) return found;
                return termFromMonth();
            });
    }

    function termBody(term) {
        return 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
    }

    function fetchTimetable(term) {
        return post(originOf() + '/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=' + GNMKDM, termBody(term))
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

    function askCampus() {
        if (typeof window.__ncSelect !== 'function') return Promise.resolve(null);
        return window.__ncSelect({
            title: '选择上课校区',
            message: '课表里没有写你在哪个校区。南校区和北校区的节次时间不一样，请选一个。取消则按南校区。',
            items: CAMPUS_LABELS,
            defaultIndex: 0
        }).then(function (index) {
            var picked = parseInt(index, 10);
            if (index === null || index === undefined || isNaN(picked)) return null;
            if (picked < 0 || picked >= CAMPUS_LABELS.length) return null;
            return CAMPUS_LABELS[picked];
        }, function () {
            return null;
        });
    }

    function listOf(value) {
        if (value instanceof Array) return value;
        if (value && typeof value === 'object' && value.data instanceof Array) return value.data;
        return null;
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

    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'xqjmc', 'jcs', 'jc', 'zcd'];
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

    if (!onJwHost()) {
        throw new Error(
            '当前打开的不是茂名职业技术学院教务系统。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            return askCampus().then(function (campusName) {
                var chosen = campusName === '南校区' || campusName === '北校区';
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText,
                        inferred: term.inferred === true
                    },
                    today: localTodayIso(),
                    raw: { kbList: rows, sjkList: practice },
                    total: totalOf(json),
                    campus: chosen ? campusName : '南校区',
                    campusChosen: chosen
                });
            });
        });
    });
})()
