(function () {
    // 南阳师范学院教务适配器（青果教务，经学校 VPN 的 /http/<十六进制>/ 前缀访问）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 NYNU/nynu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 7c9e1907635cb1c2d481b316e6f52d69dc77edff（2026-10-27 拉取）
    //   本校脚本最后一次修改 80e30cf（任务卡写的 03d161a 与快照不一致，以 git log 为准，未改快照）
    //
    // 上游的做法：先判断地址里有没有 login / cas；弹窗问四位学年和第一 / 第二学期，
    // 再 GET 写死的课表地址（查询串带 vpn-12-o1-<源站>、xn、xq），用 DOMParser 找 class 为 weeklesson、
    // id 形如 weekly0X_Y 的块，读每条列表里的课程名称 / 任课教师 / 上课时间 / 上课地点。
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」）：
    //   1. 不弹窗问学年学期：先读当前地址的 xn、xq，再读页面（含同源内嵌框架）里的 xn / xq 或 xnxq；
    //      都没有就按今天的日期判断（8 月到次年 1 月为第一学期，编号 0；2 月到 7 月为第二学期，编号 1）。
    //      只请求这一次。用了判断值就标 source = guess
    //   2. 只取数：每个 weeklesson 块交出 id 和四条标签的纯文字；拆周次、拆节次、合并、算开学日全在 parse.js
    //   3. 登录页、统一认证页、VPN 首页不发请求。上游只判断了地址里有 login 或 cas
    //   4. 列表里不是那四条标签的文字（学号等）不交出；不交网页原文
    //   5. 上游的开场公告、学年学期弹窗、保存课程、提示条、完成通知全部不移植
    //
    // 取数方式：同源 GET 一次（主机写死为 vpn.nynu.edu.cn，路径用上游那串 /http/<十六进制>/nysfjw，不改成别的写法）：
    //   GET https://vpn.nynu.edu.cn/http/77726476706e69737468656265737421feee52852d27265e67069ce29d51367b58d2/nysfjw/frame/desk/showLessonScheduleInfosV14.action?vpn-12-o1-<源站>&xn=<四位学年>&xq=<0 或 1>
    // 源站从当前地址里的 vpn-12-o1- 后面截取，没有就用上游的回落值 nysyjw.nynu.edu.cn（只放在查询串里，不另开主机）。
    // 登录全程由用户在页面里手工完成，本脚本不读、不存、不上报任何账号信息。

    var SCHEDULE_URL = 'https://vpn.nynu.edu.cn/http/77726476706e69737468656265737421feee52852d27265e67069ce29d51367b58d2/nysfjw/frame/desk/showLessonScheduleInfosV14.action';
    var ORIGIN_FALLBACK = 'nysyjw.nynu.edu.cn';
    var JW_HOST = 'vpn.nynu.edu.cn';
    var LINE_LIMIT = 200;
    var LABELS = ['课程名称', '任课教师', '上课时间', '上课地点'];

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

    function onLoginPage() {
        var href = String(window.location.href || '').toLowerCase();
        return href.indexOf('login') >= 0 || href.indexOf('cas') >= 0;
    }

    function onJwPage() {
        var host = String(window.location.hostname || '').toLowerCase();
        if (host !== JW_HOST) return false;
        var path = String(window.location.pathname || '');
        return path.indexOf('/nysfjw/') >= 0 || path === '/nysfjw';
    }

    function pairOf(xn, xq) {
        var year = textOf(xn);
        var term = textOf(xq);
        if (/^[0-9]{4}$/.test(year) && /^[01]$/.test(term)) return { xn: year, xq: term };
        return null;
    }

    function termFromUrl() {
        var search = String(window.location.search || '');
        var year = /(?:^|[?&])xn=([0-9]{4})(?:&|$)/.exec(search);
        var term = /(?:^|[?&])xq=([01])(?:&|$)/.exec(search);
        if (!year || !term) return null;
        return pairOf(year[1], term[1]);
    }

    function termIn(doc) {
        if (!doc || !doc.querySelector) return null;
        var yearEl = doc.querySelector('select[name="xn"], input[name="xn"], #xn');
        var termEl = doc.querySelector('select[name="xq"], input[name="xq"], #xq');
        if (yearEl && termEl) {
            var pair = pairOf(yearEl.value, termEl.value);
            if (pair) return pair;
        }
        var both = doc.querySelector('select[name="xnxq"], input[name="xnxq"], #xnxq');
        if (!both) return null;
        var matched = /^([0-9]{4})-([01])$/.exec(textOf(both.value));
        if (!matched) return null;
        return { xn: matched[1], xq: matched[2] };
    }

    function readTermFromPage() {
        var found = termIn(window.document);
        if (found) return found;
        var doc = window.document;
        if (!doc || !doc.querySelectorAll) return null;
        var frames = doc.querySelectorAll('iframe, frame');
        for (var i = 0; i < frames.length; i++) {
            try {
                found = termIn(frames[i].contentDocument);
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
        return { xn: String(startYear), xq: first ? '0' : '1' };
    }

    function originHostOf() {
        var href = String(window.location.href || '');
        var matched = /vpn-12-o1-([A-Za-z0-9.-]+)/.exec(href);
        if (!matched) return ORIGIN_FALLBACK;
        var host = matched[1].replace(/\.+$/, '');
        if (!host || host.indexOf('..') >= 0) return ORIGIN_FALLBACK;
        return host;
    }

    function keepLine(line) {
        for (var i = 0; i < LABELS.length; i++) {
            if (line.indexOf(LABELS[i]) === 0) return true;
        }
        return false;
    }

    function classHas(el, name) {
        var cls = el && el.className ? String(el.className) : '';
        return (' ' + cls + ' ').indexOf(' ' + name + ' ') >= 0;
    }

    // 同一份网页只在这里定义「哪些是课程块」：id 以 weekly 开头，且 class 里有 weeklesson
    function blocksOf(html) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(String(html), 'text/html');
        var nodes = doc.querySelectorAll('[id^="weekly"]');
        var blocks = [];
        for (var i = 0; i < nodes.length; i++) {
            var div = nodes[i];
            if (!classHas(div, 'weeklesson')) continue;
            var lis = div.querySelectorAll('ul li');
            var lines = [];
            for (var j = 0; j < lis.length; j++) {
                var line = textOf(lis[j].textContent);
                if (!line || !keepLine(line)) continue;
                if (line.length > LINE_LIMIT) line = line.substring(0, LINE_LIMIT);
                lines.push(line);
            }
            if (!lines.length) continue;
            blocks.push({ id: String(div.id || ''), lines: lines });
        }
        return blocks;
    }

    function looksLikeLogin(html) {
        return /cas\/login/i.test(html) || /type\s*=\s*["']?password/i.test(html);
    }

    function getText(url) {
        return fetch(url, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            var landed = String(response.url || '').toLowerCase();
            return response.text().then(function (html) {
                return { html: html, landedOnLogin: landed.indexOf('login') >= 0 || landed.indexOf('cas') >= 0 };
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    if (onLoginPage()) {
        throw new Error('当前打开的是登录页。请先登录南阳师范学院的教务系统，再点「提取课表」');
    }
    if (!onJwPage()) {
        throw new Error('请先登录南阳师范学院的教务系统，打开课表页后再点「提取课表」');
    }

    var fromUrl = termFromUrl();
    var fromPage = fromUrl ? null : readTermFromPage();
    var term = fromUrl || fromPage || guessTerm(new Date());
    var source = (fromUrl || fromPage) ? 'page' : 'guess';
    var url = SCHEDULE_URL + '?vpn-12-o1-' + originHostOf() +
        '&xn=' + encodeURIComponent(term.xn) + '&xq=' + encodeURIComponent(term.xq);

    return getText(url).then(function (result) {
        var blocks = blocksOf(result.html);
        if (!blocks.length && (result.landedOnLogin || looksLikeLogin(result.html))) {
            throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
        }
        return JSON.stringify({
            term: { xn: term.xn, xq: term.xq, source: source },
            today: localTodayIso(),
            blocks: blocks
        });
    });
})()
