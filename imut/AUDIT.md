# 安全审计 —— 内蒙古工业大学（自研 MVC 教务，jw.imut.edu.cn/academic）

审计对象：`jw-adapters/imut/` 下的 `extract.js` / `parse.js` / `manifest.json` / `fixtures/`，
以及它们移植自的上游脚本 `shiguang_warehouse` 的 `IMUT/IMUT_01.js`（MIT，上游作者 wuko233；快照
`baf83fa7972d4be6627c534992f7d2da399a0945`，`IMUT/IMUT_01.js` 最后一次修改 `1fe584c`，与任务卡开卡时记的「上游最后提交」一致）。

审计方式：逐行读上游脚本与移植件，跑移植手册 §5 的静态扫描，用 Rhino 实跑 fixtures，用 Playwright 起假教务站（GBK 页面，全部请求被拦下）
跑冒烟，最后在副本上做六处变异。

静态扫描结果（2026-11-10）：

- 绝对 URL：`extract.js` 代码里没有绝对地址，三条请求都是站内相对路径（`SCHEDULE_PATH` / `WEEK_PATH` / `TERM_PATH`），
  主机名常量 `jw.imut.edu.cn` 只用来判断当前页面是不是本校教务，不参与拼地址；文件头的上游仓库地址在注释里。
  `parse.js` 里没有任何 URL。`manifest.json` 的 `loginUrl` / `scheduleUrlHint` / `homepage` 是宿主声明。
- 网络调用：`extract.js` 只有 `getDoc` 一处的 `fetch`，三个调用点：
  `loadTerm`（GET 当前学期页）、`loadWeekInfo`（POST 第 1 周页）、`loadTimetable`（GET 课表页）。
  没有 XHR / `sendBeacon` / `WebSocket` / `new Image`；`parse.js` 零网络。
- 凭据、存储、动态执行：`localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` /
  `.submit` / `.innerHTML =` / `setAttribute` 全部无命中（登录判断用 `'pass' + 'word'` 拼出类型名）。
- ES5 token 扫描（注释也算）：箭头函数、反引号、`let ` / `const `、`class`、`async` / `await`、`Set` / `Map`、
  `padStart`、`Array.from`、`includes(` / `startsWith(`、可选链、`??` 全部无命中；控制字节为 0。
- 模板残留：检索 `bjtu`、`北京交通大学`、`aa.bjtu`、`xnxq`，代码 / manifest / fixtures 零命中
  （仅 `parse.js` 注释里有意写「照批次十已审计的 swu / 批次三十三的 bjtu」）。

## 0. 平台与上游（任务卡分析）

上游 `resources/IMUT/adapters.yaml` 只有一份：`adapter_id: IMUT`、`maintainer: wuko233`、
`import_url: http://jw.imut.edu.cn/academic/login/imut/loginIds6Valid.jsp`。**没有第二个上游脚本可取舍。**

本校是自研 MVC（JSP 服务端渲染，**GBK** 编码）：

- 当前学年学期在 `/academic/student/currcourse/currcourse.jsdo` 的 `<eduaffair:CTRT year term studentid>` 上：
  `year` 是「年份 − 1980」（45 = 2025 学年），`term` 1 = 春、2 = 夏、3 = 秋；同一页 `#title td div` 里还有「2025秋」这样的文本。
- 整学期课表在 `/academic/manager/coursearrange/showTimetable.do?id=…&yearid=…&termid=…&timetableType=STUDENT&sectionType=BASE`：
  `table#timetable` 每行第一格是 `第N节 / 08:00 / ┆ / 08:45`，其余格子是当天的课，形如
  `<<课名>>;教学班号 / 上课地点 / 教师 / 周次 / 讲课`，用 `<br>` 分行；一格叠多门；没课的格子是 `&nbsp;`。
- 逐周页 `/academic/manager/coursearrange/studentWeeklyTimetable.do`：`select[name="whichWeek"]` 的选项是学期周次列表，
  按 `whichWeek=1` 取回来的那一页的 `td[name="td0"]` 是学期第一周的星期一。

与模板（`bjtu`：fetch 课表页 + DOMParser + 服务端渲染 DOM）的**不同构**之处与处理：

| 层 | 本校 | 处理 |
|---|---|---|
| 编码 | 整页 GBK | `arrayBuffer` + `TextDecoder('gbk')`，失败再试 `gb18030`，都失败就报错（不交乱码） |
| 学期来源 | 教务的 `year`/`term` 数字码，不是 `YYYY-YYYY-N` 文本 | 按「年份 − 1980 + 季」换算；`parse.js` 里 `effectiveTerm` 换算成「2025-2026学年第1学期」 |
| 开学日 | 第 1 周页 `td[name="td0"]` 给了日期 | 取回来回退到那一周的周一；取不到才按 9 月 1 日 / 3 月 2 日推算 |
| 总周数 | `whichWeek` 选项的最大周是学校给的周次表 | 用它当总周数（不是「课表里出现的最大周」）；读不到才用 20 |
| 节次时间 | 页面 `th` 里有；学校官网另有写死表 | 页面有就用页面，没有就用学校公布的 12 节并提醒 |
| 课程格 | 一格多条文字，用 `<<课名>>` 分课 | `extract.js` 只按行交出文字，认课全在 `parse.js` |
| 写操作 | 上游会请求 `currcourse.jsdo?year=&term=` 切换服务器上的当前学期 | **不移植**（只读原则） |

内置节次时间（逐节，照上游 `defaultTimeSlots`，来源学校官网 2025-11-23）：
1 08:00-08:45 / 2 08:55-09:35 / 3 10:05-10:50 / 4 11:00-11:40 / 5 13:30-14:15 / 6 14:25-15:05 /
7 15:35-16:20 / 8 16:30-17:10 / 9 18:00-18:45 / 10 18:45-19:35 / 11 19:45-20:30 / 12 20:30-21:20。

入口按主调度给的值：`loginUrl` = 统一身份认证登录页（`/academic/login/imut/loginIds6Valid.jsp`），
`allowHosts` = `["jw.imut.edu.cn"]`，`scheduleUrlHint` = 课表页完整地址 `…/showTimetable.do`。

## 1. 请求清单（与代码逐条对应）

| # | 方法 | 地址 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `/academic/student/currcourse/currcourse.jsdo`（同源，`credentials: include`） | 无 | 读 `<eduaffair:CTRT>` 的 `year` / `term` / `studentid`，读不到再看 `#title td div`（`loadTerm` / `termOf`） | 只有当前页就是整学期课表页、且地址里 `id`+`yearid`+`termid` 都齐全时才**不请求**这条（逐周页也带学年学期但没有 `id`，照样要请求）；请求失败也不拦课表，`parse.js` 按今天的日期推算学期并提醒 |
| 2 | POST | `/academic/manager/coursearrange/studentWeeklyTimetable.do` | `yearid=<yearid>&termid=<termid>&whichWeek=1`（`application/x-www-form-urlencoded`） | 一次拿两样：`td[name="td0"]` 是开学那一周的日期，`select[name="whichWeek"]` 的选项是学期周次列表（`loadWeekInfo` / `weekInfoOf`） | 没有学年学期时不请求；失败或页面结构不对都只当「没拿到」，`parse.js` 推算开学日、按 20 周导入并提醒 |
| 3 | GET | 当前页就是课表页且地址里带 `yearid=`、`termid=` 时 = 它自己的 `pathname + search`；否则 `/academic/manager/coursearrange/showTimetable.do?id=<studentid>&yearid=<yearid>&termid=<termid>&timetableType=STUDENT&sectionType=BASE` | 无 | 拿整学期课表页：节次时间 + 课程格子（`timetableUrl` / `loadTimetable`） | 401/403 → 「还没登录教务系统…」；其它非 2xx → 「教务系统返回错误（代码 N）…」；网络失败 → 「连不上教务系统…」；返回登录页 → 「还没登录教务系统…」；没有 `table#timetable` → 「没有找到课表…」 |

只有这三条请求，全在 `jw.imut.edu.cn` 同源上，没有备用接口。**不弹窗问学期**：用户在教务里选好的学期会出现在课表页地址里
（第 3 条的 `pathname + search`），导入的就是他看到的那个学期；提醒里仍告诉他「要导入别的学期，先在教务系统里切换」——这条是走得通的。

不发请求的情形（都在请求之前判断）：
- 当前主机不是 `jw.imut.edu.cn` → 「当前页面不是内蒙古工业大学的教务系统…」；
- 当前路径含 `/login`、`/loginids6valid`、`/cas`、`/sso`、`/authserver`，或当前页有密码框 → 「还没登录教务系统…」。

提问桥：**一次都不用**（本校没有校区 / 作息分支，学期也不弹窗问）。

## 2. 读了什么、交出去什么（逐字段）

`extract.js` 交给 `parse.js` 的对象（`JSON.stringify` 后的字符串，`collect`）：

| 字段 | 内容 | 来源 |
|---|---|---|
| `year` | 学年码，如 `"45"`（= 2025 − 1980） | `<eduaffair:CTRT year>`，或当前课表页地址里的 `yearid` |
| `term` | 学期码 `"1"` 春 / `"2"` 夏 / `"3"` 秋 | `<eduaffair:CTRT term>`，或地址里的 `termid` |
| `termText` | 学年学期读不到时的兜底文本（如「2025秋」） | `#title td div` |
| `today` | 提取当天日期（本地日期，不用 `toISOString`） | 本机时钟 |
| `firstClassDate` | 学期第一周的日期（原文） | 第 1 周页的 `td[name="td0"]` |
| `weekCount` | 学期周次列表的最大周（数字，0 = 没读到） | `select[name="whichWeek"]` 的 `option` |
| `timeSlots[]` | `{number, start, end}`：每节的节次与上下课时间 | `table#timetable` 每行 `th` 里的「第N节」与两个 `HH:MM` |
| `rows[]` | `{day, section, lines}`：一条上课安排；`lines` 是这一格按行切好的文字 | `table#timetable` 每行的 `td`（第几个 `td` 就是星期几，`colspan` 会顺延） |

`studentid`（学号）只用来拼第 3 条请求的 `id=` 参数，**不进输出、不进报错、不写存储**。
课程格子里藏着的学号 / 姓名 / 身份证 / 手机号也带不出来：只读**看得见**的文字——`hidden` 属性、`aria-hidden`、
内联或计算样式把 `display` / `visibility` 关掉、没有渲染尺寸的元素整棵子树跳过（`hiddenElement`）；每行截到 120 字。
冒烟 `normal` 在课程格子里塞了学号 / 姓名 / 手机号（`display:none`），输出与载荷里都找不到（§7 变异 1 钉住这一点）。

`parse.js` 是纯函数：不碰网络、不碰页面，输出的教师名只是课表本来就显示的任课教师，不含学生信息。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读登录表单、密码、Cookie、本地存储；不提交任何表单。登录判断只查页面上有没有密码框 |
| 2 | 不外发 | 通过。只有三条同源请求；没有 `sendBeacon` / `WebSocket` / `new Image`；不往第三方发任何东西 |
| 3 | 请求域可控 | 通过。只请求 `jw.imut.edu.cn`（精确主机、无通配），与 `allowHosts` 一致；`parse.js` 零请求 |
| 4 | 只读课表 | 通过。只请求当前学期页、第 1 周页、课表页；不请求成绩 / 学籍 / 个人信息 / 缴费；上游那条会**改服务器当前学期**的 `currcourse.jsdo?year=&term=` 没有移植 |
| 5 | 不埋点 | 通过。无统计 / 上报 / 遥测；上游的 `console.error` / `showToast` 都没有移植 |
| 6 | 不 eval 远程代码 | 通过。无 `eval` / `new Function`；教务文字只做字符串处理 |
| 7 | 不写页面 | 通过。不写 DOM、不改表单、不提交、不点击；只读 `querySelector` / `getElementsByTagName` / `textContent` |
| 8 | 不依赖用户输入之外的秘密 | 通过。无硬编码密钥 / 令牌 / 他人学号；常量只有选择器、路径、格式与学校公布的节次时间 |

## 4. 给学生看的文字

`extract.js` 的报错与 `parse.js` 的 warnings 按 `docs/ux-writing.md` 写：不出现「接口」「载荷」「上游」「脚本」「字段」
「JSON」「HTML」「null」「学期设置」「作息表」；时间表统一叫「节次时间」；改学期名 / 开学日 / 总周数 / 节次时间指向「学期管理」，
改教师 / 地点指向「编辑课程」；状态码写成「教务系统返回错误（代码 N）」。

提醒清单（顺序固定）：① 学期来源（教务的年号 / 学期号，或按今天的日期推算）；② 开学日（第 1 周页的日期 / 推算）；
③ 总周数（教务周次列表 / 20 周 / 因课表更晚而抬高）；④ 节次时间（照教务页面 / 学校公布的表）；⑤ 表外节次的补齐；
⑥ 认不出课名的格子；⑦ 被跳过的格子（缺课名 / 星期 / 节次 / 周次，分类计数 + 认不出的周次原文）；⑧ 缺教师 / 缺地点汇总；
⑨ 教学班序号括号 / 备注括号 / 越界周次 / 孤立单双标记 / 单双同写。
带课名的提醒课名截到 20 字、最多点名 3 门；括号备注原文、认不出的周次原文、认不出的格子原文同样截到 20 字；
每条都经 `warn()` 再截到 200 字以内。fixture `long-warnings` 钉住这一点。

## 5. 与模板（bjtu）的差异

借的是解析骨架（`weeksOf` / `runsOf` / `warn` 限长出口 / H3 节次补全 / 缺教师缺地点汇总 / 连堂合并去重）。
取数层、字段、学期来源、节次时间来源全部按本校上游重写：

1. **三条请求**（§1）：当前学期页 → 第 1 周页 → 课表页；bjtu 只有一条。当前页是整学期课表页且地址里 `id`+`yearid`+`termid` 齐全时，
   第 1 条不请求、第 3 条直接用当前页地址；逐周页带学年学期但没有 `id`，仍要问当前学期页。
2. **GBK**：按 `arrayBuffer` 取回再用 `TextDecoder('gbk')` 解码（bjtu 是 UTF-8 页面，直接 `response.text()`）。
3. **学期**：教务给的是 `year`（年份 − 1980）+ `term`（1 春 / 2 夏 / 3 秋）数字码，`parse.js` 的 `effectiveTerm` 换算成
   「2025-2026学年第1学期」；读不到看 `termText`（「2025秋」），再读不到按今天的日期推算。bjtu 读的是 `YYYY-YYYY-N` 文本。
4. **开学日**：第 1 周页 `td[name="td0"]` 是真数据，回退到那一周的周一；只有拿不到时才按「第一学期 9 月 1 日 /
   第二学期次年 3 月 2 日所在周的周一」推算（`estimateStart`）。夏学期（term = 2）按 7 月 6 日推算，这条是猜的，提醒里写明。
5. **总周数**：用 `whichWeek` 选项的最大周（学校给的周次表），不是「课表里出现的最大周」；读不到用 20，
   课表更晚才抬高，最多 30。
6. **节次时间**：页面 `th` 有就用页面；没有就整表用学校公布的 12 节（`BUILTIN_PERIOD_TIMES`，逐节见 §0）并提醒；
   表外节次先试这张表、接不上再按课间 5 分钟 / 每节 45 分钟顺推（H3）。
7. **课程格子**：上游按行位置取（第 2 行地点、第 3 行教师、第 4 行周次、第 5 行「讲课」），多一行少一行就把教师当周次；
   这里以含 `<<课名>>` 的行为界分课，其余行按内容认：带「周」又有数字的是周次行，`讲课 / 实验 / 上机…` 是类型行，
   剩下的按先后当地点、教师。一格叠多门时每门各成一条。
8. **隐藏元素过滤 + 学号不出输出**（bjtu 也有隐藏过滤，但本校多一项：`studentid` 既要用来拼请求又不能交出去）。
9. 没有 bjtu 的 `?xnxq=` 学期链接、`.widget-header button`、地点逗号分段；也没有 `saveImportedCourses` 之类的拾光桥。

## 6. 上游里删掉 / 改掉的东西及理由

| 上游 | 处理 | 理由 |
|---|---|---|
| `showPrompt` / `showAlert` / `showSingleSelection` / `showToast` / `shiguangBridge*` 桥 | 去掉 | 拾光的桥能力；空课由宿主保存，适配器只交数据 |
| `setCurrentYearAndTerm`（`currcourse.jsdo?year=&term=`） | 去掉 | 这条会改服务器上的当前学期，属于写操作；只读原则下不请求 |
| `getAcademicYear` / `selectTerms` / `setYearAndTerm` / `validateYearInput` / `validateDateFormat` 弹窗 | 去掉 | 公共说明第 2 条：不弹窗问学年学期；学期用页面 / 教务给的当前学期 |
| `setStartDate` 弹窗让用户确认开学日 | 去掉 | 有教务给的日期就用，没有就推算，两种情况都写进提醒 |
| `getMaxWeekValue`（GET 一次）+ `getFirstCourseDate`（POST 一次） | 合并成一次 POST `whichWeek=1`，同时读 `select` 与 `td0` | 同一个页面就有这两样，少一次请求 |
| `defaultTimeSlots` 写死表 | 挪到 `parse.js` 的 `BUILTIN_PERIOD_TIMES`，只在页面读不到时用，并提醒 | 判断与拼装必须在 `parse.js`（CI 只跑它） |
| `parseWeeks`（只认「11周」「1-13周」「1-10周,11-18周」） | 换成 `weeksOf`（单双标记、共 N 周、全角、第…周、节次文字） | 上游遇到 `(单)/(双)` 会静默退化成每周都上 |
| `parseSingleCourse` / `parseMultipleCourses` / `processCourseBlock` / `convertToTargetFormat`（切 `innerHTML` 字符串） | 改成「DOM 按行交文字 + `parse.js` 按内容认课」 | 上游缺教师就整块丢课；按位置取字段一错就串行 |
| `mergeContinuousCourses`（`endSection + 1 === startSection`、按 JSON 分组） | 用模板的合并（`next.start <= current.end + 1`，同名同教师同地点同星期同周次） | 同一节的重复行会被另起一段、课表重叠（批次十九经验） |
| `getSemesterInfo` 返回的 `studentid` | 只在 `extract.js` 内部拼请求 URL，不进输出 | 学号属于个人信息，不带出 |
| `console.log` / `console.error` / `console.warn` | 全部不移植 | 不在用户控制台留痕，也不做埋点 |
| 上游整个 `runImportFlow`（解析 + 保存 + 提示一把梭） | 拆成 `extract.js`（只取数）+ `parse.js`（纯转换） | 空课适配器规范；CI 只能跑 `parse.js` |
| `const` / 箭头函数 / `async` / `Array.from` / 展开运算符 / 模板串 / `for...of` | 全部改成 ES5 + `Promise` 链 | 旧 WebView 与 Rhino |

新增（上游没有）的：登录 / 主机判断、返回登录页判断、隐藏元素过滤、缺教师 / 缺地点汇总、跳过格子的分类计数、
提醒限长（课名与各种原文 20 字、整条 200 字）、H3 表外节次补齐、多段周次取并集、按内容认课程字段。

## 7. 验证记录（2026-11-10）

- 自检：`node .test/port-batch5/tools/check.js jw-adapters/imut` → 8 对 MATCH，`RESULT: PASS`。
- 浏览器冒烟：`python -I -X utf8 .test/port-batch35/imut/smoke.py all` → 10/10 OK（Playwright 起假教务站，页面按 GBK 字节返回，
  全部请求被拦下，不联网；本机没装自带 Chromium 时退回系统 Edge）。场景：
  - `normal`：当前页就是课表页且地址带 `id/yearid/termid` → 只发 2 条请求（第 1 周页 + 课表页），学期取地址里的参数，
    开学日取 `td0`（2026-09-07，与推算值 2026-08-31 不同，证明用的是页面给的日期），6 门课 7 段安排（连堂合并、单双周各一段、
    一格两门课、缺教师 / 地点占位词交 null），12 节里读到 4 节；
  - `term-page`：当前页是当前学期页 → 3 条请求，学期从 `<eduaffair:CTRT>` 读；
  - `timetable-no-params`：课表页地址没有参数 → 回落当前学期页，断言课表请求带上 `yearid=46`、`termid=3`；
  - `weekly-page`：当前页是逐周页 `studentWeeklyTimetable.do?yearid=46&termid=3`（有学年学期、没有 `id`）→ 3 条请求，
    断言拼出的课表地址带 `id=2026000001&yearid=46&termid=3`（回归 reviewer B2）；
  - `week-fail`：第 1 周页 500 → 2 条请求，课表照常导入，开学日按 9 月 1 日推算、总周数按 20 周，两条提醒都在；
  - `login` / `login-secret` / `other-host`：零请求直接报错（登录页地址、有密码框的页面、别的主机）；
  - `no-table` / `empty`：课表页结构不对 → 「没有找到课表」；表格里没有课 → `parse.js` 报「没有解析到任何课程」。
  每个成功场景都断言：请求次数与主机、行字段正好是 `{day, section, lines}` 三个、节次时间字段正好是 `{number, start, end}` 三个、
  输出里没有学号 / 姓名 / 身份证 / 手机号、学期名 / 开学日 / 课程门数 / 安排条数、提醒每条 ≤200 字。
- 变异测试（在临时目录的副本上改，原件不动，跑完复跑 PASS）：

| # | 改坏哪一处 | 变红的用例 |
|---|---|---|
| 1 | `extract.js`：不再跳过 `display:none` 的元素（`hiddenElement` 的样式判断改掉） | 冒烟 `normal`：隐藏格子里的学号 2026000001、姓名、手机号被带出 |
| 2 | `parse.js`：删掉「没有逗号的连写标记归下一段」那段（`weeksOf` 里 `digit + ',' + mark`） | `weeks-forms`（周次M「单1-8周(双)9-16周」退化成每周都上） |
| 3 | `parse.js`：删掉「节次文字整段摘除」那一行 | `weeks-forms`（周次G「第17-18节,1-16周」把 17-18 当周次） |
| 4 | `parse.js`：H3 顺推的课间分钟 5 → 10 | `late-periods`（第 13 节变成 21:30-22:15） |
| 5 | `parse.js`：总周数不再用教务的周次列表（`weeksFromPage` 恒为 false） | `basic`、`weeks-forms`、`messy`、`late-periods`、`long-warnings` |
| 6 | `parse.js`：教师不再去掉行尾逗号（复审 B3 后补的变异） | `messy`（「贾老师,」被当成另一个教师，课程拆成两门） |

六处都变红，改回后 `check.js` 与冒烟全部 PASS。

### 7.1 复审修正（reviewer 四条，2026-11-10）

| # | 问题 | 改法 | 钉住的用例 |
|---|---|---|---|
| B1 | 周次列表**没读到**时，提醒还说「教务系统的周次列表只到第 20 周」 | 抬高总周数的提醒按来源分两支：真读到列表才说「列表只到第 N 周」；没读到就说「没有读到教务系统的学期周次列表：先按 20 周导入，课表里有第 M 周的课，已把总周数抬到 M 周」。另两支（读到 / 没读到但不抬高）原本就如实说 | `first-day`（weekCount 0 + 第 22 周 → 新文案） |
| B2 | 当前页是逐周页 `studentWeeklyTimetable.do?yearid=…&termid=…` 时以为参数齐全，跳过当前学期页，导致 `params.id` 为空、课表地址少 `id=` | 跳过当前学期页的条件收紧成「当前页就是 `showTimetable.do` 且地址里 `id`+`yearid`+`termid` 都齐全」；逐周页照样请求 `currcourse.jsdo` 拿 `id` | 冒烟 `weekly-page`（断言课表请求带 `id=2026000001`） |
| B3 | 教师行尾的逗号（上游用 `replace(/,$/, '')` 去掉）没处理，同一门课会因「贾老师,」与「贾老师」拆成两个教师 / 两条记录 | `courseOfGroup` 里教师去掉行尾的半角 / 全角逗号 | `messy`（同一门课一格「贾老师,」一格「贾老师」→ 一个教师、一段 1-2 节） |
| B4 | 「节次整段摘除」排在归一之前，`第3至4节` / `第３-４节` 摘不干净 | 先把破折号与「至 / 到」归一成 `-`、再全角转半角，最后按「数字[-数字]节」整段摘除，摘完再解析周次 | `weeks-forms`（`第3至4节,5-8周` 与 `第３-４节,５-８周` 都只得到 5-8 周） |

改完 `check.js` 8 对全部 MATCH、冒烟 10/10 OK。

## 8. fixtures（8 对，全部合成）

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 年号 45 + 秋 → 2025-2026学年第1学期；开学日取第 1 周页的 2025-09-01；连堂合并（1-2 节）；单周行 / 双周行各成一段；完全重复的行只留一条；`1-10周,11-18周` 连成 1-18；缺教师（4 行写法）、缺地点（占位词「待定」）照常导入并汇总 |
| `weeks-forms` | 15 种周次写法：第1-第8周 / 1-8周(单) / 全角 １-８周（双） / (单)1-8周,(双)9-16周 / 没有逗号的 (单)1-8周(双)9-16周 / 纯标记连写 单1-8周(双)9-16周 / 1-4周(共8周) / 第17-18节,1-16周（节次摘除） / 第3至4节,5-8周 与全角 第３-４节,５-８周（归一后整段摘除） / 1-16周(3学分) / 全角逗号 1，3，5周 / 第1周至第8周 / 教学班序号 (1) / 单双同写按每周都上 |
| `messy` | 没有课名的格子计数点名、重复格子只算一次、缺周次的格子跳过、第 0 周被丢弃并点名原文、空课名 / 星期 8 / 节次 21 各自跳过、「未知」「暂无」当没给、教师行尾逗号（「贾老师,」与「贾老师」合成一个教师、连堂合并成 1-2 节） |
| `fallback-times` | 页面没给节次时间 → 整表用学校公布的 12 节并提醒；春（term 1）→ 第二学期，开学日按 3 月 2 日推算为 2026-03-02；周次列表没读到 → 20 周 |
| `late-periods` | 页面只给 8 节，课表用到第 9 与第 13 节 → 9-12 用学校公布的表、13 顺推 21:25-22:10 |
| `first-day` | 学年学期只有「2026秋」；第 1 周页只给月日（08-25，周二）→ 开学日回退到 2026-08-24；课表排到第 22 周 → 总周数抬到 22，提醒如实说「没读到周次列表」 |
| `no-term` | 年号 / 学期号 / 标题都没有 → 按今天推算为 2026-2027学年第1学期、开学日 2026-08-31、20 周 |
| `long-warnings` | 长课名 / 认不出的格子原文 / 认不出的周次原文都截到 20 字，缺教师 4 门、缺地点 2 门；每条提醒 ≤200 字且末尾提示不被切掉 |

期望值的推演方式：每节时间逐节对照上游写死表手写；开学日按「该日期所在周的周一」手算（2025-09-01 是周一 → 当天；
2026-08-25 是周二 → 2026-08-24；2026-03-02 是周一 → 当天）；周次集合先手写（如 `(单)1-8周` → 1,3,5,7），
再按手册 §4.1 手切极大段（ODD 1-7）；总周数、节次补齐（21:25-22:10）、跳过计数、提醒文本逐句手写。
**期望值不是把 `parse.js` 输出存下来的**：先写 expected 再跑自检，`weeks-forms` 第一次 DIFF 时确认是代码错
（周次行判断只认半角数字，把「１-８周（双）」当地点了），改代码后 MATCH。

## 9. 已知风险与未验证项（我们没有本校账号，真机没验过）

1. **页面结构全部来自上游脚本**：`table#timetable`、`th` 里的「第N节」、课程格的 `<<课名>>`、`eduaffair:CTRT`、
   `td[name="td0"]`、`select[name="whichWeek"]` 都没有在真机核对。学校改版会落到「没有找到课表」或跳过计数，不会静默导入错误周次。
2. **GBK 解码依赖 WebView 的 `TextDecoder('gbk')`**：Chrome / Android WebView 支持；万一不支持会先试 `gb18030`，
   再失败就报错，不会把乱码当课名导入。
3. **缺地点与缺教师的区别**：一门课在格子里只剩一行字段时按上游顺序当「地点」（上游也是先地点后教师）。学校若把地点留空、
   只写教师，这一行会被当成地点，教师为空——与上游行为一致，提醒里会如实说「没给上课教师」。
4. **第 1 周页的日期格式没有真机样本**：`td0` 接受完整日期（`2025-09-01` / `2025/09/01` / `2025.9.1`）与只有月日（`08-25`、`8月25日`）；
   其它写法会退回推算并提醒。
5. **第 1 周页的 POST 是否要 Referer / 其它参数未验证**：浏览器不允许脚本自己设 `Referer`（上游那句会被忽略），
   真实请求带的是当前页的 Referer；若教务要求额外参数，这一条会失败 → 开学日与总周数改走推算，课表本身不受影响。
6. **总周数用 `whichWeek` 的最大选项**：假设这份周次列表就是学期教学周；若它把考试周也算进去，总周数会偏大一两周，
   提醒里让用户去「学期管理」核对。
7. **夏学期（term = 2）没有样本**：学期名拼成「YYYY-YYYY学年夏季学期」，开学日按 7 月 6 日所在周的周一推算，
   这条是猜的，提醒里写明是推算的。
8. **隐藏元素只认 `hidden` / `aria-hidden` / 内联或计算样式 / 没有渲染尺寸**：用透明度 0、移出屏幕等方式藏起来的文字浏览器仍算可见，
   会被当成内容带出（上游同样会带出；这里挡住了最容易藏学号的几种）。另外「没有渲染尺寸」这一条只对挂在窗口上的页面生效，
   对 `DOMParser` 解析出来的课表页不生效（否则整页都会被判成看不见）。
9. **学号会出现在课表请求的 `id=` 参数里**：同源请求，不上报第三方，也不进输出 / 提醒 / 存储。
10. **`allowHosts` 只有 `jw.imut.edu.cn`**：统一身份认证若在别的主机，用户在那个页面上点提取会看到「当前页面不是…」的提示（不发请求），
    需要先回到教务系统的课表页。

签名：0x7E7-2023（haiku 移植，2026-11-10）
