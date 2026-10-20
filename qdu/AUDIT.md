# 青岛大学（qdu）移植审计

本文件记录移植件的来源、模板选择与不同构之处、请求与读写面、手册 §5 八条结论、与模板件的差异、上游删掉或改掉的东西、变异测试与未验证项。
每一条声明都对应当前代码；代码里的位置按函数名引用（不写行号，改代码后不会漂移）。没有真实账号，没有核对过的地方写在 §12。

## 1. 来源（provenance）

- 上游仓库：https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT）
- 上游文件：`resources/QDU/qdu_01.js`，上游作者（adapters.yaml 的 maintainer）JellyfisHawthorn。快照提交 `19a65bf`（2026-10-19 拉取，2026-10-20 复核仍是最新），
  本校目录最后一次修改的提交 `025dc78`（`git log -1 --format=%h -- resources/QDU/` 核对一致）。
- 上游同目录 `adapters.yaml`：adapter_id `QDU_01`，adapter_name「青岛大学强智教务」，import_url `https://xjw.qdu.edu.cn/`，
  description「青岛大学强智教务，由本校开发者适配。T1、T2时段的名称需要自行设置且课程需要自行导入。T1、T2时段的时间仅供参考，请以实际为准。」
- 平台：强智 jsxsd 学生端（`/jsxsd/`）。判据是上游脚本实际请求的路径（`/jsxsd/jxzl/jxzl_query`、`/jsxsd/xskb/xskb_list.do`），不是注释。
- 移植者：0x7E7-2023（sonnet 移植，2026-10-20）。

## 2. 模板选择与不同构之处

**模板：`yssdufe`。** 理由：`.test/port-batch8/survey10-out.txt` 里它与本校上游相似度最高（0.695，其次 xjie 0.650）；
更重要的是请求完全同构：教学周历 GET + POST、课表 POST，请求体与 `yssdufe` 上游几乎逐字一致，课表格子同样是 `div.kbcontent` + `font[title]`。
`yssdufe` 的周次解析较旧，没有照搬：周次改用批次十已审计的 `swu` 写法（见 §7）。

本校与模板不同构的地方（其余结构照模板）：

1. **节次按行定，而且有 T1 / T2。** 上游 `parseTimetableToModel()` 不读方括号里的节次，按「第几个含 td 的行」算：
   行 0..5 → 1-2、3-4、6-7、8-9、11-12、13（最后一行 1 节）。这个公式跳过了第 5 节和第 10 节：
   青岛大学自己的节次是 1-11，外加 T1（午间）、T2（傍晚）两个夹档；拾光 / 空课的节次表把 T1 放第 5 节、T2 放第 10 节，
   所以教务的第 5-8 节 = 第 6-9 节，教务的第 9-11 节 = 第 11-13 节（`slotOfQdu`、`ROW_SLOTS`）。上游说明「T1、T2 需要自行设置且课程需要自行导入」，
   即课表表格里没有这两档的课，上游也不替它们导课；T1、T2 的时间上游自己标明「仅供参考」。
   移植件：节次表照上游放 13 节（T1 = 第 5 节、T2 = 第 10 节），提醒里说明序号对应关系、T1 / T2 的课没有导入、这两档时间仅供参考。
2. **作息按日期分两套。** 第 1-4 节全年一样；第 5-13 节夏季（5 月 1 日至 9 月 30 日）与冬季（10 月 1 日至次年 4 月 30 日）各一套，冬季整体早 30 分钟。
   上游用「组合作息方案」按日期自动换。空课的载荷一个学期只有一张节次表，而秋季学期（9 月开学）、春季学期（3 月开学）几乎一定跨季。
   做法（先例 `xawl` / `ujs`）：逐周看周一落在哪个季节，多数周在哪季放哪一套（各一半时取第 1 周所在的季节），
   另一季涉及的周次与差 30 分钟写进 warnings（`otherWeeks`）。整学期同季（暑期小学期）不出这条。不弹窗问，因为日期就能判断。
3. **三个执行计划请求删掉。** 上游为了给课程填学分，每次多发 `pyfa_query`、`fxpyfa_query`、`wzypyfa_query` 三个请求（培养方案页）。
   载荷没有学分字段（`credit` 在主工程里没有任何出现），培养方案也不是课表 → 全部删掉（§8）。
4. **周次解析重写。** 上游 `parseWeeks()` 是 `weekStr.split('(')[0]`，丢单双标记（§8）。
5. **课表容器 id。** 上游课表页读 `#timetable`、周历页读 `#kbtable`（模板件两处都是 `#kbtable`）。`findScheduleTable` 先认 `timetable`，再认 `kbtable`，再退到最近的含 `.kbcontent` 的表。
6. **登录页 / 门户页不发请求**（模板件没有；上游也没有）：`loginHint`。
7. **提取时给每格带行序号 `seq`**（只数含 td 的行，与上游的 `filter(r => r.querySelector('td'))` 一致），因为节次要靠行。

## 3. 请求表

extract.js 里有两处 `fetch(` 字面量（`requestText` 与 `fetchTerm`），运行时最多发出下面三个请求。路径都是页面同源的相对路径，`credentials: 'same-origin'`。

| # | 方法 | 路径 | 请求体 | 何时发 | 作用 | 取不到时 | 上游对应 |
|---|---|---|---|---|---|---|---|
| R1 | GET | `/jsxsd/jxzl/jxzl_query` | 无 | 每次提取 | 读教学周历页上 `xnxq01id` 下拉框的选中学期 | 学期退回当前页面自己的下拉框；两处都没有且页面上没课表格子 → 报错「找不到学年学期」 | `requestSemesterPage()` / `fetchSemesterList()`（上游列出前后各 3 个学期让用户选，这里只取选中项） |
| R2 | POST | `/jsxsd/jxzl/jxzl_query` | `xnxq01id=<学期代码>` | 拿到学期代码时 | 开学日期（`td[title]`）与周号 | 不致命：开学日按提取日所在周的周一推算、总周数按 20 周计，各出一条提醒 | `requestSemesterDetailPage()`，请求体一致 |
| R3 | POST | `/jsxsd/xskb/xskb_list.do` | `jx0404id=&cj0701id=&zc=&demo=&xnxq01id=<学期代码>` | 仅当当前页面没有课表格子 | 课表 | 课表为空 → 报错「教务返回的课表是空的」；状态码非 2xx → 「教务系统返回错误（代码 N）」 | `requestCoursePage()`，请求体一致 |

登录页、认证中心、门户页上点提取：`loginHint` 直接报错，**一个请求都不发**（浏览器冒烟 `login-root` / `login-index` / `login-post` / `cas` / `portal` 五个场景确认）。

请求体里只有学期代码（来自页面下拉框）和上游原样保留的空查询参数；不带学号、姓名、令牌，也不读任何本地存储。
上游共 6 处 `fetch(`，本件保留 3 处，删掉的 3 处见 §8。

## 4. allowHosts

- `["xjw.qdu.edu.cn"]`，一个精确主机名，**没有通配**。`loginUrl` 与 `scheduleUrlHint` 同主机。
- 上游静态扫描（手册 §5 的两条命令）：URL 主机只有 `https://xjw.qdu.edu.cn`；`fetch(` 六处全部使用 `URL_SEMESTER` / `URL_COURSE` / `URL_PLAN` / `URL_FXPLAN` / `URL_WZYPLAN` 常量，指向同一主机；
  没有 `XMLHttpRequest`、`sendBeacon`、`new WebSocket`、`.src =`。
- 本件脚本里没有写死主机名的请求；`loginHint` 里的 `JW_HOST` 只用于判断「当前页面是不是本校教务」。

## 5. 读取面与输出面

读取，只读，不写页面：

- **活页（`document`）**
  - 课表表格：`#timetable`，找不到则 `#kbtable`，再找不到取第一张包含 `.kbcontent` 的表。逐格读 `colspan` / `rowspan`、所在行序号 `seq`，
    以及 class 精确为 `kbcontent` 的 `div` 的 `innerHTML`（`parts`）。**有课程明细的格子不交文字**（避免重复一份），没有明细的格子（星期表头、节次标签）交文字。
  - 学年学期：`id` 或 `name` 含 `xnxq` 的 `select`，读选项值（形如 `2026-2027-1`）与选中项的文字。没有选中项时取第一个合规选项。
  - 页面地址：只取协议、主机与路径，写入 `pageUrl`（parse.js 不使用）。查询串不交，它可能带学号。
  - 本地日期 `now`，只在拿不到开学日时用于推算。
- **R1 返回的教学周历页**：只读学期下拉框，规则同上。
- **R2 返回的教学周历**：`#kbtable`；找不到则取第一张 `td[title]` 为「YYYY年MM月DD日」的表（「日」字可有可无）。只交有文字或有 title 的格子，并保留网格列号。
- **R3 返回的课表页**：课表规则同活页。解析用 `DOMParser` 的离线文档，不挂到页面上。
- 不读 `<input>` 的值、不读 `<form>`、不读页面上姓名 / 学号 / 头像等区域；`loginHint` 只读 `window.location`。

交出去（extract.js → parse.js，逐字段）：`source`（固定字符串）、`pageUrl`、`now`、`term{code,name}`、`screenTermMissing`、`cols`（表宽）、
`calendar{found, rows[{col, text?, title?}]}`、`rows[[{col, span, seq, text, parts[]}]]`。个人信息（学号、姓名、证件、手机）不在其中。

parse.js 的输出：`specVersion 1`、`kind schedule`、`ocrAssisted false`、`warnings`（≤20 条、每条 ≤200 字）、`terms`（一个学期：`name`、`firstDay`、`totalWeeks`、`periodTimes`、`courses`）。
脚本不写页面、不写存储、不向本校以外的地址发送任何东西。

## 6. 手册 §5 安全审计八条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | 两个文件不读 password、pwd、令牌、localStorage、sessionStorage、cookie（grep 无命中；parse.js 里的 `pieces` / `piece` 是周次字符串的切片变量名）。请求只声明 `credentials: 'same-origin'`，会话由浏览器附带，脚本读不到也不转发。 |
| 2 | 不外发 | 通过 | `fetch(` 两处字面量，都是同源相对路径；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。 |
| 3 | 请求域可控 | 通过 | `allowHosts` 只有 `xjw.qdu.edu.cn`，没有通配。 |
| 4 | 只读课表 | 通过 | 三个请求都是学生端的教学周历与课表（R1 至 R3）；上游多发的三个培养方案请求已删，不请求成绩、学籍、缴费或个人信息页面。 |
| 5 | 不埋点 | 通过 | 没有统计、上报或遥测代码。 |
| 6 | 不 eval 远程代码 | 通过 | 两个文件都没有 `eval` 与 `new Function`；check.js 的词法扫描为 PASS。 |
| 7 | 不写页面 | 通过 | extract 只读活页，解析用 `DOMParser` 离线文档；没有 innerHTML 赋值、appendChild 或表单提交。上游的 `showAlert` / `showToast` / `notifyTaskCompletion` / `saveCourseConfig` / `savePresetTimeSlots` / `saveComboSchedule` / `saveImportedCourses` 等界面与保存调用全部不搬。 |
| 8 | 不依赖秘密 | 通过 | 没有硬编码的密钥、令牌或学号；学期代码来自页面。 |

## 7. 与模板件（yssdufe）的差异

extract.js：

- 课表容器 `#timetable`（模板 `#kbtable`）；每格新增 `seq`；有明细的格子文字置空。
- 新增 `loginHint`（登录页 / 非教务主机不发请求）与 `JW_HOST`。
- 文案：状态码写成「教务系统返回错误（代码 N）」「教务系统拒绝访问（代码 N）」。

parse.js：

- **节次**：模板只读方括号；本件 `resolvePeriods` 以「所在行」为锚，方括号里的教务节次经 `slotOfQdu` 换算后：起点落在该行范围内就用方括号的（能读全三节连堂：`[05-07节]` → 6-8），
  对不上或读不成节次以所在行为准并计数出声（`periodMismatch`）；表里多出来的行（没有行位置）只靠方括号，读不成就跳过并点名。
- **作息**：模板一张统一 11 节表；本件夏 / 冬两套 + 按学期周次选季节 + 另一季提醒（§2 第 2 条）；占位节次从 14 节起，公式 `pad2(8 + n)`，上限 `MAX_PERIOD` = 15 节（模板 11 节、上限 16）。
- **周次**：`weeksIn` 换成 `swu` 的写法（单双前后缀归属、剥「共 N 周」、`第1-第8周`、括号备注 / 教学班序号、全角），保留模板的「认不出单双 / 隔周 → 每周都上并出声」。
- **块级合并**：`addBlock` 把同一门课、同一天、同样周次与教室、节次相接或重叠的块并成一块（模板只去完全重复的块）。
- **提醒**：新增 T1 / T2 说明、换季说明、节次对不上、周次备注、缺教师、缺教室汇总；带课名的提醒（点名跳过的块、缺教师 / 缺教室）课名截 20 字（`MAX_NAME_IN_WARNING`）。
- **学期名**：下拉框的文字若本身就是学期代码，改拼成「2026-2027学年第一学期」（模板直接用该文字）。
- 提醒文案里的「作息」一律叫「节次时间」。

## 8. 上游里被删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `fetchAllCourseCredits()` 与 `requestPlanPage` / `requestFxFPlanPage` / `requestWZYPlanPage`（`/jsxsd/pyfa/pyfa_query`、`fxpyfa_query`、`wzypyfa_query`）、`fetchCourseCredit()`、课程 `credit` 字段 | 删 | 载荷没有学分字段；培养方案 / 辅修 / 微专业执行计划不是课表（手册 §5 第 4 条只读课表）。上游自己也承认部分限选、任选课的学分拿不到。 |
| `fetchSemesterList()` + `showSingleSelection`：列出选中项前后各 3 个学期让用户选 | 删；取教学周历页（或课表页）下拉框的选中项 | 页面上选中的学期就是用户正在看的学期，不必再选一次。 |
| `parseWeeks()`：`weekStr.split('(')[0]`，`1-15(单周)` 被读成每周都上；`new Set` 去重 | 重写为 `weeksIn` | 丢单双标记。 |
| `mergeAndDistinctCourses()`：按名字排序后合并相邻节次与同节次的周次 | 只搬块级合并（`addBlock`），不做整体重排，不合并周次 | 整体重排会改写原始块的次序与周次边界，无法对照页面核对；块级合并足以覆盖上游的目的（相邻两行的同一门连堂课合成一块）。 |
| `teacher || "未知教师"`、`position || "未知地点"` | 空则 null，按类型汇总进提醒 | 「未知」会被当成真名显示。 |
| 课程名：第一个「元素节点」里有文字的 `textContent`（只看元素，不看裸文本） | 第一个 `<font>` 之前的第一个非空文本行（元素里的、裸文本都读）；其次无 title 的 `<font>`；再其次标了课程名的 `<font>` | 见 §12 第 3 条（页面结构未验证）。 |
| 没认出课名的块 `if (name)` 静默跳过 | 计数并点名（最多 5 个）进 warnings | 不许静默丢课。 |
| `semesterTotalWeeks = Math.min(totalWeeks, 20)`（上游注释「最大限制为 20」） | 有周历就取周历的周数（课表有更晚的周次才抬高，上限 30 并出声）；没有周历才按 20 周计 | 20 周封顶会让第 21 周起的课超出 totalWeeks，载荷校验拒收；载荷上限是 30。 |
| `semesterStartDate` 取第一行第一个 `td[title]`（可能是星期日） | 先按周历表头认「星期一」格，认不出才取第一个带日期的格子并对齐到周一 | 手册 §4.3：整学期会差一周。 |
| 周历 `title` 正则 `^(\d{4})年(\d{2})月(\d{2})$`（不带「日」） | 「日」字可有可无 | 与上游同口径又更宽。 |
| `saveAppTimeSlots()` 的基础时间段 + 组合作息方案（5-9 月夏季、10 月至次年 4 月冬季，按日期自动换） | 夏 / 冬两张表写在 parse.js 里，按学期周次选一张，另一季写提醒 | 载荷一个学期只有一张节次表（§2 第 2 条）。 |
| `showAlert` / `showToast` / `notifyTaskCompletion` / `saveCourseConfig` / `savePresetTimeSlots` / `saveComboSchedule` / `saveImportedCourses` | 删 | 提示与流程由宿主负责；适配器只读，不驱动界面。 |
| 分隔线：两个字面量（21 个和 22 个连字符） | 5 个以上连字符（含全角）都切开 | 放宽；模板同。 |

## 9. fixtures（9 对，全部合成数据）

用 `D:/NullClass/.test/port-batch12/qdu/gen_fixtures.py` 生成。**期望值是在脚本里手工写出的**（节次时间照上游逐节抄，周次、节次、季节、提醒文字按本文规则手推），不是 parse.js 的输出；
生成后第一次跑自检 9 对全部一次通过，说明手推结果与代码一致。

| 用例 | 课程 | warnings | 覆盖的内容 |
|---|---|---|---|
| basic | 9 | 4 | 6 行 → 空课第 1-2、3-4、6-7、8-9、11-12、13 节；ALL / ODD / EVEN；多段周次；一格两门课；无教师无教室；冬季为主的秋季学期（前 4 周夏季） |
| week-forms | 13 | 4 | `(单)1-8周,(双)9-16周`、`1-8周(单)9-16周`（后缀紧挨下一段）、`第1-第8周`、`1-8周(共8周),9-16周`（只剥备注）、`1-16周 双`、`(1)` 序号、`第3周`、隔周 / `(单双)` 认不出出声、`(3组)` 备注出声、空白分段、全角数字与括号、全角波浪（周次与节次）。钉「单/双标记归属」与「共 N 周」剥离 |
| period-map | 8 | 4 | 本校专属：`[05-07节]` → 6-8、`[06节]` → 7、`[09-11节]` → 11-13、`[11节]` → 13；相邻两行各写一半合并；方括号与所在行对不上以行为准并出声；多出来的第 7 行靠方括号；缺节次跳过点名；下拉框文字就是学期代码；春季学期冬季为主 |
| season-summer | 2 | 2 | 本校专属：夏季为主的春季学期（放夏季节次时间，提醒第 1-8 周属于冬季、实际早 30 分钟） |
| season-single | 2 | 1 | 整学期都在夏季的暑期小学期：不出换季提醒；学期名代码改拼成「第三学期」 |
| long-names | 4 | 5 | 长课名（30 字）的缺教师 / 缺教室汇总（点名前 3 门，每个课名截 20 字，加「等」）；6 个长课名的块没有周次，点名前 5 个，整条超过 200 字被截成 199 字 + 省略号 |
| no-calendar | 1 | 5 | 周历取不到：开学日按提取日所在周的周一推算、总周数按 20 周计；课表页没有下拉框；学期名是代码 |
| no-header | 2 | 5 | 无星期表头（取最后 7 列推断，出声）；跨列的格子同时放进两天；缺列号的格子跳过并计数 |
| extras | 2 | 6 | 节次 14-15（`[12-13节]`）补占位；节次 16-17 超过 15 节上限跳过点名；没课名跳过点名；周次 29-32 超出 30 周丢掉；总周数抬高到 30 |

## 10. 变异测试

每次把整件复制到临时目录，在副本上改一处，运行 check.js（M12 改的是 extract.js，用浏览器冒烟检验），记下变红的用例；真实目录没有被改动，最终自检为 `RESULT: PASS`。脚本：`D:/NullClass/.test/port-batch12/qdu/mutate.py`。

| 编号 | 改坏的位置 | 效果 | 变红的用例 |
|---|---|---|---|
| M1 | `slotOfQdu`：`if (n <= 8) return n + 1;` → `return n;` | 教务第 5-8 节不往后挪一格 | 4：basic、period-map、season-summer、no-header |
| M2 | 季节选择：`else useSummer = summerWeeks.length > winterWeeks.length;` → `= true` | 永远放夏季表 | 7：basic、week-forms、period-map、long-names、no-calendar、no-header、extras（season-summer 本来就是夏季，不变） |
| M3 | `weeksIn` 前缀单双判断：`if (/[0-9周]\s*$/.test(...)) return all;` → `if (false) return all;` | 后缀的「(单)」被后面的数字抢去当前缀，单双标记归属错 | 1：week-forms |
| M4 | 「共 N 周」：`replace(/共\s*[0-9]+\s*周?/g, '')` → `replace(/共.*$/, '')` | 从「共」一路删到行尾，后面的 9-16 周被吞 | 1：week-forms |
| M5 | `addBlock` 的相接 / 重叠判断改成总是 `continue` | 不合并相邻 / 重复的块 | 1：period-map |
| M6 | `resolvePeriods`：起点在行范围内才用方括号 → 无条件用方括号 | 方括号与所在行对不上时不以行为准 | 1：period-map |
| M7 | `MAX_NAME_IN_WARNING = 20` → 200 | 提醒里的课名不截断，整条被截成 200 字 | 1：long-names |
| M8 | 删掉 `cleaned.replace(/-\s*第\s*/g, '-')` | `第1-第8周` 被拆成第 1 周与第 8 周 | 1：week-forms |
| M9 | 冬季第 6 节 `'13:30-14:20'` → `'13:30-14:30'` | 冬季节次时间错 10 分钟 | 7（所有放冬季表的用例） |
| M10 | 换季提醒整段关掉（`if (otherWeeks.length > 0)` → `if (false)`） | 不出换季提醒 | 8 |
| M11 | `ROW_SLOTS` 改成连续编号 `[[1,2],[3,4],[5,6],[7,8],[9,10],[11,11]]`（忽略 T1 / T2 夹档） | 行对应的节次错位 | 3：basic、period-map、season-single |
| M12 | extract.js：行序号 `seq` 改成 `r`（tr 下标，含表头行） | 节次整体错一行 | 浏览器冒烟 kb-page 场景：高等数学 3-4 节、大学英语 3-4 节、体育 11-12 节等 5 门课「课程不符」（冒烟 FAIL） |

12 处全部变红；还原后（真实目录没动）`check.js` 的最后一行为 `RESULT: PASS`，冒烟 11/11 OK。

## 11. 浏览器冒烟

`D:/NullClass/.test/port-batch12/qdu/smoke.py`（Playwright 起假强智站，全部请求被拦下，不联网），11 个场景全部 OK：

| 场景 | 页面 | 结果 |
|---|---|---|
| kb-page | `/jsxsd/xskb/xskb_list.do?xh=…`（页面有课表格子） | 只发 GET `/jsxsd/jxzl/jxzl_query` + POST `/jsxsd/jxzl/jxzl_query`（体 `xnxq01id=2026-2027-1`）；**不发课表请求，不请求 pyfa_query / fxpyfa_query / wzypyfa_query**；个人信息不外带；`pageUrl` 无查询串 |
| main-page | `/jsxsd/framework/xsMain.jsp`（教务首页） | 再多发 POST `/jsxsd/xskb/xskb_list.do`，体与上游一字不差：`jx0404id=&cj0701id=&zc=&demo=&xnxq01id=2026-2027-1` |
| calendar-page | `/jsxsd/jxzl/jxzl_query` | 同 main-page |
| login-root / login-index / login-post | `/jsxsd/`、`/jsxsd/index.jsp`、`/jsxsd/xk/LoginToXk` | 报「当前打开的是登录页……」，不发请求 |
| cas / portal | `authserver.qdu.edu.cn`、`www.qdu.edu.cn` | 报「当前打开的不是青岛大学教务系统……」，不发请求 |
| empty | 首页 + 课表为空 | 报「教务返回的课表是空的……」 |
| expired | 会话失效（周历页与课表都回登录表单） | 报「找不到学年学期……」 |
| calendar-500 | 页面有课表，周历 POST 返回 500 | 照样导入，开学日按提取日推算并出声 |

每个出载荷的场景还对 7 门课的星期 / 节次 / 周次 / 教室逐一核对（含 `[05-07节]` → 6-8 的三节连堂）。

## 12. 已知风险、未验证项（我们没有本校账号，真机没验过）

1. **没有真实页面。** fixtures 全部合成；`#timetable`、`#kbtable`、`div.kbcontent`、`font[title="老师|教师|教室|周次(节次)"]`、`td[title]`、`select#xnxq01id` 这些名字都来自上游代码，未在真实页面上核对。
2. **教务方括号里的节次编号的假设。** 本件假设方括号里的节次是青岛大学自己的编号（1-11，T1 / T2 不占序号），据此按「第 5-8 节 → 6-9、第 9 节起 → 11 起」换算。
   这个假设来自上游行下标公式的推导，没有真实页面佐证。已有保护：方括号换算后的起点必须落在该格所在行的范围内才采用，否则以所在行为准并出声；
   所以即使假设错了，节次最多回落到上游同样的行位置结果（但三节连堂会退回两节，并提示「读不懂或对不上」）。
3. **课程名的取法与上游不同。** 上游取第一个有文字的元素节点；真实页面里课名是裸文本还是套在元素里无法确认（上游能用，说明套在元素里，或先于 `<font>`）。
   本件先取第一个 `<font>` 之前的文本，再试无 title 的 `<font>`，再试标了课程名的 `<font>`；认不出课名的块计数点名，不会静默丢。
4. **课表里是否真的没有 T1 / T2 的课。** 依据是上游 adapters.yaml 的说明与行下标公式（只产出 6 行、跳过第 5 与第 10 节）。如果真实页面有第 7 行以后的行装着 T1 / T2 的课，
   它们会靠方括号读（读不成就点名跳过）。提醒里「教务课表里没有这两档的课」的说法是照上游说明写的。
5. **T1 / T2 的时间仅供参考。** 第 5 节（13:10 / 12:40 起）与第 10 节（17:50 / 17:20 起）上游自己说「没找到官方具体时间」，如实写进提醒，没有核实过。
6. **季节划分。** 夏季 5 月 1 日至 9 月 30 日、冬季 10 月 1 日至次年 4 月 30 日是上游「组合作息方案」写死的日期。本件按每周的周一所在月份判季节：
   周一在 9 月 29 日、周五已是 10 月的那一周按夏季算，实际可能前半周夏季后半周冬季；提醒里写的是「第 a 至 b 周」整周，不精确到天。
   学校若调整换季日期，这里不会自动跟随。多数周在哪季就放哪一套，是对「一个学期只有一张节次表」的折中，另一季的周次课表上会差 30 分钟，提醒里已说明。
7. **登录页判断只看地址。** `loginHint` 只认主机 `xjw.qdu.edu.cn` 且路径在 `/jsxsd/` 下；登录页路径只认 `/jsxsd/`、`/jsxsd/index*`、`/jsxsd/login*`、`/jsxsd/xk/log*`。
   如果校内还有别的入口主机（别名、WebVPN），会被当成「不是教务系统」而拒绝提取；要支持需要再放宽主机判断并核对 `allowHosts`。
8. **合并 / 去重的残余风险。** `addBlock` 把同课同天同周次同教室、节次相接或重叠的块并成一块；如果某门课真的在同一天相邻两个大节各上一次且有意分开显示，会被并成连续一块（对学生可见效果等同）。
9. **学期总周数。** 有周历取周历的周数，页面上某个写错的大周次会把总周数抬高（上限 30，出提醒）。
10. **`minAppVersionCode` 为 11。** 依据手册 §5.1：载荷只用 `kind: schedule` 与 `warnings`，不用提问桥与 OCR。
11. **版本。** `version` 1.0.0；首次入库的移植件，未在真机上验证过。

## 13. 签名

0x7E7-2023（sonnet 移植，2026-10-20）
