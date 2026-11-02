# 上海立达学院（lidapoly）移植审计

- 上游 `resources/LIDAPOLY/lidapoly.js`，作者 Haooz；快照 `03d161a`，文件提交 `63d7600`。模板 `huse`。
- 同源请求：`GET /shldzyjsxy_jsxsd/xskb/xskb_list.do`（当前页无课表时）；`POST /shldzyjsxy_jsxsd/jxzl/jxzl_query?Ves632DSdyV=NEW_XSD_WDZM`，body 仅学期代码。
- 学期读取当前选中项，不弹窗；周历失败按最近周一和 20 周推算并提醒。只交课表和周历白名单字段，不读凭据、个人信息，不写页面。`allowHosts: []`。
- `font[title=班级]` 提供周次/节次；课名去掉 `[学分][性质]`；16 节时间逐节来自上游，第 13 节不是额外占位。
- 周次逐段判单双，重复行去重，缺教师/教室留空，无法解析的安排计数点名。
- 安全八条全部通过：无外部主机、无其他业务数据、无统计、无动态求值、无秘密。

验证：7 对合成 fixture 全部 MATCH；共享冒烟本校 6 个场景通过，含 POST 周历与失败降级；3 个变异（班级字段、16 节时间、单双归段）均被捕获。正式文件恢复后再次 PASS，`:importer:test --rerun-tasks` 通过。没有本校账号，未做真机验证；入口为 HTTP。

签名：0x7E7-2023（Kimi 移植，2026-11-02）
