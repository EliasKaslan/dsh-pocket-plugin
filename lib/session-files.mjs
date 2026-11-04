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
const DEFAULT_MAX_FRAMES = 12;

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
 */
function decodeTail(buffer, positions, { maxEvents = DEFAULT_MAX_EVENTS, maxFrames = DEFAULT_MAX_FRAMES } = {}) {
  const collected = [];
  let frames = 0;
  for (let index = positions.length - 1; index >= 0 && frames < maxFrames; index -= 1) {
    const from = positions[index];
    const to = index + 1 < positions.length ? positions[index + 1] : buffer.length;
    if (to - from < 8) continue;
    const events = tryFrame(buffer.subarray(from, to), maxEvents);
    if (events === undefined) continue;
    collected.unshift(...events);
    frames += 1;
    if (collected.length >= maxEvents) break;
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
  return unique.slice(-maxEvents);
}

/**
 * Async tail read (preferred on the request path). Returns undefined when the
 * file is empty, unreadable, or has no decodable frame inside the tail window.
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
  let positions = collectMagic(buffer);
  if (positions.length === 0 && tailLength < size) {
    if (size > MAX_FULL_BYTES) return undefined;
    try { buffer = await readChunkAsync(file, size, 0); } catch { return undefined; }
    positions = collectMagic(buffer);
  }
  if (positions.length === 0) return undefined;
  return decodeTail(buffer, positions, options);
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
  let positions = collectMagic(buffer);
  if (positions.length === 0 && tailLength < size) {
    if (size > MAX_FULL_BYTES) return undefined;
    try { buffer = readChunkSync(file, size, 0); } catch { return undefined; }
    positions = collectMagic(buffer);
  }
  if (positions.length === 0) return undefined;
  return decodeTail(buffer, positions, options);
}

/** Last event of each type, scanned backwards — avoids building indexes. */
export function lastOfType(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return events[index];
  }
  return undefined;
}
