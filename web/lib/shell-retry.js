/**
 * 连接层的重试策略（纯逻辑，Node 可直接 import，不碰 DOM / mqtt）。
 *
 * 为什么单独抽出来：这一版要修的两个病根都是"一次失败就再也不回来"——
 *
 *   1. 首次建联失败（`main()` 里的 `await relay.connect()` 抛错）当时直接
 *      `showFatal` + `return`，那页面上唯一的按钮是 `location.reload()`，
 *      而刷新回到的仍是同一张死页。用户看到的就是"打开就白屏，刷新也没用"。
 *   2. 控制帧（auth / login）只 `send()` 一次，8 秒没应答就 `{unavailable}`，
 *      整屏钉死在「未能确认登录状态」。桌面热重载或弱网丢一帧就把整机锁死。
 *
 * 两处都需要"退避 + 上限 + 可观察"的重试，而它们原来的写法都是散在 `remote.js`
 * 的浏览器代码里，只能靠对源码做正则断言。抽到这里之后 `test/unit` 能真的跑
 * 行为：失败几次、间隔多久、上限多少、回调看到什么。
 *
 * 写法与 `web/lib/shell-fresh.js` 一致：纯函数 / 纯类，副作用（定时器、发送）
 * 全部由调用方注入。
 */

/**
 * 首次建联失败后的退避序列：1 s / 2 s / 4 s / 8 s。
 *
 * 4 条延迟 = 4 次重试，加上最开始那次一共 5 次尝试。取这个长度的理由：
 * 公共 broker 握手实测 1~3 s，一次网络切换/运营商 DQ 一般 5~15 s 内恢复，
 * 1+2+4+8 = 15 s 的重试窗口正好覆盖；再长就该让用户看到"连不上"并自己决定。
 */
export const CONNECT_RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000];

/**
 * 控制帧（`auth` / `login`）在整体预算内的重发间隔。
 *
 * 两条 = 首次之外再发 2 次，共 3 次。总耗时 1.5 + 3.5 = 5 s，小于 8 s 的
 * `checkAuth` 预算，所以"重发完还没应答"才落到 unavailable。
 *
 * **必须是逐字节相同的重发**：桌面 `lib/cloud.mjs` 的 `handleControl()` 用
 * `sha256(JSON.stringify(message))` 当去重键，帧里一旦多一个 seq/ts（哪怕只是
 * 换了个时间戳）就会被当成**一次新的登录**——重复跑 scrypt、还可能提前撞上
 * 登录限流。所以这里只给间隔，不给"换 id / 加字段"的余地。
 */
export const CONTROL_RESEND_DELAYS = [1_500, 3_500];

/**
 * 桌面心跳的**老假设**：8 s 一跳。
 *
 * 1.1.0 起桌面会按活跃度自适应（空闲 30 s / 有实时通道或在途请求 8 s），并把
 * 当前生效周期通过 hello / beat 的增量字段 `beatMs` 下发。收到 `beatMs` 时用
 * `deriveThresholds()` 重算下面三个阈值；**收不到**（老桌面）就继续按这个
 * 8 s 假设走 —— 行为与 1.0.10 逐字等价，这是向下兼容的那一半。
 */
export const HEARTBEAT_MS = 8_000;

/**
 * 回到前台时判「这条链路其实已经死了」的门槛：两个心跳周期没有任何下行。
 *
 * 一个周期丢一条是正常的（弱网丢帧），两个周期都没有就说明隧道已经半死。
 * 用 2× 而不是等 `PC_STALE_MS`（26 s）：iOS 上页面冻结期间收不到帧是常态，
 * 醒来后用户最多愿意等一两秒，等 26 s + 15 s 冷却的体感就是"回到前台后
 * 最长 40 秒页面不动"。
 *
 * 这是**下限**：桌面空闲档把心跳拉长到 30 s 时按 2× 放大到 60 s（见
 * `deriveThresholds()`）—— 否则"下一次心跳还没到"就会被当成死链。
 */
export const WAKE_SILENT_MS = 2 * HEARTBEAT_MS;

/**
 * 「**有请求在途** + 下行静默」⇒ 立刻重建链路的阈值（外壳看门狗每 2 s 一拍）。
 *
 * 为什么必须有这条（这一版事故的直接原因，别删）：
 *   - 单条请求的**绝对**预算是 `rpcBudgetMs(4, 8_000)` = 15 200 ms（见 `./rpc-budget.js`），
 *     到点就抛 `relay_timeout`，而 `web/lib/net.js` 把它当"外壳已给结论"的不可重试失败；
 *   - 而原来的看门狗只认 `PC_STALE_MS`（26 s）——**15.2 s < 26 s**，于是每一次
 *     "上行通、下行半死"都必然是请求先烧完预算报「中继请求超时」，本该救它的链路
 *     重建要再等 10.8 s 才发生（之后还有 15 s 冷却）。现场就是这样：桌面 8~30 ms
 *     就答完了、`nackRepairs=0`，手机却报超时，用户只能手点重试。
 *
 * 取"约一个心跳周期"的理由：桌面每 8 s 一条 beat，所以「10 s 没有任何下行帧」在
 * 半死链路上是明确信号；而**正常但慢**的请求（冷会话构建实测可达 4.4 s）期间 beat
 * 照旧每 8 s 到达、`lastRxAt` 一直新鲜，这条规则**永远不会命中** —— 这是它不误伤
 * 慢请求的前提，写在这里免得下一个人把阈值调小。
 *
 * 它必须**小于** `rpcWorstCaseMs()`：否则重建永远晚于请求判死，等于没修
 * （关系由 `test/unit/shell-stall-rebuild.test.mjs` 钉住）。
 *
 * 外壳里同值的那份是一个数字字面量（`remote/remote.js` 的 `RPC_STALL_REBUILD_MS`）：
 * 看门狗的行为用例按名字把常量切进 vm 沙箱里跑，两边同值由用例逐字段比对。
 */
export const RPC_STALL_REBUILD_MS = 10_000;

/**
 * 「电脑端已离线」横幅 + 重建的静默阈值（老假设下的值）。
 *
 * `remote/remote.js` 里同值的那份是数字字面量（行为用例把常量切进 vm 沙箱跑），
 * 两边同值由 `test/unit/shell-stall-rebuild.test.mjs` 逐字段比对。
 */
export const PC_STALE_MS = 26_000;

/**
 * 从桌面下发的 `beatMs` 推导本机的静默阈值（本轮新增）。
 *
 * 公式只有三条，写成代码而不是散在三个地方，是因为**红线**在这里：
 *
 *     RPC_STALL_REBUILD_MS 必须**长于一个心跳**，否则正常链路的下一次 beat
 *     就会被当成「下行静默」⇒ 拆掉 ws 隧道、作废正在拼的分片（误重建）。
 *
 * 桌面把心跳拉长到 30 s 之后，若手机还用「8 s 假设」的 10 s，这条红线立刻被
 * 踩穿。所以三个阈值都必须**跟着 beatMs 放大**，并且永远不低于今天的值：
 *
 *   wakeSilentMs       = max(16_000, 2 × beatMs)      // 回到前台判静默
 *   pcStaleMs          = max(26_000, 3.25 × beatMs)   // 离线横幅 + 重建
 *   rpcStallRebuildMs  = max(10_000, 1.25 × beatMs)   // 有请求在途 + 下行静默
 *
 * 系数取 2 / 3.25 / 1.25 不是新拍的数字：它们正是老常量对 8 s 的倍数
 * （16_000 = 2×、26_000 = 3.25×、10_000 = 1.25×），所以 `beatMs = 8_000` 时
 * 推导结果与 1.0.10 **逐值相等**，老桌面/新桌面在同一档位下行为一致。
 *
 * 保守优先的三条规矩（别改成"聪明的"）：
 *  1. `beatMs` 缺失 / 非数字 / ≤0 ⇒ 当"不知道"，退回 8 s 假设（今天的行为）；
 *  2. `beatMs` 比 8 s 还小（更激进的桌面）⇒ 按 8 s 算，**不许**把阈值调小；
 *  3. 只增不减：推导值一律 `max(老常量, 公式值)`。
 *
 * @param {number|string|undefined} beatMs 桌面下发的当前心跳周期（毫秒）
 * @returns {{beatMs: number, known: boolean, wakeSilentMs: number,
 *   pcStaleMs: number, rpcStallRebuildMs: number}}
 *   `known` 表示这次是否真的用上了桌面下发的值（false = 老桌面 / 脏值，退回老假设）。
 */
export function deriveThresholds(beatMs) {
  const raw = Number(beatMs);
  const known = Number.isFinite(raw) && raw > 0;
  // 第 2 条：比老假设还小时按老假设算 —— 阈值只能放大，不能比今天更激进。
  const beat = known ? Math.max(HEARTBEAT_MS, Math.round(raw)) : HEARTBEAT_MS;
  return {
    beatMs: beat,
    known,
    wakeSilentMs: Math.max(WAKE_SILENT_MS, 2 * beat),
    pcStaleMs: Math.max(PC_STALE_MS, Math.ceil(3.25 * beat)),
    rpcStallRebuildMs: Math.max(RPC_STALL_REBUILD_MS, Math.ceil(1.25 * beat)),
  };
}

/** 第 `attempt` 次失败后该等多久（attempt 从 1 开始）；没有下一次就返回 null。 */
export function connectRetryDelay(attempt) {
  const index = Number(attempt);
  if (!Number.isInteger(index) || index < 1) return null;
  return CONNECT_RETRY_DELAYS[index - 1] ?? null;
}

/** 默认 sleep：只在这里出现定时器，测试里可以整个换掉。 */
function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 「做强这件事，失败就退避重试，超过上限才认输」。
 *
 * @param {{
 *   connect: (attempt: number) => Promise<unknown>,
 *   delays?: number[],
 *   sleep?: (ms: number) => Promise<unknown>,
 *   onRetry?: (info: {attempt: number, delay: number|null, error: unknown}) => void,
 * }} options
 *   `onRetry` 对**每一次**失败都会被调用，最后一次（没有下一次了）的
 *   `delay === null` —— 界面靠它拿到"最终为什么失败"，而不是在循环外面再猜一遍。
 * @returns {Promise<{ok: boolean, attempts: number, lastError: unknown}>}
 */
export async function connectWithRetry({ connect, delays = CONNECT_RETRY_DELAYS, sleep = defaultSleep, onRetry } = {}) {
  if (typeof connect !== 'function') throw new TypeError('connect 必须是函数');
  const plan = Array.isArray(delays) ? delays : [];
  const total = plan.length + 1;
  let lastError;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      await connect(attempt);
      return { ok: true, attempts: attempt, lastError: undefined };
    } catch (error) {
      lastError = error;
      const delay = attempt < total ? plan[attempt - 1] : null;
      try {
        onRetry?.({ attempt, delay, error });
      } catch { /* 界面回调不该打断重试 */ }
      if (delay === null) return { ok: false, attempts: attempt, lastError };
      await sleep(delay);
    }
  }
  return { ok: false, attempts: total, lastError };
}

/**
 * 回到前台该做什么。**必须在重置 `lastWakeAt` 之前算**（顺序反了就会拿
 * "刚刚"当最后一次下行，永远判不出静默）。
 *
 * @param {{ready?: boolean, now: number, lastRxAt?: number, pcSeenAt?: number,
 *   readyAt?: number, restarting?: boolean, beatMs?: number}} input
 *   `beatMs` 是**桌面下发的心跳周期**（`remote/remote.js` 的 `pcBeatMs`）；
 *   不给（老桌面 / 老调用点）就是 1.0.10 的 16 s 老假设，行为不变。
 * @returns {'restart-silent'|'restart-down'|'none'}
 *   - `restart-silent`：连接自称在线，但已经两个心跳周期没有下行 → 立刻重建，
 *     **不受** `justRestarted` 的 20 秒窗口限制（那正是"回到前台后不动"的来源）。
 *     桌面空闲档 30 s 时门槛会放大到 60 s —— 保守方向：宁可晚一点重建，也
 *     不能把"下一次心跳还没到"当成静默。
 *   - `restart-down`：本来就没连上 → 交给调用方按原有窗口决定。
 *   - `none`：不用动（正在重建 / 链路新鲜）。
 */
export function wakeDecision({
  ready = false, now, lastRxAt = 0, pcSeenAt = 0, readyAt = 0, restarting = false, beatMs,
} = {}) {
  if (restarting === true) return 'none';
  if (ready !== true) return 'restart-down';
  const stamp = Math.max(Number(lastRxAt) || 0, Number(pcSeenAt) || 0, Number(readyAt) || 0);
  const since = Number(now) - stamp;
  if (!Number.isFinite(since)) return 'none';
  return since >= deriveThresholds(beatMs).wakeSilentMs ? 'restart-silent' : 'none';
}
