(function () {
    // 重庆工商职业学院教务适配器（强智 jsxsd）——只取课程卡片原文与周次配置。
    // 移植自 shiguang_warehouse 的 CQTBI/cqtbi.js（MIT，上游作者 Haooz）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 03d161a；本校脚本最后修改 17f7499。
    // 仅访问当前教务源的一个课表接口；支持当前页与同源 iframe，不读登录字段、不写页面。
    var JW_HOST = 'jwgl.cqtbi.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/framework/mainV_index_loadkb.htmlx';
    var LOGIN_HINT = '请先登录重庆工商职业学院教务系统并打开课表页面，再点提取';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function loginHint() {
        var host = String(window.location.hostname || '').toLowerCase();
        var path = String(window.location.pathname || '').toLowerCase();
        if (host !== JW_HOST) return '当前打开的不是重庆工商职业学院教务系统。' + LOGIN_HINT;
        if (path === '/' || path === '' || /^\/jsxsd\/?$/.test(path) || /login/.test(path)) {
            return '当前打开的是登录页或教务首页。' + LOGIN_HINT;
        }
        return '';
    }

    function collectDocs() {
        var docs = [document];
        var frames = document.getElementsByTagName('iframe');
        for (var i = 0; i < frames.length; i++) {
            try {
                var doc = frames[i].contentDocument;
                if (doc && doc.location && String(doc.location.hostname).toLowerCase() === JW_HOST) docs.push(doc);
            } catch (e) {
                // 跨域 frame 不访问，也不请求。
            }
        }
        return docs;
    }

    function selectedOption(select) {
        if (!select || !select.options || !select.options.length) return null;
        for (var i = 0; i < select.options.length; i++) {
            if (select.options[i].selected) return select.options[i];
        }
        return select.options[select.selectedIndex >= 0 ? select.selectedIndex : 0];
    }

    function termOf(doc) {
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length; i++) {
            var option = selectedOption(selects[i]);
            if (!option) continue;
            var value = clean(option.textContent || option.value);
            if (/^\d{4}-\d{4}-\d$/.test(value)) return value;
            value = clean(option.value);
            if (/^\d{4}-\d{4}-\d$/.test(value)) return value;
        }
        return '';
    }

    function modeOf(doc) {
        var list = doc.getElementById('kbjcmsid_ul');
        if (!list) return '';
        var items = list.getElementsByTagName('li');
        var first = '';
        for (var i = 0; i < items.length; i++) {
            var value = clean(items[i].getAttribute('data-value'));
            if (!value) continue;
            if (!first) first = value;
            if ((' ' + String(items[i].className || '') + ' ').indexOf(' layui-this ') >= 0) return value;
        }
        return first;
    }

    function calendarOf(doc) {
        var select = doc.getElementById('week');
        if (!select || !select.options) return null;
        var dates = [];
        for (var i = 0; i < select.options.length; i++) {
            var value = clean(select.options[i].value);
            if (/^\d{4}-\d{2}-\d{2}$/.test(value)) dates.push(value);
        }
        if (!dates.length) return null;
        return { firstDate: dates[0], totalWeeks: dates.length };
    }

    function children(node) {
        var out = [];
        var list = node.childNodes || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].nodeType === 1) out.push(list[i]);
        }
        return out;
    }

    function hasClass(node, name) {
        return (' ' + String(node.className || '').replace(/\s+/g, ' ') + ' ').indexOf(' ' + name + ' ') >= 0;
    }

    function byClass(node, name) {
        var all = node.getElementsByTagName('*');
        var out = [];
        for (var i = 0; i < all.length; i++) if (hasClass(all[i], name)) out.push(all[i]);
        return out;
    }

    function nextByClass(node, name) {
        var cur = node.nextSibling;
        while (cur) {
            if (cur.nodeType === 1 && hasClass(cur, name)) return cur;
            cur = cur.nextSibling;
        }
        return null;
    }

    function nextTag(node, tag) {
        var cur = node.nextSibling;
        while (cur) {
            if (cur.nodeType === 1 && String(cur.tagName).toUpperCase() === tag) return cur;
            cur = cur.nextSibling;
        }
        return null;
    }

    function cardOf(nameNode, day) {
        var teacherNode = nextByClass(nameNode, 'tch-name');
        if (!teacherNode) return null;
        var infoNode = nextTag(teacherNode, 'DIV');
        if (!infoNode) return null;
        var teacherSpans = teacherNode.getElementsByTagName('span');
        var infoSpans = infoNode.getElementsByTagName('span');
        return {
            name: clean(nameNode.textContent),
            teacherText: teacherSpans.length ? clean(teacherSpans[0].textContent) : '',
            sectionsText: teacherSpans.length > 2 ? clean(teacherSpans[2].textContent) : '',
            roomText: infoSpans.length ? clean(infoSpans[0].textContent) : '',
            weekText: infoSpans.length > 1 ? clean(infoSpans[1].textContent) : '',
            day: day
        };
    }

    function itemsOf(doc) {
        var table = doc.getElementById('timetable');
        if (!table) return [];
        var rows = table.getElementsByTagName('tr');
        var out = [];
        for (var r = 0; r < rows.length; r++) {
            var cells = children(rows[r]);
            if (cells.length < 2) continue;
            var hasColspan = false;
            for (var c = 0; c < cells.length; c++) {
                if (String(cells[c].tagName).toUpperCase() === 'TD' && cells[c].getAttribute('colspan')) hasColspan = true;
            }
            if (hasColspan) continue;
            for (var day = 1; day <= 7 && day < cells.length; day++) {
                var boxes = byClass(cells[day], 'item-box');
                for (var b = 0; b < boxes.length; b++) {
                    var parts = children(boxes[b]);
                    for (var p = 0; p < parts.length; p++) {
                        if (String(parts[p].tagName).toUpperCase() !== 'P') continue;
                        var card = cardOf(parts[p], day);
                        if (card) out.push(card);
                    }
                }
            }
        }
        return out;
    }

    function readResponse(response) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('教务系统拒绝访问（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        return response.text();
    }

    function run() {
        var hint = loginHint();
        if (hint) return Promise.reject(new Error(hint));
        var docs = collectDocs();
        var term = '';
        var mode = '';
        var calendar = null;
        for (var i = 0; i < docs.length; i++) {
            if (!term) term = termOf(docs[i]);
            if (!mode) mode = modeOf(docs[i]);
            if (!calendar) calendar = calendarOf(docs[i]);
        }
        if (!term) throw new Error('没能读取当前学年学期。' + LOGIN_HINT);
        if (!mode) throw new Error('没能读取课表时间模式。' + LOGIN_HINT);
        var query = '?rq=all&sjmsValue=' + encodeURIComponent(mode) +
            '&xnxqid=' + encodeURIComponent(term) + '&xswk=false';
        return fetch(SCHEDULE_PATH + query, { method: 'GET', credentials: 'same-origin' })
            .then(readResponse, function () { throw new Error('连不上教务系统。' + LOGIN_HINT); })
            .then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var items = itemsOf(doc);
                if (!items.length) throw new Error('课表接口没有返回可识别的课程，请确认当前学期有课且选择了全部周');
                return JSON.stringify({
                    source: 'cqtbi-mainV',
                    termCode: term,
                    today: todayIso(),
                    calendar: calendar,
                    items: items
                });
            });
    }

    return run();
})()
