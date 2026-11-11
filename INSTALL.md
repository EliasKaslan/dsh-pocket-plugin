# 安装与运维指南（给 agent / 排障用）

> 这份文件不是给人读的产品介绍。人读 [`README.md`](README.md)。
> 这里的每一条命令都在 Windows + Node 24 上实跑过；涉及路径的地方按你的实际位置替换。

---

## 1. 前置条件

| 项 | 要求 | 怎么验 |
|---|---|---|
| DSH | 能正常启动，且你有一个可写的 profile | `$env:DSH_HOME`（默认 `%USERPROFILE%\.dsh`） |
| Node.js | ≥ 22.15（`package.json` 的 `engines`） | `node -v` |
| 网络 | 装依赖要能访问 npm；插件运行时要能连 broker（出站 `wss://`） | — |

插件是 **bundle** 形态：它的 `package.json` 里 `dsh.bundle.patch` 指向仓内的 `cordis.patch.yml`，
DSH 把它当作一层补丁叠进 profile。所以安装要做两件事：**登记为 bundle** + **让包名可解析**。
只加依赖不够 —— `dsh.profile.bundles` 里没有这一行时，插件不会被加载。

---

## 2. 推荐：让 DSH 自己装（一步到位）

用 DSH 的插件管理器，以本地 `link:` 规格安装（Windows 路径用正斜杠）：

```
plugin_manager(action: "install_bundle", target: "link:D:/path/to/dsh-pocket")
```

成功判据：返回里 `application: "applied"`，且 `packageResult.exitCode: 0`。

它会把三件事一次做完，并且写进正确的文件：

1. `$DSH_HOME/profiles/<profile>/package.json` 的 `dependencies` 里加 `"dsh-pocket-plugin": "link:<你的路径>"`
2. 把 `dsh-pocket-plugin` 追加进同一文件的 `dsh.profile.bundles`
3. 跑一次 pnpm，让 `node_modules/dsh-pocket-plugin` 正确指向你的目录

**不要手工 `mklink` 建 junction**（除非走第 3 节的手写路径）：pnpm 不认识手建的链接，
下一次依赖变动就可能把它冲掉。

---

## 3. 等价手写安装（实现原理 / 排障用）

只有插件管理器不可用时才走这条。

改 `$DSH_HOME/profiles/<profile>/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-pocket-plugin": "link:D:/path/to/dsh-pocket"   // 你 clone 下来的目录
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-pocket-plugin"                             // 关键：缺这行插件不会被加载
      ]
    }
  }
}
```

然后让包名可解析（两种，优先第一种）：

```powershell
# 优先：正常装依赖
pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>"

# 最后手段（pnpm 装不了时）：手工建 junction
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-pocket-plugin" "D:\path\to\dsh-pocket"
```

---

## 4. 配置

配置写在**同一个 profile** 的 `cordis.patch.yml` 里，按 id 覆盖 bundle 已经插入的那一行
（**不要**再复制一份 `- insert:`，否则会出现两行同名插件）：

```yaml
- id: pocket
  config:
    port: 47901
    serverName: ''
    qrFile: ''
    cloud:
      enabled: true
      appBase: 'https://<你的账号>.github.io/dsh-pocket-plugin/'
```

### 4.1 插件配置键

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `47901` | 回环 HTTP 端口。被占用时自动顺延（47901 → 47902 → …）。**监听地址不可配，恒为 `127.0.0.1`** |
| `serverName` | `''` | 手机端显示的电脑名；留空显示「我的电脑」（不泄露主机名） |
| `qrFile` | `''` | 二维码 PNG 落点。空 = `~/dsh-pocket-qr.png`；填绝对路径改位置；填 `false` 不写文件（仍可在 `/pair` 页面扫码） |
| `authRequired` | `true` | 是否要求口令。设为 `false` 只有在同时开 `cloud.allowAnonymous` 时才有意义，**别关** |
| `allowedRoots` | `[]` | 允许手机创建任务的工作目录白名单；为空时 fail-closed（403 `cwd_forbidden`） |
| `allowedHosts` | `[]` | 额外允许的 Host 头（一般不用） |

### 4.2 中继配置键（`cloud.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | 随 bundle 为 `false` | 中继总开关。**默认关闭，要显式开** |
| `appBase` | `''` | 手机端静态外壳地址（`docs/` 部署到哪）。**空 = 起不来**，这是有意的：外壳是一段会在你手机上跑的代码 |
| `broker` | `wss://broker-cn.emqx.io:8084/mqtt` | 公共 MQTT broker，只承载密文。可换自建；支持数组（≤ 4 个，按序回退） |
| `allowAnonymous` | `false` | 免口令模式。仅在你自建私有 broker 时考虑 |

### 4.3 设口令（手机登录用）

- **推荐**：打开连接页 `http://127.0.0.1:<port>/pair`，在「账号 + 口令」卡片里设置/修改
- 或者命令行（**交互式**，需要真终端）：`node tools/set-auth.mjs --user <用户名>`
- 查看现状：`node tools/set-auth.mjs --status`（显示用户名、scrypt 参数、有效会话数、最早到期时间）
- 清除：`node tools/set-auth.mjs --remove`

改口令会同时清空所有登录会话 —— 所有手机必须重新登录，这是预期行为。

### 4.4 自己托管手机端外壳

手机打开的页面是 `docs/`（由 `web/` + `remote/` 构建出来的静态站），必须由你自己托管：

```powershell
node tools/build-shell.mjs          # 生成/刷新 docs/
# 把 docs/ 发布到任意静态托管（GitHub Pages / OSS / 自己的站），
# 然后把地址填进 cloud.appBase（结尾带 /）
```

改过 `web/` 或 `remote/` 之后必须重跑构建，否则 CI 的 `--check` 会红。

---

## 5. 装完验收（四条，缺一条都算没装上）

```powershell
# 1. 回环接口起来了，版本对，且要求登录
Invoke-RestMethod http://127.0.0.1:47901/api/v1/health | ConvertTo-Json -Depth 4
#   期望：started=true  ready=true  version=1.0.1  requiresLogin=true

# 2. 启动日志里有监听与二维码落点
Get-Content "$env:USERPROFILE\.dsh\pocket\bridge.log" -Tail 12
#   期望：bridge listening on 127.0.0.1:47901
#        二维码文件在 C:\Users\<你>\dsh-pocket-qr.png
#        二维码已写入 C:\Users\<你>\dsh-pocket-qr.png（<N> 字节）

# 3. 二维码真的落到个人目录
Test-Path "$env:USERPROFILE\dsh-pocket-qr.png"      # 期望 True

# 4. 连接页能打开
Start-Process http://127.0.0.1:47901/pair
```

**二维码内容必须和线上链接逐字符一致**，肉眼"看着像二维码"不算。解法：把 PNG 解码
（例如 Python `cv2.QRCodeDetector`），与下面这条接口的 `url` 比对：

```powershell
Invoke-RestMethod http://127.0.0.1:47901/api/v1/cloud/status | ForEach-Object { $_.data.url }
```

> 比对时注意 BOM：`Set-Content -Encoding UTF8` 在 PowerShell 5.1 会写 BOM，
> 读回来多一个 `\ufeff`，会让你误判"差一个字符"。读的时候用 `utf-8-sig`。

命令行也能自查（在插件目录里跑）：

```powershell
node bin/cli.mjs status      # 运行状态 + 中继状态 + 手机入口 + 已登记设备数
node bin/cli.mjs pair        # 打印二维码与链接；加 --no-qr 只打印链接
node bin/cli.mjs devices     # 列出已登记设备
```

---

## 6. 常见故障

| 现象 | 原因 | 修法 |
|---|---|---|
| 日志没有 `plugin loading` | 没登记进 `dsh.profile.bundles`，或包名解析不到 | 回第 2/3 节；确认 `node_modules/dsh-pocket-plugin/package.json` 存在 |
| `health` 502/连不上 | 端口被别的程序占了 | 看日志 `port <n> is owned by another service`；插件会自动顺延一个端口 |
| 没有二维码文件 | 三种 fail-closed：`cloud.enabled=false` / `cloud.appBase` 为空 / 没设口令 | 页面 `/pair` 会写明具体是哪一种，按提示补 |
| 手机扫码后白屏 / 404 | `cloud.appBase` 指错，或 `docs/` 没部署 | 浏览器直接打开 `appBase` 应看到「DSH 随行」启动页 |
| 改了代码但行为没变 | ESM 模块缓存，热重载只重读配置不重载代码 | **冷启动 DSH**。只改配置（`cordis.patch.yml`）可以热重载 |
| 连接页每 4 秒弹「连接已断开」 | 页面在轮询一个不存在的接口（历史版本会这样） | 当前版本已改为 `/api/v1/devices`；若是旧代码请更新 |
| 手机一直「正在连接」但列表能刷 | WS 隧道槽位被僵尸连接占满 | 重启中继（DSH 里关掉再开远程访问）；当前版本已有槽位回收 |
| `npm run verify` 报执行策略错误 | 本机 PowerShell 禁止跑 `npm.ps1` | 直接调 node（见第 8 节）；注意此时 PowerShell 仍可能回 `exit 0`，是假绿 |

### 6.1 已知限制（别当成 bug 去查）

- **手机端没有文件下载**。`/download/*` 是回环专属，中继明确拒绝它
  （`lib/cloud.mjs` 的 `DENIED_TARGETS`：`文件下载不能经中继访问`）。
  手机能看任务的对话与工具输出，但下载文件要回电脑。
- **手机端不能改配置、不能改口令**。账号/口令、设备管理与重置链接都在回环连接页上。
- **中继是第三方公共服务**，可用性不受本插件控制；断线时页面会提示重连，不会静默丢消息。
- **超长会话的转录条数有上限**（`MAX_TRANSCRIPT = 5000` 条）。超出时最早的整条会被丢掉，
  手机端顶部会显示「更早的消息已省略。」——这是内存闸，不是分页失败。

### 6.2 会话详情是分页的（脚本 / 排障用）

手机点进会话时**不会**一次拿走整份详情，而是按页取：

```powershell
# 首屏：尾部窗口（默认 40 条，并保证带上最近几次用户输入）
Invoke-RestMethod 'http://127.0.0.1:47901/api/v1/tasks/<任务 id>' -Headers @{ authorization = "Bearer <设备令牌>" }

# 更早的一页：把上一页返回的 nextBefore 当游标
Invoke-RestMethod 'http://127.0.0.1:47901/api/v1/tasks/<任务 id>?before=<nextBefore>&limit=40' -Headers @{ authorization = 'Bearer <设备令牌>' }

# 只要「某条之后」的新消息（流式输出时手机就是这么追新的，几 KB 而不是整页）
Invoke-RestMethod 'http://127.0.0.1:47901/api/v1/tasks/<任务 id>?after=<已收到的最后一条 id>' -Headers @{ authorization = 'Bearer <设备令牌>' }
```

返回字段：

| 字段 | 含义 |
|---|---|
| `messages` | 这一页的消息（已按单条 6000 字符裁剪） |
| `hasMore` | 还有更早的；为 `false` 表示已经到会话开头 |
| `nextBefore` | 下一页的游标（本页最早那条消息的 id）；`hasMore=false` 时为空串 |
| `total` | 该会话转录的总条数（翻到底后累计条数应正好等于它） |
| `offset` | 本页在转录里的起始下标 |
| `cursorLost` | 游标已失效（缓存重建/会话被改写）：此时返回的是尾部一页，客户端应重置列表 |

每页同时受两个上限约束：`PAGE_MAX = 80` 条、`PAGE_CHARS = 48000` 字符。
所以无论会话多长，**单次响应都很小**（实测最大约 49 KB），不可能再撞上中继 4 MiB 的分片预算。
游标格式非法（非 `[A-Za-z0-9_:.-]` 或超过 120 字符）会被直接拒成 `400 bad_cursor`。

---

## 7. 升级 / 卸载 / 回滚

**升级**（源码目录是 link 进来的，拉代码即可，随后冷启动 DSH）：

```powershell
git -C D:\path\to\dsh-pocket pull
```

**卸载**：

```
plugin_manager(action: "remove_bundle", target: "dsh-pocket-plugin")
```

或手工：删掉 `package.json` 里那条 `dsh-pocket-plugin` 依赖、从 `dsh.profile.bundles` 里删掉同名项，
再删 `node_modules/dsh-pocket-plugin`，然后冷启动。

**回滚到某个已知可用版本**：把 `node_modules/dsh-pocket-plugin` 指向一份该版本的克隆
（或改 `dependencies` 里的 `link:` 路径），冷启动即可。插件运行态（`~/.dsh/pocket/`）不用动：
凭据、设备与中继身份都在那里，版本切换不会丢。

> 运行态文件：`auth.json`（口令哈希）、`sessions.json`（15 天会话摘要）、`state.json`（设备）、
> `cloud.json`（中继身份）、`bridge.log`。**别手改 `auth.json`**，用第 4.3 节的办法。

### 7.1 热加载 / 热卸载（**不需要重启 DSH**）

改完插件代码想让它生效，不必重启 DSH：**把这个 bundle 关掉再打开**即可。DSH 重新
apply 时会**重新加载模块**，所以磁盘上的新代码会生效（实测：内存里跑着 1.0.0 时，
关掉再打开之后 `health.version` 直接变成磁盘上的 0.3.0）。

两种操作方式：

- **图形界面**：设置 → 插件，把「DSH 随行 / dsh-pocket-plugin」关掉，再打开；
- **让 agent 做**：`plugin_manager` 工具，`action: set_bundle`，`target: dsh-pocket-plugin`，
  先 `enabled: false` 再 `enabled: true`。

**怎么确认真的换了一份新实例**（三条任一即可）：

```powershell
# 1) bootId 变了（每次 apply 换一个）
Invoke-RestMethod http://127.0.0.1:47901/api/v1/health | % { $_.data.bootId }

# 2) 版本变成了你刚改出来的那个
Invoke-RestMethod http://127.0.0.1:47901/api/v1/health | % { $_.data.version }

# 3) 日志里成对出现「plugin disposing」与「桥接实例已创建 boot=…」
Get-Content "$env:USERPROFILE\.dsh\pocket\bridge.log" -Tail 20
```

卸载干净的判据：日志有 `plugin disposing`，且 `http://127.0.0.1:47901` 打不通
（端口只剩 `TIME_WAIT`，属于正常收尾）。

几条行为须知：

- **端口会复用**。上一个实例刚放手的一瞬间端口可能还没完全可用，插件会在顺延之前
  对首选端口重试 3 次（每次 120 ms），所以反复热重载仍然绑回 47901；只有真被别人
  占用才会顺延，并在日志里留一条 `port … is owned by another service`。
- **手机上正在连的会话会短暂断开**（服务端以 `1001 bridge reloading` 关闭 WS/SSE），
  随后自动重连。中继身份不变时二维码不变，手机不用重新扫码。
- **只有当 `cloud.json` 里的中继令牌失效时**（例如那台「远程中继」设备被移除过），
  加载时才会重建身份 —— room/key 跟着变，二维码跟着变，**手机需要重扫一次**。
  这是有意的 fail-closed 行为，不是每次热重载都会发生。
- **运行态不丢**：设备、15 天会话、中继身份都在 `~/.dsh/pocket/`，热重载只换进程内实例。
- 如果**只改配置**（profile 的 `cordis.patch.yml`），本来就热生效，连关开都不用。

回归用例：`test/integration/hot-reload.test.mjs` —— 同一进程内 apply → dispose 三轮，
断言每轮都起来、`bootId` 互不相同、端口始终复用、dispose 之后端口真的放手，以及
重复 dispose 幂等。

---

## 8. 开发与测试（CI 跑的就是这四条）

```powershell
node tools/check-syntax.mjs            # 语法（全仓 .mjs）
node --test "test/**/*.test.mjs"       # 单测 + 集成 + 中继（530+ 条）
node test/e2e/run.mjs                  # 端到端（真 HTTP 打真 server）
node tools/build-shell.mjs --check     # 外壳产物与源码是否一致
```

其它工具：

```powershell
node tools/build-shell.mjs             # 重新生成 docs/
node tools/dev-server.mjs --token <t>  # 本地开发外壳（需要一枚设备令牌）
node tools/mock-host.mjs               # 假宿主，用虚构数据开发外壳
```

**别用 `npm run verify` 自动化判断**：在本机 `npm.ps1` 被执行策略禁止时它根本不会执行，
但 PowerShell 仍可能返回 `exit 0` —— 这是假绿。要么直调上面四条 `node`，要么改用 `bash`。

---

## 9. 版本策略

**v1.0.0 已于 2026-11-11 发布。** 0.x 阶段的充分自测已完成：真手机（HarmonyOS）+
真网络下的连续进入、断线重连、向上翻页到底、流式增量、多设备并存、热重载与冷启动
都跑过；569 条单测 + 11 条 e2e 全绿。

1.0 之后的规则：

- 版本号遵守语义化版本：修 bug 发 `1.0.x`；兼容地加功能发 `1.x.0`；**破坏性改动**
  （协议、配置键、行为语义）发 `2.0.0`。
- 标签格式 `vX.Y.Z`，且必须与 `package.json` 的 `version`、`lib/util.mjs` 的
  `PLUGIN_VERSION` 三处一致；发版后跑一次 `node tools/build-shell.mjs --check`。
- 改协议（例如分页/增量契约、中继帧格式）时，必须同步更新本文 §6.2 与 §4 的配置表，
  并把 `PROTOCOL_VERSION` 一起调整；手机端外壳与桌面端插件不同步时，外壳会拒绝
  未知协议而不是静默错乱。
