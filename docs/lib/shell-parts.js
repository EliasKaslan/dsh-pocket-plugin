/**
 * 下行分片重组表：**满了就淘汰最旧的半包，而不是拒绝新片**。
 *
 * 事故形态：`PART_MAX_OPEN`（8）个半包占满之后，旧实现对新来的分片直接
 * `return null` —— 新分片被丢掉，而它的兄弟片还在路上，于是这条大响应永远拼不齐，
 * 只能干等 30 秒 TTL 把旧半包清掉。窗口期内**所有 >64 KiB 的响应都被静默丢弃**
 * （任务列表、会话 detail 都是这个量级），界面上就是"点进去一直转圈，偶尔才好"。
 *
 * 反过来想：真正该死的是那些永远拼不完的旧半包（对端已经在重发新的一份了），
 * 而不是刚到达的新片。所以改成 LRU：腾出位置给新片，并把被淘汰的那组 id 交回
 * 给调用方 —— 上层据此把"这条大响应已经废了"记进诊断并立刻重发对应请求，
 * 而不是让用户等到超时。
 *
 * 抽成独立文件的理由与 `shell-fresh.js` / `shell-retry.js` 一样：`test/unit`
 * 能直接 import 它，测的是**行为**（谁会留下、谁被淘汰、拼出来的字节对不对），
 * 而不是对 `remote.js` 做正则断言。
 */

/** 半包多久没动静就丢掉（与桌面 `PART_TTL_MS` 对齐）。 */
export const PART_TTL_MS = 30_000;
/** 同时最多开几个半包。 */
export const PART_MAX_OPEN = 8;
/** 一条响应最多切几片。 */
export const PART_MAX_TOTAL = 64;
/** 单片明文上限（与桌面 `MAX_FRAME` 对齐）。 */
export const MAX_FRAME = 64 * 1024;

/** 分片 id 的形状：12 位小写十六进制（桌面 `randomBytes(6).toString('hex')`）。 */
const ID_PATTERN = /^[0-9a-f]{12}$/u;

/** 浏览器 / Node 都有 atob；这里只把结果摊成字节，不碰 DOM。 */
function decodeBase64(text) {
  const raw = atob(String(text ?? ''));
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}

/**
 * 校验一条 `part` 帧并取出 (id, seq, total, 字节)。
 *
 * @returns {{id: string, seq: number, total: number, chunk: Uint8Array}|null}
 */
export function parsePartFrame(message, { maxTotal = PART_MAX_TOTAL, maxFrame = MAX_FRAME } = {}) {
  if (message === null || typeof message !== 'object') return null;
  const id = String(message.id ?? '');
  if (!ID_PATTERN.test(id)) return null;
  const seq = Number(message.seq);
  const total = Number(message.total);
  if (!Number.isInteger(seq) || !Number.isInteger(total)) return null;
  if (total < 1 || total > maxTotal || seq < 0 || seq >= total) return null;
  if (typeof message.d !== 'string') return null;
  if (message.d.length > Math.ceil(maxFrame / 3) * 4) return null;
  let chunk;
  try {
    chunk = decodeBase64(message.d);
  } catch {
    return null;
  }
  if (chunk.length > maxFrame) return null;
  return { id, seq, total, chunk };
}

/**
 * 半包表。
 *
 * `add()` 的返回值是判据：
 *   - `{kind:'invalid'}`：这一片不可用（坏帧 / total 与已在拼的不一致）；
 *   - `{kind:'incomplete'}`：还没拼完，等下一片；
 *   - `{kind:'complete', value}`：拼完了，`value` 是解出来的 JSON。
 * 每种都带 `evicted: string[]`：这一片到达时为了腾位置被淘汰的半包 id。
 */
export class PartTable {
  constructor({
    maxOpen = PART_MAX_OPEN,
    ttlMs = PART_TTL_MS,
    maxTotal = PART_MAX_TOTAL,
    maxFrame = MAX_FRAME,
    now = () => Date.now(),
  } = {}) {
    this.maxOpen = Math.max(1, Number(maxOpen) || PART_MAX_OPEN);
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.maxTotal = maxTotal;
    this.maxFrame = maxFrame;
    this.now = now;
    /** key(`part:<id>`) -> { chunks, total, at }。Map 的插入序不是使用序，LRU 另有判据。 */
    this.parts = new Map();
    /** 累计被迫淘汰的半包数（诊断用）。 */
    this.dropped = 0;
  }

  get size() {
    return this.parts.size;
  }

  clear() {
    this.parts.clear();
  }

  /** 清掉超过 TTL 的半包。 */
  sweep(now = this.now()) {
    for (const [key, entry] of this.parts) {
      if (now - entry.at > this.ttlMs) this.parts.delete(key);
    }
  }

  /**
   * 吃掉一条分片。
   *
   * @param {object} message 已解密的分片帧
   * @returns {{kind: 'invalid'|'incomplete'|'complete', value?: unknown, evicted: string[]}}
   */
  add(message) {
    const parsed = parsePartFrame(message, { maxTotal: this.maxTotal, maxFrame: this.maxFrame });
    const evicted = [];
    if (parsed === null) return { kind: 'invalid', evicted };
    const now = this.now();
    this.sweep(now);
    const key = `part:${parsed.id}`;
    let entry = this.parts.get(key);
    if (entry === undefined) {
      // 满时淘汰「最久没有被碰过」的那一组：它最可能是对端已经放弃的那份。
      // 用 min(at) 而不是 Map 的第一个 key —— 旧键可能刚收到过一片，是热的。
      while (this.parts.size >= this.maxOpen) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [candidate, held] of this.parts) {
          if (held.at < oldestAt) {
            oldestAt = held.at;
            oldestKey = candidate;
          }
        }
        if (oldestKey === null) break;
        this.parts.delete(oldestKey);
        this.dropped += 1;
        evicted.push(oldestKey.slice('part:'.length));
      }
      entry = { chunks: new Array(parsed.total), total: parsed.total, at: now };
      this.parts.set(key, entry);
    }
    if (entry.total !== parsed.total) return { kind: 'invalid', evicted };
    entry.chunks[parsed.seq] = parsed.chunk;
    entry.at = now;
    for (const chunk of entry.chunks) {
      if (chunk === undefined) return { kind: 'incomplete', evicted };
    }
    this.parts.delete(key);
    let length = 0;
    for (const chunk of entry.chunks) length += chunk.length;
    const merged = new Uint8Array(length);
    let offset = 0;
    for (const chunk of entry.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return { kind: 'complete', value: JSON.parse(new TextDecoder().decode(merged)), evicted };
    } catch {
      return { kind: 'invalid', evicted };
    }
  }
}
