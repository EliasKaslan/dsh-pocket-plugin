#!/usr/bin/env node
/**
 * 端到端：起**真实**的 BridgeServer（lib/server.mjs + lib/core.mjs），用真 HTTP 打它。
 *
 *   node test/e2e/run.mjs
 *
 * 与单测的分工：单测证明纯函数对，这里证明「装起来之后」的行为对——
 * 鉴权闸在路由之前、CSP 真的下发、回环信任不可伪造、静态目录不会穿出去。
 *
 * 约束（都是刻意的）：
 *  - dataDir/home/web 全在 os.tmpdir() 下的一次性目录，跑完删掉，不写进仓库；
 *  - 监听 127.0.0.1 的临时端口（port 0 + 读回实际端口），不占用固定端口；
 *  - 不连 MQTT，不碰 ~/.dsh，不 profile 任何真实 DSH 服务（services 为空）；
 *  - after() 里关服务、断连接、删目录，不留常驻进程。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import { BridgeServer } from '../../lib/server.mjs';
import { PROTOCOL_VERSION } from '../../lib/util.mjs';

/** 故意放在 webRoot 之外：任何一次成功穿越都会让这个串出现在响应体里。 */
const SECRET = 'TOP-SECRET-E2E-d41d8cd9';
const FALLBACK = 'E2E-FALLBACK-INDEX';

let tmp;
let core;
let server;
let port;
let logs;
let httpServer;

/* ------------------------------------------------------------------ helpers */

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, headers, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function payload(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）：${response.body.slice(0, 120)}`);
  }
}

/* --------------------------------------------------------------------- setup */

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'dsh-pocket-e2e-'));
  const home = path.join(tmp, 'home');
  const dataDir = path.join(home, 'pocket');
  const webRoot = path.join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), `<!doctype html><html><body>${FALLBACK}</body></html>`, 'utf8');
  await writeFile(path.join(tmp, 'secret.txt'), SECRET, 'utf8');

  logs = [];
  const push = (level) => (...args) => logs.push(`${level} ${args.map(String).join(' ')}`);
  const logger = { info: push('info'), warn: push('warn'), error: push('error') };

  core = new BridgeCore({}, {
    home,
    dataDir,
    host: '127.0.0.1',
    port: 1,
    // 与线上一致：默认 fail-closed，必须有口令才允许中继；这里只测本机 HTTP 面。
    authRequired: true,
  }, logger);
  server = new BridgeServer(core, { logger, webRoot });
  // normalizeConfig 把 0 当非法端口回退到 47901；测试必须用临时端口，所以显式改 0，
  // 让 core.start() 走真实的 listen(0) → 读回实际端口。
  core.config.port = 0;
  await core.start();

  port = core.port;
  httpServer = server.http;
  assert.ok(Number.isInteger(port) && port > 0, `没有拿到实际端口：${port}`);
});

after(async () => {
  try { core?.dispose(); } catch { /* 已经关了 */ }
  try { httpServer?.closeAllConnections?.(); } catch { /* 已断 */ }
  try { server?.close(); } catch { /* 已经关了 */ }
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
});

/* --------------------------------------------------------------------- tests */

test('服务监听在临时端口上，不是写死的 47901', () => {
  assert.ok(port > 0 && port < 65536, `端口不合法：${port}`);
  assert.notEqual(port, 47901, '测试不许占用默认端口');
  assert.equal(core.started, true);
  assert.equal(core.port, port);
});

test('/api/v1/health 无令牌返回 200 且 ok===true', async () => {
  const response = await request('/api/v1/health');
  assert.equal(response.status, 200);
  const body = payload(response);
  assert.equal(body.ok, true);
  assert.equal(body.data.protocol, PROTOCOL_VERSION, 'HTTP 面报的是 PROTOCOL_VERSION');
  assert.equal(body.data.requiresLogin, true);
});

test('/api/v1/health 的响应头带 CSP 与安全头', async () => {
  const response = await request('/api/v1/health');
  const csp = String(response.headers['content-security-policy'] ?? '');
  assert.match(csp, /default-src 'self'/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.match(csp, /base-uri 'none'/u);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
});

test('/api/v1/status 与 /api/v1/tasks 不带令牌都是 401', async () => {
  for (const target of ['/api/v1/status', '/api/v1/tasks', '/api/v1/me']) {
    const response = await request(target);
    assert.equal(response.status, 401, `${target} 必须 401`);
    const body = payload(response);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(String(response.headers['content-type']), 'application/json; charset=utf-8');
  }
});

test('/api/v1/devices 不是令牌闸而是回环闸：本机 200，带中继标记 403', async () => {
  // 设备列表属于桌面管理面：本机浏览器该能看，一旦来自中继就必须拒。
  const local = await request('/api/v1/devices', { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(local.status, 200);
  assert.deepEqual(payload(local).data.devices, []);

  const viaRelay = await request('/api/v1/devices', {
    headers: { host: `127.0.0.1:${port}`, 'x-pocket-relay': core.relayNonce },
  });
  assert.equal(viaRelay.status, 403);
  assert.equal(payload(viaRelay).error.code, 'loopback_only');
});

test('连接页在非回环 Host 下被拒（Host 闸）', async () => {
  const response = await request('/pair', { headers: { host: 'evil.example:47901' } });
  assert.equal(response.status, 403);
  assert.equal(response.body, 'Forbidden');
  assert.ok(logs.some((line) => line.includes('untrusted Host')), '拒绝必须留日志');
});

test('连接页被中继标记挡住（requireLoopback：回环 socket 也不算本机）', async () => {
  const response = await request('/pair', {
    headers: { host: `127.0.0.1:${port}`, 'x-pocket-relay': core.relayNonce },
  });
  // 回环 socket + 合法 Host，只因为带了中继标记就被降级成远程。
  assert.equal(response.status, 403);
  assert.match(response.body, /连接页仅限电脑本机访问/u);
  assert.ok(logs.some((line) => line.includes('pairing page blocked (relay)')), `实际日志：${logs.slice(-3).join(' | ')}`);
});

test('中继标记伪造与真值都换不来回环信任（/api/v1/devices 403 loopback_only）', async () => {
  for (const marker of [core.relayNonce, 'forged-nonce-000']) {
    const response = await request('/api/v1/devices', {
      headers: { host: `127.0.0.1:${port}`, 'x-pocket-relay': marker },
    });
    assert.equal(response.status, 403, `marker=${marker.slice(0, 6)}… 不该放行`);
    assert.equal(payload(response).error.code, 'loopback_only');
  }
});

test('对照组：本机不带中继标记时 /pair 正常返回 200', async () => {
  const response = await request('/pair', { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(response.status, 200, '这条不过就说明前面的 403 没有意义');
  assert.match(String(response.headers['content-type']), /text\/html/u);
  // 用页面上真正稳定的锚点：页面标题是「手机连接」，而且必然教用户用口令登录。
  assert.match(response.body, /手机连接/u);
  assert.match(response.body, /口令/u);
});

test('safeJoin 挡住真实 HTTP 穿越：/app/..%2f..%2fsecret.txt 拿不到 webRoot 外的文件', async () => {
  // 地面真值：被穿越的文件确实存在，否则这条用例就没有证明力。
  assert.ok((await stat(path.join(tmp, 'secret.txt'))).isFile());

  // 这两条真的走到了 safeJoin（URL 解析不会折叠 `%2f`），服务端必须回落到 index.html。
  for (const target of [
    '/app/..%2f..%2fsecret.txt',
    '/app/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/app/..%2fsecret.txt',
  ]) {
    const response = await request(target);
    assert.ok(!response.body.includes(SECRET), `${target} 读到了 webRoot 外的文件`);
    assert.equal(response.status, 200, `${target} 应回落到 index.html`);
    assert.match(response.body, new RegExp(FALLBACK, 'u'));
  }
  // `%2e%2e` 与裸 `../` 会被 URL 解析器自己折叠掉（`/app/%2e%2e/x` 变成 `/x`），
  // 请求根本走不到 /app/ 分支，于是 404 —— 同样拿不到秘密。
  for (const target of ['/app/%2e%2e/secret.txt', '/app/../../etc/passwd', '/app/a/../../secret.txt']) {
    const response = await request(target);
    assert.ok(!response.body.includes(SECRET), `${target} 读到了 webRoot 外的文件`);
    assert.equal(response.status, 404, `${target} 被解析器归一化后应是 404`);
    assert.ok(!response.body.includes('root:'));
  }
});

test('铸出真令牌后同样的路由不再 401（证明前面的 401 是鉴权造成的）', async () => {
  // 配对码接口已删除：设备令牌直接由 core 铸，不再经过任何 HTTP 配对步骤。
  const minted = core.mintDevice({ name: 'E2E 手机', platform: 'test' });
  const token = minted.token;
  assert.match(token, /^dshb_/u);

  const me = await request('/api/v1/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  assert.equal(payload(me).data.device.id, minted.device.id);

  const tasks = await request('/api/v1/tasks', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(tasks.status, 200);
  const list = payload(tasks);
  assert.equal(list.ok, true);
  assert.deepEqual(list.data.tasks, [], '没有宿主服务时任务列表应为空而不是 500');

  // 令牌错了还是 401，鉴权和内容无关。
  const wrong = await request('/api/v1/me', { headers: { authorization: 'Bearer dshb_wrong_token_000000000000' } });
  assert.equal(wrong.status, 401);
});
