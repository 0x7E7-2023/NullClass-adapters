# 曲靖师范学院（qjnu）适配器审计

## 出处

- 上游：`shiguang_warehouse` 的 `QJNU/qjnu.js`（MIT，维护者 ZGxudQ），仓库 https://github.com/XingHeYuZhuan/shiguang_warehouse
- 上游快照：`f83288e`（2026-11-24 重新克隆）；本校脚本最后一次修改 `29fd297`（2026-11-21）。快照目录只读，未改动。
- 平台：金智 jwapp，「我的课表」`wdkb` 模块（`/jwapp/sys/wdkb/modules/...`，请求相对路径，同源）。
- 模板：`hebau`（河北农业大学，金智 wdkb，批次三十六审过）。选它不选 `sany`：二者同平台，但 hebau 的提醒出口、H3 顺推、节次校验、
  学期 / 校历回落与「审计真抓到过的错」五类常见项都已对齐，`sany` 的周次解析还没有单双标记的完整用例。

## 与模板不同构之处（逐层）

| 层 | 模板 hebau | 本校 qjnu | 处理 |
|---|---|---|---|
| 学期 | 读 `dqxnxq`，列表 `xnxqcx` 核对 | 同（上游的选学期弹窗改为读当前学期，不弹窗） | 沿用 hebau 结构 |
| 课表 | `cxxszhxqkb` 一张表 | `cxxszhxqkb`（必需）+ `syjxkcb/cxsyjxxskb` 实验课 + `xskcb/xsdkkc` 调课记录 | 新增两个可选请求与调课应用 |
| 实验课名 | 无 | `KCM` 与 `SYXMMC` 用 ` - ` 连接成课名（上游同） | 新增 |
| 调课 | 无 | 按 `KBID + 星期 + 节次` 找原课，按 `SKZC` 旧周次取交集，`01`/`03` 生成新课位，`02` 停课；接口倒序，先应用旧的（上游同） | 新增，`changeUnknown / changeUnapplied / changeNewMissing` 提醒 |
| 周次 | 位串（只认字符 1） | 同位串；另外「全周」「全部」展开到 `max(20, 全部行的最大周)`（卡要求；上游遇非位串会整次报错） | 新增展开规则；认不出的写法按原文分组提醒 |
| 校历 | `cxxljc` | `jshkcb/cxjcs`（上游接口），字段 `XQKSRQ / ZZC / ZJXZC` 同 | 沿用，`XN/XQ` 由学期编号拆出（上游优先取 `XNDM/XQDM`，正常取值一致） |
| 节次时间 | `jc` | `jshkcb/jc`，上游内置默认表（10 节）兜底 | 默认表逐节照抄（见下） |
| 合并 | 同课同键取并集，连堂分段 | 同键段「下一段开始 ≤ 上一段结束 + 1」合并 | 比上游（只认 +1 相邻）宽，卡要求 |

### 请求清单（与代码一致；全部 POST、同源、相对路径、`credentials: same-origin`、`redirect: manual`）

| # | 地址（`/jwapp/sys/wdkb/modules/` 之后） | 请求体 | 用途 | 取不到时 |
|---|---|---|---|---|
| 1 | `jshkcb/dqxnxq.do` | 空 | 当前学年学期 DM / MC | 按本机日期推定（学期编号）；parse 写提醒 |
| 2 | `jshkcb/xnxqcx.do` | `*order=-DM` | 学期列表，核对当前学期是否在列表内 | 交 `listed: null`，不写提醒（空列表证明不了「不在」） |
| 3 | `jshkcb/cxjcs.do` | `XN=<学年>&XQ=<学期>` | 校历：开学日、总周数 | 交 `[]`；开学日回落本机日期所在周的周一，总周数回落 20，均提醒 |
| 4 | `jshkcb/jc.do` | 空 | 节次时间 DM / KSSJ / JSSJ | 交 `[]`；用上游默认表并提醒 |
| 5 | `xskcb/cxxszhxqkb.do` | `XNXQDM=<学期编号>` | 整学期课表（必需） | 报「没能读到课表数据」或登录过期提示，整次导入失败（不静默） |
| 6 | `syjxkcb/cxsyjxxskb.do` | `XNXQDM=<学期编号>` | 实验课（可选） | 交 `null`，提醒「没能读到实验课安排」 |
| 7 | `xskcb/xsdkkc.do` | `XNXQDM=<学期编号>&*order=-SQSJ` | 调课记录（可选） | 交 `null`，提醒「没能读到调课记录」 |

`allowHosts` 为 `[]`：所有请求都是当前页面同源的相对路径，不请求别的主机。`loginUrl` 是 `https://jw.qjnu.edu.cn/jwapp/sys/emaphome/portal/index.do`（上游 `import_url`），
它是门户页，与课表页同源、同在 `/jwapp/` 下，门户页照上游放行，可以直接导入（请求仍是同源相对路径）。

### 不发请求的页面（页面判断在 `extract.js` 的 `pageProblem`）

判断只看 `pathname`（不看整个 href，避免 `?loginFrom=portal` 这类查询串误判）：
1. 主机不是 `jw.qjnu.edu.cn`：提示先打开教务网页，零请求；
2. 路径含 `login`，或页面有 `input[type="password"]`：登录页，给「当前打开的是登录页…」提示，零请求；
3. 路径不以 `/jwapp/` 开头：提示先登录并进入教务页面，零请求；
4. 其余（含门户页、带查询串的课表页）放行。

请求被踢回登录页（重定向、401 / 403）或返回非 JSON 时，统一报「登录已失效，请重新登录后打开「我的课表」再提取」。

## 读了什么、交出去什么（逐字段白名单）

extract 只保留下列字段，其余（含 `XH` 学号、`XM` 姓名、`SFZH` 身份证号、`SJH` 手机号、人员 ID 等）一律不带出：

- `rows` / `experimentRows`：`KBID`（排课记录编号，用于调课匹配，不是人员标识）、`KCM`、`SYXMMC`、`SKJS`（教师）、`JSM`（教师，上游回落）、`JASMC`（教室）、`SKXQ`、`KSJC`、`JSJC`、`SKZC`、`KSSJ`、`JSSJ`；
- `changeRows`：`KBID`、`TKLXDM`、`SKXQ`、`KSJC`、`JSJC`、`SKZC`、`XSKXQ`、`XKSJC`、`XJSJC`、`XSKZC`、`XKSSJ`、`XJSSJ`、`XSKJS`、`YSKJS`、`XJASMC`、`JASMC`；
- `calendarRows`：`XN`、`XQ`、`XQKSRQ`、`ZZC`、`ZJXZC`；
- `sectionRows`：`DM`、`KSSJ`、`JSSJ`；
- `term`：`code`、`name`（MC）、`source`、`listed`；`today`（本机日期）。

桩与冒烟里的假数据都塞了个人字段，断言它们不出现在 extract 输出与 payload 里（`smoke.py` 的 `SECRETS` 检查）。

## 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读 `password` 值、不读 `localStorage`、不读令牌。`input[type=password]` 只用来判断是不是登录页（只查存在性，不读值）。请求只靠同源会话 Cookie。 |
| 2 | 不外发 | 通过。全文只有一处 `fetch`（`post`），目标是 `MODULES + path`，同源。无 XHR、`sendBeacon`、WebSocket、图片外链。 |
| 3 | 请求域可控 | 通过。`allowHosts: []`，全部请求相对路径。 |
| 4 | 只读课表 | 通过。7 个接口全部是课表 / 校历 / 节次 / 学期 / 调课的只读查询；不请求成绩、学籍、缴费。 |
| 5 | 不埋点 | 通过。无统计、上报、遥测。 |
| 6 | 不 eval 远程代码 | 通过。无 `eval`、`new Function`。 |
| 7 | 不写页面 | 通过。不写 DOM、不改表单、不提交、不点击。 |
| 8 | 不依赖输入之外的秘密 | 通过。无硬编码学号、密钥、令牌。 |

审计用的静态扫描（上游快照 `qjnu.js`）：绝对 URL 只有 `https://jw.qjnu.edu.cn` 一处（上游 `origin` 常量）；移植件里没有绝对 URL。

## 与模板的差异（完整）

1. 请求顺序与上游一致但串行（上游 `Promise.all` 并发）；请求体与端点不变。
2. 当前学期只读 `dqxnxq`，不读页面上的学期选择器；上游的选学期弹窗不移植。拿不到就推定，并提醒。
3. 位串之外的周次文字：「全周」「全部」展开；其它认不出的写法按原文分组提醒并跳过，不整次报错（上游遇非位串直接 `throw`）。
4. 全 0 位串（没有上课周）与空白行静默跳过（上游同）；有课名但星期 / 节次不合法的行计入「数据不全」提醒（上游整次报错）。
5. 上游的自定义上课时间（`isCustomTime`）不带进课表：按 porting §4.4「有节次就按节次放入」，与节次时间不同的课程名写进提醒。
6. 节次超出节次时间表：按统一修订 H3 逐节顺推并提醒（上游是弹确认框让用户决定）。
7. 校历缺失、开学日非周一、学期总周数超过 30：全部进提醒（上游静默回落到周一，或弹框）。
8. 提醒统一出口：按类型汇总、课名截 20 字、整条 ≤ 200 字；超过 20 条时保留前 19 条加「另有 N 条核对提示超出上限未显示」，N 等于实际没显示的条数（模板的汇总行会覆盖第 20 条，本版不覆盖）。

## 上游里删掉或改掉的东西及理由

- 拾光弹窗（`bridge.showSingleSelection` / `showAlert` / `savePresetTimeSlots` / `saveCourseConfig` / `saveImportedCourses`）与 `native.showToast` / `notifyTaskCompletion`：移植件只交数据，保存与提示由宿主完成。
- `window.__qjnuWebImportRunning` 互斥锁：宿主侧只跑一次，不再需要。
- 上游 `maxWeeks = 60`：应用的学期总周数上限是 30，改为超过 30 时钳到 30 并提醒。
- 上游「部分教务信息未取得」确认框：改为 warnings（拿不准一律进提醒，不靠弹框让用户点确认）。
- 上游的 `ALERT` 文案「可能已部分更新，请重新导入」：宿主负责保存，移植件不写库，此句不适用。

## 节次时间（逐节对照上游 `defaultTimeSlots`，`parse.js` 的 `DEFAULT_SECTIONS`）

| 节 | 开始 | 结束 | 节 | 开始 | 结束 |
|---|---|---|---|---|---|
| 1 | 08:30 | 09:15 | 6 | 15:25 | 16:10 |
| 2 | 09:25 | 10:10 | 7 | 16:30 | 17:15 |
| 3 | 10:30 | 11:15 | 8 | 17:25 | 18:10 |
| 4 | 11:25 | 12:10 | 9 | 19:30 | 20:15 |
| 5 | 14:30 | 15:15 | 10 | 20:25 | 21:10 |

取不到教务节次表（为空、有冲突、前后倒挂、不从 1 起连续）→ 用这张表，并提醒「已改用默认的节次时间」。

## 本校专属边界（fixtures，共 7 对）

| fixture | 覆盖 |
|---|---|
| `basic` | 多门课、连堂合并（1-2 + 3-4 → 1-4）、单双周位串（ODD）、括号备注教师（张老师（外聘）→ 张老师）、教师 / 教室占位词（未知 / 待定 → null）、教室「1-101」不当周次、实验课并入（大学物理 - 力学实验）、缺星期行（星期 0）、全 0 空行、完全重复行去重 |
| `weeks-bitmap` | 「全周」展开到 max(20, 全部行最大周)=31 后截到 30、「全周」不铺满 30 周以外、单周 / 双周位串、认不出的写法「第1-8周」提醒并跳过、第 31 周位串丢弃并提醒 |
| `changes` | 调课 01 挪到新课位（周次切分、新课位带原教师、新教室）、停课 02 去掉整门、找不到原课的 03、类型认不出的 09 进提醒 |
| `sections-fallback` | 节次表为空用默认表并提醒；课表用到第 12 节，第 11-12 节按 H3 顺推（21:15-22:00、22:05-22:50）并提醒；上课时间 08:40 与节次 08:30 不同，按节次放入并点名 |
| `no-calendar` | 校历为空：开学日按本机日期 2026-11-03（周二）所在周的周一推算为 2026-11-02 并提醒；总周数回落 20，第 24 周的课把总周数抬到 24 并提醒 |
| `long-warnings` | 10 门超长课名（29 字）缺教师缺教室，提醒里点名的课名截到 20 字；认不出的周次原文 52 字截到 20 字；整条 ≤ 200 字 |
| `overflow` | 21 种认不出的周次写法，显示前 19 条加「另有 2 条核对提示超出上限未显示」，确认第 20 条不被覆盖 |

每对的期望值都是按规则手工推出来的（见上表的对应关系），跑 `check.js` 时全部 MATCH，没有用 parse 输出反推。

## 冒烟（`.test/port-batch38/qjnu/smoke.py`）

`python -I -X utf8 smoke.py all`，使用本机 Edge（`NC_PW_CHANNEL=msedge`，Playwright 自带的 Chromium 未装，未联网安装）。
Playwright 拦截到假教务站，真实执行 `extract.js`，再交 Rhino 跑 `parse.js`。结果 12/12 OK（含本轮新增的 `portal`、`login-query`、`login-path`）：

- `normal`：7 个 POST 地址与请求体与上表逐条一致；字段白名单、零个人信息。
- `login`、`login-path`、`other`：零请求，给大白话提示（登录页 / 非 /jwapp/ 页面）。
- `portal`：门户页照常导入，7 个请求全部发出。
- `login-query`：课表页地址带 `?loginFrom=portal` 照常导入。
- `no-term`：学期推定为 2026-2027-1（2026-11-03 的推算）并提醒。
- `no-terms`：学期列表为空不怪列表。
- `sections500`：节次接口 500，用默认表并提醒。
- `optional-fail`：实验课、调课记录 500，课表照常导入，并分别提醒。
- `courses-login`：课表接口返回 HTML，报「登录已失效，请重新登录后打开「我的课表」再提取」，不导入。
- `empty`：课表为空，解析阶段报「没有解析到任何课程」。

## 变异测试（在临时副本上改坏 `parse.js` 一处，源目录未改动）

1. 周次位串保留第 31 周（`bitmap-keep-31`）→ `weeks-bitmap` DIFF。
2. 连堂合并去掉 `+1` 相邻条件（`merge-no-adjacent`）→ `basic` DIFF。
3. 单双周 ODD / EVEN 对调（`odd-even-swap`）→ `basic`、`weeks-bitmap` DIFF。
4. 停课（02）也生成新课位（`cancel-gets-replacement`）→ `changes` DIFF。
5. 提醒溢出保留 20 条而不是 19 条加汇总（`overflow-keep-20`）→ `overflow` DIFF。

每一处改坏后 check 都变红；源目录的 check 复跑为 PASS。

## 页面 / 路径的未验证项（诚实说明）

- 我们没有本校账号，真机没验过。`scheduleUrlHint` 写的是金智常见的 `/jwapp/sys/wdkb/*default/index.do`，**未确认**本校「我的课表」的真实地址，需要真机复核。
- `pageProblem` 只要求主机为 `jw.qjnu.edu.cn`、路径在 `/jwapp/` 下且不含 `login`；与上游的 `/jwapp/` 前缀口径一致。若本校某个非课表的 `/jwapp/` 页面也能发出这些请求，会照常导入，这一点真机需确认。
- 当前学期读的是教务的 `dqxnxq`；页面上用户切换过的学期不会被读到。上游也没读页面选择器（它弹窗让用户选）。
- 调课的字段名（`TKLXDM`、`XSKZC` 等）来自上游代码，没有真实调课样本验证；fixtures 是合成的。
- 上游的 `maxWeeks = 60` 被改为 30（应用上限），学期超过 30 周的学校会被钳制并提醒。

## 行号

AUDIT 中引用代码处均按函数名（`pageProblem`、`post`、`buildCourse`、`readSections`、`limitedWarnings` 等），不用行号。

0x7E7-2023（haiku 移植，2026-11-24）
