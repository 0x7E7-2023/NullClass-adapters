# 湖南大学（hnu）移植审计

本文件记录移植件的来源、模板选择与不同构之处、请求与读写面、手册 §5 八条的逐条结论、与模板件的差异、删掉的上游逻辑、fixtures、浏览器冒烟、变异测试与未验证项。
这里的每一条声明都对应当前代码（引用按函数名，不写行号）；没有核对的地方写在 §12。

## 1. 来源（provenance）

- 上游仓库：https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT）
- 上游文件：`resources/HNU/hnu_01.js`，上游作者（adapters.yaml 的 maintainer）星河欲转。
- 上游同目录 `resources/HNU/adapters.yaml`：adapter_id `HNU_01`，adapter_name「湖南大学强智教务」，category `BACHELOR_AND_ASSOCIATE`，import_url `http://hdjw.hnu.edu.cn/jsxsd/sso.jsp`，description 写「支持获取开学日期，非本校开发者适配如果有误建议提交 issues」。
- 上游快照：`19a65bf07a3e998fcfc69cee692387cdc0523c1a`（2026-10-19）。本校脚本最后一次修改 `dd65c99`（`git log -1 -- resources/HNU/hnu_01.js` 核对一致）。
- 平台：强智科技「教务管理系统」新版界面，学生端 `/jsxsd/`，课表是 `table.qz-weeklyTable`，课程详情放在格子里的 tooltip（`.qz-tooltip li.qz-toolitiplists`）。
- 移植者：0x7E7-2023（sonnet 移植，2026-10-20）。

## 2. 模板选择与不同构之处（分析）

公共说明候选的三件强智件里：`yssdufe`、`xjie`（调查表里与上游文本最像，因为同一位作者的脚本骨架 fetchSemesterList / fetchSemesterInfo / saveAppTimeSlots 一样）用的都是**老界面**（`#kbtable` + `div.kbcontent` + `font[title]`），与本校的 `table.qz-weeklyTable` 不同构；`jxust` 同样是老界面。
已审计的同界面件只有 `nefu`（东北林业大学，`table.qz-weeklyTable` + `jxzl_query` 周历），所以**以 nefu 为模板**：网格还原（按 rowSpan / colSpan 占位成 8 列）、同课合并（按周拆开再合并）、周历兜底与开学日对齐的结构沿用它；
周次解析按 `hueb` / 批次十一修过的写法重写（nefu 的周次文法只认固定几种形式，且单双矛盾直接跳过）。

与 nefu 不同构、按本校上游重写的层：

| 层 | nefu | 本件 hnu |
|---|---|---|
| 课程详情 | `ul[name="kbdataUl"] > li.courselists-item`，课名 `.qz-hasCourse-title`，一整串 `老师:…;时间:…;地点:…` 在 `.qz-hasCourse-abbrinfo` | 格子里 `.qz-tooltip li.qz-toolitiplists`，课名 `.qz-tooltipContent-title`，老师 / 地点 / 时间是三个独立的 `.qz-tooltipContent-detailitem`，以「老师：」「地点：」「时间：」开头；没有 `kbdatasize` 计数可核对 |
| 课表请求 | GET 带 `kbjcmsid`（作息模式）和 `zc`（周次） | GET 只带 `viweType=0&xnxq01id=<学期>`（上游 `requestCoursePage`） |
| 学期来源 | 课表页自己的 `#xnxq01id` 选中项 | 用户正停在课表页 / 教学周历页时取那一页的下拉框选中项；否则 GET 教学周历页取选中项（上游 `fetchSemesterList` 弹窗时的默认项） |
| 节次时间 | 不内置，由每大节行标签推出 | 上游写死 11 节统一作息（`saveAppTimeSlots`），逐节照抄 |
| 星期表头 | 必须 8 格、星期一起排、不得合并 | 按上游：thead 里所有 th / td 里认得出「星期X」的格子，按出现顺序对应正文第 1..7 列；允许星期日排最前，左上角空格有没有都行；恰好 7 个、互不相同才算 |
| 周历 | `#kbtable`，日期在 `td[title]`（含年份），周号在行首格 | `#dataTable`，行首 `td.qz-weeklyTable-label` 写「第N周」，其余格子文字是「09月07日」**没有年份**（上游用学期代码推年份：学年起始年，月份小于 8 的算下一年） |
| 每周起始日 | 第 1 周的星期一 | 上游 `firstDayOfWeek: 7`，开学日取周历第 1 周第一格；本件取第 1 周的第一天（星期日起算就是星期日，应用按 `firstDay` 的星期几确定每周起始日，手册 §4.3）；第一格是别的星期几才对齐到周一并提醒 |
| 周次写法 | 固定文法 `1-5,7-8周[1-2节]`，单双矛盾整条跳过 | 上游只认 `([\d,\-]+)\s*周`；本件认 hueb 的全套写法，单双同写按每周都上并提醒，认不出的整条跳过 |
| 节次写法 | 多段拆成多块 | 上游取 `[..节]` 里所有数字的最小到最大（`[1-2,5-6节]` 会把 3-4 节也算进去）；本件拆成多块 |
| 一格占多天 | 报错 | 上游把课放进跨的每一天；本件同样，并计数提醒 |

## 3. 请求表

extract.js 里有两处 `fetch(` 字面量（`getPage` 与 `postCalendar`），一次提取最多发出下面三个请求。路径都是页面同源的相对路径，`credentials: 'same-origin'`，不写 `Authorization` 或 Cookie；请求体 / 查询串里只有学期代码。

| # | 方法 | 路径 | 请求体 | 何时发 | 作用 | 取不到时怎么办 | 上游对应 |
|---|---|---|---|---|---|---|---|
| R1 | GET | `/jsxsd/jxzl/jxzl_query` | 无 | **仅当**用户不在课表页 / 教学周历页（路径不在 `/jsxsd/xskb/` 或 `/jsxsd/jxzl/` 下），或那一页的学期下拉框没有合法选中项 | 读学年学期下拉框 `#xnxq01id` 的选中项（`currentTerm`） | 状态码非 2xx / 跳到别的主机 / 连不上 / 登录页 → 报错（大白话）；没有下拉框或值不是 `yyyy-yyyy-n` → 报「找不到学年学期的选项」 | `requestSemesterPage()` / `fetchSemesterList()` |
| R2 | GET | `/jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=<学期>` | 无 | 每次提取 | 取该学期的课表页 | 同上报错；返回登录页 → 报「登录已失效」；没有课表表格 → parse.js 报「没有找到课表」 | `requestCoursePage()`（`viweType` 拼写照抄；上游 GET 上多发的 `Content-Type` 头与 `referrer` 不要） |
| R3 | POST | `/jsxsd/jxzl/jxzl_query` | `xnxq01id=<学期>`（`encodeURIComponent`） | R2 之后 | 教学周历：开学日期与总周数 | 取不到、状态码错、解析失败 → 交 null，parse.js 用兜底口径并提醒，**不致命** | `requestSemesterDetailPage()` / `fetchSemesterInfo()` |

- `readPage` 对响应做三件事：状态码（401/403 报「拒绝访问」，其它非 2xx 报「教务系统返回错误（代码 N）」）、`response.url` 的主机必须仍是 `hdjw.hnu.edu.cn`（被重定向走了就报「登录已失效」）、再解析成离线文档。
- 登录页判断（`loginLike`）：登录表单元素 `#userAccount` / `#userPassword` 存在，或页面标题**很短（≤12 字）且含「登录」**。后一条故意限长，免得正常课表页标题里夹带「登录」二字时被误判。
- 在登录页 / 统一认证页 / 门户页上点提取：`run()` 开头检查 `window.location.host`（不是 `hdjw.hnu.edu.cn` → 「请在湖南大学教务系统中执行导入」）和当前页是否登录页（→「当前页面不是课表」），**不发任何请求**（冒烟 `hnu-cas`、`hnu-login-form` 钉住）。
- 没有任何请求指向 `hdjw.hnu.edu.cn` 之外的主机。

## 4. 端口与入口

- `manifest.json`：`loginUrl` = `http://hdjw.hnu.edu.cn/jsxsd/sso.jsp`（上游 `import_url` 原值，教务的统一入口，可能跳到学校的统一认证页）；`scheduleUrlHint` = `https://hdjw.hnu.edu.cn/jsxsd/xskb/xskb_list.do`（上游请求用的 `BASE_URL` 是 https）；`allowHosts` = `["hdjw.hnu.edu.cn"]`，只有一个精确主机名，**没有通配**。
- 统一认证页的主机只在用户登录时出现，提取期间不请求它，所以不进 `allowHosts`。
- 上游 URL 全部写成 `https://hdjw.hnu.edu.cn`；本件用相对路径，协议跟着页面走（冒烟 `hnu-http` 在 http 页面上跑通）。
- 静态扫描（手册 §5 的两条命令）：URL 主机只有 `hdjw.hnu.edu.cn`（在 manifest 与注释里）；`fetch(` 两处字面量；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。

## 5. 读取面与输出面

### 5.1 extract.js 读了什么

- 页面的 `window.location.host` / `protocol` / `pathname`（判断主机、判断是否停在课表页 / 周历页、拼 `pageUrl`），当前文档的 `#xnxq01id`（仅在课表页 / 周历页上）。
- R1 / R2 响应（离线文档）：`#xnxq01id` 的选项（`value`、文字、有没有 `selected` 属性）；`table.qz-weeklyTable`（全部）的 `thead` 里所有 th / td 的文字（截 40 字）、`tbody` 的所有行的直接子 td / th 的 `name`、`class`、`rowspan`、`colspan`、**有没有文字**（只交布尔值），以及格子里 `.qz-tooltip li.qz-toolitiplists` 的课名 `.qz-tooltipContent-title` 和 `.qz-tooltipContent-detailitem` 中以「老师：」「地点：」「时间：」开头的三类文字。
- R3 响应：`#dataTable` 的 `tbody` 每行：`td.qz-weeklyTable-label` 的文字（截 20 字，周号标签），其余格子的文字（截 60 字）和 `title` 属性（截 40 字）。
- 登录判断：只看 `#userAccount` / `#userPassword` 这两个元素**是否存在**和页面标题，**不读它们的值**。

### 5.2 extract.js 交出去什么（逐字段，即 parse.js 的全部输入）

| 字段 | 类型 | 内容 | 来源 |
|---|---|---|---|
| `source` | 字符串 | 固定 `"qz-jsxsd-hnu"` | 常量 |
| `pageUrl` | 字符串 | 协议 + 主机 + 路径，**不含查询串** | `window.location` |
| `now` | 字符串 | 提取时刻的本地日期 `yyyy-MM-dd`（不用 `toISOString`） | `Date` |
| `loginTitle` / `loginForm` | 布尔 | 标题很短且含「登录」；登录表单元素是否存在 | R2 响应 |
| `term` | 对象 | `{ code, label, assumed }`：学期代码（形如 `2025-2026-2`）、下拉框选项文字、教务有没有标出当前学期（没有时取第一项，`assumed` 为真） | 下拉框 |
| `tables` | 数组 | 每张 `table.qz-weeklyTable` 一项：`{ head, body }` | R2 响应 |
| `tables[].head[]` | `{ text }` | 表头格文字 | thead |
| `tables[].body[][]` | cell | `{ label, rowSpan, colSpan, hasText, cards }` | tbody |
| `cell.label` | 布尔 | `name="timeTd"` 或带类 `qz-weeklyTable-label`（上游判据） | 属性 |
| `cell.rowSpan` / `colSpan` | 整数 | HTML 上的值（没有或不是数字为 1，**0 原样交**，由 parse.js 报错） | 属性 |
| `cell.hasText` | 布尔 | 非节次标签的格子里有没有可见文字。**只交有无，不交文字**——格子里的 tooltip 还带学号、班级之类不在白名单里的内容（冒烟里钉住了这一点：首版交的是文字前 60 字，冒烟发现会带出学号） | textContent |
| `cell.cards[]` | `{ title, details }` | 每个 tooltip 条目：课名 + 以「老师：」「地点：」「时间：」开头的详情文字（按前缀白名单挑，其余详情不交） | tooltip |
| `calendar` | 对象或 null | `{ rows: [ { label, cells: [ { text, title } ] } ] }`；周历取不到为 null | R3 响应 |

**输出面（应用拿到的载荷）**：parse.js 的输出只含 `specVersion`、`kind: "schedule"`、`ocrAssisted: false`、`warnings`、`terms[0]`（`name`、`firstDay`、`totalWeeks`、`periodTimes`、`courses`）。课程的 `name`、`teacher`、`location` 来自 tooltip 的课名 / 老师 / 地点；没有 UUID、时间戳、颜色或学号。

**学号、姓名、人员 ID 的去向**：extract.js 不读页面上的个人信息区域；tooltip 里不在白名单里的详情（如「学号」「班级」）不交；格子文字只交有无。冒烟的假页面里把学号、姓名、身份证号、手机号分别塞在页面头部、tooltip 的非白名单详情里，检查请求和 extract 输出里一处都不出现。

## 6. 手册 §5 安全审计八条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | extract.js 不读账号、密码的值；登录表单只判断 `#userAccount` / `#userPassword` 是否存在。请求只声明 `credentials: 'same-origin'`，会话由浏览器附带。check.js 的词法提示「password 字样」命中的正是 `getElementById('userPassword')` 这个存在性判断。 |
| 2 | 不外发 | 通过 | `fetch(` 两处字面量，都是同源相对路径；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。冒烟检查了所有请求的主机。 |
| 3 | 请求域可控 | 通过 | `allowHosts` 只有 `hdjw.hnu.edu.cn`，没有通配；`run()` 开头检查页面主机，`readPage` 检查重定向目标主机。 |
| 4 | 只读课表 | 通过 | 三个请求都是学生端课表页（R2）、教学周历（R1、R3）；不请求成绩、学籍、缴费、个人信息或选课页面。上游的这三个 URL 一个不多。 |
| 5 | 不埋点 | 通过 | 没有统计、上报或遥测代码。 |
| 6 | 不 eval 远程代码 | 通过 | 两个文件都没有 `eval` 与 `new Function`；check.js 的词法扫描通过。 |
| 7 | 不写页面 | 通过 | extract 只读页面与离线文档（`DOMParser`）；没有 innerHTML 赋值、appendChild、表单提交或 value 赋值。上游的 `showAlert`、`showToast`、`showSingleSelection`、`notifyTaskCompletion`、`saveCourseConfig`、`savePresetTimeSlots`、`saveImportedCourses` 等界面与保存调用已删。 |
| 8 | 不依赖秘密 | 通过 | 没有硬编码的密钥、令牌或学号；学期代码来自页面下拉框。 |

## 7. 节次时间（逐节，照抄上游 `saveAppTimeSlots()`）

| 节 | 开始 | 结束 | 节 | 开始 | 结束 |
|---|---|---|---|---|---|
| 1 | 08:00 | 08:45 | 7 | 16:10 | 16:55 |
| 2 | 08:55 | 09:40 | 8 | 16:55 | 17:40 |
| 3 | 10:00 | 10:45 | 9 | 19:00 | 19:45 |
| 4 | 10:55 | 11:40 | 10 | 19:55 | 20:40 |
| 5 | 14:30 | 15:15 | 11 | 20:50 | 21:35 |
| 6 | 15:15 | 16:00 | | | |

- 上游不从教务读节次时间，只有这一张写死的表，所以本件也不请求节次时间，**每次**都在提醒第一条说明「节次时间没有从教务系统读取，已按学校公布的 11 节时间导入（…），与实际不符时请在「学期管理」里核对」。表是上游作者写的，我们没有对照学校的公布文件核实（§12）。
- 第 5-6 节、第 7-8 节首尾相接（15:15、16:55 没有课间），是上游原值，照抄。
- 统一修订 H3：课表用到第 12 节及以后时，在上一节下课后顺推（课间 5 分钟、每节 45 分钟）：第 12 节 21:40-22:25，第 13 节 22:30-23:15，第 14 节起越过 23:59 补不了——课程照常导入，提醒里点名「第 N 节及以后没有补上时间」。补了哪些也写进提醒（`period-extend` 用例）。单日节次上限 20，超过的写法按认不出处理。

## 8. 与模板（nefu）的差异（汇总）

1. 课程详情、请求、学期来源、节次时间、周历、星期表头：见 §2 表。
2. 周次解析：hueb 风格的全套写法 + 「第」字、「共 N 周」、括号三分类、单双就近归属；同时写单和双按每周都上并提醒（nefu 是整条跳过）。认不出的整条跳过（不猜）。
3. 节次写成多段拆成多块（上游取最小到最大）。
4. 缺教师 / 缺地点：nefu 没有汇总提醒，本件按类型汇总（点名最多 3 门，课名截 20 字）。
5. 学期没有标出当前学期（`assumed`）时的提醒；一格有内容却认不出课程时的提醒；页面有多张课表时只取第一张并提醒。
6. 一格占多天（colSpan > 1）：上游行为保留，计数提醒（nefu 直接报错）。
7. 开学日：周历第 1 周前 7 个有日期的格子必须逐天连续才采用，第一天是星期日或星期一直接采用（星期日起算时提醒周次的起算日），其它星期几对齐到周一并提醒。

## 9. 上游里被删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `showAlert` 开场确认、`showSingleSelection` 选学期 | 删；学期取页面当前选中项 | 少一次交互；公共说明约定「读页面当前学期，读不到再按上游的请求取」 |
| `showToast`、`notifyTaskCompletion`、`saveCourseConfig`、`savePresetTimeSlots`、`saveImportedCourses` | 删 | 脚本对页面只读；保存与提示由应用负责 |
| `未知教师`、`未知地点` | 留空（null），汇总提醒 | 手册 §4.7 |
| 地点是「()」时当作没有 | 保留（也认全角括号和空白） | 上游判据 |
| `parseWeeks`：按 `(` 截断后只认数字、逗号、短横线；`i > 0` 才收 | 重写（§8 第 2 条）；第 0 周及超出 30 的周次计数提醒 | 上游把「单 / 双」标记悄悄丢掉（整门课退化成每周都上），把 0 周静默丢掉 |
| `[..节]` 取最小到最大 | 拆成多块 | 避免把不上课的节次算进去 |
| `mergeAndDistinctCourses` 两阶段 | 沿用 nefu 的按周拆开再合并 | 同样不改任何一周的安排，且不会把部分周相邻的调课扩到整学期 |
| `fetchSemesterInfo`：拿第 1 周第一格的月日，没找到第 1 周就拿第一行顶替 | 不顶替：找不到第 1 周按提取时刻推算最近的周一并提醒；日期必须逐天连续 | 宁可推算并说明，也不写错日期 |
| `semesterTotalWeeks = totalWeeks \|\| 20` | 保留 20 周兜底；课表有更晚的周次则抬高；上限 30，超过截断并提醒 | 载荷规范 |
| `firstDayOfWeek: 7` | 不单独传，隐含在 `firstDay` 的星期几 | 手册 §4.3 |
| `fetch` 的 `referrer`、GET 上的 `Content-Type` | 不要 | GET 不需要 |
| 绝对地址 `https://hdjw.hnu.edu.cn` | 相对路径 | 不写死协议与主机，页面在哪就请求哪 |
| `Set`、`Array.from`、展开、解构、箭头函数、模板串、可选链等 | 改成 ES5 | CI 的 Rhino 与 ES5 检查 |

## 10. fixtures

全部为合成数据（没有真实学号、姓名）。extracted 由 `C:/Users/23703/AppData/Local/Temp/hnu-port12/gen.js` 生成（只造输入，不造期望；做完已删）；expected 按规范与代码逻辑**手工推演**后写入，再与 parse.js 输出比对（`skipped-long` 里需要数字符的长提醒，用一小段独立的 Python 按「前 19 字 + …」「整条前 199 字 + …」的规则算，没有拿 parse.js 的输出）。

| 用例 | 覆盖什么 | 本校专属边界 |
|---|---|---|
| `basic` | 星期日排最前的表头（含左上角空格）、一格两门课（`1-8周` 与 `9-16周`）、`1-15周(单)` → ODD、`2-16周(双)` → EVEN、教师和地点留空 → null 并汇总提醒、周日的课（dayOfWeek 7）、周历第 1 周从星期日算起（firstDay 取星期日并提醒） | 表头星期日起、tooltip 三行详情、地点「()」 |
| `week-forms` | 表头只有 7 格（没有左上角空格）、周一起排；前缀 `(单)1-8周,(双)9-16周` 与后缀 `1-8周(单) 9-16周(双)` 各归各的、`第1-第8周`、`1-8周(共8周),9-16周`（备注不吞后一段）、`1-15单周`、`2-16双周`、`1,3,5-7周` 混排、单独 `17周` | 单双标记归属、共 N 周剥离（批次七、八审计真抓到过的错） |
| `week-edge` | `1-35周` 截到 30 周并提醒、`0-3周` 第 0 周丢弃、`(单双周)` 按每周都上并提醒、`(1,2)` 序号括号与 `(3组)` 备注括号、`[1-2,5-6节]` 拆成两块、总周数被课表抬高到 30 | 周次边界、多段节次 |
| `merge-partial` | 周一起排；节次标签 `rowSpan=2`（第二行只有 7 个格子）；相邻节次并成 1-4 节；同一张卡片出现在两行的完全重复去重；`1-16周` 的 5-6 节 + `1-8周` 的 7-8 节只合并相邻的周（9-16 周仍是 5-6 节）；一格 `colSpan=2` 占周四、周五并提醒；春季学期年份推算（02 月 → 下一年） | 网格占位、colSpan、年份推算 |
| `calendar-fallback` | 周历取不到：开学日按最近周一推算并提醒、总周数 20 被课表（22 周）抬高并提醒、学期选项文字为空 → 由代码拼学期名、教务没有标出当前学期（`assumed`）的提醒 | 周历缺失兜底 |
| `calendar-aligned` | 周历第 1 周从星期三算起 → 对齐到周一并提醒；第 1 周格子 `title` 带年份（`2026年02月25日`）的写法；学期名用教务给的文字（`2025-2026学年第二学期`） | 开学日对齐 |
| `calendar-odd` | 第 1 周日期不连续（少了一天）→ 不采用，按最近周一推算并提醒 | 周历日期核对 |
| `period-extend` | 第 11-14 节：第 12、13 节顺推补时间（21:40-22:25、22:30-23:15），第 14 节越过 23:59 补不了，课程照常导入，两条提醒 | H3 |
| `skipped-long` | 没有课名 / 没有上课时间 / 周次写法认不出 / 节次写法认不出 / `2单周` 没有有效周次的卡片跳过并点名（最多 5 个，整条提醒被限长到 200 字）；三门缺教师缺地点的长课名（28 字）课程照常导入，例子里的课名各截到 20 字；页面有两张课表只导第一张；一格有文字却没有课程 | 带课名的提醒限长（长课名用例）、坏卡片 |

报错用例（不做成 fixture，在临时目录造输入用 RhinoRun 单跑，输出已核对）：表头少一天 / 星期重复 → 「课表表头和预期不一样」；没有课表表格 → 「没有找到课表」；没有节次行；某行格子不满 8 列 → 「有一行课表不完整」；第一列不是节次标签 / 节次标签出现在其它列；`colSpan=0` 或越界 → 「课表格子的跨行或跨列对不上」；登录表单 / 登录标题 → 「当前页面不是课表」；学期代码缺失或格式不对 → 「找不到学年学期」；整张课表没有一门课 → 「本学期没有解析到任何课程」（防止空学期清空同名学期）；所有格子都有字却认不出课程 → 同名报错并说明；周历第 1 周标签写成「第一周」 → 不认，走推算开学日的兜底并提醒；`now` 缺失且周历取不到 → 「无法确定今天的日期」。

## 11. 浏览器冒烟与变异测试

### 11.1 冒烟（`D:/NullClass/.test/port-batch12/hnu/smoke.py`，Playwright + Chromium 假教务站，请求全被 route 拦下，不联网）

跑真实的 extract.js，再用 Rhino 跑 parse.js；检查请求序列、请求体 / 查询串、没有请求去别的主机、个人信息（学号、姓名、身份证号、手机号、tooltip 里的学号和班级）不出现在请求和 extract 输出里、`pageUrl` 无查询串、载荷关键值、warnings ≤200 字。14/14 通过：

| 场景 | 确认了什么 |
|---|---|
| `hnu-schedule-page` | 用户停在课表页：只发 `GET /jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=2026-2027-1` 和 `POST /jsxsd/jxzl/jxzl_query`（体 `xnxq01id=2026-2027-1`），**没有** `GET jxzl_query`；开学日 2026-09-06（星期日） |
| `hnu-schedule-page-other-term` | 页面下拉框选了 2025-2026-2 → 课表请求、周历请求都用它，课程与开学日（2026-02-23）随之变化 |
| `hnu-calendar-page` | 用户停在教学周历页：同上，不多发 GET |
| `hnu-home` | 停在首页：先 `GET jxzl_query` 取默认学期，再课表 GET、周历 POST |
| `hnu-home-no-selected` | 周历页下拉框没有 `selected` 属性：取第一项并出「没有标出当前是哪一学期」提醒 |
| `hnu-http` | http 页面：相对路径跟着协议走 |
| `hnu-cal-500` | 周历 POST 返回 500：不致命，开学日按最近周一推算并提醒、总周数 20 |
| `hnu-no-term` | 周历页没有下拉框：「找不到学年学期的选项」 |
| `hnu-cas`、`hnu-login-form` | 统一认证页（别的主机）/ 本校登录页：直接报错，**不发任何请求** |
| `hnu-expired`、`hnu-redirect-cas` | 课表 GET 返回登录页 / 被 302 跳到认证页：「登录已失效」 |
| `hnu-500` | 课表 GET 返回 500：「教务系统返回错误（代码 500）」 |
| `hnu-empty` | 课表里一门课都没有：parse.js 报「没有解析到任何课程」，不导入空学期 |

### 11.2 变异测试

每次把整件复制到 `C:/Users/23703/AppData/Local/Temp/hnu-port12/mut-<编号>/hnu/`，在副本的 parse.js 唯一锚点上改一处，运行 check.js，记下变红的用例。真实目录的 parse.js 没有被改动，收尾后重跑自检为 PASS。

| 编号 | 改坏的位置（parse.js） | 变红的用例 |
|---|---|---|
| M1 | `var marks = (m[1] \|\| '') + (m[4] \|\| '');` 改为只取前缀（后缀单双标记不认，`weeksOf`） | basic、week-forms、week-edge、skipped-long |
| M2 | `共N周` 剥离改成上游式 `/共.*$/`（吞到行尾） | week-forms |
| M3 | 删掉 `text.replace(/第/g, '')`（`第1-第8周` 认不出） | week-forms |
| M4 | 周历第一天只认星期一（`weekday === 0 \|\| weekday === 1` 改成 `=== 1`） | basic |
| M5 | 年份推算 `(month < 8 ? 1 : 0)` 改成 `(month < 8 ? 0 : 0)`（春季学期少一年） | week-edge、merge-partial |
| M6 | `sectionsOf` 的 `return rangesOf(list)` 改成取最小到最大（上游式） | week-edge |
| M7 | H3 顺推 `nextEnd > MAX_MINUTE` 改成 `> 99999`（越过 23:59 也补） | period-extend |
| M8 | 周历日期不核对逐天连续（`if (consecutive)` 改成 `if (true)`） | calendar-odd |
| M9 | 同周相邻节次不合并（`<= last[1] + 1` 改成 `<= last[1]`） | merge-partial |
| M10 | `shortName` 不截断课名 | skipped-long |
| M11 | 单双同写时按单周处理（而不是每周都上） | week-edge |
| M12 | 单周过滤方向反了（`hasOdd && w % 2 === 0` 改成 `=== 1`） | basic、week-forms、skipped-long |
| M13 | 前缀单双标记不认（`marks` 只取 `m[4]`） | week-forms |
| M14 | 缺教师缺地点的汇总提醒整段关掉 | basic、skipped-long |

14 处全部变红；全部在副本上做，真实目录未改动。

## 12. 已知风险、未验证项

- **没有本校账号，真机没验过。** 课表格子的类名（`table.qz-weeklyTable`、`.qz-tooltip li.qz-toolitiplists`、`.qz-tooltipContent-title`、`.qz-tooltipContent-detailitem`）、周历的 `#dataTable` / `td.qz-weeklyTable-label` / 日期格文字格式、学期下拉框 `#xnxq01id` 都是按上游代码的判据写的，没有对照真实页面 HTML。冒烟用的假页面是按这些判据我们自己搭的，只能证明代码与自己的假设一致。
- **每周起始日。** 上游把 `firstDayOfWeek` 设成 7，说明本校课表 / 周历是星期日排最前。本件取周历第 1 周的第一格作开学日（星期日就是星期日，应用据此把周视图排成星期日起算）。若真实周历第 1 周第一格不是星期日或星期一，会对齐到周一并提醒；若周历是星期一起排，则按星期一处理，提醒里不会出现「星期日」那句。需要真机核对周视图的列顺序是否与教务一致。
- **年份是推出来的。** 周历格子只有月日，年份靠学期代码推（学年起始年，月份小于 8 的算下一年），与上游一致。暑期短学期若第 1 周在 8 月之前开始且代码是第一学期，会差一年——不过日期要逐天连续才采用，结果错了会体现在「现在是第几周」上，请用户核对（提醒里已要求在「学期管理」核对）。
- **教务不标出当前学期。** 周历页下拉框没有 `selected` 属性时取第一项（上游弹窗时的默认项），可能是最旧的学期；已加提醒要求核对。用户先在课表页切到想导入的学期再点提取，就不会走这条。
- **节次时间是上游写死的表。** 我们没有对照学校公布的文件核实，也没有按校区区分；提醒第一条每次都说明了来源。
- **周次写法覆盖面。** 只认 §2 / `weeksOf` 注释里列的写法；认不出的整条卡片跳过并点名（不猜）。上游 tooltip 里「时间」一行的真实样子只有注释里的一个例子（`0-3 周 [1-2节]`），本件按「周次文字 + 方括号节次」的通用形状解析，同一行里写几段（`1-8周 [1-2节] 9-16周 [3-4节]`）也认。
- **同课合并的口径。** 同名、同老师、同地点、同星期的卡片按周拆开再合并；同一门课在两个不同地点上会得到同一门课下的两条块，不会被合并成一条。
- **页面有多张课表。** 取表头认得出星期的第一张并提醒；若真实页面有两张结构相同、内容不同的课表（如「本学期」与「下学期」），导入的可能不是想要的那张。
- **登录页判断。** 同主机的登录页靠登录表单元素或「短标题含登录」识别；若学校的登录页两者都不满足，会在拿到页面后因找不到课表或学期而报错（不会静默导入）。
- **上游快照一致性。** `git log -1 -- resources/HNU/hnu_01.js` 的提交为 `dd65c99`，与任务卡一致。

## 13. 签名

0x7E7-2023（sonnet 移植，2026-10-20）
