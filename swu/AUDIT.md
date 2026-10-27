# 安全审计 —— 西南大学（正方教务新版 jwglxt，从办事大厅门户进入）

审计对象：`jw-adapters/swu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `SWU/swu.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，2026-10-20 复核仍是最新；
MIT，作者 小漫君；本校脚本最后一次修改 `91c79f1`，2026-10-15）。

审计方式：逐行读上游脚本 + 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，
  `extract.js` 文件头还有一处 `https://jw.swu.edu.cn`，三处都在注释里（说明上游把该主机写死），代码里没有任何绝对地址。
  `manifest.json` 里的 `loginUrl`、`scheduleUrlHint`、`homepage` 是给宿主看的声明，不是请求。
- 网络调用：只有 `extract.js` 里 `request` 函数中的一处 `fetch(url, options)`（`X-Requested-With` 是请求头字符串，不是 XHR 对象）。
  `parse.js` 里没有任何网络调用、没有 `document.` / `window.` / 桥调用。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` /
  `new Function` / `sendBeacon` / `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit` / `setAttribute` 全部无命中。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class`、`async`、`await`、展开符、可选链、`??`、`padStart`、
  `Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(` 全部无命中。
- 模板残留：`parse.js`、`extract.js`、`manifest.json`、`fixtures/` 检索「河北」「hueb」「HUEB」「Haooz」「202-206」「lcudcc」，零命中
  （仅 `parse.js` 文件头与 `extract.js` 注释里有意写「模板为批次八的 hueb」「照模板 hueb」）。
- 个人信息：`fixtures/` 全部为合成数据（甲 / 乙 / 丙…老师，教学楼 / 综合楼等虚构地点），没有真实姓名与学号。
  `extract.js` 里出现的「学号、姓名」二字只在注释中说明被丢弃的字段。

## 0. 上游情况与任务卡核对

- 上游文件 `SWU/swu.js` 的文件头与 `adapters.yaml` 一致，校名为「西南大学」，无需修正（与河北经贸大学那件的文件头笔误不同）。
- 上游 `buildApiUrl` 固定拼 `window.location.origin + <WebVPN 前缀> + "/jwglxt" + path`，前缀取自 `/http/<十六进制>`；
  本件的 `jwBase()` 取「`/jwglxt/` 之前的整段路径」，覆盖了 `/http/<十六进制>` 与 `/https/<主机名>` 两种形态，并在门户页上拒绝发请求（见 §4）。
- 任务卡写「总周数 = max(课表最大周次, 20)」，同一条又写「照模板（校历取总周数，取不到推算并说明）」。本件按第二句实现（见 §4、§5），
  与上游的 `max(…, 20)` 不同，已列入 §8 待主调度决定的点。

## 1. 请求域与请求清单（与代码逐条对应）

基址 `<base>` = `window.location.origin` + 当前路径里 `/jwglxt` 之前的那一段（没有就是空）+ `/jwglxt`。
本件**只访问用户当前打开的那一个教务主机**（正常是 `jw.swu.edu.cn`），地址里没有写死的主机名或端口。
当前地址的查询串里若有 `vpn-数字-o数字-…` 片段，会原样沿用到教务请求上（`vpnPart`）；没有就不带，不造默认值。

| # | 方法 | 地址（`?` 后为 query） | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `<base>/kbcx/xskbcx_cxXskbcxIndex.html?[vpn&]gnmkdm=N2151&layout=default` | 无 | 课表页取 `#xnm` / `#xqm` 下拉框 | 页面上已有下拉框则不发；取不到学年学期 → 抛「没读到学年学期…」 |
| 2 | POST | `<base>/kbcx/xskbcx_cxXsgrkb.html?[vpn&]gnmkdm=N2151` | `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=` | 取整学期课表（JSON） | HTTP 非 2xx / 网络错误 → 抛错（代码 N 或「连不上教务系统」）；响应里没有 `kbList` 数组 → 抛「没有返回课表数据」 |
| 3 | POST | `<base>/kbcx/xskbcx_cxRjc.html?[vpn&]gnmkdm=N2151` | `xnm=…&xqm=…&xqh_id=<课表行里的校区>` | 取节次时间（作息接口） | 任何失败或非 JSON → `null`，parse.js 回落到内置 14 节表并写 warnings |
| 4 | POST | `<base>/kbcx/xskbcxZccx_cxZcByXnxq.html?[vpn&]gnmkdm=N2154` | `xnm=…&xqm=…` | 取学期周次校历（第 1 周日期、周数） | 任何失败或非 JSON → `null`，开学日推算并写 warnings |

- 请求 1 只在当前页面没有学年学期下拉框时发（`currentTerm`）；页面上的 `selected` 项优先，没有就第一项。
- 请求 3、4 的失败一律吞掉交 `null`（`optionalJson`）：附加接口挂掉不能导致整次导入失败。
- 请求 2 与 1 的失败不吞：没有课表就没有可导入的内容，直接报错给学生看。
- 请求头统一为 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: */*`，
  全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。
- 门户页（当前路径里没有 `/jwglxt/`）与登录页（路径含 `login_slogin.html`）**不发任何请求**，直接抛大白话提示。

`allowHosts` 为 `["jw.swu.edu.cn"]`。注意：`loginUrl` 是门户主机 `i.swu.edu.cn`，它不发请求、不在 `allowHosts` 里；
经学校 WebVPN 打开时，实际的教务主机是 WebVPN 的映射域名，上游没有给出它的主机名，**不在 `allowHosts` 里**（见 §8）。

## 2. 读了什么、交出去什么（逐字段）

**读了什么**

- 课表页 HTML（仅请求 1）：`#xnm` / `#xqm` 两个 `<select>` 的 `option`（跳过 `value` 为空的占位项）的 `value`、`textContent`、`selected`。
- 课表 JSON（请求 2）：顶层 `kbList`（排课行）、`sjkList`（集中实践课）、`qsxqj`（每周起始日）；记录总数字段 `total` / `totalResult` / `totalCount` / `count` 之一（只用于对账）。
- 节次时间 JSON（请求 3）与校历 JSON（请求 4）：原样交出，由 parse.js 按字段名取值（`jcmc`/`jc`、`qssj`/`jssj`；`zs`/`zsmc`、`zrq`/`zcrq`/`rq`/`ksrq`）。

**交出什么**（`JSON.stringify` 的结果，字段白名单挑出，不是整个响应）

| 字段 | 来源 | 说明 |
|---|---|---|
| `term.xnm` / `term.xqm` | 下拉框 `value` | 学年、学期代号 |
| `term.xnmText` / `term.xqmText` | 下拉框 `textContent`（空白压缩） | 学期名取值用 |
| `today` | 本地日期 `YYYY-MM-DD` | 只在学年读不出来时用 |
| `campusId` | `kbList` 里第一个非空的 `xqh_id` | 只用来拼请求 3 |
| `qsxqj` | 课表响应顶层 `qsxqj`，缺失交 `null` | 每周起始日（1=周一…7=周日） |
| `raw.kbList[]` | 每行只留 `kcmc` `xm` `cdmc` `xqj` `jcs` `zcd` `xqh_id` `cxbjmc` `xkbz` | 其它字段一律不带（含 `xsxx` 等学生信息） |
| `raw.sjkList[]` | 每行只留 `kcmc` | 集中实践课只用于提醒里点名 |
| `total` | 记录总数字段之一，取不到 `null` | 与 `kbList` 长度对账 |
| `periodTimes` | 请求 3 的 JSON 原样，取不到 `null` | parse.js 校验后才采用 |
| `calendar` | 请求 4 的 JSON 原样，取不到 `null` | parse.js 取第 1 周日期与周数 |

`cxbjmc`（重修标记）与 `xkbz`（选课备注）只进课程备注（`note`）；`zcd` 交出去但不进备注（周次已经在上课安排里）。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问，也不读 Cookie（会话由浏览器自带）。上游的开场弹窗（`showAlert`）、学年 / 学期选择框（`showSingleSelection`）、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 全部未移植（见 §5）。 |
| 2 | 不外发 | **过**。唯一的 `fetch` 在 `extract.js` 的 `request`，地址全部由当前页面拼成。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，也没有第三方域。 |
| 3 | 请求域可控 | **过**。只访问当前打开的教务主机，`allowHosts` 为 `["jw.swu.edu.cn"]`，不写通配；代码里没有写死的主机名或端口。WebVPN 的映射主机未知，见 §8。 |
| 4 | 只读课表 | **过**。四条请求全部落在 `/jwglxt/kbcx/*`（课表页、课表、节次时间、周次校历），不碰成绩、学籍、缴费。课表响应里夹带的学生信息不带出，白名单之外的字段全部丢弃。 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`，失败返回 `null`）。 |
| 7 | 不写页面 | **过**。读页面下拉框只用 `querySelector` / `options`，不改 DOM、不提交表单、不点击。取课表首页用 `fetch` + `DOMParser` 离线解析，不插入当前页面。 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有上下文路径 `/jwglxt`、菜单号 `N2151` / `N2154`，都是页面上可见的参数。 |

## 4. 与模板 hueb 的差异

模板是批次八已审计的河北经贸大学件（`hueb`）。本件照它的结构复制，差异如下：

1. **门户页与登录页拦截**（`extract.js` 底部）：先判登录页（路径含 `login_slogin.html`，提示「请先登录」），再判门户页（`jwBase()` 返回 `null`，即路径里没有 `/jwglxt/`，提示「请先从办事大厅进入教务系统、打开「学生课表查询」后再点「提取课表」」）。模板此时会退回 `origin + /jwglxt`，在门户主机上必然失败。
2. **WebVPN 查询串**：沿用当前查询串里的 `vpn-…` 片段，找不到就不带。模板没有这一项（它的映射主机是写死的端口，不需要）。没有造默认值（`gdust` 那种 `VPN_DEFAULT` 不照搬）。
3. **字段白名单**：排课行多了 `cxbjmc`、`xkbz` 两个字段（任务卡点名）；`sjkList` 仍只留 `kcmc`。
4. **课程备注**（`remarkPiecesOf` / 载荷组装处）：模板的 `note` 恒为 `null`，这里把 `cxbjmc`、`xkbz` 非空的值按「 | 」连接。同一门课（课名 + 教师）多行的备注按**片段**取并集、按首次出现顺序去重；全空为 `null`。
5. **每周起始日**（`weekdayOf` / `weekStartOf`）：模板的开学日恒回退到周一。这里按 `qsxqj` 回退到「星期几 = qsxqj」的那一天（缺省、非法按周一）。校历与推算都走这一条路。提醒里若回退了，写「（教务设置每周从周X开始，已按此回退）」。
6. **推算文案**：`KIND_ANCHOR` 的规则文字由「所在周的周一」改成「所在周的第一天」（配合 §5 的 qsxqj）；学年读不出时的兜底由「今天的周一」改成「今天所在周的第一天」。
7. **节次时间表**：模板是 13 节，这里换成上游 `SWU/swu.js` 写死的 14 节（`SCHOOL_PERIOD_TIMES`，逐节照抄）。
8. **学校名**：`SCHOOL_NAME` 为「西南大学」，学期名兜底为「西南大学 第 X 学期」。
9. **内置节次表（H3 第一顺位）**：保留模板的 `BUILTIN_PERIOD_TIMES`（空课默认 12 节）。本校表是 14 节，它只在教务节次表不足 12 节时才会命中（同号节次已被本校表覆盖的情况下不会用到）。

**未改动的模板逻辑**（任务卡要求照模板，已用 fixture 覆盖）：`weeksOf` 周次解析（卡片列出的写法 `第7周`、`1~16周`、`1至8周`、`1,3,5周`、全角 `，`、`（单）` 都已有用例）、单/双标记归属、「共 N 周」只剥备注、两阶段合并（`dropExactDuplicates` → `mergeStageOne` → `mergeStageTwo`）、节次解析、校历周数与总周数抬高、H3 逐节补齐、缺教师 / 缺教室的计数提醒、提醒统一限长（`shortName` 20 字 + `warn` 200 字）、`periodTimesOf` 的连续性与递增校验。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart`（开场 `showAlert`） | 删 | 桥能力，宿主负责交互；提示文字改由 extract.js 的报错承担 |
| `selectAcademicYearAndSemester`（两个 `showSingleSelection`） | 删，改为读页面 `#xnm` / `#xqm` | 任务卡与公共说明第 2 条：不弹窗；要别的学期，用户在教务页切换后再提取 |
| `fetchAcademicOptions` 的 5 年窗口 | 删 | 只服务于弹窗选项 |
| `saveCourses` / `saveCourseConfigIfPossible`（`saveImportedCourses` / `saveCourseConfig`） | 删，载荷交给宿主 | 空课由宿主保存；学期配置随载荷的 `terms[0]` 交出 |
| `importPresetTimeSlots`（`savePresetTimeSlots`） | 删，节次时间进载荷 `periodTimes` | 同上 |
| `showToast` / `notifyTaskCompletion` | 删 | 桥能力 |
| `buildCourseConfig` 的 `semesterTotalWeeks = max(maxWeek, 20)` | 改为校历周数优先，课表更晚则抬高（模板逻辑） | 任务卡 §4 的「照模板」；与上游不同，见 §8 |
| `buildCourseConfig` 在没有开学日时整体跳过配置保存 | 改为推算开学日并写 warnings（模板逻辑） | 上游跳过是为了避免整体覆盖把用户已设的开学日清空；这里载荷是新导入的学期，不存在覆盖问题，推算后明示请核对 |
| `firstDayOfWeek` 只放进配置 | 按 qsxqj 回退开学日（`firstDay`） | 手册 §4.3：载荷没有 `firstDayOfWeek` 字段，开学日要与每周起始日对齐 |
| `parseJsonData` 的 `!xm \|\| !cdmc` 严格过滤 | 删，缺教师 / 缺教室照常导入 | 公共说明第 4 条；会静默丢课 |
| `buildCourseRemark` 里的 `zcd`（周次原文） | 删 | 任务卡：周次已经在上课安排里 |
| `parseWeeks` 的单双判断（`trimmedSet.includes('(单)')`） | 换成模板 `weeksOf` | 模板写法覆盖更宽（全角、两段前后标记、「共 N 周」），卡片点名要求 |
| `courses.sort`（按星期 / 节次 / 课名） | 不排序，载荷按首次出现顺序 | 载荷顺序不影响导入；排序由宿主做 |
| 上游 `sectionParts` 只认 `a-b` | 模板的节次解析（`1-2`、`第9-10节`、`1,2`、`0102`、多段） | 模板已有且更宽，写进 §4 |

## 6. 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/swu-port10/mut/` 下做了五份副本（每份只改一处），各跑一次 `check.js`，结果如下。
真实的 `parse.js` 未被改动，之后再跑自检通过。

| 编号 | 改坏哪一处 | 变红的用例 |
|---|---|---|
| m1 | `firstDay = weekdayOf(data.qsxqj)` 改成 `firstDay = 1`（每周起始日不生效） | `calendar-sunday`：`firstDay` 实际 2026-09-07，期望 2026-09-06 |
| m2 | 「(单)1-8周,(双)9-16周」前缀标记的预处理正则改成不匹配（标记不再随段走） | `week-markers`：单双归属错 |
| m3 | 「共 N 周」剥离改成 `/共.*$/`（从「共」删到行尾，会吞掉后面的周次段） | `week-markers`：`1-8周(共8周),9-16周` 后半段丢失 |
| m4 | 内置 14 节表第 5 节 `12:10` 改成 `12:00` | `basic`、`note-merge`、`week-markers`、`calendar-sunday`、`no-calendar-overweek`、`long-warnings`：`periodTimes[4].start` |
| m5 | 课程备注的连接符 `' \| '` 改成 `' / '` | `note-merge`：备注拼接格式 |

五处变异全部被对应用例抓住，还原后 `check.js` 通过。

## 7. fixtures 与自检

共 7 对合成用例（`manifest.json` 的 `fixtures` 与 `fixtures/` 一一对应）。期望值按规范与代码逻辑手工推演后写入，
没有把 parse.js 的输出直接存成期望。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 节次时间取不到 → 内置 14 节（第 5 节 12:10-12:55、第 14 节 21:10-21:55 逐节钉住）；周次写法 `第7周`、`1~16周`、`1至8周`、`1,3,5周`、全角 `2，4，6周`、全角 `1-15周（单）`；校历第 1 周为周一、qsxqj=1 不回退 |
| `note-merge` | 重修 + 选课备注 `重修 \| 选修`；同课同教师两行备注取并集（`重修 \| 选修 \| 英语限选`）且两行周次并成 1-16；只有空白的备注与没有备注字段 → `null`；周次原文不进备注 |
| `week-markers` | `(单)1-8周,(双)9-16周`（1-7 单 + 10-16 双）；`1-15周(单) 共16周`；`1-8周(共8周),9-16周`（9-16 不丢）；`共16周,1-15周(单)`（开头备注不整行丢课） |
| `calendar-sunday` | qsxqj=7，校历第 1 周为周一 2026-09-07 → 开学日回退到周日 2026-09-06，并写提醒；校历 18 周、课表最晚第 18 周，总周数不抬高 |
| `no-calendar-overweek` | 校历取不到、qsxqj 缺省 → 开学日推算为 2026-08-31 并写提醒；课表最晚第 23 周 → 总周数抬到 23 并说明 |
| `api-periods` | 节次时间接口返回信封 `{rows:[…]}` 的 12 节 → 整张采用；课表用到第 13 节，教务表与内置表都没有覆盖 → 按上一节 21:55 顺推为 22:00-22:45 并说明 |
| `long-warnings` | 长课名 + 缺教师 / 缺教室 → 照常导入（`teacher` / `location` 为 `null`），提醒按类型计数并点名课名截到 20 字；集中实践课四门只点名前三门；缺节次与认不出的周次各一行被跳过并说明；7 条提醒每条都不超 200 字 |

`check.js` 结果：见本次交付的自检输出（`RESULT: PASS`）。

**extract.js 桩跑**（Node + `vm`，不联网，桩脚本在 `C:/Users/23703/AppData/Local/Temp/swu-port10/stub.js`）：

- 课表页（有下拉框）：不发请求 1，直接发请求 2、3、4。
- 菜单页（无下拉框，`xtgl/index_initMenu.html`）：先 `GET …/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`，再发 2、3、4。
- WebVPN 形状 `https://<主机>/http/77726476706e69737468656265737421e0f5/jwglxt/kbcx/…?vpn-12-o1-172.16.254.1&layout=default`：
  前缀 `/http/<hex>` 与 `vpn-12-o1-172.16.254.1&` 都保留在每条请求里（如 `…/http/77726476…/jwglxt/kbcx/xskbcx_cxXsgrkb.html?vpn-12-o1-172.16.254.1&gnmkdm=N2151`）。
- 办事大厅 `https://i.swu.edu.cn/`：不发请求，报错「请先从办事大厅进入教务系统、打开「学生课表查询」后再点「提取课表」」。
- 登录页 `…/jwglxt/xtgl/login_slogin.html`：不发请求，报错「当前打开的是登录页。请先登录教务系统…」。
- 交出的数据（场景 2 的桩返回）：`qsxqj` 为 7；`kbList` 行的字段为 `kcmc, xm, cdmc, xqj, jcs, zcd, xqh_id, cxbjmc, xkbz`，
  桩里夹带的 `xsxx`（含学号）与 `zyh` 均未出现；`sjkList` 行只有 `kcmc`。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

- **没有在真机上验证**。没有西南大学账号，也没有在办事大厅登录后的真实页面。请求路径、字段名、节次时间全部以上游脚本为准；桩只证明拼出来的地址与请求体符合上游写法。
- **经 WebVPN 打开时的宿主拦截未验证**。上游没有给出 WebVPN 映射主机的主机名，`allowHosts` 只写了 `jw.swu.edu.cn`。
  若学生经学校 WebVPN 打开教务，实际主机是映射域名，宿主可能会拦截请求。需要真机确认后再决定要不要补主机（补的时候只写那一台，不写通配）。
- **总周数与上游不同**。任务卡第 1 行写「max(课表最大周次, 20)」，第二句又写「照模板（校历取总周数）」，本件按第二句实现：
  校历给出的周数优先（如校历 16 周就导入 16 周），课表更晚时抬高。上游一律至少 20 周。若校历的「周数」字段含了考试周或非教学周，总周数可能偏小（课表会被截断警告）。
- **节次时间接口 `cxRjc` 在本校是否存在未知**。取不到就回落到上游 14 节表（逐节照抄，可能与学校实际作息有出入），并在提醒里写明。
- **`qsxqj` 是否在课表响应顶层**未验证。任务卡写的是顶层，没有就按周一处理，并不会报错。
- **`xqh_id` 缺失时**，请求 3 会带空的 `xqh_id=`，接口可能拒绝；这种情况回落到内置表。
- **周次写法**：卡片列出的写法都有用例。其它认不出的写法（如「周次待定」）会计入「缺周次」并在提醒里点名示例，课不会被静默丢掉。
- **内置 12 节表（H3 第一顺位）**：本校表是 14 节，该表只在教务节次表不足 12 节时才会用到。
- **学期代号**：`termKind()` 优先看学期文本（「一 / 二 / 三」），再看代号 `3` / `12` / `16`。若本校学期文本和代号都不符合，会默认「第一学期」，并在学期名里显示。

## 9. 签名

0x7E7-2023（haiku 移植，2026-10-20）

## 审计修正（2026-10-20）

- **周次前缀标记误吞上一段的后缀**：`parse.js` 的 `weeksOf` 里，前缀写法的正则 `(单)1` 没排除标记前面紧挨着上一段（数字或「周」）的情况，
  把上一段的后缀 (单)/(双) 当成下一段的前缀：`1-8周(单) 9-16周(双)` 被读成 1-16 每周并误报「单双同时出现」；`1-8周(单)9-16周` 被读成 1-15 单周，9-16 周的双周丢了。
- 修正：标记前面紧挨着数字或「周」（中间可有空白）时按后缀归给前一段，只有在段首（字符串开头或分隔符之后）才当后一段的前缀；
  后缀后面直接跟着下一段数字时补一个逗号隔开。`(单)1-8周,(双)9-16周`、`1-8周(单),9-16周(双)`、`1-15周(单) 共16周` 等原有写法行为不变。
- 新增 fixture `week-adjacent`（三个反例；期望值按周次集合手推：1-7 单 + 10-16 双；1-7 单 + 9-16 每周，合并为 1-9 单 + 10-16 每周；1-15 单 + 17-18 每周，合并为 1-17 单 + 18 每周）。版本号 1.0.0 → 1.0.1。
- 已知取舍：`(单)1-8周 (双)9-16周`（前缀写法、段间只有空格）里的 `(双)` 前面紧挨「周」，按上述规则会被当作前一段的后缀；与后缀写法 `1-8周(单) 9-16周(双)` 在形态上无法区分，未见真实样本，按上述规则取后缀。

## 修订 1.0.2（2026-10-27）：无逗号的前置单双标记

- 问题：`(单)1-8周(双)9-16周`（前置标记、两段之间没有逗号）里的第二个标记前面紧挨「周」，被当成上一段的后缀，两段并成「单双都有」，整门课读成 1-16 周每周都上（批次十八 `jxfu`、批次十九 `smu` 审计发现，探测后确认本件同样如此）。
- 修正：`weeksOf` 里夹在两段中间的标记，若它所在的这一段以前置标记开头，就判给下一段；否则仍按后缀归上一段，`1-8周(单)9-16周(双)` 等后置写法不受影响。段间只有空格的 `(单)1-8周 (双)9-16周` 也一并读对。
- 回归：差分测试（`.test/fix-prefix/diff.js`）对 32 种其它周次写法比对修订前后输出，修订前读对的全部一字不差；7 种无逗号前置写法读出的周次与手推一致，整份输出与修订前代码对等价后置写法的输出一致。
- 新增 fixture `weeks-prefix-glued`：期望取修订前代码对等价后置写法 `1-8周(单),9-16周(双)` 的输出（该写法修订前已正确）。
- 版本 1.0.1 → 1.0.2。
