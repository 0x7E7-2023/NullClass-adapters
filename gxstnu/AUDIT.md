# 广西科技师范学院（gxstnu）移植审计

本文件记录移植件的来源、模板选择与不同构之处、请求与读写面、手册 §5 八条的逐条结论、与模板件的差异、删掉的上游逻辑、fixtures、浏览器冒烟、变异测试与未验证项。
这里的每一条声明都对应当前代码（引用按函数名，不写行号）；没有核对的地方写在 §12。

## 1. 来源（provenance）

- 上游仓库：https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT）
- 上游文件：`resources/GXSTNU/gxstnu_01.js`（427 行），上游作者（adapters.yaml 的 maintainer）CikeSeven。
- 上游同目录 `resources/GXSTNU/adapters.yaml`：adapter_id `GXSTNU_01`，adapter_name「广西科技师范学院强智教务」，category `BACHELOR_AND_ASSOCIATE`，import_url `https://jw.gxstnu.edu.cn/jsxsd/`，description 写「强智2020后版本……可选择学期，支持获取开学日期与总周数」。
- 上游快照：`1dc9ac6`（2026-11-16，与 origin/main 对齐）。本校脚本最后一次修改 `e2e5a21`（2026-11-11，`git log -1 -- resources/GXSTNU/gxstnu_01.js` 核对一致）。
- 平台：强智科技「教务管理系统」新版界面，学生端 `/jsxsd/`；课表是 `table.qz-weeklyTable`，课程详情放在格子里的 tooltip（`.qz-tooltip li.qz-toolitiplists`）。
- 移植者：0x7E7-2023（haiku 移植，2026-11-11）。

## 2. 模板选择与不同构之处（分析）

任务卡候选是 `hnptc` / `qfnu`（批次十六审过的强智件）。实际 diff 后**以 `hnu`（湖南大学）为模板**：

- 上游 `GXSTNU/gxstnu_01.js` 文件头自己写明「结构与 HNU_01 相同」；与 `HNU/hnu_01.js` 逐段 diff，`parseHeaderDays` / `readCourseItem`（tooltip 三行详情）/ `parseTimetableToModel`（按 rowspan·colspan 还原网格）/ `mergeAndDistinctCourses` / `parseSemesterInfo`（`#dataTable` 周历）都是同一套代码，只有 BASE_URL、节次时间表和教师 / 地点清理不同。
- `hnptc` / `qfnu` 是强智**老一点的课表页**：`#timetable` + `.kbcontent` 简表 / 详表、按行首标签推节次，没有 `table.qz-weeklyTable` 和 tooltip，与本校不同构。
- `hnu` 是已审计的同结构件（`table.qz-weeklyTable` + tooltip + `jxzl_query` + `#dataTable`），网格还原、同课合并、周历兜底直接沿用；按本校上游重写的层见 §8。

与 hnu 不同构、按本校上游重写的层：

| 层 | hnu | 本件 gxstnu |
|---|---|---|
| 课表请求 | `GET /jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=<学期>` | 相同（`viweType` 拼写照抄上游） |
| 教学周历请求 | `POST /jsxsd/jxzl/jxzl_query`，体 `xnxq01id=<学期>` | **GET** `/jsxsd/jxzl/jxzl_query?xnxq01id=<学期>`（上游 `requestSemesterPage(semesterId)`） |
| 节次时间 | 写死 11 节（08:00 起） | 写死 **12 节**（08:20 起，逐节见 §7） |
| 教师 | 原样交 tooltip 的「老师」 | 上游 `cleanTeacher`：去掉括号备注与职称（「张三讲师（高校）」→「张三」），多教师用逗号连起来 |
| 地点 | 原样交「地点」 | 上游 `cleanPosition`：把建筑与房间拼起来（「科教楼(西3-201-计算机基础实验室（12）)」→「科教楼西3-201-计算机基础实验室（12）」） |
| 周历日期 | 前 7 个有日期的格子必须逐天连续，首日只认星期日 / 星期一，否则对齐到周一 | 该校**工作日格子只有日号（「07」）、只有周末格子写「09月12日」**：取第 1 周里第一个带完整日期的格子，按它在行内的位置倒推这一周的第一天（与上游 `col - firstCol` 同口径）；每周从星期几算起由 `firstDay` 的星期几决定，不强行改周一 |
| 周历年份 | 按月份推（月份小于 8 算下一年） | 按学期代码推（`2026-2027-1` 取前一年、其余取后一年，上游 `parseSemesterInfo`） |
| 学期提醒 | 只在教务没标出当前学期时提醒 | 每次都在第一条说明本次导入的是哪个学期（上游弹窗选学期，这里不弹窗） |
| 坏卡片点名 | 最多 5 个（长提醒靠最后 200 字硬截断） | 最多 2 个 + 「等」，保证不靠硬截断也 ≤200 字 |

## 3. 请求表

extract.js 里有两处 `fetch(` 字面量（`getPage` 与 `getCalendar`），一次提取最多发出下面三个 GET。路径都是页面同源的相对路径，`credentials: 'same-origin'`，不写 `Authorization` 或 Cookie；查询串里只有学期代码。

| # | 方法 | 路径 | 何时发 | 作用 | 取不到时怎么办 | 上游对应 |
|---|---|---|---|---|---|---|
| R1 | GET | `/jsxsd/jxzl/jxzl_query` | **仅当**用户不在课表页 / 教学周历页（路径不在 `/jsxsd/xskb/` 或 `/jsxsd/jxzl/` 下），或那一页的学期下拉框没有合法选中项 | 读学年学期下拉框 `#xnxq01id` 的选中项（`currentTerm`） | 状态码非 2xx / 跳到别的主机 / 连不上 / 登录页 → 报错（大白话）；没有下拉框或值不是 `yyyy-yyyy-n` → 报「找不到学年学期的选项」 | `requestSemesterPage()`（无参） |
| R2 | GET | `/jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=<学期>` | 每次提取 | 取该学期的课表页 | 同上报错；返回登录页 → 报「登录已失效」；没有课表表格 → parse.js 报「没有找到课表」 | `requestCoursePage()` |
| R3 | GET | `/jsxsd/jxzl/jxzl_query?xnxq01id=<学期>` | R2 之后 | 教学周历：开学日期与总周数 | 取不到、状态码错、解析失败 → 交 null，parse.js 用兜底口径并提醒，**不致命** | `requestSemesterPage(semesterId)` / `parseSemesterInfo()` |

- `readPage` 对响应做三件事：状态码（401/403 报「拒绝访问」，其它非 2xx 报「教务系统返回错误（代码 N）」）、`response.url` 的主机必须仍是 `jw.gxstnu.edu.cn`（被重定向走了就报「登录已失效」）、再解析成离线文档。
- 登录页判断（`loginLike`）：登录表单元素 `#userAccount` / `#userPassword` 存在，或页面标题**很短（≤12 字）且含「登录」**。后一条故意限长，免得正常课表页标题里夹带「登录」二字时被误判。
- 在登录页 / 统一认证页 / 门户页上点提取：`run()` 开头检查 `window.location.host`（不是 `jw.gxstnu.edu.cn` → 「请在广西科技师范学院教务系统中执行导入」）和当前页是否登录页（→「当前页面不是课表」），**不发任何请求**（冒烟 `gxstnu-cas`、`gxstnu-login-form` 钉住）。
- 没有任何请求指向 `jw.gxstnu.edu.cn` 之外的主机。

## 4. 端口与入口

- `manifest.json`：`loginUrl` = `https://jw.gxstnu.edu.cn/jsxsd/`（任务卡给定，上游 import_url 原值）；`scheduleUrlHint` = `https://jw.gxstnu.edu.cn/jsxsd/xskb/xskb_list.do?viweType=0`（任务卡给定的课表页完整地址）；`allowHosts` = `["jw.gxstnu.edu.cn"]`，只有一个精确主机名，**没有通配**。
- 统一认证页的主机只在用户登录时出现，提取期间不请求它，所以不进 `allowHosts`。
- 上游 URL 全部写成 `https://jw.gxstnu.edu.cn`；本件用相对路径，协议跟着页面走（冒烟 `gxstnu-http` 在 http 页面上跑通）。
- 静态扫描（手册 §5 的两条命令）：URL 主机只有 `jw.gxstnu.edu.cn`（在 manifest 与注释里）；`fetch(` 两处字面量；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。

## 5. 读取面与输出面

### 5.1 extract.js 读了什么

- 页面的 `window.location.host` / `protocol` / `pathname`（判断主机、判断是否停在课表页 / 周历页、拼 `pageUrl`），当前文档的 `#xnxq01id`（仅在课表页 / 周历页上）。
- R1 / R2 响应（离线文档）：`#xnxq01id` 的选项（`value`、文字、有没有 `selected` 属性）；`table.qz-weeklyTable`（全部）的 `thead` 里所有 th / td 的文字（截 40 字）、`tbody` 的所有行的直接子 td / th 的 `name`、`class`、`rowspan`、`colspan`、**有没有文字**（只交布尔值），以及格子里 `.qz-tooltip li.qz-toolitiplists` 的课名 `.qz-tooltipContent-title` 和 `.qz-tooltipContent-detailitem` 中以「老师：」「地点：」「时间：」开头的三类文字。
- R3 响应：`#dataTable` 的 `tbody` 每行：`td.qz-weeklyTable-label` 的文字（截 20 字，周号标签），其余格子的文字（截 60 字）和 `title` 属性（截 40 字）。
- 登录判断：只看 `#userAccount` / `#userPassword` 这两个元素**是否存在**和页面标题，**不读它们的值**。

### 5.2 extract.js 交出去什么（逐字段，即 parse.js 的全部输入）

| 字段 | 类型 | 内容 | 来源 |
|---|---|---|---|
| `source` | 字符串 | 固定 `"qz-jsxsd-gxstnu"` | 常量 |
| `pageUrl` | 字符串 | 协议 + 主机 + 路径，**不含查询串** | `window.location` |
| `now` | 字符串 | 提取时刻的本地日期 `yyyy-MM-dd`（不用 `toISOString`） | `Date` |
| `loginTitle` / `loginForm` | 布尔 | 标题很短且含「登录」；登录表单元素是否存在 | R2 响应 |
| `term` | 对象 | `{ code, label, assumed }`：学期代码（形如 `2026-2027-1`）、下拉框选项文字、教务有没有标出当前学期（没有时取第一项，`assumed` 为真） | 下拉框 |
| `tables` | 数组 | 每张 `table.qz-weeklyTable` 一项：`{ head, body }` | R2 响应 |
| `tables[].head[]` | `{ text }` | 表头格文字 | thead |
| `tables[].body[][]` | cell | `{ label, rowSpan, colSpan, hasText, cards }` | tbody |
| `cell.label` | 布尔 | `name="timeTd"` 或带类 `qz-weeklyTable-label`（上游判据） | 属性 |
| `cell.rowSpan` / `colSpan` | 整数 | HTML 上的值（没有或不是数字为 1，**0 原样交**，由 parse.js 报错） | 属性 |
| `cell.hasText` | 布尔 | 非节次标签的格子里有没有可见文字。**只交有无，不交文字**——格子里的 tooltip 还带学号、班级之类不在白名单里的内容 | textContent |
| `cell.cards[]` | `{ title, details }` | 每个 tooltip 条目：课名 + 以「老师：」「地点：」「时间：」开头的详情文字（按前缀白名单挑，其余详情不交） | tooltip |
| `calendar` | 对象或 null | `{ rows: [ { label, cells: [ { text, title } ] } ] }`；周历取不到为 null | R3 响应 |

**输出面（应用拿到的载荷）**：parse.js 的输出只含 `specVersion`、`kind: "schedule"`、`ocrAssisted: false`、`warnings`、`terms[0]`（`name`、`firstDay`、`totalWeeks`、`periodTimes`、`courses`）。课程的 `name`、`teacher`、`location` 来自 tooltip 的课名 / 老师 / 地点（教师去职称、地点拼接见 §8）；没有 UUID、时间戳、颜色或学号。

**学号、姓名、人员 ID 的去向**：extract.js 不读页面上的个人信息区域；tooltip 里不在白名单里的详情（如「学号」「班级」「备注」）不交；格子文字只交有无。冒烟的假页面里把学号、姓名、身份证号、手机号分别塞在页面头部、tooltip 的非白名单详情里，检查请求和 extract 输出里一处都不出现。**隐藏行 / 隐藏列里的学号姓名**同样出不来：格子文字只交布尔值，tooltip 只交三个白名单字段；隐藏的课程卡片仍会按上游口径导入（见 §12）。

## 6. 手册 §5 安全审计八条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | extract.js 不读账号、密码的值；登录表单只判断 `#userAccount` / `#userPassword` 是否存在。请求只声明 `credentials: 'same-origin'`，会话由浏览器附带。check.js 的词法提示「password 字样」命中的正是 `getElementById('userPassword')` 这个存在性判断。 |
| 2 | 不外发 | 通过 | `fetch(` 两处字面量，都是同源相对路径；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。冒烟检查了所有请求的主机。 |
| 3 | 请求域可控 | 通过 | `allowHosts` 只有 `jw.gxstnu.edu.cn`，没有通配；`run()` 开头检查页面主机，`readPage` 检查重定向目标主机。 |
| 4 | 只读课表 | 通过 | 三个请求都是学生端课表页（R2）、教学周历（R1、R3）；不请求成绩、学籍、缴费、个人信息或选课页面。上游的这三个 URL 一个不多。 |
| 5 | 不埋点 | 通过 | 没有统计、上报或遥测代码。 |
| 6 | 不 eval 远程代码 | 通过 | 两个文件都没有 `eval` 与 `new Function`；check.js 的词法扫描通过。 |
| 7 | 不写页面 | 通过 | extract 只读页面与离线文档（`DOMParser`）；没有 innerHTML 赋值、appendChild、表单提交或 value 赋值。上游的 `showAlert`、`showToast`、`showSingleSelection`、`notifyTaskCompletion`、`saveCourseConfig`、`savePresetTimeSlots`、`saveImportedCourses` 等界面与保存调用已删。 |
| 8 | 不依赖秘密 | 通过 | 没有硬编码的密钥、令牌或学号；学期代码来自页面下拉框。 |

## 7. 节次时间（逐节，照抄上游 `TIME_SLOTS`）

| 节 | 开始 | 结束 | 节 | 开始 | 结束 |
|---|---|---|---|---|---|
| 1 | 08:20 | 09:00 | 7 | 15:15 | 15:55 |
| 2 | 09:05 | 09:45 | 8 | 16:10 | 16:50 |
| 3 | 09:55 | 10:35 | 9 | 16:55 | 17:35 |
| 4 | 10:45 | 11:25 | 10 | 19:30 | 20:10 |
| 5 | 11:30 | 12:10 | 11 | 20:15 | 20:55 |
| 6 | 14:30 | 15:10 | 12 | 21:00 | 21:40 |

- 上游不从教务读节次时间，只有这一张写死的表，所以本件也不请求节次时间，**每次**都在提醒第二条说明「节次时间没有从教务系统读取，已按学校公布的 12 节时间导入（…），与实际不符时请在「学期管理」里核对」。表是上游作者写的，我们没有对照学校的公布文件核实（§12）。
- 第 1-2 节、第 2-3 节、第 4-5 节、第 6-7 节、第 7-8 节、第 8-9 节、第 10-11 节、第 11-12 节之间的间隔都照抄上游原值。
- 统一修订 H3：课表用到第 13 节及以后时，在上一节下课后顺推（课间 5 分钟、每节 45 分钟）：第 13 节 21:45-22:30，第 14 节 22:35-23:20，第 15 节起越过 23:59 补不了——课程照常导入，提醒里点名「第 N 节及以后没有补上时间」。补了哪些也写进提醒（`period-extend` 用例）。单日节次上限 20，超过的写法按认不出处理。

## 8. 与模板（hnu）的差异（汇总）

1. 请求、节次时间、教师 / 地点清理、周历日期与年份的算法：见 §2 表。
2. 周次解析（沿用 hnu 的 `weeksOf` 并补齐批次三十三～三十五的坑）：前缀 / 后缀单双标记各归各段；**本段以标记开头时，紧挨的后一个标记归下一段**（`(单)1-8周(双)9-16周` 不能退化成 1-16 每周；标记与下一段的数字之间隔着空格或逗号——`(双) 9-16周`、`(双)，9-16周`——也照样归下一段，见 §10 末尾的返修说明）；「共 N 周」只剥备注；「第」不是分段符；整段周次写在括号里（`（第1-16周）`）照常认；周次里混着的节次（`第3-4节,1-16周`）整段摘除；括号里的纯数字是教学班序号、带字的括号是备注，都只剥括号本身。
3. 节次写成多段（`[1-2,5-6节]`）拆成多块；方括号里不写「节」（`[3-4]`）也认（上游同样接受）。
4. 缺教师 / 缺地点：留 null 并按「课名 + 教师」去重后按类型汇总（点名最多 3 门，课名截 20 字）。
5. 每次说明导入的是哪个学期；教务没标出当前学期（`assumed`）时改为「按第一项导入，请核对」。
6. 一格占多天（colSpan > 1）：上游行为保留（课放进跨的每一天），计数提醒。
7. 开学日：不强制对齐到周一；`firstDay` 的星期几就是教务周历每周的第一天。不是周一时提醒说明（应用按 `firstDay` 排周视图）。
8. 坏卡片点名从 5 个减到 2 个 + 「等」：保证「有 N 个上课安排没能导入……」这条不靠最后的 200 字硬截断也能完整显示（批次三十五的口径）。

## 9. 上游里被删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `showAlert` 开场确认、`showSingleSelection` 选学期 | 删；学期取页面当前选中项，页面没有就取下拉框第一项 | 少一次交互；公共说明约定「读页面当前学期，读不到再按上游的请求取」 |
| `showToast`、`notifyTaskCompletion`、`saveCourseConfig`、`savePresetTimeSlots`、`saveImportedCourses` | 删 | 脚本对页面只读；保存与提示由应用负责 |
| `credentials: "include"` | `credentials: 'same-origin'` | 请求全是同源相对路径，同源凭据照样带上；不声明跨源凭据 |
| `parseSemesterList` 取选中项上下各 3 个（为弹窗） | 不取列表、不弹窗；只取选中项 | 不弹窗 |
| 上游 `cleanTeacher` / `cleanPosition` | 保留并降到 ES5；地点额外认全角括号 | 上游判据 |
| `未知教师`、`未知地点` | 留空（null），汇总提醒；另把「未知」「待定」「暂无」等占位词也当没有 | 手册 §4.7 + 公共说明第 8 条 |
| `parseWeeks`：按 `(` 截断后只认数字、逗号、短横线 | 重写（§8 第 2 条）；第 0 周及超出 30 的周次计数提醒 | 上游把「单 / 双」标记悄悄丢掉（整门课退化成每周都上），把 0 周静默丢掉 |
| `[..]` 取最小到最大 | 拆成多块 | 避免把不上课的节次算进去（上游取 `[1-2,5-6]` 会连 3-4 一起算） |
| `mergeAndDistinctCourses` | 按周拆开再合并（沿用 hnu），输出按移植手册 §4.1 切段 | 同样不改任何一周的安排，且不会把部分周相邻的调课扩到整学期 |
| `parseSemesterInfo`：第一格日期按列号倒推 | 改为「第一个带完整日期的格子 + 行内位置」，因为工作日格子只有日号 | 同一口径，且能吃「工作日不带月份」的写法 |
| `semesterTotalWeeks = totalWeeks \|\| 20` | 保留 20 周兜底；课表有更晚的周次则抬高；上限 30，超过截断并提醒 | 载荷规范 |
| `firstDayOfWeek` 单传 | 不单独传，隐含在 `firstDay` 的星期几 | 手册 §4.3 |
| 绝对地址 `https://jw.gxstnu.edu.cn` | 相对路径 | 不写死协议与主机，页面在哪就请求哪 |
| `Set`、`Array.from`、展开、解构、箭头函数、模板串、可选链等 | 改成 ES5 | CI 的 Rhino 与 ES5 检查 |
| 课名里的 `●★○` 等标记 | **没有清理** | 上游 gxstnu_01.js 全文没有这类清理代码（任务卡的提示与上游代码不符）；按「以代码为准」保留课名原样，见 §12 |

## 10. fixtures

13 对，全部为合成数据（没有真实学号、姓名）。extracted 由 `C:/Users/23703/AppData/Local/Temp/gxstnu-port37/gen.py` 生成（只造输入，不造期望；做完已删；`week-mark-space` / `week-mark-comma` 两对由 `week-forms.extracted.json` 改成单行单卡）；expected 按规范与代码语义**手工推演**后写成脚本里的显式数据再序列化（没有把 parse.js 输出存成 expected）。每一对都覆盖到任务卡要求的边界。

| 用例 | 覆盖什么 | 本校专属边界 |
|---|---|---|
| `basic` | 星期一起排的表头、一格两门课（1-8 周与 9-16 周）、单双周（1-15 单周 / 2-16 双周）、缺教师缺地点照常导入并汇总提醒、周历 18 周第 1 周星期一 2026-09-07 | 教师去职称（张三讲师（高校）→张三）、地点拼接（科教楼(西3-201-…)→科教楼西3-201-…） |
| `week-forms` | 前缀 `(单)1-8周,(双)9-16周`、后缀 `1-8周(单)9-16周(双)`、**无逗号 `(单)1-8周(双)9-16周`**、`第1-第8周`、`1-8周(共8周),9-16周` 只剥备注、`1,3,5-7周` 混排、`17周` | 单双标记归属（批次十八 jxfu 的坑） |
| `week-notes` | 整段周次写在括号里（`（第1-16周）`）、周次前混着节次（`第3-4节,1-16周`）、`10-16周(3学分)`、`(单)1-8周,9-16周` 第二段每周都上、方括号不写「节」（`[3-4]`）、多段节次（`[1-2,5-6节]`） | 周次里混节次 / 学分（批次三十三、三十五的坑） |
| `week-mark-space` | `(单)1-8周(双) 9-16周[1-2节]`：后一个标记与下一段之间隔着**空格**，仍归下一段 → 1-7 单周 + 10-16 双周 | 单双标记归属（review 返修） |
| `week-mark-comma` | `(单)1-8周(双)，9-16周[1-2节]`：后一个标记与下一段之间隔着**全角逗号**，仍归下一段 → 1-7 单周 + 10-16 双周 | 单双标记归属（review 返修） |
| `merge` | 同课同师同地点同日 1-2 与 3-4 并成 1-4、1-8 与 9-16 同节次并成 1-16、完全重复卡片只留一条、同名不同教师两门课、一格 colspan=2 占两天并提醒 | 连堂合并与重复行去重 |
| `calendar-fallback` | 周历取不到、教务没标出当前学期（取第一项并提醒）、开学日按提取日 2026-09-16 所在周周一 2026-09-14 推算、总周数按 20 周计、学期名由代码拼出 | 周历缺失兜底 |
| `calendar-offset` | 工作日格子只有日号、只有星期日格子写完整日期（09月13日，行内第 7 格）→ 倒推 6 天得 2026-09-07 | 该校周历格式（工作日无月份） |
| `calendar-spring` | 第 2 学期 `2025-2026-2` 的年份取后一个年份（2026），第 1 周星期一 2026-02-23 | 周历年份按学期代码推 |
| `calendar-sunday` | 周历第 1 周从星期日 2026-09-06 算起 → 开学日取星期日并提醒周次从星期日算起 | 每周起始日随周历第一列 |
| `calendar-nodate` | 第 1 周只有日号、没有完整日期 → 不猜，按提取日所在周周一 2026-09-14 推算并提醒；总周数仍取周历 18 周 | 周历日期不可用 |
| `period-extend` | 第 13-15 节：13、14 节顺推补（21:45-22:30 / 22:35-23:20），15 节越过 23:59 补不了，课程照常导入 | H3（学校只公布 12 节） |
| `skipped-long` | 没有课名 / 没有上课时间 / 周次写法认不出 / 方括号里读不出节次 / 只有偶数周没有有效周次的卡片跳过并点名（最多 2 个 + 等）；3 门 28 字长课名缺教师缺地点照常导入、课名截 20 字；页面两张课表只导第一张；一格有文字却认不出课程 | 带课名的提醒限长、坏卡片 |

返修（review 抓到的错，2026-11-16）：`weeksOf` 里「本段以标记开头时，后一个标记归下一段」的判据原来写的是 `/^周?[0-9]/`，只认标记**紧贴**下一段数字的写法；标记后隔着空格（`(双) 9-16周`）或逗号（`(双)，9-16周`）时就判不出来，后一个标记被当成本段后缀，单双同时出现 → 按每周都上导入（1-16 每周）。现改为先用 `/^[\s,，]*周?/` 吞掉标记与数字之间的空白 / 逗号，再看后面是不是数字；四种写法（前后置、无分隔、空格、全角逗号）都归位正确，`week-mark-space` / `week-mark-comma` 两对 fixture 覆盖空格与全角逗号写法（`parse.js` 第 315-322 行）。

报错用例（不做成 fixture，在临时目录造输入用 RhinoRun 单跑，输出已核对）：表头少一天 / 星期重复 → 「课表表头和预期不一样」；没有课表表格 → 「没有找到课表」；某行格子不满 8 列 → 「有一行课表不完整」；第一列不是节次标签 / 节次标签出现在其它列；`colSpan=0` 或越界 → 「课表格子的跨行或跨列对不上」；登录表单 / 登录标题 → 「当前页面不是课表」；学期代码缺失或格式不对 → 「找不到学年学期」；整张课表没有一门课 → 「本学期没有解析到任何课程」（防止空学期清空同名学期）；`now` 缺失且周历取不到 → 「无法确定今天的日期」。

## 11. 浏览器冒烟与变异测试

### 11.1 冒烟（`D:/NullClass/.test/port-batch37/gxstnu/smoke.py`，Playwright + 系统 Edge 假教务站，请求全被 route 拦下，不联网）

跑真实的 extract.js，再用 Rhino 跑 parse.js；检查请求序列、查询串、没有请求去别的主机、个人信息（学号、姓名、身份证号、手机号、tooltip 里的学号 / 班级 / 备注）不出现在请求和 extract 输出里、`pageUrl` 无查询串、`source` 正确、载荷关键值、warnings ≤200 字。14/14 通过：

| 场景 | 确认了什么 |
|---|---|
| `gxstnu-schedule-page` | 用户停在课表页：只发 `GET /jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=2026-2027-1` 和 `GET /jsxsd/jxzl/jxzl_query?xnxq01id=2026-2027-1`，**没有**不带查询串的 `GET jxzl_query`；开学日 2026-09-07；教师「张三讲师（高校）」→「张三」、地点拼接正确、单周识别正确 |
| `gxstnu-schedule-page-other-term` | 页面下拉框选了 2025-2026-2 → 课表与周历请求都用它，开学日 2026-02-23（第 2 学期年份取 2026） |
| `gxstnu-calendar-page` | 用户停在教学周历页：同上，不多发不带查询串的 GET |
| `gxstnu-home` | 停在首页：先 `GET jxzl_query` 取默认学期，再课表 GET、周历 GET |
| `gxstnu-home-no-selected` | 周历页下拉框没有 `selected` 属性：取第一项 2025-2026-1 并出「没有标出当前是哪一学期」提醒 |
| `gxstnu-http` | http 页面：相对路径跟着协议走 |
| `gxstnu-cal-500` | 周历 GET 返回 500：不致命，开学日按最近周一推算并提醒、总周数 20 |
| `gxstnu-no-term` | 周历页没有下拉框：「找不到学年学期的选项」 |
| `gxstnu-cas`、`gxstnu-login-form` | 统一认证页（别的主机）/ 本校登录页：直接报错，**不发任何请求** |
| `gxstnu-expired` | 课表 GET 返回登录页：「登录已失效」 |
| `gxstnu-redirect-cas` | 课表 GET 被 302 跳到认证页：报登录相关错误、不导入（假站拦下跨源跳转时表现为「连不上教务系统」，真实浏览器由 `readPage` 的主机检查报「登录已失效」） |
| `gxstnu-500` | 课表 GET 返回 500：「教务系统返回错误（代码 500）」 |
| `gxstnu-empty` | 课表里一门课都没有：parse.js 报「没有解析到任何课程」，不导入空学期 |

### 11.2 变异测试

每次把整件复制到 `C:/Users/23703/AppData/Local/Temp/gxstnu-port37/mut/m<编号>/gxstnu/`，在副本的 parse.js 唯一锚点上改一处，运行 check.js，记下变红的用例。真实目录的 parse.js 没有被改动，收尾后重跑自检为 PASS。

| 编号 | 改坏的位置（parse.js） | 变红的用例 |
|---|---|---|
| M1 | `weeksOf`：`marks` 只取前缀（后缀单双标记不认） | basic、week-forms、skipped-long |
| M2 | 周历不按格子的位置倒推（`firstDate` 不减 `offset`） | basic、week-forms、week-notes、merge、calendar-offset、calendar-spring、period-extend、skipped-long |
| M3 | H3 顺推越过 23:59 也补（`> MAX_MINUTE` → `> 99999`） | period-extend |
| M4 | `cleanTeacher` 不去职称 | basic |
| M5 | 同周相邻节次不合并（`<= last[1] + 1` → `<= last[1]`） | merge |
| M6 | 周历年份永远取前一年 | calendar-spring |
| M7 | 前缀段吞掉后一个单双标记（去掉「退回下一段」分支） | week-forms |

7 处全部变红；全部在副本上做，真实目录未改动。

## 12. 已知风险、未验证项

- **没有本校账号，真机没验过。** 课表格子的类名（`table.qz-weeklyTable`、`.qz-tooltip li.qz-toolitiplists`、`.qz-tooltipContent-title`、`.qz-tooltipContent-detailitem`）、周历的 `#dataTable` / `td.qz-weeklyTable-label`、学期下拉框 `#xnxq01id` 都是按上游代码的判据写的，没有对照真实页面 HTML。冒烟用的假页面是按这些判据我们自己搭的，只能证明代码与自己的假设一致。
- **周历只有周末带月份。** 这是上游注释明确写的（工作日格子是「07」，周末是「09月12日」）。本件取第 1 周第一个带完整日期的格子按行内位置倒推；若真实页面**所有**格子都只有日号（没有完整日期），会走「开学日按最近周一推算」并提醒，不会静默写错。若周历第一列不是日期（多一列说明文字），行内位置会整体偏移一天，提醒里已要求核对开学日。
- **周历的 colspan / rowspan 不还原。** 日历行里的合并单元格会让「第几格」对不上；上游用 layout 还原，本件的 extract 按文档顺序交格子。正常周历没有合并，属于未验证项。
- **每周起始日。** 上游 `firstDayOfWeek` 取周历第一列的星期几（有的学期星期一、有的星期日）。本件让 `firstDay` 保留这个星期几，应用据此排周视图；不是周一时提醒说明。需要真机核对周视图列顺序。
- **年份是推出来的。** 周历格子只有月日，年份靠学期代码推（第 1 学期取前一年、其余取后一年），与上游一致。暑期短学期若第 1 周在 8 月之前开始且代码是第一学期，会差一年——结果错了会体现在「现在是第几周」上，提醒里已要求在「学期管理」核对。
- **节次时间是上游写死的表。** 我们没有对照学校公布的文件核实，也没有按校区区分；提醒第二条每次都说明了来源。
- **周次写法覆盖面。** 只认 `weeksOf` 注释里列的写法；认不出的整条卡片跳过并点名（不猜）。上游 tooltip 里「时间」一行的真实样子只有注释里的例子（`1-8,10-13周[1-3节]`），本件按「周次文字 + 方括号节次」的通用形状解析，同一行里写几段（`1-8周 [1-2节] 9-16周 [3-4节]`）也认。
- **课名里的 `●★○` 标记没有清理。** 任务卡提到「按上游清理」，但上游 gxstnu_01.js 全文没有这段代码；本件按「以代码为准」保留课名原样。如果真实课名带这类标记，会原样显示，需要后续补。
- **隐藏行 / 隐藏列。** 格子文字只交有无、tooltip 只交三个白名单字段，学号姓名出不来；但隐藏的课程卡片仍会按上游口径导入（上游 `parseTimetableToModel` 也不看可见性）。若真实页面用隐藏行放别的周次，可能多导入，需真机核对。
- **同课合并的口径。** 同名、同老师、同地点、同星期的卡片按周拆开再合并；同一门课在两个不同地点上会得到同一门课下的两条块，不会被合并成一条。
- **页面有多张课表。** 取表头认得出星期的第一张并提醒；若真实页面有两张结构相同、内容不同的课表（如「本学期」与「下学期」），导入的可能不是想要的那张。
- **登录页判断。** 同主机的登录页靠登录表单元素或「短标题含登录」识别；若学校的登录页两者都不满足，会在拿到页面后因找不到课表或学期而报错（不会静默导入）。
- **上游快照一致性。** `git log -1 -- resources/GXSTNU/gxstnu_01.js` 的提交为 `e2e5a21`（2026-11-11），与任务卡一致；快照提交 `1dc9ac6` 与 origin/main 对齐。

## 13. 签名

0x7E7-2023（haiku 移植，2026-11-11）
