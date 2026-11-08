# 安全审计 —— 山东药品食品职业学院（移动端逐周 JSON 课表）

审计对象：`jw-adapters/sddfvc/`。上游为 `shiguang_warehouse/resources/SDDFVC/sddfvc.js`，MIT，作者「星河欲转」；快照 `29498b026708ecb8d837c8fdc1e53b768a394e4e`，`git log -1` 实测本校脚本最后修改为 `14cb2ca`。同目录 `adapters.yaml` 的入口是 CAS，登录服务指向 `fazhan.sddfvc.edu.cn/js/fzzx/login`。

## 1. 模板判断与不同构分析

任务卡建议 `wzzy`（相似度 0.366），并提示 `yssdufe/xjie`。通读三者后确认：`wzzy` 是青果 GBK 整页表格，`yssdufe/xjie` 是强智 `/jsxsd/` HTML 表格；本校则是 `mobile/student` 下的三个 JSON 地址、按周遍历、`xq1..xq7 → 槽位 → 排课项 → pkmx` 嵌套结构。因此取数、课名、周次和节次映射均按本校上游重写，不复用它们的页面选择器或文字周次解析。只从 `wzzy` 借用通用做法：显式周次切极大段、按周矩阵吸收重复/连堂、缺教师教室汇总、提醒统一限长。

上游的六档节次时间逐节照抄：1=08:30-10:00，2=10:15-11:45，3=13:30-15:00，4=15:15-16:45，5=19:00-19:30，6=20:00-20:45。这里的「节」是上游 `sectionMap` 的大节，槽位 `1/3/5/7/9/11` 分别映射第 1～6 节；不是把原始槽号直接当空课节次。上游不存在第七个合法槽位，故没有可到达的表外节次；未知槽位跳过并提醒，不猜时间。

## 2. 请求清单（与 extract.js 一致）

| 函数 | 方法 | 地址 | 用途 | 取不到时 |
|---|---|---|---|---|
| 主流程 | GET | `<当前教务 origin>/mobile/student/mobile_kcb_xq?api_token=<令牌>` | 读 `data.xq_current`，自动选当前学期；`xq_all` 仅用于补学期名 | 非 2xx、非 JSON、无当前学期均明确报错，不回落到别的学期 |
| 主流程 | GET | `<当前教务 origin>/mobile/student/mobile_kcb_weeks?xq=<学期>&api_token=<令牌>` | 读 `data.week_list` 的周号与 `start_date` | 非 2xx、非 JSON、空列表均明确报错 |
| `fetchWeek` | GET | `<当前教务 origin>/mobile/student/mobile_kcb?api_token=<令牌>&xq=<学期>&week=<周号>` | 逐周读课表，按周历顺序串行请求 | 单周失败记入 `failedWeeks`，继续其他周；全部失败明确报错 |

所有请求均为 GET、`credentials:'include'`，无请求体、无自定义请求头。`api_token` 只从当前教务页查询串读出并拼入上述同源课表地址；不交出、不写提醒、不写存储。当前主机必须精确等于 `jwxt.sddfvc.edu.cn`，且路径不含 `/login`，否则零请求；CAS 和 `fazhan` 门户均直接提示先进入教务课表页。缺少 `api_token` 同样零请求。

`manifest.allowHosts` 只有 `jwxt.sddfvc.edu.cn`。CAS 主机由 `loginUrl` 自动进入宿主白名单，不重复写入；`fazhan` 只是登录回跳门户，脚本不向它发课表请求，故不放行；无任何通配。`scheduleUrlHint` 使用上游唯一给出的课表地址 `https://jwxt.sddfvc.edu.cn/mobile/student/mobile_kcb`，但实际访问仍需当前令牌，真机可用性未验证。

## 3. 解析与上游差异

1. **学期**：上游弹窗让用户选，移植件直接用 `xq_current`，不弹窗，也不按日期猜学期。
2. **逐周去重**：上游合并前会把每周重复响应累积，移植件先按 `[星期,槽位,原始课名,周次,单双标记,教师,教室]` 完整内容去重，再解析和计数，避免重复课与放大的提醒。
3. **课名**：保留上游 `extractCourseName` 的第一个 `#` 规则：只有左侧含「班」则取右侧，只有右侧含「班」则取左侧；两侧同含、同不含或无 `#` 保留原文，多个 `#` 时右侧其余部分仍保留 `#`。空课名不再写成「未知课程」，而是跳过并计数。
4. **周次**：接受上游的逗号分隔数字与区间；`dsz=1` 只留奇周、`dsz=2` 只留偶周，其他值全周。非法、逆序、空周次和超出 1～30 的部分分别计数提醒；不再静默丢课。排序去重后按步长 1/2 切为 ALL/ODD/EVEN 极大段。
5. **节次与合并**：六槽位按上游映射；同课名、教师、教室、星期形成按周节次矩阵，吸收完全重复、相邻和重叠槽位，再把相同节次段的周次归并。课程按课名+教师归档，换教室是同一课程的另一块，同名不同教师不合并。
6. **周历与开学日**：总周数取周历里的真实末周号与周历日期跨度的较大值（列表长度不算数，缺号也不缩短校历），课表更晚才抬高，超过 30 周收口；无可用周历时回落 20 周并提醒。第 1 周 `start_date` 配合学年名推年份：第一学期用起始自然年、其中 1～6 月的周次属下一年，第二学期整体用结束自然年且不再按月份回年（复审发现的 `month >= 7 → year--` 已删除，7 月的周次仍属第二学期）；回退到周一。没有第 1 周时按首条周号倒推 `(N-1)*7` 天；日期缺失时第一学期按 9 月 1 日、第二学期按 2 月 20 日所在周周一推算。每种推算均提醒。这两条月份调整是移植件自加，上游没有。
7. **失败与字段**：单周失败、未知星期、未知槽位、坏周次、空课名、`pkmx` 为空的排课项均出声；失败周超过 10 个时列出前 10 个并补「等共 N 周」；空明细项按 `[星期,槽位,原始课名]` 去重后计入未导入汇总，是唯一会整条消失的形状，不再静默。教师只取上游所用的 `teacher[0].xm`，教室取 `classroom`，「未知/待定/暂无」等占位转成 `null`，缺失课程照导入并汇总提醒。
8. **提醒**：课名和学期名在提醒中截到 20 字，所有提醒统一经过 `warn()`，最多 20 条、每条最多 200 字；教师教室指向「编辑课程」，开学日和总周数指向「学期管理」。
9. **上游桥调用**：`showSingleSelection`、`showToast`、`saveCourseConfig`、`savePresetTimeSlots`、`saveImportedCourses`、`notifyTaskCompletion` 全部删除；空课宿主根据返回载荷保存。

## 4. 读取面与交出字段

`extract.js` 只读当前地址的主机、路径和 `api_token`，以及三个课表响应。输出顶层键严格为 `term/calendar/responses/failedWeeks`：

- `term`：`{id,name}`，仅当前学期标识和名称。
- `calendar`：每项 `{id,startDate}`，仅周号和 `MM/DD` 日期。
- `responses`：每项 `{week,entries}`；entry 仅 `{day,slot,rawName,details}`；detail 仅 `{weeks,parity,teacher,location}`。`rawName` 来自 `pkbmc`，`teacher` 仅 `teacher[0].xm`，`location` 仅 `classroom`，周次仅 `zc.zc/zc.dsz`。`pkmx` 缺失或为空时仍交出 `details:[]` 的 entry，让 `parse.js` 计数提醒，而不是在取数阶段丢格。
- `failedWeeks`：失败周号字符串。

不交出 `xq_all` 列表、其他教师及其字段、学生姓名、学号、人员 ID、证件号、手机号、属性或整份响应。教师姓名是课表展示必需内容；`pkbmc` 可能含教学班名，是上游课名判断必需内容。字段文字均限长。`parse.js` 不访问网络、页面、存储或宿主桥。

## 5. 移植手册 §5 八条

| # | 结论 |
|---|---|
| 1 不碰凭据 | 通过。不读账号、密码、表单、Cookie 或本地存储；课表令牌仅用于本校同源 GET，不交出。 |
| 2 不外发 | 通过。只有第 2 节三类教务地址，无第三方、信标、图片、WebSocket 或遥测。 |
| 3 请求域可控 | 通过。仅精确教务主机进 `allowHosts`；CAS 由入口自动放行，门户不放行；非教务页零请求。 |
| 4 只读课表 | 通过。学期、周历均服务于课表；不读成绩、学籍、缴费或个人信息接口。 |
| 5 不埋点 | 通过。无统计、上报、日志外发。 |
| 6 不动态执行远程代码 | 通过。无 `eval` 或动态函数构造；JSON 只作为数据解析。 |
| 7 不写页面 | 通过。不改 DOM、不提交表单、不点击、不写存储。 |
| 8 不依赖秘密 | 通过。无固定令牌、密钥、学号；令牌来自用户当前已登录课表页。 |

## 6. 合成 fixtures（期望值独立手推）

11 对均为合成数据，不是实际抓取：`basic` 覆盖六槽位、单双周、分段周次与连堂；`course-names` 覆盖课名所有分支；`merge-dedup` 覆盖逐周去重、重复槽位、错位、换教室及非周一回退；`second-calendar` 覆盖第二学期和缺第 1 周倒推；`calendar-gap` 覆盖周号缺 2-6 与 5 时总周数取真实末周号 7 而非列表长度；`fallback-raised` 覆盖开学日推算、总周数抬高和两个失败周；`week-edges` 覆盖离散周、单双过滤、逆序及越界；`messy-long` 覆盖长课名提醒、未知槽位、坏周次、空课名、异常星期、占位和缺失教师教室；`second-july` 钉第二学期 7 月周次不回年、只有日期没有周号的周次按日期跨度把总周数抬到 23；`failed-many` 钉 12 个失败周只列前 10 个并补「等共 12 周」；`empty-details` 钉三周重复出现的空明细格子只计两次并入未导入汇总。

## 7. 变异测试与浏览器验证

变异副本只放 `C:/Users/23703/AppData/Local/Temp/sddfvc-port30/`，正式目录不直接改坏。`.test/port-batch30/sddfvc/mutate.py` 实测 **8/8** 被捕获：课名左侧班级判断改反（`basic/course-names` DIFF）、第二槽位映射改错（6 对 DIFF）、去掉奇周过滤（`basic/week-edges` DIFF）、学年起始年不加一（`second-calendar/second-july` DIFF）、取消按周号倒推（`second-calendar/calendar-gap` DIFF，目标串已随 :315 改成 `firstWeekNumber`，复审记录的旧串已失效）、恢复第二学期 7 月回年（`second-july` DIFF）、失败周总数不补（`failed-many` DIFF）、空明细不计数不提醒（`empty-details` DIFF）。变异副本已删除，正式目录复跑 11 对全部 MATCH，`RESULT: PASS`。

本地 Playwright 假站冒烟 `.test/port-batch30/sddfvc/smoke.py all` 于 2026-11-08 复跑实测 **14/14 OK**（本机随带 Chromium 已缺失，以 `NC_PW_CHANNEL=msedge` 复用系统 Edge；不设该变量时行为不变）：`normal`、`second-calendar`、`week-partial-fail` 均把 extract 输出交给 Rhino 实跑 parse 并核对课程、连堂、六节时间、开学日和失败周提醒；`all-weeks-fail`、`term-500`、`weeks-500`、`term-missing-current`、`weeks-empty`、`term-bad-json` 验证请求数和明确报错；`cas-zero`、`portal-zero`、`login-path-zero`、`missing-token-zero`、`wrong-host-zero` 全部零请求。假响应埋入的学生姓名、学号、人员编号、证件号、手机号、额外字段和第二教师均未出现在 extract 输出，访问令牌也未交出；输出逐层键集合断言通过，三条上游路径、GET 方法、空请求体与查询参数均通过。

## 8. 已知风险与未验证项

- 没有本校账号和真实响应；嵌套键名、当前学期形状、`start_date` 格式、槽位含义均来自上游代码反推。合成 fixture 和假站不能证明真实教务兼容。
- `scheduleUrlHint` 不带令牌；学校若必须从门户动态签发令牌，一键刷新仍需用户重新经门户进入。真机未验证。
- 总周数取真实末周号与周历日期跨度的较大值；若周历里混入短学期或附加周的日期，跨度可能偏大，此时会明确提醒「按周历日期跨度计算」，课表更晚的周只会抬高，不会擅自缩短。
- 上游只使用第一位教师，其他教师被有意忽略；若真实课表把多位教师都放在数组里，会缺后续教师。
- 未知槽位、无法识别周次会跳过并提醒，不猜课程；全部记录不可读时明确报错，避免空学期覆盖本地课表。
- 仅做本地浏览器与 Rhino 验证，未做 Android 真机抽验；按任务约束未运行 Gradle、未联网。

## 9. 签名

0x7E7-2023（haiku 移植，2026-11-03）
