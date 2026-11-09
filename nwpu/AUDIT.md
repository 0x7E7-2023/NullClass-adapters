# 西北工业大学（`nwpu`）适配器 —— 安全审计

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) → `resources/NWPU/nwpu_01.js`（MIT，455 行）。文件头作者与 `adapters.yaml` 的 maintainer 都是 zengzoxiong |
| 上游快照 | `baf83fa`（2026-11-09，已与 origin/main 对齐）。`git log -1 --format=%h -- resources/NWPU/nwpu_01.js` 得到 **`1fe584c`**，与任务卡说明一致 |
| 上游平台 | 树维学生端（上海树维 SupWisdom）：`jwxt.nwpu.edu.cn/student/for-std/...`，print-data 接口与 cupk / jstc / zzu 同一套；不是 neuq / yangtzeu 的旧 EAMS `courseTableForStd.action` |
| 本适配器 | `jw-adapters/nwpu/`。`extract.js` 只取数（331 行），`parse.js` 纯转换（692 行） |
| 移植者 | 0x7E7-2023（haiku 移植，2026-11-09） |
| 结论 | **安全性通过**（§2）。**正确性未在真机验证**：没有本校账号，fixture 与浏览器冒烟都是合成的 |

**模板用 `cupk`，不用 `neuq`。** 理由：本校上游与 cupk 走完全相同的三条 for-std 接口（课表页 HTML、`ws/semester/get`、`print-data`），字段名 `studentTableVm(s)` / `activities` / `timeTableLayout.courseUnitList` 逐字相同；neuq 是旧 EAMS，周次是位图、课表是 HTML 里的 `TaskActivity`，这两层都得推翻重写，只剩登录判断能复用。cupk 已审计、fixtures 与冒烟齐全，改动面最小。

## 0. 本校上游脚本分析（与模板的不同构之处）

上游 `runImportFlow()` 的顺序是：确认弹窗 → 取课表页 HTML（学期下拉 + `var dataId`）→ 弹窗选学期 → `print-data` → `ws/semester/get` → 取 `timeTableLayout.courseUnitList` → 拼配置 → 三段保存。

与 cupk 的不同构之处（逐条都在代码里改过）：

1. **print-data 地址带学生 id**：`/student/for-std/course-table/semester/{semesterId}/print-data/{studentId}`，cupk 没有这一段。学生 id 只从课表页 HTML 的 `var\s+dataId\s*=\s*(\d+)` 取（`dataIdFromHtml`），只当请求路径参数用；取不到就报错提示重新打开课表页——上游那条降级接口 `getStdInfo` 是学生信息接口，按移植手册 §5「只请求课表」**没有移植**。
2. **节次时间是 HHmm 整数**：上游 `formatTime(830)` → `08:30`。`parse.js:165` `fmtTime` 保留这条转换（三位数补前导零，四位数直接切，也认 `8:30` / `08:30:00`）。
3. **上游写死了一张 13 节表**（长安校区），API 没给 `courseUnitList` 时整张使用。cupk 没有写死表、缺节次只提醒。这里 `parse.js:33` 逐节照抄上游原值。
4. **上游连总周数都没算**（`semesterMeta` 交给拾光），且回退时把课表最大周当学期长度。这里按移植手册：校历优先，没有用 20，课表更晚才抬高并提醒（绝不用最大周代替学期长度）。
5. **上游弹窗选学期**：改为读页面当前学期（地址 → 下拉的 selected → 第一个 + 提醒），`extract.js:180` `pickSemester`。
6. **教师只取第一位**（`act.teachers[0]`）；这里把数组里的教师都拼出来（`parse.js:354` `teachersOf`），见 §4 第 5 条。
7. **教室**：上游 `room || building || "未知地点"`；这里同序，占位词一律 null（`parse.js:377` `locationOf`）。

**内置节次时间（逐节照上游 `getDefaultTimeSlots()`，`parse.js:33`–`48`）**

| 节 | 起 | 止 | 节 | 起 | 止 |
|---|---|---|---|---|---|
| 1 | 08:30 | 09:15 | 8 | 14:55 | 15:40 |
| 2 | 09:25 | 10:10 | 9 | 16:00 | 16:45 |
| 3 | 10:30 | 11:15 | 10 | 16:55 | 17:40 |
| 4 | 11:25 | 12:10 | 11 | 19:00 | 19:45 |
| 5 | 12:20 | 13:05 | 12 | 19:55 | 20:40 |
| 6 | 13:05 | 13:50 | 13 | 20:40 | 21:25 |
| 7 | 14:00 | 14:45 | | | |

这张表是**上游作者写死的长安校区时间**，不是从教务读的；用到就在 warnings 里说明并请学生核对。

## 1. 请求清单

只在当前页主机就是 `jwxt.nwpu.edu.cn`、且不是登录页时发请求。翱翔门户（`ecampus.nwpu.edu.cn`）与其它主机一律只提示、**零请求**（`extract.js:279`）。

| # | 方法 | 地址 | 干什么 | 拿不到时 |
|---|---|---|---|---|
| 1 | GET | `https://jwxt.nwpu.edu.cn/student/for-std/course-table` | 读学期下拉（先 `#semesters`，再 `#allSemesters`），以及页面里的 `var dataId = N` | 没有学期列表 → 报错，不猜学期；没有 `dataId` → 报错「没能在课表页面读到学生编号」，不发下一条 |
| 2 | GET | `https://jwxt.nwpu.edu.cn/student/ws/semester/get/{id}` | 开学日、结束日、一周从哪天开始、学期名 | `getJsonOptional` 交 null，不阻断；`parse.js` 用 20 周并提醒 |
| 3 | GET | `https://jwxt.nwpu.edu.cn/student/for-std/course-table/semester/{id}/print-data/{studentId}` | `studentTableVms[0]` → `studentTableVm` 里的 `activities`；`timeTableLayout.courseUnitList`（先认响应顶层，再认表里的） | 报错。地址没有查询串，与上游一致 |

学生 id 只出现在第 4 条的地址里（上游同样如此），**不写进输出、不写进任何提醒或报错**；`user={id}` 只在本校域名内使用。没有提问桥（上游的确认弹窗与选学期弹窗都没搬）。

## 2. 移植手册 §5 八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读密码框的值（只判断页面上有没有密码框，`extract.js:86`），不读 Cookie / 本地存储；只用已登录页面的同源会话 |
| 2 | 不外发 | 通过。只有上表 3 个 GET，全打 `jwxt.nwpu.edu.cn`；没有上报、外链脚本、`sendBeacon`、WebSocket |
| 3 | 请求域可控 | 通过。脚本里只有 `jwxt.nwpu.edu.cn` 一个绝对主机；`allowHosts` = `["ecampus.nwpu.edu.cn","jwxt.nwpu.edu.cn"]`，不写通配。门户主机只用于登录页提示，不发请求 |
| 4 | 只读课表 | 通过。不请求成绩、学籍、缴费，也不请求学生信息接口——上游那条降级通道 `getStdInfo` 没有移植；学生 id 只从课表页 HTML 的 `var dataId` 读、只当请求路径参数，输出按 §3 白名单挑 |
| 5 | 不埋点 | 通过 |
| 6 | 不 eval | 通过。无 `eval`、`new Function` |
| 7 | 不写页面 | 通过。`DOMParser` 只解析取回来的 HTML 字符串；不提交表单、不改 DOM |
| 8 | 不硬编码秘密 | 通过。无学号、无密钥、无其它人的 id |

## 3. 读了什么、交出去什么

`extract.js` 交出去（逐字段白名单）：

- `term`：`id`、`label`、`pickedBy`（`url` / `selected` / `first`）
- `semesters`：`id`、`label`、`selected`
- `semesterMeta`：`startDate`、`endDate`、`weekStartOnSunday`、`firstDayOfWeek`、`nameZh`、`name`
- `activities`（`pickActivity`，`extract.js:241`）：`courseName`、`teachers`（数组或串）、`room`、`building`、`weekday`、`startUnit`、`endUnit`、`weekIndexes`
- `courseUnitList`（`pickUnit`）：`indexNo`、`startTime`、`endTime`

没有带出的：`studentId`、`dataId`、学号、姓名、证件号、`studentCode`、`studentName`、`idCard`、成绩/学籍的任何字段。`semesterMeta` 里若夹带个人信息也在 `pickMeta` 处丢掉。

`parse.js` 只用上面这些，另外接受夹具里的 `today`（只为钉住「教务没给开学日」时的推算，`extract.js` 不传）。

教师 / 教室写成 `未知`、`未知地点`、`待定`、`暂无`、`暂无教师`、`暂无教室` 时，交出去是 `null`。

## 4. 与模板 `cupk` 的差异

1. 主机与入口：`jwxt.nwpu.edu.cn`，`loginUrl` 是翱翔门户 `https://ecampus.nwpu.edu.cn/`；`scheduleUrlHint` 填课表页完整地址（学期下拉和数据 `dataId` 都在这一页）。
2. print-data 地址带 `/{studentId}`：学生 id 从课表页 HTML 的 `var dataId` 读，读不到就报错（不请求学生信息接口）。
3. 节次时间：加了上游写死的 13 节表（逐节见 §0），以及「统一修订 H3」的逐节补时间（`parse.js:533`–`588` 建表补时间，`parse.js:648`–`664` 进提醒）：本校表里有这一节且不早于上一节下课就用它；没有就给不出就按上一节下课后课间 5 分钟、每节 45 分钟顺推；越过 23:59 的不补并说明。补了哪几节、哪几节补不了都进 warnings。
4. 教室不再拼校区（上游只 `room || building`，模板会加校区前缀）。
5. 教师数组里的名字全部保留并用逗号连接（上游只取第一位），缺教师仍然 null。
6. `weekIndexes` 若是文字，按 `cupk` 同一套规则解析（前置 / 后置单双、`共 N 周`、`第1-第8周`）。
7. 提醒里所有拼进去的教务原文（学期名、课名、周次原文、备注原文）先截到 20 字；每条最终 ≤200 字。
8. 登录页 / 门户 / 外站：只提示、不发请求（模板也这样，本条沿用）。

## 5. 上游里删掉或改掉的

- 确认弹窗、`showSingleSelection` 选学期、`showToast` / `showAlert` / `savePresetTimeSlots` / `saveCourseConfig` / `saveImportedCourses` / `notifyTaskCompletion`：拾光桥能力，空课由宿主保存，适配器只交载荷。
- 「无课程数据就再选一个学期」的循环：空课一次只导入当前学期，空课表直接报错说明。
- `teacher = "未知教师"`、`position = "未知地点"`：改为 null 并提醒到「编辑课程」补。
- 降级接口 `getStdInfo` **删除**：它是学生信息接口，移植手册 §5 只允许请求课表；`dataId` 缺失时改为报错提示重新打开课表页。
- 上游回退「用课表最大周当学期总周数」改掉，见 §0 第 4 条。

## 6. 本校边界（夹具）

共 8 对，期望值按规范与代码手工推演，不是把 `parse.js` 输出存下来。

| 夹具 | 覆盖 |
|---|---|
| `basic` | 13 节 HHmm → HH:mm 逐节转换；重复行并成 1–18 周；单周 1–15 / 双周 2–16；`林某(1)` 去掉序号；未知 / 暂无 / 待定教师与教室 → null；多个学期只导当前 |
| `no-units` | 教务没给 `courseUnitList` → 整张用 13 节表并提醒；课表用到第 14 节 → H3 顺推 21:30–22:15 并提醒 |
| `weeks-text` | `(单)1-8周(双)9-16周` → 1–7 单周 + 10–16 双周；后置单双同样读对；`共8周` 不吞后半；`第1-第8周`；单双同时出现；`(实验)` 备注 |
| `long-warn` | 4 门长课名缺教师 / 教室，课名截 20 字后两条提醒各 105 字 |
| `no-calendar` | 学期接口没数据 → 开学日按 `today` 推算、总周数 20（不用最大周 16） |
| `over-calendar` | 校历 16 周、课表到第 20 周 → 抬到 20 并提醒 |
| `raise-default` | 无校历但排到第 22 周 → 20 抬到 22 并提醒 |
| `dirty` | 未标当前学期；缺课程名 / 星期 / 节次 / 周次共 5 条；周次 0 与负数；第 31 周被丢；周次文字认不出；`暂无教师` / `未知` 教室 → null |

## 7. 变异测试

在临时目录的副本上改坏（副本目录名仍是 `nwpu`，否则 `manifest.key` 校验会先红），跑自检，再还原。四处都变红：

| 改坏哪一处 | 变红的夹具 |
|---|---|
| `fmtTime` 去掉三位数补前导零（HHmm 转换） | `basic`、`weeks-text`、`long-warn`、`no-calendar`、`over-calendar`、`raise-default`、`dirty` |
| H3 顺推的课间 5 分钟改成 10 分钟 | `no-units` |
| `placeholder` 不再把「待定」「暂无」当空 | `basic` |
| `weeksFromText` 的前置单双标记不再隔开下一段 | `weeks-text` |

还原后 `RESULT: PASS`（8 对 MATCH）。

## 8. 浏览器冒烟（`.test/port-batch32/nwpu/smoke.py`）

Playwright 起假站拦截全部请求，不联网（本机没装 Playwright 自带 chromium，脚本用系统 Edge 内核）。13 个场景全部 OK：

- `normal`：三个请求的顺序与地址精确匹配（`…/print-data/98765`），学期名 / 开学日 / 20 周 / 第 1 节 08:30 正确；
- `url-semester`：地址里的 `semester/171` 优先；
- `no-selected`：没有 selected → 取第一个并提醒；
- `no-dataid`：页面没有 `dataId` → 报「学生编号」并且不发 print-data（也不请求任何学生信息接口）；
- `no-semesters`：页面没有学期下拉 → 报错；
- `login-page` / `portal` / `other-host`：直接报错、**零请求**；
- `expired`（401）/ `print-500`：报「请先登录」/「教务系统返回错误（代码 500）」；
- `meta-500`：学期接口失败仍能导入，开学日推算 + 20 周提醒；
- `empty`：空课表由 `parse.js` 报错。

每个场景都断言：请求只打 `jwxt.nwpu.edu.cn`；请求地址里没有姓名 / 学号 / 证件号；取数结果与课表里没有 `studentCode`、没有学生 id、没有姓名。

## 8.1 2026-11-10 复审修正

| 编号 | 问题 | 修正 | 捕获方式 |
|---|---|---|---|
| R1 | 学期下拉先取 `#semesters`，该元素存在但为空（页面脚本事后填充，服务端原文是空 `<select>`）时不回退到 `#allSemesters`，整次导入报「没能在课表页面读到学期列表」；上游只认 `#allSemesters`，同一页面能正常导入 | 取到空列表就换另一个下拉 | 冒烟场景 `empty-semesters`；把回退删掉后该场景变红 |
| R2 | AUDIT §2 仍写着「4 个 GET」与「降级通道 `studentIdFallback`」，与本轮删除 `getStdInfo` 后的代码不符 | 改成 3 个 GET，并写明降级接口没有移植 | 与 `extract.js` 逐一对照 |

## 9. 没验的部分

- 没有本校账号。请求路径、字段名、节次时间表全部来自上游脚本，真机若改版，缺字段会进提醒或报错，不会静默交出错课表。
- `ws/semester/get/{id}` 返回里到底有没有 `startDate`/`endDate` 只看上游代码；拿不到时走「按今天所在的周一推算 + 20 周」并如实提醒。
- 课表页 `var dataId = N` 的写法照上游正则；若页面改成别的方式，会报「没能在课表页面读到学生编号」而不是去请求学生信息接口——这种情况需要拿到真实页面再补读法。
- 节次表是上游写死的**长安校区**版本；友谊校区时间不同，真机需要核对（warnings 里已经请学生核对）。
- 艺术 / 实验课若在教务里把教室写在其它字段（如 `roomName`），这里认不到，会按缺教室提醒，不会静默丢课。

0x7E7-2023（haiku 移植，2026-11-09）
