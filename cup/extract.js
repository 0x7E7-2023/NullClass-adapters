(function () {
    // 中国石油大学（北京）教务适配器（树维 for-std 平台，bk.cup.edu.cn）
    // 移植自 shiguang_warehouse 的 CUP/cup_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 larryyan；同目录 adapters.yaml 的 maintainer 也是 larryyan）
    //   上游快照：03d161a（2026-11-01），本校脚本最后提交 80e30cf（合并提交，提交者不是作者）
    //
    // 平台说明：与已移植的 cupk / jstc / zzu 同属树维学生端。取数是三条 GET：
    // 课表页 HTML、学期起止、print-data。模板用 cupk（同一套路径，只换主机和学校名），差别见 AUDIT.md。
    //
    // 移植改动：
    //   1. 不搬上游的确认弹窗，也不弹窗问学期。已登录就取页面上的当前学期：
    //      地址里的 semester/{id}，其次 #semesters 或 #allSemesters 上写了 selected 属性的一项，最后才用列表第一个。
    //   2. 登录页、别的网站上点提取：只提示，不发请求。
    //   3. 降到 ES5（Promise 链）。去掉拾光桥。
    //   4. 学期起止、节次时间原样交出，计算都在 parse.js。
    //   5. 交出去的对象按字段白名单挑，学生学号、姓名、证件号不带出。
    //
    // 请求（全部打 bk.cup.edu.cn，见 AUDIT.md）：
    //   1. GET /student/for-std/course-table
    //   2. GET /student/ws/semester/get/{id}          拿不到就交 null，不阻断
    //   3. GET /student/for-std/course-table/semester/{id}/print-data
    //
    // 只读课表：不读成绩、学籍、个人信息，不写页面，不外发。

    var BASE = 'https://bk.cup.edu.cn';
    var HOST = 'bk.cup.edu.cn';

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function request(url, accept) {
        return fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': accept,
                'X-Requested-With': 'XMLHttpRequest'
            }
        }).then(function (response) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('请先登录教务系统，并打开课表页面后再点「提取课表」。');
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）。请打开课表页面后再试。');
            }
            return response;
        }, function () {
            throw new Error('连不上教务系统。请确认已经登录，并且当前打开的是课表页面，再点「提取课表」。');
        });
    }

    function getText(url) {
        return request(url, 'text/html,application/xhtml+xml,*/*;q=0.8').then(function (response) {
            return response.text();
        });
    }

    function getJson(url) {
        return request(url, 'application/json, */*;q=0.1').then(function (response) {
            return response.text().then(function (body) {
                try {
                    return JSON.parse(body);
                } catch (e) {
                    throw new Error('教务系统返回的内容无法读取。请打开课表页面后再试。');
                }
            });
        });
    }

    function getJsonOptional(url) {
        return getJson(url).then(null, function () {
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

    function optionsFromSelect(select) {
        var out = [];
        if (!select || !select.getElementsByTagName) return out;
        var options = select.getElementsByTagName('option');
        for (var i = 0; i < options.length; i++) {
            var id = text(options[i].value);
            var label = text(options[i].textContent);
            if (!id || id === 'all' || !label) continue;
            out.push({
                id: id,
                label: label,
                selected: options[i].hasAttribute('selected') === true
            });
        }
        return out;
    }

    function optionsFromDocument(html) {
        if (typeof DOMParser === 'undefined') return [];
        var doc = null;
        try {
            doc = new DOMParser().parseFromString(html, 'text/html');
        } catch (e) {
            return [];
        }
        if (!doc || !doc.getElementById) return [];
        var select = doc.getElementById('semesters') || doc.getElementById('allSemesters');
        return optionsFromSelect(select);
    }

    function optionsFromRegex(fragment) {
        var out = [];
        var regex = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
        var match;
        while ((match = regex.exec(fragment)) !== null) {
            var attrs = match[1];
            var valueMatch = /value\s*=\s*["']([^"']+)["']/.exec(attrs);
            if (!valueMatch) continue;
            var id = text(valueMatch[1]);
            var label = text(match[2].replace(/<[^>]+>/g, ''));
            if (!id || id === 'all' || !label) continue;
            out.push({
                id: id,
                label: label,
                selected: /(\s|^)selected(\s|=|$)/i.test(attrs)
            });
        }
        return out;
    }

    function semestersFromHtml(html) {
        var out = optionsFromDocument(html);
        if (out.length) return out;
        var block = /<select[^>]*id\s*=\s*["']semesters["'][^>]*>([\s\S]*?)<\/select>/i.exec(html);
        if (!block) {
            block = /<select[^>]*id\s*=\s*["']allSemesters["'][^>]*>([\s\S]*?)<\/select>/i.exec(html);
        }
        if (!block) return out;
        return optionsFromRegex(block[1]);
    }

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

    function pickSemester(semesters) {
        var idFromUrl = semesterIdFromLocation();
        if (idFromUrl && idFromUrl !== 'all') {
            var found = findById(semesters, idFromUrl);
            return {
                id: idFromUrl,
                label: found ? found.label : null,
                pickedBy: 'url'
            };
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

    // 同一份 print-data 外壳只认这一处：studentTableVms[0]，其次 studentTableVm。
    function tableOf(published) {
        if (!published || typeof published !== 'object') return null;
        if (published.studentTableVms && published.studentTableVms.length) return published.studentTableVms[0];
        if (published.studentTableVm) return published.studentTableVm;
        return null;
    }

    function pickTeachers(raw) {
        if (typeof raw === 'string') return raw;
        if (!raw || typeof raw.length !== 'number') return null;
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var item = raw[i];
            if (item && typeof item === 'object') {
                out.push(text(item.name || item.personName || item.teacherName || ''));
            } else {
                out.push(item);
            }
        }
        return out;
    }

    function pickActivity(act) {
        act = act || {};
        return {
            courseName: act.courseName,
            teachers: pickTeachers(act.teachers),
            campus: act.campus,
            room: act.room,
            building: act.building,
            weekday: act.weekday,
            startUnit: act.startUnit,
            endUnit: act.endUnit,
            weekIndexes: act.weekIndexes
        };
    }

    function pickUnit(unit) {
        unit = unit || {};
        var indexNo = unit.indexNo;
        if (indexNo === null || indexNo === undefined) indexNo = unit.index;
        if (indexNo === null || indexNo === undefined) indexNo = unit.periodIndex;
        var startTime = unit.startTime;
        if (startTime === null || startTime === undefined) startTime = unit.start;
        var endTime = unit.endTime;
        if (endTime === null || endTime === undefined) endTime = unit.end;
        return { indexNo: indexNo, startTime: startTime, endTime: endTime };
    }

    function pickMeta(meta) {
        if (!meta || typeof meta !== 'object') return null;
        return {
            startDate: meta.startDate,
            endDate: meta.endDate,
            weekStartOnSunday: meta.weekStartOnSunday === true,
            firstDayOfWeek: meta.firstDayOfWeek,
            nameZh: meta.nameZh,
            name: meta.name
        };
    }

    var host = hostnameOf();
    if (host && host !== HOST) {
        throw new Error('请先打开中国石油大学（北京）教务系统的课表页面，再点「提取课表」。');
    }
    if (isLoginPage()) {
        throw new Error('还没登录教务系统。请先登录并打开课表页面，再点「提取课表」。');
    }

    return getText(BASE + '/student/for-std/course-table').then(function (html) {
        var semesters = semestersFromHtml(html);
        var picked = pickSemester(semesters);
        if (!picked) {
            throw new Error('没能在课表页面读到学期列表。请先打开课表页面，再点「提取课表」。');
        }
        var id = encodeURIComponent(picked.id);
        return Promise.all([
            getJsonOptional(BASE + '/student/ws/semester/get/' + id),
            getJson(BASE + '/student/for-std/course-table/semester/' + id + '/print-data')
        ]).then(function (results) {
            var table = tableOf(results[1]);
            var activities = [];
            var source = [];
            if (table && table.activities && table.activities.length) source = table.activities;
            else if (results[1] && results[1].activities) source = results[1].activities;
            for (var i = 0; i < source.length; i++) activities.push(pickActivity(source[i]));
            var units = [];
            var rawUnits = [];
            if (table && table.timeTableLayout && table.timeTableLayout.courseUnitList) {
                rawUnits = table.timeTableLayout.courseUnitList;
            }
            for (var u = 0; u < rawUnits.length; u++) units.push(pickUnit(rawUnits[u]));
            return JSON.stringify({
                term: {
                    id: picked.id,
                    label: picked.label,
                    pickedBy: picked.pickedBy
                },
                semesters: semesters,
                semesterMeta: pickMeta(results[0]),
                activities: activities,
                courseUnitList: units
            });
        });
    });
})()
