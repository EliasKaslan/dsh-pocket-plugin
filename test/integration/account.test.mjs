/**
 * 账号 + 口令的本机修改面：`lib/credentials.mjs` 与 `/api/v1/account`。
 *
 * 这里守的是安全评审会逐条看的那几条：
 *   - GET 只回账号与两个布尔，绝不回口令 / 哈希 / 盐；
 *   - POST 必须同时过 requireLoopback({write:true}) 与显式 CSRF：
 *     缺 token → 403、带中继标记 → 403，且被拒时 auth.json 一个字节都不变；
 *   - 成功路径：auth.json 被原子重写（结构 / scrypt 参数 / 0600）、sessions.json
 *     被清、旧口令登不进来、新口令能登进来；
 *   - 日志里搜不到口令明文，也搜不到哈希与盐。
 *
 * 脚手架沿用 test/integration 的既有写法：真 BridgeCore + 真 BridgeServer、
 * 一次性临时目录、127.0.0.1 的临时端口，不联网、不碰 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Auth, hashPassword } from '../../lib/auth.mjs';
import { clearSessions, validateCredentials, writeCredentials } from '../../lib/credentials.mjs';
import { jsonResponse, requestJson, startBridge } from './support/harness.mjs';

const OLD_USER = '旧账号';
const OLD_PASSWORD = '旧口令 Passw0rd!';
const NEW_USER = '新账号-小明';
const NEW_PASSWORD = '新口令 Strong#2026';
const THIRD_PASSWORD = '第三个口令 Third#2026';

let ctx;
let auth;
let credentialsFile;
let sessionsFile;

/** 写一份与 tools/set-auth.mjs 完全同构的初始凭据（测试不依赖被测写入路径）。 */
function seedOldCredentials() {
  writeFileSync(credentialsFile, `${JSON.stringify({
    user: OLD_USER,
    password: hashPassword(OLD_PASSWORD),
    updatedAt: Date.now(),
  }, null, 2)}\n`, 'utf8');
}

function postAccount(body, headers = {}) {
  return requestJson(ctx.port, '/api/v1/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pocket-csrf': ctx.core.csrfToken, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

before(async () => {
  ctx = await startBridge();
  credentialsFile = path.join(ctx.dataDir, 'auth.json');
  sessionsFile = path.join(ctx.dataDir, 'sessions.json');
  seedOldCredentials();
  auth = new Auth({
    credentialsFile,
    sessionsFile,
    // 用桥接的 logger：这样「口令是否进了日志」是在同一份日志上断言的。
    logger: ctx.core.logger,
    required: true,
  });
  ctx.core.attachAuth(auth);
  // 预置一个有效会话（相当于手机已经登录过），后面的「改口令清会话」才有东西可清。
  const login = auth.login({ user: OLD_USER, password: OLD_PASSWORD, phone: '旧手机' });
  assert.equal(login.ok, true, '预置的旧口令必须能登录，否则后面的断言没有意义');
  assert.equal(existsSync(sessionsFile), true, '预置登录必须落出 sessions.json');
});

after(async () => {
  await ctx?.close();
});

/* --------------------------------------------------------------- GET 只读 */

test('GET /api/v1/account：回环 200、只回账号与状态，绝不回口令或哈希', async () => {
  const response = await requestJson(ctx.port, '/api/v1/account');
  const body = jsonResponse(response, 200, 'GET /api/v1/account');
  assert.deepEqual(body, {
    ok: true,
    data: { user: OLD_USER, configured: true, required: true },
  }, '账号视图的字段集合被改动了');

  const record = JSON.parse(readFileSync(credentialsFile, 'utf8'));
  for (const forbidden of [OLD_PASSWORD, record.password.hash, record.password.salt, '"password"', '"salt"', '"hash"', 'scrypt']) {
    assert.equal(response.body.includes(forbidden), false, `GET /account 泄漏了 ${forbidden.slice(0, 12)}…`);
  }
});

test('GET /api/v1/account：非回环（带中继标记）一律 403 loopback_only', async () => {
  const response = await requestJson(ctx.port, '/api/v1/account', {
    headers: { 'x-pocket-relay': ctx.core.relayNonce },
  });
  const body = jsonResponse(response, 403, 'GET /account（中继）');
  assert.equal(body.error.code, 'loopback_only');
});

/* --------------------------------------------------------- POST 的两道闸 */

test('POST 无 CSRF：没有浏览器信号、只有 Origin、错误 token、跨站都必须 403，且不改进凭据', async () => {
  const before = readFileSync(credentialsFile, 'utf8');
  const cases = [
    [{}, '完全没有任何信号（本仓给 CLI 的旁路不能用来改口令）'],
    [{ origin: 'http://127.0.0.1:1' }, '同源 Origin 但没有 token'],
    [{ 'sec-fetch-site': 'same-origin' }, '同源 fetch 但没有 token'],
    [{ 'x-pocket-csrf': 'deadbeefdeadbeefdeadbeefdeadbeef' }, '错误的 token'],
    [{ 'sec-fetch-site': 'cross-site' }, '跨站'],
  ];
  for (const [headers, label] of cases) {
    const response = await requestJson(ctx.port, '/api/v1/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ user: NEW_USER, password: NEW_PASSWORD }),
    });
    const body = jsonResponse(response, 403, `POST /account（${label}）`);
    assert.equal(body.error.code, 'csrf', `${label} 的拒绝原因必须是 csrf`);
  }
  assert.equal(readFileSync(credentialsFile, 'utf8'), before, '被拒的写操作改动了 auth.json');
  const record = JSON.parse(before);
  assert.equal(record.user, OLD_USER, '被拒的写操作改动了账号');
});

test('POST 带中继标记：即便 CSRF 令牌正确也必须 403 loopback_only，且不改进凭据', async () => {
  const before = readFileSync(credentialsFile, 'utf8');
  const response = await postAccount({ user: NEW_USER, password: NEW_PASSWORD }, { 'x-pocket-relay': ctx.core.relayNonce });
  const body = jsonResponse(response, 403, 'POST /account（中继）');
  assert.equal(body.error.code, 'loopback_only');
  assert.equal(readFileSync(credentialsFile, 'utf8'), before, '中继请求改动了 auth.json');
  assert.ok(
    ctx.logs.some((line) => line.includes('blocked write from relay')),
    `中继写必须留日志，实际：${ctx.logs.slice(-4).join(' | ')}`,
  );
});

/* ----------------------------------------------------------- 校验失败 400 */

test('POST 校验失败：空账号 / 弱口令 / 非法字符 / 超长都 400 invalid_credentials，且不改动凭据', async () => {
  const before = readFileSync(credentialsFile, 'utf8');
  const cases = [
    [{ user: '', password: NEW_PASSWORD }, /账号不能为空/u],
    [{ user: '   ', password: NEW_PASSWORD }, /账号不能为空/u],
    [{ user: NEW_USER, password: '1234567' }, /口令至少 8 个字符/u],
    [{ user: NEW_USER, password: '' }, /口令不能为空/u],
    [{ user: 'bad name', password: NEW_PASSWORD }, /账号只能包含/u],
    [{ user: 'a'.repeat(65), password: NEW_PASSWORD }, /账号最多 64 个字符/u],
    [{ user: NEW_USER, password: 'a'.repeat(201) }, /口令最多 200 个字符/u],
    [{ user: NEW_USER, password: 12345678 }, /口令不能为空/u],
  ];
  for (const [payload, pattern] of cases) {
    const response = await postAccount(payload);
    const body = jsonResponse(response, 400, `POST /account（${JSON.stringify(payload).slice(0, 40)}）`);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'invalid_credentials');
    assert.match(body.error.message, pattern);
  }
  assert.equal(readFileSync(credentialsFile, 'utf8'), before, '校验失败的写操作改动了 auth.json');
  // 旧口令仍然可用：400 不能顺手把用户锁在门外。
  assert.equal(ctx.core.auth.login({ user: OLD_USER, password: OLD_PASSWORD }).ok, true);
});

/* --------------------------------------------------------------- 成功路径 */

test('POST 成功：auth.json 原子重写 + 0600、sessions.json 被清、旧口令失效、新口令可登录、日志无明文', async () => {
  const response = await postAccount({ user: ` ${NEW_USER} `, password: NEW_PASSWORD });
  const body = jsonResponse(response, 200, 'POST /account（成功）');
  assert.deepEqual(body, {
    ok: true,
    data: { user: NEW_USER, sessionsCleared: true, relayState: 'disabled' },
  }, '成功响应契约变了（账号要 trim；没有中继时 relayState=disabled）');

  // 1) 文件结构必须与 tools/set-auth.mjs 写出的完全同构。
  const raw = readFileSync(credentialsFile, 'utf8');
  const record = JSON.parse(raw);
  assert.deepEqual(Object.keys(record).sort(), ['password', 'updatedAt', 'user']);
  assert.equal(record.user, NEW_USER);
  assert.equal(typeof record.updatedAt, 'number');
  assert.deepEqual(Object.keys(record.password).sort(), ['N', 'algo', 'hash', 'p', 'r', 'salt']);
  assert.equal(record.password.algo, 'scrypt');
  assert.equal(record.password.N, 16384);
  assert.equal(record.password.r, 8);
  assert.equal(record.password.p, 1);
  assert.match(record.password.salt, /^[0-9a-f]{32}$/u, 'salt 必须是 16 字节的 hex');
  assert.match(record.password.hash, /^[A-Za-z0-9+/]{43}=$/u, 'hash 必须是 32 字节 scrypt 的 base64');
  assert.equal(raw.includes(NEW_PASSWORD), false, 'auth.json 里出现了口令明文');
  assert.equal(raw.includes(OLD_PASSWORD), false, 'auth.json 里还留着旧口令明文');

  // 2) 权限：POSIX 上必须真的 0600；Windows 上没有 group/other 位，只要求属主可读写。
  const mode = statSync(credentialsFile).mode;
  if (process.platform === 'win32') {
    assert.equal(mode & 0o600, 0o600, `Windows 上 auth.json 至少要是属主可读写，实际 mode=${(mode & 0o777).toString(8)}`);
  } else {
    assert.equal(mode & 0o077, 0, `auth.json 必须 0600，实际 mode=${(mode & 0o777).toString(8)}`);
  }

  // 3) 会话全部作废：文件被删掉，内存里也没有旧令牌。
  assert.equal(existsSync(sessionsFile), false, '改口令后 sessions.json 必须被删除');
  assert.equal(auth.sessions.size, 0, '内存里还留着旧会话');

  // 4) 旧口令登不进来，新口令能登进来；内存里的账号已经换掉（reload 生效）。
  assert.equal(ctx.core.auth.user, NEW_USER, 'reload 之后内存里的账号没更新');
  assert.equal(auth.login({ user: NEW_USER, password: OLD_PASSWORD }).ok, false, '旧口令仍然能登录');
  assert.equal(auth.login({ user: OLD_USER, password: NEW_PASSWORD }).ok, false, '旧账号名仍然能登录');
  assert.equal(auth.login({ user: NEW_USER, password: NEW_PASSWORD }).ok, true, '新口令登不进来');

  // 5) 审计：日志里有账号，但绝没有口令明文、盐或哈希。
  const joined = ctx.logs.join('\n');
  assert.ok(joined.includes(`账号口令已更新：账号=${NEW_USER}`), '审计日志必须记下账号与结果');
  for (const secret of [OLD_PASSWORD, NEW_PASSWORD, record.password.hash, record.password.salt]) {
    assert.equal(joined.includes(secret), false, `日志里出现了不该有的凭据片段：${secret.slice(0, 10)}…`);
  }

  // 6) GET 立刻反映新账号（页面刷新后看到的就是它）。
  const view = await requestJson(ctx.port, '/api/v1/account');
  assert.deepEqual(jsonResponse(view, 200, 'GET /account（改后）').data, {
    user: NEW_USER, configured: true, required: true,
  });
});

/* ------------------------------------------------- 改完口令补拉中继 */

test('POST 成功：中继处于 blocked/unconfigured/error 时补一次 stop→start；start 抛错也不改 HTTP 结果', async () => {
  const calls = [];
  const fake = {
    state: 'blocked',
    enabled: false,
    stop() { calls.push(['stop']); this.state = 'disabled'; },
    start(port) { calls.push(['start', port]); this.state = 'online'; },
    status() { return { state: this.state }; },
  };
  ctx.core.setCloud(fake);

  const response = await postAccount({ user: NEW_USER, password: THIRD_PASSWORD });
  const body = jsonResponse(response, 200, '改口令 + 补拉中继');
  assert.equal(body.data.relayState, 'online', '返回的必须是 start 之后的状态');
  assert.deepEqual(calls, [['stop'], ['start', ctx.core.port]], '必须按 stop → start 顺序、用实际端口启动');

  // start 抛错：口令已经改好，请求仍然是 200；只留一条错误日志。
  fake.state = 'error';
  fake.start = () => { throw new Error('broker unreachable'); };
  const breakdown = await postAccount({ user: NEW_USER, password: NEW_PASSWORD });
  const broken = jsonResponse(breakdown, 200, '中继启动失败时的改口令');
  assert.equal(broken.ok, true, '中继起不来不能把「口令已改好」报成失败');
  assert.equal(broken.data.relayState, 'disabled', 'stop 之后 start 抛错，状态停在 stop 写入的 disabled');
  assert.ok(
    ctx.logs.some((line) => line.includes('改口令后启动中继失败')),
    `中继启动失败必须留日志，实际：${ctx.logs.slice(-4).join(' | ')}`,
  );

  // 非 stuck 状态不重启：online 时原样返回，不产生多余的 stop/start。
  const before = calls.length;
  fake.state = 'online';
  fake.start = () => { calls.push(['start-unexpected']); this.state = 'online'; };
  const online = await postAccount({ user: NEW_USER, password: THIRD_PASSWORD });
  assert.equal(jsonResponse(online, 200, '在线时不重启中继').data.relayState, 'online');
  assert.equal(calls.length, before, '中继已经在线时不该再 stop/start');
});

/* --------------------------------------------- credentials.mjs 的单元层 */

test('validateCredentials：trim、长度边界、字符集与空值都给明确原因', () => {
  assert.deepEqual(validateCredentials({ user: ' 小明 ', password: 'abcdefgh' }), { ok: true, reason: '', user: '小明' });
  assert.deepEqual(validateCredentials({ user: 'a'.repeat(64), password: 'abcdefgh' }), { ok: true, reason: '', user: 'a'.repeat(64) });
  assert.equal(validateCredentials({ user: 'a'.repeat(65), password: 'abcdefgh' }).ok, false);
  assert.match(validateCredentials({ user: undefined, password: 'abcdefgh' }).reason, /账号不能为空/u);
  assert.match(validateCredentials({ user: '小明', password: 'abcdefg' }).reason, /口令至少 8 个字符/u);
  assert.equal(validateCredentials({ user: '小明', password: 'abcdefghi' }).ok, true);
  assert.equal(validateCredentials({ user: '小明', password: 'a'.repeat(200) }).ok, true);
  assert.match(validateCredentials({ user: '小明', password: 'a'.repeat(201) }).reason, /口令最多 200 个字符/u);
  for (const bad of ['a b', 'a\nb', 'a/b', 'a$b', ''] ) {
    assert.equal(validateCredentials({ user: bad, password: 'abcdefgh' }).ok, false, `非法账号被放行：${JSON.stringify(bad)}`);
  }
  for (const good of ['user.name', 'user_name-1', 'user@example', '中文账号', '混合abc-_@中文']) {
    assert.equal(validateCredentials({ user: good, password: 'abcdefgh' }).ok, true, `合法账号被拒：${good}`);
  }
  // 失败时绝不把原文回带出去（调用方会把它写进日志）。
  assert.equal(validateCredentials({ user: '', password: 'secret-value' }).user, '');
});

test('writeCredentials：临时文件 + rename，失败时旧文件完好且不残留临时文件；clearSessions 缺文件视为成功', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-pocket-cred-'));
  try {
    const target = path.join(dir, 'auth.json');
    const result = writeCredentials(target, { user: '小明', password: 'abcdefgh' });
    assert.deepEqual(Object.keys(result).sort(), ['updatedAt', 'user'], '返回值必须不带哈希');
    assert.equal(result.user, '小明');
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).user, '小明');
    // 目录里只有成品的 auth.json：临时文件必须已经被 rename 掉，不能留在数据目录里。
    assert.deepEqual(await readdir(dir), ['auth.json']);

    // 失败路径：目标被一个目录占住 → rename 必失败。旧「文件」不被替换，临时文件被清理。
    const blocker = path.join(dir, 'blocked.json');
    await mkdir(blocker);
    assert.throws(() => writeCredentials(blocker, { user: '小红', password: 'abcdefgh' }), /EISDIR|EPERM|EACCES|ENOTDIR|EEXIST/u);
    assert.equal(statSync(blocker).isDirectory(), true, '失败的写把目标毁掉了');
    assert.deepEqual((await readdir(dir)).sort(), ['auth.json', 'blocked.json'], '失败的写留下了临时文件');

    // 校验双保险：即使调用方跳过校验，也不能写进非法账号。
    assert.throws(() => writeCredentials(target, { user: 'bad name', password: 'abcdefgh' }), (error) => {
      assert.equal(error.code, 'invalid_credentials');
      return true;
    });

    const sessions = path.join(dir, 'sessions.json');
    assert.equal(clearSessions(sessions), true, 'sessions.json 不存在时视为成功');
    writeFileSync(sessions, '{"sessions":[]}', 'utf8');
    assert.equal(clearSessions(sessions), true);
    assert.equal(existsSync(sessions), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
