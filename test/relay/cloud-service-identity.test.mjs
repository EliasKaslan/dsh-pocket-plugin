/**
 * 安全性质 7：中继身份的生成 / 持久化 / 损坏处理（lib/cloud-service.mjs）。
 *
 * 身份文件（cloud.json）里放着房间号、AES 钥匙和设备令牌：它是二维码的全部内容。
 *  - 生成：room/key/token/deviceId 一次写全，令牌必须是本机真实可鉴权的设备；
 *  - 持久化：同一台机器重启后二维码不变（否则每次重启都要重扫）；
 *  - 损坏：缺字段 / 密钥格式非法 / 文件不是 JSON → **重新生成**，绝不静默沿用；
 *  - 令牌被吊销 → 重新生成（不能复活一个已吊销的凭证）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import { CloudService } from '../../lib/cloud-service.mjs';
import { makeLogger, tempDir } from './_support/fixtures.mjs';

const tmp = tempDir('dsh-pocket-cloud-service-');
const cores = [];
let counter = 0;

/** 每个用例一套独立的 home/dataDir（全在 os.tmpdir() 下的一次性目录里）。 */
function makeCore() {
  counter += 1;
  const home = path.join(tmp.dir, `home-${counter}`);
  const dataDir = path.join(home, 'pocket');
  const logger = makeLogger();
  const core = new BridgeCore({}, {
    home, dataDir, host: '127.0.0.1', port: 47901,
  }, logger);
  cores.push(core);
  return { core, dataDir, logger };
}

function makeService({ core, dataDir, logger }, config = {}, { auth, authRequired } = {}) {
  return new CloudService(core, {
    logger, dataDir, config, auth, authRequired,
  });
}

function identityFile(dataDir) {
  return path.join(dataDir, 'cloud.json');
}

const APP_BASE = 'https://shell.example/app/';
const fakeAuth = () => ({
  enabled: true,
  user: 'owner',
  assertUsable() {},
  check: () => null,
  login: () => ({ ok: false, reason: 'bad_credentials' }),
  logout: () => false,
  info: () => ({ enabled: true, user: 'owner', configured: true, required: true }),
});

after(() => {
  for (const core of cores) {
    try { core.dispose(); } catch { /* 已经关了 */ }
  }
  tmp.cleanup();
});

test('首次生成：room/key/token/deviceId 全部落盘，令牌绑定到本机真实设备', () => {
  const context = makeCore();
  const service = makeService(context, { appBase: APP_BASE });

  const identity = service.ensureIdentity();
  assert.match(identity.room, /^[A-Za-z0-9_-]{8,64}$/u, 'room 是 base64url 的 128-bit id');
  assert.equal(Buffer.from(identity.key, 'base64url').length, 32, 'AES-256 必须正好 32 字节');
  assert.ok(identity.token.length >= 20);
  assert.match(identity.token, /^dshb_/u, '中继令牌与手机设备令牌同一类');
  assert.match(identity.deviceId, /^dev_/u);

  assert.equal(existsSync(identityFile(context.dataDir)), true);
  const saved = JSON.parse(readFileSync(identityFile(context.dataDir), 'utf8'));
  assert.deepEqual(
    { room: saved.room, key: saved.key, token: saved.token, deviceId: saved.deviceId },
    identity,
    '落盘内容必须与内存一致',
  );
  assert.ok(typeof saved.updatedAt === 'string' && saved.updatedAt.length > 0);

  const device = context.core.authenticateToken(identity.token);
  assert.notEqual(device, undefined, '二维码里的令牌必须真的能通过本机鉴权');
  assert.equal(device.id, identity.deviceId);
  assert.equal(device.name, '远程中继');
  assert.equal(device.platform, 'relay');
  assert.equal(service.identity, identity);
});

test('持久化：同一台机器再次 ensureIdentity 复用同一套身份，不新增设备', () => {
  const context = makeCore();
  const service = makeService(context, { appBase: APP_BASE });
  const first = service.ensureIdentity();
  const devicesAfterFirst = context.core.devicesView().length;

  const again = service.ensureIdentity();
  assert.deepEqual(again, first, '重启后二维码必须不变');
  assert.equal(context.core.devicesView().length, devicesAfterFirst, '复用身份不能再 mint 一台设备');
});

test('新进程（新 core，同一 dataDir）也复用同一套身份', () => {
  const first = makeCore();
  const identity = makeService(first, { appBase: APP_BASE }).ensureIdentity();

  // 第二个 core 读同一个 dataDir：等价于进程重启。
  counter += 1;
  const home = path.dirname(first.dataDir);
  const logger = makeLogger();
  const secondCore = new BridgeCore({}, {
    home, dataDir: first.dataDir, host: '127.0.0.1', port: 47901,
  }, logger);
  cores.push(secondCore);
  const second = new CloudService(secondCore, {
    logger, dataDir: first.dataDir, config: { appBase: APP_BASE },
  });

  assert.deepEqual(second.ensureIdentity(), identity);
});

test('身份文件缺字段 → 重新生成，并给出可读告警', () => {
  const context = makeCore();
  mkdirSync(context.dataDir, { recursive: true });
  // 缺 deviceId（v1 时代的旧文件）。
  writeFileSync(identityFile(context.dataDir), JSON.stringify({
    room: 'OldRoom42', key: Buffer.alloc(32, 9).toString('base64url'), token: 'dshb_old_token_0123456789',
  }), 'utf8');

  const service = makeService(context, { appBase: APP_BASE });
  const identity = service.ensureIdentity();
  assert.notEqual(identity.key, Buffer.alloc(32, 9).toString('base64url'), '损坏的文件不能被静默沿用');
  assert.notEqual(identity.room, 'OldRoom42');
  assert.ok(context.logger.lines.some((line) => line.includes('内容不完整')), '必须留下可读告警');
});

test('密钥格式非法（太短 / 含非法字符）→ 重新生成', () => {
  for (const key of ['short', '!'.repeat(43), 'A'.repeat(20)]) {
    const context = makeCore();
    mkdirSync(context.dataDir, { recursive: true });
    writeFileSync(identityFile(context.dataDir), JSON.stringify({
      room: 'Room1234', key, token: 'dshb_old_token_0123456789', deviceId: 'dev_old',
    }), 'utf8');
    const service = makeService(context, { appBase: APP_BASE });
    const identity = service.ensureIdentity();
    assert.notEqual(identity.key, key, `非法密钥 ${key.slice(0, 6)}… 被沿用了`);
    assert.equal(Buffer.from(identity.key, 'base64url').length, 32);
    assert.ok(context.logger.lines.some((line) => line.includes('内容不完整')));
  }
});

test('身份文件不是 JSON / 是空对象 → 重新生成而不是崩', () => {
  for (const body of ['{ not json', '{}', '', 'null']) {
    const context = makeCore();
    mkdirSync(context.dataDir, { recursive: true });
    writeFileSync(identityFile(context.dataDir), body, 'utf8');
    const service = makeService(context, { appBase: APP_BASE });
    let identity;
    assert.doesNotThrow(() => { identity = service.ensureIdentity(); }, `内容 ${JSON.stringify(body)} 把启动搞崩了`);
    assert.equal(Buffer.from(identity.key, 'base64url').length, 32);
  }
});

test('令牌被吊销 → 重新生成（已吊销的凭证不允许复活）', () => {
  const context = makeCore();
  const service = makeService(context, { appBase: APP_BASE });
  const first = service.ensureIdentity();
  assert.equal(context.core.revokeDevice(first.deviceId), true);

  const second = service.ensureIdentity();
  assert.notEqual(second.token, first.token, '吊销后必须换令牌');
  assert.notEqual(second.room, first.room);
  assert.equal(context.core.authenticateToken(first.token), undefined, '旧令牌必须彻底失效');
  assert.notEqual(context.core.authenticateToken(second.token), undefined);
  assert.ok(context.logger.lines.some((line) => line.includes('令牌已失效')));
});

test('身份写入失败只报错、不抛（磁盘/权限问题不能拖垮插件）', () => {
  const context = makeCore();
  mkdirSync(context.dataDir, { recursive: true });
  // 让目标路径是个目录：rename 一定失败。
  mkdirSync(identityFile(context.dataDir), { recursive: true });
  const service = makeService(context, { appBase: APP_BASE });

  let identity;
  assert.doesNotThrow(() => { identity = service.ensureIdentity(); });
  assert.equal(Buffer.from(identity.key, 'base64url').length, 32);
  assert.ok(context.logger.lines.some((line) => line.includes('身份写入失败')), '写失败必须留 error 日志');
});

test('discardIdentity：撤掉旧设备并清空内存身份；没有身份时也不抛', () => {
  const context = makeCore();
  const service = makeService(context, { appBase: APP_BASE });
  const identity = service.ensureIdentity();
  assert.notEqual(context.core.authenticateToken(identity.token), undefined);

  service.discardIdentity();
  assert.equal(service.identity, undefined);
  assert.equal(context.core.authenticateToken(identity.token), undefined, '换链接必须立刻让旧令牌失效');
  assert.doesNotThrow(() => service.discardIdentity());
});

test('已知问题（见报告）：40 字符合法的 base64url 但解不出 32 字节的 key 会被沿用，start() 抛错', () => {
  const context = makeCore();
  const minted = context.core.mintDevice({ name: '远程中继' });
  mkdirSync(context.dataDir, { recursive: true });
  // 40 个 base64url 字符 → 30 字节；KEY_RE 只校验 40~64 字符，于是被当成合法身份。
  const bogusKey = 'A'.repeat(40);
  writeFileSync(identityFile(context.dataDir), JSON.stringify({
    room: 'RoomBogus42', key: bogusKey, token: minted.token, deviceId: minted.device.id,
  }), 'utf8');

  const service = makeService(context, { appBase: APP_BASE }, { auth: fakeAuth() });
  const loaded = service.loadIdentity();
  assert.equal(loaded.key, bogusKey, '当前实现会原样接受这个 key（这就是问题所在）');
  // 它不会「静默沿用成可用身份」：真正建链时会被 CloudLink 的 32 字节校验拦住。
  assert.throws(() => service.start(47901), /key must decode to 32 bytes/u,
    '当前行为是抛错（调用方 index.mjs 用 try/catch 兜住，但 cloud-service 文档承诺 start() 不抛）');
});
