# 北部湾大学（bbgu）适配器 · 安全审计与移植说明

## 出处

- 上游：`shiguang_warehouse` 的 `BBGU/bbgu.js`（286 行），作者（adapters.yaml 的 maintainer）Haooz，MIT。
- 上游快照：`29498b026708ecb8d837c8fdc1e53b768a394e4e`（提交 `29498b0`，2026-11-03 与 origin/main 对齐）。
- 本校脚本最后一次修改：`80e30cf`（批量合并，`git log -1 -- resources/BBGU/bbgu.js` 核对过）。
- adapters.yaml 条目：`BBGU_01`，`import_url` = `https://zhjw.bbgu.edu.cn/workspace/home`，分类 BACHELOR_AND_ASSOCIATE。
- 上游快照只读，没有修改，也没有在那个目录里运行任何程序。

## 平台与模板

- 本校是新一代金智「智慧教务」（`/api/resourceapi/…` 与 `/api/timetable/…` 两组接口），库里没有同平台的已审计件。
- 取数与字段映射按上游 `bbgu.js` 重写；**纯转换骨架借自 `hueb`**（周次解析含 (单)/(双)、「第」、括号备注；节次解析；两阶段同课合并；H3 节次补齐；提醒限长与 200 字收口）。
  `hueb` 是正方平台，只借这些与平台无关的纯转换部分，它的取数、节次表、学期名规则一律不沿用。
- 冒烟脚本从 `.test/port-batch7/smoke/smoke.py` 的结构改写（Playwright 起假教务站，全部请求被 route 拦下，不联网）。

## 上游分析（按批次十的任务卡颗粒度）

### 与模板的不同构之处
1. 学期：上游弹「请选择学期」（`showSingleSelection`），选项取 `session/list`；这里改为不弹窗，取教务标为当前的学期（`active = Y`），没有标的按今天落在起止日期之间选，还选不出取列表第一个。三种情况都写进提醒（`pick` 字段）。
2. 周次：上游 `parseWeeks` 只认 `1-4,6-9` 这种写法，**认不出的整门课被静默丢掉**（`parseCourse` 返回 null）。这里改用 `hueb` 的周次解析，并把认不出的周次原文计数写进提醒。
3. 节次：上游没有写死的节次表。节次时间只从 `get-large-period` 取（它返回按组的 `periodList`，各组拼在一起用）；取不到时用空课自己的 12 节默认表（与 `hueb` 同一张）并提醒。
4. 学期起止日期 → 开学日与总周数：上游开学日直接用 `beginDate`，总周数调 `maxWeek` 接口。这里开学日回退到那一周的周一（手册 §4.3），总周数按 `endDate - beginDate` 算，取不到用 20，课表更晚的周则抬高并提醒。`maxWeek` 接口不再请求（见「删掉或改掉的东西」）。
5. 教师 / 教室：上游缺教师写「未知」、缺教室写「待定」（`cleanTeacher` / `position`），交出去会被当成真名与真地点显示。这里一律 `null`，缺了照常导入，按类型汇总写进提醒（「编辑课程」里补）。
6. 教师备注：`[主讲]` 去掉，`（外聘）`这类圆括号备注也去掉，分号换成顿号，不拆第二位教师。
7. 去重：上游在 `fetchCourses` 里按组合键去重；这里先按内容去重原始行（逐周 / 逐页重复不被计数两次），解析后再做同课合并。

### 请求清单（与 `extract.js` 代码一致）

全部是本校教务站的**同源**请求（地址由 `window.location.origin` 拼出，并先过 `hostname === zhjw.bbgu.edu.cn` 守卫）。都带 `credentials: include`、`X-Requested-With: XMLHttpRequest`、`Accept: application/json`。读到登录令牌时另带 `Authorization: Bearer <令牌>`（只发往本校教务站）；读不到就不带这个头，照常请求。

| # | 方法 | 路径 | 用途 | 取不到时怎么办 |
|---|---|---|---|---|
| 1 | GET | `/api/resourceapi/session/list` | 取学期列表，选一个学期 | 非 2xx 或网络错 → 报错「教务系统返回错误（代码 N）…请重新登录后再点「提取课表」」或「连不上教务系统…」；返回里没有可用学期 → 报错「没有读到学期列表…」 |
| 2 | POST | `/api/timetable/class/timetable/student/my-table-detail?sessionId=<所选学期 id>` | 取该学期课表（无请求体） | 非 2xx / 网络错 → 报错；返回不是 JSON 或没有 `classTimetableVOList`（也没有 `data.classTimetableVOList`）→ 报错「没有返回课表数据…登录状态可能已失效」 |
| 3 | GET | `/api/resourceapi/timePattern/get-large-period?sessionId=<同上>` | 取节次时间（附加信息） | **任何失败都交 null，不报错**；parse.js 用默认 12 节表并在提醒里说明 |

- `sessionId` 只在请求 URL 里出现，不写进载荷。
- 没有任何 `POST` 带请求体；`my-table-detail` 按上游是 POST 且无体。

### 读了什么 · 交出去什么（逐字段）

extract.js 交出的 JSON（`parse.js` 只读这些字段）：

| 路径 | 来源字段 | 说明 |
|---|---|---|
| `term.year` | `session.year` | 学年文本，如 `2026-2027` |
| `term.term` | `session.term` | 学期字，`春` / `秋` / 其它 |
| `term.beginDate` / `term.endDate` | `session.beginDate` / `endDate` | 只取前 10 位 `年-月-日` |
| `pick` | — | `active` / `date` / `first`，表示选学期的方式 |
| `today` | 本机时钟 | `yyyy-mm-dd` |
| （读但不交出）登录令牌 | localStorage / sessionStorage 的固定 key 与整库扫描 | 只用于组装 `Authorization` 请求头；不进输出、不进报错、不进提醒，不写回存储 |
| `periodLists[][]` | `get-large-period` 的 `data[].periodList[]` 的 `smallPeriod`、`startTime`、`endTime` | 取不到为 `null` |
| `raw.rows[]` | `classTimetableVOList[]` 的 `courseName`、`instructorName`、`roomName`、`campusName`、`weekDay`、`periodFormat`、`teachingWeekFormat` | 只这七个字段，其它字段（学号 `xh`、姓名 `xm`、身份证 `sfzjh`、手机 `sjh` 等）一律不带出 |

- 冒烟与桩测试都检查过：响应里夹带的学号、姓名、身份证号、手机号在交出去的 JSON 里都找不到。

### 节次时间（逐节对照上游）

上游 `bbgu.js` **没有写死的节次表**，所以没有可逐节照抄的源。节次时间的来源是：
1. 教务 `get-large-period`（优先）：各组拼在一起，同号同时间去重；编号从 1 连续、时间递增不重叠才采用，否则当没取到。
2. 取不到：空课默认 12 节表（`DEFAULT_PERIOD_TIMES`，与 `hueb` 的 `BUILTIN_PERIOD_TIMES` 逐节相同），提醒写明「没有给出节次时间，已按默认的 12 节时间导入」。
3. 课表用到更晚的节次：默认表有这一节且开始不早于上一节下课则用它，否则从上一节下课后顺推（课间 5 分钟、每节 45 分钟），越过 23:59 就停并提醒（统一修订 H3）。

### 本校专属边界用例（fixtures）

| 用例 | 覆盖 |
|---|---|
| `basic` | 教务标为当前学期；节次时间取自教务（带秒）；起止日期算出 19 周；`甲老师[主讲];` 去标注；`未知`、`待定` 给 null；完全重复行只留一条；单周 |
| `week-markers` | `(单)1-8周,(双)9-16周`、`(单)1-8周(双)9-16周`（无逗号前置）、`1-8周(单),9-16周(双)`（后置）都读成 1-7 单 + 10-16 双；`1-15周(单) 共16周` 只读 1-15 单；`1-8周(共8周),9-16周` 只剥备注；`第1-第8周` 读成 1-8；未标当前学期取第一个；无起止日期按春季锚点推 2026-02-16、总周数 20 |
| `long-warnings` | 长课名（>20 字）截到 20 字加「…」；缺教师 / 缺教室按类型汇总；脏行（缺课名、星期 9、缺节次、认不出的周次）按原因计数；括号备注过长截短；每条 ≤200 字 |
| `dates-raise` | 开学日 2026-03-04（周三）回退到周一 2026-03-02；起止日期 2026-03-04 至 06-24 恰好 16 整周 → 17 周（末日所在周也要算）；课表排到第 19 周 → 抬高到 19 并提醒；节次组重复去重；第 11-12 节用默认表、第 13 节顺推并提醒 |
| `merge-consecutive` | 同课同教室 1-2 与 3-4 节（同周次）合成 1-4；同节次不同周次并集 1-16；完全相同的 3-4 行只留一条；周三另一段 |
| `estimate-autumn` | 秋季无起止日期、教务标为当前 → 开学日按秋季 9 月初锚点推到 2026-08-31 并提醒；总周数 20；缺教室照常导入（location 为 null） |

期望值是按规则手工推演后写的，没有把 parse.js 的输出直接存成 expected。自检对 6 对全部 MATCH，且 `check.js` 的 INVALID 检查没有报错。

## 移植手册 §5 安全审计八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **合格。** 不读账号、密码、登录表单。令牌照上游 `getAuthToken` 读取：先查固定的 key（`Authorization`、`access_token`、`token`、`X-Access-Token`、`x-token`、`auth_token`、`jwt`、`user_token`，localStorage 与 sessionStorage），再整库扫描兜底；只认形似 JWT 的值（三段用点隔开的 base64url，允许 `Bearer ` 前缀），不像的一律不要。读到的令牌只放进发往同源 `zhjw.bbgu.edu.cn` 的 `Authorization` 头（没带 `Bearer ` 就补上）。令牌不进 `extract.js` 的输出、不进报错文字、不进提醒，也不写回任何存储（`extract.js` 没有任何 `setItem`）。手册 §5 第 1 条原文「读令牌用于本校接口是正常的，外发不行」，移植版即按此执行；公共说明「不碰凭据」指账号密码，本批主调度已确认照上游保留。 |
| 2 | 不外发 | 合格。请求只有本校教务同源地址；`extract.js` 里只有 `zhjw.bbgu.edu.cn` 一个主机名，且只在守卫里出现，不发给任何其它域。 |
| 3 | 请求域可控 | 合格。三个请求都是同源相对路径（`originOf()` + 路径），`allowHosts: []`。`check.js` 的主机校验通过。 |
| 4 | 只读课表 | 合格。只请求学期列表、课表、节次时间三个接口。上游的 `maxWeek` 接口（`/api/timetable/course/maxWeek/…`）已删，它不是课表内容，删掉后也不需要。 |
| 5 | 不埋点 | 合格。没有统计、上报、遥测。上游的 `showToast` / `notifyTaskCompletion` 等提示桥也全部不移植。 |
| 6 | 不 eval 远程代码 | 合格。没有 `eval`、`new Function`，只对教务返回做 `JSON.parse`（失败返回 null，由调用方报错）。 |
| 7 | 不写页面 | 合格。不写 DOM，不提交表单，不点击。上游的 `saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` 调用全部删掉，适配器只交载荷。 |
| 8 | 不依赖秘密 | 合格。没有硬编码的学号、令牌、密钥。fixtures 全部是虚构数据（甲 / 乙 / 丙 / 丁 老师，A101 等教室号）。冒烟里的假学号只在假站里出现，并被断言不出现在交出去的数据里。 |

## 与模板（hueb）的差异

1. 取数：`hueb` 是正方 `kbList` / `sjkList` + 作息接口 + 校历接口，本校是金智三个接口（学期、节次、课表）。
2. 学期选择：`hueb` 读课表页下拉框（`#xnm` / `#xqm`），本校读 `session/list` 的 `active`，并用日期兜底。
3. 学期名：`hueb` 用正方的学年与学期代号，本校用 `year` + `term`（春→第二学期，夏→第三学期，其它→第一学期）。
4. 开学日与总周数：`hueb` 用校历接口（周次→日期），本校用学期起止日期，不再有 `zs` / `zcrq` 行。
5. 默认节次表：`hueb` 的学校 13 节表（`SCHOOL_PERIOD_TIMES`）不适用于北部湾，这里整张去掉，只保留空课的 12 节默认表。
6. 集中实践课：`hueb` 单独列出 `sjkList`，本校上游没有这一项，去掉。
7. 对账：`hueb` 用 `total` 对账取数是否取全，本校接口没有总数字段，去掉。
8. 作息 / 校历的 `rowsIn` 外壳识别：`hueb` 为正方的多种信封写的，本校的外壳只在 `extract.js` 的 `timetableRowsOf` 认一次，`parse.js` 不再认外壳。

## 上游里删掉或改掉的东西及理由

| 上游 | 处理 | 理由 |
|---|---|---|
| `getAuthToken`（扫 localStorage / sessionStorage 找 JWT，放进 `Authorization`） | **保留，加 JWT 形状校验** | 主调度决定照上游补回：只放进同源请求头，不进输出、报错、提醒，不写回存储；不像 JWT 的值一律不用。见上表第 1 条。 |
| `selectSemester` / `showSingleSelection`（弹窗选学期） | **改** | 公共说明：不弹窗，取当前学期，选不出按日期或第一个并如实提醒。 |
| `showAlert`（导入前确认） | **删** | 提示桥不移植；导入前的确认由应用负责。 |
| `fetchMaxWeek` → `maxWeek` 接口 | **删** | 总周数按学期起止日期（教务给的校历）算；公共说明第 7 条。 |
| `saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` | **删** | 桥能力不移植；空课由宿主保存，适配器只交载荷。 |
| `isLoginPage`（`authserver` 且 `login`） | **改** | 改为：主机名不是 `zhjw.bbgu.edu.cn` 或地址里有 `authserver` 时，一律不发请求，给一句大白话。 |
| `cleanTeacher` 返回 `未知` | **改** | 空 / `未知` / `待定` 等交出去是 null（公共说明第 8 条）。 |
| `position` 回落 `待定` | **改** | 同上，地点为 null。 |
| `parseCourse` 周次认不出 → 整门课丢掉 | **改** | 认不出的周次写进提醒（计数 + 截短原文）；周次写法按 `hueb` 的解析认 (单)/(双) 等。 |
| `fetchCourses`：`rows.length === 0` → 报「格式异常」 | **改** | 空列表算合法返回（例如学期还没排课），由 parse.js 报「没有解析到任何课程」并提示可能是未排课或登录失效。 |
| 节次时间失败：不保存（静默） | **改** | 交 null，parse.js 用默认表并提醒。 |
| 上游 `parseWeeks` 只认 `a-b` 与单数字 | **改** | 见「与上游的周次差异」一节（上游写法的超集）。 |

### 与上游的周次差异

上游接受的写法（`1-4,6-9`、单个数字）全部保留；新增认 (单)/(双)、`第1-第8周`、`1-16周(单)`、括号备注与教学班序号（括号里的纯数字摘掉，含非周次字的备注摘掉并计数）。上游写法的解析结果不变（`basic` 的 `1-4,6-9` 与上游一致）。

## 变异测试记录

在临时副本（`C:/Users/23703/AppData/Local/Temp/bbgu-port29/`）上改 `parse.js`，每次只改一处，跑 `check.js`，然后删掉副本。真实目录未被改动。

| # | 改坏哪一处 | 哪条用例变红 |
|---|---|---|
| M1 | `teacherOf`：去掉「未知 / 待定 / 暂无」的 null 判断 | `basic`（教师「未知」不再为 null） |
| M2 | `weeksOf`：前置无逗号单双标记不补逗号（删掉「夹在两段中间」分支） | `week-markers`（`(单)1-8周(双)9-16周` 并到上一段，变成 1-16 每周） |
| M3 | 总周数：课表超出学期周数时不抬高 | `dates-raise`（第 19 周的课放不下，总周数没有抬高） |
| M4 | `weeksBetween`：去掉 `+1`（起止相隔整周时少算一周） | `dates-raise`（起止 2026-03-04 至 06-24 应为 17 周，改后算成 16） |

4 处全部变红。之后确认真实目录已还原，`check.js` 再次 PASS（见下面「自检结果」）。

## 桩与冒烟记录

### extract.js 桩（Node，不联网）

用 `vm` 注入假的 `window`、`fetch`、`Date`（固定为 2026-10-20）。结果：

| 场景 | 发出的请求（相对路径） | 结果 |
|---|---|---|
| S1 教务首页正常 | `GET /api/resourceapi/session/list`；`POST …/my-table-detail?sessionId=S2`；`GET …/get-large-period?sessionId=S2` | 选 `active` 学期；行只剩七个字段，学号 / 姓名 / 身份证 / 手机号不在输出里 |
| S2 统一认证页（同主机 `/authserver/login`） | 无 | 报「当前停在统一身份认证页面…」 |
| S3 其它主机（`cas.bbgu.edu.cn`） | 无 | 报「当前页面不是北部湾大学教务系统…」 |
| S4 无 active，今天落在某学期 | 同 S1，`sessionId=A2` | `pick = date` |
| S5 无 active，今天不在任何学期 | 同 S1，`sessionId=B1` | `pick = first` |
| S6 节次接口 500 | 同 S1 | `periodLists = null`，不报错 |
| S7 课表套了一层 `data` | 同 S1 | 照常取到行 |
| S8 学期接口 401 | 只有 session/list | 报「教务系统返回错误（代码 401）：登录状态可能已失效…」 |
| S9 课表返回 HTML（登录失效） | 三个都发出 | 报「教务系统没有返回课表数据（返回的内容格式不对）…」 |
| S10 学期列表为空 | 只有 session/list | 报「没有读到学期列表…」 |

所有请求都 `credentials: include`，没有请求体（`my-table-detail` 无体，按上游）。存储里有合法令牌时三个请求都带 `Authorization: Bearer <令牌>`；没有（或只有不像 JWT 的值）时不带头。

### 浏览器冒烟（Playwright + Rhino 跑 parse.js）

`python -I -X utf8 D:/NullClass/.test/port-batch29/bbgu/smoke.py all` → **7/7 OK**（含下面的 `token` 与 `junk`）：

- `home`：正常取数，学期 `2026-2027学年第二学期`，起始 2027-02-22，19 周，高等数学单双周 + 大学物理（教师两人、无教室），4 条提醒。
- `login`：`/authserver/login` 页面，不发 API 请求，给出提示。
- `cas`：`cas.bbgu.edu.cn` 页面，不发 API 请求，给出提示；外域子资源与接口一律被 route 拦下（断言被拦列表为空）。
- `noperiods`：节次接口 500，用默认 12 节并提醒。
- `expired`：学期接口 401，报错（存储里带着假令牌，断言报错文字里不含令牌原文）。
- `token`：localStorage 的 `access_token` 放一个假 JWT，断言三个接口请求头都是 `Bearer <令牌>`，且输出与报错里都搜不到令牌原文（`Bearer` 字样也不许出现在输出里）。
- `junk`：localStorage 与 sessionStorage 里放不像 JWT 的值（`eyJ-junk-value`、`Bearer abc.def`、`eyJx`），断言三个接口请求都不带 `Authorization`。

## 自检结果

`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/bbgu`：6 对 fixture 全部 MATCH，ES5 与控制字节检查通过，allowHosts 检查通过，最后一行 `RESULT: PASS`。

## 已知风险与未验证项

1. **登录令牌**：已按主调度决定照上游保留（读取 + JWT 形状校验 + 只发同源）。风险在于：令牌在页面存储里的位置与格式只按上游代码推断，真机是否存在、是否是三段 JWT 未验；若真机没有令牌，接口返回未登录，适配器会报「登录状态可能已失效」，属于正常兜底。
2. **没有本校账号，真机没验过。** 所有接口形状、字段名、学期 `active` 标记、`beginDate` 格式（上游代码里是 `session.beginDate` 的原样）都只按上游代码与桩推断。
3. **`scheduleUrlHint` 填的是 `loginUrl`**（即 `https://zhjw.bbgu.edu.cn/workspace/home`）。上游代码里没有课表页地址（只有 adapters.yaml 的 `import_url`），按任务卡的主调度决定写的。真实课表页地址未知，一键刷新会先打开首页。
4. **周次与节次写法按上游 `1-4,6-9` 与 `10-11` 推断。** 真实 `teachingWeekFormat` / `periodFormat` 可能是别的写法（如「1-16周(单)」或「12」），解析已经做了宽松处理，但没有真实数据验证。
5. **学期名**：假定 `year` 为 `2026-2027` 或 `2026`，`term` 含「春 / 夏 / 秋」。读不出时用「北部湾大学 第 X 学期」。
6. **总周数**：用 `endDate - beginDate` 算。若 `endDate` 包含考试周，总周数会偏大（只影响周数显示，不影响课程）。上游用的 `maxWeek` 接口已删，两者可能不一致。
7. **开学日**：取 `beginDate` 回退到周一（手册 §4.3）。若学校第一周不是从周一开始，提醒里写明了，但需要用户核对。
8. **默认节次表**是空课自己的 12 节表，不是学校的作息。接口取不到时，时间可能与学校实际不符，提醒里已说明。
9. **`hueb` 的纯转换骨架**：周次、节次、合并逻辑借自正方的已审计件，对金智数据的适配只靠 fixtures 与变异测试验证，没有真实数据验证。
10. **时钟**：`today` 与选学期的「今天」用本机时钟。
11. **未测**：WebView 中 `fetch` 与 `credentials` 的真实行为，Cookie 作用域（`zhjw.bbgu.edu.cn` 与统一认证域的跳转）。

- **复审修正（主调度，2026-11-03）**：总周数原先从教务给的学期开始日算，开学日却退到那周的周一，开始日不是周一时会少算一周（例：2026-09-01 周二起、2027-01-18 止，应为 21 周却算成 20 周）。改为两者同一起点（开学那周的周一）。新增 `dates-tuesday`（期望手推：开学日 2026-08-31、总周数 21）；改回旧算法 → 该用例变红，在临时副本上做，已删。

## 签名

0x7E7-2023（haiku 移植，2026-11-03）
