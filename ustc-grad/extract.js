(function () {
    // 中国科学技术大学研究生教务（yjs1.ustc.edu.cn，研究生综合服务平台）课表提取。
    //
    // 移植自 shiguang_warehouse 的 resources/USTC/ustc_01.js（MIT，上游作者 hydrofluoric07）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 平台：金智教育 jwapp（接口信封 {code,datas:{<key>:{rows:[]}}}，与已移植的 dlutci / neu 同平台）。
    //
    // 取数方式：两次同源相对路径 POST（不解析课表本身的 DOM）：
    //   ① /gsapp/sys/kbcxappustc/modules/xskbcx/xnxqxxcx.do  学年学期列表
    //   ② /gsapp/sys/kbcxappustc/modules/xskbcx/xskbxxcx.do  学生课表查询（按学期代码 XNXQDM 过滤）
    // 读页面 DOM 的地方只有一处：读取「课表查询」页当前显示的学期名（形如
    // 「我的课表 <label id="xnXqSpan">2026年秋季学期</label> 更改」），用于在有多个学期时
    // 优先选中用户已经在页面上切到的那个学期。
    //
    // 移植改动：
    //   ① 上游用 showSingleSelection 弹窗兜底选学期；本文件不弹窗，只按「页面当前显示的学期名
    //      → 教务标记的当前学期（SFDQXQ=1）→ 列表第一项」这个顺序自动选（移植手册 §3 第 1 步：
    //      用户本就开在目标学期的页面上，让他自己切页面比弹窗更清楚）。
    //   ② 输出只保留 parse.js 需要的四个字段（KCMC/ZCMC/PKSJDD/RKJS），课表行原始对象里若带有
    //      学号/姓名等字段一律不透出，顺带让 fixture 天然脱敏。
    //   ③ 周次解析、时间地点解析、课程合并、周次切段等转换逻辑全部搬到 parse.js
    //      （CI 只跑得到 parse.js，见移植手册 §3 第 1 步 / testing.md §1）。

    var XNXQ_API = '/gsapp/sys/kbcxappustc/modules/xskbcx/xnxqxxcx.do';
    var KBCX_API = '/gsapp/sys/kbcxappustc/modules/xskbcx/xskbxxcx.do';

    function encodeForm(form) {
        var parts = [];
        for (var key in form) {
            if (form.hasOwnProperty(key)) {
                parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(form[key]));
            }
        }
        return parts.join('&');
    }

    function postForm(url, form) {
        return fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: encodeForm(form)
        }).then(function (resp) {
            if (!resp.ok) {
                throw new Error('接口请求失败：HTTP ' + resp.status + '（' + url + '）');
            }
            return resp.text().then(function (bodyText) {
                var data;
                try {
                    data = JSON.parse(bodyText);
                } catch (e) {
                    // 未登录时接口通常返回登录页 HTML 而不是 JSON
                    throw new Error('请先登录研究生综合服务平台 yjs1.ustc.edu.cn');
                }
                if (!data || data.code !== '0') {
                    throw new Error((data && (data.msg || data.message)) || ('接口返回异常（' + url + '）'));
                }
                return data;
            });
        });
    }

    function fetchSemesterList() {
        return postForm(XNXQ_API, { SFSY: '1', pageSize: '100', pageNumer: '1' }).then(function (data) {
            var rows = (data.datas && data.datas.xnxqxxcx && data.datas.xnxqxxcx.rows) || [];
            var out = [];
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].DM && rows[i].MC) out.push(rows[i]);
            }
            return out;
        });
    }

    function fetchTimetableRows(dm) {
        var querySetting = [{ name: 'XNXQDM', linkOpt: 'AND', builderList: 'cbl_String', builder: 'equal', value: dm }];
        return postForm(KBCX_API, {
            querySetting: JSON.stringify(querySetting),
            pageSize: '999',
            pageNumber: '1'
        }).then(function (data) {
            return (data.datas && data.datas.xskbxxcx && data.datas.xskbxxcx.rows) || [];
        });
    }

    // 页面当前显示的学期名，用于优先匹配。跨域 iframe 读不到时静默跳过，不影响后续兜底。
    function getDisplayedSemesterName() {
        var docs = [document];
        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
            try {
                var frameDoc = frames[i].contentDocument || (frames[i].contentWindow && frames[i].contentWindow.document);
                if (frameDoc) docs.push(frameDoc);
            } catch (e) { /* 跨域跳过 */ }
        }
        for (var j = 0; j < docs.length; j++) {
            try {
                var el = docs[j].getElementById('xnXqSpan') || docs[j].querySelector('h2 > label.bh-form-label');
                var t = el && (el.textContent || '').trim();
                if (t && /^\d{4}年/.test(t)) return t;
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    function pickSemester(rows) {
        var displayed = getDisplayedSemesterName();
        if (displayed) {
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].MC === displayed) return rows[i];
            }
        }
        for (var k = 0; k < rows.length; k++) {
            if (String(rows[k].SFDQXQ) === '1') return rows[k];
        }
        return rows[0] || null;
    }

    var ROW_FIELDS = ['KCMC', 'ZCMC', 'PKSJDD', 'RKJS'];

    function pickRowFields(rows) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var src = rows[i] || {};
            var dst = {};
            for (var f = 0; f < ROW_FIELDS.length; f++) {
                dst[ROW_FIELDS[f]] = src[ROW_FIELDS[f]] || '';
            }
            out.push(dst);
        }
        return out;
    }

    return fetchSemesterList().then(function (semesters) {
        if (!semesters.length) {
            throw new Error('未获取到学期信息，请确认已登录研究生综合服务平台并进入课表查询页面');
        }
        var sem = pickSemester(semesters);
        if (!sem) {
            throw new Error('未获取到学期信息，请确认已登录研究生综合服务平台并进入课表查询页面');
        }
        return fetchTimetableRows(sem.DM).then(function (rows) {
            if (!rows.length) {
                throw new Error('该学期暂无课程数据（' + sem.MC + '）');
            }
            return JSON.stringify({
                term: {
                    dm: sem.DM,
                    mc: sem.MC,
                    zs: sem.ZS || null,
                    startDateRaw: sem.TYKSRQ || sem.QSSJ || sem.ZCRQ || null
                },
                rows: pickRowFields(rows)
            });
        });
    });
})()
