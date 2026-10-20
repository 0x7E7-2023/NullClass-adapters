# 安全审计 —— 西南林业大学（正方教务新版 jwglxt，根路径下的 /jwglxt）

审计对象：`jw-adapters/swfu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `SWFU/swfu.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，2026-10-20 复核仍是最新；
MIT，作者 Haooz；本校脚本最后一次修改 `494c2f3`，2026-10-17，即新增该适配器的那次提交，之后没有改动）。

审计方式：逐行读上游脚本（210 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`（注释）；代码里没有任何绝对地址。
  `manifest.json` 里的 `loginUrl`、`scheduleUrlHint`、`homepage` 是给宿主看的声明，不是请求。
- 网络调用：只有 `extract.js` 里 `request` 函数中的一处 `fetch(url, options)`（`X-Requested-With` 是请求头字符串，不是 XHR 对象）。
  `parse.js` 里没有任何网络调用、没有 `document.` / `window.` / 桥调用。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` /
  `new Function` / `sendBeacon` / `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit` / `setAttribute` 全部无命中。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class`、`async`、`await`、展开符、可选链、`??`、`padStart`、
  `Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(` 全部无命中（`check.js` 同口径通过）。
- 模板残留：检索「西南大学」「小漫君」「91c79f1」「办事大厅」「cxbjmc」「xkbz」「14 节」，代码、manifest、fixtures 零命中
  （仅 `parse.js` 与 `extract.js` 文件头有意写「模板 swu」）。
- 个人信息：`fixtures/` 全部为合成数据（甲 / 乙 / 丙…老师，教学楼 / 综合楼等虚构地点），没有真实姓名与学号。
  `extract.js` 里出现的「学号、姓名」二字只在注释中说明被丢弃的字段。

## 0. 上游情况与任务卡核对

- 上游文件 `SWFU/swfu.js` 的文件头与 `adapters.yaml`（`adapter_name` 西南林业大学教务系统，`maintainer` Haooz，`import_url`
  `https://jw.swfu.edu.cn/jwglxt/xtgl/login_slogin.html`）一致，无需修正。
- 上游全文只有 3 个请求（课表页、校历、课表，都用站内相对路径 `/jwglxt/…`，没有 WebVPN 前缀、没有备用接口、没有菜单号回落），
  不请求节次时间接口（写死 12 节表 `SWFU_TIME_SLOTS`），不拼备注，不合并课程，不读 `qsxqj`。
- 上游课表请求体是 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=&kclxdm=`，比公共说明描述的多一个 `kclxdm=`；以上游代码为准，原样带上。
- 上游文件头注释写 `xqm=3`，但代码读的是下拉框的值；本件同样读下拉框。
- 任务卡建议模板 `hueb`。实际以批次十已审计的 `swu` 为底（同样是 `/jwglxt`，且已含「第1-第8周」修正、「节次时间」措辞统一、
  `qsxqj` 回退、H3 补节），`hueb` 里还留着「作息」「适配器内置」等批次十前的措辞，不适合直接复制。从 `swu` 去掉了门户页文案、
  `vpn-…` 查询串、备注（`cxbjmc` / `xkbz`）；`swu` 本身出自 `hueb`，周次、合并、H3、提醒限长等核心逻辑同源。

## 1. 请求域与请求清单（与代码逐条对应）

基址 `<base>` = `window.location.origin` + 当前路径里 `/jwglxt` 之前的那一段（正常为空；经网关打开时可能是 `/http/<十六进制>`）+ `/jwglxt`。
本件**只访问用户当前打开的那一个教务主机**（正常是 `jw.swfu.edu.cn`），地址里没有写死的主机名或端口。

| # | 方法 | 地址（`?` 后为 query） | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `<base>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 无 | 课表页取 `#xnm` / `#xqm` 下拉框 | 页面上已有下拉框则不发；取不到学年学期 → 抛「没读到学年学期…」 |
| 2 | POST | `<base>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=&kclxdm=`（与上游逐字一致） | 取整学期课表（JSON） | HTTP 非 2xx / 网络错误 → 抛错（「教务系统返回错误（代码 N）」或「连不上教务系统」）；响应不是带 `kbList` 数组的 JSON（如登录过期回登录页）→ 抛「没有返回课表数据」 |
| 3 | POST | `<base>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | `xnm=…&xqm=…&xqh_id=<课表行里的校区>` | 取节次时间（**上游没有这一条**，见 §4） | 任何失败或非 JSON → `null`，parse.js 回落到学校公布的 12 节并写 warnings |
| 4 | POST | `<base>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | `xnm=…&xqm=…` | 取学期周次校历（第 1 周日期、周数） | 任何失败或非 JSON → `null`，开学日推算并写 warnings |

- 请求 1 只在当前页面没有学年学期下拉框时发（`currentTerm`）；页面上的 `selected` 项优先，没有就第一项。
- 请求 3、4 的失败一律吞掉交 `null`（`optionalJson`）：附加接口挂掉不能导致整次导入失败。请求 1、2 的失败不吞：没有课表就没有可导入的内容。
- 请求头统一为 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`、`X-Requested-With: XMLHttpRequest`、`Accept: */*`，
  全部 `credentials: 'include'`（沿用浏览器会话，脚本不读 Cookie）。
- 登录页（路径含 `login_slogin.html`）与还没进到教务的页面（路径里没有 `/jwglxt/`）**不发任何请求**，直接抛大白话提示。

`allowHosts` 为 `[]`：教务主机 `jw.swfu.edu.cn` 就是 `loginUrl` 的主机，不需要另外放行；上游代码里没有任何别的主机。
经网关（如学校 WebVPN）打开时实际主机是映射域名，上游没给出，也没有写进 `allowHosts`（见 §8）。

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
| `raw.kbList[]` | 每行只留 `kcmc` `xm` `cdmc` `xqj` `jcs` `zcd` `xqh_id` | 其它字段一律不带（含 `xsxx` 等学生信息） |
| `raw.sjkList[]` | 每行只留 `kcmc` | 集中实践课只用于提醒里点名 |
| `total` | 记录总数字段之一，取不到 `null` | 与 `kbList` 长度对账 |
| `periodTimes` | 请求 3 的 JSON 原样，取不到 `null` | parse.js 校验后才采用 |
| `calendar` | 请求 4 的 JSON 原样，取不到 `null` | parse.js 取第 1 周日期与周数 |

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问，也不读 Cookie（会话由浏览器自带）。上游的开场弹窗（`showAlert`）、学年 / 学期选择框（`showSingleSelection`）、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 全部未移植（见 §5）。 |
| 2 | 不外发 | **过**。唯一的 `fetch` 在 `extract.js` 的 `request`，地址全部由当前页面拼成。没有 `sendBeacon` / `WebSocket` / `new Image` / 隐藏表单，也没有第三方域。 |
| 3 | 请求域可控 | **过**。只访问当前打开的教务主机，`allowHosts` 为空（教务主机即 `loginUrl` 主机）；代码里没有写死的主机名或端口，不写通配。 |
| 4 | 只读课表 | **过**。四条请求全部落在 `/jwglxt/kbcx/*`（课表页、课表、节次时间、周次校历），不碰成绩、学籍、缴费。课表响应里夹带的学生信息不带出，白名单之外的字段全部丢弃。 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`，失败返回 `null`）。 |
| 7 | 不写页面 | **过**。读页面下拉框只用 `querySelector` / `options`，不改 DOM、不提交表单、不点击。取课表首页用 `fetch` + `DOMParser` 离线解析，不插入当前页面。 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或学号。常量只有上下文路径 `/jwglxt`、菜单号 `N2151` / `N2154`，都是页面上可见的参数。 |

## 4. 与模板的差异

模板是批次十已审计的西南大学件 `swu`（它又出自批次八的 `hueb`）。本件照它的结构复制，差异如下：

1. **没有门户页**：`swu` 的「请先从办事大厅进入」文案去掉，改为「当前页面还不是教务系统的课表页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」」；
   登录页（路径含 `login_slogin.html`）的提示不变。两种情况都不发请求。
2. **去掉 `vpn-…` 查询串**（`vpnPart`）：上游 `swfu.js` 没有 WebVPN 处理，不造；`/jwglxt/` 之前的路径前缀仍原样保留（`jwBase`，对根路径部署等价于空）。
3. **去掉课程备注**：上游没有备注，白名单不再带 `cxbjmc` / `xkbz`，`note` 恒为 `null`（`parse.js` 的备注原料函数与按课程聚合的备注都删了）。
4. **课表请求体**多 `&kclxdm=`，与上游逐字一致（`fetchTimetable`）。
5. **节次时间表**：换成上游 `SWFU_TIME_SLOTS` 的 12 节（`SCHOOL_PERIOD_TIMES`，逐节照抄：
   1 08:20-09:05、2 09:10-09:55、3 10:25-11:10、4 11:15-12:00、5 14:00-14:45、6 14:50-15:35、7 16:05-16:50、8 16:55-17:40、
   9 18:30-19:15、10 19:20-20:05、11 20:25-21:10、12 21:15-22:00）。本校表正好 12 节，所以空课默认 12 节表（`BUILTIN_PERIOD_TIMES`）
   只在教务给的节次时间不足 12 节时才用来补缺的节次；课表排到第 13 节以后按「课间 5 分钟、每节 45 分钟」顺推（`api-periods` 钉住）。
6. **学校名**：`SCHOOL_NAME` 为「西南林业大学」，学期名兜底为「西南林业大学 第 X 学期」；`SCHOOL_TOTAL_WEEKS`（校历取不到时的总周数）注释改成「上游此时不保存学期配置，这里按 20 周并写 warnings」。
7. **文件头**的上游路径、作者、提交，以及「移植改动」逐条重写成本校版本；周次改动条目改写成与上游 `parseWeeks` 的真实差异（见 §5）。

**未改动的模板逻辑**（已用 fixture 覆盖）：`weeksOf` 周次解析、单/双标记归属、「共 N 周」只剥备注、两阶段合并（`dropExactDuplicates` → `mergeStageOne` → `mergeStageTwo`）、
节次解析、校历周数与总周数抬高、H3 逐节补齐、缺教师 / 缺教室的计数提醒、提醒统一限长（`shortName` 20 字 + `warn` 200 字）、`periodTimesOf` 的连续性与递增校验、`qsxqj` 回退。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart`（开场 `showAlert`） | 删 | 桥能力，宿主负责交互；提示文字改由 extract.js 的报错承担 |
| `selectAcademicYearAndSemester`（两个 `showSingleSelection`）与 `fetchAcademicOptions` 的 5 年窗口 | 删，改为读页面 `#xnm` / `#xqm` | 公共说明第 2 条：不弹窗；要别的学期，用户在教务页切换后再提取 |
| `saveCourses` / `saveCourseConfig` / `savePresetTimeSlots` | 删，载荷交给宿主 | 空课由宿主保存；学期配置与节次时间随载荷的 `terms[0]` 交出 |
| `showToast` / `notifyTaskCompletion` / `console.error` | 删 | 桥能力 / 调试输出 |
| `fetchSemesterConfig` 只认 `rq` 的前半 | 扩成 `zrq` / `zcrq` / `rq` / `ksrq` 都认 | 不同部署字段名不一；`rq` 的「起/止」写法由 `isoOfAny` 取前半，与上游一致 |
| 找不到 `zs=1` 时拿数组第一行顶替开学日 | 删，改为推算并说明 | 顶替会让开学日整整晚一周却不出声；`calendar-no-week1` 钉住 |
| 总周数 = 校历数组长度 | 改为校历最大周次（`zs`），课表更晚时抬高并说明 | 完整校历（每周一行）两者相同；缺行时取最大周次更稳，抬高必须写进提醒；校历取不到时上游整个跳过学期配置，这里按 20 周并说明 |
| 校历取不到就跳过学期配置，让用户手动设开学日 | 推算开学日并写 warnings | 载荷必须带开学日；推算值在提醒里明说，请学生核对 |
| `parseJsonData` 要求 `kcmc` `xqj` `jcs` `zcd` 都非空，缺的整行静默丢 | 分类计数写进 warnings，不静默 | 公共说明第 6 条 |
| `teacher` / `position` 缺失填空串 | `null` | 手册 §4.7，不许写「未知」 |
| `parseWeeks`：全局去「第」「周」，「共 N …到行尾」删除 | 换成模板 `weeksOf` | 上游的 `/共\s*\d+\s*.*$/` 会把「1-8周(共8周),9-16周」后半段一起吞掉；段首的单/双标记（`(单)1-8周,(双)9-16周`）上游认不到，会读成每周都上；模板按位置归属 |
| `parseWeeks` 的 `Set` / 展开符 / 箭头函数 | ES5 重写 | CI 的 Rhino 解释模式口径 |
| 上游不合并课程（每行各出一门课） | 两阶段合并 | 连续节次与同节次不同周次本是同一门课的几行；不改任何一周的安排（`merge-consecutive` 钉住） |
| `courses` 的单/节/日过滤静默 `continue` | 同上，计数写进提醒 | 同上 |

## 6. 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/swfu-port11/mut-<编号>/` 下做了八份副本（每份只改一处，改了副本 `manifest.json` 的 `key` 以通过目录名检查），各跑一次 `check.js`。
真实的 `parse.js` 未被改动，之后再跑自检通过；副本已删除。

| 编号 | 改坏哪一处 | 变红的用例 |
|---|---|---|
| m1 | 学校节次表第 5 节开始 `14:00` 改成 `13:00` | `basic` `merge-consecutive` `week-markers` `calendar-sunday` `calendar-no-week1` `no-calendar-overweek` `long-warnings`（凡使用学校表的 7 对） |
| m2 | 学校节次表第 12 节结束 `22:00` 改成 `21:59` | 同上 7 对 |
| m3 | `firstDay = weekdayOf(data.qsxqj)` 改成 `firstDay = 1`（每周起始日不生效） | `calendar-sunday`：开学日期望 2026-08-30 |
| m4 | 「共 N 周」剥离改成 `/共.*$/`（从「共」删到行尾） | `week-markers`：`1-8周(共8周),9-16周` 的 9-16 周被吞 |
| m5 | 去掉区间终点前「第」的归一（`第1-第8周`） | `basic`：机械制图（`第1-第8周`）的周次不对 |
| m6 | 关掉 `dropExactDuplicates`（完全重复行不去重） | `merge-consecutive`：重复的 3-4 行没被去掉 |
| m7 | 空课默认表第 11 节开始 `20:20` 改成 `20:00`（教务节次表不足时补节） | `api-short`：第 11 节补出的时间错 |
| m8 | 校历缺第 1 周时拿第一行顶替（上游写法） | `calendar-no-week1`：开学日不再是推算值、提醒也变了 |

八处变异全部被对应用例抓住，还原后 `check.js` 通过。

## 7. fixtures 与自检

共 9 对合成用例（`manifest.json` 的 `fixtures` 与 `fixtures/` 一一对应）。期望值按规范与代码逻辑手工推演后写入，没有把 parse.js 的输出直接存成期望
（`basic` 的 3 门新增课程、`merge-consecutive`、`calendar-no-week1`、`api-short` 的期望在第一次自检就一次对上）。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 节次时间取不到 → 内置 12 节（第 5 节 14:00-14:45、第 12 节 21:15-22:00 逐节钉住，课表排到第 12 节）；周次写法 `第7周`、`1~16周`、`1至8周`、`1,3,5周`、全角 `2，4，6周`、全角 `1-15周（单）`、`第1-第8周`、`1-8周,10-16周`（两段）；校历 `rq` 为「起/止」写法 → 开学日 2026-08-31、总周数 20 |
| `merge-consecutive` | 同课同日同教室 1-2 与 3-4 → 1-4；完全重复行只留一条；同节次 1-8 与 9-16 周 → 并集 1-16；同时段不同教室各留一块；同名课不同教师分成两门；`total` 与行数一致不出对账提醒 |
| `week-markers` | `(单)1-8周,(双)9-16周`（1-7 单 + 10-16 双）；`1-15周(单) 共16周`；`1-8周(共8周),9-16周`（9-16 不丢）；`共16周,1-15周(单)`（开头备注不整行丢课） |
| `calendar-sunday` | qsxqj=7，校历第 1 周为周一 2026-08-31 → 开学日回退到周日 2026-08-30，并写提醒；校历 18 周、课表最晚第 18 周，总周数不抬高 |
| `calendar-no-week1` | 校历只有第 2、3、20 周 → 不拿第一行顶替，开学日按 9 月 1 日所在周推算为 2026-08-31 并说明；总周数取校历最大周次 20 |
| `no-calendar-overweek` | 校历取不到、qsxqj 缺省 → 开学日推算为 2026-08-31 并写提醒；课表最晚第 23 周 → 总周数抬到 23 并说明 |
| `api-periods` | 节次时间接口返回信封 `{rows:[…]}` 的 12 节 → 整张采用；课表用到第 13 节，教务表与内置表都没有覆盖 → 按上一节 21:55 顺推为 22:00-22:45 并说明 |
| `api-short` | 节次时间接口只给 10 节（带秒）→ 采用前 10 节；课表用到第 11-12 节 → 用空课默认的 20:20-21:05、21:15-22:00 补上并说明；第二学期，校历 `rq` 为「起/止」写法 |
| `long-warnings` | 长课名 + 缺教师 / 缺教室 → 照常导入（`teacher` / `location` 为 `null`），提醒按类型计数并点名课名截到 20 字；集中实践课四门只点名前三门；缺节次与认不出的周次各一行被跳过并说明；每条提醒都不超 200 字 |

**浏览器冒烟**（`D:/NullClass/.test/port-batch11/swfu/smoke.py`：Playwright 起假教务站，全部请求被拦下不联网，跑真实 `extract.js`，再用 Rhino 跑 `parse.js`）11 个场景全部 OK：

- 课表页（有下拉框）：不发请求 1，只发 2、3、4；请求体逐字为 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=&kclxdm=`、`xnm=2026&xqm=3&xqh_id=1`、`xnm=2026&xqm=3`。
- 菜单页（`/jwglxt/xtgl/index_initMenu.html`，无下拉框）：先 `GET …/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`，再发 2、3、4。
- 带网关前缀 `/http/<十六进制>/jwglxt/…`：前缀保留在每条请求里。
- 节次时间与校历接口 404：仍然成功，回落到学校 12 节并推算开学日，提醒如实说明。
- `qsxqj=7`：开学日回退到周日 2026-09-06；节次时间信封 `{rows:[…]}` 被采用；`Array.prototype.filter` / `String.prototype.trim` 被页面改坏也不影响。
- 课表接口回登录页（会话过期）：报「…请重新登录…」；登录页、站点根 `https://jw.swfu.edu.cn/`、学校主站 `https://www.swfu.edu.cn/`：不发任何请求，给大白话提示。
- 响应里夹带的学号、身份证、手机号、`xsxx`、`cd_id`、`cxbjmc` / `xkbz` 均未出现在请求里或交出的数据里。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

- **没有在真机上验证**。没有西南林业大学账号，也没有登录后的真实页面。请求路径、请求体、字段名、节次时间全部以上游脚本为准；
  冒烟用的是假教务站，只证明拼出来的地址、请求体和数据形状符合上游写法。上游脚本本身是 2026-10-17 才新增的（单次提交，无后续修改）。
- **节次时间接口 `cxRjc` 是本件新增的请求**，上游没有。若本校没开这个菜单，请求会失败并被吞掉（交 `null`），回落到上游 12 节表；
  若接口返回了与学校公布的表不同的时间，则以教务的为准（`periodTimesOf` 校验连续、递增、合法才采用）。不想多这一条请求可以整段删掉（`extract.js` 的 `Promise.all` 里第一项），代价是节次时间永远用写死的 12 节表。
- **总周数与上游的计法略不同**：上游用校历数组长度，这里用校历里最大的周次号。每周一行的完整校历两者相同；校历若夹带非教学周行，长度与最大周次号可能不一致，此时课表更晚的周次仍会把总周数抬高并写进提醒。
- **校历取不到时**上游不保存学期配置，这里按 20 周推算并明说；课表最晚周次超过 20 时自动抬高。
- **`qsxqj` 是否在课表响应顶层**未验证（上游不读它）。没有就按周一处理，不会报错。
- **`xqh_id` 缺失时**，请求 3 会带空的 `xqh_id=`，接口可能拒绝；这种情况回落到学校 12 节表。
- **周次写法**：上游认的写法全部接得住；其它认不出的写法（如「周次待定」）计入「缺周次」并在提醒里点名示例，课不会被静默丢掉。
- **经网关（如学校 WebVPN）打开**：上游没有处理，也没给出网关主机名，`allowHosts` 不含网关主机；真机若走网关，宿主可能拦截请求，未验证。
- **学期代号**：`termKind()` 优先看学期文本（「一 / 二 / 三」），再看代号 `3` / `12` / `16`。若本校学期文本和代号都不符合，会默认「第一学期」，并在学期名里显示。

## 9. 签名

0x7E7-2023（sonnet 移植，2026-10-20）

## 审计修正（2026-10-20）

- **周次前缀标记误吞上一段的后缀**：`parse.js` 的 `weeksOf` 里，前缀写法的正则 `(单)1` 没排除标记前面紧挨着上一段（数字或「周」）的情况，
  把上一段的后缀 (单)/(双) 当成下一段的前缀：`1-8周(单) 9-16周(双)` 被读成 1-16 每周并误报「单双同时出现」；`1-8周(单)9-16周` 被读成 1-15 单周，9-16 周的双周丢了。
- 修正：标记前面紧挨着数字或「周」（中间可有空白）时按后缀归给前一段，只有在段首（字符串开头或分隔符之后）才当后一段的前缀；
  后缀后面直接跟着下一段数字时补一个逗号隔开。`(单)1-8周,(双)9-16周`、`1-8周(单),9-16周(双)`、`1-15周(单) 共16周` 等原有写法行为不变。
- 新增 fixture `week-adjacent`（三个反例；期望值按周次集合手推：1-7 单 + 10-16 双；1-7 单 + 9-16 每周，合并为 1-9 单 + 10-16 每周；1-15 单 + 17-18 每周，合并为 1-17 单 + 18 每周）。
- 已知取舍：`(单)1-8周 (双)9-16周`（前缀写法、段间只有空格）里的 `(双)` 前面紧挨「周」，按上述规则会被当作前一段的后缀；与后缀写法 `1-8周(单) 9-16周(双)` 在形态上无法区分，未见真实样本，按上述规则取后缀。
