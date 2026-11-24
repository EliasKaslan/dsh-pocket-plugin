/**
 * 「解除配对」要清哪些本地键 —— 纯清单，不碰 DOM。
 *
 * 为什么需要这份清单：`unpair()` 原来只走 `signOut({ forget: true })`，清的是
 * app 自己的 `dsh.pocket.session.v1`；而**外壳**（`remote/remote.js`）另外还写了
 * 两份东西：
 *
 *   1. 设备令牌（`pocket.session.v1`，同时镜像一份到 `dsh.pocket.session.v1`）：
 *      口令登录时电脑下发的。只清 app 那份的话，用户点「换一台电脑」并确认后
 *      刷新页面，外层 `boot()` 的 `adoptShellSession()` 会把旧令牌重新采纳 ——
 *      用户以为已经断开，实际仍然能操作那台电脑。
 *   2. 记住的配对链接（`dsh.pocket.link.v1`）：见 `remote/remote.js` 的
 *      `storeLink()`，里面就带着房间的 AES 密钥。断开连接却把密钥留在本机，
 *      下一个用这台手机的人只要拿得到链接就能重新连上。
 *
 * 清单放在这里是为了能被 `test/unit` 直接 import 核对，而不是在浏览器里点一遍。
 */

/**
 * 外壳写下的设备令牌。两份都清：历史版本用过不同的名字，而
 * `remote/remote.js` 的 `readDeviceSession()` 会**依次**读这两份 ——
 * 只删一份，另一份还是会把旧令牌喂回来。
 */
export const DEVICE_SESSION_KEYS = ['pocket.session.v1', 'dsh.pocket.session.v1'];

/** 更早的一代键名，同样可能还躺在 localStorage 里。 */
export const LEGACY_SESSION_KEY = 'dsh.bridge.session.v1';

/** 记住的配对链接（含房间里那把 AES 密钥）。 */
export const LINK_STORAGE_KEY = 'dsh.pocket.link.v1';

/**
 * 解除配对 / 登出时要删掉的 localStorage 键。
 *
 * 去重后返回（同一份会话被两个键名写两次是外壳的镜像逻辑，清理时只删一次）。
 *
 * @returns {string[]}
 */
export function unpairStorageKeys() {
  return [...new Set([...DEVICE_SESSION_KEYS, LEGACY_SESSION_KEY, LINK_STORAGE_KEY])];
}

/* ------------------------- 会话记录里的 `scope` 向后兼容 ------------------------- */

/**
 * 判断一条旧会话记录的 `scope` 该不该被接受。
 *
 * 背景：1.0.3 给设备会话 / 登录会话加了一条 `scope` 强校验（房间身份的一部分，
 * 换一台电脑就换一个 scope），用来避免把上一台电脑的令牌带去撞新电脑。但 **v1.0.2
 * 写下的记录里根本没有这个字段** —— 强校验一上，升级后的每台手机都会把本地那份
 * 有效令牌当成"不是这个房间的"丢掉，于是所有人都被踢回口令登录一次。
 *
 * 这里按 legacy 接受缺字段的记录：桌面端本来就会校验令牌真伪（用不了的令牌只会
 * 得到 401，然后正常走重新登录），在这个位置 fail-closed 换来的不是安全，而是
 * 一次全网用户都要重输口令的升级事故。字段**存在但与当前不同**仍然拒绝。
 *
 * @param {unknown} recordScope 记录里的 scope（可能不存在）
 * @param {unknown} currentScope 本次会话的 scope（房间密钥派生）
 * @returns {'ok'|'legacy'|'mismatch'}
 */
export function scopeVerdict(recordScope, currentScope) {
  const current = typeof currentScope === 'string' ? currentScope : '';
  // 没有当前 scope（局域网直连布局 / 还没算出）→ 不做校验。
  if (current === '') return 'ok';
  if (recordScope === current) return 'ok';
  // v1.0.2 的记录没有这个字段：按 legacy 接受，下次写入时补上。
  if (typeof recordScope !== 'string' || recordScope === '') return 'legacy';
  return 'mismatch';
}

/**
 * 把一条旧记录补上当前 scope（legacy 记录"下次写入时补上该字段"）。
 *
 * 只补字段、不改别的：调用方拿到的仍然是原来那份令牌 / deviceId。
 *
 * @template T
 * @param {T} record
 * @param {unknown} currentScope
 * @returns {T & {scope: string}}
 */
export function adoptScope(record, currentScope) {
  const current = typeof currentScope === 'string' ? currentScope : '';
  const source = record !== null && typeof record === 'object' ? record : {};
  return { ...source, scope: current };
}
