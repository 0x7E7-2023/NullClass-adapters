# 安全审计 —— 上海中侨职业技术大学（正方新版 jwglxt 平台）

审计对象：`jw-adapters/shzq/` 下的 `extract.js` / `parse.js`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `resources/SHZQ/shzq.js`（快照 commit `ff72d1f08782df965cae110034a9d87cd91e0c07`，
2026-10-08，MIT，作者 Kredenk，共 291 行）。

结论：按移植手册 §5 八项检查逐条通过。适配器只向本校教务主机发同源请求，只读课表与同模块的作息、校历；
不读凭据，不外发，不埋点，不 eval，不写页面。拿不准的点见第 9 节。

## 1. 静态扫描

- 绝对 URL：`extract.js` 与 `parse.js` 中只有 `https://github.com`，位于文件头的出处注释。
- 网络调用：`extract.js` 只有一个 `fetch` 包装（`fetch(url, options)`）。`X-Requested-With: XMLHttpRequest`
  是请求头，不是 XHR 对象。没有 `sendBeacon`、`WebSocket`、图片 `src` 赋值。`parse.js` 没有任何网络调用。
- 凭据与存储：两个文件里没有 password、pwd、localStorage、sessionStorage、cookie、token 的读取。
  `parse.js` 中的 `tokens` 是周次分词的变量名。`extract.js` 设置了 `credentials: 'include'`，
  这只让浏览器自动带上本校会话 cookie，脚本不读取 cookie。
- 埋点、eval、页面写入：没有 analytics、track、sentry、beacon、telemetry；没有 `eval(`、`new Function`；
  没有 innerHTML、表单赋值、submit、click、appendChild。`extract.js` 只读 `#xnm`、`#xqm` 两个下拉框的 value 与 option。
- 秘密：没有硬编码的学号、密钥、令牌。`extract.js` 与全部 fixtures 中没有 8 位以上的连续数字；
  `parse.js` 里只有两处 `86400000`（一天的毫秒数，用于日期运算）。

## 2. 请求清单（与代码一致）

请求地址由 `window.location.origin` 拼出（`jwBase()` = 当前页面源 + `/jwglxt`），主机名没有写死。
`manifest.json` 的 `allowHosts` 为 `["jw.shzq.edu.cn"]`，没有通配。

| 序 | 方法 | 路径（均在 `/jwglxt` 下） | 什么时候发 | 请求体 | 取到什么 | 取不到时 |
|---|---|---|---|---|---|---|
| ① | GET | `kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 页面上读不到学年学期时才发 | 无 | 返回 HTML 里 `#xnm`、`#xqm` 的学年学期 | 报错，提示重新登录并打开「学生课表查询」（`extract.js` 181–183 行） |
| ② | POST | `kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 必发 | `xnm`、`xqm`、`kzlx=ck`、`xsdm`（空） | `kbList` 排课行、`sjkList` 集中实践课 | 返回不是课表 JSON 时报错（200–202 行）；HTTP 非 2xx（74 行）、网络失败（82 行）也报错 |
| ③ | POST | `kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | 必发；失败不影响导入 | `xnm`、`xqm`、`xqh_id`（取自课表行的校区代号） | 校区作息（`periodTimes`） | 交 `null`，`parse.js` 回落到内置 12 节表，并写进 `warnings` |
| ④ | POST | `kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 必发；失败不影响导入 | `xnm`、`xqm` | 学期周次校历（`calendar`） | 交 `null`，`parse.js` 回落到推算，并写进 `warnings` |

与上游的对照（均在快照 `resources/` 下核对过）：

- 上游 SHZQ 脚本只有第 ② 条这一个请求（`SHZQ/shzq.js` 第 170 行）。请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=` 与本适配器逐字一致。上游没有 `kclbdm`。
- 第 ③ 条不在上游 SHZQ 里。快照中共 10 份脚本引用 `xskbcx_cxRjc.html`，其中 5 份带 `?gnmkdm=N2151` 字面写法，
  例如 `WENHUA/wenhua_01.js` 第 4 行、`NBUT/nbut.js` 第 171 行。
- 第 ④ 条不在上游 SHZQ 里。快照中共 31 份脚本引用 `xskbcxZccx_cxZcByXnxq`，其中 24 份带 `?gnmkdm=N2154` 字面写法，
  例如 `GDOU/gdouyj.js` 第 474 行。该脚本的路径前缀是 `/kbcx/`，与本适配器的 `/jwglxt/kbcx/` 不同，
  对照的是接口名与菜单号。
- 第 ③、④ 条的请求体字段名取自同族正方脚本的常见写法，只做了接口名层面的核对，没有逐份比对参数。
- 两条附加接口不是每个部署都装了对应菜单，所以一律按 best-effort 处理（见上表最后一列）。

**为什么 `allowHosts` 写 `jw.shzq.edu.cn`：**

- 登录页在 `cas.shzq.edu.cn`，与教务主机不同域。登录页主机由网络门自动放行（和 cqcivc、taru 一样），不用写进 `allowHosts`。
- 教务主机 `jw.shzq.edu.cn` 是唯一需要显式放行的主机，写精确主机名，不用通配（手册 §5 第 3 项）。
- 对比模板件：它的 `loginUrl` 与教务同在一个主机上，所以它的 `allowHosts` 留空。
- 如果学生经学校 WebVPN 等代理域打开教务，请求会跟随当前页面源。那个代理域不在 `allowHosts` 里，
  是新的审计对象，本次不覆盖，不能直接加进 `allowHosts`（手册 §5 代理域一节）。

## 3. 读到什么、带出什么

- 学年学期：`xnm`、`xqm`（代号）、`xnmText`、`xqmText`，交给 parse.js 作为 `term`。
- `kbList`（排课行）：每行只保留 `kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd` 六个字段（`extract.js` 的 `pickRows`）。
- `sjkList`（集中实践课）：每行只保留 `kcmc`。
- `campusId`：从原始排课行里读 `xqh_id`，取第一个非空值。它是第 ③ 条请求的参数，也原样放进交给 parse.js 的数据里（parse.js 当前不读它）；`xqh_id` 本身不进 `raw.kbList`。
- 学校级数据：作息（第 ③ 条）与学期周次校历（第 ④ 条）是教务返回的原始对象，原样交出；取不到就是 `null`。
- `total`：响应顶层的记录总数。依次找 `total`、`totalResult`、`totalCount`、`count`，取第一个能认成非负整数的值（`totalOf`），找不到交 `null`。parse.js 用它与排课行数对账，取少了就在 warnings 里说明。
- 响应顶层的其它键（上游 `xsxx` 之类的学生信息，若存在）不读取、不带出。响应顶层只读 `kbList`、`sjkList` 和上面那四个记录总数键。
- `today`：本机日期，只用于开学日推算。

验证方式：在 Node 里用桩对象（stub）替换 `window` 与 `fetch` 运行一次 `extract.js`，桩响应里夹带了虚构的学号、姓名、性别字段。
输出里没有这些内容，行的键集合正好是上面列出的六个与一个。运行脚本放在系统临时目录，不在仓库里。

## 4. 手册 §5 八项检查

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 通过 | 不读密码、表单值、存储、cookie；登录由用户在页面里完成 |
| 2 | 不外发 | 通过 | 唯一出现的外部地址是注释里的 GitHub 出处；请求全部同源 |
| 3 | 请求域可控 | 通过 | `allowHosts` 只有 `jw.shzq.edu.cn`，没有通配；第 2 节说明了代理域的边界 |
| 4 | 只读课表 | 通过（按接口名与用途判断） | 四条接口都是课表、作息、校历查询；没有成绩、学籍、缴费接口。真实返回内容未在真实环境核对 |
| 5 | 不埋点 | 通过 | 无统计、上报、遥测代码 |
| 6 | 不 eval 远程代码 | 通过 | 无 `eval`、`new Function`；返回的 JSON 只用 `JSON.parse` |
| 7 | 不写页面 | 通过 | 只读 `#xnm`、`#xqm` 下拉框，不改 DOM，不提交表单 |
| 8 | 无硬编码秘密 | 通过 | 无学号、密钥、固定令牌；fixtures 全为虚构数据 |

## 5. 与模板件的差异

- `allowHosts`：模板为 `[]`；本适配器为 `["jw.shzq.edu.cn"]`。原因见第 2 节（登录页与教务不同域）。
- 课表请求体：模板为 `…&kzlx=ck&xsdm=&kclbdm=`（模板件 `extract.js` 第 170 行）；本适配器为 `…&kzlx=ck&xsdm=`，与上游逐字一致。
- 上游作者：模板署名「上游 星河欲转（MIT）」；本适配器署名「上游 Kredenk（MIT）」，快照 `ff72d1f0…`。
- 作息表：模板件的 `SCHOOL_PERIOD_TIMES` 是模板学校的作息；本适配器换成上海中侨的 12 节（与上游 `presetTimeSlots` 逐字一致）。
- 超出作息表的节次：模板一律用空课内建节次表补（模板件 `parse.js` 第 576–583 行），不看补上的时间是否与上一节重叠；本适配器按第 7 节的 H3 规则补。
- 总周数：模板与本适配器都以 20 周为内置口径（`SCHOOL_TOTAL_WEEKS = 20`）。上游 SHZQ 脚本没有总周数，这个数字不是从上游来的。
- 附加接口：本适配器多了第 ③、④ 两条请求，和模板一样 best-effort。
- 登录页判断：本适配器检查 `cas.shzq.edu.cn/cas/login` 与 `login_slogin.html` 路径（`extract.js` 54–60 行）。

## 6. 上游删掉或改掉的东西及理由

以下每一条都在 `SHZQ/shzq.js` 里核对过行号：

- `getYearAndSemester`（第 128–165 行）：用弹窗让用户手填学年（`showPrompt` + `validateYearInput`），再选第一或第二学期（`showSingleSelection`）。
  **删。** 理由：导入前不打断用户；学年学期取自页面当前选中的学期，要别的学期时在教务页面里切换后再提取（手册 §3 第 1 步）。
- `demoAlert`（第 21 行定义，第 255 行调用）：启动时的弹窗。**删。** 理由：适配器不另开弹窗，提示统一写进 `warnings`。
  这个弹窗的具体内容没有保留在移植件里。
- 进度与结果提示 `showToast`（第 136、146、155、168、184、190、203、207、234、237、241、249 行等）和 `notifyTaskCompletion`（第 287 行）。
  **删。** 理由：适配器只输出数据，不直接驱动应用界面；结果由应用和 `warnings` 呈现。
- `saveCourses`（第 200 行）、`savePresetTimeSlots`（第 231 行）：直接写入应用的课表与作息。**删。** 理由：适配器只输出 payload，入库由应用完成。
- `importPresetTimeSlots`（第 212–245 行）中的「测试时间段导入」分支：**删。** 理由：调试用的分支，不带进正式适配器。
- 「未知课程 / 未知教师 / 未知地点」兜底（第 48–50 行）：**删。** 理由：会被课表当成真名显示。教师、教室拿不到时留 `null`；课名拿不到的行跳过并计入 `warnings`（手册 §4.7）。
- 节次只认 `1-2`、两位、四位三种写法，其它写法记为 0 并逐行打 `console.warn`（第 58–70 行）：**改。** 扩展到「第9-10节」「1,2」以及多段（`1-2,5-6`）；拿不到的节次进 `warnings`，而不是只打到控制台。
- 周次只认字样 `(单)` / `(双)`，并且只取第一个区间（第 71–98 行）：**改。** 扩展到四种写法；空格分段不丢周；括号里的纯数字当作教学班序号，不当作周次（上游会把 `(1)` 当成第 1 周）；`(1-16周)` 这类括号整段保留，`(3组)` 这类带备注字的括号整组忽略并提醒。
- 没有开学日、没有总周数（全文没有 `startDate`、`firstDay`、`totalWeeks`）：**补。** 优先取学期周次校历；取不到才推算，并写明推算依据。
- 上游 `presetTimeSlots`（第 214–226 行）：**保留为兜底。** 作为 `parse.js` 的 `SCHOOL_PERIOD_TIMES`，只在教务作息取不到时整张使用；课表超出它的节次按第 7 节的 H3 规则补时间。
- 登录页判断 `isLoginPage`（第 118 行）：**保留**，并补上 `login_slogin.html` 路径。

## 7. 统一修订 H1–H4、X1–X2（第五批正方件，第二轮）

依据 `.test/port-batch5/harmonize-zf.md`（2026-10-08 定稿）。这四条只改提醒文字与节次补位，不改请求，不改 `extract.js`。

**H1：校历第 1 周的日期不属于本学期时，校历给的周数一并作废。**

- 判定：第 1 周的日期不可信（`rejectedIso`）且没有可信的开学日（`firstIso`）时，校历周数置 0（`parse.js` 第 482 行，条件为 `!info.firstIso && info.rejectedIso`）。开学日仍不采信，按学期推算（§4.2）。
- 课表没有超过 20 周时，提醒写：「教务校历不属于这个学期（见上一条），学期总周数按适配器内置的 20 周导入（课表里最晚排到第 N 周），如与实际不符可在学期管理里改」。不说「学期周次校历接口没有返回可用数据」。
- 由 `calendar-rejected` 钉住：作废的 18 周没有被采用，总周数为 20。

**H2：超过总周数的提醒按周数来源分开写，不写「一学期是 0 周」。**

- 校历给了周数：「教务校历写的一学期是 X 周，课表里有第 N 周的课，已按 M 周导入（否则第 X+1 周起的课放不下）」。
- 校历没给或已作废：「课表里有第 N 周的课，超过适配器内置的 20 周，学期总周数已按 M 周导入，如与实际不符可在学期管理里改」。
- N 是课表里最晚的周次，M 是导入的总周数（超出时就是 N）。
- 由 `second-term` 钉住第二种写法。第一种写法目前没有 fixture 钉住（见第 9 节）。

**H3：课表用到作息表以外的节次时，逐节补时间。**

对作息表最后一节之后、课表用到的每一节（直到课表的最大节次为止），依次判断：

1. 内置空课表（`BUILTIN_PERIOD_TIMES`，即应用 `:core:model` 的 `DefaultPeriodTimes`，12 节）里有这一节，且它的开始时间不早于上一节的下课时间：用内置时间。
2. 否则从上一节下课后顺推：课间 5 分钟，每节 45 分钟（`EXTEND_BREAK_MINUTES`、`EXTEND_CLASS_MINUTES`）。
3. 顺推的下课时间超过 23:59：从这一节起不再补，课程照常导入，并提醒。

提醒只写实际用到的那一半。节次范围写「第 9-12 节」，单节写「第 9 节」，不写「第 12-12 节」。

- 补上了：「课表用到了作息表里没有的第 A-B 节，已补上时间：第 a-b 节用空课默认作息，第 c-d 节按上一节下课后课间 5 分钟、每节 45 分钟顺推，请在学期管理里核对」。只有一种来源时，只保留那一半。
- 没补上：「课表用到了第 N 节及以后，顺推的时间会越过当天 23:59，这些节次没有补上时间（课程已导入），请在学期管理里补上」。
- 由 `calendar-extra` 钉住内置表接得上时用内置（第 11–12 节）、第 13 节顺推；由 `periods-fallback` 钉住第 13 节顺推；由 `periods-overlap` 钉住内置表与上一节重叠时改为顺推（第 11–13 节），以及顺推越过 23:59 不补（第 14 节）。

**H4：提醒里指向应用页面的，一律写「学期管理」，不写旧的页面名。** 覆盖 `parse.js` 的提醒与注释、fixtures 的期望、本文件。`shzq/` 下检索不到旧页面名。

**X1：周次里的括号。** `weeksOf` 里括号先于删「周」处理（`parse.js` 第 315–332 行）：

- 括号里只有数字 / 逗号（`(1)`、`(1-2)`、`(1,2)`）是教学班序号，整组摘掉，计入 `serialGroups`；
- 括号里出现了数字、空白、`-`、`,`、单、双、周、第以外的字符（如 `(3组)`、`(第3组)`）是备注，整组摘掉，计入 `noteGroups`，并提醒「有 N 处周次后面的括号备注（如「(3组)」）不是周次，已忽略」；
- 其余（`(1-16周)`、`(单)`、`(双周)`）保留内容；
- 剩下落单的括号换成逗号，不删。删掉的话 `1-16周(1,2` 的 16 会和后面的数字粘成 161，`1-16周(3` 会粘成 163，都读成第 1-30 周。

由 `weeks-brackets` 钉住（整段周次、全角括号、班序号在前和在后、备注、单周在后、括号没闭合：`1-16周(1,2` 与 `1-16周(3` 两条落单括号）；`weeks-forms` 原有的周次写法结果未变。

**X2：提醒里不写实现细节。** 按替换表改掉「接口」「载荷」「上游」「脚本」：

- 「教务系统没有给出开学日期（学期周次校历接口没有返回可用数据）」→「教务系统没有给出开学日期」；
- 「学期周次校历接口没有返回可用数据，学期总周数按适配器内置的 20 周导入」→「教务系统没有给出学期校历，学期总周数按 20 周导入」；
- 「教务的作息时间接口没有返回可用的作息表，已用适配器内置的 N 节作息表」→「教务系统没有给出节次时间，已按适配器内置的 N 节节次时间导入」；
- 「已按载荷上限 30 周截断」→「已按最多 30 周导入」（这一句没有 fixture 覆盖）。

上面几句的期望值已同步改到 basic、weeks-forms、periods-fallback、periods-overlap、term-name-fallback、second-term、calendar-weekday、calendar-rejected。`parse.js` 的提醒字符串里检索不到「接口 / 载荷 / 上游 / 脚本 / 课程块」，剩下的命中都在注释里。

## 8. 突变测试

用同一套 `check.js` 做六次突变：M1–M4 是第五批原有的，X1A、X1B 是本轮新加的，每次只改一处。改在系统临时目录里的副本上，不动原文件；共 10 个 fixture。

| 编号 | 改动（只改一处） | 结果 | 变红的 fixture 与原因 |
|---|---|---|---|
| M1 | `SCHOOL_PERIOD_TIMES` 第 5 节开始时间 `12:35` 改为 `12:45`（第 47 行） | FAIL (8) | basic、weeks-forms、weeks-brackets、second-term、calendar-weekday、periods-fallback、term-name-fallback、calendar-rejected；都是 `$.terms[0].periodTimes[4].start` 实际 `12:45`、期望 `12:35`。calendar-extra 与 periods-overlap MATCH（它们的作息来自教务接口） |
| M2 | 第 362 行判断单周的 `indexOf('单')` 改为 `indexOf('(单)')` | FAIL (5) | basic、weeks-forms、weeks-brackets、calendar-weekday、periods-fallback；`endWeek` 与 `weekType` 不符 |
| M3 | 删除第 482 行的 `if (!info.firstIso && info.rejectedIso) info.weeks = 0;` | FAIL (2) | second-term（第 3 条提醒变成「教务校历写的一学期是 2 周…」）；calendar-rejected（总周数 18，期望 20；第 3 条提醒变成「学期总周数取自教务校历（18 周）…」） |
| M4 | H3 的判断 `if (builtin && minutesOf(builtin.start) >= prevEnd)`（第 630 行）改为 `if (builtin && true)` | FAIL (1) | periods-overlap：数组长度 14，期望 13；第 11、12 节改用内置时间（20:20–21:05、21:15–22:00），第 13 节从 22:05 起顺推，第 14 节也被补上 |
| X1A | 删「周」挪到括号处理之前：第 315 行改成 `cleaned = fullWidthToHalf(cleaned).replace(/周/g, '')`，去掉第 332 行那次删「周」 | FAIL (1) | weeks-brackets：`(1-16周)` 与 `（1-16周）` 两门被当成序号整段摘掉，courses 数组 5 比期望 7 |
| X1B | 第 331 行落单括号「换成逗号」改为「直接删掉」 | FAIL (1) | weeks-brackets：`1-16周(1,2` 与 `1-16周(3` 两门 `endWeek` 实际 30、期望 16（`16` 与后面的数字粘成 `161` / `163`），学期总周数 30 比期望 20，warnings 多出一条「超过 20 周」。`1-16周(1,2)` 那门没有变红：它是整组，在第一步就已当作教学班序号摘掉，这条变异碰不到它 |

六次突变都在副本上做（整个适配器目录复制到系统临时目录，只改副本的 `parse.js`，`check.js` 跑副本路径），原 `parse.js` 没有被改动，所以不需要还原。`check.js` 对原目录仍输出 `RESULT: PASS`（10 个 fixture 全部 MATCH）。M1–M4 的行号已按本轮改动更新。

## 9. 拿不准的点

- 没有真实账号，无法在线验证任何一条接口。所有 fixtures 都是合成数据，课程、教师、教室都是虚构的。
- 作息（`xskbcx_cxRjc`）与学期周次校历（`xskbcxZccx_cxZcByXnxq`）两个菜单是否在本校部署，未知。当前按 best-effort 设计。
- 周次的四种写法、`(1)` 这类教学班序号，是按上游代码推断的。真实排课行里 `zcd` 的写法没有核对。`(3组)` 这类备注括号也是按教务常见写法推的，整组忽略。
- 上游 `(单)` / `(双)` 与空格分段的行为是从代码读出的，没有在上游的真实页面里运行过。
- 本校登录页（`cas.shzq.edu.cn`）与教务主机（`jw.shzq.edu.cn`）不同域。是否有 WebVPN 之类的代理域，未知；如果有，需要单独审计。
- 排课行若在真实响应中混入个人字段，本适配器只保留六个字段，但真实响应的字段名没有核对过。
- H3 的内置时间来自应用 `:core:model` 的 `DefaultPeriodTimes`，顺推的 5 分钟课间与 45 分钟一节也是应用侧的约定，都不是上海中侨的真实作息。提醒里写了「请核对」，但没有拿学校实际作息对照。
- H2 里「教务校历写的一学期是 X 周」这一种写法目前没有 fixture 钉住，只有代码路径；`second-term` 钉的是校历作废后「超过内置 20 周」那一种。
- 行尾：工作区里本目录的文本文件（AUDIT.md、extract.js、parse.js、manifest.json、fixtures）现在都是 CRLF，已逐个按字节核对（CR 数与行数相同）。所在仓库 `jw-adapters` 没有 `.gitattributes`（上级仓库的 `* text=auto` 不适用于它），本机 `core.autocrlf=true`，提交时由 git 统一行尾，换行不影响解析。

## 10. 签名

审计人：0x7E7-2023（haiku 移植，2026-10-08）
上游：Kredenk（MIT），快照 `ff72d1f08782df965cae110034a9d87cd91e0c07`（2026-10-08）
