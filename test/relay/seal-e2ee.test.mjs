/**
 * 安全性质 1：AES-256-GCM 封装 / 解封（lib/cloud.mjs 的 seal/unseal，模块私有，
 * 只能通过真实的 `publish()` / `onFrame()` 触达）。
 *
 * 钉住两件事：
 *  - 同一份明文 → 密文 → 明文逐字节一致（真实代码封、真实代码解，双向）；
 *  - 任何一处被改（密文任意字节 / IV / 信封版本 / AAD / 方向 / 房间话题 / 钥匙）
 *    都必须**抛错**，绝不允许返回垃圾明文或留下半截状态。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEAL_VERSION } from '../../lib/cloud.mjs';
import { sealFrame } from '../_support/envelope.mjs';
import {
  CANARY, KEY, OTHER_KEY, decodeAll, decodeLast, feed, frameFor, identityFor, makeLink, makeLogger, makePeer, openAsPhone,
} from './_support/fixtures.mjs';

/** node 在 GCM 校验失败时抛的几种措辞（随 OpenSSL 版本不同）。 */
const AUTH_FAIL = /unable to authenticate|Unsupported state|bad decrypt/iu;
/** 信封结构本身不合法时的措辞（在进 GCM 之前就该拒）。 */
const BAD_ENVELOPE = /bad envelope/iu;
/** 任何「拒收」都算通过：GCM 校验失败、信封结构失败、或根本不是 JSON。 */
const ANY_REJECT = /unable to authenticate|Unsupported state|bad decrypt|bad envelope|JSON|Unexpected/iu;

const PLAINTEXT = {
  t: 'hello',
  name: CANARY,
  ver: 2,
  nested: { list: [1, 2, 3], text: '中文也要原样回来' },
};

function envelopeOf(payload) {
  return JSON.parse(String(payload));
}
function rebuild(envelope) {
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}
function flipBase64(base64, index = -1) {
  const buffer = Buffer.from(String(base64), 'base64');
  const at = index < 0 ? buffer.length + index : index;
  buffer[at] ^= 0x01;
  return buffer.toString('base64');
}

test('封装/解封往返：电脑 publish 的密文，用同一把钥匙能被真实 unseal 还原成逐字节相同的明文', () => {
  const { link, sent } = makeLink();
  const { peer, seen } = makePeer(link);

  assert.equal(link.publish(PLAINTEXT), true);
  assert.equal(sent.length, 1);

  // 对照：镜像解开（信封格式契约）。
  const opened = openAsPhone(link, sent[0].payload);
  assert.equal(opened.toString('utf8'), JSON.stringify(PLAINTEXT), '解出来的明文必须与封进去的逐字节一致');

  // 主证：真实 onFrame() 的 unseal + JSON.parse 还原出等价对象。
  peer.onFrame(Buffer.from(sent[0].payload, 'utf8'));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], PLAINTEXT);
  assert.equal(JSON.stringify(seen[0]), JSON.stringify(PLAINTEXT));
});

test('线上只有密文：payload 里不出现明文哨兵，IV 随机且为 12 字节，信封版本是 SEAL_VERSION', () => {
  const { link, sent } = makeLink();
  assert.equal(link.publish(PLAINTEXT), true);
  assert.equal(link.publish(PLAINTEXT), true);

  assert.ok(!sent[0].payload.includes(CANARY), 'MQTT payload 里出现明文 = E2EE 失效');
  assert.ok(!sent[0].payload.includes('中文也要原样回来'));

  const first = envelopeOf(sent[0].payload);
  const second = envelopeOf(sent[1].payload);
  assert.equal(first.v, SEAL_VERSION, '信封版本必须是 1');
  assert.equal(Buffer.from(first.n, 'base64').length, 12, 'GCM nonce 必须 12 字节');
  assert.notEqual(first.n, second.n, '同一份明文两次封装必须用不同 IV');
  assert.notEqual(first.c, second.c, 'IV 不同则密文不同');
  assert.ok(Buffer.from(first.c, 'base64').length > 16, '密文里必须含 16 字节 GCM tag');
});

test('篡改密文任意一个字节 → 解封失败（而不是返回垃圾）', () => {
  const { link, sent } = makeLink();
  link.publish(PLAINTEXT);
  const envelope = envelopeOf(sent[0].payload);
  const raw = Buffer.from(envelope.c, 'base64');
  // 首字节（数据）、中间、末字节（GCM tag）三处都试。
  const positions = [0, Math.floor(raw.length / 2), raw.length - 1];

  for (const position of positions) {
    const { link: victim } = makeLink();
    let dispatched = 0;
    victim.dispatch = () => { dispatched += 1; };

    const tampered = Buffer.from(JSON.stringify({
      ...envelope,
      c: flipBase64(envelope.c, position),
    }), 'utf8');

    assert.throws(() => victim.onFrame(tampered), ANY_REJECT, `第 ${position} 字节被改后仍然解开了`);
    assert.equal(dispatched, 0, '解封失败时绝不能把垃圾交给 dispatch');
    assert.equal(victim.stats.rx, 0);
    assert.equal(victim.phone, null);
  }
});

test('篡改 nonce/IV → 解封失败', () => {
  const { link, sent } = makeLink();
  link.publish(PLAINTEXT);
  const envelope = envelopeOf(sent[0].payload);
  const { link: victim } = makeLink();
  let dispatched = 0;
  victim.dispatch = () => { dispatched += 1; };

  assert.throws(() => victim.onFrame(rebuild({ ...envelope, n: flipBase64(envelope.n) })), ANY_REJECT);
  assert.equal(dispatched, 0);

  // 短 IV 在进 GCM 之前就该被结构检查拒掉。
  assert.throws(
    () => victim.onFrame(rebuild({ ...envelope, n: Buffer.alloc(8, 7).toString('base64') })),
    BAD_ENVELOPE,
  );
  assert.equal(dispatched, 0);
});

test('信封结构/版本被改 → 直接拒（v=2、只剩 tag、密文为空）', () => {
  const { link, sent } = makeLink();
  link.publish(PLAINTEXT);
  const envelope = envelopeOf(sent[0].payload);
  const { link: victim } = makeLink();
  const before = victim.stats.rx;

  assert.throws(() => victim.onFrame(rebuild({ ...envelope, v: 2 })), BAD_ENVELOPE);
  assert.throws(
    () => victim.onFrame(rebuild({ ...envelope, c: Buffer.from(Buffer.from(envelope.c, 'base64').subarray(0, 16)).toString('base64') })),
    BAD_ENVELOPE,
    '只有 tag 没有密文的信封必须拒',
  );
  assert.throws(() => victim.onFrame(rebuild({ ...envelope, c: '' })), BAD_ENVELOPE);
  assert.throws(() => victim.onFrame(Buffer.from('not json at all', 'utf8')), ANY_REJECT);
  // 空对象 / null 之类也不能被当成合法帧。
  assert.throws(() => victim.onFrame(Buffer.from('{}', 'utf8')), BAD_ENVELOPE);
  assert.equal(victim.stats.rx, before, '被拒的帧不能计入接收统计');
});

test('AAD 绑定：换房间话题、换方向、任意 AAD 都解不开', () => {
  const { link: alice } = makeLink({ identity: identityFor({ room: 'room-alice' }) });
  const { link: bob } = makeLink({ identity: identityFor({ room: 'room-bob' }) });
  const plaintext = JSON.stringify({ t: 'hello', name: 'from-alice-phone' });

  // 对照：本房间（AAD = alice 的 up 主题）能解开。
  const good = frameFor(alice, plaintext);
  const originalDispatch = alice.dispatch.bind(alice);
  let ok = 0;
  alice.dispatch = (message) => { ok += 1; originalDispatch(message); };
  alice.onFrame(good);
  assert.equal(ok, 1);
  assert.equal(alice.phone?.name, 'from-alice-phone');

  // 反例 1：换房间 → AAD 不同 → 不能把 alice 的录音重放进 bob 的房间。
  bob.dispatch = () => { throw new Error('bob 不该收到 alice 的帧'); };
  assert.throws(() => bob.onFrame(good), ANY_REJECT);
  assert.equal(bob.phone, null);

  // 反例 2：换方向（用 down 主题做 AAD 封一封，冒充上行）。
  const wrongDirection = Buffer.from(sealFrame({
    key: KEY, aad: alice.topics.down, plaintext,
  }), 'utf8');
  assert.throws(() => alice.onFrame(wrongDirection), ANY_REJECT);

  // 反例 3：随便挑一个 AAD（比如就写个 'x'）也不行。
  const wrongAad = Buffer.from(sealFrame({ key: KEY, aad: 'x', plaintext }), 'utf8');
  assert.throws(() => alice.onFrame(wrongAad), ANY_REJECT);
  assert.equal(alice.phone?.name, 'from-alice-phone', '失败的解封不能破坏已有状态');
});

test('错钥匙两个方向都解不开', () => {
  const { link, sent } = makeLink();
  const { link: stranger } = makeLink({ identity: identityFor({ key: OTHER_KEY }) });
  link.publish({ t: 'hello', name: CANARY });

  // 收方向：拿错钥匙封帧 → 真实 onFrame 必须抛错（victim 只有 0x5a 那把）。
  assert.throws(() => link.onFrame(frameFor(link, JSON.stringify({ t: 'hello' }), { key: OTHER_KEY })), AUTH_FAIL);
  // 发方向：我们的密文用错钥匙也解不开。
  assert.throws(() => openAsPhone(link, sent[0].payload, { key: OTHER_KEY }), AUTH_FAIL);
  // 用错钥匙的 link 收我们的帧：AAD 也许对，钥匙不对，必须失败。
  let dispatched = 0;
  stranger.dispatch = () => { dispatched += 1; };
  assert.throws(() => stranger.onFrame(Buffer.from(sent[0].payload, 'utf8')), ANY_REJECT);
  assert.equal(dispatched, 0);
});

test('合法帧仍能通过（正例对照）：hello 帧被接受、更新 phone 并回 hello + beat 两条密文', () => {
  const { link, sent } = makeLink();

  feed(link, { t: 'hello', name: 'Pixel 9', ver: 2 });
  assert.equal(link.phone?.name, 'Pixel 9');
  assert.equal(link.phone?.ver, 2);
  assert.equal(link.stats.rx, 1);
  assert.ok(link.stats.lastPhoneAt > 0);

  // hello 的自动应答：hello（10 s 限流）之后紧跟一条**即时 beat**，为的是不必等
  // 8 s 周期的定时器，手机侧横幅在 1 个 RTT 内就消失。两条都必须是密文。
  const answers = decodeAll(link, sent);
  assert.equal(answers.length, 2);
  assert.equal(answers[0].t, 'hello');
  assert.equal(answers[1].t, 'beat');
  assert.ok(answers[1].ts > 0);
  for (const entry of sent) assert.ok(!entry.payload.includes('Pixel 9'), '应答帧里泄露了明文昵称');

  // 防自激：beat 绝不能触发回复，否则双方互回会把公共 broker 打爆。
  feed(link, { t: 'beat', name: 'Pixel 9', ver: 2, ts: Date.now(), peers: 0 });
  assert.equal(sent.length, 2, 'beat 不许回声');
});
