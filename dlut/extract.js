(function () {
    // 大连理工大学本科教务适配器（树维 for-std 平台，jxgl.dlut.edu.cn）
    // 移植自 shiguang_warehouse 的 DLUT/dlut_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 dffzcqs78694）
    //   上游快照：1dc0772（2026-10-17），本校脚本最后一次修改：0de4191（2026-09-17）
    //   学校名与登录地址取自同目录 adapters.yaml（import_url）
    //
    // 取数链路（与上游 runImportFlow 一致，全部是同源相对路径，不写死主机）：
    //   ① GET  /student/for-std/course-table                                      HTML：学期下拉框 #semesters / #allSemesters；stdPersonId
    //   ② GET  /student/for-std/course-table/get-data?bizTypeId=2&semesterId={id}  JSON：lessonIds、timeTableLayoutId
    //   ③ POST /student/ws/schedule-table/datum                                    JSON：lessonList（课程）+ scheduleList（排课明细）
    //   ④ POST /student/ws/schedule-table/timetable-layout                         JSON：courseUnitList（节次时间，取不到就不要）
    //   ⑤ GET  /student/ws/semester/get/{id}                                       JSON：startDate / endDate（取不到就不要）
    //   注意：上游文件头注释写的是 /student/ws/schedule-table/get-data，但上游代码请求的是
    //   /student/for-std/course-table/get-data，本适配器以代码为准。
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 去掉「选学期」弹窗：取用户此刻在教务页面上打开的学期（URL 里的 semesterId，其次
    //      下拉框里写了 selected 属性的一项，最后才是第一项）。选中的学期名与学期总数交给 parse.js，
    //      由它在 warnings 里说明导的是哪一学期。
    //   ② 降到 ES5（Promise 链，无 async/await），去掉拾光桥（showToast / save* / notifyTaskCompletion）。
    //   ③ 上游把整个 lesson / schedule 对象交给解析函数；这里改成字段白名单，只转交 parse.js 真用到的字段。
    //   ④ stdPersonId 只用于 ③ 的请求体，不进交出去的数据，也不进报错文字。
    //   ⑤ 不做任何计算：周次切段、节次映射、开学日回退全在 parse.js（CI 只能跑 parse.js）。
    //
    // 只读课表：不请求成绩、学籍、个人信息、缴费、选课（写操作）类接口；不写页面、不提交表单、不外发。

    var TIMEOUT_TEXT = '连不上教务系统：请确认已经登录、并且当前打开的是教务系统的页面，再点「提取课表」';

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function request(url, init) {
        var headers = {
            'Accept': 'application/json, text/html,*/*;q=0.1',
            'X-Requested-With': 'XMLHttpRequest'
        };
        var options = { method: init.method, credentials: 'include', headers: headers };
        if (init.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(init.body);
        }
        return fetch(url, options).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('教务系统拒绝访问（' + response.status + '）：请先在页面里登录，并打开「课表查询」页面');
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：请先在页面里登录，并打开「课表查询」页面');
            }
            return response;
        }, function () {
            throw new Error(TIMEOUT_TEXT);
        });
    }

    function getText(url) {
        return request(url, { method: 'GET' }).then(function (response) {
            return response.text();
        });
    }

    function getJson(url) {
        return request(url, { method: 'GET' }).then(function (response) {
            return response.text().then(function (body) {
                try {
                    return JSON.parse(body);
                } catch (e) {
                    throw new Error('教务系统返回的内容看不懂，可能没有登录或会话已过期');
                }
            });
        });
    }

    function postJson(url, body) {
        return request(url, { method: 'POST', body: body }).then(function (response) {
            return response.text().then(function (raw) {
                try {
                    return JSON.parse(raw);
                } catch (e) {
                    throw new Error('教务系统返回的内容看不懂，可能没有登录或会话已过期');
                }
            });
        });
    }

    // 学期元数据、节次时间是「有更好、没有也能跑」的那一半：拿不到就交 null，
    // 由 parse.js 推算并在 warnings 里说明（推算了什么必须让用户看见）。
    function optionalOf(promise) {
        return promise.then(null, function () {
            return null;
        });
    }

    // 学期下拉框：#semesters 或 #allSemesters（上游两者都认），去掉 value 为空 / all 的项。
    // 结构化解析优先；失败再退回只在这一个 <select> 片段里找的正则。
    function semestersFromHtml(html) {
        var out = [];
        if (typeof DOMParser !== 'undefined') {
            var doc = null;
            try {
                doc = new DOMParser().parseFromString(html, 'text/html');
            } catch (e) {
                doc = null;
            }
            var select = doc ? (doc.getElementById('semesters') || doc.getElementById('allSemesters')) : null;
            if (select) {
                var options = select.getElementsByTagName('option');
                for (var i = 0; i < options.length; i++) {
                    var id = text(options[i].value);
                    var label = text(options[i].textContent);
                    if (!id || id === 'all' || !label) continue;
                    // 判定「页面有没有标出当前学期」看的是 selected 属性，不是 .selected
                    // （浏览器会把没标 selected 时的第一项的 .selected 置为 true，那样每页都会被当成「标出了」）。
                    out.push({ id: id, label: label, selected: options[i].hasAttribute('selected') === true });
                }
                return out;
            }
        }
        var block = /<select[^>]*id\s*=\s*["'](semesters|allSemesters)["'][^>]*>([\s\S]*?)<\/select>/i.exec(html);
        if (!block) return out;
        var regex = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
        var match;
        while ((match = regex.exec(block[2])) !== null) {
            var attrs = match[1];
            var valueMatch = /value\s*=\s*["']([^"']+)["']/.exec(attrs);
            if (!valueMatch) continue;
            var optId = text(valueMatch[1]);
            var optLabel = text(match[2].replace(/<[^>]+>/g, ''));
            if (!optId || optId === 'all' || !optLabel) continue;
            out.push({
                id: optId,
                label: optLabel,
                selected: /(\s|^)selected(\s|=|$)/i.test(attrs)
            });
        }
        return out;
    }

    // stdPersonId 的三种写法（上游原样保留）。它是个人 ID：只用于 ③ 的请求体。
    function stdPersonIdFromHtml(html) {
        var patterns = [
            /stdPersonId\s*[:=]\s*["']?(\d+)["']?/,
            /std_person_id\s*[:=]\s*["']?(\d+)["']?/,
            /stdPersonId["']?\s*[:=]\s*["']?(\d+)["']?/
        ];
        for (var i = 0; i < patterns.length; i++) {
            var match = patterns[i].exec(html);
            if (match) return match[1];
        }
        return null;
    }

    // 用户此刻打开的学期：URL 里的 semesterId（或 /semester/{id}）优先
    function semesterIdFromLocation() {
        if (typeof window === 'undefined' || !window.location) return null;
        var path = String(window.location.pathname || '');
        var search = String(window.location.search || '');
        var m = /\/semester\/(\d+)/.exec(path);
        if (m) return m[1];
        var q = /[?&]semesterId=(\d+)/.exec(search);
        return q ? q[1] : null;
    }

    function findById(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(id)) return list[i];
        }
        return null;
    }

    // 选学期：URL 里的 > 页面上标了 selected 的 > 列表第一个。凭什么选的必须带出去，猜的情况要写进 warnings。
    function pickSemester(semesters) {
        var idFromUrl = semesterIdFromLocation();
        if (idFromUrl) {
            var found = findById(semesters, idFromUrl);
            return { id: idFromUrl, label: found ? found.label : null, pickedBy: 'url' };
        }
        for (var i = 0; i < semesters.length; i++) {
            if (semesters[i].selected) {
                return { id: semesters[i].id, label: semesters[i].label, pickedBy: 'selected' };
            }
        }
        if (semesters.length) {
            return { id: semesters[0].id, label: semesters[0].label, pickedBy: 'first' };
        }
        return null;
    }

    // 排课明细：lesson 只留 id / 课程名 / 教师名；schedule 只留 parse.js 用到的字段（教室只留 nameZh）
    function sanitizeLessons(rawList) {
        var out = [];
        var list = rawList || [];
        for (var i = 0; i < list.length; i++) {
            var l = list[i] || {};
            var teachers = [];
            var assignments = l.teacherAssignmentList || [];
            for (var t = 0; t < assignments.length; t++) {
                var name = text(assignments[t] && assignments[t].name);
                if (name && teachers.indexOf(name) === -1) teachers.push(name);
            }
            out.push({
                id: l.id,
                courseName: l.courseName || l.name || null,
                teachers: teachers
            });
        }
        return out;
    }

    function sanitizeSchedules(rawList) {
        var out = [];
        var list = rawList || [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i] || {};
            out.push({
                lessonId: s.lessonId,
                weekday: s.weekday,
                startTime: s.startTime,
                endTime: s.endTime,
                weekIndex: s.weekIndex,
                date: s.date || null,
                personName: s.personName || null,
                roomName: s.room && s.room.nameZh ? s.room.nameZh : null,
                customPlace: s.customPlace || null
            });
        }
        return out;
    }

    // 作息表：只留 indexNo / startTime / endTime（HHmm 整数，原样交出，换算在 parse.js）
    function sanitizeUnits(rawList) {
        if (!rawList || typeof rawList.length !== 'number') return null;
        var out = [];
        for (var i = 0; i < rawList.length; i++) {
            var u = rawList[i] || {};
            out.push({ indexNo: u.indexNo, startTime: u.startTime, endTime: u.endTime });
        }
        return out;
    }

    // 学期日期：只留 startDate / endDate / nameZh
    function sanitizeMeta(raw) {
        if (!raw) return null;
        return {
            startDate: raw.startDate || null,
            endDate: raw.endDate || null,
            nameZh: raw.nameZh || null
        };
    }

    return getText('/student/for-std/course-table').then(function (html) {
        var semesters = semestersFromHtml(html);
        var picked = pickSemester(semesters);
        if (!picked) {
            throw new Error('没能在教务页面读到学期列表：请先打开「课表查询」页面，再点「提取课表」');
        }
        // stdPersonId 只为 ③ 的请求体取，不进输出
        var stdPersonId = stdPersonIdFromHtml(html);

        var semesterId = encodeURIComponent(picked.id);
        return getJson('/student/for-std/course-table/get-data?bizTypeId=2&semesterId=' + semesterId).then(function (getData) {
            var lessonIds = (getData && getData.lessonIds) || [];
            var layoutId = getData ? getData.timeTableLayoutId : null;
            if (!lessonIds.length) {
                throw new Error('教务系统没有返回这个学期的选课名单：可能还没排课，或者会话已过期，请确认已登录后重试');
            }

            return Promise.all([
                postJson('/student/ws/schedule-table/datum', {
                    lessonIds: lessonIds,
                    studentId: null,
                    stdPersonId: stdPersonId,
                    weekIndex: null
                }),
                optionalOf(postJson('/student/ws/schedule-table/timetable-layout', { id: layoutId })
                    .then(function (json) {
                        var units = json && json.result ? json.result.courseUnitList : null;
                        return sanitizeUnits(units);
                    })),
                optionalOf(getJson('/student/ws/semester/get/' + semesterId))
            ]).then(function (results) {
                var datum = results[0] && results[0].result;
                if (!datum || !datum.lessonList || !datum.scheduleList) {
                    throw new Error('教务系统返回的课表数据不完整，可能没有登录或会话已过期，请重新登录后再试');
                }

                return JSON.stringify({
                    term: {
                        id: picked.id,
                        label: picked.label,
                        pickedBy: picked.pickedBy
                    },
                    semesterCount: semesters.length,
                    semesterMeta: sanitizeMeta(results[2]),
                    lessonList: sanitizeLessons(datum.lessonList),
                    scheduleList: sanitizeSchedules(datum.scheduleList),
                    courseUnitList: results[1]
                });
            });
        });
    });
})()
