# 天津科技大学 适配器安全审计（URP 综合教务 · 统一认证登录）

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) `TUST/tust_01.js`（MIT，上游作者 **oneepointer**，`adapters.yaml` 的 `maintainer`）；`import_url` = `https://id.tust.edu.cn/authserver/login?service=http://jwxtxs.tust.edu.cn:46110/j_spring_cas_security_check` |
| 上游快照 | 本地仓库 HEAD `03d161a`（与任务卡一致）。`git log -1 -- resources/TUST/tust_01.js` 是 `80e30cf`（2026-09-23，该文件最后一次被修改的提交，是 HEAD 的祖先）。公共说明里的 `7c9e190` 与这份本地快照的 HEAD 不一致，**未改快照** |
| 平台 | URP。课表是 `thisSemesterCurriculum/<字母数字>/ajaxStudentSchedule/curr/callback`，节次时间是单独的 `/ajax/getSectionAndTime` |
| 模板 | `tcu`（已审计的 URP，行相似度 0.444，任务卡指定）。外壳都是 `dateList[].selectCourseList[]`，周次都是 `classWeek` 位串，教师都带 `*`，地点都是教学楼加教室。本校没有学期下拉、没有校历，节次时间是另一路请求，所以取数链按上游重写，解析沿用 tcu 的周次切段、两阶段合并、提醒收口和 H3 补节次 |
| 移植者 | 0x7E7-2023（haiku 移植，2026-10-27） |
| 结论 | 自检 PASS（8 对 fixture 全部一致）；浏览器冒烟 12/12 OK；变异测试 3 处全部变红并已还原。不碰凭据、不外发、只读课表、无第三方域、无埋点。**真机未验证**，见第 8 节 |

## 0. 本校与模板的不同构（动手前的分析）

上游脚本 166 行，只做三件事：从 `document.head` 的文本里用正则取出课表路径中的一段字母数字；POST 该课表（无请求体）；POST `/ajax/getSectionAndTime`（体 `planNumber=&ff=f`）。`classWeek` 是位串。节次时间按 `sectionTime` 数组下标从 1 编号，钟点是四位（`0800` → `08:00`）。总周数写死 20。没有学期选择、没有校历、没有写死节次表。开场有一个确认框，然后 toast 和桥保存。

因此：不读 `#planCode`，不请求 `/indexCalendar`；学期名和开学日按提取日推算并提醒；总周数以 20 为底，课表更晚再抬高；节次时间取不到不阻断。`scheduleUrlHint` 用任务卡给的 `http://jwxtxs.tust.edu.cn:46110/student/courseSelect/thisSemesterCurriculum/index`（协议、主机、端口都没改）。上游自己不打开页面，只要求人已经停在课表页；这个 index 路径和课表接口的目录一致。

## 1. 请求清单（与代码一致）

所有请求都是**同源相对路径**（上游写死 `http://jwxtxs.tust.edu.cn:46110/…`）。代码里没有绝对 URL。`extract.js` 里 `fetch` 共 2 处（`requestText`、`requestSlots`）。

| # | 方法 | 路径 | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| 1 | POST（无请求体） | `/student/courseSelect/thisSemesterCurriculum/<字母数字>/ajaxStudentSchedule/curr/callback` | 取当前学期课表。那段字母数字只从当前页 `document.head` 的文本里取第一处，且必须是字母或数字；不跟随页面里的任意网址。请求头带 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8` 与 `X-Requested-With: XMLHttpRequest`，`credentials: 'same-origin'` | 当前页没有这段路径：直接报「当前页面不是本学期课表」，**不发请求**。401/403 → 「教务系统拒绝访问（代码 N）」；其它非 2xx → 「教务系统返回错误（代码 N）」；网络失败 → 「连不上教务系统」；不是 JSON → 「返回的内容格式不对」；没有 `dateList` 数组 → 「没有返回课表数据」。都是抛错，导入停止 |
| 2 | POST | `/ajax/getSectionAndTime` | 体固定 `planNumber=&ff=f`。读 `sectionTime[]` 的 `startTime` / `endTime`，按原顺序交给 parse.js | **任何失败、非 2xx、不是 JSON、没有 `sectionTime` 数组，都是 `null`，不阻断导入**。空数组原样交出。parse.js 没有可用节次时间时不输出节次时间，提醒按应用默认显示 |

- 请求 2 只在请求 1 成功之后发（冒烟 `curr` 的顺序钉住）。
- 门户 / 登录页：主机是 `id.tust.edu.cn`，或路径是 `/login`、`/login/…` 时，直接报「这里还不是教务系统……」，**不发任何请求**（`onPortalOrLogin`；冒烟 `portal-auth`、`login`。即便 head 里已经有课表路径也不发）。
- 页面只读 head 的文本。不创建节点、不改表单、不提交、不点击。
- 没有其它请求：不请求成绩、学籍、个人信息、缴费、校历。
- 静态扫描：`XMLHttpRequest` / `sendBeacon` / `WebSocket` / `new Image` / `eval` / `new Function` / `document.cookie` / `localStorage` 均无。

冒烟拼出来的地址（假站，主机都是 `jwxtxs.tust.edu.cn:46110`）：

| 场景 | 结果 |
|---|---|
| `curr` | POST `…/Ab12Cd/ajaxStudentSchedule/curr/callback`（无体），再 POST `/ajax/getSectionAndTime` 体 `planNumber=&ff=f` |
| `foreign-code` | head 里只有 `http://evil.example/…/EVIL99/…` 这种绝对地址。请求仍打到教务自己的主机、路径用 EVIL99，**没有请求 evil.example** |
| `no-code` / `portal-auth` / `login` | 零请求 |
| `section-500` / `section-empty` | 课表成功；节次失败或空数组时课仍导入，节次时间为空并提醒 |

## 2. 读了什么、交出去什么

`extract.js` 交给 `parse.js` 的 JSON（白名单外一律不带出；`pick()` 只接受字符串、数字、null）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `fetchedDate` | 浏览器本地日期 | `YYYY-MM-DD`（`localDate`，不用 UTC） |
| `slots` | `sectionTime` | 每项只有 `startTime`、`endTime`，顺序即节次；失败为 `null`。页内那段字母数字不交出 |
| `courses[]` | `dateList[].selectCourseList[]` | 每项 `courseName`、`attendClassTeacher`，`timeAndPlaceList[]` 每项 `classDay`、`classSessions`、`continuingSession`、`classWeek`、`teachingBuildingName`、`classroomName` |

响应外壳（`dateList → selectCourseList`）只在 `planCourses()` 定义一次。冒烟往响应里塞了 `courseNumber`、`studentId`、`xh`、`xm`、`sfzh`、`sjh`、`weekDescription`、`planName`、`campusName`，输出里都没有；课表路径里的字母数字也不在输出里。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **通过**。不读密码、登录表单、cookie、本地存储；fetch 只带 `credentials: 'same-origin'`。登录由用户在 WebView 里完成 |
| 2 | 不外发 | **通过**。只有上面 2 个同源请求。页面里出现的其它主机（冒烟的 evil.example）不会被请求 |
| 3 | 请求域可控 | **通过**。`allowHosts` 只有 `jwxtxs.tust.edu.cn`（精确主机，无通配，无端口）。`id.tust.edu.cn` 与 `loginUrl` 同源，不列入白名单；在其上点「提取课表」只提示、不发请求。上游也只请求 `jwxtxs.tust.edu.cn` 这一个主机 |
| 4 | 只读课表 | **通过**。请求 1 无体。请求 2 的体与上游相同，只有 `planNumber=`（空）和 `ff=f`。服务端有无写副作用无法本地确认（见第 8 节） |
| 5 | 不埋点 | **通过**。无统计、无上报。上游的确认框、toast、桥保存全部去掉 |
| 6 | 不 eval 远程代码 | **通过**。无 `eval` / `new Function` / `document.write`。取回的内容只经 `JSON.parse`，课表路径只经一个字母数字正则 |
| 7 | 不写页面 | **通过**。只读 head 的文本（自检曾把 `innerHTML` 紧挨等号当成写页面，已改成先取出再 `String(...)`，自检不再提示） |
| 8 | 不依赖用户输入之外的秘密 | **通过**。无硬编码学号、令牌、密钥。课表路径的字母数字来自教务页面本身 |

## 4. 与模板的差异

| 项 | tcu（模板） | tust |
|---|---|---|
| 取数 | 有学期下拉就 POST `planCode`，否则 GET 固定课表路径；再 GET `/indexCalendar` | 必须先从 head 取出字母数字，POST 带这段的 `curr` 路径（无体）；再 POST `/ajax/getSectionAndTime` |
| 节次时间 | 同一份响应的 `jcsjbs`（`jc` / `kssj` / `jssj`） | `sectionTime` 的 `startTime` / `endTime`，第几节是数组下标加 1；坏行跳过且不把后面的节次前移（`buildSlotPeriods`，`slot-index`） |
| 学期 / 开学日 / 总周数 | 下拉框学期名；校历 `rq`、`skzc` | 上游没有这些。学期名、开学日按提取日推算并提醒。总周数以 20 为底（上游写死），课表最大周次超过 20 就抬高，超过 30 再压到 30 |
| 连堂合并 | 只合并正好相接的下一节 | 下一节开始不晚于当前结束的下一节（含重叠和同一节重复行），`mergeStageOne` |
| 门户 | `authserver.tcu.edu.cn` | `id.tust.edu.cn`。教务是 **http、端口 46110**，hint 与 loginUrl 的 service 都保留这个端口 |
| 周次、教师按星号拆开、地点拼楼名加教室、连续节数缺失按 1 节、缺教师缺教室汇总、H3 补节次、提醒收口 | — | 与 tcu 相同。位串不是纯 0/1（含空串、全 0）算读不出来 |

内置节次时间：**无**。超出已有节次时按 H3 补：`BUILTIN_PERIODS`（12 节）同一节不早于上一节下课就用它，否则课间 5 分钟、每节 45 分钟顺推，越过 23:59 就停（`slots-extend`）。一节都没有就不输出节次时间（`no-slots`，冒烟 `section-500` / `section-empty`）。

位串切段沿用 `runsOf`：相邻差 2 视为单周或双周，而且会一直吃到差不再是 2 为止。`weeks-edge` 的 `1111000010101010111` 因此是 1-4 每周、9-17 单周、18-19 每周（第 17 周离第 15 周差 2，被并进单周段），不是 9-15 再加 17-19。

## 5. 上游里删掉 / 改掉的东西及理由

- `promptUserToStart` 确认框、`showToast`、`saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig`（含写死的 `semesterTotalWeeks: 20`）/ `notifyTaskCompletion`：导入由宿主完成，extract.js 只交数据。20 周改由 parse.js 作为底数，并在提醒里说明。
- 绝对地址与 `credentials: "include"`：改成同源相对路径与 `same-origin`。
- 教师 `replace` 掉「星号加空格」：多位教师会连成一串，改为按星号拆开用顿号连接（`cleanTeacher`）。
- 地点仍是教学楼加教室直接拼，不带校区名（上游同）。校区名不带出。
- `endSection = classSessions + continuingSession - 1`：连续节数缺失时上游得到无效节次；这里按 1 节导入并计数提醒。
- 上游每条安排各成一门课：先去掉完全重复行，再两阶段合并。合并条件放宽到重叠和同一节重复行，避免课表叠在一起。
- 上游 `parseWeekString` 用下标取字符，空串当没有周次但不告诉学生。这里空串、全 0、夹杂其它字符都计入提醒，不静默丢课。
- 上游节次时间失败会让整次导入失败。这里失败只丢掉节次时间并提醒，课仍导入。
- 不新增校历请求、不弹窗问学期：上游本身就只拉当前学期（路径里的 `curr`）。

## 6. fixtures 与变异测试

8 对，期望按位串、节次下标和提醒文案手推，不是把 parse.js 的输出存成期望。

| 用例 | 覆盖 |
|---|---|
| `basic` | 12 节按下标、连续周、单周、双周、连堂 1-2 接 3-4、同节次两段周次并成 1-16、完全重复行、多位教师、缺教师、缺地点。总周数 20（最晚第 16 周）。提取日 2026-09-10 → 开学日 2026-09-07，学期名「天津科技大学 2026-2027学年第一学期」 |
| `weeks-edge` | 缺周被单周段吃进 9-17、连续周、空串、全 0、非法字符、星期 8、缺起始节、连续节数缺失、没排课、没课名 |
| `overlap` | 完全重复的 1-2 节只留一条，再与 2-3 节合成 1-3 节；5-6 接 7-8 仍合成 5-8；`11101111` 拆成 1-3 与 5-8 |
| `slot-index` | 第 2 行钟点非法时，第 3 行仍是第 3 节，时间表里没有第 2 节 |
| `slots-extend` | 第 9-12 节用默认节次时间，第 13-14 节顺推，第 15 节补不了；3 行坏数据；第 24 周把总周数抬到 24 |
| `clamp` | 第 32 周压到 30：29-32 截成 29-30，整段落在 31 周之后的安排和「超长周课」丢弃 |
| `long-names` | 四门 40 字课名缺节数、缺教师、缺教室；课名截到 19 字加省略号，点名最多 3 门；另有长课名的没排课和读不出的安排。单条提醒均不超过 200 字 |
| `no-slots` | `slots` 为 null；提取日 2026-01-15 → 2026-01-12，学期名「天津科技大学 2025-2026学年第一学期」（1 月属于上一学年第一学期）；总周数仍是 20 |

### 浏览器冒烟（`.test/port-batch21/tust/smoke.py all`，12/12 OK）

`curr`、`no-code`、`portal-auth`、`login`、`ajax-html`、`ajax-empty`、`ajax-401`、`ajax-500`、`no-courses`（空 `dateList` 解析失败）、`section-500`、`section-empty`、`foreign-code`。个人信息和课表路径字母数字不出现在交出的 JSON 里。

### 变异测试（3 处，在 `C:/Users/23703/AppData/Local/Temp/tust-port19/mut/` 的副本上改；真实目录从未改这些逻辑，收尾自检仍为 PASS）

| # | 改坏 | 变红 |
|---|---|---|
| 1 | `mergeStageOne` 改回只认正好相接的下一节 | fixture `overlap` DIFF（1-2 节与 2-3 节不再合成 1-3 节） |
| 2 | `buildSlotPeriods` 改成只给读得出来的行重新编号 | fixture `slot-index` DIFF（第 3 行变成第 2 节） |
| 3 | 删掉「课表超过 20 周就抬高总周数」 | fixture `slots-extend`、`clamp` DIFF |

## 7. 给学生看的文字

提醒和报错不出现「接口」「载荷」「上游」「脚本」「字段」「null」。时间表叫「节次时间」。改学期信息说「学期管理」，补教师 / 教室说「编辑课程」。状态码写成「教务系统返回错误（代码 N）」或「教务系统拒绝访问（代码 N）」。带课名的提醒先截到 20 字以内再进同一条 `warn`（超过 200 字才会在末尾硬截断）。

## 8. 已知风险与未验证项

1. **没有本校账号，真机没验过**。fixture 和冒烟都是合成的。拿到真实页面后应核对：head 里那段字母数字的写法、`dateList` / `sectionTime` 的形状、`classWeek` 位数、`startTime` 是不是四位。
2. **字母数字若只写在 body、不在 head**，会提示去打开本学期课表且不发请求（与上游一致，上游也只读 head）。
3. **上游没有写死节次表**。节次完全靠 `sectionTime` 的顺序；若教务中间空一节，后面的节次号不会前移，空掉的那一节没有时间（课程仍按它自己的节次号导入）。
4. **总周数 20、开学日、学期名都是推算**，提醒里写了日期和周数，需要学生到「学期管理」核对。上游没有校历，这里也没有新增校历请求。
5. **两路都是 POST**，与上游相同。请求 1 无体，请求 2 体只有空的 `planNumber` 和 `ff=f`。服务端是否有写副作用无法本地确认。
6. **只拉当前学期**（路径里的 `curr`）。历史学期导不了；上游同样不能选学期。
7. `id.tust.edu.cn` 只用于登录，不发请求，也没有加进 `allowHosts`。

签名：0x7E7-2023（haiku 移植，2026-10-27）
