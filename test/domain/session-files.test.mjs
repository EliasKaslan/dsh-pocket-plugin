/**
 * 会话文件读写（lib/session-files.mjs）——只读的 zstd 帧尾巴读取。
 *
 * 真实 DSH 的日志是「每行一个 JSON、按 zstd 帧追加」的二进制文件，所以这里的
 * 断言全部用真实的 zstdCompressSync 造帧，再让被测代码自己找 magic、自己解压：
 * 不 mock 解压，也不 mock 文件系统（os.tmpdir() 一次性目录，after 删干净）。
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import {
  lastOfType, readTailEvents, readTailEventsSync, scanSessionFiles, sessionRoot,
} from '../../lib/session-files.mjs';

let root;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-session-files-'));
});

after(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** 一个用例一个子目录，互不干扰。 */
function scratch(name) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把事件压成一个 zstd 帧（JSONL 正文），与 DSH 的追加格式一致。 */
function frame(events) {
  const text = events.map((event) => JSON.stringify(event)).join('\n');
  return zstdCompressSync(Buffer.from(`${text}\n`, 'utf8'));
}

function writeFile(dir, name, chunks) {
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))));
  return file;
}

/* --------------------------------------------------------------- sessionRoot */

test('sessionRoot 把 home 拼上 sessions 一层', () => {
  assert.equal(sessionRoot(path.join('C:', 'dsh')), path.join('C:', 'dsh', 'sessions'));
  assert.equal(sessionRoot('/home/me/.dsh'), path.join('/home/me/.dsh', 'sessions'));
});

/* ----------------------------------------------------------- scanSessionFiles */

test('scanSessionFiles：sessions 目录不存在时返回空 Map，不抛异常', () => {
  assert.deepEqual([...scanSessionFiles(path.join(root, '根本没有这个目录')).entries()], []);
  assert.deepEqual([...scanSessionFiles(path.join(root, 'nope')).entries()], []);
});

test('scanSessionFiles：两层目录（cwd/session）才认，非目录与非会话文件都跳过', () => {
  const home = scratch('scan-basic');
  const sessions = path.join(home, 'sessions');
  mkdirSync(path.join(sessions, 'proj-a', 'sess-1'), { recursive: true });
  mkdirSync(path.join(sessions, 'proj-a', 'sess-2'), { recursive: true });
  // 根下的普通文件不是 workspace 目录。
  writeFileSync(path.join(sessions, 'stray.jsonl'), '{}');
  // workspace 层的一个文件（不是目录）必须跳过。
  writeFileSync(path.join(sessions, 'proj-a', 'session.jsonl'), '{}');
  // 会话目录里的非会话文件、目录、备份名。
  writeFileSync(path.join(sessions, 'proj-a', 'sess-1', 'session.jsonl'), '{"seq":1}\n');
  writeFileSync(path.join(sessions, 'proj-a', 'sess-1', 'notes.txt'), 'x');
  writeFileSync(path.join(sessions, 'proj-a', 'sess-1', 'session.jsonl.tmp'), 'x');
  mkdirSync(path.join(sessions, 'proj-a', 'sess-1', 'session.extra.jsonl'), { recursive: true });
  // 只有不合规文件 → 这个会话不进 map。
  writeFileSync(path.join(sessions, 'proj-a', 'sess-2', 'readme.md'), 'x');

  const map = scanSessionFiles(home);
  assert.deepEqual([...map.keys()], ['sess-1']);
  const entry = map.get('sess-1');
  assert.equal(entry.file, path.join(sessions, 'proj-a', 'sess-1', 'session.jsonl'));
  assert.equal(typeof entry.mtimeMs, 'number');
  assert.equal(entry.size, statSync(entry.file).size);
  assert.equal(entry.mtimeMs, Math.round(statSync(entry.file).mtimeMs), 'mtime 必须取整（ms 精度）');
});

test('scanSessionFiles：同一会话多个候选文件时取 mtime 最新的那个', () => {
  const home = scratch('scan-newest');
  const dir = path.join(home, 'sessions', 'proj-b', 'sess-multi');
  mkdirSync(dir, { recursive: true });
  const plain = path.join(dir, 'session.jsonl');
  const rotated = path.join(dir, 'session.1.jsonl');
  const compressed = path.join(dir, 'session.jsonl.zstd');
  for (const file of [plain, rotated, compressed]) writeFileSync(file, 'x');

  const base = Math.floor(Date.now() / 1000) - 1000;
  utimesSync(plain, base + 30, base + 30);
  utimesSync(rotated, base + 20, base + 20);
  utimesSync(compressed, base + 10, base + 10);

  assert.equal(scanSessionFiles(home).get('sess-multi').file, plain, '最新 mtime 胜出');
  utimesSync(plain, base + 10, base + 10);
  utimesSync(rotated, base + 30, base + 30);
  assert.equal(scanSessionFiles(home).get('sess-multi').file, rotated, '换最新之后结论跟着换');
  assert.equal(scanSessionFiles(home).get('sess-multi').file.endsWith('session.1.jsonl'), true);
});

test('scanSessionFiles：Unicode 目录名（中文 cwd/会话 id）原样作为 key', () => {
  const home = scratch('scan-unicode');
  const dir = path.join(home, 'sessions', '手机项目', '会话-一号');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'session.abc123.jsonl.zstd'), 'x');
  const map = scanSessionFiles(home);
  assert.deepEqual([...map.keys()], ['会话-一号']);
  assert.ok(map.get('会话-一号').file.includes('手机项目'));
});

test('scanSessionFiles：同一个 cwd 下多个会话都能被扫到', () => {
  const home = scratch('scan-many');
  for (const id of ['s1', 's2', 's3']) {
    const dir = path.join(home, 'sessions', 'proj-c', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'session.jsonl'), '{}');
  }
  assert.deepEqual([...scanSessionFiles(home).keys()].sort(), ['s1', 's2', 's3']);
});

/* ------------------------------------------------------------ readTailEvents */

test('readTailEvents：非法文件名/空文件/不存在/无魔法字节都返回 undefined', async () => {
  const dir = scratch('tail-bad');
  assert.equal(await readTailEvents(undefined), undefined);
  assert.equal(await readTailEvents(''), undefined);
  assert.equal(await readTailEvents(42), undefined);
  assert.equal(await readTailEvents(path.join(dir, '不存在.jsonl')), undefined);
  const empty = writeFile(dir, 'empty.jsonl', ['']);
  assert.equal(await readTailEvents(empty), undefined);
  const plain = writeFile(dir, 'plain.jsonl', ['{"seq":1}\n{"seq":2}\n']);
  assert.equal(await readTailEvents(plain), undefined, '没有 zstd 帧的纯文本文件不该被当成日志');
});

test('readTailEvents：单个 zstd 帧按顺序解出全部事件', async () => {
  const dir = scratch('tail-single');
  const file = writeFile(dir, 'session.jsonl.zstd', [frame([
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { content: '你好' } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ])]);
  const events = await readTailEvents(file);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(events[1].data.content, '你好', 'Unicode 原样');
});

test('readTailEvents：多帧按 seq 排序、重复 seq 去重', async () => {
  const dir = scratch('tail-multi');
  const file = writeFile(dir, 'session.jsonl.zstd', [
    frame([{ seq: 5, type: 'a' }, { seq: 6, type: 'b' }]),
    frame([{ seq: 7, type: 'c' }, { seq: 8, type: 'd' }]),
  ]);
  const events = await readTailEvents(file);
  assert.deepEqual(events.map((event) => event.seq), [5, 6, 7, 8]);

  // 同一个 seq 出现在两帧里（重写/补写）→ 只保留一条。
  const dup = writeFile(dir, 'dup.jsonl.zstd', [
    frame([{ seq: 1, type: 'old', data: { turn: 1 } }]),
    frame([{ seq: 1, type: 'new', data: { turn: 1 } }, { seq: 2, type: 'x' }]),
  ]);
  const deduped = await readTailEvents(dup);
  assert.equal(deduped.length, 2, 'seq 重复的事件被折叠');
  assert.deepEqual(deduped.map((event) => event.seq), [1, 2]);
});

test('readTailEvents：没有 seq 的事件按 time 排序、按 time+type+turn+step 去重', async () => {
  const dir = scratch('tail-time');
  const file = writeFile(dir, 'time.jsonl.zstd', [
    frame([
      { time: 300, type: 'x', data: { turn: 1, step: 1 } },
      { time: 100, type: 'y', data: { turn: 1, step: 1 } },
    ]),
    frame([
      { time: 200, type: 'z', data: { turn: 1, step: 1 } },
      { time: 100, type: 'y', data: { turn: 1, step: 1 } },
    ]),
  ]);
  const events = await readTailEvents(file);
  assert.deepEqual(events.map((event) => event.time), [100, 200, 300]);
  assert.equal(events.length, 3, 'time+type+turn+step 相同的一条被去重');
});

test('readTailEvents：maxEvents / maxFrames 选项截断', async () => {
  const dir = scratch('tail-limits');
  const many = writeFile(dir, 'many.jsonl.zstd', [frame(
    Array.from({ length: 10 }, (_, index) => ({ seq: index, type: 'e' })),
  )]);
  assert.deepEqual((await readTailEvents(many, { maxEvents: 3 })).map((event) => event.seq), [7, 8, 9],
    'maxEvents 保留最后 N 条');

  const frames = writeFile(dir, 'frames.jsonl.zstd', [
    frame([{ seq: 1, type: 'a' }]),
    frame([{ seq: 2, type: 'b' }]),
    frame([{ seq: 3, type: 'c' }]),
  ]);
  assert.deepEqual((await readTailEvents(frames, { maxFrames: 1 })).map((event) => event.seq), [3],
    'maxFrames=1 只解最新一帧');
  assert.deepEqual((await readTailEvents(frames, { maxFrames: 2 })).map((event) => event.seq), [2, 3]);
});

test('readTailEvents：尾部半帧（只有 magic 或截断的帧）被跳过，不拖垮整次读取', async () => {
  const dir = scratch('tail-torn');
  const full = frame([{ seq: 1, type: 'ok' }]);
  const second = frame([{ seq: 2, type: 'torn' }]);

  // 只有 4 字节 magic：`to - from < 8` 那条分支。
  const magicOnly = writeFile(dir, 'magic-only.jsonl.zstd', [full, Buffer.from([0x28, 0xb5, 0x2f, 0xfd])]);
  assert.deepEqual((await readTailEvents(magicOnly)).map((event) => event.seq), [1]);

  // 截断到 12 字节的帧：magic 在、解压必失败。
  const truncated = writeFile(dir, 'truncated.jsonl.zstd', [full, second.subarray(0, 12)]);
  assert.deepEqual((await readTailEvents(truncated)).map((event) => event.seq), [1],
    '解不开的帧只是少一帧，不是整次失败');
});

test('readTailEvents：空帧与“解得出但一行 JSON 都没有”的帧都返回 undefined', async () => {
  const dir = scratch('tail-empty-frames');
  const emptyFrame = writeFile(dir, 'empty-frame.jsonl.zstd', [zstdCompressSync(Buffer.from(''))]);
  assert.equal(await readTailEvents(emptyFrame), undefined, '空正文的帧不给事件');

  const notJson = writeFile(dir, 'not-json.jsonl.zstd', [zstdCompressSync(Buffer.from('这不是 JSON\n'))]);
  assert.equal(await readTailEvents(notJson), undefined, '解压后没有一行能解析 → undefined');

  // 一半能解析、一半是坏的（撕裂行）：坏行丢掉，好的留下。
  const mixed = writeFile(dir, 'mixed.jsonl.zstd', [
    zstdCompressSync(Buffer.from('{"seq":1,"type":"a"}\n{不是 JSON}\n{"seq":2,"type":"b"}\n', 'utf8')),
  ]);
  assert.deepEqual((await readTailEvents(mixed)).map((event) => event.seq), [1, 2]);
});

test('readTailEvents：magic 只在 512KB 尾巴之外时回退到整文件读', async () => {
  const dir = scratch('tail-bighead');
  const padding = Buffer.alloc(600 * 1024, 0x41); // 全 'A'，不含 magic
  const file = writeFile(dir, 'big.jsonl.zstd', [frame([{ seq: 1, type: 'old' }]), padding]);
  assert.ok(statSync(file).size > 512 * 1024);
  assert.deepEqual((await readTailEvents(file)).map((event) => event.seq), [1],
    '尾部没有 magic 时必须回退整文件读，否则老帧永远读不到');
});

test('readTailEvents：超过 24MB 且尾部没有 magic 时放弃（不做整文件读）', async () => {
  const dir = scratch('tail-huge');
  const file = writeFile(dir, 'huge.jsonl.zstd', [Buffer.alloc(25 * 1024 * 1024, 0x42)]);
  assert.ok(statSync(file).size > 24 * 1024 * 1024);
  assert.equal(await readTailEvents(file), undefined, '超大文件不许整文件读（会把 host 拖死）');
});

test('readTailEvents：压缩字节里偶发的“假 magic”解不开就被跳过', async () => {
  const dir = scratch('tail-false-magic');
  const full = frame([{ seq: 1, type: 'ok' }]);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

  // 假帧头 + 0xFF：zstd 直接抛 Unsupported frame parameter → 走 tryFrame 的 catch。
  const garbageFrame = Buffer.concat([magic, Buffer.alloc(24, 0xff)]);
  const withGarbage = writeFile(dir, 'garbage.jsonl.zstd', [full, garbageFrame]);
  assert.deepEqual((await readTailEvents(withGarbage)).map((event) => event.seq), [1], '假帧被跳过');

  // 假帧头 + 0x00：解压出 0 字节 → 空正文分支，同样跳过。
  const emptyish = writeFile(dir, 'zero.jsonl.zstd', [full, Buffer.concat([magic, Buffer.alloc(24, 0x00)])]);
  assert.deepEqual((await readTailEvents(emptyish)).map((event) => event.seq), [1], '0 字节输出也被跳过');
});

test('readTailEvents：截断的帧即使解出半行 JSON 也解析不进去', async () => {
  const dir = scratch('tail-partial-json');
  // 截断帧解出的是 `{"seq":9,"type":"half` 这种半行 → JSON.parse 失败 → 丢掉。
  const torn = frame([{ seq: 9, type: 'half', pad: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxx' }]).subarray(0, 30);
  const file = writeFile(dir, 'torn.jsonl.zstd', [frame([{ seq: 1, type: 'ok' }]), torn]);
  assert.deepEqual((await readTailEvents(file)).map((event) => event.seq), [1]);
});

/* -------------------------------------------------------- readTailEventsSync */

test('readTailEventsSync：与异步版同样的输入契约', () => {
  const dir = scratch('tail-sync');
  assert.equal(readTailEventsSync(undefined), undefined);
  assert.equal(readTailEventsSync(''), undefined);
  assert.equal(readTailEventsSync(path.join(dir, '不存在.jsonl')), undefined);
  assert.equal(readTailEventsSync(writeFile(dir, 'empty.jsonl', [''])), undefined);
  assert.equal(readTailEventsSync(writeFile(dir, 'plain.jsonl', ['{"seq":1}\n'])), undefined);

  const file = writeFile(dir, 'sync.jsonl.zstd', [
    frame([{ seq: 1, type: 'a' }, { seq: 2, type: 'b' }]),
  ]);
  assert.deepEqual(readTailEventsSync(file).map((event) => event.seq), [1, 2]);
  assert.deepEqual(readTailEventsSync(file, { maxEvents: 1 }).map((event) => event.seq), [2]);
});

test('readTailEventsSync：尾部无 magic 时同样回退整文件读', () => {
  const dir = scratch('tail-sync-bighead');
  const file = writeFile(dir, 'big.jsonl.zstd', [
    frame([{ seq: 9, type: 'old' }]),
    Buffer.alloc(600 * 1024, 0x41),
  ]);
  assert.deepEqual(readTailEventsSync(file).map((event) => event.seq), [9]);
});

test('readTailEventsSync：追加写入后能读到新增的帧（增量可视）', () => {
  const dir = scratch('tail-append');
  const file = writeFile(dir, 'append.jsonl.zstd', [frame([{ seq: 1, type: 'a' }])]);
  assert.deepEqual(readTailEventsSync(file).map((event) => event.seq), [1]);
  appendFileSync(file, frame([{ seq: 2, type: 'b' }, { seq: 3, type: 'c' }]));
  assert.deepEqual(readTailEventsSync(file).map((event) => event.seq), [1, 2, 3]);
});

/* ---------------------------------------------------------------- lastOfType */

test('lastOfType：从后往前找最后一个该类型的事件', () => {
  const events = [
    { type: 'session/title', data: { title: '旧标题' } },
    { type: 'turn/end', data: {} },
    { type: 'session/title', data: { title: '新标题' } },
    { type: 'turn/end', data: { turn: 2 } },
  ];
  assert.equal(lastOfType(events, 'session/title').data.title, '新标题');
  assert.equal(lastOfType(events, 'turn/end').data.turn, 2);
  assert.equal(lastOfType(events, '不存在'), undefined);
  assert.equal(lastOfType([], 'turn/end'), undefined);
  assert.equal(lastOfType([null, undefined, { type: 'x' }], 'x').type, 'x', '数组里的空洞不能让它抛异常');
});
