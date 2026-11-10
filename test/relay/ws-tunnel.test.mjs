/**
 * WS 隧道（lib/cloud.mjs 的 ws.open / ws.msg / ws.close 状态机）。
 *
 * 这里全部用「假 socket」直接占位，**绝不 new 真 WebSocket**：一旦真的建链，
 * 就会连 127.0.0.1:<port>，测试既不稳定也违背「不联网」。所以只测纯状态部分：
 * 批量收发、槽位回收、错误帧、关停清理。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeAll, makeLink } from './_support/fixtures.mjs';

const OPEN = 1;
const CLOSED = 3;
const ID = 'ab12cd34';

function fakeSocket({ readyState = OPEN, throwOnSend = false } = {}) {
  const sent = [];
  const closed = [];
  return {
    sent,
    closed,
    readyState,
    send(payload) {
      if (throwOnSend) throw new Error('socket is gone');
      sent.push(payload);
      return true;
    },
    close(code, reason) { closed.push({ code, reason }); },
  };
}

test('下行帧批量合并：满 24 帧立即发一帧，不足 24 帧等 40ms 定时器', async () => {
  const { link, sent } = makeLink();
  const socket = fakeSocket();
  link.sockets.set(ID, socket);
  link.socketActivity.set(ID, Date.now());

  for (let index = 0; index < 24; index += 1) {
    link.queueSocketFrame(ID, { data: `frame-${index}`, bin: false });
  }
  assert.equal(sent.length, 1, '满一批就该立刻 flush');
  const batch = decodeAll(link, sent)[0];
  assert.equal(batch.t, 'ws.msg');
  assert.equal(batch.id, ID);
  assert.equal(batch.frames.length, 24);
  assert.equal(batch.frames[0].data, 'frame-0');
  assert.equal(link.wsBuckets.has(ID), false, 'flush 之后桶必须删掉，否则每隧道漏一个');

  // 不足一批：40ms 后自动 flush。
  link.queueSocketFrame(ID, { data: 'single', bin: true });
  assert.equal(sent.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(sent.length, 2);
  const late = decodeAll(link, sent).at(-1);
  assert.equal(late.frames.length, 1);
  assert.equal(late.frames[0].bin, true);
});

test('空桶 flush 不发空帧，并顺手删掉桶', () => {
  const { link, sent } = makeLink();
  link.wsBuckets.set(ID, { frames: [], timer: undefined });
  link.flushSocket(ID);
  assert.equal(sent.length, 0);
  assert.equal(link.wsBuckets.has(ID), false);

  // 完全没有桶时 flush 是 no-op，不抛错。
  assert.doesNotThrow(() => link.flushSocket('ffffffff'));
});

test('上行帧：文本直传；二进制按 base64 解码；socket 不在 OPEN 状态就丢弃', () => {
  const { link } = makeLink();
  const socket = fakeSocket();
  link.sockets.set(ID, socket);
  link.socketActivity.set(ID, 0);

  link.handleSocketMessage({ id: ID, data: 'hello' });
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0], 'hello');
  assert.ok(link.socketActivity.get(ID) > 0, '上行也要刷新活动时间');

  link.handleSocketMessage({ id: ID, bin: true, data: Buffer.from('binary!').toString('base64') });
  assert.equal(Buffer.isBuffer(socket.sent[1]), true);
  assert.equal(socket.sent[1].toString('utf8'), 'binary!');

  // 未登记的 id / 非 OPEN 的 socket：丢弃，不抛错。
  link.handleSocketMessage({ id: 'ffffffff', data: 'x' });
  const closed = fakeSocket({ readyState: CLOSED });
  link.sockets.set('eeeeeeee', closed);
  link.handleSocketMessage({ id: 'eeeeeeee', data: 'x' });
  assert.equal(closed.sent.length, 0);
  // 超大帧（>4MiB）直接丢，不往隧道里塞。
  const before = socket.sent.length;
  link.handleSocketMessage({ id: ID, data: 'x'.repeat(4 * 1024 * 1024 + 1) });
  assert.equal(socket.sent.length, before);
});

test('send 抛错只记 warning，不能把转发链路打崩', () => {
  const { link, logger } = makeLink();
  const socket = fakeSocket({ throwOnSend: true });
  link.sockets.set(ID, socket);
  assert.doesNotThrow(() => link.handleSocketMessage({ id: ID, data: 'boom' }));
  assert.ok(logger.lines.some((line) => line.includes('cloud ws send failed')));
});

test('ws.close / closeAllSockets 会真的关 socket、清槽位、清桶并通知手机', () => {
  const { link, sent } = makeLink();
  const first = fakeSocket();
  const second = fakeSocket();
  link.sockets.set('11111111', first);
  link.sockets.set('22222222', second);
  link.socketActivity.set('11111111', Date.now());
  link.socketActivity.set('22222222', Date.now());
  link.queueSocketFrame('11111111', { data: 'pending', bin: false });

  link.handleSocketClose({ id: '11111111' });
  assert.equal(first.closed[0].code, 1000);
  assert.equal(link.sockets.has('11111111'), false);
  assert.equal(link.socketActivity.has('11111111'), false);
  assert.equal(link.wsBuckets.has('11111111'), false, '关隧道时残留的批量帧要清掉');

  // 未登记的 id：no-op。
  assert.doesNotThrow(() => link.handleSocketClose({ id: '99999999' }));

  link.closeAllSockets('云端连接中断');
  assert.equal(second.closed[0].code, 1001);
  assert.equal(second.closed[0].reason, '云端连接中断');
  assert.equal(link.sockets.size, 0);
  const closes = decodeAll(link, sent).filter((message) => message.t === 'ws.close');
  assert.equal(closes.at(-1).id, '22222222');
  assert.equal(closes.at(-1).code, 1001);
});

test('僵尸隧道回收：1 小时无活动的被清掉，活跃的不动', () => {
  const { link, sent } = makeLink();
  const now = Date.now();
  const stale = fakeSocket();
  const steady = fakeSocket();
  link.sockets.set('11111111', stale);
  link.sockets.set('22222222', steady);
  link.socketActivity.set('11111111', now - 60 * 60 * 1000 - 1);
  link.socketActivity.set('22222222', now - 1000);

  link.sweepSockets(now);
  assert.equal(link.sockets.has('11111111'), false);
  assert.equal(link.sockets.has('22222222'), true);
  assert.equal(stale.closed[0].code, 1001);
  assert.equal(decodeAll(link, sent).at(-1).reason, 'idle timeout');
});

test('evictSocket 按给定 code/reason 关闭并广播；touchSocket 只认已登记 id', () => {
  const { link, sent } = makeLink();
  const socket = fakeSocket();
  link.sockets.set(ID, socket);
  link.socketActivity.set(ID, 1);

  link.evictSocket(ID, 'evicted for a new channel');
  assert.equal(socket.closed[0].code, 1001);
  assert.equal(socket.closed[0].reason, 'evicted for a new channel');
  const frame = decodeAll(link, sent).at(-1);
  assert.equal(frame.t, 'ws.close');
  assert.equal(frame.reason, 'evicted for a new channel');

  link.touchSocket('not-registered');
  assert.equal(link.socketActivity.has('not-registered'), false);
});

test('ws.open 的拒绝分支：id 非法 / 路径不是 /ws / 重复 open', () => {
  const { link, sent } = makeLink();

  // id 形状非法：直接忽略，连错误帧都不回（手机本就该被自己的 id 挡住）。
  link.handleSocketOpen({ id: 'bad', path: '/ws' });
  link.handleSocketOpen({ id: 'ZZZZZZZZ', path: '/ws' });
  assert.equal(sent.length, 0);
  assert.equal(link.sockets.size, 0);

  // 路径不是 /ws：回 ws.error 'bad path'，且不建链。
  link.handleSocketOpen({ id: ID, path: '/api/v1/health' });
  assert.deepEqual(decodeAll(link, sent).at(-1), { t: 'ws.error', id: ID, message: 'bad path' });
  assert.equal(link.sockets.size, 0);

  // 已存在的 OPEN 隧道：重发 ack（丢包重试），不新建第二条。
  const socket = fakeSocket();
  link.sockets.set(ID, socket);
  link.socketActivity.set(ID, Date.now());
  link.handleSocketOpen({ id: ID, path: '/ws' });
  assert.deepEqual(decodeAll(link, sent).at(-1), { t: 'ws.open', id: ID });
  assert.equal(link.sockets.size, 1);

  // 已存在但已关闭：不 ack、不新建（等它自己从表里消失）。
  link.sockets.set('eeeeeeee', fakeSocket({ readyState: CLOSED }));
  const before = sent.length;
  link.handleSocketOpen({ id: 'eeeeeeee', path: '/ws' });
  assert.equal(sent.length, before);
});

test('sweep() 统一巡检：socket / 半开分片 / 序号表都会被清理', () => {
  const { link } = makeLink();
  const now = Date.now();
  link.sockets.set('11111111', fakeSocket());
  link.socketActivity.set('11111111', now - 2 * 60 * 60 * 1000);
  link.parts.set('part:aabbccddeeff', { chunks: [], total: 2, at: now - 31_000 });
  link.parts.set('part:111122223333', { chunks: [], total: 2, at: now });
  link.lastSeq.set('req:aaaaaaaa', { seq: 1, at: now - 11 * 60 * 1000 });
  link.lastSeq.set('req:bbbbbbbb', { seq: 1, at: now });

  link.sweep(now);
  assert.equal(link.sockets.size, 0);
  assert.equal(link.parts.has('part:aabbccddeeff'), false, '过期半开分片必须清掉');
  assert.equal(link.parts.has('part:111122223333'), true);
  assert.equal(link.lastSeq.has('req:aaaaaaaa'), false, '过期序号必须清掉');
  assert.equal(link.lastSeq.has('req:bbbbbbbb'), true);
});
