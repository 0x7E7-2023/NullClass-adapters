(function () {
    // 沈阳科技学院教务适配器（金智教育 WIS / jwapp 平台，wdkb「我的课表」应用）—— 取数
    //
    // 移植自 shiguang_warehouse 的 SYIST/syist_01.js（MIT，上游 maintainer 星河欲转）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：19a65bf（2026-10-19）；本校脚本最后一次修改：80e30cf
    //
    // 只读课表。全部请求都是**当前页面同源**的相对路径，落在本校教务主机 jwxt.syist.edu.cn（就是 manifest 的
    // loginUrl 主机；教务站点用非标准端口 30334，相对路径自然沿用页面的端口，allowHosts 只认主机名，所以为空）。
    // 按顺序执行、不并发：
    //   ① POST /jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do      当前学年学期（上游也问，只是用来给弹窗选默认项，见改动 ①）
    //   ② POST /jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do   理论课表行（上游的请求，体 XNXQDM=<学期编号>）
    //   ③ POST /jwapp/sys/wdkb/modules/syjxkcb/cxsyjxxskb.do 实验课表行（上游的请求，体同上；本校特有，见改动 ②）
    //   ④ POST /jwapp/sys/wdkb/modules/xskcb/xsdkkc.do       调课 / 停课记录（上游的请求，体 XNXQDM=…&*order=-SQSJ）
    //   ⑤ POST /jwapp/sys/wdkb/modules/jshkcb/cxjcs.do       校历：开学日与总周数（上游的请求，体 XN=…&XQ=…）
    //   ⑥ POST /jwapp/sys/wdkb/modules/jshkcb/jc.do          节次时间（上游的请求，体为空）
    // 接口按会话里的学生身份取数，不需要学号，也不碰成绩、学籍、缴费等其它接口。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 上游先问学期列表（xnxqcx.do）再弹窗让用户选学期；这里不弹窗，只读教务给的当前学期（dqxnxq.do），
    //      读不到再按本机日期推算，由 parse.js 把「学期是推算的」写进提醒。要导别的学期，请先在教务页面里切好再点「提取课表」。
    //   ② 实验课表单独一份（cxsyjxxskb.do）；上游取不到时只在控制台留一句话，这里交 null，由 parse.js 提醒「实验课可能没导入」。
    //   ③ 上游课表请求失败时只弹提示；这里失败即整次提取失败，并把原因说成大白话（403 指向「先点开课程表」）。
    //      调课记录请求失败不影响课表，交 null，parse.js 提醒「课表可能没有反映最近的调整」。
    //   ④ 上游不管当前在哪个页面；这里在登录页、统一认证页、门户首页以及不在教务应用路径下的页面上不发请求，直接提示。
    //   ⑤ 校历、节次时间取不到时上游回落写死的值；这里交空数组，回落和提醒都由 parse.js 做。
    //   ⑥ 输出只保留白名单字段（课表行 10 个、调课记录 16 个、校历 4 个、节次 3 个），学号、姓名等个人信息一律不带出去。
    //   ⑦ ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）；弹窗、保存、桥调用全部不移植。
    //
    // 交出去的是教务原始行 + 学期元信息，不算周次、不拼课程、不应用调课（那是 parse.js 的活）。
    var HOST = 'jwxt.syist.edu.cn';
    var BASE = '/jwapp/sys/wdkb';

    // 字段白名单：每张表只带下面列出的字段（KBID 是排课记录号，调课记录靠它对回原来的课，不是个人信息；
    // SYXMMC 是实验项目名，JSM 是教师名）
    var COURSE_FIELDS = ['KBID', 'KCM', 'SYXMMC', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'SKJS', 'JSM', 'JASMC'];
    var CHANGE_FIELDS = ['KBID', 'KCM', 'SQSJ', 'TKLXDM', 'SKZC', 'SKXQ', 'KSJC', 'JSJC', 'YSKJS', 'JASMC',
        'XSKZC', 'XSKXQ', 'XKSJC', 'XJSJC', 'XSKJS', 'XJASMC'];
    var CALENDAR_FIELDS = ['XN', 'XQ', 'XQKSRQ', 'ZZC'];
    var TIME_SLOT_FIELDS = ['DM', 'KSSJ', 'JSSJ'];

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

    // 登录页 / 统一认证页 / 门户首页上没有课表：不发请求，给大白话提示。
    // 本校入口 loginUrl 就是门户首页（/jwapp/sys/emaphome/portal/index.do），登录后教务应用都在 /jwapp/ 路径下，
    // 所以不在 /jwapp/ 下的页面、登录路径、门户路径（/emaphome/）一律当作还没进课表页。
    function notReadyMessage() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '');
        var notSchedulePage = host !== HOST || path.indexOf('/jwapp/') !== 0 || /login/i.test(path) ||
            path.indexOf('/emaphome/') >= 0;
        if (!notSchedulePage) return null;
        return '现在还不在课表页面：请先登录沈阳科技学院教务系统，在教务首页点开「课程表」，' +
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

    // 理论课表行：一次请求取整学期（上游同样不翻页）。教务若在响应里报了记录总数，一并交出去，由 parse.js 对账。
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

    // 实验课表行：失败或没有这张表交 null（和「没有实验课」的空数组分开），不影响理论课表
    function fetchExperiments(code) {
        return postJson('/modules/syjxkcb/cxsyjxxskb.do', 'XNXQDM=' + encodeURIComponent(code)).then(function (json) {
            return rowsOf(json, 'cxsyjxxskb');
        }, function () {
            return null;
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

    // 校历：按学期编号拆出 XN、XQ（取不到就空数组）
    function fetchCalendar(code) {
        var parts = code.split('-');
        if (parts.length < 3) return Promise.resolve([]);
        var body = 'XN=' + encodeURIComponent(parts[0] + '-' + parts[1]) + '&XQ=' + encodeURIComponent(parts[2]);
        return postJson('/modules/jshkcb/cxjcs.do', body).then(function (json) {
            return rowsOf(json, 'cxjcs') || [];
        }, function () {
            return [];
        });
    }

    // 节次时间：取不到交空数组，由 parse.js 回落
    function fetchTimeSlots() {
        return postJson('/modules/jshkcb/jc.do', '').then(function (json) {
            return rowsOf(json, 'jc') || [];
        }, function () {
            return [];
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
    var experiments = null;
    var changes = null;
    var calendarRows = [];

    return fetchTerm(now).then(function (found) {
        term = found;
        return fetchCourses(term.code);
    }).then(function (found) {
        courses = found;
        return fetchExperiments(term.code);
    }).then(function (found) {
        experiments = found;
        return fetchChanges(term.code);
    }).then(function (found) {
        changes = found;
        return fetchCalendar(term.code);
    }).then(function (found) {
        calendarRows = found;
        return fetchTimeSlots();
    }).then(function (timeSlotRows) {
        return JSON.stringify({
            term: { code: term.code, name: term.name, source: term.source },
            today: isoDay(now),
            rowTotal: courses.rowTotal,
            rows: pick(courses.rows, COURSE_FIELDS),
            experimentRows: experiments === null ? null : pick(experiments, COURSE_FIELDS),
            changeRows: changes === null ? null : pick(changes, CHANGE_FIELDS),
            calendarRows: pick(calendarRows, CALENDAR_FIELDS),
            timeSlotRows: pick(timeSlotRows, TIME_SLOT_FIELDS)
        });
    });
})()
