/**
 * `Realtime` 建隧道时的**取票往返次数**（这就是"省一次往返"的可断言证据）。
 *
 * 改前：每次建隧道都现取票 —— `POST /api/v1/ws-ticket` 一次 + `/ws` 升级一次 =
 * 两次串行往返。单向 300 ms 下实测换票 p50 648 ms、升级 p50 632 ms（见
 * `test/integration/open-session-rtt.test.mjs` 的对照表）。
 * 改后：票由 `WsTicketCache` 预热，建隧道**只剩升级那一次**；隧道一开就在后台补
 * 下一张，所以第二次重建的取票次数仍是 0。
 *
 * 这里用计数桩统计"每次 connect() 真的发了几次取票请求"，而不是断言源码里有没有
 * `reserveTicket()`：把 `net.js` 退回"每次现取"，本文件的用例会红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Realtime, WsTicketCache } from '../../web/lib/net.js';

/** 假的 WebSocket：记录握手 URL，index 决定打开时机（同步返回，让调用方先赋值）。 */
class FakeSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = String(url);
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.instances.push(this);
    // 异步 open：connect() 里 `this.socket = socket` 必须先跑完。
    setTimeout(() => {
      if (this.readyState !== FakeSocket.CONNECTING) return;
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data) { this.sent.push(data); }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

/** 这一段用例里造出来的 Realtime，收尾时统一 stop（否则重连定时器会把进程挂住）。 */
let live = [];

/** 把 `WebSocket` 换成假件跑一段用例，结束时一定还原并停掉所有连接。 */
async function withFakeSocket(run) {
  const real = globalThis.WebSocket;
  FakeSocket.instances = [];
  live = [];
  globalThis.WebSocket = FakeSocket;
  try {
    return await run();
  } finally {
    for (const instance of live) {
      try { instance.stop(); } catch { /* 已经停了 */ }
    }
    live = [];
    globalThis.WebSocket = real;
  }
}

/** 等一下 makrotask：让 onopen → prewarm 这类异步尾巴跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * 造一个 Realtime：`api` 是计数桩，记下每条路径被要了几次。
 *
 * 返回的 `ticketHits` 就是"建隧道总共花了几次取票往返"。
 */
function makeRealtime({ tickets = null } = {}) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === '/api/v1/ws-ticket') return { ticket: `wst_${calls.length}`, expiresAt: Date.now() + 60_000 };
    return {};
  };
  const realtime = new Realtime({
    api,
    getBase: () => 'https://dsh-remote.invalid',
    getToken: () => 'device-token',
    allowSse: false,
    tickets,
    onFrame: () => {},
    onState: () => {},
  });
  live.push(realtime);
  return {
    realtime,
    calls,
    get ticketHits() { return calls.filter((path) => path === '/api/v1/ws-ticket').length; },
  };
}

test('改前基线：没有票缓存时，每次连隧道都现取一次票（1 次取票往返）', async () => {
  await withFakeSocket(async () => {
    // 注意不要解构 `ticketHits`：它是 getter，解构会在那一刻取一次快照。
    const handle = makeRealtime();
    handle.realtime.start();
    await settle();
    assert.equal(handle.realtime.state, 'online');
    assert.equal(handle.ticketHits, 1, '现取票路径：一次 connect 必须且只能发一次 POST /ws-ticket');
    assert.equal(FakeSocket.instances.length, 1);
    assert.match(FakeSocket.instances[0].url, /\/ws\?ticket=wst_1/u);
    handle.realtime.stop();
  });
});

test('改后：票已预热时，connect() 的取票往返降到 0（只剩 /ws 升级）', async () => {
  await withFakeSocket(async () => {
    const tickets = new WsTicketCache({
      fetchTicket: () => Promise.resolve({ ticket: 'wst_prewarmed', expiresAt: Date.now() + 60_000 }),
    });
    await tickets.prewarm();
    const handle = makeRealtime({ tickets });
    handle.realtime.start();
    await settle();
    assert.equal(handle.realtime.state, 'online');
    assert.equal(handle.ticketHits, 0, '票已预热：这次 connect 不该再发取票请求（省一次往返）');
    assert.match(FakeSocket.instances[0].url, /\/ws\?ticket=wst_prewarmed/u, '必须用预热那张票去升级');
    handle.realtime.stop();
    tickets.stop();
  });
});

test('两次隧道重建只花一次取票往返：第一次用预热票，第二次用后台补的那张', async () => {
  await withFakeSocket(async () => {
    let minted = 0;
    const tickets = new WsTicketCache({
      fetchTicket: () => {
        minted += 1;
        return Promise.resolve({ ticket: `wst_${minted}`, expiresAt: Date.now() + 60_000 });
      },
    });
    await tickets.prewarm(); // 开机预热（第 1 张）
    const handle = makeRealtime({ tickets });
    const { realtime } = handle;

    realtime.start();
    await settle();
    assert.equal(realtime.state, 'online');
    assert.match(FakeSocket.instances[0].url, /\/ws\?ticket=wst_1/u);
    assert.equal(handle.realtime.state, 'online');
    // 隧道打开后 net.js 会在后台补下一张。
    await settle();
    assert.equal(tickets.stats.cached, true, '隧道打开之后必须补一张备用票');

    // 第二次重建（息屏唤醒 / 切网 / 看门狗判死都走这条）。
    realtime.forceKick();
    await settle();
    assert.equal(realtime.state, 'online');
    assert.match(FakeSocket.instances[1].url, /\/ws\?ticket=wst_2/u, '第二次重建必须用后台补的那张票');
    assert.equal(handle.ticketHits, 0, '两次重建都没有走"现取票"那条路');
    // 3 张 = 开机预热 1 张 + 每次隧道打开后**后台**补 1 张；关键路径上一条都没有。
    assert.equal(minted, 3, '票全是后台补的：两次重建的关键路径上没有取票往返');
    realtime.stop();
    tickets.stop();
  });
});

test('票缓存取不到票时，连接按失败处理并退避重连（不静默卡在 connecting）', async () => {
  await withFakeSocket(async () => {
    const tickets = new WsTicketCache({ fetchTicket: () => Promise.resolve(null) });
    const { realtime } = makeRealtime({ tickets });
    realtime.start();
    await settle();
    assert.equal(realtime.state, 'offline', '取不到票必须离开 connecting 并进入重试');
    assert.equal(FakeSocket.instances.length, 0, '没有票就不该去握手（省一次注定失败的往返）');
    realtime.stop();
    tickets.stop();
  });
});
