# 北京邮电大学（bupt）安全审计与移植说明

签名：0x7E7-2023（haiku 移植，2026-11-01）

## 出处

- 上游：`shiguang_warehouse` 的 `resources/BUPT/bupt_01.js`（MIT）。
- `adapters.yaml`：adapter_id `BUPT_01`，maintainer **cstkn**，import_url `https://jwgl.bupt.edu.cn/jsxsd/`。
- 任务卡把作者写成「星河欲转」。manifest 按 yaml 的 maintainer 署 cstkn。两者都写在文件头注释里。
- 快照提交 `03d161a`（与 origin/main 对齐）。`git log -1` 显示该文件最后一次提交是 `80e30cf`，与任务卡一致。
- 模板：已审计的 `zsc`（强智 `/jsxsd/`，课表网格 + 周次切段）。本校上游**只解析已经打开的学期理论课表**，不请求课表接口，所以取数没有沿用 zsc 的 POST。

## 请求清单

| 方法 | 地址 | 干什么 | 取不到时 |
|---|---|---|---|
| 无 | 无 | extract.js 不调用 fetch / XHR | 当前页（含同源 iframe）没有 `#kbtable`，或格子里没有理论课：直接提示，不发请求 |

`allowHosts` 为空。`loginUrl` = `https://jwgl.bupt.edu.cn/jsxsd/`。`scheduleUrlHint` = `https://jwgl.bupt.edu.cn/jsxsd/xskb/xskb_list.do`。

## 读了什么、交出去什么

只读当前文档或同源 iframe 里的 `#kbtable`，以及同一文档里 id/name 含 `xnxq` 的学期下拉框选中项。

不读登录框、不读页面上的姓名 / 学号 / 证件号 / 手机号。查询串不放进 `pageUrl`。类名含 `kbcontent1` 的简写副本不读，它的文字也不进格子文本。类名含 `sykb2` 的实验课表不交原文（格子文本里同样剥掉），只交 `skippedLab` 计数。

交出去的字段：`source`、`pageUrl`（无查询串）、`now`、`term.code` / `term.name`、`screenTermMissing`、`cols`、空的 `calendar`、`slots`（行首「数字开头 + 时刻」）、`skippedLab`、`rows[].col/span/text/parts`（理论课 `kbcontent` 的 HTML）。

parse.js 再解释课名、教师、教室、周次、节次。教师或教室是「未知」「待定」「暂无」（以及上游的「未知教师」「未知地点」）写成 null。

## 节次时间

上游 `parseTimeSlots`：表头 `th` 以节次数字开头，后面带 `HH:mm-HH:mm`。没有写死的节次表。取到的放进 `slots`；某一节没有时刻时，parse.js 用「7 点加节次」的占位（第 13 节是 20:00–20:45，第 16 节是 23:00–23:45）并提醒。超过 16 节的块丢掉并点名。

没有方括号节次时，用行首标签（「第5,6节」，或剥掉时刻后的「1」）。

## 周次与总周数

周次沿用 zsc：`(单)1-8周(双)9-16周` 是单周 1–7 加双周 10–16，不是 1–16 每周。后置 `1-8周(单)9-16周(双)`、`第1-第8周`、`共 N 周`（只剥备注）都有用例。

没有校历。总周数按 20；课表最大周更晚才抬高（用例到第 22 周则总周数 22）。不把最大周当成学期长度（上游 `semesterTotalWeeks = maxWeek` 已删）。开学日按提取日所在周的周一推算，并提醒到「学期管理」核对。

## 移植手册 §5

1. 不碰凭据：不读密码、不读 localStorage。
2. 不外发：没有 fetch、XHR、sendBeacon、WebSocket、图片信标。
3. 请求域：没有请求。`allowHosts` 为空，不写通配。
4. 只读课表：不请求成绩、学籍、个人信息、缴费。实验课表块也不交出去。
5. 不埋点。
6. 不 eval、不 `new Function`。
7. 不写页面、不提交表单。上游的确认框和 toast 已删。
8. 不硬编码密钥或他人学号。fixture 与冒烟用的都是合成姓名。

## 相对 zsc 删改了什么

- 删掉课表 POST、教学周历 GET/POST，以及 zsc 写死的 12 节时刻。
- 增加 iframe 里的 `#kbtable`、行首时刻、`sykb2` 计数。
- 登录页 / 门户 / 主页没有课表时只提示。
- 「待定」「暂无」与「未知」一样留空，提醒改到「编辑课程」，不写「学期管理」改教师教室。

## 变异测试（副本在临时目录，本体已还原）

1. 前置单双不再补逗号：`basic` 变红（电路基础塌成 1–16 每周）。
2. 「待定 / 暂无」不再当空：`row-label` 变红。
3. 兜底总周数改成 16：除 `late-week` 外的用例变红。
4. 「共 N 周」改成从「共」删到行尾：`week-forms` 变红。

随后对本体再跑自检，结果 PASS。

## 已知风险

没有本校账号，真机没验过。行首时刻的正则与上游一致：表头若以「第」开头而不是数字，这一行的时刻读不到，该节会走占位并提醒。学期下拉框不在课表同一文档里时，学期名用「北京邮电大学当前学期」。
