(function () {
    // 广东科学技术职业学院课表适配器（网上办事大厅 wbdt.gdit.edu.cn 的课表 JSON 接口）—— 第一步：只取数，把接口的原始排课交出去。
    //
    // 移植自 shiguang_warehouse 的 GDIT/gdit.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03）
    //   本校脚本最后一次修改 80e30cf（批量合并提交，提交者不是作者）
    // 移植改动：
    //   ① ES5：去掉异步关键字、模板串、箭头函数与块级声明关键字，改成 then 链
    //   ② 不弹窗选学期：上游弹「选择要导入的学期」列表。这里按提取日推算当前学年学期：
    //      9 月至次年 2 月为第 1 学期，3 至 8 月为第 2 学期；学年按学期开始的那一年算（1、2 月属于上一学年）。
    //      上游的推算会把 1、2 月算成「今年-明年」学年、把 3 至 8 月也算成「今年-明年」，学年错一年，这里不照抄
    //   ③ 上游的 alert / toast / saveImportedCourses / savePresetTimeSlots 桥调用全部不移植：空课由宿主保存，适配器只交载荷
    //   ④ 只取数：响应里每条排课只留 parse.js 用得到的 8 个字段（ROW_FIELDS），响应里其它字段一律不带出
    //   ⑤ 地址不写死主机：请求拼成 window.location.origin + 接口路径，只在 wbdt.gdit.edu.cn 上发出（同源）
    //   ⑥ 上游 parseCourses 里 try/catch 静默跳过的记录，这里不跳，交给 parse.js 计数写进提醒
    //
    // 取数方式：一个同源 GET 请求（登录态靠 credentials 带上 Cookie，本脚本不碰凭据）：
    //   GET /front/extraCard/queryStudentSchedule?_t=<时间戳>&semester=<1 或 2>&schoolYear=<如 2026-2027>
    // 停在统一认证页 ids.gdit.edu.cn 时只给大白话提示，不发请求。登录全程由用户在 WebView 里手工完成。

    var HOST = 'wbdt.gdit.edu.cn';
    var LOGIN_HOST = 'ids.gdit.edu.cn';
    var API_PATH = '/front/extraCard/queryStudentSchedule';
    var ROW_FIELDS = ['courseName', 'userName', 'placeName', 'weekDay', 'festivals', 'startWeek', 'endWeek', 'singleDoubleWeek'];

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 当前学年学期（按提取日推算）：9 月起为第 1 学期；从「2 月 20 日所在周的周一」起为第 2 学期，
    // 与 parse.js 推算第 2 学期开学日的口径一致，免得 2 月下旬还取上学期
    function currentTerm(now) {
        var y = now.getFullYear();
        var m = now.getMonth() + 1;
        if (m >= 9) return { schoolYear: y + '-' + (y + 1), semester: '1' };
        if (m === 2) {
            var feb20 = new Date(y, 1, 20);
            var springStart = new Date(y, 1, 20 - (feb20.getDay() + 6) % 7);
            if (now.getTime() < springStart.getTime()) return { schoolYear: (y - 1) + '-' + y, semester: '1' };
        }
        if (m <= 1) return { schoolYear: (y - 1) + '-' + y, semester: '1' };
        return { schoolYear: (y - 1) + '-' + y, semester: '2' };
    }

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function pickFields(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var kept = {};
            for (var j = 0; j < ROW_FIELDS.length; j++) {
                if (row[ROW_FIELDS[j]] !== undefined) kept[ROW_FIELDS[j]] = row[ROW_FIELDS[j]];
            }
            out.push(kept);
        }
        return out;
    }

    var hostname = String(window.location.hostname || '');
    if (hostname === LOGIN_HOST) {
        throw new Error('当前打开的是统一认证登录页。请先登录，再打开网上办事大厅的课程表页面，然后点「提取课表」');
    }
    if (hostname !== HOST) {
        throw new Error('当前不是网上办事大厅的页面。请先登录网上办事大厅，打开课程表页面，再点「提取课表」');
    }

    var now = new Date();
    var term = currentTerm(now);
    var today = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    var url = originOf() + API_PATH + '?_t=' + Date.now() +
        '&semester=' + encodeURIComponent(term.semester) +
        '&schoolYear=' + encodeURIComponent(term.schoolYear);

    return fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        credentials: 'include'
    }).then(function (response) {
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                '教务系统返回错误（代码 ' + response.status + '）' +
                '：登录状态可能已失效，请重新登录后再点「提取课表」'
            );
        }
        return response.text();
    }, function (error) {
        var detail = error && error.message ? '（' + error.message + '）' : '';
        throw new Error('连不上网上办事大厅' + detail + '：请确认已登录，再点「提取课表」');
    }).then(function (text) {
        var json = null;
        try {
            json = JSON.parse(String(text));
        } catch (e) {
            json = null;
        }
        if (!json || typeof json !== 'object') {
            throw new Error(
                '网上办事大厅没有返回课表数据（返回的内容格式不对）：' +
                '登录状态可能已失效，请重新登录后再点「提取课表」'
            );
        }
        var meta = json.meta || {};
        return JSON.stringify({
            term: { schoolYear: term.schoolYear, semester: term.semester },
            today: today,
            meta: {
                success: !!meta.success,
                message: meta.message === undefined || meta.message === null ? '' : String(meta.message)
            },
            rows: pickFields(Array.isArray(json.data) ? json.data : [])
        });
    });
})()
