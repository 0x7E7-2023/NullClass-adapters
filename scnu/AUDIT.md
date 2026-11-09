# 安全审计 —— 华南师范大学（正方教务 V9，站点根路径，https）

审计对象：`jw-adapters/scnu/` 下的 `extract.js`（340 行）/ `parse.js`（1062 行）/ `manifest.json` /
`fixtures/`，以及它们移植自的上游脚本 `shiguang_warehouse` 的 `SCNU/scnu.js`（327 行，MIT）。
`adapters.yaml` 的 maintainer 是 `YewFence`（`adapter_id: SCNU_01`，名称「华南师范大学本科教务系统」）。

任务卡写本校脚本最后一次修改是 `2e1e720`；本地快照（提交 `baf83fa`）里
`git -C .../sgw-latest log -1 --format=%h -- resources/SCNU/scnu.js` 给出的是 `344f0e5`。
按公共说明「以快照为准、不要改快照」处理，脚本内容与任务卡描述的流程逐条对得上
（课表首页读学年学期、校区作息、周次校历、未排课程），差异记在这里备查。

模板选 `nbut`（批次二十二已审计）：同为正方 V9、https、同样的
`#xnm` / `#xqm` 下拉框与课表 POST。校区作息与学期周次校历两段照已审计的 `cauc`（同平台）
取数写法，再按本校上游的参数改。二者出处都在文件头注释里写明了。

## 0. 与模板的不同、本校边界

- 主机 `jwxt.scnu.edu.cn`，协议 https，菜单号 `N253508`（模板是 http、`N2151`）。
- `scheduleUrlHint` 照任务卡与本校实际页面写成
  `https://jwxt.scnu.edu.cn/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508`，
  是课表查询页的完整地址，不是一句说明。
- 请求体照上游：课表额外带 `kzlx=ck&xsdm=&kclbdm=&kclxdm=`；校区作息额外带 `xqh_id`；
  三个 POST 地址都不附加菜单号（上游如此，与模板 nbut 一律带 `gnmkdm` 不同）。
- 校区：上游按每个校区各取一份作息，再弹窗让用户挑默认校区。本移植不弹窗，按课表行里
  各校区的行数自动挑最多的那个（并列取先出现的），只取它的作息（`extract.js` 的
  `campusListOf` L234 / `dominantCampus` L251）。载荷只有一份 `periodTimes`，课程行跨校区
  时在提醒里说清「按 X 校区写入，其余校区的课请核对上课时间」（`parse.js` L868）。
- 一条课表行都没有校区编号时不猜作息：不发作息请求，`periodTimes` 交 null，`parse.js`
  回落应用里常用的 12 节并写明原因（L921）。
- 校历：上游 `parseWeekCalendar` 一行一周（`zs` + `rq` 形如「2026-09-07/2026-09-13」），
  要求周次从 1 连续，干脆抛错。本移植同样要求连续（`calendarInfo` L479），但不连续时只作废
  「总周数」、保留第 1 周日期作开学日，并写进提醒（L909 的 `calendar.gap` 分支）。
- 节次不连续 / 时间重叠：上游直接抛错。本移植整份作息不用，回落应用里常用的 12 节，
  并把具体原因（节次不连续 / 时间有重叠 / 写得不全 / 起止不对）写进提醒
  （`periodTimesOf` L510、`periodProblem` L509）。
- 课名后缀：上游把 `xslxbj`（`*` 理论、`&` 实验、`#` 实践）的「实验 / 实践」写成课名后缀
  「（实验）」「（实践）」，课名里已有就不加（`typedName` L685）。
- 地点：上游拼「校区 + 教室」，本移植照搬；教室是空的或「未知 / 待定 / 暂无」时整项为空，
  不拿校区名冒充地点（L714-717）。
- 未排课程 `sjkList`：上游只在「没有已排课程」弹窗和导入摘要里列课名。本移植按类型汇总成
  一条提醒（L957-974），不逐条刷屏。
- 上游固定交代「独立实验预约安排需另行核对」：保留成一条固定提醒，并写明去教务系统的
  实验预约页面核对（L976），不写「学期管理」。
- 本校专属边界（都有 fixture）：多校区按行数最多的那个取作息并提醒；没有校区编号时回落
  12 节；作息时间重叠时回落并写明原因；校历周次不连续时总周数按 20；无逗号前置单双标记
  「(单)1-8周(双)9-16周」；「第1-第8周」「共 N 周」；连堂合并与重复行；超长课名 / 校区名提醒。

## 1. 请求域与请求清单（与代码逐条对应）

地址都由当前页面的源（站点根路径）拼出（`jwBase`）：本校教务部署在根路径，登录入口
`/xtgl/...` 与上游的 `/kbcx/...` 都在根下，**不拼 `/jwglxt`**。主机必须正好是 `jwxt.scnu.edu.cn`（`onJwHost` L50）。登录页与路径里带
`/sso/` 的页面直接提示，不发请求（`onLoginPage` L54）。

| 谁 | 方法 | 地址 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| extract.js | GET | `<jwBase>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508&layout=default` | 无 | 读课表页上的学年、学期下拉框（`currentTerm` L161）。页面上已经有这两个下拉框时跳过 | 报错，提示重新登录后再点「提取课表」 |
| extract.js | POST | `<jwBase>/kbcx/xskbcx_cxXsgrkb.html` | `xnm` `xqm` `kzlx=ck` `xsdm=` `kclbdm=` `kclxdm=`（照上游） | 取课表（`fetchTimetable` L184） | 报错 |
| extract.js | POST | `<jwBase>/kbcx/xskbcx_cxRjc.html` | `xnm` `xqm` `xqh_id`（行数最多校区） | 取该校区作息。只有节次号、没有上课时间的列表整份不要（`periodListUsable` L224、L320） | 没有校区编号或请求失败：交 null。parse 用应用里常用的 12 节并提醒 |
| extract.js | POST | `<jwBase>/kbcx/xskbcxZccx_cxZcByXnxq.html` | `xnm` `xqm` | 取学期周次校历 | 交 null。parse 推算开学日、总周数按 20，并在提醒里说明 |

节次时间与校历失败不影响导入。主流程在 `extract.js` L305-340（`Promise.all` 并发取作息与
校历）。`parse.js` 不发任何请求。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 交出去的字段 |
|---|---|---|
| 学年学期 | 页面或课表首页的 `#xnm` / `#xqm` | `xnm` `xqm` `xnmText` `xqmText`（学期名要用） |
| 排课行 | 课表接口 `kbList` | `KB_FIELDS`（L269）：`kcmc` `xm` `cdmc` `xqmc` `xqh_id` `xqj` `xqjmc` `jcs` `zcd` `xslxbj` |
| 未排课程 | 课表接口 `sjkList` | `PRACTICE_FIELDS`（L270）：只带 `kcmc` |
| 校区作息 | 作息接口 | `PERIOD_FIELDS`（L271）：`jcdm` `jcmc` `jc` `qssj` `jssj` `sksj` |
| 学期周次校历 | 校历接口 | `CALENDAR_FIELDS`（L272）：`zs` `zsmc` `rq` `zrq` `zcrq` `ksrq` |
| 校区清单 | 从排课行的 `xqh_id` / `xqmc` 就地统计 | `id` `name` `rows`（行数），用于挑校区与提醒 |
| 记录总数 | 课表响应里有才有 | `total`，只用于对账 |
| 学号、姓名、身份证号、手机号、`xsxx`、`cd_id` 等 | 响应里可能夹带 | **不带出**（`pickFields` 只挑白名单，L274） |

`parse.js` 读的字段：排课行上述十项；未排课程 `kcmc`；作息的节次号与起止
（`periodTimesOf` L510）；校历的 `zs` / 各类日期字段（`calendarInfo` L479）；`total`；
`today`；`campuses` / `campusName`；学期四项文本。课名会去掉 `★○●◇◆`。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 过。不读密码、不读本地存储、不读 cookie。上游的桥调用（保存课程 / 配置 / 节次时间、弹窗）全部不移植 |
| 2 | 不外发 | 过。`fetch` 只在 `extract.js` 的 `request`，地址由当前页面的源拼出，最多四个同源请求 |
| 3 | 请求域可控 | 过。主机名只认 `jwxt.scnu.edu.cn`，`allowHosts` 写这一个，不用通配。代码里的绝对地址只有文件头注释中的上游仓库，不参与请求 |
| 4 | 只读课表 | 过。课表、校区作息、学期周次校历都在 `/kbcx/` 下，都是课表相关只读接口；不请求成绩、学籍、缴费。学生个人信息按字段白名单丢掉 |
| 5 | 不埋点 | 过。没有上报、没有打点、没有图片信标 |
| 6 | 不执行远程代码 | 过。没有 `eval` / `new Function`。只对教务响应做 JSON 解析，课表首页用 `DOMParser` 离线读 |
| 7 | 不写页面 | 过。只读下拉框，不改地址、不插入当前页、不提交表单、不写 DOM |
| 8 | 不依赖秘密 | 过。没有密钥、没有他人学号。常量只有主机名与菜单号 `N253508` |

## 4. 上游里删掉或改掉的东西及理由

- 弹窗选学年 / 学期（`showSingleSelection`）：删掉，直接用页面默认选中的当前学期；
  要别的学期，用户在教务页面里切一下再点「提取课表」。
- 弹窗选默认作息校区：删掉，按课表行里各校区的行数自动挑（不弹窗、不猜没有的信息）。
- 桥与导出流程：`showToast`、`showAlert`、`saveImportedCourses`、`savePresetTimeSlots`、
  `saveCourseConfig`、`notifyTaskCompletion` 都不移植。
- 不在教务站或不在课表页时：上游直接抛错；这里保留提示，但补上「不是华南师范大学教务系统」
  与登录页 / 单点页两种判断，且不发请求。
- 周次：上游 `parseNumbers` 按逗号切段、每段只认一段起止，单双标记只认括号里。多段、连写、
  「第」「共 N 周」会读错或丢掉。这里用已审计的 `weeksOf`（L297）。
- 节次：上游 `parseNumbers(raw.jcs, '节', 30, false)` 只认 `1-2,3-4` 这类；这里放宽到
  「第9-10节」「0102」，多段按最大跨度放入并说明（`sectionsOf` L422）。
- 校验失败时的行为：上游对作息不连续 / 重叠、校历不连续、单行节次超出作息一律抛错，
  整次导入失败。这里区分「影响课表本身」与「只影响时间」：能导入的照常导入，拿不准的
  写进提醒（公共说明第 6 条）。
- `firstDayOfWeek`：上游把开学日是星期几交给应用；空课载荷的 `firstDay` 是第 1 周的周一
  （手册 §4.3），因此这里把第 1 周日期回退到那一周的周一，不另交星期几。
- 总周数：上游直接用校历行数。这里校历给得出就用，课表里有更晚的周才抬高，最多 30 周
  （与载荷校验一致）。
- 教师 / 教室占位词：上游原样带出；这里「未知」「待定」「暂无」「暂无教师」「暂无教室」等
  一律当没给（`blankField` L677），提醒指向「编辑课程」。
- 独立实验预约：上游只在摘要里写一句「请另行核对」；这里写成固定提醒，并指明去教务系统的
  实验预约页面核对。

## 5. 变异测试（临时副本，正式文件未改）

方法：把 `jw-adapters/scnu` 复制到系统临时目录，改坏 `parse.js` 一处后用
`node .test/port-batch5/tools/check.js <副本>` 跑，确认对应用例 DIFF，再删副本。

| 改坏 | 变红的用例 |
|---|---|
| `weeksOf` 里删掉「第」的剥离（`cleaned.replace(/第/g, '')`） | `fixtures/week-di.extracted.json` DIFF |
| `weeksOf` 里把「夹在两段中间的前置单双标记」改回上一段的后缀（`if (false) return ',' + mark`） | `fixtures/weeks-prefix-glued.extracted.json` DIFF |
| `periodTimesOf` 里去掉时间重叠判断 | `fixtures/period-invalid.extracted.json` DIFF |
| `calendarInfo` 里去掉周次连续检查 | `fixtures/calendar-gap.extracted.json` DIFF |

四次都是一处改动只打红一对用例，说明每对 fixture 都真的钉住了它要覆盖的逻辑。
副本已删除，正式目录自检为 `RESULT: PASS`（9 对 fixture 全 MATCH）。

## 6. 自检与冒烟

- `node .test/port-batch5/tools/check.js jw-adapters/scnu` → `RESULT: PASS`，9 对 fixture 全 MATCH。
- `python -I -X utf8 .test/port-batch31/scnu/smoke.py all` → 13/13 OK。场景：正常页、
  菜单页、页面挂在 `/jwglxt` 下时仍请求根路径、登录页零请求、单点页零请求、非本校站点零请求、登录过期、
  返回非 JSON、HTTP 500、作息与校历都失败、没有校区编号、多校区、空课表。
  冒烟里核对过：请求都是 https 且落在 `jwxt.scnu.edu.cn`、路径是站点根下的 `/kbcx/…`（不拼 `/jwglxt`）、课表 POST 的
  六个参数、作息只请求一次且带行数最多校区的 `xqh_id`、校历一次 POST、学号 / 身份证号 /
  手机号 / 姓名不出现。

## 6.1 2026-11-10 复审修正

| 编号 | 问题 | 修正 | 捕获方式 |
|---|---|---|---|
| R1 | `jwBase()` 在页面路径不含 `/jwglxt/` 时补 `/jwglxt`，而本校部署在站点根路径（登录入口、上游接口、`import_url` 都是根路径），真机上四个请求会全部 404，导入必然失败 | 基址改为站点根路径，不再拼 `/jwglxt`；文件头注释与冒烟路径断言同步 | 冒烟 `direct` / `menu` / `subpath` 的路径断言；把基址改回拼 `/jwglxt` 后 `direct` 变红（`FAIL path /jwglxt/kbcx/…`） |
| R2 | `scheduleUrlHint` 写成 `/jwglxt/kbcx/…`，一键刷新会打开 404 页 | 改成根路径 `/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508` | manifest 与上游 `import_url` 逐字对照 |
| R3 | 校历第 1 周的日期被一律回退到周一，丢掉上游由该日期隐含的每周起始日；第 1 周不是周一时整学期周边界偏一周，提醒里的日期也与教务不符 | 直接用校历第 1 周的日期作为 `firstDay`（手册 §4.3：`firstDay` 的星期几就是每周起始日） | 三个 fixture（`basic`、`campus-missing`、`calendar-gap`）的 `firstDay` 与提醒；改回回退周一时三条全 DIFF |

## 7. 已知风险与未验证项

- 没有华南师范大学账号，真机没验过。菜单号 `N253508`、三个 POST 地址不带菜单号、
  作息接口的 `jcmc` 是纯数字、校历的 `rq` 是「起/止」两段日期，都只在假教务站上对过。
- 多校区时只取行数最多校区的作息，载荷只有一份节次时间；若另一校区作息不同，那些课的
  上下课时间会按主校区显示。提醒里让学生核对，但没有像上游那样为跨校区课程写自定义时间
  （空课载荷没有这个字段）。
- 作息接口若 `jcmc` 写成「第一节」这类非数字，会被当成没取到，回落应用里常用的 12 节并提醒。
- 校历若把日期放在这六个字段之外，会被当成没给到。
- 应用里常用的 12 节不是学校公布的时间，只在教务没给可用作息时使用，提醒里写了请核对。
- 上游快照提交与任务卡写的 `2e1e720` 不一致（快照是 `344f0e5`），已在上文说明。

签名：0x7E7-2023（haiku 移植，2026-11-09）
