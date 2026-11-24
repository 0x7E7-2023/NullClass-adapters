(function () {
    // 天津理工大学教务适配器（金智 jwapp / 我的课表 wdkb）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 TJUT/tjut_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 f83288e，本校脚本最后一次修改 9ebcf41。
    // 移植改动：
    //   1. 地址从当前页面的 /jwapp 前缀推导（同源），页面必须在 jwxt.tjut.edu.cn 的「我的课表」下；上游写死的主机不进代码。
    //   2. 上游的前置提示、选学期弹窗、提示条与保存桥全部去掉：学期取教务标记的当前学期（dqxnxq），不再问用户。
    //   3. 七个同源 POST 的地址与请求体字段与上游一致；实验课、调课、节次表取不到不影响主课表，由 parse 提醒。
    //   4. 上游不带登录令牌，这里也不读本地存储，只用会话 Cookie。
    //   5. 交出去的字段按白名单挑；学期只显式构造 XN / XQ / 开学日 / 总周数 / 学期名。
    //   6. 周次位串、节次表、开学日对齐、连堂合并、调课应用与提醒全部放到 parse.js。
    var LIST_PATH = '/jwapp/sys/wdkb/modules/jshkcb/xnxqcx.do';
    var CURRENT_PATH = '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do';
    var CALENDAR_PATH = '/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do';
    var PERIOD_PATH = '/jwapp/sys/wdkb/modules/jshkcb/jc.do';
    var COURSE_PATH = '/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do';
    var EXPERIMENT_PATH = '/jwapp/sys/wdkb/modules/syjxkcb/cxsyjxxskb.do';
    var CHANGE_PATH = '/jwapp/sys/wdkb/modules/xskcb/xsdkkc.do';
    var LOGIN_MESSAGE = '当前打开的是登录页。请先登录教务系统，再打开「我的课表」，看到个人课表后点「提取课表」';
    var COURSE_FIELDS = ['KBID', 'KCM', 'SKJS', 'JSM', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'SYXMMC'];
    var CHANGE_FIELDS = ['KBID', 'KCM', 'YSKJS', 'SKZC', 'SKXQ', 'KSJC', 'JSJC', 'TKLXDM',
        'XSKZC', 'XSKXQ', 'XKSJC', 'XJSJC', 'XSKJS', 'JASMC', 'XJASMC'];
    var PERIOD_FIELDS = ['DM', 'KSSJ', 'JSSJ'];

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
        var loc = window.location || {};
        var href = String(loc.href || '').toLowerCase();
        var doc = window.document;
        if (doc && doc.querySelector && doc.querySelector('input[type="password"]')) return LOGIN_MESSAGE;
        if (href.indexOf('login?') >= 0 || href.indexOf('authserver') >= 0) return LOGIN_MESSAGE;
        if (String(loc.hostname || '').toLowerCase() !== 'jwxt.tjut.edu.cn') {
            return '请在天津理工大学教务系统里打开「我的课表」，看到个人课表后再提取';
        }
        if (href.indexOf('/jwapp/sys/homeapp') >= 0) {
            return '当前打开的是教务首页。请先进入「我的课表」，看到个人课表后再提取';
        }
        if (href.indexOf('/jwapp/sys/wdkb') < 0) {
            return '请先打开天津理工大学「我的课表」，看到个人课表后再提取';
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

    // 只带会话 Cookie；失败分两种说法：HTTP 错误、连接失败或返回的不是 JSON。
    function post(url, body) {
        return fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest'
            },
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

    // 取不到（请求失败或返回不是 JSON）时给 null，由 parse 提醒；空列表是另一回事。
    function optional(promise) {
        return promise.then(function (json) {
            return json;
        }, function () {
            return null;
        });
    }

    // 所有响应的外壳只在这里认一次；空数据与挑字段共用同一个 rowsOf。
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

    var base = '';
    var today = localTodayIso();
    var state = {};
    var problem = pageProblem();
    if (problem) throw new Error(problem);
    base = apiBase();

    // 与上游一致的请求顺序：学期列表 → 当前学期 → 节次表 → 课表 → 实验课 → 调课停课 → 校历（开学日、总周数）。
    return post(base + LIST_PATH, '*order=-DM').then(function (json) {
        var list = rowsOf(json, 'xnxqcx');
        if (!list || !list.length) {
            throw new Error('没能读到学期列表：请重新登录后打开个人课表，再点「提取课表」');
        }
        state.list = list;
        return optional(post(base + CURRENT_PATH, ''));
    }).then(function (json) {
        var current = rowsOf(json, 'dqxnxq');
        var currentDm = current && current[0] ? text(current[0].DM) : '';
        var top = state.list.slice(0, 10);
        var chosen = null;
        var selection = 'first';
        for (var i = 0; i < top.length; i++) {
            if (currentDm && text(top[i].DM) === currentDm) {
                chosen = top[i];
                selection = 'current';
                break;
            }
        }
        if (!chosen) chosen = top[0];
        var xn = text(chosen.XNDM);
        var xq = text(chosen.XQDM);
        if (!xn || !xq) {
            throw new Error('学期信息缺少学年或学期：请重新登录后打开个人课表再试');
        }
        state.term = { xn: xn, xq: xq, name: text(chosen.MC), dm: text(chosen.DM) || xn + '-' + xq, selection: selection };
        return optional(post(base + PERIOD_PATH, ''));
    }).then(function (json) {
        state.periods = rowsOf(json, 'jc');
        var body = 'XNXQDM=' + encodeURIComponent(state.term.dm);
        return post(base + COURSE_PATH, body);
    }).then(function (json) {
        state.courses = rowsOf(json, 'cxxszhxqkb');
        if (!state.courses) {
            throw new Error('没能读到课表数据：请在「我的课表」里确认个人课表已经显示后再试');
        }
        var body = 'XNXQDM=' + encodeURIComponent(state.term.dm);
        return optional(post(base + EXPERIMENT_PATH, body));
    }).then(function (json) {
        state.experiments = rowsOf(json, 'cxsyjxxskb');
        var body = 'XNXQDM=' + encodeURIComponent(state.term.dm) + '&*order=-SQSJ';
        return optional(post(base + CHANGE_PATH, body));
    }).then(function (json) {
        state.changes = rowsOf(json, 'xsdkkc');
        var body = 'XN=' + encodeURIComponent(state.term.xn) + '&XQ=' + encodeURIComponent(state.term.xq);
        return optional(post(base + CALENDAR_PATH, body));
    }).then(function (json) {
        var calendar = rowsOf(json, 'cxjcs');
        var row = calendar && calendar[0] ? calendar[0] : {};
        return JSON.stringify({
            term: {
                name: state.term.name,
                selection: state.term.selection,
                startDate: text(row.XQKSRQ).substring(0, 10),
                totalWeeks: text(row.ZZC)
            },
            today: today,
            courseRows: pick(state.courses, COURSE_FIELDS),
            experimentRows: state.experiments ? pick(state.experiments, COURSE_FIELDS) : null,
            changeRows: state.changes ? pick(state.changes, CHANGE_FIELDS) : null,
            periodRows: state.periods ? pick(state.periods, PERIOD_FIELDS) : null
        });
    });
})()
