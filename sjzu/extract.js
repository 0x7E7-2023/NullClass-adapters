(function () {
    // 沈阳建筑大学教学管理系统（树维 EAMS 平台，111.117.146.166/eams）适配器 —— 第一步：只取数。
    //
    // 上游 shiguang_warehouse 没有本校适配，这是空课自己写的（2026-11-03，用真实账号抓包核对）。
    // 结构模板是已审计的同平台件 uestc（电子科技大学，树维 EAMS）。与 uestc 不同的地方：
    //   ① 本校课表页没有现成的学期组件（semesterBar…Semester 是页面脚本运行后才生成的），
    //      学期号从课表页脚本 semesterCalendar({…, value:"230"}, …) 里读。
    //   ② 学期列表接口不看 tagId 的具体值，读不到页面组件时用占位值照常请求。
    //   ③ 不请求学期日历 /eams/base/calendar-info.action（本校对学生返回 403）；改为读教务首页
    //      /eams/homeExt.action 里那一行「2026第秋季学期 10 教学周」，只交这一行文字（首页其余部分有姓名，不交）。
    //   ④ 停在登录页时不发请求，给大白话提示；教务提示「请不要过快点击」时也给提示，不当课表解析。
    //
    // 取数方式：全部同源请求（地址由 window.location.origin + 上下文路径拼出来），最多四条：
    //   ① （按需）GET  /eams/courseTableForStd.action?sf_request_type=ajax  读 ids / 学期号
    //   ② POST /eams/dataQuery.action?sf_request_type=ajax（dataType=semesterCalendar）→ 学期列表原文
    //   ③ POST /eams/courseTableForStd!courseTable.action（semester.id + ids）→ 课表 HTML 全文
    //   ④ （可选）GET /eams/homeExt.action → 只取「当前第几教学周」那一行文字
    // 学号（ids）只用于构造课表请求，不交给 parse.js、不进载荷、不进 fixture。
    // 登录全程由用户在 WebView 里手工完成（含图片验证码），本脚本不读、不存、不上报任何账号信息。

    var EAMS_PATH = '/eams';

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 树维 EAMS 的上下文路径是 /eams；万一学校把它挂在门户 / 网关前缀下（例如 /webvpn/eams/...），
    // 跟着当前地址里那一段走，脚本不替教务系统写死主机，也不写死前缀。
    function eamsBase() {
        var path = String(window.location.pathname || '');
        var at = path.indexOf(EAMS_PATH + '/');
        if (at >= 0) return originOf() + path.substring(0, at + EAMS_PATH.length);
        return originOf() + EAMS_PATH;
    }

    function request(url, method, body) {
        var options = {
            method: method,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*'
            }
        };
        if (typeof body === 'string') options.body = body;
        return fetch(url, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    '教务系统返回错误（代码 ' + response.status + '）：登录状态可能已失效，请重新登录后再点「提取课表」'
                );
            }
            return response.text().then(function (body) {
                if (String(body).indexOf('请不要过快点击') >= 0) {
                    throw new Error('教务系统提示操作太快，请等几秒再点「提取课表」');
                }
                return body;
            });
        }, function (error) {
            var detail = error && error.message ? '（' + error.message + '）' : '';
            throw new Error('连不上教务系统' + detail + '：请确认已登录，再点「提取课表」');
        });
    }

    function get(url) {
        return request(url, 'GET', null);
    }

    function post(url, body) {
        return request(url, 'POST', body);
    }

    function tidy(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim();
    }

    function digitsOnly(value) {
        var raw = String(value === null || value === undefined ? '' : value).replace(/\s+/g, '');
        return /^\d+$/.test(raw) ? raw : null;
    }

    function textOf(node) {
        if (!node) return '';
        if (node.textContent !== undefined && node.textContent !== null) return tidy(node.textContent);
        return tidy(node.innerText);
    }

    function tagNameOf(node) {
        return node && node.tagName ? String(node.tagName).toUpperCase() : '';
    }

    // 学期组件的值：<select> 读它当前选中的值，隐藏 input 读 value 属性
    function semesterValueOf(node) {
        if (!node) return null;
        if (tagNameOf(node) === 'SELECT') return digitsOnly(node.value);
        if (!node.getAttribute) return null;
        return digitsOnly(node.getAttribute('value'));
    }

    // 学期组件的显示文字（教务自己写的学期名最准）：<select> 当前那一项的文本
    function semesterLabelOf(node) {
        if (!node || tagNameOf(node) !== 'SELECT' || !node.options) return null;
        var option = node.options[node.selectedIndex];
        if (!option) return null;
        var label = textOf(option);
        return label ? label : null;
    }

    // 当前页面上就已经有的线索：用户此刻正开在课表页时，不必再请求一次课表页
    function hintFromPage() {
        var hints = { ids: null, tagId: null, semesterId: null, semesterLabel: null };
        var i;
        var inputs = document.querySelectorAll('form input[name="ids"]');
        for (i = 0; i < inputs.length; i++) {
            var value = digitsOnly(inputs[i].value);
            if (value) { hints.ids = value; break; }
        }
        if (!hints.ids) {
            var params = document.querySelectorAll('form input[name="params"]');
            for (i = 0; i < params.length; i++) {
                var match = /[?&]ids=(\d+)/.exec(String(params[i].value || ''));
                if (match) { hints.ids = match[1]; break; }
            }
        }
        var bars = document.querySelectorAll('[id$="Semester"]');
        for (i = 0; i < bars.length; i++) {
            var id = String(bars[i].id || '');
            if (!/^semesterBar\d+Semester$/.test(id)) continue;
            hints.tagId = id;
            hints.semesterId = semesterValueOf(bars[i]);
            hints.semesterLabel = semesterLabelOf(bars[i]);
            break;
        }
        return hints;
    }

    // 课表页 HTML 里的同两个字段（同族 HPU / ZUA / NEUQ / CUIT 都是这么读的）
    function fillFromEntryHtml(html, hints) {
        var source = String(html || '');
        if (!hints.ids) {
            var ids = /bg\.form\.addInput\(\s*form\s*,\s*["']ids["']\s*,\s*["'](\d+)["']\s*\)/.exec(source);
            if (!ids) ids = /<input[^>]*\bname=["']ids["'][^>]*\bvalue=["'](\d+)["']/i.exec(source);
            if (!ids) ids = /<input[^>]*\bvalue=["'](\d+)["'][^>]*\bname=["']ids["']/i.exec(source);
            if (ids) hints.ids = ids[1];
        }
        if (!hints.tagId) {
            var bar = /\bid=["'](semesterBar\d+Semester)["']/.exec(source);
            if (bar) hints.tagId = bar[1];
        }
        if (!hints.semesterId) {
            var calendarCall = /semesterCalendar\(\s*\{[^}]*\bvalue\s*:\s*["'](\d+)["']/.exec(source);
            if (calendarCall) hints.semesterId = calendarCall[1];
        }
        if (!hints.semesterId && hints.tagId) {
            var escaped = hints.tagId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var tag = new RegExp('<[^>]*\\bid=["\']' + escaped + '["\'][^>]*>', 'i').exec(source);
            if (tag) {
                var value = /\bvalue=["'](\d+)["']/i.exec(tag[0]);
                if (value) hints.semesterId = value[1];
            }
        }
        return hints;
    }

    function gatherHints() {
        var hints = hintFromPage();
        if (hints.ids && hints.tagId && hints.semesterId) return Promise.resolve(hints);
        return get(eamsBase() + '/courseTableForStd.action?sf_request_type=ajax')
            .then(function (html) {
                return fillFromEntryHtml(html, hints);
            });
    }

    // 学期列表原文里的当前学期号（semesterId:523 或 semesterId:"523"）
    function semesterIdFromRaw(raw) {
        var match = /\bsemesterId\s*:\s*["']?(\d+)["']?/.exec(String(raw || ''));
        return match ? match[1] : null;
    }

    // 失败一律交 null：附加接口挂掉不该让整个导入失败，由 parse.js 回落到推算并写进 warnings
    function optionalText(url, body) {
        return post(url, body).then(function (text) {
            return String(text);
        }, function () {
            return null;
        });
    }

    // 「2026第秋季学期 10 教学周」这一行：当前页就是首页时直接读，否则 GET 一次首页。
    // 只交这一行的纯文字（首页其余部分有姓名等个人信息）；读不到交 null，由 parse.js 推算开学日并提醒。
    function teachWeekLine(html) {
        var m = /\bid=["']teach-week["'][^>]*>([\s\S]*?)<\/h\d>/i.exec(String(html || ''));
        if (!m) return null;
        var line = tidy(m[1].replace(/<[^>]*>/g, ' '));
        return line && line.length <= 60 ? line : null;
    }

    function teachWeekText() {
        var onPage = document.getElementById ? document.getElementById('teach-week') : null;
        if (onPage) {
            var line = textOf(onPage);
            if (line && line.length <= 60) return Promise.resolve(line);
        }
        return get(eamsBase() + '/homeExt.action').then(function (html) {
            return teachWeekLine(html);
        }, function () {
            return null;
        });
    }

    function onLoginPage() {
        var path = String(window.location.pathname || '');
        if (/\/(loginExt|login)\.action$/i.test(path)) return true;
        return !!document.querySelector('input[name="captcha_response"]');
    }

    function todayIso() {
        var now = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    }

    if (onLoginPage()) {
        return Promise.reject(new Error('当前打开的是登录页。请先登录教学管理系统，再点「提取课表」'));
    }

    return gatherHints().then(function (hints) {
        // 本校学期列表接口不看 tagId 的具体值；页面上没有学期组件时用占位值
        var dataQueryBody = 'tagId=' + encodeURIComponent(hints.tagId || 'semesterBar1Semester') + '&dataType=semesterCalendar';
        var semesterRaw = optionalText(eamsBase() + '/dataQuery.action?sf_request_type=ajax', dataQueryBody);

        return semesterRaw.then(function (raw) {
            var semesterId = hints.semesterId || semesterIdFromRaw(raw);
            if (!semesterId) {
                throw new Error(
                    '没读到当前学期的编号：请先在教务系统里打开「我的课表」页面，再点「提取课表」'
                );
            }
            if (!hints.ids) {
                throw new Error(
                    '没读到你的学号参数：请先在教务系统里打开「我的课表」页面，再点「提取课表」；' +
                    '如果已经打开，请确认登录状态没有失效'
                );
            }
            // 请求体与 uestc 相同；2026-11-03 用本校真实账号抓包核对过（project.id=1）
            var courseBody = 'ignoreHead=1&setting.kind=std&startWeek=&project.id=1&isEng=0' +
                '&semester.id=' + encodeURIComponent(semesterId) +
                '&ids=' + encodeURIComponent(hints.ids);
            return post(eamsBase() + '/courseTableForStd!courseTable.action', courseBody)
                .then(function (courseHtml) {
                    return teachWeekText()
                        .then(function (teachWeek) {
                            return JSON.stringify({
                                // 取数当天的日期：教务不给开学日时 parse.js 只能拿它当推算基准，
                                // 原样交出去（而不是让 parse.js 自己去问系统时间），回归用例才钉得住
                                today: todayIso(),
                                url: String(window.location ? window.location.href : ''),
                                tagId: hints.tagId || null,
                                semesterId: semesterId,
                                semesterLabel: hints.semesterLabel || null,
                                semesterRaw: raw,
                                teachWeek: teachWeek,
                                // 课表 HTML 的「打印」「导出」链接与请求参数串里带着 ids=<学生内部编号>，抹掉再交出去
                                courseHtml: String(courseHtml).split('ids=' + hints.ids).join('ids=')
                            });
                        });
                });
        });
    });
})()
