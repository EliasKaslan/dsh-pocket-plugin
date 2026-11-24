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

/** 电脑端心跳周期（桌面 `beat` 每 8 s 一条）。 */
export const HEARTBEAT_MS = 8_000;

/**
 * 回到前台时判「这条链路其实已经死了」的门槛：两个心跳周期没有任何下行。
 *
 * 一个周期丢一条是正常的（弱网丢帧），两个周期都没有就说明隧道已经半死。
 * 用 2× 而不是等 `PC_STALE_MS`（26 s）：iOS 上页面冻结期间收不到帧是常态，
 * 醒来后用户最多愿意等一两秒，等 26 s + 15 s 冷却的体感就是"回到前台后
 * 最长 40 秒页面不动"。
 */
export const WAKE_SILENT_MS = 2 * HEARTBEAT_MS;

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
 *   readyAt?: number, restarting?: boolean}} input
 * @returns {'restart-silent'|'restart-down'|'none'}
 *   - `restart-silent`：连接自称在线，但已经两个心跳周期没有下行 → 立刻重建，
 *     **不受** `justRestarted` 的 20 秒窗口限制（那正是"回到前台后不动"的来源）。
 *   - `restart-down`：本来就没连上 → 交给调用方按原有窗口决定。
 *   - `none`：不用动（正在重建 / 链路新鲜）。
 */
export function wakeDecision({ ready = false, now, lastRxAt = 0, pcSeenAt = 0, readyAt = 0, restarting = false } = {}) {
  if (restarting === true) return 'none';
  if (ready !== true) return 'restart-down';
  const stamp = Math.max(Number(lastRxAt) || 0, Number(pcSeenAt) || 0, Number(readyAt) || 0);
  const since = Number(now) - stamp;
  if (!Number.isFinite(since)) return 'none';
  return since >= WAKE_SILENT_MS ? 'restart-silent' : 'none';
}
