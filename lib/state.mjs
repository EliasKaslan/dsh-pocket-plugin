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

  /** Synchronous write for anything a user would notice losing. */
  flush() {
    this.dirty = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      atomicWriteJson(this.file, this.data);
    } catch (error) {
      this.dirty = true;
      this.logger?.error('state write failed', error);
    }
  }

  close() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }
}
