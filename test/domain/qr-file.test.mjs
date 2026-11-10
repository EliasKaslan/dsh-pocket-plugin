/**
 * 二维码落盘（lib/qr-file.mjs）——用户要的「二维码固定放在 ~/」。
 *
 * 这里守四件事：
 *  1. 真能解出内容：把 PNG 自己解回像素，逐模块与二维码矩阵比对。只断言
 *     "文件存在 + 是个 PNG" 是不够的 —— 一张黑方块也满足那个条件。
 *  2. 位置固定：默认就是用户主目录下的固定文件名，不跟端口、房间号变。
 *  3. 不重复写：中继状态每秒都在刷，链接没变就不许动盘。
 *  4. 写不出来不能把插件搞崩：返回 ok:false，不抛。
 *
 * 另有一层肉眼之外的证据：本会话里用 OpenCV（cv2.QRCodeDetector）对
 * `qrPngBuffer` 的真实产物做过解码，154 字符的链接逐字符还原一致。
 */
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { inflateSync } from 'node:zlib';

import qrcode from '../../lib/vendor/qrcode.mjs';
import {
  QR_FILE_NAME, QrFileWriter, defaultQrFile, qrPngBuffer, writeQrPng,
} from '../../lib/qr-file.mjs';

const URL = 'https://example.github.io/dsh-pocket/#s=wss%3A%2F%2Fbroker&r=room42&k=key42';

let root;

after(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  root ??= mkdtempSync(path.join(tmpdir(), 'dsh-pocket-qr-'));
  return mkdtempSync(path.join(root, 'case-'));
}

/* --------------------------------------------------------- PNG 结构自证 ---- */

/** 读回一个 chunk 列表，顺便校验每个 chunk 的 CRC。 */
function readChunks(png) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    chunks.push({ type, data, crc });
    offset += 12 + length;
  }
  return chunks;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

test('产出的确实是合法 PNG：签名、IHDR、IEND、每个 chunk 的 CRC 都对', () => {
  const png = qrPngBuffer(URL);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const chunks = readChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);

  const ihdr = chunks[0].data;
  assert.equal(ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), '二维码必须是正方形');
  assert.equal(ihdr[8], 8, '位深 8');
  assert.equal(ihdr[9], 2, '真彩 RGB');

  for (const chunk of chunks) {
    const body = Buffer.concat([Buffer.from(chunk.type, 'ascii'), chunk.data]);
    assert.equal(chunk.crc, crc32(body), `${chunk.type} 的 CRC 不对`);
  }
});

/**
 * 把 PNG 自己解回「每个模块是黑是白」，再与二维码矩阵逐格比对。
 *
 * 这一步才是真正证明「这张图能被扫出那段内容」的核心：PNG 里画的必须就是
 * vendor 库算出来的那个矩阵，一处像素错位都会让扫码失败。
 */
test('PNG 像素与二维码矩阵逐模块一致（不是"看着像二维码"）', () => {
  const { scale, margin } = { scale: 8, margin: 4 };
  const png = qrPngBuffer(URL, { scale, margin });
  const chunks = readChunks(png);
  const ihdr = chunks[0].data;
  const side = ihdr.readUInt32BE(0);
  const raw = inflateSync(chunks[1].data);

  const qr = qrcode(0, 'M');
  qr.addData(URL);
  qr.make();
  const count = qr.getModuleCount();
  assert.equal(side, (count + margin * 2) * scale, '画布尺寸必须是 (模块数 + 2×留白) × 放大倍数');

  const stride = 1 + side * 3;
  const dark = (x, y) => {
    const rowStart = y * stride;
    assert.equal(raw[rowStart], 0, '每条扫描线的 filter 必须是 0');
    return raw[rowStart + 1 + x * 3] < 128;
  };

  for (let my = 0; my < count; my += 1) {
    for (let mx = 0; mx < count; mx += 1) {
      // 取模块中心点，避免落在模块边界上。
      const x = (mx + margin) * scale + Math.floor(scale / 2);
      const y = (my + margin) * scale + Math.floor(scale / 2);
      assert.equal(dark(x, y), qr.isDark(my, mx), `模块 (${mx},${my}) 画错了`);
    }
  }

  // 留白区必须是白的（扫得出来靠的就是这圈静默区）。
  for (let i = 0; i < margin * scale; i += 1) {
    assert.equal(dark(i, i), false, '左上角留白必须是白的');
    assert.equal(dark(side - 1 - i, side - 1 - i), false, '右下角留白必须是白的');
  }
});

test('内容不同就产出不同的图；同样内容两次产出逐字节相同', () => {
  const a = qrPngBuffer(URL);
  const b = qrPngBuffer(URL);
  const c = qrPngBuffer(`${URL}&extra=1`);
  assert.deepEqual(a, b, '同样输入必须可复现');
  assert.notDeepEqual(a, c, '内容变了图必须跟着变');
});

/* ------------------------------------------------------------ 默认位置 ---- */

test('默认落点就是用户主目录下的固定文件名', () => {
  const home = process.env.USERPROFILE || process.env.HOME;
  assert.equal(QR_FILE_NAME, 'dsh-pocket-qr.png');
  assert.equal(defaultQrFile(), path.join(home ?? '', QR_FILE_NAME));
  assert.ok(defaultQrFile().endsWith(QR_FILE_NAME));
});

/* -------------------------------------------------------------- 写文件 ---- */

test('writeQrPng：产生可读的 PNG、不留临时文件、覆盖旧内容', () => {
  const dir = scratch();
  const file = path.join(dir, QR_FILE_NAME);

  const first = writeQrPng(file, URL);
  assert.equal(first.ok, true);
  assert.equal(first.file, file);
  assert.ok(first.bytes > 0);
  assert.equal(statSync(file).size, first.bytes);
  assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const before = readFileSync(file);
  const second = writeQrPng(file, `${URL}&rotated=1`);
  assert.equal(second.ok, true);
  assert.notDeepEqual(readFileSync(file), before, '覆盖后内容必须变');

  // 临时文件必须是「要么已经 rename 掉，要么已删」的状态。
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], `不该留下临时文件：${leftovers.join(', ')}`);
});

test('writeQrPng：目录不存在时自己建出来', () => {
  const dir = scratch();
  const file = path.join(dir, 'nested', 'deep', QR_FILE_NAME);
  const result = writeQrPng(file, URL);
  assert.equal(result.ok, true);
  assert.equal(existsSync(file), true);
});

test('writeQrPng：非法输入与不可写路径都只返回 ok:false，绝不抛', () => {
  const dir = scratch();
  assert.equal(writeQrPng('', URL).ok, false);
  assert.equal(writeQrPng(path.join(dir, 'x.png'), '').ok, false);

  // 把父路径做成一个普通文件，mkdir 必然失败。
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory', 'utf8');
  const result = writeQrPng(path.join(blocker, 'x.png'), URL);
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof Error);
});

/* ------------------------------------------------------------ 跟随链接 ---- */

test('QrFileWriter：链接没变就不重写，链接一变就重写', () => {
  const dir = scratch();
  const file = path.join(dir, QR_FILE_NAME);
  const writer = new QrFileWriter({ file });

  const first = writer.sync(URL);
  assert.equal(first.written, true);
  assert.equal(existsSync(file), true);
  const written = readFileSync(file);

  const again = writer.sync(URL);
  assert.equal(again.written, false, '同一个链接不该重复写盘');
  assert.deepEqual(readFileSync(file), written);

  const rotated = writer.sync(`${URL}&rotated=1`);
  assert.equal(rotated.written, true, '链接变了必须重写');
  assert.notDeepEqual(readFileSync(file), written);
});

test('QrFileWriter：空链接（中继没起来）不写盘，也不删已有文件', () => {
  const dir = scratch();
  const file = path.join(dir, QR_FILE_NAME);
  const writer = new QrFileWriter({ file });
  writer.sync(URL);
  const written = readFileSync(file);

  assert.equal(writer.sync('').written, false);
  assert.deepEqual(readFileSync(file), written, '中继断开不该把上一张能用的二维码删掉');
});

test('QrFileWriter：写不出来时下一轮还会再试（不把失败当成已写）', () => {
  const dir = scratch();
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'x', 'utf8');
  const writer = new QrFileWriter({ file: path.join(blocker, 'q.png') });

  const warnings = [];
  writer.logger = { info() {}, warn: (...args) => warnings.push(args.join(' ')) };

  assert.equal(writer.sync(URL).written, false);
  assert.equal(writer.lastUrl, '', '失败不该被记成已写');
  assert.equal(warnings.length, 1);

  // 第二轮仍然尝试（这里还是失败），证明没有被 lastUrl 挡住。
  assert.equal(writer.sync(URL).written, false);
  assert.equal(warnings.length, 2);
});

test('QrFileWriter：file:false 时整体关掉，一个字节都不写', () => {
  const dir = scratch();
  const file = path.join(dir, QR_FILE_NAME);
  const writer = new QrFileWriter({ file: false });
  assert.equal(writer.enabled, false);
  assert.equal(writer.sync(URL).written, false);
  assert.equal(existsSync(file), false);
});
