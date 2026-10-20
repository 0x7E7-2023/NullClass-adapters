(function () {
    // 济源职业技术学院教务适配器（青果教务，部署在 /jyvtcjw 下）—— 第一步：只取数，把课表表格里的原始文字原样交出去。
    //
    // 移植自 shiguang_warehouse 的 JYVTC/jyvtc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf
    //
    // 上游的做法：弹窗问学年（四位数字）和学期（第一 / 第二），POST 一次课表页，用正则从返回的网页片段里
    // 抠出 class 为 mykb 的表格行，一行是一节课，一格里可能叠着好几门课；再按课名 / 教师 / 教室 / 周次排序后把连续节次合并。
    //
    // 移植改动（逐条对应 AUDIT.md 第 5 节）：
    //   ① 弹窗改成自动取学期：先在当前页面（含同源的内嵌框架）里找名叫 xnxq 的下拉框或输入框，值形如 2026-0 才认；
    //      找不到就按今天的日期判断（8 月到次年 1 月 = 第一学期，2 月到 7 月 = 第二学期），
    //      只取这一次（学期没有课时由 parse.js 报错，不改取别的学期）；用了判断值就在交出去的数据里标 source = guess，parse.js 据此在提醒里说明
    //   ② 只取数：表格行 -> 每格 { 是否带属性, 开头文字, 格内第一个列表的纯文字 } 原样交出；
    //      读行号、分课程、拆周次与教室、合并连续节次全部在 parse.js（CI 只跑得到 parse.js）
    //   ③ 登录页不发请求：当前路径含 /cas/login 就直接提示先登录；不在教务主机、路径里也没有 /jyvtcjw/ 的页面
    //      （统一认证、门户）同样提示，不发请求。上游只判断了登录页这一种
    //   ④ 不再带出网页片段原文：只交出表格行里每一格的开头文字和列表文字（属性、脚本、其它标签一律不带）
    //   ⑤ 上游的开场公告、学年学期弹窗、保存课程、导入预设时间段、showToast、notifyTaskCompletion 全部不移植：
    //      这些是「拾光」的桥能力，空课由宿主负责保存，适配器只交数据
    //
    // 取数方式：同源请求，只有一个（地址由当前页面的 origin + /jyvtcjw 拼出）：
    //   POST <base>/frame/desk/showLessonScheduleDetail.action，体 weeks=&xnxq=<年份>-<0 或 1>  取课表网页片段
    // 请求头只带 Content-Type（和上游一致，不额外加 X-Requested-With，免得服务端改成别的返回格式）。
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var CONTEXT = '/jyvtcjw';
    var JW_HOST = 'jwgl.jyvtc.edu.cn';
    var SCHEDULE_PATH = '/frame/desk/showLessonScheduleDetail.action';

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

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // 教务上下文路径 /jyvtcjw 之前的那一段（反向代理前缀）原样保留；
    // 当前地址里没有 /jyvtcjw/ 时，只有在教务主机本身上才补 /jyvtcjw，其它主机（门户、统一认证）返回 null
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
        return path.indexOf('/cas/login') >= 0;
    }

    // ---------- 学年学期：先读页面，读不到才按日期判断 ----------

    function termValueIn(doc) {
        if (!doc || !doc.querySelector) return null;
        var el = doc.querySelector('select[name="xnxq"], #xnxq, input[name="xnxq"]');
        if (!el) return null;
        var value = String(el.value === null || el.value === undefined ? '' : el.value).replace(/\s+/g, '');
        return /^[0-9]{4}-[01]$/.test(value) ? value : null;
    }

    // 当前页面找不到就找同源的内嵌框架（教务桌面常把功能页放在框架里）；跨域框架读不到，直接跳过
    function readTermFromPage() {
        var found = termValueIn(window.document);
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

    function post(url, body) {
        var options = {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body
        };
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            var landed = String(response.url || '').toLowerCase();
            return response.text().then(function (html) {
                return { html: html, landedOnLogin: landed.indexOf('/cas/login') >= 0 };
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    // ---------- 网页片段 -> 表格行（只留每格的开头文字和第一个列表里的纯文字） ----------

    function decodeEntities(value) {
        return String(value)
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x([0-9a-f]+);/gi, function (all, hex) {
                return String.fromCharCode(parseInt(hex, 16));
            })
            .replace(/&#([0-9]+);/g, function (all, dec) {
                return String.fromCharCode(parseInt(dec, 10));
            })
            .replace(/&amp;/gi, '&');
    }

    // 列表里的网页片段 -> 纯文字，一行一门课（换行标签、列表项结尾都算换行）
    function linesOf(innerHtml) {
        var plain = String(innerHtml)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(li|p|div)>/gi, '\n')
            .replace(/<[^>]*>/g, '');
        var parts = decodeEntities(plain).split('\n');
        var lines = [];
        for (var i = 0; i < parts.length; i++) {
            var line = textOf(parts[i]);
            if (line) lines.push(line);
        }
        return lines.join('\n');
    }

    function cellOf(tdHtml) {
        var hasAttrs = /^<td\s/i.test(tdHtml);
        var inner = tdHtml.replace(/^<td[^>]*>/i, '').replace(/<\/td>$/i, '');
        var lead = textOf(decodeEntities(inner.split('<')[0]));
        if (lead.length > 40) lead = lead.substring(0, 40);
        var cell = { a: hasAttrs ? 1 : 0, lead: lead };
        var list = /<ul(?=[\s>])[^>]*>([\s\S]*?)<\/ul>/i.exec(inner);
        if (list) {
            var lines = linesOf(list[1]);
            if (lines) cell.ul = lines;
        }
        return cell;
    }

    // 同一份网页片段只在这里定义一次「哪些是课表行」：<tr> 的 class 里有 mykb 这个词
    function rowsOf(html) {
        var blocks = String(html).match(/<tr(?=[\s>])[\s\S]*?<\/tr>/gi) || [];
        var rows = [];
        for (var i = 0; i < blocks.length; i++) {
            var open = /^<tr[^>]*>/i.exec(blocks[i]);
            var cls = open ? /class\s*=\s*["']([^"']*)["']/i.exec(open[0]) : null;
            if (!cls || textOf(cls[1]).split(' ').indexOf('mykb') < 0) continue;
            var tds = blocks[i].match(/<td(?=[\s>])[^>]*>[\s\S]*?<\/td>/gi) || [];
            var cells = [];
            for (var j = 0; j < tds.length; j++) cells.push(cellOf(tds[j]));
            rows.push({ cells: cells });
        }
        return rows;
    }

    function looksLikeLogin(html) {
        return /cas\/login/i.test(html) || /type\s*=\s*["']?password/i.test(html);
    }

    // 「有没有课」看课表行里有没有课程内容（任何一格有列表文字），不看 mykb 行是否存在：空表也可能带着 mykb 行
    function hasContent(rows) {
        for (var i = 0; i < rows.length; i++) {
            var cells = rows[i].cells;
            for (var j = 0; j < cells.length; j++) {
                if (cells[j].ul) return true;
            }
        }
        return false;
    }

    function fetchTerm(base, code) {
        var body = 'weeks=&xnxq=' + encodeURIComponent(code);
        return post(base + SCHEDULE_PATH, body).then(function (result) {
            var rows = rowsOf(result.html);
            if (!hasContent(rows) && (result.landedOnLogin || looksLikeLogin(result.html))) {
                throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
            }
            return rows;
        });
    }

    if (onLoginPage()) {
        throw new Error('当前打开的是登录页。请先登录教务系统，再点「提取课表」');
    }
    var base = jwBase();
    if (!base) {
        throw new Error('请先登录济源职业技术学院的教务系统（打开教务系统首页或课表页）后再点「提取课表」');
    }

    var pageCode = readTermFromPage();
    var firstCode = pageCode || guessTerm(new Date());
    var source = pageCode ? 'page' : 'guess';

    function pack(code, rows) {
        return JSON.stringify({
            term: { xnxq: code, source: source },
            today: localTodayIso(),
            rows: rows
        });
    }

    return fetchTerm(base, firstCode).then(function (rows) {
        return pack(firstCode, rows);
    });
})()
