(function () {
    // 兰州理工大学教务适配器（金智 jwapp / 我的课表 wdkb）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 LUT/LUT.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Colton）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945，本校脚本最后一次修改 f1de9c2。
    // 移植改动：
    //   1. 全部改成 ES5 与 Promise 链；拾光保存桥、提示条和弹窗不移植。
    //   2. 登录页、门户页和非「我的课表」页直接提示，不发请求（上游没有页面判断）。
    //   3. 保留上游「GET 当前学年学期 + POST 课表」两个请求、路径与表单字段；不弹窗选学期，用教务给的当前学期。
    //   4. 学期只交 DM；课表行用字段白名单只留七个排课字段，响应里夹带的学生信息一律不带出。
    //   5. 不读本地存储里的令牌：本校这两个接口只用浏览器现有 Cookie（credentials include）。
    //   6. 周次文本解析、节次时间、合并与提醒全部放到 parse.js。
    var TERM_PATH = '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do';
    var COURSE_PATH = '/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do';
    var COURSE_FIELDS = ['KCM', 'SKJS', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'ZCMC'];

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
            return '当前打开的是登录页。请先登录教务系统，再打开「我的课表」，看到个人课表后点「提取课表」';
        }
        if (href.indexOf('/jwapp/sys/wdkb') >= 0) return '';
        if (href.indexOf('login') >= 0) {
            return '请先登录教务系统，登录后打开「我的课表」，看到个人课表后再提取';
        }
        return '请先打开兰州理工大学「我的课表」，看到个人课表后再点「提取课表」';
    }

    // 与上游一致：GET 不带正文，POST 用表单正文；两请求都带浏览器现有 Cookie。
    function request(path, body) {
        var options = { method: body === null ? 'GET' : 'POST', credentials: 'include' };
        if (body !== null) {
            options.headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
            options.body = body;
        }
        return fetch(path, options).then(function (response) {
            if (!response.ok) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后打开个人课表再试');
            }
            return response.json().then(function (json) {
                if (json && json.code && String(json.code) !== '0') {
                    throw new Error('教务系统没有给出课表（代码 ' + text(json.code).substring(0, 20) + '）：请重新登录后打开个人课表再试');
                }
                return json;
            }, function () {
                throw new Error('教务系统没有返回可读取的数据：登录状态可能已失效，请重新登录后再试');
            });
        }, function () {
            throw new Error('连不上教务系统：请确认已登录并打开个人课表，再点「提取课表」');
        });
    }

    // 两种响应都只在这里认一次外壳；空数据与挑字段共用同一个 rowsOf。
    function rowsOf(json, name) {
        if (!json || !json.datas || !json.datas[name]) return null;
        var rows = json.datas[name].rows;
        return Array.isArray(rows) ? rows : null;
    }

    function pick(rows, fields) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var src = rows[i] || {};
            var dst = {};
            for (var j = 0; j < fields.length; j++) {
                if (Object.prototype.hasOwnProperty.call(src, fields[j])) dst[fields[j]] = src[fields[j]];
            }
            out.push(dst);
        }
        return out;
    }

    var problem = pageProblem();
    if (problem) throw new Error(problem);
    var today = localTodayIso();
    return request(TERM_PATH, null).then(function (json) {
        var termRows = rowsOf(json, 'dqxnxq');
        if (!termRows || !termRows.length) {
            throw new Error('没能读到当前学期：请重新登录后打开个人课表，再点「提取课表」');
        }
        var dm = text(termRows[0].DM);
        if (!dm) {
            throw new Error('没能读到当前学期的学期代码：请重新登录后打开个人课表再试');
        }
        return request(COURSE_PATH, 'XNXQDM=' + encodeURIComponent(dm)).then(function (courseJson) {
            var courseRows = rowsOf(courseJson, 'cxxszhxqkb');
            if (!courseRows) {
                throw new Error('没能读到课表数据：请在「我的课表」里确认个人课表已经显示后再试');
            }
            return JSON.stringify({ term: { dm: dm }, today: today, rows: pick(courseRows, COURSE_FIELDS) });
        });
    });
})()
