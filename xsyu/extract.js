(function () {
    // 西安石油大学 · 超星（chaoxing）综合教学管理系统 —— 取数段（第一步）。
    //
    // 移植自 shiguang_warehouse 的 XSYU/xsyu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，维护者 dr1am1）
    // 上游快照 7c9e190；本校脚本最后一次修改 be8d720（2026-10-25）。
    // 移植改动（逐条与 AUDIT.md §4 对应）：
    //   ① 解析（课程合并、周次切段、节次时间校验、校区节次表）全部搬到 parse.js，这里只把教务数据原样搬出来；
    //   ② 学年学期不再弹窗选：取课表页下拉框里「当前选中」的学期（上游 ASK_SEMESTER 的默认项）；
    //   ③ 上课校区从课程行自带的 xqid / xqmc 判断；只有判不出校区名、教务也没给节次时间时，才用 __ncSelect 问一次；
    //   ④ 学生标识 #xhid 只用于本次请求，**不写进输出**；输出只留 parse.js 用得到的字段（字段白名单）；
    //   ⑤ 登录页 / 统一认证页上点「提取课表」只给一句大白话，不发请求；
    //   ⑥ 上游的确认弹窗、进度提示、写库（保存课程 / 节次时间 / 学期配置）全部去掉，交给应用统一处理。
    //
    // 取数方式：**同源接口**，全部是 GET，不写页面、不提交表单：
    //   1. /admin/pkgl/xskb/queryKbForXsd            课表页 HTML → #xhid、#xqdm 与学年学期下拉框
    //   2. /admin/xsd/pkgl/xskb/sdpkkbList           课程数据（按小节返回，每行自带 xqid / xqmc）
    //   3. /admin/api/getZclistByXnxq                周次表（开学日、总周数）+ 节次时间；取不到不影响课程
    // 请求域：**只有当前页面这一台主机**，全部用相对路径，allowHosts 为空（见 AUDIT.md §1）。

    var KB_PAGE_PATH = '/admin/pkgl/xskb/queryKbForXsd';
    var LIST_PATH = '/admin/xsd/pkgl/xskb/sdpkkbList';
    var WEEK_PATH = '/admin/api/getZclistByXnxq';

    // 课程行、周次行、节次行各只留下这些字段；学分、人员 ID、姓名等一律不带出
    var ROW_FIELDS = ['kcmc', 'tmc', 'croommc', 'xingqi', 'djc', 'zcstr', 'xqid', 'xqmc'];
    var WEEK_FIELDS = ['zc', 'minrq'];
    var SLOT_FIELDS = ['jc', 'kssj', 'jssj'];

    // 只有判不出校区名、教务也没给节次时间时才问，选项与 parse.js 的校区节次表名字一致
    var CAMPUS_LABELS = ['雁塔校区', '明德校区', '鄠邑校区'];

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pick(source, fields) {
        var out = {};
        var item = source && typeof source === 'object' ? source : {};
        for (var i = 0; i < fields.length; i++) {
            var key = fields[i];
            if (item[key] !== undefined && item[key] !== null) out[key] = item[key];
        }
        return out;
    }

    function listOf(value) {
        return Array.isArray(value) ? value : [];
    }

    // 课程行的外壳只在这里认一次：裸数组、{data:[…]}、{data:{list:[…]}} 都接；认不出返回 null
    function rowsOf(json) {
        var data = json.data;
        if (Array.isArray(data)) return data;
        if (data && typeof data === 'object') {
            var keys = ['list', 'rows', 'records'];
            for (var i = 0; i < keys.length; i++) {
                if (Array.isArray(data[keys[i]])) return data[keys[i]];
            }
        }
        return null;
    }

    function isLoginPage() {
        var href = window.location.href;
        return href.indexOf('/admin/login') >= 0 || href.indexOf('slogin') >= 0;
    }

    function statusError(status) {
        if (status === 401 || status === 403) {
            return new Error('教务系统拒绝访问（代码 ' + status + '）：请先在页面里登录，再点「提取课表」');
        }
        return new Error('教务系统返回错误（代码 ' + status + '）：请确认已登录，并停留在教务系统内部页面后再点「提取课表」');
    }

    function linkError() {
        return new Error('连不上教务系统：请确认网络正常，并已在页面里登录后再点「提取课表」');
    }

    function formatError() {
        return new Error('教务系统返回的内容不是课表数据：登录状态可能已失效，请在页面里重新登录后再点「提取课表」');
    }

    // 同源 GET 取 JSON。ret 不为 0 按教务报错处理（只报代码，不回显教务原话）
    function getJson(path) {
        var options = {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' }
        };
        return fetch(path, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw statusError(response.status);
            // 登录失效时教务多半 302 到一个非 JSON 页面，把「解析不出」翻成人话
            return response.json().then(null, function () {
                throw formatError();
            });
        }, function () {
            throw linkError();
        }).then(function (json) {
            if (!json || typeof json !== 'object') throw formatError();
            if (json.ret !== undefined && json.ret !== null && String(json.ret) !== '0') {
                throw new Error('教务系统返回错误（代码 ' + textOf(json.ret) + '）：请确认已登录，并在页面里重新打开课表后再点「提取课表」');
            }
            return json;
        });
    }

    // 课表页：学生标识、校区代号、学年学期下拉框都从这里取。不用首页的同名元素（首页 #xhid 是用户 ID，会返回错误）
    function readKbPage() {
        return fetch(KB_PAGE_PATH, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw statusError(response.status);
            return response.text();
        }, function () {
            throw linkError();
        }).then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var xhidEl = doc.querySelector('#xhid');
            var xqdmEl = doc.querySelector('#xqdm');
            var xhid = xhidEl ? textOf(xhidEl.value) : '';
            var xqdm = xqdmEl ? textOf(xqdmEl.value) : '';
            if (!xhid || !xqdm) {
                throw new Error('没能在课表页上找到学生标识，请先在教务系统里打开「课表查询」页面，再点「提取课表」');
            }

            // 下拉框取「当前选中」的学期，没有选中就取第一个有值的（与上游的默认项一致）
            var select = doc.querySelector('#xnxq1');
            var options = select ? select.options : [];
            var chosen = null;
            for (var i = 0; i < options.length; i++) {
                if (!textOf(options[i].value)) continue;
                if (!chosen) chosen = options[i];
                if (options[i].selected) {
                    chosen = options[i];
                    break;
                }
            }
            if (!chosen) {
                throw new Error('没能读到学年学期，请先在教务系统里打开「课表查询」页面，再点「提取课表」');
            }
            return {
                xhid: xhid,
                xqdm: xqdm,
                term: { code: textOf(chosen.value), text: textOf(chosen.textContent) }
            };
        });
    }

    // 上课校区：课程行自带的 xqid / xqmc，取课程最多的那个；行上没有校区时沿用课表页的 #xqdm。
    // 这里只挑出请求周次表要用的校区代号，作息怎么用由 parse.js 决定。
    function pickCampus(rows, pageXqdm) {
        var tally = {};
        var order = [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i] || {};
            var xqid = textOf(row.xqid);
            var xqmc = textOf(row.xqmc);
            if (!xqid && !xqmc) continue;
            var key = 'k:' + (xqid || xqmc);
            if (!tally[key]) {
                tally[key] = { xqid: xqid, xqmc: xqmc, rows: 0 };
                order.push(key);
            }
            tally[key].rows += 1;
        }
        var best = null;
        for (var j = 0; j < order.length; j++) {
            if (!best || tally[order[j]].rows > best.rows) best = tally[order[j]];
        }
        if (!best) return { xqid: textOf(pageXqdm), xqmc: '' };
        return best;
    }

    // 周次表与节次时间：失败不影响课程，返回空数组，由 parse.js 推算并写进提醒
    function fetchWeekData(termCode, campus) {
        var url = WEEK_PATH + '?xnxq=' + encodeURIComponent(termCode) +
            '&xqid=' + encodeURIComponent(campus.xqid || campus.xqmc);
        return getJson(url).then(function (json) {
            var data = json.data && typeof json.data === 'object' ? json.data : {};
            return {
                weeks: listOf(data.zclist).map(function (item) { return pick(item, WEEK_FIELDS); }),
                slots: listOf(data.jcsjszList).map(function (item) { return pick(item, SLOT_FIELDS); })
            };
        }, function () {
            return { weeks: [], slots: [] };
        });
    }

    // 判不出校区名、教务也没给节次时间：问一次。取消（或提问桥不可用）返回 null，parse.js 据此不猜节次时间
    function askCampus() {
        // 不用 __ncCapabilities 判断：脚本里出现这个名字，宿主会把本适配器当成「要用 OCR」的，每次都先等一遍引擎
        if (typeof window.__ncSelect !== 'function') return Promise.resolve(null);

        return window.__ncSelect({
            title: '选择你所在的校区',
            message: '教务没有给出节次时间，也判断不出上课校区。不清楚就取消，' +
                '本次导入会用默认的节次时间，导入后再到学期管理里核对。',
            items: CAMPUS_LABELS,
            defaultIndex: 0
        }).then(function (index) {
            var picked = parseInt(index, 10);
            if (index === null || index === undefined || isNaN(picked)) return null;
            if (picked < 0 || picked >= CAMPUS_LABELS.length) return null;
            return CAMPUS_LABELS[picked];
        }, function () {
            return null;
        });
    }

    function run() {
        if (isLoginPage()) {
            return Promise.reject(new Error('当前是登录页面，请先在教务系统里完成登录，并进入任意教务页面后再点「提取课表」'));
        }

        var page = null;
        var rawRows = null;
        var campus = null;
        var result = null;
        var asked = null;

        return readKbPage().then(function (info) {
            page = info;
            var url = LIST_PATH + '?xnxq=' + encodeURIComponent(page.term.code) +
                '&xhid=' + encodeURIComponent(page.xhid) +
                '&xqdm=' + encodeURIComponent(page.xqdm) + '&xskbxslx=0';
            return getJson(url);
        }).then(function (json) {
            rawRows = rowsOf(json);
            if (!rawRows) {
                throw new Error('没有读到课表数据：教务系统的返回格式可能变了，请在页面里重新登录后再点「提取课表」');
            }
            if (!rawRows.length) {
                throw new Error('这个学期（' + page.term.text + '）没有找到课程，请确认已在教务系统里切到正确的学期，并且已经排课');
            }
            campus = pickCampus(rawRows, page.xqdm);
            return fetchWeekData(page.term.code, campus);
        }).then(function (week) {
            result = week;
            // 校区名判不出、节次时间也没给：问一次（只在这种情况下才问）
            if (!campus.xqmc && !result.slots.length) {
                return askCampus().then(function (name) {
                    asked = name;
                });
            }
        }).then(function () {
            var rows = rawRows.map(function (row) { return pick(row, ROW_FIELDS); });
            return JSON.stringify({
                term: { code: page.term.code, text: page.term.text },
                campus: { xqid: campus.xqid, xqmc: campus.xqmc },
                askedCampus: asked,
                rows: rows,
                slots: result.slots,
                weeks: result.weeks
            });
        });
    }

    return run();
})()
