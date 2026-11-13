/**
 * `retry()` 必须做与 `'close'` 分支等价的清理（R6）—— `lib/cloud.mjs`。
 *
 * 链路看门狗（`checkLink`）判死时走的是 `retry()`：直接把旧 client `end(true)` 再
 * 重建。问题在于 broker **半死**（TCP 还在、应用层不通）时，MQTT 的 `'close'`
 * 事件根本不会触发 —— 而清理只写在 `'close'` 分支里，于是：
 *   - 12 条 WS 隧道全部变成僵尸，占满槽位（手机从此永远 `too many channels`）；
 *   - 在途 RPC 的 timer 要等满 `RPC_TIMEOUT_MS`（45 s）才超时，手机早就在重试；
 *   - 这段时间里下行帧还在往死管道里发，静默丢失。
 *
 * 所以 `retry()` 里也要 `closeAllSockets` + `clearPending`（连同分片重组表）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeAll, makeLink } from './_support/fixtures.mjs';

const OPEN = 1;

/** 换上假 socket（覆写 `createSocket`）：真建链会连 127.0.0.1:<port>。 */
function stubSocket(link) {
  const created = [];
  link.createSocket = (url) => {
    const handlers = new Map();
    const socket = {
      url,
      readyState: OPEN,
      handlers,
      on(event, fn) { handlers.set(event, fn); return socket; },
      emit(event, ...args) { handlers.get(event)?.(...args); },
      send() {},
      close(code, reason) { socket.closed = { code, reason }; socket.readyState = 3; },
    };
    created.push(socket);
    return socket;
  };
  return created;
}

test('retry()：关掉全部隧道、清掉在途 RPC 与分片表，然后才重连', () => {
  const { link, sent } = makeLink();
  const created = stubSocket(link);

  // 一条活隧道（带 psid，模拟手机页面）。
  link.handleSocketOpen({ id: 'ab12cd34', sid: 'page0001', path: '/ws' });
  created[0].emit('open');
  assert.equal(link.sockets.size, 1);

  // 两条在途 RPC + 一份未拼完的分片。
  link.pending.set('rpc-1', { at: Date.now(), timer: setTimeout(() => {}, 60_000) });
  link.pending.set('rpc-2', { at: Date.now(), timer: setTimeout(() => {}, 60_000) });
  link.parts.set('part:abcdef012345', { chunks: [Buffer.from('x')], total: 2, at: Date.now() });

  let connects = 0;
  link.connect = () => { connects += 1; };
  sent.length = 0;

  const failuresBefore = link.stats.failures;
  link.retry();

  assert.equal(link.sockets.size, 0, 'retry() 必须关掉全部隧道，否则槽位被僵尸占满');
  assert.equal(link.pending.size, 0, '在途 RPC 必须立刻清掉，不能等 45 s 超时');
  assert.equal(link.parts.size, 0, '分片重组表也要清（跨连接拼帧没有意义）');
  assert.equal(created[0].closed?.code, 1001, '隧道要真的被 close(1001)，不是只从表里删掉');
  assert.equal(created[0].closed?.reason, '云端连接中断');
  assert.ok(
    decodeAll(link, sent).some((message) => message.t === 'ws.close' && message.id === 'ab12cd34'),
    '手机要收到 ws.close，否则它会一直以为隧道还在',
  );
  assert.equal(link.stats.failures, failuresBefore + 1, '一次重试记一次失败');
  assert.equal(connects, 1, '清理之后仍然要重连');
});

test('看门狗重建链路时同样清理隧道（broker 半死不会触发 close 事件）', () => {
  const now = Date.now();
  const { link } = makeLink();
  const created = stubSocket(link);

  link.handleSocketOpen({ id: 'aaaa1111', sid: 'page0002', path: '/ws' });
  created[0].emit('open');
  link.pending.set('rpc-3', { at: now, timer: setTimeout(() => {}, 60_000) });

  // 应用层证据全部老旧：connected 仍是 true（TCP 还在），但上行没有 ACK、也没有帧。
  link.connectedAt = now - 120_000;
  link.lastTxAckAt = now - 40_000;
  link.lastRxAt = now - 40_000;
  link.client = { connected: true, publish(_t, _p, _o, cb) { cb?.(); }, end() {} };

  let connects = 0;
  link.connect = () => { connects += 1; };

  assert.equal(link.checkLink(now), false, '第 1 个异常周期只记账');
  assert.equal(link.checkLink(now + 10_000), true, '第 2 个异常周期必须重建');

  assert.equal(connects, 1);
  assert.equal(link.sockets.size, 0, '看门狗重建也必须把僵尸隧道一起收掉');
  assert.equal(link.pending.size, 0, '在途 RPC 同样要清');
});
