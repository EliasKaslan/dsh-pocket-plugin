/**
 * HTTP + WebSocket front door for the plugin.
 *
 * Security posture: the DSH web server itself stays on loopback. This listener
 * never leaves loopback, so this is the only HTTP surface; every route except
 * pairing/hello requires a per-device bearer token.
 *
 * Three guards are applied before any route runs:
 *   1. `Host` must name this machine (DNS-rebinding defence, all routes).
 *   2. The relay header is stripped unconditionally and remembered on the
 *      request object, so a request that came through the phone's relay can
 *      never be mistaken for a local browser.
 *   3. Loopback-only routes re-check socket + Host and, for writes, the
 *      Origin / Sec-Fetch-Site / CSRF-token triple.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { clearSessions, validateCredentials, writeCredentials } from './credentials.mjs';
import { renderLandingPage, renderPairPage } from './pair-page.mjs';
import {
  RELAY_HEADER, RELAY_MARK, RateLimiter, clientIp, contentType, drainRequest,
  fileStat, nowMs, readJsonBody, redactUrl, safeEqual, safeJoin, sendJson, sendText,
} from './util.mjs';

const API_PREFIX = '/api/v1';
const MAX_BODY = 256 * 1024;
const MAX_FORM_BODY = 4096;
const MAX_WS_CLIENTS = 40;
const MAX_WS_PER_DEVICE = 6;
const MAX_SSE_CLIENTS = 32;
const MAX_SSE_PER_DEVICE = 6;
/** A stalled client is dropped once this many bytes are buffered for it. */
const MAX_STREAM_BUFFER = 1024 * 1024;

const ERROR_STATUS = {
  internal: 500,
  not_found: 404,
  method: 405,
  loopback_only: 403,
  csrf: 403,
  unauthorized: 401,
  rate_limited: 429,
  body_too_large: 413,
  invalid_json: 400,
  bad_cwd: 400,
  cwd_forbidden: 403,
  empty_prompt: 400,
  prompt_too_long: 413,
  create_in_flight: 409,
  not_running: 409,
  bad_broker: 400,
  invalid_credentials: 400,
  unavailable: 503,
  no_agent: 503,
  subagent_immutable: 409,
  preset_broken: 409,
  create_failed: 500,
  prompt_failed: 500,
  cancel_failed: 500,
  read_failed: 500,
};

function statusForError(error) {
  return ERROR_STATUS[error?.code] ?? 500;
}

function securityHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http: https: ws: wss:; font-src 'self' data:; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

function parseUrl(req) {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  } catch {
    return new URL('http://127.0.0.1/');
  }
}

function pathnameOf(url) {
  try { return decodeURIComponent(url.pathname); } catch { return url.pathname; }
}

/**
 * Windows permits a 0.0.0.0 listener beside a 127.0.0.1-only one, which would
 * silently send loopback pairing-page requests to the *other* service. Probe
 * loopback first so a busy port is skipped no matter which interface owns it.
 */
function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (value) => {
      try { server.close(); } catch { /* not listening */ }
      resolve(value);
    };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    try { server.listen(port, host); } catch { done(false); }
  });
}

/**
 * 热重载时**先重试首选端口**再决定顺延。
 *
 * 上一个实例刚 dispose 的一瞬间，它的监听 socket 可能还没完全收尾，`canBind`
 * 会瞬时失败 —— 直接顺延的话，用户每次热重载都会被挪到 47902、47903……
 * 端口本身对手机无害（二维码里没有回环端口），但"每次重载都换地址"会让
 * 排障的人误以为出了新问题。三次、每次 120 ms 足够覆盖这个收尾窗口。
 */
async function canBindWithRetry(port, host, attempts = 3, gapMs = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await canBind(port, host)) return true;
    if (attempt < attempts - 1) await new Promise((resolve) => { setTimeout(resolve, gapMs); });
  }
  return false;
}

/**
 * 详情响应的整形。
 *
 * `?after=` 是流式追新：手机已经有任务头、更早的消息和子任务列表了，重复发这些
 * 等于每次都在重传同一批元数据（实测空增量也要 3.6 KB）。增量模式只回增量本身。
 *
 * 导出是为了能单测 —— 这个形状直接决定流式期间每一帧的体积。
 */
export function shapeDetailResponse(detail, { incremental = false } = {}) {
  if (incremental !== true) return detail;
  return {
    messages: Array.isArray(detail?.messages) ? detail.messages : [],
    total: typeof detail?.total === 'number' ? detail.total : 0,
    reset: detail?.reset === true,
    hasMoreAfter: detail?.hasMoreAfter === true,
  };
}

export class BridgeServer {
  constructor(core, { logger, webRoot, downloadDirs = [] }) {
    this.core = core;
    this.logger = logger;
    this.webRoot = webRoot;
    this.downloadDirs = downloadDirs.filter((dir) => typeof dir === 'string' && dir.length > 0);
    this.http = undefined;
    this.wss = undefined;
    /** deviceId -> Set<{socket, cleanup}> */
    this.wsClients = new Map();
    /** deviceId -> Set<client> */
    this.sseClients = new Map();
    this.allSse = new Set();
    this.authLimiter = new RateLimiter();
    this.createLimiter = new RateLimiter();
    this.helloLimiter = new RateLimiter();
    this.sweepTimer = setInterval(() => {
      this.authLimiter.sweep();
      this.createLimiter.sweep();
      this.helloLimiter.sweep();
    }, 60_000);
    this.sweepTimer.unref?.();
    core.setServer(this);
  }

  async listen(preferredPort, host) {
    let lastError;
    for (let offset = 0; offset < 16; offset += 1) {
      const port = preferredPort + offset;
      // 首选端口先重试几次（热重载后上一个实例可能刚放手）；顺延的端口不做重试。
      const free = offset === 0
        ? await canBindWithRetry(port, '127.0.0.1')
        : await canBind(port, '127.0.0.1');
      if (!free) {
        this.logger.warn(`port ${port} is owned by another service on loopback, trying ${port + 1}`);
        continue;
      }
      const server = http.createServer((req, res) => {
        // Every handler path must be able to reject without taking the host
        // down: an unhandled rejection here would kill the DSH process.
        this.handle(req, res).catch((error) => {
          try { this.logger.error('unhandled request failure', req.method, redactUrl(req.url), error); } catch { /* logging failed */ }
          if (res.headersSent || res.writableEnded) {
            try { res.destroy(); } catch { /* gone */ }
            return;
          }
          sendJson(res, 500, { ok: false, error: { code: 'internal', message: '服务内部错误' } }, securityHeaders());
        });
      });
      server.keepAliveTimeout = 30_000;
      server.headersTimeout = 35_000;
      server.requestTimeout = 30_000;

      const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, clientTracking: true });
      wss.on('connection', (socket, request, device) => this.onConnection(socket, request, device));
      server.on('upgrade', (request, socket, head) => this.onUpgrade(request, socket, head, wss));
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
          const onListening = () => { server.removeListener('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, host);
        });
        this.http = server;
        this.wss = wss;
        // Port 0 asks the OS for a free port, so report what actually bound.
        const bound = server.address();
        return typeof bound === 'object' && bound !== null && typeof bound.port === 'number'
          ? bound.port
          : port;
      } catch (error) {
        lastError = error;
        try { wss.close(); } catch { /* not opened */ }
        try { server.close(); } catch { /* not opened */ }
        if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') break;
        this.logger.warn(`port ${port} unavailable (${error.code}), trying ${port + 1}`);
      }
    }
    throw lastError ?? new Error('no usable port');
  }

  close() {
    clearInterval(this.sweepTimer);
    for (const client of [...this.allSse]) this.closeSse(client, false);
    this.allSse.clear();
    this.sseClients.clear();
    for (const entries of this.wsClients.values()) {
      for (const entry of [...entries]) {
        try { entry.socket.close(1001, 'bridge reloading'); } catch { /* already closed */ }
      }
    }
    this.wsClients.clear();
    try { this.wss?.close(); } catch { /* not opened */ }
    try { this.http?.close(); } catch { /* not opened */ }
    // `close()` 只停止接收新连接；已有的 keep-alive 连接会攥着 socket 直到
    // 超时（30 s），热重载时端口看起来就"还没放"。主动断开，重载才确定。
    try { this.http?.closeAllConnections?.(); } catch { /* 老版本 Node 没有这个 API */ }
    this.http = undefined;
    this.wss = undefined;
  }

  /** Unconditionally remove the relay header and remember that it was there. */
  stripRelayHeader(req) {
    const raw = req.headers?.[RELAY_HEADER];
    if (raw === undefined) return false;
    // Fail-closed first: whatever the value, a request that carried the header
    // is treated as relay-originated (never loopback), then the header is
    // removed so no downstream code can be tricked by a re-sent copy.
    req[RELAY_MARK] = true;
    try { delete req.headers[RELAY_HEADER]; } catch { /* frozen headers */ }
    if (typeof raw !== 'string' || raw.length === 0 || !safeEqual(raw, this.core.relayNonce)) {
      // Forged marker: worth a line in the log (the value itself never is).
      this.logger.warn('relay 标记无效，已按远程请求处理并剥离该头');
      return false;
    }
    return true;
  }

  async handle(req, res) {
    const started = Date.now();
    this.stripRelayHeader(req);

    // 1) Host gate for every route: a foreign Host means DNS rebinding.
    if (!this.core.hostAllowed(req.headers?.host)) {
      this.logger.warn(`rejected request with untrusted Host header (${req.method} ${redactUrl(req.url)})`);
      drainRequest(req);
      if (pathnameOf(parseUrl(req)).startsWith(API_PREFIX)) {
        sendJson(res, 403, { ok: false, error: { code: 'bad_host', message: 'Host 校验失败' } }, securityHeaders());
      } else {
        sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8', securityHeaders());
      }
      return;
    }

    const url = parseUrl(req);
    const pathname = pathnameOf(url);
    if (req.method === 'OPTIONS') {
      drainRequest(req);
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(204, securityHeaders({ allow: 'GET, POST, OPTIONS' }));
      res.end();
      return;
    }

    try {
      if (pathname.startsWith(API_PREFIX)) {
        await this.handleApi(req, res, url, pathname.slice(API_PREFIX.length));
      } else if (pathname === '/pair' || pathname === '/pair/') {
        this.servePairPage(req, res);
      } else if (pathname.startsWith('/cloud/')) {
        await this.handleCloudAdmin(req, res, pathname.slice('/cloud/'.length));
      } else if (pathname.startsWith('/pair/')) {
        // Accept both `web/pair/pair.js` (source layout) and `web/pair.js`
        // (flattened build output): the web assets are maintained separately.
        const base = path.basename(pathname.slice('/pair/'.length));
        if (base === 'pair.js' || base === 'pair.css') {
          this.serveFirstExisting(req, res, [
            path.join(this.webRoot, 'pair', base),
            path.join(this.webRoot, base),
          ], { cache: 'no-store' });
        } else {
          sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', securityHeaders());
        }
      } else if (pathname === '/app' || pathname === '/app/' || pathname === '/index.html') {
        this.serveFile(req, res, path.join(this.webRoot, 'index.html'), { cache: 'no-store' });
      } else if (pathname.startsWith('/app/')) {
        const relative = pathname.slice('/app/'.length);
        const file = safeJoin(this.webRoot, relative);
        const info = file === undefined ? undefined : fileStat(file);
        if (file !== undefined && info !== undefined && statSync(file).isFile()) {
          const cache = /\.(?:png|jpe?g|webp|gif|svg|ico|woff2?)$/iu.test(file) ? 'public, max-age=86400' : 'no-cache';
          if (relative === 'sw.js') this.serveWorker(req, res, file);
          else this.serveFile(req, res, file, { cache });
        } else {
          this.serveFile(req, res, path.join(this.webRoot, 'index.html'), { cache: 'no-store' });
        }
      } else if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true, data: this.core.publicStatus() }, securityHeaders());
      } else if (pathname === '/' || pathname === '') {
        if (this.core.isLoopbackRequest(req)) {
          if (!res.headersSent) {
            res.writeHead(302, securityHeaders({ location: '/pair' }));
            res.end();
          }
        } else {
          sendText(res, 200, renderLandingPage(this.core), 'text/html; charset=utf-8', securityHeaders());
        }
      } else if (pathname.startsWith('/download/')) {
        this.serveDownload(req, res, pathname.slice('/download/'.length));
      } else if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
        this.serveFirstExisting(req, res, [
          path.join(this.webRoot, 'favicon.svg'),
          path.join(this.webRoot, 'pair', 'favicon.svg'),
        ], { cache: 'public, max-age=86400' });
      } else {
        sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', securityHeaders());
      }
      const elapsed = Date.now() - started;
      if (elapsed > 1500) this.logger.warn(`slow ${req.method} ${redactUrl(req.url)} ${elapsed}ms`);
    } catch (error) {
      // Never log the raw URL: it can carry a bearer token in `?token=`.
      this.logger.error('request failed', req.method, redactUrl(req.url), error?.stack ?? error);
      if (res.headersSent || res.writableEnded) {
        try { res.destroy(); } catch { /* gone */ }
        return;
      }
      if (pathname.startsWith(API_PREFIX)) {
        sendJson(res, statusForError(error), {
          ok: false,
          error: { code: error?.code ?? 'internal', message: String(error?.message ?? '服务内部错误') },
        }, securityHeaders());
      } else {
        sendText(res, 500, 'Internal Server Error', 'text/plain; charset=utf-8', securityHeaders());
      }
    }
  }

  /**
   * Loopback-only gate. `write` also enforces the CSRF triple:
   * Sec-Fetch-Site, then Origin, then the per-process token.
   */
  requireLoopback(req, res, url, { write = false } = {}) {
    if (!this.core.isLoopbackRequest(req)) {
      this.logger.warn(`blocked ${write ? 'write' : 'read'} from ${this.core.loopbackDeniedReason(req) || 'unknown'} (${req.method} ${redactUrl(req.url)})`);
      if (write) drainRequest(req);
      sendJson(res, 403, { ok: false, error: { code: 'loopback_only', message: '仅可在电脑本机操作' } }, securityHeaders());
      return false;
    }
    if (write && !this.csrfOk(req, url)) {
      drainRequest(req);
      sendJson(res, 403, { ok: false, error: { code: 'csrf', message: '请求来源校验失败，请刷新电脑上的配对页后重试' } }, securityHeaders());
      return false;
    }
    return true;
  }

  csrfOk(req, url) {
    const site = req.headers?.['sec-fetch-site'];
    if (typeof site === 'string' && site.length > 0) {
      return site === 'same-origin' || site === 'none';
    }
    const origin = req.headers?.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        return this.core.allowedHosts().has(parsed.hostname.toLowerCase());
      } catch {
        return false;
      }
    }
    // No browser signals at all. Browsers always attach `Origin` (and
    // `Sec-Fetch-Site`) to a POST — including plain form posts — so this branch
    // is only reachable from local tooling (the `dsh-pocket-plugin` CLI) that
    // talks to the socket directly. Scope it to loopback instead of returning a
    // blanket `true`, so a request that arrives through the relay cannot use
    // "I sent no Origin" as a way past the check.
    const token = req.headers?.['x-pocket-csrf'] ?? url.searchParams.get('csrf');
    if (typeof token === 'string' && token.length > 0) return safeEqual(token, this.core.csrfToken);
    return this.core.isLoopbackRequest(req);
  }

  /** Form fallback for the two loopback forms; never used for JSON routes. */
  async formCsrfOk(req) {
    const type = String(req.headers?.['content-type'] ?? '');
    if (!type.includes('application/x-www-form-urlencoded')) return false;
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (body.length > MAX_FORM_BODY) return false;
      }
    } catch {
      return false;
    }
    const token = new URLSearchParams(body).get('csrf');
    return typeof token === 'string' && token.length > 0 && safeEqual(token, this.core.csrfToken);
  }

  servePairPage(req, res) {
    if (!this.core.isLoopbackRequest(req)) {
      this.logger.warn(`pairing page blocked (${this.core.loopbackDeniedReason(req) || 'unknown'})`);
      sendText(res, 403, renderLandingPage(this.core, { forbidden: true }), 'text/html; charset=utf-8', securityHeaders());
      return;
    }
    // 这一页只需要一个稳定的安装指纹（页面底部用来区分「同一台电脑」）。
    // 配对码已经彻底移除，所以不再有「读一次顺带轮换」这件事。
    const view = { fingerprint: this.core.fingerprint };
    const remote = this.core.remoteView();
    const html = renderPairPage(this.core, view, this.core.devicesView(), remote, {
      csrfToken: this.core.csrfToken,
      auth: remote.auth ?? {},
    });
    sendText(res, 200, html, 'text/html; charset=utf-8', securityHeaders({ 'cache-control': 'no-store' }));
  }

  /**
   * Remote-relay controls. Loopback only and POST only: rotating the link
   * revokes the current token, so it must never be reachable from the network.
   *
   * `action` is the last path segment, so both the desktop page (`/cloud/*`)
   * and the CLI (`/api/v1/cloud/*`) share one implementation.
   */
  async handleCloudAdmin(req, res, action, { respondJson = false } = {}) {
    const url = parseUrl(req);
    if (action === 'status') {
      if (!this.requireLoopback(req, res, url, { write: false })) return;
      // Loopback-only, so the QR is safe here (unlike `/hello`): the desktop
      // page uses it to refresh the remote card after a link rotation.
      sendJson(res, 200, { ok: true, data: this.core.remoteView() }, securityHeaders());
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'method', message: '请使用 POST' } }, securityHeaders({ allow: 'POST' }));
      return;
    }
    if (!this.core.isLoopbackRequest(req)) {
      this.logger.warn(`cloud admin blocked (${this.core.loopbackDeniedReason(req) || 'unknown'})`);
      drainRequest(req);
      sendJson(res, 403, { ok: false, error: { code: 'loopback_only', message: '仅可在电脑本机操作' } }, securityHeaders());
      return;
    }
    if (!this.csrfOk(req, url) && !(await this.formCsrfOk(req))) {
      sendJson(res, 403, { ok: false, error: { code: 'csrf', message: '请求来源校验失败，请刷新电脑上的配对页后重试' } }, securityHeaders());
      return;
    }
    const cloud = this.core.cloud;
    if (cloud === undefined) {
      sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: '远程访问未启用' } }, securityHeaders());
      return;
    }
    let result;
    try {
      if (action === 'rotate') {
        cloud.rotate();
        this.logger.info('cloud relay link rotated');
      } else if (action === 'broker') {
        // Runtime-only override: persisting it would mean rewriting the host's
        // cordis patch file, which is the operator's job, not the plugin's.
        const body = await readJsonBody(req, 8 * 1024);
        cloud.setBroker(body.broker);
        this.logger.info('cloud relay broker changed');
      } else if (action === 'toggle') {
        const enabled = cloud.setEnabled(cloud.enabled !== true);
        this.logger.info(`cloud relay ${enabled ? 'enabled' : 'paused'}`);
      } else {
        sendJson(res, 404, { ok: false, error: { code: 'not_found', message: '未知的远程操作' } }, securityHeaders());
        return;
      }
      result = cloud.status();
    } catch (error) {
      this.logger.error('cloud admin failed', error);
      sendJson(res, statusForError(error), { ok: false, error: { code: error?.code ?? 'internal', message: String(error?.message ?? error) } }, securityHeaders());
      return;
    }
    if (respondJson) {
      const { qrSvg: _qr, ...status } = result;
      sendJson(res, 200, { ok: true, data: status }, securityHeaders());
      return;
    }
    if (res.headersSent) return;
    res.writeHead(303, securityHeaders({ location: '/pair' }));
    res.end();
  }

  serveFile(req, res, file, { cache = 'no-store' } = {}) {
    const info = fileStat(file);
    if (info === undefined) {
      sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', securityHeaders());
      return;
    }
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(304, securityHeaders({ etag, 'cache-control': cache }));
      res.end();
      return;
    }
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(200, securityHeaders({
      'content-type': contentType(file),
      'content-length': info.size,
      'cache-control': cache,
      etag,
    }));
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).on('error', (error) => {
      this.logger.warn('static read failed', path.basename(file), error);
      try { res.destroy(); } catch { /* gone */ }
    }).pipe(res);
  }

  /**
   * 局域网路径上的 app-shell 版本戳。
   *
   * `web/sw.js` 里写的是 `__POCKET_BUILD__`，只有 `tools/build-shell.mjs` 会把它
   * 换成内容哈希 —— 而那条路只覆盖远端产物 `docs/`。局域网下 `web/` 是被直接
   * 读出来发的，于是手机上收到的缓存名永远是 `dsh-pocket-__POCKET_BUILD__`：
   * 名字不变，`activate` 就永远不清旧壳，插件的 web 层升级后用户可能停在旧前端。
   * 这里在响应时补一个哈希，覆盖 `web/` 下除 `sw.js` 自身以外的全部文件。
   */
  workerBuild() {
    if (this.webBuild !== undefined) return this.webBuild;
    const hash = createHash('sha256');
    const walk = (dir) => {
      let names;
      try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of names) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile() || entry.name === 'sw.js') continue;
        hash.update(path.relative(this.webRoot, full).split(path.sep).join('/'));
        try { hash.update(readFileSync(full)); } catch { /* 读不到就跳过 */ }
      }
    };
    walk(this.webRoot);
    this.webBuild = hash.digest('hex').slice(0, 16);
    return this.webBuild;
  }

  /** 把 worker 源码里的版本戳替换掉再发，其余静态文件仍走流式 serveFile。 */
  serveWorker(req, res, file) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      this.logger.warn('service worker read failed', error);
      sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', securityHeaders());
      return;
    }
    const body = Buffer.from(source.replaceAll('__POCKET_BUILD__', this.workerBuild()), 'utf8');
    const etag = `"w-${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(304, securityHeaders({ etag, 'cache-control': 'no-cache' }));
      res.end();
      return;
    }
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(200, securityHeaders({
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': body.length,
      // worker 必须每次回源，否则浏览器会一直用旧版本。
      'cache-control': 'no-cache',
      etag,
    }));
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(body);
  }

  serveFirstExisting(req, res, files, options) {    for (const file of files) {
      if (fileStat(file) !== undefined) {
        this.serveFile(req, res, file, options);
        return;
      }
    }
    sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8', securityHeaders());
  }

  serveDownload(req, res, relative) {
    // Installers are loopback-only: they are unauthenticated blobs, so exposing
    // them through the relay would be an open download endpoint.
    if (!this.core.isLoopbackRequest(req)) {
      this.logger.warn(`download blocked (${this.core.loopbackDeniedReason(req) || 'unknown'})`);
      drainRequest(req);
      sendJson(res, 403, { ok: false, error: { code: 'loopback_only', message: '安装包仅可在电脑上下载' } }, securityHeaders());
      return;
    }
    const safeRelative = relative.replace(/\\/gu, '/').replace(/^\/+/u, '');
    if (safeRelative.includes('..') || safeRelative.includes('\0')) {
      sendText(res, 400, 'Bad Request', 'text/plain; charset=utf-8', securityHeaders());
      return;
    }
    for (const dir of this.downloadDirs) {
      const file = safeJoin(dir, safeRelative);
      if (file === undefined) continue;
      const info = fileStat(file);
      if (info !== undefined && statSync(file).isFile()) {
        this.serveFile(req, res, file, { cache: 'no-store' });
        return;
      }
    }
    sendText(res, 404, '安装包尚未生成', 'text/plain; charset=utf-8', securityHeaders());
  }

  requireAuth(req, res, url, { allowQuery = false } = {}) {
    let token;
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) token = header.slice(7).trim();
    if (token === undefined && allowQuery) token = url.searchParams.get('token') ?? undefined;
    const device = this.core.authenticateToken(token);
    if (device === undefined) {
      const ip = clientIp(req);
      const limit = this.authLimiter.take(`auth:${ip}`, 40, 60_000);
      if (!limit.ok) {
        drainRequest(req);
        sendJson(res, 429, { ok: false, error: { code: 'rate_limited', message: '尝试过于频繁，请稍后再试' } }, securityHeaders({ 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) }));
        return undefined;
      }
      drainRequest(req);
      sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: '未授权：请先登录' } }, securityHeaders());
      return undefined;
    }
    this.core.state.touchDevice(device.id, clientIp(req));
    return device;
  }

  /** 当前账号视图：只有账号与两个布尔；口令、盐、哈希绝不进这个对象。 */
  accountView() {
    const auth = this.core.auth;
    const user = typeof auth?.user === 'string' && auth.user.length > 0 ? auth.user : null;
    return {
      user,
      configured: auth?.configured === true,
      required: auth === undefined ? this.core.config.authRequired === true : auth.required === true,
    };
  }

  /**
   * 账号 + 口令：GET 读当前账号，POST 改账号与口令。
   *
   * 改口令是整个插件最敏感的写操作，所以三道闸叠在一起：
   *   1. `requireLoopback(..., { write: true })`：回环 socket + 本机 Host + Origin/Sec-Fetch-Site；
   *   2. 再**强制**校验一次 `x-pocket-csrf`：本仓的 `csrfOk` 在「浏览器完全没带信号」时会
   *      退回「是回环就放行」（那条分支是给本机 CLI 的），改口令不能走这条旁路；
   *   3. 写盘只有 scrypt 哈希，日志只有账号与结果 —— 口令与哈希从不出现。
   */
  async handleAccount(req, res, url) {
    const auth = this.core.auth;
    if (req.method === 'GET') {
      if (!this.requireLoopback(req, res, url)) return;
      sendJson(res, 200, { ok: true, data: this.accountView() }, securityHeaders());
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'method', message: '请使用 GET 或 POST' } }, securityHeaders({ allow: 'GET, POST' }));
      return;
    }
    if (!this.requireLoopback(req, res, url, { write: true })) return;

    const token = req.headers?.['x-pocket-csrf'] ?? url.searchParams.get('csrf');
    if (typeof token !== 'string' || token.length === 0 || !safeEqual(token, this.core.csrfToken)) {
      drainRequest(req);
      this.logger.warn('账号口令修改被拒：缺少或不匹配的 CSRF 令牌');
      sendJson(res, 403, { ok: false, error: { code: 'csrf', message: '请求来源校验失败，请刷新电脑上的配对页后重试' } }, securityHeaders());
      return;
    }

    if (auth === undefined) {
      drainRequest(req);
      sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: '口令组件未就绪，暂时不能在本页改口令' } }, securityHeaders());
      return;
    }

    let body;
    try {
      // 复用现有的 readJsonBody（同一个 8KiB 预算；改口令的请求体只有两个字段）。
      body = await readJsonBody(req, 8 * 1024);
    } catch (error) {
      sendJson(res, statusForError(error), { ok: false, error: { code: error?.code ?? 'bad_request', message: '请求格式不正确' } }, securityHeaders());
      return;
    }

    const check = validateCredentials({ user: body.user, password: body.password });
    if (!check.ok) {
      this.logger.warn(`账号口令未修改：${check.reason}`);
      sendJson(res, 400, { ok: false, error: { code: 'invalid_credentials', message: check.reason } }, securityHeaders());
      return;
    }

    try {
      writeCredentials(auth.credentialsFile, { user: check.user, password: body.password });
    } catch (error) {
      // 原子写失败 = 旧 auth.json 完好：不碰会话、不 reload，用户还能用旧口令进来。
      this.logger.error(`账号口令写入失败（旧口令仍然有效）：${error?.message ?? error}`);
      sendJson(res, 500, { ok: false, error: { code: 'write_failed', message: '口令写入失败，旧口令仍然有效；请重试，或查看 DSH 日志' } }, securityHeaders());
      return;
    }

    let sessionsCleared = true;
    try {
      clearSessions(auth.sessionsFile);
    } catch (error) {
      // 删不掉就退一步：内存里全部作废并落一个空 sessions.json，绝不能让旧令牌活着。
      this.logger.error(`旧会话文件删除失败，改为全部作废：${error?.message ?? error}`);
      try {
        auth.revokeAll();
      } catch (nested) {
        sessionsCleared = false;
        this.logger.error('旧会话作废失败', nested);
      }
    }
    // 让内存里的账号 / 哈希立刻变成刚写下的那一份，不必等 maybeReload 的 mtime 探测。
    auth.reload();

    if (!sessionsCleared) {
      this.logger.error(`账号口令已更新但旧会话未清空：账号=${check.user}`);
      sendJson(res, 500, { ok: false, error: { code: 'session_reset_failed', message: '口令已更新，但旧会话没能清空；请立即重启 DSH 并检查数据目录权限' } }, securityHeaders());
      return;
    }

    // 审计日志只有账号与结果。口令、盐、哈希一律不进日志。
    this.logger.info(`账号口令已更新：账号=${check.user}，全部手机会话已清空（需用新口令重新登录）`);
    const relayState = this.restartRelayAfterAuthChange();
    sendJson(res, 200, {
      ok: true,
      data: { user: check.user, sessionsCleared: true, relayState },
    }, securityHeaders());
  }

  /**
   * 改完口令后补拉中继：blocked / unconfigured / error 都是「现在没跑」，而刚刚
   * 补上的口令很可能正是它缺的那块。失败只记日志 —— 口令已经改好，不能因此回 500。
   */
  restartRelayAfterAuthChange() {
    const cloud = this.core.cloud;
    if (cloud === undefined) return 'disabled';
    const state = String(cloud.state ?? '');
    if (state !== 'blocked' && state !== 'unconfigured' && state !== 'error') return state;
    try {
      // 先 stop 再 start：不依赖 start 的幂等性，也顺手丢掉上次失败留下的半条链路。
      cloud.stop();
      cloud.start(this.core.port);
    } catch (error) {
      this.logger.error('改口令后启动中继失败（口令已生效，可刷新配对页重试）', error);
    }
    return String(this.core.cloud?.state ?? 'error');
  }

  async handleApi(req, res, url, route) {
    const method = req.method ?? 'GET';
    const ip = clientIp(req);

    // CLI aliases: `dsh-pocket status/broker` talk to /api/v1/cloud/*, the
    // desktop pairing page uses /cloud/*. One implementation, two mounts.
    if (route === '/cloud/status' || route === '/cloud/rotate'
      || route === '/cloud/toggle' || route === '/cloud/broker') {
      await this.handleCloudAdmin(req, res, route.slice('/cloud/'.length), { respondJson: true });
      return;
    }

    if (route === '/hello' && method === 'GET') {
      // Unauthenticated and cheap: no QR generation, no address probing.
      const limit = this.helloLimiter.take(`hello:${ip}`, 120, 60_000);
      if (!limit.ok) {
        sendJson(res, 429, { ok: false, error: { code: 'rate_limited', message: '请求过于频繁' } }, securityHeaders({ 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) }));
        return;
      }
      sendJson(res, 200, {
        ok: true,
        data: {
          ...this.core.helloView(),
          requiresLogin: true,
          time: nowMs(),
        },
      }, securityHeaders());
      return;
    }

    if (route === '/health' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: this.core.publicStatus() }, securityHeaders());
      return;
    }

    if (route === '/devices' && method === 'GET') {
      if (!this.requireLoopback(req, res, url)) return;
      sendJson(res, 200, { ok: true, data: { devices: this.core.devicesView() } }, securityHeaders());
      return;
    }

    const deviceRoute = route.match(/^\/devices\/([^/]+)\/revoke$/u);
    if (deviceRoute !== null) {
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method', message: '请使用 POST' } }, securityHeaders({ allow: 'POST' }));
        return;
      }
      if (!this.requireLoopback(req, res, url, { write: true })) return;
      let id;
      try { id = decodeURIComponent(deviceRoute[1]); } catch { id = deviceRoute[1]; }
      const ok = this.core.revokeDevice(id);
      sendJson(res, ok ? 200 : 404, ok
        ? { ok: true, data: { revoked: true } }
        : { ok: false, error: { code: 'not_found', message: '设备不存在' } }, securityHeaders());
      return;
    }

    if (route === '/account') {
      // 账号 + 口令：回环页面的读写入口。必须在 requireAuth 之前分流——
      // 它的凭据是「本机回环 + CSRF」，不是手机设备令牌。
      await this.handleAccount(req, res, url);
      return;
    }

    if (route === '/events' && method === 'GET') {
      const device = this.requireAuth(req, res, url, { allowQuery: true });
      if (device === undefined) return;
      this.openSse(req, res, device, url);
      return;
    }

    const device = this.requireAuth(req, res, url);
    if (device === undefined) return;

    if (route === '/me' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        data: {
          device: this.core.deviceView(device),
          server: this.core.serverInfo(),
          stats: this.core.status(),
          model: this.core.defaultModelView(),
        },
      }, securityHeaders());
      return;
    }

    if (route === '/self/revoke' && method === 'POST') {
      this.core.revokeDevice(device.id);
      sendJson(res, 200, { ok: true, data: { revoked: true } }, securityHeaders());
      return;
    }

    if (route === '/ws-ticket' && method === 'POST') {
      sendJson(res, 200, { ok: true, data: this.core.createWsTicket(device) }, securityHeaders());
      return;
    }

    if (route === '/tasks' && method === 'GET') {
      const filter = url.searchParams.get('filter') ?? 'all';
      const q = url.searchParams.get('q') ?? '';
      const includeSubagents = url.searchParams.get('subagents') === '1';
      const limit = Number(url.searchParams.get('limit') ?? 300);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const data = this.core.index.snapshot({ filter, q, includeSubagents, limit, offset });
      sendJson(res, 200, { ok: true, data: { ...data, summary: this.core.index.summary() } }, securityHeaders());
      return;
    }

    if (route === '/tasks' && method === 'POST') {
      const limit = this.createLimiter.take(`create:${device.id}`, 20, 60_000);
      if (!limit.ok) {
        drainRequest(req);
        sendJson(res, 429, { ok: false, error: { code: 'rate_limited', message: '创建任务过于频繁，请稍后再试' } }, securityHeaders({ 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) }));
        return;
      }
      let body;
      try {
        body = await readJsonBody(req, MAX_BODY);
      } catch (error) {
        sendJson(res, statusForError(error), {
          ok: false,
          error: { code: error.code ?? 'bad_request', message: error.code === 'body_too_large' ? '内容过大' : '请求格式不正确' },
        }, securityHeaders());
        return;
      }
      try {
        const result = await this.core.index.createTask({
          prompt: body.prompt,
          cwd: body.cwd,
          preset: body.preset,
          clientTaskId: body.clientTaskId,
          source: 'mobile',
        });
        sendJson(res, result.reused ? 200 : 201, { ok: true, data: result }, securityHeaders());
      } catch (error) {
        sendJson(res, statusForError(error), { ok: false, error: { code: error.code ?? 'create_failed', message: error.message } }, securityHeaders());
      }
      return;
    }

    const taskRoute = route.match(/^\/tasks\/([^/]+)(?:\/(prompt|cancel))?$/u);
    if (taskRoute !== null) {
      let id;
      try { id = decodeURIComponent(taskRoute[1]); } catch { id = taskRoute[1]; }
      const action = taskRoute[2];
      if (action === undefined && method === 'GET') {
        // 分页：`?before=<消息 id>` 往更早翻；`?after=<消息 id>` 只要之后的（流式增量）。
        // 不带参数就是首屏的尾部窗口。校验字符集是为了不让任意长串进日志/进 findIndex；
        // 上限 120 与实际消息 id 的长度（`u-12` / `t-c<n>` / `m-<seq>`）相比足够宽松。
        const before = String(url.searchParams.get('before') ?? '');
        const after = String(url.searchParams.get('after') ?? '');
        const cursorOk = (value) => value.length <= 120
          && (value.length === 0 || /^[A-Za-z0-9_:.-]+$/u.test(value));
        if (!cursorOk(before) || !cursorOk(after)) {
          sendJson(res, 400, { ok: false, error: { code: 'bad_cursor', message: '分页游标不合法' } }, securityHeaders());
          return;
        }
        const limitRaw = Number(url.searchParams.get('limit') ?? 0);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;
        try {
          const detail = await this.core.index.detail(id, { before, after, limit });
          sendJson(res, 200, { ok: true, data: shapeDetailResponse(detail, { incremental: after.length > 0 }) }, securityHeaders());
        } catch (error) {
          sendJson(res, statusForError(error), { ok: false, error: { code: error.code ?? 'read_failed', message: error.message } }, securityHeaders());
        }
        return;
      }
      if (action === 'prompt' && method === 'POST') {
        let body;
        try {
          body = await readJsonBody(req, MAX_BODY);
        } catch (error) {
          sendJson(res, statusForError(error), { ok: false, error: { code: error.code ?? 'bad_request', message: '请求格式不正确' } }, securityHeaders());
          return;
        }
        try {
          const task = await this.core.index.promptTask(id, body.prompt, { source: 'mobile' });
          sendJson(res, 200, { ok: true, data: { task } }, securityHeaders());
        } catch (error) {
          sendJson(res, statusForError(error), { ok: false, error: { code: error.code ?? 'prompt_failed', message: error.message } }, securityHeaders());
        }
        return;
      }
      if (action === 'cancel' && method === 'POST') {
        try {
          const task = await this.core.index.cancelTask(id);
          sendJson(res, 200, { ok: true, data: { task } }, securityHeaders());
        } catch (error) {
          sendJson(res, statusForError(error), { ok: false, error: { code: error.code ?? 'cancel_failed', message: error.message } }, securityHeaders());
        }
        return;
      }
    }

    if (route === '/workspaces' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: { workspaces: await this.core.index.workspaces() } }, securityHeaders());
      return;
    }

    if (route === '/presets' && method === 'GET') {
      const presets = await this.core.index.presets();
      sendJson(res, 200, { ok: true, data: { ...presets, model: this.core.defaultModelView() } }, securityHeaders());
      return;
    }

    if (route === '/stats' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: this.core.status() }, securityHeaders());
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'not_found', message: '接口不存在' } }, securityHeaders());
  }

  openSse(req, res, device, url) {
    const perDevice = this.sseClients.get(device.id)?.size ?? 0;
    if (this.allSse.size >= MAX_SSE_CLIENTS || perDevice >= MAX_SSE_PER_DEVICE) {
      sendJson(res, 503, { ok: false, error: { code: 'too_many_streams', message: '事件连接过多，请关闭其他页面后重试' } }, securityHeaders({ 'retry-after': '5' }));
      return;
    }
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(200, securityHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    }));
    const client = { res, deviceId: device.id, closed: false, cleanup: () => {} };
    let bucket = this.sseClients.get(device.id);
    if (bucket === undefined) {
      bucket = new Set();
      this.sseClients.set(device.id, bucket);
    }
    bucket.add(client);
    this.allSse.add(client);

    res.write('retry: 3000\n\n');
    const send = (frame) => {
      if (client.closed) return;
      if (res.writableLength > MAX_STREAM_BUFFER) {
        this.logger.warn('sse client is not reading its stream, closing it');
        this.closeSse(client, true);
        return;
      }
      try {
        res.write(`id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      } catch {
        this.closeSse(client, true);
      }
    };
    send({ type: 'hello', seq: this.core.seq, at: nowMs(), payload: { device: this.core.deviceView(device), server: this.core.serverInfo() } });
    const since = url.searchParams.get('since');
    for (const frame of this.core.replay(since)) send(frame);
    const unsubscribe = this.core.subscribe(send);
    const heartbeat = setInterval(() => {
      if (client.closed) return;
      if (res.writableLength > MAX_STREAM_BUFFER) {
        this.closeSse(client, true);
        return;
      }
      try { res.write(': ping\n\n'); } catch { this.closeSse(client, true); }
    }, 20_000);
    heartbeat.unref?.();
    client.cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    const close = () => this.closeSse(client, false);
    req.on('close', close);
    req.on('error', close);
    res.on('close', close);
    res.on('error', close);
  }

  closeSse(client, destroy) {
    if (client.closed) return;
    client.closed = true;
    this.allSse.delete(client);
    const bucket = this.sseClients.get(client.deviceId);
    if (bucket !== undefined) {
      bucket.delete(client);
      if (bucket.size === 0) this.sseClients.delete(client.deviceId);
    }
    try { client.cleanup(); } catch { /* already cleaned */ }
    if (destroy) {
      try { client.res.destroy(); } catch { /* gone */ }
    } else {
      try { client.res.end(); } catch { /* gone */ }
    }
  }

  /** Called by `core.revokeDevice` / `core.removeDevice`. */
  disconnectDevice(deviceId) {
    const entries = this.wsClients.get(deviceId);
    if (entries !== undefined) {
      this.wsClients.delete(deviceId);
      for (const entry of [...entries]) {
        try { entry.cleanup?.(); } catch { /* already cleaned */ }
        try { entry.socket.close(4001, 'device revoked'); } catch { /* gone */ }
        // Give the close frame a moment to flush before forcing the socket
        // down; `terminate()` immediately would turn 4001 into 1006.
        const kill = setTimeout(() => {
          try { entry.socket.terminate(); } catch { /* gone */ }
        }, 500);
        kill.unref?.();
      }
    }
    const bucket = this.sseClients.get(deviceId);
    if (bucket !== undefined) {
      this.sseClients.delete(deviceId);
      for (const client of [...bucket]) this.closeSse(client, true);
    }
  }

  wsCount() {
    let total = 0;
    for (const entries of this.wsClients.values()) total += entries.size;
    return total;
  }

  rejectUpgrade(socket, status, message) {
    try {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch { /* gone */ }
    try { socket.destroy(); } catch { /* gone */ }
  }

  onUpgrade(request, socket, head, wss) {
    this.stripRelayHeader(request);
    if (!this.core.hostAllowed(request.headers?.host)) {
      this.logger.warn(`rejected upgrade with untrusted Host header (${redactUrl(request.url)})`);
      this.rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    } catch {
      this.rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== '/ws') {
      this.rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const device = this.core.consumeWsTicket(url.searchParams.get('ticket'));
    if (device === undefined) {
      this.rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const perDevice = this.wsClients.get(device.id)?.size ?? 0;
    if (this.wsCount() >= MAX_WS_CLIENTS || perDevice >= MAX_WS_PER_DEVICE) {
      this.rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, device);
    });
  }

  onConnection(socket, request, device) {
    let bucket = this.wsClients.get(device.id);
    if (bucket === undefined) {
      bucket = new Set();
      this.wsClients.set(device.id, bucket);
    }
    const entry = { socket, cleanup: undefined };
    bucket.add(entry);
    socket.isAlive = true;

    const send = (frame) => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > MAX_STREAM_BUFFER) {
        this.logger.warn('ws client is not reading its stream, closing it');
        try { socket.terminate(); } catch { /* gone */ }
        return;
      }
      try { socket.send(JSON.stringify(frame)); } catch { /* closing */ }
    };
    send({
      type: 'hello',
      seq: this.core.seq,
      at: nowMs(),
      payload: {
        device: this.core.deviceView(device),
        server: this.core.serverInfo(),
        protocol: 1,
      },
    });
    let since;
    try { since = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('since'); } catch { since = null; }
    for (const frame of this.core.replay(since)) send(frame);
    const unsubscribe = this.core.subscribe(send);
    const heartbeat = setInterval(() => {
      if (socket.isAlive === false) {
        try { socket.terminate(); } catch { /* gone */ }
        return;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch { /* gone */ }
    }, 25_000);
    heartbeat.unref?.();
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString('utf8'));
        if (message?.type === 'ping') send({ type: 'pong', at: nowMs(), seq: this.core.seq, payload: {} });
        else if (message?.type === 'resync') send({ type: 'resync', at: nowMs(), seq: this.core.seq, payload: { summary: this.core.index.summary() } });
      } catch { /* ignore malformed client frames */ }
    });
    let cleaned = false;
    const close = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      bucket.delete(entry);
      if (bucket.size === 0) this.wsClients.delete(device.id);
    };
    entry.cleanup = close;
    socket.on('close', close);
    socket.on('error', close);
  }
}
