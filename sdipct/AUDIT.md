# 安全审计 —— 山东石油化工学院（乘方智慧教务，经学校 WebVPN 的路径前缀访问）

审计对象：`jw-adapters/sdipct/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `SDIPCT/sdipct.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，2026-10-20 复核仍是最新；
MIT，作者（maintainer）星河欲转；`SDIPCT` 目录最后一次修改 `80e30cf`，已用 `git log -1 -- resources/SDIPCT/sdipct.js` 核对，与任务卡一致）。

审计方式：逐行读上游脚本（217 行）+ 逐行读移植件，并跑移植手册 §5 的静态扫描。扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`（注释）；代码里**没有任何其它绝对地址**。
  `extract.js` 里的 `WEBVPN_HOST = 'webvpn.sdipct.edu.cn'` 只用来判断「当前页面是不是 WebVPN」，请求地址由 `window.location.origin` 加固定的教务前缀拼出。
  `manifest.json` 里的 `loginUrl`、`scheduleUrlHint`、`homepage` 是给宿主看的声明，不是请求。
- 网络调用：只有 `extract.js` 里 `request` 函数中的一处 `fetch(jwUrl(path), options)`（`X-Requested-With` 是请求头字符串，不是 XHR 对象）。
  `parse.js` 里没有任何网络调用、没有 `document.` / `window.` / 桥调用。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` /
  `new Function` / `sendBeacon` / `WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit` / `setAttribute` 全部无命中。
  `extract.js` 对页面只做两件读操作：`window.location` 的主机 / 路径 / 查询串、`getElementById('xnxqdm')` 读学期下拉框（外加 `DOMParser` 解析自己取回的课表页）。
- ES5 token 扫描（注释也算，`check.js` 同口径）：`=>`、反引号、`let `、`const `、`class`、`async`、`await`、展开符、可选链、`??`、`padStart`、
  `Array.from`、`new Set` / `new Map`、`includes(`、`startsWith(` 全部无命中；NUL 等控制字节为 0。
- 模板残留：检索「hnsf」「河南」「htu」「jwc.」「创新港」「建设东路」「平原湖」「夏季作息」「swu」「西南」「jwglxt」「正方」「hueb」「timetable」「提问」「`__ncSelect`」，
  代码、manifest、fixtures 零命中（仅 `extract.js` / `parse.js` 文件头与周次注释里有意写「骨架照 hnsf」「周次写法照 swu」）。
- 个人信息：`fixtures/` 全部为合成数据（甲 / 乙 / 丙老师、虚构教学楼），没有真实姓名与学号；`extract.js` 对排课行按字段白名单取值（见 §2）。

## 0. 上游情况与模板选择

上游 `SDIPCT/sdipct.js` 的全部工作（`adapters.yaml`：`adapter_id: SDIPCT`，作者 星河欲转，`import_url` 为 WebVPN 的教务根地址，即 `manifest.loginUrl`）：

1. `showAlert` 公告 → `showPrompt` 问起始学年（四位数字）→ `showSingleSelection` 选「第一学期 (秋季) / 第二学期 (春季)」。
2. `POST https://webvpn.sdipct.edu.cn/https/<十六进制>/new/student/xsgrkb/getCalendarWeekDatas?vpn-12-o2-jwxt.sdipct.edu.cn`，
   体 `xnxqdm=<学年><01|02>`（`content-type: application/x-www-form-urlencoded; charset=UTF-8`，`credentials: include`），`response.json()`。
3. `parseJsonData`：要求 `code === 0` 且 `data` 是数组；每行只要求 `kcmc && xq && ps && pe` 非空。
   **优先读 `jxcdmc2`**（"教室-周次,教室-周次"）：按最后一个「-」切，周次 `Number()`，按教室归并，一间教室一门课（`weeks` 升序）；
   一个都没解析出来才回落到 `jxcdmc` + `zc`（`zc` 逗号分隔的数字）。教师缺了写「未知教师」，教室缺了写「未知地点」。最后丢弃周次为空或起始节大于结束节的课。
4. 固定一张 10 节表 `StandardTimeSlots`（每节 50 分钟，08:00 起，第 5 节 14:00，第 9 节 19:00），`savePresetTimeSlots` 存下，没有校区或季节之分。
5. `saveImportedCourses` + `notifyTaskCompletion`。

平台判断：路径 `/new/student/xsgrkb/getCalendarWeekDatas`、字段 `kcmc` / `teaxms` / `jxcdmc` / `jxcdmc2` / `xq` / `ps` / `pe` / `zc`、`xnxqdm` 请求体，
与库里已移植的 `hnsf`（河南师范大学，批次十四，乘方教务）以及上游的 `CMC` / `LIT` / `NENU` / `SHXY` / `GLMU` / `GXMU` 同属一个平台。

**模板选择：`hnsf`**。理由：① 同平台同接口，取数三步（课表页读学期 → 整学期排课 → 第 1 周日期）、学期与开学日的处理、`weeksOf`（含单双标记归属、
`第1-第8周`、`共 N 周` 只剥备注）、`warn()` 限长出口、H3 节次补全、缺教师 / 缺教室汇总都已在批次十四审计过；② 任务卡给的候选 `shxy` 虽然同平台，
但它的难点是两个校区的节次表与「按教室判断校区」（厚德楼 / 崇德楼），本校没有校区之分，用不上，且它的取数层没有 WebVPN 处理；
`czimt` / `gdust` 是正方教务（`/kbcx/` + `gnmkdm`）的 WebVPN 件，只借它们的 **WebVPN 前缀与查询串写法**，不借解析层。
`hnsf` 里本校用不上的东西（三选一提问桥、三张节次表、按排课行判断用哪张表）已全部删掉，见 §5。

## 1. 请求清单（与代码逐条对应）

三个请求全部在用户已登录的教务页面里发出，全部打在当前页面所在的 WebVPN 主机上，地址 = `window.location.origin` + 固定教务前缀 + 路径 + `?` + WebVPN 查询片段
（`jwUrl`）。教务前缀 `/https/77726476706e69737468656265737421fae0598869236c596e0b9de29d51367bd943` 取自上游脚本（前 32 位是 WebVPN 通用的固定头，后面是教务主机的加密串）；
查询片段沿用当前地址里的 `vpn-<数字>-o<数字>-jwxt.sdipct.edu.cn`（`vpnPart`），找不到才用上游写死的 `vpn-12-o2-jwxt.sdipct.edu.cn`。登录全程由用户手工完成。

| # | 方法 | 地址（`<前缀>` = 上面的教务前缀，`<vpn>` = 查询片段） | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|---|
| 1 | GET | `<前缀>/new/student/xsgrkb/week.page?<vpn>` | 无 | 读学期下拉框 `#xnxqdm` 的默认选中项（**当前页面上已经有该下拉框就不发**，直接读用户选的那项） | 任何失败（非 2xx / 网络错误 / 没有下拉框 / 超长）都当没取到，改按今天的日期推算学期，parse.js 在提醒里说明 |
| 2 | POST | `<前缀>/new/student/xsgrkb/getCalendarWeekDatas?<vpn>` | `xnxqdm=<学期代码>`（与上游体一字不差，上游的 `<学年><01\|02>` 就是这个代码） | 取整学期排课（`{code:0,data:[…]}`） | 非 2xx → 抛「教务系统返回错误（代码 N）」；网络错误 → 抛「连不上教务系统」；响应不是 `{code:0,data:[…]}`（含登录页 HTML、`code` 非 0）→ 抛「教务系统没有返回课表数据（…）：登录状态可能已失效」；`data` 为空 → 抛「这个学期还没有课表数据」 |
| 3 | POST | `<前缀>/new/xlxx/getDatesOfWeek?<vpn>` | `xnxqdm=<学期代码>&zc=1` | 取第 1 周七天的日期，用作开学日（**上游不取开学日；这一条是新增，见 §5**） | 任何失败都交 `null`，parse.js 按学期推算开学日并在提醒里说明；绝不影响取课表 |

不发请求的情形（都在发任何请求之前，**同步抛出**，见 §9 第 6 条）：

| 当前页面 | 结果 |
|---|---|
| 主机是 `webvpn.sdipct.edu.cn`、路径在教务前缀下的内页（如 `…/new/welcome.page`、`…/new/student/xsgrkb/week.page`） | 取数 |
| 教务前缀下的根路径（`<前缀>` 或 `<前缀>/`，不看查询串）、路径含 `login` 或单独的 `cas` 一段 | 抛「当前打开的是登录页或教务系统首页。请先登录学校的 WebVPN，进入教务系统并打开你的课表页面…」 |
| WebVPN 自己的根路径 `/`、`/login`，或 WebVPN 里映射到别的系统的 CAS 页（`/https/<别的十六进制>/cas/…`） | 同上（登录类提示） |
| WebVPN 里映射到别的系统的页面（前缀不是教务前缀，且不是登录页） | 抛「当前页面不是山东石油化工学院的教务系统…」 |
| 其它主机（含直连 `jwxt.sdipct.edu.cn`） | 同上（不是教务系统） |

只看路径、不看查询串：统一认证页的 `service=` 参数里会带着教务自己的地址，看查询串会误判。

## 2. 读了什么、交出去什么（逐字段）

`extract.js` 交给 `parse.js` 的对象（`JSON.stringify` 后的字符串）：

| 字段 | 内容 | 来源 |
|---|---|---|
| `term.code` | 学期代码，必须是 6 位数字 | 下拉框选中项的 `value`；读不到按日期推算 |
| `term.name` | 学期下拉框里的文字（如「2026-2027学年第一学期」），推算时为空串 | 下拉框 `textContent` |
| `term.source` | `page` / `date` | extract 判断 |
| `today` | 提取当天日期 | 本机时钟（本地日期，不用 `toISOString`） |
| `weekOne` | `[{xqmc, rq}]`（七天里每天的星期标号与日期）或 `null` | 请求 #3，只取这两个字段 |
| `rows[]` | 每条排课：`kcmc` 课名、`teaxms` 教师、`jxcdmc` 教室、`jxcdmc2` 分周教室、`xq` 星期、`ps` / `pe` 起止节次、`zc` 周次、`qssj` / `jssj` 上课起止时间 | 请求 #2 的 `data[]`，**字段白名单**（`ROW_FIELDS`），其余字段一律不带出 |

响应里夹带的学号、姓名、身份证号、手机号、课程任务号等（上游也没读）不在白名单内，不会出现在输出里；冒烟里往课表响应、学期下拉框所在的页面脚本、开学日响应里塞了
`xh` / `xm` / `sfzh` / `sjh` / `kcrwdm` 与外层 `xsxx`，输出里都找不到（冒烟逐场景断言顶层字段只有 `term` / `today` / `weekOne` / `rows`，行字段都在白名单内）。
`jxcdmc2` 是教学信息（教室 + 周次），`qssj` / `jssj` 是教务给的实际上课时间，都不是个人信息。`jxcdmc2` 与上游一致；`qssj` / `jssj` 不在 SDIPCT 上游里，
来源是同平台的其它上游脚本（`CMC/cmc_01.js`、`LIT/lit_01.js`，见 §9 第 2 条）。

`parse.js` 是纯函数：不碰网络、不碰页面，输出载荷里的教师名只是课表本来就显示的任课教师，不含学生信息。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读 `password` / 登录表单 / `localStorage` / Cookie；`credentials: 'include'` 只是让浏览器带上用户已有的会话；全程没有提问 |
| 2 | 不外发 | 通过。全脚本唯一的 `fetch` 调用点发三个同源请求，没有 `sendBeacon` / `WebSocket` / `new Image().src`；没有任何第三方域 |
| 3 | 请求域可控 | 通过。请求主机永远是用户当前打开的 `webvpn.sdipct.edu.cn`（`locate` 用 `hostname` 精确比较，其它主机直接报错不发请求），路径固定在教务前缀下，查询片段只认 `vpn-<数字>-o<数字>-jwxt.sdipct.edu.cn`（当前地址里带了别的内部主机名的片段不沿用，改用默认值；冒烟 `vpn-foreign-host` 钉住）。`allowHosts: []`，没有通配；WebVPN 主机与 `loginUrl` 同源，宿主按规则不用列 |
| 4 | 只读课表 | 通过。三个请求依次是：课表页（只读学期下拉框）、整学期排课、第 1 周日期；不请求成绩、学籍、个人信息、缴费等任何其它接口 |
| 5 | 不埋点 | 通过。无统计 / 上报 / 遥测；上游里全部 `console.log` / `console.error` / `showToast` 一并去掉 |
| 6 | 不 eval 远程代码 | 通过。无 `eval` / `new Function`；教务返回的字符串只做 `JSON.parse` 与 `DOMParser` 解析（解析的是只读的新文档，不执行脚本）。`hasWord` 里 `new RegExp` 的模式是代码里写死的 `cas` 字样，不含外部输入 |
| 7 | 不写页面 | 通过。不写 DOM、不改表单、不提交、不点击；`DOMParser` 解析出来的文档不挂到页面上 |
| 8 | 不依赖用户输入之外的秘密 | 通过。无硬编码密钥 / 令牌 / 他人学号；常量只有 WebVPN 主机名、教务前缀（取自上游脚本的公开地址，不是密钥）、接口路径、学期代码格式、体积上限和一张节次时间表 |

## 4. 给学生看的文字

`extract.js` 的报错、`parse.js` 的 warnings 都按 `docs/ux-writing.md` 写成大白话：不出现「接口」「载荷」「上游」「脚本」「字段」「JSON」「HTML」「null」「作息表」；
状态码写成「教务系统返回错误（代码 N）」；时间表统一叫「节次时间」；改开学日、总周数、节次时间指向「学期管理」，改教师 / 教室指向「编辑课程」。
带课名的提醒（缺教师 / 缺教室汇总、上课时间对不上、分周地点对不上、周次认不出）课名截到 20 字、最多点名 3 门，每条经过 `warn()` 再截到 200 字以内；
fixture `long-warnings` 钉住这一点（超长课名各一，六类提醒同时出现）。

提醒清单（顺序固定）：① 学期来源（取自教务 / 按日期推算）；② 开学日来源（取自教务 / 推算 / 教务给的日期不属于这个学期而忽略 / 标成周一的日期不是周一已回退）；
③ 总周数（教务不给，按 max(最晚周次, 20) 导入）；④ 节次时间来源（教务没给，按学校公布的 10 节表导入，请核对）；⑤ 排课行的上课时间与节次时间对不上（点名）；
⑥ 节次补全（顺推 / 补不了）；⑦ 被跳过的行（分类计数 + 认不出的周次写法）；⑧ 缺教师 / 缺教室汇总；⑨ 分周次的上课地点与周次对不上；
⑩ 周次里的序号括号 / 备注括号 / 越界周次 / 孤立单双标记 / 单双同写。

## 5. 与模板（hnsf）的差异

1. **WebVPN 前缀与查询串**（`hnsf` 是直连 `jwc.htu.edu.cn` 相对路径）：地址 = 当前 origin + 教务前缀 + 路径 + `?vpn-…`（`locate` / `vpnPart` / `jwUrl`）。
   页面归类 `locate` 分 `jw` / `login` / `other` 三种；教务前缀下的根路径当登录页或首页（与 `hnsf` 对根路径的处理同口径，只是这里根路径是前缀本身）。
2. **只有一张节次时间表**：`hnsf` 上游有三张表并让用户三选一，这里上游只有一张，所以删掉了 `__ncSelect` 提问、`timetable` 字段、按排课行自动判断用哪张表的逻辑。
   `qssj` / `jssj` 保留，只用来核对：对不上的课点名提醒、课仍按节次导入（手册 §4.4：自定义时间在有节次时当作附加信息丢掉并提一句）。
3. **教室按周次拆课（本校专属，`hnsf` 只数个数）**：上游优先读 `jxcdmc2` 并按教室拆成多门课，所以 `venueWeeksOf` 把它读成「教室 → 周次」，每个教室一组安排，
   再走同一套合并与切段。读不出来（整串没有「-周次」）回落到 `jxcdmc` + `zc`，与上游一致。上游对 `zc` 里有而 `jxcdmc2` 里没有的周次是**静默丢掉**的，
   这里保留并用主要教室（`jxcdmc`）补上，反过来 `jxcdmc2` 里有而 `zc` 里没有的周次也保留，两边对不上的课（以及教室串里有看不懂的项）按类型汇总提醒。
4. 去掉 `hnsf` 对 `jxcdmc2` 的「不同周次地点不一样」提醒（现在是真的按周次拆了，不再需要「已按主要地点导入」）。
5. 开学日、总周数、学期名、H3 节次补全、缺教师 / 缺教室汇总、周次解析、同课合并：与 `hnsf` 完全一致（只改了学校名与节次表）。

## 6. 上游里删掉 / 改掉的东西及理由（对应两份文件头的「移植改动」）

| 上游 | 处理 | 理由 |
|---|---|---|
| `showAlert` 公告、`showPrompt` 问学年、`showSingleSelection` 选学期 | 去掉；读页面学期下拉框 `#xnxqdm` → 取一次课表页读默认项 → 按日期推算 | 公共说明第 2 条：不弹窗问学年学期；用户要别的学期就在教务页面里切一下再提取 |
| 教师缺了写「未知教师」、教室缺了写「未知地点」 | 留空（null），课照常导入，按类型汇总提醒 | 手册 §4.7：「未知」会被课表当成真名显示；不静默 |
| `parseWeeks`：`zc` 只认逗号分隔数字，`Number("1-16")` 是 NaN 被过滤，课整门丢 | 用 `weeksOf`（照批次十 swu，含单双标记归属、`第1-第8周`、`共 N 周` 只剥备注），仍认纯逗号列表 | 上游接受的写法一个不能少；放宽的写法钉进 fixture `week-markers` / `week-anomalies` |
| `jxcdmc2` 周次 `Number(...)` 不检查范围（可以是 0、很大的数）；重复项不去重 | 周次必须在 1..30，越界丢弃并计数提醒；重复周次去重 | 载荷校验要求周次在 1..totalWeeks；fixture `venue-weeks` |
| 上游在 `jxcdmc2` 能读出时完全不看 `zc` | 两边都看，对不上的保留并提醒（见 §5 第 3 条） | 不许静默丢周次 |
| 不检查 `xq` 范围 | `xq` 必须是 1..7，节次 1..20 且起不晚于止，否则按类计数提醒、整行跳过 | 载荷校验；fixture `week-anomalies` |
| `StandardTimeSlots` 写死 10 节表后 `savePresetTimeSlots` | 同一张表逐节抄进 `SCHOOL_TIMES` 随载荷交出（`periodTimes`）；用到第 11 节及以后按统一修订 H3 补 | 空课载荷格式 |
| `saveImportedCourses` / `savePresetTimeSlots` / `notifyTaskCompletion` / `showToast` / 全部 `console.*` | 去掉 | 拾光的桥能力，空课由宿主保存；日志属于埋点类输出 |
| `response.json()` 解析失败时 `showToast("网络请求失败…")` 并返回 null（静默结束） | 抛带原因的大白话错误（非 2xx → 代码；不是预期形状 → 没有返回课表数据） | 失败要让学生看得到 |
| 起始学年与学期用 `new Date().getFullYear()` 当输入框默认值 | 取页面选中的学期；读不到才按日期推算（8 月到次年 1 月为第一学期，1 月算上一学年） | 避免年份错一年；推算时 parse.js 提醒 |
| 上游没有对重复行、同一上课安排的处理 | 去掉完全相同的行，并把「课名、教师、教室、星期、起止节次都一样」的行的周次取并集 | 不改任何一周的安排，只合并 |

## 7. fixtures（10 对，全部合成）

| 用例 | 覆盖 |
|---|---|
| `basic` | 教室按周次拆课（1-8 周 203、9-16 周 305；单周体育馆、双周操场；教室每周都一样归并成一段）；教室名带「-」；`jxcdmc2` 为空串 / 缺失时回落；连堂、分段周次 1-8 与 10-17、完全重复行；学期取页面选中的、开学日取教务第 1 周日期；上游 10 节表 |
| `venue-weeks`（本校专属） | `zc` 比教室列得多（补主要教室）、教室比 `zc` 列得多（保留）、教室串里有看不懂的项、整串读不出（回落不提醒）、只有分周教室没有 `zc`、周次 0 与 31 越界丢弃、教室名为空 → 缺教室 |
| `week-markers` | 前缀 / 后缀单双标记归属、`共 N 周` 只剥备注、`第1-第8周`、全角标点、波浪线、「至」、逗号列表 |
| `late-periods` | 第 11-13 节顺推（20:55-21:40 / 21:45-22:30 / 22:35-23:20），第 14 节越过 23:59 补不了 |
| `row-times` | 排课行带上课起止时间：相符不提醒（含带秒与不带秒）、起点或终点对不上点名、没带或只带一头不核对 |
| `long-warnings`（带课名的提醒不超 200 字） | 超长课名（>20 字）截 19 字 + 「…」；缺教师 / 缺教室、上课时间对不上、分周地点对不上、周次认不出各一条，每条 ≤200 字；分周地点按代码点排序 |
| `start-estimate` | 学期与开学日都按日期推算（第二学期 → 2 月 20 日所在周的周一）；课表排到第 22 周抬高总周数；第 11-12 节顺推 |
| `week-anomalies` | 序号括号、备注括号、单双同写、周次越界、孤立标记，以及缺课名 / 星期不合法 / 节次倒挂 / 周次为空 / 周次 99 的行被跳过并分类计数 |
| `start-rejected` | 教务给的第 1 周日期不属于这个学期 → 忽略并推算 |
| `start-adjusted` | 标成周一的日期实际是周二（带时间部分）→ 回退到当周周一并说明 |

期望值全部由 `.test/port-batch15/sdipct/gen_fixtures.py` 里手推的值写出（节次时间表照上游手抄；周次切段、按教室拆课及块排序、开学日、总周数、节次顺推、提醒文本都是手算），
没有读 `parse.js` 的输出；首次跑 `check.js` 10 对全部 MATCH。其中 `basic` 在变异测试里发现一处覆盖漏洞（教室名带「-」的那门课，主要教室与分周教室同名，变异后回落结果相同，没有变红），
已把主要教室改成另一个名字（「实验楼A区」）后重新生成并重跑。

## 8. 验证记录（2026-10-20）

- 自检：`node .test/port-batch5/tools/check.js jw-adapters/sdipct` → `RESULT: PASS`（10 对 fixture）。
- 浏览器冒烟：`python -I -X utf8 .test/port-batch15/sdipct/smoke.py all` → 22/22 OK（Playwright 起假 WebVPN 教务站，全部请求被拦下，不联网）。每个成功场景断言：
  请求序列与请求体、每个请求都在教务前缀下且主机是 `webvpn.sdipct.edu.cn`、查询串等于预期、输出里没有学号 / 姓名 / 身份证号 / 手机号 / 课程任务号、
  顶层字段与行字段都在白名单内、节次时间是上游那张 10 节表、教室按周次拆成多段、提醒 ≤200 字。场景与拼出的地址：
  - 课表页本身带下拉框（`…/new/student/xsgrkb/week.page?vpn-12-o2-jwxt.sdipct.edu.cn`）：不发 GET，只发 `POST <前缀>/new/student/xsgrkb/getCalendarWeekDatas?vpn-12-o2-jwxt.sdipct.edu.cn`（体 `xnxqdm=202601`）与 `POST <前缀>/new/xlxx/getDatesOfWeek?vpn-12-o2-jwxt.sdipct.edu.cn`（体 `xnxqdm=202601&zc=1`）；
  - 教务内页没有下拉框：先 `GET <前缀>/new/student/xsgrkb/week.page?vpn-12-o2-jwxt.sdipct.edu.cn`，再两个 POST（学期取到页面选中的 202602）；
  - 当前地址没有查询串：三个请求都补上默认片段 `vpn-12-o2-jwxt.sdipct.edu.cn`；当前地址是 `vpn-13-o2-jwxt.sdipct.edu.cn`：沿用；当前地址的片段带了别的内部主机名：不沿用，改默认；
  - 课表页读不到下拉框（登录页内容 / 404）：按日期推算学期，请求体 `xnxqdm=<推算值>`；开学日接口 404：课表照常，提醒里说明推算；
  - 排课行带上课时间：提醒点名；
  - 不发请求直接报错：教务前缀根路径（带 / 不带查询串）、教务前缀下 `/login`、WebVPN 根 `/`、WebVPN `/login`、别的系统的 CAS 页（登录类提示）、别的系统的普通页、其它主机、直连 `jwxt.sdipct.edu.cn`（不是教务系统提示）；
  - 发了请求但报错：课表响应是登录页内容、`code:1`、`data` 为空、HTTP 500。
- extract.js 的地址拼法没有走另外的桩脚本：上面的浏览器冒烟跑的就是真实的 `extract.js`（`page.evaluate`），请求地址取自 Playwright 拦到的真实请求。
- 变异测试（在临时目录的 `parse.js` 副本上改，每处都有用例变红，原件未动，改完最后复跑 PASS；脚本 `.test/port-batch15/sdipct/mutate.py`）：

| # | 改坏哪一处 | 变红的用例 |
|---|---|---|
| 1 | 忽略分周教室（`jxcdmc2`）整条路径 | `basic`、`venue-weeks`、`long-warnings` |
| 2 | `zc` 里有而分周教室里没有的周次不再用主要教室补上 | `venue-weeks`、`long-warnings` |
| 3 | 教室名里的「-」不再按最后一个切（`.*` 改 `[^-]*`） | `basic` |
| 4 | 分周教室里周次 0 不再丢弃 | `venue-weeks` |
| 5 | 前缀单双标记归属（段首 `(单)` 不再认，被并到上一段） | `week-markers` |
| 6 | 「共 N 周」剥离改成上游式的一路吞到行尾 | `week-markers` |
| 7 | 第 5 节开始时间 14:00 → 14:30 | 10 对全部变红（`basic` 等） |
| 8 | 节次顺推的课间分钟数 5 → 10 | `late-periods`、`start-estimate` |
| 9 | 上课时间核对只看起点（不看终点） | `row-times`、`long-warnings` |
| 10 | 点名课名不截断到 20 字 | `long-warnings` |
| 11 | 第 1 周日期合理性判断恒真 | `start-rejected` |
| 12 | 缺教室不再计入汇总 | `venue-weeks`、`long-warnings` |

## 9. 已知风险与未验证项（我们没有本校账号，真机没验过）

1. **全部字段形状来自上游脚本与同平台脚本，没有在山东石油化工学院真机验证**：`getCalendarWeekDatas` 的 `{code:0,data:[…]}`、`xq` / `ps` / `pe` / `zc` / `kcmc` / `teaxms` / `jxcdmc` / `jxcdmc2`
   来自 SDIPCT 上游；`week.page` 里的 `#xnxqdm`、`getDatesOfWeek` 的 `[{xqmc,rq}]`、`qssj` / `jssj` 来自同平台（乘方教务）的 `CMC` / `LIT` / `NENU` 上游，
   本校的部署上不一定有；缺了都有兜底（日期推算学期 / 推算开学日 / 不核对上课时间），并在提醒里说明，不会让导入失败。
2. **`jxcdmc2` 的写法只来自上游脚本的解析代码**（"教室-周次,教室-周次"、教室名里可能带「-」），没有真实样本。教室名以数字结尾又恰好是「…-N」写法时会被当作周次，
   这是上游同样的歧义。认不出来的项会计数提醒、不吞课。
3. **节次时间表无法核对**：照上游逐节抄，但没有学校公布的时间可对照；上游没有校区或季节之分，也就没有可以判断的依据。教务（`qssj` / `jssj`）若给出不同的时间，
   会点名提醒，但不会改表。提醒里写「按学校公布的 10 节节次时间」沿用批次十的统一说法，实际是上游作者的写法（上游说明里写明「非本校开发者适配」，错了建议提 issue）。
4. **总周数是假设**：教务不给，按 `max(最晚周次, 20)`，提醒里说明；真实学期若是 18 周，课表照常可用，只是「共 N 周」显示偏大。
5. **WebVPN 前缀写死为上游脚本里的那个映射**：学校换 WebVPN 映射（教务主机加密串变化）时，`JW_PREFIX`、`manifest.loginUrl`、`scheduleUrlHint` 三处要一起改。
   查询片段里的 `o2` 的含义（推测是 https 内部站点）没有文档可查，沿用上游和当前地址里的值。
   WebVPN 网关本身若会改写 `fetch` 的地址，上游脚本传的就是带前缀的完整地址、行为与上游一致，这里没有额外风险，但真机未验。
6. **同步抛错**：登录页 / 首页 / 非教务页面是**同步**抛出提示（`extract.js` 最后几行，在发任何请求前）。宿主若只接 Promise 的 reject，这几种提示会丢；
   `hnsf`、`gdust` 等同写法，宿主是否按同步异常展示，本件没有验证。
7. **教务前缀下的根路径一律当登录页或首页**：如果登录后教务首页恰好就是前缀根路径，用户会看到「当前打开的是登录页或教务系统首页」，需要先点进课表页再提取；
   `scheduleUrlHint` 指向 `week.page`（路径取自同平台其它学校的上游脚本，未验证，若 404 用户仍可手动打开课表页）。
8. **直连校内地址不支持**：上游只有 WebVPN 入口，查询片段里的内部主机名 `jwxt.sdipct.edu.cn` 只是 WebVPN 的内部目标，我们没有它在校内网络可直连的依据，
   所以不为它加 `allowHosts`，也不处理直连页面（直连页面会收到「不是教务系统」的提示）。
9. **教师字段原样取**：同平台的 `CMC` 上游会去掉教师名里的 `[…]` 并去重，SDIPCT 上游只做 `trim`，这里照 SDIPCT；教务若把教师写成「张三[教授]」之类，会原样显示。
10. **学期推算**：没有读到学期下拉框时，8 月到次年 1 月算第一学期、2 到 7 月算第二学期；夏季学期（代码 03）只有在页面下拉框里选中时才会出现。

签名：0x7E7-2023（sonnet 移植，2026-10-20）
