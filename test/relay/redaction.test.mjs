/**
 * 安全性质 6：密钥/令牌不落日志。
 *
 * 中继的日志会进文件、进控制台、进用户贴出来的排障记录。房间密钥、设备令牌、
 * 登录口令、进程 nonce 一个都不能出现。可断言的两层：
 *   - lib/util.mjs 的 redactUrl / redactBroker / redactSecret 输出；
 *   - lib/cloud.mjs 在自己所有失败路径上真正写进 logger 的行（用假 logger 收集）。
 * 另外钉住「二维码链接把秘密放在 # 后面」——fragment 永远不会发给服务器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLinkUrl } from '../../lib/cloud.mjs';
import { redactBroker, redactSecret, redactUrl } from '../../lib/util.mjs';
import {
  KEY, feed, identityFor, makeLink, makeLogger,
} from './_support/fixtures.mjs';

const TOKEN = 'dshb_SUPER_SECRET_RELAY_TOKEN_0123456789';
const PASSWORD = 'hunter2-correct-horse';
const NONCE = 'process-nonce-abcdef0123456789';

test('redactBroker：丢弃 userinfo 与 query，但保留排障真正需要的 scheme/host/path', () => {
  const output = redactBroker(`wss://alice:${PASSWORD}@broker.example:8084/mqtt?access_token=${TOKEN}`);
  assert.equal(output, 'wss://***@broker.example:8084/mqtt?…');
  assert.ok(!output.includes(PASSWORD));
  assert.ok(!output.includes(TOKEN));

  // 没有 userinfo/query 时原样保留（host 是排障的关键，不能被一起抹掉）。
  assert.equal(redactBroker('wss://broker-cn.emqx.io:8084/mqtt'), 'wss://broker-cn.emqx.io:8084/mqtt');
  assert.equal(redactBroker('ws://127.0.0.1:8083'), 'ws://127.0.0.1:8083/');
  assert.equal(redactBroker(''), '(empty)');
  assert.equal(redactBroker(undefined), '(empty)');

  // 不是 URL 的输入退化成「前缀 + 长度」，绝不整串打印。
  const fallback = redactBroker(`not a url ${TOKEN}`);
  assert.ok(!fallback.includes(TOKEN));
  assert.match(fallback, /…\(len=\d+\)$/u);
});

test('redactUrl / redactSecret：query 与 fragment 一并丢掉', () => {
  assert.equal(redactUrl(`https://shell.example/app?k=${TOKEN}#k=${TOKEN}`), '/app?…');
  assert.equal(redactUrl('http://127.0.0.1:47901/api/v1/tasks?token=abc'), '/api/v1/tasks?…');
  assert.equal(redactUrl('http://127.0.0.1:47901/api/v1/health'), '/api/v1/health');
  assert.equal(redactUrl(''), '(empty)');
  assert.ok(!redactUrl(`https://x.example/?${TOKEN}`).includes(TOKEN));

  const secret = redactSecret(TOKEN);
  assert.equal(secret, `${TOKEN.slice(0, 6)}…(len=${TOKEN.length})`);
  assert.ok(!secret.includes(TOKEN));
  assert.equal(redactSecret(''), '(empty)');
  assert.equal(redactSecret(null), '(empty)');
});

test('二维码链接：秘密只在 # 之后（fragment 不会发给任何服务器）', () => {
  const link = { appBase: 'https://shell.example/app', room: 'room-1', key: 'k'.repeat(43), token: TOKEN, name: 'DSH', broker: 'wss://b.example/mqtt' };
  const url = buildLinkUrl(link);
  const parsed = new URL(url);
  assert.equal(parsed.search, '', '查询串会随请求发到服务器，秘密不能放这里');
  assert.equal(parsed.pathname, '/app');
  assert.ok(parsed.hash.includes(`t=${TOKEN}`), '令牌应放在 fragment');
  assert.ok(!url.split('#')[0].includes(TOKEN), 'fragment 之前不能出现令牌');
  assert.ok(!url.split('#')[0].includes(link.key));
});

test('CloudLink 全失败路径的日志都不含钥匙 / 令牌 / nonce / 口令', async () => {
  const logger = makeLogger();
  const auth = {
    enabled: true,
    user: 'owner',
    check: () => null,
    login: () => ({ ok: false, reason: 'bad_credentials' }),
    logout: () => false,
    info: () => ({ enabled: true, user: 'owner' }),
  };
  const { link, sent } = makeLink({
    identity: identityFor({ token: TOKEN }),
    auth,
    allowAnonymous: false,
    relayNonce: NONCE,
    logger,
  });

  // 1) 未授权帧
  feed(link, { t: 'req', id: 'unauth', seq: 1, ts: Date.now(), sid: 'aabbccdd', path: '/api/v1/me' }, { key: KEY });
  // 2) 过期帧（已授权路径走不通，用匿名 link 单独触发）
  const anon = makeLink({ logger, relayNonce: NONCE });
  feed(anon.link, { t: 'req', id: 'stale', seq: 1, ts: Date.now() - 1e9, sid: 'aabbccdd', path: '/api/v1/me' });
  // 3) 被拒绝的目标
  await anon.link.handleRequest({ id: 'pair', method: 'GET', path: '/pair' });
  // 4) 解不开的帧
  try {
    anon.link.onFrame(Buffer.from('{"v":1,"n":"","c":""}', 'utf8'));
  } catch { /* 预期抛错 */ }
  // 5) 登录失败（口令不该进日志）
  anon.link.auth = auth;
  anon.link.authEnabled = true;
  anon.link.blocked = null;
  anon.link.handleLogin({ user: 'owner', password: PASSWORD });

  const joined = logger.lines.join('\n');
  assert.ok(joined.length > 0, '这条用例要真的产生日志，否则是真空断言');
  for (const secret of [TOKEN, PASSWORD, NONCE, KEY.toString('base64url')]) {
    assert.ok(!joined.includes(secret), `日志里出现了秘密：${secret.slice(0, 8)}…`);
  }
  // 帧本身也不许带明文秘密（应答帧是密文，解出来才有内容）。
  for (const entry of sent) assert.ok(!entry.payload.includes(TOKEN));
  assert.ok(!JSON.stringify(anon.link.lastError).includes(TOKEN));
  // 反向对照：日志确实记录了「拒绝」，证明上面不是「什么都没做」。
  assert.ok(joined.includes('拒绝未授权消息'));
  assert.ok(joined.includes('拒绝重放/过期帧'));
  assert.ok(joined.includes('relay target refused'));
});

test('发送失败的错误只留信息、不留钥匙；lastError 可安全展示', () => {
  const logger = makeLogger();
  const { link, sent } = makeLink({ identity: identityFor({ token: TOKEN }), logger });
  link.client = {
    publish(_topic, _payload, _options, callback) { callback(new Error('broker said no')); },
    end() {},
  };
  link.publish({ t: 'res', id: 'x', status: 200, headers: {}, enc: '', body: '', ms: 1 });

  assert.equal(link.stats.errors, 1);
  assert.match(link.lastError, /broker said no/u);
  assert.ok(!link.lastError.includes(TOKEN));
  assert.ok(!link.lastError.includes(KEY.toString('base64url')));
  assert.ok(logger.lines.some((line) => line.includes('publish failed')));
  // 发送失败时没有任何一帧落袋，也不会把密文/明文写进日志。
  assert.equal(sent.length, 0);
});

/**
 * R3：拒绝日志的模板串曾经引号错位 ——
 *
 *     `... method=${String(message.method ?? ').slice(0, 8) || "GET"} path=${String(message.path ?? ').slice(0, 80) || "-"}`
 *
 * `?? '` 之后的引号与 `path=` 之后的引号闭合成一个字符串字面量，把
 * `).slice(0, 8) || "GET"} path=${String(message.path ?? ` 整段吞了进去：拒绝日志
 * 丢掉 path，method 缺失时还会把源码碎片打出来。`node --check` 对"语法合法、
 * 语义错位"不报错，所以只能断言日志内容来钉住它 —— 修复回退时这条必红。
 */
test('R3：被拒绝的目标必须把 method 与 path 打进日志（模板串不能再吞字段）', async () => {
  const logger = makeLogger();
  const { link } = makeLink({ logger });

  await link.handleRequest({ id: 'denied-devices', method: 'DELETE', path: '/api/v1/devices/dev_1' });
  // 旧外壳可能不带 method：默认 GET，且绝不能把源码碎片打进日志。
  await link.handleRequest({ id: 'denied-other', path: '/nope/at/all' });

  const lines = logger.lines.filter((line) => line.includes('relay target refused'));
  assert.equal(lines.length, 2, `两条被拒请求都要留痕（实际 ${lines.length}）`);
  assert.match(lines[0], /code=devices/u);
  assert.match(lines[0], /method=DELETE/u);
  assert.match(lines[0], /path=\/api\/v1\/devices\/dev_1/u, '拒绝日志必须带真实 path');
  assert.match(lines[1], /method=GET/u, '缺 method 时默认 GET');
  assert.match(lines[1], /path=\/nope\/at\/all/u);
  for (const line of lines) {
    assert.doesNotMatch(line, /\.slice\(|String\(message|path=\$\{/u, `日志里出现了源码碎片：${line}`);
  }
});
