# 安全审计 —— 浙江万里学院（正方新版 jwglxt，门户登录 + 教务独立主机）

审计对象：`jw-adapters/zwu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `resources/ZWU/zwu_01.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取；
本校脚本最后一次修改 `bdb97ca`，2026-10-14；MIT，作者 星河欲转）。上游同目录 `adapters.yaml` 只有一个条目 `ZWU_01`，
`import_url` 为学校门户 `https://ehall.zwu.edu.cn/_layouts/15/ZWUWSBS/BSDT/HomePage.aspx#`（去掉末尾 `#` 即 manifest 的 `loginUrl`）。

复制模板：批次八的 `jsei`（门户 / 双主机写法、周次两处修正、合并两阶段都在里面）。移植件与模板的差异见第 5 节。

审计方式：逐行读上游脚本与移植件；`check.js` 自检（7 对 fixture 用 Rhino 1.8.0 实跑，载荷校验，ES5 与控制字节扫描，`allowHosts` 检查）；
`extract.js` 用 Node 桩（`vm` 沙箱，桩 `window` / `document` / `fetch` / `DOMParser`，不联网）跑 5 个场景，记录实际拼出的地址与请求体；
变异测试 4 处，见第 8 节。扫描结果：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有一处上游仓库地址（注释，不是请求）。`extract.js` 的请求地址全部由
  `window.location.origin` 拼出，没有写死主机名。
- 网络调用：只有 `extract.js` 里 `request()` 中的一处 `fetch`。`parse.js` 没有任何网络调用。
- 凭据、本地存储、Cookie、动态执行、信标、WebSocket、`new Image`：全部无命中。
- 上游 `showPrompt` / `showSingleSelection` / `showToast` / `save*` 等宿主桥调用：移植件不调用任何桥（保存由宿主根据载荷完成）。

## 1. 请求域与请求清单（与代码逐条对应）

上游 `zwu_01.js` 写死 `BASE_URL = "https://jw.zwu.edu.cn/jwglxt"`，没有请求节次时间接口（上游注释：「不再请求教务作息接口，作息时间由内置的冬令时/夏令时方案提供」）。
移植件把地址改成「当前页面 origin + `/jwglxt`」，代码里没有主机名。

`manifest.json`：`loginUrl` 是门户 `https://ehall.zwu.edu.cn/...`，`allowHosts` 为 `["jw.zwu.edu.cn"]`（精确主机名，无通配）。
门户主机由 `loginUrl` 覆盖，教务主机由 `allowHosts` 覆盖；脚本只在教务主机上请求，不请求门户。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js `currentTerm` | GET | `<origin>/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的学年学期（`#xnm` / `#xqm`）。**页面上已经有这两个下拉框时不发** | 报错，提示重新登录后再点「提取课表」 |
| extract.js `fetchTimetable` | POST | `<origin>/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`，体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数。请求体与上游 `fetchAndParseCourses` 逐字一致 | 报错（不是 JSON 或没有 `kbList`），提示重新登录 |
| extract.js `optionalJson`（校历） | POST | `<origin>/jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`，体 `xnm=…&xqm=…` | 取学期周次校历，定开学日与总周数。与上游 `fetchSemesterStartDate` 一致 | 交 `null`；parse 推算开学日、总周数按 20 周，并写进 `warnings` |

与上游的差别（都不牵涉安全）：

- 上游用 `fetchAcademicOptions` 先取一次课表首页生成学年学期选择框，再用 `showSingleSelection` 让用户选。移植件：页面上读得到 `#xnm` / `#xqm` 就不发这条请求；读不到才取一次首页，用 `DOMParser` 离线解析（不插入当前页面）。
- 上游的校历请求失败被 `catch` 吞掉；移植件沿用「取不到就 `null`」，但失败会在 `warnings` 里说明（推算开学日）。
- 请求头统一带 `Content-Type`、`X-Requested-With`、`Accept`，不带任何自定义令牌。凭据用 `credentials: 'include'`，让 WebView 按同源规则带 Cookie；脚本既不读 Cookie，也不把它发到别处。
- `parse.js` 不发任何请求。

## 2. 读了什么、交出去什么（数据面）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期：`xnm` / `xqm` 与下拉框文本 `xnmText` / `xqmText` | 课表页的 `#xnm` / `#xqm`，或课表首页 HTML 的同两个下拉框 | 带出（学期名要用） |
| 今天的日期 `today`（本地 `yyyy-MM-dd`） | 手机本地时间 | 带出（只用来选冬令时 / 夏令时） |
| 排课行 `kbList` | 课表接口 | 每行只带 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` 六个字段（`extract.js` 的 `ROW_FIELDS` 白名单） |
| 集中实践课 `sjkList` | 课表接口 | 每行只带 `kcmc` |
| 记录总数（`total` / `totalResult` / `totalCount` / `count` 之一，如有） | 课表接口 | 带出一个数，仅用于对账 |
| 校历 `calendar` | 校历接口 | 整段原样带出（`zs` / `zsmc` / `zrq` / `zcrq` / `rq` / `ksrq` 之一有日期即可，行内没有学生信息） |

不带出：响应里的 `xsxx`（学号、姓名、学院等）、`xqh_id`、`kch`、`xkbz` 等其余字段，以及任何学生个人信息。
桩跑场景 C 的响应里放了一段假的 `xsxx`（含学号、姓名、学院），交出的 JSON 里搜不到，结果为 `false`。

交给 parse 的对象键：`term`（`xnm` / `xqm` / `xnmText` / `xqmText`）、`today`、`raw`（`kbList` / `sjkList`）、`total`、`calendar`。
没有 `periodTimes`：本件不取教务的节次时间，节次时间全部由 parse 按季节内置。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。`extract.js` 不读 `password` / 登录表单 / `localStorage` / Cookie；只靠 `credentials: 'include'` 让浏览器带同源 Cookie。 |
| 2 | 不外发 | 通过。全部外发请求是第 1 节的三个同源地址；`parse.js` 无网络调用；无信标、无 WebSocket、无 `new Image`。 |
| 3 | 请求域可控 | 通过。地址由 `window.location.origin` 拼出；`allowHosts` 为精确主机 `jw.zwu.edu.cn`，无通配；门户主机只在 `loginUrl` 里，脚本不请求门户。 |
| 4 | 只读课表 | 通过。只请求课表与校历两个接口，不请求成绩、学籍、缴费、个人信息。上游的节次时间接口在移植件里已删（见第 6 节）。 |
| 5 | 不埋点 | 通过。无统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | 通过。无 `eval` / `new Function`；`JSON.parse` 只解析接口返回的数据。 |
| 7 | 不写页面 | 通过。不改 DOM，不改表单，不触发提交；学年学期只读 `#xnm` / `#xqm` 的 `value` 与选中项。 |
| 8 | 不依赖秘密 | 通过。无硬编码学号、令牌、密钥；学年学期取自页面。 |

## 4. 本批共性检查表（公共说明 1–7）

- 取数三连：课表页 HTML（读下拉框）、校历、课表，全部同源，`<base>` = origin + `/jwglxt`。✓
- 不弹窗：不调用 `showPrompt` / `showSingleSelection`，直接读页面下拉框。要别的学期，用户在教务页面切换后再点「提取课表」。选中的学期名（`xnmText` / `xqmText`）交给 parse 当学期名。学期码不写死。✓
- 课表响应只交白名单字段。`sjkList` 只留 `kcmc`。学生信息不带出。✓
- 不照抄上游的严格过滤：缺教师 / 缺教室的课照常导入（`teacher` / `location` 为 `null`），按课名汇总进 `warnings`（指向「编辑课程」）。✓
- 节次时间：本件不请求（任务卡规定，也与上游一致）；节次表写在 parse 里，按季节选用，逐节照抄上游 `WINTER_TIME_SLOTS` / `SUMMER_TIME_SLOTS`（14 节）。H3 顺推见第 5 节。✓
- 登录页 / 门户页：页面路径不含 `/jwglxt/` 提示先从门户进入教务；在 `login_slogin.html` 上提示先登录。两种都不发请求。桩跑场景 A、B 已确认。✓
- 非标准入口：`loginUrl` 为门户，`allowHosts` 为教务主机，未经改写。✓

## 5. 与模板 `jsei` 的差异

1. **不请求节次时间**：模板请求 `skxxMobile_cxRsdjc`（`xqh_id=1`），本件删除。`extract.js` 不再交 `periodTimes`，也不交 `campusId`（`xqh_id` 只服务于节次时间，已从白名单去掉）。`cxRjc` 未加。
2. **两套节次时间**：parse 按 `today` 的月份选一张表（5–9 月夏令时，其余冬令时），载荷只放一张。`today` 缺失或不合法时按冬令时。另一套的第 6–14 节逐节写进 `warnings`（分两条，各不超 200 字），并说明换季后去「学期管理」改节次时间。
3. **删除模板的节次时间两条分支**：`periodTimesOf`（教务节次时间的解析）、`apiPeriodTimes` 与「教务系统没有给出节次时间」的提醒，本件都没有这条数据来源，删除。
4. **删除 11 节表与 12 节「空课默认」表**：模板的 `SCHOOL_PERIOD_TIMES` 与 `BUILTIN_PERIOD_TIMES`。本校内置表是 14 节。H3 的「空课默认 12 节表」分支对本校不适用：12 节表覆盖不到第 13 节及以后，第 15 节起只能顺推，所以本件的顺推直接接在 14 节表后面（课间 5 分钟、每节 45 分钟，越过 23:59 就停）。顺推规则与模板一致（统一修订 H3 的「补不了就顺推、补了写进提醒」口径）。
5. **登录判断**：模板只判断 `login_slogin.html`。本件增加门户判断：路径里没有 `/jwglxt/` 就提示先从门户进入（对应任务卡第 3 条）。
6. **地址拼法**：模板的 `jwBase()` 会按当前路径保留 `/jwglxt` 之前的前缀（为 WebVPN 前缀准备）。本件上下文路径固定为 `/jwglxt`，`jwBase()` 直接返回 `origin + '/jwglxt'`。
7. **学校名**：`SCHOOL_NAME` 改为「浙江万里学院」，学期名兜底也用它。
8. **缺教师 / 缺教室的提醒**：模板写「请核对」，本件改为「请在「编辑课程」里补上」（教师 / 教室在「编辑课程」里改，不写「学期管理」，见公共说明「审计真抓到过的错」）。
9. **校历日期字段**：模板的 `calendarInfo` 已经认 `zrq` / `zcrq` / `rq` / `ksrq` 四种，本件沿用，无需补。`ksrq` 与「第 1 周不是周一」两种情况由 fixture `period-overflow` 钉住，`zcrq` 由 fixture `summer` 钉住。

## 6. 对上游的删改（都不牵涉安全问题，审阅者需要知道）

- `BASE_URL` 写死 → origin 拼接。
- `fetchAcademicOptions` + `selectAcademicYearAndSemester`（弹窗选学年学期）→ 读页面下拉框，页面读不到才取一次首页。
- 上游的节次时间：上游注释写「不再请求教务作息接口」，本件保持不请求；上游的 `WINTER_TIME_SLOTS` / `SUMMER_TIME_SLOTS` 与 `buildComboSchedule` 的组合作息方案（`saveComboSchedule`）→ 移植件不调用宿主的作息保存桥，只在载荷里放当前季节的一张表，另一套写进提醒。**这是本件与上游最主要的行为差异**：上游会把两套表都存进应用，换季自动切换；本件只能导入一张表，换季要学生自己改（已在提醒里说明，见第 9 节）。
- 上游的 `saveCourses` / `saveCourseConfig` / `importBaseTimeSlots` / `notifyTaskCompletion` 等宿主桥调用 → 移植件只交数据，由宿主按载荷导入。
- `parseJsonData` 对缺教师 / 缺教室整行丢弃 → 不丢，按公共说明第 4 条处理。
- `parseWeeks` 的「共 N 周」剥离是贪婪的 `.*$`（会把后面的真实周次段一起吞掉）→ 只剥备注本身（模板 `jsei` 的修正）。
- 上游 `parseWeeks` 不认「(单)1-8周,(双)9-16周」这类前缀标记（段首标记会并到上一段）、不认「1-16(单周)」、不摘教学班序号括号 → 模板的周次解析（单/双标记按位置归属、序号括号摘掉）。
- 上游 `jcs.split('-')` → 模板的节次解析（「第9-10节」「1,2」「0102」）。
- 上游 `fetchSemesterStartDate` 取第 1 周的 `rq` 首段原样当开学日、不回退到周一 → 回退到那一周的周一（手册 §4.3）。上游找不到第 1 周时拿第一行顶替 → 不顶替，宁可推算。

## 7. 合并等价性（对齐上游 `mergeAndDistinctCourses`）

同模板 `jsei`：先去完全相同的行，再做阶段 1（同课、同周次、节次首尾相接则合并），再做阶段 2（同课、同节次则周次取并集）。
`fixtures/merge.*` 钉住三种情况：连续节次合并（1-2 + 3-4 → 1-4）、完全重复的行只留一条、同节次 1-8 周与 9-16 周取并集。

## 8. 变异测试记录

在临时副本（`C:/Users/23703/AppData/Local/Temp/zwu-port9/m*/zwu`）上改 `parse.js` 的一处，跑 `check.js`，然后丢弃副本；
`D:/NullClass/jw-adapters/zwu/` 下的文件未被改动，自检仍为 PASS。

| 编号 | 改坏的地方 | 变红的用例 |
|---|---|---|
| m1 | 节次表季节判断取反（`todayMonth` 5–9 月改选冬令时） | 7 对中的 7 对全部 DIFF（basic、summer、today-missing、period-overflow、week-markers、long-name-missing、merge） |
| m2 | 「共 N 周」备注改回上游的贪婪 `.*$` 剥离 | `week-markers`（「共周备注课」「共在前课」整行丢周次，报 DIFF） |
| m3 | 顺推每节时长 45 分钟改成 40 分钟 | `period-overflow`（第 15、16 节的时间与第 17 节是否补上都会变，报 DIFF） |
| m4 | 校历日期字段去掉 `ksrq` 回退 | `period-overflow`（开学日提醒的文字变成「没有给出开学日期」，报 DIFF） |

## 9. 已知风险与未验证项

- **没有本校账号，真机没验过。** 门户到教务的跳转（`ehall.zwu.edu.cn` → `jw.zwu.edu.cn`）、教务页面的实际 DOM、接口的实际响应，都只按上游脚本与模板推断。
- **上游注释写「仅支持校园网内网直连」**（`zwu_01.js` 文件头）。`adapters.yaml` 的描述却写「校内访问和 vpn 访问都可以」。两者不一致；本件按任务卡的 `allowHosts` 放行 `jw.zwu.edu.cn`，校外访问是否可用没有验证。
- **换季只能导入一张表。** 节次时间按导入当天的月份选。学期中途换季（如 9 月开学、10 月起用冬令时）时，导入的表可能与实际不符一段时间；提醒里已写明另一套的时间与换季日期，需要学生自己在「学期管理」里改。上游会把两套都存下来，换季自动切换，这一点本件做不到。
- **`today` 取手机本地日期。** 与学校实际时区一致时才准确。
- **第 15 节及以后的时间是顺推的，不是学校的时间表。** 上游的节次表只到 14 节；提醒里已说明。
- **学期码假定** 3 = 第一学期、12 = 第二学期（同正方常见值，上游写死的也是这两个）；`xqmText` 有「一 / 二 / 三」时优先看文字。
- **校历接口假定存在。** 取不到就推算开学日并提醒，推算依据是 9 月 1 日（第一学期）/ 2 月 20 日（第二学期）所在周的周一，不一定与学校相符。
- **附加请求的成功与否只能靠代码推断**：校历接口的实际字段名（`zs` / `zrq` 等）未经真机核对，桩跑只用了我们假定的形状。

## 10. 签名

0x7E7-2023（haiku 移植，2026-10-20）

## 修订 1.0.1（2026-10-27）：无逗号的前置单双标记

- 问题：`(单)1-8周(双)9-16周`（前置标记、两段之间没有逗号）里的第二个标记前面紧挨「周」，被当成上一段的后缀，两段并成「单双都有」，整门课读成 1-16 周每周都上（批次十八 `jxfu`、批次十九 `smu` 审计发现，探测后确认本件同样如此）。
- 修正：`weeksOf` 里夹在两段中间的标记，若它所在的这一段以前置标记开头，就判给下一段；否则仍按后缀归上一段，`1-8周(单)9-16周(双)` 等后置写法不受影响。段间只有空格的 `(单)1-8周 (双)9-16周` 也一并读对。
- 回归：差分测试（`.test/fix-prefix/diff.js`）对 32 种其它周次写法比对修订前后输出，修订前读对的全部一字不差；7 种无逗号前置写法读出的周次与手推一致，整份输出与修订前代码对等价后置写法的输出一致。
- 新增 fixture `weeks-prefix-glued`：期望取修订前代码对等价后置写法 `1-8周(单),9-16周(双)` 的输出（该写法修订前已正确）。
- 版本 1.0.0 → 1.0.1。
