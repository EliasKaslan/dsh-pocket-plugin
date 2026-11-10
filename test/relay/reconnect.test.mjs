/**
 * 「同一台手机反复重连」与「多台手机并存」——用户最在意的场景，也是这里
 * 曾经真出过 bug 的地方。
 *
 * 全部用**真实** CloudLink + 真实 Auth + 真 BridgeCore，只把 MQTT 换成假
 * client（见 test/relay/_support/fixtures.mjs），所以 seal/unseal、登录闸门、
 * 设备登记、会话落盘走的都是线上那条代码路径。
 *
 * 回归的主角：设备身份以前按 `name + platform` 认，而外壳恒发「手机 / web」，
 * 于是第二台手机首次登录会原地轮换掉第一台那条记录 —— 第一台下一帧就收到
 * `revoked: true` 并清掉自己 15 天的登录态。现在按手机自报的 installId 认。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { Auth, hashPassword } from '../../lib/auth.mjs';
import { BridgeCore } from '../../lib/core.mjs';
import { decodeLast, makeLink, makeLogger } from './_support/fixtures.mjs';

const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };
const PASSWORD = '手机口令 Passw0rd!';
const USER = 'owner';

const roots = [];

after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 已经没了 */ }
  }
});

/**
 * 一套「电脑」：真 Auth（凭据落盘）+ 真 BridgeCore（设备与状态落盘）+ 中继。
 *
 * @param {{dir?: string}} [options] 传同一个 dir 就是「同一个安装重启之后」。
 */
function makeWorld({ dir } = {}) {
  const root = dir ?? mkdtempSync(path.join(tmpdir(), 'dsh-pocket-reconnect-'));
  if (dir === undefined) roots.push(root);
  const dataDir = path.join(root, 'pocket');
  const credentialsFile = path.join(root, 'auth.json');
  // 只在第一次创建时写凭据；重启（复用 dir）时保留原文件。
  if (dir === undefined) {
    writeFileSync(credentialsFile, JSON.stringify({
      user: USER,
      password: hashPassword(PASSWORD, 'a'.repeat(32), FAST),
    }), 'utf8');
  }
  const logger = makeLogger();
  const auth = new Auth({
    credentialsFile,
    sessionsFile: path.join(dataDir, 'sessions.json'),
    logger,
    required: true,
  });
  const core = new BridgeCore({}, { home: root, dataDir, qrFile: false }, logger);
  core.attachAuth(auth);
  const { link, sent } = makeLink({ auth, allowAnonymous: false, core, logger });
  return { root, dataDir, auth, core, link, sent, logger };
}

/** 发一次 login，返回电脑的应答。 */
function login(world, { installId, deviceToken, remember } = {}) {
  world.sent.length = 0;
  world.link.handleLogin({
    user: USER,
    password: PASSWORD,
    phone: '手机',
    platform: 'web',
    ...(installId !== undefined ? { installId } : {}),
    ...(deviceToken !== undefined ? { deviceToken } : {}),
    ...(remember !== undefined ? { remember } : {}),
  });
  return decodeLast(world.link, world.sent);
}

/** 发一次 auth 探测（手机带着已有凭据重连时走这条）。 */
function authProbe(world, { token, deviceToken, installId } = {}) {
  world.sent.length = 0;
  world.link.handleAuthCheck({
    token,
    ...(deviceToken !== undefined ? { deviceToken } : {}),
    ...(installId !== undefined ? { installId } : {}),
  });
  return decodeLast(world.link, world.sent);
}

/** 中继有登录预算（10 次/分钟）；用例里需要更多次登录时显式重置。 */
function resetLoginBudget(world) {
  world.link.loginBudget.windowAt = 0;
  world.link.loginBudget.used = 0;
}

/* --------------------------------------------------- 同一台手机反复重连 ---- */

test('同一台手机带着凭据连续重连 5 次：设备不增、令牌不变、会话不增', () => {
  const world = makeWorld();
  const first = login(world, { installId: 'install-phone-a' });
  assert.equal(first.ok, true);
  assert.equal(typeof first.deviceToken, 'string');
  assert.equal(typeof first.deviceId, 'string');

  const sessionsAfterLogin = world.auth.sessions.size;

  for (let round = 1; round <= 5; round += 1) {
    const reply = authProbe(world, {
      token: first.token,
      deviceToken: first.deviceToken,
      installId: 'install-phone-a',
    });
    assert.equal(reply.ok, true, `第 ${round} 次重连必须仍然放行`);
    // 令牌必须原样回显：手机端靠"回到同一个值"确认自己没被顶掉。
    assert.equal(reply.deviceToken, first.deviceToken, `第 ${round} 次重连令牌不该轮换`);
    assert.equal(reply.deviceId, first.deviceId, `第 ${round} 次重连设备身份不该变`);
    assert.equal(reply.revoked, false, `第 ${round} 次重连不能被判成已移除`);
    assert.equal(world.core.devicesView().length, 1, `第 ${round} 次重连后设备数必须还是 1`);
  }
  assert.equal(world.auth.sessions.size, sessionsAfterLogin, '重连不该铸造新会话');
});

test('同一台手机重新登录 3 次：deviceId 恒定、只有最后一枚设备令牌可用', () => {
  const world = makeWorld();
  const seen = [];
  for (let round = 1; round <= 3; round += 1) {
    resetLoginBudget(world);
    const reply = login(world, { installId: 'install-phone-a' });
    assert.equal(reply.ok, true);
    assert.equal(reply.deviceId, seen[0]?.deviceId ?? reply.deviceId, `第 ${round} 次登录 deviceId 不该变`);
    seen.push(reply);
  }
  assert.equal(world.core.devicesView().length, 1, '同一台手机重复登录不该多出设备');

  // 令牌是轮换的：只有最新的那枚认得出设备。
  assert.equal(world.core.authenticateToken(seen[2].deviceToken)?.id, seen[0].deviceId);
  assert.equal(world.core.authenticateToken(seen[0].deviceToken), undefined, '旧设备令牌必须失效');
  assert.equal(world.core.authenticateToken(seen[1].deviceToken), undefined, '旧设备令牌必须失效');
});

/* ----------------------------------------------------- 两台手机不能互顶 ---- */

test('两台同名同平台的手机（不同 installId）各自独立，不再互相顶掉', () => {
  const world = makeWorld();
  const phoneA = login(world, { installId: 'install-phone-a' });
  resetLoginBudget(world);
  const phoneB = login(world, { installId: 'install-phone-b' });

  assert.equal(phoneA.ok, true);
  assert.equal(phoneB.ok, true);
  assert.notEqual(phoneB.deviceId, phoneA.deviceId, '两台手机必须是两条独立设备记录');
  assert.equal(world.core.devicesView().length, 2);

  // 关键回归：后登录的那台不能把先登录的那台顶掉。
  assert.equal(world.core.authenticateToken(phoneA.deviceToken)?.id, phoneA.deviceId, '先登录的手机令牌被顶掉了');
  assert.equal(world.core.authenticateToken(phoneB.deviceToken)?.id, phoneB.deviceId);

  // 两台各自的 auth 探测都必须是 ok，且都不带 revoked。
  const probeA = authProbe(world, { token: phoneA.token, deviceToken: phoneA.deviceToken, installId: 'install-phone-a' });
  assert.equal(probeA.ok, true);
  assert.equal(probeA.revoked, false);
  assert.equal(probeA.deviceId, phoneA.deviceId);
});

test('同一台手机但 installId 变了（清过数据）：按新设备登记，不撞旧记录', () => {
  const world = makeWorld();
  const before = login(world, { installId: 'install-old' });
  resetLoginBudget(world);
  const after = login(world, { installId: 'install-new' });
  assert.notEqual(after.deviceId, before.deviceId);
  assert.equal(world.core.devicesView().length, 2);
});

/* ------------------------------------------------------------- 重启之后 ---- */

test('重启（同一数据目录、全新进程内对象）后仍认得这台手机', () => {
  const first = makeWorld();
  const reply = login(first, { installId: 'install-phone-a' });
  assert.equal(reply.ok, true);

  // 模拟重启：同一 dir，重新 new Auth + BridgeCore + CloudLink。
  const restarted = makeWorld({ dir: first.root });
  assert.equal(restarted.core.devicesView().length, 1, '设备表必须从 state.json 还原');

  const probe = authProbe(restarted, {
    token: reply.token,
    deviceToken: reply.deviceToken,
    installId: 'install-phone-a',
  });
  assert.equal(probe.ok, true, '重启后 15 天内的会话必须仍然有效');
  assert.equal(probe.deviceToken, reply.deviceToken, '重启后设备令牌必须仍然认得');
  assert.equal(probe.deviceId, reply.deviceId);
});

/* --------------------------------------------------------------- 吊销后 ---- */

test('电脑上移除这台手机：带旧令牌重连被判 revoked，重新登录后同一 deviceId 复活', () => {
  const world = makeWorld();
  const granted = login(world, { installId: 'install-phone-a' });
  world.core.revokeDevice(granted.deviceId);
  assert.equal(world.core.devicesView().length, 0, '被移除的设备不再出现在列表里');

  // 旧设备令牌必须不再能换回任何东西。
  const probe = authProbe(world, {
    token: granted.token,
    deviceToken: granted.deviceToken,
    installId: 'install-phone-a',
  });
  assert.equal(probe.deviceToken, null, '已吊销的设备令牌不能被原样回显');
  assert.equal(probe.revoked, true, '必须明确告诉手机「你被移除了」');

  // 重新用口令登录：复用同一条设备记录（installId 还是它），吊销标记被清掉。
  resetLoginBudget(world);
  const again = login(world, { installId: 'install-phone-a' });
  assert.equal(again.ok, true);
  assert.equal(again.deviceId, granted.deviceId, '重新登录应复用同一个设备 id');
  assert.equal(world.core.devicesView().length, 1);
  assert.equal(world.core.authenticateToken(again.deviceToken)?.id, granted.deviceId);
});

/* ------------------------------------------------------- 过期与重新登录 ---- */

test('会话过期后 auth 探测失败，重新登录即恢复且不重复登记设备', () => {
  const world = makeWorld();
  const granted = login(world, { installId: 'install-phone-a' });

  // 把这条会话推到过去，模拟 15 天到期。必须**同时落盘**：`check()` 会先
  // maybeReload()，只改内存里的对象会被磁盘上的旧值覆盖回来。
  const digest = [...world.auth.sessions.keys()][0];
  world.auth.sessions.get(digest).expiresAt = Date.now() - 1;
  world.auth.saveSessions();

  const expired = authProbe(world, {
    token: granted.token,
    deviceToken: granted.deviceToken,
    installId: 'install-phone-a',
  });
  assert.equal(expired.ok, false, '过期的会话令牌必须被拒');
  assert.equal(expired.deviceToken, null);

  resetLoginBudget(world);
  const again = login(world, { installId: 'install-phone-a' });
  assert.equal(again.ok, true);
  assert.equal(again.deviceId, granted.deviceId);
  assert.equal(world.core.devicesView().length, 1, '重新登录不该多出一台设备');
});

/* ------------------------------------------------------------- 口令错误 ---- */

test('口令错误时不登记任何设备，也不发令牌', () => {
  const world = makeWorld();
  world.sent.length = 0;
  world.link.handleLogin({
    user: USER,
    password: '错误的口令',
    phone: '手机',
    platform: 'web',
    installId: 'install-phone-a',
  });
  const reply = decodeLast(world.link, world.sent);
  assert.equal(reply.ok, false);
  assert.equal(reply.deviceToken, undefined);
  assert.equal(world.core.devicesView().length, 0);
});
