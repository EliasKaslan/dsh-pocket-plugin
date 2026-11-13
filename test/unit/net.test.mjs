/**
 * 传输层的两个"看起来在工作、其实永远不恢复"的坑（C7 / C8）。
 *
 * C7：`fetch()` 只要拿到响应头就 resolve，而 `clearTimeout()` 原来就写在那一刻。
 * 中继半边挂住时（头已回、body 不进流）`response.text()` 没有超时、永久 pending，
 * `sending` / 翻页就卡到用户手工刷新。
 *
 * C8：页面在后台时定时器只是变慢、不是停，退避照旧每 15 秒拉一次连接；
 * 醒来时中继侧已经堆了几十条隧道。后台只该留一次长延迟，回前台由 kick() 接管。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi, reconnectDelay } from '../../web/lib/net.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 最小的会话对象：只需要 baseUrl / token 两个来源。 */
function makeApi() {
  return createApi({
    getBase: () => 'https://dsh-remote.invalid',
    getToken: () => 'device-token',
    onUnauthorized: () => {},
  });
}

/**
 * 模拟中继"头已回、body 不进流"：`fetch` 立刻 resolve 一个响应，但 body 是
 * 一个永不结束的流，只有 abort 才能把它打断。
 */
function stallingFetch() {
  return (url, init) => {
    const signal = init?.signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true,"data":'));
        signal?.addEventListener('abort', () => {
          try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* 已经 errored */ }
        }, { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  };
}

/** 临时替换 globalThis.fetch，用例结束一定还原（否则会污染同进程的其他用例）。 */
async function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/* --------------------------------------------------------- C7：body 超时 ---- */

test('createApi：响应头已回但 body 卡住时，超时仍然生效（请求不会永久 pending）', async () => {
  await withFetch(stallingFetch(), async () => {
    const api = makeApi();
    // 60 秒的看门狗：把修复回退掉（拿到头就 clearTimeout），请求会永远挂着，
    // 这个用例就以 STILL-PENDING 红掉，而不是把整个测试进程拖死。
    const outcome = await Promise.race([
      api('/api/v1/tasks/1/messages', { timeout: 60 }).then(
        () => ({ kind: 'resolved' }),
        (error) => ({ kind: 'rejected', error }),
      ),
      sleep(1500).then(() => ({ kind: 'STILL-PENDING' })),
    ]);
    assert.notEqual(
      outcome.kind,
      'STILL-PENDING',
      'body 读没有超时：计时器在拿到响应头时就被清掉了，中继半边挂住时请求永久 pending',
    );
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.error.code, 'timeout');
  });
});

test('createApi：外部 signal 取消返回 aborted，不会被误报成超时', async () => {
  await withFetch(stallingFetch(), async () => {
    const api = makeApi();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const outcome = await api('/api/v1/tasks/1/messages', { timeout: 5000, signal: controller.signal })
      .then(() => ({ kind: 'resolved' }), (error) => ({ kind: 'rejected', error }));
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.error.code, 'aborted');
  });
});

test('createApi：正常响应照旧返回 data（超时链路改造没有破坏成功路径）', async () => {
  const fake = async () => new Response(JSON.stringify({ ok: true, data: { tasks: [{ id: 'a' }] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await withFetch(fake, async () => {
    const data = await makeApi()('/api/v1/tasks');
    assert.deepEqual(data, { tasks: [{ id: 'a' }] });
  });
});

test('createApi：服务端 401 会触发 onUnauthorized（成功路径之外的分支没被改坏）', async () => {
  const seen = [];
  const fake = async () => new Response(JSON.stringify({ ok: false, error: { message: '登录已失效' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
  const api = createApi({
    getBase: () => 'https://dsh-remote.invalid',
    getToken: () => 'device-token',
    onUnauthorized: (message) => seen.push(message),
  });
  await withFetch(fake, async () => {
    await assert.rejects(api('/api/v1/me'), (error) => {
      assert.equal(error.status, 401);
      return true;
    });
  });
  assert.deepEqual(seen, ['登录已失效']);
});

/* ------------------------------------------------- C8：后台的重连延迟 ---- */

test('reconnectDelay：指数退避、15 s 封顶、带随机抖动', () => {
  const noJitter = { random: () => 0 };
  // 未封顶时逐次翻倍
  assert.equal(reconnectDelay(0, noJitter), 700);
  assert.equal(reconnectDelay(1, noJitter), 1400);
  assert.equal(reconnectDelay(2, noJitter), 2800);
  // failures 再大也不超过上限
  assert.equal(reconnectDelay(5, noJitter), 15_000);
  assert.equal(reconnectDelay(99, noJitter), 15_000);
  // 抖动只有 0~249 ms，不会把上限顶穿
  assert.ok(reconnectDelay(0) >= 700 && reconnectDelay(0) < 950);
  assert.ok(reconnectDelay(5) >= 15_000 && reconnectDelay(5) < 15_250);
  // 负数/垃圾输入不应算出诡异延迟
  assert.equal(reconnectDelay(-3, noJitter), 700);
  assert.equal(reconnectDelay(Number.NaN, noJitter), 700);
});

test('reconnectDelay：页面在后台时只给一次长延迟，不随失败次数增长', () => {
  const hidden = { hidden: true, random: () => 0 };
  const delays = [0, 1, 3, 12, 99].map((failures) => reconnectDelay(failures, hidden));
  assert.equal(new Set(delays).size, 1, `后台延迟必须固定，实际 ${delays.join(', ')}`);
  assert.ok(delays[0] >= 30_000, '后台的重试间隔必须远大于前台退避上限（15 s）');
  assert.ok(reconnectDelay(9, hidden) > reconnectDelay(9, { random: () => 0 }), '后台一定比前台更慢');
});
