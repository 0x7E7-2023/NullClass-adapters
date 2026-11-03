(function () {
    // 湖北文理学院 · 超星（chaoxing）教务系统 —— 取数段（第一步）。
    //
    // 移植自 shiguang_warehouse 的 HBUAS/hbuas_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，维护者 salt-fishes）
    // 上游快照 29498b0；本校脚本最后一次修改 80e30cf（2026-09-23，批量合并，提交者不是作者）。
    // 移植改动（逐条与 AUDIT.md 第 4 节对应）：
    //   1. 解析（单节合并、周次切段、节次时间校验、开学日）全部搬到 parse.js，这里只把教务数据原样搬出来；
    //   2. 学年学期不再弹窗：取课表页下拉框里当前选中的学期（上游 ASK_SEMESTER 的默认项）；选不中就用第一个有值的选项；
    //   3. 校区不弹窗：沿用课表页的校区代号（上游 ASK_CAMPUS = false 的默认行为），不再请求校区列表（只为显示名字，空课用不到）；
    //   4. 学生标识 #xhid 只用于本次请求，不写进输出；上游课表页取不到时会退回当前页面的 #xhid，
    //      这里不退：首页的同名元素是用户 ID，拿去查课会返回错误，宁可报错让用户回到课表页；
    //   5. 输出只留 parse.js 用得到的字段（字段白名单）；学分、人员 ID、姓名等一律不带出；
    //   6. 登录页、统一认证页、门户首页上点「提取课表」只给一句大白话，不发请求；
    //   7. 上游的确认弹窗、进度提示、写库（保存课程、节次时间、学期配置）全部去掉，交给应用统一处理。
    //
    // 取数方式：同源 GET，不写页面、不提交表单。
    //   1. /admin/pkgl/xskb/queryKbForXsd          课表页 HTML → #xhid、#xqdm 与学年学期下拉框
    //   2. /admin/xsd/pkgl/xskb/sdpkkbList          课程数据（按单节返回，parse.js 合并）
    //   3. /admin/api/getZclistByXnxq               周次表（开学日、总周数）+ 节次时间；取不到不影响课程
    // 请求域：只有当前页面这一台主机，全部用相对路径，allowHosts 为空（见 AUDIT.md §1）。

    var KB_PAGE_PATH = '/admin/pkgl/xskb/queryKbForXsd';
    var LIST_PATH = '/admin/xsd/pkgl/xskb/sdpkkbList';
    var WEEK_PATH = '/admin/api/getZclistByXnxq';

    // 课程行、周次行、节次行各只留下这些字段；学分、人员 ID、姓名等一律不带出
    var ROW_FIELDS = ['kcmc', 'tmc', 'croommc', 'xingqi', 'djc', 'zcstr'];
    var WEEK_FIELDS = ['zc', 'minrq'];
    var SLOT_FIELDS = ['jc', 'kssj', 'jssj'];

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

    // 课程行的外壳只在这里认一次：裸数组、data 为数组、data 里再套一层列表都接；认不出返回 null
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

    // 当前页面属于哪一类：登录 / 统一认证、门户首页（不发请求，只给提示）、教务内部页面
    function pageKind() {
        var href = String(window.location.href || '');
        var path = String(window.location.pathname || '');
        if (href.indexOf('/admin/login') >= 0 || href.indexOf('slogin') >= 0 || href.indexOf('/cas/') >= 0) {
            return 'login';
        }
        if (path === '/' || path === '/index' || path === '/index.html' ||
            path === '/admin' || path === '/admin/' || path === '/admin/index' ||
            path === '/admin/index.html' || path === '/admin/home') {
            return 'portal';
        }
        return 'inner';
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

    // 同源 GET 取 JSON。返回码不为 0 按教务报错处理（只报代码，不回显教务原话）
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

    // 课表页：学生标识、校区代号、学年学期下拉框都从这里取（不用首页的同名元素，见文件头第 4 条）
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
            if (!select) select = doc.querySelector('select[name="xnxq"]');
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

    // 周次表与节次时间：失败不影响课程，返回空数组，由 parse.js 推算并写进提醒
    function fetchWeekData(termCode, xqdm) {
        var url = WEEK_PATH + '?xnxq=' + encodeURIComponent(termCode) + '&xqid=' + encodeURIComponent(xqdm);
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

    function run() {
        var kind = pageKind();
        if (kind === 'login') {
            return Promise.reject(new Error('当前是登录页面，请先在教务系统里完成登录，并进入任意教务页面后再点「提取课表」'));
        }
        if (kind === 'portal') {
            return Promise.reject(new Error('当前是教务首页，请先在教务系统里点进「课表查询」或任意教务页面后，再点「提取课表」'));
        }

        var page = null;
        var rawRows = null;
        var result = null;

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
            return fetchWeekData(page.term.code, page.xqdm);
        }).then(function (week) {
            result = week;
            var rows = rawRows.map(function (row) { return pick(row, ROW_FIELDS); });
            return JSON.stringify({
                term: { code: page.term.code, text: page.term.text },
                rows: rows,
                slots: result.slots,
                weeks: result.weeks
            });
        });
    }

    return run();
})()
