# 大连理工大学（`dlut`）适配器 —— 安全审计

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) → `resources/DLUT/dlut_01.js`（MIT） |
| 上游快照 | 仓库 `1dc0772566ba610f495906410734db4e7b8ef0c1`（2026-10-17）；本校脚本最后一次修改 `0de4191`（2026-09-17）。学校名与登录地址取自同目录 `adapters.yaml`（`import_url`，maintainer `dffzcqs78694`） |
| 上游平台 | 树维 `for-std`（`jxgl.dlut.edu.cn/student/for-std/...` + `/student/ws/...`） |
| 本适配器 | `jw-adapters/dlut/`，按适配器规范切两段（`extract.js` 只取数 / `parse.js` 纯转换）+ 降 ES5 |
| 模板 | `jw-adapters/jstc/`（同为树维 for-std）；取数接口与字段读法参照 `jw-adapters/ustc/`（排课记录按 `startTime` / `endTime` 换算节次） |
| 审计范围 | `extract.js`、`parse.js` 全文，`manifest.json` 的 `allowHosts` / `loginUrl` |
| 审计日期 | 2026-10-17 |
| 审计 / 移植 | 0x7E7-2023（haiku 移植，2026-10-17） |
| 结论 | **安全性通过**（逐条见 §2，请求域见 §1）。**正确性未验**：没有本校账号，fixture 是合成的，真机没跑过，见 §5 |

---

## 1. 请求了哪些域

脚本只请求**同源相对路径**，不写死主机。运行时主机就是用户正在用的教务页面所在主机，即 `jxgl.dlut.edu.cn`，与 `allowHosts` 一致。

| # | 方法 | 路径（同源） | 拿什么 | 取不到时 |
|---|---|---|---|---|
| ① | GET | `/student/for-std/course-table` | 课表页 HTML：学期下拉框 `#semesters` / `#allSemesters`；`stdPersonId`（三条正则，上游原样） | 学期列表读不到 → 报错停止；`stdPersonId` 读不到 → 按上游传 `null` 继续 |
| ② | GET | `/student/for-std/course-table/get-data?bizTypeId=2&semesterId={id}` | JSON：`lessonIds`、`timeTableLayoutId` | 网络 / 状态码 / 非 JSON → 报错停止；`lessonIds` 为空 → 报错停止 |
| ③ | POST | `/student/ws/schedule-table/datum`（`Content-Type: application/json`，体 `{"lessonIds":[…],"studentId":null,"stdPersonId":<①>,"weekIndex":null}`） | JSON `result.lessonList` / `result.scheduleList`（课程与排课明细） | 结构不对（没有这两个数组）或请求失败 → 报错停止（报错文字提示「可能没有登录或会话已过期」） |
| ④ | POST | `/student/ws/schedule-table/timetable-layout`（体 `{"id":<②的 timeTableLayoutId>}`） | JSON `result.courseUnitList`（节次时间，HHmm 整数） | 任何失败 → 交 `null`，`parse.js` 回落内置 12 节并写进 warnings |
| ⑤ | GET | `/student/ws/semester/get/{id}` | JSON `startDate` / `endDate` / `nameZh` | 任何失败 → 交 `null`，`parse.js` 推算开学日并写进 warnings |

- 出现的主机只有一个：`jxgl.dlut.edu.cn`（教务系统本体）。
- `loginUrl`（`http://jxgl.dlut.edu.cn/student/for-std/course-table`）是 WebView 的打开地址，脚本不请求它；登录会跳统一身份认证，那一步由教务自己完成。
- 上游脚本里没有别的域（上游 `dlut_01.js` 只有上述路径，没有第三方 URL）。

**上游文件头注释与代码不一致**：注释写的是 `/student/ws/schedule-table/get-data`，代码实际请求的是 `/student/for-std/course-table/get-data`。本适配器以代码为准。

## 2. 移植手册 §5 八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | **不碰凭据** | ✅ 不读登录表单、不读 `localStorage` / `sessionStorage`、不读令牌或密码字段，也不把任何东西发回去。取数只用用户已登录页面自带的会话 Cookie（`credentials: 'include'`，同源）。 |
| 2 | **不外发** | ✅ 全文只有 `fetch`，全部是同源相对路径；没有 `XMLHttpRequest`、`sendBeacon`、`WebSocket`、`EventSource`、`new Image().src`，也没有第三方脚本或 CDN 引用。 |
| 3 | **请求域可控** | ✅ 见 §1：只有一个主机，写进 `allowHosts`（`jxgl.dlut.edu.cn`，精确主机，没有通配）。 |
| 4 | **只读课表** | ✅ 5 个请求依次是课表页、课程数据、排课明细、作息表、学期日期。没有成绩、学籍、个人信息、缴费、选课类接口。第 ③ 步的 `datum` 是课表明细查询，按上游原样调用。 |
| 5 | **不埋点** | ✅ 无统计、上报、遥测、匿名上报，无外部资源引用。 |
| 6 | **不 eval 远程代码** | ✅ 无 `eval`、`new Function`、`document.write`、字符串形式的 `setTimeout`；`JSON.parse` 只解析教务返回的内容，失败即报错。 |
| 7 | **不写页面** | ✅ 不写 DOM、不改表单、不触发提交、不点击元素。`DOMParser` 只在内存里解析取回的 HTML 字符串，不挂到文档上。学期取自 URL 或页面当前状态，没有点击切换。 |
| 8 | **不依赖输入之外的秘密** | ✅ 无硬编码密钥、无他人学号、无固定令牌。唯一的运行时信息是当前页面里的会话 Cookie（用户自己登录得来的）和页面里的 `stdPersonId`。 |

补充：

- **没有交互**：不使用 `__ncSelect` / `__ncConfirm` / `__ncPrompt`，也不用弹窗索要任何信息。上游的「选学期」弹窗与「导入提醒」公告都去掉了，改为取页面当前打开的学期。
- **没有 OCR 桥**：不调 `__ncOcr` / `__ncOcrGrid`，课表来自接口。
- **`stdPersonId` 是个人 ID**：只放进第 ③ 步的请求体，不进交出去的对象，也不进任何报错文字。

## 3. 读了什么数据、交出去什么

`extract.js` 交出去的 JSON 是**字段白名单**挑出来的，不整对象转交：

| 对象 | 字段 | 说明 |
|---|---|---|
| `term` | `id`、`label`、`pickedBy` | `id` 是学期号；`label` 是下拉框选中项的文字；`pickedBy` 是 `url` / `selected` / `first`，说明是怎么选中的 |
| `semesterCount` | 数字 | 下拉框里去掉空值与 `all` 后的学期数，用来在 warnings 里说明「还有几个学期」 |
| `semesterMeta` | `startDate`、`endDate`、`nameZh`（拿不到则 `null`） | 只来自 ⑤ |
| `lessonList[]` | `id`、`courseName`、`teachers[]`（只留教师姓名字符串，去重） | 课程 ID 与课程名 |
| `scheduleList[]` | `lessonId`、`weekday`、`startTime`、`endTime`、`weekIndex`、`date`、`personName`、`roomName`（取 `room.nameZh`）、`customPlace` | `personName` 是**排课教师**姓名，不是学生；`roomName` 只留 `nameZh`，不带教室的其它字段 |
| `courseUnitList` | `indexNo`、`startTime`、`endTime`（或 `null`） | 节次时间，HHmm 整数原样交出 |

**不交出去的**：`stdPersonId`、`timeTableLayoutId`、`lessonIds`、`studentId`（请求体里为 `null`）、`datum` 与 `get-data` 里的其它字段、`semesterMeta` 以外的学期字段、教师与教室对象里的其它字段（如 `building`、教师 ID）。

## 4. 与模板 jstc 的差异

| 项 | jstc（模板） | dlut |
|---|---|---|
| 课表数据来源 | `/semester/{id}/print-data` 的 `studentTableVms[0].activities` | `get-data` + `POST datum` 的 `lessonList` / `scheduleList`（照 ustc 同构） |
| 一条记录 | 一条 activity 带 `startUnit` / `endUnit` / `weekIndexes` | 一条排课 = 一门课在一个星期几、一个时段、**一周**（`weekIndex` 单值）；节次由时间换算 |
| 节次换算 | 直接用 `startUnit` / `endUnit` | 按排课 `startTime`/`endTime` 落在节次时间范围内换算；对不上取最近一节（≤60 分钟）；都超过则跳过并点名 |
| 课程聚合 | 按「课名 + 教师」 | 按 `lessonId`（课程 ID） |
| 分组键 | 课程 + 星期 + 节次段 + 教室，周次并集 | 原始分组 `(lessonId, 星期, 开始, 结束, 教室)`，映射到节次段后再并集（见 §6） |
| 作息表兜底 | 上游内置 11 节 | 上游内置 12 节（`FALLBACK_TIME_SLOTS`，逐节照抄） |
| 开学日回退 | `weekStartOnSunday` + `firstDayOfWeek` | 对齐到周一（移植手册 §4.3）；没有 `startDate` 时用排课最早日期回推 |
| 总周数 | `ceil((天数 + 1) / 7)`（含首尾） | 上游写法 `ceil(相差天数 / 7)` |
| 学期名兜底 | 「学年学期」推断 | 「大连理工大学 + 学年学期」（不许用适配器名） |
| 教师合并 | 「,」连接 | 「、」连接（与公共说明一致） |

## 5. 上游被删掉 / 改掉的东西及理由

| 上游 | 本适配器 | 理由 |
|---|---|---|
| `promptUserToStart` 导入提醒弹窗 | 删 | 我们不用弹窗索要确认；取数只在用户点「提取课表」时发生 |
| `showSingleSelection` 选学期弹窗 | 改为取页面当前学期（URL → `selected` 属性 → 第一项） | 同 jstc；选中方式写进 warnings |
| `window.shiguangBridge*` 提示、保存、完成通知 | 删，改为返回 JSON 字符串 | 规范 §5：extract 只交出数据，保存由应用端做 |
| `fetchSemesterInfo` 原样返回整个 JSON | 白名单 `startDate` / `endDate` / `nameZh` | §3 字段白名单 |
| `fetchDatum` 等把整个 lesson / schedule 交给解析 | 字段白名单 | §3 |
| `calcSemesterStartDate` 的 `new Date(字符串)` + `toISOString().split('T')[0]` | 整数天数运算（`Date.UTC` + `getUTC*`） | 上游在北京时间早上 8 点前会退一天（移植手册 §4.3 / 任务卡） |
| 上游 `config.semesterStartDate = semesterInfo.startDate`（原样） | 对齐到周一，不是周一要提醒 | 移植手册 §4.3：日期不是周一会整体偏 |
| 上游 `Math.ceil((end - start) / day)` 用 `Date` 相减 | 整数天数相减 | 同上，避免时区 |
| 上游每个 `(lessonId, 星期, 时间)` 组各出一门课（同名多条） | 按课程合并，多个时段放在同一门课的 `blocks` 里 | 规范：一门课一个 course，时段进 blocks |
| 上游教师名用空格连接 | 「、」连接 | 与公共说明统一 |
| 上游 `config.defaultClassDuration` / `defaultBreakDuration` / `firstDayOfWeek` | 不交出去 | 这些不在载荷里；每周起始日由 `firstDay` 表达 |
| 上游 `FALLBACK_TIME_SLOTS` 与 `buildTimeSlots` | 保留 12 节数值，但**只在整张表缺失或不合法时**用，并写进 warnings | 上游只在 `courseUnitList` 缺失时用内置表，没有逐节校验；本适配器改为整表校验 |
| 上游文件头注释里的 `get-data` 路径 | 以代码的 `/student/for-std/course-table/get-data` 为准 | 文件头与代码不一致（见 §1） |

## 6. 移植中的有意偏离

- **分组键多带教室**：上游的分组键是 `(lessonId, weekday, startTime, endTime)`，同一时段两间教室的排课会被合并掉一间。这里多带上教室，两间都保留（不会重复计数，因为映射到节次段后仍按节次段并集）。
- **同一节次段并集**：不同原始时间映射到同一节次段（例如 `10:05-10:50` 与 `10:00-10:55` 都映射到第 3 节）时，周次取并集，不会出现重复 block。
- **跳过的时段都进 warnings**：时间不合法、星期越界、没有周次的排课记录按类型计数；离所有节都超过 60 分钟的时段点名（最多 3 门课名）。课程的所有时段都被跳过时，这门课不出现在课表里，但仍在 warnings 里有迹可查。

## 7. 变异测试记录

在临时目录副本上改坏 `parse.js`，跑 `check.js`，必须有用例变红；原目录未改动，还原后自检 PASS。

| # | 改坏哪一处 | 哪条用例变红 |
|---|---|---|
| M1 | 最近一节阈值 `NEAREST_MINUTES` 60 → 0（最近一节规则失效） | `section-edge`：`大学物理` 09:50-10:00 不再放入第 3 节，变成「超过 0 分钟」的跳过提醒，总周数也随之变 |
| M2 | 去掉开学日对齐到周一（`firstDay = mondayOf(startDay)` → `firstDay = startDay`） | `section-edge`（开学日 2026-09-09 应为 09-07）、`over-calendar`（应为 2025-09-01） |
| M3 | 去掉教师从课程名单兜底（只用排课教师） | `basic`、`section-edge`、`no-meta`、`over-calendar`（课程教师变成 `null`） |
| M4 | 单双周类型对调（`ODD` ↔ `EVEN`） | `basic`（`大学英语(2)` 的 1,3,5,7 周应为 ODD；`线性代数` 的 2,4,6,8 周应为 EVEN） |
| M5 | 去掉「没有排课的课」点名 | `basic`（warnings 少一条）、`section-edge`（warnings 少一条） |
| M6 | 去掉课名截短（`clipName` 直接返回原名，B1 修复的一半） | `long-names`：三条提醒里的课名全部变成完整英文名，与期望的截短形式不符 |
| M7 | 去掉整条提醒限长（`pushWarning` 不再调用 `clipText`，B1 修复的另一半） | 无用例变红，见下方说明 |

M1–M6 全部变红。M7 不变红，原因：课名已在 `clipName` 里截到 20 字，`long-names` 的三条提醒都在 200 字之内，整条限长这一道目前只是后备。它会在「非课名部分」超长时起作用（例如教务给的学期名超长），目前没有 fixture 覆盖这种情况。原文件已还原，`check.js` 对原目录 PASS。

## 8. 与任务卡有出入的地方（需要主调度确认）

1. **任务卡的「10:00–11:40 对不上节次表」这个例子其实能对上**：第 3 节 10:05–10:50 与第 4 节 10:55–11:40 都完整落在 10:00–11:40 之内，按上游口径应放入第 3–4 节。因此边界用例改用 09:50–10:00（确实对不上任何节，按最近一节放入第 3 节）。
2. **H3「节次超出节次时间表时逐节补齐」没有实现**：节次号只从正在使用的作息表（教务的或内置 12 节）里映射出来，映射结果不可能超过表长，所以补齐分支不会被触发。本适配器没有写这段代码，也没有 fixture 覆盖它。如果主调度希望保留，需要先定义「节次表之外的节次从哪里来」。
3. **任务卡的「一门课一个 block」与上游的「一组一门课」不同**：本适配器按课程合并，见 §5 最后两行与 §6。

## 9. 已知风险与未验证项

- **登录地址是明文 http**（`http://jxgl.dlut.edu.cn/...`，来自上游 `adapters.yaml` 的 `import_url`）。WebView 第一次打开的是明文地址，会在那一步暴露给同一网络上的中间人，然后跳统一身份认证。这是上游的配置，本适配器没有改，也无法在本适配器内修。
- **没有本校账号，真机没跑过**：请求路径、请求体、响应字段（`lessonIds`、`timeTableLayoutId`、`lessonList`、`scheduleList`、`courseUnitList`、`startDate` / `endDate`）全部照上游代码读取，没有对照真实响应验证。
- **`stdPersonId` 的三条正则**是上游原样，没有验证它们能否在当前教务页面上取到；取不到时按上游传 `null`，由教务决定能否返回数据。
- **星期编号口径**：假定 `weekday` 为 1=周一…7=周日（任务卡与公共说明的口径）。上游代码直接使用 `weekday`，没有做换算，本适配器也没有验证。
- **排课明细的 `date` 字段**：只在没有 `startDate` 时用于回推开学日；本适配器假定它是 `yyyy-MM-dd` 形式。
- 合成 fixture 的数据形状是按 extract 的白名单编造的，不是真实抓取。
- 上游脚本本身在 2026-10-17 的快照里是否还能跑通，未验证。

## 10. 审计修复记录

| 编号 | 问题 | 修法 | 对应变异 / fixture |
|---|---|---|---|
| B1 | 带课名的提醒没有限长。「离所有节次超过 60 分钟已跳过（涉及…）」「按最近一节放入」「另有 N 门课…例如 A、B、C」把课名原样拼进去，三门约 70 字的英文课名就能让一条超过 200 字，整次导入被拒收 | 所有提醒统一经过 `pushWarning`：每条超过 200 字截断并以「…」结尾，条数上限 20，同文去重；点名的课名经 `clipName` 截到 20 字（超出以「…」结尾） | M6、M7；fixture `long-names`（三门长课名分别触发三条提醒） |
| B2 | 非 2xx 报错写成「教务系统返回异常状态码：N」，学生看到的是技术词，也没有出路 | 改为「教务系统返回错误（代码 N）：请先在页面里登录，并打开「课表查询」页面」，与 401/403 的写法一致 | 人工核对：全目录 `grep` 「状态码」「HTTP」「JSON」「接口」，学生可见的字符串里已无这些词（剩余命中都在代码或注释里） |
