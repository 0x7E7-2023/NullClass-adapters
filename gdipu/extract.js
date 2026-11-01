(function () {
    // 广东轻工职业技术大学 教务适配器 —— 强智学生端首页课表片段（/jsxsd/）。
    // 移植自 shiguang_warehouse 的 GDIPU/gdipu.js（MIT）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/GDIPU/adapters.yaml 的 maintainer 是 LittleArray；gdipu.js 正文没有署名。
    // manifest 用上游名单里的 LittleArray，不写仓库组织名。
    // 上游快照 03d161a；本校脚本最后一次修改 80e30cf。
    // 周次、节次、提醒的写法参考已审计的 gdkm，请求不照抄 gdkm：
    // 上游只 POST /jsxsd/framework/main_index_loadkb.jsp，正文 rq= 加日期，再按周循环。
    // 不请求 xskb_list.do。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   1. 删掉上游的开学日手填框。开学的那个周一优先用当前页教学周历推算；
    //      推不出来就从本周周一开始按周往前找，具体怎么对齐交给 parse.js，并写进提醒；
    //   2. 不写死主机名：只 POST 当前页同源的根相对路径；
    //   3. 登录页、统一认证页、学校主页上点提取：不发请求，直接给大白话提示；
    //   4. 只交原始结构：学期代码与名称、周历标签和日期格、每一周的请求日期、
    //      页上的周次短句、每格 p 的 title 原文、行首节次原文。
    //      周次、节次、开学日的解释全在 parse.js；
    //   5. 不读账号，不读整页自由文本。学号、姓名若出现在卡片以外，不带出。
    //
    // 只请求当前页面同源的教务。不写页面，不外发任何数据。详见 AUDIT.md。
    var JW_HOST = 'jw.gdipu.edu.cn';
    var KB_PATH = '/jsxsd/framework/main_index_loadkb.jsp';
    var LOGIN_HINT = '请先登录教务系统，再打开课表页，然后点提取';
    var MAX_WEEKS = 20;

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoOf(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function todayIso() {
        return isoOf(new Date());
    }

    function parseIso(isoDate) {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(clean(isoDate));
        if (!m) return null;
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }

    function addDays(isoDate, days) {
        var day = parseIso(isoDate);
        if (!day) return null;
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() + days));
    }

    function mondayOf(isoDate) {
        var day = parseIso(isoDate);
        if (!day) return null;
        var back = (day.getDay() + 6) % 7;
        return isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() - back));
    }

    function tagOf(node) {
        return String((node && node.tagName) || '').toUpperCase();
    }

    function attrOf(node, name) {
        return node && node.getAttribute ? String(node.getAttribute(name) || '') : '';
    }

    function hasClass(node, name) {
        var classes = ' ' + String(node.className || '').replace(/\s+/g, ' ') + ' ';
        return classes.indexOf(' ' + name + ' ') >= 0;
    }

    function childElements(node) {
        var out = [];
        var kids = node.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            if (kids[i].nodeType === 1) out.push(kids[i]);
        }
        return out;
    }

    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host !== JW_HOST) {
            return '当前打开的不是广东轻工职业技术大学教务系统。' + LOGIN_HINT;
        }
        if (path === '/' || path === '' || /^\/jsxsd\/?$/.test(path) || /^\/jsxsd\/(index|login|xk\/log)/.test(path)) {
            return '当前打开的是登录页。' + LOGIN_HINT;
        }
        return '';
    }

    function hostOf(url) {
        var m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || ''));
        return m ? m[1].split(':')[0].toLowerCase() : '';
    }

    function titleOf(doc) {
        var titles = doc.getElementsByTagName('title');
        return titles.length ? clean(titles[0].textContent) : '';
    }

    function firstByClass(node, name) {
        var all = node.getElementsByTagName('*');
        for (var i = 0; i < all.length; i++) {
            if (hasClass(all[i], name)) return all[i];
        }
        return null;
    }

    function termOf(doc) {
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length; i++) {
            var identity = String(selects[i].id || '') + ' ' + String(selects[i].name || '');
            if (identity.indexOf('xnxq') < 0) continue;
            var options = selects[i].options || [];
            var chosen = null;
            var first = null;
            for (var j = 0; j < options.length; j++) {
                var code = clean(options[j].value);
                if (!code) continue;
                if (!first) first = options[j];
                if (options[j].selected || attrOf(options[j], 'selected') !== '') chosen = options[j];
            }
            var opt = chosen || first;
            if (!opt) continue;
            var value = clean(opt.value);
            if (!value) continue;
            return { code: value, name: clean(opt.textContent) || value };
        }
        return { code: '', name: '' };
    }

    function calendarOf(doc) {
        var trs = doc.getElementsByTagName('tr');
        var weeks = [];
        for (var i = 0; i < trs.length; i++) {
            var labelNode = firstByClass(trs[i], 'qz-weeklyTable-label');
            if (!labelNode) continue;
            var inner = firstByClass(labelNode, 'td-cell');
            var days = [];
            var tds = childElements(trs[i]);
            for (var k = 0; k < tds.length; k++) {
                if (tagOf(tds[k]) !== 'TD') continue;
                if (hasClass(tds[k], 'qz-weeklyTable-normalDay')) days.push(clean(tds[k].textContent));
            }
            weeks.push({ label: clean((inner || labelNode).textContent), days: days });
        }
        return { weeks: weeks };
    }

    function isoParts(year, month, day) {
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        var probe = new Date(year, month - 1, day);
        if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
        return year + '-' + pad2(month) + '-' + pad2(day);
    }

    function yearForMonth(code, month) {
        var text = clean(code);
        var pair = /^(\d{4})\s*-\s*(\d{4})/.exec(text);
        if (pair) {
            var start = parseInt(pair[1], 10);
            var end = parseInt(pair[2], 10);
            if (end === start + 1) return month >= 8 ? start : end;
            return start;
        }
        var one = /^(\d{4})/.exec(text);
        return one ? parseInt(one[1], 10) : 0;
    }

    // 与 parse.js 的 firstMondayFromCalendar 同一套：只为决定从哪一周开始请求。
    function firstMondayFromCalendar(weeks, code) {
        for (var i = 0; i < weeks.length; i++) {
            if (!/^第\s*1\s*周$/.test(clean(weeks[i].label))) continue;
            var days = weeks[i].days || [];
            var mondayText = clean(days[0] || '');
            var saturdayText = clean(days[5] || '');
            var sat = /(\d{1,2})月(\d{1,2})日/.exec(saturdayText);
            if (!sat) return null;
            var month = parseInt(sat[1], 10);
            var satDay = parseInt(sat[2], 10);
            var dayMatch = /(\d{1,2})日/.exec(mondayText);
            var day = dayMatch ? parseInt(dayMatch[1], 10) : parseInt(mondayText, 10);
            if (!(day >= 1)) return null;
            if (day > satDay) {
                month = month - 1;
                if (month === 0) month = 12;
            }
            var year = yearForMonth(code, month);
            if (!year) return null;
            return isoParts(year, month, day);
        }
        return null;
    }

    function findKb(doc) {
        var tables = doc.getElementsByTagName('table');
        var fallback = null;
        for (var i = 0; i < tables.length; i++) {
            if (!hasClass(tables[i], 'kb_table')) continue;
            if (!fallback) fallback = tables[i];
            var node = tables[i].parentNode;
            while (node) {
                if (tagOf(node) === 'FORM') return tables[i];
                node = node.parentNode;
            }
        }
        return fallback;
    }

    function titlesOf(td) {
        var ps = td.getElementsByTagName('p');
        var out = [];
        for (var i = 0; i < ps.length; i++) {
            var title = attrOf(ps[i], 'title');
            if (title) out.push(title);
        }
        return out;
    }

    function firstLine(text) {
        var parts = String(text || '').split('\n');
        return clean(parts[0]);
    }

    function weekTextOf(doc) {
        var all = doc.getElementsByTagName('*');
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (tagOf(el) === 'P' && attrOf(el, 'title')) continue;
            var ident = String(el.id || '') + ' ' + String(el.className || '');
            ident = ident.toLowerCase();
            if (ident.indexOf('week') < 0 && ident.indexOf('zc') < 0) continue;
            var text = clean(el.textContent);
            if (!text || text.length > 30) continue;
            var m = /第\s*(\d+)\s*周/.exec(text);
            if (m) return '第' + m[1] + '周';
        }
        return '';
    }

    function harvestKb(doc, iso) {
        var table = findKb(doc);
        var rows = [];
        if (table) {
            var bodies = table.getElementsByTagName('tbody');
            var scope = bodies.length ? bodies[0] : table;
            var trs = scope.getElementsByTagName('tr');
            for (var t = 0; t < trs.length; t++) {
                if (trs[t].parentNode !== scope && trs[t].parentNode.parentNode !== scope) continue;
                var tds = childElements(trs[t]);
                var tdList = [];
                var c;
                for (c = 0; c < tds.length; c++) {
                    if (tagOf(tds[c]) === 'TD') tdList.push(tds[c]);
                }
                var cells = [];
                var section = '';
                var start = 0;
                // 满 8 列时第一格是节次，哪怕里面只有空白。不能因为文字是空的就改读下一格，
                // 否则星期一会被当成节次，后面的星期全部错一位。
                // 只有 7 列、而且第一格里已经是课程时，这一行没有节次格（上一行 rowspan），从星期一开始。
                if (tdList.length >= 8 || (tdList.length && !titlesOf(tdList[0]).length)) {
                    section = firstLine(tdList[0].textContent);
                    start = 1;
                }
                var day = 0;
                for (c = start; c < tdList.length; c++) {
                    day++;
                    if (day > 7) break;
                    var titles = titlesOf(tdList[c]);
                    if (!titles.length) continue;
                    cells.push({ day: day, titles: titles });
                }
                if (cells.length) rows.push({ section: section, cells: cells });
            }
        }
        return { rq: iso, weekText: weekTextOf(doc), rows: rows };
    }

    function countTitles(block) {
        var n = 0;
        var rows = (block && block.rows) || [];
        for (var i = 0; i < rows.length; i++) {
            var cells = rows[i].cells || [];
            for (var c = 0; c < cells.length; c++) n += (cells[c].titles || []).length;
        }
        return n;
    }

    function isLoginDoc(doc, block) {
        if (countTitles(block) > 0) return false;
        var title = titleOf(doc);
        if (title.indexOf('登录') >= 0) return true;
        if (title.indexOf('统一身份') >= 0) return true;
        return false;
    }

    function readText(response) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('教务系统拒绝访问（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        if (hostOf(response.url) && hostOf(response.url) !== JW_HOST) {
            throw new Error('登录已失效。' + LOGIN_HINT);
        }
        return response.text();
    }

    function postWeek(iso) {
        return fetch(KB_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: 'rq=' + encodeURIComponent(iso)
        }).then(readText, function () {
            throw new Error('连不上教务系统。' + LOGIN_HINT);
        }).then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var block = harvestKb(doc, iso);
            if (isLoginDoc(doc, block)) throw new Error('登录已失效。' + LOGIN_HINT);
            return block;
        });
    }

    function walkBack(iso, left, acc) {
        if (left <= 0 || !iso) return Promise.resolve(acc);
        return postWeek(iso).then(function (block) {
            if (countTitles(block) === 0) return acc;
            acc.unshift(block);
            return walkBack(addDays(iso, -7), left - 1, acc);
        });
    }

    function walkForward(iso, left, acc, keepGoing) {
        if (left <= 0 || !iso) return Promise.resolve(acc);
        return postWeek(iso).then(function (block) {
            var empty = countTitles(block) === 0;
            if (!empty) acc.push(block);
            if (empty && !keepGoing) return acc;
            return walkForward(addDays(iso, 7), left - 1, acc, keepGoing);
        });
    }

    function finish(term, calendar, fetched) {
        if (!fetched.length) {
            throw new Error('没有找到课程。请确认已经登录并打开本学期课表再点提取');
        }
        return JSON.stringify({
            now: todayIso(),
            term: term,
            calendar: calendar,
            fetched: fetched
        });
    }

    var hinted = loginHint();
    if (hinted) throw new Error(hinted);

    var term = termOf(document);
    var calendar = calendarOf(document);
    var fromCalendar = firstMondayFromCalendar(calendar.weeks || [], term.code || term.name);
    var origin = mondayOf(fromCalendar || todayIso());
    if (!origin) throw new Error('无法确定今天的日期，无法推算开学日期，请重新导入');

    if (fromCalendar) {
        var span = (calendar.weeks && calendar.weeks.length) ? calendar.weeks.length : MAX_WEEKS;
        if (span > MAX_WEEKS) span = MAX_WEEKS;
        if (span < 1) span = MAX_WEEKS;
        return walkForward(origin, span, [], true).then(function (fetched) {
            return finish(term, calendar, fetched);
        });
    }

    return postWeek(origin).then(function (block) {
        if (countTitles(block) > 0) {
            return walkBack(addDays(origin, -7), MAX_WEEKS - 1, [block]).then(function (acc) {
                var room = MAX_WEEKS - acc.length;
                if (room <= 0) return acc;
                return walkForward(addDays(acc[acc.length - 1].rq, 7), room, acc);
            });
        }
        return walkBack(addDays(origin, -7), MAX_WEEKS, []).then(function (acc) {
            if (!acc.length) return acc;
            var room = MAX_WEEKS - acc.length;
            if (room <= 0) return acc;
            return walkForward(addDays(acc[acc.length - 1].rq, 7), room, acc);
        });
    }).then(function (fetched) {
        return finish(term, calendar, fetched);
    });
})()
