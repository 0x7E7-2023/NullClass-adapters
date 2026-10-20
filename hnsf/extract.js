(function () {
    // 河南师范大学教务适配器（乘方教务，jwc.htu.edu.cn）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 HNSF/hnsf_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校目录最后一次修改 80e30cf
    // 上游 HNSF 目录有两份脚本：hnsf_01.js（星河欲转，整学期周课表接口）与 hnsf_02.js（一颗，按月份的日历接口），
    // 本件只移植 01，取舍理由见 AUDIT.md §0。
    //
    // 移植改动（逐条对应 AUDIT.md §4）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗问学年和学期：上游用输入框问学年、再用单选框问学期。这里先看当前页面有没有学期下拉框 #xnxqdm
    //      （用户在课表页上选好了学期再点提取，就取他选的那项），没有就取一次课表页读它的默认选中项，
    //      两者都读不到才按今天的日期推算（parse.js 会在提醒里说明是推算的）
    //   ③ 请求体与上游一字不差（xnxqdm=<学年起始年份 4 位 + 学期 2 位>），只多带了 X-Requested-With 头
    //   ④ 登录页（根路径 / 地址含 login、cas）与非教务主机的页面不发请求，直接给大白话提示
    //   ⑤ 只取数：排课行只带 parse.js 用得到的字段（kcmc / teaxms / jxcdmc / jxcdmc2 / xq / ps / pe / zc / qssj / jssj），
    //      响应里夹带的学号、姓名等一律不带出；周次解析、节次校验与课程拼装全部在 parse.js
    //   ⑥ 上游要求 kcmc / teaxms / jxcdmc / xq / ps / pe / zc 七个字段全部非空，缺一个整行丢弃：
    //      这里不丢，缺教师或缺教室的行照常交出去，由 parse.js 导入并按类型汇总提醒
    //   ⑦ 开学日期：上游没取。这里多探一个同平台的接口（getDatesOfWeek，取第 1 周七天的日期），
    //      取到交给 parse.js 当开学日；取不到交 null，由 parse.js 推算并说明。失败不影响取课表
    //   ⑧ 上游先问校区、再问作息季节（两次弹窗，都用 showSingleSelection）；这里合成一次 __ncSelect 三选一
    //      （建设东路 / 平原湖校区的非夏季作息、同校区的夏季作息、创新港校区），选项里带上第 1 节与下午第 5 节的开始时间方便辨认。
    //      提问桥不存在或用户取消时交 null，由 parse.js 按教务给的上课时间判断，判断不了就用第一种并提醒
    //   ⑨ 上游的 showAlert / showToast / saveImportedCourses / savePresetTimeSlots / notifyTaskCompletion 等拾光界面调用全部去掉
    //
    // 取数方式：同源请求，最多三个，全是相对路径（只会打在用户当前打开的教务主机 jwc.htu.edu.cn 上）：
    //   ① GET  /new/student/xsgrkb/week.page             读学期下拉框 #xnxqdm 的默认选中项（当前页面已有该下拉框则跳过）
    //   ② POST /new/student/xsgrkb/getCalendarWeekDatas  体 xnxqdm=<学期>，取整学期排课（JSON：{code:0,data:[…]}）
    //   ③ POST /new/xlxx/getDatesOfWeek                  体 xnxqdm=<学期>&zc=1，取第 1 周七天的日期（尽力而为，失败交 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ term: { code, name, source }, today, timetable, weekOne, rows: [...] }
    //   term.source —— 'page'（取自教务页面的学期下拉框）或 'date'（按今天的日期推算）
    //   timetable   —— 'normal' / 'summer' / 'campus'（用户在提问里选的节次时间）；没问到或取消为 null
    //   weekOne     —— 第 1 周七天的日期 [{ xqmc, rq }]；取不到为 null
    var HOST = 'jwc.htu.edu.cn';
    var LIST_PATH = '/new/student/xsgrkb/getCalendarWeekDatas';
    var PAGE_PATH = '/new/student/xsgrkb/week.page';
    var WEEK_ONE_PATH = '/new/xlxx/getDatesOfWeek';
    var MAX_PAGE_BODY = 3000000;   // 课表页超过这个长度就不认
    var MAX_LIST_BODY = 4000000;   // 课表响应超过这个长度就不认（多半是登录页 HTML）
    var MAX_SMALL_BODY = 200000;   // 开学日接口的响应超过这个长度就不认
    var TIMETABLE_KEYS = ['normal', 'summer', 'campus'];

    // 行字段白名单：parse.js 只读这几个字段，响应里其它字段（学生信息之类）一律不带出
    var ROW_FIELDS = ['kcmc', 'teaxms', 'jxcdmc', 'jxcdmc2', 'xq', 'ps', 'pe', 'zc', 'qssj', 'jssj'];
    var DAY_FIELDS = ['xqmc', 'rq'];

    var LOGIN_TEXT = '当前打开的是登录页。请先登录教务系统，再打开课表页面，然后点「提取课表」';
    var NOT_JW_TEXT = '当前页面不是河南师范大学的教务系统（jwc.htu.edu.cn）。请先登录教务系统，再打开课表页面，然后点「提取课表」';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。不能用 toISOString：北京时间早上 8 点前它会退到前一天
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // 登录页：根路径（不带查询串）、或主机 + 路径里含 login、含单独的 cas 一段（与上游 isLoginPage 的判断一致，
    // 只是不去看查询串：CAS 登录页的 service= 参数里会带着教务自己的地址）
    function onLoginPage() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '');
        if (host.indexOf('htu.edu.cn') < 0) return false;
        if ((path === '/' || path === '') && !loc.search) return true;
        var where = (host + path).toLowerCase();
        if (where.indexOf('login') >= 0) return true;
        return /(^|[^a-z0-9])cas([^a-z0-9]|$)/.test(where);
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === HOST;
    }

    function jsonOf(text) {
        try {
            return JSON.parse(String(text));
        } catch (e) {
            return null;
        }
    }

    function request(path, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        if (typeof body === 'string') options.body = body;
        return fetch(path, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：请确认已登录，再点「提取课表」');
        });
    }

    // 课表响应的外壳只在这里定义一次：{code:0,data:[…]}。返回行数组；不是这个形状返回 null
    function courseRowsOf(json) {
        if (!json || typeof json !== 'object') return null;
        if (String(json.code) !== '0') return null;
        return json.data instanceof Array ? json.data : null;
    }

    // 开学日接口的外壳：裸数组，或套了一层 rows / data
    function dayRowsOf(json) {
        if (json instanceof Array) return json;
        if (!json || typeof json !== 'object') return null;
        if (json.rows instanceof Array) return json.rows;
        if (json.data instanceof Array) return json.data;
        return null;
    }

    function pick(row, fields) {
        var kept = {};
        for (var i = 0; i < fields.length; i++) {
            if (row[fields[i]] !== undefined && row[fields[i]] !== null) kept[fields[i]] = row[fields[i]];
        }
        return kept;
    }

    function pickAll(list, fields) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && typeof list[i] === 'object') out.push(pick(list[i], fields));
        }
        return out;
    }

    // ---------- 学期 ----------
    // 学期代码 = 学年起始年份 4 位 + 学期 2 位（上游拼的 xnxqdm）。下拉框里不是这个形状的选项不认
    function termCodeOk(code) {
        return /^[0-9]{6}$/.test(code);
    }

    // 读 #xnxqdm：选中项优先（用户在页面上切过的就是他选的），没有选中标记取第一个合法选项
    function readTermSelect(doc) {
        var select = doc && doc.getElementById ? doc.getElementById('xnxqdm') : null;
        if (!select) return null;
        var options = select.querySelectorAll ? select.querySelectorAll('option') : (select.options || []);
        var list = [];
        var picked = -1;
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var code = clean(option.value).replace(/\s+/g, '');
            if (!termCodeOk(code)) continue;
            var chosen = option.selected === true || (option.hasAttribute && option.hasAttribute('selected'));
            if (chosen && picked < 0) picked = list.length;
            list.push({ code: code, name: clean(option.textContent) });
        }
        if (!list.length) return null;
        if (picked < 0) picked = 0;
        return { code: list[picked].code, name: list[picked].name, source: 'page' };
    }

    // 按今天的日期推算学期：8 月到次年 1 月是第一学期（1 月算上一学年），2 到 7 月是第二学期
    function termByDate(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        var code;
        if (month >= 8) code = year + '01';
        else if (month <= 1) code = (year - 1) + '01';
        else code = (year - 1) + '02';
        return { code: code, name: '', source: 'date' };
    }

    function fetchPageTerm() {
        if (typeof DOMParser === 'undefined') return Promise.resolve(null);
        return request(PAGE_PATH, 'GET', null).then(function (html) {
            if (html.length > MAX_PAGE_BODY) return null;
            return readTermSelect(new DOMParser().parseFromString(html, 'text/html'));
        }, function () {
            return null;
        });
    }

    function resolveTerm() {
        var onPage = readTermSelect(window.document);
        if (onPage) return Promise.resolve(onPage);
        return fetchPageTerm().then(function (found) {
            return found || termByDate(new Date());
        });
    }

    // ---------- 课表 ----------
    function fetchRows(term) {
        return request(LIST_PATH, 'POST', 'xnxqdm=' + encodeURIComponent(term.code)).then(function (body) {
            var json = body.length > MAX_LIST_BODY ? null : jsonOf(body);
            var rows = courseRowsOf(json);
            if (!rows) {
                var code = json && typeof json === 'object' && json.code !== undefined && String(json.code) !== '0'
                    ? '（代码 ' + clean(json.code).substring(0, 20) + '）' : '';
                throw new Error(
                    '教务系统没有返回课表数据' + code + '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return pickAll(rows, ROW_FIELDS);
        });
    }

    // 第 1 周七天的日期：不是每个部署都有，任何失败（非 2xx / 不是 JSON / 超长 / 形状不对）都交 null
    function fetchWeekOne(term) {
        return request(WEEK_ONE_PATH, 'POST', 'xnxqdm=' + encodeURIComponent(term.code) + '&zc=1').then(function (body) {
            var json = body.length > MAX_SMALL_BODY ? null : jsonOf(body);
            var days = dayRowsOf(json);
            return days ? pickAll(days, DAY_FIELDS) : null;
        }, function () {
            return null;
        });
    }

    // ---------- 节次时间 ----------
    // 校区和季节判断不了、又直接影响每门课的上课时间，所以问一次。桥不在或用户取消都交 null，不阻塞导入
    function askTimetable() {
        if (typeof __ncCapabilities === 'undefined' || !__ncCapabilities || !__ncCapabilities.ask) {
            return Promise.resolve(null);
        }
        if (typeof __ncSelect !== 'function') return Promise.resolve(null);
        return __ncSelect({
            title: '选择节次时间',
            message: '学校的节次时间随校区和季节不同。请选择你现在适用的一种，选错会让所有课的上课时间整体偏移。',
            items: [
                '建设东路校区 / 平原湖校区 · 非夏季作息（第 1 节 08:00，第 5 节 14:30）',
                '建设东路校区 / 平原湖校区 · 夏季作息（第 1 节 08:00，第 5 节 15:00）',
                '创新港校区（第 1 节 08:30，第 5 节 14:00）'
            ],
            defaultIndex: 0
        }).then(function (index) {
            if (typeof index !== 'number' || index < 0 || index >= TIMETABLE_KEYS.length) return null;
            return TIMETABLE_KEYS[index];
        }, function () {
            return null;
        });
    }

    if (onLoginPage()) throw new Error(LOGIN_TEXT);
    if (!onJwHost()) throw new Error(NOT_JW_TEXT);

    return resolveTerm().then(function (term) {
        return fetchRows(term).then(function (rows) {
            if (!rows.length) {
                throw new Error(
                    '教务系统里这个学期（' + (term.name || term.code) + '）还没有课表数据：可能是课表还没发布。' +
                    '请先在教务系统的课表页面里切到有课的学期，再点「提取课表」'
                );
            }
            return fetchWeekOne(term).then(function (weekOne) {
                return askTimetable().then(function (timetable) {
                    return JSON.stringify({
                        term: term,
                        today: todayIso(),
                        timetable: timetable,
                        weekOne: weekOne,
                        rows: rows
                    });
                });
            });
        });
    });
})()
