(function () {
    // 长沙工业学院 · 超星教务 —— 取数段（第一步）。
    //
    // 移植自 shiguang_warehouse 的 CCSUT/ccsut_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 小漫君，派生自 b1n23 超星通用脚本）
    // 上游快照 29498b0；本校脚本最后一次修改 5b33178。结构模板是已审计的 ustl（同为超星三接口）。
    // 移植改动（逐条与 AUDIT.md 第 4 节对应）：
    //   1. 解析（课程合并、周次切段、节次校验、开学日）全部搬到 parse.js，这里只把教务数据原样搬出来；
    //   2. 学期不弹窗：取课表入口页下拉框里当前选中的学期（上游的选择框默认也是它）；
    //   3. 校区不弹窗：入口页有校区代号就直接用（上游的默认也是它）；入口页没有才请求校区列表，只有一个就用，多个才问一次；
    //   4. 只在 tls.ccsut.cn 本站取数。统一认证页、智慧校园页、登录页、门户页上点「提取课表」只给一句大白话，不发请求；
    //   5. 学生标识只用于本次请求，不写进输出；课程行按字段白名单挑；
    //   6. 上游的确认框、进度提示和保存课程 / 节次时间 / 开学日（应用桥）全部去掉，交给应用统一处理。
    //
    // 取数方式：同源 GET，不写页面、不提交表单，不读当前页面的课表 DOM（入口参数来自下面的入口页 HTML）。
    //   1. /admin/pkgl/xskb/queryKbForXsd          入口页 HTML：学生标识、校区代号、学年学期下拉框
    //   2. /admin/api/jcsj/xqsj/getXqList           仅当入口页没有校区代号
    //   3. /admin/xsd/pkgl/xskb/sdpkkbList          课程数据
    //   4. /admin/api/getZclistByXnxq               周次表与节次时间；取不到不影响课程
    // 请求域：tls.ccsut.cn 一台主机，全部用相对路径，allowHosts 为 ["tls.ccsut.cn"]（见 AUDIT.md）。

    var HOST = 'tls.ccsut.cn';
    var KB_PAGE_PATH = '/admin/pkgl/xskb/queryKbForXsd';
    var CAMPUS_PATH = '/admin/api/jcsj/xqsj/getXqList';
    var LIST_PATH = '/admin/xsd/pkgl/xskb/sdpkkbList';
    var WEEK_PATH = '/admin/api/getZclistByXnxq';

    var ROW_FIELDS = ['kcmc', 'tmc', 'croommc', 'xingqi', 'djc', 'zcstr', 'xqid', 'xqmc'];
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

    // 只看地址，不发请求：不是本站、登录页、门户页分别给不同的提示
    function pageKind() {
        var host = String(window.location.hostname || '');
        var href = String(window.location.href || '');
        var path = String(window.location.pathname || '');
        if (host !== HOST) return 'outside';
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

    // 入口页 HTML 只读三样：学生标识、校区代号、学年学期下拉框（当前选中项，没有就第一个有值的）
    function readParams(doc) {
        var xhidEl = doc.querySelector('#xhid');
        var xqdmEl = doc.querySelector('#xqdm');
        var xhid = xhidEl ? textOf(xhidEl.value) : '';
        var xqdm = xqdmEl ? textOf(xqdmEl.value) : '';
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
        return {
            xhid: xhid,
            xqdm: xqdm,
            term: chosen ? { code: textOf(chosen.value), text: textOf(chosen.textContent) } : null
        };
    }

    function needId() {
        return new Error('没能在教务系统里读到学生标识，请先在教务系统里打开「我的课表」页面，再点「提取课表」');
    }

    function needTerm() {
        return new Error('没能读到学年学期，请先在教务系统里打开「我的课表」页面，再点「提取课表」');
    }

    function fetchKbPage() {
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
            return readParams(new DOMParser().parseFromString(html, 'text/html'));
        });
    }

    function resolvePage() {
        var kind = pageKind();
        if (kind === 'outside') {
            return Promise.reject(new Error('请先从智慧校园进入教务系统，再点「提取课表」（不需要打开课表页面）'));
        }
        if (kind === 'login') {
            return Promise.reject(new Error('当前是登录页面，请先在教务系统里完成登录，再点「提取课表」'));
        }
        if (kind === 'portal') {
            return Promise.reject(new Error('当前还在教务系统首页，请先在里面打开任一功能页面，再点「提取课表」'));
        }
        return fetchKbPage();
    }

    // 多个校区且入口页没给代号：问一次。取消或提问桥不可用返回 null
    function askCampus(labels) {
        if (typeof window.__ncSelect !== 'function') return Promise.resolve(null);
        return window.__ncSelect({
            title: '选择你所在的校区',
            message: '入口页上没有校区，不同校区的课表和节次时间不一样。不清楚就取消，本次先不导入。',
            items: labels,
            defaultIndex: 0
        }).then(function (index) {
            var picked = parseInt(index, 10);
            if (index === null || index === undefined || isNaN(picked)) return null;
            if (picked < 0 || picked >= labels.length) return null;
            return picked;
        }, function () {
            return null;
        });
    }

    function ensureCampus(page) {
        if (page.xqdm) return Promise.resolve({ xqdm: page.xqdm, xqmc: '', asked: null });
        return getJson(CAMPUS_PATH).then(function (json) {
            var data = listOf(json.data);
            var list = [];
            for (var i = 0; i < data.length; i++) {
                var item = data[i] || {};
                var id = textOf(item.id);
                var name = textOf(item.xqmc);
                if (!id) continue;
                list.push({ xqdm: id, xqmc: name || id });
            }
            if (!list.length) {
                throw new Error('没能读到校区，请先在教务系统里打开「我的课表」页面，再点「提取课表」');
            }
            if (list.length === 1) return { xqdm: list[0].xqdm, xqmc: list[0].xqmc, asked: null };
            var labels = [];
            for (var j = 0; j < list.length; j++) labels.push(list[j].xqmc);
            return askCampus(labels).then(function (index) {
                if (index === null) {
                    throw new Error('没有选择校区，不同校区的课表不一样，请重新点「提取课表」并选择校区');
                }
                return { xqdm: list[index].xqdm, xqmc: list[index].xqmc, asked: list[index].xqmc };
            });
        });
    }

    // 周次表与节次时间：取不到不影响课程，返回空表（parse.js 会写提醒）
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

    // 入口页没给校区名时，用课程行里与这个代号相符、出现最多的校区名
    function nameFromRows(rows, xqdm) {
        var tally = {};
        var best = '';
        var bestN = 0;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i] || {};
            if (textOf(row.xqid) && textOf(row.xqid) !== xqdm) continue;
            var name = textOf(row.xqmc);
            if (!name) continue;
            tally[name] = (tally[name] || 0) + 1;
            if (tally[name] > bestN) {
                bestN = tally[name];
                best = name;
            }
        }
        return best;
    }

    function run() {
        var page = null;
        var campus = null;
        var rawRows = null;
        var week = null;
        return resolvePage().then(function (info) {
            if (!info.xhid) throw needId();
            if (!info.term) throw needTerm();
            page = info;
            return ensureCampus(page);
        }).then(function (picked) {
            campus = picked;
            var url = LIST_PATH + '?xnxq=' + encodeURIComponent(page.term.code) +
                '&xhid=' + encodeURIComponent(page.xhid) +
                '&xqdm=' + encodeURIComponent(campus.xqdm) + '&xskbxslx=0';
            return getJson(url);
        }).then(function (json) {
            rawRows = rowsOf(json);
            if (!rawRows) {
                throw new Error('没有读到课表数据：教务系统的返回格式可能变了，请在页面里重新登录后再点「提取课表」');
            }
            if (!rawRows.length) {
                throw new Error('这个学期（' + page.term.text + '）没有找到课程，请确认已在教务系统里切到正确的学期，并且已经排课');
            }
            return fetchWeekData(page.term.code, campus.xqdm);
        }).then(function (result) {
            week = result;
            var xqmc = campus.xqmc || nameFromRows(rawRows, campus.xqdm);
            var rows = rawRows.map(function (row) { return pick(row, ROW_FIELDS); });
            return JSON.stringify({
                term: { code: page.term.code, text: page.term.text },
                campus: { xqid: campus.xqdm, xqmc: xqmc },
                askedCampus: campus.asked,
                rows: rows,
                slots: week.slots,
                weeks: week.weeks
            });
        });
    }

    return run();
})()
