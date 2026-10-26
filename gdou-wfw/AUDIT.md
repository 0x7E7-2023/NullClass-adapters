# 安全审计 —— 广东海洋大学（校外通道）（正方教务 V9 新版 jwglxt，经学校零信任通道 wfw.gdou.edu.cn 访问）

审计对象：`jw-adapters/gdou-wfw/` 下的 `extract.js` / `parse.js` / `manifest.json`，移植自 `shiguang_warehouse` 的 `GDOU/gdou2.js`
（快照 `e15c6274ac347c9642da890504651a9b4e374391`，2026-10-26 拉取；`git log -1 -- resources/GDOU/gdou2.js` 得 `3976cfa`，2026-10-25，PR #892；
MIT，作者 Mccurtain，上游版本号 1.0，校外通道反代方案由 Yihe-ng 提供）。入口 `import_url` = `https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/`（学校零信任通道，校内外都能用）。

**范围**：`gdou2.js` 与 `gdou.js` 其余逻辑逐字相同（`diff gdou.js gdou2.js` 只有「零信任移动门户」一块与学年范围裁剪）。因此本件**以 `jw-adapters/gdou` 1.1.0 为底**：
`parse.js` 除文件头外与 `gdou/parse.js` 逐字一致（以后跟进上游一处改两件）；差别集中在 `extract.js` 的地址前缀与提示文字。内网直连入口见 `gdou` 件；阳江校区脚本不在范围内。

静态扫描（`check.js`）：ES5、控制字节、`allowHosts`、载荷校验、Rhino 实跑 fixture 均通过；`extract.js` 代码里没有任何绝对地址（出现的 `https://...` 都在注释里）；网络调用只有 `request()` 一处 `fetch`。

## 1. 请求域与请求清单（与代码逐条对应）

所有请求都由 `window.location` 拼成**同源**地址：`originOf()`（wfw 主机）+ `prefixOf()` 的前缀。`prefixOf()`：路径里最早出现的 `/kbcx/` 或 `/xtgl/` 之前的一段；
两者都没有时识别反代前缀（`/https://jw.gdou.edu.cn`、`/http/<串>`，正则同上游 `getScheduleBase`）；仍认不出返回 null，脚本报错、**不发任何请求**。
`allowHosts` = `[]`：全部请求都打在用户当前打开的 wfw 主机上，没有任何需要直连别的主机的请求（上游 `prepareWfwTimetableHtml` 还会拒绝非同源脚本）。

| 谁 | 方法 | 地址（`<前缀>`：代理课表页 `/https://jw.gdou.edu.cn`，移动门户首页为空） | 干什么 | 取不到时 |
|---|---|---|---|---|
| `currentTerm` | GET | `<前缀>/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | 读 `#xnm` / `#xqm`（页面上已有时跳过） | 报错，提示重新登录、打开「学生课表查询」，并提示「手机版就切到电脑版」 |
| `fetchTimetable` | POST | `<前缀>/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151` | 取课表 JSON，请求体与上游一致 | 非 2xx 报「教务系统返回错误（代码 N）」；返回的不是课表 JSON 报「登录状态可能已失效」 |
| `optionalJson` | POST | `<前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154` | 学期周次校历 | 交 `null`，parse 推算开学日并提醒 |

不请求节次时间接口（节次时间用 parse.js 里写死的 10 节，与 `gdou` 相同）。

## 2. 读了什么、交出去什么

与 `gdou` 完全相同（见 `jw-adapters/gdou/AUDIT.md` §2）：排课行只带 `kcmc / xm / cdmc / xqj / jcs / zcd`，实践课只带课名，校历按字段白名单；`xsxx`、学号、姓名、教室 ID 等一律不带出。
冒烟桩响应里混入学号、身份证号、手机号、`xsxx` 姓名、教室 ID，请求与输出里均检索不到。

## 3. 移植手册 §5 八条

| # | 结论 |
|---|---|
| 1 不碰凭据 | 过。不读不存账号密码；上游的弹窗不移植 |
| 2 不外发 | 过。只有 `request()` 一处 `fetch`，同源 |
| 3 请求域可控 | 过。只有当前 wfw 主机，`allowHosts` 为空，代码没有写死主机名 |
| 4 只读课表 | 过。三条请求全在 `/kbcx/*` |
| 5 不埋点 | 过 |
| 6 不 eval | 过。只对响应做 `JSON.parse` |
| 7 不写页面 | 过。**上游 iframe 整套不移植**（见 §5）；取课表首页是 `fetch` + `DOMParser` 离线解析，不插入页面 |
| 8 无秘密 | 过。常量只有两个菜单号 |

## 4. 与模板（gdou 1.1.0）的差异

1. `manifest`：`key=gdou-wfw`、名称、`loginUrl` = 上游 import_url、`scheduleUrlHint` = wfw 前缀的课表页地址（它是一键刷新时会打开的地址，所以只写地址，「手机版切电脑版」的提醒放在报错文字里）。
2. `extract.js`：文件头；`NOT_IN_JW` 改成「请先登录校外通道……；如果页面显示成手机版，请点右上角菜单切到电脑版」；读不到学年学期的两条报错末尾加同一句提示（`DESKTOP_HINT`）。取数代码（含反代前缀兜底）与 `gdou` 一致。
3. `parse.js`：只改文件头。fixtures：复制 `gdou` 的 11 对（含 `special-field`），保证两件同口径。

## 5. 上游里删掉 / 改掉的东西及理由

1. **移动门户首页的 iframe（`openTimetableFromMobilePortal` / `prepareWfwTimetableHtml` / `normalizeWfwPageHtml`）不移植**：上游在 `wfw.gdou.edu.cn/xtgl/index_cxAllApp.html` 弹窗确认后，
   fetch 课表首页 HTML、把页面里每个脚本逐个 fetch 并内联、改 base、做成 `srcdoc` iframe 盖满全屏。这是写页面、改写并执行教务脚本，违反「不写页面」。
   取舍依据：门户首页路径里没有反代前缀，`getScheduleBase()` 得空串，iframe 方案真正请求的就是 `https://wfw.gdou.edu.cn/kbcx/xskbcx_cxXskbcxIndex.html?...`；
   空课的 `currentTerm()` 直接请求同一个地址并离线解析下拉框，拿到的东西相同，所以**不插 iframe 也拿得到必需的数据**。学期以教务页面默认选中项为准（与 `gdou` 一致，不弹窗）。
2. 弹窗（`showAlert`、学年学期选择、`showToast` 等）与保存桥调用全部不移植。上游裁剪学年下拉范围（前 2 后 2）只为弹窗服务，不需要。
3. 「登录前切电脑模式」：空课的教务网页默认是电脑版；读不到学年学期时报错里提示一句。
4. 登录页判断：wfw 自己的登录页路径上游没有写。本件规则：路径含 `login_slogin.html` 报「登录页」；路径里没有 `/kbcx/`、`/xtgl/`、反代前缀的页面（wfw 根页、统一认证页）报「请先登录校外通道并进入教务系统」，都不发请求。

## 6. 变异测试与冒烟

变异：M1 `prefixOf()` 去掉 `/xtgl/` 锚点（改真文件、跑完立刻还原）→ 冒烟 `wfw-portal` 变红（门户首页拼出的前缀不对，报「请先进入教务系统」）。
parse.js 与 `gdou` 逐字一致，其变异记录见 `gdou/AUDIT.md` §6.1 与 §10（`special-field` 在本件同样钉住）。还原后自检 PASS。

冒烟：`D:/NullClass/.test/port-batch17/gdou/smoke.py`（Playwright，假教务站，全部请求被拦，不联网）。本件 8 个场景全部 OK：

| 场景 | 页面 | 结果 |
|---|---|---|
| wfw-proxy-kb | `wfw.gdou.edu.cn/https://jw.gdou.edu.cn/kbcx/…` | 两条 POST，路径前缀 `/https://jw.gdou.edu.cn/kbcx/`，不发 GET 首页 |
| wfw-portal | `wfw.gdou.edu.cn/xtgl/index_cxAllApp.html` | 先 GET `/kbcx/xskbcx_cxXskbcxIndex.html?…`，再两条 POST（前缀为空） |
| wfw-proxy-root | `wfw.gdou.edu.cn/https://jw.gdou.edu.cn/` | 兜底识别前缀；GET 首页 + 两条 POST |
| wfw-login | `…/xtgl/login_slogin.html` | 不发请求，报「当前打开的是登录页」 |
| wfw-root / wfw-authpage | `wfw.gdou.edu.cn/`、`/login` | 不发请求，报「请先登录校外通道……切到电脑版」 |
| wfw-mobile | 门户首页但课表首页没有下拉框 | GET 一次后报「没读到学年学期……切到电脑版后再试」 |
| wfw-expired | 课表接口回登录页 | 报「登录状态可能已失效」 |

所有场景请求中 `cxRjc`、`/jwglxt` 出现 0 次；载荷里「（公选）大学英语」规范成「大学英语(公选)」，「匹克场」命中特殊场地提醒。

## 7. 已知风险与未验证项（没有本校账号，真机没验过）

1. **wfw 通道的真实行为未验证**：登录后页面路径形态（拼接态 / 哈希态 / 门户首页）、课表首页在门户前缀下是否返回含 `#xnm` 的完整页面，全凭上游代码推断。门户首页路径下请求直接打在 wfw 主机 `/kbcx/…` 上，是照上游 `getScheduleBase()` 的行为推出的。
2. **wfw 登录页路径未知**：上游没写，只认 `login_slogin.html`；其它登录页形态会走「读不到学年学期」或「没有返回课表数据」两条报错，都带「重新登录」的提示，不会写错数据。
3. 其余风险（节次时间照抄上游、特殊场地不分校区、校历字段没见过真实响应等）同 `gdou/AUDIT.md` §8。

签名：0x7E7-2023（sonnet 移植，2026-10-26）。
