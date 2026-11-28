/**
 * 下行分片重组表的行为测试（A6）。
 *
 * 事故形态：`PART_MAX_OPEN`（8）个半包占满之后，旧实现对新来的分片直接
 * `return null` —— 新片被丢掉，它的兄弟片还在路上，于是这条大响应永远拼不齐，
 * 只能干等 30 秒 TTL 清掉旧半包。窗口期内**所有 >64 KiB 的响应都被静默丢弃**
 * （任务列表、会话 detail 都是这个量级），界面上就是"点进去一直转圈"。
 *
 * 这里直接喂分片帧、断言"谁留下、谁被淘汰、拼出来的字节对不对"，而不是
 * 对 `remote.js` 里的 `collectPart` 做正则断言。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PART_MAX_OPEN, PartTable, parsePartFrame } from '../../web/lib/shell-parts.js';

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

/** 12 位小写十六进制 id（桌面用 `randomBytes(6).toString('hex')`）。 */
const idOf = (index) => index.toString(16).padStart(12, '0');

/** 一条分片帧。 */
const part = (id, seq, total, text) => ({ t: 'part', id, seq, total, d: b64(text) });

/** 一条"永远拼不完"的响应：total=2，只给第 0 片。 */
const openGroup = (id) => part(id, 0, 2, `{"dead":"${id}`);

/** 一条能被拼完的响应：`{"id":"<id>"}` 切成两片。 */
function completeGroup(id) {
  return [part(id, 0, 2, `{"id":"${id}`), part(id, 1, 2, '"}')];
}

test('A6：表满时淘汰最旧的半包，新来的分片必须被接受（旧实现会丢掉新片）', () => {
  let clock = 0;
  const table = new PartTable({ now: () => (clock += 1) });
  for (let index = 0; index < PART_MAX_OPEN; index += 1) {
    assert.equal(table.add(openGroup(idOf(index))).kind, 'incomplete');
  }
  assert.equal(table.size, PART_MAX_OPEN);

  const result = table.add(openGroup('cccccccccccc'));
  assert.equal(result.kind, 'incomplete', '新分组必须被接受并开始累积');
  assert.deepEqual(result.evicted, [idOf(0)], '被淘汰的应该是最久没有动静的那一组');
  assert.equal(table.size, PART_MAX_OPEN, '表大小仍然受上限约束');
  assert.equal(table.dropped, 1);

  // 新组真的在表里：补上第二片就能拼出来，说明第一片没被丢弃
  const done = table.add(part('cccccccccccc', 1, 2, '"}'));
  assert.equal(done.kind, 'complete');
  assert.deepEqual(done.value, { dead: 'cccccccccccc' });
});

test('A6：淘汰按"最近一次活动"而不是插入顺序（刚收到过一片的旧组是热的）', () => {
  let clock = 0;
  const table = new PartTable({ now: () => (clock += 1), maxOpen: 3 });
  // 每组 total=3：能"摸一下"而不拼完
  const frames = [
    ['aaaaaaaaaaaa', 0, '{"a":'],
    ['bbbbbbbbbbbb', 0, '{"b":'],
    ['dddddddddddd', 0, '{"d":'],
  ];
  for (const [id, seq, text] of frames) table.add(part(id, seq, 3, text));
  // 摸一下 aaaaaaaaaaaa（它插入最早，但现在是最新的活动）
  table.add(part('aaaaaaaaaaaa', 1, 3, '1'));
  // 再来一组：该被淘汰的是 bbbbbbbbbbbb（活动最久远），不是 aaaaaaaaaaaa
  const result = table.add(part('eeeeeeeeeeee', 0, 3, '{"e":'));
  assert.deepEqual(result.evicted, ['bbbbbbbbbbbb']);
});

test('A6：被淘汰那组的后续分片拼不出"半条"——它会重新开一组', () => {
  let clock = 0;
  const table = new PartTable({ now: () => (clock += 1), maxOpen: 1 });
  table.add(part('aaaaaaaaaaaa', 0, 2, '{"a":'));
  // 第二组把第一组挤掉
  const evicted = table.add(part('bbbbbbbbbbbb', 0, 2, '{"b":'));
  assert.deepEqual(evicted.evicted, ['aaaaaaaaaaaa']);
  // 旧组迟到的第二片：不能和已被淘汰的第一片拼在一起
  const late = table.add(part('aaaaaaaaaaaa', 1, 2, '1}'));
  assert.equal(late.kind, 'incomplete', '迟到的片只能开一组新的，不能拼出半个 JSON');
  // maxOpen=1：开新组的同时又挤掉了最近那一组，所以表里始终只有一组。
  assert.deepEqual(late.evicted, ['bbbbbbbbbbbb']);
  assert.equal(table.size, 1);
});

test('A6：超时的半包会被清掉（TTL 仍然生效）', () => {
  let clock = 0;
  const table = new PartTable({ now: () => (clock += 1), maxOpen: 2, ttlMs: 10 });
  table.add(openGroup('aaaaaaaaaaaa'));
  clock += 100; // 越过 TTL
  table.add(openGroup('bbbbbbbbbbbb'));
  assert.equal(table.size, 1, '过期的半包不该继续占位置');
  assert.equal(table.dropped, 0, 'TTL 清理不是"被迫淘汰"，不该计入诊断');
});

test('A6：坏帧一律不走表（id / seq / total / 大小都会被拒）', () => {
  const table = new PartTable();
  const bad = [
    null,
    { t: 'part' },
    { t: 'part', id: 'nope', seq: 0, total: 1, d: b64('x') },
    { t: 'part', id: 'aaaaaaaaaaaa', seq: 0, total: 0, d: b64('x') },
    { t: 'part', id: 'aaaaaaaaaaaa', seq: 2, total: 2, d: b64('x') },
    { t: 'part', id: 'aaaaaaaaaaaa', seq: 0, total: 2, d: 42 },
  ];
  for (const message of bad) {
    const result = table.add(message);
    assert.equal(result.kind, 'invalid', `${JSON.stringify(message)} 不该进表`);
    assert.deepEqual(result.evicted, []);
  }
  assert.equal(table.size, 0);
  // total 与已在拼的不一致：不能把两代响应混在一起
  table.add(part('aaaaaaaaaaaa', 0, 2, '{"a":'));
  const conflict = table.add(part('aaaaaaaaaaaa', 1, 3, '1'));
  assert.equal(conflict.kind, 'invalid');
});

test('parsePartFrame：合法帧给出 id / seq / total / 字节，超长片直接拒', () => {
  const parsed = parsePartFrame(part('aaaaaaaaaaaa', 1, 3, 'hello'));
  assert.equal(parsed.id, 'aaaaaaaaaaaa');
  assert.equal(parsed.seq, 1);
  assert.equal(parsed.total, 3);
  assert.equal(Buffer.from(parsed.chunk).toString('utf8'), 'hello');

  // 单片明文上限之外的分片不接（给一个比 maxFrame/3*4 更长的 base64）
  const huge = 'A'.repeat(Math.ceil((64 * 1024) / 3) * 4 + 8);
  assert.equal(parsePartFrame({ t: 'part', id: 'aaaaaaaaaaaa', seq: 0, total: 2, d: huge }), null);
  assert.equal(parsePartFrame(part('aaaaaaaaaaaa', 0, 2, 'x'), { maxTotal: 0 }), null);
});

/* ----------------- 组记录里的 rid（C1 的纯逻辑那一半） ----------------- */

test('C1：组记录必须保存 rid（= 被拆那一帧的 request id），后到的片也能补上', () => {
  let clock = 0;
  const table = new PartTable({ now: () => (clock += 1) });
  const withRid = (id, seq, total, text, rid) => ({ t: 'part', id, seq, total, d: b64(text), rid });
  // 第 0 片带 rid：第一片就记下来。
  table.add(withRid('aaaaaaaaaaaa', 0, 3, '{"a":', '0123456789abcdef'));
  assert.equal(table.incomplete()[0].rid, '0123456789abcdef', '组记录要带上 rid');
  assert.equal(table.ridOf('aaaaaaaaaaaa'), '0123456789abcdef', '被淘汰/过期之前要能按 chunkId 查回 rid');
  // 后续片没带 rid：不能把已知的 rid 擦成空（片是同一组，rid 只有一份）。
  table.add({ t: 'part', id: 'aaaaaaaaaaaa', seq: 1, total: 3, d: b64('1') });
  assert.equal(table.ridOf('aaaaaaaaaaaa'), '0123456789abcdef');
  // 老桌面的帧（没有 rid）：`ridOf` 给空串，上层据此退回启发式。
  table.add(part('cccccccccccc', 0, 2, '{"c":'));
  assert.equal(table.ridOf('cccccccccccc'), '', '老桌面没有 rid：必须是空串，不能编造');
  assert.equal(table.ridOf('nosuchgroup'), '', '查不到也要给空串（不许抛）');
  // 认不出的 rid 只当"没给"，不许因此把整组分片丢掉。
  table.add({ t: 'part', id: 'dddddddddddd', seq: 0, total: 2, d: b64('{"d":'), rid: { evil: true } });
  assert.equal(table.ridOf('dddddddddddd'), '', 'rid 畸形不该拒帧，只当没给');
  assert.equal(table.size, 3, '三组都还在表里（畸形 rid 没有把新组拒之门外）');
});

test('C1/C2：oldestRid 按「创建时刻」挑最老的那一组（并支持只在给定的几组里挑）', () => {
  let clock = 1_000;
  const table = new PartTable({ now: () => clock });
  const withRid = (id, rid, seq = 0, total = 3) => ({ t: 'part', id, seq, total, d: b64('{"x":'), rid });
  table.add(withRid('aaaaaaaaaaaa', 'rid-oldest'));
  clock += 10;
  table.add(withRid('bbbbbbbbbbbb', 'rid-newer'));
  assert.equal(table.oldestRid(), 'rid-oldest', '默认在全表里挑最老的');
  assert.equal(table.oldestRid(['bbbbbbbbbbbb']), 'rid-newer', '限定范围时只看给定那几组');
  assert.equal(table.oldestRid(['nosuchgroup']), '', '挑不出就给空串（上层退回启发式）');
  // `at` 被新片刷新过也不影响"谁最老"：判据是 createdAt。
  clock += 1_000;
  table.add({ t: 'part', id: 'aaaaaaaaaaaa', seq: 1, total: 3, d: b64('1') });
  assert.equal(table.oldestRid(), 'rid-oldest', '刚收到过新片的组仍然可能是"最老的那组"');
  // 老桌面（没有 rid）：整表都没有可用 rid。
  const bare = new PartTable();
  bare.add({ t: 'part', id: 'eeeeeeeeeeee', seq: 0, total: 2, d: b64('{"e":') });
  assert.equal(bare.oldestRid(), '');
});

test('C1：淘汰/过期要连 rid 一起交回（组一删就从表里查不到了）', () => {
  // ① TTL 过期：`expired` 仍是 chunkId 列表，`expiredRids` 按位置一一对应。
  let clock = 0;
  const expiring = new PartTable({ now: () => (clock += 1), maxOpen: 4, ttlMs: 5 });
  expiring.add({ t: 'part', id: 'aaaaaaaaaaaa', seq: 0, total: 2, d: b64('{"a":'), rid: 'rid-a' });
  clock += 100;
  const expired = expiring.add({ t: 'part', id: 'bbbbbbbbbbbb', seq: 0, total: 2, d: b64('{"b":'), rid: 'rid-b' });
  assert.deepEqual(expired.expired, ['aaaaaaaaaaaa'], 'expired 仍是 chunkId 列表（既有门禁靠它）');
  assert.deepEqual(expired.expiredRids, ['rid-a'], '同一批组的 rid 必须一一对应地交回');
  // ② 被迫淘汰（表满）：同样要把被淘汰那组的 rid 交回。
  let tick = 0;
  const full = new PartTable({ now: () => (tick += 1), maxOpen: 2, ttlMs: 60_000 });
  full.add({ t: 'part', id: 'cccccccccccc', seq: 0, total: 2, d: b64('{"c":'), rid: 'rid-c' });
  full.add({ t: 'part', id: 'dddddddddddd', seq: 0, total: 2, d: b64('{"d":'), rid: 'rid-d' });
  const evicted = full.add({ t: 'part', id: 'eeeeeeeeeeee', seq: 0, total: 2, d: b64('{"e":'), rid: 'rid-e' });
  assert.deepEqual(evicted.evicted, ['cccccccccccc']);
  assert.deepEqual(evicted.evictedRids, ['rid-c']);
});
