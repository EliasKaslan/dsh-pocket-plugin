/**
 * 隧道墓碑（lib/cloud.mjs `closedSocketIds`）的回归测试。
 *
 * 事故：手机上「进页面 → 退页面」时可能先发 `ws.close`、再由重发/乱序送来一条
 * 迟到的 `ws.open`。旧代码在 handleSocketOpen 里只看 this.sockets，于是这条迟到的
 * open 又建了一条新隧道 —— 手机侧的对象已经删了，谁也不会再关它。12 个槽位满了
 * 就 `too many channels`，只能等 10 分钟空闲 sweep，表现为「有时重连要很久」。
 *
 * 全部用假 socket（覆写 `createSocket`）：真建链会连 127.0.0.1:<port>，测试不联网。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeAll, makeLink } from './_support/fixtures.mjs';

const OPEN = 1;
const ID = 'ab12cd34';

/** 换上假 socket 并记录每一次真实的建链尝试。 */
function stubSocket(link) {
  const created = [];
  link.createSocket = (url) => {
    const handler = new Map();
    const socket = {
      url,
      readyState: OPEN,
      handlers: handler,
      on(event, fn) { handler.set(event, fn); return socket; },
      emit(event, ...args) { handler.get(event)?.(...args); },
      send() {},
      close(code, reason) { socket.closed = { code, reason }; socket.readyState = 3; },
    };
    created.push(socket);
    return socket;
  };
  return created;
}

test('墓碑：ws.open → ws.close → 迟到的 ws.open 不许复活孤儿槽位', () => {
  const { link, sent, logger } = makeLink();
  const created = stubSocket(link);

  link.handleSocketOpen({ id: ID, path: '/ws' });
  assert.equal(link.sockets.size, 1, '第一条要建起来');
  assert.equal(created.length, 1);
  created[0].emit('open');
  assert.deepEqual(decodeAll(link, sent).at(-1), { t: 'ws.open', id: ID });

  // 手机主动关掉：PC 记账并立墓碑。
  link.handleSocketClose({ id: ID });
  assert.equal(link.sockets.size, 0);
  assert.equal(link.closedSocketIds.has(ID), true, '关掉的 id 必须留墓碑');

  // 迟到的同 id open：不许建链、不许占槽位，只回一条 ws.close。
  sent.length = 0;
  created.length = 0;
  link.handleSocketOpen({ id: ID, path: '/ws' });
  assert.equal(link.sockets.size, 0, '墓碑内的 id 不许再占槽位');
  assert.equal(created.length, 0, '连建链都不该尝试');
  assert.deepEqual(decodeAll(link, sent), [{ t: 'ws.close', id: ID, code: 1000, reason: 'closed by client' }]);
  assert.ok(logger.lines.some((line) => line.includes('隧道已关闭')), '要留痕，否则孤儿槽位无法从日志定位');
});

test('墓碑覆盖被踢掉的隧道：evict 之后同 id 的 open 也不能复活它', () => {
  const { link, sent } = makeLink();
  const created = stubSocket(link);
  const now = Date.now();
  link.sockets.set(ID, { readyState: OPEN, send() {}, close() {} });
  link.socketActivity.set(ID, now - 91_000);

  assert.equal(link.evictOldestSocket(now), true);
  assert.equal(link.closedSocketIds.has(ID), true);

  sent.length = 0;
  link.handleSocketOpen({ id: ID, path: '/ws' });
  assert.equal(link.sockets.size, 0);
  assert.equal(created.length, 0);
  assert.equal(decodeAll(link, sent).at(-1).t, 'ws.close');
});

test('墓碑超过 TTL 后过期：不把合法的同 id 重开永久堵死', () => {
  const { link } = makeLink();
  const created = stubSocket(link);
  link.burySocket(ID);
  // 把时间戳拨到 TTL 之外：注入时间戳，不真等整个 TTL。
  // 用 200s 而不是 61s：TTL 已抬到 150s（必须 >= 重放窗口 120s）。
  link.closedSocketIds.set(ID, Date.now() - 200_000);

  link.handleSocketOpen({ id: ID, path: '/ws' });
  assert.equal(link.sockets.size, 1, '过期墓碑不许拦住正当重开');
  assert.equal(created.length, 1);
  assert.equal(link.closedSocketIds.has(ID), false, '过期条目顺手清掉，避免只增不减');
});

test('墓碑表有上限：反复开关也不会让它无限增长', () => {
  const { link } = makeLink();
  const last = (199).toString(16).padStart(8, '0');
  for (let index = 0; index < 199; index += 1) link.burySocket(index.toString(16).padStart(8, '0'));
  link.burySocket(last);
  assert.ok(link.closedSocketIds.size <= 48, `墓碑表必须有硬上限（实际 ${link.closedSocketIds.size}）`);
  assert.equal(link.closedSocketIds.has(last), true, '最新写入的那条要留着');
});

test('过期墓碑会被清掉（TTL 之外的 id 不再拦路）', () => {
  const { link } = makeLink();
  const now = Date.now();
  for (let index = 0; index < 50; index += 1) {
    link.closedSocketIds.set(index.toString(16).padStart(8, '0'), now - 200_000);
  }
  link.burySocket('deadbeef');
  assert.ok(link.closedSocketIds.size <= 2, `过期墓碑必须被清掉（实际 ${link.closedSocketIds.size}）`);
  assert.equal(link.closedSocketIds.has('deadbeef'), true);
});

test('closeAllSockets 的墓碑：链路断了之后迟到的 open 不会重建孤儿', () => {
  const { link, sent } = makeLink();
  const created = stubSocket(link);
  link.sockets.set(ID, { readyState: OPEN, send() {}, close() {} });
  link.socketActivity.set(ID, Date.now());

  link.closeAllSockets('云端连接中断');
  assert.equal(link.sockets.size, 0);
  assert.equal(link.closedSocketIds.has(ID), true);

  sent.length = 0;
  link.handleSocketOpen({ id: ID, path: '/ws' });
  assert.equal(link.sockets.size, 0);
  assert.equal(created.length, 0);
  assert.equal(decodeAll(link, sent).at(-1).reason, 'closed by client');
});

test('页面标识透传：ws.open 的 sid 必须变成隧道 URL 上的 psid', () => {
  const { link } = makeLink();
  const created = stubSocket(link);

  link.handleSocketOpen({ id: 'aaaa1111', sid: 'page0001', path: '/ws?since=3' });
  assert.equal(created.length, 1);
  assert.match(created[0].url, /[?&]psid=page0001/u, 'sid 必须透传成 psid，否则桥只能按设备顶掉');
  assert.match(created[0].url, /since=3/u, '原有的查询参数不能被破坏');

  // 没有 sid（旧外壳 / 本机直连）：不许凭空加参数，保持原语义。
  link.handleSocketOpen({ id: 'bbbb2222', path: '/ws' });
  assert.equal(created.length, 2);
  assert.doesNotMatch(created[1].url, /psid=/u);
});