(function () {
    // 中山大学（本科）教务适配器（教务自建 JSON 接口，同源相对路径）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SYSU/sysu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 JXCZ）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03）
    //   本校脚本最后一次修改 80e30cf（批量合并提交）
    // 移植改动：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉块级声明、箭头函数、展开、可选链与 for-of）
    //   ② 不弹窗问学年与学期：上游先弹两个输入 / 选择框，默认值写死为 2026-1。这里按今天的日期推算学年学期（见 acadYearToday），
    //      推算结果交给 parse.js，并在提醒里说明「是按日期推算的」
    //   ③ 只取课表行需要的 8 个字段（课名、教师、教室、星期、起止节次、起始周、周次原文）；
    //      上游没有读令牌，这里也不读；响应里其它字段一律不带出
    //   ④ 校历请求取不到不再整次失败（上游会抛错）：开学日交 null，parse.js 推算并写进提醒
    //   ⑤ 登录页 / 统一认证页不发请求，给大白话提示；上游的错误原文（responseText）不再拼进报错
    //   ⑥ 上游 Object.values 改为 Object.keys，判断「有没有课表」的外壳只在这里认一次
    //
    // 取数方式：同源相对路径，两个请求（全部在 jwxt.sysu.edu.cn 上，不走 allowHosts）：
    //   ① POST /jwxt/timetable-search/stuTimeTabPrint/studentQuery?_t=…   取课表（JSON，请求体见下）
    //   ② GET  /jwxt/base-info/school-calender?academicYear=…&weekly=1&_t=…  取学期第 1 周开始日期（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号或令牌。

    var ORIGIN_HOST = 'jwxt.sysu.edu.cn';
    var API_URL = '/jwxt/timetable-search/stuTimeTabPrint/studentQuery';
    var CALENDAR_API_URL = '/jwxt/base-info/school-calender';

    // 按今天的日期推算学年学期（格式与上游的 ACAD_YEAR 相同，如 2026-1 = 2026-2027 学年第一学期）：
    // 8 月起是当年的第一学期，1 月仍是上一学年第一学期，2 至 7 月是上一学年第二学期
    function acadYearToday() {
        var now = new Date();
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        if (month >= 8) return year + '-1';
        if (month === 1) return (year - 1) + '-1';
        return (year - 1) + '-2';
    }

    function onRightHost() {
        return String(window.location.hostname || '') === ORIGIN_HOST;
    }

    function parseJson(text) {
        try {
            return JSON.parse(String(text));
        } catch (e) {
            return null;
        }
    }

    function postJson(path, payload) {
        return fetch(path + '?_t=' + Date.now(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        }).then(function (response) {
            if (!response.ok) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）：' +
                    '登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：请确认已登录，再点「提取课表」');
        });
    }

    // 课表行只带这几个字段（白名单）；响应里夹带的其它信息一律不带出
    var ROW_FIELDS = [
        'courseName', 'teachingStaffName', 'classPlace', 'week',
        'startClassTimes', 'endClassTimes', 'startWeek', 'timeDetail'
    ];

    // 课表外壳只在这里认一次：{ code: 200, data: { timetable: { "11": [行…], … } } }
    function rowsOf(json) {
        if (!json || typeof json !== 'object') {
            throw new Error('教务系统没有返回课表数据（返回的内容格式不对）：登录状态可能已失效，请重新登录后再点「提取课表」');
        }
        if (json.code !== 200) {
            throw new Error('教务系统返回错误（代码 ' + json.code + '）：请稍后再点「提取课表」');
        }
        var timetable = json.data ? json.data.timetable : null;
        if (!timetable || typeof timetable !== 'object' || Object.prototype.toString.call(timetable) === '[object Array]') {
            throw new Error('教务系统没有返回这个学期的课表数据：请确认教务系统里已有排课，再点「提取课表」');
        }
        var rows = [];
        var keys = Object.keys(timetable);
        for (var i = 0; i < keys.length; i++) {
            var entries = timetable[keys[i]];
            if (Object.prototype.toString.call(entries) !== '[object Array]') continue;
            for (var j = 0; j < entries.length; j++) {
                var item = entries[j];
                if (!item || typeof item !== 'object') continue;
                var kept = {};
                for (var k = 0; k < ROW_FIELDS.length; k++) {
                    if (item[ROW_FIELDS[k]] !== undefined) kept[ROW_FIELDS[k]] = item[ROW_FIELDS[k]];
                }
                rows.push(kept);
            }
        }
        return rows;
    }

    // 校历是附加信息：取不到不影响课表，交 null（parse.js 推算开学日并写进提醒）
    function startDateOf(academicYear) {
        var url = CALENDAR_API_URL + '?academicYear=' + encodeURIComponent(academicYear) +
            '&weekly=1&_t=' + Math.floor(Date.now() / 1000);
        return fetch(url, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (!response.ok) return null;
            return response.text();
        }).then(function (text) {
            var json = text === null ? null : parseJson(text);
            var start = json && json.data ? json.data.startTime : null;
            return typeof start === 'string' && start ? start : null;
        }, function () {
            return null;
        });
    }

    if (!onRightHost()) {
        throw new Error(
            '当前页面不是中山大学教务系统。请先在教务系统（jwxt.sysu.edu.cn）里登录，再点「提取课表」'
        );
    }

    var acadYear = acadYearToday();

    return postJson(API_URL, {
        acadYear: acadYear,
        submitFlag: '1',
        nothroughCourseFlag: '1'
    }).then(function (text) {
        var rows = rowsOf(parseJson(text));
        if (rows.length === 0) {
            throw new Error('教务系统里没有这个学期的排课记录，请确认教务系统里已有排课，再点「提取课表」');
        }
        return startDateOf(acadYear).then(function (startDate) {
            return JSON.stringify({
                acadYear: acadYear,
                rows: rows,
                startDate: startDate
            });
        });
    });
})()
