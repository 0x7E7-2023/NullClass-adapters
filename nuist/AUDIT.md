# 安全审计 —— nuist（南京信息工程大学教务）

- 上游：`shiguang_warehouse` 的 `resources/NUIST/nuist.js`（MIT，上游作者 `wild0408`）
  <https://github.com/XingHeYuZhuan/shiguang_warehouse>
- 上游快照：`ff72d1f`（2026-10-08，只读引用，未改动上游）
- 移植者：0x7E7-2023（haiku 移植，2026-10-08）
- 审计结论：**通过（静态与合成 fixture 层面）**。请求域只有本校教务主机，四个 POST 之外没有其它网络行为，不碰凭据、不埋点、不写页面。接口字段名与 403 行为尚未在真机核实，见第七节。

## 一、请求了哪些域、哪些接口

**只有一个域：`jwxt.nuist.edu.cn`（即 manifest 的 `loginUrl` 主机）。** 脚本里写的是绝对地址 `https://jwxt.nuist.edu.cn/jwapp/sys/wdkb/...`，没有其它主机（上游是相对路径，改动理由见第五节）。

| 顺序 | 接口（路径，前面都是 `https://jwxt.nuist.edu.cn`） | 方法与请求体 | 取不到（网络错误、非 2xx、非 JSON）时 |
|---|---|---|---|
| 1 | `/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do` | POST，请求体为空 | 任何失败（含 403）都按「学期编号本机日期推算」处理，`source` 记为 `guess`，`parse.js` 写入 warnings；随后的课表请求会以 403 报出原因 |
| 2 | `/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do` | POST，`XNXQDM=<学期编号，encodeURIComponent>` | 整次提取失败。403 给出「请在页面里点开一次「我的课表」」的提示；先判 `extParams.code` 不为 1 时抛出教务返回的 `msg`（没有 rows 也照样报，没有 `msg` 时用「教务系统未发布该学期课表。」）；再判没有 rows 时提示「没能读到课表数据」；返回的不是 JSON 时提示登录可能已失效 |
| 3 | `/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do` | POST，`XN=<学年>&XQ=<学期>`（编码后） | 交空数组，`parse.js` 按最近的周一推算开学日、按课表推算总周数，并写入 warnings |
| 4 | `/jwapp/sys/wdkb/modules/jshkcb/jc.do` | POST，请求体为空 | 交空数组，`parse.js` 回落本校 12 节内置作息，并写入 warnings |

- 四个请求**顺序执行，不并发**。
- 请求头：`Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`X-Requested-With: XMLHttpRequest`；`credentials: 'include'`（携带 WebView 里已有的本校教务会话 Cookie，与上游一致）。
- 没有请求 `xnxqcx.do`（学期列表，上游用于弹窗选学期；移植件不做选学期交互）。
- 没有请求任何学籍、成绩、个人信息接口，没有 `cxxsjbxx.do`（学号不需要，接口按会话身份取数）。

## 二、读了什么、交出什么

- **读的接口数据**：`datas.dqxnxq.rows` 的 `DM` / `MC`；`datas.cxxszhxqkb.rows` 的排课字段（`KCM`、`SKXQ`、`KSJC`、`JSJC`、`SKZC`、`SKJS`、`JASMC`、`XXXQDM_DISPLAY`）；`datas.cxjcs.rows` 的 `XQKSRQ` / `ZZC`；`datas.jc.rows` 的 `DM` / `KSSJ` / `JSSJ`；各接口的 `extParams.code` / `msg`。
- **不读**：页面 DOM（上游读的 `#dqxnxq2` 已删除）、`localStorage` / `sessionStorage` / `document.cookie`、表单、成绩、学籍、缴费、个人信息。
- **交给 parse.js 的载荷**：`term`（`code`、`name`、`source`）、`today`（本机日期，`yyyy-MM-dd`）、`rows`、`calendarRows`、`timeSlotRows`。三张表都只保留白名单字段（课程行 8 个、校历 4 个、节次 3 个），学号、姓名等个人信息不带出去。
- 脚本不写入任何存储，不保存令牌，不外发任何数据。

## 三、手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。脚本里没有 password、pwd、登录表单，没有读写 localStorage 令牌；只靠 WebView 现有会话（`credentials: 'include'`）请求本校教务主机，不外发。 |
| 2 | 不外发 | 通过。全部网络行为是第一节的四个 POST。无 `sendBeacon`、`WebSocket`、`EventSource`、`new Image`。 |
| 3 | 请求域可控 | 通过。四个请求都是绝对地址，主机均为 `jwxt.nuist.edu.cn`，即 `loginUrl` 主机，所以 `allowHosts` 为 `[]`。无通配。 |
| 4 | 只读课表 | 通过。四个接口分别是学期、课表行、校历（开学日与总周数）、节次时间，都是取课表所必需。没有成绩、学籍、个人信息、缴费接口。输出剔除 `XH` / `XM`。 |
| 5 | 不埋点 | 通过。无统计、上报、遥测，无第三方域名。 |
| 6 | 不 eval 远程代码 | 通过。无 `eval`、`new Function`，无动态 `import`，无注入 `<script>`。脚本自包含。 |
| 7 | 不写页面 | 通过。不读也不写 DOM（上游的 `#dqxnxq2` 读取已删除）；无 `innerHTML`、`appendChild`、表单赋值、`submit`、点击。取数全走接口。 |
| 8 | 不依赖输入之外的秘密 | 通过。无硬编码学号、令牌、密钥。学期编号来自接口，或由 extract 按本机日期推算（推算会写进 warnings）。 |

`check.js` 对 `extract.js` 的静态扫描（`sendBeacon` / `WebSocket` / `new Image`、绝对 URL 的主机）与 `parse.js` 的纯函数检查（无 `fetch`、`XMLHttpRequest`、`document.`、`window.`）均通过。

## 四、与模板（niit）的差异

模板是 `jw-adapters/niit/`，移植自上游 NIIT 脚本。本件在模板基础上改了以下各项：

1. 请求地址：模板与本件都是绝对地址，主机不同。模板是 `https://jwxt.niit.edu.cn/...`，本件是 `https://jwxt.nuist.edu.cn/jwapp/sys/wdkb`（上游是相对路径，见第五节）。`allowHosts` 都是 `[]`。
2. 错误处理：模板的 `postJson` 把 403、非 2xx、非 JSON、网络错误一律收敛成 `null`，丢失了 403 的原因。改为：403 抛出明确提示；其它错误抛出 HTTP 状态或登录失效提示；只有可降级的请求（学期、校历、节次）在调用处捕获并降级。
3. 取数键名：模板的 `rowsOf` 先按已知键取，再「取第一个带 rows 的键」兜底，可能取错表。改为按接口的精确键取（`dqxnxq`、`cxxszhxqkb`、`cxjcs`、`jc`）。
4. 学期来源：模板优先读页面 `#dqxnxq2` 的 DOM 值。删除该读取；学期只从 `dqxnxq.do` 取，失败按推算处理。
5. 挂钟依赖：模板的 `parse.js` 在推算开学日时读取本机时间（`currentMondayIso`）。改为 extract 交来 `today`，`parse.js` 只看这个值，不读挂钟时间，fixture 因此可以复现。
6. 校历接口：模板用 `cxxljc.do`，改为上游 NUIST 使用的 `cxjcs.do`（带 `XN` / `XQ` 参数）。
7. 作息：模板硬编码 11 节。改为优先用 `jc.do` 的节次时间，取不到或不合法时回落到上游 NUIST 的 12 节。
8. 节次时间校验：模板没有服务端节次时间可校验。改为接受 `0800` 与 `08:00` 两种写法，统一成 `HH:mm`；节次号须从 1 起连续，结束须晚于开始；任一行不合法则整表回落并写入 warnings。
9. 周次上限：模板对超限周次逐周计入 `droppedWeeks`，全部超限的行还计入 `skipped`，同一行重复计数。本件只计入 `droppedWeeks`（按周计），全部超限的行不计入跳过数。
10. 总周数越界：模板对 `ZZC` 越界静默忽略。改为 clamp 到 30 并写入 warnings。注意派工单字面要求 clamp 周次，本件对周次本身采用丢弃（见第五节「对派工单的偏离」）。
11. 复合键：模板用 `name + '\u0000' + teacher` 作为分组键。改为 `JSON.stringify([name, teacher || ''])`，不使用控制字符。
12. 教室：模板只取 `JASMC`。改为「教室（校区）」；只有校区则用校区名；都没有是 `null`。
13. 教师：模板保留 `SKJS` 原文（`text(row.SKJS) || null`），不拆分。本件按 `/ 、 , ， ; ；` 拆开，丢掉空片段与含数字的片段（教务 SKJS 常写成「姓名/工号」，工号不算教师），去重后以「、」连接；拿不到是 `null`。
14. 学期名兜底：模板依次取 `term.name`、由学期编号推导，只有编号格式不对时才用「教务导入」。本件依次取 `term.name`、「南京信息工程大学 + 学年学期」（如 `南京信息工程大学 2026-2027学年第一学期`）。
15. 警告：模板已有五类提示（学期推算、开学日推算、周数与校历不符、跳过、周次丢弃），并非只有一条总括提示。本件在此基础上新增总周数推算、总周数超 30 clamp、节次回落、节次超表四类，固定顺序，见 `parse.js`。

## 五、上游删改项及理由

上游 `resources/NUIST/nuist.js` 的下列内容**没有照搬**：

- **弹窗与桥交互**（`showAlert`、`showSingleSelection`、`showToast`、`notifyTaskCompletion`、`saveCourseConfig`、`saveImportedCourses`、`savePresetTimeSlots` 等）：移植件只交付 extract / parse 两段纯转换，界面与入库由应用负责。
- **学期列表与选学期弹窗**（`xnxqcx.do`）：移植件不请求学期列表，学期只取当前学期（决定：不做选学期交互）。
- **`Number.parseInt`、`Number.isFinite`、对象展开、`async`/`await`、箭头函数、模板串**：不符合 ES5 硬约束（CI 不剥注释）。改为等价的 ES5 写法。
- **占位词「未知」（教师）与「待定」（教室）**：上游 `teacher ... || "未知"` 与 `position ... || "待定"` 会把占位词当成真名显示，规范与 `validatePayload` 都禁止。改为 `null`。
- **静默丢行**（上游 `rows.map(parseCourse).filter(Boolean)`）：解析不出来的行直接丢掉，不留痕迹。改为计入 `skipped` 并写入 warnings。
- **周数缺省 20 周、开学日缺省 `null`**：都是静默的。改为按课表推算总周数、按最近的周一推算开学日，并写入 warnings。
- **节次不校验**：上游把 `jc.do` 只过滤「节次号大于 0 且时间非空」，不校验 `HH:mm`。改为完整校验，不合法整表回落。
- **教师按 `/` 截断取第一位**：改为保留全部（见第四节第 13 条）。
- **注释「已由接口确认」**：上游在内置 12 节作息旁注明「已由接口确认」。我们无法核实该说法（没有真机或接口样本可对照），保留这组数值作为回落值，注释里如实写明未核实。
- **请求地址与凭据**：上游是相对路径 `/jwapp/sys/wdkb/...`，`credentials: 'include'`。本件改为绝对地址 `https://jwxt.nuist.edu.cn/jwapp/sys/wdkb`，凭据仍是 `include`。理由：页面停在别的域上时（比如登录跳转后），相对路径会把请求发到别的主机，违反「只请求本校教务主机」。代价：页面不在教务主机上时这是跨域请求，教务需返回 CORS 头，真机未验证（见第七节）。
- **字段白名单**：上游把接口返回的整行原样交给解析。本件只保留第二节列出的字段。
- **SKZC 非 0/1 位串**：上游 `parseWeeks` 逐字符只认「1」，其它字符静默忽略。本件认为整行不是位串，计入跳过并写入 warnings。
- **教师分隔符**：上游按斜杠、反斜杠、顿号、逗号、全角逗号截断，只取第一位。本件不含反斜杠，也不截断：按 `/ 、 , ， ; ；` 拆开，丢掉含数字的片段（工号）后去重连接；不含反斜杠是移植决定，真机未核实教务是否会用反斜杠分隔教师名。
- **载荷字段**：上游 `saveCourseConfig` 里的 `defaultClassDuration: 45`、`defaultBreakDuration: 10`、`firstDayOfWeek: 1` 不在规范 v1 载荷里，本件不带。开学日仍按周一对齐，与 `firstDayOfWeek: 1` 的口径一致。
- **排序**：上游按星期、节次、课名排序（`courses.sort`），本件保持教务返回的首次出现顺序。
- **文案**：警告与报错按 `docs/ux-writing.md` 第五节改写：不出现「载荷」「学期编号」这类数据术语，HTTP 状态码放在括号里，结论与出路写在前面。

**对派工单的偏离（需主调度确认，见报告）**：派工单要求周次越界时 clamp。本件对超过 30 的**周次**采用丢弃并 warn，而不是 clamp，理由是 clamp 会把第 31 周及以后的课错并到第 30 周，课表会整体错位，比丢弃更难察觉。对**总周数**（`ZZC`）仍是 clamp 到 30 并 warn，与派工单一致。

## 六、变异测试记录

### 第一轮（移植时）

三处变异，每处都在 `parse.js` 上用 Edit 改坏，运行 `check.js` 看到 DIFF，再用 Edit 还原，并复跑确认 PASS。

| 变异 | 改动 | 结果 | 还原后 |
|---|---|---|---|
| (a) 周次下标 | `weeksFromBits` 中 `weeks.push(i + 1)` 改为 `i + 2` | basic、calendar、boundary 三条全部 DIFF（FAIL 3） | 已还原，PASS |
| (b) 开学日回退周一 | `mondayOnOrBefore` 中 `offset = (date.getUTCDay() + 6) % 7` 改为 `offset = 0` | basic、calendar、boundary 三条全部 DIFF（FAIL 3） | 已还原，PASS |
| (c) 时间补零 | `normTime` 中 `return pad2(h) + ':' + pad2(min)` 改为 `return h + ':' + pad2(min)` | 仅 calendar DIFF（FAIL 1）；boundary 的节次表因第二行 `10:70` 不合法而整表回落，不经过该分支，输出不受影响；basic 没有节次表 | 已还原，PASS |

三处变异均已还原；最终 `check.js` 为 `RESULT: PASS`，`parse.js` 中 `i + 1`、`offset = (date.getUTCDay() + 6) % 7`、`pad2(h) + ':' + pad2(min)` 三处都已恢复原样。变异之后又改过 `extract.js`（绝对地址、字段白名单、错误文案）和 `parse.js`（校历按学期编号匹配、警告文案），并同步改了 `basic.expected.json` 与 `boundary.expected.json` 里对应的三条警告文字；改后 `check.js` 复跑为 `RESULT: PASS`，三条 MATCH。

三处变异均已还原；最终 `check.js` 为 `RESULT: PASS`，`parse.js` 中 `i + 1`、`offset = (date.getUTCDay() + 6) % 7`、`pad2(h) + ':' + pad2(min)` 三处都已恢复原样。变异之后又改过 `extract.js`（绝对地址、字段白名单、错误文案）和 `parse.js`（校历按学期编号匹配、警告文案），并同步改了 `basic.expected.json` 与 `boundary.expected.json` 里对应的三条警告文字；改后 `check.js` 复跑为 `RESULT: PASS`，三条 MATCH。

### 第二轮（审计修复：教师工号、总周数提醒、教务报错原因）

- 新增三对合成用例，期望值全部手工推出：`teacher`（教师「姓名/工号」只留姓名，多名去重，覆盖「张三/2008010010」→「张三」、「张三/2008010010,李四/2009020020」→「张三、李四」、「张三/李四」→「张三、李四」，另有「赵六/2011010011、赵六」→「赵六」）；`total-below`（教务给的总周数 10、课表到第 16 周：提醒写「教务给的学期总周数是 10 周，课表里有第 16 周的课，已按 16 周导入，请在学期管理里核对」，总周数按 16 导入）；`total-guess`（校历没有总周数：按位串长度推算为 20，提醒「没能从教务取到总周数，已按课表推算为 20 周，请核对」，不出现「教务给的」）。
- 变异都在系统临时目录的副本上做，原适配器文件未动；每处改坏后跑 `check.js`：

| 编号 | 对应问题 | 改坏哪一处 | 结果 |
|---|---|---|---|
| M1 | B1 教师工号 | `parse.js` 的 `teacherOf`：`if (!name \|\| /\d/.test(name)) return;` 改为 `if (!name) return;`（不再丢工号） | `teacher` 用例 DIFF：「张三/2008010010」变成「张三、2008010010」，三条教师期望全部不符 |
| M2 | B2 提醒原值 | `parse.js` 的 `belowWarning`：打印的 `calendarWeeks` 改为抬高后的 `totalWeeks` | `total-below` DIFF：提醒写成「教务给的学期总周数是 16 周」 |
| M3a | B2 推算不提 | 去掉 `belowMaxWeek && !guessedWeeks` 中的 `!guessedWeeks` | 六对全部 MATCH。推算路径下推算值是位串长度，不小于任何周次，`belowMaxWeek` 恒为假，守卫目前不可达，只作防线 |
| M3b | B2 推算不提 | 去掉守卫，同时把推算值改为 11（低于课表最大周次 12，模拟推算路径将来出错） | `total-guess` 与 `basic` DIFF：提醒出现「教务给的学期总周数是 null 周」，守卫正是挡这句的 |
| M4 | B3 报错原因 | `extract.js` 的 `fetchCourses`：恢复旧顺序（先判 rows 后判 extParams） | 桩 fetch 验证：只有 extParams、不带 rows 时报「没能读到课表数据…」，教务原因被盖掉。`check.js` 不跑 extract.js，这一条只能用桩 fetch 看 |

- 修复后的 `extract.js` 用 Node 桩 fetch 跑课表接口的六种响应：只有 extParams（code 0，msg「该学期课表尚未发布」）→ 报「该学期课表尚未发布」；带 rows 但 code 0 → 报同一句；code 0 无 msg → 报「教务系统未发布该学期课表。」；带 rows 且 code 1 → 正常返回；无 extParams 也无 rows → 报「没能读到课表数据…」；datas 里没有课表键 → 报「没能读到课表数据…」。

## 七、已知风险与未验证项

- **403 未在真机验证**。同平台 `dlutci` 的做法是先 GET 门户再 GET `appShow.do?id=` 进入应用，但那里的 `KNOWN_APP_ID` 是大连工程学院专属的，本校没有验证，因此**没有复制**，也**没有实现**自动进门户。当前行为是：遇到 403 给出明确提示，让用户在页面里点开一次「我的课表」后再提取。
- **请求地址与跨域**：四个请求都打绝对地址。若 WebView 停在别的域上，这些请求就是跨域请求，教务需返回允许该来源的 CORS 头，否则提取会以网络错误失败。真机未验证。
- **字段名未经本校核实**：`KCM`、`SKXQ`、`KSJC`、`JSJC`、`SKZC`、`SKJS`、`JASMC`、`XXXQDM_DISPLAY`，学期接口的 `DM` / `MC`，`cxjcs` 的 `XQKSRQ` / `ZZC`，`jc` 的 `DM` / `KSSJ` / `JSSJ`，全部取自上游代码，没有本校接口样本可对照。
- **作息 12 节未核实**：上游注释称「已由接口确认」，我们无法核实。回落值与上游一致；只要 `jc.do` 可用，就以接口为准。
- **学期推算口径未核实**：1–6 月为上学年第二学期、7–12 月为本学年第一学期，是模板沿用的口径，本校的学期切分未核实。推算时会写入 warning。
- **fixture 全部合成**：课名与教师都是虚构的，只保证同样输入得到同样输出、规则覆盖到位，不代表真实教务返回的格式。六对 expected 都是手工从规则推导的，没有由 `parse.js` 的输出复制。
- **教师连接符是移植决定**：按 `/ 、 , ， ; ；` 拆开、丢掉工号后以「、」连接，上游没有这一步。
- **`minAppVersionCode` 写 11**（与移植手册 §5.1 一致）。`warnings` 通道需要较新的应用版本（与 `niit` 的说明相同）；更旧的应用会忽略它。
- **未运行 gradle / CI，未联网，未 commit，未发版。** 仅运行了 `check.js`（含 Rhino 1.8.0 实跑六个 fixture），以及在 Node 里用桩 fetch 跑 extract.js 的课表接口（不联网）。

## 签名

0x7E7-2023（haiku 移植，2026-10-08）
