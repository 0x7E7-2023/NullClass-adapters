# 重庆科技大学（`cqust`）适配器 —— 安全审计与移植说明

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) → `resources/CQUST/cqust_01.js`（MIT，文件头作者 yuexps；同目录 `adapters.yaml` 的 maintainer 也是 yuexps） |
| 上游快照 | `baf83fa`（2026-11-10）。`git log -1` 核对 `cqust_01.js` 最后提交为 `3d15335`（2026-09-16，「优化教务适配，增加 WebVPN 通道」），与任务卡一致 |
| 上游平台 | 树维 EAMS 学生端**旧版课表页**：`/eams/courseTableForStd.action` + `/eams/dataQuery.action` + `/eams/courseTableForStd!courseTable.action`，课程以 `TaskActivity` 脚本内嵌在课表页 HTML 里。不是 cupk / jstc 那套 for-std `print-data` |
| 本适配器 | `jw-adapters/cqust/`。`extract.js` 只取数，`parse.js` 纯转换 |
| 移植者 | 0x7E-2023（haiku 移植，2026-11-10） |
| 结论 | **安全性通过**（§2）。**正确性未在真机验证**：没有本校账号，夹具与浏览器冒烟都是合成的 |

## 0. 模板选择

任务卡指定 **cupk**（批次三十四已审的树维 EAMS 件）。cupk 走的 for-std `print-data` 与本校不是同一条取数路径，所以只借它三样东西：目录与 manifest 结构、载荷组装与提醒口径（周次段 / 总周数 / 缺教师缺教室 / 节次时间）、AUDIT 的结构。

真正同构的是 **sjzu**（沈阳建筑大学，自写并已审）：同样是 `courseTableForStd.action` + `courseTableForStd!courseTable.action` + `TaskActivity` + `activity.index = 天*unitCount + 节` + 位图周次。`parse.js` 里读脚本参数、剥 `index`、按「天 + 教室」并连堂的那套代码沿用 sjzu 的做法，删掉了它本校专属的助教处理与院内作息表。

## 1. 请求清单

只在已经打开本校课表页（WebVPN 上还要求路径里有 `/eams/`）、且当前页不是登录页时发请求。主机只有 `ALLOWED_HOSTS` 里那三个，地址一律用「当前页源 + WebVPN 前缀 + `/eams`」拼，脚本里没有写死主机。

| # | 方法 | 地址 | 干什么 | 拿不到时 |
|---|---|---|---|---|
| 1 | GET | `{源}{/http<十六进制>}/eams/courseTableForStd.action` | 读排课标识 `ids`（`bg.form.addInput(form, "ids", "…")` 或 `<input name="ids">`）、学期栏编号 `semesterBar…Semester`、当前学期号（学期栏上的 `value`，其次页内 `semesterCalendar({…value:"…"})`） | 读不到 `ids` 报错，请学生打开「我的课表」；响应里出现 `login.action` / `actionError` / `用户登录` / `密码错误` 时按登录失效报错 |
| 2 | POST | `{…}/eams/dataQuery.action` | 学期列表原文。请求体照上游：`tagId=…&dataType=semesterCalendar&value=561&empty=false`（`value=561` 是上游抓包时的当前学期号，学期列表本身与它无关，照搬不改） | 交 `null`，不阻断。学期号退回第 1 步页面上读到的；两边都没有才报错 |
| 3 | POST | `{…}/eams/courseTableForStd!courseTable.action` | 课表页 HTML。请求体照上游：`ignoreHead=1&setting.kind=std&startWeek=1&project.id=1&semester.id=<学期号>&ids=<学号>` | HTTP 非 2xx 报「教务系统返回错误（代码 N）」；200 但页面里没有 `TaskActivity` 报「这个学期可能还没排课」 |

登录页（密码框，或地址是 `/login.action` / `/loginExt.action`）、WebVPN 门户页（`web.cqust.edu.cn` 上路径里没有 `/eams/`）、别的主机：直接提示，**不发请求**。

`manifest.loginUrl` 是 `https://web.cqust.edu.cn/`（任务卡定的入口）。`scheduleUrlHint` 按任务卡省略：EAMS 课表页要带学生自己的 `ids`，没有稳定的直达地址。`allowHosts` 就是上游 `ALLOWED_HOSTS` 那三个主机，不通配。

## 2. 移植手册 §5 八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读密码框的值，不读本地存储、Cookie。取数只用已登录页面的同源会话 |
| 2 | 不外发 | 通过。只有上面 3 条同源请求，没有上报、外链脚本 |
| 3 | 请求域可控 | 通过。主机只有那三个，`allowHosts` 不长通配；WebVPN 前缀取自当前地址，不写死 |
| 4 | 只读课表 | 通过。不请求成绩、学籍、缴费。学号 `ids` 只用于拼第 3 条请求与抹除页面里的 `ids=`，不进交出对象、不进报错、不进夹具 |
| 5 | 不埋点 | 通过 |
| 6 | 不 eval | 通过。无 `eval`、`new Function`；课表脚本只按字符读参数，不执行 |
| 7 | 不写页面 | 通过。不碰 DOM 写操作、不提交表单；`document` 只用来读密码框与当前地址 |
| 8 | 不硬编码秘密 | 通过。无学号、无密钥 |

没有提问桥。上游的学期选择弹窗没有搬过来。

## 3. 读了什么、交出去什么

`extract.js` 只交出四个字段：

- `today`：取数当天 `yyyy-MM-dd`。教务不给开学日时 `parse.js` 拿它当推算基准，原样交出才钉得住回归用例。
- `semesterId`：当前学期号。
- `semesterRaw`：`dataQuery.action` 的学期列表原文（没有学生个人信息）。
- `courseHtml`：课表页 HTML 里**能明确定位的片段**，不是整页——
  1. 带 `TaskActivity` 的 `<script>` 块；
  2. 找不到这种块时（课程写在畸形标签里的极端写法），按 `new TaskActivity(` 逐个括号配对截出调用本身，加上紧跟着的 `index = …;` 赋值和 `unitCount = …;` 声明，页头页脚不进来；
  3. 带「第 N 节 HH:MM-HH:MM」的表格格子；
  4. 「未安排时间任务列表」那张表。

  连片段都拿不到就按「页面结构不对」报错、零输出。**没有「退回整页」这条路**，白名单绕不过去。
- 交付前统一过一遍 `scrubPersonal`：`ids=<学号>`（`ids=N` / `ids="N"` / `ids='N'` 三种写法）、`学号：` / `姓名：` / `身份证：` / `手机：` / `证件号：` 这类标签后面的值、裸的 18 位身份证号与 11 位手机号，一律抹掉。

`parse.js` 用到的字段：`courseHtml`（`TaskActivity` 参数、`index` 赋值、`unitCount`、节次时间格子、未安排时间任务列表）、`semesterRaw`（`{id,schoolYear,name}`）、`semesterId`、`today`。

`TaskActivity` 参数位置照上游与同族 EAMS 件（UESTC 文件头、HPU 的实现一致）：第 2 个教师、第 4 个课程名、第 6 个教室、第 7 个周次位图。参数写成字面量、`new Array(...)`、`xxx.join(...)`、变量都就地读出，读不出的计次提醒，绝不把表达式原文当值。

教师 / 教室写成 `未知`、`未知地点`、`待定`、`暂无`、`暂无教师`、`暂无教室`、`无` 时，交出去是 `null`。教室写「停课」的记录是教务的临时停课标记，跳过并提醒。

## 4. 与模板 cupk 的差异（逐条）

1. 取数完全不同：cupk 是 for-std `print-data` 的 JSON；本校是旧版 EAMS 三条请求 + 课表页 HTML，课程从内嵌的 `TaskActivity` 脚本里读。
2. 学期：cupk 从页面的 `#semesters` 下拉里挑；本校从学期栏 `value`、页内 `semesterCalendar(...)`、学期列表原文的 `semesterId` 三处依次取，都没有就报错（上游 `curSemId = '561'` 的硬编码猜测没有搬）。
3. 节次时间：cupk 只信教务给的 `courseUnitList`，缺就只提醒不编。本校上游写死了 11 节表，所以这里做成「课表页面上有「第 N 节 HH:MM-HH:MM」就用页面的；没有就用学校公布的 11 节表并提醒」；超出的节次按课间 10 分钟、每节 45 分钟顺推（上游的 `defaultClassDuration` / `defaultBreakDuration`）。
4. 开学日：cupk 有教务的学期起止；本校教务不给，按学年学期推算（秋季 9 月 7 日、春季 2 月 22 日所在周的周一，与上游的锚点一致），并提醒。
5. 教师：本校准许多位教师（上游直接当字符串；这里按 `,`、`、`、`;`、`/` 拆开去重后重新用半角逗号拼）。括号备注（外聘、主讲）留在原名字里，不拆成第二位教师。
6. 连堂合并：上游要求「下一节正好是 `end + 1`」，同一节的重复行会另起一段、课表重叠。这里按「天 + 教室」分组，**相邻节次且周次集合完全相同**才并成连堂；周次只部分重合的不并，各留一段（例：第 1 节 1-16 周、第 2 节 1-8 周 → 两个块，绝不出现第 9-16 周的第 2 节）。
7. 「未安排时间任务列表」：上游给它编了 `day=0 / section=0 / position='集中实践'`，载荷里 `dayOfWeek` 只允许 1..7，整次导入会被拒收。这里只计数并按课名提醒「排不下、没有导入」。
8. `allowHosts`/`loginUrl` 换成本校三个主机与统一身份认证入口。

## 5. 上游里删掉或改掉的

- 学期选择弹窗 `showSingleSelection`、拾光桥的 toast / `saveCourseConfig` / `savePresetTimeSlots` / `saveImportedCourses` / `notifyTaskCompletion`。已登录就用当前学期。
- 上游 `creditMap` 那段（解析课程代码与学分）整段没搬：交出去的对象里没有学分，读了也没用。
- 上游用整段正则从 `TaskActivity(...)` 里抓双引号字符串；这里改成按括号配对切参数再逐个读，兼容单引号、数组、变量与 `join`。
- 上游把「未安排时间任务列表」编造成第 0 天第 0 节（见 §4.7），改为提醒。
- `calcSemesterStartDate` 里 `termName.includes('2')` 这种判定保留为「是第二学期」，但补上了「学年只有一个年份时按 +1 年算」的分支。
- 学号 `ids` 与页面里的 `ids=` 参数不交出去。

## 6. 本校边界（夹具）

8 对，期望值全部按规范和代码逻辑手工推出来（含日期先算星期几），不是把 `parse.js` 输出存下来。数据是合成的，没有真实姓名学号。

| 夹具 | 覆盖 |
|---|---|
| basic | 位图周次、连堂合并、同一节的重复行并进同一段、课程名末尾课程代码去掉、缺教师缺教室、学期名取自学学期列表、节次时间回落到学校 11 节表 |
| weeks-text | `(单)1-8周(双)9-16周` → 1-7 单周 + 10-16 双周（不是 1-16 每周）；后置 `1-16周(单)`；`第1周至第8周`；周次里混着 `第3-4节` |
| missing-teacher-room | 缺教师 2 门、缺教室 2 门按课程汇总；`暂无` / `待定` / `未知地点` 一律当没有 |
| page-times | 课表页面给出第 1-2 节，第 3-5 节按上一节顺推并提醒 |
| no-semester | 学期列表没取到：学期名写成学校名 + 学年学期，开学日按 9 月 7 日所在周的周一推算 |
| long-warn | 三门长课名缺教师缺教室，课名截到 20 字，两条提醒都在 200 字以内 |
| merge-weeks | 同课同师同教室：第 1 节 1-16 周、第 2 节 1-8 周 → 两个块（1-16 第 1 节、1-8 第 2 节），不出现第 9-16 周的第 2 节；周次一样的第 3-4 节照常并成连堂 |
| dirty | 参数不够、周次全 0、周次写成不存在的变量、节次越界、标了停课、未安排时间的课——逐条计数提醒，好课照常导入 |

## 7. 浏览器冒烟

`.test/port-batch35/cqust/smoke.py`（Playwright 起假教务站，`route` 全拦截，不联网），12/12 OK：

`normal`（直连三请求，请求体校验）、`webvpn`（三条请求都带上 `/http<十六进制>/` 前缀）、`login`（密码页零请求）、`login-html`（入口返回登录页时只发 1 条就报登录失效）、`webvpn-portal`（门户页零请求）、`other-host`（别的主机零请求）、`empty` / `no-task`（拿不到排课片段 → 报「页面结构不对」，不交整页）、`leak`（页头写着「学号：2026000001 姓名：学生某」、课程写在畸形标签里 → 交出去的内容里两样都没有）、`scrub`（script 块里夹着学号、姓名、身份证号、手机号 → 全部抹掉）、`table-500`（HTTP 500 与结构不对分开说）、`no-semester`（学期栏与学期列表都没有学期号时报错，只发 2 条请求）。

每个成功场景都把 `extract.js` 的输出交给 Rhino 跑 `parse.js`，校验学期名、开学日、安排条数、提醒长度、交出去的字段白名单，并确认学号与姓名没有带出。

## 8. 变异测试

在 `parse.js` 上改坏再还原，自检先 DIFF 再 PASS：

1. `weeksFromText` 里「本段以 `(单)` / `(双)` 开头时，后一个标记归下一段」改成不隔开 → `weeks-text` 变红（前置单双退化成 1-16 每周）。
2. `weeksFromBitmap` 从第 0 位开始读 → `dirty` 变红（全 0 的那条不再是「周次为空」，冒出没有安排的课）。
3. `pageTimesFromHtml` 不生效（`pageTimes` 恒为空）→ `page-times` 变红（节次时间与顺推提醒都不对）。
4. `placeholder` 不再把「暂无」当空 → `missing-teacher-room` 变红（`teacher` 变成「暂无」，缺教师计数从 2 变 1）。
5. 连堂合并改回「周次重合度 ≥ 30% 就并」→ `merge-weeks` 变红（第 1、2 节并成一块，周次被并成 1-16）。

五处都已还原，最终自检 PASS。

## 9. 没验的部分

- 没有本校账号，三条请求的路径、请求体、`TaskActivity` 参数位置都来自上游代码（与同族 EAMS 件 UESTC / HPU 一致），真机改版会进提醒或报错，不会静默交出错课表。
- 课表页面上到底有没有「第 N 节 HH:MM-HH:MM」这种格子没有真机确认（HPU 的实现说明同族 EAMS 有）。没有就回落到学校 11 节表并提醒，不会编时间。
- 开学日是按学年学期推算的（教务不给），每学期都会提醒学生核对。
- `scrubPersonal` 只认带标签的值（`学号：`、`姓名：`、`身份证：`、`手机：`、`证件号：`）与裸的 18 位身份证号、11 位手机号；脚本里没有标签的写法（例如 `var studentName = '张三';`）抹不到。挡这类信息靠的是「只交能定位的片段、不交整页」这条路，不是这个函数。
- `dataQuery.action` 的 `value=561` 照上游没改，不参与学期选择；学期号以页面和学期列表里的 `semesterId` 为准。
- `minAppVersionCode` 为 11。输出仍是 `kind:"schedule"`。

0x7E-2023（haiku 移植，2026-11-10）
