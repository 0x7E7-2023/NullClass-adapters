# 安全审计：`upc-grad`（中国石油大学（华东）· 研究生综合管理系统）

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) `UPC/upc_graduate.js`（MIT，上游作者 **Haooz**，见同目录 `adapters.yaml` 的 `maintainer`），快照 2026-09-22 |
| 上游入口 | `adapters.yaml` 的 `import_url` = `https://degrees.upc.edu.cn/`——**不走 WebVPN**，直连研究生综合管理系统 |
| 平台 | ASP.NET WebForms 自研系统（`/Gstudent/Course/StuCourseQuery.aspx`）。课表已经服务端渲染在页面的 `<table id="ctl00_contentParent_dgData">` 里，格子文本用全角「｛｝」把 课名/周次/教师/地点 编码进去；不需要任何接口请求。唯一的网络调用是可选的教学日历页 `/PublicPage/TermCalender.aspx`（同源相对路径），用来取开学日期与总周数。 |
| 移植者 | NullClass 适配器移植（Claude Code agent）　日期 **2026-09-22** |
| 结论 | **通过**：不碰凭据、不外发、只读课表与教学日历、无第三方域、无埋点、不写页面。逐条留证见下。 |

本科版 `upc/`（强智 `/jsxsd/`，走 WebVPN）已单独移植，其 `AUDIT.md` 明确写过「`upc_graduate.js` 不在本次范围」——本审计就是补这一块。两者平台、取数方式、风险面完全不同，不能互相套用结论。

## 1. 脚本实际请求了哪些域

两段脚本里唯一的网络调用：

```bash
$ grep -oE "https?://[A-Za-z0-9.-]+" extract.js parse.js
extract.js:https://github.com          # 只出现在文件头的上游出处注释里，不参与请求
$ grep -nE "fetch\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource|\.src\s*=" extract.js parse.js
extract.js:155:        return fetch(url, { credentials: 'same-origin' }).then(function (response) {
```

| 域 | 上游怎么用 | 我们怎么用 |
|---|---|---|
| `degrees.upc.edu.cn` | 不显式请求（课表已经在页面里；上游只在 `adapters.yaml` 把它当 `import_url`） | **不写死主机名**。教学日历请求 `fetchCalendar()` 用的是相对路径 `/PublicPage/TermCalender.aspx?EID=...&UID=`，落在**当前页面同源**——即用户打开的这台研究生系统自己的域，不一定叫 `degrees.upc.edu.cn`（学校可能有备用域名/端口），但一定是同一个主机。`loginUrl` 会被宿主自动加入白名单，不需要在 `allowHosts` 里重复声明。 |

**没有第二个域**：上游脚本本身也只对 `TermCalender.aspx` 发过一次 `fetch`（`credentials: 'include'`），课表数据全部来自当前页面的 DOM，不像本科版 `upc.js` 那样需要 POST 一个单独的课表接口。移植后同样只有这一处网络调用，改用更保守的 `credentials: 'same-origin'`（同源请求不需要 `include` 那么宽的凭据策略）。

**`allowHosts` 为什么是空数组 `[]`**：两段脚本里**没有任何绝对 URL 参与请求**（唯一的绝对 URL 在注释里，不会被执行）。`fetchCalendar()` 用的相对路径由浏览器自动解析到当前页面的 origin，这本来就在规范 §3.3「与 `loginUrl` 同源」的默认放行范围内，不需要额外声明。这与 `dlutci/manifest.json`（同样 `allowHosts: []`，同源接口）是同一种最小化写法。

## 2. manifest 取值

- **`loginUrl` = `https://degrees.upc.edu.cn/`**——上游 `adapters.yaml` 的 `import_url`，也是用户实际要打开的入口页。
- **`scheduleUrlHint` = `https://degrees.upc.edu.cn/Gstudent/Course/StuCourseQuery.aspx`**——上游脚本文件头注释直接写明的课表查询页路径（`// ASP.NET WebForms（/Gstudent/Course/StuCourseQuery.aspx）：`），来源可信，用于「一键刷新」优先打开这一页。没有账号验证过这条路径在所有部署上都成立，但风险很低：猜错了只是打开的页面不对，用户仍可以自己在系统里导航过去。
- **`allowHosts` = `[]`**：理由见 §1——脚本只请求当前页面同源，没有需要额外放行的域。
- **`minAppVersionCode` = 11**：与 `dlutci` / `ustc` / `upc` 等移植件一致（只用了 `warnings`，没有用 `kind:"boxes"`/`kind:"image"`这类需要新版本的载荷种类，手册 §5.1）。

## 3. 有没有绕过白名单的写法——逐类点名

| 写法 | 有没有 |
|---|---|
| 把目标地址塞进 URL 参数（`?url=` / 代理转发） | **没有**。唯一的请求参数是 `EID`（从页面「教学日历」链接的 `onclick` 属性里原样取出的字符串，做过 `encodeURIComponent`），不是外部地址。 |
| 非同源 iframe / `<img>` / `<script>` 拉取 | **没有**。两段脚本都不创建元素、不 `appendChild`（`grep -nE "createElement\|appendChild\|innerHTML\s*=\|new Image"` 均无命中）。教学日历页取回的 HTML 只交给 `DOMParser`（惰性文档，不执行脚本、不加载子资源）。 |
| 重定向把数据带走 | **没有**。不赋值 `location`、不导航、不开窗。未登录时教学日历接口大概率返回登录页或非 200，`fetchCalendar()` 直接按「拿不到」处理（`return null`），不会把这类响应当成日历数据用。 |
| `fetch(u,{mode:'no-cors'})` / 跨域带凭据 | **没有**。唯一一处 `fetch` 是同源相对路径 + `credentials: 'same-origin'`，没有 `mode` 覆盖、没有跨域目标。 |
| 把主机名拼出来（域名分片、base64 拼串） | **没有**。脚本里连参与请求的主机名字面量都没有，只有路径前缀 `/PublicPage/TermCalender.aspx?EID=`。 |
| WebSocket / EventSource / Service Worker 侧信道 | **没有**（三者在两段脚本里都无命中）。 |
| `sendBeacon` / 隐藏表单提交 | **没有**。 |

## 4. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **通过**。两段脚本都不读 `password` / `pwd` / 登录表单值 / `localStorage` / `sessionStorage` / `document.cookie`（见 §1 的 grep 扫描，均无命中）。登录全程由用户在 WebView 里手工完成；`fetch` 只带同源 cookie（`credentials: 'same-origin'`），不读取、不解析、不转发 cookie 内容本身。 |
| 2 | 不外发 | **通过**。除课表页 DOM 与教学日历这一个同源接口外，没有任何 `fetch`/`XHR`/`sendBeacon`/`WebSocket`/`new Image().src` 指向任何域；提取结果只通过 `return`/`JSON.stringify` 交给宿主，不经过任何网络出口。 |
| 3 | 请求域可控 | **通过**。唯一的请求是当前页面同源的相对路径，不需要额外声明就落在规范 §3.3 的默认放行范围内；`allowHosts` 留空反而是**最小化**的写法（不必要地加一个精确域名反而多一个可能写错的地方）。 |
| 4 | 只读课表 | **通过**。DOM 只读课表表格 `#ctl00_contentParent_dgData` 与教学日历表格（同一个 id，出现在教学日历页里）；不请求成绩、学籍、缴费、个人信息接口——上游脚本本身也没有这些接口。 |
| 5 | 不埋点 | **通过**。无统计、无上报、无遥测；`console.error` 那种上游调试日志在移植时也删掉了（改为 `throw new Error(...)` 让宿主接住并展示给用户）。 |
| 6 | 不 eval 远程代码 | **通过**。无 `eval` / `new Function`（宿主用 `new Function` 编译适配器脚本本身是宿主机制，不是适配器行为）。教学日历 HTML 只经 `DOMParser` 解析，`parse.js` 只经 `JSON.parse`。 |
| 7 | 不写页面 | **通过**。两段脚本对页面只读，不调用任何 DOM 写 API（`createElement`/`appendChild`/`innerHTML=`/`document.write` 均无命中）。上游脚本本身也不写页面（它是纯读取 + 弹窗确认，弹窗部分移植时已删除，见 §6）。 |
| 8 | 不依赖用户输入之外的秘密 | **通过**。无硬编码密钥 / 固定令牌 / 他人学号；`EID` 来自当前页面「教学日历」链接的公开 `onclick` 属性（不是账号相关信息），`now` 来自浏览器本地时间。 |

## 5. 读取面（`extract.js` 到底读了什么）

| # | 读什么 | 代码位置 | 取出的值 | 去处 |
|---|---|---|---|---|
| 1 | 当前页面（含同源 iframe）里 `id="ctl00_contentParent_dgData"` 的课表表格 | `findById` + `cellsOfTable` | 每个有课格子的**清洗后文本**（`clean(textContent)`）+ 星期/节次号 + `rowspan` | 载荷 `cells[]`（由 `parse.js` 解释课名/周次/教师/地点） |
| 2 | 页面上「教学日历」链接（`#hykTermCalender` 或 `onclick` 含 `TermCalender.aspx` 的 `<a>`）的 `onclick` 属性 | `findCalendarEid` | 正则提取的 `EID` 参数值（一段不透明字符串） | 只用于拼教学日历页的请求 URL，**不进最终载荷** |
| 3 | 教学日历页（同源相对路径请求回来的 HTML）里同一个 `id="ctl00_contentParent_dgData"` 的日期网格 | `fetchCalendar` → `calendarRowsOfTable` | 每格的 `{day, month}`（正则 `(\d+)\s*\((\d+)月\)` 解析「5(9月)」这类文本） | 载荷 `calendar.rows`（年份推算、开学日、总周数的计算在 `parse.js`） |
| 4 | `document.title` | `termHintOf` | 只做一次正则匹配 `(20\d{2})-(20\d{2})学年第?[一二三123]学期`，命中就取**整个匹配串**，不命中就是 `null` | 载荷 `termHint`（`parse.js` 里当学期名候选，找不到才按开学日期推算） |

**不读的东西**：`document.body`、任意元素的任意属性、`localStorage`/`sessionStorage`、除上述两个表格 id 之外的任何页面结构。教学日历请求失败（无 `EID`、非 2xx、网络错误、解析不出表格）时一律 `return null`，不重试、不改用别的接口、不影响课表本身的提取（课表来自当前页面 DOM，与日历请求相互独立）。

`parse.js` 不读页面、不联网：输入是 `extract.js` 交出来的 JSON 字符串（`__ncInput`），是纯函数（CI 用 Rhino 真跑）。

## 6. 移植时删掉/改了的上游行为（不涉及安全也记一下）

- **弹窗全删**：`showAlert` 确认「已登录并打开课表查询页」、一串 `showToast`、`notifyTaskCompletion()`。找不到课表表格或课表为空时直接 `throw new Error(...)`，宿主自己会展示错误。
- **不再保存作息时间到 `shiguangBridge`**：`UPC_TIME_SLOTS`（12 节，08:00 起，与本科版 `upc/parse.js` 完全一致——教务处公布的全校统一作息）直接写进 `parse.js` 的 `PERIOD_TIMES` 常量，作为 `terms[0].periodTimes` 的一部分交给宿主，不需要单独的保存步骤。
- **周次/课名/教师/地点的解释从 `extract.js` 搬到 `parse.js`**：上游把 `parseWeeksText`/`parseCellText`/`mergeCourses` 都写在会在浏览器里跑的那一段；移植后这些是纯字符串处理（不碰 DOM），所以整体搬进 `parse.js`——CI 用 Rhino 真跑得到，`extract.js` 只交格子的原始文本。
- **教师默认值从 `"未知"` 改成 `null`**：上游 `parseCellText` 对没解析出教师/地点的情况写死 `"未知"`/`"待定"`；移植手册 §4.7 明确说「空着比写『未知』好」（会被当成真名字显示），本次统一改成 `null`。
- **教学日历的年份推算/开学日/总周数计算原样保留语义**：上游 `parseTermCalendar` 的「月份 ≤ 2 属于上一自然年」「第 1 行星期一 = 开学日」「行数 = 总周数」三条规则原样移植到 `parse.js`，只是从 `DOMParser` 解析 HTML 字符串改成消费 `extract.js` 已经结构化好的 `{day,month}` 网格（`DOMParser` 在 CI 的 Rhino 环境里不存在，不能留在 `parse.js` 里）。
- **新增：越界周次丢弃**（上游没有这条）：上游 `parseWeeksText` 不检查周次范围，理论上教务给出「35-40 周」这种明显错误的数据会原样进课表，触发宿主 `JwPayloadCodec` 的 `endWeek > totalWeeks` 校验直接让整次导入失败。移植时加了 `MAX_WEEK = 30`（`core.model.MAX_TOTAL_WEEKS`）上限过滤，超界的周次丢弃并计数进 `warnings`，不让个别脏数据拖垮整次导入。
- **新增：格式无法识别的课程计数进 `warnings`**（上游是静默 `return`，直接丢）：一段文字里如果一个「周次[教师:...]」都没匹配上（比如「见通知」），上游直接丢弃这门课、不留痕迹；移植后同样丢，但计数进 `stats.skippedParts` 并写进 `warnings`——手册 §4.4「不要静默丢课」的要求。
- **新增：学期名称**（上游完全没有这个概念——它一张课表对应一个学期，不需要学期名）：我们的载荷 `terms[].name` 必填。优先用页面标题里认出来的「YYYY-YYYY学年第X学期」，认不出就按开学日期推算（8 月及以后视为当年第一学期，否则视为上一学年第二学期），并在 `warnings` 里如实说明——这是纯粹为了满足我们自己的载荷契约，不是上游行为。
- **新增：第 12 节之后没有作息时间的提醒**：上游 `UPC_TIME_SLOTS` 本来就只到第 12 节，且找节次号时只认 1~12（`t >= 1 && t <= 12`），理论上不会解析出超过 12 节的课；但 `rowspan` 可以让一门课从第 12 节起跨到第 13 节（`endSection = startSection + rowspan - 1`），这种课块本身合法（`JwPayloadCodec` 不要求 `periodTimes` 覆盖所有 `endPeriod`），只是没有具体上下课时间——移植时加了这条 `warnings`，没有做（也不需要做）额外的作息表顺延。

## 7. fixture 与覆盖范围

三份 fixture 都是**合成数据**（测试方案 §3 的既定代价：移植件拿不到真实教务账号），课名/教师/教室均为虚构，不含任何真实姓名或学号。期望值按手册 §4 与本文件 §6 的规则**独立推出**后再跑 `./gradlew :importer:test --offline` 核对，不是把 `parse.js` 的输出贴回去当期望——三份用例首次跑就与实现完全一致（详见下方「跑门记录」）。

| 用例 | 覆盖 |
|---|---|
| `fixtures/basic`（基本课表） | 教学日历给出开学日（星期一取自日历第 1 行）与总周数；页面标题给出学期名（不需要推算）；单教师单地点课（逗号内联地点）；同一课名两个不同教师（`14周[教师:A]、15-16周[教师:B][地点:Y]` 的「段内无地点则用整段最后一个 `[地点:]` 兜底」）；一个格子里分号分隔的两门课；完全没有地点信息时 `location` 留 `null`。零 `warnings`（教务信息齐全时的干净路径）。 |
| `fixtures/weeks`（周次写法） | 教学日历不可用（`calendar: null`）；连续周（`1-16` → `ALL`）；离散偶周（`2,4,6,8,10` → `EVEN`，不是靠显式「双」字，靠数字间距推出来）；离散奇周（`1,3,5,7,9` → `ODD`）；反写区间（`16-14` 自动交换成 `14-16`）；越界周次（`35-36`，超过 30 周上限，整门课因此无有效周次而丢弃）；格式无法识别（`｛见通知｝`，没有任何「周[教师:]」段）；开学日期与总周数均按推算兜底；学期名按开学日期推算（3 月 → 上一学年第二学期）。五条 `warnings` 同时触发，顺序验证。 |
| `fixtures/edge`（边界） | 教学日历**有**但缺星期一那一格（`calendar.rows[0][1] = null`）——总周数能从日历行数拿到，开学日仍需推算，两条独立的 `warnings` 互不影响；课表最大周次（16 周）超过日历给出的总周数（10 周），触发「放宽总周数」而不是「未提供总周数」；第 12 节之后的连堂（`startSection=12, endSection=13`，`rowspan=2`）；同名同教师、不同天/不同教室的两个课块合并进同一门课的 `blocks[]`；一个格子里分号分隔的两门课（复用同一地点）。三条 `warnings`。 |

**跑门记录**：`./gradlew :importer:test --offline`（重试一次后通过，首次失败是 `java.io.EOFException`——Gradle daemon 级别的瞬时问题，与本适配器代码无关，重跑即绿）。`JwLibraryHarnessTest` 的 5 个用例全部通过，其中「每个适配器的 parse 脚本能跑通 fixture」逐条比对了本适配器的三份 fixture，`basic`/`weeks`/`edge` 首次运行即与手工推算的期望值完全一致（未经过「跑一遍再回填期望值」的自证陷阱，见测试方案 §3.1）。

## 8. 已知不确定 / 只有真机能验

1. **fixture 是合成的**：只保证「同样的输入永远得到同样的输出」，**不保证真实页面上的解析是对的**。拿到真实 dump 请替换 `fixtures/*.extracted.json` 并重跑门，顺便核对三件事：
   ① 格子文本的全角「｛｝」编码在真实部署上是否始终成立（会不会有的学期用半角括号、或者格式版本不同）；
   ② 教学日历链接是不是**始终**叫 `hykTermCalender`、`EID` 参数是不是**始终**在 `onclick` 属性里（也可能是 `href` 或数据属性，上游脚本只验证过一种形态）；
   ③ 节次号列是否**始终**是「纯数字 1~12」，会不会出现「第1节」这种带汉字后缀、导致 `cellsOfTable` 的数字探测失效的写法。
2. **`scheduleUrlHint` 未经账号验证**：路径取自上游脚本文件头注释，公开可信但没有人拿真实账号点开过，一键刷新如果打不开这一页，用户仍可以自己导航过去，不是阻断性问题。
3. **`warnings` 的显示要新版应用**：`minAppVersionCode` 取 11，老版本能装、能导入，只是不显示核对提示。
4. **没有账号做过真机抽验**（测试方案 §4 的第 ③ 层）：本适配器与上游一样，正确性靠用户反馈迭代；`extract.js` 的选择器/接口正确性不在 CI 覆盖范围内（测试方案 §2：CI 只跑 `parse.js`）。

签名：NullClass 适配器移植（Claude Code agent）　2026-09-22
