/* Build stamp: tools/build-shell.mjs replaces a85e57ae307152cd with the content hash of app.js + remote.js + remote.css + index.html — never hand-edit CACHE below. */
/*
 * DSH Pocket · remote shell service worker
 * ------------------------------------------------------------
 * Scope is deliberately tiny: the static shell (HTML/CSS/JS) and nothing else.
 * It is cache-first because these files are immutable per build — the build
 * script re-stamps CACHE whenever any of them changes, so a deploy produces a
 * new cache name and the old one is dropped on activate.
 *
 * Never touched here:
 *  - the relay's fake origin (https://dsh-remote.local/*): those requests are
 *    produced by the fetch shim and tunnelled over MQTT, not HTTP;
 *  - the MQTT broker;
 *  - /api/* and /healthz on the real origin.
 */
'use strict';

const BUILD = 'a85e57ae307152cd';
const CACHE = `pocket-shell-${BUILD}`;

/**
 * Shell assets. **Generated at build time** by tools/build-shell.mjs from the
 * actual output file list — do not hand-maintain this list. It used to be a
 * hand-written array of nine files, which silently missed `store.js`, `lib/*`
 * and `views/*`; `app.js` imports those as static ES modules, so opening the
 * cached shell offline died on the first missing module (white screen).
 * The placeholder must stay a bare expression on its own line.
 */
const PRECACHE = [
  "./",
  "./app.css",
  "./app.js",
  "./favicon.svg",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-64.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./index.html",
  "./lib/answers.js",
  "./lib/dom.js",
  "./lib/format.js",
  "./lib/markdown.js",
  "./lib/net.js",
  "./lib/perf.js",
  "./lib/shell-fresh.js",
  "./lib/shell-session.js",
  "./lib/sprite.js",
  "./lib/ui.js",
  "./manifest.webmanifest",
  "./mqtt.min.js",
  "./remote.css",
  "./remote.js",
  "./store.js",
  "./views/compose.js",
  "./views/connect.js",
  "./views/detail.js",
  "./views/settings.js",
  "./views/tasks.js"
];

const SHELL_URLS = new Set(PRECACHE.map((path) => new URL(path, self.location.href).href));
const INDEX_URL = new URL('./index.html', self.location.href).href;

/**
 * 取壳资源：**先网络，失败再回退缓存**。
 *
 * 以前这里是纯 cache-first，于是浏览器/manual 刷新拿到的是旧的 index.html 与旧 JS，
 * 必须"关掉页面重新打开"才会更新（那次导航前 SW 更新检查刚好完成）。
 * 壳文件体积小、部署在静态 CDN 上，先网络换来的延迟可以忽略；离线仍由缓存兜底。
 */
async function networkFirst(key, request) {
  try {
    // 导航必须绕过 HTTP 缓存：静态托管的 CDN 会把旧 index.html 喂回来，
    // 于是"普通刷新拿到旧壳、点 banner 按钮（晚一点）才成功"。
    const response = await fetch(request, { cache: 'no-store' });
    // 非 2xx 不能直接回给用户：深链在静态托管上常回 404 页，直接返回就等于
    // 「页面变成了 404」；回退到缓存的壳更符合预期。
    if (!response.ok) return (await caches.match(key)) ?? response;
    // 只缓存真正的入口文档：任何 2xx HTML 都写进去会用别的文档覆盖缓存的壳。
    if (key === INDEX_URL) {
      const cache = await caches.open(CACHE);
      cache.put(key, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const hit = await caches.match(key);
    return hit ?? Response.error();
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Add one by one: cache.addAll() rejects the whole batch when a single
    // optional asset (an icon, a manifest) is missing, which would leave the
    // shell without any offline cache at all.
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        const response = await fetch(new Request(path, { cache: 'reload' }));
        if (!response.ok) return;
        await cache.put(new URL(path, self.location.href).href, response);
      } catch {
        /* optional asset missing: the network copy still works */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('pocket-shell-') && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data !== null && typeof event.data === 'object' && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Cross-origin covers the relay's fake origin, the broker, and any CDN.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (request.headers.has('range')) return;

  // Query strings are ignored when matching: the shell assets are addressed
  // without one, but a host may append a cache buster.
  const canonical = new URL(url.pathname, self.location.origin).href;

  // 导航必须先于壳资源分支判定：真实入口 /repo/ 的 canonical 就在 SHELL_URLS 里
  // （PRECACHE 首项是 ./）。否则先命中 cache-first，下面的 navigate 分支永远不可达，
  // 于是「改了 network-first 却刷不出新壳」。
  if (SHELL_URLS.has(canonical) && request.mode !== 'navigate') {
    // 壳资源**缓存优先 + 后台更新**：它们按 build 分代，新壳上线后由新的 install
    // 重新填充；把这里也改成 network-first 会让手机每次打开都发几十个请求，
    // 移动网络下明显变慢（实测用户感知为"连接变慢 / 连不上电脑"）。
    // 只有**导航**必须是 network-first —— 它决定"刷新能不能拿到新壳"。
    event.respondWith((async () => {
      const hit = await caches.match(canonical);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE).then((cache) => cache.put(canonical, response.clone())).catch(() => {});
          }
          return response;
        })
        .catch(() => null);
      if (hit !== undefined) {
        void network; // 先给缓存，后台更新
        return hit;
      }
      return (await network) ?? Response.error();
    })());
    return;
  }
  // A navigation to some nested path (static-host 404 fallbacks, a trailing
  // path segment) should still land on the shell rather than a host error page.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(INDEX_URL, request));
  }
});
