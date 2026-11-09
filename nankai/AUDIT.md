# 安全审计：`nankai`（南开大学（研究生）· 研究生教育综合管理系统）

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) `NANKAI/nankai.js`（MIT，上游作者 **Cure**，见同目录 `adapters.yaml` 的 `maintainer`），快照 `baf83fa`，本校脚本最后一次修改 `2e1e720` |
| 上游入口 | `adapters.yaml` 的 `import_url` = `https://yjs.nankai.edu.cn/py/page/student/grkcb.htm` |
| 平台 | JSP 服务端渲染的研究生培养管理系统，**没有 JSON 接口**：课表按「周次」逐周渲染成 HTML 表格（容器 `table.table-course`），同一门课只在它真正上课的那一周出现；页面上有学年 `#xn` / 学期 `#xj` / 周次 `#zc` 三个下拉框，页面正文底部还有节次时间说明 |
| 模板 | `jw-adapters/upc-grad`（研究生件，借骨架：目录结构、manifest 形态、parse.js 的纯函数写法）。库里没有同平台件：本件是「一次页面读学期/作息 + 逐周抓页面 + 网格还原」，提取与合并按上游 `nankai.js` 重写，只沿用 `upc-grad` 的「extract 只交结构、解释全在 parse」这一分层 |
| 移植者 | 0x7E7-2023（haiku 移植，2026-11-09） |
| 结论 | **通过**：不碰凭据、不外发、只读个人课表页、无第三方域、无埋点、不写页面。逐条留证见下 |

## 1. 脚本请求了哪些域 / 请求清单

两段脚本里唯一的网络调用是 `extract.js:311` 的 `fetch`，目标全部是**当前页面同源**的相对路径 `/py/page/student/grkcb.htm`（`extract.js:28` 的 `PAGE_PATH`）。`extract.js` 先判主机名必须是 `yjs.nankai.edu.cn`（`extract.js:27` 的 `HOST`，`extract.js:407` 起），所以相对路径一定落在这个主机上；代码里没有任何绝对 URL 参与请求。

| # | 方法 | 地址 | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| 1 | GET | `/py/page/student/grkcb.htm`（不带参数） | 读学年 `#xn` / 学期 `#xj` / 周次 `#zc` 三个下拉框（选中项 = 学校当前学期）与页面正文里的节次时间 | 非 2xx / 网络错误 → 报错「教务系统返回错误（代码 N）」/「连不上教务系统」；页面上有密码框 → 报「当前页面是登录页」；三个下拉框缺任一 → 报「未获取到课表数据」（`extract.js:347` `loadTermPage`） |
| 2 | GET | `/py/page/student/grkcb.htm?xn=<学年>&xj=<学期>&zc=<周次>` | 逐个周次抓这一周的课表页，收集课表格子里的课程链接 | 单周失败记进 `failedWeeks`，由 `parse.js` 汇总成提醒；**所有周都失败**才报错（`extract.js:394` `crawlWeek`、`extract.js:418` 起的汇总） |

并发 3（`extract.js:29`，与上游同值）。参数 `xn` / `xj` 原样取自下拉框的值，`zc` 是纯数字周次，全部 `encodeURIComponent` / 数字拼接，没有把外部地址塞进 URL。

## 2. manifest 取值

- **`loginUrl` = `https://yjs.nankai.edu.cn/py/page/student/grkcb.htm`**——上游 `adapters.yaml` 的 `import_url`，就是用户登录后要打开的「个人课表」页。
- **`scheduleUrlHint` = 同一地址**——一键刷新时优先打开这一页（任务卡指定；`scheduleUrlHint` 必须是课表页的完整地址，不能写成一句话）。
- **`allowHosts` = `["yjs.nankai.edu.cn"]`**：脚本只请求同源课表页；声明这一台主机是审计清单里的请求目标，也保证桥注入到这一页。没有通配。
- **`minAppVersionCode` = 11**：只用了 `warnings`，没有用新版本才有的载荷种类。

## 3. 有没有绕过白名单的写法——逐类点名

| 写法 | 有没有 |
|---|---|
| 把目标地址塞进 URL 参数 | **没有**。参数只有 `xn` / `xj`（下拉框的选项值）和 `zc`（数字），都不是地址。 |
| 非同源 iframe / `<img>` / `<script>` 拉取 | **没有**。不创建元素、不 `appendChild`；取回的 HTML 只交给 `DOMParser`（惰性文档，不执行脚本、不加载子资源）。 |
| 重定向把数据带走 | **没有**。不赋值 `location`、不导航、不开窗。 |
| `mode:'no-cors'` / 跨域带凭据 | **没有**。`fetch` 是相对路径 + `credentials: 'same-origin'`。 |
| 把主机名拼出来（域名分片、base64 拼串） | **没有**。参与请求的只有路径前缀常量。 |
| WebSocket / EventSource / Service Worker | **没有**。 |
| `sendBeacon` / 隐藏表单提交 | **没有**。 |

## 4. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **通过**。不读登录表单值、不读 `localStorage` / `sessionStorage` / `document.cookie`。`hasPasswordInput`（`extract.js:297`）只判断页面上**有没有**密码输入框（用来识别登录页），不读它的值。`fetch` 只带同源 cookie（`credentials: 'same-origin'`），不读取、不转发 cookie 内容。 |
| 2 | 不外发 | **通过**。除课表页这一个同源路径外没有任何网络调用；结果只通过 `return` 交给宿主。 |
| 3 | 请求域可控 | **通过**。唯一主机 `yjs.nankai.edu.cn`，先去 `location.hostname` 核对（`extract.js:406`），再发相对路径请求。 |
| 4 | 只读课表 | **通过**。只请求并解析「个人课表」页（课表表格、学年/学期/周次下拉框、正文里的节次时间）；不请求成绩、学籍、缴费、个人信息页面。 |
| 5 | 不埋点 | **通过**。无统计、无上报、无 `console` 调试输出。 |
| 6 | 不 eval 远程代码 | **通过**。无 `eval` / `new Function`；取回的 HTML 只经 `DOMParser`，`parse.js` 只经 `JSON.parse`。 |
| 7 | 不写页面 | **通过**。两段脚本对页面只读：不 `createElement` / `appendChild` / `innerHTML=` / `document.write` / `submit` / 改表单值。 |
| 8 | 不依赖用户输入之外的秘密 | **通过**。无硬编码密钥 / 固定令牌 / 他人学号；学年学期与周次都来自教务页面。 |

## 5. 读取面（`extract.js` 到底读了什么）

| # | 读什么 | 代码位置 | 取出的值 | 去处 |
|---|---|---|---|---|
| 1 | 不带参数课表页的 `select#xn` / `#xj` / `#zc` 的选项与选中项 | `readOptions` / `selectedValue` / `labelOf`（`extract.js:202`–`extract.js:233`） | 学年、学期的代码与显示文字（各截 40 字），周次数值（1~30） | 载荷 `term{xn,xj,xnLabel,xjLabel,source}`、`weeks[]`、`skippedWeeks` |
| 2 | 同一页面的 `document.body.textContent`，只用于匹配「第X节 H:MM-H:MM」 | `parseTimeSlots`（`extract.js:265`） | 只交匹配到的 `{number,start,end}`（要求从第 1 节起连续、结束晚于开始，否则整张不交） | 载荷 `timeSlots`；页面正文本身**不带出** |
| 3 | 每一周的课表页：`table.table-course`（或同时含「星期一」与「第 N 节」的表）展开成二维网格（正确处理 rowspan / colspan），表头行认「星期X」→ 列 | `buildGrid` / `findDayColumns` / `findTimetable`（`extract.js:103`–`extract.js:165`） | 每个星期的列号与课程链接 | 只用于定位，不进载荷 |
| 4 | 课表格子里每个含「第 N 节」的 `<a>` 的**可见文字行**（`<br>` 当换行，每行 ≤60 字、最多 8 行）+ `<strong>` 里的课名 + 所在星期 | `parseWeekDoc` / `linesOf` / `visibleText`（`extract.js:91`–`extract.js:101`、`extract.js:167`） | `{week, day, name, lines[]}` | 载荷 `courses[]`，解释全在 `parse.js` |
| 5 | 当前页面有没有密码输入框 | `hasPasswordInput`（`extract.js:297`） | 布尔值 | 只用来在登录页直接报错，不发请求 |

**不读的东西**：登录表单的任何输入值、`localStorage` / `sessionStorage` / `cookie`、课表格子里的浮窗 / 悬浮详情 / 隐藏元素。`visibleText`（`extract.js:74`）遇到 `hidden` 属性、`aria-hidden="true"`、行内 `display:none` / `visibility:hidden` 的元素**连里面的文字都不读**；只读课程链接 `<a>` 自己的内容，格子里的其它节点（包括藏着姓名学号的浮窗）不读。页面正文虽然整体过了 `textContent`，但只有「第X节 H:MM-H:MM」这种片段会被交出去，正文原文不出脚本。

交出去的整个对象只有 7 个键：`now`、`term{xn,xj,xnLabel,xjLabel,source}`、`weeks`、`skippedWeeks`、`failedWeeks`、`timeSlots`、`courses[]{week,day,name,lines}`（`extract.js:437` 起）。没有学号、姓名、身份证号、手机号、人员 ID 之类的字段。

`parse.js` 不读页面、不联网：输入是 `extract.js` 交出来的 JSON 字符串（`__ncInput`，`parse.js:280`），是纯函数（CI 用 Rhino 真跑）。

## 6. 移植时删掉 / 改了的上游行为

- **弹窗全删**：上游的「确认导入信息」`showAlert`、`showToast`、`notifyTaskCompletion`、`saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig` 全部删掉。学年学期直接用教务页面的默认选中项（任务卡要求不弹窗），确认信息（学期名、开学日期是推算的）写进 `warnings`。
- **取数分层**：上游把「抓 DOM → 解析课程链接 → 合并去重」全写在浏览器里跑的那一段；移植后 `extract.js` 只交「第几周、星期几、链接里的可见文字行」，课名 / 节次 / 教师 / 地点的解释、跨周合并、连续节次合并、去重全搬进 `parse.js`——CI 能真跑到。
- **教师 / 地点默认值从 `"待定"` 改成 `null`**：上游 `parseCourseAnchor` 没有地点时写死 `'待定'`；移植手册 §4.7 要求拿不到就留空（占位词会被当成真名字显示），这里统一 `null`，「待定」「未知」「暂无」也按没有处理（`isPlaceholder`，`parse.js:80`）。
- **总周数改用教务页面的周次列表**：上游用「课表里出现的最大周」当学期长度（`courses.reduce(max)`）。移植手册要求「有校历用校历、没有用 20，不要用课表里最大周」；这里的周次下拉框就是学校给出的周次范围，取它的最大值；列表为空才退到 20 并提醒；课表比列表更晚时抬高并提醒（`parse.js:394`）。
- **新增：完全相同的行只留一条**：上游的三步合并只在排序后相邻比较，同一门课在多个周里重复出现时（本系统逐周抓取，必然重复）缺教师 / 缺教室的计数会被放大；移植后先按「课名 + 教师 + 地点 + 星期 + 起止节次 + 周次」去重再合并（`mergeRecords`，`parse.js:190`）。去重键包含周次，所以不同周的同一安排不会被误删。
- **新增：连堂合并条件用 `<= end + 1`**：上游是 `end + 1 === start`，同一节的重复行会另起一段、课表重叠（批次十九 `xsyu` 的坑）。这里改成 `next.start <= current.end + 1`，并在合并时取 `max(end)`（`parse.js:213`–`parse.js:218`）。
- **新增：节次超出时的补齐**（统一修订 H3）：课表用到第 14 节之后的节次时，按「上一节下课后课间 5 分钟、每节 45 分钟」顺推补上，越过 23:59 就停并如实提醒（`parse.js:422` 起）。
- **新增：部分周次取不到时的提醒**：`failedWeeks` 按周次汇总进 `warnings`；认不出的课程条目、超过 30 周的周次也计数，不静默丢。
- **开学日期**：上游 `guessStartDate` 的规则原样保留（第一学期 9 月 1 日、第二学期次年 2 月 20 日、短学期 7 月 1 日，取当天或之后的第一个周一），按学期代号最后一位识别第一 / 第二 / 短学期（兼容 `11/12/13` 与 `1/2/3` 两种写法）。**这永远是推算值**，每次都写进提醒。

## 7. 与模板 `upc-grad` 的差异

1. **取数方式完全不同**：`upc-grad` 的课表已经渲染在页面里、只需读一个表格 + 一次教学日历请求；本件要**逐周抓页面**（1 + N 次同源 GET，并发 3），学期与节次时间来自第一次不带参数的响应。
2. **模板用教学日历给开学日与总周数；本件教务没有校历**：开学日按学期规则推算、总周数取周次下拉框最大值，两者都写进提醒。
3. **模板的格子文本是「｛周次[教师:…][地点:…]｝」编码；本件是课程链接里按 `<br>` 分行**，字段解释逻辑（第 X 节行、教师行、地点行、「没有独立教师行时第一行是地点」）按上游重写。
4. **模板的节次表是 12 节写死；本件是 14 节兜底表**（照抄上游 `NKU_FALLBACK_TIME_SLOTS`），页面正文能解析出节次时间时优先用教务的。
5. **合并与去重**按上游 `mergeAndDistinctCourses` 重写，比模板的 `mergeCourses` 多了「连续节次合并」。
6. `parse.js` 的 warnings、limit、`runsOf`、H3 补齐沿用模板与批次统一口径。

## 8. fixture 与覆盖范围

六对都是**合成数据**（课名 / 教师 / 教室均为虚构，不含真实姓名或学号），期望值按本文件 §6 与移植手册 §4 的规则手工推出后再跑自检比对。

| 用例 | 覆盖 |
|---|---|
| `fixtures/basic` | 教务选中第一学期（`2026-2027`）与页面节次时间（4 节）；同一门课跨 3 周合并成 1-3 周；只上单周的课（1/3/5/7 周）合成 1-7 单周段；同周两个相邻节次要合并成 3-4 节；**没有独立教师行时第一行（逸夫楼报告厅）认成地点、教师为 null**；缺教师汇总提醒 |
| `fixtures/weeks` | 同一门课在第 1~3 周重复出现（含完全重复的一条）先按内容去重，缺教师 / 缺地点只计一门课；隔周课程（2/4/6/8）合成 2-8 双周段；第二学期开学日按 2 月 20 日之后最近的周一 = 2027-02-22 |
| `fixtures/fallback` | 学年学期没有预选（`source:"first"`，用列表第一项并提醒）；页面没有节次时间（14 节兜底并提醒）；总周数取周次列表的 20 |
| `fixtures/failed` | 第 2、4 周没取到课表；1 条课程信息认不出（「见通知」）；2 个超过 30 周的周次没抓取——三类都进提醒，其余课程照常导入 |
| `fixtures/long-name` | 3 门 27~28 字课名的课都缺教师 / 缺地点：提醒按类型汇总、点名的课名截到 20 字、整条 121 字（<200） |
| `fixtures/sections` | 课表排到第 15、16 节，兜底节次时间只到第 14 节：按课间 5 分钟、每节 45 分钟顺推补成 22:05-22:50 / 22:55-23:40 并提醒 |

## 9. 浏览器冒烟（`.test/port-batch31/nankai/smoke.py`，Playwright 起假教务站，不联网）

用 `context.route` 拦下全部请求：`extract.js` 真跑在 Chromium（本机用 Edge 内核）里，输出再交给 Rhino 跑 `parse.js`。9 个场景全部 OK：

| 场景 | 验证点 |
|---|---|
| `course-page` | 请求序列 = 1 次不带参数 + `zc=1,2,3`（`xn=2026&xj=11`）；rowspan 网格还原；课程格子里隐藏的学生姓名 / 学号 / 身份证号 / 手机号既不在请求里也不在交出的数据里；学期名、开学日、总周数、节次时间、两门课的合并结果都对 |
| `no-timeslots` | 页面正文没有节次时间 → 14 节兜底 + 提醒 |
| `partial-weeks` | 第 2 周返回登录页 → `failedWeeks` 进提醒；第 3 周是本系统页面但没有课表 → 按当周无课处理，不算失败 |
| `empty-term` | 三周都没有课表 → 报「当前学期还没有排课」，不返回空学期 |
| `term-login` | 不带参数的课表页返回登录页 → 报「当前页面是登录页」，只发 1 次请求 |
| `login-page` | 当前页面就是登录页 → 直接报错，**0 次请求** |
| `other-host` | 不在 `yjs.nankai.edu.cn` → 直接报错，**0 次请求** |
| `no-preselect` | 学期页三个下拉框都没有 `selected` 属性 → 用列表第一项并在提醒里说明（2026-11-10 复审修正新增） |
| `hang-week` | 第 2 周的请求一直不返回 → 单页 8 秒超时后按「这一周没取到」处理，其余周照常导入并提醒（2026-11-10 复审修正新增） |

## 10. 变异测试记录

都在临时目录的副本上改（`%TEMP%/nankai-port31/nankai`），跑完即删；仓库里的文件没有动过。原始代码变异前 PASS、变异后 DIFF、换回原副本 PASS。

| # | 改坏哪一处 | 变红的用例 | 说明 |
|---|---|---|---|
| 1 | `parse.js:162` 的「没有地点、教师行其实是地点」回落条件改成恒假 | `basic` | `学术讲座` 的 `location` 变成 null（期望「逸夫楼报告厅」） |
| 2 | `parse.js:213` 连堂合并条件 `next.start <= current.end + 1` 改成 `next.start < current.end` | `basic` | `计算机基础` 的 3 节 + 4 节不再合并 |
| 3 | `parse.js:272` 学期代号最后一位 `'2'`（第二学期）改成 `'9'` | `weeks`、`fallback` | 第二学期被按第一学期算，开学日从 2027-02-22 变成 2026-09-07 |
| 4 | `parse.js:394` 总周数从「周次列表最大值」改成 `maxWeek` | `basic`、`fallback`、`long-name`、`sections` | 总周数从 8/20 缩成课表里出现的最大周 |

## 10.1 2026-11-10 复审修正

| 编号 | 问题 | 修正 | 捕获方式 |
|---|---|---|---|
| R1 | 提醒写「2 月 20 日**所在周**的周一」，但算法（与上游 `guessStartDate` 一致）取的是当天或之后最近的周一；2027-02-20 是周六时口径正好差一周 | 三条规则文字改成「X 月 X 日**之后最近的周一**」，六个 expected 用例同步 | 六个 fixture 的提醒文本；改回旧措辞即 DIFF |
| R2 | `readOptions` 用 `option.selected` 判断预选，浏览器会把第一个 option 默认置为选中，于是「没有预选」永远检测不到，静默导入列表第一项 | 只认 `selected` 属性（`hasAttribute`） | 冒烟 `no-preselect`；把判定改回 `selected === true \|\| hasAttribute` 后该场景变红（提醒里没有「没有预选学年学期」） |
| R3 | 逐周抓取没有单请求超时与总时长预算，一个卡住的页面会把整次导入拖到宿主 30 秒上限，已抓到的周也一起丢 | 单请求 `AbortController` 超时 8 秒；逐周总预算 22 秒，超预算的周按「没取到」交给 parse.js 提醒 | 冒烟 `hang-week`；去掉超时后该场景会一直等到宿主超时（harness 自身也会卡在浏览器清理，所以这条不做删代码式变异，只保留场景） |

## 11. 已知不确定 / 只有真机能验

1. **上游描述本校系统需要校园网**（`adapters.yaml` 的 `description` 写「需校园网环境」）。校外直连 `yjs.nankai.edu.cn` 可能打不开或跳统一认证，这不是适配器能解决的；AUDIT 如实记录。我们没有本校账号，**真机没验过**。
2. **fixture 是合成的**：只保证「同样的输入永远得到同样的输出」，不保证真实页面上的解析一定对。拿到真实页面请核对三件事：① 课表容器是否始终是 `table.table-course`（否则靠「含星期一 + 第 N 节」兜底）；② 表头是否始终写「星期一…星期日」；③ 课程链接里是否始终按「课名 / 周次 / 第X节 / 教师 / 地点」分行，有没有独立教师行。
3. **`#xn` / `#xj` / `#zc` 三个下拉框的 id 取自上游代码**，页面改版会失效（会报「未获取到课表数据」而不是悄悄导错）。
4. **逐周抓取会放大请求数**：一学期 20 周就是 1 + 20 次同源 GET。已加单请求 8 秒超时与 22 秒总预算（超预算的周按「没取到」提醒），宿主 30 秒上限不会再被一个卡住的页面拖死；但预算用完时后面的周会显示为「没有取到」，校园网很慢时需要重试。上游经验值是并发 3 稳定，这里保持一致。
5. **学期代号只有 `11/12/13` 与 `1/2/3` 两种写法被验证过**：按最后一位数字判断第一 / 第二 / 短学期，遇到新代号会按第一学期算（开学日推算会偏，但提醒里写了推算规则）。
6. **节次时间解析依赖页面正文的「第X节 08:00-08:45」写法**（支持中文数字与阿拉伯数字、`-` / `~` / `至` 等分隔）；解析不到就用 14 节兜底表并提醒，不会静默出错。
7. `warnings` 的显示要新版应用（`minAppVersionCode` 11）；老版本能导入，只是不显示核对提示。

签名：0x7E7-2023（haiku 移植，2026-11-09）
