(function () {
    // 山东石油化工学院教务适配器（乘方智慧教务，经学校 WebVPN 的路径前缀访问）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SDIPCT/sdipct.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校目录最后一次修改 80e30cf
    // 骨架照同平台的 hnsf（河南师范大学，批次十四已审计）：取数三步与学期 / 开学日的处理一样，
    // 差别在 WebVPN 前缀、只有一张节次时间表（不用提问）和按周次给教室的 jxcdmc2 字段（在 parse.js 里处理）。
    //
    // 移植改动（逐条对应 AUDIT.md §6）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗问学年和学期：上游用输入框问学年、再用单选框问学期。这里先看当前页面有没有学期下拉框 #xnxqdm
    //      （用户在课表页上选好了学期再点提取，就取他选的那项），没有就取一次课表页读它的默认选中项，
    //      两者都读不到才按今天的日期推算（parse.js 会在提醒里说明是推算的）
    //   ③ 请求体与上游一字不差（xnxqdm=<学年起始年份 4 位 + 学期 2 位>），只多带了 X-Requested-With 头；
    //      请求地址也与上游一致：WebVPN 前缀 /https/<十六进制> + 乘方教务路径，查询串带 vpn-12-o2-jwxt.sdipct.edu.cn
    //   ④ 登录页 / WebVPN 首页 / 教务首页（根路径）与不是教务的页面不发请求，直接给大白话提示
    //   ⑤ 只取数：排课行只带 parse.js 用得到的字段（kcmc / teaxms / jxcdmc / jxcdmc2 / xq / ps / pe / zc / qssj / jssj），
    //      响应里夹带的学号、姓名等一律不带出；周次解析、节次校验与课程拼装全部在 parse.js
    //   ⑥ 上游只要求 kcmc / xq / ps / pe 非空，教师和教室缺了写成「未知教师」「未知地点」：这里不写占位词，
    //      缺教师或缺教室的行照常交出去，由 parse.js 导入（留空）并按类型汇总提醒
    //   ⑦ 开学日期：上游没取。这里多探一个同平台的接口（getDatesOfWeek，取第 1 周七天的日期），
    //      取到交给 parse.js 当开学日；取不到交 null，由 parse.js 推算并说明。失败不影响取课表
    //   ⑧ 上游的 showAlert / showToast / saveImportedCourses / savePresetTimeSlots / notifyTaskCompletion 等拾光界面调用全部去掉
    //
    // 取数方式：同源请求，最多三个，全部打在用户当前打开的 WebVPN 主机上，地址 = 主机 + 教务前缀 + 路径 + 查询串：
    //   ① GET  <前缀>/new/student/xsgrkb/week.page             读学期下拉框 #xnxqdm 的默认选中项（当前页面已有该下拉框则跳过）
    //   ② POST <前缀>/new/student/xsgrkb/getCalendarWeekDatas  体 xnxqdm=<学期>，取整学期排课（JSON：{code:0,data:[…]}）
    //   ③ POST <前缀>/new/xlxx/getDatesOfWeek                  体 xnxqdm=<学期>&zc=1，取第 1 周七天的日期（尽力而为，失败交 null）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。
    //
    // 交给 parse.js 的对象：
    //   term        —— { code: '202601', name: '页面上的学期文字', source: 'page' | 'date' }
    //   today       —— 提取当天日期（本地日期 yyyy-MM-dd），parse.js 推算开学日时用
    //   weekOne     —— 第 1 周七天的日期 [{ xqmc, rq }]；取不到为 null
    //   rows        —— 排课行（白名单字段）
    var WEBVPN_HOST = 'webvpn.sdipct.edu.cn';
    // 教务（乘方）在 WebVPN 里的映射：前面 32 位是 WebVPN 通用的固定头，后面是教务主机的加密串（取自上游脚本的地址）
    var JW_PREFIX = '/https/77726476706e69737468656265737421fae0598869236c596e0b9de29d51367bd943';
    // 上游写死在请求地址查询串里的 WebVPN 片段；当前地址里找不到时沿用它
    var VPN_DEFAULT = 'vpn-12-o2-jwxt.sdipct.edu.cn';
    var LIST_PATH = '/new/student/xsgrkb/getCalendarWeekDatas';
    var PAGE_PATH = '/new/student/xsgrkb/week.page';
    var WEEK_ONE_PATH = '/new/xlxx/getDatesOfWeek';
    var MAX_PAGE_BODY = 3000000;   // 课表页超过这个长度就不认
    var MAX_LIST_BODY = 4000000;   // 课表响应超过这个长度就不认（多半是登录页 HTML）
    var MAX_SMALL_BODY = 200000;   // 开学日接口的响应超过这个长度就不认

    // 行字段白名单：parse.js 只读这几个字段，响应里其它字段（学生信息之类）一律不带出
    var ROW_FIELDS = ['kcmc', 'teaxms', 'jxcdmc', 'jxcdmc2', 'xq', 'ps', 'pe', 'zc', 'qssj', 'jssj'];
    var DAY_FIELDS = ['xqmc', 'rq'];

    var LOGIN_TEXT = '当前打开的是登录页或教务系统首页。请先登录学校的 WebVPN，进入教务系统并打开你的课表页面，然后点「提取课表」';
    var NOT_JW_TEXT = '当前页面不是山东石油化工学院的教务系统。请先登录学校的 WebVPN，进入教务系统并打开你的课表页面，然后点「提取课表」';

    function clean(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 提取时刻（本地日期）。不能用 toISOString：北京时间早上 8 点前它会退到前一天
    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function hasWord(text, word) {
        return new RegExp('(^|[^a-z0-9])' + word + '([^a-z0-9]|$)').test(text);
    }

    // 当前页面在哪：
    //   'jw'    —— WebVPN 主机上、教务前缀下的内页（课表页、教务各栏目）：可以取数
    //   'login' —— WebVPN 的首页 / 登录页 / 统一认证页，或教务前缀下的根路径（登录页或首页）/ 含 login、含单独 cas 一段的页面
    //   'other' —— 其它（别的主机，或 WebVPN 里映射到别的系统的页面）
    // 只看路径、不看查询串：统一认证页的 service= 参数里会带着教务自己的地址
    function locate() {
        var loc = window.location;
        if (String(loc.hostname || '').toLowerCase() !== WEBVPN_HOST) return 'other';
        var path = String(loc.pathname || '').toLowerCase();
        var prefix = JW_PREFIX.toLowerCase();
        if (path === prefix || path.indexOf(prefix + '/') === 0) {
            var rest = path.substring(prefix.length);
            if (rest === '' || rest === '/') return 'login';
            if (rest.indexOf('login') >= 0 || hasWord(rest, 'cas')) return 'login';
            return 'jw';
        }
        if (path === '' || path === '/' || path.indexOf('login') >= 0 || hasWord(path, 'cas')) return 'login';
        return 'other';
    }

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // WebVPN 查询串片段：沿用当前地址里的 vpn-数字-o数字-jwxt.sdipct.edu.cn，找不到才用上游写死的那个
    function vpnPart() {
        var search = String(window.location.search || '');
        var m = /(^|[?&])(vpn-[0-9]+-o[0-9]+-jwxt\.sdipct\.edu\.cn)(&|#|$)/.exec(search);
        return m ? m[2] : VPN_DEFAULT;
    }

    // 教务地址：<主机><前缀><路径>?<vpn 片段>
    function jwUrl(path) {
        return originOf() + JW_PREFIX + path + '?' + vpnPart();
    }

    function jsonOf(text) {
        try {
            return JSON.parse(String(text));
        } catch (e) {
            return null;
        }
    }

    function request(path, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        if (typeof body === 'string') options.body = body;
        return fetch(jwUrl(path), options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：请确认已登录，再点「提取课表」');
        });
    }

    // 课表响应的外壳只在这里定义一次：{code:0,data:[…]}。返回行数组；不是这个形状返回 null
    function courseRowsOf(json) {
        if (!json || typeof json !== 'object') return null;
        if (String(json.code) !== '0') return null;
        return json.data instanceof Array ? json.data : null;
    }

    // 开学日接口的外壳：裸数组，或套了一层 rows / data
    function dayRowsOf(json) {
        if (json instanceof Array) return json;
        if (!json || typeof json !== 'object') return null;
        if (json.rows instanceof Array) return json.rows;
        if (json.data instanceof Array) return json.data;
        return null;
    }

    function pick(row, fields) {
        var kept = {};
        for (var i = 0; i < fields.length; i++) {
            if (row[fields[i]] !== undefined && row[fields[i]] !== null) kept[fields[i]] = row[fields[i]];
        }
        return kept;
    }

    function pickAll(list, fields) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && typeof list[i] === 'object') out.push(pick(list[i], fields));
        }
        return out;
    }

    // ---------- 学期 ----------
    // 学期代码 = 学年起始年份 4 位 + 学期 2 位（上游拼的 xnxqdm）。下拉框里不是这个形状的选项不认
    function termCodeOk(code) {
        return /^[0-9]{6}$/.test(code);
    }

    // 读 #xnxqdm：选中项优先（用户在页面上切过的就是他选的），没有选中标记取第一个合法选项
    function readTermSelect(doc) {
        var select = doc && doc.getElementById ? doc.getElementById('xnxqdm') : null;
        if (!select) return null;
        var options = select.querySelectorAll ? select.querySelectorAll('option') : (select.options || []);
        var list = [];
        var picked = -1;
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var code = clean(option.value).replace(/\s+/g, '');
            if (!termCodeOk(code)) continue;
            var chosen = option.selected === true || (option.hasAttribute && option.hasAttribute('selected'));
            if (chosen && picked < 0) picked = list.length;
            list.push({ code: code, name: clean(option.textContent) });
        }
        if (!list.length) return null;
        if (picked < 0) picked = 0;
        return { code: list[picked].code, name: list[picked].name, source: 'page' };
    }

    // 按今天的日期推算学期：8 月到次年 1 月是第一学期（1 月算上一学年），2 到 7 月是第二学期
    function termByDate(now) {
        var year = now.getFullYear();
        var month = now.getMonth() + 1;
        var code;
        if (month >= 8) code = year + '01';
        else if (month <= 1) code = (year - 1) + '01';
        else code = (year - 1) + '02';
        return { code: code, name: '', source: 'date' };
    }

    function fetchPageTerm() {
        if (typeof DOMParser === 'undefined') return Promise.resolve(null);
        return request(PAGE_PATH, 'GET', null).then(function (html) {
            if (html.length > MAX_PAGE_BODY) return null;
            return readTermSelect(new DOMParser().parseFromString(html, 'text/html'));
        }, function () {
            return null;
        });
    }

    function resolveTerm() {
        var onPage = readTermSelect(window.document);
        if (onPage) return Promise.resolve(onPage);
        return fetchPageTerm().then(function (found) {
            return found || termByDate(new Date());
        });
    }

    // ---------- 课表 ----------
    function fetchRows(term) {
        return request(LIST_PATH, 'POST', 'xnxqdm=' + encodeURIComponent(term.code)).then(function (body) {
            var json = body.length > MAX_LIST_BODY ? null : jsonOf(body);
            var rows = courseRowsOf(json);
            if (!rows) {
                var code = json && typeof json === 'object' && json.code !== undefined && String(json.code) !== '0'
                    ? '（代码 ' + clean(json.code).substring(0, 20) + '）' : '';
                throw new Error(
                    '教务系统没有返回课表数据' + code + '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return pickAll(rows, ROW_FIELDS);
        });
    }

    // 第 1 周七天的日期：不是每个部署都有，任何失败（非 2xx / 不是 JSON / 超长 / 形状不对）都交 null
    function fetchWeekOne(term) {
        return request(WEEK_ONE_PATH, 'POST', 'xnxqdm=' + encodeURIComponent(term.code) + '&zc=1').then(function (body) {
            var json = body.length > MAX_SMALL_BODY ? null : jsonOf(body);
            var days = dayRowsOf(json);
            return days ? pickAll(days, DAY_FIELDS) : null;
        }, function () {
            return null;
        });
    }

    var where = locate();
    if (where === 'login') throw new Error(LOGIN_TEXT);
    if (where !== 'jw') throw new Error(NOT_JW_TEXT);

    return resolveTerm().then(function (term) {
        return fetchRows(term).then(function (rows) {
            if (!rows.length) {
                throw new Error(
                    '教务系统里这个学期（' + (term.name || term.code) + '）还没有课表数据：可能是课表还没发布。' +
                    '请先在教务系统的课表页面里切到有课的学期，再点「提取课表」'
                );
            }
            return fetchWeekOne(term).then(function (weekOne) {
                return JSON.stringify({
                    term: term,
                    today: todayIso(),
                    weekOne: weekOne,
                    rows: rows
                });
            });
        });
    });
})()
