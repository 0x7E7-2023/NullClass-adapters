# 安全审计 —— 广东药科大学（正方教务，jwglxt 根路径，经学校 WebVPN 访问）

审计对象：`jw-adapters/gdpu/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `GDPU/gdpu_01.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取；
本校脚本最后一次修改 `80e30cf`，2026-09-23；MIT，作者 星河欲转）。

审计方式：逐行读上游脚本与移植件；跑 `check.js`（Rhino 实跑 6 对 fixture、载荷校验、ES5、控制字节、allowHosts）；
用 Node 桩跑 `extract.js`（不联网，结果见 §5）；变异测试（§6）。

**没有本校教务账号，真机没跑过。** WebVPN 地址的十六进制段、`vpn-12-o1-…` 查询串片段、校区作息接口 `cxRjc` 的
返回字段、校历接口字段、节次与周次写法，都是照上游与同族正方件推断的，**未在本校实测**，见 §8。

## 0. 上游的校名与写法问题

上游 `GDPU/gdpu_01.js` 文件头写的是「广东药科大学 (gdpu.edu.cn) 拾光课程表适配脚本」，与同目录 `adapters.yaml` 的
`adapter_name`「广东药科大学正方教务」一致，本件以之为准。上游 `import_url` 是 WebVPN 的 `https` 映射地址
（`webvpn.gdpu.edu.cn/https/<十六进制>/lyuapServer/login?...`），课表请求走的是同一主机的 `/http/<十六进制>/` 前缀。

## 1. 请求域与请求清单（与代码逐条对应）

地址的拼法（`extract.js` 第 58–80 行 `jwBase` / `kbcxUrl`）：

- `<base>`：当前页面路径里最早出现的 `/kbcx/` 或 `/xtgl/` 之前的那一段，再拼上 `window.location.origin`。
  WebVPN 下就是 `https://webvpn.gdpu.edu.cn/http/<十六进制>`；正常部署为空。找不到这两个标记（停在 WebVPN 首页、门户页等）
  就抛「请先进入教务系统、打开课表页后再点「提取课表」」，**不发请求**。
- `[vpn&]`：只有当前路径以 `/http/` 或 `/https/` 开头（经 WebVPN 打开）时才带。取当前查询串里形如 `vpn-数字-o数字-…` 的片段；
  找不到就用上游的 `vpn-12-o1-jwsys.gdpu.edu.cn`。非 WebVPN 时不带。所有请求按同一规则拼。

| 谁 | 方法 | 地址 | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| extract.js | GET | `<base>/kbcx/xskbcx_cxXskbcxIndex.html?[vpn&]gnmkdm=N2151&layout=default` | 读课表首页的 `#xnm` / `#xqm`。**页面上已有就不发** | 报错，提示重新登录后再点「提取课表」 |
| extract.js | POST | `<base>/kbcx/xskbcx_cxXsgrkb.html?[vpn&]gnmkdm=N2151`，体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数 | 报错（网络、状态码、非 JSON、无 `kbList`）→ 大白话提示 |
| extract.js | POST | `<base>/kbcx/xskbcx_cxRjc.html?[vpn&]gnmkdm=N2151`，体 `xnm=…&xqm=…&xqh_id=<课表行里的 xqh_id>` | 取校区节次时间（上游没有此接口，见 §4） | 交 `null`（`optionalJson` 吞掉一切失败）；返回空或不是数组时视为取不到，此时才问校区（见下一行） |
| extract.js | `__ncSelect` | 提问桥，标题「选择校区」，两个选项「广州、云浮校区」「中山校区」，`defaultIndex` 0 | 仅在 `cxRjc` 取不到、且 `__ncCapabilities.ask` 可用时问一次 | 桥不在、用户取消、报错都交 `campusChoice: null`，不让提取失败 |
| extract.js | POST | `<base>/kbcx/xskbcxZccx_cxZcByXnxq.html?[vpn&]gnmkdm=N2154`，体 `xnm=…&xqm=…` | 学期周次校历：定开学日与总周数（上游也取，但上游只取了开学日，见 §4） | 交 `null`，parse 推算开学日并写 warnings |

`allowHosts` 为空数组（manifest 第 14 行），不写通配。全部请求都是同源（就是 `loginUrl` 所在的 `webvpn.gdpu.edu.cn`），
代码里没有其它主机。`parse.js` 不发任何请求。

## 2. 读了什么、交出什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 的值与下拉框文本） | 课表页的 `#xnm` / `#xqm`，或课表首页 HTML（`DOMParser` 离线解析，不插入当前页面） | 带出（`term` 段，学期名要用） |
| 排课行 `kbList` | 课表接口 | 白名单 `KB_FIELDS`（`extract.js` 第 270 行）：`kcmc`、`xm`、`cdmc`、`xqj`、`jcs`、`zcd`、`xqh_id` |
| 集中实践课 `sjkList` | 课表接口 | 白名单 `PRACTICE_FIELDS`：只带 `kcmc` |
| 校区号 | 第一条排课行的 `xqh_id`（拼 `cxRjc` 用） | 带出（`campusId`） |
| 校区节次时间 | `cxRjc` | 带出，只留 `jcmc` / `jc` / `qssj` / `jssj`（`PERIOD_FIELDS`，`slimRows`）；取不到为 `null`，parse 再校验 |
| 校区选择 | `__ncSelect` 的下标 | 带出（`campusChoice`，0 / 1 / `null`） |
| 学期周次校历 | `cxZcByXnxq` | 带出，只留 `zs` / `zsmc` / `zrq` / `zcrq` / `rq` / `ksrq`（`CALENDAR_FIELDS`）；parse 只用它算开学日与总周数，不进载荷 |
| 记录总数（响应里有才有） | 课表接口 | 带出（`total`，只用于对账） |
| 学生个人信息（课表响应里夹带的 `xsxx`、学号、姓名、学院等） | 课表接口 | **不带出，不进 fixture**：`extract.js` 只按白名单挑字段。桩跑时在响应里塞了带 `FAKE` 字样的 `xsxx`，交出的字符串里检索不到 |

`parse.js` 实际读的字段：排课行 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd`；实践课 `kcmc`；`periodTimes` 的 `jcmc` / `jc` 与 `qssj` / `jssj`；
`calendar` 的 `zs` / `zsmc` 与 `zrq` / `zcrq` / `rq` / `ksrq`；`total`；`today`；`term.*`；`campusChoice`。

不读的东西：`password` / 登录表单、`localStorage` / `sessionStorage` / Cookie、成绩（`/cjcx/*`）、学籍、个人信息、缴费，以及其它模块的接口。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问。`credentials: 'include'` 让 WebView 按同源规则带会话 Cookie，脚本既不读它也不外发。上游的开场弹窗 `showAlert`、学年输入 `showPrompt`、学期选择 `showSingleSelection` 都没有移植 |
| 2 | 不外发 | **过**。全部 `fetch` 在 `extract.js` 的 `request` 里，地址由 `window.location` 拼成。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单 |
| 3 | 请求域可控 | **过**。请求主机只有一个，即用户当前打开的 WebVPN 主机。`allowHosts` 留空，不写通配。代码里没有写死的主机名与端口（文件头注释里的上游地址不在代码里） |
| 4 | 只读课表 | **过**。四条请求全部落在 `/kbcx/*`（课表首页、课表、作息、周次校历），不碰成绩、学籍、个人信息、缴费。课表响应里的学生信息不带出 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，也没有图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`，第 121 行） |
| 7 | 不写页面 | **过**。只读 `#xnm` / `#xqm` 的值，首页用 `fetch` + `DOMParser` 离线解析，不插入、不改表单、不点击、不提交 |
| 8 | 不依赖输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。常量只有菜单号 `N2151` / `N2154` 与 WebVPN 查询串的兜底片段 `vpn-12-o1-jwsys.gdpu.edu.cn`（上游写死的公开路由名，不是秘密） |

## 4. 与模板 hueb 的差异（复制后逐处改动）

1. **根路径 + WebVPN 前缀**：模板写死 `/jwglxt`；本件是根路径，`<base>` 按当前地址算（`jwBase`），WebVPN 下带 `/http/<十六进制>`，`vpn-…` 片段沿用当前地址。
2. **登录 / 门户判断**：模板只看 `login_slogin.html`；本件照上游 `isLoginPage()` 判 `href` 含 `lyuapServer/login`，另加 `login_slogin.html`（`onLoginPage`，第 82 行）。门户页（找不到 `/kbcx/` 与 `/xtgl/`）在 `jwBase()` 里抛提示。
3. **节次时间**：模板是一张上游 13 节表；本件是上游两张 15 节表（广州、云浮 / 中山，`CAMPUS_PERIOD_TIMES`，parse.js 第 57 行起），逐节照抄。选表依据：`cxRjc` 合法 → 用它；否则 `campusChoice`（0 / 1）；`null` → 广州、云浮表并写「没选校区」提醒。
4. **提问桥**：模板没有；本件按 `lnu` 的 `askCampus` 写法，仅在 `cxRjc` 取不到时问一次（`askCampus`，第 229 行）。
5. **周次校历**：模板也取（`N2154`）；上游只在模板里保留了总周数 20 的写死值。本件照模板，校历取不到推算开学日、总周数内置 20 周。
6. **H3 补节次**：沿用模板。`BUILTIN_PERIOD_TIMES`（空课默认 12 节）只在教务表短于 12 节时会用到；两张校区表都是 15 节，所以对本校而言 16 节起一律走**顺推**（课间 5 分钟、每节 45 分钟，越过 23:59 就停）。

## 5. 上游里删掉或改掉的东西及理由

| 上游 | 本件 | 理由 |
|---|---|---|
| `validateYearInput` + `showPrompt`（输入起始学年） | 删，改读 `#xnm` | 不弹窗；学年从课表页下拉框来，与教务实际可选项一致 |
| `showSingleSelection`（学期，`第一学期` / `第二学期`，学期码写死 `3` / `12`） | 删，改读 `#xqm` 的值 | 学期码与代号由页面给，不写死 |
| `showSingleSelection`（校区） | 改为 `__ncSelect`，且只在 `cxRjc` 取不到时问 | 节次时间能从教务取到就不打扰用户 |
| `showAlert`（开场「请确保已登录」） | 删 | 登录提示由 `onLoginPage` 与大白话报错承担 |
| `saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots` | 删 | 空课由宿主保存，适配器只交载荷 |
| `showToast` / `notifyTaskCompletion` | 删 | 同上，UI 不在适配器里 |
| `config.defaultClassDuration` / `defaultBreakDuration` / `firstDayOfWeek` | 删 | 载荷没有这些概念；每周起始日按手册 §4 处理 |
| `config.semesterTotalWeeks: 20` | 保留为校历取不到时的兜底 `SCHOOL_TOTAL_WEEKS` | 与上游一致 |
| `!rawCourse.kcmc \|\| !rawCourse.xm \|\| !rawCourse.cdmc \|\| ...` 整行丢弃 | 放宽：只要求课名、星期、节次、周次；缺教师 / 教室照常导入（`null`），按类型汇总写进 warnings | 移植手册 §4.7；不许静默丢课 |
| 上游不合并课程（一行一个 block） | 模板的两阶段合并（`dropExactDuplicates`、`mergeStageOne`、`mergeStageTwo`） | 与模板统一；只合并首尾相接的节次，不改任何一周的安排 |
| 上游 `parseWeeks`（只认 `(\d+)-(\d+)周` 与 `^(\d+)周`，单双靠 `includes`） | 模板的周次解析（`weeksOf`） | 认 `(单)1-8周,(双)9-16周`、`1-8周(单)`、`1-16(单周)`、`共 N 周` 备注；上游的写法会把段首标记并错段或整段丢掉 |
| 上游 `jcs.split('-')` | 模板的节次解析（`sectionsOf`） | 认 `1-2` / `第9-10节` / `1,2` / `0102`；多段按最大跨度放入并说明 |
| 上游 `TimeSlots` 写死（只在成功后存预设） | 教务接口优先，写死表只做回落 | 同一学校不同校区节次不同，写死表会错 |

## 6. 变异测试记录

在临时副本（`C:/Users/23703/AppData/Local/Temp/gdpu-port9/mut/`）上改坏 `parse.js` 一处，跑 `check.js`，原件未动：

| 编号 | 改坏哪一处 | 变红的用例 | 结果 |
|---|---|---|---|
| M1 | 选表被固定为第 0 张（`campusIndex` 恒为 0） | `campus1-wednesday` DIFF | 红，已还原 |
| M2 | 中山表第 7 节开始时间 `13:30` 改成 `14:00` | `campus1-wednesday` DIFF | 红，已还原 |
| M3 | 删掉「没选校区」提醒 | `second-term-no-campus` DIFF | 红，已还原 |
| M4 | 「共 N 周」剥离改回上游式 `/共.*$/`（删到行尾） | `week-markers` DIFF | 红，已还原 |
| M5 | 去掉段首「(单)/(双)」归属修复（标记并到前一段） | `week-markers` DIFF | 红，已还原 |

原件已还原，`check.js` 重跑 PASS（见交付报告）。

## 7. 合成用例（6 对，期望值按规范与代码逻辑手工推演）

| 文件 | 覆盖什么 |
|---|---|
| `basic` | 广州、云浮表逐节（第 7 节 14:00-14:40、第 15 节 20:40-21:20）；校历第 1 周是周一；单周、双周、完全重复行；课表排到第 16 节 → H3 顺推 21:25-22:10 并写 warnings |
| `campus1-wednesday` | 中山表（第 7 节 13:30-14:10、第 15 节 20:10-20:50）；校历第 1 周是周三 → 回退到周一 |
| `second-term-no-campus` | 第二学期；教务节次时间两行重叠 → 整张弃用；没问到校区 → 广州、云浮表 + 「没选校区」；校历取不到 → 按 2 月 20 日锚点推算（2027-02-15），总周数内置 20 周 |
| `api-periods-legal` | 教务给了合法的 10 节 → 用教务的，不出校区提醒（即使带了下标）；总周数取校历 18 周；双周 |
| `long-warnings` | 长课名 + 缺教师 / 缺教室 → 照常导入（`null`），提醒指向「编辑课程」；课名截到 20 字；集中实践课 4 门只点名 3 门；周次「待定」的一行跳过并写明 |
| `week-markers` | 单/双标记归属（前缀、后缀两种）；`1-15周(单) 共16周`；`共16周,1-15周(单)`；`1-8周(共8周),9-16周` |

本校专属边界（任务卡 §本校专属边界用例）：1 → `basic`；2 → `campus1-wednesday`；3 → `second-term-no-campus`；4 → `api-periods-legal`；
5 → `basic`（第 16 节）；6 → `campus1-wednesday`（周三回退）与 `second-term-no-campus`（推算）；7 → `week-markers` 与 `long-warnings`。

## 8. extract.js 桩跑（Node，不联网）

桩脚本与输出在 `C:/Users/23703/AppData/Local/Temp/gdpu-port9/stub.js`，做完删除。桩模拟 `window.location` / `document` / `DOMParser` / `fetch` 与 `__ncSelect`，
记录每个请求的地址与请求体：

| 场景 | 地址（省略 origin） | 结论 |
|---|---|---|
| WebVPN 课表页（查询串带 vpn 片段），`cxRjc` 成功 | `/http/<hex>/kbcx/xskbcx_cxXsgrkb.html?vpn-12-o1-jwsys.gdpu.edu.cn&gnmkdm=N2151`；`…/xskbcx_cxRjc.html?vpn-…&gnmkdm=N2151` 体 `xqh_id=01`；`…/xskbcxZccx_cxZcByXnxq.html?vpn-…&gnmkdm=N2154` | 不调用 `__ncSelect`；`periodTimes` 为数组；`campusChoice` 为 `null` |
| WebVPN 课表页（查询串无 vpn 片段），`cxRjc` 返回 500，桥可用，用户选下标 1 | 三条地址都补上了 `vpn-12-o1-jwsys.gdpu.edu.cn&` | `__ncSelect` 调用一次，参数 `title` 「选择校区」、`items` 两项、`defaultIndex` 0；`campusChoice` 为 1 |
| `cxRjc` 失败，没有提问桥，课表页不在 DOM 中（走课表首页 GET） | 先 `GET …/xskbcx_cxXskbcxIndex.html?vpn-…&gnmkdm=N2151&layout=default`，再三个 POST | 不问校区，`campusChoice` 为 `null`；`calendar` 为 `null`（桩里 `cxZc` 失败） |
| 统一认证页（`/lyuapServer/login`） | 无 | 同步抛「当前打开的是教务登录页…」，0 个请求 |
| WebVPN 首页（`/`，无 kbcx） | 无 | 同步抛「请先进入教务系统、打开课表页后再点「提取课表」」，0 个请求 |
| 非 WebVPN 根路径（`/kbcx/...`） | `https://webvpn.gdpu.edu.cn/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` 等，无 vpn 片段 | 地址不带 vpn 片段；三个 POST 正常 |

所有成功场景的输出都检查过：不含 `FAKE` 字样（学生信息未带出），`raw.kbList` 行只含白名单字段。

**审计修正（2026-10-20，reviewer B2，adversary CONFIRMED）**：`hasPeriodRows`（判断「教务给没给节次时间」、决定问不问校区）认 `kbList` 信封，
`slimRows` 的 `ENVELOPE_KEYS` 却不认，作息接口若返回 `{kbList:[…]}` 会既不问校区、又把教务的节次时间丢成 null。
改为两处共用 `ENVELOPE_KEYS`（含 `kbList`，与 parse.js 一致）；浏览器冒烟 `gdpu-envelope` 场景钉住（用教务的节次时间、不提问）。
同次审计的 B1（教务节次时间非空但不合法时不问校区）被 adversary 驳回：这是任务卡定的口径，按广州、云浮表导入并提醒。

## 9. 已知风险与未验证项

- **没有本校账号，真机未验证。** 以下都是推断，需要用户在真机上跑一次「提取课表」确认：
  - WebVPN 地址形状（`/http/<十六进制>/`）与 `vpn-…` 片段在不同入口下是否稳定；
  - `cxRjc`（菜单 `N2151`）是否存在于本校，返回的字段名（`jcmc` / `qssj` / `jssj`）与格式；
  - 校历接口返回字段（`zs` / `zsmc` / `rq`）；
  - `jcs` 与 `zcd` 的实际写法（本件已覆盖多种常见形态，但没见过真数据）；
  - `xqh_id` 的取值与两个校区的对应关系：本件不认校区号，只在 `cxRjc` 取不到时让用户自己选。
- **校区推断依赖用户。** 若 `cxRjc` 取不到又没有提问桥（例如宿主不支持），节次时间会按广州、云浮表导入，中山校区的同学要在学期管理里改，已写进 warnings。
- **H3 顺推的时间是估的**（课间 5 分钟、每节 45 分钟），与学校实际不一定相同，已写进 warnings。
- **上游的 `isLoginPage` 只看 `href`**：本件额外判 `login_slogin.html`，但没有见过本校的登录页地址形状以外的变体。
- **`parse.js` 的 `BUILTIN_PERIOD_TIMES`** 是模板的空课默认 12 节，只在教务表短于 12 节时使用；本校两张表都是 15 节，所以在本校上它基本不会用到。
- **本件没有请求成绩、学籍、个人信息、缴费。** `cxRjc` 与 `cxZcByXnxq` 是未经本校确认的两个菜单；`extract.js` 对它们的返回也按字段白名单挑（见 §2），
  即使返回里夹带了别的东西也不会带出。真机上仍应看一眼它们的实际返回，确认字段名与上面的推断一致。

签名：0x7E7-2023（haiku 移植，2026-10-20）
