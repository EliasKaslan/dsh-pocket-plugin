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
 * @param {string} path
 * @param {{method?: string, body?: unknown, base?: string, auth?: boolean, timeout?: number, signal?: AbortSignal}} options
 */
export function createApi({ getBase, getToken, onUnauthorized }) {
  return async function api(path, options = {}) {
    const base = normalizeBase(options.base ?? getBase());
    const method = options.method ?? 'GET';
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
    const abort = () => controller.abort(new Error('aborted'));
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }

    const headers = { accept: 'application/json' };
    if (options.auth !== false) {
      const token = getToken();
      if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`;
    }
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await fetch(base + path, { method, headers, body, cache: 'no-store', signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (options.signal?.aborted === true) throw new ApiError('已取消', { code: 'aborted' });
      if (error?.name === 'AbortError') throw new ApiError('请求超时，电脑端可能正忙', { code: 'timeout' });
      throw new ApiError('连不上电脑，请检查网络与插件状态', { code: 'network' });
    }
    clearTimeout(timer);

    let text;
    try {
      text = await response.text();
    } catch {
      throw new ApiError('读取响应失败', { status: response.status, code: 'read' });
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
      if (response.status === 401) onUnauthorized(error.message ?? '登录已失效');
      throw new ApiError(error.message ?? `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        code: error.code ?? 'failed',
        body: payload,
      });
    }
    if (!response.ok) {
      if (response.status === 401) onUnauthorized('登录已失效');
      throw new ApiError(`请求失败（HTTP ${response.status}）`, { status: response.status, code: 'http', body: payload });
    }
    return payload.data ?? payload;
  };
}

const RECONNECT_BASE = 700;
const RECONNECT_MAX = 15_000;
const PING_EVERY = 20_000;
const DEAD_AFTER = 75_000;
/**
 * 一次实时连接最多等这么久（从设置 connecting 到 onopen）。
 *
 * 没有这个上限时，只要票据请求或握手挂住，状态就永远是 connecting ——
 * 而 kick() 在 connecting 下是空操作，用户点「重连」会**完全没反应**。
 */
const CONNECT_TIMEOUT = 9_000;

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
    if (this.state === 'online') return;
    if (this.state === 'connecting' && !force) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failures = 0;
    void this.connect();
  }

  teardown() {
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

  async connect() {
    if (this.stopped) return;
    this.teardown();
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
      if (this.stopped) return;
      if (typeof ticket?.ticket !== 'string' || ticket.ticket.length === 0) {
        throw new ApiError('无法获取实时连接票据');
      }
      const base = normalizeBase(this.getBase()).replace(/^http/iu, 'ws');
      const since = this.lastSeq > 0 ? `&since=${this.lastSeq}` : '';
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
        if (this.connectTimer !== null) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.failures = 0;
        this.lastPong = Date.now();
        this.setState('online');
        this.startPing();
      };
      socket.onmessage = (event) => {
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
      if (this.stopped) return;
      if (error?.status === 401) { this.setState('offline'); return; }
      this.failures += 1;
      this.setState('offline');
      this.scheduleReconnect();
    }
  }

  openSse() {
    if (typeof EventSource !== 'function') { this.scheduleReconnect(); return; }
    const base = normalizeBase(this.getBase());
    const since = this.lastSeq > 0 ? `&since=${this.lastSeq}` : '';
    const url = `${base}/api/v1/events?token=${encodeURIComponent(this.getToken() ?? '')}${since}`;
    try {
      const source = new EventSource(url);
      this.source = source;
      const types = ['hello', 'summary', 'task.updated', 'task.created', 'task.removed', 'task.message', 'bridge.status', 'devices.changed', 'pong'];
      for (const type of types) {
        source.addEventListener(type, (event) => {
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          this.dispatch({ ...frame, type: frame.type ?? type });
        });
      }
      source.onopen = () => { this.setState('online'); };
      source.onerror = () => {
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
    if (this.stopped) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    const attempt = Math.min(this.failures, 5);
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** attempt) + Math.floor(Math.random() * 250);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) void this.connect();
    }, delay);
  }
}
