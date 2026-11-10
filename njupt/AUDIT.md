# 安全审计 —— 南京邮电大学（正方教务 V9，根相对路径，经智慧校园 / WebVPN 通道访问）

审计对象：`jw-adapters/njupt/` 下的 `extract.js` / `parse.js` / `manifest.json` 与 `fixtures/`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `NJUPT/njupt_01.js`（快照 commit `baf83fa7972d4be6627c534992f7d2da399a0945`，2026-11-10 拉取，
MIT，作者 kemi-20，`adapters.yaml` 的 `adapter_id` 是 `NJUPT_01`；**本校脚本最后一次修改 `b54f40c`**，用
`git -C .../sgw-latest log -1 --format=%h -- resources/NJUPT/njupt_01.js` 核对过，与任务卡一致）。

审计方式：逐行读上游脚本（362 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果：

- 绝对 URL：`parse.js` 与 `extract.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，都是写上游出处的注释，不是请求。
  代码里**没有任何绝对地址**（`grep -n http` 只命中这两行注释）。请求地址都是根相对路径，由当前页面的 origin 决定。
- 网络调用：只有 `extract.js` 第 48 行起的 `request` 函数里那一个 `fetch(url, options)`。`parse.js` 没有任何网络调用（check.js 的纯函数检查通过）。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval(` / `new Function` /
  `sendBeacon` / `WebSocket` / `EventSource` / `new Image` / `innerHTML` / `appendChild` / `.submit` 全部无命中。
  `parse.js` 里没有 `document.` / `window.` / 桥调用（只读宿主注入的 `__ncInput`）。
- `allowHosts`：`["i.njupt.edu.cn"]`，无通配（check.js 通过）。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class `、`async`/`await`、展开符、模板串、`new Set` / `new Map`、
  `Array.from`、`padStart`、`includes` / `startsWith`、可选链、后行断言与命名捕获组在 `parse.js`、`extract.js` 全文中全部无命中。
- 控制字节与 BOM：全件 20 个文件（`extract.js`、`parse.js`、`manifest.json`、本文件 + 16 个 fixture）逐字节扫描通过。
- 模板残留：`parse.js` / `extract.js` / `manifest.json` / `fixtures/` 里搜不到模板学校的校名、主机、key 与上游路径
  （本文件只在「与模板的差异」一节里有意写「照模板 hueb」，代码里不留）。

## 0. 任务卡之外我自己读出来的东西（与模板不同构之处）

上游 `njupt_01.js` 是正方 V9 的**接口式**脚本，和模板 `hueb` 同族，但有三处实质不同，移植时都按上游代码办：

1. **地址是根相对路径**。上游 `getNjuptApiBasePath()`（第 162–170 行）先判断
   `/（kbcx|xtgl）/` 在不在 `location.pathname` 里，在就返回**空串**，三条请求因此都是 `'' + '/kbcx/...'`。
   上游注释写明原因：南邮 WebVPN 会拦截并改写根相对请求，若传已经带 WebVPN 哈希前缀的完整地址，
   会被二次改写成「当前页面.htm/kbcx/...」。**移植件照抄**（`extract.js` 第 37 行 `var BASE = ''`），
   不拼 `window.location.origin`，也不拼 `/jwglxt`（模板的做法）。
2. **没有作息接口**。上游只有一张写死的 12 节表 `NJUPT_TIME_SLOTS`（第 4–17 行），从不请求节次时间。
   模板多取一个 `cxRjc`，本件按「只有写死表的就用写死表」把那张表逐节抄进 `parse.js`（第 57–70 行），**不请求**。
3. **上游会弹两次学年学期选择框**（`selectAcademicYearAndSemester`，第 235–268 行）：先 GET 课表首页读 `#xnm` / `#xqm`
   的选项，再 `showSingleSelection`。移植件改成读页面下拉框里标了 `selected` 的那一项；两个框都没标就取第一项，
   并把「这不是用户选中的学期」写进提醒（模板只是静默取第一项）。

## 1. 请求域与请求清单（与代码逐条对应）

上游三个请求都在当前教务主机下，脚本里没有写死任何主机名。移植件同样：地址全是根相对路径
（`extract.js` 第 37 行 `BASE = ''`，第 165 / 184 / 149 行拼成 `/kbcx/...`），由浏览器按当前页面的 origin 解析，
再交给学校 WebVPN 改写。**So 主机只有用户当前所在的那一个教务主机**（正常就是 `loginUrl` 的主机 `i.njupt.edu.cn`）。
`allowHosts` 写 `["i.njupt.edu.cn"]`（与 `loginUrl` 同主机，算是把「脚本会打这个域」写明），不写通配。
`scheduleUrlHint` 是课表页的完整地址（manifest 第 10 行）。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | POST | `/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数。请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`，与上游第 294 行逐字一致 | 报错：`教务系统没有返回课表数据（返回的内容格式不对）…请重新登录` |
| extract.js | POST | `/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取学期周次校历，定开学日与总周数。请求体 `xnm=…&xqm=…`，与上游第 273 行一致 | 交 `null`，parse 回落到推算并写进 `warnings` |
| extract.js | GET | `/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的 `#xnm` / `#xqm` 两个下拉框。**页面上已经有这两个字段时跳过这一步**（正常路径下这条请求不发） | 报错：`没读到学年学期…请重新登录并打开「学生个人课表」` |

与上游的差别：

- 上游每次都先 GET 课表首页生成选择框选项（`fetchAcademicOptions`，第 187 行）；移植件只在当前页读不到 `#xnm` / `#xqm`
  时才补这一次 GET，且用 `DOMParser` 离线解析，不插入当前页面。
- 上游的两条附加请求只有校历一条（本件一致）。作息请求模板有、本件没有（见 §0 第 2 条）。
- 两条 POST 都带统一请求头 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、
  `Accept: */*`（上游课表请求只带 Content-Type，校历请求带另外两个，这里一律带上，不改请求语义）。
- 凭据用 `credentials: 'include'`，让 WebView 按同源规则带 Cookie；脚本既不读 Cookie，也不把它发到别处。
- 校历请求失败（非 2xx、网络错误、JSON 解析失败）一律吞成 `null`（`extract.js` 第 184–192 行 `fetchCalendar`），
  绝不因为校历取不到就导不进课表。
- `parse.js` 不发任何请求（CI 里用 Rhino 实跑，是纯函数）。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 与下拉框文本） | 页面的 `#xnm` / `#xqm`，或课表首页 HTML（`DOMParser` 解析的离线文档） | 带出（学期名要用） |
| 学期是不是页面标了「选中」的那一项（布尔 `selected`） | 同上，`option.selected` | 带出（只用来决定提醒怎么写） |
| 排课行 `kbList` | 课表接口 | 带出**白名单字段**：`kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd`（`KB_FIELDS`，`extract.js` 第 205 行）。上游也用这六个 |
| 集中实践课 `sjkList` | 课表接口 | 只带 `kcmc`。上游不读这一项；本件保留模板的做法：有就提醒用户自己加，不吞掉 |
| 学期周次校历 | cxZcByXnxq | 交给 parse 只用来算开学日与总周数，不进入载荷 |
| 记录总数（响应里有才有） | 课表接口 | 只用于对账，不进入载荷 |
| 今天的日期 | 脚本本地时间 | 带出（`today`），只在学年读不出来、要按今天推算时用 |
| 学生个人信息（课表响应里夹带的 `xsxx`、学号、姓名、身份证号、手机号等） | 课表接口 / 页面 | **不带出，也不进 fixture**：`extract.js` 只按白名单挑字段；桩跑把 `xsxx`（含学号、身份证号）混进响应，交出的字符串里检索不到 |

`parse.js` 实际读的字段：排课行 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd`；实践课 `kcmc`；
`calendar` 的 `zs` / `zsmc` 与 `zrq` / `zcrq` / `rq` / `ksrq`；`total`；`today`；`term.*`。

不读的东西（静态扫描无命中）：`password` / 登录表单、`localStorage` / Cookie、成绩（`/cjcx/*`）、学籍、个人信息、缴费，
以及任何其它模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问。唯一的「凭据」是浏览器自带的会话 Cookie，脚本既不读它也不外发。上游的开场公告弹窗、两个学年学期选择框、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 都没有移植 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js` 的 `request` 里，地址是根相对路径，只会打到当前教务主机。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单，也没有第三方域 |
| 3 | 请求域可控 | **过**。请求主机只有一个，即用户当前打开的教务主机。`allowHosts` 只写 `i.njupt.edu.cn`，不写通配；代码里没有写死的主机名或端口 |
| 4 | 只读课表 | **过**。三个请求全部落在 `/kbcx/*`（课表接口、周次校历、课表页），不碰成绩、学籍、个人信息、缴费。课表响应里夹带的学生信息一律不带出 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，也没有图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`extract.js` 第 88 行 `jsonOf`） |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的 `option`；取课表首页用 `fetch` + `DOMParser`，离线解析，不插入当前页面，不改表单，不触发提交或点击。上游的桥调用全部没有移植 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。常量只有两个菜单号 `N2151` / `N2154`、上下文前缀空串 `BASE`，都是页面上可见的参数 |

## 4. 与模板 hueb 的差异（模板目录只读，本件未改动）

1. **地址不拼 origin**：模板用 `window.location.origin + '/jwglxt'`；本件按上游用根相对路径（`BASE = ''`，`extract.js` 第 37 行），
   否则南邮 WebVPN 会二次改写（见 §0 第 1 条）。
2. **只有三条请求、没有作息接口**：模板有 `cxRjc` 并按它决定节次时间；本件不请求，整张用上游那 12 节（`parse.js` 第 57–70 行，
   逐节照抄：第 1 节 08:00–08:45、第 2 节 08:50–09:35、第 3 节 09:50–10:35、第 4 节 10:40–11:25、第 5 节 11:30–12:15、
   第 6 节 13:45–14:30、第 7 节 14:35–15:20、第 8 节 15:35–16:20、第 9 节 16:25–17:10、第 10 节 18:30–19:15、
   第 11 节 19:25–20:10、第 12 节 20:20–21:05），并删掉模板的 `periodTimesOf` / `timeOf` / 空课默认 12 节表。
   课表用到第 13 节及以后时按 H3 顺推（课间 5 分钟、每节 45 分钟，越过 23:59 就停），补了哪些写进提醒（`parse.js` 第 748–760 行）。
3. **学期回落要说实话**：`extract.js` 多交一个 `selected` 布尔（`readSelect` 第 99 行记录这一项是不是教务标的），
   `parse.js` 第 763–775 行据此二选一：标了写「只导入了教务系统当前选中的学期」，没标写「已按列表第一项（…）导入」。
4. **占位词当没有**：教师 / 教室写成「未知」「暂无」「待定」时交出去是 `null`（`parse.js` 第 102–107 行 `PLACEHOLDER` / `realText`），
   模板原样当名字。`fixtures/missing-fields` 钉住「暂无教师」「待定」两种。
5. **连堂合并吸收重复行**：模板只认「下一节正好接着」（`end + 1 === start`），本件用「下一节起点 <= 当前终点 + 1」
   并把终点取最大值（`parse.js` 第 577 行起的 `mergeStageOne`），重叠的重复行不会被排成两格（批次十九 xsyu）。
6. **页面判断**：上游要求当前地址在 `/kbcx/` 或 `/xtgl/` 下（`inTeachingSystem`，`extract.js` 第 44 行），
   不在就零请求直接提示；模板只认正方登录页 `login_slogin.html`。
7. 其余层（请求头与请求体、`#xnm` / `#xqm` 读取、周次四写法与括号序号、节次多写法、两阶段合并 + 完全重复行、
   开学日回退周一与可信度判断、总周数收紧、H3 补时间、warnings 收口、学期名兜底带学校名）与模板一致。

## 5. 上游里删掉 / 改掉的东西及理由

1. **删掉「拾光」桥调用**：`showAlert` / `showSingleSelection` / `saveImportedCourses` / `saveCourseConfig` /
   `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion`（上游第 238、246、253、301–306、332、340、350、351、354）。
   空课里由宿主负责保存，适配器只交载荷；这些桥在空课里不存在。
2. **删掉弹窗选学年学期**：上游 `selectAcademicYearAndSemester`（第 235–268 行）会打断用户。改成读页面下拉框（移植手册 §3 第 1 步），
   拿不到选中项就取第一项并提醒。
3. **整行丢课改为计数**：上游 `parseJsonData` 第 129 行要求 `kcmc` / `xqj` / `jcs` / `zcd` 四个字段全非空（教师、教室另在第 150–151 行取），
   缺一个就整行 `continue`。移植件只要求课名、星期、节次、周次；教师与教室没有就留 `null`，跳过的行按原因计数写进 `warnings`（手册 §4.7）。
4. **周次解析修正**：上游 `parseWeeks`（第 98–119 行）按逗号切段后各段用 `/(\d+)(?:-(\d+))?\s*周?/` 取**第一个**匹配，
   且只看本段里有没有 `(单)` / `(双)`；`(单)1-8周,(双)9-16周` 这种前置标记在段首是能读对的，但
   `1-8周(单)9-16周(双)`（无逗号）会把两段粘一起读成 1-16 每周，`共 N 周` 备注会把后面的真实周次一起吞掉。
   移植件用模板那套（前缀 / 后缀标记各自归属、括号分类、只剥「共 N 周」备注）并加 `fixtures/weeks-markers` 钉住五种写法。
5. **节次解析放宽**：上游 `String(jcs).match(/[0-9]+/g)` 只取首末两个数，`第9-10节` 能读、`1,2` 读成 1-2（碰巧对），
   但 `1-2,5-6` 会读成 1-6、`0102` 会读成 102。移植件按 `sectionsOf`（`parse.js` 第 419 行）处理，多段按最大跨度放入并在 `warnings` 里说明。
6. **开学日**：上游 `fetchSemesterStartDate`（第 270–290 行）把 `rq.split('/')[0]` 原样当开学日、不回退到周一，
   找不到第 1 周时拿 `data[0]` 顶替。移植件用 `isoOfAny` 认多种日期写法，回退到那一周的周一（手册 §4.3），
   并检查日期是否落在本学期的合理窗口内（`plausibleStart`，`parse.js` 第 250 行），可疑就忽略并推算。
7. **总周数**：上游写死 `semesterTotalWeeks: 20`；移植件优先用校历，课表里更晚的周次会把总周数抬上去，抬了都写进 `warnings`。
8. **学生信息**：上游把整个课表响应交给自己的解析函数（不涉及外发）；移植件按字段白名单挑，`xsxx` 等一律不交出去。

## 6. 变异测试记录

变异改的是**副本**：每个副本在临时目录里整目录复制（目录名同样是 `njupt`，否则 check.js 会因 `manifest.key` 与目录名不一致报错），
只替换副本的 `parse.js`；真文件 `jw-adapters/njupt/parse.js` 没有被变异脚本写过。每条替换要求恰好命中 1 次。
脚本是 `.test/port-batch34/njupt/mutate.py`（可重跑）。

| 变异 | 改了什么 | 变红的 fixture |
|---|---|---|
| M1 | 第 57 行的学校节次表：第 6 节 `13:45-14:30` 改成 `14:00-14:45` | 8 条全部：`periodTimes[5]` 与期望不符 |
| M2 | `weeksOf` 里「夹在两段中间的标记判给下一段」那一支改成永不命中（退回模板缺陷） | `weeks-markers`：`(单)1-8周(双)9-16周` 变成 1-16 每周都上，并多一条「单双同时出现」提醒 |
| M3 | 连堂合并条件改回 `next.start === current.end + 1` | `merge-duplicates`：1-2 与 2-3 不再并成 1-3 |
| M4 | 学期回落提醒整段不出现（`if (term.selected !== true)` 改 `if (false)`） | `term-fallback`：少了「已按列表第一项…」那一条 |
| M5 | 占位词正则改成永不命中（`暂无教师`、`待定` 当真名真地点） | `missing-fields`：`teacher` / `location` 期望 `null`，实际是占位文字 |

**还原校验**：变异前后各查一次真文件 SHA-256，一致（脚本里 `before == after`，输出「是」）；
真文件跑 `check.js` 最后一行 `RESULT: PASS`，8 个 fixture 全部 MATCH。

## 7. fixtures、自检与冒烟

8 对合成用例（`_note` 里写明是编造的，课程、教师、教室均为虚构，无真实个人信息）：

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 校历给开学日 2026-09-07（周一）与 18 周；同课同日同教室 1-2 与 3-4 连堂合并；单周、双周；12 节节次表逐节钉住（第 1 / 6 / 12 节） |
| `weeks-markers` | 周次多段与单双标记：前置、后置、无逗号前置三种写法都读成 1-7 单 + 10-16 双；`1-15周(单) 共16周` 只读 1-15 单；`1-8周(共8周),9-16周` 只剥备注、9-16 不丢 |
| `missing-fields` | 一门体育课两个时段都缺教师（按课名只点一次）、两门缺地点（含「待定」）→ 照常导入为 `null`，按类型汇总一条提醒 |
| `term-fallback` | `selected: false` → 取列表第一项并提醒；校历为 `null` → 开学日推算为 2026-08-31、总周数 20 |
| `overweek` | 校历为 `null`、课表有第 22 周 → 总周数从 20 抬到 22 并说明 |
| `long-warnings` | 4 门超长课名实践课（点名 3 门、课名截 20 字、其余写「等」）+ 两门超长课名缺教师 / 缺地点 + 两行认不出的周次 → 每条提醒 ≤200 字、末尾「怎么核对」不被截掉 |
| `merge-duplicates` | 完全重复行只留一条、重叠行并进同一段（`<= end + 1`）、隔开的一大节单独成段、同节次不同周次取并集 |
| `second-term` | 页面选中的是第二学期（代号 12）→ 学期名「2026-2027学年第二学期」，校历给 2027-02-22 与 18 周 |

期望值全部先按规范和代码逻辑手推（节次时间、周次切段、单双周、开学日、总周数、学期名、每条提醒的原文与顺序），
再跑自检比对；`long-warnings` 第一次差一个字（课名截断少算一位），核对后确认是**期望写错**、代码按 `NAME_TEXT_LIMIT = 20` 取前 19 字加「…」，改的是期望文件。

自检：`node .test/port-batch5/tools/check.js D:/NullClass/jw-adapters/njupt` 最后一行 `RESULT: PASS`，8 个 fixture 全部 MATCH。
8 份期望里最多 7 条 `warnings`（`long-warnings`），单条最长 97 字，都没有触到 20 条 / 200 字的硬上限。

**浏览器冒烟**（`.test/port-batch34/njupt/smoke.py`，Playwright 拦下全部请求、起假正方教务站，不联网；
本机没有随 playwright 的 Chromium，用 `NC_PW_CHANNEL=msedge` 走系统 Edge）9/9 OK：

| 场景 | 断言 |
|---|---|
| `normal` | 页面上有 `#xnm` / `#xqm` → **不发课表首页的 GET**，正好两条 POST：`/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` 体 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=`、`/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` 体 `xnm=2026&xqm=3`；学期名、开学日 2026-09-07、总周数 18、12 节表、单周都对 |
| `term-page` | 页面选中的是第二学期 → 两条 POST 都带 `xqm=12`，学期名是「2026-2027学年第二学期」、开学日 2027-02-22（证明取的是页面选中项，不是弹窗默认项） |
| `fallback` | 两个下拉框都没标选中 → 取第一项（2025-2026 第一学期），提醒里有「列表第一项」 |
| `portal` / `auth` | 门户首页 `/`、统一认证 `/authserver/login` → **零请求**，提示「请先登录教务系统并进入「学生个人课表」」 |
| `calendar-missing` | 校历接口 500 → 交 `null`，提醒「教务系统没有给出开学日期…」 |
| `badkb` | 课表接口返回 HTML → 报错「没有返回课表数据（返回的内容格式不对）」 |
| `empty` | `kbList` 为空 → 交给 parse.js 报「这个学期没有解析到任何课程」 |
| `total` | 响应写 `total: 9` 实际 2 行 → 提醒「实际只取到 2 条」 |

冒烟同时断言：交出的对象只有 `term`（`xnm` / `xqm` / `xnmText` / `xqmText` / `selected` 五个键）、`today`、`raw`（行只含六个白名单字段）、
`total`、`calendar`；没有 `periodTimes` / `campusId`；`xsxx`（学号、身份证号）与页面上的手机号不出现在 extract 输出或载荷里。

## 8. 已知风险与未验证项（我们没有本校账号，真机没验过）

1. **真实部署未验证**：没有访问 `i.njupt.edu.cn`，也没在 Android 真机上抽验。fixture 与假站只证明转换逻辑。
2. **`scheduleUrlHint` 的前缀是推断的**：取 `https://i.njupt.edu.cn/` + 上游的根相对路径 `/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`。
   若真实课表页在 WebVPN 通道下另有哈希前缀（如 `/#/...` 形态），「一键刷新」打开的可能不是课表页，首次真机要核对这一行；
   脚本本身用根相对地址，不依赖它。
3. **WebVPN 的改写规则没在真机验证**：根相对请求会不会被正确改写成带通道前缀的教务地址，只能靠上游注释与代码推断。
   若真机上三条请求 404，优先怀疑这一点（改成与当前页面路径同前缀的地址）。
4. **校历接口的字段形状**按正方 `cxZcByXnxq` 推断（`zs` / `zsmc` + `zrq` / `zcrq` / `rq` / `ksrq`），真实返回可能是别的列名；
   取不到就回落推算并提醒，不会导错。
5. **12 节节次时间逐节照抄上游** `NJUPT_TIME_SLOTS`，没有与学校实际作息核对过；导入预览每次都提示核对。
6. **学期下拉框的文本**可能是「1 / 2 / 3」：`termKind` 先看文本里的「一 / 二 / 三」，认不出再看正方学期代号 `3` / `12` / `16`；
   如果本校把第二学期代号配成别的值，开学日推算会落到第一学期锚点（会写进提醒）。
7. **`allowHosts` 只写了 `i.njupt.edu.cn`**：脚本请求都是同源根相对地址，用不到别的域；若真机上教务在另一个子域（例如经网关跳转后换了主机），
   要把那个主机加进来，否则桥不会注入。
8. **集中实践课**：上游不读 `sjkList`，本件保留模板做法（有就提醒用户自己加）。若本校的课表接口不返回这一项，这条提醒不会出现，没有副作用。
9. **warnings 到 20 条后的截断**只有代码阅读，没有 fixture（正常路径下这些计数不会同时爆满）。

## 9. 签名

移植与审计：0x7E7-2023（haiku 移植，2026-11-10）。
上游出处：`shiguang_warehouse` → `resources/NJUPT/njupt_01.js`（快照 commit `baf83fa7972d4be6627c534992f7d2da399a0945`，2026-11-10 拉取；
本校脚本最后修改 `b54f40c`；MIT，作者 kemi-20）。

## 10. 复审修正（2026-11-10，reviewer 提出、主调度核对后改）

- **区间终点前的「第」没归一**：`weeksOf()` 只把破折号 / 「至」「到」折成 `-`，`第1周至第8周` 变成 `第1-第8`，
  区间正则认不出，被拆成 1、8 两个孤周（批次十 swu 同款坑）。补一句删「第」；`weeks-markers` 新增 `第1周至第8周`、`第3周-第5周` 两行。
- **括号备注原文没截短**：`noteSample` 直接拼教务原文，约 200 字的备注把提醒顶到上限、末尾「请核对这几门课的周次」被硬截断。
  改为 `shortName(all)`；`long-warnings` 新增一条约 70 字括号备注的课，钉住 20 字截断与「已忽略，请核对…」那半句。
