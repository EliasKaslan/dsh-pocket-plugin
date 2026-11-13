# DSH 随行 · dsh-pocket-plugin

**用手机在任何网络下，看你电脑上正在跑的 DeepSeek Harness。** 电脑不需要公网 IP、不开放任何入站端口，也不做内网穿透或端口映射。

> ✅ **v1.0.1。** 首个公开发布版 v1.0.0 已在真手机、真网络下完成连续进入、断线重连、向上翻页、流式输出等场景的自测；1.0.1 是随后的 bugfix 发布。

v1.0.1 · 正式版 · MIT

> 🔐 为什么它**不需要公网 IP、也不会把电脑暴露到公网**：见 [SECURITY.md](SECURITY.md)。

---

## 1. 它是什么，能做什么

它是 DSH 的一个插件。装上之后，电脑上的 DSH 会在本机 `127.0.0.1` 起一个小服务，把当前会话**当成任务**暴露给手机；手机通过一个加密中继连上来，得到一个和桌面几乎一样的任务面板。

在手机上你可以：

- **看任务列表**：所有会话、状态、模型、最近活动时间，**按最近活动倒序**（最新的在最前）
- **看任务详情**：每一轮对话、每一次工具调用、命令输出与报错
- **新建任务**：选工作目录、选 Agent 预设，写一句话就开工
- **追问与中断**：给正在跑的任务补一句话，或者把它停下来
- **实时进度**：任务状态与新消息经 WS/SSE 推到手机上，不用手动刷新
- **长会话也能翻**：点进去先给你最近一屏（含你最近几次说的话），**往上翻会自动加载更早的记录**，一直能翻到会话开头。每一页都有体积上限，所以会话再长也不会卡住或"加载不出来"

一句话：**你离开电脑之后，电脑上的活儿还在继续，而你能盯着它、也能接着指挥它。**

## 2. 它的优点

**电脑零公网暴露。**
插件只监听 `127.0.0.1`，对外只有一条**出站**的 `wss://` 连接。没有反向代理、没有端口映射、没有内网穿透，路由器和防火墙不用为它开任何东西。

**端到端加密，中转看不到内容。**
手机与电脑之间的载荷用 AES-256-GCM 封装，密钥只存在于二维码的 `#` 片段里，**从来不上行**，中继服务器只经手密文。用的是你自己托管的外壳 + 一个公共 broker，全程没有第三方账号体系。

**只需要一个凭据：账号 + 口令。**
不用记配对码、不用记端口、不用记地址。扫码打开页面，输一次账号和口令就进去了。

**15 天免密，而且会续期。**
登录后有效期 15 天；**只要还在用就一直往后推**（每 24 小时最多续一次），所以常用的手机不会在第 15 天突然掉线。真正没连满 15 天，才需要重新输口令。

**二维码固定放在你的个人目录。**
`~/dsh-pocket-qr.png`（Windows：`C:\Users\<你>\dsh-pocket-qr.png`）。不用回电脑上找某个带随机端口的网址，随时想看就看。链接不变不会重写，中继身份轮换后自动更新。

**多台手机可以同时用。**
设备按手机自己的标识认，第二台登录**不会把第一台顶掉**。桌面页能看到已登记的设备，随时单独移除某一台。

**更新插件不用重启 DSH。**
在设置 → 插件里把它关掉再打开就生效（新代码会重新加载）。`/api/v1/health` 里的 `bootId` 每次加载都会变，用来确认"确实换了新实例"。

**出错时它会说清原因。**
中继没开、没设口令、外壳地址没填——连接页会直接写明是哪一种、下一步该做什么，而不是给你一个空白页。

## 3. 安装

**这一节只面向 agent，你不需要照着做任何步骤。**

安装涉及改 profile 的 `package.json`、登记 bundle、跑包管理器、填 `appBase` 并托管手机端页面——这些**依 DSH 版本而变**，写死在 README 里只会过期。所以细节都在仓内单独的指导文件里：

> 📄 **[`INSTALL.md`](INSTALL.md)** —— 给 agent 看的安装与运维指南

你要做的只有一件事：**把下面这句话发给你的 agent**（它需要能改本机文件，比如 `danger-full-access` 权限）：

```text
把 https://github.com/EliasKaslan/dsh-pocket-plugin 这个插件装到我的 DSH 里，按仓内 INSTALL.md 来，
装完照里面的四条验收自查，把二维码文件路径、手机登录用的用户名告诉我。
```

agent 会自己完成安装、配置、托管手机端外壳、启动并验收，最后告诉你**二维码在哪**、**用户名是什么**。

如果它卡住了，把 `INSTALL.md` 里「常见故障」那张表丢给它。

## 4. 安装后怎么用

**第一步：拿到二维码**

装好之后二维码就是这个文件，用手机相机直接扫：

```text
C:\Users\<你>\dsh-pocket-qr.png        # Windows
~/dsh-pocket-qr.png                    # macOS / Linux
```

也可以在电脑上打开连接页看同一张码：`http://127.0.0.1:47901/pair`

**第二步：在手机上登录**

扫码会打开手机端页面（外层是加密通道，进面板还要过口令闸）。输入：

- **用户名**：电脑上设置的那个（agent 会把名字告诉你）
- **口令**：你自己设的那个

登录成功就进去了。**之后 15 天不用再输**，只要还在用就会一直续期。

**第三步：日常使用**

| 你想做的事 | 去哪 |
|---|---|
| 看电脑上正在跑什么 | 打开手机端页面，首页就是任务列表 |
| 接手指挥某个任务 | 点进任务，底部输入框追问；右上角可以中断 |
| 想往前看更早的记录 | 在会话里**往上翻**，翻到顶会继续加载更早的一页，直到会话开头 |
| 开新任务 | 列表页新建，选工作区与预设 |
| 手机丢了 / 换手机 | 电脑连接页「已登记设备」里点「移除」，那台手机立刻失效 |
| 觉得二维码被人看过 | 连接页点「重置链接」，旧二维码立刻作废，重新扫新的 |
| 暂时不想让手机连 | 连接页里暂停远程访问 |

**两件要注意的事**

- **二维码等同于入口凭据**：它里面带着与电脑通信的密钥。别截图发群、别贴到公开文档里。真泄露了就「重置链接」。
- **中继是第三方公共服务**：它只经手密文，看不到内容，但能看到"有流量"这件事，也不保证 100% 可用。想彻底自己掌控，`INSTALL.md` 里写了怎么换自建 broker。

更多细节：安全模型与已知限制见 [`SECURITY.md`](SECURITY.md)，实现与排障见 [`INSTALL.md`](INSTALL.md)。

---

## 5. DSH 兼容性

**已验证版本**：DSH `0.2.2-rc.2`（Desktop profile，Windows）。

实测通过的项：

- 8 个宿主服务全部绑定成功：`sessionQuery`、`agents`、`sessions`、`userQuestions`、
  `agentPresets`、`agentDefaultModel`、`workspaceRegistry`、`sessionPersistence`
  （`lib/index.mjs` 的 `bind()` 共 8 次调用；运行日志里 `service bound: <name>` 也是 8 条）
- 从 `~/.dsh/sessions` 读取会话索引成功（数量随会话增长）
- 会话详情读取（`sessionQuery.readSurface`）正常
- 加密中继上线（`cloud link online`）

### 5.1 它依赖的 DSH 表面

升级 DSH 后只需要对照这张表——只有这些变了才需要改本插件：

| 表面 | 用途 |
| --- | --- |
| `sessionQuery`（含 `readSurface`） | 读取会话详情与正文 |
| `agents` | 任务状态、在跑/已停 |
| `sessions` | 按 id 取会话 |
| `userQuestions` | `ask_user_question` 的答卷通道（手机端 `tasks.answer` 走它） |
| `agentPresets` | 新建任务时可选预设 |
| `agentDefaultModel` | 展示与默认模型 |
| `workspaceRegistry` | 工作目录选择 |
| `sessionPersistence` | 会话持久化目录定位 |

本插件**不涉及**：Client slot / 右键菜单 / CSS 锚点菜单、Forge、Schedule、Office、
CUA、终端 bundle、LLM 路由、`Session.append`、session projection。

### 5.2 免于升级影响的依据

DSH `0.2.2-rc.1`、`0.2.2-alpha.3`、`0.2.2-alpha.2` 三段升级指南共 31 项变更中，
本插件对 `Session.append`、session projection（帧与快照）、`BundleInfo`、
`interrupt_agent`、Client 菜单/浮层等改动表面的引用次数均为 **0**。
因此从这些版本升级到 `0.2.2-rc.2` 不需要改动本插件。

**未验证**：早于 `0.2.2-rc.2` 的版本未做系统验证；`engines.dsh` 只声明已验证的下界。

`engines.dsh` 在两处形态不同是故意的：`package.json` 只声明已验证的下界
（`>=0.2.2-rc.2`），`market/index.json` 需要带上界（`>=0.2.2-rc.2 <0.3.0-0`），
让市场按区间过滤兼容版本。**两处的下界必须一致**——放宽成 `>=0.2.2-rc.1` 会把插件
推给未验证的宿主，`test/protocol/packaging.test.mjs` 会拦住这种改动。

### 5.3 升级后异常，先看这三行日志

1. `service bound: <name>` 缺失 —— 该服务接口改名或移除，需要适配
2. `task index loaded N sessions` 失败或为 0 —— 会话日志格式变了
3. 手机端「连接中断」但电脑端 `cloud link online` 正常 —— 中继没问题，查 `sessionQuery`

`package.json` 里通过 `engines.dsh` 声明了已验证的版本下界，
便于在版本不匹配时被及早发现，而不是以「静默失效」的形式出现。

## English

DSH Pocket puts your desktop DeepSeek Harness on your phone from any network. The desktop keeps listening on `127.0.0.1` only and makes a single outbound `wss://` connection to a relay; nothing is exposed to the public internet. Payloads are sealed with AES-256-GCM and the key lives in the QR-code fragment, so the broker only ever sees ciphertext. One credential — the account and password you set on the desktop — gets you in, and the session lasts 15 days and slides while you keep using it. The QR code is always at `~/dsh-pocket-qr.png`. MIT licensed.

Installation is documented for agents in [`INSTALL.md`](INSTALL.md); just ask your agent to install the repo following that file.
