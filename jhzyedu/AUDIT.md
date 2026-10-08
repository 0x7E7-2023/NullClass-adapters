# 安全审计 —— 江西航空职业技术学院（正方教务 V9，根路径部署）

审计对象：`jw-adapters/jhzyedu/` 下的 `extract.js`、`parse.js`、`manifest.json`，以及它们移植自的上游脚本。

## 0. 出处与基线

- 上游：shiguang_warehouse 的 `resources/JHZYEDU/zhengfang.js`，快照 `ff72d1f08782df965cae110034a9d87cd91e0c07`（2026-10-08），MIT。
- 署名：维护者 JN，取自 `resources/JHZYEDU/adapters.yaml` 的 `maintainer`。上游脚本文件头没有作者行。
- 登录地址：`https://jw.jhzyedu.cn/xtgl/login_slogin.html?ydType=0`，与 adapters.yaml 的 `import_url` 一致。
- 模板件：第五批表头指定的模板（计划文档 `docs/impl/2026-10-08-port-adapters-batch5-6.md`，只读）。本文件不写其名。
- 第五批统一修订：H1 校历第 1 周日期不可信时，校历周数不采用；H2 总周数抬高的文案分两种；H3 教务作息表没有的节次补时间（内置表 / 顺推 / 23:59 截断，本次新做）；H4 文案统一用「学期管理」。
- 审计基线哈希（2026-10-08，统一修订之后）：
  - `parse.js` `98036dc239acd040076a44d11aba82f65eccc7f3b6f8be87c86d688376b0bf85`
  - `extract.js` `1d5c4d8c8aec4428ed779f3779ecdf275f2f42589db26380a4d345e477a2e582`（第 55 行注释已改；第 74、183 行报错文案已改，X3）
  - `manifest.json` `be0f5e65e0542e01ae5b3df22e0589d9fe4d79fe68466e94bdb0c8163ff29ffd`（已有 9 条 fixture）

## 1. 请求清单

所有地址由 `window.location.origin` 拼出，不写死主机名。`jwBase()` 取当前地址中 `/xtgl/` 或 `/kbcx/` 之前的前缀，正常为空（根路径部署）。全脚本只有下面四条请求，都是同源。

| # | 方法 | 地址（`jwBase()` 之后） | 请求体 | 何时发 | 失败时 |
|---|---|---|---|---|---|
| 1 | GET | `/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 无 | 当前页没有 `#xnm` / `#xqm` 时才发 | 报错，提示重新登录或打开课表页 |
| 2 | POST | `/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=` | 必发 | 报错，提示重新登录 |
| 3 | POST | `/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | `xnm=…&xqm=…&xqh_id=…` | 课表成功后与第 4 条并发；best-effort | 请求失败或响应不是 JSON 交 `null`；响应是 JSON 但找不到行数组交 `[]` |
| 4 | POST | `/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | `xnm=…&xqm=…` | 同第 3 条 | 请求失败或响应不是 JSON 交 `null`；响应是 JSON 但找不到行数组交 `[]` |

逐条核对：

- 第 2 条与上游一致。上游地址是 `https://jw.jhzyedu.cn/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`（上游第 153 行），请求体是 `"xnm=" + … + "&xqm=" + … + "&kzlx=ck&xsdm=&kclbdm="`（第 151 行）。本件对学年、学期代号做了 `encodeURIComponent`，它们是数字代号，结果相同。
- 请求头：本件比上游多 `X-Requested-With: XMLHttpRequest` 与 `Accept: */*`（上游只有 `Content-Type`）。模板件同样带这两个头。本校是否需要，未验证。
- 第 3 条：`campusId` 为空时仍会带空的 `xqh_id=` 发出。
- 第 3、4 条是附加接口：失败一律交 `null`，parse 回落并写 warning，不会因为它们失败而导不进课表。

菜单号依据（对上游 `resources/` 下 `.js` 文件实查）：

- 周次校历 N2154：上游多数脚本的校历请求与路径写在同一行，字面 `N2154`，本件沿用。几份写法不同（已对 `resources/` 实查）：HUALIXY 第 233 行用变量 `gnmkdm` 拼菜单号；SCEMI 第 264 行用候选列表；JUST 第 24 行的路径行没有字面菜单号；SCNU 第 268 行的调用没有字面菜单号，第 96 行只在注释里提到。这几份实际取什么菜单号，未核实。
- 作息 N2151 的 Rjc：同一行字面写 `N2151` 的有 4 份（NBUT、NJCIT、SCUT、WENHUA），本件沿用这一写法。另有 HUALIXY（变量）、JUST、QUT、SCEMI、SCNU 的同一行没有字面菜单号；YXHMC 第 271 行只在注释里出现。

## 2. 读了什么、带出什么（以当前代码为准）

读，全部来自本校教务同源接口的返回：

- 学年学期：页面上的 `#xnm`、`#xqm` 下拉框（用户切过的优先，跳过空值占位项）。没有则读一次课表页的同两个框。
- 课表 `kbList` 与集中实践课 `sjkList`；可选的记录总数（`total` / `totalResult` / `totalCount` / `count`）。
- 作息 JSON、学期周次校历 JSON（均可选）。

带出，即交给 parse 的载荷：

| 字段 | 内容 | 说明 |
|---|---|---|
| `term` | `xnm`、`xqm`、`xnmText`、`xqmText` | 学年学期代号与页面文本 |
| `today` | 本机日期 `YYYY-MM-DD` | 推算开学日用 |
| `campusId` | 课表行的 `xqh_id` | 在字段投影之前取，只用来拼第 3 条请求 |
| `raw.kbList` | 每行只留 `kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd` | `xm` 是**教师**姓名 |
| `raw.sjkList` | 每行只留 `kcmc`、`zcd` | 集中实践课，不进课表 |
| `total` | 数字或 `null` | 记录总数，用来对账 |
| `periodTimes` | 每行只留 `jc`、`jcmc`、`qssj`、`jssj`；请求失败或响应不是 JSON 为 `null`，找不到行数组为 `[]` | 校区作息 |
| `calendar` | 每行只留 `zs`、`zsmc`、`zrq`、`zcrq`、`rq`、`ksrq`；请求失败或响应不是 JSON 为 `null`，找不到行数组为 `[]` | 学期周次校历 |

不带出：课表响应里的其它字段（包括 xsxx 等学生信息）、Cookie、登录账号、令牌、成绩、学籍、缴费信息。脚本不读取这些内容。

## 3. 手册 §5 八条

证据命令（在 `jw-adapters/jhzyedu/` 的 `extract.js`、`parse.js` 上执行，写本文件前完成）：

- `grep -in "cookie\|localStorage\|sessionStorage\|password\|pwd"`：无命中。
- `grep -n "eval\|new Function"`：无命中。
- `grep -nE "innerHTML|\.submit\(|\.click\(|\.value\s*=[^=]"`：无命中。`.value` 只有读取：extract.js 第 120、129 行是与 `null`、`undefined` 的 `===` 比较，第 139、147 行是读取。
- `grep -n "fetch(\|XMLHttpRequest\|sendBeacon"`：命中两处。第 71 行是 `request()` 里的 `fetch(url, options)`，地址全部来自 `jwBase()`；第 66 行的 `'XMLHttpRequest'` 是请求头字符串，不是 XHR 对象。没有 `sendBeacon`。
- `grep -n "WebSocket\|EventSource\|new Image"`：无命中。
- `grep -n "https\?://"`：只有两个文件头注释里的上游仓库地址，不是请求。

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 过 | 没有读写 cookie、storage、密码字段。`credentials: 'include'` 只让浏览器带上用户自己的会话，脚本不接触它。 |
| 2 | 不外发 | 过 | 唯一的网络出口是 `request()`，地址全部是 `jwBase()` 拼出的同源地址。没有第三方域。 |
| 3 | 请求域可控 | 过 | `allowHosts: []`，只放行同源（即登录页所在的教务主机）。脚本里没有写死的绝对请求地址。 |
| 4 | 只读课表 | 过 | 四条请求全在 `/kbcx/` 下（课表页、课表接口、作息、周次校历）。不请求成绩、学籍、个人信息、缴费。作息与校历是学校公共数据。响应里的学生字段不带出（见 §2）。 |
| 5 | 不埋点 | 过 | 没有统计、上报、遥测。grep 命中的 `reportedTotal` 是教务返回的记录总数变量，不是上报。 |
| 6 | 不 eval 远程代码 | 过 | 无 `eval`，无 `new Function`。 |
| 7 | 不写页面 | 过 | 不写 DOM，不提交表单，不点击。extract.js 只读 `#xnm`、`#xqm` 的 option 与 value。 |
| 8 | 不依赖用户输入之外的秘密 | 过 | 无密钥、令牌、学号。脚本里的常量只有两个公开菜单号 `N2151`、`N2154`。 |

## 4. 第五批专项检查表（1–6）

1. **上下文路径**：过。`jwBase()` 不拼任何固定前缀，只取当前地址里 `/xtgl/` 或 `/kbcx/` 之前的部分，正常为空。extract.js 第 42 行注释说明本校不是带上下文前缀的部署。
2. **菜单号与请求体**：过。课表 N2151，请求体与上游逐字一致（见 §1）。作息 N2151、周次校历 N2154，依据见 §1。
3. **作息表逐节核对**：过。`SCHOOL_PERIOD_TIMES` 的 8 行与上游 `TimeSlots` 逐节一致：09:00–09:40、09:45–10:25、10:35–11:15、11:20–12:00、13:30–14:10、14:15–14:55、15:05–15:45、15:50–16:30。`MAX_PERIOD`（parse.js 第 37 行）的注释指向「作息时间」一节，值 20 不变。教务作息表没有的节次（不限第几节）补时间，依统一修订：内置节次时间不早于上一节下课才用，否则课间 5 分钟、每节 45 分钟顺推，顺推越过 23:59 就停并写 warning。用例：`evening` 钉住内置分支（第 9–12 节全用内置）；`periods-short` 钉住教务只给 2 节时第 3–6 节全用内置（10:00、10:55 都不早于上一节结束）；`calendar-extra` 同时钉住内置（第 11、12 节）与顺推（第 9、10、13、14 节），以及 23:59 截断（第 15 节不补）。第 9–12 节的 18:30–22:00 取自 `:core:model` 的 `DefaultPeriodTimes` 晚间四节（按分钟值核对）。它不是本校作息，已在 warnings 里说明。
4. **跨域登录**：过（本件不跨域）。上游脚本只请求本机教务主机。登录页地址与 adapters.yaml 的 `import_url` 同主机。`onLoginPage()` 只认 `login_slogin.html` 这一页。CAS 跳转页的识别未验证（本件不许联网，看不到真实跳转）。
5. **模板残留**：过。对模板学校的名称、简称与域名做全目录 grep，无命中（本文件也不写它们）。前缀字样只出现在 extract.js 第 8、42 行的注释里，用来说明本校不是带前缀的部署。
6. **其余沿用批次三/四**：
   - 周次写法：`weeks-forms` 覆盖「1-16周(单)」「(单)1-16周」「1-16(单周)」「1-16周(单周)」「1-3,5-9周」「1-3周 5-9周」（空格分段）、「1-16周(单双周)」（单双同时写）、「16周」，以及整格只有「(3)」、只有「单周」没有周次的两行。`weeks-brackets` 覆盖括号的六种位置：「(1-16周)」「1-16周(1,2)」「1-16周(3组)」「(1)1-16周」「1-16(2」「1-16周(3」，末两条是落单括号（钉 X1 第 3 步：换成逗号、不删）。没有「周次全超出 1–30」的行。
   - 括号序号：`(1)`、`(1-2)`、`1-16周(1,2)`、`(1)1-16周` 的序号括号整段摘掉并计数；`1-16周(3组)` 类备注摘掉并写提醒。`(3)` 整格无周次，跳过并计数。
   - warnings 不超过 20 条、每条不超过 200 字：check.js 校验通过。
   - `HH:mm` 合法、结束晚于开始：check.js 校验通过。
   - 学期名：用教务的学年学期文本。学年读不出时写「江西航空职业技术学院 第一学期」，不用适配器名。
   - `teacher` / `location` 拿不到留 `null`：`basic`、`calendar-extra`、`evening` 的期望中均为 `"teacher": null`。check.js 拒绝占位词。
   - AUDIT 与代码一致：本文件的哈希核对基线为统一修订之后的 parse.js（`98036dc2…`），§0 记录了三个文件的基线哈希。
   - 期望值按设计规则手推（非第二实现交叉验证），并做变异测试：见 §6。
   - ES5（注释也算）：extract.js、parse.js 全文 grep `=>`、反引号、`let `、`const `、`async`、`await`、`class `、展开运算符、`(?<`，均无命中。
   - 控制字节与 BOM：check.js 校验通过。

## 5. 与模板件的差异（逐条）

对照对象是模板件目录的只读副本（第五批表头指定）。逐条列出，不写模板名。

`.test/port-batch5/diffs/` 下那份 diff 是上游对上游，不是本件对模板件，本节不以它为依据。

**extract.js**

1. 上下文路径：模板件有一个写死的部署前缀常量，`jwBase()` 在它之上拼接。本件删去该常量，改为取 `/xtgl/`、`/kbcx/` 之前的前缀，找不到就只用 origin。
2. 请求地址：模板件所有地址都带该前缀。本件是根路径 `/kbcx/…`。
3. 载荷投影：模板件把课表行、实践课行、作息、校历原样交出。本件按字段白名单投影（`keepFields`），只留解析要用的字段。
4. `campusId`：两边都从课表行取。本件在投影之前取。
5. 作息与校历：模板件把接口返回原样交给 parse。本件在 extract 里用 `rowsOf` 先找出行数组（找法与 parse 的 `rowsIn` 相同）；找不到行数组交 `[]`，只有请求失败或响应不是 JSON 才交 `null`。
6. 请求头：两边相同，都带 `X-Requested-With` 与 `Accept`。与上游不同，见 §7。
7. 头注释：移植改动条目按本校重写（⓪ 根路径部署，⑤ 字段白名单）。

**parse.js**

8. 作息表：模板件的 `SCHOOL_PERIOD_TIMES` 是 12 节表，从 08:00 起。本件是 8 节表，与上游 `TimeSlots` 逐节一致。
9. 内建节次表与补齐方式：模板件的 `BUILTIN_PERIOD_TIMES` 是 12 行显式数组，其中第 5–8 节是通用模板的 14:00–17:40（前一轮记录，本次未重新核对），缺节次时无条件用它补。本件的 `BUILTIN_PERIOD_TIMES` 是 `DefaultPeriodTimes` 的 12 行，逐节照抄（parse.js 第 59 行起）；教务作息没有的节次按统一修订补：内置时间不早于上一节下课才用，否则课间 5 分钟、每节 45 分钟顺推，顺推越过 23:59 即停并写 warning。
10. `MAX_PERIOD` 注释：模板件写「这所学校作息只有 12 节」。本件改为 8 节口径并指向「作息时间」一节，值 20 不变。
11. 校历第 1 周日期不可信：模板件的 `calendarInfo` 在这种情况下仍保留校历周数。本件清零（`if (!info.firstIso && info.rejectedIso) info.weeks = 0;`，parse.js 第 468 行），总周数回落到内置的 20 周。
12. 总周数抬高（`raisedBySchedule`）的文案：模板件只有一套文案，直接拼 `calendarWeeks`，校历没给周数时句子里会拼进「0 周」。本件按周数来源分两种文案：校历给了周数的（写明校历周数与按几周导入），校历没给或被作废的（写超过内置 20 周）。校历不属于本学期时另写一条 warning，句式为「教务校历不属于这个学期（见上一条）……」。
13. 学期名兜底：模板件学年读不出时直接拼学年文本。本件增加 `SCHOOL_NAME` 常量，学年读不出时写「江西航空职业技术学院 第一学期」。
14. 注释中的上游事实：模板件的头注释写的是模板学校的上游事实（如 `firstDayOfWeek`、12 节）。本件改为本校上游事实：config 只有 `semesterStartDate: null` 与 `semesterTotalWeeks: 20`。
15. 函数清单：两件 parse.js 的具名函数原本一致（从 `text` 到 `courseOf`）。统一修订新增两个：`hhmmOf`（分钟数转 HH:mm）与 `sectionsText`（节次号转「第 9-12 节」文案），其余差异在常量、分支与文案里。

**manifest.json**

16. `name`、`key`、`initial`、`loginUrl`、`scheduleUrlHint`：改为本校。`loginUrl` 与上游 adapters.yaml 的 `import_url` 一致。
17. `author`：本件为「上游 JN（MIT）；移植 0x7E7-2023」，署名的是本校上游的维护者。
18. `fixtures`：模板件 5 对，本件 9 对。新增 `calendar-raise`（总周数抬高分支）、`evening`（本校 8 节作息的边界）、`periods-short`（教务只给 2 节时第 3–6 节补时间，B1 边界）与 `weeks-brackets`（周次括号的六种位置，含两条落单括号，X1）。`weeks-forms` 增加「1-16周(单周)」的一行。
19. `allowHosts: []`、`minAppVersionCode: 11`：与模板件相同。§5.1 的判断：本件只用 warnings 与已有的载荷字段，属于可降级能力，写 11。

## 6. 变异测试

基线：`parse.js` 哈希 `98036dc2…`（全文见 §0）。变异都在副本上做：每个变异对副本里的 parse.js 做字符串替换（M7 为同一步骤的两处），跑 check.js 并记录结果；真目录不动，无需还原。

| 编号 | 位置 | 改法 | 变红的用例 | 变红的表现 |
|---|---|---|---|---|
| M1 | parse.js 第 630 行 | `if (builtin && minutesOf(builtin.start) >= prevEnd) {` 改为 `if (builtin && false) {`（关掉内置分支，教务作息没有的节次全部顺推） | `periods-short`、`evening`、`calendar-extra` | 三个文件 DIFF，RESULT: FAIL (3) |
| M2 | parse.js 第 418 行 | 单数字节次正则 `[0-9]{1,2}` 改为 `[0-9]{3}` | `evening` | DIFF（课程数 3 ≠ 期望 4），RESULT: FAIL (1) |
| M3 | parse.js 第 468 行 | `if (!info.firstIso && info.rejectedIso) info.weeks = 0;` 改为 `if (false) info.weeks = 0;`（关掉不可信校历的周数清零） | `second-term` | DIFF（warnings 第 3 条文案不同，改走校历抬高的文案），RESULT: FAIL (1) |
| M4 | parse.js 第 601 行 | `if (maxWeek > totalWeeks) {` 改为 `if (maxWeek > totalWeeks && false) {`（关掉总周数抬高） | `calendar-raise` | DIFF（totalWeeks 18 ≠ 期望 20；warnings 第 3 条不同），RESULT: FAIL (1) |
| M5 | parse.js 第 630 行 | `if (builtin && minutesOf(builtin.start) >= prevEnd) {` 改为 `if (builtin) {`（「不早于上一节下课」判断改为恒真） | `calendar-extra` | DIFF（第 9 节结束 19:15，期望 19:30；warnings 第 4 条不同），RESULT: FAIL (1) |
| M6 | parse.js 第 637 行 | `23 * 60 + 59` 改为 `23 * 60 + 60 * 99`（关掉 23:59 截断） | `calendar-extra` | DIFF（periodTimes 长度 15 ≠ 期望 14；warnings 9 条 ≠ 期望 10 条），RESULT: FAIL (1) |
| M7 | parse.js 第 298、316 行 | X1 步骤二（删「周」）挪到括号分类之前：第 298 行后加删「周」，第 316 行那句删去 | `weeks-brackets` | DIFF（课程数 5 ≠ 期望 6，M 括号包住周次那门课丢失），RESULT: FAIL (1) |
| M8 | parse.js 第 318 行 | X1 步骤三（落单括号换逗号）改为 `replace(/[()]/g, '')`，直接删 | `weeks-brackets` | DIFF（Q 与 R「1-16周(3」都变为 1–30 周，totalWeeks 30 ≠ 期望 20；warnings 7 条 ≠ 期望 6 条，第 3 条变成抬高文案），RESULT: FAIL (1) |
| M9 | parse.js 第 62 行（BUILTIN 第 3 行） | `{ periodIndex: 3, start: '10:00', end: '10:45' }` 改为 `10:35`–`11:15` | `periods-short` | DIFF（第 3 节 10:35–11:15，第 4 节 11:20–12:05；warnings 第 4 条不同），RESULT: FAIL (1) |
| M10 | parse.js 第 630 行 | `minutesOf(builtin.start) >= prevEnd` 改为 `>`（边界相等时不用内置） | `calendar-extra` | DIFF（第 11 节 20:20 边界改走顺推，变为 20:25–21:10），RESULT: FAIL (1) |

结果：十个变异（M1–M10）每次 `check.js` 都是 `RESULT: FAIL`，失败的用例与上表一致。变异在副本上做，真目录未动，无需还原；真目录的 `check.js` 为 `RESULT: PASS`，`parse.js` 哈希与基线一致。

## 7. 对上游的删改及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| 开场弹窗：`promptUserToStart`（第 113 行）里的 `showAlert`（第 114 行）、学年输入 `showPrompt`（第 123 行）、学期选择 `showSingleSelection`（第 133 行）：先提示，再问学年，再选学期 | 读页面上的 `#xnm`、`#xqm`；页面没有才读一次课表页 | 手册 §3 第 1 步：自动取当前学期，不打断用户。要导入别的学期，在教务页切换后再提取 |
| 全部 `window.shiguangBridge` 调用（提示、保存、导入时间段，第 155–275 行） | 去掉，脚本只交载荷 | 写入与提示由应用完成，适配器不碰应用的桥 |
| 课表行六个字段必填（第 63–64 行） | 只要求课名、星期、节次、周次；教师、教室缺失则留 `null`，并计数 | 手册 §4.7；不许静默丢课 |
| `parseWeeks`：两条正则，`includes('(单)')` 认单双 | `weeksOf`：三步处理括号（①逐个括号按内容分类：只含数字、区间、逗号的是教学班序号，整组换成逗号并计数；含数字、区间、逗号、周、单、双、第以外的字（如「组」）的是备注，整组换成逗号、计数并记首处原文；其余保留内容，两侧换逗号。②删「周」字。③落单括号换逗号）；再按逗号和空白分段，单双按所在段认，展开区间，丢弃 1–30 之外的周 | 上游会把「1-16(单周)」整段丢掉，把「1-16周(单周)」当成每周都上，把「1-3,5-9周」只认成 5-9 周 |
| 节次 `jcs.split('-')` 取首尾（第 74 行） | `sectionsOf`：区间、单个数字、两位一拼、多段（取最大跨度并写 warning） | 上游会丢掉「第9-10节」「1,2」，把「0102」当成第 102 节，把「1-2,5-6」当成 1–6 节 |
| `semesterStartDate: null`、`semesterTotalWeeks: 20`（第 176–177 行） | 开学日：校历第 1 周可信则取它，否则推算并写 warning。总周数：校历周数，课表排得更晚则抬高并写 warning，上限 30 | 手册 §4.2、§4.3：不猜开学日，并说清楚来源 |
| 作息 `TimeSlots` 预设表（第 206 行起） | 先用教务作息接口；取不到用同一张 8 节表（逐行一致）。课表用到教务作息没有的节次时：内置节次时间不早于上一节下课就用它，否则课间 5 分钟、每节 45 分钟顺推，顺推越过 23:59 即停并写 warning。不像模板件那样无条件用内置表补 | 教务有作息时以教务为准。内置节次时间（第 1–12 节）是应用默认值，不是本校作息；顺推参数是统一规则，也不是本校作息（见 §8） |
| 只请求课表一条（第 151–163 行） | 另外请求作息与周次校历两条（best-effort，失败交 `null`） | 上游的开学日与作息都是写死的，本件要取学校的真实数据 |
| 请求头只有 `Content-Type`（第 161 行） | 加 `X-Requested-With`、`Accept` | 与模板件相同。必要性未验证（见 §8） |
| 课表行的字段：上游只取六个字段，没有约束响应里的其它字段 | extract 阶段就只留六个字段，其它字段不带出 | 手册 §5 第 4 条，以及「不带出学生个人信息」的约束 |
| 学期名 | 用教务的学年学期文本；学年读不出时用学校名加学期 | 手册 §4.7 |

## 8. 未确定的事与未覆盖的分支

1. 真实页面与账号未验证（本件不许联网）。N2151 的 Rjc（作息）与 N2154 的 Zccx（周次校历）在本校是否存在，只能真机验证。不存在时两者都交 `null`：开学日推算，总周数 20，作息用 8 节表。
2. 学期锚点（9 月 1 日、2 月 20 日、7 月 1 日）是模板的启发式，对本校未核实。只在校历不可信或没有时使用，此时 warning 已写明。
3. `BUILTIN_PERIOD_TIMES` 与应用的 `DefaultPeriodTimes` 逐节一致（B1 修复后，原先的疑问已有答案）。它不是本校作息：本校作息只有 `SCHOOL_PERIOD_TIMES` 的 8 节。教务作息没有的节次才用它补，补的时间已在 warnings 里说明。
4. `campusId` 为空时仍发第 3 条请求（空的 `xqh_id=`），本校是否接受未知。失败即交 `null`。
5. `X-Requested-With`、`Accept` 为本件新增（与模板件相同），上游没有。若本校拒收，需要删去。
6. 期望值按设计规则手推（包括顺推时间与 23:59 截断），不是第二实现的交叉验证。变异测试证明的是「fixture 能抓住这些分支」，不是「解析结果与真实页面一致」。
7. 没有 fixture 覆盖的分支：周数超过 30 的截断（clamped）；作息表不连续或时间不递增时回落到内置 8 节表（`periodTimesOf` 返回 `null`）；`periodTimesOf([])` 返回 `null`（parse.js 第 487 行 `if (!slots.length) return null;`）；抬高文案「校历没给或被作废」（calendar-raise 只覆盖「校历给了周数」）；warnings 超过条数上限时的截断；学年读不出时的学期名兜底与推算；课表行为空时的报错；weeks-forms 没有「周次全超出 1–30」的行。extract.js 没有自动化测试，只能真机跑。
8. CAS 跳转页的识别未验证（不许联网）。
9. 署名 JN 取自 adapters.yaml 的 maintainer。上游脚本文件头没有作者行。
10. 顺推参数（课间 5 分钟、每节 45 分钟）与 23:59 截止是统一修订定下的规则，不是本校作息。`calendar-extra` 里第 9、10、13、14 节的时间（如 22:05–22:50、22:55–23:40）是按规则推算的合成值，不代表学校实际时间。
11. 参考实现中的 `if (!prev)` 分支未照抄：`periodTimes` 到达那里时恒非空（教务表经 `periodTimesOf` 校验，否则回落 8 行内置表），该分支不可达。
12. M10 已跑（红）：把 `>=` 改为 `>`（parse.js 第 630 行）后，`calendar-extra` 第 11 节的 20:20 边界改走顺推，变为 20:25–21:10。

## 9. 签名

移植者：0x7E7-2023（haiku 移植）
日期：2026-10-08
