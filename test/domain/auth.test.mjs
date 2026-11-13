/**
 * 口令与令牌（lib/auth.mjs）——第二道闸：口令 scrypt、会话令牌只存摘要、
 * 失败按 ip+deviceId 分桶锁定。
 *
 * 这里的断言守的是「谁能进门」和「猜错能不能把主人锁在外面」。口令哈希用
 * 真实 scryptSync，不 mock；为了让 40 多次登录不拖慢 CI，凭据记录里显式写
 * N=1024（verifyPassword 会按记录里的参数算，见 auth.mjs:60-64）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  Auth, hashPassword, SESSION_TTL_MS, verifyPassword,
} from '../../lib/auth.mjs';

const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };
const PASSWORD = '正确口令 Passw0rd!';
const DAY = 24 * 60 * 60 * 1000;

let root;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-auth-'));
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

function credentialsFile(dir, { user = 'alice', password = PASSWORD } = {}) {
  const file = path.join(dir, 'auth.json');
  writeFileSync(file, JSON.stringify({ user, password: hashPassword(password, 'f'.repeat(32), FAST) }), 'utf8');
  return file;
}

function makeAuth(dir, { required = true, user = 'alice', password = PASSWORD, withCredentials = true } = {}) {
  const credentials = withCredentials ? credentialsFile(dir, { user, password }) : path.join(dir, 'missing-auth.json');
  const sessions = path.join(dir, 'sessions.json');
  const logs = [];
  const logger = {
    info: (...args) => logs.push(['info', args.join(' ')]),
    warn: (...args) => logs.push(['warn', args.join(' ')]),
    error: (...args) => logs.push(['error', args.join(' ')]),
  };
  const auth = new Auth({ credentialsFile: credentials, sessionsFile: sessions, logger, required });
  return { auth, credentials, sessions, logs };
}

const digest = (token) => createHash('sha256').update(String(token)).digest('base64url');

function bump(file, secondsAhead = 5) {
  const when = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(file, when, when);
}

/* ---------------------------------------------------------- hashPassword ---- */

test('hashPassword：结构、确定性、随机 salt 与 NFKC 归一', () => {
  const record = hashPassword('口令');
  assert.equal(record.algo, 'scrypt');
  assert.equal(typeof record.salt, 'string');
  assert.equal(record.salt.length, 32, '默认 16 字节 salt → 32 位十六进制');
  assert.equal(record.N, 16_384);
  assert.equal(record.r, 8);
  assert.equal(record.p, 1);
  const digestBytes = Buffer.from(record.hash, 'base64');
  assert.equal(digestBytes.length, 32, 'keylen 默认 32 字节');

  const salt = 'a'.repeat(32);
  assert.equal(hashPassword('同一个口令', salt).hash, hashPassword('同一个口令', salt).hash, '同 salt 必须确定');
  assert.notEqual(hashPassword('同一个口令', salt).hash, hashPassword('同一个口令', 'b'.repeat(32)).hash);
  assert.notEqual(hashPassword('口令一', salt).hash, hashPassword('口令二', salt).hash);
  assert.equal(hashPassword('口令', salt).salt, salt, '传了 salt 就用传入的');
  assert.notEqual(hashPassword('口令').salt, hashPassword('口令').salt, '不传 salt 时每次随机');

  // NFKC：全角字母与半角字母是同一个口令（用户切换输入法不该登录失败）。
  assert.equal(hashPassword('ＡＢＣ１２３', salt).hash, hashPassword('ABC123', salt).hash);
  // 非字符串口令按 String() 处理。
  assert.equal(hashPassword(12345, salt).hash, hashPassword('12345', salt).hash);
  assert.equal(hashPassword(undefined, salt).hash, hashPassword('undefined', salt).hash);
});

/* -------------------------------------------------------- verifyPassword ---- */

test('verifyPassword：正确/错误/畸形记录都只返回布尔，不抛', () => {
  const salt = 'c'.repeat(32);
  const record = hashPassword('正确口令', salt, FAST);
  assert.equal(verifyPassword('正确口令', record), true);
  assert.equal(verifyPassword('错误口令', record), false);
  assert.equal(verifyPassword('', record), false);
  assert.equal(verifyPassword(undefined, record), false);

  for (const bad of [null, undefined, 'string', 42, {}, { hash: 'x' }, { salt: 'x' }, { hash: 1, salt: 2 }]) {
    assert.equal(verifyPassword('正确口令', bad), false, `非法记录必须 false：${JSON.stringify(bad)}`);
  }
  assert.equal(verifyPassword('正确口令', { ...record, hash: '' }), false, '空 hash → false');
  assert.equal(verifyPassword('正确口令', { ...record, hash: '!!!!!!!' }), false, '无效 base64 解出空 buffer → false');
  assert.equal(verifyPassword('正确口令', { ...record, hash: `${record.hash.slice(0, -2)}AA` }), false, '被改过的 hash 必拒');
  // 记录里的 N 决定派生参数：把它改成垃圾会回退到默认 16384，于是原来按 1024 算的 hash 对不上。
  assert.equal(verifyPassword('正确口令', { ...record, N: 'not-a-number', r: 0, p: null }), false,
    '参数被篡改 → 派生结果变 → false（而不是抛异常）');
  // Unicode 口令往返。
  const unicode = hashPassword('口令🚀e\u0301', salt, FAST);
  assert.equal(verifyPassword('口令🚀e\u0301', unicode), true);
  assert.equal(verifyPassword('口令🚀e', unicode), false);
});

/* ------------------------------------------------------------ 未配置 / 闸门 ---- */

test('未配置且未要求：闸门关闭，authorize 直接放行', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir, { required: false, withCredentials: false });
  assert.equal(auth.configured, false);
  assert.equal(auth.enabled, false);
  assert.equal(auth.loadError, undefined);
  assert.equal(auth.assertUsable(), true, '不要求口令时缺凭据不算错');
  assert.deepEqual(auth.authorize('任意令牌'), { required: false, ok: true, session: null });
  assert.equal(auth.check('任意令牌'), null);
  assert.deepEqual(auth.login({ user: 'alice', password: PASSWORD }), { ok: false, reason: 'disabled', retryAfterSec: 0 });
});

test('要求口令却没有凭据：fail-closed，assertUsable 抛 auth_missing_credentials', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir, { required: true, withCredentials: false });
  assert.equal(auth.configured, false);
  assert.equal(auth.enabled, false, '没有凭据就不算启用，但绝不能放行');
  assert.equal(auth.loadError, 'missing_credentials');
  assert.throws(() => auth.assertUsable(), (error) => {
    assert.equal(error.code, 'auth_missing_credentials');
    assert.match(error.message, /auth\.json/u);
    return true;
  });
  assert.equal(auth.login({ user: 'alice', password: PASSWORD }).reason, 'misconfigured');
  assert.equal(auth.info().error, 'missing_credentials');
});

test('凭据文件结构不对（user 为空 / password 缺失）等同于未配置', () => {
  const dir = scratch();
  const sessions = path.join(dir, 'sessions.json');
  const file = path.join(dir, 'auth.json');
  writeFileSync(file, JSON.stringify({ user: '   ', password: hashPassword('x', 'f'.repeat(32), FAST) }), 'utf8');
  const blank = new Auth({ credentialsFile: file, sessionsFile: sessions, required: true, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(blank.configured, false, '空白 user 不算配置好');
  assert.equal(blank.loadError, 'missing_credentials');

  writeFileSync(file, JSON.stringify({ user: 'alice' }), 'utf8');
  const noPassword = new Auth({ credentialsFile: file, sessionsFile: sessions, required: true, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(noPassword.configured, false, '缺 password 记录不算配置好');

  writeFileSync(file, '这不是 JSON', 'utf8');
  const corrupt = new Auth({ credentialsFile: file, sessionsFile: sessions, required: true, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(corrupt.configured, false, '损坏的凭据文件绝不能被当成“放行”');
});

/* --------------------------------------------------------------- 登录成功 ---- */

test('登录成功：发令牌、只落盘摘要、有效期 15 天', () => {
  const dir = scratch();
  const { auth, sessions } = makeAuth(dir);
  assert.equal(auth.configured, true);
  assert.equal(auth.enabled, true);
  assert.equal(auth.user, 'alice');

  const before = Date.now();
  const result = auth.login({ user: 'alice', password: PASSWORD, phone: '小明的手机' });
  assert.equal(result.ok, true);
  assert.equal(typeof result.token, 'string');
  assert.ok(result.token.length >= 40, '令牌必须足够长');
  assert.ok(result.expiresAt >= before + SESSION_TTL_MS - 2000);
  assert.ok(result.expiresAt <= Date.now() + SESSION_TTL_MS + 2000);

  // 内存里按 sha256(token) 存，明文 token 不进 map 的键。
  assert.equal(auth.sessions.has(digest(result.token)), true);
  assert.equal(auth.sessions.has(result.token), false);

  // 磁盘上只有摘要，没有明文。
  const raw = readFileSync(sessions, 'utf8');
  assert.ok(!raw.includes(result.token), 'sessions.json 里出现明文令牌');
  const stored = JSON.parse(raw);
  assert.equal(stored.sessions.length, 1);
  assert.equal(stored.sessions[0].id, digest(result.token));
  assert.equal(stored.sessions[0].phone, '小明的手机');
  assert.ok(stored.sessions[0].at >= before, 'at 是创建时间');

  // 校验与授权。
  assert.equal(auth.check(result.token)?.phone, '小明的手机');
  assert.equal(auth.check(result.token.toUpperCase() + 'x'), null);
  const live = auth.check(result.token);
  assert.deepEqual(auth.authorize(result.token), {
    required: true,
    ok: true,
    session: {
      expiresAt: live.expiresAt,
      phone: '小明的手机',
      at: live.at,
      // 刚创建时的 renewedAt 就是创建时间：还没发生过滑动续期。
      renewedAt: live.at,
      short: false,
    },
  });
  assert.deepEqual(auth.authorize('瞎编的'), { required: true, ok: false, session: null });
  assert.deepEqual(auth.authorize(undefined), { required: true, ok: false, session: null });
  assert.deepEqual(auth.authorize(42), { required: true, ok: false, session: null });
});

test('remember=false 走 12 小时短会话', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  const before = Date.now();
  const result = auth.login({ user: 'alice', password: PASSWORD, remember: false });
  assert.equal(result.ok, true);
  assert.ok(result.expiresAt - before <= 12 * 60 * 60 * 1000 + 2000);
  assert.ok(result.expiresAt - before > 11 * 60 * 60 * 1000);
});

test('用户名比对忽略大小写与空白，口令仍然逐字符严格', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  assert.equal(auth.login({ user: '  ALICE  ', password: PASSWORD }).ok, true, '用户名 trim + 小写比较');
  const wrongCase = auth.login({ user: 'alice', password: PASSWORD.toUpperCase() });
  assert.equal(wrongCase.ok, false);
  assert.equal(wrongCase.reason, 'bad-credentials');
});

test('phone 截断到 40 字符，Unicode 不抛异常', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  const longPhone = `📱${'很长的设备名'.repeat(20)}`;
  const result = auth.login({ user: 'alice', password: PASSWORD, phone: longPhone });
  assert.equal(result.ok, true);
  assert.equal(auth.check(result.token).phone.length, 40);
  assert.ok(longPhone.startsWith(auth.check(result.token).phone));

  const noPhone = auth.login({ user: 'alice', password: PASSWORD });
  assert.equal(auth.check(noPhone.token).phone, '手机', '缺省设备名');
});

/* ------------------------------------------------------------ 过期与清理 ---- */

test('check：令牌过期即失效，并从内存与磁盘同时删除', () => {
  const dir = scratch();
  const { auth, sessions } = makeAuth(dir);
  const { token } = auth.login({ user: 'alice', password: PASSWORD });
  const key = digest(token);
  // check() 内部会先 maybeReload()（auth.mjs:169）；login 的 saveSessions 没同步
  // sessionsMtime，所以第一次 check 会把文件整份读回来、覆盖内存改动。
  auth.maybeReload();
  auth.sessions.get(key).expiresAt = Date.now() - 1;

  assert.equal(auth.check(token), null);
  assert.equal(auth.sessions.has(key), false, '过期令牌必须从内存删除');
  assert.deepEqual(JSON.parse(readFileSync(sessions, 'utf8')).sessions, [], '过期令牌必须从磁盘删除');
});

test('写盘后 sessionsSignature 不同步：下一次 check 会整份重载，内存改动被覆盖（现状记录）', () => {
  const dir = scratch();
  const { auth, sessions } = makeAuth(dir);
  const { token } = auth.login({ user: 'alice', password: PASSWORD });
  const key = digest(token);

  // saveSessions() 只写文件、不回写 sessionsSignature，
  // 于是 save 之后的第一次 maybeReload 一定认为“文件被外部改过”。
  // 签名是「mtime:size」，必须两个都比 —— 只比 mtime 的话，同一毫秒内的
  // 连续两次写会被漏掉（那是另一个真 bug，见 lib/auth.mjs 的 fileSignature）。
  const onDisk = statSync(sessions);
  assert.equal(typeof auth.sessionsSignature, 'string', 'sessionsSignature 必须存在，否则这条断言是空转');
  assert.notEqual(auth.sessionsSignature, `${onDisk.mtimeMs}:${onDisk.size}`,
    'login 写盘后 sessionsSignature 还停在写之前');

  auth.sessions.get(key).expiresAt = Date.now() - 1;
  assert.equal(auth.check(token) !== null, true,
    'check 先 reload，内存里刚被改成“已过期”的会话会被磁盘内容复活');
  assert.equal(auth.maybeReload(), false, '这次 check 顺带把 sessionsSignature 同步了');
});

test('prune：只清过期会话，返回清除条数；没有过期时不写盘', () => {
  const dir = scratch();
  const { auth, sessions } = makeAuth(dir);
  const a = auth.login({ user: 'alice', password: PASSWORD });
  const b = auth.login({ user: 'alice', password: PASSWORD });
  assert.equal(auth.prune(), 0, '都没过期 → 0');
  const mtime = statSync(sessions).mtimeMs;

  auth.sessions.get(digest(a.token)).expiresAt = Date.now() - 5000;
  assert.equal(auth.prune(), 1);
  assert.equal(auth.sessions.has(digest(a.token)), false);
  assert.equal(auth.sessions.has(digest(b.token)), true);
  assert.ok(statSync(sessions).mtimeMs >= mtime, '有删除时必须重写文件');
  assert.equal(JSON.parse(readFileSync(sessions, 'utf8')).sessions.length, 1);

  auth.sessions.get(digest(b.token)).expiresAt = Date.now() - 5000;
  assert.equal(auth.prune(Date.now() + 10_000), 1, '可以按指定的“现在”判断');
});

test('加载 sessions.json：过期、结构非法的条目被丢弃，缺省字段被补齐', () => {
  const dir = scratch();
  const credentials = credentialsFile(dir);
  const sessions = path.join(dir, 'sessions.json');
  writeFileSync(sessions, JSON.stringify({
    sessions: [
      { id: 'good', expiresAt: Date.now() + 60_000 },
      { id: 'expired', expiresAt: Date.now() - 60_000 },
      { id: 42, expiresAt: Date.now() + 60_000 },
      { id: 'no-expiry' },
      { id: 'string-expiry', expiresAt: 'soon' },
      null,
      'nope',
      { id: 'full', expiresAt: Date.now() + 70_000, phone: '平板', at: 123 },
      { id: 'bad-at', expiresAt: Date.now() + 80_000, at: '不算数字' },
    ],
  }), 'utf8');
  const auth = new Auth({ credentialsFile: credentials, sessionsFile: sessions, required: true, logger: { info() {}, warn() {}, error() {} } });
  assert.deepEqual([...auth.sessions.keys()].sort(), ['bad-at', 'full', 'good']);
  assert.equal(auth.sessions.get('good').phone, '手机', '缺省设备名');
  assert.equal(auth.sessions.get('good').at, 0);
  assert.equal(auth.sessions.get('full').phone, '平板');
  assert.equal(auth.sessions.get('full').at, 123);
  assert.equal(auth.sessions.get('bad-at').at, 0, '非数字 at 归零');
});

test('maybeReload：凭据或会话文件被外部改写时热加载', () => {
  const dir = scratch();
  const { auth, credentials, sessions } = makeAuth(dir);
  assert.equal(auth.maybeReload(), false, '没变就不重载');

  writeFileSync(credentials, JSON.stringify({
    user: 'bob', password: hashPassword('新口令', 'e'.repeat(32), FAST),
  }), 'utf8');
  bump(credentials);
  assert.equal(auth.maybeReload(), true);
  assert.equal(auth.user, 'bob');
  assert.equal(auth.login({ user: 'bob', password: '新口令' }).ok, true);
  assert.equal(auth.login({ user: 'alice', password: PASSWORD }).ok, false, '旧用户名不能再用');

  // 凭据被删掉 → 立刻回到 fail-closed（不能继续沿用内存里的旧记录）。
  rmSync(credentials);
  assert.equal(auth.maybeReload(), true);
  assert.equal(auth.configured, false);
  assert.throws(() => auth.assertUsable(), /已要求口令登录/u);

  writeFileSync(sessions, JSON.stringify({ sessions: [] }), 'utf8');
  bump(sessions);
  assert.equal(auth.maybeReload(), true);
});

/* ---------------------------------------------------------------- 分桶锁定 ---- */

test('bucketKey：ip 与 deviceId 的组合键，deviceId 截断到 32', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir, { required: false, withCredentials: false });
  assert.equal(auth.bucketKey({ ip: '1.2.3.4', deviceId: 'dev-1' }), '1.2.3.4|dev-1');
  assert.equal(auth.bucketKey({ ip: '1.2.3.4' }), '1.2.3.4|');
  assert.equal(auth.bucketKey({ deviceId: 'dev-1' }), 'unknown|dev-1');
  assert.equal(auth.bucketKey({}), 'unknown|');
  assert.equal(auth.bucketKey(), 'unknown|');
  assert.equal(auth.bucketKey({ ip: '', deviceId: '' }), 'unknown|');
  assert.equal(auth.bucketKey({ ip: 42, deviceId: 7 }), 'unknown|');
  assert.equal(auth.bucketKey({ deviceId: 'd'.repeat(40) }), `unknown|${'d'.repeat(32)}`);
});

test('bucket：同一个键复用同一个桶', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir, { required: false, withCredentials: false });
  const first = auth.bucket('k');
  assert.deepEqual(first, { failures: [], lockedUntil: 0, lockCount: 0 });
  first.lockCount = 3;
  assert.equal(auth.bucket('k'), first);
  assert.notEqual(auth.bucket('k2'), first);
});

test('sweepBuckets：只清“没锁且失败全在窗口外”的桶', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir, { required: false, withCredentials: false });
  const now = Date.now();
  auth.buckets.set('empty', { failures: [], lockedUntil: 0, lockCount: 0 });
  auth.buckets.set('recent-failure', { failures: [now - 1000], lockedUntil: 0, lockCount: 0 });
  auth.buckets.set('old-failure', { failures: [now - 11 * 60_000], lockedUntil: 0, lockCount: 0 });
  auth.buckets.set('locked', { failures: [], lockedUntil: now + 60_000, lockCount: 1 });
  auth.buckets.set('expired-lock-old-failures', { failures: [now - 20 * 60_000], lockedUntil: now - 1, lockCount: 1 });

  auth.sweepBuckets(now);
  assert.deepEqual([...auth.buckets.keys()].sort(), ['locked', 'recent-failure']);
});

test('bucket 的数量上限是软上限：能清就清，清不掉就继续长', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir, { required: false, withCredentials: false });
  for (let index = 0; index < 512; index += 1) auth.bucket(`k${index}`);
  assert.equal(auth.buckets.size, 512);
  // 再次取桶时先 sweep：512 个空桶全部过期 → 全清 → 再加一个。
  auth.bucket('k512');
  assert.equal(auth.buckets.size, 1, '空桶在触发上限时被清掉');

  // 所有桶都被锁住时 sweep 删不掉任何东西，于是会超过上限继续增长（软上限）。
  auth.buckets.clear();
  for (let index = 0; index < 512; index += 1) {
    auth.buckets.set(`k${index}`, { failures: [], lockedUntil: Date.now() + 60_000, lockCount: 1 });
  }
  auth.bucket('overflow');
  assert.equal(auth.buckets.size, 513, '锁住的桶不会被清理，上限只是软约束');
});

test('登录失败：错用户名与错口令都只回 bad-credentials，且都计入同一个桶', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  const wrongUser = auth.login({ user: 'mallory', password: PASSWORD, ip: '1.1.1.1', deviceId: 'd1' });
  assert.deepEqual(wrongUser, { ok: false, reason: 'bad-credentials', retryAfterSec: 0 });
  const wrongPassword = auth.login({ user: 'alice', password: '错的', ip: '1.1.1.1', deviceId: 'd1' });
  assert.deepEqual(wrongPassword, { ok: false, reason: 'bad-credentials', retryAfterSec: 0 });
  assert.equal(auth.globalFailures, 2);
  assert.equal(auth.bucket('1.1.1.1|d1').failures.length, 2);
  // 错误原因不区分「用户名错」还是「口令错」，避免枚举用户。
  assert.equal(wrongUser.reason, wrongPassword.reason);
});

test('连续 5 次失败锁定 5 分钟，锁定期内正确口令也进不来', () => {
  const dir = scratch();
  const { auth, logs } = makeAuth(dir);
  const attempt = () => auth.login({ user: 'alice', password: '错的', ip: '2.2.2.2', deviceId: 'd2' });
  for (let index = 0; index < 4; index += 1) assert.equal(attempt().reason, 'bad-credentials');
  const locked = attempt();
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'locked');
  assert.equal(locked.retryAfterSec, 300, '第一次锁定 5 分钟');
  assert.ok(logs.some(([, line]) => line.includes('已被锁定')));
  assert.equal(auth.bucket('2.2.2.2|d2').lockCount, 1);
  assert.deepEqual(auth.bucket('2.2.2.2|d2').failures, [], '锁定时清空失败计数');

  const rightWhileLocked = auth.login({ user: 'alice', password: PASSWORD, ip: '2.2.2.2', deviceId: 'd2' });
  assert.equal(rightWhileLocked.reason, 'locked');
  assert.ok(rightWhileLocked.retryAfterSec > 0 && rightWhileLocked.retryAfterSec <= 300);

  // 锁到期后正确口令可以进（把 lockedUntil 拨回过去来模拟等待 5 分钟）。
  auth.bucket('2.2.2.2|d2').lockedUntil = Date.now() - 1;
  const recovered = auth.login({ user: 'alice', password: PASSWORD, ip: '2.2.2.2', deviceId: 'd2' });
  assert.equal(recovered.ok, true);
  assert.equal(auth.bucket('2.2.2.2|d2').lockCount, 0, '成功登录要重置锁定层级');
});

test('重复锁定按 2 倍递增，封顶 1 小时', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  const key = '3.3.3.3|d3';
  const fail5 = () => {
    auth.bucket(key).lockedUntil = 0;
    for (let index = 0; index < 5; index += 1) auth.login({ user: 'alice', password: '错的', ip: '3.3.3.3', deviceId: 'd3' });
  };
  fail5();
  assert.equal(auth.bucket(key).lockCount, 1);
  fail5();
  assert.equal(auth.bucket(key).lockCount, 2);
  assert.ok(auth.bucket(key).lockedUntil - Date.now() > 550_000, '第二次锁定 10 分钟');

  for (let round = 0; round < 8; round += 1) fail5();
  assert.equal(auth.bucket(key).lockCount, 10);
  const maxRetry = Math.ceil((auth.bucket(key).lockedUntil - Date.now()) / 1000);
  assert.ok(maxRetry <= 3600, `封顶 1 小时，实际 ${maxRetry}s`);
  assert.ok(maxRetry > 3500, '到第 10 轮时早已封顶');
});

test('没有身份信息时不锁定，只累计并记日志（避免陌生人锁死主人）', () => {
  const dir = scratch();
  const { auth, logs } = makeAuth(dir);
  for (let index = 0; index < 12; index += 1) {
    const result = auth.login({ user: 'alice', password: '错的' });
    assert.equal(result.reason, 'bad-credentials', `第 ${index + 1} 次也还是 bad-credentials`);
    assert.equal(result.retryAfterSec, 0);
  }
  assert.equal(auth.globalFailures, 12);
  assert.equal(auth.buckets.size, 0, '没有身份就不建桶');
  assert.ok(logs.some(([, line]) => line.includes('来源未标识')));
  assert.equal(auth.info().locked, false);
});

test('分桶互相隔离：一个来源被锁不影响另一个来源与主人', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  for (let index = 0; index < 5; index += 1) {
    auth.login({ user: 'alice', password: '错的', ip: '6.6.6.6', deviceId: 'attacker' });
  }
  assert.equal(auth.bucket('6.6.6.6|attacker').lockedUntil > Date.now(), true);

  // 同一台手机换 ip：不同桶，不被牵连。
  const otherIp = auth.login({ user: 'alice', password: PASSWORD, ip: '7.7.7.7', deviceId: 'attacker' });
  assert.equal(otherIp.ok, true);
  // 同一 ip 换 deviceId：不同桶。
  const otherDevice = auth.login({ user: 'alice', password: PASSWORD, ip: '6.6.6.6', deviceId: 'owner' });
  assert.equal(otherDevice.ok, true);
  // 真正的主人（另一个来源）始终能进。
  assert.equal(auth.info().locked, true, 'info 里能看出“有来源正被锁”');
});

test('锁定到期后旧失败记录不再累计（10 分钟窗口）', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  const key = '8.8.8.8|d8';
  const bucket = auth.bucket(key);
  bucket.failures = [Date.now() - 11 * 60_000, Date.now() - 12 * 60_000];
  const result = auth.login({ user: 'alice', password: '错的', ip: '8.8.8.8', deviceId: 'd8' });
  assert.equal(result.reason, 'bad-credentials', '窗口外的 2 次不计入，所以还没到 5 次');
  assert.equal(bucket.failures.length, 1, '过窗记录被裁掉，只剩这一次');
});

/* ------------------------------------------------------ 会话上限 / 登出 ---- */

test('会话数上限 20：超出时按创建时间淘汰最旧的', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  const tokens = [];
  for (let index = 0; index < 21; index += 1) tokens.push(auth.login({ user: 'alice', password: PASSWORD }).token);
  assert.equal(auth.sessions.size, 20);
  assert.equal(auth.check(tokens[0]), null, '最早的一条被淘汰');
  assert.equal(auth.check(tokens[1]) !== null, true);
  assert.equal(auth.check(tokens[20]) !== null, true);
});

test('logout：只认字符串，删掉就再也 check 不过', () => {
  const dir = scratch();
  const { auth, sessions } = makeAuth(dir);
  const { token } = auth.login({ user: 'alice', password: PASSWORD });
  assert.equal(auth.check(token) !== null, true);

  assert.equal(auth.logout(undefined), false);
  assert.equal(auth.logout(42), false);
  assert.equal(auth.logout('不存在的令牌'), false);
  assert.equal(auth.logout(token), true);
  assert.equal(auth.check(token), null);
  assert.equal(auth.logout(token), false, '重复登出返回 false');
  assert.deepEqual(JSON.parse(readFileSync(sessions, 'utf8')).sessions, []);
});

test('revokeAll：清空全部会话并落盘', () => {
  const dir = scratch();
  const { auth, sessions } = makeAuth(dir);
  auth.login({ user: 'alice', password: PASSWORD });
  auth.login({ user: 'alice', password: PASSWORD });
  assert.equal(auth.revokeAll(), 2);
  assert.equal(auth.sessions.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(sessions, 'utf8')).sessions, []);
  assert.equal(auth.revokeAll(), 0, '空的时候返回 0');
});

test('nextExpiry / info：摘要给 CLI 与状态页用', () => {
  const dir = scratch();
  const { auth } = makeAuth(dir);
  assert.equal(auth.nextExpiry(), 0, '没有会话 → 0');
  const first = auth.login({ user: 'alice', password: PASSWORD });
  auth.sessions.get(digest(first.token)).expiresAt = Date.now() + 5_000;
  const second = auth.login({ user: 'alice', password: PASSWORD });
  assert.equal(auth.nextExpiry(), auth.sessions.get(digest(first.token)).expiresAt, '取最近的过期时间');
  assert.ok(auth.nextExpiry() < auth.sessions.get(digest(second.token)).expiresAt);

  auth.sessions.get(digest(first.token)).expiresAt = Date.now() - 1;
  assert.equal(auth.nextExpiry(), auth.sessions.get(digest(second.token)).expiresAt, '过期的不参与');

  const info = auth.info();
  assert.equal(info.required, true);
  assert.equal(info.configured, true);
  assert.equal(info.enabled, true);
  assert.equal(info.user, 'alice');
  assert.equal(info.sessions, 2);
  assert.equal(typeof info.nextExpiry, 'number');
  assert.equal(info.locked, false);
  assert.equal(info.globalFailures, 0);
  assert.equal(info.error, '');
});

/* -------------------------------------------------------- 多实例 / 失败路径 ---- */

test('两个实例共享文件：令牌与登出都能互相看见（check 内部会 maybeReload）', () => {
  const dir = scratch();
  const a = makeAuth(dir).auth;
  const b = makeAuth(dir).auth;
  const { token } = a.login({ user: 'alice', password: PASSWORD });
  assert.equal(b.check(token)?.phone, '手机', 'B 不需要手工 reload，check 自己会比对 mtime');
  assert.equal(a.logout(token), true);
  assert.equal(b.check(token), null, '登出也要能被另一个实例看到');
});

test('会话文件写不进去时 login/renew/check 都不抛：内存照常生效，只丢持久化', () => {
  const dir = scratch();
  // 把 sessions 的父路径占成一个普通文件：atomicWriteJson 的 openSync 必然失败，
  // 等价于只读目录 / 磁盘满 / Windows 上 rename 的 EPERM。
  const blocker = path.join(dir, 'blocked');
  writeFileSync(blocker, 'x', 'utf8');
  const logs = [];
  const auth = new Auth({
    credentialsFile: credentialsFile(dir),
    sessionsFile: path.join(blocker, 'sessions.json'),
    required: true,
    logger: {
      info: () => {},
      warn: (...args) => logs.push(args.join(' ')),
      error: () => {},
    },
  });

  // login 不能抛：调用方（handleLogin / handleAuthCheck / authorized）都是按
  // 「不会抛」写的，一抛就会被 MQTT 回调的 catch 吞成 stats.errors++ 并丢帧，
  // 手机上表现为「登录没反应 / 所有消息都丢了」，看起来像鉴权失败。
  let login;
  assert.doesNotThrow(() => { login = auth.login({ user: 'alice', password: PASSWORD }); });
  assert.equal(login.ok, true, '落盘失败不能让登录失败');
  assert.equal(auth.sessions.size, 1, '内存里的会话必须已经登记');
  assert.ok(logs.some((line) => line.includes('写入磁盘失败')), '失败必须留一条 warn，否则永远查不到');

  // check + 滑动续期同样不能抛，且续期必须真的写进内存（磁盘丢了，登录不能丢）。
  const session = [...auth.sessions.values()][0];
  const before = session.expiresAt;
  session.renewedAt = 0; // 强制下一次 check 触发续期
  let seen;
  assert.doesNotThrow(() => { seen = auth.check(login.token); });
  assert.notEqual(seen, null, 'check 必须照常放行');
  assert.ok(session.expiresAt > before, '续期必须落在内存里');

  // 告警节流：持续故障不该每次心跳都刷一行日志。
  const warned = logs.filter((line) => line.includes('写入磁盘失败')).length;
  session.renewedAt = 0;
  assert.equal(auth.renew(session), true);
  assert.equal(
    logs.filter((line) => line.includes('写入磁盘失败')).length,
    warned,
    '短时间内的重复失败必须被节流',
  );
});

/* ---------------------------------------------------------------- authorize ---- */

test('authorize：required 但凭据缺失时 fail-closed；闸门正常时按令牌判定', () => {
  const dir = scratch();
  const broken = new Auth({
    credentialsFile: path.join(dir, 'missing-auth.json'),
    sessionsFile: path.join(dir, 'sessions.json'),
    required: true,
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(broken.required, true);
  assert.equal(broken.enabled, false);
  // 老实现走到这里返回 {required:false, ok:true}：配置要求口令、闸门却坏了，
  // 中继会当成「不需要口令」直接放行 —— 正是本文件开头契约禁止的 fail-open。
  assert.throws(
    () => broken.authorize('any-token'),
    (error) => error.code === 'auth_missing_credentials',
  );
  // 语义与 assertUsable() 一致：调用方只需要处理一种「闸门坏了」的形态。
  assert.throws(() => broken.assertUsable(), (error) => error.code === 'auth_missing_credentials');

  const enabled = makeAuth(dir).auth;
  const { token } = enabled.login({ user: 'alice', password: PASSWORD });
  const good = enabled.authorize(token);
  assert.equal(good.required, true);
  assert.equal(good.ok, true);
  assert.equal(good.session?.phone, '手机');

  const bad = enabled.authorize('not-a-token');
  assert.equal(bad.required, true);
  assert.equal(bad.ok, false);
  assert.equal(bad.session, null);

  const off = new Auth({
    credentialsFile: credentialsFile(dir),
    sessionsFile: path.join(dir, 'off-sessions.json'),
    required: false,
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.deepEqual(off.authorize('anything'), { required: false, ok: true, session: null });
});
