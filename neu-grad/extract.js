(function () {
    // 东北大学（研究生）教务适配器（金智教育研究生系统 gsapp 平台）—— 取数段
    //
    // 移植自 shiguang_warehouse 的 NEU/neuyjs.js（MIT，上游作者 Vera-zero）
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse
    // 上游 yaml：adapter_id NEU_2，import_url https://yjs.neu.edu.cn/
    //
    // 平台核实：上游唯一的接口是
    //   POST https://yjs.neu.edu.cn/gsapp/sys/wdkbapp/xskcb/loadPkjg.do
    //   body: XNXQDM=<学年学期代码，如 20261>&ZC=
    // 响应是 { jgList: [...], jcList: [...] }（不是金智本科 jwapp 常见的
    // { code, datas: {...} } 信封），jgList 是排课行，jcList 是节次时间表。
    // 与本科 neu（jwxt.neu.edu.cn，jwapp 平台）是同厂商不同产品线（gsapp 研究生系统），
    // 接口路径、信封结构、字段名都不一样，没有可复用的取数逻辑。
    //
    // 请求全部是**当前页面同源**的相对路径（= manifest 的 loginUrl 主机 yjs.neu.edu.cn），
    // 没有第二个域，所以 allowHosts 是空数组。
    //
    // 上游的交互（手输学年、手选学期）没有移植：上游没有「当前学期」查询接口可用
    // （不像本科 neu 那样有 kb/xnxq.do），所以这里按本机日期推算学年学期代码
    // （与本科 neu 的 termFromDate 同一套校历假设：秋季学期 9 月开学，春季学期次年
    // 2~3 月开学，7~8 月按春季学期猜，1 月还在秋季学期里）——推算结果**总是**
    // 写进 warnings，因为上游本来就没有别的数据源可以验证它。
    //
    // 交出去的是教务的原始行（jgList / jcList）加学期代码：不算周次、不拼课程、
    // 不切段（那是 parse.js 的活）。输出前剔除学号 / 姓名等个人字段，只留排课信息。
    var PERSONAL = {
        XH: true,
        XM: true,
        XH_ID: true,
        SFZH: true,
        USERID: true,
        USERNAME: true,
        USER_NAME: true,
        STUDENTID: true,
        STUDENTNUMBER: true,
        REALNAME: true
    };

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function withoutPersonal(rows) {
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var src = rows[i];
            if (!src || typeof src !== 'object') continue;
            var dst = {};
            for (var key in src) {
                if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
                if (PERSONAL[String(key).toUpperCase()]) continue;
                dst[key] = src[key];
            }
            out.push(dst);
        }
        return out;
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // 上游没有「当前学期」接口，只能按本机日期推算（与本科 neu 的 termFromDate 同一套假设）。
    function termFromDate(now) {
        var y = now.getFullYear();
        var m = now.getMonth() + 1;
        if (m >= 8) return y + '1';
        if (m <= 1) return (y - 1) + '1';
        return (y - 1) + '2';
    }

    // 开学日同样没有任何接口可查（上游 config 里连 semesterStartDate 字段都没有），
    // parse.js 只能按「提取时刻所在周的周一」推算。这里把提取时刻的日期原样交出去，
    // 而不是让 parse.js 自己调 new Date()——parse.js 要在 CI 里被 Rhino 反复重放
    // 同一份 fixture，必须是纯函数（规范 §5.2），日期只能从输入来，不能现算「现在」。
    function todayIso(now) {
        return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }

    function jsonOrNull(response) {
        if (!response || response.status < 200 || response.status >= 300) return null;
        return response.json().then(function (json) {
            return json;
        }, function () {
            return null;
        });
    }

    function fetchCourses(xnxqdm) {
        var path = '/gsapp/sys/wdkbapp/xskcb/loadPkjg.do';
        var options = {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: 'XNXQDM=' + encodeURIComponent(xnxqdm) + '&ZC='
        };
        return fetch(path, options).then(jsonOrNull, function () {
            return null;
        });
    }

    // 唯一的请求是「必须成功」的课表请求：给一次立刻重试（宿主给整段脚本 30 秒，
    // 正常一次请求远用不完这个预算）。
    function fetchCoursesWithRetry(xnxqdm) {
        return fetchCourses(xnxqdm).then(function (json) {
            if (json && isArray(json.jgList)) return json;
            return fetchCourses(xnxqdm);
        });
    }

    var now = new Date();
    var xnxqdm = termFromDate(now);
    var extractedOn = todayIso(now);

    return fetchCoursesWithRetry(xnxqdm).then(function (data) {
        if (!data || !isArray(data.jgList) || data.jgList.length === 0) {
            throw new Error('没能取到课表数据：可能是该学期暂无课程数据，或登录状态已失效，' +
                '请在教务页面里重新登录后再点「提取课表」');
        }
        var jcList = isArray(data.jcList) ? data.jcList : [];

        return JSON.stringify({
            term: {
                code: xnxqdm,
                source: 'guess',
                extractedOn: extractedOn
            },
            jgList: withoutPersonal(data.jgList),
            jcList: jcList
        });
    });
})()
