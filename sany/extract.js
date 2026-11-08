(function () {
    // 湖南三一工业职业技术学院教务适配器（金智 jwapp / 我的课表 wdkb）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 SANYEDU/sany.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e，本校脚本最后一次修改 79d6d37。
    // 移植改动：
    //   1. 全部改成 ES5 与 Promise 链；拾光保存桥、弹窗和提示条不移植。
    //   2. 登录页、门户页和非「我的课表」页直接提示，不发请求。
    //   3. 保留上游两个 POST、查询串和 /jwapp 前缀推导；学期不弹窗，按开学日期自动选择。
    //   4. 学期靠显式构造 term 只交 XN / XQ / XQKSRQ / ZZC / ZJXZC；课表行用 pick 只留七个排课字段。
    //   5. 登录令牌只放进本校同源请求头，不交出去、不写日志；账号密码一律不读。
    //   6. 位串解析、开学日对齐、周次切段、合并和提醒全部放到 parse.js。
    var COURSE_FIELDS = ['KCM', 'SKJS', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC'];
    var SEMESTER_PATH = '/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do?enlink-vpn';
    var COURSE_PATH = '/jwapp/sys/wdkb/modules/xskcb/xskcb.do?enlink-vpn';

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

    function validIso(value) {
        var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text(value).substring(0, 10));
        if (!m) return false;
        var year = parseInt(m[1], 10);
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        var date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    }

    function pageProblem() {
        var href = String(window.location && window.location.href || '').toLowerCase();
        var doc = window.document;
        if (doc && doc.querySelector && doc.querySelector('input[type="password"]')) {
            return '当前打开的是登录页。请先登录教务系统，再打开「我的课表」，看到个人课表后点「提取课表」';
        }
        if (href.indexOf('login?') >= 0) {
            return '请先登录教务系统，登录后打开「我的课表」，看到个人课表后再提取';
        }
        if (href.indexOf('new/index.html') >= 0) {
            return '当前打开的是教务首页。请先进入「我的课表」，看到个人课表后再提取';
        }
        if (href.indexOf('/jwapp/sys/wdkb') < 0) {
            return '请先打开湖南三一工业职业技术学院「我的课表」，看到个人课表后再提取';
        }
        return '';
    }

    function apiBase() {
        var href = String(window.location.href || '');
        var match = /^(https?:\/\/[^/]+(?:[^?#]*)?)\/jwapp/.exec(href);
        if (match) return match[1];
        var loc = window.location;
        return loc.origin || (loc.protocol + '//' + loc.host);
    }

    // 与上游一致：只在本地存储里找 JWT，只用于同源 Authorization 请求头。
    function authToken() {
        var keys = ['Authorization', 'access_token', 'token', 'X-Access-Token', 'x-token', 'auth_token', 'jwt', 'user_token'];
        var stores = [];
        try { stores.push(window.localStorage); } catch (e1) {}
        try { stores.push(window.sessionStorage); } catch (e2) {}
        var i;
        var j;
        for (i = 0; i < keys.length; i++) {
            for (j = 0; j < stores.length; j++) {
                try {
                    var value = stores[j].getItem(keys[i]);
                    if (value && value.indexOf('eyJ') >= 0) return value;
                } catch (e3) {}
            }
        }
        for (j = 0; j < stores.length; j++) {
            try {
                for (i = 0; i < stores[j].length; i++) {
                    var raw = stores[j].getItem(stores[j].key(i));
                    if (!raw) continue;
                    if (raw.indexOf('eyJ') === 0) return raw;
                    var match = /"([^"]*eyJ[^"]*)"/.exec(raw);
                    if (match) return match[1];
                }
            } catch (e4) {}
        }
        return '';
    }

    function post(url, body) {
        var headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
        var token = authToken();
        if (token) headers.Authorization = token.indexOf('Bearer ') === 0 ? token : 'Bearer ' + token;
        return fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: body || ''
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后打开个人课表再试');
            }
            return response.json().then(null, function () {
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

    // 上游：最近开学且不晚于今天；全部都晚于今天时取列表第一项。
    function chooseSemester(rows, today) {
        var best = null;
        var bestDate = '';
        for (var i = 0; i < rows.length; i++) {
            var start = text(rows[i] && rows[i].XQKSRQ).substring(0, 10);
            if (!validIso(start) || start > today) continue;
            if (!best || start > bestDate) {
                best = rows[i];
                bestDate = start;
            }
        }
        if (best) return { row: best, selection: 'date' };
        return { row: rows[0], selection: 'first' };
    }

    var problem = pageProblem();
    if (problem) throw new Error(problem);
    var base = apiBase();
    var today = localTodayIso();
    return post(base + SEMESTER_PATH, '').then(function (json) {
        var semesterRows = rowsOf(json, 'cxjcs');
        if (!semesterRows || !semesterRows.length) {
            throw new Error('没能读到学期信息：请重新登录后打开个人课表，再点「提取课表」');
        }
        var chosen = chooseSemester(semesterRows, today);
        var xn = text(chosen.row.XN);
        var xq = text(chosen.row.XQ);
        if (!xn || !xq) {
            throw new Error('学期信息缺少年学年学期：请重新登录后打开个人课表再试');
        }
        var term = {
            xn: xn,
            xq: xq,
            startDate: text(chosen.row.XQKSRQ).substring(0, 10),
            totalWeeks: chosen.row.ZZC,
            altTotalWeeks: chosen.row.ZJXZC,
            selection: chosen.selection
        };
        return post(base + COURSE_PATH, 'XNXQDM=' + encodeURIComponent(xn + '-' + xq)).then(function (courseJson) {
            var courseRows = rowsOf(courseJson, 'xskcb');
            if (!courseRows) {
                throw new Error('没能读到课表数据：请在「我的课表」里确认个人课表已经显示后再试');
            }
            return JSON.stringify({ term: term, today: today, rows: pick(courseRows, COURSE_FIELDS) });
        });
    });
})()
