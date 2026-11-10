(function () {
    // 山东轻工职业学院教务适配器（jedu 教务 JSON 接口）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 SDLIVC/sdlivc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 赛博丁真）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945，本校脚本最后一次修改 1fe584c。
    // 移植改动：
    //   1. 全部改成 ES5 与 Promise；拾光保存桥、弹窗、提示条不移植。
    //   2. 登录页（含密码框或 /xsgl/xs/login/login.aspx）与拿不到 stuId 时直接提示，零请求。
    //   3. 保留上游 POST 地址、站点根路径推导（window.__rootPath，缺省 /jedu）与请求体
    //      semId / stuId / checkType=student；只发往当前页面同源地址。
    //   4. stuId 只放进本次请求，不交出去、不写错误和提醒；每行只交白名单字段。
    //   5. 周次文字解析、停开记录跳过、合并和提醒全部放到 parse.js。
    var COURSE_PATH = '/edu/core/eduScheduleInfo/getScheduleNew.do';

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

    function pageProblem() {
        var href = String(window.location && window.location.href || '').toLowerCase();
        var doc = window.document;
        if (doc && doc.querySelector && doc.querySelector('input[type="password"]')) {
            return '当前打开的是登录页。请先登录教务系统，进入学生端的「学期课表」，看到课表后再点「提取课表」';
        }
        if (href.indexOf('/login/login.aspx') >= 0 || href.indexOf('login.aspx') >= 0) {
            return '当前打开的是登录页。请先登录教务系统，进入学生端的「学期课表」，看到课表后再点「提取课表」';
        }
        return '';
    }

    // 上游 getStudentId：先看 window.stuId，再在页面源码里找 var stuId。
    // 只用于本次同源请求的请求体，绝不放进交出去的对象。
    function studentId() {
        if (typeof window.stuId === 'string' && window.stuId.replace(/^\s+|\s+$/g, '')) {
            return window.stuId.replace(/^\s+|\s+$/g, '');
        }
        var html = window.document && window.document.body ? window.document.body.innerHTML : '';
        var match = String(html).match(/var\s+stuId\s*=\s*["']([^"']+)["']/);
        return match ? match[1] : '';
    }

    // 上游 getSelectedSemesterId：先读 mini 下拉框，再读页面里的 semId 输入框；读不到传空。
    function semesterId() {
        try {
            if (typeof window.mini !== 'undefined' && window.mini && typeof window.mini.get === 'function') {
                var picker = window.mini.get('semId');
                if (picker && typeof picker.getValue === 'function') {
                    return text(picker.getValue());
                }
            }
        } catch (e1) {}
        var input = window.document && window.document.querySelector
            ? window.document.querySelector('input[name="semId"], #semId') : null;
        return input ? text(input.value) : '';
    }

    // 上游用 window.__rootPath || '/jedu' 拼接口地址。这里只保留路径部分，
    // 即使页面把它写成完整地址，请求也不会离开当前教务站点。
    function rootPath() {
        var raw = typeof window.__rootPath === 'string' ? window.__rootPath : '/jedu';
        var path = text(raw || '/jedu').replace(/^https?:\/\/[^/]+/i, '');
        if (path.charAt(0) !== '/') path = '/' + path;
        return path.replace(/\/+$/, '');
    }

    function pickSchedule(raw) {
        var rows = Array.isArray(raw) ? raw : [];
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var item = rows[i] || {};
            var place = item.eduPlace || {};
            var lesson = item.eduLesson || {};
            out.push({
                courseName: item.courseName,
                teacherName: item.teacherName,
                week: item.week,
                weekList: item.weekList,
                stopCourse: item.stopCourse,
                eduPlace: { placeName: place.placeName, nameIncludeNum: place.nameIncludeNum },
                eduLesson: { startLesson: lesson.startLesson, endLesson: lesson.endLesson }
            });
        }
        return out;
    }

    var problem = pageProblem();
    if (problem) throw new Error(problem);
    var stuId = studentId();
    if (!stuId) {
        throw new Error('没有找到学生信息。请先登录教务系统，进入学生端的「学期课表」，看到课表后再点「提取课表」');
    }
    var semId = semesterId();
    var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
    var url = origin + rootPath() + COURSE_PATH;
    var body = 'semId=' + encodeURIComponent(semId)
        + '&stuId=' + encodeURIComponent(stuId)
        + '&checkType=student';
    return fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
        },
        body: body
    }).then(function (response) {
        if (!response.ok) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再试');
        }
        return response.json().then(null, function () {
            throw new Error('教务系统没有返回可读取的课表数据：登录状态可能已失效，请重新登录后打开「学期课表」再试');
        });
    }, function () {
        throw new Error('连不上教务系统：请确认已登录并打开「学期课表」，再点「提取课表」');
    }).then(function (json) {
        // 同一份响应的外壳只在这里认一次。
        if (!json || json.success !== true || !json.data || !Array.isArray(json.data.schedule)) {
            if (json && json.success === false) {
                throw new Error('教务系统没有返回这个学期的课表：请确认教务里的学期选择，再点「提取课表」');
            }
            throw new Error('教务系统没有返回可读取的课表数据：登录状态可能已失效，请重新登录后打开「学期课表」再试');
        }
        return JSON.stringify({
            today: localTodayIso(),
            rows: pickSchedule(json.data.schedule)
        });
    });
})()
