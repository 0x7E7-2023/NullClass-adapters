(function () {
    // 河南城建学院 · 超星（chaoxing）教务管理系统 —— 取数段（第一步）。
    //
    // 移植自 shiguang_warehouse 的 HUUC/huuc_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者「拉里」，基于 b1n23 的超星通用脚本）
    // 上游快照 29498b0；本校脚本最后一次修改是 80e30cf（批量合并，提交者星河欲转，不是作者）。
    // 本校走 http，端口 8061：请求全是相对路径，所以同源即可，不需要写主机。
    // 模板：已审计的 ustl（同为超星三接口 + 课表页）。
    // 移植改动（逐条与 AUDIT.md 第 4 节对应）：
    //   1. 解析（课程合并、周次切段、节次校验、开学日）全部搬到 parse.js，这里只把教务数据原样搬出来；
    //   2. 学年学期不再弹窗：取课表页下拉框里当前选中的学期；选不中就用第一个有值的选项；
    //   3. 校区：页面上已有校区代号就直接用，不再弹窗。没有代号才请求校区列表：只有一个就用它，有多个才问一次；
    //   4. 节次时间：教务给的 jcsjszList 有效就直接用，不问；无效或缺失才问一次夏季 / 冬季（有提问桥）。
    //      取消或没有提问桥，交给 parse.js 按夏季表导入并写进提醒，不中止（上游弹窗始终用用户选择，这里改为只在需要时问）；
    //   5. 学生标识只用于本次请求，不写进输出。输出只留 parse.js 用得到的字段（字段白名单）；
    //   6. 登录页、统一认证页、门户首页上点「提取课表」只给一句大白话，不发请求；
    //   7. 上游的确认弹窗、进度提示、写库（保存课程、节次时间、学期配置）全部去掉，交给应用统一处理。
    //
    // 取数方式：同源 GET，不写页面、不提交表单。
    //   1. /admin/pkgl/xskb/queryKbForXsd          不在课表页、页面上又没有学生标识时，抓课表页补参数
    //   2. /admin/api/jcsj/xqsj/getXqList           仅当页面没有校区代号
    //   3. /admin/xsd/pkgl/xskb/sdpkkbList          课程数据
    //   4. /admin/api/getZclistByXnxq               周次表与教务节次时间；取不到不影响课程
    // 请求域：只有当前页面这一台主机，全部用相对路径，allowHosts 为空（见 AUDIT.md）。

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
        return new Error('没能在课表页上找到学生标识，请先在教务系统里打开「我的课表」页面，再点「提取课表」');
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
        if (kind === 'login') {
            return Promise.reject(new Error('当前是登录页面，请先在教务系统里完成登录，并打开「我的课表」后再点「提取课表」'));
        }
        if (kind === 'portal') {
            return Promise.reject(new Error('当前不是课表页面，请先在教务系统里打开「信息查询」中的「我的课表」，再点「提取课表」'));
        }
        var path = String(window.location.pathname || '');
        var onKb = path.indexOf(KB_PAGE_PATH) >= 0;
        var local = readParams(document);
        if (onKb || (local.xhid && local.term)) {
            if (!local.xhid) return Promise.reject(needId());
            if (!local.term) return Promise.reject(needTerm());
            return Promise.resolve(local);
        }
        return fetchKbPage().then(function (info) {
            if (!info.xhid) throw needId();
            if (!info.term) throw needTerm();
            return info;
        });
    }

    // 多个校区且页面没给代号：问一次。取消或提问桥不可用返回 null
    function askCampus(labels) {
        if (typeof window.__ncSelect !== 'function') return Promise.resolve(null);
        return window.__ncSelect({
            title: '选择你所在的校区',
            message: '页面上没有校区，不同校区的课表不一样。不清楚就取消，本次先不导入。',
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

    // 教务节次时间能不能直接用：与 parse.js 的 serverSlotsOf 同一规则，两处要一起改。
    // 无效的节次项跳过（同 parse.js），剩下的必须从 1 连续、每节有开始有结束、不重叠
    function clockOf(value) {
        var m = /^([0-9]{1,2}):([0-9]{2})(:[0-9]{2})?$/.exec(textOf(value));
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var mi = parseInt(m[2], 10);
        if (h > 23 || mi > 59) return null;
        return h * 60 + mi;
    }

    function timesUsable(list) {
        if (!Array.isArray(list) || !list.length) return false;
        var got = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            var n = /^[0-9]{1,3}$/.test(textOf(item.jc)) ? parseInt(textOf(item.jc), 10) : 0;
            var s = clockOf(item.kssj);
            var e = clockOf(item.jssj);
            if (n && s !== null && e !== null) got.push({ n: n, s: s, e: e });
        }
        got.sort(function (a, b) { return a.n - b.n; });
        for (var k = 0; k < got.length; k++) {
            if (got[k].n !== k + 1 || got[k].e <= got[k].s || (k > 0 && got[k].s < got[k - 1].e)) return false;
        }
        return got.length > 0;
    }

    // 教务没给可用的节次时间才问一次：夏季、冬季只差第 5 至 8 节（冬季早 30 分钟）。
    // 返回 'summer' / 'winter'；取消或没有提问桥返回 null（parse.js 按夏季导入并提醒）
    function askSeason() {
        if (typeof window.__ncSelect !== 'function') return Promise.resolve(null);
        return window.__ncSelect({
            title: '选择本学期的节次时间',
            message: '没能从教务系统读到节次时间。冬季的第 5 至 8 节比夏季提前 30 分钟，请按学校本学期实际使用的选择；不清楚就取消，将按夏季导入。',
            items: ['夏季（第 5 节 14:30 开始）', '冬季（第 5 节 14:00 开始）'],
            defaultIndex: 0
        }).then(function (index) {
            var picked = parseInt(index, 10);
            if (index === null || index === undefined || isNaN(picked)) return null;
            if (picked === 0) return 'summer';
            if (picked === 1) return 'winter';
            return null;
        }, function () {
            return null;
        });
    }

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
        var season = null;
        var rawRows = null;
        var week = null;
        return resolvePage().then(function (info) {
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
            return timesUsable(week.slots) ? null : askSeason();
        }).then(function (picked) {
            season = picked;
            var xqmc = campus.xqmc || nameFromRows(rawRows, campus.xqdm);
            var rows = rawRows.map(function (row) { return pick(row, ROW_FIELDS); });
            return JSON.stringify({
                term: { code: page.term.code, text: page.term.text },
                campus: { xqid: campus.xqdm, xqmc: xqmc },
                askedCampus: campus.asked,
                season: season,
                rows: rows,
                slots: week.slots,
                weeks: week.weeks
            });
        });
    }

    return run();
})()
