(function () {
    // 吉林化工大学教务适配器（乘方教务新版，jwxt.jluct.edu.cn）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 JLUCT/jluct_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 f83288e（2026-11-24 重新克隆）；本校脚本最后一次修改 f4e81dd（2026-11-18），已用 git log 核对一致
    // 模板：同平台已审计的 lit（乘方教务新版，批次三十七）。取数路径以上游代码为准（任务卡里写的 xlxx/xlxxlist、xsgrkb/get
    // 与上游代码不一致，AUDIT.md 第 0 节有说明）。
    //
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① 不弹窗选学年学期：上游用单选框让用户从学期列表里选。这里先看当前页面有没有学期下拉框 #xnxqdm，
    //      有就取页面上选中的那一项（用户在教务页面里切到哪个学期，导入的就是哪个）；没有就 GET 一次学期列表页，
    //      取它标出的当前学期；列表页也没标就取第一项并在提醒里说清楚；
    //   ② 只取数：上游的拼课、去重、按教室分周次、节次时间与提醒全部挪到 parse.js（CI 里跑得到的那一段）；
    //      教务行只交 parse.js 用得到的字段，行里夹带的学号、姓名等个人信息一律不带出；
    //   ③ 校历：上游 POST 校历接口算开学日与总周数。这里只把「周次 + 日期」的白名单结构交出去，计算放在 parse.js；
    //      校历取不到不影响课表导入（交 null，由 parse.js 按学期推算并提醒）；
    //   ④ 上游的弹窗、toast、saveImportedCourses、savePresetTimeSlots、saveCourseConfig、notifyTaskCompletion 全部不移植；
    //   ⑤ 门户页 / 统一认证页（页面里有密码输入框，或路径含 login / cas / authserver）与非教务主机的页面不发请求，直接给大白话提示。
    //
    // 取数方式：同源请求，最多三个（地址都是相对路径，只会打在用户当前打开的 jwxt.jluct.edu.cn 上）：
    //   ① GET  /new/student/xlxx/xlxxlist.page      仅当当前页面没有学期下拉框时：读列表页的 #xnxqdm（上游同一个地址）
    //   ② POST /new/student/xsgrkb/getCalendarWeekDatas   取整学期课表，请求体与上游一致：xnxqdm=<学期代码>
    //   ③ POST /new/xlxx/data                      取校历（上游同一个地址），请求体：xnxqdm=<学期代码>；失败不影响课表
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ term: { code, label, source }, today, rows: [白名单字段], calendar: { weeks: [{ w, d }] } | null }
    //   term.source —— page（当前页面上选中的）/ default（学期列表页标出的当前学期）/ first（都没标，取第一项）
    //   calendar    —— 只留「周号 + 当周日期字符串」；取不到交 null
    var HOST = 'jwxt.jluct.edu.cn';
    var LIST_PATH = '/new/student/xlxx/xlxxlist.page';
    var COURSE_PATH = '/new/student/xsgrkb/getCalendarWeekDatas';
    var CAL_PATH = '/new/xlxx/data';
    var LOGIN_HINT = '请先在页面里登录教务系统，确认能看到你的课表后，再点「提取课表」';
    var PORTAL_HINT = '当前打开的不是吉林化工大学的教务系统页面。请先登录教务系统，确认能看到你的课表后，再点「提取课表」';
    var NO_TERM_HINT = '没读到当前学期：登录状态可能已失效，或教务系统改了页面。请重新登录并打开教务系统的课表页面后再点「提取课表」';
    var MAX_PAGE = 3000000;     // 页面源码超过 3M 字符就不认
    var MAX_BODY = 4000000;     // 接口响应超过 4M 字符就不认（多半是登录页 HTML）
    var MAX_CAL_WEEKS = 80;     // 校历最多留 80 周（一学期远到不了）
    var ROW_FIELDS = ['kcmc', 'teaxms', 'jxcdmc', 'jxcdmc2', 'xq', 'ps', 'pe', 'zc'];
    var COURSE_HEADERS = { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' };
    var CAL_HEADERS = {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest'
    };

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

    // 学期代码是教务自己的值（上游原样拼进请求体）：只认非空、只含字母数字与 _ - 的短字符串
    function termCodeOk(code) {
        return /^[A-Za-z0-9_-]{1,20}$/.test(code);
    }

    // 学期下拉框 #xnxqdm。live 为真表示就是当前页面：取用户当前看到的那一项（selected 属性）；
    // 否则是别人拉回来的源码：只认源码里明确标了 selected 的项。都没有返回 picked = false（调用方取第一项并提醒）。
    function readTermSelect(doc, live) {
        if (!doc || !doc.getElementById) return null;
        var select = doc.getElementById('xnxqdm');
        if (!select || !select.getElementsByTagName) return null;
        var nodes = select.getElementsByTagName('option');
        var options = [];
        var marked = -1;   // 源码里标了 selected 的项
        var chosen = -1;   // 当前页面上被选中的项
        for (var i = 0; i < nodes.length; i++) {
            var value = textOf(nodes[i].value).replace(/\s+/g, '');
            if (!termCodeOk(value)) continue;
            if (marked < 0 && nodes[i].hasAttribute && nodes[i].hasAttribute('selected')) marked = options.length;
            if (chosen < 0 && nodes[i].selected === true) chosen = options.length;
            options.push({ value: value, label: textOf(nodes[i].textContent).substring(0, 60) });
        }
        if (!options.length) return null;
        if (live) {
            var at = chosen >= 0 ? chosen : 0;
            return { value: options[at].value, label: options[at].label, picked: true };
        }
        if (marked >= 0) return { value: options[marked].value, label: options[marked].label, picked: true };
        return { value: options[0].value, label: options[0].label, picked: false };
    }

    // live：当前页面只认看得见的密码框（学生页常带隐藏的「修改密码」弹窗）；解析出来的页面没有布局，有密码框就算
    function hasLoginForm(doc, live) {
        var list = doc && doc.querySelectorAll ? doc.querySelectorAll('input[type="password"]') : [];
        for (var i = 0; i < list.length; i++) {
            if (!live || list[i].getClientRects().length > 0) return true;
        }
        return false;
    }

    function request(path, method, body, headers) {
        var options = { method: method, credentials: 'include', headers: headers || {} };
        if (typeof body === 'string') options.body = body;
        return fetch(path, options);
    }

    // 学期列表页：读 #xnxqdm。取不到（网络、非 2xx、没有下拉框）交 null；页面是登录页则直接报错
    function fetchListTerm() {
        if (typeof DOMParser === 'undefined') return Promise.resolve(null);
        return request(LIST_PATH, 'GET', null, null).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (html) {
                var source = String(html);
                if (source.length > MAX_PAGE) return null;
                var doc = new DOMParser().parseFromString(source, 'text/html');
                if (hasLoginForm(doc)) {
                    throw new Error('登录已失效，请重新登录。' + LOGIN_HINT);
                }
                return readTermSelect(doc, false);
            });
        }, function () {
            return null;
        });
    }

    // 学期：当前页面上的下拉框优先；没有再问学期列表页
    function findTerm() {
        var here = readTermSelect(window.document, true);
        if (here) return Promise.resolve({ term: here, source: 'page' });
        return fetchListTerm().then(function (found) {
            if (!found) throw new Error(NO_TERM_HINT);
            return { term: found, source: found.picked ? 'default' : 'first' };
        });
    }

    // 校历里的「周号 + 当周日期」：只留这两样，其它字段（若有）一律不带出
    function calendarWeeksOf(blocks) {
        var weeks = [];
        for (var i = 0; i < blocks.length; i++) {
            var block = blocks[i];
            if (!(block instanceof Array)) continue;
            for (var j = 0; j < block.length; j++) {
                var row = block[j];
                if (!(row instanceof Array) || row.length === 0) continue;
                var head = row[0];
                if (!head || head.type !== 'zc') continue;
                var days = [];
                for (var k = 1; k < row.length; k++) {
                    var cell = row[k];
                    if (cell && cell.type === 'day' && cell.fullText) days.push(textOf(cell.fullText).substring(0, 10));
                }
                weeks.push({ w: textOf(head.value).substring(0, 4), d: days });
                if (weeks.length >= MAX_CAL_WEEKS) return weeks;
            }
        }
        return weeks;
    }

    // 校历取不到交 null（课表照常导入，由 parse.js 按学期推算并提醒）
    function fetchCalendar(code) {
        return request(CAL_PATH, 'POST', 'xnxqdm=' + code, CAL_HEADERS).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (body) {
                var json = jsonOrNull(body, MAX_BODY);
                if (!json || typeof json !== 'object' || json.code !== 0 || !(json.data instanceof Array)) return null;
                return { weeks: calendarWeeksOf(json.data) };
            });
        }).then(null, function () {
            return null;
        });
    }

    // 取整学期课表。返回行数组（只含白名单字段）
    function fetchRows(code) {
        return request(COURSE_PATH, 'POST', 'xnxqdm=' + code, COURSE_HEADERS).then(function (response) {
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
            if (!json || typeof json !== 'object') {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效。' + LOGIN_HINT);
            }
            if (json.code !== 0 && json.code !== '0') {
                throw new Error('教务系统没有返回课表数据（代码 ' + textOf(json.code).substring(0, 20) + '）。' + LOGIN_HINT);
            }
            if (!(json.data instanceof Array)) {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效。' + LOGIN_HINT);
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

    var hostName = String(window.location.hostname || '').toLowerCase();
    var pathName = String(window.location.pathname || '');
    if (hasLoginForm(document, true) || /login|authserver|(^|[^a-z0-9])cas([^a-z0-9]|$)/i.test(pathName)) {
        throw new Error('当前打开的是登录页。' + LOGIN_HINT);
    }
    if (hostName !== HOST) {
        throw new Error(PORTAL_HINT);
    }

    return findTerm().then(function (context) {
        var code = context.term.value;
        return fetchRows(code).then(function (rows) {
            if (!rows.length) {
                throw new Error(
                    '教务系统里「' + (context.term.label || code) + '」没有取到课表数据：可能是该学期课表还没发布，' +
                    '也可能学期不对。请在教务页面里切换到有课的学期，确认能查到你的课表后再点「提取课表」。'
                );
            }
            return fetchCalendar(code).then(function (calendar) {
                return JSON.stringify({
                    term: { code: code, label: context.term.label, source: context.source },
                    today: todayIso(),
                    rows: rows,
                    calendar: calendar
                });
            });
        });
    });
})()
