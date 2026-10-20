(function () {
    // 厦门城市职业学院教务适配器（青果教务，经学校 WebVPN 子域名访问，部署在 /xmcsjw 下）—— 第一步：只取数，把课表格子里的原始文字原样交出去。
    //
    // 移植自 shiguang_warehouse 的 XMCU/xmcu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf
    //
    // 上游的做法：先要求当前地址以 https://jws-443.webvpn.xmcu.edu.cn/xmcsjw/ 开头，再 POST 一次学期列表让用户在弹窗里选学期，
    // 然后 GET 学生课表页（学年 / 学期编成 Base64 放在 params 参数里，返回 GBK 编码的整页网页），用 DOMParser 在 id 为 mytable 的表格里找
    // td.td（一格一天），格里每个带内联样式 padding-bottom:5px 的 div 是一门课，div 的子节点逐行是「课名 / 教师 / 周次[节次] / 地点」。
    // 上游没有取开学日（只保存课程和写死的节次时间）。
    //
    // 移植改动（逐条对应 AUDIT.md 第 5 节）：
    //   ① 弹窗改成自动取学期：先看当前地址的 params 参数（学生课表页自己就带着学年学期），再看页面（含同源内嵌框架）里名叫 xnxq 的
    //      下拉框或输入框，值形如 2026-0 才认；都没有就按今天的日期判断（8 月到次年 1 月 = 第一学期，2 月到 7 月 = 第二学期），
    //      并拿学期列表核对：判断出的学期不在列表里就改用列表里的第一个；列表也取不到就直接用判断值。只取这一个学期，
    //      用了判断值就在交出去的数据里标 source，parse.js 据此在提醒里说明
    //   ② 只取数：课表格子 -> { 本行的第几个 td.td、每个课程 div 的逐行文字 } 原样交出；拆周次、拆节次、合并、算开学日全在 parse.js
    //   ③ 开学日：上游没有取。这里照同平台、同作者的梧州职业学院适配器（wzzy）多取一次「第 1 周周课表」，只交出里面「<br>月-日」的前几处原文，
    //      由 parse.js 挑出周一并核对是不是合理的开学日；取不到或不合理就改为推算并提醒。该地址在本校没有验证过（见 AUDIT.md 第 10 节）
    //   ④ 登录页不发请求：当前路径含 /login 就直接提示先登录；不在教务主机、路径里也没有 /xmcsjw/ 的页面（融合信息门户、WebVPN 首页）
    //      同样提示，不发请求。上游只判断地址前缀、提示是弹一条消息
    //   ⑤ 不带出网页原文：只交出表格里每个课程 div 的逐行文字（最多每行 200 字）；学期列表只用来挑出一个学期，不整份交出
    //   ⑥ 上游的确认弹窗、学期弹窗、保存课程、导入预设时间段、showToast、notifyTaskCompletion 全部不移植：
    //      这些是「拾光」的桥能力，空课由宿主负责保存，适配器只交数据
    //
    // 取数方式：同源请求，最多三个（地址由当前页面的 origin + /xmcsjw 拼出；本校经 WebVPN 子域名访问，教务主机就是当前页面的主机，不需要额外的路径前缀）：
    //   POST <base>/frame/droplist/getDropLists.action，体 comboBoxName=StMsXnxqDxDesc&…        取学期列表（只用来核对学期、取学期名；取不到不影响导入）
    //   GET  <base>/student/wsxk.xskcb10319.jsp?params=<Base64 的 xn=…&xq=…>                   取学生课表页（GBK 编码）
    //   POST <base>/frame/desk/showLessonScheduleInfosV14.action?xn=…&xq=…&jxz=1                取第 1 周周课表里的日期（取不到就由 parse.js 推算开学日）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var CONTEXT = '/xmcsjw';
    var JW_HOST = 'jws-443.webvpn.xmcu.edu.cn';
    var LIST_PATH = '/frame/droplist/getDropLists.action';
    var SCHEDULE_PATH = '/student/wsxk.xskcb10319.jsp';
    var WEEK_PATH = '/frame/desk/showLessonScheduleInfosV14.action';
    var LINE_LIMIT = 200;      // 每行文字最多交出的字数
    var DATE_LIMIT = 14;       // 周课表里最多交出多少处日期

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 教务上下文路径 /xmcsjw 之前的那一段（若有反向代理前缀）原样保留；
    // 当前地址里没有 /xmcsjw/ 时，只有在教务主机本身上才补 /xmcsjw，其它主机（融合信息门户 eone-443…、统一认证）返回 null
    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(CONTEXT + '/');
        if (at >= 0) return originOf() + path.substring(0, at + CONTEXT.length);
        if (path === CONTEXT) return originOf() + CONTEXT;
        if (String(window.location.hostname || '').toLowerCase() === JW_HOST) return originOf() + CONTEXT;
        return null;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '').toLowerCase();
        return path.indexOf('/login') >= 0;
    }

    // ---------- 学年学期：先读页面，读不到才按日期判断 ----------

    var CODE_SHAPE = /^[0-9]{4}-[01]$/;

    // 学生课表页的地址自己带着 params=Base64(xn=2026&xq=0)；读出来形如 2026-0
    function termFromUrl() {
        var found = /[?&]params=([^&#]*)/.exec(String(window.location.search || ''));
        if (!found) return null;
        try {
            var plain = window.atob(decodeURIComponent(found[1]));
            var parts = /(?:^|&)xn=([0-9]{4})&xq=([01])(?:&|$)/.exec(plain);
            return parts ? parts[1] + '-' + parts[2] : null;
        } catch (e) {
            return null;
        }
    }

    function termValueIn(doc) {
        if (!doc || !doc.querySelector) return null;
        var el = doc.querySelector('select[name="xnxq"], #xnxq, input[name="xnxq"]');
        if (!el) return null;
        var value = String(el.value === null || el.value === undefined ? '' : el.value).replace(/\s+/g, '');
        return CODE_SHAPE.test(value) ? value : null;
    }

    // 当前页面找不到就找同源的内嵌框架（教务桌面常把功能页放在框架里）；跨域框架读不到，直接跳过
    function readTermFromPage() {
        var found = termFromUrl() || termValueIn(window.document);
        if (found) return found;
        var doc = window.document;
        if (!doc || !doc.querySelectorAll) return null;
        var frames = doc.querySelectorAll('iframe, frame');
        for (var i = 0; i < frames.length; i++) {
            try {
                found = termValueIn(frames[i].contentDocument);
            } catch (e) {
                found = null;
            }
            if (found) return found;
        }
        return null;
    }

    // 8 月到次年 1 月算第一学期（编号 0），2 月到 7 月算第二学期（编号 1）
    function guessTerm(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        var startYear = month >= 8 ? year : year - 1;
        var first = month >= 8 || month <= 1;
        return startYear + '-' + (first ? '0' : '1');
    }

    // ---------- 请求 ----------

    function failure(response) {
        return new Error(
            '教务系统返回错误（代码 ' + response.status + '）' +
            '：登录状态可能已失效，请重新登录后再点「提取课表」'
        );
    }

    function unreachable(error) {
        var detail = error && error.message ? '（' + error.message + '）' : '';
        return new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
    }

    // 网页是 GBK 编码（上游同样按 gbk 解码）
    function decodeGbk(buffer) {
        return new TextDecoder('gbk').decode(buffer);
    }

    // 学期列表：只用来核对学期、取学期名。取不到、不是预期的格式都当没有，不影响导入
    function fetchTermList(base) {
        var options = {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: 'comboBoxName=StMsXnxqDxDesc&paramValue=&isYXB=0&isCDDW=0&isXQ=0&isDJKSLB=0&isZY=0'
        };
        return fetch(base + LIST_PATH, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.json();
        }).then(function (list) {
            if (!Array.isArray(list)) return null;
            var out = [];
            for (var i = 0; i < list.length; i++) {
                var item = list[i] || {};
                var code = textOf(item.code);
                if (CODE_SHAPE.test(code)) out.push({ code: code, name: textOf(item.name).substring(0, 40) });
            }
            return out;
        }).then(null, function () {
            return null;
        });
    }

    function nameOf(list, code) {
        for (var i = 0; list && i < list.length; i++) {
            if (list[i].code === code) return list[i].name;
        }
        return '';
    }

    function listHas(list, code) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].code === code) return true;
        }
        return false;
    }

    function termParts(code) {
        var parts = code.split('-');
        return { xn: parts[0], xq: parts[1] };
    }

    // ---------- 课表页 -> 格子里的逐行文字 ----------

    function looksLikeLogin(html) {
        return /cas\/login/i.test(html) || /type\s*=\s*["']?password/i.test(html);
    }

    // 同一份网页只在这里定义一次「哪些是课表格子」：id 为 mytable 的表格里每一行的 td.td，按位置数第几天（上游同一规则）；
    // 格里带内联样式 padding-bottom:5px 的 div 是一门课，子节点逐个取文字、去空行（上游同一规则）
    function cellsOf(doc) {
        var table = doc.getElementById('mytable');
        if (!table) return null;
        var out = [];
        var rows = table.querySelectorAll('tr');
        for (var r = 0; r < rows.length; r++) {
            var tds = rows[r].querySelectorAll('td.td');
            for (var c = 0; c < tds.length; c++) {
                var divs = tds[c].querySelectorAll('div[style*="padding-bottom:5px"]');
                var courses = [];
                for (var d = 0; d < divs.length; d++) {
                    var nodes = divs[d].childNodes;
                    var lines = [];
                    for (var n = 0; n < nodes.length; n++) {
                        if (nodes[n].nodeType === 8) continue;   // 注释节点不算一行
                        var line = textOf(nodes[n].textContent);
                        if (line) lines.push(line.length > LINE_LIMIT ? line.substring(0, LINE_LIMIT) : line);
                    }
                    if (lines.length) courses.push(lines);
                }
                var cell = { d: c + 1 };
                if (courses.length) {
                    cell.courses = courses;
                } else {
                    // 有文字却没有一个课程 div：排版和预期不一样，只交出开头一小段让 parse.js 计数说明
                    var stray = textOf(tds[c].textContent);
                    if (!stray) continue;
                    cell.stray = stray.length > 20 ? stray.substring(0, 20) : stray;
                }
                out.push(cell);
            }
        }
        return out;
    }

    function fetchSchedule(base, code) {
        var parts = termParts(code);
        var params = window.btoa('xn=' + parts.xn + '&xq=' + parts.xq);
        var url = base + SCHEDULE_PATH + '?params=' + encodeURIComponent(params);
        return fetch(url, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw failure(response);
            var landed = String(response.url || '').toLowerCase();
            return response.arrayBuffer().then(function (buffer) {
                var html = decodeGbk(buffer);
                var cells = cellsOf(new DOMParser().parseFromString(html, 'text/html'));
                if (!cells && (landed.indexOf('/login') >= 0 || looksLikeLogin(html))) {
                    throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
                }
                return cells;
            });
        }, function (error) {
            throw unreachable(error);
        });
    }

    // 第 1 周周课表：只留「<br>月-日」的前几处原文（上游取第一处当第 1 周周一）。取不到就当没有，由 parse.js 推算
    function fetchWeekDates(base, code) {
        var parts = termParts(code);
        var url = base + WEEK_PATH + '?xn=' + encodeURIComponent(parts.xn) +
            '&xq=' + encodeURIComponent(parts.xq) + '&jxz=1';
        return fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'x-requested-with': 'XMLHttpRequest' }
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return [];
            return response.arrayBuffer().then(function (buffer) {
                var html = decodeGbk(buffer);
                var pattern = /<br\s*\/?>\s*([0-9]{2})-([0-9]{2})/gi;
                var dates = [];
                var found;
                while (dates.length < DATE_LIMIT && (found = pattern.exec(html)) !== null) {
                    dates.push(found[1] + '-' + found[2]);
                }
                return dates;
            });
        }).then(null, function () {
            return [];
        });
    }

    if (onLoginPage()) {
        throw new Error('当前打开的是登录页。请先登录教务系统，再点「提取课表」');
    }
    var base = jwBase();
    if (!base) {
        throw new Error('请先登录厦门城市职业学院的教务系统（在融合信息门户的应用中心进入教务系统，打开首页或课表页）后再点「提取课表」');
    }

    var pageCode = readTermFromPage();

    return fetchTermList(base).then(function (list) {
        var code = pageCode;
        var source = 'page';
        if (!code) {
            code = guessTerm(new Date());
            source = 'guess';
            // 判断出的学期不在学期列表里（列表取到了、且里面有别的学期）：改用列表里的第一个，和上游弹窗默认选中的一致
            if (list && list.length && !listHas(list, code)) {
                code = list[0].code;
                source = 'list-first';
            }
        }
        return fetchSchedule(base, code).then(function (cells) {
            return fetchWeekDates(base, code).then(function (dates) {
                var parts = termParts(code);
                return JSON.stringify({
                    term: { xn: parts.xn, xq: parts.xq, source: source, name: nameOf(list, code) },
                    hasTable: cells !== null,
                    cells: cells || [],
                    dates: dates
                });
            });
        });
    });
})()
