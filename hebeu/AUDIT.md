# 安全审计 —— 河北工程大学（正方教务 v9，站点根路径部署）

审计对象：`jw-adapters/hebeu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `resources/HEBEU/hebeu.js`（快照 commit `e15c6274ac347c9642da890504651a9b4e374391`，
2026-10-26 拉取；本校脚本最后一次修改 `25dc738`，2026-10-15；MIT，作者 Nanawwa，`adapters.yaml` 的 maintainer）。
上游 `import_url` 为 `https://jwglxxfwpt.hebeu.edu.cn/xtgl/login_slogin.html`，本件 `loginUrl` 与之相同。

审计方式：逐行读上游脚本（488 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描；`parse.js` 用 Rhino 1.8.0 实跑
8 对 fixture（`check.js`，最后一行 `RESULT: PASS`）；`extract.js` 用 Playwright 起假教务站（全部请求被 route 拦下，
不联网）跑真实脚本，14 个场景全部 OK（`.test/port-batch18/hebeu/smoke.py`），确认请求地址、方法、请求体、
交出去的形状，以及个人信息不外带。扫描结果：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，
  是写上游出处的注释，不是请求。请求地址全部由 `window.location.origin` 拼出，代码里只有一个字符串常量
  `JW_HOST = 'jwglxxfwpt.hebeu.edu.cn'`，用来判断「当前页面是不是教务主机」，不用来拼请求地址。
- 网络调用：只有 `extract.js` 里 `request` 函数（第 65 行起）的 `fetch(url, options)`。`parse.js` 里没有任何网络调用。
- 凭据、本地存储、动态执行：`password` / `pwd` / `localStorage` / `sessionStorage` / `document.cookie` /
  `eval` / `new Function` / `sendBeacon` / `WebSocket` / `EventSource` / `new Image` 全部无命中。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、解构、展开符、
  `new Set` / `new Map` / `Array.from`、可选链、后行断言与命名捕获组，在 `parse.js`、`extract.js` 全文中全部无命中。
- 控制字节与 BOM：本目录全部文件（含 fixtures）无控制字节、无 BOM（`check.js` 扫描）。
- 模板残留：全目录无 `jsei` / 江苏电子信息 / `jwpd` / `webvpn` 等模板学校字样。仅 `parse.js` 文件头注释里有意写了
  「模板：同平台已审计件 jsei」，以及两处注释提到 `jwglxt`（说明正方通用的学期代号与周次写法，不是路径）。

## 0. 模板选择与本校分析

- **模板**：`jsei`（批次八，正方 v9，同样是 POST 表单取课表 + `jzgl/skxxMobile_cxRsdjc` 取节次时间 + `cxZcByXnxq` 取校历，
  周次解析、节次解析、两阶段合并、H3 补节次、提醒限长都已审计）。本校上游也是同一套写法，所以复制 `jsei` 后改
  取数层与本校常量即可；周次解析里的前缀 / 后缀单双标记归属（B1）、「共 N 周」只剥备注（B3）、「第」前缀沿用 `jsei`
  的已修版本。读学期的写法参考批次十七 `zust` / `gdou`（读页面上的 `#xnm` / `#xqm`）。
- **与 `jsei` 不同构之处**：
  1. 教务在站点根下，没有 `/jwglxt/` 前缀：上游 `getBaseUrl()` 是 `window.location.origin + '/'`，本件 `jwUrl(path)` 同义。
  2. 单入口（没有 WebVPN / 校园网双入口），`allowHosts` 为空，请求与 `loginUrl` 同源。
  3. 节次时间请求的 `xqh_id` 不是固定 1，而是**取第一门有校区号的课**的 `xqh_id`，没有就不带（上游 `campusId` 同样）。
  4. 上游内置作息是 10 节（兜底表注明「2026-2027 学年第 1 学期自教务作息接口实测，xqh_id=108」），不是 `jsei` 的 11 节。
  5. 上游校历开学日是「第 1 周那一行的日期，不回退周一」，总周数「连续且最大周次在 10~60」才采用；`jsei` 的口径更宽，
     本件的校历判定按本校上游改写（见 §5）。
  6. 上游有 `hebeu.edu.cn$` 主机名判断，移植时收紧为教务主机本身（见 §3 第 3 条）。
- **需桩跑 / 冒烟的场景**：已在教务课表页（页面上有学期下拉框）、在教务别的页面（要先取课表首页读学期）、页面上切过学期、
  读不到学期、登录页、同校统一认证 / 门户子域名、第三方页面、登录过期、返回非 JSON、HTTP 500、附加接口失败、缺校区号、
  没有排课行，共 14 个（见 §8）。

## 1. 请求域与请求清单（与代码逐条对应）

四条请求，全部 `fetch` 到**当前教务主机**（`window.location.origin`），站点根路径，没有 `/jwglxt` 前缀。`manifest.json`：
`loginUrl` 为 `https://jwglxxfwpt.hebeu.edu.cn/xtgl/login_slogin.html`，`allowHosts` 为 `[]`（全部请求与 `loginUrl` 同源，
不写通配）。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<origin>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的学年学期字段（`#xnm` / `#xqm`）。**当前页面上已经有这两个字段时跳过这一步**（`currentTerm`） | 报错：「没读到学年学期…请重新登录并打开「个人课表查询」后再点「提取课表」」 |
| extract.js | POST | `<origin>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数。请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=&kclxdm=`，与上游 `requestJw` 的参数顺序和内容一致（`fetchTimetable`） | 报错，提示重新登录 |
| extract.js | POST | `<origin>/jzgl/skxxMobile_cxRsdjc.html?gnmkdm=N2154` | 取节次时间。请求体 `xnm=…&xqm=…`，有校区号时加 `&xqh_id=<第一门有校区号的课的 xqh_id>`，与上游 `fetchTimeSlots` 一致 | 交 `null`，parse 回落到学校 10 节表并写进提醒 |
| extract.js | POST | `<origin>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取学期周次校历，定开学日与总周数。请求体 `xnm=…&xqm=…`，与上游 `fetchSemesterConfig` 一致 | 交 `null`，parse 回落到推算并写进提醒 |

补充：

- 上游每次导入都先请求学年学期首页，生成「默认学期 / 更换学年学期」两级选择框。移植件改成：页面上读得到 `#xnm` / `#xqm`
  就不发这条请求，读不到才去取一次首页（`DOMParser` 离线解析，不插入当前页面）。被 `selected` 标记的那一项优先，没标记取第一项
  （`readSelect`）；上游还看全局变量 `window.xnm` / URL 参数，本件不读（页面上的下拉框就是用户当前选的）。
- 没有排课行（未排课学期）时不发后两条请求（`extract.js` 末尾 `if (!rows.length) return result(null, null)`，上游同样直接提示「暂无课程」）。
- 两条附加请求失败不影响导入：`optionalJson` 把任何失败（非 2xx、网络错误、解析失败）吞成 `null`，由 `parse.js` 回落并提醒。
- 请求头统一带 `Content-Type`（仅 POST）、`X-Requested-With`、`Accept`，不带自定义令牌；凭据用 `same-origin`（上游同样）。
- 登录失效识别：课表等请求返回 HTTP 200 的登录页时（地址含 `login_slogin` 或标题是「用户登录 / 统一身份认证」），报「登录已过期」；
  非 2xx 报「教务系统返回错误（代码 N）」。
- `parse.js` 不发任何请求（CI 里用 Rhino 实跑，是纯函数）。

## 2. 读了什么（数据面）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 与下拉框文本） | 课表页的 `#xnm` / `#xqm`，或课表首页 HTML（离线解析） | 带出（学期名要用） |
| 排课行 `kbList`：`kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `jc` / `zcd` / `xqh_id` | 课表接口 | 带出这八个字段（`ROW_FIELDS` 白名单，`pickFields`）；`xqh_id` 另用来选节次时间的校区 |
| 集中实践课 `sjkList` | 课表接口 | **只带出 `kcmc`**（逐行重建 `{ kcmc }`）；上游预览里展示的 `qsjsz` 也不带 |
| 节次时间（`jcmc` / `qssj` / `jssj`） | `skxxMobile_cxRsdjc` | `PERIOD_FIELDS` 白名单，parse 变成载荷的 `periodTimes` |
| 学期周次校历（`zs` / `zsmc` / `rq` / `zcrq` / `ksrq`） | `cxZcByXnxq` | `CALENDAR_FIELDS` 白名单；只用来算开学日与总周数，不进载荷 |
| 记录总数（响应里有才有，`total` / `totalResult` / `totalCount` / `count`） | 课表接口 | 只用于对账，不进入载荷 |
| 本地日期 `today` | 浏览器时钟 | 带出，仅在学年读不出来、要退回「今天的周一」时用 |
| 学生个人信息（课表响应里夹带的 `xsxx`、排课行里的学号等） | 课表接口 | **不带出，也不进 fixture**（按白名单重建行；冒烟场景里故意塞了学号、身份证号、手机号、教室 ID、`qsjsz` 暗号，输出里全部不见） |

不读的东西（静态扫描无命中）：`password` / `pwd` / 登录表单、`localStorage` / `sessionStorage`、Cookie 值、
成绩（`/cjcx/*`）、学籍、个人信息、缴费，以及任何其它模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问。唯一的「凭据」是浏览器自带的会话 Cookie，脚本既不读它也不外发。上游的开场弹窗（`alertUser`）和学年学期选择框（`showSingleSelection`）没有移植：学年学期改成读页面上的 `#xnm` / `#xqm`，不向用户问任何东西 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `request` 里，地址由 `window.location.origin` 拼成。没有 `sendBeacon` / `WebSocket` / `EventSource` / 图片打点 / 隐藏表单，也没有第三方域 |
| 3 | 请求域可控 | **过**。请求主机只有一个，即用户当前打开的教务主机，且 `onJwHost` 要求它**等于** `jwglxxfwpt.hebeu.edu.cn`（与 `loginUrl` 同源，`allowHosts` 为空）。上游只检查主机名以 `hebeu.edu.cn` 结尾，会让同校任意子域名（统一认证、门户、其它业务系统）都进入取数流程；按白名单口径收紧后，这些页面直接给大白话提示、不发请求（冒烟 `auth` / `portal` / `site` 场景证实）。代码里没有 `*.` 通配 |
| 4 | 只读课表 | **过**。四条请求全部落在课表与节次模块（`/kbcx/*`、`/jzgl/skxxMobile_cxRsdjc.html`），不碰成绩、学籍、个人信息、缴费。课表响应里夹带的学生信息一律不带出 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse` |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的值；课表首页用 `fetch` + `DOMParser` 离线解析，不插入当前页面，不改表单，不触发提交或点击。上游的 `toast` / `notifyTaskCompletion` / `saveImportedCourses` 等桥调用全部没有移植 |
| 8 | 不硬编码秘密 | **过**。没有账号、密码、令牌、他人学号；唯一的主机字符串是公开的教务域名 |

另：给学生看的文字（warnings 与报错）已按 `docs/ux-writing.md` 自查，不出现「接口」「载荷」「脚本」「作息表」「学期设置」等词；
状态码写成「教务系统返回错误（代码 N）」；节次时间统一叫「节次时间」；改学期信息指向「学期管理」，教师 / 教室提醒只说「已按不显示…导入，请核对」，不指向「学期管理」。

## 4. 本批检查表（审计真抓到过的错，逐条自查）

1. **单/双标记归属**：`weeksOf` 按括号相对周次的位置区分前缀 / 后缀标记（`parse.js` 第 361–376 行），`(单)1-8周,(双)9-16周`
   读成 1-7 单周 + 10-16 双周；含挨着下一段、前面隔「第」的写法（`(单)第9-第16周`，先去「第」再判）。`week-markers` 钉住。
2. **「第 N-第 M 周」**：先去掉「第」再切段（第 340 行），与上游 `replace(/第/g, '')` 同义。`week-markers` 第 6 行钉住。
3. **「共 N 周」只剥备注**：`/共\s*[0-9]+\s*周?/g`（第 332 行），不照抄上游的 `共\s*\d+\s*.*$`（会吞后面的真实周次段）。
   `week-markers` 钉住末尾、括号里、开头三种位置。
4. **提醒限长**：所有带课名的提醒走 `shortName`（课名截 20 字）+ `sampleNames`（最多点 3 个）+ `warn`（单条 >200 字截断、最多 20 条）。
   `long-warnings` 用六门超长课名同时缺教师教室、四门超长实践课、超长的不认识周次原文、超长的括号备注钉住，整条均 ≤200 字。
5. **缺教师 / 缺教室**：照常导入（`teacher` / `location` 为 `null`），按课名去重汇总各出一条提醒。
6. **节次时间叫法**：提醒里统一说「节次时间」，没有「作息表」「空课默认作息」。
7. **模板残留**：见上文扫描，无残留。
8. **行号校准**：本文件行号按收尾时的当前文件逐条核对，大多数改用函数名引用。
9. **外壳只定义一次**：`extract.js` 的 `listIn`（第 224 行）是唯一的外壳定义，「有没有数据」（`rows.length`）与「挑字段」（`pickList`）共用；
   课表行本身认 `json.kbList`（`fetchTimetable` 里先校验必须是数组，否则报「没有返回课表数据」）。parse 里 `rowsIn` 对附加接口同样先认裸数组再认常见外壳。
10. **学期名**：用下拉框文本（`2026-2027`）拼成「2026-2027学年第一学期」，读不出来用「河北工程大学 第一学期」，不用适配器名。

## 5. 与模板件（`jsei`）的差异

1. 文件头、学校名（河北工程大学）、上游出处（`HEBEU/hebeu.js`，快照 `e15c627`，本校提交 `25dc738`，作者 Nanawwa）改为本件内容。
2. **站点根路径**：`jwUrl(path)` = `origin + '/' + path`，没有 `/jwglxt`；单入口，`allowHosts` 为空。
3. **节次时间表**：`SCHOOL_PERIOD_TIMES` 是上游 `HEBEU_FALLBACK_TIME_SLOTS` 的 10 节逐节照抄（08:30-09:15、09:20-10:05、
   10:25-11:10、11:15-12:00、14:00-14:45、14:50-15:35、15:55-16:40、16:45-17:30、19:00-19:45、19:50-20:35）；
   `BUILTIN_PERIOD_TIMES`（空课默认 12 节）只用于超出表长时补时间。
4. **节次时间请求的校区**：`xqh_id` 取第一门有校区号的课（`extract.js` 里 `campusId`），没有就不带；`jsei` 固定为 1。
5. **校历口径照本校上游**（`calendarInfo`）：周次要「从最小周次到最大周次连续」且最大周次在 10~60 才采用，否则不采用并提醒、总周数按 20；
   超过 30 周钳到 30 并提醒。开学日：取第 1 周那一行的日期，回退到当周周一（上游不回退，空课规范要求周一）；
   第 1 周行没有日期而别的周有日期时按周号倒推并提醒；日期与学期锚点相差超 45 天（`plausibleStart`）则整份校历作废并提醒。
6. **节次时间可信性**（`periodTimesOf`）：节次名必须是纯数字且 1~30（上游同样跳过其它行）；同一节重复且时间一样只留一条，时间不一样、
   时间倒挂、不从第 1 节起连续、时间重叠都视为没取到，整张回落学校 10 节表并提醒（上游遇到同一节不同时间是抛错回落，口径一致）。
7. **课表用到更晚的节次**：上游直接把那门课剔除；本件按 H3 逐节补上时间（内置表有且不早于上一节下课就用内置，否则顺推 5 分钟课间 + 45 分钟），课程照常导入并提醒。
8. **总周数**：上游课表比校历总周数更晚时是丢掉总周数；本件抬高总周数并提醒。
9. **提醒文案**：模板里与本校无关的提法已改成本校口径；补节次、缺教师教室、集中实践课、记录总数对账、括号备注等提醒沿用 `jsei` 的已审计写法。
10. **字段白名单**：多留 `jc`（上游 `row.jcs || row.jc`），实践课只留 `kcmc`。

## 6. 对上游的删改（都不牵涉安全问题，审阅者需要知道）

1. **两段式**：上游把取数、解析、保存写在一起；移植件切成 `extract.js`（只取数）与 `parse.js`（纯转换，CI 实跑）。
2. **弹窗与保存全部去掉**：`alertUser`（开场提示与结束提示）、`selectAcademicYearAndSemester`（默认学期 / 更换学期）、
   核对确认框（`showAlert`）、`saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig`、`toast`、`notifyTaskCompletion` 全部不移植；
   结果由 `parse.js` 的载荷承载，核对在应用的导入预览里做。
3. **学期选择**：改为读页面上当前的学年学期，提醒里说明「只导入了当前选中的学期，要导入别的学期请在教务页面里切」。
4. **主机名判断**：收紧为教务主机本身（见 §3 第 3 条）。
5. **`mergeAndDistinctCourses`**：上游逐字用官方 wiki 的实现（含展开符、箭头函数）；本件按 ES5 重写成等价的两阶段合并，前面多一步完全相同行的去重（见 §7）。
6. **学分 `xf`**：上游读 `row.xf` 写进课程的 `credit`；空课载荷没有学分字段，不带 `xf`。
7. **实践课预览**：上游在确认框里列出 `sjkList` 的课名与 `qsjsz`；本件只把课名汇总进提醒（不带 `qsjsz`）。
8. **缺作息的课程剔除**：见 §5 第 7 条，改为补时间。
9. **`normalizeText` 的全角转半角**：本件在 `weeksOf` 里用等价的 `fullWidthToHalf`（含全角数字、括号、逗号、各种破折号和「至」）。

## 7. 合并等价性（对齐上游 `mergeAndDistinctCourses`）

上游先按（课名、教师、教室、星期、周次串、起始节）排序，把「名称 / 教师 / 教室 / 星期 / 周次都相同且节次首尾相接」的合成一条，
重复的丢掉；再按（课名、教师、教室、星期、起始节、结束节）排序，把「名称 / 教师 / 教室 / 星期 / 起止节次都相同」的周次取并集。
本件 `dropExactDuplicates` → 排序（`orderStageOne`）→ `mergeStageOne` → 排序（`orderStageTwo`）→ `mergeStageTwo` 与之同口径：
阶段 1 只合并首尾相接的节次，重叠的节次保持原样（不丢课、不改任何一周的安排）；前面多出的去重只去掉「所有字段都一样」的行，
是为了防止「1-2、3-4、3-4」被合成「1-4」+「3-4」两块在 3-4 节重叠。`merge` 用例钉住：1-2 与 3-4 合成 1-4、周次并集、完全重复只留一条、
同课不同教室的相邻节次不合并。

## 8. 变异测试记录与冒烟

### 8.1 变异测试（8 处；在临时目录副本上改，脚本 `.test/port-batch18/hebeu/mutate.py`，改完均已还原，自检重新 PASS）

| # | 改坏哪一处 | 变红的用例 |
|---|---|---|
| 1 | 前缀单双标记不再贴到后一段（`if (!followsWeeks && leadsWeeks) return inner;` 改成 `if (false)`） | `week-markers` |
| 2 | 「共 N 周」改成上游的「共 + 数字 + 到结尾」贪婪写法 | `week-markers` |
| 3 | 同课合并不再要求节次首尾相接（`end + 1` 改成 `end + 2`） | `api-calendar`、`merge` |
| 4 | 校历第 1 周行没有日期时不再按周号倒推 | `cal-week1-empty` |
| 5 | 校历周次不连续也照样采用 | `cal-bad-weeks` |
| 6 | 提醒里的课名不截 20 字 | `long-warnings` |
| 7 | 节次名不是纯数字的行（「午休」）也收进节次时间 | `api-calendar` |
| 8 | 学校 10 节表第 4 节结束时间抄串（12:00 → 12:05） | `basic`、`cal-week1-empty`、`cal-bad-weeks`、`overweek`、`merge` |

另有一次 fixture 对账暴露的是期望的错而非代码的错：`long-warnings` 里括号备注点名时，`weeksOf` 先去掉「第」再摘括号，
所以点名文字是去掉「第」之后的 20 字截断；期望按这一实际口径（先去「第」、与上游一致）修正，不是改代码迁就。

### 8.2 fixtures（8 对，`expected` 由 `.test/port-batch18/hebeu/gen.js` 手写推演，生成器不调用 `parse.js`）

`basic`（学校 10 节 + 顺推补第 11、12 节、单双周、缺教师 / 教室、只有 `jc`、实践课、`xqmText` 为「1」按代号 3 认第一学期）、
`api-calendar`（教务节次时间与校历都取到、非数字节次跳过、带秒时间、校历第 1 周是周三回退周一、记录总数对账、脏行计数、合并与拆段、
第 9-10 节取空课默认节次时间）、`cal-week1-empty`（第 1 周无日期按第 2 周倒推）、`cal-bad-weeks`（校历不连续、节次时间倒挂作废）、
`overweek`（总周数从 20 抬到 22、夏季学期开学日）、`week-markers`（单/双标记归属与「共 N 周」剥离）、`merge`（同课合并）、
`long-warnings`（长课名提醒不超 200 字）。

### 8.3 浏览器冒烟（14 个场景，全部 OK，`smoke.py all`）

`direct`（课表页，不再取课表首页）、`term-switched`（页面上选中 2025-2026 第二学期，课表 / 节次时间 / 校历三个请求体都带 2025 / 12，开学日 2026-02-23）、
`other-page`（教务别的页面：先 GET 课表首页再 POST 取数）、`no-term`（读不到学期报错）、`loginpage`（登录页不发请求）、
`auth` / `portal`（同校统一认证、门户子域名不发请求）、`site`（第三方页面不发请求）、`expired`（登录页 HTML → 登录已过期）、
`notjson`、`http500`（报「代码 500」）、`aux-fail`（节次时间与校历都挂：课表照样交出，回落学校 10 节并提醒）、
`no-campus`（节次时间请求不带 `xqh_id`）、`empty`（没有排课行：不发后两条请求，parse 报「没有解析到任何课程」）。
每个场景都检查：请求主机 = 教务主机、路径无 `/jwglxt` 前缀、方法正确、请求体不含个人信息、交出去的 JSON 里没有学号 / 身份证号 / 手机号 / 教室 ID 等。

## 9. 已知风险与未验证项

- **我们没有本校账号，真机没验过。** 所有 fixture 与冒烟数据都是按上游读取的字段形状合成的，只保证「同样输入永远同样输出」，
  不保证解析在真实教务页面上是对的。
- 上游兜底节次表注明是「2026-2027 学年第 1 学期自教务实测，xqh_id=108」；不同校区 / 不同学期的真实节次时间是否一致未验证。
  教务接口取到时以教务为准，取不到才用这张表，并在提醒里说明。
- 学期代号（3 = 第一学期、12 = 第二学期、16 = 第三学期）是正方通用约定；本校下拉框文本若是别的写法（如整句「2026-2027学年第一学期」放进学期框），
  `termName` 已兼容，但没有真机核对。
- 校历接口返回的字段名（`zs` / `rq` / `zcrq` / `ksrq`）按上游代码推定；校历形态与预期不符时，退回推算开学日并提醒，不会静默写错。
- 把入口收紧到 `jwglxxfwpt.hebeu.edu.cn` 单一主机：若学生是从学校另一个教务入口域名（如 WebVPN 映射、新旧域名并存）打开课表，会收到
  「当前页面还不是河北工程大学教务系统」的提示。上游 `adapters.yaml` 只有这一个入口，且 `allowHosts` 为空本来也只放行这个主机，因此保持一致；
  若以后确认有第二入口，需要同时改 `JW_HOST` 判断与 manifest 的 `allowHosts`。
- 课表首页读学期失败（页面改版）时只能报错；不会弹窗问用户选学期。
- 一个学期的课超过 30 周时总周数钳到 30，更晚周次会被丢弃并提醒（载荷上限）。

## 10. 签名

0x7E7-2023（sonnet 移植，2026-10-26）
