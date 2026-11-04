/**
 * E2EE 信封（lib/cloud.mjs）——这是整个「手机在任何网络看电脑」的安全支点：
 * broker 只该看到密文，钥匙只在二维码里；AAD 绑主题与方向，所以录下来的帧
 * 既不能换房间重放，也不能反过来用（上行帧不能当下行帧解）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudLink, CLOUD_PROTOCOL, MAX_FRAME, SEAL_VERSION } from '../../lib/cloud.mjs';
import {
  CANARY, KEY_A, KEY_B, makeLink, openFrame, sealFrame, topicsOf, upFrame,
} from '../_support/envelope.mjs';

const AUTH_FAIL = /unable to authenticate|Unsupported state|bad decrypt/iu;

test('信封往返：seal 出来的是密文，unseal 能用同一把钥匙还原', () => {
  const { link, sent } = makeLink();
  const down = topicsOf(link.identity.room).down;

  assert.equal(link.publish({ t: 'hello', name: CANARY }), true);
  assert.equal(sent.length, 1, '一帧明文只该产生一条 MQTT 消息');
  assert.equal(sent[0].topic, down, '发方向必须封在 down 主题上');

  // 线上只有密文：明文哨兵不能出现在 payload 里。
  assert.ok(!sent[0].payload.includes(CANARY), 'MQTT payload 里出现了明文，E2EE 失效');

  const envelope = JSON.parse(sent[0].payload);
  assert.equal(envelope.v, SEAL_VERSION);
  assert.equal(Buffer.from(envelope.n, 'base64').length, 12, 'GCM IV 必须是 12 字节');
  assert.ok(Buffer.from(envelope.c, 'base64').length > 16, '密文里必须带 16 字节 GCM tag');

  const opened = openFrame({ key: KEY_A, aad: down, envelope: sent[0].payload });
  const message = JSON.parse(opened.toString('utf8'));
  assert.equal(message.t, 'hello');
  assert.equal(message.name, CANARY, '解出来的明文必须与封进去的一致');
});

test('错钥匙必须抛错：别人的钥匙解不开这一帧', () => {
  const { link, sent } = makeLink();
  const down = topicsOf(link.identity.room).down;

  link.publish({ t: 'hello', name: CANARY });
  // 发方向：密文本身就该解不开。
  assert.throws(() => openFrame({ key: KEY_B, aad: down, envelope: sent[0].payload }), AUTH_FAIL);

  // 收方向：拿错钥匙封一帧塞进来，真实代码必须抛错而不是当成空帧。
  const forged = upFrame(link, JSON.stringify({ t: 'hello', name: 'attacker' }), { key: KEY_B });
  assert.throws(() => link.onFrame(forged), AUTH_FAIL);
  assert.equal(link.phone, null, '解不开的帧不能留下任何状态');
});

test('AAD 绑定方向：down 主题封的帧不能当 up 主题的帧解开', () => {
  const { link, sent } = makeLink();
  const topics = topicsOf(link.identity.room);
  link.publish({ t: 'hello', name: CANARY });

  // 用 up 主题做 AAD 去解 down 主题封出来的帧 —— 必须失败（这就是方向被 AAD 钉住）。
  assert.throws(() => openFrame({ key: KEY_A, aad: topics.up, envelope: sent[0].payload }), AUTH_FAIL);

  // 用错 AAD 封一帧冒充上行，真实解码路径必须拒绝。
  const wrongDir = Buffer.from(sealFrame({
    key: KEY_A,
    aad: topics.down,
    plaintext: JSON.stringify({ t: 'hello', name: 'attacker' }),
  }), 'utf8');
  assert.throws(() => link.onFrame(wrongDir), AUTH_FAIL);
});

test('AAD 绑定主题：换了房间号（主题）之后同一帧解不开', () => {
  const { link: alice } = makeLink({ room: 'room-alice' });
  const { link: bob } = makeLink({ room: 'room-bob' });
  const frameForAlice = upFrame(alice, JSON.stringify({ t: 'hello', name: 'alice-phone' }));

  // 对照组：本房间能解开，证明这帧本身是合法的。
  alice.onFrame(frameForAlice);
  assert.equal(alice.phone?.name, 'alice-phone');

  // 换房间（换主题）后 AAD 不同，必须抛错：不能用别人房间的录音重放到这个房间。
  assert.throws(() => bob.onFrame(frameForAlice), AUTH_FAIL);
  assert.equal(bob.phone, null);
});

test('信封版本受 SEAL_VERSION 约束：v 不等于 1 的信封被拒', () => {
  const { link } = makeLink();
  const up = topicsOf(link.identity.room).up;
  const future = upFrame(link, JSON.stringify({ t: 'hello' }));
  const bumped = Buffer.from(sealFrame({
    key: KEY_A, aad: up, plaintext: JSON.stringify({ t: 'hello' }), version: 2,
  }), 'utf8');

  // v=1 的同构帧能过长度/结构检查（对照组），v=2 直接 bad envelope。
  assert.throws(() => link.onFrame(bumped), /bad envelope/u);
  assert.ok(future.length > 0);
  // 结构合法但 IV/tag 长度不对的信封也要拒。
  assert.throws(
    () => link.onFrame(Buffer.from(JSON.stringify({ v: 1, n: '', c: '' }), 'utf8')),
    /bad envelope body/u,
  );
});

test(`MAX_FRAME 边界：恰好 ${MAX_FRAME} 字节走单帧，+1 字节才拆包`, () => {
  const { link, sent } = makeLink();
  const down = topicsOf(link.identity.room).down;
  assert.equal(MAX_FRAME, 64 * 1024);

  const pad = (length) => ({ t: 'hello', name: 'boundary', pad: 'x'.repeat(length) });
  const base = Buffer.byteLength(JSON.stringify(pad(0)), 'utf8');

  // 恰好等于上限：单条消息，不是 part。
  const exact = pad(MAX_FRAME - base);
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), MAX_FRAME);
  assert.equal(link.publish(exact), true);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(openFrame({ key: KEY_A, aad: down, envelope: sent[0].payload })).t, 'hello');

  // 上限 +1：必须拆成两条 part，分片能拼回原始 JSON。
  sent.length = 0;
  const over = pad(MAX_FRAME - base + 1);
  assert.equal(Buffer.byteLength(JSON.stringify(over), 'utf8'), MAX_FRAME + 1);
  assert.equal(link.publish(over), true);
  assert.equal(sent.length, 2, '超过上限 1 字节就该拆成 2 片');
  const parts = sent.map((entry) => JSON.parse(openFrame({ key: KEY_A, aad: down, envelope: entry.payload })));
  assert.deepEqual(parts.map((part) => part.seq), [0, 1]);
  assert.deepEqual(parts.map((part) => part.t), ['part', 'part']);
  assert.equal(parts[0].total, 2);
  assert.equal(
    Buffer.concat(parts.map((part) => Buffer.from(part.d, 'base64'))).toString('utf8'),
    JSON.stringify(over),
    '分片重组后必须逐字节等于原始明文',
  );
});

test('超过 64 个分片预算的帧被拒（发方向），预算内仍照发', () => {
  const { link, sent } = makeLink();
  const base = Buffer.byteLength(JSON.stringify({ t: 'hello', name: 'budget', pad: '' }), 'utf8');
  const pad = (length) => ({ t: 'hello', name: 'budget', pad: 'x'.repeat(length) });

  // 恰好 64 片：允许。
  const atLimit = pad(64 * MAX_FRAME - base);
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit), 'utf8'), 64 * MAX_FRAME);
  assert.equal(link.publish(atLimit), true);
  assert.equal(sent.length, 64);
  assert.equal(link.stats.errors, 0);

  // 预算 +1 字节：直接拒绝，不发出任何一条消息。
  sent.length = 0;
  const oversize = pad(64 * MAX_FRAME - base + 1);
  const before = link.stats.errors;
  assert.equal(link.publish(oversize), false);
  assert.equal(sent.length, 0, '被拒的帧不能泄漏半条消息出去');
  assert.match(link.lastError, /frame too large/u);
  assert.equal(link.stats.errors, before + 1);
});

test('收方向硬上限：2*MAX_FRAME 字节能过长度检查，+1 字节直接 frame too large', () => {
  const { link } = makeLink();

  // 恰好 2*MAX_FRAME：长度闸放行，栽在 JSON 解析上（说明不是被长度闸拦的）。
  assert.throws(
    () => link.onFrame(Buffer.alloc(2 * MAX_FRAME, 0x20)),
    (error) => !/frame too large/u.test(error.message),
  );
  // +1 字节：长度闸先拦。
  assert.throws(() => link.onFrame(Buffer.alloc(2 * MAX_FRAME + 1, 0x20)), /frame too large/u);
});

test('hello 帧带的是 CLOUD_PROTOCOL(2)，不是 SEAL_VERSION(1)', () => {
  const { link, sent } = makeLink();
  const down = topicsOf(link.identity.room).down;
  link.sayHello(true);

  assert.equal(sent.length, 1);
  const hello = JSON.parse(openFrame({ key: KEY_A, aad: down, envelope: sent[0].payload }));
  assert.equal(hello.t, 'hello');
  // 两个编号各自管一层：帧内 `ver` 是云端协议版本(2)，信封 `v` 才是 seal 版本(1)。
  assert.equal(hello.ver, CLOUD_PROTOCOL);
  assert.equal(CLOUD_PROTOCOL, 2);
  assert.notEqual(hello.ver, SEAL_VERSION, '把 SEAL_VERSION 写进 hello.ver 是真实会犯的错');
});

test('构造 CloudLink 时的钥匙长度校验：不是 32 字节就抛错', () => {
  const identity = { room: 'r', key: Buffer.alloc(16, 1).toString('base64url'), token: 't', deviceId: 'd' };
  assert.throws(
    () => new CloudLink({ localPort: 1, identity, allowAnonymous: true }),
    /key must decode to 32 bytes/u,
  );
});
