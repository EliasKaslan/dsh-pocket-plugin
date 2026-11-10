/**
 * 状态（lib/state.mjs）——设备令牌哈希索引、安装标识、去抖落盘。
 *
 * test/protocol/state.test.mjs 已经覆盖了「配对/吊销/损坏文件」的主干，这里补的是
 * 那条文件里没走到的分支：fingerprint 修复、settings 视图、按 installId 反查、touchDevice
 * 的 5 分钟节流、save/flush/close 的定时器语义，以及**写盘失败**这条错误路径。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { StateStore } from '../../lib/state.mjs';
import { randomHex, sha256 } from '../../lib/util.mjs';

let root;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-domain-state-'));
});

after(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function scratch() {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStore(dir) {
  const logs = [];
  const push = (level) => (...args) => logs.push(`${level} ${args.map(String).join(' ')}`);
  const logger = { info: push('info'), warn: push('warn'), error: push('error') };
  const store = new StateStore(dir, logger).load();
  return { store, logs, file: path.join(dir, 'state.json') };
}

const readState = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ 视图 ---- */

test('settings 是活视图：改它并 flush 之后就落盘', () => {
  const dir = scratch();
  const { store, file } = makeStore(dir);
  assert.equal(store.settings, store.data.settings, 'getter 必须返回同一个对象，不能是拷贝');
  store.flush(); // 先建出基线文件
  store.settings.theme = 'dark';
  assert.equal(readState(file).settings.theme, undefined, '没 flush 之前不该在盘上');
  store.flush();
  assert.equal(readState(file).settings.theme, 'dark');
});

test('installFingerprint：已有 10 位就复用，长度不对就重算并落盘', () => {
  const dir = scratch();
  const { store, file } = makeStore(dir);
  const first = store.installFingerprint();
  assert.equal(first.length, 10);
  assert.match(first, /^[0-9a-f]{10}$/u);
  assert.equal(store.installFingerprint(), first, '同一个进程内稳定');
  assert.equal(readState(file).settings.installFingerprint, first, '必须落盘');

  // 脏值（长度不对/不是字符串）要能自愈，否则指纹会一直不可用。
  for (const bad of ['abc', '', 42, null, `${'a'.repeat(10)}x`]) {
    store.data.settings.installFingerprint = bad;
    const repaired = store.installFingerprint();
    assert.equal(repaired.length, 10);
    assert.notEqual(repaired, bad);
  }

  // 跨实例（重启）保持稳定。
  const second = new StateStore(dir).load();
  assert.equal(second.installFingerprint(), store.installFingerprint());
});

test('findDeviceByInstallId：只认手机自报的安装标识，空值与未知值一律查不到', () => {
  const dir = scratch();
  const { store } = makeStore(dir);
  store.addDevice({ id: 'dev_a', name: '手机', tokenHash: sha256('a'), installId: 'install-a' });
  store.addDevice({ id: 'dev_b', name: '手机', tokenHash: sha256('b'), installId: 'install-b' });
  // 没自报标识的设备不能被 installId 查到（否则第二台手机一登录就把第一台顶掉）。
  store.addDevice({ id: 'dev_c', name: '手机', tokenHash: sha256('c') });

  assert.equal(store.findDeviceByInstallId('install-a')?.id, 'dev_a');
  assert.equal(store.findDeviceByInstallId('install-b')?.id, 'dev_b');
  assert.equal(store.findDeviceByInstallId('install-missing'), undefined);
  for (const bad of ['', undefined, null, 42]) {
    assert.equal(store.findDeviceByInstallId(bad), undefined, `installId=${JSON.stringify(bad)} 不该命中任何设备`);
  }
  // 同一个 id 重新登记时标识跟着更新，旧标识不再命中。
  store.addDevice({ id: 'dev_a', name: '手机', tokenHash: sha256('a2'), installId: 'install-a2' });
  assert.equal(store.findDeviceByInstallId('install-a'), undefined);
  assert.equal(store.findDeviceByInstallId('install-a2')?.id, 'dev_a');
});

/* ------------------------------------------------------------- touchDevice ---- */

test('touchDevice：不认识的 id 与已吊销的设备都不更新', () => {
  const dir = scratch();
  const { store } = makeStore(dir);
  assert.equal(store.touchDevice('dev_不存在', '1.2.3.4'), undefined);

  store.addDevice({ id: 'dev_r', name: '旧手机', tokenHash: sha256('t') });
  store.revokeDevice('dev_r');
  const before = { ...store.devices[0] };
  store.touchDevice('dev_r', '9.9.9.9');
  assert.equal(store.devices[0].lastSeenAt, before.lastSeenAt);
  assert.equal(store.devices[0].lastIp, before.lastIp, '吊销设备的 IP 不该再被记录（隐私）');
});

test('touchDevice：5 分钟内不重复写盘，超过才更新 lastSeenAt/lastIp', async () => {
  const dir = scratch();
  const { store, file } = makeStore(dir);
  const device = store.addDevice({ id: 'dev_t', name: '手机', tokenHash: sha256('t'), ip: '1.1.1.1' });
  const written = readState(file);
  const seenAt = device.lastSeenAt;

  store.touchDevice('dev_t', '2.2.2.2');
  assert.equal(store.devices[0].lastSeenAt, seenAt, '刚配对完不该再写一次');
  assert.equal(store.devices[0].lastIp, '1.1.1.1', '节流期内连 IP 都不更新');
  assert.equal(store.dirty, false, '没有触发 save()');

  store.devices[0].lastSeenAt = Date.now() - 6 * 60_000;
  store.touchDevice('dev_t', '2.2.2.2');
  assert.ok(store.devices[0].lastSeenAt > Date.now() - 1000, '过窗后刷新 lastSeenAt');
  assert.equal(store.devices[0].lastIp, '2.2.2.2');
  assert.equal(store.dirty, true, '走的是去抖 save()');
  await sleep(260);
  assert.equal(readState(file).devices[0].lastIp, '2.2.2.2', '去抖结束后必须落盘');
  assert.equal(written.devices[0].lastIp, '1.1.1.1');

  // 不给 ip 时保留旧值。
  store.devices[0].lastSeenAt = Date.now() - 6 * 60_000;
  store.touchDevice('dev_t');
  assert.equal(store.devices[0].lastIp, '2.2.2.2', 'ip 为空不能把已记录的 IP 抹掉');
  store.close();
});

/* ------------------------------------------------------- save / flush / close ---- */

test('save 去抖：150ms 内只写一次，flush 会取消挂起的定时器', async () => {
  const dir = scratch();
  const { store } = makeStore(dir);
  store.addDevice({ id: 'dev_a', name: '手机', tokenHash: sha256('a') });

  store.data.settings.k1 = 1;
  store.save();
  const timer = store.timer;
  assert.notEqual(timer, undefined, '第一次 save 必须挂定时器');
  store.data.settings.k2 = 2;
  store.save();
  assert.equal(store.timer, timer, '第二次 save 不该再挂一个定时器');
  assert.equal(store.dirty, true);

  store.flush();
  assert.equal(store.dirty, false);
  assert.equal(store.timer, undefined, 'flush 必须清掉挂起的定时器');
  await sleep(220);
  assert.equal(store.dirty, false, '定时器已被取消，不该再回来写一次');
});

test('save 到点自动落盘（不调 flush 也行）', async () => {
  const dir = scratch();
  const { store, file } = makeStore(dir);
  store.flush(); // 建出 state.json 基线
  store.data.settings.auto = 'yes';
  store.save();
  assert.equal(readState(file).settings.auto, undefined);
  await sleep(260);
  assert.equal(readState(file).settings.auto, 'yes');
  assert.equal(store.dirty, false);
});

test('close：取消挂起的定时器并立即落盘', () => {
  const dir = scratch();
  const { store, file } = makeStore(dir);
  store.data.settings.last = 'before-close';
  store.save();
  store.close();
  assert.equal(store.timer, undefined);
  assert.equal(store.dirty, false);
  assert.equal(readState(file).settings.last, 'before-close');
});

test('写盘失败：flush 不抛异常，标记 dirty 并让 logger.error 收到一条', () => {
  const dir = scratch();
  // 把 store 的目录占成一个普通文件：atomicWriteJson 的 openSync 必然失败。
  const blocker = path.join(dir, 'blocked');
  writeFileSync(blocker, 'x', 'utf8');
  const logs = [];
  const logger = { info: () => {}, warn: (...a) => logs.push(['warn', a]), error: (...a) => logs.push(['error', a]) };
  const store = new StateStore(blocker, logger).load();

  store.data.settings.unsaved = true;
  assert.doesNotThrow(() => store.flush());
  assert.equal(store.dirty, true, '写失败后必须保持 dirty，等下一次重试');
  assert.equal(logs.filter(([level]) => level === 'error').length, 1);
  assert.match(String(logs[0][1][0]), /state write failed/u);

  // addDevice 这类“用户会注意到丢数据”的操作也走 flush，同样不能抛。
  assert.doesNotThrow(() => store.addDevice({ id: 'dev_x', name: '手机', tokenHash: sha256('x') }));
  assert.equal(store.devices.length, 1, '内存里仍然记下了设备');
  assert.equal(store.dirty, true);
});

test('损坏的 state.json 备份失败时，降级为“重来”而不是抛异常', () => {
  const dir = scratch();
  const file = path.join(dir, 'state.json');
  writeFileSync(file, '{ 这不是 JSON，但字节数大于 2', 'utf8');

  // 钉住 Date.now，好让备份目标路径可预测，并提前占成一个**目录**，
  // 于是 renameSync 在 Windows 上返回 EPERM（已实测），走 auth 之外的 catch 分支。
  const fixed = Date.now();
  const target = `${file}.corrupt-${fixed}`;
  mkdirSync(target);
  const realNow = Date.now;
  Date.now = () => fixed;
  try {
    const logs = [];
    const logger = { info() {}, warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
    const store = new StateStore(dir, logger).load();
    assert.deepEqual(store.devices, [], '解析失败 → 空设备表');
    assert.ok(logs.some((line) => line.includes('备份失败')), `必须留下告警，实际日志：${logs.join(' | ')}`);
    assert.equal(statSync(file).size > 0, true, '原损坏文件仍在（没被删掉）');
  } finally {
    Date.now = realNow;
  }
});

/* ------------------------------------------------------------ load 的兜底 ---- */

test('load：顶层不是对象（数字/数组/字符串/null）时保持默认值', () => {
  const dir = scratch();
  const file = path.join(dir, 'state.json');
  for (const body of ['123', '[]', '"字符串"', 'null', 'true']) {
    writeFileSync(file, body, 'utf8');
    const store = new StateStore(dir).load();
    assert.equal(store.devices.length, 0, `${body} 不该被当成状态对象`);
    // 配对码窗口已删除：任何输入都不该让这个键重新出现。
    assert.equal('pairing' in store.data, false, `${body} 让已删除的配对窗口复活了`);
    assert.deepEqual(store.settings, {});
    assert.equal(store.data.version, 1);
  }
});

test('load：devices 不是数组、settings 不是对象时各自兜底', () => {
  const dir = scratch();
  const file = path.join(dir, 'state.json');
  // 旧版本写下的 state.json 里可能还留着 pairing：必须被丢掉，不许跟着透传。
  writeFileSync(file, JSON.stringify({
    version: 99, createdAt: 'yesterday', settings: [], pairing: 'soon', devices: { 0: {} },
  }), 'utf8');
  const store = new StateStore(dir).load();
  assert.deepEqual(store.devices, []);
  assert.equal('pairing' in store.data, false, '已删除的配对窗口被 load 带回来了');
  assert.deepEqual(store.settings, {}, '非对象的 settings 被丢掉');
  assert.equal(store.data.version, 1, '版本号被强制回当前版本');
  assert.equal(typeof store.data.createdAt, 'number', '非法 createdAt 用当前时间兜底');
});

test('validDevice：tokenHash 大小写不敏感，但必须是 64 位十六进制', () => {
  const dir = scratch();
  const file = path.join(dir, 'state.json');
  const good = randomHex(32);
  writeFileSync(file, JSON.stringify({
    devices: [
      { id: 'upper', tokenHash: good.toUpperCase() },
      { id: 'lower', tokenHash: good },
      { id: 'short', tokenHash: good.slice(0, 63) },
      { id: 'nonhex', tokenHash: good.slice(0, 63) + 'z' },
      { id: 'nullhash', tokenHash: null },
      { id: '', tokenHash: good },
      { id: 'ok-no-name', tokenHash: good },
    ],
  }), 'utf8');
  const store = new StateStore(dir).load();
  assert.deepEqual(store.devices.map((device) => device.id), ['upper', 'lower', 'ok-no-name']);
  // 大写哈希被接受，但查找是逐字节比较，所以只有小写那份能被命中；
  // 且循环不 break（常量时间语义），同哈希多条时返回最后一条。
  assert.equal(store.findDeviceByTokenHash(good)?.id, 'ok-no-name');
});

/* ---------------------------------------------------------------- addDevice ---- */

test('addDevice：缺省字段都有兜底，缺 id 时自动生成', () => {
  const dir = scratch();
  const { store } = makeStore(dir);
  const device = store.addDevice({ tokenHash: sha256('t') });
  assert.match(device.id, /^dev_/u);
  assert.equal(device.name, '未命名设备');
  assert.equal(device.platform, 'unknown');
  assert.equal(device.appVersion, '');
  assert.equal(device.lastIp, '');
  assert.equal(device.revoked, false);
  assert.equal(typeof device.createdAt, 'number');
  assert.equal(device.createdAt, device.lastSeenAt);
  assert.match(device.tokenHash, /^[0-9a-f]{64}$/u);

  // id 是空串也当没有 id 处理。
  assert.match(store.addDevice({ id: '', tokenHash: sha256('t2') }).id, /^dev_/u);
});

test('addDevice：同一 id 重配对时，缺省的 name 会把已存的设备名抹掉（现状记录）', () => {
  const dir = scratch();
  const { store, file } = makeStore(dir);
  const tokenHash = sha256('t');
  store.addDevice({ id: 'dev_keep', name: '我的手机', platform: 'android', tokenHash });
  assert.equal(store.devices[0].name, '我的手机');

  // 新增分支有 `name || '未命名设备'` 兜底，重建分支（state.mjs:112-119）没有：
  // 重配对时如果客户端没带 name，磁盘上的名字就变成 undefined。
  store.addDevice({ id: 'dev_keep', tokenHash: sha256('t2') });
  assert.equal(store.devices[0].name, undefined, '重配对把设备名冲掉了（现状）');
  assert.equal(store.devices[0].platform, undefined);
  assert.equal(store.devices[0].tokenHash, sha256('t2'), '令牌哈希仍然要换新');
  assert.equal('name' in readState(file).devices[0], false, 'undefined 被 JSON 序列化丢键');
});

test('findDeviceByTokenHash：空/非字符串一律查不到，非法记录被跳过', () => {
  const dir = scratch();
  const { store } = makeStore(dir);
  const hash = sha256('t');
  store.addDevice({ id: 'dev_1', tokenHash: hash });
  assert.equal(store.findDeviceByTokenHash(''), undefined);
  assert.equal(store.findDeviceByTokenHash(undefined), undefined);
  assert.equal(store.findDeviceByTokenHash(42), undefined);
  assert.equal(store.findDeviceByTokenHash(hash)?.id, 'dev_1');

  // 手工放进来的脏记录（tokenHash 不是字符串）不能让查找抛异常。
  store.data.devices.push({ id: 'broken', tokenHash: 42, revoked: false });
  store.data.devices.push({ id: 'broken2', tokenHash: null, revoked: false });
  assert.equal(store.findDeviceByTokenHash(hash)?.id, 'dev_1');
  assert.equal(store.findDeviceByTokenHash('null'), undefined);

  // 同名同哈希两条时，返回**最后**一条（循环不 break，常量时间语义）。
  store.data.devices.push({ id: 'dev_dup', tokenHash: hash, revoked: false });
  assert.equal(store.findDeviceByTokenHash(hash)?.id, 'dev_dup');
});

test('removeDevice / revokeDevice 对不存在的 id 都只返回 false', () => {
  const dir = scratch();
  const { store } = makeStore(dir);
  assert.equal(store.removeDevice('nope'), false);
  assert.equal(store.revokeDevice('nope'), false);
  assert.equal(store.devices.length, 0);
});
