(function () {
    // 成都信息工程大学教务适配器（本科实践教学平台）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 CUIT/cuit_bk_new.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 igugyj(Pfolg)）
    //   上游快照 fa7cbc2ea116e5ffd082a9fe8cb7bdf4407a8713（2026-09-22）
    //   上游 adapters.yaml：adapter_id "CUIT_01"、「成都信息工程大学本科实践教学平台」，
    //   import_url "https://ywtb.cuit.edu.cn/"。同目录的 CUIT_02 是「成都信息工程大学教务管理系统」
    //   （cuit_bk_old.js，走 https://jwc.cuit.edu.cn/，已移植在 jw-adapters/cuit/），
    //   与本件不是一套系统，别拿错。
    //
    // 平台：本科实践教学（管理）平台「LabMS」（接口前缀 /labms/），课表页
    //   https://sjjx.cuit.edu.cn:56443/labms/#/course/my（上游脚本注释自带的地址）。
    //   这一台与 loginUrl（ywtb.cuit.edu.cn，上游 adapters.yaml 的说明是「外网用户把二维码发到
    //   另一台设备登录」）不同源，所以 manifest.json 的 allowHosts 显式写了 "sjjx.cuit.edu.cn"
    //   （见 AUDIT.md 第 2 节）——不写的话，提取期闸门只放行 loginUrl 的主机，
    //   本脚本对 window.location.origin 的同源请求会被直接拦掉。
    //
    // 移植改动：
    //   ① ES6 → ES5（async/await 改成 then 链，去掉模板串、箭头函数、块级声明关键字、可选链 ?.）
    //   ② 只取数：courseName / weeks / sections / weekDay / startTime / endTime 等字段原样交出去，
    //      不在这里切周次段、不拼节次、不并课程——那些是 parse.js 的活（手册 §3 第 1 步）
    //   ③ 上游的 showToast / showAlert（弹 alert）、shiguangBridge* 系列回调全部没有移植
    //   ④ 上游的 importTimeSlots() / importConfig() 两段没有移植：作息表与开学日/总周数
    //      改由 parse.js 用同一张作息表 + 从课表数据本身推算（见 parse.js 头部注释）。
    //      上游 importConfig() 的开学日只对「2025-2026学年第一学期」这一个字符串特判，
    //      其余一律写死 "2026-02-23"、总周数写死 20 ——这个特判过了这一个学期就是错的，
    //      本移植不背这个包袱（手册 §4.5：以实际语义为准，不照抄一次性写死的值）
    //   ⑤ 上游的当前学期兜底是硬编码字符串 "2025-2026学年第二学期"（三种取法都失败时用它）：
    //      这个值只在上游写脚本那一刻是对的，原样搬过来会一直冒充「当前学期」。
    //      本件在三种取法都失败时让 semester 字段留空，由 parse.js 用 warnings 如实说明
    //      「学期名称没有取到」，不假装拿到了一个学期名
    //   ⑥ studentId 只用于构造课表请求（上游同款），不写进输出：fixture 里不会出现学号
    //
    // 取数链（同源，最多两条，都打在本科实践教学平台主机上；地址由 window.location.origin 拼出）：
    //   ① 优先从页面全局变量读用户信息（window.__INITIAL_STATE__ / window.g_initialState 的
    //      info.userCode，或页面上 .username___LBEmQ 节点的文本）；三处都拿不到才退到
    //      GET /labms/user/info?sf_request_type=ajax
    //   ② POST /labms/course/schedule/list/type?sf_request_type=ajax
    //      body: {studentIds:[学号], labIds:[], classIds:[], teacherIds:[学号], status:2,
    //             semester:<当前学期名>, week:null, showMode:"table", toBeDeleted:0}
    //      → 课表行的扁平数组（接口本身返回的结构，不是本脚本拼的）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号密码信息。

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 当前主机名不像本科实践教学平台时，给一句能照做的提示，别只报「连不上」
    // （loginUrl 与实际教务主机不同源，见文件头 ③ 与 AUDIT.md 第 2 节）。
    function hostHint() {
        var host = String(window.location.hostname || '');
        if (/sjjx|labms/i.test(host)) return '';
        return '。本适配器请求的是「本科实践教学（管理）平台」（sjjx.cuit.edu.cn），' +
            '若你当前打开的不是该平台的课表页，请先登录并进入「本科实践教学（管理）平台」' +
            '，打开「我的课表」后再点「提取课表」';
    }

    function request(url, method, body, contentType) {
        var headers = { 'X-Requested-With': 'XMLHttpRequest' };
        if (contentType) headers['Content-Type'] = contentType;
        var options = { method: method, credentials: 'include', headers: headers };
        if (typeof body === 'string') options.body = body;
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回 HTTP ' + response.status +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上本科实践教学平台' + detail + hostHint() + '：请确认已登录，再点「提取课表」');
        });
    }

    function jsonOf(raw, what) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            throw new Error('教务系统返回的' + what + '不是合法的 JSON（教务系统可能改版了），请反馈');
        }
    }

    // ---------- 从页面提取用户信息（上游 getUserInfoFromPage，原样移植） ----------
    function userInfoFromPage() {
        try {
            var state = window.__INITIAL_STATE__ || window.g_initialState;
            if (state && state.info && state.info.userCode) {
                return { userCode: text(state.info.userCode), nickName: text(state.info.nickName) };
            }
        } catch (e) { /* 页面全局变量形状变了，退到下面几种办法 */ }
        try {
            var span = document.querySelector('.username___LBEmQ');
            if (span) {
                var value = text(span.textContent);
                var idMatch = /^\d+/.exec(value);
                if (idMatch) return { userCode: idMatch[0], nickName: value };
            }
        } catch (e) { /* 同上 */ }
        return null;
    }

    function fetchUserInfo() {
        var pageInfo = userInfoFromPage();
        if (pageInfo) return Promise.resolve(pageInfo);
        return request(originOf() + '/labms/user/info?sf_request_type=ajax', 'GET', null, null)
            .then(function (raw) {
                var data = jsonOf(raw, '用户信息');
                if (data.status !== 200) throw new Error(data.message || '获取用户信息失败');
                var d = data.data || {};
                return { userCode: text(d.userCode), nickName: text(d.nickName) };
            });
    }

    // ---------- 当前学期（上游 getCurrentSemester，去掉硬编码兜底，见文件头 ⑤） ----------
    function currentSemesterFromPage() {
        try {
            var select = document.querySelector('.ant-select-selection-item[title]');
            if (select) {
                var title = select.getAttribute('title');
                if (title && title.indexOf('学年') >= 0) return text(title);
            }
        } catch (e) { /* 下拉框结构变了，退到全局变量 */ }
        try {
            var state = window.__INITIAL_STATE__ || window.g_initialState;
            if (state && state.semester && state.semester.current && state.semester.current.name) {
                return text(state.semester.current.name);
            }
        } catch (e) { /* 两处都拿不到，留空交给 parse.js 报警 */ }
        return '';
    }

    // ---------- 课表数据（上游 fetchCourseSchedule，原样移植请求体） ----------
    function fetchCourseSchedule(studentId, semester) {
        var body = JSON.stringify({
            studentIds: [studentId],
            labIds: [],
            classIds: [],
            teacherIds: [studentId],
            status: 2,
            semester: semester,
            week: null,
            showMode: 'table',
            toBeDeleted: 0
        });
        return request(
            originOf() + '/labms/course/schedule/list/type?sf_request_type=ajax',
            'POST',
            body,
            'application/json'
        ).then(function (raw) {
            var data = jsonOf(raw, '课表数据');
            if (data.status !== 200) throw new Error(data.message || '获取课表失败');
            return data.data instanceof Array ? data.data : [];
        });
    }

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
    }

    return fetchUserInfo().then(function (user) {
        if (!user || !user.userCode) {
            throw new Error(
                '没有读到学号：请先在「本科实践教学（管理）平台」登录，打开「我的课表」页面' +
                '再点「提取课表」；若教务系统改版了请反馈'
            );
        }
        var semester = currentSemesterFromPage();
        return fetchCourseSchedule(user.userCode, semester).then(function (rows) {
            if (!rows || rows.length === 0) {
                throw new Error(
                    '教务系统没有返回课表行：可能是这个学期还没排课，也可能登录状态已失效、' +
                    '或课表页面上没有选中学期。请重新登录、确认课表页能看到课后再点「提取课表」'
                );
            }
            return JSON.stringify({
                semester: semester,
                today: localTodayIso(),
                raw: { rows: rows }
            });
        });
    });
})()
