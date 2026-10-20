# 安徽财经大学 适配器安全审计（URP 综合教务 · 校内入口 / WebVPN）

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) `AUFE/aufe_01.js`（MIT，上游作者 **星河欲转**）；同目录 `adapters.yaml` 有两个入口共用这一个脚本：`AUFE_01`（`import_url` = `http://all.aufe.edu.cn`，校内入口）与 `AUFE_02`（`import_url` = `http://vpn.aufe.edu.cn`，WebVPN 入口），`maintainer` 均为 `星河欲转` |
| 上游快照 | `19a65bf07a3e998fcfc69cee692387cdc0523c1a`（2026-10-19 拉取）；本校脚本最后一次修改：`80e30cf`（`git log -1 -- resources/AUFE/aufe_01.js` 核对一致） |
| 平台 | URP 综合教务系统（`/student/courseSelect/...`），与 lnu / neau 同平台，但取数链不同（见第 4 节） |
| 移植者 | 0x7E7-2023（sonnet 移植，2026-10-20） |
| 模板 | `lnu`（同平台、同样 `planCode` 选学期、同样读 `/indexCalendar` 的 `var rq`）；同课合并（两阶段 `mergeAndDistinctCourses`）、缺教师 / 缺教室汇总、提醒收口（`warn`）照 `swu` |
| 结论 | 自检 PASS（7 对 fixture 全部一致）；浏览器冒烟 23/23 OK；变异测试 15 处全部变红并已还原。不碰凭据、不外发、只读课表、无第三方域、无埋点。**真机未验证**，见第 8 节。 |

## 1. 请求清单（与代码一致）

所有请求都是**同源相对路径**，目标主机永远是当前页面所在的主机（用户在 WebView 里打开的教务站点，校内直连或 WebVPN 子域都一样）。代码里没有任何绝对 URL。

| # | 方法 | 路径 | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| 1 | GET | `/student/courseSelect/calendarSemesterCurriculum/index` | 取学期课表页的 HTML，读 `#planCode` 学期下拉框和页面里的课表地址（含 `ajaxStudentSchedule` 的路径）。用 `DOMParser` 在内存里解析，**不插入页面** | 401/403/其它非 2xx → 「教务系统拒绝访问 / 返回错误（代码 N）」；网络失败 → 「连不上教务系统」；页面里没有学期下拉框 → 区分「要求重新登录」（有密码输入框）与「当前页面可能不是教务系统」；没有可用的课表地址 → 「没有找到课表的入口」。都是抛错，导入停止 |
| 2 | POST | 请求 1 的页面里读到的课表地址（形如 `/student/courseSelect/thisSemesterCurriculum/<令牌>/ajaxStudentSchedule/past/callback`），体 `&planCode=<学期代码>`（`encodeURIComponent`） | 取课表 JSON（`dateList[].selectCourseList[]`）。请求头 `Content-Type: application/x-www-form-urlencoded`、`X-Requested-With: XMLHttpRequest`（与上游一致） | 非 2xx → 抛错（同上）；返回不是 JSON → 「返回的内容格式不对」；没有 `dateList` → 「没有返回课表数据」。都是抛错 |
| 3 | POST | `/ajax/getSectionAndTime`，体 `planNumber=&ff=f` | 取节次时间（`sectionTime[]`）与学期总周数（`section.zs`） | **任何失败都是 `null`，不阻断导入**；parse.js 提醒「没有给出可用的节次时间，按应用默认的节次时间显示」 |
| 4 | GET | `/indexCalendar` | 只从 HTML 文本里用正则取 `var rq`（开学日 `YYYYMMDD`）一个字符串，**不交整页** | **任何失败都是 `null`，不阻断导入**；parse.js 按提取当天所在周的周一推算并提醒 |

- 课表地址（请求 2 的路径）是从请求 1 的页面内容里读出来的，所以做了**严格的路径校验**（`isSafeSchedulePath`）：整条路径必须匹配 `^/student/courseSelect/thisSemesterCurriculum/(?:[A-Za-z0-9]+/)?ajaxStudentSchedule/[A-Za-z0-9/_-]*$`（固定前缀 + 可有可无的字母数字令牌段 + `ajaxStudentSchedule/…`；有令牌是上游的写法，无令牌是同平台 lnu / neau 的写法），不带查询串、不带主机名；别的路径（哪怕名字里碰巧含 `ajaxStudentSchedule`，如 `/student/courseSelect/delete/cancel?x=ajaxStudentSchedule1`、`/logout?ajaxStudentSchedule`）一律不收，找不到合格的就报错、不发 POST。候选来源与上游相同：脚本里 `url: "…"`、脚本里出现的标准路径、`form` 的 `action`；多个候选时取第一个合格的。冒烟场景 `badurl`（带主机名）、`badpath-query`、`badpath-logout` 钉住：页面里只有这些地址时一律报错，不发任何 POST；`notoken` 正例钉住无令牌写法能正常取数。
- 门户 / 登录页：主机是 `all.aufe.edu.cn`（校内入口）或 `vpn.aufe.edu.cn`（WebVPN 网关），或路径是 `/login`、`/login/…` 时，直接报「这里还不是教务系统……」，**不发任何请求**（冒烟 `portal-all` / `portal-vpn` / `login` 钉住）。
- 页面 DOM **只读**：`document.getElementById('planCode')` 取用户在课表页上选中的学期代码（只在它出现在教务给的学期列表里时才采用）。不创建节点、不改表单、不提交、不点击。
- 没有任何其它请求：不请求成绩、学籍、个人信息、缴费、选课接口。

静态扫描：`extract.js` 里 `fetch` 共 2 处（`getText`、`postForm` 两个出口），`XMLHttpRequest` / `sendBeacon` / `WebSocket` / `new Image` / `eval` / `new Function` / `document.cookie` / `localStorage` 均无。`check.js` 的提示「出现 password 字样」来自 `input[type="password"]` 这个选择器——只用来判断「拿到的页面是不是登录页」（有无密码输入框），不读取任何值。

## 2. 读了什么、交出去什么

`extract.js` 交给 `parse.js` 的 JSON 字段（逐字段；**白名单外的一律不带出**，包括响应里的学号、人员 ID、课程 ID、姓名等）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `fetchedDate` | 浏览器本地日期 | `YYYY-MM-DD`，推算开学日与学期名用，写进提醒 |
| `term` | 学期下拉框 | `{ text, isCurrent }`：被选中学期的文字、文字里是否带「当前」。学期代码（`value`）只用来拼请求 2 的体，不交出 extract.js |
| `rq` | `/indexCalendar` | 8 位数字串或 `null` |
| `zs` | `getSectionAndTime` 的 `section.zs` | 字符串或 `null` |
| `slots[]` | `getSectionAndTime` 的 `sectionTime` | 每项 `sessionName`、`djjc`、`startTime`、`endTime`；取不到为 `null` |
| `courses[]` | 课表 JSON `dateList[].selectCourseList[]` | 每项 `courseName`、`coureName`（教务偶有笔误的写法，上游也兼容）、`attendClassTeacher`，`timeAndPlaceList[]` 每项 `classDay`、`classSessions`、`continuingSession`、`classWeek`、`campusName`、`teachingBuildingName`、`classroomName` |

值只接受字符串、数字、null；嵌套对象一律丢弃（`pick()`）。响应外壳（`dateList → selectCourseList`）只在 `planCourses()` 里定义一次，「有没有数据」与「挑字段」共用它。冒烟脚本往响应里塞了 `id`、`studentId`、`xh`、`xm`、`sfzh`、`sjh`、`weekDescription`、`planName`，输出里一个都没有出现。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **通过**。不读 `password` 的值、登录表单、cookie、`localStorage`；fetch 只带 `credentials: 'same-origin'`。登录由用户在 WebView 里手工完成。 |
| 2 | 不外发 | **通过**。只有上面 4 个同源请求；没有埋点、上报、统计。课表地址做了路径校验，不会被页面内容引到别的主机。 |
| 3 | 请求域可控 | **通过**。`allowHosts` 写 2 个精确主机（不用通配）：`jwcxk2-aufe-edu-cn.vpn2.aufe.edu.cn`（教务系统的 WebVPN 改写主机，来自上游注释里的示例 `jwcxk2-aufe-edu-cn.vpn2.aufe.edu.cn:8118`）和 `jwcxk2.aufe.edu.cn`（由前者**推断**出的直连主机，见第 8 节）。校内入口 `all.aufe.edu.cn` 与 `loginUrl` 同源，无需列出；WebVPN 网关 `vpn.aufe.edu.cn` 只是登录入口、不在其上取数，也不列出（这两个门户主机上点「提取课表」只会直接提示，不发请求）。请求落在页面自己的同源路径上。 |
| 4 | 只读课表 | **通过**。请求 2 与 3 是 POST，但与上游相同：请求体只有学期代码 / 固定查询参数，都是上游的既有查询方式；服务端有无写副作用我们无法在本地确认（见第 8 节）。 |
| 5 | 不埋点 | **通过**。无统计、无上报、无遥测；上游的弹窗与 toast 全部去掉。 |
| 6 | 不 eval 远程代码 | **通过**。无 `eval` / `new Function` / `document.write`；取回的内容只经 `JSON.parse`，HTML 只经 `DOMParser`（不执行脚本）和两个正则读字符串。 |
| 7 | 不写页面 | **通过**。只读 `#planCode`；`DOMParser` 解析的是内存文档，不插入页面；不改表单、不提交、不点击。 |
| 8 | 不依赖用户输入之外的秘密 | **通过**。无硬编码学号、令牌、密钥；学期代码和课表地址都来自教务页面本身（上游同）。 |

## 4. 与模板 lnu 的差异（按我自己通读上游后的分析）

| 项 | lnu（模板） | aufe |
|---|---|---|
| 取数链 | 固定地址 `…/thisSemesterCurriculum/ajaxStudentSchedule/callback`，有下拉框 POST、没有 GET | 先 GET 学期课表页，从 HTML 里读下拉框 + **动态课表地址**，再 POST 该地址；地址须通过路径校验 |
| 响应外壳 | `xkxx`（课程 ID → 课程对象 的字典数组）、`jcsjbs` | `dateList[].selectCourseList[]`；课名 `courseName` 或笔误写法 `coureName` |
| 节次时间 | 响应里的 `jcsjbs` + 崇山 / 蒲河 / 武圣三张内置表 + `__ncSelect` 校区提问 | `POST /ajax/getSectionAndTime`；**上游没有写死的节次表**，所以没有内置表、没有提问桥；取不到就按应用默认并提醒 |
| 开学日 / 总周数 | `rq` + `skzc`（`/indexCalendar`） | `rq`（`/indexCalendar`）+ `section.zs`（节次时间请求里的学期总周数）；都只对「当前学期」有效 |
| 学期选择 | 取下拉框选中项 | 页面上选中的（须在教务列表里）→ 标「当前」的 → 第一项（上游默认项）；不是「当前」时不用 `rq` / `zs`，推算并提醒 |
| 周次 | `classWeek` 位串优先，`weekDescription` 文字为辅 | 只认 `classWeek` 位串（上游只读位串）；读不出来的安排计数提醒，不静默 |
| 连续节数缺失 | 当 2 节（lnu 上游的写法） | 上游得到无效节次（`NaN`）；这里按 1 节导入并计数提醒（只确定知道起始节） |
| 去重 / 合并 | 按安排去重 | 上游 `mergeAndDistinctCourses` 两阶段（连堂合并 + 同节次周次并集），前面加一步去完全重复行（照 `swu`） |
| 教师 | `*` 换空格 | 上游 `replace(/\* /g, "")`，多位教师的名字会连成一串；这里按 `*` 拆开用「、」连接 |
| 教室 | `buildPosition` 去重复前缀 | 上游「校区 + 教学楼 + 教室」直接拼，这里同样直接拼（不额外去重）；全空为空 |
| 缺教师 / 缺教室 | 无汇总 | 按类型汇总计数进提醒（照 `swu`） |
| 提醒用词 | 含「作息表」「内置作息表」 | 统一「节次时间」「空课默认的节次时间」 |
| 学期名兜底 | 1 月被算成下一学年第一学期（`inferTermName` 的小错） | 修正：1 月属于上一学年第一学期（`no-meta` 钉住） |
| 门户页处理 | 无 | `all.aufe.edu.cn` / `vpn.aufe.edu.cn` / `/login`：直接提示，不发请求 |
| WebVPN 前缀 | `vpnBase()`（路径前缀式 VPN） | **不要**：上游 WebVPN 是子域改写式（`jwcxk2-aufe-edu-cn.vpn2.aufe.edu.cn:8118`），页面本身就在那个子域上，同源相对路径已经正确（冒烟 `vpn` 钉住） |

内置节次时间：**无**（上游没有写死表，只读教务）。节次超出教务给的节次时间时按「统一修订 H3」逐节补：空课默认的节次时间同一节不早于上一节下课就用它，否则从上一节下课后顺推（课间 5 分钟、每节 45 分钟），越过 23:59 就停，补了哪些都写进提醒（`slots-extend` 钉住）。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 处理 | 理由 |
|---|---|---|
| `BASE_URL` 配置、`getBaseUrl()`（用 `window.location.origin` 拼绝对地址） | 去掉，全部改成同源相对路径 | 相对路径天然同源，不会指向别的主机；WebVPN 子域下同样成立 |
| `showAlert` 确认框、`showSingleSelection`（选学期）、`showPrompt`（确认开学日）、`validateDate`、`showToast` | 去掉；学期取页面选中 / 当前 / 第一项，开学日取 `rq` 对齐周一并提醒 | 宿主的交互由宿主统一管理；不弹窗问学年学期（批次规则） |
| `saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig` / `notifyTaskCompletion` | 去掉 | 导入由宿主完成，extract.js 只交数据 |
| `fetch(..., credentials: "include")` | 改为 `same-origin` | 请求是同源相对路径，两者在这里等价；`same-origin` 不把 cookie 发给别的站点 |
| `response.json()`（失败直接抛原始错误） | 先取文本再 `JSON.parse`，失败给大白话 | 报错不写「JSON」 |
| 教师兜底（空串）、教室兜底「未知地点」、课名兜底「未知课程」 | 教师 / 教室改为 null 并汇总提醒；没有课程名的课跳过并计数提醒 | 空课里「未知」会被当成真名显示；课名不能凭空编 |
| `mergeAndDistinctCourses`（含 `Set`、展开运算符、`localeCompare`） | 移到 parse.js 并改写成 ES5（照 `swu`），排序比较改成纯字符串比较 | CI 只跑 parse.js 且需要 ES5；`localeCompare` 依赖区域设置，排序结果不稳定 |
| `semesterTotalWeeks` 默认 20 | 保留为兜底：教务没给 `zs` 且课表没有周次时才用 | 与上游一致 |
| 取到的 HTML 整页 | 只在内存里解析，只交白名单字段 | 不外带页面里可能夹带的个人信息（冒烟用含学号 / 姓名的假页面验证） |

**没有删任何为安全而删的东西**：上游脚本本身不含凭据、不含第三方地址、不含埋点。

## 6. 测试

### fixtures（7 对，期望值全部先手工推演再比对，没有把输出直接存成 expected）

| 用例 | 覆盖 |
|---|---|
| `basic` | 当前学期；节次时间 12 节（含 `sessionName` 为空走 `djjc`、`sessionName` 为「第12节」走 `djjc`）；开学日取 `rq`（周一）；总周数取 `zs`；多位教师「张三* 李四* 」→「张三、李四」；连堂拆两行合并（1-2 + 3-4 → 1-4）；同节次周次拆两行合并（1-8 + 9-16 → 1-16）；**相邻节次但周次不同不合并**（单周 7-8 与双周 9-10）；完全重复行；`coureName` 笔误写法；缺教师 / 缺教室汇总 |
| `weeks-edge` | 零散周次（1-4、6/8/10 双周段、13-15）；单周 + 单独一周；`classWeek` 全 0 / 含非法字符 / 缺失；星期 8、节次 0；连续节数 `""` / `null` / `"0"` 按 1 节；没排课的课；没有课程名；`（当前学期）` 标记剥离 |
| `term-other` | 非当前学期：`rq` / `zs` 不用，按提取日推算并提醒 |
| `no-meta` | 学期名只剩「(当前)」→ 推算（提取日 2027-01-05 → 2026-2027 学年第一学期）；无 `rq`；无节次时间；`zs`=35 非法；缺教师汇总 |
| `slots-extend` | 开学日不是周一（对齐）；节次时间只到第 8 节：第 9-12 节用空课默认、第 13-14 节顺推、第 15 节越过 23:59 补不了；节次时间有重复行与坏行；第 24 周超过教务给的 20 周，总周数抬高 |
| `clamp` | 第 32 周的课：总周数压到 30；跨界安排截断到 30 周；整条落在 30 周之后的安排与课程丢弃并提醒 |
| `long-names` | 四门 80 字长课名都缺连续节数 / 教师 / 教室，另有长课名的没排课课与读不出安排的课：提醒里课名截到 20 字、超过 3 门写「等 N 门」，单条提醒 ≤200 字 |

### 浏览器冒烟（`.test/port-batch15/aufe/smoke.py all`，23/23 OK）

Playwright 起 Chromium，所有请求被 `route` 拦下，不联网；跑真实 extract.js，再用 Rhino 跑 parse.js。场景：校内直连（课表页 / 首页）、WebVPN 子域（带端口）、门户页 `all` / `vpn` 与 `/login` 不发请求、用户在课表页选了历史学期（采用并提醒非当前）、页面上有无关的 `planCode` 下拉（忽略）、课表地址只在 `form` 里、课表地址带主机名（拒绝，不发请求）、没有课表地址、没有学期下拉框、会话过期（返回登录页）、首页 404、没有「当前」标记、课表请求回 HTML / 空对象 / 500、节次时间请求 500、`/indexCalendar` 404。每个场景核对请求主机、路径、请求体，并检查个人信息（学号、身份证、手机号、姓名、课程 ID）不出现在请求或交出的数据里。

### 变异测试（15 处，在 `C:/Users/23703/AppData/Local/Temp/aufe-port15/mut/` 的副本上改；真实目录从未改动，收尾自检仍为 PASS）

| # | 改坏哪一处 | 变红的用例 / 场景 |
|---|---|---|
| 1 | `runsOf` 单双周判定对调 | fixture `basic`、`weeks-edge` |
| 2 | 阶段 1 连堂合并关掉 | `basic` |
| 3 | 阶段 2 同节次周次并集关掉 | `basic` |
| 4 | 多位教师不再用「、」分开 | `basic` |
| 5 | 非当前学期仍用教务的开学日 | `term-other` |
| 6 | 顺推补节次的课间 5 分钟改 10 分钟 | `slots-extend` |
| 7 | 提醒里的课名不截短 | `long-names` |
| 8 | 节次时间重复行不再跳过 | `slots-extend` |
| 9 | 连续节数缺失改按 2 节 | `weeks-edge`、`long-names` |
| 10 | 周次落在总周数之后的整条安排不再丢弃 | `clamp` |
| 11 | 1 月不再算上一学年第一学期 | `no-meta` |
| 12 | 课名笔误写法 `coureName` 不再认 | `basic` |
| 13 | extract：课表地址不再做路径校验 | 冒烟 `badurl`、`badpath-query`、`badpath-logout`（发了 POST） |
| 14 | extract：门户页不再拦截 | 冒烟 `portal-all`、`portal-vpn`、`login`（发了请求） |
| 15 | extract：不再优先用用户在页面上选中的学期 | 冒烟 `page-select` |

## 7. 提醒清单（学生会看到的文字，均按 `docs/ux-writing.md` 写）

开学日（取自校历 / 不是周一已对齐 / 不属于所选学期已忽略 / 没有给出推算）、学期名是推算的、导入的不是当前学期、学期总周数（取自教务 / 课表更晚已抬高 / 超过 30 周已压到 30 / 与所选学期对不上 / 教务给的周数不合法 / 没有给出）、没有可用的节次时间、节次时间里有读不出来或重复的行、课表用到更晚的节次已补时间（及补不了的）、连续节数缺失按 1 节、没排课的课、读不出来的安排 / 课、没有课程名的课、周次超出 30 周的截断与丢弃、缺教师 / 缺教室汇总。带课名的提醒一律走 `shortName`（课名 ≤20 字）、点名最多 3 门、每条 ≤200 字（`warn` 收口再截一次），条数上限 20 条；正常课表通常只有 1–4 条。

## 8. 已知风险与未验证项

1. **没有本校账号，真机没验过**。fixture 全是合成的，冒烟用的是自造的假教务站，只保证「同样输入同样输出」和请求形状，不保证真实页面上解析正确。拿到真实 dump 后应替换 `fixtures/*.extracted.json` 并核对：`#planCode` 的选项文字（「当前」是否就是这个写法）、课表地址真的在页面脚本里、`dateList` 的形状、`classWeek` 的位数、`sessionName` / `djjc` 哪个有值。
2. **教务主机是推断的**：上游只在注释里给过 WebVPN 示例 `jwcxk2-aufe-edu-cn.vpn2.aufe.edu.cn:8118`，据此推出直连主机 `jwcxk2.aufe.edu.cn`（**推断，未证实**）并连同 WebVPN 主机写进 `allowHosts`。宿主只放行 `loginUrl` 同源与 `allowHosts` 里的域；如果真实教务主机不在这两个之内，请求会被宿主拦住（表现为「连不上教务系统」），需要补主机。`scheduleUrlHint` 因同样的原因**没有写**（猜错会让一键刷新打开错页面）。
3. **`rq` 的含义按上游理解**：上游把 `/indexCalendar` 里的 `var rq` 当开学日，注释示例 `20260831` 恰好是周一，所以按开学日用，并在提醒里要求核对；`section.zs` 被上游当学期总周数，同样按上游理解、未实测。两者都只对当前学期有效。若 `rq` 其实是别的日期（例如当天），学生会在第一条提醒里看到明确的日期并可在「学期管理」里改。
4. **POST 的语义**：请求 2 与 3 是 POST，但都是上游的既有写法、请求体只有学期代码 / 固定查询参数；服务端是否有写副作用我们无法本地确认。
5. **课表地址校验偏严**：只收 `/student/courseSelect/thisSemesterCurriculum/[<令牌>/]ajaxStudentSchedule/…` 这个形状（令牌段可有可无）。若真实地址是别的形状（例如换了前缀、或带查询串），会报「没有找到课表的入口」（不会静默出错）；放宽需要看到真实页面。
6. **学期选择的限制**：不弹窗问学期。想导入非当前学期，要先在教务系统的课表页（学期下拉框）里选好再提取；选中的学期必须出现在教务给的列表里才被采用。提醒里已说明。
7. **连续节数缺失按 1 节**是保守推算（上游在这种情况下得到无效节次），已计数提醒，学生需要核对。
8. **教室不做去重**：上游「校区 + 教学楼 + 教室」直接拼；若教务的教室名本身已带楼名，会出现重复的楼名（不影响使用，学生可在「编辑课程」里改）。
9. **不处理路径前缀式 WebVPN**（`/http/<加密串>/…`）：上游的 WebVPN 是子域改写式，没有这种前缀；如果学校换成前缀式，需要补 `vpnBase()`（lnu 里有现成写法）。
10. **明文 http 登录页**：`loginUrl` 与上游 `import_url` 一样是 `http://`，这是学校自己的站点；我们只让用户在 WebView 里打开它，不在脚本里发任何凭据。

签名：0x7E7-2023（sonnet 移植，2026-10-20）
