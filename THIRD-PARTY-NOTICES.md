# 第三方组件声明 · dsh-pocket

本文件列出 `dsh-pocket-plugin` 分发内容里的第三方代码、各自的许可证，以及 MIT 许可证全文。

三条口径，先说清楚：

1. **随本仓库分发的代码**（vendored 源文件、提交进仓库的构建产物）——必须复现其版权行，下面逐条给出。
2. **只作为 npm 依赖安装的组件**——不随本包的 tarball 分发，由包管理器按各自包内 `LICENSE` 安装。这里的义务由 `node_modules/<pkg>/LICENSE` 满足，本文件只做索引，不复述含个人署名与联系方式的原文。
3. **传递依赖**（`mqtt` 自己的依赖树）——同样由包管理器解析安装，许可证以各包内 `LICENSE` 为准。本文件只列**直接依赖**与被 vendored/提交进仓库的代码，不逐一枚举传递依赖；需要完整清单时，安装后遍历 `node_modules` 即可（pnpm 布局下在 `node_modules/.pnpm`）。

## 清单

| 组件 | 版本 | 许可证 | 用途 | 分发方式 |
| --- | --- | --- | --- | --- |
| [`mqtt`](https://github.com/mqttjs/MQTT.js) | 5.16.1 | MIT | 电脑端与手机端连 MQTT broker（中继） | 直接依赖（`package.json`） |
| [`ws`](https://github.com/websockets/ws) | 8.22.0 | MIT | 电脑端 WebSocket 服务端；中继内部 WebSocket 客户端 | 直接依赖（`package.json`） |
| `qrcode.mjs`（QR Code Generator for JavaScript，作者 Kazuhiko Arase） | 单文件构建 | MIT | 配对二维码编码，vendor 进仓库 | vendored：`lib/vendor/qrcode.mjs` |
| `mqtt.min.js`（即 `mqtt` 的浏览器构建产物） | 与上表 `mqtt` 一致 | MIT | 手机端在浏览器里连 broker | 构建产物：`docs/mqtt.min.js`，随 `docs/` 提交 |

两个直接依赖的全部依赖只有这两个包（`package.json:dependencies`），没有 devDependencies。

## 逐条说明

### 1. `mqtt`（MQTT.js）— MIT

- 上游：<https://github.com/mqttjs/MQTT.js>
- 版本由 `pnpm-lock.yaml` 锁定为 `5.16.1`，`package.json` 里写的是**精确版本** `5.16.1`（不是 `^`）：这个依赖有被提交进仓库的构建产物，范围漂移会让 `docs/mqtt.min.js` 的字节失去确定性。
- 版权行（上游 `LICENSE.md`）：`Copyright (c) 2015-2016 MQTT.js contributors`。
- **有一份被提交进仓库的构建产物**：`docs/mqtt.min.js`。它是 `node_modules/mqtt/dist/mqtt.min.js` 的逐字节复制（`tools/build-shell.mjs` 里的 `MQTT_DIST` 与 `entries.set('mqtt.min.js', mqtt)`），随手机端外壳一起静态托管。因此这一份**是**本仓库在分发 `mqtt` 的代码，MIT 的署名要求由本文件满足。
- 升级方式：改 `package.json` 的版本范围 → `pnpm install` → `node tools/build-shell.mjs` 重新生成 `docs/`（`node tools/build-shell.mjs --check` 会在 CI 里发现产物没更新）。

### 2. `ws`（WebSocket client & server）— MIT

- 上游：<https://github.com/websockets/ws>
- 版本锁定为 `8.22.0`（`package.json` 里是精确版本 `8.22.0`，不是范围）。
- 不随本仓库分发二进制或源码副本；由 npm 安装到 `node_modules/ws`，其 `LICENSE` 随之分发。版权行以上游 `LICENSE` 为准。

### 3. `lib/vendor/qrcode.mjs` — MIT，Kazuhiko Arase

- 上游：<https://github.com/kazuhikoarase/qrcode-generator>（单文件构建 `qrcode.mjs`）
- 版权行（文件头，`lib/vendor/qrcode.mjs:1-15`）：`Copyright (c) 2009 Kazuhiko Arase`。
- **未做任何修改**：逐字节复制上游单文件构建，只在尾部保留/添加 `export const qrcode` 与 `export default qrcode` 两个导出。详见 `lib/vendor/README.md`。
- 只用到编码器 API：`qrcode(typeNumber, errorCorrectionLevel)`、`addData`、`make`、`getModuleCount`、`isDark`。
- 为什么 vendor 而不装依赖：只需要一个二维码编码器，为约 50 KB 的稳定 MIT 代码引入一棵新的依赖树不划算；同时锁定字节，保证配对二维码不会因为上游悄悄变化而变。
- 升级方式：用上游新文件替换 `qrcode.mjs`，保留尾部的两个导出，再跑 `node --check lib/vendor/qrcode.mjs`。插件里没有任何代码改它的行为。
- 注意："QR Code" 是 DENSO WAVE INCORPORATED 的注册商标。

### 4. `docs/mqtt.min.js`

见上面第 1 条：它是 `mqtt` 的浏览器构建产物，随 `docs/` 提交，属"本仓库分发第三方代码"。不要手工编辑这个文件——它由 `node tools/build-shell.mjs` 生成，`--check` 会按 `tools/build-shell.mjs` 里钉住的 `MQTT_DIST_SHA256` 校验它的字节。

## 本项目自身

`dsh-pocket-plugin` 以 MIT 许可发布，见 [LICENSE](LICENSE)。`web/`、`remote/`、`lib/`、`bin/`、`tools/` 下除上述 vendored 文件与构建产物外，均为本项目原创代码。

## MIT License 全文

以下全文适用于上表中标记为 MIT 的组件。各组件分别保留其上面的版权行。

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 维护提示

- 增删依赖时同步改这张表，并在 `package.json` 里保持 `license` 字段与实际一致。
- 升级 `mqtt` 后必须重新生成 `docs/`（`node tools/build-shell.mjs`），否则 `--check` 会在 CI 里失败——这是有意的，防止外壳里的 broker 客户端与测试所用版本悄悄错位。
- 新增 vendored 文件时，在 `lib/vendor/README.md` 记录上游、版本/日期、改动说明，并在这里加一行。
