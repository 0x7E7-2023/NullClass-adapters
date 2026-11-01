(function () {
    // 广东工业大学教务适配器（Struts2 教务平台 xsgrkbcx 族，jxfw.gdut.edu.cn）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 GDUT/gdut.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 forer4433）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4（2026-11-01 与 origin/main 对齐）
    //   本校脚本最后一次修改 933f6f0（2026-10-12，核对过，与任务卡一致）
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① ES6 改成 ES5：异步改成 then 链，去掉模板串、箭头函数、解构、块级声明
    //   ② 不弹窗选学期：页面上有学期下拉框就读用户此刻选中的项；没有就按上游同一套日期规则推算当前学期
    //      （7 月到次年 1 月算秋季，1 月仍算上一学年；2 月到 6 月算春季）。不向用户提问
    //   ③ 上游自己解析节次、拼课程、写入宿主；这里只交原始行。每行只留 kcmc / teaxms / jxcdmc / xq / jcdm / zc
    //   ④ 取课照上游：先探测总条数，再按总条数一次取回。上游注明分页会让教务返回重复或缺课，所以不按页翻
    //   ⑤ 总条数为 0 时，照上游再看课表页是否写着课表未开放，两种情况分开说明
    //   ⑥ 开学日探测失败只交 null，由下一步推算并提醒。登录页、统一认证页不发请求
    //   ⑦ 上游的确认弹窗、宿主保存、控制台输出全部不移植
    //
    // 取数（相对路径，与 loginUrl 同源，allowHosts 为空）：
    //   ① POST /xsgrkbcx!getDataList.action    先 rows=1 看总数，再 rows=总数 取全部
    //   ② GET  /xsgrkbcx!xsAllKbList.action    仅当一条课都没有时，判断课表是否未开放
    //   ③ GET  /xsgrkbcx!getKbRq.action        第 1 周日期，失败即放弃
    // 登录由用户在页面里完成。本脚本不读、不存、不上报账号。
    //
    // 输出：{ term: { code, name, source }, today, dateInfo, total, truncated, rows }
    //   source —— page（读的是页面上选中的学期）/ auto（按日期推算）

    var LIST_URL = '/xsgrkbcx!getDataList.action';
    var OPEN_URL = '/xsgrkbcx!xsAllKbList.action';
    var DATE_URL = '/xsgrkbcx!getKbRq.action';
    var MAX_LIST_BODY = 3000000;
    var MAX_DATE_BODY = 200000;
    var MAX_OPEN_BODY = 3000000;
    var MAX_ROWS = 2000;
    var MAX_FIELD_TEXT = 300;
    var NAME_LIMIT = 30;
    var FIELDS = ['kcmc', 'teaxms', 'jxcdmc', 'xq', 'jcdm', 'zc'];
    var CLOSED_MARK = '本学期课表还未开放，请稍后查询！';
    var ON_LOGIN = '当前打开的是登录页。请先登录教务系统，打开「我的课表」后再点「提取课表」';

    function asText(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function trimText(value) {
        return asText(value).replace(/^\s+|\s+$/g, '');
    }

    function pad2(value) {
        return (value < 10 ? '0' : '') + value;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function shortLabel(value) {
        var line = trimText(value);
        return line.length > NAME_LIMIT ? line.substring(0, NAME_LIMIT - 1) + '…' : line;
    }

    function fail(message) {
        return Promise.reject(new Error(message));
    }

    function ignoreFailure(promise) {
        return promise.then(function (value) { return value; }, function () { return null; });
    }

    function jsonOrNull(body, maxLength) {
        if (typeof body !== 'string' || body.length === 0 || body.length > maxLength) return null;
        try {
            return JSON.parse(body);
        } catch (e) {
            return null;
        }
    }

    // 与上游 selectSemesterSelection 同一套：7 月到次年 1 月是秋季（代码末位 1），2 月到 6 月是春季（末位 2）。
    // 1 月仍属于上一学年的秋季。
    function currentTermCode(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        var semester = (month >= 7 || month <= 1) ? 1 : 2;
        var semesterYear = semester === 1 ? year : year - 1;
        if (month <= 1) semesterYear = semesterYear - 1;
        return semesterYear + '0' + semester;
    }

    function nameOfCode(code) {
        var matched = /^(\d{4})0([12])$/.exec(asText(code));
        if (!matched) return '广东工业大学 ' + asText(code);
        var year = parseInt(matched[1], 10);
        var label = matched[2] === '1' ? '秋季' : '春季';
        return year + '-' + (year + 1) + '学年' + label + '学期';
    }

    function readPageTerm() {
        var select = document.getElementById ? document.getElementById('xnxqdm') : null;
        if (!select || typeof select.querySelectorAll !== 'function') return null;
        var options = select.querySelectorAll('option');
        var index = select.selectedIndex;
        if (typeof index !== 'number' || index < 0 || index >= options.length) return null;
        var option = options[index];
        var code = trimText(option.value !== undefined ? option.value : option.getAttribute('value'));
        if (!code) return null;
        var name = trimText(option.textContent) || nameOfCode(code);
        return { code: code, name: name, source: 'page' };
    }

    function chooseTerm() {
        var fromPage = readPageTerm();
        if (fromPage) return fromPage;
        var code = currentTermCode(new Date());
        return { code: code, name: nameOfCode(code), source: 'auto' };
    }

    function httpError(status) {
        return new Error('教务系统返回错误（代码 ' + status + '）：请先登录，打开「我的课表」后再点「提取课表」');
    }

    function postList(code, rows) {
        var body = 'zc=&xnxqdm=' + encodeURIComponent(code) + '&page=1&rows=' + rows + '&sort=kxh&order=asc';
        return fetch(LIST_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw httpError(response.status);
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效，请重新登录后再点「提取课表」');
        }).then(function (text) {
            var json = jsonOrNull(text, MAX_LIST_BODY);
            if (!json || typeof json !== 'object') {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            return json;
        });
    }

    function checkOpen(code, label) {
        return fetch(OPEN_URL + '?xnxqdm=' + encodeURIComponent(code), {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw httpError(response.status);
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效，请重新登录后再点「提取课表」');
        }).then(function (html) {
            if (typeof html !== 'string' || html.length > MAX_OPEN_BODY) {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            if (html.indexOf(CLOSED_MARK) >= 0) {
                throw new Error('「' + label + '」的课表还没有开放，请过几天再提取');
            }
            throw new Error('教务系统里「' + label + '」还没有排课数据。请打开教务「我的课表」，确认能看到课程后再点「提取课表」');
        });
    }

    function pickValue(value) {
        if (value === null || value === undefined || typeof value === 'object') return undefined;
        if (typeof value === 'number' && isFinite(value)) return value;
        var line = asText(value);
        return line.length > MAX_FIELD_TEXT ? line.substring(0, MAX_FIELD_TEXT) : line;
    }

    function pickRow(item) {
        var out = {};
        for (var i = 0; i < FIELDS.length; i++) {
            var picked = pickValue(item ? item[FIELDS[i]] : undefined);
            if (picked === undefined) continue;
            out[FIELDS[i]] = picked;
        }
        return out;
    }

    function pickDates(node, depth) {
        if (!node || typeof node !== 'object' || depth > 4) return null;
        if (node.xqmc !== undefined && node.rq !== undefined) {
            return { xqmc: asText(node.xqmc), rq: asText(node.rq) };
        }
        var out = {};
        var any = false;
        for (var key in node) {
            if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
            var picked = pickDates(node[key], depth + 1);
            if (picked) { out[key] = picked; any = true; }
        }
        return any ? out : null;
    }

    function fetchDates(code) {
        var request = fetch(DATE_URL + '?xnxqdm=' + encodeURIComponent(code) + '&zc=1', {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return ignoreFailure(response.text()).then(function (body) {
                return pickDates(jsonOrNull(body, MAX_DATE_BODY), 0);
            });
        });
        return ignoreFailure(request);
    }

    function fetchCourses(chosen) {
        var label = shortLabel(chosen.name || nameOfCode(chosen.code));
        return postList(chosen.code, 1).then(function (probe) {
            var reported = parseInt(probe.total, 10);
            var probeRows = (probe.rows && typeof probe.rows.length === 'number') ? probe.rows : [];
            if (isNaN(reported) || reported < 0) {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            if (reported === 0 || probeRows.length === 0) return checkOpen(chosen.code, label);
            var ask = reported;
            var truncated = false;
            if (ask > MAX_ROWS) { ask = MAX_ROWS; truncated = true; }
            return postList(chosen.code, ask).then(function (full) {
                var list = (full.rows && typeof full.rows.length === 'number') ? full.rows : null;
                if (!list) {
                    throw new Error('教务系统返回的课表格式读不出来，请稍后重试，仍不行请反馈');
                }
                var rows = [];
                for (var i = 0; i < list.length; i++) rows.push(pickRow(list[i]));
                return { rows: rows, total: reported, truncated: truncated };
            });
        });
    }

    var host = (window.location && window.location.hostname) ? String(window.location.hostname) : '';
    if (host === 'authserver.gdut.edu.cn') return fail(ON_LOGIN);
    var loginFields = document.querySelectorAll ? document.querySelectorAll('input[type="password"]') : [];
    if (loginFields && loginFields.length > 0) return fail(ON_LOGIN);

    var chosen = chooseTerm();
    return fetchCourses(chosen).then(function (pack) {
        return fetchDates(chosen.code).then(function (dateInfo) {
            return JSON.stringify({
                term: { code: chosen.code, name: chosen.name, source: chosen.source },
                today: isoOf(new Date()),
                dateInfo: dateInfo,
                total: pack.total,
                truncated: pack.truncated === true,
                rows: pack.rows
            });
        });
    });
})()
