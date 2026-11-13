# 交接：已验收场景、实测基线、剩余任务

> 面向下一个接手的 agent。读这一份就够，不需要翻对话记录。
>
> 最后更新：v1.0.2（2026-11-13）——1.0.1 之后补**中继断线诊断**与两处健壮性改进
> （心跳 40 s → 20 s、重试叠 ±20% 抖动），起因是「WiFi 能连、蜂窝流量连不上」
> 但屏幕上只有一句「中继断开，正在重连…」，真实断因只进了 console。
>
> 版本号有**四处手写副本**，改版本必须四处一起改：`package.json` 的 `version`、
> `lib/util.mjs` 的 `PLUGIN_VERSION`（`/api/v1/health` 返回的是它）、
> `cordis.patch.yml` 顶部的注释、以及 `market/index.json` 里登记的 `version`。
> 只改 `package.json` 会让 health 一直报旧版本，市场登记的版本也会和它不一致。
> 其中 `package.json` / `PLUGIN_VERSION` / 市场那份已被 `test/protocol/packaging.test.mjs`
> 自动拦住（CI 会跑）；`cordis.patch.yml` 顶部那行注释只能靠人改。

---

## 0. 三条必须先知道的纪律

1. **`~/.dsh` 是受保护目录**：不要 `Remove-Item -Recurse` / `git clean` / 批量删除。看门狗每 2 分钟快照到 `D:\dsh-vault`，可用 `python D:\workspace\agent\dsh-guard\dsh_guard.py status` 查状态。
2. **改完必须双端推送**：`origin`（GitHub）与 `gitcode` 都要有同一份代码，`git ls-remote --heads <remote> main` 三条 SHA 必须一致。
   **本机 `git push` 挂死的真因是凭据助手弹了一个看不见的 GUI 对话框**，不是 TLS/schannel：
   `ls-remote` 走匿名读所以秒回，`push` 要鉴权就卡在等输入（`GIT_TERMINAL_PROMPT=0` 拦不住 GCM 的窗口）。实测两条可用推法：
   - GitHub：PAT 放进 URL 并**关掉助手**（PAT 在 `~/.dsh/.secrets/github-pr-flow.token`）
     `git -c credential.helper= -c http.version=HTTP/1.1 push https://x-access-token:<PAT>@github.com/EliasKaslan/dsh-pocket-plugin.git main` → 2.2s 成功
   - GitCode：**保留**默认助手（wincred 里有 `git:https://gitcode.com` 缓存）
     `git -c http.version=HTTP/1.1 push gitcode main` → 4s 成功
   - 鉴别方法：`-c credential.helper=` 在 GitCode 上会 **0.8s 快失败** `could not read Username`；
     而 GitHub 上会**挂满 120s 无输出**。两者现象不同，别再用"偶发"描述它。
3. **热重载会打断手机连接**（约 2~5 秒，之后自愈）。合并/提交不需要重载；只有改了 `lib/`（桌面端）才需要。**改 `web/` 与 `remote/` 不需要重载**，只需推送到 GitHub Pages、手机刷新页面。

---

## 1. 怎么跑验收（四条命令，缺一不可）

```powershell
cd D:\workspace\261102_mobile_dsh\dsh-pocket
node tools/check-syntax.mjs                    # 语法（全绿；文件数随新增文件增长，以实际输出为准）
node --test "test/**/*.test.mjs"               # 单测+集成+中继（全绿；用例数以实际输出为准）
node test/e2e/run.mjs                          # 端到端（全绿）
node tools/build-shell.mjs --check             # 外壳产物是否最新（docs/ 与 web/、remote/ 的同步）
```

现状：**四条全绿**。具体数字以这四条命令的实际输出为准（不要背数字，本仓新增测试很快）：
v1.0.1 修复前的基线是 `113 / 631 / 14 / 29`；v1.0.1 结束时是 `133 / 727 / 14 / 31`；
v1.0.2（中继诊断）结束时是 `137 / 762 / 14 / 32`。

---

## 2. 已验收场景清单

### 2.1 鉴权与设备（自动化 + 实机）

| 场景 | 结论 | 证据 |
|---|---|---|
| 口令登录换设备令牌 | ✅ | `test/domain/*auth*`、实机登录成功 |
| 15 天会话 + 滑动续期 | ✅ | `test/domain/session-lifecycle.test.mjs`（11 条） |
| 同一手机重复登录不新增设备 | ✅ | 实机：多次进入后 `state.json` 恒为 3 条设备 |
| 第二台手机登录不顶掉第一台 | ✅ | installId 认设备；`session-lifecycle` 用例 |
| 设备被吊销 → 4001 主动断开 | ✅ | `test/integration/server-branches.test.mjs` |
| 中继设备不可移除（改为「本机·不可移除」） | ✅ | 实机配对页只有 1 个「移除」按钮 |
| 未授权消息逐帧拒绝 | ✅ | `test/relay/*`、日志 `拒绝未授权消息` |

### 2.2 连接与自愈（实机）

| 场景 | 结论 | 证据 |
|---|---|---|
| 冷启动/热重载后自动重连 | ✅ | 日志 `ws open … slots=1`；多次实测 |
| 下行静默 26s → 重建底层 MQTT | ✅ | `test/domain/relay-restart.test.mjs`（4 条） |
| 点「重连」强制重建（不再空操作） | ✅ | 同上；浏览器实测 `restart()` 返回 true，1382ms |
| 重建并发互斥（不开两条连接） | ✅ | 浏览器实测 `a=true / b=false` |
| 硬兜底只在**持续离线 3 分钟**后刷新 | ✅ | 1.0.0 修正后；避免刷新循环 |
| 同一设备只保留最新隧道（槽位不泄漏） | ✅ | 实机 `slots` 从 3/4 → 稳定 1 |
| 中继身份不随重载变化（不用重扫码） | ✅ | 身份指纹 `68bac9f63075492c` 多次重载不变 |
| 电脑端半开链路可自愈（v1.0.0 新增） | ✅ | 看门狗 3s 采样 / 17s 判死 / 连续 2 次才重建，上界 ≈23s（< 手机 26s）；用例 `link-watchdog.test.mjs` |
| 重连后横幅立刻消失（v1.0.0） | ✅ | 收到 `hello` 立即回一条 beat，不再等 8s 周期；用例 `seal-e2ee.test.mjs` |
| 断连可诊断（v1.0.0） | ✅ | `error`/`close` 补日志 + `/api/v1/cloud/status` 的 `stats.closes` / `link` 字段 |

### 2.3 会话列表与详情（自动化 + 实机）

| 场景 | 结论 | 证据 |
|---|---|---|
| 列表纯时间倒序（运行中不再置顶） | ✅ | `test/domain/ui-and-order.test.mjs` |
| 首屏定位到最新一条 | ✅ | 浏览器实测 `atBottom ≈ 0` |
| 向上翻页到最早（无重叠、无遗漏） | ✅ | `test/domain/session-paging.test.mjs`（27 条） |
| 翻页时滚动位置不跳 | ✅ | 元素锚点补偿；用例断言 `applyAt > setAt` |
| 游标失效 → 整页重载（不拼接） | ✅ | `sliceAfter` 的 `reset` 分支 + 用例 |
| 流式增量 `?after=`（只回 4 个字段） | ✅ | 实机 soak 60 次增量，形状每次校验 |
| 增量并发闸命中不丢消息 | ✅ | 1.0.0 加 `detailAppendPending` 补拉 |
| 800ms 缓存窗口内的最后一条不丢 | ✅ | 空结果对同一游标最多补拉一次 |
| 离开会话清 `detailId`（再进会重拉） | ✅ | 代码路径 + 用例断言 |

### 2.4 性能（实测数字，非估算）

| 项 | 实测 | 备注 |
|---|---|---|
| 列表 300 条（回环，未压缩） | 143.5 KB · 28 ms | 中继链路会 gzip |
| 详情首屏 | 59.4 KB / 60 条 · 8~10 ms | 原 112 KB / 80 条 |
| 增量（1 条新消息） | **0.3 KB** | 原 60.6 KB |
| 增量（无新消息） | **82 B** | 原 3662 B |
| 一次 10 秒流式回合总流量 | **~14 KB** | 原 2.03 MB（−99%） |
| `snapshot()` @5000 会话 | **0.14 ms** | 桌面端无 CPU 热点 |
| `summary()` @5000 会话 | **0.17 ms** | |
| gzip | 已生效 | JSON > 1200 B 即压 |
| soak（60 轮 / 40 次翻页 / 60 次增量） | 0 失败 · p95 25 ms · warn/error 0 | |

### 2.5 安全模型（另一 agent 完成，已合并）

- `SECURITY.md`（0–8 节 + 附录 A）：不监听公网、无端口映射、密钥在 URL fragment、AES-256-GCM + AAD、逐帧鉴权、防重放、Host 闸与 relay nonce；宿主层改为**本机实测**（2026-11-13：DSH 的监听全在 `127.0.0.1`），原先那份第三方桌面壳的分析降级为附录 A 的对照材料。
- 代码侧加固：外壳产物校验收紧、补 WS Origin 校验、修幂等缓存串回包、`mqtt` 锁死精确版本 `5.16.1`。
- 对应新增用例：`test/relay/replay-cache-key.test.mjs`（2 条）。

---

## 3. 已知未做 / 未验证（下一步的输入）

### 3.1 性能：还差"手机端"的实测

桌面端已经没有 CPU 热点，响应体也压缩了。剩下没量过的是**手机端渲染**与**中继往返**。为此已埋探针：

- `web/lib/perf.js` 记录 `detail.paint` / `list.paint` 的 p50/p95/max/慢帧数；
- 数据在 `globalThis.__POCKET_PERF__.snapshot()`。

**待接线**：设置页「复制诊断」还没把这段带出来（`copyDiagnostics` 的数组收尾未匹配，改动中止）。接线后让用户在手机上跑一段，就能判断该做哪一项：

| 若数字显示 | 则做 |
|---|---|
| `detail.paint` p95 高（>30ms） | 详情改成"仅追加新消息"的增量渲染（不重跑 `buildEntries` + 全量 diff） |
| `list.paint` p95 高 | 列表虚拟化 / 降低 `task.updated` 触发频率 |
| 两者都低但体感慢 | 优化中继往返：调 `scheduleDetailAppend` 去抖、合并请求 |

### 3.2 已知未修（审计提出，评估后记录）

| 项 | 影响 | 建议 |
|---|---|---|
| `cloud.mjs` 按 24 帧而非字节 flush | 40ms 窗口内超 4MiB 会静默丢帧（回放洪峰才触发） | 按字节累积（>512KiB 即 flush） |
| 游标白名单比 provider id 域窄 | id 含 `=`/`+`/中文时 `400 bad_cursor` | 只校验长度+去控制字符 |
| 会话满 20 条的淘汰顺序 | `remember=false` 分支可能淘汰刚签发的令牌（当前外壳不走该分支） | 先淘汰再插入 |
| 「任务完成时提醒」开关 | 只申请权限，未真正发通知 | 实现或移除开关 |
| 「今日」统计 | 未排除子代理会话 | 加 `isVisible` 过滤 |
| 列表搜索 | 只覆盖最近 300 条 | 服务端加 `q` 参数 |

### 3.3 测试覆盖的真实缺口

- **手机端交互无法自动化**：点击、滚动、息屏恢复、Service Worker 更新，都只能靠真机反馈。
- 浏览器端验证需要登录口令，无法在 CI 里跑；已验证的方式是本地静态服务 + 真实二维码参数。
- 也就是说：**"631+ 条绿"不等于"手机上一遍过"**。每次改动建议附一句"手机上应看到什么"，让用户据此回报。

---


## 4. 常用操作

```powershell
# 桌面端版本与实例标识
Invoke-RestMethod http://127.0.0.1:47901/api/v1/health | % { $_.data.version, $_.data.bootId }

# 中继状态
Invoke-RestMethod http://127.0.0.1:47901/api/v1/cloud/status | % { $_.data.state, $_.data.stats }

# 热重载（改 lib/ 之后）：plugin_manager set_bundle，先 false 再 true
# 手机端外科刷新：关掉页面重开（Service Worker 有新构建时可能需要两次）

# 身份指纹（判断"要不要重扫码"）
node -e "const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),c=require('node:crypto');const id=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.dsh','pocket','cloud.json'),'utf8'));console.log(c.createHash('sha256').update(id.room+'|'+id.key).digest('hex').slice(0,16))"
```

