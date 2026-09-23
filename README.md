# NullClass-adapters —— 空课教务适配器库

[空课 NullClass](https://github.com/0x7E7-2023/NullClass) 的教务适配器库：**一个学校一个子目录**，加上根目录的 `index.json`。
主仓库以 git submodule 的形式挂在 `jw-adapters/`，构建时打进 APK 成为「内置适配器」；
任何人 fork 本仓库、托管自己的 `index.json`，就是一份可被空课直接引用的第三方适配器库
（在应用里填 `https://github.com/<你>/<仓库>` 即可）。

## 目录结构

```
index.json              库索引（列出本仓库所有适配器）
<school-key>/
  manifest.json         清单：学校名、登录页、脚本名、白名单域名、fixture 列表
  extract.js            在已登录的教务页面里执行，抓取数据
  parse.js              把 extract 的输出转成课表载荷（可省略，省略时 extract 输出即载荷）
  fixtures/
    *.extracted.json    extract.js 的真实输出样例（脱敏）
    *.expected.json     对应的课表载荷期望值
```

## 提交一个适配器

1. 复制 `ustc/` 或 `dlutci/`（两个真实学校的适配器）改个 `key`（小写字母/数字/连字符，2-40 字符），改 `manifest.json`（别忘了 `initial`：学校名拼音首字母，多音字按实际读音，如长春 → `C`）；
2. 写 `extract.js`（DOM 抓取或同源请求）与 `parse.js`；
3. 在浏览器里跑通，把**脱敏后的** extract 输出与期望载荷放进 `fixtures/`；
4. 在 `index.json` 里加一条；
5. 本地跑回归（CI 会用 Rhino 实跑你的 `parse.js` 对 fixture 比对）：
   ```sh
   git clone --recursive https://github.com/0x7E7-2023/NullClass.git
   cd NullClass/jw-adapters   # 这里就是本仓库，在这里改、在这里提交
   cd .. && ./gradlew :importer:test
   ```
6. 向本仓库提 PR。

完整规范（契约、字段、安全规则、审计要求）见主仓库的 [`docs/jw-adapter-spec.md`](https://github.com/0x7E7-2023/NullClass/blob/main/docs/jw-adapter-spec.md)，
移植与测试见 [`jw-adapter-porting.md`](https://github.com/0x7E7-2023/NullClass/blob/main/docs/jw-adapter-porting.md)、
[`jw-adapter-testing.md`](https://github.com/0x7E7-2023/NullClass/blob/main/docs/jw-adapter-testing.md)。
没有能力写适配器？[提交适配请求](../../issues/new?template=jw-adapter-request.md)。

## 通用适配器（`universal`）

`universal/` 是**兜底手段**，不是写新适配器时的模板：它不认学校，地址由用户现场输入，
靠「把页面量成文字 + 坐标，交给应用的表格结构层还原」来支持任意学校。
写具体学校的适配器时请照 `ustc/`、`dlutci/` 的样子做——又快又准，也不用让用户自己填地址。

## 注意

- **`key` 不能与已合并的适配器重复**，也不能用内置适配器的 key 覆盖它们。
- 合并进主线的适配器会被**逐个人工审计**（脚本全文 + 请求目标）。
- 用户自己导入的适配器不受审计保护：安装界面会明确提示，安全性由用户自负。
- 合并到本仓库后，要等主仓库更新 submodule 指针并发版，才会随 APK 内置。
