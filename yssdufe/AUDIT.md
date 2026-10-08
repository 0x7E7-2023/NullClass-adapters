# 山东财经大学燕山学院（yssdufe）移植审计

本文件记录移植件的来源、请求与读写面、手册 §5 与批次三 checklist 的逐条结论、与模板件的差异、删掉的上游逻辑、变异测试与未验证项。
这里的每一条声明都对应当前代码；没有核对的地方写在 §11。

## 1. 来源（provenance）

- 上游仓库：https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT）
- 上游文件：`resources/YSSDUFE/yssdufe_01.js`，上游作者 星河欲转。核对用的克隆 HEAD 为 `ff72d1f`（位于本机临时目录，不随本件提交）。
- 上游同目录 `resources/YSSDUFE/adapters.yaml`：adapter_id `YSSDUFE_01`，adapter_name「山东财经大学燕山学院强智教务」，import_url `https://ysjw.sdufe.edu.cn:8081/jsxsd/`，maintainer 星河欲转。
- 上游文件头写的是 `ys.sdufe.edu.cn`，但代码里真正请求的是 `https://ysjw.sdufe.edu.cn:8081`（`BASE_URL`）。以代码为准。
- 平台：强智 jsxsd 学生端（`/jsxsd/`），**非标准端口 :8081**。
- 结构骨架参照模板件；选择器与请求体以本校上游为准，逐条差异见 §7。
- 移植者：0x7E7-2023（haiku 移植，2026-10-08）。

## 2. 请求表

extract.js 里有两处 `fetch(` 字面量（`requestText` 与 `fetchTerm`），运行时最多发出下面三个请求。路径都是页面同源的相对路径，`credentials: 'same-origin'`。

| # | 方法 | 路径 | 请求体 | 何时发 | 作用 | 上游对应 |
|---|---|---|---|---|---|---|
| R1 | GET | `/jsxsd/jxzl/jxzl_query` | 无 | 每次提取 | 读教学周历页上 `xnxq01id` 下拉框的选中学期 | `requestSemesterPage()` |
| R2 | POST | `/jsxsd/jxzl/jxzl_query` | `xnxq01id=<学期代码>` | 拿到学期代码时 | 开学日期与周号（教学周历） | `requestSemesterDetailPage()`，请求体一致 |
| R3 | POST | `/jsxsd/xskb/xskb_list.do` | `jx0404id=&cj0701id=&zc=&demo=&xnxq01id=<学期代码>` | 仅当当前页面没有课表格子 | 课表 | `requestCoursePage()`，请求体一致 |

请求体里只有学期代码（来自页面）和上游原样保留的空查询参数。不带学号、姓名、令牌，也不读任何本地存储。

## 3. 端口与 allowHosts

- `manifest.json` 的 `allowHosts` 为 `["ysjw.sdufe.edu.cn"]`，只有一个精确主机名，**没有通配**。
- 非标准端口 8081 **不写进 allowHosts**。宿主的白名单按主机名比较，不含端口：`JwHostAllowlist.matches` 只接收主机名，它的两个调用方分别用 `uri.host`（`JwImageOcr`）和 `Uri.parse(url).host`（`JwWebViewStep.hostOf`），两者都不带端口。因此 `https://ysjw.sdufe.edu.cn:8081/...` 与 `allowHosts` 匹配。
- `loginUrl` 与 `scheduleUrlHint` 保留 `:8081`。
- 请求用相对路径，脚本里没有写死主机名。
- 上游静态扫描（手册 §5 的两条命令）：URL 主机只有 `https://ysjw.sdufe.edu.cn`；`fetch(` 出现 3 处（上游第 197、209、223 行），全部使用 `URL_SEMESTER` / `URL_COURSE` 常量，指向同一主机；没有 `XMLHttpRequest`、`sendBeacon`、`new WebSocket`、`.src =`。

## 4. 读取面与输出面

读取，只读，不写页面：

- **活页（`document`）**
  - 课表表格：`#kbtable`；找不到则取第一张包含 `.kbcontent` 的表。逐格读文字（`textContent`）、`colspan` 与 `rowspan`，以及 class 精确为 `kbcontent` 的 `div` 的 `innerHTML`。
  - 学年学期：`id` 或 `name` 含 `xnxq` 的 `select`，读选项值（形如 `2026-2027-1`）与选中项的文字。没有选中项时取第一个合规选项（`readTerm`，不出提醒）。
  - 页面地址：只取协议、主机（含端口 8081）与路径，写入载荷的 `pageUrl`。查询串不交，它可能带学号（§11 第 7 条）。
  - 本地日期，写入 `now`，只在拿不到开学日时用于推算。
- **R1 返回的教学周历页**：只读学期下拉框，规则同上。
- **R2 返回的教学周历**：`#kbtable`；找不到则取第一张 `td[title]` 为「YYYY年MM月DD日」的表（「日」字可有可无，上游的周历正则就不带「日」，见 §11 第 1 条）。只交有文字或有 title 的格子，并保留网格列号。
- **R3 返回的课表页**：课表规则同活页。解析用 `DOMParser` 的离线文档，不挂到页面上。

学期的来源：页面上有课表格子时，学期取页面下拉框的选中项，即屏幕上那一学期；页面上找不到下拉框时，载荷带 `screenTermMissing`，学期改取 R1 的选中项，并出一条提醒（§11 第 11 条）。页面上没有课表格子时，学期取 R1 的选中项，再发 R3 请求课表。R1 拿不到学期代码时（请求失败，或 R1 页面没有学期选项），学期退回页面自己的下拉框；两处都没有学期代码时，屏幕上有课表格子则用占位学期名并出提醒（§6 第 7 条），没有课表格子则报错、不导入。

输出：

- extract.js 交给 parse.js 的 JSON 载荷（parse.js 不读取 `pageUrl`）：`source`、`pageUrl`（只含协议、主机与路径）、`now`、`term{code,name}`、`screenTermMissing`（课表页上找不到学年学期下拉框时为真）、`cols`、`calendar{found,rows}`、`rows`（每格含 `col`、`span`、`text`、`parts` 原始 HTML）。
- parse.js 的输出：`specVersion 1`、`kind schedule`、`ocrAssisted false`、`warnings`（最多 20 条，每条不超过 200 字；超过 20 条时第 20 条为汇总，§6 第 5 条）、`terms`（一个学期，含 `name`、`firstDay`、`totalWeeks`、`periodTimes`、`courses`）。

脚本不写页面、不写存储、不向本校以外的地址发送任何东西。

## 5. 手册 §5 安全审计八条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | extract.js 与 parse.js 不读 password、pwd、token、localStorage、sessionStorage、cookie（grep 无命中）。请求只声明 `credentials: 'same-origin'`，会话由浏览器附带，脚本读不到也不转发。 |
| 2 | 不外发 | 通过 | `fetch(` 两处字面量，都是同源相对路径；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。 |
| 3 | 请求域可控 | 通过 | `allowHosts` 只有 `ysjw.sdufe.edu.cn`，没有通配；端口 8081 的匹配依据见 §3。 |
| 4 | 只读课表 | 通过 | 三个请求都是学生端的课表与教学周历（R1 至 R3）；不请求成绩、学籍、缴费或个人信息页面。 |
| 5 | 不埋点 | 通过 | 没有统计、上报或遥测代码（grep 无 analytics、track、beacon）。 |
| 6 | 不 eval 远程代码 | 通过 | 两个文件都没有 `eval` 与 `new Function`；check.js 的词法扫描为 PASS。 |
| 7 | 不写页面 | 通过 | extract 只读活页，解析用 `DOMParser` 离线文档；没有 innerHTML 赋值、appendChild 或表单提交（grep 无命中）。模板件的 `window.validateYearInput` 全局函数与季节弹窗已删（§7）；上游的 `showAlert` 等界面调用已删（§8）。 |
| 8 | 不依赖秘密 | 通过 | 没有硬编码的密钥、令牌或学号；学期代码来自页面。 |

## 6. 批次三 checklist 十条

来源：`docs/impl/2026-09-13-port-adapters-batch3.md` 的十条移植要求。

| # | 要求 | 结论 | 落点 |
|---|---|---|---|
| 1 | 周次编码四种写法 | 实现 | `weeksIn`（parse.js）。fixtures `week-forms` 覆盖 `1-16周(单)`、`(单)1-16周`、`1-16(单周)`、`1-16(周)`。 |
| 2 | 括号内纯数字不是周次 | 实现 | `SERIAL_PAREN`。fixtures `week-forms` 的 `(1)`、`(1-2)`。 |
| 3 | 无星期表头：不许按数组长度猜列 | 实现，有一处保留的推断（主调度第 2 条） | 有表头时，列号只用 extract 交出的网格列号 `col`（已算 colspan / rowspan），不按数组长度。没有表头时，窗口取网格宽度（`gridWidthOf`：所有行 `col + span` 的最大值与 `data.cols` 中较大者）减 7，即最后 7 列，**不是**每行的 `row.length - 7`；每次都进 warnings（fixtures `col-align`）。没有 `col` 的格子跳过并计数（`withColOnly`，fixture `no-col-cell`）。与批次三第 3 条的关系见 §11 第 4 条。 |
| 4 | periodTimes 为 HH:mm，范围 00:00 至 23:59，end 晚于 start | 实现 | `clockMinutes` 与 `timePair`。越界的时刻夹住并计数进 warnings。 |
| 5 | warnings 最多 20 条，每条不超过 200 字 | 实现 | `pushWarning` 去重，每条超过 200 字截断（含「…」）。`finalWarnings`：不超过 20 条原样输出；超过 20 条时保留前 19 条，第 20 条写「另有 N 条提醒未列出」（N 为总数减 19）。现有用例都走不到这个汇总分支：提醒最多的是 `dropped-limits`，3 条。parse.js 有 21 个 `pushWarning` 调用点（grep 计数）；单次运行最多能产生多少条互不相同的提醒，没有穷举。见 §10 与 §11 第 8 条。 |
| 6 | 分页 | 不适用 | 教学周历页与课表页都是单次整页返回，页面上没有记录总数字段。 |
| 7 | 学期名 | 实现 | 优先用教务给的名称（下拉框选中项的文字）；没有则由学期代码拼名：代码须是 `YYYY-YYYY-N`，N 为 1、2、3 时拼成第一、第二、第三学期，其他个位数拼成「第N学期」（如 `2026-2027-1` 拼成「2026-2027学年第一学期」，`2026-2027-4` 拼成「2026-2027学年第4学期」），不带学校名；代码不合此形式时拼不出；两者都没有则用「山东财经大学燕山学院当前学期」占位，并出一条提醒，请用户在「学期管理」里改名。提醒与占位都不使用适配器名。见 §11 第 12 条。 |
| 8 | teacher 拿不到就留空 | 实现 | `teacherOf` 与 `roomOf` 缺失时返回 null。上游写的「未知教师」「未知地点」只用来识别，识别后置 null，不作为输出值（主调度第 10 条）。 |
| 9 | allowHosts 不写死主机，用同源相对路径 | 实现 | 见 §2 与 §3。 |
| 10 | 每件都做变异测试 | 实现 | 见 §10：十二处变异全部变红（都在副本上做，真实文件未改）；关掉汇总分支这一条没有用例能变红，原因见 §10 与 §11 第 8 条。 |

## 7. 与模板件的差异

extract.js：

- 删掉模板件的年份输入验证（`window.validateYearInput`）与「第一学期 / 第二学期」选择，学期只取页面选中项。
- 删掉模板件的季节提问（`pickSeason` 与 `__ncSelect`）。本校用统一作息，载荷里没有 `season` 字段。
- 课表容器：模板件写 `#timetable`；本件用上游的 `#kbtable`，找不到时取含 `.kbcontent` 的最近表格。
- 教学周历请求体：模板件是 `xnxq01id` 加 20 组重复的 `xqt`；本件只有 `xnxq01id`，与上游一致。
- 课表请求体：模板件带 `sfFD=1&wkbkc=1`；本件与上游一致，不带这两项。
- 明细 div：模板件优先取 `display:none` 的那份；本件取 class 精确为 `kbcontent` 的全部 div（上游同样只读这个 class），重复由 parse.js 按块去重。

parse.js：

- 作息：模板件是冬令、夏令两套；本件是一张统一的 11 节表，外加节次超过 11 时的占位档。
- 分隔线：本件的 `DASHES` 是 `-{5,}|－{5,}`，即 5 个以上连字符或全角连字符。上游是两个字面量（21 个和 22 个连字符）。这是与上游的差异，理由见 §8 的「分隔线」一行。
- 周次、节次、起始日、warnings 文案等其余 parse.js 行为，没有与模板件的 parse.js 逐行核对，见 §11 第 10 条。

## 8. 上游删掉或改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `fetchSemesterList` 与 `showSingleSelection`：列出页面学期（选中项前后各 3 个）让用户选 | 删；学期取页面下拉框的选中项，不再弹列表 | 页面上选中的学期就是用户正在看的那一学期，不必再选一次。 |
| 上游的统一作息表（`saveAppTimeSlots`） | 保留这张统一表（11 节），外加占位档 | 上游本身就是统一作息，不需要提问。 |
| `showAlert`、`showToast`、`notifyTaskCompletion` | 删 | 提示与流程由宿主负责；适配器只读，不驱动界面。 |
| 上游 `semesterTotalWeeks = totalWeeks || 20`（上游第 309 行）；`totalWeeks` 取周历首列整数单元格的最大周号，取不到才是 20 | 有周历：总周数取周历的周数（`calendarWeeks`）；课表里有更晚的周次（`maxWeek`）时抬高到它，并出提醒「课表里有到第 N 周的课，比教务教学周历的 M 周多……」。没有周历：按兜底的 20 周（`FALLBACK_TOTAL_WEEKS`），并出提醒。超过 30 时按 30 周计，超出的周次丢弃并计数、出提醒（fixtures `school-boundary`、`calendar-weeks-only`、`col-align`、`total-weeks-raised`、`dropped-limits`） | 上游的 20 只是取不到周历时的兜底，不能当成总周数：周历是 18 周时按 20 周计，就会多出两周。上限 30 是**有意偏离**的：把第 31 周以后的课压到第 30 周会把它们错放到第 30 周上，丢掉并说明更安全（见 §11 第 16 条）。 |
| 开学日取第一行第一个 `td[title]` | 先按表头与「1」行的周一格取，不是周一则按所在周的周一对齐；取不到才用第一个带日期的格子：若它是星期日，它所在的那一周从星期日开始，周一是下一天（+1），其他星期几则往前对齐到周一；都取不到则按提取时刻推算最近的周一。周一日期直接采用、不出提醒；按提取时刻推算的路径总是出提醒；其余两条路径只在实际对齐（不是周一）时出提醒（fixtures `non-monday-first-day`、`titled-sunday`） | 第一个带日期的格子可能是星期日，直接当开学日会差一周。两条路径的对齐方向不同，是因为两种表格排法不同，见 §11 第 2 条。 |
| `parseWeeks` 用 `weekStr.split('(')[0]` | 重写为 `weeksIn` | 这样会丢掉括号里的单、双标记：「1-15(单周)」会被读成每周都上。 |
| 节次用 `split('-')` 取首尾两个数 | 认逗号写法与两位连堂；连字符连排（`[01-02-03-04节]`、`[09-10-11节]`）按首尾取，即 1 至 4 节、9 至 11 节 | 「[09,10节]」里没有 `-`，上游整块丢掉。上游的 `split('-')` 取首尾，能读 3 个及以上数字的连排；本件原先整门课跳过，已与上游对齐（fixture `periods-chain-dash`）。 |
| `mergeAndDistinctCourses`：按名字排序，合并相邻节次与同节次的周次 | 不照搬；只去掉同一门课里完全相同的块 | 合并会改写原始块的节次与周次边界，无法对照页面核对；工作规则第 6 条要求不改、不丢。 |
| `teacher || "未知教师"`，`position || "未知地点"` | 空则 null；这两个字样只用来识别，识别后置 null，不作为输出 | 移植要求第 8 条；这些字样会被当成真名显示。主调度第 10 条：保留识别，不输出。 |
| 没认出课名、周次或节次的块：`if (name && startSection > 0)` 静默跳过 | 计数，并点名（最多 5 个）进 warnings | 工作规则第 6 条：不许静默丢课。 |
| 没有节次上限 | `MAX_PERIOD = 16`；超限的块跳过、计数、点名 | 占位档的公式 `pad2(7 + n)` 对 n 大于 16 会补出 24:00 以后的时刻，载荷校验会拒收整次导入。 |
| 分隔线：两个字面量（21 个和 22 个连字符） | 5 个以上连字符，或 5 个以上全角连字符，都切开 | 上游只按 21 或 22 个连字符切，20 个或更少不切；本件放宽到 5 个以上（全角也认）。放宽后，课程名里若出现 5 个以上连字符会被误切，这种情况罕见。 |
| 课程名：第一个非空文本节点 | 第一个 font 之前的第一个非空文本行；保留模板件来的无 title 的 font 兜底（`nameOf`） | 上游没有这条兜底，它来自模板件。主调度定为保留（§11 第 9 条）。 |

## 9. fixtures（17 对，全部为合成数据）

本轮（B1 至 B6）改过期望值的有 col-align、school-boundary、calendar-weeks-only、titled-sunday、week-forms、bracket-parity、dropped-limits、no-col-cell，原因见下表的说明列。basic、non-monday-first-day、weeks-space-segments、term-name-from-code、screen-term-missing、term-name-placeholder 未改。新增的三对（B1、B2、B3）各只改 basic 的一处输入，期望值按规则手推后写入，不取 parse.js 的输出。

| 用例 | 有效课程 | warnings | 覆盖的内容 |
|---|---|---|---|
| basic | 8 | 0 | ALL、ODD、EVEN 三种周次类型；多段周次；同一格里两门课；教师与教室为空（创新创业基础） |
| week-forms | 13 | 3 | 四种写法；类序号 `(1)`、`(1-2)`；「1-16周 双」；「第3周」；无周历时由提取时刻推算开学日，并按兜底的 20 周计总周数（两条提醒）；无法认出的 `1-16周(单双)` 与 `1-16周隔周` 合为一条 warning，列出样本 |
| col-align | 5 | 2 | 无星期表头，出提醒；8 列表格取最后 7 列；周历 18 周，总周数取 18（不再用内置的 20 周）；跨列的体育课同时放进周五与周六，出一条提醒 |
| dropped-limits | 2 | 3 | 占位节次 12、13（19:00 与 20:00 档）；第 31、32 周被丢弃；5 个块被跳过并点名：2 个节次超出 16 节（[17-18节]、[19-20节]），1 个没认出课名，1 个没认出周次，1 个没认出节次；名单截断在 200 字以内 |
| bracket-parity | 15 | 3 | 方括号内的单、双、单双标记；全角、半角、en dash、em dash 的区间分隔符；「至」「到」；无周历，开学日按提取时刻推算、总周数按兜底 20 周，各出一条提醒；认不出的单双标记出一条提醒 |
| weeks-space-segments | 8 | 0 | 空白分段「1-3周 5-9周」读成两个块、不并段；全角波浪「[05～06节]」与半角读出的节次一致 |
| school-boundary（本校专属边界用例） | 4 | 0 | 周历 22 周，课表最大 22 周，总周数取 22（由周历给出，不出提醒）；`1-15(单周)`、`2-14(双周)`、`1-22周`；`1-20周[10-11节]` 的第 11 节是 20:10-21:50，不需要占位 |
| calendar-weeks-only | 4 | 0 | 周历 22 周、课表最大 16 周，总周数 22 只能来自周历（周历给出了周数，不出提醒）；若 M3 把周历的 21、22 周忽略，总周数会变成 20 |
| titled-sunday | 3 | 2 | 周历表头是「日一…六」，第 1 行写「首周」而不是「1」；第一个带日期的格子是 2026-09-06（星期日），对齐到 2026-09-07 并出 warning；周历没有给出周数，总周数按兜底的 20 周计，并出一条提醒 |
| non-monday-first-day（C，主调度第 1 条） | 8 | 1 | 周历「1」行的星期一格写成 2026-09-08（星期二）。开学日按所在周的周一对齐为 2026-09-07，出一条提醒；覆盖开学日的 `aligned !== firstDay` 分支 |
| no-col-cell | 7 | 1 | 「创新创业基础」所在格（`rows[4][3]`）去掉 `col`：该格跳过，整门课不导入（8 → 7），计数出一条提醒；不按数组下标补列 |
| term-name-from-code | 8 | 0 | `term.name` 为 null，学期代码 2026-2027-1 拼成「2026-2027学年第一学期」，不出提醒 |
| screen-term-missing | 8 | 1 | `screenTermMissing: true`：课表页上没有学年学期下拉框，学期取教学周历页的选中项，出一条提醒 |
| term-name-placeholder | 8 | 1 | 学期名与学期代码都为 null：学期名占位为「山东财经大学燕山学院当前学期」，出一条提醒 |
| calendar-no-day-mark（B1） | 8 | 0 | 周历日期不带「日」（如「2026年08月31」）：第 1 周的星期一格直接读出开学日 2026-08-31，不退成推算，不出提醒 |
| periods-chain-dash（B2） | 8 | 0 | 「[01-02-03-04节]」取 1 至 4 节，「[09-10-11节]」取 9 至 11 节，两门课都不再跳过 |
| total-weeks-raised（B3） | 8 | 1 | 周历 20 周，课表里大学物理到第 21 周：总周数抬到 21 并出一条提醒；其余课不变 |

## 10. 变异测试

每次：把整件复制到临时目录，在副本的 parse.js 唯一锚点上改一处，运行 check.js，记下变红的用例。真实目录的 parse.js 没有被改动，所以无需还原。真实目录上的最终 check 为 `RESULT: PASS`。M4、M5、M6 为第二轮新增；MB 系列为本轮新增，依次对应 B1、B2、B3（两处）、B6。每个用例名只计一次。

| 编号 | 改坏的位置（parse.js） | 改坏后的效果 | 变红的用例 |
|---|---|---|---|
| M1 | `var oddOnly = segment.indexOf('单') >= 0;` 改为 `var oddOnly = false;` | 单标记失效，「单」段按每周处理 | 14 个：basic、week-forms、bracket-parity、weeks-space-segments、school-boundary、titled-sunday、non-monday-first-day、no-col-cell、term-name-from-code、screen-term-missing、term-name-placeholder、calendar-no-day-mark、periods-chain-dash、total-weeks-raised |
| M2 | `'20:10-21:50'` 改为 `'20:10-21:40'` | 第 11 节结束时刻错 10 分钟 | 17 个，即全部用例 |
| M3 | `if (value > max) max = value;` 改为 `if (value > max && value <= FALLBACK_TOTAL_WEEKS) max = value;` | 周历里超过 20 周的周号被忽略，周历周数最多算到 20 | 2 个：school-boundary（周历只算到 20，总周数 22 由课表抬出，多出一条「课表里有到第 22 周的课……」提醒，应为 0 条）、calendar-weeks-only（totalWeeks 为 20，应为 22） |
| M4 | `else noColCells++;` 改为 `else { noColCells++; grid[r][c].col = c; kept.push(grid[r][c]); }` | 缺 `col` 的格子改回按数组下标补列并保留，即删掉的回退 | 1 个：no-col-cell（课程数 8，应为 7） |
| M5 | `termName = SCHOOL_NAME + '当前学期';` 改为 `termName = '山东财经大学燕山学院课表';` | 学期名占位退回旧的「课表」字样 | 1 个：term-name-placeholder（学期名与提醒文字都不符） |
| M6 | `if (data.screenTermMissing === true) {` 改为 `if (false) {` | 课表页无下拉框的提醒被关掉 | 1 个：screen-term-missing（warnings 为 0 条，应为 1 条） |
| M7 | `if (warnings.length <= MAX_WARNINGS) return warnings;` 改为 `if (warnings.length <= 0) return warnings;` | 任何非空提醒列表都走汇总分支，汇总行「另有 0 条提醒未列出」被追加到本来没有超限的列表末尾 | 10 个：week-forms、col-align、dropped-limits、bracket-parity、titled-sunday、non-monday-first-day、no-col-cell、screen-term-missing、term-name-placeholder、total-weeks-raised。这一条测的是汇总分支的接线与文字，不是「关掉汇总」。school-boundary、calendar-weeks-only 的提醒列表为空，空列表原样返回，不变红。 |
| MB1 | `日?/.exec(text);` 改为 `日/.exec(text);`（周历日期的「日」字改回必须有） | 周历日期不带「日」时读不出，开学日退成推算并出提醒 | 1 个：calendar-no-day-mark（开学日 2026-09-07 而非 2026-08-31；提醒 1 条而非 0 条） |
| MB2 | `+$/.test(segment)) {` 改为 `+$/.test(segment) && false) {`（关掉连字符连排分支） | 3 个及以上数字的连字符写法整门课被跳过 | 1 个：periods-chain-dash（课程 6 门，应为 8 门） |
| MB3a | `var baseWeeks = calendarWeeks > 0 ? calendarWeeks : FALLBACK_TOTAL_WEEKS;` 改为 `var baseWeeks = Math.max(FALLBACK_TOTAL_WEEKS, calendarWeeks);` | 周历给出的周数被内置 20 周垫底，周历不到 20 周时仍按 20 周计 | 1 个：col-align（totalWeeks 为 20，应为 18；提醒数与文字不符） |
| MB3b | `var wantedWeeks = Math.max(baseWeeks, maxWeek);` 改为 `var wantedWeeks = baseWeeks;` | 课表里有更晚的周次时不抬高总周数 | 1 个：total-weeks-raised（totalWeeks 为 20，应为 21；提醒 0 条，应为 1 条） |
| MB6 | `个格子无法确定它是星期几` 改为 `个格子缺少网格列号`（提醒文字退回开发者用语） | 提醒文字被改坏时，fixture 会变红（文案钉住，不是逻辑） | 1 个：no-col-cell（提醒文字不符） |

**关掉汇总分支不能变红（§11 第 8 条）。** 把 `finalWarnings` 的汇总关掉（直接 `return warnings`）后，任何用例的输出都不变：没有用例会产生超过 20 条的提醒（§6 第 5 条），所以这条变异没有用例能测到。check.js 的载荷校验（`warnings` 不超过 20 条）也只在某个用例真的超限时才会拒收。M7 已经覆盖了汇总分支的接线与文字，但它测的是「汇总被触发」，不是「汇总被关掉」。要让「关掉汇总」可测，需要主调度决定：(a) 增加一个能重复产生提醒的输入源，让某个用例超过 20 条；或 (b) 把它当作不可达的防御代码，靠 M7 与代码审读覆盖。建议 (b)：人为制造超限会把测试绑在不真实的输入上。

所有变异都在副本上做，真实目录的 parse.js 没有被改动。

## 11. 已知风险、未验证项与主调度已定的点

「主调度第 N 条」指主调度第二轮的决定编号。第 1 至 16 条的编号保持稳定（extract.js 文件头引用了「§11 第 7 条」）。

1. **没有真实页面。** fixtures 全部是合成数据（`_note` 字段标明）。`kbcontent`、`font[title=...]`、`td[title]`、`xnxq01id` 这些名字来自上游代码，未在真实页面上核对。
2. **开学日的对齐（已定：保留，主调度第 1 条）。** 两条路径往相反方向对齐，是因为两种表格排法不同：
   - 周历第 1 周那一行的「星期一」格不是周一（如写的是星期二或星期日）：往前退到所在周的周一（`mondayOf`），出提醒。往前退到上一个周一，符合手册 §4.3。fixture `non-monday-first-day` 钉住星期二的情况。
   - 周历没有「1」标签，只能用第一个带日期的格子（`calendarFirstTitled`，再由 `mondayFromTitled` 对齐）：若它是星期日，说明该行的一周从星期日开始（日一…六），这一周的周一在下一天，所以 +1；其他星期几仍往前对齐。非周一时出提醒。fixture `titled-sunday` 钉住这一点。

   残余风险：若某校的周历排法与这两条假设都不符，推出的开学日会差一周。两条路径在非周一时都出提醒，请用户在学期管理里核对。
3. **「第 1 周的星期一格不是周一」分支（已覆盖）。** 由 fixture `non-monday-first-day` 覆盖（期望开学日 2026-09-07，出一条提醒）。没有变异测试针对它。
4. **无表头的表宽推断（已定：保留，主调度第 2 条）。** 没有星期表头时，窗口 = 网格宽度 − 7（`gridWidthOf`：所有行 `col + span` 的最大值与 `data.cols` 中较大者），不是每行的 `row.length - 7`；每次都出提醒（fixture `col-align`）。与批次三第 3 条的关系：第 3 条禁止按数组长度猜列，本件满足这一点，列号只来自 extract 的网格列号。第 3 条后半句「没有表头且拿不到列号时：进 warnings，不许猜」的前提是拿不到列号；本件有列号，按字面不触发。但无表头时按表宽推最后 7 列仍是一种推断，未经真实页面验证。
5. **缺 `col` 的格子（已删回退，主调度第 3 条）。** `colOf` 只读 `cell.col`，不再按数组下标回退。缺 `col` 的格子在 `withColOnly` 里跳过并计数，出一条提醒「有 N 个格子无法确定它是星期几……」。计数包含课表格子与周历格子，所以提醒只说「这些格子里的内容没有用上」。fixture `no-col-cell`；变异 M4 把回退写回去后该用例变红。
6. **同一格里的两份 `kbcontent`。** 本件读取 class 精确为 `kbcontent` 的全部 div。若真实页面同一格有两份明细，靠 parse.js 的块去重合并，未在真实页面核对。
7. **pageUrl（已定：只交协议、主机与路径，主调度第 7 条）。** 载荷的 `pageUrl` 为协议加主机（含端口 8081）加路径，不含查询串。查询串可能带学号，所以不交。路径本身不做过滤；若路径里带有标识符，它仍会进入载荷。载荷只在本地解析，不外发。
8. **warnings 超过 20 条（已定：前 19 条加汇总，主调度第 4 条）。** 超过 20 条时，前 19 条照常，第 20 条写「另有 N 条提醒未列出」（N 为总数减 19），每条仍不超过 200 字。现有用例都走不到这个分支（§6 第 5 条：提醒最多的用例只有 3 条）；代码路径能否走到，没有穷举。关掉它也不会让任何用例变红（§10）。
9. **课程名的裸 font 兜底（已定：保留，主调度第 8 条）。** `nameOf` 保留模板件来的无 title 的 font 兜底。上游没有这一步。
10. **parse.js 与模板件 parse.js 的逐行差异没有核对。** 只核对了 extract.js 的差异，以及 parse.js 的行为。
11. **学期来源（已定：屏幕学期优先，缺下拉框时出提醒，主调度第 9 条）。** 页面有课表格子且有下拉框时，学期只取屏幕那份，不存在两个来源不一致的情况，所以没有做比对。页面有课表格子但找不到下拉框（`screenTermMissing`）时，学期改取 R1 的选中项，并出一条提醒说明导入的是哪一学期（fixture `screen-term-missing`）。残余风险：R1 页面没有选中项时，`readTerm` 取第一个合规选项且不出提醒；此时若课表页也没有格子，导入的是 R1 默认的那一学期，用户无从得知。
12. **学期名（已定：由学期代码拼名，占位出提醒，主调度第 6 条）。** 取法：教务给的名称（下拉框选中项的文字）→ 学期代码拼成「2026-2027学年第一学期」（`termNameFromCode`，不带学校名，按主调度给的例子）→ 两者都没有则用「山东财经大学燕山学院当前学期」占位，并出提醒，请用户在「学期管理」里改名。主调度的表述「学校名 + 学年学期」有两种读法：例子是不带学校名的写法，本件按例子实现；若要带学校名，改 `termNameFromCode` 的返回值，并同时更新 fixture `term-name-from-code` 的期望学期名。
13. **`clockMinutes` 的分钟数不检查上限。** 分钟在 60 至 99 时不计入 badTimes，也不夹住。但它只被内置时刻与占位公式调用，运行时不会收到这种值。
14. **宿主端口处理是读代码确认的。** `JwHostAllowlist.matches` 与 `JwWebViewStep.hostOf` 的端口行为是读代码确认的，没有在设备上跑过。
15. **`minAppVersionCode` 为 11。** 依据手册 §5.1：载荷只用 `kind: schedule` 与 `warnings`，没有 boxes、image，不用提问桥，也不用 OCR。
16. **学期总周数上限 30（有意偏离，主调度第 5 条）。** 上游的 `totalWeeks || 20` 里，20 只是取不到周历时的兜底。本件有周历时取周历的周数（课表有更晚的周次时抬高，见第 17 条）；没有周历时按 20 周计并出提醒（fixtures `titled-sunday`、`week-forms`、`bracket-parity`）；超过 30 时按 30 周计（`wantedWeeks` 超过 `MAX_WEEK` 时出提醒）。31 周以后的周次丢弃并计数，出提醒（fixture `dropped-limits`）。不把超出部分压到第 30 周，因为压进去会把第 31 周以后的课错放到第 30 周上。残余风险：若某校的学期超过 30 周，那部分课会丢失，只有提醒，没有补救。
17. **课表周次抬高总周数（已按主调度 B3 实现）。** 课表里有比周历更晚的周次时，总周数抬到课表的最大周次，并出提醒（fixture `total-weeks-raised`）。残余风险：页面上某个写错的周次会把总周数拉长，只有提醒，没有逐项核对。

## 12. 与源码文件头的对应

extract.js 文件头：

- ①（学期取页面选中项）：§8 第一行。
- ②（不问冬令时 / 夏令时）：§7、§8。
- ③（只交原始结构）：§4。
- ④（去掉界面调用，页面只读）：§5 第 7 条、§8。
- ⑤（只读 class 为 kbcontent 的 div）：§7、§11 第 6 条。
- ⑥（页面地址只交协议、主机、路径；`screenTermMissing`）：§4、§11 第 7、11 条。

parse.js 文件头：

- ①（单双周不丢）：§8 的 `split('(')` 一行。
- ②（括号内纯数字是序号）：§6 第 2 条。
- ③（按网格列号对齐）：§6 第 3 条、§4。
- ④（节次逗号写法、两位连堂、上限）：§8 的节次与上限两行。
- ⑤（不照搬合并）：§8 的 `mergeAndDistinctCourses` 一行。
- ⑥（丢弃的块计数并点名）：§8 的块跳过一行。
- ⑦（teacher、location 留空）：§6 第 8 条。
- ⑧（统一 11 节作息）：§7、§8。
- ⑨（学期取下拉框选中项）：§8 第一行、§11 第 11 条。
- ⑩（学期名：教务名称、代码拼名、占位出提醒）：§6 第 7 条、§11 第 12 条。
- ⑪（没有网格列号的格子跳过并计数；课表页没有下拉框时出提醒）：§6 第 3 条、§11 第 5、11 条。

## 13. 签名

0x7E7-2023（haiku 移植，2026-10-08）
