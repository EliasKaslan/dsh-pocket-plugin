/**
 * 安全性质 3：资源上限（lib/cloud.mjs）。
 *
 * MAX_FRAME / MAX_FRAME_TOTAL / MAX_BODY_BYTES / MAX_SOCKETS / LOGIN_BUDGET
 * 都是「一条被泄的链接能把电脑拖垮到什么程度」的边界。每条都做正反两例：
 * 恰好在上限内 → 放行；超一个字节/一个槽位/一次预算 → 明确拒绝（不是崩溃、
 * 不是静默截断、更不是继续放行）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_FRAME } from '../../lib/cloud.mjs';
import { decodeAll, feed, frameFor, makeLink, makePeer, stubFetch, waitFor } from './_support/fixtures.mjs';

const BASE_OBJ = { t: 'hello', name: 'limits', pad: '' };
const BASE_LEN = Buffer.byteLength(JSON.stringify(BASE_OBJ), 'utf8');
const jsonOfSize = (size) => ({ t: 'hello', name: 'limits', pad: 'x'.repeat(size - BASE_LEN) });

function fakeSocket() {
  const record = { closed: 0, code: 0, reason: '' };
  return {
    record,
    readyState: 1, // WebSocket.OPEN
    send() {},
    close(code, reason) { record.closed += 1; record.code = code; record.reason = String(reason ?? ''); },
  };
}

test('单帧上限 64KiB：恰好 MAX_FRAME 走单帧，+1 字节拆包', () => {
  const { link, sent } = makeLink();
  assert.equal(MAX_FRAME, 64 * 1024);

  const exact = jsonOfSize(MAX_FRAME);
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), MAX_FRAME);
  assert.equal(link.publish(exact), true);
  assert.equal(sent.length, 1, '恰好等于上限的单帧不该被拆分');

  sent.length = 0;
  const over = jsonOfSize(MAX_FRAME + 1);
  assert.equal(link.publish(over), true);
  assert.equal(sent.length, 2, '超上限 1 字节就该拆成 2 片');
  const parts = decodeAll(link, sent);
  assert.deepEqual(parts.map((part) => part.t), ['part', 'part']);
  assert.deepEqual(parts.map((part) => part.seq), [0, 1]);
  assert.equal(parts[0].total, 2);
});

test('收方向单帧上限：2*MAX_FRAME 字节能过长度闸，+1 字节直接拒', () => {
  const { link } = makeLink();
  // 恰好 2*MAX_FRAME：不是被长度闸拦的（栽在信封解析上）。
  assert.throws(
    () => link.onFrame(Buffer.alloc(2 * MAX_FRAME, 0x20)),
    (error) => !/frame too large/u.test(error.message),
  );
  assert.throws(() => link.onFrame(Buffer.alloc(2 * MAX_FRAME + 1, 0x20)), /frame too large/u);
});

test('整包上限 64 帧：64 片照发，第 65 片超预算直接拒且一发不发', () => {
  const { link, sent } = makeLink();
  const atLimit = jsonOfSize(64 * MAX_FRAME);
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit), 'utf8'), 64 * MAX_FRAME);
  assert.equal(link.publish(atLimit), true);
  assert.equal(sent.length, 64, '预算内必须完整发出 64 片');
  assert.equal(link.stats.errors, 0);

  sent.length = 0;
  const over = jsonOfSize(64 * MAX_FRAME + 1);
  const errorsBefore = link.stats.errors;
  assert.equal(link.publish(over), false, '超出整包预算必须拒绝');
  assert.equal(sent.length, 0, '被拒的帧不能泄漏半条消息出去');
  assert.match(link.lastError, /frame too large/u);
  assert.equal(link.stats.errors, errorsBefore + 1);
});

test('分片重组：64KiB 以上的帧被拆成 part，真实 onFrame 能原样拼回', () => {
  const { link, sent } = makeLink();
  const { peer, seen } = makePeer(link);
  const big = jsonOfSize(MAX_FRAME * 2 + 123);

  assert.equal(link.publish(big), true);
  assert.equal(sent.length, 3);
  for (const entry of sent) peer.onFrame(Buffer.from(entry.payload, 'utf8'));

  assert.equal(seen.length, 1, '只该 dispatch 一次（分片本身不算一条消息）');
  assert.deepEqual(seen[0], big);
  assert.equal(peer.stats.rx, 1);
  assert.equal(peer.parts.size, 0, '重组完成后不能留下分片缓存');
});

test('分片上限与分片校验：total>64 / id 非法 / seq 越界 / 数据超长 全部丢弃', () => {
  const { link } = makeLink();
  let dispatched = 0;
  link.dispatch = () => { dispatched += 1; };

  // total 超预算。
  feed(link, { t: 'part', id: 'aabbccddeeff', seq: 0, total: 65, d: 'AAAA' });
  // id 形状不对（必须是 12 位小写 hex）。
  feed(link, { t: 'part', id: 'NOT-HEX', seq: 0, total: 2, d: 'AAAA' });
  // seq 越界 / 负数 / 非整数。
  feed(link, { t: 'part', id: 'aabbccddeeff', seq: 2, total: 2, d: 'AAAA' });
  feed(link, { t: 'part', id: 'aabbccddeeff', seq: -1, total: 2, d: 'AAAA' });
  feed(link, { t: 'part', id: 'aabbccddeeff', seq: 0.5, total: 2, d: 'AAAA' });
  // 单片数据超长：base64 长度 > ceil(MAX_FRAME*4/3)+16（但仍要塞进 2*MAX_FRAME 的帧里）。
  feed(link, { t: 'part', id: 'aabbccddeeff', seq: 0, total: 2, d: 'A'.repeat(87399) });

  assert.equal(dispatched, 0);
  assert.equal(link.parts.size, 0);
});

test('同时打开的分片表不超过 8 个（PART_MAX_OPEN）', () => {
  const { link } = makeLink();
  const ids = Array.from({ length: 9 }, (_value, index) => index.toString(16).padStart(12, '0'));
  for (const id of ids) feed(link, { t: 'part', id, seq: 0, total: 2, d: 'AAAA' });

  assert.equal(link.parts.size, 8, '第 9 个半开分片必须被拒');
  assert.ok(link.stats.errors >= 1);
});

test('请求体上限：超过 8MiB（base64 后）回 413，不转发；上限内照常转发', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  const limitChars = Math.ceil((8 * 1024 * 1024) / 3) * 4;
  try {
    // 反例：超一个字符 → 413 body-too-large，且绝不调用 fetch。
    await link.handleRequest({
      id: 'big-body',
      method: 'POST',
      path: '/api/v1/tasks/task_1/prompt',
      body: 'A'.repeat(limitChars + 1),
    });
    assert.equal(stub.calls.length, 0, '超大 body 不能打到本机 API');
    const refusal = decodeAll(link, sent).find((message) => message.id === 'big-body');
    assert.equal(refusal.status, 413);
    assert.equal(JSON.parse(Buffer.from(refusal.body, 'base64').toString('utf8')).error.code, 'body-too-large');

    // 正例：上限内的小 body 正常转发，且请求体真的被送出去了。
    sent.length = 0;
    await link.handleRequest({
      id: 'small-body',
      method: 'POST',
      path: '/api/v1/tasks/task_1/prompt',
      body: Buffer.from('{"text":"hi"}', 'utf8').toString('base64'),
    });
    assert.equal(stub.calls.length, 1);
    assert.equal(Buffer.from(stub.calls[0].init.body).toString('utf8'), '{"text":"hi"}');
  } finally {
    stub.restore();
  }
});

test('在途请求上限 96：超了回 503 busy，而不是把本机拖死', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    for (let index = 0; index < 97; index += 1) link.pending.set(`seed-${index}`, { at: 0 });
    await link.handleRequest({ id: 'overflow', method: 'GET', path: '/api/v1/health' });
    assert.equal(stub.calls.length, 0);
    const refusal = decodeAll(link, sent).find((message) => message.id === 'overflow');
    assert.equal(refusal.status, 503);
    assert.equal(JSON.parse(Buffer.from(refusal.body, 'base64').toString('utf8')).error.code, 'busy');
    link.clearPending();
  } finally {
    stub.restore();
  }
});

test('WS 槽位上限 12：满员时强制回收最旧一条，不许把手机锁死在 too many channels', () => {
  const { link, sent, logger } = makeLink();
  const now = Date.now();
  for (let index = 0; index < 12; index += 1) {
    const id = index.toString(16).padStart(8, '0');
    link.sockets.set(id, fakeSocket());
    link.socketActivity.set(id, now);
  }

  // 反例（不 force）：刚活动过的 12 条一条都不该被抢。
  assert.equal(link.evictOldestSocket(now), false, '不 force 时保护期内的健康隧道不许动');

  // 正例：满员 + 全在 90 s 保护期内，新 ws.open 仍必须被放行 —— 踢掉最旧的那条。
  // 假 socket 走 `createSocket` 这个注入口：真实建链会连 127.0.0.1:<port>，测试不联网。
  const created = [];
  link.createSocket = (url) => {
    const handler = new Map();
    const socket = {
      url,
      readyState: 1,
      on(event, fn) { handler.set(event, fn); return socket; },
      emit(event, ...args) { handler.get(event)?.(...args); },
      send() {},
      close() {},
    };
    created.push(socket);
    return socket;
  };
  link.handleSocketOpen({ id: 'ffffffff', path: '/ws' });
  const messages = decodeAll(link, sent);
  assert.equal(messages.filter((message) => message.message === 'too many channels').length, 0,
    '槽位满不许再把手机锁在 too many channels');
  const closes = messages.filter((message) => message.t === 'ws.close');
  assert.equal(closes.length, 1, '必须踢掉且只踢掉一条');
  assert.equal(closes[0].id, '00000000', '踢的必须是最旧的那条');
  assert.equal(link.sockets.size, 12, '槽位总数仍受 MAX_SOCKETS 约束');
  assert.equal(link.sockets.has('ffffffff'), true, '新隧道必须建起来');
  assert.ok(logger.lines.some((line) => line.includes('强制回收最旧一条')));
  assert.equal(created.length, 1, '新隧道必须真的尝试建链');

  // 建链成功要给手机回 ack，否则它会以为自己还卡在 CONNECTING。
  created[0].emit('open');
  assert.deepEqual(decodeAll(link, sent).at(-1), { t: 'ws.open', id: 'ffffffff' });

  // 正例：把最老的一条标成 90s 未活动，它才是常规可被抢占的。
  link.sockets.clear();
  link.socketActivity.clear();
  link.closedSocketIds.clear();
  const staleId = (40).toString(16).padStart(8, '0');
  for (let index = 0; index < 12; index += 1) {
    const id = (index + 40).toString(16).padStart(8, '0');
    link.sockets.set(id, fakeSocket());
    link.socketActivity.set(id, now);
  }
  link.socketActivity.set(staleId, now - 91_000);
  assert.equal(link.evictOldestSocket(now), true, '久未活动的隧道必须可以被回收');
  assert.equal(link.sockets.size, 11);
  assert.equal(link.sockets.has(staleId), false);
  const oldest = decodeAll(link, sent).at(-1);
  assert.equal(oldest.t, 'ws.close');
  assert.equal(oldest.id, staleId);
  assert.equal(oldest.code, 1001);

  // 一条都不老时，不 force 的 evictOldestSocket 必须返回 false（不误踢健康隧道）。
  link.sockets.clear();
  link.socketActivity.clear();
  for (let index = 0; index < 12; index += 1) {
    const id = (index + 20).toString(16).padStart(8, '0');
    link.sockets.set(id, fakeSocket());
    link.socketActivity.set(id, now);
  }
  assert.equal(link.evictOldestSocket(now), false);
  assert.equal(link.sockets.size, 12);
});

test('登录预算 10 次 / 60 秒（注入假时钟，不真等）', () => {
  const { link } = makeLink();
  const now = Date.now();
  const results = Array.from({ length: 12 }, () => link.loginAllowed(now));
  assert.equal(results.filter((entry) => entry.ok).length, 10);
  assert.equal(results[10].ok, false);
  assert.ok(results[10].retryAfterSec > 0 && results[10].retryAfterSec <= 60, '要告诉调用方还要等几秒');
  assert.equal(results[11].ok, false);

  // 窗口滑动之后重新放行。
  assert.equal(link.loginAllowed(now + 60_001).ok, true);
});
