# 安全审计 —— 南阳师范学院（青果教务，经学校 VPN 的 /http/ 十六进制前缀）

审计对象：`jw-adapters/nynu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `resources/NYNU/nynu.js`（仓库快照 `7c9e1907635cb1c2d481b316e6f52d69dc77edff`，2026-10-27 拉取；
本校脚本最后一次修改实测 `80e30cf`，2026-09-23，提交说明为合并 #744。任务卡写的 `03d161a` 与 `git log -1 -- resources/NYNU/nynu.js` 不一致，以实测为准，未改快照。MIT，作者 `Haooz`）。
上游同目录 `adapters.yaml` 只有一个条目 `NYNU_01`，`import_url` 为 `https://vpn.nynu.edu.cn/`（原样作为 `loginUrl`），
描述写着需先登录学校 VPN 并通过统一身份认证进入教务系统。

审计方式：逐行读上游脚本与移植件；`check.js` 自检（7 对 fixture 用 Rhino 1.8.0 实跑、载荷校验、ES5 与控制字节扫描、`allowHosts` 检查）结果 `RESULT: PASS`；
`extract.js` 用 Playwright 起假教务站在 Chromium 里实跑 13 个场景（`.test/port-batch21/nynu/smoke.py`，不联网）；
变异测试 4 处，见第 9 节。扫描结果：

- 绝对 URL：`extract.js` 文件头注释里有上游仓库地址。代码里的请求地址写死为 `https://vpn.nynu.edu.cn/http/77726476706e69737468656265737421feee52852d27265e67069ce29d51367b58d2/nysfjw/...`，主机与 `loginUrl` 相同。`nysyjw.nynu.edu.cn` 只出现在查询串的键名里，不是请求主机。
- 网络调用：只有 `extract.js` 的 `getText()` 里一处 `fetch`（GET）。`parse.js` 没有任何网络调用。
- 凭据、本地存储、动态执行、信标、WebSocket、`new Image`：无命中。`check.js` 对 `extract.js` 的 password 提示来自 `looksLikeLogin()` 里判断响应是不是登录页的正则（`type=password`），不读输入框、不存、不发。
- 上游 `showAlert` / `showPrompt` / `showSingleSelection` / `showToast` / `saveImportedCourses` / `notifyTaskCompletion`：移植件不调用任何桥。

## 1. 为什么用 jyvtc 当模板

任务卡指定模板为已审计的青果件 `jyvtc`（济源职业技术学院）。行相似度更高的 `gxmu` 是乘方，不用。
本校与 `jyvtc` 同属青果，但取数不同构：`jyvtc` 是 POST `showLessonScheduleDetail.action`、课在 `tr.mykb` 表格里；本校是 GET `showLessonScheduleInfosV14.action`，课在 `id` 形如 `weekly03_1`、class 含 `weeklesson` 的块里，而且地址带学校 VPN 的 `/http/<十六进制>/` 前缀。
因此 `extract.js` 按上游重写；`parse.js` 保留 `jyvtc` 里已审计的周次切段、提醒限长、缺教师 / 缺教室汇总、连堂合并和 H3 补节次，数据入口改成课程块。无逗号前置单双标记按批次十八 `jxfu` 的归属（`weeksOf`），避免 `(单)1-8周(双)9-16周` 退化成 1-16 每周。

## 2. 请求清单（与代码逐条对应）

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| `extract.js` `getText` | GET | `https://vpn.nynu.edu.cn/http/77726476706e69737468656265737421feee52852d27265e67069ce29d51367b58d2/nysfjw/frame/desk/showLessonScheduleInfosV14.action?vpn-12-o1-<源站>&xn=<四位学年>&xq=<0 或 1>` | 取课表网页。路径、查询串形态与上游 `fetchAndParseCourses` 一致。源站从当前地址的 `vpn-12-o1-` 后截取，没有就用上游回落值 `nysyjw.nynu.edu.cn` | 状态码非 2xx 抛「教务系统返回错误（代码 N）」；连不上抛「连不上教务系统」；没有任何课程块且像登录页时抛「登录状态已失效」 |

不发请求的页面（冒烟已覆盖）：

- 地址里含 `login` 或 `cas`（上游 `isLoginPage` 同一规则）：抛「当前打开的是登录页……」（场景 `login-page`）
- 主机不是 `vpn.nynu.edu.cn`，或路径里没有 `/nysfjw/`（VPN 首页、别的主机）：抛「请先登录南阳师范学院的教务系统，打开课表页后再点「提取课表」」（场景 `portal`、`other-host`）

`manifest.json`：`loginUrl` 为 `https://vpn.nynu.edu.cn/`，`allowHosts` 为 `[]`（请求都在这个主机上）。`scheduleUrlHint` 为课表页完整地址，协议、主机和那串十六进制与上游一致，没有改成别的 WebVPN 写法。

学年学期不弹窗：当前地址的 `xn` + `xq` 优先，其次页面（含同源内嵌框架）里成对的 `xn` / `xq`，或形如 `2025-0` 的 `xnxq`；都没有就按今天判断（8 月到次年 1 月为第一学期，编号 0；2 月到 7 月为第二学期，编号 1），并标 `source = guess`。只请求这一次。冒烟：`schedule-url-term` 地址上的 `2024` / `1` 压过页面上的 `2025` / `0`；`schedule-frame`、`schedule-xnxq` 读到页面；`schedule-guess` 与坏值走判断。

## 3. 与上游 / 模板的不同构之处

1. **一块一门课**。`extract.js` 的 `blocksOf` 只收 id 以 `weekly` 开头且 class 含 `weeklesson` 的块，每块只留以「课程名称 / 任课教师 / 上课时间 / 上课地点」开头的纯文字（其余列表项，例如学号，不交出）。`parse.js` 的 `fieldOf` 再按这四个标签取最后一次出现的值。星期来自 id：`weekly03_1` 的星期是 3（上游 `parseWeeklyDiv` 同一条正则），id 对不上或星期不在 1 到 7 就计数跳过，不静默。
2. **上课时间**。上游只认 `[1-2,5-18周]` 这种数字区间加 `[1-2节]`。移植件 `timeParts` 仍从两对方括号里取周次和节次，周次正文交给 `weeksOfCell` / `weeksOf`，因此还能读「周」字、`第1-第8周`、`(单)` / `(双)`（含无逗号前置和后置）、`共 N 周`（只剥备注本身）、教学班序号括号、整串一个不在括号里的「双周」（只作用于区间）。读不出的计数后跳过并提醒。
3. **教师 / 教室**。上游缺了就写成「未知教师」「未知地点」。这里写成空，并按类型汇总，点名课名截到 20 字，指向「编辑课程」。
4. **节次时间**。上游没有从教务读，也没有写死的表（不抄 `jyvtc` 的两套时间，那是另一所学校的）。整张用常用的 12 节（第 1 节 08:00-08:45，第 12 节 21:15-22:00），并在提醒里说明请到「学期管理」核对。课表用到第 13 节及以后时按统一修订 H3 从上一节下课后顺推（课间 5 分钟、每节 45 分钟），越过 23:59 就停，课程仍导入。第 13 节 22:05-22:50，第 14 节 22:55-23:40，第 15 节起不补。
5. **开学日 / 总周数 / 学期名**。上游都不给。开学日按学期推算（第一学期 = 9 月 1 日所在周的周一，第二学期 = 2 月 20 日所在周的周一），总周数取 20 与课表最大周次中较大者（最多 30），两条都写进提醒。学期名由学年和学期编号推出（`2025` + `0` → `2025-2026学年第一学期`），读不出时用「南阳师范学院 当前学期」。
6. **合并**。上游只按课名、星期、节次、周次、教师、地点去重。这里先去掉完全相同的块，再把同一门课、同一星期、周次相同且下一节起点不晚于上一节终点加 1 的合成一块（连堂，也吸收同一节的重复和互相重叠的节次），最后把节次相同的周次取并集。同名不同教师仍是两门课。

## 4. 读了什么、交出去什么

`extract.js` 交出去的对象只有：`term.xn`、`term.xq`、`term.source`（`page` 或 `guess`）、`today`（导入当天的日期）、`blocks[]`（`id` 加最多四条标签文字，每条最多 200 字）。没有学号、姓名、身份证号、手机号。

`parse.js` 交出去的载荷：`specVersion`、`kind`、`ocrAssisted`、`warnings`、`terms[0]` 的 `name` / `firstDay` / `totalWeeks` / `periodTimes` / `courses`。每门课只有 `name`、`teacher`（或空）、`note`（空）、`blocks`（星期、起止节次、起止周、单双周、地点或空）。

## 5. 移植手册第 5 节八条

1. 不碰凭据：不读账号密码，不访问本地存储。登录页判断只用地址和响应里是否像登录表单。
2. 不外发：只 GET 上面那一个 `vpn.nynu.edu.cn` 地址，查询串里的源站名字不会变成另一个请求主机。`allowHosts` 为空，没有通配。
3. 只读课表：没有成绩、学籍、个人信息、缴费接口。响应里夹带的其它文字不进 `blocks`。
4. 不埋点：无。
5. 不动态执行：无 `eval` / `new Function`。
6. 不改页面：不写 DOM、不提交表单。
7. 不硬编码秘密或他人学号。fixture 与冒烟用的人名、学号都是合成的。
8. 给学生看的提醒不写实现细节：不出现「接口」「载荷」「上游」「脚本」「字段」「作息表」。时间表叫「节次时间」，改学期信息指向「学期管理」，改教师 / 教室指向「编辑课程」。

## 6. 上游里删掉或改掉的

- 开场公告、学年输入框、学期单选、保存课程、完成通知：空课由宿主保存，适配器只交数据。
- 「未知教师」「未知地点」：拿不到就是空。
- 同一门课只去重、不合并相邻节次：移植件会合并连堂和重叠节次，避免同一节的重复行另起一块。
- 周次正则只接受数字、逗号、减号：移植件接受上游注释里的 `1-2,5-18`，并补上常见的单双周、第、共 N 周写法，读不出才跳过并提醒。

## 7. 冒烟（13 个场景）

假站不联网。正常桌面页拼出的地址是  
`GET https://vpn.nynu.edu.cn/http/77726476706e69737468656265737421feee52852d27265e67069ce29d51367b58d2/nysfjw/frame/desk/showLessonScheduleInfosV14.action?vpn-12-o1-nysyjw.nynu.edu.cn&xn=2025&xq=0`  
（页面选了 2025 年第 0 学期时）。地址上带 `vpn-12-o1-lab.nynu.edu.cn` 时查询串改用这个源站。GET，无请求体，不加 `X-Requested-With`。学号等合成个人信息没有出现在请求或交出的文字里；class 不是 `weeklesson` 的块不会进课表。登录页、VPN 首页、其它主机不发请求。空课表由 `parse.js` 报「这个学期……在教务系统里还没有课」。

## 8. fixtures（7 对，期望值按规范和代码手工推演，不是把 parse.js 的输出存下来）

- `basic`：分段周次 1-2 与 5-18、重复块只留一条、1-2 节与 3-4 节连成 1-4 节、开学日 2025-09-01
- `weeks-forms`：无逗号前置单双、后置单双、有逗号前置、第 1-第 8 周、共 8 周、整串双周、教学班序号、括号备注、单双同写、第 22 周把总周数加成 22
- `messy`：缺教师 / 缺教室 / 「未知」留空、教室带空格、坏 id、缺课名、上课时间认不出
- `long-names`：长课名截到 20 字，缺教师 4 门、缺地点 1 门，提醒里写「另有 1 门未列出」，整条不超过 200 字
- `period-overflow`：第 13-14 节顺推，第 15 节越过 23:59 不补
- `merge`：连堂、重复节、重叠节合成 1-5、周次并集、同名不同教师
- `guess-second`：`source = guess` 的提醒，第二学期开学日 2026-02-16

## 9. 变异测试（改坏后自检变红，已还原，还原后 `RESULT: PASS`）

- `weeksOf` 里「本段以单双标记开头则后一个标记归下一段」改成一律留给上一段：`weeks-forms` 变红
- `mergeStageOne` 的 `next.start <= current.end + 1` 改成必须正好接上一节：`merge` 变红
- `weeksOfCell` 里「共 N 周」从只剥备注改成从「共」删到结尾：`weeks-forms` 变红
- `blankToNull` 不再把「未知」当成没填：`messy` 变红

## 10. 已知风险与未验证项

没有本校账号，真机没验过。课表网页的真实标签是否就是这四条、`weeklesson` 是否稳定，只对照了上游脚本，没有对照过线上页面。源站回落值 `nysyjw.nynu.edu.cn` 是否每次会话都适用，上游自己也写了「没匹配到才用」。节次时间不是学校公布的，学生需要在「学期管理」里核对。开学日是按 9 月 1 日 / 2 月 20 日推的周一，不是校历。

签名：0x7E7-2023（haiku 移植，2026-10-27）
