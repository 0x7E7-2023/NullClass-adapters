(function () {
    // 江西飞行学院教务适配器（Struts2 教务平台 xsgrkbcx 族，jwxt.jxfu.edu.cn）—— 第一步：只取数，把教务的原始排课行交出去。
    //
    // 移植自 shiguang_warehouse 的 JXFU/JXFU_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 dezige131）
    //   上游快照 e15c6274ac347c9642da890504651a9b4e374391（2026-10-26 拉取）
    //   本校脚本最后一次修改 80e30cf（2026-09-23，仓库整理提交）
    // 移植改动（逐条对应 AUDIT.md §4、§5）：
    //   ① ES6 → ES5：异步写法改成 then 链，去掉模板串、箭头函数、解构、块级声明关键字、Set
    //   ② 不弹窗选学期：上游拿到学期下拉框后一律弹「请选择要导入的学期」。这里先读当前页面上的 #xnxqdm（用户正开着「我的课表」页时，
    //      读的就是他此刻选中的那个学期）；页面上没有就取一次上游同一个学期列表页，读被标为 selected 的那一项；
    //      列表里一项都没标、又有多个学期时，才用 __ncSelect 问一次（桥不在就取列表第一项并在提醒里说明）
    //   ③ 上游在脚本里自己抠数据、去重、排周次、存节次时间；这里只把课表页里 var kbxx 那个数组交出去，
    //      每行只留 kcmc / teaxms / jxcdmcs / xq / zcs / jcdm2 六个字段，其余字段（学号、姓名等）一律不带出；
    //      周次、节次解析、去重合并、节次时间与开学日全部挪到 parse.js（CI 里跑得到的那一段）
    //   ④ 上游把整页源码的前 800 字打到控制台（console.error）；这里不输出任何日志
    //   ⑤ 新增一个尽力而为的开学日探测：GET /xsgrkbcx!getKbRq.action?xnxqdm=…&zc=1（同平台的 hbmu 也是这么探的，上游没有这一步，
    //      因为空课的课表必须有开学日）。任何失败（404 / 登录页 / 非 JSON / 超长）都只交 null，由 parse.js 推算开学日并提醒
    //   ⑥ 登录页判断：当前页面上有密码输入框就直接提示先登录，不发请求（只看有没有，不读它的值）；
    //      会话失效时教务返回 200 + 登录页，课表页读不到 kbxx 数组也读不到课表表格，单独给大白话提示
    //   ⑦ 上游的浏览器测试分支（prompt / alert / 控制台输出）与「拾光」的桥调用
    //      （showToast / showSingleSelection / showAlert / saveCourseConfig / savePresetTimeSlots / saveImportedCourses /
    //      notifyTaskCompletion）全部不移植；上游把缺教师写成「未知」、缺教室写成「待定」，这里一律交原值，由 parse.js 记成空并提醒
    //
    // 取数方式：同源请求，最多三个，全部是站点根下的相对路径（与 loginUrl 同源，所以 allowHosts 为空）：
    //   ① GET /xsgrkbcx!getXsgrbkList.action                      学期列表页（页面上已有 #xnxqdm 时跳过）
    //   ② GET /xsgrkbcx!xsAllKbList.action?xnxqdm=<学期代码>      课表页，源码里有 var kbxx = [ ... ];
    //   ③ GET /xsgrkbcx!getKbRq.action?xnxqdm=<学期代码>&zc=1     第 1 周七天的日期（探测，失败即放弃）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 输出：{ term: { code, name, source }, today, dateInfo, rows: [ { kcmc, teaxms, jxcdmcs, xq, zcs, jcdm2 } ] }
    //   term.source —— page（读的是页面上用户选中的学期）/ default（学期列表里标了 selected 的那一项，或只有一项）/
    //                  user（用户在提问里选的）/ first（没有任何标记、桥又不在，取了列表第一项）

    var LIST_URL = '/xsgrkbcx!getXsgrbkList.action';
    var KB_URL = '/xsgrkbcx!xsAllKbList.action';
    var DATE_URL = '/xsgrkbcx!getKbRq.action';
    var MAX_PAGE_BODY = 3000000;   // 课表页 / 列表页超过 3M 字符就不认
    var MAX_DATE_BODY = 200000;    // 日期响应超过这个长度就不认
    var MAX_CHOICES = 12;          // 提问时最多列出的学期个数
    var MAX_FIELD_TEXT = 300;      // 每个字段最多带出的字数
    var FIELDS = ['kcmc', 'teaxms', 'jxcdmcs', 'xq', 'zcs', 'jcdm2'];
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

    // 读一个 <select id="xnxqdm">：live 为 true 表示是当前页面上的（用 selectedIndex，反映用户此刻的选择），
    // 否则是解析出来的列表页（只认写了 selected 属性的项 —— 离线文档里「第一项默认选中」不是教务的标记）
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

    // 取到可选学期：{ items, marked, live }
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

    // 标了 selected 的直接用；没标又有多个学期才问用户；问不了就取第一项
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

    // 从课表页源码里取出 var kbxx = [ ... ]; 的数组文本：按括号配对扫描（跳过字符串里的括号），
    // 比"懒惰匹配到第一个 ];" 更不容易被课名里的符号截断
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

    function pickRow(item) {
        var out = {};
        for (var i = 0; i < FIELDS.length; i++) {
            var value = item ? item[FIELDS[i]] : null;
            if (value === null || value === undefined || typeof value === 'object') continue;
            var line = asText(value);
            out[FIELDS[i]] = line.length > MAX_FIELD_TEXT ? line.substring(0, MAX_FIELD_TEXT) : line;
        }
        return out;
    }

    function fetchRows(code) {
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
                // 页面结构正确（有课表表格）但没有数据 = 这个学期还没排课，交空数组，由 parse.js 说明
                if (/<table[^>]*class\s*=\s*["']kb["']/.test(html)) return [];
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
            var rows = [];
            for (var i = 0; i < list.length; i++) rows.push(pickRow(list[i]));
            return rows;
        });
    }

    // 日期响应里只留 parse.js 要认的两个键（xqmc 星期、rq 日期），其余整棵丢掉；对象 / 数组的层级照旧，
    // parse.js 靠它区分"第 1 周"那一层
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
        return Promise.all([fetchRows(code), fetchDates(code)]).then(function (result) {
            return JSON.stringify({
                term: { code: code, name: chosen.term.name, source: chosen.source },
                today: isoOf(new Date()),
                dateInfo: result[1],
                rows: result[0]
            });
        });
    });
})()
