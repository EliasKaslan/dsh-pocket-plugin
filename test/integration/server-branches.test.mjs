/**
 * lib/server.mjs 的剩余分支：实时面（SSE / WebSocket）、兜底 catch、限流与
 * 「文件读不到」这类防御性出口。
 *
 * 全部用**真 BridgeServer + 真 HTTP/WS**（端口 0、临时目录），只在两处做实例级
 * 打桩，且都是为了打到「库自己抛错」的兜底分支：
 *   1. `core.index.snapshot` / `server.serveDownload` 抛错 → handle 的 catch；
 *   2. `server.handle` 整体 reject → listen 里 createServer 的 catch。
 * 不联网、不连 MQTT、不碰 ~/.dsh、不留常驻进程。
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';

import { BridgeServer } from '../../lib/server.mjs';
import {
  expectSecurityHeaders, openStream, request, requestJson, startBridge, waitClose, wsHandshake,
} from './support/harness.mjs';

let ctx;
let token;
let deviceId;

const delay = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

async function until(predicate, { timeoutMs = 4000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  throw new Error(`等待${label}超时`);
}

before(async () => {
  ctx = await startBridge();
  const minted = ctx.mint({ name: '实时面测试设备' });
  token = minted.token;
  deviceId = minted.device.id;
});

after(async () => {
  await ctx?.close();
});

const authed = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

async function wsTicket(port = ctx.port, headerOptions = {}) {
  const response = await requestJson(port, '/api/v1/ws-ticket', { method: 'POST', headers: authed(headerOptions) });
  assert.equal(response.status, 200, `ws-ticket 失败：${response.body.slice(0, 160)}`);
  return response.json.data.ticket;
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

test('SSE：/events 开流 → retry 头 + hello 帧 + 实时帧，断开后服务端两侧映射都清空', async () => {
  const stream = await openStream(ctx.port, `/api/v1/events?token=${encodeURIComponent(token)}`);
  try {
    assert.equal(stream.res.statusCode, 200);
    assert.equal(stream.res.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(stream.res.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(stream.res.headers['x-accel-buffering'], 'no');
    assert.notEqual(stream.res.headers['content-security-policy'], undefined, 'SSE 出口也要带安全头');

    const head = await stream.readUntil((text) => text.includes('event: hello'));
    assert.match(head, /^retry: 3000\n\n/u, '开流第一段必须是 retry: 3000');
    assert.match(head, /^id: \d+\nevent: hello\ndata: \{.*\}\n\n$/mu);
    const hello = JSON.parse(head.split('event: hello\ndata: ')[1].split('\n')[0]);
    assert.equal(hello.type, 'hello');
    assert.equal(hello.payload.device.id, deviceId);
    assert.equal(typeof hello.payload.server.version, 'string');

    assert.equal(ctx.server.allSse.size, 1, '服务端必须登记这条流');
    assert.equal(ctx.server.sseClients.get(deviceId).size, 1);

    ctx.core.emit('integration.ping', { n: 1 });
    const frame = await stream.readUntil((text) => text.includes('event: integration.ping'));
    assert.match(frame, /event: integration\.ping/u);
    assert.match(frame, /"n":1/u);
  } finally {
    stream.destroy();
  }
  await until(() => ctx.server.allSse.size === 0, { label: 'SSE 清理' });
  assert.equal(ctx.server.sseClients.size, 0, '断开后 per-device 桶必须被删掉（不只是清空）');
});

test('SSE：带 since 时先把环形缓冲里的旧帧补发一遍', async () => {
  ctx.core.emit('integration.before-since', { marker: 'replay-me' });
  const stream = await openStream(ctx.port, `/api/v1/events?token=${encodeURIComponent(token)}&since=0`);
  try {
    const text = await stream.readUntil((value) => value.includes('integration.before-since'));
    assert.match(text, /"marker":"replay-me"/u, 'since 必须真的补发历史帧');
  } finally {
    stream.destroy();
  }
  await until(() => ctx.server.allSse.size === 0, { label: 'SSE 清理' });
});

test('SSE：同一设备超过 6 条流 → 503 too_many_streams + retry-after', async () => {
  const streams = [];
  try {
    for (let i = 0; i < 6; i += 1) {
      const stream = await openStream(ctx.port, `/api/v1/events?token=${encodeURIComponent(token)}`);
      streams.push(stream);
    }
    assert.equal(ctx.server.sseClients.get(deviceId).size, 6);

    const rejected = await request(ctx.port, `/api/v1/events?token=${encodeURIComponent(token)}`);
    assert.equal(rejected.status, 503);
    const body = JSON.parse(rejected.body);
    assert.equal(body.error.code, 'too_many_streams');
    assert.equal(rejected.headers['retry-after'], '5');
    expectSecurityHeaders(rejected, 'SSE 503');
  } finally {
    for (const stream of streams) stream.destroy();
  }
  await until(() => ctx.server.allSse.size === 0, { label: 'SSE 清理' });
});

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

test('WS：ticket 握手 → hello → ping/pong → resync → 畸形帧被忽略 → 关闭后清空', async () => {
  const ticket = await wsTicket();
  const handshake = await wsHandshake(ctx.port, `/ws?ticket=${encodeURIComponent(ticket)}`);
  try {
    assert.equal(handshake.status, 101);
    const hello = handshake.messages[0];
    assert.equal(hello.type, 'hello');
    assert.equal(hello.payload.protocol, 1);
    assert.equal(hello.payload.device.id, deviceId);

    assert.equal(ctx.server.wsCount(), 1, 'wsCount 必须数到这条连接');

    // 同一张 ticket 只能用一次：第二次握手必须 401
    const reuse = await wsHandshake(ctx.port, `/ws?ticket=${encodeURIComponent(ticket)}`, { expectFirstFrame: false });
    assert.equal(reuse.status, 401, 'ticket 已被消费，第二次必须 401');
    reuse.socket.terminate();

    handshake.socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForMessage(handshake, (message) => message.type === 'pong');
    assert.equal(pong.type, 'pong');
    assert.equal(typeof pong.seq, 'number');

    handshake.socket.send('这不是 JSON');
    handshake.socket.send(JSON.stringify({ type: 'unknown-type' }));
    handshake.socket.send(JSON.stringify({ type: 'resync' }));
    const resync = await waitForMessage(handshake, (message) => message.type === 'resync');
    assert.equal(typeof resync.payload.summary.total, 'number', 'resync 必须带 summary');
  } finally {
    handshake.socket.close();
  }
  await until(() => ctx.server.wsCount() === 0, { label: 'WS 清理' });
});

test('WS：升级请求的四种拒绝（无 ticket 401 / 路径不对 404 / Host 不对 403 / 每设备超限 503）', async () => {
  const none = await wsHandshake(ctx.port, '/ws', { expectFirstFrame: false });
  assert.equal(none.status, 401);
  assert.equal(none.body, '');
  none.socket.terminate();

  const ticket = await wsTicket();
  const wrongPath = await wsHandshake(ctx.port, `/not-ws?ticket=${encodeURIComponent(ticket)}`, { expectFirstFrame: false });
  assert.equal(wrongPath.status, 404);
  wrongPath.socket.terminate();

  const badHost = await wsHandshake(ctx.port, '/ws?ticket=whatever', {
    headers: { host: 'evil.example' }, expectFirstFrame: false,
  });
  assert.equal(badHost.status, 403);
  badHost.socket.terminate();
  assert.ok(ctx.logs.some((line) => line.includes('rejected upgrade with untrusted Host header')), '必须留 warn');

  const sockets = [];
  try {
    for (let i = 0; i < 6; i += 1) {
      const one = await wsHandshake(ctx.port, `/ws?ticket=${encodeURIComponent(await wsTicket())}`);
      sockets.push(one.socket);
    }
    assert.equal(ctx.server.wsCount(), 6);
    const over = await wsHandshake(ctx.port, `/ws?ticket=${encodeURIComponent(await wsTicket())}`, { expectFirstFrame: false });
    assert.equal(over.status, 503);
    over.socket.terminate();
  } finally {
    for (const socket of sockets) socket.close();
  }
  await until(() => ctx.server.wsCount() === 0, { label: 'WS 清理' });
});

test('WS：设备被吊销时用 4001 主动断开（不只是让下一次请求 401）', async () => {
  const bridge = await startBridge();
  try {
    const minted = bridge.mint({ name: '待吊销设备' });
    const ticketResponse = await requestJson(bridge.port, '/api/v1/ws-ticket', {
      method: 'POST', headers: { authorization: `Bearer ${minted.token}` },
    });
    const ticket = ticketResponse.json.data.ticket;
    const handshake = await wsHandshake(bridge.port, `/ws?ticket=${encodeURIComponent(ticket)}`);
    const stream = await openStream(bridge.port, `/api/v1/events?token=${encodeURIComponent(minted.token)}`);
    await stream.readUntil((text) => text.includes('event: hello'));
    assert.equal(bridge.server.wsCount(), 1);
    assert.equal(bridge.server.allSse.size, 1);

    const closed = waitClose(handshake.socket);
    assert.equal(bridge.core.revokeDevice(minted.device.id), true);
    const close = await closed;
    assert.equal(close.code, 4001, `吊销必须给 4001，实际 ${close.code}`);
    assert.match(close.reason, /device revoked/u);

    await stream.waitEnd();
    await until(() => bridge.server.allSse.size === 0, { label: 'SSE 清理' });
    assert.equal(bridge.server.wsClients.size, 0, '吊销后 wsClients 必须清空');
    assert.equal(bridge.server.sseClients.size, 0, '吊销后 sseClients 必须清空');
  } finally {
    await bridge.close();
  }
});

test('close()：还有 ws 连接时用 1001「bridge reloading」断开，并把映射清空', async () => {
  const bridge = await startBridge();
  const minted = bridge.mint({ name: '重载设备' });
  const ticketResponse = await requestJson(bridge.port, '/api/v1/ws-ticket', {
    method: 'POST', headers: { authorization: `Bearer ${minted.token}` },
  });
  const handshake = await wsHandshake(bridge.port, `/ws?ticket=${encodeURIComponent(ticketResponse.json.data.ticket)}`);
  assert.equal(bridge.server.wsCount(), 1);

  const closed = waitClose(handshake.socket);
  await bridge.close();
  const close = await closed;
  assert.equal(close.code, 1001);
  assert.match(close.reason, /bridge reloading/u);
  assert.equal(bridge.server.wsClients.size, 0);
});

/** 从握手后继续等一条满足条件的帧（wsHandshake 只保证第一帧）。 */
function waitForMessage(handshake, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { handshake.socket.off('message', onMessage); reject(new Error('等待 ws 帧超时')); }, timeoutMs);
    timer.unref?.();
    const onMessage = (data) => {
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      handshake.socket.off('message', onMessage);
      resolve(message);
    };
    handshake.socket.on('message', onMessage);
  });
}

/* ------------------------------------------------------------------ */
/* 兜底 catch                                                           */
/* ------------------------------------------------------------------ */

test('handle 的 catch：API 出口回 500 JSON，静态出口回 500 纯文本，且都不把进程带走', async () => {
  const original = ctx.core.index.snapshot;
  ctx.core.index.snapshot = () => { const error = new Error('snapshot exploded'); error.code = 'internal'; throw error; };
  try {
    const response = await request(ctx.port, '/api/v1/tasks', { headers: authed() });
    assert.equal(response.status, 500);
    const body = JSON.parse(response.body);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, 'snapshot exploded');
    assert.equal(response.headers['cache-control'], 'no-store');
    expectSecurityHeaders(response, 'API 500');
    assert.ok(ctx.logs.some((line) => line.includes('request failed GET /api/v1/tasks')));
  } finally {
    ctx.core.index.snapshot = original;
  }

  const originalDownload = ctx.server.serveDownload;
  ctx.server.serveDownload = () => { throw new Error('download exploded'); };
  try {
    const response = await request(ctx.port, '/download/setup.exe');
    assert.equal(response.status, 500);
    assert.equal(response.body, 'Internal Server Error');
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    expectSecurityHeaders(response, '静态 500');
  } finally {
    ctx.server.serveDownload = originalDownload;
  }

  // 复原之后必须还能正常服务
  const healthy = await request(ctx.port, '/api/v1/tasks', { headers: authed() });
  assert.equal(healthy.status, 200);
});

test('listen 的 catch：handle 整体 reject 时回 500 internal 而不是把宿主进程搞崩', async () => {
  const bridge = await startBridge();
  try {
    bridge.server.handle = async () => { throw new Error('handle exploded'); };
    const response = await request(bridge.port, '/healthz');
    assert.equal(response.status, 500);
    const body = JSON.parse(response.body);
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, '服务内部错误');
    expectSecurityHeaders(response, '未捕获异常 500');
    assert.ok(bridge.logs.some((line) => line.includes('unhandled request failure GET /healthz')));
  } finally {
    await bridge.close();
  }
});

test('parseUrl 的 catch：Host 带着非法端口（URL 解析必炸）时按 / 处理，而不是 500', async () => {
  const response = await request(ctx.port, '/', { headers: { host: '127.0.0.1:99999999' } });
  // hostAllowed 只取 hostname（127.0.0.1）→ 通过；parseUrl 落到 catch 后 pathname='/'。
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/pair');
  expectSecurityHeaders(response, 'parseUrl 兜底');
});

/* ------------------------------------------------------------------ */
/* 限流与 405                                                           */
/* ------------------------------------------------------------------ */

test('POST /tasks 第 21 次（每分钟每设备 20 次）→ 429 + retry-after，且不计入业务错误', async () => {
  const minted = ctx.mint({ name: '限流设备' });
  const headers = { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' };
  const statuses = [];
  for (let i = 0; i < 20; i += 1) {
    const response = await request(ctx.port, '/api/v1/tasks', { method: 'POST', headers, body: '{"prompt":""}' });
    statuses.push(response.status);
  }
  assert.deepEqual(new Set(statuses), new Set([400]), '前 20 次都该走到「空 prompt」的业务校验');

  const limited = await request(ctx.port, '/api/v1/tasks', { method: 'POST', headers, body: '{"prompt":""}' });
  assert.equal(limited.status, 429);
  const body = JSON.parse(limited.body);
  assert.equal(body.error.code, 'rate_limited');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  expectSecurityHeaders(limited, '429');

  // 换一台设备立刻恢复（限流是按设备算的）
  const other = ctx.mint({ name: '另一台设备' });
  const ok = await request(ctx.port, '/api/v1/tasks', {
    method: 'POST',
    headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
    body: '{"prompt":""}',
  });
  assert.equal(ok.status, 400, '限流不能误伤别的设备');
});

test('/cloud/* 的 405 与桌面表单挂载的 404，CSRF 失败时不执行任何副作用', async () => {
  const bridge = await startBridge();
  let rotated = 0;
  bridge.core.setCloud({
    enabled: false,
    status: () => ({ enabled: false, state: 'idle', url: '', broker: '', appBase: 'https://x/', lastError: '' }),
    rotate: () => { rotated += 1; },
    setBroker: () => {},
    setEnabled: () => false,
  });
  try {
    const wrongMethod = await request(bridge.port, '/cloud/rotate', { method: 'GET' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'POST');
    expectSecurityHeaders(wrongMethod, 'cloud 405');

    const unknown = await request(bridge.port, '/cloud/nope', {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error.code, 'not_found');

    // CSRF 不通过（跨站 Origin 且没有 token）→ 403，rotate 一次都不许发生
    const csrf = await request(bridge.port, '/cloud/rotate', {
      method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(csrf.status, 403);
    assert.equal(JSON.parse(csrf.body).error.code, 'csrf');
    assert.equal(rotated, 0, 'CSRF 失败绝不能有副作用');

    // 表单挂载：带 csrf 字段的 urlencoded 表单能通过
    const form = await request(bridge.port, '/cloud/rotate', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${encodeURIComponent(bridge.core.csrfToken)}`,
    });
    assert.equal(form.status, 303);
    assert.equal(form.headers.location, '/pair');
    assert.equal(rotated, 1);
  } finally {
    await bridge.close();
  }
});

test('/cloud/* 来自中继（带 x-pocket-relay 头）→ 403 loopback_only；没启用远程 → 503', async () => {
  const bridge = await startBridge();
  bridge.core.setCloud({
    enabled: true,
    status: () => ({ enabled: true, state: 'online', url: 'https://x/', broker: 'b', appBase: 'https://x/', lastError: '' }),
    rotate: () => { throw new Error('must not rotate'); },
    setBroker: () => {},
    setEnabled: () => false,
  });
  try {
    // 这个头由中继注入；入口无条件把它记成「来自中继」，于是回环判定必然为假。
    const relayed = await request(bridge.port, '/api/v1/cloud/rotate', {
      method: 'POST',
      headers: { 'x-pocket-relay': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(relayed.status, 403);
    assert.equal(JSON.parse(relayed.body).error.code, 'loopback_only');
    expectSecurityHeaders(relayed, 'relay 403');
  } finally {
    await bridge.close();
  }

  // 没有 CloudService 的宿主（core.cloud === undefined）
  const bare = await startBridge();
  try {
    assert.equal(bare.core.cloud, undefined);
    const response = await request(bare.port, '/api/v1/cloud/rotate', {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).error.code, 'unavailable');
  } finally {
    await bare.close();
  }
});

/* ------------------------------------------------------------------ */
/* 端口与静态文件的防御性出口                                            */
/* ------------------------------------------------------------------ */

test('listen：首选端口被本机占用时跳过它，顺延一个端口并留 warn', async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const occupied = blocker.address().port;
  const bridge = await startBridge();
  try {
    // 先占住「bridge 当前端口」，再看同一个 server 实例能否顺延。
    const second = new BridgeServer(bridge.core, { logger: bridge.core.logger, webRoot: bridge.webRoot, downloadDirs: [bridge.downloads] });
    const bound = await second.listen(occupied);
    try {
      assert.equal(bound, occupied + 1, `占用 ${occupied} 时应顺延到 ${occupied + 1}，实际 ${bound}`);
      assert.ok(bridge.logs.some((line) => line.includes(`port ${occupied} is owned by another service`)), '必须留 warn');
    } finally {
      second.close();
    }
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await bridge.close();
  }
});

test('静态出口：favicon 两处都不存在 → 404；serveWorker/serveFile 读不到文件 → 404 且带安全头', async () => {
  const bridge = await startBridge();
  try {
    // default webRoot 有 favicon.svg，先删掉，走「哪个都没有」的分支
    await rm(path.join(bridge.webRoot, 'favicon.svg'), { force: true });
    const favicon = await request(bridge.port, '/favicon.ico');
    assert.equal(favicon.status, 404);
    assert.equal(favicon.body, 'Not Found');
    expectSecurityHeaders(favicon, 'favicon 404');

    // serveWorker / serveFile 的「文件消失」分支：路由层已先 stat 过，
    // 这里直接对真实实例调用，才能打到 readFileSync / fileStat 失败那一步。
    const worker = callWithFakeExchange(bridge.server, 'serveWorker', path.join(bridge.webRoot, 'gone-sw.js'));
    assert.equal(worker.status, 404);
    assert.equal(worker.body, 'Not Found');
    assert.ok(bridge.logs.some((line) => line.includes('service worker read failed')));

    const file = callWithFakeExchange(bridge.server, 'serveFile', path.join(bridge.webRoot, 'gone.js'));
    assert.equal(file.status, 404);
    assert.equal(file.body, 'Not Found');
  } finally {
    await bridge.close();
  }
});

/** 用最小 req/res 对调真实实例方法（故意绕开路由层的 stat 预检）。 */
function callWithFakeExchange(server, method, file) {
  const result = { status: 0, headers: {}, body: '', headersSent: false, writableEnded: false };
  const res = {
    get headersSent() { return result.headersSent; },
    get writableEnded() { return result.writableEnded; },
    writeHead(status, headers) { result.status = status; result.headers = headers; result.headersSent = true; return this; },
    end(body) {
      result.writableEnded = true;
      if (typeof body === 'string') result.body = body;
      else if (Buffer.isBuffer(body)) result.body = body.toString('utf8');
      return this;
    },
    destroy() { result.destroyed = true; return this; },
  };
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' }, url: '/' };
  server[method](req, res, file);
  return result;
}

test('扫限流器的 sweep 定时器：60 秒一次，五个限流器都要被扫到', () => {
  const swept = { pair: 0, global: 0, auth: 0, create: 0, hello: 0 };
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const server = new BridgeServer({ setServer() {} }, { logger: silentLogger(), webRoot: '.' });
    server.pairLimiter.sweep = () => { swept.pair += 1; };
    server.pairGlobal.sweep = () => { swept.global += 1; };
    server.authLimiter.sweep = () => { swept.auth += 1; };
    server.createLimiter.sweep = () => { swept.create += 1; };
    server.helloLimiter.sweep = () => { swept.hello += 1; };
    assert.deepEqual(swept, { pair: 0, global: 0, auth: 0, create: 0, hello: 0 });
    mock.timers.tick(60_000);
    assert.deepEqual(swept, { pair: 1, global: 1, auth: 1, create: 1, hello: 1 });
    mock.timers.tick(60_000);
    assert.deepEqual(swept, { pair: 2, global: 2, auth: 2, create: 2, hello: 2 });
  } finally {
    mock.timers.reset();
  }
});

function silentLogger() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}
