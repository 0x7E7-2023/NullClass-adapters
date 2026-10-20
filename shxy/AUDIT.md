# 安全审计 —— 绥化学院（乘方智慧教务，jwgl.shxy.edu.cn）

审计对象：`jw-adapters/shxy/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `SHXY/shxy.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，2026-10-20 复核仍是最新；
MIT，作者 Haooz，`adapters.yaml` 的 maintainer；本校脚本最后一次修改 `80e30cf`，`git log -1 -- resources/SHXY/shxy.js` 核对一致）。

审计方式：逐行读上游脚本（234 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，`extract.js` 注释里一处
  `http://jwgl.shxy.edu.cn/…`（说明上游把地址写死成绝对地址）。代码里没有任何绝对地址，请求路径全是以 `/` 开头的相对路径。
  `manifest.json` 里的 `loginUrl`、`homepage` 是给宿主看的声明，不是请求。
- 网络调用：`extract.js` 里只有两处 `fetch(`：`request()`（POST，课表与开学日期）和 `fetchTermSelect()`（GET，课表页）。
  `X-Requested-With: XMLHttpRequest` 是请求头字符串，不是 XHR 对象。`parse.js` 里没有任何网络调用、没有 `document.` / `window.` / 桥调用。
- 凭据、本地存储、动态执行、写页面：`localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` / `sendBeacon` /
  `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit` / `setAttribute` / `.click(` 全部无命中。
  `password` 只命中 `hasLoginForm()` 里的一处选择器 `input[type="password"]`：**只判断页面上有没有密码输入框**（用来认出登录页、不发请求），
  不读它的 `value`、不碰其它输入框。自检脚本对这个字样的提示即来源于此。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、展开符、可选链、`??`、`padStart`、
  `Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(`、`for…of` 全部无命中。
- 模板残留：`extract.js`、`parse.js`、`manifest.json`、`fixtures/` 检索「西南」「swu」「hueb」「jwglxt」「正方」，只有 `parse.js` 文件头与两处注释里有意写
  「照 swu」（说明通用部分的来源）。
- 个人信息：`fixtures/` 全部为合成数据（教师甲 / 乙 / 丙…，厚德楼 / 崇德楼 / 主楼等教室），没有真实姓名与学号。
  `extract.js` 里出现的「学号、姓名」只在注释里说明被丢弃的字段。

## 0. 上游情况与任务卡核对

- 上游 `SHXY/shxy.js` 文件头与 `adapters.yaml` 一致，校名「绥化学院」，无需修正。`import_url` 是 `http://jwgl.shxy.edu.cn/`（**http**），原样用作 `loginUrl`。
- 任务卡写的平台「乘方 / 智慧教务」与上游代码一致：上游唯一的取数请求是
  `POST http://jwgl.shxy.edu.cn/new/student/xsgrkb/getCalendarWeekDatas`，请求体只有 `xnxqdm=<学年起始年 4 位><01|02>`。
- **库里没有同平台的已审计件**：`jw-adapters/` 里的 `glmu` / `hbmu` 虽然和乘方同属「xsgrkb」前缀，但它们走的是 `/xsgrkbcx!getDataList.action`（Struts2 另一套），
  不是同一个平台，没有选作模板。通用部分（周次写法、同课合并、提醒限长、节次补齐、H3）复制批次十已审计的 `swu`，
  理由：它是最新一批、审计修正最多（含 `week-adjacent` 的相邻单双标记修正）的一件，且 parse.js 结构（entries → 合并 → block）最适合这里「一行按教室拆成多条」的需要；
  取数（extract.js）与按教室拆课、校区节次时间按上游 `SHXY/shxy.js` 重写。
- 同平台还有 GXMU、SDIPCT、CMC、LIT、NENU、HNSF、GLMU 的上游脚本。读过它们来确认平台的另外两个接口（见 §1 的请求 1、3），但只交本校，没有合并多校共用的实现。

## 1. 请求域与请求清单（与代码逐条对应）

只访问用户当前打开的教务主机，地址全是相对路径，代码里没有写死主机名；`window.location.hostname` 必须等于 `jwgl.shxy.edu.cn`，
否则（停在统一认证或别的站点）直接抛提示、**不发请求**。所以 `allowHosts` 为空数组。

| # | 方法 | 路径 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `/new/student/xsgrkb/week.page` | 无 | 读学期下拉框 `#xnxqdm`（同平台 CMC / LIT / NENU 都这么读）。**上游没有** | 当前页面已有 `#xnxqdm` 时不发；404 / 网络错误 / 改版 → 交 null，退回按日期推算学期；页面里有密码输入框（登录页）→ 抛「登录已失效」 |
| 2 | POST | `/new/student/xsgrkb/getCalendarWeekDatas` | `xnxqdm=<学期代码>`（与上游一字不差） | 取整学期课表（JSON：`{code:0, data:[…]}`） | HTTP 401/403 → 「教务系统拒绝访问（代码 N）」；其它非 2xx → 「教务系统返回错误（代码 N）」；网络错误 → 「连不上教务系统」；响应不是 JSON / 没有 `data` 数组 → 「没有返回课表数据」；`code` 不是 0 → 「没有返回课表数据（代码 N）」 |
| 3 | POST | `/new/xlxx/getDatesOfWeek` | `xnxqdm=<学期代码>&zc=1` | 取第 1 周的日期（开学日）。**上游没有**，同平台 CMC 脚本用它 | 任何失败（非 2xx / 不是 JSON / 超长）一律交 null，parse.js 推算开学日并写 warnings |

- 请求 2、3 在取到课表前并发发出（`gather`）；课表一门课都没有时，若宿主允许提问，用 `__ncSelect` 问一次要导入哪个学期，换学期后重发 2、3。
- 请求头统一为 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: application/json, …`，
  全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。上游只带 `content-type`，多出的两个头是同平台其它上游脚本都带的。
- 请求 2 的失败不吞：没有课表就没有可导入的内容，直接报给学生。请求 1、3 的失败一律吞掉交 null：附加请求挂掉不能导致整次导入失败。
- 登录页（页面里有密码输入框，或路径含 `login`）与别的主机**不发任何请求**，直接抛大白话提示。
- 学期代码来源，按顺序：① 当前页面 `#xnxqdm` 选中项（用户在页面里切到哪个学期就是哪个，`option.selected` 优先，其次 `selected` 属性，最后第一项；
  只认 value 是 6 位数字的项）→ ② 请求 1 读到的默认项 → ③ 按当前日期推算（8 月 – 次年 1 月 = `<年>01`，2 – 7 月 = `<去年>02`，与上游的 `学年 + 01/02` 同形）。
  `term.source` 依次是 `page` / `default` / `auto` / `user`，parse.js 据此写第一条提醒。
- 提问（`__ncSelect`）最多两次：取不到课时选学期（候选是页面下拉框的项，没有下拉框时是推算出的最近 6 个学期）、判断不了校区时选校区。
  宿主没有 `ask` 能力、用户取消、提问报错都不让提取失败：学期退回「没有课」的报错，校区交 `index: null`。

## 2. 读了什么、交出去什么（逐字段）

**读了什么**

- 页面 HTML（请求 1，或当前页面）：`#xnxqdm` 的 `option` 的 `value` / `selected` / `textContent`；登录页判断只查有无密码输入框。
- 课表 JSON（请求 2）：`code`、`data[]`。
- 开学日期 JSON（请求 3）：数组（或 `{data:[…]}`）的每行 `xqmc`、`rq`。

**交出什么**（`JSON.stringify` 的结果，字段白名单挑出，不是整个响应）

| 字段 | 来源 | 说明 |
|---|---|---|
| `term.code` | 学期代码 6 位 | 请求体与学期名用 |
| `term.label` | 下拉框文字（≤60 字），推算时为空 | 学期名优先取它 |
| `term.source` | `page` / `default` / `auto` / `user` | parse.js 写第一条提醒用 |
| `today` | 本地日期 `YYYY-MM-DD` | 只在学期代码读不出时兜底 |
| `rows[]` | 每行只留 `kcmc` `teaxms` `jxcdmc` `jxcdmc2` `zc` `xq` `ps` `pe` | 课名、教师、教室、按周教室、周次、星期、起止节次；其它字段（学号、姓名、证件号、手机号、任务代码…）一律不带 |
| `dates[]` | 请求 3 的每行只留 `xqmc`、`rq`（≤20 行），取不到 `null` | 第 1 周的日期 |
| `campus` | `{asked, index}` | 问过用户才有答案；0 = 老校区、1 = 新校区、`null` = 没问到 / 取消 |

课表响应顶层夹带的 `xsxx` 之类对象（桩里放了学号）不在白名单里，冒烟测试确认没有出现在输出里。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。不读密码、不读 Cookie、不存任何东西；只判断页面上有没有密码输入框（`hasLoginForm`），不读它的值。上游的开场弹窗、学年 / 学期 / 校区弹窗、`saveImportedCourses` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 全部未移植（见 §5）。 |
| 2 | 不外发 | **过**。只有 `extract.js` 里的两处 `fetch`，路径全是相对路径，请求只会打到用户当前打开的教务主机（且提前确认主机名）。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，没有第三方域。 |
| 3 | 请求域可控 | **过**。`allowHosts` 为空（同源相对路径，不需要额外主机）；代码里的主机名只有一处用来拦截「不在教务主机上」的常量 `HOST`。 |
| 4 | 只读课表 | **过**。三个请求落在 `/new/student/xsgrkb/*`（课表页、课表）和 `/new/xlxx/getDatesOfWeek`（校历日期），不碰成绩、学籍、缴费、考试。响应里夹带的个人信息不带出。 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOrNull`，失败返回 null）与 `DOMParser`（离线解析课表页，不插入当前页面）。 |
| 7 | 不写页面 | **过**。读页面只用 `getElementById` / `getElementsByTagName` / `querySelector`，不改 DOM、不提交表单、不点击。 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有教务主机名、三个页面路径、两张节次时间表。 |

## 4. 与模板的差异

模板：库里没有同平台件（见 §0）。`parse.js` 的通用部分复制自 `swu`（批次十），下面是改动：

1. **取数整个重写**（`extract.js`）：乘方的三个请求、学期来源三级、主机与登录页拦截、白名单八字段、校区提问，都是新写的，与 `swu` 的正方取数无关。
2. **按教室拆课**（`parse.js` 的 `roomPiecesOf` / `addRoomWeek` 与逐行循环）：上游 `jxcdmc2`（形如「教室-周次,教室-周次,…」）逐段按最后一个「-」切开，同一教室的周次归到一起，每个教室一条课，课表周次取自这里；
   `jxcdmc2` 读不出任何一段时用 `zc` + `jxcdmc`（上游的「兜底方案」）。`swu` 一行只有一个教室，没有这一层。
3. **节次**（`sectionsOf`）：`swu` 读 `jcs` 文本（`1-2` / `第9-10节` / `0102`），这里读 `ps` / `pe` 两个数字；删掉多段「稀疏节次」的逻辑与提醒。
4. **没有的东西删掉**：`qsxqj` 每周起始日（每周按周一；乘方 `xq` 1..7 = 周一..周日）、课程备注 `cxbjmc` / `xkbz`（`note` 恒 null）、集中实践课 `sjkList`、教务节次时间接口（`cxRjc`）、校历接口（`cxZcByXnxq`）、记录总数对账。
5. **节次时间**：`swu` 是一张 14 节表，这里是两张 10 节表（老校区 / 新校区，逐节照抄上游 `CampusTimeSlots`），用哪张由 `campusOfRooms` → 提问答案 → 默认老校区决定（见 §5 第 7 条与 §8）。
   H3 补节次的逻辑原样保留：第 11、12 节取空课默认 12 节表同号且接得上的，第 13 节起顺推，越过 23:59 的如实说明。
6. **开学日**：`swu` 取校历；这里取 `getDatesOfWeek` 里 `xqmc` 为 `1`（周一）那一行的 `rq`，离学期锚点超过 45 天的视为别的学期、忽略并推算；推算锚点沿用 `swu`（9 月 1 日 / 2 月 20 日 / 7 月 1 日所在周的周一）。
7. **学期名**：取下拉框文字（含「学年」「学期」且 ≤40 字时直接用），否则用学期代码拼「YYYY-YYYY学年第N学期」（`01` 第一、`02` 第二、`03` 短学期），再不行用「绥化学院 学年学期」。
8. **第一条提醒**按 `term.source` 分四种写法（页面选中 / 教务默认 / 按日期推算 / 用户改选）；提醒里不用「作息」「接口」之类的词。
9. **教室与周次对不上的提醒**（`mismatchCourses`）：`jxcdmc2` 里有、`zc` 里没有的周次，按教室记录导入并点名提醒（上游直接信 `jxcdmc2`，这里把这种不一致说出来）。

**未改动的模板逻辑**（有 fixture 覆盖）：`weeksOf` 周次解析（含相邻单/双标记归属、「共 N 周」只剥备注、`第1-第8周`、括号序号 / 备注）、
两阶段合并（`dropExactDuplicates` → `mergeStageOne` → `mergeStageTwo`）、提醒统一限长（`shortName` 20 字 + `warn` 200 字）、
缺教师 / 缺教室的计数提醒、H3 逐节补齐。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart`（开场 `showAlert`） | 删 | 桥能力，宿主负责交互；提示文字改由 extract.js 的报错承担 |
| `getAcademicYear`（`showPrompt` 问起始学年）+ `selectSemester`（`showSingleSelection`） | 删，改为读页面 `#xnxqdm`、课表页默认项、按日期推算（§1） | 任务要求不弹窗问学年学期；要别的学期，用户在教务页面里切换后再提取；取不到课才用 `__ncSelect` 问一次 |
| `validateYearInput` | 删 | 只服务于学年弹窗 |
| `selectCampus`（`showSingleSelection` 选校区） | 改：先看上课教室，判断不了才用 `__ncSelect` 问一次，问不了 / 取消按上游默认的老校区并提醒 | 任务要求能自动判断就自动判断 |
| `saveImportedCourses` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` | 删，载荷交给宿主 | 空课由宿主保存；节次时间进载荷 `periodTimes` |
| `fetchCourses` 里的绝对地址 `http://jwgl.shxy.edu.cn/…` | 改成相对路径 + 主机校验 | 协议与主机跟随用户当前页面，避免 http 页面请求 https 地址（反之亦然）被浏览器拦截 |
| `parseJsonData` 的 `code !== 0` 或 `data` 非数组 → 静默返回空 | 改为分情况报错（§1 请求 2） | 公共说明：不许让学生面对「没有课」却不知道为什么 |
| `parseJsonData` 的 `!(kcmc && xq && ps && pe)` 整行静默丢弃 | 改为按原因计数写进提醒（缺课名 / 缺星期 / 缺节次） | 公共说明第 6 条：不许静默丢课 |
| `startSection <= endSection` 的静默过滤 | 改为计入「缺节次（或节次不合法）」并提醒 | 同上 |
| `teacher: raw.teaxms \|\| "未知教师"`、`position: room \|\| "未知地点"` | 改为 `null` | 手册 §4.7：写「未知」会被课表当成真名显示；缺教师 / 缺教室按类型汇总进提醒，指向「编辑课程」 |
| `Number(week)` 读 `jxcdmc2` 的周次（`isNaN` 才跳过；「A-101」读成第 101 周、空串读成第 0 周） | 周次必须是 1-30 的整数，三位数当教室编号跳过，31-99 计入「周次超出上限」 | 防止没带周次的教室名被读成周次；第 0 周 / 超上限周次会让整次导入被应用拒收 |
| `jxcdmc2` 主路径只信它的周次，`zc` 里多出的周次静默丢 | `zc` 里有而教室记录里没有的周次，用 `jxcdmc` 的教室补上 | 不静默丢周 |
| `parseWeeks`（逗号列表，`Number()` 过滤） | 换成 `swu` 的 `weeksOf` | 逗号列表是它的子集；多出的写法（`1-16周`、`(单)`、`第1-第8周`、`共 N 周`）本平台不一定出现，但接得住 |
| 不合并同课 | 照 `swu` 补两阶段合并 | 连续节次、同节次不同周次拆成多行是乘方的常态；合并不丢课、不改任何一周的安排 |
| 老 / 新校区各一张 10 节表 | 原样保留（逐节照抄） | 上游唯一的节次时间来源，没有教务读取的版本 |

## 6. 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/shxy-port14/mut/` 下做了十份副本（每份只改一处），各跑一次 `check.js`，结果如下。真实的 `parse.js` 未被改动，之后再跑自检通过。

| 编号 | 改坏哪一处 | 变红的用例 |
|---|---|---|
| m1 | 新校区第 3 节 `10:30` 改成 `10:40` | `new-campus`、`campus-asked`：`periodTimes[2].start` |
| m2 | `campusOfRooms`：只有厚德楼时返回新校区（判反） | `basic`、`new-campus`、`room-weeks`、`week-markers`、`late-periods`、`long-warnings` |
| m3 | 三位数不再当教室编号（`droppedWeeks` 对「A-101」也计数） | `room-weeks`：多出「周次超出上限」提醒 |
| m4 | 去掉「`zc` 里有、教室记录里没有的周次用 `jxcdmc` 补上」（兜底路径同走这一步） | `basic`、`new-campus`、`room-weeks`、`long-warnings`：课整门丢周 |
| m5 | `plausibleStart` 恒返回 true（教务给的开学日不再校验是否属于本学期） | `campus-default`：2025-09-01 被当成开学日 |
| m6 | 「(单)1-8周,(双)9-16周」前缀标记的预处理正则失效 | `week-markers`：单双归属错 |
| m7 | 去掉「教室记录里有 `zc` 之外的周次」的检测 | `room-weeks`、`long-warnings`：缺提醒 |
| m8 | 没问到校区时默认成新校区（上游默认是老校区） | `campus-default`：节次时间与提醒都错 |
| m9 | 「共 N 周」剥离改成 `/共.*$/`（从「共」删到行尾） | `week-markers`：`1-8周(共8周),9-16周` 后半段丢失 |
| m10 | `sectionsOf` 放行开始节次大于结束节次的行 | `long-warnings`：「节次颠倒」那行应被跳过并计入提醒 |

十处变异全部被对应用例抓住，还原后 `check.js` 通过。

## 7. fixtures、自检与冒烟

共 8 对合成用例（`manifest.json` 的 `fixtures` 与 `fixtures/` 一一对应）。期望值按规范与代码逻辑手工推演后写入（生成脚本 `D:/NullClass/.test/port-batch14/shxy/genfix.py`
里每条 block 都是手写的字面量，提醒文字也是手写，不是把 parse.js 的输出存下来），首次自检 8 对全部 MATCH。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 教室都在厚德楼 → 老校区 10 节（第 3 节 10:15-11:00、第 8 节 16:30-17:15）；按教室拆课（同一门课 1-8 周在 201、9-16 周在 305）；连续节次 1-2 + 3-4 合并成 1-4；奇数周 / 偶数周 / 分段周次（1-8、10-16）；兜底路径（`jxcdmc2` 为空）；开学日取教务日期；页面选中的学期 |
| `new-campus` | 教室都在崇德楼 → 新校区节次时间（第 3 节 10:30-11:15）；教务默认学期；开学日期取不到 → 9 月 1 日所在周的周一 2026-08-31 并说明；学期名由代码拼出；`1-8周` 写法 |
| `campus-asked` | 厚德楼与崇德楼的课都有 → 判断不了，用户选了新校区；按日期推算的第二学期（代码 `202502`）→ 2 月 20 日所在周的周一 2026-02-16 |
| `campus-default` | 教室没有楼名、提问被取消 → 按上游默认的老校区并说明；教务给的开学日 2025-09-01 不属于这个学期 → 忽略并推算；用户改选的学期 |
| `room-weeks` | 「A-101」不读成第 101 周；教室名带「-」（实验A-3-5）；教室为空 → `location` null；`zc` 有而教室记录没有的周次用 `jxcdmc` 补上（按教室拆成两块）；教室记录里有 `zc` 之外的周次 → 提醒；教室周次 45 超上限 → 丢弃并提醒；兜底路径 |
| `week-markers` | 兜底路径的 `zc` 写成「(单)1-8周,(双)9-16周」「1-15周(单) 共16周」「1-8周(共8周),9-16周」「第1-第8周」「共16周,1-15周(单)」 |
| `late-periods` | 老校区 10 节，课表用到第 11-12 节（空课默认时间）、第 13-14 节（顺推）、第 15 节（越过 23:59 补不了）；课表最晚第 23 周 → 总周数抬到 23 并说明 |
| `long-warnings` | 长课名 + 缺教师 / 缺教室 → 照常导入；提醒按类型汇总并点名课名截到 20 字（三个例子）；缺课名 / 缺星期 / 节次颠倒 / 认不出的周次（「第周」）/ 周次为空各一行被跳过并说明；完全相同的行去重；教室记录与周次对不上点名长课名；每条提醒不超 200 字 |

`check.js`（与 CI 同口径）：`RESULT: PASS`（8 对 fixture 全部 MATCH）。

**浏览器冒烟**（`python -I -X utf8 D:/NullClass/.test/port-batch14/shxy/smoke.py all`，Playwright 起假教务站，全部请求被拦截，不联网；跑真实 `extract.js`，输出再交给 Rhino 跑 `parse.js`）17 个场景全部 OK：

- `page`：当前页面有 `#xnxqdm` → 不发 `week.page`，直接 `POST …/getCalendarWeekDatas`（请求体恰为 `xnxqdm=202601`）+ `POST …/getDatesOfWeek`（`xnxqdm=202601&zc=1`）；
  `page-switched`：用户在页面里把下拉框切到 `202502` → 请求体是 `xnxqdm=202502`（`option.selected` 优先于 `selected` 属性）。
- `home`：页面没有下拉框 → 先 `GET /new/student/xsgrkb/week.page`，读到默认项 `202601`（`source=default`）；`home-nopage`：课表页 404 → 按日期推算（请求体与 Python 里同口径算出的学期一致，`source=auto`）；`dates-404`：开学日期接口 404 → 课表照常导入，开学日推算并说明。
- `empty-ask` / `empty-noask`：第一个学期一门课都没有 → 有桥时问一次（选项是页面下拉框的三项），选第二项后重发课表与日期请求，`source=user`；没有桥 → 报「没有取到课表数据」。
- `campus-ask` / `campus-cancel` / `campus-nobridge` / `campus-noroom`：厚德楼崇德楼混排（或教室没有楼名）→ 问一次校区；选新校区 → 第 3 节 10:30；取消或没有桥 → 老校区 + 默认校区提醒。
- `login-form`（页面有密码输入框）、`login-path`（路径含 login）、`portal`（`cas.shxy.edu.cn`，别的主机）：**不发请求**，给大白话提示。
- `expired`（课表接口回登录页）→ 「…登录状态可能已失效…」；`http500` → 「教务系统返回错误（代码 500）」；`code1`（`code` 不为 0）→ 「没有返回课表数据（代码 1）」。
- 每个场景都检查：所有请求都落在教务主机；请求和输出里都没有桩里放的学号 / 证件号 / 手机号 / 姓名 / 教室内部编号；交出去的行字段都在白名单内；提醒每条 ≤200 字。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

- **没有在真机上验证**。没有绥化学院账号，也没有登录后的真实页面。课表请求的路径、请求体、字段名（`kcmc` `teaxms` `jxcdmc` `jxcdmc2` `zc` `xq` `ps` `pe`）和节次时间全部以上游脚本为准；
  桩只证明拼出来的地址与请求体符合上游写法、解析逻辑自洽。
- **请求 1（`week.page`）和请求 3（`getDatesOfWeek`）是上游没有的**，依据是同平台另外几所学校（CMC / LIT / NENU）的上游脚本。
  绥化学院的乘方是否开放这两个路径、返回的形状是否一致未验证；取不到时的行为是退回按日期推算学期 / 推算开学日并在提醒里说明，不会让导入失败。
  `getDatesOfWeek` 里「`xqmc` 为 `1` 的那一行是周一、`rq` 是日期」的理解来自 CMC 脚本的 `rows.find(item => item.xqmc === "1").rq`；如果本校的 `rq` 带时间或星期，`isoOfAny` 只取年月日。
- **校区靠教室名里的「厚德」「崇德」判断**。依据是上游把校区叫「老校区(厚德楼)」「新校区(崇德楼)」，推测教室名以楼名开头，**未验证**。
  如果教室名不含楼名，`campusOfRooms` 返回 null，会问学生一次；问不了或取消就按上游默认的老校区导入，并在提醒里写明另一个校区第 3、4、7、8 节的时间不同。
  两个校区的节次时间只有这四节不同，选错的后果是这四节的上下课时间偏差 15 分钟左右；一个学生同时在两个校区上课的情形（极少）整张表只能用一个校区的时间。
- **学期选择**：页面上 `#xnxqdm` 下拉框的选中项是学期来源；用户在课表页切换学期后再点「提取课表」才是预期用法，第一条提醒里写了。
  当前页面如果不是课表页（没有下拉框），读到的是教务系统的默认学期，不一定是学生想要的那个。
- **总周数**：教务不给学期总周数，上游也没存；按 20 周给，课表更晚则抬高，两种情况都有提醒。学校实际周数不同需要学生在学期管理里改。
- **请求体只有 `xnxqdm`**：同平台其它学校的上游脚本还带 `zc=`、`d1`、`d2`。本件跟随本校上游（只带 `xnxqdm`）；如果真机返回的不是整学期，需要补这几个参数。
- **WebVPN / 非 `jwgl.shxy.edu.cn` 主机**：上游没有给出别的入口，本件要求当前主机就是 `jwgl.shxy.edu.cn`，经别的主机打开会提示「请在绥化学院教务系统（…）的页面里提取」。
- **`loginUrl` 是 http**（上游 `import_url` 原样）。如果学校只开放 https，请求 2 也会跟着页面协议走（相对路径），不会被混合内容拦截。
- **`teaxms` 的写法**：同平台 LIT 脚本会去掉教师名里的 `[…]` 备注，上游 SHXY 不去；本件跟随上游，原样保留（多位教师按教务给的一个字符串交出）。
- **每门课的实际上课时间**：同平台 LIT 脚本会用行里的 `qssj` / `jssj` 判断是否自定义时间；上游 SHXY 不读，本件也不读，一律用校区节次时间表。

## 9. 签名

0x7E7-2023（sonnet 移植，2026-10-20）
