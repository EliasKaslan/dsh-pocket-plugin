# 安全策略 · dsh-pocket-plugin

DSH 随行把桌面上的 DeepSeek Harness 接到手机。这份文档说明三件事：我们**有意**做了什么、**做不到**什么、以及发现漏洞后怎么报。

手机接入只有一条路：电脑上的二维码 → 手机打开你托管的外壳 → 输入账号 + 口令 → 登录成功即登记设备。电脑端**只监听 `127.0.0.1`**，跨网时它只是公共 broker 的客户端。

文中每条断言都能在代码里找到对应实现，引用格式为 `文件:行号`；代码里没有的，这里不写。

## 支持的版本

| 版本 | 是否接受安全修复 |
| --- | --- |
| `1.0.x` | 是 |

只维护最新的 1.0.x。报问题前请先确认版本（`/api/v1/health` 的 `version`，或连接页页脚）。

## 报告漏洞

**不要开公开 issue。**

1. 走仓库的 **GitHub Private Vulnerability Reporting**：仓库页 → *Security* → *Report a vulnerability*。这条通道只有维护者可见。
2. 报告请包含：受影响版本、复现步骤、你实际观察到的行为，以及你认为攻击者需要具备什么（拿到二维码/链接？拿到已登录的手机？能改 broker？能替换外壳？能接触电脑？）。
3. **不要**贴真实口令、真实房间密钥，也不要贴 `state.json` / `auth.json` / `sessions.json` / `cloud.json` 的内容。要证明问题，给脱敏后的结构，或自己新生成一份现场重放。
4. 目标是在 7 天内给出首次回复；修复与公开披露的时间线会和你商量，修好之前请不要公开细节。

以下属于**已知设计**（见「已知限制」），不按漏洞处理：broker 能看到元数据、`cloud.appBase` 提供的是一段你选择信任的前端代码、物理接触电脑、以及手机解锁后被人拿走。

## 威胁模型

**要保护的东西**：会话内容与产出的路径/文件名、账号口令、设备令牌、以及中继链接（它本身就是凭据）。

**不假设安全的**：公共 broker、承载外壳的静态托管、手机所在的浏览器环境、电脑上的其他本地进程。

**考虑的对手位置**：

1. 链路上或 broker 运营方——只看得到密文与元数据；
2. 拿到二维码或中继链接的人——能打开外壳、能发起登录尝试；
3. 拿到一台已登录手机的人；
4. 同一台电脑上的其他用户或进程；
5. 能替换 `cloud.appBase` 所指外壳内容的人。

下面逐项说明对应措施与残留风险。

## 安全模型

### 网络面

- **只监听回环。** 监听地址是常量 `127.0.0.1`（`lib/core.mjs:39`、`lib/core.mjs:617`），**没有任何配置项能改成 `0.0.0.0` 或内网地址**。跨网时电脑是中继的**客户端**，主动向外拨 `wss://`，没有任何入站端口，NAT 与防火墙都不用动。
- **中继只转发白名单路由。** 手机经中继能触达的路径是 12 条硬编码正则（`lib/cloud.mjs:231-241`）：`/api/v1/me`、`/api/v1/health`、任务列表/详情/下发/取消、`/api/v1/presets`、`/api/v1/workspaces`、`/api/v1/self/revoke`、`/api/v1/events`、`/api/v1/ws-ticket`、`/ws`。配对页（`/pair`）、设备管理（`/api/v1/devices*`）、中继管理（`/cloud/*`）、`/healthz`、`/download/*` 一律拒绝，并在日志里写明拒绝原因（`lib/cloud.mjs:251-258`）。方法也被钉死，GET 路由不能被打成写操作。
- **转发进来 ≠ 本机请求。** 中继给每个转发请求打一个每进程随机标记；插件看到这个标记就不再按回环请求处理，哪怕源地址是 `127.0.0.1`（`lib/core.mjs:456-465`）。客户端自带的同名头与 `x-forwarded-*` 在转发前被整体剥掉，标记只由中继自己加（`lib/cloud.mjs:962-981`）。

### 密码学

- **AES-256-GCM**，每帧 12 字节随机 IV，认证标签随密文一起走（`lib/cloud.mjs:190-212`）。
- **AAD 绑定话题与方向。** 上行封在 `dshm/<room>/u`、下行封在 `dshm/<room>/d`（`lib/cloud.mjs:153-156`），加解密时把话题名当 AAD（`lib/cloud.mjs:193`、`lib/cloud.mjs:209`）。把密文搬到另一个话题，或把上下行对调，解密必然失败。
- **密钥只在链接的 `#` 片段里。** 房间号、密钥、中继令牌都写在 `base.hash` 之后（`lib/cloud.mjs:165-187`），浏览器不会把 fragment 发给任何服务器，中继侧也从不把它写进日志。
- **重放防护。** 状态变更帧要求 `seq` 严格递增、`ts` 落在 120 s 窗口内、`sid` 合法；三者缺一就按 `stale` 拒绝（`lib/cloud.mjs:772-790`）。这使「在公共 broker 上录一段包、几分钟后重发」失效。

### 口令、会话与设备令牌

- **口令只存 scrypt 哈希**：N=16384、r=8、p=1、随机盐（`lib/auth.mjs:30`、`lib/auth.mjs:61`）；校验用 `timingSafeEqual`（`lib/auth.mjs:85`），用户名错也会照跑一次 scrypt，避免用耗时区分「账号错」和「口令错」。
- **会话 15 天，滑动续期。** 登录一次有效期 15 天（`lib/auth.mjs:20`）；只要手机还在连，有效期就往后推到「现在 + 15 天」，但每 24 小时最多续一次、最多落盘一次（`lib/auth.mjs:28`、`lib/auth.mjs:210-227`）。改口令会作废旧会话并让所有手机失效（`lib/server.mjs:689-703`）。
- **手机侧令牌加密后落盘。** 外壳用 AES-256-GCM（密钥经 HKDF 从本机随机 secret 派生）封装登录令牌再写 `localStorage`（`remote/remote.js:284-330`）。
- **设备令牌**：`dshb_` + 32 字节随机数的 base64url（`lib/util.mjs:50`），状态文件里只存 SHA-256；撤销时正在连的 WebSocket 以 4001 关闭（`lib/server.mjs:1014-1022`）。
- **登录即登记设备。** 口令校验通过后，桌面端在同一个应答里下发设备令牌（`lib/core.mjs:294-334`）。三条边界：
  - **按 `installId` 认设备**：同一台手机再次登录复用同一条记录、轮换令牌并清掉旧的吊销标记（`lib/core.mjs:313`、`lib/state.mjs:87-135`）；不同 `installId` 的手机各自独立，多台并存不会互相顶掉。
  - **吊销后不会被自动补发。** 设备被移除后，那台手机再出示旧令牌时，服务端回 `revoked: true` 且 `deviceToken: null`（`lib/cloud.mjs:840-857`、`lib/cloud.mjs:889-893`）—— 否则「移除设备」就形同虚设。唯一恢复路径是回到登录页用账号 + 口令重新登录，旧令牌永远作废。
  - **设备数量不设上限。** 看到不认识的条目就移除；改口令会让所有手机失效。
- **未授权尝试有速率上限。** 设备令牌错误按 IP 限 40 次/分钟（`lib/server.mjs:602`）。

### 本机守门

- **防 DNS rebinding。** 所有路由先过 `Host` 校验：只接受 `localhost`、`127.0.0.1` / `[::1]`、本机主机名，以及你显式配置的 `allowedHosts`（`lib/core.mjs:440-465`）。
- **防 CSRF。** 回环写操作依次校验 `Sec-Fetch-Site` → `Origin` → 每进程 CSRF token，最后兜底为「必须是回环」，不给「我不发 Origin」留后门（`lib/server.mjs:326-372`）。
- **响应头。** `default-src 'self'`、`frame-ancestors 'none'`、`base-uri 'none'`、`nosniff`、`no-referrer`、COOP/CORP 同源、`permissions-policy` 关掉摄像头/麦克风/定位（`lib/server.mjs:70-84`）。
- **工作目录白名单。** 任务目录先 `realpath` 再按路径段比较，符号链接跳不出去；空列表 = 全关，不是全开；UNC 路径直接拒（`lib/task-index.mjs:733-762`）。
- **未鉴权的健康检查不泄露状态。** `/api/v1/health` 只回版本、协议、实际端口、运行时长与 `requiresLogin` 等公开字段，不回任务数、设备数与绝对路径（`lib/core.mjs:486-500`）。

## 已知限制

**以下全部是当前版本的真实状态，不是「将来会做」。**

### 1. 中继口令失败预算只有全链路共享，没有按来源分桶

中继侧预算是**每条中继链路** 10 次登录 / 60 s（`lib/cloud.mjs:84-85`、`lib/cloud.mjs:900-906`）。中继登录帧只携带 `user` / `password` / `phone` / `remember`（`lib/cloud.mjs:909-927`），**没有 ip、没有 deviceId**，所以 `Auth.login` 判定为「来源未标识」，走进只计数、不锁定的分支（`lib/auth.mjs:269-294`）。

后果：任何拿到二维码/链接的人（链接自带房间密钥）可以长期、匀速地试口令，代价只有每分钟 10 次，且不会因为失败次数累积而被锁。唯一的兜底是口令本身的强度——请用长口令，不要用能猜到的。

> 对照：`lib/auth.mjs` 里**确实**实现了按 IP+设备分桶、失败达阈值起锁、锁定时长 5 分钟指数增长到 1 小时（`lib/auth.mjs:31-34`、`lib/auth.mjs:240-310`）。但这套分桶在中继路径上取不到输入。

### 2. `cloud.appBase` 默认空 = 连不上；外壳是「谁来提供这段代码」的信任点

`DEFAULT_APP_BASE = ''`（`lib/cloud.mjs:107`），为空时中继直接不启动并报 `unconfigured`（`lib/cloud-service.mjs:171-181`）。中继既然是唯一通路，这一项留空的直接后果就是**手机连不上**，没有备用路径。

那段前端代码拿不到明文（密钥在你手机的 URL fragment 里），但它**决定你的手机执行什么 JS**：一个被替换的外壳可以在你输入口令时把它读走，也可以在你解密之后读走明文。这就是为什么默认值留空——把它设成谁的地址，是你自己的信任决定，不是安装包能替你做的。

### 3. 公共 broker 看不到内容，但看得到元数据

默认 broker 是公共 EMQX（`lib/cloud.mjs:100`），它只承载密文，但**能看到**：房间名（`dshm/<room>/u|d`）、连接与断开时间、消息条数与大小、你的出口 IP。这些足够做流量分析（比如「这台机器现在很忙」），只是看不到任务内容、设备令牌与目录。

不保证可用性：它是第三方公共服务，掉线时手机也连不上。介意就自建——`cloud.broker` 接受任意 MQTT over WSS 地址，也接受最多 4 个地址按顺序回退（`lib/cloud-service.mjs:278`）。

### 4. Windows 上文件权限 `0600` 是 no-op

状态、口令、会话、中继身份都按 `0600` 创建（`atomicWriteJson`，`lib/util.mjs:152-165`；`FileLogger`，`lib/util.mjs:387-396`），但 Windows 上的 `chmod` 只会动只读位，POSIX 权限位不起作用；代码里 `chmodSync` 的失败也被 try/catch 吞掉。

实际保护来自 `%USERPROFILE%\.dsh\pocket\` 这一层目录的 NTFS 继承 ACL（默认只有本用户可读）。**结论**：同机的其他 Windows 用户读不到；但任何以你的身份运行的进程、以及会打包整个用户目录的备份/同步工具，都能拿到 `auth.json` 与 `cloud.json`。不要把数据目录放进公开同步盘。

### 5. `cloud.allowAnonymous` 可以彻底关掉口令

配置项 `cloud.allowAnonymous` 为 `true` 时，中继会在没有口令的情况下启动（`lib/cloud.mjs:394-397` 的启动前守卫）。此时**链接本身就是全部权限**：拿到链接的人可以读写你的所有会话。这个开关是为自建 broker + 自托管外壳的极端场景留的，默认关闭；除非你完全清楚后果，否则不要打开。

### 6. 手机端的令牌只「包了一层」，不是硬件保护

外壳会把登录令牌用 AES-256-GCM 封起来再写 `localStorage`，但拆封用的 secret 同样存在这台手机上（`remote/remote.js:284-330`）。它能挡住「打开开发者工具复制字符串」，挡不住同源上已经在跑的脚本，更挡不住拿到已解锁手机的人。

**该撤销就撤销**：电脑端配对页的「已登记设备」，或 `node bin/cli.mjs revoke <id|all>`。

### 7. CSP 的 `connect-src` 收不到具体主机上

CSP 里 `connect-src` 是 `'self' http: https: ws: wss:`（`lib/server.mjs:79`），不是白名单。原因是 broker 可配置、而且会随二维码链接下发（`lib/cloud.mjs:184` 的 `s` 参数），外壳必须能连任意 `wss://`，所以这里没法收紧。

后果：CSP 挡不住「页面里的脚本把数据 POST 到任意地址」——真正挡住 XSS 的是 `script-src 'self'` 与「不用 `innerHTML` 拼内容」这两条纪律，而不是 `connect-src`。

## 加固清单

按收益排序，都是配置或运维动作，不需要改代码：

1. **设一个长口令**（`node tools/set-auth.mjs --user 你的名字`，写入数据目录的 `auth.json`）。这是手机入口唯一的闸门。
2. **自己托管外壳**：`node tools/build-shell.mjs` 后把 `docs/` 发到你自己的静态托管，`cloud.appBase` 指向它。外壳就是手机的唯一入口，自己不托管就没有入口。
3. **不要把 `cloud.broker` 留在公共 broker 上**，如果你在意元数据：自建 EMQX/Mosquitto，填 `wss://` 地址。
4. **只给需要的工作目录**：`allowedRoots` 留空 = 全部禁止；不要填 `/` 或整个家目录。
5. **定期清设备**：配对页或 `node bin/cli.mjs devices` 看有没有不认识的设备，撤销掉；改口令会让全部手机失效。
6. **链接泄露就重置**：配对页的「重置链接」立刻作废旧二维码与旧链接。
7. **不要把数据目录放进云同步**（见限制 4）。

## 安全相关代码位置

| 关注点 | 位置 |
| --- | --- |
| 监听地址常量与绑定调用 | `lib/core.mjs:39`、`lib/core.mjs:617` |
| 中继常量（协议版本、帧上限、登录预算、默认 broker/appBase） | `lib/cloud.mjs:37-107` |
| 中继路由白名单与拒绝名单 | `lib/cloud.mjs:231-258` |
| 信封加解密（AES-256-GCM + AAD） | `lib/cloud.mjs:190-212`、`lib/cloud.mjs:153-156` |
| 重放防护（seq/ts/sid） | `lib/cloud.mjs:772-790` |
| 口令、会话、失败分桶 | `lib/auth.mjs:20-34`、`lib/auth.mjs:61-85`、`lib/auth.mjs:210-310` |
| 登录即登记设备（口令 → 设备令牌、`installId` 复用、`revoked`） | `lib/core.mjs:294-334`、`lib/state.mjs:87-135`、`lib/cloud.mjs:840-893` |
| 设备吊销（`revoked` 标记 / 4001 断开） | `lib/core.mjs:357-365`、`lib/server.mjs:1014-1022` |
| `Host` 校验 / 回环判定 | `lib/core.mjs:440-465` |
| 安全响应头 / CSRF / 回环闸门 | `lib/server.mjs:70-84`、`lib/server.mjs:326-372` |
| 数据文件权限与原子写 | `lib/util.mjs:152-165`、`lib/util.mjs:387-396` |
| 工作目录白名单 | `lib/task-index.mjs:733-762` |
| 手机端登录闸门与令牌封装 | `remote/remote.js:284-330` |

## 许可

MIT，见 [LICENSE](LICENSE)。第三方组件见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
