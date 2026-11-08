(function () {
    // 浙江工商职业技术学院教务适配器（青果教务，WebVPN 下 /zjgsjw 上下文）—— 第一步：只取课表原始文字。
    // 移植自 shiguang_warehouse 的 ZJBTI/zjbti.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 LanRhyme）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e；本校脚本最后一次修改 72967b1
    //
    // 移植改动（对应 AUDIT.md）：
    //   ① 学期弹窗改为读当前地址 params、页面 xnxq 控件，再按节次锚点日期判断；只取一个学期。
    //   ② 课表格子只交逐行文字；5 或 7 天识别、课程块两种回退选择器照上游，解析与合并移到 parse.js。
    //   ③ 开学日不再弹窗确认，只交周历中的 MM-DD；总周数不再取课表最大周，由 parse.js 按 20 周起步。
    //   ④ 仅当当前路径含独立 /zjgsjw 段时请求；保留它之前的 WebVPN 前缀。登录页、门户和入口根路径零请求。
    //   ⑤ 输出使用字段白名单，不读凭据、不取网页属性、不交学期列表额外键或周历正文。
    //   ⑥ 上游提示、保存、完成通知等宿主桥调用不移植，保存由空课完成。
    //
    // 同源只读请求：POST 学期下拉列表；GET GBK 学生课表；POST GBK 第 1 周周课表。
    var CONTEXT = '/zjgsjw';
    var LIST_PATH = '/frame/droplist/getDropLists.action';
    var SCHEDULE_PATH = '/student/wsxk.xskcb10319.jsp';
    var WEEK_PATH = '/frame/desk/showLessonScheduleInfosV14.action';
    var LINE_LIMIT = 200;
    var DATE_LIMIT = 14;

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(CONTEXT);
        while (at >= 0) {
            var end = at + CONTEXT.length;
            if (end === path.length || path.charAt(end) === '/') {
                return originOf() + path.substring(0, end);
            }
            at = path.indexOf(CONTEXT, at + 1);
        }
        return null;
    }

    function onLoginPage() {
        return String(window.location.pathname || '').toLowerCase().indexOf('/cas/login') >= 0;
    }

    var CODE_SHAPE = /^[0-9]{4}-[01]$/;

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

    function mondayTime(year, month, day) {
        var date = new Date(year, month - 1, day);
        date.setDate(date.getDate() - (date.getDay() + 6) % 7);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    }

    // 学期切换与开学日推算使用同一锚点：9 月 1 日、2 月 20 日各自所在周的周一。
    function guessTerm(now) {
        var year = now.getFullYear();
        var time = now.getTime();
        if (time >= mondayTime(year, 9, 1)) return year + '-0';
        if (time >= mondayTime(year, 2, 20)) return (year - 1) + '-1';
        return (year - 1) + '-0';
    }

    function failure(response) {
        return new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再点「提取课表」');
    }

    function unreachable(error) {
        var detail = error && error.message ? '（' + error.message + '）' : '';
        return new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
    }

    function decodeGbk(buffer) {
        return new TextDecoder('gbk').decode(buffer);
    }

    function fetchTermList(base) {
        return fetch(base + LIST_PATH, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: 'comboBoxName=StMsXnxqDxDesc&paramValue=&isYXB=0&isCDDW=0&isXQ=0&isDJKSLB=0&isZY=0'
        }).then(function (response) {
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

    function looksLikeLogin(html) {
        return /cas\/login/i.test(html) || /type\s*=\s*["']?password/i.test(html);
    }

    function hasCourseTime(value) {
        return /\[[0-9]+.*\]/.test(String(value || ''));
    }

    function groupApplies(rule) {
        // 条件分组只在当前环境确实生效时才可能隐藏课程；判不准时宁可当作不生效，避免静默丢课。
        if (rule.media) {
            if (!window.matchMedia) return false;
            try {
                return window.matchMedia(rule.media.mediaText || String(rule.media)).matches === true;
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    function declarationHides(node, rule) {
        if (!rule.style || !rule.selectorText) return false;
        var display = rule.style.getPropertyValue('display');
        var visibility = rule.style.getPropertyValue('visibility');
        if (display !== 'none' && visibility !== 'hidden' && visibility !== 'collapse') return false;
        var matches = node.matches || node.msMatchesSelector;
        if (!matches) return false;
        try {
            return matches.call(node, rule.selectorText) === true;
        } catch (e) {
            // 不认的选择器不据此隐藏可见课程。
            return false;
        }
    }

    function rulesHide(node, rules) {
        for (var i = 0; rules && i < rules.length; i++) {
            var rule = rules[i];
            if (rule.selectorText) {
                // 新版内核给普通规则也挂了空 cssRules（CSS 嵌套）；有选择器就先按普通声明判断。
                // 嵌套子规则的选择器是相对父选择器的，单独套用会误隐藏可见课程，因此不递归。
                if (declarationHides(node, rule)) return true;
            } else if (groupApplies(rule) && rulesHide(node, rule.cssRules)) {
                return true;
            }
        }
        return false;
    }

    function stylesheetHides(node) {
        var doc = node.ownerDocument;
        var sheets = doc && doc.styleSheets;
        for (var i = 0; sheets && i < sheets.length; i++) {
            try {
                if (rulesHide(node, sheets[i].cssRules)) return true;
            } catch (e) {
                // 跨域或不可读样式表不读取；内联与隐藏属性仍处理。
            }
        }
        return false;
    }

    // DOMParser 的文档不插入当前页面；同时检查内联、文档样式、计算样式和隐藏属性，隐藏祖先也会挡住后代。
    function isVisible(node) {
        var current = node && node.nodeType === 3 ? node.parentElement : node;
        while (current && current.nodeType === 1) {
            if (current.hidden || current.getAttribute('hidden') !== null || current.getAttribute('aria-hidden') === 'true') return false;
            var style = String(current.getAttribute('style') || '').toLowerCase().replace(/\s+/g, '');
            if (style.indexOf('display:none') >= 0 || style.indexOf('visibility:hidden') >= 0 || style.indexOf('visibility:collapse') >= 0) return false;
            if (stylesheetHides(current)) return false;
            if (window.getComputedStyle) {
                try {
                    var computed = window.getComputedStyle(current);
                    if (computed && (computed.display === 'none' || computed.visibility === 'hidden' || computed.visibility === 'collapse')) return false;
                } catch (e) {
                    // 内联、文档规则与祖先检查仍然有效。
                }
            }
            current = current.parentElement;
        }
        return true;
    }

    function visibleText(node) {
        if (!node) return '';
        if (node.nodeType === 3) return String(node.nodeValue || '');
        if (node.nodeType !== 1 || !isVisible(node)) return '';
        var tag = String(node.tagName || '').toLowerCase();
        if (tag === 'script' || tag === 'style') return '';
        var out = '';
        var children = node.childNodes;
        for (var i = 0; i < children.length; i++) out += visibleText(children[i]);
        return out;
    }

    function courseLines(node) {
        var lines = [];
        var nodes = node.childNodes;
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].nodeType === 8) continue;
            var line = visibleText(nodes[i]).trim();
            if (line) lines.push(line);
        }
        if (lines.length === 1 && lines[0].indexOf('\n') >= 0) {
            lines = lines[0].split(/\n+/);
        }
        var out = [];
        for (var j = 0; j < lines.length; j++) {
            var clean = String(lines[j]).trim();
            if (clean) out.push(clean.length > LINE_LIMIT ? clean.substring(0, LINE_LIMIT) : clean);
        }
        return out;
    }

    // 上游先找 padding-bottom 课程块；找不到时找文字含 [数字…] 的 div，再退回整个格子。
    function courseNodesOf(cell) {
        var nodes = cell.querySelectorAll("div[style*='padding-bottom']");
        var primary = [];
        var i;
        for (i = 0; i < nodes.length; i++) {
            if (isVisible(nodes[i])) primary.push(nodes[i]);
        }
        if (primary.length) return primary;
        var all = cell.querySelectorAll('div');
        var found = [];
        for (i = 0; i < all.length; i++) {
            if (isVisible(all[i]) && hasCourseTime(visibleText(all[i]))) found.push(all[i]);
        }
        if (found.length) return found;
        return hasCourseTime(visibleText(cell)) ? [cell] : [];
    }

    function weekdayOf(value) {
        var clean = textOf(value).replace(/\s+/g, '');
        var matched = /(?:星期|周)([一二三四五六日])/.exec(clean);
        if (matched) return matched[1];
        return /^[一二三四五六日]$/.test(clean) ? clean : '';
    }

    // 按真实星期词识别 5 天或 7 天；中文日期中的“日”不再是星期日。
    function cellsOf(doc) {
        var table = doc.getElementById('mytable') || doc.querySelector('table.table');
        if (!table) return null;
        var totalDays = 7;
        var rows = table.rows;
        for (var r = 0; r < rows.length; r++) {
            var headerCells = rows[r].cells;
            var weekdays = {};
            for (var h = 0; h < headerCells.length; h++) {
                var weekday = weekdayOf(visibleText(headerCells[h]));
                if (weekday) weekdays[weekday] = true;
            }
            if (weekdays['一'] && (weekdays['六'] || weekdays['日'])) { totalDays = 7; break; }
            if (weekdays['一'] && weekdays['五']) { totalDays = 5; break; }
        }
        var out = [];
        for (var ri = 0; ri < rows.length; ri++) {
            var cells = rows[ri].cells;
            if (cells.length < totalDays) continue;
            var first = cells.length - totalDays;
            for (var ci = first; ci < cells.length; ci++) {
                var cell = cells[ci];
                if (String(cell.tagName || '').toLowerCase() === 'th') continue;
                var nodes = courseNodesOf(cell);
                var courses = [];
                for (var ni = 0; ni < nodes.length; ni++) {
                    var lines = courseLines(nodes[ni]);
                    if (lines.length) courses.push(lines);
                }
                var item = { d: ci - first + 1 };
                if (courses.length) {
                    item.courses = courses;
                } else {
                    if (!textOf(visibleText(cell))) continue;
                    item.stray = true;
                }
                out.push(item);
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
                if (!cells && (landed.indexOf('/cas/login') >= 0 || looksLikeLogin(html))) {
                    throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
                }
                return cells;
            });
        }, function (error) {
            throw unreachable(error);
        });
    }

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
        throw new Error('请先在 WebVPN 中进入「教务管理」，打开教务首页或课表页后再点「提取课表」');
    }

    var pageCode = readTermFromPage();
    return fetchTermList(base).then(function (list) {
        var code = pageCode;
        var source = 'page';
        if (!code) {
            code = guessTerm(new Date());
            source = 'guess';
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
