/**
 * 宿主 HTTP / WebSocket 面的资源与异常边界（lib/server.mjs + lib/pair-page.mjs）。
 *
 * 覆盖的都是「进程里悄悄泄漏 / 静默吞请求 / 回显内部报错」这类**不会立刻报错**
 * 的缺陷：
 *   1. SSE 写缓冲超限先关闭后，不能再 subscribe / 起心跳（listeners 永不移除）；
 *   2. 静态大文件被客户端中断时，必须销毁源读流（否则 fd 挂到进程退出）；
 *   3. `POST /pair` 不能被当成 200 配对页吞掉；
 *   4. API 500 不回显内部报错原文（绝对路径）；
 *   5. 配对页插槽只放行结构合法的二维码 SVG；
 *   6. WebSocket 升级 / 连接路径的异常不能上抛成宿主进程的未捕获异常。
 *
 * 全部用真 BridgeServer + 真 HTTP；只在「库自己抛错 / 写缓冲超限」这两个观测点
 * 传假对象或打桩。端口 0、临时目录，不联网、不留常驻进程。
 */
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

import { renderPairPage } from '../../lib/pair-page.mjs';
import { expectSecurityHeaders, openStream, request, startBridge } from './support/harness.mjs';

let ctx;
let token;
let device;

// 被 await 的定时器不能 unref，否则 Node 22 的 runner 会取消整个文件。
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(predicate, { timeoutMs = 4000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  throw new Error(`等待${label}超时`);
}

before(async () => {
  ctx = await startBridge();
  const minted = ctx.mint({ name: '硬化测试设备' });
  token = minted.token;
  device = minted.device;
});

after(async () => {
  await ctx?.close();
});

const authed = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

/* ------------------------------------------------------------- 假对象 ---- */

/** 只实现 openSse 真正用到的形状；`writableLength` 就是「客户端不读」的观测点。 */
function fakeResponse({ writableLength = 0 } = {}) {
  const handlers = new Map();
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writableLength,
    writeHead() { res.headersSent = true; return res; },
    write() { return true; },
    end() { res.writableEnded = true; },
    destroy() { res.destroyed = true; },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return res;
    },
  };
  return res;
}

function fakeRequest() {
  return {
    on() { return this; },
  };
}

/** onConnection 需要的 socket 形状：够走到 hello 帧构造即可。 */
function fakeWsSocket() {
  const handlers = new Map();
  return {
    readyState: 1,
    isAlive: true,
    bufferedAmount: 0,
    send() { /* hello 帧在构造阶段就抛了，这里通常到不了 */ },
    ping() {},
    close() { this.readyState = 3; },
    terminate() { this.readyState = 3; },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return this;
    },
  };
}

/** onUpgrade 需要的裸 socket 形状（noServer 模式下 ws 还没接管）。 */
function fakeUpgradeSocket() {
  return {
    destroyed: false,
    written: '',
    write(chunk) { this.written += String(chunk); },
    destroy() { this.destroyed = true; },
  };
}

/* ---------------------------------------------------------------- S1 ---- */

test('SSE：写缓冲超限先关闭时不再订阅、也不起心跳（listeners 与定时器都不留）', () => {
  const baseline = ctx.core.listeners.size;
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const handle = realSetInterval(...args);
    timers.push(handle);
    return handle;
  };
  let res;
  try {
    // 8 MB 远超 MAX_STREAM_BUFFER(1 MB)：等价于「客户端不读、写缓冲已堆满」。
    res = fakeResponse({ writableLength: 8 * 1024 * 1024 });
    assert.doesNotThrow(
      () => ctx.server.openSse(fakeRequest(), res, device, new URL('http://127.0.0.1/api/v1/events')),
      'openSse 内部不能抛',
    );
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  assert.equal(res.destroyed, true, '写缓冲超限必须销毁这条响应');
  assert.equal(ctx.core.listeners.size, baseline, '关闭之后绝不能再 subscribe(send)（listeners 每次 +1 永不移除）');
  assert.equal(timers.length, 0, '关闭之后绝不能再起 20 秒心跳定时器（它永远不会被清理）');
  assert.equal(ctx.server.allSse.size, 0, '不能留在 allSse 里');
  assert.equal(ctx.server.sseClients.size, 0, 'per-device 桶必须被删掉');
});

test('SSE：正常开流再断开时，订阅数量回到基线（cleanup 真的解绑了）', async () => {
  // 单独起一个 bridge：上面那条「写缓冲超限」的用例在**修复前**会留下一个
  // 永不移除的订阅，共用实例会把基线污染得看不出因果。
  const bridge = await startBridge();
  try {
    const baseline = bridge.core.listeners.size;
    const minted = bridge.mint({ name: 'SSE 基线设备' });
    const stream = await openStream(bridge.port, `/api/v1/events?token=${encodeURIComponent(minted.token)}`);
    try {
      await stream.readUntil((text) => text.includes('event: hello'));
      assert.equal(bridge.core.listeners.size, baseline + 1, '开流期间必须订阅一次');
    } finally {
      stream.destroy();
    }
    await until(() => bridge.server.allSse.size === 0, { label: 'SSE 清理' });
    assert.equal(bridge.core.listeners.size, baseline, '断开后订阅必须被移除');
  } finally {
    await bridge.close();
  }
});

/* ---------------------------------------------------------------- S3 ---- */

test('静态大文件：客户端中断后源读流被 destroy（否则 fd 挂到进程退出）', async () => {
  const file = path.join(ctx.webRoot, 'big.bin');
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024, 0x61));
  const destroyed = [];
  const realDestroy = Readable.prototype.destroy;
  Readable.prototype.destroy = function patchedDestroy(...args) {
    destroyed.push(this);
    return realDestroy.apply(this, args);
  };
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: ctx.port, path: '/app/big.bin', agent: false }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
        res.on('error', () => { /* 主动中断时正常发生 */ });
      });
      req.on('error', (error) => {
        if (error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
    });
    await until(
      () => destroyed.some((stream) => String(stream.path ?? '').endsWith('big.bin')),
      { label: '静态源流销毁' },
    );
  } finally {
    Readable.prototype.destroy = realDestroy;
    await rm(file, { force: true });
  }
});

/* ---------------------------------------------------------------- S4 ---- */

test('POST /pair：405 + allow，不再被当成 200 配对页静默吞掉', async () => {
  const get = await request(ctx.port, '/pair');
  assert.equal(get.status, 200, 'GET /pair 仍然正常');
  assert.match(get.headers['content-type'], /text\/html/u);
  assert.equal((await request(ctx.port, '/pair', { method: 'HEAD' })).status, 200, 'HEAD /pair 仍然正常');

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await request(ctx.port, '/pair', {
      method,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=alice&password=hunter2',
    });
    assert.equal(response.status, 405, `${method} /pair 必须 405，不能回 200 配对页`);
    assert.equal(response.headers.allow, 'GET, HEAD', `${method} /pair 必须声明允许的方法`);
    assert.equal(response.body, 'Method Not Allowed');
    assert.equal(response.body.includes('hunter2'), false);
    expectSecurityHeaders(response, `${method} /pair`);
  }
});

/* ---------------------------------------------------------------- S5 ---- */

test('API 500：未知异常（含绝对路径的 fs 报错）不回显原文', async () => {
  const original = ctx.core.index.snapshot;
  ctx.core.index.snapshot = () => {
    const error = new Error(`ENOENT: no such file or directory, open '${path.join(ctx.root, 'secret-state.json')}'`);
    error.code = 'ENOENT';
    throw error;
  };
  try {
    const response = await request(ctx.port, '/api/v1/tasks', { headers: authed() });
    assert.equal(response.status, 500);
    const body = JSON.parse(response.body);
    assert.equal(body.error.message, '服务内部错误', '未知异常一律固定文案');
    assert.equal(response.body.includes(ctx.root), false, '响应体不能带宿主绝对路径');
    assert.equal(response.body.includes('no such file or directory'), false);
    expectSecurityHeaders(response, '未知异常 500');
    assert.ok(
      ctx.logs.some((line) => line.includes('request failed GET /api/v1/tasks')),
      '细节必须进日志，方便排障',
    );
  } finally {
    ctx.core.index.snapshot = original;
  }

  // 连 code 都没有的异常同样只回固定文案。
  ctx.core.index.snapshot = () => { throw new Error(`boom at ${ctx.root}`); };
  try {
    const response = await request(ctx.port, '/api/v1/tasks', { headers: authed() });
    assert.equal(response.status, 500);
    const body = JSON.parse(response.body);
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message, '服务内部错误');
    assert.equal(response.body.includes(ctx.root), false);
  } finally {
    ctx.core.index.snapshot = original;
  }

  // 反向护栏：语义 code（ERROR_STATUS 里那些给用户看的）的 message 必须照旧回显，
  // 不能因为「一律清洗」把可用性一起改没了。
  ctx.core.index.snapshot = () => {
    const error = new Error('任务列表暂时不可用');
    error.code = 'unavailable';
    throw error;
  };
  try {
    const response = await request(ctx.port, '/api/v1/tasks', { headers: authed() });
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).error.message, '任务列表暂时不可用');
  } finally {
    ctx.core.index.snapshot = original;
  }
});

/* ---------------------------------------------------------------- S6 ---- */

test('配对页：relay.qrSvg 只放行结构合法的 SVG，注入内容不落进 HTML', () => {
  const base = {
    state: 'online',
    url: 'https://example.test/shell/#s=wss%3A%2F%2Fbroker&r=room&k=key',
    appBase: 'https://example.test/shell/',
  };
  const render = (qrSvg) => renderPairPage(
    ctx.core,
    { fingerprint: 'it-fingerprint' },
    [],
    { ...base, qrSvg },
    { csrfToken: 'it-csrf', auth: { required: true, configured: true } },
  );

  // 正常二维码（只含 rect）必须原样渲染 —— 否则二维码本身扫不出来。
  const good = render('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="1" height="1"/></svg>');
  assert.match(good, /<div class="remote-qr"><svg [\s\S]*<\/svg><\/div>/u, '合法 SVG 必须被插入');

  const hostile = [
    '<svg onload="alert(1)"></svg>',
    '<svg/onload="alert(1)"></svg>',
    '<svg><script>alert(1)</script></svg>',
    '<svg></svg><script>alert(1)</script>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<svg><image href="https://evil.example/x.png"/></svg>',
    '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>',
    'not-an-svg',
  ];
  for (const qrSvg of hostile) {
    const html = render(qrSvg);
    assert.equal(html.includes(qrSvg), false, `非法 SVG 被原样插进了页面：${qrSvg}`);
    assert.equal(html.includes('<script>alert(1)</script>'), false, `脚本落进了页面：${qrSvg}`);
    assert.match(html, /二维码内容异常，已隐藏/u, `非法 SVG 必须退回纯文本占位：${qrSvg}`);
  }
});

/* ---------------------------------------------------------------- S8 ---- */

test('WS：wss 有 error 监听，emit(error) 不会变成宿主进程的未捕获异常', () => {
  assert.doesNotThrow(
    () => ctx.server.wss.emit('error', new Error('wss boom')),
    '没有 error 监听时 EventEmitter 会直接抛出，那是进程级事故',
  );
  assert.ok(ctx.logs.some((line) => line.includes('websocket server error')), '必须留一条日志');
});

test('WS：onConnection 内部抛错时安全关闭 socket，不冒泡进 upgrade 事件', () => {
  const socket = fakeWsSocket();
  const original = ctx.core.deviceView;
  ctx.core.deviceView = () => { throw new Error('deviceView exploded'); };
  try {
    assert.doesNotThrow(
      () => ctx.server.wss.emit('connection', socket, { url: '/ws' }, device),
      '连接回调里的异常必须被兜住（上抛会打死宿主）',
    );
  } finally {
    ctx.core.deviceView = original;
  }
  assert.equal(socket.readyState, 3, '异常时必须安全关闭这条 socket');
  assert.equal(ctx.server.wsCount(), 0, '不能留下半条隧道：桶里的记录必须撤掉');
  assert.ok(ctx.logs.some((line) => line.includes('websocket connection failed')));
});

test('WS：onUpgrade 内部抛错时回 500 并销毁 socket，不冒泡成进程级异常', () => {
  const socket = fakeUpgradeSocket();
  const original = ctx.core.consumeWsTicket;
  ctx.core.consumeWsTicket = () => { throw new Error('ticket store exploded'); };
  try {
    assert.doesNotThrow(
      () => ctx.server.onUpgrade(
        { url: '/ws?ticket=whatever', headers: { host: `127.0.0.1:${ctx.port}` } },
        socket,
        Buffer.alloc(0),
        ctx.server.wss,
      ),
      '升级路径的异常必须被兜住（它由 http 的 upgrade 事件直接调用）',
    );
  } finally {
    ctx.core.consumeWsTicket = original;
  }
  assert.equal(socket.destroyed, true, '异常时必须销毁这条 socket');
  assert.match(socket.written, /^HTTP\/1\.1 500 Internal Server Error/u);
  assert.ok(ctx.logs.some((line) => line.includes('websocket upgrade failed')));
});
