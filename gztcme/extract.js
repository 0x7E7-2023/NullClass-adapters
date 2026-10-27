(function () {
    // 贵州机电职业技术学院教务适配器（正方新版 jwglxt）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 GZTCME/gztcme.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Panda君）
    //   上游快照 e15c627（2026-10-26 拉取）
    //   本校脚本最后一次修改 134bdbc（2026-10-24）
    // 模板：同平台已审计件 zust（读教务节次时间、校历、按校区取数的写法），本校差异如下。
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数、块级声明关键字）
    //   ② 不弹窗让用户选学年与学期、不弹窗选校区：学年学期直接读页面上的 #xnm / #xqm（用户自己切过的学期优先），
    //      页面上没有才去取一次课表首页读同样两个下拉框；要导入别的学期，用户在教务页面里切一下再点「提取课表」。
    //      校区由 parse.js 自动取课数最多的一个（上游：出现多个校区时弹窗让用户选）
    //   ③ 只取数：排课行、未排课课程、各校区节次时间、学期校历交出去；周次、节次、校区时间对比、合并全部挪到 parse.js
    //   ④ 请求路径、方法、请求体照上游：课表、校历、节次时间三个都是 POST 表单（xnm / xqm，课表多 kzlx=ck，节次时间多 xqh_id），
    //      课表与节次时间菜单号 N2151、校历 N2154；校历与节次时间取不到交 null（上游会整次报错，这里降级到推算 / 空课默认节次时间并在提醒里说明）
    //   ⑤ 不再带出学生信息：排课行按字段白名单挑（kcmc / xm / cdmc / xqj / jcs / zcd / xqh_id / xqmc），
    //      未排课课程只留 kcmc，节次时间只留 jcmc / qssj / jssj，校历只留 zs / rq；响应里的 xsxx 只在本文件里比对学年学期，不交出
    //   ⑥ 入口判断照上游 gztcmeCheckPage：当前地址不在 /jwglxt/ 下（门户页、统一认证页等）就给大白话提示，不发请求；
    //      另外停在教务登录页（login_slogin.html）时也提示，不发请求；主机一律由 window.location.origin 拼，不写死
    //
    // 取数方式：同源请求，最多 3 + 校区数个（上限 6 个校区）：
    //   ① GET  /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default   读当前学年学期（已经开在课表页时跳过）
    //   ② POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151      xnm=…&xqm=…&kzlx=ck      取课表（JSON）
    //   ③ POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154   xnm=…&xqm=…           取学期校历（取不到就 null）
    //   ④ POST /jwglxt/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151          xnm=…&xqm=…&xqh_id=…   每个校区取一次节次时间（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    var GNMKDM = 'N2151';
    var CALENDAR_GNMKDM = 'N2154';
    var MAX_CAMPUS = 6;

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 正方新版的上下文路径是 /jwglxt；万一挂在前缀下，跟着当前地址里的那一段走
    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(JWLGXT + '/');
        if (at > 0) return originOf() + path.substring(0, at + JWLGXT.length);
        return originOf() + JWLGXT;
    }

    function onJwPath() {
        return String(window.location.pathname || '').indexOf(JWLGXT + '/') >= 0;
    }

    function onLoginPage() {
        return String(window.location.pathname || '').indexOf('login_slogin.html') >= 0;
    }

    // 响应地址落在登录页 / 统一认证页，或页面标题是登录页，就是登录过期；
    // 要 JSON 的请求却回了一张写着 login_slogin 的网页，也是（上游同样按 login_slogin 判断）
    function looksLikeLogin(url, text, expectJson) {
        var body = String(text || '');
        if (/authserver\/|login_slogin/i.test(String(url || ''))) return true;
        if (/<title[^>]*>\s*(统一身份认证|用户登录)/.test(body)) return true;
        return !!expectJson && /^\s*</.test(body) && body.indexOf('login_slogin') >= 0;
    }

    // method 为 POST 时 body 是已拼好的表单串（上游同样用 application/x-www-form-urlencoded）
    function request(method, url, body, accept, expectJson) {
        var headers = {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': accept
        };
        if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        var options = { method: method, credentials: 'include', headers: headers };
        if (method === 'POST') options.body = body;
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text().then(function (text) {
                if (looksLikeLogin(response.url, text, expectJson)) {
                    throw new Error('登录已过期，请重新登录教务系统，再点「提取课表」');
                }
                return text;
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    function query(params) {
        var parts = [];
        for (var i = 0; i < params.length; i++) {
            parts.push(params[i][0] + '=' + encodeURIComponent(params[i][1]));
        }
        return parts.join('&');
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
                '这个页面里读不到学年学期：请先在教务系统里打开个人课表，再点「提取课表」'
            );
        }
        return request('GET', jwBase() + '/kbcx/xskbcx_cxXskbcxIndex.html?' +
            query([['gnmkdm', GNMKDM], ['layout', 'default']]), null, 'text/html', false)
            .then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
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

    // 课表接口：一次性返回整学期的排课。路径、请求体照上游 gztcmeRunImport 原样
    function fetchTimetable(term) {
        var url = jwBase() + '/kbcx/xskbcx_cxXsgrkb.html?' + query([['gnmkdm', GNMKDM]]);
        var body = query([['xnm', term.xnm], ['xqm', term.xqm], ['kzlx', 'ck']]);
        return request('POST', url, body, 'application/json', true).then(function (text) {
            var json = jsonOf(text);
            if (!json || typeof json !== 'object' || !(json.kbList instanceof Array)) {
                throw new Error(
                    '教务系统没有返回课表数据（返回的内容格式不对）：' +
                    '登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            // 上游要求响应回显的学年学期与所选一致；xsxx 本身不交出，只在这里比对
            var echo = json.xsxx;
            if (echo && typeof echo === 'object') {
                var echoYear = textOf(echo.XNM);
                var echoTerm = textOf(echo.XQM);
                if ((echoYear && echoYear !== textOf(term.xnm)) || (echoTerm && echoTerm !== textOf(term.xqm))) {
                    throw new Error('教务返回的课表不是所选学期的，请重新进入教务系统后再点「提取课表」');
                }
            }
            return json;
        });
    }

    // 附加请求（校历 / 各校区节次时间）：失败一律交 null，让 parse.js 回落并在提醒里说明 —— 绝不因为它们挂掉就导不进课表
    function optionalJson(url, body) {
        return request('POST', url, body, 'application/json', true).then(function (text) {
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

    // 一律先"拆壳"：教务的列表可能是裸数组，也可能套一层（rows / datas / data / list / items / kbList）。
    // 外壳只在这里定义一次，"有没有数据"和"挑字段"共用
    function listIn(value) {
        if (value instanceof Array) return value;
        if (!value || typeof value !== 'object') return [];
        var keys = ['rows', 'datas', 'data', 'list', 'items', 'kbList'];
        for (var i = 0; i < keys.length; i++) {
            if (value[keys[i]] instanceof Array) return value[keys[i]];
        }
        return [];
    }

    function pickFields(row, fields) {
        var out = {};
        if (!row || typeof row !== 'object') return out;
        for (var i = 0; i < fields.length; i++) {
            var value = row[fields[i]];
            if (value === null || value === undefined) continue;
            out[fields[i]] = value;
        }
        return out;
    }

    function pickList(value, fields) {
        var list = listIn(value);
        var out = [];
        for (var i = 0; i < list.length; i++) out.push(pickFields(list[i], fields));
        return out;
    }

    // 排课行按字段白名单挑：parse.js 只用到这八个字段，响应里其余内容（含学生个人信息）一律不带出
    var ROW_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd', 'xqh_id', 'xqmc'];
    var PERIOD_FIELDS = ['jcmc', 'qssj', 'jssj'];
    var CALENDAR_FIELDS = ['zs', 'rq'];

    if (!onJwPath()) {
        throw new Error(
            '当前页面还不是教务系统。请先登录教务系统（jwxt.gztcme.cn），' +
            '打开「个人课表查询」后再点「提取课表」'
        );
    }
    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「个人课表查询」，然后点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            // 只交出排课行与未排课课程；响应里夹带的学生信息（xsxx 等）一律不带出
            var source = json.kbList;
            var rows = [];
            var campusIds = [];
            var seenCampus = {};
            var i;
            for (i = 0; i < source.length; i++) {
                var picked = pickFields(source[i], ROW_FIELDS);
                var id = textOf(picked.xqh_id).replace(/\s+/g, '');
                if (id && !seenCampus['c' + id] && campusIds.length < MAX_CAMPUS) {
                    seenCampus['c' + id] = true;
                    campusIds.push(id);
                }
                rows.push(picked);
            }
            var unscheduled = [];
            if (json.sjkList instanceof Array) {
                for (i = 0; i < json.sjkList.length; i++) {
                    var unscheduledName = textOf((json.sjkList[i] || {}).kcmc);
                    if (unscheduledName) unscheduled.push({ kcmc: unscheduledName });
                }
            }
            var base = jwBase();
            var jobs = [
                optionalJson(base + '/kbcx/xskbcxZccx_cxZcByXnxq.html?' + query([['gnmkdm', CALENDAR_GNMKDM]]),
                    query([['xnm', term.xnm], ['xqm', term.xqm]]))
            ];
            for (i = 0; i < campusIds.length; i++) {
                jobs.push(optionalJson(base + '/kbcx/xskbcx_cxRjc.html?' + query([['gnmkdm', GNMKDM]]),
                    query([['xnm', term.xnm], ['xqm', term.xqm], ['xqh_id', campusIds[i]]])));
            }
            return Promise.all(jobs).then(function (results) {
                var periodTimes = [];
                for (var k = 0; k < campusIds.length; k++) {
                    var slotRows = pickList(results[k + 1], PERIOD_FIELDS);
                    periodTimes.push({ campusId: campusIds[k], rows: slotRows.length ? slotRows : null });
                }
                var calendarRows = pickList(results[0], CALENDAR_FIELDS);
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText
                    },
                    today: localTodayIso(),
                    raw: { kbList: rows, sjkList: unscheduled },
                    total: totalOf(json),
                    periodTimes: periodTimes,
                    calendar: calendarRows.length ? calendarRows : null
                });
            });
        });
    });
})()
