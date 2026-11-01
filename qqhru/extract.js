(function () {
    // 齐齐哈尔大学 教务适配器（URP 综合教务，经 WebVPN 资源主机访问）—— 第一步：取数
    //
    // 移植自 shiguang_warehouse 的 QQHRU/qqhru.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 星河欲转）
    //   上游快照 7c9e190（2026-10-26）；本校脚本最后一次修改 80e30cf（2026-09-23）
    //   模板：已审计的 tcu（URP 课表外壳相同）。本校取数路径按上游重写，不照搬模板学校的主机。
    //
    // 取数方式（只打资源主机上的绝对地址，不写页面，不发明路径前缀）：
    //   ① GET 学期课表页，从页面文字里抽出 ajaxStudentSchedule/past/callback 的路径，再拼回同一主机。
    //   ② POST 该地址，体为 planCode=课表页下拉框选中的学期（页面没有下拉框时，用课表页里默认选中的那一项）。
    //      响应外壳 { dateList: [ { selectCourseList: [ 课程… ] } ], jcsjbs: [ { jc, kssj, jssj } ] }。
    //   登录主机 webvpn.qqhru.edu.cn 与资源主机不是同一个，这里不向登录主机发请求。
    //
    // 只把课表相关的字段按白名单挑出来交给 parse.js，周次、节次、拼课全在 parse.js（CI 里能真跑）。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 学期：不弹上游的学年 / 学期输入框，也不自己拼 planCode；读课表页下拉框，没有就读刚取回的课表页里默认选中项
    //   ② 地址：上游写死资源主机 https://172-20-139-153-7700.webvpn.qqhru.edu.cn ，回调路径从课表页抽出；抽不出就停止，不猜路径
    //   ③ 抽出的地址若指向别的主机，停止提取，不请求，也不把它加进白名单
    //   ④ 字段白名单：接口响应里夹带的个人信息（学号、人员标识等）一律不带出 extract.js
    //   ⑤ 去掉上游的弹窗、toast、保存与桥调用：这里只交出数据，导入由宿主完成
    //   ⑥ 登录页（登录主机，或路径为登录页）上直接提示，不发请求
    //   ⑦ 不请求校历：上游没有这一步，开学日与总周数交给 parse.js 按提取日和课表周次推算并提醒
    var RESOURCE_HOST = '172-20-139-153-7700.webvpn.qqhru.edu.cn';
    var RESOURCE_ORIGIN = 'https://172-20-139-153-7700.webvpn.qqhru.edu.cn';
    var INDEX_URL = 'https://172-20-139-153-7700.webvpn.qqhru.edu.cn/student/courseSelect/calendarSemesterCurriculum/index';
    var LOGIN_HOST = 'webvpn.qqhru.edu.cn';
    var LOGIN_HINT = '请先登录学校的教务系统，并停在「学期课表」页面后再点「提取课表」。';

    var COURSE_KEYS = ['courseName', 'attendClassTeacher'];
    var PLACE_KEYS = ['classDay', 'classSessions', 'continuingSession', 'classWeek',
        'teachingBuildingName', 'classroomName'];
    var SLOT_KEYS = ['jc', 'kssj', 'jssj'];

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

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

    function pick(source, keys) {
        var out = {};
        if (!source || typeof source !== 'object') return out;
        for (var i = 0; i < keys.length; i++) {
            var value = source[keys[i]];
            if (value === null || typeof value === 'string' || typeof value === 'number') out[keys[i]] = value;
        }
        return out;
    }

    function onPortalOrLogin() {
        var host = String(window.location.hostname || '').toLowerCase();
        var path = String(window.location.pathname || '');
        if (host === LOGIN_HOST) return true;
        if (path === '/users/sign_in' || path.indexOf('/users/sign_in/') === 0) return true;
        if (path === '/login' || path.indexOf('/login/') === 0) return true;
        return false;
    }

    function readTermFrom(root) {
        if (!root || !root.getElementById) return null;
        var select = root.getElementById('planCode');
        if (!select || !select.options || select.options.length === 0) return null;
        var index = select.selectedIndex >= 0 ? select.selectedIndex : 0;
        var option = select.options[index];
        var value = String(option.value || '');
        if (!value || value === 'no') return null;
        return {
            text: textOf(option.text),
            value: value,
            isDefault: !!option.defaultSelected
        };
    }

    function termFromHtml(html) {
        try {
            var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
            return readTermFrom(doc);
        } catch (e) {
            return null;
        }
    }

    // 只接受资源主机上的路径。抽出的若是别的主机的完整地址，返回空，调用方停止，不发起请求。
    function callbackUrl(captured) {
        var path = textOf(captured);
        if (!path) return '';
        if (path.indexOf('https://') === 0 || path.indexOf('http://') === 0) {
            var rest = path.replace(/^https?:\/\//, '');
            var slash = rest.indexOf('/');
            var host = (slash < 0 ? rest : rest.substring(0, slash)).toLowerCase();
            var tail = slash < 0 ? '/' : rest.substring(slash);
            if (host !== RESOURCE_HOST) return '';
            return RESOURCE_ORIGIN + tail;
        }
        if (path.charAt(0) !== '/') path = '/' + path;
        return RESOURCE_ORIGIN + path;
    }

    function findCallback(html) {
        var match = /url:\s*["']([^"']*\/ajaxStudentSchedule\/past\/callback)["']/.exec(String(html || ''));
        if (!match) return '';
        return callbackUrl(match[1]);
    }

    function httpError(status) {
        if (status === 401 || status === 403) {
            return new Error('教务系统拒绝访问（代码 ' + status + '）：' + LOGIN_HINT);
        }
        return new Error('教务系统返回错误（代码 ' + status + '）：' + LOGIN_HINT);
    }

    function fetchIndex() {
        return fetch(INDEX_URL, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'text/html, */*' }
        }).then(function (response) {
            if (response.status === 401 || response.status === 403 || response.status < 200 || response.status >= 300) {
                throw httpError(response.status);
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
        });
    }

    function fetchSchedule(url, term) {
        return fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            body: '&planCode=' + encodeURIComponent(term.value)
        }).then(function (response) {
            if (response.status === 401 || response.status === 403 || response.status < 200 || response.status >= 300) {
                throw httpError(response.status);
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

    function publicError(message) {
        var line = textOf(message).replace(/[0-9]{6,}/g, '');
        line = textOf(line);
        if (!line) return '';
        if (line.length > 40) line = line.substring(0, 39) + '…';
        return line;
    }

    if (onPortalOrLogin()) {
        return Promise.reject(new Error('这里还是登录页：请先登录，进入教务系统的「学期课表」页面后再点「提取课表」。'));
    }

    var pageTerm = readTermFrom(document);

    return fetchIndex().then(function (html) {
        var url = findCallback(html);
        if (!url) {
            throw new Error('没能从课表页找到课表数据的地址：请打开「学期课表」页面并确认已登录后再点「提取课表」。');
        }
        var term = pageTerm || termFromHtml(html);
        if (!term) {
            throw new Error('课表页上没有可选的学期：请打开「学期课表」页面，等学期列表出来后再点「提取课表」。');
        }
        return fetchSchedule(url, term).then(function (body) {
            return { body: body, term: term };
        });
    }).then(function (packed) {
        var data = parseBody(packed.body);
        var note = publicError(data.errorMessage);
        if (note) {
            throw new Error('教务系统没有返回课表：' + note);
        }
        if (data.errorMessage) {
            throw new Error('教务系统没有返回课表数据：' + LOGIN_HINT);
        }
        var list = planCourses(data);
        if (!list) {
            throw new Error('教务系统没有返回课表数据：登录状态可能已失效，或所选学期没有课。' + LOGIN_HINT);
        }
        return JSON.stringify({
            fetchedDate: localDate(),
            term: { text: packed.term.text, isDefault: packed.term.isDefault },
            rq: null,
            skzc: null,
            slots: collectSlots(data.jcsjbs),
            courses: collectCourses(list)
        });
    });
})()
