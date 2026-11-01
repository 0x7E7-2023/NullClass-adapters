(function () {
    // 河南科技学院教务适配器（青果 / KINGOSOFT，明文 http）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 HIST/hist_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转；
    //   adapters.yaml 的 maintainer 账号是 zixij644-elaborate）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4（2026-11-01 与 origin/main 对齐）
    //   本校脚本最后一次修改 80e30cf（2026-09-23，与任务卡一致）
    //
    // 上游的做法：判断地址里有没有 /cas/ 或 login；弹窗问四位学年和第一 / 第二学期；
    // GET /wsxk/xkjg.ckdgxsxdkchj_data10319.jsp?params=Base64(xn 与 xq)；
    // 再 POST /public/SchoolTimetable.show.jsp 取节次时间，失败就用写死的两套时间。
    // 课在表格行里：课程名形如 [代码]课名，教师形如 [工号]姓名，时间地点格是「周次 星期[节次] 地点」。
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」）：
    //   1. 不弹窗问学年学期。先读当前地址的 xn 与 xq（或 xq_m），再读页面（含同源内嵌框架）里的同名控件；
    //      都没有就按今天判断（8 月到 12 月、以及 7 月为当年第一学期，编号 0；
    //      1 月为上一学年第一学期；2 月到 6 月为上一学年第二学期，编号 1），并标 source = guess
    //   2. 只取数：每一行只交课程名、教师姓名、时间地点原文。工号、课程代码、学号都不交。拆周次、合并、算开学日全在 parse.js
    //   3. 节次时间表只交节次号和起止时间。页面写了未设置 / 未设定 / 未发布，或一行都读不出，就交空表并标明原因，由 parse.js 回落备用时间
    //   4. 登录页（路径里有 /cas/ 或 login.action）以及不是本校教务主机的页面，只提示，不发请求
    //   5. 上游的开场公告、学年学期弹窗、保存课程、保存节次、提示条、完成通知全部不移植
    //
    // 取数方式（协议保持 http，不改成 https）：
    //   GET  http://jwgl.hist.edu.cn/wsxk/xkjg.ckdgxsxdkchj_data10319.jsp?params=<Base64>
    //   POST http://jwgl.hist.edu.cn/public/SchoolTimetable.show.jsp
    //        正文 xn=<学年>&xq_m=<0 或 1>&menucode=&is_ssxq=0&axq=&ssxq=
    // 不带学号。登录全程由用户在页面里手工完成，本脚本不读、不存、不上报任何账号信息。

    var HOST = 'http://jwgl.hist.edu.cn';
    var SCHEDULE_URL = HOST + '/wsxk/xkjg.ckdgxsxdkchj_data10319.jsp';
    var TIME_URL = HOST + '/public/SchoolTimetable.show.jsp';
    var JW_HOST = 'jwgl.hist.edu.cn';

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/　/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === JW_HOST;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '').toLowerCase();
        return path.indexOf('/cas/') >= 0 || path.indexOf('login.action') >= 0;
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
        var term = /(?:^|[?&])xq(?:_m)?=([01])(?:&|$)/.exec(search);
        if (!year || !term) return null;
        return pairOf(year[1], term[1]);
    }

    function termIn(doc) {
        if (!doc || !doc.querySelector) return null;
        var yearEl = doc.querySelector('select[name="xn"], input[name="xn"], #xn');
        var termEl = doc.querySelector('select[name="xq"], input[name="xq"], #xq, select[name="xq_m"], input[name="xq_m"]');
        if (!yearEl || !termEl) return null;
        return pairOf(yearEl.value, termEl.value);
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

    // 8–12 月：当年第一学期。7 月上游不减年，学期列表默认第 0 项，也是当年第一学期。
    // 1 月：上一学年第一学期。2–6 月：上一学年第二学期。
    function guessTerm(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        if (month >= 7) return { xn: String(year), xq: '0' };
        if (month <= 1) return { xn: String(year - 1), xq: '0' };
        return { xn: String(year - 1), xq: '1' };
    }

    function stripCode(value) {
        return textOf(value).replace(/^\s*\[[^\]]*\]\s*/g, '').trim();
    }

    // 只留姓名。[工号]姓名 里的工号不交出去；括号里没有姓名就当没填，不把工号原样交出去
    function cleanTeacher(value) {
        var raw = textOf(value);
        if (raw.indexOf('[') < 0) return raw;
        var parts = raw.split('[');
        var names = [];
        for (var i = 0; i < parts.length; i++) {
            var idx = parts[i].indexOf(']');
            if (idx < 0) continue;
            var name = textOf(parts[i].substring(idx + 1).replace(/&ensp;|&nbsp;/g, ' '));
            if (name) names.push(name);
        }
        return names.join(' & ');
    }

    function cellText(el) {
        return textOf(el && el.textContent ? el.textContent : '');
    }

    function looksLikeTime(value) {
        if (value.indexOf('周') >= 0) return true;
        if (/\[\d{1,2}(?:\s*[-—～]\s*\d{1,2})?\s*节?\]/.test(value)) return true;
        if (/[一二三四五六日天]\s*\[/.test(value)) return true;
        if (/\d{1,2}\s*[-—～]\s*\d{1,2}\s*节/.test(value)) return true;
        return false;
    }

    // 同一份网页只在这里认「哪一格是时间地点」：从右往左，含「周」或节次
    function rowsOf(html) {
        var doc = new DOMParser().parseFromString(String(html), 'text/html');
        var trs = doc.querySelectorAll('tr');
        var rows = [];
        for (var r = 0; r < trs.length; r++) {
            var cells = trs[r].querySelectorAll('td');
            if (!cells || cells.length < 3) continue;
            var dataIdx = -1;
            var dataText = '';
            for (var i = cells.length - 1; i >= 0; i--) {
                var sample = cellText(cells[i]);
                if (!looksLikeTime(sample)) continue;
                dataIdx = i;
                dataText = sample;
                break;
            }
            if (dataIdx < 0) continue;
            var name = '';
            var nameIdx = -1;
            for (var j = 0; j < cells.length; j++) {
                if (j === dataIdx) continue;
                var named = cellText(cells[j]);
                if (!/^\s*\[[^\]]*\]\s*\S/.test(named)) continue;
                name = stripCode(named);
                nameIdx = j;
                break;
            }
            if (!name) {
                var fallback = cellText(cells.length > 2 ? cells[2] : null) || cellText(cells[1]) || cellText(cells[0]);
                name = stripCode(fallback);
            }
            var teacher = '';
            for (var k = 0; k < cells.length; k++) {
                if (k === dataIdx || k === nameIdx) continue;
                var who = cellText(cells[k]);
                if (!/[0-9]/.test(who) || !/\[[^\]]*\]/.test(who)) continue;
                teacher = cleanTeacher(who);
                break;
            }
            if (dataText.length > 800) dataText = dataText.substring(0, 800);
            if (name.length > 200) name = name.substring(0, 200);
            if (teacher.length > 200) teacher = teacher.substring(0, 200);
            rows.push({ name: name, teacher: teacher, timePlace: dataText });
        }
        return rows;
    }

    function slotsOfHtml(html) {
        var doc = new DOMParser().parseFromString(String(html), 'text/html');
        var trs = doc.querySelectorAll('tr');
        var map = {};
        var order = [];
        for (var r = 0; r < trs.length; r++) {
            var nodes = trs[r].querySelectorAll('td, th');
            var cells = [];
            for (var i = 0; i < nodes.length; i++) {
                var piece = cellText(nodes[i]);
                if (piece) cells.push(piece);
            }
            var num = parseInt(cells[0] || '', 10);
            if (isNaN(num)) num = parseInt(cells[1] || '', 10);
            if (isNaN(num)) continue;
            var start = '';
            var end = '';
            for (var j = 0; j < cells.length; j++) {
                if (!/^\d{2}:\d{2}$/.test(cells[j])) continue;
                if (!start) start = cells[j];
                else if (!end) { end = cells[j]; break; }
            }
            if (!(num >= 1 && num <= 30 && start && end)) continue;
            if (map[num]) continue;
            map[num] = { number: num, start: start, end: end };
            order.push(num);
        }
        order.sort(function (a, b) { return a - b; });
        var out = [];
        for (var k = 0; k < order.length; k++) out.push(map[order[k]]);
        return out;
    }

    function looksExpired(html) {
        var source = String(html || '');
        if (source.indexOf('凭证已失效') >= 0) return true;
        if (source.indexOf('请重新登录') >= 0) return true;
        if (/cas\/login/i.test(source)) return true;
        if (/type\s*=\s*["']?password/i.test(source)) return true;
        return false;
    }

    function countChar(source, code) {
        var n = 0;
        var text = String(source);
        for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
        return n;
    }

    function countCjk(source) {
        var n = 0;
        var text = String(source);
        for (var i = 0; i < text.length; i++) {
            var code = text.charCodeAt(i);
            if (code >= 0x4e00 && code <= 0x9fa5) n++;
        }
        return n;
    }

    // 教务页面有的是 UTF-8，有的是 GBK。UTF-8 能完整解开（没有替换字符）就用 UTF-8，
    // 避免短页面被另一种解法误判；只有 UTF-8 解不开时才改用 GBK。
    function decodeBest(buf) {
        var utf8 = '';
        var gbk = null;
        try { utf8 = new TextDecoder('utf-8').decode(buf); } catch (e1) { utf8 = ''; }
        try { gbk = new TextDecoder('gbk').decode(buf); } catch (e2) { gbk = null; }
        var bad = 0xFFFD;
        var utfBad = countChar(utf8, bad);
        var gbkBad = gbk === null ? 1 : countChar(gbk, bad);
        if (gbk === null || utfBad === 0) return utf8;
        if (gbkBad === 0) return gbk;
        if (countCjk(gbk) > countCjk(utf8)) return gbk;
        return gbkBad < utfBad ? gbk : utf8;
    }

    function getBuf(url, options) {
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            var landed = String(response.url || '').toLowerCase();
            return response.arrayBuffer().then(function (buf) {
                return {
                    text: decodeBest(buf),
                    landedOnLogin: landed.indexOf('login.action') >= 0 || landed.indexOf('/cas/') >= 0
                };
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    function pack(term, rows, table) {
        var slots = [];
        var note = 'failed';
        if (table) {
            if (table.landedOnLogin || looksExpired(table.text)) note = 'failed';
            else if (table.text.indexOf('未设置') >= 0 || table.text.indexOf('未设定') >= 0 || table.text.indexOf('未发布') >= 0) note = 'unpublished';
            else {
                slots = slotsOfHtml(table.text);
                note = slots.length ? 'school' : 'empty';
            }
        }
        return {
            term: { xn: term.xn, xq: term.xq, source: term.source },
            today: localTodayIso(),
            rows: rows,
            slots: slots,
            slotsNote: note
        };
    }

    if (!onJwHost()) {
        throw new Error('请先登录河南科技学院的教务系统，打开教务页面后再点「提取课表」');
    }
    if (onLoginPage()) {
        throw new Error('当前打开的是登录页。请先登录河南科技学院的教务系统，再点「提取课表」');
    }

    var fromUrl = termFromUrl();
    var fromPage = fromUrl ? null : readTermFromPage();
    var picked = fromUrl || fromPage || guessTerm(new Date());
    var term = { xn: picked.xn, xq: picked.xq, source: (fromUrl || fromPage) ? 'page' : 'guess' };
    var scheduleUrl = SCHEDULE_URL + '?params=' + encodeURIComponent(btoa('xn=' + term.xn + '&xq=' + term.xq));
    var timeBody = 'xn=' + term.xn + '&xq_m=' + term.xq + '&menucode=&is_ssxq=0&axq=&ssxq=';

    return getBuf(scheduleUrl, { method: 'GET', credentials: 'include' }).then(function (sched) {
        if (sched.landedOnLogin || looksExpired(sched.text)) {
            throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
        }
        var rows = rowsOf(sched.text);
        return getBuf(TIME_URL, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: timeBody
        }).then(function (table) {
            return JSON.stringify(pack(term, rows, table));
        }, function () {
            return JSON.stringify(pack(term, rows, null));
        });
    });
})()
