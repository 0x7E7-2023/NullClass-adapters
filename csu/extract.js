(function () {
    // 中南大学教务适配器 —— 强智科技「高校综合管理教务系统」（学生端 /jsxsd/，老界面：table#kbtable + div.kbcontent + font[title]）。
    // 移植自 shiguang_warehouse 的 CSU/csu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 GaLeKu）
    // 上游 resources/CSU/adapters.yaml：CSU_01「中南大学（强智教务）」，maintainer「GaLeKu」，
    //   import_url = https://ca.csu.edu.cn/authserver/login?service=http%3A%2F%2Fcsujwc.its.csu.edu.cn%2Fsso.jsp
    // 上游快照 e15c627（2026-10-26 拉取），本校脚本最后一次修改 a7b9cdf。模板：hnptc（同平台、同样的教学周历 + 网格还原）。
    //
    // 平台判据按脚本实际请求的接口路径，不按注释（上游全部走同源请求，不读当前页面的课表）：
    //   GET  /jsxsd/jxzl/jxzl_query            教学周历页（读学年学期下拉框 #xnxq01id 的默认选中项）
    //   POST /jsxsd/xskb/xskb_list.do          整学期课表（服务端渲染的网页，不是 JSON；容器 table#kbtable，课程在精确类名 div.kbcontent 里）
    //   POST /jsxsd/jxzl/jxzl_query            教学周历（第 1 周的日期与周号）
    //
    // 取数方式：
    //   ① 学期：当前页在 /jsxsd/xskb/ 或 /jsxsd/jxzl/ 下就读本页下拉框的选中项（用户在页面上切到哪一学期，导入的就是哪一学期）；
    //      否则 GET 教学周历页读默认选中项（上游弹窗的默认项）；
    //   ② POST 整学期课表，请求体与上游一字不差（cj0701id=&zc=&demo=&xnxq01id=<学期>）；
    //   ③ POST 教学周历取开学日期与总周数，请求体与上游一致（xnxq01id=<学期>），取不到不是致命错误，由 parse.js 推算并出提醒。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从列表里选学期（上游 showSingleSelection，默认项就是页面选中项）：学期取页面下拉框的选中项；
    //   ② 只交原始结构（学期 + 每格的网格列号 col / 跨列数 span / 清理后的课程明细 HTML + 周历的网格），
    //      周次 / 节次 / 课程名 / 拼课拆分 / 合并的解释全在 parse.js —— 那边 CI 里能真跑；
    //   ③ 格子里只取精确类名 div.kbcontent（上游同样：kbcontent1 是隐藏的旧数据，带着同样完整的拼课数据，取了每门课都翻倍）；
    //      课表容器 table#kbtable 页面里有两个（课程表 / 页脚周次表），按「第一行含星期表头」挑出课程表；
    //   ④ 去掉上游的 showAlert / showToast / saveCourseConfig / savePresetTimeSlots / saveImportedCourses / notifyTaskCompletion 等拾光界面调用；
    //   ⑤ 登录页、统一认证页、不在教务系统里的页面上点提取：直接给大白话提示，不发请求（上游只提示「请先登录教务系统」）；
    //   ⑥ 课程明细按白名单重新拼，不转交 innerHTML：只留最外层文字、换行和标题认得的 font 里看得见的文字，看不见的元素与不认识的标签一律不读；
    //      没有课程明细的格子只交 parse.js 认得的标签（星期表头、行首节次标签、周号 / 日号），周历格子只交 title 里的日期（没有 title 时交格子文字里的日期），
    //      其它自由文字（备注、标题、藏在格子里的姓名学号之类）一律不带出；
    //   ⑦ 上游 res.ok 之外的状态码一律抛错；这里把 401 / 403 与其它非 2xx 分开说，并识别「回的是登录页」。
    //
    // 只请求当前页面同源的教务服务器（中南按学号把请求分摊到多台服务器，以当前页面所在主机为准，不写死域名）：
    // 不读账号密码（只看页面上有没有密码框）、不写页面、不外发任何数据。详见 AUDIT.md。
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var HOST_SUFFIX = '.its.csu.edu.cn';
    var TEXT_LIMIT = 40;       // 学期名最多交出的字数
    var LOGIN_HINT = '请先登录教务系统，再点「提取课表」';
    var NOT_JW = '当前页面不是中南大学教务系统的页面。请先登录教务系统（登录后会自动进入教务），在教务系统的任意页面上再点「提取课表」';
    var ON_LOGIN = '当前页面是登录页或需要输入密码的页面。请先登录教务系统，在教务系统的任意页面上再点「提取课表」';
    var CN_DATE = /\d{4}\s*[-年]\s*\d{1,2}\s*[-月]\s*\d{1,2}/;

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

    // 当前页面所在的教务服务器（同源地址）；主机不是 .its.csu.edu.cn 就返回 null（统一认证页、门户页、别的网站）
    function jwBase() {
        var loc = window.location;
        var host = String(loc.hostname || '').toLowerCase();
        if (host.length <= HOST_SUFFIX.length || host.lastIndexOf(HOST_SUFFIX) !== host.length - HOST_SUFFIX.length) return null;
        return loc.origin ? loc.origin : (loc.protocol + '//' + loc.host);
    }

    // 一格里的课程明细：强智把课程名 + 教师 / 周次(节次) / 教室写在类名恰好是 kbcontent 的 div 里（拼课用一长串减号分隔）。
    // 这里不转交 innerHTML，而是按白名单重新拼一份最小的明细：
    //   · 最外层的文字节点（课程名）原样留；换行标签留；
    //   · font 只留标题里含「周次 / 节次 / 教师 / 老师 / 教室 / 地点 / 单双」的，只取它里面看得见的文字，标题原样写回；
    //   · 其它元素（悬浮详情、span、a、img、输入框、脚本……任何不认识的标签）连里面的文字一律不读；
    //   · 看不见的元素（hidden 属性、aria-hidden、行内样式 display:none / visibility:hidden）一律不读（根节点自己不查）。
    // 注意：类名 kbcontent1（隐藏的旧数据）不是 kbcontent，hasClass 按整词比较，不会误取。
    var FONT_KEYS = ['周次', '节次', '教师', '老师', '教室', '地点', '单双'];
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
                    if (title !== null) html += '<font title="' + title.replace(/"/g, '') + '">' + escapeText(visibleText(kid)) + '</font>';
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

    // 格子的文字只在没有课程明细时才交，而且只交 parse.js 认得的标签：
    //   · 星期表头（「星期日」「星期一」…；中南表头里星期日排在最前）；
    //   · 行首节次标签：中南写成「1－2」（全角连字符，没有「节」字），连排写成「1－2,3－4」；这类标签只在表头单元格（th）里读，
    //     只交里面的数字（用逗号连起来），别的文字不带出；
    //   · 周历里的周号 / 日号 / 日期。
    // 其它自由文字（备注、标题、藏在格子里的姓名学号之类）一律不带出；有明细的格子文字与明细重复，不交。
    function labelOf(text, isTh) {
        var one = clean(text);
        var out = [];
        var found = /(星期|周|礼拜)\s*[一二三四五六日天1-7]/.exec(one);
        if (found) out.push(found[0]);
        if (isTh && !found) {
            var nums = one.match(/\d+/g);
            if (nums && nums.length <= 12) return nums.join(',');
        }
        found = /\d+\s*[~～\-－—]\s*\d+\s*小?节/.exec(one);
        if (found) out.push(found[0]);
        found = CN_DATE.exec(one);
        if (found) out.push(clean(found[0]));
        if (out.length) return out.join(' ');
        if (/^第?\s*\d{1,3}\s*[周节]?$/.test(one) || /^[一二三四五六日天]$/.test(one)) return one;
        return '';
    }

    // th：这个格子是不是表头单元格（行首节次标签「1－2」在每行的 th 里，parse.js 靠它给每门课定节次）
    function cellOf(node, col, span, withNode) {
        var parts = partsOf(node);
        var isTh = tagOf(node) === 'TH';
        var text = node.textContent !== undefined ? node.textContent : node.innerText;
        var cell = { col: col, span: span, text: parts.length ? '' : labelOf(text, isTh), parts: parts };
        if (isTh) cell.th = true;
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

    // 课表容器：页面里有两个 id=kbtable（第一个是课程表，第二个是页脚周次表），按「第一行含星期表头」挑出课程表（上游同样）；
    // 挑不出来就找最近一张含 div.kbcontent 格子的表。
    function findScheduleTable(doc) {
        var tables = doc.getElementsByTagName('table');
        for (var i = 0; i < tables.length; i++) {
            if (attrOf(tables[i], 'id') !== 'kbtable') continue;
            var head = tables[i].getElementsByTagName('tr')[0];
            if (head && /星期/.test(String(head.textContent || ''))) return tables[i];
        }
        var divs = doc.getElementsByTagName('div');
        for (var d = 0; d < divs.length; d++) {
            if (hasClass(divs[d], 'kbcontent')) return closestTable(divs[d]);
        }
        return null;
    }

    // 页面里有没有课程格（精确类名 kbcontent）：上游用它判断「返回的是不是真正的课表」（教学周历页同样有 table#kbtable）
    function hasCourseCells(doc) {
        var divs = doc.getElementsByTagName('div');
        for (var i = 0; i < divs.length; i++) {
            if (hasClass(divs[i], 'kbcontent')) return true;
        }
        return false;
    }

    // 课表：整张表还原成网格，每个格子带上网格列号 col 与跨列数 span，表宽一起交出去。
    // 不能让 parse.js 拿「第几个 td」当星期几：首列是节次列，星期日排在最前，还可能有 rowspan/colspan。
    // 只交「有文字或有课程明细」的行（星期表头行与行首节次标签行照交，parse.js 靠它们认星期与节次）。
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

    // 教学周历的容器：#kbtable（上游 getElementById）；认不出就找第一张有日期 title 的表（周历的日期挂在 td[title] 上）
    function findCalendarTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cells = doc.getElementsByTagName('td');
        for (var i = 0; i < cells.length; i++) {
            if (CN_DATE.test(attrOf(cells[i], 'title'))) return closestTable(cells[i]);
        }
        return null;
    }

    // 周历：只交「有文字或有 title」的格子（空白的日子格没有信息），但保留网格列号。
    // parse.js 读第 1 周那一行：第一格是周号，后面第一个带日期的格子就是开学日（上游同样）。
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
                // 周历格子的 title 只留日期那一段（2026年09月06日 / 2026-09-06），别的备注不带出
                var dated = CN_DATE.exec(attrOf(cells[c].node, 'title'));
                if (dated) item.title = clean(dated[0]);
                if (item.text || item.title) keep.push(item);
            }
            if (keep.length) out.push(keep);
        }
        return out;
    }

    // 学期代码的形状（2026-2027-1）；放宽到只要是安全字符，换了命名规则也不至于整个取不到
    function isTermCode(value) {
        return /^[0-9A-Za-z][0-9A-Za-z_-]{3,23}$/.test(value);
    }

    // 学年学期：下拉框（强智是 select#xnxq01id，值形如 2026-2027-1）。
    // 只读选中项：用户在页面上切到哪一学期，导入的就是哪一学期。取不到选中项时取第一个合规选项（上游默认第 0 项）。
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

    // 课表页的请求体：与上游一字不差（上游 requestCoursePage：cj0701id=&zc=&demo=&xnxq01id=<学期>）
    function scheduleBody(code) {
        return 'cj0701id=&zc=&demo=&xnxq01id=' + encodeURIComponent(code);
    }

    // 教学周历的请求体：与上游一致，只有 xnxq01id
    function calendarBody(code) {
        return 'xnxq01id=' + encodeURIComponent(code);
    }

    // 周历取不到（教务改了页面、这一学期没有周历）不算致命：开学日期由 parse.js 推算并说明。
    // 这里返回空网格而不是抛错。没有学期代码时不发请求。
    function fetchCalendar(base, code) {
        if (!code) return Promise.resolve({ found: false, rows: [] });
        return requestText('POST', base + CALENDAR_PATH, calendarBody(code)).then(function (html) {
            var table = findCalendarTable(htmlDoc(html));
            var rows = table ? calendarGrid(table) : [];
            return { found: rows.length > 0, rows: rows };
        }, function () {
            return { found: false, rows: [] };
        });
    }

    // 学期来源 ①：当前页在课表页 / 教学周历页下，读本页下拉框的选中项
    function pageTerm() {
        var path = String(window.location.pathname || '');
        if (path.indexOf('/jsxsd/xskb/') < 0 && path.indexOf('/jsxsd/jxzl/') < 0) return { code: null, name: null };
        return readTerm(document);
    }

    // 学期来源 ②：GET 教学周历页读默认选中项（上游 fetchSemesterList 弹窗前的默认项）。回的是登录页就当场说清楚
    function fetchDefaultTerm(base) {
        return requestText('GET', base + CALENDAR_PATH, null).then(function (html) {
            var doc = htmlDoc(html);
            var term = readTerm(doc);
            if (!term.code) {
                if (hasPasswordInput(doc)) throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
                throw new Error('教务页面里没找到「学年学期」选项：' + LOGIN_HINT);
            }
            return term;
        });
    }

    // 整学期课表：POST（上游唯一的路径）。返回页里没有 div.kbcontent 就不是课表（上游：「返回页面里没有课程，请确认已登录」）
    function fetchSchedule(base, code) {
        return requestText('POST', base + SCHEDULE_PATH, scheduleBody(code)).then(function (html) {
            var doc = htmlDoc(html);
            if (!hasCourseCells(doc)) {
                if (hasPasswordInput(doc)) throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
                throw new Error('教务返回的页面里没有课程：可能这个学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
            }
            var table = findScheduleTable(doc);
            return table ? scheduleGrid(table) : { cols: 0, rows: [] };
        });
    }

    function payloadOf(term, grid, calendar) {
        return JSON.stringify({
            now: todayIso(),
            term: term,
            cols: grid.cols,
            calendar: calendar,
            rows: grid.rows
        });
    }

    var base = jwBase();
    if (base === null) throw new Error(NOT_JW);
    if (hasPasswordInput(document)) throw new Error(ON_LOGIN);

    var here = pageTerm();
    var termStep = here.code ? Promise.resolve(here) : fetchDefaultTerm(base);
    return termStep.then(function (term) {
        return fetchSchedule(base, term.code).then(function (grid) {
            return fetchCalendar(base, term.code).then(function (calendar) {
                return payloadOf(term, grid, calendar);
            });
        });
    });
})()
