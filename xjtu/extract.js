(function () {
    // 西安交通大学教务适配器（金智教育 WIS / jwapp 平台，wdkb 应用）—— 取数
    //
    // 移植自 shiguang_warehouse 的 XJTU/xjtu.js（MIT，上游 maintainer SDPD、TiaoFeng）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：c586957（2026-10-08）
    //
    // 只读课表。三个 POST 接口，全部打到本校教务主机 ehall.xjtu.edu.cn（就是 manifest 的 loginUrl 主机，
    // 因此不用 allowHosts）。主机写死、不跟着当前页面的域走：一键刷新会先打开登录页，页面跳到哪个域都不影响取数。
    //   ① 当前学年学期：/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do。失败或拿不到就按本机日期推算，parse.js 会在 warnings 里说明
    //   ② 课表行：/jwapp/sys/wdkb/modules/xskcb/xskcb.do，带 XNXQDM，一次取整学期（上游与模板件都不翻页，见 AUDIT.md）
    //   ③ 开学日与总周数：/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do，带 XN / XQ。失败则交空数组，由 parse.js 推算并说明
    // 本校没有可用的节次时间接口：/modules/jshkcb/jc.do 返回 403（真机验过，见 AUDIT §8），所以这里不发这条请求，
    // 作息由 parse.js 内置的两张表给出（与上游 XJTU 的表逐字相同，见 AUDIT §7）。
    // 接口按会话里的学生身份取数，脚本不需要学号，也不碰成绩、学籍、缴费等其它接口。
    //
    // 交出去的是教务原始行 + 学期元信息，不算周次、不拼课程（那是 parse.js 的活）。
    // 输出里只保留排课、校历需要的字段（白名单），学号、姓名等个人信息不带出去。
    var BASE = 'https://ehall.xjtu.edu.cn/jwapp/sys/wdkb';

    // 字段白名单：每张表只带下面列出的字段
    var COURSE_FIELDS = ['KCM', 'SKXQ', 'KSJC', 'JSJC', 'SKZC', 'SKJS', 'JASMC', 'XXXQDM_DISPLAY'];
    var CALENDAR_FIELDS = ['XN', 'XQ', 'XQKSRQ', 'ZJXZC', 'ZZC'];

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

    // 发一次 POST 并解析 JSON。403 与其它错误直接抛出，不再收敛成 null，让用户看到真正的原因。
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
                throw new Error('教务系统拒绝访问（错误码 403）：请在页面里点开一次「我的课表」，看到课表后再点「提取课表」');
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统暂时无法访问（错误码 ' + response.status + '），请稍后再试');
            }
            return response.json().then(function (json) {
                return json;
            }, function () {
                throw new Error('教务系统没有返回课表数据，登录可能已失效，请在教务页面里重新登录后再试');
            });
        });
    }

    // 金智统一信封：{ code, datas: { <键>: { rows, extParams } } }。键名按接口精确取，不做「取第一个带 rows 的键」的兜底，免得取错表。
    function rowsOf(json, key) {
        var table = json && json.datas && json.datas[key];
        if (!table || !Array.isArray(table.rows)) return null;
        return table.rows;
    }

    // 学期兜底：1~6 月为上学年第二学期，7~12 月为本学年第一学期
    function termFromDate(now) {
        var year = now.getFullYear();
        if (now.getMonth() + 1 <= 6) return (year - 1) + '-' + year + '-2';
        return year + '-' + (year + 1) + '-1';
    }

    function fetchTerm(now) {
        return postJson('/modules/jshkcb/dqxnxq.do', '').then(function (json) {
            var rows = rowsOf(json, 'dqxnxq') || [];
            if (rows.length && rows[0].DM) {
                return { code: String(rows[0].DM), name: text(rows[0].MC) || null, source: 'api' };
            }
            return { code: termFromDate(now), name: null, source: 'guess' };
        }, function () {
            return { code: termFromDate(now), name: null, source: 'guess' };
        });
    }

    // 课表行：一次请求。教务若在响应里报了记录总数，一并交出去，由 parse.js 与实际行数对账（取少了会提醒，不静默丢课）。
    function fetchCourses(code) {
        return postJson('/modules/xskcb/xskcb.do', 'XNXQDM=' + encodeURIComponent(code)).then(function (json) {
            var table = json && json.datas && json.datas.xskcb;
            // 先看教务的状态码：不带 rows 时也要把教务给的原因报出来，不能被「没读到数据」盖掉
            if (table && table.extParams && Number(table.extParams.code) !== 1) {
                throw new Error(text(table.extParams.msg) || '教务系统未发布该学期课表。');
            }
            if (!table || !Array.isArray(table.rows)) {
                throw new Error('没能读到课表数据，请在教务页面里确认课表已经显示后再试');
            }
            var total = parseInt(table.totalSize, 10);
            return { rows: table.rows, rowTotal: isNaN(total) ? null : total };
        });
    }

    function fetchCalendar(term) {
        var parts = term.code.split('-');
        if (parts.length < 3) return Promise.resolve([]);
        var body = 'XN=' + encodeURIComponent(parts[0] + '-' + parts[1]) + '&XQ=' + encodeURIComponent(parts[2]);
        return postJson('/modules/jshkcb/cxjcs.do', body).then(function (json) {
            return rowsOf(json, 'cxjcs') || [];
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
                if (src.hasOwnProperty(fields[k])) dst[fields[k]] = src[fields[k]];
            }
            out.push(dst);
        }
        return out;
    }

    var now = new Date();
    var term = null;
    var courseRows = [];
    var rowTotal = null;
    var calendarRows = [];

    return fetchTerm(now).then(function (found) {
        term = found;
        return fetchCourses(term.code);
    }).then(function (found) {
        courseRows = found.rows;
        rowTotal = found.rowTotal;
        return fetchCalendar(term);
    }).then(function (found) {
        calendarRows = found;
        return JSON.stringify({
            term: { code: term.code, name: term.name, source: term.source },
            today: isoDay(now),
            rowTotal: rowTotal,
            rows: pick(courseRows, COURSE_FIELDS),
            calendarRows: pick(calendarRows, CALENDAR_FIELDS)
        });
    });
})()
