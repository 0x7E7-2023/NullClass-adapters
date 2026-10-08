# 安全审计 —— 贵州大学（正方新版 jwglxt 平台）

审计对象：`jw-adapters/gzu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本。本文件与当前代码一致；代码改动后需同步更新。

## 1. 来源

- 上游：shiguang_warehouse `resources/GZU/gzu.js`，快照 `ff72d1f08782df965cae110034a9d87cd91e0c07`（2026-10-08 读取），MIT，作者 Daoguan-king。
- 上游署名保留在两处：`extract.js` / `parse.js` 文件头，以及 `manifest.json` 的 `author`（「上游 Daoguan-king（MIT）；移植 0x7E7-2023」）。
- 结构来源：模板件（同批次中已审计的正方新版适配器目录）。只借结构与通用解析函数；学校常量、接口、作息表全部按上游重新核对。
- 平台：正方新版教务（jwglxt），上下文路径 `/jwglxt`，教学主机 `zhjw.gzu.edu.cn`。
- 版本 1.0.0，minAppVersionCode 11，`allowHosts` 为空数组（只请求页面所在的教务同源主机）。

## 2. 文件

| 文件 | 说明 |
|---|---|
| manifest.json | 适配器元数据；fixtures 列 8 对 |
| extract.js | 在用户已登录的教务页面里取数，只交出原始数据（ES5） |
| parse.js | 纯函数：读 `__ncInput`，返回载荷 JSON 字符串（ES5，CI 用 Rhino 解释执行） |
| AUDIT.md | 本文件 |
| fixtures/ | 8 对 `*.extracted.json` / `*.expected.json`，全部为合成数据，期望值手工推出 |

## 3. 请求清单（与 extract.js 逐条一致）

| 序号 | 方法 | 路径（`jwBase()` 之后） | 请求体 | 失败时 |
|---|---|---|---|---|
| ① | GET | `/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 无 | 页面上已有 `#xnm` / `#xqm` 时不发；否则读不到学期就报错 |
| ② | POST | `/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | `xnm=<学年>&xqm=<学期代号>&kzlx=ck&xsdm=&kclbdm=` | 非 2xx 报错；返回的不是含 `kbList` 数组的 JSON 报错 |
| ③ | POST | `/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | `xnm=…&xqm=…&xqh_id=<排课行里的校区代号>` | 任何失败 → null |
| ④ | POST | `/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | `xnm=…&xqm=…` | 任何失败 → null |

- `jwBase()` 取当前页面的 origin 加 `/jwglxt`；地址里若挂在更长的前缀下，跟随那段前缀。
- ② 的请求体与上游 GZU 脚本第 157 行一致，没有 `kclxdm`。
- 四个请求都带 `credentials: 'include'`，即浏览器里用户自己的登录 cookie。脚本不设置、不读取任何 token 或 cookie。
- 上游只请求课表这一条接口，学期由用户手选，学期代号按上游 `getSemesterCode` 写死映射。本版改为读页面下拉框；③④ 是为作息表与开学日多取的同族只读接口（见第 8 节）。

## 4. 读取与导出的数据

| 来源 | 读取的字段 | 导出位置 | 说明 |
|---|---|---|---|
| 课表首页下拉框 | `#xnm`、`#xqm` 的值与显示文字 | `term.xnm`、`term.xqm`、`term.xnmText`、`term.xqmText` | 学期名由此而来 |
| ② 课表 JSON 的 kbList | kcmc、xm、cdmc、xqj、jcs、zcd、xqh_id | `raw.kbList`（每行只含这 7 个字段） | 其余字段一律不带出 |
| ② 课表 JSON 的 sjkList | kcmc、zcd | `raw.sjkList`（每行只含这 2 个字段） | 集中实践课 |
| ② 课表 JSON 的记录总数 | total / totalResult / totalCount / count 之一 | `total` | 与 kbList 行数对账用 |
| ② 的排课行 | xqh_id 的第一个非空值 | `campusId` | 校区代号，不是个人信息 |
| 设备本地日期 | — | `today` | 不含个人信息 |
| ③ 作息 JSON | 原样 | `periodTimes` | 没有字段白名单，见第 11 节第 3 条 |
| ④ 校历 JSON | 原样 | `calendar` | 同上 |

不导出：学号、姓名、性别等学生基本信息（本版不请求学生信息接口）；cookie、token、登录凭据；kbList 与 sjkList 白名单之外的字段。

## 5. 手册 §5 八项红线

| 项 | 结论 | 依据 |
|---|---|---|
| 1. 不处理凭据 | 通过 | 不读密码框、不读 cookie、不存 token；登录由用户在页面里手工完成。凭据关键字 grep 无命中（parse.js 里的 token 是周次文本分词的局部变量） |
| 2. 只请求本校教学主机 | 通过 | 地址由当前页面的 origin 加 `/jwglxt` 拼成，不写死主机名；`allowHosts` 为空；没有绝对 URL 请求（grep 只命中文件头注释里的仓库地址） |
| 3. 只读课表 | 通过 | 只有 xskbcx 系列查询接口，没有增删改接口，没有表单提交 |
| 4. 不带出学生个人信息 | 通过（有一处保留，见第 4 节） | 排课行与实践课行做字段白名单；不请求学生信息接口 |
| 5. 无统计与埋点 | 通过 | grep analytics / track / beacon / gtag 无命中；请求目标只有教务同源 |
| 6. 不用 eval 与 new Function | 通过 | grep 无命中 |
| 7. 不写 DOM、不提交表单 | 通过 | 课表首页 HTML 只用 DOMParser 解析，不挂入文档，DOMParser 文档不执行脚本；`innerHTML` / `outerHTML` / `document.write` / `submit` 无命中，`.value` 只读 |
| 8. 无硬编码密钥与他人学号 | 通过 | 代码里没有密钥；长数字串只命中 86400000（一天的毫秒数常量） |

## 6. 本批专项检查表（1–6）

1. **上下文路径**：通过。本部署是 `/jwglxt` 路径，`jwBase()` 拼的是 `/jwglxt`，不是根路径部署；地址里有更长前缀时跟随前缀。
2. **菜单号与请求体**：通过。课表请求的菜单号 N2151 与请求体 `xnm / xqm / kzlx=ck / xsdm= / kclbdm=` 与上游逐字一致，没有 `kclxdm`。作息与校历两个附加接口的菜单号照同族正方脚本，未在本校上游验证（见第 11 节）。
3. **作息表逐节核对**：通过。`SCHOOL_PERIOD_TIMES` 11 项与上游 TimeSlots（第 206–219 行）逐项一致（08:00-08:50 至 21:30-22:20，每节 50 分钟）。`MAX_PERIOD` 注释写的是「这所学校作息只有 11 节」。课表用到超出作息表的节次：calendar-extra（数字电路 `11-12` 节，第 12 节顺推成 22:25-23:10）与 short-table（第 5–15 节：内置表与顺推两条分支都走到，第 15 节越界）覆盖，并由 M2 变异验证。
4. **跨域登录**：不适用。loginUrl 与教务主机同为 `zhjw.gzu.edu.cn`，没有 CAS 跨主机跳转，`allowHosts` 保持为空。登录页判断保留模板件的 `login_slogin.html` 检查（上游没有这一检查，是模板件带来的）。
5. **模板件残留**：通过。对 gzu 目录（含本文件）做全目录搜索：模板件的学校名、key 与教务主机名均无命中，结果见第 10 节。
6. **其余**：通过。
   - 周次四写法与括号序号：weeks-forms 用例 12 行覆盖「1-16周(单)」「(单)1-16周」「1-16(单周)」「1-3,5-9周」、括号里的教学班序号、单双同现、只有「单周」、起始周 0。
   - 周次括号（X1）：weeks-brackets 用例覆盖「(1-16周)」整段保留、「1-16周(1,2)」与「1-16周(3组)」删括号不粘连（不出现 161、163）、「(1)1-16周」序号照摘、「1-16周(单)」仍是单周、括号没闭合的「1-16周(1,2」按逗号分段；落单括号「1-16周(3」读成第 1-16 周（删括号会粘成 1-163）；括号备注写进 warnings。
   - 校历超出上限：calendar-clamp 用例（校历第 32 周）封顶为 30 周并写 warnings；开学日取校历第 1 周的周一。
   - warnings 不超过 20 条、每条不超过 200 字：check.js 校验，parse.js 的 `warn()` 也封顶。
   - `HH:mm` 合法且 end > start：check.js 校验；作息表 11 项全部符合。
   - 学期名取自教务下拉框的学年学期文字，不用适配器名。
   - teacher / location 缺失为 null：basic 用例里大学体育(一) 无教师、思想道德与法治 无教室，输出为 null；check.js 拒绝占位词。
   - 期望值手工推出，并有 M1–M3 与 X1-a、X1-b、X2-a、X2-b 变异测试（第 9 节）。
   - ES5：extract.js 与 parse.js（含注释）grep 无命中。
   - 控制字节、BOM：check.js 校验，通过。

## 7. 与模板件的差异

- `manifest.json`：key、name、initial、author、homepage、loginUrl、scheduleUrlHint、minAppVersionCode、allowHosts、fixtures 全部改为贵州大学的值。
- `extract.js`：头部注释与引用改为 GZU 上游；接口注释改为本校菜单号；新增 `pickFields` 字段白名单（排课行 7 个字段，实践课 2 个字段）。学期读取、请求封装、登录页检查等取数函数与模板件一致。
- `parse.js`：
  - 删除模板件原有的 12 节作息表，换成本校上游的 11 节表 `SCHOOL_PERIOD_TIMES`；
  - 保留 12 节空课内置表 `BUILTIN_PERIOD_TIMES`（与空课应用的默认节次时间 DefaultPeriodTimes 逐节相同）作为补表来源：课表用到超出作息表的节次时，内置表同一节的开始不早于上一节下课才用，否则在上一节下课后顺推（课间 5 分钟、每节 45 分钟）；顺推越过 23:59 就从这一节起不再补，课程照常导入，写进 warnings（统一修订 H3，见第 12 节）；
  - `MAX_PERIOD` 注释改为 11 节；
  - 校历第 1 周日期不属于这个学期时，周数清零，不沿用教务给的周数；
  - 汇总 warnings 的分支顺序与文字调整（周数来源、校历被拒、补表说明）。
  - 周次解析、节次解析、课程合并、warnings 上限等函数与模板件相同。
- `fixtures/`：8 对全部按本校合成数据重做（short-table 为新增，见第 12 节；weeks-brackets、calendar-clamp 为新增，见第 13 节）。

## 8. 上游的删改及理由

行号指快照 `ff72d1f0` 中的 `GZU/gzu.js`。

- **删除三处交互弹窗**（第 121、130、140 行：showAlert / showPrompt / showSingleSelection），以及第 191–268 行的全部 showToast 与第 269 行的 notifyTaskCompletion。理由：适配器只取数，不与用户交互。
- **不再手填「起始学年」再选「第一/第二学期」**，改为读页面上的 `#xnm` / `#xqm`（用户在教务页面里切过的学期优先）。理由：页面上的选择才是用户看到的学期，手填容易选错。要别的学期，用户在页面里切换后再提取。
- **删除按学期序号写死的学期代号映射**（`getSemesterCode`：第一学期为 "3"，其余为 "12"）。理由：学期代号由页面下拉框给出，不再猜。
- **周次解析**：上游只认「(单)」「(双)」括号写法，外加两个正则（「N-M周」与「开头 N 周」）；其余写法会整段丢掉或塌成每周。改为四种单双写法、括号序号、括号内的周次（「(1-16周)」）、混排、取值范围裁剪的周次解析；括号备注（「(3组)」）整组忽略并写入 warnings；所有丢弃都计数写入 warnings。
- **六字段必填规则**：上游要求 kcmc、xm、cdmc、xqj、jcs、zcd 全部非空，缺教师或缺教室的课整行丢掉。改为只要求课名、星期、节次、周次；教师与教室缺失留 null，课不丢。理由：不许静默丢课。
- **开学日与总周数**：上游 config 里 `semesterStartDate: null`，本版保留「校历优先、推算兜底」，推算时一律写 warning，不猜。上游 `semesterTotalWeeks: 20` 保留为兜底总周数。
- **firstDayOfWeek**：上游没有，本版也不写；开学日回退到所在周的周一由 parse.js 计算。
- **登录页检查**：上游没有，本版保留模板件的 `login_slogin.html` 检查。这是新增，不是删除。
- **作息表**：上游第 206–219 行的 11 节表原样保留为 `SCHOOL_PERIOD_TIMES`，没有删改。
- **校区分支**：未移植。本学校上游没有这类逻辑，批次基线 diff（ZCMU）只作参考，没有照搬。
- **附加接口**：作息表（Rjc）与学期周次校历（Zccx）是上游没有的、从同族正方脚本取来的只读接口，失败回落，不影响课表。

## 9. 变异测试

本轮基线：仓库内的 `jw-adapters/gzu/parse.js`，sha256 `147e42cc486d6906e7d1eea0f666ac6b64f8ea25ba0d6041aaa71a70b42b24fa`。上一轮（统一修订 H1–H4 之后）的 parse.js sha256 为 `ade273dbad4fc7f71195fcb162243fb6d97dde414d001e9e033897d36502cb7d`（备份文件已删除，只保留此记录）。修订前的旧版 parse.js sha256 `cdd2598…2b185` 已作废。

| 编号 | 改动（第二轮均在副本上做） | 位置（parse.js 行） | 应变红的用例 | 结果（check.js） | 还原 |
|---|---|---|---|---|---|
| M1 | 第 11 节开始时间 21:30 改为 21:40 | 第 53 行 | 用学校作息表的用例 | FAIL (6)：basic、weeks-forms、second-term、calendar-weekday、weeks-brackets、calendar-clamp 变红；calendar-extra、short-table 仍 MATCH（二者都用教务给的作息表） | 副本丢弃，原文件不动 |
| M2 | H3「内置表开始不早于上一节下课」判断改为恒真：`minutesOf(builtin.start) >= prevEnd` 换成 `true` | 第 625 行 | 超出作息表的节次、且内置表与上一节重叠的用例 | FAIL (2)：calendar-extra（第 12 节被用内置 21:15，与第 11 节 22:20 重叠）与 short-table（第 5 节被用内置 14:00，与教务第 4 节 14:20 重叠）变红；其余 MATCH | 同上 |
| M3 | 单周过滤关闭：`if (onlyOdd && week % 2 === 0) continue;` 换成 `if (false) continue;` | 第 348 行 | 含单周写法的用例 | FAIL (6)：basic、weeks-forms、calendar-extra、second-term、calendar-weekday、weeks-brackets 变红；short-table 没有单双周写法，仍 MATCH | 同上 |
| X1-a | 删「周」提到括号处理之前：`cleaned = fullWidthToHalf(cleaned);` 换成 `cleaned = fullWidthToHalf(cleaned).replace(/周/g, '');` | 第 285 行 | 括号内是周次的用例（「(1-16周)」） | FAIL (1)：weeks-brackets 变红；高等数学C 整门丢失，课程数为 6 门（应为 7 门）。check.js 每个用例最多打印 6 行，warnings 的差异没有打印出来 | 同上 |
| X1-b | 括号落单时直接删除、不换成逗号：`cleaned = cleaned.replace(/[()]/g, ',');` 换成 `cleaned = cleaned.replace(/[()]/g, '');` | 第 305 行 | 括号没闭合的「1-16周(1,2」（操作系统原理）、落单括号的「1-16周(3」（程序设计基础，第 13 节新增） | FAIL (1)：weeks-brackets 变红；操作系统原理 变成 1–30 周（「1-161,2」被当成 161 周后裁到 30），程序设计基础 变成 1–30 周（「1-163」裁到 30），总周数抬到 30，warnings 变为 7 条（应为 6 条）。成对的「1-16周(1,2)」那一行没有变红，因为第一步已先把它处理掉（见第 13 节） | 同上 |
| X2-a | 开学日推算提醒改回上一轮写法（加入「学期周次校历接口没有返回可用数据」） | 第 656 行 | basic、weeks-forms、weeks-brackets（提醒第 2 条） | FAIL (3) | 同上 |
| X2-b | 总周数封顶提醒改回上一轮写法（「载荷上限」「截断」） | 第 674 行 | calendar-clamp（提醒第 3 条） | FAIL (1) | 同上 |
| ctrl | 不改动的副本 | — | — | PASS，8 个 fixture 全部 MATCH | — |

旧的 M2（补表「不重叠守卫」改恒真，FAIL 1）随守卫一起删除，由上面的 H3 变异替代。

第二轮的变异都在副本上做：把整个适配器目录复制到临时目录里的一次性子目录（副本目录名仍为 `gzu`），只改副本的 parse.js，对副本跑 check.js，跑完即删。变异的锚点文本必须在文件里恰好出现一次，否则拒绝改动。原目录的 parse.js 全程未改，sha256 始终为 `147e42…24fa`。最后一次 check.js 为 `RESULT: PASS`（见第 10 节）。

## 10. 自检结果

check.js 输出（第二轮修订之后，共 10 行）：

```
== gzu
  fixture fixtures/basic.extracted.json MATCH
  fixture fixtures/weeks-forms.extracted.json MATCH
  fixture fixtures/calendar-extra.extracted.json MATCH
  fixture fixtures/second-term.extracted.json MATCH
  fixture fixtures/calendar-weekday.extracted.json MATCH
  fixture fixtures/short-table.extracted.json MATCH
  fixture fixtures/weeks-brackets.extracted.json MATCH
  fixture fixtures/calendar-clamp.extracted.json MATCH
RESULT: PASS
```

- ES5 grep（extract.js 与 parse.js，含注释）：反引号、let / const、箭头函数、async / await、class、展开运算符、解构、默认参数、后行断言、具名分组、eval / new Function：全部无命中。
- 模板件残留搜索（gzu 目录全部文件，含本文件；搜索词为模板件的学校名、key 与教务主机名，本文件不逐字列出）：无命中。
- 红线 grep：见第 5 节。
- 旧的页面叫法（parse.js、extract.js、fixtures 中的搜索）：无命中。
- 开发者用语 grep（parse.js）：命中的行全部是注释，warnings 文字里没有。
- 行尾：parse.js、extract.js 全为 CRLF，没有单独的 LF。
- `node --check extract.js`：通过（退出码 0），X3 之后执行。
- extract.js 里的 HTTP 与 JSON：grep HTTP 无命中；grep JSON 命中 3 行：第 26 行（注释里的接口说明）、第 100 行 `JSON.parse`、第 241 行 `JSON.stringify`。后两处是代码调用，不是给学生看的文字。

## 11. 已知风险与未验证项

1. **没有真实教务样本**。所有 fixture 都是合成的，期望值按规则手工推出，不是抓真实页面得到的。真实页面的字段形状、编码、空值写法都可能与合成数据不同。
2. **附加接口未在本校验证**。作息表（Rjc，菜单 N2151）与学期周次校历（Zccx，菜单 N2154）照同族正方脚本写的；本校是否装了这两个菜单未知。取不到时回落到内置作息表与推算开学日，并在 warnings 里说明。
3. **附加响应原样交出**。作息与校历两个响应没有字段白名单。按设计它们只含全校数据，但没有抓到真实响应确认；若接口返回了个人字段，会原样带出。
4. **`xqh_id` 参数未核对**。③ 请求体里的 `xqh_id` 与模板件的写法相同，上游 GZU 没有这个请求，本校是否需要未知。失败就回落，不影响课表。
5. **开学日推算的锚点未核对**。锚点（每年 9 月 1 日、次年 2 月 20 日、次年 7 月 1 日，取所在周的周一）来自模板件，未对照本校校历。推算时必有 warning。
6. **学期代号不再写死映射**。学期名取页面文字。若页面下拉框的代号或文字与预期不同（例如小学期），学期名会照实显示，但未验证。
7. **时区与日期**。`today` 取设备本地日期，parse.js 按 UTC 日期运算。跨时区与跨零点的边界未验证。
8. **warnings 文字瑕疵（已解决，统一修订 H3）**。原先补表只补一节时可能写成「第 12-12 节」。现在单节写「第 N 节」、连续区间写「A-B」，不连续的段之间用「、」连接；calendar-extra（「第 12 节」）与 short-table（「第 5-14 节」「第 5-6、13-14 节」）覆盖这几种写法。
9. **extract.js 没有运行过**。只有 parse.js 经 check.js 在 CI 方式下跑过；extract.js 只做了 ES5 与静态检查，没有在真实或模拟的 WebView 里执行。
10. **越界节次的课没有时间**。顺推越过 23:59 的节次（short-table 的第 15 节）课程照常导入，但这一节没有时间：节次模式下落在周视图网格外，时间轴模式下不画。warnings 已说明，需用户在学期管理里补上。应用的载荷校验只检查 endPeriod ≥ startPeriod，不检查节次是否在作息表内，所以这条课能导入。

## 12. 统一修订（H1–H4）

依据：`.test/port-batch5/harmonize-zf.md`（主调度定稿，只读）。逐条核对：

| 条目 | 状态 | 说明 |
|---|---|---|
| H1 校历第 1 周日期被拒时，校历周数也作废 | 原已有（`calendarInfo` 里 `info.weeks = 0`）；提醒文字本次新改 | 新增「教务校历不属于这个学期（见上一条）…」分支；short-table 钉住 |
| H2 「抬高总周数」的提醒按来源分开写 | 校历给了周数的分支原已有；「校历没给 / 被作废」分支本次新改 | 不再出现「一学期是 0 周」；second-term 改用新分支文字 |
| H3 超出作息表的节次怎么补时间 | 本次新改，替换了原来的「不重叠守卫」 | 见第 7 节；变异见第 9 节 M2；calendar-extra、short-table 覆盖 |
| H4 提醒里写「学期管理」 | 原已有；本次 grep 核对 | parse.js、extract.js、fixtures 中均无旧的页面叫法（本文件也不逐字写出该叫法） |

期望值变了的 fixture 及原因（按新规则手推后更新）：
- `calendar-extra`：第 12 节原先补不上（与第 11 节重叠）。现按 H3 顺推成 22:25–23:10，`periodTimes` 增一项；第 4 条 warning 改为补时间的说明；`_case` 同步。
- `second-term`：校历被判为不属于本学期，课表到第 21 周。第 3 条 warning 改为 H2 第二分支的文字，其余不变。
- `short-table`（新增，第 6 对）：教务只给 4 节作息（第 4 节止于 14:20），校历被拒。钉住 H1 分支、H3 的内置表分支（第 7–12 节）与顺推分支（第 5–6、13–14 节），以及 H3 越界（第 15 节不补、课程照常导入）。

需要主调度确认的判断：
1. 校历被拒、但课表超过 20 周：总周数的提醒用 H2 第二分支的文字，不再重复校历被拒的原因（原因见上一条）。
2. 补时间的提醒里，内置表那半句在前、顺推那半句在后（按 H3 规定的顺序）。
3. 不连续的顺推段用「、」连接（short-table 中为「第 5-6、13-14 节」）。
4. check.js 与应用的 `JwSchedulePayload.kt` 校验都只看 `endPeriod ≥ startPeriod`，不检查节次是否在作息表内，所以越界节次的课能导入（见第 11 节第 10 条）。

## 13. 第二轮修订（B2 / X1 / X2 / X3）

依据：`.test/port-batch5/harmonize-zf-2.md`（只读）与 `.test/port-batch5/fix-common.md`。改动只涉及 parse.js、fixtures、manifest.json 与本文件。

| 条目 | 状态 | 说明 |
|---|---|---|
| B2 模板件残留 | 完成 | parse.js 第 56–58 行与第 77 行的注释不再点名模板。第 56–58 行改为「与空课应用的默认节次时间（DefaultPeriodTimes）逐节相同」，12 项已逐项核对。这些只是注释，行为没有变，所以没有对应的变异，验收靠 grep 与 check.js。第 6 节第 5 条、第 7 节第 88 行同步改写。 |
| X1 周次括号 | 完成 | `weeksOf`（parse.js 第 285–307 行）分三步：①括号一对一对处理。只含数字、区间、逗号的整组摘掉并计为序号；含备注字符（如「组」）的整组摘掉并计为备注；其余保留内容，两侧换成逗号。②删「周」。③落单的括号换成逗号，不直接删，避免「1-16(1,2」粘成 161。用例：weeks-brackets 里不闭合的「1-16周(1,2」（操作系统原理）与落单的「1-16周(3」（程序设计基础，新增）钉第 3 步，X1-b 变异两条都变红。备注的计数与提醒在第 757–759 行。 |
| X2 提醒文案 | 完成 | 四处提醒去掉「接口」「载荷」等实现用语，见下表。 |
| X3 报错文案 | 完成 | extract.js 第 67 行（HTTP 报错）改为「教务系统返回错误（代码 N）：…」；第 176 行（课表格式不对）改为「教务系统没有返回课表数据（返回的内容格式不对）：…」。冒号后的半句不变。check.js 不运行 extract.js，本项没有变异测试，验收靠 node --check 与 grep（见第 10 节）。 |

| 位置（parse.js 行） | 上一轮 | 本轮 |
|---|---|---|
| 开学日推算（656 行） | 教务系统没有给出开学日期（学期周次校历接口没有返回可用数据），第 1 周按「…」推算为… | 教务系统没有给出开学日期，第 1 周按「…」推算为… |
| 学期总周数（683 行） | 学期周次校历接口没有返回可用数据，学期总周数按适配器内置的 20 周导入… | 教务系统没有给出学期校历，学期总周数按 20 周导入… |
| 节次时间（690 行） | 教务的作息时间接口没有返回可用的作息表，已用适配器内置的 11 节作息表（第 1 节 08:00-08:50）… | 教务系统没有给出节次时间，已按适配器内置的 11 节节次时间导入（第 1 节 08:00-08:50）… |
| 总周数封顶（674 行） | 学期总周数取自教务校历（30 周），已按载荷上限 30 周截断，… | 学期总周数取自教务校历（30 周），已按最多 30 周导入，… |

上游脚本那句「没有作息表」不在 gzu 的 parse.js 里，X2 替换表的这一行不适用。

期望值变化（只有提醒文字与新增用例，载荷不变）：
- `basic`、`weeks-forms`：提醒文件第 7–9 行（开学日、学期校历、节次）。
- `calendar-weekday`、`second-term`：提醒文件第 9 行（节次）。
- 新增 `weeks-brackets`：7 门课（第 7 门「程序设计基础」用落单括号「1-16周(3」钉第 3 步，读成第 1-16 周）、6 条提醒，括号序号 2 处、括号备注 1 处。
- 新增 `calendar-clamp`：校历第 32 周封顶为 30 周，开学日取校历第 1 周的周一，4 条提醒。

有意未改（不在 X2 替换表内）：
- 校历存在时的开学日提醒「开学日期取自教务系统的学期周次校历」（parse.js 第 648 行），calendar-extra、calendar-weekday、calendar-clamp 用到。
- 补时间提醒里的「作息表」字样（parse.js 第 703 行）。

变异测试结果见第 9 节（X1-a、X1-b、X2-a、X2-b 为本轮新增）。

需要主调度留意的点：
1. 残留搜索覆盖 gzu 目录全部文件（含本文件），本文件不含搜索词，不需要排除任何文件。
2. X1-b 的成对行「1-16周(1,2)」不会变红：第一步先把它处理掉。X1-b 钉住第 3 步靠的是两条落单括号：不闭合的「1-16周(1,2」（操作系统原理）与「1-16周(3」（程序设计基础）。
3. 第 7 节第 88 行的 BUILTIN 来源说明超出「第 56–58 行与第 77 行」的范围，这里一并改了。
4. M1 变红的用例由 4 个增为 6 个（新增的 weeks-brackets、calendar-clamp 都回落到学校作息表）；M3 由 5 个增为 6 个（weeks-brackets 含「(单)」）。
5. 第 9 节的基线改为仓库内的 parse.js；上一轮 parse.js 只保留 sha256 记录，备份文件已删除。
6. 第 9 节的表原来没有表头，本轮补上。
7. extract.js 的 grep 口径：X3 之后，学生可见的报错文字里已没有 HTTP 与 JSON；但 grep JSON 仍命中第 100 行 JSON.parse 与第 241 行 JSON.stringify（代码调用，不是文案）。按 X3 的字面规则（HTTP、JSON 只能命中注释）这两处无法满足，未改代码，请主调度确认口径。

## 14. 签名

0x7E7-2023（haiku 移植，2026-10-08）
