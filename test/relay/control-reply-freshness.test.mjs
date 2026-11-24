/**
 * 控制回复缓存命中、但会话/设备已失效时的应答语义（R11）—— `lib/cloud.mjs` 的
 * `handleControl()`。
 *
 * 旧代码对**所有**"缓存命中但已失效"的情况都回 `revoked: true`。手机端
 * （`remote/remote.js`）对 `revoked: true` 的反应是**丢掉自己的设备令牌**并重走
 * 一次配对；可"只是登录会话过期"时设备令牌其实还好好活着，用户白白多一次重新
 * 扫码。正确的区分只有一条判据：
 *   - 设备令牌本身失效（设备被移除 / 被吊销）→ `revoked: true`（必须让手机丢掉）；
 *   - 只是会话过期 → `reason: 'expired'` + `revoked: false`（重新登录即可）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import {
  decodeLast, makeLink, makeLogger, tempDir,
} from './_support/fixtures.mjs';

const PASSWORD = '正确口令 Passw0rd!';
const SESSION = 'login_session_token_0123456789abcdef';
const tmp = tempDir('dsh-pocket-control-reply-');
const cores = [];
let counter = 0;

function makeCore() {
  counter += 1;
  const home = path.join(tmp.dir, `home-${counter}`);
  const logger = makeLogger();
  const core = new BridgeCore({}, { home, dataDir: path.join(home, 'pocket'), port: 47901 }, logger);
  cores.push(core);
  return core;
}

/** 会话表可外部操控的 auth 桩：过期 = 删会话；吊销 = 只动设备记录（由 core 负责）。 */
function makeAuth() {
  const sessions = new Map();
  return {
    enabled: true,
    user: 'owner',
    sessions,
    assertUsable() {},
    check(token) {
      const session = sessions.get(token);
      return session === undefined ? null : { phone: 'Pixel 9', expiresAt: session.expiresAt, deviceHash: session.deviceHash };
    },
    login() {
      const token = SESSION;
      sessions.set(token, { expiresAt: Date.now() + 15 * 24 * 3600_000 });
      return { ok: true, token, expiresAt: Date.now() + 15 * 24 * 3600_000, user: 'owner' };
    },
    bindDevice(token, deviceHash) {
      const session = sessions.get(token);
      if (session !== undefined) session.deviceHash = deviceHash;
    },
    logout(token) {
      return sessions.delete(token);
    },
    info: () => ({ enabled: true, user: 'owner', configured: true, required: true }),
  };
}

function makeWorld() {
  const core = makeCore();
  const logger = makeLogger();
  const auth = makeAuth();
  const { link, sent } = makeLink({ auth, allowAnonymous: false, logger, core });
  return { core, link, sent, auth, logger };
}

/** 一次能进控制回复缓存（id 是 16~32 位 hex）的登录帧。 */
const loginFrame = () => ({
  t: 'login', id: 'a'.repeat(24), user: 'owner', password: PASSWORD, phone: 'Pixel 9', platform: 'web', installId: 'phone-a',
});

after(() => {
  for (const core of cores) {
    try { core.dispose(); } catch { /* 已经关了 */ }
  }
  tmp.cleanup();
});

test('R11：缓存命中但只有会话过期 → reason=expired、revoked=false（别让手机白丢设备令牌）', () => {
  const world = makeWorld();
  const { link, sent, auth } = world;
  const frame = loginFrame();

  link.handleControl(frame);
  const granted = decodeLast(link, sent);
  assert.equal(granted.ok, true);
  assert.ok(granted.deviceToken, '登录成功必须下发设备令牌');

  // 只让**会话**过期：设备令牌仍然有效（用户没在电脑上移除设备）。
  auth.sessions.clear();
  sent.length = 0;
  link.handleControl(frame); // 同一条帧 → 命中控制回复缓存
  const expired = decodeLast(link, sent);
  assert.equal(expired.ok, false);
  assert.equal(expired.id, frame.id, '应答必须带回手机发来的 id');
  assert.equal(expired.reason, 'expired', '会话过期就要说 expired');
  assert.equal(expired.revoked, false, '设备令牌还有效时绝不能说「已吊销」');
});

test('R11：缓存命中且设备真被吊销 → reason=revoked、revoked=true（这条语义不能弱化）', () => {
  const world = makeWorld();
  const { link, sent, core } = world;
  const frame = loginFrame();

  link.handleControl(frame);
  const granted = decodeLast(link, sent);
  assert.equal(core.revokeDevice(granted.deviceId), true, '真把设备移除掉');

  sent.length = 0;
  link.handleControl(frame);
  const revoked = decodeLast(link, sent);
  assert.equal(revoked.ok, false);
  assert.equal(revoked.revoked, true, '设备被移除时必须明确告诉手机');
  assert.equal(revoked.reason, 'revoked');
});

test('R11：一切正常时缓存命中直接回原应答（这条捷径不能因为区分语义而被砍掉）', () => {
  const world = makeWorld();
  const { link, sent } = world;
  const frame = loginFrame();

  link.handleControl(frame);
  const first = decodeLast(link, sent);
  sent.length = 0;
  link.handleControl(frame);
  const again = decodeLast(link, sent);
  assert.equal(again.ok, true);
  assert.equal(again.token, first.token, '在有效期内重发必须复用同一条应答');
  assert.equal(again.deviceToken, first.deviceToken);
});
