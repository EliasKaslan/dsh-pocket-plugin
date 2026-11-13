/**
 * Durable plugin state: paired devices, the current pairing window, settings.
 *
 * Only token hashes are stored. The plaintext device token exists exactly once,
 * in the pairing response, and never touches disk here. Revoked devices are
 * kept as audit records; every view and lookup filters them out.
 */
import path from 'node:path';
import { existsSync, renameSync, statSync } from 'node:fs';
import {
  atomicWriteJson, ensureDir, isPlainObject, nowMs, randomHex, randomId, readJsonFile, safeEqual,
} from './util.mjs';

const STATE_VERSION = 1;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/u;
/** 写盘失败后多久重试一次。 */
const SAVE_RETRY_MS = 5000;
/** 持续写不进磁盘时，告警的节流间隔（成功一次即恢复）。 */
const WRITE_WARN_MS = 60 * 1000;

export class StateStore {
  constructor(dir, logger) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.logger = logger;
    this.data = {
      version: STATE_VERSION,
      createdAt: nowMs(),
      settings: {},
      devices: [],
    };
    this.timer = undefined;
    this.dirty = false;
    /** 失败后的延迟重试定时器（成功一次即清掉）。 */
    this.retryTimer = undefined;
    /** 重试间隔；测试会把它调小，生产固定 5 秒。 */
    this.retryDelayMs = SAVE_RETRY_MS;
    /** 上次「写盘失败」告警的时间戳，用于节流；0 表示可以立刻告警。 */
    this.writeWarnedAt = 0;
  }

  load() {
    ensureDir(this.dir);
    const parsed = readJsonFile(this.file, undefined);
    if (parsed === undefined) {
      // A non-empty file that does not parse is corruption, not a fresh
      // install: move it aside so the next save cannot silently erase the
      // device list, and leave a breadcrumb for support.
      try {
        if (existsSync(this.file) && statSync(this.file).size > 2) {
          const backup = `${this.file}.corrupt-${Date.now()}`;
          renameSync(this.file, backup);
          this.logger?.error(`state.json 无法解析，已备份为 ${path.basename(backup)} 并重新开始`);
        }
      } catch (error) {
        this.logger?.warn('state.json 备份失败', error);
      }
    }
    if (isPlainObject(parsed)) {
      this.data = {
        version: STATE_VERSION,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : nowMs(),
        settings: isPlainObject(parsed.settings) ? parsed.settings : {},
        devices: Array.isArray(parsed.devices) ? parsed.devices.filter((device) => this.validDevice(device)) : [],
      };
    }
    return this;
  }

  validDevice(device) {
    return isPlainObject(device)
      && typeof device.id === 'string'
      && device.id.length > 0
      && typeof device.tokenHash === 'string'
      && TOKEN_HASH_RE.test(String(device.tokenHash).toLowerCase());
  }

  get settings() {
    return this.data.settings;
  }

  /** All device records, including revoked ones (audit trail). */
  get devices() {
    return this.data.devices;
  }

  /** Stable, per-install identifier that survives restarts. */
  installFingerprint() {
    const current = this.data.settings.installFingerprint;
    if (typeof current === 'string' && current.length === 10) return current;
    const value = randomHex(5);
    this.data.settings.installFingerprint = value;
    this.flush();
    return value;
  }

  addDevice({ id, name, platform, appVersion, tokenHash, ip, installId }) {
    const now = nowMs();
    const cleanInstallId = typeof installId === 'string' && installId.length > 0
      ? installId.slice(0, 64)
      : '';
    const existing = this.data.devices.find((device) => device.id === id);
    if (existing !== undefined) {
      // Re-pairing the same id rotates the token and clears the revocation,
      // which is what users expect after wiping the app.
      existing.name = name;
      existing.platform = platform;
      existing.appVersion = appVersion;
      existing.tokenHash = tokenHash;
      existing.lastSeenAt = now;
      existing.lastIp = ip;
      existing.revoked = false;
      if (cleanInstallId.length > 0) existing.installId = cleanInstallId;
      delete existing.revokedAt;
      this.flush();
      return existing;
    }
    const device = {
      id: typeof id === 'string' && id.length > 0 ? id : randomId('dev_'),
      name: name || '未命名设备',
      platform: platform || 'unknown',
      appVersion: appVersion || '',
      tokenHash,
      createdAt: now,
      lastSeenAt: now,
      lastIp: ip || '',
      revoked: false,
    };
    if (cleanInstallId.length > 0) device.installId = cleanInstallId;
    this.data.devices.push(device);
    this.flush();
    return device;
  }

  /**
   * 按「这台手机自己的安装标识」找设备 —— 手机身份的唯一可靠判据。
   *
   * 旧的判据是 `name + platform`，而外壳恒发「手机 / web」，于是第二台手机
   * 首次登录会原地轮换掉第一台那条记录，第一台立刻被当成「已移除」掉登出。
   * 安装标识由手机自己在本地生成并持久化，卸载重装才会变。
   */
  findDeviceByInstallId(installId) {
    if (typeof installId !== 'string' || installId.length === 0) return undefined;
    return this.data.devices.find((device) => device.installId === installId);
  }

  /**
   * Constant-time lookup: the comparison iterates the whole list so a timing
   * observer cannot bisect which device slot matched.
   */
  findDeviceByTokenHash(tokenHash) {
    if (typeof tokenHash !== 'string' || tokenHash.length === 0) return undefined;
    let found;
    for (const device of this.data.devices) {
      if (device.revoked === true) continue;
      if (typeof device.tokenHash !== 'string') continue;
      if (safeEqual(device.tokenHash, tokenHash)) found = device;
    }
    return found;
  }

  touchDevice(id, ip) {
    const device = this.data.devices.find((item) => item.id === id);
    if (device === undefined || device.revoked === true) return;
    const now = nowMs();
    // Avoid rewriting the file for every request; five minutes is enough for UI.
    if (now - (device.lastSeenAt ?? 0) < 5 * 60_000) return;
    device.lastSeenAt = now;
    if (ip) device.lastIp = ip;
    this.save();
  }

  revokeDevice(id) {
    const device = this.data.devices.find((item) => item.id === id);
    if (device === undefined || device.revoked === true) return false;
    device.revoked = true;
    device.revokedAt = nowMs();
    this.flush();
    return true;
  }

  removeDevice(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((device) => device.id !== id);
    if (this.data.devices.length === before) return false;
    this.flush();
    return true;
  }

  /** Debounced save for high-frequency, low-value writes only. */
  save() {
    this.dirty = true;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 150);
    this.timer.unref?.();
  }

  /**
   * Synchronous write for anything a user would notice losing.
   *
   * 失败时原来只置 `dirty=true` —— 而 `dirty` 没有任何读者：一次 rename 失败
   * （Windows 上杀软/索引器短暂持有句柄就是 EPERM）之后，只要再没有新的写入，
   * 这次设备列表 / `lastSeen` 变更就永久丢了，状态文件与内存悄悄分叉，重启后
   * 手机被当成未登记而登出。
   *
   * 这里排一次**延迟重试**而不是把错误抛给调用方：调用方都在请求热路径上，
   * 抛错等于把「磁盘临时不可写」升级成请求失败，而磁盘恢复后这次重试就够了。
   * 重试定时器 `unref()`，不会拖住进程退出。
   *
   * @param {{retry?: boolean}} [options] `close()` 用 `{retry:false}` 收起挂起任务
   */
  flush({ retry = true } = {}) {
    this.dirty = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      atomicWriteJson(this.file, this.data);
      this.writeWarnedAt = 0;
      if (this.retryTimer !== undefined) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
    } catch (error) {
      this.dirty = true;
      this.logWriteFailure(error);
      if (retry) this.scheduleRetry();
    }
  }

  /** 失败告警：节流到 WRITE_WARN_MS 一条 —— 重试是每 5 秒一次，日志不能也这么密。 */
  logWriteFailure(error) {
    const now = nowMs();
    if (now - this.writeWarnedAt < WRITE_WARN_MS) return;
    this.writeWarnedAt = now;
    this.logger?.error('state write failed', error);
  }

  /**
   * 失败后排一次延迟重试。
   *
   * 刻意**不设重试次数上限**：磁盘不可写会持续多久无法预知（杀软扫描、
   * 卷被卸载、备份工具占着目录），放弃就等于回到「一次失败即永久丢数据」。
   * 定时器 `unref()`，不会拖住进程退出。
   */
  scheduleRetry() {
    if (this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      // 期间已经有别的路径写入成功（dirty 被清掉），不必再补写。
      if (this.dirty !== true) return;
      this.flush();
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }

  close() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.flush({ retry: false });
  }
}
