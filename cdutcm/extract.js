(function () {
    // 成都中医药大学教务适配器（广州乘方 / Struts2，xsgrkbcx 族，jwweb.cdutcm.edu.cn）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 CDUTCM/cdutcm_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4（2026-11-01 与 origin/main 对齐）
    //   本校脚本最后一次修改 80e30cf（核对过，与任务卡一致）
    //   adapters.yaml 的 maintainer 是 wwwhyDB；脚本正文没有署名。manifest.author 用上游名单里的 wwwhyDB
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① ES6 改成 ES5：异步改成 then 链，不用模板串、箭头函数、解构、块级声明、Set
    //   ② 不弹窗选学期，也不问开学日期。页面上有学期下拉框就读此刻选中的；没有再取一次学期列表页，读标了 selected 的那一项；
    //      一项都没标又有多个学期时，才用提问桥问一次（桥不在就取列表第一项，由 parse.js 提醒）
    //   ③ 两个接口都保留，不并成一个：课表页源码里的 kbxx 只留课名、教师、备用地点、星期、周次、节次；
    //      每个教学任务号再请求排课详情，只留课名、星期、节次、单周次、精确地点。学号、姓名等一律不带出，教学任务号本身也不交出去
    //   ④ 开学日只做一次尽力探测（第 1 周的日期）。失败就交空，由 parse.js 按学期推算并提醒。上游是弹窗让人填日期，这里不弹
    //   ⑤ 登录页上有密码框就直接提示，不发请求（只看有没有，不读里面的字）。会话失效时页面既没有课表数据也没有课表表格，同样给大白话提示
    //   ⑥ 上游的弹窗、提示条、保存课表和节次时间的宿主调用全部不移植。缺教师、缺教室交原值，由 parse.js 记成空并提醒
    //
    // 取数方式：同源 GET，相对路径（与 loginUrl 同源，所以 allowHosts 为空）：
    //   ① /xsgrkbcx!getXsgrbkList.action                         学期列表（页面上已有学期下拉框时跳过）
    //   ② /xsgrkbcx!xsAllKbList.action?xnxqdm=                   课表页，源码里有 var kbxx = [ ... ]
    //   ③ /xsgrkbcx!getSkxxDataList.action?kcrwdm=&teadm=        每个教学任务的逐周排课（精确地点）
    //   ④ /xsgrkbcx!getKbRq.action?xnxqdm=&zc=1                  第 1 周日期（探测，失败即放弃）
    // 登录由用户在页面里完成。本脚本不读、不存、不上报账号。
    //
    // 输出：{ term, today, dateInfo, tasks, details, detailFailed }
    //   tasks[i]：kcmc / teaxms / jxcdmcs / xq / zcs / jcdm2
    //   details[i]：kcmc / xq / jcdm2 / zc / jxcdmc
    //   detailFailed：没有拿到排课详情的教学任务个数

    var LIST_URL = '/xsgrkbcx!getXsgrbkList.action';
    var KB_URL = '/xsgrkbcx!xsAllKbList.action';
    var SK_URL = '/xsgrkbcx!getSkxxDataList.action';
    var DATE_URL = '/xsgrkbcx!getKbRq.action';
    var MAX_PAGE_BODY = 3000000;
    var MAX_DATE_BODY = 200000;
    var MAX_JSON_BODY = 3000000;
    var MAX_CHOICES = 12;
    var MAX_FIELD_TEXT = 300;
    var TASK_FIELDS = ['kcmc', 'teaxms', 'jxcdmcs', 'xq', 'zcs', 'jcdm2'];
    var DETAIL_FIELDS = ['kcmc', 'xq', 'jcdm2', 'zc', 'jxcdmc'];
    var NOT_IN_JW = '请先登录教务系统，打开「我的课表」后再点「提取课表」';
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

    function clip(value) {
        var line = asText(value);
        return line.length > MAX_FIELD_TEXT ? line.substring(0, MAX_FIELD_TEXT) : line;
    }

    // 周次在课表页里经常是数组。数组收成逗号分隔的文字再交出去，对象丢掉
    function clipField(value) {
        if (value === null || value === undefined) return '';
        if (Object.prototype.toString.call(value) === '[object Array]') {
            var parts = [];
            for (var i = 0; i < value.length; i++) {
                if (value[i] === null || value[i] === undefined) continue;
                if (typeof value[i] === 'object') continue;
                parts.push(asText(value[i]));
            }
            return clip(parts.join(','));
        }
        if (typeof value === 'object') return '';
        return clip(value);
    }

    function termsOf(select, live) {
        var items = [];
        var marked = -1;
        if (!select || typeof select.querySelectorAll !== 'function') return null;
        var options = select.querySelectorAll('option');
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var code = trimText(option.value !== undefined ? option.value : option.getAttribute('value'));
            if (!code) continue;
            var name = trimText(option.textContent);
            var isMarked = live ? (select.selectedIndex === i) : option.hasAttribute('selected');
            if (isMarked && marked < 0) marked = items.length;
            items.push({ code: code, name: name });
        }
        return items.length ? { items: items, marked: marked } : null;
    }

    function fetchTermList() {
        return fetch(LIST_URL, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：请先登录，打开「我的课表」后再点「提取课表」');
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效，请重新登录后再点「提取课表」');
        }).then(function (html) {
            if (typeof html !== 'string' || html.length > MAX_PAGE_BODY) throw new Error(NOT_IN_JW);
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var found = termsOf(doc.getElementById('xnxqdm'), false);
            if (!found) throw new Error(NOT_IN_JW);
            return found;
        });
    }

    function loadTerms() {
        var liveSelect = document.getElementById('xnxqdm');
        var live = termsOf(liveSelect, true);
        if (live) {
            live.live = true;
            return Promise.resolve(live);
        }
        return fetchTermList().then(function (found) {
            found.live = false;
            return found;
        });
    }

    function chooseTerm(found) {
        var items = found.items;
        if (found.marked >= 0) {
            return Promise.resolve({ term: items[found.marked], source: found.live ? 'page' : 'default' });
        }
        if (items.length === 1) return Promise.resolve({ term: items[0], source: 'default' });
        if (typeof __ncCapabilities === 'undefined' || !__ncCapabilities || !__ncCapabilities.ask || typeof __ncSelect !== 'function') {
            return Promise.resolve({ term: items[0], source: 'first' });
        }
        var shown = items.length > MAX_CHOICES ? items.slice(0, MAX_CHOICES) : items;
        var labels = [];
        for (var i = 0; i < shown.length; i++) {
            var label = shown[i].name || shown[i].code;
            labels.push(label.length > 60 ? label.substring(0, 59) + '…' : label);
        }
        return __ncSelect({
            title: '选择要导入的学期',
            message: '教务系统没有标出当前学期，请选择你要导入的学期：',
            items: labels,
            defaultIndex: 0
        }).then(function (index) {
            if (typeof index !== 'number' || index < 0 || index >= shown.length) {
                throw new Error('已取消导入，没有选择学期');
            }
            return { term: shown[index], source: 'user' };
        });
    }

    // 按括号配对取出 var kbxx = [ ... ]，跳过字符串里的括号，避免课名里的右括号把数组截断
    function kbxxText(html) {
        var head = /var\s+kbxx\s*=\s*\[/.exec(html);
        if (!head) return null;
        var begin = head.index + head[0].length - 1;
        var depth = 0;
        var inString = false;
        var quote = '';
        for (var i = begin; i < html.length; i++) {
            var ch = html.charAt(i);
            if (inString) {
                if (ch === '\\') { i++; continue; }
                if (ch === quote) inString = false;
                continue;
            }
            if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
            if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) return html.substring(begin, i + 1);
            }
        }
        return null;
    }

    function pickTask(item) {
        var out = {};
        for (var i = 0; i < TASK_FIELDS.length; i++) {
            out[TASK_FIELDS[i]] = clipField(item ? item[TASK_FIELDS[i]] : '');
        }
        return out;
    }

    function pickDetail(item) {
        var out = {};
        for (var i = 0; i < DETAIL_FIELDS.length; i++) {
            out[DETAIL_FIELDS[i]] = clipField(item ? item[DETAIL_FIELDS[i]] : '');
        }
        return out;
    }

    function fetchTasks(code) {
        return fetch(KB_URL + '?xnxqdm=' + encodeURIComponent(code), {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：请先登录，打开「我的课表」后再点「提取课表」');
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效，请重新登录后再点「提取课表」');
        }).then(function (html) {
            if (typeof html !== 'string' || html.length > MAX_PAGE_BODY) {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            var arrayText = kbxxText(html);
            if (arrayText === null) {
                if (/<table[^>]*class\s*=\s*["']kb["']/.test(html)) return { tasks: [], codes: [] };
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            var list = null;
            try {
                list = JSON.parse(arrayText);
            } catch (e) {
                list = null;
            }
            if (!list || typeof list.length !== 'number') {
                throw new Error('教务系统返回的课表格式读不出来，请稍后重试，仍不行请反馈');
            }
            var tasks = [];
            var codes = [];
            var seenCode = {};
            for (var i = 0; i < list.length; i++) {
                tasks.push(pickTask(list[i]));
                var taskCode = trimText(list[i] && list[i].kcrwdm);
                if (taskCode && !seenCode[taskCode]) {
                    seenCode[taskCode] = true;
                    codes.push(taskCode);
                }
            }
            return { tasks: tasks, codes: codes };
        });
    }

    // 某一个教学任务取不到时记失败并继续，不让一门课的失败挡住其余的课
    function fetchOneDetail(taskCode) {
        return fetch(SK_URL + '?kcrwdm=' + encodeURIComponent(taskCode) + '&teadm=', {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return { ok: false, rows: [] };
            return ignoreFailure(response.text()).then(function (body) {
                var parsed = jsonOrNull(body, MAX_JSON_BODY);
                var list = parsed && Object.prototype.toString.call(parsed.rows) === '[object Array]' ? parsed.rows : null;
                if (!list) return { ok: false, rows: [] };
                var rows = [];
                for (var i = 0; i < list.length; i++) rows.push(pickDetail(list[i]));
                return { ok: true, rows: rows };
            });
        }, function () {
            return { ok: false, rows: [] };
        });
    }

    function fetchDetails(codes) {
        var rows = [];
        var failed = 0;
        var index = 0;
        function next() {
            if (index >= codes.length) return Promise.resolve({ rows: rows, failed: failed });
            var taskCode = codes[index];
            index++;
            return fetchOneDetail(taskCode).then(function (res) {
                if (!res.ok) failed++;
                else {
                    for (var i = 0; i < res.rows.length; i++) rows.push(res.rows[i]);
                }
                return next();
            });
        }
        return next();
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

    var loginFields = document.querySelectorAll ? document.querySelectorAll('input[type="password"]') : [];
    if (loginFields && loginFields.length > 0) return fail(ON_LOGIN);

    return loadTerms().then(chooseTerm).then(function (chosen) {
        var code = chosen.term.code;
        return fetchTasks(code).then(function (kb) {
            return Promise.all([fetchDetails(kb.codes), fetchDates(code)]).then(function (result) {
                return JSON.stringify({
                    term: { code: code, name: chosen.term.name, source: chosen.source },
                    today: isoOf(new Date()),
                    dateInfo: result[1],
                    tasks: kb.tasks,
                    details: result[0].rows,
                    detailFailed: result[0].failed
                });
            });
        });
    });
})()
