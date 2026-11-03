(function () {
    // 中南林业科技大学教务适配器 —— 强智新版周课表，经学校 WebVPN 访问。
    // 移植自 shiguang_warehouse 的 CSUFT/csuft.js（MIT，上游作者 jinnianliuxing）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照 29498b0；本校脚本最后一次修改 92a4198（1.0.1 跟进域名迁移；1.0.0 基于 4678e75）。
    // 模板是已审计的 gdkm；课表网格、周历和载荷沿用同平台实现，请求参数与 WebVPN 入口按 CSUFT 上游重写。
    //
    // 请求（教务域名按顺序探测，见 jwFetch）：
    //   GET  /jsxsd/xskb/xskb_list.do                         读取当前学期与时间模式
    //   GET  /jsxsd/xskb/xskb_list.do?<完整课表参数>           整学期课表
    //   POST /jsxsd/jxzl/jxzl_query                           教学周历；失败时退回带学期参数的 GET
    // 域名：当前页已在教务域名上则先用当前域名；否则先新域名 https-443，再旧域名 http-80（旧域名 302 到新域名）。
    // 只有响应正常且内容像课表 / 周历才算可用；单域名 15 秒超时；整次导入最多 10 次请求。
    //
    // 移植改动：不弹窗选学期；去掉提示与保存桥；只交学期、周历、课程卡片原文；
    // 周次、节次和开学日全在 parse.js；教务登录页与 WebVPN 门户页不发请求；页面地址不带查询串。
    // 1.0.1 改动（跟进上游 92a4198）：多域名探测、记住可用域名、单域名超时、内容校验，
    // 两个域名都不可用时提示「请先在学校 WebVPN 里打开教务系统」。未跟上游的「月历推算开学日」与
    // 「学期列表改从周历页取」，理由见 AUDIT.md。
    // 不读账号、姓名、学号或隐藏令牌，不写页面。详见 AUDIT.md。
    var PORTAL_HOST = 'webvpn.csuft.edu.cn';
    var JW_HOSTS = [
        'https-jwxt-csuft-edu-cn-443.webvpn.csuft.edu.cn',
        'http-jwxt-csuft-edu-cn-80.webvpn.csuft.edu.cn'
    ];
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var LOGIN_HINT = '请先在学校 WebVPN 里打开教务系统，再打开「课表查询」，然后点提取';
    var TIMEOUT_MS = 15000;     // 单个域名最多等 15 秒，超时就换下一个域名
    var MAX_REQUESTS = 10;      // 整次导入请求上限，防止多域名反复试探卡住
    var requestCount = 0;
    var goodOrigin = '';        // 本次已确认可用的域名，后续请求优先用它

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

    // 教务登录页 / WebVPN 门户页 / 学校主页：不发请求。只看地址，不读输入框。
    // 门户页跨域取数不可靠（需要 CORS 与跨子域 cookie），只给提示，让学生先进入教务系统。
    function loginHint() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var path = String(loc.pathname || '').toLowerCase();
        if (host === PORTAL_HOST) {
            return '当前打开的是学校 WebVPN 门户。请先在门户里点进教务系统，打开「课表查询」页面，再点提取';
        }
        if (JW_HOSTS.indexOf(host) < 0) {
            return '当前打开的不是中南林业科技大学教务系统。' + LOGIN_HINT;
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

    function parseHtml(text) {
        return new DOMParser().parseFromString(text, 'text/html');
    }

    // 课表页与周历页的判定特征：登录页、门户页内容不算
    function isSchedulePage(text) {
        return /id=["']xnxq01id["']/.test(text) || /qz-weeklyTable/.test(text);
    }

    function isCalendarPage(text) {
        return /qz-weeklyTable-label/.test(text) || /第\s*1\s*周/.test(text);
    }

    // 本次导入的教务域名尝试顺序：当前页若在教务域名上就先用它，然后新域名、旧域名；已确认可用的排最前
    function originsInOrder() {
        var out = [];
        var here = window.location;
        if (JW_HOSTS.indexOf(String(here.hostname || '').toLowerCase()) >= 0) {
            out.push(String(here.protocol) + '//' + String(here.host));
        }
        for (var i = 0; i < JW_HOSTS.length; i++) {
            var url = 'https://' + JW_HOSTS[i];
            if (out.indexOf(url) < 0) out.push(url);
        }
        if (goodOrigin) {
            var rest = [];
            for (var k = 0; k < out.length; k++) {
                if (out[k] !== goodOrigin) rest.push(out[k]);
            }
            out = [goodOrigin].concat(rest);
        }
        return out;
    }

    // 单次请求：超时、非 2xx、被跳到非教务主机（登录页）都算失败
    function requestText(url, init) {
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
        var opts = { credentials: 'include' };
        for (var key in init) {
            if (init.hasOwnProperty(key)) opts[key] = init[key];
        }
        if (ctrl) opts.signal = ctrl.signal;
        function done() { if (timer) clearTimeout(timer); }
        return fetch(url, opts).then(function (resp) {
            if (resp.status < 200 || resp.status >= 300) throw new Error('HTTP ' + resp.status);
            var host = hostOf(resp.url);
            if (host && JW_HOSTS.indexOf(host) < 0) throw new Error('跳到了非教务主机');
            return resp.text();
        }).then(function (text) {
            done();
            return text;
        }, function (err) {
            done();
            throw err;
        });
    }

    // 依次试各教务域名，返回第一个通过 check 的页面文本；全部不可用返回 null
    function jwFetch(path, init, check) {
        var origins = originsInOrder();
        function tryFrom(i) {
            if (i >= origins.length) return Promise.resolve(null);
            if (requestCount >= MAX_REQUESTS) {
                return Promise.reject(new Error('教务系统请求次数过多，已停止本次导入，请稍后重试'));
            }
            requestCount++;
            return requestText(origins[i] + path, init).then(function (text) {
                if (check(text)) {
                    goodOrigin = origins[i];
                    return text;
                }
                return tryFrom(i + 1);
            }, function () {
                return tryFrom(i + 1);
            });
        }
        return tryFrom(0);
    }

    function loadPage(path, check) {
        return jwFetch(path, { method: 'GET' }, check).then(function (text) {
            if (text === null) throw new Error(LOGIN_HINT);
            return text;
        });
    }

    function scheduleQuery(code, mode) {
        var params = {
            viweType: '0',
            showallprint: '0',
            showkchprint: '0',
            showkink: '0',
            showfzmprint: '0',
            baseUrl: '/jsxsd',
            xsflMapListJsonStr: '讲课学时,实践学时,讲座学时,实验学时,上机学时,课内实践学时,课程实践学时,',
            zc: ''
        };
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

    // 周历是可选的：POST 取不到或没有周次时退回带学期参数的 GET；都失败就给空周历，由 parse.js 按 20 周提醒
    function fetchCalendar(code) {
        var body = 'xnxq01id=' + encodeURIComponent(code || '');
        var postInit = {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body
        };
        return jwFetch(CALENDAR_PATH, postInit, isCalendarPage).then(function (text) {
            var calendar = text ? calendarOf(parseHtml(text)) : { weeks: [] };
            if (calendar.weeks.length) return calendar;
            return jwFetch(CALENDAR_PATH + '?' + body, { method: 'GET' }, isCalendarPage).then(function (t) {
                return t ? calendarOf(parseHtml(t)) : { weeks: [] };
            });
        }).then(null, function () {
            return { weeks: [] };
        });
    }

    function run() {
        var hint = loginHint();
        if (hint) return Promise.reject(new Error(hint));
        return loadPage(SCHEDULE_PATH + '?' + scheduleQuery('', ''), isSchedulePage).then(function (html) {
            var initial = parseHtml(html);
            var term = termOf(initial);
            if (!term) throw new Error('当前页面找不到学年学期。' + LOGIN_HINT);
            var mode = modeOf(initial);
            return loadPage(SCHEDULE_PATH + '?' + scheduleQuery(term.code, mode), isSchedulePage).then(function (text) {
                var page = parseHtml(text);
                if (titleOf(page).indexOf('登录') >= 0 && !findTimetable(page)) {
                    throw new Error('登录已失效。' + LOGIN_HINT);
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
