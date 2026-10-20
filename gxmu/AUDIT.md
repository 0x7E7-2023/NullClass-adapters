# 安全审计 —— 广西医科大学（乘方智慧教务，jwxt.gxmu.edu.cn）

审计对象：`jw-adapters/gxmu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `GXMU/gxmu.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，2026-10-20 复核仍是最新；
MIT，作者 Haooz，`adapters.yaml` 的 maintainer；本校脚本最后一次修改 `80e30cf`，`git log -1 -- resources/GXMU/gxmu.js` 核对一致）。

审计方式：逐行读上游脚本（239 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js` / `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，`extract.js` 注释里一处
  `https://jwxt.gxmu.edu.cn/…`（说明上游把地址写死成绝对地址）。代码里没有任何绝对地址，请求路径全是以 `/` 开头的相对路径。
  `manifest.json` 里的 `loginUrl`、`scheduleUrlHint`、`homepage` 是给宿主看的声明，不是请求。
- 网络调用：`extract.js` 里只有两处 `fetch(`：`request()`（POST，课表与开学日期）和 `fetchTermSelect()`（GET，课表页）。
  `X-Requested-With: XMLHttpRequest` 是请求头字符串，不是 XHR 对象。`parse.js` 里没有任何网络调用、没有 `document.` / `window.` / 桥调用。
- 凭据、本地存储、动态执行、写页面：`localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` / `sendBeacon` /
  `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit` / `setAttribute` / `.click(` 全部无命中。
  `password` 只命中 `hasLoginForm()` 里的一处选择器 `input[type="password"]`：**只判断页面上有没有密码输入框**（用来认出登录页、不发请求），
  不读它的 `value`、不碰其它输入框。自检脚本对这个字样的提示即来源于此。
- ES5 token 扫描（注释也算，`check.js` 同口径）：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、展开符、可选链、`??`、`padStart`、
  `Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(`、`for…of` 全部无命中。
- 模板残留：`extract.js`、`parse.js`、`manifest.json`、`fixtures/` 检索「绥化」「shxy」「jwgl」「厚德」「崇德」「校区」，只有 `parse.js` 文件头与两处注释里有意写
  「照 shxy」「照 swu」（说明通用部分的来源）。
- 个人信息：`fixtures/` 全部为合成数据（教师甲 / 乙 / 丙…，教学楼 / 实验楼 / 体育馆等教室），没有真实姓名与学号。
  `extract.js` 里出现的「学号、姓名」只在注释里说明被丢弃的字段。

## 0. 上游情况与任务卡核对（分析写在这里）

- 上游 `GXMU/gxmu.js` 文件头与 `adapters.yaml` 一致，校名「广西医科大学」，无需修正。`import_url` 是 `https://cas.gxmu.edu.cn/lyuapServer/login`（统一认证），原样用作 `loginUrl`。
  `adapters.yaml` 的描述：「登录门户站点以后，进入教务系统，直接点击导入即可」——即用户在门户登录后进入教务系统（`jwxt.gxmu.edu.cn`），在教务页面里导入。
- 平台：上游唯一的取数请求是 `POST https://jwxt.gxmu.edu.cn/new/student/xsgrkb/getCalendarWeekDatas`（乘方「智慧教务」），请求体
  `xnxqdm=<学年起始年 4 位><01|02>&zc=&d1=<本周一 00:00:00>&d2=<本周日 00:00:00>`（d1 / d2 做 URL 编码；`zc` 传空 = 全学期）。
- 与同平台已审计的 `shxy`（批次十四，同一作者）比，不同构之处：
  1. **登录入口与教务主机不同**：`loginUrl` 是 `cas.gxmu.edu.cn`，课表接口在 `jwxt.gxmu.edu.cn`。`shxy` 的登录页与教务同主机所以 `allowHosts` 为空；
     这里教务主机写进 `allowHosts`，`extract.js` 仍用相对路径、并要求**当前页面主机就是 `jwxt.gxmu.edu.cn`**，停在门户上不发请求、提示先从门户进入教务系统。
  2. **请求体带 `zc=&d1=&d2=`**（`shxy` 只有 `xnxqdm`）。照上游逐字，含上游算「本周一」的写法（周日时 `getDay()` 为 0，d1 落在次日）；`zc` 为空时服务端返回全学期，d1 / d2 只是参考。
  3. **上游不读 `jxcdmc2`**（按教室 + 周次拆课）：教室取 `jxcdmc`，周次取 `zc`。删掉 `shxy` 的 `roomPiecesOf` / `addRoomWeek` / 教室周次不一致提醒；白名单字段从 8 个减到 7 个。
  4. **没有校区**：只有一张写死的 12 节表（`GXMU_TIME_SLOTS`，一节 40 分钟）。删掉校区判断、校区提问与校区提醒。
  5. **空课内置节次表只有 12 节，与本校表等长**：补节次只剩「顺推」一条路（课间 5 分钟、每节 40 分钟；`shxy` 是 45 分钟），删掉 `BUILTIN_PERIOD_TIMES`。
  6. 提问桥只剩「取到的学期一门课都没有 → 问用户要导入哪个学期」（沿用 `shxy`）。
- 选 `shxy` 作模板的理由：同平台、同作者、同样的取数形状（`kcmc` `teaxms` `jxcdmc` `zc` `xq` `ps` `pe`），`parse.js` 的通用部分（周次写法、两阶段合并、提醒限长、H3）已经过批次十四审计，
  本件只做删减；候选的 `hnsf` 多了 `qssj` / `jssj` 与三张节次表的提问，离本校更远。通用部分又逐条对照了「审计真抓到过的错」：相邻 `(单)/(双)` 归属、`第1-第8周`、
  「共 N 周」只剥备注（`/共\s*[0-9]+\s*周?/g`）、课名截 20 字 + 每条 ≤200 字、编辑课程指引（不写「学期管理」补教师 / 教室）、「节次时间」用词，均已在 fixtures 里钉住。
- 同平台还有 SHXY、SDIPCT、CMC、LIT、NENU、HNSF 的上游脚本。读过它们来确认平台的另外两个接口（见 §1 的请求 1、3），但只交本校，没有合并多校共用的实现。

## 1. 请求域与请求清单（与代码逐条对应）

只访问用户当前打开的教务主机，地址全是相对路径，代码里没有写死主机名；`window.location.hostname` 必须等于 `jwxt.gxmu.edu.cn`，
否则（停在统一认证门户或别的站点）直接抛提示、**不发请求**。`allowHosts` 写 `jwxt.gxmu.edu.cn`（登录入口 `cas.gxmu.edu.cn` 与教务主机不同源，宿主需要放行教务主机；不用通配）。

| # | 方法 | 路径 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `/new/student/xsgrkb/week.page` | 无 | 读学期下拉框 `#xnxqdm`（同平台 CMC / LIT / NENU 都这么读）。**上游没有** | 当前页面已有 `#xnxqdm` 时不发；404 / 网络错误 / 改版 → 交 null，退回按日期推算学期；页面里有密码输入框（登录页）→ 抛「登录已失效」 |
| 2 | POST | `/new/student/xsgrkb/getCalendarWeekDatas` | `xnxqdm=<学期代码>&zc=&d1=<本周一 00:00:00>&d2=<本周日 00:00:00>`（与上游一致，d1 / d2 URL 编码） | 取整学期课表（JSON：`{code:0, data:[…]}`） | HTTP 401/403 → 「教务系统拒绝访问（代码 N）」；其它非 2xx → 「教务系统返回错误（代码 N）」；网络错误 → 「连不上教务系统」；响应不是 JSON / 没有 `data` 数组 → 「没有返回课表数据」；`code` 不是 0 → 「没有返回课表数据（代码 N）」 |
| 3 | POST | `/new/xlxx/getDatesOfWeek` | `xnxqdm=<学期代码>&zc=1` | 取第 1 周的日期（开学日）。**上游没有**，同平台 CMC 脚本用它 | 任何失败（非 2xx / 不是 JSON / 超长）一律交 null，parse.js 推算开学日并写 warnings |

- 请求 2、3 在取到课表前并发发出（`gather`）；课表一门课都没有时，若宿主允许提问，用 `__ncSelect` 问一次要导入哪个学期，换学期后重发 2、3。
- 请求头统一为 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: application/json, …`，
  全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。上游只带 `Content-Type`，多出的两个头是同平台其它上游脚本都带的。
- 请求 2 的失败不吞：没有课表就没有可导入的内容，直接报给学生。请求 1、3 的失败一律吞掉交 null：附加请求挂掉不能导致整次导入失败。
- 登录页（页面里有密码输入框，或路径含 `login` / `lyuapServer`）与别的主机**不发任何请求**，直接抛大白话提示。登录判断只看路径、不看查询串
  （统一认证页的 `service=` 参数里会带着教务自己的地址，上游用整条地址判断会误判）。
- 学期代码来源，按顺序：① 当前页面 `#xnxqdm` 选中项（`option.selected` 优先，其次 `selected` 属性，最后第一项；只认 value 是 6 位数字的项）→ ② 请求 1 读到的默认项 →
  ③ 按当前日期推算（8 月 – 次年 1 月 = `<年>01`，2 – 7 月 = `<去年>02`，与上游的 `学年 + 01/02` 同形）。`term.source` 依次是 `page` / `default` / `auto` / `user`，parse.js 据此写第一条提醒。
- 提问（`__ncSelect`）最多一次：取不到课时选学期（候选是页面下拉框的项，没有下拉框时是推算出的最近 6 个学期）。宿主没有 `ask` 能力、用户取消、提问报错都不让提取失败：退回「没有取到课表数据」的报错。

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
| `rows[]` | 每行只留 `kcmc` `teaxms` `jxcdmc` `zc` `xq` `ps` `pe` | 课名、教师、教室、周次、星期、起止节次；其它字段（`jxcdmc2`、学号、姓名、证件号、手机号、任务代码…）一律不带 |
| `dates[]` | 请求 3 的每行只留 `xqmc`、`rq`（≤20 行），取不到 `null` | 第 1 周的日期 |

课表响应顶层夹带的 `xsxx` 之类对象、行里的 `xh` / `xm` / `sfzh` / `sjh` / `cdid` / `jxcdmc2`（桩里放了带标记的值）不在白名单里，冒烟测试确认没有出现在输出里。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。不读密码、不读 Cookie、不存任何东西；只判断页面上有没有密码输入框（`hasLoginForm`），不读它的值。上游的开场弹窗、学年 / 学期弹窗、`saveImportedCourses` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 全部未移植（见 §5）。 |
| 2 | 不外发 | **过**。只有 `extract.js` 里的两处 `fetch`，路径全是相对路径，请求只会打到用户当前打开的教务主机（且提前确认主机名）。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，没有第三方域。 |
| 3 | 请求域可控 | **过**。`allowHosts` 只有 `jwxt.gxmu.edu.cn`（教务主机，无通配）；代码里的主机名只有一处用来拦截「不在教务主机上」的常量 `HOST`。 |
| 4 | 只读课表 | **过**。三个请求落在 `/new/student/xsgrkb/*`（课表页、课表）和 `/new/xlxx/getDatesOfWeek`（校历日期），不碰成绩、学籍、缴费、考试。响应里夹带的个人信息不带出。 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOrNull`，失败返回 null）与 `DOMParser`（离线解析课表页，不插入当前页面）。 |
| 7 | 不写页面 | **过**。读页面只用 `getElementById` / `getElementsByTagName` / `querySelector`，不改 DOM、不提交表单、不点击。 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有教务主机名、三个页面路径、一张节次时间表。 |

## 4. 与模板（shxy）的差异

模板：`shxy`（同平台、同作者，批次十四）。下面是改动：

1. **主机与入口**（`extract.js`）：`HOST` 改成 `jwxt.gxmu.edu.cn`；登录判断改成「密码框或路径含 `login` / `lyuapServer`」先于主机判断，其余非教务主机一律提示「先登录门户、再从门户进入智慧教务系统」；`allowHosts` 写教务主机（§0 第 1 条）。
2. **请求体**（`courseBody`）：照上游加 `zc=&d1=&d2=`，d1 / d2 按上游算法（本周一、本周日，`00:00:00`）。
3. **按教室拆课整套删掉**：`roomPiecesOf` / `addRoomWeek` / `mismatchCourses` 以及 `jxcdmc2` 白名单字段。上游不读 `jxcdmc2`，教室取 `jxcdmc`、周次取 `zc`，一行一条课。
4. **校区整套删掉**：`campusOfRows`（extract）/ `campusOfRooms`（parse）、`askCampus`、`data.campus`、两张 10 节表、校区提醒。节次时间只有一张 12 节表 `PERIOD_TIMES`（逐节照抄 `GXMU_TIME_SLOTS`）。
5. **节次补齐**：删掉 `BUILTIN_PERIOD_TIMES`（空课默认表也是 12 节，补不到更晚的节次）；顺推改成每节 40 分钟（本校一节 40 分钟）；提醒文字相应改成「已按上一节下课后课间 5 分钟、每节 40 分钟顺推补上」。
6. **节次读法**（`sectionsOf`）：照上游，开始节次必须在，结束节次读不出数字时当作只上开始那一节——这在 `shxy` 里是「缺节次，整行跳过」。上游这样做，本件跟随，但多一条提醒
   （「有 N 门课没给结束节次（例如 …），已按只上开始的那一节导入」，`guessedCourses`），因为这是猜的；结束节次读得出却小于开始节次 / 开始节次不合法，上游不检查，本件跳过整行并计入「缺节次（或节次不合法）」（否则载荷校验会拒收整包）。
7. **学校名**：`SCHOOL_NAME` 为「广西医科大学」（只在学期代码读不出时兜底）。

**未改动的模板逻辑**（有 fixture 覆盖）：`weeksOf` 周次解析（含相邻单/双标记归属、「共 N 周」只剥备注、`第1-第8周`、括号序号 / 备注）、
两阶段合并（`dropExactDuplicates` → `mergeStageOne` → `mergeStageTwo`）、提醒统一限长（`shortName` 20 字 + `warn` 200 字）、
缺教师 / 缺教室的计数提醒、开学日取 `getDatesOfWeek` 并校验离学期锚点 ≤45 天（`plausibleStart`）、学期名取下拉框文字或学期代码拼。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart`（开场 `showAlert`） | 删 | 桥能力，宿主负责交互；提示文字改由 extract.js 的报错承担 |
| `getAcademicYear`（`showPrompt` 问起始学年）+ `selectSemester`（`showSingleSelection`） | 删，改为读页面 `#xnxqdm`、课表页默认项、按日期推算（§1） | 任务要求不弹窗问学年学期；要别的学期，用户在教务页面里切换后再提取；取不到课才用 `__ncSelect` 问一次 |
| `validateYearInput` | 删 | 只服务于学年弹窗 |
| `saveImportedCourses` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` | 删，载荷交给宿主 | 空课由宿主保存；节次时间进载荷 `periodTimes` |
| `fetchAndParseCourses` 里的绝对地址 `https://jwxt.gxmu.edu.cn/…` | 改成相对路径 + 主机校验 | 协议与主机跟随用户当前页面；停在门户上不发请求 |
| `isLoginPage`：`href.includes('login') \|\| includes('lyuapServer')`，命中就 toast「请先登录」 | 改：密码框或路径（不含查询串）含 `login` / `lyuapServer`，抛大白话错误 | 统一认证页的 `service` 参数里带教务地址，整条地址判断会把教务页误判成登录页（反之，cas 页被误放行也无害，因为主机不对会被拦） |
| `response.ok` 之外的任何失败只弹「网络请求失败」「请求或解析失败: …」 | 改为分情况报错（§1 请求 2） | 公共说明：不许让学生面对「没有课」却不知道为什么 |
| 解析不出课程弹「未找到任何课程数据，请检查所选学年学期是否正确」 | 改：有桥就问一次改选哪个学期；否则报「该学期没有取到课表数据」 | 同上 |
| `mapCourseRecord`：`weeks.length === 0`、`!day`、`!startSection` 整行静默 `return null` | 改为按原因计数写进提醒（缺课名 / 缺星期 / 缺节次 / 缺周次） | 公共说明第 6 条：不许静默丢课。上游对课名为空**不**丢（`name: record.kcmc \|\| ""`），本件缺课名的行跳过并计数（空课名的课没有意义） |
| `teacher: record.teaxms \|\| "未知教师"`、`position: record.jxcdmc \|\| "未知地点"` | 改为 `null` | 手册 §4.7：写「未知」会被课表当成真名显示；缺教师 / 缺教室按类型汇总进提醒，指向「编辑课程」 |
| `parseWeeks`（逗号列表，`Number()` 过滤小于 1 的项；没有上限） | 换成 `swu` 的 `weeksOf`；周次限 1-30，超出的丢弃并计数提醒 | 逗号列表是它的子集；多出的写法（`1-16周`、`(单)`、`第1-第8周`、`共 N 周`）本平台不一定出现，但接得住；31 周及以上超出载荷上限（totalWeeks ≤30），不丢会整包被拒 |
| 不合并同课，只按「课名\|星期\|起止节次\|周次\|教师\|地点」去重 | 去掉完全相同的行，再照 `shxy` 补两阶段合并（连续节次合并、同节次周次并集） | 乘方把同一门课拆成多行是常态；合并不丢课、不改任何一周的安排 |
| 12 节 `GXMU_TIME_SLOTS` | 原样保留（逐节照抄成 `PERIOD_TIMES`） | 上游唯一的节次时间来源，没有教务读取的版本 |
| `GXMU_TIME_SLOTS` 只有 12 节，课表用到更晚的节次时上游不处理 | 顺推补齐，补不了如实说明（统一修订 H3） | 载荷带了 `periodTimes` 时应用不会自己补；不补会让第 13 节及以后没有时间 |

## 6. 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/gxmu-port15/mut/` 下做了十三份副本（每份只改 `parse.js` 的一处；脚本 `D:/NullClass/.test/port-batch15/gxmu/mut.py`），各跑一次 `check.js`，结果如下。
真实的 `parse.js` 未被改动，之后再跑自检通过。

| 编号 | 改坏哪一处 | 变红的用例 |
|---|---|---|
| m1 | 第 3 节开始 `10:05` 改成 `10:15` | 全部 7 对：`periodTimes[2].start` |
| m2 | 第 6 节开始 `14:30` 改成 `14:00` | 全部 7 对：`periodTimes[5].start` |
| m3 | 顺推每节 40 分钟改成 45 分钟 | `late-periods`：第 13-15 节时间 |
| m4 | 没给结束节次时改成整行跳过（`shxy` 的写法） | `edge-weeks`、`long-warnings` |
| m5 | 「共 N 周」剥离改成 `/共.*$/`（从「共」删到行尾） | `week-markers`：`1-8周(共8周),9-16周` 后半段丢失 |
| m6 | 前缀「(单)1-8周」的预处理失效 | `week-markers`：单双归属错 |
| m7 | `plausibleStart` 恒返回 true（教务给的开学日不再校验是否属于本学期） | `second-term`：2025-09-01 被当成开学日 |
| m8 | 缺教室写「未知地点」（上游写法） | `long-warnings`：location 应为 null |
| m9 | 超出 1-30 周的周次不再计数提醒 | `edge-weeks`：缺「周次超出」提醒 |
| m10 | 阶段 1 不再合并连续节次 | `basic`：高等数学 1-2 + 3-4 应合并成 1-4 |
| m11 | 提醒里的课名不再截 20 字 | `long-warnings`：点名课名 |
| m12 | 顺推越过 23:59 也照补 | `late-periods`：第 16 节应补不了 |
| m13 | 缺教师写「未知教师」（上游写法） | `long-warnings`：teacher 应为 null |

十三处变异全部被对应用例抓住，还原后 `check.js` 通过。

## 7. fixtures、自检与冒烟

共 7 对合成用例（`manifest.json` 的 `fixtures` 与 `fixtures/` 一一对应）。期望值按规范与代码逻辑手工推演后写入（生成脚本 `D:/NullClass/.test/port-batch15/gxmu/genfix.py`
里每条 block 都是手写的字面量，提醒文字也是手写，不是把 parse.js 的输出存下来），首次自检 7 对全部 MATCH。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 12 节表（第 3 节 10:05-10:45、第 6 节 14:30-15:10）；连续节次 1-2 + 3-4 合并成 1-4；奇数周 / 偶数周 / 分段周次（1-8、10-16）；`zc` 逗号数字列表；开学日取教务日期；页面选中的学期 |
| `estimate` | 教务默认学期；开学日期取不到 → 9 月 1 日所在周的周一 2026-08-31 并说明；学期名由代码拼出；课表最晚 18 周，总周数仍 20 |
| `second-term` | 用户改选的第二学期（202502）；教务给的开学日 2025-09-01 不属于这个学期 → 忽略，按 2 月 20 日所在周的周一 2026-02-16 推算并说明 |
| `late-periods` | 按日期推算的学期；课表用到第 13-15 节（顺推 21:15-21:55 / 22:00-22:40 / 22:45-23:25）、第 16 节（越过 23:59 补不了）；课表最晚第 23 周 → 总周数抬到 23 并说明 |
| `week-markers` | `zc` 写成「(单)1-8周,(双)9-16周」「1-15周(单) 共16周」「1-8周(共8周),9-16周」「第1-第8周」「共16周,1-15周(单)」「1-8周(单) 9-16周(双)」「1～16周」 |
| `edge-weeks` | 0 和 31 超出 1-30 周丢弃并提醒；不连续周次 1,2,3,5,6 切成 1-3、5-6 两块；星期 7；教学班序号括号「(1)」、备注括号「(3组)」各一条提醒；没给结束节次 → 按只上第一节导入并提醒；同一时段两处教室各自一块 |
| `long-warnings` | 长课名 + 缺教师 / 缺教室 → 照常导入；提醒按类型汇总并点名课名截到 20 字；缺课名 / 缺星期 / 节次颠倒 / 开始节次为 0 / 认不出的周次（「第周」）/ 周次为空各一行被跳过并说明；没给结束节次的长课名点名；完全相同的行去重；每条提醒不超 200 字 |

`check.js`（与 CI 同口径）：`RESULT: PASS`（7 对 fixture 全部 MATCH）。

**浏览器冒烟**（`python -I -X utf8 D:/NullClass/.test/port-batch15/gxmu/smoke.py all`，Playwright 起假教务站，全部请求被拦截，不联网；跑真实 `extract.js`，输出再交给 Rhino 跑 `parse.js`）15 个场景全部 OK：

- `page`：当前页面有 `#xnxqdm` → 不发 `week.page`，直接 `POST …/getCalendarWeekDatas`（请求体恰为 `xnxqdm=202601&zc=&d1=<本周一> 00:00:00&d2=<本周日> 00:00:00`，d1 / d2 与 Python 里按上游算法算出的值逐字比对）
  + `POST …/getDatesOfWeek`（`xnxqdm=202601&zc=1`）；`page-switched`：用户在页面里把下拉框切到 `202502` → 请求体里 `xnxqdm=202502`。
- `home`：页面没有下拉框 → 先 `GET /new/student/xsgrkb/week.page`，读到默认项 `202601`（`source=default`）；`home-nopage`：课表页 404 → 按日期推算（`source=auto`）；`dates-404`：开学日期接口 404 → 课表照常导入，开学日推算并说明。
- `empty-ask` / `empty-cancel` / `empty-noask`：第一个学期一门课都没有 → 有桥时问一次（选项是页面下拉框的三项），选第二项后重发课表与日期请求，`source=user`；取消或没有桥 → 报「没有取到课表数据」。
- `login-form`（页面有密码输入框）、`login-path`（路径含 login）、`portal-login`（`cas.gxmu.edu.cn/lyuapServer/login?service=<教务地址>`）、`portal-home`（`cas.gxmu.edu.cn` 门户首页，别的主机）：**不发请求**，给大白话提示（门户首页提示先登录门户再进智慧教务系统）。
- `expired`（课表接口回登录页）→ 「…登录状态可能已失效…」；`http500` → 「教务系统返回错误（代码 500）」；`code1`（`code` 不为 0）→ 「没有返回课表数据（代码 1）」。
- 每个场景都检查：所有请求都落在教务主机；请求和输出里都没有桩里放的学号 / 证件号 / 手机号 / 姓名 / 教室内部编号 / `jxcdmc2`；输出顶层只有 `term` `today` `rows` `dates`；交出去的行字段都在白名单内；提醒每条 ≤200 字；节次时间是 12 节、第 3 节 10:05、第 6 节 14:30。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

- **没有在真机上验证**。没有广西医科大学账号，也没有登录后的真实页面。课表请求的路径、请求体、字段名（`kcmc` `teaxms` `jxcdmc` `zc` `xq` `ps` `pe`）和节次时间全部以上游脚本为准；
  桩只证明拼出来的地址与请求体符合上游写法、解析逻辑自洽。
- **登录入口与教务主机不同源**：用户在 `cas.gxmu.edu.cn` 登录后，需要从门户进入教务系统（`jwxt.gxmu.edu.cn`）才能提取；停在门户上点「提取课表」会提示先进入教务系统。
  `allowHosts` 里的 `jwxt.gxmu.edu.cn` 让宿主放行这个主机；上游没有说明是否还会经过别的单点登录跳转域，若有跳转，宿主在提取期间拦截别的域是否会影响登录流程未验证（提取只在用户已进入教务页面之后进行，所以预期不受影响）。
- **`scheduleUrlHint` 是推测的**：`https://jwxt.gxmu.edu.cn/new/student/xsgrkb/week.page`。主机来自上游的接口地址；`week.page` 这个路径来自同平台 CMC / LIT / NENU 上游，本校**未验证**。
  若路径不对，一键刷新会打开一个 404 页面，学生手动进入教务系统即可，不影响导入本身。（调度者可按批次十四 `shxy` 的做法删掉这个字段。）
- **请求 1（`week.page`）和请求 3（`getDatesOfWeek`）是上游没有的**，依据是同平台另外几所学校的上游脚本。
  本校的乘方是否开放这两个路径、返回的形状是否一致未验证；取不到时的行为是退回按日期推算学期 / 推算开学日并在提醒里说明，不会让导入失败。
  `getDatesOfWeek` 里「`xqmc` 为 `1` 的那一行是周一、`rq` 是日期」的理解来自 CMC 脚本的 `rows.find(item => item.xqmc === "1").rq`；如果本校的 `rq` 带时间或星期，`isoOfAny` 只取年月日。
- **只用 `jxcdmc` 作教室**：同平台 SHXY 上游会用 `jxcdmc2`（「教室-周次」）按周拆教室，GXMU 上游不读。如果本校的某些课在不同周次上课教室不同，
  `jxcdmc` 是否把几个教室拼在一起、还是只给一个，上游代码看不出；本件原样把 `jxcdmc` 当地点显示（拼在一起就显示拼在一起的文字）。已经与上游行为一致，但可能出现「全学期显示同一个教室」的情形，需真机确认。
- **`zc` 的写法**：上游只按「逗号分隔的数字列表」读（`"1,2,3,…"`）。本件在此之外多接几种写法，认不出的周次整行跳过并计数提醒，不会静默丢。
  `zc` 里单个非数字片段（如列表中夹着「abc」）会被忽略而不计数——这是 `weeksOf` 的既有行为（非数字片段不是周次），与上游一致。
- **学期选择**：页面上 `#xnxqdm` 下拉框的选中项是学期来源；用户在课表页切换学期后再点「提取课表」才是预期用法，第一条提醒里写了。当前页面如果不是课表页（没有下拉框），读到的是教务系统的默认学期，不一定是学生想要的那个。
- **总周数**：教务不给学期总周数，上游也没存；按 20 周给，课表更晚则抬高，两种情况都有提醒。学校实际周数不同需要学生在学期管理里改。
- **d1 / d2 的参考周**：照上游取「本周一 ~ 本周日」。周日时上游算出的 d1 是次日（下周一）；本件逐字照搬，不修。上游注释说 `zc` 为空时服务端返回全学期，d1 / d2 只是参考——若真机上 d1 / d2 实际会限制返回范围，课表会不全，
  这时提醒不到（课表看着正常只是少课），需要真机核对。
- **节次时间只有一张表**：上游没分校区 / 季节，本件同样；若学校冬夏季作息不同，本件看不出来，第 3 节 10:05 等时间以上游为准。顺推出的第 13 节及以后（一节 40 分钟、课间 5 分钟）是推测，已提醒核对。
- **WebVPN / 非 `jwxt.gxmu.edu.cn` 主机**：上游没有给出别的入口，本件要求当前主机就是 `jwxt.gxmu.edu.cn`，经别的主机打开会提示先登录门户并进入智慧教务系统。
- **`teaxms` 的写法**：多位教师按教务给的一个字符串原样交出（上游同）。

## 9. 签名

0x7E7-2023（sonnet 移植，2026-10-20）
