(function () {
    // 广东技术师范大学教务适配器（正方教务 V9，jwglxt）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 GPNU/gpnu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 moondish）
    //   上游快照 03d161a（仓库当前版本；公共说明写的 7c9e190 更早，本脚本在两处之间没有再改）
    //   本校脚本最后一次修改 80e30cf（2026-09-23）
    // 移植改动：
    //   ① ES6 写法改成 ES5（异步改成 then 链，去掉模板串、箭头函数与块级声明）
    //   ② 不弹窗问学年、学期、总周数和开学日：读页面上的学年学期字段（用户自己切过的优先），
    //      页面上没有才取一次课表首页读同样两个下拉框。要导入别的学期，在教务页面里切一下再点「提取课表」
    //   ③ 三个校区的节次时间不一样，教务数据里又看不出校区。只问一次选哪套节次时间；
    //      提问桥不在或用户取消时交空，由第二步按东校区 / 西校区 / 北校区并提醒
    //   ④ 只取数：排课行与集中实践课只带白名单字段；周次、节次、合并都在第二步
    //   ⑤ 不带出学生信息：排课行只留课名、教师、教室、星期、节次、周次；实践课只留课名
    //   ⑥ 上游把主机写死。这里用当前页面的源拼同源地址，并且只在广东技术师范大学这台教务主机上发请求
    //   ⑦ 登录页、统一认证页和其它网站上不发请求，直接提示
    //   ⑧ 课表请求体与上游一致（含课程类型参数，值为空）；周次校历请求体只有学年与学期
    //
    // 取数方式：同源请求，最多三个，全部打在当前教务主机上：
    //   ① GET  /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （已经开在带学年学期的课表页时跳过）
    //   ② POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表
    //   ③ POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就空）
    // 登录全程由用户在页面里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    var GNMKDM = 'N2151';
    var SCHOOL_HOST = 'jwglxt.gpnu.edu.cn';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(JWLGXT + '/');
        if (at > 0) return originOf() + path.substring(0, at + JWLGXT.length);
        return originOf() + JWLGXT;
    }

    // 登录页、统一认证、以及不是这台教务主机的页面：不发请求
    function onBlockedPage() {
        var host = String(window.location.hostname || '');
        var path = String(window.location.pathname || '');
        if (host !== SCHOOL_HOST) return true;
        if (path.indexOf('login') >= 0) return true;
        if (path.indexOf('/sso/') >= 0) return true;
        return false;
    }

    function looksLikeLogin(url, text) {
        var blob = String(url || '') + '\n' + String(text || '');
        return /authserver\/|login_slogin|lyiotlogin|\/sso\//i.test(blob) ||
            /<title[^>]*>\s*统一身份认证/.test(String(text || '')) ||
            /用户登录|统一身份认证/.test(String(text || ''));
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
                return { url: response.url, text: text };
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
        return { xnm: year.value, xqm: season.value, xnmText: year.text, xqmText: season.text };
    }

    function currentTerm() {
        var onPage = readTermFromDoc(window.document);
        if (onPage) return Promise.resolve(onPage);
        if (typeof DOMParser === 'undefined') {
            throw new Error(
                '这个页面里读不到学年学期：请先在教务系统里打开个人课表，再点「提取课表」'
            );
        }
        return get(jwBase() + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default')
            .then(function (got) {
                if (looksLikeLogin(got.url, got.text)) {
                    throw new Error('登录已过期，请重新登录教务系统，再点「提取课表」');
                }
                var doc = new DOMParser().parseFromString(String(got.text), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开个人课表后再点「提取课表」'
                    );
                }
                return found;
            });
    }

    function fetchTimetable(term) {
        var body = 'gnmkdm=' + encodeURIComponent(GNMKDM) +
            '&xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=&kclxdm=';
        return post(jwBase() + '/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=' + GNMKDM, body)
            .then(function (got) {
                var notJson = !/^\s*[\[{]/.test(got.text);
                if (looksLikeLogin(got.url, got.text) || (notJson && /login|登录/.test(got.text))) {
                    throw new Error('登录已过期，请重新登录教务系统，再点「提取课表」');
                }
                var json = jsonOf(got.text);
                if (!json || typeof json !== 'object' || !(json.kbList instanceof Array)) {
                    throw new Error(
                        '教务系统没有返回课表数据（返回的内容格式不对）：' +
                        '登录状态可能已失效，请重新登录后再点「提取课表」'
                    );
                }
                return json;
            });
    }

    function optionalJson(url, body) {
        return post(url, body).then(function (got) {
            if (looksLikeLogin(got.url, got.text)) return null;
            return jsonOf(got.text);
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

    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];
    var PRACTICE_FIELDS = ['kcmc'];
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'rq', 'zcrq', 'ksrq', 'zrq'];

    function pickRow(row, fields) {
        var kept = {};
        var source = row || {};
        for (var j = 0; j < fields.length; j++) {
            if (source[fields[j]] !== undefined) kept[fields[j]] = source[fields[j]];
        }
        return kept;
    }

    function pickFields(list, fields) {
        var out = [];
        for (var i = 0; i < list.length; i++) out.push(pickRow(list[i], fields));
        return out;
    }

    // 校历可能是裸数组，也可能套一层。外壳只定义这一次，挑字段共用
    function listIn(value) {
        if (value instanceof Array) return value;
        if (!value || typeof value !== 'object') return [];
        var keys = ['rows', 'datas', 'data', 'list', 'items', 'kbList'];
        for (var i = 0; i < keys.length; i++) {
            if (value[keys[i]] instanceof Array) return value[keys[i]];
        }
        return [];
    }

    // 校区判断不了，又会改每节课的上课时间，所以问一次。桥不在或取消都交空，不挡住导入
    function askTimetable() {
        if (typeof __ncCapabilities === 'undefined' || !__ncCapabilities || !__ncCapabilities.ask) {
            return Promise.resolve(null);
        }
        if (typeof __ncSelect !== 'function') return Promise.resolve(null);
        return __ncSelect({
            title: '选择节次时间',
            message: '三个校区的节次时间不一样，选错会让上课时间整体偏掉。请按你上课的校区选一种。',
            items: [
                '东校区 / 西校区 / 北校区（第 1 节 08:20，第 5 节 13:30）',
                '白云校区（第 1 节 08:30，第 5 节 13:30）',
                '河源校区（第 1 节 08:20，第 5 节 13:50）'
            ],
            defaultIndex: 0
        }).then(function (index) {
            if (typeof index !== 'number' || index < 0 || index > 2) return null;
            return index;
        }, function () {
            return null;
        });
    }

    if (onBlockedPage()) {
        throw new Error(
            '当前页面还不是课表页。请先登录广东技术师范大学教务系统，打开个人课表后再点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return Promise.all([
                optionalJson(jwBase() + '/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154', termBody),
                askTimetable()
            ]).then(function (extras) {
                var picked = extras[1];
                var calendarRows = pickFields(listIn(extras[0]), CALENDAR_FIELDS);
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText
                    },
                    today: localTodayIso(),
                    timetable: picked,
                    timetableSource: picked === null || picked === undefined ? 'default' : 'ask',
                    raw: { kbList: rows, sjkList: practice },
                    total: totalOf(json),
                    calendar: calendarRows.length ? calendarRows : null
                });
            });
        });
    });
})()
