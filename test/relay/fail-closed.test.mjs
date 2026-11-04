/**
 * 安全性质 4：无口令时拒绝启动（lib/cloud.mjs 构造函数 + 登录闸门）。
 *
 * 「没有口令的中继 = 拿到链接就有全权」——所以默认必须 fail closed，只有配置里
 * 显式写 allowAnonymous: true 才放行；而一旦配置了口令，allowAnonymous 也不能
 * 绕过它。登录预算与「未授权日志不带令牌」一并钉在这里。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudLink } from '../../lib/cloud.mjs';
import { decodeLast, identityFor, makeLink } from './_support/fixtures.mjs';

function fakeAuth({
  enabled = true,
  user = 'owner',
  check = () => null,
  login = () => ({ ok: false, reason: 'bad_credentials' }),
  logout = () => false,
  info = () => ({ enabled, user, configured: true, required: true }),
} = {}) {
  const calls = { check: [], login: [], logout: [] };
  return {
    calls,
    enabled,
    user,
    check(token) { calls.check.push(token); return check(token); },
    login(input) { calls.login.push(input); return login(input); },
    logout(token) { calls.logout.push(token); return logout(token); },
    info,
  };
}

test('无口令 + allowAnonymous=false → 拒绝启动，并给出可读原因（不碰 MQTT）', () => {
  const { logger } = makeLink();
  // 注意：这里不用 makeLink() 的假 client，要证明 start() 根本没走到 connect()。
  const link = new CloudLink({
    localPort: 47801,
    identity: identityFor(),
    auth: null,
    allowAnonymous: false,
    logger,
  });

  assert.notEqual(link.blocked, null, '无口令时必须进入 blocked');
  assert.equal(link.blocked.code, 'auth-required');
  assert.match(link.blocked.message, /口令/u, '原因必须能被人读懂');
  assert.match(link.blocked.message, /allowAnonymous/u, '要指出显式放行的开关');

  assert.equal(link.start(), false, 'blocked 的链接不许启动');
  assert.equal(link.state, 'blocked');
  assert.equal(link.client, undefined, '被拒启动时绝不能已经连上 broker');
  assert.equal(link.socketSweeper, undefined, '被拒启动时不该留下常驻定时器');
  assert.equal(link.sockets.size, 0);
  // 只落一行可读的错误日志，且不含任何密钥/令牌。
  assert.ok(logger.lines.some((line) => line.startsWith('error') && line.includes('auth-required')));
  for (const line of logger.lines) {
    assert.ok(!line.includes(link.identity.token));
    assert.ok(!line.includes(link.identity.key));
  }

  const status = link.status();
  assert.equal(status.state, 'blocked');
  assert.deepEqual(status.guard.blocked, { code: 'auth-required', message: link.blocked.message });
  assert.equal(status.guard.anonymous, false);
});

test('auth 对象存在但 enabled=false → 同样视为无口令，仍然拒绝启动', () => {
  const auth = fakeAuth({ enabled: false });
  const { link } = makeLink({ auth, allowAnonymous: false });
  assert.equal(link.authEnabled, false);
  assert.equal(link.blocked?.code, 'auth-required');
  assert.equal(link.start(), false);
});

test('allowAnonymous=true → 按配置放行（不再 blocked，匿名帧被接受）', () => {
  const { link } = makeLink({ auth: null, allowAnonymous: true });
  assert.equal(link.blocked, null, '显式匿名模式不该再被拦');
  assert.equal(link.status().guard.anonymous, true);
  assert.equal(link.status().guard.blocked, null);
  assert.equal(link.authorized('req', {}), true, '匿名模式下帧应被接受');
});

test('allowAnonymous 不能绕过已配置的口令：令牌错就是错', () => {
  const auth = fakeAuth({ check: (token) => (token === 'good-token' ? { expiresAt: 1 } : null) });
  const { link } = makeLink({ auth, allowAnonymous: true });
  assert.equal(link.authEnabled, true);
  assert.equal(link.authorized('req', { token: 'bad-token' }), false, '配了口令就必须校验，匿名开关不能豁免');
  assert.equal(link.stats.unauthorized, 1);
  assert.equal(link.authorized('req', { token: 'good-token' }), true);
});

test('未授权日志不泄漏令牌（连长度都不留）', () => {
  const token = 'dshb_SUPER_SECRET_TOKEN_0123456789';
  const auth = fakeAuth({ check: () => null });
  const { link, logger } = makeLink({ auth, allowAnonymous: false });
  link.blocked = null; // 只为走到「有口令但令牌错」的分支
  link.authorized('req', { token });
  assert.equal(link.stats.unauthorized, 1);
  const joined = logger.lines.join('\n');
  assert.ok(joined.includes('拒绝未授权消息'));
  assert.ok(!joined.includes(token), '日志里出现了完整令牌');
  assert.ok(!joined.includes('SUPER_SECRET'));
  assert.ok(!joined.includes(String(token.length)), '连令牌长度都不该落日志');
});

test('登录预算耗尽 → 回 locked，且不调用 scrypt 校验', () => {
  const auth = fakeAuth({ login: () => ({ ok: true, token: 'never', expiresAt: 1 }) });
  const { link, sent } = makeLink({ auth, allowAnonymous: false });
  link.blocked = null; // authEnabled 为 true 时本来就不会 blocked，这里只是显式化
  const now = Date.now();
  link.loginBudget = { windowAt: now, used: 10 };

  link.handleLogin({ user: 'owner', password: 'pw' });
  assert.equal(auth.calls.login.length, 0, '预算耗尽后不能再跑 scrypt');
  const reply = decodeLast(link, sent);
  assert.equal(reply.t, 'login');
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'locked');
  assert.ok(reply.retryAfterSec > 0 && reply.retryAfterSec <= 60);
});

test('登录成功回令牌、失败回原因；令牌与口令都不落日志', () => {
  const token = 'dshb_issued_token_abcdef0123456789';
  const auth = fakeAuth({
    login: ({ password }) => (password === 'correct horse'
      ? { ok: true, token, expiresAt: 123, user: 'owner' }
      : { ok: false, reason: 'bad_credentials', retryAfterSec: 0 }),
  });
  const { link, sent, logger } = makeLink({ auth, allowAnonymous: false });

  link.handleLogin({ user: 'owner', password: 'correct horse', phone: 'Pixel', remember: true });
  assert.deepEqual(auth.calls.login[0], {
    user: 'owner', password: 'correct horse', phone: 'Pixel', remember: true,
  });
  const ok = decodeLast(link, sent);
  assert.equal(ok.ok, true);
  assert.equal(ok.token, token);
  assert.equal(ok.expiresAt, 123);

  link.handleLogin({ user: 'owner', password: 'wrong', phone: 'Pixel' });
  const failed = decodeLast(link, sent);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'bad_credentials');

  const joined = logger.lines.join('\n');
  assert.ok(!joined.includes(token), '登录令牌进了日志');
  assert.ok(!joined.includes('correct horse'), '口令进了日志');
});

test('没有口令时登录接口回 disabled；blocked 的链接连登录都不处理', () => {
  const anonymous = makeLink({ auth: null, allowAnonymous: true });
  anonymous.link.handleLogin({ user: 'u', password: 'p' });
  assert.deepEqual(decodeLast(anonymous.link, anonymous.sent), { t: 'login', ok: false, reason: 'disabled' });

  const blocked = makeLink({ auth: fakeAuth(), allowAnonymous: false });
  blocked.link.blocked = { code: 'auth-required', message: 'x' };
  blocked.link.handleLogin({ user: 'u', password: 'p' });
  assert.deepEqual(decodeLast(blocked.link, blocked.sent), { t: 'login', ok: false, reason: 'disabled' });
  assert.equal(blocked.link.auth.calls.login.length, 0);
});

test('logout 与 auth 检查的响应字段跟着配置走', () => {
  const auth = fakeAuth({
    check: (token) => (token === 'ok' ? { phone: 'Pixel', expiresAt: 999 } : null),
    logout: (token) => token === 'ok',
  });
  const { link, sent } = makeLink({ auth, allowAnonymous: false });

  link.handleLogout({ token: 'ok' });
  assert.deepEqual(decodeLast(link, sent), { t: 'logout', ok: true });
  link.handleLogout({ token: 'nope' });
  assert.deepEqual(decodeLast(link, sent), { t: 'logout', ok: false });

  link.handleAuthCheck({ token: 'ok' });
  const accepted = decodeLast(link, sent);
  assert.equal(accepted.t, 'auth');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.required, true, '配了口令就必须要求登录');
  assert.equal(accepted.phone, 'Pixel');
  assert.equal(accepted.expiresAt, 999);
  assert.equal(accepted.user, 'owner');

  link.handleAuthCheck({ token: 'nope' });
  assert.equal(decodeLast(link, sent).ok, false);

  // 匿名模式：不需要登录，ok 直接为 true、required 为 false。
  const anon = makeLink({ auth: null, allowAnonymous: true });
  anon.link.handleAuthCheck({});
  const publicReply = decodeLast(anon.link, anon.sent);
  assert.equal(publicReply.required, false);
  assert.equal(publicReply.ok, true);
  assert.equal(publicReply.user, null);
});

test('CloudLink 构造必须校验钥匙长度（解不出 32 字节直接抛）', () => {
  for (const key of [
    Buffer.alloc(16, 1).toString('base64url'),
    'not-base64url',
    '',
  ]) {
    assert.throws(
      () => new CloudLink({ localPort: 1, identity: identityFor({ key }), allowAnonymous: true }),
      /key must decode to 32 bytes/u,
      `钥匙 ${JSON.stringify(key)} 不该被接受`,
    );
  }
});
