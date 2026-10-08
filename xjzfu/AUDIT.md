# 安全审计 —— xjzfu（新疆政法学院教务）

- 上游：`shiguang_warehouse` 的 `XJZFU/xjzfu.js`（MIT，上游作者 `jesse-s4`；上游 yaml 里
  `adapter_id: XJZFU_01` / `import_url: https://jwxt.xjzfu.edu.cn/jwapp/sys/homeapp/home/index.html`）
  <https://github.com/XingHeYuZhuan/shiguang_warehouse>
- 上游快照：`main` @ `ff72d1f08782df965cae110034a9d87cd91e0c07`（2026-10-08）
- 移植者：`0x7E7-2023`（haiku 移植，2026-10-08）
- 移植者自审结论：**通过**。全部网络请求是当前页同源相对路径（落在 `loginUrl` 主机），只读课表与校历，
  不碰凭据、不读令牌、不埋点、不写页面、不外发。第二段审计（reviewer / adversary）未在本件上跑，见主报告。

## 〇、平台判定

**金智教育 jwapp（homeapp）平台。** 依据是脚本里写死的接口路径与信封：

- `/jwapp/sys/homeapp/api/home/kb/xnxq.do`（学年学期列表，`itemCode` / `itemName` / `selected`）
- `/jwapp/sys/homeapp/api/home/student/getMyScheduleDetail.do`（课表，`datas.arrangedList`）
- `/jwapp/sys/homeapp/api/home/getTermWeeks.do`（校历：首项 `startDate` = 开学日，项数 = 总周数）

信封统一是 `{ code: "0", msg, datas }`。行字段 `courseName` / `dayOfWeek` / `beginSection` /
`endSection` / `week`（位串）/ `weeksAndTeachers` / `placeName`。

> 模板件走的是 `kbapp` 路径族，接口路径、请求体、作息来源都不同，本件**没有**沿用模板件的
> fixture 期望，所有期望值按本件的解析规则独立推出。

## 一、请求清单（与 `extract.js` 逐条一致）

| # | 方法 | 路径（相对、同源） | 头 / 体 | 读什么 | 失败时 |
|---|---|---|---|---|---|
| ① | GET | `/jwapp/sys/homeapp/api/home/kb/xnxq.do` | 头 `fetch-api: true`，`credentials: 'include'` | 学期列表：`itemCode`、`itemName`、`selected === true` 为当前学期 | 信封不对 / 网络错误 / 列表为空 → 按本机日期推算学期（`source: guess`），进 warnings |
| ② | POST | `/jwapp/sys/homeapp/api/home/student/getMyScheduleDetail.do` | 头 `fetch-api: true`、`content-type: application/x-www-form-urlencoded;charset=UTF-8`；体 `termCode=<编码>&campusCode=1&type=term` | `datas.arrangedList`（课表行，剔除个人字段） | 失败**立即重试一次**（不 sleep）；仍失败抛错，提示重新登录 |
| ③ | GET | `/jwapp/sys/homeapp/api/home/getTermWeeks.do?termCode=<编码>` | 头 `fetch-api: true`，`credentials: 'include'` | 校历：第一项 `startDate` 与项数 | 失败 → `firstDay` 为 null，`parse.js` 按运行日推算并进 warnings（见第九节） |

② 与 ③ 在学期确定后并发发出；① 只在最前面一次。没有其它主机，没有 `allowHosts`（`[]`）。

## 二、读取与外发

- **读**：学期列表、课表行、校历。三者都是课表相关的只读接口，未调用任何写接口。
- **个人字段**：`extract.js` 在输出前剔除 `XH` / `XM` / `XH_ID` / `SFZH` / `USERID` / `USERNAME` /
  `USER_NAME` / `STUDENTID` / `STUDENTNUMBER` / `REALNAME`（大小写不敏感），与模板件口径相同。
- **凭据**：不读 `password`、表单值、`localStorage`、`sessionStorage`、`document.cookie`。
  `credentials: 'include'` 只让浏览器自动带本站 Cookie，与上游一致。
- **外发**：无 `sendBeacon` / `WebSocket` / `EventSource` / `new Image()` / 动态 `<script>` / 第三方域。
- **写页面**：无 `innerHTML` / `appendChild` / `submit()` / 表单赋值。

## 三、manifest §5 八条对照

| # | 检查项 | 本件结论 | 证据 |
|---|---|---|---|
| 1 | 不碰凭据 | ✅ | `extract.js` 不引用 password / 表单 / 存储；自检无相关提示 |
| 2 | 不外发 | ✅ | 仅三条同源相对路径；自检无 `sendBeacon` / `WebSocket` / `Image` 命中 |
| 3 | 请求域可控 | ✅ | 代码里无绝对 URL 主机；`allowHosts: []`；自检主机覆盖检查通过 |
| 4 | 只读课表 | ✅ | 三条都是 GET 或课表 POST 查询；无成绩、学籍、缴费接口 |
| 5 | 不埋点 | ✅ | 无统计 / 上报 / 遥测 |
| 6 | 不 eval 远程代码 | ✅ | 无 `eval`、无 `new Function`；响应只走 `JSON.parse` 形式的 `response.json()` |
| 7 | 不写页面 | ✅ | 无 DOM 写入；上游的 `shiguangBridge` 弹窗与提示全部删除（第五节） |
| 8 | 不依赖输入之外的秘密 | ✅ | 无硬编码密钥、学号、令牌；`campusCode=1` 是上游写死的校区参数，不是秘密 |

## 四、本批检查表（第五批）

1. **上下文路径**：金智 homeapp 是绝对路径 `/jwapp/...`，不涉及 `/jwglxt` 或根路径之分。不适用。
2. **菜单号与请求体**：金智没有菜单号；请求体为上游逐字的 `termCode&campusCode=1&type=term`。
3. **作息表逐节核对**：11 节，与上游 `standardSchedule` 逐节一致（10:00 起）。课表节次超过 11 时整张表不写（见第五节）。
4. **跨域登录**：无跨域；`allowHosts: []`。不适用。
5. **模板件残留**：`manifest.json`、`extract.js`、`parse.js`、`fixtures/` 下按模板件的校名、域名与代号 grep 无命中；`AUDIT.md` 只在说明模板差异时提到「模板件」。
6. **其余**：周次位串 + 文本兜底；括号序号（文本路径内）；warnings 上限 20 条、每条 200 字符（`clip`）；
   `HH:mm` 合法性；学期名取教务 `itemName`；`teacher` / `location` 拿不到留 `null`；本文件与代码一致；
   期望值独立推出；变异测试见第七节；ES5（注释也算，自检通过）；控制字节与 BOM 自检通过。

## 五、与模板件的差异，及上游删掉或改掉的东西（逐条）

**与模板件的差异**：

- 接口族不同：本件走 `homeapp`，模板件走 `kbapp`，请求路径与请求体全部重写。
- 学期选择：模板件的学期选择口径不用于本件；本件取 `selected`，没有则取第一项并告警。
- 校历请求：本件 `getTermWeeks` 用 GET（与上游一致）。
- 开学日：按移植手册 §4.3 回退到所在周的周一（`mondayOnOrBefore`）。
- 作息表：本件是上游写死的 11 节常量，只写到课表用到的最大节次；模板件的作息来自教务接口。
- 学期名：优先教务 `itemName`，否则「新疆政法学院 + 学年学期」。
- 课表合并：按「课名 + 教师」合并为一门多 block 的课程（与模板件同口径）。
- 课表重试：本件课表请求失败时立即重试一次（上游没有）。

**上游删掉或改掉的东西及理由**：

- `isOnStudentPage()` 的主机名判断：删。改为同源相对路径，请求失败统一提示「重新登录」。
- 弹窗选学期（`showSingleSelection`）：删。改为自动取 `selected`；没有标出时取第一项并进 warnings。
- 所有 `shiguangBridge.*` 提示与 `notifyTaskCompletion`：删。适配器只交出载荷，宿主负责提示与收尾。
- `saveImportedCourses` / `savePresetTimeSlots` / `saveCourseConfig` 三次推送：删。合并为一个课表载荷（`parse.js` 输出）。
- `setTimeout(importCourseSchedule, 1000)` 自启动：删。由宿主调用。
- `generateTimeSlots` 按最大节次截断作息表：改。上游在超过 11 节时静默只导前 11 节，课表里第 12 节以后的课
  仍然存在但节次时间对不上。本件改为：超过 11 节时**整张 `periodTimes` 不写**并进 warnings，让应用补默认节次表。
- `defaultClassDuration` / `defaultBreakDuration` / `firstDayOfWeek` 配置：删。载荷不带这几个字段；周一对齐靠开学日回退实现。
- 学期列表为空时上游直接报错：改。改为按日期推算学期并进 warnings。
- 上游每行一条课（不合并）：改。合并为「课名 + 教师」一门多 block。
- `parseTeacher` 无教师时返回空串：改。返回 `null`。
- `position: placeName || ''`：改。返回 `location`，拿不到为 `null`。
- **保留**：`campusCode=1`、`fetch-api: true` 头、`credentials: 'include'`、表单体的 `termCode` / `type=term` 字段、
  `getTermWeeks` 的 GET 与「首项 `startDate` + 项数」口径。

## 六、fixtures

共 **3 对**。

1. **基本课表**（`fixtures/basic.extracted.json` → `basic.expected.json`）：
   学期 `api`（`selected`）；校历给出非周一开学日 `2026-09-09`，对齐后应为 `2026-09-07`；总周数 18（校历项数）；
   四门课覆盖多天（周一、周三、周五）、主讲教师（`张三` / `李四` / `孙七` / `刘八`）、位串周次（连续、单周 `ODD`）、
   `placeName` 教室、教室为空得 `null`、节次 1–8（作息表写到第 8 节）。
2. **本校专属边界**（`fixtures/boundary.extracted.json` → `boundary.expected.json`）：
   - 位串下标 `i` 即第 `i+1` 周：`01100000000000000000` → 第 2–3 周（`startWeek 2`、`endWeek 3`）；
   - 主讲 / 辅讲混排：`王教授[主讲];赵助教[辅讲]` 只取 `王教授`；
   - 同一主讲跨时段去重：`大学物理` 两行（周二 1–2 节、周四 3–4 节）合并为一门、两条 block；
   - 文本周次兜底：`线性代数` 位串为空，由 `3-5周/许五[主讲]` 推出第 3–5 周；
   - 第 12 节超出作息表（11 节）：`periodTimes` 不写，并进 warnings；
   - 教务没标出学期（`api-first`）与校历缺失（`firstDaySource: guess`、`totalWeeks: null`）：各进一条 warning，
     总周数由位串长度（20）推出。
3. **文字周次兜底**（`fixtures/textweeks.extracted.json` → `textweeks.expected.json`）：四门课的 week 位串为空或全 0，周次只能取自 weeksAndTeachers 的文字：`1-16周`（离散数学，区间全取）、`1-17(单周)`（数据结构，ODD 第 1–17 周）、`2-16(双周)`（操作系统，EVEN 第 2–16 周）、`2-3周,5-6周`（数字电路，两段 ALL）。总周数取校历 18 周，不产生 warning。

**本校专属边界用例是第 2 条**（`boundary`）。

## 七、变异测试（改坏 → 变红 → 还原 → 复绿）

还原方式：改前给 `parse.js` 做一份快照（放在适配器目录之外）；
每次变异后用 `cp` 还原，并用 `cmp` 核对与快照逐字节一致，再跑一次自检。M3、M4 的变异改在系统临时目录的副本上做，不经过这个快照（见下）。

- **M1 位串下标 off-by-one**：`weeksFromBits` 中 `weeks.push(i + 1)` 改为 `weeks.push(i)`。
  `basic` 变红（如 `高等数学` 的 `endWeek 实际=15 期望=16`，`startWeek 实际=0 期望=1`），
  `boundary` 变红（如 `大学物理` 的 `startWeek 实际=1 期望=2`）。还原后 `cmp` 一致，自检 **PASS**。
- **M2 去掉「主讲」过滤**：`teacherOf` 的正则由 `\[主讲\]` 改为 `\[(主讲|辅讲)\]`。
  `basic` 变红（`大学英语` 的 `teacher 实际="李四、王五" 期望="李四"`），
  `boundary` 变红（课程数 实际=5 期望=4；`大学物理` 教师变成 `王教授、赵助教` 并被拆成两门）。
  还原后 `cmp` 一致，自检 **PASS**。
- **M3 文字路径单周过滤反向**：`weeksFromSegment` 中 `if (odd && i % 2 === 0) continue;` 改为 `if (odd && i % 2 === 1) continue;`。`textweeks` 变红（`数据结构` 的 `startWeek 实际=2 期望=1`、`endWeek 实际=16 期望=17`、`weekType 实际="EVEN" 期望="ODD"`），`basic` 与 `boundary` 不变。变异在系统临时目录的副本上做，原文件未动；还原后 `cmp` 一致，自检 **PASS**。
- **M4 文字路径双周过滤反向**：`if (even && i % 2 === 1) continue;` 改为 `if (even && i % 2 === 0) continue;`。`textweeks` 变红（`操作系统` 的 `startWeek 实际=3 期望=2`、`endWeek 实际=15 期望=16`、`weekType 实际="ODD" 期望="EVEN"`），`basic` 与 `boundary` 不变。变异在系统临时目录的副本上做，原文件未动；还原后 `cmp` 一致，自检 **PASS**。

## 八、本件的具体风险

- **`campusCode=1` 写死**：多校区学校的课表可能取不全。上游就是这样写的，本件保留，未做验证（无真实账号）。
- **校历缺失时开学日随运行日期变化**：`getTermWeeks` 失败时 `extract.js` 给出 `firstDay: null`，`parse.js`
  取「运行当天所在周的周一」，同一份输入在不同日子会得出不同载荷。这一支没有固定期望值的 fixture 能覆盖（输出会随日期变），
  所以 `boundary` 用的是「给定日期 + `firstDaySource: guess`」来覆盖告警路径。**决定：保持现状，不改代码。**理由：模板件也是这样写的；parse.js 与 extract.js 在同一次导入里紧接着运行，取到的「当天所在周」相同，只有恰好跨过周日到周一的午夜时才可能差一周。唯一代价是 CI 没法给这一支写固定期望值，上面那条用例只覆盖告警路径，输出随日期变的部分不进期望值。
- **文本周次只覆盖了一部分写法**：文字路径（位串缺失或全 0 时才会走）由 `textweeks` 与 `boundary` 实际执行的是 `1-16周`、`1-17(单周)`、`2-16(双周)`、`2-3周,5-6周`、`3-5周`，单双周过滤已由 M3、M4 验证。`6周`、`第1-8周`、
  `1至16周`、`(单)1-16周`、括号里的教学班序号等写法有代码、**没有 fixture 期望值**。
- **fixture 为合成数据**：人名（张三、李四……）与课程都是占位，不含真实学号、姓名或真实课表。
- **warnings 上限**：当前最多 10 条（学期、节次、开学日、总周数、超周、丢课、认不出的周次、单双冲突、校历不一致），
  实际不会触及 20 条上限；超过的部分由 `clip` 截掉，不额外提示。

## 九、签名

0x7E7-2023（haiku 移植，2026-10-08）
