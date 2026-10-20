(function () {
    // 广西医科大学教务适配器（乘方智慧教务，jwxt.gxmu.edu.cn）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 GXMU/gxmu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf
    // 平台是乘方「智慧教务」：整学期课表走 POST /new/student/xsgrkb/getCalendarWeekDatas（返回 {code:0, data:[…]}）。
    // 同平台的上游脚本还有 SHXY / SDIPCT / CMC / LIT / NENU / HNSF，请求写法大同小异；本件只交本校。
    // 登录入口是统一认证门户（cas.gxmu.edu.cn），用户登录后从门户进入教务系统（jwxt.gxmu.edu.cn），在教务页面里点「提取课表」。
    //
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数、展开与块级声明关键字）；
    //   ② 不弹窗问学年和学期：上游用 showPrompt 让用户输入起始学年、再用 showSingleSelection 选学期，拼出 xnxqdm。
    //      这里按顺序取学期代码：当前页面上有 #xnxqdm 下拉框就取它选中的那一项（用户在页面里切到哪个学期，导入的就是哪个）；
    //      没有就 GET 一次课表页 week.page 读同一个下拉框的默认项；再读不到才按当前日期推算（学期代码照上游的 学年起始年 + 01/02）。
    //      只有取到的学期一门课都没有时，才用 __ncSelect 问一次要导入哪个学期；
    //   ③ 只取数：上游的拼课程（mapCourseRecord / transformSchedule）、去重、写节次时间表全部挪到 parse.js（CI 里跑得到的那一段）；
    //      教务行只交 parse.js 用得到的七个字段，行里夹带的其它内容一律不带；
    //   ④ 上游没有的两个附加请求（都取不到就交 null，不影响主流程）：课表页 week.page（读学期下拉框）和
    //      /new/xlxx/getDatesOfWeek（第 1 周的日期，同平台的 CMC 脚本用它取开学日）。上游不存开学日，
    //      有了它 parse.js 才能少猜一次；
    //   ⑤ 上游把请求地址写死成 https://jwxt.gxmu.edu.cn/…（绝对地址）。这里改成同源相对路径，协议跟随用户当前打开的页面，
    //      并在提取前确认当前主机就是教务主机，停在统一认证门户或别的站点上不发请求，提示先从门户进入教务系统；
    //   ⑥ 登录页（页面里有密码输入框，或路径含 login / lyuapServer）不发请求，直接给大白话提示；只判断输入框是否存在，不读它的值。
    //      上游用整条地址（含查询串）判断，统一认证页的 service 参数里带着教务自己的地址，会误判，这里只看路径；
    //   ⑦ 上游报错只弹一句「网络请求失败」，这里区分「没登录 / 登录失效」「教务返回错误（代码 N）」「没有这个学期的课」，都是大白话。
    //
    // 取数方式：同源请求，最多三个（地址都是相对路径，只会打在用户当前打开的教务主机上）：
    //   ① GET  /new/student/xsgrkb/week.page                读学期下拉框（当前页面已有下拉框时跳过）
    //   ② POST /new/student/xsgrkb/getCalendarWeekDatas      取整学期课表，请求体与上游一致：
    //                                                       xnxqdm=<学年起始年 4 位 + 学期 2 位>&zc=&d1=<本周一>&d2=<本周日>
    //   ③ POST /new/xlxx/getDatesOfWeek                      取第 1 周的日期（取不到就 null）；请求体 xnxqdm=…&zc=1
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ term: { code, label, source }, today, rows: [七个白名单字段], dates }
    //   term.source —— page（页面上选中的）/ default（教务课表页的默认项）/ auto（按日期推算）/ user（取不到课后用户改选的）
    //   dates       —— getDatesOfWeek 的结果，只留 xqmc 与 rq 两个字段；取不到交 null
    var HOST = 'jwxt.gxmu.edu.cn';
    var PAGE_PATH = '/new/student/xsgrkb/week.page';
    var COURSE_PATH = '/new/student/xsgrkb/getCalendarWeekDatas';
    var DATES_PATH = '/new/xlxx/getDatesOfWeek';
    var LOGIN_HINT = '请先在页面里登录教务系统，确认能看到你的课表后，再点「提取课表」';
    var PORTAL_HINT = '当前打开的不是教务系统页面。请先登录学校门户，再从门户进入智慧教务系统，确认能看到你的课表后，再点「提取课表」';
    var MAX_BODY = 4000000;       // 课表响应超过 4M 字符就不认（多半是登录页 HTML）
    var MAX_DATES_BODY = 200000;  // 开学日期响应超过这个长度就不认
    var MAX_DATE_ROWS = 20;       // 开学日期响应最多留几行
    var MAX_CANDIDATES = 8;       // 取不到课时给用户改选的学期个数
    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（学号、姓名等个人信息）一律不带出
    var ROW_FIELDS = ['kcmc', 'teaxms', 'jxcdmc', 'zc', 'xq', 'ps', 'pe'];

    function pad2(value) {
        return (value < 10 ? '0' : '') + value;
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
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

    // 学期代码 = 学年起始年份 4 位 + 学期号 2 位（01 第一学期 / 02 第二学期 / 03 短学期）。与 parse.js 的 termName 同口径（只用于提问的选项文字）
    function termNameOf(code) {
        var m = /^(\d{4})(\d{2})$/.exec(String(code));
        if (!m) return String(code);
        var suffix = m[2] === '01' ? '第一学期' : (m[2] === '02' ? '第二学期' : (m[2] === '03' ? '短学期' : m[2] + ' 学期'));
        return m[1] + '-' + (parseInt(m[1], 10) + 1) + '学年' + suffix;
    }

    // 按当前日期推算学期：8 月 – 次年 1 月是秋季（<当年>01，1 月算上一学年），2 – 7 月是春季（<去年>02）。
    function currentTermCode(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        if (month >= 8) return year + '01';
        if (month <= 1) return (year - 1) + '01';
        return (year - 1) + '02';
    }

    function previousTermCode(code) {
        var m = /^(\d{4})(\d{2})$/.exec(String(code));
        if (!m) return null;
        var year = parseInt(m[1], 10);
        var no = parseInt(m[2], 10);
        if (no > 1) return year + '0' + (no - 1);
        return (year - 1) + '03';
    }

    function derivedCandidates() {
        var list = [];
        var walk = currentTermCode(new Date());
        for (var i = 0; i < 6 && walk; i++) {
            list.push({ value: walk, label: termNameOf(walk) });
            walk = previousTermCode(walk);
        }
        return list;
    }

    // 页面上的学期下拉框 #xnxqdm（同平台的 CMC / LIT / NENU 脚本都是读它）：
    // 只认 value 是 6 位数字的项；被 selected 标的那项优先，没有就第一项。读不到返回 null。
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
            if (!/^[0-9]{6}$/.test(value)) continue;
            if (nodes[i].selected === true && picked < 0) picked = options.length;
            if (nodes[i].hasAttribute && nodes[i].hasAttribute('selected') && marked < 0) marked = options.length;
            options.push({ value: value, label: textOf(nodes[i].textContent).substring(0, 60) });
        }
        if (!options.length) return null;
        if (picked < 0) picked = marked;
        if (picked < 0) picked = 0;
        return { selected: options[picked], options: options };
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

    // 课表页：读学期下拉框。取不到（网络、404、改版）交 null，退回按日期推算；页面是登录页则直接报错
    function fetchTermSelect() {
        if (typeof DOMParser === 'undefined') return Promise.resolve(null);
        return fetch(PAGE_PATH, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                if (hasLoginForm(doc)) {
                    throw new Error('登录已失效，请重新登录。' + LOGIN_HINT);
                }
                return readTermSelect(doc);
            });
        }, function () {
            return null;
        });
    }

    // 学期来源：页面上选中的 → 课表页默认项 → 按日期推算
    function findTerm() {
        var here = readTermSelect(document);
        if (here) {
            return Promise.resolve({ code: here.selected.value, label: here.selected.label, source: 'page', options: here.options });
        }
        return fetchTermSelect().then(function (found) {
            if (found) {
                return { code: found.selected.value, label: found.selected.label, source: 'default', options: found.options };
            }
            var code = currentTermCode(new Date());
            return { code: code, label: '', source: 'auto', options: null };
        });
    }

    // 上游请求体里的参考周：d1 = 本周一、d2 = 本周日（00:00:00），zc 留空 = 整学期。
    // 算法与上游一字不差（含周日时 getDay() 为 0、d1 落在下周一这一点）：d1 / d2 只是参考，zc 为空时服务端返回全学期
    function weekDateText(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' 00:00:00';
    }

    function courseBody(code) {
        var today = new Date();
        var startOfWeek = new Date(today.getTime());
        startOfWeek.setDate(today.getDate() - today.getDay() + 1);
        var endOfWeek = new Date(startOfWeek.getTime());
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        return 'xnxqdm=' + encodeURIComponent(code) + '&zc=&d1=' + encodeURIComponent(weekDateText(startOfWeek)) +
            '&d2=' + encodeURIComponent(weekDateText(endOfWeek));
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
                throw new Error('教务系统没有返回课表数据（代码 ' + textOf(json.code) + '）。' + LOGIN_HINT);
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

    // 第 1 周的日期（开学日）：同平台的 CMC 脚本用这个接口。这所学校上不一定有，任何失败都交 null，不影响主流程。
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

    function gather(code) {
        return Promise.all([fetchRows(code), fetchDates(code)]).then(function (result) {
            return { code: code, rows: result[0], dates: result[1] };
        });
    }

    function askBridgeReady() {
        return typeof __ncCapabilities !== 'undefined' && __ncCapabilities && __ncCapabilities.ask && typeof __ncSelect === 'function';
    }

    // 取到的学期一门课都没有时，问用户要导入哪个学期。桥不在、用户取消、提问报错都交 null，退回「没有课」的报错
    function askTerm(candidates) {
        if (!askBridgeReady() || candidates.length < 2) return Promise.resolve(null);
        var items = [];
        for (var i = 0; i < candidates.length; i++) items.push(candidates[i].label || termNameOf(candidates[i].value));
        return Promise.resolve().then(function () {
            return __ncSelect({
                title: '选择要导入的学期',
                message: '当前学期里没有取到课表。请选择你要导入的学期：',
                items: items,
                defaultIndex: 0
            });
        }).then(function (index) {
            if (typeof index !== 'number' || index < 0 || index >= candidates.length) return null;
            return index;
        }, function () {
            return null;
        });
    }

    function finish(label, result, source) {
        if (!result.rows.length) {
            throw new Error(
                '教务系统里「' + (label || termNameOf(result.code)) + '」没有取到课表数据：可能是该学期课表还没发布，' +
                '也可能学期不对。请在教务页面里确认能查到你的课表后再点「提取课表」。'
            );
        }
        return JSON.stringify({
            term: { code: result.code, label: label, source: source },
            today: todayIso(),
            rows: result.rows,
            dates: result.dates
        });
    }

    var hostName = String(window.location.hostname || '').toLowerCase();
    var pathName = String(window.location.pathname || '');
    if (hasLoginForm(document) || /login|lyuapServer/i.test(pathName)) {
        throw new Error('当前打开的是登录页。' + LOGIN_HINT);
    }
    if (hostName !== HOST) {
        throw new Error(PORTAL_HINT);
    }

    return findTerm().then(function (term) {
        return gather(term.code).then(function (first) {
            if (first.rows.length > 0) return finish(term.label, first, term.source);
            var candidates = [{ value: term.code, label: term.label }];
            var pool = term.options || derivedCandidates();
            for (var i = 0; i < pool.length && candidates.length < MAX_CANDIDATES; i++) {
                if (pool[i].value !== term.code) candidates.push(pool[i]);
            }
            return askTerm(candidates).then(function (index) {
                if (index === null || index === 0) return finish(term.label, first, term.source);
                return gather(candidates[index].value).then(function (second) {
                    return finish(candidates[index].label, second, 'user');
                });
            });
        });
    });
})()
