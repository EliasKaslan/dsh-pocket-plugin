/**
 * 「打开会话并进入实时」的**往返次数与耗时**对照（改前 / 改后）。
 *
 * 复用 `test/support/bench-harness.mjs`（只读，未改）：真 `CloudLink` + 真
 * `relay-client` + 内存 broker，单向 300 ms ⇒ **RTT ≈ 600 ms**。手机端跑的是**真**
 * `web/lib/net.js` 的 `Realtime` 与 `WsTicketCache`；「/ws 升级」也走真链路
 * （本文件给 mock 宿主的 http server 挂了一个 upgrade 处理器，校验票是一次性 +
 * 未过期，然后回 hello）—— 所以量到的每一次往返都是真的 broker 往返。
 *
 * 量出来的三件事
 * --------------
 * 1. 一次往返的成本：detail（45 KB，真 gzip 分片路径）≈ 637 ms、换票 ≈ 648 ms、
 *    `/ws` 升级 ≈ 632 ms —— 与仓库既有基准（`bench-baseline.test.mjs`）同量级。
 * 2. **改前**：建隧道 = 换票 + 升级 = **两次串行往返**（实测 p50 1275 ms）。
 * 3. **改后**：票预热/复用之后建隧道 = **一次往返**（实测 p50 629 ms）；
 *    首屏 detail 里顺带下发的票让这次重建的取票次数直接归零。
 *
 * 断言的是**可数的东西**（某次连接产生的 `req` 帧数），不是"看起来快了"：
 * 把 `net.js` 退回每次现取、或把 `WsTicketCache.take()` 的复用去掉，本文件都会红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import { Realtime, WsTicketCache } from '../../web/lib/net.js';
import {
  DEFAULT_ONE_WAY_MS, PAYLOAD_PATHS, createBenchEnv, percentile,
} from '../support/bench-harness.mjs';

const ONE_WAY_MS = DEFAULT_ONE_WAY_MS;
const RTT_MS = ONE_WAY_MS * 2;
const SAMPLES = 3;

const p50 = (values) => percentile([...values].sort((a, b) => a - b), 50);

/**
 * mock 宿主的 `/ws`：校验「票一次性 + 未过期」，然后接受升级并回一条 hello。
 * 这就是电脑端 `/ws` 的最小可用模型（票的语义与服务端一致）。
 */
function attachWsHost(env) {
  const tickets = new Map();
  let minted = 0;
  const wss = new WebSocketServer({ noServer: true });
  const live = new Set();
  env.bridge.server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url ?? '/ws', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    const ticket = String(url.searchParams.get('ticket') ?? '');
    const record = tickets.get(ticket);
    const ok = record !== undefined && record.used === false && record.expiresAt > Date.now();
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    record.used = true;
    wss.handleUpgrade(request, socket, head, (ws) => {
      live.add(ws);
      ws.on('close', () => live.delete(ws));
      ws.send(JSON.stringify({ type: 'hello', payload: { bootId: 'bench' }, seq: 1 }));
    });
  });
  return {
    mint() {
      minted += 1;
      const ticket = `wst_bench_${minted}`;
      tickets.set(ticket, { expiresAt: Date.now() + 60_000, used: false });
      return { ticket, expiresAt: Date.now() + 60_000 };
    },
    stats() {
      return { minted, used: [...tickets.values()].filter((record) => record.used).length };
    },
    /** 收尾：把还开着的隧道全掐掉，否则 mock 宿主的 http server 关不掉（close 会一直等）。 */
    async close() {
      for (const ws of live) {
        try { ws.terminate(); } catch { /* 已经断了 */ }
      }
      live.clear();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * 假的 `WebSocket`：把握手翻译成**真**的 `ws.open` 帧（经 broker、含 300 ms 单向延迟）。
 *
 * 只翻译 `/ws`：`Realtime` 只连这一个地址，其它地址（没有）直接当作失败。
 */
function installBenchSocket(env) {
  const RealSocket = globalThis.WebSocket;
  const sockets = [];
  class BenchSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      const parsed = new URL(String(url));
      this.url = String(url);
      this.readyState = BenchSocket.CONNECTING;
      this.id = '';
      sockets.push(this);
      const path = `${parsed.pathname}${parsed.search}`;
      env.phone.client.openTunnel(path).then(
        (tunnel) => {
          if (this.readyState !== BenchSocket.CONNECTING) return;
          this.id = tunnel.id;
          this.readyState = BenchSocket.OPEN;
          this.onopen?.();
        },
        () => {
          if (this.readyState === BenchSocket.CLOSED) return;
          this.readyState = BenchSocket.CLOSED;
          this.onclose?.();
        },
      );
    }

    send() { /* 只量"建起来要几次往返"，隧道里的数据帧不参与 */ }

    close() {
      if (this.readyState >= BenchSocket.CLOSING) return;
      this.readyState = BenchSocket.CLOSED;
      // 桌面端那条隧道也要关：否则 mock 宿主的连接一直挂着，env.close() 会等死。
      if (this.id !== '') void env.phone.client.closeTunnel(this.id);
      this.onclose?.();
    }
  }
  globalThis.WebSocket = BenchSocket;
  return {
    installed: sockets,
    restore() { globalThis.WebSocket = RealSocket; },
  };
}

/**
 * 造一个用真链路的 `Realtime`：`api` 走真 `req` 帧；换票额外把票交给 mock 宿主签发。
 *
 * 计数的关键：`req` 帧数要在**状态变成 online 的那一刻**取样。隧道一打开
 * `net.js` 就会在后台补下一张票（那是一次不在关键路径上的往返），采样晚几毫秒
 * 就会把它算进"建隧道要几次往返"里 —— 那是两种完全不同的东西。
 *
 * @param {object} options
 * @param {object} options.env           bench 环境
 * @param {object} options.wsHost        mock 宿主的 /ws
 * @param {object|null} [options.tickets] 票缓存（改后）；null = 改前（每次现取）
 */
function makeRealtime({ env, wsHost, tickets = null }) {
  const requests = [];
  const api = async (path, options = {}) => {
    requests.push(path);
    if (path === '/api/v1/ws-ticket') {
      // 真往返（mock 宿主没有这条路由，404 正文最小；要的是那次往返本身）。
      await env.phone.request(String(options.method ?? 'POST'), path);
      return wsHost.mint();
    }
    const detail = await env.phone.request('GET', path);
    const payload = JSON.parse(Buffer.from(String(detail.body ?? ''), 'base64').toString('utf8') || '{}');
    return payload.data ?? {};
  };
  /** online 那一刻的帧数快照（-1 = 还没到）。 */
  const marks = { framesAtOnline: -1, onlineAt: 0 };
  const online = new Promise((resolve) => {
    const realtime = new Realtime({
      api,
      getBase: () => 'http://127.0.0.1',
      getToken: () => 'bench-device-token',
      allowSse: false,
      tickets,
      onFrame: () => {},
      onState: (state) => {
        if (state !== 'online' || marks.framesAtOnline >= 0) return;
        marks.framesAtOnline = env.phone.stats.requests;
        marks.onlineAt = Date.now();
        resolve();
      },
    });
    marks.realtime = realtime;
  });
  return { realtime: marks.realtime, requests, marks, online };
}

/** 等 `realtime` 真的 online，返回耗时（真链路上 600 ms/往返，给足余量）。 */
async function waitOnline(handle, timeout = 15_000) {
  const started = Date.now();
  const timer = setTimeout(() => { handle.marks.timeout = true; }, timeout);
  timer.unref?.();
  while (handle.realtime.state !== 'online') {
    if (Date.now() - started > timeout) throw new Error(`等 realtime online 超时（state=${handle.realtime.state}）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  clearTimeout(timer);
  return Date.now() - started;
}

test('「进入实时」的往返次数：改前 2 次串行（换票+升级）→ 改后 1 次（升级）', async (t) => {
  const env = await createBenchEnv({ seed: 31, latencyMs: ONE_WAY_MS });
  const wsHost = attachWsHost(env);
  const socketFacade = installBenchSocket(env);
  const ticketRequests = () => env.phone.stats.requests;
  const rows = { detail: [], ticket: [], open: [], beforeLive: [], afterLive: [] };
  try {
    await env.warmPhone();

    /* ---- 单程成本：三种基本往返各量几次（真链路，真 300 ms 单向） ---- */
    for (let index = 0; index < SAMPLES; index += 1) {
      const detail = await env.phone.request('GET', PAYLOAD_PATHS.detail);
      rows.detail.push(detail.ms);
      const ticket = await env.phone.request('POST', '/api/v1/ws-ticket');
      rows.ticket.push(ticket.ms);
      const at = Date.now();
      const tunnel = await env.phone.client.openTunnel(`/ws?ticket=${wsHost.mint().ticket}`);
      rows.open.push(Date.now() - at);
      await env.phone.client.closeTunnel?.(tunnel.id);
    }

    /* ---- 改前：没有票缓存，每次建隧道都现取（2 次串行往返） ---- */
    let beforeTrips = 0;
    for (let index = 0; index < SAMPLES; index += 1) {
      const handle = makeRealtime({ env, wsHost });
      const framesBefore = ticketRequests();
      const at = Date.now();
      handle.realtime.start();
      while (handle.marks.framesAtOnline < 0) await new Promise((resolve) => setTimeout(resolve, 5));
      const ms = Date.now() - at;
      // online 那一刻的帧数：这条就是"建隧道花了几个 req 往返"。
      const frames = handle.marks.framesAtOnline - framesBefore;
      beforeTrips += frames;
      rows.beforeLive.push(ms);
      assert.equal(frames, 1, '改前：每次建隧道都该有 1 次取票往返（+ 1 次升级）');
      handle.realtime.stop();
    }
    assert.equal(beforeTrips, SAMPLES, '改前每次连接都要现取一张票');

    /* ---- 改后：票已预热，建隧道只剩升级那一次往返 ---- */
    let afterTrips = 0;
    let backgroundRefills = 0;
    for (let index = 0; index < SAMPLES; index += 1) {
      const tickets = new WsTicketCache({
        fetchTicket: async () => {
          await env.phone.request('POST', '/api/v1/ws-ticket');
          return wsHost.mint();
        },
      });
      // 开机预热（这一次是后台的，不在"打开会话"的关键路径上）。
      await tickets.prewarm();
      const handle = makeRealtime({ env, wsHost, tickets });
      const framesBefore = ticketRequests();
      const at = Date.now();
      handle.realtime.start();
      while (handle.marks.framesAtOnline < 0) await new Promise((resolve) => setTimeout(resolve, 5));
      const ms = Date.now() - at;
      const frames = handle.marks.framesAtOnline - framesBefore;
      afterTrips += frames;
      rows.afterLive.push(ms);
      assert.equal(frames, 0, '改后：票已预热，建隧道不该再发取票请求（少一次往返）');
      // 隧道打开之后**后台**补一张（不在关键路径上，只是为下一次重建备货）。
      await new Promise((resolve) => setTimeout(resolve, 30));
      backgroundRefills += ticketRequests() - handle.marks.framesAtOnline;
      handle.realtime.stop();
      tickets.stop();
    }
    assert.equal(afterTrips, 0, '改后关键路径上的取票往返必须是 0');

    /* ---- 结论：改后少一次串行往返（≈ 一个 RTT） ---- */
    const beforeP50 = p50(rows.beforeLive);
    const afterP50 = p50(rows.afterLive);
    const saved = beforeP50 - afterP50;
    t.diagnostic([
      `单向 ${ONE_WAY_MS}ms ⇒ RTT ${RTT_MS}ms（真 broker + 真 relay-client + 真 ws.open）`,
      `单程 p50：detail(gzip 45KB) ${p50(rows.detail)}ms / 换票 ${p50(rows.ticket)}ms / 升级 ${p50(rows.open)}ms`,
      `改前「进入实时」：2 次串行往返，p50 ${beforeP50}ms（取票往返 ${beforeTrips / SAMPLES} 次/连接）`,
      `改后「进入实时」：1 次往返，p50 ${afterP50}ms（取票往返 ${afterTrips / SAMPLES} 次/连接；另有 ${backgroundRefills / SAMPLES} 次后台补票，不在关键路径）`,
      `省下 ${saved}ms ≈ ${(saved / RTT_MS).toFixed(2)} 个 RTT`,
      `票：签发 ${wsHost.stats().minted} 张、被用掉 ${wsHost.stats().used} 张（一次性）`,
    ].join('\n'));
    assert.ok(
      saved > RTT_MS * 0.5,
      `改后至少该省半个 RTT（实测 before=${beforeP50}ms after=${afterP50}ms，RTT≈${RTT_MS}ms）`,
    );
  } finally {
    socketFacade.restore();
    await wsHost.close();
    await env.close();
  }
});

test('首屏 detail 里顺带下发的票：打开会话之后的第一次重建，取票往返为 0', async (t) => {
  const env = await createBenchEnv({ seed: 37, latencyMs: ONE_WAY_MS });
  const wsHost = attachWsHost(env);
  const socketFacade = installBenchSocket(env);
  try {
    await env.warmPhone();
    const tickets = new WsTicketCache({
      fetchTicket: async () => {
        await env.phone.request('POST', '/api/v1/ws-ticket');
        return wsHost.mint();
      },
    });
    const handle = makeRealtime({ env, wsHost, tickets });

    // 1) 用户点进会话：detail 往返（服务端在首屏那一页顺带下发一张票）。
    const detailAt = Date.now();
    const detail = await env.phone.request('GET', PAYLOAD_PATHS.detail);
    const detailMs = Date.now() - detailAt;
    assert.equal(detail.ok, true, 'detail 往返应当成功');
    const carried = wsHost.mint(); // 等价于服务端塞进应答的那张 wsTicket
    assert.equal(tickets.offer(carried), true, 'detail 下发的票必须被缓存收下');

    // 2) 隧道要重建（息屏唤醒/切网）：这一次不该再有任何取票往返。
    const framesBefore = env.phone.stats.requests;
    const at = Date.now();
    handle.realtime.start();
    while (handle.marks.framesAtOnline < 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const liveMs = Date.now() - at;
    const frames = handle.marks.framesAtOnline - framesBefore;
    assert.equal(frames, 0, 'detail 已经带票：重建隧道不该再发取票请求');
    t.diagnostic([
      `detail 往返 p50 量级 ${detailMs}ms（45 KB gzip，含分片判断）`,
      `随 detail 下发的那张票 → 重建隧道 ${liveMs}ms，取票往返 ${frames} 次（省一次往返 ≈ ${RTT_MS}ms）`,
    ].join('\n'));
    handle.realtime.stop();
    tickets.stop();
  } finally {
    socketFacade.restore();
    await wsHost.close();
    await env.close();
  }
});

test('安全边界不变：票用掉即作废，重放同一张票升级必被拒（mock 宿主按服务端语义校验）', async () => {
  const env = await createBenchEnv({ seed: 41, latencyMs: 0 });
  const wsHost = attachWsHost(env);
  const socketFacade = installBenchSocket(env);
  try {
    await env.warmPhone();
    const first = wsHost.mint();
    const tunnel = await env.phone.client.openTunnel(`/ws?ticket=${first.ticket}`);
    assert.ok(tunnel.id.length > 0);
    await env.phone.client.closeTunnel?.(tunnel.id);
    await assert.rejects(
      () => env.phone.client.openTunnel(`/ws?ticket=${first.ticket}`),
      /隧道打开被拒/u,
      '同一张票第二次必须被拒（一次性）',
    );
  } finally {
    socketFacade.restore();
    await wsHost.close();
    await env.close();
  }
});
