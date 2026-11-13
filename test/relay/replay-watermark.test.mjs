/**
 * 重放闸的水位不可下调（R1）—— `lib/cloud.mjs` 的 `checkFreshness` / `sweepSeq`。
 *
 * 旧实现的自愈分支这么写：
 *
 *     if (fresh) this.lastSeq.set(key, { seq, at: now });   // 水位被降到 seq
 *
 * 于是攻击者只要重放**一条** seq≤64 的旧帧（ts 在 10 s 的 REHEAL_FRESH_MS 内
 * 就够，重放不需要钥匙、只需要能往主题里丢密文），水位就被拉到低位；接着按升序
 * 重放整段录制窗口，`seq > 水位` 全部走正常路径 —— 已经执行过的帧被二次执行
 * （写操作就是重复副作用）。
 *
 * 现在的语义：
 *  1. 水位**单调不减**：自愈只放行这一帧，`entry.seq` 不动（只刷新 `at` 保活）；
 *  2. 每个被自愈放行的 seq 记进 `healedSeq`，同一 (type, sid, seq) 第二次到达
 *     直接 `{ ok:false, code:'replay' }`；
 *  3. 计数器被重置的客户端从 1 开始发（seq=1,2,3… ≤64）依旧全部放行 —— 这是
 *     当初加自愈的原因，不能修回去；
 *  4. `sweepSeq()` 一并清理 `healedSeq`，不会只增不减。
 *
 * 残留（有意保留，不能靠单测消除）：每个 key 仍有 seq ≤ 64 的"宽限"，其中每个
 * **不同** seq 都能被放行一次 —— 因为"重置计数器的客户端"和"重放旧帧的人"在
 * 协议层不可区分（两者都是新鲜 ts + 低 seq）。所以自愈只能做到"有界 + 每条一次"：
 * 水位不动之后，录制窗口里 seq > 64 的帧全部作废，可用面从整段窗口缩到 64 帧。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REHEAL_FRESH_MS, STALE_WINDOW_MS } from '../../lib/cloud.mjs';
import { decodeAll, feed, makeLink, stubFetch } from './_support/fixtures.mjs';

const SID = 'f00dbabe';

/** 造一个 req 明文帧（手机方向）。 */
function req(overrides = {}) {
  return {
    t: 'req',
    id: 'req-under-test',
    seq: 1,
    ts: Date.now(),
    sid: SID,
    path: '/api/v1/health',
    method: 'GET',
    ...overrides,
  };
}

/** 直接把水位推到 `seq`（走真实 checkFreshness，不手改内部状态）。 */
function raiseWatermark(link, seq, sid = SID, type = 'req') {
  const now = Date.now();
  for (let value = 1; value <= seq; value += 1) {
    const result = link.checkFreshness(type, { seq: value, ts: now, sid });
    assert.equal(result.ok, true, `推进水位时 seq=${value} 不该被拒`);
  }
}

test('水位不可下调：自愈放行后 entry.seq 保持原值', () => {
  const { link } = makeLink();
  const now = Date.now();
  raiseWatermark(link, 200);
  assert.equal(link.lastSeq.get(`req:${SID}`)?.seq, 200);

  // 客户端计数器被重置（新鲜、seq 很小、低于水位）⇒ 自愈放行这一帧
  assert.equal(link.checkFreshness('req', { seq: 7, ts: now, sid: SID }).ok, true, '低 seq 的首次到达应放行');

  assert.equal(link.lastSeq.get(`req:${SID}`)?.seq, 200, '自愈**不许**把水位从 200 降到 7');
});

test('同一低 seq 帧第二次到达必须被拒（自愈只放行一次）', () => {
  const { link } = makeLink();
  const now = Date.now();
  raiseWatermark(link, 200);

  const frame = { seq: 9, ts: now, sid: SID };
  assert.equal(link.checkFreshness('req', frame).ok, true, '第一次：计数器重置，放行');
  const again = link.checkFreshness('req', frame);
  assert.equal(again.ok, false, '同一条 seq 第二次到达就是重放，不能执行');
  assert.equal(again.code, 'replay');
  assert.equal(again.seen, 200, '拒绝时要带回真实水位，便于日志定位');
});

test('端到端：重放一条低 seq 的旧帧，第二次必须被拒且请求不执行', async () => {
  const { link, sent } = makeLink();
  const stub = stubFetch();
  try {
    raiseWatermark(link, 200);
    const now = Date.now();
    sent.length = 0;

    feed(link, req({ id: 'replay-target', seq: 3, ts: now }));
    assert.equal(stub.calls.length, 1, '首次到达是"计数器重置"，要放行并执行');

    // 同一个 seq、不同 id：这次是录放，不是重置。
    feed(link, req({ id: 'replay-target-2', seq: 3, ts: now }));
    assert.equal(stub.calls.length, 1, '被拒的帧绝不能打到本机 API（写操作会重复副作用）');
    const rejects = decodeAll(link, sent).filter((message) => message.t === 'reject');
    assert.equal(rejects.at(-1)?.code, 'replay');
    assert.equal(rejects.at(-1)?.id, 'replay-target-2', 'reject 要带 id，手机才知道是哪条');
    assert.equal(link.lastSeq.get(`req:${SID}`)?.seq, 200, '水位始终保持在 200');
  } finally {
    stub.restore();
  }
});

test('攻击链被截断：水位拉低后，录制窗口里的高位旧帧全部被拒', () => {
  const { link } = makeLink();
  const now = Date.now();
  raiseWatermark(link, 500);

  // 第 1 步：重放一条 seq=2 的旧帧（新鲜 ts）—— 自愈会放行这一次。
  assert.equal(link.checkFreshness('req', { seq: 2, ts: now, sid: SID }).ok, true);
  // 同一条 seq 再到达一次就不再放行（自愈只给一次）。
  assert.equal(link.checkFreshness('req', { seq: 2, ts: now, sid: SID }).code, 'replay');

  // 第 2 步：按升序重放"录制窗口"里的旧帧。旧实现此时水位已被降到 2，
  // 这些帧（seq > 2）会走"正常递增"分支被二次执行；现在水位还是 500，
  // 而自愈只认 seq ≤ 64 的低 seq，所以它们一条都过不去。
  for (const seq of [100, 120, 499, 500]) {
    const result = link.checkFreshness('req', { seq, ts: now, sid: SID });
    assert.equal(result.ok, false, `seq=${seq} 是已执行过的旧帧，必须被拒`);
    assert.equal(result.code, 'replay');
  }
  // 宽限期是有界的：seq 一旦超过 64 就拿不到"计数器重置"的解释。
  assert.equal(link.checkFreshness('req', { seq: 65, ts: now, sid: SID }).code, 'replay');

  // 残留（有意为之，见文件头）：低于 64 的每个**不同** seq 仍可被放行一次 ——
  // 这是"重置计数器不能永久卡死"的必要代价。测试把它钉死，避免有人把宽限放大。
  assert.equal(link.checkFreshness('req', { seq: 3, ts: now, sid: SID }).ok, true, '低 seq 的首次到达仍走自愈');
  assert.equal(link.checkFreshness('req', { seq: 3, ts: now, sid: SID }).code, 'replay', '第二次到达判重放');

  assert.equal(link.lastSeq.get(`req:${SID}`)?.seq, 500, '水位纹丝不动');
});

test('计数器被重置的客户端：新 seq 序列（1,2,3…）仍然全部放行', () => {
  const { link } = makeLink();
  const now = Date.now();
  raiseWatermark(link, 300);

  // 重置后的客户端从 1 开始重新数：每一条都是"新的 seq"，都要放行。
  for (let seq = 1; seq <= 64; seq += 1) {
    const result = link.checkFreshness('req', { seq, ts: now, sid: SID });
    assert.equal(result.ok, true, `重置后的 seq=${seq} 不许被永久卡死`);
  }
  // 放行归放行，水位没有被这些低 seq 拖下来。
  assert.equal(link.lastSeq.get(`req:${SID}`)?.seq, 300);
});

test('自愈的水位是"每 key 独立"的：别的 sid / 别的 type 不受影响', () => {
  const { link } = makeLink();
  const now = Date.now();
  raiseWatermark(link, 120, SID, 'req');
  raiseWatermark(link, 30, 'aaaa1111', 'ws.msg');

  assert.equal(link.checkFreshness('req', { seq: 5, ts: now, sid: SID }).ok, true);
  assert.equal(link.healedSeq.get(`req:${SID}`)?.has(5), true);
  assert.equal(link.healedSeq.has('ws.msg:aaaa1111'), false, '别的 key 不该被写入自愈记录');
  assert.equal(link.checkFreshness('ws.msg', { seq: 5, ts: now, sid: 'aaaa1111' }).ok, true, '另一个 key 的 seq=5 是首次自愈');
});

test('sweepSeq 一并清理自愈记录（TTL 与硬上限）', () => {
  const { link } = makeLink();
  const now = Date.now();

  // 正常 key：水位与自愈记录都留着。
  link.lastSeq.set(`req:${SID}`, { seq: 200, at: now });
  link.healedSeq.set(`req:${SID}`, new Set([3, 4]));
  // 过期 key：水位被 TTL 清掉后，自愈记录不能变成孤儿。
  link.lastSeq.set('req:dead0001', { seq: 200, at: now - 11 * 60 * 1000 });
  link.healedSeq.set('req:dead0001', new Set([8]));

  link.sweepSeq(now);

  assert.equal(link.lastSeq.has('req:dead0001'), false);
  assert.equal(link.healedSeq.has('req:dead0001'), false, '水位没了，自愈记录必须一起清');
  assert.equal(link.healedSeq.get(`req:${SID}`)?.size, 2, '还在 TTL 内的自愈记录不许被误删');

  // 硬上限：海量新 sid 不许把两张表撑爆（SEQ_TABLE_MAX = 64）。
  for (let index = 0; index < 200; index += 1) {
    const key = `req:${index.toString(16).padStart(8, '0')}`;
    link.lastSeq.set(key, { seq: 100, at: now });
    link.healedSeq.set(key, new Set([1]));
  }
  link.sweepSeq(now);
  assert.ok(link.lastSeq.size <= 64, `水位表必须有硬上限（实际 ${link.lastSeq.size}）`);
  assert.ok(link.healedSeq.size <= 64, `自愈记录表必须有硬上限（实际 ${link.healedSeq.size}）`);
  // 自愈记录不许留下没有水位的孤儿 key。
  for (const key of link.healedSeq.keys()) {
    assert.equal(link.lastSeq.has(key), true, `孤儿自愈记录 ${key} 必须被清掉`);
  }
});

test('自愈只看 REHEAL_FRESH_MS 内的新鲜帧：陈旧低 seq 不触发自愈', () => {
  const { link } = makeLink();
  const now = Date.now();
  raiseWatermark(link, 100);

  // ts 超出新鲜窗口但仍在 STALE_WINDOW_MS 内：延迟重放的面，必须拒。
  const staleButInWindow = link.checkFreshness('req', { seq: 4, ts: now - REHEAL_FRESH_MS - 1_000, sid: SID });
  assert.equal(staleButInWindow.ok, false);
  assert.equal(staleButInWindow.code, 'replay');

  // 超出 STALE_WINDOW_MS：连新鲜度都不满足。
  const expired = link.checkFreshness('req', { seq: 4, ts: now - STALE_WINDOW_MS - 1, sid: SID });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'bad-ts');
  assert.equal(link.healedSeq.has(`req:${SID}`), false, '被拒的帧不许留下自愈记录');
});
