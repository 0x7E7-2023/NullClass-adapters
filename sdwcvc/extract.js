(function () {
    // 山东水利职业学院教务适配器（树维 EAMS 平台，教务主机 jw.sdwcvc.edu.cn，统一认证 sso.sdwcvc.cn 登录后在门户里打开
    // 「教务系统」）—— 第一步：只取数，把教务的数据交出去，判断与拼课全在 parse.js。
    //
    // 移植自 shiguang_warehouse 的 SDWCVC/sdwcvc_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，上游 maintainer 小漫君）
    //   上游快照 19a65bf07a3e998fcfc69cee692387cdc0523c1a（2026-10-19 拉取，2026-10-20 复核）
    //   本校脚本最后一次修改 494e3ce
    //   上游文件头写明：周次位图、逐周合并、日期校验复用 ZUA/zua.js（沿用 HFNU/hfnu.js），教学周历的英文日期格式参考 HIIT/hiit_01.js。
    //
    // 平台：树维 EAMS（上海树维信息科技有限公司 / SupWisdom；路径 /eams/）。本文件写「树维」，不写「强智」。
    //
    // 移植改动（逐条对应 AUDIT.md「移植改动」一节）：
    //   ① ES6 → ES5：async/await 改成 Promise 的 then 链，去掉模板串、箭头函数、块级声明关键字、展开运算符与 URLSearchParams
    //   ② 不弹窗选学期：上游先取学期列表、再弹选择框让用户挑。这里直接用教务课表页给的当前学期（entityId），
    //      学期列表只用来查这个学期的名字（取不到不影响导入，学期名由 parse.js 推）
    //   ③ 登录页与门户页不发请求：当前主机不是教务主机（例如统一认证 / 门户页），或路径是教务的登录页，直接提示，一个请求都不发
    //      （上游对非教务主机只弹一次提示，对登录页则在拿到响应后才报错）
    //   ④ 只取数、只交白名单内容：课表页响应只留 unitCount、教师声明（只留姓名）、TaskActivity 参数与 index 赋值这几类语句；
    //      学期列表只留 option 元素；教学周历只留「学年度 / 学期」那一格的文字和「起 ~ 止 (总周数)」那一段。
    //      页面其余部分（可能夹带的姓名、学号等）不交出去；学号 ids 只进请求体，不交出去
    //   ⑤ 不解析、不算周次、不拼课：位图、合并、日期、节次时间全部放 parse.js（CI 里跑得到的那一段）
    //   ⑥ 上游的 showAlert / showToast / saveCourseConfig / savePresetTimeSlots / saveImportedCourses / notifyTaskCompletion
    //      这些桥调用全部没有移植：这条链路是「拉」不是「推」
    //   ⑦ 校历（calendar-info）取不到不再整次失败：交空串，parse.js 回落到推算并写进提醒
    //
    // 取数方式：同源请求，最多四个（全部打在教务主机上，地址由 window.location.origin 拼出来），与上游同路径、同请求体：
    //   ① GET  /eams/courseTableForStd.action                     读学号 ids 与当前学期 id（entityId）
    //   ② POST /eams/dataQuery.action                              dataType=semester&entityId=<当前学期 id>，取学期列表（只用来查学期名，可选）
    //   ③ POST /eams/courseTableForStd!courseTable.action          取整学期课表页（必需）
    //   ④ POST /eams/base/calendar-info.action                     version=1&semesterId=<当前学期 id>，取教学周历（可选）
    // 登录全程由用户在 WebView 里手工完成，本脚本不读、不存、不上报任何账号信息，也不碰成绩 / 学籍 / 个人信息等其它接口。

    var JW_HOST = 'jw.sdwcvc.edu.cn';
    var EAMS = '/eams';
    var LOGIN_HINT = '请先登录统一认证，并在门户里打开「教务系统」，再点「提取课表」';
    var MAX_TEACHERS = 30;

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // 树维的上下文路径是 /eams；万一挂在前缀下，跟着当前地址里的那一段走
    function eamsBase() {
        var path = text(window.location.pathname);
        var at = path.indexOf(EAMS + '/');
        if (at > 0) return originOf() + path.substring(0, at + EAMS.length);
        return originOf() + EAMS;
    }

    // 当前不在教务系统里（统一认证页、门户页），或在教务的登录页：不发请求
    function notInJw() {
        var host = text(window.location.hostname).toLowerCase();
        if (host !== JW_HOST) return true;
        return /\/login[A-Za-z]*\.action/i.test(text(window.location.pathname));
    }

    function isLoginUrl(url) {
        var value = text(url);
        if (!value) return false;
        var qAt = value.search(/[?#]/);
        var path = qAt >= 0 ? value.substring(0, qAt) : value;
        return /\/login[A-Za-z]*\.action$/i.test(path);
    }

    function detailOf(error) {
        return error && error.message ? '（' + error.message + '）' : '';
    }

    function request(path, body) {
        var options = { method: body === undefined ? 'GET' : 'POST', credentials: 'include' };
        if (body !== undefined) {
            options.headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
            options.body = body;
        }
        return fetch(eamsBase() + path, options).then(function (response) {
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）：' + LOGIN_HINT);
            }
            if (isLoginUrl(response.url)) {
                throw new Error('教务系统返回了登录页：' + LOGIN_HINT);
            }
            return response.text();
        }, function (error) {
            throw new Error('连不上教务系统' + detailOf(error) + '：请确认已登录，再点「提取课表」');
        });
    }

    function pair(name, value) {
        return encodeURIComponent(name) + '=' + encodeURIComponent(text(value));
    }

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
    }

    // ① 课表入口页：学号 ids（请求体要它）与当前学期 id。正则与上游一致，引号放宽到单引号；
    // 上游只认 entityId，这里再加一条学期栏元素的 value 作后备。
    function paramsFromEntry(html) {
        var source = text(html);
        var idsMatch = /bg\.form\.addInput\(\s*form\s*,\s*["']ids["']\s*,\s*["'](\d+)["']\s*\)/.exec(source);
        var semesterMatch = /\bentityId\s*:\s*["'](\d+)["']/.exec(source);
        if (!semesterMatch) {
            var tagMatch = /id=["'](semesterBar\d+Semester)["']/.exec(source);
            if (tagMatch) {
                var element = new RegExp('<[^>]*\\bid=["\']' + tagMatch[1] + '["\'][^>]*>', 'i').exec(source);
                semesterMatch = element ? /\bvalue=["'](\d+)["']/i.exec(element[0]) : null;
            }
        }
        if (!idsMatch || !semesterMatch) return null;
        return { ids: idsMatch[1], semesterId: semesterMatch[1] };
    }

    // 学期列表只留 option 元素（学期 id + 学期名），响应里的其它内容不交出去
    function optionsOf(html) {
        var found = text(html).match(/<option\b[^>]*>[\s\S]*?<\/option>/gi);
        return found ? found.join('\n') : '';
    }

    // ④ 课表页只留 parse.js 要读的几类语句（按出现顺序）：unitCount、教师声明、TaskActivity、index 赋值。
    // 教师声明重写成只含姓名的形式（教师内部 id 不交出去）。
    var DIGEST_RE = new RegExp(
        '\\bunitCount\\s*=\\s*\\d+\\s*;' +
        '|var\\s+teachers\\s*=\\s*\\[[\\s\\S]*?\\]\\s*;' +
        '|\\bactTeachers\\s*=\\s*\\[[\\s\\S]*?\\]\\s*;' +
        '|new\\s+TaskActivity\\s*\\([\\s\\S]*?\\)\\s*;' +
        '|\\bindex\\s*=\\s*\\d+\\s*(?:\\*\\s*(?:unitCount|\\d+)\\s*\\+\\s*\\d+\\s*)?;',
        'g'
    );

    function teacherDeclaration(prefix, fragment) {
        var re = /\bname\s*:\s*(?:"([^"]*)"|'([^']*)')/g;
        var names = [];
        var m;
        while ((m = re.exec(fragment)) !== null && names.length < MAX_TEACHERS) {
            var name = text(m[1] !== undefined ? m[1] : m[2]).replace(/["'\\\s]+/g, ' ').replace(/^\s+|\s+$/g, '');
            if (name) names.push('{name:"' + name + '"}');
        }
        return prefix + '[' + names.join(',') + '];';
    }

    function courseDigest(html) {
        var source = text(html);
        var parts = [];
        var m;
        DIGEST_RE.lastIndex = 0;
        while ((m = DIGEST_RE.exec(source)) !== null) {
            var piece = m[0];
            if (/^var\s+teachers/.test(piece)) {
                parts.push(teacherDeclaration('var teachers = ', piece));
            } else if (/^actTeachers/.test(piece)) {
                parts.push(teacherDeclaration('var actTeachers = ', piece));
            } else {
                parts.push(piece);
            }
            if (m[0].length === 0) DIGEST_RE.lastIndex++;
        }
        return parts.join('\n');
    }

    function countActivities(html) {
        return (text(html).match(/new\s+TaskActivity\s*\(/g) || []).length;
    }

    function plainOf(html) {
        return text(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    }

    // 教学周历只留两样：「学年度 / 学期」后面那一格的文字，和「起 ~ 止 (总周数)」那一段（英文日期是上游认的写法，数字日期是后备）
    function calendarFacts(html) {
        var source = text(html);
        var termCell = /学年度\s*\/\s*学期\s*<\/t[dh]>\s*<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/.exec(source);
        var plain = plainOf(source);
        var range = /[A-Za-z]{3}\s+\d{1,2},\s+\d{4}\s*~\s*[A-Za-z]{3}\s+\d{1,2},\s+\d{4}\s*\(\d+\)/.exec(plain) ||
            /\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}\s*(?:~|～|至|到)\s*\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}\s*[（(]\s*\d+\s*[)）]/.exec(plain);
        return {
            term: termCell ? plainOf(termCell[1]).substring(0, 40) : '',
            range: range ? range[0] : ''
        };
    }

    // 学期列表与校历取不到都不算失败（parse.js 回落并写进提醒）
    function optional(path, body) {
        return request(path, body).then(function (response) {
            return text(response);
        }, function () {
            return '';
        });
    }

    if (notInJw()) {
        throw new Error('现在还不在教务系统里：' + LOGIN_HINT);
    }

    return request('/courseTableForStd.action').then(function (entryHtml) {
        var params = paramsFromEntry(entryHtml);
        if (!params) {
            throw new Error('没能读到课表页的信息：登录状态可能已失效。' + LOGIN_HINT);
        }
        return optional(
            '/dataQuery.action',
            pair('dataType', 'semester') + '&' + pair('entityId', params.semesterId)
        ).then(function (semesterResponse) {
            var courseBody = pair('ignoreHead', '1') + '&' + pair('setting.kind', 'std') + '&' + pair('startWeek', '') +
                '&' + pair('semester.id', params.semesterId) + '&' + pair('ids', params.ids);
            return request('/courseTableForStd!courseTable.action', courseBody).then(function (courseHtml) {
                var calendarBody = pair('version', '1') + '&' + pair('semesterId', params.semesterId);
                return optional('/base/calendar-info.action', calendarBody).then(function (calendarHtml) {
                    var calendar = calendarFacts(calendarHtml);
                    return JSON.stringify({
                        today: localTodayIso(),
                        semesterId: params.semesterId,
                        semesterOptions: optionsOf(semesterResponse),
                        courseDigest: courseDigest(courseHtml),
                        activityCount: countActivities(courseHtml),
                        calendarTerm: calendar.term,
                        calendarRange: calendar.range
                    });
                });
            });
        });
    });
})()
