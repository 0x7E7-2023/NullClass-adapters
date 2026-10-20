(function () {
    // 南京师范大学教务适配器（金智教育 jwapp / wdkb「我的课表」）—— 取数
    //
    // 移植自 shiguang_warehouse 的 NJNU/njnu.js（MIT，上游维护者 aryunm）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：19a65bf（2026-10-19），本校脚本最后一次修改 80e30cf
    //
    // 取数方式：同源接口（不抓页面表格，教务改版不影响）。上游的三个接口全部保留，另加一个读当前学期的接口，
    // 全部在教务应用主机 ehallapp.nnu.edu.cn 的 /jwapp/sys/wdkb 下（该主机已写进 manifest 的 allowHosts），
    // 请求一律用相对路径，所以「当前页面就是教务应用页」是前提（见 pageProblem）：
    //   ① POST /modules/jshkcb/dqxnxq.do         当前学年学期（上游是弹窗让用户填；这里改成读教务给的当前学期）
    //   ② POST /modules/xskcb/cxxszhxqkb.do      课表行（上游的主请求），body 为 XNXQDM=<学年学期>&
    //   ③ POST /modules/xskcb/xsdkkc.do          调课 / 停课记录（上游的第二个请求），body 为 XNXQDM=<学年学期>&*order=-SQSJ
    //   ④ POST /modules/jshkcb/cxjcs.do          学期校历：开学日 XQKSRQ（上游的第三个请求，body 为 XN=<学年>&XQ=<学期>），顺带读总周数 ZZC
    // 四个请求顺序执行，不并发；①③④ 失败只降级，②失败整次提取失败。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 不弹窗问学年学期：读 ① 的当前学期，读不到按本机日期推算，推算值由 parse.js 写进提醒。
    //   ② 上游里 http 开头的绝对地址改成相对路径：页面是什么协议就用什么协议，避免 https 页面请求 http 地址被拦。
    //   ③ 上游的 console.log / 提示框 / 弹窗 / 保存课程的桥调用全部不移植，只把教务原始数据交给 parse.js。
    //   ④ 上游把整行原样交给解析；这里按字段白名单挑（每张表一份），多余的字段（含任何个人信息）不带出去。
    //   ⑤ 上游不看 HTTP 状态码；这里 403、其它错误码、网络错误、返回的不是数据（登录失效）分别给大白话报错。
    //   ⑥ 登录页 / 门户页 / 统一认证页上点「提取课表」：直接提示先进入「我的课表」，不发任何请求。
    //   ⑦ 调课记录取不到时上游只弹一句提示；这里交 null 给 parse.js，由它写进提醒。
    //
    // 交出去的是教务的原始行 + 学期元信息 + 本机日期，不算周次、不拼课、不应用调课（那是 parse.js 的活）。
    var BASE = '/jwapp/sys/wdkb';

    // 字段白名单：每张表只带下面列出的字段，学号、姓名等个人信息一律不带出去
    var COURSE_FIELDS = ['KBID', 'KCM', 'SKJS', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC'];
    var CHANGE_FIELDS = ['KBID', 'KCM', 'TKLXDM', 'YSKJS', 'JASMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC',
        'XSKJS', 'XJASMC', 'XSKXQ', 'XKSJC', 'XJSJC', 'XSKZC'];
    var CALENDAR_FIELDS = ['XN', 'XQ', 'XQKSRQ', 'ZZC'];

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function isoDay(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 页面不对就返回给学生看的提示，对就返回空串。只看当前页面的路径，不发请求。
    // 教务应用的页面路径都在 /jwapp/ 下；统一认证页、门户页不在，请求相对路径会打到错误的主机。
    function pageProblem() {
        var path = String(location.pathname || '');
        if (path.indexOf('/jwapp/') === 0) return '';
        return '当前页面还不是教务系统的课表页：请先登录学校账号，再在学校门户里打开「我的课表」，看到课表后再点「提取课表」';
    }

    // 发一次 POST，不抛错：返回 { status, json }。status 0 是网络错误；json 为 null 表示返回的不是数据（多半是登录失效跳回登录页）
    function post(path, body) {
        return fetch(BASE + path, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'accept': 'application/json, text/javascript, */*; q=0.01',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest'
            },
            body: body
        }).then(function (response) {
            return response.json().then(function (json) {
                return { status: response.status, json: json };
            }, function () {
                return { status: response.status, json: null };
            });
        }, function () {
            return { status: 0, json: null };
        });
    }

    // 金智统一信封 { code, datas: { <键>: { rows, extParams } } }。键按接口精确取，不做「取第一个带 rows 的键」的兜底，免得取错表。
    // 「有没有数据」和「挑字段」都从这里过，外壳只定义这一处。
    function tableOf(json, key) {
        var table = json && json.datas && json.datas[key];
        if (!table || Object.prototype.toString.call(table.rows) !== '[object Array]') return null;
        return table;
    }

    // 非关键请求：2xx 且有数据表才算成功，其余一律当作没取到（null）
    function softTable(path, body, key) {
        return post(path, body).then(function (res) {
            if (res.status < 200 || res.status >= 300) return null;
            return tableOf(res.json, key);
        });
    }

    // 按本机日期最可能的学期：9 月～次年 1 月是第一学期，2～8 月是第二学期
    function termFromDate(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        if (month >= 9) return year + '-' + (year + 1) + '-1';
        if (month === 1) return (year - 1) + '-' + year + '-1';
        return (year - 1) + '-' + year + '-2';
    }

    function fetchTerm(now) {
        return softTable('/modules/jshkcb/dqxnxq.do', '', 'dqxnxq').then(function (table) {
            var row = table && table.rows.length ? table.rows[0] : null;
            var code = row ? text(row.DM) : '';
            if (/^\d{4}-\d{4}-\d{1,2}$/.test(code)) {
                return { code: code, name: text(row.MC) || null, source: 'api' };
            }
            return { code: termFromDate(now), name: null, source: 'guess' };
        });
    }

    function fetchCourses(code) {
        return post('/modules/xskcb/cxxszhxqkb.do', 'XNXQDM=' + encodeURIComponent(code) + '&').then(function (res) {
            if (res.status === 403) {
                throw new Error('教务系统拒绝访问（代码 403）：请在学校门户里点开一次「我的课表」，看到课表后再点「提取课表」');
            }
            if (res.status === 0) {
                throw new Error('连不上教务系统，请检查网络后再试');
            }
            if (res.status < 200 || res.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + res.status + '），请稍后再试');
            }
            if (res.json === null) {
                throw new Error('教务系统返回的内容格式不对，登录可能已失效，请重新登录后再点「提取课表」');
            }
            var table = tableOf(res.json, 'cxxszhxqkb');
            if (!table) {
                var extParams = res.json.datas && res.json.datas.cxxszhxqkb && res.json.datas.cxxszhxqkb.extParams;
                var reason = extParams ? text(extParams.msg) : '';
                throw new Error('没能读到课表数据' + (reason ? '（' + reason + '）' : '') + '，请在教务页面确认课表已经显示出来后再试');
            }
            return table.rows;
        });
    }

    // 调课 / 停课记录：取不到交 null（parse.js 会提醒），取到但没有记录是空数组
    function fetchChanges(code) {
        return softTable('/modules/xskcb/xsdkkc.do', 'XNXQDM=' + encodeURIComponent(code) + '&*order=-SQSJ', 'xsdkkc').then(function (table) {
            return table ? table.rows : null;
        });
    }

    function fetchCalendar(code) {
        var parts = code.split('-');
        var body = 'XN=' + encodeURIComponent(parts[0] + '-' + parts[1]) + '&XQ=' + encodeURIComponent(parts[2]);
        return softTable('/modules/jshkcb/cxjcs.do', body, 'cxjcs').then(function (table) {
            return table ? table.rows : [];
        });
    }

    // 只保留白名单字段，其它（学号、姓名等）一律不带出去
    function pick(rows, fields) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var src = rows[i] || {};
            var dst = {};
            for (var k = 0; k < fields.length; k++) {
                if (src.hasOwnProperty(fields[k])) dst[fields[k]] = src[fields[k]];
            }
            out.push(dst);
        }
        return out;
    }

    var problem = pageProblem();
    if (problem) return Promise.reject(new Error(problem));

    var now = new Date();
    var term = null;
    var rows = [];
    var changeRows = null;

    return fetchTerm(now).then(function (found) {
        term = found;
        return fetchCourses(term.code);
    }).then(function (courseRows) {
        rows = courseRows;
        return fetchChanges(term.code);
    }).then(function (found) {
        changeRows = found;
        return fetchCalendar(term.code);
    }).then(function (calendarRows) {
        return JSON.stringify({
            term: term,
            today: isoDay(now),
            rows: pick(rows, COURSE_FIELDS),
            changeRows: changeRows === null ? null : pick(changeRows, CHANGE_FIELDS),
            calendarRows: pick(calendarRows, CALENDAR_FIELDS)
        });
    });
})()
