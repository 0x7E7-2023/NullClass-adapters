(function () {
    // 菏泽学院教务适配器 —— 强智新版学期理论课表。
    // 移植自 shiguang_warehouse 的 HZU/hzu.js（MIT，上游作者 yukoimi）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 03d161a；本校脚本最后一次修改 74c26ff。模板是已审计的 csuft。
    // 两次同源 GET 分别读取当前学期/时间模式和整学期课表，再 GET 教学周历。
    // 学期只读选中项，返回页学期不一致会报错；只交课表卡片和周历白名单字段。
    // 周次、节次、冬夏季和开学日全在 parse.js；登录页与门户零请求，不读凭据。详见 AUDIT.md。
    var JW_HOST = '222.206.176.102';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var LOGIN_HINT = '请先登录菏泽学院教务系统，再打开「学期理论课表」，然后点提取';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
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

    function allByClass(node, name) {
        var all = node.getElementsByTagName('*');
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (hasClass(all[i], name)) out.push(all[i]);
        }
        return out;
    }

    function firstByClass(node, name) {
        var found = allByClass(node, name);
        return found.length ? found[0] : null;
    }

    function childElements(node) {
        var out = [];
        var kids = node.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            if (kids[i].nodeType === 1) out.push(kids[i]);
        }
        return out;
    }

    // 登录页 / 统一认证页 / 学校主页：不发请求。只看地址，不读输入框。
    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host !== JW_HOST) {
            return '当前打开的不是菏泽学院教务系统。' + LOGIN_HINT;
        }
        if (path === '/' || path === '' || /^\/jsxsd\/?$/.test(path) || /^\/jsxsd\/(index|login|xk\/log)/.test(path)) {
            return '当前打开的是登录页。' + LOGIN_HINT;
        }
        return '';
    }

    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function hostOf(url) {
        var m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || ''));
        return m ? m[1].split(':')[0].toLowerCase() : '';
    }

    function titleOf(doc) {
        var titles = doc.getElementsByTagName('title');
        return titles.length ? clean(titles[0].textContent) : '';
    }

    // 课程卡片只留课名和「老师 / 时间 / 地点」原文。是不是卡片由类名判断，解释留给 parse.js。
    function cardOf(node) {
        if (tagOf(node) !== 'LI' || !hasClass(node, 'courselists-item')) return null;
        var title = firstByClass(node, 'qz-hasCourse-title');
        var abbr = firstByClass(node, 'qz-hasCourse-abbrinfo');
        return {
            name: title ? clean(title.textContent) : '',
            abbr: abbr ? clean(abbr.textContent) : ''
        };
    }

    function itemsOf(td) {
        var lists = td.getElementsByTagName('li');
        var out = [];
        for (var i = 0; i < lists.length; i++) {
            var card = cardOf(lists[i]);
            if (card) out.push(card);
        }
        return out;
    }

    function spanOf(node) {
        var value = parseInt(attrOf(node, 'rowspan'), 10);
        return value >= 1 ? value : 1;
    }

    function rowOf(tr) {
        var sectionText = '';
        var cells = [];
        var kids = childElements(tr);
        for (var i = 0; i < kids.length; i++) {
            if (tagOf(kids[i]) !== 'TD') continue;
            var name = attrOf(kids[i], 'name');
            if (name === 'timeTd' && !sectionText) sectionText = clean(kids[i].textContent);
            if (name === 'kbDataTd') {
                cells.push({ rowspan: spanOf(kids[i]), items: itemsOf(kids[i]) });
            }
        }
        return { sectionText: sectionText, cells: cells };
    }

    function findTimetable(doc) {
        var tables = doc.getElementsByTagName('table');
        var best = null;
        var bestCount = -1;
        for (var i = 0; i < tables.length; i++) {
            var tds = tables[i].getElementsByTagName('td');
            var count = 0;
            for (var k = 0; k < tds.length; k++) {
                if (attrOf(tds[k], 'name') === 'kbDataTd') count++;
            }
            if (count > bestCount) {
                best = tables[i];
                bestCount = count;
            }
        }
        return bestCount > 0 ? best : null;
    }

    function timetableOf(doc) {
        var table = findTimetable(doc);
        if (!table) return [];
        var bodies = table.getElementsByTagName('tbody');
        var scope = bodies.length ? bodies : [table];
        var rows = [];
        for (var b = 0; b < scope.length; b++) {
            var trs = scope[b].getElementsByTagName('tr');
            for (var t = 0; t < trs.length; t++) {
                if (scope[b] !== table && trs[t].parentNode !== scope[b]) continue;
                var row = rowOf(trs[t]);
                if (row.cells.length || row.sectionText) rows.push(row);
            }
        }
        return rows;
    }

    // 教学周历：第 N 周那一行的标签，以及按从左到右的日期格文字（星期一在第 1 格）。
    function calendarOf(doc) {
        var dataTable = doc.getElementById('dataTable');
        var trs = (dataTable || doc).getElementsByTagName('tr');
        var weeks = [];
        for (var i = 0; i < trs.length; i++) {
            var days = [];
            var tds = trs[i].getElementsByTagName('td');
            var labelNode = firstByClass(trs[i], 'qz-weeklyTable-label');
            if (labelNode) {
                var inner = firstByClass(labelNode, 'td-cell');
                for (var k = 0; k < tds.length; k++) {
                    if (tds[k].parentNode !== trs[i]) continue;
                    if (hasClass(tds[k], 'qz-weeklyTable-normalDay')) days.push(clean(tds[k].textContent));
                }
                weeks.push({ label: clean((inner || labelNode).textContent), days: days });
            } else if (dataTable && tds.length >= 2 && /^第\s*\d+\s*周$/.test(clean(tds[0].textContent))) {
                for (var d = 1; d < tds.length && d <= 7; d++) days.push(clean(tds[d].textContent));
                weeks.push({ label: clean(tds[0].textContent), days: days });
            }
        }
        return { weeks: weeks };
    }

    function termOf(doc) {
        var select = doc.getElementById('xnxq01id');
        if (!select || !select.options) return null;
        var chosen = null;
        for (var i = 0; i < select.options.length; i++) {
            var opt = select.options[i];
            if (opt.selected || attrOf(opt, 'selected') !== '') chosen = opt;
        }
        if (!chosen && select.value) {
            for (var j = 0; j < select.options.length; j++) {
                if (String(select.options[j].value) === String(select.value)) chosen = select.options[j];
            }
        }
        if (!chosen) return null;
        var code = clean(chosen.value);
        if (!code) return null;
        return { code: code, name: clean(chosen.textContent) || code };
    }

    function readResponse(response) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('教务系统拒绝访问（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        if (hostOf(response.url) && hostOf(response.url) !== JW_HOST) {
            throw new Error('登录已失效。' + LOGIN_HINT);
        }
        return response.text().then(function (html) {
            return new DOMParser().parseFromString(html, 'text/html');
        });
    }

    function requestDoc(url, options) {
        return fetch(url, options).then(readResponse, function () {
            throw new Error('连不上教务系统。' + LOGIN_HINT);
        });
    }

    function getDoc(url) {
        return requestDoc(url, { method: 'GET', credentials: 'same-origin' });
    }

    function scheduleQuery(code, mode) {
        var params = { viweType: '0', zc: '' };
        if (code) params.xnxq01id = code;
        if (mode) params.kbjcmsid = mode;
        var parts = [];
        for (var key in params) {
            if (params.hasOwnProperty(key)) parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
        }
        return parts.join('&');
    }

    function modeOf(doc) {
        var select = doc.getElementById('kbjcmsid');
        if (!select || !select.options || !select.options.length) return '';
        for (var i = 0; i < select.options.length; i++) {
            if (select.options[i].selected) return clean(select.options[i].value);
        }
        return clean(select.options[0].value);
    }

    function countItems(rows) {
        var n = 0;
        for (var r = 0; r < rows.length; r++) {
            var cells = rows[r].cells || [];
            for (var c = 0; c < cells.length; c++) n += (cells[c].items || []).length;
        }
        return n;
    }

    function fetchCalendar(code) {
        return getDoc(CALENDAR_PATH + '?xnxq01id=' + encodeURIComponent(code || '')).then(function (doc) {
            var shown = termOf(doc);
            if (shown && shown.code !== code) return { weeks: [] };
            return calendarOf(doc);
        }, function () {
            return { weeks: [] };
        });
    }

    function run() {
        var hint = loginHint();
        if (hint) return Promise.reject(new Error(hint));
        return getDoc(SCHEDULE_PATH + '?' + scheduleQuery('', '')).then(function (initial) {
            var term = termOf(initial);
            if (!term) throw new Error('当前页面找不到学年学期。' + LOGIN_HINT);
            var mode = modeOf(initial);
            return getDoc(SCHEDULE_PATH + '?' + scheduleQuery(term.code, mode)).then(function (page) {
                if (titleOf(page).indexOf('登录') >= 0 && !findTimetable(page)) {
                    throw new Error('登录已失效。' + LOGIN_HINT);
                }
                var shownTerm = termOf(page);
                if (shownTerm && shownTerm.code !== term.code) {
                    throw new Error('教务返回的学期与当前选择不一致，请重新打开课表后再试');
                }
                var rows = timetableOf(page);
                if (!countItems(rows)) throw new Error('没有找到课程。请确认已经打开本学期课表再点提取');
                return fetchCalendar(term.code).then(function (calendar) {
                    return JSON.stringify({
                        source: 'qz-jsxsd',
                        pageUrl: pageUrlOf(),
                        now: todayIso(),
                        term: term,
                        calendar: calendar,
                        rows: rows
                    });
                });
            });
        });
    }

    return run();
})()
