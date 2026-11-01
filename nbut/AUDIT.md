# 安全审计 —— 宁波工程学院（正方教务 V9，jwglxt，http）

审计对象：`jw-adapters/nbut/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `NBUT/nbut.js`（MIT）。`adapters.yaml` 的 maintainer 是 `xiekeqing`。
任务卡把作者写成「星河欲转」，那是仓库名，不是 yaml 里的维护者，这里按 yaml 署名。
任务卡写的上游快照是 `03d161a`。`git log -1 -- resources/NBUT/nbut.js` 给出的本校脚本最后一次修改是 `80e30cf`，与任务卡一致。

模板选 `qut`：同为已审计的正方 jwglxt（课表首页读学年学期、课表 POST、节次时间 POST、周次文字解析、连堂合并）。
本校与模板不同的是：协议为 http、主机 `jwxt.nbut.edu.cn`、菜单号只有 `N2151`、请求体只有学年和学期、
校历是移动校历页上的一个开学日期而不是周次列表、上游没有写死节次表。

## 0. 与模板的不同、本校边界

上游实际打开的课表页是 `xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`。
`loginUrl`、`scheduleUrlHint`、`allowHosts` 按任务卡原样填写，协议保持 http，菜单号不改成别的学校的。

上游只请求 `http://jwxt.nbut.edu.cn`，没有第二台主机。`allowHosts` 为空，不写通配。运行时地址由当前页面的源拼出，不把协议改成 https。

上游没有写死节次时间。节次接口若只有节次号、没有上课时间（`periodListUsable`），不当成可用，交 null。
取不到时 `parse.js` 用应用里常用的 12 节（与 qut 补晚节用的是同一张），并写进提醒。这不是学校公布的时间。

本校专属边界（都有 fixture）：无逗号的 `(单)1-8周(双)9-16周` 必须是 1–7 单周加 10–16 双周；
后置 `1-8周(单)9-16周(双)` 同样；「第1-第8周」不能拆成两周；「共 N 周」不能吞掉后面的周次；
「未知」「待定」「暂无」写成空；星期中文「星期三」「星期一」；只有节次号的列表回落到 12 节；
校历只给开学日时总周数按 20，课表到第 21 周才抬高；1-2 节与 2-3 节并成 1-3 节。

## 1. 请求域与请求清单（与代码逐条对应）

地址都由当前页面的源加上下文路径拼出（`jwBase`）。当前路径里已经有 `/jwglxt/` 时，前缀保留。
主机必须正好是 `jwxt.nbut.edu.cn`（`onJwHost`）。登录页与路径里带 `/sso/` 的页面直接提示，不发请求（`onLoginPage`）。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<jwBase>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的学年、学期下拉框。页面上已经有这两个下拉框时跳过（`currentTerm`） | 报错，提示重新登录后再点「提取课表」 |
| extract.js | POST | `<jwBase>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表。请求体只有 `xnm`、`xqm`（与上游 `encodeParams` 一致，不附加空的课程类型） | 报错 |
| extract.js | POST | `<jwBase>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | 取节次时间。请求体同样只有 `xnm`、`xqm`（`fetchPeriodTimes`）。只试这一个菜单号 | 没有列表、请求失败，或每行都没有上课时间：交 null。parse 用应用里常用的 12 节并提醒 |
| extract.js | GET | `<jwBase>/pkgl/xlglMobile_cxXlIndexForxs.html?gnmkdm=Y210501&layout=default` | 读移动校历页上的开学日期（元素 `ksrq`，`fetchCalendarStart`） | 交 null。parse 按学期推算开学日，总周数按 20，课表更晚再抬高，并提醒 |

节次时间与校历失败不影响导入。课表接口回登录页文字时，按「登录已过期」报错，不再往下请求。

`parse.js` 不发任何请求。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期 | 页面或课表首页的下拉框 | 带出（学期名要用） |
| 排课行 | 课表接口 `kbList` | 只带 `kcmc`、`xm`、`cdmc`、`xqj`、`xqjmc`、`jcs`、`zcd`（`KB_FIELDS`）。上游只读星期中文，正方多数还给数字，两个都留 |
| 集中实践课 | 课表接口 `sjkList`（上游整段忽略） | 只带 `kcmc`。没有星期和节次，排不进周课表，写进提醒 |
| 节次时间 | 节次接口里至少有一行带上课时间的列表 | 只带 `jcdm`、`jcmc`、`jc`、`qssj`、`jssj`、`sksj`。只有节次号的列表整份丢掉 |
| 开学日期 | 移动校历页 `ksrq` | 只带这一段文字（`calendarStart`），不带页面上的姓名学号 |
| 记录总数 | 课表响应里有才有 | 只用于对账，不进课表 |
| 学号、姓名、身份证号、手机号、`xsxx` | 响应里可能夹带 | 不带出 |

`parse.js` 读的字段：排课行上述七项；实践课 `kcmc`；节次时间的节次号与起止（`periodTimesOf`，没有起止就整份作废）；`calendarStart` 或周次列表里的日期；`total`；`today`；学期四项文本。课名会去掉 `★○●◇◆`。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 过。不读密码、不读本地存储。上游改地址跳登录页、保存课程 / 配置 / 节次时间的桥调用都没有移植 |
| 2 | 不外发 | 过。`fetch` 只在 `extract.js` 的 `request`，地址由当前页面的源拼出 |
| 3 | 请求域可控 | 过。只认 `jwxt.nbut.edu.cn`。`allowHosts` 为空。代码里的绝对地址只有文件头注释中的上游仓库，不参与请求 |
| 4 | 只读课表 | 过。课表页、课表、节次时间都在 `/kbcx/`；开学日期在 `/pkgl/` 的移动校历页（上游用来取开学日，不取成绩学籍）。学生个人信息按白名单丢掉 |
| 5 | 不埋点 | 过。没有上报、没有打点 |
| 6 | 不执行远程代码 | 过。没有 `eval` / `new Function`。只对教务响应做 JSON 解析，校历页用 `DOMParser` 离线读 |
| 7 | 不写页面 | 过。只读下拉框和开学日期。不改地址、不插入当前页、不提交表单 |
| 8 | 不依赖秘密 | 过。没有密钥或他人学号。常量只有路径 `/jwglxt`、主机名和菜单号 `N2151` / `Y210501` |

## 4. 上游里删掉或改掉的东西

- 不在教务站就 `location.href` 跳到登录页：改成提示，不改页面。
- 弹窗和桥：`showToast`、`saveImportedCourses`、`savePresetTimeSlots`、`saveCourseConfig`、`notifyTaskCompletion` 都不移植。
- 请求头里的浏览器标识、来源页：不抄。同源请求由页面自己带登录状态。
- 周次：上游 `parseWeek` 只认一段起止，整段里有「单」或「双」就过滤。多段和「第」「共 N 周」会读错。这里用 qut / hueb 已审计的 `weeksOf`。
- 教师、教室：上游空了就照样带出，写「未知」会被课表当成真名。这里空着，并把「未知」「待定」「暂无」当成没给，提醒里指向「编辑课程」，不指向「学期管理」。
- 节次：上游 `jcs.split("-")` 认不出「第9-10节」「0102」。这里放宽，多段按最大跨度并说明。
- 节次时间：上游没有写死表，失败就直接结束、课已经存了但时间没存。这里仍导入课表，时间改用应用里常用的 12 节并说明。上游的 `defaultClassDuration = 40` 没有起点，不能排成一天的时间，不用。
- 总周数：上游不给。校历只有开学日时按 20；课表最大周更晚才抬高并提醒。开学日退到那一周的周一。
- 集中实践课：上游丢掉。这里只留课名进提醒。
- 星期：上游只认「星期一」到「星期日」。这里数字优先，没有再认中文。

## 5. 变异测试（临时副本，正式文件未改）

| 改坏 | 变红的用例 |
|---|---|
| `weeksOf` 里，本段以前置单双标记开头时不再把后一个标记隔到下一段 | `fixtures/weeks-prefix-glued.extracted.json` DIFF |
| 标记和数字之间的空格、或「周」紧挨下一段数字时不再断开 | `fixtures/weeks-space.extracted.json` DIFF |
| `mergeStageOne` 改成下一节必须正好等于上一段结束再加 1 | `fixtures/merge.extracted.json` DIFF（1-2 与 2-3 不再并成 1-3） |
| `weeksOf` 不再去掉「第」 | `fixtures/week-di.extracted.json` DIFF |

副本已删除。正式目录自检为 PASS。

## 6. 已知风险

没有宁波工程学院账号，真机没验过。菜单号 N2151、请求体只有学年学期、移动校历页的开学日期，只在假教务站上对过。
节次接口若一部分行有时间、一部分没有，整份作废并改用 12 节，不猜着补。
校历若把开学日写在 `ksrq` 以外的地方，会当成没给到。
应用里常用的 12 节不是学校公布的节次时间，只在教务没给可用时间时使用，提醒里写了请到学期管理核对。

签名：0x7E7-2023（haiku 移植，2026-10-27）
