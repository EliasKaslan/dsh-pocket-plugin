/**
 * Read-only access to DSH's on-disk session logs.
 *
 * DSH writes one directory per logical session under `<home>/sessions/<cwd>/<id>/`
 * and appends zstd frames to a JSONL event log. The query service already gives
 * us headers and titles; the tail reader here only fills in the last turn's
 * status and preview. All reads are bounded: a 20 GB log must not make the host
 * read 20 GB at startup.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_FULL_BYTES = 24 * 1024 * 1024;
const MAX_FRAME_OUTPUT = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 400;
/**
 * 尾部**基础**窗口：帧数，不是事件数。
 *
 * 真实语料实测每帧只有 1~3 条事件（108087 帧 / 约 20 万条事件），所以旧的 12
 * 帧只等于 12~36 条事件 —— 连一个带工具调用的回合都装不满，`turn/end` 落在
 * 窗口之外，冷会话的 status / turn 就停在上一个回合（实测有 `full=completed` 而
 * `tail=none` 的会话）。提到 64 帧之后基础窗口约等于 90~190 条事件。
 */
const DEFAULT_MAX_FRAMES = 64;
/**
 * 基础窗口没能命中 `turn/end` 时的回溯上限。
 *
 * 512 KB 的尾巴窗口在真实语料里最多放得下约 280 帧，所以这个常数基本等于
 * "把窗口里能解的都解一遍"；正常会话在基础窗口内就会命中，只有"回合超长、还在跑
 * 或被打断"的会话才会真的回溯（实测最深 ~85 帧）。
 */
const MAX_BACKTRACK_FRAMES = 512;
/** 回溯时的内存闸：单次尾巴解析最多收集这么多事件（防止一屏超密日志撑爆内存）。 */
const MAX_BACKTRACK_EVENTS = 4_000;
/** 见到这个类型说明"这一轮已经收尾"，可以停止回溯：状态与 turn 号只认它。 */
const TURN_END_TYPE = 'turn/end';

export function sessionRoot(home) {
  return path.join(home, 'sessions');
}

/**
 * Map session id -> log file metadata. Depth is exactly two (cwd dir -> session
 * dir); anything deeper is not a session and is ignored.
 */
export function scanSessionFiles(home) {
  const result = new Map();
  const root = sessionRoot(home);
  let cwdDirs;
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    let sessionDirs;
    try {
      sessionDirs = readdirSync(path.join(root, cwdDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const dir = path.join(root, cwdDir.name, sessionDir.name);
      let files;
      try {
        files = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      let best;
      for (const entry of files) {
        if (!entry.isFile()) continue;
        if (!/^session(?:\.[a-z0-9]+)?\.jsonl(?:\.zstd)?$/iu.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        try {
          const info = statSync(file);
          if (best === undefined || info.mtimeMs > best.mtimeMs) {
            best = { file, mtimeMs: Math.round(info.mtimeMs), size: info.size };
          }
        } catch { /* raced with cleanup */ }
      }
      if (best !== undefined) result.set(sessionDir.name, best);
    }
  }
  return result;
}

function readChunkSync(file, length, position) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

async function readChunkAsync(file, length, position) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* torn tail line */ }
  }
  return events;
}

/**
 * 纯文本 JSONL 尾巴（旧版 / 未压缩的 `session*.jsonl`）。
 *
 * `scanSessionFiles` 一直把非压缩的 `session*.jsonl` 当成合法日志，但读取侧
 * 过去只在找到 zstd magic 之后才解析，于是这类会话**永远**读不出事件：列表里
 * 没有状态、标题、预览，`applyTail` 静默 return，既无日志也无报错。
 *
 * 窗口从任意字节落点开始，所以：
 *   - 首行可能是半行 → 丢掉（`headTrimmed`）；
 *   - 尾行可能正在写（末尾没有换行）→ 能解析就留（说明是完整写完才没换行），
 *     解析不了就当半行丢掉；
 *   - 其余坏行一律跳过，绝不抛 —— 与 zstd 路径的容错口径一致。
 */
function decodeTextTail(buffer, { maxEvents = DEFAULT_MAX_EVENTS, headTrimmed = false } = {}) {
  // 含 NUL 的窗口看着是二进制（真 zstd 帧的压缩字节），别拿去逐行试 JSON。
  if (buffer.length === 0 || buffer.includes(0)) return undefined;
  let start = 0;
  if (headTrimmed) {
    const firstBreak = buffer.indexOf(0x0a);
    // 整个窗口里连一个换行都没有 → 一行完整内容都没有。
    if (firstBreak < 0) return undefined;
    start = firstBreak + 1;
  }
  if (start >= buffer.length) return undefined;
  const events = [];
  for (const line of buffer.subarray(start).toString('utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event !== null && typeof event === 'object') events.push(event);
    } catch { /* 半行 / 坏行：丢掉 */ }
  }
  if (events.length === 0) return undefined;
  return events.slice(-maxEvents);
}

function collectMagic(buffer) {
  const positions = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      positions.push(index);
    }
  }
  return positions;
}

function tryFrame(buffer, maxEvents) {
  try {
    // maxOutputLength bounds a decompression bomb inside a single frame.
    const text = zstdDecompressSync(buffer, { maxOutputLength: MAX_FRAME_OUTPUT }).toString('utf8');
    if (text.length === 0) return undefined;
    const events = parseLines(text);
    if (events.length === 0) return undefined;
    return events.slice(-maxEvents);
  } catch {
    return undefined;
  }
}

/**
 * Walk the tail buffer from the newest frame backwards. A false-positive magic
 * inside compressed bytes simply fails to decompress and is skipped, so the
 * heuristic degrades to "one frame missing", never to a crash.
 *
 * 两段式后向扫描：
 *   1. 先走满 `maxFrames` 帧（默认 64）—— 保证预览/标题/计数有足够料；
 *   2. 若这一段里没见到 `turn/end`，继续往回走，直到命中它（状态与 turn 号只
 *      认这最后一个 `turn/end`），或碰到帧数/事件数的硬上限。
 *
 * `maxFrames` 被调用方**显式**指定时按硬上限处理（"只解最新 N 帧"是它被调用
 * 的语义），只有默认值才启用第 2 段回溯。
 */
function decodeTail(buffer, positions, { maxEvents = DEFAULT_MAX_EVENTS, maxFrames = DEFAULT_MAX_FRAMES, backtrack = true } = {}) {
  const collected = [];
  let frames = 0;
  let reachedTurnEnd = false;
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    if (frames >= maxFrames && (reachedTurnEnd === true || backtrack !== true)) break;
    if (frames >= MAX_BACKTRACK_FRAMES || collected.length >= MAX_BACKTRACK_EVENTS) break;
    const from = positions[index];
    const to = index + 1 < positions.length ? positions[index + 1] : buffer.length;
    if (to - from < 8) continue;
    const events = tryFrame(buffer.subarray(from, to), maxEvents);
    if (events === undefined) continue;
    collected.unshift(...events);
    frames += 1;
    if (reachedTurnEnd !== true && events.some((event) => event?.type === TURN_END_TYPE)) reachedTurnEnd = true;
  }
  if (collected.length === 0) return undefined;

  const seen = new Set();
  const unique = [];
  for (const event of collected) {
    const key = typeof event?.seq === 'number'
      ? `s:${event.seq}`
      : `t:${event?.time}:${event?.type}:${event?.data?.turn}:${event?.data?.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  unique.sort((left, right) => {
    if (typeof left?.seq === 'number' && typeof right?.seq === 'number') return left.seq - right.seq;
    return (left?.time ?? 0) - (right?.time ?? 0);
  });
  // 只留最近 maxEvents 条，但**必须**带上最后一个 `turn/end`：为了它才回溯的，
  // 裁掉它等于白走一趟（状态、turn 号会退回旧值）。
  let from = Math.max(0, unique.length - maxEvents);
  for (let index = from - 1; index >= 0; index -= 1) {
    if (unique[index]?.type === TURN_END_TYPE) {
      from = index;
      break;
    }
  }
  return unique.slice(from);
}

/**
 * 归一读取选项：调用方显式给 `maxFrames` 就是"最多解这几帧"的硬要求，
 * 此时关掉"回溯到 turn/end"的第二段扫描。
 */
function tailOptions(options) {
  const explicit = Number.isFinite(options?.maxFrames) && options.maxFrames > 0
    ? Math.floor(options.maxFrames)
    : undefined;
  return { ...options, maxFrames: explicit ?? DEFAULT_MAX_FRAMES, backtrack: explicit === undefined };
}

/**
 * Async tail read (preferred on the request path). Returns undefined when the
 * file is empty, unreadable, or yields no event inside the tail window.
 *
 * 两种日志都要认：zstd 帧格式（当前 DSH）和纯文本 JSONL（未压缩 / 旧版）。
 */
export async function readTailEvents(file, options = {}) {
  if (typeof zstdDecompressSync !== 'function') return undefined;
  if (typeof file !== 'string' || file.length === 0) return undefined;
  let size;
  try { size = (await stat(file)).size; } catch { return undefined; }
  if (size === 0) return undefined;
  const tailLength = Math.min(size, MAX_TAIL_BYTES);
  let buffer;
  try { buffer = await readChunkAsync(file, tailLength, size - tailLength); } catch { return undefined; }
  const headTrimmed = tailLength < size;
  let positions = collectMagic(buffer);
  if (positions.length > 0) return decodeTail(buffer, positions, tailOptions(options));
  // 没有 zstd magic：先按纯文本 JSONL 尾巴解析（旧会话就是这么写的），
  // 再回退到整文件找 magic（帧可能全在尾巴窗口之外）。
  const text = decodeTextTail(buffer, { ...options, headTrimmed });
  if (text !== undefined) return text;
  if (!headTrimmed) return undefined;
  if (size > MAX_FULL_BYTES) return undefined;
  try { buffer = await readChunkAsync(file, size, 0); } catch { return undefined; }
  positions = collectMagic(buffer);
  if (positions.length > 0) return decodeTail(buffer, positions, tailOptions(options));
  return decodeTextTail(buffer, options);
}

/** Synchronous variant, kept for startup paths that cannot await. */
export function readTailEventsSync(file, options = {}) {
  if (typeof zstdDecompressSync !== 'function') return undefined;
  if (typeof file !== 'string' || file.length === 0) return undefined;
  let size;
  try { size = statSync(file).size; } catch { return undefined; }
  if (size === 0) return undefined;
  const tailLength = Math.min(size, MAX_TAIL_BYTES);
  let buffer;
  try { buffer = readChunkSync(file, tailLength, size - tailLength); } catch { return undefined; }
  const headTrimmed = tailLength < size;
  let positions = collectMagic(buffer);
  if (positions.length > 0) return decodeTail(buffer, positions, tailOptions(options));
  const text = decodeTextTail(buffer, { ...options, headTrimmed });
  if (text !== undefined) return text;
  if (!headTrimmed) return undefined;
  if (size > MAX_FULL_BYTES) return undefined;
  try { buffer = readChunkSync(file, size, 0); } catch { return undefined; }
  positions = collectMagic(buffer);
  if (positions.length > 0) return decodeTail(buffer, positions, tailOptions(options));
  return decodeTextTail(buffer, options);
}

/** Last event of each type, scanned backwards — avoids building indexes. */
export function lastOfType(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return events[index];
  }
  return undefined;
}
