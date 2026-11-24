/**
 * 端到端：**真** `CloudLink`（电脑端）× **Node 版手机端**（test/support/relay-client.mjs），
 * 中间只有一个内存 broker。
 *
 * 这一组用例存在的理由：线上反复出现「手机能连上中继，但应用的请求不被应答」。
 * 只测单侧的 `dispatch()` / `handleRequest()` 抓不到两侧**帧格式漂移**，所以这里：
 *   - 电脑端是 `lib/cloud.mjs` 的真实实现：`start()` → 真 `connect()` 接线
 *     （subscribe 上行主题、收到 message 走 `onFrame`、回 hello、起 beat）；
 *   - 手机端是独立重写的信封 + 帧实现（不 import remote/remote.js）；
 *   - broker 是内存假件：两个假 mqtt client 互相投递，QoS 1 的 PUBACK 用
 *     `process.nextTick` 模拟 —— 不用 setTimeout，所以是确定性的；
 *   - 本地 HTTP/WS 桥是**真的**（127.0.0.1 随机端口上的 http + ws server），
 *     `req` → `fetch` → `res` 走完整链路，不是 stub。
 *
 * 红线：**不打公网**。电脑端的 broker 写成 `wss://memory-broker.invalid/mqtt`
 * （RFC 2606 保留的 `.invalid`，永远解析不到），而且 `link.start()` / `retry()` 一次都
 * 不调用 —— 电脑端那条假 mqtt client 由本条消息里的检查函数手工接线（原因见下）。
 *
 * 为什么手工接线：`mqtt` 的默认导出是**只读命名空间**（`connect` 只有 getter、
 * `configurable:false`），打不了补丁；真 `connect()` 又只能走 `mqtt.connect()`。
 * 所以这里复刻 `CloudLink.connect()` 里 `'connect'` 分支的三步（subscribe 上行主题、
 * 发 hello、起 beat）以及 `'message'` → `onFrame()`。被检的实现仍然是真实的
 * `publish()` / `onFrame()` / `dispatch()` / `handleRequest()` / `respond()`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';

import { WebSocketServer } from 'ws';

import { Auth, hashPassword } from '../../lib/auth.mjs';
import { CloudLink, MAX_FRAME, RELAY_HEADER } from '../../lib/cloud.mjs';
import { createRelayClient } from '../support/relay-client.mjs';

/* --------------------------- 内存 broker（假 mqtt） ------------------------ */

/**
 * 最小 MQTT：只要 publish / subscribe / on('message') / ack。
 *
 * QoS 1 语义按线上顺序模拟：broker 先收下（这里立即返回 true），然后在下一个
 * `process.nextTick` 里**先投递给订阅者、再回 PUBACK** —— 顺序固定，所以测试不
 * 依赖任何时钟。
 */
class MemoryBroker {
  constructor() {
    this.clients = [];
    this.deliveries = [];
  }

  createClient(label) {
    const broker = this;
    const listeners = new Map();
    const subscriptions = new Set();
    const client = {
      label,
      connected: false,
      ended: false,
      subscriptions,
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return client;
      },
      off(event, handler) {
        listeners.get(event)?.delete(handler);
        return client;
      },
      emit(event, ...args) {
        for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
      },
      subscribe(topic, options, callback) {
        subscriptions.add(String(topic));
        process.nextTick(() => callback?.(null));
      },
      unsubscribe(topic, callback) {
        subscriptions.delete(String(topic));
        process.nextTick(() => callback?.(null));
      },
      publish(topic, payload, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
        broker.deliveries.push({ from: label, topic: String(topic), bytes: body.length });
        // 只投给「此刻已订阅这个主题」的**别的** client（MQTT 不回送自己）。
        const targets = broker.clients.filter((peer) => peer !== client && peer.subscriptions.has(String(topic)));
        process.nextTick(() => {
          for (const peer of targets) peer.emit('message', String(topic), Buffer.from(body));
          cb?.(null); // PUBACK：这正是 CloudLink 看门狗唯一认的「管道真的通」证据
        });
        return true;
      },
      end() {
        client.ended = true;
        const index = broker.clients.indexOf(client);
        if (index >= 0) broker.clients.splice(index, 1);
        process.nextTick(() => client.emit('close'));
      },
    };
    this.clients.push(client);
    // 与真实 mqtt 一样：CONNECT 是异步完成的，监听器一定先挂上。
    process.nextTick(() => {
      if (client.ended) return;
      client.connected = true;
      client.emit('connect');
    });
    return client;
  }
}

/** 当前测试的 broker（只为让断言能读到投递记录，不再用来替换 mqtt.connect）。 */
let activeBroker = null;
after(() => {
  activeBroker = null;
});

/* ----------------------------- 本地假桥（真监听） -------------------------- */

/**
 * 电脑端 `handleRequest()` 会真的 `fetch('http://127.0.0.1:<port>' + path)`，
 * 所以这里必须有一个**真实监听**的 HTTP server；同一个端口上再挂一个真的
 * WebSocketServer 给 `ws.open` 隧道用。
 */
function createBridge() {
  const calls = [];
  const wsConnections = [];
  // 不可压缩的大正文：用来逼出 > MAX_FRAME 的 res（gzip 关掉时才会分片）。
  const bigPayload = JSON.stringify({ ok: true, data: { id: 'session-big', blob: randomBytes(120 * 1024).toString('hex') } });
  const detailPayload = JSON.stringify({
    ok: true,
    data: {
      id: 'session-aaaa',
      messages: Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `第 ${index} 条消息正文，重复够多才会触发电脑端的 gzip 分支。`,
      })),
    },
  });

  const server = createHttpServer((request, response) => {
    const path = String(request.url ?? '');
    calls.push({ method: String(request.method ?? 'GET'), path, headers: { ...request.headers } });
    const json = (status, text) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(text);
    };
    if (path === '/api/v1/tasks') return json(200, '{"ok":true,"data":{"tasks":[{"id":"session-aaaa","title":"第一个会话"},{"id":"session-bbbb","title":"第二个会话"}]}}');
    if (path === '/api/v1/tasks/session-aaaa') return json(200, detailPayload);
    if (path === '/api/v1/tasks/session-big') return json(200, bigPayload);
    if (path === '/api/v1/me') return json(200, '{"ok":true,"data":{"user":"owner"}}');
    return json(404, '{"ok":false,"error":{"code":"not_found","message":"没有这个路径"}}');
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    const url = String(request.url ?? '');
    const record = { url, psid: new URL(url, 'http://127.0.0.1').searchParams.get('psid'), closed: false, received: [] };
    wsConnections.push(record);
    socket.on('message', (data) => {
      record.received.push(String(data));
      socket.send(`echo:${String(data)}`);
    });
    socket.on('close', () => { record.closed = true; });
  });

  return {
    server,
    wss,
    calls,
    wsConnections,
    bigPayload,
    detailPayload,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* --------------------------------- 夹具 ---------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待（`handleRequest` 是异步的，`ws.msg` 还要过 40ms 的批处理窗口）。 */
async function waitFor(predicate, { timeout = 4_000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/** 收集日志行（顺便用来断言令牌不落日志）。 */
function makeLogger(lines) {
  const push = (level) => (...args) => {
    lines.push(`${level} ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`);
  };
  return { info: push('info'), warn: push('warn'), error: push('error') };
}

const SESSION_PASSWORD = 'e2e-pass-9f3a';
const RELAY_DEVICE_TOKEN = 'dshb_e2e_device_token_0123456789';

/**
 * 造一套完整环境：真 CloudLink + 内存 broker + 真本地桥。
 * @param {{password?: string|null}} [options] 给口令时开启登录闸门（`req` 必须带会话令牌）
 */
async function makeHarness({ password = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pocket-e2e-'));
  const logLines = [];
  const logger = makeLogger(logLines);
  const bridge = createBridge();
  const port = await bridge.listen();

  let auth = null;
  let session = null;
  if (password !== null) {
    const credentialsFile = join(dir, 'auth.json');
    const sessionsFile = join(dir, 'sessions.json');
    // N 调小到 4 只是为了让测试快；verifyPassword 会读文件里记录的参数。
    writeFileSync(credentialsFile, JSON.stringify({
      user: 'owner',
      password: hashPassword(password, 'e2e-salt', { N: 4, r: 8, p: 1, keylen: 32 }),
    }), 'utf8');
    auth = new Auth({ credentialsFile, sessionsFile, required: true, logger });
    const result = auth.login({ user: 'owner', password, phone: 'node-test' });
    session = result.ok ? result.token : null;
  }

  const identity = {
    room: randomBytes(12).toString('hex'),
    key: Buffer.alloc(32, 0x5a).toString('base64url'),
    token: RELAY_DEVICE_TOKEN,
    deviceId: 'dev_e2e',
  };
  const link = new CloudLink({
    localPort: port,
    identity,
    broker: 'wss://memory-broker.invalid/mqtt',
    name: '测试电脑',
    auth,
    allowAnonymous: password === null,
    logger,
  });

  const broker = new MemoryBroker();
  activeBroker = broker;

  // —— 电脑端接线：复刻 CloudLink.connect() 的 'connect' / 'message' 两个分支 ——
  // （mqtt.connect 是只读命名空间上的 getter，打不了补丁，见文件头注释。）
  const desktop = broker.createClient('desktop');
  link.state = 'connecting';
  link.client = desktop;
  desktop.on('message', (_topic, payload) => {
    try {
      link.onFrame(payload); // 真 unseal + 真 dispatch
    } catch (error) {
      link.stats.errors += 1;
      link.lastError = String(error?.message ?? error);
    }
  });
  desktop.on('connect', () => {
    link.stats.connects += 1;
    link.noteLinkUp(desktop);
    link.state = 'online';
    desktop.subscribe(link.topics.up, { qos: 1 });
    link.sayHello(true); // 与真实现一致：连上就先 announce 一次
    link.startBeat();
    link.startLinkWatch();
  });

  const online = await waitFor(() => link.state === 'online', { timeout: 3_000 });
  if (!online) {
    link.stop();
    await bridge.close();
    activeBroker = null;
    rmSync(dir, { recursive: true, force: true });
    throw new Error('CloudLink 没有进入 online（内存 broker 接线有问题）');
  }

  const phones = [];
  const harness = {
    link,
    broker,
    bridge,
    identity,
    session,
    logLines,
    dir,
    /** 造一台「手机」并连上：token 决定它在电脑端被怎么对待。 */
    async connectPhone({ token = '', name = 'NodePhone' } = {}) {
      const transport = broker.createClient(`phone-${phones.length}`);
      const client = createRelayClient({
        room: identity.room,
        key: identity.key,
        token,
        name,
        transport,
      });
      phones.push({ client, transport });
      await client.connect();
      return client;
    },
    async close() {
      for (const entry of phones) {
        entry.client.close();
        entry.transport.end();
      }
      link.stop();
      await bridge.close();
      activeBroker = null;
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/* --------------------------------- 用例 ---------------------------------- */

test('hello → beat：手机 announce 后电脑端更新「手机在线」并回 hello 回声 + 即时 beat', async () => {
  const harness = await makeHarness();
  try {
    const client = await harness.connectPhone();
    // 电脑端在 `start()` 的 connect 里刚发过一条 hello，10 s 限流窗口还没过；
    // 把它清掉，模拟「电脑端已在线上很久」的稳态（否则这次 hello 要等 8 s 周期
    // 才拿到 beat —— 见最后一条用例，那本身是一个可诊断的真实行为）。
    harness.link.lastHelloAt = 0;

    const beatPromise = client.waitForFrame((message) => message.t === 'beat', 3_000);
    const sentAt = Date.now();
    await client.announce(true);
    const { message: beat, meta } = await beatPromise;

    assert.equal(beat.t, 'beat');
    assert.equal(beat.name, '测试电脑');
    assert.ok(Number(beat.ts) > 0, 'beat 必须带电脑端时间戳');
    assert.ok(meta.bytes > 0);
    assert.ok(Date.now() - sentAt < 3_000, '即时 beat 必须在一个 RTT 内到达');

    // 电脑端确实认了这台手机（hello 通过了新鲜度闸门）。
    assert.equal(harness.link.phone?.name, 'NodePhone');
    assert.ok(harness.link.stats.lastPhoneAt > 0);
    assert.equal(harness.link.stats.rx >= 1, true, '电脑端至少要收到 1 条上行帧（连接时的 announce + 这次强制 announce）');
    // hello 回声：同一个 hello 分支里 `if (sayHello()) beat()`。
    assert.equal(client.stats.hello, 1, '应当收到一条 hello 回声');
    assert.equal(client.stats.unsealErrors, 0);
  } finally {
    await harness.close();
  }
});

test('hello 落在电脑端 10s hello 限流窗口内 → 不立刻回 beat（要等 8s 周期，横幅因此会多挂几秒）', async () => {
  const harness = await makeHarness();
  try {
    const client = await harness.connectPhone();
    // 不复位 lastHelloAt：电脑端刚在 connect 里发过 hello，窗口还没过。
    const beats = [];
    client.on('beat', (message) => beats.push(message));
    await client.announce(true);

    // 手机端确实被认了（hello 本身没被拒），只是没有即时 beat。
    const accepted = await waitFor(() => harness.link.phone?.name === 'NodePhone', { timeout: 1_000 });
    assert.equal(accepted, true, 'hello 必须被接受（新鲜度闸门不能误杀合法 hello）');

    // 这里判的是"**即时** beat"：电脑端若在 hello 分支里回了 beat，
    // 那条 publish 已经进了内存 broker 的 `process.nextTick` 队列（见 MemoryBroker），
    // 而 `phone.name` 已更新说明 hello 分支就跑完了。所以排空一轮宏任务再断言就够了 ——
    // 以前这里是 `sleep(700)`，靠"700ms 远小于 BEAT_MS=8000"这种时序巧合，机器卡顿时会假红。
    await sleep(0);
    assert.equal(beats.length, 0, '窗口内不该有即时 beat');
    assert.equal(client.stats.beat, 0);
  } finally {
    await harness.close();
  }
});

test('req → res 401：链接里的设备令牌不是会话令牌，电脑端在 authorized() 就拒了，且不转发', async () => {
  const harness = await makeHarness({ password: SESSION_PASSWORD });
  try {
    assert.ok(harness.session !== null, '测试自己要能换到一枚会话令牌');
    // 链接里的 t= 是设备令牌（core 那本账），CloudLink.authorized() 查的是 Auth 的会话表。
    const client = await harness.connectPhone({ token: RELAY_DEVICE_TOKEN });
    const reply = await client.request('GET', '/api/v1/tasks');

    assert.equal(reply.status, 401);
    const body = JSON.parse(reply.body.toString('utf8'));
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(client.stats.unauthorized, 1);
    // 关键：请求**没有**被转发到本地桥，也没有走到 handleRequest。
    assert.equal(harness.bridge.calls.length, 0, '未授权的 req 绝不能打到本地桥');
    assert.equal(harness.link.stats.rpc, 0);
    assert.equal(harness.link.stats.unauthorized, 1);
    // 设备令牌与会话令牌都不能落日志。
    const joined = harness.logLines.join('\n');
    assert.ok(!joined.includes(RELAY_DEVICE_TOKEN), '设备令牌泄进了日志');
    assert.ok(!joined.includes(harness.session), '会话令牌泄进了日志');
  } finally {
    await harness.close();
  }
});

test('req → res 200：会话令牌通过 authorized()，请求被真转发到本地桥，gzip 响应能解开', async () => {
  const harness = await makeHarness({ password: SESSION_PASSWORD });
  try {
    const client = await harness.connectPhone({ token: harness.session });

    const list = await client.request('GET', '/api/v1/tasks');
    assert.equal(list.status, 200);
    const parsed = JSON.parse(list.body.toString('utf8'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.tasks.length, 2);
    assert.equal(harness.link.stats.rpc, 1);
    assert.equal(harness.bridge.calls.length, 1);
    assert.equal(harness.bridge.calls[0].path, '/api/v1/tasks');
    // 电脑端必须注入自己的中继标记头（手机伪造的那一份会被丢掉）。
    const relayHeader = harness.bridge.calls[0].headers[RELAY_HEADER];
    assert.ok(typeof relayHeader === 'string' && relayHeader.length > 0, '转发时必须带中继标记头');

    // 详情：正文 > 1200B 且是 json ⇒ 电脑端会 gzip，手机端必须解回原文。
    const detail = await client.request('GET', '/api/v1/tasks/session-aaaa');
    assert.equal(detail.status, 200);
    assert.equal(detail.enc, 'gzip', '这个体量必须走 gzip 分支');
    assert.equal(detail.body.toString('utf8'), harness.bridge.detailPayload);
    assert.ok(detail.raw.body.length < harness.bridge.detailPayload.length, 'gzip 后应当比原文小');
    assert.equal(harness.link.stats.rpc, 2);
  } finally {
    await harness.close();
  }
});

test('大响应 > MAX_FRAME：电脑端拆 part，手机端重组出逐字节一致的正文', async () => {
  const harness = await makeHarness();
  try {
    const client = await harness.connectPhone();
    const parts = [];
    client.on('part', (message) => parts.push(message));

    // gzip:false 是手机端没有 DecompressionStream 时的真实取值，也是唯一会让
    // 大响应以明文过中继的分支 —— 分片最容易被压出来的路径。
    const reply = await client.request('GET', '/api/v1/tasks/session-big', { gzip: false });

    assert.equal(reply.status, 200);
    assert.equal(reply.body.toString('utf8'), harness.bridge.bigPayload, '重组后的正文必须逐字节一致');
    assert.equal(client.stats.partsReassembled, 1);
    assert.ok(parts.length > 1, `必须真的分片（实际 ${parts.length} 片）`);

    const id = parts[0].id;
    assert.match(id, /^[0-9a-f]{12}$/u, '分片 id 必须是 12 位小写 hex');
    for (const part of parts) {
      assert.equal(part.id, id);
      assert.equal(part.total, parts.length);
      assert.ok(Buffer.from(part.d, 'base64').length <= MAX_FRAME, '单片明文不得超过 MAX_FRAME');
    }
    assert.deepEqual(parts.map((part) => part.seq).sort((a, b) => a - b), parts.map((_, index) => index));
  } finally {
    await harness.close();
  }
});

test('seq 回退：电脑端回 reject(code=replay)，被拒的请求不执行第二次；同 sid 换新页可恢复', async () => {
  const harness = await makeHarness();
  try {
    const client = await harness.connectPhone();
    await client.request('GET', '/api/v1/tasks'); // 把 req:<sid> 的水位推到 1
    assert.equal(harness.link.stats.rpc, 1);

    // 模拟手机端计数器被重置（旧外壳没有跳号自救）：seq 回到 1，低于水位。
    client.seq = 0;
    await assert.rejects(
      client.request('GET', '/api/v1/tasks'),
      (error) => {
        assert.equal(error.code, 'replay', `应当是 replay，实际 ${error.code}`);
        return true;
      },
    );
    assert.equal(client.stats.reject, 1);
    assert.equal(harness.link.stats.stale, 1);
    assert.equal(harness.bridge.calls.length, 1, '被拒的帧绝不能再执行一次');
    assert.equal(harness.link.stats.rpc, 1);

    // 换一个 sid（= 手机重新加载页面）后，低 seq 是合法的新水位。
    client.sid = 'abcdef01';
    const recovered = await client.request('GET', '/api/v1/me');
    assert.equal(recovered.status, 200);
    assert.equal(harness.link.stats.rpc, 2);
  } finally {
    await harness.close();
  }
});

test('ws.open → 本地 WS 隧道打开：真连 127.0.0.1 的 ws server，双向帧走 ws.msg', async () => {
  const harness = await makeHarness();
  try {
    const client = await harness.connectPhone();
    const tunnel = await client.openTunnel('/ws?ticket=e2e-ticket');
    assert.equal(tunnel.ack.t, 'ws.open');
    assert.equal(tunnel.ack.id, tunnel.id);
    assert.equal(harness.link.stats.wsOpen, 1);

    const opened = await waitFor(() => harness.bridge.wsConnections.length === 1, { timeout: 3_000 });
    assert.equal(opened, true, '电脑端必须真的连上本地 ws server');
    const connection = harness.bridge.wsConnections[0];
    assert.match(connection.url, /^\/ws\?ticket=e2e-ticket/u);
    // 手机端页面实例 id 必须透传给桥（否则两个页面会互相顶掉）。
    assert.equal(connection.psid, client.sid);

    const echoed = client.waitForFrame((message) => message.t === 'ws.msg' && message.id === tunnel.id, 4_000);
    await client.sendWsMessage(tunnel.id, 'ping-from-node');
    const { message } = await echoed;
    const text = message.frames
      .map((frame) => (frame.bin === true ? Buffer.from(frame.data, 'base64').toString('utf8') : frame.data))
      .join('');
    assert.equal(text, 'echo:ping-from-node');
    assert.deepEqual(connection.received, ['ping-from-node']);

    await client.closeTunnel(tunnel.id);
    assert.equal(await waitFor(() => connection.closed === true, { timeout: 3_000 }), true, 'ws.close 必须真的关掉本地隧道');
  } finally {
    await harness.close();
  }
});
