# 安全审计 —— 西安交通大学（金智教育 WIS / jwapp 平台，wdkb 应用）

审计对象：`jw-adapters/xjtu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `XJTU/xjtu.js`（本地只读克隆的 HEAD `c586957c077506a5182105ae3961ceff4d0223ce`，
提交时间 2026-10-08T22:54:57+08:00，MIT，仓库根 `LICENSE` 的版权人是 `星河欲转`）。

审计方式：逐行读本件两个脚本，对照上游本地快照的 `XJTU/xjtu.js`
（`<临时目录>/sgw/resources/XJTU/xjtu.js`，只读，未在其目录运行任何程序），逐条核对本件引用的上游行号，
并跑移植手册 §5 的静态扫描。扫描结果：

- 绝对 URL：`parse.js` 里只有文件头写上游仓库的 `https://github.com/...`（注释，不是请求）。
  `extract.js` 里有一处写死的主机 `https://ehall.xjtu.edu.cn/jwapp/sys/wdkb`（`extract.js:19`），
  它就是 `manifest.json` 的 `loginUrl` 主机，逐条说明见 §1。
- 网络调用：只有 `extract.js` 的 `postJson()`（`extract.js:39`，`fetch`）与上游同款的
  `X-Requested-With: XMLHttpRequest`（请求头，不是 XHR 对象）。
- `eval`、`new Function`、`innerHTML`、`document.write`、`appendChild`、`sendBeacon`、`WebSocket`、
  `new Image`、`localStorage` / `sessionStorage`、`document.cookie`：无命中。
- `extract.js` **完全不读当前页面的 DOM**（没有 `document` / `querySelector` / `DOMParser`），
  取数全凭接口与会话。

## 1. 请求域与请求清单

上游 `XJTU/xjtu.js` 用**相对当前源的根路径**发请求（`api("/jwapp/sys/wdkb/modules/…")`，
`api()` 定义在上游第 163 行、请求在第 172 行），因此请求落在用户当时所在的那个主机上
（上游文件头自述适配 `jwxt.xjtu.edu.cn / ehall.xjtu.edu.cn` 两台主机）。

本件**不跟页面走位**：主机写死在 `extract.js:19` 的 `BASE`，就是 `manifest.json` 的 `loginUrl`
（`https://ehall.xjtu.edu.cn/`）。三条请求全部由 `BASE` 拼出。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | POST | `/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do`（空体） | 当前学年学期（`dqxnxq` 的 `DM` / `MC`，`extract.js:77-87`） | 按本机日期推算（`termFromDate`，`extract.js:71-75`：1~6 月为上学年第二学期，7~12 月为本学年第一学期），`source` 记 `guess`，parse 写进 `warnings` |
| extract.js | POST | `/jwapp/sys/wdkb/modules/xskcb/xskcb.do`（体 `XNXQDM=<学期代码>`，`extract.js:91`） | 课表行 `xskcb.rows` 与记录总数 `xskcb.totalSize` | 报错。教务若用 `extParams.code ≠ 1` 报错，本件把教务的原话交出去（`extract.js:94-96`），不用「没读到数据」盖掉它 |
| extract.js | POST | `/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do`（体 `XN=<学年>&XQ=<学期序号>`，`extract.js:108`） | 校历行：开学日 `XQKSRQ`、教学周数 `ZJXZC`、总周数 `ZZC` | 交空数组（`extract.js:111-113`），parse 回落推算并写进 `warnings` |

两处要说清楚的：

1. **写死主机是对上游的改动，不是照搬。** 理由：本件 `manifest.json` 的 `loginUrl` 就是
   `https://ehall.xjtu.edu.cn/`，宿主放行的域由 `loginUrl` 派生；而西交的登录是**跨主机的 CAS 链**
   （ehall → `org.xjtu.edu.cn` → `login.xjtu.edu.cn`），页面最后停在哪台主机不由本件决定。
   写死 ehall 保证三条请求一定落在放行域内，也不受页面跳转影响。
   已联网核实 `https://ehall.xjtu.edu.cn/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do` 存在（未带会话时 302 跳 CAS）。
   **代价**：如果用户的会话只建立在 `jwxt.xjtu.edu.cn` 上而没有 ehall 的会话，本件会失败而上游可能成功。
   这一条**未在设备上验证**（见 §9）。
2. **校历行的选取**：上游取 `rows[0]`（上游第 218-222 行）；本件按 `XN` / `XQ` 与学期代码对得上的那一行
   才算数（`findCalendarRow`，`parse.js:143-150`），对不上就当没有校历。避免接口返回多学期时取错行。

### 曾经多发过一条 `jc.do`，已删掉

本件最初跟模板件一样向 `/jwapp/sys/wdkb/modules/jshkcb/jc.do`（空体）要节次时间
（`jc` 的 `DM` / `KSSJ` / `JSSJ`），拿它填载荷的 `periodTimes`。

**在真实会话里试过，这条请求返回 403。** 403 的成因可能是本校根本没有这个接口、也可能是该身份无权访问；
无论哪一种，本件都不该发一条注定失败的请求。因此现在**不发这条请求**，作息改用 `parse.js` 内置的两张表
（`SUMMER_PERIOD_TIMES` / `WINTER_PERIOD_TIMES`，`parse.js:30-55`），与上游逐字相同（见 §7 第 8 条）。

删掉的不只是那一条请求：随它一起删掉了 `TIME_SLOT_FIELDS` 白名单、`fetchTimeSlots()`、
`timeSlotRows` 这个输出字段，以及 `parse.js` 里 `normTime` / `periodTimesFrom` / 整套「教务节次表优先、
不合法就整表作废」的校验和两条提醒文字。只用来验这套机制的 `timeslots-bad` / `timeslots-time`
两对 fixture 也随之删除，fixture 由 8 对减到 6 对。

其它：

- `allowHosts: []`，不写通配。
- 请求头只有 `Content-Type` 与 `X-Requested-With`（`extract.js:44-45`），没有自定义令牌。
- `credentials: 'include'`（`extract.js:42`）让 WebView 按同源规则自动带会话 Cookie；脚本不读、不存、不外发 Cookie。
- `parse.js` 不发任何请求（CI 里用 Rhino 实跑，是纯函数）。

### WebVPN 与代理域（移植手册 §5 的代理域规则）

- 经学校 WebVPN 打开时，当前源会是 WebVPN 的映射域。本件的三条请求**不落在当前源上**，而是落在
  `ehall.xjtu.edu.cn`。这个主机名只出现在 `manifest.json` 的 `loginUrl` 与 `extract.js:19` 的 `BASE`
  里，没有第二个主机名。
- 本件不请求 `jwxt.xjtu.edu.cn`，也不请求任何 WebVPN 网关域。
- 直连与 WebVPN 两种情况下，宿主要放行的都是 `ehall.xjtu.edu.cn`（= `loginUrl` 主机）。
  宿主如何执行 `allowHosts` 本件没有验证（见 §9）。

## 2. 读了什么（数据面）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学期元信息：`DM`（学期代码）、`MC`（学期名） | 当前学期接口 | 带出（学期名要用） |
| 排课行：`KCM` / `SKXQ` / `KSJC` / `JSJC` / `SKZC` / `SKJS` / `JASMC` / `XXXQDM_DISPLAY` | 课表接口 | 带出（课表本身） |
| 校历：`XN` / `XQ` / `XQKSRQ` / `ZJXZC` / `ZZC` | 校历接口 | 带出（只用来定开学日与总周数） |
| 记录总数 `totalSize` | 课表接口 | 只用于对账，不整表带出 |
| 课表响应里若夹带的学生信息 | 课表接口 | **不带出**。`pick()`（`extract.js:117-128`）按两张白名单逐字段取（`extract.js:22-23`），其余字段一律不带出去 |

不读的东西：密码与登录表单、会话 Cookie、`localStorage` / `sessionStorage`、成绩、学籍、缴费、
选课、考试，以及其它应用的接口。三条请求都在 `wdkb`（我的课表）这一个应用下。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有读取密码或登录表单，没有 `localStorage` / `sessionStorage` 访问，`extract.js` 不碰 DOM。`credentials: 'include'` 只让 WebView 自己带会话 Cookie，脚本不读它。上游的学期选择弹窗（`fetchTermOptions` / `selectTerm`，上游第 84-135 行）与学期列表接口（`xnxqcx.do`）**没有移植**，本件不向用户要任何输入、也不多发一条请求 |
| 2 | 不外发 | **过**。全部网络调用在 `extract.js` 的 `postJson()` 里（第 39 行），三条地址都由 `BASE` 拼出。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单 |
| 3 | 请求域可控 | **过**。写死的主机就是 `loginUrl` 主机，请求不跟页面走（§1 第 1 条）。`allowHosts: []`，无通配 |
| 4 | 只读课表 | **过**。三条请求都在 `wdkb` 应用下（课表行、当前学期、校历），没有成绩、学籍、缴费或个人信息接口。课表响应里的其它字段不带出（§2） |
| 5 | 不埋点 | **过**。没有统计、上报或遥测；`img` 打点无命中 |
| 6 | 不 eval 远程代码 | **过**。两个脚本都没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`，`postJson` 里把解析失败单独接住（`extract.js:55-59`） |
| 7 | 不写页面 | **过**。`extract.js` 完全不读当前页面，也没有任何 `document.*` / `innerHTML` / `appendChild`。上游的交互与写入步骤（`showSingleSelection`、`shiguangBridgePromise`、保存流程，上游第 424 行起）全部没有移植 |
| 8 | 不依赖输入之外的秘密 | **过**。没有硬编码密钥、令牌，也没有任何学号。常量只有那个 `loginUrl` 主机与两张字段白名单。fixture 的人名、课名、教室全是编造的 |

**结论：八条全过，未发现阻止入库的问题。** 请求只打 `loginUrl` 主机，只读课表，
不碰凭据、不外发、不埋点、不写页面。只剩「写死主机 vs 相对当前源」一条待设备验证（见 §8、§9）。

## 4. 本批检查表（10 条）

| # | 检查项 | 本件结论 |
|---|---|---|
| 1 | 周次写法 | **过，有用例**。金智 `wdkb` 的 `SKZC` 是**位图字符串**，第 i 位（从 0 起）为 `1` 表示第 i+1 周。`weeksFromBits`（`parse.js:103-110`）只认 `/^[01]+$/`，不是位串就返回空数组（该行按缺周次处理，计数进 `warnings`）。用例：`basic` R1（16 个 1 → 第 1-16 周）、R2（`0101…` → 第 2、4、…、16 周）、R3（首尾各一个 1 → 第 1 周与第 16 周两段）；`boundary` B1（只有第 1 位 → 第 1 周）、B2（`1010…` → 第 1、3、…、15 周）、B3（全 1）、B5（`1x01` 非位串 → 按缺周次跳过）、B9（全 0 → 按缺周次跳过）。上游 `parseWeekBitmap`（上游第 267-282 行）同样是 `i + 1`，但**非位串直接 `throw`**（上游第 269 行），整单失败 |
| 2 | 单双周与极大段 | **过，有用例**。`runsOf`（`parse.js:113-131`）把升序周次切成极大段：步长 1 记为 `ALL`（每周）；步长 2 按**起始周的奇偶**记 `ODD` / `EVEN`；两端相同或落单的一周记为 `ALL`。载荷按段存（`startWeek` / `endWeek` / `weekType`），不展开成逐周数组。用例：`basic` R1（1-16 `ALL`）、R2（2-16 `EVEN`，起始周 2 为偶）、R3（1-1 与 16-16 两段 `ALL`）；`boundary` B2（1-15 `ODD`）、B4（第 34 周被丢弃后只剩 1-1 `ALL`）。上游把周次展开成数组再按「课程名+教师+地点+星期+节次」合并取并集（上游第 366-389 行），不区分单双周 |
| 3 | 无星期表头兜底 | **不适用，且不猜**。本件走接口 JSON，星期直接来自 `SKXQ`（`parse.js:191`），不解析课表 HTML 表格。`SKXQ` 不在 1-7 的行按缺字段计数进 `warnings`（`parse.js:203-207`），不推断。用例：`boundary` B7（`SKXQ = 8` → 计入跳过） |
| 4 | 时间合法性 | **过，且不再依赖教务**。本件不发节次时间请求（§1），`periodTimes` 直接取内置的夏/冬两张表（`parse.js:30-55`，11 节），两张表都是本校教务处公布的作息，与上游逐字相同（§7 第 8 条）。季节按 `data.today` 的月份选：5~9 月夏季、其余冬季（`parse.js:174-176`）；`data.today` 不是合法 `yyyy-MM-dd` 时 `monthOfIso` 返回 `null`，一律按冬季。课表用到的节次超出作息表时（本件 11 节），**保留课程**并计数提醒（`parse.js:216`、`:305-307`）。用例：`boundary` 的「边界十一」（第 12-13 节）；`calendar`（`today = 2026-03-02` → 冬季表）、`boundary` / `total-below`（同为冬季）、`basic` / `teacher` / `summer-term`（9 月 / 7 月 → 夏季表），四个月份把两张表都钉住了。上游对 `JSJC > 11` 的课**直接 `throw`**（上游第 45、334 行），整单失败 |
| 5 | `warnings` 上限 | **过**。本件的提示是**固定 9 个位置**拼出的数组（`parse.js:298-316`），没有任何一条由数据长度决定，条数最多 9 条（远低于 20 条上限）。实测：单条最长 50 字（开学日推算那条，`basic` / `boundary` / `teacher` / `summer-term` 各有一处），单用例最多 6 条（`boundary`）。`parse.js` 里没有 `warn()` 之类的截断函数，因为不需要 |
| 6 | 分页与记录总数对账 | **不适用分页，但对账**。金智这个接口一次性返回整学期排课，没有分页参数；上游也只请求一次，不翻页。教务在 `xskcb.totalSize` 里报了记录总数时（`extract.js:100-101`），`parse.js:290-293` 与实际行数对账，取到的少就出声（提醒文字：「教务系统说这个学期有 N 条排课记录，实际只取到 M 条，课表可能不完整，请重新提取或反馈」）。用例：`total-below`（教务说 5 条、实际 1 条 → 提醒）；`calendar`（3 条对 3 条 → 不误报） |
| 7 | 学期名 | **过，有用例**。`termNameFrom`（`parse.js:134-140`）把学期代码 `2026-2027-1` 映射成「2026-2027学年第一学期」，`1` / `2` / `3` 分别是第一学期、第二学期、夏季小学期（`3` 是西交的小学期，见上游第 57 行注释「1=第一学期, 2=第二学期, 3=夏季小学期, 4=暑假」）。`parse.js:322` 的顺序：先取教务给的 `MC`；没有就用上面的映射拼「西安交通大学 + 学年学期」；再没有就用「西安交通大学」。用例：`calendar`（教务给了 `MC`，原样采用）、`basic` / `boundary` / `teacher`（映射出第一学期）、`total-below`（第二学期）、`summer-term`（夏季小学期） |
| 8 | 教师、教室拿不到就留空 | **过，有用例**。读不到就是 `null`，**不写「未知教师」「未知地点」**。`teacherOf`（`parse.js:153-161`）按 `/`、`、`、`,`、`，`、`;`、`；` 拆分，丢掉空片段与**含数字的片段**（教务常写「姓名/工号」，工号不是教师），去重后以「、」连接。`locationOf`（`parse.js:164-169`）**教室优先、校区兜底**：`JASMC` 有就用它，为空才退到 `XXXQDM_DISPLAY`，都没有是 `null` —— 与上游同序（上游第 340-347 行），**不拼成「教室（校区）」**。用例：`teacher`（`张三/2024011234` → `张三`；`李四、王五` → `李四、王五`；`2024011234` → `null`；`赵六, 赵六` → `赵六`；`工程训练` 教室与校区都空 → `null`）、`calendar`（「操作系统」教师空 → `null`；「体育（二）」`JASMC` 为空 → 退到校区名）、`basic`（「大学英语」两样都空 → `null`）。上游写「未知教师」（上游第 301 行）与「未知地点」（上游第 347 行），且按 `[,，、]` 拆分后**排序**再以 `,` 连接（上游第 300-307 行），不去重也不过工号 |
| 9 | `allowHosts` | **过**。`allowHosts: []`。三条请求都是 `loginUrl` 主机上的绝对路径，无通配。`extract.js` 里只有 `ehall.xjtu.edu.cn` 一个主机名 |
| 10 | 变异测试 | **已做，见 §6**。20 处改动，逐条让对应 fixture 变红，**没有一条变异逃过 fixture**。原件 `jw-adapters/xjtu/parse.js` 从未被改动 |

## 5. 与模板件的差异（模板件：`nuist/`，同为金智 wdkb，本批已审计）

- `manifest.json`：`key` / `initial`（`X`）/ `name` / `author` / `loginUrl` 全部换成本校，
  `loginUrl` 为 `https://ehall.xjtu.edu.cn/`。`allowHosts` 同为 `[]`。fixture 共六条。
- `parse.js`：骨架（`text` / `intOf` / `pad2` / `isoDayOf` / `monthOfIso` / `mondayOnOrBefore` /
  `findCalendarRow` / `runsOf` 的极大段口径 / `MAX_WEEKS = 30` / 提醒的固定顺序）与模板件相同。
  本件的实质改动：
  - 夏/冬两张作息表（`parse.js:30-55`）换成本校的 **11 节**与两种换季时刻：夏季 5/6 节 14:30 / 15:30、
    9 节 19:40；冬季 5/6 节 14:00 / 15:00、9 节 19:10。第 1-4 节两季相同。
  - 换季的判定沿用上游口径（5~9 月夏季），但依据是 `extract.js` 交进来的 `data.today` 的月份，
    不是脚本读到的时间 —— 这样 fixture 可复现。`monthOfIso` 在 `today` 不合法时返回 `null`，
    走冬季（模板件按同一个月份区间分季节）。
  - `teacherOf` 的分隔符扩到 `/、,，;；`，并丢掉**含数字**的片段（模板件没有工号这一层）。
  - 校历行按 `XN` / `XQ` 匹配（`findCalendarRow`），不是取第一行。
  - 学期名映射把 `3` 认成「夏季小学期」（`parse.js:138`，模板件同）。
  - 模板件有而本件**没有**的那一块：本件不发节次时间请求，所以没有「教务节次表优先、
    不合法整表作废」的那段校验（模板件的 `normTime` / `periodTimesFrom` 及其两条提醒）。
- `extract.js`：骨架（`postJson` / `rowsOf` / `termFromDate` / 两个 `fetch*` / `pick` / 白名单）与模板件相同。
  本件的改动：`BASE` 写死本校 `loginUrl` 主机（模板件也写死本校主机，两者做法一致）；
  课表接口多报一个 `totalSize` 用于对账；`fetchCalendar` 拆出 `XN` / `XQ` 传参；
  403 的提示文案指向本校的应用名「我的课表」。模板件里那条节次时间的 `fetch*` 本件没有。
- fixtures：六对全部是本件自编的**合成用例**（manifest 的用例名一律以「合成用例：」开头）。
  每个 `expected` 先按规格手推，再跑本地自检核对，结果逐条一致。

## 6. 变异测试记录

变异在临时副本上做（`%TEMP%/xjtu-mutate/<变体>/xjtu/`，目录名为 `xjtu`，自检按目录名核对 `key`）。
每个变体只改一处；改完跑自检。原件 `jw-adapters/xjtu/parse.js` 从未被改动。
基准（当前件）：`parse.js` sha256 `8f6686811ba6754a2697bf29d350dd5f60feb5447e9da3685bdaf247f113d06a`（339 行），
`extract.js` sha256 `c4d3b550102f1f0976c1f97e904db275528bb0d313162ac6a0fa71a5ef841ba7`（153 行）。
临时副本在 AUDIT 定稿后删除。

| 变异 | 改了什么 | 结果（fixture） |
|---|---|---|
| M01 | 季节判定恒为夏季（`parse.js:175`） | **FAIL (3)**：`calendar`、`boundary`、`total-below` 变红（这三件在冬季，作息表换了） |
| M02 | 位图第 i 位当成第 i 周而不是第 i+1 周（`parse.js:107`） | **FAIL (6)**：全部六件变红（周次整体前移，`startWeek` 跌破 1） |
| M03 | 单双周判反（`parse.js:125`） | **FAIL (3)**：`basic`、`boundary`、`teacher` 变红（三件都有步长 2 的段） |
| M04 | 总周数优先用 `ZZC` 而不是 `ZJXZC`（`parse.js:269`） | **FAIL (2)**：`calendar`（18 而非 16）、`total-below`（18 而非 16，提醒文案跟着变） |
| M05 | 教师片段不再过滤含数字的（`parse.js:156`） | **FAIL (1)**：只有 `teacher` 变红（工号被当成教师） |
| M06 | 教师姓名不再去重（`parse.js:158`） | **FAIL (1)**：只有 `teacher` 变红（`赵六、赵六`） |
| M07 | 教室不再优先用 `JASMC`（改为只认校区名，`parse.js:166`） | **FAIL (4)**：`basic`、`calendar`、`teacher`、`summer-term` 变红 |
| M08 | 超过 30 周的周次不丢弃（`parse.js:211`） | **FAIL (1)**：只有 `boundary` 变红（第 34 周被保留，`endWeek` 超出 `totalWeeks`） |
| M09 | 总周数不再为课表里的最大周让路（`parse.js:276`） | **FAIL (1)**：只有 `total-below` 变红 |
| M10 | 开学日不再回退到周一（`parse.js:97`） | **FAIL (1)**：只有 `calendar` 变红（校历给的 2026-02-25 是周三，本件应回退到 02-23） |
| M11 | 记录总数不再对账（`parse.js:291`） | **FAIL (1)**：只有 `total-below` 变红 |
| M12 | 教室丢掉校区兜底（`parse.js:168`） | **FAIL (1)**：只有 `calendar` 变红（「体育（二）」的 `JASMC` 为空，该退到校区名却没了） |
| M15 | 节次超出作息表不再计数（`parse.js:216`） | **FAIL (1)**：只有 `boundary` 变红 |
| M16 | 缺字段的脏行不再计数（`parse.js:205`） | **FAIL (1)**：只有 `boundary` 变红 |
| M17 | 位图长度不再当学期周数（`parse.js:200`） | **FAIL (1)**：只有 `boundary` 变红（推算的总周数由 34 变 16） |
| M18 | 周次不再切极大段（`parse.js:120`） | **FAIL (5)**：`basic`、`calendar`、`boundary`、`teacher`、`summer-term` 变红（段数与期望不同）；`total-below` 只有一段，不受影响 |
| M19 | 同一门课的同一教师不再合并（`parse.js:220`） | **FAIL (1)**：只有 `teacher` 变红（`大学物理/张三` 的两条排课不再合成一门课的两段） |
| M20 | 学期名不再映射第一/第二/夏季小学期（`parse.js:138`） | **FAIL (5)**：`basic`、`boundary`、`teacher`、`total-below`、`summer-term` 变红；`calendar`（教务给了 `MC`）不受影响 |
| M21 | 校历行不再按 `XN` / `XQ` 匹配（`parse.js:147`） | **FAIL (2)**：`calendar`、`total-below` 变红（开学日与总周数双双走推算） |
| M22 | 占位行也当脏行计数（`parse.js:197`） | **FAIL (1)**：只有 `boundary` 变红（跳过数由 5 变 6） |

20 条全部被 fixture 钉住，**没有一条逃过**。几条单件变红（M05、M06、M08、M09、M10、M11、M12、M15、M16、M17、M19、M22）
说明对应的分支只由一件 fixture 守着；如果将来删用例，要先看这张表。

编号 M13 / M14 是**空号**：它们原来钉的是「节次号从 1 起连续」与「结束晚于开始」两条校验
（分别由 `timeslots-bad`、`timeslots-time` 守着），随 `jc.do` 一起删掉了（§1）。保留空号是为了让本表与
改动前的记录对得上，也为了提醒：这两条能力现在**不存在**，不是忘了测。

## 7. 上游删改与理由

1. **两段式**：上游在一段脚本里弹窗、取数、解析、保存。本件按移植手册 §3 切成 `extract.js`（只取数）
   与 `parse.js`（纯转换，CI 用 Rhino 实跑）。
2. **弹窗与学期选择全部去掉**（上游 `fetchTermOptions`、`selectTerm`，第 84-135 行；学期列表接口
   `xnxqcx.do`，上游第 90 行）。上游让用户在弹窗里选学期（默认当前学期，可翻到前后学年的五个学年）。
   本件只取当前学期（`dqxnxq.do`），用户在教务页面里切好学期再点「提取课表」。
   理由：少一条请求、少一处用户输入；要导别的学期在教务页面切比在弹窗里选更清楚，也不会选错到别人学期的课表。
3. **主机写死**（上游用相对当前源的根路径）：见 §1 第 1 条。
4. **不再要教务的节次时间**：上游本来也没有这条请求（它只有两张写死的表），是本件一度多加了
   `jc.do`，在真机上返回 403 后删掉。详见 §1 那一节。
5. **脏行不再让整单失败**。上游 `parseCourseRow`（上游第 315 行起）与 `parseStrictUnsizedInt`
   （上游第 284 行）对缺课名（第 321 行）、星期不在 1-7（第 327 行）、节次倒挂或 `JSJC > 11`（第 334 行）、
   位图非法（第 269 行）、位图全零（第 340 行）、非整数字段（第 287、291 行）一律 `throw`：
   **课表里有一条脏数据，整次导入就失败**。本件按缺课名、星期、节次、周次四类过滤，跳过并计数，
   写进 `warnings`（`parse.js:203-207`）：一条脏数据不挡其余课程。
6. **能拿到的信息尽量留**：上游写「未知教师」（第 301 行）、「未知地点」（第 347 行），本件留 `null`。
   上游教师按 `[,，、]` 拆分后排序再以 `,` 连接（第 300-307 行），本件拆 `/、,，;；`、丢掉含数字的片段、
   去重、以 `、` 连接、**不排序**（排序会打乱教务给的署名顺序）。教室两边都是「`JASMC` 优先、校区兜底」，
   本件照抄上游的顺序，不额外拼校区名。
   上游按「课名+教师+地点+星期+节次」合并并把周次取并集（第 366-389 行）；本件按「课名+教师」归成一门课、
   下面挂多条安排（`parse.js:220`），地点可以逐段不同 —— 载荷本身有 `blocks`，不需要上游那种扁平化。
7. **周次上限**：上游对课表周次没有上限（`parseWeekBitmap` 只枚举起位，第 267-282 行），
   位图第 34 位就得到第 34 周。载荷规范要求 `totalWeeks ∈ 1..30`，本件把超过 30 的周次丢弃并计数
   （`parse.js:209-214`），总周数超过 30 时按 30 收口并提示（`parse.js:274`、`:281-283`）。
8. **作息**：上游有两张写死的表（上游第 7-36 行），按本机月份的 5-9 月 / 其余二选一（上游第 396-410 行）。
   本件只保留这两张表（`parse.js:30-55`），**逐字相同**（已与上游快照逐节比对过数值）。
   与上游的唯一区别是季节的判定依据：上游用脚本自己读到的月份，本件用 `extract.js` 交进来的 `today`
   （§5），同样按 5~9 月为夏季。
9. **总周数口径**：上游 `Math.max(termWeeks || 0, maxCourseWeek) || DEFAULT_NUM_OF_WEEKS`
   （上游第 407 行），兜底 16 周（上游第 41 行），`MAX_NUM_OF_WEEKS = 32`（上游第 42 行）只用来**校验**
   `ZJXZC` / `ZZC` 是否越界（上游第 232 行），不截断课表周次。本件：教学周数 `ZJXZC` 优先、没有才用
   `ZZC`（与上游同序），都没有就**按位图长度推算**（金智位图口径，模板件同；上游不用长度，见 §5 的注释说明），
   上限按载荷规范收口到 30，再按课表里的最大周抬高，并**区分「教务给的」与「推算的」两种提醒文字**
   （`parse.js:278-287`）—— 上游只有一句 console 输出，没有面向用户的提示。
10. **单双周不展开**：上游把周次展开成逐周数组（上游第 366-389 行）。本件切成极大段
    （`ALL` / `ODD` / `EVEN`，`parse.js:113-131`），与载荷的 `weekType` 对齐。
11. **假期学期（`4`）不做特殊处理**：上游的学期列表里有「4=暑假」（上游第 57 行注释），
    本件只取当前学期，若教务把当前学期报成 `4`，`termNameFrom` 会退到「第 4 学期」。
    没有真实样本，见 §9。
12. **ES5 降级**：去掉模板串、箭头函数、`const` / `let`、`async` / `await`（改成 then 链）、解构与展开、
    `for…of`、`Map` / `Set`、`??` / `?.`；注释里也不写这些关键字的原文。
13. **删去上游的 `console.log` / `console.warn` 调试输出**（上游有近二十处，不影响结果）。

## 8. 已知风险

- **fixture 全是合成的**：六对 fixture 都保证同样输入得到同样输出，但不保证解析在真实西交页面上正确。
  与 `cauc/` 不同，本件的 fixture 里**没有** `_note` 字段，合成这一事实只写在 `manifest.json`
  的用例名（一律以「合成用例：」开头）与本表里。已按 §9 的办法用一次真实抓取做核对，但**没有**把
  真实响应留成 fixture（里面是真人课表）。
- **真实抓取只做过一次**：用一位在校生的会话抓到过一个学期的排课（17 行，学期代码 `2026-2027-1`，
  校历 `XN=2026-2027 / XQ=1 / XQKSRQ=2026-09-14 / ZJXZC=16 / ZZC=18`，`totalSize` 与实际行数同为 17）。
  这一次抓取**推翻了两处原先的设计**，都已按它改掉：
  - `jc.do` 返回 **403** → 删掉这条请求与整套教务节次机制（§1）。
  - 17 行的 `XXXQDM_DISPLAY` **全是同一个校区名**，而 `JASMC` 基本都有值 → 原先「教室拼成
    「教室（校区）」」的写法会给每一门课都加上同一条校区尾巴，改成上游那样的 `JASMC` 优先（§4 第 8 条）。
- **写死 ehall 主机的代价**：如果用户的会话只建立在 `jwxt.xjtu.edu.cn` 上，本件的三条请求会失败，
  而上游（相对当前源）可能成功。本件已把 403 与 HTTP 错误的文案写成可执行的指引
  （「请在页面里点开一次「我的课表」…」），但**未在设备上验证**。
- **`cxjcs.do` 是否存在于本校未验证**：只读附加接口，取不到不影响导入，但开学日与总周数会回落到推算值。
  上面那次真实抓取**取到了**校历行，所以这条路是通的 —— 但只验过一次、只验了一个学期。
- **`totalSize` 字段名未核对**：按金智惯例取 `datas.xskcb.totalSize`（`extract.js:100`）。
  上面那次抓取里它等于实际行数（17），但没有第二次样本；取不到时 `rowTotal` 为 `null`，对账自动跳过，不报错。
- **位图长度是否等于学期周数：真实数据说「不等于」**。那次抓取的 17 行里，`SKZC` 长度出现
  16 / 18 / 19 三种，而教务给的 `ZJXZC` 是 16。本件只在教务**没给** `ZJXZC` / `ZZC` 时才用位图长度推算
  （`parse.js:272`），所以该次没有走这条路；但这说明**推算路径天然会偏大**（会取到 19），
  只能当兜底，不能当依据。这条已从「未核对」升级为「已知不准，且已限定影响面」。
- **`SKJS` 的写法**：本件按「含数字的片段不是教师」处理工号。如果某位教师的姓名里真的带数字
  （少数民族姓名转写、外教等），会被误删。上游不做这个过滤。
- **同一门课的不同教学班**：本件按「课名+教师」分课，同一位教师在同一学期教两个教学班的同一门课
  （不同时间）会被合成一门课的两段安排。上游按「课名+教师+地点+星期+节次」分，会分成两条。
  哪种更合用户预期未定，见 §9。
- **`weekType` 的奇偶按起始周判断**：`runsOf` 里步长 2 的段按 `startWeek` 的奇偶记 `ODD` / `EVEN`
  （`parse.js:125`）。如果教务发的位图出现的段是「第 2、4、…、16 周」这种双周，记 `EVEN` 是对的；
  但如果一段里既有单周又有双周（会被切成两段），也不会出错。没有真实样本。

## 9. 没能确定的事（交接给下一位 / 主调度）

- **宿主如何执行 `allowHosts`**：本件 `allowHosts` 留空，请求打在 `loginUrl` 主机上。
  宿主是否按 `loginUrl` 派生放行域，本件无法确认。
- **写死主机 vs 相对当前源**：本件选了写死 `loginUrl` 主机（§1）。这一条的取舍需要主调度确认：
  若宿主保证一定先把用户带到 `loginUrl`，两者等价；若用户可能停在 `jwxt.xjtu.edu.cn` 且只在那里登录，
  本件会失败。上面那次真实抓取是在 ehall 上做的，**没有**在 jwxt 上试过 —— 谁拿到第二份真实 dump，
  请在 jwxt 上也试一次。
- **推算路径的准确度**：真实数据已证 `SKZC` 位图长度不等于学期周数（§8）。如果某学期教务**没有**
  可用的校历行，本件会按位图长度推算总周数，可能偏大几周，并给出一条「已按课表推算为 N 周，请核对」
  的提醒。要不要改成更保守的兜底（例如固定 16 或取位图里的最大置位周），需要主调度定。
- **同一门课多个教学班是否该合并**（§8）：按「课名+教师」合并是本件与上游的又一处不同。
  如果西交存在「同一教师、同一课名、两个教学班」的情况，用户会看到一门课挂两段安排，
  而两个班的同学互相看到课表不同 —— 但本件没有班级信息，无法区分。
- **学期代码 `4`（暑假）**：上游第 57 行的注释写着 `4` 是暑假。本件若遇到，学期名会退到「第 4 学期」。
  没有真实样本，也没有对应的 fixture。
- **只有一次真实抓取、只有一个学期**：`2026-2027-1`（秋季）是唯一被真机验过的学期，
  夏季小学期（学期代码 `3`）、第二学期、以及任何跨学期多行的校历响应都只有合成用例。
  谁拿到新的真实 dump，替换 fixture 并重跑本地自检，仍然是最高优先级的验证。

## 10. 签名

- 上游出处：`shiguang_warehouse` → `resources/XJTU/xjtu.js`（本地只读克隆的 HEAD
  `c586957c077506a5182105ae3961ceff4d0223ce`，提交时间 2026-10-08T22:54:57+08:00；许可证 MIT，
  已对照仓库根 `LICENSE`；`resources/XJTU/adapters.yaml` 的 `import_url` 为 `https://ehall.xjtu.edu.cn`）
- 上游作者 / maintainer：`LICENSE` 的版权人是 `星河欲转`（仓库级）；`resources/XJTU/adapters.yaml`
  的 maintainer 是 `SDPD, TiaoFeng`。两个都记在这里，`manifest.json` 的 `author` 取的是后者。
  `xjtu.js` 文件头没有作者行。
- 移植者：`Stellortus`
- 本件的安全结论：八条全过，§4 十条逐条落实，未发现阻止入库的问题；
  只剩「写死主机 vs 相对当前源」一条待设备验证（§8、§9）。
