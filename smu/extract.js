(function () {
    // 南方医科大学教务适配器（乘方智慧教务新版，zhjw.smu.edu.cn）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SMU/smu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 NekoJackie）
    //   上游快照 7c9e1907635cb1c2d481b316e6f52d69dc77edff（2026-10-27 拉取）
    //   本校脚本最后一次修改 78c4b31
    // 平台是乘方「智慧教务」新版：整学期课表走 POST /new/student/xsgrkb/getCalendarWeekDatas（返回 {code:0, data:[…]}），
    // 校历走 POST /new/xlxx/data。模板选同平台已审计的 gxmu（取数的返回形状与错误分支沿用），取数路径与请求体按本校上游改。
    //
    // 移植改动（逐条对应 AUDIT.md §3、§4）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数、展开与块级声明关键字）；
    //   ② 不弹窗选学期：上游用 showSingleSelection 让用户从学期列表里选（默认是被 selected 标的那项）。
    //      这里取当前页面上 #xnxqdm 下拉框选中的那一项（用户在页面里切到哪个学期，导入的就是哪个）；
    //      当前页面没有下拉框就 GET 一次课表页 week.page 读同一个下拉框的默认项；再不行 GET 一次上游读学期列表的 xlxxlist.page 读它的默认项；
    //      都读不到就报错，不凭日期猜学期代码（教务的学期代码是它自己的值）；
    //   ③ 只取数：上游的拼课程、周次 / 教室拆分、校区节次时间、自定义时间、合并全部挪到 parse.js（CI 里跑得到的那一段）；
    //      教务行只交 parse.js 用得到的十一个字段，行里夹带的其它内容（学号、姓名等）一律不带出；
    //   ④ 校历：上游用 xlxx/data 的日期推开学日与总周数。这里把校历压成 [{zc, rq}]（周次 + 日期，只留这两个字段），
    //      计算全放 parse.js；校历取不到交 null，parse 推算并写进 warnings；
    //   ⑤ 上游请求地址写死成 https://zhjw.smu.edu.cn/…（绝对地址）。这里改成同源相对路径，协议跟随用户当前打开的页面，
    //      并在提取前确认当前主机就是教务主机，停在统一认证门户或别的站点上不发请求，提示先从门户进入教务系统；
    //   ⑥ 登录页（页面里有密码输入框，或路径含 login / authserver / cas）不发请求，直接给大白话提示；只判断输入框是否存在，不读它的值；
    //   ⑦ 上游报错只弹一句「网络请求失败」，这里区分「没登录 / 登录失效」「教务返回错误（代码 N）」「没有这个学期的课」，都是大白话；
    //   ⑧ 上游的拾光界面调用（showToast / showAlert / showSingleSelection / savePresetTimeSlots / saveCourseConfig /
    //      saveImportedCourses / notifyTaskCompletion）与「教务导入说明」弹窗全部不移植：空课由宿主负责保存，适配器只交载荷。
    //
    // 取数方式：同源请求，最多四个（地址都是相对路径，只会打在用户当前打开的教务主机 zhjw.smu.edu.cn 上）：
    //   ① GET  /new/student/xsgrkb/week.page              读学期下拉框（当前页面已有下拉框时跳过）
    //   ② GET  /new/student/xlxx/xlxxlist.page            ①也读不到时再读一次学期下拉框（上游读学期列表的页面）
    //   ③ POST /new/student/xsgrkb/getCalendarWeekDatas   取整学期课表，请求体与上游一致：xnxqdm=<学期代码>
    //   ④ POST /new/xlxx/data                             取校历（取不到就交 null）；请求体 xnxqdm=<学期代码>
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ term: { code, label, source }, today, rows: [十一个白名单字段], calendar: [{zc, rq}] 或 null }
    //   term.source —— page（页面上选中的）/ default（教务页面里的默认项）
    var HOST = 'zhjw.smu.edu.cn';
    var TERM_PAGE_PATH = '/new/student/xsgrkb/week.page';
    var TERM_LIST_PATH = '/new/student/xlxx/xlxxlist.page';
    var COURSE_PATH = '/new/student/xsgrkb/getCalendarWeekDatas';
    var CALENDAR_PATH = '/new/xlxx/data';
    var LOGIN_HINT = '请先在页面里登录教务系统，确认能看到你的课表后，再点「提取课表」';
    var PORTAL_HINT = '当前打开的不是教务系统页面。请先登录学校门户，再进入教务系统，确认能看到你的课表后，再点「提取课表」';
    var MAX_PAGE = 3000000;        // 课表页 / 学期列表页源码超过 3M 字符就不认
    var MAX_BODY = 4000000;        // 课表响应超过 4M 字符就不认（多半是登录页 HTML）
    var MAX_CALENDAR_BODY = 1000000;  // 校历响应超过 1M 字符就不认
    var MAX_CALENDAR_ROWS = 600;   // 校历最多留几条（周 × 日）
    var MAX_FIELD_TEXT = 1000;     // 单个字段最多留 1000 字（教室周次串最长的也远不到）
    // 行字段白名单：parse.js 只读这十一个字段。响应里其它字段（学号、姓名、人员 ID 等个人信息）一律不带出
    var ROW_FIELDS = ['kcmc', 'teaxms', 'jxcdmc', 'jxcdmc2', 'xq', 'zc', 'ps', 'pe', 'kkxqdm', 'qssj', 'jssj'];

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

    // 读一个页面里的学期下拉框（课表页或学期列表页）。取不到（网络、非 2xx、没有下拉框）交 null；页面是登录页则直接报错
    function fetchTermSelect(path) {
        if (typeof DOMParser === 'undefined') return Promise.resolve(null);
        return fetch(path, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (html) {
                var source = String(html);
                if (source.length > MAX_PAGE) return null;
                var doc = new DOMParser().parseFromString(source, 'text/html');
                if (hasLoginForm(doc)) {
                    throw new Error('登录已失效，请重新登录。' + LOGIN_HINT);
                }
                return readTermSelect(doc);
            });
        }, function () {
            return null;
        });
    }

    // 学期来源：当前页面的下拉框 → 课表页的默认项 → 学期列表页的默认项。三处都读不到就报错
    function findTerm() {
        var here = readTermSelect(window.document);
        if (here) {
            return Promise.resolve({ code: here.value, label: here.label, source: 'page' });
        }
        return fetchTermSelect(TERM_PAGE_PATH).then(function (found) {
            if (found) return { code: found.value, label: found.label, source: 'default' };
            return fetchTermSelect(TERM_LIST_PATH).then(function (listed) {
                if (listed) return { code: listed.value, label: listed.label, source: 'default' };
                throw new Error(
                    '没读到当前学期：登录状态可能已失效，或教务系统改了页面。' +
                    '请重新登录并打开课表页面后再点「提取课表」'
                );
            });
        });
    }

    // 取整学期课表。请求体与上游一致：只有 xnxqdm 一项。返回行数组（只含白名单字段）
    function fetchRows(code) {
        return request(COURSE_PATH, 'POST', 'xnxqdm=' + encodeURIComponent(code)).then(function (response) {
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
                    var value = src[ROW_FIELDS[j]];
                    if (value === undefined || value === null) continue;
                    kept[ROW_FIELDS[j]] = textOf(value).substring(0, MAX_FIELD_TEXT);
                }
                rows.push(kept);
            }
            return rows;
        });
    }

    // 校历（取不到就是 null，不影响主流程）。响应 {code:0, data:[月块…]}：月块是行数组，行首格 type 为 zc 的是周次，
    // 其余 type 为 day 的格 fullText 是日期。压成 [{zc, rq}]：每个有日期的格一条；整周没有日期的也留一条（rq 为空串），
    // 这样总周数仍然能从周次里看出来。只留这两个字段。
    function fetchCalendar(code) {
        return request(CALENDAR_PATH, 'POST', 'xnxqdm=' + encodeURIComponent(code)).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (body) {
                var json = jsonOrNull(body, MAX_CALENDAR_BODY);
                if (!json || typeof json !== 'object' || json.code !== 0 || !(json.data instanceof Array)) return null;
                var out = [];
                for (var m = 0; m < json.data.length && out.length < MAX_CALENDAR_ROWS; m++) {
                    var block = json.data[m];
                    if (!(block instanceof Array)) continue;
                    for (var r = 0; r < block.length && out.length < MAX_CALENDAR_ROWS; r++) {
                        var line = block[r];
                        if (!(line instanceof Array) || line.length === 0 || !line[0] || line[0].type !== 'zc') continue;
                        var week = textOf(line[0].value).substring(0, 10);
                        var dated = 0;
                        for (var c = 1; c < line.length && out.length < MAX_CALENDAR_ROWS; c++) {
                            var cell = line[c];
                            if (!cell || cell.type !== 'day' || !cell.fullText) continue;
                            out.push({ zc: week, rq: textOf(cell.fullText).substring(0, 30) });
                            dated++;
                        }
                        if (!dated) out.push({ zc: week, rq: '' });
                    }
                }
                return out;
            });
        }, function () {
            return null;
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

    return findTerm().then(function (term) {
        return Promise.all([fetchRows(term.code), fetchCalendar(term.code)]).then(function (result) {
            if (!result[0].length) {
                throw new Error(
                    '教务系统里「' + (term.label || term.code) + '」没有取到课表数据：可能是该学期课表还没发布，' +
                    '也可能学期不对。请在教务页面里切换到有课的学期，确认能查到你的课表后再点「提取课表」。'
                );
            }
            return JSON.stringify({
                term: { code: term.code, label: term.label, source: term.source },
                today: todayIso(),
                rows: result[0],
                calendar: result[1]
            });
        });
    });
})()
