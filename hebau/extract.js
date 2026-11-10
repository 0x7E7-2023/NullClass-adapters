(function () {
    // 河北农业大学教务适配器（金智 jwapp / 我的课表 wdkb）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 HEBAU/hebau.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 baf83fa，本校脚本最后一次修改 c60b8f7（2026-10-08）。
    // 移植改动：
    //   1. 全部改成 ES5 与 Promise 链；拾光弹窗、提示条、保存桥不移植。
    //   2. 登录页、教务首页、非「我的课表」页直接提示，不发请求。
    //   3. 上游弹窗让用户选学期；这里改为读教务给出的当前学年学期（dqxnxq.do），再拿学期列表
    //      （xnxqcx.do，上游的请求之一）核对；都取不到按本机日期推算，由 parse.js 写提醒。
    //   4. 校历（cxxljc.do）与节次时间（jc.do）是可选请求，取不到交空数组，不影响课表。
    //   5. 课表请求、请求体与 XNXQDM 照上游；每张表只交白名单字段，学号、姓名等一律不带出。
    //   6. 不读本地存储、不碰令牌：本校接口只用教务会话 Cookie（上游如此），模板里的登录令牌扫描已删除。
    var DQXNXQ = '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do';
    var TERMS = '/jwapp/sys/wdkb/modules/jshkcb/xnxqcx.do';
    var CALENDAR = '/jwapp/sys/wdkb/modules/xskcb/cxxljc.do';
    var COURSES = '/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do';
    var SECTIONS = '/jwapp/sys/wdkb/modules/jshkcb/jc.do';

    var COURSE_FIELDS = ['KCM', 'SKJS', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC'];
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

    // 登录页、教务首页和不在「我的课表」应用下的页面：不发请求，给大白话提示。
    function pageProblem() {
        var href = String(window.location && window.location.href || '');
        var doc = window.document;
        if (doc && doc.querySelector && doc.querySelector('input[type="password"]')) {
            return '当前打开的是登录页。请先登录教务系统，再打开「我的课表」，看到个人课表后点「提取课表」';
        }
        if (/login/i.test(href)) {
            return '请先登录教务系统，登录后打开「我的课表」，看到个人课表后再提取';
        }
        if (href.indexOf('/jwapp/sys/homeapp') >= 0) {
            return '当前打开的是教务首页。请先进入「我的课表」，看到个人课表后再提取';
        }
        if (href.indexOf('/jwapp/sys/wdkb') < 0) {
            return '请先打开河北农业大学「我的课表」，看到个人课表后再提取';
        }
        return '';
    }

    // 与上游一致：当前 URL 中 /jwapp 之前的完整前缀；带端口与路径前缀的入口都原样保留。
    function apiBase() {
        var href = String(window.location.href || '');
        var index = href.indexOf('/jwapp');
        if (index > 0) return href.substring(0, index);
        var loc = window.location;
        return loc.origin || (loc.protocol + '//' + loc.host);
    }

    function post(base, path, body) {
        return fetch(base + path, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body || ''
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后打开「我的课表」再试');
            }
            return response.json().then(null, function () {
                throw new Error('教务系统没有返回可读取的数据：登录状态可能已失效，请重新登录后再试');
            });
        }, function () {
            throw new Error('连不上教务系统：请确认已登录并打开「我的课表」，再点「提取课表」');
        });
    }

    // 金智统一信封 { code, datas: { <键>: { rows, totalSize } } }。
    // 同一份响应只在这里认一次外壳，空数据与挑字段共用它。
    function rowsOf(json, key) {
        if (!json || !json.datas || !json.datas[key]) return null;
        var rows = json.datas[key].rows;
        return rows instanceof Array ? rows : null;
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

    // 与上游 inferYearTerm 一致：9 月到次年 1 月是秋季（第一学期），2 到 8 月是春季（第二学期）。
    function termFromDate(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        if (month >= 9) return year + '-' + (year + 1) + '-1';
        if (month <= 1) return (year - 1) + '-' + year + '-1';
        return (year - 1) + '-' + year + '-2';
    }

    // 学期编号 XNXQDM 形如 2026-2027-1；拆出校历请求要的学年与学期。
    function termParts(code) {
        var parts = text(code).split('-');
        if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null;
        return { xn: parts[0] + '-' + parts[1], xq: parts[2] };
    }

    // 当前学年学期：上游没有这个请求，弹窗让用户选；这里优先问教务，失败再按本机日期推算。
    function fetchTerm(base, now) {
        return post(base, DQXNXQ, '').then(function (json) {
            var rows = rowsOf(json, 'dqxnxq') || [];
            var first = rows[0] || {};
            var code = text(first.DM);
            if (code) return { code: code, name: text(first.MC), source: 'api' };
            return { code: termFromDate(now), name: '', source: 'guess' };
        }, function () {
            return { code: termFromDate(now), name: '', source: 'guess' };
        });
    }

    // 学期列表只用来核对当前学期在不在学校公布的列表里；取不到交 null，不阻断导入。
    function fetchTermListed(base, code) {
        return post(base, TERMS, '*order=-DM').then(function (json) {
            var rows = rowsOf(json, 'xnxqcx');
            // 空列表证明不了「不在列表里」，当作没取到，不写提醒。
            if (!rows || !rows.length) return { listed: null, name: '' };
            for (var i = 0; i < rows.length; i++) {
                if (text(rows[i] && rows[i].DM) === code) return { listed: true, name: text(rows[i].MC) };
            }
            return { listed: false, name: '' };
        }, function () {
            return { listed: null, name: '' };
        });
    }

    // 校历：只读，取不到交空数组，不影响课表。
    function fetchCalendar(base, code) {
        var parts = termParts(code);
        if (!parts) return Promise.resolve([]);
        var body = 'XN=' + encodeURIComponent(parts.xn) + '&XQ=' + encodeURIComponent(parts.xq);
        return post(base, CALENDAR, body).then(function (json) {
            return pick(rowsOf(json, 'cxxljc') || [], CALENDAR_FIELDS);
        }, function () {
            return [];
        });
    }

    // 节次时间：只读，取不到交空数组，由应用用默认节次时间并由 parse.js 提醒。
    function fetchSections(base) {
        return post(base, SECTIONS, '').then(function (json) {
            return pick(rowsOf(json, 'jc') || [], SECTION_FIELDS);
        }, function () {
            return [];
        });
    }

    var problem = pageProblem();
    if (problem) throw new Error(problem);

    var base = apiBase();
    var now = new Date();
    var today = isoDay(now);
    var term = null;
    var listed = null;
    var calendarRows = [];
    var sectionRows = [];

    return fetchTerm(base, now).then(function (found) {
        term = found;
        return fetchTermListed(base, term.code);
    }).then(function (check) {
        listed = check.listed;
        if (!term.name && check.name) term.name = check.name;
        return fetchCalendar(base, term.code);
    }).then(function (rows) {
        calendarRows = rows;
        return fetchSections(base);
    }).then(function (rows) {
        sectionRows = rows;
        return post(base, COURSES, 'XNXQDM=' + encodeURIComponent(term.code)).then(function (json) {
            var courseRows = rowsOf(json, 'cxxszhxqkb');
            if (!courseRows) {
                throw new Error('没能读到课表数据：请在「我的课表」里确认个人课表已经显示后再试');
            }
            return JSON.stringify({
                term: { code: term.code, name: term.name, source: term.source, listed: listed },
                today: today,
                calendarRows: calendarRows,
                sectionRows: sectionRows,
                rows: pick(courseRows, COURSE_FIELDS)
            });
        });
    });
})()
