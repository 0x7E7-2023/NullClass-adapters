# 安全审计 —— 吉林化工大学（乘方教务新版，jwxt.jluct.edu.cn）

## 0. 上游情况与任务卡分析（分析写在这里，不另写文件）

**出处**：上游 `JLUCT/jluct_01.js`（437 行），作者 / maintainer 星河欲转（MIT）；上游仓库 https://github.com/XingHeYuZhuan/shiguang_warehouse。
快照 `f83288e`（2026-11-24 重新克隆）；本校脚本最后一次修改 `f4e81dd`（2026-11-18），已用 `git log -1 -- resources/JLUCT/jluct_01.js` 核对一致。快照只读，未改动。

**上游流程**（`runImportFlow`，上游 L399-435）：弹窗说明 → `selectAcademicYearAndSemester`（L346-369，弹窗让用户从学期列表里选）→ 并行 `fetchCourses`（L373-395）与 `fetchSemesterCalendar`（L245-308）→ `saveImportedCourses` / `saveTimeSlotsAndConfig`（L312-334，存节次时间、开学日、总周数）。

**与任务卡不一致之处（以上游代码为准）**：
- 任务卡写「校历 `student/xlxx/xlxxlist`」「个人课表 `student/xsgrkb/get`」。上游代码实际是：学期列表 `GET /new/student/xlxx/xlxxlist.page`（上游 L198，只读它的 `#xnxqdm` 选项）；校历 `POST /new/xlxx/data`（上游 L246）；课表 `POST /new/student/xsgrkb/getCalendarWeekDatas`（上游 L377）。本适配器照代码用这三个地址，没有用卡里的写法。
- 上游 `scheduleUrlHint` 无从确定：上游只用 POST 接口，没有 GET 课表页。manifest 不填 `scheduleUrlHint`（卡的规定是「确定不了就不填」）。

**上游的取数与计算要点**：
- 节次时间：上游 `TIME_SLOTS`（上游 L13-26）写死「全校统一作息，共 12 节」，不从教务读。本适配器逐节照抄为 `SCHOOL_PERIOD_TIMES`（parse.js L42-55），已与上游逐行对照。
- 周次：上游 `parseWeeks`（上游 L33-39）只认纯数字列表（`zc` 为 `1,2,3`）。
- 教室：上游 `locationMap`（上游 L145-159）按 `jxcdmc2` 的「教室-周次」拆：每间教室一组周次，每组出一门课（L161-172）；`zc` 只在 `locationMap` 为空时才用（L173-183）。卡里说的「别丢周次、别把不同教室的安排并成一条」，就是按这一条处理：同一门课在不同教室的周次分开成段。
- 占位词：教师 `raw.teaxms || "未知教师"`（上游 L165、L176）；教室 `room || "不用场地"`（上游 L166）与 `jxcdmc || "不用场地"`（上游 L177）。
- 静默丢课：上游 L140 `if (!(raw.kcmc && raw.xq && raw.ps && raw.pe)) return;`，缺任一字段直接丢，没有提醒；上游 L173 `else if (raw.zc)`，没周次的行也静默丢。
- 开学日：上游取校历里**最早的有日期的那一格**（上游 L289-294，`earliestDate`）作为 `startDate`；总周数取校历的最大周次（上游 L302，`maxWeek`）。
- 合并：上游 `mergeAndDistinctCourses`（上游 L46-125）按「星期 | 课名 | 教师 | 地点」分组，周次相同的节次段合并，判据是 `cur.end + 1 >= start`（L82）。本适配器的两阶段合并沿用 lit 的同类写法，判据一致。

**本批任务卡的要求落实情况**：
- 学期不弹窗：已改为取页面 / 列表页标出的当前学期（extract.js `findTerm`，L132-140）。
- 节次时间逐节照抄上游：已做（parse.js `SCHOOL_PERIOD_TIMES`），AUDIT 写明未经真机验证（§8）。
- 开学日取不到按卡的第 7 条兜底：已做（校历取不到 → 学期锚点推算 + 提醒，parse.js `estimateStart`）。
- 同一门课多教室：已做（`venueWeeksOf`，每间教室一段）。
- 接口里学号、人员 ID 等按白名单挑掉：已做（§2）。

## 1. 请求域与请求清单（与代码逐条对应）

- `allowHosts` = `[]`（请求用相对路径，只打在用户当前打开的 `jwxt.jluct.edu.cn` 上；登录入口为 `https://jwxt.jluct.edu.cn/`，主调度已定）。
- 脚本只允许在 `hostname === 'jwxt.jluct.edu.cn'` 时发请求（extract.js L216-221）；门户页、统一认证页、非教务主机都是零请求。

| # | 方法 | 地址（相对路径） | 干什么 | 请求体 | 取不到时怎么办 |
|---|---|---|---|---|---|
| 1 | GET | `/new/student/xlxx/xlxxlist.page` | **仅当当前页面没有 `#xnxqdm` 下拉框时**读学期列表页，取标了 `selected` 的学期；都没标取第一项（`source: first`） | 无 | 网络失败 / 非 2xx → 无学期 → 报「没读到当前学期」，不再发后续请求；页面里有密码框 → 报登录已失效 |
| 2 | POST | `/new/student/xsgrkb/getCalendarWeekDatas` | 整学期课表（只读） | `xnxqdm=<学期代码>`，头 `content-type: application/x-www-form-urlencoded; charset=UTF-8`（与上游同） | 401 / 403 → 拒绝访问；其它非 2xx → 返回错误（代码 N）；响应不是 JSON、`code` 不为 0、`data` 不是数组 → 没有返回课表数据；行数为 0 → 没取到课表数据。**全部报错，不导入** |
| 3 | POST | `/new/xlxx/data` | 校历（只读，取「周号 + 当周日期」） | `xnxqdm=<学期代码>`，头 `accept` / `content-type` / `x-requested-with`（与上游同） | 任何失败（网络、非 2xx、非 JSON、`code` 不为 0）→ 交 `calendar: null`，课表照常导入，提醒「没取到教务系统的校历」 |

顺序：`1（可选）→ 2 → 3`。上游是 2 与 3 并行，这里改成顺序，只是为了先保证课表成功才去要校历。

**桩跑 / 冒烟实测拼出的地址与请求体**（`.test/port-batch38/jluct/smoke.py`，Playwright 起假教务站，全部请求被 route 拦下，不联网）：

| 场景 | 实际发出的请求（方法 路径 请求体） |
|---|---|
| live-page（页面上有下拉框） | `POST /new/student/xsgrkb/getCalendarWeekDatas` `xnxqdm=202501`；`POST /new/xlxx/data` `xnxqdm=202501` |
| list-marked（页面无下拉框，列表页标了 selected） | `GET /new/student/xlxx/xlxxlist.page`；然后同上两个 POST |
| list-first（列表页没标 selected） | `GET /new/student/xlxx/xlxxlist.page`；然后同上两个 POST；学期取第一项 202501 |
| no-term（列表页 404） | `GET /new/student/xlxx/xlxxlist.page`；报「没读到当前学期」，不再发请求 |
| login-root / login-path / cas-path | **零请求**，直接报「当前打开的是登录页」 |
| other-host（`www.jluct.edu.cn`） | **零请求**，直接报「不是吉林化工大学的教务系统」 |
| expired / code1 / empty / http-500 | 只发课表 POST；各自报对应的错，不导入 |
| calendar-fail / calendar-nodata | 课表 POST 与校历 POST 都发；前者报「没取到校历」，后者报「没有给出开学日期」 |

## 2. 读了什么、交出去什么（逐字段）

**读了什么**：
- 当前页面的 `#xnxqdm` 下拉框：只取被选中项的学期代码（`value`）与文字（`textContent`，截 60 字）；代码必须匹配 `^[A-Za-z0-9_-]{1,20}$`。
- 学期列表页的 `#xnxqdm`：同上，另看 `selected` 属性。
- 课表接口响应：只看 `code`、`data`（数组）；每行只挑下面 8 个字段。
- 校历接口响应：只看 `code`、`data`；每个 `type === 'zc'` 的行首格取 `value`（周号），同行 `type === 'day'` 的格取 `fullText`（日期）。
- 页面：`input[type="password"]` 是否存在（只判断有没有，不读值；当前页面只认看得见的密码框，即 `getClientRects()` 非空，解析出来的学期列表页有密码框就算登录页）；`location.hostname` 与 `location.pathname`。

**交出去什么**（`JSON.stringify`，extract.js L233-238）：

| 顶层字段 | 内容 |
|---|---|
| `term` | `code`（学期代码）、`label`（学期文字）、`source`（`page` / `default` / `first`） |
| `today` | 提取当天的 `YYYY-MM-DD` |
| `rows` | 每行只含 `kcmc`、`teaxms`、`jxcdmc`、`jxcdmc2`、`xq`、`ps`、`pe`、`zc`（白名单 `ROW_FIELDS`，extract.js L40；值为 `null` / `undefined` 的字段不带） |
| `calendar` | `{ weeks: [{ w: 周号文字（截 4 字）, d: [日期文字（截 10 字）…] }] }`，最多 80 周；取不到为 `null` |

**不交出去的**（冒烟里每个场景都检查，都没有出现）：行里的 `xh`（学号）、`xm`（姓名）、`sfzh`（身份证号）、`sjh`（手机号）、`kcrwdm` / `bjdm` 等；响应里的 `xsxx`；校历里除周号和日期以外的字段。冒烟会把假数据里的这些值（`2025000001`、`110101200001011234`、`13800000000`、`学生某`、`SECRET-KCRW-9`）逐个查一遍，输出与请求里都不许出现。

**没读的**：密码框的值、Cookie（脚本不读，`credentials: 'include'` 只是让浏览器带上登录态）、任何 token。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。不读密码，不读 Cookie，不存任何东西。`hasLoginForm` 只判断页面里有没有 `input[type="password"]`。上游的 `showAlert` / `showSingleSelection` / `showToast` / `savePresetTimeSlots` / `saveImportedCourses` / `saveCourseConfig` / `notifyTaskCompletion` 全部未移植（§5）。 |
| 2 | 不外发 | **过**。extract.js 里只有 `fetch`，三个地址都是相对路径（§1），请求只会打到当前打开的教务主机，且先核对主机名。没有 `sendBeacon` / `WebSocket` / `Image` / 隐藏表单 / 第三方域。 |
| 3 | 请求域可控 | **过**。`allowHosts` 为空数组；主机名常量 `HOST` 只用于拦截「不在教务主机上」的情况。 |
| 4 | 只读课表 | **过**。三个请求只读：课表（`getCalendarWeekDatas`）、学期列表（`xlxxlist.page`）、校历（`xlxx/data`）。不碰成绩、学籍、缴费、考试。接口里夹带的个人信息不带出（§2）。 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval`、`new Function`。接口响应只做 `JSON.parse`（`jsonOrNull`，失败返回 null）；页面只用 `DOMParser` 离线解析学期列表页（不插入当前页面）。 |
| 7 | 不写页面 | **过**。读页面只用 `getElementById` / `getElementsByTagName` / `querySelector`；不改 DOM，不提交表单，不点击。 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有教务主机名、三个路径、请求头、报错提示文字和限长参数。 |

## 4. 与模板（lit）的差异

模板选 `lit`，理由：同为乘方教务新版（`/new/` 前缀、`xnxqdm` 学期下拉框、`getCalendarWeekDatas` 课表接口 + 表单 POST），批次三十七已审计通过；它的「字段白名单 + 登录页零请求 + 学期下拉框读法 + 两阶段合并 + 提醒限长」都照用。`nenu` / `cdutcm` 的 `xsgrkb/week.page` 页面节次时间来源不适用于本校（本校上游不读节次）。

| # | 差异 | 原因 |
|---|---|---|
| 1 | lit 的节次时间从课表页源码的 `businessHours` 读，取不到回落空课默认 12 节；本校只用上游写死的学校统一作息（12 节） | 上游本校脚本不读节次时间，只用写死表（上游 L13-26） |
| 2 | 去掉 lit 的 `qssj` / `jssj` 排课自带时间、`pkr` 备用教师字段、`bapjxcd` 不用场地标记 | 上游不用这些字段；本校接口字段里也没有（白名单按上游代码取） |
| 3 | 开学日：lit 用学期锚点推算（仅在没有校历时）；本校有校历时用校历第一个有日期的周倒推到第 1 周，再取所在周的周一；校历周日开头时取周一（`mondayOfRow`，parse.js L244-253） | 上游取校历最早日期（上游 L294）；周日开头的校历按最早日期会早一周，已用 `calendar-sunday-first` 用例钉住 |
| 4 | 总周数：有校历用校历最大周次（上游同）；lit 固定 20 | 上游 L302 |
| 5 | 教室名为空的周次：lit 沿用上一间教室；本校**留空**（地点 `null`）并计入「没给上课地点」 | 上游的做法是写成「不用场地」（上游 L166），我们不写「不用场地」（它是一个事实性断言）；沿用上一间是猜测，不做。`venue-weeks` 用例钉住 |
| 6 | 占位词：上游的「未知教师」「不用场地」（教室）→ `null`；教室占位词「待定」「暂无」也留空（`PLACEHOLDERS`） | 公共说明第 8 条 |
| 7 | 教师括号备注：去掉全角 / 半角圆括号与方括号的内容（lit 只去方括号） | 公共说明「教师括号备注不是教师名」；`teachers` 用例钉住 |
| 8 | 缺课名 / 星期 / 节次 / 周次的行：上游静默丢掉（上游 L140、L173）；这里计数并分四条提醒 | 公共说明第 4、6 条：不许静默丢课 |
| 9 | 没给结束节次（`pe` 为空）：上游静默丢掉（上游 L140 要求 `pe` 为真）；这里按只上开始那一节导入并提醒 | 同上 |
| 10 | 缺教师、缺地点分成两条提醒（lit 合成一条） | 按类型汇总；`overflow-warnings` 用它凑满 21 条来验证溢出汇总 |
| 11 | 提醒超过 20 条：lit 的 `warnings[19] = …` 会覆盖第 20 条，N 也少算一条；这里保留前 19 条，第 20 条写「另有 N 条」，N = 总条数 − 19（`warningsOut`，parse.js L179-186） | 公共说明「批次三十七」第 5 条；`overflow-warnings` 与变异 M3 钉住 |
| 12 | 学期名：上游用下拉框文字（`xnxqmc`）；这里同 lit：文字带学年就用文字，读不出用学期代码拼，都读不出用「吉林化工大学 学年学期」 | 公共说明第 8 条：不用适配器名 |
| 13 | 不弹窗选学期（lit 同） | 公共说明第 2 条 |

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 处理 | 理由 |
|---|---|---|
| `promptUserToStart` 弹窗（L338-344） | 删 | 宿主负责交互，适配器不弹窗 |
| `selectAcademicYearAndSemester` 单选框（L346-369） | 改：读页面 / 列表页标出的学期 | 公共说明第 2 条 |
| `fetchAcademicOptions` 取 7 个选项（L197-241） | 改：只取学期下拉框的当前项 | 只需要当前学期，不需要选项列表 |
| `saveTimeSlotsAndConfig` / `savePresetTimeSlots` / `saveCourseConfig` / `saveImportedCourses`（L312-334、L426-427） | 删 | 保存由宿主负责，适配器只交载荷 |
| `showToast` / `notifyTaskCompletion`（L326-332、L374、L392、L405、L418、L429-430） | 删（提醒改进 `warnings`） | 同上 |
| `mergeAndDistinctCourses` 按教室分组的合并（L46-125） | 改：两阶段合并（lit 写法），教室分段用 `venueWeeksOf` | 同一套合并判据，结果一致；多教室的周次按教室分开 |
| `parseWeeks`（L33-39）只认纯数字 | 改：lit 的 `weeksOf` | 公共说明：「1-16周」「(单)」「第1-第8周」都要认，认不出的进提醒 |
| `"未知教师"` / `"不用场地"` 占位（L165-166、L176-177） | 改：留空（null） | 公共说明第 8 条 |
| 静默丢行（L140、L173） | 改：计数并提醒 | 公共说明第 4、6 条 |
| 校历并行请求（上游 L411-414 的 `Promise.all`） | 改：顺序请求，课表先成功 | 课表失败就不需要校历 |
| 校历 `startDate` 取最早日期（L289-294，L301） | 改：周一倒推 + 周日特例 + 提醒 | 手册 §4.3「第 1 周的第一天」；见 §4 第 3 条 |

## 6. 变异测试记录

在系统临时目录 `C:/Users/23703/AppData/Local/Temp/jluct-port38/` 的副本上改坏 `parse.js`（脚本 `mutate.py`，每次改在副本上，跑完删除副本，原文件从未改动），跑 `check.js`：

| # | 改坏的地方 | 变红的用例 |
|---|---|---|
| M1 | `weeksOf` 的前置标记判据改回按空白切（`split(/[,\s]+/)`，即批次三十七之前的写法）：「(单) 1-8周 (双) 9-16周」里第二个标记被当成上一段的后缀 | `prefix-markers` |
| M2 | `mergeStageTwo` 不取周次并集（同节次两段只留第一段的周次） | `basic`、`venue-weeks` |
| M3 | 溢出汇总的 N 少算一条（`allWarnings.length - MAX_WARNINGS`） | `overflow-warnings` |
| M4 | `teacherOf` 不去掉括号备注 | `teachers` |
| M5 | 节次顺推的课间改为 0 分钟 | `calendar-fallback`、`overflow-warnings` |

5 处全部变红（DIFF），还原后自检 PASS（见 §7）。

## 7. fixtures、自检与冒烟

**fixtures**（共 9 对，合成数据，期望值按规范与代码逻辑手工推演，未把 parse.js 的输出直接存成期望）：

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 多门课；连堂 1-2 与 3-4 合成 1-4；单周行与双周行并成每周；校历给开学日 2025-09-01 与 20 周；缺教师 / 缺教室照常导入并汇总提醒；节次时间 12 节 |
| `weeks-multi` | `(单)1-8周,(双)9-16周`；`1-8周(共8周)` 只剥备注；`第1-第8周` 是一个区间；`1-16周(3组)` 备注忽略并提醒；`(1)` 教学班序号忽略并提醒；`31` 超界丢弃并计数 |
| `prefix-markers` | 无逗号前置标记 `(单)1-8周(双)9-16周`；全角逗号 `(单)1-8周，(双)9-16周`；空白 `(单) 1-8周 (双) 9-16周`；`第(单)1-8周(双)9-16周`。四种都是第二个标记归下一段：单周只落 1-7，双周只落 10-16 |
| `venue-weeks` | jxcdmc2「教室-周次」一间教室一段；同名课拆成多段；zc 有而 jxcdmc2 没有的第 5 周用主教室补上并提醒；教室名为空的第 6 周地点留空并计入缺地点 |
| `teachers` | 「未知教师」「暂无」留空；「李明（外聘）」「王芳(研究生)」去掉备注；同名同教师两次排课合并为一门课两段；「待定」教室留空 |
| `calendar-fallback` | 校历接口失败 → 按第二学期锚点 2026-02-20 所在周的周一推算为 2026-02-16 并提醒；总周数 20 并提醒；学期标记为 `default`；第 13 节超出学校作息表，按统一修订 H3 顺推补齐并提醒 |
| `calendar-sunday-first` | 校历第 1 周列顺序从周日起（2025-08-31 周日、09-01 周一）→ 开学日 2025-09-01，不早一周（`mondayOfRow`） |
| `long-warnings` | 超过 20 字的课名截到 19 字加「…」；同类问题 3 门课一条提醒（缺教师）；缺地点、分周地点对不上、没给结束节次各一条；每条 ≤200 字 |
| `overflow-warnings` | 21 条核对提示：保留前 19 条，第 20 条「另有 2 条」（N 为实际没显示的条数）；覆盖学期名推算、校历取不到、节次补齐与超界、缺课名 / 星期 / 节次 / 周次四类跳过、缺教师、缺地点、分周地点、没给结束节次、序号、备注、超界周次、孤立单双、单双同时出现 |

**自检**：`node .test/port-batch5/tools/check.js D:/NullClass/jw-adapters/jluct`，9 对 fixture 全部 MATCH，载荷校验通过，ES5 检查通过，控制字节检查通过，allowHosts 为空。最终结果见 §9。

**冒烟**：`python -I -X utf8 D:/NullClass/.test/port-batch38/jluct/smoke.py all`，14/14 OK：live-page、list-marked、list-first、no-term、calendar-fail、calendar-nodata、login-root、login-path、cas-path、other-host、expired、code1、empty、http-500。每个场景都检查请求序列、请求体、零请求场景、白名单字段、个人信息不外带，并把输出交给 Rhino 跑 parse.js，检查学期来源、节次时间、提醒长度。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **学期代码格式**：上游只把下拉框的 `value` 原样拼进请求体，没有说明格式。fixture 与冒烟用 `202501` / `202502`（仿 lit）。真机上的代码若是别的形式，学期名仍用下拉框文字（`label`），学期序号靠文字「第一学期」「第二学期」读，读不出再看代码，都读不出按日期推算并提醒。
2. **节次时间未经真机验证**：全部 12 节照抄上游（`SCHOOL_PERIOD_TIMES`）。每次导入都会有一条「节次时间按学校统一作息导入……请核对」的提醒，即使学校实际作息一致。
3. **校历接口结构未经真机验证**：`/new/xlxx/data` 的 `data` 形状（月块 → 行 → 格，`type` 为 `zc` / `day`）是按上游代码读的，没有真实响应样本。形状不对时校历会被当成取不到，走推算并提醒，课表照常导入，不会导错。
4. **开学日的「周日开头」判断是启发式**：校历第 1 周最早有日期的那一格若是周日，就取下一天为周一。真实校历若周日排在最前，这一判断正确；若周一排在最前但第 1 周只有周日有日期（极少见），会晚一天。
5. **教室名为空的周次留空**：上游写「不用场地」，这里不写。偏离上游，需主调度确认（§4 第 5 条）。
6. **总周数取校历最大周次**（上游同）：若校历把考试周也编进周次，总周数会偏大，提醒里会写明按校历给的周数导入。
7. **登录页判断**：只认页面有（当前页面上看得见的）密码框、路径含 `login` / `authserver` / `cas`，以及主机不是 `jwxt.jluct.edu.cn`。门户（金山 SSO）页面的真实结构未知，门户页若没有密码框、路径也不含这些词，会走「不是教务系统页面」或「没读到当前学期」的提示，零请求是安全的，但提示文字不一定最贴切。
8. **`loginUrl`** 按主调度定为 `https://jwxt.jluct.edu.cn/`。上游说明是「金山 SSO 门户 → 统一登录 → 进教务」，统一门户与教务是两个账户（上游 description）。学生需要先过统一门户，再进教务；这一点在报错提示里已说明「请先登录教务系统」。
9. **`scheduleUrlHint` 未填**（§0）。
10. **没有真机验证登录态**：所有请求是桩跑，cookie、会话过期的真实表现未知。`expired` / `code1` / `http-500` 三个场景只覆盖「返回了登录页 HTML」「返回 code 1」「返回 500」三种形式。

## 8a. 复审修正（主调度，2026-11-24）

- 复审零 bug；提出的风险已修：乘方学生页常带隐藏的「修改密码」弹窗，原先当前页面只要有 `input[type="password"]` 就判为登录页、零请求报错。
  `hasLoginForm(doc, live)` 在当前页面只认 `getClientRects()` 非空的密码框；`fetchListTerm` 解析出来的页面没有布局，仍按有密码框判。
  冒烟新增 `hidden-password`（课表页带 `display:none` 的密码框仍能导入），15/15 OK。

## 9. 签名

自检终态与冒烟终态见 §7（收尾时重跑记录）。

0x7E7-2023（haiku 移植，2026-11-24）
