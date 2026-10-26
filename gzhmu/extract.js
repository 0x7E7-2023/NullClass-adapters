(function () {
    // 广州医科大学教务适配器 —— 强智科技「高校综合管理教务系统」学生端（/jsxsd/），经学校 WebVPN 的路径前缀访问，校内网络可直连教务主机。
    // 移植自 shiguang_warehouse 的 GZHMU/gzhmu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 小漫君；上游请求与课表字段解析参考 GDCP/gdcp_01.js，
    //   周历参考 ZHKU/zhku_lc6464.js（lc6464），GDCP 所记载的 HNIU、HHTC、NJFU、QFNU（Yumu-banxia）贡献一并保留，原仓库 Copyright (c) 2025 星河欲转）
    // 上游 resources/GZHMU/adapters.yaml：GZHMU_01「广州医科大学强智教务」，maintainer「小漫君」，import_url = https://webvpn.gzhmu.edu.cn/
    // 上游快照 e15c627（2026-10-26 拉取），本校脚本最后一次修改 8fbac2c。模板：hnptc（同平台、同一组请求）；入口判断照 hunau。
    //
    // 平台判据按脚本实际请求的接口路径，不按注释：
    //   GET  <前缀>/jsxsd/xskb/xskb_list.do     课表页（读「学年学期」下拉框 #xnxq01id 与节次模式下拉框 #kbjcmsid；页面上已有就不发）
    //   POST <前缀>/jsxsd/xskb/xskb_list.do     整学期课表（服务端渲染的网页，不是 JSON；容器 #timetable，课程在 div.kbcontent 里）
    //   POST <前缀>/jsxsd/jxzl/jxzl_query       教学周历（第 1 周的日期与周号）
    //
    // 取数方式：
    //   ① 当前页面是本人学期课表页（/jsxsd/xskb/ 下）、已有课表格子、且没有选定某一周 → 直接用屏幕上的那张；
    //   ② 否则（在教务任意其它页面上）GET 课表页读学期与节次模式（页面上已有就不发），再 POST 整学期课表，
    //      请求体与上游一字不差（cj0701id=&zc=&demo=&xnxq01id=<学期>&sfFD=1&kbjcmsid=<节次模式>）；
    //   ③ 两条路都再 POST 一次教学周历取开学日期与总周数，取不到不是致命错误，由 parse.js 推算并出提醒。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从列表里选学期（上游 showSingleSelection，默认项就是页面选中项）：学期取页面下拉框的选中项；
    //   ② 只交原始结构（学期 + 每格的网格列号 col / 跨列数 span / 清理后的课程明细 HTML + 行表头标签 + 周历的网格），
    //      周次 / 节次 / 课程名 / 节次时间核对 / 合并的解释全在 parse.js —— 那边 CI 里能真跑；
    //   ③ 只认主机 jwgl.gzhmu.edu.cn 与 webvpn.gzhmu.edu.cn；上游还认 *.webvpn.gzhmu.edu.cn 子域，但具体子域名不明、授权主机不能写通配，
    //      这一形式不支持：在那种页面上点提取直接给大白话提示，不发请求；WebVPN 的 /https/<代理标识>/ 前缀原样保留，请求落在当前页面同源。
    //   ④ 去掉上游的 showAlert / showToast / saveCourseConfig / savePresetTimeSlots / saveImportedCourses / notifyTaskCompletion 等拾光界面调用；
    //   ⑤ 登录页、WebVPN 首页、不在教务系统里的页面上点提取：直接给大白话提示，不发请求；班级 / 教室 / 教师课表等其它页面上的课表不当本人课表读；
    //   ⑥ 选定了某一周的课表页不当整学期用（只显示那一周的课），改走 ②；
    //   ⑦ 课程明细按白名单重新拼，不转交 innerHTML：只留课名（不带标题的 font，没有时才取最外层文字）、换行和标题认得的 font 里看得见的文字，
    //      看不见的元素与不认识的标签一律不读；没有课程明细的格子只交 parse.js 认得的标签（星期表头、行表头的节次与时钟、周号 / 日号），
    //      周历格子只交 title 里的日期，其它自由文字（备注、标题、藏在格子里的姓名学号之类）一律不带出；
    //   ⑧ 上游缺节次模式、缺教师 / 教室时整次报错；这里节次模式取不到才报错（照上游），缺教师 / 教室交给 parse.js 汇总提醒；
    //   ⑨ 上游没有 GET 退路，这里也不加；请求体里没有 hnptc 的 jx0404id（上游没有）。
    //
    // 只请求当前页面同源的教务服务器：不读账号密码（只看登录页上有没有密码框）、不写页面、不外发任何数据。详见 AUDIT.md。
    var WEBVPN_HOST = 'webvpn.gzhmu.edu.cn';
    var DIRECT_HOST = 'jwgl.gzhmu.edu.cn';
    var CONTEXT = '/jsxsd/';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var TEXT_LIMIT = 40;       // 学期名最多交出的字数
    var LOGIN_HINT = '请先登录学校的 WebVPN，进入教务系统并打开「学期理论课表」页面，确认页面上能看到课表再点「提取课表」';
    var NOT_JW = '当前页面不是广州医科大学教务系统的页面。校外请先登录学校的 WebVPN（' + WEBVPN_HOST + '），进入教务系统，打开「学期理论课表」页面，确认能看到课表再点「提取课表」';
    var OUTSIDE = '当前还没有进入教务系统（这里是 WebVPN 首页或其它页面）。' + LOGIN_HINT;
    var SUBDOMAIN = '暂不支持从这个 WebVPN 子域名页面导入。请回到学校 WebVPN 首页（' + WEBVPN_HOST + '）进入教务系统，打开「学期理论课表」页面，确认能看到课表再点「提取课表」';
    var ON_LOGIN = '当前是教务系统的登录页。' + LOGIN_HINT;
    var CN_DATE = /\d{4}\s*[-年]\s*\d{1,2}\s*[-月]\s*\d{1,2}/;
    // 行表头里的节次与时钟：「第一大节(01,02小节)08:30-09:55」里的「(01,02小节)08:30-09:55」
    var CLOCK_LABEL = /\(\s*\d{1,2}(?:\s*[,，、]\s*\d{1,2})*\s*小节\s*\)\s*\d{1,2}:\d{2}\s*[-~～—–－]\s*\d{1,2}:\d{2}/;

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function limited(value, max) {
        var text = clean(value);
        return text.length > max ? text.substring(0, max) : text;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。教务给不出开学日时由 parse.js 用它推算第 1 周。
    // 不能用 toISOString：北京时间早上 8 点前它会退到前一天。
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
        var classes = ' ' + String((node && node.className) || '').replace(/\s+/g, ' ') + ' ';
        return classes.indexOf(' ' + name + ' ') >= 0;
    }

    // 判断当前页面在哪：只认 jwgl.gzhmu.edu.cn 与 webvpn.gzhmu.edu.cn；路径里 /jsxsd/ 之前的那一段（WebVPN 的 /https/<代理标识>）原样当前缀。
    //   other：不是本校教务主机；subdomain：*.webvpn.gzhmu.edu.cn 子域（不支持）；outside：还没进教务（WebVPN 首页等）；
    //   login：教务登录页 / 入口页；jw：在教务里，onKbPage 表示在 /jsxsd/xskb/ 下（本人学期课表页）。
    function locate() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        var tail = '.' + WEBVPN_HOST;
        if (host.length > tail.length && host.substring(host.length - tail.length) === tail) return { kind: 'subdomain' };
        if (host !== WEBVPN_HOST && host !== DIRECT_HOST) return { kind: 'other' };
        var path = String(loc.pathname || '');
        var lower = path.toLowerCase();
        if (lower.substring(lower.length - 6) === '/jsxsd') {
            path += '/';
            lower += '/';
        }
        var at = lower.indexOf(CONTEXT);
        if (at < 0) return { kind: 'outside' };
        var rest = lower.substring(at + CONTEXT.length);
        if (rest === '' || rest.indexOf('login') >= 0 || rest.indexOf('sso') === 0) return { kind: 'login' };
        var origin = loc.origin ? loc.origin : (loc.protocol + '//' + loc.host);
        return { kind: 'jw', base: origin + path.substring(0, at), onKbPage: rest.indexOf('xskb/') === 0 };
    }

    // 一格里的课程明细：强智把课程名 + 教师 / 周次(节次) / 教室写在类名含 kbcontent 的 div 里（上游只读 .kbcontent，不读简表 kbcontent1）。
    // 这里不转交 innerHTML，而是按白名单重新拼一份最小的明细：
    //   · 课名：不带标题的 font 里看得见的文字照留（上游 font:not([title]) 取课名；parse.js 取每门课里第一个），最外层文字也留（没有这种 font 时取课名，
    //     一格里几门课之间的减号分隔线也是最外层文字）；换行标签留；
    //   · font 只留标题里含「周次 / 节次 / 教师 / 老师 / 教室 / 地点 / 课程」的，只取它里面看得见的文字，标题原样写回；
    //   · 其它元素（悬浮详情 .item-box、span、a、img、输入框、脚本……任何不认识的标签）连里面的文字一律不读；
    //   · 看不见的元素（hidden 属性、aria-hidden、行内样式 display:none / visibility:hidden）一律不读（根节点自己不查）。
    var FONT_KEYS = ['周次', '节次', '教师', '老师', '教室', '地点', '课程'];
    var NODE_LIMIT = 100;      // 明细里每段文字最多交出的字数

    function isHidden(node) {
        if (node.nodeType !== 1) return false;
        if (node.hasAttribute && (node.hasAttribute('hidden') || attrOf(node, 'aria-hidden').toLowerCase() === 'true')) return true;
        return /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrOf(node, 'style'));
    }

    function keptTitle(node) {
        var title = clean(attrOf(node, 'title'));
        for (var i = 0; i < FONT_KEYS.length; i++) {
            if (title.indexOf(FONT_KEYS[i]) >= 0) return title.length > 20 ? title.substring(0, 20) : title;
        }
        return null;
    }

    // 一个元素里看得见的文字（跳过看不见的元素和脚本样式）
    function visibleText(node) {
        var out = '';
        var kids = node.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            var kid = kids[i];
            if (kid.nodeType === 3) {
                out += kid.nodeValue;
            } else if (kid.nodeType === 1) {
                var tag = tagOf(kid);
                if (tag === 'BR') out += ' ';
                else if (tag !== 'SCRIPT' && tag !== 'STYLE' && !isHidden(kid)) out += visibleText(kid);
            }
        }
        return out;
    }

    function escapeText(value) {
        return limited(value, NODE_LIMIT).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function safeHtmlOf(root) {
        var html = '';
        var kids = root.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            var kid = kids[i];
            if (kid.nodeType === 3) {
                var text = limited(kid.nodeValue, NODE_LIMIT);
                if (text) html += escapeText(text);
            } else if (kid.nodeType === 1) {
                var tag = tagOf(kid);
                if (isHidden(kid)) continue;
                if (tag === 'BR') {
                    html += '<br/>';
                } else if (tag === 'FONT') {
                    var title = keptTitle(kid);
                    var inner = visibleText(kid);
                    if (title !== null) html += '<font title="' + title.replace(/"/g, '') + '">' + escapeText(inner) + '</font>';
                    else if (!clean(attrOf(kid, 'title'))) html += '<font>' + escapeText(inner) + '</font>';
                }
            }
        }
        return html;
    }

    function partsOf(cell) {
        var divs = cell.getElementsByTagName('div');
        var out = [];
        for (var i = 0; i < divs.length; i++) {
            if (!hasClass(divs[i], 'kbcontent')) continue;
            var html = safeHtmlOf(divs[i]).trim();
            if (html && clean(html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '))) out.push(html);
        }
        return out;
    }

    // 格子的文字只在没有课程明细时才交，而且只交 parse.js 认得的标签：星期表头、节次标签（"第1-2节"）、周号 / 日号（周历）。
    // 周历格子里写成文字的日期（没有 title 时上游读文字）也算标签。其它自由文字（备注、标题、藏在格子里的姓名学号之类）一律不带出；有明细的格子文字与明细重复，不交。
    function labelOf(text) {
        var one = clean(String(text === null || text === undefined ? '' : text).replace(/（/g, '(').replace(/）/g, ')'));
        var out = [];
        var found = CLOCK_LABEL.exec(one);
        if (found) out.push(clean(found[0]));
        found = /(星期|周|礼拜)\s*[一二三四五六日天1-7]/.exec(one);
        if (found) out.push(found[0]);
        if (!out.length) {
            found = /\d+\s*[~～\-—]\s*\d+\s*小?节/.exec(one);
            if (found) out.push(found[0]);
        }
        found = CN_DATE.exec(one);
        if (found) out.push(clean(found[0]));
        if (out.length) return out.join(' ');
        if (/^第?\s*\d{1,3}\s*[周节]?$/.test(one) || /^[一二三四五六日天]$/.test(one)) return one;
        return '';
    }

    // th：这个格子是不是表头单元格（节次标签 "第1-2节" 在每行的 th 里，parse.js 靠它给没写节次的课补节次）
    function cellOf(node, col, span, withNode) {
        var parts = partsOf(node);
        var text = node.textContent !== undefined ? node.textContent : node.innerText;
        var cell = { col: col, span: span, text: parts.length ? '' : labelOf(text), parts: parts };
        if (tagOf(node) === 'TH') cell.th = true;
        // withNode 只给周历用：它要读 td[title] 上的日期
        if (withNode) cell.node = node;
        return cell;
    }

    function spanOfAttr(node, name) {
        var value = parseInt(attrOf(node, name), 10);
        return value >= 1 ? value : 1;
    }

    // carry[c] = 第 c 列还被前面某一行的 rowspan 占着几行（不含当前行）。
    // 每进一行先把占用的列标出来并把计数减 1；rowspan 格子只在它自己那一行留下 td，它占住的列在下一行必须空出来，
    // 否则下一行的格子会整体左移一格。
    function cellsOfRow(row, carry, withNode) {
        var out = [];
        var kids = row.children || [];
        var occupied = {};
        for (var k = 0; k < carry.length; k++) {
            if (carry[k] > 0) {
                occupied[k] = true;
                carry[k] = carry[k] - 1;
            }
        }
        var col = 0;
        for (var i = 0; i < kids.length; i++) {
            var tag = tagOf(kids[i]);
            if (tag !== 'TD' && tag !== 'TH') continue;
            while (occupied[col]) col++;
            var span = spanOfAttr(kids[i], 'colspan');
            var rowspan = spanOfAttr(kids[i], 'rowspan');
            out.push(cellOf(kids[i], col, span, withNode));
            if (rowspan > 1) {
                for (var s = 0; s < span; s++) carry[col + s] = rowspan - 1;
            }
            col += span;
        }
        return out;
    }

    function closestTable(el) {
        var node = el;
        while (node && node.nodeType === 1) {
            if (tagOf(node) === 'TABLE') return node;
            node = node.parentNode;
        }
        return null;
    }

    // 课表容器：#timetable（上游同样只认它；#kbtable 是教学周历，不当课表）；没有就找最近一张含 .kbcontent 格子的表。
    function findScheduleTable(doc) {
        var byId = doc.getElementById('timetable');
        if (byId) return byId;
        var cell = doc.querySelector ? doc.querySelector('.kbcontent') : null;
        return cell ? closestTable(cell) : null;
    }

    // 课表：整张表还原成网格，每个格子带上网格列号 col 与跨列数 span，表宽一起交出去。
    // 不能让 parse.js 拿「第几个 td」当星期几：首列是节次列、还有 rowspan/colspan。
    // 只交「有文字或有课程明细」的行（节次标签行照交，parse.js 靠它认节次）。
    function scheduleGrid(table) {
        var out = [];
        var width = 0;
        var trs = table.rows || table.getElementsByTagName('tr');
        var carry = [];
        for (var r = 0; r < trs.length; r++) {
            // carry 要跨行走：哪怕这一行最后不交出去，也要过一遍，否则后面的列号会错
            var cells = cellsOfRow(trs[r], carry, false);
            for (var w = 0; w < cells.length; w++) {
                if (cells[w].col + cells[w].span > width) width = cells[w].col + cells[w].span;
            }
            var keep = false;
            for (var c = 0; c < cells.length; c++) {
                if (cells[c].text || cells[c].parts.length) {
                    keep = true;
                    break;
                }
            }
            if (keep) out.push(cells);
        }
        return { cols: width, rows: out };
    }

    // 教学周历的容器：#kbtable；认不出就找第一张有日期 title 的表（周历的日期挂在 td[title] 上）；再不行取文档里第一张表（上游的做法）
    function findCalendarTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cells = doc.getElementsByTagName('td');
        for (var i = 0; i < cells.length; i++) {
            if (CN_DATE.test(attrOf(cells[i], 'title'))) return closestTable(cells[i]);
        }
        var tables = doc.getElementsByTagName('table');
        return tables.length ? tables[0] : null;
    }

    // 周历：只交「有文字或有 title」的格子（空白的日子格没有信息），但保留网格列号 ——
    // parse.js 要靠列号认「星期几在哪一列」，再读第 1 周那一行。
    function calendarGrid(table) {
        var out = [];
        var trs = table.rows || table.getElementsByTagName('tr');
        var carry = [];
        for (var r = 0; r < trs.length; r++) {
            var cells = cellsOfRow(trs[r], carry, true);
            var keep = [];
            for (var c = 0; c < cells.length; c++) {
                var item = { col: cells[c].col };
                if (cells[c].text) item.text = cells[c].text;
                // 周历格子的 title 只留日期那一段（2026-09-07 / 2026年09月07日），别的备注不带出
                var dated = CN_DATE.exec(attrOf(cells[c].node, 'title'));
                if (dated) item.title = clean(dated[0]);
                if (item.text || item.title) keep.push(item);
            }
            if (keep.length) out.push(keep);
        }
        return out;
    }

    // 有课内容的格子数：判断这一页算不算「拿到了课表」
    function courseCells(rows) {
        var count = 0;
        for (var r = 0; r < rows.length; r++) {
            for (var c = 0; c < rows[r].length; c++) {
                if (rows[r][c].parts.length) count++;
            }
        }
        return count;
    }

    // 学期代码的形状（2026-2027-1）；放宽到只要是安全字符，换了命名规则也不至于整个取不到
    function isTermCode(value) {
        return /^[0-9A-Za-z][0-9A-Za-z_-]{3,23}$/.test(value);
    }

    // 学年学期：课表页顶部的下拉框（强智是 select[id|name 含 xnxq]，值形如 2026-2027-1）。
    // 只读选中项：用户在页面上切到哪一学期，导入的就是哪一学期。取不到选中项时取第一个合规选项。
    function readTerm(doc) {
        var code = null;
        var name = null;
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length && !code; i++) {
            var identity = String(selects[i].id || '') + ' ' + String(selects[i].name || '');
            if (identity.indexOf('xnxq') < 0) continue;
            var options = selects[i].options || [];
            var firstCode = null;
            var firstName = null;
            for (var j = 0; j < options.length; j++) {
                var value = clean(options[j].value);
                if (!isTermCode(value)) continue;
                if (firstCode === null) {
                    firstCode = value;
                    firstName = limited(options[j].text, TEXT_LIMIT);
                }
                if (options[j].selected) {
                    code = value;
                    name = limited(options[j].text, TEXT_LIMIT);
                }
            }
            if (!code && firstCode) {
                code = firstCode;
                name = firstName;
            }
        }
        return { code: code, name: name };
    }

    // 某个下拉框当前选中项的值（按 id 或 name 找）；没有这个下拉框返回 null
    function selectValue(doc, key) {
        var select = doc.getElementById(key);
        if (!select && doc.getElementsByName) {
            var named = doc.getElementsByName(key);
            for (var n = 0; n < named.length && !select; n++) {
                if (tagOf(named[n]) === 'SELECT') select = named[n];
            }
        }
        if (!select || tagOf(select) !== 'SELECT') return null;
        var options = select.options || [];
        for (var i = 0; i < options.length; i++) {
            if (options[i].selected) return clean(options[i].value);
        }
        return options.length ? clean(options[0].value) : '';
    }

    // 节次模式（#kbjcmsid）：上游把它原样带进请求体；页面上没有这个下拉框时上游带空值，这里同样
    function readMode(doc) {
        var value = selectValue(doc, 'kbjcmsid');
        return value ? value : null;
    }

    // 页面上是不是选定了某一周（#zc 选了具体周次）：那样课表只显示那一周的课，不能当整学期用
    function weekFiltered(doc) {
        var value = selectValue(doc, 'zc');
        return value !== null && /^[0-9]+$/.test(value) && parseInt(value, 10) > 0;
    }

    function harvestPage(doc) {
        var table = findScheduleTable(doc);
        var grid = table ? scheduleGrid(table) : { cols: 0, rows: [] };
        return {
            term: readTerm(doc),
            mode: readMode(doc),
            filtered: weekFiltered(doc),
            cols: grid.cols,
            rows: grid.rows
        };
    }

    function htmlDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    // 只看页面上有没有密码输入框，不读它的值
    function hasPasswordInput(doc) {
        var inputs = doc.getElementsByTagName('input');
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === 'password') return true;
        }
        return false;
    }

    function requestText(method, url, body) {
        var init = { method: method, credentials: 'same-origin' };
        if (body !== null) {
            init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            init.body = body;
        }
        return fetch(url, init).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('教务系统拒绝访问（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        });
    }

    // 课表页的请求体：与上游一字不差（上游 URLSearchParams 的顺序与空参数都留着；显式请求整学期，避免复用入口页的周筛选结果）
    function scheduleBody(code, mode) {
        return 'cj0701id=&zc=&demo=&xnxq01id=' + encodeURIComponent(code) + '&sfFD=1&kbjcmsid=' + encodeURIComponent(mode);
    }

    // 教学周历的请求体：与上游一致，只有 xnxq01id
    function calendarBody(code) {
        return 'xnxq01id=' + encodeURIComponent(code);
    }

    // 周历取不到（教务改了页面、这一学期没有周历、返回的明明是别的学期）不算致命：开学日期由 parse.js 推算并说明。
    // 这里返回空网格而不是抛错。没有学期代码时不发请求。返回页上有学期下拉框、而且选的不是所选学期，才算对不上。
    function fetchCalendar(base, code) {
        if (!code) return Promise.resolve({ found: false, rows: [] });
        return requestText('POST', base + CALENDAR_PATH, calendarBody(code)).then(function (html) {
            var doc = htmlDoc(html);
            var shown = readTerm(doc).code;
            if (shown && shown !== code) return { found: false, rows: [] };
            var table = findCalendarTable(doc);
            var rows = table ? calendarGrid(table) : [];
            return { found: rows.length > 0, rows: rows };
        }, function () {
            return { found: false, rows: [] };
        });
    }

    // 课表页上读学期与节次模式（GET 课表页）。回的是登录页就当场说清楚
    function fetchPageInfo(base) {
        return requestText('GET', base + SCHEDULE_PATH, null).then(function (html) {
            var doc = htmlDoc(html);
            var term = readTerm(doc);
            if (!term.code && hasPasswordInput(doc)) {
                throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
            }
            return { term: term, mode: readMode(doc) };
        });
    }

    // 整学期课表：POST（上游的做法）。返回页的学期与所选不符、或回的是登录页，当场说清楚；没有课程格子就说课表是空的
    function fetchSchedule(base, code, mode) {
        return requestText('POST', base + SCHEDULE_PATH, scheduleBody(code, mode)).then(function (html) {
            var doc = htmlDoc(html);
            var got = harvestPage(doc);
            if (got.term.code && got.term.code !== code) {
                throw new Error('教务系统返回的课表不是所选学期（' + code + '）的，请在课表页选好学期后重试');
            }
            if (courseCells(got.rows) === 0) {
                if (!got.rows.length && hasPasswordInput(doc)) {
                    throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
                }
                throw new Error('教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
            }
            return got;
        });
    }

    function payloadOf(flight, calendar) {
        return JSON.stringify({
            now: todayIso(),
            term: flight.term,
            screenTermMissing: flight.screenTermMissing === true,
            cols: flight.cols,
            calendar: calendar,
            rows: flight.rows
        });
    }

    var where = locate();
    if (where.kind === 'other') throw new Error(NOT_JW);
    if (where.kind === 'subdomain') throw new Error(SUBDOMAIN);
    if (where.kind === 'outside') throw new Error(OUTSIDE);
    if (where.kind === 'login') throw new Error(ON_LOGIN);
    var base = where.base;

    // 只在本人学期课表页（/jsxsd/xskb/）上读屏幕课表：班级 / 教室 / 教师课表等其它页面上的课表不是本人的
    var live = where.onKbPage ? harvestPage(document) : { term: { code: null, name: null }, mode: null, filtered: false, cols: 0, rows: [] };
    // 课表页上已有课程格子、且没有选定某一周：用屏幕上的那份（学期也取它的，它就是用户看到的那一学期）
    var onScreen = courseCells(live.rows) > 0 && !live.filtered;
    if (courseCells(live.rows) === 0 && hasPasswordInput(document)) throw new Error(ON_LOGIN);

    if (onScreen) {
        var termStep = live.term.code
            ? Promise.resolve(live.term)
            : fetchPageInfo(base).then(function (info) { return info.term; }, function () { return { code: null, name: null }; });
        return termStep.then(function (term) {
            return fetchCalendar(base, term.code).then(function (calendar) {
                return payloadOf({ term: term, cols: live.cols, rows: live.rows, screenTermMissing: !live.term.code }, calendar);
            });
        });
    }

    var infoStep = (live.term.code && live.mode)
        ? Promise.resolve({ term: live.term, mode: live.mode })
        : fetchPageInfo(base).then(function (info) {
            return { term: live.term.code ? live.term : info.term, mode: live.mode || info.mode };
        });
    return infoStep.then(function (info) {
        if (!info.term.code) {
            throw new Error('教务页面里没找到「学年学期」选项：' + LOGIN_HINT);
        }
        if (!info.mode) {
            throw new Error('教务页面里没找到课表的节次设置，请回到「学期理论课表」页面再点「提取课表」');
        }
        return fetchSchedule(base, info.term.code, info.mode).then(function (got) {
            return fetchCalendar(base, info.term.code).then(function (calendar) {
                return payloadOf({ term: info.term, cols: got.cols, rows: got.rows }, calendar);
            });
        });
    });
})()
