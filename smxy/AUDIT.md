# 安全审计 —— 三明学院（正方教务 V9，/jwglxt 上下文，CAS 统一身份认证登录）

审计对象：`jw-adapters/smxy/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `SMXY/smxy.js`（182 行；快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，2026-10-20 复核仍是最新；
MIT，作者 Haooz；本校目录最后一次修改 `80e30cf`，用 `git log -1 -- resources/SMXY/smxy.js` 核对过，与任务卡一致）。

审计方式：逐行读上游脚本与同目录 `adapters.yaml`（`adapter_name` 三明学院正方教务，`maintainer` Haooz，`description` 写明「三明学院正方教务V9，通过CAS统一身份认证登录后进入教务系统执行导入」，
`import_url` `https://one.fjsmu.edu.cn/tp_up/view?m=up`，与任务卡一致）；再逐函数对照模板；移植手册 §5 八条逐条；静态扫描；
extract.js 在 Playwright 的 Chromium 里对着假教务站实跑 13 个场景（不联网）。

静态扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js`、`parse.js` 代码里没有任何绝对地址；两个文件头注释里各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`（注释）。
  `manifest.json` 的 `loginUrl` / `scheduleUrlHint` / `homepage` 是给宿主看的声明，不是请求。
- 网络调用：只有 `extract.js` 的 `request()` 里一处 `fetch(url, options)`（`X-Requested-With` 是请求头字符串，不是 XHR 对象）。`parse.js` 没有任何网络调用、没有 `document.` / `window.`。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` / `sendBeacon` / `WebSocket` / `new Image` /
  `innerHTML` / `appendChild` / `.submit` / `setAttribute` 全部无命中。
- 原型方法：`extract.js` 代码里不调用 `.filter(` / `.trim(` / `.map(` / `.forEach(`（grep 只在注释里提到名字）；`parse.js` 的 `text()` 用了 `.trim()`，它只在 Rhino / 宿主解析环境里跑，不在教务页面里。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class`、`async`、`await`、展开符、可选链、`??`、`padStart`、`Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(`
  全部无命中（`check.js` 同口径通过）。控制字节与 BOM：无。
- 模板残留：检索「广州新华」「xhsysu」「XHSYSU」「lyuapServer」「sso/lyiotlogin」「jw.xhsysu」，代码与 manifest 零命中（`parse.js` 文件头有意写「模板为同作者同平台的 xhsysu」）。
- 个人信息：`fixtures/` 全部为合成数据（甲 / 乙 / 丙…老师，致远楼 / 实验楼等虚构地点），没有真实姓名与学号。

## 0. 上游情况（任务卡之外自己读出来的）

- **平台**：正方教务 V9（`/jwglxt/kbcx/…`，菜单号 `N2151` 课表、`N2154` 校历），带 `/jwglxt` 上下文。登录：学校门户 `one.fjsmu.edu.cn`（`/tp_up/`）→ CAS 统一身份认证 → 教务。
  `import_url` 是门户而不是教务站，上游脚本里所有请求都是相对路径（`/jwglxt/kbcx/…`），**代码里没有教务站的主机名**，所以主机只能由用户当前页面决定；`allowHosts` 里的教务主机见 §1 末尾与 §8。
- **上游全文 3 个请求**：课表首页 GET（读 `#xnm` / `#xqm` 做弹窗选项）、课表 POST、校历 POST。没有 `qsxqj`、没有节次时间接口（`cxRjc`）、没有备用接口、没有菜单号回落、没有 WebVPN 前缀处理、没有提问桥。
- **上游没有任何节次时间**：全文无写死的节次表，也没有 `savePresetTimeSlots`；只存课程（`saveImportedCourses`）与学期配置（`saveCourseConfig`：开学日、总周数写死 20）。
- **上游课表请求体**：`xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`（与 `xhsysu` 逐字相同）；校历请求体 `xnm=…&xqm=…`；课表首页 GET 地址不带 `layout=default`。本件逐字照上游。
- **上游 `parseWeeks`**（代码，不是注释）：按半角逗号切段，每段用 `/(\d+)-(\d+)周/`（不带全局标志，只取第一个区间）或 `/^(\d+)周/`；标记 `(单)` / `(双)` 用 `includes` 判断**整段**。后果：
  ① 空格分段的「1-8周(单) 9-16周(双)」只取第一个区间，后一段静默丢掉；② 全角逗号「2，4，6周」整段读不出，这行课静默消失；③ 不认「~」「至」，「1~16周」整行消失；
  ④「第7周」「第1-第8周」带「第」整行消失；⑤「1-16周(单双)」两个标记互相排除成空数组，整行消失。（前缀写法「(单)1-8周,(双)9-16周」因为是按段判断，上游是对的。）
  本件换成 `weeksOf`（§4 第 1 条）。
- **上游丢行条件**：`!c.kcmc || !c.xm || !c.cdmc || !c.xqj || !c.jcs || !c.zcd` 整行静默 `continue`（缺教师或缺教室的课也整行丢掉）；`jcs` 只认「a-b」（`split('-')`，首尾两端）。
- **上游总周数** 写死 20（`semesterTotalWeeks: 20`），开学日 = 校历里 `zs` 或 `zsmc` 为 `"1"` 的那行（找不到拿第一行）的 `rq.split('/')[0]`（须为 `yyyy-MM-dd`），否则从 `zcrq` 正则取第一个日期；取不到则开学日为 `null`。
- **上游合并** `mergeAndDistinctCourses`：按「课名、教师、教室、星期、周次串、起始节」排序后合并连续节次，再按「起止节次相同」取周次并集。
- **上游登录页判断**：没有。上游开场弹一个「请确保已登录」的提示就继续发请求。

## 1. 请求域与请求清单（与代码逐条对应）

地址 = `window.location.origin` + 路径前缀 + `/kbcx/<页面>?gnmkdm=<菜单号>`。路径前缀（`extract.js` 的 `prefixOf`）= 当前路径里**最早出现的 `/kbcx/` 或 `/xtgl/` 之前**的那一段：
校内直连是 `/jwglxt`；经学校 WebVPN 打开时前面还有一段（如 `/http/<十六进制>`），原样保留。当前路径里一个都没有（学校门户、教务站根、WebVPN 首页）时返回 `null`，直接抛错、**不发任何请求**。
主机一律是用户当前打开的那个页面的主机，代码里没有写死的主机名或端口。

| # | 谁 | 方法 | 地址 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|---|
| 1 | `currentTerm` | GET | `<前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151`（与上游一致，不带 `layout=default`） | 无 | 读 `#xnm` / `#xqm` 下拉框（`DOMParser` 离线解析）。**页面上已有这两个下拉框时跳过** | 抛「没读到学年学期…」 |
| 2 | `fetchTimetable` | POST | `<前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`（与上游逐字一致） | 取整学期课表 JSON：`kbList`、`sjkList`、`qsxqj`、可能有的记录总数 | 非 2xx 抛「教务系统返回错误（代码 N）」；网络错误抛「连不上教务系统」；200 但内容含 `login_slogin` / `/cas/login` / `/authserver/login` / `name="yhm"`（会话过期回登录页）抛「登录状态已失效」；不是带 `kbList` 数组的 JSON 抛「没有返回课表数据」 |
| 3 | `optionalJson` | POST | `<前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | `xnm=…&xqm=…`（与上游一致） | 取学期周次校历（第 1 周日期、周数） | 任何失败或非 JSON → `null`，parse.js 推算开学日并写 warnings |

- 请求头统一为 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: */*`，全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。
  上游课表请求只带 `Content-Type`，校历请求带 `accept` 与 `X-Requested-With`；统一后多的头都是标准头，不带任何自定义令牌。
- 校历请求在课表成功之后才发（上游是并行）：课表失败时少一次无意义请求；校历失败不影响导入。
- **没有第四条请求**：不请求节次时间接口（`cxRjc`）——上游没有，且要带的校区号没有本校账号无从验证。冒烟里所有场景都检查了请求清单里没有 `cxRjc`。
- 登录页 / 统一认证页 / 学校门户 / 教务站根 / WebVPN 首页：**不发请求**，直接给大白话提示（§6.2）。
- `allowHosts` = `["zhjw.fjsmu.edu.cn", "zhjw.smxy.cn"]`（不写通配）：`loginUrl` 是学校门户 `one.fjsmu.edu.cn`（与教务站不同源），教务主机单列；脚本本身不请求门户或认证主机。**教务主机名不在上游代码里，见 §8。**

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
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问，也不读 Cookie（会话由浏览器自带）。统一认证全程由用户在 WebView 里手工完成。上游的开场弹窗（`showAlert`）、学年 / 学期选择框（`showSingleSelection`）、`saveImportedCourses` / `saveCourseConfig` / `showToast` / `notifyTaskCompletion` 全部未移植 |
| 2 | 不外发 | **过**。唯一的 `fetch` 在 `extract.js` 的 `request`，地址全部由当前页面的 origin 加前缀拼成同源地址。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，也没有第三方域 |
| 3 | 请求域可控 | **过**。只访问用户当前打开的教务页面所在主机；`allowHosts` 只写教务主机两项（主域名与别名），不写通配；代码里没有写死的主机名或端口 |
| 4 | 只读课表 | **过**。三条请求全部落在 `/kbcx/*`（课表首页、课表、周次校历），不碰成绩、学籍、缴费。课表响应里夹带的学生信息不带出，白名单之外的字段全部丢弃 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`，失败返回 `null`） |
| 7 | 不写页面 | **过**。读页面下拉框只用 `querySelector` / `options`，不改 DOM、不提交表单、不点击。取课表首页用 `fetch` + `DOMParser` 离线解析，不插入当前页面 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有菜单号 `N2151` / `N2154`（页面上可见的参数）和判断登录页用的路径片段 |

## 4. 与模板的差异

**模板选择**：以同作者（Haooz）、同平台的 `xhsysu`（广州新华学院）为底。理由：
① 上游同样是「正方 V9 三个请求（课表首页 GET、课表 POST、校历 POST）」，课表请求体 `xnm/xqm/kzlx=ck/xsdm=/kclbdm=` 逐字相同，没有 `cxRjc`、没有备用接口、没有提问桥；
② `xhsysu` 已含本批要求的全部新写法：`weeksOf`（单双按位置归属、含挨着下一段与「第」前缀、「共 N 周」只剥备注）、提醒限长出口、缺教师 / 教室按类型汇总、H3 顺推补节次、每周起始日回退、校历 `zs`/`zsmc`/`rq`/`zcrq` 兼容、完全重复行去重；
③ `xhsysu` 的 `prefixOf` 取 `/kbcx/` 或 `/xtgl/` 之前的任意前缀，天然适用 `/jwglxt`（桩跑与冒烟确认）。
未选 `swu`：它多一套备用接口与提问桥，要删的比要改的多（`swu` 的 `/jwglxt` 前缀写法只拿来对照）。

差异逐条：

1. **周次解析**（`weeksOf`，照模板）：上游「按半角逗号切段 + 每段只取第一个区间 + 整段套标记」的五个后果（§0）在本件全部接住：「1-8周(单) 9-16周(双)」「2，4，6周」「1~16周」「1至8周」「第7周」「第1-第8周」「1-16周(单双)」（按每周都上处理并提醒）。
   「共 N 周」只剥备注本身（`/共\s*[0-9]+\s*周?/g`），不写成「删到行尾」；括号里的教学班序号摘掉并计数、含非周次字的括号备注摘掉并计数。
2. **`/jwglxt` 上下文**：`prefixOf` 取 `/kbcx/` 或 `/xtgl/` 之前的路径作前缀，校内直连得 `/jwglxt`，WebVPN 得 `/http/<hex>/jwglxt` 之类；不带 `layout=default`、不带 `kclxdm=`，与上游一致。
3. **登录页判断**（上游没有）：正方自己的 `login_slogin.html`、统一认证 `/cas/login` 与 `/authserver/login`、学校门户 `/tp_up/`，命中就不发请求。会话过期识别认 `login_slogin` / `/cas/login` / `/authserver/login` / `name="yhm"`。
   这些页面本来也没有 `/kbcx/` `/xtgl/` 路径（正方登录页在 `/xtgl/login_slogin.html` 下，需要专门判断），所以另有一条「还没进教务」的兜底提示。
4. **每周起始日 `qsxqj`**（上游没有）：extract.js 原样交出，parse.js 的 `weekdayOf` / `weekStartOf` 按移植手册 §4.3 把开学日回退到那一天（缺省或不合法按周一），推算开学日的锚点同理。回退时在提醒里说明。
5. **节次时间**：**上游没有任何节次时间**（§0），没有学校的数据可抄，也不编造三明学院的作息。parse.js 内置一张与应用自带默认节次时间逐节相同的 12 节表（`DEFAULT_PERIOD_TIMES`，
   对照 `core/model/.../DefaultPeriodTimes.kt`：08:00-08:45、08:55-09:40、10:00-10:45、10:55-11:40、14:00-14:45、14:55-15:40、16:00-16:45、16:55-17:40、18:30-19:15、19:25-20:10、20:20-21:05、21:15-22:00），随载荷交出，
   并**每次**在提醒里说明「教务系统没有给出节次时间，已先用应用自带的 12 节节次时间导入…请在学期管理里改成学校的节次时间」。
   这样做而不是把 `periodTimes` 留空让应用补默认，是为了课表用到第 13 节及以后时能按 H3 在上一节下课后顺推（课间 5 分钟、每节 45 分钟，越过 23:59 如实说明）。
   效果与应用自带默认相同，用户在「学期管理」里改一次即可。**需要主调度决定**：若要改成请求教务的节次时间（`cxRjc` + 校区号），需要先拿到本校账号验证，本件未做。
6. **「未排地点」**：教室等于它（trim 后）时当作没有教室（`location` 为 `null`），按缺教室汇总（`no-teacher-room`、`long-warnings` 钉住）。上游不特殊处理，会把它当成真实教室收下。
7. **缺教师 / 缺教室**：上游整行静默丢掉；本件照常导入（对应项为 `null`）并按类型汇总进提醒（`no-teacher-room`、`long-warnings` 钉住）。
8. **学校名 / 学期名兜底**：「三明学院 第 X 学期」；学期文本是正方的「1 / 2 / 3」写法时按学期代号（3 / 12 / 16）认学期序号（`basic` 用的就是文本「1」）。
9. **总周数**：上游写死 20；本件取校历里最大的周次号（取不到才 20，课表更晚时抬高并说明）。校历完整时这比 20 更准，校历缺行或取不到时行为与上游一致。
10. **同课合并**：两阶段与上游 `mergeAndDistinctCourses` 同语义，前面多一步完全重复行去重（上游只跟当前合并中的那条比，合并之后才出现的重复会漏掉）。
11. **集中实践课**（`sjkList`）：上游不处理，这里只带课名，提醒里点名，不静默吞掉。
12. **字段白名单**：六个字段 + 实践课课名。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart`（开场 `showAlert`） | 删 | 桥能力，宿主负责交互；提示改由 extract.js 的报错承担 |
| `selectAcademicYearAndSemester` / `fetchAcademicOptions`（两个 `showSingleSelection`，学年只取选中项前后各 2 项） | 删，改为读页面 `#xnm` / `#xqm`（`selected` 项优先，没有取第一项） | 公共说明第 2 条：不弹窗；要别的学期，用户在教务页切换后再点「提取课表」 |
| `saveCourses` / `saveCourseConfig` / `showToast` / `notifyTaskCompletion` | 删，载荷交给宿主 | 空课由宿主保存；开学日、总周数、节次时间随载荷的 `terms[0]` 交出 |
| `parseWeeks`（只认半角逗号、每段只取第一个区间、不认 `~` `至` 与「第」） | 换成 `weeksOf` | 见 §0；上游能读的写法都读得出，上游会丢整行的写法也接住 |
| `parseJsonData` 缺 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` 的行静默 `continue`；`jcs` 只认 `a-b`；`start > end` 的行静默丢 | 只要求课名 / 星期 / 节次 / 周次，缺的分类计数写进 warnings；节次放宽到「第9-10节」「1,2」「0102」，多段按最大跨度放入并说明；缺教师 / 教室照常导入 | 公共说明第 4、6 条：不许静默丢课 |
| `fetchSemesterStartDate` 找不到 `zs=1` 时拿 `json[0]` 顶替 | 不顶替，改为推算并说明 | 顶替会让开学日悄悄错一周；`calendar-no-week1` 钉住 |
| 开学日 = `rq` 前半（或 `zcrq` 里第一个日期），不回退 | 回退到每周起始日（`qsxqj`，缺省周一） | 手册 §4.3；校历里的日期本来就是周起始日时结果相同 |
| 总周数写死 20 | 校历最大周次号（取不到 20），课表更晚时抬高并说明 | 见 §4 第 9 条 |
| 校历取不到时开学日为 `null`，由用户手动设 | 按学期序号推算（第一学期 9 月 1 日所在周、第二学期 2 月 20 日所在周、夏季 7 月 1 日所在周的第一天）并写 warnings | 载荷必须带开学日；推算值在提醒里明说 |
| 课表与校历并行请求 | 课表成功后再取校历 | 课表失败时少一次无意义请求 |
| 课表响应整体交给解析函数（不外发） | 按字段白名单挑 | 学生信息不进载荷 |
| `Set` / 展开符 / 箭头函数 / 模板串 / `async` | ES5 重写 | CI 的 Rhino 解释模式口径 |

## 6. 变异测试与冒烟记录

### 6.1 变异测试

在 `C:/Users/23703/AppData/Local/Temp/smxy-port15/mut/smxy/` 下做副本（目录名同样是 `smxy`，否则 check.js 会因 `manifest.key` 与目录名不一致报错；用一个临时的 python 脚本逐处替换，做完已删除），
每份只替换副本的 `parse.js` 里一处（替换要求恰好命中 1 次），各跑一次 `check.js`。真实的 `parse.js` 未被改动，之后再跑自检通过；副本已删除。

| 编号 | 改坏哪一处 | 变红的用例 |
|---|---|---|
| m1 | 内置节次表第 5 节开始 `14:00` 改成 `13:30` | 所有带节次时间的用例（12 对全红） |
| m2 | 去掉「标记前面紧挨数字或『周』则归上一段后缀」的判断 | `week-adjacent` |
| m3 | 「共 N 周」剥离改成 `/共.*$/`（同族适配器上游的常见写法，从「共」删到行尾） | `week-markers`：`1-8周(共8周),9-16周` 的 9-16 周被吞 |
| m4 | `NO_ROOM_TEXT` 的置空逻辑删掉（「未排地点」当真教室） | `no-teacher-room`、`long-warnings` |
| m5 | `EXTEND_CLASS_MINUTES` 45 改成 50 | `boundary-periods`：第 13-14 节顺推时间错 |
| m6 | `plausibleStart` 的 45 天窗口放宽到 400 天 | `calendar-wrong-term` |
| m7 | `NAME_TEXT_LIMIT` 20 改成 40（课名不截断到 20 字） | `long-warnings` |
| m8 | 关掉 `dropExactDuplicates` | `merge-dedupe` |
| m9 | `weekdayOf(data.qsxqj)` 改成恒为 1（每周起始日不生效） | `calendar-sunday`：开学日期望 2026-08-30 |
| m10 | 校历日期不再认 `zcrq` | `calendar-zcrq` |

十处全部被对应用例抓住，还原后 `check.js` 通过。

### 6.2 浏览器冒烟（`D:/NullClass/.test/port-batch15/smxy/smoke.py`）

Playwright 起 Chromium，所有请求被 `route` 拦下（假教务站，不联网），跑真实 `extract.js`，再用 Rhino 跑 `parse.js`。13 个场景全部 OK：

| 场景 | 页面 | 结果 |
|---|---|---|
| `smxy` | `https://zhjw.fjsmu.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`（页面上有下拉框） | 不发 GET 首页；只发 `POST /jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`（体 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=`）与 `POST /jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`（体 `xnm=2026&xqm=3`）；没有 `cxRjc`；节次时间 12 节 |
| `smxy-menu` | `/jwglxt/xtgl/index_initMenu.html?jsdm=xs`（无下拉框） | 先 `GET /jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151`（与上游一致，无 `layout=default`），再发上面两条 POST |
| `smxy-vpn` | `https://webvpn.fjsmu.edu.cn/http/<hex>/jwglxt/kbcx/…`（假想的 WebVPN 网关，仅验证前缀逻辑） | 每条请求都保留 `/http/<hex>/jwglxt` 前缀 |
| `smxy-proto` | 先把 `Array.prototype.filter` / `String.prototype.trim` 改坏 | 与正常场景输出一致 |
| `smxy-cal500` | 校历 500 | 仍然成功；开学日推算 2026-08-31、总周数 20，提醒如实说明 |
| `smxy-calhtml` | 校历接口 200 但返回登录页 HTML | 同上（`jsonOf` 失败 → `null`） |
| `smxy-expired` | 课表接口 200 但返回正方登录页 | 报「登录状态已失效，请重新登录教务系统后再点「提取课表」」 |
| `smxy-badjson` | 课表接口 200 但 JSON 里没有 `kbList` | 报「教务系统没有返回课表数据…」 |
| `smxy-404` | 课表接口 404 | 报「教务系统返回错误（代码 404）：…」 |
| `smxy-portal` / `smxy-cas` / `smxy-login` | 学校门户 `one.fjsmu.edu.cn/tp_up/view?m=up`、CAS 登录页 `/cas/login`、正方登录页 `/jwglxt/xtgl/login_slogin.html` | **不发请求**，报「当前打开的是登录页（或学校门户）…」 |
| `smxy-home` | 教务站根 `/` | **不发请求**，报「请先登录并进入教务系统，打开…后再点「提取课表」」 |

检查项（同一轮运行）：课表响应里埋的学号、身份证号、手机号、`xsxx`、`cd_id`、`xqmc`、`cxbjmc` / `xkbz` 等，没有出现在任何请求里，也没有出现在交出的数据里；
所有请求与页面同源；每条请求都带菜单号；`cdmc` 为空的体育课导入后教师、教室均为 `null`。

## 7. fixtures 与自检

共 12 对合成用例（`manifest.json` 的 `fixtures` 与 `fixtures/` 一一对应）。期望值先按规范与代码逻辑手工推演（周次切段、单双归属、合并、开学日、总周数、节次时间取自应用默认节次表、提醒文本逐字），
写进 expected 后再跑自检比对，**没有**把 parse.js 的输出直接存成 expected；12 对第一次自检就全部对上。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 12 节节次时间逐节钉住（第 4/5 节午休断档、第 8/9 节晚课断档、第 12 节）；教务没给节次时间的提醒；周次写法 `第7周`、`1~16周`、`1至8周`、`1,3,5周`、全角 `2，4，6周`、全角 `1-15周（单）`、`第1-第8周`、`1-8周,10-16周`（两段）；校历 `rq` 为「起/止」写法；学期文本为「1」（正方写法）按代号认学期 |
| `no-teacher-room` | 上游会整行丢掉的缺教师 / 缺教室：教室「未排地点」（含前后空格）、教室字段缺席、教师空串 → `null` 并分别汇总；同课 1-2 与 3-4 两行都未排地点仍合成 1-4；提醒只点名前三门、第四门只计数 |
| `week-markers` | `(单)1-8周,(双)9-16周`、后缀写法、`1-8周,10-16周(单)`（只有后一段单周）；`1-16(单周)`；`共16周` 三种位置只剥备注；`1-16周(单双)` 两个标记同时出现（上游互相排除成空、整行消失）按每周都上并提醒；教学班序号与括号备注各提醒一次；`2-16单周`；校历 `zs` 为字符串 + `zrq` 字段 |
| `week-adjacent` | `1-8周(单) 9-16周(双)`（上游会丢后一段）→ 1-7 单 + 10-16 双；`1-8周(单)9-16周` → 1-9 单 + 10-16 每周；`1-16周(单) 17-18周` → 1-17 单 + 18 每周 |
| `calendar-sunday` | `qsxqj="7"`，校历第 1 周周一 → 开学日回退到周日 2026-08-30 并说明；课表最晚周与校历一致，总周数不抬高 |
| `calendar-no-week1` | 校历只有第 2、3、20 周 → 不顶替（上游拿第一行），推算 2026-08-31 并说明；总周数取校历最大周次 20；`qsxqj` 为 `null` |
| `calendar-zcrq` | 校历周次在 `zsmc`、日期只有 `zcrq`（「起 至 止」），第 1 周不在第一行 → 开学日 2026-09-07，总周数 19 |
| `calendar-wrong-term` | 校历是别的学期（第 1 周 2026-02-23）→ 忽略校历与它的周数，推算开学日、总周数 20，两条提醒 |
| `no-calendar-overweek` | 无校历、第二学期（代号 12）→ 推算 2027-02-15；课表最大第 22 周 → 总周数抬到 22 并说明；`31周` 丢弃并提醒；三行认不出的周次跳过并点名写法 |
| `boundary-periods` | `第9-10节` + `11-12` 相接合并成 9-12；`0102`、`11-12节`、`1,2`、`1-2,5-6`（多段提醒）；课表用到第 13-14 节 → 顺推 22:05-22:50、22:55-23:40 并说明；用到第 15-16 节 → 越过 23:59 不补时间并说明；`total` 写 12 条实际 8 行 → 对账提醒 |
| `long-warnings` | **专门覆盖「带课名的提醒不超 200 字」**：两门超 20 字的课名（缺教师、教室「未排地点」各一）+ 体育两项都缺 + 四门超长集中实践课（只点名前三门、课名截到 20 字）+ 三行认不出的周次；每条提醒都经 `warn()` 同一个出口 |
| `merge-dedupe` | 同课 1-2 与 3-4 相接合成 1-4；完全重复的行（两处）只留一条；同节次不同周次不合并；同节次两个周次段取并集 1-16 |

自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/smxy`，12 个 fixture 全部 MATCH，最后一行 `RESULT: PASS`。

## 8. 已知风险与未验证项

- **没有本校账号，真机没验过**：三条请求的路径、菜单号、请求体全部来自上游脚本和同族适配器，响应字段（`kbList` 的 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd`、校历的 `zs` / `rq`）也按上游。fixtures 全是合成数据。
- **教务主机名来自公开搜索结果，`/jwglxt` 部署未核实**：上游代码和 `adapters.yaml` 里只有门户 `one.fjsmu.edu.cn`；三明学院「智慧教务管理系统」的主机经主调度用公开搜索查到是 `zhjw.fjsmu.edu.cn`（别名 `zhjw.smxy.cn`，同一套系统），但没有看到该主机下 `/jwglxt/…` 路径的直接证据，也没有本校账号。extract.js 不写死主机，按当前页面同源 + 当前路径里 `/kbcx/`、`/xtgl/` 之前的前缀拼地址；若实际主机不在 `allowHosts` 里，请求会被拦、用户会看到「连不上教务系统」，需要改 manifest 的 `allowHosts` 与 `scheduleUrlHint`。
- **门户进教务的路径**：用户从门户进教务（CAS 单点登录），需要在 WebView 里点进教务系统并打开「信息查询 - 学生课表查询」后再点「提取课表」；不在 `/jwglxt/kbcx/…` 或 `/jwglxt/xtgl/…` 页面上时给出的是「请先登录并进入教务系统」。
- **节次时间是应用默认值**：学校实际上下课时间可能不同；提醒每次导入都会说明，用户需要在「学期管理」里核对。
- **总周数**：校历接口返回的是整学期周次时取最大周次号；若本校校历接口返回的不是完整周次表（比如只有当前周），总周数会偏小，课表更晚的周次会把它抬高并提醒。
- **WebVPN**：上游没有 WebVPN 处理；本件的前缀逻辑理论上支持，但三明学院是否有 WebVPN、前缀长什么样没有验证（冒烟里的网关地址是假想的）。

签名：0x7E7-2023（sonnet 移植，2026-10-20）

**主调度补充（2026-10-20）**：教务主机按公开搜索结果定为 `zhjw.fjsmu.edu.cn`（「三明学院-智慧教务管理系统」，另有别名 `zhjw.smxy.cn`），两者都进 `allowHosts`；该主机上是否部署 `/jwglxt` 未核实。extract.js 不写死主机，按当前页面同源拼地址。

## 修订 1.0.1（2026-10-27）：无逗号的前置单双标记

- 问题：`(单)1-8周(双)9-16周`（前置标记、两段之间没有逗号）里的第二个标记前面紧挨「周」，被当成上一段的后缀，两段并成「单双都有」，整门课读成 1-16 周每周都上（批次十八 `jxfu`、批次十九 `smu` 审计发现，探测后确认本件同样如此）。
- 修正：`weeksOf` 里夹在两段中间的标记，若它所在的这一段以前置标记开头，就判给下一段；否则仍按后缀归上一段，`1-8周(单)9-16周(双)` 等后置写法不受影响。段间只有空格的 `(单)1-8周 (双)9-16周` 也一并读对。
- 回归：差分测试（`.test/fix-prefix/diff.js`）对 32 种其它周次写法比对修订前后输出，修订前读对的全部一字不差；7 种无逗号前置写法读出的周次与手推一致，整份输出与修订前代码对等价后置写法的输出一致。
- 新增 fixture `weeks-prefix-glued`：期望取修订前代码对等价后置写法 `1-8周(单),9-16周(双)` 的输出（该写法修订前已正确）。
- 版本 1.0.0 → 1.0.1。
