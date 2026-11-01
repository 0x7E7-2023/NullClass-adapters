# 安全审计 —— 青岛理工大学（正方教务 V9，jwglxt）

审计对象：`jw-adapters/qut/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `QUT/qut.js`（MIT，作者 LucasAndrew0120）。任务卡写的上游快照是 `03d161a`（与当前快照 HEAD 一致）。
`git log -1 -- resources/QUT/qut.js` 给出的本校脚本最后一次修改是 `80e30cf`（2026-09-23 的合并提交）；其后的快照提交没有再改这个文件。

模板选 `hueb`：同为已审计的正方 jwglxt（课表 POST、校历 POST、节次时间 POST、下拉框读学年学期）。本校与模板不同的是菜单号、请求体多 `kclxdm`、节次时间先试 `N2151` 再试 `N253508`、不带校区号、内置节次是 10 节而不是 13 节。

## 0. 与模板的不同、本校边界

上游实际打开的课表页是 `xskbcx_cxXskbcxIndex.html?gnmkdm=N253508`（`qut.js` 里 `fetchTermPage` / `isOnTimetablePage`）。任务卡预填的 `scheduleUrlHint` 是周次页 `xskbcxZccx_cxXskbcxIndex.html?gnmkdm=N2154`。按「课表页以上游实际打开的为准」，`manifest.scheduleUrlHint` 用的是 N253508 那条，主机仍是 `jxgl.qut.edu.cn`。周次接口仍是 N2154 的 `cxZcByXnxq`，没有当成课表页。

上游只请求 `window.location.origin`，没有第二台主机。`allowHosts` 为空，不写通配。

内置节次时间（上游 `TimeSlots`，逐节照抄，只在两个节次接口都没有可用列表时使用）：

| 节 | 开始 | 结束 | 节 | 开始 | 结束 |
|---|---|---|---|---|---|
| 1 | 08:00 | 08:45 | 6 | 14:00 | 14:45 |
| 2 | 08:50 | 09:35 | 7 | 14:50 | 15:35 |
| 3 | 09:55 | 10:40 | 8 | 15:55 | 16:40 |
| 4 | 10:45 | 11:30 | 9 | 16:45 | 17:30 |
| 5 | 11:35 | 12:20 | 10 | 19:00 | 19:45 |

本校专属边界（都有 fixture）：无逗号的前置单双标记；「第1-第8周」不能拆成两周；节次号用 `jcdm`、只有 `sksj` 的一节也要认；1-2 节与 2-3 节要并成 1-3 节（上游是「下一节起点不晚于上一节结束再加 1」）。

## 1. 请求域与请求清单（与代码逐条对应）

地址都由 `window.location.origin` 加上下文路径拼出（`extract.js` 的 `jwBase`，第 42 行）。当前路径里已经有 `/jwglxt/` 时，前缀保留，不会写成两段。主机必须正好是 `jxgl.qut.edu.cn`（`onJwHost`，第 49 行）；登录页与路径里带 `/sso/` 的页面直接提示，不发请求（第 53、267 行）。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<jwBase>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508&layout=default` | 读课表页上的学年、学期下拉框。页面上已经有这两个下拉框时跳过（`currentTerm`，第 160 行） | 报错，提示重新登录后再点「提取课表」 |
| extract.js | POST | `<jwBase>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N253508` | 取课表。请求体 `xnm`、`xqm`、`kzlx=ck`、`xsdm=`、`kclbdm=`、`kclxdm=`（与上游一致，比 hueb 多空的 `kclxdm`） | 报错 |
| extract.js | POST | `<jwBase>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151`，没有可用列表再 POST 同一路径 `gnmkdm=N253508` | 取节次时间。请求体与课表相同，不带校区号（`fetchPeriodTimes`，第 218 行） | 交 null，parse 用上面那张 10 节表，并写进提醒 |
| extract.js | POST | `<jwBase>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取学期周次校历。请求体只有 `xnm`、`xqm`（第 280 行） | 交 null，parse 按学期推算开学日，总周数先按 20，课表更晚再抬高，并写进提醒 |

附加的节次时间与校历失败不影响导入：`optionalJson` 把非成功状态、网络错误、不是 JSON 都变成 null。课表接口回登录页文字时，按「登录已过期」报错，不再往下请求。

`parse.js` 不发任何请求。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期 | 页面或课表首页的下拉框 | 带出（学期名要用） |
| 排课行 | 课表接口 `kbList` | 只带 `kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd`（`KB_FIELDS`，第 237 行）。不带校区号：上游节次请求不用它，parse 也不读它 |
| 集中实践课 | 课表接口 `sjkList`（上游整段忽略） | 只带 `kcmc`。没有星期和节次，排不进周课表，写进提醒，不静默丢掉 |
| 节次时间 | 两个菜单号里第一个非空列表 | 只带 `jcdm`、`jcmc`、`jc`、`qssj`、`jssj`、`sksj` |
| 校历 | 周次接口 | 只带 `zs`、`zsmc`、`zrq`、`zcrq`、`rq`、`ksrq`。日期若写在别的名字里，会当成没给到，改走推算并提醒 |
| 记录总数 | 课表响应里有才有 | 只用于对账，不进课表 |
| 学号、姓名、身份证号、手机号、`xsxx` | 响应里可能夹带 | 不带出 |

`parse.js` 读的字段：排课行上述六项；实践课 `kcmc`；节次时间的 `jcdm` / `jcmc` / `jc` 与 `qssj` / `jssj` / `sksj`（`periodTimesOf`，第 509 行）；校历的周次与日期；`total`；`today`；学期四项文本。课名会去掉 `★○●◇◆`（上游 `cleanCourseName`）。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 过。不读密码、不读本地存储。上游的开场弹窗、两个学期选择框、保存课程 / 配置 / 节次时间的桥调用都没有移植 |
| 2 | 不外发 | 过。`fetch` 只在 `extract.js` 的 `request`（第 67 行），地址由当前页面的源拼出 |
| 3 | 请求域可控 | 过。只认 `jxgl.qut.edu.cn`。`allowHosts` 为空，代码里没有写死别的主机 |
| 4 | 只读课表 | 过。四条请求都在 `/kbcx/`（课表页、课表、节次时间、校历）。学生个人信息按白名单丢掉 |
| 5 | 不埋点 | 过。没有上报、没有打点 |
| 6 | 不执行远程代码 | 过。没有 `eval` / `new Function`。只对教务响应做 JSON 解析 |
| 7 | 不写页面 | 过。只读下拉框。课表首页用 `DOMParser` 离线解析，不插入当前页，不提交表单 |
| 8 | 不依赖秘密 | 过。没有密钥或他人学号。常量只有路径 `/jwglxt` 和菜单号 `N253508` / `N2151` / `N2154` |

## 4. 上游里删掉或改掉的东西

- 弹窗选学年学期：改成读页面上已选中的项；页面上没有才去取课表首页。
- `console.log` 打印原始课表行：会把响应里的个人信息打进日志，删掉。
- `Map` / `Set` / `Array.from` / `padStart` / 异步函数：Rhino 约束下不用。合并改成 hueb 的两阶段，节次相接条件保持上游的「起点不晚于上一段结束再加 1」，并先去掉完全相同的行。
- 总周数：上游只取课表里最大周次，没有就 20，开学日经常是空。这里优先用校历，校历的第 1 周若不是周一就退到那一周的周一；校历不像这个学期（离锚点超过 45 天）就不用，改推算并说明。
- 集中实践课：上游丢掉。这里只留课名进提醒。
- 上游在节次接口失败时用内置 10 节。这里同样，课表用到第 11 节及以后再按统一修订补，补不了的说明。

## 5. 变异测试（在临时副本上改，正式文件未改；改前自检已 PASS）

| 改坏 | 变红的用例 |
|---|---|
| 去掉周次里「第」的剥离（`weeksOf`，第 317 行） | `fixtures/week-di.extracted.json` DIFF |
| 连堂合并改回必须正好差 1 节（`mergeStageOne`，第 626 行） | `fixtures/merge.extracted.json` DIFF |
| 无逗号的前置单双标记不再补分隔（`weeksOf` 里归下一段的那一支） | `fixtures/weeks-prefix-glued.extracted.json` DIFF |

副本已删除。正式目录随后再跑一次自检，必须仍是 PASS。

## 6. 已知风险

没有青岛理工大学账号，真机没验过。节次时间两个菜单号的先后、课表请求体里的空 `kclxdm`，只在假教务站上对过。校历日期若写在白名单以外的字段里，会当成没给到。`scheduleUrlHint` 与任务卡预填的周次页不一致，见第 0 节，留给主调度确认。

签名：0x7E7-2023（haiku 移植，2026-10-27）
