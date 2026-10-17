# 辽宁大学 适配器安全审计（URP 综合教务 · 直连校外可访问的教务站点）

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) `LNU/LNU_01.js`（MIT，上游作者 **739C1AE2**）；同目录 `adapters.yaml` 的 `import_url` = `http://jwstudent.lnu.edu.cn/`、`maintainer` = `739C1AE2` |
| 上游快照 | `1dc0772566ba610f495906410734db4e7b8ef0c1`（2026-10-17）；本校脚本最后一次修改：`94c2bea`（2026-08-30）、`b0f05f7`（2026-09-05，加了开学日配置） |
| 平台 | URP 综合教务系统（同平台的上游适配有 neau / IMU / TCU / TUST / YZU / AUFE / QQHRU，课表接口路径相同） |
| 移植者 | 0x7E7-2023（haiku 移植，2026-10-17） |
| 模板 | `neau`（同平台、同一个课表接口）；参考件 `qau` 的 `askCampus()` |
| 结论 | 自检 PASS（5 对 fixture 全部一致）；不碰凭据、不外发、只读课表、无第三方域、无埋点。**真机未验证**，见第 7 节。 |

## 1. 请求清单（与代码一致）

所有请求都是**同源相对路径**，目标主机永远是当前页面所在的主机（即用户在 WebView 里打开的教务站点）。
`vpnBase()` 只在页面路径形如 `/http[s]/<token>/…` 时补上这个前缀，结果仍是同源路径。

| # | 方法 | 路径 | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| 1 | 有学期下拉框（`#planCode`）时 **POST**，没有时 **GET** | `/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback` | 取课表 JSON。POST 体只有 `planCode=<下拉框当前选中项的值>`（`encodeURIComponent`）；请求头 `Accept`、`Content-Type`（仅 POST）、`X-Requested-With` | 401/403 → 「教务系统拒绝访问（代码 N）」；其它非 2xx → 「教务系统返回错误（代码 N）」；网络失败 → 「连不上教务系统」；返回不是 JSON → 「教务系统返回的内容格式不对」。以上都是抛错，导入停止 |
| 2 | GET | `/indexCalendar` | 只从 HTML 文本里用正则取 `var rq`（开学日 `YYYYMMDD`）与 `var skzc`（学期周数）两个字符串，**不交整页** | 非 2xx、网络失败、读不出来 → 两个值都是 null，不阻断导入；parse.js 改用推算并写进提醒 |

- 校区选择不发请求，只调用宿主桥 `__ncSelect`（照 `qau` 的 `askCampus()`）；桥不在 / 取消 / 报错 → 校区为 null。
- 页面 DOM **只读**：`document.getElementById('planCode')` 取 `options` 的文字 / 值 / `defaultSelected` 与 `selectedIndex`。
- 没有任何其它请求：不请求成绩、学籍、个人信息、缴费、选课接口；上游脚本里也没有这些地址。

静态扫描结果：`extract.js` 代码里**没有任何绝对 URL**（`check.js` 的主机扫描为空）；`fetch` 只有 2 处（上面 #1、#2），`XMLHttpRequest` / `sendBeacon` / `WebSocket` / `new Image` / `eval` / `new Function` / `document.cookie` / `localStorage` 均无。

## 2. 读了什么、交出去什么

`extract.js` 交给 `parse.js` 的 JSON 字段（逐字段；**白名单外的一律不带出**，包括接口响应里的学号、人员 ID、姓名等）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `fetchedDate` | 浏览器本地日期 | `YYYY-MM-DD`，推算开学日与学期名用，写进提醒 |
| `term` | `#planCode` 选中项 | `{ text, isDefault }` 或 `null`（没有下拉框）。`text` 是学期名，`isDefault` 是是否写了 selected 属性。学期代码（`value`）只用来拼 POST 体，不交出 extract.js。 |
| `campus` | 校区选择桥 | `extract` / `chongshan` / `puhe` / `wusheng` / `null` |
| `rq` | `/indexCalendar` | 8 位数字串或 `null` |
| `skzc` | `/indexCalendar` | 数字串或 `null` |
| `errorMessage` | 课表 JSON 顶层 | 字符串或 `null`（有值时 parse.js 抛错） |
| `courses[]` | 课表 JSON `xkxx` | 每项 `courseName`、`attendClassTeacher`，`timeAndPlaceList[]` 每项 `classDay`、`classSessions`、`continuingSession`、`classWeek`、`weekDescription`、`campusName`、`teachingBuildingName`、`classroomName`。**课程 ID 键不带出**，改成数组。 |
| `slots[]` | 课表 JSON `jcsjbs` | 每项 `jc`、`kssj`、`jssj`；没有时为 `null` |

值只接受字符串、数字、null；嵌套对象一律丢弃（`pick()`）。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **通过**。不读 `password`、登录表单、cookie、`localStorage`；fetch 只带 `credentials: 'same-origin'`（本站 cookie 交给本站接口）。登录由用户在 WebView 里手工完成。 |
| 2 | 不外发 | **通过**。除上面两个同源 GET/POST 外没有任何目的地；没有埋点、上报、统计。 |
| 3 | 请求域可控 | **通过**。`allowHosts` 写精确主机 `jwstudent.lnu.edu.cn`（不用通配）；请求落在页面自己的同源路径上，页面就是 `loginUrl` 所在的站点。 |
| 4 | 只读课表 | **通过**。只取 `xkxx`（课程、时间地点）与 `jcsjbs`（作息）。POST 是上游就有的查询方式，请求体只有学期代码，服务端写操作与否我们无法在本地确认（见第 7 节）。 |
| 5 | 不埋点 | **通过**。无统计、无上报、无遥测；上游的弹窗与 toast 全部去掉。 |
| 6 | 不 eval 远程代码 | **通过**。无 `eval` / `new Function` / `document.write`；取回的内容只经 `JSON.parse`；HTML 只用两个正则读字符串。 |
| 7 | 不写页面 | **通过**。只读 `#planCode`；不创建节点、不改表单、不提交、不点击。上游「切到课表页」等动作未移植。 |
| 8 | 不依赖用户输入之外的秘密 | **通过**。无硬编码学号、令牌、密钥；学期代码与校区都来自页面或用户的选择。 |

## 4. 与模板 neau 的差异（按任务卡）

| 项 | neau（模板） | lnu |
|---|---|---|
| `allowHosts` | `*.neau.edu.cn`（通配） | `jwstudent.lnu.edu.cn`（精确主机，符合硬约束 9） |
| 报错文案 | 含「HTTP」「JSON」 | 大白话（「教务系统返回错误（代码 N）」「返回的内容格式不对」） |
| 学期选择 | 无（只按当前学期 GET） | 有下拉框时取选中项，POST `planCode`；选中项是不是默认学期交给 parse.js |
| 学期名 | 按抓取日推算 | 取下拉框选中项文字；没有时「辽宁大学 + 推算的学年学期」并提醒 |
| 开学日 | 按抓取日推算 | 默认学期（或没有下拉框）时用校历 `rq`，周一对齐；否则推算并提醒 |
| 总周数 | 按课表最大周次 | 默认学期时用校历 `skzc`（1..30 才收），课表更晚则抬高并提醒；否则按最大周次推定并提醒 |
| 校区 / 作息 | 只用教务的 `jcsjbs`，没有内置表 | `__ncSelect` 问一次，四项：教务提供 / 崇山 / 蒲河 / 武圣；三张内置表逐节照抄上游；未选成则按课程校区名猜（同上游 `guessCampus`） |
| 周次 | `weekDescription` 优先，位串为辅 | `classWeek` 位串优先，`weekDescription` 文字写法为辅（上游只读位串） |
| 连续节数缺失 | 当 1 节，不提醒 | 当 2 节（照上游），并计数提醒 |
| 教师 | 只去 `*` | 照上游 `cleanTeacher`（`*` 换空格、合并空白），空 → null |
| 教室 | 直接拼接 | 照上游 `buildPosition`（去重复的校区前缀），再去掉教室名里重复的楼名，全空 → null |
| 去重 | 按课段（每个周次段） | 按安排（星期、节次、周次、地点）去重，与上游一致 |
| 节次超出作息表 | 不补 | 统一修订 H3：空课默认表同一节不早于上一节下课则用它，否则顺推；补了哪些都提醒 |
| 作息解析 | 只认 4 位或 6 位 HHmm | 同（`formatClock`）；坏行计数提醒 |

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 处理 | 理由 |
|---|---|---|
| `showAlert` 确认框、`showSingleSelection`（学期、作息来源）、`showToast` | 去掉；学期取下拉框，校区用 `__ncSelect` 问一次 | 宿主的交互由宿主统一管理；本地不弹窗（学期不选，默认就是页面当前选中的那一项） |
| `saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig` / `notifyTaskCompletion` | 去掉 | 导入由宿主完成，extract.js 只交数据 |
| `fetch(..., credentials: "include")` | 改为 `same-origin` | 请求是同源相对路径，两者在这里等价；`same-origin` 不把 cookie 发给别的站点 |
| `res.json()`（失败时直接抛原始错误） | 先取文本再 `JSON.parse`，失败给大白话 | 硬约束 7（报错不写「JSON」） |
| 教师兜底「未知」、教室兜底「待定」 | 改为 null | 空课里「未知」会当成真名显示（`docs/ux-writing.md`） |
| `parseInt(continuingSession) \|\| 2`（静默） | 保留「当 2 节」，但计数提醒 | 这是推算，不能静默 |
| `fetchCourseConfig` 失败时 `showToast` | 改为返回 null，不弹提示 | 校历取不到不阻断导入，由 parse.js 推算并提醒 |
| 作息表 `formatTime` 只认 4 位 | 同时认 6 位（`HHmmss`，取前四位） | 与模板 neau 的读法一致，见 `parse.js` 的 `formatClock` |

**没有删任何为安全而删的东西**：上游脚本本身不含凭据、不含第三方地址、不含埋点，移植只是去掉弹窗与保存桥调用。

## 6. 变异测试记录

在临时副本（`C:/Users/23703/AppData/Local/Temp/lnu-port/`）上改 `parse.js`，每次只改一处，跑 `check.js`，然后删除副本；**真实目录从未被改动**，最后自检仍为 PASS。

| 改坏哪一处 | 哪些用例变红 |
|---|---|
| ① 单双周判定反了（`runsOf` 里 `ODD` / `EVEN` 对调） | `basic`（大学英语，双周 → 单周）、`campus-guess`（数据结构，单周 → 双周） |
| ② 蒲河校区的猜测关键词改坏（`CAMPUS_KEYWORDS.puhe`） | `campus-guess`（猜不出校区，节次时间变成无） |
| ③ 连续节数缺失的默认值 2 → 1 | `campus-guess`（英语听力 7–8 节变 7 节）、`extract-dates`（体育 5–6 节变 5 节） |
| ④ 学期周数 `skzc` 不再区分默认学期 | `term-no-calendar`（总周数 18 被误用，应为 12） |
| ⑤ 开学日取消「对齐到周一」（直接用 rq） | `extract-dates`（2026-09-09 应对齐为 2026-09-07） |
| ⑥ 节次补齐的内置表分支关掉（H3） | `extract-dates`（第 11–12 节改由顺推而非内置表） |
| ⑦ 去掉「教室名以楼名开头时去掉重复楼名」这一步 | `campus-guess`（「蒲河校区文科楼101」变回「蒲河校区文科楼文科楼101」） |
| ⑧ 去掉提醒里课名截短（`nameList` 的 `shortName`，课名超过 20 字截断） | `long-names`（三门 80 字课名的提醒整条超 200 字，被 `pushWarning` 截成 199 字 + 「…」，与期望不符） |
| ⑨ 去掉 `pushWarning` 的单条 200 字截断 | **不变红，属等价变异**：所有提醒都先经 `nameList` 课名截短，单条最长约 110 字，`pushWarning` 的截断在现有输入下不可达，仅作安全网保留。已如实记录，未为凑数硬造用例。 |

另：`extract.js` 在 Node 里用桩 `fetch` / DOM 跑过一次（不联网）：POST 体为 `planCode=A2`（选中项），校区默认项正确，`indexCalendar` 只交出 `rq`、`skzc` 两个值，学号、人员 ID 等白名单外字段全部没有带出。把这一步的输出喂给 Rhino 跑 `parse.js`，得到合法载荷。

## 7. 已知风险与未验证项

1. **没有本校账号，真机没验过**。fixture 全部是合成的，只保证「同样输入永远同样输出」，不保证真实页面上解析正确。拿到真实 dump 后应替换 `fixtures/*.extracted.json`，并核对：`#planCode` 是否真存在、`xkxx` 是否是数组、`classWeek` 与 `weekDescription` 哪个有值。
2. **`rq` 与 `skzc` 的含义只按上游理解**：上游把 `rq` 当开学日用（同平台 AUFE 也是这样用的）；`skzc` 被上游当作学期总周数，但我们没有在别处看到旁证，**按上游理解、未实测**。`/indexCalendar` 页面在本校是否存在、返回什么，都没有验证。
3. **POST 的语义**：上游用 POST 带 `planCode` 取非当前学期的课表，我们照做；服务端是否有写副作用我们无法本地确认，但请求只带一个学期代码，且是上游的既有写法。
4. **明文 http 登录页**：`loginUrl` 与上游 `import_url` 一样是 `http://`。这是学校自己的站点；我们只是让用户在 WebView 里打开它，不在脚本里发任何凭据。
5. **校区猜测的口径**：上游作者注明「教务给的时间可能把校区搞混」，所以我们让用户选；猜测只决定默认选项，猜错了 warnings 会说明用的是哪张表，可在「学期管理」里改。
6. **宿主桥**：`__ncSelect` 依赖宿主的 `__ncCapabilities.ask`。桥不在时校区为 null，走猜测 / 教务时间表回落，并有提醒。
7. **学期名的兜底**：任务卡写的是「照 neau 推算」，全局规则 8 写的是「学校名 + 学年学期」。这里取后者，即「辽宁大学 2026-2027学年第一学期」。若主调度希望与 neau 一致，去掉前缀即可。
8. **提醒条数上限 20 条**：超出的提醒被静默丢弃（模板行为）。本校正常情况下 6–8 条，不会触发。

## 8. 对上游的改动与审计修复（不涉及安全，记一下）

- 审计 B1（超长提醒）：上游没有提醒限长概念；本件的提醒若含三门约 80 字的课名（都缺连续节数）会超过 200 字，应用会整包拒收。修法：课名在提醒里截到 20 字（`shortName`，超出以「…」结尾，只显示前 3 门、其余计数）；`pushWarning` 对每条再限长 200 字（超出截断并以「…」结尾），条数上限 20 另计。`long-names` 用例钉住课名截短。
- 地点：上游 `buildPosition` 只去掉楼名、教室名以校区名开头时的校区前缀，不去掉「教室名以楼名开头」的楼名，所以会得到「崇山校区文科楼文科楼101」。这里在去校区前缀之后再加一步：教室名以楼名开头时去掉教室名里重复的楼名，得到「崇山校区文科楼101」（主调度决定；`campus-guess` 用例固定此结果，变异 ⑦ 钉住这一步）。
- 上游 `parseTimeSlots` 对坏的节次时间不校验；这里逐行校验（开始 < 结束、格式为 HH:mm）并计数提醒。
- 上游作息表缺节时没有补齐；这里按 H3 逐节补齐并提醒。
- 上游周次只读位串；这里位串缺失时退回文字写法（与模板 neau 一致）。

签名：0x7E7-2023（haiku 移植，2026-10-17）
