# 内蒙古大学 适配器安全审计（URP 综合教务）

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) `IMU/imu_01.js`（MIT，上游作者 **星河欲转**，`adapters.yaml` 的 `maintainer`）；`import_url` = `https://jwxt.imu.edu.cn/login` |
| 上游快照 | 工作区 HEAD `03d161a`（公共说明写的 `7c9e190` 对不上，未改快照）。本校脚本最后一次修改：`80e30cf`（2026-09-23，`git log -1 -- resources/IMU/imu_01.js` 与任务卡一致） |
| 平台 | URP 综合教务（`/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback`）。与 `TCU/tcu_01.js` 的差异只有两处：主机 `jwxt.imu.edu.cn`，以及上游自己拼的 `planCode` 末段是 `-2`（天津城建是 `-1`） |
| 模板 | 已审计的 `tcu`。选它是因为上游脚本与 `tcu_01.js` 行相似度 0.983，响应外壳、`classWeek` 位串、节次字段都相同；以它为底只改学校、主机和登录页判断 |
| 移植者 | 0x7E7-2023（haiku 移植，2026-10-27） |
| 结论 | 自检 PASS（8 对 fixture 全部一致）；浏览器冒烟 13/13 OK；变异测试 3 处全部变红并已还原。不碰凭据、不外发、只读课表、无第三方域、无埋点。**真机未验证**，见第 8 节 |

## 1. 请求清单（与代码一致）

所有请求都是**同源相对路径**（上游写死绝对地址 `https://jwxt.imu.edu.cn/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback`）。代码里没有任何绝对 URL，也没有第二个主机。`allowHosts` 为空：不声明额外主机，宿主也不自动拦截网页请求；桥注入与宿主图片下载只使用 `loginUrl`（`jwxt.imu.edu.cn`）的主机。`extract.js` 里 `fetch` 共 2 处（`requestSchedule`、`fetchCalendar`）。

| # | 方法 | 路径 | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| 1 | 课表页有学期下拉框时 POST；没有（或只有占位项）时 GET | `/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback` | 取课表 JSON（`dateList[].selectCourseList[]` 与 `jcsjbs`）。POST 体 `planCode=<下拉框选中的学期代码>`（`encodeURIComponent`），请求头 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`X-Requested-With: XMLHttpRequest`；GET 时教务给当前学期。`credentials: 'same-origin'` | 401/403 → 「教务系统拒绝访问（代码 N）」；其它非 2xx → 「教务系统返回错误（代码 N）」；网络失败 → 「连不上教务系统」；返回不是 JSON → 「返回的内容格式不对」；没有 `dateList` → 「没有返回课表数据」。都是抛错，导入停止 |
| 2 | GET | `/indexCalendar` | 只用正则从页面文本里取 `var rq`（开学日 `YYYYMMDD`）和 `var skzc`（学期周数）两个字符串，**不交整页** | **任何失败都是 `null`，不阻断导入**；parse.js 按提取当天所在周的周一推算开学日；总周数校历优先，没有可用校历时按 20 周，课表更晚再抬高，并提醒 |

- 请求 1 在请求 2 之前发出，请求 2 只在请求 1 成功后发。
- 登录页：路径是 `/login` 或 `/login/…` 时，直接报「这里还不是课表页……」，**不发任何请求**（`onPortalOrLogin`）。本校登录页就在 `jwxt.imu.edu.cn`，上游没有单独的统一认证主机，所以这里不列第二台主机。
- 页面 DOM **只读**：`document.getElementById('planCode')` 取选中项（`selectedIndex`）的 `value`、文字和 `defaultSelected`。不创建节点、不改表单、不提交、不点击。选中项为空或 `no`（占位项）时当作没有下拉框，走 GET。
- 没有任何其它请求：不请求成绩、学籍、个人信息、缴费、选课接口。上游也只请求 `jwxt.imu.edu.cn` 这一个主机。
- 静态扫描：`XMLHttpRequest` / `sendBeacon` / `WebSocket` / `new Image` / `eval` / `new Function` / `document.cookie` / `localStorage` 均无。

## 2. 读了什么、交出去什么

`extract.js` 交给 `parse.js` 的 JSON 字段（**白名单外的一律不带出**；`pick()` 只接受字符串、数字、null）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `fetchedDate` | 浏览器本地日期 | `YYYY-MM-DD`（`localDate`，不用 UTC） |
| `term` | `#planCode` 选中项 | `{ text, isDefault }`；没有下拉框为 `null`。学期代码只用来拼请求 1 的体，不交出 |
| `rq` | `/indexCalendar` | 8 位数字串或 `null` |
| `skzc` | `/indexCalendar` | 数字串或 `null` |
| `slots[]` | 响应 `jcsjbs` | 每项 `jc`、`kssj`、`jssj`；非数组为 `null` |
| `courses[]` | 响应 `dateList[].selectCourseList[]` | 每项 `courseName`、`attendClassTeacher`，`timeAndPlaceList[]` 每项 `classDay`、`classSessions`、`continuingSession`、`classWeek`、`teachingBuildingName`、`classroomName` |

响应外壳只在 `planCourses()` 里定义一次。周次是 `classWeek` 位串（下标 i 为第 i+1 周），不是「单 / 双」文字。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **通过**。不读密码、登录表单、cookie、`localStorage`；fetch 只带 `credentials: 'same-origin'`。 |
| 2 | 不外发 | **通过**。只有上面 2 个同源请求；没有埋点、上报。 |
| 3 | 请求域可控 | **通过**。`allowHosts` 为空（无通配）。与 `loginUrl` 同源的 `jwxt.imu.edu.cn` 由宿主放行。没有第二个主机。 |
| 4 | 只读课表 | **通过**。请求 1 的 POST 体只有 `planCode`，是上游的既有查询方式；服务端有无写副作用无法本地确认（见第 8 节）。请求 2 是 GET。 |
| 5 | 不埋点 | **通过**。上游的弹窗、toast、桥调用全部去掉。 |
| 6 | 不 eval 远程代码 | **通过**。无 `eval` / `new Function`；取回的内容只经 `JSON.parse` 和两个正则。 |
| 7 | 不写页面 | **通过**。只读 `#planCode`。 |
| 8 | 不依赖用户输入之外的秘密 | **通过**。无硬编码学号、令牌；学期代码来自教务页面本身，不在脚本里拼 `-2`。 |

## 4. 与模板的差异

| 项 | tcu（模板） | imu |
|---|---|---|
| 主机 / 登录 | `loginUrl` 在 `authserver.tcu.edu.cn`，课表在 `jwxs.tcu.edu.cn`，`allowHosts` 列出教务主机；统一认证主机上直接提示 | `loginUrl` 与课表同在 `jwxt.imu.edu.cn`，`allowHosts` 为空；只拦路径 `/login` |
| 上游 planCode | 上游自己拼时末段是 `-1` | 上游自己拼时末段是 `-2`（`学年-下一年-学期序号-2`）。这里不自己拼，原样提交页面下拉框的值 |
| 其余（下拉框、校历、`jcsjbs`、位串、两阶段合并、教师按 `*` 拆、H3 补节次、提醒收口） | — | 与 tcu 相同 |

内置节次时间：**无**。节次超出教务给的 `jcsjbs` 时按「统一修订 H3」逐节补：空课默认的节次时间（`BUILTIN_PERIODS`，12 节）同一节不早于上一节下课就用它，否则从上一节下课后顺推（课间 5 分钟、每节 45 分钟），越过 23:59 就停（`slots-extend` 钉住）。教务一节都没给时不输出节次时间（`no-meta`）。

## 5. 上游里删掉 / 改掉的东西及理由

- 「学年」输入框与「学期」单选，以及自己拼的 `planCode`（末段固定 `-2`）：改为读课表页下拉框，没有下拉框就让教务给当前学期。不弹窗。
- `showAlert`、`showToast`、保存课表 / 节次 / `semesterTotalWeeks: 20` 的桥调用：导入由宿主完成。
- 绝对地址与 `credentials: "include"`：改成同源相对路径与 `same-origin`。主机仍只有 `jwxt.imu.edu.cn`。
- 教师 `replace` 掉「星号加空格」：多位教师会连成一串，改为按 `*` 拆开用「、」连接。
- 连续节数缺失时上游得到无效节次：这里按 1 节导入并计数提醒。
- 总周数写死 20：改为取校历 `skzc`；取不到用 20 周，课表最大周次更晚再抬高，并提醒。
- 上游不设开学日：取校历 `rq` 对齐到周一，取不到按提取日推算，都提醒核对。
- 上游每条安排各成一门课：先去完全重复行，再两阶段合并（首尾相接 `end + 1`、同节次周次取并集）。
- 新增 `/indexCalendar` 只读取值（上游没有，照模板 tcu）；只取两个字符串。
- 位串不是纯 0/1、全 0、空串都当读不出来，计入提醒（`weeksOf`）。

## 6. 测试

### fixtures（8 对，期望值沿用与模板相同的推演，只改了学校名和空串这一处）

空串这一处是本校任务卡要求、模板没有单独钉住的：在 `weeks-edge` 给综合C 加了一条 `classWeek` 为空串的安排。空串与全 0、非法文字、缺字段一样进不了课表，所以「读不出来」从 6 条变为 7 条，课程块不变。其余期望与模板同一套推演（节次、周次切段、开学日、总周数、提醒文本），学校名只出现在推算学期名里，已改成「内蒙古大学」。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 默认学期、教务 12 节、开学日与总周数取校历、单双周位串、连堂合并、同节次周次合并、完全重复行、多位教师、缺教师缺教室 |
| `weeks-edge` | 缺周（1-4 + 双周段 + 13-15；单周 + 单独一周）、连续周、全 0、非法文字、**空串**、缺字段、星期 8、节次 0、起止超过 20 节，共 7 条读不出来；连续节数缺失按 1 节；没排课；没有课程名 |
| `term-other` | 历史学期：不用校历开学日和总周数 |
| `no-meta` | 无校历、无节次时间、学期名只剩「(当前)」按 1 月推成上一学年第一学期（学校名「内蒙古大学」）、总周数 35 非法 |
| `slots-extend` | 开学日不是周一、第 9 节以后补时间、第 15 节补不了、坏的节次行、第 24 周抬高总周数 |
| `clamp` | 第 32 周压到 30 周：截断与丢弃 |
| `long-names` | 四门长课名缺节数、缺教师、缺教室，课名截 20 字，单条 ≤200 字 |
| `no-select` | 没有下拉框：学期名按提取日推算（学校名「内蒙古大学」），校历照用 |

### 浏览器冒烟

`.test/port-batch20/imu/smoke.py`（从 `.test/port-batch18/tcu/smoke.py` 改），`all` 为 **13/13 OK**。假教务站不联网。场景：课表页默认学期 POST（体 `planCode=2026-2027-1-2`，末段 `-2` 原样来自页面）、无下拉框 GET、占位项 GET、历史学期 POST（`planCode=2025-2026-2-2`）、教务首页 GET、`/login` 与 `/login/cas` 不发请求、返回登录页 HTML、无 `dateList`、401、500、校历 404、无节次时间。没有备用接口，也没有第二台主机。输出里没有学号、身份证号、手机号、校区名。

### 变异测试

在 `C:/Users/23703/AppData/Local/Temp/imu-port19/` 的副本上改 `parse.js`，跑自检，三处都只有对应用例 DIFF，改回后副本自检 PASS，临时目录已删除。真实目录从未做这些改动，收尾自检仍为 PASS、冒烟 13/13。

| # | 改坏哪一处 | 变红的用例 |
|---|---|---|
| 1 | `cleanTeacher` 不按 `*` 拆 | `basic` |
| 2 | `weeksOf` 把空串当成第 1 周 | `weeks-edge` |
| 3 | `termIsCurrent` 恒为真 | `term-other` |

## 7. 提醒清单

与模板 tcu 相同的收口：开学日、学期名、总周数、节次时间、补的节次、猜的连续节数、没排课、读不出来、超出 30 周、缺教师 / 缺教室。课名走 `shortName`（≤20 字），点名最多 3 门，每条 ≤200 字，最多 20 条。缺教师 / 缺教室指向「编辑课程」，开学日 / 总周数 / 节次时间指向「学期管理」。

## 8. 已知风险与未验证项

1. **没有本校账号，真机没验过**。fixture 与冒烟都是合成的。拿到真实页面后应核对：`#planCode` 的文字和 `value`（是否以 `-2` 结尾）、`defaultSelected`、`dateList` / `jcsjbs`、`classWeek` 位数、`/indexCalendar` 里 `var rq` / `var skzc` 的写法。
2. **`rq` 与 `skzc` 是照模板 tcu 新增的**，本校上游不读校历。若含义不对，学生会在提醒里看到日期并可在「学期管理」里改；两者只对默认学期使用。
3. **上游没有写死的节次表**，完全依赖 `jcsjbs`。取不到就按应用默认显示并提醒。
4. **POST 只有 `planCode`**，服务端是否有写副作用无法本地确认。
5. **不弹窗问学期**。非默认学期要先在课表页下拉框里选好。首页没有下拉框时 GET 当前学期。
6. **上游只请求一个 planCode**（自己拼的那一个，末段固定 `-2`）。这里同样只请求选中的一个；若同一学期有多条计划，其它计划的课不会出现。
7. **连续节数缺失按 1 节**是推算，已提醒。
8. **地点是「教学楼 + 教室」直接拼**，楼名可能重复。
9. **不处理 WebVPN**。上游没有别的主机；若校外访问改写主机，需要主调度决定是否加 `allowHosts`，本次没有自行添加。
10. **`scheduleUrlHint`** 按任务卡填 `https://jwxt.imu.edu.cn/student/courseSelect/thisSemesterCurriculum/index`，未在真机确认。

签名：0x7E7-2023（haiku 移植，2026-10-27）
