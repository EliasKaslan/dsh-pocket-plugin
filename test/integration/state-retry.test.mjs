/**
 * StateStore 落盘失败后的重试（lib/state.mjs）。
 *
 * 缺陷形态：`flush()` 失败只把 `dirty` 置 true，而这个字段**没有任何读者**。
 * 一次 rename 失败（Windows 上杀毒软件/索引器短暂持有句柄就是 EPERM）之后，
 * 只要再没有新的写入，这次设备列表 / `lastSeen` 变更就永久丢了 —— 状态文件与
 * 内存悄悄分叉，重启后已配对的手机被当成未登记而登出。
 *
 * 这里用「把 state.json 的父路径占成一个普通文件」制造**确定性**的写盘失败
 * （openSync 必然失败），再把路径换回可写，验证延迟重试真的把迟到的变更补上。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { StateStore } from '../../lib/state.mjs';

const TOKEN_HASH = 'a'.repeat(64);

let root;

// 被 await 的定时器不能 unref，否则 Node 22 的 runner 会取消整个文件。
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(predicate, { timeoutMs = 4000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(5);
  }
  throw new Error(`等待${label}超时`);
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-state-retry-'));
});

after(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function makeLogger() {
  const logs = [];
  const push = (level) => (...args) => logs.push([level, args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')]);
  return { logs, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

/** 造一个「目录可用、但写 state.json 一定失败」的 store。 */
function brokenStore(dir, { retryDelayMs = 10 } = {}) {
  mkdirSync(dir, { recursive: true });
  const blocker = path.join(dir, 'blocked');
  writeFileSync(blocker, 'x', 'utf8');
  const { logs, logger } = makeLogger();
  const store = new StateStore(dir, logger).load();
  const file = store.file;
  store.retryDelayMs = retryDelayMs;
  // 让每一次落盘都失败（等价于只读目录 / 磁盘满 / rename EPERM）。
  store.file = path.join(blocker, 'state.json');
  return { store, logs, file };
}

test('flush 失败后自动重试：迟到的设备变更不会静默丢失', async () => {
  const { store, file } = brokenStore(path.join(root, 'case-1'));

  assert.doesNotThrow(() => store.addDevice({ id: 'dev_retry', name: '手机', tokenHash: TOKEN_HASH }));
  assert.equal(store.devices.length, 1, '内存里必须已经记下这台设备');
  assert.equal(store.dirty, true, '写失败后必须保持 dirty');
  assert.notEqual(store.retryTimer, undefined, '写失败后必须排一次延迟重试');
  assert.equal(existsSync(file), false, '这一次确实没写进去');

  store.file = file; // 「磁盘恢复可写」
  await until(() => existsSync(file), { label: '重试落盘' });
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.devices[0].id, 'dev_retry', '迟到的变更必须真的落盘');
  assert.equal(store.dirty, false);
  store.close();
});

test('持续写不进去不会放弃重试：重试继续排队，磁盘恢复后自动补写，且日志被节流', async () => {
  const { store, logs, file } = brokenStore(path.join(root, 'case-2'));

  store.addDevice({ id: 'dev_persist', name: '手机', tokenHash: TOKEN_HASH });
  await delay(42); // 让它真的重试几轮（每轮仍然失败）
  assert.equal(store.dirty, true);
  assert.notEqual(store.retryTimer, undefined, '持续失败必须继续排队重试，而不是放弃');
  assert.equal(existsSync(file), false);
  // 重试是每 5 秒一次，日志不能也这么密：多轮失败只留一条 error。
  assert.equal(
    logs.filter(([level]) => level === 'error').length,
    1,
    `重复失败必须被节流：${logs.map(([level, line]) => `${level} ${line}`).join(' | ')}`,
  );

  store.file = file;
  await until(() => existsSync(file), { label: '重试自愈落盘' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).devices[0].id, 'dev_persist');
  store.close();
});

test('close()：收起重试定时器，关掉之后不再偷偷安排写盘', () => {
  const { store } = brokenStore(path.join(root, 'case-4'));

  store.addDevice({ id: 'dev_close', name: '手机', tokenHash: TOKEN_HASH });
  assert.notEqual(store.retryTimer, undefined);

  store.close();
  assert.equal(store.retryTimer, undefined, 'close() 必须清掉重试定时器');
  assert.equal(store.timer, undefined, 'close() 必须清掉去抖定时器');
});
