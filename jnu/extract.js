(function () {
    // 暨南大学教务适配器（金智教育 jwapp / 我的课表 wdkb）—— 取数
    //
    // 移植自 shiguang_warehouse 的 JNU/jnu_01.js（MIT）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游快照：03d161a；本校脚本最后提交 80e30cf。
    // 脚本正文没有署名。同目录 adapters.yaml 的维护者是 White-Dew-Boy，manifest 用这个名字。
    //
    // 移植改动（与 AUDIT.md 一致）：
    //   1. 只在「我的课表」页取数。登录页、新教务首页、其它页面直接提示，不发请求。
    //   2. 学年学期只读页面上 dqxnxq2 的 value，不弹窗让人选学年学期。
    //   3. 不弹「仅珠海校区」确认框；节次时间由 parse.js 固定用珠海校区并写进提醒。
    //   4. 只请求课表这一个地址，请求体只有 XNXQDM。
    //   5. 交出去的每行只留 KCM / SKJS / JASMC / SKSJ。学号、姓名等一律不带出。
    //   6. 不算周次、不拼课程，那是 parse.js 的活。
    //
    // 课表地址写死本校教务主机，不跟着当前页面的域走。
    var COURSE_URL = 'https://jw.jnu.edu.cn/jwapp/sys/wdkb/modules/xskcb/xskcb.do';
    var COURSE_FIELDS = ['KCM', 'SKJS', 'JASMC', 'SKSJ'];

    function text(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    function isoDay(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    // 登录页、门户页不发请求。判断与上游一致：地址里的 login?、new/index.html、jwapp/sys/wdkb。
    function pageProblem() {
        var href = String(window.location && window.location.href || '').toLowerCase();
        if (href.indexOf('login?') >= 0) {
            return '请先登录教务，登录后打开「我的课表」再提取';
        }
        if (href.indexOf('new/index.html') >= 0) {
            return '请先进入「我的课表」，看到课表后再提取';
        }
        if (href.indexOf('jwapp/sys/wdkb') < 0) {
            return '请先打开暨南大学「我的课表」页面，看到课表后再提取';
        }
        return '';
    }

    // 金智信封只认 datas.xskcb 这一处，空课表和挑字段都用它。
    function tableOf(json) {
        if (!json || !json.datas || !json.datas.xskcb) return null;
        var table = json.datas.xskcb;
        if (typeof table !== 'object') return null;
        return table;
    }

    function pick(rows) {
        var out = [];
        var i;
        for (i = 0; i < rows.length; i++) {
            var src = rows[i] || {};
            var dst = {};
            var k;
            for (k = 0; k < COURSE_FIELDS.length; k++) {
                var field = COURSE_FIELDS[k];
                if (Object.prototype.hasOwnProperty.call(src, field)) dst[field] = src[field];
            }
            out.push(dst);
        }
        return out;
    }

    var problem = pageProblem();
    if (problem) throw new Error(problem);

    var node = document.getElementById('dqxnxq2');
    var code = node ? text(node.getAttribute('value')) : '';
    if (!code) {
        throw new Error('没能读到当前学年学期，请在「我的课表」里等课表显示出来后再提取');
    }

    return fetch(COURSE_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
        },
        body: 'XNXQDM=' + encodeURIComponent(code)
    }).then(function (response) {
        if (response.status === 403) {
            throw new Error('教务系统拒绝访问（错误码 403）：请在页面里点开一次「我的课表」，看到课表后再提取');
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error('教务系统返回错误（代码 ' + response.status + '），请稍后再试');
        }
        return response.json().then(function (json) {
            return json;
        }, function () {
            throw new Error('教务没有返回课表数据，登录可能已失效，请重新登录后再试');
        });
    }).then(function (json) {
        var table = tableOf(json);
        if (!table || !Array.isArray(table.rows)) {
            throw new Error('没能读到课表数据，请在「我的课表」里确认课表已经显示后再试');
        }
        if (Number(table.totalSize) === 0 || table.rows.length === 0) {
            throw new Error('这学期的课表是空的，请在「我的课表」里核对学年学期后再提取');
        }
        return JSON.stringify({
            term: { code: code, name: '', source: 'page' },
            today: isoDay(new Date()),
            rows: pick(table.rows)
        });
    });
})()
