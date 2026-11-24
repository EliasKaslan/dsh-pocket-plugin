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

/** Normalise the shell origin: add a scheme when missing, drop a trailing slash. */
export function normalizeBase(input) {
  let text = String(input ?? '').trim();
  if (text.length === 0) return '';
  if (!/^https?:\/\//iu.test(text)) text = `http://${text}`;
  return text.replace(/\/+$/u, '');
}

const DEFAULT_TIMEOUT = 20_000;

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

/** 这条请求在失败之后还能不能再试一次。 */
function canRetry({ method, options, error, attempt, attempts, signal }) {
  if (attempt >= attempts) return false;
  if (signal?.aborted === true) return false;
  if (options?.signal?.aborted === true) return false;
  // 自己的超时 / 用户取消 / 协议层错误（401、坏 body）重试只会重复同一结果。
  if (error?.code !== 'network' && error?.code !== 'read') return false;
  const verb = String(method ?? 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return true;
  if (options?.idempotent === true) return true;
  return error?.beforeSend === true;
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
        if (!canRetry({ method, options, error, attempt, attempts, signal: options.signal })) throw error;
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
  constructor({ api, getBase, getToken, onFrame, onState, onError, onBeat, allowSse = true }) {
    this.api = api;
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
      const ticket = await this.api('/api/v1/ws-ticket', { method: 'POST' });
      if (this.stopped || this.generation !== generation) return;
      if (typeof ticket?.ticket !== 'string' || ticket.ticket.length === 0) {
        throw new ApiError('无法获取实时连接票据');
      }
      const base = normalizeBase(this.getBase()).replace(/^http/iu, 'ws');
      const since = this.bootId || this.lastSeq > 0 ? `&since=${this.lastSeq}&boot=${encodeURIComponent(this.bootId)}` : '';
      const socket = new WebSocket(`${base}/ws?ticket=${encodeURIComponent(ticket.ticket)}${since}`);
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
