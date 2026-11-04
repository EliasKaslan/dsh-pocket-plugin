#!/usr/bin/env node
/**
 * 开发服务器：把 `web/` 当成线上的 `/app/` 提供，并把 `/api` 与 `/ws` 代理到
 * 一个正在运行的宿主（默认 http://127.0.0.1:47901）。
 *
 * 为什么需要它：宿主的 `web/` 是安装副本，改源码不会反映到运行中的实例；
 * 而前端与 API 必须**同源**，直接开另一个端口会被 CORS 拦住。代理解决了这个问题，
 * 也顺便让 E2E 能拿到一份真实的设备令牌（`GET /__dev/session`）。
 *
 *   node tools/dev-server.mjs --port 5173 --target http://127.0.0.1:47901
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const ROOT = resolve(import.meta.dirname, '..', 'web');
const PORT = Number(args.port ?? 5173);
const HOST = args.host ?? '127.0.0.1';
const TARGET = new URL(args.target ?? 'http://127.0.0.1:47901');

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

/** Map `/app/foo.js` to `<repo>/web/foo.js` and refuse anything outside ROOT. */
function resolveStatic(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '/app' || rel === '/app/') rel = '/index.html';
  else if (rel.startsWith('/app/')) rel = rel.slice(4);
  const full = normalize(join(ROOT, rel));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

async function serveStatic(req, res, pathname) {
  const file = resolveStatic(pathname);
  if (file === null) { send(res, 403, 'Forbidden'); return; }
  let info;
  try { info = await stat(file); } catch { send(res, 404, 'Not Found'); return; }
  if (info.isDirectory()) {
    const index = join(file, 'index.html');
    try { info = await stat(index); } catch { send(res, 404, 'Not Found'); return; }
    return pipeFile(req, res, index, info.size);
  }
  return pipeFile(req, res, file, info.size);
}

function pipeFile(req, res, file, size) {
  res.writeHead(200, {
    'content-type': MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function proxyHttp(req, res) {
  const upstream = httpRequest({
    hostname: TARGET.hostname,
    port: TARGET.port || 80,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `${TARGET.hostname}:${TARGET.port}` },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) send(res, 502, 'upstream unavailable'); });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
  const upstream = connect(Number(TARGET.port || 80), TARGET.hostname, () => {
    const headers = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      headers.push(`${name}: ${name.toLowerCase() === 'host' ? `${TARGET.hostname}:${TARGET.port}` : value}`);
    }
    upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

/** 借宿主的 loopback 配对接口换一份真设备令牌，给浏览器注入用。 */
async function fetchSession() {
  const cached = await readState();
  if (cached !== null) {
    const alive = await fetch(`${TARGET.origin}/api/v1/me`, {
      headers: { authorization: `Bearer ${cached.token}`, accept: 'application/json' },
    }).then((response) => response.ok, () => false);
    if (alive) return cached;
  }
  const pairing = await fetchJson(new URL('/api/v1/pairing', TARGET), { method: 'GET' });
  const code = pairing?.code ?? pairing?.pairing?.code;
  if (typeof code !== 'string' || code.length === 0) throw new Error('没能从宿主拿到配对码');
  const paired = await fetchJson(new URL('/api/v1/pair', TARGET), {
    method: 'POST',
    body: JSON.stringify({
      code,
      name: 'Dev Tools',
      platform: 'web',
      appVersion: 'dev',
    }),
  });
  if (typeof paired?.token !== 'string') throw new Error('配对失败：宿主没有返回令牌');
  const session = {
    token: paired.token,
    baseUrl: '',
    deviceName: 'Dev Tools',
    serverName: paired.server?.name ?? '',
    pairedAt: Date.now(),
  };
  await writeState(session);
  return session;
}

/**
 * 设备令牌缓存。宿主默认只允许少量配对设备，反复配对会撞上 device_limit，
 * 所以令牌落在系统临时目录（不在仓库里），失效了再重新配对。
 */
function statePath() {
  return args.state ?? join(tmpdir(), 'dsh-pocket-dev-session.json');
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'));
    return typeof parsed?.token === 'string' && parsed.token.length > 0 ? parsed : null;
  } catch { return null; }
}

async function writeState(session) {
  try { await writeFile(statePath(), JSON.stringify(session), { mode: 0o600 }); } catch { /* best effort */ }
}

async function fetchJson(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-pocket-dev': '1' },
    body,
  });
  const text = await response.text();
  try {
    const payload = JSON.parse(text);
    return payload?.data ?? payload;
  } catch {
    throw new Error(`宿主返回了非 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/__dev/session') {
    fetchSession().then(
      (session) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(session));
      },
      (error) => send(res, 502, `配对失败：${error.message}`),
    );
    return;
  }

  if (url.pathname === '/__dev/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, target: TARGET.href, root: ROOT }));
    return;
  }

  if (url.pathname.startsWith('/api/')) { proxyHttp(req, res); return; }
  void serveStatic(req, res, url.pathname);
});

server.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').startsWith('/ws')) { proxyUpgrade(req, socket, head); return; }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`dev server: http://${HOST}:${PORT}/app/  →  ${TARGET.href}\n`);
  process.stdout.write(`  web root : ${ROOT}\n`);
  process.stdout.write(`  session  : http://${HOST}:${PORT}/__dev/session\n`);
});
