/**
 * In-process glue between the plugin and the relay transport in `cloud.mjs`.
 *
 * Everything here runs inside the DSH host process: no spawned helpers, no pid
 * files, no daemons. The only persisted state is the relay identity (room, key,
 * token), which is needed to keep the same QR code across restarts.
 *
 * Fail-closed rules:
 *   - no `cloud.appBase` -> the relay does not start (a QR without a shell is
 *     worthless, and a personal Pages default would be a supply-chain risk);
 *   - auth required but not configured -> the relay does not start;
 *   - the relay listens on nothing: it dials out to the broker.
 */
import path from 'node:path';
import { CloudLink, DEFAULT_APP_BASE, DEFAULT_BROKERS, createIdentity } from './cloud.mjs';
import { atomicWriteJson, isPlainObject, readJsonFile } from './util.mjs';

const IDENTITY_FILE = 'cloud.json';
/** `room` is a base64url 128-bit id, so it may contain `-` and `_`. */
const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/u;
const KEY_RE = /^[A-Za-z0-9_-]{40,64}$/u;
const BROKER_RE = /^(?:wss?|mqtts?|tls?):\/\/[^\s/]+/iu;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBrokers(value) {
  const list = Array.isArray(value) ? value : [value];
  const result = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const broker = item.trim();
    if (broker.length === 0) continue;
    if (!BROKER_RE.test(broker)) continue;
    if (!result.includes(broker)) result.push(broker);
    if (result.length >= 4) break;
  }
  return result.length > 0 ? result : [...DEFAULT_BROKERS];
}

function normalizeAppBase(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return DEFAULT_APP_BASE;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username.length > 0 || url.password.length > 0) return '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class CloudService {
  constructor(core, { logger, dataDir, config, auth, authRequired = false }) {
    this.core = core;
    this.logger = logger;
    this.file = path.join(dataDir, IDENTITY_FILE);
    const cloud = isPlainObject(config) ? config : {};
    this.config = {
      enabled: cloud.enabled !== false,
      appBase: normalizeAppBase(cloud.appBase),
      broker: normalizeBrokers(cloud.broker),
      allowAnonymous: cloud.allowAnonymous === true,
    };
    /** @type {import('./auth.mjs').Auth|undefined} */
    this.auth = auth;
    this.authRequired = authRequired === true;
    this.link = undefined;
    this.identity = undefined;
    this.port = 0;
    this.enabled = false;
    this.state = this.config.enabled ? 'idle' : 'disabled';
    this.lastError = '';
    this.warnedOnce = false;
    core.setCloud(this);
  }

  get appBase() {
    return this.config.appBase;
  }

  /** Reject a broken identity file loudly instead of silently re-pairing. */
  loadIdentity() {
    const raw = readJsonFile(this.file);
    if (raw === null || typeof raw !== 'object') return undefined;
    const room = typeof raw.room === 'string' ? raw.room.trim() : '';
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : '';
    if (!ROOM_RE.test(room) || !KEY_RE.test(key) || token.length < 20 || deviceId.length === 0) {
      this.logger.warn('cloud.json 内容不完整，将重新生成远程链接');
      return undefined;
    }
    return { room, key, token, deviceId };
  }

  saveIdentity(identity) {
    try {
      atomicWriteJson(this.file, {
        room: identity.room,
        key: identity.key,
        token: identity.token,
        deviceId: identity.deviceId,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('远程链接身份写入失败', error);
    }
  }

  /**
   * The relay needs a device token bound to this host: it is the same
   * credential class as a paired phone, so it shows up in the device list and
   * can be revoked like one. Reusing `core.mintDevice` keeps one code path.
   */
  ensureIdentity() {
    const existing = this.loadIdentity();
    if (existing !== undefined) {
      const device = this.core.authenticateToken(existing.token);
      if (device !== undefined) {
        this.identity = existing;
        return existing;
      }
      // The token was revoked (or the file was copied from another install):
      // keep the room so an old QR keeps pointing at the same mailbox? No —
      // a revoked token must not be resurrected, so mint a fresh identity.
      this.logger.warn('远程中继令牌已失效（可能已被移除），正在重新生成');
    }
    const fresh = createIdentity();
    const minted = this.core.mintDevice({ name: '远程中继', platform: 'relay', appVersion: '1' });
    const identity = { ...fresh, token: minted.token, deviceId: minted.device.id };
    this.saveIdentity(identity);
    this.identity = identity;
    this.logger.info('已生成本机远程中继身份');
    return identity;
  }

  /** Drop the identity (used by "reset link"): the old QR dies immediately. */
  discardIdentity() {
    const token = this.identity?.token;
    if (typeof token === 'string' && token.length > 0) {
      const device = this.core.authenticateToken(token);
      if (device !== undefined) this.core.revokeDevice(device.id);
    }
    this.identity = undefined;
  }

  /**
   * Start (or re-point) the relay. Returns the state string; never throws for
   * expected configuration problems, so a broken relay cannot prevent the LAN
   * bridge from starting.
   */
  start(port) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      this.state = 'error';
      this.lastError = '监听端口无效，远程访问未启动';
      this.logger.error(this.lastError);
      return this.state;
    }
    this.port = port;
    if (!this.config.enabled) {
      this.state = 'disabled';
      return this.state;
    }
    if (this.config.appBase.length === 0) {
      // No personal fallback on purpose: shipping someone's Pages URL as a
      // default would route every install's phone page through one account.
      this.state = 'unconfigured';
      this.lastError = '未配置 cloud.appBase（手机端外壳地址），远程访问未启动';
      if (!this.warnedOnce) {
        this.warnedOnce = true;
        this.logger.warn(this.lastError);
      }
      return this.state;
    }
    if (this.auth === undefined) {
      this.state = 'error';
      this.lastError = '鉴权组件缺失，远程访问未启动';
      return this.state;
    }
    try {
      this.auth.assertUsable();
    } catch (error) {
      // Not a failure: the relay is *supposed* to stay down until a password
      // exists. Report it as blocked so the UI says "set a password" instead of
      // "something broke".
      const missing = error?.code === 'auth_missing_credentials';
      this.state = missing ? 'blocked' : 'error';
      this.lastError = String(error?.message ?? error);
      if (missing) this.logger.warn(`远程访问未启动：${this.lastError}`);
      else this.logger.error(`远程访问未启动：${this.lastError}`);
      return this.state;
    }
    if (this.link !== undefined) {
      if (this.link.localPort === port) {
        const ok = this.link.start();
        this.enabled = ok;
        this.state = this.link.state;
        return this.state;
      }
      // Reload changed the port: the relay forwards to 127.0.0.1:<localPort>,
      // so it must be rebuilt rather than reused.
      this.logger.info(`监听端口已变为 ${port}，重启远程中继`);
      this.stop();
    }
    let identity;
    try {
      identity = this.ensureIdentity();
    } catch (error) {
      // Device limit, unwritable state file, ...: keep the LAN bridge alive and
      // report the relay as broken instead of throwing into the status hook.
      this.state = 'error';
      this.lastError = `无法生成中继身份：${String(error?.message ?? error)}`;
      this.logger.error(this.lastError);
      return this.state;
    }
    this.link = new CloudLink({
      localPort: port,
      identity,
      broker: this.config.broker,
      appBase: this.config.appBase,
      name: this.core.serverName,
      logger: this.logger,
      auth: this.auth,
      allowAnonymous: this.config.allowAnonymous,
      relayNonce: this.core.relayNonce,
      core: this.core,
    });
    const ok = this.link.start();
    this.enabled = ok;
    this.state = this.link.state;
    this.lastError = ok ? '' : '远程中继拒绝启动';
    if (ok) {
      this.logger.info('远程访问已启动（电脑只向中转发起出站连接）');
    } else {
      this.logger.error(`远程访问未启动：${this.link.status().guard?.blocked?.message ?? this.lastError}`);
    }
    return this.state;
  }

  stop() {
    try { this.link?.stop(); } catch (error) { this.logger.warn('停止远程中继时出错', error); }
    this.link = undefined;
    this.enabled = false;
    this.state = 'disabled';
  }

  setEnabled(value) {
    const enabled = value === true;
    this.config.enabled = enabled;
    if (!enabled) {
      this.stop();
      return false;
    }
    if (this.port === 0) {
      this.state = 'idle';
      return false;
    }
    this.start(this.port);
    return this.enabled;
  }

  /**
   * Change the broker at runtime. Persisting the value would mean rewriting the
   * host's plugin config, which belongs to the operator; the CLI reports the
   * value so it can be copied into the config file.
   */
  setBroker(value) {
    const items = (Array.isArray(value) ? value : [value])
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
    if (items.length === 0 || items.length > 4 || items.some((item) => !BROKER_RE.test(item))) {
      throw codedError('bad_broker', '中转地址不合法（需要 ws/wss/mqtt/mqtts 地址，最多 4 个）');
    }
    this.config.broker = [...new Set(items)];
    if (this.port > 0 && this.config.enabled) {
      const wasOn = this.link !== undefined;
      if (wasOn) this.stop();
      this.config.enabled = true;
      this.start(this.port);
    }
    return this.status();
  }

  /** New room + key + token: the previous QR code stops working at once. */
  rotate() {
    const wasEnabled = this.config.enabled;
    this.stop();
    this.discardIdentity();
    this.config.enabled = wasEnabled;
    if (this.port > 0) this.start(this.port);
    return this.status();
  }

  status() {
    const base = {
      enabled: this.enabled === true,
      state: this.state,
      port: this.port,
      url: '',
      broker: this.config.broker[0] ?? '',
      appBase: this.config.appBase,
      allowAnonymous: this.config.allowAnonymous,
      phone: null,
      lastPhoneAt: 0,
      stats: {},
      lastError: this.lastError,
      auth: this.authInfo(),
    };
    if (this.link === undefined) return base;
    let linkStatus;
    try {
      linkStatus = this.link.status();
    } catch (error) {
      this.logger.warn('读取远程中继状态失败', error);
      return base;
    }
    return {
      ...base,
      ...linkStatus,
      enabled: this.enabled === true,
      port: this.port,
      appBase: this.config.appBase,
      // A "blocked" link has no lastError of its own; surface the reason so the
      // pairing page can explain what is missing instead of showing "error".
      lastError: linkStatus.lastError || linkStatus.guard?.blocked?.message || this.lastError,
      auth: this.authInfo(),
    };
  }

  authInfo() {
    if (this.auth === undefined) return { required: this.authRequired, configured: false, enabled: false };
    try {
      return this.auth.info();
    } catch {
      return { required: this.authRequired, configured: false, enabled: false };
    }
  }

  dispose() {
    this.stop();
  }
}

export { DEFAULT_APP_BASE };
