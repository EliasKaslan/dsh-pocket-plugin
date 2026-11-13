/*
 * DSH 随行 · service worker（app-shell 缓存）
 *
 * __POCKET_BUILD__ 由构建/服务端在发送时替换成内容哈希（远端产物走
 * `tools/build-shell.mjs`，局域网 `/app` 走 `lib/server.mjs` 的 `serveWorker()`）：
 * 哈希变了缓存名就变，activate 时会清掉旧壳，避免手机上一直跑旧前端。
 */
const BUILD = '__POCKET_BUILD__';
const CACHE = `dsh-pocket-${BUILD}`;

/**
 * 相对 registration.scope 的壳资源。
 *
 * **这份清单必须是全集**：`app.js` 用静态 `import` 拉起 store / lib/* / views/*，
 * 少列一个，装好 SW 的首次离线打开就是一个 ES 模块 404 —— 白屏，而且现场
 * 只有一行没头没尾的 404。同样的坑 `remote/sw.js` 里已经记过一次（手写九文件
 * 清单漏了 store.js / lib / views），这里当时没同步修：`lib/answers.js`、
 * `lib/perf.js`、`lib/shell-fresh.js`、`lib/shell-session.js` 与
 * `manifest.webmanifest` 都漏了。
 *
 * 之所以没有像 `remote/sw.js` 那样由构建期占位符生成：`web/sw.js` 不是构建产物，
 * 局域网布局下它就是被 `lib/server.mjs` 直接读出来发的源码，构建期替换覆盖不到它。
 * 改用 `test/unit/client-guards.test.mjs` 做门禁：解析这份数组 + 递归扫
 * `web/**\/*.js` 的相对 import，任何漏项都红。
 */
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './store.js',
  './manifest.webmanifest',
  './lib/answers.js',
  './lib/dom.js',
  './lib/format.js',
  './lib/markdown.js',
  './lib/net.js',
  './lib/perf.js',
  './lib/shell-fresh.js',
  './lib/shell-session.js',
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

/** 缓存的壳入口（导航一律回它）。 */
function shellIndexUrl() {
  return new URL('./index.html', self.registration.scope).href;
}

/**
 * 导航：**先网络，失败再回退缓存**。
 *
 * 以前这里是纯 cache-first：命中缓存就直接返回 index.html，于是手动刷新/普通
 * 刷新永远拿到旧壳，必须"关掉页面重新打开"才会更新 —— 这正是 `remote/sw.js`
 * 里已经记过的那次事故（"改了没反应"），同一个坑在这里没同步修。
 * 壳文件体积小、局域网和静态托管都在近处，先网络的延迟可以忽略；离线仍由
 * 缓存兜底。静态资源仍然走缓存优先（见下面），否则每次打开都要发几十个请求。
 *
 * @param {Request} request
 */
async function networkFirstShell(request) {
  const cache = await caches.open(CACHE);
  const index = shellIndexUrl();
  try {
    // 必须绕过 HTTP 缓存：否则宿主/CDN 把旧 index.html 喂回来，"刷新"等于没刷。
    const response = await fetch(request, { cache: 'no-store' });
    // 非 2xx 不能直接给用户：深链在静态托管上常回 404 页，返回它就等于页面变成 404。
    if (!response.ok) return (await cache.match(index)) ?? response;
    // 只把入口文档写进缓存：任何 2xx HTML 都写会用别的文档覆盖掉壳。
    cache.put(index, response.clone()).catch(() => {});
    return response;
  } catch {
    return (await cache.match(index))
      ?? (await cache.match(new URL('./', self.registration.scope).href))
      ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
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
