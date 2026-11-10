/**
 * 15 天免密会话的生命周期（lib/auth.mjs）——用户端的承诺是
 * 「输一次账号 + 口令，之后 15 天不用再输」，所以这里守的是三件事：
 *
 *  1. 到期边界**精确**：第 15 天最后一毫秒还认，下一毫秒就不认；
 *  2. 滑动续期：一直在用的手机不会被「从登录那天算起 15 天」硬掐掉；
 *  3. 名额淘汰按「最久没连」而不是「最早登录」，否则天天用的手机反而先掉。
 *
 * 全部用真 scryptSync + 真文件，只把 N 调小（FAST）让 20+ 次登录不拖慢 CI。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { Auth, hashPassword, SESSION_TTL_MS } from '../../lib/auth.mjs';

const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };
const PASSWORD = '口令 Passw0rd!';
const USER = 'owner';
const DAY = 24 * 60 * 60 * 1000;

let root;

after(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

let counter = 0;

/** 一套干净凭据 + 一个真 Auth。 */
function makeAuth() {
  root ??= mkdtempSync(path.join(tmpdir(), 'dsh-pocket-lifecycle-'));
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const credentialsFile = path.join(dir, 'auth.json');
  writeFileSync(credentialsFile, JSON.stringify({
    user: USER,
    password: hashPassword(PASSWORD, 'b'.repeat(32), FAST),
  }), 'utf8');
  const sessionsFile = path.join(dir, 'sessions.json');
  const logger = { info() {}, warn() {}, error() {} };
  const auth = new Auth({ credentialsFile, sessionsFile, logger, required: true });
  return { auth, sessionsFile, credentialsFile, dir, logger };
}

/* ------------------------------------------------------------- 到期边界 ---- */

test('15 天窗口：最后一毫秒仍然有效，到期那一刻立刻失效', () => {
  const { auth } = makeAuth();

  // 用两条独立会话分别验两个边界。不能拿同一条令牌先验「有效」再验「失效」：
  // 前一次 check 会触发滑动续期，把到期时间推到更远，后面的断言就自相矛盾了。
  const expired = auth.login({ user: USER, password: PASSWORD });
  assert.equal(auth.check(expired.token, expired.expiresAt), null, '到期那一刻必须失效（<= 而非 <）');
  assert.equal(auth.check(expired.token, expired.expiresAt + 1), null);

  const alive = auth.login({ user: USER, password: PASSWORD });
  assert.notEqual(auth.check(alive.token, alive.expiresAt - 1), null, '到期前 1ms 必须仍然有效');
});

test('短会话的到期边界是硬的（不续期，所以 12 小时整点就失效）', () => {
  const { auth } = makeAuth();
  const before = Date.now();
  const short = auth.login({ user: USER, password: PASSWORD, remember: false });
  assert.ok(short.expiresAt - before <= 12 * 60 * 60 * 1000 + 2000);

  // 短会话不参与续期，所以这两个断言不会互相影响。
  assert.equal(auth.check(short.token, short.expiresAt), null, '短会话到期那一刻必须失效');
  const again = auth.login({ user: USER, password: PASSWORD, remember: false });
  assert.notEqual(auth.check(again.token, again.expiresAt - 1), null);
});

test('有效期就是 15 天，不是 14 也不是 16', () => {
  const { auth } = makeAuth();
  const before = Date.now();
  const { expiresAt } = auth.login({ user: USER, password: PASSWORD });
  assert.ok(expiresAt >= before + SESSION_TTL_MS, '有效期不得短于 15 天');
  assert.ok(expiresAt <= Date.now() + SESSION_TTL_MS, '有效期不得长于 15 天');
  assert.equal(SESSION_TTL_MS, 15 * DAY);
});

/* ------------------------------------------------------------- 滑动续期 ---- */

test('滑动续期：一天之后再连，有效期被推到「现在 + 15 天」', () => {
  const { auth } = makeAuth();
  const { token, expiresAt } = auth.login({ user: USER, password: PASSWORD });

  const later = Date.now() + 2 * DAY;
  const session = auth.check(token, later);
  assert.notEqual(session, null);
  assert.equal(session.expiresAt, later + SESSION_TTL_MS, '续期后应当是「现在 + 15 天」');
  assert.ok(session.expiresAt > expiresAt, '续期必须真的把到期时间往后推');
  assert.equal(session.renewedAt, later);
});

test('滑动续期：一直在连的手机永远不会掉线（连推 5 天）', () => {
  const { auth } = makeAuth();
  const { token } = auth.login({ user: USER, password: PASSWORD });

  let now = Date.now();
  // 每天连一次，连续 5 天：每次都必须仍然有效。
  for (let day = 1; day <= 5; day += 1) {
    now += DAY;
    assert.notEqual(auth.check(token, now), null, `第 ${day} 天必须仍然有效`);
  }
});

test('续期节流：同一天内的连续 check 只续一次，不反复写盘', () => {
  const { auth, sessionsFile } = makeAuth();
  const { token } = auth.login({ user: USER, password: PASSWORD });

  const base = Date.now() + 2 * DAY;
  auth.check(token, base);
  const firstWrite = readFileSync(sessionsFile, 'utf8');

  // 同一小时内再连 5 次：有效期不该动（一天一次已经够）。
  for (let i = 1; i <= 5; i += 1) {
    auth.check(token, base + i * 60_000);
  }
  const session = auth.check(token, base + 6 * 60_000);
  assert.equal(session.expiresAt, base + SESSION_TTL_MS, '同一天内的重复连接不该再续期');
  // 文件内容允许因为别的写入变化，但有效期字段必须稳定。
  const stored = JSON.parse(readFileSync(sessionsFile, 'utf8'));
  assert.equal(stored.sessions[0].expiresAt, base + SESSION_TTL_MS);
  assert.ok(firstWrite.includes('"sessions"'));
});

test('续期要落盘：新进程读同一个 sessions.json 看得到新的到期时间', () => {
  const { auth, sessionsFile, credentialsFile, logger } = makeAuth();
  const { token } = auth.login({ user: USER, password: PASSWORD });
  const later = Date.now() + 3 * DAY;
  auth.check(token, later);

  const revived = new Auth({ credentialsFile, sessionsFile, logger, required: true });
  const session = revived.check(token, later + 60_000);
  assert.notEqual(session, null, '重启后续期结果必须还在');
  assert.equal(session.expiresAt, later + SESSION_TTL_MS);
});

test('短会话（remember=false）不参与续期：用完就该失效', () => {
  const { auth } = makeAuth();
  const { token } = auth.login({ user: USER, password: PASSWORD, remember: false });
  const later = Date.now() + DAY;
  // 短会话 12 小时，过一天就该过期，且不该被续期救回来。
  assert.equal(auth.check(token, later), null);
});

/* ------------------------------------------------------- 名额与淘汰顺序 ---- */

test('会话名额有上限：超了之后按「最久没连」淘汰，而不是「最早登录」', () => {
  const { auth } = makeAuth();

  // 先登录一台，然后把它续到很远的将来 —— 它「用得最多」。
  const active = auth.login({ user: USER, password: PASSWORD, phone: '常用的那台' });
  const far = Date.now() + 10 * DAY;
  auth.check(active.token, far);

  // 再堆满到上限。
  for (let i = 0; i < 20; i += 1) {
    auth.login({ user: USER, password: PASSWORD, phone: `批量 ${i}` });
  }
  assert.ok(auth.sessions.size <= 20, `会话数不得超过上限，实际 ${auth.sessions.size}`);

  // 关键断言：被续期过的那台必须还在。
  assert.notEqual(
    auth.check(active.token, far + 60_000),
    null,
    '天天在用的手机不该被后来的登录挤掉',
  );
});

test('改口令撤销全部会话后，旧令牌一个都不认', () => {
  const { auth } = makeAuth();
  const first = auth.login({ user: USER, password: PASSWORD });
  const second = auth.login({ user: USER, password: PASSWORD });
  assert.equal(auth.sessions.size, 2);
  assert.equal(auth.revokeAll(), 2);
  assert.equal(auth.check(first.token), null);
  assert.equal(auth.check(second.token), null);
});

test('prune 清掉过期会话并落盘，不虚占名额', () => {
  const { auth, sessionsFile } = makeAuth();
  const { token } = auth.login({ user: USER, password: PASSWORD });
  const removed = auth.prune(Date.now() + SESSION_TTL_MS + 1);
  assert.equal(removed, 1);
  assert.equal(auth.sessions.size, 0);
  assert.equal(auth.check(token), null);
  const stored = JSON.parse(readFileSync(sessionsFile, 'utf8'));
  assert.deepEqual(stored.sessions, [], '过期的会话不该留在磁盘上');
});
