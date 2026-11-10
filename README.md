# DSH 随行 · dsh-pocket-plugin

把电脑上的 [DeepSeek Harness](https://github.com/deepseek-ai) 接到手机上：看任务跑到哪一步、随时补一句话、随时中断。

**不用内网穿透，不用公网 IP，不用开端口。** 电脑端只在 `127.0.0.1` 上监听，手机唯一的通路是加密中继：手机和电脑各自向公共消息中转发起**出站**连接，中间流动的只有密文；密钥只存在于你手机扫到的那串链接里，中转服务器拿不到。

> **v1.0.0 · 首个发行版。** 手机端只需要一个凭据：电脑上设的**账号 + 口令**。登录成功时电脑自动登记这台手机并下发设备令牌，之后 15 天免密；只要还在用就一直续期，常用的手机不会掉线。

> **包名**：本项目的 npm 包名是 `dsh-pocket-plugin`。npm 上另有一个同名项目 `dsh-pocket`，两者没有关系，认准 `dsh-pocket-plugin`。

## 它能做什么

- **任务列表**：电脑上每个 DSH 会话就是一条任务，状态、模型、轮次、最后一句产出都同步到手机，断线重连按序号补帧。
- **看过程**：思考过程、工具调用、工具结果、Markdown 正文（代码块 / 表格 / 列表）都能在手机上读。
- **下发任务**：写一段话、选一个工作目录就能开工；任务跑着的时候还能追加消息。
- **中断**：一键取消正在跑的任务。
- **断网可用**：外壳是 PWA，安装后静态资源全部预缓存，飞行模式下也能打开看到上次的任务列表。

## 它是怎么连的

```
手机浏览器                    公共 broker                    你的电脑
  ├─ 从链接 # 片段取密钥 ─┐                                    │
  │  （密钥从不发给服务器） │                                    │
  ├─ AES-GCM 加密请求 ────┼──► dshm/<房间>/u  ──► 解密 ──► 127.0.0.1:47901
  └─ 解密响应 ◄───────────┼──◄ dshm/<房间>/d  ◄── 加密 ◄── DSH 插件
```

房间号与密钥都是随机的，只在二维码链接里出现；broker 上看不到任务内容、看不到设备令牌，也看不到你在哪个目录里干活。

**中继是手机唯一的通路。** 没设口令、没配 `cloud.appBase`、或 broker 连不上时，手机就连不上；配对页会直接写明是哪一种（`未配置` / `已阻止` / `连接失败`），不会给一个备用地址。

## 安装

要求：DSH 已能正常启动；Node.js ≥ 22.15。

插件是 **bundle** 形态：`package.json` 的 `dsh.bundle.patch` 指向仓库里的 `cordis.patch.yml`，DSH 把它当作一层补丁叠进 profile。所以安装要做两件事 —— **登记为 bundle** + **让包名可解析**。

只加依赖不够：`dsh.profile.bundles` 里没有这一行时，插件不会加载。

```jsonc
// $DSH_HOME/profiles/<你的 profile>/package.json
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

```powershell
# 让包名可解析（不用联网）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\<你的 profile>\node_modules\dsh-pocket-plugin" "D:\path\to\dsh-pocket"
```

装完重启 DSH，启动日志里应出现 `plugin loading; data=<数据目录>` 与 `bridge listening on 127.0.0.1:<port>`（`lib/index.mjs:35`、`lib/core.mjs:624`）；没有就回去检查 `bundles` 与 `node_modules` 链接。

要改配置就在同一个 profile 的 `cordis.patch.yml` 里按 id 覆盖（**不要**再复制一份 `- insert:` 行）：

```yaml
- id: pocket
  config:
    port: 47901
    cloud:
      enabled: true
      appBase: 'https://你的账号.github.io/dsh-pocket-plugin/'
```

配置改动热重载生效；改了插件代码必须冷启动（ESM 模块缓存）。

## 首次配置：三件事

### 1. 设账号 + 口令

```bash
# 交互输入，不回显，不进命令历史
node tools/set-auth.mjs --user 你的名字
```

这里填的**账号**就是手机上要输的用户名（配对页会显示真实值）。忘了账号用 `node tools/set-auth.mjs --status` 查。没有口令时中继不会启动。

### 2. 托管外壳，填 `cloud.appBase`

```bash
node tools/build-shell.mjs     # 生成 docs/：可直接静态托管的外壳
#    把 docs/ 整个目录发布到 GitHub Pages / OSS / 你自己的静态站
#    把那个地址填进配置的 cloud.appBase（结尾带 /），enabled 改成 true，重启 DSH
```

`cloud.appBase` **故意没有默认值**：外壳是一段会在你手机上执行的代码，如果把某个第三方地址写成默认，等于让每一次安装都去信任同一个人的账号。

### 3. 取二维码

中继起来之后，二维码固定在**你的个人目录**：

- Windows：`C:\Users\<你>\dsh-pocket-qr.png`
- macOS / Linux：`~/dsh-pocket-qr.png`

链接不变就不重写；中继身份轮换后自动更新。也可以随时打开 `http://127.0.0.1:47901/pair`（实际端口见 `/api/v1/health`）：二维码、账号提示、已登记设备、中继状态都在这张页面上，它只在回环可访问。

## 手机怎么连

1. **扫二维码**，手机浏览器打开外壳。
2. **输入账号 + 口令**，登录成功就进入任务列表——电脑端在同一刻自动登记这台手机。
3. **之后不用再输口令**：登录一次有效期 15 天；只要还在用就滑动续期（每 24 小时最多续一次），所以常用的手机不会掉线。连续 15 天没连过才需要重新登录。手机侧令牌用 AES-GCM 封装后才写 localStorage；登录页没有「记住我」勾选框。

设备身份按手机本地生成的 `installId` 认：

- 同一台手机重连或重新登录，复用同一条设备记录，不会越登越多。
- 多台手机可以并存，不会互相顶掉。
- 在电脑端移除某台设备后，那台手机带着旧令牌重连会明确收到 `revoked`，令牌作废且不会自动补发，必须回到登录页重新输入账号 + 口令。
- 改口令会让所有手机立刻失效。

手机浏览器登录后就是 App；「添加到主屏幕」之后像原生应用一样打开。

## 配置

插件配置写在 profile 的 `cordis.patch.yml` 那一行 `config:` 下。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `47901` | 回环端口；监听地址恒为 `127.0.0.1`，被占用时自动顺延（47901 → 47902 → …），实际端口看 `/api/v1/health` 的 `port` |
| `serverName` | 留空显示「我的电脑」 | 手机上显示的名字，**不会**默认用主机名 |
| `qrFile` | `~/dsh-pocket-qr.png` | 二维码 PNG 的落点；填绝对路径改位置，填 `false` 则不写文件（仍可在 `/pair` 页面看到二维码） |
| `cloud.enabled` | `false` | 是否启用中继。要同时有口令和 `appBase` 才能起来，缺一个都不启动 |
| `cloud.appBase` | `''` | 你自己托管的手机端外壳地址（结尾带 `/`）。**留空 = 连不上**，故意没有默认值 |
| `cloud.broker` | `wss://broker-cn.emqx.io:8084/mqtt` | 消息中转地址，可以是字符串或数组（最多 4 个，按顺序回退）；可换成自建 broker |

另有 `allowedRoots`（允许作为任务工作目录的根，留空 = 只允许你在 DSH 里打开过的工作区）与 `allowedHosts`（仅在本机反代预览时才需要），日常不用碰。

数据目录默认在 `$DSH_HOME/pocket`（在仓库之外），里面有 `state.json`（设备记录，令牌只存哈希）、`auth.json`（账号与口令的 scrypt 哈希）、`sessions.json`、`cloud.json`（中继房间与密钥）、`runtime.json` 和 `bridge.log`。其中 `auth.json`、`state.json`、`sessions.json`、`runtime.json`、`*.log` 与 `*-qr.png` 已在 `.gitignore` 里排除；`cloud.json` 同样不该入库，别把整个数据目录拷进仓库。

## 命令行

```bash
node bin/cli.mjs pair            # 中继链接 + 二维码 + 登录账号（别名 link）
node bin/cli.mjs status          # 运行状态、中继状态、已登记设备数
node bin/cli.mjs devices         # 已登记设备
node bin/cli.mjs revoke <id|all> # 撤销某台（或全部）设备
node bin/cli.mjs broker [url]    # 查看 / 临时切换中继地址
```

也可以用包装出来的命令 `dsh-pocket-plugin <子命令>`。这些接口只在电脑本机（回环）可用，从手机侧调用一律 403。

## 本机接口

- `GET /api/v1/health`：未鉴权，只回版本、协议、实际端口、运行时长与 `requiresLogin` 等公开字段，不含任务数、设备数与绝对路径。
- `GET /api/v1/devices`：列出已登记设备（回环可用）。
- `POST /api/v1/devices/:id/revoke`：撤销某台设备（回环可用）。
- `POST /api/v1/self/revoke`：手机侧自助撤销当前设备（中继白名单内）。

配对页、设备管理与中继管理都不会被中继转发；手机能触达的只有手机 UI 真正需要的那几条路由。

## 安全模型

**做了什么**

- **只监听回环**：监听地址硬编码为 `127.0.0.1`，没有任何配置项能改成 `0.0.0.0` 或内网地址。跨网时电脑是 broker 的**客户端**，主动向外拨 `wss://`，没有入站端口，NAT 与防火墙都不用动。
- **端到端加密**：请求与响应都用 AES-256-GCM 封装，每帧一个新随机 IV；AAD 绑定房间话题名**且区分方向**（上行 `…/u`、下行 `…/d`），把密文挪到别的话题或反方向重放都会解密失败；密钥只存在于链接的 `#` 片段，浏览器不会把它发给任何服务器。
- **中继请求不提权**：转发进本机的请求带一个每进程随机标记，插件看到标记就一律当作远程（哪怕源 IP 是 `127.0.0.1`）；客户端自带的同名头在转发前被整体剥掉，标记只由中继自己加。
- **中继路由白名单**：只有手机 UI 需要的路由能被代理进来；配对页、设备管理、中继管理、`/healthz`、`/download/*` 在中继侧直接拒绝。
- **口令闸门**：口令只存 scrypt 哈希（N=16384），校验用 `timingSafeEqual`；用户名错也会照跑一次，避免用耗时区分「账号错」和「口令错」。
- **设备令牌**：`dshb_` + 32 字节随机数，状态文件里只存哈希；撤销时正在连的 WebSocket 立刻以 4001 断开，旧令牌不会被自动补发。
- **按设备身份登记**：设备按手机自报的 `installId` 认，同一台手机重登是原地轮换同一条记录，多台手机并存不互相顶掉。
- **15 天免密 + 滑动续期**：每 24 小时最多续一次，连续 15 天没连才失效；手机侧令牌用 AES-GCM 封装后才落 localStorage。
- **本机守门**：所有路由先校验 `Host`（防 DNS rebinding）；写操作依次校验 `Sec-Fetch-Site`、`Origin` 与本进程 CSRF token；响应头带 CSP、`frame-ancestors 'none'`、`nosniff`、`no-referrer` 等。
- **工作目录白名单**：任务目录先 `realpath` 再按路径段比较，符号链接跳不出去；空列表 = 全关，不是全开。

**没有做 / 做不到**

- broker 能看到**元数据**：房间名、消息大小、收发时间、你的出口 IP。足以做流量分析，但看不到内容。
- 中继的登录失败预算只有「整条链路共享」这一层（10 次/分钟），**没有按来源分桶**：陌生人持续乱试可以把你挡在门外最多一分钟（拿不到口令，但能恶心你）。
- **链接等同凭据**：拿到二维码/链接的人可以打开外壳并尝试登录；链接泄露就在配对页点「重置链接」，旧码立刻作废。
- 中继是**第三方公共服务**，不保证可用性；介意就自建（`cloud.broker` 接受任意 MQTT over WSS 地址）。
- `cloud.appBase` 指向的外壳是「谁来提供这段前端代码」的信任点：它拿不到明文（没有密钥），但可以读到你输入的口令，也能读到你解密后的内容——所以要自己托管。
- Windows 上状态文件的 `0600` 权限位是 no-op（`chmod` 被吞），安全性依赖 `%USERPROFILE%` 的 NTFS 默认 ACL。
- 电脑被物理接触、或手机解锁后被人拿走，这套机制帮不了你——该撤销设备就撤销。

更完整的威胁模型与代码位置见 [SECURITY.md](SECURITY.md)。

## 常见问题

**手机连不上？**
按这个顺序看配对页「远程访问」那一栏：`未配置` = `cloud.appBase` 为空；`已阻止` = 还没设口令；`连接失败` = broker 不通，换一个（`cloud.broker`）试试。三项都正常还连不上，就是手机没有从你托管的外壳地址打开。

**找不到二维码？**
固定位置是 `~/dsh-pocket-qr.png`（Windows：`C:\Users\<你>\dsh-pocket-qr.png`）。中继没起来时不会有新二维码，先看连接页写的状态；用 `qrFile` 可以改路径或关掉文件，改用 `/pair` 页面扫码。

**端口不是 47901？**
被占用了，插件自动顺延。以 `/api/v1/health` 返回的 `port` 为准。

**改了插件代码没生效？**
ESM 模块缓存：必须重启 DSH。只有 `cordis.patch.yml` 的配置改动是热重载的。

**任务创建报 `cwd_forbidden`？**
没有允许的工作目录。在桌面端打开一个工作区，或者配置 `allowedRoots`。

**手机上显示「登录已过期」？**
连续 15 天没连过、改过口令、或设备被撤销，都会失效。用账号 + 口令重新登录一次即可。

**手机上提示「这台设备已被电脑端移除」？**
你在电脑端移除过它，旧令牌已作废且不会自动补发。回到登录页用账号 + 口令重新登录。

**能同时用几台手机？**
不限台数。设备按 `installId` 区分，多台并存不会互相顶掉；看到不认识的设备就撤销它。

**忘记账号或口令？**
`node tools/set-auth.mjs --status` 看当前账号；重设口令会让所有手机失效、需要重新登录。

**能不能不用公共 broker？**
可以，`cloud.broker` 填你自己的 MQTT over WSS 地址，手机和电脑都连得上就行。

## 开发

```bash
npm install
npm test                              # 单元 + 协议测试（node:test）
npm run test:e2e                      # 端到端：真起服务、打真 HTTP
node tools/check-syntax.mjs           # 逐文件语法检查
node tools/build-shell.mjs            # 生成 docs/：可直接静态托管的外壳
node tools/build-shell.mjs --check    # 校验 docs/ 与源码一致
npm run mock                          # 假宿主，截图与联调用
npm run dev                           # web/ 热更新开发服务器（代理到 47901）
npm run verify                        # 上面几条串成门禁：语法 → 单测 → e2e → docs 一致性
```

`npm run dev` 需要一个设备令牌：`--token <dshb_…>` 或环境变量 `DSH_POCKET_TOKEN`。在手机外壳登录一次后，令牌就是 localStorage 里 `pocket.session.v1` 那一枚。

测试数量会随代码变动，以 `npm test` 的实际输出为准；CI 在 Node 22 与 24 上跑同一套门禁（语法检查 → 单测 → e2e → `docs/` 一致性）。Windows 下 `npm` 被执行策略拦住时（`npm.ps1 因为在此系统上禁止运行脚本`），用 `npm.cmd`，或直接按顺序敲上面的 `node` 命令。

目录：

```
lib/         电脑端：HTTP/WS 服务、设备登记、任务索引、鉴权、中继
web/         手机端 UI（ES 模块，无构建步骤）
remote/      远端外壳：校验链接 → 连中继 → 登录 → 动态加载 web/app.js
docs/        由 build-shell 生成的静态站（静态托管用，勿手改）
bin/         CLI
tools/       开发与运维脚本（dev-server、mock-host、build-shell、set-auth、check-syntax）
test/        单元 / 协议 / 端到端测试
```

`web/` 和 `remote/` 共用同一套 UI：`remote/index.html` 只是先把中继和登录搞定，再 `import` 同一份 `app.js`，所以两个入口的界面不会走样。Service Worker 的预缓存清单由 `tools/build-shell.mjs` 按真实产物列表生成，不要手写。

## 已知限制

- 只镜像 DSH 的**会话列表与对话**；文件树、diff、终端面板还没搬到手机上。
- 上传附件、语音输入、系统推送通知都没有做（设置页的「通知」开关只会申请浏览器权限，不会真的弹通知）。
- 远程模式下每条资源请求都要过一次中继往返，首次加载靠 Service Worker 预缓存兜住。
- 中继不可用 = 手机连不上；这是单通路的取舍，没有局域网兜底。
- 手机端只在移动端浏览器上验证过；桌面浏览器能用，但不为它优化。

## 许可

MIT。第三方组件见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；安全问题怎么报见 [SECURITY.md](SECURITY.md)。

## English

DSH Pocket puts your desktop DeepSeek Harness on your phone. The desktop only ever listens on `127.0.0.1` and makes outbound `wss://` connections to a public MQTT broker; the phone opens the static shell you host yourself at `cloud.appBase` and scans the QR code written to `~/dsh-pocket-qr.png`. Everything between phone and desktop is AES-256-GCM sealed, with the key kept in the QR-code fragment and never sent upstream. The phone needs exactly one credential — the account and password you set on the desktop: sign in once, the phone is registered automatically, and the session lasts 15 days and slides while you keep using it. MIT licensed.
