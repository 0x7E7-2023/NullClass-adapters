# 安全审计 —— 长江大学教务适配器（`yangtzeu`）

审计对象：`jw-adapters/yangtzeu/extract.js` + `parse.js`
（移植自拾光社区 `YANGTZEU/yu.js`，上游作者 **Jursin**，MIT）

上游快照 HEAD `03d161a416db6fa5f5f7835a377821c077b670b4`（任务卡写的 `03d161a`）。
`yu.js` 最后一次改动是 `80e30cf`（2026-09-23，合并提交）。公共说明里的快照号 `7c9e190` 与本地 HEAD 不一致，以本地 HEAD 为准，没有改快照。

审计人（移植者）：**0x7E7-2023**　日期：**2026-10-27**
签名：0x7E7-2023（haiku 移植，2026-10-27）

## 1. 结论

**通过。** 只在用户已经打开的 `jwc3-yangtzeu-edu-cn-s.atrust.yangtzeu.edu.cn` 上发三条只读请求。统一认证、门户和其它网站上不发请求。不碰凭据、不外发、不埋点、不执行取回来的代码、不写页面。

模板用已审计的 `neuq`：同是树维 EAMS，课表都在 `TaskActivity` 里，周次都是位图。本校和它不同的地方见第 6 节。

## 2. 请求清单（与代码一致）

当前页主机不是 `jwc3-yangtzeu-edu-cn-s.atrust.yangtzeu.edu.cn` 时，`extract.js` 的 `pageHost` 判断直接报错，下面三条都不会发。登录主机 `cas-yangtzeu-edu-cn.atrust.yangtzeu.edu.cn` **不在** `allowHosts` 里。

| 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|
| GET | `/eams/courseTableForStd.action?sf_request_type=ajax` | 读选课身份 `ids` 和学期选择框 `semesterBar…Semester` 的当前值 | 没有 `ids` 就停，不再请求后面两条 |
| POST | `/eams/dataQuery.action?sf_request_type=ajax` | 学期列表。请求体 `tagId=<选择框 id>&dataType=semesterCalendar`；没有 tagId 时只带 `dataType`。响应里没有 `semesters` 且原来带了 tagId 时，再试一次只带 `dataType` | 失败或认不出就交空数组，课表照常取 |
| POST | `/eams/courseTableForStd!courseTable.action?sf_request_type=ajax` | 课表原文。请求体 `ignoreHead=1&setting.kind=std&startWeek=&semester.id=<当前值>&ids=<选课身份>` | 状态不是成功，或原文里没有 `TaskActivity`，整次失败 |

没有请求：`courseTableStd.action`、探测页里的表单 action、校历、成绩、学籍、个人信息。上游也没有这些课表以外的主机。学期列表和两条课表路径都在任务卡指定的那一台 jwc3 主机上。

`allowHosts` 只有 `jwc3-yangtzeu-edu-cn-s.atrust.yangtzeu.edu.cn`，没有通配。`loginUrl` 是统一认证，`scheduleUrlHint` 是课表页完整地址。

## 3. 读了什么、交出去什么

`extract.js` 输出只有四个字段：`today`、`semesters`（`id` / `schoolYear` / `term` / `startDate` / `endDate`）、`currentSemesterId`、`courseHtml`。探测页原文不交出去。选课身份只出现在发往本校课表主机的请求体里，不进输出。

`parse.js` 交课表载荷：学期名、开学日、总周数、8 节节次时间、课程（课名、教师、备注空、上课块）。教师 / 教室拿不到就是 JSON 的空值，不写「未知」。

学生姓名、身份证号、手机号、学号即使出现在探测页或学期响应的其它文字里，也不进输出（冒烟用假数据钉过）。

## 4. 节次（上游 `getPresetTimeSlots`，逐节照抄）

| 节 | 开始 | 结束 | 说明 |
|---|---|---|---|
| 1 | 08:00 | 09:35 | |
| 2 | 10:05 | 11:40 | |
| 3 | 12:00 | 13:35 | 午间 |
| 4 | 14:00 | 15:35 | |
| 5 | 16:05 | 17:40 | |
| 6 | 17:45 | 18:30 | 上游注释：部分课是 18:00-18:45，提醒里写了 |
| 7 | 19:00 | 20:35 | |
| 8 | 20:45 | 22:20 | |

表格行号到节次（`mapSection`）：1→1，2→2，3→4，4→5，5→7，6→8，7→3，8→6。超出这 8 行的行号原样当节次。用到第 9 节及以后时，空课默认节次的开始不早于上一节结束才借用，否则按课间 5 分钟、每节 45 分钟顺推，越过 23:59 就停并提醒。

周次位图：下标 `i`（从 1 起）为 `1` 就是第 `i` 周。第 0 位是占位。

## 5. 移植手册 §5 八条

1. **不碰凭据**：不读密码框，不存账号。登录页直接提示。
2. **不外发**：只有 `fetch`，地址由当前页 origin 拼 `/eams/...`，且当前页必须是 jwc3 主机。
3. **只读课表**：上表三条。学期列表只为开学日和学期名，失败可降级。
4. **不埋点**：没有统计请求。
5. **不执行远程代码**：学期响应用花括号配平读字段（`parseSemesterResponse`）。上游的 `Function` 构造器已删。
6. **不写页面、不提交表单**：不改 DOM。`ids` 只在课表 POST 里。
7. **不硬编码秘密**：没有口令、没有真实学号。
8. **个人信息不带出**：输出按上面的字段白名单。课表原文要留给 `parse.js` 抽 `TaskActivity`，解析结果里不回写学号。

## 6. 和模板 `neuq` 的差异

- 主机写死为 jwc3，不是「当前页是哪台就请求哪台」。统一认证和门户不发请求。
- 不请求 `courseTableStd.action`，也不跟着表单 action 改课表地址。
- 一天 8 节大课，不是 12 节 45 分钟；行号要映射，午间和晚间不在表格中间。
- 同一节重复行用「开始节次小于等于上一段结束加 1」并进去。不相邻节次不成一段（不把最小节到最大节涂满）。
- 教师是 `.join` 表达式时，先按变量名回看名单，再看 `actTeachers`。
- 节次超出 8 节时按统一修订 H3 补，不只是提醒「没有时间」。

## 7. 上游删掉或改掉的

- `Function` 构造器解析学期：改成配平读字段。
- `showSingleSelection` 选最近八个学期：改成用页面上当前学期。
- `showAlert` / `showToast` / `saveImportedCourses` / `savePresetTimeSlots`：不移植。节次时间进载荷并提醒。
- 调试信息（响应长度、有没有 TaskActivity）不给用户看。
- 选课身份不放进输出对象。

## 8. 用例与期望怎么推的

7 对，全部合成，没有真实姓名学号。开学日：2025-09-01 是周一，起止到 2026-01-18 共 140 天，20 周。

- `basic`：行 1+2 映射后连成第 1-2 节；行 7 映射成第 3 节；位图单周 1-15；课名去掉 `(1.01)`。
- `section-map`：行 3+4 → 第 4-5 节；行 7 → 第 3 节；行 6 → 第 8 节；行 8 → 第 6 节；行 1 与行 3 不合并。
- `weeks-bitmap`：第 0 位、缺周两段、单周 1-7 接双周 10-16、第 31 周丢掉、非 01 符号、空周次。
- `fallback`：没有学期列表时按 2025-10-08 推 2025-09-01 与 20 周；没有 `unitCount` 按 8；`index = 10` 反解成周二第 4 节；教师从 `actTeacherName` 还原成「陈某,周某」。
- `long-name`：4 门缺教师、缺教室，课名 21 字在提醒里只留 20 字。
- `duplicate-rows`：同一节写两次仍是一段第 1-2 节；中间空一节保持两段。
- `extend-period`：第 9 节补 22:25-23:10（第 8 节 22:20 下课加 5 分钟课间、45 分钟）。

## 9. 变异测试（已还原，还原后自检 PASS）

1. `mapSection` 把行 3 改成映射到第 3 节 → `section-map`、`fallback`、`duplicate-rows` 变红。
2. `weeksFromBitmap` 从下标 0 开始收周次 → `weeks-bitmap` 变红（出现第 0 周）。
3. 连堂条件改成必须正好接下一节 → `duplicate-rows` 变红（重复行裂成两段）。

## 10. 已知风险

没有长江大学账号，真机没验过。第 6 节 17:45-18:30 来自上游写死的表，不是这次从教务读的；上游注释说少数晚间课是 18:00-18:45。学期列表若改版，开学日会退回推算并提醒。

## 11. 冒烟（`/.test/port-batch21/yangtzeu/smoke.py`，11/11）

正常页、课表页、jwc3 根路径都会打出上面三条，请求体里的学期编号是 201。统一认证、门户、其它主机零请求。探测页没有选课身份时只打第一条。课表 401 / 500、空课表会报错。学期列表 500 时课表仍导入，并提醒学期只能推算。假学号和假身份证不出现在输出里。
