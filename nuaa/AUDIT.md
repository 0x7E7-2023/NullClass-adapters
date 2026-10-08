# 安全审计 —— 南京航空航天大学（树维 EAMS 平台）

审计对象：`jw-adapters/nuaa/` 下的 `extract.js`、`parse.js`，以及它们移植自的上游脚本 `shiguang_warehouse` 的 `NUAA/nuaa_01.js`（MIT，上游 maintainer `kemi-20`，快照 `ff72d1f08782df965cae110034a9d87cd91e0c07`，2026-10-08）。

- 移植者：`0x7E7-2023`
- 移植日期：2026-10-08（第六批 #2，树维 EAMS 族）
- 适配器 key：`nuaa`；名称：南京航空航天大学；首字母 `N`；version `1.0.0`；minAppVersionCode `11`
- 主页：`https://github.com/XingHeYuZhuan/shiguang_warehouse`
- loginUrl：`https://aao-eas.nuaa.edu.cn/eams/login.action`
- scheduleUrlHint：`https://aao-eas.nuaa.edu.cn/eams/courseTableForStd.action`
- 模板：「模板件」（同族，树维 EAMS）。与模板件的对照见 §4.1 与 §5。

审计方式：

- 上游对照依据 `.test/port-batch5/diffs/nuaa.diff`。这个文件只含改动段落及其上下文，不是上游全文。文件头写明「--- 模板件的上游」「+++ 本校上游 NUAA/nuaa_01.js」，所以以 `-` 开头的行是模板件上游，以 `+` 开头的行是 NUAA 上游，无前缀的行是两边相同的上下文。本文引用的 diff 行号都指这个文件的行号。
- 上游全文已读（团队复核第 9 条，2026-10-08，只读，未在该目录运行任何程序）。`request()`、教师取值、学期日历字段的逐条核对结果见 §4.3 与 §8 第 0 条。写「全文第 N 行」的指 `nuaa_01.js` 本身；写「diff 第 N 行」的指 `nuaa.diff`。
- 静态扫描（本轮重跑）：`extract.js` 与 `parse.js` 的代码里 `fetch(` 只出现在 `extract.js` 的 `request()` 中；没有 `password`、`pwd`、`cookie`、`localStorage`、`sessionStorage`、`sendBeacon`、`WebSocket`、`EventSource`、`new Image`；代码中没有 `eval`、`new Function`、`Function(`（注释里提到的不计）；代码中没有绝对 URL（注释里的 github 地址不计）；`parse.js` 只读 `__ncInput`。

---

## 1. 请求域与请求清单（必须与代码一致）

三条请求都是**同源**请求，地址由当前页面的 origin 加上上下文路径拼成（`eamsBase()`，`extract.js` 第 43–48 行）：

- `<origin>`：`window.location.origin`；没有 origin 时用 protocol 加 host 拼。
- `<前缀>`：`window.location.pathname` 里 `/eams` 之前的那一段，**含 `/eams` 本身**。地址里没有 `/eams/` 时直接拼成 `/eams`。
- 请求主机只有一个，就是用户正在用的教务主机。代码里没有写死主机名，`allowHosts` 为空数组。

| 谁 | 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js | GET | `<origin><前缀>/courseTableForStd.action?sf_request_type=ajax` | 读课表页 HTML，取学号 `ids`（正则 `bg\.form\.addInput\(form,\s*"ids",\s*"(\d+)"\)`，与上游一致，允许其间有空白，diff 第 213 行 `+` 侧）、学期组件 id（`id="(semesterBar\d+Semester)"`）、页面当前学期（`semesterCalendar_target` 的 value，其次 `semesterCalendar({…value:"数字"`） | 报「没能从课表页读到学号和学期，……」，后面两条请求都不发 |
| extract.js | POST | `<origin><前缀>/dataQuery.action?sf_request_type=ajax`，body 为 `tagId=<学期组件 id>&dataType=semesterCalendar` | 取学期日历原文（JS 对象字面量，只做字面量扫描，不求值） | 经 `request()` 统一处理：HTTP 非 2xx 报「登录状态可能已失效」，网络失败报「连不上教务系统」，响应超过 4000000 字符报错。日历列表为空时：页面有学期 id 就只用这个 id（学期名与日期留空，parse 写 warning）；两者都没有则报「没能确定要导入哪个学期」 |
| extract.js | POST | `<origin><前缀>/courseTableForStd!courseTable.action?sf_request_type=ajax`，body 为 `ignoreHead=1&setting.kind=std&semester.id=<所选学期 id>&ids=<学号>` | 取课表 HTML 全文 | 同上（`request()` 统一处理，含 4000000 字符上限） |

补充：

- 请求头：`credentials: 'include'`（让浏览器带上用户自己的登录态，脚本不读 cookie）；`Content-Type: application/x-www-form-urlencoded; charset=UTF-8`（GET 也带，代码不区分）；`X-Requested-With: XMLHttpRequest`；`Accept: */*`（`extract.js` 第 71–75 行）。与上游对照（全文第 182–186 行的 `request()`，第 212、243 行的两条 POST）：上游只设 `credentials` 与调用方给的 `headers`，POST 只带 `Content-Type`；本件另加 `X-Requested-With` 与 `Accept`，与模板件的 `extract.js` 第 83–84 行相同，是相对上游的偏离（§4.3 第 16 条）。
- 4000000 字符上限在 `request()` 里对三条请求都生效（`extract.js` 第 33 行、第 92–97 行）。
- 请求体：学期组件 id、所选学期 id、学号都经 `encodeURIComponent`（`extract.js` 第 380、390–391 行）。上游 `getSelectedSemester`（全文第 213 行）同样编码 `tagId`；`fetchAndParseCourses`（全文第 244 行）不编码 `semester.id` 与 `ids`。两者都是纯数字，编码前后字节相同。
- 页面侧只读这些东西：`document.readyState`；`DOMContentLoaded` 监听与最长 8 秒的定时器（等页面就绪）；`document.documentElement.innerHTML`，只为在 try 里找页面上的 `unitCount` 数字，**只把这个数字交出去**；`window.location` 的 origin、protocol、host、pathname；本机时钟（今天的日期）。
- 交给 parse.js 的原始数据是 `{ today, semester, unitCountPage, semesterCalendar（学期日历原文）, courseTable（课表 HTML 全文） }`，序列化成 JSON 字符串输出。`semester` 只含 `id`、`rawName`、`schoolYear`、`startDate`、`endDate` 与 `source`（记录它是怎么选出来的）。学号 `ids` 不进这个对象。
- 学期选择顺序（`chooseSemester`，`extract.js` 第 303–335 行）：① 页面学期组件的 id，且它在学期列表里 → ② 学期日历标出的当前学期 → ③ 起止日期包含今天的那一个 → ④ 起始日期最晚的那一个 → ⑤ 列表最后一项 → ⑥ 列表为空、页面上有学期 id：只用这个 id，`source` 记为 `page`，学期名与日期留空（parse 写 warning）→ ⑦ 以上都没有：报错。上游的 `showSingleSelection` 弹窗没有移植（§4.3 第 3 条）。

---

## 2. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。两个脚本不读 `password`、`pwd` 或登录表单的值，不碰 cookie、`localStorage`、`sessionStorage`（静态扫描无匹配）。上游的学期弹窗没有移植，不向用户提问（§4.3 第 3 条） |
| 2 | 不外发 | **过**。`fetch` 只有 `extract.js` 里 `request()` 的一处；三条请求都经过它，地址全部由 origin 加 `/eams` 拼成。没有 `sendBeacon`、`WebSocket`、`EventSource`、`new Image`、隐藏表单，也没有第三方域 |
| 3 | 请求域可控 | **过**。请求主机只有用户当前页面的 origin，正常即 `aao-eas.nuaa.edu.cn`，与 `loginUrl` 同主机。`allowHosts` 为空数组。上游的 `const BASE` 绝对地址没有保留（§4.3 第 1 条） |
| 4 | 只读课表 | **团队接受，不改代码**（见 §8 第 2 条）。三条请求是课表查询链：课表页入口、学期日历、课表 HTML。不碰成绩、学籍、个人信息、缴费接口。学号只放进第三条请求的 body，不进输出的 JSON 字段。`courseTable` 与 `semesterCalendar` 的**原文整体**随 JSON 交给 parse.js，与模板件一致；其中是否夹带学生个人信息未核实。手册 §5 第 4 条字面上要求这类信息不带出 extract.js，团队确认接受现状，并在本件写明 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，没有图片打点 |
| 6 | 不 eval 远程内容 | **过**。代码中没有 `eval`、`new Function`、`Function(`。上游全文第 215 行（diff 第 232 行）对网络响应求值（`Function(...)()`），本件改为字面量扫描（`splitTop`、`outerOf`、`objectOf`、`arrayOf`、`literalOf`），只按顶层逗号与冒号切分，感知括号深度与引号，只取值，不执行（§4.3 第 2 条） |
| 7 | 不写页面 | **过**。只读 `document.readyState` 与 `innerHTML`，没有点击、提交、写 DOM。上游的四类桥调用全部没有移植（§4.3 第 15 条）；`parse.js` 只输出 JSON，由宿主决定如何保存 |
| 8 | 不硬编码秘密或他人学号 | **过**。没有密钥、令牌、学号字面量。脚本常量只有 `/eams`、4000000 的响应长度上限、两张作息表与节次映射。学号是运行时从已登录的课表页读的。fixture 里的 `ids` 值（`20260001`）是合成的 |

**结论：七条过；第 4 条经团队确认接受，不改代码，理由与残余风险见 §8 第 2 条。**

---

## 3. 本批 12 条检查表逐条

| # | 检查项 | 本件结论 |
|---|---|---|
| 1 | 周次位图的下标基准 | **过，有用例**。统一口径：第 i 位为 1 且 i ≥ 1 → 第 i 周。第 0 位为 1 不产出第 0 周，计数并 warn（`parse.js` 第 225–228 行）。第 31 位及以后丢弃并计数（超过 30 周）。上游的位图循环从下标 0 起 push（diff 第 155–156 行，两边相同的上下文），会把第 0 周送进载荷；本件按任务卡不这样做（§4.3 第 8 条）。用例 `weeks-bitmap`：位图甲只有第 0 位（整条不导入，计空位图）；位图乙第 0、1 位（得第 1 周）；位图丙只有第 1 位（得 1–1）；位图丁（期望 2–16 ALL）；位图戊（期望 1–3 ODD）；位图己（期望 2–4 EVEN）。变异见 §7 的 M1 |
| 2 | `TaskActivity` 的参数位 | **过，有用例**。`args[3]` 课名：字面量 trim 后取用，不切括号；表达式则取出其中所有字符串字面量依次拼接，计 `exprNameHits` 并 warn（§4.3 第 20 条）。`args[6]` 教室：去掉括号及括号内内容，再 trim（`parse.js` 第 207–209 行）；天目湖判断用去括号之前的原文（`parse.js` 第 316 行，上游 diff 第 151 行同款）。`args[7]` 位图（diff 第 152 行）。教师：同一块里 `actTeachers` 的第一个 `name` 优先；取不到时，`args[1]` 为字符串字面量则用它（照模板件，`parse.js` 第 309 行，`teacherOfArg` 第 198–204 行）；`args[1]` 为表达式（如 `teachers.join(',')`）则教师留 null，计 `exprTeacherHits` 并单独 warn；两者都没有的计 `noTeacherHits` 并 warn（§4.3 第 21 条）。课名为空的活动跳过，计 `noNameHits` 并 warn（无用例）。用例：`fallback` 的「数据结构」（无 actTeachers，`args[1]` 字面量「王老师」回落为教师）与「形势」（`args[1]` 为表达式，教师 null）；`edge-units` 的「英语听力」（无 actTeachers，教师 null）；`campus-tianmuhu` 的「材料力学」（教室「天目湖校区教3-205(东)」→「天目湖校区教3-205」）；`course-name` 的「  离散数学  」（两端空白去掉） |
| 3 | 两种 `index` 写法 | **过，有用例**。写法一：`index = 星期 * unitCount + 单元`，两个数都从 0 起，各 +1（`parse.js` 第 322–326 行）。写法二：已算好的 `index = N`，用 `unitCount` 换算：星期 = 取整 + 1，单元 = 取余 + 1（第 331–337 行）。换算不用 eval。换算后星期不在 1–7、或单元映射不出节次的，丢弃并计 `strayIndexes`；写法二的个数计 `bareIndexes` 并 warn。上游与模板件上游都只认写法一（上游全文第 160 行 `idxRegex`，diff 第 163 行）；模板件另有裸数字换算，但读不到 unitCount 时跳过，见 §4.3 第 18 条。用例 `edge-units`：裸数字 27 换算为周三第 2 节；裸数字 100 换算为星期 8，丢弃并计 stray |
| 4 | `unitCount` 要真的读 | **过，有用例**。优先级：① 课表响应里的 `unitCount = N`（N 在 1–60 之间才有效）→ ② extract 读到的页面值（同样 1–60，`parse.js` 第 474–476 行）→ ③ 缺省 13，并 warn（第 733–735 行，`unitCountUnread`）。课表里的 `unitCount` 由 `readUnitCount` 读（第 253–259 行）。上游（全文第 157–158 行）只读课表响应、缺省 13、不限范围、没有页面回落；本件多的两步是增补。缺省值 13 是任务卡要求的（批次文档第 81 行）。用例 `edge-units`：课表与页面都没有 unitCount，warn 即此条；其余用例的课表里有 `var unitCount = 13;` |
| 5 | 作息时间从哪来 | **过，有用例**。脚本内置两张 11 节表：`TIANMUHU_TIMES`（`parse.js` 第 50–54 行）与 `OTHER_TIMES`（第 55–59 行），来源是 NUAA 上游 `getTimeSlots`（diff 第 283–293 行，共 22 组）。已用脚本比对：diff 的 44 个 HH:mm 与 `parse.js` 第 50–59 行的 44 个 HH:mm 顺序完全一致。整学期只用一张：有任一门课的教室含「天目湖」→ 天目湖表，否则 → 明故宫/将军路表（§4.2；计数在第 486–492 行，选表在第 651–652 行）。节次映射：单元 1–4 → 第 1–4 节；单元 5、6 丢弃并逐门点名进 warnings（第 276–277 行）；单元 7–13 → 第 5–11 节（减 2）。用例：`section-map`（单元 1–13 的映射与午间丢弃）、`campus-tianmuhu`（天目湖表）、`campus-other`（明故宫/将军路表）、`campus-mixed`（混排）。校验：`check.js` 第 114 行的 TIME 正则覆盖 00:00–23:59（小时 0–23、分钟 00–59），第 145–146 行对每个 periodTimes 的 start、end 校验。本件最大节次为 11，与作息表等长，不会出现节次超出作息表的情形 |
| 6 | 开学日 | **过，有用例（教务路径）**。优先取选中学期 `startDate` 所在周的周一，warning 写明「教务给的学期起始日期（……）所在周的周一」（起始日期取值在 `parse.js` 第 602–625 行，warning 在第 691–698 行）。拿不到起始日期时，按学期锚点推算（第一学期 9 月 1 日、第二学期 2 月 20 日所在周的周一），warning 写明「推算」。13 对 fixture 里，12 对选中的学期有起止日期（11 对为 454，`fallback` 为 455），走教务路径；`term-start-second` 没有起止日期，走推算路径（第二学期 2 月 20 日，见 §6）。第一学期的推算路径无用例（§8 第 6 条） |
| 7 | 周次上限 | **过，部分有用例**。`totalWeeks` 先取学期起止日期的周数（`parse.js` 第 629–637 行）；拿不到则用 `FALLBACK_TOTAL_WEEKS` = 20 并 warn；课表里有更晚的周次则顶高并 warn（第 640–643 行，第 703–707 行）；超过 30 的截到 30 并 warn（第 644–647 行，第 710 行）。位图第 31 位及以后丢弃并计数。用例覆盖第一步（教务起止日期推出的周数，12 对 fixture 都是 19 周）与缺省分支（`term-start-second` 没有起止日期，取缺省 20 周）；顶高、截到 30、位图超过 30 位都没有用例（§8 第 6 条） |
| 8 | `teacher` / `location` 拿不到就留空 | **过，有用例**。教师取不到为 null；教室去掉括号后为空为 null；课名取不到的活动跳过。不写「未知教师」「未知地点」「未知课程」这类占位词（§4.3 第 10–12 条）。用例：`edge-units`（「英语听力」教师 null；「体育」教室为空 → null）；`campus-other`（「体育」教室为空 → null） |
| 9 | 学期名 | **过，有用例**。学期名用教务自己的「学年 + 第几学期」拼，分三步。① `rawName` 含「学期」：以四位年份开头（如「2026-2027学年第一学期」）时原样用；不以年份开头（如「第一学期」）且有学年时，补成「<学年>学年」加它。② 否则 `rawName` 为 1–4（用 `hasOwn` 查表，原型属性名不算）且有学年时，得「<学年>学年第X学期」（如 2026-2027 加 1 → 「2026-2027学年第一学期」）。③ 其余情形（`rawName` 为空、为 5、为「春」、为「constructor」这类，或没有学年）得空，改用兜底名「南京航空航天大学 <学年>学年第X学期」；序号认不出时写「南京航空航天大学 <学年>学年（学期未知）」。学年缺失时按今天的日期推算（如 2026 年 10 月推为「2026-2027」）。学期对象缺失时同样走兜底。这三步在 `termNameOf`（`parse.js` 第 569–580 行）与 `fallbackNameOf`（第 584–596 行）里。兜底名出现时写 warning「教务没有给出可识别的学期名，已按「……」导入，请在学期管理里核对」（`parse.js` 第 687–689 行，§8 第 11 条）。用例：`term-name-kind`（「第一学期」+ 2026-2027 → 「2026-2027学年第一学期」，不出提醒）；`term-name-unknown`（「5」→ 兜底名「南京航空航天大学 2026-2027学年（学期未知）」+ 提醒）；`term-name-proto`（「constructor」→ 同一兜底名 + 提醒，不拼出函数源码）；`fallback`（`rawName` 为空 → 同一兜底名 + 提醒）；`term-start-second`（`rawName` 为「第二学期」、学年 2026-2027 → 「2026-2027学年第二学期」，不出提醒；开学日推算见第 6 条）。学年缺失时按今天推算学年的路径无用例（§8 第 6 条）。`rawName` 为「第5学期」这类序号在 1–4 之外的，按第 ① 步原样补学年前缀，不走兜底（§8 第 8 条） |
| 10 | `allowHosts` | **过**。`allowHosts: []`。`extract.js` 的代码里没有绝对 URL，三条请求都以 `window.location.origin` 为前缀，不需要放行额外主机。`check.js` 第 102–108 行要求代码里出现的绝对 URL 主机必须与 loginUrl 同主机或在 allowHosts 中，本件满足。`parse.js` 只读 `__ncInput`，`check.js` 禁止 `__ncSelect`、`__ncPrompt`、`__ncConfirm`、`__ncOcr` 等名字，本件不使用 OCR 与提问桥 |
| 11 | `warnings` 上限 | **过，部分有用例**。所有 warning 经 `warn()` 收口（`parse.js` 第 124–128 行）：单条超过 200 字符时截到 199 字加「…」。超过 20 条时保留前 19 条，末尾加一条「另有 N 条说明因为超出上限没有显示，请把这份课表反馈给我们」（第 770–775 行）。最多的 fixture 是 8 条，上限分支与截断分支没有用例（§8 第 6 条） |
| 12 | 每件都要做变异测试 | **已做，见 §7** |

### 3.1 专项检查表（第五批第 1–6 条，第六批 NUAA 适用性）

1. **上下文路径**（第五批第 1 条，针对 `/jwglxt` 与根路径两种正方部署）：**部分适用**。正方的两种部署形态与树维 EAMS 无关，EAMS 只有 `/eams` 这一个上下文路径。跟随网关前缀的规则适用：`eamsBase()` 取当前地址里 `/eams` 之前的那一段（§1）。
2. **菜单号与请求体**（第五批第 2 条，针对 sdnu 的 `N253508` 与 `kclxdm`）：**不适用于本件的三条请求**。这三条请求没有菜单号参数。请求体字段名 `tagId`、`dataType`、`ignoreHead`、`setting.kind`、`semester.id`、`ids` 与上游 diff 中两边相同的行一致。
3. **作息表逐节核对**（第五批第 3 条）：**适用**。两张表与 NUAA 上游 `getTimeSlots` 逐组一致（§3 第 5 条的脚本比对）。最大节次 11 与作息表等长，不存在「课表节次超出作息表」的情形，因此没有对应的超出用例。
4. **跨域登录**（第五批第 4 条）：**未验证**。任务卡写明 `loginUrl` 与课表页同在 `aao-eas.nuaa.edu.cn`；但 NUAA 的登录是否经过 CAS 等跨主机页面，没有证据（§8 第 3 条）。本件不识别登录页，登录态由用户在 WebView 里保持。
5. **模板残留**（第五批第 5 条）：**适用**。本轮 grep 结果：另一所学校的校名与域名（旧件残留的检查词）在 `extract.js`、`parse.js`、`manifest.json` 中无匹配（本文件引用这组词的句子不计）。「模板件」的校名与缩写只出现在有意的对照里：本文件 §3.1 本条、§4.1、§4.3、§5；`parse.js` 头注释第 ④、⑥ 条（第 19、21 行）与 `teacherOfArg` 旁的注释（第 195 行）。代码文件中没有其它残留。
6. **其余沿用**（第五批第 6 条）：**适用**。
   - 周次四写法：§3 第 1、3 条。
   - 括号与序号：课名不切括号、不去序号（§3 第 2 条）。
   - warnings 上限：§3 第 11 条。
   - `HH:mm` 合法性与先后顺序：`check.js` 的 TIME 正则与 `validatePayload` 校验，13 对 fixture 均通过。
   - 学期名：§3 第 9 条。
   - `teacher` 留空：§3 第 8 条。
   - `AUDIT.md` 与代码一致：`check.js` 不校验 AUDIT 内容，本条由人工逐条对照完成（本轮逐条核对了行号）。
   - 期望值独立推出 + 变异测试：§6、§7。
   - ES5（注释也算）、控制字节：`check.js` 全文扫描。

---

## 4. 与模板的差异，与上游的差异

### 4.1 与模板件（同族）的差异

模板件的各行均已对照模板件目录的源码核实（行号指模板件目录下的文件）。

| 项 | 模板件 | 本件 nuaa | 理由 |
|---|---|---|---|
| 教室括号 | 保留括号内容，只剥成对引号（模板件的 `parse.js` 第 331–333 行） | 去掉括号及括号内内容，再 trim | 任务卡要求；NUAA 上游 diff 第 150 行同样去掉 |
| 课程名括号与序号 | 只摘整段括号里全是数字的末尾序号（如「大学物理(2)」），其它括号保留（模板件的 `parse.js` 第 240–256 行） | 不切括号，不去序号 | 任务卡要求。模板件上游用 `split('(')[0]`（diff 第 144 行，`-` 侧），会切掉「(一)」之类；NUAA 上游只 trim（diff 第 148 行，`+` 侧） |
| `unitCount` 缺省 | 14 | 13 | 任务卡要求（批次文档第 81 行） |
| 裸数字 `index = N` | 读到 unitCount 时换算；读不到时跳过并计数（模板件的 `parse.js` 第 348–358 行） | 读不到 unitCount 时按缺省 13 换算并 warn；换算越界的丢弃并计数 | 任务卡要求两种写法都支持。读不到时的处理与模板不同，属有意偏离（§4.3 第 18 条） |
| 作息表 | 一张 11 节表（`SCHOOL_PERIOD_TIMES`，第 62–72 行），另有一张 12 节的 `BUILTIN_PERIOD_TIMES`（第 77–88 行），课表用到第 12 节时补时间 | 两张 11 节表，整学期选一张；没有 12 节表（本件最大节次为 11） | NUAA 上游 `getTimeSlots` 按校区分两张（diff 第 283 行起）；模板件上游的 `applyTimeSlots` 只有一张（diff 第 269 行，`-` 侧） |
| 节次映射 | 单元与节次一一对应，`+1`（模板件上游 diff 第 167 行，`-` 侧）；移植件同样一一对应 | 单元 1–4、7–13 映射（7–13 减 2）；5、6 丢弃并点名 | 任务卡要求；NUAA 上游 `mapSection`（diff 第 127–133 行，调用在第 170–171 行） |
| 教师来源 | `actTeachers` 的 name 优先（模板件的 `parse.js` 第 321 行）；取不到时 `args[1]` 为字面量才回落（第 328 行） | `actTeachers` 的 name 优先（`parse.js` 第 302 行）；取不到时 `args[1]` 为字符串字面量就用它，为表达式则留空并计数提醒（第 309 行，`teacherOfArg` 第 198–204 行） | 照模板件 的回落规则（§4.3 第 21 条）。NUAA 上游全文第 138–139 行只认 `actTeachers`，取不到写「未知教师」，没有 `args[1]` 回落（§4.3 第 12 条） |
| 学期默认顺序 | `cal.currentId` 优先，没有则用页面 id（模板件的 `extract.js` 第 313 行）；其次起止日期包含今天；再其次起始最晚；最后列表末项；列表为空时用页面 id 兜底（第 311–336 行） | 页面学期组件 id（须在列表里）优先；然后 currentId、日期包含、起始最晚、列表末项；列表为空时用页面 id 兜底（`extract.js` 第 303–335 行） | 任务卡要求以页面为默认；NUAA 上游也以页面学期为默认（diff 第 244–247 行，`+` 侧） |
| `TaskActivity` 参数位 | `args[5]` 教室（模板件的 `parse.js` 第 333 行）、`args[6]` 位图 | `args[6]` 教室、`args[7]` 位图 | NUAA 上游（diff 第 149、152 行） |
| 周次上限 | 位图超过 30 位丢弃并计数（模板件的 `parse.js` 第 277 行，warn 第 771 行）；课表更晚的周次顶高并 warn（第 651–653 行，warn 第 721–723 行）；超过 30 截到 30 并 warn（第 655–657 行，warn 第 728 行）。学期日历周数超过 30 时，第 645 行直接截到 30，之后不记录截断 | 同左；本件的截断经 `clampedWeeks` 带 warn（`parse.js` 第 639–647 行，§3 第 7 条） | 与模板一致；第 645 行的静默截断只在模板中存在，本件没有（§5） |

### 4.2 两校区混排（同一学期里既有天目湖课，又有其它校区或教室为空的课）

- **上游**：`campus` 字段只在教室含「天目湖」时设为 `"天目湖"`，其余为空串（diff 第 151 行）。`detectCampusFromCourses` 取第一门 `campus` 为真的课（diff 第 305–306 行），因此只会命中天目湖课；没有则用「其他校区」（第 310 行）。
- **结论**：上游与本件的作息选择结果相同。只要有一门天目湖课，整学期用天目湖表；否则用其它表。
- **本件增补**：混排时额外写一条 warning，写明天目湖安排数与其它安排数（教室为空的算其它）（`parse.js` 第 726–731 行）。上游没有这条提醒。
- **风险**：一学期只用一张作息表，其它校区课程的节次时间可能不准。warning 已写明「请核对」（§8 第 5 条）。

### 4.3 与 NUAA 上游的差异（逐条，附 diff 行号与理由）

1. `const BASE = "https://aao-eas.nuaa.edu.cn/eams"`（diff 第 10 行，`+` 侧）写死 → origin 加上下文路径（§1）。理由：不写死主机，只放行当前主机。
2. 学期日历用 `Function(...)()` 求值（全文第 215 行；diff 第 232 行，两边相同）→ 字面量扫描（§2 第 6 条）。理由：手册 §5 第 6 条；响应体来自网络，不能求值。
3. 学期选择弹窗：模板件上游 `showSingleSelection`（diff 第 249 行，`-` 侧，默认项为 0）；NUAA 上游的弹窗（diff 第 251–255 行，`+` 侧；全文第 232–236 行；默认项为页面学期）→ 不弹窗，按 §1 的顺序自动选。理由：任务卡要求；不向用户提问。
4. 学期显示名：模板件上游（diff 第 235 行，`-` 侧）与 NUAA 上游（diff 第 238 行，`+` 侧）都是 `${s.schoolYear} ${s.name}学期`，即「2026-2027 1学期」→ 本件用「2026-2027学年第一学期」（`termNameOf` 与 `fallbackNameOf`，`parse.js` 第 569–596 行）。理由：任务卡要求学期名用教务给的；与模板件的写法一致。学期 id 不变，只改显示名。
5. 学期列表为空：NUAA 上游 `throw new Error("未解析到学期列表……")`（全文第 223 行；diff 第 241 行，`+` 侧）→ 页面上有学期 id 时继续，只用这个 id，学期名与日期留空，warn；两者都没有才报错。理由：页面学期 id 仍能发出课表请求。代价见 §8 第 9 条。
6. 默认学期：NUAA 上游 `defaultIndex`（全文第 226–229 行；diff 第 244–247 行，`+` 侧）找到页面学期就用它，找不到取列表第 0 项 → 找不到页面学期时依次按当前学期、起止日期包含今天、起始日期最晚、列表最后一项。理由：任务卡要求；列表第 0 项不一定是当前学期。
7. 节次映射：NUAA 上游 `mapSection`（diff 第 127–133 行，`+` 侧，调用在第 170–171 行）对单元 5、6 返回 null 后直接跳过、不记录；模板件上游是一一对应（diff 第 167 行，`-` 侧）→ 本件同样丢弃，并逐门点名进 warnings（丢弃逻辑在 `parse.js` 第 276–277 行，警告在第 754 行）。理由：任务卡要求。这是增补：上游静默丢弃，本件说明。
8. 位图第 0 位：上游循环从下标 0 起（全文第 153–154 行；diff 第 155–156 行，两边相同）→ 第 0 位只计数并 warn，不产出第 0 周（`parse.js` 第 223–228 行）。理由：任务卡要求；载荷校验要求 `startWeek ≥ 1`。
9. 周次矩阵：上游 `Array.from({ length: 50 })` 与 `w < 50`（diff 第 50、58 行，两边相同）→ 以 30 周为上限，超过的位丢弃并计数。理由：载荷校验要求 `totalWeeks ≤ 30`。
10. 课名：上游 `(args[3] || "未知课程").trim()`（全文第 146 行；diff 第 148 行，`+` 侧）→ 课名为空时跳过该活动，计数并 warn，不写「未知课程」。理由：批次四检查表第 8 条（`docs/impl/2026-09-16-port-adapters-batch4.md` 第 212–213 行）：拿不到留空，不写占位词。
11. 教室：上游 `….trim() || "未知地点"`（全文第 148 行；diff 第 150 行，`+` 侧）→ 去括号后为空则为 null，不写「未知地点」。理由：同第 10 条。
12. 教师：上游全文第 138 行写 `let teacherName = "未知教师";`（diff 摘录里没有这一行，全文核实后确认）；第 139 行只认 `actTeachers` 的 name，没有 `args[1]` 回落。→ 本件教师为 null，不写占位词。理由：批次四检查表第 8 条（`docs/impl/2026-09-16-port-adapters-batch4.md` 第 212–213 行）：拿不到留空，不写占位词，「未知教师」会被当成真姓名。
13. `campus` 字段（diff 第 47、52–53、111、151、183 行）与校区判断（diff 第 305–311 行）→ §4.2 的混排规则。本件的校区统计在 `parse.js` 第 486–492 行，选表在第 651–652 行；`campus` 只在 `parse.js` 内部用，输出 JSON 没有这个字段。
14. `courses.map(({ campus, ...rest }) => rest)`（diff 第 344 行，`+` 侧）→ 本件输出里没有 `campus`（同第 13 条）。
15. 四类桥调用：`showToast`（diff 第 312、318、322、330、334、339、351 行；其中 318、334、351 为两边相同的上下文）、`savePresetTimeSlots`（第 313 行）、`saveImportedCourses`（第 345 行）、`notifyTaskCompletion`（第 352 行）→ 全部不移植。理由：手册 §5 第 7 条；`parse.js` 只输出 JSON，由宿主决定如何保存。
16. 请求头：上游全文第 212 行（学期日历 POST）与第 243 行（课表 POST）的 `headers` 都只写了 `Content-Type`；`request()`（全文第 182–186 行）只加 `credentials: "include"`。本件另加 `X-Requested-With` 与 `Accept`（`extract.js` 第 71–75 行），与模板件的 `extract.js` 第 83–84 行相同。理由：与模板相同；是否必需未在真实账号上验证。
17. 响应长度上限 4000000 字符，超过则报错（本件增补，上游没有）（`extract.js` 第 33 行、第 92–97 行）。理由：不交出被截断的数据。
18. 裸数字 `index = N`：上游与模板件上游都只认两段式（diff 第 163 行的正则）。本件支持（`parse.js` 第 331–337 行），按 unitCount 换算。模板件的 `parse.js` 第 348–358 行也支持，但读不到 unitCount 时跳过；本件读不到时按缺省 13 换算并 warn。理由：任务卡要求两种写法都支持。
19. 两段式 `index` 正则允许 `;` 前有空白（`parse.js` 第 322、331 行的 `\s*;`），比上游（diff 第 163 行，`(\d+);`）宽松。理由：任务卡没有要求，是本件自行放宽，用来容忍数据里的空白。真实数据若从不带空白，可改回上游写法。
20. 表达式课名：上游的 `powerSplit`（diff 中两边相同）把参数清洗成去引号的文字，表达式会原样保留（如 `courseName + （实验）`）；本件取表达式中的字符串字面量拼接（`nameOfArg`，`parse.js` 第 183–193 行），如得到「（实验）」，并 warn。两种结果都不是真实课名，没有 fixture 覆盖（§8 第 10 条）。
21. 教师回落（团队第 3 条）：上游 `args[1]` 不作教师来源。本件照模板件 的回落规则（模板件的 `parse.js` 第 321 行取 actTeachers，第 328 行取 `args[1]` 字面量）：`args[1]` 为字符串字面量则用它作教师；为表达式（如 `teachers.join(",")`）则教师为 null，计 `exprTeacherHits` 并单独 warn（`parse.js` 第 309 行、第 762–764 行；`teacherOfArg` 第 198–204 行）。理由：任务卡要求；表达式取不到人名，不能照抄。用例：`fallback`（字面量回落与表达式留空各一条）。

### 4.4 头注释里的编号（移植改动的依据）

`extract.js` 头注释 ①–⑦：① ES6 改 ES5（then 链，不用模板串与箭头函数）；② 三条请求地址不写死，按 origin 加前缀拼；③ 不弹学期选择，默认学期取页面值；④ 学期日历用字面量扫描，不求值；⑤ 只交出原始数据，不解析课程；⑥ 桥调用不移植；⑦ 学号只用于课表请求，课表 HTML 是否夹带个人信息未核实（§8 第 2 条）。

`parse.js` 头注释分两组编号。**上游骨架 ①–④**（第 9–12 行，照搬的结构）：① powerSplit 切参数；② 按 `var teachers =` 分块，教师取 actTeachers；③ `index = 星期 * unitCount + 单元`；④ mergeContinuousLessons 合并。**移植改动 ①–⑬**（第 14–33 行，与上表的对应关系）：① ES6 改 ES5；② 参数位次 args[3]、args[6]、args[7]；③ 节次映射（§4.3 第 7 条）；④ 课程名不切括号、不去序号（§4.1）；⑤ 教室去括号（§4.3 第 11 条）；⑥ 教师：actTeachers 优先，取不到时 `args[1]` 字面量回落，表达式留空（§4.1，§4.3 第 21 条）；⑦ 位图第 0 位占位（§4.3 第 8 条）；⑧ 两种 index 写法（§3 第 3 条，§4.3 第 18 条）；⑨ unitCount 三级回落（§3 第 4 条）；⑩ 整学期一张作息表与混排提醒（§4.2）；⑪ 不用 eval（§2 第 6 条）；⑫ 开学日（§3 第 6 条）；⑬ 上游的选学期弹窗与桥调用不移植（§4.3 第 3、15 条）。

---

## 5. 与同平台已移植件的对照（同族不等于同编码）

- **请求三连**与模板同形：同样的三条路径与同样的 body 字段名（模板件的 `extract.js` 第 378、387、399 行，本件 §1）。但 `TaskActivity` 的参数位不同：模板件读 `args[5]` 作教室（模板件的 `parse.js` 第 333 行），NUAA 上游是 `args[6]` 教室、`args[7]` 位图（diff 第 149、152 行）。因此本件的 fixture 按 NUAA 的参数位重写，没有复用模板的 fixture。
- **作息表**：NUAA 两张 11 节，整学期选一张；模板一张 11 节加一张 12 节备用（§4.1）。
- **节次映射**：NUAA 的单元 5、6 丢弃并 warn；模板的单元与节次一一对应。
- **教师来源**：模板件与本件相同：先看 `actTeachers`，取不到时 `args[1]` 为字面量才回落（§4.1）。上游 NUAA 只认 `actTeachers`（§4.3 第 12 条）。
- **学期选择**：NUAA 上游以页面学期为默认；模板件先看 `cal.currentId`，再看页面 id（模板件的 `extract.js` 第 313 行）。
- **模板的学期日历周数截断**（模板件的 `parse.js` 第 645 行）：周数超过 30 时直接截到 30，之后不记录截断。这是模板的行为，本件没有这一步。团队可以决定是否回头修模板，本件不改模板。

---

## 6. fixture 的合成来源与覆盖

- 13 对 fixture 全部是**合成**的：课程、教师、教室、学期 id 都是虚构的。选中学期 454（`fallback` 为 455）的起止日期（2026-08-31 至 2027-01-10）是合成值，不对应真实校历；`term-start-second` 选中的学期 455 没有起止日期，开学日按第二学期锚点推算。
- 结构按上游 `nuaa_01.js` 实际读取的字段形状编出（`TaskActivity` 参数位、`index` 写法、位图、`actTeachers`）。**没有真实账号，没有真实课表 HTML**。fixture 只能证明移植件与我们对上游读取规则的理解一致，不能证明与学校的实际课表一致。
- expected 全部人工推出（每个 block 的星期、节次、周次、单双周都手算），再由 `check.js` 经 Rhino 实跑比对；不是把输出复制进 expected。
- 学号字段：`basic` 的 courseTable 里有合成的隐藏域 `ids` 值 `20260001`，只为测试 extract 的取值路径，不是真实学号。

| fixture | 覆盖的边界 |
|---|---|
| `basic` | 页面学期 id 为默认（454）、教务起止日期（19 周）、明故宫/将军路作息表、单双周、连堂合并、教师取自 `actTeachers`；学期日历另列了 445、446 |
| `weeks-bitmap` | 第 0 位占位（3 处）与空位图（1 个）、只有第 1 位、单周与双周；学期日历另列了 445、446 |
| `course-name` | 全角括号「形势与政策（四）」、半角括号「大学物理(2)」、括号后还有内容「C语言程序设计(2)上机」、两端空白「  离散数学  」；学期日历另列了 445、446 |
| `edge-units` | 读不到 `unitCount` → 缺省 13 并 warn；裸数字换算（27 → 周三第 2 节）；越界的裸数字丢弃并计数（100 → 星期 8）；无 `actTeachers` 且 `args[1]` 为表达式的教师 → null 并 warn（字面量回落见 `fallback`）；教室为空 → null |
| `section-map` | 单元 1–13 全覆盖：1–4 直映、5 与 6 丢弃并在 warnings 里点名（近代史纲要、军事理论，文字面向学生）、7–13 减 2 |
| `campus-tianmuhu` | 教室含「天目湖」→ 天目湖表；计数按原始安排（工程制图两处定位计 2 条，合并为一个块 1–2 节；共 4 条安排）；教室括号去掉（「天目湖校区教3-205(东)」→「天目湖校区教3-205」） |
| `campus-other` | 明故宫/将军路表；教室为空计入非天目湖 |
| `campus-mixed` | 天目湖 2 条、其它 4 条（含教室为空）→ 天目湖表 + 混排 warning |
| `fallback` | 「数据结构」无 `actTeachers`、`args[1]` 为字面量「王老师」→ 教师回落；「形势」`args[1]` 为表达式 → 教师 null 并单独 warn；学期名为空（`rawName` 为空、学年 2026-2027）→ 兜底名「南京航空航天大学 2026-2027学年（学期未知）」并 warn；开学日取教务起始日期所在周的周一；学期日历只列 455 |
| `term-name-kind` | `rawName` 为「第一学期」、学年 2026-2027 → 「2026-2027学年第一学期」，不出学期名提醒（§3 第 9 条） |
| `term-name-unknown` | `rawName` 为「5」→ 兜底名「南京航空航天大学 2026-2027学年（学期未知）」并出提醒（§3 第 9 条） |
| `term-name-proto` | `rawName` 为「constructor」→ 不拼出函数源码，走同一兜底名并出提醒（§3 第 9 条） |
| `term-start-second` | 教务没给起止日期、`rawName` 为「第二学期」、学年 2026-2027 → 学期名补成「2026-2027学年第二学期」，开学日按 2 月 20 日所在周的周一推算为 2027-02-15，学期总周数取缺省 20 周，学期日历只列 455（§3 第 6、9 条） |

---

## 7. 变异测试记录（本批检查表第 12 条）

**本轮（2026-10-09，d、e 修改之后）**在当前 `parse.js`（sha256 `829efc62…`）上跑 M1–M6、B2a–B2c 与 D1，每个变异只改一行。更早几轮的数据基于其它版本的文件，已作废，下表只保留本轮数据。

- 做法：不改真实的 `parse.js`。每个变异都在系统临时目录的整份副本里做：`C:/Users/23703/AppData/Local/Temp/nuaa-fix/mut/<编号>/nuaa/`，各含一份完整的适配器目录，只改副本里的一行（替换前先确认原文恰好出现一次）。`check.js` 对副本跑，输出存在 `out-<编号>.txt`，做完后临时目录已删除。
- 还原：真实文件在每次变异前后 sha256 都是 `829efc62…`，未被改动，无需还原。真实目录的全量检查结果为 `RESULT: PASS`（13 MATCH，退出码 0）。
- M4、M6 的红用例是预期：`edge-units` 与 `fallback` 都依赖表达式教师的路径，两份都该红。M4 另让三份学期名用例（`term-name-kind`、`term-name-unknown`、`term-name-proto`）和第二学期推算用例（`term-start-second`）变红，因为它们的老师取自 `args[1]` 字面量「王老师」，回落删掉后就缺老师（M4 FAIL (6)）。M5 关掉学期名兜底提醒，`fallback`、`term-name-unknown`、`term-name-proto` 三份都少了这条提醒（M5 FAIL (3)）。

| 编号 | 改坏哪一处（`parse.js` 行号） | 哪条用例变红 | `check.js` 输出（摘录） | 改后 sha256 |
|---|---|---|---|---|
| M1 | 第 225 行 `if (i === 0) {` → `if (i === -1) {`（位图第 0 位分支失效） | `weeks-bitmap`（其余 12 对 MATCH） | `$.warnings：数组长度 实际=4 期望=6`；`RESULT: FAIL (1)` | `9fa8f36434c81d8dfa07268fbbfd9d549da38f08b98a17d7d235f944ee2e2181` |
| M2 | 第 276 行 `if (unit === 5 \|\| unit === 6) {` → `if (unit === 5) {`（单元 6 不再进午间） | `section-map`（其余 12 对 MATCH） | `$.warnings：数组长度 实际=6 期望=5`；`$.warnings[4]` 实际为 stray 类说明（「有 1 条上课安排的时间超出了课表能容纳的范围……」），应为午间名单那条；`RESULT: FAIL (1)` | `6a9a0dfefb54639875696f407cfd125074e0cd53c2392ef2f05ab2c6473f208c` |
| M3 | 第 651 行 `var useTianmuhu = tianmuhuCount > 0;` → `var useTianmuhu = tianmuhuCount > 0 && otherCount === 0;`（混排时仍用明故宫表） | `campus-mixed`（其余 12 对 MATCH） | `$.terms[0].periodTimes[0].end：实际="08:50" 期望="09:20"`，以及 `periodTimes[0]` 至 `[2]` 的 start、end 共 6 处（被 check.js 截断）；`RESULT: FAIL (1)` | `14093903682262f919a5abdddd398ec09bf01e66e1511c1de711cd1528c80311` |
| M4 | 第 309 行 `if (!teacher) teacher = teacherOfArg(args[1]);` → `if (!teacher) teacher = '';`（args[1] 的回落与表达式留空都失效） | `edge-units`、`fallback`、`term-name-kind`、`term-name-unknown`、`term-name-proto`、`term-start-second`（其余 7 对 MATCH） | `edge-units`：`$.warnings[7]` 实际为「有 1 条上课安排没有查到任课老师，老师一栏已留空」；`fallback`：`$.terms[0].courses[1].teacher：实际=null 期望="王老师"`，`$.warnings[5]` 实际为「有 2 条上课安排没有查到任课老师，老师一栏已留空」；四份学期名用例（含 `term-start-second`）：`$.terms[0].courses[0].teacher：实际=null 期望="王老师"`，警告多出一条（`term-name-kind` 与 `term-start-second` 实际 5 期望 4，`term-name-unknown` 与 `term-name-proto` 实际 6 期望 5）；`RESULT: FAIL (6)` | `215aa035ca6cc7103a8e0049e5157d5c5917718285dc000398c771739c7a089f` |
| M5 | 第 687 行 `if (nameFallback) {` → `if (false) {`（学期名兜底提醒被关掉） | `fallback`、`term-name-unknown`、`term-name-proto`（其余 10 对 MATCH） | `fallback`：`$.warnings：数组长度 实际=5 期望=6`，缺了「教务没有给出可识别的学期名……」那条，之后各条错位；`term-name-unknown` 与 `term-name-proto`：数组长度 实际=4 期望=5；`RESULT: FAIL (3)` | `38f70b49e205991f7b04b2c4b007b708222d1eae9dbbd5e4a2667927ad69e3c6` |
| M6 | 第 202 行 `exprTeacherHits++;` 删除（表达式教师不再计数） | `edge-units` 与 `fallback`（其余 11 对 MATCH） | `edge-units`：`$.warnings[7]` 实际为「有 1 条上课安排没有查到任课老师，老师一栏已留空」；`fallback`：`$.warnings[5]` 实际为同一句；`RESULT: FAIL (2)` | `133e1cbfae1c1f895116be091ae82b77b3d338452d89c42723f4033aec56d6c9` |
| B2a | 第 577 行 `if (year && hasOwn(KIND_CN, label)) return` → `if (year && KIND_CN[label]) return`（termNameOf 去掉 hasOwn，原型属性名走进查表） | `term-name-proto`（其余 12 对 MATCH） | `$.terms[0].name`：实际为「2026-2027学年第」接一段 `function Object() { [native code …] }` 函数源码再接「学期」，`$.warnings[0]` 里同样出现，`$.warnings` 实际 4 条、期望 5 条（学期名不再为空，兜底提醒没有出现）；`RESULT: FAIL (1)` | `eb98095a9d95adc05529fff1a271c00675323dcf3df657c401f4c60ee830fe93` |
| B2b | 第 575 行 `return year ? year + '学年' + label : '';` → `return label;`（termNameOf 去掉补学年前缀） | `term-name-kind` 与 `term-start-second`（其余 11 对 MATCH） | `term-name-kind` 与 `term-start-second`：`$.terms[0].name` 实际为「第一学期」「第二学期」，期望「2026-2027学年第一学期」「2026-2027学年第二学期」；`$.warnings[0]` 里的学期名同样只剩「第一学期」「第二学期」；`RESULT: FAIL (2)` | `095e2425b66691892b180c2e22452ac24c1bcdfa28bd7af6f0f786262adfb6c9` |
| B2c | 第 562 行 `if (hasOwn(KIND_CN, label)) return KIND_CN[label];` → `if (KIND_CN[label]) return KIND_CN[label];`（termKindOf 去掉 hasOwn，兜底名的学期序号） | `term-name-proto`（其余 12 对 MATCH） | `$.terms[0].name`：实际为「南京航空航天大学 2026-2027学年第」接函数源码再接「学期」，`$.warnings[1]` 里的学期名同样如此；`RESULT: FAIL (1)` | `d425663c0ba6231a8f5eb27b36e186323ae019f7bb8ec8521fd3898e362f45f1` |
| D1 | 第 618 行 `var isSecond = termKindOf() === '二';` → `var isSecond = (sem ? text(sem.rawName) : '') === '2';`（第二学期只认 rawName 为 2，「第二学期」不再走第二学期锚点） | `term-start-second`（其余 12 对 MATCH） | `$.terms[0].firstDay`：实际 `2026-08-31`，期望 `2027-02-15`；`$.warnings[1]` 的推算规则变成「第一学期 9 月 1 日所在周的周一（2026 学年）」，推出 2026-08-31；`RESULT: FAIL (1)` | `9d93ccba61f75f888952c7325860f33a736e16ff7cad84b735a929f39b2a4f0a` |

M3 的输出有截断，需要说明：`check.js` 第 175 行的 `if (out.length > 5) return;` 使每个 fixture 最多只列 6 条差异。M3 的 `periodTimes` 差异远不止 6 处，所以 `$.warnings` 的差异（按代码推断：M3 去掉了混排提醒，并把天目湖作息的 warning 换成了明故宫那条）没有出现在输出里。这一条是推断，不是输出证据。

---

## 8. 已知风险与未验证项

0. **上游全文已读**（团队第 9 条，2026-10-08，只读，未在该目录运行任何程序）。核对结果：
   - `request()`（全文第 182–186 行）：`credentials: "include"` 与本件一致；非 2xx 报错、取文本，目的相同。报错文字不同；本件另有 4000000 字符上限（§4.3 第 17 条）。
   - 教师（全文第 138–139 行）：上游默认「未知教师」，只认 `actTeachers`。本件改为取不到留 null，并按模板回落字面量 `args[1]`（§4.3 第 12、21 条）。
   - 学期日历（全文第 215 行）：上游用 `Function(...)()` 求值，本件改为字面量扫描（§2 第 6 条）。上游的学期显示名是 `${schoolYear} ${name}学期`，且不读 `startDate`、`endDate`、`currentId`；本件读这三个字段，用于开学日与学期选择（§4.3 第 4、6 条）。
   - 课表请求体（全文第 244 行）：上游不编码 `semester.id` 与 `ids`；本件编码，两者都是数字，字节相同（§1）。
   - 请求头：见 §4.3 第 16 条。上游 `adapters.yaml` 的说明文字本件未核对（§8 第 5 条）。
1. **`ids`、`tagId`、`semesterBar`、`semesterCalendar_target` 的正则未在真实页面上验证**。`ids` 的正则与上游一致（允许空白，diff 第 213 行 `+` 侧）；`tagId` 与模板件相同。本地没有 NUAA 账号与真实课表页。页面结构若变，extract 会报「没能从课表页读到学号和学期」，不会静默出错。
2. **个人信息（团队接受，不改代码）**。团队第 1 条对应本条。`courseTable`（课表 HTML 全文）与 `semesterCalendar`（学期日历原文）整体经 JSON 交给 parse.js（`__ncInput`），与模板件 相同。学号 `ids` 只用作课表请求体的字段（`extract.js` 第 390–391 行），不进输出 JSON。parse.js 只从课表里抽 `TaskActivity`、`index` 与 `unitCount`，输出 JSON 不带姓名、学号等字段；但原文仍随 JSON 整体交给 parse.js。两份原文是否夹带学生个人信息，未用真实账号核实。手册 §5 第 4 条字面要求这类信息不带出 extract.js，本件字面上不满足；团队确认接受现状。可选的过滤做法（只交出 TaskActivity 相关片段）未做。真实账号核实前，这一残余风险保留。
3. **登录与 CAS 未核实**。任务卡写明 `loginUrl` 与课表页同在 `aao-eas.nuaa.edu.cn`，但 NUAA 的登录是否经过跨主机的 CAS 页面，没有证据。若有，需要像 ksu 那样把教务主机写进 `allowHosts`，并让登录页判断认出 CAS。本件不识别登录页。
4. **教师的取法只认双引号写法**。`parse.js` 第 302 行的正则是 `name:\s*"(.*?)"`，只对 `actTeachers` 生效。如果真实页面用单引号或其它写法，这些活动的教师会全部记为取不到，warn 会提示。`args[1]` 的回落是本件按模板件 加的（§4.3 第 21 条）；上游全文第 139 行没有这一步（§4.3 第 12 条）。`args[1]` 为表达式时教师留空，不做拼接还原。
5. **混排规则的结果与上游相同**（§4.2），但上游 `adapters.yaml` 的说明文字本件未核对。
6. **没有 fixture 覆盖的分支**（只靠读代码核对，尚无用例证明正确）：
   - 学期日历没有起始日期 → 按学期锚点推算的分支（第二学期有一条用例 `term-start-second`；第一学期 9 月 1 日的推算没有用例）；
   - 学期列表为空（§4.3 第 5 条）与页面学期 id 也缺失时的报错路径；
   - 学期选择的 current、date、latest、last 四条路径（13 对 fixture 都经页面给出的学期 id 选中，见第 7 条）；
   - 学年缺失时按 `data.today` 推算学年的分支（`fallbackNameOf`，§3 第 9 条），以及学期对象整体缺失时的学期名兜底；
   - 周次超过学期总周数（顶高）、位图超过 30 位（丢弃）、`totalWeeks` 截到 30；
   - `unitCountPage` 回落（课表里没有 unitCount，页面有）；
   - 表达式课名（`exprNameHits`，见第 10 条）、课名为空（`noNameHits`）、没有任何定位的块（`blocksWithoutIndex`）；
   - warnings 超过 20 条的截断、单条超过 200 字符的截断、午间名单超过 150 字符的换行；
   - `extract.js` 整体（没有自动化测试，只能在浏览器里跑）。
7. **学期日历的覆盖**。11 对 fixture 选中的学期是 454（由页面给出）；`fallback` 与 `term-start-second` 选中 455（由页面给出，学期日历只列这一个学期）。`basic`、`weeks-bitmap`、`course-name` 的学期日历还列了 445 与 446（`rawName` 分别为 1、2），但选择路径都走页面 id，没有测列表里其它学期会不会被误选。其余 8 对的学期日历只列 454。
8. **学期名的两处取舍**。（a）`rawName` 含「学期」、序号在 1–4 之外（如「第5学期」）且有学年时，补学年前缀后原样输出，不走兜底，也不出学期名提醒；没有 fixture 覆盖这一例。（b）兜底名的学期序号由 `termKindOf()` 取，正则 `/第([一二三四])学期/` 只认「第一」至「第四」，认不出时写「（学期未知）」。模板件的同名函数只认到「二」，本件是否多认由团队决定。开学日推算用的也是 `termKindOf()`（`parse.js` 第 618 行），`term-start-second` 与变异 D1 验证第二学期分支。
9. **学期列表为空时的继续策略与上游不同**（§4.3 第 5 条）。页面学期 id 能用就继续，学期名与日期留空，开学日只能推算。warning 会写明。
10. **表达式课名**（§4.3 第 20 条）。上游保留清洗后的表达式文字，本件取字符串字面量拼接，两者都可能不对。没有 fixture 覆盖（所有 expected 里都没有这条 warning）；真实页面是否出现这种写法待核实。
11. **已修正（团队第 5 条）**：学期名认不出时会出 warning（`parse.js` 第 687–689 行，条件是 `nameFallback`），文字是「教务没有给出可识别的学期名，已按「……」导入，请在学期管理里核对」。认不出的情形：`rawName` 为空（`fallback` 覆盖）、为「5」（`term-name-unknown`）、为「constructor」（`term-name-proto`）、为「春」这类（未单独成例）。学期对象整体缺失未覆盖（见第 6 条）。M5 把提醒关掉后三份用例变红，验证了触发。
12. **已改写（团队第 4 条）**：warnings 按 `docs/ux-writing.md` 第五节改成面向学生的文字，不再出现 unitCount、index、actTeachers、位图、TaskActivity 等词；技术细节留在本文件与代码注释里。手工改写了 `edge-units`、`section-map`、`weeks-bitmap` 三份 expected 的 warnings（未用解析器输出覆盖），`fallback`、`term-start-second` 与三份学期名用例（`term-name-kind`、`term-name-unknown`、`term-name-proto`）为新写。grep 核对（本轮，fix-common 禁词表 + actTeachers、TaskActivity）：13 份 expected 文件里都没有这些词（「位图丁」只出现在课程名里，不在提醒里）。
13. 「午间」一词是本件对单元 5、6 的说明。任务卡只写了「单元 5、6」。
14. 作息表与 NUAA 上游 `getTimeSlots` 逐组一致（diff 第 283–293 行，22 组，已用脚本比对 44 个时间串）。学校实际作息若调整，需要另行更新；本件不向教务请求作息。
15. **读不到 unitCount 时缺省 13**（§3 第 4 条）。若学校实际单元数不是 13，课表会错位。warn 会提示「如果课表整体错位，请反馈」。
16. **位图第 0 位占位的假设未在真实数据上验证**。上游从下标 0 起（全文第 153–154 行；diff 第 155–156 行），第 0 位为 1 时上游会产出第 0 周。若真实数据第 0 位确有含义，会丢失一周的课；warning 会提示核对。
17. **check.js 的差异输出只列前 6 条**（第 175 行），不足以看到每个 fixture 的全部差异（§7）。这是校验工具的限制，不影响 PASS / FAIL 的判定。
18. **适配器版本 `1.0.0`**（团队第 8 条确认正确）。这是适配器自身的版本号（`manifest.json`），与 App 的版本号无关。`minAppVersionCode` 为 11。
19. **团队第 2、6、7 条**：本件记为已知风险，没有改代码。这三条的具体条目本件未逐字记录，请团队确认对应关系后补入本节；在此之前，本件不声称它们已处理。

---

## 9. 签名

0x7E7-2023（haiku 移植，2026-10-08）
