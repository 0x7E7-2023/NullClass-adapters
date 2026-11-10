(function () {
    // 北方工业大学教务适配器（正方教务 jsxsd，jwxtbk.ncut.edu.cn）—— 第一步：只取数，把课表页上的原始内容交出去。
    //
    // 移植自 shiguang_warehouse 的 NCUT/ncut_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 EnderHCO3）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 与 origin/main 对齐）
    //   本校脚本最后一次修改 1fe584c（已用 git log -1 -- resources/NCUT/ncut_01.js 核对一致）
    // 移植改动：
    //   ① ES6 降到 ES5：去掉箭头函数、块级声明、模板串、for...of、padStart 与数组的 forEach
    //   ② 只取数不拼课：周次、节次时间、开学日、总周数、合并、提醒全部挪到 parse.js（CI 里能真跑的那一段）
    //   ③ 课表文档：先在当前页找 #dv1（要求 table tbody tr 里有内容），没有就遍历同源 iframe / frame
    //      （递归、最多 8 个文档，跨域读不到的跳过），最多等 15 秒、每 300 毫秒看一次 —— 与上游一致
    //   ④ 每行首格的两个 p 原样交出（「(1, 2小节)」与整段起止「08:00-09:30」），
    //      首末两节的拆分算法在 parse.js（上游写死每节 45 分钟）
    //   ⑤ 每个 td.kb-cell 里的 .person-class 只交出课名 / 周次 / 教师 / 教室与 li 的个数；
    //      页面上其余内容（学号、姓名、班级、教学班备注等）一律不带出
    //   ⑥ 周次下拉框（#week）只交出 option 里的日期、哪一项被选中、有没有「全部」这一项，
    //      第一个日期当开学日、个数当总周数由 parse.js 算
    //   ⑦ 学年学期：页面上有 #xnm / #xqm 就读出来（正方课表页的学期下拉框），没有交空对象，
    //      由 parse.js 按开学日推算学期名（上游根本不存学期名）
    //   ⑧ 本脚本全程不联网、不写页面、不读也不存任何账号信息；登录页与别的网站直接给大白话提示
    //   ⑨ 上游「拾光」的桥调用（saveImportedCourses / savePresetTimeSlots / saveCourseConfig /
    //      notifyTaskCompletion）与 showToast、以及出错时静默吞掉，都不移植：空课由宿主保存，取不到就报出来

    var MAX_DOCS = 8;
    var MAX_WAIT_MS = 15000;
    var POLL_MS = 300;
    var SCHEDULE_HOST = 'jwxtbk.ncut.edu.cn';

    function asText(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function squash(value) {
        return asText(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // 全角括号 / 数字与各种破折号归一，页面写法五花八门，先抹平再看
    function fullWidth(source) {
        return source
            .replace(/[０-９]/g, function (ch) {
                return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
            })
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/[~～—－–−至]/g, '-');
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === SCHEDULE_HOST;
    }

    // 登录页上必然有密码框：有就说明还没登录，直接给提示，不去读它的值
    function onLoginPage() {
        var inputs;
        try { inputs = document.querySelectorAll('input[type="password"]'); } catch (e) { inputs = null; }
        return !!(inputs && inputs.length);
    }

    function hasSchedule(doc) {
        if (!doc || !doc.getElementById) return false;
        var dv;
        try { dv = doc.getElementById('dv1'); } catch (e) { dv = null; }
        if (!dv) return false;
        var tr;
        // #dv1 一般是个包着课表的外壳，个别部署直接把它写在 table 上，两种都认
        var isTable = String(dv.tagName || '').toUpperCase() === 'TABLE';
        try { tr = isTable ? dv.querySelector('tbody tr') : dv.querySelector('table tbody tr'); } catch (e) { tr = null; }
        return !!tr;
    }

    // 同源 iframe / frame 递归穿透；跨域框架取 contentDocument 会抛错，跳过
    function allDocuments() {
        var docs = [];
        function walk(doc) {
            if (!doc || docs.length >= MAX_DOCS) return;
            for (var i = 0; i < docs.length; i++) {
                if (docs[i] === doc) return;
            }
            docs.push(doc);
            var frames;
            try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
            for (var j = 0; j < frames.length; j++) {
                try {
                    if (frames[j].contentDocument) walk(frames[j].contentDocument);
                } catch (e) { /* 跨域框架读不到，跳过 */ }
            }
        }
        walk(document);
        return docs;
    }

    function scheduleDoc() {
        var docs = allDocuments();
        for (var i = 0; i < docs.length; i++) {
            if (hasSchedule(docs[i])) return docs[i];
        }
        return null;
    }

    // 读一个下拉框：跳过 value 为空的占位项，被 selected 标记的那项优先，没标记就取第一项
    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options && selectEl.querySelectorAll) options = selectEl.querySelectorAll('option');
        if (!options || !options.length) {
            var raw = squash(selectEl.value);
            return raw ? { value: raw, text: '' } : null;
        }
        var list = [];
        var picked = -1;
        var i;
        for (i = 0; i < options.length; i++) {
            var option = options[i];
            var value = squash(option.value);
            if (!value) continue;
            if (option.selected && picked < 0) picked = list.length;
            list.push({ value: value, text: squash(option.textContent) });
        }
        if (!list.length) return null;
        if (picked < 0) picked = 0;
        return { value: list[picked].value, text: list[picked].text };
    }

    function readTerm(doc) {
        if (!doc || !doc.querySelector) return null;
        var year = readSelect(doc.querySelector('#xnm'));
        var season = readSelect(doc.querySelector('#xqm'));
        if (!year && !season) return null;
        return {
            xnm: year ? year.value : '',
            xqm: season ? season.value : '',
            xnmText: year ? year.text : '',
            xqmText: season ? season.text : ''
        };
    }

    // 周次下拉框：值是每周的日期，「全部」那一项的值是 all。
    // 只交出日期清单与选中项，开学日与总周数在 parse.js 里算
    function weekInfo(doc) {
        var info = { values: [], selected: '', selectedText: '', hasAll: false };
        var el = null;
        try { el = doc.getElementById('week'); } catch (e) { el = null; }
        if (!el && doc !== document) {
            try { el = document.getElementById('week'); } catch (e) { el = null; }
        }
        if (!el) return info;
        var options = el.options;
        if (!options && el.querySelectorAll) options = el.querySelectorAll('option');
        if (!options) return info;
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var value = squash(option.value);
            if (!value) continue;
            if (value === 'all') {
                info.hasAll = true;
                if (option.selected) {
                    info.selected = 'all';
                    info.selectedText = squash(option.textContent);
                }
                continue;
            }
            info.values.push(value);
            if (option.selected && !info.selected) {
                info.selected = value;
                info.selectedText = squash(option.textContent);
            }
        }
        return info;
    }

    // 一个课程块：课名在 h3 a，周次 / 教师 / 教室依次是第 2、3、4 个 li（与上游同）
    function courseOf(block) {
        var nameEl = null;
        try { nameEl = block.querySelector('h3 a'); } catch (e) { nameEl = null; }
        var lis;
        try { lis = block.querySelectorAll('ul>li'); } catch (e) { lis = []; }
        return {
            name: nameEl ? squash(nameEl.textContent) : '',
            weeks: lis.length > 1 ? squash(lis[1].textContent) : '',
            teacher: lis.length > 2 ? squash(lis[2].textContent) : '',
            location: lis.length > 3 ? squash(lis[3].textContent) : '',
            li: lis.length
        };
    }

    // 每行：首格的节次区间与整段起止时间 + 各天的课程格（列序 1..7 就是星期）。
    // 整行没课的大节也要交出去 —— 节次时间表要靠这些行（上游 parseTimeSlots 同样是遍历全部行），
    // 只跳过完全没有节次信息、也不是课表格子的行（表头、上午 / 下午的分隔行）
    function rowsOf(doc) {
        var out = [];
        var trs;
        try { trs = doc.querySelectorAll('#dv1 tbody tr'); } catch (e) { return out; }
        for (var r = 0; r < trs.length; r++) {
            var tr = trs[r];
            var first = null;
            var last = null;
            var start = '';
            var end = '';
            var firstCell = null;
            try { firstCell = tr.querySelector('td:first-child'); } catch (e) { firstCell = null; }
            var ps = firstCell ? firstCell.querySelectorAll('p') : [];
            if (ps.length >= 2) {
                var sec = /\(([0-9]{1,2})\s*,\s*([0-9]{1,2})\s*小节\)/
                    .exec(fullWidth(squash(ps[0].textContent)));
                var span = /([0-9]{1,2}:[0-9]{2})\s*-\s*([0-9]{1,2}:[0-9]{2})/
                    .exec(fullWidth(squash(ps[1].textContent)));
                if (sec && span) {
                    first = parseInt(sec[1], 10);
                    last = parseInt(sec[2], 10);
                    start = span[1];
                    end = span[2];
                }
            }
            var cells;
            try { cells = tr.querySelectorAll('td.kb-cell'); } catch (e) { cells = []; }
            var days = [];
            for (var c = 0; c < cells.length; c++) {
                var blocks;
                try { blocks = cells[c].querySelectorAll('.person-class'); } catch (e) { blocks = []; }
                if (!blocks.length) continue;
                var list = [];
                for (var b = 0; b < blocks.length; b++) {
                    list.push(courseOf(blocks[b]));
                }
                if (list.length) days.push({ day: c + 1, courses: list });
            }
            if (first === null && !days.length) continue;
            out.push({ first: first, last: last, start: start, end: end, days: days });
        }
        return out;
    }

    function buildPayload(doc) {
        var rows = rowsOf(doc);
        if (!rows.length) {
            throw new Error(
                '课表页上没有读到课程：可能这个学期还没排课，也可能课表还没显示出来。' +
                '请刷新课表页，确认能看到课表后再点「提取课表」'
            );
        }
        return JSON.stringify({
            term: readTerm(doc) || readTerm(document) || {},
            today: localTodayIso(),
            week: weekInfo(doc),
            rows: rows
        });
    }

    function waitForDoc() {
        return new Promise(function (resolve, reject) {
            var started = new Date().getTime();
            function check() {
                var doc = scheduleDoc();
                if (doc) {
                    resolve(doc);
                    return;
                }
                if (new Date().getTime() - started > MAX_WAIT_MS) {
                    reject(new Error(
                        '没找到课表：请确认已经登录教务系统，打开「我的课表」并能看到课表后，再点「提取课表」'
                    ));
                    return;
                }
                setTimeout(check, POLL_MS);
            }
            check();
        });
    }

    if (!onJwHost()) {
        throw new Error(
            '当前页面还不是北方工业大学的教务系统。请先登录教务系统，打开「我的课表」后再点「提取课表」'
        );
    }
    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，打开「我的课表」后再点「提取课表」'
        );
    }

    return waitForDoc().then(function (doc) {
        return buildPayload(doc);
    });
})()
