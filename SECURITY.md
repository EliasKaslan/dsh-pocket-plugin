# 安全模型与暴露面分析

> 本文件回答两个问题：
> 1. **这个插件**会不会把电脑暴露到公网？
> 2. 它跑在 **DSH Desktop** 宿主里之后，整台电脑的暴露面是什么？
>
> 上一版只回答了第 1 个问题，并把结论写成"电脑上没有任何端口在等待外部连接"。
> 这个说法**对本插件成立，对宿主不成立**：DSH Desktop 为了手机配对会在 `0.0.0.0`
> 上开一个随机端口，并且可以按需建立公网隧道。本版把两层分开写清楚。

---

## 0. 结论

| 场景 | 公网可达 | 局域网可达 |
|---|---|---|
| 只装插件、宿主不开手机连接 | 否 | 否（仅回环 `127.0.0.1`） |
| DSH Desktop 正常启动（未开手机连接） | 否 | **是**（宿主桥接随机端口） |
| DSH Desktop 打开"连接手机"→ 局域网模式 | 否 | 是（需一次性配对码） |
| DSH Desktop 切到"互联网"模式 | **是**（随机 `trycloudflare.com` 域名，需 6 位 PIN） | 是 |

一句话：**插件是"零入向"；宿主是"一个常开的局域网口 + 一个按需的公网口"。**

---

## 1. 资产与信任边界

**资产**：会话内容、工作区文件、agent 的命令执行能力、设备令牌、端到端密钥。

**一律不信任**（按零信任设计）：

- GitHub Pages（静态外壳）
- 公共 MQTT broker（`broker-cn.emqx.io`）
- Cloudflare Quick Tunnel / Pinggy
- 本机其它进程、同网段设备、拿到二维码或链接的人

---

## 2. 插件层：逐条核验

### 2.1 只绑回环

- `lib/core.mjs:636`：`server.listen(this.config.port, LOOPBACK_HOST)`，`LOOPBACK_HOST = '127.0.0.1'`
- `lib/server.mjs:179-180`：先 `canBind(..., '127.0.0.1')` 探端口，再监听
- `lib/index.mjs:4`：模块说明即 "loopback-only HTTP/WebSocket listener"

→ **成立**。注意：这是**插件的**监听；宿主另有监听（见第 3 节）。

### 2.2 Host 校验、CSRF、安全响应头

- `lib/server.mjs:272-276`：`Host` 不在白名单 → `403 bad_host`（防 DNS rebinding）
- `lib/server.mjs:374`：来源非回环 → `403 loopback_only`
- `lib/server.mjs:379`：同源校验失败 → `403 csrf`
- `lib/server.mjs:71-79`：`X-Frame-Options: DENY`、`nosniff`、`no-referrer`、`Permissions-Policy`、CSP `default-src 'self'; script-src 'self'`

→ **成立**。CSP 的 `connect-src` 放开 `ws:/wss:` 是给 broker 连接用的；`script-src 'self'` 意味着外壳不会执行第三方脚本。

### 2.3 端到端加密

- `lib/cloud.mjs:204-205`：`createCipheriv('aes-256-gcm', key, iv)` + `setAAD(topic)`
- `lib/cloud.mjs:220-221`：解密侧同样校验 AAD
- 密钥只存在于二维码 URL fragment 与 `~/.dsh/pocket/cloud.json`；fragment 不会随 HTTP 请求发给 GitHub Pages

→ **成立**。AAD 绑主题，搬帧/改帧都会解密失败。
**残余**：静态密钥、无前向保密（no ratchet）；密钥一旦泄露，此前录下的密文可被解开。

### 2.4 鉴权与重放防护

- `lib/auth.mjs:8`：会话令牌只存 SHA-256 摘要，泄露 `sessions.json` 不能直接登录
- `lib/auth.mjs:314-315`：32 字节随机令牌 + TTL
- `lib/auth.mjs:85`：`timingSafeEqual` 常量时间比较
- `lib/cloud.mjs:85`：`STALE_WINDOW_MS = 120_000`（时间戳窗口）
- `lib/cloud.mjs:92-94`：每个 `sid` 单调递增 `seq`，重放/回退即 `reject(stale)`
- `lib/cloud.mjs:87-88`：`res` 帧幂等缓存（独立于重放窗口）

→ **成立**。逐帧、无状态鉴权，重启后仍有效。

**残余**（2026-11-11 审计实测，v1.0.1）：

- **重放闸的覆盖范围**：只有会触发动作的 `req` 与 `ws.open` 走 `checkFreshness`；`ws.msg` / `ws.close` 不带 `ts` / `seq`。上行隧道只收 `ping` / `resync` 且隧道 id 随机，今天没有可用路径，但边界要说清。
- **`seq` 表是 64 条 FIFO**（`sweepSeq`）：灌 64 个新 `sid` 会把真实手机的条目挤掉，同一帧于是又能被接受一次。缓解是 `res` 幂等缓存（120 s）——窗口内重复执行会被吃掉，窗口外则不会。
- **没有账号级锁定**：`LOGIN_BUDGET` 只给到「每个中继链接 10 次/分钟」，而 `auth.login()` 的 5 次锁定要求传入 `ip` 或 `deviceId`，中继登录调用点两个都不传（有意：共享锁会让陌生人把机主锁死）。所以**口令强度是唯一屏障**，请用长口令。

### 2.5 中继 nonce 与文件白名单

- `lib/util.mjs:25`：`RELAY_HEADER = 'x-pocket-relay'`
- `lib/core.mjs:198`：每进程随机 `relayNonce`，`safeEqual` 常量时间比较；缺失/伪造即按远程请求处理（fail-closed）
- `lib/core.mjs:90-102`：`allowedRoots` 归一化 + 数量上限，文件访问受白名单约束

→ **成立**（具体语义以实现与测试为准）。

### 2.6 没有的东西

仓库内没有 UPnP / NAT-PMP / frp / ngrok / 反向代理逻辑；唯一的对外连接是**出站** WSS 到 broker
（`lib/cloud.mjs:112`，`DEFAULT_BROKERS = ['wss://broker-cn.emqx.io:8084/mqtt']`）。

---

## 3. 宿主层：DSH Desktop 新增的暴露面

> 以下结论来自 `dataelement/dsh-desktop` 源码（`main`，v0.12.1）。这是第三方桌面壳，不是官方 Harness。

### 3.1 启动即开的局域网端口

- `src/main/mobile/lan-mobile-bridge.ts:235`：`server.listen(port ?? 0, '0.0.0.0')` —— **绑所有网卡、随机端口**
- `src/main/index.ts:3636`：应用启动即 `mobileBridge.start()`（Safe Mode 除外）

所以：**只要你开着 DSH Desktop，同网段就有一个可被扫描到的 HTTP 端口**，即使你从没用过手机功能。

缓解：`lan-mobile-bridge.ts:664-665` 对非私网来源直接 `403 Private network only`；
配对需要二维码里 256-bit 一次性 token（5 分钟）。没有 token 无法配对。

### 3.2 按需的公网隧道

- `src/main/mobile/cloudflared-tunnel.ts:279`：`cloudflared tunnel --url http://127.0.0.1:<bridge>`
- `:125,132`：cloudflared 从 GitHub Releases 下载，**带 SHA256 校验**
- 失败回落 Pinggy：`ssh -R 0:127.0.0.1:<port> dsh@free.pinggy.io`（`pinggy-tunnel.ts:10,63-68`，约 60 分钟）
- 只转发**配对/移动桥接面**，不转发 Harness 本体

### 3.3 鉴权

| 机制 | 参数 | 代码 |
|---|---|---|
| 一次性配对 token | 32 字节，5 分钟，配对即作废 | `:446-452`、`:959` |
| 互联网 PIN | 6 位；默认 5 分钟只存内存；勾选同意才落盘 `mobile-pairing-pin.json`（0600） | `:29,500` |
| 爆破限速 | 5 次/IP、20 次/全局，10 分钟窗口 | `:30-32`、`:529-550` |
| 会话 | 仅 cookie；tunnel 模式带 `Secure`；LAN 模式另校验来源地址 | `:590-600`、`:963,1003` |

### 3.4 生命周期（容易被忽略）

- **关掉"连接手机"窗口不会停隧道**：`src/main/index.ts:3501-3503` 只清窗口引用；
  界面自己写着 "The connection stays active in the background."
- **断开手机也不会停隧道**：`:898-908` 只清会话 + 轮换 token
- **没有私网 IPv4 时会自动开隧道**：`:3478-3480`

停隧道的唯一正常路径：在窗口里切回"局域网" / 关闭隧道，或退出应用（`mobileBridge.stop()`）。

---

## 4. 组合后的攻击面

| # | 场景 | 结果 | 前提 |
|---|---|---|---|
| S1 | 同网段扫描 | 发现宿主桥接端口；无 token 进不去 | 主机在线 |
| S2 | 二维码/链接泄露 | 可发起配对；互联网模式还需 PIN | 拿到图/链接 |
| S3 | PIN 在线爆破 | 每 10 分钟全局仅 20 次；默认 PIN 5 分钟即失效 | 隧道开着 |
| S4 | broker 旁观 | 可见房间主题、时序、帧大小；内容为密文 | 订阅 `dshm/#` |
| S5 | 静态外壳被篡改 | 可读 `location.hash` 偷 E2E 密钥 | Pages 账号/XSS |
| S6 | 本机恶意进程 | 读 `cloud.json` 明文密钥、QR PNG、PIN 文件 | 已在本机执行 |
| S7 | 第三方插件/工作台 | 任意代码执行（与宿主同权限） | 用户安装 |

---

## 5. 风险登记

| ID | 风险 | 严重度 | 说明与缓解 |
|---|---|---|---|
| R1 | 宿主桥接常开在 `0.0.0.0` | 中 | 无 token 不可用，但端口可被扫描；无法在设置里关闭，只能靠防火墙限制 |
| R2 | 隧道常驻、关窗/断开不停 | 中 | 公网 URL 在应用运行期间持续可达；用完请手动切回局域网 |
| R3 | PIN 在线爆破 | 低 | 6 位 = 1e6；全局 20 次/10 分钟、PIN 5 分钟 TTL → 单个窗口约 10 次尝试，命中概率 ~1e-5 |
| R4 | 无私网 IPv4 时自动开隧道 | 低 | 云主机/纯公网网卡场景；表现为"没点过也开了隧道" |
| R5 | 公共 broker 匿名可订阅 | 低 | `cloud.mjs:483-490` 无 MQTT 用户名/口令；可观元数据、可刷流量，但不能解密或伪造（无密钥） |
| R6 | 静态外壳供应链 | 中 | GitHub Pages 被篡改或前端 XSS 可窃取 fragment 密钥；CSP `script-src 'self'` 降低但非零 |
| R7 | 密钥与 PIN 明文落盘 | 中 | `cloud.json` 明文；QR 默认写 `~/dsh-pocket-qr.png`；防本机恶意进程 |
| R8 | 无前向保密 | 低-中 | 静态 E2E 密钥；泄露即可解历史密文 |
| R9 | 插件/工作台任意代码 | 高 | 安装即等于授权；只在可信来源安装，必要时用 Safe Mode |
| R10 | 更新与二进制供应链 | 中 | cloudflared 有 SHA256 校验；应用走 electron-updater + 签名安装包，但未在本仓库逐一验证 |
| R11 | 链接泄露等于**完全控制**，不只是"能发起连接" | 中 | 拿到 `room`+`key` 的人可订阅上行主题，从手机发出的帧里直接读出**有效设备令牌**（令牌随每帧携带，15 天有效），因此不需要口令。二维码/链接应视同账号密码 |
| R12 | 移除设备不换房间与密钥 | 低-中 | 吊销只作废那枚令牌，`room` / `key` 不动：旧链接仍可**被动解密**之后的帧（发不出可用指令）。手机丢了要作废旧码，只能用「重置链接」 |
| R13 | Host 白名单含本机主机名 | 低 | `allowedHosts()` 除 `localhost`/`127.0.0.1` 外还含 `os.hostname()` 与 `<主机名>.local`（为让 `http://<主机名>:<端口>/pair` 打得开）。DNS rebinding 因此多一条理论路径：需知道你的主机名并拥有与它逐字相同的域名；公开 DNS 注册不了单标签名，`.local` 还需同网段 mDNS 投毒 |

---

## 6. 不要做的事

- 不要为了"手机能连"把宿主改成 `--host 0.0.0.0` 或自建反代裸奔（官方 Harness 本身会拒绝通配地址）
- 不要把配对二维码/链接发到群里；它等价于连接入口凭据
- 不要把长效 PIN 勾上后又长期开着互联网隧道
- 不要在不可信目录安装第三方插件或工作台
- 不要把 `cloud.json`、`mobile-pairing-pin.json`、QR PNG 提交进任何仓库

---

## 7. 自检

```powershell
# 插件：应当只有 127.0.0.1
Get-NetTCPConnection -LocalPort 47901 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess

# 宿主：桥接端口是随机的，出现在 0.0.0.0 上属于已知设计
Get-NetTCPConnection -State Listen |
  Where-Object LocalAddress -in @('0.0.0.0','::') |
  Select-Object LocalAddress, LocalPort, OwningProcess

# 隧道进程
Get-Process cloudflared,ssh -ErrorAction SilentlyContinue | Format-Table Id,ProcessName,Path
```

判读：插件端口出现 `0.0.0.0` = 异常，必须立刻处理；宿主端口出现 `0.0.0.0` = 设计如此，
但意味着"这台机器在局域网上有一个配对入口"。

---

## 8. 范围、版本与披露

- 审阅对象：`dsh-pocket-plugin` 1.0.1；宿主 `dataelement/dsh-desktop` v0.12.1（源码 `main`）
- 方法：源码静态审计 + 本机运行时验证（回环/局域网探针、监听表、进程树）
- 未覆盖：宿主打包后的二进制差异、Cloudflare/Pinggy 服务端行为、MQTT broker 自身安全
- 本文不构成安全保证；发现新问题请通过仓库 Issue 或维护者邮箱私下披露
