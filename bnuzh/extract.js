(function () {
    // 北京师范大学珠海校区教务适配器（青果 KINGOSOFT，主机 jwxt.bnuzh.edu.cn）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 BNUZH/school.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Sue Yin，维护者 sbVAN）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4（2026-11-01 与 origin/main 对齐）
    //   本校脚本最后一次修改 03aa24c（与任务卡一致，未改快照）
    //
    // 上游的做法：先确认地址主机以 bnuzh.edu.cn 结尾，弹窗选学期（学期列表或当前学期，都没有就手填），
    // 再按 GBK 取列表课表、第 1 周周课表里的月-日、制表符分隔的节次时间，在脚本里拆周次并弹窗确认开学日。
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」）：
    //   1. 当前页主机必须正好是 jwxt.bnuzh.edu.cn 才发请求。不使用「主机名以某后缀结尾」这种判断，子域和仿冒主机直接提示、不发请求
    //   2. 登录页、统一认证页、网站根路径上不发请求
    //   3. 不弹窗问学年学期：先读地址上的 xn 与 xq（或 params 里的学年学期），再读页面（含同源内嵌框架）；
    //      都没有就请求教务的当前学期；当前学期也没有，就按今天判断，判断结果不在学期列表里则用列表第一项。只导入这一个学期
    //   4. 只取数：课表只交出课程名、教师、上课时间原文；第 1 周周课表只交出月-日；节次时间只交出节次号和起止时间。拆周次、合并、算开学日在 parse.js
    //   5. 课表格子里其余列（可能夹着学号等）不交出；不交网页原文
    //   6. 上游的开场确认、学期弹窗、开学日输入框、保存课程、提示条、完成通知全部不移植
    //
    // 取数方式：同源请求，最多五个（主机写死为 jwxt.bnuzh.edu.cn）：
    //   POST /jw/common/showYearTerm.action                         当前学年学期（页面上已经有学年学期时不请求）
    //   POST /frame/droplist/getDropLists.action                    学期列表（只用来核对、取学期名）
    //   GET  /wsxk/xkjg.ckdgxsxdkchj_data10319.jsp?params=<编码>    列表课表（GBK）
    //   POST /frame/desk/showLessonScheduleInfosV14.action?xn&xq&jxz=1   第 1 周周课表里的月-日（GBK）
    //   GET  /public/SchoolTimetable.show.jsp                       节次时间（GBK，制表符分隔）
    // 登录全程由用户在页面里手工完成，本脚本不读、不存、不上报任何账号信息。

    var HOST = 'jwxt.bnuzh.edu.cn';
    var ORIGIN = 'https://jwxt.bnuzh.edu.cn';
    var YEAR_PATH = '/jw/common/showYearTerm.action';
    var LIST_PATH = '/frame/droplist/getDropLists.action';
    var SCHEDULE_PATH = '/wsxk/xkjg.ckdgxsxdkchj_data10319.jsp';
    var WEEK_PATH = '/frame/desk/showLessonScheduleInfosV14.action';
    var TIME_PATH = '/public/SchoolTimetable.show.jsp';
    var LIST_BODY =
        'comboBoxName=Ms_KBBP_FBXKJGXNXQ&paramValue=&isYXB=0&isCDDW=0&isPYCC=0' +
        '&isPYCCNJ=0&zyPyccFiled=&isKBLB=0&isXQ=0&isBJ=0&isSXJD=0&isDJKSLB=0';
    var TEXT_LIMIT = 200;
    var DATE_LIMIT = 14;

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

    function clip(value, limit) {
        var line = textOf(value);
        if (line.length > limit) return line.substring(0, limit);
        return line;
    }

    function onThisHost() {
        return String(window.location.hostname || '').toLowerCase() === HOST;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '').toLowerCase();
        return path.indexOf('login') >= 0 || path.indexOf('cas') >= 0;
    }

    function onPortal() {
        var path = String(window.location.pathname || '');
        return path === '' || path === '/' || path === '/index' || path === '/index.html' ||
            path === '/index.jsp' || path === '/portal' || path === '/portal/';
    }

    function pairOf(xn, xq) {
        var year = textOf(xn);
        var termNo = textOf(xq);
        if (/^[0-9]{4}$/.test(year) && /^[01]$/.test(termNo)) return { xn: year, xq: termNo };
        return null;
    }

    function termFromQuery() {
        var search = String(window.location.search || '');
        var year = /(?:^|[?&])xn=([0-9]{4})(?:&|$)/.exec(search);
        var termNo = /(?:^|[?&])xq=([01])(?:&|$)/.exec(search);
        if (year && termNo) return pairOf(year[1], termNo[1]);
        var found = /[?&]params=([^&#]*)/.exec(search);
        if (!found) return null;
        try {
            var plain = window.atob(decodeURIComponent(found[1]));
            var parts = /(?:^|&)xn=([0-9]{4})(?:&|&amp;)xq=([01])(?:&|$)/.exec(plain);
            if (!parts) parts = /(?:^|&)xn=([0-9]{4})&xq=([01])(?:&|$)/.exec(plain);
            return parts ? pairOf(parts[1], parts[2]) : null;
        } catch (e) {
            return null;
        }
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
        var matched = /^([0-9]{4})[,\-]([01])$/.exec(textOf(both.value).replace(/\s+/g, ''));
        if (!matched) return null;
        return { xn: matched[1], xq: matched[2] };
    }

    function readTermFromPage() {
        var found = termFromQuery();
        if (found) return found;
        found = termIn(window.document);
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

    function decodeGbk(buffer) {
        return new TextDecoder('gbk').decode(buffer);
    }

    function codeOf(item) {
        return textOf(item && item.code).replace(/\s+/g, '');
    }

    function partsOfCode(code) {
        var matched = /^([0-9]{4})[,\-]([01])$/.exec(code);
        if (!matched) return null;
        return { xn: matched[1], xq: matched[2] };
    }

    function sameCode(item, term) {
        var parts = partsOfCode(codeOf(item));
        return !!(parts && term && parts.xn === term.xn && parts.xq === term.xq);
    }

    function fetchYearTerm() {
        return fetch(ORIGIN + YEAR_PATH, { method: 'POST', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (body) {
                try {
                    var data = JSON.parse(body);
                    if (!data) return null;
                    return pairOf(data.xn, data.xqM);
                } catch (e) {
                    return null;
                }
            });
        }, function () {
            return null;
        });
    }

    function fetchTermList() {
        return fetch(ORIGIN + LIST_PATH, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: LIST_BODY
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.json();
        }).then(function (list) {
            if (!Array.isArray(list)) return null;
            var out = [];
            for (var i = 0; i < list.length; i++) {
                var parts = partsOfCode(codeOf(list[i]));
                if (!parts) continue;
                out.push({ xn: parts.xn, xq: parts.xq, name: clip(list[i].name, 40) });
            }
            return out;
        }, function () {
            return null;
        });
    }

    function nameOf(list, term) {
        if (!list) return '';
        for (var i = 0; i < list.length; i++) {
            if (list[i].xn === term.xn && list[i].xq === term.xq) return list[i].name;
        }
        return '';
    }

    function listHas(list, term) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].xn === term.xn && list[i].xq === term.xq) return true;
        }
        return false;
    }

    function looksLikeLogin(html) {
        return html.indexOf('凭证已失效') >= 0 || /cas\/login/i.test(html) || /type\s*=\s*["']?password/i.test(html);
    }

    // 同一份网页只在这里定义「哪些是课程行」：tbody 里至少 6 列，第一列是 [代码]课名，第 5 列教师，第 6 列上课时间
    function rowsOf(html) {
        var doc = new DOMParser().parseFromString(String(html), 'text/html');
        var body = doc.querySelector('tbody');
        var nodes = body ? body.querySelectorAll('tr') : [];
        var rows = [];
        var bad = 0;
        for (var i = 0; i < nodes.length; i++) {
            var cells = nodes[i].querySelectorAll('td');
            if (cells.length < 6) {
                if (textOf(nodes[i].textContent)) bad++;
                continue;
            }
            var matched = /^\[[^\]]+\]\s*(.+)$/.exec(textOf(cells[0].textContent));
            if (!matched) {
                if (textOf(cells[0].textContent)) bad++;
                continue;
            }
            rows.push({
                name: clip(matched[1], TEXT_LIMIT),
                teacher: clip(cells[4].textContent, TEXT_LIMIT),
                time: textOf(cells[5].textContent)
            });
        }
        return { hasTable: !!body, rows: rows, badRows: bad };
    }

    function fetchSchedule(term) {
        var params = window.btoa('xn=' + term.xn + '&xq=' + term.xq);
        var url = ORIGIN + SCHEDULE_PATH + '?params=' + encodeURIComponent(params);
        return fetch(url, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw failure(response);
            var landed = String(response.url || '').toLowerCase();
            return response.arrayBuffer().then(function (buffer) {
                var html = decodeGbk(buffer);
                if (html.indexOf('凭证已失效') >= 0 || landed.indexOf('login') >= 0 || landed.indexOf('cas') >= 0) {
                    throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
                }
                var packed = rowsOf(html);
                if (!packed.rows.length && looksLikeLogin(html)) {
                    throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
                }
                return packed;
            });
        }, function (error) {
            throw unreachable(error);
        });
    }

    function fetchWeekDates(term) {
        var url = ORIGIN + WEEK_PATH + '?xn=' + encodeURIComponent(term.xn) +
            '&xq=' + encodeURIComponent(term.xq) + '&jxz=1';
        return fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
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
        }, function () {
            return [];
        });
    }

    function slotsOf(raw) {
        var tab = String.fromCharCode(9);
        var pattern = new RegExp('([0-9]{1,2})' + tab + '([0-9]{2}:[0-9]{2})' + tab + '([0-9]{2}:[0-9]{2})', 'g');
        var slots = [];
        var seen = {};
        var found;
        while ((found = pattern.exec(String(raw))) !== null) {
            var n = parseInt(found[1], 10);
            if (n < 1 || n > 30 || seen[n]) continue;
            seen[n] = true;
            slots.push({ n: n, start: found[2], end: found[3] });
        }
        slots.sort(function (a, b) { return a.n - b.n; });
        return slots;
    }

    function fetchSlots() {
        return fetch(ORIGIN + TIME_PATH, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return [];
            return response.arrayBuffer().then(function (buffer) {
                return slotsOf(decodeGbk(buffer));
            });
        }, function () {
            return [];
        });
    }

    function chooseTerm(pageTerm, current, list) {
        if (pageTerm) return { xn: pageTerm.xn, xq: pageTerm.xq, source: 'page', name: nameOf(list, pageTerm) };
        if (current) return { xn: current.xn, xq: current.xq, source: 'current', name: nameOf(list, current) };
        var guess = guessTerm(new Date());
        if (list && list.length && !listHas(list, guess)) {
            return { xn: list[0].xn, xq: list[0].xq, source: 'list-first', name: list[0].name };
        }
        return { xn: guess.xn, xq: guess.xq, source: 'guess', name: nameOf(list, guess) };
    }

    if (!onThisHost()) {
        throw new Error('请先登录北京师范大学珠海校区的教务系统，打开课表页后再点「提取课表」');
    }
    if (onLoginPage()) {
        throw new Error('当前打开的是登录页。请先登录北京师范大学珠海校区的教务系统，再点「提取课表」');
    }
    if (onPortal()) {
        throw new Error('请先登录北京师范大学珠海校区的教务系统，打开课表页后再点「提取课表」');
    }

    var pageTerm = readTermFromPage();
    var currentPromise = pageTerm ? Promise.resolve(null) : fetchYearTerm();

    return currentPromise.then(function (current) {
        return fetchTermList().then(function (list) {
            var term = chooseTerm(pageTerm, current, list);
            return fetchSchedule(term).then(function (packed) {
                return fetchWeekDates(term).then(function (dates) {
                    return fetchSlots().then(function (slots) {
                        return JSON.stringify({
                            term: { xn: term.xn, xq: term.xq, source: term.source, name: term.name },
                            today: localTodayIso(),
                            hasTable: packed.hasTable,
                            rows: packed.rows,
                            badRows: packed.badRows,
                            dates: dates,
                            slots: slots
                        });
                    });
                });
            });
        });
    });
})()
