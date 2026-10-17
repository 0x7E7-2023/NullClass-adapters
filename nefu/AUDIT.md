# 东北林业大学（nefu）移植审计

本文件记录移植件的来源、请求与读写面、手册 §5 八条的逐条结论、与模板件的差异、删掉的上游逻辑、fixtures、变异测试与未验证项。
这里的每一条声明都对应当前代码；没有核对的地方写在 §10。

## 1. 来源（provenance）

- 上游仓库：https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT）
- 上游文件：`resources/NEFU/nefu.js`，上游作者（adapters.yaml 的 maintainer）Chr0n0stasis。
- 上游同目录 `resources/NEFU/adapters.yaml`：adapter_id `NEFU_01`，adapter_name「东北林业大学本部本科生院」，import_url `https://jwxt.nefu.edu.cn/jsxsd/`，maintainer `Chr0n0stasis`。
- 上游快照：`1dc0772566ba610f495906410734db4e7b8ef0c1`（2026-10-17）。本校脚本最后一次修改：`247e1e1`（2026-09-28）。
- 本件只管**本部本科生个人课表**（上游的 `xskb_list.do` 课表页与其三个下拉框），不处理研究生、其他校区或其他入口。
- 平台：强智科技「教务管理系统」新版界面，学生端 `/jsxsd/`。课表是 `table.qz-weeklyTable`，与模板件 yssdufe 的老界面（`#kbtable` + `div.kbcontent`）**不同构**，本件按上游重写（见 §6）。
- 移植者：0x7E7-2023（haiku 移植，2026-10-17）。

## 2. 请求表

extract.js 里有两处 `fetch(` 字面量（`getPage` 与 `postCalendar`），一次提取最多发出下面三个请求。路径都是页面同源的相对路径，`credentials: 'same-origin'`，不写 `Authorization` 或 Cookie。

| # | 方法 | 路径 | 请求体 | 何时发 | 作用 | 取不到时怎么办 | 上游对应 |
|---|---|---|---|---|---|---|---|
| R1 | GET | `/jsxsd/xskb/xskb_list.do?viweType=0` | 无 | 每次提取 | 读默认学期、作息模式（找「本部」）、周次下拉框 | 状态码非 2xx / 跳到别的主机 / 连不上 → 报错（大白话）；页面没有学期或作息下拉框，或是登录页 → 报错「请先在页面里登录…」 | `metadata()`（上游 `viweType` 拼写照抄） |
| R2 | GET | `/jsxsd/xskb/xskb_list.do?viweType=0&xnxq01id=<学期>&kbjcmsid=<作息模式>&zc=` | 无 | R1 之后 | 拿指定学期、作息模式、整学期（周次空）的课表 | 同上报错；返回页的三个下拉框选中值与请求不一致 → 报错「对不上」；课表表格不是唯一一张 → 报错 | `requestCoursePage()` 的 GET 等价形式（`zc` 空 = 整学期） |
| R3 | POST | `/jsxsd/jxzl/jxzl_query` | `xnxq01id=<学期>`（`encodeURIComponent`） | R2 之后，**本件新增** | 教学周历：开学日期与总周数 | 取不到、状态码错、解析失败 → 交 null，由 parse.js 用兜底口径并提醒，**不致命** | 上游没有取周历；请求体与模板件 yssdufe 的 `requestSemesterDetailPage()` 一致 |

- 三个请求的请求体只含学期代码（来自页面的选中项）、作息模式的值（来自页面选项）和空的周次。不带学号、姓名、令牌，不读任何本地存储。
- 上游 `requestCoursePage` 与本件的区别：上游的学期由用户在弹窗里选；本件取页面默认选中项，不弹窗（§7）。
- 没有任何请求指向 `jwxt.nefu.edu.cn` 之外的主机。`readPage` 对响应的 `response.url` 做了主机检查：被重定向到别的主机（通常是统一身份认证页）时报「登录已失效」。

## 3. 端口与 allowHosts

- `manifest.json` 的 `allowHosts` 为 `["jwxt.nefu.edu.cn"]`，只有一个精确主机名，**没有通配**。
- 上游的 URL 里没有写端口。`loginUrl` 为 `https://jwxt.nefu.edu.cn/jsxsd/`，与上游 `import_url` 一致。
- 请求用相对路径，脚本里只有上面三个路径字面量，主机由页面本身决定。`run()` 开头还检查 `window.location.host` 必须是 `jwxt.nefu.edu.cn`，否则直接拒绝执行（上游 `WRONG_ORIGIN` 的同一判据）。
- 静态扫描（手册 §5 的两条命令）：URL 主机只有 `https://jwxt.nefu.edu.cn`（在 `manifest.json` 与注释里）；`fetch(` 两处字面量，全部是同源相对路径；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。

## 4. 读取面与输出面

### 4.1 extract.js 读了什么

- 页面的 `window.location.host`（只用来判断是否在本校主机上）、`window.location.protocol` / `host` / `pathname`（只用于 `pageUrl`）。
- 三个课表页（R1、R2）的 DOM，只读取：`#xnxq01id`、`#kbjcmsid`、`#zc` 三个下拉框的 `value` 与选项的 `value`、文字；`table.qz-weeklyTable`（全部，数量交给 parse.js 判断）的 `thead` 第一行、`tbody` 的所有行、`tfoot .qz-weeklyTable-detailtext` 的文字；课程格子里 `ul[name="kbdataUl"]` 的 `kbdatasize` 属性与子元素（`li.courselists-item` 的结构、`.qz-hasCourse-title` 课名、`.qz-hasCourse-abbrinfo` 的详情文字）。
- 登录判断：只看 `#userAccount` / `#userPassword` 这两个元素**是否存在**，以及页面标题是否含「登录」二字。**不读它们的值**。
- 教学周历页（R3 的响应）：先找 `#kbtable`，找不到就找第一个 `td[title]` 含「2026年09月07日」这类日期的表；读其中每一行的每个格子的 `rowspan`、`colspan`、文字与 `title` 属性。

### 4.2 extract.js 交出去什么（逐字段，即 parse.js 的全部输入）

| 字段 | 类型 | 内容 | 来源 |
|---|---|---|---|
| `source` | 字符串 | 固定 `"qz-jsxsd"` | 常量 |
| `pageUrl` | 字符串 | 协议 + 主机 + 路径，**不含查询串** | `window.location` |
| `now` | 字符串 | 提取时刻的本地日期 `yyyy-MM-dd`（不用 `toISOString`） | `Date` |
| `loginForm` | 布尔 | 登录表单元素是否存在（不读值） | R2 响应的文档 |
| `loginTitle` | 布尔 | 页面标题是否含「登录」（标题原文**不交出**） | R2 响应的文档 |
| `request` | 对象 | `{ xnxq01id, kbjcmsid, zc }`：本次实际请求的三个参数（周次为 `""`） | 提取流程 |
| `selects.xnxq01id` / `kbjcmsid` / `zc` | 对象或 null | `{ selected: 选中值, options: [{ value, label }] }`；下拉框不存在为 null | R2 响应的文档 |
| `tables` | 数组 | 每张 `table.qz-weeklyTable` 一项：`{ head, body, foot }` | R2 响应的文档 |
| `tables[].head` | 数组 | 表头第一行每格的 cell（见下） | `thead` 第一行 |
| `tables[].body` | 数组的数组 | 每行的 cell（`tbody` 的 `tr` 子元素，按 tbody 顺序拼接） | `tbody` |
| `tables[].foot` | 字符串数组 | 表尾备注文字（空白归一） | `tfoot` |
| `cell.name` | 字符串 | `name` 属性（`timeTd` / `kbDataTd` / 其他 / 空） | td/th |
| `cell.rowSpan` / `colSpan` | 整数 | HTML 上的跨行跨列数（没有或不是数字为 1，**0 原样交**，由 parse.js 报错） | td/th |
| `cell.text` | 字符串 | 格子文字（空白归一） | td/th |
| `cell.lists` | 数组 | 格子里所有 `ul[name="kbdataUl"]`：每个 `{ size, items }` | 格子内 ul |
| `lists[].size` | 字符串或 null | `kbdatasize` 属性原文，没有为 null | ul |
| `lists[].items` | 数组 | ul 的每个子元素：`{ course, title, abbr }` | ul 的子元素 |
| `items[].course` | 布尔 | 是否 `li.courselists-item` | 子元素 |
| `items[].title` | 字符串 | `.qz-hasCourse-title` 的文字，没有为 `""` | 卡片 |
| `items[].abbr` | 字符串 | `.qz-hasCourse-abbrinfo` 的文字（「老师:…;时间:…;地点:…」），没有为 `""` | 卡片 |
| `calendar` | 对象或 null | `{ rows: [[{ rowSpan, colSpan, text, title }]] }`；周历取不到为 null | R3 响应的文档 |

**输出面（应用拿到的载荷）**：parse.js 的输出只含 `specVersion`、`kind: "schedule"`、`ocrAssisted: false`、`warnings`、`terms[0]`（`name`、`firstDay`、`totalWeeks`、`courses`，节次时间能推全时还有 `periodTimes`）。课程的 `name`、`teacher`、`location`（即 `position`）都来自课表卡片；没有 UUID、时间戳、颜色或学号。

**学号、姓名、人员 ID 的去向**：课表页与周历页本身不要求这些字段，extract.js 也**不读**页面上的个人信息区域（只按上面的选择器取课表与下拉框）。如果教务页面的课表格子里偶然带了学号，它会作为 `cell.text` 的一部分随 `tables` 进入 parse.js 的内存，但 parse.js **不把格子的整段文字写进输出**，只取课名、老师、时间、地点四个字段。

## 5. 手册 §5 安全审计八条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | extract.js 不读账号、密码的值；登录表单只判断 `#userAccount` / `#userPassword` 是否存在。请求只声明 `credentials: 'same-origin'`，会话由浏览器附带，脚本读不到也不转发。check.js 的词法提示「password 字样」命中的正是 `getElementById('userPassword')` 这个存在性判断，不是读值。 |
| 2 | 不外发 | 通过 | `fetch(` 两处字面量，都是同源相对路径；没有 XHR、sendBeacon、WebSocket，也没有图片 src 赋值。 |
| 3 | 请求域可控 | 通过 | `allowHosts` 只有 `jwxt.nefu.edu.cn`，没有通配；`run()` 开头检查页面主机，`readPage` 检查重定向目标主机。 |
| 4 | 只读课表 | 通过 | 三个请求都是学生端课表页（R1、R2）与教学周历（R3）；不请求成绩、学籍、缴费、个人信息或选课页面。 |
| 5 | 不埋点 | 通过 | 没有统计、上报或遥测代码。 |
| 6 | 不 eval 远程代码 | 通过 | 两个文件都没有 `eval` 与 `new Function`；check.js 的词法扫描为通过。 |
| 7 | 不写页面 | 通过 | extract 只读页面与离线文档（`DOMParser`）；没有 innerHTML 赋值、appendChild、表单提交或 value 赋值。上游的 `showToast`、`showSingleSelection`、`notifyTaskCompletion`、`saveImportedCourses` 等界面与保存调用已删（§7）。 |
| 8 | 不依赖秘密 | 通过 | 没有硬编码的密钥、令牌或学号；学期与作息模式的值都来自页面。 |

## 6. 与模板件（yssdufe）的差异

本件的结构骨架参照 yssdufe，但**课表解析层**按上游 `nefu.js` 重写，因为两者的课表 DOM 完全不同：

| 层 | 模板 yssdufe | 本件 nefu |
|---|---|---|
| 课表容器 | `#kbtable`，格子 `div.kbcontent`，教师教室在 `font[title]` 里 | `table.qz-weeklyTable`，卡片 `ul[name="kbdataUl"] > li.courselists-item`，课名 `.qz-hasCourse-title`，详情 `.qz-hasCourse-abbrinfo`（「老师:…;时间:…;地点:…」） |
| 课表请求 | POST `/jsxsd/xskb/xskb_list.do`（请求体含 `jx0404id` 等） | GET `/jsxsd/xskb/xskb_list.do?viweType=0[&xnxq01id&kbjcmsid&zc]`（上游 `viweType` 拼写照抄） |
| 学期来源 | 教学周历页的选中项 + 课表页屏幕那份 | 课表页自己的 `#xnxq01id` 选中项（同一页面，不另取） |
| 作息 | 11 节统一表（内置 `SLOT_TIMES`） | **不内置** 11 节表，由每大节行标签推出（§6.1）；推不全时：课表最大节次 >12 交内置 12 节 + 顺推，否则不交 |
| 星期 | 按 td 的网格列号 + 表头启发式（允许 7 列 / 8 列表头、找不到表头时按最右 7 列推断） | 表头必须 8 格、`星期一…星期日`（或周一…周日）各一次、无合并，否则报错；**不做启发式** |
| 卡片容错 | 按块计数跳过 | 按卡片计数跳过（同），结构问题整体报错（上游的做法） |
| 教学周历 | 同 | 同（周历的解析与兜底逻辑照抄模板，见 §6.2） |

### 6.1 节次时间的推法（新增，上游不导入作息）

行标签 `第一大节 (1、2小节) 08:00~09:35` 中：小节号 `[1,2]`，起止 `08:00`–`09:35`。

- 一行 n=1 个小节：这一节就是 `S–E`；
- n≥2：`p = floor((E−S−5×(n−1))/n)`，第 i 节（从 0 数）开始 `S + i×(p+5)`，结束为开始 + p，**最后一节的结束改成 E**；
- 推不出来 → 节次时间**推不全**，分两种：
  - 课表最大节次 ≤12：整张节次时间**不交**（应用用默认节次时间）并提醒；
  - 课表最大节次 >12：改交**空课内置 12 节**（数值照抄 haut 的 `BUILTIN_PERIOD_TIMES`，即 `:core:model` 的 `DefaultPeriodTimes`），第 13 节起按补时间循环顺推：上一节下课 + 课间 5 分钟为开始、每节 45 分钟，**越过 23:59 就停**，停下的节次写进提醒（课程照常导入）。
  - 推不出来的原因：行标签没写时间、同一小节号出现在两行、小节号不连续覆盖 1..最大节、p < 20 分钟。
- 推得出来 → 提醒「每大节内的小节时间是按课间 5 分钟推算的，请在「学期管理」里核对」（只有存在多小节的大节才提醒）。
- 补上的时间都要说清：「节次时间没能读全，第 1–12 节改用空课默认的节次时间（不是教务给的）」；「课表用到了第 13–14 节，这几节没有时间，已按第 12 节下课后课间 5 分钟、每节 45 分钟顺推补上」。

### 6.2 开学日与总周数（照模板 yssdufe）

- 开学日：① 周历第 1 周那一行的「星期一」格的日期（`td[title]`，「日」字可有可无）；② 周历里第一个带日期的格子，星期日则顺延一天、其它对齐到所在周的周一；③ 都没有，按提取时刻推算最近的周一。②③ 都提醒。
- 总周数：周历给出的周号最大值优先；周历没有 → 周次下拉框里最大的数字选项；再没有 → 课表最大周次；最后兜底 20 周。课表里有更晚的周次则抬高到它。上限 30，超过的截断并提醒。

## 7. 上游里删掉或改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `showSingleSelection` 弹窗让用户从学期列表里选 | 学期取页面默认选中项，不弹窗 | 手册与模板约定：学期取页面选中项（yssdufe 的做法）；少一次交互；与「本部、当前屏幕所见一致」一致 |
| `showToast`、`notifyTaskCompletion`、`saveImportedCourses` | 删除 | 脚本对页面只读；保存与提示由应用负责（应用只接收载荷） |
| 提醒「仅导入课程，保留原有作息和学期设置」 | 删除，改由 parse.js 给出本件自己的提醒 | 本件会交节次时间（能推全时，或推不全时的内置 12 节 + 顺推），这句提醒不再成立（§8 的规定） |
| `scheduled-empty`：一门课都没有时仍提交空课表 | 报错（「本学期没有解析到任何课程…」） | 批次五的教训：空学期会把本地同名学期清空（yxhmc/jxust 的同类问题）；有上课安排被跳过时报错会点名 |
| 一张坏卡整次失败（`BAD_CARD` 等） | 单张卡跳过、计数、点名（最多 5 个） | 任务卡要求：单张卡片坏了不整表失败；结构问题仍整体报错 |
| 周次上限 60（`numbers(match[1], 60)`） | 解析到 60，但超过 30 的周次截掉并提醒 | 载荷规范的周次上限是 30 |
| 作息：上游不导入 | 由行标签推出（§6.1） | 应用需要节次时间才能画出课表 |
| 登录时 `ORIGIN` 检查（`WRONG_ORIGIN`） | 保留为 `window.location.host` 检查 | 与上游一致（不是删除，列在这里是为了说明检查的对象是页面主机） |
| 表尾备注（`remarks`）的提醒文字「请另行核对」 | 改为点名（最多 3 项）的提醒，并说明没有导入 | 任务卡要求；不伪造课程时间 |
| 用 `Set`、`Map`、`Array.from`、展开、解构、`for…of`、箭头函数、模板串等 | 改成 ES5（对象字典、循环） | CI 的 Rhino 与 ES5 检查 |

## 8. fixtures

全部为合成数据（没有真实学号、姓名）。extracted 由 `C:/Users/23703/AppData/Local/Temp/nefu-port/gen-fixtures.js` 生成（只造输入，不造期望）；expected 按规范与代码逻辑**手工推演**后写入，再与 parse.js 输出比对。

| 用例 | 覆盖什么 | 本校专属边界 |
|---|---|---|
| `basic` | 一周七列；`timeTd` 的 `rowSpan=2`（周一格跨两行，第二行少一格，网格靠占位对齐）；一格两门课；`1-5,7-8周[1-2节]` 拆两段 ALL；`2-16周(双)[1-2节]` → EVEN；大节行标签推出 08:00–08:45 / 08:50–09:35、10:00–10:45 / 10:50–11:35、14:00–14:45；教师留空 → null；周历给出开学日与周数 | 边界 1 |
| `week-forms` | `1-15单周[3-4节]` → ODD；`2-16周(双)[5-6节]` → EVEN；`1-16单周(双)[1-2节]` 单双矛盾跳过并点名；`1-16周[1-2,5节]` 拆成 1–2 与 5–5 两块；`1-35周` 截到 30 周并提醒；总周数由周历 20 被课表 30 抬高并提醒 | 边界 2 |
| `merge-partial` | 同课同周的 1–2 节与 3–4 节两张卡并成 1–4 节；只有部分周（1–8 周）相邻的合并不扩到整学期（9–16 周仍是 3–4 节）；`10:00~11:36` 的非整除时间（最后一节结束改成 11:36） | 边界 3 |
| `fallback-no-calendar` | 作息下拉框没有「本部」→ 用当前值并提醒；表尾两条备注 → 点名提醒；周历取不到 → 开学日按最近周一推算并提醒；总周数用周次下拉框最大值 20 并提醒；学期名由代码拼出 | 边界 4 |
| `time-missing` | 大节行标签没写时间 → 节次时间推不全；课表最大节次 14 > 12 → 交内置 12 节 + 第 13–14 节顺推（22:05–22:50、22:55–23:40），两条提醒；`[15节]` 不在作息表里 → 跳过并点名 | 边界 5（节次时间缺失 / 超过 12 节，H3 补齐） |
| 报错（不做成 fixture） | 表头只有 7 格 → 在临时目录造输入（由 `basic.extracted.json` 删掉末尾一格表头），用 RhinoRun 单跑 | 结构错误 |

报错用例的输出（RhinoRun 的 `__RHINO_ERROR__` 行）：`Error: 课表表头和预期不一样：必须能明确认出星期一至星期日`。
输入要点：`tables[0].head` 只有 7 格（星期一…星期日的前 7 格），其余与 `basic` 相同。

## 9. 变异测试

每次把整件复制到 `C:/Users/23703/AppData/Local/Temp/nefu-port/mut-<编号>/nefu/`，在副本的 parse.js 唯一锚点上改一处，运行 check.js，记下变红的用例。真实目录的 parse.js 没有被改动。

| 编号 | 改坏的位置（parse.js） | 变红的用例 |
|---|---|---|
| M1 | `weeks[i] % 2 !== (parity === '单' ? 1 : 0)` 改为 `… ? 0 : 1`（单双过滤方向反了） | basic、week-forms（共 2 个） |
| M2 | `slotStart = start + i * (each + BREAK_MINUTES);` 改为 `… (each + BREAK_MINUTES - 1);`（课间少算 1 分钟） | basic、week-forms、merge-partial、fallback-no-calendar（共 4 个） |
| M3 | 同周区间合并 `intervals[ii2][0] <= last[1] + 1` 改为 `<= last[1]`（不再合并相邻节次） | merge-partial（1 个） |
| M4 | 删掉单双矛盾判断 `if (m[2] && m[3] && m[2] !== m[3]) return { error: 'parity' };` | week-forms（1 个） |
| M5 | `var slotEnd = i === count - 1 ? end : slotStart + each;` 改为 `slotStart + each`（最后一节不改成 E） | merge-partial（1 个；`10:00~11:36` 的非整除用例才能钉住，首版的整除用例钉不住） |
| M6 | 周次上限 `if (weeks[i] > MAX_WEEK) {` 改为 `> 99`（超 30 周不截） | week-forms（1 个） |
| M7 | H3 补时间循环 `for (var fp = DEFAULT_SLOT_COUNT + 1; fp <= tableMaxSection; fp++) {` 改为 `for (var fp = 0; fp < 0; fp++) {`（去掉 13 节起的顺推） | time-missing（1 个；课程的第 13–14 节将没有时间，输出与期望不符） |
| 结构 | 表头 7 格 | 报错（见 §8），不是 fixture 变红 |

所有变异都在副本上做，真实目录的 parse.js 未被改动。

## 10. 已知风险、未验证项

- **没有本校账号，真机没验过。** 上游脚本只被读过、未在本校页面上运行。课表卡片的类名（`li.courselists-item`、`.qz-hasCourse-title`、`.qz-hasCourse-abbrinfo`、`ul[name="kbdataUl"]`）、`kbdatasize` 属性、三个下拉框 id，都是按上游代码的判据写的，没有对照真实页面 HTML。
- **教学周历页（R3）没有样本。** 按模板件 yssdufe 的周历结构（`#kbtable`、`td[title]` 日期）写的；本校的周历页结构未核对。取不到时有兜底（不致命），但兜底的开学日是**推算值**，会在提醒里说明，请用户核对。
- **请求的 `zc` 参数与周次回显（已知风险）。** 按上游 `requestCoursePage()` 的 `zc=` 空值照搬，parse.js 保留上游的回显校验：返回页的 `#zc` 选中值与请求不一致即整体报错。若教务回显的周次不是空串，导入会失败（不会静默错误）。需要真机核对。
- **作息模式的文字。** 上游只认「本部」这个文字；没有就用当前选中项并提醒。真机上选项文字若写成「本部校区」之类，会走提醒分支，不影响解析，但节次时间会按当前模式的行标签推。
- **节次时间是推算的。** 行标签的起止时间是大节的，小节时间按课间 5 分钟均分（§6.1）。学生应到「学期管理」里对照教务系统核对。
- **H3 的补齐（已按主调度口径实现，有一处边界）。** 节次表的前 12 节来自行标签；节次时间整张推不出、且课表最大节次 >12 时，交出空课内置 12 节，第 13 节起顺推（§6.1）。顺推越过 23:59 的节次没有补上时间，课程照常导入并点名提醒。节次时间由行标签推出时，课程卡片的节次必须落在行标签里（否则跳过并点名），「课程节次超出已交的时间表」不会发生；只有走默认 12 节 + 顺推、且顺推越过 23:59 时才会出现没有时间的节次（应用里画不出这几节的课），这一情况已出提醒。
- **同课合并的口径。** 同名、同老师、同地点、同星期的卡片按周拆开再合并（上游 `mergeCourses` 的口径）。同一门课（同名、同老师）若在两个不同地点上（例如一周在 A 楼、另一周在 B 楼），会得到同一门课下的两条 block（地点是 block 的字段），不会被合并成一条。
- **extract.js 的 `tables` 没有过滤。** 所有 `table.qz-weeklyTable` 都交出去，数量由 parse.js 判断（不是恰好一张就报错）。页面如果同时有两张课表（例如「本学期」与「下学期」并排），会整体报错而不是猜。
- **上游快照一致性。** 依公共说明，本批次三份脚本已与上游 `1dc0772` 逐字核对一致（只差行尾 CRLF）；本件只读了快照里的 `NEFU/nefu.js` 与 `adapters.yaml`，未另行 diff。

## 11. 签名

0x7E7-2023（haiku 移植，2026-10-17）
