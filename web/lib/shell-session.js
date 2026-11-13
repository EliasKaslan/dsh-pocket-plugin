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
