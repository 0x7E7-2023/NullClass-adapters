# 安全审计 —— neu-grad（东北大学·研究生教务）

- 上游：`shiguang_warehouse` 的 `NEU/neuyjs.js`（MIT，上游作者 `Vera-zero`，上游 yaml 里
  `adapter_id: NEU_2` / `import_url: https://yjs.neu.edu.cn/`，`description` 注明
  「网页仅在校园网/连接校内vpn环境下可访问」）
  <https://github.com/XingHeYuZhuan/shiguang_warehouse>
- 移植者：`0x7E7-2023`　移植日期：2026-09-22
- 审计结论：**通过**。请求域只有一个（本校研究生教务主机，且走**当前页同源相对路径**），
  只有取课表这一个接口，不碰凭据、不读令牌、不埋点、不写页面、不 eval。

## 〇、与同校本科 `neu` 的关系

同一所学校、**不同产品线**：本科 `neu` 是 `jwxt.neu.edu.cn` 的金智 `jwapp`（WIS 本科）平台，
本适配器是 `yjs.neu.edu.cn` 的金智 **`gsapp`（WIS 研究生）**平台。域名、接口路径、响应信封、
字段名全部不同（`jwapp` 是 `{code, datas:{...}}` 信封 + `courseName`/`dayOfWeek` 字段，
`gsapp` 是 `{jgList, jcList}` 直出 + `KCMC`/`XQ` 字段），**没有可复用的取数逻辑**，
`parse.js` 是按本适配器自己的编码单独写的，没有沿用 `neu` 的 fixture 期望。

两者共享的只有一个语义结论：`XQ`（本适配器）与 `dayOfWeek`（本科 `neu`）都是**绝对星期**
（1 = 周一），这一点在本科 `neu` 的 `parse.js` 头部注释里已经点名验证过，这里延用同一结论。

## 一、请求了哪些域与路径

**只有一个域：`yjs.neu.edu.cn`（= manifest 的 `loginUrl` 主机）。**

`extract.js` 里唯一的请求是**相对路径**（`/gsapp/sys/wdkbapp/xskcb/loadPkjg.do`），落在用户
当前打开的教务页面上，主机由页面决定、脚本没有把主机名写死。

| # | 接口 | 方法 | 用途 | 必需性 |
|---|---|---|---|---|
| ① | `/gsapp/sys/wdkbapp/xskcb/loadPkjg.do` | POST，body `XNXQDM=<学年学期代码>&ZC=` | 课表行（`jgList`）+ 节次作息表（`jcList`），**上游唯一的请求** | 必须成功 |

- 请求带 `credentials: 'include'`，用的是**用户自己在 WebView 里登录后**的会话 Cookie
  （规范允许：读本校令牌用于本校接口是正常的；脚本不读、不存、不外发任何令牌）。
- `allowHosts` 为 `[]`：请求路径全是相对的，落在 `loginUrl` 同源主机，没有额外域名需要声明。
- 没有 CAS 登录域、CDN、统计域、WebVPN 网关；`ZC=` 参数留空是上游口径（上游注释没有解释
  这个参数，本移植件照抄留空，不臆测其含义）。
- `loginUrl` 是 **https**（与本科 `neu` 的 http 不同，上游 yaml 给的地址本身就是 `https://`）。
  该校研究生教务同样只在校园网/校内 VPN 内可达（上游 yaml `description` 注明）。

## 二、读了什么

- **接口数据**：`jgList`（课表行：`KCMC` 课名、`JGJSXM` 教师、`JASMC` 教室、`XQ` 星期、
  `KSJCDM`/`JSJCDM` 起止节次、`ZCBH` 周次位串）、`jcList`（节次作息表：`DM` 节次号、
  `KSSJ`/`JSSJ` 起止时间，格式为“时*100+分”的整数，如 830 = 08:30）。都是排课信息。
- **不读页面 DOM**：全程走接口，不读 `document.cookie`、不读 `localStorage`/`sessionStorage`、
  不读任何页面元素。
- **输出前剔除个人字段**：`extract.js` 用一张表把学号 / 姓名 / 身份证 / 用户 id 之类的键
  **大小写不敏感地**滤掉（`XH`/`XM`/`XH_ID`/`SFZH`/`USERID`/`USERNAME`/`USER_NAME`/
  `STUDENTID`/`STUDENTNUMBER`/`REALNAME`），与本科 `neu` 用同一张表。上游脚本本身读的
  `jgList` 字段（`KCMC`/`JGJSXM`/`JASMC`/`XQ`/`KSJCDM`/`JSJCDM`/`ZCBH`）里没有学号姓名，
  这层过滤是防御性的（万一教务接口在某次响应里多带了字段）；`jcList` 是纯节次时间表，
  不含个人信息，未做过滤。
- 不读成绩、学籍、缴费、个人信息页；上游脚本本身也没有这些接口。

## 三、手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | ✅ 脚本里没有 password / pwd / 登录表单 / 验证码；不读 `localStorage` / `document.cookie`。只用 WebView 现有会话 Cookie 请求本校接口，令牌既不读入内存也不外发 |
| 2 | 不外发 | ✅ 全部网络行为就是上表一个请求，相对路径 → 落在 `yjs.neu.edu.cn`；无 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 动态 `<script>`（`grep -nE "fetch\(\|XMLHttpRequest\|sendBeacon\|WebSocket\|\.src\s*=\|eval\(\|new Function" extract.js parse.js` 只命中 `fetch(` 本体与请求头字符串 `'X-Requested-With'`） |
| 3 | 请求域可控 | ✅ 只有一个精确主机名（= `loginUrl` 主机），无通配；`allowHosts` 空数组。请求路径是相对的、主机名不写死；`grep -noE "https?://[A-Za-z0-9.-]+" extract.js parse.js` 命中的三处绝对 URL 全部在**注释**里（出处说明），代码本体没有写死任何绝对地址 |
| 4 | 只读课表 | ✅ 唯一接口是课表 + 节次表，没有成绩、学籍、缴费、个人信息接口，也没有任何与登录人身份有关的接口。`jgList`/`jcList` 若夹带学号/姓名，`extract.js` 的 `withoutPersonal()` 会在交出前剔除（大小写不敏感） |
| 5 | 不埋点 | ✅ 无统计、上报、遥测，无第三方域名；脚本里没有 `console`，没有任何额外输出通道 |
| 6 | 不 eval 远程代码 | ✅ 无 `eval` / `new Function`；脚本自包含，无动态 `import` |
| 7 | 不写页面 | ✅ 一处 DOM 都不碰：无 `innerHTML` / `appendChild` / 表单赋值 / `submit`。取数全走接口 |
| 8 | 不依赖用户输入之外的秘密 | ✅ 无硬编码密钥、无他人学号、无固定令牌。学年学期代码按本机日期推算（见下），推算结果**总是**写进 `warnings` |

## 四、没有移植的东西（审计应知情）

- **手输学年 + 手选学期的交互没有移植**。上游让用户在弹窗里输入四位学年、再选秋/春学期，
  拼成 `XNXQDM`（如 `20261`）。这里改成**在 `extract.js` 里按本机日期自动推算**同样格式的
  代码（与本科 `neu` 的 `termFromDate` 同一套校历假设：秋季学期 9 月开学、春季学期次年
  2~3 月开学、7~8 月按春季学期猜、1 月还在秋季学期里）。**与本科 `neu` 不同的是**：
  上游 `neuyjs.js` 没有任何「当前学期」查询接口可用（`neu.js` 至少有 `kb/xnxq.do`），
  所以这里**没有「先查接口、查不到才猜」这一降级层**，推算结果**必然**写进
  `warnings`——不是「大多数情况准，个别情况要核对」，而是「每次导入都请核对」。
- **`config.semesterStartDate` 上游根本没有这个字段**（对比本科 `neu`，那边至少有一个
  校历接口可以尽力而为）。`firstDay` 因此**永远**按「提取时刻所在周的周一」推算，
  同样**必然**写进 `warnings`。为了让 `parse.js` 保持纯函数（规范 §5.2：CI 用 Rhino 重放
  同一份 fixture，不能每次结果不同），「现在几号」由 `extract.js` 在提取那一刻捕获成
  `term.extractedOn` 字段传给 `parse.js`，`parse.js` 本身不调用 `new Date()` 取当前时间
  （唯一的 `new Date(...)` 用于把给定日期转成 UTC 时间戳做纯粹的日期运算）。
- **`config.firstDayOfWeek: 7`（周日）没有采用**，理由与本科 `neu` 相同：空课的载荷靠
  `firstDay` 的星期几决定列对齐，而 `XQ` 是**绝对**星期（1 = 周一）。照抄会让整学期的课
  偏几天。
- **`config.semesterTotalWeeks: 18`（硬编码）改成兜底下限，不是直接采用**。上游没有接口
  数据支持这个数字，只是该校研究生学期的经验值；这里把它当**下限**——`ZCBH` 位串长度或
  课表里实际出现的最大周比 18 大时用观测值，避免把真实存在的课裁掉（见 `parse.js` 头部
  移植改动 ⑤，`fixtures/weeks.*` 覆盖了这条：位串 32 位、最大观测周 30，总周数按观测值
  定成 30，而不是兜底的 18）。
- **`isCustomTime` 字段没有移植**：上游固定写 `false`、从未被读取，空课载荷没有这个概念
  （移植手册 §4.4 讨论的是它为 `true` 时怎么处理；上游这里恒为 `false`，等价于没有信息，
  不产出任何字段）。
- **上游的重试 + sleep 没有照搬**：上游没有重试逻辑（原脚本单次请求失败就直接 toast 失败），
  这里额外加了**一次**立即重试（无 sleep，宿主给整段脚本 30 秒预算），提高对瞬时网络抖动
  的容忍度，不算「照抄上游」而是移植时的合理加固。

## 五、专项检查表（周次 / 节次边界）逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 位串周次编码 | ✅ `ZCBH` 是显式位串（'1' = 该周上课），不是文本周次，不存在上游文本解析漏字段那类坑。`fixtures/basic` 覆盖连续段（ALL）、奇数隔周（ODD）、偶数隔周（EVEN）、单周落单（ALL）四种切段；`fixtures/weeks` 额外覆盖**一个位串里含两段不连续的周次**（1-16 与 25-32，中间空档 17-24），验证 `runsOf` 切出两个独立 block 而不是一个跨空档的假段 |
| 2 | 超过 30 周的位串 | ✅ `clampWeeks` 逐周检查，超出 `MAX_WEEKS`（30）的位丢弃并计入 `droppedWeeks`，写进 `warnings`（不静默）。`fixtures/weeks` 的 32 位位串里第 31、32 位被裁掉，`totalWeeks` 同时被夹到 30（不会因为位串长度 32 而把总周数抬到非法值） |
| 3 | 非法位串（非纯 0/1） | ✅ `isBitString` 先判合法性，不合法的整段排课**跳过并记入 `warnings`**（`fixtures/weeks` 的 `"1010X010"`），不静默丢；与「合法但全零位串（这门课这学期没有排任何一周）」区分开——后者走通用的「没有周次」计数，不会被误报成「认不出的位串」 |
| 4 | 星期越界 | ✅ `XQ` 必须落在 1..7，否则整条记录跳过并计入 `warnings`（`fixtures/weeks` 的 `XQ: 8`） |
| 5 | 节次颠倒 / 缺失 | ✅ `endPeriod >= startPeriod` 且 `startPeriod >= 1`，否则跳过（`fixtures/weeks` 的 `KSJCDM: 5, JSJCDM: 3`） |
| 6 | 课名为空 | ✅ 空课名的记录必须在写入课程**之前**挡住——放进去会让**整个载荷**被规范 §4 的校验拒绝，不是跳过这一门（`fixtures/weeks` 的空 `KCMC`） |
| 7 | 完全空白占位行 | ✅ 课名 / 星期 / 位串全部缺失的记录（`fixtures/weeks` 里的 `{}`）直接跳过，不计入任何 `warnings` 计数——它不是「被丢掉的课」，是教务接口本来就可能返回的占位行 |
| 8 | 作息表覆盖不到课表用到的节次 | ✅ 课表里用到的最大节次超过作息表最后一个合法节次时，**整张作息表**改用空课默认值并写 `warnings`（`fixtures/periods`：课表用到第 11 节，作息表只到第 8 节） |
| 9 | 作息表时间非法 | ✅ `hhmmFromInt` 拒绝小时 >23 或分钟 >59 的条目，该条节次从作息表整体剔除并计入 `bad`，不会把 `25:30` 这类非法时间写进 `periodTimes`（`fixtures/basic` 混入一条 `KSSJ: 2530`，验证它被剔除且触发「有 1 个节次的时间认不出来」告警，同时不影响其余 10 个合法节次） |
| 10 | 总周数兜底 vs 观测值 | ✅ 上游硬编码的 18 周只当下限；`fixtures/basic`（观测最大 16 周）落在兜底 18 周，`fixtures/weeks`（观测最大 30 周）按观测值定 30 周——同一份代码两种分支都被覆盖 |
| 11 | `teacher` 拿不到就留空 | ✅ `fixtures/basic` 的「学术论文写作」一行没有 `JGJSXM` 字段，`teacher` 输出为 `null`，不是「未知」 |
| 12 | `allowHosts` | ✅ `[]` + 全部相对路径（本件不涉及 WebVPN，也不使用 OCR / 提问桥） |

## 六、变异测试

用 `parse.js` 的当前版本做基线（三个用例全绿：`basic=MATCH weeks=MATCH periods=MATCH`，
`node` + `vm` 当 Rhino 的替身），逐条把逻辑改坏，跑同一组用例：

| # | 改坏了什么 | 变红的用例 |
|---|---|---|
| M1 | `runsOf` 不再识别步长 2（`if (...) step = 2;` → `if (false) step = 2;`） | `basic`（单双周段塌成一堆独立 `ALL` 段） |
| M2 | `clampWeeks` 不裁剪超限周次 | `weeks`（第 31、32 周被放进去，`droppedWeeks` 告警消失） |
| M3 | 位串合法性检查失效（`isBitString` 恒真） | `weeks`（`"1010X010"` 被当成合法位串解析出畸形周次） |
| M4 | 星期校验关掉 | `weeks`（`XQ: 8` 的记录被当成合法课程写入） |
| M5 | 节次颠倒校验关掉 | `weeks`（`KSJCDM: 5, JSJCDM: 3` 被当成合法节次写入） |
| M6 | 作息表覆盖范围检查关掉 | `periods`（第 11 节直接套用只到第 8 节的作息表，产出错误的节次时间） |
| M7 | 总周数兜底（18 周）关掉 | `basic`、`periods`（总周数从 18 掉回观测值 16） |
| M8 | 时间越界检查关掉（`h > 23 \|\| mi > 59` 判断失效） | `basic`（`25:30` 被写进 `periodTimes`；规范 §4 下这类非法时间会让整个载荷被拒） |

八条全部命中，`basic`/`weeks`/`periods` 三份 fixture 合起来没有「有用例但盖不住」的死角。
还原核对：八次变异后 `parse.js` 与变异前逐字节一致，三个用例恢复全绿。

## 七、已知的取舍与缺口（审计应知情）

- **fixture 是合成的**：字段形状取自上游脚本 `saveCoursesData` 实际读取的字段
  （`item.KCMC`/`JGJSXM`/`JASMC`/`XQ`/`KSJCDM`/`JSJCDM`/`ZCBH`，`jcList` 的 `DM`/`KSSJ`/`JSSJ`），
  只保证「同样的输入永远得到同样的输出」，**不保证真实教务上的解析正确性**——见
  `docs/jw-adapter-testing.md` §3。拿到真实 dump 请替换 fixture 并重跑 `:importer:test`。
- **学期代码永远是猜的**：上游没有「当前学期」接口，本适配器也没有替它造一个（宁可
  每次都提醒用户核对，也不要编一个未经验证的接口去请求一个本不确定存在的端点——
  那样反而会把「猜错」伪装成「查到了」）。这是本适配器与本科 `neu` 最大的功能差距，
  日后若该校研究生教务上线了等价的学期列表接口，应优先补上这一层降级链。
- **单次请求，不分周补拉**：上游只发一次不带 `ZC` 的请求（`ZC=` 留空），本移植件保持
  上游口径。若该校存在只在部分周次开设的短期课程且不带 `ZC` 时会被服务端过滤，
  本适配器可能漏掉——与本科 `neu` AUDIT.md 记录的同类缺口性质相同，这里同样没有实测
  依据去验证是否存在，不臆测修复。
- `minAppVersionCode` 写 11：本适配器不用 OCR / 提问能力位，只多写了 `warnings`
  （老版本会忽略未知字段，导入照样成功，只是少一句提醒），与 `neu`/`dlutci`/`ustc` 一致。
- **上游更新了怎么办**：这里搬的是 2026-09-22 抓取的 `neuyjs.js` 快照（仓库当时没有单独的
  commit 哈希标注，脚本文件本身没有版本号），不追上游。转换逻辑全部在 `parse.js`，
  重搬一遍成本很低。

ES5 自检：`grep -nE "=>|\`|\blet |\bconst " jw-adapters/neu-grad/*.js` 无输出；
NUL 字节计数为 0。`grep -noE "https?://[A-Za-z0-9.-]+"` 命中的三处绝对 URL 全部在注释里。
