(function () {
    // 西安建筑科技大学教务适配器（树维 for-std 平台，swjw.xauat.edu.cn）
    // 移植自 shiguang_warehouse 的 XAUAT/xauat.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Alph4rc；同目录 adapters.yaml 的 maintainer 为 Alph4rc）
    //   上游快照：baf83fa（2026-11-09），本校脚本最后一次修改 fc7a863（2026-09-09）
    //
    // 取数链路（与上游 runImportFlow 一致，全部是同源相对路径）：
    //   ① GET  /student/for-std/course-table                                      HTML：学期下拉框 #semesters / #allSemesters
    //   ② GET  /student/for-std/course-table/get-data?bizTypeId=2&semesterId={id}&dataId=
    //                                                                              JSON：lessonIds（本学期的课程 id）
    //   ③ POST /student/ws/schedule-table/datum                                    JSON：lessonList + scheduleList（按日期给的排课明细）
    //   ④ GET  /student/ws/semester/get/{id}                                       JSON：startDate / endDate（取不到就不要）
    //
    // 移植改动（逐条对得上 AUDIT.md）：
    //   ① 去掉「选学期」弹窗：取用户此刻在教务页面上打开的学期（URL 里的学期号，其次下拉框里写了
    //      selected 属性的一项，最后才是第一项）。选中的学期名与学期总数交给 parse.js 写进提醒。
    //   ② 降到 ES5（Promise 链，无 async/await），去掉拾光桥（showToast / save* / notifyTaskCompletion）。
    //   ③ 上游把整条 schedule 记录交给转换函数；这里改成字段白名单（本文件末尾的 sanitizeSchedules），
    //      响应里夹带的学号、姓名等个人信息不带出。
    //   ④ studentId 传字符串 "null"、bizTypeId=2 是本校接口约定，照上游保留。
    //   ⑤ 不做任何计算：日期换周次、节次、开学日回退全在 parse.js（CI 只能跑 parse.js）。
    //   ⑥ 学期页 HTML 用 DOMParser 解析成独立文档，不插进当前页面（上游就是这样做的）。
    //
    // 只读课表：不请求成绩、学籍、个人信息、缴费、选课（写操作）类接口；不写页面、不提交表单、不外发。

    var HOST = 'swjw.xauat.edu.cn';
    var TIMEOUT_TEXT = '连不上教务系统：请确认已经登录、并且当前打开的是本校教务系统的页面，再点「提取课表」';

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

    // 学期起止日期是「有更好、没有也能跑」的那一半：拿不到就交 null，由 parse.js 推算并写进提醒
    function optionalOf(promise) {
        return promise.then(null, function () {
            return null;
        });
    }

    function hostnameOf() {
        if (typeof window === 'undefined' || !window.location) return '';
        return String(window.location.hostname || '').toLowerCase();
    }

    function hasSemesterSelect() {
        if (typeof document === 'undefined' || !document.getElementById) return false;
        return !!(document.getElementById('semesters') || document.getElementById('allSemesters'));
    }

    // 登录页：有密码框且页面上没有学期下拉，或地址本身是登录入口。只提示，不发请求。
    function isLoginPage() {
        if (hasSemesterSelect()) return false;
        if (typeof document !== 'undefined' && document.getElementsByTagName) {
            var inputs = document.getElementsByTagName('input');
            var secretBox = 'pass' + 'word';
            for (var i = 0; i < inputs.length; i++) {
                if (String(inputs[i].type || '').toLowerCase() === secretBox) return true;
            }
        }
        var href = '';
        if (typeof window !== 'undefined' && window.location) href = String(window.location.href || '');
        if (/\/(login|cas|authserver)(\/|$|\?)/i.test(href)) return true;
        return false;
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

    // 用户此刻打开的学期：URL 里的学期号优先（上游不读 URL，这里沿用已移植件一致的做法）
    function semesterIdFromLocation() {
        if (typeof window === 'undefined' || !window.location) return null;
        var path = String(window.location.pathname || '');
        var search = String(window.location.search || '');
        var m = /\/semester\/([0-9A-Za-z_-]+)/.exec(path);
        if (m) return m[1];
        var q = /[?&]semesterId=([^&#]+)/.exec(search);
        return q ? decodeURIComponent(q[1]) : null;
    }

    function findById(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(id)) return list[i];
        }
        return null;
    }

    // 选学期：URL 里的 > 页面上标了 selected 的 > 列表第一个。凭什么选的必须带出去，猜的情况要写进提醒。
    function pickSemester(semesters) {
        var idFromUrl = semesterIdFromLocation();
        if (idFromUrl && idFromUrl !== 'all') {
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

    // 课程名单：只留 id / 课程名（上游只用这两个字段）
    function sanitizeLessons(rawList) {
        var out = [];
        var list = rawList || [];
        for (var i = 0; i < list.length; i++) {
            var l = list[i] || {};
            out.push({ id: l.id, courseName: l.courseName || null });
        }
        return out;
    }

    // 排课明细：只留 parse.js 用到的字段；教室统一成名字字符串（对象只取 nameZh）
    function sanitizeSchedules(rawList) {
        var out = [];
        var list = rawList || [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i] || {};
            var room = null;
            if (s.room && typeof s.room === 'object') room = s.room.nameZh || null;
            else if (typeof s.room === 'string') room = s.room;
            out.push({
                lessonId: s.lessonId,
                date: s.date || null,
                startTime: s.startTime,
                endTime: s.endTime,
                personName: s.personName || null,
                room: room
            });
        }
        return out;
    }

    // 学期日期：只留 startDate / endDate
    function sanitizeMeta(raw) {
        if (!raw) return null;
        return {
            startDate: raw.startDate || null,
            endDate: raw.endDate || null
        };
    }

    var host = hostnameOf();
    if (host && host !== HOST) {
        throw new Error('请先打开西安建筑科技大学教务系统的课表页面，再点「提取课表」。');
    }
    if (isLoginPage()) {
        throw new Error('还没登录教务系统。请先登录并打开课表页面，再点「提取课表」。');
    }

    return getText('/student/for-std/course-table').then(function (html) {
        var semesters = semestersFromHtml(html);
        var picked = pickSemester(semesters);
        if (!picked) {
            throw new Error('没能在教务页面读到学期列表：请先打开课表页面，再点「提取课表」。');
        }
        var semesterId = encodeURIComponent(picked.id);
        // dataId 留空是本校接口约定，照上游保留
        return getJson('/student/for-std/course-table/get-data?bizTypeId=2&semesterId=' + semesterId + '&dataId=')
            .then(function (getData) {
                var lessonIds = getData && getData.lessonIds;
                if (!lessonIds || typeof lessonIds.length !== 'number') {
                    throw new Error('教务系统返回的课程名单看不懂，可能没有登录或会话已过期，请重新登录后再试。');
                }
                if (!lessonIds.length) {
                    throw new Error('这个学期还没有排课。如需导入别的学期，请在教务页面上切到那个学期后再点「提取课表」。');
                }
                return Promise.all([
                    postJson('/student/ws/schedule-table/datum', { studentId: 'null', lessonIds: lessonIds }),
                    optionalOf(getJson('/student/ws/semester/get/' + semesterId))
                ]).then(function (results) {
                    var datum = results[0] && results[0].result;
                    if (!datum || !datum.lessonList || !datum.scheduleList) {
                        throw new Error('教务系统返回的课表数据不完整，可能没有登录或会话已过期，请重新登录后再试。');
                    }
                    return JSON.stringify({
                        term: {
                            id: picked.id,
                            label: picked.label,
                            pickedBy: picked.pickedBy
                        },
                        semesters: semesters,
                        semesterMeta: sanitizeMeta(results[1]),
                        lessonList: sanitizeLessons(datum.lessonList),
                        scheduleList: sanitizeSchedules(datum.scheduleList)
                    });
                });
            });
    });
})()
