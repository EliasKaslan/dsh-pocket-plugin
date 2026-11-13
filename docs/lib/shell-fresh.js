/**
 * 外壳自检的纯逻辑：**我跑的这一版，和线上那一版是不是同一版？**
 *
 * 为什么单独抽成一个文件：这段判断原来整块写在 `app.js` 的 `checkShellFresh()`
 * 里，而那里一有笔误（曾经是一个根本不存在的变量 `mine`）就会被外层的
 * `catch { /* 自检失败不影响使用 *\/ }` 静默吞掉 —— 自检每次都在第一行死掉，
 * 「界面是旧版本，立即刷新」的横幅与 `hardRefreshShell()` 于是成了不可达代码。
 * 血证是一次真实事故：手机一直跑着 Service Worker 缓存里的旧壳，改了没反应，
 * 现场只看到请求超时、看不到任何版本提示。
 *
 * 放在这里可以被 Node 直接 import（不碰 DOM / caches），`test/unit` 能真的跑它，
 * 而不是对源码做正则断言。
 */

/**
 * 外壳缓存名的前缀。
 *
 * 两代外壳各用一个：远端外壳 `remote/sw.js` 写 `pocket-shell-${BUILD}`，
 * 局域网 `/app` 外壳 `web/sw.js` 写 `dsh-pocket-${BUILD}`。
 * 两个都要认：`hardRefreshShell()` 清缓存时本来就同时清这两种前缀，
 * 自检只认一个的话，另一种布局下自检会永远找不到自己的缓存直接 return ——
 * 又是一次"横幅不可达"。缓存是 per-origin 的，两种前缀不会互相污染。
 */
export const SHELL_CACHE_PREFIXES = ['pocket-shell-', 'dsh-pocket-'];

/**
 * 从 `sw.js` 源码里取出构建哈希（`const BUILD = '…'`）。
 *
 * 取不到、或者拿到的是没被替换的占位符（例如直接拿源码起的开发服务器），
 * 一律返回 null —— 表示"不知道线上是哪一版"。这时**不能**拿它去比对：
 * 会把占位符当成一个真实 build，界面就永远挂着"是旧版本"的横幅。
 *
 * @param {string} source
 * @returns {string|null}
 */
export function parseShellBuild(source) {
  const match = /const BUILD = '([^']*)'/u.exec(String(source ?? ''));
  const build = match?.[1] ?? '';
  if (build.length === 0) return null;
  if (build.includes('__POCKET_')) return null;
  return build;
}

/**
 * 缓存名列表 → 本机缓存的那些 build 号（顺序保持输入顺序，重复保留）。
 *
 * @param {Iterable<string>} cacheKeys `caches.keys()` 的结果
 * @returns {string[]}
 */
export function shellCacheBuilds(cacheKeys) {
  const builds = [];
  for (const key of cacheKeys ?? []) {
    if (typeof key !== 'string') continue;
    const prefix = SHELL_CACHE_PREFIXES.find((candidate) => key.startsWith(candidate));
    if (prefix === undefined) continue;
    const build = key.slice(prefix.length);
    // 前缀后面什么都没有的键不是我们的缓存名，别把它算成一个 build。
    if (build.length === 0) continue;
    builds.push(build);
  }
  return builds;
}

/**
 * 哪些缓存的 build 已经过时。
 *
 * 判据是**逐条比对**而不是 `find()` 一个：新旧两个缓存可能同时存在
 * （新 SW 先预缓存、旧 SW 后才 activate 删除），随手拿一个可能拿到旧的，
 * 于是误报「界面是旧版本」。
 *
 * `liveBuild` 为 null/空（自检拿不到线上版本）时返回空数组：不做判断比误报好。
 *
 * @param {Iterable<string>} cacheKeys
 * @param {string|null} liveBuild
 * @returns {string[]}
 */
export function staleShellBuilds(cacheKeys, liveBuild) {
  if (typeof liveBuild !== 'string' || liveBuild.length === 0) return [];
  return shellCacheBuilds(cacheKeys).filter((build) => build !== liveBuild);
}
