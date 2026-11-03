(function () {
    // 河南职业技术学院教务适配器（学校自建课表服务 one.hnzj.edu.cn，JSON 接口）—— 第一步：只取数，把接口的原始数据交出去。
    //
    // 移植自 shiguang_warehouse 的 HNZY/hnzy.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 一颗）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03 拉取）
    //   本校脚本最后一次修改 80e30cf（批量合并提交，提交者不是作者）
    // 移植改动（逐条见 AUDIT.md「与上游的差异」）：
    //   ① 不弹窗选学年学期：先认教务接口标为当前的一项；没有标记就按提取日推算学年学期，再在列表里找；
    //      上游默认选第一个学年与第一个学期，春季就选错了，这里不照搬；
    //   ② 周数：逐周请求上限 = max(20, 已收到记录里出现的最大周)，硬上限 30；上游写死 20 周，超过的周次会丢；
    //   ③ 单周失败不静默：记下周次交给 parse.js 点名；全部失败才报错；
    //   ④ 只带课表用得到的字段（课名、教师、教室、星期、起止节次、周次文字），其余字段（学号等）一律不带出；
    //   ⑤ 只在 one.hnzj.edu.cn 页面上运行；登录页或其它页面上点提取：大白话提示，不发请求。
    //
    // 取数方式（同源，地址由 window.location.origin 拼出）：
    //   ① GET /kcb/api/schoolyearTerms                       取学年列表与学期列表（只读）
    //   ② GET /kcb/api/course?schoolYear=&schoolTerm=&week=N  逐周取课表，N = 1..上限，串行请求

    var HOST = 'one.hnzj.edu.cn';
    var WEEKS_MIN = 20;        // 逐周请求的下限（上游写死 20 周）
    var WEEKS_MAX = 30;        // 逐周请求的硬上限（载荷 totalWeeks 也只到 30）
    var LOGIN_HINT = '请先在学校的统一认证页面登录，登录后打开「课表」页面，再点「提取课表」';
    var FLAGS = ['current', 'isCurrent', 'selected', 'isSelected', 'checked', 'default', 'isDefault'];

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 接口里标为当前的一项（认 FLAGS 里的几种标记，值为 true）
    function findFlag(list) {
        for (var i = 0; i < list.length; i++) {
            for (var j = 0; j < FLAGS.length; j++) {
                if (list[i] && list[i][FLAGS[j]] === true) return list[i];
            }
        }
        return null;
    }

    // 按日期推算：8–12 月 = 当年第一学期；1 月 = 上一年第一学期；2–7 月 = 上一年第二学期
    function dateTerm(now) {
        var m = now.getMonth() + 1;
        var y = now.getFullYear();
        if (m >= 8) return { year: y, no: 1 };
        if (m === 1) return { year: y - 1, no: 1 };
        return { year: y - 1, no: 2 };
    }

    // 学年项的 label 或 value 以起始年开头（例如 2026，匹配 2026-2027；不能匹配 2025-2026 的结束年 2026）
    function findYearByDate(list, year) {
        var s = String(year);
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].label || '').indexOf(s) === 0 || String(list[i].value || '').indexOf(s) === 0) return list[i];
        }
        return null;
    }

    // 学期项：label 含「一」或 1（第二学期则是「二」或 2）；都没有时 value 恰好是 1 或 2
    function findTermByDate(list, no) {
        var cn = no === 1 ? '一' : '二';
        var digit = String(no);
        var i;
        for (i = 0; i < list.length; i++) {
            var label = String(list[i].label || '');
            if (label.indexOf(cn) >= 0 || label.indexOf(digit) >= 0) return list[i];
        }
        for (i = 0; i < list.length; i++) {
            if (String(list[i].value) === digit) return list[i];
        }
        return null;
    }

    // 学期项的文字里能读出第几学期（读不出返回 0）
    function noOfTerm(item) {
        var label = String(item.label || '');
        if (label.indexOf('二') >= 0 || label.indexOf('2') >= 0) return 2;
        if (label.indexOf('一') >= 0 || label.indexOf('1') >= 0) return 1;
        return 0;
    }

    // 选学年学期：
    //   both flag → 'flag'；否则按日期找（找不到年就用第一个学年）→ 'date'；日期也对不上 → 第一项 'first'
    function chooseTerm(years, terms, now) {
        var yearFlag = findFlag(years);
        var termFlag = findFlag(terms);
        if (yearFlag && termFlag) return { year: yearFlag, term: termFlag, picked: 'flag', no: 0 };
        var dt = dateTerm(now);
        var year = yearFlag || findYearByDate(years, dt.year);
        var term = termFlag || findTermByDate(terms, dt.no);
        if (term) {
            // 学年对不上今天的日期时退回第一个学年，单独标记（提醒要说清楚，不能写成「按今天的日期选择」）
            return {
                year: year || years[0], term: term, picked: year ? 'date' : 'yearfallback',
                no: noOfTerm(term) || dt.no
            };
        }
        return { year: year || years[0], term: terms[0], picked: 'first', no: 0 };
    }

    // 一条课表记录的周次文字里最大的数字（「15-22周」→ 22；读不出返回 0）
    function maxWeekIn(weeksText) {
        var nums = String(weeksText || '').match(/[0-9]+/g) || [];
        var max = 0;
        for (var i = 0; i < nums.length; i++) {
            var n = parseInt(nums[i], 10);
            if (n <= 99 && n > max) max = n;
        }
        return max;
    }

    function getJson(url) {
        return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
            if (!res.ok) throw new Error('教务系统返回错误（代码 ' + res.status + '）');
            return res.json();
        }, function () {
            throw new Error('没有连上教务系统，请检查网络后再试');
        });
    }

    if (window.location.host !== HOST) {
        throw new Error(LOGIN_HINT);
    }

    var base = window.location.origin;
    var now = new Date();

    return getJson(base + '/kcb/api/schoolyearTerms').then(function (json) {
        var resp = (json && json.response) || {};
        var years = Array.isArray(resp.schoolYears) ? resp.schoolYears : [];
        var terms = Array.isArray(resp.schoolTerms) ? resp.schoolTerms : [];
        if (!years.length || !terms.length) {
            throw new Error('没有读到学年学期列表，请确认已登录并能看到课表后再试');
        }
        var chosen = chooseTerm(years, terms, now);
        var query = '/kcb/api/course?schoolYear=' + encodeURIComponent(chosen.year.value) +
            '&schoolTerm=' + encodeURIComponent(chosen.term.value) + '&week=';

        var rows = [];
        var failedWeeks = [];
        var week = 1;
        var attempted = 0;
        var limit = WEEKS_MIN;   // 随已收到记录的最大周次延伸，最多到 WEEKS_MAX
        var maxSeen = 0;

        // 串行逐周请求：单周失败只记下周次，不中断
        function next() {
            if (week > limit) return finish();
            var current = week;
            week++;
            attempted++;
            return getJson(base + query + current).then(function (json) {
                if (!json || !Array.isArray(json.response)) throw new Error('返回的内容不是课表');
                var days = json.response;
                for (var d = 0; d < days.length; d++) {
                    var dayInfo = days[d] || {};
                    var list = Array.isArray(dayInfo.data) ? dayInfo.data : [];
                    for (var c = 0; c < list.length; c++) {
                        var item = list[c] || {};
                        var weekMax = maxWeekIn(item.weeks);
                        if (weekMax > maxSeen) maxSeen = weekMax;
                        rows.push({
                            courseName: item.courseName,
                            teacherName: item.teacherName,
                            classRoom: item.classRoom,
                            day: dayInfo.week,
                            startSection: item.startSection,
                            endSection: item.endSection,
                            weeks: item.weeks
                        });
                    }
                }
            }).catch(function () {
                failedWeeks.push(current);
            }).then(function () {
                limit = Math.min(WEEKS_MAX, Math.max(WEEKS_MIN, maxSeen));
            }).then(next);
        }

        function finish() {
            if (attempted && failedWeeks.length === attempted) {
                throw new Error('每一周的课表都没有取到，请确认已登录并能看到课表后再试');
            }
            return {
                term: {
                    yearLabel: String(chosen.year.label || ''),
                    termLabel: String(chosen.term.label || ''),
                    yearValue: chosen.year.value,
                    termValue: chosen.term.value,
                    picked: chosen.picked,
                    dateNo: chosen.no
                },
                today: now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()),
                weekLimit: limit,
                capHit: maxSeen >= WEEKS_MAX,
                failedWeeks: failedWeeks,
                rows: rows
            };
        }

        return next();
    }).then(function (data) {
        return JSON.stringify(data);
    });
})()
