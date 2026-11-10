(function () {
    // 西北农林科技大学教务适配器（金智 jwapp / ehall 新门户「我的本研课表」wdkbby）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 NWAFU/nwafu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 123zhuzhu61）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945，本校脚本最后一次修改 177e7bb。
    // 移植改动：
    //   1. 全部改成 ES5 与 Promise 链；拾光保存桥、提示条、确认框都不移植。
    //   2. 登录页、门户页和非「我的本研课表」页直接给提示，不发请求。
    //   3. 不弹窗选学期：先问当前学年学期（dqxnxq.do），取不到再取学期列表第一条并提醒。
    //   4. 校历（cxxljc.do）取不到不影响课表；不请求上游的节次结构接口，它只返回上午/下午/晚上的节数，没有时间。
    //   5. SKZC 位串在这里只按位展开成周号数组，周次文字解析、单双归属与切段全都放到 parse.js。
    //   6. 学期、校历、课表行一律按字段白名单挑：学号、姓名等个人信息不带出；账号密码一律不读。
    //   7. 请求之间留间隔；403 与登录失效给大白话提示，不连珠炮重试。
    var APP_CODE = 'wdkbby';
    var PATH_TERM = '/modules/jshkcb/dqxnxq.do';
    var PATH_TERM_LIST = '/modules/jshkcb/xnxqcx.do';
    var PATH_COURSE = '/modules/xskcb/cxxszhxqkb.do';
    var PATH_CALENDAR = '/modules/xskcb/cxxljc.do';
    var TERM_FIELDS = ['DM', 'MC'];
    var CALENDAR_FIELDS = ['XQKSRQ', 'ZZC'];
    var COURSE_FIELDS = ['KCM', 'TYXMDM_DISPLAY', 'SKJS', 'JASMC', 'JAS',
        'JXLDM_DISPLAY', 'JXLMC', 'XXXQMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'ZCMC'];
    var GAP_MS = 300;

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
            return '当前打开的是登录页。请先登录教务系统，再打开「我的本研课表」，看到个人课表后点「提取课表」';
        }
        if (href.indexOf('login?') >= 0) {
            return '请先登录教务系统，登录后打开「我的本研课表」，看到个人课表后再提取';
        }
        if (href.indexOf('/jwapp/sys/wdkbby') < 0) {
            if (href.indexOf('/jwapp/sys/emaphome') >= 0 || href.indexOf('/new/index.html') >= 0 ||
                    /^https?:\/\/[^\/]+\/?$/.test(href)) {
                return '当前打开的是教务门户首页。请先进入「我的本研课表」，看到个人课表后再点「提取课表」';
            }
            return '请先打开「我的本研课表」，看到个人课表后再点「提取课表」';
        }
        return '';
    }

    // 与上游一致：优先用页面自己的应用根路径，取不到用 /jwapp。相对地址，始终同源。
    function rootPath() {
        var config = window._JW_INIT_CONFIG || {};
        var root = config.path || config.ROOT_PATH || config.contextPath || '/jwapp';
        root = String(root);
        if (root.charAt(0) !== '/') root = '/' + root;
        return root.replace(/\/+$/, '');
    }

    function pause(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // 会话级失败（拒绝访问、登录失效、连不上）不再拿学期列表重试，免得连珠炮。
    function failure(message, stop) {
        var error = new Error(message);
        error.stop = !!stop;
        return error;
    }

    function post(path, body) {
        return fetch(rootPath() + '/sys/' + APP_CODE + path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body || ''
        }).then(function (response) {
            if (response.status === 403) {
                throw failure('教务系统拒绝访问：请先在新门户里打开「我的本研课表」，看到个人课表后再回来导入', true);
            }
            if (!response.ok) {
                throw failure('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再试');
            }
            return response.json().then(null, function () {
                throw failure('教务系统没有返回可读取的数据：登录状态可能已失效，请重新登录后再试');
            });
        }, function () {
            throw failure('连不上教务系统：请确认已登录并打开「我的本研课表」，再点「提取课表」', true);
        }).then(function (json) {
            if (json && json.loginURL) {
                throw failure('登录状态已失效：请重新登录后打开「我的本研课表」，再点「提取课表」', true);
            }
            return json;
        });
    }

    // 响应外壳只在这里认一次；空数据与挑字段共用同一个 rowsOf。
    function rowsOf(json, action) {
        if (!json || !json.datas || !json.datas[action]) return null;
        var rows = json.datas[action].rows;
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

    // "2026-2027-1" 拆成 { xn: "2026-2027", xq: "1" }
    function termCodes(dm) {
        var parts = text(dm).split('-');
        if (parts.length < 3) return null;
        var xn = parts[0] + '-' + parts[1];
        var xq = parts[2];
        if (!/^[0-9]{4}-[0-9]{4}$/.test(xn) || !/^[0-9]+$/.test(xq)) return null;
        return { xn: xn, xq: xq };
    }

    // 与上游一致：按学期代码降序（最新在前）。
    function sortTermsDesc(rows) {
        var list = [];
        var i;
        for (i = 0; i < rows.length; i++) {
            var row = rows[i] || {};
            var dm = text(row.DM);
            if (!dm) continue;
            list.push({ DM: dm, MC: text(row.MC) });
        }
        list.sort(function (a, b) {
            if (a.DM === b.DM) return 0;
            return a.DM < b.DM ? 1 : -1;
        });
        return list;
    }

    // 上游位串：每一位一周，字符 1 表示上课；这里只展开成周号数组，超出范围的处理留给 parse.js。
    function weeksFromBits(value) {
        var raw = text(value).replace(/\s+/g, '');
        if (!raw || !/^[01]+$/.test(raw) || raw.length > 60) return [];
        var weeks = [];
        for (var i = 0; i < raw.length; i++) {
            if (raw.charAt(i) === '1') weeks.push(i + 1);
        }
        return weeks;
    }

    // 当前学年学期；取不到再取学期列表第一条，selection 交给 parse.js 提醒。
    function loadTerm() {
        return post(PATH_TERM, '').then(function (json) {
            var rows = rowsOf(json, 'dqxnxq');
            var picked = rows && rows.length ? pick(rows, TERM_FIELDS)[0] : null;
            if (!picked || !text(picked.DM)) {
                throw new Error('没能读到教务当前的学年学期：请重新登录后打开「我的本研课表」，再点「提取课表」');
            }
            return { dm: text(picked.DM), mc: text(picked.MC), selection: 'current' };
        }).then(null, function (firstError) {
            if (firstError && firstError.stop) throw firstError;
            return pause(GAP_MS).then(function () {
                return post(PATH_TERM_LIST, '*order=' + encodeURIComponent('-DM'));
            }).then(function (json) {
                var rows = rowsOf(json, 'xnxqcx');
                var list = rows && rows.length ? sortTermsDesc(pick(rows, TERM_FIELDS)) : [];
                if (!list.length) throw firstError;
                return { dm: list[0].DM, mc: list[0].MC, selection: 'list' };
            }, function () {
                throw firstError;
            });
        });
    }

    function loadCourses(dm) {
        return pause(GAP_MS).then(function () {
            return post(PATH_COURSE, 'XNXQDM=' + encodeURIComponent(dm));
        }).then(function (json) {
            var rows = rowsOf(json, 'cxxszhxqkb');
            if (!rows) {
                throw new Error('没能读到课表数据：请在「我的本研课表」里确认个人课表已经显示后再试');
            }
            var picked = pick(rows, COURSE_FIELDS);
            for (var i = 0; i < picked.length; i++) {
                picked[i].weeks = weeksFromBits(picked[i].SKZC);
            }
            return picked;
        });
    }

    // 校历取不到不影响课程导入，parse.js 会提醒并按默认推算。
    function loadCalendar(dm) {
        var codes = termCodes(dm);
        if (!codes) return Promise.resolve(null);
        return pause(GAP_MS).then(function () {
            return post(PATH_CALENDAR, 'XN=' + encodeURIComponent(codes.xn) + '&XQ=' + encodeURIComponent(codes.xq));
        }).then(function (json) {
            var rows = rowsOf(json, 'cxxljc');
            if (!rows || !rows.length) return null;
            var picked = pick([rows[0]], CALENDAR_FIELDS)[0];
            return { startDate: text(picked.XQKSRQ).substring(0, 10), totalWeeks: picked.ZZC };
        }, function () {
            return null;
        });
    }

    var problem = pageProblem();
    if (problem) throw new Error(problem);
    var today = localTodayIso();
    return loadTerm().then(function (term) {
        return loadCourses(term.dm).then(function (rows) {
            return loadCalendar(term.dm).then(function (calendar) {
                return JSON.stringify({
                    term: {
                        dm: term.dm,
                        mc: term.mc,
                        selection: term.selection,
                        startDate: calendar ? calendar.startDate : '',
                        totalWeeks: calendar ? calendar.totalWeeks : null
                    },
                    today: today,
                    rows: rows
                });
            });
        });
    });
})()
