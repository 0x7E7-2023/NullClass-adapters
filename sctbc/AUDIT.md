# 安全审计 —— 四川工商职业技术学院（正方教务 V9，网站根路径，http）

审计对象：`jw-adapters/sctbc/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `SCTBC/sctbc.js`（MIT）。提交作者是 Violet（`94ce818`），`adapters.yaml` 的 maintainer 是 `dclindev`。
任务卡写「没有 adapters.yaml」，快照里实际有一份，署名按两边都保留。
任务卡写的上游快照是 `03d161a`。`git log -1 -- resources/SCTBC/sctbc.js` 给出的本校脚本最后一次修改是 `94ce818`，与任务卡一致。

模板选 `nbut`：同为已审计的正方 V9（课表首页读学年学期、课表 POST、节次时间 POST、周次文字、连堂合并、只有节次号的列表不当成节次时间）。
本校与模板不同的是：教务挂在网站根上，不拼 `/jwglxt/`；课表接口是 `xskbcx_cxXsKb.html` 而不是个人课表 `xskbcx_cxXsgrkb.html`；
请求体带 `kzlx=ck`（节次还带三个空筛选项）；校历是 POST `xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` 的周列表，不是移动校历页上的一个日期；
统一认证主机 `cas.sctbc.edu.cn` 只用来认出登录页，不进 `allowHosts`。

## 0. 与模板的不同、本校边界

上游实际打开的登录页是 `http://jw.sctbc.edu.cn/xtgl/login_slogin.html`。
`loginUrl`、`scheduleUrlHint`、`allowHosts` 按任务卡原样填写：协议保持 http，路径里不加 `/jwglxt/`，`allowHosts` 为空。

上游只请求 `http://jw.sctbc.edu.cn`。运行时地址由当前页面的源拼出（`jwBase` 就是源，不看路径里有没有 `/jwglxt/`），不把协议改成 https。

上游没有写死节次时间。节次接口若只有节次号、没有上课时间（`periodListUsable`），不当成可用，交 null。
取不到时 `parse.js` 用应用里常用的 12 节，并写进提醒。这不是学校公布的时间。

校历：一行一周。周次号认 `zs` 或 `zsmc`（会去掉「第」「周」这类字）。第 1 周的日期认 `zrq` / `zcrq` / `rq` / `ksrq`，再退到那一周的周一。
最大周在 10 到 30 之间才拿来当学期一共多少周（上游同一口径）。只有第 1 周时当成只给了开学日期。比 10 短（且不止一周）或比 30 长的不当成一学期，并提醒。
没有可用校历时总周数按 20，课表最大周更晚才抬高。

本校专属边界（都有 fixture）：无逗号的 `(单)1-8周(双)9-16周` 必须是 1–7 单周加 10–16 双周；
标记和数字之间有空格同样；后置 `1-8周(单)9-16周(双)` 同样；「第1-第8周」不能拆成两周；「共 N 周」不能吞掉后面的周次；
「未知」「待定」「暂无」「暂无教师」「暂无教室」写成空；星期中文「星期三」「星期一」；只有节次号的列表回落到 12 节；
校历第 1 周写成「第1周」「2026年9月7日」仍认得出；校历只到第 8 周时总周数仍按 20；校历到第 18 周时总周数用 18；
没有校历时课表到第 21 周才抬高；1-2 节与 2-3 节并成 1-3 节。

## 1. 请求域与请求清单（与代码逐条对应）

地址都由当前页面的源拼出（`jwBase`，`extract.js`）。当前路径里即使出现 `/jwglxt/` 也不跟着走。
主机必须正好是 `jw.sctbc.edu.cn`（`onJwHost`）。`cas.sctbc.edu.cn`（`onCasPage`）、登录页与路径里带 `/sso/` 的页面（`onLoginPage`）直接提示，不发请求。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<源>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151` | 读课表页上的学年、学期下拉框。页面上已经有这两个下拉框时跳过（`currentTerm`） | 报错，提示重新登录后再点「提取课表」 |
| extract.js | POST | `<源>/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151` | 取课表。请求体是 `xnm`、`xqm`、`kzlx=ck`（`fetchTimetable`） | 报错 |
| extract.js | POST | `<源>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | 取节次时间。请求体是 `xnm`、`xqm`、`kzlx=ck` 以及空的 `xsdm`、`kclbdm`、`kclxdm`（`fetchPeriodTimes`） | 没有列表、请求失败，或每行都没有上课时间：交 null。parse 用应用里常用的 12 节并提醒 |
| extract.js | POST | `<源>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取校历各周。请求体只有 `xnm`、`xqm`（`fetchCalendar`） | 交 null。parse 按学期推算开学日，总周数按 20，课表更晚再抬高，并提醒 |

节次时间与校历失败不影响导入。课表接口回登录页文字时，按「登录已过期」报错，不再往下请求。

`parse.js` 不发任何请求。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期 | 页面或课表首页的下拉框 | 带出（学期名要用） |
| 排课行 | 课表接口 `kbList` | 只带 `kcmc`、`xm`、`cdmc`、`xqj`、`xqjmc`、`jcs`、`zcd`（`KB_FIELDS`） |
| 集中实践课 | 课表接口 `sjkList`（上游整段忽略） | 只带 `kcmc`。没有星期和节次，排不进周课表，写进提醒 |
| 节次时间 | 节次接口里至少有一行带上课时间的列表 | 只带 `jcdm`、`jcmc`、`jc`、`qssj`、`jssj`、`sksj`。只有节次号的列表整份丢掉。有的行有时间、有的行没有时，留下有时间的行 |
| 校历 | 校历接口的周列表 | 只带 `zs`、`zsmc`、`rq`、`zcrq`、`ksrq`、`zrq`（`CAL_FIELDS`）。上游只用前三个日期名，`zrq` 是同平台其它部署的叫法，多留一个日期不会带出个人信息 |
| 记录总数 | 课表响应里有才有 | 只用于对账，不进课表 |
| 学号、姓名、身份证号、手机号、`xsxx` | 响应里可能夹带 | 不带出 |

`parse.js` 读的字段：排课行上述七项；实践课 `kcmc`；节次时间的节次号与起止（`periodTimesOf`，没有起止的行跳过；一行都没有或没有第 1 节才整份作废）；校历周次与日期（`calendarInfo`，`spanRejected` 在其后）；`total`；`today`；学期四项文本。课名会去掉星号一类符号。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 过。不读密码、不读本地存储。上游的确认框、选学年学期、保存课程 / 配置 / 节次时间的桥调用都没有移植 |
| 2 | 不外发 | 过。`fetch` 只在 `extract.js` 的 `request`，地址由当前页面的源拼出 |
| 3 | 请求域可控 | 过。只认 `jw.sctbc.edu.cn`。`allowHosts` 为空，不写通配。`cas.sctbc.edu.cn` 只出现在登录页判断里，不会向它发请求。代码里的绝对地址只有文件头注释中的上游仓库，不参与请求 |
| 4 | 只读课表 | 过。课表页、课表、节次时间、校历都在 `/kbcx/`。学生个人信息按白名单丢掉 |
| 5 | 不埋点 | 过。没有上报、没有打点 |
| 6 | 不执行远程代码 | 过。没有 `eval` / `new Function`。只对教务响应做 JSON 解析，课表首页用 `DOMParser` 离线读 |
| 7 | 不写页面 | 过。只读下拉框。不改地址、不插入当前页、不提交表单 |
| 8 | 不依赖秘密 | 过。没有密钥或他人学号。常量只有主机名和菜单号 `N2151` / `N2154` |

## 4. 上游里删掉或改掉的东西

- 弹窗选学年、选学期，以及「开始导入」确认框：改成读页面上教务已经选中的学期，页面上没有才去取一次课表首页。不弹窗。
- 桥：`showAlert`、`showSingleSelection`、`showToast`、`saveImportedCourses`、`savePresetTimeSlots`、`saveCourseConfig`、`notifyTaskCompletion` 都不移植。
- 请求头里的来源页：不抄。同源请求由页面自己带登录状态。
- 周次：上游 `toWeeks` 按逗号切开后整段看有没有「单」或「双」，`(单)1-8周(双)9-16周` 会粘成一段。这里用 nbut / hueb 已审计的 `weeksOf`，并保留空格与「第」的用例。
- 没有星期、节次或周次的行：上游直接跳过。这里计数后写进提醒，不静默。
- 教师、教室：上游空字符串照样带出。这里空着，并把「未知」「待定」「暂无」「暂无教师」「暂无教室」当成没给。提醒指向「编辑课程」，不指向「学期管理」。
- 节次：上游只取数字里的最小和最大。这里放宽写法，多段按最大跨度并说明。
- 节次时间：上游没有写死表，失败就不存时间。这里仍导入课表，时间改用应用里常用的 12 节并说明。
- 总周数：上游把课表最大周和校历最大周比，校历只在 10 到 30 周之间才采用。这里同样；没有校历时按 20，更晚再抬高并提醒。开学日退到那一周的周一。
- 集中实践课：上游丢掉。课表响应里若另有 `sjkList`，这里只留课名进提醒。
- 学分：上游有就带上。空课这一步的课表载荷没有学分项，不带出。

## 5. 变异测试（已还原，还原后自检 PASS）

| 改坏哪里 | 变红的用例 |
|---|---|
| `calendar.weeks < 10` 改成永远不成立，8 周的校历被当成一学期 | `fixtures/calendar-short.extracted.json` |
| 无逗号前置单双标记不再补逗号隔开下一段 | `fixtures/weeks-prefix-glued.extracted.json`、`fixtures/weeks-space.extracted.json` |
| `blankField` 不再把「暂无教师」当成没给 | `fixtures/basic.extracted.json` |

## 6. 冒烟（不联网）

`.test/port-batch23/sctbc/smoke.py` 用假教务站跑真实 `extract.js`。12 个场景全部 OK：
课表页上已有学期时不重复取首页；菜单页会先取首页；页面停在 `/jwglxt/` 下时请求仍走网站根的 `/kbcx/`；
登录页、`/sso/`、`cas.sctbc.edu.cn`、学校官网不发请求；课表回登录页、非课表内容、代码 500 时报错且不再请求节次和校历；
节次或校历失败仍能导入，开学日按 9 月 1 日所在周的周一推算、总周数 20、节次时间用常用的 12 节；
只有节次号的列表不当成节次时间；校历与节次响应里的学号、姓名不出现在交出去的文字里。
拼出来的地址：
`POST /kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151` 正文 `xnm=2026&xqm=3&kzlx=ck`；
`POST /kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` 正文 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=&kclxdm=`；
`POST /kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` 正文 `xnm=2026&xqm=3`。

## 7. 已知风险与未验证项

没有本校账号，真机没验过。菜单号、字段名、校历 10 到 30 周的口径都按上游脚本，没有对照过真实响应。
正方若把课表改回 `/jwglxt/` 或改接口名，取数会失败并提示，不会猜另一条路径。

签名：0x7E7-2023（haiku 移植，2026-11-01）
