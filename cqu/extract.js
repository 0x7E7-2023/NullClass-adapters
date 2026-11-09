(function () {
    // 重庆大学「智慧教务」（my.cqu.edu.cn，自研 REST 接口）适配器 —— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 CQU/cqu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 茵符草）
    //   上游快照 baf83fa（2026-11-09 拉取）；本校脚本最后一次修改 1fe584c（2026-08-23，升级桥接接口至 v2）
    // 移植改动：
    //   1. ES6 改为 ES5 与 Promise 链；拾光保存桥、提示条、任务完成通知都不移植（空课由宿主保存载荷）。
    //   2. 登录判定照上游：主机不是 my.cqu.edu.cn，或页面里读不到学号，直接给大白话提示，一个请求都不发。
    //   3. 登录令牌照上游取 localStorage 的 cqu_edu_ACCESS_TOKEN，只放进发往本校同源接口的
    //      Authorization 头；不交出去、不写进报错或提醒。
    //   4. 学号照上游从页面 .trigger-user-name 的 [学号] 里读，只作为课表接口的请求体；
    //      学号是个人信息，不进交出的对象、不进提醒、不进报错。
    //   5. 学期不弹窗：直接用 session/info-detail 给的当前学期。
    //   6. 地址一律由 window.location.origin 拼出（登录判定已保证它就是 https://my.cqu.edu.cn），
    //      不写死主机名，也不发往别的域。
    //   7. 交出的对象按字段白名单挑：学期只交 id / year / term / name，课表行只交七个排课字段；
    //      响应里夹带的学生信息（学号、姓名、证件号、手机号等）一律不带出。
    //   8. 上游 baseFetch 报错时引用了未定义的 termResponse（上游 bug），这里改为读当前响应的状态码。
    //
    // 请求（全部 credentials: 'include'，全部带 Authorization: Bearer <令牌>）：
    //   1. GET  /api/resourceapi/session/info-detail                                   读当前学期 id
    //   2. GET  /api/resourceapi/session/info/<termId>                                 读开学日与学年学期文本（取不到交 null）
    //   3. GET  /api/timetable/course/maxWeek/<termId>                                 读学期总周数（取不到交 null）
    //   4. GET  /api/workspace/time-pattern/session-time-pattern                       读节次时间（取不到交 null）
    //   5. POST /api/timetable/class/timetable/student/my-table-detail?sessionId=<id>  取课表，请求体 [学号]
    // 第 2-4 条失败不影响导入（交 null，parse.js 回落到推算并写进提醒）；第 5 条失败整次报错。

    var HOST = 'my.cqu.edu.cn';
    var TOKEN_KEY = 'cqu_edu_ACCESS_TOKEN';
    var ROW_FIELDS = ['courseName', 'instructorName', 'position', 'roomName', 'weekDay', 'periodFormat', 'teachingWeek'];
    var SLOT_FIELDS = ['periodOrder', 'startTime', 'endTime'];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 学号只用于课表接口的请求体：上游从页面用户名的 [学号] 里读，这里照做
    function studentIdOf() {
        var node = window.document && window.document.querySelector
            ? window.document.querySelector('.trigger-user-name')
            : null;
        if (!node) return '';
        var raw = node.innerText || node.textContent || '';
        var matched = /\[([^\]]*)\]/.exec(String(raw));
        return matched ? text(matched[1]) : '';
    }

    // 登录令牌只用于本校接口的请求头（上游 getAccessToken 的同一做法）
    function accessToken() {
        try {
            return text(window.localStorage.getItem(TOKEN_KEY)).replace(/"/g, '');
        } catch (e) {
            return '';
        }
    }

    function requestJson(path, method, body, token) {
        var options = {
            method: method,
            credentials: 'include',
            headers: { 'Authorization': 'Bearer ' + token }
        };
        if (method === 'POST') {
            options.headers['Content-Type'] = 'application/json';
            options.body = body;
        }
        return fetch(originOf() + path, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status +
                    '）：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        }).then(function (raw) {
            try {
                return JSON.parse(String(raw));
            } catch (e) {
                throw new Error('教务系统没有返回可读取的数据：请重新登录后再点「提取课表」');
            }
        });
    }

    // 附加数据的请求失败一律吞成 null，由 parse.js 回落并在提醒里说明，不让附加数据挡住课表
    function optional(path, token) {
        return requestJson(path, 'GET', null, token).then(function (json) {
            return json;
        }, function () {
            return null;
        });
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

    // 课表响应的外壳只在这里定义一次：「有没有数据」与「挑字段」共用同一个判断
    function tableRows(json) {
        if (json && json.classTimetableVOList instanceof Array) return json.classTimetableVOList;
        if (json && json.data && json.data.classTimetableVOList instanceof Array) return json.data.classTimetableVOList;
        return null;
    }

    function sessionIdOf(json) {
        if (!json || typeof json !== 'object') return null;
        if (json.curSessionId !== undefined && json.curSessionId !== null) return json.curSessionId;
        if (json.data && typeof json.data === 'object' &&
            json.data.curSessionId !== undefined && json.data.curSessionId !== null) {
            return json.data.curSessionId;
        }
        return null;
    }

    // 学期只交白名单：开学日、学年学期文本、学年、学期。响应里其它字段（含个人信息）一律不带出
    function sessionInfoOf(json) {
        var data = json && json.data;
        if (data instanceof Array) data = data.length ? data[0] : null;
        if (!data || typeof data !== 'object') return { startDate: null, name: null, year: null, term: null };
        return {
            startDate: text(data.beginDate) || null,
            name: text(data.name) || text(data.sessionName) || text(data.showName) || null,
            year: text(data.year) || null,
            term: text(data.term) || null
        };
    }

    function maxWeekOf(json) {
        var value = json && json.data;
        var number = Number(value);
        return isFinite(number) && number > 0 ? number : null;
    }

    function periodTimesOf(json) {
        var data = json && json.data;
        var list = data && data.classPeriodVOS;
        if (!(list instanceof Array)) return null;
        return pickFields(list, SLOT_FIELDS);
    }

    // ---------- 登录检查：不满足就零请求 ----------
    if (String(window.location.hostname || '') !== HOST) {
        throw new Error(
            '这个页面不是重庆大学教务系统。请先登录重庆大学教务系统（my.cqu.edu.cn），看到自己的课表后再点「提取课表」'
        );
    }
    var studentId = studentIdOf();
    if (!studentId) {
        throw new Error(
            '没读到你的学号：请先登录重庆大学教务系统，打开首页并看到自己的课表后再点「提取课表」'
        );
    }
    var token = accessToken();
    if (!token) {
        throw new Error(
            '没找到登录信息：请重新登录重庆大学教务系统后再点「提取课表」'
        );
    }

    var base = '/api/';

    return requestJson(base + 'resourceapi/session/info-detail', 'GET', null, token).then(function (detail) {
        var sessionId = sessionIdOf(detail);
        if (sessionId === null || text(sessionId) === '') {
            throw new Error(
                '教务系统没有给出当前学期：登录状态可能已失效，请重新登录后再点「提取课表」'
            );
        }
        var idText = text(sessionId);
        return Promise.all([
            optional(base + 'resourceapi/session/info/' + encodeURIComponent(idText), token),
            optional(base + 'timetable/course/maxWeek/' + encodeURIComponent(idText), token),
            optional(base + 'workspace/time-pattern/session-time-pattern', token),
            requestJson(base + 'timetable/class/timetable/student/my-table-detail?sessionId=' +
                encodeURIComponent(idText), 'POST', JSON.stringify([studentId]), token)
        ]).then(function (results) {
            var rows = tableRows(results[3]);
            if (rows === null) {
                throw new Error(
                    '教务系统没有返回课表数据（返回的内容格式不对）：' +
                    '登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            var info = sessionInfoOf(results[0]);
            return JSON.stringify({
                term: {
                    id: idText,
                    name: info.name,
                    year: info.year,
                    term: info.term
                },
                today: localTodayIso(),
                startDate: info.startDate,
                maxWeek: maxWeekOf(results[1]),
                periodTimes: periodTimesOf(results[2]),
                rows: pickFields(rows, ROW_FIELDS)
            });
        });
    });
})()
