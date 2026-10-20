# 安全审计 —— 常州机电职业技术学院（正方教务 jwglxt 根路径，经「校内通」WebVPN 路径前缀访问，校内网络可直连）

审计对象：`jw-adapters/czimt/` 下的 `extract.js` / `parse.js` / `manifest.json`，以及它们移植自的上游脚本 `shiguang_warehouse` 的 `CZIMT/czimt.js`
（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 22:41 拉取，2026-10-20 复核仍是最新；本校脚本最后一次修改 `80e30cf`，2026-09-23；MIT，维护者 ShallowY）。
上游 `adapters.yaml` 登记：`adapter_id` `CZIMT_01`，`import_url` `https://webapp.czimt.edu.cn`（「校内通」统一身份认证入口，即 `manifest.loginUrl`），描述「采用新版Webapp(校内通)入口，统一身份认证后进入教务系统执行导入」。

模板：`gdust`（批次九，根路径 + WebVPN 路径前缀 + `vpn-…` 片段，登录页 / 门户页拦截已审）。本件是复制模板后逐处改成本校，所以与模板不同的地方集中在第 4 节。

审计方式：逐行读上游脚本与移植件；跑移植手册 §5 的静态扫描；用 Node 桩（不联网）跑 `extract.js` 的地址拼接与敏感字段检查；用 `check.js`（Rhino 实跑）跑 6 对 fixture；用 4 处变异测试 `parse.js`。

## 0. 静态扫描结果（2026-10-20 运行，扫描命令未入库）

- 网络调用：`extract.js` 只有一处 `fetch(url, options)`，位于 `request` 函数里。`X-Requested-With` 是请求头字符串，不是 XHR 对象。`parse.js` 没有任何网络调用。
- 绝对 URL：`extract.js` 与 `parse.js` 代码里没有绝对地址；文件头各有一处 `https://github.com/XingHeYuZhuan/shiguang_warehouse`，是上游出处注释。`manifest.json` 里有 `loginUrl` / `scheduleUrlHint` / `allowHosts`，这三项是任务卡给定的。
- 主机字面量：`extract.js` 代码里没有写死的主机名。`VPN_DEFAULT = 'vpn-12-o1-jwc.czmec.cn'` 是 WebVPN 查询串里的参数片段（上游原样写在 WebVPN 地址的查询串里），只在当前地址的查询串里找不到 `vpn-…` 片段时使用；它含有教务内网主机名 `jwc.czmec.cn`，但不是秘密。
- 凭据、本地存储、Cookie、`eval` / `new Function`、`sendBeacon` / `WebSocket` / `EventSource` / `new Image`、`innerHTML` / `appendChild` / `.submit` / `.click(`：全部无命中。
- ES5：`=>`、反引号、`let `、`const `、`class `、`async`、`await`、展开符、模板串、`for...of`、`Set` / `Map`、`Array.from`、`padStart`、`includes` / `startsWith`、可选链、`??`、后行断言、命名分组：全部无命中（`check.js` 的 ES5 检查通过）。
- 控制字节与 BOM：无。`parse.js` 为 CRLF（与模板一致），`extract.js` 为 LF（模板即如此）。
- 学生可见文字：`parse.js` 的 `warn(...)` 与 `throw`、`extract.js` 的报错里没有「接口」「载荷」「上游」「脚本」「字段」「课程块」「组件」「模板」「HTTP」「JSON」「DOM」「HTML」「null」「undefined」「学期设置」「作息表」。
- 模板残留：全目录检索 `gdust` / `GDUST` / `广东` / `星河` / `hueb` / `172.16` / `webvpn.gdust` / `10 节` / `作息表`，除 `parse.js` 里「第9-10节」这类节次写法示例外零命中。

## 1. 请求域与请求清单（与代码逐条对应）

上游 `CZIMT/czimt.js` 的请求是 4 条，全部同源：

- 学年学期选项：`fetchAcademicOptions`，GET `…/kbcx/xskbcx_cxXskbcxIndex.html?vpn-12-o1-jwc.czmec.cn&gnmkdm=N2151`（WebVPN）与 `http://jwc.czmec.cn/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151`（校内直连），依次尝试；读 `#xnm` / `#xqm` 后交给用户弹窗选择（`showSingleSelection`）。
- 开学日：`fetchSemesterStartDate`，POST `…/kbcx/xskbcxZccx_cxZcByXnxq.html?…&gnmkdm=N2154`，两个入口依次尝试。
- 课表：`fetchAndParseCourses`，POST `…/kbcx/xskbcx_cxXsgrkb.html?…&gnmkdm=N2151`，两个入口依次尝试；请求体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=&kclxdm=`。
- 节次时间：上游**不请求**，写死 12 节（`TimeSlots`），导入成功后另存为预设（`savePresetTimeSlots`）。

移植件的请求由 `extract.js` 的 `jwUrl` 拼出：前缀由**当前页面路径**决定（`prefixOf`：取当前路径里最早出现的 `/kbcx/` 或 `/xtgl/`，它之前的那段，WebVPN 下是 `/http/<十六进制>`，校内直连为空），主机用 `window.location.origin`。`vpnPart` 在路径以 `/http/` 或 `/https/` 开头时沿用当前查询串里的 `vpn-数字-o数字-…` 片段，找不到用 `VPN_DEFAULT`；校内直连不带片段。**只打当前页面所在的那一个主机**，不再依次尝试两个入口（跨主机请求会被宿主沙箱拦下，见第 5 节第 2 条）。

| 谁 | 方法 | 地址（`<前缀>` 与 `[vpn片段&]` 按上面的规则拼） | 干什么 | 取不到时 |
|---|---|---|---|---|
| extract.js `currentTerm` | GET | `<origin><前缀>/kbcx/xskbcx_cxXskbcxIndex.html?[vpn片段&]gnmkdm=N2151&layout=default` | 读课表页的学年学期下拉框（`#xnm` / `#xqm`）。**页面上已有这两个下拉框时跳过** | 报错「没读到学年学期…」；网络错误报「连不上教务系统…」。这条失败就不导入 |
| extract.js `fetchTimetable` | POST | `<origin><前缀>/kbcx/xskbcx_cxXsgrkb.html?[vpn片段&]gnmkdm=N2151`，体 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=&kclxdm=` | 取课表 JSON：`kbList` 排课行、`sjkList` 集中实践课、可能有的记录总数。请求体与上游逐字一致（只是 `xnm` / `xqm` 改为读下拉框的值） | 非 2xx 报「教务系统返回错误（代码 N）」；返回内容不是带 `kbList` 数组的 JSON 报「没有返回课表数据」。**这条是必需的** |
| extract.js `optionalJson` | POST | `<origin><前缀>/kbcx/xskbcx_cxRjc.html?[vpn片段&]gnmkdm=N2151`，体 `xnm=…&xqm=…&xqh_id=<课表行里的校区号>` | 取节次时间。上游没有这条请求，移植时按批次九公共说明多取的 | 交 `null`，`parse.js` 回落到本校 12 节表并在 `warnings` 里说明 |
| extract.js `optionalJson` | POST | `<origin><前缀>/kbcx/xskbcxZccx_cxZcByXnxq.html?[vpn片段&]gnmkdm=N2154`，体 `xnm=…&xqm=…` | 取学期周次校历，定开学日与总周数。上游也取（用来算开学日），但上游失败会退到 `null`，这里的处理是推算并写 warnings | 交 `null`，`parse.js` 推算开学日、总周数按 20 周并写进 `warnings` |

与上游的差别：

- 上游弹「选择学年」「选择学期」两个选择框（学年以选中项为中心取 5 个，学期取全部）；移植件改成读页面上的 `#xnm` / `#xqm`，不向用户问任何东西（`readSelect` / `currentTerm`）。页面上读不到才取一次学年学期页（`DOMParser` 离线解析，不插入当前页面）。
- 上游两个入口依次尝试；移植件只打当前页面所在的那一个。
- 两条附加请求（节次时间、校历）失败不影响导入：`optionalJson` 把任何失败吞成 `null`。
- 请求头统一带 `Content-Type`、`X-Requested-With`、`Accept`。`credentials: 'include'` 让 WebView 按同源规则带 Cookie；脚本既不读 Cookie，也不把它发到别处。
- `parse.js` 不发任何请求（CI 里用 Rhino 实跑，是纯函数）。

### 1.1 extract.js 桩跑结果（Node 桩，不联网；桩脚本在临时目录，未入库）

桩里的 `fetch` 记录「方法 + 地址 + 请求体」，并按场景返回；课表响应里埋了学生信息（`xsxx`、学号、姓名、学院、身份证号式字段、行内的 `xh_id` 与 `xsxx`），检查交出去的字符串里检索不到它们。

| 场景 | 拼出的地址（请求体见下） | 结论 |
|---|---|---|
| 1 WebVPN 课表页（`https://webapp.czimt.edu.cn/http/77726476…a2/kbcx/xskbcx_cxXskbcxIndex.html?vpn-12-o1-jwc.czmec.cn&gnmkdm=N2151&layout=default`，页面有下拉框） | `POST …/kbcx/xskbcx_cxXsgrkb.html?vpn-12-o1-jwc.czmec.cn&gnmkdm=N2151`；`POST …/kbcx/xskbcx_cxRjc.html?vpn-12-o1-jwc.czmec.cn&gnmkdm=N2151`；`POST …/kbcx/xskbcxZccx_cxZcByXnxq.html?vpn-12-o1-jwc.czmec.cn&gnmkdm=N2154` | 页面已有下拉框，不发 GET；3 条 POST；学生信息未带出 |
| 2 WebVPN 课表页但查询串没有 vpn 片段（`?gnmkdm=N2151&layout=default`，页面无下拉框） | `GET …/kbcx/xskbcx_cxXskbcxIndex.html?vpn-12-o1-jwc.czmec.cn&gnmkdm=N2151&layout=default`，再 3 条 POST，片段都补成本校默认 `vpn-12-o1-jwc.czmec.cn` | 补上了本校默认片段 |
| 3 校内直连课表页 `http://jwc.czmec.cn/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default` | `POST http://jwc.czmec.cn/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`；`POST …/xskbcx_cxRjc.html?gnmkdm=N2151`；`POST …/xskbcxZccx_cxZcByXnxq.html?gnmkdm=N2154`（无 vpn 片段，前缀为空） | 与上游校内入口的路径一致；只打这一个主机 |
| 4a「校内通」首页 `https://webapp.czimt.edu.cn/` | 不发请求 | 同步抛出「请先进入教务系统、打开课表页后再点「提取课表」」 |
| 4b 统一认证页 `…/http/<hex>/cas/login?service=…` | 不发请求 | 同步抛出「当前打开的是登录页。请先登录教务系统…」 |
| 4c WebVPN `/login` 页 | 不发请求 | 同上，「请先登录」 |
| 5 WebVPN 菜单页 `/http/<hex>/xtgl/index_initMenu.html?vpn-12-o1-jwc.czmec.cn&gnmkdm=index`（页面无下拉框） | 先 GET 课表首页（同场景 2 的地址），再 3 条 POST | 前缀取到 `/http/<hex>`（`/xtgl/` 标记），学期从课表首页取到 |

请求体：课表 `xnm=2026&xqm=3&kzlx=ck&xsdm=&kclbdm=&kclxdm=`；节次时间 `xnm=2026&xqm=3&xqh_id=01`；校历 `xnm=2026&xqm=3`。

场景 4a–4c 是同步 `throw`（与模板的登录页判断写法一致），宿主要把 IIFE 的同步异常当成失败提示处理，不能只接 Promise 的 reject（第 8 节第 3 条）。

场景 1 交出的载荷（桩里的 1 条课，学生信息已剔除，`sjkList` 只剩课名）：

```
{"term":{"xnm":"2026","xqm":"3","xnmText":"2026-2027","xqmText":"第一学期"},"today":"…","campusId":"01",
 "raw":{"kbList":[{"kcmc":"高等数学A","xm":"甲老师","cdmc":"教学楼1-101","xqmc":"东校区","xslxbj":"(理论)","xqj":"1","jcs":"1-2","zcd":"1-16周","xqh_id":"01"}],
        "sjkList":[{"kcmc":"认知实习"}]},
 "total":1,"periodTimes":[{"jcmc":"1","qssj":"08:00","jssj":"08:45"}],"calendar":[{"zs":"1","zrq":"2026-09-07"}]}
```

## 2. 读了什么、交出什么（逐字段）

| 数据 | 从哪来 | 是否带出 |
|---|---|---|
| 学年学期（`xnm` / `xqm` 与下拉框文本） | 课表页的 `#xnm` / `#xqm`，或学年学期页 HTML（`DOMParser` 离线解析） | 带出（学期名要用） |
| 排课行 `kbList` | 课表接口 | 带出**白名单字段**：`kcmc`、`xm`、`cdmc`、`xqmc`、`xslxbj`、`xqj`、`jcs`、`zcd`、`xqh_id`（`KB_FIELDS`，`pickFields`）。`xqh_id` 是校区号，只用来拼节次时间请求；`xqmc` 与 `xslxbj` 是拼教室与课名要用的 |
| 集中实践课 `sjkList` | 课表接口 | 只带 `kcmc`（`PRACTICE_FIELDS`）。它没有固定星期与节次，排不进周课表，但不能吞掉：写进 `warnings` 让用户自己加 |
| 节次时间 | cxRjc | 带出（原样），取不到为 `null` |
| 学期周次校历 | cxZcByXnxq | 原样带出，`parse.js` 只用来算开学日与总周数，不进载荷 |
| 记录总数（响应里有才有） | 课表接口 | 只用于对账，不进载荷 |
| 学生个人信息（课表响应里夹带的 `xsxx`、学号、姓名、学院、身份证号等） | 课表接口 | **不带出，也不进 fixture**：`extract.js` 只按白名单挑字段，桩跑（场景 1–3）检查交出去的字符串里检索不到 |

`parse.js` 实际读的字段：排课行 `kcmc` / `xslxbj` / `xm` / `cdmc` / `xqmc` / `xqj` / `jcs` / `zcd`（`xqh_id` 不参与解析）；实践课 `kcmc`；`periodTimes` 的 `jcmc` / `jc` 与 `qssj` / `jssj`；`calendar` 的 `zs` / `zsmc` 与 `zrq` / `zcrq` / `rq` / `ksrq`；`total`；`today`；`term.*`。

不读的东西：`password` / 登录表单、本地存储与 Cookie、成绩（`/cjcx/*`）、学籍、个人信息、缴费，以及任何其它模块的接口。

## 3. 移植手册 §5 八条逐条

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 不碰凭据 | **过**。没有密码读取、没有登录表单、没有本地存储访问。唯一的「凭据」是浏览器自带的会话 Cookie，脚本既不读它也不外发。上游的开场弹窗（`promptUserToStart`，`showAlert`）、学年学期选择（`selectAcademicYearAndSemester`，`showSingleSelection`）都没有移植 |
| 2 | 不外发 | **过**。全部 `fetch` 都在 `extract.js` 的 `request` 里，地址由 `origin` 加当前页面的前缀拼成。没有 `sendBeacon` / `WebSocket` / `EventSource` / `new Image().src` / 隐藏表单，也没有第三方域 |
| 3 | 请求域可控 | **过**。请求主机只有一个，即用户当前打开的教务页面所在的主机。`allowHosts` 为 `["jwc.czmec.cn"]`：校内直连时页面就在这个主机上，宿主靠它给这个 origin 注入桥。WebVPN 主机 `webapp.czimt.edu.cn` 与 `loginUrl` 同源，按规则不用列 |
| 4 | 只读课表 | **过**。四条请求全部落在 `/kbcx/*`（学年学期页、课表、节次时间、学期周次校历），不碰成绩、学籍、个人信息、缴费。课表响应里夹带的学生信息一律不带出；节次时间与校历是学校公共数据 |
| 5 | 不埋点 | **过**。没有统计、上报、遥测，没有图片打点 |
| 6 | 不 eval 远程代码 | **过**。没有 `eval` / `new Function`。只对教务自己的响应做 `JSON.parse`（`jsonOf`，失败返回 `null`） |
| 7 | 不写页面 | **过**。`extract.js` 只读 `#xnm` / `#xqm` 的值。学年学期页用 `fetch` + `DOMParser`，离线解析，不插入当前页面，不改表单，不触发提交或点击。上游的桥调用全部没有移植 |
| 8 | 不依赖用户输入之外的秘密 | **过**。没有硬编码的密钥、令牌或他人学号。脚本里的常量只有菜单号 `N2151` / `N2154` 与查询串默认片段 `vpn-12-o1-jwc.czmec.cn`，都是页面上可见的参数 |

## 4. 与模板 gdust 的差异（模板目录只读，本件未改动）

1. **WebVPN 默认片段换成本校**：`VPN_DEFAULT = 'vpn-12-o1-jwc.czmec.cn'`（上游三个 WebVPN 地址都带它）。模板是 `vpn-12-o1-172.16.254.1`。
2. **课表请求体多一个 `kclxdm=`**：`fetchTimetable` 照上游写 `xnm=…&xqm=…&kzlx=ck&xsdm=&kclbdm=&kclxdm=`。
3. **节次时间表是本校 12 节**（模板是 10 节，见 `parse.js` 的 `SCHOOL_PERIOD_TIMES`，逐节照抄上游 `TimeSlots`）。第 5 节 13:45–14:25、第 12 节 20:20–21:00。空课默认的 12 节内置表（`BUILTIN_PERIOD_TIMES`）保留，它只在 H3 口径里给超出教务节次表的节次补时间（见第 4 条下面的说明）。
4. **地点带校区**（模板无）：`parse.js` 的 `location`：`cdmc` 非空且 `xqmc` 非空 → `cdmc(xqmc)`；`cdmc` 非空、`xqmc` 为空 → `cdmc`；`cdmc` 为空 → 空（计入「缺教室」，不写成「(校区)」）。
5. **课名带学时类型标记**（模板无）：课名 = `kcmc` + `xslxbj`，`xslxbj` 为空就只用 `kcmc`。同一门课理论、实验标记不同会成为两门课，这是上游的口径。注意 `text()` 会把内部连续空白也折成一个空格，比上游的 `trim()` 多做了一步，对课名无实际影响。
6. **白名单加 `xqmc` 与 `xslxbj`**（`KB_FIELDS`）。
7. **学期名兜底**：读不出学年时用「常州机电职业技术学院 第 X 学期」（`SCHOOL_NAME`）。
8. **`loginUrl` / `scheduleUrlHint` / `allowHosts`** 按任务卡：`https://webapp.czimt.edu.cn`；课表页提示含 `…/http/77726476…a2/kbcx/…?vpn-12-o1-jwc.czmec.cn…`；`allowHosts` `["jwc.czmec.cn"]`。
9. **登录页 / 门户页判断**沿用模板 `loginHint`（路径含 `login_slogin.html`、`/cas/`，或路径为 `/login`）。校内通首页、菜单页等**没有 `/kbcx/` 与 `/xtgl/` 标记**的页面统一抛「请先进入教务系统、打开课表页后再点「提取课表」」（`prefixOf` 为 `null`）。统一认证页的具体路径本件没有验证，它若不在上面三种形态里，就走第二句提示（第 8 节第 2 条）。
10. **其余层**与模板一致：周次四写法与单双归属、「共 N 周」只剥备注、教学班序号与备注括号、节次多写法、开学日回退周一与可信度判断（`plausibleStart`）、总周数收紧、H3 补时间（`fromBuiltin` / `bySequence`）、warnings 限长收口（`warn` / `shortName`）、取数对账（`total`）、缺教师 / 缺教室计数、两阶段合并（`dropExactDuplicates` / `mergeStageOne` / `mergeStageTwo`）。

H3 口径说明：本校教务节次表是 12 节，`BUILTIN_PERIOD_TIMES` 只会在教务节次表不足（例如接口只给了 10 节）时补第 11–12 节，此时补的是空课默认时间，会写进 `warnings`。课表用到第 13 节及以后时，内置表没有这一节，就从上一节下课后顺推（课间 5 分钟、每节 45 分钟）并写进 `warnings`。

## 5. 上游里删掉 / 改掉的东西及理由

1. **删掉「拾光」桥调用**：`shiguangBridgePromise.showAlert`（开场提示「导入前请确保您已成功登录教务系统」）、`showSingleSelection`（学年 / 学期选择）、`saveImportedCourses`、`savePresetTimeSlots`（`importPresetTimeSlots`）、`saveCourseConfig`，以及 `shiguangBridge.showToast`、`notifyTaskCompletion`、`console.*`。空课里由宿主负责保存，适配器只交载荷；这些桥在空课里不存在。
2. **删掉两个入口依次尝试**：上游 `fetchAcademicOptions`、`fetchSemesterStartDate`、`fetchAndParseCourses` 都写死「WebVPN 地址 → 校内直连地址」两个 `targetUrls` 并循环尝试。移植件只打当前页面所在的那一个。理由：跨主机请求会被宿主沙箱拦下，「依次尝试」在沙箱里只会多出一个失败请求；前缀由当前路径决定，两个入口的路径都能覆盖。
3. **删掉学年学期选择**：上游 `selectAcademicYearAndSemester` 与 `fetchAcademicOptions`（学年以选中项为中心取 5 个）。改成读页面上的 `#xnm` / `#xqm`（移植手册 §3 第 1 步）。
4. **整行丢课改为计数**：上游 `parseJsonData` 要求 `kcmc` / `xm` / `cdmc` / `xqj` / `jcs` / `zcd` 六个字段全都非空，缺教师或缺教室的课整行丢掉。移植件只要求课名、星期、节次、周次；教师与教室没有就留 `null`，跳过的行按原因计数写进 `warnings`，缺教师 / 缺教室的已导入课也汇总计数（`long-warnings` 与 `basic` 钉住）。
5. **周次解析修正**：上游 `parseWeeks` 只认 `/(\d+)-(\d+)周/` 与 `/^(\d+)周/`，`1-16(单周)` 一个都匹配不上，整段周次塌成空数组，这门课被静默丢掉；上游的单双判断是逐个逗号段看 `includes('(单)')`，所以「(单)1-8周,(双)9-16周」与「1-8周(单),9-16周(双)」本身能读对；但写成「1-16(单周)」的整段被 `parseWeeks` 的正则漏掉、这门课静默丢掉，写成「1-16周单」的则因为没有「(单)」字样被当成每周都上。移植件认四种写法，单双标记按相邻关系归属，括号里的教学班序号先摘掉。
6. **节次解析放宽**：上游 `jcs.split('-')` 认不出「第9-10节」「1,2」「0102」，多段只取首尾。移植件按 `sectionsOf` 处理，多段按最大跨度放入并在 `warnings` 里说明。
7. **开学日与总周数**：上游 `semesterStartDate` 取校历第 1 周的 `rq`（失败退到 `zcrq`，都失败就 `null`），`semesterTotalWeeks` 写死 20。移植件同样取校历，开学日回退到那一周的周一（`plausibleStart` 判断日期是否落在本学期的合理窗口内），总周数优先用校历，课表里更晚的周次会把总周数抬上去，抬了都写进 `warnings`。
8. **同课合并**：上游不合并，同一门课的多行原样输出。移植件沿用模板的两阶段合并。合并不改任何一周的安排，只合并首尾相接的节次与同节次周次的并集（`merge-consecutive` 钉住）。
9. **节次时间**：上游写死 12 节（`TimeSlots`）且只在导入成功后存为预设。移植件先请求 cxRjc；取不到才用这张 12 节表（逐节照抄），并把「用的是内置节次时间」写进 `warnings`。
10. **主机不写死**：上游三个 URL 都带 `https://webapp.czimt.edu.cn/http/77726476…` 与 `http://jwc.czmec.cn`。移植件改成当前页面的前缀 + `origin`，`extract.js` 代码里没有任何主机名。
11. **学生信息**：上游把整个课表响应交给解析函数，不涉及外发；移植件按字段白名单挑，`xsxx` 与学号等一律不交出去。

## 6. 变异测试记录

变异改的是**副本**：每个副本在临时目录里是整目录复制（目录名同样是 `czimt`，否则 `check.js` 会因 `manifest.key` 与目录名不一致报错），只替换副本的 `parse.js`，真文件没有被变异脚本写过。每条替换要求恰好命中 1 次，然后跑 `check.js`，记录哪些 fixture 变红。

| 变异 | 改了什么（`parse.js` 里的原文 → 改坏成） | 变红的 fixture | 变红的表现 |
|---|---|---|---|
| M1 | 内置 12 节表第 5 节开始时间 `13:45` → `13:55` | 5：basic、merge-consecutive、no-calendar-overweek、long-warnings、week-markers | 第 5 节 `start` 实际 `13:55`，期望 `13:45`。这 5 个用例都在取不到节次时间时整张用本校表；calendar-weekday 不红，它的节次时间来自教务接口 |
| M2 | 地点拼接 `room ? (campus ? room + '(' + campus + ')' : room) : ''` → `campus ? room + '(' + campus + ')' : room` | 2：basic、long-warnings | 教室为空、只有校区时地点变成「(校区)」，而不是 `null`（basic 里的「人体解剖学」与 long-warnings 里的「跨境电子商务…」会多出地点）。这正是任务卡点名的坑 |
| M3 | 课名拼标记 `if (kindMark) name = name + kindMark;` → 删掉 | 1：basic | 「大学物理(理论)」与「大学物理(实验)」合成一门，课数与 blocks 都变 |
| M4 | 「共 N 周」剥离 `/共\s*[0-9]+\s*周?/g` → `/共.*$/g`（从「共」删到行尾） | 1：week-markers | 「1-8周(共8周),9-16周」的 9-16 周被一起吞掉，「共16周,1-15周(单)」整行丢课，`week-markers` 的课程数与周次都变 |

**还原校验**：变异前后 `parse.js` 的内容在真文件上未被改写（变异脚本只写副本）；真文件跑 `check.js` 结果 `RESULT: PASS`，6 个 fixture 全部 MATCH。

## 7. fixtures 与自检

6 对合成用例（`_note` 里写明是编造的，课程、教师、教室、校区均为虚构，无真实个人信息）：

| 用例 | 覆盖什么 |
|---|---|
| `basic` | 节次时间取不到 → 本校 12 节表逐节钉住（第 5 节 13:45–14:25、第 12 节 20:20–21:00）；课表排到第 13–14 节 → H3 顺推补时间并写 warnings（21:05–21:50、21:55–22:40）；校历取不到 → 推算开学日 2026-08-31、总周数 20 周；教室+校区拼接、只有校区没有教室 → 地点为空并计入缺教室；`xslxbj` 拼进课名、同一 `kcmc` 理论 / 实验是两门；单双周；缺教师照常导入；集中实践课 |
| `merge-consecutive` | 同课同日同教室 1-2 与 3-4 合并成 1-4；完全重复的 3-4 行只留一条；1-8 周与 9-16 周取并集 1-16；1-2 与 4-5 中间隔一节不合并；同名不同教师是两门课 |
| `calendar-weekday` | 校历第 1 周的 `rq` 给周三 2026-09-09 → 开学日回退到周一 2026-09-07（`rq` 字段路径）；节次时间接口给出完整 12 节 → 用教务的，不用内置表；节次写成「第3-4节」与「9-10」；教室+校区拼接 |
| `no-calendar-overweek` | 第二学期；校历取不到 → 推算开学日 2026-02-16（2 月 20 日所在周的周一）；课表最大周次 21 → 总周数抬到 21 并写明；节次时间取不到 → 内置 12 节，第 11–12 节逐节用它；教师与教室都缺的课照常导入 |
| `long-warnings` | 三门课名 21 字的长课缺教师（其中一门还缺教室），一门 18 字课缺教室 → 提醒按类型汇总、点名的课名截到 20 字、指向「编辑课程」；一行周次写法认不出（28 字）→ 跳过并截断点名；集中实践课四门（首个 22 字）→ 只点名前三个并加「等」；每条不超 200 字 |
| `week-markers` | 单/双标记归属与「共 N 周」剥离：`(单)1-8周,(双)9-16周` 与 `1-8周(单),9-16周(双)` 都读成 1–7 单周 + 10–16 双周；`1-15周(单) 共16周` 只读 1–15 单周；`1-8周(共8周),9-16周` 只剥括号备注、9–16 周不丢；`共16周,1-15周(单)` 只剥开头备注、不整行丢课 |

自检：`node D:/NullClass/.test/port-batch5/tools/check.js D:/NullClass/jw-adapters/czimt` 最后一行 `RESULT: PASS`，6 个 fixture 全部 MATCH。期望值是先按代码逻辑手工推演写入的（日期的星期用日历算），再由自检比对，没有把 `parse.js` 的输出直接存成期望。

## 8. 没能确定的事与已知风险（我们没有本校账号，真机没验过）

1. **真实部署未验证**：「校内通」下的正方是否有 cxRjc（节次时间）与 cxZcByXnxq（学期周次校历）两个菜单，以及它们的返回形状，没有账号无法验证。取不到就是 `null`，回落并写 `warnings`，不影响导入。
2. **登录页与门户页的路径未验证**：任务卡只给了「校内通」首页与统一认证页的概念，没有给具体路径。本件把「没有 `/kbcx/` 与 `/xtgl/` 标记」的页面统一当成「还没进入教务」，提示语「请先进入教务系统、打开课表页后再点「提取课表」」对登录页与首页都适用；`/cas/` 与 `/login` 路径走「请先登录」。若校内通的统一认证页用别的路径，学生会看到第一句提示，而不是「请先登录」，这是可接受的兜底，但需要真机核对。
3. **同步抛错**：统一认证页、首页、登录页都是**同步**抛出提示（§1.1 场景 4a–4c）。宿主若只接 Promise 的 reject，这几种情况的提示会丢。模板也是同样写法，宿主是否按同步异常处理，本件没有验证，需要确认。
4. **WebVPN 路径与查询串**取自上游脚本：`/http/77726476706e69737468656265737421fae042d2242a65557d468aa2`（课表页提示）与 `vpn-12-o1-jwc.czmec.cn`（查询串默认片段）。脚本会优先沿用当前页面的 `vpn-…` 片段与前缀，但若学校更换 WebVPN 映射或改了路径，`loginUrl` 与 `scheduleUrlHint` 两行要跟着改。
5. **校历字段的匹配方式与上游略有不同**：上游用「字符串中任意位置的 `YYYY-MM-DD`」从 `rq` 取日期，`rq` 为空才看 `zcrq`；移植件的 `isoOfAny` 要求日期在字符串开头，且先看 `zrq` / `zcrq` 再看 `rq`。`rq` 若是「第1周 2026-09-07」这类前面带文字的写法，移植件认不出，会回落到推算并写明，不会写错日期，但会少用一次真实校历。上游在第 1 周行缺失时会退到 `json[0]`，移植件则直接推算。
6. **节次时间表来自上游 `TimeSlots`**，逐节照抄，没有与学校实际作息核对过。教务节次时间接口取得到时以教务为准；取不到时导入预览会提示核对。
7. **开学日推算的锚点**（第一学期 9 月 1 日所在周的周一、第二学期 2 月 20 日所在周的周一）是模板通用规则，未核对常州机电职业技术学院的实际开学日。推算结果都写进了 `warnings`，请学生核对。
8. **学期只能是页面上选中的那个**：要导入别的学期，用户要先在教务页面里切换再点「提取课表」。上游的学期选择框没有移植（§5 第 3 条）。
9. **课名标记拆课**：上游口径是 `kcmc + xslxbj`，同一门课理论、实验标记不同会拆成两门。这是上游原有的行为，本件照搬，如果学生反馈这会导致重复课，应当在这里改，而不是在 `extract.js` 里改。
10. **`allowHosts` 只写了 `jwc.czmec.cn`**：这是任务卡给定的值，理由见 §3 第 3 条。若校内直连的主机变化，这一行要跟着改。

## 9. 签名

移植与审计：0x7E7-2023（haiku 移植，2026-10-20）。
上游出处：`shiguang_warehouse` → `CZIMT/czimt.js`（快照 commit `19a65bf07a3e998fcfc69cee692387cdc0523c1a`，2026-10-19 拉取；本校脚本最后修改 `80e30cf`，2026-09-23，MIT，维护者 ShallowY）。

## 审计修正（2026-10-20）

- **周次前缀标记误吞上一段的后缀**：`parse.js` 的 `weeksOf` 里，前缀写法的正则 `(单)1` 没排除标记前面紧挨着上一段（数字或「周」）的情况，
  把上一段的后缀 (单)/(双) 当成下一段的前缀：`1-8周(单) 9-16周(双)` 被读成 1-16 每周；`1-8周(单)9-16周` 被读成 1-15 单周，9-16 周的双周丢了；
  `1-16周(单) 17-18周` 被读成 1-17 单周，第 18 周丢了。
- 修正：标记前面紧挨着数字或「周」（中间可有空白）时按后缀归给前一段，只有在段首（字符串开头或分隔符之后）才当后一段的前缀；
  后缀后面直接跟着下一段数字时补一个逗号隔开。`(单)1-8周,(双)9-16周`、`1-8周(单),9-16周(双)`、`1-15周(单) 共16周` 等原有写法行为不变。
- 新增 fixture `week-adjacent`（三个反例；期望值按周次集合手推：1-7 单 + 10-16 双；1-7 单 + 9-16 每周，合并为 1-9 单 + 10-16 每周；1-15 单 + 17-18 每周，合并为 1-17 单 + 18 每周）。版本号 1.0.0 → 1.0.1。
- 已知取舍：`(单)1-8周 (双)9-16周`（前缀写法、段间只有空格）里的 `(双)` 前面紧挨「周」，按上述规则会被当作前一段的后缀；与后缀写法 `1-8周(单) 9-16周(双)` 在形态上无法区分，未见真实样本，按上述规则取后缀。
