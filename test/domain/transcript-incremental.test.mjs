/**
 * lib/task-index.mjs 的转录热路径：增量拼接、全量扫描硬上限、单飞。
 *
 * 三个缺陷都是"随使用时间线性恶化"的那一类，所以判据必须是**可量化的**：
 *   - 增量：同一会话追加 1 条事件后，构建只处理新增部分（`transcriptMeter` 计数），
 *     且结果与全量重建**逐字节相同**；
 *   - 上限：事件流超过上限时只返回尾部窗口，`truncated === true`，分页契约
 *     （`before` / `after` / `cursorLost` / `hasMore` / `nextBefore` / `limit`）照旧；
 *   - 单飞：同一 sessionId 并发两次只构建一次。
 *
 * 与 `task-index.test.mjs` 同一条线：纯内存宿主桩，不联网、不碰 ~/.dsh、
 * 临时目录统一在 os.tmpdir() 下清理。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildTranscriptAsync } from '../../lib/messages.mjs';
import { TaskIndex } from '../../lib/task-index.mjs';

const tmpRoot = path.join(tmpdir(), `dsh-pocket-transcript-${process.pid}-${Date.now()}`);
const indexes = [];
let dirSeq = 0;

async function makeHome() {
  dirSeq += 1;
  const home = path.join(tmpRoot, `home-${dirSeq}`);
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  return home;
}

function makeLogger() {
  const lines = [];
  const push = (level) => (...args) => {
    lines.push(`${level} ${args.map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.message;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' ')}`);
  };
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

async function makeIndex({ services = {}, config = {} } = {}) {
  const home = await makeHome();
  const logger = makeLogger();
  const index = new TaskIndex({
    logger,
    emit: () => {},
    state: { touchDevice() {} },
    config,
    services,
    home,
    dataDir: path.join(home, 'pocket'),
  });
  const ctx = { index, logger, home };
  indexes.push(ctx);
  return ctx;
}

/** live + running 的任务：宿主把整份事件流放在内存里（`sessions.get(id).log`）。 */
function liveTask(index, id) {
  const task = index.upsertRow({ header: { id, createdAt: 1, cwd: 'C:\\w' } });
  task.live = true;
  task.status = 'running';
  return task;
}

/**
 * 让运行中会话的转录缓存"过期"（TTL 是 800 ms，真实轮询就是这样跨过去的）。
 * 直接改条目的时间戳，比 sleep 810 ms 稳定得多。
 */
function expireTranscript(index, id) {
  const cached = index.transcripts.get(id);
  if (cached !== undefined) cached.at = 0;
}

/**
 * 5 类事件循环：user / assistant / tool-call / tool-result（折进上一条 call）/
 * turn-start。既覆盖"新消息"，也覆盖"折进已有消息"这条最容易拼错的路径。
 */
function makeEvent(seq) {
  const time = 1_000 + seq;
  switch (seq % 5) {
    case 1:
      return {
        type: 'user/message',
        seq,
        time,
        data: { id: `u-${seq}`, content: [{ type: 'text', text: `用户第 ${seq} 问` }], source: { kind: 'user' } },
      };
    case 2:
      return {
        type: 'assistant/message',
        seq,
        time,
        data: { message: { id: `a-${seq}`, content: [{ type: 'text', text: `回答 ${seq}` }] } },
      };
    case 3:
      return {
        type: 'tool/call',
        seq,
        time,
        data: { callId: `c-${seq}`, name: 'bash', arguments: JSON.stringify({ command: `echo ${seq}` }) },
      };
    case 4:
      return {
        type: 'tool/result',
        seq,
        time,
        data: {
          message: { toolCallId: `c-${seq - 1}`, content: [{ type: 'text', text: `输出 ${seq}` }] },
        },
      };
    default:
      return { type: 'turn/start', seq, time, data: { turn: 1 } };
  }
}

function makeEvents(count, from = 1) {
  const events = [];
  for (let seq = from; seq < from + count; seq += 1) events.push(makeEvent(seq));
  return events;
}

/** 全量重建的参照实现（与 `TaskIndex` 全量路径同一套参数）。 */
function fullBuild(events) {
  return buildTranscriptAsync(events, {
    max: 5_000,
    budget: Number.POSITIVE_INFINITY,
    maxScan: Number.POSITIVE_INFINITY,
  });
}

after(async () => {
  for (const ctx of indexes) {
    try { ctx.index.dispose(); } catch { /* 已释放 */ }
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* P1-1 增量拼接                                                        */
/* ------------------------------------------------------------------ */

test('增量拼接：追加 1 条事件只处理新增部分，结果与全量重建逐字节相同', async () => {
  let surfaceCalls = 0;
  const log = makeEvents(240);
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { surfaceCalls += 1; throw new Error('live 会话不该读磁盘'); },
      },
      sessions: { get: (id) => (id === 'live-1' ? { log } : undefined) },
    },
  });
  liveTask(index, 'live-1');

  const first = await index.detail('live-1');
  assert.equal(index.transcriptMeter.fullBuilds, 1, '第一次必须全量建一份');
  assert.equal(index.transcriptMeter.incrementalBuilds, 0);
  assert.equal(index.transcriptMeter.eventsScanned, 240, '全量重建扫的是整份日志');
  assert.equal(first.truncated, false);
  assert.equal(surfaceCalls, 0);

  const cachedBefore = index.transcripts.get('live-1');
  const messageCountBefore = cachedBefore.messages.length;
  const cursor = cachedBefore.messages[messageCountBefore - 1].id;
  const scannedBefore = index.transcriptMeter.eventsScanned;
  const bytesBefore = index.transcriptMeter.bytesScanned;

  // 流式输出：宿主日志只追加一条，手机在 800 ms 之后又轮询一次（?after=）。
  log.push({
    type: 'assistant/message',
    seq: 241,
    time: 1_241,
    data: { message: { id: 'a-241', content: [{ type: 'text', text: '刚刚追加的一条' }] } },
  });
  expireTranscript(index, 'live-1');
  const detail = await index.detail('live-1', { after: cursor });

  assert.equal(index.transcriptMeter.fullBuilds, 1, '追加不许触发整份重建');
  assert.equal(index.transcriptMeter.incrementalBuilds, 1, '必须走增量拼接');
  assert.equal(index.transcriptMeter.eventsScanned - scannedBefore, 1, '只处理新增的那 1 条事件');
  assert.ok(index.transcriptMeter.bytesScanned > bytesBefore, '字节计量也要跟着走');
  assert.equal(index.transcripts.get('live-1').messages.length, messageCountBefore + 1);
  assert.deepEqual(detail.messages.map((message) => message.text), ['刚刚追加的一条']);
  assert.equal(detail.reset, false, '游标仍在转录里');

  // 逐字节对照：增量结果必须与"从头全量重建"完全一致。
  const expected = await fullBuild(log);
  assert.equal(
    JSON.stringify(index.transcripts.get('live-1').messages),
    JSON.stringify(expected),
    '增量拼接的结果必须与全量重建逐字节相同',
  );

  // 再追加一条 tool/result：它必须折进已有的 tool/call，而不是单独成条。
  // （240 条事件里最后一个 tool/call 是 seq 238 的 c-238。）
  log.push({
    type: 'tool/result',
    seq: 242,
    time: 1_242,
    data: { message: { toolCallId: 'c-238', content: [{ type: 'text', text: '折进 call 的输出' }] } },
  });
  expireTranscript(index, 'live-1');
  await index.detail('live-1');
  assert.equal(index.transcriptMeter.incrementalBuilds, 2);
  const merged = index.transcripts.get('live-1').messages.filter((message) => message.tool?.callId === 'c-238');
  assert.equal(merged.length, 1, 'tool/result 必须折进那条 tool/call，不许单独成条');
  assert.equal(merged[0].role, 'tool');
  assert.equal(merged[0].tool.result, '折进 call 的输出');
  assert.equal(
    JSON.stringify(index.transcripts.get('live-1').messages),
    JSON.stringify(await fullBuild(log)),
    '折进既有 tool/call 的语义必须与全量重建一致',
  );
});

test('增量拼接：日志被截断或整体重建时退回全量，不会拼出半份转录', async () => {
  const holder = { log: makeEvents(60) };
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { throw new Error('live 会话不该读磁盘'); },
      },
      sessions: { get: (id) => (id === 'live-2' ? holder : undefined) },
    },
  });
  liveTask(index, 'live-2');
  await index.detail('live-2');
  assert.equal(index.transcriptMeter.fullBuilds, 1);
  assert.equal(index.transcriptMeter.incrementalBuilds, 0);

  // 场景 A：日志被截断（换过 DSH_HOME / 宿主动过日志文件）。
  holder.log = holder.log.slice(0, 20);
  expireTranscript(index, 'live-2');
  const truncatedDetail = await index.detail('live-2');
  assert.equal(index.transcriptMeter.fullBuilds, 2, '日志变短必须退回全量');
  assert.equal(index.transcriptMeter.incrementalBuilds, 0);
  assert.equal(
    JSON.stringify(index.transcripts.get('live-2').messages),
    JSON.stringify(await fullBuild(holder.log)),
    '截断后必须是一份完整的重建结果，不是拼接残片',
  );
  assert.equal(truncatedDetail.truncated, false);

  // 场景 B：日志被整体替换成另一份（对象全换、seq 也不连续）。
  holder.log = makeEvents(30, 900);
  expireTranscript(index, 'live-2');
  await index.detail('live-2');
  assert.equal(index.transcriptMeter.fullBuilds, 3, '对象换了同样必须退回全量');
  assert.equal(index.transcriptMeter.incrementalBuilds, 0);
  assert.equal(
    JSON.stringify(index.transcripts.get('live-2').messages),
    JSON.stringify(await fullBuild(holder.log)),
  );
});

test('增量拼接：非 live 的磁盘来源永远走全量（增量只属于内存日志）', async () => {
  let surfaceCalls = 0;
  const events = makeEvents(20);
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { surfaceCalls += 1; return { events, capturedThroughSeq: surfaceCalls }; },
      },
    },
  });
  index.upsertRow({ header: { id: 'cold-1', createdAt: 1 } });
  await index.detail('cold-1');
  expireTranscript(index, 'cold-1');
  await index.detail('cold-1');
  assert.equal(surfaceCalls, 2, '缓存过期就要重读 surface');
  assert.equal(index.transcriptMeter.fullBuilds, 2);
  assert.equal(index.transcriptMeter.incrementalBuilds, 0, '磁盘来源没有"只追加"的保证，不许增量');
  assert.equal(index.transcripts.get('cold-1').capturedThroughSeq, 2);
});

test('增量拼接：被上限截断的长会话仍然只追加新事件（最长的会话不能最慢）', async () => {
  const log = makeEvents(100);
  const { index } = await makeIndex({
    config: { maxScanEvents: 30 },
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { throw new Error('live 会话不该读磁盘'); },
      },
      sessions: { get: (id) => (id === 'capped-1' ? { log } : undefined) },
    },
  });
  liveTask(index, 'capped-1');
  const first = await index.detail('capped-1');
  assert.equal(first.truncated, true);
  assert.equal(index.transcriptMeter.eventsScanned, 30);
  const countBefore = index.transcripts.get('capped-1').messages.length;

  log.push({
    type: 'assistant/message',
    seq: 101,
    time: 1_101,
    data: { message: { id: 'a-101', content: [{ type: 'text', text: '截断会话里新追加的一条' }] } },
  });
  expireTranscript(index, 'capped-1');
  const scannedBefore = index.transcriptMeter.eventsScanned;
  const detail = await index.detail('capped-1');
  assert.equal(index.transcriptMeter.incrementalBuilds, 1, '截断的会话也要走增量');
  assert.equal(index.transcriptMeter.fullBuilds, 1, '不许因为 truncated 就每轮整份重建');
  assert.equal(index.transcriptMeter.eventsScanned - scannedBefore, 1, '只扫新增的 1 条，不是窗口里的 30 条');
  assert.equal(index.transcripts.get('capped-1').messages.length, countBefore + 1);
  assert.equal(detail.truncated, true, '降级标记必须继续为真');
  assert.equal(detail.messages[detail.messages.length - 1].text, '截断会话里新追加的一条');
});

test('增量拼接：消息数超过 MAX_TRANSCRIPT(5000) 时仍与全量重建逐字节相同', async () => {
  // 5200 条 assistant 事件 → 5200 条消息 > 5000，全量重建会裁掉最旧的 200 条。
  const log = [];
  for (let seq = 1; seq <= 5_200; seq += 1) {
    log.push({
      type: 'assistant/message',
      seq,
      time: 1_000 + seq,
      data: { message: { id: `a-${seq}`, content: [{ type: 'text', text: `第 ${seq} 段` }] } },
    });
  }
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { throw new Error('live 会话不该读磁盘'); },
      },
      sessions: { get: (id) => (id === 'long-1' ? { log } : undefined) },
    },
  });
  liveTask(index, 'long-1');
  const first = await index.detail('long-1');
  assert.equal(first.truncated, true, '超过 5000 条消息必须如实告知');
  assert.equal(index.transcripts.get('long-1').messages.length, 5_000);

  log.push({
    type: 'assistant/message',
    seq: 5_201,
    time: 6_201,
    data: { message: { id: 'a-5201', content: [{ type: 'text', text: '第 5201 段' }] } },
  });
  expireTranscript(index, 'long-1');
  await index.detail('long-1');
  assert.equal(index.transcriptMeter.incrementalBuilds, 1, '超长会话也必须走增量');
  assert.equal(index.transcripts.get('long-1').messages.length, 5_000, '条数闸照旧生效');
  assert.equal(
    JSON.stringify(index.transcripts.get('long-1').messages),
    JSON.stringify(await fullBuild(log)),
    '裁剪 + 增量之后仍必须与全量重建逐字节相同',
  );
});

/* ------------------------------------------------------------------ */
/* P1-2 硬上限（降级成尾部窗口）                                        */
/* ------------------------------------------------------------------ */

test('上限：事件数超过 maxScanEvents 时只返回尾部窗口，truncated 为真且分页语义不变', async () => {
  const log = makeEvents(100);
  const { index } = await makeIndex({
    config: { maxScanEvents: 30 },
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { throw new Error('live 会话不该读磁盘'); },
      },
      sessions: { get: (id) => (id === 'big-1' ? { log } : undefined) },
    },
  });
  liveTask(index, 'big-1');

  const page = await index.detail('big-1');
  const windowMessages = index.transcripts.get('big-1').messages.length;
  assert.equal(index.transcriptMeter.eventsScanned, 30, '全量重建必须只扫尾部 30 条事件（硬上限）');
  assert.ok(windowMessages <= 30, `窗口内消息数不该超过事件上限，实际 ${windowMessages}`);
  assert.equal(page.truncated, true, '超上限降级必须置 truncated');
  assert.equal(page.total, windowMessages);
  assert.equal(page.hasMore, false, '窗口只有一页');
  assert.equal(page.nextBefore, '');
  // 只给尾部：最早的那条用户消息不在窗口里。
  assert.equal(page.messages.some((message) => message.text === '用户第 1 问'), false);

  // 逐页往前翻：窗口内部的 hasMore / nextBefore / cursorLost 语义一个字都没变。
  expireTranscript(index, 'big-1');
  const first = await index.detail('big-1', { limit: 10 });
  assert.equal(first.messages.length, 10);
  // 分页契约字段一个都不许改名/删除（`truncated` 是新增的降级标记）。
  for (const key of [
    'messages', 'total', 'offset', 'hasMore', 'nextBefore', 'cursorLost', 'reset',
    'hasMoreAfter', 'capturedThroughSeq', 'truncated', 'degraded', 'children', 'pendingQuestions',
  ]) {
    assert.ok(key in first, `分页契约字段 ${key} 不许消失`);
  }
  assert.equal(first.hasMore, true);
  assert.equal(first.cursorLost, false);
  assert.equal(first.nextBefore, first.messages[0].id);

  expireTranscript(index, 'big-1');
  const second = await index.detail('big-1', { before: first.nextBefore, limit: 10 });
  assert.equal(second.cursorLost, false);
  assert.equal(second.hasMore, true);

  expireTranscript(index, 'big-1');
  const third = await index.detail('big-1', { before: second.nextBefore, limit: 10 });
  assert.equal(third.hasMore, false, '翻到窗口开头就没有更早的了');
  assert.equal(third.nextBefore, '');
  assert.equal(third.truncated, true, '窗口外还有历史，truncated 必须一直为真');
  assert.equal(first.messages.length + second.messages.length + third.messages.length, windowMessages);

  // 游标指向窗口外（更早）的消息：如实报 cursorLost，让手机重置成尾部一页。
  expireTranscript(index, 'big-1');
  const lost = await index.detail('big-1', { before: 'u-1', limit: 10 });
  assert.equal(lost.cursorLost, true);

  // 会话再长，单次构建的成本也只与"新增了几条"有关：截断会话走增量，
  // 不再整份重建（所以不是每轮 30 条，而是每轮新增几条）。
  const fullBuildsBefore = index.transcriptMeter.fullBuilds;
  log.push(
    { type: 'assistant/message', seq: 101, time: 1_101, data: { message: { id: 'a-101', content: [{ type: 'text', text: '新 101' }] } } },
    { type: 'assistant/message', seq: 102, time: 1_102, data: { message: { id: 'a-102', content: [{ type: 'text', text: '新 102' }] } } },
    { type: 'assistant/message', seq: 103, time: 1_103, data: { message: { id: 'a-103', content: [{ type: 'text', text: '新 103' }] } } },
  );
  expireTranscript(index, 'big-1');
  const scanned = index.transcriptMeter.eventsScanned;
  await index.detail('big-1');
  assert.equal(index.transcriptMeter.eventsScanned - scanned, 3, '单次构建只扫新增的 3 条，与会话总长无关');
  assert.equal(index.transcriptMeter.fullBuilds, fullBuildsBefore, '截断的会话也不许退回每轮全量');
});

test('上限：单条巨大的事件也受 maxScanBytes 约束（事件数不多也会降级）', async () => {
  const log = [];
  for (let seq = 1; seq <= 40; seq += 1) {
    log.push({
      type: 'assistant/message',
      seq,
      time: 1_000 + seq,
      data: { message: { id: `fat-${seq}`, content: [{ type: 'text', text: `${seq}`.repeat(600) }] } },
    });
  }
  const { index } = await makeIndex({
    config: { maxScanBytes: 4_000 },
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { throw new Error('live 会话不该读磁盘'); },
      },
      sessions: { get: (id) => (id === 'fat-1' ? { log } : undefined) },
    },
  });
  liveTask(index, 'fat-1');
  const page = await index.detail('fat-1');
  assert.equal(page.truncated, true, '字节上限生效时必须置 truncated');
  assert.ok(index.transcriptMeter.eventsScanned < 40, `字节闸要真的缩窗口，实际扫了 ${index.transcriptMeter.eventsScanned} 条`);
  assert.ok(page.messages.length >= 1, '至少留一条，不能返回空页');
  // 留下的必须是**尾部**（最新的）那几条。
  assert.equal(page.messages[page.messages.length - 1].id, 'fat-40');
});

/* ------------------------------------------------------------------ */
/* P1-3 单飞                                                            */
/* ------------------------------------------------------------------ */

test('单飞：同一 sessionId 并发两次只构建一次，两边拿到同一份结果', async () => {
  const log = makeEvents(600);
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { throw new Error('live 会话不该读磁盘'); },
      },
      sessions: { get: (id) => (id === 'live-3' ? { log } : undefined) },
    },
  });
  liveTask(index, 'live-3');
  const buildsBefore = index.transcriptMeter.builds;

  const [left, right] = await Promise.all([
    index.detail('live-3'),
    index.detail('live-3'),
  ]);

  assert.equal(index.transcriptMeter.builds - buildsBefore, 1, '并发两次必须只调用一次构建');
  assert.equal(index.transcriptMeter.fullBuilds, 1);
  assert.deepEqual(left.messages, right.messages);
  assert.equal(left.total, right.total);
  assert.equal(index.transcriptFlights.size, 0, '构建结束后必须从单飞表里摘掉，否则会一直命中旧 promise');

  // 单飞只合并"同一 id 的并发"：不同 id 仍然各建各的。
  index.upsertRow({ header: { id: 'live-4', createdAt: 2 } });
  const other = index.getTask('live-4');
  other.live = true;
  other.status = 'running';
  // live-3 的缓存还在 TTL 内：先让它过期，才是"两个都在建"的对照。
  expireTranscript(index, 'live-3');
  const buildsBeforeSecond = index.transcriptMeter.builds;
  await Promise.all([index.detail('live-3'), index.detail('live-4')]);
  assert.equal(index.transcriptMeter.builds - buildsBeforeSecond, 2, '不同会话不能被合并成一次构建');
});
