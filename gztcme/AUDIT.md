# 安全审计 —— 贵州机电职业技术学院（正方新版教务 jwglxt，`jwxt.gztcme.cn`）

审计对象：`jw-adapters/gztcme/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `GZTCME/gztcme.js`（快照 commit `e15c6274ac347c9642da890504651a9b4e374391`，2026-10-26 拉取，MIT，维护者 Panda君；本校脚本最后一次修改 `134bdbc`，2026-10-24，已用 `git log -1 -- resources/GZTCME/gztcme.js` 核对一致）。

审计方式：逐行读上游脚本 + 逐行读移植件，跑 `check.js`（Rhino 1.8.0 实跑全部 fixture + 载荷校验 + ES5 + 控制字节 + allowHosts），再用 Playwright 在 Chromium 里起假教务站实跑 `extract.js`（11 个场景，见第 8 节）。

## 0. 出处、模板与分析

- 上游 `GZTCME/gztcme.js`（277 行，正方 V9）：入口 `import_url` 直达「个人课表查询」；检查路径含 `/jwglxt/`；读课表首页的 `#xnm` / `#xqm` 做成弹窗让用户选学年学期；
  然后并发请求课表（`kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`）与校历（`kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`），
  课表里出现多个校区（`xqh_id`）时弹窗让用户选一个，再按所选校区取节次时间（`kbcx/xskbcx_cxRjc.html?gnmkdm=N2151`），
  确认弹窗后保存「学期配置 → 作息 → 课程」三步。**没有写死的节次表**，全部读教务。
- 三个数据请求都是 **POST 表单**（`application/x-www-form-urlencoded`），只有首页是 GET。
- 模板选 `zust`（批次十七）：同为正方新版 `/jwglxt/`、同样读教务校历与节次时间、同样按校区取节次时间且校区不用提问桥而自动判断，
  已吸收批次七至十七的审计修正（前缀 / 后缀单双标记各归各段、共 N 周只剥备注、H3 补节次、校历第 1 周回退周一、去重合并、提醒限长、`第1-第8周`）。
  `hueb` / `jsei` 是 POST 表单但不分校区、节次表写死，不如 `zust` 贴近；上游的 POST 请求体改回 POST 即可。
- 本校差异的分析结论：
  1. 入口单一主机（`jwxt.gztcme.cn`），没有 WebVPN 前缀，也没有备用入口：不需要 `zust` 的双主机判断，改为上游的「路径含 `/jwglxt/`」判断；`allowHosts` 为空（全部请求同源）。
  2. 请求方法 / 路径 / 请求体不同（POST；节次时间接口是 `xskbcx_cxRjc.html` 而不是 `zust` 的 `skxxMobile_cxRsdjc.html`）。
  3. 上课地点上游只取 `cdmc`，不加校区名（`zust` 上游加）。
  4. 未排课课程（`sjkList`）上游列在确认弹窗里写明「本次不导入」，这里写进提醒。
  5. 内置节次时间：无。教务取不到时上游回落「应用默认作息」，这里回落空课默认节次时间（12 节）并说明。
  6. 提问桥：不使用。上游选学期、选校区两处弹窗都改为自动（读页面当前学期；校区取课数最多的，其它校区的差异进提醒）。
     校区只影响节次时间，而课表仍按教务节次号放入，所以不属于「影响课表本身」的情形。

## 1. 请求清单（与 `extract.js` 逐条对应）

主机一律由 `window.location.origin` 拼出，不写死；上下文路径跟着当前地址走（`jwBase`），没有就用 `/jwglxt`。
全部同源，`credentials: 'include'`，头只带 `X-Requested-With`、`Accept`，POST 另带 `Content-Type: application/x-www-form-urlencoded;charset=UTF-8`（`request`）。

| 方法 | 地址 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|
| GET | `<origin>/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 无 | 读 `#xnm` / `#xqm`（**页面上已有这两个字段时跳过**，`currentTerm`） | 报错，提示重新登录后再点「提取课表」 |
| POST | `<origin>/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | `xnm=…&xqm=…&kzlx=ck` | 取整学期课表（排课行、未排课课程；`xsxx` 只比对学年学期，`fetchTimetable`） | 报错 |
| POST | `<origin>/jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | `xnm=…&xqm=…` | 学期校历（开学日、总周数，`optionalJson`） | 交 `null`，`parse.js` 推算开学日、总周数按 20 并说明 |
| POST | `<origin>/jwglxt/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | `xnm=…&xqm=…&xqh_id=<校区>` | 每个出现过的校区各取一次节次时间（最多 6 个校区，`optionalJson`） | 该校区交 `null`；基础校区取不到则整张用空课默认节次时间并说明，其它校区取不到进「节次时间不同」提醒 |

路径、方法、请求体字段、菜单号（课表与节次时间 N2151、校历 N2154）逐字照抄上游 `gztcmeRunImport` / `gztcmeChooseTerm`。
不同：上游每次先取课表首页给弹窗用，这里页面上读得到就不取；校历与节次时间失败上游整次报错，这里降级（见第 5 节）；
上游对课表里没有 `xqh_id` 的课不取节次时间（用应用默认作息），这里同样不取，用空课默认节次时间并说明（冒烟 `no-campus`）。
`X-Requested-With` / `Accept` 头上游没有带，这里沿用 `zust` 审计过的写法（正方 Ajax 惯例，不含任何个人信息）。

登录过期判断（`looksLikeLogin`）：响应地址含 `authserver/` 或 `login_slogin`；页面标题以「统一身份认证」或「用户登录」开头；
要 JSON 的请求却回了一张写着 `login_slogin` 的网页。上游是「响应地址或正文里有 `login_slogin`」，这里对正文收窄成「期望 JSON 却拿到网页」，
避免课表首页自带的退出链接误报。

入口判断：`loginUrl` 就是上游 `import_url`（未登录会跳到正方登录页，登录后回到课表页）。
停在非 `/jwglxt/` 路径（门户页、统一认证页等）或教务登录页（`login_slogin.html`）点「提取课表」：给大白话提示，**不发请求**（冒烟 `portal` / `auth` / `loginpage` 场景覆盖）。
`scheduleUrlHint` 照 `zust` / `hueb` 的做法写成课表页地址（该字段是「一键刷新时优先打开的课表页」，写大白话会打不开），任务卡建议的那句话改由报错文字承担。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 带出的字段 |
|---|---|
| 学年学期 | `xnm` / `xqm` 与下拉框文字 |
| 排课行 | 白名单 `kcmc` `xm` `cdmc` `xqj` `jcs` `zcd` `xqh_id` `xqmc`（`ROW_FIELDS`） |
| 未排课课程 | 只留 `kcmc`（上游还展示 `qsjsz`，不需要，不带） |
| 节次时间 | 每校区 `{campusId, rows}`，行只留 `jcmc` `qssj` `jssj`（`PERIOD_FIELDS`） |
| 校历 | 只留 `zs` `rq`（`CALENDAR_FIELDS`） |
| 记录总数 | 响应里有才有，只用于对账 |
| 今天日期 | `today`，本机时钟，只在校历取不到时用来兜底推算 |

不带出：`xsxx`（含学号、姓名等，只在 `fetchTimetable` 里取 `XNM` / `XQM` 比对，不交出）、学分、教室内部 ID、响应里其余任何字段。
冒烟里在课表行、`xsxx`、校历行、未排课行里都塞了学号 / 证件号 / 手机号 / 教室内部 ID，交出的 JSON 里一个都没有。

## 3. 移植手册 §5 八条逐条结论

1. **不碰凭据**：不读不存不发账号密码；只用 WebView 已登录的会话（`credentials: 'include'`），不读 Cookie。通过。
2. **不外发**：全部请求同源（`window.location.origin`），`extract.js` 里没有任何写死的绝对地址（只有一句提示文字里提到 `jwxt.gztcme.cn`）；`allowHosts` 为空。通过。
3. **只读课表**：只请求课表首页、课表、校历、节次时间四类，不碰成绩 / 学籍 / 个人信息。通过。
4. **字段白名单**：见第 2 节。通过。
5. **不埋点**：无 `sendBeacon` / `WebSocket` / `Image` 上报。通过。
6. **不动态执行**：无 `eval` / `new Function`。通过。
7. **不写页面、不提交表单**：只读 `#xnm` / `#xqm`，首页用离线 `DOMParser` 解析，不插入当前页面；POST 是对教务查询接口的只读查询，不改任何数据。通过。
8. **不硬编码秘密**：无任何账号、学号、令牌。通过。

## 4. 与模板 `zust` 的差异

- 请求：课表 / 校历 / 节次时间改 POST 表单（`zust` 全 GET + 查询串），课表不带 `xsdm=&kclbdm=&kclxdm=`，节次时间接口换成 `xskbcx_cxRjc.html`（菜单号 N2151）。
- 入口：不判断主机（单一主机、`allowHosts` 空），按上游判断路径含 `/jwglxt/`；登录页判断多认「用户登录」标题。
- 地点：只写教室名，不加校区名（上游 `position: cdmc`）；合并键仍含校区号，同一教室名的两个校区不会被并（fixture `merge`）。
- 未排课课程提醒措辞按上游「尚未排定上课时间，本次不导入」重写，课名经 `sampleNames` 限长（`zust` 那条没限长，这里补上，fixture `long-names` 钉住）。
- 文字里的学校名、`SCHOOL_NAME`、报错里的页面名（「个人课表查询」）换成本校。
- 周次、节次、校历、节次表校验、H3 补节次、合并、限长全部原样沿用。

## 5. 上游里被删掉 / 改掉的东西及理由

- **选学期 / 选校区弹窗**（`gztcmeChooseTerm`、`gztcmePick`）：学期改为读页面当前学期（移植手册 §3）；校区改为自动取课数最多的，其它校区节次时间不同的课进提醒（`otherTimes`）。
- **严格校验后整次报错**（`gztcmeWeeks` 认不出周次、周次超过 60、`gztcmeCalendar` 校历第 1 周不是周一 / 周次不连续 / 日期不对应、`gztcmeTimeSlots` 节次编号不连续或起止时间异常、
  课程周次超过校历周数、节次超过作息节数）：按空课规范降级为 warnings，不静默丢课、不猜测。
  周次认不出的行计数进「数据不全」提醒；校历第 1 周起日回退到周一；校历取不到 / 异常推算开学日；节次时间不合法当没取到；课表周次更晚则抬高总周数（上限 30）并提醒。
- **课表节次超过校区作息节数整次报错**：改为 H3 逐节补齐并提醒，补不了的如实说明。
- **未排课课程**（`sjkList`）预览：写进提醒（课名限长），让学生自己添加或排定后重新导入。
- **保存桥调用、确认弹窗、`notifyTaskCompletion`、`showToast`**：「拾光」的桥能力，空课由宿主保存，适配器只交数据。
- **`gztcmeSave` 的部分保存提示**：空课整包一次导入，不存在中途失败只存一半。

## 6. fixtures（7 对，全部合成）

| 用例 | 覆盖 |
|---|---|
| `basic` | 单校区；校历 22 行含假期 → 开学日 / 总周数；单双周；缺教师 / 缺教室；星期日；未排课课程；地点只写教室名 |
| `multi-campus` | 本校专属：基础校区自动选择；东校区 1-2 节时间相同不提醒、5-6 节不同提醒；南校区节次时间取不到提醒；节次表重复行；校历取不到 |
| `period-fallback` | 本校专属：第二学期（下拉框文字 2）；校历第 1 周是周三 → 回退周一；校历 34 行 → 钳到 30 周；基础校区节次时间取不到 → 空课默认节次时间；第 13-15 节补时间与越界不补 |
| `weeks-forms` | `第1-第8周`、前缀单双各归各段、共 N 周只剥备注、后缀标记紧挨下一段、备注括号、教学班序号、超范围丢弃、全角 / 波浪线 / 空格写法、单双同写 |
| `messy` | 缺名 / 星期 8 / 节次 1a / 周次认不出各计一行；节次多段；校区名缺失；未排课四门只点前三门；总数对账 |
| `long-names` | 长课名（29 字）缺教师缺教室六门 + 长课名（32 字）未排课四门 + 很长的括号备注：每个点名课名截到 20 字，每条 ≤200 字 |
| `merge` | 连堂合并、重复行、同课周次并集、不同校区且教室名相同的连堂不合并 |

期望值的来源：先沿用 `zust` 已审计的期望（周次切段、单双周、节次时间、开学日、warnings 逐条手工推演过），再逐处按本校差异改写——
地点去掉校区名前缀、校区名换成虚构的「主校区 / 东校区 / 南校区」、未排课提醒换成新措辞、`merge` 的跨校区用例改成教室名相同并删去缺教室提醒、
`long-names` 新增一条未排课提醒（课名 `第X门超长未排课课程名称` + 7 个「测」 + 省略号，手数 19 字 + 省略号）。没有把 `parse.js` 输出直接存成 expected；首次比对全部一致。

## 7. 变异测试（临时副本上改 `parse.js`，跑 `check.js`；脚本 `.test/port-batch18/gztcme/mutate.py`，原件未动）

| 改坏哪一处 | 变红的用例 |
|---|---|
| 合并键不看校区号（`sameSlotDay`） | `merge` |
| 点名课名不截断（`shortName`） | `long-names` |
| 不去掉「第」（`weeksOf`） | `weeks-forms` |
| 校历第 1 周起日不回退周一 | `period-fallback` |
| 基础校区改取课数最少 | `multi-campus` |
| 地点加上校区名 | 全部 7 对 |
| 未排课课程不进提醒 | `basic` / `messy` / `long-names` |

七处全部变红；变异都在复制到系统临时目录的副本上做，原目录未改，最后在原目录跑 `check.js` 为 `RESULT: PASS`。

## 8. 浏览器冒烟（Playwright + 假教务站，不联网；`.test/port-batch18/gztcme/smoke.py`）

场景 11 个全部 OK：`normal`（课表页，GET 首页不发、三个数据请求都是 POST，请求体与上游一致）、`menu`（页面没有 `#xnm`，先 GET 课表首页再取课表）、
`portal`（非 `/jwglxt/` 路径，不发请求）、`auth`（统一认证路径，不发请求）、`loginpage`（教务登录页，不发请求）、`expired`（课表请求回正方登录页 → 报登录过期）、
`expired-auth`（回统一认证页 → 报登录过期）、`mismatch`（回显学期与所选不一致 → 报错）、`aux-fail`（校历与节次时间 500 → 仍能导入，推算开学日 + 空课默认节次时间 + 提醒）、
`one-campus`（只有一个校区只取一次节次时间）、`no-campus`（课表没有校区号，不取节次时间，用空课默认节次时间并提醒）。
每个场景检查：请求方法（首页 GET、其余 POST）、请求体字段集合、请求里没有个人信息、交出的数据里没有个人信息、节次时间请求的校区与课表里出现的校区一致、地点里没有校区名、每条提醒 ≤200 字。

## 9. 已知风险与未验证项

- **没有本校账号，真机没验过**：接口字段名、校历 `rq` 的「起日/止日」格式、节次时间的 `jcmc` / `qssj` / `jssj`、学期下拉框文字（假定 1 / 2 / 3，值 3 / 12 / 16）、
  POST 请求体是否还需要别的字段，全部来自上游脚本的读法，没有拿真实响应对过。学期文字读不出来时按学期代号判断第几学期。
- **校区名 / 校区个数未知**：fixtures 里的「主校区 / 东校区 / 南校区」是虚构的，不代表本校真实校区；自动取课数最多的校区作基础，
  学生主要在课数少的校区上课时，提醒里会指出其它校区的课，时间以教务为准。
- **校历总周数含假期**（上游注释明说「范围可能包含假期」）：总周数取校历行数，超过 30 钳到 30 并说明。
- 登录过期判断对正文收窄后，若教务用别的登录页形态（标题不是「用户登录」且不含 `login_slogin`）会落到「返回的内容格式不对」类报错（同样带重新登录提示），不会静默出错。
- 本校只有 `jwxt.gztcme.cn` 一个入口；如果学生是经别的主机（校外通道）进的教务，`allowHosts` 为空会被拦下。

签名：0x7E7-2023（sonnet 移植，2026-10-26）
