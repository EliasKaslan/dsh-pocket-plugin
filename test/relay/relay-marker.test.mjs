/**
 * 安全性质 5：中继标记（RELAY_HEADER / RELAY_MARK）——提权防护。
 *
 * 故事背景：电脑上的本机 API 把「来自 127.0.0.1」当成最高权限（配对页、设备管理、
 * 中继管理都只信回环）。中继会把手机请求从 127.0.0.1 发出去，所以必须有一个
 * **手机伪造不了**的标记把这类请求标成「远程」：
 *   - lib/cloud.mjs 的 `buildForwardHeaders()` 先丢弃客户端自带的同名头，再注入
 *     进程级 nonce（手机无法猜到/伪造）；
 *   - lib/server.mjs 的 `stripRelayHeader()` 只要看到该头就无条件打上 RELAY_MARK 并
 *     删除该头；值不对也按远程处理（fail closed）；
 *   - lib/core.mjs 的 `isLoopbackRequest()` 见到 RELAY_MARK 就返回 false。
 * 这三段用真实实现串起来测，正反两例都要有。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudLink, RELAY_HEADER } from '../../lib/cloud.mjs';
import { RELAY_MARK } from '../../lib/util.mjs';
import { BridgeCore } from '../../lib/core.mjs';
import { BridgeServer } from '../../lib/server.mjs';
import { decodeLast, identityFor, makeLink, makeLogger, stubFetch, tempDir, waitFor } from './_support/fixtures.mjs';

const LOOPBACK_IP = '127.0.0.1';
const REMOTE_IP = '192.168.1.99';
const HOST = '127.0.0.1:47901';

test('转发的请求一定带进程 nonce，客户端自带的同名头被丢弃（不能伪造）', () => {
  const relayNonce = 'nonce-from-bridge-0123456789';
  const { link } = makeLink({ relayNonce });

  const headers = link.buildForwardHeaders({
    'x-pocket-relay': 'forged-by-phone',
    'X-Pocket-Relay': 'forged-too',
    'x-forwarded-for': '203.0.113.7',
    'x-forwarded-host': 'evil.example',
    'sec-websocket-key': 'abc',
    host: 'evil.example',
    connection: 'keep-alive',
    forwarded: 'for=1.2.3.4',
    via: 'proxy',
    'content-type': 'application/json',
  });

  assert.equal(RELAY_HEADER, 'x-pocket-relay');
  assert.equal(headers[RELAY_HEADER], relayNonce, '必须是进程 nonce，而不是手机给的值');
  assert.ok(!Object.values(headers).includes('forged-by-phone'));
  assert.ok(!Object.values(headers).includes('forged-too'));
  // 逐跳头、转发提示头、Host、WebSocket 握手头都不许透传。
  for (const dropped of ['host', 'connection', 'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'sec-websocket-key']) {
    assert.equal(headers[dropped], undefined, `${dropped} 不该被转发`);
  }
  assert.equal(headers['content-type'], 'application/json');
});

test('头数量与长度受限：>32 个只留前 32 个（外加标记），超长值丢弃', () => {
  const { link } = makeLink({ relayNonce: 'n'.repeat(43) });
  const source = {};
  for (let index = 0; index < 40; index += 1) source[`x-custom-${index}`] = 'v';
  source['x-huge'] = 'x'.repeat(8 * 1024 + 1);
  source['x-array'] = ['a', 'b'];
  source['x-number'] = 7;

  const headers = link.buildForwardHeaders(source);
  const keys = Object.keys(headers);
  assert.equal(keys.length, 33, '32 个客户端头 + 1 个标记');
  assert.equal(headers[RELAY_HEADER], link.relayNonce);
  assert.equal(headers['x-huge'], undefined, '超长头的值必须丢弃');
  assert.equal(headers['x-array'], undefined, '非字符串头必须丢弃');
  assert.equal(headers['x-number'], undefined);
});

test('未注入 nonce 时自行生成：长度足够、实例之间不同', () => {
  const first = new CloudLink({ localPort: 1, identity: identityFor(), allowAnonymous: true });
  const second = new CloudLink({ localPort: 1, identity: identityFor(), allowAnonymous: true });
  assert.notEqual(first.relayNonce, second.relayNonce, '两个实例不能共用同一个标记');
  assert.ok(first.relayNonce.length >= 32);
  assert.equal(first.relayNonceFromConfig, false);
  assert.equal(new CloudLink({
    localPort: 1, identity: identityFor(), allowAnonymous: true, relayNonce: 'injected-nonce',
  }).relayNonceFromConfig, true);
  // 状态页可以看「标记来源」，但绝不能把 nonce 本身吐出去。
  assert.ok(!JSON.stringify(first.status()).includes(first.relayNonce), '状态里泄漏了 relay nonce');
});

test('端到端：被转发的请求头里带真实 nonce，手机伪造的值一个字节都到不了本机 API', async () => {
  const relayNonce = 'marker-e2e-nonce-0123456789';
  const { link, sent } = makeLink({ relayNonce });
  const stub = stubFetch();
  try {
    await link.handleRequest({
      id: 'marker-req',
      method: 'GET',
      path: '/api/v1/me',
      headers: {
        'x-pocket-relay': 'forged-by-phone',
        'x-forwarded-for': '203.0.113.7',
        authorization: 'Bearer token',
      },
    });
    assert.equal(stub.calls.length, 1);
    const forwarded = stub.calls[0].init.headers;
    assert.equal(forwarded[RELAY_HEADER], relayNonce);
    assert.equal(forwarded['x-forwarded-for'], undefined);
    assert.equal(forwarded.authorization, 'Bearer token', '正常头要照样透传');
    assert.ok(!JSON.stringify(forwarded).includes('forged-by-phone'));

    // 请求真的回了 res（也证明转发链路完整走完）。
    assert.ok(await waitFor(() => sent.length === 1));
    assert.equal(decodeLast(link, sent).id, 'marker-req');
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------------------- */
/* 真实 BridgeCore + BridgeServer：isLoopbackRequest / stripRelayHeader      */
/* ------------------------------------------------------------------------- */

const tmp = tempDir();
let core;
let server;
let logger;

function boot() {
  logger = makeLogger();
  const home = `${tmp.dir}/home`;
  const dataDir = `${home}/pocket`;
  core = new BridgeCore({}, {
    home, dataDir, port: 47901,
  }, logger);
  // 只构造、不 listen：本文件不占端口、不发请求。
  server = new BridgeServer(core, { logger, webRoot: `${tmp.dir}/web` });
}

function req({ ip = LOOPBACK_IP, host = HOST, headers = {} } = {}) {
  return { socket: { remoteAddress: ip }, headers: { host, ...headers } };
}

test.before(() => { boot(); });
test.after(() => {
  try { server?.close(); } catch { /* 已经关了 */ }
  try { core?.dispose(); } catch { /* 已经关了 */ }
  tmp.cleanup();
});

test('回环请求（无标记）被判为 loopback（正例对照）', () => {
  const plain = req();
  assert.equal(core.isLoopbackRequest(plain), true);
  assert.equal(core.loopbackDeniedReason(plain), '');
  const stripped = req();
  assert.equal(server.stripRelayHeader(stripped), false, '没带标记就不算中继流量');
  assert.equal(core.isLoopbackRequest(stripped), true);
});

test('带合法中继标记 → 不是回环请求（手机拿到电脑的全权就是提权）', () => {
  const marked = req({ headers: { [RELAY_HEADER]: core.relayNonce } });
  assert.equal(server.stripRelayHeader(marked), true, '合法 nonce 应被识别');
  assert.equal(marked.headers[RELAY_HEADER], undefined, '标记必须被无条件删除，防止下游再被骗一次');
  assert.equal(marked[RELAY_MARK], true, '必须留下「这是中继流量」的记号');
  assert.equal(core.isLoopbackRequest(marked), false, '中继流量不许被当成回环请求');
  assert.equal(core.loopbackDeniedReason(marked), 'relay');
});

test('伪造的中继标记 → 仍然按远程处理（fail closed），并落警告', () => {
  const before = logger.lines.length;
  const forged = req({ headers: { [RELAY_HEADER]: 'forged-nonce-000' } });
  assert.equal(server.stripRelayHeader(forged), false);
  assert.equal(forged.headers[RELAY_HEADER], undefined, '值不对也要删除该头');
  assert.equal(forged[RELAY_MARK], true);
  assert.equal(core.isLoopbackRequest(forged), false);
  assert.ok(logger.lines.slice(before).some((line) => line.includes('relay 标记无效')));
  assert.ok(!logger.lines.join('\n').includes(core.relayNonce), '日志里不能出现真实 nonce');
});

test('标记值的异常形态（空串 / 数组 / 只差一个字符）都按远程处理', () => {
  for (const value of ['', ['a', 'b'], `${core.relayNonce}x`, core.relayNonce.slice(0, -1)]) {
    const header = req({ headers: { [RELAY_HEADER]: value } });
    assert.equal(server.stripRelayHeader(header), false, `值 ${JSON.stringify(value)} 不该通过`);
    assert.equal(header[RELAY_MARK], true);
    assert.equal(core.isLoopbackRequest(header), false);
  }
});

test('即使 nonce 全对，来自非回环 socket 的请求也不是 loopback', () => {
  const remote = req({ ip: REMOTE_IP, headers: { [RELAY_HEADER]: core.relayNonce } });
  server.stripRelayHeader(remote);
  assert.equal(core.isLoopbackRequest(remote), false);
  // 对照：同一台机器、同一个头，只是 socket 是回环。
  const local = req({ headers: { [RELAY_HEADER]: core.relayNonce } });
  server.stripRelayHeader(local);
  assert.equal(core.isLoopbackRequest(local), false, '中继流量在任何 socket 上都不是 loopback');
});

test('Host 不对（DNS rebinding）→ 不是 loopback；完全没 socket 也不崩', () => {
  assert.equal(core.isLoopbackRequest(req({ host: 'evil.example' })), false);
  assert.equal(core.isLoopbackRequest(req({ host: '192.168.1.50:47901' })), false);
  assert.equal(core.isLoopbackRequest(undefined), false);
  assert.equal(core.isLoopbackRequest({}), false);
});
