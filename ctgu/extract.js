(function () {
    // 三峡大学教务适配器（金智教育 WIS / jwapp 平台，wdkb「我的课表」应用）—— 取数
    //
    // 移植自 shiguang_warehouse 的 CTGU/ctgu.js（MIT，上游 maintainer 星河欲转）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：19a65bf（2026-10-19）；本校脚本最后一次修改：80e30cf
    //
    // 只读课表。全部请求都是**当前页面同源**的相对路径，落在本校教务主机 jwxt.ctgu.edu.cn（就是 manifest 的
    // loginUrl 主机，所以 allowHosts 为空）。按顺序执行、不并发：
    //   ① POST /jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do      当前学年学期（上游没有，见改动 ①）
    //   ② POST /jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do   课表行（上游的请求，体 XNXQDM=<学期编号>）
    //   ③ POST /jwapp/sys/wdkb/modules/xskcb/xsdkkc.do       调课 / 停课记录（上游的请求，体 XNXQDM=…&*order=-SQSJ）
    //   ④ POST /jwapp/sys/wdkb/modules/jshkcb/cxjcs.do       校历：开学日与总周数（上游没有，见改动 ②）
    //   ⑤ POST /jwapp/sys/wdkb/modules/xskcb/cxxljc.do       校历的另一种叫法（同上，④ 与 ⑤ 都问，交给 parse.js 挑）
    // 接口按会话里的学生身份取数，不需要学号，也不碰成绩、学籍、缴费等其它接口。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 上游弹窗让用户输入起始学年和学期；这里改为读教务给的当前学期（dqxnxq.do），读不到再按本机日期推算，
    //      由 parse.js 把「学期是推算的」写进提醒。要导别的学期，请先在教务页面里切好再点「提取课表」。
    //   ② 上游只保存「总周数 20」，不给开学日；空课必须有开学日，所以多问两个只读的校历接口，取本学期的
    //      XQKSRQ / ZZC。两个都取不到就交空数组，由 parse.js 按本机日期推算并说明。
    //   ③ 上游课表请求失败时只弹提示；这里失败即整次提取失败，并把原因说成大白话（403 指向「先点开课程表」）。
    //      调课记录请求失败不影响课表，交 null，parse.js 提醒「课表可能没有反映最近的调整」。
    //   ④ 上游不管当前在哪个页面；这里在登录页、统一认证页、门户首页这些没有课表的页面上不发请求，直接提示。
    //   ⑤ 输出只保留白名单字段（课表行 8 个、调课记录 16 个、校历 4 个），学号、姓名等个人信息一律不带出去。
    //   ⑥ ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）；弹窗、保存、桥调用全部不移植。
    //
    // 交出去的是教务原始行 + 学期元信息，不算周次、不拼课程、不应用调课（那是 parse.js 的活）。
    var HOST = 'jwxt.ctgu.edu.cn';
    var BASE = '/jwapp/sys/wdkb';

    // 字段白名单：每张表只带下面列出的字段（KBID 是排课记录号，调课记录靠它对回原来的课，不是个人信息）
    var COURSE_FIELDS = ['KBID', 'KCM', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'SKJS', 'JASMC'];
    var CHANGE_FIELDS = ['KBID', 'KCM', 'SQSJ', 'TKLXDM', 'SKZC', 'SKXQ', 'KSJC', 'JSJC', 'YSKJS', 'JASMC',
        'XSKZC', 'XSKXQ', 'XKSJC', 'XJSJC', 'XSKJS', 'XJASMC'];
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

    // 登录页 / 统一认证页 / 门户首页上没有课表：不发请求，给大白话提示
    function notReadyMessage() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '');
        var notSchedulePage = host !== HOST || /login/i.test(path) || path.indexOf('/emaphome/') >= 0;
        if (!notSchedulePage) return null;
        return '现在还不在课表页面：请先登录三峡大学教务系统（统一身份认证），在教务首页点开「课程表」，' +
            '看到课表后再点「提取课表」';
    }

    // 发一次 POST 并解析 JSON。403 与其它错误直接抛出，让用户看到真正的原因；可降级的请求在调用处捕获。
    function postJson(path, body) {
        return fetch(BASE + path, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body || ''
        }).then(function (response) {
            if (response.status === 403) {
                throw new Error('教务系统返回错误（代码 403）：请先在教务首页点开一次「课程表」，看到课表后再点「提取课表」');
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '），请稍后再试');
            }
            return response.json().then(function (json) {
                return json;
            }, function () {
                throw new Error('教务系统没有返回课表数据（返回的内容格式不对）：登录状态可能已失效，请重新登录后再点「提取课表」');
            });
        }, function () {
            throw new Error('连不上教务系统：请确认已登录，再点「提取课表」');
        });
    }

    // 金智统一信封：{ code, datas: { <键>: { rows, totalSize, extParams } } }。
    // 同一份响应的外壳只在这里定义一次：键名按接口精确取，不做「取第一个带 rows 的键」的兜底，免得取错表。
    function tableOf(json, key) {
        var table = json && json.datas && json.datas[key];
        if (!table || !(table.rows instanceof Array)) return null;
        return table;
    }

    function rowsOf(json, key) {
        var table = tableOf(json, key);
        return table ? table.rows : null;
    }

    // 学期兜底：9 月～次年 1 月是秋季（第一学期），2～8 月是春季（第二学期）
    function termFromDate(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        if (month >= 9) return year + '-' + (year + 1) + '-1';
        if (month === 1) return (year - 1) + '-' + year + '-1';
        return (year - 1) + '-' + year + '-2';
    }

    function fetchTerm(now) {
        return postJson('/modules/jshkcb/dqxnxq.do', '').then(function (json) {
            var rows = rowsOf(json, 'dqxnxq') || [];
            if (rows.length && text(rows[0].DM)) {
                return { code: text(rows[0].DM), name: text(rows[0].MC) || null, source: 'api' };
            }
            return { code: termFromDate(now), name: null, source: 'guess' };
        }, function () {
            return { code: termFromDate(now), name: null, source: 'guess' };
        });
    }

    // 课表行：一次请求取整学期（上游同样不翻页）。教务若在响应里报了记录总数，一并交出去，由 parse.js 对账。
    function fetchCourses(code) {
        return postJson('/modules/xskcb/cxxszhxqkb.do', 'XNXQDM=' + encodeURIComponent(code)).then(function (json) {
            var table = json && json.datas && json.datas.cxxszhxqkb;
            var rows = table && table.rows instanceof Array ? table.rows : null;
            // 先看教务的状态码：它说不成功并给了原因，就把原因报出来，不能被「没读到数据」盖掉
            var ext = table && table.extParams;
            if (ext && ext.code !== undefined && ext.code !== null && text(ext.code) !== '' && Number(ext.code) !== 1) {
                if (text(ext.msg)) throw new Error(text(ext.msg));
                if (!rows) throw new Error('教务系统未发布该学期课表。');
            }
            if (!rows) {
                throw new Error('没能读到课表数据，请在教务页面里确认课表已经显示后再试');
            }
            var total = parseInt(table.totalSize, 10);
            return { rows: rows, rowTotal: isNaN(total) ? null : total };
        });
    }

    // 调课 / 停课记录：失败交 null（和「没有调课」的空数组分开），不影响课表本身
    function fetchChanges(code) {
        var body = 'XNXQDM=' + encodeURIComponent(code) + '&*order=-SQSJ';
        return postJson('/modules/xskcb/xsdkkc.do', body).then(function (json) {
            return rowsOf(json, 'xsdkkc');
        }, function () {
            return null;
        });
    }

    // 校历：按学期编号拆出 XN、XQ；两种叫法的接口都问一遍（取不到就空数组）
    function fetchCalendars(code) {
        var parts = code.split('-');
        var rows = [];
        function ask(path, key, body) {
            return postJson(path, body).then(function (json) {
                var list = rowsOf(json, key) || [];
                for (var i = 0; i < list.length; i++) rows.push(list[i]);
            }, function () {});
        }
        if (parts.length < 3) return Promise.resolve(rows);
        var body = 'XN=' + encodeURIComponent(parts[0] + '-' + parts[1]) + '&XQ=' + encodeURIComponent(parts[2]);
        return ask('/modules/jshkcb/cxjcs.do', 'cxjcs', body).then(function () {
            return ask('/modules/xskcb/cxxljc.do', 'cxxljc', '');
        }).then(function () {
            return rows;
        });
    }

    // 只保留白名单字段，其它（学号、姓名等）一律不带出去
    function pick(rows, fields) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var src = rows[i] || {};
            var dst = {};
            for (var k = 0; k < fields.length; k++) {
                if (Object.prototype.hasOwnProperty.call(src, fields[k])) dst[fields[k]] = src[fields[k]];
            }
            out.push(dst);
        }
        return out;
    }

    var notReady = notReadyMessage();
    if (notReady) throw new Error(notReady);

    var now = new Date();
    var term = null;
    var courses = null;
    var changes = null;

    return fetchTerm(now).then(function (found) {
        term = found;
        return fetchCourses(term.code);
    }).then(function (found) {
        courses = found;
        return fetchChanges(term.code);
    }).then(function (found) {
        changes = found;
        return fetchCalendars(term.code);
    }).then(function (calendarRows) {
        return JSON.stringify({
            term: { code: term.code, name: term.name, source: term.source },
            today: isoDay(now),
            rowTotal: courses.rowTotal,
            rows: pick(courses.rows, COURSE_FIELDS),
            changeRows: changes === null ? null : pick(changes, CHANGE_FIELDS),
            calendarRows: pick(calendarRows, CALENDAR_FIELDS)
        });
    });
})()
