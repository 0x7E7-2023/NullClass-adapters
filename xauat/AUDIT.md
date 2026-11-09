# 西安建筑科技大学（`xauat`）适配器 —— 安全审计

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) → `resources/XAUAT/xauat.js`（MIT）。同目录 `adapters.yaml` 的 maintainer 是 Alph4rc |
| 上游快照 | `baf83fa`（2026-11-09，已与 origin/main 对齐）。`git log -1` 核对 `xauat.js` 最后提交为 `fc7a863`（2026-09-09），任务卡未写具体哈希，与快照一致 |
| 上游平台 | 树维学生端 for-std，`swjw.xauat.edu.cn`。与已移植的 `dlut` / `cupk` 同平台，但本校按**具体日期**给排课，不是 print-data 的 `weekday + weekIndex` |
| 本适配器 | `jw-adapters/xauat/`。`extract.js` 只取数，`parse.js` 纯转换 |
| 移植者 | 0x7E7-2023（haiku 移植，2026-11-09） |
| 结论 | **安全性通过**（§2）。**正确性未在真机验证**：没有本校账号，夹具与浏览器冒烟都是合成的 |

模板按任务卡用 **cupk**（同为 for-std，目录骨架、提醒写法、载荷输送一致）。取数结构上最近的是 **dlut**（同平台的 `lessonList` + `scheduleList` datum），`extract.js` 的分期、去拾光桥、字段白名单与 `parse.js` 的日期换算、极值段切分都照 dlut 已审计过的写法改，没有照搬它的 `timetable-layout` 请求（本校上游不请求它，任务卡也只列了四个接口）。

## 1. 请求清单

只在已经打开本校课表、且当前页不是登录页时发请求。主机只有 `swjw.xauat.edu.cn`，全部用同源相对路径。

| # | 方法 | 地址 | 干什么 | 拿不到时 |
|---|---|---|---|---|
| 1 | GET | `/student/for-std/course-table` | 读 `#semesters` / `#allSemesters` 的学期列表；`DOMParser` 解析成独立文档，不插进当前页面（extract.js:122、250） | 报错，请学生先打开课表页。不猜学期 |
| 2 | GET | `/student/for-std/course-table/get-data?bizTypeId=2&semesterId={id}&dataId=` | 本学期的 `lessonIds`（extract.js:258）。`bizTypeId=2`（本科）与空 `dataId` 是本校接口约定 | 报错；`lessonIds` 为空时报「这个学期还没有排课」，不换学期 |
| 3 | POST | `/student/ws/schedule-table/datum` | 请求体 `{studentId:"null", lessonIds:[…]}`（extract.js:268），取 `result.lessonList` + `result.scheduleList` | 报错。`studentId` 传字符串 `"null"` 是接口约定，照上游保留 |
| 4 | GET | `/student/ws/semester/get/{id}` | 开学日、结束日（extract.js:269） | `optionalOf` 交 `null`，不阻断；`parse.js` 用排课最早日期推算并写进提醒 |

登录页（密码框且没有学期下拉，或地址带 `/login`、`/cas`、`/authserver`）和别的主机：直接提示，**不发请求**（extract.js:105、243）。不读密码框的值。

`manifest.loginUrl` 是登录页，`scheduleUrlHint` 是课表页完整地址 `https://swjw.xauat.edu.cn/student/for-std/course-table`。`allowHosts` 只写 `swjw.xauat.edu.cn`，无通配。上游没有请求别的主机。

## 2. 移植手册 §5 八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读密码框、Cookie、本地存储；只用已登录页面的同源会话 |
| 2 | 不外发 | 通过。只有上面 3 个 GET + 1 个 POST，全部同源；无上报、无外链 |
| 3 | 请求域可控 | 通过。主机只有 `swjw.xauat.edu.cn`；`allowHosts` 精确主机名 |
| 4 | 只读课表 | 通过。不请求成绩、学籍、缴费、选课。`lessonList` 只留 `id`/`courseName`，`scheduleList` 只留课后六字段，学期接口只留起止日期；响应夹带的学号/姓名/证件号一律不带出（extract.js:202、213、234） |
| 5 | 不埋点 | 通过 |
| 6 | 不 eval | 通过。无 `eval`、`new Function` |
| 7 | 不写页面 | 通过。`DOMParser` 只解析取回的 HTML 字符串，不插 DOM |
| 8 | 不硬编码秘密 | 通过。无学号、无密钥 |

没有提问桥（`__ncSelect` 等）。上游的确认弹窗、选学期弹窗、拾光 toast / 存课 / 完成通知都没搬。

## 3. 读了什么、交出去什么

`extract.js` 交出去：`term`（`id`/`label`/`pickedBy`）、`semesters`（`id`/`label`/`selected`）、`semesterMeta`（`startDate`/`endDate`，可 null）、`lessonList`（`id`/`courseName`）、`scheduleList`（`lessonId`/`date`/`startTime`/`endTime`/`personName`/`room`，`room` 对象只取 `nameZh`）。

`parse.js` 另接受夹具专用 `today`（只为钉住「没有开学日也没有排课日期」时的推算，extract 不传）。

教师写成 null 的情况：空、`未知`、`暂无`、`待定`、`无`，以及「未知教师」「暂无老师」这类占位词；教师名后面的括号备注（「李某（外聘）」）剥掉。教室同理，外加「未知地点」。

## 4. 与模板（cupk）和上游的差异

1. **日期换周次**：本校 `scheduleList` 每条带 `date`，没有 `weekday`/`weekIndex`。`parse.js:295` 按 `floor((日期 - 开学日)/7) + 1` 换算第几周，星期由日期直接取。
2. **跨学期丢弃并计数**：开学日之前（周次 < 1）与第 25 周之后（可能是别的学期）的排课跳过并写进提醒（parse.js:296-303）。
3. **节次时间按实际时间推导**：载荷没有自定义上下课时间（上游用拾光的 `isCustomTime`），本校上游又不读任何节次表。这里按课表里实际出现的开始时间排节次，同一开始时间算一节、下课取最晚，并**始终**在提醒里说明（parse.js:328-353、520）。这是与上游最大的不同，见 §8 风险。
4. **去重**：逐日/逐页拿回的同一条记录按 `(课程, 日期, 开始, 结束, 教师, 教室)` 先去重再统计，免得提醒里的条数被放大（parse.js:306-315）。upstream 没有去重。
5. **分组带教室**：分组键多了教室这一维，同一时段两间教室的排课不会被合并掉一间（上游的键是 `lessonId|day|start|end`）。
6. **教师**：上游写成「未知教师」；这里写 null，并在提醒里按类型汇总。教师名后的括号备注不拆成第二位教师。
7. **总周数**：校历优先；没有校历用 20；课表更晚才抬高；上下限 16~25 周，动了就提醒（parse.js:457-475）。上游是「课程最大周次优先、`clampWeeks` 静默截到 16~25」，会低估没有课的学期长度，也不告诉学生。
8. **不弹窗选学期**：取 URL 里的学期号 > 下拉框 `selected` > 第一项；凭什么选的写进提醒（extract.js:184、parse.js:478）。

## 5. 上游里删掉或改掉的

- 选学期弹窗 `showSingleSelection`、确认弹窗、无课学期反复重选：已登录就取当前学期，取不到就报错让用户切学期。
- 拾光桥 `saveCourseConfig` / `saveImportedCourses` / `notifyTaskCompletion`：改为交载荷。
- `未知课程` / `未知教师` / `未知地点` 占位词：一律 null。
- `uniqueSortedWeeks` 静默丢超界周次：改为计数进提醒。
- `padStart`、`Map`、`Set`、`async/await`、`Array.prototype.fill`：降到 ES5（对象、数组、Promise 链）。

## 6. 本校边界（夹具）

共 9 对，期望按规范和代码逻辑手推，不是把 `parse.js` 输出存下来。

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

## 7. 变异测试

在 `parse.js` 上改坏再还原，自检必须先 DIFF 再 PASS。

1. 日期换算去掉 `+ 1`（`parse.js:295`）→ basic / no-start / cross-semester / raise-default / over-calendar 变红，long-warn / dirty 直接报错。
2. `raised = maxWeek > totalWeeks` 改成 `false`（`parse.js:464`）→ raise-default、over-calendar 变红。
3. `placeholder` 不再把「未知」当空（`parse.js:174`）→ basic、dirty 变红（「未知」被当成教师名交出去）。

三处都已还原，最终自检 `RESULT: PASS`。

## 7.1 2026-11-10 复审修正

| 编号 | 问题 | 修正 | 捕获方式 |
|---|---|---|---|
| R1 | 低周数提醒里报的是「抬高后」的周数，却写成「学期起止日期只能数出 N 周」，与上一条抬高提醒自相矛盾 | 改报「按教务数据算出的学期总周数」（抬高后的真实值），措辞不再假设一定有校历；高周数提醒同步 | 新用例 `counters`；把值换回 `calendarWeeks` 即 DIFF |
| R2 | 所有排课都被跨学期规则丢掉时，报错只说「读不出课程、日期或上课时间」，不写真实原因 | 报错里按原因分项计数（对不上名单 / 日期读不出 / 上课时间读不出 / 日期在开学日之前 / 超出学期末） | 冒烟场景 `all-before-start`（`expect_parse_fail`） |
| R3 | 「下课时间前后不一致」按行数计，文案却说「N 个开始时间」 | 按不同的开始时间计数 | `counters` 里同一个开始时间三种下课时间 → 提醒仍写 1 个；改回按行数即 DIFF |
| R4 | 内容去重放在各类跳过计数之后，重复行会放大提醒条数（与代码注释相反） | 去重挪到最前面：先按原始字段去重，再计数、再解析 | `counters` 里重复的「待定」行只算 1 条；删掉提前的去重即 DIFF |
| R5 | AUDIT 署名笔误 `0x7E-2023` | 改为 `0x7E7-2023`，与 manifest 一致 | 与 manifest 对照 |

## 8. 没验的部分与风险

- **没有本校账号**，真机没跑过。`date` / `startTime` / `endTime` / `personName` / `room.nameZh` 的字段名来自上游代码，若教务改版，缺字段会进提醒或报错，不会静默交出错课表。
- **节次时间由排课数据推导**（§4.3）：如果本校实际把一上午拆成多个小节的开始时间，推导出的节次行就是多个；如果是 2 节连堂一块给，推导出的是连堂这一行。两种都能自洽显示，但和学校公布的节次表可能不是一比一。学生看到的是真实上下课时间，提醒里也写明了来源。若主调度认可补一个 `timetable-layout` 请求（dlut 有），可以换成教务的真节次表。
- 同一开始时间、下课时间不同的两条记录（dirty 用例）：课表按最晚的下课时间显示，并提醒学生核对。
- 上游按「最早一节课在第 1 周」推算开学日；这只在最早一节课确实排在第 1 周时成立，不成立会整体偏移，提醒里写明是推算值。
- 浏览器冒烟（`.test/port-batch32/xauat/smoke.py`，本机 Playwright 无自带 chromium，退回系统 Edge）覆盖 12 个场景：正常、地址里的学期、未标学期、登录页零请求、门户零请求、同校别的主机零请求、401、学期名单为空、datum 500、学期接口 500 回落、跨学期日期、空课表。全部 OK，不联网。
- `minAppVersionCode` 为 11。输出仍是 `kind:"schedule"`。

0x7E7-2023（haiku 移植，2026-11-09）
