# 广州华立学院（hualixy）移植审计

**签名：0x7E7-2023（haiku 移植，2026-10-20）**

## 0. 出处

- 上游文件：`HUALIXY/hualixy.js`，上游仓库 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，MIT，作者（adapters.yaml 的 maintainer）**小漫君**。
- 上游快照：`19a65bf07a3e998fcfc69cee692387cdc0523c1a`（2026-10-19 拉取，2026-10-20 复核仍是最新）。
- 本校脚本最后一次修改：`80e30cf`（2026-09-23）。
- 上游 `adapters.yaml` 登记：`adapter_id HUALIXY_01`，`import_url https://jw.hualixy.edu.cn/sso/ddlogin`，`category BACHELOR_AND_ASSOCIATE`。
- 模板：批次八的 `hueb`（同属正方新版 jwglxt，已审计）。本件只复制了它的 manifest 骨架与 parse.js 的周次、合并、提醒基础，取数层按上游重写。
- 本件是**本校的首次移植**，没有旧版本可比。我们没有广州华立学院的教务账号，**没有在真机上跑过**，见第 8 节。

## 1. 请求域与请求清单（与代码逐条对应）

上游 `hualixy.js` 没有写死任何主机名：所有地址由 `buildApiUrl(modulePath, gnmkdm)` 拼出，前缀取 `window.location.origin`，
路径固定为 `/jwglxt` + 接口路径，WebVPN 的 `/http/<hex>` 前缀原样保留。上游文件头与提示文字里出现的 `jw.hualixy.edu.cn` 只是注释和弹窗文字，不是请求。

本件同样只请求**当前页面所在的教务主机**：地址由 `window.location.origin` 拼成（`extract.js` 的 `originOf()`、`jwBase()`），
没有写死的主机名或端口。`allowHosts` 为空数组：统一认证页 `/sso/ddlogin` 与教务在同一个主机上，不需要额外放行任何域。不写通配。

菜单号：上游 `GNMKDMS = ["N2151", "N253508"]`（`hualixy.js` 第 18 行）。本件照搬顺序，`tryMenus()` 逐个尝试。

| 谁 | 方法 | 地址（`<base>` = origin + 路径前缀 + `/jwglxt`，`[vpn片段&]` 见下） | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js `currentTerm()` | GET | `<base>/kbcx/xskbcx_cxXskbcxIndex.html?[vpn片段&]gnmkdm=<N2151 或 N253508>&layout=default` | 读课表页的 `#xnm` / `#xqm` 下拉框，取学年学期。**页面上已有这两个下拉框时跳过** | 两个菜单号都失败 → 报「没读到学年学期…」 |
| extract.js `fetchTimetable()` | POST | `<base>/kbcx/xskbcx_cxXsgrkb.html?[vpn片段&]gnmkdm=<N2151 或 N253508>`，体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数、`qsxqj`。请求体与上游逐字一致（`xnm` / `xqm` 改为读下拉框的值，参数经 `encodeURIComponent`） | 两个菜单号都失败 → 报错（非 2xx 报「教务系统返回错误（代码 N）」；返回登录页报「登录状态已失效」；非课表 JSON 报「没有返回课表数据」）。**必需，失败就不导入** |
| extract.js 主流程 | POST | `<base>/kbcx/xskbcx_cxRjc.html?[vpn片段&]gnmkdm=<同课表的菜单号>`，体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=&kclxdm=` | 取节次时间。上游也请求了这条（`fetchAndParseTimeSlots`，`hualixy.js` 第 268 行起），请求体照上游（**不带** `xqh_id`） | 交 `null`，parse.js 整张改用空课默认的 12 节表并写 warnings |
| extract.js 主流程 | POST | `<base>/kbcx/xskbcxZccx_cxZcByXnxq.html?[vpn片段&]gnmkdm=<同课表的菜单号>`，体 `xnm=…&xqm=…` | 取学期周次校历，定开学日与总周数（上游 `fetchSemesterStartDate`，第 233 行起，取 `rq` → `zcrq` → `ksrq`） | 交 `null`，parse.js 推算开学日并写 warnings |

说明：

- **校历与节次时间用课表成功时的同一个菜单号**（任务卡要求；上游校历也是在这两个菜单号里试，但这里不再独立重试，避免校历与课表来自不同菜单）。
- `[vpn片段&]`：当前查询串里有 `vpn-数字-o数字-…` 片段时原样沿用（`vpnPart()`），没有就不带。**不写默认值**（与 gdust 不同：gdust 的片段是那所学校的固定值，本校没有可靠的默认值）。
- 两条附加请求（节次时间、校历）走 `optionalJson()`：任何失败（网络错误、非 2xx、非 JSON）都吞成 `null`，由 parse.js 回落并写进 warnings，**绝不因为附加接口挂掉就导不进课表**。
- 没有任何写请求，没有任何第三方域。

### 1.1 不发请求的情形

- 路径不在 `/jwglxt/` 下（统一认证页 `/sso/ddlogin`、门户页等）：`notInJwglxt()` 为真，同步抛出「请先登录教务系统，再点「提取课表」」，**不发任何请求**。
- 路径含 `login_slogin.html`（正方直登页）：同上，不发请求。
- 页面上已有学年学期下拉框：不发 GET 首页请求。

## 2. 读了什么、交出什么（逐字段）

**读（只读，不写页面）**

| 来源 | 字段 | 用途 |
|---|---|---|
| 当前页面或课表首页 HTML | `#xnm` / `#xqm` 的 `option`：`value`、`textContent`、`selected` | 学年学期（被 `selected` 标的优先，没有就第一项，跳过空 value 占位项） |
| 课表 JSON 顶层 | `kbList`（数组，必须有）、`sjkList`、`qsxqj`、记录总数（`total` / `totalResult` / `totalCount` / `count` 任一，可能没有） | 课表、集中实践课、每周起始日、对账 |
| `kbList` 每行 | 只读 `kcmc` `xm` `cdmc` `xqj` `jcs` `zcd` | 课名、教师、教室、星期、节次、周次 |
| `sjkList` 每行 | 只读 `kcmc` | 集中实践课课名（只用于提醒） |
| 节次时间 JSON | 裸数组，或 `{ data: [...] }`（`pickRows()` 统一剥） | 每行只读 `jcdm`（没有再读 `jcmc`）、`qssj` / `jssj`（没有再读 `sksj`） |
| 校历 JSON | 裸数组（或 `{ data: [...] }`） | 每行只读 `zs` `zsmc` `zrq` `zcrq` `rq` `ksrq` |

**交出（`extract.js` 返回的 JSON 字符串，只含以下键）**

| 键 | 内容 |
|---|---|
| `term` | `{ xnm, xqm, xnmText, xqmText }`：学年学期的值与显示文字（下拉框的文字） |
| `gnmkdm` | 课表成功时用的菜单号（`N2151` 或 `N253508`），只给冒烟和审计看，parse.js 不用 |
| `today` | 本机当天日期 `yyyy-MM-dd`（推算用） |
| `qsxqj` | 课表响应顶层的 `qsxqj` 原值（1=周一…7=周日），缺省为 `null`；parse.js 做合法性判断 |
| `raw.kbList` | 数组，每行只含 `kcmc` `xm` `cdmc` `xqj` `jcs` `zcd` 六个字段（白名单，`pickFields()`） |
| `raw.sjkList` | 数组，每行只含 `kcmc` |
| `total` | 记录总数（没有则 `null`） |
| `periodTimes` | 节次时间行数组（每行只含 `jcdm` `jcmc` `qssj` `jssj` `sksj`），取不到或为空则 `null` |
| `calendar` | 校历行数组（每行只含 `zs` `zsmc` `zrq` `zcrq` `rq` `ksrq`），取不到则 `null` |

**不交出**：`xsxx`（学生信息：学号、姓名、学院等）、`xqh_id`（校区号；任务卡的节次时间请求不带它，所以不留）、课表响应里的其它任何字段。
这些字段在 stub 桩跑中以 `STUB-ID-0001` 等假学号注入响应，输出里检不到（见第 7 节）。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有读取或发送账号、密码、令牌；没有读 `localStorage` / `sessionStorage` / Cookie。`credentials: 'include'` 只让 WebView 按同源规则带会话 Cookie，脚本既不读它也不外发。上游的 `showAlert` 开场提示、两个学年学期选择框（`showSingleSelection`）、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` / `showToast` / `notifyTaskCompletion` 都没有移植 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js`，地址由 `window.location.origin` 拼成。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单。只有 `DOMParser` 离线解析课表首页 HTML，不插入当前页面 |
| 3 | 请求域可控 | **过**。请求主机只有当前教务主机。`allowHosts: []`，不写通配。代码里没有写死的主机名或端口（自检脚本的 hosts 扫描通过） |
| 4 | 只读课表 | **过**。请求的接口只有 `/jwglxt/kbcx/` 下四个：课表页、课表、节次时间（cxRjc）、学期周次校历（cxZcByXnxq）。没有成绩、学籍、个人信息、缴费接口。课表响应里夹带的学生信息一律不带出（见第 2 节） |
| 5 | 不埋点 | **过**。没有统计、上报、遥测、图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf()`） |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的 `option`，不写 DOM，不改表单，不触发提交或点击 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。脚本里的常量只有上下文路径 `/jwglxt`、两个菜单号（页面上可见的参数）与提示文字 |

## 4. 与模板 hueb 的差异（逐条）

1. **菜单号两个依次尝试**：hueb 只用 `N2151`。本件 `GNMKDMS = [N2151, N253508]`，`tryMenus()` 在课表首页与课表两条请求上回退；校历与节次时间跟随课表成功的菜单号。
2. **附加请求的菜单号**：hueb 的校历用 `N2154`，本件校历与节次时间都跟随课表菜单（上游校历也是在 N2151 / N253508 里试，不是 N2154）。
3. **节次时间请求体**：hueb 带 `xqh_id`，本件不带（任务卡要求），请求体 `xnm / xqm / kzlx=ck / xsdm= / kclbdm= / kclxdm=`，与上游一致。
4. **节次时间内置表**：hueb 有一张上游 13 节 `TimeSlots`；本件**上游没有内置表**，取不到时整张改用空课默认的 12 节表（`BUILTIN_PERIOD_TIMES`，`:core:model` 的 DefaultPeriodTimes），并写「没能从教务系统读到节次时间，已按空课默认的节次时间导入，请在学期管理里核对」。
5. **节次时间字段**：hueb 读 `jcmc` / `jc`、`qssj` / `jssj`；本件读 `jcdm`（没有再 `jcmc`）、`qssj` / `jssj`（没有再 `sksj`，`sksj` 形如 `08:00~08:45`，分隔符 `~ - — 至 到`）。`qssj` 带秒（`08:00:00`）由 `timeOf()` 截成 `HH:mm`。
6. **外壳只剥一次**：hueb 在 parse.js 的 `rowsIn()` 里按键名递归找行数组。本件的外壳（裸数组 / `{ data: [...] }`）只在 extract.js 的 `pickRows()` 判断一次，「有没有数据」与「挑字段」用同一份结果；parse.js 的 `periodTimesOf()` 只收数组，`calendarInfo()` 也只收数组。
7. **登录 / 门户页判断**：hueb 只认 `login_slogin.html`。本件认「路径不在 `/jwglxt/` 下」（统一认证页 `/sso/ddlogin`）与 `login_slogin.html`，两者都**不发请求**直接提示。
8. **WebVPN 查询串片段**：hueb 用 `vpn-…` 片段并带默认值。本件只沿用当前查询串里的片段，**没有默认值**。
9. **每周起始日**：hueb 把开学日回退到周一（`mondayOfIso`）。本件回退到 `qsxqj` 指定的那一天（`dayOnOrBefore(iso, firstDowOf())`），缺省或非法按 1。校历路径与推算路径都适用。
10. **推算规则文字**：`KIND_ANCHOR.rule` 改为 `label` + 「往前回退到周X」（`estimateStart()`），因为回退的星期可能不是周一。
11. **输出多两个键**：`gnmkdm`、`qsxqj`（hueb 没有）；`raw.kbList` 不带 `xqh_id`，顶层不再有 `campusId`。
12. **请求头**：每个请求统一带 `Content-Type`、`X-Requested-With`、`Accept`（`request()`）。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart` 开场弹窗（`showAlert`） | 删 | 空课不用桥弹窗；提示文字不移植 |
| `selectAcademicYearAndSemester`：两个选择框（`showSingleSelection`） | 改为读页面下拉框 | 公共说明第 2 条：不弹窗问学年学期；要别的学期，用户在教务页切换后再点「提取课表」 |
| `saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` | 删 | 空课由宿主保存，适配器只交载荷 |
| `showToast` / `notifyTaskCompletion` | 删 | 同上 |
| `parseWeeks` 只认 `/(\d+)-(\d+)周/` 与 `/^(\d+)周/` | 换成模板的 `weeksOf()` | 上游认不出 `1-16(单周)` 写法，整段周次会静默变空（那样课就丢了）；且没有处理前缀单双标记与「共 N 周」 |
| `parseJsonData` 的 `startSection > endSection` 等 | 换成模板的 `sectionsOf()` 与校验 | 上游 `jcs.split('-')` 认不出 `第9-10节`、`0102`、`1,2` 等写法 |
| 上游没有合并课程 | 模板的两阶段合并（`dropExactDuplicates` → `mergeStageOne` → `mergeStageTwo`） | 公共说明：合并与提醒是本批统一口径 |
| `buildCourseConfig` 的 `semesterTotalWeeks: Math.max(maxWeek, 20)` | 总周数取校历周数（校历给得出时），否则 20，课表更晚则抬高 | **与上游口径不同，见第 9 节第 2 条** |
| `firstDayOfWeek`（`Number(jsonData.qsxqj)`，非法按 1）写进 config | 交 `qsxqj` 给 parse.js，回退开学日 | 手册 §4.3：`firstDay` 是「星期几 = qsxqj」那一天 |
| 上游 `parseJsonData` 只要求 `kcmc` / `xqj` / `jcs` / `zcd` | 同样只要求这四项；缺教师 / 缺教室照常导入（null） | 与上游一致（上游本来就不丢缺教师或缺教室的课）；公共说明第 4 条 |
| `fetchSemesterStartDate` 的 `firstWeekObj` 取法 | 同：`zs` / `zsmc` 等于 1 的那行，找不到不顶替第一行 | 上游找不到第 1 周时拿第一行顶替，本件不顶替，宁可推算也不写错日期（`calendarInfo()` 只认 `week === 1`） |

## 6. 变异测试记录

在临时副本（`C:/Users/23703/AppData/Local/Temp/hualixy-port10/m_*`）上改 parse.js，每次只改一处，跑 `check.js`，然后丢弃副本；真实文件未动。

| 改坏哪一处 | 哪条用例变红 | 失败内容 |
|---|---|---|
| `spanOf()` 删掉 `sksj` 拆分分支（`var parts = null;`） | `period-sksj` | 节次时间整张改用 12 节默认表，第 4 节 11:40 ≠ 15:15，第 5 节不再顺推 |
| `periodTimesOf()` 的 `firstDow` 固定为 1（`var firstDow = 1;`，即忽略 `qsxqj`） | `calendar-sunday` | 开学日 2026-09-07 ≠ 期望 2026-09-06（周日） |
| `weeksOf()` 的「共 N 周」剥离改成上游式 `/共.*$/`（删到行尾） | `calendar-sunday` | 编译原理 `1-8周(共8周),9-16周` 的 9-16 周被吞，endWeek 8 ≠ 16 |
| `periodTimesOf()` 删掉「节次时间递增不重叠」判断（`if (minutesOf(slots[k].start) < lastEnd) return null;`） | `period-overlap` | 两节重叠的教务表被采用（第 2 节 08:40 ≠ 08:55），本应整张弃用 |

以上四处全部变红，说明对应逻辑都有用例钉住。还原后真实文件跑自检通过（见第 7 节）。

## 7. fixtures 与自检

**fixtures（7 对，全部手工推演期望后比对）**：

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 节次时间没取到 → 空课默认 12 节 + 提醒；校历没取到 → 推算 2026-08-31、总周数 20；课表排到第 15 节 → 第 13、14 节顺推，第 15 节越过 23:59 不补并说明；单双周、无教师、无教室、完全重复行、集中实践课 |
| `period-api` | 教务节次时间带秒（`08:00:00`）、节次号在 `jcdm` → 用教务的 4 节；课表用到第 5、6 节 → 空课默认表同号节次接得上，直接用默认时间并说明；1-2 与 3-4 节合并；校历第 1 周为周一，不回退 |
| `period-sksj` | 教务节次时间只给 `sksj`（`~`、`-`、`至` 三种分隔符），节次号在 `jcmc` → 照样读出 4 节；第 5 节空课默认表（14:00）早于第 4 节下课（15:15）接不上 → 顺推 15:20-16:05 并说明；第二学期，开学日按 2 月 20 日推算回退到周一 |
| `period-overlap` | 教务节次时间两节重叠 → 整张弃用，改用空课默认 12 节并提醒 |
| `calendar-sunday` | `qsxqj = 7`，校历第 1 周为周三 2026-09-09 → 回退到周日 2026-09-06；单双周三种写法（前缀 `(单)1-8周,(双)9-16周`、后缀 `1-15周(单) 共16周`、`1-8周(共8周),9-16周`）各自正确归属 |
| `no-calendar-overweek` | 校历与 `qsxqj` 都没有 → 推算 2026-08-31（周一）；课表最大周次 21 → 总周数抬到 21 并说明；`(1)` 教学班序号与 `(3组)` 备注各提醒一条，不当周次 |
| `long-warnings` | 长课名（23 字）+ 缺教师 / 缺教室 → 不丢课（null），提醒点名的课名截到 20 字；四门超长集中实践课 → 只点前三门、按类型汇总、整条不超 200 字 |

`check.js` 结果：7 对全部 MATCH；完整自检输出见本次移植报告。

**extract.js 桩跑**（Node `vm`，桩 `window` / `document` / `DOMParser` / `fetch`，不联网）：

| 场景 | 请求（方法 + 地址 + 体） | 结论 |
|---|---|---|
| 课表页（页面有下拉框，`selected` 在第二学期） | POST 课表 `…xskbcx_cxXsgrkb.html?gnmkdm=N2151` 体 `xnm=2026&xqm=12&kzlx=ck&xsdm=&kclbdm=`；POST `…cxRjc.html?gnmkdm=N2151` 体 `xnm=2026&xqm=12&kzlx=ck&xsdm=&kclbdm=&kclxdm=`（无 `xqh_id`）；POST `…cxZcByXnxq.html?gnmkdm=N2151` 体 `xnm=2026&xqm=12` | 只三条，菜单号全是 N2151；学期取 `selected` 项 |
| 教务首页 `/jwglxt/xtgl/index_initMenu.html`（无下拉框） | GET `…xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`，然后同上三条 POST | 先读下拉框，再发三条 |
| 课表 N2151 返回 404 | N2151 课表 404 → N253508 课表 200 → N253508 cxRjc → N253508 cxZc | 校历与节次时间跟着 N253508；不再发 N2151 附加请求 |
| 课表 N2151 与 N253508 都返回登录页（含「登录」「密码」） | 两条课表 POST，无附加请求 | 报「登录状态已失效：教务系统返回了登录页，请重新登录后再点「提取课表」」 |
| 统一认证页 `https://jw.hualixy.edu.cn/sso/ddlogin` | 无请求 | 同步抛「请先登录教务系统，再点「提取课表」」 |
| 正方直登页 `…/xtgl/login_slogin.html` | 无请求 | 同上 |
| WebVPN 地址 `https://webvpn.hualixy.edu.cn/http/77726476…/jwglxt/…?vpn-12-o1-jw.hualixy.edu.cn&gnmkdm=N2151&layout=default` | 三条 POST 的地址为 `…/http/77726476…/jwglxt/kbcx/…?vpn-12-o1-jw.hualixy.edu.cn&gnmkdm=N2151` | `/http/<hex>` 前缀与 vpn 片段都原样保留 |
| 校内直连、查询串无 vpn 片段，附加接口返回 500 | 课表 POST 成功；cxRjc、cxZc 失败 | 附加接口为 `null`，课表照常交出；地址不带 vpn 片段 |

所有场景输出中检不到 `STUB` 字样（学生信息未泄漏）；`periodTimes` 的 `{ data: [...] }` 外壳被剥成数组；每行的 `extra` 等非白名单字段被丢弃。

**自检**：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/hualixy`。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **真机未验证**：没有广州华立学院的账号，所有请求路径、请求体、字段名都照上游代码写，没有在真实教务页面上跑过。上游代码本身是否仍被本校教务接受，未知。
2. **`N253508` 的含义未知**：上游把它当作备用菜单号，我们不知道它对应哪个页面。它只在 `N2151` 失败时才会用到；如果本校 `N253508` 恰好能返回别的菜单的数据，形状不对会被 `kbList` 校验挡下，但内容不对我们无法从形状判断。
3. **节次时间接口形状未知**：`cxRjc` 可能是裸数组，也可能是 `{ data: [...] }`，也可能字段是 `jcdm`/`jcmc` 或 `qssj`/`jssj`/`sksj` 的任一组合。本件都收，但没见过真实响应。取不到就用空课默认 12 节，学生会看到提醒。
4. **`qsxqj` 是否存在未知**：上游读 `qsxqj` 做 `firstDayOfWeek`，说明课表响应大概率有它；缺省时本件按周一。
5. **空课默认节次表不是本校的作息**：12 节表是 `:core:model` 的默认值，与学校实际作息可能不同。提醒文字已写明「请在学期管理里核对」。
6. **WebVPN 查询串片段**：本校教务若经 WebVPN 访问，查询串里的 `vpn-…` 片段格式未知。本件只沿用，不生成。如果学校的片段不在查询串里，附加接口会 404，只影响节次时间与校历。
7. **登录页判断靠文字**：「登录」与「密码」同时出现即视为登录页，沿用上游。若课表本身含这两个词（极少见），会被误判为登录失效。
8. **总周数口径与上游不同**：见第 9 节第 2 条。
9. **`today` 依赖本机时钟**：校历与节次都取不到时，推算开学日用的是「今天」只作兜底（`estimateStart()` 的 `!year` 分支）；正常路径用的是学年与学期锚点，不依赖今天。

## 9. 需要主调度确认的点

1. **总周数口径**：任务卡「开学日 / 总周数」一行写「总周数 = max(课表最大周次, 20)。照模板」。本件**照模板 hueb**：校历给得出周数就用校历的周数，课表更晚则抬高，取不到校历则 20。这与上游的 `Math.max(maxWeek, 20)` 不同：校历写 18 周而课表最晚 16 周时，上游会导 20 周，本件导 18 周。两者都不会丢课。若主调度要求严格按上游，改 `parse.js` 中 `totalWeeks` 那一段即可。
2. **周次 / 节次 / 单双周的细节**沿用模板，不再单独确认。

## 10. 签名

0x7E7-2023（haiku 移植，2026-10-20）
