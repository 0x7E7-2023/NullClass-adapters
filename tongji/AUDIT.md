# 安全审计 —— 同济大学（学校自研「1 系统」REST 接口）

审计对象：`jw-adapters/tongji/` 下的 `extract.js` / `parse.js` / `manifest.json` 与 `fixtures/`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `TONGJI/tongji_01.js`（上游快照 commit `baf83fa7972d4be6627c534992f7d2da399a0945`，2026-11-09 拉取，MIT，作者 Linho1219）。

审计方式：逐行读上游脚本与移植件，并跑移植手册 §5 的静态扫描。扫描结果：

- 绝对 URL：代码里没有。文件头注释里有上游仓库地址；`extract.js` 的主机名常量是 `1.tongji.edu.cn`（与 `loginUrl` 同源），请求地址一律由 `window.location.origin + '/api'` 拼出。
- 网络调用：只有 `extract.js` 第 59 行 `request` 函数里的 `fetch(url, options)`。`parse.js` 没有任何网络调用。
- 动态执行、写页面、埋点：`eval` / `new Function` / `sendBeacon` / `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `submit` 全部无命中。
- 凭据与本地存储：没有 `localStorage` / `sessionStorage` / `document.cookie`。`extract.js` 第 49 行 `onLoginPage` 里有一处 `querySelector('input[type="password"]')`，
  只判断登录页上有没有密码输入框，**不读、不存、不交、不转发它的值**（check.js 的 `password` 提示指的就是这一处）。
- 模板件残留：代码、manifest、给学生看的文字里检索模板学校的目录名、学校名与主机，零命中；本文件只在 §4 的对比语境里提到模板目录名。
- ES5 与文件卫生：两段脚本没有 `=>`、反引号、`let `、`const `、`class `、async/await、可选链、后行断言等；无控制字节、无 BOM（check.js 逐字节扫描通过）。

## 0. 与任务卡的出入

1. 任务卡写「上游最后提交 `2e1e720`」。快照里 `2e1e720`（2026-09-17，Fix syntax error in alert content string）改的是别的学校，
   **`TONGJI/tongji_01.js` 最后一次修改是 `1fe584ccf60553688e7759cd8070baf5caae66ed`**（2026-08-23，refactor: 升级桥接接口至v2，作者星河欲转）。
   `git -C <快照> log -1 --format=%h -- resources/TONGJI/tongji_01.js` 的输出是 `1fe584c`。本件按实际提交记录写文件头，未改快照。
2. 任务卡写「找不到总周数就用课表最大周并提醒」。本件按**主调度已定的口径**（批次三十一 reviewer 说明）执行：
   教务给得出就用教务的，否则内置 20 周；只有课表里出现更晚的周次才把总周数抬到那一周并提醒。
   理由：直接拿课表最大周当学期长度，会把「教务没排到第 18 周」的学期截成 16 周，与公共说明第 7 条冲突。
3. 任务卡说上游维护者 `Linho1219`；`adapters.yaml` 的 `maintainer` 字段确实是 `Linho1219`，文件头与 manifest 照此写。

## 1. 请求域与请求清单（与代码逐条对应）

主机只有一个：**用户当前所在的 `1.tongji.edu.cn`**。上游把 `https://1.tongji.edu.cn/api` 写死；移植件改用 `window.location.origin + '/api'`（`extract.js` 第 30–38 行 `originOf` / `apiBase`），
非本校主机的页面在第 262 行直接报错、一个请求都不发。`allowHosts` 只写精确主机 `["1.tongji.edu.cn"]`，不写通配。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js（`checkAuth`，第 202 行） | POST | `/api/sessionservice/session/currentAuthId`，请求体 `{"authId": 四位数}` | 判断登录状态（上游同样发这个请求；数字是本地随机生成的，不是令牌） | 401/403 报「教务系统要求重新登录」；其余非 2xx 报「教务系统返回错误（代码 N）」 |
| extract.js（`currentTerm`，第 226 行） | GET | `/api/baseresservice/schoolCalendar/currentTermCalendar?_t=…` | 取当前学期 id 与名称 | 读不到 id 或请求失败 → 见下一行 |
| extract.js（`termFromList`，第 210 行） | GET | `/api/baseresservice/schoolCalendar/list?_t=…` | 当前学期读不到时的回落：取列表第一项，`fromList=true` | 连它也读不到 → 报「没能读到学期信息」，提示重新登录 |
| extract.js（`loadDetail`，第 239 行） | GET | `/api/baseresservice/schoolCalendar/detail?id=<日历 id>&_t=…` | 开学日 `beginDay`、逐节时间 `noWeekendWorkTimes`、总周数字段 | 失败一律交 `null`，parse.js 回落推算与默认节次时间并写提醒，**不阻断导入** |
| extract.js（`loadCourses`，第 249 行） | GET | `/api/electionservice/reportManagement/findStudentTimetab?calendarId=<日历 id>&_t=…` | 取课表 `data[].courseName` + `data[].timeTableList[]` | 非 2xx 报错；返回不是 JSON 报「没有返回可读取的课表数据」；`data` 为空数组交给 parse.js，由它报「没有解析到任何课程」 |
与上游的差别：

- 上游每次都用 `showSingleSelection` 问「是否使用当前学期 / 选择其他学期」，并请求一次学期列表做选项。移植件删掉弹窗，直接取当前学期；
  只有当前学期读不到时才请求列表并取第一项，这件事由 `parse.js` 写进提醒（第 501 行）。
- 上游把主机写死；移植件用同源地址，网关换端口或域名不影响。
- 上游的桥调用（`shiguangBridge*`）全部不移植，空课由宿主保存。
- 请求头只带 `Accept` 与（POST 时）`Content-Type`；`credentials: 'include'` 让 WebView 按同源规则带 Cookie，脚本不读 Cookie、也不把它发到别处。

## 2. 读了什么、交出去什么（逐字段）

`extract.js` 交出的对象（`parse.js` 只读这些）：

| 字段 | 从哪来 | 说明 |
|---|---|---|
| `term.name` | `currentTermCalendar` 的 `data.schoolCalendar.fullName` / `name` / `data.fullName` / `simpleName` 等；回落时取列表项的同名字段 | 学期名要用 |
| `term.fromList` | 是否走了学期列表回落 | 只用于提醒 |
| `today` | 本机日期（`localTodayIso`） | 推算开学日的兜底锚点 |
| `detail.beginDay` | `detail` 的 `data.beginDay` | 开学日 |
| `detail.times[]` | `data.noWeekendWorkTimes[]` 的 `beginTime` / `endTime` | 逐节时间，**只带这两个字段** |
| `detail.totalWeeks` | `data` 或 `data.schoolCalendar` 上 `TOTAL_WEEK_KEYS`（`extract.js` 第 142 行）里第一个 1–30 的整数 | 见 §8 未验证项 |
| `courses[].courseName` | 课表接口 `data[].courseName` | 课名 |
| `courses[].timeTableList[]` | 每条安排只挑 `SLOT_FIELDS`（`extract.js` 第 177 行）：`teacherName` / `roomIdI18n` / `roomLable` / `dayOfWeek` / `timeStart` / `timeEnd` / `weeks` | `roomLable` 是接口里拼错的字段名，以代码为准 |

**不带出**：课表响应里夹带的学生姓名、学号、身份证号、手机号、人员 ID 等个人字段；`extract.js` 只按上面的白名单复制字段，
冒烟场景把这些字段混进课程与安排对象，交出的字符串与最终的课表载荷里都检索不到（`SECRETS` 断言）。

`parse.js` 实际读的字段：`term.name` / `term.fromList`、`today`、`detail.beginDay` / `detail.times[].beginTime|endTime` / `detail.totalWeeks`、
`courses[].courseName`、`courses[].timeTableList[].teacherName|roomIdI18n|roomLable|dayOfWeek|timeStart|timeEnd|weeks`。不读其它任何字段。

不读的东西（静态扫描无命中）：登录表单值、密码、Cookie、本地存储、成绩、学籍、缴费，以及其它任何模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。不读登录表单值、不读本地存储、不读 Cookie。`onLoginPage` 只判断页面上有没有密码输入框（不取值）。会话 Cookie 由浏览器按同源规则带上，脚本既不读也不外发。上游的弹窗与保存桥全部删除，向用户问的次数为 0 |
| 2 | 不外发 | **过**。全部请求在 `extract.js`，地址由 `window.location.origin + '/api'` 拼成，只打本校教务主机；没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image` |
| 3 | 请求域可控 | **过**。主机只有 `1.tongji.edu.cn`，`allowHosts` 是精确主机数组，无通配；主机不匹配时零请求直接报错 |
| 4 | 只读课表 | **过**。五个请求全部落在 `/api/sessionservice/session/currentAuthId` 与 `/api/baseresservice/schoolCalendar/*`、`/api/electionservice/reportManagement/findStudentTimetab`，不碰成绩、学籍、个人信息、缴费；响应里的学生字段按白名单丢弃 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`；只对教务自己的响应做 `JSON.parse`（`extract.js` 第 94 行 `jsonOf`） |
| 7 | 不写页面 | **过**。不写 DOM、不改表单、不触发提交或点击；只读 `location` 与 `document.querySelector` |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的令牌、密钥或他人学号；常量只有主机名、接口路径与常见字段名。`authId` 是每次本地随机生成的四位数，来自上游 |

## 4. 与模板 hueb 的差异

模板选 `hueb` 只借 `parse.js` 的骨架（warnings 收口、H3 补节次、开学日回退周一、缺教师/教室汇总、载荷结构），取数层与字段映射按本校上游重写：

1. **平台不同构**：本校是学校自研 JSON REST（`/api/...`，GET + 一个判登录的 POST），模板是正方 `jwglxt` 表单 POST。`extract.js` 整份重写。
2. **周次是数字数组**：上游 `weeks` 本来就是 `[1,2,3…]`。模板那套文字周次解析（单/双括号归属、「共 N 周」、教学班序号、多段节次）**整段删掉**；
   改为 `weeksOfValue`（第 233 行）排序去重、`runsOf`（第 248 行）切极大段。单双周由步长 2 判断，语义与手册 §4.1 一致。
3. **节次时间是教务给的**：模板有学校写死的 13 节表；本校上游没有写死表，`noWeekendWorkTimes` 是唯一来源（`periodTimesOf`，第 268 行）。
   取不到时用空课默认 12 节（`BUILTIN_PERIOD_TIMES`，第 45 行）并提醒。
4. **总周数来源不同**：模板读校历接口的周次；本校读 `detail` 里的总周数字段（`extract.js` `totalWeeksOf`），找不到按 20 周、更晚的周次抬高。
5. **不合并连堂**：上游同济脚本不合并（一个 `timeTableList` 条目就是一条安排），本件也不合并，只做完全重复行去重（`dropExactDuplicates`，第 380 行），
   避免合并改变语义；连堂的两条安排会各自成为一条上课安排，显示效果等价。
6. **教师工号剥离**：照上游 `removeId`，去掉末尾 `(1001)`、把中间 `(1001),` 折成 `, `；先把全角括号与顿号归一。
7. **教室 `roomLable` 兜底**：`roomIdI18n` 为空时用 `roomLable`（接口拼写错误，以代码为准）。
8. **学期回落**：模板从页面下拉框读；本校读当前学期接口，读不到时取列表第一项并提醒。
9. 模板里为正方准备的 `#xnm/#xqm` 读取、`DOMParser`、请求体拼接、菜单号等全部删除。

## 5. 上游里删掉 / 改掉的东西及理由

1. **删掉桥调用**：`shiguangBridgePromise.showSingleSelection` / `saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig`、`shiguangBridge.showToast` / `notifyTaskCompletion`（上游第 48、57、59、63、69、106–110、121、125 行）。空课由宿主保存，这些桥在空课里不存在。
2. **删掉「是否使用当前学期」弹窗**：上游第 48 行会让用户选。移植件直接取当前学期；读不到才回落学期列表第一项并提醒。
3. **开学日换算**：上游用 `Intl.DateTimeFormat` 把 `beginDay` 格式化后原样当开学日（第 33–41 行），不回退到周一。移植件按手册 §4.3 回退到该周周一（`parse.js` 第 439 行），并在日期不是周一时提醒。
4. **总周数**：上游第 102–104 行用 `Math.max(...weeks)` 当总周数，且 `weeks` 为空时会得到 `-Infinity`。移植件优先读教务字段，读不到用 20 周，只在课表更晚时抬高并说明。
5. **教师缺失不再崩**：上游 `removeId(t.teacherName)` 对 `undefined` 会抛异常。移植件把缺失 / 占位词交给 `null`，并汇总提醒（`parse.js` 第 599–616 行）。
6. **字段白名单**：上游逐条新建对象，本身没有把个人字段带进 `saveImportedCourses`；移植件在 `extract.js` 里就把白名单收紧到 `SLOT_FIELDS`，即使响应里夹带学生信息也带不出来。
7. **课表接口信封只定义一次**：`extract.js` 只在 `pickCourses`（第 188 行）里认 `data[]`，没有第二处判断，避免「一处认、一处不认」把数据丢掉。

## 6. 变异测试记录

变异脚本 `.test/port-batch31/tongji/mutate.py` 把整个适配器复制到系统临时目录（目录名同样是 `tongji`，否则 `check.js` 会因 `manifest.key` 与目录名不一致报错），
只改副本的 `parse.js`，每条替换要求恰好命中一次；真文件 `jw-adapters/tongji/parse.js` 没有被变异脚本写过。

| 变异 | 改了什么 | 变红的 fixture |
|---|---|---|
| M1 | `weeksOfValue` 不再丢弃超出 1–30 的周次（去掉 `week > MAX_WEEK`） | `missing`（第 31 周被当成真实上课周次，`totalWeeks` 与提醒都对不上） |
| M2 | 教师工号剥离正则改成永不命中 | `basic`、`runs`、`term-list`、`h3-periods`（教师名变成「张三(1001)」这类） |
| M3 | `usedCalendarWeeks` 恒为 `false`（忽略教务给的总周数） | `basic`、`runs`、`long-warnings`、`term-list`、`h3-periods`（18/16 周被写成 20 周） |
| M4 | `NAME_TEXT_LIMIT` 20 → 200（提醒里不截课名与周次原文） | `long-warnings`（超长课名与三条长周次原文撑破 200 字，末尾「如发现少课请反馈」被截掉） |

结果：**4/4 被捕获**；变异前后真文件 `parse.js` 的 SHA-256 一致（`02480b5569216e939a5b53758d45e57001ae8bb9112e24f7e485cd2e2993722d`），
还原后 `check.js` 结果 `RESULT: PASS`。

## 7. fixtures 与自检

6 对合成用例（`_note` 里写明是编造的，课程、教师、教室均为虚构，无真实个人信息；期望值按规范与代码逻辑手推后再比对，没有把 `parse.js` 的输出直接存成 expected）：

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 13 节逐节时间与周一开学日；总周数取教务；教师工号剥离、多教师逗号分隔；`roomLable` 兜底；「暂无」与空值交 `null`；单双周；完全重复行只留一条 |
| `runs` | 数字周次切段：1-3 / 5-7 / 9-11 / 13-15 四段、隔周单周 1-9、单周 12、步长变化 1,2,4,6 → 1-2 每周 + 4-6 双周 |
| `missing` | 详情取不到：开学日推算、20 周被第 21 周抬高、默认 12 节 + H3 顺推 13-14 节；缺课名 / 星期 8 / 节次 5-3 / 周次只有「第一周」各计一行；周次 0 与 31 丢弃；无上课安排的课单独提醒 |
| `long-warnings` | 长课名 + 缺教师/教室 + 三条长周次 + 三条脏行：提醒汇总、课名与周次原文截到 20 字、每条 ≤200 字（专钉限长） |
| `term-list` | 学期回落（`fromList`）与学期名兜底「同济大学 第一学期」 |
| `h3-periods` | 教务只给 11 节，课表排到 12-13 节：第 12 节用空课默认时间、第 13 节顺推，逐节说明 |

自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/tongji` → `RESULT: PASS`，6 对全部 MATCH。
8 份期望里 warnings 最多 8 条（`missing`），单条最长 177 字（`long-warnings` 的跳过行提醒），都在 20 条 / 200 字上限内。

浏览器冒烟：`.test/port-batch31/tongji/smoke.py`（Playwright 拦截全部地址到假教务站，不联网），9/9 OK：
正常页 4 个同源请求（POST 判登录 + 3 个 GET）、登录页与外部主机零请求、401 报请先登录、当前学期读不到走学期列表回落、
当前学期 500 报错、详情 500 时回落推算与默认节次、空课表在解析时报错、课表接口返回 HTML 时报错；
交出的对象与最终载荷里检索不到混进响应的学号、姓名、身份证号、手机号与令牌。本机随带的 Chromium 内核缺失，冒烟用 `NC_PW_CHANNEL=msedge` 走系统 Edge。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **总周数字段名未验证**：任务卡要求「按真实字段名找」，但拿不到本校账号，只能在 `data` 与 `data.schoolCalendar` 上按常见字段名
   （`totalWeeks` / `weekCount` / `weeks` / `maxWeek` 等 12 个）找 1–30 的整数。真实字段名若不是这些，会退到内置 20 周并在提醒里说明，
   不会导错，但可能比实际学期长或短。拿到真实响应后应把字段名补进 `TOTAL_WEEK_KEYS`（`extract.js` 第 142 行）。
2. **响应外壳未验证**：`currentTermCalendar` 的 `data.schoolCalendar.id`、`data.simpleName`、`detail` 的 `data.beginDay` / `data.noWeekendWorkTimes`、
   课表的 `data[]` 形状都照上游代码；上游没有给出样例。fixture 与冒烟站按这些形状编造。
3. **`beginDay` 的格式**：上游用 `new Date(...)` + `Intl`，说明它可能是 ISO 日期时间或时间戳；移植件用 `isoOfAny` 只认 `yyyy-MM-dd` / `yyyy/MM/dd` / `yyyy.MM.dd`
   开头。若是纯时间戳，会回落推算并提醒，不会静默写错。
4. **`currentAuthId` 的语义**：上游用它判断登录（非 2xx 即报「请先登录」）。如果真实部署在未登录时仍返回 200，登录失效会由后续接口报错兜住。
5. **学期列表的顺序**：回落时取 `data[0]`，假设列表把当前 / 最新学期排在最前。若不是，导入的可能是别的学期；提醒里写明了这一点，但没有自动判断的依据。
6. **登录页的识别**：非 `1.tongji.edu.cn` 的页面零请求报错；同主机上按路径 / 片段含 `login` 或页面有密码输入框判断。若学校把登录页放在同主机的奇怪路径且没有密码框，可能先发一次请求再报登录失效。
7. **`noWeekendWorkTimes` 是工作日作息**：上游就用它当逐节时间。若学校把它拆成工作日 / 周末两张表，周末课的节次时间可能对不上。
8. **不合并连堂**：同一门课分成 1-2 与 3-4 两条安排时会显示成两条上课安排，不合并成 1-4；不影响周次与课程本身。
9. 全部 fixture 为合成数据，只证明转换逻辑与防回归能力；真机与真实响应的解析正确性靠用户反馈迭代。

## 9. 签名

移植与审计：0x7E7-2023（haiku 移植，2026-11-09）。
上游出处：`shiguang_warehouse` → `resources/TONGJI/tongji_01.js`（快照 commit `baf83fa7972d4be6627c534992f7d2da399a0945`，2026-11-09 拉取；
本校脚本最后修改 `1fe584ccf60553688e7759cd8070baf5caae66ed`，2026-08-23，MIT，作者 Linho1219）。
