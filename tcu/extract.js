(function () {
    // 天津城建大学 教务适配器（URP 综合教务系统）—— 第一步：取数
    //
    // 移植自 shiguang_warehouse 的 TCU/tcu_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 星河欲转）
    //   上游快照 e15c627（2026-10-26）；本校脚本最后一次修改 80e30cf
    //
    // 取数方式（全部是同源相对路径，不写页面）：
    //   ① 课表页上有学期下拉框（#planCode）：POST 课表接口，体 planCode=<选中的学期>；没有下拉框：GET（教务的当前学期）。
    //      响应外壳 { dateList: [ { selectCourseList: [ 课程… ] } ], jcsjbs: [ { jc, kssj, jssj } ] }。
    //   ② GET /indexCalendar：只从页面文本里取 var rq（开学日 YYYYMMDD）与 var skzc（学期周数）两个值，不交整页，取不到不阻断。
    //
    // 只把课表相关的字段按白名单挑出来交给 parse.js，周次、节次、拼课全在 parse.js（CI 里能真跑）。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 学期：不弹上游的「学年 / 学期」输入框，也不自己拼 planCode；取课表页下拉框选中项，没有下拉框就让教务给当前学期，
    //      并告诉 parse.js 选中的是不是服务端默认写了 selected 的那一项
    //   ② 地址：上游写死绝对地址 https://jwxs.tcu.edu.cn/…；这里用同源相对路径（页面本身必须在教务主机上，白名单只放它）
    //   ③ 字段白名单：接口响应里夹带的个人信息（学号、人员 ID 等）一律不带出 extract.js
    //   ④ 去掉上游的 toast / 保存 / 桥调用：这里只交出数据，导入由宿主完成
    //   ⑤ 统一认证页（authserver）/ 教务登录页上直接提示，不发请求
    //   ⑥ 新增只读的校历取值（/indexCalendar），用来得到开学日与总周数（上游没有，写死 20 周）
    var API_PATH = '/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback';
    var CALENDAR_PATH = '/indexCalendar';
    var LOGIN_HINT = '请先登录学校的教务系统，并停在「本学期课表」页面后再点「提取课表」。';
    // 统一认证（登录）主机：它不是教务系统本身
    var PORTAL_HOSTS = ['authserver.tcu.edu.cn'];

    var COURSE_KEYS = ['courseName', 'attendClassTeacher'];
    var PLACE_KEYS = ['classDay', 'classSessions', 'continuingSession', 'classWeek',
        'teachingBuildingName', 'classroomName'];
    var SLOT_KEYS = ['jc', 'kssj', 'jssj'];

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 本地日期（不能用 UTC：北京时间早上 8 点前会退到前一天）
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

    // 当前页面是不是统一认证 / 登录页（不是教务系统本身）：是就直接提示，不发任何请求
    function onPortalOrLogin() {
        var host = String(window.location.hostname || '').toLowerCase();
        var path = String(window.location.pathname || '');
        for (var i = 0; i < PORTAL_HOSTS.length; i++) {
            if (host === PORTAL_HOSTS[i]) return true;
        }
        return path === '/login' || path.indexOf('/login/') === 0;
    }

    // 学期下拉框：取当前选中项（selectedIndex）；它是不是写了 selected 属性的那一项，交给 parse.js 判断默认学期
    function readTerm() {
        var select = document.getElementById('planCode');
        if (!select || !select.options || select.options.length === 0) return null;
        var index = select.selectedIndex >= 0 ? select.selectedIndex : 0;
        var option = select.options[index];
        var value = String(option.value);
        if (!value || value === 'no') return null;
        return {
            text: textOf(option.text),
            value: value,
            isDefault: !!option.defaultSelected
        };
    }

    function requestSchedule(term) {
        var init = {
            method: 'GET',
            credentials: 'same-origin',
            headers: { 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest' }
        };
        if (term) {
            init = {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: 'planCode=' + encodeURIComponent(term.value)
            };
        }
        return fetch(API_PATH, init).then(function (response) {
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

    function parseBody(body) {
        try {
            var data = JSON.parse(body);
            return data && typeof data === 'object' ? data : {};
        } catch (e) {
            throw new Error('教务系统返回的内容格式不对：登录状态可能已失效，或当前页面不是教务系统。' + LOGIN_HINT);
        }
    }

    // 课表响应的外壳只在这里定义一次：dateList → 每个元素的 selectCourseList → 课程。不是这个形状就返回 null
    function planCourses(data) {
        if (!data || !isArray(data.dateList)) return null;
        var list = [];
        for (var i = 0; i < data.dateList.length; i++) {
            var plan = data.dateList[i];
            if (!plan || !isArray(plan.selectCourseList)) continue;
            for (var k = 0; k < plan.selectCourseList.length; k++) {
                if (plan.selectCourseList[k] && typeof plan.selectCourseList[k] === 'object') {
                    list.push(plan.selectCourseList[k]);
                }
            }
        }
        return list;
    }

    // 课程只留白名单字段；课程 ID 等其它键一概不带出
    function collectCourses(list) {
        var courses = [];
        for (var i = 0; i < list.length; i++) {
            var course = pick(list[i], COURSE_KEYS);
            var places = isArray(list[i].timeAndPlaceList) ? list[i].timeAndPlaceList : [];
            course.timeAndPlaceList = [];
            for (var p = 0; p < places.length; p++) {
                course.timeAndPlaceList.push(pick(places[p], PLACE_KEYS));
            }
            courses.push(course);
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

    // 校历页只取两个值（不交整页 HTML）：var rq 是开学日（YYYYMMDD），var skzc 是学期周数。取不到就是 null，不阻断导入
    function fetchCalendar() {
        return fetch(CALENDAR_PATH, { method: 'GET', credentials: 'same-origin' }).then(function (response) {
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

    if (onPortalOrLogin()) {
        return Promise.reject(new Error('这里还不是教务系统：请先登录学校的统一认证，' +
            '从里面进入教务系统，停在「本学期课表」页面后再点「提取课表」'));
    }

    var term = readTerm();

    return requestSchedule(term).then(parseBody).then(function (data) {
        var list = planCourses(data);
        if (!list) {
            throw new Error('教务系统没有返回课表数据：登录状态可能已失效，或所选学期没有课。' + LOGIN_HINT);
        }
        var courses = collectCourses(list);
        var slots = collectSlots(data.jcsjbs);
        return fetchCalendar().then(function (calendar) {
            return JSON.stringify({
                fetchedDate: localDate(),
                term: term ? { text: term.text, isDefault: term.isDefault } : null,
                rq: calendar ? calendar.rq : null,
                skzc: calendar ? calendar.skzc : null,
                slots: slots,
                courses: courses
            });
        });
    });
})()
