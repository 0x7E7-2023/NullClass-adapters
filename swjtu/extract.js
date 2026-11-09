(function () {
    // 西南交通大学（扬华学堂，yhxt.swjtu.edu.cn）教务适配器 —— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SWJTU/swjtu_yhxt.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Weedy233）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-09 与 origin/main 对齐）
    //   本校目录最后一次修改 481949f
    //
    // 移植改动（逐条对应 AUDIT.md §5）：
    //   ① 全部改成 ES5 与 Promise 链；拾光的 showToast / showAlert / saveImportedCourses /
    //      savePresetTimeSlots / notifyTaskCompletion 与全部 console 输出不移植
    //   ② 请求照上游代码：GET 同一个接口，credentials 为 include，Accept / Content-Type / ytoken 三个请求头一字不差
    //   ③ ytoken 从 Cookie 或本地存储读出来，只放进发往本校同源接口的请求头；不交出去、不写进报错、不写进存储
    //   ④ 上游 40 个 classTime / classPlace 定长字段在这里摊平成每门课的 slots；
    //      周次、星期、节次的解析全部放到 parse.js（CI 只能跑 parse.js）
    //   ⑤ 字段白名单：只交课名、两位教师、校区名、每段的原始上课文字与地点；响应里的学号、姓名、其它字段一律不带出
    //   ⑥ 学期不弹窗：从课表页面上的「20xx-20xx学年第x学期」文字读；读不到交空，由 parse.js 按今天的日期推算并在提醒里说明
    //   ⑦ 开学日：接口不给，上游也没取。这里同样不猜，由 parse.js 按学期推算并提醒
    //   ⑧ 上游把「有时间文字但认不出节次」的课静默跳过（只在提示条里说一句条数）；
    //      这里把每门课的原始时间段都交出去，parse.js 逐条计数并写进提醒，不静默丢课
    //
    // 取数方式：同源请求，只有一次，相对路径（只会打在用户当前打开的 yhxt.swjtu.edu.cn 上）：
    //   GET /yethan/common/course-schedule/student-course-schedule
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报账号密码。
    //
    // 输出：{ today, term: { name, year, kind, source }, courses: [{ courseName, staffName, staffNameOther,
    //        campusName, slots: [{ classTime, classPlace }] }] }
    var HOST = 'yhxt.swjtu.edu.cn';
    var API_PATH = '/yethan/common/course-schedule/student-course-schedule';
    var MAX_CLASS_TIME_FIELDS = 40;   // 上游的定长字段数，逐节对照上游代码
    var MAX_BODY = 4000000;           // 响应超过这个长度就不认（多半是登录页 HTML）
    var MAX_PAGE_TEXT = 20000;        // 只在页面正文前这么多字里找学期
    var TOKEN_LIMIT = 4096;           // 正常令牌不会这么长

    var LOGIN_TEXT = '当前打开的是登录页。请先登录西南交通大学扬华学堂，再打开课表页面，然后点「提取课表」';
    var NOT_JW_TEXT = '当前页面不是西南交通大学扬华学堂（yhxt.swjtu.edu.cn）。请先登录并打开课表页面，然后点「提取课表」';
    var NO_LOGIN_TEXT = '没有读到登录状态：请先在页面里登录西南交通大学扬华学堂，再打开课表页面，然后点「提取课表」';
    var NO_DATA_TEXT = '教务系统里当前学期的课表还没有内容：可能课表还没发布。请打开课表页面确认能看到课表后再点「提取课表」';

    var KIND_CN = { first: '一', second: '二', third: '三' };
    var KIND_BY_MARK = { '一': 'first', '1': 'first', '二': 'second', '2': 'second', '三': 'third', '3': 'third' };

    function clean(value) {
        if (value === null || value === undefined) return '';
        var line = String(value).replace(/\s+/g, ' ').trim();
        if (!line || line.toLowerCase() === 'null' || line === '无') return '';
        return line;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。不能用 toISOString：北京时间早上 8 点前它会退到前一天
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // 登录页：有密码框、根路径（不带查询串）、路径里含 login、或有单独的 cas 一段
    function onLoginPage() {
        var loc = window.location;
        var path = String(loc.pathname || '');
        var where = (String(loc.hostname || '') + path).toLowerCase();
        var doc = window.document;
        if (doc && doc.querySelector && doc.querySelector('input[type="password"]')) return true;
        if ((path === '/' || path === '') && !loc.search) return true;
        if (where.indexOf('login') >= 0) return true;
        return /(^|[^a-z0-9])cas([^a-z0-9]|$)/.test(where);
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === HOST;
    }

    function jsonOf(body) {
        try {
            return JSON.parse(String(body));
        } catch (e) {
            return null;
        }
    }

    // ---------- 登录令牌（只用于本校同源请求头，不交出去） ----------
    function cookieValue(name) {
        var parts = String(document.cookie || '').split(';');
        for (var i = 0; i < parts.length; i++) {
            var piece = parts[i];
            var eq = piece.indexOf('=');
            if (eq < 0) continue;
            if (clean(piece.substring(0, eq)) !== name) continue;
            var value = piece.substring(eq + 1);
            try {
                value = decodeURIComponent(value);
            } catch (e) {
                value = '';
            }
            return clean(value);
        }
        return '';
    }

    function storageValue(name) {
        var stores = [];
        try {
            if (window.localStorage) stores.push(window.localStorage);
        } catch (e1) {}
        try {
            if (window.sessionStorage) stores.push(window.sessionStorage);
        } catch (e2) {}
        for (var i = 0; i < stores.length; i++) {
            try {
                var value = stores[i].getItem(name);
                if (value) return clean(value);
            } catch (e3) {}
        }
        return '';
    }

    // 与上游 getYToken 的顺序一致：Cookie 的 ytoken 优先，再本地 / 会话存储的几个键
    function yToken() {
        var names = ['ytoken', 'YToken', 'token', 'TOKEN'];
        var value = cookieValue('ytoken');
        for (var i = 0; !value && i < names.length; i++) value = storageValue(names[i]);
        return value.length > TOKEN_LIMIT ? '' : value;
    }

    // ---------- 学期（不从接口拿，也不弹窗问） ----------
    // 课表页面上会显示当前学期文字，只认「20xx-20xx学年第x学期」这一种明确写法，避免把别的数字误认成学期
    function readPageTerm() {
        var empty = { name: '', year: 0, kind: '', source: 'none' };
        var body = null;
        try {
            body = window.document && window.document.body;
        } catch (e) {
            body = null;
        }
        if (!body) return empty;
        var page = String(body.innerText || body.textContent || '').substring(0, MAX_PAGE_TEXT);
        page = page.replace(/\s+/g, ' ');
        var m = /(20[0-9]{2})\s*[-－—–~至]\s*(20[0-9]{2})\s*学年\s*度?\s*第?\s*([一二三123])\s*学期/.exec(page);
        if (!m) return empty;
        var year = parseInt(m[1], 10);
        // 学年两头的年份必须连着（2026-2027），否则多半是页面上的别的文字
        if (parseInt(m[2], 10) !== year + 1) return empty;
        var kind = KIND_BY_MARK[m[3]];
        if (!kind) return empty;
        return {
            name: year + '-' + (year + 1) + '学年第' + KIND_CN[kind] + '学期',
            year: year,
            kind: kind,
            source: 'page'
        };
    }

    // ---------- 课表 ----------
    function requestSchedule(token) {
        return fetch(API_PATH, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'ytoken': token
            }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：请确认已登录，再点「提取课表」');
        });
    }

    // 响应的外壳只在这里定义一次：{code:'00000', data:[…]} 或 {code:'00000', data:{list:[…]}}。
    // 「有没有数据」与「挑字段」两处都只用它，免得一处认一处不认
    function courseRowsOf(json) {
        if (!json || typeof json !== 'object') return null;
        if (String(json.code) !== '00000') return null;
        if (json.data instanceof Array) return json.data;
        if (json.data && json.data.list instanceof Array) return json.data.list;
        return null;
    }

    // 一门课 → 白名单对象。40 个定长字段里没有上课时间的跳过；时间段文字原样交给 parse.js 解析
    function courseOf(item) {
        var name = clean(item.courseName || item.name || item.kcmc);
        if (!name) return null;
        var slots = [];
        for (var i = 1; i <= MAX_CLASS_TIME_FIELDS; i++) {
            var classTime = clean(item['classTime' + i]);
            if (!classTime) continue;
            slots.push({ classTime: classTime, classPlace: clean(item['classPlace' + i]) });
        }
        return {
            courseName: name,
            staffName: clean(item.staffName),
            staffNameOther: clean(item.staffNameOther),
            campusName: clean(item.campusName),
            slots: slots
        };
    }

    if (onLoginPage()) throw new Error(LOGIN_TEXT);
    if (!onJwHost()) throw new Error(NOT_JW_TEXT);

    var token = yToken();
    if (!token) throw new Error(NO_LOGIN_TEXT);

    var term = readPageTerm();

    return requestSchedule(token).then(function (body) {
        var json = body.length > MAX_BODY ? null : jsonOf(body);
        var rows = courseRowsOf(json);
        if (!rows) {
            var code = json && typeof json === 'object' && json.code !== undefined && String(json.code) !== '00000'
                ? '（代码 ' + clean(json.code).substring(0, 20) + '）' : '';
            throw new Error(
                '教务系统没有返回课表数据' + code + '：登录状态可能已失效，请重新登录后再点「提取课表」'
            );
        }
        var courses = [];
        for (var i = 0; i < rows.length; i++) {
            if (!rows[i] || typeof rows[i] !== 'object') continue;
            var course = courseOf(rows[i]);
            if (course) courses.push(course);
        }
        if (!courses.length) throw new Error(NO_DATA_TEXT);
        return JSON.stringify({ today: todayIso(), term: term, courses: courses });
    });
})()
