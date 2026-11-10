/**
 * 把中继二维码落成一个**固定的 PNG 文件**，默认放在用户个人目录
 * （`~/dsh-pocket-qr.png`）。
 *
 * 为什么要有这个模块：二维码以前只存在于 `http://127.0.0.1:<port>/pair`
 * 这一张网页里。想在手机上扫码，用户必须先在心里记住一个带随机端口的
 * 回环地址，或者在另一台设备上把页面开出来；电脑重启换端口之后，旧的
 * 书签还会 404。落成文件之后，「二维码在哪」这个问题只有唯一答案：
 * 用户个人目录下那个固定文件名，内容随中继身份自动更新。
 *
 * 不引第三方依赖：PNG 只需要 zlib 的 deflate + 四个 chunk，
 * 二维码矩阵由仓内已有的 `lib/vendor/qrcode.mjs` 给出。
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { randomHex } from './util.mjs';
import qrcode from './vendor/qrcode.mjs';

/** 默认文件名。改它等于改用户已经习惯的路径，所以刻意写成常量。 */
export const QR_FILE_NAME = 'dsh-pocket-qr.png';

/** PNG 默认边长像素。8 倍模块 + 4 模块留白，手机在 30cm 外也能扫。 */
const DEFAULT_SCALE = 8;
const DEFAULT_MARGIN = 4;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个 PNG chunk：4 字节长度 + 类型 + 数据 + CRC（CRC 覆盖类型与数据）。 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * 二维码 → PNG 字节。零依赖，纯同步。
 *
 * 输出 8 位真彩（colour type 2）而不是 1 位灰度：后者体积更小，但
 * 一部分看图软件（尤其手机自带相册）对低位深 PNG 的缩放是最近邻，
 * 放大后边缘会糊成锯齿，扫不出来。真彩 + 整数倍放大最省事。
 *
 * @param {string} text 二维码内容（中继链接）
 * @param {{scale?: number, margin?: number}} [options]
 * @returns {Buffer} 完整 PNG
 */
export function qrPngBuffer(text, { scale = DEFAULT_SCALE, margin = DEFAULT_MARGIN } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const count = qr.getModuleCount();
  const side = (count + margin * 2) * scale;

  // 每条扫描线前面有一个 filter 字节（0 = None），所以 stride = 1 + 3 * 宽。
  const stride = 1 + side * 3;
  const raw = Buffer.alloc(stride * side);
  for (let y = 0; y < side; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    const my = Math.floor(y / scale) - margin;
    for (let x = 0; x < side; x += 1) {
      const mx = Math.floor(x / scale) - margin;
      const dark = mx >= 0 && mx < count && my >= 0 && my < count && qr.isDark(my, mx);
      const value = dark ? 0 : 255;
      const offset = rowStart + 1 + x * 3;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩 RGB
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 交织：无

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 二维码文件的默认位置：**用户个人目录**根下，固定文件名。
 *
 * 不用 `~/.dsh/pocket/`：那是插件的内部数据目录，用户不该为了扫个码翻进去；
 * 也不该放在 DSH 的受保护目录里 —— 一个「给人看的产物」混在「机器状态」中间，
 * 备份、清理和排查都会变糊涂。
 */
export function defaultQrFile() {
  return path.join(os.homedir(), QR_FILE_NAME);
}

/**
 * 原子写二维码 PNG：同目录临时文件 → fsync → rename。
 *
 * 失败绝不抛给调用方：二维码是**附加便利**，写不出来不该让中继起不来。
 * 但也不能静默 —— 返回 `{ ok: false, error }`，由调用方记一条 warn。
 *
 * @param {string} file 目标绝对路径
 * @param {string} text 二维码内容
 * @param {{scale?: number, margin?: number}} [options]
 * @returns {{ok: boolean, file: string, bytes: number, error?: Error}}
 */
export function writeQrPng(file, text, options = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    return { ok: false, file: '', bytes: 0, error: new Error('二维码路径为空') };
  }
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, file, bytes: 0, error: new Error('二维码内容为空') };
  }

  let png;
  try {
    png = qrPngBuffer(text, options);
  } catch (error) {
    return { ok: false, file, bytes: 0, error };
  }

  const temp = `${file}.${process.pid}.${randomHex(4)}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeFileSync(fd, png);
      try { fsyncSync(fd); } catch { /* 尽力而为：断电场景不靠这一行兜底 */ }
    } finally {
      closeSync(fd);
    }
    try { chmodSync(temp, 0o600); } catch { /* Windows 上是 no-op */ }
    renameSync(temp, file);
  } catch (error) {
    // 临时文件里是二维码（链接本身就是凭据），失败时不能把它留在用户主目录。
    try { rmSync(temp, { force: true }); } catch { /* 已经没了 */ }
    return { ok: false, file, bytes: 0, error };
  }
  return { ok: true, file, bytes: png.length };
}

/**
 * 跟着中继链接走：链接没变就不重写文件。
 *
 * 这个类是唯一的写入口，所以「什么时候该重写」只有一处判断：
 * 只有 `url` 真的变了才动盘。中继每秒都在刷状态，不这么挡一下
 * 就等于每秒往用户主目录写一次 PNG。
 */
export class QrFileWriter {
  /**
   * @param {{file?: string, logger?: object}} [options]
   */
  constructor({ file, logger } = {}) {
    this.file = typeof file === 'string' && file.length > 0 ? file : defaultQrFile();
    // 显式关掉：传 `false` 或空串。
    this.enabled = file !== false && this.file.length > 0;
    this.logger = logger ?? { info() {}, warn() {} };
    this.lastUrl = '';
    this.lastResult = undefined;
  }

  /**
   * @param {string} url 中继链接；空串表示「现在没有可用链接」
   * @returns {{written: boolean, file: string, bytes: number}}
   */
  sync(url) {
    if (!this.enabled) return { written: false, file: '', bytes: 0 };
    if (typeof url !== 'string' || url.length === 0) return { written: false, file: this.file, bytes: 0 };
    if (url === this.lastUrl) return { written: false, file: this.file, bytes: this.lastResult?.bytes ?? 0 };

    const result = writeQrPng(this.file, url);
    if (result.ok) {
      this.lastUrl = url;
      this.lastResult = result;
      this.logger.info(`二维码已写入 ${result.file}（${result.bytes} 字节），用手机相机扫它即可登录`);
      return { written: true, file: result.file, bytes: result.bytes };
    }
    // 失败不记 lastUrl：下一轮再试一次（可能只是目录暂时不可写）。
    this.logger.warn(`二维码写入失败：${result.file}`, result.error);
    return { written: false, file: this.file, bytes: 0 };
  }
}
