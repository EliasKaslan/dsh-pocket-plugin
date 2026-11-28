/**
 * `web/lib/net.js` 与外壳（`remote/remote.js`）之间的**错误归属**。
 *
 * 病根：外壳抛什么都长一个样，net.js 一律当成「连不上电脑」（`code: 'network'`）
 * → **可重试** → 换一个新的 request id 把整条请求重来一遍。而外壳刚刚已经用
 * **同一个 request id** 幂等重放了 4 次、整整跑完一个预算（15.2 s）。于是：
 *
 *   - 用户的等待从 15 s 变成 30 s+（界面上的「加载中…」一直不动）；
 *   - 电脑端日志里出现"同一个会话在数秒内被完整请求多次"（每次重试都是新 id，
 *     是**真的重新执行**，不是命中幂等缓存）；
 *   - 用户看到的原因永远是一句错的「连不上电脑」——链路明明是通的。
 *
 * 现在外壳给自己的结论打 `pocketCode`（`relay_timeout` / `decompress` / `relay`），
 * net.js 原样透出原因、并且**不再重试**。这个文件钉住的就是这条边界。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../../web/lib/net.js';

async function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/** 重试不发生等待：只记录"要不要再发一次"。 */
function makeApi() {
  const sleeps = [];
  const api = createApi(
    { getBase: () => 'https://dsh-remote.invalid', getToken: () => 'device-token', onUnauthorized: () => {} },
    { attempts: 3, baseMs: 400, sleep: async (ms) => { sleeps.push(ms); } },
  );
  return { api, sleeps };
}

test('外壳已判死的 relay_timeout：不重试，且把真实原因翻出来（不是「连不上电脑」）', async () => {
  let calls = 0;
  const { api, sleeps } = makeApi();
  const shellError = Object.assign(new Error('中继请求超时'), { pocketCode: 'relay_timeout', timeoutMs: 8_000 });
  let caught = null;
  await withFetch(async () => { calls += 1; throw shellError; }, async () => {
    try {
      await api('/api/v1/tasks/abc', { timeout: 20_000 });
    } catch (error) {
      caught = error;
    }
  });
  assert.equal(calls, 1, '同一个 id 的幂等重放已经跑完 → 换新 id 再来一轮只是把等待翻倍');
  assert.deepEqual(sleeps, [], '不重试就不该有退避等待');
  assert.equal(caught?.code, 'relay_timeout', 'code 要原样透给界面/诊断');
  assert.equal(caught?.relayConfirmed, true);
  assert.match(String(caught?.message), /回包没送到手机/u, '原因必须说人话，而不是「连不上电脑」');
  assert.equal(/连不上电脑/u.test(String(caught?.message)), false);
});

test('解压失败（decompress）同样不重试：整份 108 KB 的重拉解决不了坏字节', async () => {
  let calls = 0;
  const { api } = makeApi();
  let caught = null;
  await withFetch(async () => {
    calls += 1;
    throw Object.assign(new Error('大响应解压失败：invalid gzip'), { pocketCode: 'decompress' });
  }, async () => {
    try {
      await api('/api/v1/tasks/abc');
    } catch (error) {
      caught = error;
    }
  });
  assert.equal(calls, 1);
  assert.equal(caught?.code, 'decompress');
  assert.match(String(caught?.message), /解压/u);
});

test('真正的传输层失败仍然按原策略重试（这次修的是"归属"，不是把重试关掉）', async () => {
  let calls = 0;
  const { api, sleeps } = makeApi();
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ ok: true, data: { done: true } }), { status: 200 });
  }, async () => {
    const data = await api('/api/v1/tasks');
    assert.deepEqual(data, { done: true });
  });
  assert.equal(calls, 2, '没有 pocketCode 的失败仍然可重试（网络抖动要能吃掉）');
  assert.deepEqual(sleeps, [400]);
});

test('parts_lost：丢片不是"回声慢"，换新 id 重切一份响应才是对的', async () => {
  let calls = 0;
  const { api, sleeps } = makeApi();
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('大响应的分片没到齐（下行丢了片）'), { pocketCode: 'parts_lost' });
    return new Response(JSON.stringify({ ok: true, data: { done: true } }), { status: 200 });
  }, async () => {
    const data = await api('/api/v1/tasks/abc');
    assert.deepEqual(data, { done: true });
  });
  assert.equal(calls, 2, 'GET 遇到丢片必须再试一次（重新切一份响应比原样重放更可能成功）');
  assert.deepEqual(sleeps, [400]);
});

test('parts_lost 也不许把写方法重做一遍（除非调用方声明幂等）', async () => {
  let calls = 0;
  const { api } = makeApi();
  let caught = null;
  await withFetch(async () => {
    calls += 1;
    throw Object.assign(new Error('大响应的分片没到齐（下行丢了片）'), { pocketCode: 'parts_lost' });
  }, async () => {
    try {
      await api('/api/v1/tasks/abc/prompt', { method: 'POST', body: { prompt: 'hi' } });
    } catch (error) {
      caught = error;
    }
  });
  assert.equal(calls, 1, 'POST 重放 = 把同一条 prompt 发进会话两次');
  assert.equal(caught?.code, 'parts_lost');
  assert.match(String(caught?.message), /分片没到齐/u);
});

test('应用侧自己的超时仍然翻成「请求超时」且不重试', async () => {
  let calls = 0;
  const { api } = makeApi();
  let caught = null;
  await withFetch(async () => { calls += 1; throw new DOMException('aborted', 'AbortError'); }, async () => {
    try {
      await api('/api/v1/tasks');
    } catch (error) {
      caught = error;
    }
  });
  assert.equal(calls, 1, '超时重试只会重复同一结果');
  assert.equal(caught?.code, 'timeout');
  assert.match(String(caught?.message), /请求超时/u);
});
