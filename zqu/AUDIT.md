# 安全审计 —— 肇庆学院教务适配器（`zqu`）

- 上游：`shiguang_warehouse` 的 `ZQU/zqu_01.js`（MIT，作者 **NoobLLiu**：文件头「维护者」，与 `adapters.yaml` 的 maintainer 一致；文件没有其他署名）
- 上游快照：`29498b026708ecb8d837c8fdc1e53b768a394e4e`（2026-11-03 与 origin/main 对齐，提交 29498b0）；本校脚本最后一次修改 `09432b1`（经 `git log -1 -- resources/ZQU/zqu_01.js` 核对，与任务卡一致）
- 移植者：0x7E7-2023　日期：**2026-11-03**
- 审计对象：本目录 `extract.js` / `parse.js` 全文（`parse.js` 不碰网络与 DOM；`extract.js` 只发同源请求，站点根由当前页面地址推出）
- 下文的代码位置一律按函数名引用，不写行号（行号在改动后会漂移）。

## 1. 平台与模板选择

上游打的是 URP 系 `xsgrkbcx!` 族（Struts2）：学期下拉框在「我的课表」内容页 `xsgrkbcx!getXsgrbkList.action`，课表数据是 JSON 接口 `xsgrkbcx!getKbRq.action`，
`zc` 传空即整学期（上游注释如此）。与 `jxfu` 同族，但**取数层不同构**：`jxfu` 读课表页源码里的 `var kbxx = [...]`，本校读 JSON；
所以 `extract.js` 不能照抄 `jxfu` 的 `fetchRows`，要按本校的 `getKbRq` 重写，只借它的「学期选取 / 登录页判断 / 字段白名单 / 日期探测」骨架。

模板选 **`jxfu`**（批次十八，已审计，同族 xsgrkbcx）。`parse.js` 的周次解析、提醒限长、缺教师教室汇总、H3 补节次、同时段合并直接沿用它的成品写法，
再按本校改：字段名（`zc` / `jxcdmc`）、14 节表、学期名截字数（20 字）、占位词表、`(0/1)` 位串周次、总周数规则、相邻节次合并。
没有选 `hbmu` / `glmu`：它们是 `getDataList.action` 的分页接口，接口形状不同。

## 2. 请求清单（与代码一致）

根（`root`）：校内直连 `https://jwgl.zqu.edu.cn/`；校外 WebVPN `https://webvpn.zqu.edu.cn/https/<加密串>/`（取当前页面路径里的 `/https/<段>/`）。
其余页面（WebVPN 门户、统一认证页、别的站）**一律不发请求**，直接报大白话提示（见 `siteRoot`）。

| # | 方法 | 地址（`root` 之下） | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| ① | GET | `xsgrkbcx!getXsgrbkList.action` | 学期列表页，读 `#xnxqdm` 各 `option`（值 = 学期代码，文字 = 学期名，`selected` = 教务标的当前学期）。**页面上已有 `#xnxqdm` 时跳过，直接读页面下拉框**（`loadTerms`） | 非 2xx 报「教务系统返回错误（代码 N）」；连不上报「连不上教务系统」；读不到 `#xnxqdm` 报「请先登录…」 |
| ② | GET | `xsgrkbcx!getKbRq.action?xnxqdm=<学期代码>&zc=&xsdm=` | 整学期排课记录。响应是 JSON 数组，按上游代码要求长度 ≥ 2，记录取 `data[0]`（`fetchRows`） | 非 2xx 报「代码 N」；非 JSON / 长度不对 / 登录页 → 「没有返回课表数据：登录状态可能已失效」 |
| ③ | GET | `xsgrkbcx!getKbRq.action?xnxqdm=<学期代码>&zc=1&xsdm=` | 第 1 周日期（`data[1]` 里的 `xqmc` / `rq`）。**上游也有这个请求**（上游在弹窗里让用户确认），这里只交给 parse.js，不弹窗（`fetchDates`） | 任何失败只交空，`parse.js` 推算开学日并提醒 |

全部是 GET，不提交表单、不发 POST、不带请求体。学期代码只来自下拉框的 `option.value`（经 `encodeURIComponent`）。
`allowHosts` 声明为 `["webvpn.zqu.edu.cn"]`（主调度定）；代码里不写任何绝对 URL，所有请求都落在页面当前的同源里。

**桩 / 冒烟跑出的实际地址**（Chromium + Playwright 假教务站，全部 route 拦截，不联网；脚本 `.test/port-batch29/zqu/smoke.py`）：

| 场景 | 页面地址 | 拼出的请求 |
|---|---|---|
| 校内直连，页面自带下拉框 | `https://jwgl.zqu.edu.cn/xsgrkbcx!getXsgrbkList.action` | `…/xsgrkbcx!getKbRq.action?xnxqdm=202502&zc=&xsdm=`、`…&zc=1&xsdm=`（不再取列表页） |
| 校内直连，停在首页 | `https://jwgl.zqu.edu.cn/index.action` | 先 `…/xsgrkbcx!getXsgrbkList.action`，再两个 `getKbRq` |
| 校外 WebVPN，页面自带下拉框 | `https://webvpn.zqu.edu.cn/https/a1b2c3d4e5f60718293a4b5c6d7e8f90/xsgrkbcx!getXsgrbkList.action` | `https://webvpn.zqu.edu.cn/https/a1b2c3d4e5f60718293a4b5c6d7e8f90/xsgrkbcx!getKbRq.action?xnxqdm=202502&zc=&xsdm=`（前缀保留） |
| 校外 WebVPN，停在 `/https/<段>/index.action` | 同上前缀 | 列表页 `…/https/<段>/xsgrkbcx!getXsgrbkList.action`，再两个 `getKbRq`（前缀一致，同源） |
| WebVPN 门户 `https://webvpn.zqu.edu.cn/` | 无 `/https/` 段 | **不发请求**，报「请先进入教务系统（校外请经 WebVPN 打开教务系统，校内直接打开即可）…」 |
| WebVPN 统一认证页 `…/https/<段>/authserver/login?service=x` | 路径段含 `authserver` | **不发请求**，报「当前打开的是登录页」 |
| 页面有密码输入框 | 任意 | **不发请求**，报「当前打开的是登录页」（只数有没有，不读值） |

## 3. 读了什么、交出什么

- 读：学期下拉框的 `value` / 文字 / `selected` 标记（或 live 的 `selectedIndex`）；整学期记录的 `kcmc / teaxms / jxcdmc / xq / zc / jcdm2 / jcdm` 七个字段；第 1 周日期的 `xqmc` / `rq`；页面是否有 `input[type="password"]`（只看有没有）。
- 交出去（字段白名单）：`{ term: { code, name, source }, today, dateInfo, rows }`
  - `rows[i]`：只有上面七个字段；每个字段限 300 字，对象 / 数组类直接丢（`pickRow`）。学号、姓名、身份证号、手机号、院系、班级等一律不带出。
  - `dateInfo`：只留 `xqmc` + `rq` 两个键的叶子，其余整棵丢掉（`pickDates`）。
  - `today`：本机日期（只用于推算兜底）。
- 冒烟里在记录与日期响应里都放了学号 / 姓名 / 身份证 / 手机 / `extra` / `nested` 等字段，所有场景都确认输出里一个都没有，且 `rows` 的键都在白名单内。
- 教师姓名、教室属于课表本身的内容（载荷要用），不算个人信息。

## 4. 与上游的差别（逐条）

1. 上游用 `window.shiguangBridge*`（拾光宿主接口）。这里改成 **return 一个 JSON 字符串**，不碰页面全局。
2. **不弹窗选学期**：上游一律弹「选择学期」。这里：页面上有下拉框就读用户此刻选中的；没有就取列表页的 `selected` 项；只有一项也直接用；**一项都没标就取第一项**，并在提醒里说明（`source: first`）。不再 `__ncSelect` 问用户（按任务卡「学期用教务给的当前学期，不弹窗」）。
3. **开学日不弹窗**：上游在 `confirmStartDate` 里让用户确认 / 修改第 1 周周一。这里不弹窗：探到的日期直接用（取自教务，提醒里写明），探不到按学期代码推算并提醒，用户可在学期管理里改。**这是需要主调度确认的一点**（见第 9 节）。
4. **地址**：上游 `siteBase` 只截 `xsgrkbcx!` 之前的一段；停在 WebVPN 门户时它会退回到域名根，拼出 `https://webvpn.zqu.edu.cn/xsgrkbcx!…` 这种错地址。这里改成：经 WebVPN 只认 `/https/<段>/`，校内只认 `jwgl.zqu.edu.cn`，其余不发请求（`siteRoot`）。
5. **整学期记录的形状**：上游注释说「不限周次时不返回日期数组」，代码却要求数组长度 ≥ 2 并取 `data[0]`。**照代码办**（`fetchRows`）；`data[0]` 不是数组时当作没有记录，由 `parse.js` 报「还没有排课数据」。
6. **周次**：上游 `parseWeekText` 先删掉括号、再删「单」「双」字，单双信息全丢；这里认单双周（含 `(单)1-8周,(双)9-16周` 等写法，标记各归各段）、「第」「周」字、括号备注 / 教学班序号、「共 N 周」（只剥备注本身）、0/1 位串（上游也认位串，保留）。认不出的计数进提醒。
7. **占位值**：上游缺教师写「未知」、缺教室写「未获取到教室」（会当真实值显示）。这里 `cleanField` 把「未知 / 暂无 / 暂无教师 / 暂无教室 / 待定 / 无 / 未获取到教室」一律记为 null，并按类型汇总提醒。
8. **总周数**：上游取课表里**最大周次**当学期长度。这里按任务卡第 7 条：教务不给校历，取 20 周；只有某周更晚才抬高（最多 30），并提醒。
9. **归并**：上游 `mergeAndDistinctCourses` 第一阶段会把「同课、同星期、同教室、周次完全相同、节次首尾相接」的块合成一段。这里 `mergeSlots` 照做（首尾相接或重叠都合并）。
10. **节次时间**：上游 14 节写死的表逐节搬过来（见第 5 节）。**不**沿用模板 `jxfu` 的空课默认节次表（12 节）分支：它只覆盖到第 12 节，而本校表已有 14 节，H3 的「默认表接得上就用」这一步对本校是死代码，删掉。H3 只剩「逐节顺推」一种。
11. 上游的浏览器测试分支（`prompt` / `alert` / `console`）、`showToast` / `showSingleSelection` / `showAlert` / `saveCourseConfig` / `savePresetTimeSlots` / `saveImportedCourses` / `notifyTaskCompletion` 全部不移植；上游的 `saveCourseConfig` 只在取到值时写 `semesterTotalWeeks` / `semesterStartDate`，这些由载荷的 `totalWeeks` / `firstDay` 代替。

## 5. 节次时间（逐节对照上游 `PRESET_TIME_SLOTS`）

| 节 | 时间 | 节 | 时间 | 节 | 时间 |
|---|---|---|---|---|---|
| 1 | 08:00-08:40 | 6 | 14:30-15:10 | 11 | 19:00-19:40 |
| 2 | 08:50-09:30 | 7 | 15:20-16:00 | 12 | 19:50-20:30 |
| 3 | 09:50-10:30 | 8 | 16:15-16:55 | 13 | 20:40-21:20 |
| 4 | 10:40-11:20 | 9 | 17:05-17:45 | 14 | 21:30-22:10 |
| 5 | 11:30-12:10 | 10 | 17:55-18:35 | | |

上游表 = `PERIOD_TIMES`（`parse.js`），逐项核对无串位。第 15 节起按 H3 顺推（上一节下课后课间 5 分钟、每节 45 分钟）：第 15 节 22:15-23:00、第 16 节 23:05-23:50；第 17 节起顺推会越过 23:59，**补不上**，课照常导入，提醒里说明（fixture `late-periods`）。

## 6. 逐条过移植手册 §5

| # | 检查项 | 结论 |
|---|---|---|
| 1 | **不碰凭据** | ✅ 不读 / 不存 / 不发账号、密码、令牌、Cookie、`localStorage`。唯一与登录沾边的是 `document.querySelectorAll('input[type="password"]')`，只数有几个，用来判断「当前是登录页」，不读 `.value`。`credentials: 'include'` 只是让浏览器带上现成会话。 |
| 2 | **不外发** | ✅ 全脚本只有 `getText` / `fetchDates` / `fetchRows` / `fetchTermList` 四处 `fetch`，都是 `root` 之下的 GET；没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image`。 |
| 3 | **请求域可控** | ✅ `root` 只能是当前页面所在的 `jwgl.zqu.edu.cn` 或 `webvpn.zqu.edu.cn/https/<段>/`；代码里没有任何绝对 URL。`allowHosts` = `["webvpn.zqu.edu.cn"]`（主调度定），无通配。 |
| 4 | **只读课表** | ✅ 只请求学期列表页、整学期课表记录、第 1 周日期。不请求成绩、学籍、个人信息、缴费。页面与记录里夹带的个人信息不进输出（字段白名单，冒烟验证）。 |
| 5 | **不埋点** | ✅ 无统计 / 上报 / 遥测；`extract.js` 不输出任何 `console`。 |
| 6 | **不 eval 远程代码** | ✅ 无 `eval` / `new Function`；返回值只做 `JSON.parse`、正则与字段读取。 |
| 7 | **不写页面** | ✅ 不写 DOM、不改表单、不提交、不点击；学期列表页用 `DOMParser` 离线解析。 |
| 8 | **不依赖用户输入之外的秘密** | ✅ 无硬编码密钥 / 令牌 / 他人学号；常量只有接口路径、截断上限、字段白名单、节次时间。冒烟里的 WebVPN 加密串是合成的 `a1b2…`，不是真实映射。 |

## 7. 与模板 `jxfu` 的差异（主要）

- 取数：`getKbRq` JSON 代替 `kbxx` 源码抠取；入口由 `root` 推出，不用根相对路径（WebVPN 必须带前缀）。
- 学期：不 `__ncSelect` 提问；`source` 只有 `page` / `default` / `first` 三种。
- 字段：`zc` / `jxcdmc` 代替 `zcs` / `jxcdmcs`；`jcdm2` 为空时回落 `jcdm`（`sectionsOf(row.jcdm2) || sectionsOf(row.jcdm)`）。
- 节次：14 节表；去掉空课默认节次表分支（见第 4 节第 10 条）。
- 总周数：20 起，抬高才提醒（`jxfu` 也是 20 起，口径一致）。
- 学期名截字数：20 字（`jxfu` 是 30 字）；任务卡要求拼进提醒的教务原文一律 20 字。
- 占位词：加入「暂无教师」「暂无教室」「未获取到教室」。
- 新增：0/1 位串周次、相邻节次合并（`mergeSlots`）。

## 8. fixtures 与变异测试

fixtures 共 **10 对**（合成，期望值由 `.test/port-batch29/zqu/gen_fixtures.py` 手工推演后写死，不是 `parse.js` 的输出；自检首次运行即全部 MATCH）：

| fixture | 覆盖 |
|---|---|
| `basic` | 教务给第 1 周日期 → 开学日取自教务；同课同时段两行周次合并成 1-18；`1-8,10-16` 分两段；`2-16(双)` 偶数周；`1-16周(单)` 奇数周；完全重复行不计 |
| `weeks-parity` | 没有日期响应，第二学期推算 2026-02-16；`(单)1-8周,(双)9-16周` 各归各段；`第1-第8周` 与 `1-8周(共16周),9-16周` 合并成 1-16（只剥备注） |
| `weeks-prefix` | **本校专属边界**：`(单)1-8周(双)9-16周`、`1-8周(单),9-16周(双)`、`(单)1-8周,(双)9-16周`、`1-8(单)9-16(双)`、`1-8周(单)9-16周(双)` 都读成 1-7 单 + 10-16 双；`第1-第8周(单)`；`1-16周(单)共16周` |
| `late-periods` | 第 15、16 节顺推；第 17 节补不了，提醒说清楚 |
| `dirty-rows` | 占位词记为空（`未知` / `待定` / `暂无教师` / `暂无教室`）；缺课名、星期 8、缺节次、周次读不出各一行被跳过并计数；0/1 位串 `0111000000000000`；括号序号 `(01)`、括号备注 `(实验)`、单双同写 `(单双周)`、节次不连续 `01,02,05`、周次超 30（`1-35`，抬到 30） |
| `long-warnings` | 四门缺教师教室的长课名（25 字以上）、40 字学期名、长周次原文；提醒里课名 / 学期名 / 周次原文一律截 20 字，每条 ≤200 字 |
| `first-term` | 没有任何标记，取第一项并提醒核对；学期名为空用「肇庆学院 + 学期代码」；日期响应属于别的学期（2024-09-02）不采用，按 2026-09-01 所在周推算 2026-08-31 |
| `merge-entities` | `&amp;` 解码；斜杠日期 `2025/09/01`；乱序周次 `17,2,3,4,6` 切成 2-4 / 6 / 17；全角 `１-４，６周`；同课不同教室分开 |
| `adjacent-merge` | 同教室同周次的 1-2、2-3（重叠）、3-4 合成 1-4；周次不同的 5-6（1-8 周）不并；隔了空节的 9-10 不并 |

**变异测试**（`.test/port-batch29/zqu/mutate.py`，在系统临时目录的副本上改，跑自检，主目录未动）：

| 改坏哪一处 | 变红的用例 |
|---|---|
| M1 `weeksOf`：前缀标记不再归下一段（退回后缀） | `weeks-prefix` |
| M2 `weeksOf`：0/1 位串分支删掉 | `dirty-rows` |
| M3 `EMPTY_VALUE`：漏掉「暂无教师」「暂无教室」 | `dirty-rows` |
| M4 `NAME_TEXT_LIMIT` 20 → 80（提醒不再截断） | `long-warnings` |
| M5 `EXTEND_BREAK_MINUTES` 5 → 10 | `late-periods` |
| M6 总周数直接取课表最大周 | `basic`、`weeks-parity`、`weeks-prefix`、`late-periods`、`long-warnings`、`first-term`、`merge-entities`、`adjacent-merge` |
| M7 「共 N 周」剥离改成删到行尾 | `weeks-parity` |
| M8 `plausibleFirstDay` 恒真 | `first-term` |
| M9 `mergeSlots` 原样返回（相邻节次不合并） | `adjacent-merge` |

九处全部变红；主目录未被改动，自检 `RESULT` 只剩 AUDIT 相关的一项（本文件写完后应为 PASS）。

**浏览器冒烟**（`.test/port-batch29/zqu/smoke.py`，Playwright 假教务站，不联网）：14/14 OK。场景：`direct-page`、`direct-list`、`direct-first`、`vpn-page`、`vpn-list`、`vpn-portal`、`vpn-portal-home`、`vpn-auth`、`login-form`、`list-expired`、`kb-expired`、`kb-500`、`empty-term`、`dates-fail`。
每个场景核对：所有请求是 GET；主机只在 `jwgl.zqu.edu.cn` / `webvpn.zqu.edu.cn`；路径都在 `xsgrkbcx!` 下；WebVPN 前缀与页面一致；门户 / 登录 / 认证页零请求；输出无学号 / 姓名 / 身份证 / 手机 / 额外字段；课名里的 `];` 不截断数据；经 Rhino 跑 `parse.js` 得到的节次时间与提醒长度都在上限内。

## 9. 已知风险与未验证项（如实记录）

- **没有本校账号，真机没验过。** fixture 与冒烟都是按上游脚本读取的字段形状合成的，只保证「同样输入 → 同样输出」，不保证在真实教务上解析正确。
- 真实环境才能验的：`getKbRq` 整学期（`zc=` 空）响应是否真的是「`[记录数组, 日期数组]`」（上游注释与代码矛盾，这里照代码；若真实形状是别的，会报「还没有排课数据」或「没有返回课表数据」，不会静默丢课）；`zc` 的真实写法（上游注释列了三种，单双写法没见过实样）；`jcdm2` / `jcdm` 的真实格式；`#xnxqdm` 里哪一项带 `selected`；学期代码格式。
- **WebVPN 加密串**：这里只认路径形如 `/https/<段>/` 的前缀（上游的 WebVPN 映射也是这个形状，`/http/` 也接受）。真实的加密串未知；如果学校改成别的形状，`siteRoot` 会报「请先进入教务系统」，不会乱发请求。
- **统一认证页**：只按路径段 `authserver` / `login` / `cas` 与「页面有密码框」判断。学校的认证页若长得不一样，会落到「请先进入教务系统」或请求后报「没有返回课表数据」，两者都不是静默错误。
- 节次时间 14 节照上游写死的表抄，**没有核对学校真实作息**（上游注释说「依据学校实际作息表」，我们没有学校的官方作息文件）。
- 开学日：这里不弹窗（上游会让用户确认）。取到的值来自教务的第 1 周日期时，提醒里写明「请在学期管理里核对」；推算值同理。**需要主调度决定**：是否恢复上游的开学日确认弹窗。
- 总周数按 20 周给（教务不给），本校实际学期周数如不同需在学期管理里改（提醒里已写）。
- `scheduleUrlHint` 填的是 `https://jwgl.zqu.edu.cn/xsgrkbcx!getXsgrbkList.action`（上游的「我的课表」内容页，推断，未在真机验证；打开后若不是课表页，用户仍可手动进入「我的课表」）。
- 同一门课相邻节次若周次不完全相同（如 1-2 节 1-8 周、3-4 节 1-16 周），按上游一样不合并，会显示成两块，不丢课。
- 上游 `parseWeekText` 把 `zc` 的位串（`/^[01]{4,}$/`）当成正方 classWeek 写法。这里保留这个分支，代价是理论上一段真实的 `0/1` 数字串会被当成位串；教务的周次文字里几乎不会出现纯 0/1 的 4 位以上数字，已接受。

## 10. 复审修正（2026-11-03，团队负责人复审两条）

- **B1 直连认证页零请求**：原先只有 WebVPN 分支判断路径里的 `authserver` / `login` / `cas`，直连 `jwgl.zqu.edu.cn` 的同类页面会照常发课表请求。
  现在两个分支共用 `isAuthPath` 一个判断，命中就报「当前打开的是登录页」，不发请求（`siteRoot`）。冒烟新增 `direct-auth`（`https://jwgl.zqu.edu.cn/authserver/login?service=x`）：零请求、报登录页提示，通过。
  变异：删掉直连分支的 `isAuthPath` 判断 → `direct-auth` 变红（FAIL：发出了请求，且没报登录页）；已在临时副本上做，主目录未动。
- **B2 连写节次**：原先只认 2 位或 4 位，`010203` 这类 6 位以上整行被当缺节次跳过。现在与上游 `parseSections` 一致：任意偶数位都每两位切一节（`sectionsOf`）。
  奇数位（如 `01020`）或切出非数字，照旧返回空，计入「缺节次」并提醒。`0103` 这类断开的写法按现有规则放入并计为不连续（提醒「节次不连续」），不静默连成一段。
  新 fixture `six-digit-sections`：`010203` → 第 1–3 节（期望值手推：1 + 2 + 3 节，周次 1–16 全周），`01020` → 缺节次一行并提醒。
  变异：`sectionsOf` 连写分支改回只认 4 位（`mutate.py` 的 M10）→ `six-digit-sections` 变红（Rhino 执行出错：整门课被跳过，课表为空）。

签名：0x7E7-2023（haiku 移植，2026-11-03）
