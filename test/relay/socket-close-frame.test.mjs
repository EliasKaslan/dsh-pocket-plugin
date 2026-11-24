/**
 * 隧道关闭帧必须带 `psid`（R2）—— `lib/cloud.mjs` 的 `socket.on('close')`。
 *
 * 手机端（`remote/remote.js`）判断「被关掉的是不是我自己这一页」有两条判据：
 * 隧道 id 命中本页，或者关闭帧上的 `psid` 等于本页 sid。后者是补救路径 ——
 * 手机本地已经把这条隧道从表里删掉时，id 判据会落空，只剩 psid 能认领。
 *
 * 旧代码的顺序是错的：
 *
 *     this.socketPage.delete(id);
 *     ...
 *     this.publish({ t: 'ws.close', ..., psid: this.socketPage.get(id) ?? '' });
 *
 * 读的时候条目已经被删了，`psid` 恒为空串 → 手机不认输 → 接着反抢 →
 * 1000/4002 交替的乒乓，表现为"页面在几张卡片之间反复横跳、隧道建了又断"。
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

test('上游关闭隧道（4002）：ws.close 帧必须原样带回 psid', () => {
  const { link, sent } = makeLink();
  const created = stubSocket(link);

  link.handleSocketOpen({ id: 'ab12cd34', sid: 'page0001', path: '/ws' });
  created[0].emit('open');
  sent.length = 0;

  // 桥自己关的隧道（例如被同页面的新连接顶掉）：code 4002。
  created[0].readyState = 3;
  created[0].emit('close', 4002, 'replaced by newer tunnel');

  const close = decodeAll(link, sent).find((message) => message.t === 'ws.close');
  assert.ok(close !== undefined, '必须回一条 ws.close');
  assert.equal(close.id, 'ab12cd34');
  assert.equal(close.code, 4002);
  assert.equal(close.psid, 'page0001', 'psid 必须在删除之前读出来（旧代码恒为空串）');
  assert.equal(link.socketPage.has('ab12cd34'), false, 'socketPage 仍然要被清理，不能泄漏');
});

test('没有 sid 的隧道（本机直连 / 旧外壳）：psid 是空串，不是乱码', () => {
  const { link, sent } = makeLink();
  const created = stubSocket(link);

  link.handleSocketOpen({ id: 'bbbb2222', path: '/ws' });
  created[0].emit('open');
  sent.length = 0;
  created[0].readyState = 3;
  created[0].emit('close', 1006, '');

  const close = decodeAll(link, sent).find((message) => message.t === 'ws.close');
  assert.equal(close?.psid, '', '没有页面标识时就是空串');
});

test('手机主动关掉的隧道不再回 ws.close（避免重复帧）', () => {
  const { link, sent } = makeLink();
  const created = stubSocket(link);

  link.handleSocketOpen({ id: 'cccc3333', sid: 'page0002', path: '/ws' });
  created[0].emit('open');

  // handleSocketClose 先从表里删掉再关 socket：随后的 close 事件 known=false。
  link.handleSocketClose({ id: 'cccc3333' });
  sent.length = 0;
  created[0].emit('close', 1000, 'client closed');

  assert.equal(decodeAll(link, sent).some((message) => message.t === 'ws.close'), false,
    '手机自己关的隧道不该再收到一条 ws.close');
});

/**
 * R6：四个 emit 点必须**都**带 psid，且都要先取 psid 再删表。
 * 旧代码缺两处：`closeAllSockets`（先 socketPage.delete 再发，取也取不到）与
 * `handleSocketOpen` 的墓碑分支（直接 publish 一个没有 psid 的帧）。
 */
test('R6：closeAllSockets 的 ws.close 必须带 psid（旧代码先删表 → 恒为空串）', () => {
  const { link, sent } = makeLink();
  const created = stubSocket(link);

  link.handleSocketOpen({ id: 'dddd4444', sid: 'page0004', path: '/ws' });
  created[0].emit('open');
  sent.length = 0;

  link.closeAllSockets('云端连接中断');
  const close = decodeAll(link, sent).find((message) => message.t === 'ws.close' && message.id === 'dddd4444');
  assert.ok(close !== undefined, '必须回一条 ws.close');
  assert.equal(close.psid, 'page0004', 'psid 必须带出来，否则手机认不出被关的是自己这一页');
  assert.equal(close.code, 1001);
  assert.equal(link.socketPage.has('dddd4444'), false, 'socketPage 仍然要清理，不能泄漏');
});

test('R6：墓碑分支的 ws.close 也要带 psid（从迟到 ws.open 的 sid 取）', () => {
  const { link, sent } = makeLink();
  const created = stubSocket(link);

  link.handleSocketOpen({ id: 'eeee5555', sid: 'page0005', path: '/ws' });
  created[0].emit('open');
  link.handleSocketClose({ id: 'eeee5555' }); // 手机主动关：条目已删，只剩墓碑
  sent.length = 0;

  link.handleSocketOpen({ id: 'eeee5555', sid: 'page0005', path: '/ws' }); // 迟到的重开
  const close = decodeAll(link, sent).find((message) => message.t === 'ws.close');
  assert.ok(close !== undefined);
  assert.equal(close.psid, 'page0005', '墓碑分支以前完全不带 psid');
  assert.equal(link.sockets.size, 0, '仍然不许建链');
});
