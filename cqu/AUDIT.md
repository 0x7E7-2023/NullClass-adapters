# 安全审计 —— 重庆大学（智慧教务，my.cqu.edu.cn，自研 REST 接口）

当前版本 **1.0.1**（2026-11-24 跟进上游 `391193b`，见 §10）；下文 §0–§9 是 1.0.0 的审计，除 §10 列出的改动外仍然有效。

审计对象：`jw-adapters/cqu/` 下的 `manifest.json`、`extract.js`、`parse.js` 与 `fixtures/`。
上游：`shiguang_warehouse` 的 `CQU/cqu.js`（MIT，`adapters.yaml` 维护者 茵符草）。
上游快照 `baf83fa`（2026-11-09 对齐 origin/main）。任务卡写「上游最后提交 `2e1e720`」，
但快照里 `git log -1 -- resources/CQU/cqu.js` 实际是 `1fe584c`（2026-08-23，refactor: 升级桥接接口至 v2），
文件内容与「v2 桥接」一致，以快照为准；快照未做任何修改（只读）。

审计方式：逐行读上游脚本与移植件，跑移植手册 §5 的静态扫描，再用 Playwright 假教务站实跑 `extract.js`、
用 Rhino 实跑 `parse.js`（场景见 §7 与冒烟记录）。

## 0. 平台判断与模板选择

- 库里没有同平台已审计件：`jw-adapters/` 检索 `cqu` 零命中。上游是重庆大学「智慧教务」自研 REST
  （`/api/resourceapi/...` + `/api/timetable/...`），与库里正方、强智、金智 jwapp、青果都不同构。
- 上游快照里另有 `BBGU/bbgu.js` 用同一个金智 `resourceapi` + `timetable` 平台家族
  （`session/list`、`timePattern/get-large-period`、`my-table-detail`、`maxWeek`）。**只借它核对响应外壳的形状**
  （`classTimetableVOList` 也可能套在 `data` 下、`maxWeek` 在 `data`、学期对象带 `year` / `term` / `beginDate`），
  端点、字段、学期选择仍以本校 `CQU/cqu.js` 的代码为准（`session/info-detail` 与 `session-time-pattern`）。
- 模板取 `hueb`：parse.js 的骨架（提醒统一收口 20 条 × 200 字、周次切段、H3 补节次、
  同课合并、缺教师 / 缺教室汇总、学期名兜底）整段沿用；**取数与字段映射全部按上游重写**。

## 1. 请求域与请求清单（与代码逐条对应）

请求主机只有一个：`window.location.origin`，而脚本在**发请求之前**已经检查
`window.location.hostname === 'my.cqu.edu.cn'`（`extract.js` 第 174-190 行），不满足就报错、零请求。
所以实际主机就是 `loginUrl` 的 `my.cqu.edu.cn`。`allowHosts` 为 `["my.cqu.edu.cn"]`，无通配；
代码里没有任何写死的主机名（只有注释里提到 `my.cqu.edu.cn`）。
上游在任意页面都能执行，`scheduleUrlHint` 按主调度决定写门户首页 `https://my.cqu.edu.cn/`。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| `extract.js` | GET | `/api/resourceapi/session/info-detail` | 读当前学期 id（`curSessionId`，兼容 `data.curSessionId`） | 整次报错（没有学期 id 后面全是错的） |
| `extract.js` | GET | `/api/resourceapi/session/info/<termId>` | 读 `data.beginDate`（开学日），顺带读 `data.name` / `sessionName` / `showName`、`data.year`、`data.term` 用于学期名 | 交 `null`：开学日推算、学期名按开学日推，两者都写进提醒 |
| `extract.js` | GET | `/api/timetable/course/maxWeek/<termId>` | 读学期总周数（`data`） | 交 `null`：按课表最晚周导入并提醒（不静默用 20） |
| `extract.js` | GET | `/api/workspace/time-pattern/session-time-pattern` | 读节次时间（`data.classPeriodVOS[]` 的 `periodOrder` / `startTime` / `endTime`） | 交 `null`：整张用空课默认 12 节表并提醒 |
| `extract.js` | POST | `/api/timetable/class/timetable/student/my-table-detail?sessionId=<termId>`，请求体 `[学号]`（JSON） | 读 `classTimetableVOList`（也认 `data.classTimetableVOList`） | 非 2xx / 不是 JSON / 两种外壳都没有：整次报错；空数组交给 `parse.js` 报「没有解析到任何课程」 |

- 全部请求 `credentials: 'include'`（让 WebView 按同源规则带 Cookie），并带
  `Authorization: Bearer <cqu_edu_ACCESS_TOKEN>`（从 `localStorage` 读出，只放进这一个请求头）。
- 后三条是附加数据：任何失败（非 2xx、网络错误、JSON 解析失败）都吞成 `null`
  （`optional()`，`extract.js` 第 109-116 行），由 parse.js 回落并把回落写进提醒。
- 不重试、不翻页、不请求其它模块。`parse.js` 不发任何请求（Rhino 里实跑，纯函数）。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 当前学期 id | `info-detail` 的 `curSessionId` | 带出 `term.id` |
| 开学日 | `session/info/<id>` 的 `data.beginDate` | 只取日期部分，带出为 `startDate` |
| 学期文本 / 学年 / 学期 | `session/info/<id>` 的 `data.name`（或 `sessionName` / `showName`）、`data.year`、`data.term` | 带出为 `term.name` / `term.year` / `term.term`（三个键都是白名单） |
| 学期总周数 | `maxWeek` 的 `data` | 带出为 `maxWeek` |
| 节次时间 | `classPeriodVOS` | 只带 `periodOrder` / `startTime` / `endTime`（`SLOT_FIELDS`，`extract.js` 第 36 行） |
| 排课行 | `classTimetableVOList` | 只带 `courseName` / `instructorName` / `position` / `roomName` / `weekDay` / `periodFormat` / `teachingWeek` 七个字段，1.0.1 起加 `period` / `timeIn` / `startTime` / `endTime`（共 11 个，`ROW_FIELDS`，`extract.js` 第 34-35 行） |
| 本机日期 | 浏览器时钟 | 带出为 `today`，只用于学年 / 学期推不出来时的兜底 |
| **登录令牌** | `localStorage['cqu_edu_ACCESS_TOKEN']`（去掉引号） | **不带出**：只进发往 `my.cqu.edu.cn` 的 `Authorization` 头；不写进报错、提醒、返回对象；冒烟逐字检索过 |
| **学号** | 页面 `.trigger-user-name` 文本里的 `[学号]` | **不带出**：只在 `extract.js` 内存里当课表接口的请求体（`["2026..."]`），不进返回对象、不进提醒 / 报错。课上没有其它接口天然给学号，上游也是这么读的，没有更好的替代办法 |
| 响应里夹带的学生信息（`studentId` / `studentName` / `idCard` / `phone` / `personCode` 等） | 学期与课表接口 | **一律不带出**：按上表白名单挑字段；冒烟把这些人造字段混进每个响应，`extract` 输出与 build 后的载荷里都检索不到 |
| 成绩 / 学籍 / 缴费 / 其它模块 | — | 不请求 |

`parse.js` 实际使用的字段：`term.id/name/year/term`、`today`、`startDate`、`maxWeek`、`periodTimes[].periodOrder/startTime/endTime`、
`rows[].courseName/instructorName/position/roomName/weekDay/periodFormat/teachingWeek/period/timeIn/startTime/endTime`（后四个 1.0.1 起）。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。不读账号密码、不读登录表单值、不读 Cookie。`cqu_edu_ACCESS_TOKEN` 是本校接口要求的登录令牌，按手册例外只放进本校同源请求头；不交出、不外发、不进报错 / 提醒 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js` 的 `requestJson`（第 78-107 行），地址由 `originOf()` 与固定路径拼成；无 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 第三方域 |
| 3 | 请求域可控 | **过**。发请求前限定 `hostname === 'my.cqu.edu.cn'`；`allowHosts` 只写这一个精确主机，无通配；代码里没有写死主机名，也不请求别的域 |
| 4 | 只读课表 | **过**。五条请求分别是当前学期 id、学期详情（开学日）、最大周数、节次时间、个人课表；不碰成绩、学籍、个人信息、缴费。响应里夹带的学生信息按白名单丢弃 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，也没有图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`；只对教务自己的响应做 `JSON.parse`（第 100-104 行） |
| 7 | 不写页面 | **过**。只读 `.trigger-user-name` 的文本与 `localStorage` 的一个键；不写 DOM、不改表单、不触发提交或点击，也不把 HTML 插进页面 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。常量只有主机名、令牌键名与接口路径 |

静态扫描：`extract.js` / `parse.js` 全文（含注释）无箭头函数、反引号、`let ` / `const `、`async` / `await`、
`class`、展开、模板串、`for...of`、`Set` / `Map`、`padStart`、`Array.from`、`includes` / `startsWith`、可选链 / 空值合并、
后行断言 / 命名分组；无 BOM、无控制字节；`parse.js` 里没有 `document.` / `window.` / 网络 / 桥调用。

## 4. 与模板 hueb 的差异

1. **取数层整体重写**：模板是正方 HTML 表单 4 条请求；本件是自研 REST 5 条请求（JSON 响应、Bearer 令牌、POST 请求体是 `[学号]`）。
2. **周次改位串**：模板解析 `zcd` 文字（单双标记、共 N 周）；本件按 `teachingWeek` 位串，第 1 位是第 1 周，
   非 `0`/`1` 字符算认不出，超过 30 位丢弃并提醒。
3. **没有集中实践课、校历、校区**：上游也没有，不编。
4. **节次来源不同**：模板用校区作息接口 + 上游写死的 13 节表；本件用 `classPeriodVOS`，
   取不到**整张用空课默认 12 节表**（上游没有写死的本校表，不臆造），提醒里如实说「默认」而不是「教务的」。
5. **学期不弹窗**：直接用 `info-detail` 的当前学期；学期名按「教务文本 → 学年 + 学期代号 → 按开学日推 → 学校名 + 第 X 学期」四层兜底。
6. **开学日对齐周一**：模板已有，本件照用；对齐时把教务原始日期也写进提醒。
7. **合并条件放宽到「上一节结束 + 1」**：重复行与重叠行都能吸收（批次十九口径），合并前先按原始行内容去重，
   缺教师 / 缺教室与周次丢弃的计数不会被重复行放大。
8. **令牌与学号的处理口径**是本件独有（模板只用 Cookie）。

## 5. 上游里删掉 / 改掉的东西及理由

- 拾光桥（`showToast`、`shiguangBridgePromise.saveCourseConfig / saveImportedCourses / savePresetTimeSlots`、
  `notifyTaskCompletion`）全部不移植：空课由宿主保存载荷，适配器只交 JSON。
- 上游 `baseFetch` 的报错引用了未定义的 `termResponse`（上游 bug），本件改为读当前响应的状态码。
- 上游 `instructorName.slice(0, indexOf('-'))` 在没有 `-` 时返回空串、`slice(0, -1)` 的写法还会砍掉最后一个字（上游 bug）：
  本件只在真有 `-` 时取前一段，并先摘掉 `[主讲]` 这类角色标记。
- 上游 `?? ''` / `?? 0` 的占位：本件把空值交 `null`；「未知」「待定」「暂无」等词也归成 `null`（载荷校验会拒占位词）。
- 上游把 `beginDate` 直接当开学日：本件回退到那一周的周一（手册 §4.3），并在提醒里保留原始日期。
- 上游 `maxWeek` 取不到时整次失败；本件按课表最晚周导入并提醒，超过 30 周按 30 周导入。
- 上游位串非 `0`/`1` 字符会得到 `undefined` 再被过滤（静默少周）；本件当作认不出，整行跳过并计数提醒。
- 上游没有学期名；本件按 §4.7 拼可读学期名，不用适配器名。

## 6. 变异测试记录

全部在系统临时目录的副本上改（`%TEMP%/cqu-port31/mut/cqu`），跑完即删；本目录的 `parse.js` 未被改动。

| # | 改坏哪一处 | 变红的用例 |
|---|---|---|
| 1 | `weeksOf`：`var week = i + 1` 改成 `i`（位串下标错一位） | 7 对全部 DIFF |
| 2 | `sectionsOf`：区间分支 `end: to` 改成 `end: from`（连堂塌成单节） | 7 对全部 DIFF |
| 3 | `mondayOfIso`：直接 `return iso`（不回退到周一） | 仅 `maxweek-clamp` DIFF（周三开学那一对） |
| 4 | `teacherOf`：`raw.indexOf('-')` 改成 `-1`（不再取「-」前一段） | 仅 `merge-duplicates` DIFF |
| 5 | `termName`：恢复成「原文必须含『学期』二字」才采用（2026-11-10 复审修正 R1） | 仅 `term-name-summer` DIFF |
| 6 | `termNameFromDate`：删掉「7 月 = 第三学期」那一行（复审修正 R2） | 仅 `start-july` DIFF |

还原后本目录自检 `RESULT: PASS`。

## 7. fixtures 与自检

9 对合成用例（`manifest.json` 每条都写了覆盖点；8、9 为 2026-11-10 复审修正新增；10–12 为 1.0.1 跟进上游新增，见 §10）：

1. `basic` —— 基本路径：学年 + 学期代号拼学期名、周一开始日、教务 maxWeek、教务 `classPeriodVOS`；
   连堂与单节、单双周位串、缺教师、地点「待定」、完全重复的行。
2. `weeks-bitmap` —— 位串切段（连续 / 孤立 / 隔周）、第 31 周丢弃、全 0 与「1-16」算不完整行、课表更晚周抬高总周数。
3. `no-maxweek` —— 没有 maxWeek 时按课表最晚周；节次时间缺失 → 默认 12 节表；第 15 节顺推与越过 23:59 的说明。
4. `start-fallback` —— 没有 beginDate 时按「第二学期 = 2 月 20 日所在周的周一」推；课表更晚周抬高；教务只给 10 节时用默认表补 11-12 节。
5. `merge-duplicates` —— 重复行去重、连堂合并、同节次周次并集、教室不同不合并、不连续节次保持两段、教师「-」取前一段。
6. `long-warnings` —— 5 门超长课名 / 占位词，提醒按类型汇总、课名截到 20 字、每条 ≤200 字；4 行不完整数据按原因计数；「张三（外聘）」不拆成第二位教师。
7. `maxweek-clamp` —— 周三开学回退到周一并说明、36 周按 30 周导入、没给学期名时按开学日推并说明。
8. `term-name-summer` —— 教务给的学期名是「2026夏」（不含「学期」二字），必须原样使用，不能改说「教务没有给学期名称」。
9. `start-july` —— 只能按开学日推学期名时，7 月开学推成「第三学期」（与 7 月 1 日的夏季学期锚点一致）。
10. `period-bitmap` —— 节次位串（三节课 3-5、位串优先于 periodFormat、超出 20 节的位串整串不用退回 periodFormat、隔节两段）。
11. `custom-time` —— 只有上课时间没有节次：离最近一节 ≤1 小时放进去并提醒；同名同星期只差时间的两行是两节课（rowKey 含时间）；超过 1 小时跳过并计数；周次写错的不进「按最近一节」提醒。
12. `multi-teacher` —— 「;」「；」分隔的多位老师、占位词去掉、重名只留一个、括号备注不拆、全部缺教师计入提醒。

自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/cqu` 最后一行 `RESULT: PASS`。

浏览器冒烟（`python -I -X utf8 D:/NullClass/.test/port-batch31/cqu/smoke.py all`，10/10 OK）：
全部请求被 Playwright 拦到假教务站，不联网。`normal` / `nested` 拼出的请求依次是
`GET /api/resourceapi/session/info-detail`、`GET /api/resourceapi/session/info/115`、
`GET /api/timetable/course/maxWeek/115`、`GET /api/workspace/time-pattern/session-time-pattern`、
`POST /api/timetable/class/timetable/student/my-table-detail?sessionId=115`（请求体 `'["2026000001"]'`），
五条都带 `Authorization: Bearer eyJ...`；令牌、学号与响应里夹带的学生信息在输出和载荷里都检索不到。
另外覆盖：非本校主机 / 读不到学号 / 没有令牌 → 零请求报错；学期接口 500 与空课表 → 整次报错；
课表接口返回 HTML → 报错；三条附加接口全挂 → 仍导入，提醒写明按课表最晚周、默认节次表与推算开学日。

## 7.1 2026-11-10 复审修正

| 编号 | 问题 | 修正 | 捕获方式 |
|---|---|---|---|
| R1 | 教务给的学期名不含「学期」二字（如「2026夏」）时整段丢弃，还反过来提醒「教务系统没有给出学期名称」 | 只要教务给了非空原文就照用 | 新用例 `term-name-summer`；改回「必须含学期」即 DIFF |
| R2 | 按开学日推学期名时 2-7 月一律算第二学期，与本校 7 月 1 日的夏季学期锚点（`KIND_ANCHOR.third`）冲突 | 7 月单独算第三学期 | 新用例 `start-july`；删掉这一行即 DIFF |

## 8. 已知风险与未验证项（我们没有本校账号，真机没验过）

- **响应形状是按上游代码与同平台件推的，没有抓过本校真实响应**：
  `info-detail` 的 `curSessionId` 在顶层还是 `data` 下、`session/info/<id>` 的 `data` 里到底有没有
  `name` / `year` / `term`，都只做了兼容读法。读不到时不会瞎写：开学日推算、学期名按开学日推，两者都在提醒里说明。
- `classPeriodVOS` 按上游读**平铺数组**；同平台的 `get-large-period` 是分组结构，若本校也改成分组，
  这里会整张回落到默认 12 节表并提醒（不会静默用错时间）。
- `periodFormat` 只认「1-2」与「3」（再加全角数字与「第…节」）；出现别的写法会按「缺节次」计数并提醒，不硬塞。
- 课表接口的请求体 `[学号]` 与令牌键名 `cqu_edu_ACCESS_TOKEN` 都照上游；教务改协议时要跟着改。
  学号读不到时脚本给大白话提示、零请求（页面 `.trigger-user-name` 改版会走到这里）。
- 合并把「同一段周次、节次重叠或首尾相接」的多行合成一条（批次十九口径）；周次集合不变，语义等价，
  但教务若用重叠行表达别的东西（例如不同教学班），会被合成一条。
- 30 周上限、单日 20 节上限是载荷校验的硬约束；超出的周次 / 节次丢弃或跳过并提醒，不静默。
- 学期名「按开学日推学年学期」用的是 8 月–次年 1 月 = 第一学期、2–7 月 = 第二学期的通行划分，
  推出来会在提醒里明确说「按开学日期记为」。

## 9. 签名

0x7E7-2023（haiku 移植，2026-11-09）

## 10. 1.0.1 跟进上游 `391193b`（2026-11-24）

上游 `391193b`（2026-11-17，PR #934「适配重庆大学非正常节数课程与考表导入」，茵符草）改了 `CQU/cqu.js`（+80/−39）。
快照 `f83288e` 与 `1dc9ac6` 对 `resources/CQU/` 内容一致，`baf83fa..f83288e` 之间只有这一个提交。只读比对，快照未改。

### 10.1 上游每条改动：跟 / 不跟

| 上游改动 | 决定 | 理由 |
|---|---|---|
| 节次改用 `period` 位串（`matchAll(/1+/g)`，第 1 位 = 第 1 节），支持三节课、隔节课 | **跟** | 课表数据正确性；位串优先，`periodFormat` 保留作回落（旧版接口或位串不认时不丢课） |
| 无节次时用 `timeIn`（`HH:mm~HH:mm`）或 `startTime` / `endTime` 作自定义上课时间 | **跟，但按手册 §4.4 改写** | 上游把 `isCustomTime` 挂在课上，载荷没有这个字段；按开始时间找差不超过 1 小时的最近一节，找到放进去并提醒，找不到跳过并计数（不静默丢课） |
| 教师按 `;` 拆成多位（每位取「-」前一段、去 `[..]`） | **跟** | 我们旧版只取第一个「-」前的整段，`甲-教授;乙-副教授` 会静默丢第二位老师；现在拆开、占位词去掉、重名只留一个 |
| 地点回落 `hourType`（课程性质） | **不跟** | 「理论」「实验」不是地点，会误导学生；缺地点照常计数提醒 |
| 周次 `split('')` 只认 `'1'`，其它字符静默忽略 | 不跟（我们已是对的） | 我们只认 0/1，出现别的字符整行计为「认不出的周次」并提醒，不静默少周 |
| 周次为空或星期不对直接丢课（`return []`） | 不跟（我们已是对的） | 计数并进提醒 |
| `getStartDate` 改用 `toLocaleDateString('sv-SE')` | 不跟（我们已是对的） | 我们直接截取教务字符串的年月日（`isoOfAny`），不经过 `Date`，没有时区换算问题 |
| `baseFetch` 的错误处理、`toLocaleDate`、`padStart` 等写法 | 不跟 | 1.0.0 已修（读当前响应状态码）；我们是 ES5，不用可选链 / padStart |
| `maxWeek` 与课表最晚周取大（`semesterTotalWeeks`） | 不跟（我们已是对的） | 1.0.0 的 `raisedBySchedule` 提醒同口径 |
| `timeSlots` 时间规整为 `HH:mm` | 不跟（我们已是对的） | `timeOf` 同口径，越界时间交 null 回落 |
| 学期详情（`Promise.allSettled` → `Promise.all`）失败整次报错 | 不跟 | 我们的附加接口失败吞成 null 并提醒，不让附加数据挡住课表（公共说明） |
| `credit` 字段 | 不跟 | 载荷没有学分字段 |
| 考试安排（`getExams` / `parseExams`，写成「[考试] …」课） | **不跟** | 空课规范没有考试载荷（任务卡与公共说明要求） |
| 保存桥、`showToast`、`notifyTaskCompletion` | 不跟 | 同 1.0.0：空课由宿主保存 |

### 10.2 改动落点

- `extract.js`：`ROW_FIELDS` 增加 `period`、`timeIn`、`startTime`、`endTime`（共 11 个，都是排课时间字段，无个人信息）。请求清单、学号 / 令牌处理、白名单逻辑不变。
- `parse.js`：`sectionsOf`（位串优先 → `periodFormat`）、`customStartOf` / `nearestPeriodOf`（上课时间回落）、`teacherOf`（多教师）、`rowKey`（节次与上课时间进去重键，同名同星期只差时间的两行不被合并掉）；节次基础表移到逐行处理之前（上课时间要找最近的一节），H3 补节次仍在行处理之后。
- 新增提醒：「有 N 门课只有上课时间、没有标准节次，已按开始时间放进最近的一节（例如「…」）」与「上课时间离各节都超过 1 小时」计数（并入「有 N 行课表数据不全」）。
- `shortcut:`（`parse.js`，`nearestPeriodOf` 上方）：自定义时间只放开始时间最近的一节，跨多节的课只占一节；载荷有按课自定义时间的字段时再改。

### 10.3 差分测试

- 改动前把 9 对旧 fixtures 与一份自造探针输入（`probe`，覆盖位串、上课时间、多教师、占位词、周次坏的晚课）的输出存到 `C:/Users/23703/AppData/Local/Temp/cqu-port38/base/`；改完后同样输入重跑。
- 9 对旧 fixtures：输出**一字不差**（`cmp` 全部 SAME）。
- 探针输入的有意修正（旧结果 → 新结果，依据上游 `391193b`）：
  - 多教师课「甲老师-教授;乙老师-副教授[主讲]」：旧「甲老师」→ 新「甲老师,乙老师」（上游 `split(';')`）。
  - 「非标三节」`period=0011100`、无 periodFormat：旧「缺节次跳过」→ 新第 3-5 节（上游位串）。
  - 「位串优先」`period=01100000` + `periodFormat=5`：旧第 5 节 → 新第 2-3 节（上游只看位串）。
  - 「自定义晚课」`timeIn=18:30~20:00`：旧「缺节次跳过」→ 新第 9 节 + 提醒（§4.4）。
  - 「自定义起止字段」`startTime=19:55:00`：旧「缺节次跳过」→ 新第 10 节 + 提醒。
  - 「自定义太早」`06:30~07:20`：旧「缺节次跳过」→ 新跳过，计入「上课时间离各节都超过 1 小时」。
  - 「自定义且周次坏」`1x11`：旧计为「缺节次」→ 新计为「缺周次 / 认不出的周次」（上课时间先于周次检查，但只有周次不合法时才计入周次原因）。
  - 「位串超范围」（第 26 节）、「占位教师」：与旧版一致。
- 新增 3 对 fixture 的期望值是按规范与代码逻辑手工推出来的（先推 expected、再跑自检比对），自检 12 对全部 MATCH。

### 10.4 变异测试（1.0.1 新增逻辑，在临时副本上改，跑完即删，本目录 parse.js 未改动）

| # | 改坏哪一处 | 变红的用例 |
|---|---|---|
| 7 | `sectionsOf`：位串分支整段去掉（`if (false)`，等于不要位串） | 仅 `period-bitmap` DIFF |
| 8 | `rowKey`：去掉 `period` / `timeIn` / `startTime` / `endTime` | 仅 `custom-time` DIFF（两行「晚课A」被合并成一节） |
| 9 | `teacherOf`：不再按「;」「；」拆分 | 仅 `multi-teacher` DIFF |

还原后自检 `RESULT: PASS`（12 对）。

### 10.5 冒烟

`python -I -X utf8 D:/NullClass/.test/port-batch38/cqu/smoke.py all`：10/10 OK。冒烟表里新增两行（节次位串 `0011100` 与上课时间 `18:30~20:00`），断言它们分别归到 3-5 节与 9 节；白名单扩到 11 个排课字段。

### 10.6 已知风险

- 位串、`timeIn`、`startTime` 的真实字段形状只按上游代码推断，本校真实接口没有抓过；`period` 为空而 `timeIn` 格式不同（例如带秒、带中文）时会计入「上课时间离各节都超过 1 小时」或直接缺节次，不会静默放错。
- 自定义时间的课只占一节（最近的那节），跨多节的上课时间会少算后面的节次（见 `shortcut:`）。
- 未验证：教务同时给出 `period` 与 `periodFormat` 且两者不一致时，以位串为准（与上游一致），本校是否存在这种情况未知。

### 10.7 复审修正（主调度，2026-11-24）

- 复审 B1：`customStartOf` 只要 `timeIn` 非空就不再看 `startTime` / `endTime`（上游 `timeIn?.split('~') ?? [...]` 也是这样），`timeIn` 写成「待定」时有效的起止字段被丢、整门课计入「数据不全」。
  改为 `timeIn` 认不出时再试起止字段（`validStartOf`）。`custom-time` 用例补一行「待定时间课」（`timeIn` 待定、19:00 起 → 第 9 节，提醒计数 2 → 3）。
- 变异：把回落去掉 → `custom-time` 变红；还原后 PASS。

签名：0x7E7-2023（haiku 跟进上游，2026-11-24）
