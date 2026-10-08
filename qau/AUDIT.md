# 安全审计：`qau`（青岛农业大学）

- **适配器**：`jw-adapters/qau/`（`manifest.json` / `extract.js` / `parse.js` / `fixtures/`）
- **移植者**：`0x7E7-2023`
- **移植日期**：2026-10-08
- **审计对象**：上游 `resources/QAU/qau_01.js`（14015 字节，340 行）全文 + 本适配器 `extract.js` / `parse.js` 全文
- **结论**：**通过（有未决项，见 §5）**。只请求本校教务服务器上的一个课表接口（同源 GET，相对路径），不碰凭据、不写页面、不 POST、不埋点、不外发、不读课表以外的数据。

---

## 1. 上游出处

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/XingHeYuZhuan/shiguang_warehouse`（MIT） |
| 文件 | `resources/QAU/qau_01.js`（14015 字节，340 行） |
| 同目录 `adapters.yaml` | `adapter_id: QAU_01`／`adapter_name: 青岛农业大学综合教务管理系统（强智科技）`／`maintainer: ReGoMark`／`import_url: http://jwglxt.qau.edu.cn/`／`category: BACHELOR_AND_ASSOCIATE` |
| 快照 commit | `ff72d1f08782df965cae110034a9d87cd91e0c07`（extract.js 文件头记录） |
| 上游作者 | ReGoMark |

本适配器是该快照的移植，不追上游后续更新。

## 2. 平台与取数方式（按脚本实际请求的路径判，不按上游注释）

- 强智课表页返回服务端渲染的 HTML，所以是 DOM 抓取，不走 JSON 接口。
- **唯一的网络请求**：`extract.js` 234–236 行 `fetch(KB_PATH, { method: 'GET', credentials: 'same-origin' })`，`KB_PATH = '/jsxsd/xskb/xskb_list.do'`。同源相对路径，主机名只在 `manifest.json` 的 `allowHosts` 里出现。
- 上游的 POST（重选学期后再 `fetch(..., { method: 'POST' })`，上游 282–285 行）已删，见 §3。
- 返回的 HTML 经 `DOMParser`（`extract.js` 229 行）解析。DOMParser 产生的文档不执行脚本、不加载资源；此后只读其中的 `#kbtable`、`.kbcontent`、学期 `select`。
- 不读 `document.*`（extract.js 里没有）；`window` 只读 `location.pathname` 一处（见 §3.1 ⑤）。不读 cookie、localStorage、sessionStorage。
- `parse.js` 不碰页面，是对 `__ncInput` 的纯函数，没有任何网络或 DOM 调用。

## 3. 改动清单（相对上游）

### 3.1 extract.js

| 编号 | 上游做法 | 移植做法 | 理由 |
|---|---|---|---|
| ① | 弹学期下拉，再 POST 一次（上游 244–285 行） | 只读课表页自带学期 `select` 的选中项（value 与文字），不发 POST | 不写页面，不发第二个请求 |
| ② | 无校区 | `askCampus()` 用 `__ncSelect` 问一次（青岛 / 平度 / 蓝谷，默认第 0 项） | 三校区作息不同；问不到或取消为 null，parse.js 回落青岛并出声 |
| ③ | 直接生成课程 | 只交原始结构：`term`、`cols`、`rows`（格子带 col / span / text / 原始 HTML）、`campus` | 解释全在 parse.js，CI 的 Rhino 里能真跑 |
| ④ | showToast / showAlert / 保存 / 通知 | 全部删除 | 保存是空课自己的事，脚本对页面只读 |
| ⑤ | `pageUrl` 取 `location.href` | 只取 `location.pathname` | 查询串里可能有学号（本轮审计改动，待 team-lead 确认） |

### 3.2 parse.js（①–⑫ 逐条理由见文件头，此处列要点）

- ① 星期按网格列号对齐（extract 每格带 col / span）。上游用 td 下标当星期，首列「节次」rowspan 跨行时整行错一天。
- ② 周次保留单双：「1-16周(单)」「(双)2-16周」「1-16(单周)」。上游 `parseWeeks` 先删掉全部括号内容，单双信息全丢，结果变成每周都上。
- ③ 括号内纯数字或数字区间（`(1)`、`(1-2)`）是教学班序号，不当周次。
- ④ 节次上限 `MAX_PERIOD = 16`：越界块点名进 warnings，不补出非法时刻。
- ⑤ 上游静默丢弃的块（无课名 / 无周次 / 无节次）全部计数并点名。
- ⑥ 去重键加上教师与教室。上游键（142–146 行）只有星期、节次、课名、周次。
- ⑦ 校区来自 `data.campus`；缺失或不在三校区内，回落青岛校区并 warning。
- ⑧ 上游的「未知 / 待定 / 未知教师 / 未知地点」一律不抄，写成 null；「任课教师:」等标签前缀去掉（`TEACHER_PREFIX`）。
- ⑨ 总周数上游不给：默认 20 周，课表里有更靠后的周就抬到那一周（上限 30），并 warning。
- ⑩ 开学日上游不给：按提取当天所在周的周一推算（`mondayOf`），并 warning。学期名取下拉框文字；没有则由学期号推成「2026-2027学年第一学期」；再没有用「青岛农业大学学年学期」占位并 warning。
- ⑪ 有课的格子落在不对应星期的列上（如第 9 列）：原先静默跳过（`if (d < 1) continue`），现计数并点名进 warnings（§3.4 P4），不静默丢课。
- ⑫ 节次以格子为准：格内方括号写的节次优先，格内没写才用行表头「第N,M节」；两者都有又对不上，计数并点名（§3.4 P5）。上游只看行表头。

### 3.3 合并规则与一处前提

- 保留上游条件：同天、同课名、同教师、同教室、同周次，`prev.endSection + 1 === cur.startSection`，且 `(cur.endSection - prev.startSection) <= 3`（跨度不超过 4 节）。上游 163–173 行；parse.js 710 行。
- **前提（未决，见 §5）**：上游先按节次排序再合并（上游 151 行 `uniqueCourses.sort`）。移植没有排序，靠同组内的 DOM 顺序就是节次升序。课表的节次行本身是升序，正常页面等价。若 rowspan 错位打乱了顺序，只可能漏合并；合并出来的节次仍是两段的并集，不会合成错误的范围。

### 3.4 缺陷修复记录（审计中找到，已修）

- **P1 `weekFieldOf` 截断**。任务卡写的是「取 (周) 之前」，那样 `1-3(周) 5-9(周)` 只剩 1-3，5-9 周静默丢失。改为整段保留，由 `weeksIn()` 去掉 (周) 与方括号。这是对任务卡字面规则的有意偏离，理由是「不许静默丢」。见 `weeks-space-segments` 与 M4。
- **P2 只读第一个「周次」字段**。同一块有多个周次 font 时只取第一个。改为周次取并集，节次取第一个方括号。见 `multi-spec` 双字段用例与 M5。
- **P3 「任课教师:」前缀未去**。改用模板件同款 `TEACHER_PREFIX`。见 `weeks-space-segments` 与 M6。
- **P4 有课格子对不上星期几（B5）**。原先 `if (d < 1) continue;` 静默跳过。现改为计数并点名：`noteUnmappedCell`（parse.js 561 行），在 665–668 行调用。计数按格子，不按课程；样本取该格第一个认出的课名，认不出课名就只计数。提醒原文（868–870 行）：「有 N 处有课的格子对不上星期几，这些课没有导入（例：「X」），请核对导入结果」，无样本时省略「（例：…）」。见 `unmapped-col` 与 M8。
- **P5 格内节次与行表头对不上（B8）**。原先行表头优先，格内节次只在行表头缺失时才用。现改为格内方括号节次优先，格内没写才用行表头「第N,M节」。两者都有且不一致时以格内为准，计数并点名（parse.js 629 行计数，841–843 行提醒）。提醒原文：「有 N 处课程的节次和所在行的节次对不上，已按格子里写的节次导入（例：「X」），请核对导入结果」。见 `period-conflict` 与 M9。

### 3.5 与模板件的差异（标识符对比，去掉 CR 行尾后）

- parse.js：模板件独有 `specsOf`、`splitSpec`，以及它自己的三张作息表常量（模板件专用，本校不用）；qau 独有 `groupKeyOf`、`isPlaceholder`、`noteUnmappedCell`、`readBlock`、`rowSectionOf`、`sectionOf`、`weekFieldOf`，以及 `CAMPUS_NAMES`、`CAMPUS_PERIODS`、`DEFAULT_CAMPUS`、`PLACEHOLDERS`、`WEEK_TITLE`。
- extract.js：模板件独有 `readTerm`、`requestHtml`、`termFromHidden`；qau 独有 `askCampus`、`CAMPUSES`、`requestTimetable`。
- 行数：parse.js 模板件 859 / qau 891；extract.js 模板件 286 / qau 261。
- diff 命中的 hunk：parse.js 23 处，extract.js 6 处。这两个数字是改动前（B5、B8 之前）的结果，本轮未重算；比对输出是临时文件，不入库。
- fixtures：模板件 6 对，qau 12 对（§6）。

## 4. 字段映射

| 输出字段 | 来源 | 缺失时 |
|---|---|---|
| `terms[].name` | 学期下拉选中项的文字（extract ①） | 由学期号推成「2026-2027学年第一学期」；再没有用「青岛农业大学学年学期」占位，并 warning |
| `terms[].firstDay` | 教务不给，按提取日所在周的周一推算 | 每次都 warning（§3.2 ⑩） |
| `terms[].totalWeeks` | 教务不给，默认 20；课表里有更晚的周则抬到那一周（上限 30） | 默认 20，并 warning |
| `terms[].periodTimes` | `CAMPUS_PERIODS[校区]`，三张 11 节作息表 | 校区不明回落青岛，并 warning |
| `courses[].name` | 格内第一段非空文字 | 课名读不出的块跳过并计数，warning |
| `courses[].teacher` | `font[title=老师]`，去标签前缀；占位词不抄 | null |
| `courses[].note` | 本适配器不填 | 恒为 null |
| `courses[].blocks[].location` | `font[title=教室]` | null |
| `blocks[].dayOfWeek` | 网格列号映射（列 1 为周一）；无表头时按表宽推算 | 推算时 warning；对不上星期的有课格子计数并点名，不静默丢（§3.2 ⑪，§3.4 P4） |
| `blocks[].startPeriod` / `endPeriod` | 格内方括号节次优先；格内没写用行表头「第N,M节」；两者不一致以格内为准并 warning（§3.4 P5）；夹在 1–16 节内 | 越界块跳过，warning |
| `blocks[].startWeek` / `endWeek` / `weekType` | 周次字段（§3.2 ②③）；周次超过 30 的丢弃并 warning | 无周次的块跳过，warning |

## 5. 安全红线与未决项

### 5.1 红线逐条（grep 证据）

| 红线 | 结果 | 证据 |
|---|---|---|
| 不读凭据 | 通过 | 两个脚本里没有 password / passwd 字样 |
| 不 POST | 通过 | 代码里唯一的 fetch 是 GET（extract.js 234–236 行）；「POST」只出现在说明删除的注释里 |
| 不写 DOM | 通过 | extract.js 里没有 `document.`；innerHTML 只读，读的是 DOMParser 产出的文档 |
| 不 eval、不动态执行 | 通过 | 没有 eval、Function 构造器、import()、require() |
| 不外发、不埋点 | 通过 | 没有 XMLHttpRequest、sendBeacon、postMessage；无统计、无第三方脚本 |
| 不跟踪 | 通过 | `credentials: 'same-origin'` 让浏览器带上本站登录 Cookie，脚本本身读不到 Cookie |
| 不碰存储 | 通过 | 没有 localStorage、sessionStorage、cookie 访问 |
| allowHosts 无通配、无第三方 | 通过 | `["jwglxt.qau.edu.cn"]` 只有一项；代码里的 https 链接只在文件头注释 |
| pageUrl 不带查询串 | 通过（本轮改动） | extract.js `pageUrl: String(window.location.pathname)` |

### 5.2 未决项（需 team-lead 或真机确认）

1. 选择器没在青岛教务的真页面上核对。`#kbtable`、`div.kbcontent`、`font[title=…]`、「第N,M节」表头、学期 select（id 或 name 含 xnxq）都取自上游与模板件的同类页面。
2. 所有 fixture 是合成数据（与模板件相同）。
3. pageUrl 改为 pathname（§3.1 ⑤）是本轮新增的改动，需要 team-lead 确认。
4. 合并依赖组内 DOM 顺序（§3.3）。
5. P1 偏离任务卡的字面规则（§3.4）。
6. 无星期表头时按表宽推算（no-header），仍可能整体错位，已 warning。
7. 节次以格内方括号为准，行表头只在格内没写时才用（§3.2 ⑫）。没有「第N,M节」的行只能靠方括号节次读；两者都没有则跳过并计数。
8. 20 条 warning 上限（`MAX_WARNINGS`）没有 fixture 覆盖；200 字截断由 dirty-limits 覆盖。
9. 校区回落：桥不可用、用户取消、返回值不在三校区内，都回落青岛并 warning。
10. `CAMPUS_PERIODS` 与上游 `CAMPUS_TIME_SLOTS` 逐 token 一致（已比对），但数值来自上游，未对照三校区的实际作息。
11. 格内节次与行表头不一致（§3.4 P5）在真实页面上出现的频率未知。若青岛教务的格内写法和行表头常常不同，每份课表都会出现「节次对不上」的提醒，需要真机核对后决定保留提醒还是改为静默。格内优先这条规则本身也未在真页面上验证。

## 6. fixtures（12 对，`*.extracted.json` + `*.expected.json`）

| # | fixture | 覆盖 | 课程 / 块 | warnings |
|---|---|---|---|---|
| 1 | basic | 青岛校区；同课相邻节合并（高数 1-4）；单双周；一格多门（`-----` 分隔）；同格同课去重；教师缺失为 null | 8 / 8 | 3 |
| 2 | week-forms | 「1-16周(单)」「(双)2-16周」「1-16(单周)」；「1-3,5-9周」；`(1)`、`(1-2)` 教学班序号；空格分段 | 7 / 8 | 3 |
| 3 | no-header | 无星期表头，按网格列号；colspan=2 的体育；rowspan 错位的行（数据库） | 6 / 6 | 6 |
| 4 | dirty-limits | 第17,18节越界；`[12345678节]` 越界；1-40(周) 丢 10 条并抬总周数到 30；名称 220 字；warning 截到 200 字；第一二节表头读不出，靠方括号节次 | 3 / 3 | 7 |
| 5 | multi-spec | 1-8周 10-16周 同字段两块；五种异体与全角区间分隔符；全角括号 `[05～06节]`；双周次 font 取并集 | 8 / 10 | 4 |
| 6 | weeks-space-segments | 「1-3(周) 5-9(周)」拆成两块（P1）；「任课教师:」去前缀（P3） | 6 / 7 | 3 |
| 7 | campus-fallback | campus 为 null，回落青岛并 warning | 1 / 1 | 3 |
| 8 | campus-pingdu | 平度作息表，与青岛不同（本校专属边界） | 2 / 2 | 3 |
| 9 | merge-span | 跨度上限：高数 1-4 合并，5-6 另起；不连续的两段不合并 | 3 / 5 | 3 |
| 10 | no-term | 学期下拉与学期号都缺，学期名占位并 warning | 1 / 1 | 4 |
| 11 | unmapped-col | 有课的格子落在第 9 列（不对应星期）：计数并点名，不静默丢课（B5）；第 1 列的高数照常导入 | 1 / 1 | 4 |
| 12 | period-conflict | 行表头「第1,2节」，格内写 `[03-04节]`：以格内为准得 3–4 节，并提醒（B8） | 1 / 1 | 4 |

## 7. 变异测试（在临时副本上改，原文件不动）

| 编号 | 位置 | 改动 | 变红的 fixture | FAIL |
|---|---|---|---|---|
| M1 | 56 行 | 平度第 1 节改成 08:00–08:45 | campus-pingdu | 1 |
| M2 | 272 行 `sectionOf` | `end = nums[0]`，区间收成起点 | 既有 10 对 + unmapped-col；period-conflict 不变 | 11 |
| M3 | 281–282 行 `pushWeek` | 去掉单双过滤 | basic、week-forms、weeks-space-segments | 3 |
| M4 | 258 行 `weekFieldOf` 返回值 | 截到「(周)」之前（任务卡字面规则） | weeks-space-segments | 1 |
| M5 | `readBlock` 周次循环，605 行后加 `break` | 只取第一个周次 font | multi-spec | 1 |
| M6 | 239 行 `teacherOf` | 去掉 `TEACHER_PREFIX` 的剥离 | weeks-space-segments（teacher 实际为「任课教师:」） | 1 |
| M7 | 710 行 | 合并跨度上限 3 改为 9 | merge-span | 1 |
| M8 | 665–668 行 | 把 `if (d < 1)` 块换成 `if (d < 1) continue;` | unmapped-col（warnings 3 vs 4） | 1 |
| M9 | 616 行 | 改回行表头优先的写法（`rowSection || cellPeriods`） | period-conflict（startPeriod 1 vs 3；endPeriod 2 vs 4） | 1 |
| M10 | 810 行 | 校区文案改回改动前的版本 | campus-fallback | 1 |

M2 的 11 处 DIFF：既有 10 对全部变红，unmapped-col 也变红，period-conflict 仍 MATCH。unmapped-col 多出的那条 DIFF 原因按代码路径推断，未逐条核对输出：`sectionOf` 把区间收成一个节次后，格内写法与表头对不上，会触发 P5 的提醒。

改动前的 parse.js 基线：sha256 `24ae99ee6e3eb612692831b958fd51d6aab29623cea0893ec902907e4ee0cfaf`，855 行。当前 parse.js：sha256 `987caad24263dd828cd30fea17a2bc0bb6d3582b11bc26358bf8ac0df7fc2dad`，891 行。extract.js 与基线相同（261 行）；收尾时主调度只改了第 242 行 HTTP 非 2xx 报错的文字（「教务系统返回 HTTP N」→「教务系统返回错误（代码 N）」，与本批其它件一致），当前 extract.js sha256 `d49fac0a7535d8c97e88f78f8adf5cbf4c1c8133d73e433b4f5ec4acef1f83b3`。M1–M10 都只在临时副本上做，每个副本只改一处；上表第 5 列是 check.js 的 FAIL 数。

---

0x7E7-2023（haiku 移植，2026-10-08）
