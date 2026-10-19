(function () {
    // 重庆航天职业技术学院教务适配器（正方新版 jwglxt 平台，明文 http）—— 第一步：只取数，
    // 把教务的原始数据（按字段白名单挑过）原样交出去。
    //
    // 移植自 shiguang_warehouse 的 CQEPC/cqepc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 yang01）
    //   上游快照 c4a35feb061a3f6db2d6c122927083c067c61309（2026-10-19 拉取），
    //   本校脚本最后一次修改 80e30cf5990f1166210b8af6b72bed71667232ca（2026-09-23）
    // 移植改动：
    //   ① 上游的 ES6 写法降级成 ES5（异步写法改成 then 链，去掉箭头函数、模板串与块级声明关键字）
    //   ② 不弹窗问学年与学期：上游用两次单选弹窗让用户选，再拿选项代号请求；
    //      这里直接读课表页上的 #xnm / #xqm（被 selected 标记的那项优先，没有就第一项），
    //      页面上没有才去取一次课表首页读同样两个下拉框。要导入别的学期，用户在教务页面里
    //      切到那个学期再点「提取课表」（而不是每次导入都打断用户）
    //   ③ 只取数：排课行（kbList）、集中实践课（sjkList）、校区作息、学期周次校历交出去；
    //      周次解析、节次解析与课程合并全部挪到 parse.js（CI 里跑得到的那一段）
    //   ④ 排课行只交白名单字段：kcmc / xm / cdmc / xqj / jcs / zcd / xqh_id。
    //      响应里夹带的学生信息（xsxx、学号、姓名、学院等）一律不带出，也不进 fixture
    //   ⑤ 上游没有作息接口，本校的作息表写死在上游脚本里（14 节，含两节午休占位）。
    //      这里多取一个同模块的只读接口 cxRjc（菜单号 N2151，带 xqh_id 校区；路径与请求体照
    //      同族正方脚本），取到就用教务给的节次时间，取不到交 null，parse.js 回落到
    //      上游那张 14 节表并在 warnings 里说明 —— 绝不因为作息取不到就导不进课表
    //   ⑥ 学期周次校历（cxZcByXnxq，N2154）上游本来就取来当作开学日，照旧；请求体 xnm / xqm
    //   ⑦ 请求头统一带 Content-Type、X-Requested-With 与 Accept；课表请求体与上游逐字一致
    //      （xnm / xqm / kzlx=ck / xsdm= / kclbdm=，本校这一项是空的但必须带上）
    //   ⑧ 上游开场公告弹窗、保存课程、保存配置、导入预设节次时间与完成提示全部没有移植：
    //      移植件只负责取数，导入由宿主的导入流程完成
    //
    // 取数方式：同源请求，最多四个，全部打在当前教务主机上（地址都由 window.location.origin 拼出来，
    // 不写死主机名）：
    //   ① GET  /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （已经开在课表页时跳过这一步）
    //   ② POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON）
    //   ③ POST /jwglxt/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151                         取校区作息（取不到就 null）
    //   ④ POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    var GNMKDM = 'N2151';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 正方新版的上下文路径是 /jwglxt；万一挂在前缀下（门户 / 网关），跟着当前地址里的那一段走
    function jwBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(JWLGXT + '/');
        if (at > 0) return originOf() + path.substring(0, at + JWLGXT.length);
        return originOf() + JWLGXT;
    }

    // 本校教务进门后是正方自己的登录页 login_slogin.html；在登录页上不请求任何接口
    function onLoginPage() {
        return String(window.location.pathname || '').indexOf('login_slogin.html') >= 0;
    }

    function request(url, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*'
            }
        };
        if (typeof body === 'string') options.body = body;
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
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

    function get(url) {
        return request(url, 'GET', null);
    }

    function post(url, body) {
        return request(url, 'POST', body);
    }

    // 排课行只留 parse.js 用得到的字段，另外留 xqh_id 用来拼作息请求。
    // 响应行里若夹带学生个人信息（学号、姓名、学院等），一律不带出
    var KB_ROW_KEYS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd', 'xqh_id'];
    var SJK_ROW_KEYS = ['kcmc'];

    function pickRows(list, keys) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var src = list[i] || {};
            var row = {};
            for (var k = 0; k < keys.length; k++) {
                if (src[keys[k]] !== undefined) row[keys[k]] = src[keys[k]];
            }
            out.push(row);
        }
        return out;
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

    function jsonOf(text) {
        try {
            return JSON.parse(String(text));
        } catch (e) {
            return null;
        }
    }

    // 读一个学年学期字段：正常是下拉框（跳过 value 为空的占位项，被 selected 标记的那项优先，
    // 没标记就取第一项）；万一页面把它放在隐藏 input 里，就直接读 value（上游也是读 value 的）
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
            var label = String(option.textContent === null || option.textContent === undefined ? '' : option.textContent)
                .replace(/\s+/g, ' ').trim();
            if (option.selected && picked < 0) picked = list.length;
            list.push({ value: value, text: label });
        }
        if (!list.length) return null;
        if (picked < 0) picked = 0;
        return { value: list[picked].value, text: list[picked].text };
    }

    function readTermFromDoc(doc) {
        if (!doc || !doc.querySelector) return null;
        var year = readSelect(doc.querySelector('#xnm'));
        var season = readSelect(doc.querySelector('#xqm'));
        if (!year || !season) return null;
        return { xnm: year.value, xqm: season.value, xnmText: year.text, xqmText: season.text };
    }

    function currentTerm() {
        var onPage = readTermFromDoc(window.document);
        if (onPage) return Promise.resolve(onPage);
        if (typeof DOMParser === 'undefined') {
            throw new Error(
                '这个页面里读不到学年学期：请先在教务系统里打开「信息查询 - 学生课表查询」，再点「提取课表」'
            );
        }
        return get(jwBase() + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default')
            .then(function (html) {
                var doc = new DOMParser().parseFromString(String(html), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开「信息查询 - 学生课表查询」后再点「提取课表」'
                    );
                }
                return found;
            });
    }

    // 课表接口（正方：POST 表单，xnm 学年 + xqm 学期代号，请求体照上游 CQEPC 脚本原样，
    // 包含末尾那个空的 kclbdm=）。这个接口一次性返回整学期的排课，没有分页参数；
    // 万一响应里带了记录总数，就一起交出去对账。
    function fetchTimetable(term) {
        var body = 'xnm=' + encodeURIComponent(term.xnm) +
            '&xqm=' + encodeURIComponent(term.xqm) +
            '&kzlx=ck&xsdm=&kclbdm=';
        return post(jwBase() + '/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=' + GNMKDM, body)
            .then(function (text) {
                var json = jsonOf(text);
                if (!json || typeof json !== 'object' || !(json.kbList instanceof Array)) {
                    throw new Error(
                        '教务系统没有返回课表数据（返回的内容格式不对）：' +
                        '登录状态可能已失效，请重新登录后再点「提取课表」'
                    );
                }
                return json;
            });
    }

    // 附加接口（校区作息 / 学期周次校历）：不是每个部署都有这两个菜单，失败一律交 null，
    // 让 parse.js 回落到内置节次时间与推算并在 warnings 里说明 —— 绝不因为附加接口挂掉就导不进课表。
    function optionalJson(url, body) {
        return post(url, body).then(function (text) {
            return jsonOf(text);
        }, function () {
            return null;
        });
    }

    function totalOf(json) {
        var keys = ['total', 'totalResult', 'totalCount', 'count'];
        for (var i = 0; i < keys.length; i++) {
            var value = json[keys[i]];
            if (typeof value === 'number' && isFinite(value) && value >= 0) return value;
            if (typeof value === 'string' && /^[0-9]+$/.test(value)) return parseInt(value, 10);
        }
        return null;
    }

    if (onLoginPage()) {
        throw new Error(
            '当前打开的是教务登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」'
        );
    }

    return currentTerm().then(function (term) {
        return fetchTimetable(term).then(function (json) {
            var rows = json.kbList;
            var practice = json.sjkList instanceof Array ? json.sjkList : [];
            var campusId = '';
            for (var i = 0; i < rows.length; i++) {
                var id = textOf((rows[i] || {}).xqh_id).replace(/\s+/g, '');
                if (id) { campusId = id; break; }
            }
            var termBody = 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
            return Promise.all([
                // 菜单号照同族正方脚本的实际写法：作息挂课表菜单 N2151、周次校历挂 N2154
                optionalJson(jwBase() + '/kbcx/xskbcx_cxRjc.html?gnmkdm=' + GNMKDM,
                    termBody + '&xqh_id=' + encodeURIComponent(campusId)),
                optionalJson(jwBase() + '/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154', termBody)
            ]).then(function (extras) {
                return JSON.stringify({
                    term: {
                        xnm: term.xnm,
                        xqm: term.xqm,
                        xnmText: term.xnmText,
                        xqmText: term.xqmText
                    },
                    today: localTodayIso(),
                    campusId: campusId,
                    raw: { kbList: pickRows(rows, KB_ROW_KEYS), sjkList: pickRows(practice, SJK_ROW_KEYS) },
                    total: totalOf(json),
                    periodTimes: extras[0],
                    calendar: extras[1]
                });
            });
        });
    });
})()
