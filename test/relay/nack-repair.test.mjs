/**
 * 「分片丢失可修复」—— `lib/cloud.mjs` 的下行分片组缓存（`rememberPartGroup` /
 * `sweepPartCache`）与 `nack` 修复（`handleNack`）。
 *
 * 修的故障：`publish()` 把大帧拆成 `part` 片逐片 `publishSealed()`，而重发**只在
 * PUBACK 报错时**触发。broker 收下、订阅方却没收到（真实会发生的丢法）时，桌面侧
 * 的 `publishRetries / publishLost / errors` 全是 0，也不回 `reject` —— 手机端只能
 * 等满 30 s 分片 TTL，或者等 8 s 心跳用同 id 重发触发幂等回放。生产统计
 * `replays=43 / rx=94` 就是这个静默丢失的指纹。
 *
 * 协议（两端共用）：上行 `{ t:'nack', id:<chunkId>, sid, seq, ts }`；桌面若该组仍在
 * 短期缓存里就重发**全部**片，否则回 `{ t:'reject', id, code:'part-gone' }`。
 * 手机侧在本文件里用 `makePeer()` 的镜像 CloudLink 真实模拟（同一把钥匙、反向主题）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeAll, feed, makeLink, makePeer } from './_support/fixtures.mjs';

/** 手机端每个页面实例一个 sid；形状必须是 8~32 位小写 hex（见 checkFreshness）。 */
const SID = 'a1b2c3d4';

/**
 * 一条一定会被拆成**两片**的响应（明文 100 KiB / MAX_FRAME = 64 KiB）。
 * 第二片只占几十 KB，却决定整条详情能不能送达 —— 这就是线上最容易丢的那一片。
 */
function twoPart(id) {
  return {
    t: 'res',
    id,
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    enc: '',
    body: 'z'.repeat(100 * 1024),
    ms: 12,
  };
}

/** 手机端发出的 nack 帧（seq 必须单调递增，ts 必须新鲜）。 */
function nackFor(chunkId, { seq = 1, ts = Date.now(), sid = SID } = {}) {
  return { t: 'nack', id: chunkId, sid, seq, ts };
}

/** 手机侧镜像：把下行 payload 喂给同钥匙、反向主题的 CloudLink，看它拼出什么。 */
function phone(link) {
  const { peer, seen } = makePeer(link);
  return {
    peer,
    seen,
    receive(payload) { peer.onFrame(Buffer.from(payload)); },
  };
}

/** 发一条响应并返回它的 chunkId（顺带清掉 `sent`，只留这一组）。 */
function publishGroup(link, sent, id) {
  sent.length = 0;
  assert.equal(link.publish(twoPart(id)), true);
  const frames = decodeAll(link, sent);
  assert.equal(frames.length, 2, `夹具前提：这条响应必须正好两片，实际 ${frames.length}`);
  assert.equal(frames[0].t, 'part');
  assert.equal(frames[0].total, 2);
  assert.equal(frames[0].seq, 0);
  assert.equal(frames[1].seq, 1);
  assert.equal(frames[1].id, frames[0].id, '同一组共用一个 chunkId');
  return frames[0].id;
}

/* ------------------------------ 1. 主用例 ------------------------------- */

test('NACK：故意丢弃第 2 片，nack 之后手机侧能把整帧集齐', () => {
  const { link, sent } = makeLink({ allowAnonymous: true });
  const mobile = phone(link);

  const original = twoPart('detail-1');
  const chunkId = publishGroup(link, sent, 'detail-1');

  // 只把第 1 片交到手机手里：第 2 片「broker 收下但订阅方没收到」。
  mobile.receive(sent[0].payload);
  assert.equal(mobile.seen.length, 0, '缺一片时必须拼不出来');
  assert.equal(mobile.peer.parts.size, 1, '手机侧应当停在半包');

  // 桌面侧对这次丢失**完全无感知**（PUBACK 是成功的）——这就是静默丢失的定义。
  assert.equal(link.stats.publishRetries, 0);
  assert.equal(link.stats.publishLost, 0);
  assert.equal(link.stats.errors, 0);

  // 手机发现半包超过阈值，发一条 nack。
  feed(link, nackFor(chunkId));
  assert.equal(sent.length, 4, `nack 之后必须把整组的 2 片重发一遍，实际多发了 ${sent.length - 2} 条`);
  const resent = decodeAll(link, sent.slice(2));
  assert.deepEqual(resent.map((frame) => frame.seq), [0, 1],
    '重发的是**全部**片：nack 只带 chunkId，手机不知道丢的是哪一片');
  assert.ok(resent.every((frame) => frame.t === 'part' && frame.id === chunkId && frame.total === 2),
    '重发的每一帧都必须属于原分片组');
  assert.equal(link.stats.nackRepairs, 1, '修复次数要计数（status() 里能读到）');

  for (const entry of sent.slice(2)) mobile.receive(entry.payload);
  assert.equal(mobile.seen.length, 1, '补片之后整帧必须能拼出来并派发（旧代码这里永远等 30 s TTL）');
  assert.equal(mobile.seen[0].id, 'detail-1');
  assert.equal(mobile.seen[0].body, original.body, '拼回来的 body 必须逐字符一致');
  assert.equal(mobile.peer.parts.size, 0, '拼完之后不能留下半包');
});

/* ------------------------------ 2. 限流 -------------------------------- */

test('NACK 限流：同一 chunkId 连发 10 次只重发一次，其余计入 nackDropped', () => {
  const { link, sent } = makeLink();
  const chunkId = publishGroup(link, sent, 'detail-2');

  for (let seq = 1; seq <= 10; seq += 1) feed(link, nackFor(chunkId, { seq }));
  assert.equal(sent.length, 4, `5 秒内只许修一次（2 原片 + 2 重发片），实际 ${sent.length} 条`);
  assert.equal(link.stats.nackRepairs, 1);
  assert.equal(link.stats.nackDropped, 9, '被丢弃的 9 条都要计数');
});

test('NACK 限流：全局每秒最多 10 次重发（超限丢弃，不把桌面变成放大器）', () => {
  const { link, sent } = makeLink();
  const ids = [];
  for (let index = 0; index < 15; index += 1) ids.push(publishGroup(link, sent, `burst-${index}`));
  assert.equal(new Set(ids).size, 15, '15 组各自一个 chunkId');

  // 15 条 nack 全部落在同一个 1 s 窗口里：全局预算只有 10 次。
  sent.length = 0;
  for (let index = 0; index < ids.length; index += 1) {
    feed(link, nackFor(ids[index], { seq: index + 1 }));
  }
  assert.equal(link.stats.nackRepairs, 10, '全局每秒只放行 10 次重发');
  assert.equal(link.stats.nackDropped, 5);
  assert.equal(sent.length, 20, `10 组 × 2 片；超限的一条都不许发（实际 ${sent.length} 条）`);
});

/* ------------------------- 3. 鉴权 / 新鲜度闸 -------------------------- */

test('NACK 闸门：未授权 / 陈旧 ts / seq 回退的 nack 不重发、不抛错', () => {
  // ① 未授权：持钥不等于有权限，而重发是纯下行放大动作。
  const unauthAuth = { enabled: true, check: () => null, info: () => ({ enabled: true }) };
  const {
    link: unauthed, sent: unauthedSent,
  } = makeLink({ auth: unauthAuth, allowAnonymous: false });
  const unauthId = publishGroup(unauthed, unauthedSent, 'detail-3a');
  unauthedSent.length = 0;
  assert.doesNotThrow(() => feed(unauthed, nackFor(unauthId)));
  assert.equal(unauthedSent.length, 0, '未授权的 nack 一条都不许重发');
  assert.equal(unauthed.stats.nackRepairs, 0);
  assert.equal(unauthed.stats.unauthorized, 1, '要按未授权计数，但日志里不许出现令牌');
  assert.equal(unauthed.partCache.has(unauthId), true, '拒绝时也不能泄露/清掉缓存里的组');

  // ② 陈旧 ts：从公共 broker 上录下来的 nack 不许十分钟后仍然好用。
  const { link: stale, sent: staleSent } = makeLink();
  const staleId = publishGroup(stale, staleSent, 'detail-3b');
  staleSent.length = 0;
  assert.doesNotThrow(() => feed(stale, nackFor(staleId, { ts: Date.now() - 10 * 60 * 1000 })));
  assert.equal(staleSent.length, 0, '过期 nack 不许重发');
  assert.equal(stale.stats.nackRepairs, 0);
  assert.equal(stale.stats.stale, 1);

  // ③ seq 回退 / 重放：同 sid 内 seq 不增的第二条 nack 判重放，不许重发。
  const { link: rolled, sent: rolledSent } = makeLink();
  const idA = publishGroup(rolled, rolledSent, 'detail-3c');
  feed(rolled, nackFor(idA, { seq: 5 }));
  assert.equal(rolled.stats.nackRepairs, 1, '第一条合法的 nack 应当修一组');
  rolledSent.length = 0;
  // 同一条 nack 被原样重放（seq=5 没有增长）：新鲜度闸判 replay。
  assert.doesNotThrow(() => feed(rolled, nackFor(idA, { seq: 5 })));
  assert.equal(rolledSent.length, 0, '重放的 nack 不许重发');
  assert.equal(rolled.stats.nackRepairs, 1, '重发次数不许增长');
  assert.equal(rolled.stats.stale, 1);
  // 真回退到 4 的那种帧：新鲜度闸的「自愈」会放行一次（replay-gate.test.mjs 钉住的
  // 既有语义，这里不改），但重发仍被「同组 5 s 一次」挡死 —— 放大面没有变大。
  assert.doesNotThrow(() => feed(rolled, nackFor(idA, { seq: 4 })));
  assert.equal(rolledSent.length, 0, '被自愈放行的低 seq 也必须被节流挡住');
  assert.equal(rolled.stats.nackRepairs, 1);
  assert.equal(rolled.stats.nackDropped, 1);
});

/* --------------------------- 4. 淘汰后 part-gone ----------------------- */

test('NACK：组已被淘汰 → 回 part-gone，并计入 stats.partGone', () => {
  const { link, sent } = makeLink();
  const chunkId = publishGroup(link, sent, 'detail-4');

  // 走真实回收路径：把时间戳推到 TTL 之外，再跑一次 sweep()。
  const entry = link.partCache.get(chunkId);
  assert.notEqual(entry, undefined, '刚发布的分片组必须在缓存里');
  entry.at = Date.now() - 121_000;
  link.sweep();
  assert.equal(link.partCache.has(chunkId), false, '超过 120 s 的组必须被 sweep() 回收');
  assert.equal(link.partCacheBytes, 0, '字节账要跟着减掉');

  sent.length = 0;
  feed(link, nackFor(chunkId));
  assert.equal(link.stats.partGone, 1);
  assert.equal(link.stats.nackRepairs, 0, '组没了就不能假装修好');
  assert.equal(sent.length, 1, '必须回一条明确的 part-gone，而不是静默丢弃');
  const reply = decodeAll(link, sent)[0];
  assert.equal(reply.t, 'reject');
  assert.equal(reply.id, chunkId, 'id 必须原样回显，手机靠它对上自己的分片组');
  assert.equal(reply.code, 'part-gone');
});

/* ----------------------------- 5. 缓存上限 ----------------------------- */

test('NACK 缓存上限：超过 32 组后淘汰最旧的，字节有界且账目自洽', () => {
  const { link, sent } = makeLink();
  const ids = [];
  for (let index = 0; index < 40; index += 1) ids.push(publishGroup(link, sent, `cache-${index}`));

  assert.equal(link.partCache.size, 32, `组数必须被 32 收口，实际 ${link.partCache.size}`);
  assert.equal(link.partCache.has(ids[0]), false, '最旧的一组必须被淘汰');
  assert.equal(link.partCache.has(ids[7]), false, '淘汰按「最旧」推进，不是随机挑');
  assert.equal(link.partCache.has(ids[8]), true, '留下的应当是最近 32 组');
  assert.equal(link.partCache.has(ids[39]), true, '最新的一组必须在（不许把刚到的挤掉）');

  let sum = 0;
  for (const cached of link.partCache.values()) sum += cached.bytes;
  assert.equal(link.partCacheBytes, sum, '字节账必须与缓存内容一致');
  assert.ok(link.partCacheBytes <= 8 * 1024 * 1024, `字节必须 ≤ 8 MiB，实际 ${link.partCacheBytes}`);

  // 被淘汰的那一组再 nack：只能拿到 part-gone（对端据此走原有整请求重试）。
  sent.length = 0;
  feed(link, nackFor(ids[0]));
  assert.equal(link.stats.partGone, 1);
  assert.equal(link.stats.nackRepairs, 0);
  assert.equal(decodeAll(link, sent)[0]?.code, 'part-gone');
});

/* --------------------------- 6. 向后兼容 ------------------------------- */

test('兼容：未知帧与畸形 nack 一律忽略——不抛错、不重发、不断链', () => {
  const { link, sent } = makeLink();
  const chunkId = publishGroup(link, sent, 'detail-6');
  sent.length = 0;

  // 老桌面/新桌面都必须忽略不认识的帧（老手机不发 nack，协议只在两侧都升级后生效）。
  assert.doesNotThrow(() => feed(link, { t: 'frame-from-the-future', id: chunkId }));
  // id 形状不对的 nack：不进缓存表，也不许触发重发。
  assert.doesNotThrow(() => feed(link, { t: 'nack', id: 'NOT-A-CHUNK', sid: SID, seq: 1, ts: Date.now() }));
  // 缺 seq/sid/ts 的 nack：被判 bad-seq，静默丢弃。
  assert.doesNotThrow(() => feed(link, { t: 'nack', id: chunkId }));

  assert.equal(sent.length, 0, '没有任何一条畸形帧能换到重发');
  assert.equal(link.stats.nackRepairs, 0);
  assert.equal(link.stats.nackDropped, 1, 'id 形状不对的 nack 计入 nackDropped');
  assert.equal(link.stats.stale, 1, '缺 seq/sid/ts 的 nack 走新鲜度闸');
  assert.equal(link.state, 'online', '收到不认识的帧不许断开链路');
  assert.notEqual(link.client, undefined);
});
