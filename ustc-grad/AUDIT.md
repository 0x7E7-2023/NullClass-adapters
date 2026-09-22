# 安全审计与移植说明：`ustc-grad`（中国科学技术大学·研究生教务）

- **上游出处**：`shiguang_warehouse` 的 `resources/USTC/ustc_01.js`（MIT，上游作者 **hydrofluoric07**），
  同目录 `adapters.yaml` 里 `adapter_id: USTC_01`：

  | id | 名称 | 脚本 | import_url |
  |---|---|---|---|
  | `USTC` | 中国科学技术大学本科教务 | `ustc.js` | `id.ustc.edu.cn` CAS → `jw.ustc.edu.cn`（已移植，`jw-adapters/ustc/`） |
  | `USTC_01` | 中国科学技术大学研究生教务 ← **本件** | `ustc_01.js` | `https://yjs1.ustc.edu.cn/gsapp/sys/yjsrzfwapp/dbLogin/main.do` |

  <https://github.com/XingHeYuZhuan/shiguang_warehouse>
- **上游快照**：`main` @ `fa7cbc2ea116e5ffd082a9fe8cb7bdf4407a8713`（2026-09-22 00:35:28 +0800）
- **移植者**：0x7E7-2023　**日期**：2026-09-22
- **审计结论**：**通过**。脚本里没有任何绝对 URL（`grep -oE "https?://…"` 零命中），
  全部请求都是**相对路径**、落在用户当前页面的同源主机上；不碰凭据、不外发、不埋点、
  不 `eval`/`new Function`、不写页面 DOM（只读一处显示用的学期名 `<label>`）。

## 〇、平台判定

**金智教育 jwapp 平台**（与已移植的 `dlutci`、`neu` 同平台），判据是脚本实际请求的接口路径与
响应信封：

- `/gsapp/sys/kbcxappustc/modules/xskbcx/xnxqxxcx.do`、
  `/gsapp/sys/kbcxappustc/modules/xskbcx/xskbxxcx.do`；
- 响应信封 `{ code: "0", datas: { <key>: { rows: [...] } } }`，与 `dlutci`/`neu` 请求的
  `/jwapp/sys/...` 接口是同一套金智标准信封（`kbcxappustc` 是该校研究生平台的模块前缀，
  不影响信封判定）。

行字段用得很少：`KCMC`（课程名）、`ZCMC`（周次文本）、`PKSJDD`（时间地点文本，
形如 `"教1-101: 1(1,2);西阶2: 3(6,7,8)"`）、`RKJS`（教师，逗号/顿号分隔）。
学期行字段：`DM`（代码）、`MC`（名称）、`ZS`（总周数）、`TYKSRQ`/`QSSJ`/`ZCRQ`（开学日候选字段，
逐个尝试）、`SFDQXQ`（是否当前学期，"1" 表示是）。

**与本科 `ustc`（`jw.ustc.edu.cn`，for-std 平台）是完全不同的两套系统**：不同域名
（`yjs1.ustc.edu.cn` vs `jw.ustc.edu.cn`）、不同接口风格（金智表单 POST + `rows` 信封 vs
for-std 的 `lessonList`/`scheduleList` JSON），只是恰好同校、同一套教务处公布的作息时间表
（13 节制，起止时间逐节相同）。

## 一、请求了哪些域与路径

**只有一个域：`yjs1.ustc.edu.cn`（= `loginUrl` 的主机）。**

`extract.js` 里的两个请求全部是**相对路径**（`/gsapp/sys/...`），落在用户当前打开的页面上，
主机名没有写死在脚本里。

| # | 接口 | 方法 | 用途 | 必需性 |
|---|---|---|---|---|
| ① | `/gsapp/sys/kbcxappustc/modules/xskbcx/xnxqxxcx.do` | POST | 学年学期列表（`DM`/`MC`/`ZS`/开学日候选字段/`SFDQXQ`） | 必须成功（用于选定要导入的学期） |
| ② | `/gsapp/sys/kbcxappustc/modules/xskbcx/xskbxxcx.do` | POST | 学生课表查询（按 `XNXQDM` 过滤，`pageSize=999` 一次取全） | 必须成功（上游唯一的排课接口） |

- 请求都带 `credentials: 'include'`，用的是用户已在 WebView 里登录的会话 Cookie；脚本不读取、
  不存储、不外发任何令牌，也不读 `document.cookie` / `localStorage`。
- `allowHosts` 写 `[]`：两个接口都是相对路径，主机由页面决定，等同于 `loginUrl` 的主机，
  应用会自动把 `loginUrl` 主机并入白名单（与 `dlutci`/`neu` 同一口径）。
- 没有 CAS 域、CDN、统计域、WebVPN 网关；研究生综合服务平台本身就是脚本要操作的唯一域。

## 二、读了什么

- **接口数据**：学期列表（代码、名称、总周数、开学日候选字段、是否当前学期标记）、
  课表行（课程名、周次文本、时间地点文本、教师姓名文本）。都是排课信息。
- **DOM**：只读一处——课表查询页当前显示的学期名（`#xnXqSpan` 或 `h2 > label.bh-form-label`，
  可能在同源 iframe 里），用来在有多个学期时优先选中用户已经切到的那个学期；不读、不写任何
  其它 DOM 节点，不触发点击/提交，不读表单值。
- **输出剔除**：`extract.js` 的 `pickRowFields()` 只从原始课表行里挑出 `KCMC`/`ZCMC`/`PKSJDD`/`RKJS`
  四个字段透出，原始行里若带学号（`XH`）、姓名（`XM`）等字段一律不会进入 `parse.js` 的输入，
  fixture 因此天然脱敏（本身也是合成数据，见第五节）。
- 不读成绩、学籍、缴费、个人信息页；不请求任何与登录人身份有关的接口（上游脚本本身也没有）。

## 三、移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | ✅ 无 password/pwd/登录表单/验证码；不读 `localStorage`/`document.cookie`；只用 WebView 现有会话 Cookie 请求本校接口，令牌不进内存、不外发 |
| 2 | 不外发 | ✅ 全部网络行为就是上表两个请求，均为相对路径 → 落在 `yjs1.ustc.edu.cn`；无 `sendBeacon`/`WebSocket`/`EventSource`/`new Image().src`/动态 `<script>` |
| 3 | 请求域可控 | ✅ 唯一主机 = `loginUrl` 主机，无通配；`allowHosts` 为空数组；脚本源码里没有任何绝对 URL（`grep -oE "https?://…"` 零命中） |
| 4 | 只读课表 | ✅ 两个接口分别是学期列表与课表行，均为取课表所必需；无成绩/学籍/缴费/个人信息接口 |
| 5 | 不埋点 | ✅ 无统计、上报、遥测，无第三方域名 |
| 6 | 不 eval 远程代码 | ✅ 无 `eval`/`new Function`；`JSON.parse` 失败时直接报错（判定为未登录），不会把响应体当代码执行 |
| 7 | 不写页面 | ✅ 无 `innerHTML`/`appendChild`/表单赋值/`submit`/点击/滚动；唯一的 DOM 交互是**只读**当前显示的学期名 |
| 8 | 不依赖用户输入之外的秘密 | ✅ 无硬编码密钥、无他人学号、无固定令牌；学期由接口的「当前学期」标记或页面显示的学期名自动选定 |

## 四、没有移植的东西 / 移植改动（审计应知情）

- **交互改成自动选择**：上游用 `showSingleSelection` 弹窗选学期；本文件按「页面当前显示的
  学期名 → 教务标记的当前学期（`SFDQXQ=1`）→ 列表第一项」的顺序自动选，不弹窗
  （移植手册 §3 第 1 步：用户已经开在目标学期的页面上，让他自己切页面比弹窗更清楚）。
- **【存疑】`firstDay` 按「开学周的周日」而不是「开学周的周一」计算**：上游
  `computeSemesterConfig` 把 `config.firstDayOfWeek` 写死成 `7`（周日），但
  `semesterStartDate` 又是 `mondayOf(...)` 算出来的**周一**。按移植手册 §4.3 的公式
  （`firstDay = 把 semesterStartDate 往前回退到「星期几 = firstDayOfWeek」的那一天`），
  周一往前回退到「星期几=7（周日）」的那一天正好是前一天。本仓库里**本科** `ustc` 适配器
  （`jw.ustc.edu.cn`，for-std 平台，与本件无代码关系）的 `extract.js` 注释也独立写着
  「USTC 一周从周日开始」，两处互相印证，因此本文件按此实现：`firstDay = mondayOf(开学日候选字段) - 1 天`。
  **没有真实教务数据核对过这一天的偏移**——如果日后反馈「课表整体错一天」，这里是第一嫌疑，
  回退方法是去掉 `parse.js` 里 `mondayEpochOf(rawEpoch) - 1` 的那个 `- 1`。
- **周次/时间地点解析不到时不再静默丢课**：上游对「时间分段与周次分段数对不上」用并集顶上
  但不留痕迹、对「解析不出时间地点」「解析不出周次」直接 `return` 跳过且只在 `console.warn`
  里提一句（宿主侧拿不到 `console.warn`）。本文件把这三种情况全部落一条 `warnings`，且用
  不同措辞区分（移植手册 §4.7：不要悄悄丢课）。
- **新增 30 周上限防线**：上游没有这一层；本文件在切周次段之前把超过空课支持上限（30 周）的
  周次丢弃并写 `warnings`，防止极端脏数据（如教务把学年拼错）导致载荷校验直接被拒。
- **教室解析不到时留空（`null`）**：上游默认写死字符串「未知地点」；按移植手册 §4.7
  （空着比写占位字面量好），本文件改成 `null`。
- **未采用考试 / 成绩等接口**：上游脚本本身就没有涉及，无需额外剔除。
- **未使用 `__ncSelect`/`__ncOcr` 等宿主能力**：本适配器纯接口取数，不需要 OCR，也不需要
  弹窗问学期（已用页面显示的学期名/当前学期标记自动决定）。

## 五、已知的取舍与缺口（审计应知情）

- **fixture 是合成的**：按上游脚本实际读取的字段形状（`KCMC`/`ZCMC`/`PKSJDD`/`RKJS` 与学期
  字段）手工编造，只保证「同样的输入永远得到同样的输出」，**不保证真实教务上的解析正确性**——
  见 `docs/jw-adapter-testing.md` §3。拿到真实 dump 后请替换 fixture 并重跑
  `:importer:test`，顺带验证第四节里标记为「存疑」的开学日偏移是否成立。
- **分页**：上游 `xskbxxcx.do` 用 `pageSize=999&pageNumber=1` 一次取全学期课表、不翻页；
  本文件原样保留这个假设（研究生课表数据量通常远小于 999 行）。若日后出现「少课」反馈且
  能确认是分页截断，需要照 `dlutci`/`neu` 那样加循环翻页。
- **`minAppVersionCode` 写 11**：与 `dlutci`/`neu`/`ustc` 一致——本适配器只多写了
  `warnings`，不涉及 `kind:"boxes"`/`kind:"image"` 这类结构性能力，老版本会忽略未知字段，
  导入照样成功，只是少一句提醒。
- **上游更新了怎么办**：这里搬的是 `main @ fa7cbc2` 的快照，不追上游。转换逻辑全部在
  `parse.js`，重搬一遍成本很低——上游修了 bug 时优先重跑移植，而不是打补丁。

## 六、fixture 有效性验证（本地，未跑 CI 之前）

用 Node 的 `vm` 模块当 Rhino 的替身跑 `parse.js`，对两份 fixture 各做一次逐条改坏 → 重跑的
变异测试，确认**新用例不是摆设**：

| 改坏了什么 | 变红的用例 |
|---|---|
| 关掉 `parseWeekText` 的单/双周过滤（`单`/`双` 一律当全周） | `basic`（「学术英语」EVEN 周次塌成 ALL） |
| 去掉 `firstDay` 的「周一 → 周日」回退（第四节存疑项本身） | `basic`、`edge`（两份 `firstDay` 都整体偏一天） |
| 关掉 30 周上限过滤 | `edge`（「科研伦理研讨」多出 31/32 周，`totalWeeks` 超出规范上限） |
| 强制永远只走「`weekSegs.length===1`」分支（绕开分段数不一致的并集分支） | `edge`（「学科前沿讲座」不再产出「时间分段与周次分段数不一致」告警） |

四处改坏均能让对应 fixture 变红，且改坏前后 `parse.js` 逐字节一致（`sha256sum` 相同），
说明两份 fixture 确实在盯着各自覆盖的那条逻辑，不是「跑通就存」。

`basic` 覆盖：连续周次（`1-16周`）、单/双周文本标记在括号里（`(双)`）、多段离散周次
（`1-3,5-9,11周` 切出 3 个 ALL 段）、时间地点与周次一一对应的多段课（2 个不同教室/星期）、
节次边界（第 1 节起、第 13 节末）、多教师（顿号合并）与空教师（留空不写「未知」）。

`edge` 覆盖：时间分段数与周次分段数不一致时的并集告警、空时间地点文本、空周次文本、
周次超过 30 周上限的丢弃告警——四条全部落在 `warnings` 里，不静默丢课。

ES5 自检：`grep -nE "=>|\`|\blet |\bconst " extract.js parse.js` 无输出；NUL 字节计数为 0。
