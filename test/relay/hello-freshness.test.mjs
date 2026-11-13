/**
 * `hello` 的新鲜度与放大面（R7）—— `lib/cloud.mjs` 的 `dispatch` + `checkHelloFreshness`。
 *
 * 以前的 `hello` 分支既不做任何新鲜度判断，也不做应答限流：broker 上录下来的一条
 * hello 密文可以无限期重放，后果有两层 ——
 *  1. 每一帧都触发一次 `beat()` 上行（还有一次 `sayHello`），等于把一条 101 B 的
 *     密文放大成 N 倍上行，公共 broker 上直接触发限流，反过来静默丢掉真正的 RPC
 *     响应；
 *  2. `status.phone` / `lastPhoneAt` 被伪造成"手机还在线"，配对页与状态接口都会撒谎。
 *
 * 手机端的 hello 只带 `ts`（`remote/remote.js` 的 announce() 没有 seq/sid），所以
 * 闸门分两层：带 ts 必须在 STALE_WINDOW_MS 内；带齐 seq/sid 的新外壳再走完整
 * `checkFreshness`。beat 应答则与 `sayHello` 同档限流（HELLO_MIN_GAP_MS）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HELLO_MIN_GAP_MS, STALE_WINDOW_MS } from '../../lib/cloud.mjs';
import { decodeAll, feed, makeLink } from './_support/fixtures.mjs';

function hello(overrides = {}) {
  return { t: 'hello', name: 'Pixel 9', ver: 2, ts: Date.now(), ...overrides };
}

test('陈旧的 hello（超出 STALE_WINDOW_MS）→ 拒：不改手机状态、一条应答都不发', () => {
  const { link, sent } = makeLink();
  feed(link, hello({ name: '重放的手机', ts: Date.now() - STALE_WINDOW_MS - 5_000 }));

  assert.equal(link.phone, null, '陈旧 hello 不许把"手机在线"写进状态');
  assert.equal(link.stats.lastPhoneAt, 0);
  assert.deepEqual(decodeAll(link, sent), [], '被拒的 hello 不许触发 hello/beat 应答');
  assert.equal(link.stats.stale, 1);
  assert.equal(link.lastHelloAt, undefined, '被拒时连 hello 的限流窗口都不该被占用');
});

test('未来时间戳的 hello（时钟坏的客户端）同样被拒', () => {
  const { link, sent } = makeLink();
  feed(link, hello({ ts: Date.now() + STALE_WINDOW_MS + 5_000 }));
  assert.deepEqual(decodeAll(link, sent), []);
  assert.equal(link.phone, null);
});

test('新鲜 hello：记下手机状态并回一条 hello + 一条即时 beat', () => {
  const { link, sent } = makeLink();
  link.sockets.set('11111111', { readyState: 1, send() {}, close() {} });
  feed(link, hello({ name: 'Pixel 9' }));

  assert.equal(link.phone?.name, 'Pixel 9');
  assert.ok(link.stats.lastPhoneAt > 0);
  const answers = decodeAll(link, sent);
  assert.deepEqual(answers.map((message) => message.t), ['hello', 'beat']);
  assert.equal(answers[1].peers, 1);
});

test('同一秒内反复喂同一条 hello（重放）：最多只有第一帧有应答（放大面被限流）', () => {
  const { link, sent } = makeLink();
  const frame = hello({ name: 'Pixel 9' });
  const before = Date.now();

  for (let round = 0; round < 20; round += 1) feed(link, frame);

  const answers = decodeAll(link, sent);
  assert.equal(answers.filter((message) => message.t === 'hello').length, 1, 'hello 回声只许一条/10s');
  assert.equal(answers.filter((message) => message.t === 'beat').length, 1, 'beat 与 hello 同档限流，只许一条/10s');
  assert.ok(Date.now() - before < HELLO_MIN_GAP_MS, '这条用例本身就发生在同一个限流窗口内');
});

test('带 seq/sid 的 hello 走完整 checkFreshness：同一 seq 第二次到达判重放', () => {
  const { link } = makeLink();
  const frame = hello({ seq: 7, sid: 'abcd1234' });

  feed(link, frame);
  assert.equal(link.stats.stale, 0, '第一次是合法的新外壳 hello');
  assert.equal(link.lastSeq.get('hello:abcd1234')?.seq, 7);

  feed(link, frame);
  assert.equal(link.stats.stale, 1, '同一条 seq 第二次到达必须判重放');
});

test('没有 ts 的旧外壳 hello 保持兼容（仍回 hello + beat），但不计新鲜度', () => {
  const { link, sent } = makeLink();
  feed(link, { t: 'hello', name: 'OldShell', ver: 1 });
  assert.equal(link.phone?.name, 'OldShell', '旧外壳（真的没有 ts）不该被拒');
  assert.deepEqual(decodeAll(link, sent).map((message) => message.t), ['hello', 'beat']);
});
