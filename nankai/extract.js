(function () {
    // 南开大学（研究生）培养管理信息系统教务适配器（JSP 服务端渲染 ·
    // /py/page/student/grkcb.htm）—— 第一步：取数。
    //
    // 移植自 shiguang_warehouse 的 NANKAI/nankai.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Cure）
    // 上游快照 baf83fa（2026-11-09 拉取），本校脚本最后一次修改 2e1e720。
    //
    // 上游取数方式（JSP 页面逐周渲染，没有 JSON 接口）：
    //   ① 取一次不带参数的课表页：学年 #xn / 学期 #xj / 周次 #zc 三个下拉框
    //      （选中项 = 学校当前学期）与页面底部的节次时间说明都在这一份响应里；
    //   ② 按周次逐个取 grkcb.htm?xn=..&xj=..&zc=N，把每一周课表格子里的课程链接收下来。
    //      同一门课只在它真正上课的那一周出现，所以每一周抓到的记录都记一个「第 N 周」。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 删掉上游的确认弹窗与全部 shiguangBridge 保存调用：学年学期直接取教务页面的默认选中项，
    //      确认信息写进 parse.js 的提醒；
    //   ② extract.js 只交「第几周、星期几、课程链接里的可见文字行」；课程名 / 节次 / 教师 / 地点怎么解释、
    //      跨周怎么合并去重全在 parse.js（CI 用 Rhino 真跑得到，extract.js 需要浏览器）；
    //   ③ 只读课程链接 <a> 自己的可见文字，隐藏元素（hidden 属性、aria-hidden、
    //      display:none / visibility:hidden）一律不读——格子里的浮窗、悬浮详情即使写了学生姓名 / 学号也不会带出去；
    //   ④ 逐周并发 3（与上游同值）；某几周没取到不算失败，交给 parse.js 写进提醒；一周都没取到才报错；
    //   ⑤ 登录页、统一认证页、不在这个系统里的页面上点提取：给大白话提示，不发请求。
    //
    // 只请求当前页面同源的 /py/page/student/grkcb.htm（相对路径，不把主机名写进请求）：
    // 不读账号密码、不写页面、不外发任何数据。审计见同目录 AUDIT.md。
    var HOST = 'yjs.nankai.edu.cn';
    var PAGE_PATH = '/py/page/student/grkcb.htm';
    var CONCURRENCY = 3;        // 上游同值：同一 JSP 会话并发过高会被串行化
    var REQUEST_TIMEOUT = 8000; // 单个页面最多等 8 秒，卡住的页面不能拖垮整次导入
    var CRAWL_BUDGET = 22000;   // 逐周抓取的总时长预算（宿主 30 秒上限），超时的周按没取到处理
    var LINE_LIMIT = 60;        // 每个文字行最多交出的字数
    var MAX_LINES = 8;          // 每个课程链接最多交出的行数
    var LOGIN_HINT = '请先登录研究生教务系统，打开「个人课表」页面后再点「提取课表」';
    var NOT_JW = '当前页面不是南开大学研究生教务系统的页面。请先登录研究生教务系统，在「个人课表」页面上再点「提取课表」';
    var ON_LOGIN = '当前页面是登录页。请先登录研究生教务系统，在「个人课表」页面上再点「提取课表」';
    var LOGIN_LOST = '未获取到课表数据：登录状态可能已失效。请重新登录研究生教务系统后再点「提取课表」';

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

    // 提取时刻（本地日期）。教务给不出开学日期时由 parse.js 按学期规则推算。
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

    // 看不见的元素：hidden 属性、aria-hidden="true"、行内 display:none / visibility:hidden
    function isHidden(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.hasAttribute && (node.hasAttribute('hidden') || attrOf(node, 'aria-hidden').toLowerCase() === 'true')) return true;
        return /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrOf(node, 'style'));
    }

    // 一个元素里看得见的文字；<br> 当换行。隐藏元素与脚本 / 样式连里面的文字都不读。
    function visibleText(node) {
        var out = '';
        var kids = node.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            var kid = kids[i];
            if (kid.nodeType === 3) {
                out += kid.nodeValue;
            } else if (kid.nodeType === 1) {
                var tag = tagOf(kid);
                if (tag === 'BR') out += '\n';
                else if (tag !== 'SCRIPT' && tag !== 'STYLE' && !isHidden(kid)) out += visibleText(kid);
            }
        }
        return out;
    }

    // 课程链接 -> 按 <br> 切分的可见文字行（课名 / 周次说明 / 第X节 -- 第Y节 / 教师 / 地点）
    function linesOf(anchor) {
        var raw = visibleText(anchor).replace(/ /g, ' ').replace(/\r/g, '').split('\n');
        var out = [];
        for (var i = 0; i < raw.length && out.length < MAX_LINES; i++) {
            var line = limited(raw[i], LINE_LIMIT);
            if (line) out.push(line);
        }
        return out;
    }

    // 把表格展开成二维网格，正确处理 rowspan / colspan（课表用 rowspan 跨节次、
    // 表头的「时间」列常用 colspan 合并）；跨行 / 跨列的格子只在它左上角那一格留下节点。
    function buildGrid(table) {
        var grid = [];
        var occupied = [];
        var trs = table.getElementsByTagName('tr');
        for (var r = 0; r < trs.length; r++) {
            var col = 0;
            var kids = trs[r].children || [];
            for (var k = 0; k < kids.length; k++) {
                var cell = kids[k];
                var tag = tagOf(cell).toLowerCase();
                if (tag !== 'td' && tag !== 'th') continue;
                while (occupied[r] && occupied[r][col]) col++;
                var colspan = parseInt(attrOf(cell, 'colspan'), 10);
                var rowspan = parseInt(attrOf(cell, 'rowspan'), 10);
                if (!(colspan >= 1)) colspan = 1;
                if (!(rowspan >= 1)) rowspan = 1;
                for (var i = 0; i < rowspan; i++) {
                    var rr = r + i;
                    grid[rr] = grid[rr] || [];
                    occupied[rr] = occupied[rr] || [];
                    for (var j = 0; j < colspan; j++) {
                        if (!i && !j) grid[rr][col] = cell;
                        occupied[rr][col + j] = true;
                    }
                }
                col += colspan;
            }
        }
        return grid;
    }

    // 表头形如 <th colspan="2">时间</th><th>星期一</th>… -> { 列下标: 星期(1~7) }
    // 表头不一定在第一行（上面可能有标题行），往下找几行，认不出就放弃。
    function findDayColumns(grid) {
        var days = '一二三四五六日';
        for (var r = 0; r < grid.length && r < 5; r++) {
            var map = {};
            var found = 0;
            var row = grid[r] || [];
            for (var col = 0; col < row.length; col++) {
                if (!row[col]) continue;
                var match = clean(row[col].textContent).replace(/\s/g, '').match(/^星期([一二三四五六日天])$/);
                if (!match) continue;
                map[col] = days.indexOf(match[1] === '天' ? '日' : match[1]) + 1;
                found++;
            }
            if (found) return map;
        }
        return null;
    }

    // 课表主表格：上游先认 table.table-course，再找同时含「星期一」与「第 N 节」的表
    function findTimetable(doc) {
        var direct = doc.querySelector('table.table-course');
        if (direct && /星期/.test(String(direct.textContent || ''))) return direct;
        var tables = doc.getElementsByTagName('table');
        for (var i = 0; i < tables.length; i++) {
            var text = String(tables[i].textContent || '');
            if (/星期一/.test(text) && /第\s*\d+\s*节/.test(text)) return tables[i];
        }
        return null;
    }

    // 解析某一周课表页面里所有课程链接；null 表示页面里找不到课表（登录失效 / 页面改版）
    function parseWeekDoc(doc) {
        var table = findTimetable(doc);
        if (!table) return null;
        var grid = buildGrid(table);
        var dayColumns = findDayColumns(grid);
        if (!dayColumns) return null;

        var keys = [];
        for (var key in dayColumns) {
            if (Object.prototype.hasOwnProperty.call(dayColumns, key)) keys.push(key);
        }

        var out = [];
        for (var r = 1; r < grid.length; r++) {
            for (var k = 0; k < keys.length; k++) {
                var col = Number(keys[k]);
                var cell = grid[r] ? grid[r][col] : null;
                if (!cell) continue;
                // 同一格可能塞了多门课（冲突课程），逐个解析
                var anchors = cell.getElementsByTagName('a');
                for (var a = 0; a < anchors.length; a++) {
                    var anchor = anchors[a];
                    if (!/第\s*\d+\s*节/.test(String(anchor.textContent || ''))) continue;
                    var lines = linesOf(anchor);
                    if (!lines.length) continue;
                    var strong = anchor.getElementsByTagName('strong');
                    var name = strong.length ? limited(visibleText(strong[0]), LINE_LIMIT) : '';
                    out.push({ day: dayColumns[keys[k]], name: name, lines: lines });
                }
            }
        }
        return out;
    }

    // <select> 的选项 -> [{ value, label, selected }]
    function readOptions(select) {
        var out = [];
        if (!select) return out;
        var options = select.getElementsByTagName('option');
        for (var i = 0; i < options.length; i++) {
            var value = clean(options[i].value);
            if (!value) continue;
            out.push({
                value: value,
                label: limited(options[i].textContent, 40),
                // 只看 selected 属性：没有预选时浏览器会把第一项当作已选中，
                // 用 selected 属性判断才不会把「没预选」误当成「学校选了第一项」
                selected: options[i].hasAttribute('selected')
            });
        }
        return out;
    }

    function selectedValue(options) {
        for (var i = 0; i < options.length; i++) {
            if (options[i].selected) return options[i].value;
        }
        return '';
    }

    function labelOf(options, value) {
        for (var i = 0; i < options.length; i++) {
            if (options[i].value === value) return options[i].label;
        }
        return value;
    }

    // 中文数字 -> 整数（支持 一 ~ 九十九）；无法解析返回 NaN
    var CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

    function cnToInt(text) {
        var s = String(text || '').replace(/\s/g, '');
        if (!s) return NaN;
        if (s === '十') return 10;
        if (s.length === 1) return Object.prototype.hasOwnProperty.call(CN_DIGITS, s) ? CN_DIGITS[s] : NaN;
        var idx = s.indexOf('十');
        if (idx === -1) return NaN;
        var high = idx === 0 ? 1 : CN_DIGITS[s.charAt(idx - 1)];
        var low = idx === s.length - 1 ? 0 : CN_DIGITS[s.charAt(idx + 1)];
        return (high === undefined || low === undefined) ? NaN : high * 10 + low;
    }

    // "8:00" / "08:00:00" -> "08:00"；非法返回 null
    function formatTime(value) {
        var match = typeof value === 'string' ? value.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/) : null;
        if (!match) return null;
        var hour = Number(match[1]);
        var minute = Number(match[2]);
        if (hour > 23 || minute > 59) return null;
        return pad2(hour) + ':' + pad2(minute);
    }

    function minutesOf(value) {
        var text = formatTime(value);
        if (!text) return -1;
        return Number(text.substring(0, 2)) * 60 + Number(text.substring(3));
    }

    // 从页面正文解析节次时间，形如「第一节 8:00-8:45 第二节 8:55-9:40 …」。
    // 只交「第几节 + 起止时间」；要求编号从 1 起连续，否则返回 null 交给 parse.js 的兜底表。
    function parseTimeSlots(doc) {
        var bodyText = doc && doc.body ? String(doc.body.textContent || '') : '';
        if (!bodyText) return null;

        var normalized = bodyText
            .replace(/[：]/g, ':')
            .replace(/[–—~～至]/g, '-')
            .replace(/\s+/g, ' ');
        var pattern = /第([一二三四五六七八九十]+|\d{1,2})\s*节?:?\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g;
        var collected = {};
        var maxIndex = 0;
        var match;
        while ((match = pattern.exec(normalized)) !== null) {
            var number = /^\d+$/.test(match[1]) ? parseInt(match[1], 10) : cnToInt(match[1]);
            var start = formatTime(match[2]);
            var end = formatTime(match[3]);
            if (!(number >= 1) || !start || !end) continue;
            if (minutesOf(start) >= minutesOf(end)) continue;
            if (collected['p' + number]) continue;
            collected['p' + number] = { number: number, start: start, end: end };
            if (number > maxIndex) maxIndex = number;
        }

        var slots = [];
        for (var i = 1; i <= maxIndex; i++) {
            if (!collected['p' + i]) return null;   // 编号不连续：交给兜底表，不猜
            slots.push(collected['p' + i]);
        }
        return slots.length ? slots : null;
    }

    // 只看页面上有没有密码输入框，不读它的值
    function hasPasswordInput(doc) {
        var inputs = doc.getElementsByTagName('input');
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === 'password') return true;
        }
        return false;
    }

    // 文档是不是这个系统的课表页 —— 用来区分「这一周没课」和「登录失效 / 请求被拦」
    function looksLikeCoursePage(doc) {
        return !!(doc.getElementById('kcbForm') || doc.getElementById('zc') || doc.getElementById('xn'));
    }

    function requestText(url) {
        var options = { method: 'GET', credentials: 'same-origin' };
        var controller = null;
        var timer = null;
        if (typeof AbortController === 'function') {
            controller = new AbortController();
            options.signal = controller.signal;
            timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT);
        }
        function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
        return fetch(url, options).then(function (response) {
            stopTimer();
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            return response.text();
        }, function () {
            stopTimer();
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        });
    }

    function htmlDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    // 简单的并发池（不依赖 Set / Map，ES5 对象够用）
    function runPool(tasks, limit) {
        var results = [];
        var cursor = 0;
        function worker() {
            if (cursor >= tasks.length) return Promise.resolve();
            var index = cursor;
            cursor++;
            return tasks[index]().then(function (value) {
                results[index] = value;
                return worker();
            });
        }
        var runners = [];
        var count = Math.min(limit, tasks.length);
        for (var i = 0; i < count; i++) runners.push(worker());
        return Promise.all(runners).then(function () {
            return results;
        });
    }

    // 第一次取不带参数的课表页：学年 / 学期 / 周次的默认项、节次时间都在这一份响应里
    function loadTermPage() {
        return requestText(PAGE_PATH).then(function (html) {
            var doc = htmlDoc(html);
            if (hasPasswordInput(doc)) throw new Error(ON_LOGIN);

            var xnOptions = readOptions(doc.getElementById('xn'));
            var xjOptions = readOptions(doc.getElementById('xj'));
            var zcOptions = readOptions(doc.getElementById('zc'));
            if (!xnOptions.length || !xjOptions.length || !zcOptions.length) throw new Error(LOGIN_LOST);

            // 学年学期用教务页面的默认选中项（上游同样）；没有选中项时才用列表第一项，并标出来
            var xn = selectedValue(xnOptions);
            var xj = selectedValue(xjOptions);
            var source = 'selected';
            if (!xn) { xn = xnOptions[0].value; source = 'first'; }
            if (!xj) { xj = xjOptions[0].value; source = 'first'; }

            var weeks = [];
            var skippedWeeks = 0;
            for (var i = 0; i < zcOptions.length; i++) {
                if (!/^\d+$/.test(zcOptions[i].value)) continue;
                var week = parseInt(zcOptions[i].value, 10);
                if (week < 1) continue;
                if (week > 30) { skippedWeeks++; continue; }   // 载荷上限 30 周，抓了也用不上
                if (weeks.indexOf(week) < 0) weeks.push(week);
            }
            if (!weeks.length) throw new Error(LOGIN_LOST);

            return {
                xn: xn,
                xj: xj,
                xnLabel: labelOf(xnOptions, xn),
                xjLabel: labelOf(xjOptions, xj),
                source: source,
                weeks: weeks,
                skippedWeeks: skippedWeeks,
                timeSlots: parseTimeSlots(doc)
            };
        });
    }

    function weekUrl(term, week) {
        return PAGE_PATH + '?xn=' + encodeURIComponent(term.xn) +
            '&xj=' + encodeURIComponent(term.xj) + '&zc=' + week;
    }

    // 抓某一周：返回 { week, list }；list 为 null 表示这一周没拿到课表页（登录失效 / 请求失败 / 被拦）
    function crawlWeek(term, week) {
        return requestText(weekUrl(term, week)).then(function (html) {
            var doc = htmlDoc(html);
            var list = parseWeekDoc(doc);
            if (list !== null) return { week: week, list: list };
            // 是本系统的课表页却没有课表 —— 超出本学期周次范围，按这一周没课处理
            if (looksLikeCoursePage(doc)) return { week: week, list: [] };
            return { week: week, list: null };
        }, function () {
            return { week: week, list: null };
        });
    }

    var host = String(window.location.hostname || '').toLowerCase();
    if (host !== HOST) throw new Error(NOT_JW);
    if (hasPasswordInput(document)) throw new Error(ON_LOGIN);

    return loadTermPage().then(function (term) {
        var tasks = [];
        var deadline = Date.now() + CRAWL_BUDGET;
        for (var i = 0; i < term.weeks.length; i++) {
            tasks.push((function (week) {
                return function () {
                    // 预算用完的周不再发请求，按「这一周没取到」交给 parse.js 提醒
                    if (Date.now() > deadline) return Promise.resolve({ week: week, list: null, timeout: true });
                    return crawlWeek(term, week);
                };
            })(term.weeks[i]));
        }
        return runPool(tasks, CONCURRENCY).then(function (results) {
            var courses = [];
            var failedWeeks = [];
            var okWeeks = 0;
            for (var r = 0; r < results.length; r++) {
                var item = results[r];
                if (!item || item.list === null) {
                    if (item) failedWeeks.push(item.week);
                    continue;
                }
                okWeeks++;
                for (var c = 0; c < item.list.length; c++) {
                    var course = item.list[c];
                    courses.push({ week: item.week, day: course.day, name: course.name, lines: course.lines });
                }
            }
            if (!okWeeks) throw new Error(LOGIN_LOST);
            if (!courses.length) throw new Error('当前学期还没有排课：请确认教务系统里的学年学期是否正确');

            return JSON.stringify({
                now: todayIso(),
                term: {
                    xn: term.xn,
                    xj: term.xj,
                    xnLabel: term.xnLabel,
                    xjLabel: term.xjLabel,
                    source: term.source
                },
                weeks: term.weeks,
                skippedWeeks: term.skippedWeeks,
                failedWeeks: failedWeeks,
                timeSlots: term.timeSlots,
                courses: courses
            });
        });
    });
})()
