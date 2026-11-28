/**
 * R1：异步入口的统一兜底（`CloudLink.guard`）——「一条中继请求不能带走宿主进程」。
 *
 * 修的故障：`void this.handleRequest(message)`、定时器回调、mqtt / ws 回调都是
 * "谁调谁不管"的入口。`handleRequest` 的 try 只包了 fetch 段；catch 里再调
 * `respond()` 失败（publish 抛错、日志抛错…）就成了 **unhandledRejection** ——
 * Node 24 默认把它升级成宿主进程级异常：桌面端整个 DSH 被一条手机请求打死。
 *
 * 本文件钉住两件事：
 *  1. `guard()` 自己的契约：同步抛 / 异步 reject 都被接住、计入 `stats.errors`、
 *     绝不重抛（返回 undefined，调用方语义不变）。
 *  2. 可复现判据：人为让 `handleRequest` 在 catch 里抛错，进程仍在、链路仍在、
 *     **没有 unhandledRejection**、同一条链路下一条帧照常处理。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeLast, feed, makeLink, waitFor } from './_support/fixtures.mjs';

const SID = 'a1b2c3d4';

/** 一条合法的 `req` 帧（seq 必须递增、ts 必须新鲜，否则被新鲜度闸拦掉）。 */
function reqFrame(overrides = {}) {
  return {
    t: 'req', id: 'g1', method: 'GET', path: '/api/v1/me', seq: 1, ts: Date.now(), sid: SID, ...overrides,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('guard 契约：同步抛 / 异步 reject 都接住，计入 stats.errors，绝不重抛', async () => {
  const { link } = makeLink({ allowAnonymous: true });
  const before = link.stats.errors;

  assert.doesNotThrow(() => link.guard('sync-boom', () => { throw new Error('sync exploded'); }));
  assert.equal(link.stats.errors, before + 1, '同步异常必须计入 stats.errors');

  // 异步入口：不 await 也不加 .catch 时不许留下 unhandledRejection。
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const returned = link.guard('async-boom', async () => { throw new Error('async exploded'); });
    assert.equal(typeof returned?.then, 'function', '返回的是被接住的 Promise');
    assert.equal(await returned, undefined, 'reject 被吞成 undefined，调用方看不到异常');
    await tick();
    assert.deepEqual(rejections, [], 'guard 之后不许再有 unhandledRejection');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.equal(link.stats.errors, before + 2);
  assert.equal(link.state, 'online', '兜底不影响链路状态');
});

test('R1 判据：handleRequest 在 catch 里抛错 → 宿主不崩、stats.errors 增加、链路继续可用', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);

  const { link, sent, logger } = makeLink({ allowAnonymous: true });
  const originalFetch = globalThis.fetch;
  const originalRespond = link.respond;
  try {
    // ① fetch 必然失败 → handleRequest 走 catch 分支（transport 失败那条）。
    globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:47901'); };
    // ② 再让 catch 里唯一的出口 respond() 抛错 —— 这正是"catch 里再抛"的形状。
    let respondedInCatch = 0;
    link.respond = () => {
      respondedInCatch += 1;
      throw new Error('respond exploded after transport failure');
    };

    const errorsBefore = link.stats.errors;
    // 真实入口：onFrame → dispatch → `void this.guard('req', () => handleRequest(...))`。
    // 没有 guard 时这里会留下 unhandledRejection（Node 24 直接判宿主死刑）。
    assert.doesNotThrow(() => feed(link, reqFrame()));
    await tick();
    await tick();

    assert.equal(respondedInCatch, 1, 'catch 分支真的抛了（否则这个用例什么都没测到）');
    assert.equal(link.stats.errors, errorsBefore + 1, '被 guard 兜住的异常必须计入 stats.errors');
    assert.equal(link.guardFailures, 1);
    assert.ok(
      logger.lines.some((line) => line.includes('warn') && line.includes('异步入口异常') && line.includes('req')),
      `必须留一条可定位的 warn，实际日志：${logger.lines.join(' | ')}`,
    );
    // 进程/链路都还活着：不是"没崩但已经半死"。
    assert.equal(link.state, 'online');
    assert.notEqual(link.client, undefined);

    // ③ 同一个进程里换成正常实现：同一条链路的下一条帧照常处理完。
    link.respond = originalRespond;
    globalThis.fetch = async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    feed(link, reqFrame({ id: 'g2', seq: 2 }));
    assert.ok(await waitFor(() => sent.length > 0), 'guard 之后链路必须还能正常出站');
    assert.equal(decodeLast(link, sent).id, 'g2');
    assert.equal(decodeLast(link, sent).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    link.respond = originalRespond;
    process.off('unhandledRejection', onRejection);
  }

  await tick();
  assert.deepEqual(rejections, [], '整个过程不许出现 unhandledRejection');
});
