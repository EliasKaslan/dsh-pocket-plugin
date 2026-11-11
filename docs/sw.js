/* Build stamp: tools/build-shell.mjs replaces b47d8361d45f20b3 with the content hash of app.js + remote.js + remote.css + index.html — never hand-edit CACHE below. */
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

const BUILD = 'b47d8361d45f20b3';
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
  "./lib/dom.js",
  "./lib/format.js",
  "./lib/markdown.js",
  "./lib/net.js",
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

  if (SHELL_URLS.has(canonical)) {
    event.respondWith(caches.match(canonical).then((hit) => hit ?? fetch(request)));
    return;
  }
  // A navigation to some nested path (static-host 404 fallbacks, a trailing
  // path segment) should still land on the shell rather than a host error page.
  if (request.mode === 'navigate') {
    event.respondWith(caches.match(INDEX_URL).then((hit) => hit ?? fetch(request)));
  }
});
