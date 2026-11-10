(function () {
    // 南方科技大学教学管理与服务平台（TIS，tis.sustech.edu.cn）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 SUSTECH/sustech.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 yusancky）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945，本校脚本最后一次修改 80bedee。
    // 移植改动：
    //   1. 全部改成 ES5 与 Promise 链；拾光保存桥、确认框、提示条、学期弹窗都不移植。
    //   2. 删掉上游的 /cjgl/grcjcx/grcjcx：那是成绩查询，只用来拼学期列表，既不需要也违反只读课表。
    //   3. 登录页、CAS 页、非 TIS 页面直接给提示，不发任何请求。
    //   4. 不弹窗选学期：只问 /component/querydangqianxnxq 当前学年学期；取不到仍照常查课表（不带学期参数），
    //      由 parse.js 提醒学期名是推的。
    //   5. ZC 位图与 SKSJ / SKSJ_EN 多行文本原样交出去：位串解释、周次文字、拼课全在 parse.js。
    //   6. 节次时间原样交（xj / kssj / jssj），能不能用由 parse.js 判断；请求失败给 null。
    //   7. 字段白名单：学号、姓名、班级、人员 ID 都不带出；账号密码一律不读。
    var PATH_TERM = '/component/querydangqianxnxq';
    var PATH_COURSE = '/xszykb/queryxszykbzong';
    var PATH_SLOTS = '/component/queryKbjg';
    var PATH_WEEK = '/component/querydangqianzc';
    var ROW_FIELDS = ['KEY', 'KCMC', 'SKJS', 'SKDD', 'KSJC', 'JSJC', 'ZC', 'SKSJ', 'SKSJ_EN'];
    var SLOT_FIELDS = ['xj', 'kssj', 'jssj'];
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
        var host = String(window.location && window.location.hostname || '').toLowerCase();
        var href = String(window.location && window.location.href || '');
        var doc = window.document;
        if (doc && doc.querySelector && doc.querySelector('input[type="password"]')) {
            return '当前打开的是登录页：请先完成统一身份认证登录，进入教学管理与服务平台后再点「提取课表」';
        }
        if (/(^|\.)cas\.sustech\.edu\.cn$/.test(host) || href.indexOf('/cas/login') >= 0) {
            return '当前打开的是登录页：请先完成统一身份认证登录，进入教学管理与服务平台后再点「提取课表」';
        }
        if (!/(^|\.)tis\.sustech\.edu\.cn$/.test(host)) {
            return '请先打开南方科技大学教学管理与服务平台（tis.sustech.edu.cn）并登录，再点「提取课表」';
        }
        return '';
    }

    function pause(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // 会话级失败（拒绝访问、登录失效、连不上）不再往下试，免得连珠炮。
    function failure(message, stop) {
        var error = new Error(message);
        error.stop = !!stop;
        return error;
    }

    function formBody(fields) {
        if (!fields) return '';
        var parts = [];
        for (var name in fields) {
            if (Object.prototype.hasOwnProperty.call(fields, name)) {
                parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(fields[name]));
            }
        }
        return parts.join('&');
    }

    // 每个请求都是相对地址（同源），Cookie 由浏览器自动带，不读也不发任何令牌。
    function request(path, fields) {
        return fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: formBody(fields)
        }).then(function (response) {
            if (response.status === 403) {
                throw failure('教务系统拒绝访问：请先登录教学管理与服务平台，打开课表页面后再回来导入', true);
            }
            if (!response.ok) {
                throw failure('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再试');
            }
            return response.text();
        }, function () {
            throw failure('连不上教务系统：请确认已登录并打开教学管理与服务平台，再点「提取课表」', true);
        }).then(function (raw) {
            var trimmed = String(raw === null || raw === undefined ? '' : raw).replace(/^\s+|\s+$/g, '');
            // 会话失效时 TIS 会返回登录提示页（HTML 或带「登录」字样的文本）
            if (/重新登录|请登录|用户认证|登录已过期/.test(trimmed)) {
                throw failure('登录状态已失效：请重新登录后再点「提取课表」', true);
            }
            return trimmed;
        });
    }

    function postJson(path, fields) {
        return request(path, fields).then(function (trimmed) {
            if (!trimmed) return null;
            if (trimmed.charAt(0) === '<') {
                throw failure('教务系统返回的是登录页面：登录状态可能已失效，请重新登录后再试', true);
            }
            try {
                return JSON.parse(trimmed);
            } catch (error) {
                throw failure('教务系统没有返回可读取的数据：请确认已登录并打开教学管理与服务平台后再试');
            }
        });
    }

    // 响应外壳只在这里认一次：空数据与挑字段共用同一个 rowsOf。
    function rowsOf(json) {
        if (Array.isArray(json)) return json;
        if (json && Array.isArray(json.content)) return json.content;
        if (json && Array.isArray(json.data)) return json.data;
        return [];
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

    // 当前学年学期；拿不到就交空值，课表照查（不带学期参数），提醒留给 parse.js。
    function loadTerm() {
        return postJson(PATH_TERM, null).then(function (json) {
            var xn = text(json && json.XN);
            var xq = text(json && json.XQ);
            if (!/^[0-9]{4}-[0-9]{4}$/.test(xn) || !/^[0-9]+$/.test(xq)) {
                return { xn: '', xq: '', label: '' };
            }
            return { xn: xn, xq: xq, label: text(json.XNXQ) };
        }, function (error) {
            if (error && error.stop) throw error;
            return { xn: '', xq: '', label: '' };
        });
    }

    function loadRows(term) {
        var fields = term && term.xn && term.xq ? { xn: term.xn, xq: term.xq } : null;
        return postJson(PATH_COURSE, fields).then(function (json) {
            return pick(rowsOf(json), ROW_FIELDS);
        });
    }

    // 节次时间取不到不影响课程导入，parse.js 会回落到写死的常规节次表并提醒。
    function loadSlots(term) {
        return postJson(PATH_SLOTS, { xn: term.xn, xq: term.xq, zc: '1' }).then(function (json) {
            return pick(rowsOf(json), SLOT_FIELDS);
        }, function (error) {
            if (error && error.stop) throw error;
            return null;
        });
    }

    // 当前教学周是纯数字文本；学期未开始时为空，按拿不到处理。
    function loadCurrentWeek() {
        return request(PATH_WEEK, null).then(function (raw) {
            return /^[0-9]{1,2}$/.test(raw) ? Number(raw) : null;
        }, function (error) {
            if (error && error.stop) throw error;
            return null;
        });
    }

    var problem = pageProblem();
    if (problem) throw new Error(problem);
    var today = localTodayIso();

    return loadTerm().then(function (term) {
        return pause(GAP_MS).then(function () {
            return loadRows(term);
        }).then(function (rows) {
            return pause(GAP_MS).then(function () {
                return loadSlots(term);
            }).then(function (slots) {
                return pause(GAP_MS).then(function () {
                    return loadCurrentWeek();
                }).then(function (currentWeek) {
                    return JSON.stringify({
                        term: term,
                        today: today,
                        currentWeek: currentWeek,
                        slots: slots,
                        rows: rows
                    });
                });
            });
        });
    });
})()
