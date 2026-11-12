/**
 * 幂等缓存的键必须包含「方法 + 路径」，不能只用客户端自选的 id。
 *
 * 历史缺陷（v1.0.1）：键只有 id。手机发 `GET /api/v1/me`（id=X）之后，若用同一个
 * id 发 `POST .../prompt`，中继会命中缓存 —— POST **根本不转发**，而客户端收到
 * 200 和上一份 /me 的 body。动作被静默吞掉，界面上看起来还成功了。
 *
 * 这两个用例是一对：第一条要求「同 id 不同请求必须各自转发」，第二条要求
 * 「同 id 同请求的重发仍然只执行一次」—— 修第一条时最容易把第二条弄坏。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeLink, stubFetch, waitFor } from './_support/fixtures.mjs';

test('同 id、不同方法与路径：两条各自转发，不得复用对方回包', async () => {
  const ctx = makeLink();
  const stub = stubFetch('{"ok":true,"src":"FIRST"}');
  try {
    await ctx.link.handleRequest({ id: 'shared', method: 'GET', path: '/api/v1/me' });
    await waitFor(() => ctx.sent.length === 1);

    await ctx.link.handleRequest({
      id: 'shared',
      method: 'POST',
      path: '/api/v1/tasks/task_1/prompt',
      body: Buffer.from('{"text":"hi"}').toString('base64'),
    });
    await waitFor(() => ctx.sent.length === 2);

    assert.equal(stub.calls.length, 2, '同 id 的 POST 不得被 GET 的回包顶掉（否则写操作被静默吞掉）');
  } finally {
    stub.restore();
  }
});

test('同 id、同方法、同路径的重发：仍然只执行一次，第二次回放缓存', async () => {
  const ctx = makeLink();
  const stub = stubFetch('{"ok":true}');
  const request = { id: 'dup', method: 'POST', path: '/api/v1/tasks', body: Buffer.from('{}').toString('base64') };
  try {
    await ctx.link.handleRequest(request);
    await waitFor(() => ctx.sent.length === 1);
    await ctx.link.handleRequest(request);
    await waitFor(() => ctx.sent.length === 2);

    assert.equal(stub.calls.length, 1, '重发必须命中幂等缓存，不能重复执行副作用');
  } finally {
    stub.restore();
  }
});
