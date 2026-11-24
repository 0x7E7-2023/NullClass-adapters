(function () {
    // 曲靖师范学院教务适配器（金智 jwapp / 我的课表 wdkb）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 QJNU/qjnu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 ZGxudQ）
    //   上游快照 f83288e，本校脚本最后一次修改 29fd297（2026-11-21）。
    // 移植改动（逐条对应 AUDIT.md）：
    //   1. 全部改成 ES5 与 Promise 链；拾光弹窗、提示条、保存桥不移植。
    //   2. 上游弹窗让用户选学期；这里改为读教务给的当前学年学期（dqxnxq.do），拿不到按本机日期推定，由 parse.js 写提醒。
    //   3. 登录页（路径含 login 或页面有密码框）与非 /jwapp/ 页面直接提示，不发请求；门户页与课表页同源，照上游放行。
    //   4. 请求路径与请求体照上游；每张表只交白名单字段，学号、人员 ID 等一律不带出。
    //   5. 校历、节次时间是可选请求，取不到交空数组；实验课、调课记录取不到交 null，由 parse.js 提醒。
    //   6. 不读本地存储、不碰令牌；请求只走本页同源的教务会话 Cookie。
    var HOST = 'jw.qjnu.edu.cn';
    var MODULES = '/jwapp/sys/wdkb/modules';
    var LOGIN_HINT = '请登录曲靖师范学院网页教务，打开「我的课表」后再导入';
    var LOGIN_EXPIRED = '登录已失效，请重新登录后打开「我的课表」再提取';

    var COURSE_FIELDS = ['KBID', 'KCM', 'SYXMMC', 'SKJS', 'JSM', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'KSSJ', 'JSSJ'];
    var CHANGE_FIELDS = ['KBID', 'TKLXDM', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'XSKXQ', 'XKSJC', 'XJSJC', 'XSKZC',
        'XKSSJ', 'XJSSJ', 'XSKJS', 'YSKJS', 'XJASMC', 'JASMC'];
    var CALENDAR_FIELDS = ['XN', 'XQ', 'XQKSRQ', 'ZZC', 'ZJXZC'];
    var SECTION_FIELDS = ['DM', 'KSSJ', 'JSSJ'];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoDay(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 登录页（路径含 login，或页面有密码框）与非 /jwapp/ 页面：不发请求，给大白话提示。
    // 门户页与课表页同源、同在 /jwapp/ 下，照上游放行。
    function pageProblem() {
        var doc = window.document;
        var loc = window.location;
        var path = String(loc.pathname || '');
        if (loc.host !== HOST) {
            return '请先打开曲靖师范学院网页教务，登录后再提取课表';
        }
        if (/login/i.test(path) || (doc && doc.querySelector && doc.querySelector('input[type="password"]'))) {
            return '当前打开的是登录页。请先登录教务系统，再打开「我的课表」，看到个人课表后点「提取课表」';
        }
        if (path.indexOf('/jwapp/') !== 0) {
            return '请先登录教务系统，并进入教务系统内的页面（如「我的课表」），再点「提取课表」';
        }
        return '';
    }

    function lastKey(path) {
        return path.substring(path.lastIndexOf('/') + 1);
    }

    function post(path, body) {
        return fetch(MODULES + '/' + path + '.do', {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'manual',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json'
            },
            body: body || ''
        }).then(function (response) {
            if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
                throw new Error(LOGIN_EXPIRED);
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）。' + LOGIN_HINT);
            }
            return response.json().then(null, function () {
                throw new Error(LOGIN_EXPIRED);
            });
        }, function () {
            throw new Error('连不上教务系统，请确认网络后重试。' + LOGIN_HINT);
        });
    }

    // 金智统一信封 { code, datas: { <键>: { rows, totalSize } } }。外壳只在这里认一次。
    function rowsOf(json, key) {
        if (!json || !json.datas || !json.datas[key]) return null;
        var rows = json.datas[key].rows;
        return rows instanceof Array ? rows : null;
    }

    function loginLike(json) {
        var message = text(json && (json.msg || json.message));
        return text(json && json.code) === '401' || /未登[录陆]|请先登录|重新登录|登录.{0,2}过期/.test(message);
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

    // 必需的请求：没有 rows 就报错（登录过期单独说）。
    function requiredRows(path, body, fields, failText) {
        return post(path, body).then(function (json) {
            var rows = rowsOf(json, lastKey(path));
            if (!rows) throw new Error(loginLike(json) ? LOGIN_EXPIRED : failText);
            return pick(rows, fields);
        });
    }

    // 可选的请求：取不到交 null，由 parse.js 决定怎么提醒。
    function optionalRows(path, body, fields) {
        return post(path, body).then(function (json) {
            var rows = rowsOf(json, lastKey(path));
            return rows ? pick(rows, fields) : null;
        }, function () {
            return null;
        });
    }

    // 当前学年学期推算（只在教务没给出时用）：9 月到次年 1 月是第一学期，2 到 8 月是第二学期。
    function guessTerm(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        var code;
        if (month >= 9) code = year + '-' + (year + 1) + '-1';
        else if (month <= 1) code = (year - 1) + '-' + year + '-1';
        else code = (year - 1) + '-' + year + '-2';
        return { code: code, name: '', source: 'guess' };
    }

    function fetchTerm(now) {
        return post('jshkcb/dqxnxq', '').then(function (json) {
            var row = (rowsOf(json, 'dqxnxq') || [])[0] || {};
            var code = text(row.DM);
            if (!code) return guessTerm(now);
            return { code: code, name: text(row.MC), source: 'api' };
        }, function () {
            return guessTerm(now);
        });
    }

    // 学期列表只用来核对当前学期在不在学校公布的列表里；空列表证明不了什么，交 null。
    function fetchListed(code) {
        return post('jshkcb/xnxqcx', '*order=-DM').then(function (json) {
            var rows = rowsOf(json, 'xnxqcx');
            if (!rows || !rows.length) return { listed: null, name: '' };
            for (var i = 0; i < rows.length; i++) {
                if (text(rows[i] && rows[i].DM) === code) return { listed: true, name: text(rows[i].MC) };
            }
            return { listed: false, name: '' };
        }, function () {
            return { listed: null, name: '' };
        });
    }

    function termParts(code) {
        var parts = text(code).split('-');
        if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null;
        return { xn: parts[0] + '-' + parts[1], xq: parts[2] };
    }

    function fetchCalendar(code) {
        var parts = termParts(code);
        if (!parts) return Promise.resolve([]);
        var body = 'XN=' + encodeURIComponent(parts.xn) + '&XQ=' + encodeURIComponent(parts.xq);
        return optionalRows('jshkcb/cxjcs', body, CALENDAR_FIELDS).then(function (rows) {
            return rows || [];
        });
    }

    function fetchSections() {
        return optionalRows('jshkcb/jc', '', SECTION_FIELDS).then(function (rows) {
            return rows || [];
        });
    }

    var problem = pageProblem();
    if (problem) throw new Error(problem);

    var now = new Date();
    var today = isoDay(now);
    var term = null;
    var calendarRows = [];
    var sectionRows = [];
    var rows = null;
    var experimentRows = null;
    var changeRows = null;

    return fetchTerm(now).then(function (found) {
        term = found;
        return fetchListed(term.code);
    }).then(function (listing) {
        term.listed = listing.listed;
        if (!term.name && listing.name) term.name = listing.name;
        return fetchCalendar(term.code);
    }).then(function (calendar) {
        calendarRows = calendar;
        return fetchSections();
    }).then(function (sections) {
        sectionRows = sections;
        var query = 'XNXQDM=' + encodeURIComponent(term.code);
        return requiredRows('xskcb/cxxszhxqkb', query, COURSE_FIELDS,
            '没能读到课表数据：请在「我的课表」里确认个人课表已经显示后再试');
    }).then(function (regular) {
        rows = regular;
        var query = 'XNXQDM=' + encodeURIComponent(term.code);
        return optionalRows('syjxkcb/cxsyjxxskb', query, COURSE_FIELDS);
    }).then(function (experiments) {
        experimentRows = experiments;
        var query = 'XNXQDM=' + encodeURIComponent(term.code) + '&*order=-SQSJ';
        return optionalRows('xskcb/xsdkkc', query, CHANGE_FIELDS);
    }).then(function (changes) {
        changeRows = changes;
        return JSON.stringify({
            term: term,
            today: today,
            calendarRows: calendarRows,
            sectionRows: sectionRows,
            rows: rows,
            experimentRows: experimentRows,
            changeRows: changeRows
        });
    });
})()
