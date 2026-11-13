# 安全模型与暴露面分析

> 本文件回答两个问题：
> 1. **这个插件**会不会把电脑暴露到公网？
> 2. 它跑在**官方 DeepSeek Harness 宿主**里之后，整台电脑的暴露面是什么？
>
> 两层分开写：第 2 节是插件自己的逐条核验，第 3 节是宿主层的**本机实测**（附原始输出）。
>
> **更正记录（2026-11-13）**：上一版第 3 节把第三方桌面壳 `dataelement/dsh-desktop`
> （v0.12.1）当成了本机宿主来审，把「`0.0.0.0` 局域网桥接端口、cloudflared/Pinggy 隧道、
> 6 位 PIN」写成了 "DSH Desktop 的设计如此"。本机实际宿主是官方 Harness
> （`@deepseek-ai/dsh-desktop` 0.2.2-rc.2），它的监听**全部在回环**（见 §3）。
> 那段第三方壳的分析已降级为附录 A 的对照材料，不再当作本机事实陈述。

---

## 0. 结论

| 场景 | 公网可达 | 局域网可达 |
|---|---|---|
| 只装插件、中继关闭 | 否 | 否（插件只监听 `127.0.0.1`） |
| 中继开启（`cloud.enabled: true` + `appBase` 非空 + 已设口令） | 否 | 否（只有一条**出站** `wss://`） |
| 官方 Harness 宿主正常启动 | 否 | 否（实测 DSH 的 2 个监听全在 `127.0.0.1`，见 §3.1） |

一句话：**插件与宿主都没有入向监听**。手机能看到电脑，靠的是电脑主动连出去的加密中继，
不是电脑上开了某个端子在等人连。

> 边界：§3 是**某一时刻的本机快照**（2026-11-13 09:37 +08:00，Windows，DSH
> `@deepseek-ai/dsh-desktop` 0.2.2-rc.2）。它是可复现的测量，不是对"任何机器上永远没有
> 非回环监听"的保证——那台机器上就有 22 个通配地址监听，属于 Windows 自身服务，与 DSH 无关。

---

## 1. 资产与信任边界

**资产**：会话内容、工作区文件、agent 的命令执行能力、设备令牌、端到端密钥。

**一律不信任**（按零信任设计）：

- 你托管手机端外壳的静态托管（例如 GitHub Pages）
- 公共 MQTT broker（默认 `wss://broker-cn.emqx.io:8084/mqtt`，见 `lib/cloud.mjs` 的 `DEFAULT_BROKERS`）
- 本机其它进程、同网段设备
- 拿到二维码或链接的人

---

## 2. 插件层：逐条核验

> 本节引用的是**符号名**而不是行号。`lib/` 下的文件在持续改动，行号一定会过期，
> 符号名（函数名 / 常量名 / 类方法名 / 错误码）是稳定的。

### 2.1 只绑回环

- `lib/core.mjs` 的 `LOOPBACK_HOST = '127.0.0.1'`，由 `BridgeCore.startOnce()` 传给
  `server.listen(this.config.port, LOOPBACK_HOST)`；监听地址**不可配置**。
- `lib/server.mjs` 的 `BridgeServer.listen()` 先用 `canBindWithRetry()`（内部 `canBind()`）
  探端口所有权，再真正监听。
- `lib/index.mjs` 的模块头注释即 "loopback-only HTTP/WebSocket listener … nothing here listens on the WAN"。

→ **成立**。实测：插件端口 `127.0.0.1:47901` 出现在监听表里，且 `Get-NetTCPConnection`
显示其 `LocalAddress` 是 `127.0.0.1`（见 §3.1）。

### 2.2 Host 校验、CSRF、安全响应头

- `lib/server.mjs` 的 `securityHeaders()`：`x-frame-options: DENY`、`x-content-type-options: nosniff`、
  `referrer-policy: no-referrer`、`permissions-policy: camera=(), microphone=(), geolocation=()`、
  CSP `default-src 'self'; … script-src 'self'`。
- `BridgeServer.handle()`：`Host` 不在 `BridgeCore.allowedHosts()` 的白名单里 → `403 bad_host`（防 DNS rebinding）。
- `BridgeServer.requireLoopback()`：来源不是回环 → `403 loopback_only`；写操作再过
  `BridgeServer.csrfOk()`（先 `Sec-Fetch-Site`、再 `Origin`、最后比对每进程的 `BridgeCore.csrfToken`），
  失败回 `403 csrf`。

→ **成立**。注意 `script-src 'self'`：外壳页不会执行第三方脚本；`connect-src` 放开 `ws:/wss:`
是给 broker 连接用的。

### 2.3 端到端加密

- `lib/cloud.mjs` 的 `seal()`：`createCipheriv('aes-256-gcm', key, iv)` + `cipher.setAAD(...)`（AAD 绑定主题，搬帧/改帧都会解密失败）。
- `lib/cloud.mjs` 的 `unseal()`：解密侧同样 `decipher.setAAD(...)`。
- 密钥只存在于二维码 URL 的 `#` fragment 与 `~/.dsh/pocket/cloud.json`；fragment 不会随 HTTP 请求发给静态托管。

→ **成立**。**残余**：静态密钥、无前向保密（no ratchet）；密钥一旦泄露，此前录下的密文可被解开。

### 2.4 鉴权与重放防护

- `lib/auth.mjs` 的 `sha256()`：会话令牌在 `sessions.json` 里只存 SHA-256 摘要（`Auth.check()` 用
  `sha256(token)` 查表），泄露该文件不能直接登录。
- `lib/auth.mjs` 的 `Auth.login()`：`randomBytes(32)` 生成 32 字节令牌，有效期由 `SESSION_TTL_MS`（15 天）
  与 `SHORT_SESSION_TTL_MS` 决定。
- `lib/auth.mjs` 的 `verifyPassword()`：用 `timingSafeEqual` 做常量时间比较（scrypt 派生）。
- `lib/cloud.mjs` 的 `STALE_WINDOW_MS = 120_000` 与 `CloudLink.checkFreshness()`：每帧带 `ts`，
  每个 `sid` 的 `seq` 必须单调递增，重放/回退即拒绝。
- `lib/cloud.mjs` 的 `REPLAY_CACHE_MS` / `REPLAY_CACHE_MAX`：`res` 帧幂等缓存，独立于重放窗口。

→ **成立**。逐帧、无状态鉴权，重启后仍有效。

**残余**（2026-11-11 审计实测，代码版本 1.0.2）：

- **重放闸的覆盖范围**：只有会触发动作的 `req` 与 `ws.open` 走 `CloudLink.checkFreshness()`；
  `ws.msg` / `ws.close` 不带 `ts` / `seq`。上行隧道只收 `ping` / `resync` 且隧道 id 随机，
  今天没有可用路径，但边界要说清。
- **`seq` 表是 64 条 FIFO**（`SEQ_TABLE_MAX` + `CloudLink.sweepSeq()`）：灌 64 个新 `sid` 会把
  真实手机的条目挤掉，同一帧于是又能被接受一次。缓解是 `res` 幂等缓存（120 s）——窗口内重复
  执行会被吃掉，窗口外则不会。
- **没有账号级锁定**：`LOGIN_BUDGET` 只给到「每个中继链接 10 次/分钟」（`LOGIN_BUDGET_MS` 窗口），
  而 `Auth.login()` 的 5 次锁定要求传入 `ip` 或 `deviceId`，中继登录调用点两个都不传
  （有意：共享锁会让陌生人把机主锁死）。所以**口令强度是唯一屏障**，请用长口令。

### 2.5 中继 nonce 与文件白名单

- `lib/util.mjs` 的 `RELAY_HEADER = 'x-pocket-relay'`。
- `lib/core.mjs` 的 `BridgeCore` 构造器里 `this.relayNonce = randomHex(16)`（每进程随机）；
  HTTP 入口在 `BridgeServer.handle()` 里用 `safeEqual(raw, this.core.relayNonce)`（`safeEqual()` 来自
  `lib/util.mjs`）比对，缺失或伪造即按远程请求处理（fail-closed）。
- `lib/core.mjs` 的 `normalizeAllowedRoots()` + `MAX_ALLOWED_ROOTS = 64`：文件访问受白名单约束。

→ **成立**（具体语义以实现与测试为准）。

### 2.6 没有的东西

仓库内没有 UPnP / NAT-PMP / frp / ngrok / 反向代理逻辑；唯一的对外连接是**出站** WSS 到 broker
（`lib/cloud.mjs` 的 `DEFAULT_BROKERS`）。

---

## 3. 宿主层：官方 Harness 的实测暴露面

### 3.1 本机实测（原始输出，已脱敏）

实测时间：**2026-11-13 09:37 +08:00**；宿主：`@deepseek-ai/dsh-desktop` **0.2.2-rc.2**
（`D:\tools\dsh\resources\app.asar` 内的 `package.json`）；Windows。

```powershell
# 1) DSH 自己开了哪些监听
$ids = @(Get-Process 'DeepSeek Harness').Id
Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess } |
  Select-Object LocalAddress, LocalPort

# 2) 谁在通配地址（0.0.0.0 / ::）上监听，按进程名归组
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalAddress -in @('0.0.0.0','::') } |
  ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } |
  Group-Object | Sort-Object Count -Descending | Select-Object Count, Name
```

输出（脱敏后逐字摘录）：

```text
DSH 进程数 = 10
DSH 监听数 = 2
LocalAddress LocalPort
127.0.0.1        54430      ← DSH GUI
127.0.0.1        47901      ← 本插件的回环桥
非回环监听按进程名归组：svchost x8, LMS x4, lsass x2, System x2, services x2, spoolsv x2, wininit x2
```

### 3.2 判读

- **DSH 的 10 个进程一共只有 2 个监听，全是 `127.0.0.1`**（GUI 54430、插件桥 47901）。
  没有任何 DSH 进程监听通配地址，也没有隧道进程（`Get-Process cloudflared,ssh` 无命中）。
- 同一台机器上确实有 **22 个**通配地址监听，但按进程归属它们全部是 Windows 自身服务
  （svchost / LMS / lsass / System / services / spoolsv / wininit）。**那是机器的暴露面，
  不是 DSH 的，也不是本插件带来的**；装不装本插件都在。
- 因此"装了这个插件之后，局域网里能扫到一个 DSH 的配对端口"这句话在本机**不成立**。

### 3.3 源码侧旁证（不替代上面的实测）

在 `D:\tools\dsh\resources\app.asar`（208,137,981 字节）里按字节统计：

- `cloudflared`、`pinggy`、`trycloudflare`、`lan-mobile-bridge`：各 **0 次**。
- `0.0.0.0`：**65 次**，按文件归属逐条统计，全部落在文档/README、
  `@deepseek-ai/dsh-http-proxy` 的代理旁路策略、以及第三方依赖（`zod`、`ipaddr.js`）的测试与说明里。
- 官方自己在 `@deepseek-ai/dsh-client-connection` 的 README 里写着：
  "`dsh web --host 0.0.0.0` is unsupported."（中文版同义）

---

## 4. 组合后的攻击面

| # | 场景 | 结果 | 前提 |
|---|---|---|---|
| S1 | 同网段扫描 | 扫不到本插件与宿主（都只听回环）；能扫到的是机器上其它软件 | 主机在线 |
| S2 | 二维码/链接泄露 | 拿到 `room`+`key` 的人可订阅上行主题，并从手机发出的帧里读出**有效设备令牌**（令牌随每帧携带），因此不需要口令——等同于完全控制 | 拿到图/链接 |
| S3 | broker 旁观 | 可见房间主题、时序、帧大小；内容为密文 | 订阅 `dshm/#` |
| S4 | 静态外壳被篡改 | 可读 `location.hash` 偷 E2E 密钥 | 托管账号或外壳 XSS |
| S5 | 本机恶意进程 | 读 `cloud.json` 明文密钥、二维码 PNG | 已在本机执行 |
| S6 | 手机浏览器上的第三方脚本 | 读 `localStorage` 里的房间密钥与设备令牌（见 R14） | 外壳同源被破坏 |
| S7 | 第三方插件/工作台 | 任意代码执行（与宿主同权限） | 用户安装 |

---

## 5. 风险登记

> 编号从 R5 起：R1–R4 与 R10 原属**第三方桌面壳**的分析（0.0.0.0 桥接、隧道常驻、PIN 爆破、
> 自动开隧道、cloudflared 更新链），与官方宿主无关，已移出风险登记，只在附录 A 保留对照。
> 保留原编号是为了不打断既有的引用。

| ID | 风险 | 严重度 | 说明与缓解 |
|---|---|---|---|
| R5 | 公共 broker 匿名可订阅 | 低 | `lib/cloud.mjs` 的 `CloudLink.connect()` 调用 `mqtt.connect(this.broker, {…})` 时没有传 `username`/`password`；可观元数据、可刷流量，但不能解密或伪造（无密钥） |
| R6 | 静态外壳供应链 | 中 | 托管被篡改或前端 XSS 可窃取 fragment 密钥；CSP `script-src 'self'` 降低但非零 |
| R7 | 密钥明文落盘 | 中 | `cloud.json` 明文；二维码默认写 `~/dsh-pocket-qr.png`；防本机恶意进程 |
| R8 | 无前向保密 | 低-中 | 静态 E2E 密钥；泄露即可解历史密文 |
| R9 | 插件/工作台任意代码 | 高 | 安装即等于授权；只在可信来源安装，必要时用 Safe Mode |
| R11 | 链接泄露等于**完全控制**，不只是"能发起连接" | 中 | 拿到 `room`+`key` 的人可订阅上行主题，从手机发出的帧里直接读出**有效设备令牌**（15 天有效），因此不需要口令。二维码/链接应视同账号密码 |
| R12 | 移除设备不换房间与密钥 | 低-中 | 吊销只作废那枚令牌，`room` / `key` 不动：旧链接仍可**被动解密**之后的帧（发不出可用指令）。手机丢了要作废旧码，只能用电脑端「重置链接」 |
| R13 | Host 白名单含本机主机名 | 低 | `BridgeCore.allowedHosts()` 除 `localhost`/`127.0.0.1` 外还含 `os.hostname()` 与 `<主机名>.local`（为让 `http://<主机名>:<端口>/pair` 打得开）。DNS rebinding 因此多一条理论路径：需知道你的主机名并拥有与它逐字相同的域名；公开 DNS 注册不了单标签名，`.local` 还需同网段 mDNS 投毒 |
| R14 | 房间密钥与设备令牌落在手机浏览器的 `localStorage` | 中 | 手机端外壳为"从桌面图标裸启动也能恢复"必须记住入口链接：`remote/remote.js` 的 `storeLink()` 把整条 `#r=…&k=…&t=…` 链接（**含 AES-256-GCM 房间密钥与初始设备令牌**）明文写进 `localStorage`（键名 `dsh.pocket.link.v1`）。这不是安全承诺，是已知取舍：任何能在该源上执行的脚本都能读到它。因此手机端外壳**必须由你自己同源托管、不得引入第三方脚本**（CSP 的 `script-src 'self'` 是第二道） |

### 5.1 已知限制（用户能感知的部分）

- **手机丢了的正确处置是电脑端「重置链接」**：它换房间与密钥，旧链接立即失效。
  只「移除设备」不够——见 R12。
- **浏览器隐私模式/清理站点数据**：`localStorage` 被清掉后，裸启动恢复不了链接，
  需要重新扫码（这不会降低安全性，只是不方便）。
- **口令是唯一屏障**：没有账号级锁定（见 §2.4 残余），请用长口令。

---

## 6. 不要做的事

- 不要为了让手机连上，把插件或宿主的监听地址改成通配（插件的监听地址不可配置；官方 Harness
  的 `dsh web --host 0.0.0.0` 明确不受支持，见 §3.3）
- 不要把配对二维码/链接发到群里；它等价于连接入口凭据
- **不要给手机端外壳引入第三方脚本或跨源资源**：那个源上的脚本能读 `localStorage` 里的房间密钥与设备令牌（R14）
- 不要在不可信目录安装第三方插件或工作台
- 不要把 `cloud.json`、QR PNG 提交进任何仓库

---

## 7. 自检

```powershell
# 插件：应当只有 127.0.0.1
Get-NetTCPConnection -LocalPort 47901 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess

# 宿主：DSH 的全部监听都应当只有 127.0.0.1 / ::1（本机实测如此）
$ids = @(Get-Process 'DeepSeek Harness').Id
Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess } |
  Select-Object LocalAddress, LocalPort

# 通配地址上都有谁（看进程名，不是 DSH 就不属于本文范围）
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalAddress -in @('0.0.0.0','::') } |
  ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } |
  Group-Object | Sort-Object Count -Descending | Select-Object Count, Name
```

判读：

- **插件端口出现 `0.0.0.0` = 异常**，立刻处理（监听地址本应恒为 `127.0.0.1`）。
- **宿主端口出现 `0.0.0.0` 同样要查**：本机实测 DSH 不监听通配地址。若出现，说明宿主版本、
  启动参数或运行环境变了，或者那个端口其实属于另一个进程——用 `OwningProcess` 反查进程名，
  不要假设"设计如此"。

---

## 8. 范围、版本与披露

- 审阅对象：`dsh-pocket-plugin` **1.0.2**；宿主 `@deepseek-ai/dsh-desktop` **0.2.2-rc.2**
  （本机安装目录 `D:\tools\dsh\resources\app.asar`）。
- 方法：源码静态审计 + 本机运行时测量（监听表、进程归属、插件回环接口）。
- 未覆盖：宿主打包产物的二进制差异；MQTT broker 自身安全；手机端浏览器/系统的实现；
  **附录 A 的第三方壳内容未在本机复验**（其源码不在本机，结论按其上游 `main` 的公开代码记录）。
- 本文不构成安全保证；发现新问题请通过仓库 Issue 或维护者邮箱私下披露。

---

## 附录 A：第三方桌面壳的实现对照（不是本机宿主，仅供对照）

> **这一段不是本机事实，也不适用于官方 Harness。** 它记录的是另一个产品
> `dataelement/dsh-desktop`（v0.12.1，`main`）的做法，保留下来只为两件事：
> (a) 如果你用的确实是那个第三方壳（而不是官方 Harness），下面这些才是你要评估的暴露面；
> (b) 说明"宿主会开 `0.0.0.0` 端口 + 公网隧道"这类说法从哪来，避免再被当成 DSH 的事实。
> 官方 Harness 的实测结论见 §3。

- 启动即开局域网口：`src/main/mobile/lan-mobile-bridge.ts` 里 `server.listen(port ?? 0, '0.0.0.0')`
  （绑所有网卡、随机端口），应用启动即 `mobileBridge.start()`；对非私网来源回
  `403 Private network only`，配对需要一次性 token。
- 按需公网隧道：`src/main/mobile/cloudflared-tunnel.ts` 跑 `cloudflared tunnel --url http://127.0.0.1:<bridge>`，
  失败回落 Pinggy（`pinggy-tunnel.ts`，约 60 分钟）；只转发配对/移动桥接面，不转发 Harness 本体。
- 鉴权：一次性配对 token（32 字节、5 分钟）、互联网模式 6 位 PIN、按 IP/全局限速。
- 生命周期：关掉"连接手机"窗口不停隧道，断开手机也不停隧道，没有私网 IPv4 时会自动开隧道。
- 对应风险就是本文旧版的 R1–R4 与 R10。

如果你要审计的是那个壳，请以它自己的仓库和版本为准——本文件不对它做任何保证。
