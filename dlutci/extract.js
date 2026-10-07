(function () {
    // 大连工程学院（原大连理工大学城市学院）教务系统 —— 金智教育 jwapp 平台。
    //
    // 取数方式：同源接口（不用 DOM 抓取，页面改版不影响）。
    //   ① /modules/xskcb/cxxsjbxx.do   当前登录学生（拿学号，无参数即可）
    //   ② /modules/jshkcb/dqxnxq.do    当前学年学期
    //   ③ /modules/xskcb/cxxljc.do     校历：开学日期 XQKSRQ、总周数 ZZC
    //   ④ /modules/xskcb/xskcb.do      课表行（必须带 XH + XNXQDM，分页）
    //
    // 输出里**已剔除学号与姓名**（XH / XM）——只留排课信息，顺带让 fixture 天然脱敏。
    //
    // 注意 manifest 里**不写 scheduleUrlHint**：金智的模块页 URL 形如
    // /jwapp/sys/wdkb/*default/index.do#/xskcb，用它当登录跳转目标时，新会话会直接
    // 落到模块页并拿到 403（实测：从门户登录再进模块页则正常）。让 WebView 从登录页
    // （根地址）起，登录后停在门户首页即可。
    //
    // 应用授权（2026-10 实测）：金智按「应用」授权，同一会话里**没从门户点进过「我的课表」**
    // 时，wdkb 的接口一律 403（不是频率风控，等多久都一样）。门户上的入口是
    // /jwapp/sys/emaphome/appShow.do?id=<应用 id>，GET 它会登记授权再 302 到应用首页。
    // 所以遇到 403 先替用户「点进」一次应用再重试；请求之间也留一点间隔，不连珠炮。
    var BASE = '/jwapp/sys/wdkb';
    var PORTAL = '/jwapp/sys/emaphome/portal/index.do';
    var APP_SHOW = '/jwapp/sys/emaphome/appShow.do?id=';
    var APP_NAME = '我的课表';
    // 门户里抓不到入口时的兜底：本校「我的课表」应用的 id（2026-10 门户页实测）
    var KNOWN_APP_ID = 'a4f0ffba5bd74df4810f16b61deeefc4';
    var GAP_MS = 300;
    var appEntered = false;

    function pause(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // 在门户 HTML 里找「我的课表」后面最近的 appShow 入口 id；找不到返回 null
    function findAppId(html) {
        var from = 0;
        while (true) {
            var at = html.indexOf(APP_NAME, from);
            if (at < 0) return null;
            // 入口既可能写在名字前（title="我的课表" data-url="…"），也可能在后（卡片「进入应用」）
            var windowText = html.substring(Math.max(0, at - 200), at + 400);
            var key = 'appShow.do?id=';
            var idAt = windowText.indexOf(key);
            if (idAt >= 0) {
                var id = windowText.substring(idAt + key.length, idAt + key.length + 32);
                if (/^[0-9a-fA-F]{32}$/.test(id)) return id;
            }
            from = at + APP_NAME.length;
        }
    }

    // 相当于用户在门户上点一次「我的课表」：登记应用授权（302 到应用首页，正文不要）
    function enterApp() {
        appEntered = true;
        return fetch(PORTAL, { credentials: 'same-origin' }).then(function (response) {
            return response.ok ? response.text() : '';
        }).then(function (html) {
            return findAppId(html) || KNOWN_APP_ID;
        }, function () {
            return KNOWN_APP_ID;
        }).then(function (id) {
            return fetch(APP_SHOW + id, { credentials: 'same-origin' }).then(null, function () {});
        }).then(function () {
            // 给服务端一点时间落授权，也像真人点开页面后再取数
            return pause(800);
        });
    }

    function post(path, body) {
        return fetch(BASE + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body || ''
        }).then(function (response) {
            if (response.status === 403 && !appEntered) {
                return enterApp().then(function () { return post(path, body); });
            }
            if (response.status === 403) {
                throw new Error('教务系统拒绝访问（403）：请在页面里点开一次「我的课表」，看到课表后再点「提取课表」');
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回 HTTP ' + response.status);
            }
            // 未登录时教务系统会 302 到 http 登录页，WebView 拦掉混合内容 → fetch 直接失败；
            // 兜底把「解析不出 JSON」也翻译成同一句人话。
            return response.json().then(null, function () {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效，请在页面里重新登录后再点「提取课表」');
            });
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效，请在页面里重新登录后再点「提取课表」');
        });
    }

    function rowsOf(json, key) {
        if (!json || String(json.code) !== '0' || !json.datas || !json.datas[key]) {
            throw new Error('教务系统返回了意料之外的数据（缺少 ' + key + '）');
        }
        return json.datas[key].rows || [];
    }

    function fetchScheduleRows(xh, termCode) {
        var pageSize = 200;
        var collected = [];

        function nextPage(page) {
            var body = 'XH=' + encodeURIComponent(xh) +
                '&XNXQDM=' + encodeURIComponent(termCode) +
                '&pageSize=' + pageSize +
                '&pageNumber=' + page;
            return post('/modules/xskcb/xskcb.do', body).then(function (json) {
                if (!json || String(json.code) !== '0' || !json.datas || !json.datas.xskcb) {
                    throw new Error('课表接口返回了意料之外的数据');
                }
                var data = json.datas.xskcb;
                var rows = data.rows || [];
                for (var i = 0; i < rows.length; i++) collected.push(rows[i]);
                var total = parseInt(data.totalSize, 10);
                if (isNaN(total)) total = collected.length;
                // 兜底：最多翻 20 页（200×20 条），防止接口异常时死循环
                if (collected.length < total && rows.length > 0 && page < 20) {
                    return pause(GAP_MS).then(function () { return nextPage(page + 1); });
                }
                return collected;
            });
        }
        return nextPage(1);
    }

    // 校历里按「学年 + 学期」找到本学期那一行
    function findCalendar(rows, termCode) {
        var parts = String(termCode).split('-');
        if (parts.length < 3) return null;
        var xn = parts[0] + '-' + parts[1];
        var xq = parts[2];
        for (var i = 0; i < rows.length; i++) {
            if (String(rows[i].XN) === xn && String(rows[i].XQ) === xq) return rows[i];
        }
        return null;
    }

    var PERSONAL = { XH: true, XM: true };

    function withoutPersonal(rows) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var src = rows[i];
            var dst = {};
            for (var key in src) {
                if (src.hasOwnProperty(key) && !PERSONAL[key]) dst[key] = src[key];
            }
            out.push(dst);
        }
        return out;
    }

    return post('/modules/xskcb/cxxsjbxx.do', '').then(function (me) {
        var meRows = rowsOf(me, 'cxxsjbxx');
        if (!meRows.length || !meRows[0].XH) {
            throw new Error('没能取到当前登录学生的学号，请重新登录教务系统后再试');
        }
        var xh = meRows[0].XH;

        // 逐个请求、中间留空：不并发，免得被当成脚本连发
        var res = [];
        return pause(GAP_MS).then(function () {
            return post('/modules/jshkcb/dqxnxq.do', '');
        }).then(function (json) {
            res.push(json);
            return pause(GAP_MS);
        }).then(function () {
            return post('/modules/xskcb/cxxljc.do', '');
        }).then(function (json) {
            res.push(json);
            var termRows = rowsOf(res[0], 'dqxnxq');
            if (!termRows.length || !termRows[0].DM) {
                throw new Error('没能取到当前学年学期，请稍后重试');
            }
            var term = termRows[0];
            var calendar = findCalendar(rowsOf(res[1], 'cxxljc'), term.DM);

            return pause(GAP_MS).then(function () {
                return fetchScheduleRows(xh, term.DM);
            }).then(function (rows) {
                return JSON.stringify({
                    term: {
                        code: term.DM,
                        name: term.MC,
                        firstDay: calendar && calendar.XQKSRQ ? String(calendar.XQKSRQ).substring(0, 10) : null,
                        totalWeeks: calendar && calendar.ZZC ? parseInt(calendar.ZZC, 10) : null
                    },
                    rows: withoutPersonal(rows)
                });
            });
        });
    });
})()
