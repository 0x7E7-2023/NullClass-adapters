(function () {
    // 曲阜师范大学 教务适配器 —— 强智科技「教务管理系统」（学生端 /jsxsd/，教务主机 zhjw.qfnu.edu.cn）。
    // 移植自 shiguang_warehouse 的 QFNU/qfnu_01.js（MIT，上游作者 Yumu-banxia）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 resources/QFNU/adapters.yaml：adapter_name「曲阜师范大学强智教务」，maintainer「Yumu-banxia」，
    //   import_url = http://zhjw.qfnu.edu.cn/jsxsd/
    // 上游快照 19a65bf（2026-10-19 拉取）；本校脚本最后一次修改 80e30cf。
    //
    // 平台判据按脚本**实际请求的接口路径**（与上游 QFNU_KB_URL / QFNU_CALENDAR_URL 一致），不按注释：
    //   GET  /jsxsd/xskb/xskb_list.do                          课表页（读学年学期下拉框与节次模式下拉框）
    //   POST /jsxsd/xskb/xskb_list.do                          整学期课表（服务端渲染的 HTML；容器 #timetable / #kbtable，格子 div.kbcontent / div.kbcontent1）
    //   GET  /jsxsd/xskb/xskb_list.do?xnxq01id=<学期>          POST 取不到表格时的退路（上游同样）
    //   POST /jsxsd/jxzl/jxzl_query                            教学周历（开学日期与周号）
    // 路径前缀：上游 jsxsdUrl() 取当前页面路径里 /jsxsd/ 之前的部分作前缀（兼容经 WebVPN 的路径形态），这里照做。
    //
    // 取数方式：
    //   ① 当前页面就是课表页、课表格子已经在屏幕上、且没有选定某一周 → 直接用（用户此刻看到的那张，不多发课表请求），
    //      学期也取页面下拉框的选中项；
    //   ② 否则 GET 课表页读学期与节次模式（上游弹窗时的默认项 = 选中项，这里不弹窗），再 POST 整学期课表，
    //      请求体与上游一字不差（jx0404id=&cj0701id=&zc=&demo=&xnxq01id=<学期>&sfFD=1&kbjcmsid=<节次模式>）；
    //      POST 取不到表格就退回带学期的 GET，和上游一致；
    //   ③ 两条路都再 POST 一次教学周历取开学日期与总周数，取不到不是致命错误，由 parse.js 推算并出提醒。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从学期列表里选（上游 showSingleSelection，默认项就是页面选中项）：学期取页面下拉框的选中项；
    //   ② 只交原始结构出去（学期 + 每格的网格列号 col / 跨列数 span / 是否表头格 head / 去掉悬浮详情后的原始 HTML + 周历的网格），
    //      周次 / 节次 / 课程名的解释与简表详表的择优全在 parse.js —— 那边 CI 里能真跑；
    //   ③ 简表（div.kbcontent1）与详表（div.kbcontent）都交（上游两个都读、再择优）；悬浮详情（.item-box）与隐藏元素（display:none 等，里面的文字用户看不到）在复制出来的节点上摘掉，页面本身不动；
    //   ④ 去掉上游的 showAlert / showToast / showSingleSelection / saveCourseConfig / saveImportedCourses / notifyTaskCompletion 等拾光界面调用；
    //   ⑤ 不在教务系统里、或停在登录页时直接给大白话提示，不发请求（上游只判断路径里有没有 /jsxsd/）；
    //   ⑥ 屏幕上的课表只在页面就是课表页时才用（别的 /jsxsd/ 页面上也可能有别人的课表，例如班级课表）；
    //      选定了某一周的课表页不当整学期用（只显示那一周的课），改走 ②；
    //   ⑦ POST 与退路 GET 返回的页面若自带学期下拉框、且选中的不是所选学期，不当作所选学期的课表。
    //
    // 只请求当前页面同源的教务服务器的相对路径：不读账号密码（只看登录页上有没有密码框）、
    // 不写页面、不外发任何数据。详见 AUDIT.md。
    var HOST = 'zhjw.qfnu.edu.cn';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var LOGIN_HINT = '请先登录教务系统并打开「课表查询」，确认页面上能看到课表再点「提取课表」';
    var NOT_JW = '当前打开的不是曲阜师范大学教务系统的页面。请先登录教务系统，再打开「课表查询」，然后点「提取课表」';
    var ON_LOGIN = '当前是教务系统的登录页。请先登录，再打开「课表查询」，确认页面上能看到课表再点「提取课表」';
    var CN_DATE = /\d{4}\s*[-年]\s*\d{1,2}\s*[-月]\s*\d{1,2}/;

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
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

    // 页面路径里 /jsxsd/ 之前的部分是前缀（直连为空，经 WebVPN 时是它的路径前缀）；rel 是 /jsxsd/ 起的小写路径。
    function locate() {
        var path = String(window.location.pathname || '');
        var lower = path.toLowerCase();
        var at = lower.indexOf('/jsxsd/');
        if (at < 0 && /\/jsxsd$/.test(lower)) at = lower.length - 6;
        if (at < 0) return { inJsxsd: false, prefix: '', rel: '' };
        return { inJsxsd: true, prefix: path.substring(0, at), rel: lower.substring(at) };
    }

    var where = locate();

    // 登录页 / 门户页：不发请求，给大白话提示。强智的 /jsxsd/ 根路径、index、login、xk/LoginToXk 都是登录表单；
    // 路径里没有 /jsxsd/、或主机不是本校教务又不带前缀（别的学校、别的入口）时，相对路径请求会打到别处，同样不发。只看地址。
    function loginHint() {
        var host = String(window.location.hostname || '').toLowerCase();
        if (!where.inJsxsd) return NOT_JW;
        if (host !== HOST && where.prefix === '') return NOT_JW;
        if (/^\/jsxsd\/?$/.test(where.rel) || /^\/jsxsd\/(index|login|xk\/log)/.test(where.rel)) return ON_LOGIN;
        return '';
    }

    // 隐藏元素里的文字用户看不到，不能交出去（页面可能在里面藏着学号、姓名之类）：
    // 复制出来的节点与原节点结构相同，按下标对应；原节点上算出来 display:none 的、
    // 带 hidden 属性、内联样式写了隐藏的、类名在页面自带 <style> 里写成 display:none 的，在复制出来的节点上整个摘掉。页面本身不动。
    function hiddenStyle(text) {
        return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(text);
    }

    // 页面（或返回页）自带的 <style> 里写成 display:none 的类名。离线解析的返回页没有排版，算不出样式，
    // 只能靠这个认「类名隐藏」；外链样式表里的认不出来（AUDIT.md §13）。
    var hiddenClasses = {};

    function collectHiddenClasses(doc) {
        hiddenClasses = {};
        var styles = doc.getElementsByTagName('style');
        for (var i = 0; i < styles.length; i++) {
            var text = String(styles[i].textContent || '');
            var re = /\.([A-Za-z0-9_-]+)\s*\{[^}]*display\s*:\s*none/g;
            var m = re.exec(text);
            while (m) {
                hiddenClasses[m[1]] = true;
                m = re.exec(text);
            }
        }
    }

    function hasHiddenClass(node) {
        var names = String((node && node.className) || '').split(/\s+/);
        for (var i = 0; i < names.length; i++) {
            if (names[i] && hiddenClasses[names[i]]) return true;
        }
        return false;
    }

    function dropHidden(original, copy) {
        if (!original.querySelectorAll || !copy.querySelectorAll) return;
        var src = original.querySelectorAll('*');
        var dst = copy.querySelectorAll('*');
        var doomed = [];
        for (var i = 0; i < src.length && i < dst.length; i++) {
            var hide = src[i].hasAttribute && src[i].hasAttribute('hidden');
            if (!hide && (hiddenStyle(attrOf(src[i], 'style')) || hasHiddenClass(src[i]) || attrOf(src[i], 'aria-hidden') === 'true')) hide = true;
            if (!hide && window.getComputedStyle) {
                try {
                    var cs = window.getComputedStyle(src[i]);
                    hide = cs.display === 'none';
                } catch (error) {
                    hide = false;
                }
            }
            if (hide) doomed.push(dst[i]);
        }
        for (var d = 0; d < doomed.length; d++) {
            if (doomed[d].parentNode) doomed[d].parentNode.removeChild(doomed[d]);
        }
    }

    // 一格里的课程明细：强智把课程名 + 教师 / 周次(节次) / 教室写在类名是 kbcontent（详表）或 kbcontent1（简表）的 div 里，
    // 上游两种都读，再按课名 + 周次 + 教室归并、择优。这里两种都交，择优留给 parse.js。
    // 明细里若嵌着悬浮详情（.item-box，内容与明细重复），在复制出来的节点上摘掉再取 HTML。
    function partsOf(cell) {
        var divs = cell.getElementsByTagName('div');
        var parts = [];
        for (var i = 0; i < divs.length; i++) {
            if (!hasClass(divs[i], 'kbcontent') && !hasClass(divs[i], 'kbcontent1')) continue;
            var copy = divs[i].cloneNode(true);
            var boxes = copy.querySelectorAll ? copy.querySelectorAll('.item-box') : [];
            for (var b = 0; b < boxes.length; b++) {
                if (boxes[b].parentNode) boxes[b].parentNode.removeChild(boxes[b]);
            }
            dropHidden(divs[i], copy);
            var html = String(copy.innerHTML || '').trim();
            if (html && html.replace(/&nbsp;/gi, '').trim() !== '') parts.push(html);
        }
        return parts;
    }

    // 格子的文字只在没有课程明细时才交（节次标签、星期表头要靠它认）；有明细的格子文字与明细重复，不交。
    // head 标出表头格（th）：parse.js 在没有方括号节次时，靠行首 th 里的「1~2节」认这一行的节次（上游同样读 th）。
    function cellOf(node, col, span, withNode) {
        var parts = partsOf(node);
        var text = node.textContent !== undefined ? node.textContent : node.innerText;
        var cell = { col: col, span: span, text: parts.length ? '' : clean(text), parts: parts };
        if (tagOf(node) === 'TH') cell.head = true;
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
    // 否则下一行的格子会整体左移一格 —— 课表的首列是节次列，它常被 rowspan 跨两行，正是靠 col 才对齐得回来。
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

    // 课表容器：上游 findTimetableTable() 认 #timetable 与 #kbtable（不同强智版本各用一个）。
    // 都没有再退一步找最近一张含课程明细格子的表。
    function findScheduleTable(doc) {
        var byId = doc.getElementById('timetable') || doc.getElementById('kbtable');
        if (byId) return byId;
        var cell = doc.querySelector ? doc.querySelector('.kbcontent, .kbcontent1') : null;
        return cell ? closestTable(cell) : null;
    }

    // 课表：整张表还原成网格，每个格子带上网格列号 col 与跨列数 span，表宽一起交出去。
    // 不能让 parse.js 拿「第几个 td」当星期几：首列是节次列、还有 rowspan/colspan。
    // 只交「有文字或有课程明细」的行（节次标签行照交，parse.js 靠它认节次与无表头时的对齐）。
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

    // 教学周历的容器：上游取文档里第一张表（doc.querySelector('table')）。这里先找 #kbtable，
    // 再找第一张有日期 title 的表（周历的日期挂在 td[title] 上），最后才是文档里第一张表。
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
                var title = clean(attrOf(cells[c].node, 'title'));
                if (title) item.title = title;
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
    // 只读选中项：用户在页面上切到哪一学期，导入的就是哪一学期。取不到选中项时取第一个合规选项（上游同样默认第一项）。
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
                    firstName = clean(options[j].text);
                }
                if (options[j].selected) {
                    code = value;
                    name = clean(options[j].text);
                }
            }
            if (!code && firstCode) {
                code = firstCode;
                name = firstName;
            }
        }
        return { code: code, name: name };
    }

    // 按 id 或 name 找下拉框，返回 { found, value }：选中项的值，没有选中项取第一项（上游 parseKbjcmsid 同样），没有这个下拉框 found 为 false
    function selectInfo(doc, key) {
        var selects = doc.getElementsByTagName('select');
        for (var i = 0; i < selects.length; i++) {
            if (String(selects[i].id || '') !== key && String(selects[i].name || '') !== key) continue;
            var options = selects[i].options || [];
            for (var j = 0; j < options.length; j++) {
                if (options[j].selected) return { found: true, value: clean(options[j].value) };
            }
            return { found: true, value: options.length ? clean(options[0].value) : '' };
        }
        return { found: false, value: '' };
    }

    // 页面上是不是选定了某一周（#zc 选了具体周次）：那样课表只显示那一周的课，不能当整学期用
    function weekFiltered(doc) {
        var info = selectInfo(doc, 'zc');
        return info.found && /^[0-9]+$/.test(info.value) && parseInt(info.value, 10) > 0;
    }

    function harvestPage(doc) {
        collectHiddenClasses(doc);
        var table = findScheduleTable(doc);
        var grid = table ? scheduleGrid(table) : { cols: 0, rows: [] };
        return {
            hasTable: !!table,
            term: readTerm(doc),
            mode: selectInfo(doc, 'kbjcmsid'),
            filtered: weekFiltered(doc),
            cols: grid.cols,
            rows: grid.rows
        };
    }

    function htmlDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    // 只看登录页上有没有密码输入框，不读它的值
    function hasPasswordInput(doc) {
        var inputs = doc.getElementsByTagName('input');
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === 'password') return true;
        }
        return false;
    }

    function requestText(method, path, body) {
        var init = { method: method, credentials: 'same-origin' };
        if (body !== null) {
            init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            init.body = body;
        }
        return fetch(where.prefix + path, init).then(function (response) {
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

    // 课表页的请求体：与上游 fetchTimetableDoc() 一字不差（顺序与空参数都留着；节次模式取不到时同样发空值）
    function scheduleBody(code, mode) {
        return 'jx0404id=&cj0701id=&zc=&demo=&xnxq01id=' + encodeURIComponent(code) + '&sfFD=1&kbjcmsid=' + encodeURIComponent(mode);
    }

    // 教学周历的请求体：与上游 fetchCalendar() 一致，只有 xnxq01id
    function calendarBody(code) {
        return 'xnxq01id=' + encodeURIComponent(code);
    }

    // 周历取不到（教务改了页面、这一学期没有周历、返回页自带的学期不是所选学期）不算致命：开学日期由 parse.js 推算并说明。
    // 这里返回空网格而不是抛错。没有学期代码时不发请求。
    function fetchCalendar(code) {
        if (!code) return Promise.resolve({ found: false, rows: [] });
        return requestText('POST', CALENDAR_PATH, calendarBody(code)).then(function (html) {
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

    // 课表页上读学期与节次模式（GET 课表页，上游用它列学期并取 kbjcmsid）
    function fetchPageInfo() {
        return requestText('GET', SCHEDULE_PATH, null).then(function (html) {
            var doc = htmlDoc(html);
            return { term: readTerm(doc), mode: selectInfo(doc, 'kbjcmsid') };
        });
    }

    // 返回页有课表格子的容器、且自带的学期（若有）就是所选学期，才算拿到所选学期的课表。
    // 返回 { page } 或 { mismatch: true } 或 null（根本没有课表容器）。
    function checkSchedule(html, code) {
        var page = harvestPage(htmlDoc(html));
        if (!page.hasTable) return null;
        if (page.term.code && page.term.code !== code) return { mismatch: true };
        return { page: page };
    }

    // 取整学期课表：先 POST，取不到再退回带学期的 GET（上游同样）。POST 失败（含非 2xx）也走退路。
    function fetchSchedule(code, mode) {
        return requestText('POST', SCHEDULE_PATH, scheduleBody(code, mode)).then(function (html) {
            return checkSchedule(html, code);
        }, function () {
            return null;
        }).then(function (posted) {
            if (posted && posted.page) return posted.page;
            return requestText('GET', SCHEDULE_PATH + '?xnxq01id=' + encodeURIComponent(code), null).then(function (html) {
                var got = checkSchedule(html, code);
                if (got && got.page) return got.page;
                if (got && got.mismatch) {
                    throw new Error('教务系统返回的课表不是所选学期（' + code + '）的，请在课表页选好学期后重试');
                }
                throw new Error('教务系统没有返回课表：登录状态可能已失效。' + LOGIN_HINT);
            });
        });
    }

    // 页面地址只交协议、主机与路径：查询串里可能带学号，不交
    function pageUrlOf() {
        var loc = window.location;
        return String(loc.protocol) + '//' + String(loc.host) + String(loc.pathname);
    }

    function payloadOf(flight, calendar) {
        return JSON.stringify({
            source: 'qz-jsxsd',
            pageUrl: pageUrlOf(),
            now: todayIso(),
            term: flight.term,
            screenTermMissing: flight.screenTermMissing === true,
            cols: flight.cols,
            calendar: calendar,
            rows: flight.rows
        });
    }

    var hint = loginHint();
    if (hint) throw new Error(hint);

    var live = harvestPage(document);
    if (courseCells(live.rows) === 0 && hasPasswordInput(document)) throw new Error(ON_LOGIN);
    var onSchedulePage = where.rel.indexOf(SCHEDULE_PATH) === 0;
    // 页面就是课表页、课表格子已在屏幕上、且没有选定某一周：用屏幕上的那份（学期也取它的，它就是用户看到的那一学期）
    var onScreen = onSchedulePage && courseCells(live.rows) > 0 && !live.filtered;

    if (onScreen) {
        var termStep = live.term.code
            ? Promise.resolve(live.term)
            : fetchPageInfo().then(function (info) { return info.term; }, function () { return { code: null, name: null }; });
        return termStep.then(function (term) {
            return fetchCalendar(term.code).then(function (calendar) {
                return payloadOf({ term: term, cols: live.cols, rows: live.rows, screenTermMissing: !live.term.code }, calendar);
            });
        });
    }

    // 选定了某一周的课表页自带学期与节次模式，直接用；其余情形 GET 课表页读（上游的做法）
    var infoStep = (onSchedulePage && live.term.code)
        ? Promise.resolve({ term: live.term, mode: live.mode })
        : fetchPageInfo();
    return infoStep.then(function (info) {
        if (!info.term.code) {
            throw new Error('教务页面里没找到「学年学期」选项：' + LOGIN_HINT);
        }
        return fetchSchedule(info.term.code, info.mode.value).then(function (got) {
            if (courseCells(got.rows) === 0) {
                throw new Error('教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
            }
            return fetchCalendar(info.term.code).then(function (calendar) {
                return payloadOf({ term: info.term, cols: got.cols, rows: got.rows }, calendar);
            });
        });
    });
})()
