# 安全审计 —— 华南理工大学（正方教务 V9，jwglxt，经学校 WebVPN 映射主机访问）

审计对象：`jw-adapters/scut/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `SCUT/SCUT_01.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，MIT，作者 dezige131；
本校目录最后一次修改 `80e30cf`，与任务卡一致，已用 `git log -1 -- resources/SCUT` 核对）。

审计方式：逐行读上游脚本（263 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-20 运行，扫描脚本未入库）：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，只是写上游出处的注释，不是请求。代码里没有任何绝对地址。
- 网络调用：只有 `extract.js` 的 `request` 函数里的一处 `fetch(url, options)`；`X-Requested-With: XMLHttpRequest` 是请求头里的字符串，不是 XHR 对象。`parse.js` 里没有任何网络调用。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` / `sendBeacon` / `new WebSocket` / `EventSource` / `new Image` / `innerHTML` / `appendChild` / `.submit` 全部无命中。`parse.js` 里没有 `document.` / `window.` / 桥调用（check.js 的纯函数检查通过）。
- 模板件字样：代码、`manifest.json`、`fixtures/` 检索模板件（`xhsysu` / `hueb`）的目录名与学校名，零命中；这两个名字只在 `parse.js` 文件头注释和本文件里**有意**出现（说明模板来源）。
- ES5 token 扫描（注释也算）：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、展开符、模板串、`new Set` / `new Map` / `Array.from`、`includes(` / `startsWith`、`padStart`、可选链、后行断言与命名捕获组，在 `parse.js`、`extract.js` 全文中全部无命中（check.js 与人工各查一遍）。
- 控制字节与 BOM：`parse.js`、`extract.js`、`manifest.json`、`AUDIT.md` 与 `fixtures/` 下的 26 个文件，无控制字节、无 BOM（check.js 逐字节扫描通过）。

## 0. 分析（模板选择与不同构之处）

上游是正方 V9 通用脚本（同一份 `SCUT_01.js` 被 `adapters.yaml` 里 SCUT_01 的 WebVPN 入口和 SCUT_02 的内网入口共用），任务卡只要 WebVPN 入口（`xsjw2018-jw.webvpn.scut.edu.cn`，主机本身就是映射后的教务）。

模板选择：**主模板 `xhsysu`（批次十三，同为正方 V9）**，取它的 extract/parse 骨架——登录页与会话失效识别、路径前缀判断、周次解析（含「第1-第8周」、单双按位置归属、「共 N 周」只剥备注）、节次解析、两阶段合并、开学日 / 每周起始日、提醒限长；
**从 `hueb`（批次八，正方 + WebVPN）搬节次时间的读取**（`periodTimesOf`、空课默认表与 H3 逐节补）。选 xhsysu 而不是 hueb 作骨架，是因为 hueb 的周次解析不认「第1-第8周」、没有每周起始日（批次十的统一修正没回灌）；
而 xhsysu 没有 cxRjc 请求（它的上游写死了 14 节表），本校上游恰恰是**读教务的节次时间**，所以这一块要从 hueb 搬。不要 hueb 的 `SCHOOL_PERIOD_TIMES`（本校上游没有写死的节次表）。

与模板不同构的地方（逐条，对应下文 §4）：

1. 路径前缀：上游用页面全局 `_path`（没有就 `/jwglxt`）。xhsysu 靠 `/kbcx/` `/xtgl/` 前的那一段推。本件两者合并：先认 `_path`，没有再推。
2. 节次时间：读 cxRjc（请求体照上游，不带校区号）；按上游丢掉结束时间晚于 21:35 的节次；上游无写死表，取不到时整张用空课默认 12 节并提醒。
3. 开学日与总周数：上游完全没有（它只存课程和节次时间，不存学期配置）。本件新增校历请求（N2154）；取不到才推算。
4. 教师 / 教室缺：上游写「未知」「待定」；本件置 null 并按类型汇总提醒。
5. 去重：上游只按 `day-start-end-name-weeks` 去重（教师 / 教室不同的两行会被当成重复）；本件完全相同才去重，再做两阶段合并。

## 1. 请求域与请求清单（与代码逐条对应）

上游的请求全是站内相对路径 `<_path>/kbcx/…`（`_path` 缺省 `/jwglxt`），没有任何绝对地址。移植件的地址由 `window.location.origin` + 路径前缀 + `/kbcx/…` 拼出（`jwUrl`），
**主机只有用户当前所在的那一个映射教务主机**，正常就是 `loginUrl` 的主机 `xsjw2018-jw.webvpn.scut.edu.cn`。`allowHosts` 为空数组，不写通配。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上的学年学期（`#xnm` / `#xqm`）。**页面上已经有这两个字段时跳过**（`currentTerm`） | 报错，提示重新登录后再点「提取课表」 |
| extract.js | POST | `<前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、顶层 `qsxqj`、可能有的记录总数。请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=`，与上游逐字一致 | 报错（非 2xx → 「教务系统返回错误（代码 N）」；200 + 登录页 → 「登录状态已失效」；不是课表 JSON → 「返回的内容格式不对」） |
| extract.js | POST | `<前缀>/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` | 取节次时间。请求体与课表请求**逐字相同**（上游就是这样并发发的，不带校区号） | 交 `null`，parse.js 整张回落到空课默认 12 节并写 warnings |
| extract.js | POST | `<前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 取学期周次校历，定开学日与总周数。请求体 `xnm` / `xqm`。**上游没有这个请求**（见下） | 交 `null`，parse.js 推算开学日、总周数按 20 周并写 warnings |

与上游的差别：

- 上游每次导入先 GET 课表首页并用正则抠两个下拉框，再弹窗让用户选学期。本件读页面上的 `#xnm` / `#xqm`（被 selected 标的优先）；读不到才去取一次首页（`DOMParser` 离线解析，不插入当前页面）。要导入别的学期，用户在教务页面里切一下再点「提取课表」。
- 上游并发请求课表与节次时间；本件先课表后节次时间 + 校历（并发）。节次时间失败不影响导入（`optionalJson` 把任何失败吞成 `null`）。
- **新增校历请求**（N2154）：上游不存学期配置，没有开学日；空课的课表必须有开学日（它决定「现在第几周」），所以多取这一次，写法照 `hueb` / `xhsysu`（同模块、只读、公共数据）。取不到不影响导入，推算并在 warnings 里说清。
- 路径前缀（`prefixOf`）：先认页面全局 `window._path`（`declaredPath`：空串合法——根路径部署；非空必须以 `/` 开头、只含路径字符、无 `//` 与 `..`，否则不认），没有再取当前路径里最早出现的 `/kbcx/` 或 `/xtgl/` 之前的一段，
  再不行当前路径本身在 `/jwglxt` 下就用 `/jwglxt`（上游缺省值）。都得不到（WebVPN 首页、统一认证页）→ 不发任何请求，提示先进入教务系统。
- 登录页（`onLoginPage`：路径含 `login_slogin.html`）→ 不发请求，直接提示。会话失效时教务返回 200 + 登录页（含 `login_slogin` / `/cas/login` / `name="yhm"`），先于 JSON 解析判断，单独提示。
- 请求头统一带 `Content-Type`、`X-Requested-With`、`Accept`，不带任何自定义令牌。凭据用 `credentials: 'include'`，让 WebView 按同源规则带 Cookie；脚本既不读 Cookie，也不把它发到别处。
- `parse.js` 不发任何请求（CI 里用 Rhino 实跑，是纯函数）。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 与下拉框文本） | 课表页的 `#xnm` / `#xqm`，或课表首页 HTML（离线解析） | 带出（学期名要用） |
| 排课行 `kbList` | 课表接口 | 只带**白名单字段**：`kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd`（`KB_FIELDS`） |
| 集中实践课 `sjkList` | 课表接口 | 只带 `kcmc`（`PRACTICE_FIELDS`）。它没有固定星期与节次，排不进周课表，但不能吞掉：写进 `warnings` |
| 每周起始日 `qsxqj` | 课表接口顶层 | 带出（没有就 `null`，按周一） |
| 节次时间 | cxRjc | 只带 `jcmc` / `jc` / `qssj` / `jssj`（`PERIOD_FIELDS`），拆掉外壳后交裸数组；取不到为 `null` |
| 学期周次校历 | cxZcByXnxq | 只带 `zs` / `zsmc` / `zrq` / `zcrq` / `rq` / `ksrq`（`CALENDAR_FIELDS`）；只用来算开学日与总周数，不进入载荷 |
| 记录总数（响应里有才有） | 课表接口 | 只用于对账，不进入载荷 |
| 学生个人信息（课表响应里夹带的 `xsxx`、学号、姓名、学院、校区号等） | 课表接口 | **不带出，也不进 fixture**：`extract.js` 只按白名单挑字段。冒烟里把学号、身份证号、手机号、`xsxx` 混进课表、节次时间和校历的响应，交出的字符串里全部检索不到 |

`parse.js` 实际读的字段：排课行 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd`；实践课 `kcmc`；`periodTimes` 的 `jcmc` / `jc` 与 `qssj` / `jssj`；
`calendar` 的 `zs` / `zsmc` 与 `zrq` / `zcrq` / `rq` / `ksrq`；`total`；`qsxqj`；`today`；`term.*`。

不读的东西（静态扫描无命中）：`password` / `pwd` / 登录表单、`localStorage` / `sessionStorage` / Cookie、成绩（`/cjcx/*`）、学籍、个人信息、缴费，以及任何其它模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问。唯一的「凭据」是浏览器自带的会话 Cookie，脚本既不读它也不外发。上游的桥调用（`showToast` / `showSingleSelection` / `showAlert` / `saveCourseConfig` / `savePresetTimeSlots` / `saveImportedCourses` / `notifyTaskCompletion`）都没有移植 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js` 的 `request` 里，地址由 `window.location.origin` 拼成。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单，也没有第三方域 |
| 3 | 请求域可控 | **过**。请求主机只有一个，即用户当前打开的教务主机（正常是 `xsjw2018-jw.webvpn.scut.edu.cn`）。`allowHosts` 留空，不写通配；代码里没有写死的主机名或端口。`_path` 只作路径用，形状校验后才拼（拼在 `origin` 后面，不可能指向别的主机） |
| 4 | 只读课表 | **过**。四条请求全部落在 `<前缀>/kbcx/*`（课表页、课表、节次时间、周次校历），不碰成绩、学籍、个人信息、缴费。课表响应里夹带的学生信息一律不带出；节次时间与周次校历是学校公共数据 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，也没有图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`） |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的值与 `window._path`。取课表首页用的是 `fetch` + `DOMParser`，离线解析，不插入当前页面，不改表单，不触发提交或点击 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。常量只有默认路径 `/jwglxt`、两个菜单号 `N2151` / `N2154`（都是页面上可见的参数）、固定的 21:35 阈值 |

## 4. 与模板 xhsysu 的差异（模板目录只读，本件未改动）

1. **作息：读教务 + 上游的 21:35 规则**（`periodTimesOf`）。xhsysu 的上游写死 14 节表、不请求教务；本件上游读 cxRjc，所以：
   ① 先丢掉结束时间晚于 21:35 的节次（上游是字符串比较 `jssj > "21:35"`，`"9:35" > "21:35"` 为真，不补零的写法会被误丢；本件按分钟比，`LATEST_END_MINUTES`）；
   ② 时间读不懂 / 结束不晚于开始的行不收；剩下的只认「从第 1 节起连续、时间递增不重叠」的那一段，断开之后的不收（用到时走补节次并提醒）；
   ③ 同一节号重复且时间一样只留一条；时间不一样（多校区可能混在一起）不猜用哪个，整张当没取到；
   ④ 没有可用的 → 整张用空课默认 12 节（`BUILTIN_PERIOD_TIMES`，逐节核对过 `DefaultPeriodTimes.kt`），并按原因（没给 / 同一节两个时间）写 warnings；
   ⑤ 课表用到表之外的节次（含被 21:35 规则丢掉的）→ H3 逐节补：空课默认表里同号的节次开始不早于上一节下课就用它，否则按课间 5 分钟、每节 45 分钟顺推（与上游存的 config 一致），越过 23:59 就停，补了哪些、哪些补不了都进 warnings。
2. **extract.js 的前缀判断**：见 §1，多认页面全局 `_path`（上游就读它），并校验形状。
3. **extract.js 多取节次时间**，并对节次时间 / 校历拆外壳（`rowsOf`，外壳只定义一次）后按白名单挑字段。xhsysu 只取校历且原样交出。
4. **去掉统一认证（联奕）相关的页面判断**：xhsysu 认 `lyuapServer/login` 与 `/sso/lyiotlogin`，本校只认正方登录页；其它非教务页面（WebVPN 首页、统一认证页）靠「前缀得不到」统一拦下。会话失效识别多认 `/cas/login`。
5. **学校名、学期总周数的兜底**：`SCHOOL_NAME` = 华南理工大学；校历取不到时总周数 20（上游没有这一项，是本件的取舍，会写进 warnings）。
6. **提醒里括号备注示例限长**：`noteSample` 经 `shortName` 截到 20 字（模板直接贴原文，超长括号会把整条提醒顶到 200 字上限被硬截）。
7. 周次、节次、合并、开学日回退、总周数收紧、warnings 收口、缺教师 / 缺教室汇总等其余层与 xhsysu 一致。

## 5. 上游里删掉 / 改掉的东西及理由

1. **删掉「拾光」桥调用与浏览器测试分支**：`showToast` / `showSingleSelection` / `showAlert` / `saveCourseConfig` / `savePresetTimeSlots` / `saveImportedCourses` / `notifyTaskCompletion`，以及没有桥时的 `prompt` / `alert` / `console.log`。空课里由宿主负责保存，适配器只交载荷。
2. **删掉弹窗选学年学期**：改成读页面当前选中（移植手册 §3 第 1 步）。上游枚举所有「学年 × 学期」的笛卡尔积再弹框，其中大量不存在的组合没有意义。
3. **周次解析重写**（上游 `parseZhengFangWeeks`）：① 整串含「单」就整串只留单周、含「双」就只留双周，`(单)1-8周,(双)9-16周` 两边互相排除、整行消失，`1-8周,10-16周(单)` 把前一段也变成单周 → 改成标记按位置归属；
   ② 只认半角逗号 → 全角逗号、顿号、分号、空格也当分段符；③ 不认区间终点前的「第」（`第1-第8周` → `parseInt('第1')` 为 NaN，`i <= NaN` 一次都不循环，整行静默消失）→ 认；④ 括号里的教学班序号 `(1)` 会被当成周次 → 摘掉并提醒；
   ⑤ 「共 N 周」备注被读成周次 → 只剥备注本身。
4. **整行丢课改为计数**：上游要求课名、周次、起始节次都有才收，不满足的静默丢；星期用 `parseInt(c.xqj)` 不校验范围。本件跳过的行按原因计数写进 `warnings`（含「星期不在 1-7」），不静默。
5. **教师 / 教室占位改 null**：上游缺教师写「未知」、缺教室写「待定」，课表会把它们当真名显示。本件置 `null`，按类型汇总提醒（点名最多 3 门，课名截 20 字），提醒指向「编辑课程」。教室写「未排地点」同样当作没有教室。
6. **节次解析放宽**：上游 `jcs.split('-')` 认不出 `第9-10节`、`1,2`、两位一拼的 `0102`（会读成第 102 节），多段只取首尾。本件按 `sectionsOf` 处理，多段按最大跨度放入并说明。
7. **去重改写**：见 §0 第 5 点。没有真实样本，行为由 `fixtures/merge-dedupe` 钉住（教师不同教室相同、教室不同教师相同各一对）。
8. **节次时间的 21:35 规则改按分钟比**：见 §4 第 1 点。**保留了上游的 21:35 阈值本身**（含边界：恰好 21:35 结束的节次保留）。
9. **主机不写死、WebVPN 映射主机不进代码**：上游没有写死主机，本件也没有；`loginUrl` / `scheduleUrlHint` 里的映射主机取自 `adapters.yaml` 的 `import_url`。
10. **学生信息**：上游把整个响应交给自己的解析函数（不涉及外发）；本件按字段白名单挑，`xsxx` 等一律不交出去。
11. **上游的内网入口（SCUT_02，`http://xsjw2018.jw.scut.edu.cn/`）没有移植为独立适配器**：任务卡只要 WebVPN 入口。脚本本身同源、不依赖主机，但 manifest 的 `loginUrl` / `scheduleUrlHint` 只指向 WebVPN 子域。

## 6. 变异测试记录

变异改的是**副本**：每个副本在临时目录里是整目录复制（目录名同样是 `scut`，否则 check.js 会因 `manifest.key` 与目录名不一致报错），只替换副本里被改的那个文件，真文件没有被变异脚本写过。每条替换要求恰好命中 1 次。
M1–M10 改 `parse.js` 跑 `check.js`；M11 改 `extract.js`（check.js 不跑 extract.js），在副本上跑冒烟。变异副本收尾时已删除。

| 变异 | 改了什么 | 变红的用例 | 变红的表现 |
|---|---|---|---|
| M1 | `LATEST_END_MINUTES` 21:35 → 21:45 | basic | 第 12 节（21:00-21:45）没被丢，节次表多出一节 |
| M2 | 边界判断 `>` 改 `>=` | late-periods | 恰好 21:35 结束的第 12 节被丢，后面的顺推整体错位 |
| M3 | 同一节号两个时间不再判冲突（改成直接跳过后一行） | rjc-conflict | 不再回落到空课默认表，warnings 少一条，节次表是第一套时间 |
| M4 | 去掉「从第 1 节起连续」的检查 | rjc-short | 缺口后的第 10 节（19:20-20:05）被收进表，节次表多一节且第 9 节没补 |
| M5 | 空课默认第 12 节结束 22:00 → 22:10 | rjc-missing、rjc-conflict | 整张默认表和 warnings 里的第 12 节时间都对不上 |
| M6 | `timeOf` 不再补零（`8:50` 保持原样） | late-periods | 第 1 节写成 `8:50`，不是 `08:50` |
| M7 | 去掉相邻单/双后缀归属守卫（`[0-9周]` 判断） | week-adjacent | `1-8周(单) 9-16周(双)` 退化成 1-16 每周都上 |
| M8 | 完全重复判定漏掉教师 | merge-dedupe | 同教室同节次只教师不同的两行被当成重复，第二位老师的课没有了排课块 |
| M9 | 括号备注示例不限长 | long-warnings | 提醒里贴出完整长括号，与期望（19 字 + …）不符 |
| M10 | 顺推课间 5 分钟 → 15 分钟 | late-periods、rjc-missing | 第 13、14 节顺推出来的时间都错 |
| M11 | `declaredPath` 去掉 `..` 检查（extract.js，冒烟副本） | smoke 的 `scut-dotdot` | `_path='/../x'` 被采用，请求落到 `/../x/kbcx/…`，前缀检查失败 |

**还原校验**：变异前后真文件的 SHA-256 一致 —— `parse.js` = `1326f8215ea677478ab743708c8aee9b5e063c0de077b380e7e3a8b12de6b621`、
`extract.js` = `80e96a669600e948edb38ba0335167daf156bf86cf1420df5784228c2fa36d08`、`manifest.json` = `c6a8462e8406376a864bf8f20e4ebaab2cb8abcb62baf75ca5ae1b4c6bcacd31`。
真文件跑 `check.js` 结果 `RESULT: PASS`，13 个 fixture 全部 MATCH。

## 7. fixtures 与自检

13 对合成用例（`_note` 里写明是编造的，课程、教师、教室、**节次时间**均为虚构，无真实个人信息；教务节次时间的数值是按形状编的，不代表华工真实作息）。期望值是手工推演后写成字面量（生成器 `gen_fixtures.py` 只负责落盘，不调用 parse.js），不是 parse.js 的输出。

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 教务节次时间 13 节，第 12、13 节结束晚于 21:35 → 丢掉，表里留 11 节；校历 20 周；单双周、两段周次、缺教师、缺教室、完全重复行、集中实践课 |
| `late-periods` | 21:35 边界（恰好 21:35 结束保留）、不补零的 `8:50`、重复一行；课表用到第 13-15 节 → 13、14 节顺推、15 节越过 23:59 |
| `rjc-missing` | 节次时间与校历都取不到 → 空课默认 12 节 + 推算开学日；课表排到第 14 节 |
| `rjc-short` | 节次时间只给到第 8 节，带一行读不懂、一行隔着缺口 → 只认第 1-8 节；第 9、10 节取空课默认表 |
| `rjc-conflict` | 同一节号两个不同的时间 → 回落并说明原因 |
| `week-markers` | 单/双标记归属、「共 N 周」三种位置、「第1-第8周」、教学班序号、括号备注、「单双周」同时出现 |
| `week-adjacent` | 相邻周次段的单/双后缀（三个反例） |
| `calendar-sunday` | 每周起始日 7 → 开学日回退到周日 |
| `no-calendar-overweek` | 第二学期 + 校历取不到 + 课表最晚第 21 周 → 总周数抬到 21 |
| `dirty-rows` | 缺课程名 / 星期 8 / 节次空 / 节次超限 / 周次超限；周次从 0 开始；多种节次写法；记录总数对账 |
| `merge-dedupe` | 连续节次合并、教师 / 教室不同的两行都保留、完全相同只留一条、周次并集、重叠不合并 |
| `no-room` | 「未排地点」当作没有教室；缺教师 4 门，提醒点名 3 门 |
| `long-warnings` | 超长课名 / 超长周次文字 / 超长括号备注 → 课名与示例文字截到 20 字，每条提醒 ≤200 字 |

浏览器冒烟（`.test/port-batch14/scut/smoke.py`，Playwright 起假教务站，不联网）20 个场景全部 OK：正常页、菜单页（取首页）、无 `_path` 靠路径推前缀、`_path` 为空串（根部署）、`_path` 形状异常（外域 / `..`）回落、
每周起始日、节次时间 404、节次时间套外壳、校历 404、原型被改写（`filter` / `trim`）、会话失效（登录页 / 统一认证页）、课表 500、登录页 / 首页 / WebVPN 门户 / 统一认证页不发请求。
每个场景核对：请求主机只有映射教务主机；地址与查询串（菜单号 N2151 / N2154）；节次时间与课表的请求体逐字相同且不含 `xqh_id`；POST 请求头；学号 / 身份证号 / 手机号 / `xsxx` / 校区号等不出现在请求与交出的字符串里；载荷关键值；每条 warning ≤200 字。

自检：`node .test/port-batch5/tools/check.js D:/NullClass/jw-adapters/scut` 最后一行 `RESULT: PASS`，13 个 fixture 全部 MATCH。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **真实部署未验证**：全部 fixture 与冒烟都是合成数据。cxRjc（节次时间）与 cxZcByXnxq（校历）在华工是否开放、返回的形状与字段名，没有账号无法验证；取不到就是 `null`，回落并写 `warnings`，不影响导入。
2. **节次时间的真实形状与 21:35 规则的用意**：上游为什么丢掉 21:35 之后的节次（推测是接口会返回不存在的晚间节次）没有文字说明，本件按上游行为照做。若某天课表确实排到被丢掉的节次，会按 H3 补时间并提醒核对，而不是用教务给的原值。
3. **多校区**：华工有多个校区，节次时间可能不同。上游请求不带校区号，本件照做；若教务把多校区的作息混在一起返回且同一节号时间不同，本件整张回落到空课默认表并说明，**不替学生选校区**。若教务按默认校区返回单一一套，则用的是默认校区的时间，用其它校区上课的学生需要自己核对。
4. **WebVPN 映射主机**取自上游 `adapters.yaml` 的 `import_url`（`xsjw2018-jw.webvpn.scut.edu.cn`）。脚本本身同源，不依赖这个值；但宿主靠 `loginUrl` 的主机给这个 origin 注入桥，若学校更换映射域名，manifest 的 `loginUrl` / `scheduleUrlHint` 要跟着改。
   如果用户通过别的 WebVPN 入口形式（例如门户域名加路径前缀）打开教务页面，页面 origin 与 `loginUrl` 不同源，提取期间的网络白名单可能拦住请求；本件没有为这种形式做特殊处理。
5. **`_path` 全局变量**：正方页面通常自带 `var _path`。本件在页面主世界里通过 `window._path` 读它（宿主文档 §3.1 说明脚本在页面主世界执行）；读不到或形状不对时按当前路径推，推不出就不发请求。冒烟用桩页面覆盖了这几条分支，没有真页面验证。
6. **课表接口的真实响应形状**：fixture 是合成的（按上游脚本实际读取的字段形状编），只保证同样的输入永远得到同样的输出，**不保证解析在真实页面上是对的**。拿到真实响应后替换 fixture 并重跑 `check.js`，是最高优先级。
7. **学期总周数 20 周**是本件的取舍（上游没有这一项）；校历取不到时用它并写提醒。华工的学期周数可能不同，用户需在学期管理里核对。
8. **小学期 / 夏季学期**：学期代号 `16` 按「第三学期」处理；华工实际代号未验证。
9. warnings 到 20 条后的截断只有代码阅读，没有 fixture（正常路径下这些计数不会同时爆满）。

## 9. 签名

移植与审计：0x7E7-2023（sonnet 移植，2026-10-20）。
上游出处：`shiguang_warehouse` → `resources/SCUT/SCUT_01.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取；本校脚本最后修改 `80e30cf`，MIT，作者 dezige131）。
