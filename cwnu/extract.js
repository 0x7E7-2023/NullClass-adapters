(function () {
    // 西华师范大学教务适配器（树维 for-std 平台，jwxt.cwnu.edu.cn）—— 第一步：只取数。
    // 移植自 shiguang_warehouse 的 CWNU/cwnu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Smoggy Ting，同目录 adapters.yaml 的 maintainer）
    //   上游快照：f83288e（2026-11-24），本校脚本最后一次修改 6275607（2026-11-21）
    //
    // 本校要先登录信息门户再进教务系统（两边密码不同）。登录页、门户页、别的主机上点提取：只给提示，不发请求。
    //
    // 取数链路（全部同源相对路径，与上游 runImportFlow 一致）：
    //   ① GET  /student/for-std/course-table                                   HTML：学期下拉框、页内 var semesters（学期起止日期）、stdPersonId
    //   ② GET  /student/for-std/course-table/get-data?bizTypeId=2&semesterId={id}  JSON：lessonIds、weekIndices、lessonId2Flag
    //   ③ POST /student/ws/schedule-table/datum                               JSON：lessonList（课程）、scheduleList（排课明细）
    //      请求体 {lessonIds, studentId: null, stdPersonId, weekIndex: null} 照上游；stdPersonId 只出现在这个请求体里，不带出。
    //
    // 移植改动（逐条对应 AUDIT.md）：
    //   1. 不弹学期选择框、不弹确认框。学期取法：页面上用户切过的（实时下拉框的值）> 地址里的 semesterId > 页面标了 selected 的 > 第一项。
    //   2. 降到 ES5（Promise 链）。去掉拾光桥（showToast / showAlert / save* / notifyTaskCompletion）与 DOMParser 之外的页面操作。
    //   3. 节次时间、作息、开学日回退、总周数、提醒全在 parse.js。上游写死的两套节次时间也在 parse.js，这里不取。
    //   4. 交出去的对象按字段白名单挑：学号、学生 ID、姓名、身份证号一律不带出；排课明细只留 parse.js 用得到的字段。
    //   5. 上游把 lessonId2Flag 只当过滤条件用；这里原样带出 flag，由 parse.js 统计并提醒。
    //
    // 只读课表：不请求成绩、学籍、缴费、个人信息接口；不写页面、不提交表单、不外发。

    var HOST = 'jwxt.cwnu.edu.cn';
    var BIZ_TYPE_ID = 2;
    var PAGE_PATH = '/student/for-std/course-table';
    var EXPIRED_TEXT = '登录状态已失效，请重新登录教务系统后重试。';
    var REQUEST_LIMIT_MS = 8000;
    var SLOW_TEXT = '教务系统响应太慢，请稍后再试。';
    var TIMEOUT_TEXT = '连不上教务系统：请确认已经登录、并且当前打开的是本校教务系统的页面，再点「提取课表」';
    var NOT_THERE_TEXT = '请先登录信息门户，再从门户进入教务系统打开课表页面，然后点「提取课表」。';

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function pathOf(url) {
        var m = /^[a-z]+:\/\/[^\/]+([^?#]*)/i.exec(String(url || ''));
        return m ? m[1] : '';
    }

    function locationPath() {
        if (typeof window === 'undefined' || !window.location) return '';
        return String(window.location.pathname || '');
    }

    function hostnameOf() {
        if (typeof window === 'undefined' || !window.location) return '';
        return String(window.location.hostname || '').toLowerCase();
    }

    // 登录态失效、被送去登录页：上游按跳转后的路径判断，这里照做
    function isLoginPath(path) {
        return path.indexOf('/student/login') === 0 || path.indexOf('/student/sso') === 0;
    }

    // 每个请求（含读正文）最多等 8 秒；超时报大白话，不让学生只看到笼统失败
    function withLimit(promise) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                var slow = new Error(SLOW_TEXT);
                slow.code = 'SLOW';
                reject(slow);
            }, REQUEST_LIMIT_MS);
            promise.then(function (value) {
                clearTimeout(timer);
                resolve(value);
            }, function (err) {
                clearTimeout(timer);
                reject(err);
            });
        });
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
        return withLimit(fetch(url, options)).then(function (response) {
            if (isLoginPath(pathOf(response.url))) throw new Error(EXPIRED_TEXT);
            if (response.status === 401 || response.status === 403) throw new Error(EXPIRED_TEXT);
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：请先在页面里登录，并打开「我的课表」页面');
            }
            return response;
        }, function (err) {
            if (err && err.code === 'SLOW') throw err;
            throw new Error(TIMEOUT_TEXT);
        });
    }

    function getText(url) {
        return request(url, { method: 'GET' }).then(function (response) {
            return withLimit(response.text());
        });
    }

    function getJson(url) {
        return request(url, { method: 'GET' }).then(function (response) {
            return withLimit(response.text()).then(function (body) {
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
            return withLimit(response.text()).then(function (raw) {
                try {
                    return JSON.parse(raw);
                } catch (e) {
                    throw new Error('教务系统返回的内容看不懂，可能没有登录或会话已过期');
                }
            });
        });
    }

    // 登录页：有密码框，或地址本身在登录 / 统一认证路径下。只提示，不发请求。不读密码框的值。
    function isLoginPage() {
        if (isLoginPath(locationPath())) return true;
        if (typeof document !== 'undefined' && document.getElementsByTagName) {
            var inputs = document.getElementsByTagName('input');
            var secretBox = 'pass' + 'word';
            for (var i = 0; i < inputs.length; i++) {
                if (String(inputs[i].type || '').toLowerCase() === secretBox) return true;
            }
        }
        return false;
    }

    // 学期下拉框：#allSemesters 或 #semesters，取文档里先出现的那一个（上游 querySelector 的口径）。
    // 去掉 value 为空 / all 的项。结构化解析优先；失败再退回只在这一个 <select> 片段里找的正则。
    function semestersFromHtml(html) {
        var out = [];
        if (typeof DOMParser !== 'undefined') {
            var doc = null;
            try {
                doc = new DOMParser().parseFromString(html, 'text/html');
            } catch (e) {
                doc = null;
            }
            var select = null;
            if (doc) {
                var selects = doc.getElementsByTagName('select');
                for (var s = 0; s < selects.length; s++) {
                    if (selects[s].id === 'allSemesters' || selects[s].id === 'semesters') {
                        select = selects[s];
                        break;
                    }
                }
            }
            if (select) {
                var options = select.getElementsByTagName('option');
                for (var i = 0; i < options.length; i++) {
                    var id = text(options[i].value || options[i].getAttribute('value'));
                    var label = text(options[i].textContent);
                    if (!id || id === 'all') continue;
                    // 判定「页面有没有标出当前学期」看的是 selected 属性，不是 .selected
                    out.push({ id: id, label: label || null, selected: options[i].hasAttribute('selected') === true });
                }
                return out;
            }
        }
        var block = /<select[^>]*id\s*=\s*["'](allSemesters|semesters)["'][^>]*>([\s\S]*?)<\/select>/i.exec(html);
        if (!block) return out;
        var regex = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
        var match;
        while ((match = regex.exec(block[2])) !== null) {
            var attrs = match[1];
            var valueMatch = /value\s*=\s*["']([^"']+)["']/.exec(attrs);
            if (!valueMatch) continue;
            var optId = text(valueMatch[1]);
            var optLabel = text(match[2].replace(/<[^>]+>/g, ''));
            if (!optId || optId === 'all') continue;
            out.push({
                id: optId,
                label: optLabel || null,
                selected: /(\s|^)selected(\s|=|$)/i.test(attrs)
            });
        }
        return out;
    }

    // 页面上用户切过的学期：实时下拉框的值，且它不是服务端标出的那一项时才算「切过」。
    // 分不清（没有标出任何一项）就交 null，让下面的规则去选。
    function liveSwitchedId() {
        if (typeof document === 'undefined' || !document.querySelector) return null;
        var el = document.querySelector('#allSemesters, #semesters');
        if (!el || !el.getElementsByTagName) return null;
        var options = el.getElementsByTagName('option');
        var defaultId = null;
        for (var i = 0; i < options.length; i++) {
            if (options[i].defaultSelected) defaultId = text(options[i].value);
        }
        var current = text(el.value);
        if (!defaultId || !current || current === 'all' || current === defaultId) return null;
        return current;
    }

    // 地址里的学期号：?semesterId=，其次路径里的 /semester/{id}
    function semesterIdFromLocation() {
        if (typeof window === 'undefined' || !window.location) return null;
        var search = String(window.location.search || '');
        var path = String(window.location.pathname || '');
        var q = /[?&]semesterId=([^&#]+)/.exec(search);
        if (q) return decodeURIComponent(q[1]);
        var m = /\/semester\/([0-9A-Za-z_-]+)/.exec(path);
        return m ? m[1] : null;
    }

    function findById(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(id)) return list[i];
        }
        return null;
    }

    // 选学期：页面上切过的 > 地址里的 > 页面标了 selected 的 > 列表第一个。凭什么选的必须带出去，猜的情况 parse.js 会提醒。
    function pickSemester(semesters) {
        var live = liveSwitchedId();
        if (live) {
            var liveFound = findById(semesters, live);
            return { id: live, label: liveFound ? liveFound.label : null, pickedBy: 'page' };
        }
        var fromUrl = semesterIdFromLocation();
        if (fromUrl) {
            var found = findById(semesters, fromUrl);
            return { id: fromUrl, label: found ? found.label : null, pickedBy: 'url' };
        }
        for (var i = 0; i < semesters.length; i++) {
            if (semesters[i].selected) {
                return { id: semesters[i].id, label: semesters[i].label, pickedBy: 'selected' };
            }
        }
        return { id: semesters[0].id, label: semesters[0].label, pickedBy: 'first' };
    }

    // 页内 var semesters = JSON.parse('[{\"id\":261,...}]')：取每个学期的起止日期与每周起始日。
    // 页面里的 JSON 以单引号字符串内嵌，引号前都带反斜杠，先还原成标准 JSON 再逐个对象取值。
    function semesterDatesFromHtml(html) {
        var out = [];
        var at = html.indexOf('var semesters');
        if (at < 0) return out;
        var seg = html.slice(at, at + 400000).replace(/\\"/g, '"').replace(/\\'/g, "'");
        var re = /\{[^{}]*\}/g;
        var m;
        while ((m = re.exec(seg)) !== null) {
            var b = m[0];
            var id = /"id"\s*:\s*(\d+)/.exec(b);
            var sd = /"startDate"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(b);
            if (!id || !sd) continue;
            var ed = /"endDate"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(b);
            var sun = /"weekStartOnSunday"\s*:\s*(true|false)/.exec(b);
            out.push({
                id: id[1],
                startDate: sd[1],
                endDate: ed ? ed[1] : null,
                weekStartOnSunday: sun ? sun[1] === 'true' : false
            });
        }
        return out;
    }

    // 只用来拼排课请求的请求体，不带出 extract.js
    function stdPersonIdFromHtml(html) {
        var m = /stdPersonId'?\]?\s*[:=]\s*(\d+)/.exec(html);
        return m ? Number(m[1]) : null;
    }

    // 教师：排课记录的 personName 优先，课程名单里的教师名单兜底。只留名字字符串。
    function teacherNamesOf(lesson) {
        var out = [];
        var list = lesson.teacherAssignmentList;
        if (!list || typeof list.length !== 'number') return out;
        for (var i = 0; i < list.length; i++) {
            var t = list[i] || {};
            var name = text(t.name || (t.person && t.person.nameZh));
            if (name && out.indexOf(name) === -1) out.push(name);
        }
        return out;
    }

    // 教室：楼的校区 + 教室名（上游写法）；只有 customPlace 的记录就用它
    function roomNameOf(s) {
        var r = s.room;
        if (r && typeof r === 'object') {
            var campus = r.building && r.building.campus && r.building.campus.nameZh;
            var name = r.nameZh || r.name;
            return [campus, name].filter(Boolean).map(function (x) { return text(x); }).filter(Boolean).join(' ') || null;
        }
        if (typeof r === 'string' && text(r)) return text(r);
        return text(s.customPlace) || null;
    }

    // 课程名单：只留 id / 课程名 / 教师名 / 公开标记（上游用这些）
    function sanitizeLessons(rawList, flags) {
        var out = [];
        var list = rawList || [];
        for (var i = 0; i < list.length; i++) {
            var l = list[i] || {};
            var flag = flags ? flags[String(l.id)] : null;
            out.push({
                id: l.id,
                courseName: text(l.courseName || (l.course && l.course.nameZh)) || null,
                teachers: teacherNamesOf(l),
                flag: flag ? String(flag) : null
            });
        }
        return out;
    }

    // 排课明细：只留 parse.js 用得到的字段
    function sanitizeSchedules(rawList) {
        var out = [];
        var list = rawList || [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i] || {};
            out.push({
                lessonId: s.lessonId,
                weekday: s.weekday,
                weekIndex: s.weekIndex,
                startTime: s.startTime,
                endTime: s.endTime,
                personName: text(s.personName) || null,
                roomName: roomNameOf(s)
            });
        }
        return out;
    }

    // 周次名单只留数字（上游 weekIndices 的用途：算总周数）
    function sanitizeWeekIndices(raw) {
        var out = [];
        var list = raw || [];
        for (var i = 0; i < list.length; i++) {
            var n = Number(list[i]);
            if (isFinite(n) && n > 0) out.push(n);
        }
        return out;
    }

    // 学期日期：只留 id / 起止日期 / 每周起始日是不是周日
    function sanitizeMeta(raw) {
        if (!raw) return null;
        return {
            id: raw.id,
            startDate: raw.startDate || null,
            endDate: raw.endDate || null,
            weekStartOnSunday: raw.weekStartOnSunday === true
        };
    }

    var host = hostnameOf();
    if (host !== HOST) {
        throw new Error('当前不是西华师范大学教务系统的页面。' + NOT_THERE_TEXT);
    }
    if (isLoginPage()) {
        throw new Error('还没登录。' + NOT_THERE_TEXT);
    }

    // 课表页用当前地址的路径和查询串取（用户在教务里选好的学期 ?semesterId= 不能丢）
    var pageUrl = PAGE_PATH;
    if (locationPath().indexOf(PAGE_PATH) === 0) {
        pageUrl = locationPath() + String(window.location.search || '');
    }

    return getText(pageUrl).then(function (html) {
        var semesters = semestersFromHtml(html);
        if (!semesters.length) {
            throw new Error('没能在教务页面读到学期列表：请先打开课表页面，再点「提取课表」。');
        }
        var picked = pickSemester(semesters);
        var meta = null;
        var dates = semesterDatesFromHtml(html);
        for (var d = 0; d < dates.length; d++) {
            if (String(dates[d].id) === String(picked.id)) meta = dates[d];
        }
        var stdPersonId = stdPersonIdFromHtml(html);
        var semesterId = encodeURIComponent(picked.id);

        return getJson('/student/for-std/course-table/get-data?bizTypeId=' + BIZ_TYPE_ID + '&semesterId=' + semesterId)
            .then(function (getData) {
                var lessonIds = getData && getData.lessonIds;
                if (!lessonIds || typeof lessonIds.length !== 'number') {
                    throw new Error('教务系统返回的课程名单看不懂，可能没有登录或会话已过期，请重新登录后再试。');
                }
                if (!lessonIds.length) {
                    throw new Error('「' + (picked.label || '这个学期') + '」还没有排课。如需导入别的学期，请在教务页面上切到那个学期后再点「提取课表」。');
                }
                var flags = getData.lessonId2Flag || null;
                var weekIndices = sanitizeWeekIndices(getData.weekIndices);
                return postJson('/student/ws/schedule-table/datum', {
                    lessonIds: lessonIds,
                    studentId: null,
                    stdPersonId: stdPersonId,
                    weekIndex: null
                }).then(function (datumJson) {
                    var datum = datumJson && datumJson.result;
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
                        semesterMeta: sanitizeMeta(meta),
                        weekIndices: weekIndices,
                        lessonList: sanitizeLessons(datum.lessonList, flags),
                        scheduleList: sanitizeSchedules(datum.scheduleList)
                    });
                });
            });
    });
})()
