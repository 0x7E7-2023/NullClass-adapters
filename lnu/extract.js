(function () {
    // 辽宁大学 教务适配器（URP 综合教务系统）—— 第一步：取数
    //
    // 移植自 shiguang_warehouse 的 LNU/LNU_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游作者 739C1AE2）
    //   上游快照 1dc0772（2026-10-17）；本校脚本最后一次修改 b0f05f7（2026-09-05）
    //
    // 取数方式（全部是同源相对路径，不写页面）：
    //   ① 页面上有学期下拉框（#planCode）：POST 课表接口，带上下拉框当前选中的学期；没有下拉框：GET（教务的当前学期）。
    //   ② GET /indexCalendar：只从页面文本里取 var rq（开学日 YYYYMMDD）与 var skzc（学期周数）两个值，不交整页。
    //   ③ 校区：用 __ncSelect 问一次（选项与上游一致，默认项按课程的校区名猜）；桥不在 / 取消 / 报错 → null。
    //
    // 只把课表相关的字段按白名单挑出来交给 parse.js，周次、节次、拼课全在 parse.js（CI 里能真跑）。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   ① 学期：不弹上游的选择框，取下拉框选中项，并告诉 parse.js 它是不是服务端默认写了 selected 的那一项
    //   ② 校区：上游用 showSingleSelection 弹窗，这里改用 __ncSelect 提问，回落规则照模板 qau 的 askCampus
    //   ③ 字段白名单：接口响应里夹带的个人信息（学号、人员 ID 等）一律不带出 extract.js
    //   ④ 去掉上游的 toast / 保存 / 桥调用：这里只交出数据，导入由宿主完成
    var API_PATH = '/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback';
    var CALENDAR_PATH = '/indexCalendar';
    var LOGIN_HINT = '请先在页面里登录教务系统，并停在课表页后再提取。';

    var CAMPUS_CODES = ['extract', 'chongshan', 'puhe', 'wusheng'];
    var CAMPUS_ITEMS = ['从教务提取', '内置崇山校区作息', '内置蒲河校区作息', '内置武圣校区作息'];
    var CAMPUS_KEYWORDS = { chongshan: '崇山', puhe: '蒲河', wusheng: '武圣' };
    var CAMPUS_MESSAGE = '教务给的上课时间可能把校区搞混，请优先选你自己所在的校区；' +
        '选「从教务提取」则用教务系统给出的节次时间。';

    var COURSE_KEYS = ['courseName', 'attendClassTeacher'];
    var PLACE_KEYS = ['classDay', 'classSessions', 'continuingSession', 'classWeek', 'weekDescription',
        'campusName', 'teachingBuildingName', 'classroomName'];
    var SLOT_KEYS = ['jc', 'kssj', 'jssj'];

    // 复制模板：少数 WebVPN（深信服那套）把内网站点放在 /http/<加密串>/… 前缀下，
    // 绝对化的相对路径会把这个前缀丢掉；只影响同一个域上的路径，不会指向别的主机。
    function vpnBase() {
        var match = /^\/(https?)\/([A-Za-z0-9_.-]+)\//.exec(window.location.pathname);
        return match ? '/' + match[1] + '/' + match[2] : '';
    }

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

    // 学期下拉框：取当前选中项（selectedIndex）；它是不是写了 selected 属性的那一项，交给 parse.js 判断默认学期
    function readTerm() {
        var select = document.getElementById('planCode');
        if (!select || !select.options || select.options.length === 0) return null;
        var index = select.selectedIndex >= 0 ? select.selectedIndex : 0;
        var option = select.options[index];
        return {
            text: textOf(option.text),
            value: String(option.value),
            isDefault: !!option.defaultSelected
        };
    }

    function requestSchedule(term) {
        var url = vpnBase() + API_PATH;
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
        return fetch(url, init).then(function (response) {
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
            throw new Error('教务系统返回的内容格式不对：登录状态可能已失效，或当前页面不是课表页');
        }
    }

    // 课程：「课程 ID → 课程对象」的字典（数组里每个对象取用），只留白名单字段，课程 ID 不带出
    function collectCourses(xkxx) {
        var maps = [];
        if (isArray(xkxx)) {
            for (var mi = 0; mi < xkxx.length; mi++) {
                if (xkxx[mi] && typeof xkxx[mi] === 'object') maps.push(xkxx[mi]);
            }
        } else if (xkxx && typeof xkxx === 'object') {
            maps.push(xkxx);
        }
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

    // 与上游 guessCampus 同一口径：数各条安排的校区名，出现最多的那个决定默认项（猜不出 → null）
    function guessCampus(courses) {
        var counts = {};
        for (var c = 0; c < courses.length; c++) {
            var places = courses[c].timeAndPlaceList || [];
            for (var p = 0; p < places.length; p++) {
                var campus = textOf(places[p].campusName);
                if (campus) counts[campus] = (counts[campus] || 0) + 1;
            }
        }
        var best = null;
        var bestCount = 0;
        var names = Object.keys(counts);
        for (var n = 0; n < names.length; n++) {
            if (counts[names[n]] > bestCount) {
                best = names[n];
                bestCount = counts[names[n]];
            }
        }
        if (!best) return null;
        var codes = ['chongshan', 'puhe', 'wusheng'];
        for (var i = 0; i < codes.length; i++) {
            if (best.indexOf(CAMPUS_KEYWORDS[codes[i]]) >= 0) return codes[i];
        }
        return null;
    }

    // 校区选项的默认项：猜出哪个校区就选哪一项，猜不出选第 0 项「从教务提取」
    function defaultCampusIndex(guessed) {
        if (guessed === 'chongshan') return 1;
        if (guessed === 'puhe') return 2;
        if (guessed === 'wusheng') return 3;
        return 0;
    }

    function askCampus(guessed) {
        var capable = typeof __ncCapabilities !== 'undefined' && __ncCapabilities && __ncCapabilities.ask;
        if (!capable || typeof __ncSelect !== 'function') return Promise.resolve(null);
        return Promise.resolve().then(function () {
            return __ncSelect({
                title: '选择校区',
                message: CAMPUS_MESSAGE,
                items: CAMPUS_ITEMS,
                defaultIndex: defaultCampusIndex(guessed)
            });
        }).then(function (index) {
            return typeof index === 'number' && CAMPUS_CODES[index] ? CAMPUS_CODES[index] : null;
        }, function () {
            return null;
        });
    }

    // 校历页只取两个值（不交整页 HTML）：var rq 是开学日（YYYYMMDD），var skzc 是学期周数。取不到就是 null，不阻断导入
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

    var term = readTerm();

    return requestSchedule(term).then(parseBody).then(function (raw) {
        var courses = collectCourses(raw.xkxx);
        return askCampus(guessCampus(courses)).then(function (campus) {
            return fetchCalendar().then(function (calendar) {
                return JSON.stringify({
                    fetchedDate: localDate(),
                    term: term ? { text: term.text, isDefault: term.isDefault } : null,
                    campus: campus,
                    rq: calendar ? calendar.rq : null,
                    skzc: calendar ? calendar.skzc : null,
                    errorMessage: typeof raw.errorMessage === 'string' ? raw.errorMessage : null,
                    courses: courses,
                    slots: collectSlots(raw.jcsjbs)
                });
            });
        });
    });
})()
