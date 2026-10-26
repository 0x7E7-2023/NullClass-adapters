(function () {
    // 云南财经大学教务适配器 —— 强智科技「高校综合管理教务系统」（学生端 /jsxsd/）。
    // 移植自 shiguang_warehouse 的 YNUFE/ynufe.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 AxelPLN）
    // 上游 resources/YNUFE/adapters.yaml：YNUFE_01「云南财经大学本科教务系统」，maintainer「AxelPLN」，
    //   import_url = https://xjwis.ynufe.edu.cn/jsxsd/
    // 上游快照 e15c627（2026-10-26 拉取），本校脚本最后一次修改 7a4c0f7（2026-10-21：支持获取开学日期及周数、自动判断校区）。
    // 模板：hnptc（同平台、同一组路径：课表页 xskb_list.do + 教学周历 jxzl_query）。
    //
    // 平台判据按脚本实际请求的接口路径，不按注释：
    //   GET  /jsxsd/xskb/xskb_list.do          课表页（页面上没有学期下拉框时才发：读「学年学期」#xnxq01id 与时间模式 #kbjcmsid）
    //   POST /jsxsd/xskb/xskb_list.do          整学期课表（服务端渲染的网页，不是 JSON；容器 #kbtable，课程在 div.kbcontent 里）
    //                                          同一个地址再发两次是「按校区探测」：用「安宁校区」「龙泉校区」两个时间模式各取一遍，看哪边有课
    //   GET  /jsxsd/xskb/xskb_list.do?xnxq01id=..   POST 拿不到课表时的退路（只在主课表上用）
    //   POST /jsxsd/jxzl/jxzl_query            教学周历（第 1 周的日期与周号）
    //
    // 取数方式：
    //   ① 学期与时间模式取页面下拉框（当前页面没有就 GET 一次课表页），不弹窗选学期；
    //   ② POST 整学期课表，请求体与上游一致（jx0404id=&cj0701id=&zc=&demo=&xnxq01id=<学期>&kbjcmsid=<「全部」选项的值>），
    //      不看屏幕上正显示的那张（可能只显示某一周或某个校区的课）；POST 失败或没拿到课表，退回带 xnxq01id 的 GET；
    //   ③ 判断校区（上游：用「安宁校区」时间模式取一遍，有课就用安宁校区的节次时间，否则龙泉校区）：
    //      没有「安宁校区」选项 → 龙泉；安宁模式取不到课 → 龙泉；安宁有课而页面有「龙泉校区」选项时再取一遍龙泉：
    //      两边都有课才用 __ncSelect 问一次（问不了或取消，按上游口径取安宁并提醒）；探测请求失败不致命，取龙泉并提醒；
    //   ④ 再 POST 一次教学周历取开学日期与总周数，取不到不是致命错误，由 parse.js 推算并出提醒。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 不弹窗让用户从列表里选学期（上游 showSingleSelection，默认项就是页面选中项）：学期取页面下拉框的选中项；
    //   ② 只交原始结构（学期 + 校区 + 每格的网格列号 col / 跨列数 span / 清理后的课程明细 HTML / 格子上的星期标注 + 周历的网格），
    //      周次 / 节次 / 课程名 / 合并的解释全在 parse.js —— 那边 CI 里能真跑；
    //   ③ 去掉上游的 showToast / showSingleSelection / saveCourseConfig / savePresetTimeSlots / saveImportedCourses / notifyTaskCompletion 与全部 console 输出；
    //   ④ 地址前缀：当前地址里 /jsxsd/ 之前的那一段（反向代理 / WebVPN 前缀）原样保留，请求落在当前页面同源；
    //   ⑤ 登录页、不在教务系统里的页面上点提取：直接给大白话提示，不发请求（上游只检查地址里有没有 login 或页面有没有密码框，且不发请求时静默返回）；
    //   ⑥ 课程明细按白名单重新拼，不转交 innerHTML：只留最外层文字、换行和标题认得的 font 里看得见的文字，看不见的元素与不认识的标签一律不读；
    //      例外：非首行里「只有看不见的 font + 一段可见文字」的行，上游当教室，这里补成标题为「地点」的 font；
    //      没有课程明细的格子只交 parse.js 认得的标签（星期表头、节次标签、周号 / 日号），周历格子只交 title 里的日期（没有 title 时交格子文字里的日期），
    //      其它自由文字（备注、标题、藏在格子里的姓名学号之类）一律不带出；
    //   ⑦ 格子的星期标注：上游优先取课程 div 的 name（没有取 id）里「哈希-星期-序号」的中间一段（1..7），这里只把那一个整数交出去（哈希不交）；
    //   ⑧ 校区探测多一次「龙泉校区」：只在安宁有课时才发，用来区分「只在安宁上课」与「两个校区都有课」（后者才需要问用户）。
    //
    // 只请求当前页面同源的教务服务器：不读账号密码（只看登录页上有没有密码框）、不写页面、不外发任何数据。详见 AUDIT.md。
    var CONTEXT = '/jsxsd/';
    var SCHEDULE_PATH = '/jsxsd/xskb/xskb_list.do';
    var CALENDAR_PATH = '/jsxsd/jxzl/jxzl_query';
    var TEXT_LIMIT = 40;       // 学期名最多交出的字数
    var LOGIN_HINT = '请先登录教务系统，确认已经进入教务系统后再点「提取课表」';
    var NOT_JW = '当前页面不是教务系统的页面。请先登录教务系统，确认已经进入教务系统后再点「提取课表」';
    var ON_LOGIN = '当前是教务系统的登录页。请先登录，确认已经进入教务系统后再点「提取课表」';
    var CN_DATE = /\d{4}\s*[-年]\s*\d{1,2}\s*[-月]\s*\d{1,2}/;
    var MODE_ALL = '全部';
    var MODE_ANNING = '安宁校区';
    var MODE_LONGQUAN = '龙泉校区';
    var CAMPUS_ITEMS = ['龙泉校区', '安宁校区'];

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

    // 教务地址里 /jsxsd/ 之前的那一段（反向代理前缀）原样保留；当前地址里没有 /jsxsd/ 就返回 null（不在教务系统里）
    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(CONTEXT);
        if (at < 0) return null;
        var loc = window.location;
        var origin = loc.origin ? loc.origin : (loc.protocol + '//' + loc.host);
        return origin + path.substring(0, at);
    }

    // 一格里的课程明细：强智把课程名 + 教师 / 周次(节次) / 教室写在类名含 kbcontent 的 div 里（上游只认 kbcontent，不认 kbcontent1）。
    // 这里不转交 innerHTML，而是按白名单重新拼一份最小的明细：
    //   · 最外层的文字节点（课程名）原样留；换行标签留；
    //   · font 只留标题里含「周次 / 节次 / 教师 / 老师 / 教室 / 地点 / 课程」的，只取它里面看得见的文字，标题原样写回；
    //   · 其它元素（悬浮详情 .item-box、span、a、img、输入框、脚本……任何不认识的标签）连里面的文字一律不读；
    //   · 看不见的元素（hidden 属性、aria-hidden、行内样式 display:none / visibility:hidden）一律不读（根节点自己不查：课程明细的 div 本来就是隐藏的）。
    // 例外一：块里一个带汉字的最外层文字都没有时，才补一个看得见的、不带标题的 font 的文字当课名（别的强智学校有这种写法）。
    // 例外二（上游的教室兜底）：第二行起，一行里有看不见的 font、没有任何认得的带标题 font、却有一段可见文字，上游把可见文字当教室；
    //   这里把它补成 <font title="地点">…</font>（带「教室」标题的 font 排在前面优先，所以不会盖掉真正的教室）。
    var FONT_KEYS = ['周次', '节次', '教师', '老师', '教室', '地点', '课程'];
    var NODE_LIMIT = 100;      // 明细里每段文字最多交出的字数
    var MIN_TEXT = 6;          // 上游：格子里的文字不超过 6 个字的不是课（空格子 / 占位符）

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

    function newLine() {
        return { html: '', text: '', hiddenFont: false, titled: false };
    }

    // 一行收尾：非首行里「有看不见的 font、没有带标题的 font、有可见文字」的，整行当教室（上游的兜底）
    function closeLine(line, index) {
        var plain = clean(line.text);
        if (index > 0 && line.hiddenFont && !line.titled && plain) {
            return '<font title="地点">' + escapeText(plain) + '</font>';
        }
        return line.html;
    }

    function safeHtmlOf(root) {
        var lines = [];
        var line = newLine();
        var haveName = false;
        var plainFont = '';
        var kids = root.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            var kid = kids[i];
            if (kid.nodeType === 3) {
                var text = limited(kid.nodeValue, NODE_LIMIT);
                if (text) {
                    line.html += escapeText(text);
                    line.text += ' ' + text;
                    if (/[一-龥]/.test(text)) haveName = true;
                }
            } else if (kid.nodeType === 1) {
                var tag = tagOf(kid);
                if (isHidden(kid)) {
                    if (tag === 'FONT') line.hiddenFont = true;
                    continue;
                }
                if (tag === 'BR') {
                    lines.push(closeLine(line, lines.length) + '<br/>');
                    line = newLine();
                } else if (tag === 'FONT') {
                    var title = keptTitle(kid);
                    var inner = visibleText(kid);
                    if (title !== null) {
                        line.html += '<font title="' + title.replace(/"/g, '') + '">' + escapeText(inner) + '</font>';
                        line.titled = true;
                    } else if (!plainFont && !clean(attrOf(kid, 'title'))) {
                        plainFont = clean(inner);
                    }
                }
            }
        }
        lines.push(closeLine(line, lines.length));
        var html = lines.join('');
        if (!haveName && plainFont) html = '<font>' + escapeText(plainFont) + '</font>' + html;
        return html;
    }

    // 格子上的星期标注：上游取课程 div 的 name（没有取 id），形如「哈希-星期-序号」，中间一段是 1..7 的星期。只交这个整数，没有或不合法交 0
    function dayHintOf(div) {
        var tag = attrOf(div, 'name') || attrOf(div, 'id');
        var bits = tag.split('-');
        if (bits.length < 3) return 0;
        var day = parseInt(bits[1], 10);
        return day >= 1 && day <= 7 ? day : 0;
    }

    function partsOf(cell) {
        var divs = cell.getElementsByTagName('div');
        var parts = [];
        var hints = [];
        for (var i = 0; i < divs.length; i++) {
            if (!hasClass(divs[i], 'kbcontent')) continue;
            var raw = divs[i].textContent !== undefined ? divs[i].textContent : divs[i].innerText;
            if (clean(raw).length <= MIN_TEXT) continue;
            var html = safeHtmlOf(divs[i]).trim();
            if (html && clean(html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '))) {
                parts.push(html);
                hints.push(dayHintOf(divs[i]));
            }
        }
        return { parts: parts, hints: hints };
    }

    // 格子的文字只在没有课程明细时才交，而且只交 parse.js 认得的标签：星期表头、节次标签（"第1-2节"）、周号 / 日号（周历）。
    // 周历格子里写成文字的日期（没有 title 时上游读文字）也算标签。其它自由文字（备注、标题、藏在格子里的姓名学号之类）一律不带出；有明细的格子文字与明细重复，不交。
    function labelOf(text) {
        var one = clean(text);
        var out = [];
        var found = /(星期|周|礼拜)\s*[一二三四五六日天1-7]/.exec(one);
        if (found) out.push(found[0]);
        found = /\d+\s*[~～\-—]\s*\d+\s*小?节/.exec(one);
        if (found) out.push(found[0]);
        found = CN_DATE.exec(one);
        if (found) out.push(clean(found[0]));
        if (out.length) return out.join(' ');
        if (/^第?\s*\d{1,3}\s*[周节]?$/.test(one) || /^[一二三四五六日天]$/.test(one)) return one;
        return '';
    }

    // th：这个格子是不是表头单元格（节次标签 "第1-2节" 在每行的 th 里，parse.js 靠它给没写节次的课补节次）
    function cellOf(node, col, span, withNode) {
        var got = partsOf(node);
        var text = node.textContent !== undefined ? node.textContent : node.innerText;
        var cell = { col: col, span: span, text: got.parts.length ? '' : labelOf(text), parts: got.parts };
        if (got.parts.length) cell.hints = got.hints;
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

    // 课表容器：上游认 #kbtable，找不到取文档里第一张表；这里 #kbtable 找不到就找最近一张含 .kbcontent 格子的表，再不行取 #timetable。
    function findScheduleTable(doc) {
        var byId = doc.getElementById('kbtable');
        if (byId) return byId;
        var cell = doc.querySelector ? doc.querySelector('.kbcontent') : null;
        if (cell) return closestTable(cell);
        return doc.getElementById('timetable');
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

    // 时间模式下拉框（#kbjcmsid，按 id 或 name 找）里的全部选项：[{value, text}]，最多 30 个、文字截 30 字。只在 extract.js 内部用，不交出去
    function modesOf(doc) {
        var select = doc.getElementById('kbjcmsid');
        if (!select && doc.getElementsByName) {
            var named = doc.getElementsByName('kbjcmsid');
            for (var n = 0; n < named.length && !select; n++) {
                if (tagOf(named[n]) === 'SELECT') select = named[n];
            }
        }
        var out = [];
        if (!select || tagOf(select) !== 'SELECT') return out;
        var options = select.options || [];
        for (var i = 0; i < options.length && out.length < 30; i++) {
            out.push({ value: clean(options[i].value), text: limited(options[i].text, 30) });
        }
        return out;
    }

    // 按文字挑时间模式的值：exact 为真时整句相等（「全部」），否则文字里含有即可（「安宁校区」「龙泉校区」，上游用 includes）。没有返回 null
    function modeValue(modes, label, exact) {
        for (var i = 0; i < modes.length; i++) {
            var hit = exact ? modes[i].text === label : modes[i].text.indexOf(label) >= 0;
            if (hit) return modes[i].value;
        }
        return null;
    }

    function harvestPage(doc) {
        var table = findScheduleTable(doc);
        var grid = table ? scheduleGrid(table) : { cols: 0, rows: [] };
        return {
            term: readTerm(doc),
            modes: modesOf(doc),
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

    // 课表页的请求体：与上游一致（上游 URLSearchParams 的顺序与空参数都留着，没有 sfFD）
    function scheduleBody(code, mode) {
        return 'jx0404id=&cj0701id=&zc=&demo=&xnxq01id=' + encodeURIComponent(code) + '&kbjcmsid=' + encodeURIComponent(mode || '');
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

    // 课表页上读学期与时间模式（GET 课表页）。回的是登录页就当场说清楚
    function fetchPageInfo(base) {
        return requestText('GET', base + SCHEDULE_PATH, null).then(function (html) {
            var doc = htmlDoc(html);
            var term = readTerm(doc);
            if (!term.code && hasPasswordInput(doc)) {
                throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
            }
            return { term: term, modes: modesOf(doc) };
        });
    }

    // 整学期课表：先 POST（上游的主路径），失败或没拿到课表再退回带 xnxq01id 的 GET。
    // 两条路都拿不到：把 POST 的错误（有的话）原样抛出，否则说「课表是空的」
    function fetchSchedule(base, code, mode) {
        var postError = null;
        function judge(html) {
            var got = harvestPage(htmlDoc(html));
            if (got.term.code && got.term.code !== code) {
                throw new Error('教务系统返回的课表不是所选学期（' + code + '）的，请在课表页选好学期后重试');
            }
            if (courseCells(got.rows) === 0) {
                if (!got.rows.length && hasPasswordInput(htmlDoc(html))) {
                    throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
                }
                return null;
            }
            return got;
        }
        return requestText('POST', base + SCHEDULE_PATH, scheduleBody(code, mode)).then(function (html) {
            return judge(html);
        }, function (error) {
            postError = error;
            return null;
        }).then(function (got) {
            if (got) return got;
            return requestText('GET', base + SCHEDULE_PATH + '?xnxq01id=' + encodeURIComponent(code), null).then(function (html) {
                return judge(html);
            }, function (error) {
                throw postError || error;
            });
        }).then(function (got) {
            if (got) return got;
            throw new Error('教务返回的课表是空的：可能本学期还没排课，或者登录状态已失效。' + LOGIN_HINT);
        });
    }

    // 按某个时间模式取一遍课表，看这个模式下有没有课：1 有、0 没有、-1 请求失败（不致命）
    function probeMode(base, code, mode) {
        return requestText('POST', base + SCHEDULE_PATH, scheduleBody(code, mode)).then(function (html) {
            return courseCells(harvestPage(htmlDoc(html)).rows) > 0 ? 1 : 0;
        }, function () {
            return -1;
        });
    }

    // 两个校区都有课时问一次：返回 0（龙泉）/ 1（安宁）/ null（宿主不能提问、用户取消、提问报错，都不让整次提取失败）
    function askCampus() {
        var capable = typeof __ncCapabilities !== 'undefined' && __ncCapabilities && __ncCapabilities.ask;
        if (!capable || typeof __ncSelect !== 'function') return Promise.resolve(null);
        return Promise.resolve().then(function () {
            return __ncSelect({
                title: '选择校区',
                message: '你的课表里龙泉校区和安宁校区的课都有。请选你主要上课的校区，用来设置每节课的上下课时间（两个校区的节次时间不同）',
                items: CAMPUS_ITEMS,
                defaultIndex: 1
            });
        }).then(function (index) {
            return (typeof index === 'number' && index >= 0 && index < CAMPUS_ITEMS.length) ? index : null;
        }, function () {
            return null;
        });
    }

    // 判断校区（how 交给 parse.js 写提醒）：
    //   noOption 页面没有「安宁校区」选项 → 龙泉；probeFailed 探测请求失败 → 龙泉；noAnning 安宁模式下没有课 → 龙泉；
    //   anning 安宁有课（龙泉选项没有或龙泉模式下没课）→ 安宁；asked 两边都有课，问过用户；bothDefault 两边都有课、问不了或用户取消 → 安宁
    function chooseCampus(base, code, modes) {
        var anning = modeValue(modes, MODE_ANNING, false);
        if (!anning) return Promise.resolve({ id: 'longquan', how: 'noOption' });
        return probeMode(base, code, anning).then(function (has) {
            if (has < 0) return { id: 'longquan', how: 'probeFailed' };
            if (has === 0) return { id: 'longquan', how: 'noAnning' };
            var longquan = modeValue(modes, MODE_LONGQUAN, false);
            if (!longquan) return { id: 'anning', how: 'anning' };
            return probeMode(base, code, longquan).then(function (both) {
                if (both <= 0) return { id: 'anning', how: 'anning' };
                return askCampus().then(function (index) {
                    if (index === null) return { id: 'anning', how: 'bothDefault' };
                    return { id: index === 0 ? 'longquan' : 'anning', how: 'asked' };
                });
            });
        });
    }

    function payloadOf(term, got, campus, calendar) {
        return JSON.stringify({
            now: todayIso(),
            term: term,
            campus: campus,
            cols: got.cols,
            calendar: calendar,
            rows: got.rows
        });
    }

    var base = jwBase();
    if (base === null) throw new Error(NOT_JW);

    var liveTerm = readTerm(document);
    var liveModes = modesOf(document);
    if (!liveTerm.code && hasPasswordInput(document)) throw new Error(ON_LOGIN);

    // 学期与时间模式：当前页面有就用（用户在页面上选到哪一学期，导入的就是哪一学期），没有就 GET 一次课表页
    var infoStep = (liveTerm.code && liveModes.length)
        ? Promise.resolve({ term: liveTerm, modes: liveModes })
        : fetchPageInfo(base).then(function (info) {
            return { term: liveTerm.code ? liveTerm : info.term, modes: liveModes.length ? liveModes : info.modes };
        });
    return infoStep.then(function (info) {
        if (!info.term.code) {
            throw new Error('教务页面里没找到「学年学期」选项：' + LOGIN_HINT);
        }
        var code = info.term.code;
        var allMode = modeValue(info.modes, MODE_ALL, true);
        return fetchSchedule(base, code, allMode || '').then(function (got) {
            // 时间模式列表以所选学期的课表页为准（上游同样），课表页上没有就用前面读到的
            var modes = got.modes.length ? got.modes : info.modes;
            return chooseCampus(base, code, modes).then(function (campus) {
                return fetchCalendar(base, code).then(function (calendar) {
                    return payloadOf(info.term, got, campus, calendar);
                });
            });
        });
    });
})()
