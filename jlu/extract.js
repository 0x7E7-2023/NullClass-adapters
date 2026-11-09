(function () {
    // 吉林大学教务适配器（金智 jwapp /「我的课表」wdkb 应用）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 JLU/JLU_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者及 adapters.yaml 维护者 Leimeng52mc）
    //   上游快照 baf83fa（2026-11-09 对齐）；本校脚本最后一次修改 ca9632c（git log 核对可见）。
    // 移植改动：
    //   1. ES6 改成 ES5 与 Promise 链；拾光弹窗、提示条、保存桥不移植。
    //   2. 基址照上游从当前页 URL 的 /jwapp/sys/ 之前截取；经 Sangfor 网页 VPN 访问时前缀 /https/<会话 hex>
    //      由页面 URL 自带，不硬编码，直连与 WebVPN 共用同一份代码。
    //   3. 上游会弹窗问「导入当前学期 / 选择其他学期」；这里按任务卡不弹窗，只读教务给的当前学期，
    //      因此学期列表接口 xnxqcx.do 不再请求（七个 POST 减为六个）。
    //   4. 校历、节次、调课/停课、未定时间课程四个只读接口都问；取不到时照上游降级：
    //      校历与节次交空数组、调课交 null、未定时间课程交空数组，由 parse.js 决定提醒。
    //   5. 每张表只交白名单字段；学号、姓名、证件号、手机号等一律不带出。
    //      调课记录里的 KBID 是排课记录号（调课靠它对回原课），不是个人信息。
    //   6. 登录页、WebVPN 登录页、不在 /jwapp/sys/ 下的页面直接给大白话提示，不发请求。
    //   7. 不读本地存储、不碰任何令牌：本校接口只用教务会话 Cookie（上游如此），模板里的 JWT 扫描已删除。
    //
    // 交出去的是教务原始行 + 学期元信息，不算周次、不拼课、不应用调课（那是 parse.js 的活）。
    var DQXNXQ = '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do';
    var CALENDAR = '/jwapp/sys/wdkb/modules/xskcb/cxxljc.do';
    var SECTIONS = '/jwapp/sys/wdkb/modules/jshkcb/jc.do';
    var COURSES = '/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do';
    var CHANGES = '/jwapp/sys/wdkb/modules/xskcb/xsdkkc.do';
    var UNDETERMINED = '/jwapp/sys/wdkb/modules/xskcb/xswpkc.do';

    var COURSE_FIELDS = ['KBID', 'KCM', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'SKJS', 'JASMC'];
    var CHANGE_FIELDS = ['KBID', 'KCM', 'SKZC', 'SKXQ', 'KSJC', 'JSJC', 'YSKJS', 'JASMC',
        'XSKZC', 'XSKXQ', 'XKSJC', 'XJSJC', 'XSKJS', 'XJASMC'];
    var CALENDAR_FIELDS = ['XN', 'XQ', 'XQKSRQ', 'ZZC'];
    var SECTION_FIELDS = ['DM', 'KSSJ', 'JSSJ', 'SFSY'];
    var UNDETERMINED_FIELDS = ['KCM'];

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

    // 登录页、统一认证页、WebVPN 登录页和不在教务应用路径下的页面：不发请求，给大白话提示。
    function pageProblem() {
        var href = String(window.location && window.location.href || '');
        var doc = window.document;
        if (doc && doc.querySelector && doc.querySelector('input[type="password"]')) {
            return '当前打开的是登录页。请先登录，再打开吉林大学（新）教务管理系统的「我的课表」，看到个人课表后点「提取课表」';
        }
        if (/login/i.test(href)) {
            return '请先登录吉林大学统一身份认证，登录后打开「我的课表」，看到个人课表后再提取';
        }
        if (href.indexOf('/jwapp/sys/') < 0) {
            return '请先打开吉林大学（新）教务管理系统的「我的课表」，看到个人课表后再提取';
        }
        return '';
    }

    // 与上游一致：当前 URL 中 /jwapp/sys/ 之前的完整前缀；WebVPN 的 /https/<会话 hex> 因此原样保留。
    function apiBase() {
        var href = String(window.location.href || '');
        var index = href.indexOf('/jwapp/sys/');
        if (index > 0) return href.substring(0, index);
        var loc = window.location;
        return loc.origin || (loc.protocol + '//' + loc.host);
    }

    function post(base, path, body) {
        var headers = {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest'
        };
        if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        return fetch(base + path, {
            method: 'POST',
            credentials: 'include',
            headers: headers,
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
    // 同一份响应只在 rowsOf 认一次外壳，空数据与挑字段共用它，不在别处另写一遍判断。
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

    var problem = pageProblem();
    if (problem) throw new Error(problem);

    var base = apiBase();
    var today = isoDay(new Date());
    var term = null;
    var calendarRows = [];
    var sectionRows = [];
    var course = null;
    var changes = null;
    var undeterminedRows = [];

    return post(base, DQXNXQ, '').then(function (json) {
        var rows = rowsOf(json, 'dqxnxq') || [];
        var first = rows[0] || {};
        var code = text(first.DM);
        var parts = code.split('-');
        if (parts.length < 3 || !text(parts[0]) || !text(parts[1]) || !text(parts[2])) {
            throw new Error('没能读到当前学期：请重新登录后打开「我的课表」，再点「提取课表」');
        }
        term = { code: code, name: text(first.MC) };
        return { xn: parts[0] + '-' + parts[1], xq: parts[2] };
    }).then(function (semester) {
        // 校历：只读，取不到交空数组，不影响下面的课表
        return post(base, CALENDAR, 'XN=' + encodeURIComponent(semester.xn) + '&XQ=' + encodeURIComponent(semester.xq)).then(function (json) {
            calendarRows = rowsOf(json, 'cxxljc') || [];
        }, function () {
            calendarRows = [];
        });
    }).then(function () {
        return post(base, SECTIONS, '').then(function (json) {
            sectionRows = rowsOf(json, 'jc') || [];
        }, function () {
            sectionRows = [];
        });
    }).then(function () {
        // 课表：整学期一次取完（上游同样不翻页）；响应里若报了记录总数，一并交出去对账
        return post(base, COURSES, 'XNXQDM=' + encodeURIComponent(term.code)).then(function (json) {
            var table = json && json.datas && json.datas.cxxszhxqkb;
            var rows = table && table.rows instanceof Array ? table.rows : null;
            if (!rows) {
                throw new Error('没能读到课表数据：请在「我的课表」里确认个人课表已经显示后再试');
            }
            var total = parseInt(table.totalSize, 10);
            course = { rows: rows, rowTotal: isNaN(total) ? null : total };
        });
    }).then(function () {
        // 调课 / 停课：失败交 null（和「没有调课」的空数组分开），由 parse.js 提醒课表可能没反映调整
        return post(base, CHANGES, 'XNXQDM=' + encodeURIComponent(term.code) + '&*order=-SQSJ').then(function (json) {
            changes = rowsOf(json, 'xsdkkc');
        }, function () {
            changes = null;
        });
    }).then(function () {
        // 未定时间课程：上游只用来提醒，不影响课表；取不到按没有处理
        return post(base, UNDETERMINED, 'XNXQDM=' + encodeURIComponent(term.code)).then(function (json) {
            undeterminedRows = rowsOf(json, 'xswpkc') || [];
        }, function () {
            undeterminedRows = [];
        });
    }).then(function () {
        return JSON.stringify({
            term: term,
            today: today,
            rowTotal: course.rowTotal,
            calendarRows: pick(calendarRows, CALENDAR_FIELDS),
            sectionRows: pick(sectionRows, SECTION_FIELDS),
            rows: pick(course.rows, COURSE_FIELDS),
            changeRows: changes === null ? null : pick(changes, CHANGE_FIELDS),
            undeterminedRows: pick(undeterminedRows, UNDETERMINED_FIELDS)
        });
    });
})()
