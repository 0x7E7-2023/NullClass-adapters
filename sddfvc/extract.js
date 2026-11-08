(function () {
    // 山东药品食品职业学院教务适配器（移动端逐周课表）—— 第一步：只取数。
    // 移植自 shiguang_warehouse 的 SDDFVC/sddfvc.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 星河欲转）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e；本校脚本最后修改 14cb2ca
    // 移植改动：自动使用教务当前学期，不弹窗；逐周响应只做字段白名单投影；
    // 登录页、门户及无课表令牌页面零请求；失败周次单独交出，不静默丢周；
    // 删除上游保存配置、保存课程、提示与完成通知等宿主桥调用。
    var JW_HOST = 'jwxt.sddfvc.edu.cn';
    var TERM_PATH = '/mobile/student/mobile_kcb_xq?api_token=';
    var WEEKS_PATH = '/mobile/student/mobile_kcb_weeks?xq=';
    var SCHEDULE_PATH = '/mobile/student/mobile_kcb?api_token=';

    function text(value, limit) {
        if (value === null || value === undefined) return '';
        var out = String(value).replace(/\s+/g, ' ').trim();
        return out.length > limit ? out.substring(0, limit) : out;
    }

    function originOf() {
        var loc = window.location;
        return loc.origin || (loc.protocol + '//' + loc.host);
    }

    function tokenOf() {
        var found = /[?&]api_token=([^&#]*)/.exec(String(window.location.search || ''));
        if (!found) return '';
        try {
            return decodeURIComponent(found[1]);
        } catch (e) {
            return '';
        }
    }

    function failure(response) {
        return new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再点「提取课表」');
    }

    function requestJson(url) {
        return fetch(url, { method: 'GET', credentials: 'include' }).then(function (response) {
            if (response.status < 200 || response.status >= 300) throw failure(response);
            return response.json().then(null, function () {
                throw new Error('教务系统返回的内容格式不对：请确认已登录并能看到课表，再点「提取课表」');
            });
        }, function () {
            throw new Error('连不上教务系统：请确认已登录并打开教务课表页，再点「提取课表」');
        });
    }

    function currentTerm(json) {
        var data = json && json.data ? json.data : {};
        var current = data.xq_current || {};
        var id = text(current.id, 40);
        if (!id) throw new Error('教务系统没有标明当前学期：请在教务课表页切换学期后再点「提取课表」');
        var name = text(current.xqmc, 60);
        var list = Array.isArray(data.xq_all) ? data.xq_all : [];
        for (var i = 0; i < list.length; i++) {
            if (text(list[i] && list[i].id, 40) === id) {
                if (!name) name = text(list[i].xqmc, 60);
                break;
            }
        }
        return { id: id, name: name };
    }

    function calendarOf(json) {
        var list = json && json.data && Array.isArray(json.data.week_list) ? json.data.week_list : [];
        if (!list.length) throw new Error('教务系统没有给出这个学期的周次：请确认课表已经发布后再点「提取课表」');
        var weeks = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            weeks.push({ id: text(item.id, 10), startDate: text(item.start_date, 10) });
        }
        return weeks;
    }

    function valuesOf(object) {
        var out = [];
        if (!object || typeof object !== 'object') return out;
        for (var key in object) {
            if (Object.prototype.hasOwnProperty.call(object, key)) out.push(object[key]);
        }
        return out;
    }

    // 只保留 parse.js 使用的课表字段；学号、姓名、人员编号、证件号、手机号及其他响应内容不交出。
    function projectWeek(json, week) {
        var source = json && json.data ? json.data : {};
        var entries = [];
        for (var day = 1; day <= 7; day++) {
            var dayContent = source['xq' + day];
            if (!dayContent || typeof dayContent !== 'object') continue;
            for (var slot in dayContent) {
                if (!Object.prototype.hasOwnProperty.call(dayContent, slot)) continue;
                var items = valuesOf(dayContent[slot]);
                for (var i = 0; i < items.length; i++) {
                    var item = items[i] || {};
                    var rawDetails = valuesOf(item.pkmx);
                    var details = [];
                    for (var d = 0; d < rawDetails.length; d++) {
                        var detail = rawDetails[d] || {};
                        var zc = detail.zc || {};
                        var teachers = Array.isArray(detail.teacher) ? detail.teacher : [];
                        var firstTeacher = teachers.length ? teachers[0] : {};
                        details.push({
                            weeks: text(zc.zc, 100),
                            parity: (typeof zc.dsz === 'number' || typeof zc.dsz === 'string') ? zc.dsz : null,
                            teacher: text(firstTeacher && firstTeacher.xm, 100),
                            location: text(detail.classroom, 200)
                        });
                    }
                    entries.push({
                        day: day,
                        slot: text(slot, 20),
                        rawName: text(item.pkbmc, 300),
                        details: details
                    });
                }
            }
        }
        return { week: week, entries: entries };
    }

    function fetchWeek(base, token, termId, week) {
        var url = base + SCHEDULE_PATH + encodeURIComponent(token) +
            '&xq=' + encodeURIComponent(termId) + '&week=' + encodeURIComponent(week.id);
        return requestJson(url).then(function (json) {
            return projectWeek(json, week.id);
        });
    }

    var hostname = String(window.location.hostname || '').toLowerCase();
    var path = String(window.location.pathname || '').toLowerCase();
    if (hostname === 'cas.sddfvc.edu.cn' || path.indexOf('/login') >= 0) {
        throw new Error('当前打开的是登录页。请先登录并进入教务课表页，再点「提取课表」');
    }
    if (hostname !== JW_HOST) {
        throw new Error('请先登录山东药品食品职业学院教务系统，打开带有课表访问令牌的教务课表页后再点「提取课表」');
    }
    var token = tokenOf();
    if (!token) {
        throw new Error('当前教务课表页缺少课表访问令牌：请从学校门户重新进入课表页后再点「提取课表」');
    }
    var base = originOf();
    return requestJson(base + TERM_PATH + encodeURIComponent(token)).then(function (termJson) {
        var term = currentTerm(termJson);
        var weeksUrl = base + WEEKS_PATH + encodeURIComponent(term.id) + '&api_token=' + encodeURIComponent(token);
        return requestJson(weeksUrl).then(function (weeksJson) {
            var weeks = calendarOf(weeksJson);
            var responses = [];
            var failedWeeks = [];
            var chain = Promise.resolve();
            for (var i = 0; i < weeks.length; i++) {
                (function (week) {
                    chain = chain.then(function () {
                        return fetchWeek(base, token, term.id, week).then(function (projected) {
                            responses.push(projected);
                        }, function () {
                            failedWeeks.push(week.id);
                        });
                    });
                })(weeks[i]);
            }
            return chain.then(function () {
                if (!responses.length) {
                    throw new Error('各周课表都没有取到：请确认登录状态有效且课表已经发布，再点「提取课表」');
                }
                return JSON.stringify({ term: term, calendar: weeks, responses: responses, failedWeeks: failedWeeks });
            });
        });
    });
})()
