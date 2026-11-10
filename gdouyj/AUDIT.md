# 安全审计 —— 广东海洋大学（阳江校区）（正方教务 V9 新版 jwglxt，经学校零信任通道 wfw.gdou.edu.cn 访问）

审计对象：`jw-adapters/gdouyj/` 下的 `extract.js` / `parse.js` / `manifest.json`，移植自 `shiguang_warehouse` 的
`GDOU/gdouyj.js`（823 行，`adapter_id` = GDOUYJ_01，上游版本 1.2）。上游快照 `baf83fa`（2026-11-10 与 origin/main 对齐）；
`git log -1 --format=%h -- resources/GDOU/gdouyj.js` 得 `1592e3e`（2026-11-10，PR #863「支持从教务课表导入学分」，作者 Yihe-ng）。
MIT；`adapters.yaml` 的 maintainer 是 **Yihe-ng**，原始 GDOU 适配作者 **Mccurtain**（脚本头部 `@author` / `@adapted-by` 同）。
入口 `import_url` = `https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/`（学校零信任通道，校内外都能用）。
同目录另有 `gdouyj2.js`（备用通道，从教学评价系统取数，`jxpj.gdou.edu.cn`），**不在本件范围内**。

**模板**：同校已审的 `jw-adapters/gdou-wfw`（同为经 wfw 零信任通道访问的正方 V9 件，取数路径、前缀归一、周次解析、
合并、开学日与总周数逻辑完全同构）。本件以它为底，只改作息与上课地点。选它而不是 `gdou`：本校区教务同样只能经 wfw 进入，
`loginUrl` / `scheduleUrlHint` / 前缀兜底与本件一致。

**署名**：任务卡写的 `移植 0x7E-2023` 是已知笔误（批次三十三 `xzit` 集成时已统一订正），本件按实际署名写 `0x7E7-2023`。

## 1. 请求域与请求清单（与代码逐条对应）

所有请求都由 `window.location` 拼成**同源**地址：`originOf()`（wfw 主机）+ `prefixOf()` 的前缀。`prefixOf()`：路径里最早出现的
`/kbcx/` 或 `/xtgl/` 之前的一段；两者都没有时识别反代前缀（`/https://jw.gdou.edu.cn`、`/http/<串>`，正则同上游 `getScheduleBase`）；
仍认不出返回 null，脚本报错、**不发任何请求**。`allowHosts` = `[]`：全部请求都打在用户当前打开的 wfw 主机上。

| 谁 | 方法 | 地址（`<前缀>`：代理课表页 `/https://jw.gdou.edu.cn`，移动门户首页为空） | 干什么 | 取不到时 |
|---|---|---|---|---|
| `currentTerm` | GET | `<前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读 `#xnm` / `#xqm`（页面上已有时跳过） | 报错，提示重新登录、打开「学生课表查询」，并提示「手机版就切到电脑版」 |
| `fetchTimetable` | POST | `<前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON，请求体与上游一致（`xnm` / `xqm` / `kzlx=ck` / `xsdm=` / `kclbdm=`） | 非 2xx 报「教务系统返回错误（代码 N）」；返回的不是课表 JSON 报「登录状态可能已失效」 |
| `optionalJson` | POST | `<前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 学期周次校历 | 交 `null`，parse 推算开学日并提醒 |

不请求节次时间接口（节次时间用 parse.js 里写死的阳江 10 节，与上游一致）。上游的 `openTimetableFromMobilePortal`（插 iframe）
**不移植**，因此也不会逐个 fetch 课表页的 `script[src]`。

## 2. 读了什么、交出去什么

排课行（`kbList`）只带 `kcmc / xm / cdmc / xqj / jcs / zcd` 六个字段；集中实践课（`sjkList`）只带课名；校历只带
`zs / zsmc / zrq / zcrq / rq / ksrq`。`xsxx`、学号、姓名、身份证号、手机号、教室 ID 等一律不带出。
**上游 1.2 的学分（`kbList[].xf`）不取也不交**：空课载荷没有学分字段（见 §5）。

## 3. 移植手册 §5 八条

| # | 结论 |
|---|---|
| 1 不碰凭据 | 过。不读不存账号密码；上游弹窗不移植 |
| 2 不外发 | 过。只有 `request()` 一处 `fetch`，同源 |
| 3 请求域可控 | 过。只有当前 wfw 主机，`allowHosts` 为空，代码没有写死主机名 |
| 4 只读课表 | 过。三条请求全在 `/kbcx/*`，不请求成绩 / 学籍 / 个人信息接口 |
| 5 不埋点 | 过 |
| 6 不 eval | 过。只对响应做 `JSON.parse` |
| 7 不写页面 | 过。上游 iframe / `srcdoc` / 脚本内联整套不移植；取课表首页是 `fetch` + `DOMParser` 离线解析 |
| 8 无秘密 | 过。常量只有两个菜单号与阳江作息时间 |

## 4. 与模板（gdou-wfw）的差异

1. `manifest`：`key=gdouyj`、名称「广东海洋大学（阳江校区）」、`version=1.0.0`、`author=上游 Yihe-ng（MIT）；移植 0x7E7-2023`；
   `loginUrl` / `scheduleUrlHint` 与 `gdou-wfw` 相同（同一 wfw 通道、同一课表页）。
2. `extract.js`：只改文件头（出处改成 `GDOU/gdouyj.js`）与注释；取数代码（含前缀归一、登录页判断、白名单、校历外壳）与模板一致。
3. `parse.js`：**节次时间**换成阳江校区慎思楼的 10 节（上游 `TimeSlots` 逐节照抄：08:10 / 09:05 / 10:20 / 11:15 / 14:30 /
   15:20 / 16:20 / 17:10 / 19:30 / 20:25 开始）；**特殊场地连堂规则**换成阳江错峰作息（见 §4.1）；`SCHOOL_NAME` 改成全名。
4. fixtures 全部重做（模板的湖光 / 海滨场地规则不适用），7 对。

### 4.1 阳江校区错峰作息（`isOffsetSlot` / `OFFSET_BLOCK`）

上游 `getOtherVenueCustomTime`：地点为空或含「慎思楼」→ 按统一节次表；节次恰好第 3-4 节 → 用 `OTHER_VENUE_SECTION_3_4_TIME`
（10:10-11:40 的连续块）。载荷没有按课自定义时间的字段（移植手册 §4.4），课照节次导入，另用一条提醒按**课名**汇总
（同一门课占两格只算一门）说明「N 门课不在慎思楼，第 3-4 节实际是 10:10-11:40」。与模板一致，判定放在合并**之后**
（第 3 节与第 4 节分两行写的同一门课合并后也算命中；1-2 + 3-4 合并成 1-4 则不算）。

## 5. 上游里删掉 / 改掉的东西及理由

1. **学分导入（上游 1.2，PR #863）不移植**：上游从 `kbList[].xf` 读学分、写进 `course.credit`。空课载荷（specVersion 1）的
   `courses[]` 没有学分字段（`JwPayloadCodec` 只认 name / teacher / note / blocks），带上会被丢弃或整包拒收，所以 extract 不取、
   parse 不读。**上游这条改动在本件等于空操作**，等载荷格式支持学分再跟进。
2. **移动门户首页的 iframe（`openTimetableFromMobilePortal` / `prepareWfwTimetableHtml` / `normalizeWfwPageHtml`）不移植**：
   写页面、改写并执行教务脚本，违反「不写页面」；空课直接 `fetch` 同一个课表页并离线解析 `#xnm` / `#xqm`，拿到的东西相同。
3. **弹窗与桥调用全部不移植**：开场公告、`showSingleSelection` 选学年 / 学期、`saveImportedCourses` / `saveCourseConfig` /
   `savePresetTimeSlots`、`showToast` / `notifyTaskCompletion`。空课由宿主负责保存；年级下拉框裁剪（前 2 后 2）只为弹窗服务。
4. **「登录前切电脑模式」**：空课的教务网页默认是电脑版；读不到学年学期时报错里提示一句。
5. **写死的学期周数 20**：上游 `config.semesterTotalWeeks = 20` 照搬为默认值；校历给得出就用校历，课表排得更晚再把总周数抬上去。
6. **登录页判断**：上游没写。本件规则：路径含 `login_slogin.html` 报「登录页」；路径里没有 `/kbcx/`、`/xtgl/`、反代前缀的页面
   （wfw 根页、统一认证页）报「请先登录校外通道并进入教务系统」，都不发请求。
7. **上游的开场说明文字**（「如果登录后页面显示 UI 异常……」）不移植：那是给拾光导入流程的提示，空课走自己的报错文字。

## 6. 变异测试

都在真文件上改、跑完立刻还原（还原后 SHA-256 与改前一致，自检 PASS）：

| # | 改坏哪一处 | 变红的用例 |
|---|---|---|
| M1 | `UNIFIED_VENUE_KEYWORD` 由「慎思楼」改成「不存在的楼」（慎思楼也被当成错峰场地） | `basic`、`offset-venues`、`long-warnings`、`calendar-edge` DIFF |
| M2 | `OFFSET_BLOCK.from` 由 `10:10` 改成 `10:00`（提醒里的错峰时间写错） | `basic`、`offset-venues`、`weeks-prefix-glued`、`long-warnings` DIFF |
| M3 | `mergeStageOne` 的相邻节次合并 `current.end + 1 === next.start` 改成 `===`（第 3、4 节分两行写的不再合并） | `offset-venues` DIFF（数据结构不再命中错峰，提醒里的门数从 5 变 4） |
| M4 | 括号备注原文不再过 `shortName`（`noteSample` 直接取原文） | `long-warnings` DIFF（约 100 字的备注把提醒顶过 200 字，末尾的处理建议被硬截断） |

## 7. 冒烟（Playwright 假教务站，全部请求被拦，不联网）

`.test/port-batch34/gdouyj/smoke.py`，场景见脚本 `SCENES`：wfw 代理课表页（前缀 `/https://jw.gdou.edu.cn/kbcx/`，不发 GET 首页）、
门户首页（先 GET 首页再两条 POST）、代理根页（兜底前缀）、登录页 / wfw 根页 / 统一认证页（**零请求**直接报错）、
课表首页没有下拉框（GET 一次后报「切到电脑版」）、课表接口回登录页 HTML（报「登录状态可能已失效」）、`kbList` 为空
（parse 报「这个学期没有解析到任何课程」）。正常场景还检查：请求里不带学号 / 身份证号 / 手机号 / 教室 ID；载荷的节次时间是阳江
10 节（08:10 / 21:10 收尾）；教学楼 3-4 命中错峰提醒、慎思楼 3-4 不命中。

## 8. 已知风险与未验证项（没有本校账号，真机没验过）

1. **错峰作息规则按上游推断**：上游只写「慎思楼用统一节次表，其他教学楼第 3-4 节 10:10-11:40」。真实课表里地点文本若写成
   「慎思楼A101」以外的别名（如「慎思A」），会被当成其他教学楼而多提醒一次；只会多一条提醒，不影响课表本身。
2. **wfw 通道的真实行为未验证**：登录后页面路径形态（拼接态 / 哈希态 / 门户首页）、课表首页在门户前缀下是否返回含
   `#xnm` 的完整页面，全凭上游代码推断；与 `gdou-wfw` 同口径。
3. **学期名**：取教务下拉框文本（`1` / `2`）+ 学年；若教务部署把学期文本写成别的形式，学期名可能不准（不写错数据）。
4. 上游 1.2 的学分、`gdouyj2.js` 备用通道均未移植（§5.1；备用通道是非同源主机，超出本件入口）。
5. 节次时间照抄上游写死的 10 节（08:10-21:10），未与学校最新作息表核对。

签名：0x7E7-2023（haiku 移植，2026-11-10）。
