# 安全策略 · dsh-pocket

DSH 随行（`dsh-pocket-plugin`）把桌面上的 DeepSeek Harness 接到手机。这份文档说明三件事：我们**有意**做了什么、**做不到**什么、以及发现漏洞后怎么报。

**从 2.0.0 起只有一条通路：加密中继。** 桌面端**只监听 `127.0.0.1`**，**不再监听任何非回环地址**；局域网直连（`http://<内网IP>:<端口>/app`）已整条移除，没有开关、没有降级、没有兼容层。因此这份威胁模型只覆盖「手机 → 公共 broker → 电脑」这一条链路 —— 旧版本里关于「局域网 / 同一 Wi-Fi / 防火墙」的威胁与缓解措施，在 v2 里已经没有对应实体。

文中的每条断言都能在代码里找到对应实现，引用格式为 `文件:行号`。凡是代码里没有的，这里也不会写。

## 支持的版本

| 版本 | 是否接受安全修复 |
| --- | --- |
| `2.0.x` | 是 |
| `1.0.x` | 否（局域网直连已移除，请先升级） |
| `< 1.0` | 否 |

只维护最新一个 2.x 小版本。报问题前请先升级：2.0.0 移除了局域网直连（桌面端不再有任何非回环监听），并继续沿用 1.0.0 起的中继路由白名单与协议 2 重放防护。

## 报告漏洞

**不要开公开 issue。**

1. 走仓库的 **GitHub Private Vulnerability Reporting**：仓库页 → *Security* → *Report a vulnerability*。这条通道只有维护者可见。
2. 报告请包含：受影响版本、复现步骤、你实际观察到的行为、以及你认为攻击者需要具备什么（拿到配对链接？拿到已登录的手机？能改 broker？能接触电脑？）。
3. **不要**贴真实口令、真实房间密钥，也不要贴 `state.json` / `auth.json` / `sessions.json` / `cloud.json` 的内容。要证明问题，给脱敏后的结构，或者自己新生成一份现场重放。
4. 目标是在 7 天内给出首次回复；修复与公开披露的时间线会和你商量。修好之前请不要公开细节。

以下属于**已知设计**（见「已知限制」），不按漏洞处理：broker 能看到元数据、`cloud.appBase` 提供的是一段你选择信任的前端代码、物理接触电脑、以及手机解锁后被人拿走。

## 安全模型

### 网络面

- **桌面端只监听回环。** 监听地址是常量 `127.0.0.1`（`lib/core.mjs:38`、`lib/core.mjs:618`、`lib/server.mjs:150`），**没有任何配置项能改成 `0.0.0.0` 或内网地址**。旧配置里残留的 `host` / `publicBaseUrl` 会被忽略并 warn 一次（`lib/core.mjs:121-125`）。跨网时电脑是中继的**客户端**，主动向外拨 `wss://`，没有任何入站端口，NAT 与防火墙都不用动。
- **中继只转发白名单路由。** 手机经中继能触达的路径是 12 条硬编码正则（`lib/cloud.mjs:231-244`）：`/api/v1/me`、`/api/v1/health`、任务列表/详情/下发/取消、`/api/v1/presets`、`/api/v1/workspaces`、`/api/v1/self/revoke`、`/api/v1/events`、`/api/v1/ws-ticket`、`/ws`。配对页（`/pair`）、配对码（`/api/v1/pairing`、`/api/v1/pair`）、设备管理（`/api/v1/devices*`）、中继管理（`/cloud/*`）、`/healthz`、`/download/*` 一律 403，并在日志里写明拒绝原因（`lib/cloud.mjs:251-259`）。方法也被钉死，GET 路由不能被打成写操作。
- **转发进来 ≠ 本机请求。** 中继给每个转发请求打一个每进程随机标记（`x-pocket-relay`），插件看到这个标记就不再按回环请求处理，哪怕源地址是 `127.0.0.1`（`lib/core.mjs:177-186`、`lib/core.mjs:479-481`）；转发前还会把客户端自带的同名头整体剥掉，标记只由中继自己加（`lib/cloud.mjs:896-917`）。

### 密码学

- **AES-256-GCM**，每帧 12 字节随机 IV，认证标签随密文一起走（`lib/cloud.mjs:190-212`）。
- **AAD 绑定话题。** 上行封在 `dshm/<room>/u`、下行封在 `dshm/<room>/d`，加密/解密时把话题名当 AAD（`lib/cloud.mjs:627`、`lib/cloud.mjs:640`）。把密文搬到另一个话题，或把上下行对调，解密必然失败。
- **密钥只在配对链接的 `#` 片段里。** 房间号 `r`、密钥 `k`、设备令牌 `t` 全部写在 `base.hash` 之后（`lib/cloud.mjs:165-188`），浏览器不会把 fragment 发给任何服务器，中继侧也从未把它写进日志。
- **重放防护。** 状态变更帧要求 `seq` 严格递增、`ts` 落在 120 s 窗口内、`sid` 合法；三者缺一就按 `stale` 拒绝（`lib/cloud.mjs:776-790`）。这使"在公共 broker 上录一段包、几分钟后重发"失效。

### 口令与令牌

- **口令只存 scrypt 哈希**：N=16384、r=8、p=1、16 字节随机盐（`lib/auth.mjs:23`、`lib/auth.mjs:53-59`）；校验用 `timingSafeEqual`（`lib/auth.mjs:78`），用户名错也会照跑一次 scrypt，避免用耗时区分"用户名错"和"口令错"。
- **会话令牌只存 SHA-256 摘要**，勾选"记住我"为 15 天，否则 12 小时（`lib/auth.mjs:20-21`、`lib/auth.mjs:278`）。改口令或撤销全部设备会让所有手机立刻失效。
- **设备令牌 48 字符**（`dshb_` + 32 字节随机数，`lib/util.mjs:50`），状态文件里只存哈希；撤销时正在连的 WebSocket 以 4001 关闭（`lib/server.mjs:958`）。

### 本机守门

- **防 DNS rebinding。** 所有路由先过 `Host` 校验：只接受 `localhost`、`127.0.0.1` / `[::1]`、本机主机名，以及你显式配置的 `allowedHosts`；**不再自动把网卡内网 IP 加进白名单**（`lib/core.mjs:447-470`）。
- **防 CSRF。** 回环写操作依次校验 `Sec-Fetch-Site` → `Origin` → 每进程 CSRF token，最后兜底为"必须是回环"，不给"我不发 Origin"留后门（`lib/server.mjs:334-372`）。
- **响应头。** `default-src 'self'`、`frame-ancestors 'none'`、`base-uri 'none'`、`nosniff`、`no-referrer`、COOP/CORP 同源、`permissions-policy` 关掉摄像头/麦克风/定位（`lib/server.mjs:73-84`）。
- **工作目录白名单。** 任务目录先 `realpath` 再按路径段比较，符号链接跳不出去；空列表 = 全关，不是全开；UNC 路径直接拒（`lib/task-index.mjs:745-763`）。
- **未授权尝试有速率上限。** 设备令牌错误按 IP 限 40 次/分钟（`lib/server.mjs:610`），配对尝试按 IP 限 12 次/10 分钟、全局 400 次/10 分钟（`lib/server.mjs:660-664`）。

## 已知限制

**以下全部是当前版本的真实状态，不是"将来会做"。**

### 1. 中继口令失败锁定只有全链路共享预算，没有按来源分桶

中继侧预算是**每条中继链路** 10 次登录 / 60 s（`lib/cloud.mjs:84-85`、`lib/cloud.mjs:844-853`）。中继登录帧只携带 `user` / `password` / `phone`（`lib/cloud.mjs:869-874`），**没有 ip、没有 deviceId**，所以 `Auth.login` 判定为"来源未标识"，走进只计数、不锁定的分支（`lib/auth.mjs:229-238`）。

后果：任何拿到配对链接的人（链接自带房间密钥）可以长期、匀速地试口令，代价只有每分钟 10 次，且不会因为失败次数累积而被锁。唯一的兜底是口令本身的强度——请用长口令，不要用能猜到的。

> 对照：`lib/auth.mjs` 里**确实**实现了按 IP+设备分桶、5 次失败起锁、锁定时长 5 分钟指数增长到 1 小时（`lib/auth.mjs:26-27`、`lib/auth.mjs:213-240`）。但这套分桶在中继路径上取不到输入。

### 2. 局域网直连已在 v2 移除（历史说明，不是现存面）

1.0.x 提供过第二条通路：手机和电脑在同一个 Wi-Fi 时，直接打开 `http://<内网IP>:47901/app`。那条链路是**明文 HTTP**、**没有口令闸门**（凭据只有配对时下发的设备令牌），同一网段的任何人都能嗅到并重放。2.0.0 把它整条删掉了，连同「监听 `0.0.0.0`」「靠防火墙/可信 Wi-Fi 保护」这一整套说法一起作废：

- 现在**不存在**非回环监听，也就不再有"要不要放行端口"的问题；
- 手机唯一的入口是中继外壳（`cloud.appBase`），口令闸门是必经之路；
- 旧的内网链接、旧二维码在 2.0.0 里失效；即便某个旧的中继链接还能打开外壳，也不受支持，请重新配对。

### 3. `cloud.appBase` 默认空 = 连不上；手机端外壳是"谁来提供这段代码"的信任点

`DEFAULT_APP_BASE = ''`（`lib/cloud.mjs:107`），为空时中继直接不启动并报 `unconfigured`（`lib/cloud-service.mjs:171-181`）。中继既然是唯一通路，这一项留空的直接后果就是**手机连不上**，没有备用路径，也没有局域网兜底。

那段前端代码拿不到明文（密钥在你手机的 URL fragment 里），但它**决定你的手机执行什么 JS**：一个被替换的外壳可以在你输入口令时把它读走，也可以在你解密之后读走明文。这就是为什么默认值留空——把它设成谁的地址，是你自己的信任决定，不是安装包能替你做的。

### 4. 公共 broker 看不到内容，但看得到元数据

默认 broker 是公共 EMQX（`lib/cloud.mjs:100`），它只承载密文，但**能看到**：房间名（`dshm/<room>/u|d`）、连接与断开时间、消息条数与大小、你的出口 IP。这些足够做流量分析（比如"这台机器现在很忙"），只是看不到任务内容、会话 ID 与目录。

介意就自建：`cloud.broker` 接受任意 MQTT over WSS 地址，也接受数组按顺序回退。

### 5. Windows 上文件权限 `0600` 是 no-op

状态、口令、会话、中继身份都按 `0600` 创建（`atomicWriteJson`，`lib/util.mjs:170-183`；`FileLogger`，`lib/util.mjs:406-414`），但 Windows 上的 `chmod` 只会动只读位，POSIX 权限位不起作用；代码里 `chmodSync` 的失败也被 try/catch 吞掉。

实际保护来自 `%USERPROFILE%\.dsh\pocket\` 这一层目录的 NTFS 继承 ACL（默认只有本用户可读）。**结论**：同机的其他 Windows 用户读不到；但任何以你的身份运行的进程、以及会打包整个用户目录的备份/同步工具，都能拿到 `auth.json` 与 `cloud.json`。不要把数据目录放进公开同步盘。

### 6. `cloud.allowAnonymous` 可以彻底关掉口令

配置项 `cloud.allowAnonymous` 为 `true` 时，中继会在没有口令的情况下启动（`lib/cloud-service.mjs:58-78`、`lib/cloud.mjs:390-396` 的启动前守卫）。此时**配对链接本身就是全部权限**：拿到链接的人可以读写你的所有会话。这个开关是为了自建 broker + 自托管外壳的极端场景留的，默认关闭，除非你完全清楚后果，否则不要打开。

### 7. 手机端的 15 天会话令牌只是"包了一层"，不是硬件保护

外壳会把登录令牌用 AES-GCM 封起来再写 `localStorage`，但拆封用的密钥同样存在这台手机的 `localStorage` 里（`remote/remote.js:287-321`）。它能挡住"打开开发者工具复制字符串"，挡不住同源上已经在跑的脚本，更挡不住拿到已解锁手机的人。

**该撤销就撤销**：配对页或 `node bin/cli.mjs revoke <id|all>`。

### 8. CSP 的 `connect-src` 收不到具体主机上

CSP 里 `connect-src` 是 `'self' http: https: ws: wss:`（`lib/server.mjs:81`），不是白名单。原因是 broker 可配置、而且会随配对链接下发（`lib/cloud.mjs:185` 的 `s` 参数），外壳必须能连任意 `wss://`，所以这里没法收紧。

后果：CSP 挡不住"页面里的脚本把数据 POST 到任意地址"——真正挡住 XSS 的是 `script-src 'self'` 与"不用 `innerHTML` 拼内容"这两条纪律，而不是 `connect-src`。

## 加固清单

按收益排序，都是配置或运维动作，不需要改代码：

1. **设一个长口令**（`node tools/set-auth.mjs`，写入数据目录的 `auth.json`）。这是 v2 唯一的入口闸门。
2. **不要把 `cloud.broker` 留在公共 broker 上**，如果你在意元数据：自建 EMQX/Mosquitto，填 `wss://` 地址。
3. **自托管外壳**：`node tools/build-shell.mjs` 后把 `docs/` 发到你自己的静态托管，`cloud.appBase` 指向它。中继外壳就是手机的唯一入口，自己不托管就没有入口。
4. **只给需要的工作目录**：`allowedRoots` 留空 = 全部禁止；不要填 `/` 或整个家目录。
5. **定期清设备**：配对页或 `bin/cli.mjs devices` 看有没有不认识的设备，撤销掉；改口令会让全部手机失效。
6. **不要把数据目录放进云同步**（见限制 5）。

## 安全相关代码位置

| 关注点 | 位置 |
| --- | --- |
| 监听地址常量与绑定调用 | `lib/core.mjs:38`、`lib/core.mjs:618`、`lib/server.mjs:146-186` |
| 中继常量（协议版本、帧上限、预算、默认 broker/appBase） | `lib/cloud.mjs:37-110` |
| 中继路由白名单与拒绝名单 | `lib/cloud.mjs:231-259` |
| 信封加解密（AES-256-GCM + AAD） | `lib/cloud.mjs:190-212`、`lib/cloud.mjs:627-640` |
| 重放防护（seq/ts/sid） | `lib/cloud.mjs:776-790` |
| 口令、会话、失败分桶 | `lib/auth.mjs` 全文件 |
| `Host` 校验 / 回环判定 | `lib/core.mjs:447-490` |
| 安全响应头 / CSRF / 回环闸门 | `lib/server.mjs:73-84`、`lib/server.mjs:334-372` |
| 数据文件权限与原子写 | `atomicWriteJson` / `FileLogger`，`lib/util.mjs:170-183`、`lib/util.mjs:406-414` |
| 工作目录白名单 | `lib/task-index.mjs:745-763` |
| 手机端登录闸门与令牌封装 | `remote/remote.js:287-339` |

## 许可

MIT，见 [LICENSE](LICENSE)。第三方组件见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
