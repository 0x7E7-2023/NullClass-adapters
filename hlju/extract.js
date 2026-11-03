(function () {
    // 黑龙江大学本科选课系统适配器（xsxk.hlju.edu.cn，JSON 接口）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 HLJU/hlju_bachelor.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03 对齐 origin/main），本校脚本最后一次修改 80e30cf
    // 移植改动：
    //   ① ES6 → ES5：去掉箭头函数、模板串、块级声明关键字、异步函数与等待写法，改用 then 链与 for 循环。
    //   ② 不弹窗：上游开场弹框提示「导入前请确保已登录」，这里不弹；学期直接用接口标出的当前学期（SFDQXQ 为 1 的那一项），不让用户选。
    //   ③ 同源地址：请求都打在当前页面的主机上（window.location.origin 拼出来），不写死主机与端口。
    //      课表接口地址上游从浏览器的资源记录里找，这里同样找，但只认同源的；找不到就用 /xszykb/queryxszykbzong。
    //   ④ 只交白名单字段：每行只带 SKSJ / KEY / KSJC / JSJC 四个字段，别的（包括可能夹带的个人信息）一律不带出。
    //   ⑤ 不取作息：上游没有调用作息接口（只有写死的 12 节表），节次时间放在 parse.js。
    //   ⑥ 登录页判断：页面上有密码框就是登录页，直接提示，不发请求。
    //   ⑦ 只读：不写页面、不提交表单、不触发点击（上游也不写页面）。
    //
    // 取数方式：同源 POST，两个请求，全部打在当前教务主机上：
    //   ① POST /component/queryxnxqdata            取学年学期列表，挑 SFDQXQ 为 1 的那一项（学年 XN、学期序号 XQ）
    //   ② POST /xszykb/queryxszykbzong（或资源记录里的同源地址） 取课表；请求体 xn=…&xq=…（与上游逐字一致）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var FIELDS = ['SKSJ', 'KEY', 'KSJC', 'JSJC'];
    var TIMETABLE_PATH = '/xszykb/queryxszykbzong';
    var TERM_PATH = '/component/queryxnxqdata';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 登录页：页面上有密码框，就只提示，不发请求
    function onLoginPage() {
        var doc = window.document;
        return !!(doc && doc.querySelector && doc.querySelector('input[type="password"]'));
    }

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
    }

    // 响应外壳：裸数组，或 {content: [...]}（上游两种都认）。这个外壳只在这里认一次，学期与课表共用
    function listOf(body) {
        var json = null;
        try {
            json = JSON.parse(String(body));
        } catch (e) {
            return null;
        }
        if (Array.isArray(json)) return json;
        if (json && typeof json === 'object' && Array.isArray(json.content)) return json.content;
        return null;
    }

    function request(url, formBody) {
        var options = {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        if (typeof formBody === 'string') options.body = formBody;
        return fetch(url, options).then(function (response) {
            if (!response.ok) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    // 学年学期：接口把当前学期标在 SFDQXQ 上（字符串或数字都认）
    function currentTerm(origin) {
        return request(origin + TERM_PATH).then(function (body) {
            var list = listOf(body);
            if (!list) {
                throw new Error('学期接口返回的内容不对：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            var current = null;
            for (var i = 0; i < list.length; i++) {
                if (list[i] && String(list[i].SFDQXQ) === '1') { current = list[i]; break; }
            }
            if (!current || !current.XN || !current.XQ) {
                throw new Error('未获取到当前学期信息：请重新登录后再点「提取课表」');
            }
            return { xn: String(current.XN), xq: String(current.XQ) };
        });
    }

    // 课表地址：优先用页面自己请求过的那条同源地址（上游的做法），找不到就用固定路径
    function timetableUrl(origin) {
        var found = '';
        var entries = window.performance && performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
        for (var i = 0; i < entries.length; i++) {
            var name = String(entries[i].name || '');
            if (name.indexOf('queryxszykbzong') !== -1 && name.indexOf(origin + '/') === 0) found = name;
        }
        return found || origin + TIMETABLE_PATH;
    }

    // 只留白名单字段
    function pickFields(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var kept = {};
            for (var j = 0; j < FIELDS.length; j++) {
                if (row[FIELDS[j]] !== undefined) kept[FIELDS[j]] = row[FIELDS[j]];
            }
            out.push(kept);
        }
        return out;
    }

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是登录页。请先登录选课系统，再打开课表查询页，然后点「提取课表」'
        );
    }

    var origin = originOf();
    return currentTerm(origin).then(function (term) {
        return request(timetableUrl(origin),
            'xn=' + encodeURIComponent(term.xn) + '&xq=' + encodeURIComponent(term.xq)).then(function (body) {
            var list = listOf(body);
            if (!list) {
                throw new Error('课表接口返回的内容不对：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            return JSON.stringify({ term: term, today: localTodayIso(), kbList: pickFields(list) });
        });
    });
})()
