/**
 * 一次 RPC 的**重试预算**与**等待文案**——两件必须用同一份数字算的事。
 *
 * 为什么单独抽出来：这一版的事故是"两个各自合理的预算叠成了用户受不了的时长"。
 *
 *   1. 外壳（`remote/remote.js` 的 `request()`）按 request id 重发。它的总预算
 *      **不是** `timeout × attempts`——每次 attempt 都会 `clearTimeout` 上一个
 *      计时器（`entry.timer` 是单个的），只有**最后一次**才拿满 `timeout`：
 *
 *          总预算 = Σ backoff[0..attempts-2] + timeout
 *                 = 1200 + 2400 + 3600 + 8000 = 15 200 ms
 *
 *      （旧值 1200+2400+4800+16000 = 24 400 ms，且被心跳重发/stale catch 拖到
 *      更长，见 `test/domain/shell-rpc-budget.test.mjs`。）
 *   2. 应用侧 `api(..., { timeout })` 是**另一个**计时器。它一旦短于外壳预算，
 *      先到点的永远是应用侧：用户拿到笼统的「请求超时」，外壳那套"同 id 幂等
 *      重放"还没跑完就被取消，然后应用层的重试再从头来一遍 —— 界面上的
 *      「加载中…」一停就是几十秒，这正是"偶尔点进会话半天没有内容"。
 *
 * 所以两个数由**同一份数据**推导，并被用例钉住关系：
 * `rpcWorstCaseMs() + DECOMPRESS_TIMEOUT_MS < DETAIL_TIMEOUT_MS`
 * （见 `test/unit/rpc-budget.test.mjs` / `test/domain/shell-rpc-budget`）。
 *
 * 注意：`remote/remote.js` 里那几个常量仍是**数字字面量**（`relay-restart`
 * 的门禁按 `const RPC_TIMEOUT_MS = <数字>;` 解析源码），两边必须一致 ——
 * 上面那个用例会逐字段比对，改一边而忘了另一边就红。
 */

/** 同一个 request id 最多发几次（首发 + 3 次重发）。 */
export const RPC_ATTEMPTS = 4;

/**
 * **最后一次** attempt 的预算。
 *
 * 电脑端实测 4~14 ms 回包（`详情响应 原始 108 KB → 发送 45 KB（gzip），14 ms`），
 * 8 s 是它的 500 倍以上，足够覆盖一次大响应 + 手机端解压；而旧值 16 s 只是把
 * "确实丢了"这条路的空等拉长一倍。
 */
export const RPC_TIMEOUT_MS = 8_000;

/**
 * 第 1/2/3 次重发前各等多久。
 *
 * 前两次要快：首个请求常常正好撞上电脑端热重载或一次网络抖动，1.2 s 重发一次
 * 就能吃掉。第三次放长一点，避免和下行心跳（8 s 一跳）挤在同一时刻。
 */
export const RPC_BACKOFF_MS = [1_200, 2_400, 3_600];

/**
 * 一条 gzip 大响应的解压上限。
 *
 * 与 `remote/remote.js` 的 `DECOMPRESS_TIMEOUT_MS` 是同一个数（外壳里必须是数字字面量，
 * 所以两边各写一份，由 `test/domain/shell-rpc-budget` 逐字段比对）。它之所以要出现在
 * 这个模块里：应用侧的超时**必须把它算进去**，否则"解压超时"这个原因永远到不了界面
 * （见 `DETAIL_TIMEOUT_MS`）。
 */
export const DECOMPRESS_TIMEOUT_MS = 10_000;

/**
 * 应用侧详情（含翻页）的**总**超时。
 *
 * 必须**明显大于** `rpcWorstCaseMs() + DECOMPRESS_TIMEOUT_MS`：
 *   - 外壳按同 id 重放的最坏耗时是 15 200 ms（跑完才轮到自己判死，带 `pocketCode`）；
 *   - 外壳判死/回包之后还有一步解压，最坏 10 000 ms，那一步的 `pocketCode` 是
 *     `decompress`（界面据此给"回包到了但解不开"的话术）。
 *
 * 旧值 20 000 ms 比 15 200 + 10 000 = 25 200 ms 还小：先到点的永远是应用侧的笼统
 * 「请求超时」，外壳辛苦归类的 `decompress` 原因**永远显示不出来**，手机还白跑
 * ≤10 s 的解压。26 000 ms - 25 200 ms = 800 ms 留给收尾（读 body / 取消流）。
 */
export const DETAIL_TIMEOUT_MS = 26_000;

/** 详情加载超过这么久还没内容，就把"到底在干什么"写到界面上（而不是静止转圈）。 */
export const STALL_HINT_AFTER_MS = 3_000;

/**
 * 一条请求的最坏耗时（毫秒）。
 *
 * 语义就按外壳的调度来：前 `attempts-1` 次各等一个 backoff，最后一次等满 `timeout`。
 * 传参是为了让用例能验算别的组合，生产侧不要传。
 *
 * @param {{attempts?: number, timeoutMs?: number, backoffMs?: number[]}} [plan]
 * @returns {number}
 */
export function rpcWorstCaseMs(plan = {}) {
  const attempts = Math.max(1, Math.trunc(Number(plan.attempts ?? RPC_ATTEMPTS)) || RPC_ATTEMPTS);
  const timeoutMs = Math.max(1, Math.trunc(Number(plan.timeoutMs ?? RPC_TIMEOUT_MS)) || RPC_TIMEOUT_MS);
  const backoff = Array.isArray(plan.backoffMs) ? plan.backoffMs : RPC_BACKOFF_MS;
  let total = timeoutMs;
  for (let index = 0; index < attempts - 1; index += 1) {
    const value = Number(backoff[index]);
    // 缺项时外壳会 fallback 成 2 s，这里跟着算，免得预算被低估。
    total += Number.isFinite(value) && value >= 0 ? value : 2_000;
  }
  return total;
}

/** 秒数向下取整，但至少 1 秒（"已等待 0 秒"读起来像没在等）。 */
function secondsText(elapsedMs) {
  const ms = Number(elapsedMs);
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.floor(ms / 1_000));
}

/**
 * 详情加载中的进度文案。
 *
 * 为什么要有：用户报的是"点进去半天没内容"，而旧界面只有一句静止的「加载中…」——
 * 分不清是卡死、在重试、还是电脑端没响应。超过 3 秒就把"等了多久、第几次重试"
 * 写出来，至少让人知道它还在动。
 *
 * @param {{elapsedMs?: number, tries?: number}} [state]
 *   `tries` 是这条请求**已经发出的次数**（1 = 首发还在路上），由外壳的面包屑给出。
 * @returns {string} 空串表示"还不够久，别打扰"
 */
export function waitText({ elapsedMs = 0, tries = 0 } = {}) {
  const ms = Number(elapsedMs);
  if (!Number.isFinite(ms) || ms < STALL_HINT_AFTER_MS) return '';
  const seconds = secondsText(ms);
  const sent = Math.max(0, Math.trunc(Number(tries)) || 0);
  const retries = Math.max(0, sent - 1);
  if (retries < 1) return `已等待 ${seconds} 秒 · 还在等电脑端回包`;
  return `已等待 ${seconds} 秒 · 正在重试第 ${retries} 次`;
}

/**
 * 详情加载占位行**到底显示哪一句**。
 *
 * 抽成纯函数是因为它以前是 `case 'loading': return { update: () => {} }`——
 * 一个"永不更新"的空实现，界面上永远只有静止的「加载中…」。这种"逻辑只活在
 * DOM 回调里"的地方，Node 里测不到，改坏了也没人发现。
 *
 * @param {{text?: string, wait?: string}} [message]
 * @returns {string} 非空：`wait`（进度文案）优先，否则退回 `text`，再否则「加载中…」
 */
export function loadingText(message) {
  const wait = String(message?.wait ?? '').trim();
  if (wait.length > 0) return wait;
  const text = String(message?.text ?? '').trim();
  return text.length > 0 ? text : '加载中…';
}

/**
 * 详情读取失败的**可操作**文案：告诉用户下一步做什么，而不是只报一个错。
 *
 * F3：`relay_timeout` 有两种完全不同的现场，文案必须分开说 —— 否则用户看到
 * 「中继请求超时」只会去查自己的网络，而两种现场里**都不该**由用户先动手：
 *
 *   - `rebuilt === true`：请求还挂着的时候，外壳已按 F1 判定"有请求在途但下行静默"
 *     并重建过链路；这条失败是**在已经换过的新链路语境下**发生的。要写明"刚重建过 /
 *     已经自动补过一次重试"，否则用户会以为一切都没发生过。
 *   - 否则：链路没换过，就是**电脑端没响应**（或回包丢了），这时才该说"电脑端"。
 *
 * 出口（重试 / 返回列表）必须在文案里写出来：按钮已经有了，但一句话不说清
 * "还能做什么"，用户手机上只会看到一条死路。
 *
 * @param {{message?: string, code?: string, rebuilt?: boolean, retried?: boolean}} [failure]
 *   `code` 来自 `web/lib/net.js`（外壳标了 `pocketCode` 的会原样透上来）；
 *   `rebuilt` = 这次失败之后中继链路确实被重建过（`error.linkRebuilt`，见 F2）；
 *   `retried` = 已经为它自动补过一次重试（`error.autoRetried`）。
 */
export function detailFailureText({ message = '', code = '', rebuilt = false, retried = false } = {}) {
  const reason = String(message ?? '').trim();
  const picked = reason.length > 0 ? reason : '读取会话失败';
  // 「取消」是用户自己走的，不该再劝他重试一遍。
  if (code === 'aborted') return '已取消读取这个会话。';
  if (code === 'relay_timeout') {
    if (rebuilt === true) {
      const auto = retried === true ? '已自动重试 1 次' : '正在自动重试';
      return `链路刚重建过，${auto}，回包仍没送到手机。可以点「重试」，或返回列表后再进来。`;
    }
    return `电脑端没有响应（${picked}）。可以点「重试」，或返回列表后再进来。`;
  }
  return `${picked}。可以点「重试」，或返回列表后再进来。`;
}
