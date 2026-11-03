# 安全审计 —— `ccsut`（长沙工业学院 · 超星教务）

移植者签名：0x7E7-2023（haiku 移植，2026-11-03）

出处：shiguang_warehouse（MIT）`resources/CCSUT/ccsut_01.js`，作者「小漫君」（adapters.yaml 的 maintainer；文件头写明派生自 b1n23 的超星通用脚本 `chaoxing.js`，并参考 `HBUAS/hbuas_01.js`）。上游快照 `29498b0`（与任务卡一致）。本校脚本最后一次修改是 `5b33178`（`git log -1 -- resources/CCSUT/ccsut_01.js` 核对过）。文件头的「上游基线」`174396a` 是作者自己写的旧基线，不是现在的快照。没有改快照。

模板：已审计的 `ustl`（辽宁科技大学，同为超星：课表页 HTML + `sdpkkbList` + `getZclistByXnxq`，课程行是数组、周次是逗号数字、上游没有写死的节次表）。选它而不选 `xsyu`：`xsyu` 有写死的三张节次表，本校上游没有对应表，照抄会把别人的作息写成本校的。`parse.js` 的合并、周次、节次、开学日、提醒文字都照 `ustl` 已审计的版本，只改了文件头和取不到学期名时的回落名。

## 0. 本校与上游的结构（分析，先于动手）

上游 `runImportFlow` 的实际顺序（以代码为准）：

1. 地址 `hostname` 不是 `tls.ccsut.cn` 就报错（`runImportFlow`）。
2. 弹确认框 `promptUserToStart`。
3. `fetchImportParams`：GET `/admin/pkgl/xskb/queryKbForXsd`，DOMParser 读 `#xhid`、`#xqdm`，学年学期下拉 `#xnxq1`（或 `select[name="xnxq"]`）。
4. `selectAcademicYearAndSemester`：弹窗选学期（用的是下拉框的默认选中项）。
5. `selectCampus` / `fetchCampusList`：**每次都** GET `/admin/api/jcsj/xqsj/getXqList`，弹窗选校区；列表失败就用入口页的 `#xqdm`。
6. `fetchTimeAndWeekData`：GET `/admin/api/getZclistByXnxq?xnxq=&xqid=`，读 `jcsjszList`（节次时间，`kssj` / `jssj` / `jc`）和 `zclist`（第 1 周 `minrq` 作开学日）。失败只提示，课照常导。
7. `fetchCourseData`：GET `/admin/xsd/pkgl/xskb/sdpkkbList?xnxq=&xhid=&xqdm=&xskbxslx=0`。课程在 `data` 数组；`zcstr` 是逗号数字；连续节次只认「正好下一节」（`end + 1`）合并；`croommc` 空就写「待定」。
8. `saveCourses` / `importPresetTimeSlots` / `saveCourseConfig`：调上游桥写库，然后 `notifyTaskCompletion`。

上游**没有**写死的节次时间表，也没有第二台主机。学生标识只出现在课程请求的查询参数里。

上游的几处值得记下的代码事实（都是 `parse.js` / `extract.js` 里要对上的）：

- `extractAnchorText` 只取第一段 `>文字<`：`<a>张三</a>,<a>李四</a>` 上游只得到「张三」，第二位老师丢了。
- `cleanTeacherName` 把括号里的内容整段删掉：`王建国（副教授）` 得到「王建国」，`赵六,(,钱七,)` 这种畸形写法钱七也一起丢。
- `parseWeeks` 只认逗号数字；上游没有区间、「第」字、「共 N 周」、单双标记的处理。
- 上游的 `fetchTimeAndWeekData` 失败时节次和开学日都是 null，课照常导；本适配器对应地在 parse 里用默认节次表并写提醒（见第 9 节）。

空课侧的对应决定：

- 学期不弹窗，取入口页下拉框当前选中项（同上游默认），选不中用第一个有值的选项。
- 校区：入口页有 `#xqdm` 就直接用，**不请求** `getXqList`、不提问。入口页没有代号才请求列表：只有一个就用它；有多个才用 `__ncSelect` 问一次（节次时间会随校区变，所以判断不了时才问）；取消或提问桥不在就报错，不猜。
- 不在本站（统一认证页 `auth.ccsut.cn`、智慧校园页 `ehall.ccsut.cn`）、登录页、门户页上点「提取课表」只给一句大白话，**不发请求**。
- 入口参数只从入口页 HTML 读，**不读当前页面的课表 DOM**（与上游的 `fetchImportParams` 一致，也和任务卡「不读页面 DOM」一致）。

## 1. 请求了哪些地址（手册 §5 第 3 条）

全部是本站的相对路径，`fetch` 的目标都是当前页面的 `tls.ccsut.cn`。代码里没有绝对 URL。`allowHosts` 为 `["tls.ccsut.cn"]`，不写通配。`loginUrl` 的主机 `auth.ccsut.cn` 不在 `allowHosts` 里：代码不请求它，只在 `pageKind` 里靠 `hostname` 判断「不在本站」。

| # | 方法 | 地址（相对路径） | 用途 | 取不到时怎么办 |
|---|---|---|---|---|
| 1 | GET | `/admin/pkgl/xskb/queryKbForXsd` | 入口页 HTML，读 `#xhid`、`#xqdm`、学年学期下拉框（每次都请求，不读本页 DOM） | HTTP 非 2xx：报「教务系统返回错误（代码 N）」；网络失败：报「连不上教务系统」；读不到学生标识：报「没能在教务系统里读到学生标识」；读不到学期：报「没能读到学年学期」 |
| 2 | GET | `/admin/api/jcsj/xqsj/getXqList` | **仅当入口页没有 `#xqdm`**：校区列表 | 返回码非 0 按教务报错；列表为空报错；一个校区直接用；多个用 `__ncSelect` 问一次；取消或提问桥不在则报「没有选择校区」，不猜 |
| 3 | GET | `/admin/xsd/pkgl/xskb/sdpkkbList?xnxq=&xhid=&xqdm=&xskbxslx=0` | 课程行（`data` 数组，外壳在 `rowsOf` 认一次） | 返回码非 0：报「教务系统返回错误（代码 N）」，不回显教务原话；非 JSON 或登录页 HTML：报「登录状态可能已失效」；外壳认不出：报格式可能变了；空列表：报该学期没有课程 |
| 4 | GET | `/admin/api/getZclistByXnxq?xnxq=&xqid=` | 周次表（`zclist`：`zc`、`minrq`）与节次时间（`jcsjszList`：`jc`、`kssj`、`jssj`） | 任何失败都当作空表（`fetchWeekData` 吞掉错误）：课程照常导入；开学日按学期锚点推算、总周数用 20、节次用默认 12 节，全部写进提醒 |

`xhid` 只放进第 3 个请求的查询参数，不进输出。

## 2. 读了什么、交出去什么（手册 §5 第 2、4 条）

读了、但不交出去：学生标识 `#xhid`（只用于第 3 个请求）；课程行里白名单以外的任何字段（学号、姓名、身份证号、手机号等）；入口页里其余的 HTML。

`extract.js` 交出去的 JSON（`run` 的返回值）：

- `term.code` / `term.text`：入口页学年学期下拉框当前选中项（没有就第一个有值的）。
- `campus.xqid` / `campus.xqmc`：入口页 `#xqdm`；名称优先用校区列表里的名称，没有再用课程行里与该代号相符、出现最多的校区名（都没有则为空）。
- `askedCampus`：只有「入口页没代号且问过学生」时才是校区名，否则 `null`。
- `rows[]`：白名单 `kcmc`、`tmc`、`croommc`、`xingqi`、`djc`、`zcstr`、`xqid`、`xqmc`（`pick` 按字段挑）。
- `slots[]`：白名单 `jc`、`kssj`、`jssj`。`weeks[]`：白名单 `zc`、`minrq`。

`parse.js` 再做成课表载荷：课名去 HTML 标签；教师去职称括号；教室的「待定 / 未知 / 暂无」等写成 `null`；周次切成 `ALL` / `ODD` / `EVEN` 区间。输出只含 `specVersion`、`kind`、`ocrAssisted`、`warnings`、`terms`。

## 3. 手册 §5 八条逐条

| # | 结论 |
|---|---|
| 1 不碰凭据 | 不读密码框、不读登录表单、不碰 localStorage / cookie（`credentials: "include"` 只是让浏览器带上已有的会话）。学生标识只放进课程请求 |
| 2 不外发 | 只有相对路径的 `fetch`，没有信标、WebSocket、图片上报、第三方脚本 |
| 3 请求域可控 | `allowHosts: ["tls.ccsut.cn"]`，无通配。代码只请求这一台主机，`loginUrl` 的 `auth.ccsut.cn` 代码不请求 |
| 4 只读课表 | 四个地址都是入口页、校区、课程、周次 / 节次。不请求成绩、学籍、缴费、个人信息接口 |
| 5 不埋点 | 无。上游的 `console.log` 调试输出全部没有搬过来 |
| 6 不 eval | 无 `eval`、无 `new Function`。入口页 HTML 只用 `DOMParser` 解析成文档对象，只读三个元素，不执行其中脚本 |
| 7 不写页面 | 不改 DOM、不提交表单。上游的 `saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig` / `notifyTaskCompletion` 已删，交给应用 |
| 8 不硬编码秘密 | 无密钥、无他人学号。fixture 与冒烟用的标识都是合成的 |

## 4. 相对上游的改动（与文件头「移植改动」逐条对应）

1. 解析（合并、周次、节次校验、开学日）都在 `parse.js`（`weeksOf`、`runsOf`、`serverSlotsOf`、`termNameOf`）。`extract.js` 只搬运。
2. 学期不弹窗（上游的 `selectAcademicYearAndSemester`）。
3. 入口页有 `#xqdm` 就不请求 `getXqList`、不提问（上游无条件请求、无条件弹窗）。没有代号才请求并按校区数决定是否问。
4. 学生标识只进课程请求，输出按白名单挑字段。
5. `pageKind`：统一认证页、智慧校园页、登录页、门户页分别给提示，请求数为 0。
6. 去掉确认框、toast、进度提示和上游写库。
7. 周次：除上游的逗号数字外，另认区间、「第」字、「共 N 周」（只剥备注本身，用 `/共\s*[0-9]+\s*周?/g`）、单双标记在前 / 在后 / 无逗号前置。见 `weeksOf`。
8. 教室：上游默认写「待定」，这里 `plainOrNull` 把「待定」「未知」「暂无」写成 `null`，缺了按课程汇总提醒。
9. 教师：上游只取第一段锚文字，并删掉全部括号内容；这里取全部锚文字（`<a>张三</a>,<a>李四</a>` 得「张三,李四」），职称括号丢弃（`TITLE_RE`），畸形括号里的人名保留（与 `ustl` 的审计结论一致）。**与上游不同**，见第 12 节风险。
10. 连堂合并条件是「下一节不晚于上一段结束再加 1」（`<=`），同一节的重复行并进同一段。上游是 `end + 1` 精确相等，重复行会另起一段、课表重叠。
11. 节次超出节次表：能对上默认表的用默认时刻，否则在上一节下课后课间 5 分钟、每节 45 分钟顺推，越过 23:59 就停并提醒。上游没有这一步。
12. 总周数：上游不给；这里用教务校历（`zclist` 的条数，日期与学期对得上时）；没有就用 20；课表有更晚的周就抬到那一周并提醒。

## 5. 上游里被删掉 / 改掉的东西及理由

- 学期弹窗 `selectAcademicYearAndSemester`：空课不在提取时改学期，学期以入口页当前选中为准（与上游默认值一致）。
- 校区弹窗与每次都请求的 `fetchCampusList`：入口页代号已能决定课程和节次请求，只在没有代号时才查。
- 开始导入确认框 `promptUserToStart`、各种 `showToast`：交给应用的界面。
- `saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig` / `notifyTaskCompletion`：交给应用。
- `formatTime` 用的 `padStart`：ES5 不允许，改在 `parse.js` 的 `timeOf` 里用 `pad2`。
- 教室默认「待定」：占位词会显示成教室名。
- `cleanTeacherName` 整段删括号：会丢掉畸形括号里的老师（如 `(,钱七,)`）。

## 6. fixture 是合成的

六对，数据都是编的，没有真实姓名或学号。期望按周次切段、开学日锚点（第一学期 9 月 1 日之后的第一个周一，即 2026-09-07）、节次表与提醒文案手工推演，不是把 `parse.js` 的输出存回去。`extracted` 文件由一次性脚本生成（生成脚本已删），内容按入口页 / 课程行 / 周次表的实际外壳写。

| 文件 | 覆盖 |
|---|---|
| basic | 连堂（`end + 1`）、逗号周次、职称括号、畸形括号教师（钱七）、教室「待定」、教师「暂无」、第 31 周丢掉、空课名跳过、列表式单双（`1,3,5,7,9,11` → ODD）、校历 18 周、单数字小时时刻 `8:20` 补零 |
| odd-even | `(单)1-8周,(双)9-16周`、无逗号前置 `(单)1-8周(双)9-16周`、后置 `1-8周(单)9-16周(双)`、`1-16周(双)` 与 `1-15周(单)`、「共 8 周」后面的 `9-16周` 还在、`第1-第8周`；学期名为空时回落为「长沙工业学院 学期名」并截到 20 字 |
| h3-fill | 教务只给 6 节（第 6 节结束于 16:10），第 7–8 节按顺推、第 9–11 节用默认时刻，提醒里分开写清 |
| long-name | 五门长课名（22 / 21 / 21 / 20 / 22 字），超 20 字的截短、正好 20 字的不截；缺教师 4 门、缺教室 3 门；每条提醒都低于 200 字 |
| dup-rows | 同一节 1、1、2 合成 1–2 节；同名同师但周次为 9–10 的另起一段 |
| calendar-campus | 两个校区（课程行带 `xqid`）、校历开学日 2027-03-01 不属于 2026-2027-1 所以整份校历作废、课排到第 22 周所以总周数抬到 22，提醒四条 |

## 7. 与模板（ustl）的差异

- 入口参数：`ustl` 的 `resolvePage` 在课表页时直接读本页 `document`；这里**一律**抓入口页 HTML（与上游一致，也符合「不读页面 DOM」）。
- 校区：`ustl` 的 `ensureCampus` 是同一套；这里入口页有代号时同样不请求，但没有代号时的回落路径与 `ustl` 相同。
- 节次：`ustl` 与本校一样都没有写死表，都用同一张默认 12 节（第 1 节 08:00–08:45）。
- 开学日 / 总周数：相同。
- 文件头、学校名、回落学期名（「长沙工业学院」）、manifest 与 fixture 都重写了。

## 8. 上游与空课载荷的对应（自检）

- 节次时间：上游从 `jcsjszList` 取，有效就用，取不到就不写节次。空课：有效就用教务的；取不到就用默认 12 节并提醒（见第 9 节）。
- 课程合并：上游按 `end + 1` 精确合并；这里 `<= end + 1`。
- 学期名：入口页下拉框的文字（如「2026-2027学年第一学期」），取不到就「长沙工业学院 + 学年学期」，不用适配器名。

## 9. 内置节次时间

上游没有写死的节次时间表，本适配器也不写死。教务没给、或给的表不连续、重叠、时刻不合法时，整张改用下面这张默认 12 节（与 `ustl` 同款）。提醒文案为「教务系统没有给出节次时间，节次时间是默认值（第 1 节 08:00-08:45，共 12 节），可能与学校实际不符，请在学期管理里核对」（见 `parse.js` 中 `warn` 的默认节次分支）：

| 节 | 时间 | 节 | 时间 |
|---|---|---|---|
| 1 | 08:00–08:45 | 7 | 16:00–16:45 |
| 2 | 08:55–09:40 | 8 | 16:55–17:40 |
| 3 | 10:00–10:45 | 9 | 18:30–19:15 |
| 4 | 10:55–11:40 | 10 | 19:25–20:10 |
| 5 | 14:00–14:45 | 11 | 20:20–21:05 |
| 6 | 14:55–15:40 | 12 | 21:15–22:00 |

课表用到的节次超出所用的表时，按第 4 节第 11 条补齐。真机上的上下课时间以教务 `jcsjszList` 为准，上表不是学校公布的作息。

## 10. 请求与输出的冒烟（2026-11-03）

`python -I -X utf8 D:/NullClass/.test/port-batch28/ccsut/smoke.py all`，假教务站拦在 `tls.ccsut.cn` 与 `auth.ccsut.cn`，不联网。11 个场景全部 OK：

| 场景 | 结果 |
|---|---|
| 教务页（入口页有参数） | 请求 `queryKbForXsd`、`sdpkkbList`（含 `xhid`、`xqdm=01`、`xskbxslx=0`）、`getZclistByXnxq`，共 3 次，不请求校区列表。输出无学号 / 姓名 / 身份证 / 手机号。高等数学合成 1–2 节，第 1 节 08:20 |
| 门户页 `/admin` | 报「当前还在教务系统首页」，请求数 0 |
| 登录页 `/admin/login` | 报「当前是登录页面」，请求数 0 |
| 统一认证页 `auth.ccsut.cn` | 报「请先从智慧校园进入教务系统」，请求数 0 |
| 智慧校园页 `ehall.ccsut.cn` | 同上，请求数 0 |
| 周次接口 500 | 课仍导入，节次时间回落默认 12 节（第 1 节 08:00），开学日与总周数按推算并写提醒 |
| 入口页没有校区代号、两个校区、选第 2 个 | 先 `getXqList`，问一次，课程请求用 `xqdm=02`，`askedCampus` 为「东校区」 |
| 提问取消 | 请求了 `getXqList`，然后报「没有选择校区」 |
| 入口页没有学生标识 | 报「没能在教务系统里读到学生标识」，请求数 1（只有入口页） |
| 课程接口返回码 -1 | 报「代码 -1」，不回显教务原话 |
| 课程接口返回登录页 HTML | 报「登录状态可能已失效」 |

每个场景还检查：请求只落在 `tls.ccsut.cn`；请求地址不含首页用户标识或个人信息；输出与载荷不含学号、姓名、身份证号、手机号；每条提醒 ≤200 字。

## 11. 变异测试记录

在临时目录的三份副本上分别改坏 `parse.js`，跑自检，三处都变红。真实目录未被改动，`parse.js` 原样保留。

| 改坏 | 变红的用例 |
|---|---|
| 段首 / 段中的单双标记归属：`if (nextNum && !(prevNum && !runFirstIsMark))` 改成 `if (nextNum)` | `odd-even`（「数学分析」`1-8周(单)9-16周(双)` 退化成 1–16 每周） |
| 连堂合并 `next.section <= endSection + 1` 改成 `===` | `dup-rows`（同一节重复行另起一段，课表重叠） |
| 提醒里的课名不截：`examplesOf` 的 `.map(shortName)` 改成 `.map(textOf)` | `long-name`（提醒超过 20 字的课名不截断） |

## 12. 已知风险与未验证项

- 没有本校账号，真机没验过。节次时间和开学日在合成数据上验过，没验过教务的真实返回。`jcsjszList` 的 `jc` 若是非数字格式，`serverSlotsOf` 会整张不用，改用默认 12 节并提醒。
- 没有写死的节次表，学校实际作息不一定是默认 12 节（第 1 节 08:00）。取不到节次时会提醒学生核对，但课表时间会按默认走。
- 教师括号：`张三(实验)` 会变成「张三,实验」（上游会变成「张三」）。这是 `ustl` 为畸形括号做的取舍，若本校真有这种写法，会多出一位「老师」。需要真机数据确认。
- 校区：入口页没有 `#xqdm` 且只有一个校区时直接用；有多个才问。若入口页有代号但学生实际在另一校区上课，节次会按入口页校区的表。提醒会点出校区数和节次时间用的是哪个。
- `pageKind` 的登录页判断靠地址里的 `/admin/login`、`slogin`、`/cas/`，这是 `ustl` 的经验，本校真实登录页地址未验证。统一认证页和智慧校园页靠 `hostname` 判断，比较可靠。
- 上游的 `hostname` 检查只允许 `tls.ccsut.cn`；若学校以后换了教务域名，两边都要改。
- `zc` 在合成数据里是数字，真机可能是字符串，`intOf` 与 `dateOf` 都接受字符串。

## 13. 引用方式

不写行号，按函数名引用：`pageKind`、`resolvePage`、`readParams`、`ensureCampus`、`askCampus`、`fetchWeekData`、`rowsOf`、`pick`、`weeksOf`、`runsOf`、`serverSlotsOf`、`plainOrNull`、`teacherOf`、`examplesOf`、`warn`。

- **复审修正（主调度，2026-11-03）**：① 教师括号备注同 huuc，新增 `NOTE_RE`，`basic` 钉「孙八（外聘）」→「孙八」，去掉过滤 → `basic` 变红。② 多校区且页面没给校区名时，节次时间明明来自教务，提醒却说「已按默认的节次时间导入」；改为只看节次时间来源，新增 `campus-noname`（期望手推）；改回旧条件 → 该用例变红。两处都与 ustl 同源，ustl 本身未改。
