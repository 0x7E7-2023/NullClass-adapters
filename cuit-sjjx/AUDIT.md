# 安全审计与移植说明：`cuit-sjjx`（成都信息工程大学 · 本科实践教学平台）

## 0. 出处

| | |
|---|---|
| 上游文件 | `shiguang_warehouse` 的 `resources/CUIT/cuit_bk_new.js` |
| 上游快照 | commit `fa7cbc2ea116e5ffd082a9fe8cb7bdf4407a8713`（2026-09-22），MIT，作者 **igugyj(Pfolg)** |
| 上游 `adapters.yaml` | 同目录 `resources/CUIT/adapters.yaml` |
| 移植者 | 0x7E7-2023　**日期**：2026-09-22 |

同目录 `resources/CUIT/adapters.yaml` 里 CUIT 有**两条**适配器，本件取的是 `CUIT_01`：

| id | 名称 | 脚本 | import_url | 本仓对应目录 |
|---|---|---|---|---|
| `CUIT_01` | 成都信息工程大学**本科实践教学平台** | `cuit_bk_new.js` ← **本件** | `https://ywtb.cuit.edu.cn/` | `cuit-sjjx/`（本件） |
| `CUIT_02` | 成都信息工程大学**教务管理系统** | `cuit_bk_old.js` | `https://jwc.cuit.edu.cn/` | `jw-adapters/cuit/`（已移植，见其 `AUDIT.md`） |

两者不是同一套系统，接口、平台、数据形状都不同，读代码时别拿混。

## 1. 平台

「本科实践教学（管理）平台」，产品名 **LabMS**（接口前缀 `/labms/`）。判据是脚本实际请求的
接口路径（`/labms/user/info`、`/labms/course/schedule/list/type`），不是上游注释或文件名。
上游脚本头部注释自带课表页地址：`https://sjjx.cuit.edu.cn:56443/labms/#/course/my`
（非标准端口 `56443`，与登录域 `ywtb.cuit.edu.cn` 不同主机）。

这台接口本身就返回**扁平 JSON 数组**（每行一条排课，字段名清楚：`courseName` /
`teacherName` / `location` / `weekDay` / `sections` / `weeks` / `startTime` / `endTime`），
不需要像 `jw-adapters/cuit`（教务管理系统）那样在 HTML 里认内嵌 JS 块或解码位图 ——
`weeks` 本来就是显式周次数组（手册 §4.1 的「上游给的是显式周次数组」那一类），
所以本件的 `parse.js` 比 `jw-adapters/cuit` 简单很多。

## 2.（专门）`loginUrl` 与实际教务主机不同源，`allowHosts` 为什么不能留空

### 事实

| | 主机 | 出处 |
|---|---|---|
| 登录域（`loginUrl`） | `https://ywtb.cuit.edu.cn/` | 上游 `adapters.yaml` 的 `import_url`（`CUIT_01`），描述是「登录（外网用户把二维码发到另一台设备），进入「本科实践教学（管理）平台」进行导入」——典型的跨设备 / 单点登录入口，登录完成后会跳到另一套系统 |
| 脚本实际请求的教务主机 | `sjjx.cuit.edu.cn:56443` | 上游脚本头部注释「适用页面：`https://sjjx.cuit.edu.cn:56443/labms/#/course/my`」，且脚本内 `fetch` 一律用 `window.location.origin` 拼地址，说明作者假定脚本运行时页面就在这台主机上 |

这是**两台不同的主机**，与 `jw-adapters/cuit` 的情况（`jwc.cuit.edu.cn` vs `jwgl.cuit.edu.cn`）
性质相同，但本件**不能**照搬 `cuit` 那套「同源相对路径 + `allowHosts: []`」的取舍：

- 提取期的网络闸门只放行 `loginUrl` 的主机 + `allowHosts` 里声明的域
  （`JwWebViewStep.kt`：`gate.allowedHosts = adapter.allowedHosts(hostOf(loginUrl))`，
  即 `[loginUrl 主机] + manifest.allowHosts`；`scheduleUrlHint` **不会**自动加进闸门）。
- 用户点「提取课表」时，WebView 实际停留的页面是 `sjjx.cuit.edu.cn:56443`（登录 + 二维码跳转之后
  的落地页，不是 `ywtb.cuit.edu.cn`），`extract.js` 对 `window.location.origin` 发起的同源请求
  因此会命中 `sjjx.cuit.edu.cn`，**不在** `[ywtb.cuit.edu.cn]` 这个闸门允许集合里，会被直接拦掉。

### 处理方式

`manifest.json` 显式声明：

    "loginUrl": "https://ywtb.cuit.edu.cn/",
    "scheduleUrlHint": "https://sjjx.cuit.edu.cn:56443/labms/#/course/my",
    "allowHosts": ["sjjx.cuit.edu.cn"]

- `loginUrl` 保留上游 `adapters.yaml` 的 `import_url`，作为 WebView 的起始地址（用户在这里完成
  登录 / 扫码跳转）；
- `scheduleUrlHint` 指向上游脚本注释里的真实课表页，方便「一键刷新」直接跳回去，不用重新走一遍
  登录流程；
- `allowHosts` 显式写 `sjjx.cuit.edu.cn`（精确主机名，**不带端口、不带通配**——闸门按主机名匹配、
  忽略端口，见 `JwHostAllowlist.kt`），这样无论用户是从 `ywtb.cuit.edu.cn` 跳转过去还是直接打开
  `sjjx.cuit.edu.cn:56443`，只要课表页本身在这台主机上，提取请求都会被放行。
- 不写 `*.cuit.edu.cn` 这种通配：会把成信全部子域一起放行，通配范围过大（手册 §5 第 3 条）。

### 拿不到证据的地方（诚实写）

登录到「本科实践教学平台」中间那一步（「外网用户把二维码发到另一台设备」）具体经过哪些跳转、
最终落地页是不是一定是 `sjjx.cuit.edu.cn:56443`，**没有真机验证**。如果真机上课表页落在别的主机
（例如经过网关重写成另一个子域），修法是把那台主机名加进 `allowHosts`，其余代码不用动
（`extract.js` 全程用 `window.location.origin` 拼地址，不写死主机名）。

## 3. 脚本实际请求了哪些域与路径（全部）

`extract.js` 里只有一处 `fetch` 调用点（`request()` 函数），地址全部由
`window.location.origin` 拼出，**源码里没有任何绝对 URL**（连注释里的地址也不可执行）。

| # | 方法 | 路径（相对当前源） | 请求体 | 用途 |
|---|---|---|---|---|
| 1（可跳过） | GET | `/labms/user/info?sf_request_type=ajax` | — | 只有页面全局变量 / DOM 都读不到学号时才发；正常情况下学号从 `window.__INITIAL_STATE__` 或页面上的用户名节点直接读，不发请求 |
| 2 | POST | `/labms/course/schedule/list/type?sf_request_type=ajax` | `{studentIds:[学号],labIds:[],classIds:[],teacherIds:[学号],status:2,semester:<当前学期名>,week:null,showMode:"table",toBeDeleted:0}`（上游原样） | 课表数据（扁平数组） |

请求头只有 `X-Requested-With` / `Content-Type`（第 2 条）， `credentials: 'include'`
（用用户当前的会话 cookie，本脚本不读、不存、不上报任何 cookie 或令牌）。

`parse.js` **一个网络调用都没有**：没有 `fetch` / `XMLHttpRequest` / `WebSocket` /
`sendBeacon` / `new Image()` / `document` / `window`，也没有 `eval` / `new Function`
（`grep -c "eval(\|new Function"` 两份脚本均为 0）。

**请求体里带出去的东西**：只有当前学期名与**用户自己的学号**（`studentIds` / `teacherIds`，
上游同款，接口的必需参数）。学号**不会写进输出**：`extract.js` 交给 `parse.js` 的 JSON
（`semester` / `today` / `raw.rows`）三块都不含学号，fixture 里也没有。

## 4. 读取面（`extract.js` 到底读了页面上的什么）

| 读的东西 | 从哪读 | 用来干什么 |
|---|---|---|
| `window.__INITIAL_STATE__` / `window.g_initialState` 的 `info.userCode` / `info.nickName` | 页面全局变量（React 应用注水数据） | 取学号（优先，免一次请求），**不写进输出** |
| `.username___LBEmQ` 节点文本 | DOM（页面上显示的用户名，含学号前缀） | 上面失败时的退路，同样只取学号 |
| `.ant-select-selection-item[title]` 的 `title` 属性 | 课表页上的学期下拉框（Ant Design 组件） | 取当前学期名（自动取当前学期，替代上游未移植的弹窗选择） |
| `window.__INITIAL_STATE__.semester.current.name` | 页面全局变量 | 学期名的第二条退路 |
| 课表接口响应 `data.data` | 第 2 条请求的响应 | 原样交给 `parse.js`（`raw.rows`），本脚本不解析课程、不切周次 |

**没有读**：成绩、学籍、个人信息、缴费、选课、`localStorage` / `sessionStorage` /
`document.cookie`、密码框、任何表单值。`window.location` 只用来取 `origin` / `hostname`
（拼同源地址 + 失败时的提示文案），不读 `search` / `hash`。

## 5. 逐条：移植手册 §5 八条

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 不碰凭据 | ✅ | 不读密码框 / 登录表单 / `localStorage`；请求靠 `credentials:'include'` 的会话 cookie；不在任何地方外发 |
| 2 | 不外发 | ✅ | 唯一请求点 `request()`，URL 由同源拼出；无第三方域、无统计、无埋点 |
| 3 | 请求域可控 | ✅ | 全部请求打在 `window.location.origin`（提取时即 `sjjx.cuit.edu.cn:56443`）；`allowHosts` 只写精确主机名 `sjjx.cuit.edu.cn`，未使用通配；理由见第 2 节 |
| 4 | 只读课表 | ✅ | 只读用户信息（仅取学号，不外发）与课表两个接口；不读成绩 / 学籍 / 个人信息 / 缴费 |
| 5 | 不埋点 | ✅ | 没有 `console` 之外的任何上报；上游的 `showToast` / `showAlert` 弹窗类调用均未移植 |
| 6 | 不 eval 远程代码 | ✅ | 全仓禁用 `eval` / `new Function`；两份脚本 grep 计数为 0；本件也没有上游那种动态求值需求 |
| 7 | 不写页面 | ✅ | 两份脚本都不写 DOM、不改表单、不触发提交。`extract.js` 唯一碰 `window`/`document` 的地方是读 `window.location`、`window.__INITIAL_STATE__` 与 `document.querySelector`（只读，不写）；`parse.js` 连 `window`/`document` 都没有 |
| 8 | 不依赖用户输入之外的秘密 | ✅ | 无硬编码密钥 / 令牌；学号来自用户自己的会话，且不写进输出 |

## 6. 移植时删掉 / 改掉的上游行为

1. **上游硬编码的开学日 / 总周数没有移植**（`importConfig()`）：上游只对字符串
   `"2025-2026"` + `"第一学期"` 特判成 `"2025-09-01"`，其余一律写死 `"2026-02-23"`、
   总周数写死 `20`——这两个值只在上游写脚本那一刻是对的，且**上游自己也没有任何 warnings
   提示用户这是猜的**。本件改成按学期名（`YYYY-YYYY学年第N学期`）推算「学期锚点所在周的
   周一」（与 `jw-adapters/cuit` 同一套锚点：第一学期 = 当年 9 月 1 日所在周一，第二学期 =
   次年 2 月 20 日所在周一），总周数按课表里出现的最晚周次推算（课表数据本身就有显式
   `weeks` 数组，不需要猜）。两者都在 `warnings` 里如实说明是推算值（手册 §4.2/§4.3）。
2. **上游当前学期的硬编码兜底没有移植**：三种取法（`__INITIAL_STATE__` / DOM / 接口）都
   失败时，上游直接返回字符串字面量 `"2025-2026学年第二学期"` 冒充「当前学期」。这个值
   只在上游写脚本那一刻是对的，原样搬过来会一直冒充「当前学期」。本件在三种取法都失败时
   让 `semester` 留空，`parse.js` 用占位学期名 + `warnings` 如实说明，不假装拿到了学期名。
3. **手册 §4.4 的自定义时间规则**：上游对每一行都不管三七二十一取
   `item.sections[0]`/`item.sections[last]`，没有 `sections` 时也硬当成第 1 节
   （`item.sections && item.sections.length > 0 ? ... : 1`）。本件按手册规则实现：有
   `sections` 按最小/最大节次放课；没有 `sections` 但有 `startTime`，按开始时间在内置
   作息表里找最接近的一节（差 ≤1 小时）；两者都没有就跳过这门课并写 `warnings`，不悄悄
   当成「第 1 节」（那样会把课放到错误的时间格子里，比丢一门课更容易让人没发现）。
4. **教师 / 教室拿不到一律留空 `null`**，不写「未知」（手册 §4.7）。
5. **周次上限**：数组里出现超过 30 周的一律截断到 30（起始周本身超过 30 的整段丢弃），
   都写进 `warnings`；一门课的全部周次都因此被丢光时，这门课不出现在载荷里，并单独计数
   写一条 `warnings`（不能让用户以为这门课本来就没排，见 `parse.js` 的 `coursesDroppedEmpty`）。
   上游没有任何周次上限处理（`weeks` 数组多长就用多长）。
6. **上游的 `showToast` / `showAlert`（弹 `alert`）、`shiguangBridge*` 系列回调、
   `importTimeSlots()` / `importConfig()` 两段全部没有移植**：作息表改由 `parse.js` 内置
   （与上游 `importTimeSlots()` 的 12 节预设值完全一致，本身就是同一所学校，与
   `jw-adapters/cuit` 的内置表也完全一致），开学日/总周数改由 `parse.js` 推算。
7. **上游 `getUserInfoFromPage()` / `getCurrentSemester()` 的读取逻辑原样保留**（页面全局
   变量优先、DOM 兜底），只是把「三处都拿不到」的行为从「返回一个写死的假值」改成
   「留空交给 `parse.js` 报警」（见第 2 条）。
8. **学号不写进输出**（上游也没有，这里明确保证 fixture 里不会出现）。

## 7. 已知边界与没做的事（诚实写）

- **fixture 是合成的**（2 对）。合成来源已写在 `manifest.json` 的 fixture 说明里，代价是：
  真实接口返回的字段形状可能有本件没覆盖的写法（例如 `sections` 不连续、`weeks` 里混了
  非法值、`weekDay` 用 0 表示周日而不是 7）。**换成真实 dump 才算数**
  （`docs/jw-adapter-testing.md` §3 同口径）。
- **`allowHosts` 里的主机名是推断的**（第 2 节），依据是上游脚本注释自带的地址，没有真机
  验证登录跳转的最终落地域名是否总是这台。真机验证方法：导入失败时看日志里的
  `hosts=[...]` 与实际访问的域是否一致，不一致就把实际域名加进 `allowHosts`。
- **自定义时间就近匹配的容差（60 分钟）是按手册 §4.4 的建议值实现的**，没有真机样本验证
  这台接口到底有多少门课会走这条分支（也可能这台接口的 `sections` 永远非空，这条分支
  永远不触发）。
- **没有做真机验证**（没有账号）。没做的事还包括：只导入当前学期（不批量导历史学期）、
  不做 OCR、不做图片课表、不写任何 DOM。
- **`sections` 里的节次假定已经是连续的**（上游同款假设：直接取最小值当起、最大值当止），
  没有做「中间缺节」的检测（例如 `sections=[1,3]` 会被当成 1-3 节连堂，而不是 1 节 +3 节
  两段）。如果真机发现这种断档写法，需要在 `parse.js` 里按 §4.1 的「极大段」思路把
  `sections` 也切段——这是手册标注的同族做法，本件目前没有证据支持这台接口存在这种数据，
  暂不实现，留作已知缺口。

## 8. fixture 与期望值怎么独立推出来的

两份 fixture 的期望值不是把 `parse.js` 的输出贴进去的，是先按上面的规则手算出来，再用
Node `vm`（Rhino 之外的独立实现）跑一遍确认，逐字段比对全部 MATCH：

| 用例 | 覆盖点 |
|---|---|
| `basic` | 正常三门课：全周（`ALL`）、单周（`ODD`，1-15 隔周）、双周（`EVEN`，2-16 隔周）；教师/教室为空时留空 `null`；开学日按「第一学期 = 9 月 1 日所在周一」推算（`2026-08-31`，2026-09-01 是周二）；总周数按最晚周次（16）推算 |
| `edge-boundary` | 单周课（第 9 周）；`sections` 为空靠开始时间就近匹配到作息表一节（14:50 → 第 6 节，差 5 分钟）；`sections` 为空且开始时间（23:50）匹配不到任何一节，整门跳过；课程名为空、周次为空、星期越界（8）三种数据各跳过一行并计数；一门课的周次切出「1 段 30 周以内 + 1 段部分超 30 周截断到 30」两个 block；一门课的周次全部超过 30 周（起始周本身 >30）被整段丢弃、这门课因此一个 block 都不剩、**整门不出现在载荷里**并单独计数；节次用到第 13 节（超出内置 12 节作息表）触发额外提示；总周数按最晚原始周次（36）推算后按上限 30 截断 |

### 变异测试（自验，2026-09-22）

用 Node `vm` 把 `parse.js` 读进内存后按点替换（工作区文件不动），跑两对 fixture 与
`expected` 逐字段比对。对照组（不改任何地方）全绿；四组变异全部至少让一条用例变红：

| # | 改坏哪里 | 变红的用例 |
|---|---|---|
| M1 | 周次段超过 30 周时改成整段丢弃（而不是截断保留） | `edge-boundary`（「跨年周次样例」少了截断后的第二个 block） |
| M2 | `ODD`/`EVEN` 奇偶判断反过来 | `basic`（数据结构课程设计 `ODD`→`EVEN`）、`edge-boundary`（跨年周次样例的截断段 `EVEN`→`ODD`） |
| M3 | 就近匹配节次的容差从 60 分钟改成 3 分钟 | `edge-boundary`（「毕业设计（论文）」从匹配到第 6 节变成整门跳过） |
| M4 | 第二学期锚点年份不 `+1`（退回第一学期同款年份） | `edge-boundary`（开学日 `2027-02-15` → `2026-02-16`） |

## 9. 自验记录

1. **Node `vm`**：2 对 fixture 逐字段比对（键顺序无关、数组顺序有关）→ **ALL MATCH**。
2. **`node --check`**：两份脚本语法检查通过。
3. **ES5 硬要求**：两份脚本里 `=>` / 反引号 / `\blet\s` / `\bconst\s` 计数**全为 0**；
   没有 `eval` / `new Function` / `async` / `await`。
4. **NUL / 控制字符**：`parse.js`、`extract.js`、4 个 fixture 全部 **NUL: 0**。
5. **变异测试**：见第 8 节，四组变异均被至少一条用例挡住。

---

**移植者**：0x7E7-2023　**日期**：2026-09-22　**签名**：本文件与代码逐条对照过，
第 3/4 节的请求与读取清单与 `extract.js` 的实际实现一致，第 5 节的结论与代码一致。
本目录只包含 `manifest.json` / `extract.js` / `parse.js` / `AUDIT.md` / `fixtures/*`，
没有改动 `index.json`（已由主 agent 统一添加）或本仓库任何其它文件。
