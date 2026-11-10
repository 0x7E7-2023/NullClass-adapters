# 安全审计 —— 山东轻工职业学院（sdlivc，jedu 教务 JSON 接口）

审计对象：`jw-adapters/sdlivc/` 下的 `manifest.json`、`extract.js`、`parse.js` 与 `fixtures/`。
上游：`shiguang_warehouse` 的 `SDLIVC/sdlivc.js`（MIT，`adapters.yaml` 维护者 赛博丁真）。
上游快照 `baf83fa7972d4be6627c534992f7d2da399a0945`；`git log -1 -- resources/SDLIVC/sdlivc.js` 核对为 `1fe584c`，与任务卡一致。未修改快照。

## 0. 通读结论与模板选择

库里没有同平台（jedu 教务 JSON 接口）的已审计件。选 `sany` 作骨架：它同样是「当前页面同源 POST + 登录页零请求 + 字段白名单 + 纯函数 parse」的结构，且已审计过提醒限长、缺字段汇总、节次扩展。取数地址、请求体、字段名、星期映射、停开标记与合并语义全部按本校上游代码重写；`bupt`（正方 DOM 表格）只作周次提醒与 H3 的交叉参考。周次文字解析参考了 `nwafu` 的逐段解析，但按本校上游「先剥备注、再按逗号分段」的写法重写，并补上括号组号与备注的区分。

上游代码事实：

1. 请求只有一个 `POST <rootPath>/edu/core/eduScheduleInfo/getScheduleNew.do`，正文 `semId`、`stuId`、`checkType=student`，`rootPath` 取 `window.__rootPath`，缺省 `/jedu`。
2. 返回 `json.success === true` 且 `data.schedule` 是数组；上游读 `courseName`、`teacherName`、`eduPlace.placeName || eduPlace.nameIncludeNum`、`week`、`weekList`、`eduLesson.startLesson`、`eduLesson.endLesson`。
3. 星期是 `mon`..`sun`；`stopCourse !== 'NO'` 的记录整条跳过。
4. 周次是文字：上游先删空白、全角标点、「第」「周」，再按逗号分段落，每段各自看有没有「单」「双」。
5. `stuId` 从 `window.stuId` 或页面源码 `var stuId` 读；`semId` 从 `mini.get('semId')` 或 `input[name="semId"]` 读。
6. 上游只声明每节 45 分钟、课间 10 分钟，没有各节上下课时刻，也没有校历。
7. 上游直接调用拾光保存桥，弹窗确认后导入；空课由宿主保存。

## 1. 请求域与请求清单

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| `extract.js` 的 `fetch` | POST | `https://<当前教务页主机><rootPath>/edu/core/eduScheduleInfo/getScheduleNew.do`，正文 `semId=<学期>&stuId=<学号>&checkType=student`，`Content-Type: application/x-www-form-urlencoded`，带 `X-Requested-With: XMLHttpRequest` 与同源 Cookie | 读当前学期的课表安排 | 非 2xx：报「教务系统返回错误（代码 N）」；返回的不是 JSON：报「没有返回可读取的课表数据」；`success !== true`：`success === false` 时报「没有返回这个学期的课表」，其余同样报「没有返回可读取的课表数据」；网络失败单独报「连不上教务系统」。空 `data.schedule` 交给 `parse.js` 报「没有解析到任何课程」 |

`rootPath` 来自页面，缺省 `/jedu`；即使页面把它写成完整地址，代码也只保留路径，请求始终落在当前页面主机。`loginUrl` 为 `https://crp.sdlivc.cn/xsgl/xs/login/login.aspx`，`allowHosts` 为 `[]`，没有通配、第三方地址或其它请求。不重试、不翻页（上游同样没有分页逻辑）。

登录页判断在 `pageProblem()`：密码框存在，或地址含 `login.aspx`，直接报大白话，**不发生任何请求**。拿不到 `stuId`（`studentId()` 为空）也在发请求前报错，零请求。

## 2. 读了什么、交出去什么

| 数据 | 来源 | extract 输出 |
|---|---|---|
| `courseName`、`teacherName`、`week`、`weekList`、`stopCourse` | 每个 `data.schedule` 行 | `rows[]` 顶层五字段 |
| `eduPlace.placeName`、`eduPlace.nameIncludeNum` | 同上 | `rows[].eduPlace` 的两个字段 |
| `eduLesson.startLesson`、`eduLesson.endLesson` | 同上 | `rows[].eduLesson` 的两个字段 |
| 本机日期 | 浏览器时钟 | `today`，只用于开学日推算 |
| `stuId` | `window.stuId` 或页面源码 | **不带出**，只进本次同源请求正文；不写错误、提醒或存储 |
| `semId` | `mini` 下拉框或页面输入框 | **不带出**，只进本次请求正文 |
| 学期名、成绩、学籍、证件号、手机号、姓名等其它字段 | 页面 / 响应 | 一律不读、不带出 |

`parse.js` 只接收 `{ today, rows }` 普通 JSON，无 DOM、网络、存储、挂钟或桥调用。输出课名、教师、教室、星期、节次、周次段、学期名、开学日、总周数与 12 节节次时间。教师或地点为「未知」「待定」「暂无」等占位词时交 `null`，课程照常导入并汇总提醒。

## 3. 移植手册 §5 八条逐条结论

1. **不碰凭据**：通过。账号密码不读；密码框只用于存在性判断。`stuId` 是本校接口要求的身份参数，只放进同源请求正文，不交出去、不写日志。
2. **不外发**：通过。只有一个同源 POST；无统计、图片信标、WebSocket 或第三方请求。
3. **请求域可控**：通过。主机取当前页面 `location.origin`；`allowHosts: []`，无通配。
4. **只读课表**：通过。只读课表接口；按字段白名单挑，不请求成绩、学籍、个人信息、缴费。
5. **不埋点**：通过。无统计、上报或遥测。
6. **不动态执行远程代码**：通过。无 `eval`、`new Function`。
7. **不写页面**：通过。只查密码框、读页面源码与输入框值；不改 DOM、不提交表单、不点击。
8. **不依赖硬编码秘密**：通过。无固定令牌、密钥、真实学号；fixtures 全为合成课程与「教师甲」等虚构值。

`check.js` 对 `localStorage/sessionStorage/cookie/password` 的提示已人工复核：本件只有登录页判断里的 `input[type="password"]`，不读其值，也没有本地存储或 Cookie 访问。

## 4. 与模板的主要差异

- **取数**：`sany` 的金智两请求改为 jedu 单请求；`rootPath` 取页面变量、缺省 `/jedu`，并剥掉绝对地址的主机。
- **周次**：`sany` 的位串改为文字解析，按逗号分段各自判单双，兼容前置与后置标记、无逗号写法、括号整段周次与「共 N 周」。
- **学期与开学日**：本校没有学期列表与校历，不选学期；开学日按本机日期所在周的周一推算并提醒，总周数默认 20、课表更晚才抬高。
- **节次时间**：本校上游没有时刻表，用与 `core/model/DefaultPeriodTimes` 一致的 12 节默认表；第 13 节起按 H3 顺推。
- **停开记录**：`sany` 没有停开概念，本件按上游 `stopCourse !== 'NO'` 跳过并出声。
- **学期名**：上游与响应都没有学期文本，按今天的日期推算学年学期并提醒。
- **地点**：`placeName` 与 `nameIncludeNum` 逐个判占位词后再兜底，避免占位教室盖掉真实教室。

## 5. 上游删掉或改掉的内容

- 删除 `showToast`、`promptUserToStart`、`saveImportedCourses`、`saveCourseConfig`、`notifyTaskCompletion` 与控制台输出；空课宿主统一保存载荷。
- 删除 ES6 语法、`Map`、`Set`、展开、异步函数，改为 ES5 对象字典与 Promise。
- 上游 `cleanPlaceName` 的「空值」不再是空串：`placeName` 与 `nameIncludeNum` 都取不到、或是占位词时交 `null`。
- 上游无效行静默丢弃：改为按原因计数并汇总提醒；重复原始行先去重，避免计数被放大。
- 上游把课表最大周当学期长度（`getMaxWeek`）：改为默认 20 周，只有课表更晚才抬高；超过 30 周丢弃并提醒。
- 上游没有开学日：改为按本机日期所在周的周一推算并提醒。
- 上游没有学期文本：改为按今天的日期推算学年学期（1 月属上一学年第一学期，2-7 月属上一学年第二学期，8-12 月属当年第一学期），写成「学校名 + 学年学期」并提醒。
- 地点兜底先判占位词：`placeName` 是「待定」「暂无」「未知」或空白时再看 `nameIncludeNum`，两个字段各自判，不再整串拼起来判。
- 上游没有节次时间：改用默认 12 节并提醒；更晚节次逐节顺推，越过 23:59 不编造时间。
- 上游按 `Object.assign` 合并周次：改为同键（课名 / 教师 / 地点 / 星期 / 起止节次）取并集，连堂保持两段。

## 6. 节次时间与周次规则

**节次时间**：上游只给出「每节 45 分钟、课间 10 分钟」，没有各节时刻，因此整表采用应用默认节次时间（与 `core/model/DefaultPeriodTimes.kt` 逐节核对）：

| 节 | 时间 | 节 | 时间 |
|---|---|---|---|
| 1 | 08:00-08:45 | 7 | 16:00-16:45 |
| 2 | 08:55-09:40 | 8 | 16:55-17:40 |
| 3 | 10:00-10:45 | 9 | 18:30-19:15 |
| 4 | 10:55-11:40 | 10 | 19:25-20:10 |
| 5 | 14:00-14:45 | 11 | 20:20-21:05 |
| 6 | 14:55-15:40 | 12 | 21:15-22:00 |

第 13 节起按上一节下课后课间 5 分钟、每节 45 分钟顺推：13 = 22:05-22:50，14 = 22:55-23:40，第 15 节会越过 23:59，不再补时间（课程照常导入）。

**周次**：`parseWeekText()` 先剥「共 N 周」备注，归一全角括号与顿号，摘掉「数字[-数字]节」的节次文字；括号里含「周/单/双」的保留（`(单)`、`(1-16周)`），纯数字组号 `(1)` 与备注 `(3学分)` 整组摘掉。之后按逗号分段，每段各自看段首 / 段尾的「单」「双」：段首标记管本段后面的周次，段尾标记管紧挨着的前一段；无逗号的 `(单)1-8周(双)9-16周` 按段首风格读成 1-7 单、10-16 双；`1-8周(单)9-16周` 读成 1-7 单、9-16 每周。第 31 周起丢弃并计数。

**学期名**：`termNameOf()` 按 `today` 的月份推学年：1 月属上一学年第一学期，2-7 月属上一学年第二学期，8-12 月属当年第一学期，拼成「山东轻工职业学院 2026-2027学年第一学期」，并在提醒里说明是按今天的日期推算的。

**地点**：`placeOf()` 先对 `placeName` 判空白与占位词，可用就用；不可用再看 `nameIncludeNum`；两者都不可用才交 `null` 并计入缺地点。

## 7. fixtures 与变异测试

10 对均为合成数据，期望按上游字段映射、周次切段、默认节次时间与 H3 顺推、日期规则先独立手推，再跑 Rhino 比对；没有从 parse 输出回填：

1. `basic`：连堂两段、`1-8,10-16` 切段、占位教师教室交空、停开记录跳过、缺周次行计数。
2. `week-forms`：`1-8`、`1-8,10-16`、`第1周至第8周`、`第1-第8周`、`(单)1-8周,(双)9-16周`、无逗号前置 `(单)1-8周(双)9-16周`、后置 `1-8周(单)9-16周(双)`、`共8周,1-4,6-8周`、`（第1-16周）`、`1-8周(单)9-16周`、`1-16周(3学分)`、`第3-4节,1-16周`。
3. `stopped`：`stopCourse` 为 YES / STOP 的记录跳过并计数，完全重复的停开行只算一次。
4. `missing-fields`：占位教师 / 地点交 `null`，地点回落到 `nameIncludeNum`，按课名汇总。
5. `derive-term`：本机日期 2026-11-11 → 开学日 2026-11-09；课表第 21 周把默认 20 周抬高。
6. `long-name`：四门超长课名缺教师与地点，点名截到 20 字、整条仍远低于 200 字。
7. `extra-period`：第 13-14 节顺推、第 15 节越过 23:59 不补。
8. `dirty-duplicates`：缺课名 / 星期 / 节次 / 周次的重复行去重后各计 1，超过第 30 周的周次丢弃。
9. `place-fallback`：`placeName` 为「待定」或空白、`nameIncludeNum` 有真实教室时用后者；两者都不可用才交空并计数。
10. `term-name`：2027-01-15 属上一学年第一学期，学期名推成「山东轻工职业学院 2026-2027学年第一学期」，开学日 2027-01-11。

变异副本只放 `C:/Users/23703/AppData/Local/Temp/sdlivc-port36/mutate/`，正式目录不动；脚本留档 `.test/port-batch36/sdlivc/mutate.py`，要求目标串恰好命中一次。2026-11-11 复审后实测 7/7 被捕获：

| 编号 | 改坏处 | 捕获用例 |
|---|---|---|
| M1 | 前置单双标记判定改为永远后置（`prefixStyle = false`） | `week-forms` DIFF，无逗号的 `(单)1-8周(双)9-16周` 读错 |
| M2 | 括号保留条件只认「周」、不认「单/双」 | `week-forms` DIFF，`(单)`/`(双)` 被当备注删掉 |
| M3 | 节次顺推去掉 23:59 边界 | `extra-period` DIFF，第 15、16 节被补出非法时间 |
| M4 | 总周数不再按课表抬高 | `derive-term` DIFF，21 周退成 20 周 |
| M5 | 停开记录不再跳过 | `basic`、`stopped` DIFF，停开课被导入 |
| M6 | 地点不再回落到 `nameIncludeNum` | `place-fallback` DIFF，占位 / 空白的 `placeName` 吞掉真实教室 |
| M7 | 1 月不再归上一学年第一学期 | `term-name` DIFF，推成 2027-2028 学年 |

全部还原后正式目录自检 10 对 MATCH，`RESULT: PASS`。行号容易漂移，本审计一律按函数名定位。

## 8. 本地浏览器冒烟

`.test/port-batch36/sdlivc/smoke.py` 用 Playwright 拦截全部地址到假站，不联网；真实执行 `extract.js`，再以 Rhino 1.8.0 执行 `parse.js`。2026-11-11 实测 10/10 OK（本机 Playwright 自带 Chromium 缺失，以 `NC_PW_CHANNEL=msedge` 复用系统 Edge；不设该变量时行为不变）：

- `normal`：POST `/jedu/edu/core/eduScheduleInfo/getScheduleNew.do`，正文 `semId=2026-1&stuId=2026000001&checkType=student`，带 `X-Requested-With`；输出只有 `today` 与白名单行字段；多段周次、单双、停开与占位词均正确。
- `login`、`nostuid`：登录页与拿不到 `stuId`，报大白话且请求数均为 0。
- `mini`：`mini.get('semId')` 生效，正文 `semId=SEM-MINI`。
- `rootpath`：`window.__rootPath='/school2/jedu'` → 请求 `/school2/jedu/edu/core/eduScheduleInfo/getScheduleNew.do`。
- `fullurl`：`window.__rootPath` 写成 `https://evil.example.com/jedu` 时只保留路径，请求仍打到 `crp.sdlivc.cn` 的 `/jedu/...`。
- `fail`（`success=false`）、`badjson`（返回 HTML）、`forbidden`（HTTP 500）：三种失败原因分别报错，不混成一句。
- `empty`：空课表由 `parse.js` 报「没有解析到任何课程」。

所有场景都检查了假页面里的合成学号、姓名、证件号、手机号与人员标识没有出现在 extract 输出和最终载荷里（`stuId` 只出现在请求正文）。

## 9. 已知风险与未验证项

- **没有本校账号，真实教务与真机未验证。** 页面路径、响应字段与停开标记以快照代码为依据；合成 fixture 与假站不能证明线上返回完全一致。
- 上游没有给出学生端「学期课表」的稳定深链，`scheduleUrlHint` 按任务卡省略；一键刷新只能从登录页入口走。
- `semId` 读不到时照上游传空，教务可能返回默认学期；如果教务要求必须显式传学期，当前表现是 `success=false` 或空课表，会明确报错而不会导入错学期。
- 学期名拿不到教务文本，只能按今天的日期推算学年学期；开学后跨学期（例如 1 月导入春季学期）会对不上，提醒已说明，需要用户在「学期管理」里核对。
- 开学日没有校历，按本机日期所在周的周一推算；导入旧学期时第 1 周会对不上，已有提醒。
- 节次时间是应用默认 12 节，学校实际上下课时刻未知；提醒已说明。第 13 节起是顺推值。
- `stopCourse` 严格照上游：任何不等于 `NO` 的值都按停开跳过（含空值）。若线上对该字段的写法不同，会在提醒里看到跳过的条数。
- 周次只认上游给的中文写法；认不出的段会被跳过并计入「缺周次」提醒，不会静默。
- 未验证页面是否还有 WebVPN 或路径前缀；`rootPath` 已按当前页面同源拼装，绝对地址会被剥掉主机。

## 10. 签名

0x7E7-2023（haiku 移植，2026-11-11）
复审修正：0x7E7-2023（2026-11-11）——B1 学期名改为按日期推算学年学期并提醒；B2 地点字段逐个判占位词后再兜底。新增 `place-fallback`、`term-name` 两对 fixture，变异 7/7 捕获。
