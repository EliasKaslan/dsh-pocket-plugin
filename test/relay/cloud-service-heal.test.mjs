/**
 * 中继服务的两条「停在那里不自愈」路径（R4 / R5）—— `lib/cloud-service.mjs`。
 *
 * R4：`ensureIdentity()` 抛一次（瞬时 flush 失败：磁盘忙、杀软临时锁、磁盘满之后
 *   又腾出空间）就让 `start()` 把 state 置成 error，而 `start()` 只由
 *   bridge.status 与管理动作触发 —— 之后**没有任何重试入口**，磁盘恢复了也不自愈。
 *   修法：失败后安排一次延迟重试（退避、有上限、`unref()`）。
 *
 * R5：`rotate()` 里 `rmSync(force)` 只吞 ENOENT，EPERM / EISDIR 照抛；抛出点在
 *   `stop()` 之后，于是中继留在 disabled、`enabled` 还是 true、identity 没清、
 *   也没有自恢复。修法：回滚到「没 rotate 过」并重新把中继开起来。
 *
 * 全部落在 os.tmpdir() 下的一次性目录；broker 指向本机 closed 端口，绝不联网。
 */
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, rmSync,
} from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import { CloudService } from '../../lib/cloud-service.mjs';
import {
  makeLogger, tempDir, waitFor,
} from './_support/fixtures.mjs';

const tmp = tempDir('dsh-pocket-cloud-heal-');
const cores = [];
let counter = 0;

/** 连本机 closed 端口：连接必然失败，且不出网。 */
const DEAD_BROKER = 'ws://127.0.0.1:9/mqtt';
const APP_BASE = 'https://shell.example/app/';
const PORT = 47901;

function makeContext() {
  counter += 1;
  const home = path.join(tmp.dir, `home-${counter}`);
  const dataDir = path.join(home, 'pocket');
  mkdirSync(dataDir, { recursive: true });
  const logger = makeLogger();
  const core = new BridgeCore({}, { home, dataDir, port: PORT }, logger);
  cores.push(core);
  return { core, dataDir, logger };
}

const okAuth = () => ({
  enabled: true,
  user: 'owner',
  assertUsable() {},
  check: () => null,
  login: () => ({ ok: false, reason: 'bad_credentials' }),
  logout: () => false,
  info: () => ({ enabled: true, user: 'owner', configured: true, required: true }),
});

function makeService(context, config = {}) {
  const service = new CloudService(context.core, {
    logger: context.logger,
    dataDir: context.dataDir,
    config: { enabled: true, appBase: APP_BASE, broker: DEAD_BROKER, ...config },
    auth: okAuth(),
  });
  context.service = service;
  return service;
}

const identityFile = (dataDir) => path.join(dataDir, 'cloud.json');

after(() => {
  for (const core of cores) {
    try { core.dispose(); } catch { /* 已经关了 */ }
  }
  tmp.cleanup();
});

/* ------------------------------------------------------------------ R4 ---- */

test('R4：身份写入瞬时失败后会自动重试，磁盘恢复即自愈（不再永久停在 error）', async () => {
  const context = makeContext();
  // 让保存必然失败：cloud.json 这个路径上放一个目录。
  mkdirSync(identityFile(context.dataDir), { recursive: true });
  const service = makeService(context);
  service.identityRetryBaseMs = 5; // 测试里不真等 2 秒

  try {
    assert.equal(service.start(PORT), 'error');
    assert.equal(service.state, 'error');
    assert.equal(service.link, undefined);
    assert.ok(service.status().identityRetryAt > 0, '失败后必须安排一次重试（否则永远没有入口）');

    // "磁盘恢复"：把占位目录删掉，之后不该再有人碰它。
    rmSync(identityFile(context.dataDir), { recursive: true });

    assert.ok(
      await waitFor(() => service.state !== 'error', { timeout: 3000 }),
      `瞬时失败之后必须自愈（实际 state=${service.state} lastError=${service.lastError}）`,
    );
    assert.notEqual(service.link, undefined, '必须真的把中继重新建起来');
    assert.equal(service.enabled, true);
    assert.ok(existsSync(identityFile(context.dataDir)), '这次身份真的落盘了');
    assert.ok(context.logger.lines.some((line) => line.includes('重试生成远程中继身份')), '重试要留痕');
    assert.equal(service.status().identityRetryAt, 0, '成功之后不该还有待重试');
  } finally {
    service.dispose();
  }
});

test('R4：重试有上限 —— 一直失败就放弃并留一条明确的日志，不无限重试', async () => {
  const context = makeContext();
  mkdirSync(identityFile(context.dataDir), { recursive: true });
  const service = makeService(context);
  service.identityRetryBaseMs = 5;
  service.identityRetryMaxAttempts = 2;

  try {
    assert.equal(service.start(PORT), 'error');
    assert.ok(
      await waitFor(() => context.logger.lines.some((line) => line.includes('已停止自动重试')), { timeout: 3000 }),
      '必须放弃并说明原因',
    );
    assert.equal(service.identityRetry.timer, undefined, '放弃之后不许留下定时器');
    assert.equal(service.state, 'error', '仍如实报 error，不假装成功');
    assert.equal(service.status().identityRetryAt, 0);
  } finally {
    service.dispose();
  }
});

test('R4：stop()/dispose() 会取消待重试（关掉的服务不许自己复活）', async () => {
  const context = makeContext();
  mkdirSync(identityFile(context.dataDir), { recursive: true });
  const service = makeService(context);
  service.identityRetryBaseMs = 20;

  assert.equal(service.start(PORT), 'error');
  assert.notEqual(service.identityRetry.timer, undefined);
  service.stop();
  assert.equal(service.identityRetry.timer, undefined, 'stop 必须取消待重试');
  assert.equal(service.identityRetry.attempts, 0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(service.state, 'disabled', '停掉之后不许被重试悄悄拉起来');
  assert.equal(service.link, undefined);
  assert.equal(
    context.logger.lines.some((line) => line.includes('重试生成远程中继身份')),
    false,
    '取消之后不许再发生任何一次重试',
  );
  service.dispose();
});

/* ------------------------------------------------------------------ R5 ---- */

test('R5：rotate 删除身份文件失败 → 回滚到「没 rotate 过」并重开中继，不许停在 disabled', () => {
  const context = makeContext();
  const service = makeService(context);
  const first = service.ensureIdentity();
  const oldLink = {
    localPort: PORT,
    state: 'online',
    start() { return true; },
    stop() { this.stopped = true; },
    status() { return { state: 'online', broker: DEAD_BROKER, room: first.room, url: 'https://shell/x', deviceId: first.deviceId, stats: {}, lastError: '', guard: { blocked: null } }; },
  };
  service.link = oldLink;
  service.port = PORT;
  service.config.enabled = true;
  // 模拟真实的 EPERM / EISDIR：删除失败时抛出，且此时旧身份仍然完好。
  service.discardIdentity = () => {
    const error = new Error('EPERM: operation not permitted, unlink cloud.json');
    error.code = 'EPERM';
    throw error;
  };

  try {
    const status = service.rotate();
    assert.equal(oldLink.stopped, true, '先停掉旧隧道是对的');
    assert.notEqual(status.state, 'disabled', '删除失败不许把中继留在 disabled（旧代码就停在这里）');
    assert.notEqual(service.link, undefined, '必须把中继重新开起来');
    assert.equal(service.enabled, true);
    assert.match(service.lastError, /重置链接失败/u, '要留下可读原因');
    assert.ok(context.logger.lines.some((line) => line.includes('重置链接失败')));
    // 回滚的含义：旧身份（二维码）必须还能用。
    assert.equal(service.identity?.room, first.room);
    assert.equal(service.identity?.deviceId, first.deviceId);
    assert.equal(context.core.authenticateToken(first.token)?.id, first.deviceId, '旧令牌不许被吊销');
  } finally {
    service.dispose();
  }
});

test('R5：discardIdentity 本身 fail-closed —— 删不掉就抛，不许先吊销再报错', () => {
  const context = makeContext();
  const service = makeService(context);
  const first = service.ensureIdentity();
  // `rmSync(force: true)` 只吞 ENOENT：目录占位会抛 EISDIR（Windows 上是 EPERM/EISDIR）。
  rmSync(identityFile(context.dataDir), { force: true });
  mkdirSync(identityFile(context.dataDir), { recursive: true });

  try {
    assert.throws(() => service.discardIdentity(), /EISDIR|EPERM|directory|目录/iu);
    assert.equal(service.identity?.deviceId, first.deviceId, '删除失败不许清掉内存身份');
    assert.notEqual(context.core.authenticateToken(first.token), undefined, '删除失败不许吊销旧令牌');
  } finally {
    rmSync(identityFile(context.dataDir), { recursive: true });
    service.dispose();
  }
});

test('R5：rotate 成功路径不受影响（换了房间与密钥、旧令牌作废）', () => {
  const context = makeContext();
  const service = makeService(context);
  const first = service.ensureIdentity();
  service.port = 0; // 不真起 link：只验身份轮换

  try {
    const status = service.rotate();
    assert.notEqual(service.identity?.room, first.room, 'rotete 必须换房间');
    assert.notEqual(service.identity?.key, first.key);
    assert.equal(context.core.authenticateToken(first.token), undefined, '旧令牌必须作废');
    assert.equal(service.lastError, '');
    assert.equal(status.state, 'disabled', '没有端口时就是 disabled（这是正常的，不是错误）');
  } finally {
    service.dispose();
  }
});
