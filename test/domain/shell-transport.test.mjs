/**
 * 外壳传输层的行为测试：**在途请求 / 控制帧 / 分片表**（A1 / A3 / A6）。
 *
 * 为什么这个文件在 `test/domain/` 而不是 `test/unit/`：它测的不是纯函数，而是
 * `remote/remote.js` 里那个真的 `Relay` 类 —— 建一次产物再 import 回来，注入假的
 * sealer / MQTT 客户端，然后按真实时序驱动（发请求 → 断线 → 重连 → 回包）。
 *
 * 1.0.2 的三个病：
 *   A1 `failAll()` 在 MQTT close / restart 里把所有 pending 请求
 *      `clearTimeout + reject + pending.clear()`。用户点进会话 → detail 请求在途 →
 *      网络抖一下 → 立刻 reject → `web/lib/net.js` 抛出「连不上电脑」。
 *      800 ms 后重连成功也救不回来，尽管代码自己的注释写着"桌面按 request id 幂等"。
 *   A3 控制帧只 `send()` 一次，8 秒无应答 → 整屏「未能确认登录状态」。
 *   A6 分片表满时把**新来的**分片丢掉，旧半包只能等 30 秒 TTL。
 *
 * 注意：这里刻意不 import `remote/remote.js` —— 它按**产物布局**引用
 * `./lib/relay-diag.js`，源码目录里没有 `remote/lib/`，只有构建出来的 docs 才有。
 * 所以先 `build-shell.mjs --out <tmp>`，再 import 那棵产物树（与 CI 跑的门禁同一条
 * 构建路径）。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..');
const encoder = new TextEncoder();

let out;
let Relay;

before(async () => {
  out = await mkdtemp(join(tmpdir(), 'pocket-transport-'));
  await run(process.execPath, [join(ROOT, 'tools', 'build-shell.mjs'), '--out', out], { cwd: ROOT });
  ({ Relay } = await import(pathToFileURL(join(out, 'remote.js')).href));
});

after(async () => {
  await rm(out, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 最小 sealer：只做 JSON 往返。真实实现是 AES-GCM，与这里要测的调度无关。 */
const stubSealer = () => ({
  scope: 'scope-test',
  room: 'roomtest',
  seal: async (object) => JSON.stringify(object),
  unseal: async (text) => JSON.parse(text),
});

/** 假 MQTT 客户端：把 publish 的上行帧记下来，供断言（生产里这些是加密密文）。 */
function harness() {
  const published = [];
  const relay = new Relay({ room: 'roomtest', sealer: stubSealer(), brokers: ['wss://broker.invalid:8084/mqtt'] });
  relay.ready = true;
  relay.client = { publish: (topic, payload) => { published.push(JSON.parse(payload)); } };
  return { relay, published };
}

/** 记下 promise 的结局，但**不 await** —— 用来断言"它现在还挂着"。 */
function track(promise) {
  const state = { kind: 'pending', reply: undefined, error: undefined };
  promise.then((reply) => { state.kind = 'resolved'; state.reply = reply; }, (error) => { state.kind = 'rejected'; state.error = error; });
  return state;
}

/** 把一条下行帧塞进 relay（生产里这一步是 MQTT message → unseal）。 */
function deliver(relay, message) {
  return relay.onMessage(encoder.encode(JSON.stringify(message)), relay.client);
}

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const partFrame = (id, seq, total, text) => ({ t: 'part', id, seq, total, d: b64(text) });

/* ---------------------------------- A1 ---------------------------------- */

test('A1：中继断线不再 reject 在途请求（旧实现在 close/restart 里 failAll 清空）', async () => {
  const { relay, published } = harness();
  const request = track(relay.request({ method: 'GET', path: '/api/v1/tasks', headers: {}, gzip: false }));
  await tick();
  assert.equal(published.length, 1, '请求帧应当已经发出');
  assert.equal(published[0].t, 'req');

  // 生产路径：MQTT close → ready=false + abortTransport()（不再 failAll）
  relay.ready = false;
  relay.abortTransport('中继连接中断');
  await tick();
  assert.equal(request.kind, 'pending', '断线期间在途请求必须还活着（旧实现这里已经 rejected）');
  assert.equal(relay.pending.size, 1, 'pending 表不许被清空');

  // 800 ms 后重连成功：ready 恢复 → resendPending() 按同一个 id 重发
  relay.ready = true;
  relay.resendPending();
  await tick();
  assert.equal(published.length, 2, '重连后要立刻重发，而不是等下一个心跳周期');
  const first = published[0];
  const resent = published[1];
  assert.equal(resent.id, first.id, '重发必须用同一个 request id —— 桌面按它幂等，不会重复执行');
  assert.ok(resent.seq > first.seq, '重发要换新的 seq（桌面按 seq 做重放校验）');
  assert.equal(resent.sid, first.sid);

  // 电脑端回包 → 请求正常 resolve
  await deliver(relay, {
    t: 'res', id: first.id, status: 200, headers: {}, body: b64(JSON.stringify({ ok: true })),
  });
  await tick();
  assert.equal(request.kind, 'resolved', '同一个 id 的回包必须能兑现那条还活着的请求');
  assert.equal(request.reply.status, 200);
  assert.equal(relay.pending.size, 0);
});

test('A1：断线期间的发送失败不算结论，只有请求自己的预算能判死（不会立刻报"中继尚未就绪"）', async () => {
  const { relay } = harness();
  // attempts=2：首发之后 1200 ms 才有一次重发；那一次正好落在断线期间。
  const request = track(relay.request({
    method: 'GET', path: '/api/v1/me', headers: {}, gzip: false, timeout: 150, attempts: 2,
  }));
  await tick();
  // 断线：send() 会等 ready 8 秒（这里缩成"等不到就绪"），旧实现当场 reject。
  relay.ready = false;
  relay.waitReady = async () => false;
  // 等第一次退避到点（RPC_BACKOFF_MS[0] = 1200 ms），让 send 真的失败一次。
  await new Promise((resolve) => setTimeout(resolve, 1_280));
  assert.equal(request.kind, 'pending', '传输层的"没连上"不该变成用户的"连不上电脑"');
  assert.notEqual(String(request.error?.message), '中继尚未就绪');
  // 预算（timeout=150 ms 的看门狗）到点才判死。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(request.kind, 'rejected');
  assert.match(String(request.error?.message), /中继请求超时/u);
  relay.waitReady = async () => true;
});

test('A1：终结路径（界面收摊 / 页面被接管）仍然 reject 在途请求，不会让调用方永远挂着', async () => {
  const { relay } = harness();
  const request = track(relay.request({ method: 'GET', path: '/api/v1/tasks', headers: {}, gzip: false }));
  await tick();
  // stop() 是 fatal 页的收尾路径（A8）：界面不会再有人用这些回包了。
  relay.stop('界面已停止');
  await tick();
  assert.equal(request.kind, 'rejected');
  assert.match(String(request.error?.message), /界面已停止/u);
  assert.equal(relay.pending.size, 0, '终结路径必须把 pending 清空，别留没人认领的条目');
});

/* ---------------------------------- A3 ---------------------------------- */

test('A3：控制帧走同一条重发路径，重发的内容必须逐字节相同（桌面按整帧哈希去重）', async () => {
  const { relay, published } = harness();
  const control = track(relay.exchangeControl('auth', {}, 5_000));
  await tick();
  assert.equal(published.length, 1, '控制帧首发');
  const first = published[0];
  assert.equal(first.t, 'auth');

  // 重连成功 → resendPending() 把控制帧一起重发
  relay.ready = false;
  relay.abortTransport('断开');
  relay.ready = true;
  relay.resendPending();
  await tick();
  assert.equal(published.length, 2, '控制帧必须能重发（1.0.2 只 send 一次，丢一帧就整屏"未能确认登录状态"）');
  assert.deepEqual(published[1], first, '必须逐字节相同：换 id / 加 seq 会被桌面当成一次新的登录');

  // 应答到达 → resolve
  await deliver(relay, { t: 'auth.reply', id: first.id, required: false, ok: true, ver: 2 });
  await tick();
  assert.equal(control.kind, 'resolved');
  assert.equal(control.reply.ok, true);
  assert.equal(relay.controlRequests.size, 0, '拿到应答后不许留下残条目');
});

test('A3：控制帧预算到点才 fallback 成 timeout', async () => {
  const { relay } = harness();
  const control = track(relay.exchangeControl('auth', {}, 60));
  await tick();
  assert.equal(control.kind, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(control.kind, 'resolved');
  assert.deepEqual(control.reply, { ok: false, reason: 'timeout' });
  assert.equal(relay.controlRequests.size, 0);
});

/* ---------------------------------- A6 ---------------------------------- */

test('A6：分片表满时淘汰最旧半包（而不是丢掉新片），并立刻重发最老的在途请求', async () => {
  const { relay, published } = harness();
  const request = track(relay.request({ method: 'GET', path: '/api/v1/tasks/1/messages', headers: {}, gzip: false }));
  await tick();
  const beforeCount = published.length;

  // 8 个永远拼不完的半包（运行中大响应被丢弃后留下的都是这种）
  for (let index = 0; index < 8; index += 1) {
    relay.collectPart(partFrame(index.toString(16).padStart(12, '0'), 0, 2, '{"dead":'));
  }
  assert.equal(relay.parts.size, 8);

  // 第 9 组到达：旧实现 `return null`（新片被丢，大响应要等 30 秒 TTL）
  const accepted = relay.collectPart(partFrame('cccccccccccc', 0, 2, '{"id":'));
  assert.equal(accepted, null, '还没拼完');
  assert.equal(relay.parts.size, 8, '表大小仍受上限约束');
  assert.equal(relay.partsDropped, 1, '被淘汰的半包要记进诊断');
  assert.ok(relay.stats.err >= 1);

  // 淘汰 = 那条大响应永远拼不齐：立刻按同一个 id 重发最老的在途请求
  await tick();
  assert.ok(published.length > beforeCount, '淘汰半包后必须立刻重试在途请求，而不是干等超时');
  const resent = published[published.length - 1];
  assert.equal(resent.t, 'req');
  assert.equal(resent.id, published[0].id);

  // 新组真的在表里：补上第二片就能拼出来
  const merged = relay.collectPart(partFrame('cccccccccccc', 1, 2, '"x"}'));
  assert.deepEqual(merged, { id: 'x' });

  await deliver(relay, { t: 'res', id: request.reply?.id ?? published[0].id, status: 200, headers: {}, body: b64('{"ok":true}') });
});

test('A6：合法的完整分片仍能拼回原对象（改造没有破坏正常大响应）', async () => {
  const { relay } = harness();
  const payload = JSON.stringify({ tasks: Array.from({ length: 40 }, (_, index) => ({ id: `t${index}` })) });
  const middle = Math.floor(payload.length / 2);
  assert.equal(relay.collectPart(partFrame('dddddddddddd', 0, 2, payload.slice(0, middle))), null);
  const merged = relay.collectPart(partFrame('dddddddddddd', 1, 2, payload.slice(middle)));
  assert.deepEqual(merged, JSON.parse(payload));
  assert.equal(relay.parts.size, 0, '拼完的半包必须立刻释放');
});

/* ------------------------- A8 / A9：引导流程的接线（静态） ------------------------- */
//
// 这两条都在 `main()` 里，只有在浏览器里跑得起来（要 document / location / MQTT）。
// 但它们钉的是**顺序与唯一出口**，正是缺陷本身：副作用注册在 fatal 之前、
// fatal 之后计时器还在跑。这里按本仓既有的做法（见 relay-restart）做结构断言。

const readShell = () => readFile(join(ROOT, 'remote', 'remote.js'), 'utf8');

test('A8：副作用只在所有 fatal 闸门之后注册，且 fatal 统一走 teardownShell', async () => {
  const source = await readShell();
  const authGateAt = source.indexOf('const authState = await relay.checkAuth();');
  assert.ok(authGateAt > 0, '找不到登录态闸门');
  for (const [label, needle] of [
    ['抢主计时器', 'tabTimer = setInterval('],
    ['pagehide', "listen(window, 'pagehide', release)"],
    ['visibilitychange', "document.addEventListener('visibilitychange', onVisible)"],
  ]) {
    const at = source.indexOf(needle);
    assert.ok(at > 0, `找不到 ${label} 的注册点`);
    assert.ok(at > authGateAt, `${label} 必须在所有可 fatal 的闸门之后注册（死页不能带着计时器跑）`);
  }
  // 看门狗在"传输层建好"之后就要跑（电脑端 hello 可能还没来），但它必须能被
  // teardownShell 停掉 —— 否则 fatal 之后它会在 2 秒内把整条连接重新拉起来。
  const staleWatchAt = source.indexOf('relay.startStaleWatch();');
  assert.ok(staleWatchAt > source.indexOf('await relay.connect();') - 1, '看门狗要在连上之后才起');
  assert.ok(staleWatchAt > 0);

  const teardownAt = source.indexOf('const teardownShell = () => {');
  assert.ok(teardownAt > 0, '必须有统一的 teardownShell()');
  const teardown = source.slice(teardownAt, teardownAt + 700);
  for (const need of ['clearInterval(tabTimer)', 'clearTimeout(relayBannerTimer)', "relay.stop('界面已停止')", 'removeEventListener']) {
    assert.ok(teardown.includes(need), `teardownShell() 必须包含 ${need}`);
  }

  // fatal 的唯一出口：先收尾再画失败页。
  const failBootAt = source.indexOf('const failBoot = (title, detail) => {');
  assert.ok(failBootAt > 0, '必须有统一的 failBoot()');
  const failBoot = source.slice(failBootAt, failBootAt + 260);
  assert.ok(failBoot.includes('teardownShell();'), 'failBoot 必须先 teardownShell');
  assert.ok(failBoot.includes('showFatal(title, detail);'), 'failBoot 必须真的画失败页');

  // 失败页不能只有「重新加载」：1.0.2 的刷新回到的是同一张死页。
  assert.ok(source.includes('function fatalRetryButton()'), '失败页要有「重新连接」按钮');
  assert.ok(source.includes("text: '重新连接'"), '按钮文案必须是「重新连接」');
  assert.ok(source.includes('retryBootAction = retryBoot;'), '引导流程要把重跑入口接到失败页上');
});

test('A9：旧式握手不再整屏硬拦，降级为可操作提示 + 仍然继续', async () => {
  const source = await readShell();
  // 检测保留
  assert.ok(source.includes('if (!relay.supportsAuthReplyId) {'), '旧式握手的检测必须保留');
  // 但不再是 showFatal + return（注释里那句历史说明不算：只找行首就是调用的位置）
  assert.equal(/^\s*showFatal\('需要更新电脑端插件'/mu.test(source), false, '不许再整屏硬拦（刷新回到同一张死页）');
  assert.ok(source.includes('await promptLegacyDesktop();'), '必须降级成可操作的提示');
  const at = source.indexOf('function promptLegacyDesktop()');
  assert.ok(at > 0, '必须有 promptLegacyDesktop()');
  const block = source.slice(at, at + 2_400);
  assert.ok(block.includes('仍然继续'), '提示里必须有「仍然继续」这条出路');
  assert.ok(/插件 \/ 市场/u.test(block), '升级步骤要写具体（在电脑上哪里点）');
  assert.ok(block.includes('location.reload()'), '「重新加载」也要在');
});

