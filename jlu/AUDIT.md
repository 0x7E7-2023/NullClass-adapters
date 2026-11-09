# 安全审计 —— 吉林大学（jlu，金智 jwapp / wdkb）

审计对象：`jw-adapters/jlu/` 下的 `manifest.json`、`extract.js`、`parse.js` 与 `fixtures/`。
上游：`shiguang_warehouse` 的 `JLU/JLU_01.js`（MIT，作者及 `adapters.yaml` 维护者 Leimeng52mc）。
上游快照 `baf83fa`（2026-11-09 与 origin/main 对齐）；`git log -1 -- resources/JLU/JLU_01.js` 核对为 `ca9632c`
（2026-09-17，`feat(JLU): 重构调课逻辑并新增 WebVPN 入口 (#718)`）。任务卡写的 `2e1e720` 在本仓库存在，但它是全仓最后提交、
不修改 `resources/JLU/`，故以 `ca9632c` 为脚本版本依据；未修改快照。

行号在改代码后容易漂移，本审计一律按函数名 / 段落名定位。

## 0. 通读结论与模板选择

模板 = `jw-adapters/sany`（批次三十，金智 `jwapp/sys/wdkb`，已审计）。同构的部分：金智统一信封 `datas.<键>.rows`、
`SKZC` 位串口径、同源 POST 与字段白名单、占位教师/教室改 `null`、提醒统一出口与限长、课表用到表外节次时按「统一修订 H3」顺推。

不同构的部分（全部按本校上游代码重写，没有照抄模板）：

1. 请求：模板两个 POST；本校上游有七个接口，去掉弹窗用的学期列表后实际发六个。
2. 学期：模板按「最近开学且不晚于今天」的日期启发式；本校直接用 `dqxnxq.do` 给的当前学期，不猜。
3. 节次时间：模板是写死的 10 节表；本校上游从 `jc.do` 读启用节次（`SFSY=1`、`DM`、`KSSJ`、`JSSJ`），没有写死表。
4. 调课 / 停课：模板没有；本校必须按 `xsdkkc.do` 应用，否则学生看到的是没变的旧课表。
5. 未定时间课程：模板没有；本校 `xswpkc.do` 只用于提醒，不导入。
6. 基址：模板支持 `/jwapp` 前缀；本校上游按 `/jwapp/sys/` 截取，并因此天然支持 Sangfor WebVPN 的 `/https/<会话 hex>` 前缀。
7. 认证：模板扫描本地存储里的 JWT 并只放进同源请求头；本校上游只用教务会话 Cookie，不读本地存储。移植删掉了 JWT 扫描。

上游代码事实：

- `PAGE_URL` 里找不到 `/jwapp/sys/` 就提示并停止；`SITE_BASE` 是它之前的完整前缀，`REFERER` 是当前页 URL。
- 六个业务请求都是 POST：`dqxnxq.do`（空体）、`cxxljc.do`（`XN`、`XQ`）、`jc.do`（空体）、`cxxszhxqkb.do`（`XNXQDM`，不传 `SKZC`）、
  `xsdkkc.do`（`XNXQDM`、`*order=-SQSJ`）、`xswpkc.do`（`XNXQDM`）。`xnxqcx.do` 只服务上游的「选择其他学期」弹窗，本移植不弹窗故不请求。
- 周次是 `SKZC` 位串，`parseWeeksFromSkzc` 只看每个字符是不是 `1`，下标从第 1 周起。
- 教师 `SKJS` 形如「姓名/工号」，多名用英文逗号分隔；上游按逗号分段、每段取斜杠前的名字。
- 校历 `cxxljc` 取第 1 行的 `XQKSRQ`（开学日，含时间）与 `ZZC`（总周数，缺失时上游写 18 或 20）。
- 调课/停课按 `KBID` 匹配原课：`SKZC` 是本次被调走的周次，`XSKZC`/`XSKXQ`/`XKSJC`/`XJSJC` 齐全就另排一条，
  同 `KBID` 同星期同节次同教室已存在则并入周次；周次清空的课删掉。
- 上游没有分页、没有校区选择、没有成绩/学籍等其它接口。

## 1. 请求域与请求清单

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| `extract.js` `post()` 第 1 次 | POST | `<base>/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do`，空正文 | 当前学期 `DM`、`MC` | 非 2xx、非 JSON、缺 `datas.dqxnxq.rows`、`DM` 不是 `学年-学年-学期`：整次报错，不继续 |
| 第 2 次 | POST | `<base>/jwapp/sys/wdkb/modules/xskcb/cxxljc.do`，正文 `XN=<学年>&XQ=<学期>` | 校历：`XQKSRQ`、`ZZC` | 失败交空数组；`parse.js` 按本机日期推开学日、总周数用 20 并提醒 |
| 第 3 次 | POST | `<base>/jwapp/sys/wdkb/modules/jshkcb/jc.do`，空正文 | 节次时间 `DM`、`KSSJ`、`JSSJ`、`SFSY` | 失败交空数组；`parse.js` 交空 `periodTimes`（应用用默认节次时间）并提醒 |
| 第 4 次 | POST | `<base>/jwapp/sys/wdkb/modules/xskcb/cxxszhxqkb.do`，正文 `XNXQDM=<学期编号>` | 个人课表行 | 非 2xx、非 JSON、缺 `datas.cxxszhxqkb.rows`：整次报错；空行交给 `parse.js` 报「没有解析到任何课程」 |
| 第 5 次 | POST | `<base>/jwapp/sys/wdkb/modules/xskcb/xsdkkc.do`，正文 `XNXQDM=<学期编号>&*order=-SQSJ` | 调课 / 停课记录 | 失败交 `null`（与「没有调课」的空数组区分），`parse.js` 提醒课表可能没反映调整 |
| 第 6 次 | POST | `<base>/jwapp/sys/wdkb/modules/xskcb/xswpkc.do`，正文 `XNXQDM=<学期编号>` | 未定时间课程（只提醒，不导入） | 失败按没有处理；不影响课表 |

`<base>` 由 `apiBase()` 从当前页 URL 的 `/jwapp/sys/` 之前截取；没有匹配时（理论上被 `pageProblem()` 拦下）退回当前源。
所有请求始终与当前页面同主机，没有写死 API 主机，也不请求第三方。六个请求都带 `credentials: 'include'` 与
`X-Requested-With: XMLHttpRequest`（上游同样带这两项和 `Accept`）；正文非空时带表单 `Content-Type`。

上游还写了一个 `Referer: <当前页 URL>` 请求头。`Referer` 是浏览器禁止脚本设置的请求头，写了也会被丢弃，
同源请求本来就会自动带当前页 Referer；移植没有写这条无效请求头，实际发出的 Referer 行为与上游一致。

`loginUrl` = `https://iedu.jlu.edu.cn/`，`allowHosts` = `["iedu.jlu.edu.cn", "vpn.jlu.edu.cn"]`，无通配。
`scheduleUrlHint` = `https://iedu.jlu.edu.cn/jwapp/sys/wdkb/*default/index.do`：上游只给了接口路径与「我的课表」页面要求，
没有给模块首页，这里按金智 wdkb 的模块入口写法拼出，需真机确认。

## 2. WebVPN 基址与会话相关说明

上游支持经 Sangfor 网页 VPN 访问，基址形如 `https://vpn.jlu.edu.cn/https/<会话 hex>`。这个 hex 由 WebVPN 网关按会话签发，
**不能硬编码**：`apiBase()` 直接从当前页 URL 的 `/jwapp/sys/` 之前截取，所以直连时是 `https://iedu.jlu.edu.cn`，
WebVPN 时是 `https://vpn.jlu.edu.cn/https/<当前会话 hex>`，同一份代码两边都能用。
`allowHosts` 同时声明 `iedu.jlu.edu.cn` 与 `vpn.jlu.edu.cn`，没有通配。

`pageProblem()` 在三种页面上零请求直接提示：页面上有密码框（登录页）、URL 含 `login`（WebVPN 登录页）、
URL 不含 `/jwapp/sys/`（门户或别的页面）。WebVPN 登录页含密码框和 `login`，两条都会命中。

## 3. 读了什么、交出去什么

| 数据 | 来源 | extract 输出 |
|---|---|---|
| 学期编号 `DM`、学期名 `MC` | `dqxnxq` 第 1 行 | `term.code`、`term.name` |
| `XQKSRQ`、`ZZC` | `cxxljc` 行 | `calendarRows[]`，白名单 `XN`、`XQ`、`XQKSRQ`、`ZZC` |
| `DM`、`KSSJ`、`JSSJ`、`SFSY` | `jc` 行 | `sectionRows[]` |
| `KBID`、`KCM`、`SKXQ`、`KSJC`、`JSJC`、`SKZC`、`SKJS`、`JASMC` | `cxxszhxqkb` 行 | `rows[]` 的八字段白名单 |
| 调课：`KBID`、`KCM`、`SKZC`、`SKXQ`、`KSJC`、`JSJC`、`YSKJS`、`JASMC`、`XSKZC`、`XSKXQ`、`XKSJC`、`XJSJC`、`XSKJS`、`XJASMC` | `xsdkkc` 行 | `changeRows[]` 或 `null` |
| `KCM` | `xswpkc` 行 | `undeterminedRows[]` |
| 记录总数 `totalSize` | `cxxszhxqkb` 表 | `rowTotal`，`parse.js` 与实际行数对账 |
| 本机日期 | 浏览器时钟 | `today`，只用于开学日缺失时的回落 |
| 学号、姓名、证件号、手机号、人员标识等 | 任一响应 | 一律不带出（白名单外） |
| Cookie、密码、页面正文 | 页面 | 不读取、不带出 |

`KBID` 是排课记录号（调课靠它对回原课），不是个人信息。
`parse.js` 只接收上述普通 JSON，不碰 DOM、网络、存储、挂钟或桥。输出的教师或教室为空及「未知」「待定」「暂无」等占位词时为 `null`，
课程仍导入并汇总提醒。

## 4. 调课 / 停课处理（照上游 `applyCourseChanges`）

1. 先按 `KBID` 找原始课；本学期的课表接口里 `KBID` 唯一（上游注释称实测 11/11）。对不上原课的记录计数提醒，不静默丢。
2. 停课：把 `change.SKZC` 里为 `1` 的周次从原课去掉；只去掉周次、没有新时间的记录计入「只删没排」。
3. 调课：`XSKZC` 有周次且 `XSKXQ`/`XKSJC`/`XJSJC` 齐全时另排一条；同 `KBID` 同星期同起止节次同教室已存在则并入周次，
   否则新增。新教室依次取 `XJASMC`、`JASMC`，都没有就留空。
4. 新时间不合法（星期不在 1-7、节次倒挂、超过第 20 节）的记录不落位，计数提醒；上游对这类记录会直接排进课表，
   导致整次导入被载荷校验拒收，这里改成不落位并提醒。
5. 处理完后周次为空的课删掉；如果全部课都被删掉，`parse.js` 明确报「按调课、停课记录调整后没有剩下的课」，不静默出空学期。
6. 记录按教务返回顺序（`*order=-SQSJ`，申请时间倒序）处理，与上游一致。没有像 `ctgu` 那样改成按申请时间正序——
   本校上游不排序，保持忠实；两次连续调同一节课且互相依赖时，最终合并逻辑仍能归并同一排课位。

## 5. 节次时间

本校上游没有写死节次表，`parseTimeSlots()` 从 `jc.do` 取 `SFSY == 1` 的行，按 `DM` 排序，时间用 `KSSJ`/`JSSJ`。
移植保持一致，并把 `08:00:00`、`8:00` 这类写法统一成 `HH:mm`；时间不合法（超过 23:59、结束不晚于开始）的行丢弃。

- 一行都没取到：`periodTimes` 交空数组，应用会用默认节次时间；提醒说清楚「没能从教务取到学校的节次时间」。
- 课表用到节次时间表没有覆盖的节次（中间缺号或超出最后一条）：按「统一修订 H3」，从上一节结束时间起、课间 5 分钟、
  每节 45 分钟顺推补齐；越过 23:59 的部分不编造时间，课程保留并提醒。
- 正常情况不额外发提醒（时间本来就是学校给的），只在回落或顺推时提醒。

任务卡里提到「校区」：上游与 `jc.do`/`cxxljc.do` 都不读校区，也没有校区选择；课表按学生身份返回，移植不做校区处理。

## 6. 移植手册 §5 八条逐条结论

1. **不碰凭据**：通过。账号密码不读；密码框只用于存在性判断。本校接口只用教务会话 Cookie，无需额外令牌；
   模板里的本地存储 JWT 扫描已删除，不读、不存、不发任何令牌。
2. **不外发**：通过。仅上述六个同源 POST；无统计、图片信标、WebSocket 或第三方请求。
3. **请求域可控**：通过。主机为当前教务页面主机（`iedu.jlu.edu.cn` 或 WebVPN 的 `vpn.jlu.edu.cn`）；
   `allowHosts` 只列这两个，无通配。
4. **只读课表**：通过。只读学期、校历、节次、个人课表、调课/停课、未定时间课程；不请求成绩、学籍、个人信息、缴费。
   白名单阻挡响应夹带的学生信息。
5. **不埋点**：通过。无统计、上报或遥测。
6. **不动态执行远程代码**：通过。无 `eval`、`new Function`。
7. **不写页面**：通过。只查询密码框、读 URL；不改 DOM、不提交表单、不点击。
8. **不依赖硬编码秘密**：通过。无固定令牌、密钥、真实学号或他人信息；fixtures 全为合成课程与「教师甲」等虚构值；
   WebVPN 的会话 hex 从当前页 URL 读，不写死。

`check.js` 对 `localStorage/sessionStorage/cookie/password` 的提示已人工复核：`password` 只用于登录页存在性判断，
`Cookie` 只出现在说明本校会话认证的注释里，没有读写本地存储或 Cookie 的代码。

## 7. 与模板（sany）的主要差异

- **请求**：两个 POST 改为六个；删掉模板的学期列表与日期启发式，改用 `dqxnxq.do` 的当前学期。
- **周次**：同样读 `SKZC` 位串，但新增调课/停课后按 `KBID` 去周次、落位。
- **节次时间**：写死 10 节表改为读 `jc.do`；取不到时交空表（应用默认），不再套用别的学校的表。
- **开学日 / 总周数**：模板从 `cxjcs` 选「最近开学」行；本校从 `cxxljc` 第 1 行读，开学日回退周一，总周数缺失用 20 并抬高。
- **认证**：删除模板的 JWT 扫描；本校只用会话 Cookie。
- **WebVPN**：模板是 `/jwapp` 前缀；本校按 `/jwapp/sys/` 截取，天然带出 `/https/<hex>` 前缀。

## 8. 上游删掉或改掉的内容

- 删除 `showToast`、`showAlert`、`showSingleSelection`、`notifyTaskCompletion`、`saveCourseConfig`、`savePresetTimeSlots`、
  `saveImportedCourses` 与控制台输出；空课宿主统一保存载荷。
- 删除 ES6 语法、`Set`、展开、异步函数、可选链，改为 ES5 对象字典、数组和 Promise 链。
- 删除学期选择弹窗：按任务卡只用当前学期，因此 `xnxqcx.do` 不再请求。
- 上游教师「未知教师」、教室「待定」改为 `null`；缺教师 / 缺教室照常导入并汇总提醒。
- 上游缺课名 / 星期 / 节次 / 周次的行静默丢弃、调课对不上原课只 `console.warn`：移植改为计数提醒。
- 调课新时间不合法时不落位并提醒（上游会排进课表，导致载荷校验整单拒收）。
- 未定时间课程上游按行数报「N 门」；移植按课名去重后计数，避免同一门课多行时夸大数字。
- `Referer` 请求头（浏览器禁止脚本设置）不再写，浏览器自有同源 Referer。

## 9. fixtures

7 对，全部合成数据；期望先按位串下标、切段规则、上游调课口径、日期与时间规则独立手推，再跑 Rhino 比对，没有从 parse 输出回填：

1. `basic`：位串连续/单双周、教师「姓名/工号」只留姓名、多教师拆分、占位教师教室、缺星期/节次/周次三类无效行，
   节次时间来自 `jc` 且 `SFSY=0` 的第 7 节被排除。
2. `weeks-bitmap`：同一条排课的单周位串与双周位串合并成每周 1-8 周；连续、空洞、孤立周分别成段；第 31 周丢弃并计数。
3. `changes`：停课只去周次（两条）、调课换教师/教室/时间、同一排课位并入周次、连续两次调同一节课、对不上原课的记录、
   相同原始行去重后不放大计数。
4. `long-warnings`：三门 20 字以上长课名缺教师缺教室，未定时间课程 4 门，点名一律截 20 字且每条提醒 ≤200 字。
5. `fallback-raised`：校历与节次时间都没有、调课记录取不到；开学日按本机日期所在周周一（2026-03-05 → 2026-03-02）、
   总周数默认 20 再抬到课表的第 22 周，五条提醒逐条核对。
6. `weeks-clamped`：`ZZC=40` 截断为 30 周并提醒；课表用到第 7-8 节，按上一节 15:40 顺推 15:45-16:30、16:35-17:20。
7. `duplicate-changes`（2026-11-10 复审修正新增）：把 `changes` 里的第 2 条调课记录原样复制一份，输出必须与 `changes` 逐字相同——同一条记录只应用一次，提醒里仍是「已调整了 5 处」。

本校周次是位串，不套用「(单)1-8周」这类文字周次的解析，所以模板里钉前置单双标记与「共 N 周」剥离的用例在这里不适用，
改为钉位串的单双、空洞与超界。

`parse.js` 的学期名规则：教务给了 `MC` 就用它；没给则按学期编号生成「吉林大学 学年学期」。

## 10. 变异测试

8 处，改坏只发生在系统临时目录的副本上（`.test/port-batch31/jlu/mutate.py`，要求目标串恰好命中一次，否则判 SETUP FAIL），
正式目录始终通过自检。2026-11-09 实测 7/7 被捕获，2026-11-10 补 M8 后 8/8：

| 编号 | 改坏处 | 捕获用例 |
|---|---|---|
| M1 | `weeksOf()` 的周号从 `i + 1` 改成 `i` | `basic`、`weeks-bitmap`、`changes` 均 DIFF |
| M2 | 停课去周次失效（无条件保留原周次） | `changes` DIFF，停课周次没有被去掉 |
| M3 | 教师不按斜杠取姓名 | `basic`、`changes` DIFF，教师变成「教师甲/1001」 |
| M4 | 顺推课间从 5 分钟改成 10 分钟 | `weeks-clamped` DIFF，第 7-8 节时间错 |
| M5 | 开学日回落时不回退周一 | `fallback-raised` DIFF，2026-03-02 变成 2026-03-05 |
| M6 | 30 周截断标记失效（不报截断提醒） | `weeks-clamped` DIFF，提醒里少了截断说明 |
| M7 | 同一排课位的周次不取并集 | `weeks-bitmap` DIFF，单双两行不再合并成 1-8 周 |
| M8 | 删掉调课记录的去重判断（`if (seenChanges[changeKey]) continue;`） | `duplicate-changes` DIFF，「已调整了 5 处」变成 6 处 |

（M6 只关掉第一处截断判断；第二处 `totalWeeks > MAX_WEEK` 仍把数值压到 30，捕获的是「截断时的提醒」，不是数值。）

## 11. 本地浏览器冒烟

`.test/port-batch31/jlu/smoke.py` 用 Playwright 拦截全部地址到假教务站，不联网；真实执行 `extract.js`，再以 Rhino 1.8.0 执行 `parse.js`。
2026-11-09 复跑 10/10 OK（本机随带 Chromium 缺失，以 `NC_PW_CHANNEL=msedge` 复用系统 Edge）：

- `normal`：直连页六次 POST，正文依次为空、`XN=2025-2026&XQ=2`、空、`XNXQDM=2025-2026-2`、
  `XNXQDM=2025-2026-2&*order=-SQSJ`、`XNXQDM=2025-2026-2`；均带 `X-Requested-With`。
  停课记录去掉第 5-6 周后可解析为 1-4、7-16 两段；占位教师教室为 `null`；单周位串、调课提醒、未定课程提醒均正确。
- `prefix`：页面为 `https://vpn.jlu.edu.cn/https/abc123def456/...` 时，六次请求都打到同一前缀下，验证会话相关基址。
- `login`、`vpn-login`、`other`：登录页、WebVPN 登录页、门户首页分别给提示，POST 次数为 0。
- `no-term`：当前学期为空时 1 次请求后报错。
- `empty`：课表为空时六次请求后由 `parse.js` 报「没有解析到任何课程」。
- `no-calendar`：校历空时仍导入，开学日取本机日期所在周周一、总周数 20，并提醒。
- `changes-fail`：调课接口 500 时照常导入并提醒课表可能没反映调整。
- `no-sections`：节次接口为空时 `periodTimes` 交空表并提醒。
- 所有场景的合成学号、姓名、证件号、手机号、人员标识均未出现在 extract 输出或载荷中；课表与调课行都只有白名单字段。

## 12. 已知风险与未验证项

- **没有本校账号，真实教务与真机未验证。** 请求路径、响应字段、节次与调课字段以快照代码为依据；合成 fixture 与假站
  不能证明线上返回完全一致。
- `scheduleUrlHint` 是按金智 wdkb 模块入口拼的（`/jwapp/sys/wdkb/*default/index.do`），上游没有直接给模块首页，需真机确认跳转后
  能落在「我的课表」。
- WebVPN 的 `/https/<会话 hex>` 只在合成 URL 上验证了拼接；真实网关的重定向、Cookie 与授权行为未验证。
- 调课记录按教务返回顺序（申请时间倒序）处理，与上游一致；若学校出现互相依赖的连续调课，最终同排课位合并可归并，
  但极端顺序下可能多出一条同位置记录（应用里看起来是同一时段），未在真实数据上验证。
- 节次时间完全依赖 `jc.do`；若学校把节次时间配置错误，导入会原样采用，只在缺失或表外时提醒。
- 课表接口不翻页（与上游一致）；若响应里 `totalSize` 大于实际行数会提醒「课表可能不完整」，但分页本身无法自动读取。
- 未定时间课程接口失败时按上游静默处理，不额外提醒（该数据只用于提醒，不影响课表）。
- `ZZC` 超过 30 按载荷上限截断，学校若真有 31 周以上的安排，超出的周次会丢弃并提醒。

## 13. 签名

0x7E7-2023（haiku 移植，2026-11-09）
