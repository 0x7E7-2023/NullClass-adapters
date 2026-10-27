# 天津城建大学 适配器安全审计（URP 综合教务 · 统一认证登录）

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) `TCU/tcu_01.js`（MIT，上游作者 **星河欲转**，`adapters.yaml` 的 `maintainer`）；`import_url` = `https://authserver.tcu.edu.cn/authserver/login?service=https%3A%2F%2Fjwxs.tcu.edu.cn%2Flogin` |
| 上游快照 | `e15c6274ac347c9642da890504651a9b4e374391`（2026-10-26 拉取）；本校脚本最后一次修改：`80e30cf`（`git log -1 -- resources/TCU/tcu_01.js` 核对一致） |
| 平台 | URP 综合教务系统新版（`/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback`），与 aufe / lnu / neau 同平台 |
| 模板 | `aufe`（批次十五，同样读 `dateList[].selectCourseList[]`、同样的两阶段同课合并、缺教师 / 缺教室汇总、提醒收口）；取数链和选学期的做法参考 `lnu`（下拉框 `#planCode` + `/indexCalendar` 的 `var rq`）。选 aufe 是因为响应外壳、字段名、`classWeek` 位串和上游合并逻辑与本校上游脚本几乎一致；本校比它简单（固定接口、没有动态课表地址、没有单独的节次时间请求） |
| 移植者 | 0x7E7-2023（sonnet 移植，2026-10-26；收尾核对与变异测试 2026-10-27） |
| 结论 | 自检 PASS（8 对 fixture 全部一致）；浏览器冒烟 13/13 OK；变异测试 7 处全部变红并已还原。不碰凭据、不外发、只读课表、无第三方域、无埋点。**真机未验证**，见第 8 节。 |

## 1. 请求清单（与代码一致）

所有请求都是**同源相对路径**（上游写死绝对地址 `https://jwxs.tcu.edu.cn/…`；这里改成相对路径，页面必须停在教务主机上，白名单只放它）。代码里没有任何绝对 URL。`extract.js` 里 `fetch` 共 2 处（`requestSchedule`、`fetchCalendar`）。

| # | 方法 | 路径 | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| 1 | 课表页有学期下拉框时 POST；没有（或只有占位项）时 GET | `/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/callback` | 取课表 JSON（`dateList[].selectCourseList[]` 与 `jcsjbs`）。POST 体 `planCode=<下拉框选中的学期代码>`（`encodeURIComponent`），请求头 `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`X-Requested-With: XMLHttpRequest`；GET 时教务给当前学期。`credentials: 'same-origin'` | 401/403 → 「教务系统拒绝访问（代码 N）」；其它非 2xx → 「教务系统返回错误（代码 N）」；网络失败 → 「连不上教务系统」；返回不是 JSON → 「返回的内容格式不对」；没有 `dateList` → 「没有返回课表数据」。都是抛错，导入停止 |
| 2 | GET | `/indexCalendar` | 只用正则从页面文本里取 `var rq`（开学日 `YYYYMMDD`）和 `var skzc`（学期周数）两个字符串，**不交整页** | **任何失败都是 `null`，不阻断导入**；parse.js 按提取当天所在周的周一推算开学日、按课表最大周次推定总周数，并提醒 |

- 请求 1 在请求 2 之前发出，请求 2 只在请求 1 成功后发（冒烟 `expect_seq` 钉住顺序 `AJAX → CAL`）。
- 门户 / 登录页：主机是 `authserver.tcu.edu.cn`（统一认证），或路径是 `/login`、`/login/…` 时，直接报「这里还不是教务系统……」，**不发任何请求**（`onPortalOrLogin`；冒烟 `portal-auth`、`login` 钉住）。
- 页面 DOM **只读**：`document.getElementById('planCode')` 取选中项（`selectedIndex`）的 `value`、文字和 `defaultSelected`。不创建节点、不改表单、不提交、不点击。选中项为空或 `no`（占位项）时当作没有下拉框，走 GET（冒烟 `select-placeholder`）。
- 没有任何其它请求：不请求成绩、学籍、个人信息、缴费、选课接口。
- 静态扫描：`XMLHttpRequest` / `sendBeacon` / `WebSocket` / `new Image` / `eval` / `new Function` / `document.cookie` / `localStorage` 均无。

## 2. 读了什么、交出去什么

`extract.js` 交给 `parse.js` 的 JSON 字段（**白名单外的一律不带出**，包括响应里的学号、人员 ID、课程 ID、姓名、身份证号、手机号等；`pick()` 只接受字符串、数字、null，嵌套对象一律丢弃）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `fetchedDate` | 浏览器本地日期 | `YYYY-MM-DD`（`localDate`，不用 UTC），推算开学日与学期名用，写进提醒 |
| `term` | `#planCode` 选中项 | `{ text, isDefault }`：选中项的文字、它是不是服务端写了 `selected` 的那一项；没有下拉框为 `null`。学期代码（`value`）只用来拼请求 1 的体，不交出 extract.js |
| `rq` | `/indexCalendar` | 8 位数字串或 `null` |
| `skzc` | `/indexCalendar` | 数字串或 `null` |
| `slots[]` | 响应 `jcsjbs` | 每项 `jc`、`kssj`、`jssj`；非数组为 `null` |
| `courses[]` | 响应 `dateList[].selectCourseList[]` | 每项 `courseName`、`attendClassTeacher`，`timeAndPlaceList[]` 每项 `classDay`、`classSessions`、`continuingSession`、`classWeek`、`teachingBuildingName`、`classroomName` |

响应外壳（`dateList → selectCourseList`）只在 `planCourses()` 里定义一次，「有没有数据」与「挑字段」共用它。冒烟脚本往响应里塞了 `courseNumber`、`studentId`、`xh`、`xm`、`sfzh`、`sjh`、`weekDescription`、`planName`、`campusName`，输出里一个都没有出现。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **通过**。不读密码、登录表单、cookie、`localStorage`；fetch 只带 `credentials: 'same-origin'`。登录由用户在 WebView 里手工完成。 |
| 2 | 不外发 | **通过**。只有上面 2 个同源请求；没有埋点、上报、统计。 |
| 3 | 请求域可控 | **通过**。`allowHosts` 只有 `jwxs.tcu.edu.cn`（精确主机，无通配）。`authserver.tcu.edu.cn` 与 `loginUrl` 同源，无需列出，且在其上点「提取课表」只会提示、不发请求。请求落在页面自己的同源路径上，上游也只请求 `jwxs.tcu.edu.cn` 一个主机。 |
| 4 | 只读课表 | **通过**。请求 1 的 POST 与上游相同：请求体只有 `planCode`，是上游的既有查询方式；服务端有无写副作用我们无法本地确认（见第 8 节）。请求 2 是 GET。 |
| 5 | 不埋点 | **通过**。无统计、无上报、无遥测；上游的弹窗、toast、桥调用全部去掉。 |
| 6 | 不 eval 远程代码 | **通过**。无 `eval` / `new Function` / `document.write`；取回的内容只经 `JSON.parse` 和两个正则读字符串。 |
| 7 | 不写页面 | **通过**。只读 `#planCode`；不改表单、不提交、不点击。 |
| 8 | 不依赖用户输入之外的秘密 | **通过**。无硬编码学号、令牌、密钥；学期代码来自教务页面本身。 |

## 4. 与模板的差异

| 项 | aufe（模板） | tcu |
|---|---|---|
| 取数链 | 先 GET 课表页读下拉框和动态课表地址（带路径校验），再 POST | 课表接口路径固定，直接请求；没有动态地址，也就不需要路径校验 |
| 节次时间 | 单独 `POST /ajax/getSectionAndTime` | 同一份响应里的 `jcsjbs`（`jc` / `kssj` / `jssj`，`0810` 这种四位写法），上游就是这么读；**上游没有写死的节次表** |
| 总周数 | `section.zs` | `/indexCalendar` 的 `var skzc`（与 lnu 同）；上游写死 20 周，这里不照搬 |
| 响应字段 | 课名可能是 `coureName` 笔误写法、有 `campusName` | 只有 `courseName`；地点只拼「教学楼 + 教室」，没有校区名（上游同） |
| 门户页 | `all.aufe.edu.cn` / `vpn.aufe.edu.cn` | `authserver.tcu.edu.cn`；没有 WebVPN |
| 学期选择 | 页面选中项须在教务列表里，否则回落 | 直接取下拉框选中项；是否是「默认项」由 `defaultSelected` 判断，选了别的学期时 `rq` / `skzc` 不适用 |
| 其余（周次位串、两阶段同课合并、教师按 `*` 拆、连续节数缺失按 1 节、H3 补节次、提醒收口） | — | 与 aufe 相同 |

内置节次时间：**无**。节次超出教务给的 `jcsjbs` 时按「统一修订 H3」逐节补：空课默认的节次时间（`BUILTIN_PERIODS`，12 节）同一节不早于上一节下课就用它，否则从上一节下课后顺推（课间 5 分钟、每节 45 分钟），越过 23:59 就停，补了哪些都写进提醒（`slots-extend` 钉住）。教务一节都没给时，不输出节次时间，交给应用默认并提醒（`no-meta`、冒烟 `no-slots`）。

## 5. 上游里删掉 / 改掉的东西及理由

- 「学年」输入框（`showPrompt`）与「学期」单选（`showSingleSelection`）及自己拼的 `planCode`：改为读课表页下拉框选中项，没有下拉框就让教务给当前学期。不弹窗问学期；想要别的学期请先在课表页选好。
- `showAlert` 开场公告、`showToast`、`saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig` / `notifyTaskCompletion` 桥调用：导入由宿主完成，extract.js 只交数据。
- 绝对地址 `https://jwxs.tcu.edu.cn/…` 与 `credentials: "include"`：改成同源相对路径与 `same-origin`。
- 教师 `replace(/\* /g, "")`：多位教师的名字会连成一串，改为按 `*` 拆开用「、」连接。
- `endSection = classSessions + continuingSession - 1`：连续节数缺失时上游得到 `NaN`；这里按 1 节导入并计数提醒。
- `semesterTotalWeeks: 20` 写死：改为取校历 `skzc`，取不到按课表最大周次推定，并提醒。
- 上游不设开学日：这里取校历 `rq` 对齐到周一，取不到按提取日推算，都提醒核对。
- 上游每条安排各成一门课：改为先去完全重复行，再两阶段合并（首尾相接的连堂合一条、同节次周次取并集）。
- 新增 `/indexCalendar` 的只读取值（上游没有）；用来得到开学日与总周数，只取两个字符串，不交整页。
- 上游 `parseWeekString` 用 `weekStr[i]`，这里改 `charAt`；并且位串不是纯 0/1 就当读不出来，计入提醒而不是静默。

## 6. 测试

### fixtures（8 对，期望值全部先手工推演再比对，没有把输出直接存成 expected）

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 课表页默认学期（名「2026-2027学年秋」，「(当前)」标记已去掉）、教务 `jcsjbs` 12 节、开学日 20260831 取校历、总周数 20 取校历、单双周、连堂拆两行合并、同节次周次拆两行合并、完全重复行、多位教师、缺教师缺教室汇总 |
| `weeks-edge` | 零散周次集合（1-4 周 + 双周段 + 13-15 周；单周 + 单独一周，不并错单双周归属）、`classWeek` 全 0 / 含非法字符 / 缺失、星期 8、节次 0、起止节超过 20 节（`MAX_PERIOD`）都计入「读不出来」共 6 条、连续节数缺失按 1 节、没排课的课、没有课程名 |
| `term-other` | 用户选了历史学期（`isDefault` 为假）：教务的 `rq` 与 `skzc` 不适用，按提取日推算开学日（2026-09-07）与课表最大周次推定总周数（14），并提醒不是默认学期 |
| `no-meta` | 校历与节次时间都取不到、学期名只剩「(当前)」：学期名按提取日推算（1 月属于上一学年第一学期）、没有节次时间交给应用默认、`skzc` 给 35 非法按课表推定、缺教师汇总 |
| `slots-extend` | 开学日 20260901 不是周一需对齐、节次时间只到第 8 节（第 9-12 节用空课默认补、第 13-14 节顺推补、第 15 节越过 23:59 补不了）、节次时间有重复行与坏行、课表第 24 周超过教务给的 20 周需抬高总周数 |
| `clamp` | 课表有第 32 周的课，总周数压到 30 周：跨界安排截断、整条落在 30 周之后的安排与课程丢弃并提醒 |
| `long-names` | 四门约 80 字的长课名都缺连续节数、缺教师、缺教室（课名截 20 字、超过 3 门写「等 N 门」，单条提醒 ≤200 字），另有长课名的没排课课和读不出安排的课点名 |
| `no-select` | 课表页没有学期下拉框（`term` 为空）：学期名按提取日推算并提醒、校历开学日与总周数照用 |

### 浏览器冒烟（`.test/port-batch18/tcu/smoke.py all`，13/13 OK）

Playwright 起假教务站（请求全被拦下，不联网），跑真实 extract.js，再用 Rhino 跑 parse.js，检查请求方法、地址、体、顺序、个人信息不外带、载荷关键值。场景：`select-default`（下拉选中默认项 → POST `planCode=2026-2027-1-1`，顺序 课表 → 校历）、`no-select`（无下拉框 → GET）、`select-placeholder`（只有占位项 → GET）、`select-older`（选历史学期 → POST，学期名正确且标为非默认）、`home-page`（教务首页 → GET）、`portal-auth`（统一认证页 → 不发请求直接报错）、`login`（`/login` → 同上）、`ajax-html`（返回登录页 HTML → 「格式不对」）、`ajax-empty`（无 `dateList` → 「没有返回课表数据」）、`ajax-401`、`ajax-500`（报「代码 N」）、`cal-fail`（校历 404 → 照常导入、`rq` 为空）、`no-slots`（无 `jcsjbs` → 无节次时间）。

### 变异测试（7 处，在 `C:/Users/23703/AppData/Local/Temp/tcu-port18/mut/` 的副本上改；真实目录从未改动，收尾自检仍为 PASS、冒烟 13/13）

| # | 改坏哪一处 | 变红的用例 |
|---|---|---|
| 1 | `cleanTeacher`：不按 `*` 拆，直接删掉星号（多位教师连成一串，即上游写法） | fixture `basic` DIFF |
| 2 | `termIsCurrent` 恒为真（非默认学期也用教务的 `rq` / `skzc`） | fixture `term-other` DIFF |
| 3 | `mergeStageTwo`：同节次的周次不取并集，只留后一条 | fixture `basic` DIFF |
| 4 | `inferTermName`：1 月算成下一学年第一学期 | fixture `no-meta` DIFF |
| 5 | `MAX_PERIOD` 判断去掉（起止节超过 20 节也收）。**第一次这处没有变红**，说明缺用例，已在 `weeks-edge` 里补了一条 19 节起连上 3 节的安排并把「读不出来」计数 5 改为 6（手工推演：新增一条越界安排，计数加 1），补完后变红 | fixture `weeks-edge` DIFF |
| 6 | extract.js：`isDefault` 恒为真 | 冒烟 `select-older` FAIL |
| 7 | extract.js：`PORTAL_HOSTS` 清空（统一认证页不拦） | 冒烟 `portal-auth` FAIL |

## 7. 提醒清单（学生会看到的文字，均按 `docs/ux-writing.md` 写）

开学日（取自校历 / 不是周一已对齐 / 不属于所选学期已忽略 / 没有给出推算）、学期名是推算的、导入的不是默认学期、学期总周数（取自教务 / 课表更晚已抬高 / 超过 30 周已压到 30 / 与所选学期对不上 / 教务给的周数不合法 / 没有给出）、没有可用的节次时间、节次时间里有读不出来或重复的行、课表用到更晚的节次已补时间（及补不了的）、连续节数缺失按 1 节、没排课的课、读不出来的安排 / 课、没有课程名的课、周次超出 30 周的截断与丢弃、缺教师 / 缺教室汇总。带课名的提醒一律走 `shortName`（课名 ≤20 字）、点名最多 3 门、每条 ≤200 字（`warn` 收口再截一次），条数上限 20 条，真到上限时最后一条改写为「另有 N 条核对提示超出上限未显示」；正常课表通常只有 3–5 条。教师 / 地点缺失的提醒指向「编辑课程」，开学日 / 总周数 / 节次时间指向「学期管理」。

## 8. 已知风险与未验证项

1. **没有本校账号，真机没验过**。fixture 全是合成的，冒烟用的是自造的假教务站，只保证「同样输入同样输出」和请求形状，不保证真实页面上解析正确。拿到真实 dump 后应替换 `fixtures/*.extracted.json` 并核对：`#planCode` 的选项文字（是否真的带「(当前)」、选项 `value` 是不是 `2026-2027-1-1` 这种形状）、`defaultSelected` 是否真的对应服务端默认项、`dateList` / `jcsjbs` 的形状、`classWeek` 的位数、`/indexCalendar` 里 `var rq` / `var skzc` 的写法。
2. **`rq` 与 `skzc` 的含义是照同平台 lnu / aufe 的做法理解的**：本校上游没有读校历，是我们新增的。若 `rq` 其实不是开学日，学生会在第一条提醒里看到明确的日期并可在「学期管理」里改；两者都只对默认学期有效，选了别的学期时不使用。
3. **上游没有写死的节次表**，节次时间完全依赖教务的 `jcsjbs`；它的字段名（`jc` / `kssj` / `jssj`）和 `0810` 写法按上游代码理解，未实测。取不到就按应用默认显示并提醒，学生需要核对上课时间。
4. **POST 的语义**：课表请求是 POST，是上游的既有写法、体只有 `planCode`；服务端是否有写副作用我们无法本地确认。
5. **学期选择的限制**：不弹窗问学期。想导入非默认学期，要先在教务系统的课表页（学期下拉框）里选好再提取；提醒里已说明。课表页以外的页面（如首页）没有下拉框，会 GET 教务的当前学期。
6. **同一学期的 `planCode` 若由多条计划组成**，上游只请求一个 `planCode`；这里同样只请求选中的一个，其它计划的课不会出现。
7. **连续节数缺失按 1 节**是保守推算（上游在这种情况下得到无效节次），已计数提醒，学生需要核对。
8. **地点不做去重**：上游「教学楼 + 教室」直接拼；若教务的教室名本身已带楼名，会出现重复的楼名（不影响使用，学生可在「编辑课程」里改）。
9. **不处理 WebVPN**：上游没有 WebVPN 入口，本校 `allowHosts` 只有教务直连主机；校外访问若走学校的 VPN 改写主机，请求会被宿主拦住，需要补主机。
10. **`scheduleUrlHint`** 填的是 `https://jwxs.tcu.edu.cn/student/courseSelect/thisSemesterCurriculum/index`，来自任务卡与同平台路径惯例，未在真机上确认这个页面就是「本学期课表」。

签名：0x7E7-2023（sonnet 移植，2026-10-26；收尾核对 2026-10-27）
