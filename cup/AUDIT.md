# 中国石油大学（北京）（`cup`）适配器 —— 安全审计

| | |
|---|---|
| 上游 | [shiguang_warehouse](https://github.com/XingHeYuZhuan/shiguang_warehouse) → `resources/CUP/cup_01.js`（MIT）。文件本身没有署名；同目录 `adapters.yaml` 的 maintainer 是 larryyan。克拉玛依那份的文件头把这份本科脚本算在 larryyan 名下。不要写成星河欲转 |
| 上游快照 | `03d161a`（2026-11-01，已与 origin/main 对齐）。`git log -1` 核对 `cup_01.js` 最后提交为 `80e30cf`（合并提交，提交者不是作者），与任务卡一致 |
| 上游平台 | 树维学生端 `bk.cup.edu.cn/student/for-std/course-table`。与克拉玛依校区 cupk、以及 jstc / zzu 同一套 print-data，不是 neuq / yangtzeu 的旧 eams `courseTableForStd.action`。研究生脚本 `cup_02.js`（gmis）不在本次范围 |
| 本适配器 | `jw-adapters/cup/`。`extract.js` 只取数，`parse.js` 纯转换 |
| 移植者 | 0x7E7-2023（haiku 移植，2026-11-01） |
| 结论 | **安全性通过**（§2）。**正确性未在真机验证**：没有本校账号，fixture 与浏览器冒烟都是合成的 |

模板用 **cupk**。对照上游全文，`cup_01.js` 与 `cupk_01.js` 只有主机不同：`https://bk.cup.edu.cn` 对 `https://eams.cupk.edu.cn`，三条路径完全一样。任务卡写「没有 adapters.yaml」，快照里实际有 `resources/CUP/adapters.yaml`，本科项 maintainer 为 larryyan，与任务卡指定的作者一致，按 larryyan 署名。

## 1. 请求清单

只在已经打开本校课表、且当前页不是登录页时发请求。主机只有 `bk.cup.edu.cn`。

| # | 方法 | 地址 | 干什么 | 拿不到时 |
|---|---|---|---|---|
| 1 | GET | `https://bk.cup.edu.cn/student/for-std/course-table` | 读 `#semesters`，没有再读 `#allSemesters`。丢掉 `value="all"` | 报错，请学生打开课表页。不猜学期，也不弹窗 |
| 2 | GET | `https://bk.cup.edu.cn/student/ws/semester/get/{id}` | 开学日、结束日、一周从哪天开始、学期名 | `getJsonOptional` 交空，不阻断。`parse.js` 用 20 周并提醒 |
| 3 | GET | `https://bk.cup.edu.cn/student/for-std/course-table/semester/{id}/print-data` | `studentTableVms[0]`（没有则 `studentTableVm`）里的 `activities` 和 `timeTableLayout.courseUnitList` | 报错。地址没有查询串，与上游一致，不加 `hasExperiment` |

登录页（密码框且没有学期下拉，或地址带 `/login`、`/cas`、`/authserver`）和别的主机：直接提示，**不发请求**。不读密码框的内容。

`manifest.loginUrl` 与 `scheduleUrlHint` 都是课表页完整地址 `https://bk.cup.edu.cn/student/for-std/course-table`。`allowHosts` 是空数组。脚本里的绝对地址与 `loginUrl` 同主机。

## 2. 移植手册 §5 八条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | 通过。不读密码框的值，不读本地存储、Cookie。取数只用已登录页面的同源会话 |
| 2 | 不外发 | 通过。只有上面 3 个 GET，没有上报、外链脚本 |
| 3 | 请求域可控 | 通过。主机只有 `bk.cup.edu.cn`，与登录页相同。`allowHosts` 不写通配 |
| 4 | 只读课表 | 通过。不请求成绩、学籍、缴费。响应里的学号、姓名、证件号在 `pickActivity` / `pickMeta` / `pickTeachers` 丢掉 |
| 5 | 不埋点 | 通过 |
| 6 | 不 eval | 通过。无 `eval`、`new Function` |
| 7 | 不写页面 | 通过。`DOMParser` 只解析取回的 HTML 字符串 |
| 8 | 不硬编码秘密 | 通过。无学号、无密钥 |

没有提问桥。上游的确认弹窗和选学期弹窗都没有搬过来。已登录就取当前学期：地址里的 `semester/{id}`，其次下拉上写了 selected 的一项，最后才用列表第一个。

## 3. 读了什么、交出去什么

`extract.js` 交出去的只有：`term`（id、名称、凭什么选中）、`semesters`（id、名称、是否写了 selected）、`semesterMeta`（起止日期、`weekStartOnSunday`、`firstDayOfWeek`、学期名）、`activities` 白名单（课名、教师、校区、教室、楼、星期、节次、`weekIndexes`）、`courseUnitList`（节次号、开始、结束）。

`parse.js` 使用这些字段，另接受夹具里的 `today`（只为钉住「没有开学日」时的推算，extract 不传）。

教师写成空的情况：空、`未知`、`待定`、`暂无`、`暂无教师`。教室同样，外加 `未知地点`、`暂无教室`。不把这些词交给课表。

节次时间：上游没有写死表，只读 `courseUnitList`，数字四位（例如 820）在 `fmtTime` 里补成 `08:20`。课表格子按节次号占行，缺号或没盖住课表用到的节次时，只把缺的那几节按上一节下课后课间 5 分钟、每节 45 分钟补上，教务已经给出的节次不动，并在提醒里写明。顺推越过 23:59 的不再补钟点，课程仍导入。

总周数：校历优先（回退之后的开学日到结束日，含两端）；没有校历用 20；只有某一周比校历或这 20 周更晚，才抬到那一周并提醒。不用课表最大周代替学期长度。

周次文字沿用 cupk 已审过的 `weeksFromText`：`(单)1-8周(双)9-16周` 得到单周 1–7 与双周 10–16，不是 1–16 每周；标记后有空格、中间隔着「第」同样读对；后置「1-8周(单)9-16周(双)」也读对。「共 N 周」只剥备注。

开学日：把 `startDate` 退到该周的起始日（默认周一；`weekStartOnSunday` 为真则退到周日）。上游把日期原样交给拾光。这里必须自己交出 `firstDay`，所以保留回退，并在推算时写明。夹具里的 2025-09-01 到 2026-01-18 是 20 周，2025-09-01 到 2025-12-21 是 16 周。

提醒里的教务原文先截到 20 字。自己生成的学期名（学校名加学年学期）不截。不说「作息表」「内置」「学期管理里改教师」。

## 4. 与 cupk 的差异

1. 主机换成 `bk.cup.edu.cn`。学校全称是「中国石油大学（北京）」，不是克拉玛依校区，也不是华东。
2. 作者按 larryyan。cupk 文件头的克砖鼠鼠、adapters.yaml 的 ARK-VALLEY 不带到这里。
3. `placeholder` 多认「暂无教师」「暂无教室」。cupk 只认到「暂无」。
4. 取数路径、学期挑选、print-data 外壳、周次文字、总周数口径与 cupk 相同，因为两份上游脚本除主机外一致。

## 5. 上游里删掉或改掉的

- 确认弹窗 `promptUserToStart`、选学期弹窗 `showSingleSelection`、拾光的 toast / 存课 / 完成通知。已登录就取当前学期。
- 教室缺省「未知地点」。改为空，并提醒到「编辑课程」补。
- 时间格式化的补零函数移到 `parse.js` 的 `fmtTime`（ES5 没有上游用的那个字符串方法）。
- 不请求成绩或个人信息接口。print-data 里夹带的学号、姓名、证件号不带出。
- 不移植研究生 `cup_02.js`。

## 6. 本校边界（夹具）

共 10 对，期望按规范手算，不是把 parse 输出存下来。数据是合成的。

| 夹具 | 覆盖 |
|---|---|
| basic | 重复行并成一段、单周、双周、校区加教室、未知/暂无教师教室、多个学期只导当前 |
| weeks-text | `(单)1-8周(双)9-16周` → 1–7 单周 + 10–16 双周；后置单双；`共8周` 不吞掉后半；`第1-第8周`；单双同时出现 |
| weeks-gap | 单双标记后有空格，或中间隔着「第」，都是 1–7 单周加 10–16 双周 |
| no-calendar | 无结束日，总周数 20，不用最大周 16 |
| over-calendar | 校历 16 周，课表到第 20 周，抬高并提醒 |
| raise-default | 无校历但排到第 22 周，从 20 抬到 22 |
| long-warn | 三门长课名缺教师，课名截 20 字，整条不超过 200 字 |
| period-gap | 节次表只有 1–2 节，课用到第 5 节；第 3–5 节按 10:05 起顺推，第 1、2 节仍是 08:20 与 09:15 |
| dirty | 没标当前学期、缺字段、坏周次、认不出的周次；「暂无教师」「暂无教室」交空 |
| guess-start | 无开学日，以夹具里的 2026-09-02（周三）退到 2026-08-31；学期名用「中国石油大学（北京）」加学年学期，不截断 |

## 7. 变异测试

在 `parse.js` 上改坏再还原，自检必须先 DIFF 再 PASS。

1. `weeksFromText` 里「后一个标记归下一段」改成不隔开（`return ',' + mark` 改成 `return mark`）→ `weeks-text`、`weeks-gap` 变红（退化成 1–16 每周）。
2. 没有校历时改成用课表最大周（`DEFAULT_TOTAL_WEEKS` 换成 `maxWeek`）→ `no-calendar`、`raise-default`、`guess-start` 变红。
3. `placeholder` 不再把「未知」「待定」「暂无教师」当成空 → `basic`、`long-warn`、`dirty` 变红。

三处都已还原。最终自检 PASS。

## 8. 没验的部分

- 没有本校账号。print-data 的字段名来自上游脚本，真机若改版，缺字段会进提醒或报错，不会静默交出错课表。
- 上游不带 `hasExperiment`。实验课若只在加了该参数时才出现，这里会少课。这是照上游代码，不是漏请求。
- 浏览器冒烟（`.test/port-batch23/cup/smoke.py`）用假站覆盖：正常页、地址里的学期、`#allSemesters`、未标学期、登录页、门户、克拉玛依主机（应拦住且不发请求）、401、500、学期接口失败、空课表、个人信息不得带出。不联网。
- `minAppVersionCode` 为 11。输出仍是 `kind:"schedule"`。

0x7E7-2023（haiku 移植，2026-11-01）
