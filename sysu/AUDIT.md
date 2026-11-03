# 中山大学（本科）教务适配器 · 安全审计与移植说明

## 出处

- 上游：`shiguang_warehouse` 的 `SYSU/sysu.js`（621 行），仓库 https://github.com/XingHeYuZhuan/shiguang_warehouse（MIT），维护者 JXCZ。
- 上游快照：`29498b026708ecb8d837c8fdc1e53b768a394e4e`（2026-11-03 与 origin/main 对齐，提交 29498b0）。
- 本校脚本最后一次修改：`80e30cf`（批量合并提交）。已用 `git -C C:/Users/23703/AppData/Local/Temp/sgw-latest log -1 --format=%h -- resources/SYSU/sysu.js` 核对。
- 同目录 `sysu_01.js`（研究生系统，cms.sysu.edu.cn）本批不移植。
- 模板：库里没有同平台件（中山大学自建教务 `jwxt.sysu.edu.cn` 的 JSON 接口）。`extract.js` 按上游重写；`parse.js` 的周次切段、提醒限长、节次顺推骨架参照同族已审计件 `hueb`（照模板 hueb 的统一修订 H3 与校历回退周一）。

## 上游分析（按批次十任务卡颗粒度）

**与模板的不同构之处**

1. 上游是「JSON 接口 + 弹窗」：先弹「学年」输入框（默认 2026）、再弹「学期」单选框，然后 `POST` 课表 JSON、`GET` 校历。模板 hueb 是「页面下拉框 + 表单 POST」。这里不弹窗，学年学期按今天日期推算（见下文「学期推算」）。
2. 上游没有作息接口，节次时间是写死的 11 节表（`TIME_SLOTS`，逐节照抄）。模板 hueb 多取一个作息接口，这里不取。
3. 上游没有读令牌（没有 `Authorization`、没有读 localStorage）。请求只靠浏览器会话（`credentials: 'include'`）。
4. 周次文字格式（上游只认一种）：`timeDetail` 形如 `1-17每周` 或 `1,3,5周`。上游的 `parseWeeks` 只取第一个 `(\d+)\s*-\s*(\d+)` 区间，因此：
   - `1-16(单周)`、`1-16周(单)`、`(单)1-8周,(双)9-16周` 的单双标记全部丢失，整段变成每周都上；
   - `第1-第8周` 不匹配区间正则，走「数字堆」分支，变成只有第 1、8 两周；
   - `1-15周(单) 共16周` 的「共16周」被当成第 16 周；
   - `(1)` 之类的教学班序号被当成第 1 周。
   这些在本适配器里都要改对（见 fixture `week-markers`）。
5. 上游把每一行当成一门课（`courses.push`），不合并、不去重。这里只去掉完全相同的行（同课名、教师、教室、星期、起止节次、周次都相同），不做连堂合并。
6. 上游的错误提示里带 HTTP 响应体原文（`API 请求失败：HTTP ${status}\n${responseText}`）。这里不带，只给大白话（见「上游删掉或改掉的东西」）。

**请求清单（与 `extract.js` 代码逐条一致）**

| 方法 | 地址（同源相对路径，主机为当前页面的 `jwxt.sysu.edu.cn`） | 用途 | 取不到时 |
|---|---|---|---|
| POST | `/jwxt/timetable-search/stuTimeTabPrint/studentQuery?_t=<毫秒时间戳>` | 取整学期课表。请求体 JSON：`{"acadYear":"<学年-学期>","submitFlag":"1","nothroughCourseFlag":"1"}` | 不导入，报错：HTTP 非 2xx → 「教务系统返回错误（代码 N）：登录状态可能已失效…」；返回不是 JSON → 「返回的内容格式不对」；`code` 不是 200 → 「返回错误（代码 N）」；没有 `data.timetable` 对象 → 「没有返回这个学期的课表数据」；课表为空 → 「没有这个学期的排课记录」 |
| GET | `/jwxt/base-info/school-calender?academicYear=<学年-学期>&weekly=1&_t=<秒时间戳>` | 取学期第 1 周开始日期（读 `data.startTime`） | 不报错，开学日交 null，`parse.js` 按学期推算并在提醒里说明 |

- 没有其它请求，没有 `allowHosts`（`[]`），没有绝对 URL。`extract.js` 只在 `jwxt.sysu.edu.cn` 上运行，其它主机（如 `cas.sysu.edu.cn`）直接报大白话提示，不发请求。
- 冒烟（`.test/port-batch29/sysu/smoke.py`）已在 Chromium 里验证：正常路径恰好两个请求（POST 请求体与 GET 路径如上），没有 `Authorization` 头，localStorage 里放的令牌不会被带出；CAS 主机零请求。

**学期推算（上游是弹窗，这里是推算，需要核对）**

- 8 月起 → 当年第一学期（如 2026-11-03 → `2026-1`）；1 月 → 上一学年第一学期（`(年-1)-1`）；2–7 月 → 上一学年第二学期（`(年-1)-2`）。
- 推算出的学期在提醒里明说（「这次导入的是按今天日期推算出的「…」，请核对」），让用户自己判断。
- 7 月按第二学期算，夏季学期 7 月末到 8 月初之间可能不准。

**节次时间（逐节对照上游 `TIME_SLOTS`）**

| 节 | 开始 | 结束 | 节 | 开始 | 结束 |
|---|---|---|---|---|---|
| 1 | 08:00 | 08:45 | 7 | 16:30 | 17:15 |
| 2 | 08:55 | 09:40 | 8 | 17:25 | 18:10 |
| 3 | 10:10 | 10:55 | 9 | 19:00 | 19:45 |
| 4 | 11:05 | 11:50 | 10 | 19:55 | 20:40 |
| 5 | 14:20 | 15:05 | 11 | 20:50 | 21:35 |
| 6 | 15:15 | 16:00 | | | |

12 节以上：按统一修订 H3，同号的内置 12 节表开始不早于上一节下课就用它，否则按上一节下课后 5 分钟、每节 45 分钟顺推；越过 23:59 的补不上，课照常导入并提醒。内置 12 节表的第 12 节 21:15 早于第 11 节下课 21:35，所以在中大数据里 H3 只会顺推，不会用内置表。

**校区**：上游没有校区参数，节次时间只有这一张表（广州南 / 广州东 / 珠海 / 深圳是否同作息，上游代码里看不出）。没有做 `__ncSelect` 询问（上游也没问）。这是已知风险，见末尾。

## 边界用例（fixture 清单）

1. `basic`：校历给了开学日；单周、双周、每周；缺教师、缺教室（「未知」）；完全重复一行；课名「本(专必)」前缀；排到第 12-13 节（H3 补）。
2. `no-calendar-overweek`：校历取不到 → 第二学期推算 2026-02-16 并提醒；课表排到第 22 周 → 总周数抬到 22；「待定」周次 → 按开始周导入；空课名、空星期的行跳过并计数；教师括号备注不算教师名。
3. `week-markers`：周次标记全集（前置 / 后置、逗号 / 无逗号、括号单周、共 N 周的各种位置、「第1-第8周」、「1,3,5周」、教学班序号）。其中「(单)1-8周(双)9-16周」（无逗号前置）与「1-8周(单)9-16周(双)」（无逗号后置）都读成 1-7 单 + 10-16 双。
4. `long-warnings`：超长课名（25 字、21 字）在提醒里截到 20 字加「…」；缺教师 4 门（点名 3 个后加「等」）、缺教室 3 门；认不出的周次与部分认得的周次各一门；空课名、只有「待定」周次的行。
5. `period-overflow`：第 12-13 节 H3 顺推（21:40、22:30 起）；第 14 节顺推超过 23:59，补不上并提醒。
6. `second-term-calendar`：第二学期；校历第 1 周给的是周三 2026-02-25 → 开学日回退到周一 2026-02-23；校历时间戳带时分秒；「2-16周(双)」只取双周。
7. `dup-counts`：复审加的。「见通知」记录重复 3 次 → 提醒只算 1 门课的周次没看懂；「1-8周,31-32周」重复 3 次 → 越界周次只提醒 2 个（不是 6 个）。

**去重顺序（复审修正）**：先按记录内容去重（课名、星期、起止节次、教师、教室、周次原文、起始周都相同才算同一条），再解析周次、计数提醒；课程本身的去重照旧（按解析后的周次）。计数（周次没看懂、部分认出、越界周次、缺周次）都放在去重之后，所以重复行不会放大提醒。导入的课程结果不变。

每对的期望值都是按规范与代码逻辑手工推出来的，没有拿 `parse.js` 的输出直接存。

## 读了什么、交出去什么（逐字段）

**读取**（只在 `extract.js` 的 `ROW_FIELDS` 白名单内）：课表行的 `courseName`、`teachingStaffName`、`classPlace`、`week`、`startClassTimes`、`endClassTimes`、`startWeek`、`timeDetail`；校历的 `data.startTime`。其它字段（响应里的学号、姓名、手机号、证件号等）一律不带出，`ROW_FIELDS` 之外的字段不进入交出去的 JSON。

**交出去的 JSON**（`extract.js` 的输出，字段白名单）：`acadYear`（推算出的学年学期）、`rows`（上面 8 个字段的对象数组）、`startDate`（校历 `startTime` 字符串或 null）。

**载荷**（`parse.js` 的输出）：`specVersion`、`kind`、`ocrAssisted`、`warnings`；`terms[0]` 含 `name`、`firstDay`（周一）、`totalWeeks`、`periodTimes`、`courses`（每门含 `name`、`teacher`、`note: null`、`blocks`，块含 `dayOfWeek`、`startPeriod`、`endPeriod`、`startWeek`、`endWeek`、`weekType`、`location`）。学号、姓名等个人信息不进入载荷，冒烟与 fixture 里都用个人信息字段验证了这一点。

## 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 合格。不读 localStorage、cookie、令牌、密码；上游的 `Authorization` 也没有。`credentials: 'include'` 只让浏览器带自己的会话，脚本读不到。 |
| 2 | 不外发 | 合格。只请求 `jwxt.sysu.edu.cn` 上的两个同源相对路径，没有第三方域。 |
| 3 | 请求域可控 | 合格。`allowHosts: []`，没有通配。 |
| 4 | 只读课表 | 合格。两个接口分别是课表和校历，没有成绩、学籍、缴费。 |
| 5 | 不埋点 | 合格。无统计、无上报。 |
| 6 | 不 eval 远程代码 | 合格。无 `eval`，无 `new Function`。 |
| 7 | 不写页面 | 合格。只有 `fetch`，不写 DOM，不提交表单。 |
| 8 | 不依赖输入之外的秘密 | 合格。无硬编码学号、令牌。上游默认学年「2026」（`ACAD_YEAR`）已换成按日期推算。 |

## 上游删掉或改掉的东西及理由

- 两个弹窗（学年输入、学期单选）→ 按日期推算。理由：本批要求不弹窗；推算结果在提醒里明说。
- `window.shiguangBridge*` 的全部调用（`showToast`、`showPrompt`、`showSingleSelection`、`saveImportedCourses`、`savePresetTimeSlots`、`saveCourseConfig`、`notifyTaskCompletion`）→ 不需要，输出由宿主收走。
- 自动执行的 `runImportFlow()`（上游加载即跑）→ 不保留，由宿主调用 `extract.js`。
- 上游的 `CONFIG_BASE`（`defaultClassDuration: 45`、`defaultBreakDuration: 10`）→ 不进载荷，应用用自己的默认。`semesterTotalWeeks: 20` 保留为 `DEFAULT_TOTAL_WEEKS`。
- `crypto.randomUUID()`、课程 id → 载荷不需要。
- `console.warn("跳过字段不完整的课程记录")` → 改成计数后写进提醒（不静默丢课）。
- 错误信息里拼入的 HTTP 响应体原文（`responseText`）→ 删掉。理由：响应体可能是登录页或错误页的全文，不该给学生看，也不该外露。
- `Object.values` → `Object.keys`（ES5）。
- `json?.` 可选链、`??`、`async/await`、`for...of`、展开、`class`、模板串、箭头函数 → 全部改成 ES5。

## 与模板的差异（相对 hueb）

1. 取数：hueb 从课表页下拉框读学年学期，再发 4 个请求（课表 POST 表单、作息、校历、首页）；这里只发 2 个，学期按日期推算，没有页面读取。
2. 节次时间：hueb 取教务作息接口，取不到用内置 13 节；这里没有作息接口，直接用上游写死的 11 节表。
3. 周次：hueb 解析 `zcd` 位串与「第1-8周(单)」等多种写法；这里解析上游的 `timeDetail` 文字，按上面的标记归属规则读。
4. 合并：hueb 合并连续节次（`mergeStageOne`/`mergeStageTwo`）；这里不合并，只去掉完全相同的行。
5. 开学日：两边都是校历 `startTime` 回退到周一，缺校历时都按锚点推算并提醒。
6. 主机：hueb 按 `window.location.origin` 拼地址（WebVPN 映射主机）；这里是同源相对路径，外加主机名检查。

## 已知风险与未验证项

- **没有本校账号，真机没验过。** 冒烟用的是假教务站（Playwright route 拦截），接口形状取自上游代码，不是抓包。上游快照的接口当前是否仍然如此，未验证。
- **学期推算**：按日期推算，不是教务给的「当前学期」。上游代码里看不到教务的当前学期接口。7 月归第二学期，夏季前后可能不准；推算结果在提醒里说明。
- **节次时间与校区**：上游只有一张 11 节表。中大广州南 / 广州东 / 珠海 / 深圳校区是否同作息，代码里看不出来，也没有校区参数。如果不同，节次时间会错。这是最大风险，只能靠提醒「如与学校实际不符请在学期管理里核对」兜底。
- **校历**：只取 `data.startTime`（与上游相同），`weekly=1` 参数的含义上游没有说明。校历不提供学期总周数，总周数固定 20，课表排到更晚的周时才抬高并提醒。
- **登录态判断**：没有读页面 DOM 去判断登录页，只靠主机名和 API 响应（非 JSON、非 2xx）。如果教务门户页与课表页同在 `jwxt.sysu.edu.cn` 下、且 API 返回的不是 JSON，提示是「返回的内容格式不对」，不是「请先登录」。
- **scheduleUrlHint** 填的是 `https://jwxt.sysu.edu.cn/`（登录入口）。上游代码里没有课表页地址（只有 API 地址），所以课表页地址无从得知，主调度需要决定是否补。
- **周次认不出时**按开始周导入一周并提醒。这与上游的回退一致（上游的 `parseWeeks` 最后也是 `[startWeek]`）。
- **去重**只去完全相同的行。如果同一门课在上游数据里以不同节次各出现一次，会变成两门课，这与上游一致。

## 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/sysu-port29/` 的副本上改坏（不动正式文件），每处都跑自检：

| # | 改坏的位置 | 变红的用例 |
|---|---|---|
| M1 | `parse.js` 标记归属：后缀分支 `if (prev && prev.kind === 'R' && prev.mark === '') prev.mark = tok.mark;` 改成 `if (false) …`（后缀标记全部当成前置） | `basic`（「1-16周(单)」）、`week-markers`、`second-term-calendar`（「2-16周(双)」） |
| M2 | 「共N周」剥离：`/共\s*[0-9]+\s*周?/g` 改成上游式的 `/共.*$/`（从「共」吞到行尾） | `week-markers`（「共16周,1-15周(单)」整行丢周次） |
| M3 | H3 顺推课间：`EXTEND_BREAK_MINUTES` 5 改成 0 | `basic`、`period-overflow`（第 12 节开始时间变 21:35） |
| M4 | 课名截字：`NAME_TEXT_LIMIT` 20 改成 40 | `long-warnings`（超长课名在提醒里不再截断） |
| M5 | 关掉去重：`if (rawSeen[rawKey] === true) continue;` 与 `if (seenCourse[key] === true) continue;` 两处都删掉 | `dup-counts`（重复行把提醒放大，越界周次计数变成 6）；`basic`（完全重复的一行被导入两次） |

五处全部变红。正式文件从未被改动。

## 自检与冒烟结果

- `node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/sysu`：6 对 fixture 全部 MATCH，载荷校验与 ES5 检查通过。
- `python -I -X utf8 D:/NullClass/.test/port-batch29/sysu/smoke.py all`：6/6 OK（normal、calendar404、cas、loginhtml、http401、empty）。

签名：0x7E7-2023（haiku 移植，2026-11-03）
