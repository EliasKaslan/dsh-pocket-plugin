/**
 * Core state for the plugin: configuration, pairing window, event fan-out and
 * the loopback trust decision. Everything the phone sees goes through the
 * encrypted relay; the HTTP server never leaves loopback.
 *
 * The HTTP server is deliberately a separate module so the pairing/auth logic
 * can be tested without sockets, and so a server crash cannot take the task
 * index down with it.
 */
import os from 'node:os';
import path from 'node:path';
import qrcode from './vendor/qrcode.mjs';
import { StateStore } from './state.mjs';
import { TaskIndex } from './task-index.mjs';
import {
  PLUGIN_VERSION, PROTOCOL_VERSION, RELAY_HEADER, RELAY_MARK, atomicWriteJson, b64url, clamp,
  ensureDir, hostHeaderName, isLoopback, isLoopbackHostname, isPlainObject, isValidIp,
  normalizeCode, nowMs, oneLine, pairingCode, randomHex, randomId, randomToken, safeEqual, sha256,
} from './util.mjs';

export const DEFAULT_CONFIG = {
  port: 47901,
  serverName: '',
  pairTtlMs: 10 * 60_000,
  maxDevices: 8,
  maxPairUses: 10,
  allowedRoots: [],
  allowedHosts: [],
  showSeeded: false,
  dataDir: '',
  home: '',
  // Fail closed: the relay is a public entry point, so a fresh install must set
  // a password before it can be reached from the internet. The relay is the
  // only path, so this gate is what stands between the internet and the host.
  authRequired: true,
};

const LOOPBACK_HOST = '127.0.0.1';

const DEFAULT_SERVER_NAME = '我的电脑';
const MAX_ALLOWED_ROOTS = 64;
const MAX_ALLOWED_HOSTS = 32;

export function defaultHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/** Resolve the two directories before any logger or store exists. */
export function resolvePaths(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const home = typeof input.home === 'string' && input.home.trim().length > 0
    ? path.resolve(input.home.trim())
    : defaultHome();
  const dataDir = typeof input.dataDir === 'string' && input.dataDir.trim().length > 0
    ? path.resolve(input.dataDir.trim())
    : path.join(home, 'pocket');
  return { home, dataDir };
}

function sanitizeServerName(value) {
  if (typeof value !== 'string') return '';
  // Control characters would end up in HTTP headers and in the phone UI.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned.slice(0, 64);
}

function normalizeAllowedHosts(value, logger) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = hostHeaderName(item);
    if (name === undefined || name.length === 0 || name.length > 253) {
      logger?.warn('allowedHosts 里有无法识别的主机名，已忽略');
      continue;
    }
    if (!/^[a-z0-9._:[\]-]+$/iu.test(name)) {
      logger?.warn('allowedHosts 里有包含非法字符的主机名，已忽略');
      continue;
    }
    if (!result.includes(name.toLowerCase())) result.push(name.toLowerCase());
    if (result.length >= MAX_ALLOWED_HOSTS) break;
  }
  return result;
}

function normalizeAllowedRoots(value, logger) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) continue;
    if (item.includes('\0')) {
      logger?.warn('allowedRoots 里有非法路径，已忽略');
      continue;
    }
    const resolved = path.resolve(item.trim());
    if (!result.includes(resolved)) result.push(resolved);
    if (result.length >= MAX_ALLOWED_ROOTS) {
      logger?.warn(`allowedRoots 最多 ${MAX_ALLOWED_ROOTS} 项，其余已忽略`);
      break;
    }
  }
  return result;
}

export function normalizeConfig(raw, logger) {
  const input = isPlainObject(raw) ? raw : {};
  const config = { ...DEFAULT_CONFIG, ...input };
  const configuredPort = Number(input.port);
  config.port = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
    ? configuredPort
    : DEFAULT_CONFIG.port;
  config.pairTtlMs = clamp(input.pairTtlMs ?? DEFAULT_CONFIG.pairTtlMs, 60_000, 24 * 60 * 60_000);
  config.maxDevices = Math.floor(clamp(input.maxDevices ?? DEFAULT_CONFIG.maxDevices, 1, 32));
  config.maxPairUses = Math.floor(clamp(input.maxPairUses ?? DEFAULT_CONFIG.maxPairUses, 1, 100));
  config.showSeeded = input.showSeeded === true;
  config.serverName = sanitizeServerName(input.serverName);

  // 只监听回环：host 不再是可配项。老配置里残留的 host 会被忽略，
  // 免得用户以为自己还能通过改配置把面板暴露到局域网。
  if (input.host !== undefined && input.host !== '') {
    logger?.warn('host 配置已废弃：插件只监听 127.0.0.1，局域网直连已移除（请用加密中继）');
  }
  // 透传会把旧键原样留在 config 上，看着像「配了但没生效」。这里显式删掉。
  delete config.host;
  delete config.publicBaseUrl;
  config.allowedHosts = normalizeAllowedHosts(input.allowedHosts, logger);
  config.allowedRoots = normalizeAllowedRoots(input.allowedRoots, logger);
  // Fail closed: DEFAULT_CONFIG.authRequired is true, and an unset config must
  // keep that value. Only an explicit `false` turns the gate off — writing
  // `input.authRequired === true || ...` here would silently flip the default
  // to false, and the relay refuses to start without this gate, so the whole
  // cross-network feature would go dark on a default install.
  const explicitAuthRequired = input.authRequired ?? (isPlainObject(input.auth) ? input.auth.required : undefined);
  config.authRequired = explicitAuthRequired === undefined
    ? DEFAULT_CONFIG.authRequired
    : explicitAuthRequired !== false;
  return config;
}

export function qrSvg(text, { size = 300, margin = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const total = count + margin * 2;
  const rects = [];
  for (let row = 0; row < count; row += 1) {
    let start = -1;
    for (let col = 0; col <= count; col += 1) {
      const dark = col < count && qr.isDark(row, col);
      if (dark && start < 0) start = col;
      if (!dark && start >= 0) {
        rects.push(`<rect x="${start + margin}" y="${row + margin}" width="${col - start}" height="1"/>`);
        start = -1;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="配对二维码"><rect width="${total}" height="${total}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
}

export class BridgeCore {
  constructor(ctx, rawConfig, logger) {
    this.ctx = ctx;
    this.logger = logger;
    this.config = normalizeConfig(rawConfig, logger);
    const paths = resolvePaths(this.config);
    this.home = paths.home;
    this.dataDir = paths.dataDir;
    ensureDir(this.dataDir);
    this.state = new StateStore(this.dataDir, logger).load();
    this.fingerprint = this.state.installFingerprint();

    /**
     * Per-process relay marker. Only the in-process relay link may echo it;
     * the HTTP entry point strips the header from every inbound request and
     * remembers it in RELAY_MARK, so a phone cannot forge loopback trust.
     */
    this.relayHeaderName = RELAY_HEADER;
    this.relayNonce = randomHex(16);
    /** CSRF token for loopback-only forms and admin POSTs. */
    this.csrfToken = randomHex(16);

    this.services = {};
    this.index = new TaskIndex({
      logger,
      emit: (type, payload) => this.emit(type, payload),
      state: this.state,
      config: this.config,
      services: this.services,
      home: this.home,
      dataDir: this.dataDir,
    });
    this.listeners = new Set();
    this.wsTickets = new Map();
    this.ring = [];
    this.seq = 0;
    this.server = undefined;
    this.cloud = undefined;
    this.port = this.config.port;
    // 只有回环地址；真正的对外通路是中继，不在这里体现。
    this.baseUrl = '';
    this.started = false;
    this.startPromise = undefined;
    this.startedAt = 0;
    this.lastError = undefined;
    this.hostsCache = undefined;
    this.ensurePairing();
  }

  get serverName() {
    return this.config.serverName.length > 0 ? this.config.serverName : DEFAULT_SERVER_NAME;
  }

  bindService(name, service) {
    if (service === undefined || service === null) return;
    this.services[name] = service;
    this.index.setServices(this.services);
    if (this.started) this.emit('bridge.status', this.status());
  }

  setServer(server) {
    this.server = server;
  }

  setCloud(cloud) {
    this.cloud = cloud;
  }

  ensurePairing() {
    const current = this.state.pairing;
    if (current !== null && typeof current.code === 'string' && current.expiresAt > nowMs()) return current;
    return this.rotatePairing();
  }

  rotatePairing() {
    const pairing = {
      code: pairingCode(),
      createdAt: nowMs(),
      expiresAt: nowMs() + this.config.pairTtlMs,
      uses: 0,
    };
    this.state.setPairing(pairing);
    this.emit('pairing', { expiresAt: pairing.expiresAt });
    return pairing;
  }

  /** Read-only pairing surface. Callers that may rotate call `ensurePairing()`. */
  pairingView() {
    const pairing = this.state.pairing;
    if (pairing === null || typeof pairing.code !== 'string') {
      return {
        available: false,
        code: '',
        createdAt: 0,
        expiresAt: 0,
        ttlMs: this.config.pairTtlMs,
        uses: 0,
        maxUses: this.config.maxPairUses,
        // 设备上限跟着配对视图一起下发，别再让 CLI/界面各自硬编码一个数字。
        maxDevices: this.config.maxDevices,
        fingerprint: this.fingerprint,
      };
    }
    return {
      available: true,
      code: pairing.code,
      createdAt: pairing.createdAt,
      expiresAt: pairing.expiresAt,
      ttlMs: this.config.pairTtlMs,
      uses: pairing.uses ?? 0,
      maxUses: this.config.maxPairUses,
      maxDevices: this.config.maxDevices,
      fingerprint: this.fingerprint,
    };
  }

  pair({ code, deviceId, name, platform, appVersion, ip }) {
    const pairing = this.state.pairing;
    if (pairing === null || typeof pairing.code !== 'string') {
      const error = new Error('配对窗口已关闭，请在电脑上重新生成二维码');
      error.code = 'pairing_closed';
      throw error;
    }
    if (pairing.expiresAt <= nowMs()) {
      this.state.clearPairing();
      const error = new Error('二维码已过期，请在电脑上刷新');
      error.code = 'pairing_expired';
      throw error;
    }
    if ((pairing.uses ?? 0) >= this.config.maxPairUses) {
      this.state.clearPairing();
      const error = new Error('配对次数已达上限，请在电脑上刷新二维码');
      error.code = 'pairing_exhausted';
      throw error;
    }
    const supplied = normalizeCode(code);
    const expected = normalizeCode(pairing.code);
    if (supplied.length === 0 || !safeEqual(supplied, expected)) {
      const error = new Error('配对码不正确');
      error.code = 'pairing_invalid';
      throw error;
    }
    if (this.devicesView().length >= this.config.maxDevices) {
      const error = new Error('已配对设备达到上限，请先在电脑上移除旧设备');
      error.code = 'device_limit';
      throw error;
    }
    const token = randomToken('dshb_');
    let id = typeof deviceId === 'string' && /^[A-Za-z0-9_-]{6,64}$/u.test(deviceId) ? deviceId : randomId('dev_');
    if (this.state.devices.some((device) => device.id === id && device.revoked !== true)) {
      // A re-pair rotates the token for the same device, which is what users
      // expect after clearing app data.
      id = randomId('dev_');
    }
    const device = this.state.addDevice({
      id,
      name: oneLine(name || '手机', 48),
      platform: oneLine(platform || 'unknown', 24),
      appVersion: oneLine(appVersion || '', 24),
      tokenHash: sha256(token),
      ip,
    });
    pairing.uses = (pairing.uses ?? 0) + 1;
    this.state.setPairing(pairing);
    // Never log the token itself; the id is enough for support.
    this.logger.info(`paired device ${device.id} (${device.name})`);
    this.emit('devices.changed', this.devicesView());
    return { token, device: this.deviceView(device) };
  }

  /**
   * Issue a device token without a pairing code. Only reachable from the
   * loopback admin surface: the relay needs a credential bound to this host and
   * revocable from the same list as scanned phones.
   */
  mintDevice({ name = '远程中继', platform = 'relay', appVersion = '' } = {}) {
    if (this.devicesView().length >= this.config.maxDevices) {
      const error = new Error('已配对设备达到上限，请先在电脑上移除旧设备');
      error.code = 'device_limit';
      throw error;
    }
    const token = randomToken('dshb_');
    const device = this.state.addDevice({
      id: randomId('dev_'),
      name: oneLine(name, 48),
      platform: oneLine(platform, 24),
      appVersion: oneLine(appVersion, 24),
      tokenHash: sha256(token),
      ip: 'relay',
    });
    this.logger.info(`minted relay device ${device.id}`);
    this.emit('devices.changed', this.devicesView());
    return { token, device: this.deviceView(device) };
  }

  /**
   * 登录即配对：口令校验通过后直接给这台手机发设备令牌。
   *
   * 以前要两步（口令登录 + 8 位配对码），对用户来说是两个说不清的 secret。
   * 同一台手机再次登录时复用同一个设备记录（addDevice 带同 id 会原地轮换
   * 令牌并清除吊销标记），所以不会每登录一次就多一台设备。
   */
  provisionDevice({ name, platform, appVersion = '', ip = 'relay', token } = {}) {
    const cleanName = oneLine(name || '手机', 48) || '手机';
    const cleanPlatform = oneLine(platform || 'relay', 24) || 'relay';
    if (typeof token === 'string' && token.length > 0) {
      const existing = this.authenticateToken(token);
      // 传了令牌却认不出来（被吊销/伪造）：返回 null，绝不顺手补发一台。
      // 这条保险必须在 core 层，不能只靠 CloudLink.provisionFor 的 if。
      return existing === undefined ? null : { token, device: this.deviceView(existing) };
    }

    const sameDevice = this.devicesView().find(
      (device) => device.name === cleanName && device.platform === cleanPlatform,
    );
    if (sameDevice === undefined && this.devicesView().length >= this.config.maxDevices) {
      const error = new Error('设备数量已达上限，请先在电脑上移除旧设备');
      error.code = 'device_limit';
      throw error;
    }
    const fresh = randomToken('dshb_');
    const device = this.state.addDevice({
      id: sameDevice?.id ?? randomId('dev_'),
      name: cleanName,
      platform: cleanPlatform,
      appVersion: oneLine(appVersion, 24),
      tokenHash: sha256(fresh),
      ip,
    });
    this.logger.info(`provisioned device ${device.id} (${device.name}) via password login`);
    this.emit('devices.changed', this.devicesView());
    return { token: fresh, device: this.deviceView(device) };
  }

  authenticateToken(token) {
    if (typeof token !== 'string' || token.length < 20) return undefined;
    return this.state.findDeviceByTokenHash(sha256(token));
  }

  deviceView(device) {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      appVersion: device.appVersion,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      lastIp: device.lastIp,
    };
  }

  devicesView() {
    return this.state.devices.filter((device) => device.revoked !== true).map((device) => this.deviceView(device));
  }

  revokeDevice(id) {
    const ok = this.state.revokeDevice(id);
    if (ok) {
      // Revocation must actually cut the wire, not just fail the next request.
      try { this.server?.disconnectDevice?.(id); } catch (error) { this.logger.warn('disconnect on revoke failed', error); }
      this.emit('devices.changed', this.devicesView());
    }
    return ok;
  }

  removeDevice(id) {
    const ok = this.state.removeDevice(id);
    if (ok) {
      try { this.server?.disconnectDevice?.(id); } catch (error) { this.logger.warn('disconnect on remove failed', error); }
      this.emit('devices.changed', this.devicesView());
    }
    return ok;
  }

  createWsTicket(device) {
    const now = nowMs();
    for (const [key, value] of this.wsTickets) if (value.expiresAt <= now) this.wsTickets.delete(key);
    if (this.wsTickets.size > 500) {
      const oldest = this.wsTickets.keys().next().value;
      if (oldest !== undefined) this.wsTickets.delete(oldest);
    }
    const ticket = randomId('wst_');
    const expiresAt = now + 60_000;
    this.wsTickets.set(ticket, { deviceId: device.id, expiresAt });
    return { ticket, expiresAt };
  }

  consumeWsTicket(ticket) {
    const key = String(ticket ?? '');
    const hit = this.wsTickets.get(key);
    if (hit === undefined) return undefined;
    this.wsTickets.delete(key);
    if (hit.expiresAt <= nowMs()) return undefined;
    return this.state.devices.find((item) => item.id === hit.deviceId && item.revoked !== true);
  }

  emit(type, payload) {
    this.seq += 1;
    const frame = { type, payload, seq: this.seq, at: nowMs() };
    this.ring.push(frame);
    if (this.ring.length > 400) this.ring.shift();
    for (const listener of this.listeners) {
      try { listener(frame); } catch (error) { this.logger.warn('event listener failed', error); }
    }
    return frame;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replay(since) {
    const value = Number(since);
    if (!Number.isFinite(value)) return [];
    return this.ring.filter((frame) => frame.seq > value);
  }

  /**
   * Hostnames accepted in the `Host` header. DNS rebinding works by pointing an
   * attacker-controlled name at 127.0.0.1, so the header must name this machine.
   */
  allowedHosts() {
    const now = nowMs();
    if (this.hostsCache !== undefined && now - this.hostsCache.at < 30_000) return this.hostsCache.set;
    const set = new Set(['localhost', '127.0.0.1', '[::1]']);
    try {
      const hostname = os.hostname().toLowerCase();
      if (hostname.length > 0) {
        set.add(hostname);
        set.add(`${hostname}.local`);
      }
    } catch { /* no hostname */ }
    for (const extra of this.config.allowedHosts) set.add(extra.toLowerCase());
    this.hostsCache = { at: now, set };
    return set;
  }

  hostAllowed(hostHeader) {
    const name = hostHeaderName(hostHeader);
    if (name === undefined) return false;
    const hosts = this.allowedHosts();
    if (isLoopbackHostname(name) || hosts.has(name)) return true;
    // `[::1]` and `::1` mean the same interface.
    return hosts.has(name.replace(/^\[|\]$/gu, ''));
  }

  /**
   * The single loopback-trust decision used by every loopback-only route:
   * a loopback socket *and* a Host header that names this machine, and never a
   * request that came in through the relay (the relay is the phone's channel).
   */
  isLoopbackRequest(req) {
    if (req === undefined || req === null) return false;
    if (req[RELAY_MARK] === true) return false;
    if (!isLoopback(req.socket?.remoteAddress)) return false;
    return this.hostAllowed(req.headers?.host);
  }

  /** Short reason for logs; never contains the Host value itself. */
  loopbackDeniedReason(req) {
    if (req?.[RELAY_MARK] === true) return 'relay';
    if (!isLoopback(req?.socket?.remoteAddress)) return 'remote';
    if (!this.hostAllowed(req?.headers?.host)) return 'host';
    return '';
  }

  status() {
    return {
      ready: this.index.ready,
      started: this.started,
      port: this.port,
      tasks: this.index.tasks.size,
      devices: this.devicesView().length,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      error: this.lastError,
      uptimeMs: this.startedAt === 0 ? 0 : nowMs() - this.startedAt,
      allowedRoots: this.index.allowedRootsStatus(),
      auth: { required: this.config.authRequired },
    };
  }

  /** Unauthenticated status: no paths, no pairing data, no error details. */
  publicStatus() {
    return {
      ok: true,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      started: this.started,
      ready: this.index.ready,
      // 实际监听端口（被占用时会顺延），免鉴权可见：它本来就是客户端刚连上的
      // 那个端口，写进响应只是让 CLI / 脚本不用再猜。
      port: this.port,
      uptimeMs: this.startedAt === 0 ? 0 : nowMs() - this.startedAt,
      requiresPairing: true,
    };
  }

  helloView() {
    return {
      name: this.serverName,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      platform: process.platform,
      fingerprint: this.fingerprint,
      features: ['tasks', 'create', 'prompt', 'cancel', 'workspaces', 'presets', 'ws', 'sse'],
      paired: this.devicesView().length > 0,
    };
  }

  serverInfo() {
    return {
      name: this.serverName,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      platform: process.platform,
      fingerprint: this.fingerprint,
      features: ['tasks', 'create', 'prompt', 'cancel', 'workspaces', 'presets', 'ws', 'sse'],
    };
  }

  defaultModelView() {
    const service = this.services.agentDefaultModel;
    if (service === undefined) return undefined;
    try {
      const selection = service.currentSelection?.() ?? service.current?.();
      if (selection === null || typeof selection !== 'object') return undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      };
    } catch {
      return undefined;
    }
  }

  /** Everything the desktop pairing page needs to render the remote card. */
  remoteView() {
    const cloud = this.cloud;
    if (cloud === undefined) {
      return {
        enabled: false,
        state: 'disabled',
        url: '',
        qrSvg: '',
        broker: '',
        phone: null,
        lastPhoneAt: 0,
        appBase: '',
        lastError: '',
        auth: { required: this.config.authRequired, configured: false, enabled: false },
      };
    }
    let status;
    try {
      status = cloud.status();
    } catch (error) {
      this.logger.warn('cloud status failed', error);
      status = { enabled: false, state: 'error', url: '', lastError: '中继状态不可用' };
    }
    return {
      ...status,
      qrSvg: typeof status.url === 'string' && status.url.length > 0
        ? qrSvg(status.url, { size: 360, margin: 2 })
        : '',
      auth: typeof cloud.authInfo === 'function' ? cloud.authInfo() : { required: this.config.authRequired, configured: false, enabled: false },
    };
  }

  async start() {
    if (this.started) return this.status();
    if (this.startPromise !== undefined) return this.startPromise;
    this.startPromise = this.startOnce();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async startOnce() {
    this.ensurePairing();
    // The task index starts even if the HTTP listener fails: the desktop page
    // must still be able to explain that the port is taken.
    void this.index.start();
    if (this.server === undefined) {
      this.started = true;
      this.startedAt = nowMs();
      this.lastError = 'HTTP 监听器未挂载，仅进程内可用';
      this.logger.warn('bridge server is not attached; HTTP disabled');
      this.emit('bridge.status', this.status());
      return this.status();
    }
    try {
      const actualPort = await this.server.listen(this.config.port, LOOPBACK_HOST);
      this.port = actualPort;
      this.baseUrl = `http://127.0.0.1:${actualPort}`;
      this.started = true;
      this.startedAt = nowMs();
      this.lastError = undefined;
      this.writeRuntime();
      this.logger.info(`bridge listening on 127.0.0.1:${actualPort}; pairing page http://127.0.0.1:${actualPort}/pair`);
      this.emit('bridge.status', this.status());
      return this.status();
    } catch (error) {
      // `started` must stay false so a later retry (or the next reload) can try
      // again; the previous code marked the bridge started before listening.
      this.started = false;
      this.lastError = String(error?.message ?? error);
      this.logger.error('bridge listen failed', error);
      this.emit('bridge.status', this.status());
      throw error;
    }
  }

  writeRuntime() {
    try {
      atomicWriteJson(path.join(this.dataDir, 'runtime.json'), {
        version: PLUGIN_VERSION,
        port: this.port,
        pairingUrl: `http://127.0.0.1:${this.port}/pair`,
        appUrl: `${this.baseUrl}/app`,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.warn('runtime file write failed', error);
    }
  }

  dispose() {
    this.index.dispose();
    this.listeners.clear();
    this.state.close();
    if (this.server !== undefined) this.server.close();
    this.started = false;
    this.startedAt = 0;
  }
}
