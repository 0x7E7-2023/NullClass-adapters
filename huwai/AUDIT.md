# 安全审计 —— 湖南外国语职业学院（正方教务 V9，jwglxt）

审计对象：`jw-adapters/huwai/` 下的 `extract.js` / `parse.js` / `manifest.json` 与 `fixtures/`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `resources/HUWAI/huwai.js`（433 行；上游快照 commit `1dc9ac6`，2026-11-16 拉取；
本校脚本最后一次修改 `9146e1b`，2026-11-15；MIT，作者 Haooz）。上游同目录 `resources/HUWAI/adapters.yaml` 只有一个条目
`HUWAI`（`import_url` `https://jw.huwai.edu.cn:8010/jwglxt/xtgl/login_slogin.html`，maintainer `Haooz`）。

审计方式：逐行读上游脚本 + 逐行读移植件，跑移植手册 §5 的静态扫描；`parse.js` 用 Rhino 1.8.0 实跑 8 对 fixture；
`extract.js` 在 Chromium（Playwright，全部请求被 route 拦下，不联网）里实跑 8 个场景，再把输出交给 Rhino 跑 `parse.js`。
扫描结果：`extract.js` 与 `parse.js` 全文（含注释）没有箭头函数、反引号、`let `/`const `、`async`/`await`、`class`、
解构、展开符、`new Set`/`new Map`、`Array.from`、可选链、后行断言与命名捕获组；没有 BOM 与控制字节；
没有 `eval` / `new Function` / `localStorage` / `sessionStorage` / `document.cookie` / `sendBeacon` / `WebSocket` / `new Image`；
唯一的网络调用是 `extract.js` 的 `request()` 里的 `fetch`，地址全部由 `window.location.origin` 拼出。

## 1. 本校与模板的不同构之处（自己读上游得出的判断）

- 平台：正方教务 V9（`/jwglxt`），数据走 JSON 接口，不在页面表格里抠。
- 四个请求全部 `POST` 表单（第一个学年学期页是 `GET`），与上游逐字一致，见 §3 请求清单。
- 上游先取一次课表首页拿 `#xnm` / `#xqm` 的选项，再弹两个选择框问学年学期 —— 移植件不弹窗，直接读页面当前值。
- 节次时间接口是 `jzgl/skxxMobile_cxRsdjc.html`（菜单号 `N2154`，`xqh_id` 固定 `1`），与模板 `jsei` 逐字同源。
- 校历接口 `kbcx/xskbcxZccx_cxZcByXnxq.html`（`N2154`），数组长度即总周数，第 1 周的 `rq` 前半段是开学日。
- 上游 `parseWeeks` 只认 `(\d+)-(\d+)`，且用逗号切段后再判单双；`(单)1-8周(双)9-16周` 这种无逗号写法、`共 N 周` 备注、
  `1-16(单周)` 都读不对（详见 §7）。
- 教师括号备注（`张三（外聘）`）在正方这里不会拆成第二位教师：`xm` 本身就是整串，`parse.js` 原样保留，不做拆分。

## 2. 模板选择

模板用 `jsei`（江苏电子信息职业学院，批次八移植、批次十七复审）。理由：同为正方新版 `jwglxt`，课表接口、学期周次校历接口，
以及**同一路径的节次时间接口 `jzgl/skxxMobile_cxRsdjc.html`（菜单号 N2154、`xqh_id` 固定 1）**都逐字一致；
`hueb` 用的是 `kbcx/xskbcx_cxRjc.html`（N2151、`xqh_id` 取自课表行），`zust` 的取数与提问桥更复杂，都不如 `jsei` 贴合。
两件的差别只在数据内容（学校节次时间表、学校名、主机），见 §8。

## 3. 请求清单（与代码逐条对应）

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<origin>/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的学年学期（`#xnm` / `#xqm`）。**页面上已经有这两个字段时一步都不发**（`currentTerm`，第 148 行） | 报错「没读到学年学期…请重新登录」 |
| extract.js | POST | `<origin>/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数。请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`，与上游 `fetchAndParseCourses` 逐字一致（上游第 352–356 行） | 报错「教务系统没有返回课表数据（返回的内容格式不对）…」 |
| extract.js | POST | `<origin>/jwglxt/jzgl/skxxMobile_cxRsdjc.html?gnmkdm=N2154` | 取节次时间（`jcmc` / `qssj` / `jssj`）。请求体 `xnm=…&xqm=…&xqh_id=1`，与上游 `fetchTimeSlots` 逐字一致（上游第 312–323 行） | 交 `null`，parse 回落到学校 10 节表并写 `warnings` |
| extract.js | POST | `<origin>/jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取学期周次校历（`zs` / `zsmc` / `rq` 等），定开学日与总周数。请求体 `xnm=…&xqm=…`，与上游 `fetchSemesterInfo` 一致（上游第 272–284 行） | 交 `null`，parse 回落到推算并写 `warnings` |

主机：`manifest.loginUrl` = `https://jw.huwai.edu.cn:8010/jwglxt/xtgl/login_slogin.html`，`allowHosts` = `["jw.huwai.edu.cn"]`
（端口不进 allowHosts，脚本也不写死端口：地址全部由 `window.location.origin` 拼出，`jwBase()`（第 46 行）跟着当前地址里的
`/jwglxt/` 段走，挂在校内门户前缀下（`/gw/xxx/jwglxt/...`）也能取到数）。
`manifest.scheduleUrlHint` 是课表页完整地址
`https://jw.huwai.edu.cn:8010/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`。

与上游的差别：上游每次导入都先请求一次课表首页生成选择框选项；移植件只在页面上读不到 `#xnm` / `#xqm` 时才发这一次
（离线 `DOMParser` 解析，不插进当前页面）。两条附加请求（节次时间、校历）任何失败都被 `optionalRows`（第 193 行）收成 `null`，
不会让导入失败，回落这件事会出现在 `warnings` 里。请求头统一带 `Content-Type` / `X-Requested-With` / `Accept`，
凭据靠 `credentials: 'include'` 让 WebView 按同源规则带 Cookie，脚本既不读 Cookie 也不外发。`parse.js` 不发任何请求。

## 4. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 带出哪些字段 |
|---|---|---|
| 学年学期 `xnm` / `xqm` 与下拉框文本 | 课表页 `#xnm` / `#xqm`，或课表首页 HTML | 全部带出（学期名要用） |
| 排课行 `kbList` | 课表接口 | `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `jcor` / `zcd` / `xqh_id`（`ROW_FIELDS`，第 217 行）；`xqh_id` 只用来填 `campusId` |
| 集中实践课 `sjkList` | 课表接口 | 只带 `kcmc`（逐行重建 `{ kcmc }`） |
| 节次时间 | `skxxMobile_cxRsdjc` | 只带 `jcmc` / `jc` / `qssj` / `jssj`（`PERIOD_FIELDS`，第 219 行） |
| 学期周次校历 | `cxZcByXnxq` | 只带 `zs` / `zsmc` / `zrq` / `zcrq` / `rq` / `ksrq`（`CALENDAR_FIELDS`，第 220 行） |
| 记录总数（有才有） | 课表接口 | 只用于对账 |
| 学生个人信息（`xsxx`、行里的 `xh` / `sfzh` / `sjh`、`xh_id` 等） | 课表与校历响应 | **不带出**：三个接口都按白名单逐行重建；冒烟场景在响应里埋了学号、身份证号、手机号与一个 `cd_id` 标记，输出里一处都没有 |

上游没读 `sjkList`（集中实践课）。移植件照模板保留：只有课名、没有星期节次的课排不进周课表，但要提醒学生自己去加，
不能静默吞掉（本批硬约束 6）。这条不引入任何个人信息，`sjkList` 只留课名。

不读的东西（静态扫描无命中）：`password` / `pwd` / 登录表单、`localStorage` / `sessionStorage`、Cookie 值、成绩、学籍、
个人信息、缴费，以及任何其它模块的接口。

## 5. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储。上游的公告弹窗 `showAlert`、两次学年学期 `showSingleSelection`、`showToast` / `notifyTaskCompletion` / `saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` 全部没有移植 |
| 2 | 不外发 | **过**。全部 `fetch` 在 `extract.js`，地址由 `window.location.origin` 拼出；没有 `sendBeacon` / `WebSocket` / `EventSource` / 图片打点 / 隐藏表单；唯一的绝对 URL 是文件头里写上游仓库的 `https://github.com`（注释，不是请求） |
| 3 | 请求域可控 | **过**。只有一个主机（用户当前打开的教务主机）；`allowHosts` 只写主机名，不写通配 |
| 4 | 只读课表 | **过**。四条请求全在 `/jwglxt/kbcx/*` 与 `/jwglxt/jzgl/skxxMobile_cxRsdjc.html`，不碰成绩、学籍、个人信息、缴费；响应里夹带的学生信息一律不带出 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测、图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`；只对教务自己的响应做 `JSON.parse` |
| 7 | 不写页面 | **过**。只读 `#xnm` / `#xqm`；课表首页用 `fetch` + `DOMParser` 离线解析，不插入当前页面、不改表单、不触发点击 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码密钥、令牌或他人学号；常量只有 `/jwglxt`、菜单号 `N2151` / `N2154`、固定校区号 `1`（上游同款） |

**结论：可以进内置库。**

## 6. 节次时间（逐节对照上游）

`SCHOOL_PERIOD_TIMES`（`parse.js` 第 54 行）逐节照抄上游 `FALLBACK_TIME_SLOTS`（上游第 16–27 行）：

| 节 | 起 | 止 |
|---|---|---|
| 1 | 08:30 | 09:15 |
| 2 | 09:25 | 10:10 |
| 3 | 10:20 | 11:05 |
| 4 | 11:15 | 12:00 |
| 5 | 14:00 | 14:45 |
| 6 | 14:55 | 15:40 |
| 7 | 15:50 | 16:35 |
| 8 | 16:45 | 17:30 |
| 9 | 18:30 | 19:15 |
| 10 | 19:15 | 20:00 |

第 9 节下课即第 10 节上课（19:15 首尾相接），`periodTimesOf` 允许 `start == 上一节 end`，不会被判成重叠而整表作废。
教务接口给的时间优先；非法（`24:00`、结束早于开始、缺节次、不从第 1 节起连续）就整张作废回落到这张表并写 `warnings`。
课表用到第 11 节及以后时按统一修订 H3 逐节补：先看空课默认 12 节表同号那一节（开始不早于上一节下课才用），
否则课间 5 分钟、每节 45 分钟顺推；越过 23:59 就停并如实说明。`MAX_PERIOD = 20`，超过判脏数据并计数提醒。

## 7. 对上游的删改（都不牵涉安全，审阅者需要知道）

1. **两段式**：取数在 `extract.js`，解析/合并/拼载荷在 `parse.js`（CI 用 Rhino 实跑）。
2. **弹窗与保存全去掉**：上游开场公告、学年学期两个选择框、三种保存、所有 `showToast` 都没有移植。学期改成读页面上的
   `#xnm` / `#xqm`：用户在教务页面里切到哪个学期就导哪个学期。
3. **主机不写死**：上游 `BASE_URL` 写死 `https://jw.huwai.edu.cn:8010/jwglxt`（第 13 行）；移植件用 `window.location.origin` + 当前地址里的
   `/jwglxt` 段拼，换端口或挂门户前缀都不失效。
4. **周次重写**：上游 `parseWeeks`（第 33–58 行）只认 `(\d+)-(\d+)` / `(\d+)`，且 `共 N 周` 备注、无逗号前置单双标记、
   `1-16(单周)` 都读不对（会把 16 当周次、把两段并成每周都上）。移植件 `weeksOf`（第 329 行）：只剥「共 N 周」备注本身
   （`/共\s*[0-9]+\s*周?/g`，不用贪婪到结尾的写法）；破折号异体连同空白归一成 `-`；全角转半角；括号逐组判定
   （纯数字 = 教学班序号、含非周次字 = 备注、只含单双 = 标记）；空白折成段落分隔；单双标记按相对周次的位置归属
   （前缀贴后一段、后缀归前一段、夹在两段中间的按前一段是否为前缀段判给下一段）。
5. **节次放宽**：上游 `String(sectionText).split('-')` 只取首尾，`0102` 会被读成第 102 节；移植件 `sectionsOf`（第 461 行）
   认 `1-2` / `第9-10节` / `1,2` / 两位一拼的 `0102`，多段按最大跨度放入并写 `warnings`；上游 `jcs || jcor` 的回落照搬。
6. **不整行丢课**：上游要求 `kcmc` / `xqj` / `zcd` / 节次非空，缺教师缺教室本来就保留成空串；移植件把空串变成 `null`
   （载荷校验不许写「未知」），并按课程名去重汇总成两条提醒。
7. **开学日与总周数**：上游取校历第 1 周 `rq` 前半段原样当开学日、总周数写死 20（`semesterTotalWeeks`）。移植件把第 1 周日期
   回退到那一周的周一（`mondayOfIso`）；第 1 周日期离学期锚点超过 45 天（`plausibleStart`，第 280 行）判为别的学期，
   这份校历的周数一并作废；总周数取校历最大周次，没有就 20，被课表更晚的周次顶高（上限 30）；取不到就按学期序号推算
   （第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一）。所有推算、作废、抬高都写进 `warnings`。
   上游「找不到第 1 周就拿第一行顶替」没有移植 —— 宁可推算也不写错日期。
8. **合并**：照搬上游 `mergeAndDistinctCourses` 的两阶段（连续节次合并 + 同节次周次并集），合并前先整批去掉完全相同的行
   （`dropExactDuplicates`，第 597 行；上游只跟当前合并中的那条比，1-2、3-4、3-4 这种会漏）。
9. **附加接口按字段白名单交出**：节次时间与校历不整份转手（模板 `jsei` 是整份交出的），见 §4。
10. **学期名**：上游没有学期名这个概念；移植件从下拉框文本拼（`termName`，第 248 行），读不出来时用
    「湖南外国语职业学院 第 X 学期」（学校名，不是适配器名）。

## 8. 与模板 `jsei` 的差异

1. 学校名、文件头、上游出处（`HUWAI/huwai.js`，快照 `1dc9ac6`，脚本 `9146e1b`，作者 Haooz）全部换成本件内容。
2. `SCHOOL_PERIOD_TIMES` 换成上游的 10 节表（模板是 11 节）；`MAX_PERIOD` 仍为 20。
3. 字段白名单多一个 `jcor`（上游 `jcs || jcor`），`sectionsOf` 相应加回落。
4. 新增 `PERIOD_FIELDS` / `CALENDAR_FIELDS`，节次时间与校历按白名单重建（模板整份交出）。
5. 提醒里原来写「适配器内置的 N 节节次时间」，改成「学校公布的 N 节节次时间」（批次十口径：不给学生看开发者视角的词）。
6. 提醒里拼教务原文的地方统一过 `shortName`：学期名、集中实践课名、认不出的周次原文、括号备注原文（模板只截课名）。
7. 主机：模板是 WebVPN + 校园网双入口；本校只有一个入口，端口 8010 不写进代码，`loginUrl` 带端口、`allowHosts` 只写主机名。

## 9. 本校专属边界用例（fixtures，8 对）

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 节次时间接口取不到 → 整张学校 10 节表（第 2 节 09:25-10:10、第 10 节 19:15-20:00 钉住）；校历取不到 → 开学日推算 2026-08-31、总周数 20；排到第 13 节 → 第 11、12 节取空课默认时间、第 13 节顺推 22:05-22:50；单双周、缺教师、缺教室；最后一行只有 `jcor` |
| `merge` | 1-2 + 3-4 合成 1-4；同节次 1-8 与 9-16 并成 1-16；完全重复的 1-2 只留一条 |
| `week-markers` | 前缀 `(单)1-8周,(双)9-16周` 与后缀 `1-8周(单),9-16周(双)` 都是 1-7 单 + 10-16 双；`(双)1-8周`、`9-16周(单)`；末尾 `1-15周(单) 共16周` 只读 1-15 单；中间 `1-8周(共8周),9-16周` 的 9-16 不丢 |
| `weeks-prefix-glued` | `(单)1-8周(双)9-16周`（无逗号）、`(单)1-8周 (双)9-16周`（空格分隔）、`1-8周(单)9-16周(双)`（无逗号后置）都读成 1-7 单 + 10-16 双 |
| `calendar-term` | 校历 18 周、第 1 周从 2026-08-31（周一）起；作息接口给 12 节（时间故意与学校表不同）→ 用教务的，无回落提醒；总数 2 与实际 2 行对账不报警 |
| `bad-period-times` | 作息第 2 节给 `24:00` → 整表作废回落 10 节表；校历第 1 周给周三 2026-09-09 → 开学日回退到 2026-09-07，总周数 18 |
| `no-calendar-overweek` | 校历取不到、课表排到第 22 周 → 总周数抬到 22 并说明；集中实践课单独提醒；认不出的周次原文进提醒；总数 5 与实际 3 行对账 |
| `long-warnings` | 四门超长课名（21–23 字）缺教师缺教室：课照常导入（`null`），两条提醒点名课名截到 20 字、整条 ≤200 字；集中实践课名与认不出的超长周次原文同样截短；报告 1 行数据不全 |

模板里钉单/双归属与「共 N 周」剥离的用例换成本校数据后保留（`week-markers` / `weeks-prefix-glued`）。

## 10. 浏览器冒烟（`D:/NullClass/.test/port-batch37/huwai/smoke.py all`）

Chromium（本机没有 Playwright 自带浏览器，回落到系统里的 Edge）起假教务站，`route` 拦下全部请求，不联网；跑真实
`extract.js`，再交给 Rhino 跑 `parse.js`。8 个场景全部 OK：

| 场景 | 结果 |
|---|---|
| `huwai` | 页面自带 `#xnm` / `#xqm` → 3 个 POST：`xskbcx_cxXsgrkb.html?gnmkdm=N2151`（体 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=`）、`jzgl/skxxMobile_cxRsdjc.html?gnmkdm=N2154`（体 `xnm=2026&xqm=3&xqh_id=1`）、`kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`（体 `xnm=2026&xqm=3`）；节次时间用教务的 10 节（07:50–20:45）；开学日 2026-08-31、总周数 18；学号 / 身份证号 / 手机号 / `cd_id` 不外带，行与校历字段都在白名单内 |
| `huwai-menu` | 页面（`xtgl/index_initMenu.html`）没有下拉框 → 先 GET 一次 `xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` 再取课表 |
| `huwai-gateway` | 页面在 `/gw/abc123/jwglxt/...` 下 → 三条请求都落在 `/gw/abc123/jwglxt/` 前缀下 |
| `huwai-login` | 打开登录页 → 直接报「当前打开的是教务登录页…」，**零请求** |
| `huwai-expired` | 课表接口回登录页 HTML → 报「教务系统没有返回课表数据（返回的内容格式不对）…请重新登录」，与 HTTP 失败分开说 |
| `huwai-calendar-fail` | 校历 500 → 校历交 `null`，开学日按锚点推算、总周数回落 20，节次时间仍用教务的，写入「教务系统没有给出开学日期…」 |
| `huwai-bad-periods` | 作息第 2 节 `24:00` → 整表作废，回落到学校 10 节表（08:30–20:00）并提醒 |
| `huwai-empty` | `kbList` 空 → `parse.js` 报「这个学期没有解析到任何课程…」 |

## 11. 变异测试记录

变异改的是**副本**（每次整目录复制到系统临时目录，目录名仍为 `huwai` 让 `manifest.key` 对得上，只替换副本的 `parse.js`），
真文件 `jw-adapters/huwai/parse.js` 没有被写过；每处替换要求恰好命中 1 次。真文件变异前后跑 `check.js` 都是 `RESULT: PASS`。

| 变异 | 改了什么 | 变红的用例 |
|---|---|---|
| M1 | 学校 10 节表第 10 节下课 `20:00` 改为 `19:50` | basic、merge、week-markers、weeks-prefix-glued、bad-period-times、no-calendar-overweek、long-warnings（7 个；用学校表或补时间的用例都钉着这张表） |
| M2 | 去掉 `jcor` 回落（只认 `jcs`） | basic（`jcor: "13"` 的晚间实验整门丢掉） |
| M3 | 前缀单/双标记不再贴到后一段（退回「就近向前并」） | week-markers（`(单)1-8周,(双)9-16周` 两个标记都并到 1-8 上，1-7 单 + 10-16 双的期望对不上） |
| M4 | 校历第 1 周日期不回退到周一 | bad-period-times（`firstDay` 变成 2026-09-09，应为 2026-09-07） |
| M5 | 提醒里课名截断 `MAX_NAME_IN_WARNING` 20 → 40 | long-warnings（点名课名的文本变了） |
| M6 | 「共 N 周」改成只删末尾的贪婪写法 | week-markers（`1-8周(共8周),9-16周` 的备注剥不掉，中间备注课读错） |

6 处全部变红；还原后真文件 `check.js` 仍为 `RESULT: PASS`（8 对 fixture 全 MATCH）。

## 12. 已知风险与未验证项

1. **真实部署未验证**：我们没有本校账号，`extract.js` 只在假站里跑过（请求路径、请求体、交出去的形状都对），
   `parse.js` 的 fixture 是合成的。拿到真实响应后替换 fixture 并重跑 `check.js` 是最高优先级的贡献。
2. **10 节节次时间**：逐节照抄上游 `FALLBACK_TIME_SLOTS`，没有用学校官方作息核对过；教务接口取不到时会用它，
   提醒里已让用户核对。
3. **`xqh_id=1`**：节次时间请求固定带 `xqh_id=1`，照上游。若本校分校区作息不同，可能拿不到对应校区的作息，
   取不到时整张回落并提醒。
4. **学年学期下拉框**：假设课表页有 `#xnm` / `#xqm`（正方通用）。首页结构被改过会报「没读到学年学期」；
   `xqm` 代号按正方的 `3` / `12` / `16`（以及个别部署的 `1` / `2`）判学期序号，别的代号一律按第一学期推算。
5. **校历字段覆盖**：`calendarInfo` 认 `zrq` / `zcrq` / `rq` / `ksrq` 四个日期字段，fixture 只用到 `rq`（上游用的就是 `rq`）。
6. **`MAX_PERIOD=20`**：课表节次超过 20 的行判脏数据并计数提醒，不会导入。
7. **`warnings` 溢出计数差 1**：`warn()` 到第 20 条后不再追加，最后一格被换成「另有 N 条…」，第 20 条本身也被替换，
   文案少算一条。这是模板同款行为，本批没有改（需要一份超过 20 条的 fixture 才钉得住），交主调度决定是否统一修。
8. **上游没有 `console.log`**：433 行脚本里没有调试输出，也没有需要删的日志。

## 13. 签名

- 上游出处：`shiguang_warehouse` → `resources/HUWAI/huwai.js`（快照 commit `1dc9ac6`，2026-11-16；本校脚本 `9146e1b`，
  2026-11-15；MIT）
- 上游作者：Haooz
- 移植者：0x7E7-2023（haiku 移植，2026-11-16）
- 安全结论：**可以进内置库**（§5 八条全过）
