/**
 * F2：`relay_timeout` 在**链路确实被重建过**之后，允许 GET/HEAD 自动补一次重试。
 *
 * 现场（和 F1 是同一个事故的两半）：一条详情请求挂在下行半死的链路上，外壳的看门狗
 * 在 10 s 按 F1 把链路重建了，可这条请求的**绝对**截止时刻还是 15.2 s —— 于是它在
 * 一条已经换新的链路上烧完旧预算，拿 `relay_timeout` 交到用户手里，还必须手点重试。
 *
 * `web/lib/net.js` 原来的规矩是"`relay_timeout` 一律不重试"（外壳已经跑完同 id 重放，
 * 再来一轮只是把等待翻倍）。这条规矩对"链路没换过"仍然成立，但**漏掉了一种情况**：
 * 重建已经发生，重发一次是全新的链路预算。
 *
 * 这个文件钉住的就是这条例外的**边界**（放宽任何一条都会在这里变红）：
 *   - 只有 `relay_timeout`（`decompress` / 写方法 / 用户取消都不行）；
 *   - 只有 GET/HEAD（写方法换新 request id 是**语义不同**的一条请求）；
 *   - 只有"本次失败之后链路世代号变过"（没重建过就不补）；
 *   - 上限 1 次（第二次还是 relay_timeout 就认输，不许把等待无限翻倍）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../../web/lib/net.js';

const okResponse = () => new Response(JSON.stringify({ ok: true, data: { task: { id: 'a' } } }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

/** 外壳跑完同 id 重放预算后抛的那个错误（`pocketCode` 决定 net.js 怎么归类）。 */
const relayTimeout = () => Object.assign(new Error('中继请求超时'), { pocketCode: 'relay_timeout', timeoutMs: 8_000 });

async function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * @param {{epoch?: () => number, attempts?: number, injectEpoch?: boolean}} [options]
 *   `epoch` 是受控的「链路世代号」（外壳每次重建 +1）；`injectEpoch: false` 时
 *   走默认读法（`globalThis.__POCKET_DIAG__.linkEpoch`），用来验证接线本身。
 */
function makeApi({ epoch = () => 0, attempts = 3, injectEpoch = true } = {}) {
  const sleeps = [];
  const retry = { attempts, baseMs: 400, sleep: async (ms) => { sleeps.push(ms); } };
  if (injectEpoch) retry.linkEpoch = epoch;
  const api = createApi(
    { getBase: () => 'https://dsh-remote.invalid', getToken: () => 'device-token', onUnauthorized: () => {} },
    retry,
  );
  return { api, sleeps };
}

/* ------------------------------ 允许重试的那条路 ------------------------------ */

test('F2：GET + 本次失败之后链路重建过 → 自动补一次重试（第二次成功就返回）', async () => {
  let calls = 0;
  let epoch = 0;
  const { api, sleeps } = makeApi({ epoch: () => epoch });
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) {
      epoch = 1; // 外壳的看门狗（F1）在请求挂着的时候把链路重建了
      throw relayTimeout();
    }
    return okResponse();
  }, async () => {
    const data = await api('/api/v1/tasks/abc', { timeout: 26_000 });
    assert.deepEqual(data, { task: { id: 'a' } }, '新链路上这条请求本该 8~30 ms 就回来');
  });
  assert.equal(calls, 2, '重建已经发生：GET 必须自动补一次，而不是让用户手点重试');
  assert.deepEqual(sleeps, [400], '补之前只有一次短退避（与既有重试策略同一套）');
});

test('F2：HEAD 与 GET 同属读方法，同样允许补一次', async () => {
  let calls = 0;
  let epoch = 0;
  const { api } = makeApi({ epoch: () => epoch });
  await withFetch(async () => {
    calls += 1;
    if (calls === 1) { epoch = 1; throw relayTimeout(); }
    return okResponse();
  }, async () => {
    await api('/api/v1/tasks/abc', { method: 'HEAD' });
  });
  assert.equal(calls, 2);
});

test('F2：默认读法真的读 __POCKET_DIAG__.linkEpoch（没有注入也要能补）', async () => {
  let calls = 0;
  let epoch = 0;
  const realDiag = globalThis.__POCKET_DIAG__;
  globalThis.__POCKET_DIAG__ = { linkEpoch: () => epoch };
  try {
    const { api } = makeApi({ injectEpoch: false });
    await withFetch(async () => {
      calls += 1;
      if (calls === 1) { epoch = 1; throw relayTimeout(); }
      return okResponse();
    }, async () => {
      await api('/api/v1/tasks/abc');
    });
  } finally {
    if (realDiag === undefined) delete globalThis.__POCKET_DIAG__;
    else globalThis.__POCKET_DIAG__ = realDiag;
  }
  assert.equal(calls, 2, '外壳把 linkEpoch 挂在 __POCKET_DIAG__ 上，默认读法必须真的读到它');
});

/* ------------------------------ 仍然不许重试 ------------------------------ */

test('F2：写方法不许补 —— 新 fetch 会换 request id，那是语义不同的一条请求', async () => {
  let calls = 0;
  let epoch = 0;
  const { api, sleeps } = makeApi({ epoch: () => epoch });
  let caught = null;
  await withFetch(async () => {
    calls += 1;
    epoch = 1; // 就算链路重建过，写方法也不许让副作用做第二遍
    throw relayTimeout();
  }, async () => {
    try {
      await api('/api/v1/tasks/abc/prompt', { method: 'POST', body: { prompt: 'hi' } });
    } catch (error) {
      caught = error;
    }
  });
  assert.equal(calls, 1, 'POST 的 relay_timeout 不许自动重发（会把同一条 prompt 发进会话两次）');
  assert.deepEqual(sleeps, []);
  assert.equal(caught?.code, 'relay_timeout');
  assert.equal(caught?.linkRebuilt, true, '仍然要把"链路重建过"带给界面（F3 文案用）');
});

test('F2：没重建过就不补 —— 外壳的同 id 重放已经跑完预算，再来一轮只是把等待翻倍', async () => {
  let calls = 0;
  const { api, sleeps } = makeApi({ epoch: () => 7 });
  let caught = null;
  await withFetch(async () => {
    calls += 1;
    throw relayTimeout();
  }, async () => {
    try {
      await api('/api/v1/tasks/abc', { timeout: 26_000 });
    } catch (error) {
      caught = error;
    }
  });
  assert.equal(calls, 1, '链路世代号没变 → 维持原来的"不重试"（避免 15 s → 30 s+ 的空等）');
  assert.deepEqual(sleeps, []);
  assert.equal(caught?.linkRebuilt, false);
  assert.equal(caught?.autoRetried, false);
});

test('F2：只补一次 —— 第二次仍是 relay_timeout 就认输（不许无限翻倍）', async () => {
  let calls = 0;
  let epoch = 0;
  // 即使 attempts 给了 5，也只是既有普通重试的额度，F2 的例外只给 1 次。
  const { api } = makeApi({ epoch: () => epoch, attempts: 5 });
  let caught = null;
  await withFetch(async () => {
    calls += 1;
    epoch = 1;
    throw relayTimeout();
  }, async () => {
    try {
      await api('/api/v1/tasks/abc', { timeout: 26_000 });
    } catch (error) {
      caught = error;
    }
  });
  assert.equal(calls, 2, `只许补一次（实际发了 ${calls} 次）：第二次还超时说明链路仍没救回来`);
  assert.equal(caught?.linkRebuilt, true);
  assert.equal(caught?.autoRetried, true, '界面据此说"已自动重试 1 次"（F3）');
});

test('F2：例外只给 relay_timeout —— decompress 等"外壳已定论"的失败照旧不重试', async () => {
  let calls = 0;
  let epoch = 0;
  const { api } = makeApi({ epoch: () => epoch });
  let caught = null;
  await withFetch(async () => {
    calls += 1;
    epoch = 1; // 链路重建也不该让坏字节重拉一整份 108 KB 的响应
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
});

test('F2：用户主动取消仍然不补（安全闸门不许被这条例外放宽）', async () => {
  let calls = 0;
  let epoch = 0;
  const { api } = makeApi({ epoch: () => epoch });
  const controller = new AbortController();
  await withFetch(async () => {
    calls += 1;
    epoch = 1;
    controller.abort();
    throw relayTimeout();
  }, async () => {
    await assert.rejects(api('/api/v1/tasks/abc', { signal: controller.signal }), (error) => {
      assert.equal(error.code, 'aborted');
      return true;
    });
  });
  assert.equal(calls, 1);
});
