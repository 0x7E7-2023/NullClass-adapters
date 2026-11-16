# 安全审计 —— 洛阳理工学院（乘方智慧教务，lljw.lit.edu.cn）

审计对象：`jw-adapters/lit/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `LIT/lit_01.js`（快照 commit `1dc9ac6`，2026-11-16 拉取；MIT，作者 小漫君，
`adapters.yaml` 的 maintainer；本校脚本最后一次修改 `9751f72`（2026-09-07），
`git -C .../sgw-latest log -1 --format=%h -- resources/LIT/lit_01.js` 核对一致）。

审计方式：逐行读上游脚本（249 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-11-16 运行）：

- 绝对 URL：`extract.js` / `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`；代码里没有任何绝对地址，
  请求路径全是以 `/` 开头的相对路径。`manifest.json` 里的 `loginUrl`、`scheduleUrlHint`、`homepage` 是给宿主看的声明，不是请求。
- 网络调用：`extract.js` 里只有两处 `fetch(`：`request()`（POST 取整学期课表）和 `fetchPage()`（GET 课表页）。
  `X-Requested-With: XMLHttpRequest` 是请求头字符串，不是 XHR 对象。`parse.js` 里没有任何网络调用、没有 `document.` / `window.` / 桥调用。
- 凭据、本地存储、动态执行、写页面：`localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` / `sendBeacon` /
  `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit` / `setAttribute` / `.click(` 全部无命中。
  `password` 只命中 `hasLoginForm()` 里的一处选择器 `input[type="password"]`：**只判断页面上有没有密码输入框**（认出登录页，不发请求），
  不读它的 `value`、不碰其它输入框。自检脚本对这个字样的提示即来源于此。
- ES5 token 扫描（注释也算，`check.js` 同口径）：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、展开符、可选链、`??`、`padStart`、
  `Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(`、`for…of` 全部无命中。
- 模板残留：检索「nenu」「东北师范大学」「bkjx」，代码、manifest、fixtures、给学生看的文字里均无命中；
  `parse.js` / `extract.js` 注释里有意写「照 nenu」「同平台的 sdipct」说明通用部分的来源。
- 个人信息：`fixtures/` 全部为合成数据（课名与教师是「张三」「李四」「教师甲」之类占位，教室是「教学楼101」「A101」之类），
  没有真实姓名与学号。`extract.js` 里出现的「学号、姓名」只在注释里说明被丢弃的字段。

## 0. 上游情况与任务卡分析（`.test/` 下无法写分析文件，分析写在这里）

- 上游 `LIT/lit_01.js` 与 `adapters.yaml` 一致，校名「洛阳理工学院」，`import_url` 是 `https://lljw.lit.edu.cn/`，原样用作 `loginUrl`；
  教务主机与登录入口同源，请求全是同源相对路径，所以 `allowHosts` 为空。
- 平台判断：上游用 `/new/student/xsgrkb/week.page`（课表页，服务端渲染学期下拉 `#xnxqdm` 与 `businessHours`）
  和 `/new/student/xsgrkb/getCalendarWeekDatas`（整学期排课，返回 `{code:0, data:[…]}`），
  与已审计的 `nenu` / `gxmu` / `sdipct` / `hnsf` 是同一个平台（乘方「智慧教务」新版）。
- 选 `nenu` 作模板的理由：同平台、同源、`allowHosts` 为空、同样从 `week.page` 源码读 `businessHours` 当节次时间，
  学期下拉框、`getCalendarWeekDatas` 的取数与解析形状一致；`parse.js` 的通用部分（周次写法、两阶段合并、提醒限长、
  节次补齐、缺教师 / 教室汇总）已审计过。`sdipct` 走 WebVPN 前缀、节次时间是写死表，离本校更远；
  但本校的「按周换教室（jxcdmc2）」和「排课行自带上课时间」在 `sdipct` 里已审计过，这两段照它移植。
- 与模板 `nenu` 的不同构之处（逐条处理，见 §4）：
  1. 课表行多三个字段：`jxcdmc2`（按周次分的教室）、`qssj` / `jssj`（这门课自带的上课起止时间）、`pkr`（教师备用字段）。
  2. 上游没有中午「倒挂」的第 13、14 节概念；`businessHours` 给几节就照抄几节，不假设 12 节网格、不拆中午课。
  3. 请求体是 `xnxqdm=<学期>&zc=&d1=<学年起始年>-08-01 00:00:00&d2=<下一年>-08-31 23:59:59`（学年范围，不是 nenu 的固定宽范围）。
  4. 上游没有第 1 周日期来源（不请求 `getDatesOfWeek`）：本件不追加这个请求，开学日按学期锚点推算并提醒。
  5. 上游的「自定义时间」（`isCustomTime`）：空课载荷没有逐课自定义时间，只用来核对节次时间，对不上的课点名提醒、仍按节次导入。

## 1. 请求域与请求清单（与代码逐条对应）

只访问用户当前打开的教务主机，地址全是相对路径，代码里没有写死协议；`window.location.hostname` 必须等于 `lljw.lit.edu.cn`，
否则（停在别的站点）直接抛提示、**不发请求**。`allowHosts` 为空（登录入口与教务同源，不用通配）。

| # | 方法 | 路径 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `/new/student/xsgrkb/week.page` | 无 | 读学期下拉框 `#xnxqdm`，并从页面源码抠 `businessHours`（节次时间）。**上游必发** | 当前页面已有 `#xnxqdm` 且全局 `businessHours` 是数组时不发；非 2xx / 网络错误 / 改版 → 交 null；页面里有密码输入框（登录页）→ 抛「登录已失效」；页面和下拉框都取不到学期 → 抛「没读到当前学期」；节次时间取不到 → 交 null，parse.js 回落空课默认 12 节并提醒 |
| 2 | POST | `/new/student/xsgrkb/getCalendarWeekDatas` | `xnxqdm=<学期值>&zc=&d1=<学年起始年>-08-01 00:00:00&d2=<下一年>-08-31 23:59:59`（与上游逐字一致，d1 / d2 URL 编码） | 取整学期课表（JSON：`{code:0, data:[…]}`） | HTTP 401/403 → 「教务系统拒绝访问（代码 N）」；其它非 2xx → 「教务系统返回错误（代码 N）」；网络错误 → 「连不上教务系统」；响应不是 JSON / 没有 `data` 数组（如会话失效回登录页）→ 「没有返回课表数据」；`code` 不是 0 → 「没有返回课表数据（代码 N）」；`data` 为空 → 「没有取到课表数据」（上游弹「该学期没有获取到课程数据」） |

- 请求 2 的学年起始年取学期代码前 4 位，代码不是 4 位数字时取学期文字里的年份，再不行取当前年份（上游直接 `parseInt(xnxqdm.slice(0,4))`，代码不规范时会拼出 `NaN`）。
- 请求头统一为 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: application/json, …`，
  全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。上游的请求 2 带前两个头，多出的 `Accept` 是同平台其它脚本都带的。
- 登录页（页面里有密码输入框，或路径含 `login` / `authserver` / 单独的 `cas` 一段）与别的主机**不发任何请求**，直接抛大白话提示。
  登录判断只看路径、不看查询串（统一认证页的 `service=` 参数里会带着教务自己的地址）。
- 学期选择：页面上的下拉框选中哪一项就导入哪一项（用户切到哪个学期点「提取课表」就是哪个）；没有就取课表页默认选中项（没有选中标记取第一项）；
  上游的 `showSingleSelection` 学期弹窗不移植，也**不用**提问桥（学期是教务自己的值，凭日期猜学期代码会请求到不存在的学期）。
- 上游额外的开场确认 `promptUserToStart`（「请先确保已登录」）不移植：登录页判断已经覆盖这件事。

## 2. 读了什么、交出去什么（逐字段）

**读了什么**

- 页面 HTML（请求 1，或当前页面）：`#xnxqdm` 的 `option` 的 `value` / `selected` / `textContent`；页面全局 `businessHours`（或页面源码里 `var businessHours = …` 的数组）；登录页判断只查有无密码输入框。
- 课表 JSON（请求 2）：`code`、`data[]`。

**交出什么**（`JSON.stringify` 的结果，字段白名单挑出，不是整个响应）

| 字段 | 来源 | 说明 |
|---|---|---|
| `term.code` | 下拉框 `value`（只认 ≤20 位的字母数字与 `_` `-`） | 请求体与学期名兜底用 |
| `term.label` | 下拉框文字（≤60 字） | 学期名优先取它 |
| `term.source` | `page` / `default` | parse.js 写第一条提醒用 |
| `today` | 本地日期 `YYYY-MM-DD` | 只在学期名读不出、要按日期推算学期时用 |
| `rows[]` | 每行只留 `kcmc` `teaxms` `pkr` `jxcdmc` `jxcdmc2` `bapjxcd` `xq` `ps` `pe` `zc` `qssj` `jssj` | 课名、教师、教室、按周教室、不用场地标记、星期、节次、周次、上课起止时间；其它字段（学号、姓名、证件号、手机号、教师工号…）一律不带 |
| `hours[]` | `businessHours` 每项只留 `jcdm` `qssj` `jssj`（≤60 行），取不到 `null` | 节次时间 |

课表响应里夹带的 `xh` / `xm` / `sfzh` / `sjh` 等、`businessHours` 里的 `id` 之类（冒烟桩里放了带标记的值）不在白名单里，
冒烟测试确认没有出现在输出里。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。不读密码、不读 Cookie、不存任何东西；只判断页面上有没有密码输入框（`hasLoginForm`），不读它的值。上游的 `showAlert` / `showSingleSelection` / `showToast` / `savePresetTimeSlots` / `saveImportedCourses` / `notifyTaskCompletion` 全部未移植（见 §5）。 |
| 2 | 不外发 | **过**。只有 `extract.js` 里的两处 `fetch`，路径全是相对路径，请求只会打到用户当前打开的教务主机（且提前确认主机名）。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，没有第三方域。 |
| 3 | 请求域可控 | **过**。`allowHosts` 为空（登录入口与教务同源）；代码里的主机名只有一处用来拦截「不在教务主机上」的常量 `HOST`。 |
| 4 | 只读课表 | **过**。两个请求落在 `/new/student/xsgrkb/*`（课表页、课表），不碰成绩、学籍、缴费、考试。响应里夹带的个人信息不带出。 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOrNull`，失败返回 null）、对页面源码做一次正则（`hoursFromSource`，抠出的数组再 `JSON.parse`）与 `DOMParser`（离线解析课表页，不插入当前页面）。 |
| 7 | 不写页面 | **过**。读页面只用 `getElementById` / `getElementsByTagName` / `querySelector`，不改 DOM、不提交表单、不点击。 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有教务主机名、两个路径、空课默认节次表与顺推参数。 |

## 4. 与模板（nenu）的差异

1. **按周次换教室**（照 `sdipct`）：`jxcdmc2` 形如「教室-周次,教室-周次」，一间教室归并成一段；
   省略教室名时沿用上一间（上游 `lastRoom`）；`zc` 里有而 `jxcdmc2` 里没有的周次用主教室 `jxcdmc` 补上并提醒；
   看不懂的项计数提醒。上游对漏掉的周次是静默丢的。
2. **排课行自带的上课时间**（照 `sdipct`）：`qssj` / `jssj` 与所用节次时间的开始 / 结束比对，对不上的课点名（最多 3 个，课名截 20 字）并说明仍按节次导入。
   空课载荷没有逐课自定义时间，不能像上游那样存下来。
3. **节次时间不做「12 节网格 + 中午倒挂」拆分**：`businessHours` 给几节写几节（有效时间、同节不冲突、`jcdm` 1..20）；
   模板那条第 12 / 13 节不合并、跨 12/13 拆分、中午 11:45-13:15 兜底的逻辑是 nenu 特有的，本校没有依据，全部去掉。
4. **节次补齐**：课表用到、节次时间没覆盖的节次，先看空课默认表里有没有这一节（开始不早于前一节下课），否则从前面最近一节的结束时间顺推（课间 5 分钟、每节 45 分钟）；补了哪些、补不了哪些都进提醒。
5. **教师与地点**：教师取 `teaxms`（去掉方括号备注），空则取 `pkr`（上游 `teaxms || pkr` 后清洗）；地点取 `jxcdmc`，
   空且 `bapjxcd` 为 `"1"` 时写「不用场地」（上游同），否则留空并计入缺教室。上游的「未知」「待定」不移植。
6. **请求体**：`d1 / d2` 按学期代码的学年起始年动态计算（上游 `xnxqdm.slice(0,4)`）；模板的固定 2020/2030 范围不适用。
7. **学期**：学期值不要求 6 位数字（上游原样拼）；学期名与序号先看下拉框文字（含「第一学期 / 第二学期 / 春 / 秋 / 夏 / 短学期」）、
   再看 6 位值、都读不出才按提取当天的日期推算并提醒（`termGuessed`），学期名用「洛阳理工学院 学年学期」。
   模板的「课表为空时用 `__ncSelect` 问学期」去掉。
8. **开学日**：本件不请求 `getDatesOfWeek`（上游没有、任务卡也要求按推算兜底）。能确定学期时按学期锚点推算
   （第一学期 = 9 月 1 日所在周的周一、第二学期 = 2 月 20 日所在周的周一、短学期 = 7 月 1 日所在周的周一），
   确定不了才退回提取当天所在周的周一；口径与任务卡「按提取日期推算最近周一」的后半段一致，推算值一律写进提醒。
9. **总周数**：教务不给，按 20 周；课表里最晚周次更晚就抬到那一周（最多 30），并提醒。
10. **合并**：照模板的两阶段合并；阶段 1 的「首尾相接」改成 `next.start <= current.end + 1`（吸收同一节的重复行，批次十九 `xsyu` 的教训）。
11. **与模板 `bbgu` 对齐：无逗号前置标记归属**：`(单)1-8周(双)9-16周`、`第(单)1-8周(双)9-16周` 这类没有逗号的前置写法，
    第二个标记归下一段（单周只落 1-7、双周只落 10-16），不再退化成每周都上、也不再误报「单双同时出现」；
    判归属时允许标记前带一个「第」（模板 bbgu 在这步之前已全局删「第」，本件保留到后面才处理）。
    带逗号的 `(单)1-8周,(双)9-16周` 与后置写法 `1-8周(单)9-16周(双)` 结果不变。fixture 见 `prefix-markers`。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 处理 | 理由 |
|---|---|---|
| `promptUserToStart`（开场确认「请先登录」） | 不移植 | 登录页 / 非教务主机已经直接提示，零请求 |
| `showSingleSelection` 选学期 | 改读页面下拉框当前选中项 | 不弹窗问学期；用户在教务页面切学期即可 |
| `extractSemesterOptions` 的「默认项前后各取若干项」 | 只取选中项 / 第一项 | 空课一次只导入一个学期；弹窗取消后没有别的用途 |
| 取不到学期列表 / 作息时间就 `throw` | 学期取不到才报错；作息取不到回落默认并提醒 | 附加信息缺失不该让整次导入失败 |
| `parseBusinessHoursFromHtml` 里 `JSON.parse` 失败会抛异常 | `jsonOrNull` + 空数组判定 | 页面改版时给可读提示，不是异常栈 |
| 取不到课表 `throw new Error("课表接口无响应")` | 区分「没登录 / 教务返回错误（代码 N）/ 没返回课表数据 / 没有取到课表数据」 | 学生看得懂 |
| `data.length === 0` → alert「该学期没有获取到课程数据」 | 抛大白话错误并指引切换学期 | 无弹窗 |
| `teaxms \|\| "未知"`、`resolvePosition` 的「待定」 | 置 null，按类型汇总提醒 | 「未知」「待定」会被当成真名显示（手册 §4.7） |
| `parseWeeks`（`zc` 只按逗号切、`parseInt`） | 换成通用周次解析（兼容原有周号数组） | 上游接受的写法全部接住，另认「1-16周」「(单)」等 |
| `parseVenueWeeks` 漏周静默丢弃 | 保留周次、用主教室补上并提醒 | 不静默丢课 |
| `isCustomTime` / `customStartTime` / `customEndTime` | 只用于核对节次时间，对不上点名提醒 | 空课载荷没有逐课自定义时间 |
| `Set` / `Map` 去重 | 先去完全相同的行，再两阶段合并（连续节次、同节次周次并集） | 不丢课、不改任何一周的安排 |
| `savePresetTimeSlots` / `saveImportedCourses` / `showToast` / `notifyTaskCompletion` | 不移植 | 「拾光」桥能力，空课由宿主保存 |
| `window.shiguangBridge*` 全部调用 | 不移植 | 同上 |
| 无（新增） | 登录页 / 非教务主机拦截、学期与课程为空的可读报错 | 空课规范的提示要求 |

## 6. 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/lit-port37/mut/lit/` 下的副本上改坏 `parse.js`（改完删掉），跑 `check.js`：

| # | 改坏的地方 | 变红的用例 |
|---|---|---|
| M1 | `teacherOf` 不再去掉方括号备注 | `teachers` |
| M2 | `venueWeeksOf` 不再沿用上一间教室（省略教室名的项当看不懂） | `venue-weeks` |
| M3 | `shortName` 不再截 20 字（长课名原样拼进提醒） | `long-warnings` |
| M4 | 同一节两个不同时间不再判冲突（直接信最后一个） | `hours-conflict` |
| M5 | 「共 N 周」的剥离改成从「共」删到行尾（吞掉后面的真实周次） | `weeks-array` |

每次改坏后都有 DIFF，还原后（`check.js` 在 `jw-adapters/lit` 上）为 `RESULT: PASS`。副本建在系统临时目录，跑完已删除。

## 7. fixtures、自检与冒烟

期望值都是先按规范与代码逻辑手工推出（节次时间、节次、周次切段、单双周、开学日、总周数、学期名、warnings 文本），再跑自检比对；
没有把 parse.js 的输出直接存成期望。共 8 对：

- `basic`：10 节节次时间逐节照抄；连堂 1-2 与 3-4 合成 1-4；单周行 + 双周行并成每周；缺教师 / 缺教室照常导入并汇总；开学日按第一学期锚点。
- `weeks-array`：逗号周号、「1-8周」、「(单)1-8周,(双)9-16周」各归各段、「第1-第8周」、「共 N 周」只剥备注、教学班序号括号、
  备注括号、超界周次 31、缺课名 / 星期 8 / 节次倒挂 / 周次为空的行被跳过并分类计数。
- `venue-weeks`：一间教室一段、同名课按教室拆开；省略教室名沿用上一间；漏周用主教室补并提醒；看不懂的项；`bapjxcd=1` 写「不用场地」；空教室留 null。
- `teachers`：`pkr` 备用教师；方括号备注去掉；完全重复行只留一条；缺教师 / 缺教室汇总。
- `hours-fallback`：没有 `businessHours` → 空课默认 12 节；第 13 节顺推；学期名由代码拼；第 22 周抬总周数。
- `hours-conflict`：同一节两个不同时间 → 整张回落空课默认并说明。
- `long-warnings`：超长课名截 20 字；上课时间对不上、周次认不出、缺教师 / 教室、分周地点对不上各一条，每条 ≤200 字。
- `prefix-markers`：无逗号的两种前置单双写法 `(单)1-8周(双)9-16周` 与 `第(单)1-8周(双)9-16周`，单周只落 1-7、双周只落 10-16，不出现「单双同时出现」提醒。

自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/lit` → `RESULT: PASS`（8 对全部 MATCH）。

浏览器冒烟：`.test/port-batch37/lit/smoke.py`（Chromium + 假教务站，不联网，跑真实 `extract.js` 再交给 Rhino 跑 `parse.js`），15 个场景全部通过：
课表页自带下拉与节次时间（只发课表请求）、首页读取课表页并用默认学期（请求体跟着学期变）、页面有下拉但没节次时间（GET 课表页补，学期来源仍是页面）、
页面与课表页都读不出学期、课表页 404、节次时间缺失回落、排课行时间对不上、根路径登录页 / `/login` / 统一认证路径（报错、零请求）、
非教务主机（报错、零请求）、会话过期（返回登录页 HTML）、`code=1`、空课表、HTTP 500；请求体为
`xnxqdm=202601&zc=&d1=2026-08-01%2000%3A00%3A00&d2=2027-08-31%2023%3A59%3A59`，桩里放的学号 / 姓名 / 证件号 / 手机号 / 教师标记值没有出现在输出里。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

- 真机没验过：学期下拉框 `#xnxqdm` 的 `value` / 文字格式、`businessHours` 的字段与 `jcdm` 是否带前导零、
  `jxcdmc2` 的真实分隔与「教室-周次」格式、`qssj` / `jssj` 是否总带秒，都来自上游代码与同平台脚本，不是实测。
- `zc` 在本校是逗号分隔的周号数组（上游写死这么读）；本件的周次解析更宽松（多认区间与单双标记），对上游已有的写法结果一致。
- 上游没有开学日来源，本件也不请求 `getDatesOfWeek`（未验证本校是否有这个接口）；开学日按学期锚点推算，提醒里会说明。
- 学期总周数教务不给，按 20 周（不早于课表最晚周次）导入并提醒。
- 主机固定为 `lljw.lit.edu.cn`：如果学生通过别的域名 / 代理访问教务（路径相同），会被提示「当前打开的不是洛阳理工学院的教务系统页面」；
  这是为避免在别的站点上发请求。
- 同一个课程名 + 教师、不同教室的记录会归到同一门课的不同安排里；若教务用同一课名给不同教学班，教师为空时会并成一门课（与模板一致）。
- `d1 / d2` 按学期代码前 4 位取学年起始年，代码不是「学年 + 学期」格式时退回落学期文字里的年份，服务端是否接受未验证。

## 9. 签名

0x7E-2023（haiku 移植，2026-11-16）
