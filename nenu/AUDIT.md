# 安全审计 —— 东北师范大学（乘方智慧教务新版，bkjx.nenu.edu.cn）

审计对象：`jw-adapters/nenu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `NENU/NENU_01.js`（快照 commit `e15c6274ac347c9642da890504651a9b4e374391`，2026-10-26 拉取；
MIT，作者 dezige131，`adapters.yaml` 的 maintainer；本校脚本最后一次修改 `80e30cf`，
`git log -1 --format=%h -- resources/NENU/NENU_01.js` 核对一致）。

审计方式：逐行读上游脚本（188 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-26 运行）：

- 绝对 URL：`extract.js` / `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`；代码里没有任何绝对地址，
  请求路径全是以 `/` 开头的相对路径。`manifest.json` 里的 `loginUrl`、`scheduleUrlHint`、`homepage` 是给宿主看的声明，不是请求。
- 网络调用：`extract.js` 里只有两处 `fetch(`：`request()`（POST，课表与第 1 周日期）和 `fetchPage()`（GET，课表页）。
  `X-Requested-With: XMLHttpRequest` 是请求头字符串，不是 XHR 对象。`parse.js` 里没有任何网络调用、没有 `document.` / `window.` / 桥调用。
- 凭据、本地存储、动态执行、写页面：`localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` / `sendBeacon` /
  `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit` / `setAttribute` / `.click(` 全部无命中。
  `password` 只命中 `hasLoginForm()` 里的一处选择器 `input[type="password"]`：**只判断页面上有没有密码输入框**（认出登录页，不发请求），
  不读它的 `value`、不碰其它输入框。自检脚本对这个字样的提示即来源于此。
- ES5 token 扫描（注释也算，`check.js` 同口径）：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、展开符、可选链、`??`、`padStart`、
  `Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(`、`for…of` 全部无命中。
- 模板残留：检索「gxmu」「广西」「Haooz」「jwxt」「GXMU」，只有 `parse.js` / `extract.js` 注释里有意写「照 gxmu」「同平台的 gxmu / hnsf」（说明通用部分的来源）。
- 个人信息：`fixtures/` 全部为合成数据（课名与教师是「张三」「李四」「教师甲」之类占位，教室是「教学楼101」「A201」之类），没有真实姓名与学号。
  `extract.js` 里出现的「学号、姓名」只在注释里说明被丢弃的字段。

## 0. 上游情况与任务卡分析（`.test/` 下无法写分析文件，分析写在这里）

- 上游 `NENU/NENU_01.js` 与 `adapters.yaml` 一致，校名「东北师范大学」，`import_url` 是 `https://bkjx.nenu.edu.cn/`，原样用作 `loginUrl`；
  教务主机与登录入口同源，所以 `allowHosts` 为空（请求全是同源相对路径，没有别的主机）。
- 平台判断：上游用 `/new/student/xsgrkb/week.page`（课表页）与 `/new/student/xsgrkb/getCalendarWeekDatas`（整学期排课，返回 `{code:0, data:[…]}`），
  与已审计的 `gxmu` / `hnsf` / `sdipct` / `shxy` 是同一个平台（乘方「智慧教务」新版）。**不是** 任务卡里提到的 `scut` 那种正方教务（`jwglxt/kbcx/…`），
  所以没选 `scut` 当模板。`neau` 没有读 `businessHours`，也不合适。
- 选 `gxmu` 作模板的理由：同平台、取数形状最简（`week.page` 读下拉框 → `getCalendarWeekDatas` → 可选的 `getDatesOfWeek`），白名单七个字段（`kcmc` `teaxms` `jxcdmc` `zc` `xq` `ps` `pe`）
  与本校完全一致，`parse.js` 的通用部分（周次写法、两阶段合并、提醒限长、缺教师 / 教室汇总）已审计过；`hnsf` / `sdipct` 多了校区与季节的提问，离本校更远。
  通用部分又逐条对照了「审计真抓到过的错」：相邻 `(单)/(双)` 归属、`第1-第8周`、「共 N 周」只剥备注（`/共\s*[0-9]+\s*周?/g`）、课名截 20 字 + 每条 ≤200 字、
  编辑课程指引（不写「学期管理」补教师 / 教室）、「节次时间」用词，均已在 fixtures 里钉住。
- 与模板 `gxmu` 的不同构之处（逐条处理，见 §4）：
  1. 节次时间不是写死表，而是页面源码里的 `var businessHours = $.parseJSON('[…]')`（`jcdm` / `qssj` / `jssj`）；上游取不到就整个导入失败。
  2. **中午「倒挂」的第 13、14 节**：上游把 `ps` 或 `pe` > 12 的课做成自定义时间（教务的真实时间，缺则 11:45 / 13:15），第 1-12 节才是正常网格。
  3. 上游的请求体是 `xnxqdm=<学期>&zc=&d1=2020-01-01 00:00:00&d2=2030-01-01 00:00:00`（很宽的固定范围，不是 `gxmu` 的本周范围）。
  4. 学期值是下拉框 `value` 原样拼进请求体，格式没有规定，不能像 `gxmu` 那样要求 6 位数字。
  5. 上游没有开学日与总周数；上游有写死的 `defaultClassDuration: 45`、`defaultBreakDuration: 10`（只用于「拾光」的节次表，本件用作顺推补节次的参数：每节 45 分钟，课间 5 分钟取空课惯例）。

## 1. 请求域与请求清单（与代码逐条对应）

只访问用户当前打开的教务主机，地址全是相对路径，代码里没有写死协议；`window.location.hostname` 必须等于 `bkjx.nenu.edu.cn`，
否则（停在统一认证门户或别的站点）直接抛提示、**不发请求**。`allowHosts` 为空（登录入口与教务同源，不用通配）。

| # | 方法 | 路径 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `/new/student/xsgrkb/week.page` | 无 | 读学期下拉框 `#xnxqdm`，并从页面源码抠 `businessHours`（节次时间）。**上游必发**，它自己再用 `DOMParser` 解析 | 当前页面已有 `#xnxqdm` 且全局 `businessHours` 是数组时不发；非 2xx / 网络错误 / 改版 → 交 null；页面里有密码输入框（登录页）→ 抛「登录已失效」；页面和下拉框都取不到学期 → 抛「没读到当前学期」；节次时间取不到 → 交 null，parse.js 回落空课默认 12 节并提醒 |
| 2 | POST | `/new/student/xsgrkb/getCalendarWeekDatas` | `xnxqdm=<学期值>&zc=&d1=2020-01-01 00:00:00&d2=2030-01-01 00:00:00`（与上游逐字一致，d1 / d2 URL 编码） | 取整学期课表（JSON：`{code:0, data:[…]}`） | HTTP 401/403 → 「教务系统拒绝访问（代码 N）」；其它非 2xx → 「教务系统返回错误（代码 N）」；网络错误 → 「连不上教务系统」；响应不是 JSON / 没有 `data` 数组（如会话失效回登录页）→ 「没有返回课表数据」；`code` 不是 0 → 「没有返回课表数据（代码 N）」；`data` 为空 → 「没有取到课表数据」（上游弹「该学期暂无排课数据」） |
| 3 | POST | `/new/xlxx/getDatesOfWeek` | `xnxqdm=<学期值>&zc=1` | 取第 1 周的日期（开学日）。**上游没有**，同平台的 `gxmu` / `hnsf` 用它 | 任何失败（非 2xx / 不是 JSON / 超长）一律交 null，parse.js 推算开学日并写 warnings |

- 请求 2、3 并发发出；课表为空时请求 3 的结果作废。请求头统一为 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: application/json, …`，
  全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。上游的请求 2 带前两个头，多出的 `Accept` 是同平台其它脚本都带的。
- 请求 2 的失败不吞（没有课表就没有可导入的内容，直接报给学生）；请求 1、3 的失败一律吞掉交 null，附加请求挂掉不能导致整次导入失败；
  但请求 1 若连学期都读不出，才会因为没有学期可用而报错。
- 登录页（页面里有密码输入框，或路径含 `login` / `authserver` / 单独的 `cas` 一段）与别的主机**不发任何请求**，直接抛大白话提示。
  登录判断只看路径、不看查询串。
- 学期选择：页面上的下拉框选中哪一项就导入哪一项（用户切到哪个学期点「提取课表」就是哪个）；没有就取课表页默认选中项；
  上游的 `showSingleSelection` 学期弹窗不移植，也**不用**提问桥（学期是教务自己的值，凭日期猜学期代码会请求到不存在的学期）。

## 2. 读了什么、交出去什么（逐字段）

**读了什么**

- 页面 HTML（请求 1，或当前页面）：`#xnxqdm` 的 `option` 的 `value` / `selected` / `textContent`；页面全局 `businessHours`（或页面源码里 `var businessHours = …` 的数组）；登录页判断只查有无密码输入框。
- 课表 JSON（请求 2）：`code`、`data[]`。
- 第 1 周日期 JSON（请求 3）：数组（或 `{data:[…]}`）的每行 `xqmc`、`rq`。

**交出什么**（`JSON.stringify` 的结果，字段白名单挑出，不是整个响应）

| 字段 | 来源 | 说明 |
|---|---|---|
| `term.code` | 下拉框 `value`（只认 ≤20 位的字母数字与 `_` `-`） | 请求体与学期名兜底用 |
| `term.label` | 下拉框文字（≤60 字） | 学期名优先取它 |
| `term.source` | `page` / `default` | parse.js 写第一条提醒用 |
| `today` | 本地日期 `YYYY-MM-DD` | 只在学期名读不出、要按日期推算学期时用 |
| `rows[]` | 每行只留 `kcmc` `teaxms` `jxcdmc` `xq` `zc` `ps` `pe` | 课名、教师、教室、星期、周次、起止节次；其它字段（学号、姓名、证件号、手机号、教师工号…）一律不带 |
| `hours[]` | `businessHours` 每项只留 `jcdm` `qssj` `jssj`（≤60 行），取不到 `null` | 节次时间 |
| `dates[]` | 请求 3 的每行只留 `xqmc`、`rq`（≤20 行），取不到 `null` | 第 1 周的日期 |

课表响应里夹带的 `xh` / `xm` / `sfzh` / `sjh` / 教师姓名之外的字段、`businessHours` 里的 `id` 之类（冒烟桩里放了带标记的值）不在白名单里，冒烟测试确认没有出现在输出里。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。不读密码、不读 Cookie、不存任何东西；只判断页面上有没有密码输入框（`hasLoginForm`），不读它的值。上游的 `showToast` / `showSingleSelection` / `showAlert` / `saveCourseConfig` / `savePresetTimeSlots` / `saveImportedCourses` / `notifyTaskCompletion` 全部未移植（见 §5）。 |
| 2 | 不外发 | **过**。只有 `extract.js` 里的两处 `fetch`，路径全是相对路径，请求只会打到用户当前打开的教务主机（且提前确认主机名）。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，没有第三方域。 |
| 3 | 请求域可控 | **过**。`allowHosts` 为空（登录入口与教务同源）；代码里的主机名只有一处用来拦截「不在教务主机上」的常量 `HOST`。 |
| 4 | 只读课表 | **过**。三个请求落在 `/new/student/xsgrkb/*`（课表页、课表）和 `/new/xlxx/getDatesOfWeek`（第 1 周日期），不碰成绩、学籍、缴费、考试。响应里夹带的个人信息不带出。 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOrNull`，失败返回 null）、对页面源码做一次正则（`hoursFromSource`，抠出的数组再 `JSON.parse`）与 `DOMParser`（离线解析课表页，不插入当前页面）。 |
| 7 | 不写页面 | **过**。读页面只用 `getElementById` / `getElementsByTagName` / `querySelector`，不改 DOM、不提交表单、不点击。 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有教务主机名、三个路径、中午课兜底时间 11:45-13:15、空课默认节次表。 |

## 4. 与模板（gxmu）的差异

1. **节次时间**：模板是写死的 12 节表；本件取教务页面里的 `businessHours`（`periodTablesOf`）：第 1-12 节只认从第 1 节起连续、时间递增不重叠的一段；第 13 节起各按教务给的时间写；
   同一节号两个不同时间 → 不猜，整张回落空课默认 12 节并说明；整张取不到 → 回落空课默认 12 节并提醒（上游会直接失败，不能照搬）。
2. **中午第 13、14 节**（上游的「倒挂」自定义时间）：节次表里按节次号写进 13、14 节的真实时间（应用按节次号取时间、不要求递增，时间轴按实际时间画）；
   教务没给时间用上游写死的 11:45-13:15（上游：开始缺用 11:45、结束缺用 13:15，所以 13、14 节各按整段 11:45-13:15）并提醒。
   第 1-12 节没排满时为给中午节次排位置，静默补齐到第 12 节（只有补齐的节次真被课表用到才提醒）；补不齐（顺推会越过 23:59）则中午节次没有时间，如实提醒、课程照常导入。
3. **12 / 13 节边界**：阶段 1 合并不跨第 12、13 节（否则合并出一个「第 12-13 节」块，时间上倒着）；一行同时排第 12 与第 13 节的拆成两段并提醒（节次一个不丢）。
4. **请求体**：`getCalendarWeekDatas` 的 `d1 / d2` 照上游固定 2020-01-01 / 2030-01-01，不是模板的本周范围。
5. **学期**：学期值不要求 6 位数字（上游原样拼）；学期名与序号先看下拉框文字（含「第一学期 / 第二学期 / 春 / 秋 / 夏 / 短学期」）、再看 6 位值、都读不出才按提取当天的日期推算并提醒（`termGuessed`），学期名用「东北师范大学 学年学期」。
   模板的「课表为空时用 `__ncSelect` 问学期」去掉：学期代码是教务的值，让学生回教务页面切换更稳。
6. **课表为空 / 学期读不出**：直接报大白话错误，不再按日期猜学期代码去请求。
7. **顺推参数**：每节 45 分钟（上游 `defaultClassDuration`），课间 5 分钟（空课惯例；上游的 `defaultBreakDuration: 10` 只用于「拾光」自己的节次表，不用于顺推）。
   补节次先用空课默认表里不早于上一节下课的那一节（`scut` 的做法），接不上才顺推。
8. 登录页判断多认 `authserver` 路径；主机固定为 `bkjx.nenu.edu.cn`。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 处理 | 理由 |
|---|---|---|
| `showSingleSelection` 选学期 | 改读页面下拉框当前选中项 | 不弹窗问学期；用户在教务页面切学期即可 |
| 取不到学期列表 / 作息时间就 `throw` | 学期取不到才报错；作息取不到回落默认并提醒 | 附加信息缺失不该让整次导入失败 |
| 取不到课表 `throw new Error("获取课表失败")` | 区分「没登录 / 教务返回错误（代码 N）/ 没返回课表数据」 | 学生看得懂 |
| `data.length === 0` → alert「该学期暂无排课数据」 | 抛大白话错误并指引切换学期 | 无弹窗 |
| `teaxms \|\| "未知"`、`jxcdmc \|\| "待定"` | 置 null，按类型汇总提醒 | 「未知」「待定」会被当成真名显示（手册 §4.7） |
| `parseWeeks`（`zc` 只按逗号切、`parseInt`） | 换成通用周次解析（兼容原有逗号数字列表） | 上游接受的写法全部接住，另认「1-16周」「(单)」等 |
| `Set` 去重（`day-start-end-name-weeks` 为键） | 先去完全相同的行，再两阶段合并（连续节次、同节次周次并集） | 不丢课、不改任何一周的安排 |
| 第 13、14 节自定义时间（`isCustomTime`） | 写进节次表的 13、14 节 | 应用的课表按节次放；时间不连续的两段不合并 |
| `config {defaultClassDuration: 45, defaultBreakDuration: 10}` 与 `savePresetTimeSlots` / `saveCourseConfig` / `saveImportedCourses` / `showToast` / `notifyTaskCompletion` | 不移植 | 「拾光」桥能力，空课由宿主保存 |
| 浏览器测试分支（`prompt` / `alert` / `console.log`） | 不移植 | 非导入逻辑 |
| `window.shiguangBridge*` 全部调用 | 不移植 | 同上 |
| 无（新增） | `getDatesOfWeek` 请求 | 上游没有开学日，空课的课表必须有；取不到则推算并提醒 |

## 6. 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/nenu-port17/mut/` 下的副本上改坏 `parse.js`（改完删掉），跑 `check.js`：

| # | 改坏的地方 | 变红的用例 |
|---|---|---|
| M1 | 阶段 1 合并不再拦第 12 / 13 节边界 | `noon-split`、`long-warnings` |
| M2 | 跨第 12 / 13 节的行不再拆开 | `noon-split`、`long-warnings` |
| M3 | 中午课兜底结束时间 13:15 改成 13:00 | `noon-split`、`no-hours`、`hours-partial` |
| M4 | 「共 N 周」备注照上游惯用写法改成吞到行尾 | `week-markers` |
| M5 | 同一节两个时间不再判冲突 | `hours-conflict` |
| M6 | 第 1-12 节不再要求时间递增 | `hours-overlap`（该用例是 M6 暴露没有覆盖后补的） |
| M7 | 中午节次不读教务给的时间 | `basic`、`long-warnings` |

每次改坏后都有 DIFF，还原后（`check.js` 在 `jw-adapters/nenu` 上）为 `RESULT: PASS`。

## 7. fixtures、自检与冒烟

期望值都是先按规范与代码逻辑手工推出（节次时间、节次、周次切段、开学日、总周数、学期名、warnings 文本），再跑自检比对；没有把 parse.js 的输出直接存成期望。共 11 对：

- `basic`：14 节节次时间含中午第 13、14 节；连续节次合并；单周行 + 双周行并成每周；奇数周；分段周次；中午第 13-14 节的课；完全重复行；缺教师缺教室；开学日取教务。
- `noon-split`：第 11-12 节与第 13 节不合并；一行第 12-13 节拆成两段并提醒；教务没给第 13 节时间 → 11:45-13:15；教务默认学期；开学日推算。
- `no-hours`：节次时间取不到 → 空课默认 12 节；中午第 14 节兜底；开学日不属于第二学期被忽略；「1-16周」写法。
- `hours-partial`：节次时间只给到第 8 节（一行读不懂、一行隔着缺口）；第 9-10 节用空课默认；第 11、12 节静默补齐；中午兜底。
- `seq-fill`：顺推补第 5、6 节；第 7 节起越过 23:59 补不了。
- `noon-blocked`：前面节次补不齐、中午节次没有时间的提醒。
- `hours-conflict`：同一节两个时间。
- `hours-overlap`：教务节次时间重叠 → 只认前面递增的一段。
- `week-markers`：段首单双标记、「第1-第8周」、「共 N 周」只剥备注、后缀单双、括号备注与教学班序号、超界周次、缺课名 / 星期不对 / 节次不对 / 周次认不出。
- `long-warnings`：长课名（30 字）的缺教师教室、没给结束节次、跨 12/13 节三类提醒，课名截 20 字、整条 ≤200 字。
- `estimate-guessed`：学期名与学期值都读不出 → 按提取当天推算并提醒，学期名用「学校名 + 学年学期」。

浏览器冒烟（`.test/port-batch17/nenu/smoke.py`，Chromium + 假教务站，不联网，跑真实 `extract.js` 再交给 Rhino 跑 `parse.js`）14 个场景全部通过：
页面已有下拉与全局节次时间（只发请求 2、3，不发请求 1）、选中第二学期（请求体学期跟着变）、非课表页（先 GET 课表页再取课表）、课表页里没有节次时间（回落并提醒）、
下拉在但全局没有节次时间（GET 课表页补）、第 1 周日期 404（推算并提醒）、登录页 / 门户首页 / 统一认证路径（报错、不发请求）、课表为空、HTTP 500、200 + 登录页 HTML、
页面与课表页都读不出学期。请求体含 `zc=&d1=2020-01-01%2000%3A00%3A00&d2=2030-01-01%2000%3A00%3A00`，所有请求都在 `bkjx.nenu.edu.cn` 上，桩里放的学号 / 姓名 / 证件号 / 手机号 / 教师标记值没有出现在输出里。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

- 真机没验过：学期下拉框 `#xnxqdm` 的 `value` / 文字格式、`businessHours` 的字段与 `jcdm` 是否带前导零、第 13 / 14 节在教务里的真实时间（上游注释写「中午异形 11:45-13:15」，本件按教务给的优先）都来自上游代码，不是实测。
- `getDatesOfWeek` 在本校是否存在不知道（上游没用它，是同平台其它学校的脚本在用）：不存在时 404 被吞，开学日按 9 月 1 日 / 2 月 20 日所在周的周一推算并提醒学生核对。
- 课表里第 13、14 节与第 12 节之后的时间轴：应用按节次号取节次时间，第 13、14 节写在节次表末尾但时间在中午，「节次模式」下会排在第 12 节之后，时间轴按实际时间画。若应用某处假定节次时间递增，中午课的显示会受影响（未在真机验证）。
- 主机固定为 `bkjx.nenu.edu.cn`：如果学生通过别的域名 / 代理访问教务（`/new/` 路径相同），会被提示「当前打开的不是教务系统页面」；这是为避免在别的站点上发请求。
- 学期总周数教务不给，按 20 周（不早于课表最晚周次）导入并提醒。
- `d1 / d2` 的固定范围照上游，服务端是否对这个范围有限制没有验证。
- 上游 `zc` 只按逗号分隔数字读；本件周次解析更宽松（多认「1-16周」「单双」等），对上游已有的写法结果一致。

## 9. 签名

0x7E7-2023（sonnet 移植，2026-10-26）
