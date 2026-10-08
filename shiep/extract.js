(function () {
    // 上海电力大学教务适配器（树维 EAMS 平台，jw.shiep.edu.cn/eams）—— 第一步：只取数，
    // 把教务的原始数据（学期日历原文 + 课表 HTML 全文）原样交出去。
    //
    // 移植自 shiguang_warehouse 的 SHIEP/SHIEP.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游 maintainer zt11125）
    //   上游快照 ff72d1f08782df965cae110034a9d87cd91e0c07（2026-10-08）
    //   上游文件头写明：本脚本改自本仓库中天津农学院（TJAU）的适配脚本（作者：星河欲转）
    //
    // 平台是**树维 EAMS**（/eams/，上海树维信息科技有限公司 SupWisdom，新开普子公司），不是强智。
    // 本件与模板 tjau 同族，但请求方式不同：上游 SHIEP 的三条请求都**不带** ?sf_request_type=ajax，
    // 拿回来的是完整页面 / 完整响应，本件照此不带。
    //
    // 移植改动：
    //   ① ES6 → ES5：async/await 改成 then 链，去掉模板串、箭头函数与块级声明关键字
    //   ② 三条请求的地址按当前页面的 origin + 上下文路径 /eams 拼；origin 的主机名必须是 jw.shiep.edu.cn，
    //      否则一条请求都不发（eamsBase 里校验）。allowHosts 留空（见 AUDIT.md §1）
    //   ③ 不弹「选择学期」：上游用 showSingleSelection 让用户选，移植件自动取当前学期。
    //      选择顺序：课表页 semesterCalendar 里的当前学期 id → 学期日历标出的当前学期 →
    //      起止日期包含今天的那一个 → 起始日期最晚的那一个 → 列表最后一项。
    //      选中的依据原样交给 parse.js，写进 warnings。要导入别的学期，用户在教务页面里切一下再点「提取课表」
    //   ④ 学期日历：上游 SHIEP.js 用正则抽取学期列表（它的注释写明不对响应体求值），没有动态求值。
    //      本件另要学期的起止日期（推开学日、算总周数），正则够不到，于是加了一组只扫值、不求值的字面量解析函数
    //   ⑤ 重试：上游「响应不完整就重试，最多 4 次、间隔 1 秒」保留；另加两道上限，上游没有：
    //      每次尝试开始前检查脚本已耗时，超过 15 秒就不再发起新的尝试并带着原因报错；
    //      单次请求 6 秒没有响应也按失败处理（脚本整体超时是 30 秒，见规范 §3；余下的时间留给最后一次请求和解析）
    //   ⑥ 课表响应校验：必须含 new CourseTable；没有 new TaskActivity 时报「该学期没有课程数据」
    //   ⑦ 登录跳转识别保留：响应里出现 authserver / 统一身份认证 / 应用未注册 视为未登录，
    //      按不完整响应处理，重试用尽后报「请求被重定向到统一身份认证，请先登录教务系统」
    //   ⑧ 只取数：TaskActivity 解析、位图周次、课程合并全部挪到 parse.js（CI 只跑得到那一段）。
    //      本文件交出去的是**课表 HTML 全文**与**学期日历原文**，一个字都不解析成课程
    //   ⑨ 上游的 showToast / notifyTaskCompletion / saveImportedCourses / savePresetTimeSlots
    //      这些桥调用全部没有移植；作息表也不在这里推
    //   ⑩ 学号 ids（上游从课表页的 bg.form.addInput(form,"ids",...) 里取）**只用于发课表那一条请求，
    //      不写进输出。输出的课表 HTML 原文是否带个人信息，还没有用真实样本核实（见 AUDIT.md §7）
    //
    // 取数方式：同源请求，三条，全部打在本校教务主机上（地址由 window.location 拼出来）：
    //   ① GET  /eams/courseTableForStd.action                          读学号 ids、学期组件 id、页面当前学期
    //   ② POST /eams/dataQuery.action                                  body: tagId=..&dataType=semesterCalendar&value=..&empty=false
    //   ③ POST /eams/courseTableForStd!courseTable.action              body: ignoreHead=1&setting.kind=std&semester.id=..&ids=..
    // ②③ 的请求体字段与上游 SHIEP.js 一致。登录全程由用户在 WebView 里手工完成，
    // 本脚本不读、不存、不上报任何账号信息。

    var startedAt = Date.now();
    var EAMS = '/eams';
    var MAX_RESPONSE_CHARS = 4000000;
    var MAX_ATTEMPTS = 4;             // 同一条请求最多发几次（上游同款）
    var RETRY_DELAY_MS = 1000;        // 两次尝试之间等 1 秒（上游同款）
    var REQUEST_TIMEOUT_MS = 6000;    // 单次请求的等待上限（上游没有，本件补上）
    var TIME_BUDGET_MS = 15000;       // 脚本总耗时超过这个数，不再发起新的尝试（脚本总超时 30 秒，留出余量）
    var BACKSLASH = String.fromCharCode(92);
    var LOGIN_MESSAGE = '请求被重定向到统一身份认证，请先登录教务系统';
    var SCHOOL_HOST = 'jw.shiep.edu.cn';  // 只许请求本校教务主机

    function elapsedMs() {
        return Date.now() - startedAt;
    }

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 树维 EAMS 的上下文路径是 /eams；万一挂在前缀下（门户 / 网关），跟着当前地址里的那一段走
    function eamsBase() {
        if (window.location.hostname !== SCHOOL_HOST) {
            throw new Error('当前页面不是上海电力大学教务系统（' + SCHOOL_HOST + '），请先在教务系统里登录，再点「提取课表」');
        }
        var path = String(window.location.pathname || '');
        var at = path.indexOf(EAMS + '/');
        if (at > 0) return originOf() + path.substring(0, at + EAMS.length);
        return originOf() + EAMS;
    }

    function textOf(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function trimOf(value) {
        return textOf(value).replace(/^\s+|\s+$/g, '');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function todayIso() {
        var now = new Date();
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    function withTimeout(promise, ms, label) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                reject(new Error(label + '超过 ' + Math.round(ms / 1000) + ' 秒没有响应，请检查网络后重试'));
            }, ms);
            promise.then(function (value) {
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    // 只带上游带的头：GET 不带任何头，POST 只带表单类型（上游 SHIEP.js 的写法）
    function request(url, method, body) {
        var options = { method: method, credentials: 'include' };
        if (method === 'POST') {
            options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            options.body = textOf(body);
        }
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）' +
                    '：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text();
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        }).then(function (text) {
            var value = textOf(text);
            if (value.length > MAX_RESPONSE_CHARS) {
                throw new Error(
                    '教务系统的响应异常大（' + value.length + ' 字符），已停止以免交出被截断的数据；' +
                    '请确认已经登录、并开着课表页时再点「提取课表」'
                );
            }
            return value;
        });
    }

    function looksLikeLoginPage(html) {
        return /authserver|统一身份认证|应用未注册/.test(html);
    }

    // 带重试的请求：只有通过 validate 的响应才算拿到完整内容。
    // 传输错误、登录跳转、响应不完整都算一次失败；失败后等 1 秒再试，最多 MAX_ATTEMPTS 次，
    // 且每次尝试开始时脚本总耗时不得超过 TIME_BUDGET_MS。全部用尽就带着最后一次的原因报错。
    function requestValidated(url, method, body, validate, label) {
        var state = { attempt: 0, lastError: null, lastLength: -1 };
        return runAttempt(url, method, body, validate, label, state);
    }

    function runAttempt(url, method, body, validate, label, state) {
        var wait = state.attempt > 0 ? sleep(RETRY_DELAY_MS) : Promise.resolve();
        return wait.then(function () {
            if (elapsedMs() > TIME_BUDGET_MS) {
                throw finalError(label, state, true);
            }
            state.attempt++;
            return withTimeout(request(url, method, body), REQUEST_TIMEOUT_MS, label).then(function (text) {
                if (looksLikeLoginPage(text)) {
                    state.lastError = new Error(LOGIN_MESSAGE);
                    state.lastLength = -1;
                } else if (validate(text)) {
                    return text;
                } else {
                    state.lastError = null;
                    state.lastLength = text.length;
                }
                return retryOrGiveUp(url, method, body, validate, label, state);
            }, function (error) {
                state.lastError = error;
                state.lastLength = -1;
                return retryOrGiveUp(url, method, body, validate, label, state);
            });
        });
    }

    function retryOrGiveUp(url, method, body, validate, label, state) {
        if (state.attempt >= MAX_ATTEMPTS) {
            throw finalError(label, state, false);
        }
        console.log('[拾光] ' + label + ' 第 ' + state.attempt + ' 次未拿到完整响应，' + RETRY_DELAY_MS + 'ms 后重试');
        return runAttempt(url, method, body, validate, label, state);
    }

    function finalError(label, state, overBudget) {
        var note = overBudget
            ? '（提取已耗时超过 ' + Math.round(TIME_BUDGET_MS / 1000) + ' 秒，停止继续重试）'
            : '';
        if (state.lastError) {
            return new Error(state.lastError.message + note);
        }
        if (state.attempt === 0) {
            return new Error(label + '没有发出请求：提取已耗时超过 ' + Math.round(TIME_BUDGET_MS / 1000) + ' 秒，请稍后重试');
        }
        return new Error(
            label + '已尝试 ' + state.attempt + ' 次，响应都不完整（最后一次 ' + state.lastLength + ' 字符），请稍后重试' + note
        );
    }

    // 页面还在加载时先等一下（课表页把学期组件写在 HTML 里，取早了会读不到）
    function whenReady() {
        return new Promise(function (resolve) {
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                resolve();
                return;
            }
            var done = false;
            var finish = function () {
                if (done) return;
                done = true;
                resolve();
            };
            if (document.addEventListener) document.addEventListener('DOMContentLoaded', finish);
            setTimeout(finish, 8000);
        });
    }

    // ---------- 极简字面量解析（只扫值，不用 eval，也不动态造函数） ----------
    // 教务的学期日历响应体是 JS 对象字面量：
    //   {yearDom:"...",termDom:"...",semesters:{y0:[{id:32,schoolYear:"2013-2014",name:"2"}],...},
    //    yearIndex:"13",termIndex:"0",semesterId:"424"}
    // 这里用下面这组「按顶层逗号/冒号切分 + 深度与引号
    // 感知」的函数。它不做任何求值，也不执行响应体里的任何内容。
    function splitTop(text, sep) {
        var parts = [];
        var current = '';
        var depth = 0;
        var quote = '';
        var i;
        for (i = 0; i < text.length; i++) {
            var ch = text.charAt(i);
            if (quote) {
                current += ch;
                if (ch === quote && text.charAt(i - 1) !== BACKSLASH) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                current += ch;
                continue;
            }
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            if (ch === ')' || ch === ']' || ch === '}') depth--;
            if (ch === sep && depth === 0) {
                parts.push(current);
                current = '';
                continue;
            }
            current += ch;
        }
        parts.push(current);
        return parts;
    }

    // 取最外层 {...} 或 [...] 之间的内容（括号配对、尊重引号与转义）
    function outerOf(text, open, close) {
        var start = text.indexOf(open);
        if (start < 0) return null;
        var depth = 0;
        var quote = '';
        var i;
        for (i = start; i < text.length; i++) {
            var ch = text.charAt(i);
            if (quote) {
                if (ch === quote && text.charAt(i - 1) !== BACKSLASH) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === open) {
                depth++;
            } else if (ch === close) {
                depth--;
                if (depth === 0) return text.substring(start + 1, i);
            }
        }
        return null;
    }

    function unquote(raw) {
        var s = trimOf(raw);
        if (s.length >= 2) {
            var first = s.charAt(0);
            if ((first === '"' || first === "'") && s.charAt(s.length - 1) === first) {
                return s.substring(1, s.length - 1);
            }
        }
        return s;
    }

    function literalOf(raw) {
        var s = trimOf(raw);
        if (!s) return null;
        var first = s.charAt(0);
        if (first === '{') return objectOf(s);
        if (first === '[') return arrayOf(s);
        if (first === '"' || first === "'") return unquote(s);
        if (s === 'null' || s === 'undefined') return null;
        if (/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return Number(s);
        return s;
    }

    function objectOf(text) {
        var inner = outerOf(text, '{', '}');
        if (inner === null) return null;
        var pairs = splitTop(inner, ',');
        var out = {};
        var i;
        for (i = 0; i < pairs.length; i++) {
            if (!trimOf(pairs[i])) continue;
            var kv = splitTop(pairs[i], ':');
            if (kv.length < 2) continue;
            out[unquote(kv[0])] = literalOf(kv.slice(1).join(':'));
        }
        return out;
    }

    function arrayOf(text) {
        var inner = outerOf(text, '[', ']');
        if (inner === null) return [];
        var items = splitTop(inner, ',');
        var out = [];
        var i;
        for (i = 0; i < items.length; i++) {
            if (!trimOf(items[i])) continue;
            out.push(literalOf(items[i]));
        }
        return out;
    }

    function isoOfAny(value) {
        var s = textOf(value);
        var m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
        if (!m) return null;
        var month = parseInt(m[2], 10);
        var day = parseInt(m[3], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return m[1] + '-' + pad2(month) + '-' + pad2(day);
    }

    function semesterOf(item) {
        return {
            id: String(item.id),
            rawName: textOf(item.name),
            schoolYear: textOf(item.schoolYear),
            startDate: isoOfAny(item.startDate),
            endDate: isoOfAny(item.endDate)
        };
    }

    function calendarOf(raw) {
        var result = { currentId: null, semesters: [] };
        var text = trimOf(raw);
        if (!text) return result;
        var root = objectOf(text);
        if (!root) return result;
        if (root.semesterId !== null && root.semesterId !== undefined && root.semesterId !== '') {
            result.currentId = String(root.semesterId);
        }
        var buckets = root.semesters;
        if (!buckets || typeof buckets !== 'object') return result;
        var key;
        for (key in buckets) {
            if (!Object.prototype.hasOwnProperty.call(buckets, key)) continue;
            var list = buckets[key];
            if (!(list instanceof Array)) continue;
            var i;
            for (i = 0; i < list.length; i++) {
                var item = list[i];
                if (!item || typeof item !== 'object') continue;
                if (item.id === null || item.id === undefined || item.id === '') continue;
                result.semesters.push(semesterOf(item));
            }
        }
        return result;
    }

    // 选学期（不问用户）：① 课表页当前学期 ② 学期日历标出的当前学期 ③ 起止日期包含今天的那一个
    // ④ 起始日期最晚的那一个 ⑤ 列表最后一项。返回里带上选中的依据（source），parse.js 会把它写进 warnings
    function chose(item, source) {
        return {
            id: String(item.id),
            rawName: textOf(item.rawName),
            schoolYear: textOf(item.schoolYear),
            startDate: item.startDate,
            endDate: item.endDate,
            source: source
        };
    }

    function chooseSemester(cal, pageSemesterId, today) {
        var list = cal.semesters;
        var i;
        if (pageSemesterId) {
            for (i = 0; i < list.length; i++) {
                if (String(list[i].id) === String(pageSemesterId)) return chose(list[i], 'page');
            }
        }
        if (cal.currentId) {
            for (i = 0; i < list.length; i++) {
                if (String(list[i].id) === String(cal.currentId)) return chose(list[i], 'current');
            }
        }
        for (i = 0; i < list.length; i++) {
            var item = list[i];
            if (item.startDate && item.endDate && item.startDate <= today && today <= item.endDate) {
                return chose(item, 'date');
            }
        }
        var latest = null;
        for (i = 0; i < list.length; i++) {
            if (!list[i].startDate) continue;
            if (!latest || list[i].startDate > latest.startDate) latest = list[i];
        }
        if (latest) return chose(latest, 'latest');
        if (list.length) return chose(list[list.length - 1], 'last');
        // 学期列表空（接口没返回 / 被挡）：页面上的学期 id 还能用来发课表请求，
        // 只是拿不到学期名与起止日期，parse.js 会按列表为空的样子处理并写进 warnings
        if (pageSemesterId || cal.currentId) {
            return {
                id: String(pageSemesterId || cal.currentId),
                rawName: '',
                schoolYear: '',
                startDate: null,
                endDate: null,
                source: 'page'
            };
        }
        return null;
    }

    // 课表页 HTML 里的参数（上游同款正则，放宽空白）：
    //   学号 ids：bg.form.addInput(form,"ids","...")
    //   学期组件 id：id="semesterBar...Semester"
    //   当前学期 id：semesterCalendar({...value:"..."})
    function paramsOf(html) {
        var idsMatch = /bg\.form\.addInput\(\s*form\s*,\s*["']ids["']\s*,\s*["'](\d+)["']\s*\)/.exec(html);
        var tagMatch = /id=["'](semesterBar\d+Semester)["']/.exec(html);
        if (!idsMatch || !tagMatch) return null;
        var semesterMatch = /semesterCalendar\(\{[^}]*value\s*:\s*["']?(\d+)["']?/.exec(html);
        return {
            ids: idsMatch[1],
            tagId: tagMatch[1],
            semesterId: semesterMatch ? semesterMatch[1] : null
        };
    }

    // 页面自己的 unitCount（用户已经开在课表页时能读到），只在课表响应里没有时兜底
    function readUnitCountFromPage() {
        try {
            var html = document.documentElement ? textOf(document.documentElement.innerHTML) : '';
            var m = /(?:var\s+)?unitCount\s*=\s*(\d{1,3})/.exec(html);
            if (!m) return null;
            var count = parseInt(m[1], 10);
            return count > 0 ? count : null;
        } catch (e) {
            return null;
        }
    }

    return whenReady().then(function () {
        return requestValidated(
            eamsBase() + '/courseTableForStd.action', 'GET', null,
            function (text) { return paramsOf(text) !== null; },
            '探测课表参数'
        ).then(function (entryHtml) {
            var params = paramsOf(entryHtml);
            var calendarBody = 'tagId=' + encodeURIComponent(params.tagId) + '&dataType=semesterCalendar' +
                '&value=' + encodeURIComponent(params.semesterId || '') + '&empty=false';
            return requestValidated(
                eamsBase() + '/dataQuery.action', 'POST', calendarBody,
                function (text) { return calendarOf(text).semesters.length > 0; },
                '获取学期列表'
            ).then(function (calendarText) {
                var chosen = chooseSemester(calendarOf(calendarText), params.semesterId, todayIso());
                if (!chosen) {
                    throw new Error(
                        '没能确定要导入哪个学期（教务的学期列表为空，页面里也没有学期 id）：' +
                        '请重新登录后再点「提取课表」'
                    );
                }
                var tableBody = 'ignoreHead=1&setting.kind=std&semester.id=' + encodeURIComponent(chosen.id) +
                    '&ids=' + encodeURIComponent(params.ids);
                return requestValidated(
                    eamsBase() + '/courseTableForStd!courseTable.action', 'POST', tableBody,
                    function (text) { return /new CourseTable/.test(text); },
                    '获取课表数据'
                ).then(function (courseHtml) {
                    if (!/new TaskActivity/.test(courseHtml)) {
                        throw new Error('该学期没有课程数据（课表为空），请换一个学期再试');
                    }
                    return JSON.stringify({
                        today: todayIso(),
                        semester: chosen,
                        unitCountPage: readUnitCountFromPage(),
                        semesterCalendar: calendarText,
                        courseTable: courseHtml
                    });
                });
            });
        });
    });
})()
