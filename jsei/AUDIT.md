# 安全审计 —— 江苏电子信息职业学院（正方新版 jwglxt，WebVPN / 校园网双入口）

审计对象：`jw-adapters/jsei/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `resources/JSEI/jsei_01.js`（快照 commit `c4a35feb061a3f6db2d6c122927083c067c61309`，
2026-10-19 拉取；本校脚本最后一次修改 `4570e79`，2026-10-14；MIT，作者 星河欲转）。
上游同目录 `resources/JSEI/adapters.yaml` 有两个条目：`JSEI_01`（webvpn，`import_url` `https://webvpn.jsei.edu.cn/`）
与 `JSEI_02`（校园网统一门户，`import_url` `https://ehall.jsei.edu.cn/new/index.html`），两者都指向同一份
`jsei_01.js`。本件只做一个适配器，入口按任务卡取 WebVPN 映射主机上的教务登录页。

审计方式：逐行读上游脚本 + 逐行读移植件，并跑移植手册 §5 的静态扫描；`parse.js` 用 Rhino 1.8.0 实跑 8 对
fixture；`extract.js` 用桩 window / document / fetch / DOMParser 在 Node 里跑过（不联网），确认请求路径、
请求体与交出去的形状。扫描结果：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，
  是写上游出处的注释，不是请求。`extract.js` 的请求地址全部由 `window.location.origin` 拼出，没有写死主机名。
- 网络调用：只有 `extract.js` 里的 `fetch(url, options)`，位于 `request` 函数里。`parse.js` 里没有任何网络调用。
- 凭据、本地存储、动态执行：`password` / `pwd` / `localStorage` / `sessionStorage` / `document.cookie` /
  `eval` / `new Function` / `sendBeacon` / `WebSocket` / `EventSource` / `new Image` 全部无命中。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、解构、展开符、
  `new Set` / `new Map` / `Array.from`、可选链、后行断言与命名捕获组，在 `parse.js`、`extract.js` 全文中全部无命中。
- 控制字节与 BOM：本目录全部文件（含 fixtures）无控制字节、无 BOM。

## 1. 请求域与请求清单（与代码逐条对应）

上游 `jsei_01.js` 写死了两个基础地址（第 10–15 行 `BASE_URLS`）：校园网直连 `https://jwpd.jsei.edu.cn/jwglxt`
与 WebVPN 映射 `https://jwpd-443.webvpn.jsei.edu.cn/jwglxt`，再用 `getBaseUrl()` 按 `window.location.hostname`
是否含 webvpn 二选一（第 22–27 行）。移植件把这一层整个去掉：四条请求的地址都由 `window.location.origin + '/jwglxt'`
拼出（上下文路径跟着当前地址走）。页面在哪个主机上就在哪个主机取数，代码里没有 `BASE_URLS`、没有主机名判断。

`manifest.json`：`loginUrl` 是 WebVPN 映射主机上的教务登录页
`https://jwpd-443.webvpn.jsei.edu.cn/jwglxt/xtgl/login_slogin.html`，`allowHosts` 放校园网直连主机
`["jwpd.jsei.edu.cn"]`（不写通配）。WebVPN 主机由 `loginUrl` 覆盖，校园网主机由 `allowHosts` 覆盖，
宿主据此把桥注入到两个可能的 origin。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<origin>/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的学年学期字段（`#xnm` / `#xqm`）。**页面上已经有这两个字段时跳过这一步** | 报错，提示重新登录后再点「提取课表」 |
| extract.js | POST | `<origin>/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数。请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`，与上游 `fetchAndParseCourses` 逐字一致（上游第 448 行） | 报错，提示重新登录 |
| extract.js | POST | `<origin>/jwglxt/jzgl/skxxMobile_cxRsdjc.html?gnmkdm=N2154` | 取节次时间。请求体 `xnm=…&xqm=…&xqh_id=1`，与上游 `fetchTimeSlots` 逐字一致（上游第 389 行，`xqh_id` 固定 `1`） | 交 `null`，parse 回落到学校 11 节表并写进 `warnings` |
| extract.js | POST | `<origin>/jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取学期周次校历，定开学日与总周数。请求体 `xnm=…&xqm=…`，与上游 `fetchSemesterStartDate` 一致（上游第 338 行） | 交 `null`，parse 回落到推算并写进 `warnings` |

与上游的差别：

- 上游每次导入都先请求学年学期首页（`fetchAcademicOptions`），用来生成两个选择框的选项。移植件改成：页面上读得到
  `#xnm` / `#xqm` 就不发这条请求，读不到才去取一次首页（`DOMParser` 离线解析，不插入当前页面）。
- 上游的校历请求失败也被吞掉（`catch` 里返回 `null`）。移植件沿用这一点，并且把失败写进 `warnings`，不静默降级。
- 节次时间请求是**上游本来就有的**（`fetchTimeSlots`，上游第 387 行起），路径、菜单号、请求体与 `xqh_id=1`
  全部照抄；只是解析挪到了 `parse.js`，失败时不再调用 `savePresetTimeSlots`，而是由载荷的 `periodTimes` 承载。
- 两条附加请求（节次时间、校历）失败不影响导入：`optionalJson` 把任何失败（非 2xx、网络错误、解析失败）都吞成
  `null`，由 `parse.js` 回落，回落这件事会出现在导入预览的 `warnings` 里。
- 请求头统一带 `Content-Type`、`X-Requested-With`、`Accept`，不带任何自定义令牌。凭据用 `credentials: 'include'`，
  让 WebView 按同源规则带 Cookie；脚本既不读 Cookie，也不把它发到别处。
- `parse.js` 不发任何请求（CI 里用 Rhino 实跑，是纯函数）。

## 2. 读了什么（数据面）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 与下拉框文本） | 课表页的 `#xnm` / `#xqm`，或课表首页 HTML（`DOMParser` 解析的离线文档，不插入当前页面） | 带出（学期名要用） |
| 排课行 `kbList`：`kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` / `xqh_id` | 课表接口 | 带出这七个字段（`extract.js` 的 `ROW_FIELDS` 白名单）；`xqh_id` 只用来填 `campusId` |
| 集中实践课 `sjkList` | 课表接口 | **只带出 `kcmc`**（`extract.js` 逐行重建 `{ kcmc }`） |
| 节次时间（`jcmc` / `qssj` / `jssj`） | `skxxMobile_cxRsdjc` | 带出原始行，parse 只取 `jcmc` / `qssj` / `jssj` 变成载荷的 `periodTimes` |
| 学期周次校历（`zs` / `zsmc` / `zrq` / `zcrq` / `rq` / `ksrq`） | `cxZcByXnxq` | 交给 parse 只用来算开学日与总周数，不进入载荷 |
| 记录总数（响应里有才有） | 课表接口 | 只用于对账，不进入载荷 |
| 学生个人信息（课表响应里夹带的 `xsxx` 之类） | 课表接口 | **不带出，也不进 fixture**（`extract.js` 只按白名单重建排课行，`sjkList` 只留课名） |

不读的东西（静态扫描无命中）：`password` / `pwd` / 登录表单、`localStorage` / `sessionStorage`、Cookie 值、
成绩（`/cjcx/*`）、学籍、个人信息、缴费，以及任何其它模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问。唯一的「凭据」是浏览器自带的会话 Cookie，脚本既不读它也不外发。上游的开场公告弹窗（`showAlert`）和两次学年学期选择框（`showSingleSelection`）没有移植：学年学期改成读页面上的 `#xnm` / `#xqm`，不向用户问任何东西 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js`，地址由 `window.location.origin` 拼成。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单，也没有第三方域（唯一的绝对 URL 是文件头里写上游仓库的 `https://github.com`，不是请求） |
| 3 | 请求域可控 | **过**。请求主机只有一个，即用户当前打开的教务主机：要么是 WebVPN 映射主机（`loginUrl` 所在），要么是校园网直连主机（`allowHosts` 声明）。代码里没有写死的主机名，也没有 `*.` 通配 |
| 4 | 只读课表 | **过**。四条请求全部落在课表与作息模块（`/jwglxt/kbcx/*`、`/jwglxt/jzgl/skxxMobile_cxRsdjc.html`），不碰成绩、学籍、个人信息、缴费。课表响应里夹带的学生信息一律不带出。节次时间与周次校历是学校公共数据，不含个人信息 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，也没有图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse` |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的值。取课表首页用的是 `fetch` + `DOMParser`，离线解析，不插入当前页面，不改表单，不触发提交或点击。上游的 `showToast` / `notifyTaskCompletion` / `saveImportedCourses` 等桥调用全部没有移植 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。脚本里的常量只有正方上下文路径 `/jwglxt`、菜单号 `N2151` / `N2154`、固定校区号 `1`（上游同款），都是页面上可见的参数 |

**结论：可以进内置库。** 请求全部落在当前教务主机上（地址由当前页面的 origin 拼出），只读课表（含节次时间与周次校历
两个只读附加接口），不碰凭据、不外发、不埋点、不写页面。

## 4. 本批（批次八）检查表逐条

| # | 检查项 | 本件结论 |
|---|---|---|
| 1 | 周次四写法 | **过，有用例**。`1-16周(单)`（basic 的大学英语）、`2-16周(双)`（basic 的大学体育）、`1-16周`、`1-22周`、`1-15周(单) 共16周` 等。`weeksOf` 的顺序：删「共 N 周」备注 → 破折号异体连同两侧空白归一成 `-` → 全角转半角 → 括号组逐组处理 → 落单括号换逗号 → 删「周」→ 空白折成逗号切段 → 单/双标记归属 → 展开并过滤奇偶。单/双标记的归属按括号相对周次的位置决定：前缀标记 `(单)1-8` 直接贴到后面那一段，后缀标记 `1-8(单)` 并给前面那一段，前后都不是周次的独立标记才按就近向前、再向后归属。`week-markers` 钉住 `(单)1-8周,(双)9-16周` 与 `1-8周(单),9-16周(双)` 两种写法都得到 1-7 单周 + 10-16 双周（B1）；`weeks-total` 钉住末尾的「共 16 周」不会被当成周次，且备注只删本身（`1-8周(共8周),9-16周` 的 9-16 不丢、`共16周,1-15周(单)` 整行不丢课） |
| 2 | 括号内纯数字不是周次 | **过**。括号里只有数字、`-`、`,`、空白的（`(1)`、`(1-2)`）是教学班序号，整组摘掉；含非周次字的（`(3组)`）是备注，整组摘掉并计数；其余（`(1-16周)`、`(单)`）保留内容。本件的 fixture 没有单独覆盖括号写法（模板件已覆盖同一份代码，实现逐字一致） |
| 3 | 无星期表头兜底 | **不适用，没有猜列**。走接口（JSON），星期直接由 `xqj` 给出（1–7）；不在 1–7 的行计数进 `warnings`，不猜 |
| 4 | 时间合法性 | **过**。写进 `periodTimes` 的时间有两个来源。① 教务接口：逐条取 `HH:mm` 前缀（`08:10`、`08:10:00` 都认，`24:00`、`85:45` 不认）、`start < end`、从第 1 节起连续、时间递增不重叠；任何一条不满足就整表作废，回落到学校 11 节表并写 `warnings`。② 课表用到的节次超出已有节次时间时逐节补（统一修订 H3）：先看空课默认 12 节表里同号那一节，开始时间不早于上一节下课才用；否则在上一节下课后顺推（课间 5 分钟、每节 45 分钟）；顺推越过 23:59 就停，从这一节起不补，课程照常导入并写 `warnings`。`basic` 钉住第 12 节取空课默认的 21:15–22:00、第 13 节顺推 22:05–22:50 |
| 5 | `warnings` 上限 | **过**。所有提示都经 `warn()` 收口：单条超过 200 字截断并补「…」；总数到 20 条后不再追加，最后一格写「另有 N 条核对提示超出上限未显示」。带课名的提醒先按课程名去重汇总，每个课名经 `shortName()` 截到 20 字，再走 `warn()`。`long-name-missing` 用 6 个超长课名把两条提醒压到 96 字（每条），钉住这条路径 |
| 6 | 分页 | **不适用，但对账了**。正方这个接口一次性返回整学期排课，没有分页参数，上游也没有翻页。响应里若带了记录总数，就与行数对账，取到的少就出声 |
| 7 | 学期名 | **过**。取自教务下拉框文本（`extract.js` 读出的 `xnmText` / `xqmText`）。`xqmText` 整段已是「…学年…学期」时直接用原文；否则用学年（`xnmText` 是 `YYYY-YYYY` 时用它，否则由 `xnm` 推出）加「学年第 X 学期」拼。学年完全读不出来时用「江苏电子信息职业学院 第 X 学期」（学校名，不是适配器名）。用例的学期名都是 `2026-2027学年第一学期` |
| 8 | `teacher` / `location` 拿不到就留空（`null`） | **过**。读不到就是 `null`，不写「未知」「暂无」。`basic` 的「大学体育(一)」（`xm` 为空，teacher 为 null）、「思想道德与法治」（`cdmc` 为空，location 为 null）；`long-name-missing` 的 6 门课教师与教室都为 null。**上游在这里整行丢课**（`jsei_01.js` 第 182–184 行要求 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` 六个字段全部非空），移植件只要求课名、星期、节次、周次，缺教师 / 缺教室照常导入，并按类型汇总提醒 |
| 9 | `allowHosts` | **过**。`["jwpd.jsei.edu.cn"]`，只写主机名、不写通配。WebVPN 主机由 `loginUrl` 覆盖 |
| 10 | 每件都要做变异测试 | **已做，见 §8**。6 处变异，每处都有红灯 fixture |

## 5. 与模板件（`lcudcc`）的差异

模板件是批次三定稿的同族适配器（只读）。本件逐项对照得到下列差异：

1. 文件头、学校名（江苏电子信息职业学院）与上游出处（`JSEI/jsei_01.js`，快照 `c4a35fe`，作者 星河欲转）改为本件的内容。
2. **节次时间表**：模板只有一张空课默认 12 节表（上游没有作息）。本件有 `SCHOOL_PERIOD_TIMES`（上游
   `FALLBACK_TIME_SLOTS` 的 11 节，逐节照抄）与 `BUILTIN_PERIOD_TIMES`（空课默认 12 节，只用于超出表长时补时间），
   写法参考 `shzq`。教务接口取不到时整张用 11 节表；`MAX_PERIOD` 仍为 20。
3. **节次时间请求**：模板是 `cxRjc`（菜单号 N2151，`xqh_id` 取自课表行）；本件照上游用
   `jzgl/skxxMobile_cxRsdjc.html`（菜单号 N2154，`xqh_id` 固定 `1`）。
4. **字段白名单**：模板把 `kbList` 整行交出去；本件只留 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` / `xqh_id`，
   `sjkList` 只留 `kcmc`。
5. **缺教师 / 缺教室的提醒**：模板没有；本件按课程名去重汇总，各出一条提醒，课名截到 20 字。
6. **补时间的提醒文案**：模板写「课表用到了作息表里没有的…」，本件改写为「已有的节次时间没有覆盖…」，并把
   「空课默认作息」改成「空课默认节次时间」，避免界面文案里出现术语表不再使用的「作息」。
7. **两条路径**：模板的 `loginUrl` 与课表同主机、`allowHosts` 为空；本件 `loginUrl` 用 WebVPN 映射主机、
   `allowHosts` 放校园网直连主机，代码里同样不写死主机名。
8. **学期名兜底**：模板在学年读不出来时会拼出「学年第 X 学期」；本件加一条学校名兜底（见 §4 第 7 条）。
9. **缺陷修复（B1）**：模板 `lcudcc` 的 `weeksOf` 在所有单/双标记都先变成独立段后只按「就近向前、再向后」归属，
   `"(单)1-8周,(双)9-16周"` 里第二个前缀标记会被并到前一段 `1-8` 上，两段合成 1-16 每周，
   9-16 的双周整段丢掉。本件按括号相对周次的位置区分前缀 / 后缀标记（见 §4 第 1 条），`week-markers` 钉住两种写法。
   **模板件里这一处未动（只读）**，交主调度决定是否回填。
10. **上游同源修正（共 N 周）**：上游 `parseWeeks` 在清理周次文本时会删掉 `共 N 周` 这类学期总周数备注，
    模板 `lcudcc` 的 `weeksOf` 漏了这一步。不补的话 `"1-15周(单) 共16周"` 里那个 16 会被当成周次，
    多出一个第 16 周的上课安排。本件在 `text()` 之后补上同样的剥离，但**只删备注本身**
    （`/共\s*[0-9]+\s*周?/g`），不照抄上游「共 + 数字 + 到结尾」的贪婪写法（B3）：
    贪婪写法会把 `"1-8周(共8周),9-16周"` 的 9-16 整段删掉（静默少课），也会让 `"共16周,1-15周(单)"` 整行没有周次而丢课。
    `weeks-total` 同时钉住四种写法：备注在末尾、备注在中间括号里、备注在最前、以及末尾备注不影响正常周次。
    **模板件里同样缺这一步（只读）**，交主调度决定是否回填。

其余实现（周次解析、节次解析、两阶段合并、去重、开学日回滚周一、总周数收紧与抬高、校历可信性判断、载荷上限）
与模板逐行同源，本件没有另行改写。

## 6. 对上游的删改（都不牵涉安全问题，审阅者需要知道）

1. **两段式**：上游把取数、解析、保存写在一起；移植件切成 `extract.js`（只取数）与 `parse.js`（纯转换，CI 实跑）。
2. **双入口判断去掉**：上游 `BASE_URLS` + `getBaseUrl()` 写死两个主机、按 `window.location.hostname` 二选一；
   移植件一律用 `window.location.origin` 拼同源相对路径。这样 WebVPN 映射主机与校园网直连主机共用一份代码，
   也符合「不写死主机名」的要求。
3. **弹窗与保存全部去掉**：上游的 `promptUserToStart`（`showAlert`）、`selectAcademicYearAndSemester`
   （两次 `showSingleSelection`）、`saveCourses`、`saveCourseConfig`、`importPresetTimeSlots`
   （`savePresetTimeSlots`）、`showToast`、`notifyTaskCompletion` 都没有移植。学年学期改成读页面上的
   `#xnm` / `#xqm`：用户切到哪个学期就导哪个学期。要换学期，用户在教务页面里切换后再点「提取课表」。
4. **整行丢课改为计数**：上游 `parseJsonData` 要求六个字段全非空，缺任一就跳过整行（第 182–184 行）。移植件只要求
   课名、星期、节次、周次；缺教师或教室的课保留（`null`），并在 `warnings` 里按类型汇总。
5. **周次重写**：上游 `parseWeeks` 只认 `(数字)-(数字)` 加可选单双标记、且依赖 `周` 字做切分；移植件认
   §4 第 1 条的全部写法，标记不丢、不塌成「每周都上」。
6. **节次放宽**：上游 `split('-')` 只取首尾，`0102` 会算成第 102 节。移植件认 `1-2`、`第9-10节`、`1,2`、
   两位一拼的 `0102`；多段（`1-2,5-6`）按最大跨度放入并写 `warnings`；超过 20 节判为脏数据（计数加 `warnings`）。
7. **开学日与总周数**：上游固定 `semesterTotalWeeks: 20`（第 476 行）；开学日取校历第一周的 `rq` 首段，
   没有则取 `zcrq`、`ksrq`，原样当开学日，不回滚到周一；找不到第 1 周时拿第一行顶替（第 356 行）。
   移植件：开学日回滚到当周周一，第 1 周日期不在开学锚点 45 天内的不采用（它给的周数一并作废）；
   总周数取校历最大周次，没有则 20，再被课表更晚的周次顶高（上限 30）；取不到就按学期序号推算。
   所有推算、作废与抬高都写进 `warnings`。上游「拿第一行顶替」没有移植 —— 宁可推算也不写错日期。
8. **节次时间**：上游先取 `skxxMobile_cxRsdjc`，解析失败时用 `FALLBACK_TIME_SLOTS`；移植件完全一致，
   只是把「不合法就整张弃用」的判定挪进 `parse.js`。
9. **学生信息不带出**：课表响应里的学生信息字段，移植件只按白名单重建排课行，`sjkList` 只留课名。
10. **学期名**：上游没有学期名这个概念；移植件从下拉框文本取（§4 第 7 条）。

## 7. 合并等价性（对齐上游 `mergeAndDistinctCourses`）

上游两阶段：阶段一按（课名、教师、教室、星期、周次串、起始节）排序，同课、同星期、同周次且节次首尾相接就合并；
起止节完全相同的行丢掉。阶段二按（课名、教师、教室、星期、起始节、结束节）排序，同一个 slot 的周次取并集。

移植件（`parse.js`）：

- 合并前先去掉完全相同的行（`dropExactDuplicates`）。上游只跟当前合并中的那条比，合并之后才出现的重复会漏网
  （如 1-2、3-4、3-4），这里提前整批去重。
- 阶段一 `mergeStageOne`：只有 `current.end + 1 === next.start` 才合并。
- 阶段二 `mergeStageTwo`：同 slot、同起止节的周次取 `unionWeeks`（去重后排序）。
- `courseOf` 把同名同教师的行归到同一门课下面，多个时段作为多个 block。

差异只在分组粒度（我们按课程对象分组，上游每个合并行一个对象）与「缺教师 / 缺教室的行上游会丢、我们保留」。
`merge` 用例钉住连续节次合并、同节次周次并集、完全重复行去重三条路径。

## 8. 变异测试记录

变异改的是**副本**：每个变异在临时目录里是整目录复制（目录名仍为 `jsei`，`manifest.key` 才能对上），只替换副本的
`parse.js`；真文件 `jw-adapters/jsei/parse.js` 没有被变异脚本写过。每处替换要求恰好命中 1 次。每个副本都跑
`check.js`。真文件变异前后各查一次 SHA-256，都是
`478014d682553f5f06127cbc95edd0e3c65d62b70a5217cdb7707c2c14da9142`。

| 变异 | 改了什么 | 变红的 fixture |
|---|---|---|
| M1 | 学校 11 节表第 2 节开始时间 `09:20` 改为 `09:25` | basic、merge、calendar-weekday、no-calendar-week20、long-name-missing、week-markers、weeks-total、overweek（全部：每个用例都钉着 11 节表） |
| M2 | 学校 11 节表第 11 节下课 `20:40` 改为 `20:30` | 同上 8 个 |
| M3 | 提醒里课名截断长度 `MAX_NAME_IN_WARNING` 20 改为 40 | long-name-missing（长课名提醒的文本变了；仍 ≤200 字，但期望对不上） |
| M4 | 缺教师不再计入汇总提醒 | basic、long-name-missing（「没有教师姓名」那条提醒消失） |
| M5 | 校历首周日期不回退到周一，直接当开学日 | calendar-weekday（firstDay 变成 2026-09-09，应为 2026-09-07） |
| M6 | 课表更晚的周次不再抬高总周数 | overweek（totalWeeks 停在 20，应为 22） |
| M7 | B1：前缀单/双标记不再贴到后一段，退回「就近向前并」 | week-markers（`(单)1-8周,(双)9-16周` 的第二个前缀标记被并到前一段，1-7 单周 + 10-16 双周的期望对不上） |
| M8 | 「共 N 周」完全不删（上游同源修正缺失） | weeks-total（末尾的 16 被当成周次，单周课多出第 16 周、双周课被撑成 2-16） |
| M9 | B3：退回「共 + 数字 + 到结尾」的贪婪写法 | weeks-total（`1-8周(共8周),9-16周` 的 9-16 被整段删掉；`共16周,1-15周(单)` 整行没有周次而丢课） |

副本 `parse.js` 的 SHA-256（供复核）：

- M1 `dd44d40357d48c1a8d01bf45549bbe771c5b4dddc9bace69ca66a8d4c0b1e512`
- M2 `672b3727b1ae47c70d1457921981e655e9412dcbbb9e00792b38d72109aff993`
- M3 `24a3df0579a83b93be20ba64e082499ac4385700e8933296cc4d72ddaf8074f7`
- M4 `2b11f5b01b92bb74fe3ed425251a53a2dd81ec261f7a65513708f123fdf17575`
- M5 `23a1f5354aab78c5bdd6e6027d52a6a69ce8e8f05974b610eab49a9a51276617`
- M6 `c01361e8c319fa2062a91cfe54ac5580c6968384d66f4a2c365f137fd57c280f`
- M7 `e942fd147f0dcdedaa20488af936969ea0794e029412a0b127ba2cc7c5e92fbf`
- M8 `6db5c2a6ec4fa984f558de15d8fc46b21164eb85f52102b179b4f04079ec98de`
- M9 `3d6928d953cb3f9db6fe38a374b519f86c79f6e681279cf2d7b651f883a71eea`

还原校验：变异全部在副本上完成，真文件未改动（SHA-256 与变异前一致），真文件跑 `check.js` 为 `RESULT: PASS`，
8 对 fixture 全部 MATCH。

## 9. 已知风险与未验证项

1. **真实部署未验证**：我们没有本校账号，`extract.js` 只在桩环境里跑过（请求路径、请求体、交出去的形状），
   没有在真实教务页面上执行过。fixture 是合成的（按上游脚本实际读取的字段形状编），只保证「同样的输入永远得到
   同样的输出」，**不保证解析在真实页面上是对的**。拿到真实响应后替换 fixture 并重跑 `check.js` 是最高优先级的贡献。
2. **WebVPN 入口路径**：`loginUrl` 与 `scheduleUrlHint` 用的是任务卡给的 `jwpd-443.webvpn.jsei.edu.cn` 映射主机，
   `/jwglxt/...` 路径与校园网直连主机一致这一条是按上游 `BASE_URLS.webvpn` 推断的，没有实际走一遍 WebVPN 认证。
   若学校 WebVPN 对路径另有改写（例如再加一层 `/https/` 前缀），`jwBase()` 会跟着当前地址里的 `/jwglxt/` 段走，
   但首页地址本身仍需真机确认。
3. **`xqh_id=1`**：节次时间请求固定带 `xqh_id=1`，照上游。若本校有多个校区、作息按校区不同，这里可能拿不到
   对应校区的节次时间；取不到时整张回落到 11 节表并提醒用户核对。
4. **11 节作息表**：逐节照抄上游 `FALLBACK_TIME_SLOTS`，没有用学校官方作息核对过。
5. **学年学期下拉框**：假设课表页上有 `#xnm` / `#xqm` 两个下拉框（正方 jwglxt 通用）。页面上没有时会去取一次
   课表首页；首页结构被改过就会报「没读到学年学期」。
6. **校历字段覆盖**：`calendarInfo` 认 `zrq` / `zcrq` / `rq` / `ksrq` 四个日期字段，fixture 只用到 `zrq`；
   `zsmc` 分支也只靠代码阅读验证。
7. **`MAX_PERIOD=20`**：课表节次超过 20 的行会被判为脏数据并计数提醒，不会导入。
8. **`warnings` 溢出计数差 1**：`warn()` 到第 20 条后不再追加，最后一格被替换成「另有 N 条…」，第 20 条本身也被
   换掉，文案少算一条。这是模板同款行为，本批没有改（需要一份超过 20 条的 fixture 才钉得住）。交主调度决定是否统一修。

## 10. 签名

- 上游出处：`shiguang_warehouse` → `resources/JSEI/jsei_01.js`（快照 commit
  `c4a35feb061a3f6db2d6c122927083c067c61309`，2026-10-19；本校脚本 `4570e79`，2026-10-14，MIT）
- 上游作者：星河欲转
- 移植者：0x7E7-2023（haiku 移植，2026-10-19）
- 本件的安全结论：**可以进内置库**（§3 八条全过，§4 十条逐条落实）

## 修订 1.0.1（2026-10-27）：无逗号的前置单双标记

- 问题：`(单)1-8周(双)9-16周`（前置标记、两段之间没有逗号）里的第二个标记前面紧挨「周」，被当成上一段的后缀，两段并成「单双都有」，整门课读成 1-16 周每周都上（批次十八 `jxfu`、批次十九 `smu` 审计发现，探测后确认本件同样如此）。
- 修正：`weeksOf` 里夹在两段中间的标记，若它所在的这一段以前置标记开头，就判给下一段；否则仍按后缀归上一段，`1-8周(单)9-16周(双)` 等后置写法不受影响。段间只有空格的 `(单)1-8周 (双)9-16周` 也一并读对。
- 回归：差分测试（`.test/fix-prefix/diff.js`）对 32 种其它周次写法比对修订前后输出，修订前读对的全部一字不差；7 种无逗号前置写法读出的周次与手推一致，整份输出与修订前代码对等价后置写法的输出一致。
- 新增 fixture `weeks-prefix-glued`：期望取修订前代码对等价后置写法 `1-8周(单),9-16周(双)` 的输出（该写法修订前已正确）。
- 版本 1.0.0 → 1.0.1。
