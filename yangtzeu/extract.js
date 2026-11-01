(function () {
    // 长江大学 教务适配器（树维 EAMS，经 aTrust 网关的 jwc3 主机）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 YANGTZEU/yu.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Jursin）
    //   上游快照 03d161a416db6fa5f5f7835a377821c077b670b4；yu.js 最后改动 80e30cf（2026-09-23）
    //
    // 上游课表以空表格返回，课程写在 TaskActivity 构造调用里。本文件只把探测页上用得到的
    // 学期编号、学期列表字段、课表原文取回来。抽课、节次映射、周次切段全部在 parse.js。
    //
    // 移植改动：
    //   1. 新语法改成 ES5（then 链；不用模板串、箭头函数、块级声明关键字、扩展运算符）
    //   2. 课表请求只打 jwc3-yangtzeu-edu-cn-s.atrust.yangtzeu.edu.cn。当前页不是这台主机
    //      （统一认证、门户、其它网站）时直接提示，不发请求。登录主机不进 allowHosts
    //   3. 学号只放进发往本校教务的课表请求体，不进输出。探测页原文也不交出去
    //   4. 学期自动取当前页选中的学期，不再弹窗让人挑最近八个学期
    //   5. 学期列表用花括号配平读字段，不执行取回来的代码（上游用 Function 构造器）
    //   6. 学期列表取不到就交空数组，课表照常取；只有课表原文里没有 TaskActivity 才算失败
    //   7. 不请求上游没有的备用探测页，也不跟着表单 action 改地址
    //   8. 桥调用与弹窗没有移植；节次时间在 parse.js 里进课表并写进提醒
    //
    // 取数（都在当前页这台 jwc3 主机上，最多 3 条）：
    //   1. GET  /eams/courseTableForStd.action?sf_request_type=ajax
    //   2. POST /eams/dataQuery.action?sf_request_type=ajax          dataType=semesterCalendar
    //   3. POST /eams/courseTableForStd!courseTable.action?sf_request_type=ajax
    //
    // 登录由用户在页面里完成。本脚本不读、不存、不上报账号密码。

    var COURSE_HOST = 'jwc3-yangtzeu-edu-cn-s.atrust.yangtzeu.edu.cn';
    var EAMS = '/eams';

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function pageHost() {
        var loc = window.location || {};
        return textOf(loc.hostname).toLowerCase();
    }

    function originOf() {
        var loc = window.location || {};
        if (loc.origin && loc.origin !== 'null') return loc.origin;
        return textOf(loc.protocol) + '//' + textOf(loc.host);
    }

    function request(url, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*'
            }
        };
        if (typeof body === 'string') options.body = body;
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再点「提取课表」');
            }
            return response.text();
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    function optionalPost(url, body) {
        return request(url, 'POST', body).then(function (text) {
            return textOf(text);
        }, function () {
            return '';
        });
    }

    function groupOf(source, pattern) {
        var m = pattern.exec(textOf(source));
        return m ? textOf(m[1]) : '';
    }

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
    }

    var RE_IDS_FORM = /bg\.form\.addInput\(\s*form\s*,\s*["']ids["']\s*,\s*["']([0-9]+)["']\s*\)/;
    var RE_IDS_PARAM = /["']ids["']\s*[,:=]\s*["']?([0-9]+)/;
    var RE_TAG_ID = /id=["'](semesterBar[0-9]+Semester)["']/;

    function probeOf(html) {
        var source = textOf(html);
        var ids = groupOf(source, RE_IDS_FORM) || groupOf(source, RE_IDS_PARAM);
        var tagId = groupOf(source, RE_TAG_ID);
        var value = '';
        if (tagId) {
            var at = source.indexOf('id="' + tagId + '"');
            if (at < 0) at = source.indexOf("id='" + tagId + "'");
            if (at >= 0) {
                var tagStart = source.lastIndexOf('<', at);
                var tagEnd = source.indexOf('>', at);
                var tag = source.substring(tagStart < 0 ? 0 : tagStart, tagEnd < 0 ? source.length : tagEnd);
                value = groupOf(tag, /value=["']?([0-9]+)/);
            }
        }
        return { ids: ids, tagId: tagId, value: value };
    }

    var RE_FIELD = /["']?([A-Za-z_$][A-Za-z0-9_$]*)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}]*)/g;

    function unquoteJs(raw) {
        var s = textOf(raw).replace(/^\s+|\s+$/g, '');
        if (!s) return '';
        var first = s.charAt(0);
        if ((first === '"' || first === "'") && s.length >= 2 && s.charAt(s.length - 1) === first) {
            return s.substring(1, s.length - 1);
        }
        return s;
    }

    function matchBraceGroup(source, openIndex) {
        var depth = 0;
        var quote = '';
        var i;
        var ch;
        for (i = openIndex; i < source.length; i++) {
            ch = source.charAt(i);
            if (quote) {
                if (ch === '\\') { i++; continue; }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '{') { depth++; continue; }
            if (ch === '}') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function fieldsOf(body) {
        var fields = {};
        RE_FIELD.lastIndex = 0;
        var m;
        while ((m = RE_FIELD.exec(body)) !== null) {
            var key = m[1];
            var value = unquoteJs(m[2]);
            if (value === '' || value === 'null' || value === 'undefined') continue;
            if (fields[key] === undefined) fields[key] = value;
        }
        return fields;
    }

    var DATE_START_KEYS = ['startDate', 'beginDate', 'dateBegin', 'startTime', 'dateStart', 'start'];
    var DATE_END_KEYS = ['endDate', 'finishDate', 'dateEnd', 'endTime', 'dateFinish', 'end'];

    function pickDate(fields, keys) {
        var i;
        for (i = 0; i < keys.length; i++) {
            var value = fields[keys[i]];
            if (value !== undefined && value !== null && value !== '') return textOf(value);
        }
        return '';
    }

    function parseSemesterResponse(raw) {
        var source = textOf(raw);
        var out = [];
        if (!source) return out;
        var inner = [];
        var outer = [];
        var i;
        for (i = 0; i < source.length && inner.length + outer.length < 500; i++) {
            if (source.charAt(i) !== '{') continue;
            var close = matchBraceGroup(source, i);
            if (close < 0) continue;
            var body = source.substring(i + 1, close);
            if (body.indexOf('{') < 0) inner.push(body); else outer.push(body);
        }
        var groups = inner.length ? inner : outer;
        for (i = 0; i < groups.length; i++) {
            var fields = fieldsOf(groups[i]);
            if (fields.id === undefined || !textOf(fields.id)) continue;
            var entry = {
                id: textOf(fields.id),
                schoolYear: textOf(fields.schoolYear),
                term: textOf(fields.name),
                startDate: pickDate(fields, DATE_START_KEYS),
                endDate: pickDate(fields, DATE_END_KEYS)
            };
            var seen = false;
            for (var k = 0; k < out.length; k++) if (out[k].id === entry.id) seen = true;
            if (!seen) out.push(entry);
        }
        return out;
    }

    if (pageHost() !== COURSE_HOST) {
        throw new Error('请先登录教务，打开课表页面后再点「提取课表」。现在这个页面还不是课表页。');
    }

    var base = originOf() + EAMS;

    return request(base + '/courseTableForStd.action?sf_request_type=ajax', 'GET', null).then(function (html) {
        var probe = probeOf(html);
        if (!probe.ids) {
            throw new Error('没能从教务页面读到你的选课身份：登录状态可能已失效，或教务系统改了课表页。请重新登录并打开课表页后再点「提取课表」');
        }
        var body = probe.tagId
            ? 'tagId=' + encodeURIComponent(probe.tagId) + '&dataType=semesterCalendar'
            : 'dataType=semesterCalendar';
        return optionalPost(base + '/dataQuery.action?sf_request_type=ajax', body).then(function (semesterRaw) {
            if (semesterRaw && semesterRaw.indexOf('semesters') < 0 && probe.tagId) {
                return optionalPost(base + '/dataQuery.action?sf_request_type=ajax', 'dataType=semesterCalendar').then(function (retry) {
                    return (retry && retry.indexOf('semesters') >= 0) ? retry : '';
                });
            }
            return (semesterRaw && semesterRaw.indexOf('semesters') >= 0) ? semesterRaw : '';
        }).then(function (semesterRaw) {
            var courseBody = [
                'ignoreHead=1',
                'setting.kind=std',
                'startWeek=',
                'semester.id=' + encodeURIComponent(probe.value),
                'ids=' + encodeURIComponent(probe.ids)
            ].join('&');
            return request(base + '/courseTableForStd!courseTable.action?sf_request_type=ajax', 'POST', courseBody).then(function (courseHtml) {
                var text = textOf(courseHtml);
                if (!text || text.indexOf('TaskActivity') < 0) {
                    throw new Error('教务系统没有返回可解析的课表数据：登录状态可能已失效，或这个学期还没排课。请重新登录、在课表页里确认能看到课，再点「提取课表」');
                }
                return JSON.stringify({
                    today: localTodayIso(),
                    semesters: parseSemesterResponse(semesterRaw),
                    currentSemesterId: probe.value || null,
                    courseHtml: text
                });
            });
        });
    });
})()
