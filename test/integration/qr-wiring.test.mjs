/**
 * 二维码文件的**接线**（lib/core.mjs 的 config.qrFile + syncQrFile）。
 *
 * lib/qr-file.mjs 自己的行为已经单测过了；这里只验「插件有没有把它接对」：
 * 配置怎么落到路径、中继状态怎么触发写盘、中继不在时会不会崩。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { BridgeCore } from '../../lib/core.mjs';
import { QR_FILE_NAME } from '../../lib/qr-file.mjs';

const roots = [];

after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 已经没了 */ }
  }
});

function makeCore(config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-qr-wire-'));
  roots.push(root);
  const logger = { info() {}, warn() {}, error() {} };
  const core = new BridgeCore({}, {
    home: root,
    dataDir: path.join(root, 'pocket'),
    ...config,
  }, logger);
  return { core, root };
}

const URL = 'https://example.github.io/dsh-pocket/#s=wss%3A%2F%2Fbroker&r=room42&k=key42';

test('config.qrFile 为空 → 落到用户主目录的固定文件名', () => {
  const { core } = makeCore();
  assert.equal(core.config.qrFile, '');
  assert.equal(core.qrWriter.file, path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', QR_FILE_NAME));
  assert.equal(core.qrWriter.enabled, true);
});

test('config.qrFile 给绝对路径就用它（并解析成绝对路径）', () => {
  // 注意：先建出 root，再拿它拼配置 —— 不能在同一条语句里既用 root 又解构 root。
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-qr-custom-'));
  roots.push(base);
  const { core } = makeCore({ qrFile: path.join(base, 'custom', 'qr.png') });
  assert.equal(core.qrWriter.file, path.join(base, 'custom', 'qr.png'));
});

test('config.qrFile=false → 整体关掉，不写任何文件', () => {
  const { core } = makeCore({ qrFile: false });
  assert.equal(core.qrWriter.enabled, false);
  assert.equal(core.syncQrFile().written, false);
});

test('中继上线后 syncQrFile 把二维码写到配置的路径；同一链接不重复写', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-pocket-qr-out-')), 'qr.png');
  const { core } = makeCore({ qrFile: file });

  // 中继还没挂上：不该崩，也不该写。
  assert.equal(core.syncQrFile().written, false);
  assert.equal(existsSync(file), false);

  core.setCloud({ status: () => ({ url: URL, state: 'online' }) });
  const first = core.syncQrFile();
  assert.equal(first.written, true);
  assert.equal(first.file, file);
  const bytes = statSync(file).size;
  assert.ok(bytes > 0);

  const snapshot = readFileSync(file);
  const second = core.syncQrFile();
  assert.equal(second.written, false, '同一链接不该重复写盘');
  assert.deepEqual(readFileSync(file), snapshot);

  // 身份轮换 → 链接变 → 必须重写。
  core.setCloud({ status: () => ({ url: `${URL}&rotated=1`, state: 'online' }) });
  assert.equal(core.syncQrFile().written, true);
  assert.notDeepEqual(readFileSync(file), snapshot);
});

test('中继读状态抛错时只记 warn，不往上抛', () => {
  const warnings = [];
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-pocket-qr-boom-'));
  roots.push(root);
  const core = new BridgeCore({}, {
    home: root,
    dataDir: path.join(root, 'pocket'),
    qrFile: path.join(root, 'qr.png'),
  }, { info() {}, warn: (...args) => warnings.push(args.join(' ')), error() {} });

  core.setCloud({ status() { throw new Error('boom'); } });
  const result = core.syncQrFile();
  assert.equal(result.written, false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('中继链接'));
});

test('中继还没起来（status 里没有 url）时不动盘', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-pocket-qr-idle-')), 'qr.png');
  const { core } = makeCore({ qrFile: file });
  core.setCloud({ status: () => ({ url: '', state: 'idle' }) });
  assert.equal(core.syncQrFile().written, false);
  assert.equal(existsSync(file), false);
});
