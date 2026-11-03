# 北京工商大学（btbu）移植审计

## 出处

- 上游文件：`resources/BTBU/btbu.js`（713 行，文件头「API解析（BTBU_02）」），作者 lztttt（`adapters.yaml` 的 maintainer）。
- 上游快照 `29498b0`。本校脚本最后提交 `80e30cf`（`git log -1 -- resources/BTBU/btbu.js` 核对一致，与任务卡相同）。该提交是批量合并，提交者不是作者。快照未修改。
- 上游 `adapters.yaml`：adapter_id `BTBU`，名称「北京工商大学本科教务」，import_url `https://jwgl.btbu.edu.cn/`，maintainer `lztttt`。
- 主调度已定入口：`loginUrl` = `https://jwgl.btbu.edu.cn/jsxsd/`；`allowHosts` = `["vpn.btbu.edu.cn"]`；`scheduleUrlHint` = `https://jwgl.btbu.edu.cn/jsxsd/xskb/xskb_list.do`。
- 直连请求的主机是 `loginUrl` 的同源（规范 §3.3 允许）；WebVPN 请求的主机由 `allowHosts` 放行。

## 模板选择

任务卡给了 `gdkm` / `csuft` 两个候选，选 **csuft**：

- 同为强智 `/jsxsd/`，且带 WebVPN 前缀、同源请求、登录页与门户页判断、15 秒超时、内容校验，这些都已审计；
- 周次 `weeksIn`、节次 `periodsIn`、`runsOf`、合并、提醒限长、H3 补节次都照 csuft 的已审计版本搬，没有另写；
- 不照抄 csuft 的 `qz-weeklyTable` 周历结构和域名探测（北工商上游没有周历，也只有一个域名）。

`gdkm` 的 `qz-weeklyTable` 结构同样不同构，未采用。

## 与模板不同构之处

1. **课表形态**：上游读 `table#timetable`，格子是 `div.kbcontent`（另有隐藏副本 `div.kbcontent1`），卡片是无 title 的 font（内含 `kchConfig` 编号提示，外加课名）和 title 为「教师 / 老师」「周次(节次)」「教室」的 font。模板读 `li.courselists-item`。
   - `extract.js` 的 `piecesOf` / `divsOf` / `timetableRows` 只搬运原始文字；
   - 课名判断、编号兜底、「------」分隔、周次与节次解释全部放在 `parse.js` 的 `parseCell` / `cleanCourseName`（照上游 `cleanCourseName`、`parseCellInto` 的顺序）。
2. **学期来源**：上游 GET 课表页读 `select[name=xnxq01id]`，弹窗让学生选。本件不弹窗：取页面标出的当前学期（`selected`），没有标出就取列表第一项，并把 `picked` 交给 `parse.js` 写进提醒。
3. **取数方式**：上游用隐藏表单 + 隐藏 iframe 提交 POST。本件改成 `fetch` 直接 POST（取舍见「已知风险」）。
4. **周历与开学日（上游没有周历）**：上游课表页不给开学日，上游要学生手填（`showPrompt`，可跳过）。本件照 csuft 加一个**可选**的周历请求 `jxzl_query`（见「请求清单」）：从第 1 周那一行读开学日，读法与 csuft 一致（第 1 周的星期一格，或同行第一个有日期的格子往回推）。周历取不到时，按学期号推算：第 1 学期取 9 月 1 日所在周的周一，第 2 学期取 2 月 20 日所在周的周一（学年取学期号里的年份），并在提醒里写明「没取到教务的周历，开学日按……推算为 X」。有周历时总周数也用周历的，取不到照旧 20，课表里有更晚的周次才抬高。
5. **节次**：上游写死 13 节（逐节抄入 `SLOT_TIMES`）。超出的节次按统一修订 H3 顺推（课间 5 分钟、每节 45 分钟，越过 23:59 就停）。顺推能补到第 16 节，第 17 节起补不了，这些课跳过并提醒。
6. **合并**：上游是两段式合并（`mergeAndDistinctCourses`）。本件沿用 csuft 的 key 规则：名称、教师、教室、星期、周次都一致，且起点不大于上一段终点加 1，才合并。同一节的重复行因此不会叠成两门。

## 请求清单

前缀 `<前缀>`：直连为空串；WebVPN 为 `/https/<站点串>` 或 `/https-443/<站点串>`，由当前页地址里 `/jsxsd/` 之前的部分截取，并用正则 `^/https?(-\d+)?/[0-9A-Za-z]+$` 校验。其它形态的地址直接提示，不发请求。origin 取当前页的 origin，只请求同源地址。

| 方法 | 地址 | 请求体 | 干什么 | 取不到时 |
|---|---|---|---|---|
| GET | `<origin><前缀>/jsxsd/xskb/xskb_list.do` | 无 | 课表页：读学期下拉 `name=xnxq01id` 的选中项与课程模式 `name=kbjcmsid` | 页面标题含「登录」且无学期：「登录已失效」；没有学期下拉：「没有找到学期列表」；状态码非 2xx：「教务系统返回错误（代码 N）」；网络失败：「连不上教务系统」 |
| POST | 同上 | `cj0701id=&zc=&demo=&xnxq01id=<所选学期>&sfFD=1&wkbkc=1&kbjcmsid=<课程模式>` | 所选学期的整学期课表 | 没有 `#timetable`：标题含「登录」则「登录已失效」，否则「没有找到课表」；有表但没有课程卡片：「没有找到课程」 |
| POST | `<origin><前缀>/jsxsd/jxzl/jxzl_query` | `xnxq01id=<所选学期>` | 可选：教学周历（照 csuft；上游没有这一请求），第 1 周的日期格用来定开学日，各周标签用来定总周数 | POST 失败或页面里没有周历行：回落 GET |
| GET | 同上 `?xnxq01id=<所选学期>` | 无 | 周历的回落请求 | 也取不到：没有周历，开学日按学期号推算并提醒，总周数按 20（课表更晚才抬高）。周历失败不影响课表导入，也不报错 |

课程模式取页面选中项，没有就取第一个有值的项；都没有时用上游抓包得到的常量 `BA619E6D28314968AD899E77F638AE08`（与上游兜底相同，不是秘密）。

登录页、WebVPN 门户页、学校主页、他站，在任何请求之前直接提示，不发请求（`loginHint`）。

## 读了什么、交出去什么

读取面：

- 地址的协议、主机、路径（不要查询串）；页面 `<title>`（只用来判断登录）；
- `select[name=xnxq01id]` 的选项（value、文字、是否 `selected`）；`select[name=kbjcmsid]` 的选中值；
- `#timetable` 每一行的每个 `td`：没有课表格子的 `td` 交出文字（表头、行首标签）；有课表格子的只交格子列表；
- 每个 `.kbcontent` / `.kbcontent1` 的隐藏标志（`display:none`）；
- 格子里 font 的 `title` 与文字，去掉 `kchConfig` 子节点后的文字。
- 教学周历（可选）：带 `qz-weeklyTable-label` 的行的周次标签，以及该行 `qz-weeklyTable-normalDay` 格子的日期文字。

`extract.js` 交出去的字段（逐字段）：

- 顶层：`source`（固定 `btbu-jsxsd`）、`pageUrl`（协议 + 主机 + 路径）、`now`（本地日期）、`term.code` / `term.name` / `term.picked`、`calendar.weeks[].label` / `calendar.weeks[].days`（取不到时为空列表）、`rows`。
- `rows[].tds[]`：`span`（colspan）、`text`（仅无格子的单元格）、`divs[]`。
- `divs[]`：`hidden`、`pieces[]`。
- `pieces[]`：`t`（font 的 title，无 title 时为空串）、`x`（文字）。`t` 为空的是课名候选；`t` 非空时只留 title 含「课程 / 教师 / 老师 / 周次 / 教室」的 font（白名单，`KEEP_TITLE`）。

不交出去：学号、姓名、身份证号、手机号、隐藏令牌、`教学楼`、`班级`、`备注`、二维码，以及 `kchConfig` 里的编号。

`parse.js` 交出去的载荷：学期名、开学日、总周数、节次时间（13 节加补齐的节次）、课程的课名 / 教师 / 教室 / 星期 / 节次 / 周次段。教师或教室是「未知」「未知教师」「暂无」「暂无教师」「暂无教室」「待定」等占位词，写成 null。教师括号里的备注（外聘、研究生、实验、主讲）先去掉再判空，不拆成第二位教师。

## 移植手册 §5 八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读密码、登录框、本地存储；只看地址与标题判断是不是登录页。 |
| 2 | 不外发 | 通过。只有两个同源 `fetch`（GET、POST），`credentials: same-origin`。没有信标、没有长连接。 |
| 3 | 请求域可控 | 通过。直连时的主机是 `loginUrl` 同源；WebVPN 时是 `vpn.btbu.edu.cn`，与 `allowHosts` 一致。无通配。 |
| 4 | 只读课表 | 通过。只请求课表页。不请求成绩、学籍、个人信息、缴费。 |
| 5 | 不埋点 | 通过。无统计、无上报。 |
| 6 | 不 eval 远程代码 | 通过。无 `eval`、无 `Function` 构造。 |
| 7 | 不写页面 | 通过。不改 DOM、不提交表单。上游的隐藏表单、iframe、弹窗、提示、保存全部删除。 |
| 8 | 不依赖秘密 | 通过。无硬编码账号或学号；`DEFAULT_MODE` 是课程模式 ID，不是秘密。用例中的人名都是合成的「甲老师」等。 |

## 上游删掉或改掉的东西

| 上游 | 本件 | 理由 |
|---|---|---|
| 隐藏表单 + 隐藏 iframe 提交 POST | `fetch` 直接 POST | 任务卡要求改成直接请求；取舍见「已知风险」 |
| `showSingleSelection` 选学期 | 取 `selected` 项，没有就取第一项并提醒 | 移植约定不弹窗问学年学期 |
| `showPrompt` 手填开学日 | 周历第 1 周推算开学日；取不到按学期号推算（第 1 学期 9 月 1 日所在周的周一，第 2 学期 2 月 20 日所在周的周一），并提醒 | 上游没有周历，本件加可选周历请求（照 csuft）；不许悄悄猜 |
| `showAlert` / `toast` / `saveCourseConfig` / `saveImportedCourses` / `savePresetTimeSlots` | 删除 | 脚本只读，载荷由 `parse.js` 输出 |
| `validateSemesterStartDate`、`selectFromList`、`__BTBU_FORM_TIMEOUT_MS__` | 删除 | 随弹窗与 iframe 一起删 |
| `parseWeeksAndSections` 的整串单双判断（`if (/双/.test(str)) parity = 2`） | `weeksIn` 逐段判单双 | 上游 bug：只要整串里出现「双」，整串都按双周过滤，`1-8(单),9-16(双)` 的单周全被丢掉；也不认无逗号前置 |
| `teacher || '未知教师'`、`position || '未知地点'` | 空值（null），并按课汇总提醒 | 占位词不能当成真名或真地点 |
| 上游 `teacher` 原样保留（括号备注也保留） | 去掉括号备注再判空 | 「张三（外聘）」不是教师名（本件新增，上游没有这一步） |
| `mergeAndDistinctCourses`（展开运算符、箭头函数） | 等价的 ES5 写法（csuft 的 key 规则） | CI 要求 ES5 |

保留的上游内容：`kbjcmsid` 的常量兜底、13 节节次时间、`cleanCourseName` 的编号清理顺序、「------」分隔线、编号在课名之前的兜底建课、表头定星期（`buildDayMap`，不论命中几列都照用）。

## 节次时间（逐节对照上游 `importPresetTimeSlots`）

| 节 | 上游 | 本件 `SLOT_TIMES` | 节 | 上游 | 本件 |
|---|---|---|---|---|---|
| 1 | 08:00–08:45 | 一致 | 8 | 15:30–16:15 | 一致 |
| 2 | 08:50–09:35 | 一致 | 9 | 16:20–17:05 | 一致 |
| 3 | 09:50–10:35 | 一致 | 10 | 17:10–17:55 | 一致 |
| 4 | 10:40–11:25 | 一致 | 11 | 18:45–19:30 | 一致 |
| 5 | 11:30–12:15 | 一致 | 12 | 19:35–20:20 | 一致 |
| 6 | 13:40–14:25 | 一致 | 13 | 20:25–21:10 | 一致 |
| 7 | 14:30–15:15 | 一致 | | | |

第 14 节起按 H3 顺推：第 14 节 21:15–22:00，第 15 节 22:05–22:50，第 16 节 22:55–23:40；第 17 节会超过 23:59，补不了。

## 与模板的差异（csuft）

- 周历请求与解析照 csuft（POST 带学期号，失败回落 GET），但上游北工商没有这一步，本件是新增的可选请求，取不到不影响导入。
- 与 csuft 不同：csuft 的周历取不到时用今天所在周的周一推算；本件改为学期号推算（第 1 学期 9 月 1 日、第 2 学期 2 月 20 日所在周的周一），按主调度决定。
- 只有一个教务域名（当前页的 origin），没有域名探测、没有 `MAX_REQUESTS`、没有 15 秒超时（沿用 `fetch` 默认）。
- 取数是 POST 课表，学期与课程模式来自下拉框，不是 csuft 的 `scheduleQuery` 参数串。
- 教师括号备注去掉（本件新增）。
- 提醒里统一用「节次时间」，不用「作息表」。

## 本校专属边界用例

| 用例 | 覆盖 |
|---|---|
| `basic` | 整周、单周、双周；13 节时间；无周历时开学日推算提醒；缺教室、缺教师汇总 |
| `week-forms` | `(单)1-8周(双)9-16周`（无逗号前置）→ 1–7 单周 + 10–16 双周；`1-8周(单)9-16周(双)`（后置）；`1-8周(单),10-16周(双)`（逗号后置）；`1-8,10-16`；`第1-第8周`；`1-4周共2周,6-8周` 只剥备注 |
| `row-label` | 没有方括号时用行首「1~2节」补节次；「暂无教师」「暂无教室」留空并汇总；无教室字段 |
| `long-name` | 4 门缺教师的课，课名分别 23、22 字，提醒截到 20 字并以「等」收尾；1 门周次未知的长课名（22 字）截断；整条不超过 200 字 |
| `late-week` | 课表到第 22 周，总周数抬到 22 并提醒；第 14–15 节顺推补齐并提醒；第 17–18 节超出可补范围，跳过并提醒 |
| `code-divider` | 课名前的纯编号 `080901C4S2007` 兜底（课名由后面的 font 给）；`20230101` 只有编号时以编号建课；「------」分隔两门课；隐藏副本不重复；「未知教师」「未知地点」留空 |
| `term-first` | 页面没标当前学期时取第一项并提醒；第 2 学期无周历，按 2 月 20 日所在周的周一推算为 2026-02-16 并提醒；同一门课相邻节次（1–2 与 3–4）合并成 1–4；重复行不叠；7–8 节另成一段 |
| `calendar` | 有教务周历：第 1 周星期一格是 09 月 02 日（周三），开学日对齐到所在周的周一 2026-08-31 并提醒；总周数用周历的 18 周，不再提醒 |

fixtures 共 8 对，全部是合成数据。期望值按规范与代码逻辑手工推出：7 对没有周历，开学日按学期号推算为 2026-08-31（`term-first` 为 2026-02-16）；`calendar` 一对有周历。自检 8/8 MATCH。

## 桩 / 冒烟（Chromium + Playwright，假教务站，不联网）

`D:/NullClass/.test/port-batch29/btbu/smoke.py`，17 个场景全部 OK：

- 周历成功：直连 `direct-kb`、WebVPN `webvpn-https`，POST 周历成功，开学日 2026-08-31，总周数 18。
- 周历 POST 失败、GET 成功：直连 `cal-post-fail`、WebVPN `webvpn-cal-post-fail`（`/https-443/` 前缀），第二次请求是 `GET …/jsxsd/jxzl/jxzl_query?xnxq01id=2026-2027-1`，开学日与总周数同上。
- 周历全失败：直连 `cal-all-fail`、WebVPN `webvpn-cal-all-fail`，按学期号推算 2026-08-31、总周数 20，并提醒「没取到教务的周历，开学日按 9 月 1 日所在周的周一推算为 2026-08-31」。`no-selected`（第 2 学期）推算 2026-02-16，提醒写「2 月 20 日」。

- 直连课表页：`GET https://jwgl.btbu.edu.cn/jsxsd/xskb/xskb_list.do`，然后 `POST` 同地址，表单体 `cj0701id=&zc=&demo=&xnxq01id=2026-2027-1&sfFD=1&wkbkc=1&kbjcmsid=MODE-TEST-1`。
- WebVPN `/https/777264abc1b/` 前缀：`GET`、`POST` 都是 `https://vpn.btbu.edu.cn/https/777264abc1b/jsxsd/xskb/xskb_list.do`，表单体同上。
- WebVPN `/https-443/777264abc1b/` 前缀：`GET`、`POST` 都是 `https://vpn.btbu.edu.cn/https-443/777264abc1b/jsxsd/xskb/xskb_list.do`。
- 未标当前学期：POST 的 `xnxq01id` 是列表第一项 `2025-2026-2`，并提醒。
- 门户页 `https://vpn.btbu.edu.cn/`、门户内页 `…/https/777264abc1b/`、登录页 `/jsxsd/`、`/jsxsd/index.jsp`、`/jsxsd/xk/LoginToXk`、学校主页 `https://jwgl.btbu.edu.cn/`、他站、坏前缀 `vpn.btbu.edu.cn/x/jsxsd/…`：直接报错，0 次请求。
- 空课表：两次请求，报「没有找到课程」；登录失效：两次请求，报「登录已失效」。
- 个人信息（学号、身份证号、手机号、令牌、学生姓名、教学楼、班级、备注）既不在请求里，也不在 extract 的输出里，更不在提醒里。

## 变异测试

临时副本（`C:/Users/23703/AppData/Local/Temp/btbu-port29/mut/`，已删除），原文件未改：

| 改坏 | 变红的用例 |
|---|---|
| M1：`weeksIn` 前置单双不补逗号（`return ',' + all;` → `return all;`） | `week-forms` |
| M2：H3 顺推去掉课间（`var start = prevEnd + EXTRA_GAP;` → `var start = prevEnd;`） | `late-week` |
| M3：合并只认重叠（`cur.start > prev.end + 1` → `cur.start > prev.end`） | `term-first` |
| M4：编号兜底建课被去掉（`if (!current && pendingCode) current = newItem(…)` 改为空操作） | `code-divider` |

M5：周历取不到时，第 2 学期的推算日期改错（`second ? 20 : 1` 改为 `1`）→ `term-first` 变红。

还原后自检重新 PASS（8/8）。

## 已知风险与未验证项

- **没有本校账号，真机没验过。** 假站的 HTML 结构按上游 `btbu.js` 的注释（`samples/xskb_list.html` 的校准描述）复刻，不等于真实页面。
- **【已接受，主调度决定】WebVPN 下 fetch POST 可能被改写。** 上游注释称 wengine 会 hook `window.fetch` 并破坏 POST，所以上游用了 iframe。本件接受直接 `fetch` POST 的处理：失败时给大白话提示（「没有找到课表」或「连不上教务系统」），不静默丢课。
- **取数方式的取舍（fetch POST 代替 iframe）。** 上游注释称，WebVPN 的 wengine 会 hook `window.fetch` 并破坏 POST，所以上游用了 iframe。本件直接 `fetch` POST。若真实 WebVPN 环境下 POST 被破坏，表现是「没有找到课表」或「连不上教务系统」，会提示，不会静默丢课，但导入会失败。需要真机验证。
- **周历取不到时开学日是推算的。** 按学期号推算（第 1 学期 9 月 1 日所在周的周一，第 2 学期 2 月 20 日所在周的周一，第 3 学期即夏季小学期 7 月 1 日所在周的周一、取学年的后一年）。这和学校真实开学日可能不同，提醒里已写明「请在学期管理里核对」。第 3 学期一条是主调度复核时补的（原先按 9 月 1 日推，会推到前一年 9 月）：新增 `term-summer`（2025-2026-3 → 2026-06-29，期望手推），改回旧规则 → 该用例变红。
- **总周数**：有周历用周历的周数；取不到按 20 周，课表里出现更晚的周次时抬高并提醒。
- **节次 14 节以后是顺推的，不是学校真实时间。** 已提醒。
- **教师括号备注去掉**是本件新增的规则，上游没有这一步。
- **`allowHosts` 只列了 `vpn.btbu.edu.cn`。** 直连靠 `loginUrl` 同源放行（规范 §3.3）。

## 行号引用

本文只按函数名与常量名引用代码，不写行号，避免改动后漂移。

签名：0x7E7-2023（haiku 移植，2026-11-03）

- **复审修正（主调度，2026-11-03，安全）**：字段白名单 `KEEP_TITLE` 只看标题里有没有「课程 / 教师 / 周次 / 教室」，`title="课程二维码"` 会因「课程」误命中而原样交出去，可能带出学号。extract.js 新增黑名单 `DROP_TITLE`（二维码、学号、姓名、班级、备注、身份证、手机），命中即不交；parse.js 的课名分支也排除「二维码」，作为第二道防线（真实数据里 extract 已不交，不另钉 fixture）。冒烟每张假卡片都加了「课程二维码」字段，其文字列入个人信息清单；去掉黑名单 → 7 个场景报二维码外泄，恢复后 17/17 OK。
