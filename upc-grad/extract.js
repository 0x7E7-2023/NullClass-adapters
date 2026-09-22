(function () {
    // 中国石油大学（华东）研究生综合管理系统教务适配器（ASP.NET WebForms ·
    // /Gstudent/Course/StuCourseQuery.aspx）—— 第一步：取数。
    //
    // 移植自 shiguang_warehouse 的 UPC/upc_graduate.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //
    // 上游取数方式：整张课表已经渲染在当前页面的
    // <table id="ctl00_contentParent_dgData"> 里，格子文本用全角「｛｝」把
    // 课名/周次/教师/地点编码进去（例如「高等数学A｛1-16周[教师:张伟,地点:南教101]｝」），
    // 不需要任何接口请求；只有「开学日期 + 总周数」需要向教学日历页
    // /PublicPage/TermCalender.aspx 额外发一次同源请求（EID 从页面上「教学日历」
    // 链接的 onclick 属性里取）。
    //
    // 移植改动：
    //   ① 不再弹窗确认「已登录并打开课表页」——找不到课表表格时直接明确报错。
    //   ② 格子文本本身已经是最终编码（不是靠 HTML/font 结构），课名/周次/教师/地点
    //      的解释全部留给 parse.js —— 这里只把每个格子的原始文本连同星期/节次交出去，
    //      那边 CI 能用 Rhino 真跑（extract.js 需要浏览器，CI 永远跑不到）。
    //   ③ 教学日历页的日期网格也只交原始的「日(月)」结构，年份推算、开学日、
    //      总周数的计算放到 parse.js。
    //   ④ 不再向 shiguangBridge 保存作息时间——12 节的默认作息表直接写进 parse.js
    //      （与本科版 upc/parse.js 用的是同一张表，教务处公布的全校统一作息）。
    //
    // 只读当前页面与教学日历页（同源相对路径）：不碰账号密码、不外发任何数据、
    // 不写页面。审计见同目录 AUDIT.md。
    var TABLE_ID = 'ctl00_contentParent_dgData';
    var CAL_PATH_PREFIX = '/PublicPage/TermCalender.aspx?EID=';
    var LOGIN_HINT = '请先登录研究生综合管理系统，并打开「学期课表查询」页面后再点「提取课表」';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期，不能用 UTC：北京时间早上 8 点前 toISOString 会退到前一天）。
    // 只用于教学日历拿不到开学日期时推算「最近的周一」——见 parse.js。
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    // 当前页 + 同源 iframe（跨域 iframe 读不到 contentDocument，跳过）。
    function collectDocs() {
        var docs = [document];
        var frames = document.getElementsByTagName('iframe');
        for (var i = 0; i < frames.length; i++) {
            try {
                var fd = frames[i].contentDocument;
                if (fd && fd.getElementById) docs.push(fd);
            } catch (e) {
                // 跨域 iframe，跳过。
            }
        }
        return docs;
    }

    function findById(docs, id) {
        for (var i = 0; i < docs.length; i++) {
            var el = docs[i].getElementById(id);
            if (el) return el;
        }
        return null;
    }

    // 0=星期日..6=星期六 → 拾光 day（1=周一…7=周日，与上游注释「1 表示星期一，
    // 7 表示星期日」同一套编码，parse.js 直接沿用，不用再转换）。
    var DAY_BY_OFFSET = [7, 1, 2, 3, 4, 5, 6];

    // 课表表格：每行「节次号 td」之后的 7 个 td 依次是 星期日…星期六；
    // 「上午/下午/晚上」是 rowspan 合并单元格，只在每大节首行出现，所以节次号列
    // 不能固定列索引，要在每一行里动态找「纯数字 1~12」的那个 td（与上游
    // parseCourseTableFromDom 的做法一致）。
    function cellsOfTable(table) {
        var out = [];
        var trs = table.getElementsByTagName('tr');
        for (var r = 0; r < trs.length; r++) {
            var tds = trs[r].getElementsByTagName('td');
            var secIndex = -1;
            var startSection = 0;
            for (var i = 0; i < tds.length; i++) {
                var text = clean(tds[i].textContent);
                var n = Number(text);
                if (n >= 1 && n <= 12 && String(n) === text) {
                    secIndex = i;
                    startSection = n;
                    break;
                }
            }
            if (secIndex === -1) continue;
            for (var off = 0; off < 7; off++) {
                var td = tds[secIndex + 1 + off];
                if (!td) continue;
                var cellText = clean(td.textContent);
                if (!cellText || cellText.indexOf('｛') === -1) continue;
                var rowspan = Number(td.getAttribute('rowspan')) || 1;
                out.push({
                    day: DAY_BY_OFFSET[off],
                    startSection: startSection,
                    endSection: startSection + rowspan - 1,
                    text: cellText
                });
            }
        }
        return out;
    }

    // 教学日历：table 里每行一个周次，cells[0]=周次号，cells[1..7]=星期日…星期六，
    // 每格形如「5(9月)」。只交原始的 {day,month} 网格（数组下标 0..6 对应
    // 星期日…星期六），年份推算 / 开学日 / 总周数的计算留给 parse.js。
    function calendarRowsOfTable(table) {
        var out = [];
        var trs = table.getElementsByTagName('tr');
        for (var r = 0; r < trs.length; r++) {
            var tds = trs[r].getElementsByTagName('td');
            if (tds.length < 8) continue;
            var row = [null, null, null, null, null, null, null];
            var any = false;
            for (var i = 1; i <= 7; i++) {
                var m = /(\d+)\s*\((\d+)月\)/.exec(clean(tds[i].textContent));
                if (m) {
                    row[i - 1] = { day: Number(m[1]), month: Number(m[2]) };
                    any = true;
                }
            }
            if (any) out.push(row);
        }
        return out;
    }

    // 教学日历链接：上游认 #hykTermCalender，兜底认 onclick 里带
    // TermCalender.aspx 的 <a>；从 onclick 里取 EID 参数。
    function findCalendarEid(docs) {
        for (var i = 0; i < docs.length; i++) {
            var doc = docs[i];
            var link = doc.getElementById('hykTermCalender');
            if (!link && doc.querySelectorAll) {
                var candidates = doc.querySelectorAll("a[onclick*='TermCalender.aspx']");
                if (candidates.length) link = candidates[0];
            }
            if (!link) continue;
            var onclick = link.getAttribute('onclick') || '';
            var m = /TermCalender\.aspx\?EID=([^&'"]+)/.exec(onclick);
            if (m) return m[1];
        }
        return null;
    }

    function fetchCalendar(eid) {
        var url = CAL_PATH_PREFIX + encodeURIComponent(eid) + '&UID=';
        return fetch(url, { credentials: 'same-origin' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text();
        }, function () {
            return null; // 教学日历拿不到只影响开学日/总周数的推算精度，不阻断导入。
        }).then(function (html) {
            if (!html) return null;
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var table = doc.getElementById(TABLE_ID);
            if (!table) return null;
            var rows = calendarRowsOfTable(table);
            return rows.length ? { rows: rows } : null;
        });
    }

    // 页面标题里的学期名候选（例如「2026-2027学年第一学期学生课表查询」），
    // 只做一次正则匹配，匹配不到就是 null——不读页面其它内容。
    function termHintOf(doc) {
        var m = /(20\d{2})\s*-\s*(20\d{2})\s*学年\s*第?\s*([一二三123])\s*学期/.exec(clean(doc.title));
        return m ? m[0] : null;
    }

    var docs = collectDocs();
    var table = findById(docs, TABLE_ID);
    if (!table) {
        throw new Error('未找到课表表格（' + TABLE_ID + '），' + LOGIN_HINT);
    }
    var cells = cellsOfTable(table);
    if (cells.length === 0) {
        throw new Error('课表中未解析到有效课程，请确认当前学期有排课。');
    }

    var eid = findCalendarEid(docs);
    var now = todayIso();
    var termHint = termHintOf(document);

    if (!eid) {
        return JSON.stringify({ now: now, termHint: termHint, cells: cells, calendar: null });
    }
    return fetchCalendar(eid).then(function (calendar) {
        return JSON.stringify({ now: now, termHint: termHint, cells: cells, calendar: calendar });
    });
})()
