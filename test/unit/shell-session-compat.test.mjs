/**
 * 会话记录 `scope` 的向后兼容（A4）。
 *
 * 事故形态：1.0.3 给设备会话 / 登录会话加了 `scope` 强校验（房间身份的一部分，
 * 换一台电脑就换一个 scope）。但 **v1.0.2 写下的记录里根本没有这个字段** ——
 * 强校验一上，升级后的每台手机都会把本地那份有效令牌当成"不是这个房间的"丢掉，
 * 于是所有人都被踢回口令登录一次。那不是安全收益，是一次升级事故：
 * 令牌真伪本来就由电脑端校验（用不了的令牌只会得到 401，然后正常重新登录）。
 *
 * 判据在 `web/lib/shell-session.js` 的 `scopeVerdict()`：缺字段 = legacy 接受，
 * 存在但不同 = 仍然拒绝。这里测的是行为（哪些记录被接受、补字段后长什么样）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adoptScope, scopeVerdict, unpairStorageKeys } from '../../web/lib/shell-session.js';

/** v1.0.2 实际写下的形状：没有 scope 字段。 */
const V102_DEVICE_SESSION = {
  token: 'devicetoken0123456789abcdef',
  baseUrl: 'https://dsh-remote.local',
  deviceId: 'dev_102',
  server: { name: 'DSH' },
  remote: { room: 'abc123' },
  at: 1_700_000_000_000,
};

const SCOPE = 'scope-from-room-key';

test('A4：v1.0.2 的记录没有 scope 字段 → 按 legacy 接受（不许把整机用户踢回口令登录）', () => {
  const record = JSON.parse(JSON.stringify(V102_DEVICE_SESSION));
  assert.equal('scope' in record, false, '这份 fixture 必须真的没有 scope 字段');
  assert.equal(scopeVerdict(record.scope, SCOPE), 'legacy');
});

test('A4：legacy 记录在下次写入时补上 scope，令牌 / deviceId 一个字节都不动', () => {
  const adopted = adoptScope(V102_DEVICE_SESSION, SCOPE);
  assert.equal(adopted.scope, SCOPE);
  assert.equal(adopted.token, V102_DEVICE_SESSION.token);
  assert.equal(adopted.deviceId, V102_DEVICE_SESSION.deviceId);
  assert.equal(adopted.at, V102_DEVICE_SESSION.at);
  // 补完之后就是正常记录：再判一次是 ok，而不是永远 legacy
  assert.equal(scopeVerdict(adopted.scope, SCOPE), 'ok');
  // 原对象不被改写（调用方可能还要读旧那份）
  assert.equal('scope' in V102_DEVICE_SESSION, false);
});

test('A4：字段存在但不同 → 仍然拒绝（换了一台电脑，旧令牌不该拿去撞新电脑）', () => {
  assert.equal(scopeVerdict('another-room-scope', SCOPE), 'mismatch');
  assert.equal(scopeVerdict('', SCOPE), 'legacy', '空串等价于"没写过"');
  assert.equal(scopeVerdict(null, SCOPE), 'legacy');
  assert.equal(scopeVerdict(undefined, SCOPE), 'legacy');
});

test('A4：没有当前 scope（局域网直连布局 / 还没算出来）→ 不做校验', () => {
  assert.equal(scopeVerdict(undefined, ''), 'ok');
  assert.equal(scopeVerdict('whatever', undefined), 'ok');
  assert.equal(scopeVerdict('whatever', null), 'ok');
});

test('A4：legacy 放行不影响解除配对清单（两件事互不牵连）', () => {
  // 放行旧记录不等于不清本地凭据：解除配对仍然删这几份键。
  const keys = unpairStorageKeys();
  for (const key of ['pocket.session.v1', 'dsh.pocket.session.v1', 'dsh.pocket.link.v1']) {
    assert.ok(keys.includes(key), `解除配对必须清 ${key}`);
  }
});
