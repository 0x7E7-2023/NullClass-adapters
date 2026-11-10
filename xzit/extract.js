(function () {
    // 徐州工程学院教务适配器（正方 jwglxt，课表查询页的网格视图与列表视图）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 XZIT/xzit_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 盐泡）
    //   上游快照 baf83fa（2026-11-10 拉取）
    //   本校脚本最后一次修改 1fe584c
    // 移植改动：
    //   ① ES6 → ES5；去掉 jQuery 依赖：上游用 window.jQuery 的选择器读表格，缺了就报错；
    //      这里把当前页面的 HTML 交给 DOMParser，再用同样的选择器（#shcPDF、#kbgrid_table_0、
    //      #kblist_table、.td_wrap、.timetable_con.text-left、.title font、p font）读同样的内容。
    //      不依赖页面有没有加载 jQuery，也不改页面
    //   ② 上游 fetch(window.location.href) 再取一遍同一个页面；这里直接用当前页面的 HTML，不发任何请求
    //   ③ 只取数：每个课程块交出一行（课名 / 教师 / 教室 / 星期 / 节次 / 周次），外加课表页上的学年学期；
    //      周次解析、单双周、合并、节次时间、开学日、总周数全部挪到 parse.js
    //   ④ 上游要求课名、教师、教室、节次、周次全都有才收这一行，缺一样就整行丢掉；这里照原样交出去，
    //      由 parse.js 决定是否导入并把缺的东西汇总写进提醒（不静默丢课）
    //   ⑤ 上游格子里 p 的顺序是「(1-2节)1-16周 / 教室 / 教师」；这里照读，教室取空白分隔的最后一段
    //   ⑥ 不带出任何学生信息：只读课程块与学年学期下拉框，页面里别的东西（学号、姓名等）一个都不读、不交
    //
    // 取数方式：只读当前页面，零请求。停在登录页 / 统一认证页 / 非课表页时直接报错，不发请求。
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JW_HOST = 'jwglxt.xzit.edu.cn';
    var MARKS = /[●★○]/g;

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === JW_HOST;
    }

    function onLoginPage() {
        return String(window.location.pathname || '').indexOf('login_slogin.html') >= 0;
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
    }

    function hasClass(el, name) {
        return (' ' + String(el.className || '') + ' ').indexOf(' ' + name + ' ') >= 0;
    }

    function fontsOf(el) {
        return el ? el.querySelectorAll('font') : [];
    }

    // 读一个学年学期下拉框：跳过 value 为空的占位项，被 selected 标记的那项优先，没标记就取第一项
    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options && selectEl.querySelectorAll) options = selectEl.querySelectorAll('option');
        if (!options || !options.length) {
            var raw = String(selectEl.value === null || selectEl.value === undefined ? '' : selectEl.value)
                .replace(/\s+/g, '');
            return raw ? { value: raw, text: '' } : null;
        }
        var list = [];
        var picked = -1;
        var i;
        for (i = 0; i < options.length; i++) {
            var option = options[i];
            var value = String(option.value === null || option.value === undefined ? '' : option.value)
                .replace(/\s+/g, '');
            if (!value) continue;
            var label = textOf(option.textContent);
            if (option.selected && picked < 0) picked = list.length;
            list.push({ value: value, text: label });
        }
        if (!list.length) return null;
        if (picked < 0) picked = 0;
        return { value: list[picked].value, text: list[picked].text };
    }

    function readTermFromDoc(doc) {
        var year = readSelect(doc.querySelector('#xnm'));
        var season = readSelect(doc.querySelector('#xqm'));
        if (!year || !season) return {};
        return { xnm: year.value, xqm: season.value, xnmText: year.text, xqmText: season.text };
    }

    // 上课地点 / 教师前面带的标签（"周数：1-16周" / "上课地点：教1-101" / "教师 ：张三"）
    function stripLabels(value) {
        return textOf(value)
            .replace(/周数\s*[:：]/g, '')
            .replace(/上课地点\s*[:：]/g, '')
            .replace(/教师\s*[:：]/g, '');
    }

    // 空白分隔的最后一段（上游 position.split(/\s+/).pop()）
    function lastToken(value) {
        var parts = textOf(value).split(/\s+/);
        return parts[parts.length - 1] || '';
    }

    // 网格视图：.td_wrap 的 id 是「<星期>-<节次槽>」，格子里每个 .timetable_con 是一门课
    function parseGrid(doc) {
        var out = [];
        var cells = doc.querySelectorAll('#kbgrid_table_0 td');
        for (var i = 0; i < cells.length; i++) {
            var td = cells[i];
            if (!hasClass(td, 'td_wrap')) continue;
            if (!textOf(td.textContent)) continue;
            var day = String(td.getAttribute('id') || '').split('-')[0];
            var blocks = td.querySelectorAll('.timetable_con.text-left');
            for (var b = 0; b < blocks.length; b++) {
                out.push(gridRow(blocks[b], day));
            }
        }
        return out;
    }

    function gridRow(block, day) {
        var nameEl = block.querySelector('.title font');
        var name = textOf(nameEl ? nameEl.textContent : '').replace(MARKS, '').trim();
        var ps = block.querySelectorAll('p');
        var info = '';
        if (ps.length) {
            var firstFonts = fontsOf(ps[0]);
            // 上游取第 1 个 p 的第 2 个 font（第 1 个是星期几）
            if (firstFonts.length > 1) info = textOf(firstFonts[1].textContent);
        }
        var position = ps.length > 1 ? textOf(ps[1].textContent) : '';
        var teacher = ps.length > 2 ? textOf(ps[2].textContent) : '';
        var sections = '';
        var weeks = '';
        var matched = /\(([0-9]+-[0-9]+)节\)/.exec(info);
        if (matched && info.split('节)')[1]) {
            sections = matched[1];
            weeks = textOf(info.split('节)')[1]);
        }
        return {
            kcmc: name,
            xm: teacher,
            cdmc: lastToken(position),
            xqj: day,
            jcs: sections,
            zcd: weeks
        };
    }

    // 列表视图：#kblist_table 的 tbody 序号 1..7 = 星期；一门课占多行时，续行没有第一个节次格子，
    // 节次沿用同一 tbody 里上一行的（上游也是这么读的）
    function parseList(doc) {
        var out = [];
        var bodies = doc.querySelectorAll('#kblist_table tbody');
        for (var day = 1; day <= 7 && day < bodies.length; day++) {
            var carry = '';
            var trs = bodies[day].querySelectorAll('tr');
            for (var t = 1; t < trs.length; t++) {
                var tds = trs[t].querySelectorAll('td');
                if (!tds.length) continue;
                var cell;
                if (tds.length > 1) {
                    carry = textOf(tds[0].textContent);
                    cell = tds[1];
                } else {
                    cell = tds[0];
                }
                var nameEl = cell.querySelector('.title');
                var name = textOf(nameEl ? nameEl.textContent : '').replace(MARKS, '').trim();
                var fonts = cell.querySelectorAll('p font');
                var weeks = fonts.length > 0 ? stripLabels(fonts[0].textContent) : '';
                var position = fonts.length > 1 ? stripLabels(fonts[1].textContent) : '';
                var teacher = fonts.length > 2 ? stripLabels(fonts[2].textContent) : '';
                var row = {
                    kcmc: name,
                    xm: teacher,
                    cdmc: lastToken(position),
                    xqj: String(day),
                    jcs: carry,
                    zcd: weeks
                };
                if (!row.kcmc && !row.xm && !row.cdmc && !row.jcs && !row.zcd) continue;
                out.push(row);
            }
        }
        return out;
    }

    if (!onJwHost()) {
        throw new Error(
            '当前页面还不是教务系统。请先登录教务系统，打开「信息查询 - 学生课表查询」，' +
            '选好学年学期点「查询」，看到课表后再点「提取课表」'
        );
    }
    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」并点「查询」，然后点「提取课表」'
        );
    }
    if (typeof DOMParser === 'undefined') {
        throw new Error('这个页面读不出课表内容，请刷新后重新点「提取课表」');
    }

    var html = document.documentElement ? String(document.documentElement.outerHTML || '') : '';
    if (html.indexOf('课表查询') < 0) {
        throw new Error(
            '当前页面不是学生课表查询页。请先打开「信息查询 - 学生课表查询」，' +
            '选好学年学期点「查询」，看到课表后再点「提取课表」'
        );
    }

    var doc = new DOMParser().parseFromString(html, 'text/html');
    var typeEl = doc.querySelector('#shcPDF');
    if (!typeEl) {
        throw new Error('没认出课表的显示方式。请确认已经点过「查询」、课表已经显示出来，再点「提取课表」');
    }
    var isList = textOf(typeEl.getAttribute('data-type')) === 'list';
    if (!doc.querySelector(isList ? '#kblist_table' : '#kbgrid_table_0')) {
        throw new Error(
            '页面上没找到课表内容（' + (isList ? '列表' : '网格') +
            '显示方式）。请确认已经点过「查询」、课表已经显示出来，再点「提取课表」'
        );
    }

    var rows = isList ? parseList(doc) : parseGrid(doc);
    // 学年学期先读当前页面（用户刚切过学期时下拉框的实时选中态最准），读不到再看解析出来的副本
    var termInfo = readTermFromDoc(document);
    if (!termInfo.xnm) termInfo = readTermFromDoc(doc);

    return JSON.stringify({
        term: termInfo,
        today: localTodayIso(),
        raw: { kbList: rows }
    });
})()
