/**
 * 热加载 / 热卸载的生命周期验收（不起 DSH、不联网、不碰 ~/.dsh）。
 *
 * 用户的实际诉求是「改完插件不想重启 DSH」。DSH 的 bundle 启停会重新 apply，
 * 所以插件自己必须保证：
 *   1. **卸载干净**：dispose 之后端口真的放手，否则下次加载会被迫顺延端口；
 *   2. **可以反复加载**：同一进程内 apply 三次都正常，每次是独立实例（bootId 不同）；
 *   3. **端口复用**：热重载后仍然绑回原端口（这就是 `canBindWithRetry` 的意义）。
 *
 * 这里用真实的 `apply()` + 真实的 BridgeCore/BridgeServer，只把 Cordis 的
 * `ctx` 换成最小桩（inject/effect/on 三个方法），其余全是线上代码路径。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { apply } from '../../lib/index.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'pocket-hot-reload-'));
// 避开线上 47901，也避开常见端口，减少与并行测试/真实服务撞车的概率。
const PORT = 48_200 + Math.floor(Math.random() * 300);

after(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 已经没了 */ }
});

/**
 * 最小 Cordis ctx 桩。
 *
 * `inject` 立刻回调并给出一个假的 `sessionQuery`：这样插件不必等 4 秒的兜底
 * 定时器，测试跑得快，而且走的是"服务齐全"的正常启动分支。
 */
function makeCtx() {
  const effects = [];
  const childEffects = [];
  const ctx = {
    inject(_names, callback) {
      callback({
        sessionQuery: {
          async listSessions() { return []; },
          async readSurface() { return { events: [], capturedThroughSeq: 0 }; },
        },
        effect(fn) { childEffects.push(fn); return () => {}; },
      });
    },
    effect(fn) { effects.push(fn); return () => {}; },
    on() { return () => {}; },
  };
  return {
    ctx,
    /** 按 Cordis 的语义倒序执行所有 effect 的清理函数。 */
    dispose() {
      for (const fn of [...childEffects, ...effects].reverse()) {
        try {
          const cleanup = fn();
          if (typeof cleanup === 'function') cleanup();
        } catch { /* 清理失败不该让测试崩，下面用端口可用性判定 */ }
      }
      effects.length = 0;
      childEffects.length = 0;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function health(port, timeoutMs = 700) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return await response.json();
  } catch {
    return null;
  }
}

async function waitUp(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await health(port);
    if (body?.data?.started === true) return body.data;
    if (Date.now() > deadline) return null;
    await sleep(30);
  }
}

test('apply → dispose → apply 三轮：每次都起来、每次都是新实例、结束后端口释放', async () => {
  const bootIds = new Set();

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const world = makeCtx();
    apply(world.ctx, {
      home: root,
      dataDir: path.join(root, `pocket-cycle-${cycle}`),
      qrFile: false,
      port: PORT,
      serverName: '热重载测试',
      // 中继关掉：本用例只验生命周期，不联网。
      cloud: { enabled: false },
    });

    const status = await waitUp(PORT);
    assert.notEqual(status, null, `第 ${cycle} 轮：端口 ${PORT} 上没起来`);
    assert.equal(status.started, true);
    assert.equal(status.requiresLogin, true);
    assert.equal(status.port, PORT, `第 ${cycle} 轮：必须复用首选端口（否则热重载会把地址挪走）`);
    assert.equal(typeof status.bootId, 'string');
    assert.ok(status.bootId.length > 0, 'health 必须带 bootId');
    bootIds.add(status.bootId);

    world.dispose();

    // 卸载之后端口必须真的放手（否则下一次加载会顺延到下一个端口）。
    let released = false;
    const deadline = Date.now() + 3000;
    for (;;) {
      if ((await health(PORT, 250)) === null) { released = true; break; }
      if (Date.now() > deadline) break;
      await sleep(40);
    }
    assert.equal(released, true, `第 ${cycle} 轮：dispose 之后端口 ${PORT} 仍可访问`);
  }

  assert.equal(bootIds.size, 3, `三轮必须是三个不同实例，实际 ${[...bootIds].join(',')}`);
});

test('卸载是幂等的：连着 dispose 两次不抛，也不会让端口更难释放', async () => {
  const world = makeCtx();
  apply(world.ctx, {
    home: root,
    dataDir: path.join(root, 'pocket-idempotent'),
    qrFile: false,
    port: PORT,
    cloud: { enabled: false },
  });
  assert.notEqual(await waitUp(PORT), null, '这一轮没起来');

  world.dispose();
  assert.doesNotThrow(() => world.dispose(), '重复清理不该抛');
  assert.equal(await health(PORT, 300), null, '端口仍应处于释放状态');
});
