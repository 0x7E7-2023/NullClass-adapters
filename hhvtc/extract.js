(function () {
    // 怀化职业技术学院教务适配器（青果教务，隐藏课表详情）—— 第一步：只取数。
    //
    // 移植自 shiguang_warehouse 的 HHVTC/hhvt.js
    //   https://github.com/XingHeYuZhuan/shiguang_warehouse  （MIT，作者 Haooz）
    //   上游快照 29498b026708ecb8d837c8fdc1e53b768a394e4e（2026-11-03 对齐 origin/main），本校脚本最后一次修改 80e30cf
    // 移植改动：
    //   ① 改为一个表达式与 ES5 写法，异步轮询改用 Promise 和 then 链。
    //   ② 不弹窗、不调用拾光保存桥；只交原始课程详情与本地日期，由 parse.js 纯转换。
    //   ③ 保留主文档、同源 iframe 与 frame 的查找，以及最长 6 秒的详情区等待。
    //   ④ 只交课程名称、任课教师、上课时间、上课地点四项白名单内容；合班信息、格子文字、元素标识与其他页面文字均不交。
    //   ⑤ 登录页只检查密码框是否存在，不读取任何输入值；所有入口都不发网络请求。
    //   ⑥ 节次选择不在此计算，也不在提取时询问；本地日期交给 parse.js 按上游默认月份规则选择。
    //   ⑦ 只读页面，不写页面、不点击、不提交表单，不读取凭据或存储。
    //
    // 上游课表单元格的可见内容可能为空，真实课程在标识以 weekly0 开头的隐藏详情区 ul/li 中。
    // 本校上游没有任何课表网络请求，本移植同样为零请求，不需要图片或 OCR。
    var DETAIL_WAIT_MS = 6000;
    var DETAIL_POLL_MS = 300;

    function localTodayIso() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var day = now.getDate();
        return now.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
    }

    function collectDocs() {
        var docs = [document];
        var frames = document.querySelectorAll('iframe, frame');
        for (var i = 0; i < frames.length; i++) {
            try {
                if (frames[i].contentDocument) docs.push(frames[i].contentDocument);
            } catch (e) {
                // 跨域内嵌页不可读，忽略。
            }
        }
        return docs;
    }

    function onLoginPage(docs) {
        for (var i = 0; i < docs.length; i++) {
            if (docs[i].querySelector('input[type="password"]')) return true;
        }
        return false;
    }

    function valueOfLabel(source) {
        return source.replace(/^.*?[:：]/, '').replace(/\s+/g, ' ').trim();
    }

    function readDetails(doc) {
        var divs = doc.querySelectorAll('[id^="weekly0"]');
        if (!divs.length) return null;
        var details = [];
        for (var i = 0; i < divs.length; i++) {
            var lis = divs[i].querySelectorAll('li');
            var item = { name: '', teacher: '', timeText: '', location: '' };
            for (var j = 0; j < lis.length; j++) {
                var line = (lis[j].textContent || '').trim();
                if (line.indexOf('课程名称') !== -1) item.name = valueOfLabel(line);
                else if (line.indexOf('任课教师') !== -1) item.teacher = valueOfLabel(line);
                else if (line.indexOf('上课时间') !== -1) item.timeText = valueOfLabel(line);
                else if (line.indexOf('上课地点') !== -1) item.location = valueOfLabel(line);
            }
            if (item.name || item.teacher || item.timeText || item.location) details.push(item);
        }
        return details;
    }

    function findDetails() {
        var deadline = Date.now() + DETAIL_WAIT_MS;
        return new Promise(function (resolve, reject) {
            function poll() {
                var docs = collectDocs();
                if (onLoginPage(docs)) {
                    reject(new Error('当前打开的是登录页。请先登录教务系统，再打开课表查询页，然后点「提取课表」'));
                    return;
                }
                for (var i = 0; i < docs.length; i++) {
                    var details = readDetails(docs[i]);
                    if (details !== null) { resolve(details); return; }
                }
                if (Date.now() >= deadline) {
                    reject(new Error('没有找到课表详情。请确认已登录并打开本人的课表查询页，能看到课程后再点「提取课表」'));
                    return;
                }
                setTimeout(poll, DETAIL_POLL_MS);
            }
            poll();
        });
    }

    return findDetails().then(function (details) {
        return JSON.stringify({ today: localTodayIso(), details: details });
    });
})()
