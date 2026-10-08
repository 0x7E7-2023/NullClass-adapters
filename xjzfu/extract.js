(function () {
    // 新疆政法学院教务适配器（金智教育 jwapp / homeapp 平台）—— 取数段
    //
    // 移植自 shiguang_warehouse 的 XJZFU/xjzfu.js（MIT，上游作者 jesse-s4）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：main @ ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    //
    // 全部请求都是**当前页面同源**的相对路径（= manifest 的 loginUrl 主机），
    // 没有第二个域，所以 allowHosts 是空数组：
    //   ① GET  /jwapp/sys/homeapp/api/home/kb/xnxq.do                        学年学期列表（当前学期 = selected）
    //   ② POST /jwapp/sys/homeapp/api/home/student/getMyScheduleDetail.do    课表行（上游唯一的必须成功请求）
    //   ③ GET  /jwapp/sys/homeapp/api/home/getTermWeeks.do?termCode=...     校历：开学日 + 总周数（尽力而为）
    //
    // 移植改动（相对上游）：
    //   ① 上游弹窗让用户选学期 → 这里自动取 selected 那一项。列表里没有 selected 时取第一项，
    //      term.source 记成 api-first，parse.js 会在 warnings 里说明。
    //   ② 上游把课程、时间段、学期配置分三次推给宿主 → 这里只交出原始行与学期元信息，
    //      课表载荷在 parse.js 里拼。作息表是上游写死的常量，搬到了 parse.js（见那边的头注释）。
    //   ③ 上游 isOnStudentPage() 按主机名判断；这里不写死主机。请求失败或返回的不是 JSON
    //      （多半是登录已失效、被跳回登录页）时统一报错，并提示去教务页面重新登录。
    //   ④ 上游的学期列表拿不到直接报错；这里改成按本机日期推算，并在 warnings 里说明。
    //   ⑤ 课表请求失败时立刻重试一次（上游没有重试；宿主给整段脚本 30 秒，不加 sleep）。
    //   ⑥ 请求头、请求体与上游一致：fetch-api: true、credentials: 'include'；表单体手工拼接。
    //   ⑦ 课表请求里的 campusCode=1 是上游写死的，原样保留（多校区学校可能取不全，见 AUDIT.md）。
    //   ⑧ 输出前剔除学号 / 姓名等个人字段（同模板口径，大小写不敏感）。
    var PERSONAL = {
        XH: true,
        XM: true,
        XH_ID: true,
        SFZH: true,
        USERID: true,
        USERNAME: true,
        USER_NAME: true,
        STUDENTID: true,
        STUDENTNUMBER: true,
        REALNAME: true
    };

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    // 金智的 datas 有两种形状：学期列表 / 校历是数组本身，课表是对象（里面才是 arrangedList）。
    // 认不出就返回空数组。
    function listOf(node) {
        if (isArray(node)) return node;
        return [];
    }

    // 信封是 { code: "0", msg, datas }。code 不是 "0" 或没有 datas 的一律当失败（返回 null）。
    function datasOf(json) {
        if (!json || String(json.code) !== '0') return null;
        if (json.datas === undefined || json.datas === null) return null;
        return json.datas;
    }

    function messageOf(json) {
        if (!json) return '';
        return text(json.msg) || text(json.message);
    }

    // HTTP 非 2xx、返回的不是 JSON（登录页 HTML）都收敛成 null，由调用方决定是致命还是降级。
    function jsonOrNull(response) {
        if (!response || response.status < 200 || response.status >= 300) return null;
        return response.json().then(function (json) {
            return json;
        }, function () {
            return null;
        });
    }

    // 网络错误也收敛成 null。method 为 POST 时 body 是手工拼好的表单串。
    function request(path, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: {
                'fetch-api': 'true'
            }
        };
        if (method === 'POST') {
            options.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
            options.body = body;
        }
        return fetch(path, options).then(jsonOrNull, function () {
            return null;
        });
    }

    // 上游让用户手选学期，这里只在教务接口问不到时才推算，推算值会在 warnings 里说明
    // （猜错学期 = 整张课表都错）。秋季 9 月开学，春季 2 月开学，7~8 月是暑假（按春季学期猜），
    // 1 月还在秋季学期里。
    function termFromDate() {
        var now = new Date();
        var y = now.getFullYear();
        var m = now.getMonth() + 1;
        if (m >= 8) return y + '-' + (y + 1) + '-1';
        if (m <= 1) return (y - 1) + '-' + y + '-1';
        return (y - 1) + '-' + y + '-2';
    }

    // ① 学年学期列表：itemCode 是学期编号，itemName 是教务给的学期名，selected === true 标出当前学期。
    function termFromList() {
        return request('/jwapp/sys/homeapp/api/home/kb/xnxq.do', 'GET', null).then(function (json) {
            var list = listOf(datasOf(json));
            var first = null;
            for (var i = 0; i < list.length; i++) {
                var row = list[i] || {};
                var code = text(row.itemCode);
                if (!code) continue;
                var name = text(row.itemName) || null;
                if (row.selected === true) {
                    return { code: code, name: name, source: 'api' };
                }
                if (!first) first = { code: code, name: name, source: 'api-first' };
            }
            return first;
        });
    }

    function resolveTerm() {
        return termFromList().then(function (term) {
            if (term) return term;
            return { code: termFromDate(), name: null, source: 'guess' };
        });
    }

    // 'yyyy-MM-dd HH:mm:ss' 之类 → 'yyyy-MM-dd'；认不出返回 null。
    function isoDate(value) {
        var match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text(value));
        if (!match) return null;
        return match[1] + '-' + pad2(parseInt(match[2], 10)) + '-' + pad2(parseInt(match[3], 10));
    }

    // ③ 校历：datas 是数组，每周一项。第一项的 startDate 是开学日，项数是总周数（上游同口径）。
    function termWeeksOf(json) {
        var list = listOf(datasOf(json));
        if (!list.length) return { firstDay: null, totalWeeks: null };
        return {
            firstDay: isoDate((list[0] || {}).startDate),
            totalWeeks: list.length
        };
    }

    // ② 课表行。请求体与上游逐字一致；campusCode=1 是上游写死的。
    // 返回 null 表示这次请求整个失败（HTTP 非 2xx、返回 HTML、code 不是 "0"），
    // 和「返回了但没有课」不是一回事（后者 arrangedList 为空数组）。
    function fetchSchedule(termCode) {
        var path = '/jwapp/sys/homeapp/api/home/student/getMyScheduleDetail.do';
        var body = 'termCode=' + encodeURIComponent(termCode) + '&campusCode=1&type=term';
        return request(path, 'POST', body).then(function (json) {
            if (datasOf(json)) return json;
            return request(path, 'POST', body);
        });
    }

    function scheduleRowsOf(json) {
        var datas = datasOf(json);
        if (!datas) return null;
        return listOf(datas.arrangedList);
    }

    function withoutPersonal(rows) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var src = rows[i];
            if (!src || typeof src !== 'object') continue;
            var dst = {};
            for (var key in src) {
                if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
                if (PERSONAL[String(key).toUpperCase()]) continue;
                dst[key] = src[key];
            }
            out.push(dst);
        }
        return out;
    }

    return resolveTerm().then(function (term) {
        return Promise.all([
            request('/jwapp/sys/homeapp/api/home/getTermWeeks.do?termCode=' + encodeURIComponent(term.code), 'GET', null),
            fetchSchedule(term.code)
        ]).then(function (res) {
            var rows = scheduleRowsOf(res[1]);
            if (rows === null) {
                throw new Error('没能取到课表数据' + (messageOf(res[1]) ? '（' + messageOf(res[1]) + '）' : '') +
                    '：登录状态可能已失效，请在教务页面里重新登录后再点「提取课表」');
            }

            var weeks = termWeeksOf(res[0]);
            return JSON.stringify({
                term: {
                    code: term.code,
                    name: term.name,
                    source: term.source,
                    firstDay: weeks.firstDay,
                    firstDaySource: weeks.firstDay ? 'termWeeks' : 'guess',
                    totalWeeks: weeks.totalWeeks
                },
                rows: withoutPersonal(rows)
            });
        });
    });
})()
