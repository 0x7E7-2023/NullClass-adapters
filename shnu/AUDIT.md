# shnu 移植审计（上海师范大学，树维 EAMS）

本文件记录 `jw-adapters/shnu/` 的审计结论，对应移植手册 §5 安全清单与批次四专项检查表。
审计的是安全性，以及「本文件的声明与代码一致」，不是解析正确性。本移植没有上海师范大学的真实账号，没有在真实教务页面上跑过，见 §8。

## §1 来源（provenance）

- 上游仓库：https://github.com/XingHeYuZhuan/shiguang_warehouse
- 上游文件：`resources/SHNU/shnu.js`，快照 commit `ff72d1f08782df965cae110034a9d87cd91e0c07`（2026-10-08）
- 上游维护者 FaQxD233，许可 MIT，版权 星河欲转
- 上游 `resources/SHNU/adapters.yaml`：adapter_id `SHNU_01`，adapter_name `上海师范大学树维教务`，category `BACHELOR_AND_ASSOCIATE`，asset_js_path `shnu.js`，import_url `https://course.shnu.edu.cn/`，maintainer `FaQxD233`
- 上游文件指纹：快照 blob 经 LF 归一化后的 sha256 为 `271be9cc917af1e1fc5874519c15acb7f1d62c075edce6a75b4b751a3ba2937f`，15689 字节。本机工作副本是 CRLF（整文件 sha256 `ceb4912035de2385e68985c12f969b8353fa1078548afbbee23a1c8fd32827ca`），去掉回车后与 blob 一致，以 blob 为准。
- 本移植文件指纹：`manifest.json` 版本 `1.0.0`，specVersion 1，minAppVersionCode 11，sha256 `fc9e1c5391420dbd39074eaa4e73a5d57bd10666dd4d351cb26dfcc70bd01c64`（含 5 个 fixture）；`extract.js` sha256 `857c838eaa4b6c2edd8f9e2ab97088871361d63c74e718f0870f43ccecea6c50`；`parse.js` sha256 `ad8cd0ae16c62d96990c64c25651dd5429ee19babce9a695fe106395a5575a85`。
- 目录结构起点：`jw-adapters/tjau/`（天津农学院，只读，本次未改）。逻辑按上游 shnu.js 另写，模板只提供目录结构与已审过的写法。
- 注释里的主机字符串：`extract.js` 第 13 行注释写有 `https://course.shnu.edu.cn/eams`，仅作说明；代码里没有这个字面量，地址由当前页面的 origin 拼出（见 §2.1）。文件头的 GitHub 地址是上游出处。

## §2 请求表与读取、交出清单

### 2.1 请求表（extract.js）

请求的主机只有一个：当前页面的 origin（`window.location`）。路径前缀固定为 `/eams`；若当前路径里已含 `/eams/` 段，则保留该段之前的前缀（`eamsBase()`，`extract.js` 第 44 行）。代码里没有写死的主机。

| # | 方法与地址 | 请求体 | 失败时 |
|---|---|---|---|
| 1 | GET `{base}/courseTableForStd.action?sf_request_type=ajax` | 无 | HTTP 非 2xx、网络错误、响应超过 4000000 字符，都改试 GET `{base}/courseTableForStd.action`；这次也失败则整次提取报错。页面返回 200 但读不出学号时不回退，直接报错 |
| 2 | POST `{base}/dataQuery.action?sf_request_type=ajax` | `tagId=<编码>&dataType=semesterCalendar&empty=false` | 页面上找不到学期组件 id 时不发请求；请求失败返回空串，不报错 |
| 3 | POST `{base}/courseTableForStd!courseTable.action?sf_request_type=ajax` | `ignoreHead=1&setting.kind=std&startWeek=&project.id=1&semester.id=<编码>&ids=<编码>` | 失败即报错 |

- 三条请求都带 `credentials: 'include'`，由浏览器自动带上本站 cookie；脚本不读、不写 cookie 的内容。
- 三条请求都带头 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: */*`。GET 也带 Content-Type，这是 `request()`（`extract.js` 第 69 行起）的统一写法。
- 与上游的差异：上游 `request()`（上游第 33–35 行）是 `fetch(url, { credentials: "include", ...options })`，POST 只带 Content-Type。本移植多带两个头，与模板 tjau 的写法相同；这两个头是否必要未经实测验证。
- 用户可见的错误文本：HTTP 非 2xx 时为「教务系统返回错误（代码 …）：登录状态可能已失效，请重新登录后再点「提取课表」」；网络错误时为「连不上教务系统…」。
- 等待页面就绪最多 8 秒（`whenReady()`，`extract.js` 第 112 行）。

### 2.2 读了什么、交出什么

只在 WebView 内存中读取：

- 入口页 HTML（第 1 步的返回）。用三条正则取值：学号 `ids`（来自 `bg.form.addInput(form, "ids", "…")`）、学期组件 id（`id="semesterBar…Semester"` 中的数字，作为第 2 步的 tagId）、页面当前学期 id（`name="semester.id"` 隐藏域的值，`paramsOf()`，`extract.js` 第 342 行）。入口页 HTML 本身不进入输出。
- 学期日历（第 2 步的返回）。用「只扫值、不求值」的字面量函数（`extract.js` 第 134–288 行）取出 `semesterId`，以及学期列表中每项的 id、name、schoolYear、startDate、endDate。
- 当前页面的 `document.documentElement.innerHTML`。只用正则取 `unitCount` 的数字，交出去的只有这个数字（读不到为 null，`readUnitCountFromPage()`，第 355 行）。
- `window.location` 的 origin 与 pathname，只用于拼地址。
- 本机日期（本地时区的年月日），用于学期选择的「包含今天」一步，并作为输出字段 `today`。

交出去的是 `extract.js` 输出的 JSON，字段如下：

| 字段 | 内容 | parse.js 是否读取 |
|---|---|---|
| `today` | 本机日期，YYYY-MM-DD | 是，只在教务没给开学日、需要推算时读取（`todayOf()`，`parse.js` 第 436 行起） |
| `semester` | `{ id, rawName, schoolYear, startDate, endDate, source }`；`source` 为选中依据：page / current / date / latest / last | 是 |
| `unitCountPage` | 页面上的 unitCount 数字，或 null | 是，只接受 1–60 |
| `semesterCalendar` | 学期日历原文 | 否，保留，见 §8 |
| `courseTable` | 课表 HTML 全文 | 是，唯一的课程来源 |

- 学号 `ids` 只用于第 3 步的请求体，不写进 `semester` 等任何字段。但课表 HTML 全文可能含有它，见 §8。
- 不读取：cookie、localStorage、sessionStorage、密码或登录表单字段、成绩、学籍、个人信息、缴费页面。本脚本只请求上面三条地址（以及第 1 步的裸地址回退，同一地址）。

## §3 移植手册 §5 安全清单（八项）

检索范围：`extract.js` 与 `parse.js` 全文，含注释。

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | 检索 password、pwd、localStorage、sessionStorage、cookie、token、credential：无命中。不读登录表单。`credentials: 'include'` 只让浏览器带上本站 cookie，脚本接触不到其内容 |
| 2 | 不外发 | 通过 | 网络调用只有 `extract.js` 中 `request()` 里的一处 `fetch`，地址都由 `eamsBase()` 拼成。检索 sendBeacon、WebSocket、new Image、XMLHttpRequest：无命中。`parse.js` 不含任何网络调用 |
| 3 | 请求域可控 | 通过，见 §1、§2.1 | 请求只指向当前页面的 origin 及其 `/eams` 前缀，代码里没有固定主机。allowHosts 为 `[]`，与模板 tjau 一致。地址是由 origin 拼出的绝对地址，不是相对路径，见 §8 第 9 条 |
| 4 | 只读课表 | 通过 | 只请求三条：课表页（courseTableForStd）、学期日历（dataQuery，semesterCalendar）、课表（courseTable）。上游请求的也是这三条（上游第 42–46、99–102、146–150 行一带）。没有成绩、学籍、个人信息、缴费接口 |
| 5 | 不埋点 | 通过 | 检索 analytics、telemetry、track、report、beacon、统计、埋点、上报、匿名：只命中 `extract.js` 第 31 行注释（「不上报任何账号信息」） |
| 6 | 不 eval 远程代码 | 通过 | 检索 eval、`Function(`、`new Function`：无命中。上游第 76、83 行的 `Function("return …")()` 已删，改为 `extract.js` 里的字面量扫描函数（第 134–288 行），只扫值、不执行。桩测试 S9 中，恶意学期日历文本没有被执行，见 §7 |
| 7 | 不写页面 | 通过 | DOM 只读：`document.documentElement.innerHTML`（读）、`document.readyState`（读）、`addEventListener('DOMContentLoaded')`（监听）。无 innerHTML 赋值、无 appendChild、无 submit、无 click、无 value 赋值、无 setAttribute |
| 8 | 不依赖输入之外的秘密 | 通过 | 没有硬编码的学号、令牌、密钥。学号是运行时从本人课表页读出的。两个文件中没有 8 位以上的数字字面量（毫秒换算常数 86400000 除外）。fixtures 全部为合成数据，`_note` 注明不含真实学号 |

## §4 批次四专项检查表（12 条）

| # | 检查项 | shnu 做法 | 证据 |
|---|---|---|---|
| 1 | 周次位图基准 | week = index。位图第 0 位为 1 视为占位符：忽略这一位，计数，warnings 写明。`weeksOf()`（`parse.js` 第 174 行起，第 179 行判断第 0 位） | fixtures/weeks-bitmap 为对照：线性代数（第 0 位为 1，第 1–3 位为 1，得第 1–3 周）；军事理论（第 0 位为 0，第 1 位为 1，得第 1 周）；大学物理（第 0 位为 1，得第 2–16 周）；劳动教育（只有第 0 位为 1，整门跳过并计数）。变异 m1 使该用例变红，见 §7 |
| 2 | TaskActivity 参数位 | 按引号字段序号取值，与上游相同（上游第 205–229 行）：quoted[1] 课程名；quoted[3] 教室；quoted[4] 位图，不符合 `^[01]+$` 时取第一个 `^[01]{6,}$` 字段；位图不在第 4 位时，教室取位图前一字段（`parseTaskActivities()`，第 201 行起）。教师不从参数位取，只取本活动前一段的 actTeachers，上游也如此 | fixtures/edge-units：位图在 quoted[5]，教室取 quoted[4]。变异 m2、m3 不涉及此处 |
| 3 | index 两种写法 | 只认 `index = 星期 * unitCount + 节次;` 一种，与上游同一个正则（上游第 241 行），不求值。不匹配的块（如裸数字 `index = 7;`）计数，warnings 写明。上游对这种块静默丢弃，本移植改为出声 | `parse.js` 第 252 行（正则）、第 265 行（计数）；fixtures/edge-units 的「选修课程」（`index = 7;`） |
| 4 | unitCount 要真的读 | 课表响应里的 `unitCount = N` → 页面 unitCountPage（只接受 1–60）→ 缺省 14。第二、第三种情况各写一条 warnings（`parse.js` 第 366–374 行；warnings 在第 569–572 行） | fixtures/edge-units：响应里没有 unitCount，用页面值 14，warnings 写明来源 |
| 5 | 作息时间来源与校验 | 脚本内置。来源是上游 shnu.js 的 `SHNU_TIME_SLOTS`（上游第 13 行起，14 节），值与 `parse.js` 第 41 行起的 `SCHOOL_PERIOD_TIMES` 一致。不是从教务页面读的，warnings 写明。每节过 HH:mm 格式校验（小时 00–23、分钟 00–59）且开始早于结束（`validSlot()`，第 124 行），不合法的节次丢弃并写 warnings（第 610–612 行）。课表用到的节次超过表长时写 warnings（第 604–609 行） | 所有 fixture 的 periodTimes 为 14 节；fixtures/edge-units 用到第 14 节（上限），不触发超节次提示 |
| 6 | 开学日 | 取自学期日历选中学期的 startDate，firstDay 为该日所在周的周一，写 warnings（`parse.js` 第 478–479 行，warnings 第 552 行）。拿不到 startDate 时不报错，按学期锚点推算（`anchorOf()`，第 443–471 行；调用在第 481 行）：第一学期 9 月 1 日、第二学期 2 月 20 日所在周的周一。学期类型与学年的取法见 §5「开学日推算」一行。推算的 warnings 写明规则与依据（第 546–550 行）。与清单第 6 条一致，见 §8 第 3 条 | fixtures/no-calendar（推算值 2027-02-15，手算，见 §8 第 12 条）；桩测试 S3、S9（§7.2）；变异 m4 把推算改成报错，no-calendar 变红（§7.1） |
| 7 | 周次上限 | 学期总周数 = 起止日期的天数除以 7 向上取整（`parse.js` 第 499–501 行）；超过 30 截为 30，并写 warnings（截断在第 505–507 行，warnings 在第 559–561 行）。课表位图中超过第 30 周的周次丢弃并计数（第 183–184 行），写 warnings（第 592–594 行），不截为 30。**有意偏离批次四第 7 条「越界一律 clamp 到 30」**，理由与决定见 §8 第 5 条 | **缺口**：没有 fixture 覆盖超过 30 周的情况，这两条路径只经过代码审阅 |
| 8 | teacher / location 留空 | 教师取不到为 null（`teacherOf()`，第 148–170 行）；教室为空或摘完括号后为空，为 null；课程名为空的块丢弃并计数。代码里没有「未知教师」「未知地点」「未知课程」字样；检索「未知」只命中 `parse.js` 第 16 行注释，那里写的是上游的做法 | fixtures/edge-units：大学体育的教室为 null，体育理论的教师为 null |
| 9 | 学期名 | 取教务的 rawName（其中含「学期」字样时）；否则由 schoolYear 与学期序号拼成（`KIND_CN`，第 58 行）；都没有则用「上海师范大学 当前学期」并写 warnings。不用适配器名 | fixtures/edge-units 走兜底名；桩测试 S1 的学期名由 rawName「1」与 schoolYear「2026-2027」拼成 |
| 10 | allowHosts | `[]`，理由见 §3 第 3 条 | `manifest.json` |
| 11 | warnings 上限 | 每条超过 200 字符时截为 199 字符加「…」（`warn()`，第 532–536 行）。超过 20 条时保留前 19 条，并加一条「另有说明因为超出上限没有显示，请把这份课表反馈给我们」（第 614–616 行） | 代码审阅；fixtures 的 warnings 最多 7 条，超过上限的分支没有 fixture 覆盖 |
| 12 | 变异测试 | 四处改动（m1–m4），每处至少有一条 fixture 变红，见 §7 | §7 |

## §5 与模板 tjau 的差异

模板的目录结构与请求写法（请求头、三条请求的顺序、同源 origin 拼地址）与本移植相同，下表只列逻辑上不同的地方。

| 项目 | tjau（模板） | shnu（本移植） | 理由 |
|---|---|---|---|
| 课程名括号 | 只摘末尾的数字序号，如 (1)、（2），1–3 位数字 | 摘末尾一对半角括号，同上游：`大学英语(一)` → `大学英语`；`体育(1)(2)` → `体育(1)`；全角括号内容保留 | 上游写法；`(一)` 这类是课程名的一部分，只摘末尾一对 |
| 教室括号 | 保留括号内容（`parse.js` 第 329–332 行） | 去掉半角括号内容，同上游：`信息楼A305(东)` → `信息楼A305`；去完为空则为 null | 上游写法 |
| 学期选择顺序 | `cal.currentId` 或页面学期 id → 起止日期包含今天 → 起始日期最晚（`extract.js` 第 311–330 行） | 页面学期 id → 日历标出的当前学期 → 起止日期包含今天 → 起始日期最晚 → 列表末项 → 页面学期 id 兜底 | 上游选择框的默认项就是页面当前学期（上游第 66、94、130 行一带，`currentSemesterId`），本移植先取页面学期 |
| 学年兜底 | `termYearLabel()` 在缺 schoolYear 时由今天的日期推出学年；学期名取不到时兜底为「天津农学院 + 推出的学年 + 学年」（`parse.js` 第 585–606 行） | 学期名不推学年：缺 schoolYear 时名字兜底为「上海师范大学 当前学期」，并写 warnings（`parse.js` 第 544 行）。学年只用于推算开学日，见下一行 | 由今天的日期推学年可能推错，所以学期名里不写推出来的学年，宁可明说 |
| 开学日推算（缺起始日期时） | 学年：有 schoolYear 取前四位，缺则取今天的年份（`academicYear`，`parse.js` 第 614–626 行）。学期类型：只认 rawName 为 `2` 的为第二学期，其余一律第一学期（第 627 行） | 学期类型先看 rawName（`1`、`2`，或含「第一学期」「第二学期」字样）；读不出时按提取当天的月份判，2–7 月为第二学期。学年：第二学期取 schoolYear 前四位加一，第一学期取前四位；缺 schoolYear 时由今天推（第一学期 8 月及以后取今年，否则取去年；第二学期 8 月及以后取明年，否则取今年）。锚点为 2 月 20 日或 9 月 1 日所在周的周一（`anchorOf()`，`parse.js` 第 443–471 行）。推算写进 warnings（第 546–550 行） | 读不出学期类型时，tjau 一律按第一学期推算，本移植按提取当天的月份判（主调度决定 1）；缺 schoolYear 时，tjau 一律用今年（第二学期加一），本移植按月份判 |
| 学期日历请求体 | `tagId=…&dataType=semesterCalendar`，没有 `&empty=false`（`extract.js` 第 386 行） | 带 `&empty=false`，与上游逐字一致 | 上游写法 |
| 页面 unitCount | extract 写入 `unitCountPage`，parse 不读 | parse 读取，作为课表响应缺 unitCount 时的第一兜底 | 让这个兜底真正生效 |
| 作息表 | 脚本内置，来自上游 tjau.js，11 节（`parse.js` 第 62–66 行一带） | 脚本内置，来自上游 shnu.js，14 节 | 各自上游的值，来源都写明 |
| 占位符字样 | 代码里没有「未知」字样，只在注释里提到 | 同样没有 | 批次四第 8 条 |

模板文档的一处错误，移植时没有照抄：tjau 的 `AUDIT.md` §8 第 6 条说 `parse.js` 会重扫学期日历（`semestersOf`），但 tjau 的 `parse.js` 里没有这个函数。本移植的文档不引用这一条。

## §6 上游删掉或改掉的东西及理由

上游行号指 `resources/SHNU/shnu.js`（快照 ff72d1f0）。

- **学期选择框** `showSingleSelection("选择学期", …)`（上游第 137 行一带）：删。理由：适配器只取数，不弹框；学期按 §5 的顺序自动选，依据写进 warnings。
- **`Function("return (" + raw + ");")()`**（上游第 76 行）与 **`Function("return ({semesters: " + …)`**（上游第 83 行）：改为字面量扫描函数。理由：手册 §5 第 6 条；响应体是网络上取回的文本，不能求值。
- **`applyTimeSlots()` 与 `savePresetTimeSlots(JSON.stringify(SHNU_TIME_SLOTS))`**（上游第 351–352 行）：删。理由：适配器不直接写宿主设置。作息表放进输出的 `periodTimes`，由宿主处理。
- **`runImportFlow()`**（上游第 359 行起，调用在第 388 行）以及其中的 `saveImportedCourses`（第 376 行）、`notifyTaskCompletion`（第 380 行）、`showToast`（第 361、366、370、379、384 行）、`console.error`（第 383 行）：全部删。理由：只取数，不推送课程、不发完成通知、不弹提示。失败以中文 Error 抛出，由宿主收到后显示。
- **`网络请求失败: ${res.status}`**（上游第 35 行）：改为中文说明，并提示重新登录（§2.1）。理由：用户可见文本。
- **`"未知课程"`**（上游第 215 行）、**`"未知地点"`**（第 231 行）、**`"未知教师"`**（第 246 行）：删。理由：批次四第 8 条；拿不到就留空，课程名为空则丢弃并计数。地点的括号处理（第 231 行的 `replace(/\(.*?\)/g, "")`）保留，行为与 §5 一致。
- **unitCount 缺省 14 时不提示**（上游第 171 行）：保留缺省值 14，但改为写 warnings（§4 第 4 条）。
- **裸数字 `index = N;` 的块被静默丢弃**（上游第 241 行的正则只认一种写法）：保留丢弃的结果，但改为计数并写 warnings（§4 第 3 条）。

## §7 变异测试与桩测试

### 7.1 变异测试（四处改动）

做法：在临时目录 `C:/Users/23703/AppData/Local/Temp/shnu-mut-2/` 里复制本移植的全部文件（含本 AUDIT.md，不在 `jw-adapters/shnu/` 内），只在副本的 `parse.js` 里改一处，然后对副本跑 `check.js`。正式文件没有被改动。运行变异的脚本（`mutate.js`）也在临时目录，运行结束后临时目录已按主调度要求删除。

| 编号 | 改动（只改副本） | 变红的 fixture | 副本里的现象 |
|---|---|---|---|
| m1 | `weeksOf()` 里 `if (i === 0) {` 改为 `if (i === 99) {`，即不再跳过位图第 0 位 | weeks-bitmap | 劳动教育（只有第 0 位为 1）被当成一门课导入，周次出现第 0 周；课程数实际 4、期望 3。其余四个 fixture 保持一致。`RESULT: FAIL (1)` |
| m2 | `courseNameOf()` 里 `var stripped = text(name.replace(…))` 改为 `var stripped = text(name);`，即不摘末尾括号 | basic、course-name | 「大学英语(一)」「高等数学A(一)」「体育(1)(2)」「数据结构(2)」没有被摘掉；warnings 条数与期望不符（5 对 6）。edge-units 和 no-calendar 没有括号课程名，保持一致。`RESULT: FAIL (2)` |
| m3 | `teacherOf()` 里 `kept.join(',')` 改为 `kept[0]` | edge-units | 「甲教师,乙教师」变成「甲教师」。其余四个 fixture 保持一致。`RESULT: FAIL (1)` |
| m4 | 开学日推算分支改成报错：副本里把 `anchorInfo = anchorOf(sem);` 换成 `throw new Error('教务没有给出这个学期的开学日期');`，即校历缺失时不推算 | no-calendar | Rhino 报 JavaScriptException「教务没有给出这个学期的开学日期」（副本 `parse.js` 第 481 行），`RESULT: FAIL (1)`。其余四个 fixture 保持一致 |

- 副本里的 check.js 失败只来自变红的 fixture（副本已包含 AUDIT.md，所以没有「缺 AUDIT.md」）。
- 恢复确认：正式文件没有被改动。四次变异运行前后，`parse.js` 的 sha256 都是 `ad8cd0ae16c62d96990c64c25651dd5429ee19babce9a695fe106395a5575a85`，`extract.js` 为 `857c838eaa4b6c2edd8f9e2ab97088871361d63c74e718f0870f43ccecea6c50`，`manifest.json` 为 `fc9e1c5391420dbd39074eaa4e73a5d57bd10666dd4d351cb26dfcc70bd01c64`，均未变。
- 收尾改动（主调度，只改给学生看的文字、不改逻辑）：`extract.js` HTTP 非 2xx 报错「教务系统返回 HTTP N」→「教务系统返回错误（代码 N）」；`parse.js` 学期来源的兜底说法「课表页上的学期组件」→「课表页上当前选中的学期」（与 `BASES.page` 一致；现有用例都走不到这一支，期望值不变）。改后 `parse.js` sha256 `a6251a0091d1c234145d3deccfe4314c5213beb8284aaffa7613d6dfa9d24d71`，`extract.js` `39fce8880288a8daeb3a2d14384227c3b3c713f383f793978e70cc7c05de44f4`。
- 注释改动只改注释，不改代码：`parse.js` 第 15–16 行、第 22 行（⑨ 开学日说明）；`extract.js` 第 333–334、376–377 行。开学日推算的代码在 `parse.js` 第 436–482 行与第 546–550 行，m4 改的就是其中的推算分支。check.js 的结果见 §8 第 12 条，桩测试结果见 §7.2。

### 7.2 桩测试（Node vm，不在移植目录内）

脚本：`C:/Users/23703/AppData/Local/Temp/shnu-stub/run-stub.js`，运行后已按主调度要求删除，结果保留在下表。用 Node 的 vm 模拟 window、document、fetch，逐个场景运行 `extract.js`，再把输出交给 `parse.js`。S3、S9 的推算结果依赖运行当天的日期，下表以 2026-10-08 运行为准。这是 `extract.js` 唯一的运行证据，见 §8 第 2 条。

| 场景 | 设置 | 结果 |
|---|---|---|
| S1 | 正常 | 学期来源 page（id 454）；parse 通过：2026-2027学年第一学期，首日 2026-08-31，20 周，1 门课，5 条 warnings |
| S2 | ajax 入口请求失败，回退裸 GET | 请求顺序正确；结果同 S1 |
| S3 | 学期日历返回 HTTP 500 | 日历为空，学期来源 page（只有页面学期 id，学期名与日期都没有）；parse 不报错：学期名为「上海师范大学 当前学期」（写 warnings）；学期类型读不出，按运行当天的月份判为第一学期；学年读不出，按今天推为 2026 学年，推算开学日 2026-09-01 所在周的周一，首日 2026-08-31，写入 warnings；没有结束日期，总周数用缺省 20 周，写入 warnings |
| S4 | 入口页没有 ids | extract 报错「未能识别教务参数（学号）…」 |
| S5 | 没有学期组件 id，也没有页面学期 id | extract 报错「没能确定要导入哪个学期…」 |
| S6 | 日历的 currentId 为 455 | 学期来源 current；parse 通过：2026-2027学年第二学期，首日 2027-02-15，21 周 |
| S7 | 日历里有起止日期包含今天的学期 | 学期来源 date（454）；parse 通过 |
| S8 | 所有学期的起始日期都在过去 | 学期来源 latest（455，起始 2025-02-20）；parse 通过：2024-2025学年第二学期，首日 2025-02-17，21 周 |
| S9 | 学期日历文本含可执行代码 | 代码没有被执行（沙箱里的探测变量仍未定义）；学期 454 的起始日期取不出（为空），parse 不报错：按学期序号 1、学年 2026-2027 推算第一学期 9 月 1 日所在周的周一，首日 2026-08-31，写入 warnings；结束日期 2027-01-15 有效，总周数 20 |

- S1 的请求体：dataQuery 为 `tagId=semesterBar12Semester&dataType=semesterCalendar&empty=false`；courseTable 为 `ignoreHead=1&setting.kind=std&startWeek=&project.id=1&semester.id=454&ids=…`。ids 是桩里的合成值，不是真实学号。

## §8 风险与未验证项

1. 没有真实账号，没有在 course.shnu.edu.cn 上实跑。入口页 HTML 的格式、学期日历的格式、课表里 TaskActivity 的参数位，都依据上游代码与合成 fixtures，没有见过真实页面。
2. `extract.js` 只在 Node 桩测试中运行过（§7.2），没有在 WebView 里运行。`parse.js` 经 check.js 用 Rhino 1.8.0 实跑 fixture。
3. 学期日历取不到时（HTTP 错误、被挡、返回为空、起始日期取不出），extract 不报错，parse 也不报错：按学期锚点推算开学日（第一学期 9 月 1 日、第二学期 2 月 20 日所在周的周一），并在 warnings 写明「不是教务给的，请核对」。这与批次四第 6 条一致，是主调度的决定（移植手册 §4.2，依 tjau 的做法）。残余风险：学校实际开学日不在锚点那一周时，整学期的课会显示在错误的日期；学期类型读不出时按提取当天的月份判（2–7 月视为第二学期），也可能判错。宿主不会自动核对，只靠 warnings 提醒用户。
4. 课表 HTML 全文（`courseTable`）原样交出，未经脱敏。学号 `ids` 只用于拼第 3 步（courseTable）的请求体，不写进 `semester`、`today` 等任何输出字段，也不进入 parse.js 的 payload（payload 只含解析出的课程、周次与作息字段，不含 HTML 原文）。但课表 HTML 全文可能含有学号，这一点没有经真实页面验证；按 tjau 的做法原样交出，主调度已接受（决定 3）。交出之后的处理由宿主负责，不在本文件审计范围内。
5. 周次上限有两处取舍：学期总周数超过 30 时截为 30，并写 warnings；位图里超过第 30 周的周次丢弃并计数，写 warnings，不截为 30。**这是对批次四第 7 条的有意偏离**：该条要求越界一律 clamp 到 30，但 clamp 会把超过第 30 周的课挪到第 30 周，课表位置随之移动，用户看到的是错位的课表；丢弃并写明只少了那几周，错误不会换个位置出现。主调度已接受（决定 2），记入本文件。若学校教学周超过 30 周，这部分周次会丢失，warnings 会写明。两条路径都没有 fixture 覆盖（§4 第 7 条）。
6. 节次换算只认 `index = 星期 * unitCount + 节次;` 一种写法，与上游一致。真实页面若用别的写法（如已算好的 index 数字），这些课会被丢弃，并写进 warnings，不会静默丢失。
7. 作息时间是上游脚本内置的值，不是学校的实际作息。warnings 已写明，用户需要在学期管理里核对。
8. 教师只取本活动前一段的 actTeachers。取不到则为 null，不报错；若真实页面的教师不在那个位置，教师名会丢失。未经真实页面验证。
9. 请求主机：地址由当前页面的 origin 拼成，allowHosts 为 `[]`。若真实教务在别的域名（门户或 WebVPN 前缀），`eamsBase()` 只保留路径里 `/eams` 之前的前缀，不改主机。需要真实页面确认。
10. ES5：check.js 对两个文件做关键字与语法扫描（原始源码含注释），并用 Rhino 实跑 parse.js。`extract.js` 不能在 Rhino 中运行（它依赖 WebView 的 fetch 与 document），它的 ES5 只经过关键字扫描，没有经过 ES5 解析器的完整校验。
11. `semesterCalendar` 保留在输出里，parse.js 不读；主调度已接受保留（决定 4–7，不改）。`today` 现在由 parse.js 读取，只在推算开学日时用到（§2.2），有教务开学日时不影响结果。
12. 合成 fixtures 的 expected 值在运行前手算写定，之后没有根据输出修改。前四个 fixture 在第一次 check 时全部 MATCH。第五个 fixture（no-calendar，日历缺失时的推算）是改代码之后才加的，expected 也是先手算、再跑 check，结果 MATCH，没有据输出改动。
13. 超过上限的 warnings 分支（超过 20 条时）没有 fixture 覆盖，只经过代码审阅。

## §9 签名

0x7E7-2023（haiku 移植，2026-10-08）
