# 南京信息职业技术学院（njcit）移植审计

**签名：0x7E7-2023（sonnet 移植，2026-10-20）**

## 0. 出处

- 上游文件：`NJCIT/njcit.js`，上游仓库 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，MIT，作者（adapters.yaml 的 maintainer）**astraumbra**。
- 上游快照：`19a65bf07a3e998fcfc69cee692387cdc0523c1a`（2026-10-19 拉取，2026-10-20 复核仍是最新）；本校脚本最后一次修改 `73e176e`（`git log -1 -- resources/NJCIT/njcit.js` 核对一致）。
- 上游 `adapters.yaml` 登记：`adapter_id NJCIT`，`import_url https://jw.njcit.cn/sso/lyiotlogin`，`category BACHELOR_AND_ASSOCIATE`。
- 模板：parse.js 以批次十已审计的 `hualixy` 为底（同样「节次时间只来自教务、没有内置表」、支持 `qsxqj`），再按本校上游改字段；
  extract.js 以 `hualixy` 为底，去掉双菜单号与 WebVPN 片段，改回上游的单菜单号写法（`hueb` 的 `jwBase()` 思路）。
- 本件是**本校的首次移植**，没有旧版本可比。我们没有南京信息职业技术学院的教务账号，**没有在真机上跑过**，见第 8 节。

## 1. 请求域与请求清单（与代码逐条对应）

上游 `njcit.js` 的请求地址都是以 `/jwglxt/...` 开头的绝对路径（落在当前页面所在主机上），没有写死主机名。
本件同样只请求**当前页面所在的教务主机**：地址由 `window.location.origin` 拼成（`extract.js` 的 `originOf()`、`jwBase()`、`pageUrl()`），
没有写死的主机名或端口。统一认证入口 `https://jw.njcit.cn/sso/lyiotlogin` 与教务在同一主机 `jw.njcit.cn`，所以 `allowHosts` 为空数组，不写通配。

菜单号是上游写死的：首页 / 课表 / 节次时间用 `N2151`，学期周次校历用 `N2154`，没有备用菜单号。

| 谁 | 方法 | 地址（`<base>` = origin + `/jwglxt`；`/jwglxt` 之前若还有前缀则原样保留） | 干什么 | 取不到时 |
|---|---|---|---|---|
| `currentTerm()` | GET | `<base>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页的 `#xnm` / `#xqm` 下拉框，取学年学期。**页面上已有这两个下拉框时跳过**（上游 `fetchAcademicOptions` 同一个地址） | 非 2xx 报「教务系统返回错误（代码 N）」；读不到下拉框报「没读到学年学期…」。必需 |
| `fetchTimetable()` | POST | `<base>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`，体 `xnm=…&xqm=…&kzlx=ck` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、`qsxqj`、可能有的记录总数。**请求体与上游逐字一致**（上游 `fetchAndParseCourses`：只有 `xnm` / `xqm` / `kzlx=ck`，**不带** `xsdm=` 与 `kclbdm=`；`xnm` / `xqm` 改为读下拉框的值，经 `encodeURIComponent`） | 非 2xx 报「教务系统返回错误（代码 N）」；返回登录页（含「登录」与「密码」）报「登录状态已失效」；非课表 JSON 报「没有返回课表数据」。**必需，失败就不导入** |
| 主流程 | POST | `<base>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151`，体 `xnm=…&xqm=…&xqh_id=<校区号>` | 取节次时间（上游 `fetchTimesSlots`）。校区号：上游写死 `01`；本件取课表行里第一个非空 `xqh_id`，没有才用 `01` | 交 `null`，parse.js 整张改用空课默认 12 节表并写 warnings |
| 主流程 | POST | `<base>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`，体 `xnm=…&xqm=…` | 取学期周次校历，定开学日与总周数（上游 `fetchSemesterStartDate`） | 交 `null`，parse.js 推算开学日并写 warnings |

- 两条附加请求走 `optionalJson()`：任何失败（网络错误、非 2xx、非 JSON）都吞成 `null`，由 parse.js 回落并写进 warnings，**绝不因为附加请求挂掉就导不进课表**。
- 节次时间与校历响应只认**数组**（上游 `Array.isArray`）；`{ data: [...] }` 这类外壳按「取不到」处理。外壳只在 `pickRows()` 判断一次。
- 没有任何写请求，没有任何第三方域。

### 1.1 不发请求的情形

- 路径在 `/sso/` 下（统一认证入口 `/sso/lyiotlogin` 等）或含 `login_slogin.html`（正方直登页）：`notLoggedInPage()` 为真，同步抛出「请先登录教务系统，再点「提取课表」」，**不发任何请求**。
- 其余页面（教务首页、课表页、任意 `/jwglxt/` 下的页面，乃至站点根路径）照上游「无需打开课表页面」的口径直接取数；没登录时请求会拿到登录页，按第 1 节表里的「登录状态已失效」报错。
- 页面上已有学年学期下拉框：不发 GET 首页请求。

## 2. 读了什么、交出什么（逐字段）

**读（只读，不写页面）**

| 来源 | 字段 | 用途 |
|---|---|---|
| 当前页面或课表首页 HTML | `#xnm` / `#xqm` 的 `option`：`value`、`textContent`、`selected` | 学年学期（被 `selected` 标的优先，没有就第一项，跳过空 value 占位项） |
| 课表 JSON 顶层 | `kbList`（数组，必须有）、`sjkList`、`qsxqj`、记录总数（`total` / `totalResult` / `totalCount` / `count` 任一，可能没有） | 课表、集中实践课、每周起始日、对账 |
| `kbList` 每行 | 只读 `kcmc` `xm` `cdmc` `xqj` `jcs` `zcd` `xqh_id` | 课名、教师、教室、星期、节次、周次、校区号（只用来拼节次时间请求） |
| `sjkList` 每行 | 只读 `kcmc` | 集中实践课课名（只用于提醒） |
| 节次时间 JSON（数组） | 每行只读 `jcmc` `qssj` `jssj` | 节次号与起止时间 |
| 校历 JSON（数组） | 每行只读 `zs` `zsmc` `rq` | 第几周、这一周的日期区间 |

**交出（`extract.js` 返回的 JSON 字符串，只含以下键）**

| 键 | 内容 |
|---|---|
| `term` | `{ xnm, xqm, xnmText, xqmText }`：学年学期的值与显示文字 |
| `today` | 本机当天日期 `yyyy-MM-dd`（推算兜底用） |
| `qsxqj` | 课表响应顶层 `qsxqj` 原值（1=周一…7=周日），缺省为 `null`；parse.js 做合法性判断 |
| `raw.kbList` | 数组，每行只含 `kcmc` `xm` `cdmc` `xqj` `jcs` `zcd` `xqh_id` 七个字段（白名单，`pickFields()`） |
| `raw.sjkList` | 数组，每行只含 `kcmc` |
| `total` | 记录总数（没有则 `null`） |
| `periodTimes` | 节次时间行数组（每行只含 `jcmc` `qssj` `jssj`），取不到或为空则 `null` |
| `calendar` | 校历行数组（每行只含 `zs` `zsmc` `rq`），取不到则 `null` |

**不交出**：`xsxx`（学生信息：学号、姓名、学院等）和响应里的其它任何字段。`xqh_id` 是校区号，不含个人信息。
桩跑和冒烟里以 `2026000001`、`110101200001011234`、`13800000000`、`学生某`、`CD-SECRET-9` 等假数据注入响应与 HTML，输出里检不到（见第 7 节）。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有读取或发送账号、密码、令牌；没有读 `localStorage` / `sessionStorage` / Cookie。`credentials: 'include'` 只让 WebView 按同源规则带会话 Cookie，脚本既不读它也不外发。上游的 `showAlert` 开场提示、两个学年学期选择框（`showSingleSelection`）、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 都没有移植 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js`，地址由 `window.location.origin` 拼成。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单。只有 `DOMParser` 离线解析课表首页 HTML，不插入当前页面 |
| 3 | 请求域可控 | **过**。请求主机只有当前教务主机。`allowHosts: []`，不写通配。代码里没有写死的主机名或端口 |
| 4 | 只读课表 | **过**。请求的接口只有 `/jwglxt/kbcx/` 下四个：课表页、课表、节次时间（cxRjc）、学期周次校历（cxZcByXnxq）。没有成绩、学籍、个人信息、缴费接口。课表响应里夹带的学生信息一律不带出（见第 2 节） |
| 5 | 不埋点 | **过**。没有统计、上报、遥测、图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf()`） |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的 `option`，不写 DOM，不改表单，不触发提交或点击；也不改任何原型方法 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。脚本里的常量只有上下文路径 `/jwglxt`、两个菜单号（页面上可见的参数）、默认校区号 `01`（上游的值）与提示文字 |

## 4. 与模板（hualixy）的差异（逐条）

1. **菜单号单一**：hualixy 的 `GNMKDMS = [N2151, N253508]` 依次尝试；本件上游只有 `N2151`（首页 / 课表 / 节次时间）与 `N2154`（校历），删掉 `tryMenus()`，也不再交出 `gnmkdm`。
2. **课表请求体**：hualixy 带 `xsdm=&kclbdm=`；本件**不带**，与上游 `fetchAndParseCourses` 逐字一致（`xnm` / `xqm` / `kzlx=ck`）。公共说明说本批默认带 `kclbdm=`，但同时规定以本校上游代码为准，这里按代码。
3. **节次时间请求**：hualixy 的体是 `…&kzlx=ck&xsdm=&kclbdm=&kclxdm=`（不带 `xqh_id`）；本件体是 `xnm=…&xqm=…&xqh_id=<校区号>`（上游写死 `01`，本件取课表行里的 `xqh_id`，没有才用 `01`）。节次号只读 `jcmc`（上游 `Number(item.jcmc)`），时间只读 `qssj` / `jssj`，不再读 `jcdm` / `sksj`。
4. **校历字段**：hualixy 读 `zrq` / `zcrq` / `rq` / `ksrq`；本件只读 `rq`（上游：`rq.split('/')[0]`，必须是 `yyyy-MM-dd`）。`isoOfAny()` 比上游宽松（接受 `/`、`.` 分隔的日期、不足两位的月日），格式不对的行照样被跳过。
5. **响应外壳**：hualixy 认裸数组与 `{ data: [...] }`；本件只认数组（上游 `Array.isArray`），`pickRows()` 一处判断。
6. **登录 / 门户页判断**：hualixy 认「路径不在 `/jwglxt/` 下」；本件只认 `/sso/` 开头与 `login_slogin.html`，其余页面照上游的绝对路径写法直接取数（上游说教务任意页面都能导入，其中的站点根路径等页面在 hualixy 口径下会被误拦）。
7. **没有 WebVPN 查询串片段**：删掉 `vpnPart()`（本校上游没有）；`/jwglxt` 之前的路径前缀仍然原样保留（`jwBase()`）。
8. **页面原型被污染**：上游文件头说明本校教务页面的 zftal-ui 脚本会改坏 `Array.prototype.filter` / `some` / `every` 和 `String.prototype.trim`。hualixy 的 `extract.js` 里用了 `.trim()`；本件一律不用这四个方法（去首尾空白用 `stripEnds()` 的正则，遍历用下标循环）。parse.js 在 Rhino 里跑，不受影响。
9. **周次多接一种写法**：parse.js 的 `weeksOf()` 补了区间终点前带「第」（`第1-第8周`，批次十 `swu` 的修正，一行）。上游本身不认这种写法（会整段丢掉），这属于「比上游宽」，在 `week-markers` 用例钉住。
10. **校历取值**：parse.js 的 `calendarInfo()` 只读 `rq`（见第 4 条）；其余（第 1 周不属于本学期则忽略、没有第 1 周不顶替、总周数取最大周次）沿用模板。
11. **学校名与兜底学期名**：`SCHOOL_NAME` 改为「南京信息职业技术学院」。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart` 开场弹窗（`showAlert`） | 删 | 空课不用桥弹窗；提示文字不移植 |
| `fetchAcademicOptions` + `selectAcademicYearAndSemester`：两个选择框（`showSingleSelection`，年份只给当前年前后各两三项） | 改为读页面下拉框 | 公共说明第 2 条：不弹窗问学年学期；要别的学期，用户在教务页切换后再点「提取课表」 |
| `saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` | 删 | 空课由宿主保存，适配器只交载荷 |
| `showToast` / `notifyTaskCompletion` | 删 | 同上 |
| `parseWeeks` 只认 `/(\d+)-(\d+)周/` 与 `/^(\d+)周/` | 换成模板的 `weeksOf()` | 上游认不出 `1-16(单周)` 写法，整段周次会塌成空数组、这门课被静默丢掉；上游也不处理「共 N 周」备注与括号里的教学班序号 |
| `parseCourseJsonData`：`jcs.split('-')` 取首尾 | 换成模板的 `sectionsOf()` | 上游认不出 `第9-10节`、`0102`、`1,2` 等写法 |
| 缺教室写成 `未排地点`，缺教师写成空串 | 缺的一律 `null`，按类型汇总进 warnings | 载荷规范：拿不到就是 null，不许写占位词；公共说明第 4 条 |
| 缺 `kcmc` / `xqj` / `jcs` / `zcd` 的行静默 `continue` | 同样跳过，但按原因分类计数写进 warnings | 不许静默丢课 |
| `mergeAndDistinctCourses`（两阶段合并，用 `localeCompare` 排序、`Set` 去重） | 模板的 `dropExactDuplicates` → `mergeStageOne` → `mergeStageTwo` | 语义一致（连续节次合并 + 同节次周次并集）；多一步先去完全相同的行（上游只跟当前合并中的那条比，合并之后才出现的重复行会漏网）；排序改成不依赖本地化的字符串比较 |
| `fetchSemesterStartDate`：`json.find(zs==1 或 zsmc==1) \|\| json[0]`，总周数 = 校历行数 | 找不到第 1 周不顶替（推算 + 提醒）；总周数取最大周次；校历日期不属于本学期则忽略 | 宁可推算也不写错日期 |
| `fetchTimesSlots`：缺字段的行 `continue`、只排序不校验 | 任一行缺字段、不是从第 1 节起连续、时间不递增或重叠，整张弃用，改用空课默认 12 节并写提醒 | 载荷要求节次时间合法且递增；半张表会让后面的课对错时间 |
| 上游没有内置节次表，读不到就不存作息 | 空课默认 12 节整张 + 提醒；课表用到更晚节次按「统一修订 H3」逐节补齐并说明 | 任务卡与公共说明 |
| 上游 `firstDayOfWeek` 不读 `qsxqj` | 交 `qsxqj`，开学日回退到「星期几 = qsxqj」那一天，缺省按周一 | 移植手册 §4.3；上游原样用 `rq` 首段、不回退 |
| 页面请求头只有部分带 `x-requested-with` | 每个请求统一带 `Content-Type`、`X-Requested-With`、`Accept` | 统一口径 |

## 6. 变异测试记录

在临时副本（`C:/Users/23703/AppData/Local/Temp/njcit-port11/mut/`）上改 parse.js，每次只改一处，跑 `check.js`，然后丢弃副本；真实文件未动。

| 改坏哪一处 | 哪条用例变红 |
|---|---|
| `weeksOf()` 删掉「区间终点前的第」处理 | `week-markers`（`第1-第8周` 读成第 1、8 周） |
| `periodTimesOf()` 删掉「从第 1 节起连续」判断 | `period-gap` |
| `periodTimesOf()` 删掉「递增不重叠」判断 | `period-overlap` |
| `calendarInfo()` 不再读 `rq`（改读 `zcrq`） | `period-api`、`calendar-sunday`、`calendar-other-term`、`calendar-no-week1`、`week-markers` |
| `firstDowOf()` 忽略 `qsxqj`（恒 1） | `calendar-sunday` |
| `plausibleStart()` 恒真（不识别别的学期的校历） | `calendar-other-term` |
| `calendarInfo()` 找不到第 1 周时拿第一行顶替 | `calendar-no-week1` |
| 「共 N 周」备注剥离改成上游式 `/共.*$/`（删到行尾） | `calendar-sunday`、`week-markers` |
| `mergeStageOne()` 不合并连续节次 | `period-api` |
| H3 顺推的课间改成 0 分钟 | `basic` |

extract.js 的变异在冒烟里做（改坏 `C:/Users/23703/AppData/Local/Temp/njcit-port11/xmut/` 下的副本，用 `NJCIT_SMOKE_ROOT` 指过去）：

| 改坏哪一处 | 哪个冒烟场景变红 |
|---|---|
| 课表请求体多带 `&xsdm=&kclbdm=` | `njcit`（请求体逐字核对） |
| 去掉 `/sso/` 路径的拦截 | `njcit-sso`（应当不发请求） |
| 默认校区号 `01` 改 `00` | `njcit-nocampus`（节次时间请求体） |
| `stripEnds()` 改回 `.trim()` | `njcit-proto`（页面把 `trim` 改成删光空白后，下拉框文字「第一  学期」被压成「第一学期」） |

以上全部变红，还原后真实文件跑自检与冒烟均通过（见第 7 节）。

## 7. fixtures 与自检

**fixtures（10 对，期望值先手工推演再比对；其中 `basic` / `long-warnings` / `no-calendar-overweek` / `period-overlap` / `calendar-sunday` 的数据形状沿用 hualixy 已审计的用例（逻辑未改动，只改了字段形状与课程名），`period-gap` / `calendar-other-term` / `calendar-no-week1` / `week-markers` 是本件新写并逐条手算）**：

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 节次时间没取到 → 空课默认 12 节 + 提醒；校历没取到 → 推算 2026-08-31、总周数 20；课表排到第 15 节 → 第 13、14 节顺推、第 15 节越过 23:59 不补并说明；单双周、无教师、无教室、完全重复行、集中实践课 |
| `period-api` | 教务节次时间带秒、节次号在 `jcmc` → 用教务的 4 节；校历 `rq` 为「起/止」区间串 → 取前一段；课表用到第 5、6 节 → 默认表同号节次接得上；1-2 与 3-4 节合并 |
| `period-overlap` | 教务节次时间两节重叠 → 整张弃用，改用空课默认 12 节 + 提醒 |
| `period-gap` | 教务节次时间缺第 3 节 → 整张弃用，改用空课默认 12 节 + 提醒 |
| `calendar-sunday` | `qsxqj = 7`，校历第 1 周为周三 2026-09-09 → 回退到周日 2026-09-06；单双周三种写法 |
| `calendar-other-term` | 校历第 1 周是上一学年的 → 忽略，推算 2026-08-31、总周数 20，各说明一条 |
| `calendar-no-week1` | 校历没有第 1 周 → 不顶替，推算；总周数取校历最大周次 19 |
| `no-calendar-overweek` | 校历与 `qsxqj` 都没有；课表最大周次 21 → 总周数抬到 21；`(1)` 教学班序号与 `(3组)` 备注各提醒一条 |
| `week-markers` | 前缀 / 后缀单双标记各归各的段；`1-15周(单) 共16周`；`第1-第8周`；`1-8周(共8周),9-16周`；`共16周,1-15周(单)`；`1-16(单周)`；教务节次时间 8 节与校历齐全，不出现补时间与推算提醒 |
| `long-warnings` | 长课名 + 缺教师 / 缺教室 → 不丢课，提醒课名截到 20 字；四门超长集中实践课 → 只点前三门、按类型汇总、整条不超 200 字 |

**自检**：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/njcit` → 10 对全部 MATCH，`RESULT: PASS`。

**浏览器冒烟**（`D:/NullClass/.test/port-batch11/njcit/smoke.py`，Playwright 起假教务站，全部请求被 route 拦下，不联网，真实 extract.js 跑在 Chromium 里，输出再交给 Rhino 跑真实 parse.js）：12 个场景全部 OK。

| 场景 | 结果 |
|---|---|
| `njcit`：课表页（有下拉框） | 只三条 POST：课表 `…xskbcx_cxXsgrkb.html?gnmkdm=N2151` 体 `xnm=2026&xqm=3&kzlx=ck`；节次时间 `…xskbcx_cxRjc.html?gnmkdm=N2151` 体 `xnm=2026&xqm=3&xqh_id=02`（取自课表行）；校历 `…xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` 体 `xnm=2026&xqm=3`。学期取 `selected` 项，`qsxqj=7` 使开学日回退到 2026-09-06 |
| `njcit-menu`：教务首页（无下拉框） | 先 GET `…xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`，再发同样三条 POST |
| `njcit-root`：站点根路径下的页面（既不在 `/jwglxt/` 下也不在 `/sso/` 下） | 照上游绝对路径 `/jwglxt/…` 取数 |
| `njcit-prefix`：地址带前缀 `/prx/jwglxt/…` | 四个请求都落在 `/prx/jwglxt/…`，前缀原样保留 |
| `njcit-proto`：先把 `filter` / `some` / `every` / `trim` 改成污染后的行为再跑 | 请求与输出与正常场景一致；下拉框文字里的内部空白保留 |
| `njcit-nocampus`：课表行没有 `xqh_id` | 节次时间体 `xqh_id=01` |
| `njcit-optional500`：节次时间与校历都返回 500 | 课表照常交出，两者为 `null`；parse.js 用默认 12 节并推算开学日、说明 |
| `njcit-envelope`：节次时间返回 `{ data: [...] }` | 按「取不到」处理，`periodTimes` 为 `null`，用默认 12 节并提醒 |
| `njcit-expired`：课表接口回登录页 | 报「登录状态已失效…」，不发附加请求 |
| `njcit-kb500`：课表接口 500 | 报「教务系统返回错误（代码 500）…」 |
| `njcit-sso`：`https://jw.njcit.cn/sso/lyiotlogin` | 无请求，同步抛「请先登录教务系统，再点「提取课表」」 |
| `njcit-slogin`：`/jwglxt/xtgl/login_slogin.html` | 无请求，同上 |

所有场景的输出中检不到假学号 / 身份证 / 手机号 / 假姓名 / 假教室号；`raw.kbList` 每行只含白名单七个字段，`periodTimes` 只含 `jcmc` `qssj` `jssj`，`calendar` 只含 `zs` `zsmc` `rq`；任何一条 `warning` 都不超过 200 字。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **真机未验证**：没有南京信息职业技术学院的账号，所有请求路径、请求体、字段名都照上游代码写，没有在真实教务页面上跑过。上游代码本身是否仍被本校教务接受，未知。
2. **课表请求体不带 `xsdm` / `kclbdm`**：与上游一致；若本校教务实际需要这两项，上游会同样失败，此时会报「教务系统没有返回课表数据」。
3. **节次时间校区号**：上游写死 `xqh_id=01`；本件改取课表行里的校区号（没有才用 `01`）。多校区的学校里，课表第一个非空 `xqh_id` 不一定是学生主要上课的校区；节次时间不对时学生会在「学期管理」里看到的是教务给的那一张（不会有提醒）。若这条与上游行为差异不可接受，把 `campusOf()` 改成恒返回 `01` 即可。
4. **节次时间字段形状未知**：只认 `jcmc`（数字串）+ `qssj` / `jssj`，响应必须是数组。若真实响应的节次号放在 `jcdm`、或外面包了 `{ data: [...] }`，会按「取不到」处理并改用空课默认节次时间（学生会看到提醒）。这是照上游代码，没有见过真实响应。
5. **空课默认节次表不是本校的作息**：上游没有内置表，教务读不到时用空课默认 12 节，与学校实际作息可能不同。提醒文字已写明「请在学期管理里核对」。
6. **`qsxqj` 是否存在未知**：上游不读它；缺省时本件按周一。
7. **总周数口径与上游不同**：上游总周数 = 校历行数，本件取校历最大周次（模板口径）。校历行号连续时两者相同。
8. **统一认证流程未验证**：`loginUrl` 照上游 `import_url`（`/sso/lyiotlogin`）；登录后会落在哪个页面、教务是否仍在同一个主机 `jw.njcit.cn` 上，未验证。若登录后实际跳到别的主机，`allowHosts` 需要补上；`extract.js` 只请求当前页面所在主机，不会发到别处。
9. **页面原型污染只按上游描述处理**：我们没有真页面可看，不知道 zftal-ui 是否还改了别的内置方法；`extract.js` 只用 `indexOf` / `replace` / `push` / `JSON.stringify` / `Promise` 等常规方法，并在冒烟里模拟了上游描述的四种污染。
10. **登录页判断靠文字**：「登录」与「密码」同时出现即视为登录页（沿用 hualixy 的判断，上游本身没有这一条）；若课表本身含这两个词（极少见）会被误判为登录失效。

## 9. 需要主调度确认的点

1. **课表请求体不带 `kclbdm=`**（第 4 节第 2 条）：按上游代码，与公共说明的默认不同。
2. **节次时间的校区号取课表行的 `xqh_id`**（第 8 节第 3 条），上游写死 `01`。
3. **`weeksOf()` 补接「第1-第8周」**（第 4 节第 9 条）：比上游宽，一行修正，已用例钉住。

## 10. 签名

0x7E7-2023（sonnet 移植，2026-10-20）

## 审计修正（2026-10-20）

- **周次前缀标记误吞上一段的后缀**：`parse.js` 的 `weeksOf` 里，前缀写法的正则 `(单)1` 没排除标记前面紧挨着上一段（数字或「周」）的情况，
  把上一段的后缀 (单)/(双) 当成下一段的前缀：`1-8周(单) 9-16周(双)` 被读成 1-16 每周；`1-8周(单)9-16周` 被读成 1-15 单周，9-16 周的双周丢了；
  `1-16周(单) 17-18周` 被读成 1-17 单周，第 18 周丢了。
- 修正：标记前面紧挨着数字或「周」（中间可有空白）时按后缀归给前一段，只有在段首（字符串开头或分隔符之后）才当后一段的前缀；
  后缀后面直接跟着下一段数字时补一个逗号隔开。`(单)1-8周,(双)9-16周`、`1-8周(单),9-16周(双)`、`1-15周(单) 共16周` 等原有写法行为不变。
- 新增 fixture `week-adjacent`（三个反例；期望值按周次集合手推：1-7 单 + 10-16 双；1-7 单 + 9-16 每周，合并为 1-9 单 + 10-16 每周；1-15 单 + 17-18 每周，合并为 1-17 单 + 18 每周）。
- 已知取舍：`(单)1-8周 (双)9-16周`（前缀写法、段间只有空格）里的 `(双)` 前面紧挨「周」，按上述规则会被当作前一段的后缀；与后缀写法 `1-8周(单) 9-16周(双)` 在形态上无法区分，未见真实样本，按上述规则取后缀。

## 修订 1.0.1（2026-10-27）：无逗号的前置单双标记

- 问题：`(单)1-8周(双)9-16周`（前置标记、两段之间没有逗号）里的第二个标记前面紧挨「周」，被当成上一段的后缀，两段并成「单双都有」，整门课读成 1-16 周每周都上（批次十八 `jxfu`、批次十九 `smu` 审计发现，探测后确认本件同样如此）。
- 修正：`weeksOf` 里夹在两段中间的标记，若它所在的这一段以前置标记开头，就判给下一段；否则仍按后缀归上一段，`1-8周(单)9-16周(双)` 等后置写法不受影响。段间只有空格的 `(单)1-8周 (双)9-16周` 也一并读对。
- 回归：差分测试（`.test/fix-prefix/diff.js`）对 32 种其它周次写法比对修订前后输出，修订前读对的全部一字不差；7 种无逗号前置写法读出的周次与手推一致，整份输出与修订前代码对等价后置写法的输出一致。
- 新增 fixture `weeks-prefix-glued`：期望取修订前代码对等价后置写法 `1-8周(单),9-16周(双)` 的输出（该写法修订前已正确）。
- 版本 1.0.0 → 1.0.1。
