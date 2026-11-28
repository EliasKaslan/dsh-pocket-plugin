/**
 * 半包表的新职责：**发现丢片（NACK）** 与 **不再静默**。
 *
 * 事故根因（离线复现确认）：电脑端把 `res` 封帧后，`raw > 64 KiB` 就拆成 `part`
 * 发布；而 `publishSealed()` 的重发**只在 PUBACK 报错时触发** —— "broker 收下了
 * 但订阅方没收到"这种丢法它完全感知不到（`publishRetries/publishLost/errors` 全 0）。
 * 手机端拿到的半包只能干等：旧实现的 TTL 是 30 s，而请求预算（16 s/8 s）先到点，
 * 于是用户看到的是"等了半天，没有任何内容、也没有任何提示"。
 *
 * 修法两件（这个文件钉住纯逻辑那一半）：
 *   1. 半包卡住 `PART_STALL_MS`（2 s）就发 `nack` 指名补片；同一个 chunkId 两次
 *      之间至少隔 `PART_NACK_GAP_MS`（5 s），同时在途最多 `PART_NACK_MAX_OPEN`（4）组。
 *   2. 迟迟集不齐要能被**判定丢失**（`lost()`），交给上层把等它的请求送去自救/重试；
 *      TTL 清掉/被淘汰的组也要把 id 交回去（旧实现 `sweep()` 静默 `delete`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PART_LOST_MS, PART_MAX_OPEN, PART_NACK_GAP_MS, PART_NACK_MAX_OPEN, PART_STALL_MS, PART_TTL_MS, PartTable,
} from '../../web/lib/shell-parts.js';

const chunkId = (index) => index.toString(16).padStart(12, 'a');
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
/** 只带第 0 片的一帧（这一组永远拼不完）。 */
const openPart = (id, total = 2) => ({ t: 'part', id, seq: 0, total, d: b64('{"half":') });

/** 受控时钟的表：时间只由用例推进，不依赖真实 setTimeout。 */
function makeTable(overrides = {}) {
  let now = 1_700_000_000_000;
  const table = new PartTable({ now: () => now, ...overrides });
  return { table, advance: (ms) => { now += ms; return now; }, now: () => now };
}

test('卡住 2 秒才 NACK；同组 5 秒内不重复发；最多同时 4 组', () => {
  const { table, advance, now } = makeTable();
  table.add(openPart(chunkId(0)));
  assert.deepEqual(table.nackDue(now()), [], '刚到的组不该 NACK（分片之间正常是毫秒级）');
  advance(PART_STALL_MS - 1);
  assert.deepEqual(table.nackDue(now()), [], '不到 2 秒不许打扰对端');
  advance(1);
  assert.deepEqual(table.nackDue(now()), [chunkId(0)], '卡住 2 秒就该补片');
  // 发过之后要隔 gapMs 才允许再发
  table.markNacked(chunkId(0), now());
  assert.deepEqual(table.nackDue(now()), [], '刚发过就别重复发（弱网下会刷成上行风暴）');
  advance(PART_NACK_GAP_MS - 1);
  assert.deepEqual(table.nackDue(now()), []);
  advance(1);
  assert.deepEqual(table.nackDue(now()), [chunkId(0)], '隔够 5 秒可以再要一次');
  // 同时在途上限：再多组也只挑最老的 4 组
  for (let index = 1; index <= 6; index += 1) table.add(openPart(chunkId(index)));
  advance(PART_STALL_MS);
  const due = table.nackDue(now());
  assert.equal(due.length, PART_NACK_MAX_OPEN, `同时最多 ${PART_NACK_MAX_OPEN} 组`);
  assert.equal(due[0], chunkId(0), '最老的最先补（它最可能是用户正在等的那条大响应）');
});

test('有新片到达就重新计时：热的组不该被 NACK', () => {
  const { table, advance, now } = makeTable();
  table.add(openPart(chunkId(0), 3));
  advance(PART_STALL_MS - 100);
  table.add({ t: 'part', id: chunkId(0), seq: 1, total: 3, d: b64('"b":') });
  advance(200);
  assert.deepEqual(table.nackDue(now()), [], '刚刚来过新片，说明链路是通的');
  advance(PART_STALL_MS);
  assert.deepEqual(table.nackDue(now()), [chunkId(0)], '再静默 2 秒才该补片');
});

test('迟迟集不齐要能被判定丢失（交给上层自救/重试，而不是干等预算）', () => {
  const { table, advance, now } = makeTable();
  table.add(openPart(chunkId(0)));
  advance(PART_LOST_MS - 1);
  assert.deepEqual(table.lost(now()), [], '还没到 8 秒，可能只是慢');
  advance(1);
  assert.deepEqual(table.lost(now()), [chunkId(0)]);
  assert.equal(table.drop(chunkId(0)), true);
  assert.equal(table.size, 0, '判定丢失的组必须真的从表里删掉，否则永远占着位');
  assert.equal(table.drop(chunkId(0)), false, '重复 drop 不该有副作用');
});

test('TTL 清理要把被清掉的 id 交回去（旧实现是静默 delete）', () => {
  const { table, advance, now } = makeTable();
  table.add(openPart(chunkId(0)));
  table.add(openPart(chunkId(1)));
  advance(PART_TTL_MS - 1);
  const result = table.add(openPart(chunkId(2)));
  assert.deepEqual(result.expired, [], '还没到 TTL');
  advance(2);
  const gone = table.sweep(now());
  assert.deepEqual(gone.sort(), [chunkId(0), chunkId(1)].sort(), '过期的组要交回 id');
  assert.equal(table.expired, 2, 'TTL 过期单独计数（不是"被迫淘汰"）');
  assert.equal(table.dropped, 0, 'TTL 清理不算被迫淘汰（既有门禁钉着这条）');
});

test('C7：判失按「还没集齐多久」计时，不是「距最后一片」—— 每 7 s 来一片也必须被判失', () => {
  const { table, advance, now } = makeTable();
  // total=5，只补 seq 1..3：这一组永远差第 4 片（永远拼不完的最坏形态）。
  table.add(openPart(chunkId(0), 5));
  for (let step = 1; step <= 3; step += 1) {
    advance(PART_LOST_MS - 1_000); // 每次都在"判失"前一刻补一片，把 `at` 一直刷新
    table.add({ t: 'part', id: chunkId(0), seq: step, total: 5, d: b64('"x":') });
    if (step === 1) assert.deepEqual(table.lost(now()), [], `距创建才 ${PART_LOST_MS - 1_000}ms，还不到 ${PART_LOST_MS}ms`);
  }
  // 此刻距**最后一片**只有 0 ms，但距**开始拼**已经 21 s —— 旧实现按前者计时，
  // 于是这种组永远不会被判失：既不飞快地 `parts_lost`，还长期占着 8 个表位之一。
  assert.deepEqual(table.lost(now()), [chunkId(0)],
    '判失必须按 createdAt：否则"每 8 秒内来一片"的组永远判不失，请求只能干等 relay_timeout');
  // NACK 仍按最后活动时间：刚来过片，说明链路是通的，不该补片。
  assert.deepEqual(table.nackDue(now()), [], '刚收到过新片，不该 NACK');
  // 判失之后丢掉它，表位要回归。
  assert.equal(table.drop(chunkId(0)), true);
  assert.equal(table.size, 0);
});

test('incomplete()：缺哪几片要说得出来（诊断要能指出卡在哪）', () => {
  const { table, now } = makeTable();
  table.add(openPart(chunkId(0), 3));
  table.add({ t: 'part', id: chunkId(0), seq: 2, total: 3, d: b64('}') });
  const [group] = table.incomplete(now());
  assert.deepEqual(group.missing, [1], '第 1 片没到');
  assert.equal(group.total, 3);
  assert.equal(group.nacks, 0);
  assert.equal(table.size, 1);
  // 拼齐之后组会消失，不再出现在 incomplete 里
  table.add({ t: 'part', id: chunkId(0), seq: 1, total: 3, d: b64('"b":1') });
  assert.deepEqual(table.incomplete(now()), []);
  assert.ok(PART_MAX_OPEN >= PART_NACK_MAX_OPEN, '补片上限不能超过表容量（否则有一半永远 NACK 不到）');
});
