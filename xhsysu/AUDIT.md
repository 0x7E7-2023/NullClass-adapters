# 安全审计 —— 广州新华学院（正方教务 V9，根路径部署，统一认证 CAS 登录）

审计对象：`jw-adapters/xhsysu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `XHSYSU/xhsysu.js`（253 行；快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，2026-10-20 复核仍是最新；
MIT，作者 Haooz；本校目录最后一次修改 `58bff0b`，用 `git log -1 -- resources/XHSYSU/xhsysu.js` 核对过，与任务卡一致）。

审计方式：逐行读上游脚本与同目录 `adapters.yaml`（`adapter_name` 广州新华学院教务，`maintainer` Haooz，`description` 写明「正方教务系统(V9)」「非本校开发者，如有误请提交 issues」，
`import_url` `https://xhcas.xhsysu.edu.cn/lyuapServer/login?service=https%3A%2F%2Fjw.xhsysu.edu.cn%2Fsso%2Flyiotlogin`，与任务卡一致）；
再逐函数对照模板；移植手册 §5 八条逐条；静态扫描；extract.js 在 Playwright 的 Chromium 里对着假教务站实跑 17 个场景（不联网）。

静态扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js`、`parse.js` 代码里没有任何绝对地址；两个文件头注释里各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`（注释）。
  `manifest.json` 的 `loginUrl` / `scheduleUrlHint` / `homepage` 是给宿主看的声明，不是请求。
- 网络调用：只有 `extract.js` 的 `request()` 里一处 `fetch(url, options)`（`X-Requested-With` 是请求头字符串，不是 XHR 对象）。`parse.js` 没有任何网络调用、没有 `document.` / `window.`。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` / `sendBeacon` / `WebSocket` / `new Image` /
  `innerHTML` / `appendChild` / `.submit` / `setAttribute` 全部无命中。
- 原型方法：`extract.js` 代码里不调用 `.filter(` / `.trim(` / `.map(` / `.forEach(`（grep 只在注释里提到名字）；`parse.js` 的 `text()` 用了 `.trim()`，它只在 Rhino / 宿主解析环境里跑，不在教务页面里。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class`、`async`、`await`、展开符、可选链、`??`、`padStart`、`Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(`
  全部无命中（`check.js` 同口径通过）。控制字节与 BOM：无。
- 模板残留：检索「广州理工」「gzist」「YT-O5」「ids.」「jwglxt」「西南林」「swfu」，代码与 manifest 零命中（仅 `parse.js` 文件头有意写「模板 gzist」「swfu」）。
- 个人信息：`fixtures/` 全部为合成数据（甲 / 乙 / 丙…老师，教学楼 / 综合楼等虚构地点），没有真实姓名与学号。

## 0. 上游情况（任务卡之外自己读出来的）

- **平台**：正方教务 V9（新版 jwglxt 的菜单号体系），但**部署在根路径**，没有 `/jwglxt` 上下文：上游所有请求都是 `/kbcx/…`（不是 `/jwglxt/kbcx/…`）。统一认证用联奕 `lyuapServer`
  （`xhcas.xhsysu.edu.cn/lyuapServer/login` → `jw.xhsysu.edu.cn/sso/lyiotlogin`），与已审计的 `gzist` 同一套登录体系。
- **上游全文只有 3 个请求**（`apiUrl()` 只在路径前加 `window.location.origin` 与可选的 `/http/<十六进制>` 前缀）：课表首页 GET（读 `#xnm` / `#xqm`）、课表 POST、校历 POST。
  没有 `qsxqj`、没有节次时间接口（`cxRjc`）、没有备用接口、没有菜单号回落、没有提问桥。
- **上游课表请求体**是 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`（没有 `kclxdm=`，与 `swfu` 的上游不同）；课表首页 GET 不带 `layout=default`。本件逐字照上游。
- **上游节次时间**：`XHSYSU_TIME_SLOTS` 写死 14 节、每节 40 分钟、08:20 起，注释写「来源：教务处『上课时间段一览表』」。上游不请求教务的节次时间。
- **上游 `parseWeeks` 的四个坑**（代码，不是注释）：
  ① 整串文字里只要出现「单」，整串所有区间都只留单周；出现「双」同理。「(单)1-8周,(双)9-16周」两个都出现，单周被「双」排除、双周被「单」排除，整段周次是空数组，这门课被 `if (!weeks.length) continue` 静默丢掉；
  「1-8周,10-16周(单)」会把前一段 1-8 周也变成单周。
  ② 只按半角逗号切段：「2，4，6周」（全角逗号）整段被 `Number("2，4，6")` 读成 NaN，周次为空，这行课被静默丢掉。
  ③ 不认「~」「至」「到」的区间写法（「1~16周」整段 `Number` 失败，周次为空，同样被丢）；「共 N 周」备注倒是被 `Number` 失败跳过，没有副作用。
  ④ 括号里的教学班序号「(1)」会被当成第 1 周。
  本件换成 `weeksOf`（§4 第 1 条）。
- **上游的「未排地点」**：`cdmc === "未排地点"` 时置空串（注释：「不是真实教室」）。本件照办：当作没有教室，计入缺教室汇总提醒。
- **上游丢行条件**：`!c.kcmc || !c.xqj || !c.jcs || !c.zcd` 整行静默 `continue`；`jcs` 只认「a-b」（`split('-')`）；缺教师 / 教室填空串。
- **上游总周数** = `Math.max(校历数组长度, 课表最大周次)`；开学日 = 校历 `zs=1`（找不到则第一行）的 `rq.split("/")[0]`，不回退到周一；拿不到校历就整个跳过学期配置，让用户手动设。
- **上游登录页判断** `isLoginPage()`：`href` 含 `lyuapServer/login`，或路径以 `/sso/lyiotlogin` 结尾；命中就弹「请先登录」。

## 1. 请求域与请求清单（与代码逐条对应）

地址 = `window.location.origin` + 路径前缀 + `/kbcx/<页面>?gnmkdm=<菜单号>`。路径前缀（`extract.js` 的 `prefixOf`）= 当前路径里**最早出现的 `/kbcx/` 或 `/xtgl/` 之前**的那一段：
校内直连为空；经学校 WebVPN 打开时是 `/http/<十六进制>`（上游也保留这一段）。当前路径里一个都没有（学校门户、WebVPN 首页）时返回 `null`，直接抛错、**不发任何请求**。
主机一律是用户当前打开的那个页面的主机（正常是 `jw.xhsysu.edu.cn`），代码里没有写死的主机名或端口。

| # | 谁 | 方法 | 地址 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|---|
| 1 | `currentTerm` | GET | `<前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151`（与上游一致，不带 `layout=default`） | 无 | 读 `#xnm` / `#xqm` 下拉框（`DOMParser` 离线解析）。**页面上已有这两个下拉框时跳过** | 抛「没读到学年学期…」 |
| 2 | `fetchTimetable` | POST | `<前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`（与上游逐字一致） | 取整学期课表 JSON：`kbList`、`sjkList`、`qsxqj`、可能有的记录总数 | 非 2xx 抛「教务系统返回错误（代码 N）」；网络错误抛「连不上教务系统」；200 但内容含 `login_slogin` / `lyuapServer` / `name="yhm"`（会话过期回登录页）抛「登录状态已失效」；不是带 `kbList` 数组的 JSON 抛「没有返回课表数据」 |
| 3 | `optionalJson` | POST | `<前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | `xnm=…&xqm=…`（与上游一致） | 取学期周次校历（第 1 周日期、周数） | 任何失败或非 JSON → `null`，parse.js 推算开学日并写 warnings |

- 请求头统一为 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: */*`，全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。
  上游课表请求只带 `Content-Type`，校历请求才带 `X-Requested-With`；统一后多的头都是标准头，不带任何自定义令牌。
- 校历请求在课表成功之后才发（上游是并行）：课表失败时少一次无意义请求；校历失败不影响导入。
- **没有第四条请求**：不请求节次时间接口（`cxRjc`）。上游只有写死的 14 节表，按公共说明「只有写死表的就用写死表」。冒烟里所有场景都检查了请求清单里没有 `cxRjc`。
- 登录页 / 登录后的跳转页 / 门户页 / WebVPN 首页：**不发请求**，直接给大白话提示（§6 场景）。
- `allowHosts` = `["jw.xhsysu.edu.cn"]`（不写通配）：`loginUrl` 在统一认证主机 `xhcas.xhsysu.edu.cn` 上，教务主机 `jw.xhsysu.edu.cn` 与它不同源，所以单列；脚本本身不请求认证主机。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期 `term.xnm` / `xqm` / `xnmText` / `xqmText` | 页面的 `#xnm` / `#xqm`，或课表首页 HTML（`DOMParser`，不插入当前页面） | 带出（学期名、学期序号要用） |
| 排课行 `raw.kbList[]` | 课表响应 `kbList` | **白名单六个字段**：`kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd`（`KB_FIELDS`）。其余字段（`xsxx` 学生信息、学号、人员 ID、手机号、`xqmc`、`cxbjmc` 等）一律不带 |
| 集中实践课 `raw.sjkList[]` | 课表响应 `sjkList` | 只带 `kcmc`（`PRACTICE_FIELDS`），只用于提醒里点名 |
| `qsxqj` | 课表响应顶层，缺失交 `null` | 每周起始日（1=周一…7=周日）；上游不读，见 §4 第 4 条 |
| `total` | 课表响应里 `total` / `totalResult` / `totalCount` / `count` 之一，取不到 `null` | 只用于与行数对账 |
| `calendar` | 校历响应原样，取不到 `null` | parse.js 取第 1 周日期与周数；校历每行只是周次与日期，不含个人信息 |
| `today` | 本地日期 | 只在学年读不出来时的兜底分支用 |

`parse.js` 实际读的字段：`term.*`、`today`、`qsxqj`、`raw.kbList[].{kcmc,xm,cdmc,xqj,jcs,zcd}`、`raw.sjkList[].kcmc`、`total`、`calendar[].{zs,zsmc,zrq,zcrq,rq,ksrq}`。
不读的东西：成绩（`/cjcx/*`）、学籍、个人信息、缴费，以及任何其它模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问，也不读 Cookie（会话由浏览器自带）。统一认证全程由用户在 WebView 里手工完成。上游的开场弹窗（`showAlert`）、学年 / 学期选择框（`showSingleSelection`）、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 全部未移植 |
| 2 | 不外发 | **过**。唯一的 `fetch` 在 `extract.js` 的 `request`，地址全部由当前页面的 origin 加前缀拼成同源地址。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，也没有第三方域 |
| 3 | 请求域可控 | **过**。只访问用户当前打开的教务页面所在主机；`allowHosts` 只写 `jw.xhsysu.edu.cn`，不写通配；代码里没有写死的主机名或端口 |
| 4 | 只读课表 | **过**。三条请求全部落在 `/kbcx/*`（课表首页、课表、周次校历），不碰成绩、学籍、缴费。课表响应里夹带的学生信息不带出，白名单之外的字段全部丢弃 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`，失败返回 `null`） |
| 7 | 不写页面 | **过**。读页面下拉框只用 `querySelector` / `options`，不改 DOM、不提交表单、不点击。取课表首页用 `fetch` + `DOMParser` 离线解析，不插入当前页面 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有菜单号 `N2151` / `N2154`（页面上可见的参数）和判断登录页用的路径片段 |

## 4. 与模板的差异

**模板选择**：以批次十已审计的 `gzist`（广州理工学院）为底，周次与每周起始日的两处修正取自批次十一的 `swfu`。理由：
① 同一套联奕 `lyuapServer` 统一认证（登录页判断、`/sso/lyiotlogin` 跳转同形）；
② 同样「上游只有写死的节次表、不请求教务的节次时间」，`gzist` 已经是「只用内置表 + H3 顺推」的形状（不带 `cxRjc`、`periodTimesOf`、第二张默认表）；
③ 同样的 3 个请求，请求体都没有 `kclxdm=`；`gzist` 已含提醒限长、缺教师 / 教室汇总、`week-adjacent` 修正。
未选 `swfu`（同作者、同款流程）作底：它多一个可选的 `cxRjc` 请求与第二张默认表，要删的比要补的多；但 `gzist` 的 `weeksOf` 少一行「区间终点前的『第』」归一（`第1-第8周` 会被读成第 1、8 两周，批次十 `swu` 的坑）、
也没有每周起始日，这两处照 `swfu` 补上。

差异逐条：

1. **周次解析**（`weeksOf`）：标记按位置归属到各自那一段，上游接受的写法全接住（见 §0 的四个坑）：「(单)1-8周,(双)9-16周」「1-8周(单) 9-16周(双)」「1-8周,10-16周(单)」「第1-第8周」「2，4，6周」「1至8周」「1~16周」等。
   「共 N 周」只剥备注本身（`/共\s*[0-9]+\s*周?/g`），不写成「删到行尾」；括号里的教学班序号摘掉并计数、含非周次字的括号备注摘掉并计数。
2. **根路径部署，没有 `/jwglxt`**：`prefixOf` 取 `/kbcx/` 或 `/xtgl/` 之前的路径作前缀（模板 `gzist` 是取 `/jwglxt` 为止；这一点参照根路径部署的 `gdust`），不带 `layout=default`、不带 `kclxdm=`，与上游一致。
3. **登录页判断**：沿用上游的 `lyuapServer/login` 与 `/sso/lyiotlogin`，另加正方自己的 `login_slogin.html`；命中都不发请求（上游命中也只是弹提示）。
   会话过期识别在 `gzist` 的 `login_slogin` / `name="yhm"` 之外再加 `lyuapServer`（统一认证的跳转页）。
4. **每周起始日 `qsxqj`**（上游没有）：extract.js 原样交出，parse.js 的 `weekdayOf` / `weekStartOf` 按移植手册 §4.3 把开学日回退到那一天（缺省或不合法按周一），推算开学日的锚点同理。回退时在提醒里说明。
   `gzist` 只回退到周一；`swfu` 同款。若本校响应里没有 `qsxqj`，按周一处理，行为与上游相同。
5. **节次时间**：14 节表（`SCHOOL_PERIOD_TIMES`）逐节照抄上游；课表用到第 15 节及以后时，在上一节下课后顺推（课间 5 分钟、每节 45 分钟），顺推越过 23:59 如实说明（统一修订 H3）。每次导入都有一条提醒说明节次时间是学校公布的而不是从教务读的。
6. **「未排地点」**：教室等于它（trim 后）时当作没有教室（`location` 为 `null`），按缺教室汇总（`no-room`、`long-warnings` 钉住）。
7. **学校名 / 学期名兜底**：「广州新华学院 第 X 学期」；学期文本是正方的「1 / 2 / 3」写法时按学期代号（3 / 12 / 16）认学期序号（`basic` 用的就是文本「1」）。
8. **同课合并**：上游有 `mergeAndDistinctCourses`（两阶段），本件的两阶段与它同语义，前面多一步完全重复行去重（上游只跟当前合并中的那条比，合并之后才出现的重复会漏掉）。
9. **集中实践课**（`sjkList`）：上游不处理，这里只带课名，提醒里点名，不静默吞掉。
10. **字段白名单**：六个字段（模板 `swfu` 是七个，含 `xqh_id`，用来拼节次时间请求；本件不请求，不带）。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart`（开场 `showAlert`） | 删 | 桥能力，宿主负责交互；提示改由 extract.js 的报错承担 |
| `selectAcademicYearAndSemester` / `fetchAcademicOptions`（两个 `showSingleSelection`，学年只取选中项前后各 2 项） | 删，改为读页面 `#xnm` / `#xqm`（`selected` 项优先，没有取第一项） | 公共说明第 2 条：不弹窗；要别的学期，用户在教务页切换后再点「提取课表」 |
| `saveCourses` / `saveConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` / `console.error` | 删，载荷交给宿主 | 空课由宿主保存；开学日、总周数、节次时间随载荷的 `terms[0]` 交出 |
| `parseWeeks`（全局单/双标记、只认半角逗号、不认 `~` `至`） | 换成 `weeksOf` | 见 §0 四个坑；上游接受的写法都接得住 |
| `parseJsonData` 缺 `kcmc` / `xqj` / `jcs` / `zcd` 的行静默 `continue`；`jcs` 只认 `a-b`；`startSection > endSection` 的行静默丢 | 分类计数写进 warnings；节次放宽到「第9-10节」「1,2」「0102」，多段按最大跨度放入并说明 | 公共说明第 6 条：不许静默丢课 |
| `teacher` / `position` 缺失填空串 | `null` | 手册 §4.7，不许写「未知」 |
| `cdmc === "未排地点"` 置空 | 同样置空（`null`），并计入缺教室汇总 | 上游已有的处理，保留并补上提醒 |
| `fetchSemesterWeeks` 找不到 `zs=1` 时拿 `json[0]` 顶替 | 不顶替，改为推算并说明 | 顶替会让开学日悄悄错一周；`calendar-no-week1` 钉住 |
| 开学日 = `rq` 前半，不回退 | 回退到每周起始日（`qsxqj`，缺省周一） | 手册 §4.3；校历里的日期本来就是周起始日时结果相同 |
| 总周数 = `max(校历数组长度, 课表最大周次)` | `max(校历里最大的周次号, 课表最大周次)`，抬高时说明；校历取不到按 20 周并说明 | 完整校历（每周一行）两者相同；缺行时取最大周次号更稳；上游此时跳过学期配置，载荷必须带开学日与周数，所以推算并写 warnings |
| 校历取不到就让用户手动设开学日 | 按学期序号推算（第一学期 9 月 1 日所在周、第二学期 2 月 20 日所在周、夏季 7 月 1 日所在周的第一天）并写 warnings | 载荷必须带开学日；推算值在提醒里明说 |
| 14 节表通过 `savePresetTimeSlots` 存 | 随载荷 `periodTimes` 交出，用到第 15 节以后顺推 | 统一修订 H3 |
| `apiUrl()` 的 `^\/http\/[0-9a-f]+` 前缀 | `prefixOf()`（`/kbcx/` 或 `/xtgl/` 之前的路径） | 上游前缀正则的超集：WebVPN 下结果相同，另外在门户页 / 认证页上返回 `null` 不发请求（上游在这些页面也会发请求，必然失败） |
| 课表响应整体交给解析函数（不外发） | 按字段白名单挑 | 学生信息不进载荷 |
| `Set` / 展开符 / 箭头函数 / 模板串 / `async` | ES5 重写 | CI 的 Rhino 解释模式口径 |

## 6. 变异测试与冒烟记录

### 6.1 变异测试

在 `C:/Users/23703/AppData/Local/Temp/xhsysu-port13/mut/<编号>/xhsysu/` 下做了十二份副本（目录名同样是 `xhsysu`，否则 check.js 会因 `manifest.key` 与目录名不一致报错），
每份只替换副本的 `parse.js` 里一处（替换要求恰好命中 1 次），各跑一次 `check.js`。真实的 `parse.js` 未被改动，之后再跑自检通过；副本已删除。

| 编号 | 改坏哪一处 | 变红的用例 |
|---|---|---|
| m1 | `NO_ROOM_TEXT`（「未排地点」）改成不会命中的字符串 | `no-room`、`long-warnings` |
| m2 | 14 节表第 12 节开始 `19:00` 改成 `18:00` | 所有带节次时间的用例（10 对全红） |
| m3 | 去掉区间终点前「第」的归一（`第1-第8周`） | `basic`：机械制图的周次不对 |
| m4 | `weekdayOf` 恒返回 1（每周起始日不生效） | `calendar-sunday`：开学日期望 2026-08-30 |
| m5 | 前缀 `(单)1` / `(双)9` 归属的前瞻改成永不匹配 | `week-markers` |
| m6 | 「共 N 周」剥离改成 `/共.*$/`（同族适配器上游的常见写法，从「共」删到行尾） | `week-markers`：`1-8周(共8周),9-16周` 的 9-16 周被吞 |
| m7 | `EXTEND_BREAK_MINUTES` 5 改成 15 | `boundary-periods`：第 15-16 节顺推时间错 |
| m8 | 关掉 `dropExactDuplicates` | `merge-dedupe` |
| m9 | `NAME_TEXT_LIMIT` 20 改成 200（课名不截断） | `long-warnings` |
| m10 | 14 节表删掉第 14 节 | 所有带节次时间的用例（10 对全红） |
| m11 | 校历缺第 1 周时拿第一行顶替（上游写法） | `calendar-no-week1` |
| m12 | 去掉「标记前面紧挨数字或『周』则归上一段后缀」的判断 | `week-adjacent` |

十二处全部被对应用例抓住，还原后 `check.js` 通过。

### 6.2 浏览器冒烟（`D:/NullClass/.test/port-batch13/xhsysu/smoke.py`）

Playwright 起 Chromium，所有请求被 `route` 拦下（假教务站，不联网），跑真实 `extract.js`，再用 Rhino 跑 `parse.js`。17 个场景全部 OK：

| 场景 | 页面 | 结果 |
|---|---|---|
| `xhsysu` | `https://jw.xhsysu.edu.cn/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`（页面上有下拉框） | 不发 GET 首页；只发 `POST /kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`（体 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=`）与 `POST /kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`（体 `xnm=2026&xqm=3`）；路径里没有 `/jwglxt`，没有 `cxRjc`；POST 带 `X-Requested-With` 与表单 `Content-Type` |
| `xhsysu-menu` | `/xtgl/index_initMenu.html?jsdm=xs`（无下拉框） | 先 `GET /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151`（与上游一致，无 `layout=default`），再发上面两条 POST |
| `xhsysu-webvpn` | `https://gateway.test/http/<hex>/kbcx/…` | 每条请求都保留 `/http/<hex>` 前缀 |
| `xhsysu-webvpn-menu` | `https://gateway.test/http/<hex>/xtgl/index_initMenu.html` | 先 GET 首页再两条 POST，前缀都保留 |
| `xhsysu-sunday` | `qsxqj=7`，校历第 1 周周一 2026-09-07 | 开学日回退到 2026-09-06，提醒里说明 |
| `xhsysu-cal-fail` | 校历 404 | 仍然成功；开学日推算 2026-08-31、总周数 20，提醒如实说明 |
| `xhsysu-proto` | 先把 `Array.prototype.filter` / `String.prototype.trim` 改坏 | 与正常场景输出一致 |
| `xhsysu-expired` / `-expired-cas` | 课表接口 200 但返回正方登录页 / 统一认证跳转页 | 报「登录状态已失效，请重新登录教务系统后再点「提取课表」」 |
| `xhsysu-500` | 课表接口 500 | 报「教务系统返回错误（代码 500）：…」 |
| `xhsysu-cas` / `-sso` / `-zf-login` / `-webvpn-cas` | 统一认证登录页、`/sso/lyiotlogin`、正方登录页、WebVPN 下的认证页 | **不发请求**，报「当前打开的是登录页（或登录后的跳转页）…」 |
| `xhsysu-root` / `-webvpn-home` / `-portal` | 教务站根 `/`、WebVPN 首页、学校主站 `www.xhsysu.edu.cn` | **不发请求**，报「请先登录并进入教务系统，打开…后再点「提取课表」」 |

检查项（同一轮运行）：课表响应里埋的学号、身份证号、手机号、`xsxx`、`cd_id`、`xqmc`、`cxbjmc` / `xkbz` 等，没有出现在任何请求里，也没有出现在交出的数据里；
响应里 `cdmc` 为「未排地点」的课，导入后教室为 `null`；节次时间恒为校内 14 节。

## 7. fixtures 与自检

共 10 对合成用例（`manifest.json` 的 `fixtures` 与 `fixtures/` 一一对应）。期望值先按规范与代码逻辑手工推演（周次切段、单双归属、合并、开学日、总周数、节次时间、提醒文本逐字），
写进 expected 后再跑自检比对，**没有**把 parse.js 的输出直接存成 expected；10 对第一次自检就全部对上。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 校内 14 节逐节钉住（含第 11 与 12 节之间的晚课断档、第 13-14 节的晚课）；周次写法 `第7周`、`1~16周`、`1至8周`、`1,3,5周`、全角 `2，4，6周`、全角 `1-15周（单）`、`第1-第8周`、`1-8周,10-16周`（两段）；校历 `rq` 为「起/止」写法；学期文本为「1」（正方写法）按代号认学期 |
| `no-room` | 教室写「未排地点」（含前后空格）→ `null` 并计入缺教室；同课 1-2 与 3-4 两行都未排地点仍合成 1-4；缺教师；提醒只点名前三门、第四门只计数 |
| `week-markers` | 上游会丢整行的 `(单)1-8周,(双)9-16周`、后缀写法、`1-8周,10-16周(单)`（只有后一段单周）；`1-16(单周)`；`共16周` 三种位置只剥备注；教学班序号与括号备注各提醒一次；`2-16单周`；校历 `zs` 为字符串 + `zrq` 字段 |
| `week-adjacent` | `1-8周(单) 9-16周(双)` → 1-7 单 + 10-16 双；`1-8周(单)9-16周` → 1-9 单 + 10-16 每周；`1-16周(单) 17-18周` → 1-17 单 + 18 每周 |
| `calendar-sunday` | `qsxqj="7"`，校历第 1 周周一 → 开学日回退到周日 2026-08-30 并说明；课表最晚周与校历一致，总周数不抬高 |
| `calendar-no-week1` | 校历只有第 2、3、20 周 → 不顶替，推算 2026-08-31 并说明；总周数取校历最大周次 20；`qsxqj` 为 `null` |
| `no-calendar-overweek` | 无校历、第二学期（代号 12）→ 推算 2027-02-15；课表最大第 22 周 → 总周数抬到 22 并说明；`31周` 丢弃并提醒；三行认不出的周次跳过并点名写法 |
| `boundary-periods` | `第9-10节` + `11-12` 相接合并成 9-12；`0102`、`11-12节`、`1,2`、`1-2,5-6`（多段提醒）；第 14 节原样；课表用到第 15-16 节 → 顺推 21:25-22:10、22:15-23:00 并说明；`total` 写 12 条实际 8 行 → 对账提醒 |
| `long-warnings` | **专门覆盖「带课名的提醒不超 200 字」**：两门超 20 字的课名（缺教师、教室「未排地点」各一）+ 体育两项都缺 + 四门超长集中实践课（只点名前三门、课名截到 20 字）+ 三行认不出的周次；每条提醒都经 `warn()` 同一个出口 |
| `merge-dedupe` | 同课 1-2 与 3-4 相接合成 1-4；完全重复的行（两处）只留一条；同节次不同周次不合并；同节次两个周次段取并集 1-16 |

自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/xhsysu`，10 个 fixture 全部 MATCH，最后一行 `RESULT: PASS`。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **没有在真机上验证**。没有广州新华学院账号，也没有登录后的真实页面。请求路径、请求体、字段名、节次时间全部以上游脚本为准；冒烟用的是假教务站，
   只证明拼出来的地址、请求体和数据形状符合上游写法。fixture 是合成的，只保证同样的输入永远得到同样的输出，不保证解析在真实页面上是对的。
   上游 `adapters.yaml` 自己写明「非本校开发者，如有误请提交 issues」。
2. **节次时间是上游抄的学校公布值**，没有向教务系统核对；上游注释写来源是教务处「上课时间段一览表」。每次导入都有一条提醒请用户核对。本件不请求教务的节次时间，教务里若配了不同的节次表，我们不会用到。
3. **WebVPN 主机未知**：上游只说经 WebVPN 时路径带 `/http/<十六进制>` 前缀，没给 WebVPN 的主机名，所以 `allowHosts` 里没有它；`loginUrl` 也指向校内统一认证。
   前缀拼接已在冒烟里验证，但走 WebVPN 时宿主是否放行该主机未验证。
4. **`/xtgl/` 与 `/kbcx/` 作为「已进教务」的判据**：根路径部署下正方的菜单页是 `/xtgl/index_initMenu.html`、课表页是 `/kbcx/…`。若本校的登录后首页不在这两个路径下，用户需要先点进「学生课表查询」再提取（提示里已这样写）。
5. **`/sso/lyiotlogin` 当作登录页**：这是上游的判断。如果它实际上是一个会停留的页面（不是一闪而过的跳转），用户会被提示「当前打开的是登录页（或登录后的跳转页）」，需要先进入教务系统的课表页。
6. **`qsxqj` 是否在课表响应顶层**未验证（上游不读它）。没有就按周一处理，与上游行为相同，不会报错。
7. **学期代号与学期文本**：正方的学期下拉框常见 `value` 为 3 / 12 / 16、文本为 1 / 2 / 3。`termKind()` 优先看文本里的「一 / 二 / 三」，认不出再看代号；若本校两者都不符合，会默认第一学期并在学期名里显示。
8. **校历日期字段**：按 `rq` 首段（`2026-08-31/2026-09-06`，上游就是取这一段）、`zrq` / `zcrq` / `ksrq` 认日期，没见过真实响应。
9. **总周数的计法与上游略不同**（§5）：上游用校历数组长度，这里用校历里最大的周次号；每周一行的完整校历两者相同。
10. **记录总数对账**：正方这个接口一次性返回整学期，本件只在响应里带了总数字段时才对账。

## 9. 签名

0x7E7-2023（sonnet 移植，2026-10-20）

## 修订 1.0.1（2026-10-27）：无逗号的前置单双标记

- 问题：`(单)1-8周(双)9-16周`（前置标记、两段之间没有逗号）里的第二个标记前面紧挨「周」，被当成上一段的后缀，两段并成「单双都有」，整门课读成 1-16 周每周都上（批次十八 `jxfu`、批次十九 `smu` 审计发现，探测后确认本件同样如此）。
- 修正：`weeksOf` 里夹在两段中间的标记，若它所在的这一段以前置标记开头，就判给下一段；否则仍按后缀归上一段，`1-8周(单)9-16周(双)` 等后置写法不受影响。段间只有空格的 `(单)1-8周 (双)9-16周` 也一并读对。
- 回归：差分测试（`.test/fix-prefix/diff.js`）对 32 种其它周次写法比对修订前后输出，修订前读对的全部一字不差；7 种无逗号前置写法读出的周次与手推一致，整份输出与修订前代码对等价后置写法的输出一致。
- 新增 fixture `weeks-prefix-glued`：期望取修订前代码对等价后置写法 `1-8周(单),9-16周(双)` 的输出（该写法修订前已正确）。
- 版本 1.0.0 → 1.0.1。
