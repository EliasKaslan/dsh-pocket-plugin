/**
 * Transport layer: the JSON API and the realtime channel (WebSocket first,
 * Server-Sent Events as a fallback).
 *
 * Both transports take one base — the relay shell origin. That is the only way
 * in: the shell reaches the host through the encrypted tunnel that
 * `remote/remote.js` installs, so `baseUrl` is the only thing that varies.
 */

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 一次 RPC 的最坏耗时 / 详情超时都来自同一份数据，见 `./rpc-budget.js` 的长注释。 */
import { DETAIL_TIMEOUT_MS } from './rpc-budget.js';

/** Normalise the shell origin: add a scheme when missing, drop a trailing slash. */
export function normalizeBase(input) {
  let text = String(input ?? '').trim();
  if (text.length === 0) return '';
  if (!/^https?:\/\//iu.test(text)) text = `http://${text}`;
  return text.replace(/\/+$/u, '');
}

/**
 * 默认超时：外壳（`remote/remote.js`）那条链的**总预算之上**留足余量。
 *
 * 见 `./rpc-budget.js`：外壳同 id 重放的最坏耗时是 `Σ backoff + 最后一次 timeout`
 * （15.2 s），应用侧必须比它长，否则先到点的总是这里 —— 用户拿到的是笼统的
 * 「请求超时」，外壳那套幂等重放还没跑完就被取消。
 */
const DEFAULT_TIMEOUT = DETAIL_TIMEOUT_MS;

/**
 * 有界重试：首次之外最多再试 2 次，间隔 400 ms / 800 ms。
 *
 * 为什么需要它：中继层的 `relay.request()` 只在**同一次调用内**按 request id 重发
 * （1.2/2.4/4.8 s + 16 s 预算）。一旦它把错误抛到这里，在途请求就已经被判定失败了；
 * 而用户的真实体感是"网络抖一下，点进会话就白屏报连不上"。补一层短退避重试能把
 * 抖动吃掉，又不至于让用户对着转圈等 60 秒。
 *
 * **前提（重要，别删）**：重试会重新走一次 `fetch()` → 中继外壳会给它**新的**
 * request id，于是桌面端看到的是一条全新的请求。所以：
 *   - GET / HEAD 天然可重复执行（多读一遍没有副作用），默认重试；
 *   - 写方法（POST/PUT/PATCH/DELETE）默认**不重试** —— 那不是"同 id 幂等"，
 *     重发只会把副作用做第二遍（例如把同一条 prompt 发进会话两次）；
 *   - 只有两种情况写方法也安全：调用方显式声明 `idempotent: true`，或者错误本身
 *     证明请求**根本没发出去**（`beforeSend`，外壳在"中继尚未就绪"时打的标）。
 *     后者最典型：中继还没连上就点了发送。
 */
const RETRY_ATTEMPTS = 2;
const RETRY_BASE_MS = 400;

/** 默认 sleep：只在这里出现定时器，测试可以整个换掉。 */
function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 哪些错误码允许"换一个新的 request id 再试一次"。
 *
 * - `network` / `read`：真正的传输层失败（链路抖动），换新 id 无害。
 * - `parts_lost`：外壳明确说"这一份响应的分片再也凑不齐了"（下行丢片）。
 *   换一个新 id 会让服务端**重新切一份响应**，比原样重放更可能成功 ——
 *   所以这里**可重试**，但只限 GET/HEAD/OPTIONS 与写明幂等的写方法（见下）。
 *
 * 其余码（`relay_timeout` / `decompress` / `relay`）一律不重试：外壳已经按
 * **同一个 request id** 跑完了一整个重放预算，再来一轮只是把用户等待翻倍。
 *
 * **唯一的例外是 `relay_timeout` + 链路确实被重建过**（见 `canRetry`）：那条请求
 * 的预算是**烧在一条已经半死的链路上**的，重建发生之后重发一次是合理的 ——
 * 这条例外只给 GET/HEAD，且只给一次。
 */
const RETRYABLE_CODES = new Set(['network', 'read', 'parts_lost']);

/**
 * 读外壳的「链路世代号」（`remote/remote.js` 的 `relay.linkEpoch`，每次重建 +1）。
 *
 * 为什么需要它：没有这个信号，`relay_timeout` 只剩一个笼统的"别重试"——
 * 而用户现场恰恰是"请求判死的那一刻，看门狗已经把它脚下那条半死链路换掉了"。
 * 局域网布局里没有外壳（`__POCKET_DIAG__` 不存在）⇒ 恒 0，行为与以前完全一致。
 */
function defaultLinkEpoch() {
  try {
    const read = globalThis.__POCKET_DIAG__?.linkEpoch;
    if (typeof read !== 'function') return 0;
    const value = Number(read());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0; // 诊断接口永远不该拖垮请求本身
  }
}

/**
 * 这条请求在失败之后还能不能再试一次。
 *
 * @param {{method?: string, options?: object, error?: object, attempt: number,
 *   attempts: number, signal?: AbortSignal, allowRelayTimeout?: boolean}} input
 *   `allowRelayTimeout`：本次失败之后链路确实被重建过（且这条 `relay_timeout`
 *   还没补过重试）—— 只有它为真时，GET/HEAD 的 `relay_timeout` 才允许再试一次。
 */
function canRetry({ method, options, error, attempt, attempts, signal, allowRelayTimeout = false }) {
  if (attempt >= attempts) return false;
  if (signal?.aborted === true) return false;
  if (options?.signal?.aborted === true) return false;
  const verb = String(method ?? 'GET').toUpperCase();
  const readOnly = verb === 'GET' || verb === 'HEAD';
  /*
   * F2：`relay_timeout` 的「外壳已跑完同 id 重放预算」结论**有一个例外**。
   *
   * 现场：手机下行半死 → 外壳在 10 s 判"请求在途但下行静默"并重建链路 →
   * 那条请求的**绝对**截止时刻仍是 15.2 s，于是一条已经换了新链路、桌面 8~30 ms
   * 就能答的请求，还是把 `relay_timeout` 交到用户手里（还必须手点重试）。
   *
   * 为什么只给 GET/HEAD、且只给一次：
   *   - 写方法换个新 request id 再发，是**语义不同**的一条请求（不是同 id 幂等重放），
   *     可能把同一条 prompt/确认做第二遍 —— 维持不重试；
   *   - 读方法天然可重复执行，桌面也按 request id 幂等回放，多读一遍没有任何副作用；
   *   - 上限 1 次由调用方（`relayTimeoutRetried`）记账：重建过一次就只补一次，
   *     第二次还是 `relay_timeout` 说明链路仍没救回来，再等下去用户只会更难受。
   */
  if (error?.code === 'relay_timeout') {
    if (!readOnly) return false;
    return allowRelayTimeout === true;
  }
  // 外壳已经给过**定论**的失败（同一个 id 的幂等重放跑完了）不许再来一轮。
  // （`parts_lost` 不算定论：那不是"回声慢"，是"这一份字节凑不齐了"。）
  if (error?.relayConfirmed === true) return false;
  if (!RETRYABLE_CODES.has(error?.code)) return false;
  if (readOnly || verb === 'OPTIONS') return true;
  if (options?.idempotent === true) return true;
  return error?.beforeSend === true;
}

/**
 * 把外壳的错误翻成一句人能看懂的话。
 *
 * 为什么不让它继续落进「连不上电脑」：链路明明是通的（横幅显示在线、桌面 4~14 ms
 * 就回了），用户被那句错话带去看路由器，真正的原因（回包没送到手机 / 回包解不开）
 * 反而消失了。
 */
function relayFailureMessage(error) {
  const raw = String(error?.message ?? '').trim();
  switch (error?.pocketCode) {
    case 'relay_timeout':
      return raw.length > 0
        ? `${raw}（电脑端已按同一请求重放，回包没送到手机）`
        : '电脑端已按同一请求重放，回包没送到手机';
    case 'decompress':
      return raw.length > 0 ? raw : '回包到了但解不开（大响应解压失败）';
    case 'parts_lost':
      return raw.length > 0 ? raw : '大响应的分片没到齐（下行丢了片）';
    default:
      return raw.length > 0 ? raw : '中继没能完成这次请求';
  }
}

/**
 * @param {string} path
 * @param {{method?: string, body?: unknown, base?: string, auth?: boolean, timeout?: number,
 *   signal?: AbortSignal, idempotent?: boolean}} options
 *   `idempotent: true` 表示这个写请求重复执行是安全的（调用方自己保证语义）。
 * @param {{attempts?: number, baseMs?: number, sleep?: (ms: number) => Promise<unknown>}} [retry]
 */
export function createApi({ getBase, getToken, onUnauthorized }, retry = {}) {
  const attempts = Math.max(1, Number(retry.attempts ?? RETRY_ATTEMPTS) || RETRY_ATTEMPTS);
  const baseMs = Math.max(0, Number(retry.baseMs ?? RETRY_BASE_MS) || 0);
  const sleep = typeof retry.sleep === 'function' ? retry.sleep : defaultSleep;
  const linkEpoch = typeof retry.linkEpoch === 'function' ? retry.linkEpoch : defaultLinkEpoch;

  return async function api(path, options = {}) {
    const base = normalizeBase(options.base ?? getBase());
    const method = options.method ?? 'GET';
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;

    const headers = { accept: 'application/json' };
    const requestToken = options.auth === false ? null : getToken();
    if (requestToken) headers.authorization = `Bearer ${requestToken}`;
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let lastError;
    /**
     * 发这条请求时的链路世代号（每次中继重建 +1）。
     *
     * 失败时再读一次：变了 = 这条请求是在**一条后来被判定半死、已经重建过**的链路上
     * 烧完预算的 ⇒ GET/HEAD 的 `relay_timeout` 允许补一次自动重试（见 `canRetry`）。
     */
    const epochAtSend = linkEpoch();
    /** `relay_timeout` 只补一次：第二次还超时说明链路仍没救回来，继续等只会更糟。 */
    let relayTimeoutRetried = false;
    // 已经取消的请求连发都不发：既省一次握手，也避免"取消之后又冒出一次重试"。
    if (options.signal?.aborted === true) throw new ApiError('已取消', { code: 'aborted' });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(baseMs * 2 ** (attempt - 1));
        // 退避期间用户取消了：必须立刻收手，不能"睡醒再发一次"。
        if (options.signal?.aborted === true) throw new ApiError('已取消', { code: 'aborted' });
      }
      try {
        return await attemptOnce({ base, path, method, headers, body, timeout, options, requestToken });
      } catch (error) {
        lastError = error;
        const rebuiltSinceSend = linkEpoch() !== epochAtSend;
        // 把"这次失败之后链路换过没有 / 有没有自动补过一次"带给界面：
        // F3 的失败文案要区分「链路刚重建过」与「电脑端没响应」，不能只说"失败了"。
        error.linkRebuilt = rebuiltSinceSend;
        error.autoRetried = relayTimeoutRetried;
        const allowRelayTimeout = rebuiltSinceSend && !relayTimeoutRetried;
        if (!canRetry({ method, options, error, attempt, attempts, signal: options.signal, allowRelayTimeout })) throw error;
        if (error?.code === 'relay_timeout') relayTimeoutRetried = true;
        console.debug(`[pocket-diag] api retry ${method} ${path} attempt=${attempt + 2} code=${error?.code}`);
      }
    }
    throw lastError;
  };

  /** 一次完整尝试：自己的超时计时器 + 外部 signal 透传（两者的语义必须分开）。 */
  async function attemptOnce({ base, path, method, headers, body, timeout, options, requestToken }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort();
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }

    let response;
    try {
      response = await fetch(base + path, { method, headers, body, cache: 'no-store', signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', abort);
      if (options.signal?.aborted === true) throw new ApiError('已取消', { code: 'aborted' });
      if (error?.name === 'AbortError') throw new ApiError('请求超时，电脑端可能正忙', { code: 'timeout' });
      // 外壳自己给的结论（`pocketCode`）：它已经按**同一个 request id** 重放过
      // 一整个预算了。这类失败不能再说成「连不上电脑」，更不能换个新 id 再重试
      // 一遍 —— 那等于把用户的等待翻倍，而刚刚证明的恰恰是"重放没用"。
      // 典型：`relay_timeout`（回包没送到手机）、`decompress`（回包到了但解不开）。
      if (typeof error?.pocketCode === 'string' && error.pocketCode !== '') {
        const confirmed = new ApiError(relayFailureMessage(error), { code: error.pocketCode });
        // 显式标记"这是外壳跑完自己的重放预算后给出的结论"，`canRetry` 认这个标。
        // **`parts_lost` 例外**：那不是"回声慢"，而是"这一份响应的字节凑不齐了"，
        // 换一个新 id 会重新切一份响应 —— 该重试。
        if (error.pocketCode !== 'parts_lost') confirmed.relayConfirmed = true;
        throw confirmed;
      }
      const failure = new ApiError('连不上电脑，请检查网络与插件状态', { code: 'network' });
      // 外壳在"这条请求一次都没发出去"时打的标记：中继未就绪 / 客户端换代。
      // 保留它，写方法才敢重试（见 canRetry）。
      if (error?.beforeSend === true) failure.beforeSend = true;
      throw failure;
    }
    // 注意：计时器**不能**在这里清。`fetch()` 只要拿到响应头就 resolve，而中继
    // 半边挂住时（头已回、body 永不进流）`response.text()` 会一直 pending；
    // 计时器一清就没有任何东西能打断它 —— 请求永久挂着，`sending` /
    // `detailLoadingOlder` 卡死到用户手工刷新。所以超时一直保留到 body 读完，
    // 统一在 finally 里清。

    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted === true && options.signal?.aborted !== true) {
        throw new ApiError('请求超时，电脑端可能正忙', { code: 'timeout' });
      }
      if (options.signal?.aborted === true) throw new ApiError('已取消', { code: 'aborted' });
      throw new ApiError('读取响应失败', { status: response.status, code: 'read' });
    } finally {
      clearTimeout(timer);
      // 外部 signal 上的监听也要摘：它活得比这次请求久，攒多了是泄漏。
      options.signal?.removeEventListener?.('abort', abort);
    }

    let payload = null;
    if (text.length > 0) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }
    if (payload === null) {
      throw new ApiError(
        response.ok ? '电脑返回了无法解析的数据' : `请求失败（HTTP ${response.status}）`,
        { status: response.status, code: 'bad_payload' },
      );
    }
    if (payload.ok === false) {
      const error = payload.error ?? {};
      if (response.status === 401 && requestToken && getToken() === requestToken) onUnauthorized(error.message ?? '登录已失效');
      throw new ApiError(error.message ?? `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        code: error.code ?? 'failed',
        body: payload,
      });
    }
    if (!response.ok) {
      if (response.status === 401 && requestToken && getToken() === requestToken) onUnauthorized('登录已失效');
      throw new ApiError(`请求失败（HTTP ${response.status}）`, { status: response.status, code: 'http', body: payload });
    }
    return payload.data ?? payload;
  }
}

const RECONNECT_BASE = 700;
const RECONNECT_MAX = 15_000;
/**
 * 后台（`document.hidden`）时的重连间隔：一次就够，不做指数增长。
 *
 * 比 RECONNECT_MAX 长得多是故意的：后台的重试只是"别彻底失联"，真正的恢复
 * 时机是回前台（`visibilitychange` → `kick()`）。
 */
const HIDDEN_RETRY = 60_000;
const PING_EVERY = 20_000;
const DEAD_AFTER = 75_000;
/**
 * 一次实时连接最多等这么久（从设置 connecting 到 onopen）。
 *
 * 没有这个上限时，只要票据请求或握手挂住，状态就永远是 connecting ——
 * 而 kick() 在 connecting 下是空操作，用户点「重连」会**完全没反应**。
 */
/**
 * 建立实时通道的总超时。
 *
 * **必须大于 `remote/remote.js` 的 `RPC_TIMEOUT_MS`（16 s）**：这条通道要先后完成
 * `POST /api/v1/ws-ticket` 与 `ws.open` 两个 RPC。原来写 9 s，比单次 RPC 预算还短，
 * 于是 ack 只要慢一点（公共 broker 抖动、手机切网），App 就在 9 s 自己掐断重来 ——
 * 表现为**同一个页面每 9~15 秒重建一次隧道**（bridge.log 里 `ws open` 紧接着
 * `ws close code=1000`，间隔稳定在 9~12 s），用户看到的就是"经常断连"。
 */
const CONNECT_TIMEOUT = 45_000;

/**
 * 页面在后台时，只保留一次长延迟重试。
 *
 * 为什么不能照常退避：手机切后台/锁屏后定时器只是**变慢，不是停**，退避仍然
 * 每 15 秒拉起一次连接；醒来时可能已经白白重建了几十条隧道（中继侧 slots
 * 一涨，用户看到的就是"很卡 / 连不上"）。后台没有人在看，一条长延迟足够通知
 * 自己"还活着"，回前台由 `visibilitychange` 的 `kick()` 立刻接管（web/app.js）。
 *
 * 抽成纯函数是为了能被单测直接钉住：指数退避 + 封顶、以及 hidden 分支。
 *
 * @param {number} failures 连续失败次数
 * @param {{hidden?: boolean, random?: () => number}} [options]
 * @returns {number} 毫秒
 */
export function reconnectDelay(failures, { hidden = false, random = Math.random } = {}) {
  if (hidden === true) return HIDDEN_RETRY;
  const attempt = Math.min(Math.max(0, Number(failures) || 0), 5);
  // + 随机抖动：多台设备同时掉线时别在同一毫秒一起重连。
  return Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** attempt) + Math.floor(random() * 250);
}

/**
 * Owns a single logical subscription to the host's event stream.
 *
 * Emits `{type, payload, seq}` frames to `onFrame`, and `{state}` transitions to
 * `onState` where state is one of: connecting | online | polling | offline.
 */
export class Realtime {
  /**
   * @param {object} options
   * @param {object} [options.tickets] 票据缓存（本文件的 `WsTicketCache`）：
   *   有它就走"预热好的一张票"（重建隧道时 0 次额外往返），没有就退回**每次现取**。
   * @param {() => Promise<string|null>} [options.getTicket] 更小的注入点（单测用），
   *   返回票字符串或 `null`。`tickets` 优先，其次 `getTicket`，都没有就现取。
   */
  constructor({ api, getBase, getToken, onFrame, onState, onError, onBeat, allowSse = true, tickets = null, getTicket = null }) {
    this.api = api;
    /**
     * 票据缓存。**建隧道要两次串行往返**（换票 → 升级），其中换票那一次在重建时
     * 完全可以省掉：票 60 s 有效、用掉即作废（见 `ws-ticket.js` 的长注释）。
     * 这里只负责"给我一张票"，预热/刷新/一次性都在缓存里做。
     */
    this.tickets = tickets;
    this.getTicket = getTicket;
    /**
     * 是否允许在 WebSocket 连续失败后退回 SSE 轮询。
     *
     * 中继外壳（手机走加密中继）里必须关掉：中继只搬离散帧，承载不了 SSE
     * 那种长连接流。一旦退回 SSE，实时通道就永久死掉，页面只能靠刷新恢复。
     * 这正是"手机点了重连也没反应"的根因之一。
     */
    this.allowSse = allowSse !== false;
    this.onBeat = onBeat ?? (() => {});
    this.getBase = getBase;
    this.getToken = getToken;
    this.onFrame = onFrame;
    this.onState = onState ?? (() => {});
    this.onError = onError ?? (() => {});
    this.state = 'offline';
    this.lastSeq = 0;
    this.bootId = '';
    this.generation = 0;
    this.failures = 0;
    this.socket = null;
    this.source = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.connectStartedAt = 0;
    this.lastPong = 0;
    this.closing = false;
    this.stopped = true;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  start() {
    this.stopped = false;
    this.failures = 0;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.closing = true;
    this.teardown();
    this.setState('offline');
    this.closing = false;
  }

  /** Called when the tab becomes visible again: do not wait for the backoff. */
  /**
   * 立刻（重新）连接。
   *
   * @param {boolean} [force] 为真时连 connecting 也打断 —— 用户点「重连」
   *   时必须是这个语义：他看到的"正在连接"很可能已经卡死了。
   */
  kick(force = false) {
    if (this.stopped) return;
    if (this.state === 'online' && force !== true) return;
    if (this.state === 'connecting' && !force) return;
    if (force) {
      try { globalThis.__POCKET_RELAY_RESTART__?.('用户点重连'); } catch { /* 没有外壳 */ }
    }
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failures = 0;
    void this.connect({ force });
  }

  /**
   * 探活：发一条 ping，不改状态。pong 会走 dispatch() 刷新 lastPong。
   * 回到前台时用它代替「无脑重连」——健康连接不该被踢。
   */
  probe() {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify({ type: 'ping' })); return true; } catch { return false; }
  }

  teardown() {
    this.generation += 1;
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket !== null) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      try { this.socket.close(); } catch { /* already gone */ }
      this.socket = null;
    }
    if (this.source !== null) {
      try { this.source.close(); } catch { /* already gone */ }
      this.source = null;
    }
  }

  /**
   * 强制重建一次实时通道。
   *
   * 用在"唤醒后判定这条看起来在线的连接已经半开"的场景：teardown 之后走
   * `connect({force:true})`，绕过下面那道防重入检查。
   */
  forceKick() {
    this.teardown();
    this.setState('offline');
    void this.connect({ force: true });
  }

  /**
   * 取一张一次性票据。
   *
   * 优先用预热好的缓存（0 次额外往返）；没有缓存（老调用方/单测）就现取 —— 这是
   * 原来唯一的那条路，行为完全不变。
   *
   * @returns {Promise<string>} 票字符串
   */
  async reserveTicket() {
    let ticket = null;
    if (this.tickets !== null && this.tickets !== undefined && typeof this.tickets.take === 'function') {
      ticket = await this.tickets.take();
    } else if (typeof this.getTicket === 'function') {
      ticket = await this.getTicket();
    } else {
      const payload = await this.api('/api/v1/ws-ticket', { method: 'POST' });
      ticket = typeof payload?.ticket === 'string' ? payload.ticket : null;
    }
    if (typeof ticket !== 'string' || ticket.length === 0) throw new ApiError('无法获取实时连接票据');
    return ticket;
  }

  async connect(options) {
    if (this.stopped) { console.debug('[pocket-diag] connect skipped: stopped'); return; }
    // 防重入：这个函数一进来就 teardown()，多调一次就等于把**健康**的隧道拆掉重开。
    // 实测现象（bridge.log）：`ws open <新 id>` 紧跟 `ws close <旧 id>`
    // reason="replaced by newer tunnel"，间隔稳定在握手硬超时的整数倍，
    // 用户侧就是"一直显示连接中断，正在重试"。
    // 只有真的没连上（或显式 force）才允许进来拆。
    if (options?.force !== true) {
      if (this.state === 'online' && this.socket?.readyState === WebSocket.OPEN) return;
      if (this.state === 'connecting') return;
    }
    console.debug(`[pocket-diag] connect start failures=${this.failures} state=${this.state}`);
    this.teardown();
    const generation = this.generation;
    this.setState('connecting');
    // 两次 WebSocket 失败通常意味着有代理吃掉了 upgrade；这时退回 SSE 轮询。
    // 但**中继外壳里不存在这种场景**：中继承载不了长连接流，退回 SSE 只会永久
    // 失去实时通道。所以中继模式下继续老老实实用 WS 重试。
    if (this.allowSse && this.failures >= 2) {
      this.openSse();
      return;
    }
    try {
      const ticket = await this.reserveTicket();
      if (this.stopped || this.generation !== generation) return;
      const base = normalizeBase(this.getBase()).replace(/^http/iu, 'ws');
      const since = this.bootId || this.lastSeq > 0 ? `&since=${this.lastSeq}&boot=${encodeURIComponent(this.bootId)}` : '';
      const socket = new WebSocket(`${base}/ws?ticket=${encodeURIComponent(ticket)}${since}`);
      this.socket = socket;
      // 连接超时：到点还没 open 就当作一次失败重来，绝不让状态吊在 connecting。
      this.connectStartedAt = Date.now();
      if (this.connectTimer !== null) clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (this.socket !== socket || this.state === 'online') return;
        try { socket.close(); } catch { /* ignore */ }
        this.socket = null;
        this.failures += 1;
        this.setState('offline');
        this.scheduleReconnect();
      }, CONNECT_TIMEOUT);
      socket.onopen = () => {
        if (this.socket !== socket || this.stopped) return;
        if (this.connectTimer !== null) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.failures = 0;
        this.lastPong = Date.now();
        this.setState('online');
        this.startPing();
        // 手里那张票已经用掉了：**后台**补下一张（票 60 s 有效，下一次重建就有货）。
        // 这是条后台请求，不挡任何界面；失败只是下次重建多跑一次往返。
        try { void this.tickets?.prewarm?.(); } catch { /* 缓存没装或已停 */ }
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket || this.stopped) return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        this.dispatch(frame);
      };
      socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        if (this.connectTimer !== null) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.socket = null;
        this.stopPing();
        if (this.closing || this.stopped) return;
        this.failures += 1;
        this.setState('offline');
        this.scheduleReconnect();
      };
    } catch (error) {
      if (this.stopped || this.generation !== generation) return;
      if (error?.status === 401) { this.setState('offline'); return; }
      this.failures += 1;
      this.setState('offline');
      this.scheduleReconnect();
    }
  }

  openSse() {
    if (typeof EventSource !== 'function') { this.scheduleReconnect(); return; }
    const base = normalizeBase(this.getBase());
    const since = this.bootId || this.lastSeq > 0 ? `&since=${this.lastSeq}&boot=${encodeURIComponent(this.bootId)}` : '';
    const url = `${base}/api/v1/events?token=${encodeURIComponent(this.getToken() ?? '')}${since}`;
    try {
      const source = new EventSource(url);
      this.source = source;
      const types = ['hello', 'summary', 'task.updated', 'task.created', 'task.removed', 'task.message', 'bridge.status', 'devices.changed', 'pong'];
      for (const type of types) {
        source.addEventListener(type, (event) => {
          if (this.source !== source || this.stopped) return;
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          this.dispatch({ ...frame, type: frame.type ?? type });
        });
      }
      source.onopen = () => { if (this.source === source && !this.stopped) this.setState('online'); };
      source.onerror = () => {
        if (this.source !== source || this.stopped) return;
        this.setState('offline');
        if (source.readyState === EventSource.CLOSED) {
          this.source = null;
          this.failures = 0;
          this.scheduleReconnect();
        }
      };
    } catch {
      this.failures += 1;
      this.scheduleReconnect();
    }
  }

  dispatch(frame) {
    if (frame === null || typeof frame !== 'object') return;
    this.onBeat();
    if (frame.type === 'pong') { this.lastPong = Date.now(); return; }
    if (frame.type === 'hello') {
      if (Number.isFinite(frame.seq)) this.lastSeq = Number(frame.seq);
      this.bootId = frame.payload?.bootId ?? '';
      this.lastPong = Date.now();
      this.setState('online');
      this.onFrame(frame, { resync: true });
      return;
    }
    if (Number.isFinite(frame.seq)) {
      if (frame.seq <= this.lastSeq) return;
      this.lastSeq = frame.seq;
    }
    this.onFrame(frame, { resync: false });
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
      // A half-open socket looks connected forever; drop it and reconnect.
      if (this.lastPong > 0 && Date.now() - this.lastPong > DEAD_AFTER) {
        try { socket.close(); } catch { /* ignore */ }
      }
    }, PING_EVERY);
  }

  stopPing() {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  scheduleReconnect() {
    if (this.stopped) { console.debug('[pocket-diag] scheduleReconnect skipped: stopped'); return; }
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    // 后台时的重连策略见 reconnectDelay()：只留一次长延迟，回前台交给 kick()。
    const hidden = typeof document !== 'undefined'
      && (document.hidden === true || document.visibilityState === 'hidden');
    const delay = reconnectDelay(this.failures, { hidden });
    console.debug(`[pocket-diag] reconnect scheduled in ${delay}ms attempt=${this.failures}${hidden ? ' (hidden)' : ''}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) void this.connect();
    }, delay);
  }
}

/* ---------------------- 实时票的本地缓存（预热） ---------------------- */

/**
 * 建一条实时隧道要**两次串行往返**：先 `POST /api/v1/ws-ticket` 换票，再拿票去
 * 升级 `/ws`。单向 300 ms（RTT ≈ 600 ms）下的实测（`test/support/bench-harness.mjs`，
 * 真 CloudLink + 真 relay-client + 真 `ws.open`）：换票 p50 **648 ms**、升级 p50
 * **632 ms**，即「息屏唤醒 / 切网之后重新进入实时」= **1275 ms**。
 *
 * 而票的有效期是 60 s（`lib/core.mjs` 的 `createWsTicket()`），重建之间的间隔通常
 * 远小于 60 s —— 那就没必要每次都现取：**开机预热一张，用掉立刻补下一张**，重建时
 * 票已在手上，只剩一次升级（实测同一口径 **629 ms**，省一次往返 ≈ 646 ms）。
 * 首屏 detail 的应答里也会顺带下发一张（`wsTicket` 字段），`offer()` 直接收下即可。
 *
 * 安全边界（一个字都不许放宽）
 * ---------------------------
 * - 票**只**来自电脑端应答：`POST /api/v1/ws-ticket`，或首屏 detail 里那张
 *   （两边是同一个 `createWsTicket()`，同一份 60 s TTL）；
 * - **一次性**：`take()` 出票即从缓存删除，同一张票绝不会被发第二次 —— 电脑端
 *   `consumeWsTicket()` 用过就删，缓存里留着再用只会拿一张死票去撞 401；
 * - **快过期就不用**：离过期不足 `TICKET_SAFETY_MS` 的票一律丢弃重取，绝不把
 *   "送到时已过期"的票塞进握手；没有 `expiresAt` 的票按过期处理（宁可多跑一次往返）；
 * - 只做**内存**缓存：不写 storage、不进日志，票也不会出现在 URL 之外的地方
 *   （握手 URL 里的 `?ticket=` 是原有协议，没改）。
 *
 * 缓存逻辑放在这里（而不是新开 `web/lib/*.js`）：`web/sw.js` 的离线预缓存清单要
 * 与 `web/**` 的 import 图严格一致，新增文件就得改 SW（本次不在可改范围）。
 */

/** 出票安全余量：离过期不到这么久就不用它（≈ 一次往返 + 抖动）。 */
export const TICKET_SAFETY_MS = 10_000;
/** 在"过期 - 安全余量"的这个比例处补下一张（60 s 的票大约每 25 s 补一次）。 */
export const TICKET_REFRESH_RATIO = 0.5;
/** 取票失败后的重试间隔（后台补票，不打扰用户）。 */
export const TICKET_RETRY_MS = 5_000;

/** 把应答（`{ticket, expiresAt}`）归一成缓存条目；不合法就 `null`。 */
function ticketEntry(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const ticket = typeof payload.ticket === 'string' ? payload.ticket : '';
  const expiresAt = Number(payload.expiresAt);
  if (ticket.length === 0) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return { ticket, expiresAt };
}

/**
 * 一次性实时票的缓存：**预热 + 按过期刷新 + 出票即作废**。
 *
 * `Realtime` 只问它要一张票（`take()`），握手路径不需要知道预热细节；这样预热
 * 逻辑能注入时钟与定时器单测（`test/unit/ws-ticket.test.mjs`）。
 */
export class WsTicketCache {
  #fetchTicket;
  #now;
  #safetyMs;
  #refreshRatio;
  #retryMs;
  #setTimer;
  #clearTimer;
  #onError;

  /** 当前备着的那张票（最多一张）。 */
  #current = null;
  /**
   * 最近发出去过的票（只留 16 条、不含票内容以外的东西）。
   *
   * 为什么还要记这个：电脑端的**重放缓存**按 request id 回放整份应答 —— 一条
   * 已经送达、票也已经用掉的 detail 若因故被同 id 重放一次，票又会被 `offer()`
   * 收进来第二次。拿这张死票去握手只会白吃一次 401，所以出过手的票一律不许再进缓存。
   */
  #spent = new Set();
  /** 单飞：同一时刻最多一条取票请求在飞（开机预热与 connect 会同时要票）。 */
  #inflight = null;
  #timer = null;
  #stopped = false;
  /** 串行化 `take()`：两次并发取票绝不能拿到同一张。 */
  #chain = Promise.resolve();
  #fetches = 0;

  /**
   * @param {object} options
   * @param {() => Promise<{ticket?: string, expiresAt?: number}|null>} options.fetchTicket
   *   真的去电脑端换票（一般是 `api('/api/v1/ws-ticket', { method: 'POST' })`）。
   * @param {() => number} [options.now]        时钟（单测注入）。
   * @param {number} [options.safetyMs]         出票安全余量。
   * @param {number} [options.refreshRatio]     刷新点（相对"过期 - 余量"的比例）。
   * @param {number} [options.retryMs]          取票失败后的重试间隔。
   * @param {(fn: () => void, ms: number) => any} [options.setTimer]
   * @param {(id: any) => void} [options.clearTimer]
   * @param {(error: Error) => void} [options.onError] 取票失败（后台预热失败不该抛给界面）。
   */
  constructor({
    fetchTicket,
    now = () => Date.now(),
    safetyMs = TICKET_SAFETY_MS,
    refreshRatio = TICKET_REFRESH_RATIO,
    retryMs = TICKET_RETRY_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onError = () => {},
  } = {}) {
    if (typeof fetchTicket !== 'function') throw new TypeError('WsTicketCache 需要 fetchTicket()');
    this.#fetchTicket = fetchTicket;
    this.#now = now;
    this.#safetyMs = Math.max(0, Number(safetyMs) || 0);
    this.#refreshRatio = Math.min(0.9, Math.max(0.1, Number(refreshRatio) || TICKET_REFRESH_RATIO));
    this.#retryMs = Math.max(1, Number(retryMs) || TICKET_RETRY_MS);
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#onError = onError;
  }

  /** 诊断/单测用：缓存里有没有票、取过几次票。**不含票本身**。 */
  get stats() {
    return {
      cached: this.#current !== null,
      inflight: this.#inflight !== null,
      fetches: this.#fetches,
      stopped: this.#stopped,
    };
  }

  /**
   * 预热：缓存里没有**可用**的票时才去取一张，取到后按过期时间排一次刷新。
   * 失败不抛（后台预热不该把界面搞坏）：走 `onError`，并按 `retryMs` 再试。
   *
   * @returns {Promise<boolean>} 现在手里有票吗
   */
  async prewarm() {
    if (this.#stopped) return false;
    const current = this.#current;
    if (this.#usable(current)) {
      // 手里有票：只把"该补下一张的时刻"重新校准一下（幂等），不白跑往返。
      this.#scheduleRefresh(current);
      return true;
    }
    if (current !== null) this.#current = null;
    return this.#refreshOnce();
  }

  /**
   * 取一张票（**用掉就没了**）。
   *
   * @returns {Promise<string|null>} 票字符串；取不到返回 `null`（调用方按"无法获取票据"处理）。
   */
  take() {
    const run = this.#chain.then(() => this.#takeOnce());
    // 链本身永远 resolve：一次失败不该把后续所有取票都带崩。
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 票随别的应答一起回来了（首屏 `GET /api/v1/tasks/:id` 的 `wsTicket`）：
   * 直接收进缓存，**不额外跑一次往返**。
   *
   * @param {{ticket?: string, expiresAt?: number}|null|undefined} payload
   * @returns {boolean} 收下了吗
   */
  offer(payload) {
    if (this.#stopped) return false;
    const entry = ticketEntry(payload);
    if (entry === null) return false;
    if (this.#now() + this.#safetyMs >= entry.expiresAt) return false;
    // 这张已经用过了（同一条 detail 应答被重放一次就会这样）：收下只会变成死票。
    if (this.#spent.has(entry.ticket)) return false;
    const current = this.#current;
    // 手里已经有一张更耐放的票就别换（换掉只是白丢一张好票）。
    if (current !== null && this.#usable(current) && current.expiresAt >= entry.expiresAt) return false;
    this.#current = entry;
    this.#scheduleRefresh(entry);
    return true;
  }

  /** 重新开始缓存（换设备 / 重新配对之后 `startRealtime()` 会调）。 */
  start() {
    this.#stopped = false;
  }

  /** 停掉后台刷新并丢掉缓存（退登 / 解除配对时调）。 */
  stop() {
    this.#stopped = true;
    this.#cancel();
    this.#current = null;
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  async #takeOnce() {
    if (this.#stopped) return null;
    const entry = await this.#ensure();
    if (entry === null) return null;
    // 出票即作废：电脑端一用就删，缓存留着再用只会拿一张死票去握手。
    if (this.#current === entry) this.#current = null;
    this.#cancel();
    this.#remember(entry.ticket);
    return entry.ticket;
  }

  /** 记下发过手的票（只留最近 16 条：够挡住重放，不会长成账本）。 */
  #remember(ticket) {
    this.#spent.add(ticket);
    while (this.#spent.size > 16) {
      const oldest = this.#spent.values().next().value;
      if (oldest === undefined) break;
      this.#spent.delete(oldest);
    }
  }

  /** 有可用票就用它，否则取一张新的（取不到返回 null）。 */
  async #ensure() {
    const current = this.#current;
    if (this.#usable(current)) return current;
    if (current !== null) this.#current = null;
    return this.#load();
  }

  /**
   * 强制换一张新票（定时刷新与失败重试走这条）。
   *
   * 与 `#ensure()` 的区别：**不**看手里那张还能不能用 —— 刷新点的意义就是"在旧票
   * 变成不能用之前先备好新的"，走 ensure 会看到旧票还能用、然后什么都不做，
   * 缓存里的票就一路烂到过期（等于没预热）。
   */
  async #refreshOnce() {
    const entry = await this.#load();
    if (entry === null) {
      this.#scheduleRetry();
      return false;
    }
    this.#scheduleRefresh(entry);
    return true;
  }

  #usable(entry) {
    if (entry === null || entry === undefined) return false;
    if (typeof entry.ticket !== 'string' || entry.ticket.length === 0) return false;
    // 已经出过手的票不许再被当成可用的（重放缓存会把同一条应答再放一遍）。
    if (this.#spent.has(entry.ticket)) return false;
    const left = Number(entry.expiresAt) - this.#now();
    return Number.isFinite(left) && left > this.#safetyMs;
  }

  /** 单飞取票：并发调用共享同一个 Promise，绝不因为并发多跑一次往返。 */
  #load() {
    if (this.#inflight !== null) return this.#inflight;
    const promise = Promise.resolve()
      .then(() => {
        this.#fetches += 1;
        return this.#fetchTicket();
      })
      .then((payload) => {
        const entry = ticketEntry(payload);
        // 应答里没有票：当作失败，别把 undefined 当票塞进握手 URL。
        if (entry === null) throw new Error('取票应答里没有可用的 ticket/expiresAt');
        // 重放回来的旧应答：当成一次失败（下一次重试会拿到一张新的）。
        if (this.#spent.has(entry.ticket)) throw new Error('取票应答里是一张已经用过的票');
        if (this.#stopped) return null;
        this.#current = entry;
        return entry;
      })
      .catch((error) => {
        this.#onError(error instanceof Error ? error : new Error(String(error)));
        return null;
      })
      .finally(() => { this.#inflight = null; });
    this.#inflight = promise;
    return promise;
  }

  /** 在"过期 - 余量"的一半处补一张新的：缓存里的票永远不会烂到不能用。 */
  #scheduleRefresh(entry) {
    this.#cancel();
    if (this.#stopped) return;
    const left = entry.expiresAt - this.#now() - this.#safetyMs;
    if (!(left > 0)) return;
    const delay = Math.max(1_000, Math.round(left * this.#refreshRatio));
    this.#arm(() => { void this.#refreshOnce(); }, delay);
  }

  #scheduleRetry() {
    this.#cancel();
    if (this.#stopped) return;
    this.#arm(() => { void this.#refreshOnce(); }, this.#retryMs);
  }

  #arm(fn, delay) {
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      if (this.#stopped) return;
      fn();
    }, delay);
    // 定时器不该把 Node 进程拴住（测试进程会因此不退）。
    try { this.#timer?.unref?.(); } catch { /* 浏览器没有 unref */ }
  }

  #cancel() {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
  }
}