(function () {
    // 安徽财经大学 教务适配器（URP 综合教务系统）—— 第一步：取数
    //
    // 移植自 shiguang_warehouse 的 AUFE/aufe_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 星河欲转）
    //   上游快照 19a65bf（2026-10-19）；本校脚本最后一次修改 80e30cf
    //
    // 取数方式（全部是同源相对路径，不写页面）：
    //   ① GET /student/courseSelect/calendarSemesterCurriculum/index：读学期下拉框（#planCode）和页面里的课表地址
    //      （地址里有一段动态令牌，上游就是从页面脚本里找的）；
    //   ② POST 上一步读到的课表地址，体 &planCode=<学期代码>：取课表（dateList → selectCourseList → timeAndPlaceList）；
    //   ③ POST /ajax/getSectionAndTime（体 planNumber=&ff=f）：节次时间与学期总周数，取不到不阻断；
    //   ④ GET /indexCalendar：只从页面文本里取 var rq（开学日 YYYYMMDD）一个值，不交整页，取不到不阻断。
    //
    // 只把课表相关的字段按白名单挑出来交给 parse.js，周次、节次、拼课全在 parse.js（CI 里能真跑）。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 学期：不弹上游的选择框。用户在课表页里选中了某个学期就用它，否则取教务标了「当前」的那一项
    //      （没有标的取第一项，与上游默认项一致），并告诉 parse.js 它是不是「当前」
    //   ② 开学日：上游让用户确认 / 改写，这里直接交出 rq，由 parse.js 对齐到周一并提醒核对
    //   ③ 课表地址：必须是 /student/courseSelect/thisSemesterCurriculum/[<令牌>/]ajaxStudentSchedule/… 这个形状的本站路径
    //      （不收带主机名、带查询串或别的路径），找不到就报错
    //   ④ 字段白名单：接口响应里夹带的个人信息（学号、人员 ID 等）一律不带出 extract.js
    //   ⑤ 去掉上游的 toast / 保存 / 桥调用：这里只交出数据，导入由宿主完成
    //   ⑥ 门户页 / 登录页上直接提示，不发请求
    var INDEX_PATH = '/student/courseSelect/calendarSemesterCurriculum/index';
    var SLOT_PATH = '/ajax/getSectionAndTime';
    var CALENDAR_PATH = '/indexCalendar';
    var LOGIN_HINT = '请先登录学校的教务系统，并停在教务系统页面（最好是课表页）后再点「提取课表」。';
    // 校内入口门户与 WebVPN 网关：它们不是教务系统本身
    var PORTAL_HOSTS = ['all.aufe.edu.cn', 'vpn.aufe.edu.cn'];

    var COURSE_KEYS = ['courseName', 'coureName', 'attendClassTeacher'];
    var PLACE_KEYS = ['classDay', 'classSessions', 'continuingSession', 'classWeek',
        'campusName', 'teachingBuildingName', 'classroomName'];
    var SLOT_KEYS = ['sessionName', 'djjc', 'startTime', 'endTime'];

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

    // 当前页面是不是门户 / 登录页（不是教务系统本身）：是就直接提示，不发任何请求
    function onPortalOrLogin() {
        var host = String(window.location.hostname || '').toLowerCase();
        var path = String(window.location.pathname || '');
        for (var i = 0; i < PORTAL_HOSTS.length; i++) {
            if (host === PORTAL_HOSTS[i]) return true;
        }
        return path === '/login' || path.indexOf('/login/') === 0;
    }

    function httpError(status) {
        if (status === 401 || status === 403) {
            return new Error('教务系统拒绝访问（代码 ' + status + '）：' + LOGIN_HINT);
        }
        return new Error('教务系统返回错误（代码 ' + status + '）：' + LOGIN_HINT);
    }

    function networkError() {
        return new Error('连不上教务系统：登录状态可能已失效。' + LOGIN_HINT);
    }

    function getText(path) {
        return fetch(path, { method: 'GET', credentials: 'same-origin' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw httpError(response.status);
            return response.text();
        }, function () {
            throw networkError();
        });
    }

    function postForm(path, body) {
        return fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body
        }).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw httpError(response.status);
            return response.text();
        }, function () {
            throw networkError();
        });
    }

    // 课表地址必须是上游实际地址的形状：固定前缀 /student/courseSelect/thisSemesterCurriculum/[<令牌>/]ajaxStudentSchedule/…（令牌段可有可无，同平台两种写法都有），
    // 后面只允许字母数字和 / _ -；不带查询串、不带主机名。别的路径（哪怕名字里碰巧有 ajaxStudentSchedule）一律拒绝，
    // 免得页面内容把一个会改数据的地址当成课表去 POST
    function isSafeSchedulePath(path) {
        if (typeof path !== 'string') return false;
        return /^\/student\/courseSelect\/thisSemesterCurriculum\/(?:[A-Za-z0-9]+\/)?ajaxStudentSchedule\/[A-Za-z0-9\/_-]*$/.test(path);
    }

    // 上游的三种找法：脚本里 url: "…ajaxStudentSchedule…"；脚本里出现标准路径；form 的 action
    function findSchedulePath(doc) {
        var candidates = [];
        var scripts = doc.querySelectorAll('script');
        for (var i = 0; i < scripts.length; i++) {
            var content = scripts[i].textContent || '';
            if (content.indexOf('ajaxStudentSchedule') < 0) continue;
            var m1 = /url\s*:\s*"([^"]+ajaxStudentSchedule[^"]+)"/.exec(content);
            if (m1) candidates.push(m1[1]);
            var m2 = /\/student\/courseSelect\/thisSemesterCurriculum\/[A-Za-z0-9]+\/ajaxStudentSchedule\/past\/callback/.exec(content);
            if (m2) candidates.push(m2[0]);
        }
        var forms = doc.querySelectorAll('form');
        for (var f = 0; f < forms.length; f++) {
            var action = forms[f].getAttribute('action');
            if (action && action.indexOf('ajaxStudentSchedule') >= 0) candidates.push(action);
        }
        for (var c = 0; c < candidates.length; c++) {
            if (isSafeSchedulePath(candidates[c])) return candidates[c];
        }
        return null;
    }

    // 当前页面上（用户正在看的课表页）选中的学期代码；不是课表页或没选就是 null
    function pageSelectedValue() {
        var select = document.getElementById('planCode');
        if (!select || !select.options || select.selectedIndex < 0) return null;
        var option = select.options[select.selectedIndex];
        return option ? String(option.value) : null;
    }

    // 学期下拉框：有值且不是 "no" 的选项。取哪一项：用户在页面上选中的（必须在教务给的列表里）；
    // 否则文字里带「当前」的；再没有就取第一项（与上游默认项一致）
    function readTerm(doc) {
        var select = doc.getElementById('planCode');
        if (!select) return null;
        var options = select.querySelectorAll('option');
        var terms = [];
        for (var i = 0; i < options.length; i++) {
            var value = options[i].getAttribute('value');
            var text = textOf(options[i].textContent);
            if (value && value !== 'no') {
                terms.push({ text: text, value: String(value), isCurrent: text.indexOf('当前') >= 0 });
            }
        }
        if (!terms.length) return null;
        var chosen = pageSelectedValue();
        for (var s = 0; s < terms.length; s++) {
            if (chosen !== null && terms[s].value === chosen) return terms[s];
        }
        for (var t = 0; t < terms.length; t++) {
            if (terms[t].isCurrent) return terms[t];
        }
        return terms[0];
    }

    function readIndex(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var term = readTerm(doc);
        if (!term) {
            if (doc.querySelector('input[type="password"]')) {
                throw new Error('教务系统要求重新登录：' + LOGIN_HINT);
            }
            throw new Error('没有在教务系统里找到学期选项：当前页面可能不是教务系统，或者登录状态已失效。' + LOGIN_HINT);
        }
        var path = findSchedulePath(doc);
        if (!path) {
            throw new Error('没有在教务系统页面里找到课表的入口，页面可能改版了，请稍后再试或反馈给我们');
        }
        return { term: term, path: path };
    }

    function parseBody(body) {
        try {
            var data = JSON.parse(body);
            return data && typeof data === 'object' ? data : {};
        } catch (e) {
            throw new Error('教务系统返回的内容格式不对：登录状态可能已失效，或当前页面不是教务系统');
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

    // 节次时间与学期总周数：取不到（任何原因）都是 null，不阻断导入
    function fetchSlots() {
        return postForm(SLOT_PATH, 'planNumber=&ff=f').then(function (body) {
            var data = JSON.parse(body);
            var slots = null;
            if (data && isArray(data.sectionTime)) {
                slots = [];
                for (var i = 0; i < data.sectionTime.length; i++) {
                    slots.push(pick(data.sectionTime[i], SLOT_KEYS));
                }
            }
            var zs = data && data.section && data.section.zs !== undefined && data.section.zs !== null ?
                textOf(data.section.zs) : null;
            return { slots: slots, zs: zs };
        }).then(null, function () {
            return { slots: null, zs: null };
        });
    }

    // 校历页只取一个值（不交整页 HTML）：var rq 是开学日（YYYYMMDD）。取不到就是 null，不阻断导入
    function fetchCalendarDate() {
        return getText(CALENDAR_PATH).then(function (html) {
            var rq = /var\s+rq\s*=\s*["'](\d{8})["']/.exec(html);
            return rq ? rq[1] : null;
        }).then(null, function () {
            return null;
        });
    }

    if (onPortalOrLogin()) {
        return Promise.reject(new Error('这里还不是教务系统：请先登录学校的校园门户（或 WebVPN），' +
            '从里面点进「教务系统」，停在教务系统页面后再点「提取课表」'));
    }

    return getText(INDEX_PATH).then(readIndex).then(function (index) {
        return postForm(index.path, '&planCode=' + encodeURIComponent(index.term.value)).then(function (body) {
            var list = planCourses(parseBody(body));
            if (!list) {
                throw new Error('教务系统没有返回课表数据：登录状态可能已失效，或所选学期没有课');
            }
            var courses = collectCourses(list);
            return fetchSlots().then(function (slotInfo) {
                return fetchCalendarDate().then(function (rq) {
                    return JSON.stringify({
                        fetchedDate: localDate(),
                        term: { text: index.term.text, isCurrent: index.term.isCurrent },
                        rq: rq,
                        zs: slotInfo.zs,
                        slots: slotInfo.slots,
                        courses: courses
                    });
                });
            });
        });
    });
})()
