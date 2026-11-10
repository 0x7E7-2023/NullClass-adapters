(function () {
    // 湖北民族大学教务系统适配器（jwgl.hbmzu.edu.cn/edu）—— 第一步：只取数，把教务页面上的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 HBMZU/hbmzu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Haooz）
    //   上游快照 baf83fa7972d4be6627c534992f7d2da399a0945（2026-11-10 拉取）
    //   本校脚本最后一次修改 77e9b23
    //
    // 本校是自研 MVC 教务：
    //   ① 理论课表：/edu/report/mySchedule.mvc 服务端渲染，页面里 #container 内每行 tr 的首个 td 是节次
    //      （「上午1-2节」「晚上11-12节」…），后面 7 个 td 对应周一~周日；每格 .course-block 里有几个 span。
    //      页面可能在 frameset / iframe 里，按上游 collectDocs 的思路收集同源文档。
    //   ② 实验课表：先 GET /edu/report/myLabSchedule.mvc 读页面里的学号 / 学年 / 学期（学号只用来拼本校同源
    //      地址，绝不交出去），再按周 GET /edu/report/stuLabCourseTable/{学号}/{学年}/{学期}/{周}.mvc。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 不弹确认框、不弹提示条、不保存任何东西：上游用拾光的 showAlert / showToast / saveImportedCourses /
    //      savePresetTimeSlots 完成整个导入；空课由宿主保存，这里只交数据
    //   ② 不判断哪个 span 是教室 / 周次 / 教师，不解析周次、不拼课程、不去重、不合并：这些全部放在 parse.js
    //      （CI 只能跑 parse.js）。这里按格子搬出「星期 + 节次原文 + 各 span 原文」
    //   ③ 学生个人信息（学号、姓名、身份证号、手机号）不进输出：理论格子只读看得见的 span 文字，
    //      隐藏元素整棵跳过；实验数据只按字段白名单挑课程名 / 教师 / 教室 / 星期 / 节次 / 周次
    //   ④ 上游用块级声明与箭头函数，这里全部改成 ES5；分批并发的写法保留（Promise 可用）
    //   ⑤ 上游读取实验入口失败、某一周失败都只弹一句提示；这里改成结构化交出去（labStatus / labWeeks 的
    //      ok 标记），由 parse.js 汇总进 warnings，理论课表照常导入
    //   ⑥ 上游没有任何登录页判断：这里在发任何读操作之前，先判断当前页是不是登录页 / 门户页 / 别的网站，
    //      给出大白话提示（这几种情况都不发请求）
    //   ⑦ 实验入口页里的学号只在内存里存在，不写进输出、不写进报错
    //
    // 输出（JSON 字符串）：
    //   { today, term: { year, semester } | null, rows: [...], labStatus, labWeeks: [...] }
    //   rows[] —— 理论课表格子：day 1..7、section 节次原文、spans 该格内看得见的 span 文字（最多 120 字）
    //   labStatus —— ok / no-entry / first-week-failed
    //   labWeeks[] —— 实验课表每周：{ week, ok, lessons: [{name, teacher, location, day, start, period, week}] }
    var HOST = 'jwgl.hbmzu.edu.cn';
    var DEFAULT_LAB_WEEKS = 20;
    var MAX_LAB_WEEKS = 30;
    var MAX_FETCH_BATCH = 5;
    var TEXT_LIMIT = 120;
    var LOGIN_TEXT = '当前打开的是登录页或门户页。请先登录教务系统，再打开「理论课表」查询页面，然后点「提取课表」';
    var NOT_JW_TEXT = '当前页面不是湖北民族大学的教务系统（jwgl.hbmzu.edu.cn）。请先登录，再打开「理论课表」查询页面，然后点「提取课表」';
    var NO_TABLE_TEXT = '没有找到课表：请先打开「理论课表」查询页面，确认页面上能看到课表，再点「提取课表」';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function clip(value) {
        var line = clean(value);
        return line.length > TEXT_LIMIT ? line.substring(0, TEXT_LIMIT) : line;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。不用 toISOString：北京时间早上 8 点前它会退到前一天
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function onJwHost() {
        return String(window.location.hostname || '').toLowerCase() === HOST;
    }

    // 根路径与 /edu、/edu/ 是登录 / 门户入口；路径里含 login / cas / auth 的也当登录页
    function onLoginPage() {
        var path = String(window.location.pathname || '');
        var lower = path.toLowerCase();
        if (path === '/' || path === '' || path === '/edu' || path === '/edu/') return true;
        if (lower.indexOf('login') >= 0 || lower.indexOf('cas') >= 0 || lower.indexOf('auth') >= 0) return true;
        return false;
    }

    // 同源的帧才读得到；跨域读 contentDocument 会抛异常，捕掉
    function frameDoc(frame) {
        try {
            if (frame.contentDocument) return frame.contentDocument;
            return frame.contentWindow ? frame.contentWindow.document : null;
        } catch (e) {
            return null;
        }
    }

    // 收集当前文档与同源帧（含一层嵌套），与上游 collectDocs 同思路，多支持 <frame>
    function collectDocs(doc, out, depth) {
        if (!doc || depth > 1) return out;
        out.push(doc);
        var frames;
        try {
            frames = doc.querySelectorAll ? doc.querySelectorAll('iframe, frame') : [];
        } catch (e) {
            frames = [];
        }
        for (var i = 0; i < frames.length; i++) {
            var inner = frameDoc(frames[i]);
            if (inner) collectDocs(inner, out, depth + 1);
        }
        return out;
    }

    function containerIn(doc, needBlocks) {
        try {
            if (!doc || !doc.getElementById) return null;
            var node = doc.getElementById('container');
            if (!node) return null;
            if (needBlocks && !node.querySelector('.course-block')) return null;
            return node;
        } catch (e) {
            return null;
        }
    }

    function wait(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    // 上游轮询等待 frame 就绪（最长 6 秒）。这里超时后再找一次不带课块的 #container：
    // 空课表也能给 parse.js 报「没有解析到任何课程」，而不是含糊地说没找到页面
    function findContainer() {
        var deadline = (new Date()).getTime() + 6000;
        function attempt() {
            var docs = collectDocs(window.document, [], 0);
            for (var i = 0; i < docs.length; i++) {
                var found = containerIn(docs[i], true);
                if (found) return found;
            }
            return null;
        }
        function loop() {
            var found = attempt();
            if (found) return Promise.resolve(found);
            if ((new Date()).getTime() >= deadline) {
                var docs = collectDocs(window.document, [], 0);
                for (var i = 0; i < docs.length; i++) {
                    var bare = containerIn(docs[i], false);
                    if (bare) return Promise.resolve(bare);
                }
                return Promise.resolve(null);
            }
            return wait(300).then(loop);
        }
        return loop();
    }

    // 看不见的元素：hidden 属性、内联样式或计算后的样式把 display / visibility 关掉。整棵子树都不读
    function hiddenNode(node) {
        var tag = String(node.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
        try {
            if (node.getAttribute && node.getAttribute('hidden') !== null) return true;
        } catch (e) {
            return true;
        }
        try {
            var style = node.style || {};
            if (String(style.display).toLowerCase() === 'none') return true;
            if (String(style.visibility).toLowerCase() === 'hidden') return true;
            var computed = window.getComputedStyle ? window.getComputedStyle(node) : null;
            if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return true;
        } catch (e) {
            // 算不出来就当看得见，不影响取数
        }
        return false;
    }

    // 自己或任何一层祖先被隐藏 / 根本没渲染出来（祖先 display:none 时 getClientRects 为空）
    function hiddenWithAncestors(node) {
        var cur = node;
        while (cur && cur.nodeType === 1) {
            if (hiddenNode(cur)) return true;
            cur = cur.parentNode;
        }
        try {
            if (node.getClientRects && node.getClientRects().length === 0) return true;
        } catch (e) {
            // 量不出来就当看得见
        }
        return false;
    }

    // 逐个子节点取看得见的文字：<br> 当空格，隐藏元素整棵跳过
    function visibleText(node, out) {
        var children = node.childNodes || [];
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 3) {
                out.push(String(child.nodeValue || ''));
                continue;
            }
            if (child.nodeType !== 1) continue;
            if (String(child.tagName || '').toUpperCase() === 'BR') {
                out.push(' ');
                continue;
            }
            if (hiddenNode(child)) continue;
            visibleText(child, out);
        }
        return out;
    }

    // 理论课表格子里的 span 文字。隐藏的 span 整棵跳过（格子里藏的学号 / 姓名不会被带出）
    function spansOf(block) {
        var spans = [];
        var nodes;
        try {
            nodes = block.querySelectorAll('span');
        } catch (e) {
            return spans;
        }
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (hiddenWithAncestors(node)) continue;
            var line = clip(visibleText(node, []).join(''));
            if (line) spans.push(line);
        }
        return spans;
    }

    // 每行首 td 是节次（「上午1-2节」…），后面 7 个 td 对应周一~周日；每格的 .course-block 各算一条
    function theoryRows(container) {
        var rows = [];
        var trs;
        try {
            trs = container.querySelectorAll('tr');
        } catch (e) {
            return rows;
        }
        for (var r = 0; r < trs.length; r++) {
            var tds;
            try {
                tds = trs[r].querySelectorAll('td');
            } catch (e) {
                continue;
            }
            if (tds.length < 2) continue;
            var section = clip(visibleText(tds[0], []).join(''));
            // 表头 / 分组行（「上午」「下午」）没有数字，没有课
            if (!/[0-9]/.test(section)) continue;
            for (var d = 0; d < 7; d++) {
                var td = tds[d + 1];
                if (!td) continue;
                var blocks;
                try {
                    blocks = td.querySelectorAll('.course-block');
                } catch (e) {
                    continue;
                }
                for (var b = 0; b < blocks.length; b++) {
                    var spans = spansOf(blocks[b]);
                    if (!spans.length) continue;
                    rows.push({ day: d + 1, section: section, spans: spans });
                }
            }
        }
        return rows;
    }

    // 应用上下文路径（通常为 /edu），兼容不同的部署目录
    function getContextPath() {
        var m = String(window.location.pathname || '').match(/^(.*?)\/(?:report|mainpage)\//);
        return m ? m[1] : '/edu';
    }

    // 实验入口页里声明：var id=…; var openYear=…; var openTerm=…;（学号只在本函数里取出，绝不外带）
    // 三个值缺一个就不拼地址：宁可整段实验课表不导入并提醒，也不向教务发一个残缺的地址
    function labBaseOf(html) {
        var idMatch = /(?:var|const|let)\s+id\s*=\s*["']?([0-9]+)["']?\s*;/.exec(html);
        var yearMatch = /(?:var|const|let)\s+openYear\s*=\s*["']?([0-9]{4})["']?\s*;/.exec(html);
        var termMatch = /(?:var|const|let)\s+openTerm\s*=\s*["']?([0-9]+)["']?\s*;/.exec(html);
        if (!idMatch || !yearMatch || !termMatch) return null;
        return {
            sid: idMatch[1],
            year: yearMatch[1],
            term: termMatch[1]
        };
    }

    function fetchLabBase(ctx) {
        return fetch(ctx + '/report/myLabSchedule.mvc', { credentials: 'include' }).then(function (resp) {
            if (!resp.ok) return { reason: 'http' };
            return resp.text().then(function (html) {
                var base = labBaseOf(html);
                if (!base) return { reason: 'structure' };   // 返回了页面但里面没有学号 / 学年 / 学期
                base.ctx = ctx;
                return base;
            });
        }).catch(function () {
            return { reason: 'http' };
        });
    }

    // 单周实验课表：sheduleTable 是「大节 × 星期」二维数组，单元格内 lessons 是课程。
    // 只挑 parse.js 用得到的字段；结构不对返回 null（当作这一周没取到）
    function lessonsOf(json) {
        if (!json || !(json.sheduleTable instanceof Array)) return null;
        var out = [];
        for (var r = 0; r < json.sheduleTable.length; r++) {
            var row = json.sheduleTable[r];
            if (!(row instanceof Array)) continue;
            for (var c = 0; c < row.length; c++) {
                var cell = row[c];
                if (!cell || !(cell.lessons instanceof Array)) continue;
                for (var l = 0; l < cell.lessons.length; l++) {
                    var lesson = cell.lessons[l];
                    if (!lesson || typeof lesson !== 'object') continue;
                    out.push({
                        name: clip(lesson.courseName),
                        teacher: clip(lesson.teacherName),
                        location: clip(lesson.roomName),
                        day: lesson.weekday,
                        start: lesson.startSection,
                        period: lesson.period,
                        week: lesson.week
                    });
                }
            }
        }
        return out;
    }

    function totalWeeksOf(json) {
        var n = json ? Number(json.totalWeeks) : 0;
        return n > 0 ? Math.floor(n) : 0;
    }

    function fetchLabWeek(base, week) {
        var url = base.ctx + '/report/stuLabCourseTable/' + base.sid + '/' + base.year + '/' + base.term + '/' + week + '.mvc';
        return fetch(url, { credentials: 'include' }).then(function (resp) {
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.json();
        }).then(function (json) {
            var lessons = lessonsOf(json);
            if (lessons === null) throw new Error('结构不符');
            return { week: week, ok: true, lessons: lessons, totalWeeks: totalWeeksOf(json) };
        }).catch(function () {
            return { week: week, ok: false, lessons: [], totalWeeks: 0 };
        });
    }

    // 分批串行请求（每批 5 周），与上游一致，避免一次性打满教务
    function fetchLabWeeks(base, weeks) {
        var out = [];
        var index = 0;
        function nextBatch() {
            if (index >= weeks.length) return Promise.resolve(out);
            var batch = weeks.slice(index, index + MAX_FETCH_BATCH);
            index += MAX_FETCH_BATCH;
            var parts = [];
            for (var i = 0; i < batch.length; i++) parts.push(fetchLabWeek(base, batch[i]));
            return Promise.all(parts).then(function (results) {
                for (var r = 0; r < results.length; r++) out.push(results[r]);
                return nextBatch();
            });
        }
        return nextBatch();
    }

    function publicWeek(item) {
        return { week: item.week, ok: item.ok, lessons: item.lessons };
    }

    if (!onJwHost()) throw new Error(NOT_JW_TEXT);

    return findContainer().then(function (container) {
        if (!container) throw new Error(onLoginPage() ? LOGIN_TEXT : NO_TABLE_TEXT);
        var rows = theoryRows(container);
        // 找容器时有「没有课块也交出去」的兜底：登录页 / 门户页的裸容器会走到这里，这时按登录页报错，别静默只导实验课
        if (!rows.length && onLoginPage()) throw new Error(LOGIN_TEXT);
        var ctx = getContextPath();
        return fetchLabBase(ctx).then(function (base) {
            if (!base || base.reason) {
                return {
                    today: todayIso(), term: null, rows: rows, labStatus: 'no-entry',
                    labReason: base && base.reason ? base.reason : 'http', labWeeks: [], labTruncated: false
                };
            }
            var term = { year: base.year, semester: base.term };
            return fetchLabWeek(base, 1).then(function (first) {
                if (!first.ok) {
                    return {
                        today: todayIso(), term: term, rows: rows,
                        labStatus: 'first-week-failed', labWeeks: [publicWeek(first)], labTruncated: false
                    };
                }
                var total = first.totalWeeks > 0 ? first.totalWeeks : DEFAULT_LAB_WEEKS;
                var truncated = false;
                if (total > MAX_LAB_WEEKS) { total = MAX_LAB_WEEKS; truncated = true; }
                var rest = [];
                for (var w = 2; w <= total; w++) rest.push(w);
                return fetchLabWeeks(base, rest).then(function (results) {
                    var labWeeks = [publicWeek(first)];
                    for (var i = 0; i < results.length; i++) labWeeks.push(publicWeek(results[i]));
                    return {
                        today: todayIso(), term: term, rows: rows,
                        labStatus: 'ok', labWeeks: labWeeks, labTruncated: truncated
                    };
                });
            });
        });
    }).then(function (result) {
        return JSON.stringify(result);
    });
})()
