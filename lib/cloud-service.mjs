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
import { rmSync } from 'node:fs';
import path from 'node:path';
import { CloudLink, DEFAULT_APP_BASE, DEFAULT_BROKERS, createIdentity } from './cloud.mjs';
import { atomicWriteJson, isPlainObject, readJsonFile } from './util.mjs';

const IDENTITY_FILE = 'cloud.json';
/** `room` is a base64url 128-bit id, so it may contain `-` and `_`. */
const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/u;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/u;
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
      /**
       * 默认**关闭**，必须显式 `cloud.enabled: true` 才启用。
       *
       * 以前是 `!== false`（省略该键 = 开启），与文档正好相反：`cordis.patch.yml`
       * 与 INSTALL.md 都写「默认关闭」。省略一个键就悄悄打开一条对公网的入站
       * 通路，是最不该有的默认值 —— 失败要 fail closed。
       */
      enabled: cloud.enabled === true,
      appBase: normalizeAppBase(cloud.appBase),
      broker: normalizeBrokers(cloud.broker),
      allowAnonymous: cloud.allowAnonymous === true,
    };
    /** @type {import('./auth.mjs').Auth|undefined} */
    this.auth = auth;
    this.authRequired = authRequired === true;
    this.link = undefined;
    this.identity = this.loadIdentity();
    this.port = 0;
    this.enabled = false;
    this.state = this.config.enabled ? 'idle' : 'disabled';
    this.lastError = '';
    this.warnedOnce = false;
    /**
     * 身份写入失败后的延迟重试状态（R4）。
     *
     * 一次瞬时 flush 失败（磁盘忙、杀软临时锁住、磁盘满之后又腾出空间）不该让中继
     * **永久**停在 error：`start()` 只由 bridge.status 与管理动作触发，之后没有任何
     * 重试入口，磁盘恢复了也不自愈。退避翻倍、有上限（次数 + 单次间隔），并且
     * timer 一律 `unref()`，不拖住宿主退出。
     */
    this.identityRetry = { timer: undefined, attempts: 0, nextAt: 0 };
    /** 退避基数 / 单次上界 / 次数上限；测试会把基数压到毫秒级。 */
    this.identityRetryBaseMs = 2_000;
    this.identityRetryMaxMs = 60_000;
    this.identityRetryMaxAttempts = 6;
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
    atomicWriteJson(this.file, {
      room: identity.room,
      key: identity.key,
      token: identity.token,
      deviceId: identity.deviceId,
      updatedAt: new Date().toISOString(),
    });
  }

  ensureIdentity() {
    const existing = this.loadIdentity();
    if (existing && this.core.authenticateToken(existing.token)?.id === existing.deviceId) {
      this.identity = existing;
      return existing;
    }
    const room = existing ?? createIdentity();
    const minted = this.core.mintDevice({ name: '远程中继', platform: 'relay', appVersion: '1' });
    const identity = { ...room, token: minted.token, deviceId: minted.device.id };
    try {
      if (this.core.state.dirty) throw new Error('本机设备记录未能写入磁盘');
      this.saveIdentity(identity);
    } catch (error) {
      this.core.state.removeDevice(minted.device.id);
      this.logger.error('远程链接身份写入失败', error);
      throw error;
    }
    this.identity = identity;
    this.logger.info(existing ? '远程中继已补发新令牌，保留原有房间与密钥' : '已生成本机远程中继身份');
    return identity;
  }

  /** Drop the identity (used by "reset link"): the old QR dies immediately. */
  discardIdentity() {
    const token = (this.identity ?? this.loadIdentity())?.token;
    // If deletion fails, rotation must stop before the old room can be reused.
    // `force: true` 只吞 ENOENT：EPERM / EISDIR（只读盘、文件被占用、cloud.json
    // 变成了目录）照抛，而且抛出点在这行 —— 令牌还没吊销、identity 还没清，所以
    // "回滚到没 rotate 过"是可能的（见 rotate() 的 R5 分支）。
    rmSync(this.file, { force: true });
    if (typeof token === 'string' && token.length > 0) {
      const device = this.core.authenticateToken(token);
      // 直接走状态层吊销：`core.revokeDevice` 有意拒绝中继设备（防止界面误移除），
      // 但"重置链接"必须真的让旧凭据作废，所以这里绕过那层保护。
      if (device !== undefined) this.core.state.revokeDevice(device.id);
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
      // 瞬时失败必须能自愈（R4）：安排一次延迟重试，磁盘恢复后自动回来。
      this.scheduleIdentityRetry();
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
    // 起来了就没有待重试的事了：清掉退避状态，下次失败从最短间隔重新开始。
    this.cancelIdentityRetry();
    this.identityRetry.attempts = 0;
    if (ok) {
      this.logger.info('远程访问已启动（电脑只向中转发起出站连接）');
    } else {
      this.logger.error(`远程访问未启动：${this.link.status().guard?.blocked?.message ?? this.lastError}`);
    }
    return this.state;
  }

  /**
   * 安排一次延迟重试（R4）。退避 = base × 2^已试次数，封在 identityRetryMaxMs，
   * 超过 identityRetryMaxAttempts 次就放弃（并把原因写进日志）；下一次手动
   * `start()` 会把计数归零。
   */
  scheduleIdentityRetry() {
    if (this.identityRetry.timer !== undefined) return;
    if (!this.config.enabled || this.port <= 0) return;
    const attempt = this.identityRetry.attempts;
    if (attempt >= this.identityRetryMaxAttempts) {
      this.logger.error(`远程中继身份仍无法写入，已停止自动重试（共 ${attempt} 次）；重新打开远程访问或重启 DSH 时会再试一次`);
      return;
    }
    const delay = Math.min(this.identityRetryMaxMs, this.identityRetryBaseMs * (2 ** attempt));
    this.identityRetry.attempts = attempt + 1;
    this.identityRetry.nextAt = Date.now() + delay;
    const timer = setTimeout(() => {
      this.identityRetry.timer = undefined;
      this.identityRetry.nextAt = 0;
      if (!this.config.enabled || this.port <= 0) return;
      // 期间可能已经被别的入口（bridge.status / 管理动作）修好了。
      if (this.state !== 'error') return;
      this.logger.warn(`重试生成远程中继身份（第 ${this.identityRetry.attempts} 次）`);
      this.start(this.port);
    }, delay);
    // 绝不能让一次待重试把宿主进程钉住不退。
    timer.unref?.();
    this.identityRetry.timer = timer;
  }

  cancelIdentityRetry() {
    if (this.identityRetry.timer !== undefined) clearTimeout(this.identityRetry.timer);
    this.identityRetry.timer = undefined;
    this.identityRetry.nextAt = 0;
  }

  stop() {
    this.cancelIdentityRetry();
    this.identityRetry.attempts = 0;
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
    try {
      this.discardIdentity();
    } catch (error) {
      /**
       * 删不掉旧身份（EPERM / EISDIR / 只读盘）时**不许**把中继留在 disabled（R5）。
       *
       * 旧代码在这里直接往下走到 `if (this.port > 0) this.start(...)`，而 start()
       * 会因为 ensureIdentity 仍读到那份删不掉的文件而失败 —— 结果中继停着、
       * enabled 还是 true、identity 没清、也没有任何自恢复入口。正确的收场是
       * **回滚到"没 rotate 过"**：旧身份仍然有效，把它重新开起来。
       */
      this.config.enabled = wasEnabled;
      if (this.port > 0 && wasEnabled) this.start(this.port);
      // 放在 start() **之后**：成功重启会把 lastError 清空，而用户点了"重置链接"
      // 却没换成，界面必须还能看到原因（状态页读的就是这个字段）。
      this.lastError = `重置链接失败：${String(error?.message ?? error)}`;
      this.logger.error(this.lastError);
      return this.status();
    }
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
      /** 身份写入失败后的下次自动重试时刻（0 = 没有待重试）；见 R4。 */
      identityRetryAt: this.identityRetry.nextAt,
      identityRetryAttempts: this.identityRetry.attempts,
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
