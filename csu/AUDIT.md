# 中南大学（csu）移植审计

本文件记录移植件的来源、请求与读写面、安全八条结论、节次时间、fixtures、变异测试、浏览器冒烟与未验证项。每条声明对应当前代码，按函数名引用，不用行号。

## 1. 来源

- 上游仓库：https://github.com/XingHeYuZhuan/shiguang_warehouse （MIT）
- 上游文件：resources/CSU/csu.js（作者 / maintainer GaLeKu）与同目录 adapters.yaml（唯一条目 CSU_01「中南大学（强智教务）」，
  import_url = https://ca.csu.edu.cn/authserver/login?service=http%3A%2F%2Fcsujwc.its.csu.edu.cn%2Fsso.jsp ，原样作为 loginUrl）。
- 本机快照 e15c627（2026-10-26 拉取），本校脚本最后一次修改 a7b9cdf（2026-10-22 新增），与任务卡一致；快照没有修改。
- 平台：强智科技「高校综合管理教务系统」学生端 /jsxsd/（老界面：table#kbtable + div.kbcontent + font[title]）。教务是 http；
  中南按学号把请求分摊到多台 *.its.csu.edu.cn 服务器，上游以当前页面所在主机为准（location.origin），这里照做。
- 模板：hnptc（同平台、同样的教学周历 + 网格还原）；中南自己的不同构之处见 §2。
- 移植者：0x7E7-2023（sonnet 移植，2026-10-26）。

## 2. 与模板（hnptc）及上游的不同构之处

1. 课表格里只读精确类名 div.kbcontent。kbcontent1 是隐藏的旧数据且带着同样完整的拼课数据，读了每门课翻倍（上游「四个坑」之③）。
   hnptc 要读简表 + 详表两份并按分数择优，这里整段不要（parse.js 头注释 ⑩）。
2. 表头列序是「星期日、星期一…星期六」，星期日排在最前（坑①）：星期按表头文字对齐网格列（findHeaderRow / dayColOf），不按位置；认不出任何星期名直接报错。
3. 行首节次标签是全角连字符「1－2」，连排写成「1－2,3－4」取全部数字的首尾（坑②）：extract.js 只在 th 里读数字交出（labelOf），parse.js 的 rowSectionsOf 取首尾。
4. 页面里有两个 id=kbtable（课程表 / 页脚周次表，坑④）：findScheduleTable 按「第一行含星期」挑。
5. 周次在 font[title=周次(节次)] 里，形如「1-16(周)[01-02节]」：方括号里是节次，周次取方括号之外（splitSpec）。同格拼课（5 个以上减号分隔）共用本格节次、靠周次区分。
6. 节次只认行首表头，本行认不出时才读周次方括号里的节次（hnptc 同）。
7. 开学日：取周历里「第一格是周号」的行中第一个带日期的格子（calendarFirstDate，上游取第一行；这里连周号一起取）。
   周号 N 大于 1（第 1 周整行没有日期）：按 (N-1) x 7 天倒推回第 1 周并提醒核对；整份周历没有任何带周号的行：取第一个日期并提醒「认不出周次、不一定是第 1 周」。
   倒推后的日期是星期日就每周从星期日起算（上游 firstDayOfWeek=7），开学日取该星期日本身并提醒；是星期一直接用；其它星期几对齐到所在周的周一并提醒；
   周历取不到按提取日期推算最近的周一并提醒（上游是整个导入失败）。
8. 学期：当前页在 /jsxsd/xskb/ 或 /jsxsd/jxzl/ 下读本页 select#xnxq01id 的选中项，否则 GET 教学周历页读默认选中项。
   上游弹窗让用户选学期（默认项即页面选中项），这里不弹窗；用户想导别的学期，就在教务页面把学期切过去再点提取。
9. 节次时间是校历「上课时间」写死的 10 节（上游同样），每次导入都出一条提醒请学生核对。

## 3. 请求清单（与代码一致）

全部请求落在当前页面同源（jwBase：主机名必须以 .its.csu.edu.cn 结尾，协议与端口跟着页面），credentials 为 same-origin，只有 fetch 一处出口（requestText）。

| 方法 | 路径 | 请求体 | 用途 | 对应上游 |
|---|---|---|---|---|
| GET | /jsxsd/jxzl/jxzl_query | 无 | 只在当前页不是课表页 / 周历页时发一次，读学年学期下拉框的默认选中项（fetchDefaultTerm） | requestSemesterPage |
| POST | /jsxsd/xskb/xskb_list.do | cj0701id=&zc=&demo=&xnxq01id=学期 | 整学期课表（服务端渲染网页；fetchSchedule） | requestCoursePage（一字不差） |
| POST | /jsxsd/jxzl/jxzl_query | xnxq01id=学期 | 教学周历：第 1 周日期与周数（fetchCalendar）；失败 / 没表格不致命 | requestSemesterDetailPage |

登录页 / 统一认证页（ca.csu.edu.cn）/ 其它网站上点提取：不发任何请求，直接给大白话提示（NOT_JW）；教务主机上的页面带密码框同样不发请求（ON_LOGIN）。
状态码：401 / 403 与其它非 2xx 分开说（「教务系统拒绝访问 / 返回错误（代码 N）」）；返回页里没有课程格且有密码框时说「登录状态已失效」。

## 4. 读了什么、交出去什么

- 交出的 JSON：now（本地日期）、term{code, name}、cols、calendar{found, rows}、rows。全是字段白名单。
- 课程格：safeHtmlOf 只保留课程名文字节点、br、标题含「周次 / 节次 / 教师 / 老师 / 教室 / 地点 / 单双」的 font 里看得见的文字；
  看不见的元素（hidden、aria-hidden、display:none、visibility:hidden）、span / a / img / input / script 等其它标签连文字一律不读。每段文字 ≤100 字。
- 没有课程明细的格子只交 labelOf 认得的标签（星期、行首节次数字、周号 / 日号 / 日期）；周历格子只交 title 里的日期段与周号 / 日号，其它备注不带出。
- 学期名 ≤40 字。页面里的姓名 / 学号 / 身份证 / 手机号（冒烟里埋了 SECRETS）都不会出现在输出里。

## 5. allowHosts

manifest 为 ["csujwc.its.csu.edu.cn"]（主调度定），无通配。loginUrl 的 ca.csu.edu.cn 与其同源，不必再写。
风险：中南按学号把请求分摊到多台 *.its.csu.edu.cn 服务器，脚本以当前页面主机为准；若某位学生被分到 csujwc 以外的主机，宿主按白名单会不会放行请求取决于宿主实现，
这一点没法在离线环境验证，已在报告里交给主调度决定（见 §12）。

## 6. 手册 §5 安全八条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | 不读 password 值、cookie、localStorage、sessionStorage；check.js 对「password」字样的提示来源是 hasPasswordInput，只读 input.type。 |
| 2 | 不外发 | 通过 | 只有 requestText 一处 fetch，三种请求都是当前页面同源（jwBase 校验后缀）；无 XHR / sendBeacon / WebSocket。 |
| 3 | 请求域可控 | 通过 | allowHosts 无通配；请求只落在当前教务主机。 |
| 4 | 只读课表 | 通过 | 只请求课表与教学周历；不碰成绩、学籍、缴费、个人信息。 |
| 5 | 不埋点 | 通过 | 无统计、上报、遥测。 |
| 6 | 不 eval | 通过 | 两个文件都没有 eval / new Function；check.js 词法扫描 PASS。 |
| 7 | 不写页面 | 通过 | 只读遍历；解析用 DOMParser 离线文档；无 innerHTML 赋值、appendChild、表单提交、点击。 |
| 8 | 不依赖秘密 | 通过 | 无硬编码密钥 / 令牌 / 学号；学期代码来自页面下拉框。 |

## 7. 节次时间（逐节，来自上游 TIME_SLOTS；parse.js 的 SLOT_TIMES）

| 节 | 时间 | 节 | 时间 |
|---|---|---|---|
| 1 | 08:00-08:45 | 6 | 14:55-15:40 |
| 2 | 08:55-09:40 | 7 | 16:00-16:45 |
| 3 | 10:00-10:45 | 8 | 16:55-17:40 |
| 4 | 10:55-11:40 | 9 | 19:00-19:45 |
| 5 | 14:00-14:45 | 10 | 19:55-20:40 |

上游注释：2024-2025 起三学年一致；第九节前 17:40-19:00 为晚餐不排课，所以连排并课不跨过第 4/5 节（午饭）和第 8/9 节（晚饭）（NO_MERGE_AFTER）。
课表用到第 11 节起：按统一修订 H3 在上一节下课后课间 5 分钟、每节 45 分钟顺推（11：20:45-21:30，12：21:35-22:20，13：22:25-23:10），第 14 节会越过 23:59 不补，均写进提醒。

## 8. 上游里被删掉或改掉的东西

- 删：showAlert / showSingleSelection / showToast / saveCourseConfig / savePresetTimeSlots / saveImportedCourses / notifyTaskCompletion（拾光界面调用）、
  Node 测试导出、window.runImportFlow 入口。
- 改：学期不弹窗选（§2.8）；上游 parseWeeks 对整串只判一次单双、「(单)1-8周,(双)9-16周」按「不过滤」处理 —— 这里逐段判；
  上游静默丢掉的块（无课名 / 无周次）全部计数并点名；缺教师 / 教室留 null 并汇总提醒；读不到开学日期上游直接退出，这里推算并提醒；
  上游返回的整条课表对象在这里按白名单重新拼，不转交 innerHTML。
- 没有删掉任何会让导入失效的东西；上游无凭据、无外发、无埋点。

## 9. fixtures（12 对，全部为合成数据；期望值按上游规则与规范独立推演）

basic（星期日有课 dayOfWeek 7、拼课、两段周次并成 1-16、单双周、教师职称去掉、周历 18 周 / 开学日 2026-09-07）、weeks-forms（各种周次写法逐段判单双）、
weeks-notes（备注 / 教学班序号 / 超过 30 周丢弃 / 单双认不出 / 周历 20 周而课表到第 30 周）、week-sunday（周历第 1 周星期日有日期）、
cal-none（周历取不到：按提取日期周一推算 + 总周数取课表最晚周）、cal-offday（周历首个日期是星期三：对齐周一）、long-names（长课名汇总、限长 200 字）、
messy（无课名 / 无周次 / 周次认不出 / 认不出节次 / 超 20 节分别计数；方括号节次兜底）、period-overflow（第 11-14 节顺推与越界）、
merge（午饭 / 晚饭不并、连排并、拼课重复只留一条、同名不同教师）、
cal-week1-empty（第 1 周行空、第 2 周行 2026-09-14：倒推 7 天到 2026-09-07 + 提醒）、cal-no-weekno（周历无周号：取首个日期 2026-09-07 + 提醒，总周数取课表最晚第 16 周）。中南专属边界：basic / week-sunday（星期日排最前）、merge（NO_MERGE_AFTER）、period-overflow。
抽查（收尾时逐项手算）：basic 的 10 节时间与上游一致、总周数 18、开学日 2026-09-07、缺教师提醒；cal-none 的 2026-09-16（星期三）→ 周一 2026-09-14；
cal-offday 的 2026-09-09（星期三）→ 2026-09-07；period-overflow 的 20:45-21:30 / 21:35-22:20 / 22:25-23:10，第 14 节 23:15-24:00 越过 23:59 不补。均与期望一致。

## 10. 浏览器冒烟（.test/port-batch17/csu/smoke.py，Playwright 假教务站，不联网，11/11 OK）

csu-kb（课表页，学期取页面选中项，只发 2 个 POST，无 GET，kbcontent1 不翻倍，星期日课 = 7）、csu-other-server（页面在 csujwc2 上，请求跟着走）、
csu-home（教务首页：先 GET 周历页读默认学期再 POST）、csu-jxzl-page（周历页）、csu-cal-500 / csu-cal-empty（周历取不到：回落推算并提醒）、
csu-auth（统一认证页不发请求）、csu-portal（其它网站不发请求）、csu-password-page（教务主机上的登录页不发请求）、
csu-expired（回登录页 → 「登录状态已失效」）、csu-no-course（返回页无课程格 → 报错）。每个场景都断言请求体、个人信息（学号 / 身份证 / 手机号 / 姓名 / 隐藏元素里的秘密）不进请求也不进输出。

## 11. 变异测试（.test/port-batch17/csu/mutate.js：改临时副本，不动正式文件，已确认正式文件仍 PASS）

9 处全部变红：
1. NO_MERGE_AFTER 清空 → merge 变红。
2. 第 3 节开始时间 10:00 改 10:05 → basic / weeks-forms / weeks-notes 等变红。
3. 周历星期日起算判断失效 → week-sunday 变红。
4. 拼课分隔线 5 个减号改 50 个 → basic 变红。
5. 教师职称方括号不去掉 → basic 变红。
6. 总周数不取课表最晚周次 → weeks-notes / cal-offday 变红。
7. 顺推节次时间不限 23:59 → period-overflow 变红。
8. 去掉按周号倒推开学日 → cal-week1-empty 变红。
9. 无周号的周历不再提醒 → cal-no-weekno 变红。

## 12. 已知风险与未验证项

- 多服务器与 allowHosts（§5）：未能离线验证宿主对 csujwc2 之类其它主机的处理。
- 没有真实教务账号，真实页面细节（font 标题的精确写法、周历结构）以上游脚本为准，未在线核对。
- 周历第 1 周每周从星期日起算时，开学日取星期日本身；应用端怎么处理「周从星期日起」按统一规范，这里只保证提醒与日期正确。
- 节次时间写死，学校改了作息需要更新适配器。

## 13. 签名

移植：0x7E7-2023（sonnet 移植，2026-10-26）。上游作者 GaLeKu（MIT）保留在 extract.js / parse.js 文件头与 manifest.author。
