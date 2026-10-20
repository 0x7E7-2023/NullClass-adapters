# 安全审计 —— 山东水利职业学院（树维 EAMS 平台）

审计对象：`jw-adapters/sdwcvc/` 下的 `extract.js` / `parse.js`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `SDWCVC/sdwcvc_01.js`（MIT，`adapters.yaml` 的 `maintainer` 是 `小漫君`；
`adapter_id` 是 `SDWCVC_01`，`import_url` 是 `https://sso.sdwcvc.cn/`）。

- 上游快照：`19a65bf07a3e998fcfc69cee692387cdc0523c1a`（2026-10-19 22:41 拉取，2026-10-20 复核仍是最新）
- 本校脚本最后一次修改：`494e3ce`（2026-10-19）。`git log -1 -- resources/SDWCVC/sdwcvc_01.js` 实测与任务卡一致
- 移植者：`0x7E7-2023`（sonnet 移植），日期：2026-10-20，key：`sdwcvc`，版本 1.0.0
- 平台：**树维 EAMS**（上海树维信息科技有限公司 / SupWisdom，路径 `/eams/`）。不写「强智」（强智的路径是 `/jsxsd/`）
- 上游文件头自述：周次位图、逐周合并、日期校验复用 `ZUA/zua.js`（沿用 `HFNU/hfnu.js`），教学周历的英文日期格式参考 `HIIT/hiit_01.js`

审计方式：逐行读上游脚本 + 逐行读移植件；`extract.js` 在真实 Chromium（Playwright）里对着假教务站实跑，
`parse.js` 用与 CI 同口径的 Rhino 1.8.0 解释模式实跑；静态扫描：

```
grep -oE "https?://[A-Za-z0-9.:/_-]+" SDWCVC/sdwcvc_01.js | sort -u
grep -nE "fetch\(|XMLHttpRequest|sendBeacon|new WebSocket|\.src\s*=|localStorage|sessionStorage|document\.cookie|password|eval\(|new Function|Function\(" SDWCVC/sdwcvc_01.js
```

上游扫描结果：绝对 URL 只有一个教务主机 `https://jw.sdwcvc.edu.cn`（加注释里的学校官网作息页与上游仓库）；
网络调用只有 `requestText()` 里的一处 `fetch`（被五个调用点复用）；**没有** `eval` / `new Function` / `Function(...)`
（比同族 xatu、zua 干净——它们的上游用 `Function` 解析学期列表，本校上游改成了 DOM 读 option，没有这个问题）；
没有 `XMLHttpRequest` / `sendBeacon` / `WebSocket` / `.src =` / `localStorage` / `sessionStorage` / `document.cookie` / `password`。
上游里有桥调用（`showAlert` / `showToast` / `showSingleSelection` / `saveCourseConfig` / `savePresetTimeSlots` /
`saveImportedCourses` / `notifyTaskCompletion`），移植件全部没有搬（见 §5）。

## 1. 请求域与请求清单（本节必须与代码一致，不许写得比代码窄）

移植件不沿用上游的写死主机常量去拼地址，而是用**当前页面的 origin**（`originOf()`）+ 上下文路径 `/eams`
（`eamsBase()`）拼；同时用 `notInJw()` 守卫，只有当前主机就是教务主机 `jw.sdwcvc.edu.cn` 才会发请求，所以
**实际请求的主机只有这一个**。`manifest.json`：`loginUrl` 是统一认证 `https://sso.sdwcvc.cn/`（学生从这里登录，再在门户里
打开「教务系统」），教务主机与它不同源，所以 `allowHosts` 写 `["jw.sdwcvc.edu.cn"]`（只写主机名，无通配）。
`scheduleUrlHint` 是 `https://jw.sdwcvc.edu.cn/eams/courseTableForStd.action`。

| 谁 | 方法 | 地址（相对 `<origin>/eams`） | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| extract.js | GET | `/courseTableForStd.action` | 无 | 课表入口页：读学号 `ids`（请求体要用）和当前学期 id（`entityId`，后备是学期栏元素的 `value`） | 报错「没能读到课表页的信息……请先登录统一认证……」 |
| extract.js | POST | `/dataQuery.action` | `dataType=semester&entityId=<当前学期 id>` | 学期列表（`<option>`），只用来查当前学期的名字 | 不算失败，交空串，parse.js 按导入日期推学期名并说明 |
| extract.js | POST | `/courseTableForStd!courseTable.action` | `ignoreHead=1&setting.kind=std&startWeek=&semester.id=<当前学期 id>&ids=<学号>` | 取整学期课表页 | 报错「教务系统返回错误（代码 N）」或「连不上教务系统」 |
| extract.js | POST | `/base/calendar-info.action` | `version=1&semesterId=<当前学期 id>` | 教学周历：开学日与总周数 | 不算失败，交空串，parse.js 按学期名推算开学日并说明 |

以上四条请求的路径、方法、请求体与上游逐字一致（上游多发一次的请求没有：上游一共就这四条）。上游的 `requestText` 不带
`X-Requested-With`，移植件同样不带；`Content-Type` 为 `application/x-www-form-urlencoded; charset=UTF-8`，`credentials: 'include'`。

**登录页 / 门户页判断（不发请求）**：`notInJw()` 在发任何请求之前检查——当前主机不是 `jw.sdwcvc.edu.cn`（统一认证页、
门户页、学校官网）或路径是教务的登录页（`/eams/login*.action`），直接 `throw` 大白话提示，一个请求都不发
（冒烟 `login-page` / `portal` / `other-host` 三个场景实测请求数为 0）。教务主机根路径 `/` 不在此列，会照常发请求
（与上游「只要 origin 是教务主机就继续」一致，冒烟 `jw-root`）。已发请求后若被重定向到 `/eams/login*.action`
（`isLoginUrl(response.url)`），报「教务系统返回了登录页」。

**交出去的数据（逐字段，`extract.js` 的返回值）**：

| 字段 | 内容 | 白名单做法 |
|---|---|---|
| `today` | 本机日期 `yyyy-MM-dd` | 无敏感 |
| `semesterId` | 当前学期 id（纯数字） | 教务公共数据 |
| `semesterOptions` | 学期列表里的 `<option>…</option>` 元素 | 只留 option 元素（学期 id + 学期名），响应其余部分丢弃 |
| `courseDigest` | 课表页里的 `unitCount = N;`、教师声明、`new TaskActivity(…);`、`index = …;` 这几类语句，按出现顺序 | 只用 `DIGEST_RE` 摘这几类语句，页面其余部分（表头、姓名、学号等）全部丢弃；教师声明重写成只含姓名的 `var teachers = [{name:"…"}];`（教师内部 id 不交出去，最多 30 个姓名） |
| `activityCount` | 课表页原文里 `new TaskActivity(` 的个数 | 一个整数，用来对账 |
| `calendarTerm` / `calendarRange` | 「学年度 / 学期」后面那一格的文字（≤40 字）、「起 ~ 止 (总周数)」那一段 | 只留这两小段，周历页其余内容丢弃 |

学号 `ids` 只进请求体，**不进交出去的 JSON**；冒烟里课表页表头、脚本变量、周历页、学期列表都埋了姓名、学号、身份证号、手机号、教师内部 id，
交出去的 JSON 和最终载荷里都搜不到（冒烟脚本逐场景断言）。TaskActivity 的参数里有课程序号、教室 id 这类课程 / 房间数据，不是个人信息，
原样保留（parse.js 只读课名、教室、周次三个参数）。

## 2. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。两个脚本都没有 `password` / 登录表单读取，也没有 `localStorage` / `sessionStorage` / `document.cookie`。唯一的「凭据」是浏览器自带的会话 Cookie，脚本不读它、不把它发到别处。学号 `ids` 是课表入口页里公开的表单参数（接口自己要求的值），只进请求体 |
| 2 | 不外发 | **过**。全部 `fetch` 在 `extract.js` 的 `request()` 里；地址由 `window.location.origin` + `/eams` 拼，且 `notInJw()` 保证只在教务主机上发。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单 |
| 3 | 请求域可控 | **过**。请求主机只有 `jw.sdwcvc.edu.cn`；`allowHosts` 只写这一个主机名，无通配；`loginUrl` 的主机 `sso.sdwcvc.cn` 只是登录入口，不在请求清单里 |
| 4 | 只读课表 | **过**。四条请求全部落在 `/eams/courseTableForStd*.action`、`/eams/dataQuery.action`（`dataType=semester`，学期列表）与 `/eams/base/calendar-info.action`（学期周历），**不碰成绩、学籍、个人信息、缴费**等接口。学期列表与周历是学校公共数据 |
| 5 | 不埋点 | **过**。没有统计 / 上报 / 遥测 |
| 6 | 不 eval 远程代码 | **过**。两个脚本没有 `eval` / `new Function` / `Function(`；对网络取回内容的处理全是正则与字符串切分，`JSON.parse` 只用于宿主给的 `__ncInput`。上游本身也没有（见上） |
| 7 | 不写页面 | **过**。`extract.js` 不碰 `document`，不改表单、不点击、不提交；取回的 HTML 只当字符串处理。上游的 `showAlert` / `showToast` / `showSingleSelection` / `notifyTaskCompletion` / `saveCourseConfig` / `savePresetTimeSlots` / `saveImportedCourses` 桥调用全部没有移植 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码密钥、令牌或他人学号。常量只有教务主机名、`/eams`、几条 `.action` 路径与学校公布的作息时间 |

**结论：可以进内置库**（受 §10 的未验证项约束）。

## 3. 模板选择

- **选了 `xatu`（树维 EAMS，1.1.0）为底**：同平台、同一套 TaskActivity 解析骨架（`powerSplit` → 位图 → `index` → 逐周合并），
  且 xatu 1.1.0 刚跟进了上游新写法，提醒文案已按批次十的统一修订改成大白话。`zua` 作对照（同样读 `calendar-info`，
  但它是批次四的件，提醒里还有「适配器内置」「作息表」「上游脚本」之类开发者视角的词，所以没有当底）。
- **没有照抄 xatu 的取数层与学期层**：xatu 的取数层读的是 `semesterCalendar` 学期列表 + 教务首页的当前教学周，开学日来自学期起止日期；
  本校上游走的是 `dataType=semester` 学期下拉（HTML option）+ `calendar-info` 周历，两条取数路径完全不同构，所以 `extract.js` 与
  parse.js 的学期 / 周历部分按本校上游重写，只借了 xatu 的解析骨架与提醒汇总写法。
- **与 xatu 的不同构之处**：
  1. 学期列表：xatu 是 JS 对象字面量（需要配平切块），本校是 `<option value=id>学年-学年-序号</option>`，用正则读；
  2. 开学日与总周数：xatu 用学期起止日期 / 首页当前教学周，本校用 `calendar-info` 周历（英文日期 `Sep 1, 2025 ~ Jan 18, 2026 (20)`），且要和所选学期核对；
  3. 节次时间：xatu 是 12 节内置表，本校是学校官网公布的 10 节统一作息（逐节核对见 §5 ④）；
  4. 没有 xatu 的「教 3 楼第 3-4 节」自定义时间、没有首页当前教学周、没有课程序号进合并键；
  5. 本校 `index` 只有 `N * unitCount + M` 一种写法（上游正则），xatu 另认裸数字。

## 4. 与上游对齐的地方（取数与解析语义照上游）

- 请求路径、方法、请求体（§1）；`ids` 与学期 id 的正则（`bg.form.addInput(form,"ids","…")`、`entityId:"…"`）；
- `unitCount` 与 `index = N * unitCount + M`（日 = N + 1，节 = M + 1）；`new TaskActivity(...)` 按 `powerSplit` 切参数，取
  `args[3]` 课名、`args[5]` 教室、`args[6]` 周次位图；
- 按 `var teachers =` 切块、教师取 `actTeachers` 里的 `name` 去重用逗号连起来；
- 位图下标即周次（下标 0 是占位符）；`mergeContinuousLessons`：按（课名 | 教师 | 教室 | 星期）分组，逐周记下占用的节次，再把每周的连续节次合成块，
  同一块里周次相同的归一组；
- 周历解析：学期格（`学年度 / 学期` 后面的格子）去空白换成 `-` 后要等于所选学期名，再在全文找 `Mon D, YYYY ~ Mon D, YYYY (N)`。

## 5. 移植改动（逐条，对应 `extract.js` / `parse.js` 文件头的编号）

| 编号 | 改动 | 理由 |
|---|---|---|
| extract ① / parse ① | ES6 → ES5：异步改 `Promise` then 链；去掉模板串、箭头函数、块级声明、展开、`Set`、`Array.from`、`URLSearchParams`、可选链、`padStart`、`matchAll` | 规范 §3.1；Rhino/旧 WebView |
| extract ② / parse ② | 不弹窗选学期：用课表页给的当前学期（`entityId`）；学期列表只用来查名字，取不到不影响导入（学期名按导入日期推，并写提醒） | 手册 §3 第 1 步；上游是 `showSingleSelection` |
| extract ③ | 登录页 / 门户页 / 官网页上点「提取课表」直接提示，不发请求；已发请求后重定向到登录页也报错 | 公共说明共性第 6 条；上游对非教务主机只弹一次提示 |
| extract ④ | 白名单：课表页只留 `unitCount` / 教师声明（只留姓名）/ `TaskActivity` / `index` 语句；学期列表只留 option；周历只留两小段 | 个人信息不带出；公共说明共性第 3 条 |
| extract ⑤ / parse | 不解析、不算周次、不拼课：位图、合并、日期、节次时间全在 parse.js | CI 只跑 parse.js |
| extract ⑥ | 桥调用全部不搬 | 「拉」不是「推」 |
| extract ⑦ | `calendar-info` 取不到不整次失败（上游整次报错）：交空串，parse.js 回落并说明 | 不丢课、不因为一个可推算的值拒绝导入 |
| parse ③ | 上游遇到任何结构不符就整次报错（教师声明、课程活动、位图、校历与学期不一致……）；这里能读多少读多少，读不懂的按类型汇总写进提醒 | 手册 §4：不许静默丢课，也不要无谓拒绝 |
| parse ④ | 学校统一作息第 1～10 节逐节照抄上游 `SDWCVC_TIME_SLOTS`；课表用到第 10 节以后的节次时按「统一修订 H3」逐节补（上游直接报错「节次超出学校统一作息表」） | 公共说明硬约束 11 |
| parse ⑤ | 周历起始日不是周一就回退到那一周的周一并说明（上游整次报错）；总周数 > 30 按 30 并说明（上游允许到 60，我们载荷上限 30）；学期格与所选学期不一致 / 读不出周历时不用，按学期名推算开学日（第一学期 9 月 1 日所在周的周一，第二学期 2 月 20 日所在周的周一）并说明；纯数字日期写法也认（后备） | 载荷校验 totalWeeks 1..30；不猜开学日但推算要说清 |
| parse ⑥ | 位图第 0 位为 1 时不产出「第 0 周」，只写提醒；超过 30 周的周次丢弃并写提醒（上游保留到 60） | 载荷校验 startWeek/endWeek ∈ 1..30 |
| parse ⑦ | 课程名：先剥尾部 `<sup …>…</sup>` 标签，再只剥「明显是课程代码」的尾部括号（`isCourseCode`：纯 ASCII、带数字、4 位以上或带 `.` `-` `_`）。上游先删任意尾部括号、再删尾部 sup（顺序反了，带标签的课名会留着课程代码，也会把「大学英语(一)」砍成「大学英语」） | 课名保真，见 §9 风险 |
| parse ⑧ | 教师 / 教室拿不到就留空（null），按类型汇总写进提醒（点名课名截 20 字），提示去对应课程的「编辑课程」里补 | 手册 §4.7 |
| parse ⑨ | `index` 除 `N * unitCount + M` 外，也认 `N * 14 + M` 和裸数字（裸数字要有 `unitCount` 才能反推，缺就计数丢弃并说明）；节次超过 `unitCount` 的下标计数丢弃并说明（上游报错） | 不静默丢课；不猜节次数 |
| parse ⑩ | 排序改成确定性比较（上游 `localeCompare`，Rhino 与 V8 结果未必一致） | fixture 逐数组比对 |
| parse ⑪ | 全部提醒与报错改大白话；点名课名截 20 字、整条 ≤200 字、总数 ≤20 条，走同一个出口 `warn()` | `docs/ux-writing.md`；载荷校验 |
| parse ⑫ | 教师按活动取：每条活动先看自己前面有没有 `actTeachers`，有就用，没有沿用上一条的，整块都没有才用块头 `teachers` 声明里的姓名（上游取整块第一个 `actTeachers`） | 与 xatu 1.1.0 的口径一致（同族上游 983137a），多活动块里教师不会错挂 |

### 上游里被删掉 / 改掉的东西

- 全部桥调用（`showAlert` / `showToast` / `showSingleSelection` / `saveCourseConfig` / `savePresetTimeSlots` / `saveImportedCourses` / `notifyTaskCompletion`）：
  不是「推」模式，作息表放进载荷的 `periodTimes`，学期配置放进 `terms[0]`。
- 学期选择弹窗：见 ②。
- `window.location.origin !== BASE_URL` 的写死主机比较：改成 `notInJw()`（主机名守卫）+ 同源 origin 拼地址，走 http 还是 https 由用户实际打开的地址决定。
- 上游「课程名 / 周次位图无效就整次报错」「教师声明结构不符就报错」「`parsedCount !== expectedCount` 就报错」等硬失败：改成汇总提醒（§5 ③）。
- 上游里没有需要因安全原因删除的内容（没有 `eval`、没有外发、没有凭据）。

## 6. 载荷与提醒

- `terms[0].name`：教务学期列表里当前学期的名字 `2025-2026-1` → `2025-2026学年第一学期`；取不到时 `山东水利职业学院 <按导入日期推的学年学期>` 并写提醒，不用适配器名。
- `firstDay`：周历起始日（回退到周一）；周历取不到 / 与所选学期对不上时按学期名推算并写提醒。
- `totalWeeks`：周历括号里的周数（> 30 按 30）；周历没有时取课表里最晚的周次；课表里有比周历更晚的周次时抬到那一周（提醒里说明）。
- `periodTimes`：学校统一作息 10 节（逐节抄上游，08:15-09:00 / 09:10-09:55 / 10:10-10:55 / 11:05-11:50 / 14:30-15:15 / 15:25-16:10 / 16:20-17:05 / 17:15-18:00 / 19:30-20:15 / 20:25-21:10）；
  课表用到更晚节次时：空课默认 12 节表里同号且开始不早于上一节下课的用它，否则课间 5 分钟、每节 45 分钟顺推，越过 23:59 的不补，补了哪些、补不了哪些都写进提醒。
  这张表**不是从教务读取的**，提醒里每次都写明（「请对照学校通知核对」）。
- 周次切段（`runsOf`）：步长 1 = 每周，步长 2 = 单 / 双周（按起点奇偶），落单的一周是 `ALL`；一个活动可以切出多个块。位图本身不含 `(单)/(双)` 文字，
  所以公共说明里「单双标记归属 / 共 N 周备注」那两个文字类陷阱在本校不适用；对应的风险（单双周段接在一起时不能并成每周）由 `week-runs` 用例钉住。
- 提醒一览（顺序固定）：学期名推算 → 只导入当前学期 → 开学日来源（含回退 / 忽略校历 / 推算）→ 总周数来源 → 节次时间来源 → 节次补充 / 补不了 → 缺教师汇总 → 缺教室汇总 →
  无课名 → 没能导入的上课安排汇总 → 课表条数对账 → 第 0 周 → 超出 30 周 → 读不懂的周次标记。

## 7. fixtures（8 对，全部合成，期望值先手工推出再比对）

`fixtures/*.extracted.json` 的形状就是 `extract.js` 实际交出的对象（课表页是摘要后的语句，周历是两小段）。期望值由生成脚本里的字面量写出
（独立于 `parse.js`，没有把输出存成期望）。覆盖：

1. `basic`：当前学期 2025-2026-1、周历英文日期且学期格与所选学期一致、连续两节并成 1-2 节、同一门课跨两天、两位教师、
   课名带课程代码与 sup 标签、教室带括号原样、`(一)` / `(3)` 这类短后缀课名保留、教师重复去重；
2. `week-runs`：**本校专属边界**——单周段接双周段（1-7 单 + 10-16 双）、每周段接单周段（1-3 + 5-7）、双周段后落单周、同一门课不同周占不同节次、
   跨活动同周同教室的相邻节次合并、仅有块头教师声明、块头比本活动多一位教师、同一块里每条活动各有 `actTeachers` 与沿用上一条；
3. `dirty-bitmap`：第 0 位为 1、31 位以后的周次丢弃、位图里夹杂非 0/1 字符、一位都没有的活动、参数不足的活动、条数对账（页面 7 条只读到 5 条）、周次抬高总周数；
4. `calendar-nonmonday`：周历起始日是周三 → 回退周一并说明；周数 32 > 30 → 按 30 并说明；
5. `calendar-mismatch`：周历属于另一个学期 → 忽略；第二学期按 2 月 20 日所在周的周一推算；总周数取课表最晚周次；
6. `no-semester`：学期列表与周历都取不到；`N * 14 + M` 写法；缺 `unitCount` 时裸数字读不了并计数；没有 `index` 的活动计数；
7. `late-periods`：用到第 11–14 节（11–13 节顺推补时间、14 节越过 23:59 补不了）；节次超过 `unitCount` 与星期第 8 天计数丢弃；纯数字日期的周历；裸数字 `index = 28`；
8. `long-names`：缺教师 / 缺教室汇总（5 门课、课名 60 字，点名截到 20 字，整条提醒 < 200 字）；无课名按「未知课程」；`(2025)` 4 位数字后缀判定为课程代码剥掉。

## 8. 变异测试（在临时目录的副本上改 `parse.js`，实跑 `check.js`；13 处全部变红，已还原，最终自检 PASS）

| # | 改坏的地方 | 变红的用例 |
|---|---|---|
| 1 | `runsOf` 的步长判断（单双周段不再识别） | `basic`、`week-runs` |
| 2 | 位图第 0 位为 1 时不再写提醒 | `dirty-bitmap` |
| 3 | 超过 30 周的周次改成 clamp 到 30 | `dirty-bitmap` |
| 4 | 课程名去尾部括号改回上游口径（任何尾部括号都删） | `basic`、`long-names` |
| 5 | 课程名不再先剥 `<sup>` 标签 | `basic` |
| 6 | 周历与所选学期核对去掉 | `calendar-mismatch` |
| 7 | 周历起始日不再回退到周一 | `calendar-nonmonday` |
| 8 | 节次补时间去掉「不早于上一节下课」守卫 | `late-periods` |
| 9 | 顺推越过 23:59 的守卫去掉 | `late-periods` |
| 10 | 点名课名不再截 20 字 | `long-names` |
| 11 | 教师改回上游口径（整块只取第一个 `actTeachers`） | `week-runs` |
| 12 | 有 `actTeachers` 时仍优先用块头 `teachers` | `week-runs` |
| 13 | 裸数字 `index` 的反推改成直接当节次 | `late-periods` |

过程中还靠变异测试发现并补了三条用例：第 0 位那一处最初是等价变异（合并只读第 1..30 周，`continue` 删了也不影响结果），改成「不再写提醒」后才有意义；
clamp 与块头教师两处最初没有用例能区分，补进了 `dirty-bitmap`（位图含第 28 周且 31–33 位为 1）和 `week-runs`（块头比本活动多一位教师）。

## 9. 浏览器冒烟（`.test/port-batch13/sdwcvc/smoke.py`，12 个场景全部 OK）

Chromium + Playwright，全部请求被 `route` 拦下（不联网），假教务站按 §1 的路径、方法与请求体断言；`extract.js` 的输出再交给 Rhino 跑 `parse.js`：

| 场景 | 内容 | 结果 |
|---|---|---|
| `normal` / `course-page` / `jw-root` | 在 `/eams/home.action`、`/eams/courseTableForStd.action`、教务根路径 `/` 上点提取 | 依次发出 GET 入口页、POST 学期列表（`dataType=semester&entityId=101`）、POST 课表（`ignoreHead=1&setting.kind=std&startWeek=&semester.id=101&ids=…`）、POST 周历（`version=1&semesterId=101`），全部打在 `jw.sdwcvc.edu.cn/eams/…`；交出的 JSON 里没有姓名 / 学号 / 身份证 / 手机号 / 教师内部 id；载荷学期 2025-2026学年第一学期、开学日 2025-09-01、20 周、10 节 |
| `login-page` / `portal` / `other-host` | 在 `/eams/loginExt.action`、`sso.sdwcvc.cn`、`www.sdwcvc.edu.cn` 上点提取 | 直接报「现在还不在教务系统里：请先登录统一认证……」，**请求数 0** |
| `expired` | 课表请求被 302 到登录页 | 报「教务系统返回了登录页……」 |
| `entry-bad` | 入口页没有 `ids` / 学期 id | 报「没能读到课表页的信息……」 |
| `course-500` | 课表请求 500 | 报「教务系统返回错误（代码 500）……」 |
| `cal-500` / `sem-500` | 周历 / 学期列表 500 | 照常导入，提醒里说明开学日推算 / 学期名推算 |
| `empty-term` | 课表页没有任何 TaskActivity | parse.js 报「这个学期没有读到任何课程……」 |

## 10. 已知风险与未验证项

- **没有真机验证**：我们没有山东水利职业学院的教务账号。以下全靠上游脚本推断，真机上需要确认：
  1. 课表入口页里 `bg.form.addInput(form,"ids","…")` 与 `entityId:"…"` 的真实写法（后备是 `semesterBar…Semester` 元素的 `value`）；
  2. `dataQuery.action`（`dataType=semester`）真的返回 `<option value=id>学年-学年-序号</option>`；
  3. `calendar-info.action` 的 HTML 是「学年度 / 学期」+「开始 / 结束日期」两格，日期是英文 `Sep 1, 2025 ~ Jan 18, 2026 (20)`；
  4. `TaskActivity` 的第 4 个参数（课名）是否真的带课程代码括号、以及尾部 `<sup>` 里放的是什么——**上游把 sup 内容一并删掉，我们也删**，若里面其实是有用信息（如「重修」）就丢了；
  5. 课程代码的真实形态：`isCourseCode` 认纯 ASCII + 数字 + 4 位以上 / 带分隔符；如果学校的课程代码形态更特别（含中文、很短），课名里会残留括号。
- **只能导入教务系统当前学期**：上游让学生弹窗选学期；公共说明要求不弹窗，而 `extract.js` 每次都会重新打开课表入口页，学生在教务页面上切换学期不会影响它读到的当前学期。
  所以提醒里写的是「这次导入的是教务系统当前学期……其它学期暂时不能导入」，没有承诺「切学期后可以再导入」。这是相对上游的功能收窄，**需要主调度决定**要不要加 `__ncSelect` 学期选择。
- **节次时间不是从教务读的**：10 节统一作息抄自上游（学校官网「作息时间」页），学校若有分校区 / 分季节作息，课表时间会不准；提醒里每次都写明并请核对。
- 周历若不是英文日期也不是 `yyyy-MM-dd ~ yyyy-MM-dd (N)`，会按「没有可用周历」处理，开学日按学期名推算（第一学期 9 月 1 日、第二学期 2 月 20 日所在周的周一），可能差一两周，提醒里已说明请学生核对。
- 假教务站是我们按上游代码手写的，只能证明脚本与上游的请求 / 解析一致，不能证明真实页面长这样。

## 11. 对照「审计真抓到过的错」逐条自查

- 多段周次里段首 `(单)` / `(双)` 并到上一段：本校位图无文字标记，不适用；单双周段衔接由 `week-runs` 钉住；
- 区间终点前带「第」/「共 N 周」备注：本校位图无文字周次，不适用；
- 提醒里的开发者视角词：已按术语表自查（无「接口」「载荷」「上游」「脚本」「字段」「课程块」「组件」「模板」「HTTP」「JSON」「DOM」「HTML」「null」「学期设置」「作息表」「适配器」「内置」；节次时间统一叫「节次时间」，应用里改学期叫「学期管理」，教师 / 教室在「编辑课程」）；
- 带课名的提醒限长：课名截 20 字、点名最多 3 门、整条 ≤200 字、总数 ≤20 条，同一出口 `warn()`；`long-names` 用 60 字课名钉住；
- 行号引用漂移：本文件一律按函数名 / 提醒名引用，不写行号；
- 模板学校的名字 / 主机 / key 残留：全目录搜过 `xatu` / `西安` / `jwgl2018` / `晨熯` / `zua` / `郑州`，只在注释里有意写了「以 xatu 为底」「复用 zua」；
- 同一份响应两处判断外壳不一致：课表页只在 `extract.js` 的 `DIGEST_RE` 与 `parse.js` 的 `TaskActivity` / `index` 正则里各定义一次，且 `activityCount`（原文个数）与摘要后的个数对账，不一致会出提醒。

## 12. 签名

0x7E7-2023（sonnet 移植，2026-10-20）
