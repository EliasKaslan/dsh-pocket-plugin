/**
 * `dispose()` 必须能取消"在途"的 `listen()`（R9）—— `lib/core.mjs` 的
 * `startOnce()` / `dispose()`。
 *
 * 时序是问题的全部：`startOnce()` 里 `this.server.listen(...)` 是 await 的，
 * 而 `BridgeServer.close()` 关的是**已经挂上**的 `this.http`（它在 await 之后才
 * 赋值）。于是插件在启动窗口内被关掉时：
 *   - 监听器在 dispose 之后才绑上，没人再关它 → 端口被旧实例永久占住；
 *   - `started` 又被改回 true → 下一次 apply 认为已经启动。
 * 用户看到的是：重载一次端口就顺延到 47902 / 47903…，二维码里的端口跟着变，
 * 手机扫码连到的是上一个（已死）实例。
 *
 * 现在的约定：`await listen()` 返回后先看 `disposed`，是就立刻 `server.close()`
 * 并 return —— 不置 `started`、不写 runtime 文件。
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import { makeLogger, tempDir } from './_support/fixtures.mjs';

/** 造一个 core：dataDir 在一次性临时目录里，绝不碰 ~/.dsh。 */
function makeCore() {
  const tmp = tempDir('dsh-pocket-core-dispose-');
  const dataDir = path.join(tmp.dir, 'pocket');
  mkdirSync(dataDir, { recursive: true });
  const logger = makeLogger();
  const core = new BridgeCore({}, { home: tmp.dir, dataDir, port: 47901, qrFile: false }, logger);
  return { core, tmp, logger };
}

test('启动窗口内 dispose：在途 listen 的监听器必须就地关掉，started 保持 false', async () => {
  const { core, tmp, logger } = makeCore();
  let release;
  const listening = new Promise((resolve) => { release = resolve; });
  /** 每次 close 时"监听器是否已经就绪"：就绪之后那次才是启动窗口的收尾。 */
  const closes = [];
  let released = false;
  core.setServer({
    listen: () => listening,
    close: () => { closes.push(released); },
  });

  const starting = core.start();
  // 监听还没就绪，插件就被关掉了（重载 / 用户关闭）。
  core.dispose();
  released = true;
  release(47901);

  await starting; // 不许抛

  assert.equal(core.disposed, true);
  assert.equal(core.started, false, 'dispose 之后不许把 started 改回 true');
  assert.equal(core.port, 0, '端口不许被当成已绑定（否则下次 apply 会换端口）');
  assert.equal(core.baseUrl, '');
  assert.equal(closes.includes(true), true, '在途 listen 就绪后必须立刻关掉监听器（否则端口被旧实例占住）');
  assert.ok(logger.lines.some((line) => line.includes('被释放')), '必须留一条可诊断的日志');
  tmp.cleanup();
});

test('正常启动（没有 dispose）：照旧 started=true，监听器不被误关', async () => {
  const { core, tmp } = makeCore();
  let closes = 0;
  core.setServer({
    listen: async () => 47901,
    close: () => { closes += 1; },
  });

  await core.start();

  assert.equal(core.disposed, false);
  assert.equal(core.started, true);
  assert.equal(core.port, 47901);
  assert.equal(core.baseUrl, 'http://127.0.0.1:47901');
  assert.equal(closes, 0, '正常路径不许关监听器');

  core.dispose();
  assert.equal(closes, 1, 'dispose 之后才关');
  tmp.cleanup();
});
