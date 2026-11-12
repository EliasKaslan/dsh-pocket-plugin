/**
 * 口令登录即配对（lib/cloud.mjs 的 provisionFor / handleLogin / handleAuthCheck）。
 *
 * 这是新语义的**安全边界**所在，三条分支必须分清楚：
 *   1. 手机没自报 deviceToken → 铸一台新设备，把 deviceToken/deviceId 随应答下发；
 *   2. 手机自报了**有效**令牌 → 原样回显同一个 token / deviceId，设备数不变；
 *   3. 手机自报了**无效或已吊销**令牌 → 返回 null、`revoked: true`，**绝不补发**。
 *      否则「在电脑上移除设备」形同虚设：那台手机下次用口令登录就会自动复活。
 * 设备数量**没有上限**：来多少台就登记多少台，应答里既没有「名额满」标记，
 * 也不存在因为数量而发不出令牌的分支（`deviceLimit` 字段已删除）。
 *
 * 夹具：test/relay/_support/fixtures.mjs 的 makeLink()（在线但不联网的 CloudLink，
 * publish/onFrame 走真实 seal/unseal）+ 真实 BridgeCore。目录全在 os.tmpdir()。
 *
 * 注意 `link.core`：CloudLink 的构造参数里没有 core，provisionFor() 是**通过实例
 * 属性**取宿主的（`this.core.authenticateToken`）。本文件在 wiredLink() 里显式接上，
 * 以便单独验语义；生产接线目前缺这一环，见文件末尾的「已知问题」用例。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import {
  decodeLast, makeLink, makeLogger, tempDir,
} from './_support/fixtures.mjs';

const TOKEN_RE = /^dshb_[A-Za-z0-9_-]{43}$/u;
const DEVICE_ID_RE = /^dev_[A-Za-z0-9_-]{22}$/u;

const PASSWORD = '正确口令 Passw0rd!';
/** 登录会话令牌（login 应答里的 token，与设备令牌不是一回事）。 */
const SESSION = 'login_session_token_0123456789abcdef';
const EXPIRES_AT = 1_700_000_000_000;

const tmp = tempDir('dsh-pocket-login-provision-');
const cores = [];
let counter = 0;

function makeCore(config = {}) {
  counter += 1;
  const home = path.join(tmp.dir, `home-${counter}`);
  const dataDir = path.join(home, 'pocket');
  const logger = makeLogger();
  const core = new BridgeCore({}, {
    home, dataDir, port: 47901, ...config,
  }, logger);
  cores.push(core);
  return { core, logger };
}

/** 只替换口令校验，不碰 scrypt（与 test/relay/fail-closed.test.mjs 同一套做法）。 */
function fakeAuth({ login, check } = {}) {
  const calls = { login: [], check: [] };
  return {
    enabled: true,
    user: 'owner',
    calls,
    assertUsable() {},
    check(token) {
      calls.check.push(token);
      if (typeof check === 'function') return check(token);
      return token === SESSION ? { phone: 'Pixel 9', expiresAt: EXPIRES_AT } : null;
    },
    login(input) {
      calls.login.push(input);
      if (typeof login === 'function') return login(input);
      return input?.password === PASSWORD
        ? { ok: true, token: SESSION, expiresAt: EXPIRES_AT, user: 'owner' }
        : { ok: false, reason: 'bad_credentials' };
    },
    logout: () => false,
    info: () => ({ enabled: true, user: 'owner', configured: true, required: true }),
  };
}

/**
 * 一只「接上了宿主」的中继：makeLink 给的是在线但不联网的 CloudLink，
 * 这里补上 provisionFor() 需要的那条 core 引用。
 */
function wiredLink({
  core, auth = fakeAuth(), allowAnonymous = false, logger = makeLogger(),
} = {}) {
  // 走构造参数（与 cloud-service.mjs 的接线一致），不再事后赋值。
  return makeLink({ auth, allowAnonymous, logger, core });
}

/** 口令登录一次，返回解开的 login 应答。 */
function login(link, sent, overrides = {}) {
  link.handleLogin({
    user: 'owner', password: PASSWORD, phone: 'Pixel 9', platform: 'web', remember: true, ...overrides,
  });
  return decodeLast(link, sent);
}

after(() => {
  for (const core of cores) {
    try { core.dispose(); } catch { /* 已经关了 */ }
  }
  tmp.cleanup();
});

/* ------------------------------------------------------------------ */
/* 分支 1：没自报令牌 → 铸一台新设备                                    */
/* ------------------------------------------------------------------ */

test('登录成功 + 没带令牌 → 应答带 deviceToken / deviceId / revoked=false', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });

  const reply = login(link, sent);

  assert.equal(reply.t, 'login');
  assert.equal(reply.ok, true);
  assert.equal(reply.token, SESSION, '会话令牌照旧下发');
  assert.match(reply.deviceToken, TOKEN_RE, '设备令牌必须随口令应答一起下发');
  assert.match(reply.deviceId, DEVICE_ID_RE);
  assert.equal(reply.revoked, false);

  const devices = core.devicesView();
  assert.equal(devices.length, 1, '登录成功必须登记这台手机');
  assert.equal(devices[0].id, reply.deviceId);
  assert.equal(devices[0].name, 'Pixel 9', '设备名来自 message.phone');
  assert.equal(devices[0].platform, 'web');
  assert.equal(devices[0].lastIp, 'relay');
  assert.equal(core.authenticateToken(reply.deviceToken).id, reply.deviceId, '下发的令牌必须真的能用');
});

/* ------------------------------------------------------------------ */
/* 分支 2：自报有效令牌 → 原样回显                                      */
/* ------------------------------------------------------------------ */

test('登录成功 + 带上次的有效令牌 → 原样回显，设备数不变', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });
  const first = login(link, sent);

  const again = login(link, sent, { deviceToken: first.deviceToken });

  assert.equal(again.ok, true);
  assert.equal(again.deviceToken, first.deviceToken, '有效令牌必须原样回显，不能换发');
  assert.equal(again.deviceId, first.deviceId);
  assert.equal(again.revoked, false);
  assert.equal(core.devicesView().length, 1, '回显不能再登记一台');
  assert.equal(core.state.devices.length, 1);
});

/* ------------------------------------------------------------------ */
/* 分支 3：自报无效 / 已吊销令牌 → null + revoked，绝不补发               */
/* ------------------------------------------------------------------ */

test('登录成功 + 带已吊销令牌 → revoked=true，绝不补发（移除设备后不能靠重登复活）', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });
  const first = login(link, sent);
  assert.equal(core.revokeDevice(first.deviceId), true);

  const again = login(link, sent, { deviceToken: first.deviceToken });

  assert.equal(again.ok, true, '口令本身是对的，登录仍然成功');
  assert.equal(again.token, SESSION);
  assert.equal(again.deviceToken, null, '已吊销令牌绝不能补发新的');
  assert.equal(again.deviceId, null);
  assert.equal(again.revoked, true, '必须明确告诉手机「你被移除了」');

  assert.equal(core.devicesView().length, 0, '不能靠重新登录自动复活设备');
  assert.equal(core.authenticateToken(first.deviceToken), undefined, '旧令牌必须仍然无效');
  assert.equal(core.state.devices.length, 1, '只有那条吊销记录，没有新设备');
  assert.equal(core.state.devices[0].revoked, true);
});

test('登录成功 + 带伪造/未知令牌 → 同样 revoked=true，一个设备都不登记', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });
  const forged = `dshb_${'A'.repeat(43)}`;

  const reply = login(link, sent, { deviceToken: forged });

  assert.equal(reply.ok, true);
  assert.equal(reply.deviceToken, null);
  assert.equal(reply.deviceId, null);
  assert.equal(reply.revoked, true, '不认识的令牌按「已被移除」处理');
  assert.equal(core.devicesView().length, 0);
  assert.equal(core.state.devices.length, 0);
});

/* ------------------------------------------------------------------ */
/* 设备数量：没有上限                                                  */
/* ------------------------------------------------------------------ */

test('设备数量不再有上限：连续登录不同设备都拿到令牌，应答里没有 deviceLimit 字段', () => {
  // 老配置里可能还留着 maxDevices:1（升级后没删）：必须被忽略，绝不能把第二台挡在门外。
  const { core } = makeCore({ maxDevices: 1 });
  const logger = makeLogger();
  const links = Array.from({ length: 12 }, () => wiredLink({ core, logger }));

  const replies = links.map(({ link, sent }, index) => login(link, sent, {
    phone: `手机 ${index + 1}`, platform: 'web',
  }));

  for (const [index, reply] of replies.entries()) {
    assert.equal(reply.ok, true, `第 ${index + 1} 台登录必须成功`);
    assert.match(reply.deviceToken, TOKEN_RE, `第 ${index + 1} 台必须拿到设备令牌`);
    assert.match(reply.deviceId, DEVICE_ID_RE);
    assert.equal('deviceLimit' in reply, false, '上限已取消，应答里不许再有 deviceLimit 字段');
    assert.equal(reply.revoked, false, '正常登录不是「被移除」');
  }

  assert.equal(core.devicesView().length, 12, '12 台不同设备必须全部登记');
  assert.equal(core.state.devices.length, 12, '磁盘上的设备表也不许被裁剪');
  assert.equal(
    new Set(replies.map((reply) => reply.deviceToken)).size,
    12,
    '每台手机必须各拿各的令牌',
  );
  assert.equal(core.authenticateToken(replies[11].deviceToken).id, replies[11].deviceId);
  assert.equal(
    logger.lines.some((line) => line.includes('device provisioning failed')),
    false,
    '上限没了之后，发放不该再走失败分支',
  );
});

/* ------------------------------------------------------------------ */
/* 负例：登录失败什么都不发                                             */
/* ------------------------------------------------------------------ */

test('口令错误 → 不发设备令牌，也不登记设备', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });

  const reply = login(link, sent, { password: 'wrong password' });

  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'bad_credentials');
  assert.equal(reply.deviceToken, undefined, '失败应答里不该有设备令牌字段');
  assert.equal(reply.deviceId, undefined);
  assert.equal('deviceLimit' in reply, false, '失败应答里不许再有 deviceLimit 字段');
  assert.equal(reply.revoked, undefined);
  assert.equal(core.devicesView().length, 0);
});

/* ------------------------------------------------------------------ */
/* handleAuthCheck：续期路径同样带这四个字段                             */
/* ------------------------------------------------------------------ */

test('auth ok + 带有效令牌（页面刷新续期）→ 回显同一令牌，设备数不变', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });
  const first = login(link, sent);

  link.handleAuthCheck({
    token: SESSION, phone: 'Pixel 9', platform: 'web', deviceToken: first.deviceToken,
  });
  const reply = decodeLast(link, sent);

  assert.equal(reply.t, 'auth');
  assert.equal(reply.ok, true);
  assert.equal(reply.deviceToken, first.deviceToken);
  assert.equal(reply.deviceId, first.deviceId);
  assert.equal(reply.revoked, false);
  assert.equal(core.devicesView().length, 1);
});

test('auth ok + 没带令牌（首次进入）→ 铸一台并把四个字段一起下发', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });

  link.handleAuthCheck({ token: SESSION, phone: 'Pixel 9', platform: 'web' });
  const reply = decodeLast(link, sent);

  assert.equal(reply.ok, true);
  assert.match(reply.deviceToken, TOKEN_RE);
  assert.match(reply.deviceId, DEVICE_ID_RE);
  assert.equal(reply.revoked, false);
  assert.equal(core.devicesView().length, 1);
  assert.equal(core.devicesView()[0].id, reply.deviceId);
  assert.equal(core.authenticateToken(reply.deviceToken).id, reply.deviceId);
});

test('auth ok + 带已吊销令牌 → revoked=true、不补发', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });
  const first = login(link, sent);
  assert.equal(core.revokeDevice(first.deviceId), true);

  link.handleAuthCheck({
    token: SESSION, phone: 'Pixel 9', platform: 'web', deviceToken: first.deviceToken,
  });
  const reply = decodeLast(link, sent);

  assert.equal(reply.ok, true);
  assert.equal(reply.deviceToken, null);
  assert.equal(reply.deviceId, null);
  assert.equal(reply.revoked, true);
  assert.equal(core.devicesView().length, 0);
});

test('auth 不通过（口令无效）→ ok=false，不发令牌也不登记', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });

  link.handleAuthCheck({ token: 'not-a-session', phone: 'Pixel 9', platform: 'web' });
  const reply = decodeLast(link, sent);

  assert.equal(reply.t, 'auth');
  assert.equal(reply.ok, false);
  assert.equal(reply.deviceToken, null);
  assert.equal(reply.deviceId, null);
  assert.equal(reply.revoked, false, 'ok=false 时既不是「满」也不是「被移除」');
  assert.equal(core.devicesView().length, 0);
});

test('免口令部署（allowAnonymous）下 auth 也走同一条发放路径', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core, auth: null, allowAnonymous: true });

  link.handleAuthCheck({ phone: 'Pixel 9', platform: 'web' });
  const reply = decodeLast(link, sent);

  assert.equal(reply.ok, true);
  assert.equal(reply.required, false, '免口令时不该要求登录');
  assert.equal(reply.user, null);
  assert.match(reply.deviceToken, TOKEN_RE, '免口令也必须发设备令牌，否则手机调不动 API');
  assert.equal(reply.deviceId, core.devicesView()[0].id);
  assert.equal(core.devicesView().length, 1);
  assert.equal(core.authenticateToken(reply.deviceToken).id, reply.deviceId);
});

/* ------------------------------------------------------------------ */
/* 同一台手机重复登录 = 原地轮换，不是越登越多                            */
/* ------------------------------------------------------------------ */

test('同一台手机第二次登录（没令牌）→ deviceId 不变、换新令牌、旧令牌立刻失效', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });

  const first = login(link, sent);
  const second = login(link, sent);

  assert.equal(second.deviceId, first.deviceId, '同一台手机必须复用同一个设备');
  assert.notEqual(second.deviceToken, first.deviceToken);
  assert.match(second.deviceToken, TOKEN_RE);
  assert.equal(second.revoked, false);
  assert.equal(core.devicesView().length, 1, '刷新/重登不该每来一次就多一台设备');
  assert.equal(core.state.devices.length, 1);
  assert.equal(core.authenticateToken(first.deviceToken), undefined, '轮换后旧令牌必须立刻失效');
  assert.equal(core.authenticateToken(second.deviceToken).id, first.deviceId);
});

/* ------------------------------------------------------------------ */
/* 令牌不落日志                                                        */
/* ------------------------------------------------------------------ */

test('设备令牌与口令都不进日志', () => {
  const { core } = makeCore();
  const logger = makeLogger();
  const { link, sent } = wiredLink({ core, logger });

  const reply = login(link, sent);
  assert.match(reply.deviceToken, TOKEN_RE);

  const joined = logger.lines.join('\n');
  assert.ok(joined.includes('手机端登录成功'), '前置：确实走到了成功分支');
  assert.equal(joined.includes(reply.deviceToken), false, '设备令牌进了日志');
  assert.equal(joined.includes(PASSWORD), false, '口令进了日志');
  assert.equal(joined.includes(SESSION), false, '会话令牌进了日志');
});

/* ------------------------------------------------------------------ */
/* 已知问题（代码 bug，见报告）：生产接线没有把 core 交给 CloudLink        */
/* 修好接线后：删掉这条用例，前面 13 条已经覆盖了正确语义。               */
/* ------------------------------------------------------------------ */

test('接线：CloudLink 拿到 core 后，口令登录当场发设备令牌（登录即配对）', () => {
  const { core } = makeCore();
  const { link, sent } = wiredLink({ core });
  assert.equal(link.core, core, '构造后必须持有 core 引用');

  const reply = login(link, sent);
  assert.equal(reply.ok, true);
  assert.match(String(reply.deviceToken), /^dshb_[A-Za-z0-9_-]{20,}$/u);
  assert.equal(typeof reply.deviceId, 'string');
  assert.equal('deviceLimit' in reply, false, '上限已取消：应答里不该再有这个字段');

  assert.equal(core.devicesView().length, 1, '登录即登记一台设备');
  const device = core.authenticateToken(reply.deviceToken);
  assert.notEqual(device, undefined, '下发的令牌必须立刻能用于 API');
  assert.equal(device.id, reply.deviceId);

  // 再登一次（带同一令牌）→ 回显同一令牌，设备数不变。
  const again = login(link, sent, { deviceToken: reply.deviceToken });
  assert.equal(again.deviceToken, reply.deviceToken);
  assert.equal(core.devicesView().length, 1);

  // 电脑端移除之后，拿旧令牌重登 → 不补发，且明确报 revoked。
  core.revokeDevice(reply.deviceId);
  const afterRevoke = login(link, sent, { deviceToken: reply.deviceToken });
  assert.equal(afterRevoke.deviceToken, null, '已吊销令牌不许被自动补发');
  assert.equal(afterRevoke.revoked, true);
  assert.equal(core.devicesView().length, 0);
});

test('没有 core 时降级：不发令牌，但应答照常发出（绝不能把应答吞掉）', () => {
  // cloud-service 忘传 core 曾经让手机卡到 15s 超时：应答发不出去比没有令牌更糟。
  const { link, sent } = makeLink({ auth: fakeAuth(), allowAnonymous: false });
  assert.equal(link.core, null, '未注入 core');

  const reply = login(link, sent);
  assert.equal(reply.ok, true, '口令对就必须回 ok，否则手机只能等超时');
  assert.equal(reply.deviceToken, null);
  // 这是接线错误，不是「设备数满」也不是「被移除」：两个标记都不许亮。
  assert.equal('deviceLimit' in reply, false);
  assert.equal(reply.revoked, false);
});
