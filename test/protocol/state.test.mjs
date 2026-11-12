/**
 * StateStore（lib/state.mjs）——设备令牌的哈希索引与安装标识的持久化。
 * 这些断言守的是「谁能上这台电脑」：tokenHash 查得到就是登录成功，
 * revoke 之后必须查不到，而磁盘上永远不该出现明文 token。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { StateStore } from '../../lib/state.mjs';
import { randomToken, sha256 } from '../../lib/util.mjs';

/** 每个用例一个一次性目录，跑完删掉（不写进仓库、不碰真实 ~/.dsh）。 */
async function withStore(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-state-'));
  const warnings = [];
  const logger = { info() {}, warn: (...a) => warnings.push(a.join(' ')), error: (...a) => warnings.push(a.join(' ')) };
  try {
    return await run({ dir, logger, warnings });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('配对写入后能用 tokenHash 查到，revokeDevice 之后查不到', () => withStore(async ({ dir, logger }) => {
  const store = new StateStore(dir, logger).load();
  const token = randomToken('dshb_');
  const hash = sha256(token);

  store.addDevice({ id: 'dev_abc', name: '测试手机', platform: 'android', appVersion: '1.0.0', tokenHash: hash, ip: '192.168.1.5' });
  assert.equal(store.findDeviceByTokenHash(hash)?.id, 'dev_abc');
  assert.equal(store.findDeviceByTokenHash(sha256('别的 token')), undefined);

  assert.equal(store.revokeDevice('dev_abc'), true);
  assert.equal(store.findDeviceByTokenHash(hash), undefined, 'revoke 之后必须立刻失效');
  assert.equal(store.revokeDevice('dev_abc'), false, '重复 revoke 返回 false');
  assert.equal(store.revokeDevice('dev_不存在'), false);

  // 审计记录仍在（revoked 标记），只是所有查询都过滤掉它。
  assert.equal(store.devices.length, 1);
  assert.equal(store.devices[0].revoked, true);
  assert.equal(typeof store.devices[0].revokedAt, 'number');
}));

test('磁盘上只有 64 位十六进制哈希，没有明文 token', () => withStore(async ({ dir, logger }) => {
  const store = new StateStore(dir, logger).load();
  const token = randomToken('dshb_');
  store.addDevice({ id: 'dev_disk', name: '手机', tokenHash: sha256(token) });
  store.close();

  const raw = readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.ok(!raw.includes(token), 'state.json 里出现了明文 token');
  assert.ok(!raw.includes(token.slice(4)), 'state.json 里出现了 token 的一部分');
  assert.match(raw, /"tokenHash": "[0-9a-f]{64}"/u);
}));

test('重新 load 后设备记录还在，fingerprint 跨重启稳定', () => withStore(async ({ dir, logger }) => {
  const first = new StateStore(dir, logger).load();
  first.addDevice({ id: 'dev_keep', name: '手机', tokenHash: sha256(randomToken('dshb_')) });
  const fingerprint = first.installFingerprint();
  assert.equal(fingerprint.length, 10);
  first.close();

  const second = new StateStore(dir, logger).load();
  assert.equal(second.devices.length, 1, '设备记录必须跨重启保留');
  assert.equal(second.devices[0].id, 'dev_keep');
  assert.equal(second.devices.length, 1, '重复 load 不能把设备翻倍');
  assert.equal(second.installFingerprint(), fingerprint, 'fingerprint 必须跨重启稳定');
  // 配对码窗口已整条删除：磁盘上哪怕残留这个键，load 也不许把它带回来。
  assert.equal('pairing' in second.data, false, 'load 不许把配对窗口复活');
}));

test('removeDevice 真的删记录；同一 id 重新配对会轮换 token 并清掉 revoked', () => withStore(async ({ dir, logger }) => {
  const store = new StateStore(dir, logger).load();
  const oldToken = randomToken('dshb_');
  store.addDevice({ id: 'dev_rotate', name: '旧手机', tokenHash: sha256(oldToken) });
  store.revokeDevice('dev_rotate');
  assert.equal(store.findDeviceByTokenHash(sha256(oldToken)), undefined);

  const newToken = randomToken('dshb_');
  store.addDevice({ id: 'dev_rotate', name: '新手机', tokenHash: sha256(newToken) });
  assert.equal(store.devices.length, 1, '重新配对复用同一条记录，不该新增');
  assert.equal(store.devices[0].revoked, false);
  assert.equal(store.findDeviceByTokenHash(sha256(oldToken)), undefined, '旧 token 不能复活');
  assert.equal(store.findDeviceByTokenHash(sha256(newToken))?.name, '新手机');

  assert.equal(store.removeDevice('dev_rotate'), true);
  assert.equal(store.devices.length, 0);
  assert.equal(store.removeDevice('dev_rotate'), false);
}));

test('脏 state.json：损坏文件被备份后重来，非法设备记录被丢弃', () => withStore(async ({ dir, logger, warnings }) => {
  const file = path.join(dir, 'state.json');
  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const recovered = new StateStore(dir, logger).load();
  assert.deepEqual(recovered.devices, []);
  assert.ok(readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-')), '损坏文件必须备份一份');
  assert.ok(warnings.some((line) => line.includes('无法解析')));

  // 结构不合法（tokenHash 不是 64 位十六进制）的设备不能被信任。
  writeFileSync(file, JSON.stringify({
    version: 1,
    devices: [
      { id: 'dev_ok', tokenHash: sha256('t') },
      { id: 'dev_bad_hash', tokenHash: 'not-a-hash' },
      { id: '', tokenHash: sha256('t2') },
      { tokenHash: sha256('t3') },
    ],
  }), 'utf8');
  const loaded = new StateStore(dir, logger).load();
  assert.equal(loaded.devices.length, 1, '只有一条记录是合法的');
  assert.equal(loaded.devices[0].id, 'dev_ok');
}));
