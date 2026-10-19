# 安全审计 —— 河北经贸大学（正方教务 V9，jwglxt，经学校 WebVPN 映射主机访问）

审计对象：`jw-adapters/hueb/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `HUEB/hueb.js`（快照 commit `c4a35feb061a3f6db2d6c122927083c067c61309`，2026-10-19 拉取，MIT，作者 Haooz；本校脚本最后一次修改 `80e30cf5990f1166210b8af6b72bed71667232ca`，2026-09-23）。

审计方式：逐行读上游脚本 + 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-19 运行，扫描脚本未入库）：

- 绝对 URL：`parse.js` 与 `extract.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，都是写上游出处的注释，不是请求。`extract.js` 第 13 行的 `https://202-206-194-100.vpn.hueb.edu.cn:8118` 同样只在注释里（说明上游把该主机写死），代码里没有任何绝对地址。
- 网络调用：只有 `extract.js` 第 68 行的 `fetch(url, options)`，位于 `request` 函数里（第 57 行起）。第 63 行的 `X-Requested-With: XMLHttpRequest` 是请求头里的字符串，不是 XHR 对象。`parse.js` 里没有任何网络调用。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` / `sendBeacon` / `new WebSocket` / `EventSource` / `new Image` / `innerHTML` / `appendChild` / `.submit` 全部无命中。`parse.js` 里没有 `document.` / `window.` / 桥调用（check.js 的纯函数检查通过）。
- 模板件字样：`parse.js`、`extract.js`、`manifest.json` 与 `fixtures/` 检索模板件的目录名与学校名，零命中；本文件只在 §4 的对比语境里有意提到模板目录名。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、展开符、模板串、`new Set` / `new Map` / `Array.from`、`URLSearchParams`、可选链、后行断言与命名捕获组，在 `parse.js`、`extract.js` 全文中全部无命中（check.js 与人工各查一遍）。
- 控制字节与 BOM：`parse.js`、`extract.js`、`manifest.json`、`AUDIT.md` 与 `fixtures/` 下的 16 个文件，共 20 个文件，无控制字节、无 BOM（check.js 逐字节扫描通过）。

## 0. 上游问题：文件头校名写错（任务卡点名，必须记一笔）

上游 `HUEB/hueb.js` 第 1 行写的是「湖北工程学院(vpn.hueb.edu.cn)」，但同一目录 `adapters.yaml` 的
`adapter_name` 是「河北经贸大学正方教务」、`import_url` 是 `https://202-206-194-100.vpn.hueb.edu.cn:8118/...`，
域名 `hueb.edu.cn` 也是河北经贸大学。**本移植件以 `adapters.yaml` 为准，全件使用「河北经贸大学」**：
`manifest.name`、`parse.js` 的学期名兜底常量 `SCHOOL_NAME`、所有给学生看的文案。上游文件头的校名应是笔误，
脚本内容（正方 jwglxt 三条同源请求）与 `adapters.yaml` 一致，不影响移植。

## 1. 请求域与请求清单（与代码逐条对应）

上游 `HUEB/hueb.js` 里有三个绝对 URL，主机都是 `https://202-206-194-100.vpn.hueb.edu.cn:8118`：学年学期首页（GET，N2151，第 187 行）、
学期周次校历（POST，N2154，第 294 行）、课表接口（POST，N2151，第 343 行），另有上游硬编码的 13 节 `TimeSlots`（第 392 行）。
这台主机是**学校 WebVPN 的映射域名**（`202-206-194-100` 是网关把内网地址重写成的子域，不是裸 IP），端口 `8118`。
移植件把主机名与端口全部去掉了：四条请求的地址都由 `window.location.origin + '/jwglxt'` 拼出来（上下文路径跟着当前地址走，见 `extract.js` 第 45 行 `jwBase`）。
所以**主机只有用户当前所在的那一个教务主机**，正常就是 `loginUrl` 的主机 `202-206-194-100.vpn.hueb.edu.cn:8118`，不需要也没有额外放行的域。
**`allowHosts` 为空数组（manifest 第 14 行），不写通配。** `scheduleUrlHint` 写的是带 `:8118` 的课表页地址（manifest 第 10 行），宿主靠它给这个 origin 注入桥。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<origin>/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的学年学期字段（`#xnm` / `#xqm`）。**页面上已经有这两个字段时跳过这一步** | 报错，提示重新登录后再点「提取课表」 |
| extract.js | POST | `<origin>/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数。请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`，与上游逐字一致 | 报错，提示重新登录 |
| extract.js | POST | `<origin>/jwglxt/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | 取校区作息。请求体 `xnm` / `xqm` / `xqh_id`，`xqh_id` 取自课表行 | 交 `null`，parse 回落到**本校上游那张 13 节表**；课表用到更多节次时按本文件 §5 第 4 条补时间，并写进 `warnings` |
| extract.js | POST | `<origin>/jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取学期周次校历，定开学日与总周数。请求体 `xnm` / `xqm` | 交 `null`，parse 回落到推算并写进 `warnings` |

与上游的差别：

- 上游每次导入都先请求学年学期首页（`selectAcademicYearAndSemester` → `fetchAcademicOptions`，第 187 行），用来生成两个选择框的选项。
  移植件改成：页面上读得到 `#xnm` / `#xqm` 就不发这条请求，读不到才去取一次首页（`extract.js` 第 147 行起，`DOMParser` 离线解析，不插入当前页面）。
- 上游把 WebVPN 映射主机与端口写死在三个 URL 里；移植件一律用 `window.location.origin`（第 45–50 行），网关换端口或换映射域名时不用改代码。
- 上游的校历请求体是 `xnm=…&xqm=…`（第 295 行），移植件一致。
- 作息请求（cxRjc）是**上游没有的**：上游整个脚本没有作息接口，只有一段硬编码的 `TimeSlots`（第 392–406 行），并且只在导入成功后调用 `savePresetTimeSlots`（第 410 行）。
  移植件按本批公共说明多取一条同模块作息接口，菜单号用 `N2151`（课表菜单本身，与课表接口同一个菜单），请求体带 `xqh_id`；取不到就用上游那张 13 节表。
- 两条附加请求（作息、校历）失败不影响导入：`optionalJson`（`extract.js` 第 190 行）把任何失败（非 2xx、网络错误、JSON 解析失败）都吞成 `null`，由 parse.js 回落，回落这件事会出现在导入预览的 `warnings` 里。
- 请求头统一带 `Content-Type`、`X-Requested-With`、`Accept`，不带任何自定义令牌。凭据用 `credentials: 'include'`，让 WebView 按同源规则带 Cookie；脚本既不读 Cookie，也不把它发到别处。
- `parse.js` 不发任何请求（CI 里用 Rhino 实跑，是纯函数）。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 与下拉框文本） | 课表页的 `#xnm` / `#xqm`，或课表首页 HTML（`DOMParser` 解析的离线文档，不插入当前页面） | 带出（学期名要用） |
| 排课行 `kbList` | 课表接口 | 带出**白名单字段**：`kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd`、`xqh_id`（`KB_FIELDS`，`extract.js` 第 210–226 行）。`xqh_id` 是校区号，任务卡要求随行交出，不含个人信息 |
| 集中实践课 `sjkList` | 课表接口 | 只带 `kcmc`（`PRACTICE_FIELDS`）。它没有固定星期与节次，排不进周课表，但不能吞掉：写进 `warnings` 让用户自己加 |
| 校区作息 | cxRjc | 带出（载荷的 `periodTimes`），取不到为 `null` |
| 学期周次校历 | cxZcByXnxq | 交给 parse 只用来算开学日与总周数，不进入载荷 |
| 记录总数（响应里有才有） | 课表接口 | 只用于对账，不进入载荷 |
| 学生个人信息（课表响应里夹带的 `xsxx`、学号、姓名、学院等） | 课表接口 | **不带出，也不进 fixture**：`extract.js` 只按白名单挑字段。桩测试把 `xsxx`（含学号与学院）混进响应，交出的字符串里检索不到 |

`parse.js` 实际读的字段：排课行 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd`（`xqh_id` 不参与解析）；实践课 `kcmc`；
`periodTimes` 的 `jcmc` / `jc` 与 `qssj` / `jssj`；`calendar` 的 `zs` / `zsmc` 与 `zrq` / `zcrq` / `rq` / `ksrq`；`total`；`today`；`term.*`。

不读的东西（静态扫描无命中）：`password` / `pwd` / 登录表单、`localStorage` / `sessionStorage` / Cookie、成绩（`/cjcx/*`）、学籍、个人信息、缴费，以及任何其它模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问。唯一的「凭据」是浏览器自带的会话 Cookie，脚本既不读它也不外发。上游的开场公告弹窗（`showAlert`）、两个学年学期选择框（`showSingleSelection`，第 265 / 275 行）、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 都没有移植：学年学期改成读页面上的 `#xnm` / `#xqm`，不向用户问任何东西 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js`，地址由 `window.location.origin` 拼成。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单，也没有第三方域（唯一的绝对 URL 是文件头里写上游仓库与上游主机的注释，不是请求） |
| 3 | 请求域可控 | **过**。请求主机只有一个，即用户当前打开的教务主机（正常是 `202-206-194-100.vpn.hueb.edu.cn:8118`，学校 WebVPN 的映射域名，不是裸 IP）。`allowHosts` 留空，不写通配；代码里没有写死的主机名或端口 |
| 4 | 只读课表 | **过**。四条请求全部落在 `/jwglxt/kbcx/*`（课表页、课表接口、作息、周次校历），不碰成绩、学籍、个人信息、缴费。课表响应里夹带的学生信息一律不带出；作息与周次校历是学校公共数据，不含个人信息 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，也没有图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`extract.js` 第 102 行 `jsonOf`） |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的值。取课表首页用的是 `fetch` + `DOMParser`，离线解析，不插入当前页面，不改表单，不触发提交或点击。上游的桥调用全部没有移植，源码里也没有 OCR 或提问桥的调用 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。脚本里的常量只有正方上下文路径 `/jwglxt`、两个菜单号 `N2151` / `N2154`，都是页面上可见的参数 |

## 4. 与模板 lcudcc 的差异（模板目录只读，本件未改动）

1. **作息表多一张学校表**：模板只有空课默认 12 节（`BUILTIN_PERIOD_TIMES`），教务取不到就整张用它；
   本件按上游 `TimeSlots` 增加 13 节的 `SCHOOL_PERIOD_TIMES`（`parse.js` 第 55–69 行，逐节照抄：第 6 节 14:00–14:45、第 13 节 20:40–21:25），
   取不到时整张用学校表。空课默认 12 节仍保留，只用于 H3 口径里「课表超出作息表」的逐节补时间（第 73–86 行、第 778–800 行）。
2. **学期名兜底带学校名**：照 `shzq` 的写法，学年读不出来时用「河北经贸大学 第 X 学期」，不用适配器名（`parse.js` 第 233–245 行）。
3. **交出去的行做字段白名单**：模板把 `kbList` 行原样交出；本件只挑七个字段，`sjkList` 只挑 `kcmc`（`extract.js` 第 210–226 行定义、第 241–242 行使用）。
4. **缺教师 / 缺教室有汇总提醒**：模板把这两类课照常导入为 `null` 后一声不吭；本件按课名去重计数（`missingTeacherCourses` / `missingLocationCourses`，第 531–533 行），在跳过的行之后汇总成一条提醒并点名最多 3 门课（第 918–934 行），课名走 `shortName` 截到 20 字。
5. **提醒里点名的课名截到 20 字**：新增 `shortName`（第 103 行），集中实践课的课名列表、「认不出的周次写法」与缺教师/缺教室的课名都用它截短，整条提醒再由同一个 `warn()` 收口到 200 字（第 197 行）。模板只兜总长，不截课名。
6. **WebVPN 映射主机**：`loginUrl` / `scheduleUrlHint` 写带 `:8118` 的映射域名；脚本不写死主机，用同源相对路径。
7. **周次解析修两处模板缺陷（同批统一，五件同源问题）**：
   ① 单/双括号按相邻关系先归属（`parse.js` 第 326–331 行）：模板把靠前的 `(单)` 按「就近向后找数字」并给 `1-8`，靠后的 `(双)` 又「就近向前找」也并到同一段，`(单)1-8周,(双)9-16周` 于是变成 `1-16` 每周都上；现在在通用括号处理之前，先把紧挨数字的 `(单)` / `(双)` 折成 `单1` / `8单`，标记各自跟着自己那一段走。独立成段的标记仍走原来的就近逻辑。
   ② 剥离「共 N 周」备注（`parse.js` 第 318 行）：`1-15周(单) 共16周` 里的「共16周」是课程总周数说明，不是上课周次；模板（以及本件第一版）会把里面的 16 当成第 16 周排课。复核确认只许剥备注本身（`共 + 数字 + 可选「周」`）：若从第一个「共」一路删到行尾，`1-8周(共8周),9-16周` 会丢掉 9-16 周，`共16周,1-15周(单)` 整行丢课。
   `fixtures/week-markers` 钉住五条写法（前缀单双、后缀单双、「共16周」在末尾、在括号里、在开头）。
8. 其余层（取数三连与请求体、`#xnm` / `#xqm` 读取、周次四写法与括号序号、节次多写法、两阶段合并 + 完全重复行、开学日回退周一与可信度判断、总周数收紧、H3 补时间、warnings 收口）与模板一致。

## 5. 上游里删掉 / 改掉的东西及理由

1. **删掉「拾光」桥调用**：`shiguangBridgePromise.showAlert` / `showSingleSelection` / `saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` 与 `shiguangBridge.showToast` / `notifyTaskCompletion`（上游第 176、258、265、275、378、384、387、410、416、422、441、446、448、453、454 行）。空课里由宿主负责保存，适配器只交载荷；这些桥在空课里不存在。
2. **删掉弹窗选学年学期**：上游 `showSingleSelection` 会打断用户（第 265 / 275 行）。改成读页面上的 `#xnm` / `#xqm`（移植手册 §3 第 1 步）。
3. **整行丢课改为计数**：上游 `parseJsonData` 第 141–143 行要求 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` 六个字段全非空，缺教师或缺教室的课整行丢掉。移植件只要求课名、星期、节次、周次；教师与教室没有就留 `null`，跳过的行按原因计数写进 `warnings`（手册 §4.7）；缺教师 / 缺教室的已导入课也按类型汇总计数、点名最多 3 门课写进 `warnings`（`fixtures/missing-fields` 钉住）。
4. **周次解析修正**：上游 `parseWeeks`（第 91 行）只认 `/(\d+)-(\d+)周/` 与 `/^(\d+)周/`，`1-16(单周)` 一个都匹配不上，整段周次塌成空数组、这门课被静默丢掉；括号里的教学班序号（如 `(1)`）会被当成第 1 周。移植件认四种写法、先摘括号序号再找周次，并把摘掉的东西计数写进 `warnings`。
5. **节次解析放宽**：上游 `jcs.split('-')` 认不出 `第9-10节`、`1,2`、两位一拼的 `0102`（会把 `0102` 读成第 102 节），多段只取首尾。移植件按 `parse.js` 第 427 行 `sectionsOf` 处理，多段按最大跨度放入并在 `warnings` 里说明。
6. **开学日**：上游 `fetchSemesterStartDate` 把 `rq.split('/')[0]` 原样当开学日（第 315 行），不回退到周一、不判断是不是别的学期；找不到第 1 周时拿 `json[0]` 顶替。移植件用 `isoOfAny` 认多种日期写法，回退到那一周的周一（手册 §4.3），并检查日期是否落在本学期的合理窗口内（`parse.js` 第 265 行 `plausibleStart`），可疑就忽略并推算。
7. **总周数**：上游写死 `semesterTotalWeeks: 20`；移植件优先用校历，课表里更晚的周次会把总周数抬上去，抬了都写进 `warnings`。
8. **作息**：上游只有硬编码 `TimeSlots`（第 392–406 行）且只在导入成功后存预设。移植件先请求 cxRjc；取不到才用上游那张 13 节表，并把「用的是内置节次时间」写进 `warnings`。
9. **主机不写死**：上游三个 URL 都带 `https://202-206-194-100.vpn.hueb.edu.cn:8118`，移植件全部改成同源相对路径。
10. **学生信息**：上游把整个课表响应交给自己的解析函数（不涉及外发）；移植件按字段白名单挑，`xsxx` 等一律不交出去。

## 6. 变异测试记录

变异改的是**副本**：每个副本在临时目录里是整目录复制（目录名同样是 `hueb`，否则 check.js 会因 `manifest.key` 与目录名不一致报错），只替换副本的 `parse.js`，真文件 `jw-adapters/hueb/parse.js` 没有被变异脚本写过。每条替换要求恰好命中 1 次。每个副本都跑 `check.js`，记录哪些 fixture 变红。变异副本收尾时已删除，未入库。

| 变异 | 改了什么（真文件行号） | 变红的 fixture | 变红的表现 |
|---|---|---|---|
| M1 | 第 68 行学校作息表第 13 节结束时间 `21:25` 改为 `21:20` | 4：basic、merge-consecutive、no-calendar-overweek、long-warnings | `periodTimes[12].end` 实际 `21:20`、期望 `21:25`；H3 顺推出来的第 14 节也跟着错。calendar-weekday、missing-fields 与 api-calendar 不红：它们的作息来自教务接口 |
| M2 | 第 50 行顺推课间 `EXTEND_BREAK_MINUTES = 5` 改为 `15` | 1：basic | 第 14–15 节从 21:30–22:15 / 22:20–23:05 变成 21:40–22:25 / 22:40–23:25 |
| M3 | 第 49 行 `NAME_TEXT_LIMIT = 20` 改为 `200`（课名不截断） | 2：long-warnings、missing-fields | 集中实践课与缺教师/缺教室的提醒里出现完整长课名，周次原文也不再截短 |
| M4 | 第 890 行 `pn < 3` 改为 `pn < 4`（集中实践课提醒里点名 4 门课） | 1：long-warnings | 提醒里多点了「创新创业训练与学科竞赛实践」，与期望不符 |
| M5 | 第 921 行 `if (missingTeacher > 0 \|\| missingLocation > 0) {` 改为 `if (false) {`（缺教师 / 缺教室的汇总提醒整段不出现） | 3：basic、long-warnings、missing-fields | 课照常导入，但提醒少了「有 N 门课没给上课教师……」那一条，后面的提醒位置整体前移 |
| M6 | 第 326、329 行两处单/双括号归属正则改成永不匹配（标记回到通用括号处理） | 1：week-markers | `(单)1-8周,(双)9-16周` 被并成 1-16 每周都上（实际 blocks 长度 1、endWeek 16、weekType ALL），并多出一条「单双同时出现」提醒 |
| M7 | 第 318 行「共 N 周」剥离改回「从第一个共删到行尾」的宽正则 | 1：week-markers | 课程数 4（应为 5）：`共16周,1-15周(单)` 整行被丢；`1-8周(共8周),9-16周` 的 endWeek 实际 8（应为 16），9-16 周丢失；另多一条跳过行的提醒 |

**还原校验**：变异前后各查一次真文件的 SHA-256，三段完全一致 —— `parse.js` = `91e1064b588fddb14842ebc69750ade7a9484320e37f00c463e3d344e37de1eb`、
`extract.js` = `add5143e24bf0b351fdec21a32bed4307a63c045a0d19870af8e331f21c6badc`、`manifest.json` = `39b45d5c665271ea0e7c38b49a260b9ff91702b84e43e84c8f12a46cc4d42cd2`。
真文件跑 `check.js` 结果 `RESULT: PASS`，8 个 fixture 全部 MATCH。

## 7. fixtures 与自检

8 对合成用例（`_note` 里写明是编造的，课程、教师、教室均为虚构，无真实个人信息）：

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 作息取不到 → 13 节学校表逐节钉住（含第 6 节 14:00–14:45、第 13 节 20:40–21:25）；课表排到第 15 节 → H3 顺推补 14–15 节；校历取不到 → 推算开学日、20 周；单双周、无教师、无教室、完全重复行、集中实践课 |
| `merge-consecutive` | 同课同日同教室 1-2 与 3-4 合并成 1-4；1-8 周与 9-16 周取并集为 1-16；完全重复的 3-4 行只留一条 |
| `calendar-weekday` | 校历第 1 周给周三 2026-09-09 → 开学日回退到周一 2026-09-07；教务作息可用 → 直接用教务的 13 节 |
| `no-calendar-overweek` | 校历取不到、课表最大周次 21 → 总周数抬到 21 并说明 |
| `long-warnings` | 超长课名 + 缺教师 / 缺教室 / `xm` 取不到 → 不丢课（`null`）；4 门超长课名的实践课、2 行认不出的周次 → 提醒汇总、课名截到 20 字、每条不超 200 字 |
| `missing-fields` | 缺教师 / 缺教室专项：两门课缺教师、两门课缺教室（体育两项都缺，且同名体育排了两个时段）→ 照常导入为 `null`，一条按类型汇总的提醒点名 3 门课（长课名截到 20 字），按课名去重、同一门课只点一次 |
| `week-markers` | 单/双标记归属与「共 N 周」剥离：`(单)1-8周,(双)9-16周` 与 `1-8周(单),9-16周(双)` 都解析成 1-7 单周 + 10-16 双周；`1-15周(单) 共16周` 只读 1-15 单周；`1-8周(共8周),9-16周` 只剥括号备注、9-16 周不丢；`共16周,1-15周(单)` 只剥开头备注、不整行丢课 |
| `api-calendar` | 第二学期；教务作息与校历都取到；记录总数对账（说 12 条实际 7 行）；缺星期 / 缺节次 / 缺周次三种脏行；节次多段；周次从 0 开始与 31 周各丢一个；课表排到第 30 周顶高总周数 |

自检：`node .test/port-batch5/tools/check.js D:/NullClass/jw-adapters/hueb` 最后一行 `RESULT: PASS`，8 个 fixture 全部 MATCH。
8 份期望文件里最多 8 条 `warnings`（`api-calendar`），单条最长 116 字（`long-warnings`），都没有触到 20 条 / 200 字的硬上限。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **真实部署未验证**：河北经贸大学是否有 cxRjc（作息）与 cxZcByXnxq（校历）两个菜单，没有账号无法验证。取不到就是 `null`，回落并写 `warnings`，不影响导入。
2. **WebVPN 映射主机与端口**取自上游 `adapters.yaml`（`202-206-194-100.vpn.hueb.edu.cn:8118`）。脚本本身同源，不依赖这两个值；但宿主要靠 `scheduleUrlHint`（带 `:8118`）给该 origin 注入桥，若学校更换映射域名或端口，manifest 这两行要跟着改。
3. **课表接口的真实响应形状**：fixture 是合成的（按上游脚本实际读取的字段形状编），只保证同样的输入永远得到同样的输出，**不保证解析在真实页面上是对的**。拿到真实响应后替换 fixture 并重跑 `check.js`，是最高优先级。
4. **13 节作息表来自上游 `TimeSlots`**，逐节照抄，没有与学校实际作息核对过。教务作息接口取得到时以教务为准；取不到时导入预览会提示核对。
5. **上游文件头校名写错**（见 §0）：本件按 `adapters.yaml` 用「河北经贸大学」；如果上游后续修正，不影响本件。
6. **上游的日期解析分支**：上游对校历日期依次试 `rq`（按 `/` 切第一段）、`zcrq`、`ksrq`；移植件用 `isoOfAny` 统一认 `yyyy-MM-dd` / `yyyy/MM/dd` / `yyyy.MM.dd`（只取年月日），没有专门造一个 `rq` 用斜杠分隔多日期的用例（上游那种写法在真实响应里没见过）。
7. **warnings 到 20 条后的截断**只有代码阅读，没有 fixture（正常路径下这些计数不会同时爆满）。

## 9. 签名

移植与审计：0x7E7-2023（haiku 移植，2026-10-19）。
上游出处：`shiguang_warehouse` → `resources/HUEB/hueb.js`（快照 commit `c4a35feb061a3f6db2d6c122927083c067c61309`，2026-10-19 拉取；本校脚本最后修改 `80e30cf5990f1166210b8af6b72bed71667232ca`，2026-09-23，MIT，作者 Haooz）。
