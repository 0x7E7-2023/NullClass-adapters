(function () {
    // 德州学院教务适配器（正方教务新版 jwglxt，教务系统在学校的 IP 地址上，走 http）—— 第一步：只取数，把教务的原始数据原样交出去。
    //
    // 移植自 shiguang_warehouse 的 DZU/dzu_deep.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 yvmu）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取）
    //   本校脚本最后一次修改 80e30cf（2026-09-23）
    // 移植改动（逐条对应 AUDIT.md 第 5 节）：
    //   ① ES6 → ES5（异步写法改成 then 链，去掉模板串、箭头函数与块级声明关键字）
    //   ② 不弹窗让用户选学年与学期：上游先读课表首页的 #xnm / #xqm 下拉框，再弹两个选择框（读不到还会改成让用户手动输入起始学年、选第一或第二学期，
    //      并把学期码写死成 3 / 12）。这里直接读页面上的 #xnm / #xqm（被 selected 标的那项优先，没有就取第一项）；
    //      页面上读不到才去取一次课表首页读同样两个下拉框。要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ③ 主机不写死：上游的三条请求都是以 /jwglxt 开头的绝对路径（所以在教务系统任意页面都能导入）。
    //      这里同样以当前页面的来源（协议 + 主机 + 端口）为准，当前地址里有 /jwglxt/ 就用到它为止，没有就退回 /jwglxt（与上游一致），
    //      所以也是「教务系统任意页面都能提取」；只有停在登录页（路径含 login_slogin.html）时直接提示先登录，不发请求
    //   ④ 只取数：排课行（kbList）只带白名单字段，集中实践课（sjkList）只带课名，学期周次校历只带第几周与日期；
    //      响应里夹带的学生信息（xsxx、学号、姓名、学院等）一律不带出；周次、节次解析与课程合并全部挪到 parse.js（CI 里跑得到的那一段）
    //   ⑤ 不请求节次时间：上游把德州学院的 13 节作息写死（来源是学校公布的作息表），整个脚本没有请求教务的作息接口。
    //      这里同样不发作息请求，节次时间直接用 parse.js 里的本校 13 节表
    //   ⑥ 登录失效识别照上游：课表接口在会话失效时返回 200 + 登录页，命中 login_slogin / 用户登录 / 学校平台名称就单独提示
    //      （上游还判断 response.redirected；这里拿不到，但失效时返回的就是登录页文字，命中同一组特征，其余情况落到下面的格式检查）
    //   ⑦ 请求头：每个请求统一带 Content-Type、X-Requested-With 与 Accept（上游课表请求只带 Content-Type）；
    //      课表请求体与上游逐字一致（xnm / xqm / kzlx=ck / xsdm= / kclbdm=），参数值经 encodeURIComponent，数字不变
    //   ⑧ 上游的开场弹窗、saveImportedCourses / saveCourseConfig / savePresetTimeSlots、showToast / notifyTaskCompletion 全部不移植
    //
    // 取数方式：同源请求，最多三个，全部打在当前教务主机上（地址由 window.location 拼出来，不写死主机名）：
    //   ① GET  <base>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default  读当前学年学期
    //      （页面上已有 #xnm / #xqm 时跳过这一步）
    //   ② POST <base>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151                     取课表（JSON）
    //   ③ POST <base>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154                取学期周次校历（取不到就 null）
    // <base> 就是教务主机的来源加 /jwglxt（例如 http 协议、一个 IP 地址、路径 /jwglxt）。
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息。

    var JWLGXT = '/jwglxt';
    var GNMKDM = 'N2151';
    var GNMKDM_CALENDAR = 'N2154';
    var ON_LOGIN = '当前打开的是教务登录页。请先登录教务系统，再点「提取课表」';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    function pathOf() {
        return String(window.location.pathname || '');
    }

    // 上游导入的入口就是登录页；停在登录页上点「提取课表」注定失败，少发一次请求，直接提示
    function onLoginPage() {
        return pathOf().indexOf('login_slogin.html') >= 0;
    }

    // 教务基址：当前地址里有 /jwglxt/ 就用到它为止；没有（站点根等）就退回 来源 + /jwglxt，与上游的绝对路径一致
    function jwBase() {
        var path = pathOf();
        var at = path.indexOf(JWLGXT + '/');
        if (at > 0) return originOf() + path.substring(0, at + JWLGXT.length);
        return originOf() + JWLGXT;
    }

    function asText(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    // 去首尾空白、内部空白压成一个空格
    function squeeze(value) {
        return asText(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function jsonOf(text) {
        try {
            return JSON.parse(asText(text));
        } catch (e) {
            return null;
        }
    }

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
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

    // 读一个学年学期下拉框：跳过 value 为空的占位项；被 selected 标记的那项优先，没标记就取第一项。
    // 万一页面把它放成没有 option 的 input，就直接读 value
    function readSelect(selectEl) {
        if (!selectEl) return null;
        var options = selectEl.options;
        if (!options || !options.length) {
            var raw = asText(selectEl.value).replace(/\s+/g, '');
            return raw ? { value: raw, text: '' } : null;
        }
        var list = [];
        var picked = -1;
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            var value = asText(option.value).replace(/\s+/g, '');
            if (!value) continue;
            if (option.selected && picked < 0) picked = list.length;
            list.push({ value: value, text: squeeze(option.textContent) });
        }
        if (!list.length) return null;
        return list[picked < 0 ? 0 : picked];
    }

    function readTermFromDoc(doc) {
        if (!doc || !doc.querySelector) return null;
        var year = readSelect(doc.querySelector('#xnm'));
        var season = readSelect(doc.querySelector('#xqm'));
        if (!year || !season) return null;
        return { xnm: year.value, xqm: season.value, xnmText: year.text, xqmText: season.text };
    }

    function currentTerm(base) {
        var onPage = readTermFromDoc(window.document);
        if (onPage) return Promise.resolve(onPage);
        if (typeof DOMParser === 'undefined') {
            throw new Error('这个页面里读不到学年学期：请先打开「学生课表查询」，再点「提取课表」');
        }
        return get(base + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default')
            .then(function (html) {
                var doc = new DOMParser().parseFromString(asText(html), 'text/html');
                var found = readTermFromDoc(doc);
                if (!found) {
                    throw new Error(
                        '没读到学年学期：登录状态可能已失效，或教务系统改了课表页。' +
                        '请重新登录并打开「学生课表查询」后再点「提取课表」'
                    );
                }
                return found;
            });
    }

    function termBody(term) {
        return 'xnm=' + encodeURIComponent(term.xnm) + '&xqm=' + encodeURIComponent(term.xqm);
    }

    // 课表接口（正方：POST 表单，参数照上游 DZU 脚本原样，带 kclbdm=）。一次性返回整学期排课，没有分页。
    // 会话失效时正方返回 200 + 登录页：先于 JSON 解析判断，单独提示（上游同款判断）
    function fetchTimetable(base, term) {
        var body = termBody(term) + '&kzlx=ck&xsdm=&kclbdm=';
        return post(base + '/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=' + GNMKDM, body).then(function (text) {
            if (/login_slogin|用户登录|德州学院教学综合信息服务平台/.test(asText(text))) {
                throw new Error('登录状态已失效，请重新登录教务系统后再点「提取课表」');
            }
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

    // 附加接口（学期周次校历）：失败一律交 null，让 parse.js 推算开学日并写进 warnings，绝不因为它挂掉就导不进课表
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

    // 行字段白名单：parse.js 只读这几个字段。响应里其它字段（xsxx 学生信息之类）一律不带出
    var KB_FIELDS = ['kcmc', 'xm', 'cdmc', 'xqj', 'jcs', 'zcd'];
    var PRACTICE_FIELDS = ['kcmc'];
    // 校历同样只留 parse.js 用得到的字段（第几周与日期）
    var CALENDAR_FIELDS = ['zs', 'zsmc', 'zrq', 'zcrq', 'rq', 'ksrq'];

    // 校历的返回可能是裸数组，也可能套了信封：照 parse.js 的口径找出「最像行数组的那一层」，找不到返回 null
    function rowListOf(value) {
        if (value instanceof Array) return value;
        if (!value || typeof value !== 'object') return null;
        var keys = ['rows', 'datas', 'data', 'list', 'items', 'kbList'];
        var i;
        var found;
        for (i = 0; i < keys.length; i++) {
            found = rowListOf(value[keys[i]]);
            if (found && found.length) return found;
        }
        for (var key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            found = rowListOf(value[key]);
            if (found && found.length) return found;
        }
        return null;
    }

    function pickFields(list, fields) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            var kept = {};
            for (var j = 0; j < fields.length; j++) {
                if (row[fields[j]] !== undefined) kept[fields[j]] = row[fields[j]];
            }
            out.push(kept);
        }
        return out;
    }

    if (onLoginPage()) throw new Error(ON_LOGIN);
    var base = jwBase();

    return currentTerm(base).then(function (term) {
        return fetchTimetable(base, term).then(function (json) {
            var rows = pickFields(json.kbList, KB_FIELDS);
            var practice = pickFields(json.sjkList instanceof Array ? json.sjkList : [], PRACTICE_FIELDS);
            return optionalJson(base + '/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=' + GNMKDM_CALENDAR, termBody(term))
                .then(function (calendar) {
                    var calendarRows = rowListOf(calendar);
                    return JSON.stringify({
                        term: {
                            xnm: term.xnm,
                            xqm: term.xqm,
                            xnmText: term.xnmText,
                            xqmText: term.xqmText
                        },
                        today: localTodayIso(),
                        raw: { kbList: rows, sjkList: practice },
                        total: totalOf(json),
                        calendar: calendarRows ? pickFields(calendarRows, CALENDAR_FIELDS) : null
                    });
                });
        });
    });
})()
