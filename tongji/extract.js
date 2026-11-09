(function () {
    // 同济大学「1 系统」教务适配器（学校自研 REST 接口，主机 1.tongji.edu.cn，接口前缀 /api）—— 第一步：只取数，把教务的原始数据交出去。
    //
    // 移植自 shiguang_warehouse 的 TONGJI/tongji_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Linho1219）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-09 拉取）
    //   本校脚本在快照里的最后一次修改 1fe584ccf60553688e7759cd8070baf5caae66ed（2026-08-23，refactor: 升级桥接接口至v2）
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗问「是否使用当前学期」：上游的 showSingleSelection 全部删掉，直接用 currentTermCalendar 给的当前学期；
    //      当前学期读不到时退一步取学期列表的第一项，并让 parse.js 在提醒里说明（移植手册 §3 第 1 步）
    //   ③ 主机与接口前缀用当前页面的 origin 拼，不写死 https://1.tongji.edu.cn；只接受同源请求
    //   ④ 只取数：日历详情只带 beginDay、逐节时间与总周数字段；课表只带课名与每条安排的七个白名单字段（见下方 SLOT_FIELDS）。
    //      周次切段、教师工号剥离、节次时间校验全部在 parse.js（CI 里跑得到的那一段）
    //   ⑤ 不再带出学生信息：课表响应里夹带的学生姓名、学号、身份证号、手机号等一律不复制到输出，也不进 fixture
    //   ⑥ 上游的桥调用（showToast / saveImportedCourses / savePresetTimeSlots / saveCourseConfig /
    //      notifyTaskCompletion）全部不移植：空课由宿主负责保存，适配器只交载荷
    //
    // 请求全部打在当前教务主机上（地址由 window.location.origin 拼出，不写死主机名）：
    //   ① POST /api/sessionservice/session/currentAuthId                     只用来判断登录状态；401/403 当「请先登录」
    //   ② GET  /api/baseresservice/schoolCalendar/currentTermCalendar       取当前学期
    //   ③ GET  /api/baseresservice/schoolCalendar/list                      当前学期读不到时的回落：学期列表
    //   ④ GET  /api/baseresservice/schoolCalendar/detail?id=…               开学日、逐节时间、总周数（取不到交 null，不阻断导入）
    //   ⑤ GET  /api/electionservice/reportManagement/findStudentTimetab?calendarId=…  取课表
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var HOST = '1.tongji.edu.cn';
    var API = '/api';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function apiBase() {
        return originOf() + API;
    }

    function stamp() {
        return String(new Date().getTime());
    }

    function onSchoolSite() {
        return String(window.location.hostname || '') === HOST;
    }

    // 登录页 / 统一认证页上点「提取课表」：只给提示，不发请求
    function onLoginPage() {
        var loc = window.location;
        var path = String(loc.pathname || '').toLowerCase();
        var hash = String(loc.hash || '').toLowerCase();
        if (path.indexOf('login') >= 0 || hash.indexOf('login') >= 0) return true;
        var doc = window.document;
        if (doc && doc.querySelector && doc.querySelector('input[type="password"]')) return true;
        return false;
    }

    function request(url, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: { 'Accept': 'application/json, text/plain, */*' }
        };
        if (typeof body === 'string') {
            options.headers['Content-Type'] = 'application/json; charset=utf-8';
            options.body = body;
        }
        return fetch(url, options).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('教务系统要求重新登录：请先登录同济大学「1 系统」，再点「提取课表」');
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：请重新登录后再点「提取课表」，或稍后重试'
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

    function jsonOf(text) {
        try {
            return JSON.parse(String(text));
        } catch (e) {
            return null;
        }
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

    function pickText(object, keys) {
        if (!object || typeof object !== 'object') return '';
        for (var i = 0; i < keys.length; i++) {
            var value = textOf(object[keys[i]]);
            if (value) return value;
        }
        return '';
    }

    // 当前学期：上游读 data.schoolCalendar.id；学校若把 id 放在 data 上也能认
    function calendarIdOf(json) {
        var data = json && json.data;
        if (!data || typeof data !== 'object') return '';
        var calendar = data.schoolCalendar;
        return pickText(calendar, ['id']) || pickText(data, ['id']);
    }

    // 学期名：日历对象上的全名优先，其次 data 上的几个可能的名称字段
    function termNameOf(json) {
        var data = json && json.data;
        if (!data || typeof data !== 'object') return '';
        var calendar = data.schoolCalendar;
        return pickText(calendar, ['fullName', 'name', 'calendarName', 'schoolCalendarName']) ||
            pickText(data, ['fullName', 'name', 'calendarName', 'schoolCalendarName', 'simpleName']);
    }

    // 总周数：任务卡要求「按真实字段名找」。我们拿不到本校账号，只能按常见字段名逐个看，
    // 只接受 1-30 的整数；一个都没有就交 null，由 parse.js 回落内置 20 周并在提醒里说明
    var TOTAL_WEEK_KEYS = [
        'totalWeeks', 'totalWeek', 'weekCount', 'weekNum', 'weeks', 'maxWeek',
        'teachingWeeks', 'weekTotal', 'semesterWeeks', 'weekNumbers', 'weekAmount', 'zs'
    ];

    function totalWeeksOf(data) {
        var scopes = [data, data && data.schoolCalendar];
        for (var s = 0; s < scopes.length; s++) {
            var scope = scopes[s];
            if (!scope || typeof scope !== 'object') continue;
            for (var i = 0; i < TOTAL_WEEK_KEYS.length; i++) {
                var raw = scope[TOTAL_WEEK_KEYS[i]];
                var value = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : null);
                if (value !== null && value >= 1 && value <= 30 && Math.floor(value) === value) return value;
            }
        }
        return null;
    }

    function detailOf(json) {
        var data = json && json.data;
        if (!data || typeof data !== 'object') return null;
        var times = [];
        var raw = data.noWeekendWorkTimes;
        if (raw instanceof Array) {
            for (var i = 0; i < raw.length; i++) {
                var slot = raw[i] || {};
                times.push({ beginTime: slot.beginTime, endTime: slot.endTime });
            }
        }
        return { beginDay: textOf(data.beginDay), times: times, totalWeeks: totalWeeksOf(data) };
    }

    // 课表行白名单：parse.js 只读这七个字段。响应里其它字段（学生姓名 / 学号 / 身份证号 / 手机号等）一律不带出。
    // roomLable 是教务接口里拼错的字段名（上游注释「typo in API」），以代码为准，别改成 roomLabel。
    var SLOT_FIELDS = ['teacherName', 'roomIdI18n', 'roomLable', 'dayOfWeek', 'timeStart', 'timeEnd', 'weeks'];

    function pickSlot(slot) {
        var source = slot || {};
        var kept = {};
        for (var i = 0; i < SLOT_FIELDS.length; i++) {
            if (source[SLOT_FIELDS[i]] !== undefined) kept[SLOT_FIELDS[i]] = source[SLOT_FIELDS[i]];
        }
        return kept;
    }

    function pickCourses(json) {
        var data = json && json.data;
        var list = data instanceof Array ? data : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var course = list[i] || {};
            var slots = course.timeTableList instanceof Array ? course.timeTableList : [];
            var picked = [];
            for (var j = 0; j < slots.length; j++) picked.push(pickSlot(slots[j]));
            out.push({ courseName: course.courseName, timeTableList: picked });
        }
        return out;
    }

    function checkAuth() {
        var body = JSON.stringify({ authId: Math.round(Math.random() * 9000) + 1000 });
        return post(apiBase() + '/sessionservice/session/currentAuthId', body).then(function () {
            return null;
        });
    }

    // 当前学期读不到（接口改了 / 学校没配）时，退一步取学期列表的第一项；这件事由 parse.js 写进提醒
    function termFromList() {
        return get(apiBase() + '/baseresservice/schoolCalendar/list?_t=' + stamp()).then(function (html) {
            var json = jsonOf(html);
            var data = json && json.data;
            var list = data instanceof Array ? data : [];
            var first = list.length ? list[0] || {} : null;
            var id = first ? pickText(first, ['id']) : '';
            if (!id) {
                throw new Error(
                    '没能读到学期信息：请重新登录同济大学「1 系统」，确认能打开课表后再点「提取课表」'
                );
            }
            return { id: id, name: termNameOf({ data: first }), fromList: true };
        });
    }

    function currentTerm() {
        var url = apiBase() + '/baseresservice/schoolCalendar/currentTermCalendar?_t=' + stamp();
        return get(url).then(function (html) {
            var json = jsonOf(html);
            var id = calendarIdOf(json);
            if (id) return { id: id, name: termNameOf(json), fromList: false };
            return termFromList();
        }, function () {
            return termFromList();
        });
    }

    // 日历详情是附加数据：失败一律交 null，让 parse.js 回落并写提醒 —— 绝不因为详情挂掉就导不进课表
    function loadDetail(calendarId) {
        var url = apiBase() + '/baseresservice/schoolCalendar/detail?id=' + encodeURIComponent(calendarId) +
            '&_t=' + stamp();
        return get(url).then(function (html) {
            return detailOf(jsonOf(html));
        }, function () {
            return null;
        });
    }

    function loadCourses(calendarId) {
        var url = apiBase() + '/electionservice/reportManagement/findStudentTimetab?calendarId=' +
            encodeURIComponent(calendarId) + '&_t=' + stamp();
        return get(url).then(function (html) {
            var json = jsonOf(html);
            if (!json || typeof json !== 'object') {
                throw new Error(
                    '教务系统没有返回可读取的课表数据：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return pickCourses(json);
        });
    }

    if (!onSchoolSite()) {
        throw new Error(
            '当前页面不是同济大学「1 系统」。请先打开「1 系统」并登录，再点「提取课表」'
        );
    }

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是登录页。请先登录同济大学「1 系统」，再点「提取课表」'
        );
    }

    return checkAuth().then(function () {
        return currentTerm().then(function (term) {
            return loadDetail(term.id).then(function (detail) {
                return loadCourses(term.id).then(function (courses) {
                    return JSON.stringify({
                        term: { name: term.name, fromList: term.fromList },
                        today: localTodayIso(),
                        detail: detail,
                        courses: courses
                    });
                });
            });
        });
    });
})()
