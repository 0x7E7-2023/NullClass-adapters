# 中国海洋大学（ouc）移植审计

本文件记录移植件的来源、请求与读写面、手册 §5 八条的逐条结论、与模板件的差异、删掉的上游逻辑、fixtures、变异测试、冒烟测试与未验证项。
这里的每一条声明都对应当前代码；行号一律不引用，按函数名指代。没有核对的地方写在 §11。

## 1. 来源（provenance）

- 上游仓库：https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT）
- 上游文件：`resources/OUC/ouc_01.js`（417 行），上游作者（adapters.yaml 的 maintainer）anOsprey。
- 上游同目录 `resources/OUC/adapters.yaml`：adapter_id `OUC_01`，adapter_name「中国海洋大学本科教务系统」，category `BACHELOR_AND_ASSOCIATE`，
  import_url `https://id.ouc.edu.cn/sso/login?service=https%3A%2F%2Fjwgl2024.ouc.edu.cn%2F`，maintainer `anOsprey`。
- 上游快照：`19a65bf07a3e998fcfc69cee692387cdc0523c1a`（2026-10-19 拉取）。本校脚本最后一次修改：`1f02b9f`（2026-10-19 22:33，`git log -1 -- resources/OUC/ouc_01.js` 核对过，与任务卡一致，无出入）。
- 本件只管**本科生个人周课表**（上游的 `xskb_list.do` 课表页），不处理研究生或其他入口。
- 平台：强智科技「教务管理系统」新版界面，学生端 `/jsxsd/`，教务主机 `jwgl2024.ouc.edu.cn`。判据按上游**实际请求的路径**（`/jsxsd/xskb/xskb_list.do`、`/jsxsd/jxzl/jxzl_query`），
  课表 DOM 的判据是 `table.qz-weeklyTable` / `tr.qz-weeklyTable-tr` / `td[name=kbDataTd]` / `li.courselists-item` / `.qz-hasCourse-title`。
- 移植者：0x7E7-2023（sonnet 移植，2026-10-20）。

## 2. 请求清单

extract.js 里有两处 `fetch(` 字面量（`getPage` 与 `getCalendar`），一次提取最多发出下面三个请求，**全部是 GET**，路径是页面同源的相对路径，`credentials: 'same-origin'`，不写 `Authorization` 或 Cookie。

| # | 方法 | 路径 | 何时发 | 作用 | 取不到时怎么办 | 上游对应 |
|---|---|---|---|---|---|---|
| R1 | GET | `/jsxsd/xskb/xskb_list.do?viweType=0` | **仅当**当前页面没有 `select#xnxq01id` 时 | 读学年学期下拉框的选中项（和 `select#kbjcmsid`） | 状态码非 2xx / 重定向到别的主机 / 连不上 → 报错（大白话）；返回的是登录页，或页面没有学年学期下拉框 → 报错「当前页面不是课表…」「找不到学年学期的选项…」 | `fetchSemesterList()`（`viweType` 拼写照抄上游） |
| R2 | GET | `/jsxsd/xskb/xskb_list.do?viweType=0&showallprint=0&showkchprint=0&showkink=0&showfzmprint=0&baseUrl=%2Fjsxsd&xsflMapListJsonStr=<讲课学时,实践学时,>&xnxq01id=<学期>&zc=&kbjcmsid=<作息方案>` | 每次提取 | 整学期（`zc` 为空）的周课表 | 同上报错；表格找不到 → parse.js 报「没有找到周课表…」 | `fetchCourses()` 的 URL，逐字段对得上（冒烟里用独立拼出的上游查询串逐字比对，见 §9） |
| R3 | GET | `/jsxsd/jxzl/jxzl_query?xnxq01id=<学期>` | R2 成功之后 | 教学周历：开学日与总周数 | 取不到、状态码错、解析失败 → 交 null，由 parse.js 推算开学日并提醒，**不致命** | `fetchCalendarInfo()`（上游同样是 GET） |

- 请求参数只有：学期代码（来自页面下拉框的选中项）、作息方案编号（上游写死的 `16FD8C2BE55E15F9E0630100007FF6B5`；页面的 `select#kbjcmsid` 里**没有**这个值时，改用页面选中的那一项，并由 parse.js 提醒）、固定常量。不带学号、姓名、令牌，不读本地存储。
- 重定向检查：`readPage` 对 `response.url` 做主机检查，被重定向到别的主机（通常是统一身份认证页）时报「登录已失效」（桩测试见 §9）。
- 登录页处理：外层 `run()` 先看页面主机（不是 `jwgl2024.ouc.edu.cn`，例如停在 `id.ouc.edu.cn` 统一认证页，直接报「请在中国海洋大学教务系统的页面里导入」），再看当前文档是否像登录页（有 `#userAccount` / `#userPassword`，或标题含「登录」），**两种情况都不发任何请求**。
- 没有任何请求指向 `jwgl2024.ouc.edu.cn` 之外的主机。

## 3. 端口与 allowHosts

- `manifest.json` 的 `allowHosts` 为 `["jwgl2024.ouc.edu.cn"]`，一个精确主机名，**没有通配**。
- `loginUrl` 是上游的 import_url（`id.ouc.edu.cn` 统一认证，登录后跳回教务）；它与 `loginUrl` 同源，不必再写进 allowHosts。extract.js 从不向 `id.ouc.edu.cn` 发请求。
- 请求用相对路径，脚本里只有三个路径字面量，主机由页面本身决定，`run()` 开头还要求 `window.location.host` 等于 `jwgl2024.ouc.edu.cn`（上游没有这个检查，是新增的守卫）。
- 静态扫描（手册 §5）：`fetch(` 两处；没有 XHR、sendBeacon、WebSocket，没有图片 src 赋值，没有 `eval` / `new Function`。

## 4. 读取面与输出面

### 4.1 extract.js 读了什么

- `window.location.host`（判断是否在本校主机上）、`protocol` / `host` / `pathname`（只用于 `pageUrl`，**不含查询串**）。
- 当前页面与 R1、R2 响应里的下拉框：`#xnxq01id`、`#kbjcmsid` 的选中值与各选项的 `value`、文字。
- 登录判断：`#userAccount` / `#userPassword` **是否存在**，以及页面 `<title>` 是否含「登录」（标题原文不交出）。**不读它们的值**。
- R2 响应里的 `table.qz-weeklyTable`：数量（全部计数）；**第一张**的：`thead` 第一行（没有 `thead` 就取第一行不带 `qz-weeklyTable-tr` 类的行）每格的 `rowspan`、`colspan`、文字（≤40 字）；所有 `tr.qz-weeklyTable-tr`（`thead` / `tfoot` 里的不算，与上游一致）的每个 td / th 的 `name`、`rowspan`、`colspan`，非课程格子（节次标签）的文字（≤80 字），课程格子里 `li.courselists-item` 的课名（`.qz-hasCourse-title`）与整张卡片的文字（≤400 字）；`tfoot` 里 `.qz-weeklyTable-detailtext` 的文字（≤20 条，每条 ≤100 字）。
- R3 响应里的表（先找 `table.qz-weeklyTable`，没有就取页面第一张 `table`，与上游一致）：每个 td / th 的文字与 `title` 属性（各 ≤40 字）。

### 4.2 extract.js 交出去什么（逐字段，即 parse.js 的全部输入）

| 字段 | 类型 | 内容 | 来源 |
|---|---|---|---|
| `source` | 字符串 | 固定 `"qz-jsxsd-weekly"` | 常量 |
| `pageUrl` | 字符串 | 协议 + 主机 + 路径 | `window.location` |
| `now` | 字符串 | 提取时刻本地日期 `yyyy-MM-dd`（不用 `toISOString`） | `Date` |
| `loginTitle` / `loginForm` | 布尔 | R2 响应标题含「登录」/ 有登录表单元素 | R2 文档 |
| `term` | `{ code, label }` | 学期代码与选项文字 | 当前页面或 R1 的 `#xnxq01id` 选中项 |
| `echoTerm` | 字符串或 null | R2 响应里 `#xnxq01id` 的选中值（没有该下拉框为 null），parse.js 核对「返回的学期就是请求的学期」 | R2 文档 |
| `mode` | 对象 | `requested`（请求用的作息方案编号）、`fallback`（是否因下拉框里没有上游那个值而改用页面选中项）、`selected`（R2 里 `#kbjcmsid` 选中值或 null）、`label`（该选项的文字）、`clock`（第一行节次标签里的第一个「时:分」，没有为 `""`） | R2 文档 |
| `campus` | `{ asked, index }` | 是否问了校区、用户选的下标（0 崂山/鱼山，1 西海岸，取消 / 不能问为 null） | `__ncSelect` |
| `tableCount` | 整数 | `table.qz-weeklyTable` 的张数 | R2 文档 |
| `table` | 对象或 null | `{ head: [{rowSpan,colSpan,text}], rows: [[{name,rowSpan,colSpan,text,cards:[{title,text}]}]], foot: [字符串] }` | 第一张周课表 |
| `calendar` | 对象或 null | `{ rows: [[{text,title}]] }`；取不到为 null | R3 文档 |

**输出面（应用拿到的载荷）**：parse.js 的输出只含 `specVersion`、`kind: "schedule"`、`ocrAssisted: false`、`warnings`、`terms[0]`（`name`、`firstDay`、`totalWeeks`、`periodTimes`、`courses`）。
课程的 `name`、`teacher`、`location` 来自课表卡片；没有 UUID、时间戳、颜色或学号。

**学号、姓名、手机号、身份证号的去向**：课表页与周历页本身不要求这些字段，extract.js 也不读页面上的个人信息区域（只按 §4.1 的选择器取课表、下拉框、周历），`window` 下的全局对象一概不读。
课程卡片的文字（≤400 字）里理论上只有课程信息；即便教务页面在卡片里夹带了别的东西，parse.js 也只取「老师」「时间」「地点」三个字段写进输出。冒烟测试的假教务站在课表页里放了学号 / 手机号 / 身份证号的诱饵（页面文字与 `<script>` 里的全局变量），检查它们既不出现在请求里，也不出现在 extract.js 的输出里（§9）。

## 5. 手册 §5 安全审计八条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | extract.js 不读账号、密码的值；登录表单只判断 `#userAccount` / `#userPassword` 是否存在。请求只声明 `credentials: 'same-origin'`，会话由浏览器附带，脚本读不到也不转发。check.js 的词法提示「password 字样」命中的就是 `getElementById('userPassword')` 这个存在性判断，不是读值。 |
| 2 | 不外发 | 通过 | `fetch(` 两处字面量，都是同源相对路径的 GET；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。 |
| 3 | 请求域可控 | 通过 | `allowHosts` 只有 `jwgl2024.ouc.edu.cn`，没有通配；`run()` 开头检查页面主机，`readPage` 检查重定向目标主机。 |
| 4 | 只读课表 | 通过 | 三个请求都是学生端课表页（R1、R2）与教学周历（R3）；不请求成绩、学籍、缴费、个人信息或选课页面。 |
| 5 | 不埋点 | 通过 | 没有统计、上报或遥测代码。 |
| 6 | 不 eval 远程代码 | 通过 | 两个文件都没有 `eval` 与 `new Function`；check.js 的词法扫描为通过。 |
| 7 | 不写页面 | 通过 | extract 只读页面与离线文档（`DOMParser`）；没有 innerHTML 赋值、appendChild、表单提交或 value 赋值。上游的 `showAlert` / `showToast` / `showSingleSelection` / `saveCourseConfig` / `saveImportedCourses` / `savePresetTimeSlots` / `notifyTaskCompletion` 已删（§7）。提问桥 `__ncSelect` 只在校区判断不了时问一次，是宿主提供的受限接口（规范 §5.2）。 |
| 8 | 不依赖秘密 | 通过 | 没有硬编码的密钥、令牌或学号。`KBJCMSID` 是教务页面下拉框里公开的作息方案编号（上游写死），不是秘密；学期与作息方案的值优先来自页面。 |

## 6. 与模板件（nefu）的差异

模板选 **nefu**（东北林业大学，同为强智新版界面），不选候选里的 yssdufe / xjie / jxust：这三件是老界面（`#kbtable` + `div.kbcontent`，`font[title]` 里放教师教室），
与本校的 `table.qz-weeklyTable` + `li.courselists-item` 完全不同构；`D:/NullClass/.test/port-batch8/survey10-out.txt` 里 OUC 与 yssdufe 的相似度只有 0.282。
nefu 的网格还原（rowspan / colspan 占位）、同课合并、H3 补节次、提醒限长这些骨架直接适用；其余按上游 `ouc_01.js` 重写：

| 层 | nefu | 本件 ouc |
|---|---|---|
| 课表请求 | 先 GET 课表页读学期、作息模式、周次三个下拉框，再 GET 指定查询条件的课表 | 当前页面有学年学期下拉框就直接用，没有才 GET 一次；课表请求的 URL 逐字段照上游 `fetchCourses`（含 `showallprint` 等一串固定参数与写死的 `kbjcmsid`） |
| 周历请求 | POST，请求体 `xnxq01id=` | **GET** `?xnxq01id=`（上游就是 GET） |
| 周历解析 | `td[title]` 上的「yyyy年MM月DD日」，表头单字认星期几 | 照上游 `parseCalendarRows` / `deriveMondayFromRow`：每行找「第 N 周」标签格，后面的格子依次是星期一…日，找文字为「M月D日」的格子，在学年的起止年里按星期几对出年份；多认带年份的写法与 title 属性、星期日排第一列的周历；日期必须落在学期的合理区间里（第一学期：起始年 8–10 月；第二学期：次年 1–4 月；第三学期：次年 6–9 月）且星期几对得上才算数，各种组合推出的周一不唯一就不采用 |
| 课程卡片 | `ul[name=kbdataUl]` 里的 li，只读 `.qz-hasCourse-abbrinfo`，要求「老师:…;时间:…;地点:…」三段齐全 | 上游只读 `li.courselists-item`，课名取 `.qz-hasCourse-title`，三个字段从整张卡片的文字里各自取（教师 / 地点缺了不丢课）；周次节次是「周次[节次节]」一个时间串 |
| 周次 | `numbersOf` 列表，单双写在「周」前后各一处 | 用 hueb / swu 的周次写法（多段各带单双标记、后缀紧挨下一段、第 N 周、共 N 周），**严格模式**：认不出的括号 / 多余字符整张卡跳过并点名，不猜 |
| 节次时间 | 由行标签（每大节的起止时间）推算，不内置 | **内置上游写死的两张 12 节表**（崂山/鱼山、西海岸），逐节照抄；行标签不用于推算（大节内课间不是 5 分钟，推算会错），只拿第一大节的上课时间做校区判断 |
| 校区 | 无（nefu 选「本部」作息模式） | 照上游问一次；只有走了页面选中的作息方案、且数据明确时才省掉提问（§6.1） |
| 星期 | 表头必须 8 格并认出 7 天，否则报错 | 优先用表头；表头认不全时，课程列正好 7 列就从左到右当作周一…周日并提醒（上游就是按列序数星期），否则报错 |
| 表数量 | 不是恰好一张就报错 | 取第一张（上游同），多于一张时提醒 |
| 登录页 | 页面主机检查 + 返回页判登录 | 同，另外**当前文档**像登录页时直接报错、不发请求（任务卡要求） |
| 缺教师 / 教室 | 静默留空 | 留空（null）并按类型汇总提醒（公共说明第 4 条） |

### 6.1 校区与节次时间

上游把两张 12 节表写死，导入时弹窗问一次校区（崂山/鱼山 或 西海岸；两张表只有第 1–4 节不同，第 5–12 节相同）。本件逐节照抄（第 1–4 节：崂山/鱼山 08:00–08:50、09:00–09:50、10:10–11:00、11:10–12:00；西海岸 08:30–09:20、09:25–10:15、10:30–11:20、11:25–12:15；第 5–12 节：13:30–14:20、14:30–15:20、15:30–16:20、16:30–17:20、17:30–18:20、18:30–19:20、19:30–20:20、20:30–21:20）。

校区判断（`campusEvidence`，extract.js 与 parse.js 各一份、口径相同，注释里互相指明，要一起改）。

**前提**：请求用的是上游写死的作息方案编号时（绝大多数情形），方案名称和节次标签对所有学生都一样，**不许**拿来判校区，一律问一次。只有页面的作息方案下拉框里没有这个编号、改用了页面自己选中的那一项（`mode.fallback` 为真，与学生本人相关）时，才做下面的判断：

1. 选中的作息方案名称（`#kbjcmsid` 选中项文字）只写了「西海岸」→ 西海岸；只写了「崂山」或「鱼山」→ 崂山/鱼山；
2. 课表第一行节次标签里第一个「时:分」是 `08:30` → 西海岸（只有西海岸的节次时间这样开始）。`08:00` **不当作**崂山/鱼山的证据（页面标签可能对所有校区都一样，直接信会让西海岸学生静默拿到错的上课时间），只用来和名称对质；
3. 请求的是写死的编号、或名称与时间互相矛盾、或都没有说明 → 判断不了 → extract.js 用 `__ncSelect` 问一次（标题「选择校区」，两个选项；宿主不能提问 / 用户取消 / 报错都交 null）→ 选了就按选的；没得选就按崂山/鱼山导入并提醒「教务系统没有标明校区…请在「学期管理」里核对节次时间」。

提问只出现在 extract.js，parse.js 保持纯函数。本件没有教务账号，不知道真实页面上的作息方案名称和节次标签长什么样，所以这套判断只在「走了页面选中的方案且证据明确」时才省掉提问，其余一律问。

### 6.2 课表用到第 13 节及以后（统一修订 H3）

学校公布的节次时间只有 12 节。课表用到第 13 节及以后时，在上一节下课后顺推（课间 5 分钟、每节 45 分钟），顺推越过 23:59 就停，停下的节次写进提醒（课程照常导入）。补了哪些、哪些补不了都在 warnings 里说明（fixture `period-extend`）。

### 6.3 开学日与总周数

- 开学日：周历第 1 周那一行里推出周一（上游同）；取不到按提取时刻推算最近的周一并提醒（上游是不写开学日，应用侧留空；载荷要求 `firstDay` 必填，所以推算，**并说明**）。
- 总周数：周历里最大的「第 N 周」优先（上游同）；周历没有 → 课表最大周次 → 兜底 20 周（上游兜底也是 20）；课表里有更晚的周次则抬高到它。上限 30，超过的截断并提醒。

## 7. 上游里删掉或改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `showSingleSelection` 弹窗让用户从学期列表里选（只列默认项前 3 后 3 共 7 个） | 学期取当前页面 / 课表页的下拉框选中项，不弹窗 | 公共说明第 2 条；用户在页面上切到哪一学期，导入的就是哪一学期 |
| `showSingleSelection` 每次都问校区 | 判断不了才问一次（§6.1） | 任务卡：能自动判断就不问 |
| `showAlert` 开头确认、`showToast` 进度提示、`notifyTaskCompletion` | 删除 | 脚本对页面只读；确认与进度由应用负责 |
| `saveCourseConfig`（`semesterTotalWeeks`、`firstDayOfWeek: 1`、`defaultClassDuration: 50`、`defaultBreakDuration: 10`、`semesterStartDate`） | 并入载荷的 `firstDay` / `totalWeeks` / `periodTimes` | 载荷没有时长配置这个概念，每周起始日按手册 §4 处理（本校周一起） |
| `savePresetTimeSlots`、`saveImportedCourses` | 改为载荷的 `periodTimes` / `courses` | 保存由应用负责 |
| `parseWeeks` 只读卡片里**第一段**周次（`1-8周,10-16周` 只认 1-8） | 整串周次读完，单双标记各归各段 | 上游会静默丢掉后面的周次 |
| `parseCourseItem` 读不到周次返回 null（悄悄丢课）；读不到节次默认当成第 1 节（悄悄放错位置） | 周次或节次写法认不出的卡片跳过，按类型计数并点名 | 不许静默丢课 / 猜节次 |
| `mergeAndDistinctCourses`：按整串周次相同才合并 | 沿用 nefu 的「按周拆开再合并相邻 / 重叠节次，再把节次相同的周收拢」 | 部分周调课不会被扩到整学期；同一课程同周的相邻节次仍会并成一块 |
| 星期按「第几个 `kbDataTd`」数 | 按网格列 + 表头（认不全才按列序，并提醒） | 跨行格子会让下一行少一格，按个数数会错位 |
| 课表 / 周历请求 `credentials: "include"` | `credentials: 'same-origin'` | 请求本来就同源，更窄 |
| 用 `Set`、`padStart`、`Array.from`、展开、解构、模板串、箭头函数、`async/await` 等 | 改成 ES5 | CI 的 Rhino 与 ES5 检查 |
| `fetchCalendarInfo` 的年份：`suffix === 3 ? 年+1 : 年`，候选 [年, 年+1] | 同（`yearCandidates`），并要求日期的星期几对得上 | 沿用上游口径；周历日期带年份时直接用 |

## 8. fixtures

全部为合成数据（没有真实学号、姓名）。extracted 由 `C:/Users/23703/AppData/Local/Temp/ouc-port12/gen.js` 生成（只造输入，不造期望）；expected 由 `expected.py` 里**手工推演**的字面值写出（周次切段、节次、总周数、学期名、warnings 文本都是人工推出，不是 parse.js 的输出），再与 parse.js 比对；首次跑就全部 MATCH，之后用 §9 的变异测试证明这些用例确实钉得住逻辑。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 一周七列；周二的格子 `rowSpan=2`（下一行少一格，网格靠占位对齐）；一格两门课；`1-8周,10-16周[01-02节]` 拆两段；`2-16周(双)[01-02节]` → EVEN；`3,5,7周` → ODD 3–7；教师留空 → null 并出缺教师提醒；周历给出开学日与 20 周；问过校区（崂山/鱼山）→ 无校区提醒 |
| `week-forms` | **单双标记归属**：`(单)1-8周,(双)9-16周`（前缀各归各段）→ ODD 1–7 + EVEN 10–16；`1-8周(单) 9-16周`（后缀紧挨下一段）→ ODD 1–9 + ALL 10–16；`第1-第8周`；**「共 N 周」剥离**：`1-8周(共8周),9-16周` → 1–16 不被吞；`1-15单周`；`1-16(单)周`；节次列表 `[01-02,05节]` 拆两块 |
| `week-limits` | 单双同时出现按每周并提醒；`1-35周` 截到 30 周并提醒、总周数抬高到 30 并提醒；区间写反 / 括号备注 / 第 0 周 / 缺时间字段 / 缺课名 / 节次越界各自跳过，点名只列前 5 个，计数分类汇总 |
| `merge-partial` | 同周相邻节次并成一块；只有部分周（1–8 周）相邻的合并不扩到整学期；重叠节次（1–3 + 3–4）并成 1–4；重复卡片去重 |
| `calendar-sunday-first` | 页面自己选中的作息方案，第一大节 08:30 开始 → 西海岸节次时间，不问（另有「作息方案选项和预期不同」提醒）；春季学期周历按星期日排第一列（2月22日 是星期日，周一 2026-02-23）；学期名直接用教务给的文字 |
| `campus-asked` | 页面自己选中的作息方案：名称（崂山）与第一大节时间（08:30）互相矛盾 → 判断不了 → 按用户在提问里选的西海岸校区；另有「作息方案选项和预期不同」提醒 |
| `campus-label` | 页面自己选中的作息方案，名称写了鱼山校区 → 崂山/鱼山节次时间，不问；另有「作息方案选项和预期不同」提醒 |
| `campus-const-mode` | 请求的是上游写死的作息方案：名称写了西海岸、第一大节 08:30 **也不能判校区**，按用户在提问里选的崂山/鱼山，无校区提醒 |
| `calendar-sunday-fall` | 秋季学期（2025-2026-1）周历星期日排第一列：`8月31日`、`9月1日` → 开学日 2025-09-01（不能推成下一年的 8 月 31 日）；星期四格里混进春季的 `3月5日`（星期日排第一列时星期几恰好对得上）被学期区间挡掉 |
| `calendar-conflict` | 第 1 周一行里两个日期推出不同的周一（9月1日 与 9月9日）→ 不采用，开学日按最近周一推算并提醒 |
| `header-missing` | 没有星期表头 → 按课程列从左到右当作周一…周日并提醒；周历日期写在 `title` 属性里（带年份）；页面有两张课表；作息方案编号对不上、改用页面选中项；校区没法判断且没问成 → 按崂山/鱼山并提醒 |
| `no-calendar` | 周历取不到：开学日按最近周一推算（2026-10-20 是星期二 → 2026-10-19）、总周数取课表最大周次 14 并提醒；学期名取不到用「中国海洋大学当前学期」占位；表尾两条备注点名；校区判断不了 |
| `period-extend` | 节次 11–16：第 13–15 节顺推补上（21:25–22:10、22:15–23:00、23:05–23:50），第 16 节越过 23:59 说明；学期名由代码拼出 |
| `long-name` | **带课名的提醒不超 200 字**：7 个无效上课安排（课名 33 字）点名前 5 个，整条提醒按 200 字截断（199 字 + 「…」）；4 门缺教师的长课名课点名前 3 个，课名各截到 20 字 |
| 报错（不做成 fixture） | 登录页 / 统一认证页 / 返回登录页 / 重定向到认证页，见 §9 冒烟 |

## 9. 变异测试与冒烟测试

### 9.1 变异测试

每次把整件复制到 `C:/Users/23703/AppData/Local/Temp/ouc-port12/mut-<编号>/ouc/`，在副本 parse.js 的唯一锚点上改一处，运行 check.js，记下变红的用例（脚本 `mutate.js`，锚点不唯一会拒绝执行）。真实目录没有被改动，最后用 check.js 复核仍是 `RESULT: PASS`。

| 编号 | 改坏的位置（parse.js） | 变红的用例 |
|---|---|---|
| M1 | `campusEvidence` 里 `clock === '08:30'` 的结果改成 home（08:30 当崂山证据） | calendar-sunday-first、campus-asked |
| M2 | `mondayFromRow` 的 `layouts` 只留星期一排第一列（去掉星期日排第一列） | calendar-sunday-first、calendar-sunday-fall |
| M3 | `weeksOf` 里「前缀单双括号前面紧挨数字或周时是上一段后缀」的守卫整行删掉 | week-forms |
| M4 | 「共 N 周」剥离改成 `.*$`（从「共」吞到行尾） | week-forms |
| M5 | 顺推 `EXTEND_CLASS_MINUTES` 45 → 50 | period-extend |
| M6 | `runsOf` 的 ODD / EVEN 判断对调 | basic、week-forms |
| M7 | `rangesOf` 连续判断放宽到相差 3（`[1,2,5]` 并成一块） | week-forms |
| M8 | `MAX_WARNING_TEXT` 200 → 400（超长提醒不截断） | long-name |
| M9 | `noteDropped` 的点名上限 5 → 99 | week-limits |
| M10 | 删掉 `cleaned.replace(/第/g, '')`（「第1-第8周」被拆开） | week-forms |
| M11 | 单双同时出现时只清 `onlyEven` 不清 `onlyOdd`（变成只算单周） | week-limits |
| M12 | 同周合并的相邻判断 `<= last[1] + 1` 改成 `<= last[1]`（相邻不合并） | merge-partial |
| M13 | `mondayFromRow` 里「日期的星期几必须对得上」的判断删掉 | 几乎所有带周历的用例（日期不再被星期几挡住，推出的周一乱了） |
| M14 | 校区判断去掉「只有 `mode.fallback` 为真才用名称 / 节次标签」的前提 | campus-const-mode |
| M15 | `mondayFromRow` 去掉学期区间（月份范围）判断 | calendar-sunday-fall |
| M16 | `mondayFromRow` 不再要求推出的周一唯一（返回最后一个） | calendar-conflict |

16 处全部变红，所有变异都在副本上做。

### 9.2 浏览器冒烟（`D:/NullClass/.test/port-batch12/ouc/smoke.py`）

用 Playwright 起假强智教务站（全部请求被 route 拦下，不联网），跑真实的 extract.js，再把输出交给 Rhino 跑 parse.js。`python -I -X utf8 smoke.py all` → **16/16 OK**。检查项：每个请求的主机 / 方法（只许教务主机的 GET）、课表请求的查询串与**独立拼出的上游查询串逐字相等**、周历请求恰为 `xnxq01id=2025-2026-1`、学号 / 手机号 / 身份证号诱饵不出现在请求里也不出现在 extract.js 输出里、校区判断与提问、载荷关键值、每条提醒 ≤200 字。

| 场景 | 覆盖 |
|---|---|
| `page` | 在课表页上点提取：只发 2 个请求（课表 + 周历，不再取学期）；校区判断不了 → 问一次，选崂山/鱼山 → 08:00 |
| `home` | 在教务首页（没有学年学期下拉框）：先 GET 一次课表页取学期，共 3 个请求 |
| `home-label` | 走了页面选中的作息方案、名称写了崂山/鱼山 → 不问（桥被调用 0 次），课表请求的 `kbjcmsid` 是页面选中项 |
| `const-west` | 请求的是写死的作息方案：名称写了西海岸、第一大节 08:30 也**照样问**（桥被调用 1 次），不据此判校区 |
| `west-clock` / `west-label` | 走了页面选中的作息方案：第一大节 08:30、或名称写了西海岸 → 不问，西海岸节次时间（第 1 节 08:30） |
| `ask-west` | 判断不了 → 问一次（检查提问参数：标题 ≤60 字、说明 ≤300 字、2 个选项），选西海岸 → 08:30，无校区提醒 |
| `ask-cancel` / `no-bridge` | 用户取消 / 宿主不能提问 → 按崂山/鱼山导入，并出「没有标明校区」提醒 |
| `mode-fallback` | 页面的作息方案下拉框里没有上游那个编号 → 课表请求的 `kbjcmsid` 改用页面选中项，并出提醒 |
| `no-calendar` | 周历 500 → 仍然导入，开学日推算并提醒 |
| `sso` | 停在 `id.ouc.edu.cn` 统一认证页：直接报错，**不发请求** |
| `login-page` | 教务主机上的登录页：直接报错，**不发请求** |
| `expired` | 首页取学期时拿回登录页：报「当前页面不是课表」，不再发课表请求 |
| `expired-late` | 课表请求拿回登录页：extract 交出登录标记，parse.js 报「当前页面不是课表」 |
| `redirect` | 课表请求被重定向到别的主机：报错（浏览器拦下跨域重定向时是「连不上教务系统：登录状态可能已失效」） |

另外，`readPage` 的「重定向到别的主机 → 登录已失效」分支，在 Node 桩里单独验证过（`fetch` 桩返回 `status: 200`、`url` 为 `id.ouc.edu.cn`）：报错为「登录已失效，请重新登录。…」，且只发了 1 个请求。

## 10. 与公共说明「审计真抓到过的错」逐条自查

- 单双标记归属：`weeksOf` 的前缀 / 后缀规则带守卫，fixture `week-forms` 钉住「(单)1-8周,(双)9-16周」与「1-8周(单) 9-16周」，M3 变红。
- 区间终点前带「第」：`第1-第8周` 先去掉全部「第」，fixture `week-forms` 钉住，M10 变红。
- 提醒里的词：不出现「适配器」「内置」「作息表」「空课默认作息」；统一叫「节次时间」；改学期信息写「学期管理」；补教师 / 教室写「对应课程的「编辑课程」」。
- 「共 N 周」备注：只剥备注本身（`/共\s*[0-9]+\s*周?/g`），fixture `week-forms` 钉住，M4 变红。
- 带课名的提醒限长：课名截 20 字，整条经 `pushWarning` 截到 200 字；fixture `long-name` 钉住，M8 变红。
- AUDIT 行号漂移：本文不引用行号，按函数名指代。
- 模板残留：全目录搜过（东北林业、nefu、jwxt、本部、燕山、yssdufe），代码、manifest、给学生看的文字里一处都不剩；本文里提到 nefu / yssdufe 的地方是有意的说明。
- 同一份响应的外壳只定义一次：R2 响应由 `weeklyTablesOf` 统一取表（"有没有表"与"挑哪张表"共用同一份结果）；周历由 `calendarOf` 统一取表。

## 11. 已知风险、未验证项

- **没有本校账号，真机没验过。** 上游脚本只被读过、未在本校页面上运行。课表卡片的类名（`tr.qz-weeklyTable-tr`、`td[name=kbDataTd]`、`li.courselists-item`、`.qz-hasCourse-title`）、下拉框 id（`xnxq01id`、`kbjcmsid`）都是按上游代码的判据写的，没有对照真实页面 HTML；`timeTd`（节次标签）、`thead` 星期标题、`tfoot .qz-weeklyTable-detailtext` 备注是照同族已审计件 nefu 的写法，本校页面是否同样需要真机核对。
- **卡片字段的写法**（「老师:…;时间:…;地点:…」，时间串 `周次[节次节]`）取自上游的正则；上游只读第一段周次，本件整串读，多段周次的真实写法（逗号、空格、括号）没有样本，已按手册和同族件的常见写法兜住，认不出的卡片会跳过并点名，不会静默放错。
- **教学周历页没有样本。** 按上游的解析逻辑写（每行「第 N 周」标签格 + 后面依次星期一…日、找「M月D日」格），星期日排第一列、`title` 里带年份的日期是额外兜底，日期要落在学期区间里且各种组合推出的周一唯一才采用（否则推算并提醒）；本校周历页结构未核对。取不到时有兜底，但兜底的开学日是**推算值**，会在提醒里说明。
- **校区判断**：请求用的是上游写死的作息方案时一律问一次（与上游行为相同，名称和节次标签对所有人都一样，不能当证据）；只有走了页面选中的方案、且名称只写一边校区或第一大节 08:30 开始，才省掉提问。该分支在真实页面上是否会出现、名称长什么样都未知。不能问 / 取消按崂山/鱼山导入并提醒。
- **作息方案编号 `16FD8C2BE55E15F9E0630100007FF6B5` 是上游写死的。** 页面下拉框里没有这个值时改用页面选中项并提醒；如果下拉框不存在（读不到选项），仍用上游的值。返回页里作息方案选中值与请求不同时也提醒。
- **`zc` 参数。** 照上游 `zc=` 空值（整学期）；返回页没有周次下拉框的核对，如果教务只返回当前周的课表，会漏课——这一点需要真机核对。
- **校外访问。** 上游 description 要求使用校园网络登录；本件没有 WebVPN 路径适配（`loginUrl` 就是上游的 `id.ouc.edu.cn` 单点登录地址，请求都是同源相对路径，经 WebVPN 打开时主机检查会不通过）。校外学生需要先连校园网 / VPN，未做适配。
- **节次时间是上游写死的两张表。** 校区判断错了会让上午前四节的时间整体偏 30 分钟（西海岸）；学生应到「学期管理」里核对。第 13 节起的顺推时间是推算值，已提醒。
- **一次只处理第一张周课表。** 页面若同时有多张（例如不同视图），只导入第一张并提醒；与上游一致。
- **卡片文字限 400 字。** 超长卡片会被截断，截断后字段读不全的会作为「写法没认出」跳过并点名，不会静默放错。
- **研究生、其他入口不在范围内。**

## 12. 签名

0x7E7-2023（sonnet 移植，2026-10-20）
