# 安全审计 —— 江苏大学（正方教务新版，根路径部署，校内直连或经学校 WebVPN 的路径前缀访问）

审计对象：`jw-adapters/ujs/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `UJS/ujs_zhengfang_v9.0.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，2026-10-20 复核仍是最新；
MIT，作者 洛初 Github@gongfuture；该文件自己的最后一次修改是 `80e30cf`，2026-09-23。任务卡写的 `4d7b1cc`（2026-10-07）是整个 `UJS/` 目录的最后一次改动，
那次只加了研究生脚本 `ujs_yjs_v1.0.js`，本校本科脚本没变，**研究生脚本不在本件范围**）。

审计方式：逐行读上游脚本 + 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js` 与 `parse.js` 文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`（注释）；代码里没有任何绝对地址。
  `manifest.json` 里的 `loginUrl`、`scheduleUrlHint`、`homepage` 是给宿主看的声明，不是请求。
  上游脚本里的绝对地址只有三处：`https://jwc.ujs.edu.cn/index/xl_zuo_xi_shi_jian.htm`（注释，说明作息公告页跨域读不了、没有请求）、
  `http://jwxt.ujs.edu.cn/sso/jziotlogin`、`https://webvpn.ujs.edu.cn/http/`（都在注释里），**上游从未请求 jwc 主机**，所以它不进 `allowHosts`。
- 网络调用：只有 `extract.js` 里 `request` 函数中的一处 `fetch(url, options)`（`X-Requested-With` 是请求头字符串，不是 XHR 对象）。
  `parse.js` 里没有任何网络调用、没有 `document.` / `window.` / 桥调用。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` /
  `new Function` / `sendBeacon` / `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit` / `setAttribute` 全部无命中。
- 页面原型被改写的防护：本校教务页面的脚本会改写 `Array.prototype.filter/some/every`（上游为此自己写了 `arrayFilter`）；
  `extract.js`、`parse.js` 都不调用 `.filter(` / `.some(` / `.every(` / `.trim(`（扫描无命中），去首尾空白用正则（`squeeze` / `text`）。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class`、`async`、`await`、展开符、可选链、`??`、`padStart`、
  `Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(` 全部无命中。
- 模板残留：检索「西南」「swu」「小漫君」「办事大厅」「jw.swu」「14 节」「xqh_id」「cxRjc」「vpn」，代码、manifest、fixtures 里零命中
  （仅 `parse.js` 文件头有意写「模板为批次十的 swu，它又来自批次八的 hueb」；`extract.js` 文件头写「上游不带 vpn-… 查询串」）。
- 个人信息：`fixtures/` 全部为合成数据（甲 / 乙 / 丙…老师，教学楼 / 三江楼 / 实训楼等虚构地点），没有真实姓名与学号。
  `extract.js` 里出现的「学号、姓名」二字只在注释里说明被丢弃的字段。

## 0. 上游情况与任务卡核对

- 上游文件 `UJS/ujs_zhengfang_v9.0.js`（1016 行）的文件头写「江苏大学(ujs.edu.cn)」，与 `adapters.yaml` 的 `UJS_01` 一致；`import_url` 为
  `https://jwxt.ujs.edu.cn/sso/jziotlogin`（统一身份认证单点入口），`loginUrl` 照抄。
- 上游是**根路径部署**（`/kbcx/…`，没有 `/jwglxt`）；WebVPN 的映射形态是 `https://webvpn.ujs.edu.cn/http/<十六进制>/kbcx/…`，上游 `buildApiUrl`
  只取 `^/http/[0-9a-f]+` 前缀、不带 vpn-… 查询串。本件的前缀取「当前路径里 `/kbcx/` 或 `/xtgl/` 之前的一段」（`prefixOf`，写法借自 `gdust`），
  覆盖 `/http/<十六进制>`，并在门户 / WebVPN 首页上拒绝发请求（见 §4）。
- 上游**没有请求节次时间接口**：节次时间写死 A / B / C 三套上午、D / E 两套下午、夏 / 冬两套晚上，按教室名挑选后写成每门课的自定义时间。
  我们的载荷只有一份学期级节次时间（移植手册 §4.4），见 §4 第 5 条与 §9。

## 1. 请求域与请求清单（与代码逐条对应）

基址 `<前缀>` = 当前路径里最早出现的 `/kbcx/` 或 `/xtgl/` 之前的那一段（直连为空，WebVPN 下是 `/http/<十六进制>`），地址 = `window.location.origin` + `<前缀>` + 路径。
本件**只访问用户当前打开的那一个教务主机**（直连 `jwxt.ujs.edu.cn`，或 WebVPN 的 `webvpn.ujs.edu.cn`），地址里没有写死的主机名或端口，也没有查询串片段。

| # | 方法 | 地址（`?` 后为 query） | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `<前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151` | 无 | 课表页取 `#xnm` / `#xqm` 下拉框 | 页面上已有下拉框则不发；取不到学年学期 → 抛「没读到学年学期…」 |
| 2 | POST | `<前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=` | 取整学期课表（JSON） | HTTP 非 2xx / 网络错误 → 抛错（代码 N 或「连不上教务系统」）；响应里没有 `kbList` 数组（含回登录页）→ 抛「没有返回课表数据」 |
| 3 | POST | `<前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | `xnm=…&xqm=…` | 取学期周次校历（第 1 周日期、周数） | 任何失败或非 JSON → `null`，开学日推算并写 warnings |

- 请求 1 的地址照上游 `fetchAcademicOptions` 原样（`?gnmkdm=N2151`，**没有** `layout=default`），只在当前页面没有学年学期下拉框时发（`currentTerm`）；页面上的 `selected` 项优先，没有就第一项。
- 请求 3 的失败吞掉交 `null`（`optionalJson`）：附加接口挂掉不能导致整次导入失败。请求 2 与 1 的失败不吞：没有课表就没有可导入的内容，直接报错给学生看。
- **不请求** `xskbcx_cxRjc.html`（节次时间）：上游不请求，节次时间写死在 `parse.js` 里。
- 上游的课表请求与校历请求是并行发的（`Promise.all`），本件串行（先课表后校历），不影响结果。
- 请求头统一为 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: */*`（上游课表请求只带 Content-Type，校历请求带前两个；统一更宽但不改变语义），全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。
- 登录页（路径以 `/sso/jziotlogin` 结尾，或含 `login_slogin.html`、`/cas/`、`/authserver/`）与门户页（路径里找不到 `/kbcx/` 也找不到 `/xtgl/`，如 WebVPN 首页、站点根路径）**不发任何请求**，直接抛大白话提示。
- 无任何宿主交互：夏 / 冬令时不提问（主调度要求，同批次九 `zwu` 口径），`extract.js` 里没有 `__ncSelect` / `__ncCapabilities`。

`allowHosts` 为 `["webvpn.ujs.edu.cn"]`。`loginUrl` 的主机 `jwxt.ujs.edu.cn` 即直连教务主机，同源自动放行；经 WebVPN 打开时页面主机是 `webvpn.ujs.edu.cn`，
上游注释与 `buildApiUrl` 都写了这个入口，所以补上。不写通配、不写 `jwc.ujs.edu.cn`（上游没请求）。

## 2. 读了什么、交出去什么（逐字段）

**读了什么**

- 课表页 HTML（仅请求 1）：`#xnm` / `#xqm` 两个 `<select>` 的 `option`（跳过 `value` 为空的占位项）的 `value`、`textContent`、`selected`。
- 课表 JSON（请求 2）：顶层 `kbList`（排课行）、`sjkList`（集中实践课）、`qsxqj`（每周起始日）；记录总数字段 `total` / `totalResult` / `totalCount` / `count` 之一（只用于对账）。
- 校历 JSON（请求 3）：按字段名取值（`zs`/`zsmc`、`zrq`/`zcrq`/`rq`/`ksrq`）。
- 本地时间：只取今天的 `yyyy-MM-dd`（`localTodayIso`，用于默认令时与推算开学日）。

**交出什么**（`JSON.stringify` 的结果，字段白名单挑出，不是整个响应）

| 字段 | 来源 | 说明 |
|---|---|---|
| `term.xnm` / `term.xqm` | 下拉框 `value` | 学年、学期代号 |
| `term.xnmText` / `term.xqmText` | 下拉框 `textContent`（空白压缩） | 学期名取值用（本校学期文本只有「1」「2」，parse.js 按代号 3 / 12 / 16 判第几学期） |
| `today` | 本地日期 `YYYY-MM-DD` | 默认令时、推算开学日 |
| `qsxqj` | 课表响应顶层 `qsxqj`，缺失交 `null` | 每周起始日（1=周一…7=周日） |
| `raw.kbList[]` | 每行只留 `kcmc` `xm` `cdmc` `xqj` `jcs` `zcd` `cxbjmc` `xkbz` | 其它字段一律不带（含 `xsxx` 等学生信息） |
| `raw.sjkList[]` | 每行只留 `kcmc` `qsjsz` | 集中实践课：课名与起止周，只用于提醒里点名（教师 `jsxm` 不带） |
| `total` | 记录总数字段之一，取不到 `null` | 与 `kbList` 长度对账 |
| `calendar` | 请求 3 的 JSON 只留 `zs` `zsmc` `zrq` `zcrq` `rq` `ksrq`（裸数组，或套一层信封的数组） | parse.js 取第 1 周日期与周数 |

`cxbjmc`（重修标记）与 `xkbz`（选课备注）只进课程备注（`note`）；`zcd` 交出去但不进备注（周次已经在上课安排里）。
桩跑与浏览器冒烟都验证了：夹带的 `xsxx`、学号、身份证号、手机号、`cd_id`、实践课教师 `jsxm` 均未出现在交出的 JSON 里。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问，也不读 Cookie（会话由浏览器自带）。上游的开场弹窗（`showAlert`）、学年 / 学期 / 作息类型选择框（`showSingleSelection`）、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 全部未移植（见 §5）。 |
| 2 | 不外发 | **过**。唯一的 `fetch` 在 `extract.js` 的 `request`，地址全部由当前页面拼成。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，也没有第三方域。 |
| 3 | 请求域可控 | **过**。只访问当前打开的教务主机，`allowHosts` 为 `["webvpn.ujs.edu.cn"]`，不写通配；代码里没有写死的主机名或端口。 |
| 4 | 只读课表 | **过**。三条请求全部落在 `/kbcx/*`（课表页、课表、周次校历），不碰成绩、学籍、缴费。课表响应里夹带的学生信息不带出，白名单之外的字段全部丢弃。 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`，失败返回 `null`）。 |
| 7 | 不写页面 | **过**。读页面下拉框只用 `querySelector` / `options`，不改 DOM、不提交表单、不点击。取课表首页用 `fetch` + `DOMParser` 离线解析，不插入当前页面。 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有菜单号 `N2151` / `N2154`（页面上可见的参数）、夏冬令时换季日（4 月 7 日、10 月 7 日，上游同值）与节次时间表。 |

## 4. 与模板 swu 的差异

模板是批次十已审计的西南大学件（`swu`，它又来自批次八的 `hueb`）。取数壳的「根路径 + WebVPN 前缀」借 `gdust`（批次九已审计）。差异如下：

1. **部署路径与前缀**（`extract.js` 的 `prefixOf` / `jwUrl`）：模板是 `/jwglxt` + `vpnPart` 查询串；本校根路径部署、上游不带 vpn 查询串，所以去掉 `/jwglxt` 与 `vpnPart`，
   前缀取 `/kbcx/`、`/xtgl/` 之前的路径。找不到（门户、WebVPN 首页）返回 `null`，不发请求。
2. **登录页判断**（`onLoginPage`）：模板只认 `login_slogin.html`；本校上游 `isLoginPage` 看路径结尾 `/sso/jziotlogin`（直连与 WebVPN 都是），另加 `/cas/`、`/authserver/` 两个统一认证路径。
3. **课表首页地址**：模板带 `&layout=default`；本校上游没有，照抄上游 `?gnmkdm=N2151`。
4. **删 `cxRjc` 与 `xqh_id`**：上游不请求节次时间，也不用校区号；`KB_FIELDS` 去掉 `xqh_id`，`parse.js` 去掉 `periodTimesOf` / `timeOf` 与「教务节次时间优先」的分支。
5. **节次时间与夏 / 冬令时**（`parse.js` 的 `A_MORNING` … `WINTER_PERIOD_TIMES`、`summerOn`、`morningTypeOf`、`campusTypeOf`、`slotsForPosition`、`differsFromPreset`）：
   - 学期节次时间 = 上游全局预设 `SummerTimeSlots` / `WinterTimeSlots`（A 上午 + 本部下午 + 当季晚上，共 11 节，逐节照抄上游）；
   - 夏 / 冬不提问：按 `today`（今天的日期）所在季节选当季那张表（规则同上游 `whetherSummerTimeSlot`：4 月 7 日起至 10 月 7 日前为夏令时），提醒里写明所用令时与今天日期，并给出另一季的第 5、9 节时间；
   - 上游按教学楼挑上午 / 下午 / 晚上表、写成每门课的自定义时间；我们的载荷没有逐课时间，**不能保留**（手册 §4.4），改为：用上游同一套判定（教室名含「主A楼」「京江」→ A；「三江楼」→ B；「三山楼」「讲堂群」→ C；
     含「北固」→ D 否则 E；教室为空或不在收录楼里不自定义）数出「上课时间与预设不同」的课（合并后的上课安排，按课名去重），汇总写进一条提醒，点名按课名排序的前三门；
   - 上游每次导入弹窗告知「下次切令时的日期」；这里改为按学期日期范围判断：上课周跨过换季日（4 月 7 日 / 10 月 7 日）时提醒「第 N 周（M 月 D 日）起学校换令时」，
     整个学期都在另一个令时时提醒「整体对不上」；每次导入还有一条说明所用令时和来源。
   - 课表用到第 12 节及以后：沿用模板的 H3 补齐（夏令时 21:35 下课，空课默认第 12 节 21:15 接不上 → 顺推；冬令时 21:05 下课，21:15 接得上）。
6. **学期名**（`termKind` / `termName`）：本校学期文本只有「1」「2」，不含汉字「一 / 二 / 三」，`termKind` 自然落到学期代号分支（3 / 12 / 16）；`SCHOOL_NAME` 为「江苏大学」。
7. **实践课提醒**（`PRACTICE_WEEK_LIMIT`）：模板只点名课名；本件点名时带上起止周 `qsjsz`（超 12 字截短），与上游弹窗列出的课名 + 起止周一致，教师不带。
8. **白名单**：排课行去掉 `xqh_id`，其余沿用 swu（含 `cxbjmc` / `xkbz`）；实践课加 `qsjsz`；校历行只留 6 个字段（`slimRows`，沿用 `gdpu` 的写法）。
9. **紧挨的单/双标记归属（主调度追加，模板级缺陷修正）**：模板 `weeksOf` 先做前缀折叠 `(单)1` → `单1`，再做后缀折叠，段间用空格或直接相连时，上一段末尾的后缀 `(单)` / `(双)` 会被当成下一段的前缀
   （`1-8周(单) 9-16周(双)` 单双全错；`1-8周(单)9-16周` 把 9-16 周也读成单周）。本件把顺序对调：先折后缀（标记前紧挨数字或「周」，中间允许空白，折成 `8单,` 并补逗号，免得后一段数字粘上来），
   再折前缀（折完后还留着的标记前面一定不是数字或「周」，才是段首前缀）。按此规则，`1-8周 (双)9-16周`（空白隔开）仍按后缀归前一段。用例 `week-adjacent` 钉住；该用例在旧顺序下变红（见 §6 m9）。
10. **去掉 `trim()`**：`parse.js` 的 `text()` 与 `extract.js` 都用正则去首尾空白。

**未改动的模板逻辑**（已用 fixture 覆盖）：`weeksOf` 周次解析（`第7周`、`1~16周`、`1至8周`、`1,3,5周`、全角 `，`、`（单）`、`第1-第8周`、`(单)1-8周,(双)9-16周`、`1-8周(共8周),9-16周`）、
单/双标记的段首/段尾归属（第 4 节第 9 条已修正模板缺陷）、「共 N 周」只剥备注、两阶段合并（`dropExactDuplicates` → `mergeStageOne` → `mergeStageTwo`）、节次解析、校历周数与总周数抬高、
H3 逐节补齐、缺教师 / 缺教室的计数提醒、提醒统一限长（`shortName` 20 字 + `warn` 200 字）、开学日按 `qsxqj` 回退。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart`（开场 `showAlert`） | 删 | 桥能力，宿主负责交互；提示文字改由 extract.js 的报错承担 |
| `selectAcademicYearAndSemester` / `fetchAcademicOptions`（5 年窗口、手动输入回退） | 删，改为读页面 `#xnm` / `#xqm` | 公共说明第 2 条：不弹窗；要别的学期，用户在教务页切换后再提取 |
| `selectTimeSlot` / `reselectTimeSlot`（智能 / 夏 / 冬三选一 + 确认） | 删，按 `today` 所在季节自动选表，另一季的差异写进提醒 | 主调度要求不提问 |
| `getNextTimeSlotSwitchDate` + 导入后「作息时间提示」弹窗 | 改为 warnings 里的换季提醒（按学期日期范围算） | 载荷的 warnings 就是给学生看的核对提示 |
| `applyCustomTimeToCourses`（逐课 `isCustomTime` / `customStartTime` / `customEndTime`） | **不保留**，改为数偏差课并汇总提醒 | 载荷没有逐课时间（手册 §4.4）；不静默：偏差课的数量与例子都写进 warnings |
| 导入弹窗里「已收录独立作息的楼栋」说明 | 并入偏差提醒的文字 | 同上 |
| `saveCourses` / `saveCourseConfigIfPossible`（`saveImportedCourses` / `saveCourseConfig`） | 删，载荷交给宿主 | 空课由宿主保存；学期配置随载荷的 `terms[0]` 交出 |
| `importPresetTimeSlots`（`savePresetTimeSlots`） | 删，节次时间进载荷 `periodTimes` | 同上 |
| `showToast` / `notifyTaskCompletion` | 删 | 桥能力 |
| `buildCourseConfig` 的 `semesterTotalWeeks` = 校历周数 | 同（校历周数优先，课表更晚则抬高） | 载荷校验要求 endWeek ≤ totalWeeks |
| 取不到开学日期时跳过配置保存 | 改为推算开学日并写 warnings | 上游跳过是为了避免整体覆盖清空用户已设的开学日；这里载荷是新导入的学期，不存在覆盖问题，推算后明示请核对 |
| 校历找不到 `zs===1` 那行时拿 `weekList[0]` 顶替 | 不顶替，直接推算开学日 | 宁可推算并说明，也不写错日期 |
| `firstDayOfWeek` 只放进配置 | 按 `qsxqj` 回退开学日 | 手册 §4.3：载荷没有 `firstDayOfWeek` 字段，开学日要与每周起始日对齐 |
| `buildCourseRemark` 里的 `zcd`（周次原文） | 删（`cxbjmc` / `xkbz` 保留） | 周次已经在上课安排里 |
| `parseWeeks`（`(\d+)-(\d+)周` / `^(\d+)周`，逗号分段，段内含「(单)」「(双)」） | 换成模板 `weeksOf` | 模板写法覆盖更宽（全角、单双标记前后缀、「共 N 周」、「第」），上游接受的写法都接得住 |
| `jcs.split('-')` 只认 `a-b` | 模板的节次解析 | 模板已有且更宽 |
| `arrayFilter`（绕开页面改写的 `filter`） | 不调用 `filter` / `some` / `every` / `trim` | 与上游同一目的，用普通循环与正则 |
| `courses.sort`（按星期 / 节次 / 课名） | 不排序，载荷按首次出现顺序 | 载荷顺序不影响导入；排序由宿主做 |
| 上游缺教师 / 缺教室 | 照常导入（教师 / 地点为 `null`）并按类型汇总进 warnings | 上游已放宽（不丢课）；我们补上汇总提醒 |

## 6. 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/ujs-port11/mut/` 下做了副本（每份只改一处 `parse.js`），各跑一次 `check.js`；真实的 `parse.js` 未被改动，之后再跑自检通过。

| 编号 | 改坏哪一处 | 变红的用例 |
|---|---|---|
| m1 | 冬令时本部下午第 7 节开始时间 `15:30` 抄成 `15:20` | `winter-buildings`、`smart-winter-boundary`、`summer-term-mismatch` |
| m2 | `differsFromPreset` 恒返回 `false`（上课时间偏差判定失效） | `winter-buildings`、`summer-term-mismatch`、`long-warnings` |
| m3 | `campusTypeOf` 一律返回 `'E'`（北固校区判定失效） | `winter-buildings`、`long-warnings` |
| m4 | `summerOn` 的 `code < 1007` 改成 `code <= 1007`（10 月 7 日当天算夏令时） | `smart-winter-boundary` |
| m5 | 跨换季日的判断 `if (seasonAtStart !== seasonAtEnd)` 改成 `if (false)` | `basic`、`winter-buildings`、`smart-winter-boundary`、`week-markers`、`long-warnings`、`calendar-sunday`、`no-calendar-overweek` |
| m6 | `var firstDay = weekdayOf(data.qsxqj)` 改成 `var firstDay = 1`（每周起始日不生效） | `calendar-sunday` |
| m7 | `morningTypeOf` 里三江楼并入 A 楼（B 楼没有独立上午表） | `winter-buildings`、`summer-term-mismatch`、`long-warnings` |
| m8 | `summerOn` 的 `code >= 407` 改成 `code > 407`（4 月 7 日当天算冬令时） | `calendar-sunday` |

| m9 | `weeksOf` 里把后缀折叠与前缀折叠的顺序换回模板的旧顺序（先前缀后缀，不补逗号） | `week-adjacent`（五行里前三行块数、单双、端点全错） |

九处变异全部被对应用例抓住，还原后 `check.js` 通过（`RESULT: PASS`）。「共 N 周」剥离沿用 swu 已审计的代码，本件 `week-markers` 用例钉住了它的结果，未重复做变异。

## 7. fixtures 与自检

共 9 对合成用例（`manifest.json` 的 `fixtures` 与 `fixtures/` 一一对应）。期望值由独立的生成脚本（`.test/port-batch11/ujs/gen_fixtures.py`，不读 parse.js 的输出）按上游节次表与规则**手工推演**写入（节次时间逐节手抄上游，周次、块、提醒文字按规则写，
没有把 parse.js 的输出存成期望），第一次比对即全部一致。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 今天在夏令时 → 预设 11 节夏表逐节钉住（提醒带冬令时的第 5、9 节）；校历 `rq` 斜杠前取 2026-08-31、共 20 周；学期文本「1」+ 代号 3 → 第一学期；重修 + 选课备注进 note；缺教师、缺教室照常导入；主A楼 / 京江（A 楼 + 本部）不计偏差；上课周跨 10 月 7 日的换季提醒（第 6 周）；实践课带起止周 |
| `winter-buildings` | 冬令时预设逐节；三江楼 / 讲堂群 / 北固主A楼计入「上课时间不一样」提醒，三山楼 1-2 节、北固非收录楼、空教室不计；机械制图 1-2 与 3-4 节合并成 1-4 后才比较（第 4 节下课 11:50 ≠ 11:40）；三江楼 11-12 节不在表内不计偏差并触发 H3（冬令时 21:05 下课，第 12 节取空课默认 21:15-22:00）；第二学期跨 4 月 7 日（第 7 周）；点名按课名排序取前三 |
| `smart-winter-boundary` | today=2026-10-07 恰为冬令时起始日 → 冬令时；开学在夏令时、今天在冬令时 → 换季提醒写「换季之前」；`qsxqj` 缺省按周一；校历 18 周 |
| `summer-term-mismatch` | 夏季学期（学期文本「3」+ 代号 16）整个学期在夏令时，今天（3 月）在冬令时、按冬令时导入 → 「整体对不上」提醒（不是跨换季）；总周数取校历 4 周；按冬令时比较，三江楼 3-4 节算偏差；缺教室照常导入 |
| `week-markers` | `(单)1-8周,(双)9-16周`（单周 1-7 + 双周 10-16）；`1-15周(单)共16周`；`1-8周(共8周),9-16周`（9-16 不丢，合成 1-16）；`共16周,1-15周(单)`；`第1-第8周`；`2-16(双周)` |
| `week-adjacent` | 紧挨的单/双标记：`1-8周(单) 9-16周(双)` → 单 1-7 + 双 10-16；`1-8周(单)9-16周` → 单周 1-9 + 每周 10-16（等价于单 1-7 + 9-16 每周，极大段写法）；`1-16周(单) 17-18周` → 单周 1-17 + 第 18 周（等价于单 1-15 + 17-18 每周）；`1-8周,(双)9-16周` 逗号后是前缀；`1-8周 (双)9-16周` 空白隔开仍按后缀归前一段（双 2-8 + 9-16 每周） |
| `long-warnings` | 五门超 20 字课名分别缺教师 / 缺教室 / 偏差，点名统一截到 20 字；体育教师教室都缺；偏差课 4 门只点名排序后的前三门；四门超长实践课（起止周超 12 字截短）只点名前三门并加「等」；缺节次、周次认不出（点名「待定」）各一行被跳过；记录总数 13 条实际 8 行 → 对账提醒；10 条提醒每条 ≤200 字 |
| `calendar-sunday` | `qsxqj="7"`（字符串）→ 校历周一 2027-02-22 回退到周日 2027-02-21 并写进提醒；today=2027-04-07 恰为夏令时起始日 → 夏令时；开学在冬令时 → 换季提醒写「换季之前」；周日（dayOfWeek 7）的课 |
| `no-calendar-overweek` | 校历取不到 → 按「第一学期 = 9 月 1 日所在周的第一天」推算 2026-08-31 并提醒；课表最晚第 23 周 → 总周数抬到 23；夏令时 21:35 下课，第 12-13 节顺推（21:40-22:25、22:30-23:15），第 14 节越过 23:59 不补并说明 |

`check.js` 最后一行：`RESULT: PASS`（9 对 fixture 全部 MATCH）。

**extract.js 桩跑与浏览器冒烟**（Playwright 假教务站，不联网，脚本在 `.test/port-batch11/ujs/smoke.py`，`python -I -X utf8 smoke.py all`，11/11 OK）：

- 直连课表页（`https://jwxt.ujs.edu.cn/kbcx/…?gnmkdm=N2151`）：页面上有下拉框，不发请求 1，只发请求 2、3；路径都是 `/kbcx/…`，无前缀、无查询串片段，没有 `cxRjc`；课表体 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=`。
- 直连菜单页（`/xtgl/index_initMenu.html`）：先 `GET /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151`（查询串恰好是 `gnmkdm=N2151`），再发 2、3。
- WebVPN（`https://webvpn.ujs.edu.cn/http/<hex>/kbcx/…` 与 `…/http/<hex>/xtgl/…`）：前缀 `/http/<hex>` 保留在每条请求里，不带 `vpn-…` 查询串。
- 登录页（直连与 WebVPN 的 `/sso/jziotlogin`）、WebVPN 首页 `https://webvpn.ujs.edu.cn/`、站点根路径：不发请求，报「当前打开的是登录页…」或「请先登录并进入教务系统…」。
- 课表接口回登录页（会话过期）：报「教务系统没有返回课表数据…登录状态可能已失效」。
- 页面原型被改坏（`filter` / `some` / `every` 实参颠倒、`trim` 去掉所有空白）：`extract.js` 和 `parse.js` 都在页面里跑（`new Function('__ncInput', …)`，宿主同款），结果与 Rhino 逐字段一致。
- 提问桥：宿主声明有提问能力时，`extract.js` 也不调用 `__ncSelect`，交出的数据里没有 `season`。
- 交出的数据：`kbList` 行只有 8 个白名单字段，`sjkList` 行只有 `kcmc` + `qsjsz`，桩里夹带的 `xsxx`、学号、身份证号、手机号、`cd_id`、`jsxm` 均未出现。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

- **没有在真机上验证**。没有江苏大学账号，也没有在统一身份认证登录后的真实页面。请求路径、字段名、节次时间全部以上游脚本为准；桩与冒烟只证明拼出来的地址、请求体、交出的形状符合上游写法。
- **逐课上课时间丢失（载荷限制）**：上游给 B 楼（三江楼）、C 楼（三山楼、讲堂群）和北固校区的课单独设了上下课时间（上午第 3-4 节、北固下午第 7-8 节与预设不同，差 10-20 分钟）。
  本件的节次时间只能是预设那一份（A 楼上午 + 本部下午），这些课在应用里显示的上课时间会与学校实际差 10-20 分钟。已经用 warnings 点名数量与例子，没有静默；要做到逐课精确需要载荷支持逐课时间，不在本批范围。
- **教室名匹配沿用上游的猜测**：上游自己写了「api 不再返回『本部』这类校区前缀，北固的返回格式也未确认」，所以「含『北固』→ 北固，其余一律本部」只是上游的权宜写法；
  上游还注释说教务返回的是「京江2号楼2101」这类名称。真实教室名的格式我们没见过，偏差提醒的覆盖面取决于教室名里是否真有这些关键字。
- **WebVPN 入口未验证**：`/http/<十六进制>` 前缀的拼法照上游 `buildApiUrl`，上游从不带 vpn-… 查询串；若真实 WebVPN 需要别的查询串或走 `/https/` 前缀，本件对 `/https/<主机>` 前缀也能保留（前缀取 `/kbcx/` 之前整段），但查询串不会补。
  经 WebVPN 打开时宿主是否放行 `webvpn.ujs.edu.cn` 需要真机确认（已写进 `allowHosts`）。
- **夏 / 冬令时默认按今天判断**：与上游「智能选择」同规则；学生在学期初（如 8 月导入新学期）选夏令时，10 月 7 日换季后需要自己改节次时间或重新导入（提醒里已写第几周起换季）。
- **总周数**：取校历周数（上游同）；校历含考试周 / 假期周时偏大，只是课表周数上限，多几周空白无害。
- **`qsxqj` 是否在课表响应顶层**未验证（上游就是这么读的）；没有就按周一，不报错。
- **学期代号**：本校学期文本只有「1」「2」，`termKind` 靠代号 `3` / `12` / `16` 判断；若代号不符会默认「第一学期」并显示在学期名里。
- **任务卡要求的 `analysis.md`**：开工前的分析本应写进 `.test/port-batch11/ujs/analysis.md`，但写文件被工具拒绝（代理环境禁止写 `.md` 报告文件），分析内容已并入最终报告与本文档。

## 9. 签名

0x7E7-2023（sonnet 移植，2026-10-20）
