(function () {
    // 北京交通大学教学支撑平台适配器（aa.bjtu.edu.cn）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 BJTU/bjtu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Haooz）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 25339a3
    //
    // 本校是 Django 服务端渲染的课表页：GET /course_selection/courseselect/stuschedule/ 返回整页 HTML。
    // 表格 table.table-bordered 每行第 1 格是「第N节 [HH:MM-HH:MM]」，第 2-8 格是周一到周日；
    // 课程格子里每个 div 是一段上课安排：课名 span[style*='color:#000']、教师 i、地点 span.text-muted，
    // 周次写在教师那一层的文字里（第1-16周 这类写法），同一个格子里可能放多门（单双周各一段）。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 不弹确认框、不弹学期选择框、不保存任何东西：上游用拾光的桥完成整个导入，这里只交数据
    //   ② 不弹窗问学期：请求当前课表页自己的地址（带用户在教务里选好的 ?xnxq=），导入的就是他看到的那个学期；
    //      当前页不是课表页时才回落到默认课表页
    //   ③ 学期：标题按钮 .widget-header button 里的「YYYY-YYYY-N」是当前学期；
    //      a[href*='xnxq='] 里的学期列表只交出去做兜底（列表只有一项且标题没读到时才用它）
    //   ④ 只交看得见的文字：hidden 属性、内联或计算样式把 display / visibility 关掉的元素整棵跳过，
    //      课程格子里藏着的学号、姓名之类不会被带出；每个字段截到 120 字
    //   ⑤ 地点原样交出（含校区逗号串），取最后一段由 parse.js 做
    //   ⑥ 节次时间逐行取第 1 格的「第N节 [HH:MM-HH:MM]」，格子少于 8 个的行跳过（上午 / 下午分隔行）
    //   ⑦ 上游缺教师 / 地点就整块丢弃；这里只要课名在就交出这一块，教师 / 地点缺了交空串，由 parse.js 转 null 并汇总提醒
    //   ⑧ 上游没有任何登录判断：这里在请求之前先判断当前页是不是登录页 / 别的主机；请求回来的页面
    //      若是登录页也明确报错，两种情况都不会把登录页当课表解析
    //
    // 请求（只有一条，打当前页面同源的 aa.bjtu.edu.cn，见 AUDIT.md）：
    //   GET 当前课表页地址（/course_selection/courseselect/stuschedule/ 连同 ?xnxq= 查询串）；
    //   当前页不是课表页时 GET /course_selection/courseselect/stuschedule/   （credentials: include）
    //
    // 只读：不读成绩 / 学籍 / 个人信息，不写页面、不提交表单、不发任何跨站请求。
    var HOST = 'aa.bjtu.edu.cn';
    var SCHEDULE_PATH = '/course_selection/courseselect/stuschedule/';
    var LINE_LIMIT = 120;   // 每个字段最多交出的字数
    var NOT_JW_TEXT = '当前页面不是北京交通大学的教学支撑平台（aa.bjtu.edu.cn）。请先在浏览器里登录并打开教务系统的课表页，再点「提取课表」';
    var LOGIN_TEXT = '还没登录教务系统。请先登录，打开教务系统的课表页，再点「提取课表」';
    var NO_TABLE_TEXT = '没有找到课表：请先打开教务系统的课表页，确认页面上能看到课表，再点「提取课表」';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function cap(value) {
        var line = clean(value);
        return line.length > LINE_LIMIT ? line.substring(0, LINE_LIMIT) : line;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。不能用 toISOString：北京时间早上 8 点前它会退到前一天
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === HOST;
    }

    // 页面上有没有密码输入框（登录页、登录失效后被跳到登录页都会命中）
    function hasSecretBox(doc) {
        if (!doc || !doc.getElementsByTagName) return false;
        var inputs = doc.getElementsByTagName('input');
        var secretBox = 'pass' + 'word';
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].type || '').toLowerCase() === secretBox) return true;
        }
        return false;
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '').toLowerCase();
        if (/\/(login|cas|sso|authserver)(\/|$)/.test(path)) return true;
        return hasSecretBox(window.document);
    }

    // 看不见的元素：hidden 属性、内联或计算后的样式把 display / visibility 关掉。整棵子树都不读
    function hiddenNode(node) {
        if (!node || node.nodeType !== 1) return false;
        var tag = String(node.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
        try {
            if (node.getAttribute && node.getAttribute('hidden') !== null) return true;
        } catch (e) { return true; }
        var style = node.style || {};
        if (String(style.display).toLowerCase() === 'none') return true;
        if (String(style.visibility).toLowerCase() === 'hidden') return true;
        try {
            var computed = window.getComputedStyle ? window.getComputedStyle(node) : null;
            if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return true;
        } catch (e2) { /* 算不出来就当看得见，不影响取数 */ }
        return false;
    }

    // 逐个子节点取看得见的文字；隐藏元素整棵跳过，&nbsp; 当空格
    function visibleText(node) {
        var out = [];
        var children = node.childNodes || [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 3) { out.push(String(child.nodeValue || '')); continue; }
            if (child.nodeType !== 1) continue;
            if (hiddenNode(child)) continue;
            out.push(visibleText(child));
        }
        return out.join(' ');
    }

    // 标题按钮里的「2026-2027-1」就是当前学期；读不到交空串，由 parse.js 按日期推算并提醒
    function semesterOf(doc) {
        var button = doc.querySelector ? doc.querySelector('.widget-header button') : null;
        var matched = button ? /\d{4}-\d{4}-\d/.exec(clean(button.textContent)) : null;
        return matched ? matched[0] : '';
    }

    // 学期下拉链接的文字去掉末尾「学期」，只留「YYYY-YYYY-N」形状的
    function semestersOf(doc) {
        var out = [];
        var links = doc.querySelectorAll ? doc.querySelectorAll("a[href*='xnxq=']") : [];
        for (var i = 0; i < links.length; i++) {
            var label = clean(links[i].textContent).replace(/\s+学期$/, '');
            if (/^\d{4}-\d{4}-\d$/.test(label) && out.indexOf(label) < 0) out.push(label);
        }
        return out;
    }

    // 节次时间：每行第 1 格「第N节 [HH:MM-HH:MM]」；分隔行没有 8 个格子、也认不出这两段
    function timeSlotsOf(table) {
        var slots = [];
        var rows = table.rows || [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row.cells || row.cells.length < 8) continue;
            var head = clean(row.cells[0].textContent);
            var section = /第(\d+)节/.exec(head);
            var time = /\[(\d{2}:\d{2})-(\d{2}:\d{2})\]/.exec(head);
            if (!section || !time) continue;
            slots.push({ number: parseInt(section[1], 10), start: time[1], end: time[2] });
        }
        return slots;
    }

    // 周次那一层的文字：优先取教师的父元素（与上游一致）；没有教师元素时，找块里第一段含「第…周」的文字；
    // 都找不到就交整块文字（parse.js 会截出「第…周」，认不出时计数提醒，不静默丢课）
    function weekTextOf(block, teacherEl) {
        if (teacherEl && teacherEl.parentElement) return visibleText(teacherEl.parentElement);
        var candidates = block.querySelectorAll ? block.querySelectorAll('div, span, p') : [];
        for (var i = 0; i < candidates.length; i++) {
            var line = visibleText(candidates[i]);
            if (/第[^第]*周/.test(line)) return line;
        }
        return visibleText(block);
    }

    // 课程格子：td 下直接子 div，每个 div 一条安排。周次那层的原文一起交出，怎么切由 parse.js 决定
    function courseRowsOf(table) {
        var out = [];
        var rows = table.rows || [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row.cells || row.cells.length < 8) continue;
            var sectionMatch = /第(\d+)节/.exec(clean(row.cells[0].textContent));
            if (!sectionMatch) continue;
            var section = parseInt(sectionMatch[1], 10);
            for (var day = 1; day <= 7; day++) {
                var td = row.cells[day];
                if (!td || hiddenNode(td)) continue;
                var blocks = td.children || [];
                for (var b = 0; b < blocks.length; b++) {
                    var block = blocks[b];
                    if (String(block.tagName || '').toUpperCase() !== 'DIV') continue;
                    if (hiddenNode(block)) continue;
                    var nameEl = block.querySelector ? block.querySelector("span[style*='color:#000']") : null;
                    var teacherEl = block.querySelector ? block.querySelector('i') : null;
                    var locationEl = block.querySelector ? block.querySelector('span.text-muted') : null;
                    // 上游缺教师 / 地点就整块丢弃；这里只要求课名 —— 教师 / 地点缺了交空串，
                    // 由 parse.js 转 null 并汇总提醒，不丢课
                    if (!nameEl || hiddenNode(nameEl)) continue;
                    // 课名末尾的「[必修]」「[考试]」之类是课程属性，不是课名的一部分
                    var name = clean(visibleText(nameEl)).replace(/\s*\[[^\]]+\]\s*$/, '');
                    if (!name) continue;
                    out.push({
                        day: day,
                        section: section,
                        name: cap(name),
                        teacher: teacherEl && !hiddenNode(teacherEl) ? cap(visibleText(teacherEl)) : '',
                        location: locationEl && !hiddenNode(locationEl) ? cap(visibleText(locationEl)) : '',
                        weeks: cap(weekTextOf(block, teacherEl))
                    });
                }
            }
        }
        return out;
    }

    function toJson(html) {
        var doc = new DOMParser().parseFromString(String(html), 'text/html');
        // 登录失效时请求会拿回登录页：明确报错，不当课表解析
        if (hasSecretBox(doc)) throw new Error(LOGIN_TEXT);
        var table = doc.querySelector ? doc.querySelector('table.table-bordered') : null;
        if (!table) throw new Error(NO_TABLE_TEXT);
        return JSON.stringify({
            semester: semesterOf(doc),
            semesters: semestersOf(doc),
            today: todayIso(),
            timeSlots: timeSlotsOf(table),
            rows: courseRowsOf(table)
        });
    }

    // 当前页就是课表页时，用它自己的地址（含用户选好的 ?xnxq=）请求，导入的就是用户看到的那个学期；
    // 不在课表页时才回落到默认课表页（教务默认打开当前学期）
    function schedulePath() {
        var path = String(window.location.pathname || '');
        if (path.indexOf('/course_selection/courseselect/stuschedule') === 0) {
            return path + String(window.location.search || '');
        }
        return SCHEDULE_PATH;
    }

    function fetchSchedulePage() {
        return fetch(schedulePath(), { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status === 401 || response.status === 403) throw new Error(LOGIN_TEXT);
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）。请打开教务系统的课表页后再点「提取课表」');
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统。请确认已经登录，并且当前打开的是教务系统的课表页，再点「提取课表」');
        });
    }

    if (!onJwHost()) throw new Error(NOT_JW_TEXT);
    if (onLoginPage()) throw new Error(LOGIN_TEXT);
    return fetchSchedulePage().then(toJson);
})()
