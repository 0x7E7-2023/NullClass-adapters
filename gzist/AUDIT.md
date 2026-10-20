# 安全审计 —— 广州理工学院（正方教务 V9 新版 jwglxt，统一认证直连 / WebVPN 明文主机前缀）

审计对象：`jw-adapters/gzist/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `GZIST/gzist_01.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，复核时仍是最新；
本校脚本最后一次修改 `ccd43dd`，2026-10-14；MIT，作者 YT-O5）。上游同目录 `adapters.yaml` 里 `GZIST_02`（WebVPN 入口）指向的是同一份脚本，
本件不另起一份，`allowHosts` 同时放行两个主机。

审计方式：逐行读上游脚本与模板件 `hueb`，移植件逐函数对照；移植手册 §5 八条逐条结论；静态扫描（check.js，ES5 / 控制字节 / allowHosts / 载荷校验）；
extract.js 在 Node 里用桩 window / location / fetch / DOMParser 实跑，覆盖 10 个场景（见 §6）。

静态扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js` 代码里没有任何绝对地址（check.js 剥注释后扫描通过）；`parse.js` 的 `https://github.com/...` 只在文件头注释里。
- 网络调用：只有 `extract.js` 的 `request()` 一处 `fetch`。`parse.js` 没有任何网络调用。
- 原型方法：`extract.js` 代码里不调用 `.filter(` / `.trim(` / `.map(` / `.forEach(` / `.some(` / `.find(` / `.reduce(`（grep 全文只在注释里提到 filter 与 trim 两个名字）。本校页面改写了这两个原型方法（上游注释），桩跑时照上游描述把它们改坏，见 §6 场景 S4 / S5。
- ES5：`parse.js`、`extract.js` 全文（含注释）无 `=>`、反引号、`let `、`const `、`class`、async/await、展开、模板串、`Set`/`Map`、`padStart`、`Array.from`、可选链、后行断言与命名分组。
- 控制字节与 BOM：全部文件无控制字节、无 BOM。

## 0. 上游问题与注意点

1. **上游注释与节次表不完全一致**：上游 `FALLBACK_TIME_SLOTS` 上方注释写「每节 45 分钟 + 10 分钟课间」，但表里第 9 节是 18:40–19:20（40 分钟）、第 10 节 19:20–20:00（40 分钟）。
   本件按任务卡「逐节照抄」，**以表为准，不按注释推算**；节次时间是否与学校实际作息一致，没有账号无法核对（见 §8）。
2. **上游的 WebVPN 与直连是两套写死的地址**：`BASE_URLS.campus = http://jw.gzist.edu.cn/jwglxt`，`BASE_URLS.webvpn = https://webvpn.gzist.edu.cn/https/jw.gzist.edu.cn/jwglxt`。
   上游 `getBaseUrl()` 在 WebVPN 主机上取 `/https/<主机>/jwglxt` 前缀，其它情况一律回落到直连常量。本件见 §4 第 3 条。
3. **上游在统一认证页、WebVPN 首页上也会发请求**：上游 `getBaseUrl()` 在这些页面回落到直连地址，请求必然失败。本件在这些页面直接报错，不发请求（§4 第 2 条）。

## 1. 请求域与请求清单（与代码逐条对应）

所有请求都由 `window.location` 拼成**同源**地址：`originOf()` 取当前页面的 origin，`jwBase()` 取当前路径里 `/jwglxt/` 为止的那一段
（直连下为 `http://jw.gzist.edu.cn/jwglxt`，WebVPN 下为 `https://webvpn.gzist.edu.cn/https/jw.gzist.edu.cn/jwglxt`）。
当前路径里没有 `/jwglxt/` 时，`jwBase()` 返回 null，脚本直接报错、**不发任何请求**。
`allowHosts` = `["jw.gzist.edu.cn", "webvpn.gzist.edu.cn"]`（不写通配）：`jw.gzist.edu.cn` 是直连教务主机，`webvpn.gzist.edu.cn` 是校外 WebVPN 入口。
`loginUrl` 在统一认证主机 `ids.gzist.edu.cn` 上，脚本本身不请求它（它只是用户登录的入口，见 §8 第 4 条）。

| 谁 | 方法 | 地址（`<base>` 见上） | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js `currentTerm` | GET | `<base>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的学年学期下拉框（`#xnm` / `#xqm`）。**页面上已有这两个下拉框时跳过这一步** | 报错，提示先打开「学生课表查询」或重新登录 |
| extract.js `fetchTimetable` | POST | `<base>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数。请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`，与上游逐字一致（参数值经 `encodeURIComponent`，数字不变） | 报错：非 2xx 报「教务系统返回错误（代码 N）」；响应是登录页报「登录状态已失效」；JSON 不对报「没有返回课表数据」 |
| extract.js `optionalJson` | POST | `<base>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取学期周次校历，定开学日与总周数。请求体 `xnm=…&xqm=…`，与上游一致 | 交 `null`，parse 推算开学日并写进 `warnings` |

**没有第四条请求**：本件不请求节次时间接口（`cxRjc`）。上游明确不用教务的作息接口（上游注释：接口给的是「每节 50 分钟、两节相连」的行政口径，与学校作息不符），
本件照上游写死 12 节（§5 第 1 条）。桩跑中所有场景的请求清单里 `cxRjc` 出现次数为 0（§6）。

与上游的差别：

- 上游每次导入都先弹两个选择框（`showSingleSelection`），选项来自学年学期首页的 `#xnm` / `#xqm`。本件改成读页面上的下拉框，读不到才取一次首页，不问用户（§5 第 2 条）。
- 上游请求头只带 `Content-Type`；本件统一带 `Content-Type`、`X-Requested-With`、`Accept`（与模板一致，不带任何自定义令牌）。
- 凭据用 `credentials: 'include'`，让 WebView 按同源规则带 Cookie；脚本既不读 Cookie，也不把它发到别处。
- 校历请求在课表请求成功之后才发（上游是并行发）：课表失败时不发校历，少一次无意义请求；校历失败不影响导入。
- `parse.js` 不发任何请求（CI 里用 Rhino 实跑，是纯函数）。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 与下拉框文本 `xnmText` / `xqmText`） | 课表页的 `#xnm` / `#xqm`，或课表首页 HTML（`DOMParser` 离线解析，不插入当前页面） | 带出（`term`，学期名要用） |
| 排课行 `kbList` | 课表接口 | 带出**白名单字段**：`kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd`（`KB_FIELDS`，`extract.js` 第 216 行） |
| 集中实践课 `sjkList` | 课表接口 | 只带 `kcmc`（`PRACTICE_FIELDS`）。没有固定星期与节次，排不进周课表，写进 `warnings` 让用户自己加 |
| 学期周次校历 | cxZcByXnxq | 交给 parse 只用来算开学日与总周数，不进入载荷 |
| 记录总数（响应里有才有：`total` / `totalResult` / `totalCount` / `count`） | 课表接口 | 只用于对账（取到的行数比总数少就写进 `warnings`），不进入载荷 |
| 今天的日期（本地） | 浏览器 | 只在推算开学日的兜底分支用（学年读不出来时），不进入载荷的其它字段 |
| 学生个人信息（课表响应里夹带的 `xsxx`、学号、姓名、学院、手机号等） | 课表接口 | **不带出**：`extract.js` 只按白名单挑字段。桩测试把 `xsxx`、学号、人员 ID、手机号混进响应，交出的字符串里一处都检索不到（§6 检查项） |

**本件与任务卡的一处出入**：公共说明的白名单列表里有 `xqh_id`（校区，取节次时间用）。本件不请求节次时间接口，`xqh_id` 没有用处，因此**没有带出**
（公共说明也写了「只留 parse.js 真正用到的」）。如主调度认为应保留，改 `KB_FIELDS` 一行即可，parse.js 不读它，不影响解析。

`parse.js` 实际读的字段：排课行 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd`；实践课 `kcmc`；`calendar` 的 `zs` / `zsmc` 与 `zrq` / `zcrq` / `rq` / `ksrq`；`total`；`today`；`term.*`。

不读的东西（静态扫描无命中）：`password` / `passwd` / 登录表单、`localStorage` / `sessionStorage` / Cookie、成绩（`/cjcx/*`）、学籍、个人信息、缴费，以及任何其它模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问。唯一的「凭据」是浏览器自带的会话 Cookie，脚本既不读它也不外发。上游的开场弹窗（`showAlert`）与两个学年学期选择框（`showSingleSelection`）都没有移植 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js` 的 `request()` 里，地址由 `window.location` 拼成同源地址。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单，也没有第三方域 |
| 3 | 请求域可控 | **过**。请求主机只有用户当前打开的教务主机（直连 `jw.gzist.edu.cn`，或 WebVPN `webvpn.gzist.edu.cn`）。`allowHosts` 写明两个主机，不写通配；代码里没有写死的主机名或端口 |
| 4 | 只读课表 | **过**。三条请求全部落在 `/jwglxt/kbcx/*`（课表页、课表接口、周次校历），不碰成绩、学籍、个人信息、缴费。课表响应里夹带的学生信息一律不带出 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，也没有图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`） |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的值。取课表首页用的是 `fetch` + `DOMParser`，离线解析，不插入当前页面，不改表单，不触发提交或点击 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。脚本里的常量只有 `/jwglxt`、两个菜单号 `N2151` / `N2154`，都是页面上可见的参数 |

## 4. 与模板 hueb 的差异（模板目录只读，本件未改动）

1. **不请求节次时间，节次时间固定 12 节**：模板有 `cxRjc` 请求、`periodTimesOf` 校验、`timeOf`、空课默认 12 节表 `BUILTIN_PERIOD_TIMES` 与 13 节上游表两套。本件只保留上游 12 节（`parse.js` 第 52 行起 `SCHOOL_PERIOD_TIMES`），删掉其余三者。
   `BUILTIN_PERIOD_TIMES` 的 12 节与本校不同（例如第 2 节 08:55，本校是 09:15），若按模板的 H3 口径「同号能接上就用它」，会在第 1–12 节之外混进另一套时间；本件 12 节即全部，13 节起一律顺推。
2. **不在统一认证页 / WebVPN 首页上发请求**：模板 `jwBase()` 在没有 `/jwglxt` 时退回 `origin + /jwglxt`，在 `ids` / `webvpn` 根上必然失败。本件 `jwBase()` 返回 null，`extract.js` 第 232–234 行直接报「请先登录并进入教务系统…」。路径含 `lyuapServer/login` 或 `login_slogin.html` 时报「请先登录」（`onLoginPage`，第 52 行）。
3. **WebVPN 前缀**：`jwBase()` 取当前路径里 `/jwglxt/` 为止的那一段，`/https/jw.gzist.edu.cn` 前缀原样保留（第 59 行）。
4. **登录失效识别前移**：课表响应先过 `/login_slogin|name=["']yhm["']/` 判断（第 182 行），命中就报「登录状态已失效」；模板是先解析 JSON，失败才报通用错误。
5. **不用原型方法**：模板 `textOf` / `readSelect` 用了 `.trim()`，`readSelect` 还用了 `querySelectorAll` 的回调；本件改为 `asText` / `squeeze`（正则去首尾空白，`extract.js` 第 66–73 行）和普通 for 循环（`readSelect`、`pickFields`、`totalOf`）。
6. **字段白名单不含 `xqh_id`**：模板白名单 7 个字段，本件 6 个（见 §2）。
7. **学期名兜底**：「广州理工学院 第 X 学期」（`parse.js` 的 `SCHOOL_NAME`），不用适配器名。
8. **warnings 文本**：节次时间那一条改成「没有从教务系统取，已按本校固定的 12 节时间导入」；H3 补时间那一条去掉「空课默认的节次时间」。
9. **校历请求改为顺序发**（见 §1），不影响结果。
10. **周次解析、合并、开学日、总周数、H3 顺推、warnings 收口、字段计数**与模板 hueb 一致（移植手册 §4、批次八 / 九 / 十 的统一修正）。

## 5. 上游里删掉 / 改掉的东西及理由

1. **节次时间不取教务接口，固定 12 节**：上游 `TimeSlots` 写死 12 节且明确不用教务作息接口（上游注释的理由是行政口径与学校作息不符）。本件照上游，不发 `cxRjc`。
   这是任务卡的明确要求（`gzist` 不请求 `cxRjc`）。
2. **删掉弹窗选学年学期**：上游 `selectAcademicYearAndSemester` 里的两个 `showSingleSelection`（选学年、选学期）改成读页面上的 `#xnm` / `#xqm`（移植手册 §3 第 1 步）。
3. **删掉桥调用**：`showAlert` / `showSingleSelection` / `saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion`。空课由宿主负责保存，适配器只交载荷。
4. **整行丢课改为计数**：上游 `parseJsonData` 要求 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` 六个字段全非空，缺教师或缺教室的课整行丢掉。本件只要求课名、星期、节次、周次；教师与教室没有就留 `null`，缺的课按课名去重计数、点名最多 3 门写进 `warnings`（`fixtures/long-warnings`、`fixtures/basic` 钉住）。
5. **周次解析修正**：上游 `parseWeeks` 只认 `/(\d+)-(\d+)周/` 一类写法，`1-16(单周)` 认不出、整段周次塌成空数组；括号里的教学班序号 `(1)` 会被当成周次。本件在 `weeksOf` 里认四种单双写法，先摘括号序号再找周次，摘掉的计数写进 `warnings`。
   上游「共 N …到行尾」的剥离**没有照搬**：改为 `/共\s*[0-9]+\s*周?/g`，只剥备注本身（公共说明里的坑）。
6. **节次解析放宽**：上游 `jcs.split('-')` 认不出 `第9-10节`、`1,2`、两位一拼的 `0102`。本件 `sectionsOf` 认这些写法，多段按最大跨度放入并在 `warnings` 里说明。
7. **开学日**：上游 `fetchSemesterStartDate` 把 `rq.split('/')[0]` 原样当开学日，找不到第 1 周时拿 `json[0]` 顶替。本件用 `isoOfAny` 认多种日期写法，回退到那一周的周一，并检查日期是否落在本学期合理窗口内（`plausibleStart`），可疑就忽略并推算。
8. **总周数**：上游写死 `semesterTotalWeeks: 20`。本件优先用校历，课表里更晚的周次会把总周数抬上去，抬了都写进 `warnings`。
9. **主机不写死**：上游两套常量地址改成由 `window.location` 拼同源地址（§1）。
10. **学生信息**：上游把整个课表响应交给自己的解析函数（不外发）；本件按字段白名单挑，`xsxx` 等一律不交出去。
11. **集中实践课**：上游没有处理 `sjkList`，本件只带课名，写进 `warnings`，不静默丢弃。

## 6. 变异测试与桩跑记录

### 6.1 变异测试

变异改的是**临时副本**（`C:/Users/23703/AppData/Local/Temp/gzist-port10/mut/<编号>/gzist/`，目录名同样是 `gzist`，否则 check.js 会因 `manifest.key` 与目录名不一致报错），只替换副本的 `parse.js`，真文件没有被变异脚本写过。每条替换要求恰好命中 1 次。每个副本都跑 `check.js`，记录哪些 fixture 变红。变异副本已删除。

| 变异 | 改了什么（真文件） | 变红的 fixture | 变红的表现 |
|---|---|---|---|
| M1 | `weeksOf` 里 `(单)1` / `(双)9` 前缀归属正则的前瞻改成 `(?=[X])`，永不匹配 | `week-markers` | 前缀写法 `(单)1-8周,(双)9-16周` 退回通用括号处理，单双归属错位 |
| M2 | `weeksOf` 里「共 N 周」剥离改回 `/共.*$/g`（从「共」一路删到行尾） | `week-markers` | `1-8周(共8周),9-16周` 的 9–16 周与 `共16周,1-15周(单)` 的整行被一起吞掉 |
| M3 | `EXTEND_BREAK_MINUTES` 5 → 15 | `basic` | 第 13 节顺推时间从 21:45–22:30 变成 21:55–22:40 |
| M4 | `NAME_TEXT_LIMIT` 20 → 200（课名不截断） | `long-warnings` | 点名的长课名不再截到 20 字，提醒超出期望 |
| M5 | 缺教师 / 缺教室汇总提醒整段改成 `if (false)` | `basic`、`long-warnings` | 课照常导入，但提醒少了「没给上课教师 / 地点」那一条 |
| M6 | 内置表第 9 节开始 `18:40` → `18:30` | `basic`、`boundary-periods`、`week-markers`、`calendar-weekday`、`no-calendar-overweek`、`long-warnings`、`merge-dedupe` | 全部节次时间的期望对不上（逐节照抄被改坏会全线变红） |
| M7 | 完全重复行去重 `dropExactDuplicates(entries)` 改成不去重 | `merge-dedupe` | 同一行被重复计入，线性代数 1–2 节 + 3–4 节合并错位 |

**还原校验**：变异前后真文件内容一致（脚本运行前后比对 `parse.js` 全文相同）；真文件跑 check.js 结果见 §7。

### 6.2 extract.js 桩跑（Node，不联网）

桩脚本是临时文件，跑完已按公共说明删除（未入库），下表即运行结果。桩 window 的 `location` 与 `document`，桩 `fetch` 按 URL 路由并记录每一条请求（方法、地址、请求体），
桩 `DOMParser` 用正则解析桩页面里的两个 `<select>`。

| 场景 | 地址（`window.location`） | 页面 | 拼出的请求（方法 + 地址 + 请求体） | 结果 |
|---|---|---|---|---|
| S1 直连，页面上已有下拉框 | `http://jw.gzist.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?...` | 有 `#xnm` / `#xqm`（2026 / 第一学期被 selected） | POST `http://jw.gzist.edu.cn/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` 体 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=`；POST `…/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` 体 `xnm=2026&xqm=3` | 成功，不发 GET 首页 |
| S2 直连，页面没有下拉框 | 同上 | 无下拉框 | GET `http://jw.gzist.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`，再发 S1 的两条 POST | 成功，学期从首页读出 |
| S3 WebVPN 前缀 | `https://webvpn.gzist.edu.cn/https/jw.gzist.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?...` | 有下拉框 | POST `https://webvpn.gzist.edu.cn/https/jw.gzist.edu.cn/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`；POST `https://webvpn.gzist.edu.cn/https/jw.gzist.edu.cn/jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`（前缀保留） | 成功 |
| S4 直连，页面无下拉框，**原型被改坏**（filter 回调拿下标、trim 删内部空白、map / forEach 直接抛错） | 同 S2 | 无下拉框 | 与 S2 完全相同 | 输出与 S2 **逐字一致** |
| S5 直连，**原型被改坏**，页面有下拉框 | 同 S1 | 有下拉框 | 与 S1 完全相同 | 输出与 S1 **逐字一致** |
| S6 课表接口 200 + 含 `name="yhm"` 的登录页 | 直连 | 有下拉框 | 只发课表 POST | 报「登录状态已失效，请重新登录教务系统后再点「提取课表」」 |
| S7 课表接口 200 + 含 `login_slogin` 的片段 | 直连 | 有下拉框 | 只发课表 POST | 同 S6 |
| S8 统一认证页 `https://ids.gzist.edu.cn/lyuapServer/login?...` | ids 主机 | 无下拉框 | **不发请求** | 报「当前打开的是登录页，请先登录…」 |
| S9 WebVPN 首页 `https://webvpn.gzist.edu.cn/` | webvpn 根 | 无下拉框 | **不发请求** | 报「请先登录并进入教务系统，打开「学生课表查询」后再点「提取课表」」 |
| S10 校历接口 500 | 直连 | 有下拉框 | 课表 POST + 校历 POST（失败） | 成功，`calendar` 为 `null` |

检查项（同一轮运行）：

- 全部场景的请求清单中含 `cxRjc` 的次数：**0**。
- 输出里出现学号 `2024001234`、人员 ID `ID-SECRET-001`、手机号 `13800000000`、`xsxx` 字样、学院名 `计算机学院`：**0 次**（桩响应里都混进了这些字段）。
- 输出里出现 `periodTimes` 字段：**0 次**（extract.js 不交节次时间）。

## 7. fixtures 与自检

7 对合成用例（课程、教师、教室均为虚构；学期与日期为合成值；无真实姓名、学号）。期望值按规范与代码逻辑手工推演，写进 expected 后再跑自检比对，**没有**把 parse.js 的输出直接存成 expected。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 周次写法（`周数：1-16周`、`1-8周、10-16周`、`1-15周（单）`、`2-16单周`）；校历第 1 周 `2026-09-07/2026-09-13` → 开学日 2026-09-07；内置 12 节逐节钉住（第 9 节 18:40–19:20、第 10 节 19:20–20:00、第 12 节 21:00–21:40）；排到第 13 节 → H3 顺推 21:45–22:30；缺教师、缺教室照常导入；集中实践课；完全重复行只留一条 |
| `boundary-periods` | 节次写法（`第9-10节`、`0102`、`11-12节`、`1,2`、`1-2,5-6` 多段提醒）；同课 9-10 与 11-12 相接合并成 9-12；第二学期无校历 → 推算 2026-02-16；`total` 写 12 条实际 7 行 → 对账提醒；第 12 节边界 |
| `week-markers` | 单双标记归属与「共 N 周」剥离：`(单)1-8周,(双)9-16周` 与 `1-8周(单),9-16周(双)` 都读成单周 1–7 + 双周 10–16；`1-16(单周)`；`1-15周（单）共16周`；`1-8周(共8周),9-16周`（9–16 不丢）；`共16周,1-15周(单)`（不整行丢）；`(1)` 教学班序号；`1-4；6-8`；`1-8周(实验)` 备注；`2-16单周`；校历 `zs` 为字符串、第 18 周用 `rq` 斜杠段 |
| `calendar-weekday` | 校历第 1 周给周三（`zcrq` 带时分秒）→ 开学日回退到周一 2026-09-07；同名不同教师的两门课各自成课；校历 20 周 |
| `no-calendar-overweek` | 无校历、第三学期 → 夏季学期推算 2026-06-29；课表最大第 22 周 → 总周数抬到 22 并说明；`1-6周,31周` 丢掉 31 周并提醒；`第一到十六周`、`待定`、`另行安排` 三行认不出，跳过并点名写法 |
| `long-warnings` | **专门覆盖「带课名的提醒不超 200 字」**：两门超 20 字的课名分别缺教师、缺教室，体育两项都缺；四门超长集中实践课只点名前三门；三行认不出的周次；课名统一截到 20 字（`shortName`），每条经同一个 `warn()` 出口 |
| `merge-dedupe` | 同课 1–2 与 3–4（同周）相接合成 1–4；完全重复的行（两处）只留一条；同节次不同周次不合并；同节次两个周次段取并集 1–16 |

自检：`node .test/port-batch5/tools/check.js D:/NullClass/jw-adapters/gzist`，7 个 fixture 全部 MATCH，最后一行 `RESULT: PASS`（运行结果见本次交付报告）。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **真实部署未验证**：广州理工学院教务是否开放 `xskbcx_cxXskbcxIndex` / `xskbcx_cxXsgrkb` / `xskbcxZccx_cxZcByXnxq` 这三个接口、返回形状是否与 fixture 一致，没有账号无法验证。fixture 是合成的，只保证同样的输入永远得到同样的输出，**不保证解析在真实页面上是对的**。拿到真实响应后替换 fixture 并重跑 check.js，是最高优先级。
2. **节次时间与学校实际不符的风险**：12 节逐节照抄上游，上游注释与表本身也不完全一致（§0 第 1 条）。导入时 `warnings` 会说明「节次时间没有从教务系统取，已按本校固定的 12 节时间导入」，并请用户核对。
3. **统一认证直连教务**：`jw.gzist.edu.cn` 直连能否用统一认证登录态（上游 `import_url` 带 `/sso/lyiotlogin`）访问课表页，没有账号无法验证。若不行，用户需要走 WebVPN 入口（`webvpn.gzist.edu.cn/https/jw.gzist.edu.cn/...`），脚本两种都支持。
4. **`loginUrl` 不在 `allowHosts` 里**：`loginUrl` 指向 `ids.gzist.edu.cn`，它是用户登录用的统一认证主机，脚本不请求它；`allowHosts` 只放行脚本真正请求的两个教务主机。
5. **「页面覆盖原型方法」只是上游注释的说法**：没有真机核实这两个方法是否真被改写。本件的 extract.js 不依赖它们（§6.2 S4 / S5 已按注释描述改坏后验证），即使真不存在这种改写也不影响结果。
6. **学期代号认法**：`termKind` 优先看下拉框文本里的「一 / 二 / 三」，认不出再看代号（`3` 第一、`12` 第二、`16` 第三）。若本校代号不同，文本认法仍然生效，但学期名与开学日推算依赖它。
7. **校历日期字段**：本件按 `rq` 首段（`2026-09-07/2026-09-13`）、`zrq` / `zcrq` / `ksrq` 认日期，没有见过真实响应。`rq` 首段不是周一时会回退到那一周的周一。
8. **上游没有的字段**：`qsxqj`（教务给的每周起始日，1=周一）任务卡未点名，本件未交出，parse.js 也未读取（按公共说明：没点名的件不用管）。
9. **记录总数对账**：正方这个接口一般一次返回整学期，本件只在响应里带了总数时才对账（`total` 字段）。

## 9. 签名

移植与审计：0x7E7-2023（haiku 移植，2026-10-20）。
上游出处：`shiguang_warehouse` → `resources/GZIST/gzist_01.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取；本校脚本最后修改 `ccd43dd`，2026-10-14，MIT，作者 YT-O5）。

## 审计修正（2026-10-20）

- **周次前缀标记误吞上一段的后缀**：`parse.js` 的 `weeksOf` 里，前缀写法的正则 `(单)1` 没排除标记前面紧挨着上一段（数字或「周」）的情况，
  把上一段的后缀 (单)/(双) 当成下一段的前缀：`1-8周(单) 9-16周(双)` 被读成 1-16 每周；`1-8周(单)9-16周` 被读成 1-15 单周，9-16 周的双周丢了；
  `1-16周(单) 17-18周` 被读成 1-17 单周，第 18 周丢了。
- 修正：标记前面紧挨着数字或「周」（中间可有空白）时按后缀归给前一段，只有在段首（字符串开头或分隔符之后）才当后一段的前缀；
  后缀后面直接跟着下一段数字时补一个逗号隔开。`(单)1-8周,(双)9-16周`、`1-8周(单),9-16周(双)`、`1-15周(单) 共16周` 等原有写法行为不变。
- 新增 fixture `week-adjacent`（三个反例；期望值按周次集合手推：1-7 单 + 10-16 双；1-7 单 + 9-16 每周，合并为 1-9 单 + 10-16 每周；1-15 单 + 17-18 每周，合并为 1-17 单 + 18 每周）。版本号 1.0.0 → 1.0.1。
- 已知取舍：`(单)1-8周 (双)9-16周`（前缀写法、段间只有空格）里的 `(双)` 前面紧挨「周」，按上述规则会被当作前一段的后缀；与后缀写法 `1-8周(单) 9-16周(双)` 在形态上无法区分，未见真实样本，按上述规则取后缀。
