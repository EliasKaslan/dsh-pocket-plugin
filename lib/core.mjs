/**
 * Core state for the plugin: configuration, device registry, event fan-out and
 * the loopback trust decision. Everything the phone sees goes through the
 * encrypted relay; the HTTP server never leaves loopback.
 *
 * The HTTP server is deliberately a separate module so the auth logic
 * can be tested without sockets, and so a server crash cannot take the task
 * index down with it.
 */
import os from 'node:os';
import path from 'node:path';
import qrcode from './vendor/qrcode.mjs';
import { QrFileWriter, defaultQrFile } from './qr-file.mjs';
import { StateStore } from './state.mjs';
import { TaskIndex } from './task-index.mjs';
import {
  PLUGIN_VERSION, PROTOCOL_VERSION, RELAY_HEADER, RELAY_MARK, atomicWriteJson, b64url, clamp,
  ensureDir, hostHeaderName, isLoopback, isLoopbackHostname, isPlainObject, isValidIp,
  nowMs, oneLine, randomHex, randomId, randomToken, safeEqual, sha256,
} from './util.mjs';

export const DEFAULT_CONFIG = {
  port: 47901,
  serverName: '',
  allowedRoots: [],
  allowedHosts: [],
  showSeeded: false,
  dataDir: '',
  home: '',
  // 二维码落盘位置。空串 = 自动落到用户个人目录（~）下的固定文件名；
  // `false` = 不写文件。见 lib/qr-file.mjs。
  qrFile: '',
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
  // 设备数量不再有上限：电脑端无条件保存所有连过的设备。老配置里残留的
  // maxDevices 一律忽略（warn 一次），免得用户以为自己还设了个上限。
  if (input.maxDevices !== undefined) {
    logger?.warn('maxDevices 配置已废弃：设备数量不再有上限，已忽略');
  }
  delete config.maxDevices;
  config.allowedHosts = normalizeAllowedHosts(input.allowedHosts, logger);
  config.allowedRoots = normalizeAllowedRoots(input.allowedRoots, logger);
  // 二维码文件：只接受 `false`（关掉）、空串（自动）或一个明确路径。
  // 写成 `true` 一律按「自动」处理，免得用户以为能把文件塞进某个布尔开关里。
  if (input.qrFile === false) config.qrFile = false;
  else if (typeof input.qrFile === 'string' && input.qrFile.trim().length > 0) config.qrFile = path.resolve(input.qrFile.trim());
  else config.qrFile = '';
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

    // 二维码文件的唯一写入口。`config.qrFile === false` 时整体关掉（测试与
    // 无家目录环境用得上）；否则空串表示「用户个人目录下的固定文件名」。
    this.qrWriter = new QrFileWriter({
      file: this.config.qrFile === false ? false : (this.config.qrFile || defaultQrFile()),
      logger,
    });

    /**
     * Per-process relay marker. Only the in-process relay link may echo it;
     * the HTTP entry point strips the header from every inbound request and
     * remembers it in RELAY_MARK, so a phone cannot forge loopback trust.
     */
    this.relayHeaderName = RELAY_HEADER;
    this.relayNonce = randomHex(16);
    /**
     * 本次加载的实例标识。
     *
     * 插件的"热重载"= 在 DSH 里把这个 bundle 关掉再打开（不用重启 DSH）。每次
     * apply 都会 new 一个 BridgeCore，所以 bootId 会变 —— `health` 里带它之后，
     * "到底重载成功没有" 不用猜，比一次即可。
     */
    this.bootId = randomHex(4);
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
    // 口令组件由组装方（lib/index.mjs）创建后交回来：HTTP 层要能读当前账号、
    // 改完口令就地 reload。core 自己 new 一个会变成第二份真相（required、日志、
    // 文件路径都可能不一致），所以只持有引用。
    this._auth = undefined;
    this.port = this.config.port;
    // 只有回环地址；真正的对外通路是中继，不在这里体现。
    this.baseUrl = '';
    this.started = false;
    this.startPromise = undefined;
    this.startedAt = 0;
    this.lastError = undefined;
    this.hostsCache = undefined;
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

  /**
   * 把已经创建好的 Auth 交给 core：server 的 /api/v1/account 用它读账号、
   * 改口令后 reload，中继用它校验登录。传 undefined 等于「没有口令组件」，
   * 调用方必须按未配置处理，绝不 fail-open。
   */
  attachAuth(auth) {
    this._auth = auth ?? undefined;
    return this._auth;
  }

  /** 只读引用：未组装时是 undefined，调用方自己兜底。 */
  get auth() {
    return this._auth;
  }

  /**
   * Issue a device token without a password. Only reachable from the
   * loopback admin surface: the relay needs a credential bound to this host and
   * revocable from the same list as scanned phones.
   */
  mintDevice({ name = '远程中继', platform = 'relay', appVersion = '' } = {}) {
    // 与 pair()/provisionDevice() 一致：不检查数量，也不再有「名额满」这个错误码。
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
  provisionDevice({ name, platform, appVersion = '', ip = 'relay', token, installId } = {}) {
    const cleanName = oneLine(name || '手机', 48) || '手机';
    const cleanPlatform = oneLine(platform || 'relay', 24) || 'relay';
    if (typeof token === 'string' && token.length > 0) {
      const existing = this.authenticateToken(token);
      // 传了令牌却认不出来（被吊销/伪造）：返回 null，绝不顺手补发一台。
      // 这条保险必须在 core 层，不能只靠 CloudLink.provisionFor 的 if。
      return existing === undefined ? null : { token, device: this.deviceView(existing) };
    }

    // 身份判据的优先级：手机自报的安装标识 > 回落到「同名同平台」。
    //
    // 只用 name+platform 会让所有手机塌成同一台（外壳恒发「手机 / web」），
    // 第二台一登录就把第一台顶掉。安装标识由手机本地生成并持久化，是唯一
    // 能区分「同一台手机重连」与「另一台手机」的东西。
    //
    // **给了标识就只认标识**：标识查不到就是一台新手机。如果这时还回落到
    // name+platform，第二台手机依然会把第一台顶掉 —— 回落只在「客户端根本
    // 没能力自报标识」时才有意义。
    const byInstall = this.state.findDeviceByInstallId(installId);
    const sameDevice = typeof installId === 'string' && installId.length > 0
      ? byInstall
      : this.devicesView().find(
        (device) => device.name === cleanName && device.platform === cleanPlatform,
      );
    // 这里以前是「不同机且已达上限就抛错」。上限已彻底取消，
    // 新手机直接登记；同一台手机（同安装标识）仍然走下面的原地轮换。
    const fresh = randomToken('dshb_');
    const device = this.state.addDevice({
      id: sameDevice?.id ?? randomId('dev_'),
      name: cleanName,
      platform: cleanPlatform,
      appVersion: oneLine(appVersion, 24),
      tokenHash: sha256(fresh),
      ip,
      installId,
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
    // 「远程中继」是本机自己的凭据，不是一台手机。它只出现在设备列表里是为了
    // 让"吊销"这一类操作有统一的入口，但**从界面移除它没有任何安全收益**：
    // 它本身就在这台电脑上，移除只会让二维码的初始凭据失效、把你自己的手机
    // 搞得要重新登录。真正想让旧码作废的入口是「重置链接」。
    const target = this.state.devices.find((device) => device.id === id);
    if (target !== undefined && target.platform === 'relay') {
      this.logger.warn('拒绝移除本机中继设备：它不是手机；要让旧二维码作废请用「重置链接」');
      return false;
    }
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

  /** Unauthenticated status: no paths, no credentials, no error details. */
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
      // 每次 apply 都会变：用它确认「关掉再打开确实加载了新代码」。
      bootId: this.bootId,
      // 手机端唯一的进门方式是「账号 + 口令」，没有配对码这一步。
      requiresLogin: true,
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

  /**
   * 把当前中继链接同步到 `~/` 下那个固定 PNG。
   *
   * 复制 `remoteView()` 的逻辑不值得（那会顺带生成一份 300px 的 SVG），
   * 这里只读中继状态里的 `url`；链接没变时 QrFileWriter 自己会跳过写盘。
   *
   * @returns {{written: boolean, file: string, bytes: number}}
   */
  syncQrFile() {
    let url = '';
    try {
      url = typeof this.cloud?.status === 'function' ? (this.cloud.status().url ?? '') : '';
    } catch (error) {
      this.logger.warn('读取中继链接失败，二维码文件本轮不更新', error);
      return { written: false, file: this.qrWriter.file, bytes: 0 };
    }
    return this.qrWriter.sync(url);
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
