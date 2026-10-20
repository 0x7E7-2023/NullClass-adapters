# 安全审计 —— 上海财经大学浙江学院（正方教务 jwglxt 根路径，无 WebVPN，主备两个课表接口）

审计对象：`jw-adapters/shufezj/` 下的 `extract.js` / `parse.js` / `manifest.json` / `fixtures/`。
上游：`shiguang_warehouse` 的 `SHUFEZJ/shufezj.js`，快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`（2026-10-19 22:41 拉取，2026-10-20 复核仍是最新）；
本校脚本最后一次修改 `80e30cf`（2026-09-23，已用 `git log -1 -- resources/SHUFEZJ/shufezj.js` 核对）；MIT；作者（maintainer）ZnonEn。
移植模板：`gdust`（取数外壳、周次 / 合并 / 校历 / 节次时间逻辑），课表主备接口的写法参考 `gzmtu` 的 `fetchTimetable`。

审计方式：逐行读上游脚本与移植件；移植手册 §5 八条静态扫描（§0）；Node 桩跑 `extract.js` 的地址拼接与回落（§1.1，不联网）；
`check.js` 的 Rhino 实跑（6 对 fixture）与 6 处变异测试 `parse.js`（§6）。

## 0. 静态扫描结果（2026-10-20 运行，扫描命令未入库）

- 网络调用：`extract.js` 只有一处 `fetch(url, options)`，位于 `request`（约第 82 行）。`X-Requested-With` 是请求头字符串，不是 XHR 对象。`parse.js` 没有任何网络调用。
- 绝对 URL：`parse.js` 与 `extract.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse` 的出处注释（上游仓库地址，不是请求）。代码里没有写死的主机名，也没有 `ty.shufe-zj.edu.cn` 的 CAS 地址。
- 危险构造：对两个文件搜 `eval(`、`new Function`、`localStorage`、`innerHTML`、`.submit(`、`console.`、`document.write`，0 命中。
- ES5：对两个文件搜箭头函数、反引号、`let `、`const `、`async` / `await`、`class`、展开运算符、可选链、空值合并、`Set(` / `Map(`、`padStart`、`Array.from`、`.includes(`、`.startsWith(`，0 命中（注释里提到这些写法时用了文字描述）。
- 含学号的字样：只在注释与字段白名单的说明里出现（`xsxx`、`su=`），代码里不拼学号。

## 1. 请求域与请求清单（与代码逐条对应）

请求域：只有当前教务页面所在的同源主机（`window.location.origin`，本校为 `https://jwxt.shufe-zj.edu.cn`）。`allowHosts` 为 `[]`：教务主机与 `loginUrl` 同源，不跨主机。路径前缀由 `prefixOf()` 取 `/kbcx/`（或 `/xtgl/`）之前的那段，本校为空（根路径部署）；两个标记都没有（门户页、未进教务）时不发任何请求。

| # | 方法 | 地址（`<base>` = 同源主机 + 前缀，本校前缀为空） | 请求体 | 用途 | 取不到时怎么办 |
|---|---|---|---|---|---|
| 1 | GET | `<base>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 无 | 读学年学期下拉框（页面上已有 `#xnm` / `#xqm` 就不发） | 读不到 → 大白话报错，不导入 |
| 2 | POST | `<base>/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151` | `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=` | 课表主接口 | 网络错误、非 2xx、不是 JSON、没有 `kbList`、`kbList` 为空 → 改打 #3 |
| 3 | POST | `<base>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 同 #2 | 课表备用接口（上游的第二个接口，同样的请求体） | 主接口给了合法的空 `kbList` 且备用失败 → 以空结果交给 parse.js（照常报「没有解析到任何课程」）；两个都拿不到合法课表外壳 → 大白话报错 |
| 4 | POST | `<base>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | `xnm=…&xqm=…&xqh_id=<课表行里的校区号>` | 节次时间（上游没有这个请求，本件新增的可选请求） | 失败、或响应不是顶层数组 → 交 `null`，parse.js 回落内置 13 节表 |
| 5 | POST | `<base>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | `xnm=…&xqm=…` | 学期周次校历（上游没有这个请求，本件新增的可选请求） | 失败、或响应不是顶层数组 → 交 `null`，parse.js 推算开学日、总周数按 20 周 |

说明：
- 上游的 `kzlx=ck&xsdm=&kclbdm=` 请求体逐字保留。学期码直接取自下拉框的值，不再像上游那样在 `3↔1`、`12↔2` 之间换着试（见 §5）。
- 请求 #4 在课表为空（没有任何行、校区号为空）时仍会发出，`xqh_id` 为空串。这是模板既有行为，不影响结果：取不到就是 `null`。
- 没有任何写操作：不提交表单、不改 DOM、不写存储。
- 所有请求都带 `credentials: 'include'`（只让浏览器附带本站已有的会话 Cookie，本件不读、不存、不拼 Cookie）。

### 1.1 extract.js 桩跑结果（Node 桩，不联网；桩脚本在临时目录，未入库）

用桩 `window`（location / document）、`fetch`、`DOMParser` 跑 `extract.js`，记录每一次发出的地址与请求体。

- A 正常（页面有 `#xnm`/`#xqm`，地址带 `su=` 参数）：
  - `POST https://jwxt.shufe-zj.edu.cn/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151`，体 `xnm=2025&xqm=3&kzlx=ck&xsdm=&kclbdm=`
  - `POST …/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151`，体 `xnm=2025&xqm=3&xqh_id=01`
  - `POST …/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`，体 `xnm=2025&xqm=3`
  - 没有 `cxXsgrkb`；交出 `source="cxXsKb"`；地址与请求体里都没有学号。
- B `cxXsKb` 返回 500 → 第二个请求 `POST …/xskbcx_cxXsgrkb.html?gnmkdm=N2151`，同样的体，返回课表 → 交出 `source="cxXsgrkb"`，`cxRjc` / `cxZcByXnxq` 照常发（返回非数组时为 `null`）。
- C `cxXsKb` 返回 `{"kbList":[]}` → 改打 `cxXsgrkb`，交出 `source="cxXsgrkb"`。
- D 两个都失败（`cxXsKb` 500，`cxXsgrkb` 回了登录页 HTML）→ 报 `教务系统没有返回课表数据（返回的内容格式不对）：登录状态可能已失效，请重新登录后再点「提取课表」`，不交数据。
- E `cxXsKb` 返回 `{"kbList":[]}`、`cxXsgrkb` 返回 500 → 以主接口的空结果为准，交出 `source="cxXsKb"`、`rows=[]`（parse.js 之后报「没有解析到任何课程」，不是网络错误）。
- F 两个都网络错误 → `连不上教务系统（Failed to fetch）：请确认已登录，再点「提取课表」`。
- G 主机 `ty.shufe-zj.edu.cn`、路径 `/tpass/login`（CAS）→ 同步抛「当前打开的是登录页。请先登录教务系统，再打开「信息查询 - 学生课表查询」，然后点「提取课表」」，**零请求**。
- H 路径 `/kbcx/login_slogin.html` → 同上，**零请求**。
- I 门户首页（路径 `/`，没有 `/kbcx/` 与 `/xtgl/`）→ 同步抛「请先进入教务系统、打开课表页后再点「提取课表」」，**零请求**。
- J 页面没有学年学期下拉框 → 先 `GET …/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`，从返回的 HTML 读到 `xnm=2025&xqm=3`，再照 A 的顺序打接口。
- K 附加接口全挂（`cxRjc` 500、`cxZcByXnxq` 回登录页）→ 课表照常交出，`periodTimes` 与 `calendar` 都是 `null`。

各场景的结论：没有任何一个场景把学号（测试用的 `su` 值）带进请求地址、请求体或交出的数据；交出的 `raw.kbList` 只含七个白名单字段，`xsxx` 与 `xh` 都被挑掉。

## 2. 读了什么、交出什么（逐字段）

读（只读，不写）：
- 页面：`#xnm` / `#xqm` 下拉框（`selected` 的那项优先，否则第一个非空项；万一是隐藏 input 就读 `value`），取 `value` 与 `textContent`。
- 页面地址：`pathname`（找前缀、判断登录页）与 `hostname`（判断 CAS 主机 `ty.`）。**不读 `search`**：`su` 学号参数不读。
- 课表响应（主或备）：`kbList`（每行只取 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` / `xqh_id` 七个字段）、`sjkList`（每行只取 `kcmc`）、记录总数（`total` / `totalResult` / `totalCount` / `count` 中第一个数字）。
- 节次时间响应：只认顶层数组，每行只取 `jcmc` / `jc` / `qssj` / `jssj`。
- 校历响应：只认顶层数组，每行只取 `zs` / `zsmc` / `zrq` / `zcrq` / `rq` / `ksrq`。

交出（`extract.js` 返回的 JSON 字符串）：
- `term`：`{ xnm, xqm, xnmText, xqmText }`，学年学期的值与下拉框文字。
- `today`：本地日期 `yyyy-MM-dd`。
- `campusId`：第一条课表行的 `xqh_id`，没有则空串。
- `source`：`"cxXsKb"` 或 `"cxXsgrkb"`，说明课表来自哪个接口，只给冒烟与审计看。
- `raw.kbList`：白名单七字段的行数组。`raw.sjkList`：只含 `kcmc` 的行数组。
- `total`：数字或 `null`。
- `periodTimes`：白名单四字段的数组，或 `null`。`calendar`：白名单六字段的数组，或 `null`。

parse.js 读的字段与 extract.js 交出的完全一致，没有额外的字段需要进载荷。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | 合格 | 不读 password / pwd / 表单值 / localStorage / Cookie；`credentials: 'include'` 只让浏览器附带既有会话，本件不接触其内容 |
| 2 | 不外发 | 合格 | 所有请求都是 `window.location.origin` 同源；没有第三方域；上游的 `console.*` 调试输出全部删掉 |
| 3 | 请求域可控 | 合格 | `allowHosts: []`，本校教务即 `loginUrl` 的同源主机；无通配；没有写死的主机名 |
| 4 | 只读课表 | 合格 | 请求的接口只有 `xskbcx_cxXskbcx` / `xskbcx_cxXsKb` / `xskbcx_cxXsgrkb` / `xskbcx_cxRjc` / `xskbcxZccx_cxZcByXnxq`，全部是课表、节次时间、校历；不请求成绩、学籍、缴费；响应字段按白名单挑 |
| 5 | 不埋点 | 合格 | 没有统计、上报、遥测；上游的 `console.log` / `console.warn` / `console.error` 全部没有移植 |
| 6 | 不 eval 远程代码 | 合格 | 没有 `eval` / `new Function`；extract.js 的 `jsonOf` 对教务响应做 `JSON.parse` 并包在 `try` 里；parse.js 只解析宿主传入的 `__ncInput` |
| 7 | 不写页面 | 合格 | 只读 DOM（`querySelector` / `options`）；不点击、不改表单、不提交；课表首页 HTML 用 `DOMParser` 在内存里解析，不挂到页面上 |
| 8 | 不依赖用户输入之外的秘密 | 合格 | 没有硬编码的学号、令牌、密钥；上游从地址里读 `su` 学号拼进课表地址的做法**不照搬**（见 §4） |

## 4. 与模板 gdust 的差异（模板目录只读，本件未改动）

- 去掉 WebVPN：模板的 `vpnPart()`、`VPN_DEFAULT` 与 `/http/` `/https/` 路径前缀逻辑全部删除。地址一律 `<origin><前缀>/kbcx/<页面>?gnmkdm=…`，前缀按 `/kbcx/` 或 `/xtgl/` 取，本校为空。
- 登录页判断：模板认 `login_slogin.html`、`/cas/`、`/login` 路径；本件认 `login_slogin.html`、`/cas/` 路径，以及**主机以 `ty.` 开头**（本校 CAS 主机 `ty.shufe-zj.edu.cn`）。`/login` 路径判断去掉（那是模板 WebVPN 的登录地址形态，本校没有）。
- 课表接口：模板只打 `cxXsgrkb`；本件**主 `cxXsKb`、备 `cxXsgrkb`**，顺序照上游，拿不到非空 `kbList` 才换。
- 课表响应判断：模板只判断 `kbList` 是数组；本件把「是不是课表外壳」收成一个函数 `isTimetable`，主、备两条路径共用，不再分两处判断（公共说明「审计真抓到过的错」）。
- 节次时间：模板的内置表是 10 节；本件换成上游 `shufezj.js` 的 13 节表（`SCHOOL_PERIOD_TIMES`，逐节照抄）。
- 附加接口（节次时间、校历）：模板把整个响应原样交出；本件只认顶层数组并按字段白名单挑（`optionalRows`）。信封对象按「没取到」处理，回落到内置表并在 warnings 说明。
- 学期码：模板直接用下拉框的值；本件同样，并且与上游的「3↔1、12↔2 换着试」都不做。
- 交出的数据多了 `source` 字段（只给冒烟与审计看）。
- 周次：模板没有花括号处理；本件新增「花括号外有周次文本则去掉花括号及内容，整段只有花括号则只去花括号字符」（`weeksOf` 开头，见 §5 的对应条目）。
- 学期名兜底：「广东科技学院 第 X 学期」改为「上海财经大学浙江学院 第 X 学期」（`SCHOOL_NAME`）。
- 没有 `su` 学号：模板本来也没有，本件保持。

## 5. 上游里删掉 / 改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `promptUserToStart`（开场弹窗）、`getAcademicYear`（输入学年）、`selectSemester`（选学期）、`validateYearInput` | 删除，改读页面下拉框 | 公共说明第 2 条：不弹窗问学年学期；要别的学期，用户在教务页面切一下再点「提取课表」 |
| `getSemesterCodeCandidates` 与 `alt` 表（3↔1、12↔2 换着试） | 删除 | 下拉框的值就是教务认的学期码，换着试会把别的学期的课当成本学期导入（静默错误）。若真有学校需要换着试，应在真机确认后再加 |
| `getStudentIdFromUrl`（从地址读 `su`，拼进课表地址 `&su=`） | 删除，不读 `search` | 会话 Cookie 已能标识学生，学号不需要进请求；任务卡要求学号不进任何请求、也不进交出的数据。已知风险见 §8 |
| `getCurrentSemesterFromPage` 的多组备选选择器与模糊匹配兜底 | 只认 `#xnm` / `#xqm`（读不到才 GET 课表首页） | 任务卡第 8 条：模糊匹配不照搬。隐藏 input 的读法（`readSelect` 的 `value` 分支）是本件新增的防御性读法 |
| `parseJsonData` 的严格过滤 `!xm \|\| !cdmc` | 删除，缺教师 / 缺教室照常导入（值为 `null`），按类型汇总进 warnings | 公共说明第 4 条：不许静默丢课 |
| `parseWeeks` 的 `replace(/\{[^}]*\}/g, '')` | 改为「外面有周次文本才删花括号内容，整段只有花括号则只去花括号字符」 | 上游在 `zcd` 整段是 `{第1-16周}` 时会删光，课表没有周次（静默丢课） |
| `parseSections` 的 `Array.from`、`substr`，以及 `for…of` / 解构 / 箭头函数 | 改为 ES5 写法，逻辑等价 | CI 的 Rhino 1.8.0 是 ES5 解释模式 |
| `showToast`、`saveImportedCourses`、`saveCourseConfig`、`savePresetTimeSlots`、`notifyTaskCompletion`、`console.*` | 全部不移植 | 这些是「拾光」的桥能力，空课由宿主保存，适配器只交载荷（公共说明与 parse.js 文件头第 ⑨ 条） |
| `config.semesterStartDate: null`、`semesterTotalWeeks: 20` | 开学日：校历优先，取不到推算并写 warnings；总周数：校历优先，取不到用 20，课表更晚则抬高并说明 | 上游没有校历请求，直接写死 null 与 20；本件多取校历，取不到仍回到上游的 20 |
| `TimeSlots`（13 节，只在成功导入后存成预设） | 保留为 `SCHOOL_PERIOD_TIMES`，教务节次时间接口取到合法表就用它，取不到用它并写 warnings | 公共说明第 5 条 |
| 上游 `fetchAndParseCourses` 的 `targetUrls` 循环与 `baseUrls` 数组 | 只打当前页面的同源主机 | 只请求本校同源；跨主机会被宿主沙箱拦下 |

## 6. 变异测试记录

在临时目录的副本上改坏 `parse.js` 的一处，跑 `check.js`，必须有 DIFF。原始文件未被改动，逐次测试之后自检仍为 PASS。

| # | 改坏的地方 | 哪些用例变红 |
|---|---|---|
| M1 | `weeksOf`：花括号外有周次文本时也整段删花括号内容（上游做法）→ `{第1-16周}` 删光 | `week-markers` DIFF |
| M2 | `weeksOf`：单/双标记前缀写法 `(单)1-8周,(双)9-16周` 的归属替换为空串（标记丢失，整段变每周都上） | `week-markers` DIFF |
| M3 | `sectionsOf`：两位补零节次 `0102` 不认（4 位数分支关掉） | `basic`、`week-markers` DIFF |
| M4 | `SCHOOL_PERIOD_TIMES`：本校第 13 节下课时间写成 21:50（应为 21:40） | `basic`、`week-markers`、`merge-consecutive`、`no-calendar-overweek`、`long-warnings` 等 7 对 DIFF |
| M5 | `weeksOf`：「共 N 周」剥离改成 `/共.*$/g`（吞掉后面的真实周次段） | `week-markers` DIFF |
| M6 | `EXTEND_BREAK_MINUTES` 改成 10 分钟（H3 顺推） | `basic` DIFF |

以上六处改坏后每一处都有用例变红；还原后 `check.js` 为 `RESULT: PASS`。

## 7. fixtures 与自检

共 6 对合成 fixture（期望值按规范与代码规则手工推演后写入，未把 parse.js 的输出存为 expected）：

1. `basic`：基本。节次时间接口取不到 → 本校 13 节表逐节钉住（第 6 节 14:00-14:40、第 13 节 21:00-21:40）；校历取不到 → 第一学期按 9 月 1 日所在周的周一推算为 2025-09-01、总周数内置 20；课表排到第 14 节 → 顺推 21:45-22:30 并写 warnings；`0304` 两位补零节次；单双周并集（1-8 周）；完全重复行只留一条；集中实践课只提示。
2. `week-markers`：周次写法全覆盖。`{第1-16周}` 整段花括号 → 1-16；`1-16周{第1-16周}` → 1-16；`1-8周(单周)` → 1-7 单；`1~16`；`1-3,5`；`2—10周(双周)` → 2-10 双；`(单)1-8周,(双)9-16周` → 单双各归各段；`1-8周(共8周),9-16周` → 只剥备注、9-16 周不丢；`1-15周(单) 共16周`；`0102` 节次。
3. `calendar-periods`：校历与节次时间接口都取到。开学日取校历第 1 周那一周的周一（2026-09-02 周三 → 2026-08-31），总周数取校历 18 周；节次时间接口给 8 节，课表用到第 9-10 节，接口表没覆盖 → 本校内置表同号节次接得上就补并说明。
4. `merge-consecutive`：同课合并。1-2 与 3-4（同周 1-8）首尾相接 → 合成 1-4；完全重复行只留一条；同节次不同周次（1-4 周 1-8 与 1-4 周 9-16）→ 周次并集 1-16；不相接的 7-8 不并进去。
5. `no-calendar-overweek`：校历取不到 → 第二学期按 2 月 20 日所在周的周一推算为 2026-02-16；课表最大周次 22 → 总周数抬到 22 并说明；节次时间也取不到 → 内置 13 节。
6. `long-warnings`：长课名 + 缺教师 / 缺教室。课照常导入（`teacher` / `location` 为 `null`）；按类型汇总计数并点名「编辑课程」；课名截到 19 字加「…」；集中实践课长名截断；`第一周至第十六周` 认不出 → 跳过并说明；每条提醒 ≤200 字。

自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/shufezj` → `RESULT: PASS`（6 对 fixture 全部 MATCH，ES5、控制字节、allowHosts 检查通过）。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

- **未真机验证**：没有本校账号，`cxXsKb` 与 `cxXsgrkb` 在本校是否都返回 JSON、字段名是否与上游一致，都没有验证。上游脚本注释只说明「已通过 HTTP 302->CAS 验证存在」，并未说明返回格式。
- **学号是否必需**：上游课表地址带 `&su=学号`。本件不带。若本校接口必须带 `su` 才返回数据，主、备两个接口都会返回空或非课表内容，最终报「没有返回课表数据」。任务卡要求此时需真机确认后再加，不在本件里偷加。
- **菜单号 N2151 / N2154 的附加接口**：`cxRjc` 与 `cxZcByXnxq` 的地址沿用同族正方脚本的惯例（模板 gdust 与 `WENHUA/wenhua_01.js` 的写法），本校未验证。取不到即回落，不影响导入，但节次时间与校历可能一直用不上。
- **内置 13 节表是否现行**：上游写死的时间，与学校当前实际安排是否一致未知。parse.js 在用到它时已写进 warnings（「时间可能与学校实际安排不符，请在学期管理里核对」）。
- **响应信封不认**：`cxRjc` / `cxZcByXnxq` 若是 `{datas:{rows:[…]}}` 之类的信封，本件按「没取到」处理（回落 + 提示），不会错用数据，但会丢掉教务给的节次时间与校历。这是有意的取舍（字段白名单只对顶层数组可控），真机若遇到信封，需要再议。
- **空课表的判断**：主接口给合法空 `kbList` 且备用接口失败时，交出空结果，parse.js 报「没有解析到任何课程：可能还没排课，也可能登录状态已失效」。这不是静默错误，但学生需要自己分辨。
- **周次花括号的真实写法未知**：`{第1-16周}` 与 `1-16周{第1-16周}` 两种是按任务卡给的样例写的，真机上可能还有别的形态；认不出的会计入「认不出的周次写法」并跳过，不静默。
- **集中实践课**：只提示，不导入（没有星期与节次，排不进周课表）。
- **学期码**：只认页面下拉框的值。若某个页面的下拉框值与接口不匹配，接口会返回空 `kbList`，最终报「没有解析到任何课程」，而不是导入错误的数据。
- **WebView 环境**：`fetch` 的 `credentials` 与 CORS 在宿主 WebView 里的行为未在真机验证。

## 9. 签名

0x7E7-2023（haiku 移植，2026-10-20）

## 审计修正（2026-10-20）

- **周次前缀标记误吞上一段的后缀**：`parse.js` 的 `weeksOf` 里，前缀写法的正则 `(单)1` 没排除标记前面紧挨着上一段（数字或「周」）的情况，
  把上一段的后缀 (单)/(双) 当成下一段的前缀：`1-8周(单) 9-16周(双)` 被读成 1-16 每周；`1-8周(单)9-16周` 被读成 1-15 单周，9-16 周的双周丢了；
  `1-16周(单) 17-18周` 被读成 1-17 单周，第 18 周丢了。
- 修正：标记前面紧挨着数字或「周」（中间可有空白）时按后缀归给前一段，只有在段首（字符串开头或分隔符之后）才当后一段的前缀；
  后缀后面直接跟着下一段数字时补一个逗号隔开。`(单)1-8周,(双)9-16周`、`1-8周(单),9-16周(双)`、`1-15周(单) 共16周` 等原有写法行为不变。
- 新增 fixture `week-adjacent`（三个反例；期望值按周次集合手推：1-7 单 + 10-16 双；1-7 单 + 9-16 每周，合并为 1-9 单 + 10-16 每周；1-15 单 + 17-18 每周，合并为 1-17 单 + 18 每周）。版本号 1.0.0 → 1.0.1。
- 已知取舍：`(单)1-8周 (双)9-16周`（前缀写法、段间只有空格）里的 `(双)` 前面紧挨「周」，按上述规则会被当作前一段的后缀；与后缀写法 `1-8周(单) 9-16周(双)` 在形态上无法区分，未见真实样本，按上述规则取后缀。
