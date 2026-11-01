(function () {
    // 天津科技大学 教务适配器（URP 综合教务系统）—— 第一步：取数
    //
    // 移植自 shiguang_warehouse 的 TUST/tust_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 oneepointer）
    //   上游快照 03d161a（仓库 HEAD）；本校脚本最后一次修改 80e30cf
    //
    // 取数方式（全部是同源相对路径，不写页面）：
    //   ① 从当前页 head 的文本里取出课表接口路径中的一段字母数字（页面每次刷新都会变），
    //      POST /student/courseSelect/thisSemesterCurriculum/<这段>/ajaxStudentSchedule/curr/callback（无请求体）。
    //      响应外壳 { dateList: [ { selectCourseList: [ 课程… ] } ] }，这是当前学期的课，没有学期参数。
    //   ② POST /ajax/getSectionAndTime，体 planNumber=&ff=f。响应 sectionTime 数组，每项 startTime / endTime（四位钟点）。
    //
    // 只把课表相关的字段按白名单挑出来交给 parse.js，周次、节次、拼课全在 parse.js（CI 里能真跑）。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 不弹上游的开场确认框；统一认证页（id.tust.edu.cn）和教务登录页上直接提示，不发请求
    //   ② 地址：上游写死带端口的绝对地址；这里只用同源相对路径，并且只采用页面里那段字母数字，不跟随页面里的任意网址
    //   ③ 字段白名单：接口响应里夹带的个人信息（学号、人员 ID 等）一律不带出 extract.js
    //   ④ 去掉上游的 toast / 保存 / 桥调用：这里只交出数据，导入由宿主完成
    //   ⑤ 节次时间取不到（请求失败、不是预期外壳、没有 sectionTime）不阻断导入，交给 parse.js 提醒
    //   ⑥ 当前页没有那段课表路径时不发请求，提示先打开本学期课表
    var SECTION_PATH = '/ajax/getSectionAndTime';
    var SECTION_BODY = 'planNumber=&ff=f';
    var LOGIN_HINT = '请先登录学校的教务系统，并停在「本学期课表」页面后再点「提取课表」。';
    // 统一认证（登录）主机：它不是教务系统本身
    var PORTAL_HOSTS = ['id.tust.edu.cn'];
    var CODE_PATTERN = /\/student\/courseSelect\/thisSemesterCurriculum\/([0-9a-zA-Z]+)\/ajaxStudentSchedule\/curr\/callback/;

    var COURSE_KEYS = ['courseName', 'attendClassTeacher'];
    var PLACE_KEYS = ['classDay', 'classSessions', 'continuingSession', 'classWeek',
        'teachingBuildingName', 'classroomName'];
    var SLOT_KEYS = ['startTime', 'endTime'];

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 本地日期（不能用 UTC：北京时间早上 8 点前会退到前一天）
    function localDate() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
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

    // 课表路径里的那段字母数字只从当前页 head 的文本里取第一处；取不到就是空串
    function readScheduleCode() {
        var html = document.head ? String(document.head.innerHTML || '') : '';
        var found = CODE_PATTERN.exec(html);
        return found ? found[1] : '';
    }

    function schedulePath(code) {
        return '/student/courseSelect/thisSemesterCurriculum/' + code + '/ajaxStudentSchedule/curr/callback';
    }

    function requestText(path, method, body) {
        var init = {
            method: method,
            credentials: 'same-origin',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        if (body) init.body = body;
        return fetch(path, init).then(function (response) {
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

    // 节次时间按数组原顺序交出去（第几节由下标决定，在 parse.js 里算）。失败一律 null，不阻断
    function requestSlots() {
        return fetch(SECTION_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: SECTION_BODY
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) return null;
            return response.text().then(function (body) {
                try {
                    var data = JSON.parse(body);
                    if (!data || !isArray(data.sectionTime)) return null;
                    var slots = [];
                    for (var i = 0; i < data.sectionTime.length; i++) {
                        slots.push(pick(data.sectionTime[i], SLOT_KEYS));
                    }
                    return slots;
                } catch (e) {
                    return null;
                }
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

    var code = readScheduleCode();
    if (!code) {
        return Promise.reject(new Error('当前页面不是本学期课表：请打开「本学期课表」后再点「提取课表」。' + LOGIN_HINT));
    }

    return requestText(schedulePath(code), 'POST').then(parseBody).then(function (data) {
        var list = planCourses(data);
        if (!list) {
            throw new Error('教务系统没有返回课表数据：登录状态可能已失效，或这个学期没有课。' + LOGIN_HINT);
        }
        var courses = collectCourses(list);
        return requestSlots().then(function (slots) {
            return JSON.stringify({
                fetchedDate: localDate(),
                slots: slots,
                courses: courses
            });
        });
    });
})()
