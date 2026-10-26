(function () {
    // 东北师范大学教务适配器（乘方智慧教务新版，bkjx.nenu.edu.cn）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 NENU/NENU_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 dezige131）
    //   上游快照 e15c6274ac347c9642da890504651a9b4e374391（2026-10-26 拉取）
    //   本校脚本最后一次修改 80e30cf
    // 平台是乘方「智慧教务」新版：整学期课表走 POST /new/student/xsgrkb/getCalendarWeekDatas（返回 {code:0, data:[…]}），
    // 节次时间写在课表页 week.page 的页面源码里（var businessHours = $.parseJSON('[…]')）。模板选同平台已审计的 gxmu。
    //
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数、展开、for...of、Set 与块级声明关键字）；
    //   ② 不弹窗选学期：上游 GET week.page 后用 showSingleSelection 让用户选学期（默认是被 selected 标的那项）。
    //      这里先看当前页面有没有 #xnxqdm 下拉框，有就取它选中的那一项（用户在页面里切到哪个学期，导入的就是哪个）；
    //      没有就 GET 一次 week.page 读同一个下拉框的默认项；再读不到才报错（学期代码是教务自己的值，不能凭日期猜）；
    //   ③ 只取数：上游的拼课程、节次分类、去重、自定义时间（第 13、14 节中午课）全部挪到 parse.js（CI 里跑得到的那一段）；
    //      教务行只交 parse.js 用得到的七个字段（kcmc / teaxms / jxcdmc / xq / zc / ps / pe），节次时间只交 jcdm / qssj / jssj，
    //      行里夹带的其它内容一律不带出；
    //   ④ 节次时间：上游只用 week.page 源码里的 businessHours，没有就整个导入失败；这里取不到交 null，由 parse.js 回落空课默认节次并提醒。
    //      页面上已有全局 businessHours 数组时直接读，不再重复请求；
    //   ⑤ 上游没有的附加请求（取不到就交 null，不影响主流程）：POST /new/xlxx/getDatesOfWeek 取第 1 周日期当开学日
    //      （同平台的 gxmu / hnsf 在用）。上游不存开学日，有了它 parse.js 才能少猜一次；
    //   ⑥ 登录页（页面里有密码输入框，或路径含 login / cas / authserver）与非教务主机的页面不发请求，直接给大白话提示；
    //      只判断输入框是否存在，不读它的值；
    //   ⑦ 上游报错只弹一句「获取课表失败」，这里区分「没登录 / 登录失效」「教务返回错误（代码 N）」「没有这个学期的课」，都是大白话；
    //   ⑧ 上游的拾光界面调用（showToast / showSingleSelection / showAlert / saveCourseConfig / savePresetTimeSlots /
    //      saveImportedCourses / notifyTaskCompletion）与浏览器测试分支（prompt / alert / 控制台输出）全部不移植。
    //
    // 取数方式：同源请求，最多三个（地址都是相对路径，只会打在用户当前打开的教务主机 bkjx.nenu.edu.cn 上）：
    //   ① GET  /new/student/xsgrkb/week.page                读学期下拉框与节次时间（页面上已有下拉框和 businessHours 时跳过）
    //   ② POST /new/student/xsgrkb/getCalendarWeekDatas      取整学期课表，请求体与上游逐字一致：
    //                                                       xnxqdm=<学期>&zc=&d1=2020-01-01 00:00:00&d2=2030-01-01 00:00:00
    //   ③ POST /new/xlxx/getDatesOfWeek                      取第 1 周的日期（取不到就 null）；请求体 xnxqdm=…&zc=1
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ term: { code, label, source }, today, rows: [七个白名单字段], hours, dates }
    //   term.source —— page（页面上选中的）/ default（教务课表页的默认项）
    //   hours       —— businessHours 的 jcdm / qssj / jssj 三个字段；取不到交 null
    //   dates       —— getDatesOfWeek 的结果，只留 xqmc 与 rq 两个字段；取不到交 null
    var HOST = 'bkjx.nenu.edu.cn';
    var PAGE_PATH = '/new/student/xsgrkb/week.page';
    var COURSE_PATH = '/new/student/xsgrkb/getCalendarWeekDatas';
    var DATES_PATH = '/new/xlxx/getDatesOfWeek';
    var LOGIN_HINT = '请先在页面里登录教务系统，确认能看到你的课表后，再点「提取课表」';
    var PORTAL_HINT = '当前打开的不是教务系统页面。请先登录学校门户，再进入教务系统，确认能看到你的课表后，再点「提取课表」';
    var MAX_PAGE = 3000000;       // 课表页源码超过 3M 字符就不认
    var MAX_BODY = 4000000;       // 课表响应超过 4M 字符就不认（多半是登录页 HTML）
    var MAX_DATES_BODY = 200000;  // 开学日期响应超过这个长度就不认
    var MAX_DATE_ROWS = 20;       // 开学日期响应最多留几行
    var MAX_HOUR_ROWS = 60;       // 节次时间最多留几行
    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（学号、姓名等个人信息）一律不带出
    var ROW_FIELDS = ['kcmc', 'teaxms', 'jxcdmc', 'xq', 'zc', 'ps', 'pe'];

    function pad2(value) {
        return (value < 10 ? '0' : '') + value;
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function jsonOrNull(body, maxLength) {
        if (typeof body !== 'string' || body.length === 0 || body.length > maxLength) return null;
        try {
            return JSON.parse(body);
        } catch (e) {
            return null;
        }
    }

    // 节次时间（businessHours）的外壳只在这里定义一次：数组，每项取 jcdm / qssj / jssj。页面全局和页面源码两个来源共用
    function hoursOf(list) {
        if (!(list instanceof Array)) return null;
        var out = [];
        for (var i = 0; i < list.length && out.length < MAX_HOUR_ROWS; i++) {
            var item = list[i];
            if (!item || typeof item !== 'object') continue;
            out.push({
                jcdm: textOf(item.jcdm).substring(0, 10),
                qssj: textOf(item.qssj).substring(0, 20),
                jssj: textOf(item.jssj).substring(0, 20)
            });
        }
        return out.length ? out : null;
    }

    // 从课表页源码里抠 businessHours：上游的写法是 var businessHours = $.parseJSON('[…]');，另认直接写数组的写法
    function hoursFromSource(html) {
        var m = /var\s+businessHours\s*=\s*\$\.parseJSON\(\s*'(\[.*?\])'\s*\)/.exec(html) ||
            /var\s+businessHours\s*=\s*(\[.*?\])\s*;/.exec(html);
        if (!m) return null;
        return hoursOf(jsonOrNull(m[1], MAX_PAGE));
    }

    // 学期代码是教务自己的值（上游原样拼进请求体），不要求固定位数；只认非空、只含字母数字与 _ - 的短字符串
    function termCodeOk(code) {
        return /^[A-Za-z0-9_-]{1,20}$/.test(code);
    }

    // 页面上的学期下拉框 #xnxqdm：被 selected 标的那项优先，没有就第一项。读不到返回 null。
    function readTermSelect(doc) {
        if (!doc || !doc.getElementById) return null;
        var select = doc.getElementById('xnxqdm');
        if (!select || !select.getElementsByTagName) return null;
        var nodes = select.getElementsByTagName('option');
        var options = [];
        var picked = -1;      // selected 属性值为 true 的项（用户在页面里切换后也准确）
        var marked = -1;      // 只有 selected 标记的项（属性值读不出来时的后备）
        for (var i = 0; i < nodes.length; i++) {
            var value = textOf(nodes[i].value).replace(/\s+/g, '');
            if (!termCodeOk(value)) continue;
            if (nodes[i].selected === true && picked < 0) picked = options.length;
            if (nodes[i].hasAttribute && nodes[i].hasAttribute('selected') && marked < 0) marked = options.length;
            options.push({ value: value, label: textOf(nodes[i].textContent).substring(0, 60) });
        }
        if (!options.length) return null;
        if (picked < 0) picked = marked;
        if (picked < 0) picked = 0;
        return options[picked];
    }

    function hasLoginForm(doc) {
        return !!(doc && doc.querySelector && doc.querySelector('input[type="password"]'));
    }

    function request(path, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/javascript, */*; q=0.01'
            }
        };
        if (typeof body === 'string') options.body = body;
        return fetch(path, options);
    }

    // 课表页：读学期下拉框与节次时间。取不到（网络、404、改版）交 null；页面是登录页则直接报错
    function fetchPage() {
        if (typeof DOMParser === 'undefined') return Promise.resolve(null);
        return fetch(PAGE_PATH, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (html) {
                var source = String(html);
                if (source.length > MAX_PAGE) return null;
                var doc = new DOMParser().parseFromString(source, 'text/html');
                if (hasLoginForm(doc)) {
                    throw new Error('登录已失效，请重新登录。' + LOGIN_HINT);
                }
                return { term: readTermSelect(doc), hours: hoursFromSource(source) };
            });
        }, function () {
            return null;
        });
    }

    // 学期与节次时间：页面上选中的学期 + 页面全局的 businessHours；缺哪样就 GET 一次课表页补
    function findContext() {
        var here = readTermSelect(window.document);
        var globalHours = hoursOf(window.businessHours);
        if (here && globalHours) {
            return Promise.resolve({ term: here, source: 'page', hours: globalHours });
        }
        return fetchPage().then(function (found) {
            var term = here || (found && found.term) || null;
            if (!term) {
                throw new Error(
                    '没读到当前学期：登录状态可能已失效，或教务系统改了课表页。' +
                    '请重新登录并打开课表页面后再点「提取课表」'
                );
            }
            return {
                term: term,
                source: here ? 'page' : 'default',
                hours: globalHours || (found && found.hours) || null
            };
        });
    }

    // 请求体与上游逐字一致：zc 留空 = 整学期，d1 / d2 是一个很宽的日期范围
    function courseBody(code) {
        return 'xnxqdm=' + encodeURIComponent(code) + '&zc=&d1=' + encodeURIComponent('2020-01-01 00:00:00') +
            '&d2=' + encodeURIComponent('2030-01-01 00:00:00');
    }

    // 取整学期课表。返回行数组（只含白名单字段）
    function fetchRows(code) {
        return request(COURSE_PATH, 'POST', courseBody(code)).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('教务系统拒绝访问（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效。' + LOGIN_HINT);
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        }).then(function (body) {
            var json = jsonOrNull(body, MAX_BODY);
            if (!json || typeof json !== 'object' || !(json.data instanceof Array)) {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效。' + LOGIN_HINT);
            }
            if (json.code !== 0 && json.code !== '0') {
                throw new Error('教务系统没有返回课表数据（代码 ' + textOf(json.code).substring(0, 20) + '）。' + LOGIN_HINT);
            }
            var rows = [];
            for (var i = 0; i < json.data.length; i++) {
                var src = json.data[i] || {};
                var kept = {};
                for (var j = 0; j < ROW_FIELDS.length; j++) {
                    if (src[ROW_FIELDS[j]] !== undefined && src[ROW_FIELDS[j]] !== null) kept[ROW_FIELDS[j]] = src[ROW_FIELDS[j]];
                }
                rows.push(kept);
            }
            return rows;
        });
    }

    // 第 1 周的日期（开学日）：这个接口在这所学校上不一定有，任何失败都交 null，不影响主流程。
    // 响应是 [{xqmc: "1", rq: "2026-08-31", …}, …]（xqmc = 星期几），只留 xqmc 与 rq。
    function fetchDates(code) {
        return request(DATES_PATH, 'POST', 'xnxqdm=' + encodeURIComponent(code) + '&zc=1').then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (body) {
                var json = jsonOrNull(body, MAX_DATES_BODY);
                var list = json instanceof Array ? json : (json && json.data instanceof Array ? json.data : null);
                if (!list) return null;
                var out = [];
                for (var i = 0; i < list.length && out.length < MAX_DATE_ROWS; i++) {
                    var item = list[i] || {};
                    out.push({ xqmc: textOf(item.xqmc).substring(0, 10), rq: textOf(item.rq).substring(0, 30) });
                }
                return out;
            });
        }).then(function (value) { return value; }, function () { return null; });
    }

    var hostName = String(window.location.hostname || '').toLowerCase();
    var pathName = String(window.location.pathname || '');
    if (hasLoginForm(document) || /login|authserver|(^|[^a-z0-9])cas([^a-z0-9]|$)/i.test(pathName)) {
        throw new Error('当前打开的是登录页。' + LOGIN_HINT);
    }
    if (hostName !== HOST) {
        throw new Error(PORTAL_HINT);
    }

    return findContext().then(function (context) {
        var code = context.term.value;
        return Promise.all([fetchRows(code), fetchDates(code)]).then(function (result) {
            if (!result[0].length) {
                throw new Error(
                    '教务系统里「' + (context.term.label || code) + '」没有取到课表数据：可能是该学期课表还没发布，' +
                    '也可能学期不对。请在教务页面里切换到有课的学期，确认能查到你的课表后再点「提取课表」。'
                );
            }
            return JSON.stringify({
                term: { code: code, label: context.term.label, source: context.source },
                today: todayIso(),
                rows: result[0],
                hours: context.hours,
                dates: result[1]
            });
        });
    });
})()
