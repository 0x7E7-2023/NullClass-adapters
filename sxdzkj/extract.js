(function () {
    // 山西电子科技学院教务适配器（青果教务）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 SXDZKJ/sxdzkj.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 REnss3536；任务卡写星河欲转，以 adapters.yaml 的 maintainer 为准）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4（2026-11-01 与 origin/main 对齐）
    //   本校脚本最后一次修改 80e30cf（2026-09-23）
    //
    // 上游的做法：地址里有 sso.sxdzkj.edu.cn/sso-auth 或 cas/login 就只提示先登录。
    // 然后弹窗问四位学年、第一或第二学期，再从 cookie 的 userCode 或再弹窗问学号，
    // 把 xn、xq、xh 做 base64 后 GET 课表页，用 DOMParser 找含「上课时间地点」的表，
    // 第 3 列课名、第 7 列教师、第 11 列时间地点（从 1 数起）。课名和教师去掉方括号里的编号。
    // 响应按 GBK 解码，失败再按 UTF-8。
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」）：
    //   1. 不弹窗问学年学期：先读当前地址的 xn、xq，再读页面（含同源内嵌框架）里的 xn / xq 或 xnxq；
    //      都没有就按今天的日期判断（8 月到次年 1 月为第一学期，编号 0；2 月到 7 月为第二学期，编号 1）。
    //      用了判断值就标 source = guess。只请求这一次
    //   2. 学号只用来拼这一次请求：读 cookie 的 userCode，没有再读页面上名为 xh 的输入框或地址里的 xh。
    //      读不到就提示打开课表查询页，不弹窗向学生要学号。学号不写进交出去的结果
    //   3. 只取数：每行只交课名、教师、上课时间地点原文。拆周次、拆节次、合并、算开学日全在 parse.js
    //   4. 登录页、统一认证页不发请求。sso.sxdzkj.edu.cn 只用于认出登录页，不向它发请求
    //   5. 其它列（学号、证件号、手机号等）不交出
    //   6. 上游的开场公告、学年学期弹窗、学号弹窗、保存课程、提示条、完成通知全部不移植
    //
    // 取数方式：同源 GET 一次（主机与 loginUrl 相同）：
    //   GET https://jwxt.sxdzkj.edu.cn/wsxk/xkjg.ckdgxsxdkchj_data10319.jsp?params=<base64>
    //   base64 的原文是 xn=<四位学年>&xq=<0 或 1>&xh=<学号>
    // 登录全程由用户在页面里手工完成，本脚本不读、不存、不上报账号密码。

    var SCHEDULE_URL = 'https://jwxt.sxdzkj.edu.cn/wsxk/xkjg.ckdgxsxdkchj_data10319.jsp';
    var JW_HOST = 'jwxt.sxdzkj.edu.cn';
    var TEXT_LIMIT = 200;

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function clip(value, limit) {
        var line = textOf(value);
        if (line.length > limit) return line.substring(0, limit);
        return line;
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
        if (href.indexOf('sso.sxdzkj.edu.cn') >= 0) return true;
        if (href.indexOf('cas/login') >= 0) return true;
        if (href.indexOf('/login') >= 0) return true;
        return false;
    }

    function onJwPage() {
        var host = String(window.location.hostname || '').toLowerCase();
        return host === JW_HOST;
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
        var i;
        for (i = 0; i < frames.length; i++) {
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

    function idFromText(value) {
        var line = textOf(value);
        if (/^[A-Za-z0-9]+$/.test(line)) return line;
        return '';
    }

    function studentIdIn(doc) {
        if (!doc || !doc.querySelector) return '';
        var el = doc.querySelector('input[name="xh"], #xh');
        if (!el) return '';
        return idFromText(el.value);
    }

    function studentId() {
        var cookie = '';
        try {
            cookie = String(document.cookie || '');
        } catch (e) {
            cookie = '';
        }
        var fromCookie = /(?:^|;\s*)userCode(?:=|:)([^;]+)/.exec(cookie);
        if (fromCookie) {
            var cookieId = idFromText(fromCookie[1]);
            if (cookieId) return cookieId;
        }
        var fromPage = studentIdIn(window.document);
        if (fromPage) return fromPage;
        var doc = window.document;
        if (doc && doc.querySelectorAll) {
            var frames = doc.querySelectorAll('iframe, frame');
            var i;
            for (i = 0; i < frames.length; i++) {
                try {
                    fromPage = studentIdIn(frames[i].contentDocument);
                } catch (e2) {
                    fromPage = '';
                }
                if (fromPage) return fromPage;
            }
        }
        var fromUrl = /(?:^|[?&])xh=([A-Za-z0-9]+)(?:&|$)/.exec(String(window.location.search || ''));
        if (fromUrl) return fromUrl[1];
        return '';
    }

    function rowsOf(html) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(String(html), 'text/html');
        var tables = doc.querySelectorAll('table');
        var rows = [];
        var t;
        for (t = 0; t < tables.length; t++) {
            var table = tables[t];
            if (textOf(table.textContent).indexOf('上课时间地点') < 0) continue;
            var trs = table.querySelectorAll('tr');
            var r;
            for (r = 0; r < trs.length; r++) {
                var cells = trs[r].querySelectorAll('td');
                if (cells.length < 11) continue;
                var name = clip(textOf(cells[2].textContent).replace(/\[[^\]]*\]/g, ''), TEXT_LIMIT);
                var teacher = clip(textOf(cells[6].textContent).replace(/\[[^\]]*\]/g, ''), TEXT_LIMIT);
                var schedule = clip(cells[10].textContent, TEXT_LIMIT);
                if (!name && !teacher && !schedule) continue;
                rows.push({ name: name, teacher: teacher, schedule: schedule });
            }
        }
        return rows;
    }

    function looksLikeLogin(html) {
        var source = String(html || '');
        if (/cas\/login/i.test(source)) return true;
        if (/sso\.sxdzkj\.edu\.cn/i.test(source)) return true;
        if (/type\s*=\s*["']?password/i.test(source)) return true;
        return false;
    }

    function decodeBody(buf, contentType) {
        var ctype = String(contentType || '').toLowerCase();
        var matched = /charset=([^;\s]+)/.exec(ctype);
        var name = matched ? matched[1].replace(/["']/g, '') : '';
        function asCharset(label) {
            return new TextDecoder(label).decode(buf);
        }
        if (name === 'gbk' || name === 'gb2312' || name === 'gb18030') return asCharset('gbk');
        if (name === 'utf-8' || name === 'utf8') return asCharset('utf-8');
        var gbkText = '';
        try {
            gbkText = asCharset('gbk');
        } catch (e) {
            gbkText = '';
        }
        if (gbkText.indexOf('上课时间地点') >= 0) return gbkText;
        var utf8Text = asCharset('utf-8');
        if (utf8Text.indexOf('上课时间地点') >= 0) return utf8Text;
        return gbkText || utf8Text;
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
            var ctype = '';
            try {
                ctype = response.headers.get('content-type') || '';
            } catch (e) {
                ctype = '';
            }
            return response.arrayBuffer().then(function (buf) {
                return {
                    html: decodeBody(buf, ctype),
                    landedOnLogin: landed.indexOf('login') >= 0 || landed.indexOf('cas') >= 0 || landed.indexOf('sso.sxdzkj.edu.cn') >= 0
                };
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    if (onLoginPage()) {
        throw new Error('当前打开的是登录页。请先登录山西电子科技学院的教务系统，再点「提取课表」');
    }
    if (!onJwPage()) {
        throw new Error('请先登录山西电子科技学院的教务系统，打开课表页后再点「提取课表」');
    }

    var xh = studentId();
    if (!xh) {
        throw new Error('没有读到当前登录的学号。请在教务系统里打开课表查询页后再点「提取课表」');
    }

    var fromUrl = termFromUrl();
    var fromPage = fromUrl ? null : readTermFromPage();
    var term = fromUrl || fromPage || guessTerm(new Date());
    var source = (fromUrl || fromPage) ? 'page' : 'guess';
    var paramStr = 'xn=' + term.xn + '&xq=' + term.xq + '&xh=' + xh;
    var url = SCHEDULE_URL + '?params=' + encodeURIComponent(btoa(paramStr));

    return getText(url).then(function (result) {
        var rows = rowsOf(result.html);
        if (!rows.length && (result.landedOnLogin || looksLikeLogin(result.html))) {
            throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
        }
        return JSON.stringify({
            term: { xn: term.xn, xq: term.xq, source: source },
            today: localTodayIso(),
            rows: rows
        });
    });
})()
