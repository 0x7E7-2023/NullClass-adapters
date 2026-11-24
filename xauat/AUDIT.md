# 西安建筑科技大学（`xauat`）适配器 —— 安全审计

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) → `resources/XAUAT/xauat.js`（MIT）。同目录 `adapters.yaml` 的 maintainer 是 `Alph4rc,ZionPu` |
| 上游快照 | `f83288e`（2026-11-24）。本校脚本最后一次修改 `893854b`（2026-11-20，PR #941「修复周次和作息导入并精简适配脚本」，作者 ZionPu）；1.0.0 移植时的快照是 `baf83fa`（上一版的 `fc7a863` 为脚本更早的提交） |
| 上游平台 | 树维学生端 for-std，`swjw.xauat.edu.cn`。与已移植的 `dlut` / `cupk` 同平台，但本校按**具体日期**给排课，不是 print-data 的 `weekday + weekIndex` |
| 本适配器 | `jw-adapters/xauat/`。`extract.js` 只取数，`parse.js` 纯转换。当前版本 **1.0.1** |
| 移植者 | 0x7E7-2023（haiku 移植，2026-11-09；1.0.1 跟进上游，2026-11-24） |
| 结论 | **安全性通过**（§2）。**正确性未在真机验证**：没有本校账号，夹具与浏览器冒烟都是合成的 |

模板按任务卡用 **cupk**（同为 for-std，目录骨架、提醒写法、载荷输送一致）。取数结构上最近的是 **dlut**（同平台的 `lessonList` + `scheduleList` datum，以及 `timetable-layout` 作息表），`extract.js` 的分期、去拾光桥、字段白名单与 `parse.js` 的节次映射（包含优先、最近一节）都照 dlut 已审计过的写法改。1.0.1 起请求作息表（本校上游 `893854b` 起也请求它）。

## 1. 请求清单

只在已经打开本校课表、且当前页不是登录页时发请求。主机只有 `swjw.xauat.edu.cn`，全部用同源相对路径。

| # | 方法 | 地址 | 干什么 | 拿不到时 |
|---|---|---|---|---|
| 1 | GET | `/student/for-std/course-table` | 读 `#semesters` / `#allSemesters` 的学期列表；`DOMParser` 解析成独立文档，不插进当前页面（`semestersFromHtml`） | 报错，请学生先打开课表页。不猜学期 |
| 2 | GET | `/student/for-std/course-table/get-data?bizTypeId=2&semesterId={id}&dataId=` | 本学期的 `lessonIds`，以及作息表号 `timeTableLayoutId`。`bizTypeId=2`（本科）与空 `dataId` 是本校接口约定 | 报错；`lessonIds` 为空时报「这个学期还没有排课」，不换学期 |
| 3 | POST | `/student/ws/schedule-table/datum` | 请求体 `{studentId:"null", lessonIds:[…]}`（`postJson` 调用），取 `result.lessonList` + `result.scheduleList`。`studentId` 传字符串 `"null"` 是接口约定，照上游保留 | 报错 |
| 4 | GET | `/student/ws/semester/get/{id}` | 开学日、结束日、`weekStartOnSunday`（每周是否从周日开始） | `optionalOf` 交 `null`，不阻断；`parse.js` 用排课最早日期推算并写进提醒，每周按周一 |
| 5 | POST | `/student/ws/schedule-table/timetable-layout` | 请求体 `{timeTableLayoutId: N}`，N 是 #2 给的正整数；取 `result.courseUnitList`（节次号与起止时间）。**只在 #2 给了正整数表号时才发**（`extract.js` 的 `layoutPromise`） | `optionalOf` 交 `null`，`parse.js` 回落到按课表里实际出现的开始时间推导节次，并写进提醒 |

登录页（密码框且没有学期下拉，或地址带 `/login`、`/cas`、`/authserver`）和别的主机：直接提示，**不发请求**（`isLoginPage`、`hostnameOf`）。不读密码框的值。

`manifest.loginUrl` 是登录页，`scheduleUrlHint` 是课表页完整地址 `https://swjw.xauat.edu.cn/student/for-std/course-table`。`allowHosts` 只写 `swjw.xauat.edu.cn`，无通配。上游没有请求别的主机。

## 2. 移植手册 §5 八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读密码框、Cookie、本地存储；只用已登录页面的同源会话 |
| 2 | 不外发 | 通过。只有上面 3 个 GET + 2 个 POST，全部同源；无上报、无外链 |
| 3 | 请求域可控 | 通过。主机只有 `swjw.xauat.edu.cn`；`allowHosts` 精确主机名 |
| 4 | 只读课表 | 通过。不请求成绩、学籍、缴费、选课。`lessonList` 只留 `id`/`courseName`/教师名，`scheduleList` 只留课表字段，学期接口只留起止日期与周起始标记，作息表只留节次号与起止时间；响应夹带的学号/姓名/证件号一律不带出（`sanitizeLessons`、`sanitizeSchedules`、`sanitizeMeta`、`sanitizeUnits`） |
| 5 | 不埋点 | 通过 |
| 6 | 不 eval | 通过。无 `eval`、`new Function` |
| 7 | 不写页面 | 通过。`DOMParser` 只解析取回的 HTML 字符串，不插 DOM |
| 8 | 不硬编码秘密 | 通过。无学号、无密钥 |

没有提问桥（`__ncSelect` 等）。上游的确认弹窗、选学期弹窗、拾光 toast / 存课 / 完成通知都没搬。

## 3. 读了什么、交出去什么

`extract.js` 交出去：

- `term`（`id` / `label` / `pickedBy`）、`semesters`（`id` / `label` / `selected`）；
- `semesterMeta`（`startDate` / `endDate` / `weekStartOnSunday`，可 null）；
- `lessonList`（`id` / `courseName` / `teacherNames`，教师名只留 `name`）；
- `scheduleList`（`lessonId` / `date` / `weekIndex` / `startTime` / `endTime` / `personName` / `room` / `customPlace`，`room` 对象只取 `nameZh`）；
- `courseUnitList`（`indexNo` / `startTime` / `endTime`，取不到为 null）。

`parse.js` 另接受夹具专用 `today`（只为钉住「没有开学日也没有排课日期」时的推算，extract 不传）。

教师写成 null 的情况：空、`未知`、`暂无`、`待定`、`无`，以及「未知教师」「暂无老师」这类占位词；教师名后面的括号备注（「李某（外聘）」）剥掉。课程名单里的教师名同样处理，且只在排课上没写教师时才用。教室同理，外加「未知地点」；教室是占位词时改用 `customPlace`（自定义地点）。

## 4. 与模板（cupk）和上游的差异

1. **日期换周次**：`scheduleList` 每条带 `date`，周次以 `weekIndex` 为准（1.0.1 起）；与日期算出的周次对不上的计数进提醒（`parse.js` 排课循环）。星期由日期取。
2. **每周起始日**（1.0.1 起）：学期接口 `weekStartOnSunday` 为真时以周日为一周第一天，否则周一。开学日先回退到当周起始日作为 `firstDay`（`weekStartOf`）。
3. **跨学期丢弃并计数**：先按日期算的周次判断，开学日之前（< 1 周）计入 `beforeStart`，第 25 周之后（可能是别的学期）计入 `tooLate`，都跳过并写进提醒。`weekIndex` 超过 25 周也计入 `tooLate`。
4. **节次时间**（1.0.1 起）：有可用作息表时用它。作息表逐行检查：节次号 < 1（如 0 号休息行）、时间读不出、开始不早于结束的行跳过；节次号 ≥ 1 的跳过行计数进提醒，其余合法节次照常用。合法节次号须从 1 连续，否则整张不用。起始节 = 开始时间落在某节 `[start, end]` 内的那节，落不进就取开始时间最接近的一节（差 ≤ 60 分钟）；结束节同理按结束时间取。两端都要找到且起 ≤ 止，否则跳过并点名提醒。首尾没有正好对齐节次边界的课计数提醒（「有 N 门课的上课时间与节次时间对不上，已按最接近的节次放入」）。作息表缺失或合法节次为空时，回落到按课表里实际出现的开始时间排节次（同一开始时间算一节，下课取最晚，有出入的计数进提醒），并说明是推导的（`nodeOf` / `sectionsOf`）。
5. **同一格多间教室**（1.0.1 起）：同一课、同一天、同一时间、同一周的多间教室并排写成 `A101/A102`，并在提醒里点名（上游是同样合并，只是用弹窗提示）。
6. **分组带教室、同课合并**：分组键多了教室这一维，同一时段两间教室（不同周）的排课不会被合并掉一间；同一课的教师并列写在一门课里（上游按教师再拆门，这里不拆）。
7. **教师回落**（1.0.1 起）：排课上没有教师（或占位词）时回落到课程名单的教师名（上游 `teacherAssignmentList` 同款）。
8. **地点回落**（1.0.1 起）：教室为空或占位词时用 `customPlace`（上游 `readPosition` 同款）。
9. **去重**：逐日/逐页拿回的同一条记录按 `(课程, 日期, 开始, 结束, 教师, 教室)` 先去重再统计，免得提醒里的条数被放大。上游没有去重。
10. **总周数**：校历优先；没有校历用 20；课表更晚才抬高；上下限 16~25 周，动了就提醒。上游是「课程最大周次优先、`clampWeeks` 静默截到 16~25」，会低估没有课的学期长度，也不告诉学生。
11. **不弹窗选学期**：取 URL 里的学期号 > 下拉框 `selected` > 第一项；凭什么选的写进提醒（`pickSemester`，parse.js 的 `term.pickedBy`）。

## 5. 上游里删掉或改掉的

- 选学期弹窗 `showSingleSelection`、确认弹窗、无课学期反复重选、「多个教室」弹窗：已登录就取当前学期，取不到就报错让用户切学期；多教室改成提醒。
- 拾光桥 `saveCourseConfig` / `savePresetTimeSlots` / `saveImportedCourses` / `notifyTaskCompletion`：改为交载荷。
- `未知课程` / `未知教师` / `未知地点` 占位词：一律 null。
- `uniqueSortedWeeks` 静默丢超界周次：改为计数进提醒。
- `isCustomTime` 自定义时间：载荷没有这个字段（移植手册 §4.4），不能照搬（见 §9）。
- `padStart`、`Map`、`Set`、`async/await`、`Array.from`、`Array.prototype.fill`、`log` 开关：降到 ES5（对象、数组、Promise 链）。
- 上游 `deriveSemesterStartDate` 与「学期接口取不到就中止」：我们保留排课日期回退，但写进提醒（见 §9）。

## 6. 本校边界（夹具）

共 18 对，期望按规范和代码逻辑手推，不是把 `parse.js` 输出存下来。1.0.0 的 10 对 `parse.js` 输出在 1.0.1 改动前后逐字节一致（差分测试，见 §9）。1.0.1 第二轮（B1、B2）只改了 `layout-approx-drop` 的提醒文字，其余输出不变。

| 夹具 | 覆盖 |
|---|---|
| basic | 日期 → 周次与星期、完全重复行去重、ALL / ODD（隔周日期）/ EVEN、名单里有但没排课的课、`未知`教师与`待定`教室转 null、多个学期只导当前 |
| no-start | 学期接口没给开学日，按最早排课日期（周三 → 当周周一）推算并提醒；无校历按 20 周 |
| cross-semester | 开学前的日期、第 25 周之后的日期都跳过并计数；校历 19 周 |
| long-warn | 三门超长课名、教师缺失：课名截 20 字，整条提醒 99 字（< 200） |
| raise-default | 无校历、课表排到第 22 周：从 20 抬到 22 并提醒 |
| over-calendar | 校历 16 周、课表排到第 18 周：抬到 18 并提醒 |
| dirty | 没标当前学期、缺课程/坏日期/坏时间各 1 条、同一开始时间下课时间不一致、没排课的课、`未知`/`待定` 转 null、`李某（外聘）` 只取「李某」 |
| calendar-short | 校历只数出 7 周，按 16 周下限导入并提醒 |
| calendar-long | 校历跨 30 周，按 25 周上限导入并提醒 |
| counters | 重复记录先去重再计数，同一开始时间三种下课时间只计 1 个开始时间 |
| layout-grid（1.0.1） | 有作息表：08:00-09:40 占第 1-2 节，10:00-10:45 占第 3 节；周次 1~3 与 `weekIndex` 一致 |
| layout-approx-drop（1.0.1） | 课时段 10:05-10:40 落在第 3 节内但首尾未对齐，计数提醒「1 门课对不上」；23:00-23:50 离所有节次超过 60 分钟，跳过并点名 |
| sunday-first（1.0.1） | `weekStartOnSunday` 为真，开学日是周日：周一 09-07 是第 1 周，周日 09-13 是第 2 周；无「对齐到周一」提醒 |
| rooms-merge（1.0.1） | 同一周同一时间两间教室：写成 `A101/A102` 并提醒；另一周只有 `A101`，分开导入 |
| weekindex-mismatch（1.0.1） | 09-21 日期算出第 3 周、教务 `weekIndex` 为 4：按 4 周导入并提醒；与日期一致的 09-28 不提醒 |
| lesson-fallback（1.0.1） | 排课教师为 null / 「未知」时回落到课程名单（「赵六（主讲）」→「赵六」，占位词不取）；教室为 null 时用 `customPlace` 「操场」；无教室的课点名提醒 |
| layout-edge（1.0.1） | 首尾不对齐：08:05-09:40 起节 1、止节 2；08:00-09:35 起节 1、止节 2（不再只得一节）；计数提醒「2 门课对不上」 |
| layout-skip-row（1.0.1） | 作息表含 0 号休息行与 5 号「开始晚于结束」的坏行：0 号不计提醒，5 号跳过并提醒「第 5 节读不出」，1~4 节照常用 |

## 7. 变异测试

在 `parse.js` 上改坏再还原，自检必须先 DIFF 再 PASS。

### 7.1 1.0.0 的三处

1. 日期换算去掉 `+ 1`（`parse.js` 排课循环的 `week = Math.floor(...) + 1`）→ basic / no-start / cross-semester / raise-default / over-calendar 变红，long-warn / dirty 直接报错。
2. `raised = maxWeek > totalWeeks` 改成 `false`（总周数段）→ raise-default、over-calendar 变红。
3. `placeholder` 不再把「未知」当空 → basic、dirty 变红（「未知」被当成教师名交出去）。

三处都已还原。

### 7.2 1.0.1 的五处（2026-11-24，在临时副本上改，不动正式文件）

| 改坏哪一处 | 哪条用例变红 |
|---|---|
| `sectionsOf`：去掉「最近一节（≤60 分钟）」分支 | `layout-approx-drop` |
| `weekStartOf`：忽略 `weekStartDow`，一律按周一 | `sunday-first` |
| 同格多教室：只取第一间（`cellPlace = cl.rooms[0]`） | `rooms-merge` |
| 周次：忽略 `weekIndex`（`week = wIdx` 改成不变） | `weekindex-mismatch` |
| 格的教师：去掉课程名单回落（`cellTeachers = cl.teachers`） | `lesson-fallback` |
| 起止对齐判断：永远视为对齐（`aligned = true`） | `layout-edge`（另 `layout-approx-drop` 同样变红） |
| 作息表跳过：不记录跳过的节次号（`layoutSkipped` 不入列） | `layout-skip-row` |

五处都已还原，`check.js` 最终 `RESULT: PASS`。1.0.1 第二轮又加两处（最后两行），同样在临时副本上做、已还原。

## 7.3 2026-11-10 复审修正

| 编号 | 问题 | 修正 | 捕获方式 |
|---|---|---|---|
| R1 | 低周数提醒里报的是「抬高后」的周数，却写成「学期起止日期只能数出 N 周」，与上一条抬高提醒自相矛盾 | 改报「按教务数据算出的学期总周数」（抬高后的真实值），措辞不再假设一定有校历；高周数提醒同步 | 新用例 `counters`；把值换回 `calendarWeeks` 即 DIFF |
| R2 | 所有排课都被跨学期规则丢掉时，报错只说「读不出课程、日期或上课时间」，不写真实原因 | 报错里按原因分项计数（对不上名单 / 日期读不出 / 上课时间读不出 / 日期在开学日之前 / 超出学期末） | 冒烟场景 `all-before-start`（`expect_parse_fail`） |
| R3 | 「下课时间前后不一致」按行数计，文案却说「N 个开始时间」 | 按不同的开始时间计数 | `counters` 里同一个开始时间三种下课时间 → 提醒仍写 1 个；改回按行数即 DIFF |
| R4 | 内容去重放在各类跳过计数之后，重复行会放大提醒条数（与代码注释相反） | 去重挪到最前面：先按原始字段去重，再计数、再解析 | `counters` 里重复的「待定」行只算 1 条；删掉提前的去重即 DIFF |
| R5 | AUDIT 署名笔误 `0x7E-2023` | 改为 `0x7E7-2023`，与 manifest 一致 | 与 manifest 对照 |

## 8. 没验的部分与风险

- **没有本校账号**，真机没跑过。`date` / `weekIndex` / `startTime` / `endTime` / `personName` / `room.nameZh` / `customPlace` / `teacherAssignmentList` / `courseUnitList`、`timeTableLayoutId` 的字段名与接口路径都来自上游代码，若教务改版，缺字段会进提醒或报错，不会静默交出错课表。
- **作息表请求是尽力而为**：它与 datum 并发，它的登录失效会被吞掉（`optionalOf`），登录失效的报错由 datum 那一路给出。
- **作息表的重叠没有校验**：上游会因「节次时间重叠」中止；这里只校验节次连续与每节合法，重叠的作息表会照常使用，课时段仍按「包含 / 最近」映射。
- **「最近一节、差 ≤ 60 分钟」是我们的近似**，上游是把这类课保留为自定义时间。学生看到的是近似节次 + 提醒，不是真实时段。
- **周次以 `weekIndex` 为准**：若学校的周次编号与开学日推算不一致，导入的是学校编号，并计数提醒。
- **节次时间由作息表（有时）或排课数据推导（无时）**：推导时和学校公布的节次表可能不是一比一，提醒里写明了来源。
- 上游按「最早一节课在第 1 周」推算开学日的回退，仍保留在没有开学日时；提醒里写明是推算值。
- 浏览器冒烟（`.test/port-batch38/xauat/smoke.py`，本机 Playwright 无自带 chromium，退回系统 Edge）覆盖 16 个场景，见 §9.4。全部 OK，不联网。
- `minAppVersionCode` 为 11。输出仍是 `kind:"schedule"`。

## 9. 1.0.1 跟进上游（2026-11-24）

上游改动：`893854b`（PR #941，作者 ZionPu）改了 `XAUAT/xauat.js` 约 +317/−244 行，并把 `adapters.yaml` 的 maintainer 改为 `Alph4rc,ZionPu`。我们的 1.0.0 是对 `baf83fa` 的移植。

### 9.1 上游每条改动：跟 / 不跟

| # | 上游改动 | 1.0.0 的行为 | 结论 |
|---|---|---|---|
| 1 | 每周起始日取 `weekStartOnSunday`（周日开头则 `firstDayOfWeek=7`） | 固定周一 | **跟**：`weekStartOf` 按 `weekStartDow`；周一路径的输出不变 |
| 2 | 周次直接采用记录的 `weekIndex`，与开学日算出的不一致就**中止**整次导入 | 只按日期算周次 | **跟，但不中止**：采用 `weekIndex`，不一致的计数进提醒。中止会让整次导入失败，与「不许静默丢课」的原则冲突；跨学期仍按日期判定 |
| 3 | 星期字段与日期不一致就中止 | 星期只取日期 | **不跟**：以日期为准（同一条记录里日期是权威字段），不读 `weekday`。这一点是我们没有的校验，记在 §8 |
| 4 | 作息表：`timetable-layout`，表号取自 `get-data.timeTableLayoutId` | 无作息表，按课表推导节次 | **跟**：`extract.js` 的 `layoutPromise`；`parse.js` 用 `layoutOk` / `sectionsOf` |
| 5 | 作息表校验：节次从 1 连续、不重叠，否则整张不用 | — | **部分跟**：连续与每节合法校验照跟；**重叠不校验**（§8） |
| 6 | 作息取不到时回落到课程自带时间（`isCustomTime`） | 按课表推导节次 | **不跟**：载荷没有自定义时间（移植手册 §4.4）。回落仍是按课表推导 + 提醒 |
| 7 | 不在节次网格内的课保留真实起止（`isCustomTime`） | 按开始时间推导 | **不跟**：按移植手册 §4.4，最近一节（≤ 60 分钟，近似提醒），否则跳过并点名 |
| 8 | 同一周同一时间多间教室合并为 `A/B`，弹窗提示 | 按教室分组，同时段会出现重叠的两个块 | **跟**：`cellPlace` 并排写出，`parallelNames` 进提醒（弹窗不搬） |
| 9 | 教师缺时回落到 `lesson.teacherAssignmentList` | 缺教师就是 null | **跟**：`lessonTeachers`，占位词与括号备注同样清理 |
| 10 | 地点缺时回落到 `customPlace` | 缺地点就是 null | **跟**：`cleanPlace(s.room) \|\| cleanPlace(s.customPlace)` |
| 11 | 分组键含教师，同课不同教师拆成多门 | 同课合并，教师并列 | **不跟**：我们的写法对学生更直观（`courses` 一门课一个 `teacher` 字符串）；1.0.0 已是这样 |
| 12 | 学期接口取不到开学日就中止（`fetchSemester` 必需） | 取不到就用排课日期推算并提醒 | **不跟**：公共说明「拿不准进 warnings」；保留推算 + 提醒，不丢整次导入 |
| 13 | 删去「由最早排课日期反推开学日」 | 有（作为回退，且提醒） | **不跟**：同上，回退保留并提醒 |
| 14 | 周次 `< 1` 静默丢弃 | 计数进提醒 | **不跟**（我们已更好） |
| 15 | 总周数：课程最大周次优先，限 16~60，超出中止 | 校历优先，16~25，动了就提醒 | **不跟**：校历优先与提醒是 1.0.0 的设计；载荷上限是 25 |
| 16 | 「未知课程」「未知教师」占位词 | null | **不跟**（1.0.0 已 null） |
| 17 | `isLoginResponse`：响应落在登录页就判登录失效 | 401/403 与 JSON 解析失败给登录提示 | **不跟**：重定向到登录页时，JSON 接口会解析失败并给出同一句登录提示；课表页（HTML）会报「没能在教务页面读到学期列表」，两者都指向重新登录 |
| 18 | 拾光 toast / saveConfig / saveCourses / 完成通知 / 选学期弹窗 / 确认弹窗 | 已删 | **不跟**（公共说明：只交载荷） |
| 19 | 日志开关、`Map` / `Set` / `padStart` / `async` 等 | 降到 ES5 | **不跟**（精简本身不用跟） |
| 20 | 考试安排 / 考表导入 | 无 | **无需跟**：本次上游 `xauat.js` 未新增考试相关代码（已通读确认），空课规范也没有考试载荷 |
| 21 | maintainer 改为 `Alph4rc,ZionPu` | `Alph4rc` | **跟**：`manifest.author` 与文件头署名补上 ZionPu |

### 9.2 差分测试：改动前后的 `parse.js` 输出

改动前把 10 个已有夹具与新造输入跑一遍存在临时目录，改动后再跑：

- **10 个 1.0.0 夹具的输出一字不差**（`basic` … `counters`，共 10 个，逐字节比较）。没有有意改变的已有输出。
- 新增 6 对夹具（第一轮）的输入，用 1.0.0 的 `parse.js` 再跑一遍，与新结果对照（**旧结果 → 新结果，依据上游哪段代码**）：

| 夹具 | 旧结果（1.0.0 代码） | 新结果（1.0.1） | 依据 |
|---|---|---|---|
| layout-grid | 按开始时间推导两节：`08:00-09:40` 与 `10:00-10:45` 各占一节；周一课占第 1 节（周次 1~3），周三课占第 2 节 | 教务作息表：周一课占第 1-2 节，周三课占第 3 节；周次不变 | 上游 `fetchTimeSlots` / `convertCourses` 的 `unitByStart` / `unitByEnd` |
| layout-approx-drop | 推导出 3 节（含 `23:00-23:50` 当第 3 节）；`选修课` 被导入 | 作息表 4 节；`大学英语` 近似放入第 3 节并提醒；`选修课` 跳过并点名 | 移植手册 §4.4；上游 `convertCourses` 的 `isCustomTime` 分支 |
| sunday-first | 开学日 `09-06`（周日）被对齐到周一 `08-31`；周一 09-07 落在第 2 周，还有「对齐到周一」提醒 | `firstDay` 为 `09-06`；周一 09-07 是第 1 周，周日 09-13 是第 2 周；无对齐提醒 | 上游 `fetchSemester`（`weekStartOnSunday`）与 `weekStartOf` |
| rooms-merge | 同一周同一时间两块（`A101` 与 `A102`，都在第 1 周）互相重叠 | 第 1 周一块 `A101/A102`，第 2 周 `A101`；提醒点名 | 上游 `convertCourses` 的 `rooms` 合并与 `parallel` |
| weekindex-mismatch | 按日期算 09-21 为第 3 周，与第 1 周合成单周段（单周 1、3 周）；第 4 周另一段 | 第 1 周一段、第 4 周一段；提醒「周次对不上」 | 上游 `convertCourses` 的 `weekIndex` 采用 |
| lesson-fallback | 两门课教师为空、`体育` 的地点丢成 null（操场没用上），并提醒 2 门课没教师、2 门课没教室 | 教师回落为 `王五` / `赵六`，`体育` 地点为 `操场`；只提醒 1 门课没教室 | 上游 `teacherAssignmentList` 回落与 `readPosition` 的 `customPlace` |

### 9.3 变异测试

见 §7.2（五处，全部变红并已还原）。

### 9.4 验证结果

- 自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/xauat` → `RESULT: PASS`，18 对夹具全部 MATCH。
- 冒烟：`python -I -X utf8 D:/NullClass/.test/port-batch38/xauat/smoke.py all` → **16/16 OK**。新增场景：`no-layout`（没有表号时不请求作息表，回落并提醒）、`layout-500`（作息表 500 时回落并提醒）、`sunday-first`（周日起始，无对齐提醒）。`normal` 现在校验作息表请求体 `{"timeTableLayoutId":77}` 与第 1-2 节。
- 扫描：`parse.js` 与 `extract.js` 中无箭头函数、反引号、`let`/`const`、`for…of`、`Set`/`Map`、`padStart`、`Array.from`、`includes`/`startsWith`、可选链、`??`（ES5 检查通过）。

### 9.5 清单

- `extract.js`：请求作息表（条件发）；学期接口多取 `weekStartOnSunday`；排课明细多取 `weekIndex` / `customPlace`；课程名单多取教师名；`sanitizeUnits` 新增。
- `parse.js`：`weekStartOf` / `weekStartDow`；周次采用 `weekIndex`；节次 `layoutOk` / `sectionsOf`；一格（`cells`）合并多教室、回落教师；新增提醒（周次不一致、课时段跳过、近似、并排教室、节次格式不对）。
- `manifest.json`：`version` `1.0.1`；`author` 补 ZionPu；fixtures 新增 8 对（第二轮 B1、B2 各 1 对）。
- 文件头：上游快照改为 `f83288e`，「移植改动」与本节对得上。

0x7E7-2023（haiku 移植，2026-11-09；1.0.1 跟进上游，2026-11-24）
