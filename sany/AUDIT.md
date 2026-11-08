# 安全审计 —— 湖南三一工业职业技术学院（sany，金智 jwapp / wdkb）

审计对象：`jw-adapters/sany/` 下的 `manifest.json`、`extract.js`、`parse.js` 与 `fixtures/`。
上游：`shiguang_warehouse` 的 `SANYEDU/sany.js`（MIT，作者及 `adapters.yaml` 维护者 Haooz）。
上游快照 `29498b026708ecb8d837c8fdc1e53b768a394e4e`；`git log -1 -- resources/SANYEDU/sany.js` 核对为 `79d6d37`，快照 HEAD 为 `29498b0`。未修改快照。

## 0. 通读结论与模板选择

任务卡建议 `hlju`（相似度 0.434）。通读后确认只有通用转换层同构：周次切段、占位词清理、提醒限长、节次扩展和字段缺失计数。取数层并不同构：`hlju` 是本科选课系统的两个 JSON 地址与 `SKSJ` 文本；本校是金智 `jwapp/sys/wdkb`，返回 `datas.cxjcs.rows` 与 `datas.xskcb.rows`，周次是 `SKZC` 位串。故没有照搬 `hlju` 的地址、文本周次解析、开学日推算或 12 节时间。

另通读同平台 `jnu` 和较早的 `dlutci` 作交叉参考。`jnu` 的 wdkb 页面门禁、信封与白名单最接近，但它只取课表且读 `SKSJ`；`dlutci` 虽读 `SKZC`，还需要学号和分页，与本校不同。最终请求、字段、学期选择、10 节时间与合并语义均以本校上游代码为准。

上游代码事实：

1. `cxjcs.do` 没有当前学期标记，选择「最近开学且不晚于今天」的一项；全都未开学时取列表第一项。请求课表用 `XNXQDM=<XN>-<XQ>`。
2. `getApiBase()` 从当前 URL 截取 `/jwapp` 之前的完整前缀，支持校内入口和带路径前缀的入口。两个地址都带 `?enlink-vpn`。
3. 上游扫描本地存储中的 JWT，只加到 `Authorization` 请求头。移植保留这一同源认证需要，但不交出令牌。
4. `SKZC` 每一位是一周，字符 `1` 表示上课；课名 `KCM`、教师 `SKJS`、地点 `JASMC`、星期 `SKXQ`、节次 `KSJC`/`JSJC`。
5. 上游只合并课名、教师、地点、星期、起止节次完全相同的记录并取周次并集；连堂不合并。
6. 上游开学日直接保存 `XQKSRQ`，总周数依次读 `ZZC`、`ZJXZC`。空课要求第 1 周从周一开始，因此移植将日期回退到同一周周一，发生变化时提醒。
7. 上游缺教师写「未知」、缺地点写「待定」，无效行静默跳过；移植改为空值或汇总提醒。
8. 上游使用 ES6、弹窗、提示条和拾光保存桥；移植全部改为 ES5 与空课载荷。

## 1. 请求域与请求清单

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| `extract.js` 首个 `post()` | POST | `<base>/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do?enlink-vpn`，空表单正文 | 读全部学期，选择最近已开学项，取 `XN`、`XQ`、`XQKSRQ`、`ZZC`、`ZJXZC` | 非 2xx、非 JSON、缺 `datas.cxjcs.rows`、空列表、缺学年学期：整次报错，不继续取课表 |
| `extract.js` 第二个 `post()` | POST | `<base>/jwapp/sys/wdkb/modules/xskcb/xskcb.do?enlink-vpn`，正文 `XNXQDM=<XN>-<XQ>` | 读个人课表 | 非 2xx、非 JSON、缺 `datas.xskcb.rows`：整次报错；空行交给 `parse.js` 报「没有解析到任何课程」 |

`<base>` 是当前 URL 中最后一个 `/jwapp` 前的完整前缀；没有匹配时退回当前源。所有请求始终与当前页面同主机，不写死 API 主机。`loginUrl` 为 `https://ehall.sanyedu.com/new/index.html`，`allowHosts` 为 `[]`，没有通配、第三方地址或其他请求。

两个请求都带浏览器现有 Cookie，表单 Content-Type 与上游一致；若本地存储找到 JWT，则只在本请求头加 `Authorization: Bearer …`。不添加额外业务参数，不重试、不翻页。上游没有分页代码，本移植也不臆造分页。

登录页（密码框或地址含 `login?`）、`new/index.html` 门户、非 `/jwapp/sys/wdkb` 页面都在 `pageProblem()` 直接报错，两个 POST 均不发生。只判断密码框是否存在，不读取其值。

## 2. 读了什么、交出去什么

| 数据 | 来源 | extract 输出 |
|---|---|---|
| `XN`、`XQ` | 选中的 `cxjcs` 行 | `term.xn`、`term.xq`，用于课表请求和学期名 |
| `XQKSRQ` | 同上 | `term.startDate`，仅前 10 字日期 |
| `ZZC`、`ZJXZC` | 同上 | `term.totalWeeks`、`term.altTotalWeeks`，由 parse 判断有效性 |
| 选择方式 | 日期比较结果 | `term.selection` 为 `date` 或 `first` |
| 本机日期 | 浏览器时钟 | `today`，只用于学期选择和开学日缺失时回落 |
| `KCM`、`SKJS`、`JASMC`、`SKXQ`、`KSJC`、`JSJC`、`SKZC` | 每个 `xskcb` 行 | `rows[]` 的七字段白名单 |
| 学期及课表其他字段 | 两个响应 | 一律不带出；包括学号、姓名、人员标识、证件号、手机号 |
| JWT | 本地存储 | 不带出，只进同源请求头；不写错误或提醒 |
| 密码、Cookie 内容、页面正文 | 页面 | 不读取、不带出 |

`parse.js` 只接收上述普通 JSON，无 DOM、网络、存储、挂钟或桥调用。输出课名、教师、教室、星期、节次、周次段、学期名、开学日、总周数与 10 节时间。教师或地点为空及「未知」「待定」「暂无」等占位词时为 `null`，课程仍导入并汇总提醒。

## 3. 移植手册 §5 八条逐条结论

1. **不碰凭据**：通过。账号密码不读；密码框只用于存在性判断。JWT 是本校接口需要的登录令牌，仅用于同源请求头，符合手册例外，绝不输出。
2. **不外发**：通过。仅上述两个同源 POST；无统计、图片信标、WebSocket 或第三方请求。
3. **请求域可控**：通过。主机为当前教务页面主机，入口主机为 `ehall.sanyedu.com`；`allowHosts: []`，无通配。
4. **只读课表**：通过。只读学期配置与个人课表；不请求成绩、学籍、个人信息、缴费。白名单阻挡响应夹带的学生信息。
5. **不埋点**：通过。无统计、上报或遥测。
6. **不动态执行远程代码**：通过。无 `eval`、`new Function`。
7. **不写页面**：通过。只查询密码框、读 URL 和本地存储；不改 DOM、不提交表单、不点击。
8. **不依赖硬编码秘密**：通过。无固定令牌、密钥、真实学号或他人信息；fixtures 全为合成课程与「教师甲」等虚构值。

`check.js` 对 `localStorage/sessionStorage/password` 的提示已人工复核：分别对应上游同源 JWT 认证与登录页零请求门禁。绝对 URL 只出现在注释中的上游仓库出处；`fetch` 只在一个 `post()` 中。

## 4. 与模板的主要差异

- **取数**：`hlju` 的选课接口改为金智 wdkb 两请求；保留上游 `/jwapp` 前缀与 `enlink-vpn`，不用资源记录找地址。
- **周次**：删除 `hlju` 的大段文本周次解析。本校只读 `SKZC` 位串，覆盖连续、单双、孤立、空洞和第 31 周。
- **学期与校历**：本校接口直接给 `XQKSRQ` 和总周数，不采用 `hlju` 的月份锚点推算；仅在日期或周数缺失时回落并提醒。
- **课程结构**：七字段结构化行直接映射，不拆 `SKSJ`；同键周次并集，连堂保持两段，原始重复行先去重再计数。
- **节次时间**：使用本校上游 10 节表，而非 `hlju` 12 节或 `jnu` 珠海 13 节。

## 5. 上游删掉或改掉的内容

- 删除 `showAlert`、`showToast`、`notifyTaskCompletion`、`saveImportedCourses`、`saveCourseConfig`、`savePresetTimeSlots` 与控制台输出。空课宿主统一保存载荷。
- 删除 ES6 语法、`Map`、`Set`、展开、异步函数等，改为 ES5 对象字典、数组和 Promise 链。
- 教师「未知」、地点「待定」改为 `null`；无效课名、星期、节次、空位串不再静默丢弃，按原因计数。
- 重复行先按七字段内容去重，避免无效行和超界周次的提醒被重复放大。
- 总周数缺失时不再可能落为 0：`ZZC` 不是合法正整数时先取上游的第二字段 `ZJXZC`，两者都无效才用 20 周并提醒；课表更晚才抬高；超过 30 周按载荷上限截断并提醒。
- 开学日回退到周一；日期无效才用 `today` 所在周周一并明确提醒。
- 第 11 节起按统一 H3 顺推，课间 5 分钟、每节 45 分钟；越过 23:59 不编造时间，课程保留并提醒。
- 学期名用 `XN` + `XQ` 生成「2026-2027学年第一学期」；不规则时退回学校名与原文，不用适配器名。

## 6. 节次时间逐节对照

上游 `SANY_TIME_SLOTS` 与 `parse.js` 的 `PERIOD_TIMES` 一致：

| 节 | 时间 | 节 | 时间 |
|---|---|---|---|
| 1 | 08:20-09:05 | 6 | 14:55-15:40 |
| 2 | 09:15-10:00 | 7 | 15:50-16:35 |
| 3 | 10:20-11:05 | 8 | 16:45-17:30 |
| 4 | 11:15-12:00 | 9 | 19:00-19:45 |
| 5 | 14:00-14:45 | 10 | 19:55-20:40 |

第 11、12、13 节分别顺推为 20:45-21:30、21:35-22:20、22:25-23:10；第 14 节会到次日 00:00，因此不补。`future-extend` 固定了这一边界。

## 7. fixtures 与变异测试

9 对均为合成数据，期望先按位串下标、切段规则、上游合并顺序和日期/时间规则独立手推，再运行 Rhino 比对；没有从 parse 输出回填：

1. `basic`：连续、单双位串，占位教师地点及三类无效行。
2. `weeks-bitmap`：连续、单双、孤立与空洞切段，第 31 周丢弃。
3. `merge-duplicates`：同键并集、完全重复、连堂不并、不同教室不并。
4. `future-extend`：未来学期首项、周三回退周一、默认 20 抬到 22、11-14 节边界。
5. `long-warnings`：四门长课名缺教师地点，点名单个截 20 字、整句不超 200 字。
6. `dirty-duplicates`：五种无效记录重复出现，去重后计数不放大。
7. `alt-weeks`：`ZZC` 为空、`ZJXZC=22` 时按备用总周数取 22 周，不回落成默认 20，也不重复「没有给出总周数」提醒。
8. `start-invalid`：`XQKSRQ` 为空或非法时用本机日期所在周周一（2026-11-03 → 2026-11-02）并明确提醒。
9. `weeks-clamped`：`ZZC=40` 超过载荷上限时按 30 周导入并提醒，不把 40 写进载荷。

变异副本只放 `C:/Users/23703/AppData/Local/Temp/sany-port30/`，正式目录不直接改坏；脚本留档为 `.test/port-batch30/sany/mutate.py`，要求每处目标串恰好命中一次，否则判 SETUP FAIL。2026-11-08 实测 7/7 被捕获：

| 编号 | 改坏处 | 捕获用例 |
|---|---|---|
| M1 | `weeksOf()` 把周号从 `i + 1` 改成 `i` | 6 对全部 DIFF，覆盖第 1 周和单双周归属 |
| M2 | 同键 `unionWeeks()` 改成只保留当前行周次 | `merge-duplicates` DIFF，1-16 周退成 9-16 周 |
| M3 | 扩展课间从 5 改成 10 分钟 | `future-extend` DIFF，第 11-13 节时间全错 |
| M4 | 删除原始重复行去重 | `dirty-duplicates` DIFF，5 条被放大为 11 条、越界计数翻倍 |
| A1 | 忽略 `ZJXZC` 备用总周数 | `alt-weeks` DIFF，22 周退成默认 20 |
| A2 | 开学日缺失时直接取本机日期而不回退周一 | `start-invalid` DIFF，`2026-11-02` 变 `2026-11-03` |
| A3 | 同时移走两处 30 周钳制 | `weeks-clamped` DIFF，载荷写成 40 周 |

A3 需要一次改两处：第一处 `configuredWeeks > MAX_WEEK` 与第二处 `totalWeeks > MAX_WEEK` 互为兜底，单改任一处仍会得到 30 周、提醒不变，故这条 fixture 钉住的是「总周数不超 30」这一整体行为，而不是某一行。全部还原后正式目录自检 9 对 MATCH，`RESULT: PASS`，`parse.js` SHA-256 仍为 `e54421bdd8e068c2186de21a1e0b623974ac80147cfa77e6a331d0495d076b7e`、`extract.js` 为 `97e8cdb735c14530942859659545ba26b6a92d6981757cb69448166fd286c99e`（本轮另删除 `extract.js` 中没有引用的 `SEMESTER_FIELDS` 常量，行为不变）。行号容易漂移，本审计一律按函数名定位。

## 8. 本地浏览器冒烟

`.test/port-batch30/sany/smoke.py` 用 Playwright Chromium 拦截全部地址到假站，不联网；真实执行 `extract.js`，再以 Rhino 1.8.0 执行 `parse.js`。2026-11-08 复跑 10/10 OK（本机随带 Chromium 已缺失，以 `NC_PW_CHANNEL=msedge` 复用系统 Edge；不设该变量时行为不变）：

- `normal`：依次 POST 学期与课表地址，查询串均为 `enlink-vpn`；正文分别为空和 `XNXQDM=2026-2027-1`。选择 2026-09-07 的最近已开学学期，位串和占位词正确。
- `prefix`：当前页带 `/https/local-prefix` 时，两请求均打到 `/https/local-prefix/jwapp/...`，验证上游特有前缀逻辑。
- `token`：合成 JWT 只出现在 `Authorization: Bearer …` 请求头，不出现在 extract 或载荷；无令牌场景不多加请求头。
- `login`、`portal`、`other`：分别提示登录页、教务首页、打开我的课表，POST 数均为 0。
- `no-semester`、`term500`、`badkb`、`empty`：空学期、500、课表 HTML、空课表均给出预期错误。
- 所有正常场景的合成学号、姓名、证件号、手机号、人员标识均未出现在输出；请求正文不含个人信息。

## 9. 已知风险与未验证项

- **没有本校账号，真实教务与真机未验证。** 页面路径、响应字段和节次以快照代码为依据；合成 fixture 与假站不能证明线上返回完全一致。
- `scheduleUrlHint` 按金智 wdkb 标准模块地址写为 `/jwapp/sys/wdkb/*default/index.do`；上游只给门户入口与接口路径，没有直接给出模块首页，需真机确认。
- 上游没有分页或空 `totalSize` 特判，本移植也不增加。若真实课表分页，当前只能读取响应中的 `rows`，可能少课；无效或空结果会提醒，但分页缺失本身无法识别。
- 学期选择完全沿用日期启发式；全部未来时取第一项并不保证是学校期望学期，已用醒目提醒。无合法日期时才用本机周周一。
- 固定 10 节时间可能随学期调整；第 11 节起是推算值，均有提醒。
- 位串只按上游认字符 `1`，没有位串长度与总周数交叉校验；第 31 周起丢弃并计数。
- 令牌扫描是上游兼容逻辑，真实存储键或认证方式若变化，可能只能依靠 Cookie；不会为排错输出令牌。
- 带路径前缀的场景已在合成 URL 验证，但未在真实 WebVPN 网关上验证重定向、Cookie 或授权行为。

## 10. 签名

0x7E7-2023（haiku 移植，2026-11-03）
复审与修正：0x7E7-2023（batch-30 复审，2026-11-08）——新增 `alt-weeks`、`start-invalid`、`weeks-clamped` 三对 fixture 及 A1/A2/A3 变异，留档 `.test/port-batch30/sany/mutate.py`，自检 9/9 MATCH、变异 7/7 捕获、假站 10/10 OK。
