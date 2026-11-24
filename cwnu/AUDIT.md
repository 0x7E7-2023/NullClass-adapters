# 西华师范大学（`cwnu`）适配器 —— 安全审计

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) → `resources/CWNU/cwnu.js`（MIT）。同目录 `adapters.yaml` 的 maintainer 是 Smoggy Ting |
| 上游快照 | `f83288e`（2026-11-24，与 origin/main 对齐）。`git log -1 -- resources/CWNU/cwnu.js` 核对为 `6275607`（2026-11-21），与任务卡一致 |
| 上游平台 | 树维 for-std 学生端，`jwxt.cwnu.edu.cn`。取数是 `get-data`（学期的课程名单）+ `schedule-table/datum`（课程与排课明细），与 `dlut` 同构 |
| 本适配器 | `jw-adapters/cwnu/`。`extract.js` 只取数，`parse.js` 纯转换（CI 只跑它） |
| 结论 | **安全性通过**（§2）。**正确性未在真机验证**：没有本校账号，夹具与浏览器冒烟都是合成数据，取数与登录态跳转只在桩和 Chromium 拦截里验证过 |
| 移植者 | 0x7E7-2023（haiku 移植，2026-11-24） |

## 0. 选模板与分析（写在前面，供后人复核）

任务卡给的候选是 `nwpu` / `xauat` / `cqust`，逐个对照后都不够近：

- `xauat`：排课明细是**按日期**给的（`date`），没有 `weekday` + `weekIndex`；本校上游直接给的是第几周，两者的周次换算不同构。
- `nwpu`：走 `print-data/{stdId}`（学生 id 放在路径里），不是 `get-data` + `datum`。
- `cqust`：树维 EAMS 旧版（`/eams/`，HTML 片段解析），与 for-std 完全不同构。

选 **`dlut`**（审计 2026-10-17，`jw-adapters/dlut/`）：同为 for-std，取数链路一致（`get-data?bizTypeId=2&semesterId=` → `POST schedule-table/datum`，`lessonList` + `scheduleList` 带 `weekday` / `weekIndex` / `startTime` / `endTime` / `roomName`），分组、节次段切分、周次极大段、提醒的限长出口都可以照搬。不照搬的部分：`dlut` 的节次表来自 `timetable-layout`，本校上游没有这个请求，节次只能用上游写死的两套。

## 1. 请求清单

只在页面是本校教务系统（主机 `jwxt.cwnu.edu.cn`）、且不是登录页时发请求。全部同源相对路径，`allowHosts` 为空数组（任务卡要求，见 §2 第 3 条）。

| # | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| 1 | GET | 当前页 `pathname + search`（若当前页在 `/student/for-std/course-table` 下），否则 `/student/for-std/course-table` | 读学期下拉框 `#allSemesters` / `#semesters`（取文档里先出现的那一个）、页内 `var semesters`（学期起止日期、每周起始是不是周日）、`stdPersonId` | 没有学期下拉框：报「没能在教务页面读到学期列表」，不发后续请求 |
| 2 | GET | `/student/for-std/course-table/get-data?bizTypeId=2&semesterId={id}` | 本学期的 `lessonIds`、`weekIndices`（学期周次名单）、`lessonId2Flag`（课程公开标记） | `lessonIds` 不是数组：报「课程名单看不懂」；为空：报「还没有排课，请切到那个学期」 |
| 3 | POST | `/student/ws/schedule-table/datum`，请求体 `{lessonIds, studentId: null, stdPersonId, weekIndex: null}`（`Content-Type: application/json`） | 取 `result.lessonList`（课程）与 `result.scheduleList`（排课明细） | HTTP 错误：报「教务系统返回错误（代码 N）」；非 JSON：报「内容看不懂，可能没有登录」；`result` 不全：报「课表数据不完整」 |

跳转与登录态：响应的最终地址路径以 `/student/login` 或 `/student/sso` 开头，或返回 401 / 403，一律报「登录状态已失效，请重新登录教务系统后重试」（上游 `request()` 的同一判断）。

不发的请求：上游没有的 `semester/get`、任何成绩 / 学籍 / 缴费 / 个人信息接口。登录页、门户页、其它主机上点提取：只给提示，**零请求**。

`stdPersonId` 来自页面脚本里的 `stdPersonId = N`（与上游同一正则），只出现在请求 3 的请求体里，不带出 `extract.js`。拿不到就是 `null`，与上游一致。

## 2. 移植手册 §5 八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读密码框的值、不读 Cookie、不读存储；只用已登录页面的同源会话（`credentials: 'include'`） |
| 2 | 不外发 | 通过。只有上面 3 个请求，全部同源；无上报、无外链 |
| 3 | 请求域可控 | 通过。主机只有 `jwxt.cwnu.edu.cn`。`allowHosts` 是空数组：本校上游也没有请求别的主机，任务卡要求为空，CI 的 `check.js` 接受 |
| 4 | 只读课表 | 通过。不请求成绩、学籍、缴费、个人信息；交出去的对象按字段白名单挑（§3）；`teacherAssignmentList` 里的 `person` 对象（含证件号字段）只取名字，不带出 |
| 5 | 不埋点 | 通过 |
| 6 | 不 eval | 通过。无 `eval`、`new Function` |
| 7 | 不写页面 | 通过。学期下拉框只读取；不插入、不修改 DOM，不提交表单 |
| 8 | 不硬编码秘密 | 通过。无学号、无密钥。夹具里的课程、教师、教室全部虚构 |

另：移除的上游 `alert` / `showSingleSelection` / `saveCourseConfig` / `savePresetTimeSlots` / `saveComboSchedule` / `saveImportedCourses` / `notifyTaskCompletion` 拾光桥调用，改为交一份载荷，由应用侧导入。

## 3. 读了什么、交出什么（逐字段）

`extract.js` 交出去的 JSON：

- `term`：`id`（学期号）、`label`（学期名，取下拉框文字）、`pickedBy`（`page` 页面上切过的 / `url` 地址里的 / `selected` 页面标了 selected 的 / `first` 列表第一项）。
- `semesters`：每项 `id` / `label` / `selected`（只用来算学期数量）。
- `semesterMeta`：当前学期的 `id` / `startDate` / `endDate` / `weekStartOnSunday`；页内找不到就是 `null`。
- `weekIndices`：`get-data` 的周次名单，只留正数。
- `lessonList`：每项 `id` / `courseName` / `teachers`（教师名字符串数组）/ `flag`（`lessonId2Flag` 里的公开标记，没有就 `null`）。
- `scheduleList`：每项 `lessonId` / `weekday` / `weekIndex` / `startTime` / `endTime` / `personName` / `roomName`（楼的校区 + 教室名，或 `customPlace`）。

不带出：`stdPersonId`、学生 id、`studentId`、接口响应里的学生姓名 / 编号、`person` 对象里的其它字段。夹具 `dirty` / `basic` 的形状都照这份白名单编造；桩跑与冒烟都检查了取数结果里不含学号、姓名、证件号、`stdPersonId`。

`parse.js` 另接受夹具专用字段 `today`，只用于「没有开学日」的夹具推算季节与第 1 周。`extract.js` 从不发送它（代码里没有这一项）。

## 4. 与模板（dlut）和上游的差异

1. **周次不靠日期**：上游与本适配器都直接用 `weekIndex`。开学日只决定「第 1 周从哪天起」。
2. **第 1 周按上游 `firstDayOfWeek` 对齐**：`weekStartOf()` 先回退到周一，学期 `weekStartOnSunday` 为真时回退到周日（移植手册 §4.3）。`dlut` 一律对齐周一，这里不同。
3. **节次时间：只能交一套**（`parse.js` 的季节块）。上游写死两套（`SLOTS_WINTER` / `SLOTS_SUMMER`）并用 `saveComboSchedule` 按日期切换；载荷只有一个 `periodTimes`，所以按开学日（取不到就按提取当天）的季节选一套（5–9 月夏令，其余冬令），并提醒另一套从哪天起生效。学期跨两段时写清切换日期。两套的节次号 1–12 一致，只有下午与晚上差半小时。
4. **节次对不上不再「自定义时间」**：上游用 `isCustomTime` 存具体时间；载荷没有这个字段。这里的规则是：先取落在排课时间范围内的节次；范围内能取到节次、但首末节与排课时间不完全对齐的（例如冬令 14:30–16:00 落在夏令表上只剩第 6 节），按范围内的节次放入并算「近似」；范围内一节都没有的，按开始时间**最接近**的一节放入（相差 ≤60 分钟，也算近似）。所有近似的都提醒，不会悄悄缩短。超过 60 分钟的整门丢弃并点名。
5. **总周数**：有学期结束日期时用「开学日所在周起到结束日」的周数（`ceil((结束日 - 第 1 周起始日 + 1) / 7)`）；没有结束日就用 `weekIndices` 的最大周（依据见 §4 之后的「weekIndices 的来源」）；都没有就 20。课表里有更晚的周次才抬高，并提醒。第 30 周以后的周次裁掉、保留 ≤30 的部分，被裁过的课点名提醒（本轮修正：原先整段跳过，跨过第 30 周的课会整门消失）。上游 `MIN_WEEKS = 16` 不当作学期长度，只保留为校验范围的说明（任务卡要求）；上限 `MAX_WEEKS = 30`（载荷校验）超过的安排跳过并计数。
6. **分组带教室、带教师**：分组键是 `(课程, 星期, 开始, 结束, 教室, 教师)`。上游没有教室这一维，同一时段两间教室的排课会被合并掉一间；教师一并入键后，同课同时段同教室、由不同教师上不同周次的，各自成一条课程（载荷的课程只有一位教师），不会被并成第一行的教师。
7. **教师、教室占位词一律 null**：`未知`、`未知教师`、`待定`、`暂无`、`暂无教师`、`暂无教室`、`无`、空白。教师名括号备注（「张三（外聘）」）剥掉，不拆成第二位教师。教室括号不剥（教室名可能有括号编号）。
8. **不公开的课**：上游 `lessonId2Flag` 值不是 `publish` 时直接跳过；这里也跳过，并按类型**汇总一条**提醒：「另有 N 门课教务未公开安排，例如 A、B、C，这些课没有导入。」，点名最多 3 门，课名截 20 字（上游没有提醒）。
9. **学期选择**：页面上用户切过的（实时下拉框的值，且它不是服务端标出的那一项）> 地址里的 `semesterId` > 页面标了 `selected` 的 > 第一项。上游是弹窗选学期，任务卡要求去掉弹窗。
10. **提醒计数按课程**：缺教师、缺教室按课程（课程名单的 id）计数，不按格子计数。

## 5. 本校专属边界（夹具与冒烟）

夹具共 8 对，期望值按规范、节次表、`parse.js` 的口径**手工推出**后写成字面量（生成脚本只负责把输入形状写成 JSON，期望不由 `parse.js` 输出得来）。

| 夹具 | 覆盖 |
|---|---|
| `basic` | 冬令（10 月开学）节次；连堂（14:30–16:00 = 第 6–7 节）；单周 ODD、双周 EVEN、连续 ALL；同一时段重复行去重；教师 `未知` 与教室 `待定` 转 null；没排课的课点名；提醒「冬令节次时间 + 5 月 1 日起改夏令」 |
| `summer` | 夏令（5 月开学）节次；15:00–16:30 = 夏令第 6–7 节；14:30 的课对不上夏令表，按最接近的节次放入并提醒（2 处）；缺教师缺教室；提醒「夏令节次时间 + 10 月 1 日起改冬令」 |
| `cross` | 学期从夏令跨到冬令（9 月开学到次年 1 月）：「跨两段」提醒写清切换日；校历 19 周、课表排到第 20 周：抬高总周数并提醒 |
| `no-start` | 没有开学日、没有结束日：按 `data.today` 推算第 1 周（周日起算，2026-11-22），提醒；页面没有标出当前学期（用 selected 那一项）；学期列表还有别的学期，提醒只导当前 |
| `long-warn` | 超过 20 字的课名（提醒里截到 20 字，末尾 `…`）；节次时间超过 60 分钟对不上的课点名丢弃；未排课的课点名最多 3 门；缺教师缺教室；每条提醒 ≤200 字 |
| `teacher-split` | 同一门课、同一时段、同一教室，甲老师上第 1 周、乙老师上第 2 周：导入为两条课程，各自保留自己的教师（B1 修正） |
| `weeks-trim` | 大学数学的周次 25..35 裁到 25..30（B2 修正）；程序设计的周次全在第 31 周以后，整门没有导入，同条提醒点名；课表排到第 30 周、校历 17 周，抬高总周数并提醒 |
| `dirty` | 找不到课程名、星期不对、时间不对（开始晚于结束、时间文字认不出）、没有周次各计数；整数 HHmm 时间；占位词教师（`暂无教师`）与教室（`未知`、纯空白）；不公开的课按类型汇总点名 |

浏览器冒烟（`.test/port-batch38/cwnu/smoke.py`，Playwright 拦截，不联网；`NC_PW_CHANNEL=msedge` 指定 Edge 通道）：14 个场景 14/14 OK。

| 场景 | 结果 |
|---|---|
| datum-hang datum 一直不回包 | OK，8 秒后报「教务系统响应太慢，请稍后再试。」 |
| datum-hang datum 一直不回包 | OK，8 秒后报「教务系统响应太慢，请稍后再试。」 |
| normal 正常课表（URL 带学期 / 默认） | OK，3 个请求：页面 → get-data → datum，请求体 `studentId: null`，取数结果不含学号、姓名、证件号、`stdPersonId` |
| url-semester 地址里的学期 1000 | OK，学期号用的是地址里的 |
| no-selected 页面没标出当前学期 | OK，提醒「没有标出当前学期」 |
| summer-term 开学 5 月 3 日 | OK，夏令节次时间 |
| cross-season 9 月开学到次年 1 月 | OK，「跨两段」提醒 |
| no-start 没有开学日 | OK，「没有给出开学日期」提醒 |
| login-page 密码框 / 统一认证路径 | OK，报「信息门户」提示，**零请求** |
| portal 其它主机 | OK，报提示，**零请求** |
| expired 401 | OK，报「登录状态已失效」 |
| redirect-login 302 到登录页 | OK，报「连不上教务系统」（见下方说明） |
| get-data-empty 没有排课 | OK，报「还没有排课」 |
| datum-500 | OK，报「教务系统返回错误（代码 500）」 |
| empty 排课明细为空 | OK，解析报「没有返回任何排课记录」 |

冒烟里 `redirect-login` 的期望是「教务系统响应太慢」：Playwright 的 `route.fulfill` 回的 302 不会被浏览器跟随，`fetch` 一直不结束，走的是 8 秒上限分支（上一轮这一场景走的是网络失败分支，「连不上」）。「跟随到登录页 200 → 登录已失效」这一支由 Node 桩跑验证（见 §6）。

## 6. 桩跑（extract.js 在 Node 里，假 window / document / fetch，不联网）

- 正常（地址带 `?semesterId=1001`）：请求 `GET /student/for-std/course-table?semesterId=1001` → `GET .../get-data?bizTypeId=2&semesterId=1001` → `POST .../datum`，请求体 `{"lessonIds":[11],"studentId":null,"stdPersonId":88123,"weekIndex":null}`。取数结果无泄漏。
- 页面切过学期（实时下拉框值 1000，服务端默认 1001）：`semesterId=1000`，`pickedBy: page`。
- 登录页（密码框）、`/student/sso/login`、门户主机：同步报错，**0 个请求**。
- datum 500：报错，请求 3 次（到 datum 为止）。
- 302 跟随到 `/student/login/`（桩里 `response.url` 改成登录路径）：报「登录状态已失效」。
- get-data 返回空 `lessonIds`：报「还没有排课」。
- 本校 WebVPN 前缀：本适配器不做（上游没有 WebVPN 分支，`allowHosts` 只写直连主机）。

未测：`DOMParser` 不存在时的正则退路（`semestersFromHtml` 的第二段）。冒烟运行在 Chromium 里，走的是 DOMParser 那一段。

## 7. 变异测试（在临时副本上改 `parse.js` 一处，跑 `check.js`，真目录未动）

| 改坏的地方 | 变红的用例 | 结果 |
|---|---|---|
| M1 季节判断：9 月从夏令改成冬令（`refMonth <= 9` → `<= 8`） | `cross` | FAIL (2) → 还原 |
| M2 每周起始日：去掉周日起算分支（`sundayFirst ? day - (wd % 7) : …` → 固定周一） | `no-start` | FAIL (2) → 还原 |
| 【B1】分组键去掉教师（`rowTeacher || ''` 从 groupKey 移除） | `teacher-split` | FAIL (1) → 还原 |
| 【B2】不裁第 30 周以后的周（`if (slot.weeks[kw] <= MAX_WEEKS)` 改成恒真） | `weeks-trim` | FAIL (1) → 还原 |
| 【B3】超时提醒文字被换掉（`SLOW_TEXT` 改成「网络慢」） | 冒烟 `datum-hang`（用例 FAIL：报错不符）→ 还原 |
| M3 溢出汇总：「另有 N 条」的 N 少算一条（`MAX_WARNINGS - 1` → `MAX_WARNINGS`） | 无夹具覆盖（溢出在自然输入下到不了，见下「溢出注入验证」） | 未变红，**这一处不计入变异通过** |
| M4 不公开的课：去掉 `flag !== 'publish'` 判断 | `dirty` | FAIL (2) → 还原 |
| M5 节次对齐：去掉「首末节必须对齐」的判断（`exact = false` 那一行） | `summer` | FAIL (2) → 还原 |
| M6 占位词：教师不再过占位词表（`placeholderOut` → `text`） | `basic`、`dirty` | FAIL (3) → 还原 |

8 处变红（M1、M2、M4、M5、M6、B1、B2、B3），M3 未变红（见上）；每次还原后真目录 `check.js` 为 `RESULT: PASS`。

**溢出注入验证**（不留夹具）：在临时副本的 `parse.js` 收尾前注入 25 条提醒，用 `dirty` 的输入跑 RhinoRun：总提醒 30 条（5 + 25），输出 20 条：前 19 条原样，第 20 条为「另有 11 条提醒没有显示，请到教务页面核对原课表。」，11 = 30 − 19，计数正确。

## 8. 与审计真抓到过的错逐条自查

- 按日期推算学期的月份边界：本适配器不按日期推周次；季节边界（5 月 1 日、10 月 1 日）与学期跨段判断用的是整数月份与切换日，不经过时区（`dayOf` 只用 `Date.UTC`）。
- 逐周请求的重复记录：排课明细按 `(课程, 星期, 开始, 结束, 教室)` 分组，同一周重复的周次只留一份（`dirty` 与 `basic` 有重复行）。
- 退回默认值时提醒要说实话：`pickedBy: first` 与开学日回退都有各自的提醒，文字说的是实际用了什么。
- 拼进提醒的教务原文截 20 字：学期名、课名、未排课的课名、不公开的课名、时段涉及的课名都经过 `clipName`。
- 教师括号备注不拆成两位教师：`cleanName` 剥掉括号。
- 正则补分隔符：本适配器不做这类拼接。
- 给学生看的文字不写「作息」，统一「节次时间」（提醒与报错中无「作息」）。
- 提醒里让学生去补教师 / 教室：写「在「编辑课程」里补上」，没有写「学期管理」。
- 带课名的提醒限长：课名截 20 字，整条 ≤200 字（`long-warn` 钉住）。
- 只给课名限长不够：所有拼进提醒的教务原文都截短，硬截断是最后保险。
- 无逗号前置单双标记：本适配器的周次是数字 `weekIndex`，不解析周次文字，不适用。
- 连堂合并：同一课、同一星期、同一段节次的周次合并成一个 `slot`，按 `weekIndex` 去重后再切段。
- 计数提醒按课程去重：缺教师、缺教室、不公开的课都按课程计数。
- `warn()` 满 20 条：`pushWarning` 先全部收下（去重），输出时只留前 19 条加一条汇总，N 等于没显示的条数（注入验证过，见 §7；自然输入到不了，不留夹具）。
- `scheduleUrlHint` 是课表页完整地址（见 `manifest.json`），大白话提示放在报错里。
- 同一份数据的外壳只定义一次：`semestersFromHtml`、`sanitizeSchedules` 各一处，`extract.js` 内没有第二处判断。
- 登录页与容器兜底：登录页判断在任何请求之前做，地址与密码框都看。
- 两种失败原因分开说：HTTP 错误、非 JSON、结构不对、登录失效都各有文字（§1 表格）。

## 8a. weekIndices 的来源（主调度要求的核对）

上游 `cwnu.js` 的 `fetchGetData` 直接取 `get-data` 响应的 `weekIndices`（不经过课程），请求只带 `semesterId`，与 `lessonIds` 同一次返回。`totalWeeks(weekIndices, courses)` 只在 `weekIndices` 为空时才回退到课程的最大周。因此上游把它当学期级周列表用，而不是由课程上课周汇出（课程上课周在 `scheduleList` 里，不在这里）。这是从代码结构推出的，**响应结构未在真机上看过**，所以这一点列为风险（§10 第 2 条）。

## 9. 与上游的其它差异（不是为了「修」上游）

- 上游的 `totalWeeks` 优先取 `weekIndices` 的最大值（没有时取课程最大周，再没有取 20）；这里改成校历优先（§4 第 5 条）。
- 上游的 `MIN_WEEKS = 16` 下限会把短学期（如夏季学期）抬到 16 周；这里不抬，按校历导入（任务卡要求）。
- 上游的 `firstDay` 不做对齐（只写 `semesterStartDate` 与 `firstDayOfWeek`）；这里按 §4.3 对齐。
- 上游 `convertCourses` 把两套节次表都当作匹配依据；这里只用一套（载荷限制）。
- 上游的分组键是「课名 | 教师 | 教室 | 星期 | 起止时间」；这里用「课程 id + 教师」做课程键，同名不同课不会被合并，同课不同教师分成两条。

## 10. 已知风险与未验证项

1. **真机未验证**。没有本校账号；页面结构（`var semesters`、`stdPersonId`、`lessonId2Flag` 的值）是按上游代码读的，没在真实页面上见过。
2. **`weekIndices` 当校历周数**（没有结束日时）。依据有限，未经真机确认：见下方「weekIndices 的来源」。若它其实是课表涉及的周次，总周数会偏小，但课表里有更晚的周次会抬高并提醒。
3. **季节节次只能导入一套**。学期跨夏令、冬令两段时，后半段的节次时间会错位半小时左右（夏令的下午与晚上比冬令晚半小时）；已经按节次「最接近」放入并提醒。要真正按日期切换，需要载荷支持多套节次时间，这是应用侧的改动，不在本适配器范围。
4. **切换日与学期名**：切换日按学校公布的 5 月 1 日与 10 月 1 日推算（与上游写死的表一致），学校实际切换日若不同，提醒会说错。
5. **`redirect-login` 只在桩里验证了「跟随到登录页」那一支**；真实的登录过期在 WebView 里可能表现为跳到门户页，门户主机判断会先拦下，也会给出提示。
6. **超时是 8 秒、每个请求各一次**（`withLimit`，含读正文）。超时报「教务系统响应太慢，请稍后再试。」。CWNU 的三个请求（页面、get-data、datum）都是必需的，**没有可选请求可以回落**：semester 起止日期来自页面里的 `var semesters`，不另发请求。所以超时直接失败，不做回落。超时后 fetch 不会被取消，只是结果被丢弃。
7. **`stdPersonId` 解析失败时请求体里是 `null`**，与上游一致；若本校改了页面脚本的写法，datum 可能返回空结果，会报「课表数据不完整」。
8. **`DOMParser` 退路未测**（见 §6）。
9. **溢出路径无夹具**：自然输入下提醒种类有限，超过 20 条到不了，只做了注入验证（§7）。

## 11. 签名

0x7E7-2023（haiku 移植，2026-11-24）
