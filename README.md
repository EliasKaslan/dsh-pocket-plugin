# DSH 随行 · dsh-pocket-plugin

把电脑上的 [DeepSeek Harness](https://github.com/deepseek-ai) 接到手机上：随时看任务跑到哪一步、随时补一句话、随时中断。

**不用内网穿透，不用公网 IP，不用开端口。** 手机和电脑各自向外连一个公共消息中转，中间流动的只有密文；密钥只存在于你手机扫到的那串链接里，中转服务器和服务商都拿不到。

> **包名说明**：本项目的 npm 包名是 `dsh-pocket-plugin`。npm 上另有一个同名项目叫 `dsh-pocket`，两者**没有关系**，代码、协议、许可都不同。认准 `dsh-pocket-plugin`。

---

## 它能做什么

- **任务列表**：电脑上每个 DSH 会话就是一条任务，状态、模型、轮次、最后一句产出都同步到手机，断线重连按序号补帧。
- **看过程**：思考过程、工具调用、工具结果、Markdown 正文（代码块 / 表格 / 列表）都能在手机上读。
- **下发任务**：写一段话、选一个工作目录就能开工；任务跑着的时候还能追加消息。
- **中断**：一键取消正在跑的任务。
- **两种连法**：同一个 Wi-Fi 下扫局域网码直连（低延迟）；不在同一个网络时走加密中继。
- **断网可用**：外壳是 PWA，安装后静态资源全部预缓存，飞行模式下也能打开看到上次的任务列表。

## 两条连接路径

| | 局域网 | 远程中继 |
| --- | --- | --- |
| 适用 | 手机和电脑同一个 Wi-Fi | 任何网络，包括 4G/5G |
| 链路 | 手机 → 电脑的 `http://<内网IP>:47901` | 手机 ⇄ 公共 MQTT broker ⇄ 电脑 |
| 端口 | 电脑监听 47901 | **电脑不监听任何公网端口**，两边都是主动外连 |
| 加密 | 局域网明文（**没有传输加密**） | AES-256-GCM 端到端，broker 只见密文与房间号 |
| 身份 | 配对时发一张设备令牌（只存哈希） | 口令登录 + 设备令牌 |
| 需要 | 扫局域网二维码 | 设访问口令 + 自托管手机端外壳，再扫远程二维码 |

远程路径的数据流：

```
手机浏览器                    公共 broker                    你的电脑
  ├─ 从链接 # 片段取密钥 ─┐                                    │
  │  （密钥从不发给服务器） │                                    │
  ├─ AES-GCM 加密请求 ────┼──► dshm/<room>/u  ──► 解密 ──► 127.0.0.1:47901
  └─ 解密响应 ◄───────────┼──◄ dshm/<room>/d  ◄── 加密 ◄── DSH 插件
```

房间号是随机的，密钥是随机的，两者都只在二维码里出现一次。broker 上看不到任务内容、看不到 token、也看不到你在哪个目录里干活。

## 安装

要求：DSH 已装好并能正常启动；Node.js ≥ 22.15。

这个插件是 **bundle** 形态：`package.json` 里的 `dsh.bundle.patch` 指向仓库自带的 `cordis.patch.yml`，DSH 会把它当作一层补丁叠进 profile。所以安装要做两件事 —— **登记为 bundle** + **让包名可解析**。

只加依赖是不够的。实测：只写 `dependencies`、不写 `dsh.profile.bundles` 时，`dsh --profile <name> --dump-config` 只会打印 `patch: entry "pocket" not found`，插件静默不加载。

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
# 让包名可解析（等价于 pnpm 装完后的形态，不需要联网）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\<你的 profile>\node_modules\dsh-pocket-plugin" "D:\path\to\dsh-pocket"
```

要改配置就在 profile 的 `cordis.patch.yml` 里按 id 覆盖。**不要**再复制一份 `- insert:` 行 —— 那会插出两行同样的插件：

```yaml
- id: pocket
  config:
    port: 47901
    cloud:
      enabled: true
      appBase: 'https://你的账号.github.io/dsh-pocket-plugin/'
```

改完重启 DSH 生效。插件是 ESM，改代码必须冷启动；热重载只对配置生效。

> `dsh plugin --profile <name> add <包>` 只是把参数转发给 pnpm，**不会**替你登记 `bundles`；而且 Electron 应用自管的 profile 会直接拒绝执行（`profile "..." is managed exclusively by the Electron application`）。所以上面这套手写步骤才是完整的安装路径。

装好后打开 `http://127.0.0.1:47901/pair`，这就是电脑上的配对页 —— 二维码、配对码、已配对设备、远程开关都在这一页。这个页面**只接受本机回环访问**，局域网里的其它机器打开会被拒绝。

## 配对

**局域网**

1. 电脑打开 `http://127.0.0.1:47901/pair`。
2. 手机扫页面上的二维码（或手输 8 位配对码，形如 `VX42-NW9A`）。
3. 手机浏览器打开后就是 App；把它「添加到主屏幕」，下次像原生应用一样打开。

配对码 10 分钟内有效、最多用 10 次；一台电脑最多 8 台设备，满了要先在配对页撤销旧设备。

**远程**

```bash
# 1) 设访问口令（交互输入，不回显，不进命令历史）
node tools/set-auth.mjs --user 你的名字

# 2) 生成手机端外壳并发布到任意静态托管
node tools/build-shell.mjs          # 产物在 docs/
#    把 docs/ 整个目录传到 GitHub Pages / OSS / 你自己的静态站

# 3) 把那个地址填进插件配置的 cloud.appBase（结尾带 /），重启 DSH
```

`cloud.appBase` **故意没有默认值**：外壳是一段会在你手机上执行的代码，如果把某个第三方地址写成默认，等于让每一次安装都去信任同一个人的账号。所以远程访问必须你自己提供这一段。填好并重启后，配对页「远程」那一栏就有二维码了。

没有口令时中继**不会启动**，`cloud.appBase` 为空时也不会启动 —— 两道闸都是有意的。

登录后手机记住 15 天，过期或被撤销都要重新登录。改口令会让所有手机立刻失效。

## 配置

插件配置在 profile 的 `cordis.patch.yml` 里那一行 `config:` 下。改完热重载即可生效（除非改的是插件代码）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `47901` | 局域网监听端口。被占用时自动顺延（47901 → 47902 → …），实际端口看 `/api/v1/health` 的 `port` |
| `host` | `0.0.0.0` | 监听地址。只给本机用可以填 `127.0.0.1` |
| `serverName` | `我的电脑` | 手机上显示的名字。**不会**默认用主机名，避免泄露机器名 |
| `pairTtlMs` | `600000` | 配对码有效期 |
| `maxDevices` | `8` | 最多同时配对的设备数 |
| `allowedRoots` | `[]` | 允许作为任务工作目录的根。**留空不是"不限制"**，而是"只允许你在 DSH 里打开过的工作区"；一个都没有时任务无法创建 |
| `allowedHosts` | `[]` | 额外的合法 `Host` 值（反向代理时才需要），用于防 DNS rebinding |
| `publicBaseUrl` | `''` | 反向代理后的对外地址，只影响二维码里的链接 |
| `authRequired` | `true` | 是否要求口令登录。只有显式写 `false` 才会关；关掉它中继就起不来（除非同时开 `cloud.allowAnonymous`） |
| `cloud.enabled` | `false` | 是否启用远程中继。随包发布的插件行设成了 `false`，要在配对页里打开或改成 `true` |
| `cloud.appBase` | `''` | 手机端静态外壳地址。**留空 = 不启用远程**，必须填你自己托管的地址 |
| `cloud.broker` | 公共 EMQX | 消息中转地址，可以是字符串或数组（最多 4 个，按顺序回退）。可换成自建 broker |
| `cloud.allowAnonymous` | `false` | 允许无口令的中继。**强烈不建议** |
| `dataDir` | `$DSH_HOME/pocket` | 状态、口令、日志的存放目录 |

数据目录里有：`state.json`（设备与配对码，只存 token 哈希）、`auth.json`（口令 scrypt 哈希）、`sessions.json`（登录会话）、`cloud.json`（中继房间与密钥）、`bridge.log`。这些都**不应该进版本库**，`.gitignore` 已经排除。

## 命令行

```bash
node bin/cli.mjs link            # 二维码 + 配对链接 + 配对码（在终端里扫）
node bin/cli.mjs status          # 运行状态、中继状态、设备数
node bin/cli.mjs devices         # 已配对设备
node bin/cli.mjs revoke <id|all> # 撤销设备
node bin/cli.mjs broker [url]    # 查看/临时切换中继地址
```

也可以用包装出来的命令 `dsh-pocket-plugin <子命令>`。这些接口只在电脑本机（回环）可用，从手机侧调用一律 403。

## 安全模型

**做了什么**

- **没有入站端口**：远程路径上电脑只向外拨号，NAT 和防火墙都不用动。
- **端到端加密**：请求与响应都用 AES-256-GCM 封装，每帧一个新随机 IV；AAD 绑定房间话题名**且区分方向**（上行用 `…/u`、下行用 `…/d`），防止把密文挪到别的话题或反方向重放；密钥只存在于链接的 `#` 片段，浏览器不会把它发给任何服务器。
- **中继请求不提权**：转发进本机的请求带一个每进程随机标记，插件**看到标记就一律当作远程**（先标记、再校验值，值不对也只是记日志），哪怕源 IP 是 127.0.0.1；转发前该头一律剥离。
- **中继路由白名单**：只有手机 UI 真正需要的路由能被代理进来；`/pair`、`/api/v1/pairing`、`/api/v1/pair`、`/api/v1/devices*`、`/api/v1/cloud*`、`/download*`、`/healthz` 在中继侧直接拒绝。
- **口令闸门**：远程必须过口令（scrypt，N=16384）；中继侧还有 10 次/分钟的登录预算，超了直接 `locked`。
- **设备令牌**：局域网用随机令牌，只存哈希；可单独撤销，撤销时正在连的 WebSocket / SSE 立刻断开。
- **防 DNS rebinding**：所有路由先校验 `Host`，外来 Host 直接 403。
- **防 CSRF**：写操作校验 `Sec-Fetch-Site` / `Origin`；两者都没有时只放行回环，非回环一律拒绝。表单再带一个隐藏 CSRF 字段。
- **工作目录白名单**：任务目录必须落在允许的根里，解析后按路径段比较；空列表 = 全关，不是全开。
- **不泄露路径**：未鉴权的 `/api/v1/health` 只回版本、协议、端口、运行时长，不回任务数、设备数、绝对路径。

**没有做 / 做不到**

- 中继可见**元数据**：房间号、消息大小、收发时间。这些足以做流量分析，但看不到内容。
- **口令锁定在中继路径上只有"整条链路共享"这一层**：`auth.mjs` 按 `ip + deviceId` 分桶（5 次/10 分钟起，指数锁到 1 小时），但中继的登录消息里不带 ip/deviceId，于是只有 `cloud.mjs` 的 10 次/分钟全链路预算在起作用。结果是一个陌生人持续乱试可以把你锁在门外最多一分钟（拿不到你的口令，但能恶心你）。局域网路径没有口令闸，因此也谈不上按来源锁定。
- 公共 broker 是第三方服务，它掉线你也掉线；介意就自建（`cloud.broker` 支持任意 MQTT over WSS）。
- 局域网路径是**明文 HTTP**：同一 Wi-Fi 下的其他人可以嗅探到内容。**局域网没有口令闸门**，唯一的门槛是配对时发的那张设备令牌，所以请只在可信网络里用；要加密就走中继。
- `cloud.appBase` 指向的外壳是"谁来提供这段前端代码"的信任点。它拿不到明文（没有密钥），但不信任的话就自己托管 —— 本来也要求你自己托管。
- Windows 上状态文件的 `0600` 权限位是 no-op（chmod 被吞），安全性依赖 `%USERPROFILE%` 的 NTFS 默认 ACL。
- 电脑被物理接触、或手机被解锁后拿走，这套机制帮不了你 —— 该撤销设备就撤销。

发现安全问题请走 [SECURITY.md](SECURITY.md)，不要开公开 issue。

## 常见问题

**手机连不上，配对页却正常？**
先确认手机和电脑在同一个 Wi-Fi，且电脑防火墙放行 47901（Windows 首次运行会弹一次）。远程连不上就看配对页「远程」那一栏的状态：`未配置` = `cloud.appBase` 为空；`已阻止` = 还没设口令或 `authRequired=false`；`连接失败` = broker 不通，换一个试试。

**`/api/v1/health` 里端口不是 47901？**
被占用了，插件自动顺延。以 `/api/v1/health` 返回的 `port` 为准。

**改了插件代码没生效？**
ESM 模块缓存：必须重启 DSH。只有 `cordis.patch.yml` 的配置改动是热重载的。

**任务创建报 `cwd_forbidden`？**
没有允许的工作目录。在桌面端打开一个工作区，或者配置 `allowedRoots`。

**手机上显示"登录已过期"？**
会话默认 15 天；改过口令、或设备被撤销，也会立刻失效。重新扫码配一次即可。

**能不能不用公共 broker？**
可以，`cloud.broker` 填你自己的 MQTT over WSS 地址；两台设备都连得上就行。

**从旧版（`dsh-mobile-bridge`，协议 1）升上来？**
见 [MIGRATION.md](MIGRATION.md)：数据不自动迁移，要重新配对、重设口令。

## 开发

```bash
npm install            # 或 pnpm install
node tools/dev-server.mjs     # web/ 热更新开发服务器（代理到 47901）
node --test "test/**/*.test.mjs"   # 单元 + 协议测试（node:test，无浏览器）
node test/e2e/run.mjs         # 端到端：真起一个服务，打真 HTTP
node tools/build-shell.mjs    # 生成 docs/：可直接静态托管的外壳
node tools/build-shell.mjs --check    # 校验 docs/ 与源码同步（CI 用）
node tools/check-syntax.mjs   # 逐文件语法检查
npm run verify        # 上面几条全跑一遍：语法 → 单测/协议 → e2e → docs 一致性
```

> Windows PowerShell 下如果 `npm` 被执行策略拦住（`npm.ps1 因为在此系统上禁止运行脚本`），
> 用 `npm.cmd run verify`，或者直接按顺序敲上面那几条 `node` 命令 —— 本仓所有脚本都不依赖 npm。

> 测试命令必须写成 glob。Node 24 会把 `node --test test/unit test/protocol` 里的**目录**当成模块去
> `require`，直接 `MODULE_NOT_FOUND` 退 1；而空 glob（目录里没有匹配文件时）会以 `tests 0` 静默退 0。
> 两种都不是你要的结果，所以 CI 与 `package.json` 统一用 `test/**/*.test.mjs`。

目录：

```
lib/         电脑端：HTTP/WS 服务、配对、任务索引、鉴权、中继
web/         手机端 UI（ES 模块，无构建步骤）
remote/      远端外壳：校验链接 → 连中继 → 登录 → 动态加载 web/app.js
docs/        由 build-shell 生成的静态站（静态托管用，勿手改）
bin/         CLI
tools/       开发与运维脚本（dev-server、mock-host、build-shell、set-auth、check-syntax）
test/        单元 / 协议 / 端到端测试
```

`web/` 和 `remote/` 共用同一套 UI：`remote/index.html` 只是先把中继和登录搞定，再 `import` 同一份 `app.js`。所以两个入口的界面不会走样，改一处两边都变。

Service Worker 的预缓存清单由 `tools/build-shell.mjs` 按真实产物列表生成，不要手写 —— 手写过一次，漏了 `store.js` / `lib/*` / `views/*`，结果断网打开是白屏。

### 这个仓现在验到什么程度

写清楚边界，免得你把「测过」当成「不会坏」：

- **已验证**：`npm run verify` 四关全绿（60 文件语法 / 58 条单元+协议 / 11 条端到端 / `docs/` 与源码逐字节一致）；CI 在 Node 22 与 24 上都绿；把仓库重新 clone 一份（Linux CI 与 Windows 本地各一次）跑同样的四关，结果一致 —— 说明提交进仓库的东西是自洽的，不依赖我本机的残留文件。
- **已验证**：用真实入口 `lib/index.mjs` + 假 ctx 起服务（临时端口、临时数据目录），健康检查 / CSP / 配对页 / 配对码 / 未授权 401 / 路径穿越 / 端口释放全部符合预期。
- **已验证**：`npm pack --dry-run` 出来的 83 个文件里包含 `cordis.patch.yml`、`lib/index.mjs`、`bin/`，即安装器拿到的包是完整的。
- **已验证（装进真 profile 冷启动）**：在隔离的 `DSH_HOME` 里用真 host 起过（`dsh --profile <name> --no-open`），日志出现 `plugin loading; data=<DSH_HOME>/pocket` 与 `bridge listening on 0.0.0.0:<port>`，`/api/v1/health` 200、`/pair` 200、`/api/v1/pairing` 正常发码、未授权 `/api/v1/tasks` 401；同一次实验里首选端口被占用，插件自动退到下一个端口。`--dump-config` 里能看到 `# == dsh-pocket-plugin` 这一层，说明 bundle 补丁确实被叠进去了。同一个形态也装进了日常在用的 profile。
- **未验证**：iOS Safari 实机、真正的蜂窝网络切换、长时间（>24h）中继稳定性。

## 已知限制

- 只镜像 DSH 的**会话列表与对话**；文件树、diff、终端面板还没搬到手机上。
- 远程模式下每条资源请求都要过一次中继往返，首次加载用 Service Worker 预缓存兜住；之后接近瞬时。
- 上传附件、语音输入、系统推送通知都没有做（设置页里的「通知」开关目前只会申请浏览器权限，**不会真的弹通知**）。
- 只在 Chromium / Safari 移动端浏览器上验过；桌面浏览器能用但不为它优化。

## 许可

MIT。第三方组件见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；安全模型与已知问题见 [SECURITY.md](SECURITY.md)。

## English

DSH Pocket puts your desktop DeepSeek Harness on your phone. There is no inbound port: the desktop dials out to a public MQTT broker, the phone does the same, and everything between them is AES-256-GCM sealed with a key that only lives in the QR-code fragment. Pair over your LAN for low latency, or over the relay when you are on another network (a password plus your own copy of the static shell are required for that path). Install with `dsh plugin add`, open `http://127.0.0.1:47901/pair`, scan the code. MIT licensed.
