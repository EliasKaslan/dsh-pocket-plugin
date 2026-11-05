/*
 * DSH 随行 · service worker（app-shell 缓存）
 *
 * __POCKET_BUILD__ 由 tools/build-shell.mjs 在构建时替换成内容哈希；
 * 哈希变了缓存名就变，activate 时会清掉旧壳，避免手机上一直跑旧前端。
 */
const BUILD = '__POCKET_BUILD__';
const CACHE = `dsh-pocket-${BUILD}`;

/** 相对 registration.scope 的壳资源；/app 与远端站点共用同一份。 */
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './store.js',
  './lib/dom.js',
  './lib/format.js',
  './lib/markdown.js',
  './lib/net.js',
  './lib/sprite.js',
  './lib/ui.js',
  './views/tasks.js',
  './views/detail.js',
  './views/compose.js',
  './views/settings.js',
  './views/connect.js',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

/** 远端外壳额外注入的脚本/样式；本地外壳（`/app`）里没有这些文件，缺失不算失败。 */
const OPTIONAL = ['./remote.js', './remote.css', './mqtt.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const absolute = ASSETS.map((path) => new URL(path, self.registration.scope).href);
    const extra = OPTIONAL.map((path) => new URL(path, self.registration.scope).href);
    await Promise.allSettled([...absolute, ...extra].map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('dsh-pocket-') && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(new URL('./index.html', self.registration.scope).href);
      if (cached !== undefined) return cached;
      try { return await fetch(request); } catch { return (await cache.match(new URL('./', self.registration.scope).href)) ?? Response.error(); }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    }).catch(() => null);
    if (cached !== undefined) {
      // 先给缓存，同时后台更新：冷启动最快，下一次打开已是新版。
      void network;
      return cached;
    }
    const fresh = await network;
    return fresh ?? Response.error();
  })());
});
