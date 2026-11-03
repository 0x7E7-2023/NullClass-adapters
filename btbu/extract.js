(function () {
    // 北京工商大学 教务适配器 —— 强智科技旧版课表页（/jsxsd/），校园网直连或经学校 WebVPN 访问。
    // 移植自 shiguang_warehouse 的 BTBU/btbu.js（MIT，上游作者 lztttt）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 29498b0；本校脚本最后一次修改 80e30cf（批量合并，提交者不是作者）。
    // 模板是已审计的 csuft（同为强智 /jsxsd/，WebVPN 前缀与提示结构沿用）；课表形态按上游读 #timetable 与 font 卡片，
    // 不照抄 csuft 的 qz-weeklyTable 周历结构。
    //
    // 请求（都是当前页同源，前缀从当前地址 /jsxsd/ 之前截取，直连为空，WebVPN 为 /https/<站点串> 或 /https-443/<站点串>）：
    //   GET  <前缀>/jsxsd/xskb/xskb_list.do    课表页：读学期下拉框 name=xnxq01id 与课程模式 name=kbjcmsid
    //   POST <前缀>/jsxsd/xskb/xskb_list.do    所选学期的整学期课表（表单体与上游抓包一致）
    //   POST <前缀>/jsxsd/jxzl/jxzl_query      可选：教学周历，照 csuft 写法（上游没有这一请求）；失败回落 GET ?xnxq01id=；都取不到就没有周历
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   1. 上游用隐藏表单 + iframe 提交 POST（为躲 WebVPN 对 fetch 的改写）；本件改成 fetch 直接 POST，拿不到就提示；
    //   2. 不弹窗选学期：取页面标出的当前学期，没有标出就取列表第一项，并把 picked 交给 parse.js 写进提醒；
    //   3. 去掉上游的弹窗、吐司、保存课程与节次时间，脚本对页面只读；
    //   4. 只交原始结构：表头与行首格的文字、每个课表格子里 font 的课名 / 教师 / 周次 / 教室原文；
    //      课名判断、节次、周次与合并全在 parse.js；
    //   5. 登录页、WebVPN 门户页、学校主页不发请求，给大白话提示；页面地址不带查询串。
    //
    // 只请求当前页同源地址；不读账号、学号、姓名，不写页面，不外发任何数据。详见 AUDIT.md。
    var DIRECT_HOST = 'jwgl.btbu.edu.cn';
    var VPN_HOST = 'vpn.btbu.edu.cn';
    var LIST_PATH = '/jsxsd/xskb/xskb_list.do';
    var CAL_PATH = '/jsxsd/jxzl/jxzl_query';
    var DEFAULT_MODE = 'BA619E6D28314968AD899E77F638AE08'; // 上游抓包得到的默认课程模式，上游同款兜底
    var LOGIN_HINT = '请先登录教务系统，再打开「课表查询」页面，然后点提取';
    var WEBVPN_BASE = /^\/https?(-\d+)?\/[0-9A-Za-z]+$/;
    var KEEP_TITLE = /课程|教师|老师|周次|教室/; // 字段白名单：教学楼、班级、备注、二维码等 font 不交出去
    // 标题含这些字的即使命中白名单也不交（「课程二维码」里「课程」会误命中）；复审 B1
    var DROP_TITLE = /二维码|学号|姓名|班级|备注|身份证|手机/;

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

    function hostOf(url) {
        var m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || ''));
        return m ? m[1].split(':')[0].toLowerCase() : '';
    }

    function titleOf(doc) {
        var titles = doc.getElementsByTagName('title');
        return titles.length ? clean(titles[0].textContent) : '';
    }

    // 教务前缀：直连为空；WebVPN 为 /https/<站点串>。不在教务页内返回 null
    function baseOf(loc) {
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '');
        var idx = path.indexOf('/jsxsd/');
        if (idx < 0) return null;
        var base = path.slice(0, idx);
        if (host === DIRECT_HOST && base === '') return base;
        if (host === VPN_HOST && WEBVPN_BASE.test(base)) return base;
        return null;
    }

    // 门户页、登录页、学校主页：不发请求。只看地址，不读输入框。
    function loginHint(loc) {
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '');
        var idx = path.indexOf('/jsxsd/');
        if (host !== DIRECT_HOST && host !== VPN_HOST) {
            return '当前打开的不是北京工商大学教务系统。' + LOGIN_HINT;
        }
        if (idx < 0) {
            if (host === VPN_HOST) {
                return '当前打开的是学校 WebVPN 门户或登录页。请先在门户里进入教务系统，打开「课表查询」页面，再点提取';
            }
            return '当前打开的不是教务系统页面。' + LOGIN_HINT;
        }
        if (baseOf(loc) === null) return '当前地址不是教务系统的标准地址。' + LOGIN_HINT;
        var rest = path.slice(idx);
        if (/^\/jsxsd\/?$/i.test(rest) || /^\/jsxsd\/(index|login|xk\/log)/i.test(rest)) {
            return '当前打开的是登录页。' + LOGIN_HINT;
        }
        return '';
    }

    function pageUrlOf(loc) {
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    // 卡片里的文字，去掉嵌在里面的课程编号提示（kchConfig），只留课名或属性原文
    function textWithoutHints(node) {
        var copy = node.cloneNode(true);
        var hints = allByClass(copy, 'kchConfig');
        for (var i = 0; i < hints.length; i++) {
            if (hints[i].parentNode) hints[i].parentNode.removeChild(hints[i]);
        }
        return clean(copy.textContent);
    }

    // 一个格子里的 font 片段。嵌在别的 font 里的（编号提示）跟外层走，不单独取。
    function piecesOf(div) {
        var fonts = div.getElementsByTagName('font');
        var out = [];
        for (var i = 0; i < fonts.length; i++) {
            var f = fonts[i];
            if (tagOf(f.parentNode) === 'FONT') continue;
            var title = attrOf(f, 'title');
            if (!title) {
                out.push({ t: '', x: textWithoutHints(f) });
            } else if (KEEP_TITLE.test(title) && !DROP_TITLE.test(title)) {
                out.push({ t: title, x: clean(f.textContent) });
            }
        }
        return out;
    }

    function isHidden(node) {
        return /display\s*:\s*none/i.test(attrOf(node, 'style'));
    }

    // 一个单元格里的课表格子（.kbcontent / .kbcontent1）；隐藏副本由 parse.js 跳过
    function divsOf(td) {
        var all = td.getElementsByTagName('*');
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (!hasClass(all[i], 'kbcontent') && !hasClass(all[i], 'kbcontent1')) continue;
            out.push({ hidden: isHidden(all[i]), pieces: piecesOf(all[i]) });
        }
        return out;
    }

    // 课表表格：#timetable（上游就是这个 id）
    function timetableRows(doc) {
        var table = doc.getElementById('timetable');
        if (!table) return null;
        var trs = table.getElementsByTagName('tr');
        var rows = [];
        for (var t = 0; t < trs.length; t++) {
            var kids = childElements(trs[t]);
            var tds = [];
            for (var k = 0; k < kids.length; k++) {
                var tag = tagOf(kids[k]);
                if (tag !== 'TD' && tag !== 'TH') continue;
                var divs = divsOf(kids[k]);
                tds.push({
                    span: parseInt(attrOf(kids[k], 'colspan'), 10) || 1,
                    text: divs.length ? '' : clean(kids[k].textContent),
                    divs: divs
                });
            }
            if (tds.length) rows.push({ tds: tds });
        }
        return rows;
    }

    function selectNamed(doc, name) {
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length; i++) {
            if (attrOf(selects[i], 'name') === name) return selects[i];
        }
        return null;
    }

    // 学期列表：页面标出的当前学期（selected），没有标出就取第一项，并记下 picked
    function termsOf(doc) {
        var sel = selectNamed(doc, 'xnxq01id');
        var opts = sel ? sel.getElementsByTagName('option') : [];
        var list = [];
        var chosen = null;
        for (var i = 0; i < opts.length; i++) {
            var code = clean(attrOf(opts[i], 'value'));
            if (!code) continue;
            var item = { code: code, name: clean(opts[i].textContent) || code };
            list.push(item);
            if (chosen === null && opts[i].getAttribute('selected') !== null) chosen = item;
        }
        if (!list.length) return { list: list, term: null, picked: 'first' };
        return { list: list, term: chosen || list[0], picked: chosen ? 'selected' : 'first' };
    }

    // 课程模式：页面选中项，没有就取第一个有值的项，都没有用上游抓包常量
    function modeOf(doc) {
        var sel = selectNamed(doc, 'kbjcmsid');
        if (!sel) return DEFAULT_MODE;
        var opts = sel.getElementsByTagName('option');
        var first = '';
        for (var i = 0; i < opts.length; i++) {
            var v = clean(attrOf(opts[i], 'value'));
            if (!v) continue;
            if (opts[i].getAttribute('selected') !== null) return v;
            if (!first) first = v;
        }
        return first || DEFAULT_MODE;
    }

    // 教学周历（可选，照 csuft）：第 N 周那一行的标签，以及从左到右的日期格文字（星期一在第 1 格）
    function calendarOf(doc) {
        var trs = doc.getElementsByTagName('tr');
        var weeks = [];
        for (var i = 0; i < trs.length; i++) {
            var labelNode = firstByClass(trs[i], 'qz-weeklyTable-label');
            if (!labelNode) continue;
            var inner = firstByClass(labelNode, 'td-cell');
            var days = [];
            var tds = trs[i].getElementsByTagName('td');
            for (var k = 0; k < tds.length; k++) {
                if (tds[k].parentNode !== trs[i]) continue;
                if (hasClass(tds[k], 'qz-weeklyTable-normalDay')) days.push(clean(tds[k].textContent));
            }
            weeks.push({ label: clean((inner || labelNode).textContent), days: days });
        }
        return { weeks: weeks };
    }

    // 单次取周历：失败或页面里没有周历都返回 null，不影响课表导入
    function calendarFrom(url, init) {
        return fetchDoc(url, init).then(function (doc) {
            var cal = calendarOf(doc);
            return cal.weeks.length ? cal : null;
        }, function () {
            return null;
        });
    }

    // 先 POST 带学期号，失败回落 GET；都取不到就给空周历，parse.js 按学期号推算开学日
    function fetchCalendar(calUrl, code) {
        var body = 'xnxq01id=' + encodeURIComponent(code);
        return calendarFrom(calUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body
        }).then(function (cal) {
            return cal || calendarFrom(calUrl + '?' + body, { method: 'GET' });
        }).then(function (cal) {
            return cal || { weeks: [] };
        });
    }

    function checkStatus(response) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('教务系统拒绝访问（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '）。' + LOGIN_HINT);
        }
        var host = hostOf(response.url);
        if (host && host !== String(window.location.hostname).toLowerCase()) {
            throw new Error('登录已失效。' + LOGIN_HINT);
        }
    }

    function fetchDoc(url, init) {
        var opts = init || {};
        opts.credentials = 'same-origin';
        return fetch(url, opts).then(function (response) {
            checkStatus(response);
            return response.text();
        }, function () {
            throw new Error('连不上教务系统。' + LOGIN_HINT);
        }).then(function (html) {
            return new DOMParser().parseFromString(html, 'text/html');
        });
    }

    function countItems(rows) {
        var n = 0;
        for (var r = 0; r < rows.length; r++) {
            for (var c = 0; c < rows[r].tds.length; c++) {
                var divs = rows[r].tds[c].divs;
                for (var d = 0; d < divs.length; d++) {
                    if (!divs[d].hidden && divs[d].pieces.length) n++;
                }
            }
        }
        return n;
    }

    function run() {
        var loc = window.location;
        var hint = loginHint(loc);
        if (hint) return Promise.reject(new Error(hint));
        var listUrl = String(loc.protocol) + '//' + String(loc.host) + baseOf(loc) + LIST_PATH;
        return fetchDoc(listUrl, { method: 'GET' }).then(function (listDoc) {
            var terms = termsOf(listDoc);
            if (!terms.term) {
                if (titleOf(listDoc).indexOf('登录') >= 0) throw new Error('登录已失效。' + LOGIN_HINT);
                throw new Error('没有找到学期列表。请确认已登录教务系统，再打开「课表查询」页面后点提取');
            }
            var term = terms.term;
            var body = 'cj0701id=&zc=&demo=&xnxq01id=' + encodeURIComponent(term.code) +
                '&sfFD=1&wkbkc=1&kbjcmsid=' + encodeURIComponent(modeOf(listDoc));
            return fetchDoc(listUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            }).then(function (page) {
                var rows = timetableRows(page);
                if (!rows) {
                    if (titleOf(page).indexOf('登录') >= 0) throw new Error('登录已失效。' + LOGIN_HINT);
                    throw new Error('没有找到课表。请确认已登录教务系统，再打开「课表查询」页面后点提取');
                }
                if (!countItems(rows)) throw new Error('没有找到课程。请确认该学期已发布课表，再点提取');
                var calUrl = listUrl.slice(0, listUrl.length - LIST_PATH.length) + CAL_PATH;
                return fetchCalendar(calUrl, term.code).then(function (calendar) {
                    return JSON.stringify({
                        source: 'btbu-jsxsd',
                        pageUrl: pageUrlOf(loc),
                        now: todayIso(),
                        term: { code: term.code, name: term.name, picked: terms.picked },
                        calendar: calendar,
                        rows: rows
                    });
                });
            });
        });
    }

    return run();
})()
