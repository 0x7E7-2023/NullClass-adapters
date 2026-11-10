(function () {
    // 南京邮电大学教务适配器（正方教务 V9，WebVPN 根相对路径）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 NJUPT/njupt_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 kemi-20）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 b54f40c
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗让用户选学年与学期：上游先拉课表首页读 #xnm / #xqm 的选项，再弹两个选择框。
    //      这里直接读页面上的 #xnm / #xqm（标了 selected 的那项优先），页面上读不到才去取一次课表首页；
    //      两个下拉框都没标 selected 时取第一项，并把「不是用户选中的那一项」交给 parse.js 写成提醒。
    //      要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ③ 地址用根相对路径（上游 getNjuptApiBasePath 返回空串）：南邮 WebVPN 会拦截并改写根相对请求，
    //      传已经带前缀的完整地址会被二次改写成「当前页面.htm/kbcx/...」。所以这里也不拼 origin，照上游写 ''
    //   ④ 当前页必须是教务的 /kbcx/ 或 /xtgl/ 路径（上游同一判断）；否则不发任何请求，直接给大白话提示
    //   ⑤ 只取数：排课行（kbList）只带 kcmc / xm / cdmc / xqj / jcs / zcd 六个字段，集中实践课（sjkList）只带课名；
    //      响应里夹带的 xsxx（学号、姓名、学院等）一律不带走；周次、节次解析与课程合并全部挪到 parse.js
    //   ⑥ 不请求节次时间：上游只有一张写死的 12 节表（NJUPT_TIME_SLOTS），没有作息接口；
    //      这里同样不请求，节次时间用 parse.js 里逐节照抄的那张表，交出去的数据里也没有 periodTimes
    //   ⑦ 请求头统一带 Content-Type、X-Requested-With 与 Accept（上游课表请求只带 Content-Type，校历请求才带另外两个）；
    //      课表与校历的请求体与上游逐字一致（xnm / xqm，课表另带 kzlx=ck / xsdm= / kclbdm=），值经 encodeURIComponent
    //   ⑧ 上游的开场弹窗、学年学期选择框、saveImportedCourses / saveCourseConfig / savePresetTimeSlots、
    //      showToast / notifyTaskCompletion 全部不移植：这些是「拾光」的桥能力，空课由宿主负责保存
    //
    // 取数方式：同源请求，最多三个，全部打在当前教务页面所在的主机上（地址是根相对路径，由 WebVPN 改写）：
    //   ① GET  /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （页面上已有 #xnm / #xqm 时跳过这一步）
    //   ② POST /kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就 null）
    //   ③ POST /kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                      取课表（JSON）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var GNMKDM = 'N2151';
    var GNMKDM_CALENDAR = 'N2154';
    // 上游 getNjuptApiBasePath 的返回值：空串。南邮 WebVPN 会把根相对地址改写成带通道前缀的教务地址，
    // 自己再拼一遍前缀会被二次改写（见上游第 162-170 行）
    var BASE = '';

    function pathOf() {
        return String(window.location.pathname || '');
    }

    // 上游的页面判断：当前地址在教务的 /kbcx/ 或 /xtgl/ 下才取数（智慧校园门户、统一认证页都不算）
    function inTeachingSystem() {
        return /\/(?:kbcx|xtgl)\//.test(pathOf());
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

    // 读一个学年学期字段：正常是下拉框（跳过 value 为空的占位项，标了 selected 的那项优先，没标记就取第一项）；
    // 万一页面把它放在隐藏 input 里，就直接读 value（上游也是读 value 的，隐藏 input 的值就是当前学期）。
    // chosen 记录「这一项是教务明确标出来的」还是我们兜底取的第一项，parse.js 据此说实话
    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options && selectEl.querySelectorAll) options = selectEl.querySelectorAll('option');
        if (!options || !options.length) {
            var raw = String(selectEl.value === null || selectEl.value === undefined ? '' : selectEl.value)
                .replace(/\s+/g, '');
            return raw ? { value: raw, text: '', chosen: true } : null;
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
        var chosen = picked >= 0;
        if (!chosen) picked = 0;
        return { value: list[picked].value, text: list[picked].text, chosen: chosen };
    }

    function readTermFromDoc(doc) {
        if (!doc || !doc.querySelector) return null;
        var year = readSelect(doc.querySelector('#xnm'));
        var season = readSelect(doc.querySelector('#xqm'));
        if (!year || !season) return null;
        return {
            xnm: year.value,
            xqm: season.value,
            xnmText: year.text,
            xqmText: season.text,
            selected: !!(year.chosen && season.chosen)
        };
    }

    function currentTerm() {
        var onPage = readTermFromDoc(window.document);
        if (onPage) return Promise.resolve(onPage);
        if (typeof DOMParser === 'undefined') {
            throw new Error(
                '这个页面里读不到学年学期：请先在教务系统里打开「学生个人课表」，再点「提取课表」'
            );
        }
        return get(BASE + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default')
            .then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开「学生个人课表」后再点「提取课表」'
                    );
                }
                return found;
            });
    }

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，请求体与上游 NJUPT 脚本逐字一致）。
    // 这个接口一次性返回整学期的排课，没有分页参数；响应里带了记录总数时一起交出去对账。
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
        return post(BASE + '/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=' + GNMKDM, body)
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

    // 学期周次校历：不是每个部署都给得出，失败一律交 null，
    // 让 parse.js 回落到推算并写 warnings —— 绝不因为校历取不到就导不进课表。
    function fetchCalendar(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
        return post(BASE + '/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=' + GNMKDM_CALENDAR, body)
            .then(function (text) {
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

    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（学生信息 xsxx 之类）一律不带出
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

    if (!inTeachingSystem()) {
        throw new Error(
            '当前页面不是教务的课表页。请先登录教务系统并进入「学生个人课表」，再点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            return fetchCalendar(term).then(function (calendar) {
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText,
                        selected: term.selected
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
