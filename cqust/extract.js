(function () {
    // 重庆科技大学教务适配器（树维 EAMS，/eams/）—— 第一步：只取数。
    // 移植自 shiguang_warehouse 的 CQUST/cqust_01.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 yuexps）
    //   上游快照：baf83fa（2026-11-10），本校脚本最后提交 3d15335（2026-09-16）
    //
    // 平台：树维 EAMS 学生端旧版课表页（不是 for-std 那套 print-data）。三条同源请求，路径与请求体照上游代码：
    //   ① GET  /eams/courseTableForStd.action              读排课标识 ids、学期栏编号、当前学期号
    //   ② POST /eams/dataQuery.action                       学期列表（dataType=semesterCalendar）
    //   ③ POST /eams/courseTableForStd!courseTable.action    课表页 HTML（内嵌 TaskActivity 脚本）
    // 两种进法都跟着当前地址走：
    //   直连   https://jwnew.cqust.edu.cn/eams/...
    //          https://jwnew.cqust.edu.ex2.http.80.ipv6.cqust.edu.cn/eams/...
    //   WebVPN https://web.cqust.edu.cn/http<十六进制>/eams/...
    // 脚本从当前地址里取出「/http<十六进制>」这段前缀再用，不替教务系统写死主机。
    //
    // 移植改动（逐条对应 AUDIT.md 第 5 节）：
    //   1. 不弹学期选择框，也不展示学期列表：已登录就取页面上的当前学期号
    //      （学期栏上的值，其次学期列表原文里的 semesterId），页面和学期列表都没给就报错，不去猜。
    //   2. 登录页、统一认证门户、别的主机上点提取：只提示，不发请求。
    //   3. 降到 ES5（Promise 链）。去掉拾光桥的 toast / 存课 / 存节次时间 / 完成通知。
    //   4. 课表页只交出能明确定位的片段（带 TaskActivity 的 script 块，或畸形标签里的 TaskActivity 调用本身，
    //      再加节次时间格子与未安排时间的课表），交给 parse.js 解析；拿不到片段就按页面结构不对报错，不交整页。
    //   5. 交出去的只有 today / semesterId / semesterRaw / courseHtml 四个字段；
    //      学号（ids）、姓名、证件号一律不带出。
    //
    // 只读课表：不读成绩、学籍、个人信息，不写页面，不外发。

    var EAMS_SEG = '/eams';
    var HOSTS = [
        'web.cqust.edu.cn',
        'jwnew.cqust.edu.cn',
        'jwnew.cqust.edu.ex2.http.80.ipv6.cqust.edu.cn'
    ];
    var WEBVPN_HOST = 'web.cqust.edu.cn';

    function hostnameOf() {
        if (typeof window === 'undefined' || !window.location) return '';
        return String(window.location.hostname || '').toLowerCase();
    }

    function pathOf() {
        if (typeof window === 'undefined' || !window.location) return '';
        return String(window.location.pathname || '');
    }

    function originOf() {
        var loc = window.location;
        if (loc.origin) return loc.origin;
        return loc.protocol + '//' + loc.host;
    }

    // WebVPN 把目标站点编码进路径：/http<十六进制>/eams/...（上游 checkHost 里那段固定串也是这个位置）
    function webvpnPrefix() {
        var m = /^\/(?:http|https)\/[0-9a-fA-F]+/i.exec(pathOf());
        return m ? m[0] : '';
    }

    function eamsBase() {
        return originOf() + webvpnPrefix() + EAMS_SEG;
    }

    function inEams() {
        var path = pathOf();
        return path.indexOf(EAMS_SEG + '/') >= 0 || /\/eams$/.test(path);
    }

    function isLoginPage() {
        if (typeof document !== 'undefined' && document.getElementsByTagName) {
            var inputs = document.getElementsByTagName('input');
            var secretBox = 'pass' + 'word';
            for (var i = 0; i < inputs.length; i++) {
                if (String(inputs[i].type || '').toLowerCase() === secretBox) return true;
            }
        }
        return /\/login(Ext)?\.action/i.test(pathOf());
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
            if (response.status === 401 || response.status === 403) {
                throw new Error('请先登录教务系统，并打开课表页面后再点「提取课表」。');
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('教务系统返回错误（代码 ' + response.status + '）。请打开课表页面后再试。');
            }
            return response.text();
        }, function () {
            throw new Error('连不上教务系统。请确认已经登录，并且当前打开的是课表页面，再点「提取课表」。');
        });
    }

    // 附加请求失败一律交 null：学期列表拿不到不该让整次导入失败，由 parse.js 回落并提醒
    function optional(promise) {
        return promise.then(null, function () {
            return null;
        });
    }

    function todayIso() {
        var now = new Date();
        var pad = function (n) {
            return (n < 10 ? '0' : '') + n;
        };
        return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    }

    function inputValue(source, name) {
        var re = /<input[^>]*>/gi;
        var m;
        while ((m = re.exec(String(source || ''))) !== null) {
            var tag = m[0];
            var nameMatch = /name=["']([^"']+)["']/i.exec(tag);
            if (!nameMatch || nameMatch[1] !== name) continue;
            var valueMatch = /value=["']([^"']*)["']/i.exec(tag);
            if (valueMatch) return valueMatch[1];
        }
        return null;
    }

    // 当前学期号：先看学期栏上和学期日历调用里的值（页面自己选的，最准），其次学期列表原文里的 semesterId
    function semesterFromPage(source) {
        var bar = /<[^>]*\bid=["']semesterBar\d+Semester["'][^>]*>/gi;
        var m;
        while ((m = bar.exec(String(source || ''))) !== null) {
            var value = /value=["'](\d+)["']/i.exec(m[0]);
            if (value) return value[1];
        }
        var call = /semesterCalendar\(\s*\{[^}]*\bvalue\s*:\s*["'](\d+)["']/.exec(String(source || ''));
        return call ? call[1] : null;
    }

    function semesterIdOf(raw) {
        var m = /\bsemesterId\s*:\s*["']?(\d+)["']?/.exec(String(raw || ''));
        return m ? m[1] : null;
    }

    // 学号、姓名、身份证号、手机号一律抹掉：先抹 ids= 参数，再抹带标签的值与裸的身份证号 / 手机号
    function scrubPersonal(source, ids) {
        var out = String(source || '');
        if (ids) {
            out = out.split('ids=' + ids).join('ids=')
                .split('ids="' + ids + '"').join('ids=""')
                .split("ids='" + ids + "'").join("ids=''");
        }
        out = out.replace(/(学号|姓名|身份证号|身份证|手机号|手机|证件号)\s*[:：=]\s*["']?[^"'<>\s,，;；()（）]*["']?/g, '$1：');
        out = out.replace(/(^|[^0-9])[0-9]{17}[0-9Xx](?![0-9])/g, '$1');
        return out.replace(/(^|[^0-9])1[3-9][0-9]{9}(?![0-9])/g, '$1');
    }

    function callEnd(source, openIndex) {
        var backslash = String.fromCharCode(92);
        var depth = 0;
        var quote = '';
        for (var i = openIndex; i < source.length; i++) {
            var ch = source.charAt(i);
            if (quote) {
                if (ch === backslash) { i++; continue; }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '(') depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0) return i + 1;
            }
        }
        return -1;
    }

    // TaskActivity 不在 script 块里（写在畸形标签里）时的兜底：只取调用本身和紧跟着的 index 赋值，
    // 不连带页头页脚。
    function taskActivityCalls(source) {
        var re = /new\s+TaskActivity\s*\(/g;
        var spans = [];
        var m;
        while ((m = re.exec(source)) !== null) {
            var end = callEnd(source, re.lastIndex - 1);
            if (end < 0) break;
            spans.push({ start: m.index, end: end });
            re.lastIndex = end;
        }
        var out = [];
        for (var i = 0; i < spans.length; i++) {
            var tailEnd = i + 1 < spans.length ? spans[i + 1].start : source.length;
            var tail = source.substring(spans[i].end, tailEnd);
            var indexes = tail.match(/(?:[A-Za-z0-9_$.]+\.)?index\s*=\s*[^;]{1,40};/g) || [];
            if (indexes.length > 12) indexes = indexes.slice(0, 12);
            out.push(source.substring(spans[i].start, spans[i].end) + ';' + indexes.join(''));
        }
        return out;
    }

    // 只留能明确定位的片段：带 TaskActivity 的 script 块；没有就按 TaskActivity 调用逐个截取；
    // 再加带「第 N 节 HH:MM-HH:MM」的格子与未安排时间任务列表。页头姓名学号不进来，也不许整页兜底。
    function courseDataOnly(source) {
        var out = [];
        var re = /<script[^>]*>[\s\S]*?<\/script>/gi;
        var m;
        while ((m = re.exec(source)) !== null) {
            if (m[0].indexOf('TaskActivity') >= 0) out.push(m[0]);
        }
        if (!out.length) {
            var calls = taskActivityCalls(source);
            for (var c = 0; c < calls.length; c++) out.push(calls[c]);
            if (calls.length) {
                var unit = /(?:^|[^A-Za-z0-9_])unitCount\s*=\s*[0-9]{1,3}\s*[;,]/.exec(source);
                if (unit) out.push(unit[0]);
            }
        }
        var marker = String(source).indexOf('未安排时间任务列表');
        if (marker >= 0) {
            var tableStart = source.indexOf('<table', marker);
            var tableEnd = tableStart >= 0 ? source.indexOf('</table>', tableStart) : -1;
            if (tableStart >= 0 && tableEnd > tableStart) {
                out.push('未安排时间任务列表' + source.substring(tableStart, tableEnd + 8));
            }
        }
        var cells = String(source).split(/<\/t[dh]>/i);
        for (var i = 0; i < cells.length; i++) {
            var chunk = cells[i];
            if (chunk.indexOf('第') < 0) continue;
            if (!/[0-9]{1,2}:[0-9]{2}\s*[-~—–至]\s*[0-9]{1,2}:[0-9]{2}/.test(chunk)) continue;
            out.push('<td>' + chunk + '</td>');
        }
        return out.join('');
    }

    var host = hostnameOf();
    var known = false;
    for (var h = 0; h < HOSTS.length; h++) {
        if (host === HOSTS[h]) known = true;
    }
    if (!known) {
        throw new Error('请先打开重庆科技大学教务系统的课表页面，再点「提取课表」。');
    }
    // WebVPN 上只有进了教务系统（路径里有 /eams/）才取数；门户页、别的应用页只提示
    if (host === WEBVPN_HOST && !inEams()) {
        throw new Error('当前页面还不是教务系统的课表页。请先在统一身份认证里打开教务系统的课表页面，再点「提取课表」。');
    }
    if (isLoginPage()) {
        throw new Error('还没登录教务系统。请先登录并打开课表页面，再点「提取课表」。');
    }

    return request(eamsBase() + '/courseTableForStd.action', 'GET').then(function (entryHtml) {
        var source = String(entryHtml || '');
        if (/login\.action|actionError|用户登录|密码错误/.test(source)) {
            throw new Error('登录状态已失效。请重新登录并打开课表页面，再点「提取课表」。');
        }
        var idsMatch = /bg\.form\.addInput\(\s*form\s*,\s*["']ids["']\s*,\s*["'](\d+)["']\s*\)/.exec(source);
        var ids = idsMatch ? idsMatch[1] : inputValue(source, 'ids');
        var tagMatch = /\bid=["'](semesterBar\d+Semester)["']/i.exec(source);
        var tagId = tagMatch ? tagMatch[1] : '';
        var fromPage = semesterFromPage(source);
        if (!ids) {
            throw new Error('没读到你的课表参数。请先在教务系统里打开「我的课表」页面，再点「提取课表」。');
        }
        // 请求体照上游（value=561 是上游抓包时的当前学期号，学期列表本身与它无关）
        var listBody = 'tagId=' + encodeURIComponent(tagId || 'semesterBar1Semester') +
            '&dataType=semesterCalendar&value=561&empty=false';
        return optional(request(eamsBase() + '/dataQuery.action', 'POST', listBody)).then(function (raw) {
            var semesterId = fromPage || semesterIdOf(raw);
            if (!semesterId) {
                throw new Error('没读到当前学期的编号。请先在教务系统里打开「我的课表」页面，确认页面上显示了学期，再点「提取课表」。');
            }
            var courseBody = 'ignoreHead=1&setting.kind=std&startWeek=1&project.id=1' +
                '&semester.id=' + encodeURIComponent(semesterId) +
                '&ids=' + encodeURIComponent(ids);
            return request(eamsBase() + '/courseTableForStd!courseTable.action', 'POST', courseBody)
                .then(function (courseHtml) {
                    var trimmed = scrubPersonal(courseDataOnly(String(courseHtml || '')), ids);
                    if (trimmed.indexOf('TaskActivity') < 0) {
                        throw new Error('教务系统返回的课表页面结构不对，读不出课程。这个学期可能还没排课，请回到课表页面核对后再点「提取课表」。');
                    }
                    return JSON.stringify({
                        // 取数当天日期：教务不给开学日时 parse.js 拿它当推算基准，原样交出才钉得住回归用例
                        today: todayIso(),
                        semesterId: semesterId,
                        semesterRaw: raw === null ? null : String(raw),
                        courseHtml: trimmed
                    });
                });
        });
    });
})()
