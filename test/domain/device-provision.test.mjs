/**
 * 口令登录即配对（lib/core.mjs 的 provisionDevice）——设备令牌的发放语义。
 *
 * 旧世界是两步：口令登录 + 8 位配对码。现在口令通过就直接给这台手机发设备
 * 令牌，于是「什么时候铸新令牌、什么时候复用、什么时候拒绝」变成了安全契约：
 *
 *   - 没给 token：铸一台新设备，令牌形如 `dshb_` + 43 个 base64url 字符，
 *     落盘**只有 sha256**（明文只存在于这次返回值里）；
 *   - 给了有效 token：原样回显同一 token / 同一 device，绝不能顺手多登记一台；
 *   - 同一台手机重装 App 后重登（同名同平台）：**原地轮换**——
 *     同一 device id、新令牌、旧令牌立即失效、设备总数不变；
 *   - 设备数量**没有上限**：不同设备来多少台登记多少台，磁盘上的记录一条都不许被裁剪。
 *
 * 夹具沿用 test/relay/_support/fixtures.mjs（同一套 makeLogger / 一次性 tempDir），
 * 全部目录落在 os.tmpdir()，不碰 %USERPROFILE%\.dsh、不监听端口。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import { sha256 } from '../../lib/util.mjs';
import { makeLogger, tempDir } from '../relay/_support/fixtures.mjs';

/** `randomToken('dshb_')` = 5 + base64url(32B)=43；`randomId('dev_')` = 4 + 22。 */
const TOKEN_RE = /^dshb_[A-Za-z0-9_-]{43}$/u;
const DEVICE_ID_RE = /^dev_[A-Za-z0-9_-]{22}$/u;

const tmp = tempDir('dsh-pocket-provision-');
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
  return { core, home, dataDir, logger };
}

function stateFile(dataDir) {
  return path.join(dataDir, 'state.json');
}

function savedState(dataDir) {
  return JSON.parse(readFileSync(stateFile(dataDir), 'utf8'));
}

after(() => {
  for (const core of cores) {
    try { core.dispose(); } catch { /* 已经关了 */ }
  }
  tmp.cleanup();
});

test('没给 token → 铸一台新设备：dshb_ 令牌、dev_ id，落盘只有 sha256', () => {
  const { core, dataDir } = makeCore();

  const issued = core.provisionDevice({
    name: 'Pixel 9', platform: 'android', appVersion: '2.0.0', ip: '10.0.0.7',
  });

  assert.match(issued.token, TOKEN_RE, '设备令牌必须是 dshb_ 前缀的 48 字符');
  assert.match(issued.device.id, DEVICE_ID_RE, '设备 id 必须是 dev_ 前缀');
  assert.equal(issued.device.name, 'Pixel 9');
  assert.equal(issued.device.platform, 'android');
  assert.equal(issued.device.appVersion, '2.0.0');
  assert.equal(issued.device.lastIp, '10.0.0.7');
  assert.equal(core.devicesView().length, 1);
  assert.equal(core.state.devices.length, 1, '一次发放只能写一条设备记录');
  assert.equal(core.authenticateToken(issued.token).id, issued.device.id, '发出去的令牌必须真的能鉴权');

  const raw = readFileSync(stateFile(dataDir), 'utf8');
  assert.equal(raw.includes(issued.token), false, '明文令牌绝不能落盘');
  const saved = savedState(dataDir);
  assert.equal(saved.devices.length, 1);
  assert.equal(saved.devices[0].tokenHash, sha256(issued.token), '落盘必须是 sha256(令牌)');
  assert.equal(saved.devices[0].tokenHash.length, 64);
  assert.equal(saved.devices[0].id, issued.device.id);
});

test('给了有效 token → 原样回显同一 token 与同一设备，不新增设备', () => {
  const { core } = makeCore();
  const first = core.provisionDevice({ name: 'Pixel 9', platform: 'android' });

  const again = core.provisionDevice({
    name: 'Pixel 9', platform: 'android', appVersion: '9.9.9', token: first.token,
  });

  assert.equal(again.token, first.token, '有效令牌必须原样回显，不能换发');
  assert.equal(again.device.id, first.device.id);
  assert.equal(core.devicesView().length, 1, '回显不能再登记一台');
  assert.equal(core.state.devices.length, 1);
  assert.equal(core.authenticateToken(first.token).id, first.device.id);
  // 回显路径不写盘、不改资料：appVersion 保持登记时那份。
  assert.equal(again.device.appVersion, '');
});

test('没给 token 但同名同平台 → 原地轮换：同 id、新令牌、旧令牌立即失效、设备数不变', () => {
  const { core, dataDir } = makeCore();
  const first = core.provisionDevice({ name: 'Pixel 9', platform: 'android', appVersion: '1.0.0' });

  const second = core.provisionDevice({ name: 'Pixel 9', platform: 'android', appVersion: '2.1.0' });

  assert.notEqual(second.token, first.token, '重登必须换一把新令牌');
  assert.match(second.token, TOKEN_RE);
  assert.equal(second.device.id, first.device.id, '同一台手机必须复用同一个 device id');
  assert.equal(second.device.createdAt, first.device.createdAt, '是原地更新，不是新建记录');
  assert.equal(second.device.appVersion, '2.1.0', '重登会顺手更新这台设备的资料');
  assert.equal(core.devicesView().length, 1, '轮换不能让设备数变多');
  assert.equal(core.state.devices.length, 1, '连审计记录都不该多一条');

  assert.equal(core.authenticateToken(first.token), undefined, '旧令牌必须立刻失效');
  assert.equal(core.authenticateToken(second.token).id, first.device.id);

  const saved = savedState(dataDir);
  assert.equal(saved.devices.length, 1);
  assert.equal(saved.devices[0].tokenHash, sha256(second.token), '落盘必须已经是新哈希');
  assert.notEqual(saved.devices[0].tokenHash, sha256(first.token), '旧哈希不能留在盘上');
});

test('「同机」= name 与 platform 同时相同：只差一个就当两台', () => {
  const { core } = makeCore();
  const base = core.provisionDevice({ name: 'Pixel 9', platform: 'android' });
  const otherPlatform = core.provisionDevice({ name: 'Pixel 9', platform: 'ios' });
  const otherName = core.provisionDevice({ name: '另一台手机', platform: 'android' });

  assert.notEqual(otherPlatform.device.id, base.device.id);
  assert.notEqual(otherName.device.id, base.device.id);
  assert.notEqual(otherPlatform.token, base.token);
  assert.equal(core.devicesView().length, 3);
  assert.equal(core.authenticateToken(base.token).id, base.device.id, '新设备不能把旧设备的令牌顶掉');
  assert.equal(core.authenticateToken(otherPlatform.token).id, otherPlatform.device.id);
});

test('设备数量没有上限：连续登记 20 台不同设备全部成功，第 21 台也照样成功', () => {
  const { core, dataDir } = makeCore();

  for (let index = 1; index <= 20; index += 1) {
    const issued = core.provisionDevice({ name: `手机 ${index}`, platform: 'android', ip: 'relay' });
    assert.match(issued.token, TOKEN_RE, `第 ${index} 台必须真的拿到令牌，不能被数量挡掉`);
    assert.equal(issued.device.name, `手机 ${index}`);
  }

  // 三处都必须留下 20 条：内存视图、内存状态、磁盘。
  assert.equal(core.devicesView().length, 20, '20 台不同设备必须全部出现在视图里');
  assert.equal(core.state.devices.length, 20, 'state.devices 不能被裁剪');
  assert.equal(savedState(dataDir).devices.length, 20, '落盘的 devices 也必须是 20 条（重启后不会少）');

  // 第 21 台：上限已经彻底不存在，必须照样成功。
  const extra = core.provisionDevice({ name: '第 21 台', platform: 'ios' });
  assert.match(extra.token, TOKEN_RE);
  assert.equal(core.devicesView().length, 21);
  assert.equal(core.state.devices.length, 21);
  assert.equal(savedState(dataDir).devices.length, 21);
  assert.equal(core.authenticateToken(extra.token).id, extra.device.id, '第 21 台的令牌也必须立刻能用');
});

test('设备表再长也不误伤重登：同名同平台仍然原地轮换', () => {
  const { core } = makeCore();
  for (let index = 1; index <= 12; index += 1) {
    core.provisionDevice({ name: `手机 ${index}`, platform: 'android' });
  }
  const first = core.provisionDevice({ name: 'Pixel 9', platform: 'android' });
  assert.equal(core.devicesView().length, 13, '前置：表里已经有 13 台');

  const second = core.provisionDevice({ name: 'Pixel 9', platform: 'android' });

  assert.equal(second.device.id, first.device.id);
  assert.notEqual(second.token, first.token);
  assert.equal(core.devicesView().length, 13, '重登不该多一台');
  assert.equal(core.state.devices.length, 13);
  assert.equal(core.authenticateToken(first.token), undefined);
  assert.equal(core.authenticateToken(second.token).id, first.device.id);
});

test('传了无效 / 已吊销令牌时 provisionDevice 返回 null，绝不补发一台', () => {
  const { core } = makeCore();
  const first = core.provisionDevice({ name: 'Pixel 9', platform: 'android' });

  // 伪造令牌：认不出来就什么都不发。这条保险必须在 core 层——
  // 否则任何绕过 CloudLink.provisionFor 的新调用点都会悄悄复活吊销语义。
  const forged = `dshb_${'A'.repeat(43)}`;
  assert.equal(
    core.provisionDevice({ name: 'Pixel 9', platform: 'android', token: forged }),
    null,
    '伪造令牌不许顺手补发一台',
  );
  assert.equal(core.devicesView().length, 1, '设备数不能变');
  assert.equal(core.devicesView()[0].id, first.device.id);
  assert.equal(core.authenticateToken(forged), undefined);
  assert.notEqual(core.authenticateToken(first.token), undefined, '原来那台的令牌仍然有效');

  // 吊销之后再拿旧令牌来换：同样 null，且一台都不多出来。
  assert.equal(core.revokeDevice(first.device.id), true);
  assert.equal(core.devicesView().length, 0);
  assert.equal(
    core.provisionDevice({ name: 'Pixel 9', platform: 'android', token: first.token }),
    null,
    '已吊销的令牌不能换一台新的复活',
  );
  assert.equal(core.devicesView().length, 0, '吊销后一台都不该多出来');
  assert.equal(core.state.devices.filter((device) => device.revoked === true).length, 1);

  // 没带令牌的重新登录仍然是「新设备」——那是用户用口令重新授权，属预期行为。
  const fresh = core.provisionDevice({ name: 'Pixel 9', platform: 'android' });
  assert.match(fresh.token, TOKEN_RE);
  assert.equal(core.devicesView().length, 1);
});

test('重启后（新 core 读同一 dataDir）仍认得这个令牌，设备数不变', () => {
  const first = makeCore();
  const issued = first.core.provisionDevice({ name: 'Pixel 9', platform: 'android' });

  // 第二个 core 读同一个 dataDir：等价于进程重启。
  const restarted = new BridgeCore({}, {
    home: first.home, dataDir: first.dataDir, port: 47901,
  }, makeLogger());
  cores.push(restarted);

  assert.equal(restarted.devicesView().length, 1);
  assert.equal(restarted.authenticateToken(issued.token).id, issued.device.id, '只存 sha256 也必须能认回来');
});
