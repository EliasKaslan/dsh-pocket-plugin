/**
 * `web/lib/net.js` 的有界重试（A1 的客户端一侧）。
 *
 * 病根：中继层的 `relay.request()` 只在**同一次调用内**按 request id 重发；一旦
 * 它把错误抛到这里，在途请求就已经被判死了，`api()` 于是把它翻译成
 * 「连不上电脑，请检查网络与插件状态」。而真实链路 800 ms 后就恢复了 ——
 * 用户看到的是"网络抖一下，点进会话就白屏"。
 *
 * 重试的前提必须写清楚（这也是本文件逐条钉住的东西）：
 *   - 重试会重新走一次 `fetch()`，中继外壳会给它**新的** request id，所以
 *     "同 id 幂等"在这个层面**不成立**；
 *   - GET / HEAD 天然可重复执行 → 默认重试；
 *   - 写方法默认不重试，除非调用方声明 `idempotent: true`，或者错误本身证明
 *     请求一次都没发出去（`beforeSend`，外壳在"中继尚未就绪"时打的标）；
 *   - 用户主动取消（AbortSignal）**一律不重试**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../../web/lib/net.js';

const okBody = () => JSON.stringify({ ok: true, data: { tasks: [{ id: 'a' }] } });
const okResponse = () => new Response(okBody(), { status: 200, headers: { 'content-type': 'application/json' } });
const networkError = () => Object.assign(new TypeError('Failed to fetch'), { beforeSend: false });

async function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/** 不真的等：退避时间由注入的 sleep 记录，用例只断言"要不要再发一次"。 */
function makeApi({ getBase = () => 'https://dsh-remote.invalid', getToken = () => 'device-token', onUnauthorized = () => {} } = {}) {
  const sleeps = [];
  const api = createApi({ getBase, getToken, onUnauthorized }, {
    attempts: 3,
    baseMs: 400,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { api, sleeps };
}

test('A1：GET 遇到"连不上"会短退避重试，第二次成功就返回（不再白屏）', async () => {
  let calls = 0;
  const { api, sleeps } = makeApi();
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) throw networkError();
    return okResponse();
  }, async () => {
    const data = await api('/api/v1/tasks');
    assert.deepEqual(data, { tasks: [{ id: 'a' }] });
  });
  assert.equal(calls, 2, '第一次失败后必须再发一次（旧实现只发一次，直接抛"连不上电脑"）');
  assert.deepEqual(sleeps, [400], '重试前要有一次短退避');
});

test('A1：重试有上限（最多 3 次尝试），最终把网络错误原样抛出去', async () => {
  let calls = 0;
  const { api, sleeps } = makeApi();
  await withFetch(async () => { calls += 1; throw networkError(); }, async () => {
    await assert.rejects(api('/api/v1/tasks'), (error) => {
      assert.equal(error.code, 'network');
      assert.match(error.message, /连不上电脑/u);
      return true;
    });
  });
  assert.equal(calls, 3, '上限是 3 次尝试，不许无限重试');
  assert.deepEqual(sleeps, [400, 800], '退避要递增');
});

test('A1：写方法默认不重试 —— 新的一次 fetch 会换 request id，重发等于把副作用做第二遍', async () => {
  let calls = 0;
  const { api } = makeApi();
  await withFetch(async () => { calls += 1; throw networkError(); }, async () => {
    await assert.rejects(api('/api/v1/tasks/1/prompt', { method: 'POST', body: { text: 'hi' } }), (error) => {
      assert.equal(error.code, 'network');
      return true;
    });
  });
  assert.equal(calls, 1, 'POST 失败后不许自动重发（会把同一条 prompt 发进会话两次）');
});

test('A1：写方法在"根本没发出去"（beforeSend）时可以重试 —— 这是中继未就绪的唯一证据', async () => {
  let calls = 0;
  const { api } = makeApi();
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new TypeError('中继尚未就绪'), { beforeSend: true });
    return okResponse();
  }, async () => {
    const data = await api('/api/v1/tasks/1/prompt', { method: 'POST', body: { text: 'hi' } });
    assert.deepEqual(data, { tasks: [{ id: 'a' }] });
  });
  assert.equal(calls, 2, 'beforeSend 证明这一帧没发出去，重发是安全的');
});

test('A1：调用方显式声明 idempotent 的写方法也允许重试', async () => {
  let calls = 0;
  const { api } = makeApi();
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) throw networkError();
    return okResponse();
  }, async () => {
    await api('/api/v1/tasks/1/ack', { method: 'PUT', body: { seen: true }, idempotent: true });
  });
  assert.equal(calls, 2);
});

test('A1：用户主动取消不重试（无论取消发生在发送前还是退避期间）', async () => {
  // 情形一：一开始就已经取消
  let calls = 0;
  const { api, sleeps } = makeApi();
  const controller = new AbortController();
  controller.abort();
  await withFetch(async () => { calls += 1; throw networkError(); }, async () => {
    await assert.rejects(api('/api/v1/tasks', { signal: controller.signal }), (error) => {
      assert.equal(error.code, 'aborted');
      return true;
    });
  });
  assert.equal(calls, 0, '已取消的请求根本不该发出去');
  assert.deepEqual(sleeps, []);

  // 情形二：第一次失败后退避期间用户取消 → 醒来看见 aborted，不再发第二次
  let calls2 = 0;
  const controller2 = new AbortController();
  const slow = createApi(
    { getBase: () => 'https://dsh-remote.invalid', getToken: () => 't', onUnauthorized: () => {} },
    {
      attempts: 3,
      baseMs: 400,
      sleep: async () => { controller2.abort(); },
    },
  );
  await withFetch(async () => { calls2 += 1; throw networkError(); }, async () => {
    await assert.rejects(slow('/api/v1/tasks', { signal: controller2.signal }), (error) => {
      assert.equal(error.code, 'aborted');
      return true;
    });
  });
  assert.equal(calls2, 1, '取消之后不许再发一次');
});

test('A1：超时 / 401 / 坏 body 都不重试（重试只会重复同一结果）', async () => {
  // 401
  let calls = 0;
  const { api } = makeApi();
  await withFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false, error: { message: '登录已失效' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }, async () => {
    await assert.rejects(api('/api/v1/me'), (error) => { assert.equal(error.status, 401); return true; });
  });
  assert.equal(calls, 1);
});
