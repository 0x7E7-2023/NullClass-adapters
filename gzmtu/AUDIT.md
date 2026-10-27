# 安全审计 —— 广州航海学院（正方教务新版 jwglxt，上下文路径 /jwglxt，http 直连教务主机）

审计对象：`jw-adapters/gzmtu/` 下的 `extract.js` / `parse.js` / `manifest.json` / `fixtures/`，以及它们移植自的上游脚本
`shiguang_warehouse` 的 `GZMTU/gzmtu.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取，MIT，作者 weiwei221206；
本校脚本最后一次修改 `80e30cf`，2026-09-23）。上游同目录 `adapters.yaml` 的 `import_url` 与 `maintainer` 与此一致。

审计方式：逐行读上游脚本与移植件；对 `extract.js` 用 Node 桩（假 `window` / `fetch` / `DOMParser`，不联网）跑 8 个场景，
确认拼出的每个地址、请求体与交出去的形状（见 §8）；`parse.js` 在 Rhino 1.8.0 下实跑全部 fixture（自检 `check.js`）；变异测试见 §6。

静态扫描结果（2026-10-20 运行）：

- 绝对 URL：`extract.js` 与 `parse.js` 的文件头各有上游出处的 `https://github.com/XingHeYuZhuan/shiguang_warehouse`（注释）。
  `extract.js` 文件头第 ③ 条注释里写了上游的主机 `http://jwx.gzmtu.edu.cn`（说明上游把它写死），代码里没有任何绝对地址。
- 网络调用：只有 `extract.js` 的 `request` 函数里的 `fetch(url, options)`。`X-Requested-With` 是请求头字符串，不是 XHR 对象。`parse.js` 没有任何网络调用。
- 凭据、本地存储、动态执行、写页面：`password` / `passwd` / `localStorage` / `sessionStorage` / `document.cookie` / `eval` / `new Function` /
  `sendBeacon` / `new WebSocket` / `new Image` / `innerHTML` / `appendChild` / `.submit(` 全部无命中。`parse.js` 里没有 `document.` / `window.` / 桥调用。
- 模板件字样：`parse.js`、`extract.js`、`manifest.json`、`fixtures/` 检索「河北 / hueb / HUEB / Haooz / vpn / 202-206 / 8118 / lcudcc / jsei」，零命中。
- ES5：`=>`、反引号、`let `、`const ` 在两个脚本全文（含注释）零命中；`check.js` 的 ES5 / 控制字节 / BOM 检查通过。

## 0. 上游问题与我们的处理

- 上游 `fetchAcademicOptions` 的 `window.location.origin` 写法没问题，但它取不到选项时**凭当前年份猜学年**（`selectAcademicYearAndSemester` 的「智能学年预测」兜底，学期码写死 `"3"` / `"12"`）。
  移植件**不照搬**：页面读不到 `#xnm` / `#xqm` 就去取一次课表首页读同样的下拉框，还是读不到就报错。猜出来的学期会整学期错位，不如直接说清楚（见 §5）。
- 上游 `fetchAndParseCourses` 算了 `maxWeek` 却没用到，总周数直接写死 `semesterTotalWeeks: 20`。移植件照上游的 20 周作缺省，但课表里更晚的周次会抬高总周数并写进 `warnings`（`parse.js` 的 `totalWeeks` 段）。
- 上游 `promptUserToStart` 的开场弹窗、`saveImportedCourses` / `saveCourseConfig` / `savePresetTimeSlots`、`showToast`、`notifyTaskCompletion` 都是「拾光」的桥能力，空课不移植（适配器只交载荷）。

## 1. 请求域与请求清单（与代码逐条对应）

上游脚本的四个请求地址（学年学期首页 GET、课表 POST、课表备用 `xskbcx_cxXsKb` POST、学期周次校历 POST）主机都是 `http://jwx.gzmtu.edu.cn`（无端口、无 WebVPN 前缀），另有一张写死的 10 节表。
移植件把主机全部去掉：所有地址由 `window.location.origin` 拼出来（`extract.js` 的 `jwBase`），上下文路径默认 `/jwglxt`；
若当前地址里含 `/jwglxt/`，则跟着那一段走（挂在前缀下的部署也能用）。

- **`allowHosts` 为空数组**：所有请求都是当前教务主机的同源地址，没有任何第三方域，也不需要放行额外主机。
- `loginUrl` 与 `scheduleUrlHint` 都是课表页 `http://jwx.gzmtu.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`（照上游 `import_url`）。
  没登录时教务会自己跳登录页，脚本里的 `onLoginPage`（判断路径含 `login_slogin.html`）会给出「请先登录」提示、不发请求。

| 谁 | 方法 | 地址 | 干什么 | 取不到时怎么办 |
|---|---|---|---|---|
| extract.js `currentTerm` | GET | `<origin>/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读课表页上 `#xnm` / `#xqm` 的学年学期（**页面上已有就不发**） | 报错「没读到学年学期……请重新登录并打开课表页后再点「提取课表」」 |
| extract.js `fetchTimetable` | POST | `<origin>/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`，体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数 | 网络错误或非 2xx → **打备用**（下一行）；2xx 但不是课表 JSON → 报「没有返回课表数据」，**不回落**（照上游 `!resp.ok` 才回落） |
| extract.js `fetchTimetable`（仅主接口失败时） | POST | `<origin>/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151`，体与上一行相同 | 课表备用接口（上游回落用的第二个地址） | 备用也网络错误或非 2xx → 报「教务系统返回错误（代码 N）」或「连不上教务系统」，带状态码 |
| extract.js `optionalJson` | POST | `<origin>/jwglxt/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151`，体 `xnm=…&xqm=…&xqh_id=<课表行里的校区号>` | 取校区节次时间（作息）。上游没有这个请求，移植件多取一条 | 任何失败（非 2xx、网络错误、JSON 解析失败）都交 `null`，parse 回落到上游 10 节表并写进 `warnings` |
| extract.js `optionalJson` | POST | `<origin>/jwglxt/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`，体 `xnm=…&xqm=…` | 学期周次校历，定开学日与总周数（上游本来就取） | 任何失败交 `null`，parse 按推算开学日、20 周并写进 `warnings` |

与上游的差别：

- **备用接口**：上游 `fetchAndParseCourses` 在 `!resp.ok` 时打 `xskbcx_cxXsKb`，移植件照做（`fetchTimetable` 的 `.then(null, …)`）。
  主接口 2xx 但内容不是课表 JSON 时**不**打备用，与上游一致；这种情况报「登录状态可能已失效」。
- **学年学期**：上游弹两个选择框（选项来自课表首页、失败时用猜的学年）。移植件不弹窗，读页面上的下拉框（被 `selected` 标的项优先，没有就第一项）。
  要导入别的学期，用户在教务页面里切一下再点「提取课表」。
- **作息请求（cxRjc）**：上游没有。菜单号用 `N2151`（课表菜单本身），与同族正方脚本的写法一致（`WENHUA/wenhua_01.js` 的注释里写过这个约定）。
  **这一条是按同族约定推断的，我们没有本校账号，真机上是否存在这个接口未验证**，取不到就回落，不影响导入（见 §9）。
- 请求头统一带 `Content-Type`、`X-Requested-With`、`Accept`；凭据用 `credentials: 'include'`，由 WebView 按同源规则带 Cookie。脚本既不读 Cookie，也不把它发到别处。
- `parse.js` 不发任何请求。

## 2. 读了什么、交出去什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 的值与下拉框文本） | 课表页的 `#xnm` / `#xqm`，或课表首页 HTML（`DOMParser` 离线解析，不插入当前页面） | 带出（学期名要用） |
| 排课行 `kbList` | 课表接口 | 白名单 `KB_FIELDS`：`kcmc`、`kcmc_raw`、`xm`、`cdmc`、`xqj`、`jcor`、`jcs`、`jc`、`zcd`、`xqh_id`。`kcmc_raw` / `jcor` / `jc` 是上游的兜底字段名；`xqh_id` 是校区号，只用来拼作息请求，任务卡要求随行交出，不含个人信息 |
| 集中实践课 `sjkList` | 课表接口 | 只带 `kcmc`（`PRACTICE_FIELDS`）。没有固定星期与节次，排不进周课表，但不能吞掉：写进 `warnings` 让用户自己加 |
| 校区节次时间 | cxRjc | 带出原始 JSON（parse 的 `periodTimesOf` 按 `jcmc` / `qssj` / `jssj` 认），取不到为 `null` |
| 学期周次校历 | cxZcByXnxq | 带出原始 JSON，parse 只用来算开学日与总周数，不进载荷 |
| 记录总数（响应里有才有） | 课表接口 | 只用于对账，不进载荷 |

**不带出**：`xsxx`（学生信息）、学号、姓名、学院、`cd_id`（场地编号，任务卡点名不带）、以及课表响应里其它一切字段。
§8 的桩跑里，响应夹带了 `xsxx`、`xh`、`kkdw`、`cd_id`，交出去的 JSON 里一个都没有。

## 3. 移植手册 §5 八条逐条结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。脚本不读 `password`、不读表单值、不读任何 token；只读 `#xnm` / `#xqm` 下拉框的值。`credentials: 'include'` 只是让浏览器带 Cookie，脚本读不到也不外发 |
| 2 | 不外发 | 通过。所有地址由 `window.location.origin` 拼出，只打本校教务同源地址；代码里没有任何第三方域 |
| 3 | 请求域可控 | 通过。`allowHosts: []`，不写通配。教务主机就是 `loginUrl` 的主机，与 `allowHosts` 无关 |
| 4 | 只读课表 | 通过。请求的接口只有课表（`xskbcx_cxXsgrkb`、`xskbcx_cxXsKb`）、作息（`xskbcx_cxRjc`）、周次校历（`xskbcxZccx_cxZcByXnxq`）与课表首页。没有成绩、学籍、缴费、个人信息接口；响应按字段白名单挑 |
| 5 | 不埋点 | 通过。没有统计、上报、遥测 |
| 6 | 不 eval 远程代码 | 通过。`eval` / `new Function` 无命中；`JSON.parse` 只解析教务返回的数据 |
| 7 | 不写页面 | 通过。不写 DOM、不改表单、不提交。课表首页 HTML 用 `DOMParser` 离线解析，不插入当前页面 |
| 8 | 不依赖输入之外的秘密 | 通过。没有硬编码的密钥、学号或令牌；fixtures 全部是合成数据，课程名、教师名、教室名均为虚构 |

## 4. 与模板 hueb 的差异（模板目录只读，本件未改动模板）

| 层 | 模板 hueb | 本件 gzmtu | 原因 |
|---|---|---|---|
| 主机与路径 | WebVPN 映射主机 + 端口 8118，同源拼接 | 同源拼接，`http://` 直连，无端口、无前缀 | 任务卡：`jwx.gzmtu.edu.cn` 直连 |
| 课表接口 | 单一主接口 | **主接口 + 备用接口 `xskbcx_cxXsKb`**（主接口网络错误或非 2xx 才打） | 任务卡 §与模板不同构 1，照上游 `!resp.ok` 回落 |
| 课名字段 | `kcmc` | `kcmc`，没有就 `kcmc_raw` | 上游 `parseJsonData` 兜底 |
| 节次字段 | `jcs` | `jcor` → `jcs` → `jc`（取第一个非空） | 上游 `parseJsonData` 兜底 |
| 节次取数 | 取最小值与最大值（模板已如此） | 不变，`4-3` 读成 3-4 | 与上游「取最小值与最大值」一致 |
| 教室 | `cdmc` | `cdmc`（不用 `cd_id`） | 上游 `cdmc || cd_id` 改掉，见 §5 |
| 白名单 | 7 个字段 | 10 个字段（增 `kcmc_raw`、`jcor`、`jc`） | 兜底字段 |
| 作息内置表 | 上游 13 节 | 上游 10 节（`SCHOOL_PERIOD_TIMES`，逐节照抄） | 本校上游写死 10 节 |
| 作息 H3 补齐表 | 空课默认 12 节 | 不变（同一张 12 节默认表） | 统一修订 H3 的口径，模板与本件都用它 |
| 学期名兜底 | 河北经贸大学 | 广州航海学院 | 学校名 |
| 周次解析 | 四写法全认 | 不变；本件 fixtures 额外钉住全角逗号与无「周」字 | 任务卡 §与模板不同构 3，模板已能吃下，用例补齐 |
| 登录页判断 | `login_slogin.html` | 不变 | 任务卡：上游没有别的入口特征 |
| 文件头、作者、manifest | 河北经贸大学 / Haooz | 广州航海学院 / weiwei221206 | 署名按上游公约保留 |

## 5. 上游里删掉 / 改掉的东西及理由

- **猜学年的兜底**（`selectAcademicYearAndSemester` 里「智能学年预测」，学期码写死 `"3"` / `"12"`）：删。猜错了整学期错位，且用户看不出来。
  改为读页面下拉框；读不到就报错，请用户打开课表页。
- **`cd_id` 回落为教室**（`position = rawCourse.cdmc || rawCourse.cd_id`）：改。`cd_id` 是场地编号，不是给人看的教室名，拿它当教室会在课表上显示一串数字。
  `cdmc` 为空就是「缺教室」，按类型汇总提醒，允许 `location` 为 `null`。`cd_id` 不进白名单，parse 也不读它（§8 桩跑、§6 变异 M2 都验过）。
- **严格过滤**（`!courseName || !day || !zcd || !jcStr` 之外，还有 `!xm || !cdmc` 整行丢弃）：改。缺教师或缺教室的课照常导入（值为 `null`），按类型汇总提醒。
- **写死的 `semesterTotalWeeks: 20`**：保留为缺省值，但校历给出总周数时用校历，课表更晚的周次会抬高总周数并说明。
- **弹窗与桥调用**（`showAlert`、`showSingleSelection`、`saveImportedCourses`、`saveCourseConfig`、`savePresetTimeSlots`、`showToast`、`notifyTaskCompletion`）：不移植。这些是「拾光」的桥能力，空课由宿主保存，适配器只交载荷。
- **`maxWeek` 计算后未使用**：不移植（没有用）。
- **作息内置表**：照抄上游 10 节，不改值；上游只在导入成功后存成预设，移植件改为随载荷交出（取不到教务作息时才用它，并写进 `warnings`）。

## 6. 变异测试记录

在 `C:/Users/23703/AppData/Local/Temp/gzmtu-port9/mut/` 下的临时副本上各改坏一处，跑 `check.js`，然后丢弃副本（真实文件未改动，改后自检 PASS 不变）：

| 编号 | 改坏哪一处（parse.js） | 改成什么 | 变红的用例 |
|---|---|---|---|
| M1 | H3 补齐里的 `builtinSlot` 判断（`if (builtinSlot && minutesOf(builtinSlot.start) >= prevEnd)`） | `>` 严格大于 | `basic` DIFF（第 11 节本应用内置表的 20:20-21:05，改后变成顺推） |
| M2 | 教室读取（`var location = text(row.cdmc);`） | 回落到 `text(row.cd_id)` | `missing-fields` DIFF（航海气象的教室变成 `A-0912`） |
| M3 | 「共 N 周」备注剥离（`cleaned.replace(/共\s*[0-9]+\s*周?/g, '')`） | 改回上游的贪婪删到行尾 | `week-markers` DIFF（「1-8周(共8周),9-16周」的 9-16 周被吞） |
| M4 | 课名读取（`var name = text(row.kcmc) \|\| text(row.kcmc_raw);`） | 去掉 `kcmc_raw` 回落 | `missing-fields` DIFF（只有 `kcmc_raw` 的课整行丢掉） |

每一处都有至少一条用例变红；四个副本都已丢弃，真实 `parse.js` 与自检 PASS 不变。

## 7. fixtures 与自检

共 8 对，全部是合成数据（`_note` 里写明），期望值按规范与代码规则手工推出（开学日、节次时间、周次切段、单双周、warnings 文本），
再与 `parse.js` 实跑结果比对，没有把输出直接存成期望：

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 节次时间接口取不到 → 上游 10 节逐节钉住（第 1 节 08:10-08:55、第 9 节 18:40-19:25）；课表排到第 11–12 节 → 内置表接得上，用它；第 13–14 节 → 顺推；校历取不到 → 推算开学日、总周数 20；单双周；缺教师、缺教室；完全重复行；集中实践课 |
| `merge-consecutive` | 同课同日同教室 1-2 + 3-4 → 1-4；同节次不同周次 1-8 与 9-16 → 周次并集；完全重复行只留一条；周次不同的另一门课不合并 |
| `calendar-weekday` | 校历第 1 周给周三 2026-09-09 → 回退到周一 2026-09-07；教务作息 10 节（与内置表不同）→ 用教务的；周次 2-18 双周 → 总周数取校历 18 |
| `no-calendar-overweek` | 校历与作息都取不到，第二学期 → 推算 2027-02-15；课表最大周次 21 → 总周数抬到 21 并说明 |
| `long-warnings` | **本校专属**：长课名（23 字）同时缺教师、缺教室 → 照常导入，提醒按类型汇总、点名课名截到 20 字；两行认不出的周次（「未排周次」「第十六周起」）；四门集中实践课，点名截断，每条 ≤200 字 |
| `missing-fields` | **本校专属**：只有 `kcmc_raw` 的课；只有 `jcor` 的课（3-4）；只有 `jc` 的课（5）；`jcs` 写成 `4-3` → 3-4；`cdmc` 空、带 `cd_id` → 教室为 null 且不出现 `cd_id`；`xm` 缺失 → 教师为 null |
| `week-markers` | **本校专属**：全角逗号 `1-8,10，12-16`；无「周」字 `1-16`；单周 `3`；前缀 `(单)1-8周,(双)9-16周`；后缀 `1-8周(单),9-16周(双)`；`1-15周(单) 共16周`；`共16周,1-15周(单)`；`1-8周(共8周),9-16周` |
| `api-second-term` | 第二学期；教务作息 12 节与校历都取到；开学日回退周一（周三 2027-02-17 → 2027-02-15）；记录总数对账（说 12 条、实际 6 行）；脏行（缺星期 / 缺节次 / 缺周次）；节次多段 `1-2,5-6`；周次 0 与 31 各丢一个、29-30 与 1-5 并集；课表排到第 30 周，顶高总周数（校历 20） |

自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/gzmtu` 最后一行是 `RESULT: PASS`，8 对 fixture 全部 MATCH，ES5、控制字节、BOM、allowHosts 检查通过。

## 8. extract.js 桩跑记录

桩脚本：`C:/Users/23703/AppData/Local/Temp/gzmtu-port9/stub-run.js`（不联网，`vm` 里跑 `extract.js`，假 `window.location.origin` 为 `http://jwx.gzmtu.edu.cn`）。
每个场景拼出的地址与请求体（逐个列）：

| 场景 | 实际发出的请求（按顺序） | 结果 |
|---|---|---|
| A 主接口 2xx | POST `…/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` 体 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=`；POST `…/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151` 体 `xnm=2026&xqm=3&xqh_id=01`；POST `…/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` 体 `xnm=2026&xqm=3` | 成功，不打备用 |
| B 主接口 500 | 主接口 500 → POST `…/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151` 体同主接口；再打 Rjc、Zc | 成功，打了备用 |
| C 主接口网络错误 | 主接口 reject → POST `…/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151` 体同上；再打 Rjc、Zc | 成功，打了备用 |
| D 两个都失败（500 / 503） | POST `xskbcx_cxXsgrkb` 与 POST `xskbcx_cxXsKb`，体同上 | 报错「教务系统返回错误（代码 503）：登录状态可能已失效，请重新登录后再点「提取课表」」 |
| E 页面读不到学期 | GET `…/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`；然后 POST 主接口、Rjc、Zc | 成功，学期从课表首页取到 |
| F 登录页（路径含 `login_slogin.html`） | 不发请求 | 直接抛「当前打开的是教务登录页。请先登录教务系统……」 |
| G 主接口 2xx 但是登录页 HTML | POST `xskbcx_cxXsgrkb` 一次，**不打备用** | 报错「教务系统没有返回课表数据（返回的内容格式不对）」 |
| H 附加接口失败（Rjc 500、Zc 网络错误） | POST 主接口、Rjc、Zc | 成功，`periodTimes` 与 `calendar` 均为 `null` |

所有成功场景的输出：顶层键只有 `term` / `today` / `campusId` / `raw` / `total` / `periodTimes` / `calendar`；
`raw.kbList` 每行只剩白名单字段；`raw.sjkList` 只剩 `kcmc`；输出字符串里搜不到 `SECRET` / `xsxx` / `cd_id` / `kkdw` 任何一个。
（场景 F 的报错是同步抛出，与模板 hueb 的写法一致，宿主照常接住。）

## 9. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **真机未验证**。没有本校账号，课表接口、备用接口、作息接口、校历接口的真实返回形状都是按上游代码与同族正方脚本推断的。fixtures 是合成数据。
2. **作息接口 `cxRjc` 的菜单号**按同族约定写 `N2151`，本校是否存在该接口未知。取不到就回落上游 10 节表，不影响导入，但节次时间可能与学校实际作息不符（会有 warnings 提醒核对）。
3. **H3 补齐与任务卡的一处出入**：任务卡写「课表排到第 11–12 节 → H3 顺推」。按统一修订 H3 的口径，第 11 节内置表写的是 20:20-21:05，它的开始（20:20）不早于上一节（第 10 节）下课（20:20），所以用的是内置时间，不是顺推。
   本件的 `basic` fixture 按 H3 写：第 11–12 节用内置、第 13–14 节才顺推。**这一点需要主调度确认是否接受。**
4. **登录页判断只认 `login_slogin.html`**。`loginUrl` 本身是课表页（照上游 `import_url`），没登录时教务跳登录页，路径会是 `login_slogin.html`，能覆盖。
   如果教务改了登录页路径，判断会失效，但会落到「没读到学年学期」的报错，不会静默出错。
5. **主接口 2xx 但内容错**（比如登录失效回了 HTML）按上游 `!resp.ok` 的口径不回落备用，直接报「请先登录」类错误。这是照上游的选择，如果本校备用接口在这种情况下才有数据，会漏掉。
6. **学期名**取下拉框文本（`#xnm` 的 `2026-2027`、`#xqm` 的「第一学期」）；拿不到学年时退回「广州航海学院 第 X 学期」。
7. **总周数缺省 20**：校历与课表都给不出更多周次时，就是 20 周。学期长于 20 周而校历又取不到时，要靠课表里的最晚周次抬高，学校若只排了前 16 周的课，总周数会按 20 导入（warnings 会说明）。

## 10. 签名

0x7E7-2023（haiku 移植，2026-10-20）

## 审计修正（2026-10-20）

- **周次前缀标记误吞上一段的后缀**：`parse.js` 的 `weeksOf` 里，前缀写法的正则 `(单)1` 没排除标记前面紧挨着上一段（数字或「周」）的情况，
  把上一段的后缀 (单)/(双) 当成下一段的前缀：`1-8周(单) 9-16周(双)` 被读成 1-16 每周；`1-8周(单)9-16周` 被读成 1-15 单周，9-16 周的双周丢了；
  `1-16周(单) 17-18周` 被读成 1-17 单周，第 18 周丢了。
- 修正：标记前面紧挨着数字或「周」（中间可有空白）时按后缀归给前一段，只有在段首（字符串开头或分隔符之后）才当后一段的前缀；
  后缀后面直接跟着下一段数字时补一个逗号隔开。`(单)1-8周,(双)9-16周`、`1-8周(单),9-16周(双)`、`1-15周(单) 共16周` 等原有写法行为不变。
- 新增 fixture `week-adjacent`（三个反例；期望值按周次集合手推：1-7 单 + 10-16 双；1-7 单 + 9-16 每周，合并为 1-9 单 + 10-16 每周；1-15 单 + 17-18 每周，合并为 1-17 单 + 18 每周）。版本号 1.0.0 → 1.0.1。
- 已知取舍：`(单)1-8周 (双)9-16周`（前缀写法、段间只有空格）里的 `(双)` 前面紧挨「周」，按上述规则会被当作前一段的后缀；与后缀写法 `1-8周(单) 9-16周(双)` 在形态上无法区分，未见真实样本，按上述规则取后缀。

## 修订 1.0.2（2026-10-27）：无逗号的前置单双标记

- 问题：`(单)1-8周(双)9-16周`（前置标记、两段之间没有逗号）里的第二个标记前面紧挨「周」，被当成上一段的后缀，两段并成「单双都有」，整门课读成 1-16 周每周都上（批次十八 `jxfu`、批次十九 `smu` 审计发现，探测后确认本件同样如此）。
- 修正：`weeksOf` 里夹在两段中间的标记，若它所在的这一段以前置标记开头，就判给下一段；否则仍按后缀归上一段，`1-8周(单)9-16周(双)` 等后置写法不受影响。段间只有空格的 `(单)1-8周 (双)9-16周` 也一并读对。
- 回归：差分测试（`.test/fix-prefix/diff.js`）对 32 种其它周次写法比对修订前后输出，修订前读对的全部一字不差；7 种无逗号前置写法读出的周次与手推一致，整份输出与修订前代码对等价后置写法的输出一致。
- 新增 fixture `weeks-prefix-glued`：期望取修订前代码对等价后置写法 `1-8周(单),9-16周(双)` 的输出（该写法修订前已正确）。
- 版本 1.0.1 → 1.0.2。
