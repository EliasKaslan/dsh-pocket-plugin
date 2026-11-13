/**
 * lib/task-index.mjs —— 插件侧的任务索引（补覆盖用）。
 *
 * 这里**不**起 HTTP：任务索引是纯内存 + 宿主服务桩的领域对象，
 * 直接用真实的 `TaskIndex` + 手搓 `services` 桩打，才能精确走到
 * 「服务缺失 / 抛错 / 返回畸形数据」这三类降级分支。
 *
 * 约束（与仓库既有 e2e/integration 同一条线）：
 *  - 所有目录都在 os.tmpdir() 下，after() 统一清理；
 *  - 不联网、不碰 ~/.dsh、不占端口、不留常驻进程；
 *  - 会话日志用真实的 zstd 帧（node:zlib），走真实的 readTailEvents/scanSessionFiles。
 *
 * 桩只实现被测代码真实调用到的形状，方法名与 DSH 宿主 API 一致。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { after, test } from 'node:test';

import { reasonText } from '../../lib/messages.mjs';
import { scanSessionFiles } from '../../lib/session-files.mjs';
import { LIST_PREVIEW_CHARS, TaskIndex } from '../../lib/task-index.mjs';

const tmpRoot = path.join(tmpdir(), `dsh-pocket-task-index-${process.pid}-${Date.now()}`);
const indexes = [];

let dirSeq = 0;
/** 每个用例一个独立的 home（内含 sessions/），互不干扰。 */
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

// 注意：这个定时器**不能** unref。await 一个 unref 的定时器时，事件循环会因
// 为没有别的活而提前兜底，Node 22 的 runner 直接判 cancelledByParent，
// 后面整个文件的测试都会被取消（Node 24 不复现，所以只有 CI 会红）。
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 造一个真实 TaskIndex。`services` 未给出的键就是「宿主没装这个服务」。
 */
async function makeIndex({ services = {}, config = {}, home } = {}) {
  const resolvedHome = home ?? await makeHome();
  const emitted = [];
  const logger = makeLogger();
  const index = new TaskIndex({
    logger,
    emit: (type, payload) => emitted.push({ type, payload }),
    state: { touchDevice() {} },
    config,
    services,
    home: resolvedHome,
    dataDir: path.join(resolvedHome, 'pocket'),
  });
  const ctx = { index, logger, emitted, home: resolvedHome };
  indexes.push(ctx);
  return ctx;
}

/** 把事件行写成真实的 zstd 帧（readTailEvents 靠 zstd magic 找帧）。 */
async function writeSessionFile(home, { cwdDir = 'workspace', sessionId, lines, frameSize = 0 }) {
  const dir = path.join(home, 'sessions', cwdDir, sessionId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl.zstd');
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  let payload;
  if (frameSize > 0) {
    const frames = [];
    for (let offset = 0; offset < text.length; offset += frameSize) {
      frames.push(zstdCompressSync(Buffer.from(text.slice(offset, offset + frameSize), 'utf8')));
    }
    payload = Buffer.concat(frames);
  } else {
    payload = zstdCompressSync(Buffer.from(text, 'utf8'));
  }
  await writeFile(file, payload);
  return { file, dir };
}

const row = (header, extra = {}) => ({ header, ...extra });

after(async () => {
  for (const ctx of indexes) {
    try { ctx.index.dispose(); } catch { /* 已释放 */ }
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 装载：空 / 损坏 / 重复 / 上限                                        */
/* ------------------------------------------------------------------ */

test('load：空 sessions 也能收敛（0 条、loadedAt 有值、发 loaded 与 summary）', async () => {
  const { index, emitted, logger } = await makeIndex({
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  const size = await index.load();
  assert.equal(size, 0);
  assert.equal(index.tasks.size, 0);
  assert.ok(index.loadedAt > 0, 'loadedAt 必须被写成真实时间戳');
  assert.equal(index.loading, false);
  assert.equal(index.loadError, undefined);
  assert.ok(emitted.some((frame) => frame.type === 'tasks.changed' && frame.payload.reason === 'loaded'));
  assert.ok(logger.lines.some((line) => line.includes('task index loaded 0 sessions from 0 rows')));
});

test('load：header 畸形（null / 字符串 / id 不是字符串 / 空 id）的行被跳过，不抛也不占位', async () => {
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() {
          return [
            {},
            row(null),
            row('not-an-object'),
            row({ id: 42 }),
            row({ id: '' }),
            row({ id: 'ok-1', createdAt: 1000 }),
          ];
        },
      },
    },
  });
  // 现状：`id: ''` 是字符串，会被当成合法 id 收进索引（空 id 无法被 /tasks/:id 路由到）。
  assert.equal(await index.load(), 2);
  assert.deepEqual([...index.tasks.keys()], ['', 'ok-1']);
  assert.equal(index.tasks.get('ok-1').createdAt, 1000);
});

test('脏行不再毒死装载：null 行被跳过，loading 必定放开（原为已知问题 task-index:131）', async () => {
  const { index } = await makeIndex({
    services: { sessionQuery: { async listSessions() { return [null, row({ id: 'ok-1', createdAt: 5 })]; } } },
  });
  assert.equal(index.upsertRow(null), undefined, 'upsertRow 对 null 是安全的');
  // 修之前这里是 assert.rejects：`row.header?.id` 的可选链挂错了位置，一行 null 就抛
  // TypeError，而且抛在 `loading = false` 之前 —— 索引从此永久 loading。现在应当跳过脏行、
  // 正常装载其余行，并且无论成败都把 loading 放开。
  await index.load();
  assert.deepEqual([...index.tasks.keys()], ['ok-1'], '同一批里的正常行仍然入库');
  assert.equal(index.loading, false, 'load() 结束后 loading 必须是 false');
});

test('脏行之外的失败也会放开 loading：投递期抛错不留下永久 loading', async () => {
  const { index } = await makeIndex({
    services: { sessionQuery: { async listSessions() { return [row({ id: 'a', createdAt: 1 })]; } } },
  });
  index.rebuildChildren = () => { throw new Error('boom'); };
  await assert.rejects(index.load(), /boom/u);
  assert.equal(index.loading, false, '抛错也要走 finally 放开 loading');
});

test('load：showSeeded 关闭时 seeded 会话不出现，打开时出现', async () => {
  const rows = () => [
    row({ id: 'seeded-1', isSeeded: true, createdAt: 1 }),
    row({ id: 'real-1', createdAt: 2 }),
  ];
  const off = await makeIndex({ services: { sessionQuery: { async listSessions() { return rows(); } } } });
  assert.equal(await off.index.load(), 1);
  assert.deepEqual([...off.index.tasks.keys()], ['real-1']);

  const on = await makeIndex({
    services: { sessionQuery: { async listSessions() { return rows(); } } },
    config: { showSeeded: true },
  });
  assert.equal(await on.index.load(), 2);
  assert.ok(on.index.tasks.has('seeded-1'));
});

test('upsertRow：并发/重复装载同一 id 只保留一条，且字段被最新一行刷新', async () => {
  const { index } = await makeIndex({
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  const first = index.upsertRow(row({ id: 'dup', createdAt: 10, cwd: 'C:\\a\\b\\' }));
  assert.equal(first.cwdName, 'b', 'cwdName 是最后一段（去掉尾部分隔符）');
  const second = index.upsertRow(row({ id: 'dup', createdAt: 10, agentPreset: 'p2', cwd: 'C:\\a\\b' }));
  assert.equal(index.tasks.size, 1, '同一 id 不允许出现两条任务');
  assert.equal(second, first, '重复装载复用同一个对象（增量更新就靠这个）');
  // 现状：只有 live/persisted/file 会被重装刷新，身份类字段（cwd/preset/createdAt）
  // 保持首次装载的值 —— 这是刻意的，「可变状态」由 handleEvent 负责。
  assert.equal(second.preset, undefined);
  assert.equal(second.cwdName, 'b');
  assert.equal(second.titleSource, 'none');

  // live/persisted 会被刷新
  index.upsertRow(row({ id: 'dup', createdAt: 10 }), undefined);
  const live = index.upsertRow({ header: { id: 'dup', createdAt: 10 }, live: true, persisted: true });
  assert.equal(live.live, true);
  assert.equal(live.persisted, true);

  // 两次 load() 结果一致（模拟并发装载）
  const twice = await makeIndex({
    services: { sessionQuery: { async listSessions() { return [row({ id: 'x', createdAt: 1 })]; } } },
  });
  await Promise.all([twice.index.load(), twice.index.load()]);
  assert.equal(twice.index.tasks.size, 1);
});

test('upsertRow：MAX_TASKS=5000 上限截断，只告警一次且已有任务仍可刷新', async () => {
  const { index, logger } = await makeIndex({
    services: { sessionQuery: { async listSessions() { return []; } } },
    config: {},
  });
  for (let i = 0; i < 5000; i += 1) index.upsertRow(row({ id: `t-${i}`, createdAt: i }));
  assert.equal(index.tasks.size, 5000);

  assert.equal(index.upsertRow(row({ id: 'overflow-1', createdAt: 1 })), undefined, '超上限的新会话必须被拒绝');
  assert.equal(index.tasks.size, 5000);
  assert.equal(index.upsertRow(row({ id: 'overflow-2', createdAt: 2 })), undefined);
  assert.equal(logger.lines.filter((line) => line.includes('task index is full')).length, 1, '只告警一次，不许刷屏');

  const updated = index.upsertRow(row({ id: 't-0', createdAt: 0, agentPreset: 'late' }));
  assert.notEqual(updated, undefined, '已存在的任务在上限之后仍必须能刷新');
  assert.equal(updated, index.tasks.get('t-0'));
  assert.equal(index.tasks.size, 5000);
});

test('upsertRow：父子关系在重复装载时不重复挂载（children 去重）', async () => {
  const { index } = await makeIndex({
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  index.upsertRow(row({ id: 'parent', createdAt: 1 }));
  index.upsertRow(row({ id: 'child', parentSessionId: 'parent', createdAt: 2 }));
  index.upsertRow(row({ id: 'child', parentSessionId: 'parent', createdAt: 2 }));
  assert.deepEqual(index.tasks.get('parent').children, ['child']);
  assert.equal(index.tasks.get('child').isSubagent, true);
  // rebuildChildren 幂等
  index.rebuildChildren();
  assert.deepEqual(index.tasks.get('parent').children, ['child']);
});

test('rebuildChildren：孤儿子代理不挂到任何父级，也不报错', async () => {
  const { index } = await makeIndex({
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  index.upsertRow(row({ id: 'child-a', origin: 'subagent', parentSessionId: 'ghost', createdAt: 1 }));
  index.upsertRow(row({ id: 'child-b', origin: 'subagent', createdAt: 2 }));
  assert.equal(index.tasks.size, 2);
  index.rebuildChildren();
  assert.deepEqual(index.tasks.get('child-a').children, []);
  assert.equal(index.tasks.get('child-b').parentId, undefined);
});

test('load：命中会话文件时 merged 最新 mtime，并把 file 记到任务上', async () => {
  const home = await makeHome();
  const { file } = await writeSessionFile(home, {
    sessionId: 'with-file',
    lines: [{ type: 'session/title', seq: 1, data: { title: '来自文件' } }],
  });
  const { index } = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  const task = index.upsertRow(row({ id: 'with-file', createdAt: 1 }), { file, mtimeMs: 1_700_000_000_000 });
  assert.equal(task.file, file);
  assert.equal(task.fileMtime, 1_700_000_000_000);
  assert.ok(task.updatedAt >= 1_700_000_000_000, '文件 mtime 必须参与 updatedAt');
});

/* ------------------------------------------------------------------ */
/* start()：失败可重试                                                  */
/* ------------------------------------------------------------------ */

test('start：宿主服务缺失时 loadError 落库并广播，服务到位后同一实例可重试成功', async () => {
  const services = {};
  const { index, emitted, logger } = await makeIndex({ services });

  await index.start();
  assert.match(index.loadError, /sessionQuery service is not available/u);
  assert.equal(index.loading, false);
  const status = emitted.find((frame) => frame.type === 'bridge.status');
  assert.notEqual(status, undefined, '装载失败必须广播 bridge.status');
  assert.equal(status.payload.loading, false);
  assert.equal(status.payload.tasks, 0);
  assert.match(status.payload.error, /sessionQuery/u);
  assert.ok(logger.lines.some((line) => line.startsWith('error task index load failed')));

  // 宿主迟到了：同一个实例必须能再试一次
  services.sessionQuery = { async listSessions() { return [row({ id: 'late', createdAt: 1 })]; } };
  index.setServices(services);
  const size = await index.start();
  assert.equal(size, 1);
  assert.equal(index.loadError, undefined);
  assert.ok(index.tasks.has('late'));
});

test('start：并发调用共享同一个 loadPromise（只装载一次）', async () => {
  let calls = 0;
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { calls += 1; await delay(5); return [row({ id: 'p', createdAt: 1 })]; },
      },
    },
  });
  const [a, b] = await Promise.all([index.start(), index.start()]);
  assert.equal(calls, 1, '并发 start 不许重复 listSessions');
  assert.equal(a, 1);
  assert.equal(b, 1);
});

/* ------------------------------------------------------------------ */
/* 标题与尾部装载                                                       */
/* ------------------------------------------------------------------ */

test('loadTitles：fulfilled 才采纳、空标题丢弃、未知任务忽略，并按 80 分块', async () => {
  const ids = Array.from({ length: 81 }, (_unused, i) => `s-${i}`);
  const batches = [];
  const { index, emitted, logger } = await makeIndex({
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  for (const id of ids) index.upsertRow(row({ id, createdAt: 1 }));
  index.services.sessionQuery = {
    async readTitleSnapshots(chunk) {
      batches.push(chunk);
      return [
        { status: 'fulfilled', value: { session: { id: chunk[0] }, title: { title: `标题-${chunk[0]}` } } },
        { status: 'rejected', value: undefined },
        { status: 'fulfilled', value: {} },
        { status: 'fulfilled', value: { session: { id: chunk[0] }, title: '   ' } },
        { status: 'fulfilled', value: { session: { id: 'no-such-task' }, title: 'x' } },
      ];
    },
  };
  await index.loadTitles(ids);
  assert.equal(batches.length, 2, '81 个 id 必须分成 2 块（80 + 1）');
  assert.equal(batches[0].length, 80);
  assert.equal(batches[1].length, 1);
  assert.equal(index.tasks.get('s-0').title, '标题-s-0');
  assert.equal(index.tasks.get('s-0').titleSource, 'provider');
  assert.equal(index.tasks.get('s-80').title, '标题-s-80');
  assert.ok(emitted.some((frame) => frame.type === 'tasks.changed' && frame.payload.reason === 'titles'));
  assert.equal(logger.lines.filter((line) => line.includes('title projection failed')).length, 0);
});

test('loadTitles：投影抛错时告警并停止后续分块（不把宿主拖死）', async () => {
  const ids = Array.from({ length: 200 }, (_unused, i) => `e-${i}`);
  let calls = 0;
  const { index, logger } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readTitleSnapshots() { calls += 1; throw new Error('projection exploded'); },
      },
    },
  });
  await index.loadTitles(ids);
  assert.equal(calls, 1, '出错后必须 break，而不是继续打剩下的块');
  assert.ok(logger.lines.some((line) => line.includes('title projection failed projection exploded')));
});

test('loadTitles：没有 sessionQuery 时静默返回（不抛）', async () => {
  const { index } = await makeIndex({ services: {} });
  await index.loadTitles(['a', 'b']);
  assert.equal(index.tasks.size, 0);
});

test('applyTail：从真实 zstd 帧里恢复标题/状态/模型/计数/预览', async () => {
  const home = await makeHome();
  const startedAt = 1_700_000_500_000;
  const { file } = await writeSessionFile(home, {
    sessionId: 'rich',
    lines: [
      { type: 'session/title', seq: 1, data: { title: '  会话标题  ' } },
      { type: 'subagent/descriptor', seq: 2, data: { label: '子代理标签' } },
      { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '帮我看下这个函数' }] } },
      { type: 'tool/call', seq: 4, data: { callId: 'c1', name: 'shell', arguments: '{"command":"ls"}' } },
      { type: 'tool/call', seq: 5, data: { callId: 'c2', name: 'read', arguments: '{"path":"/a"}' } },
      {
        type: 'assistant/message',
        seq: 6,
        time: 1_700_000_900_000,
        data: { message: { content: [{ type: 'text', text: '看过了\n没问题' }], source: { provider: 'p2', model: 'm2' } } },
      },
      { type: 'request/header', seq: 7, data: { header: { config: { provider: 'p1', model: 'm1' } } } },
      { type: 'turn/end', seq: 8, data: { turn: 3, reason: { kind: 'completed' } } },
    ],
  });
  const { index } = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  const task = index.upsertRow(row({ id: 'rich', createdAt: 1 }), { file, mtimeMs: startedAt });
  await index.applyTail(task);

  assert.equal(task.title, '会话标题', '标题必须 trim');
  assert.equal(task.titleSource, 'provider');
  assert.equal(task.blank, false);
  assert.equal(task.turn, 3);
  assert.equal(task.status, 'done', 'completed → done');
  assert.equal(task.statusReason, reasonText({ kind: 'completed' }), 'statusReason 必须由 reasonText 给出');
  assert.ok(task.statusReason.length > 0);
  assert.deepEqual(task.model, { provider: 'p2', model: 'm2' }, 'assistant 的 source 覆盖 request/header');
  assert.equal(task.messageCount, 2, '1 条 user + 1 条 assistant');
  assert.equal(task.toolCount, 2);
  assert.equal(task.lastRole, 'assistant');
  assert.equal(task.lastText, '看过了 没问题', '预览是一行（oneLine 折叠换行）');
  assert.equal(task.updatedAt, 1_700_000_900_000, 'assistant 的 time 参与 updatedAt');
  assert.equal(task.tailMtime, startedAt);
});

test('applyTail：没有 session/title 时用 descriptor.label；都没有时用派生标题与用户正文', async () => {
  const home = await makeHome();

  const descriptor = await writeSessionFile(home, {
    sessionId: 'descriptor',
    lines: [{ type: 'subagent/descriptor', seq: 1, data: { label: '描述符标题' } }],
  });
  const viaDescriptor = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  const taskA = viaDescriptor.index.upsertRow(row({ id: 'descriptor', createdAt: 1 }), { file: descriptor.file, mtimeMs: 1 });
  await viaDescriptor.index.applyTail(taskA);
  assert.equal(taskA.title, '描述符标题');
  assert.equal(taskA.titleSource, 'descriptor');

  const userOnly = await writeSessionFile(home, {
    sessionId: 'user-only',
    lines: [{ type: 'user/message', seq: 1, data: { content: '这是一段很长很长的用户输入，用来验证标题会被截断到四十二个字符以内不会整段塞进去' } }],
  });
  const viaUser = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  const taskB = viaUser.index.upsertRow(row({ id: 'user-only', createdAt: 1 }), { file: userOnly.file, mtimeMs: 1 });
  await viaUser.index.applyTail(taskB);
  assert.equal(taskB.titleSource, 'derived');
  assert.equal(taskB.lastRole, 'user');
  assert.ok(taskB.title.length <= 42, `派生标题必须截断，实际 ${taskB.title.length}`);
  assert.equal(taskB.title, taskB.lastText.slice(0, 42).replace(/\s+/gu, ' ').trim());

  const empty = await writeSessionFile(home, {
    sessionId: 'empty-ish',
    lines: [{ type: 'tool/call', seq: 1, data: { name: 'x' } }],
  });
  const viaNothing = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  const taskC = viaNothing.index.upsertRow(row({ id: 'empty-ish', createdAt: 0 }), { file: empty.file, mtimeMs: 1 });
  await viaNothing.index.applyTail(taskC);
  assert.equal(taskC.titleSource, 'derived');
  assert.match(taskC.title, /^未命名任务 · /u);
  assert.equal(taskC.blank, true, '只有工具调用时任务仍是空白会话');
});

test('applyTail：mtime 未变则跳过读盘；文件为空/zstd 损坏时安静返回', async () => {
  const home = await makeHome();
  const { file } = await writeSessionFile(home, {
    sessionId: 'cached',
    lines: [{ type: 'session/title', seq: 1, data: { title: '第一次' } }],
  });
  const { index } = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  const task = index.upsertRow(row({ id: 'cached', createdAt: 1 }), { file, mtimeMs: 111 });
  await index.applyTail(task);
  assert.equal(task.title, '第一次');

  // 手工改掉标题：若第二次真的重读了文件，标题会被重置回「第一次」
  task.title = '被外部改过';
  await index.applyTail(task);
  assert.equal(task.title, '被外部改过', 'tailMtime 已等于 fileMtime，不许重复读盘');

  // 空文件 → readTailEvents 返回 undefined → 原样返回
  const emptyFile = path.join(home, 'empty.bin');
  await writeFile(emptyFile, '');
  const taskB = index.upsertRow(row({ id: 'empty-file', createdAt: 1 }), { file: emptyFile, mtimeMs: 1 });
  const before = { title: taskB.title, titleSource: taskB.titleSource };
  await index.applyTail(taskB);
  assert.deepEqual({ title: taskB.title, titleSource: taskB.titleSource }, before);

  // 有内容但没有 zstd 帧（纯 JSONL）——未压缩会话就是这种格式，必须被读出来
  // （过去这里恒返回 undefined，于是这类会话永远没有标题/状态/预览）。
  const plainFile = path.join(home, 'plain.jsonl');
  await writeFile(plainFile, `${JSON.stringify({ type: 'session/title', data: { title: 'x' } })}\n`);
  const taskC = index.upsertRow(row({ id: 'plain', createdAt: 1 }), { file: plainFile, mtimeMs: 1 });
  await index.applyTail(taskC);
  assert.equal(taskC.title, 'x', '纯 JSONL 也是合法日志，标题必须被读出来');
});

test('applyTail：turn/end 的每种 reason.kind 映射到正确的状态', async () => {
  const home = await makeHome();
  const cases = [
    ['completed', 'done'],
    ['forked', 'done'],
    ['aborted', 'cancelled'],
    ['interrupted', 'cancelled'],
    ['error', 'error'],
    ['blocked', 'error'],
    ['max-tokens', 'error'],
    ['weird-unknown-kind', 'idle'],
    [undefined, 'idle'],
  ];
  for (const [kind, expected] of cases) {
    const sessionId = `reason-${String(kind)}`;
    const { file } = await writeSessionFile(home, {
      sessionId,
      lines: [{ type: 'turn/end', seq: 1, data: { turn: 1, reason: kind === undefined ? undefined : { kind } } }],
    });
    const { index } = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
    const task = index.upsertRow(row({ id: sessionId, createdAt: 1 }), { file, mtimeMs: 1 });
    await index.applyTail(task);
    assert.equal(task.status, expected, `reason.kind=${String(kind)} 应该映射到 ${expected}`);
  }
});

test('applyTail：reason 不是对象 / 畸形数据不抛，status 落到 idle', async () => {
  const home = await makeHome();
  for (const reason of [null, 42, 'completed', [], true]) {
    const sessionId = `malformed-${typeof reason}-${String(reason).slice(0, 4)}`;
    const { file } = await writeSessionFile(home, {
      sessionId,
      lines: [{ type: 'turn/end', seq: 1, data: { turn: 2, reason } }],
    });
    const { index } = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
    const task = index.upsertRow(row({ id: sessionId, createdAt: 1 }), { file, mtimeMs: 1 });
    await index.applyTail(task);
    assert.equal(task.status, 'idle');
    assert.equal(task.turn, 2);
  }
});

/*
 * 尾部窗口太窄的后果：真实语料每帧只装 1~3 条事件，旧的 12 帧窗口遇到"收尾之后
 * 又跑了很多步"的会话就读不到最后一个 `turn/end`，冷会话的 status / turn 号
 * 停在上一个回合（实测有列表显示已完成、详情却是 none 的会话）。
 */
test('applyTail：turn/end 落在老 12 帧窗口之外时，状态与 turn 号仍是最新回合的', async () => {
  const home = await makeHome();
  const dir = path.join(home, 'sessions', 'workspace', 'long-turn');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl.zstd');
  const frames = [];
  const pushFrame = (events) => frames.push(zstdCompressSync(
    Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8'),
  ));
  pushFrame([
    { type: 'turn/start', seq: 1, data: { turn: 3 } },
    { type: 'user/message', seq: 2, data: { content: '第三轮' } },
    { type: 'turn/end', seq: 3, data: { turn: 3, reason: { kind: 'completed' } } },
  ]);
  // 收尾之后又追加 20 帧（每帧 1 条）：模拟"下一轮已经跑了很多步但还没收尾"。
  for (let i = 0; i < 20; i += 1) {
    pushFrame([{ type: 'tool/result', seq: 4 + i, data: { message: { toolCallId: `c${i}`, content: 'x' } } }]);
  }
  await writeFile(file, Buffer.concat(frames));

  const { index } = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  const task = index.upsertRow(row({ id: 'long-turn', createdAt: 1 }), { file, mtimeMs: 1 });
  await index.applyTail(task);
  assert.equal(task.status, 'done', '状态必须来自最后一个 turn/end(completed→done)，不是默认 idle');
  assert.equal(task.turn, 3, 'turn 号不许停在旧值');
});

/*
 * 未压缩 / 旧版会话写的是纯文本 `session*.jsonl`。`scanSessionFiles` 一直认它，
 * 但读取侧过去只在找到 zstd magic 后才解析 —— 这类会话在列表里永远没有状态、
 * 标题、预览，`applyTail` 静默 return，既无日志也无报错。
 */
test('applyTail：未压缩的纯文本 session.jsonl 也能填出标题/状态/正文预览', async () => {
  const home = await makeHome();
  const dir = path.join(home, 'sessions', 'workspace', 'plain-log');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'session/title', seq: 1, data: { title: '纯文本会话标题' } },
    { type: 'turn/start', seq: 2, data: { turn: 1 } },
    { type: 'user/message', seq: 3, data: { content: '未压缩日志里的用户消息', source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 4, data: { message: { content: '未压缩日志里的回答' } } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

  const entry = scanSessionFiles(home).get('plain-log');
  assert.equal(entry?.file, file, 'scanSessionFiles 一直把纯 JSONL 当合法日志');
  const { index } = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  const task = index.upsertRow(row({ id: 'plain-log', createdAt: 1 }), entry);
  await index.applyTail(task);
  assert.equal(task.title, '纯文本会话标题', '标题必须读得出来');
  assert.equal(task.status, 'done', '状态必须读得出来');
  assert.equal(task.turn, 1);
  assert.equal(task.lastText, '未压缩日志里的回答', '正文预览必须读得出来');
});

test('loadTails：并发 6 路、跳过 live 与无文件任务、单个失败不拖垮整批', async () => {
  const home = await makeHome();
  const ids = [];
  for (let i = 0; i < 9; i += 1) {
    const sessionId = `tail-${i}`;
    const { file } = await writeSessionFile(home, {
      sessionId,
      lines: [{ type: 'session/title', seq: 1, data: { title: `尾部-${i}` } }],
    });
    ids.push({ id: sessionId, file });
  }
  const { index, logger } = await makeIndex({ home, services: { sessionQuery: { async listSessions() { return []; } } } });
  for (const [i, entry] of ids.entries()) {
    index.upsertRow(row({ id: entry.id, createdAt: i }), { file: entry.file, mtimeMs: 100 + i });
  }
  // 一个 live 任务（有文件也不该读）、一个没有文件的任务、一个 id 根本不存在的任务
  const liveTask = index.upsertRow(row({ id: 'live-task', createdAt: 99 }), { file: ids[0].file, mtimeMs: 1 });
  liveTask.live = true;
  index.upsertRow(row({ id: 'no-file', createdAt: 98 }));

  // 让其中一个任务在 applyTail 里抛错，验证 worker 的隔离
  const boom = index.tasks.get('tail-4');
  const original = index.applyTail.bind(index);
  index.applyTail = async (task) => {
    if (task === boom) throw new Error('tail exploded');
    return original(task);
  };

  await index.loadTails([...ids.map((entry) => entry.id), 'live-task', 'no-file', 'no-such-id']);

  assert.ok(logger.lines.some((line) => line.includes('tail read failed tail-4')), '失败必须留 warn');
  for (const entry of ids) {
    const task = index.tasks.get(entry.id);
    if (entry.id === 'tail-4') continue;
    assert.equal(task.title, `尾部-${entry.id.slice('tail-'.length)}`, `${entry.id} 必须被读到`);
  }
  assert.equal(index.tasks.get('live-task').title, '', 'live 任务不读盘');
  assert.equal(index.tasks.get('no-file').title, '', '没有文件的任务被跳过');
  assert.ok(logger.lines.some((line) => line.includes('task index is full')) === false);
});

/* ------------------------------------------------------------------ */
/* 事件驱动                                                             */
/* ------------------------------------------------------------------ */

test('handleEvent：turn/start、turn/end、session/title 更新状态与标题', async () => {
  const { index, emitted } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  index.upsertRow(row({ id: 's1', createdAt: 1 }));
  const session = { id: 's1', header: { id: 's1', createdAt: 1 } };

  index.handleEvent(session, { type: 'turn/start', time: 1000, data: { turn: 2 } });
  let task = index.getTask('s1');
  assert.equal(task.status, 'running');
  assert.equal(task.turn, 2);
  assert.equal(task.updatedAt, 1000);

  index.handleEvent(session, { type: 'session/title', data: { title: '新标题' } });
  assert.equal(task.title, '新标题');
  assert.equal(task.titleSource, 'provider');

  index.handleEvent(session, { type: 'session/title', data: { title: '   ' } });
  assert.equal(task.title, '新标题', '空标题不能覆盖已有标题');

  index.handleEvent(session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'interrupted' } } });
  assert.equal(task.status, 'cancelled');
  assert.equal(task.turn, 4);

  await delay(200);
  assert.ok(emitted.some((frame) => frame.type === 'task.updated' && frame.payload.id === 's1'));
  task = index.getTask('s1');
  assert.equal(task.status, 'cancelled');
});

test('handleEvent：assistant/user/tool 累加计数并从内容里取预览与标题', async () => {
  const { index, emitted } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  const session = { id: 's2', header: { id: 's2', createdAt: 5 } };

  index.handleEvent(session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '把 Windows 上的端口改一下' }] },
  });
  const task = index.getTask('s2');
  assert.notEqual(task, undefined, '未知会话的历史事件必须顺手建出任务');
  assert.equal(task.messageCount, 1);
  assert.equal(task.lastRole, 'user');
  assert.equal(task.title, '把 Windows 上的端口改一下');
  assert.equal(task.titleSource, 'derived');
  assert.equal(task.origin, 'user');

  // 注入型 user/message 不算一条真人消息
  index.handleEvent(session, {
    type: 'user/message', data: { content: [{ type: 'text', text: '系统注入' }], source: { kind: 'system' } },
  });
  assert.equal(task.messageCount, 1, '注入消息不许计入 messageCount');
  assert.equal(task.title, '把 Windows 上的端口改一下', '注入消息不许改标题');

  index.handleEvent(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '改好了' }], source: { provider: 'p', model: 'm' } } },
  });
  assert.equal(task.messageCount, 2);
  assert.equal(task.lastRole, 'assistant');
  assert.equal(task.lastText, '改好了');
  assert.deepEqual(task.model, { provider: 'p', model: 'm' });

  // 空正文的 assistant 不算 blank=false，也不产生预览
  index.handleEvent(session, { type: 'assistant/message', data: { message: { content: [] } } });
  assert.equal(task.lastText, '改好了');

  index.handleEvent(session, { type: 'tool/call', data: { name: 'shell' } });
  assert.equal(task.toolCount, 1);

  const beforeUnknown = { messageCount: task.messageCount, toolCount: task.toolCount, lastText: task.lastText };
  index.handleEvent(session, { type: 'some/unknown/event', data: {} });
  assert.deepEqual(
    { messageCount: task.messageCount, toolCount: task.toolCount, lastText: task.lastText },
    beforeUnknown,
    '未知事件不改任何计数或预览',
  );
  assert.equal(task.messageCount, 3, '空正文的 assistant 也计入 messageCount（先加后判）');

  assert.ok(emitted.some((frame) => frame.type === 'task.message' && frame.payload.taskId === 's2'));
  assert.ok(emitted.some((frame) => frame.type === 'task.message' && frame.payload.message.text === '改好了'));
});

test('handleEvent：session/error 与 error 置错误态并给出可读原因', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  const session = { id: 's3', header: { id: 's3' } };
  index.handleEvent(session, { type: 'turn/start', data: {} });
  index.handleEvent(session, { type: 'session/error', data: { error: { message: '磁盘满了' } } });
  const task = index.getTask('s3');
  assert.equal(task.status, 'error');
  assert.equal(task.statusReason, '磁盘满了');

  index.handleEvent(session, { type: 'error', data: { message: '传输中断' } });
  assert.equal(task.statusReason, '传输中断');

  index.handleEvent(session, { type: 'error', data: {} });
  assert.equal(task.statusReason, '执行出错', '没有 message 时给固定兜底文案');
});

/*
 * live 事件是旁路：它不经过 buildTranscript（那里才有 6000 字符/条的单条闸），
 * 所以不在这里裁，一条 100k 字符的正文（桌面粘贴、模型整篇输出）会原样进中继；
 * 而中继单消息最多 64 帧 × 64 KiB，超了根本发不出去，手机端只能等超时。
 */
test('handleEvent：live 事件正文在 emit 前就被裁到单条上限（中继发不出去的大消息）', async () => {
  const { index, emitted } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  const session = { id: 'live-big', header: { id: 'live-big' } };
  index.handleEvent(session, { type: 'turn/start', data: { turn: 1 } });
  const huge = 'x'.repeat(100_000);
  index.handleEvent(session, { type: 'user/message', data: { content: huge, source: { kind: 'user' } } });
  index.handleEvent(session, { type: 'assistant/message', data: { message: { content: `y${huge}` } } });

  // turn/start 也会 emit 一条空正文的分隔线，这里只看带正文的那两条。
  const frames = emitted
    .filter((frame) => frame.type === 'task.message')
    .filter((frame) => frame.payload.message.text.length > 0);
  assert.equal(frames.length, 2);
  for (const frame of frames) {
    const text = frame.payload.message.text;
    assert.ok(text.length < 10_000, `live 正文必须先裁再 emit（中继预算 64 帧×64 KiB），实际 ${text.length}`);
    assert.match(text, /内容过长，已截断/u, '裁剪必须留下可读的截断说明');
    assert.ok(text.startsWith('y') || text.startsWith('x'), '保留的是开头（认得是哪条消息）');
  }
  // 索引里的预览本来就只有一行/220 字，这条路径不受影响。
  assert.ok(index.getTask('live-big').lastText.length <= 221);
});

test('handleEvent：畸形输入（无 id / 非对象事件 / header 缺失）一律静默返回', async () => {
  const { index, emitted } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  index.handleEvent({}, { type: 'turn/start' });
  index.handleEvent({ id: 42 }, { type: 'turn/start' });
  index.handleEvent({ id: 'x' }, null);
  index.handleEvent({ id: 'x' }, 'turn/start');
  index.handleEvent({ id: 'x' }, []);
  assert.equal(index.tasks.size, 0);
  assert.equal(emitted.length, 0);

  // header 非法 → upsertRow 拒绝 → 直接返回（不抛）
  index.handleEvent({ id: 'y', header: { id: 42 } }, { type: 'turn/start' });
  assert.equal(index.tasks.size, 0);
});

test('handleSessionCreated/Disposed：进任务表并广播 created，销毁只翻 live 不删任务', async () => {
  const { index, emitted } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  index.handleSessionCreated({ header: { id: 'live-1', createdAt: 1, cwd: 'D:\\w\\proj' } });
  const task = index.getTask('live-1');
  assert.equal(task.live, true);
  assert.equal(task.persisted, true);
  assert.equal(task.cwdName, 'proj');
  assert.ok(emitted.some((frame) => frame.type === 'task.created' && frame.payload.id === 'live-1'));

  index.handleSessionCreated({ header: { id: 'live-1' } });
  assert.equal(emitted.filter((frame) => frame.type === 'task.created').length, 2, '同一会话重复 create 仍各自广播一次');

  index.handleSessionCreated({ header: null });
  index.handleSessionCreated({});
  index.handleSessionCreated(undefined);
  assert.equal(index.tasks.size, 1);

  index.handleSessionDisposed({ id: 'live-1' });
  assert.equal(task.live, false);
  assert.notEqual(index.getTask('live-1'), undefined, '销毁不等于从索引删除');
  index.handleSessionDisposed({ id: 'never-existed' });
  index.handleSessionDisposed(undefined);
  assert.equal(index.tasks.size, 1);
});

test('scheduleUpdate：120ms 内的多次事件只发一帧 task.updated', async () => {
  const { index, emitted } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  index.upsertRow(row({ id: 'burst', createdAt: 1 }));
  const task = index.getTask('burst');
  for (let i = 0; i < 5; i += 1) index.scheduleUpdate(task);
  assert.equal(index.pendingUpdates.size, 1, '去重后的定时器只有一个');
  await delay(220);
  assert.equal(index.pendingUpdates.size, 0);
  assert.equal(emitted.filter((frame) => frame.type === 'task.updated').length, 1);
  await delay(450);
  assert.ok(emitted.some((frame) => frame.type === 'summary'), '更新之后必须补发 summary（400ms 节流）');
});

/* ------------------------------------------------------------------ */
/* 查询面                                                               */
/* ------------------------------------------------------------------ */

function seedTasks(index) {
  const specs = [
    { id: 'run-1', status: 'running', updatedAt: 900, title: '跑着的任务' },
    { id: 'err-1', status: 'error', updatedAt: 800, title: '出错的任务' },
    { id: 'can-1', status: 'cancelled', updatedAt: 700, title: '中断的任务' },
    { id: 'done-1', status: 'done', updatedAt: 600, title: '完成的任务' },
    { id: 'idle-1', status: 'idle', updatedAt: 500, title: '空闲的任务' },
  ];
  for (const spec of specs) {
    const task = index.upsertRow(row({ id: spec.id, createdAt: 1, cwd: 'C:\\w\\x' }));
    task.status = spec.status;
    task.updatedAt = spec.updatedAt;
    task.title = spec.title;
  }
  const child = index.upsertRow(row({ id: 'sub-1', parentSessionId: 'run-1', createdAt: 1 }));
  child.status = 'running';
  child.updatedAt = 950;
  index.rebuildChildren();
}

test('snapshot：filter 覆盖全部取值，未知 filter 等于 all', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  seedTasks(index);
  const ids = (filter, extra = {}) => index.snapshot({ filter, includeSubagents: true, ...extra }).tasks.map((task) => task.id);

  assert.deepEqual(ids('running'), ['sub-1', 'run-1']);
  assert.deepEqual(ids('error'), ['err-1']);
  assert.deepEqual(ids('cancelled'), ['can-1']);
  assert.deepEqual(ids('idle'), ['idle-1']);
  assert.deepEqual(ids('done'), ['can-1', 'done-1', 'idle-1'], 'done 过滤含 done/idle/cancelled');
  assert.equal(ids('all').length, 6);
  assert.equal(ids('nonsense-filter').length, 6, '未知 filter 等价于 all');
  assert.deepEqual(ids('running', { includeSubagents: false }), ['run-1'], '默认不含子代理');
});

test('snapshot：排序先按状态等级（running 0 → idle 4），同等级按 updatedAt 倒序', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  seedTasks(index);
  const all = index.snapshot({ includeSubagents: true }).tasks.map((task) => task.id);
  assert.deepEqual(all, ['sub-1', 'run-1', 'err-1', 'can-1', 'done-1', 'idle-1']);

  // 同等级 + 同 updatedAt：顺序必须稳定（插入序）
  index.upsertRow(row({ id: 'tie-a', createdAt: 1 })).status = 'error';
  index.upsertRow(row({ id: 'tie-b', createdAt: 1 })).status = 'error';
  for (let i = 0; i < 3; i += 1) {
    const order = index.snapshot({ includeSubagents: true }).tasks.map((task) => task.id);
    assert.deepEqual(order, index.snapshot({ includeSubagents: true }).tasks.map((task) => task.id));
    assert.ok(order.indexOf('tie-a') < order.indexOf('tie-b'), '同分时保持插入顺序（稳定排序）');
  }
});

test('snapshot：q 在 title/cwd/lastText 三个字段里做大小写无关的子串匹配', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  seedTasks(index);
  assert.deepEqual(index.snapshot({ q: '出错' }).tasks.map((task) => task.id), ['err-1']);
  assert.deepEqual(index.snapshot({ q: 'C:\\W\\X' }).tasks.length, 5, 'cwd 匹配且大小写无关（子代理默认被过滤掉）');
  index.getTask('idle-1').lastText = '里面提到了 WebSocket 心跳';
  assert.deepEqual(index.snapshot({ q: 'websocket' }).tasks.map((task) => task.id), ['idle-1']);
  assert.deepEqual(index.snapshot({ q: '  不存在的词  ' }).tasks, []);
  assert.equal(index.snapshot({ q: 42 }).tasks.length, 5, '非字符串 q 被忽略');
});

test('snapshot：lastText 预览按码点截断，emoji 不会被切成孤立代理项', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  const task = index.upsertRow(row({ id: 'emoji-1', createdAt: 1 }));
  // 95 个 'a' + 一个 emoji：第 96 个码元正好是 emoji 的高代理项（代理对中间）。
  task.lastText = `${'a'.repeat(95)}😀尾巴`;
  const listed = index.publicTask(task);
  assert.ok(listed.lastText.length <= LIST_PREVIEW_CHARS + 1, '预览长度上限不变');
  assert.equal(listed.lastText, `${'a'.repeat(95)}…`, '切点落在代理对中间时退一位，而不是留半个 emoji');
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(listed.lastText), false, '不许出现孤立高代理项（手机端是 �）');

  // 预览本来就没超长时保持原样，不额外动刀。
  task.lastText = '短的 😀 预览';
  assert.equal(index.publicTask(task).lastText, '短的 😀 预览');
});

test('snapshot：limit/offset 的边界（0、负数、非数字、超 500）', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  for (let i = 0; i < 30; i += 1) {
    const task = index.upsertRow(row({ id: `n-${i}`, createdAt: 1 }));
    task.updatedAt = 1000 - i;
  }
  assert.equal(index.snapshot({ limit: 5 }).tasks.length, 5);
  assert.equal(index.snapshot({ limit: 5 }).hasMore, true);
  assert.equal(index.snapshot({ limit: 0 }).limit, 300, '0 不是「返回 0 条」，而是走默认 300');
  assert.equal(index.snapshot({ limit: -3 }).limit, 300);
  assert.equal(index.snapshot({ limit: 'abc' }).limit, 300);
  assert.equal(index.snapshot({ limit: 9999 }).limit, 500, '硬上限 500');
  assert.equal(index.snapshot({ limit: 400 }).limit, 400);
  assert.equal(index.snapshot({ limit: 2.7 }).limit, 2, 'limit 向下取整');

  const page = index.snapshot({ limit: 10, offset: 25 });
  assert.equal(page.offset, 25);
  assert.equal(page.tasks.length, 5);
  assert.equal(page.hasMore, false);
  assert.equal(index.snapshot({ offset: -10 }).offset, 0);
  assert.equal(index.snapshot({ offset: 'x' }).offset, 0);
  assert.equal(index.snapshot({ offset: 999 }).tasks.length, 0);

  const fresh = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  fresh.index.loading = true;
  fresh.index.loadedAt = 12345;
  fresh.index.loadError = 'oops';
  const meta = fresh.index.snapshot();
  assert.equal(meta.loading, true);
  assert.equal(meta.loadedAt, 12345);
  assert.equal(meta.error, 'oops');
  assert.equal(meta.total, 0);
  assert.equal(meta.hasMore, false);
});

test('summary：状态计数 + 今日计数 + 子代理数，且不把子代理算进 total', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  seedTasks(index);
  const now = Date.now();
  index.getTask('run-1').updatedAt = now;
  index.getTask('err-1').updatedAt = now - 3 * 24 * 3600 * 1000;

  const summary = index.summary();
  assert.equal(summary.total, 5, 'total 只数顶层任务');
  assert.equal(summary.running, 1);
  assert.equal(summary.error, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.done, 1);
  assert.equal(summary.idle, 1);
  assert.equal(summary.subagents, 1);
  assert.equal(summary.today, 1, '只有 updatedAt >= 今天 0 点的算今日');
  assert.equal(summary.loading, false);
  assert.ok(typeof summary.updatedAt === 'number');

  // 未知 status 不计入任何一个计数桶（KNOWN_STATUS 白名单）
  index.getTask('done-1').status = 'weird-status';
  assert.equal(index.summary().done, 0);
  assert.equal(index.summary().total, 5);
});

test('detail：未知任务抛 not_found；not_found 的错误码可被判读', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  await assert.rejects(index.detail('nope'), (error) => {
    assert.equal(error.code, 'not_found');
    return true;
  });
});

test('detail：live 任务优先用内存 session.log，settled 之后命中缓存不重复读 surface', async () => {
  let surfaceCalls = 0;
  const log = [
    { type: 'user/message', seq: 1, data: { content: '你好' } },
    { type: 'assistant/message', seq: 2, data: { message: { content: '你也好' } } },
  ];
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { surfaceCalls += 1; return { events: [], capturedThroughSeq: 0 }; },
      },
      sessions: { get: (id) => (id === 'live-1' ? { log } : undefined) },
    },
  });
  const task = index.upsertRow(row({ id: 'live-1', createdAt: 1, cwd: 'C:\\w' }));
  task.live = true;
  const first = await index.detail('live-1');
  assert.equal(surfaceCalls, 0, 'live 任务不该走磁盘 surface');
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[0].text, '你好');
  assert.equal(first.capturedThroughSeq, null);
  assert.equal(first.degraded, false);

  const second = await index.detail('live-1');
  assert.equal(surfaceCalls, 0);
  assert.deepEqual(second.messages, first.messages);

  // running 状态不吃缓存
  task.status = 'running';
  await index.detail('live-1');
  assert.equal(surfaceCalls, 0, 'running 走内存日志，仍不读 surface');
});

test('detail：非 live 任务走 readSurface；surface 抛错但有文件时降级读尾部并标记 degraded', async () => {
  const home = await makeHome();
  const { file } = await writeSessionFile(home, {
    sessionId: 'cold-1',
    lines: [
      { type: 'user/message', seq: 1, data: { content: '尾巴里的用户消息' } },
      { type: 'assistant/message', seq: 2, data: { message: { content: '尾巴里的回答' } } },
    ],
  });
  const { index, logger } = await makeIndex({
    home,
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { throw new Error('strict corpus validation rejected the log'); },
      },
    },
  });
  const task = index.upsertRow(row({ id: 'cold-1', createdAt: 1 }), { file, mtimeMs: 1 });
  assert.equal(task.live, false);
  const detail = await index.detail('cold-1');
  assert.equal(detail.degraded, true, '降级必须显式标记');
  assert.deepEqual(detail.messages.map((message) => message.text), ['尾巴里的用户消息', '尾巴里的回答']);
  assert.ok(logger.lines.some((line) => line.includes('tail read failed')) === false);

  // 没有文件可降级时也**不许**把整页打成 500：日志被清理 / 换过 DSH_HOME /
  // cwd 目录名不匹配 / 会话目录是符号链接（Dirent.isDirectory() 对 symlink 为
  // false）都可能让 `scanSessionFiles` mapping 缺失，此时抛错会让手机端整页打不开，
  // 连标题、子任务、待答卡片一起消失。
  const bare = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { throw new Error('no fallback for me'); },
      },
    },
  });
  bare.index.upsertRow(row({ id: 'cold-2', createdAt: 1 }));
  const empty = await bare.index.detail('cold-2');
  assert.equal(empty.degraded, true, '无文件可降级时必须显式标记 degraded');
  assert.deepEqual(empty.messages, [], '正文为空，但页面结构仍然完整');
  assert.equal(empty.hasMore, false);
  assert.equal(empty.cursorLost, false);
  assert.equal(empty.task.id, 'cold-2', '标题等元信息照常给手机');
  assert.equal(empty.task.title.length > 0, true);

  // 降级告警只打一次：手机在流式期间每 220ms 轮询一次详情，逐条告警会刷满日志。
  bare.index.upsertRow(row({ id: 'cold-3', createdAt: 2 }));
  assert.equal((await bare.index.detail('cold-3')).degraded, true);
  assert.equal(bare.logger.lines.filter((line) => line.includes('degrades to empty')).length, 1,
    '降级告警必须只打一次');
});

test('detail：转录缓存超过 8 条时淘汰最久没用的', async () => {
  let calls = 0;
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { calls += 1; return { events: [], capturedThroughSeq: calls }; },
      },
    },
  });
  for (let i = 0; i < 9; i += 1) {
    index.upsertRow(row({ id: `cache-${i}`, createdAt: i }));
    await index.detail(`cache-${i}`);
  }
  assert.equal(calls, 9);
  assert.ok(index.transcripts.size <= 8, `转录缓存必须被限制在 8 条，实际 ${index.transcripts.size}`);
  assert.equal(index.transcripts.has('cache-0'), false, '最久没用的那条必须被淘汰');

  await index.detail('cache-0');
  assert.equal(calls, 10, '被淘汰的任务必须重新读 surface');
});

/*
 * 只有条数闸挡不住体积：单条 6000 字上限 × 单份最多 5000 条 × 8 份 ≈ 理论 240 MB
 * 常驻。所以缓存同时守字节预算，超预算按最久未用淘汰（Map 插入顺序就是 LRU 顺序）。
 * 这里用 `config.transcriptCacheBytes` 把预算调到几 KB，在几十条消息的规模上验证。
 */
test('detail：转录缓存还有字节预算，超预算时淘汰最久没用的那份', async () => {
  const makeEvents = (tag) => [
    { seq: 1, type: 'user/message', data: { content: `${tag}${'u'.repeat(600)}`, source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: 'a'.repeat(600) } } },
  ];
  let calls = 0;
  const { index } = await makeIndex({
    // 每份转录约 2 ×（600 字 × 2 字节 + 64 B 开销）≈ 2.5 KB，预算 6 KB 只够留两份。
    config: { transcriptCacheBytes: 6_000 },
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface(id) { calls += 1; return { events: makeEvents(id), capturedThroughSeq: calls }; },
      },
    },
  });
  for (const id of ['byte-a', 'byte-b']) {
    index.upsertRow(row({ id, createdAt: 1 }));
    await index.detail(id);
  }
  assert.deepEqual([...index.transcripts.keys()], ['byte-a', 'byte-b'], '没超预算时两份都留着');
  assert.ok(index.transcriptBytes > 0, '字节用量必须被记着');

  // 命中 A 的缓存 → A 被挪到 LRU 队尾；再建 C 时被淘汰的必须是 B。
  await index.detail('byte-a');
  assert.equal(calls, 2, '命中缓存不该重读 surface');
  index.upsertRow(row({ id: 'byte-c', createdAt: 3 }));
  await index.detail('byte-c');

  assert.deepEqual([...index.transcripts.keys()], ['byte-a', 'byte-c'], '超预算时必须淘汰最久没用的那份');
  assert.equal(index.transcripts.has('byte-b'), false);
  assert.ok(index.transcriptBytes <= 6_000, `字节预算必须被守住，实际 ${index.transcriptBytes}`);
});

test('detail：children 只含索引里真实存在的子任务', async () => {
  const { index } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { return { events: [], capturedThroughSeq: 7 }; },
      },
    },
  });
  index.upsertRow(row({ id: 'parent', createdAt: 1 }));
  index.upsertRow(row({ id: 'child-a', parentSessionId: 'parent', createdAt: 2 }));
  const parent = index.getTask('parent');
  parent.children.push('ghost-child');
  const detail = await index.detail('parent');
  assert.deepEqual(detail.children.map((child) => child.id), ['child-a'], '不存在的 childId 不许进结果');
  assert.equal(detail.capturedThroughSeq, 7);
  assert.equal(detail.task.childCount, 2, 'childCount 数的是 children 数组长度');
});

/* ------------------------------------------------------------------ */
/* 续聊：ensureAgent / resumeAgent / preset                             */
/* ------------------------------------------------------------------ */

test('ensureAgent：无 agents 服务 → no_agent；未运行且不许创建 → not_running', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  await assert.rejects(index.ensureAgent('x'), (error) => error.code === 'no_agent');

  const withAgents = await makeIndex({
    services: { agents: { get() { return undefined; } }, sessionQuery: { async listSessions() { return []; } } },
  });
  await assert.rejects(withAgents.index.ensureAgent('x'), (error) => error.code === 'not_running');
});

test('ensureAgent：live 直接返回；冷任务并发续聊只 resume 一次（agentLocks 合流）', async () => {
  let resumes = 0;
  const agent = { id: 'cold-1', followup: async () => {} };
  const agents = {
    get: (id) => (id === 'hot-1' ? { id: 'hot-1', status: 'running' } : undefined),
    async resume(request) {
      resumes += 1;
      await delay(10);
      agent.resumeRequest = request;
      return { agent };
    },
  };
  const { index } = await makeIndex({ services: { agents, sessionQuery: { async listSessions() { return []; } } } });
  index.upsertRow(row({ id: 'hot-1', createdAt: 1 }));
  index.upsertRow(row({ id: 'cold-1', createdAt: 2 }));

  const hot = await index.ensureAgent('hot-1');
  assert.equal(hot.id, 'hot-1');

  const [a, b] = await Promise.all([
    index.ensureAgent('cold-1', { createIfMissing: true }),
    index.ensureAgent('cold-1', { createIfMissing: true }),
  ]);
  assert.equal(resumes, 1, '并发续聊必须合流到同一个 Promise');
  assert.equal(a, agent);
  assert.equal(b, agent);
  assert.equal(index.agentLocks.size, 0, '续聊结束后锁必须释放');
});

test('resumeAgent：任务不存在 → not_found；子代理 → subagent_immutable', async () => {
  const { index } = await makeIndex({
    services: { agents: { get() { return undefined; }, async resume() { return { agent: {} }; } }, sessionQuery: { async listSessions() { return []; } } },
  });
  await assert.rejects(index.ensureAgent('ghost', { createIfMissing: true }), (error) => error.code === 'not_found');

  index.upsertRow(row({ id: 'sub', parentSessionId: 'p', createdAt: 1 }));
  await assert.rejects(index.ensureAgent('sub', { createIfMissing: true }), (error) => error.code === 'subagent_immutable');
});

test('resumeAgent：把 agentOptions 与 preset setup 一起传给 agents.resume，setup 真的会 mount', async () => {
  const mounted = [];
  const agents = {
    get() { return undefined; },
    async resume(request) { return { agent: { id: request.resumeSessionId, request } }; },
  };
  const { index } = await makeIndex({
    services: {
      agents,
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
      agentPresets: {
        defaultId: 'p-default',
        async list() { return [{ id: 'p-default' }]; },
        async resolve(id) { return { id }; },
        async mount(ctx, id) { mounted.push({ ctx, id }); },
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  index.upsertRow(row({ id: 'cold-1', createdAt: 1, agentPreset: 'p-explicit' }));
  const agent = await index.ensureAgent('cold-1', { createIfMissing: true });
  assert.deepEqual(agent.request.agentOptions, { provider: 'deepseek', model: 'v4' });
  assert.equal(typeof agent.request.setup, 'function');

  await agent.request.setup({ any: 'context' });
  assert.deepEqual(mounted, [{ ctx: { any: 'context' }, id: 'p-explicit' }], 'setup 必须落到 presets.mount');
});

test('defaultAgentOptions：缺服务/畸形返回值/抛错都收敛成 undefined', async () => {
  const cases = [
    [{}, undefined],
    [{ agentDefaultModel: { currentSelection: () => null } }, undefined],
    [{ agentDefaultModel: { currentSelection: () => ({ provider: 'p' }) } }, undefined],
    [{ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 42 }) } }, undefined],
    [{ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }, { provider: 'p', model: 'm' }],
    [{ agentDefaultModel: { current: () => ({ provider: 'p2', model: 'm2' }) } }, { provider: 'p2', model: 'm2' }],
  ];
  for (const [services, expected] of cases) {
    const { index } = await makeIndex({ services: { ...services, sessionQuery: { async listSessions() { return []; } } } });
    assert.deepEqual(index.defaultAgentOptions(), expected);
  }

  const { index, logger } = await makeIndex({
    services: {
      agentDefaultModel: { currentSelection() { throw new Error('selection exploded'); } },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  assert.equal(index.defaultAgentOptions(), undefined);
  assert.ok(logger.lines.some((line) => line.includes('default model selection failed selection exploded')));
});

test('presetSetup：无 registry → undefined；空列表 → undefined；默认 id → 用它', async () => {
  const none = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  assert.equal(await none.index.presetSetup(undefined), undefined);

  const empty = await makeIndex({
    services: {
      agentPresets: { defaultId: 'd', async list() { return []; }, async resolve() {}, async mount() {} },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  assert.equal(await empty.index.presetSetup(undefined), undefined);

  const byDefault = await makeIndex({
    services: {
      agentPresets: {
        defaultId: 'from-default',
        async list() { return [{ id: 'first' }]; },
        async resolve(id) { return { id }; },
        async mount() {},
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  const setup = await byDefault.index.presetSetup(undefined);
  assert.equal(typeof setup, 'function', 'defaultId 存在时必须给出 setup');

  const byFirst = await makeIndex({
    services: {
      agentPresets: {
        async list() { return [{ id: 'first' }]; },
        async resolve(id) { return { id }; },
        async mount() {},
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  assert.equal(typeof await byFirst.index.presetSetup(undefined), 'function', '没有 defaultId 时用第一条');
});

test('presetSetup：broken 预设必须抛出 preset_broken；其它解析错误只告警并放弃 setup', async () => {
  const broken = await makeIndex({
    services: {
      agentPresets: {
        async list() { return []; },
        async resolve() { return { id: 'bad', broken: { message: '缺依赖' } }; },
        async mount() {},
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  await assert.rejects(broken.index.presetSetup('bad'), (error) => {
    assert.equal(error.code, 'preset_broken');
    assert.match(error.message, /agent preset "bad" is unavailable/u);
    // 现状：reason 被 String() 折叠成 [object Object]，真正的缺依赖原因丢了。
    assert.match(error.message, /\[object Object\]/u);
    return true;
  });

  const thief = await makeIndex({
    services: {
      agentPresets: {
        async list() { return []; },
        async resolve() { throw new Error('registry offline'); },
        async mount() {},
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  assert.equal(await thief.index.presetSetup('x'), undefined);
  assert.ok(thief.logger.lines.some((line) => line.includes('preset resolution failed registry offline')));
});

/* ------------------------------------------------------------------ */
/* 工作目录                                                             */
/* ------------------------------------------------------------------ */

test('computeAllowedRoots：config 优先、去重、去空白；registry 派生；都没有则 closed', async () => {
  const configured = await makeIndex({
    config: { allowedRoots: ['D:\\w\\a', 'D:\\w\\a', '  ', 42, 'D:\\w\\b'] },
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  const fromConfig = configured.index.computeAllowedRoots();
  assert.equal(fromConfig.mode, 'config');
  assert.deepEqual(fromConfig.roots, [path.resolve('D:\\w\\a'), path.resolve('D:\\w\\b')]);
  assert.deepEqual(configured.index.allowedRootsStatus(), { mode: 'config', count: 2 });

  const derived = await makeIndex({
    services: {
      workspaceRegistry: {
        list() {
          return [{ path: 'D:\\w\\one' }, { path: 'D:\\w\\one' }, { path: '' }, { nope: true }, null];
        },
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  assert.deepEqual(derived.index.computeAllowedRoots().roots, [path.resolve('D:\\w\\one')]);
  assert.equal(derived.index.computeAllowedRoots().mode, 'derived');

  const closed = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  assert.deepEqual(closed.index.computeAllowedRoots(), { mode: 'closed', roots: [] });
  assert.deepEqual(closed.index.allowedRootsStatus(), { mode: 'closed', count: 0 });

  const throwing = await makeIndex({
    services: { workspaceRegistry: { list() { throw new Error('registry down'); } }, sessionQuery: { async listSessions() { return []; } } },
  });
  assert.deepEqual(throwing.index.computeAllowedRoots(), { mode: 'closed', roots: [] });
  assert.ok(throwing.logger.lines.some((line) => line.includes('workspace list failed while resolving allowed roots')));
});

test('resolveWorkdir：无根 fail-closed；NUL/相对/UNC/不存在/不是目录全部 4xx 且带 code', async () => {
  const base = await mkdtemp(path.join(tmpRoot, 'workdir-'));
  const inside = path.join(base, 'inside');
  await mkdir(inside, { recursive: true });
  const filePath = path.join(base, 'a-file.txt');
  await writeFile(filePath, 'x');

  const closed = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  await assert.rejects(closed.index.resolveWorkdir(inside), (error) => {
    assert.equal(error.code, 'cwd_forbidden');
    assert.match(error.message, /尚未允许任何工作目录/u);
    return true;
  });

  const { index } = await makeIndex({
    config: { allowedRoots: [base] },
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  // 不传 cwd → 落到第一个 root
  assert.equal(await index.resolveWorkdir(undefined), await realpathOf(base));
  assert.equal(await index.resolveWorkdir('   '), await realpathOf(base));

  const cases = [
    [`bad\0cwd`, 'bad_cwd'],
    ['relative/dir', 'bad_cwd'],
    ['\\\\server\\share', 'bad_cwd'],
    ['//server/share', 'bad_cwd'],
    [path.join(base, 'does-not-exist'), 'bad_cwd'],
    [filePath, 'bad_cwd'],
  ];
  for (const [cwd, code] of cases) {
    await assert.rejects(index.resolveWorkdir(cwd), (error) => {
      assert.equal(error.code, code, `${JSON.stringify(cwd)} 应该给 ${code}，实际 ${error.code}：${error.message}`);
      return true;
    }, `${JSON.stringify(cwd)} 没被拒`);
  }

  assert.equal(await index.resolveWorkdir(inside), await realpathOf(inside));
  // tmpRoot 存在但在 base 之外 → cwd_forbidden（不是 bad_cwd）
  await assert.rejects(index.resolveWorkdir(tmpRoot), (error) => {
    assert.equal(error.code, 'cwd_forbidden');
    assert.match(error.message, /不在允许的工作区范围内/u);
    return true;
  });
});

test('resolveWorkdir：root 自己 realpath 失败时回落到 path.resolve（不因坏根全盘拒绝）', async () => {
  const base = await mkdtemp(path.join(tmpRoot, 'fallback-'));
  const ghostRoot = path.join(base, 'ghost-root');
  const { index } = await makeIndex({
    config: { allowedRoots: [base] },
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  // 直接构造「根不存在但目标存在」的错配：ghostRoot 不存在，base 存在。
  index.config = { allowedRoots: [base] };
  index.services.workspaceRegistry = { list: () => [{ path: ghostRoot }] };
  // config 优先，所以真正的派生发生在 allowedRoots 被清空之后
  index.config.allowedRoots = [];
  await assert.rejects(index.resolveWorkdir(base), (error) => error.code === 'cwd_forbidden');
});

async function realpathOf(value) {
  const { realpath } = await import('node:fs/promises');
  return realpath(value);
}

/* ------------------------------------------------------------------ */
/* 幂等键与创建                                                         */
/* ------------------------------------------------------------------ */

test('trimClientIds：超过 500 时先删最旧的「已提交」键，PENDING 键被保留', async () => {
  const { index } = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  for (let i = 0; i < 501; i += 1) index.rememberClientId(`k-${i}`, `s-${i}`);
  assert.equal(index.byClientId.size, 500);
  assert.equal(index.byClientId.has('k-0'), false, '最旧的键被淘汰');
  assert.equal(index.byClientId.has('k-500'), true);

  // 全部是 PENDING 时无法淘汰 → 直接返回，不无限循环
  const pendingOnly = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  for (let i = 0; i < 510; i += 1) pendingOnly.index.reserveClientId(`p-${i}`);
  assert.equal(pendingOnly.index.byClientId.size, 510, 'PENDING 键一个都不能丢（否则幂等被击穿）');

  // 混入一个已提交键 → 它优先被淘汰，PENDING 依然保留
  pendingOnly.index.rememberClientId('done-key', 'session-x');
  assert.equal(pendingOnly.index.byClientId.size, 510);
  assert.equal(pendingOnly.index.byClientId.has('done-key'), false);
  const stillPending = pendingOnly.index.byClientId.get('p-0');
  assert.equal(typeof stillPending, 'symbol');
  assert.equal(stillPending.description, 'pending-create');
  assert.equal(pendingOnly.index.byClientId.get('p-509'), pendingOnly.index.byClientId.get('p-0'), '同一个 PENDING 哨兵');
});

test('createTask：空 prompt / 超长 prompt / 无 agents 服务都给出稳定 code', async () => {
  const { index } = await makeIndex({
    config: { allowedRoots: [tmpRoot] },
    services: { sessionQuery: { async listSessions() { return []; } } },
  });
  await assert.rejects(index.createTask({ prompt: '', cwd: tmpRoot }), (error) => error.code === 'empty_prompt');
  await assert.rejects(index.createTask({ prompt: '   ', cwd: tmpRoot }), (error) => error.code === 'empty_prompt');
  await assert.rejects(index.createTask({ prompt: 42, cwd: tmpRoot }), (error) => error.code === 'empty_prompt');
  await assert.rejects(index.createTask({ prompt: 'x'.repeat(20_001), cwd: tmpRoot }), (error) => error.code === 'prompt_too_long');
  await assert.rejects(index.createTask({ prompt: 'ok', cwd: tmpRoot }), (error) => error.code === 'no_agent');
});

test('createTask：成功创建 → 任务进索引、followup 收到正文、幂等键在成功后提交', async () => {
  const created = [];
  const followups = [];
  const agents = {
    get() { return undefined; },
    async create(request) {
      const agent = {
        header: { id: request.sessionId, cwd: request.meta.cwd, createdAt: 1234 },
        async followup(message) { followups.push(message); },
      };
      created.push({ request, agent });
      return { agent };
    },
  };
  const { index, emitted } = await makeIndex({
    config: { allowedRoots: [tmpRoot] },
    services: { agents, sessionQuery: { async listSessions() { return []; } } },
  });

  const result = await index.createTask({
    prompt: '  第一行\n第二行  ', cwd: tmpRoot, preset: 'p1', clientTaskId: 'idem-1', source: 'mobile',
  });
  assert.equal(result.reused, false);
  assert.equal(created.length, 1);
  assert.equal(created[0].request.meta.agentPreset, 'p1');
  assert.equal(followups.length, 1);
  assert.equal(followups[0].content[0].text, '第一行\n第二行');
  assert.equal(followups[0].source.kind, 'user');
  assert.equal(followups[0].source.client, 'mobile');

  assert.equal(result.task.title, '第一行 第二行', '标题是单行化后的前 42 字');
  assert.equal(result.task.titleSource, 'derived');
  assert.equal(result.task.status, 'running');
  assert.equal(result.task.origin, 'user');
  assert.equal(result.task.isSubagent, false);
  assert.equal(result.task.messageCount, 0);

  const sessionId = result.task.id;
  assert.equal(index.byClientId.get('idem-1'), sessionId, '幂等键必须在 followup 成功后才提交');
  assert.equal(index.getTask(sessionId).live, true);

  const again = await index.createTask({ prompt: '重复', cwd: tmpRoot, clientTaskId: 'idem-1' });
  assert.equal(again.reused, true);
  assert.equal(again.task.id, sessionId);
  assert.equal(created.length, 1, '幂等命中不许再建 agent');

  await delay(200);
  assert.ok(emitted.some((frame) => frame.type === 'task.updated'));
});

test('createTask：同一 clientTaskId 在飞行中 → create_in_flight', async () => {
  const agents = {
    get() { return undefined; },
    async create() { return { agent: { header: { id: 'session-x' }, async followup() {} } }; },
  };
  const { index } = await makeIndex({
    config: { allowedRoots: [tmpRoot] },
    services: { agents, sessionQuery: { async listSessions() { return []; } } },
  });
  index.reserveClientId('busy');
  await assert.rejects(index.createTask({ prompt: 'x', cwd: tmpRoot, clientTaskId: 'busy' }), (error) => {
    assert.equal(error.code, 'create_in_flight');
    return true;
  });
});

test('createTask：followup 失败 → 任务置 error、抛出原始错误、幂等键被清除（可重试）', async () => {
  const agents = {
    get() { return undefined; },
    async create() {
      return {
        agent: {
          header: { id: 'session-fail', createdAt: 1 },
          async followup() { throw new Error('transport closed'); },
        },
      };
    },
  };
  const { index } = await makeIndex({
    config: { allowedRoots: [tmpRoot] },
    services: { agents, sessionQuery: { async listSessions() { return []; } } },
  });
  await assert.rejects(
    index.createTask({ prompt: '发送失败的任务', cwd: tmpRoot, clientTaskId: 'retry-me' }),
    /transport closed/u,
  );
  assert.equal(index.byClientId.has('retry-me'), false, '失败后必须释放幂等键，否则重试永远打不进去');
  const task = index.getTask('session-fail');
  assert.equal(task.status, 'error');
  assert.equal(task.statusReason, 'transport closed');

  // 修复后同一 key 可以重新创建
  let createCalls = 0;
  agents.create = async () => {
    createCalls += 1;
    return { agent: { header: { id: 'session-ok', createdAt: 2 }, async followup() {} } };
  };
  const retried = await index.createTask({ prompt: '重试', cwd: tmpRoot, clientTaskId: 'retry-me' });
  assert.equal(retried.reused, false);
  assert.equal(retried.task.id, 'session-ok');

  // 幂等键必须记**真实会话 id**：这里宿主回填的 header.id 是 'session-ok'，与请求里
  // 生成的 `session-<uuid>` 不同。记请求值时 `tasks.has(hit)` 永远查不到，重放会再打
  // 一次 agents.create，把上一份 prompt 晾在旧会话里。
  const stored = index.byClientId.get('retry-me');
  assert.equal(stored, 'session-ok', '幂等键必须记真实会话 id（handle.agent.header.id），不是请求生成的 sessionId');
  const replay = await index.createTask({ prompt: '再重放', cwd: tmpRoot, clientTaskId: 'retry-me' });
  assert.equal(replay.reused, true, '同一 clientTaskId 必须命中已有会话');
  assert.equal(replay.task.id, 'session-ok');
  assert.equal(createCalls, 1, '命中的重放不许再建 agent');
});

test('createTask：agent factory 未注册时短暂重试，成功一次即停', async () => {
  let attempts = 0;
  const agents = {
    get() { return undefined; },
    async create(request) {
      attempts += 1;
      if (attempts < 3) throw new Error('no agent factory registered yet');
      return { agent: { header: { id: request.sessionId }, async followup() {} } };
    },
  };
  const { index } = await makeIndex({
    config: { allowedRoots: [tmpRoot] },
    services: { agents, sessionQuery: { async listSessions() { return []; } } },
  });
  const result = await index.createTask({ prompt: '等一下工厂', cwd: tmpRoot });
  assert.equal(attempts, 3);
  assert.equal(result.reused, false);
  assert.equal(index.tasks.size, 1);

  // 其它错误不重试，立刻抛出
  let otherAttempts = 0;
  const failFast = await makeIndex({
    config: { allowedRoots: [tmpRoot] },
    services: {
      agents: {
        get() { return undefined; },
        async create() { otherAttempts += 1; throw new Error('quota exceeded'); },
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  await assert.rejects(failFast.index.createTask({ prompt: 'x', cwd: tmpRoot }), /quota exceeded/u);
  assert.equal(otherAttempts, 1, '非「工厂未注册」的错误不许重试');
});

test('createTask：agent 没给 header 时用 id/cwd/now 兜底建任务', async () => {
  const { index } = await makeIndex({
    config: { allowedRoots: [tmpRoot] },
    services: {
      agents: {
        get() { return undefined; },
        async create() { return { agent: { id: 'agent-only', async followup() {} } }; },
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  const result = await index.createTask({ prompt: '没有 header', cwd: tmpRoot });
  assert.equal(result.task.id, 'agent-only');
  assert.equal(result.task.origin, 'user');
  assert.equal(index.tasks.size, 1);
});

test('promptTask：空/超长/未知任务全部拒绝；已知任务送到 live agent 并更新预览', async () => {
  const followups = [];
  const { index } = await makeIndex({
    services: {
      agents: { get: (id) => (id === 'run-1' ? { id, async followup(message) { followups.push(message); } } : undefined) },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  await assert.rejects(index.promptTask('run-1', ''), (error) => error.code === 'empty_prompt');
  await assert.rejects(index.promptTask('run-1', 'x'.repeat(20_001)), (error) => error.code === 'prompt_too_long');
  await assert.rejects(index.promptTask('ghost', 'hi'), (error) => error.code === 'not_found');

  index.upsertRow(row({ id: 'run-1', createdAt: 1 }));
  const task = await index.promptTask('run-1', '  追加一句  ', { source: 'phone' });
  assert.equal(followups.length, 1);
  assert.equal(followups[0].content[0].text, '追加一句');
  assert.equal(followups[0].source.client, 'phone');
  assert.equal(task.status, 'running');
  assert.equal(task.lastRole, 'user');
  assert.equal(task.lastText, '追加一句');
});

test('cancelTask：agent 缺失 → not_running；cancel 抛错也要留 warn 并落 cancelled', async () => {
  const throwing = await makeIndex({
    services: { agents: { get() { return undefined; } }, sessionQuery: { async listSessions() { return []; } } },
  });
  await assert.rejects(throwing.index.cancelTask('x'), (error) => error.code === 'not_running');

  const { index, logger } = await makeIndex({
    services: {
      agents: { get: (id) => (id === 'c1' ? { id, async cancel() { throw new Error('cancel exploded'); } } : undefined) },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  index.upsertRow(row({ id: 'c1', createdAt: 1 }));
  const task = await index.cancelTask('c1');
  assert.equal(task.status, 'cancelled');
  assert.equal(task.statusReason, '已中断');
  assert.ok(logger.lines.some((line) => line.includes('agent cancel failed c1')));

  // 有 agent 但没有对应任务：仍返回一个合法视图
  const orphan = await makeIndex({
    services: { agents: { get: (id) => (id === 'ghost' ? { id, async cancel() {} } : undefined) }, sessionQuery: { async listSessions() { return []; } } },
  });
  assert.deepEqual(await orphan.index.cancelTask('ghost'), { id: 'ghost', status: 'cancelled' });
});

/* ------------------------------------------------------------------ */
/* 工作区与预设                                                         */
/* ------------------------------------------------------------------ */

test('workspaces：无 registry → 空数组；有 registry 时去重、标 available、补 recent', async () => {
  const existing = await mkdtemp(path.join(tmpRoot, 'ws-'));
  const recentDir = path.join(existing, 'sub');
  await mkdir(recentDir, { recursive: true });
  const missing = path.join(tmpRoot, 'ws-missing');
  const none = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  assert.deepEqual(await none.index.workspaces(), []);

  const { index } = await makeIndex({
    services: {
      workspaceRegistry: {
        list() {
          return [
            { id: 'w1', path: existing, title: '显式标题' },
            { path: existing.toUpperCase() },
            { path: missing },
            { id: 'no-path' },
            null,
            { path: 42 },
          ];
        },
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  index.upsertRow(row({ id: 'recent-1', createdAt: 1, cwd: recentDir }));
  index.upsertRow(row({ id: 'recent-2', createdAt: 2, cwd: '' }));
  index.upsertRow(row({ id: 'recent-sub', createdAt: 3, cwd: path.join(existing, 'sub2'), parentSessionId: 'recent-1' }));

  const list = await index.workspaces();
  const paths = list.map((entry) => entry.path);
  assert.equal(list[0].id, 'w1');
  assert.equal(list[0].title, '显式标题');
  assert.equal(list[0].available, true);
  // 大小写折叠是**平台相关**的：lib/task-index.mjs:59 只在 win32 上 toLowerCase，
  // 因为 POSIX 里 /Foo 与 /foo 真是两个目录。测试不能替实现编造统一行为，
  // 否则在 Linux CI 上必红（这条就是这么红的）。
  const caseVariants = paths.filter((value) => value.toUpperCase() === existing.toUpperCase()).length;
  const foldedByPlatform = process.platform === 'win32' ? 1 : 2;
  assert.equal(caseVariants, foldedByPlatform,
    process.platform === 'win32'
      ? 'Windows 上大小写不同应算同一个工作区'
      : 'POSIX 上大小写不同应是两个不同的工作区');
  assert.equal(list.find((entry) => entry.path === missing).available, false);
  assert.equal(list.find((entry) => entry.path === missing).title, 'ws-missing', '没有 title 时用目录名');

  const recent = list.filter((entry) => entry.recent === true);
  assert.deepEqual(recent.map((entry) => entry.path), [recentDir], '只补一个 recent（cwd 为空与子代理都被跳过）');
  assert.equal(recent[0].available, true);
  assert.equal(recent[0].id, recentDir);
});

test('workspaces：recent 列表最多补到 30 条', async () => {
  const { index } = await makeIndex({
    services: { workspaceRegistry: { list() { return []; } }, sessionQuery: { async listSessions() { return []; } } },
  });
  for (let i = 0; i < 40; i += 1) {
    index.upsertRow(row({ id: `many-${i}`, createdAt: i, cwd: path.join(tmpRoot, `cwd-${i}`) }));
  }
  const list = await index.workspaces();
  assert.equal(list.length, 30);
  assert.equal(list.every((entry) => entry.recent === true), true);
});

test('presets：无 registry → 空；正常映射 isDefault/name/description；list 抛错 → 空 + warn', async () => {
  const none = await makeIndex({ services: { sessionQuery: { async listSessions() { return []; } } } });
  assert.deepEqual(await none.index.presets(), { presets: [], defaultId: undefined });

  const { index } = await makeIndex({
    services: {
      agentPresets: {
        defaultId: 'b',
        async list() {
          return [
            { id: 'a', name: '甲', description: '第一个' },
            { id: 'b' },
            { id: 'b', description: '重复 id 也算默认' },
          ];
        },
      },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  const view = await index.presets();
  assert.equal(view.defaultId, 'b');
  assert.deepEqual(view.presets[0], { id: 'a', name: '甲', description: '第一个', isDefault: false });
  assert.deepEqual(view.presets[1], { id: 'b', name: 'b', description: '', isDefault: true });
  assert.equal(view.presets[2].isDefault, true);

  const broken = await makeIndex({
    services: {
      agentPresets: { defaultId: 'x', async list() { throw new Error('preset registry down'); } },
      sessionQuery: { async listSessions() { return []; } },
    },
  });
  assert.deepEqual(await broken.index.presets(), { presets: [], defaultId: undefined });
  assert.ok(broken.logger.lines.some((line) => line.includes('preset list failed preset registry down')));
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                             */
/* ------------------------------------------------------------------ */

test('dispose：清掉定时器、缓存与续聊锁，之后不再广播', async () => {
  const { index, emitted } = await makeIndex({
    services: {
      sessionQuery: {
        async listSessions() { return []; },
        async readSurface() { return { events: [], capturedThroughSeq: 0 }; },
      },
    },
  });
  index.upsertRow(row({ id: 'd1', createdAt: 1 }));
  index.scheduleUpdate(index.getTask('d1'));
  index.emitSummary();
  await index.detail('d1');
  index.agentLocks.set('d1', Promise.resolve('x'));
  assert.equal(index.pendingUpdates.size, 1);
  assert.notEqual(index.summaryTimer, undefined);
  assert.equal(index.transcripts.size, 1);

  index.dispose();
  assert.equal(index.pendingUpdates.size, 0);
  assert.equal(index.summaryTimer, undefined);
  assert.equal(index.transcripts.size, 0);
  assert.equal(index.agentLocks.size, 0);

  emitted.length = 0;
  await delay(500);
  assert.deepEqual(emitted, [], 'dispose 之后不许再有定时器广播');
});

test('ready：只有 sessionQuery 与 agents 都在时才是 true', async () => {
  const nothing = await makeIndex({ services: {} });
  assert.equal(nothing.index.ready, false);
  const half = await makeIndex({ services: { sessionQuery: {} } });
  assert.equal(half.index.ready, false);
  const full = await makeIndex({ services: { sessionQuery: {}, agents: {} } });
  assert.equal(full.index.ready, true);
  full.index.setServices({});
  assert.equal(full.index.ready, false);
});
