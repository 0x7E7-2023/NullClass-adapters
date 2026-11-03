(function () {
    // 北部湾大学智慧教务适配器（新一代金智「智慧教务」resourceapi，本校教务站同源访问）—— 第一步：只取数，把教务原始数据交出去。
    //
    // 移植自 shiguang_warehouse 的 BBGU/bbgu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（提交 29498b0，2026-11-03）
    //   本校脚本最后一次修改 80e30cf（批量合并）
    // 移植改动（每条对得上 AUDIT.md）：
    //   ① 不弹窗选学期：上游弹「请选择学期」，这里取教务标为当前的学期（active = Y）；没有标的按今天的日期选；
    //      都选不出就取列表第一个。三种情况由 parse.js 写进提醒（pick 字段）
    //   ② 登录令牌照上游 getAuthToken 读取：先查固定的几个 key，再整库扫描兜底，只认形似 JWT 的值（三段用点隔开的 base64url）。
    //      读到的令牌只放进发往同源教务站的 Authorization 头（没有 Bearer 前缀就补上）；读不到就不带头，照常请求。
    //      令牌不进输出、不进报错文字、不写回任何存储（移植手册 §5 第 1 条，见 AUDIT.md）
    //   ③ 不请求最大周次：上游用 maxWeek 接口定总周数；这里按学期的开始 / 结束日期（教务给的校历）定，见 parse.js
    //   ④ 节次时间：上游没有写死表，只从 get-large-period 接口取；取不到交 null，parse.js 用内置默认节次表并提醒
    //   ⑤ 行字段白名单：只带课程名、教师、教室、校区、星期、节次、周次七个字段，接口响应里的学生个人信息一律不带出
    //   ⑥ 上游的导入桥（showToast、saveImportedCourses、saveCourseConfig、savePresetTimeSlots、notifyTaskCompletion）不移植，
    //      适配器只交载荷
    //
    // 取数方式（全部是本校教务站同源 GET / POST，不写死主机以外的地址，不发给其它域）：
    //   ① GET  /api/resourceapi/session/list                                  取学期列表（选一个学期）
    //   ② POST /api/timetable/class/timetable/student/my-table-detail?sessionId=…   取该学期课表（取不到就报错）
    //   ③ GET  /api/resourceapi/timePattern/get-large-period?sessionId=…       取节次时间（取不到交 null，不报错）
    // 页面不在教务站上、或停在统一身份认证页时，一律不发请求，只给一句大白话提示。
    // 登录全程由用户在 WebView 里手工完成，本脚本不读账号密码，不存、不上报任何账号信息；令牌只放进同源请求头。

    var HOST = 'zhjw.bbgu.edu.cn';
    var SESSION_API = '/api/resourceapi/session/list';
    var PERIOD_API = '/api/resourceapi/timePattern/get-large-period';
    var TIMETABLE_API = '/api/timetable/class/timetable/student/my-table-detail';
    var ROW_FIELDS = ['courseName', 'instructorName', 'roomName', 'campusName', 'weekDay', 'periodFormat', 'teachingWeekFormat'];
    var PERIOD_FIELDS = ['smallPeriod', 'startTime', 'endTime'];

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    // 日期只认「年-月-日」开头（教务给的时间后面的部分不要）；认不出返回空串
    function dateOf(value) {
        var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(textOf(value));
        if (!m) return '';
        var mm = m[2].length < 2 ? '0' + m[2] : m[2];
        var dd = m[3].length < 2 ? '0' + m[3] : m[3];
        return m[1] + '-' + mm + '-' + dd;
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

    // 登录令牌：先查固定的几个 key（localStorage、sessionStorage），再整库扫描兜底；只认形似 JWT 的值，不像的一律不要
    var TOKEN_KEYS = ['Authorization', 'access_token', 'token', 'X-Access-Token', 'x-token', 'auth_token', 'jwt', 'user_token'];
    var JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

    function jwtOf(value) {
        var s = textOf(value);
        if (s.indexOf('Bearer ') === 0) s = s.substring(7);
        return JWT_SHAPE.test(s) ? s : null;
    }

    function storesOf() {
        var out = [];
        try { if (window.localStorage) out.push(window.localStorage); } catch (e) { /* 存储不可访问就跳过 */ }
        try { if (window.sessionStorage) out.push(window.sessionStorage); } catch (e) { /* 同上 */ }
        return out;
    }

    function getAuthToken() {
        var list = storesOf();
        var i;
        var j;
        var k;
        var v;
        for (k = 0; k < TOKEN_KEYS.length; k++) {
            for (i = 0; i < list.length; i++) {
                try { v = jwtOf(list[i].getItem(TOKEN_KEYS[k])); } catch (e) { v = null; }
                if (v) return v;
            }
        }
        // 整库扫描兜底：值本身是令牌，或 JSON 包装里的某个引号字符串是令牌
        for (i = 0; i < list.length; i++) {
            var count = 0;
            try { count = list[i].length; } catch (e) { count = 0; }
            for (j = 0; j < count; j++) {
                var raw = '';
                try { raw = String(list[i].getItem(list[i].key(j)) || ''); } catch (e) { raw = ''; }
                if (!raw) continue;
                var whole = jwtOf(raw);
                if (whole) return whole;
                var re = /"([^"]+)"/g;
                var m = re.exec(raw);
                while (m !== null) {
                    var inner = jwtOf(m[1]);
                    if (inner) return inner;
                    m = re.exec(raw);
                }
            }
        }
        return null;
    }

    // 同源请求：读到令牌就放进 Authorization 头（只发往本校教务站），读不到就不带头；页面自己的 Cookie 照常带上
    function request(path, method, body) {
        var headers = {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json'
        };
        var token = getAuthToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        var options = {
            method: method,
            credentials: 'include',
            headers: headers
        };
        if (typeof body === 'string') options.body = body;
        return fetch(originOf() + path, options).then(function (response) {
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

    // 学期列表：只留能用的（有编号、学年、学期名）
    function sessionsOf(payload) {
        var list = payload && payload.sessionVOList instanceof Array ? payload.sessionVOList : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i] || {};
            if (textOf(s.id) && textOf(s.year) && textOf(s.term)) out.push(s);
        }
        return out;
    }

    // 选学期：教务标为当前的优先；没有标的，取今天落在开始与结束日期之间的；还是没有，取列表第一个（parse.js 会说实话）
    function pickSession(list, today) {
        var i;
        for (i = 0; i < list.length; i++) {
            if (textOf(list[i].active) === 'Y') return { session: list[i], pick: 'active' };
        }
        for (i = 0; i < list.length; i++) {
            var begin = dateOf(list[i].beginDate);
            var end = dateOf(list[i].endDate);
            if (begin && end && begin <= today && today <= end) return { session: list[i], pick: 'date' };
        }
        return { session: list[0], pick: 'first' };
    }

    // 课表：外壳只在这里认一次（裸对象 classTimetableVOList，或套一层 data）
    function timetableRowsOf(payload) {
        if (payload && payload.classTimetableVOList instanceof Array) return payload.classTimetableVOList;
        if (payload && payload.data && payload.data.classTimetableVOList instanceof Array) {
            return payload.data.classTimetableVOList;
        }
        return null;
    }

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

    // 节次时间：按组交出（上游是把各组的 periodList 拼在一起用），取不到或形状不对返回 null
    function periodListsOf(payload) {
        var groups = payload && payload.data instanceof Array ? payload.data : null;
        if (!groups) return null;
        var lists = [];
        for (var i = 0; i < groups.length; i++) {
            var list = groups[i] && groups[i].periodList instanceof Array ? groups[i].periodList : [];
            lists.push(pickFields(list, PERIOD_FIELDS));
        }
        return lists;
    }

    // 页面不在教务站上、或停在统一身份认证页：一律不发请求，只给大白话提示
    var loc = window.location;
    if (String(loc.hostname || '') !== HOST) {
        throw new Error('当前页面不是北部湾大学教务系统：请先登录教务系统，打开课表页后再点「提取课表」');
    }
    if (String(loc.href || '').indexOf('authserver') >= 0) {
        throw new Error('当前停在统一身份认证页面：请先登录，登录成功后再点「提取课表」');
    }

    return request(SESSION_API, 'GET').then(function (text) {
        var sessions = sessionsOf(jsonOf(text));
        if (sessions.length === 0) {
            throw new Error('没有读到学期列表：登录状态可能已失效，请重新登录后再点「提取课表」');
        }
        var today = localTodayIso();
        var picked = pickSession(sessions, today);
        var s = picked.session;
        var id = encodeURIComponent(textOf(s.id));
        return Promise.all([
            request(TIMETABLE_API + '?sessionId=' + id, 'POST').then(function (body) {
                var rows = timetableRowsOf(jsonOf(body));
                if (!rows) {
                    throw new Error(
                        '教务系统没有返回课表数据（返回的内容格式不对）：' +
                        '登录状态可能已失效，请重新登录后再点「提取课表」'
                    );
                }
                return rows;
            }),
            // 节次时间是附加信息：取不到不影响导入，parse.js 会用内置默认节次表并提醒
            request(PERIOD_API + '?sessionId=' + id, 'GET').then(function (body) {
                return periodListsOf(jsonOf(body));
            }, function () {
                return null;
            })
        ]).then(function (parts) {
            return JSON.stringify({
                term: {
                    year: textOf(s.year),
                    term: textOf(s.term),
                    beginDate: dateOf(s.beginDate),
                    endDate: dateOf(s.endDate)
                },
                pick: picked.pick,
                today: today,
                periodLists: parts[1],
                raw: { rows: pickFields(parts[0], ROW_FIELDS) }
            });
        });
    });
})()
