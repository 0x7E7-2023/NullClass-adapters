(function () {
    // 扬州大学 教务适配器（URP 综合教务系统，经网瑞达 WebVPN 访问）—— 第一步：取数
    //
    // 移植自 shiguang_warehouse 的 YZU/yzu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 Thanatos）
    //   上游快照 baf83fa（2026-11-10）；本校脚本最后一次修改 1fe584c（2026-08-23）
    //
    // 取数方式（全部同源，最多两个请求）：
    //   ① 从当前页面地址的 /http<…>/<加密主机>/ 前缀拼出 WebVPN 基址（不写死令牌：令牌每次登录都会变）
    //   ② POST <基址>/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback
    //      正文 planCode=<课表页学期下拉框当前选中的学期>；页面没有下拉框时正文为 planCode=（教务按会话里的当前学期给）
    //      响应外壳 { xkxx: [ { 课程ID: { courseName, attendClassTeacher, timeAndPlaceList[…] } } ], jcsjbs: [ { jc, kssj, jssj } ] }
    //   ③ GET <基址>/indexCalendar：只从页面文本里取 var rq（开学日 YYYYMMDD）与 var skzc（学期周数）两个值，不交整页；
    //      取不到就是 null，不阻断导入（主调度 2026-11-10 批准，理由见 AUDIT.md §1）
    //
    // 只把课表相关的字段按白名单挑出来交给 parse.js，周次、节次、拼课全在 parse.js（CI 里能真跑）。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 学期：不弹上游的选择框；读课表页 #planCode 下拉框的当前选中项，没有下拉框就让教务给当前学期
    //   ② 地址：上游从页面地址推出的 WebVPN 基址正则原样保留，改为只取路径前缀（不写死令牌，也不交整页地址）
    //   ③ 字段白名单：接口响应里夹带的个人信息（学号、人员标识等）一律不带出 extract.js
    //   ④ 去掉上游的弹窗 / toast / 保存 / 桥调用：这里只交出数据，导入由宿主完成
    //   ⑤ 登录页（WebVPN 登录页，或不在 /http…/ 映射路径下的页面）直接提示，零请求
    //   ⑥ 新增只读的校历取值（/indexCalendar），用来得到开学日与总周数（上游没有，写死 20 周；照同平台已审的 lnu）
    var API_PATH = '/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback';
    var CALENDAR_PATH = '/indexCalendar';
    var LOGIN_HINT = '请先在扬州大学 WebVPN 里登录，打开教务系统的「本学期课表」页面后再点「提取课表」。';

    var COURSE_KEYS = ['courseName', 'attendClassTeacher'];
    var PLACE_KEYS = ['classDay', 'classSessions', 'continuingSession', 'classWeek',
        'campusName', 'classroomName'];
    var SLOT_KEYS = ['jc', 'kssj', 'jssj'];

    // WebVPN 基址：上游把整条地址整段匹配，这里只取路径前缀 /http<…>/<加密主机>（网瑞达的映射路径）。
    // 令牌每次登录都会变，所以从当前页推导，不写死；不在映射路径下（登录页、门户首页）返回空串
    function vpnBase() {
        var match = /^\/(http[^\/]*)\/([^\/]+)/.exec(String(window.location.pathname || ''));
        return match ? '/' + match[1] + '/' + match[2] : '';
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 本地日期（不能用 UTC：北京时间早上 8 点前会退到前一天，学期名与开学日推算都会被带偏）
    function localDate() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    // 白名单：只挑课表真正用到的字段；值只接受字符串、数字、null
    function pick(source, keys) {
        var out = {};
        if (!source || typeof source !== 'object') return out;
        for (var i = 0; i < keys.length; i++) {
            var value = source[keys[i]];
            if (value === null || typeof value === 'string' || typeof value === 'number') out[keys[i]] = value;
        }
        return out;
    }

    // 学期下拉框：取当前选中项（selectedIndex），交给 parse.js 当学期名；
    // isDefault 说的是这一项有没有被服务端标成 selected（只有它才对应教务会话里的当前学期，校历才适用）
    function readTerm() {
        var select = document.getElementById('planCode');
        if (!select || !select.options || select.options.length === 0) return null;
        var index = select.selectedIndex >= 0 ? select.selectedIndex : 0;
        var option = select.options[index];
        var value = String(option.value);
        if (!value || value === 'no') return null;
        return { text: textOf(option.text), value: value, isDefault: !!option.defaultSelected };
    }

    function requestSchedule(term) {
        var url = vpnBase() + API_PATH;
        // 上游总是 POST（体里只有 planCode）；没有下拉框时留空，让教务按会话里的当前学期给
        return fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: 'planCode=' + (term ? encodeURIComponent(term.value) : '')
        }).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('教务系统拒绝访问（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        });
    }

    // 返回网页（登录失效时教务通常回登录页）与「JSON 但结构不对」分开报，别把两种原因混成一句
    function parseBody(body) {
        var data = null;
        try {
            data = JSON.parse(body);
        } catch (e) {
            throw new Error('教务系统返回的是网页而不是课表数据：登录状态可能已失效，请在 WebVPN 里重新登录、打开课表页后再提取。');
        }
        return data && typeof data === 'object' ? data : {};
    }

    // 课表响应的外壳只在这里定义一次：xkxx 是「课程 ID → 课程对象」的字典数组（也认单个字典）。
    // 不是这个形状就返回 null —— 登录失效时教务会给个空对象或别的页面
    function courseMaps(raw) {
        var xkxx = raw ? raw.xkxx : null;
        if (isArray(xkxx)) {
            var maps = [];
            for (var i = 0; i < xkxx.length; i++) {
                if (xkxx[i] && typeof xkxx[i] === 'object') maps.push(xkxx[i]);
            }
            return maps;
        }
        if (xkxx && typeof xkxx === 'object') return [xkxx];
        return null;
    }

    // 课程只留白名单字段；课程 ID 等其它键一概不带出
    function collectCourses(maps) {
        var courses = [];
        for (var m = 0; m < maps.length; m++) {
            var keys = Object.keys(maps[m]);
            for (var k = 0; k < keys.length; k++) {
                var info = maps[m][keys[k]];
                if (!info || typeof info !== 'object') continue;
                var course = pick(info, COURSE_KEYS);
                var places = isArray(info.timeAndPlaceList) ? info.timeAndPlaceList : [];
                course.timeAndPlaceList = [];
                for (var p = 0; p < places.length; p++) {
                    course.timeAndPlaceList.push(pick(places[p], PLACE_KEYS));
                }
                courses.push(course);
            }
        }
        return courses;
    }

    function collectSlots(jcsjbs) {
        if (!isArray(jcsjbs)) return null;
        var slots = [];
        for (var i = 0; i < jcsjbs.length; i++) {
            slots.push(pick(jcsjbs[i], SLOT_KEYS));
        }
        return slots;
    }

    // 校历页只取两个值（不交整页）：var rq 是开学日（YYYYMMDD），var skzc 是学期周数。取不到就是 null，不阻断导入
    function fetchCalendar() {
        return fetch(vpnBase() + CALENDAR_PATH, { method: 'GET', credentials: 'same-origin' }).then(function (response) {
            if (!response.ok) return null;
            return response.text().then(function (html) {
                var rq = /var\s+rq\s*=\s*["'](\d{8})["']/.exec(html);
                var skzc = /var\s+skzc\s*=\s*["'](\d+)["']/.exec(html);
                return { rq: rq ? rq[1] : null, skzc: skzc ? skzc[1] : null };
            });
        }, function () {
            return null;
        }).then(null, function () {
            return null;
        });
    }

    if (!vpnBase()) {
        return Promise.reject(new Error('这里还不是教务课表页：请先在扬州大学 WebVPN 里登录，' +
            '打开教务系统的「本学期课表」页面后再点「提取课表」'));
    }

    var term = readTerm();

    return requestSchedule(term).then(parseBody).then(function (raw) {
        var errorMessage = typeof raw.errorMessage === 'string' ? raw.errorMessage : null;
        var maps = courseMaps(raw);
        if (!maps && !errorMessage) {
            throw new Error('教务系统没有返回课表数据：登录状态可能已失效，或当前页面不是课表页。' + LOGIN_HINT);
        }
        return fetchCalendar().then(function (calendar) {
            return JSON.stringify({
                fetchedDate: localDate(),
                term: term ? { text: term.text, isDefault: term.isDefault } : null,
                rq: calendar ? calendar.rq : null,
                skzc: calendar ? calendar.skzc : null,
                errorMessage: errorMessage,
                courses: maps ? collectCourses(maps) : [],
                slots: collectSlots(raw.jcsjbs)
            });
        });
    });
})()
