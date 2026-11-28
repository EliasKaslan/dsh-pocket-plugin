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

/**
 * 一个半包**超过这么久没有新片**就算"可能丢了"，可以发 `nack` 让电脑端补。
 *
 * 依据：电脑端实测 4~14 ms 就回完一条详情，分片之间是同一个 `for` 循环里连续
 * `publish()` 的（`lib/cloud.mjs` 的 `publishSealed`），正常间隔是毫秒级。2 s
 * 还没到下一片，就只可能是"broker 收下但订阅方没收到"——桌面侧的 `publishRetries`
 * / `publishLost` 对这种丢法**全 0**，它自己完全感知不到。
 */
export const PART_STALL_MS = 2_000;
/** 同一个 chunkId 两次 `nack` 的最小间隔（防止弱网时把上行刷成风暴）。 */
export const PART_NACK_GAP_MS = 5_000;
/** 同时最多为几个半包发 `nack`。 */
export const PART_NACK_MAX_OPEN = 4;
/**
 * 一个半包**从开始拼起，这么久还没集齐**就判定"这一组回包再也拼不齐了"。
 *
 * 取两个心跳周期：电脑端每 8 s 一跳 beat，而心跳会用**同一个 request id**
 * 触发一次重发（桌面命中幂等缓存重放整条响应）。所以 8 s 内既没有集齐、
 * 也没有被重放的完整响应，就只剩"我们等的东西不存在了"这一种解释 ——
 * 与其让用户干等到请求预算耗尽，不如立刻把这条请求送去自救/重试。
 *
 * 计时起点是 `createdAt` 而不是"最后一片到达"，见 `PartTable.lost()`。
 */
export const PART_LOST_MS = 8_000;

/** 分片 id 的形状：12 位小写十六进制（桌面 `randomBytes(6).toString('hex')`）。 */
const ID_PATTERN = /^[0-9a-f]{12}$/u;

/**
 * 分片帧可选的 `rid`（= 被拆那一帧的 request id）的形状。
 *
 * 桌面 `publish()` 拆帧时把 `object.id` 写进每一片（`lib/cloud.mjs`）。它的宽度
 * 由桌面决定（现在是 16 位十六进制），这里**故意放宽**：只要能当 Map 键用就行，
 * 格式不认识就当"老桌面没给"，绝不允许因为一个字段长得奇怪就把整组分片丢掉。
 */
const RID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** 浏览器 / Node 都有 atob；这里只把结果摊成字节，不碰 DOM。 */
function decodeBase64(text) {
  const raw = atob(String(text ?? ''));
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}

/**
 * 校验一条 `part` 帧并取出 (id, seq, total, 字节, rid)。
 *
 * `rid` 是**可选的**：新桌面会带上"被拆那一帧的 request id"，老桌面没有 —— 缺失时
 * 返回空串，上层据此退回启发式（见 `PartTable.oldestRid()`）。
 *
 * @returns {{id: string, seq: number, total: number, chunk: Uint8Array, rid: string}|null}
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
  // 认不出的 rid 当作"没给"：它只用来定位受害者，不值得为它拒掉整组分片。
  const rid = typeof message.rid === 'string' && RID_PATTERN.test(message.rid) ? message.rid : '';
  let chunk;
  try {
    chunk = decodeBase64(message.d);
  } catch {
    return null;
  }
  if (chunk.length > maxFrame) return null;
  return { id, seq, total, chunk, rid };
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
    /**
     * key(`part:<id>`) -> `{ chunks, total, at, createdAt, rid, nacks?, nackedAt? }`。
     *
     * 三个时刻的语义**不能混**：
     *   - `at`：最后一片到达的时刻（NACK 判据 = "这一组有多久没动静了"）；
     *   - `createdAt`：这一组**开始拼**的时刻（判失判据 = "还没集齐多久了"）；
     *   - Map 的插入序不是使用序，LRU 另有判据（见 `add()`）。
     */
    this.parts = new Map();
    /** 累计被迫淘汰的半包数（诊断用）。 */
    this.dropped = 0;
    /** 累计因 TTL 过期被清掉的半包数（诊断用；与 `dropped` 分开，语义不同）。 */
    this.expired = 0;
  }

  get size() {
    return this.parts.size;
  }

  clear() {
    this.parts.clear();
  }

  /**
   * 清掉超过 TTL 的半包，**并把清掉的 id 交回去**。
   *
   * 为什么必须交回去：清掉的半包意味着"这一组回包永远拼不齐了"，而上层
   * （`remote/remote.js`）要据此计入诊断、并让等它的那条请求立刻自救/重试。
   * 旧实现是静默 `delete` —— 用户和诊断都看不到任何痕迹。
   *
   * @param {number} [now]
   * @returns {string[]} 被清掉的 chunkId
   */
  sweep(now = this.now()) {
    return this.expire(now).map((group) => group.id);
  }

  /**
   * 与 `sweep()` 同一判据，但**连 `rid` 一起交回**。
   *
   * 为什么需要另一个方法：分组一旦从表里删掉，`rid` 就再也查不到了 —— 而上层要靠
   * 它把"哪一组丢了"精确对上"哪条在途请求"。只交回 id 的话，上层只能再退回
   * "挑最老在途请求"的启发式（那正是丢片自救救错对象的根因）。
   *
   * @param {number} [now]
   * @returns {{id: string, rid: string}[]}
   */
  expire(now = this.now()) {
    const gone = [];
    for (const [key, entry] of this.parts) {
      if (now - entry.at > this.ttlMs) {
        this.parts.delete(key);
        this.expired += 1;
        gone.push({ id: key.slice('part:'.length), rid: entry.rid ?? '' });
      }
    }
    return gone;
  }

  /** 当前所有没集齐的组（诊断 / NACK 判据都读它）。 */
  incomplete(now = this.now()) {
    const out = [];
    for (const [key, entry] of this.parts) {
      const missing = [];
      for (let index = 0; index < entry.total; index += 1) {
        if (entry.chunks[index] === undefined) missing.push(index);
      }
      out.push({
        id: key.slice('part:'.length),
        total: entry.total,
        missing,
        /** 被拆那一帧的 request id（老桌面没有 → 空串）。 */
        rid: entry.rid ?? '',
        /** 距最后一片到达多久（NACK 判据）。 */
        ageMs: Math.max(0, now - entry.at),
        /** 这一组还没集齐多久了（判失判据，见 `lost()`）。 */
        aliveMs: Math.max(0, now - (entry.createdAt ?? entry.at)),
        nacks: entry.nacks ?? 0,
        nackedAt: entry.nackedAt ?? 0,
      });
    }
    // 最老的先处理：它最可能是"用户正在等的那条大响应"。
    out.sort((left, right) => right.ageMs - left.ageMs);
    return out;
  }

  /**
   * 现在该给哪几组发 `nack`。
   *
   * 判据：这一组超过 `stallMs` 没有新片、距上次 `nack` 已过 `gapMs`、
   * 且同时最多 `maxOpen` 个 —— 弱网抖动时不许把上行刷成风暴。
   *
   * @param {number} [now]
   * @param {{stallMs?: number, gapMs?: number, maxOpen?: number}} [options]
   * @returns {string[]} 要发 `nack` 的 chunkId
   */
  nackDue(now = this.now(), { stallMs = PART_STALL_MS, gapMs = PART_NACK_GAP_MS, maxOpen = PART_NACK_MAX_OPEN } = {}) {
    const due = [];
    for (const group of this.incomplete(now)) {
      if (due.length >= Math.max(0, maxOpen)) break;
      if (group.ageMs < stallMs) continue;
      if (group.nackedAt > 0 && now - group.nackedAt < gapMs) continue;
      due.push(group.id);
    }
    return due;
  }

  /** 记下"已经为这一组发过 nack"（下次要等 `gapMs` 才允许再发）。 */
  markNacked(id, now = this.now()) {
    const entry = this.parts.get(`part:${id}`);
    if (entry === undefined) return false;
    entry.nacks = (entry.nacks ?? 0) + 1;
    entry.nackedAt = now;
    return true;
  }

  /**
   * 已经超过 `lostMs` 还没集齐的组：这组回包不可能再拼齐了。
   * 上层据此把组丢掉，并把等它的请求送去自救/重试。
   *
   * **计时起点是 `createdAt`（开始拼的那一刻），不是最后一片到达时刻。**
   * 旧实现用的是后者，于是"每 8 秒内来一片"的组**永远**不会被判失 —— 它既不走
   * 更快的 `parts_lost`，又长期占着表位（`PART_MAX_OPEN` 只有 8 个）。而注释一直
   * 写的是"还没集齐"，实现量的却是"距最后一片"。
   *
   * @param {number} [now]
   * @param {{lostMs?: number}} [options]
   * @returns {string[]} chunkId（最老的先，便于上层一次只救一条）
   */
  lost(now = this.now(), { lostMs = PART_LOST_MS } = {}) {
    const gone = [];
    for (const [key, entry] of this.parts) {
      const aliveMs = now - (entry.createdAt ?? entry.at);
      if (aliveMs >= lostMs) gone.push({ id: key.slice('part:'.length), aliveMs });
    }
    gone.sort((left, right) => right.aliveMs - left.aliveMs);
    return gone.map((group) => group.id);
  }

  /** 这一组半包属于哪条请求（老桌面 / 没带 rid 时返回空串）。 */
  ridOf(id) {
    const entry = this.parts.get(`part:${String(id ?? '')}`);
    const rid = entry?.rid;
    return typeof rid === 'string' ? rid : '';
  }

  /**
   * 在给定的几组里挑"**半包最老**"那一组，返回它的 `rid`。
   *
   * 为什么按 `createdAt` 挑而不是按 `at`：`at` 会被 NACK 补回来的片刷新，
   * "创建最早"才是"用户最可能正盯着的那一条"。选不出（没给 rid / 没有组）时返回
   * 空串，上层据此退回启发式。
   *
   * @param {string[]|null} [ids] 限定在这几组里挑（`null` = 全部）
   * @returns {string}
   */
  oldestRid(ids = null) {
    const wanted = Array.isArray(ids) ? new Set(ids.map((id) => String(id))) : null;
    let best = null;
    for (const [key, entry] of this.parts) {
      if (wanted !== null && !wanted.has(key.slice('part:'.length))) continue;
      if (best === null || (entry.createdAt ?? entry.at) < (best.createdAt ?? best.at)) best = entry;
    }
    const rid = best?.rid;
    return typeof rid === 'string' ? rid : '';
  }

  /** 丢掉一组半包（返回是否真的删掉了）。 */
  drop(id) {
    return this.parts.delete(`part:${id}`);
  }

  /**
   * 吃掉一条分片。
   *
   * @param {object} message 已解密的分片帧
   * @returns {{kind: 'invalid'|'incomplete'|'complete', value?: unknown,
   *   evicted: string[], expired: string[], evictedRids: string[], expiredRids: string[]}}
   *   `evicted` / `expired` 是被淘汰 / 过期的 chunkId（既有门禁钉着这两个字段）；
   *   `evictedRids` / `expiredRids` 是**同一批组的 rid**（按位置一一对应，没给时是
   *   空串）—— 上层要靠它精确找到受害者，而不是"挑最老的在途请求"。
   */
  add(message) {
    const parsed = parsePartFrame(message, { maxTotal: this.maxTotal, maxFrame: this.maxFrame });
    const evicted = [];
    const expired = [];
    const evictedRids = [];
    const expiredRids = [];
    if (parsed === null) return { kind: 'invalid', evicted, expired, evictedRids, expiredRids };
    const now = this.now();
    for (const group of this.expire(now)) {
      expired.push(group.id);
      expiredRids.push(group.rid);
    }
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
        evicted.push(oldestKey.slice('part:'.length));
        evictedRids.push(this.parts.get(oldestKey)?.rid ?? '');
        this.parts.delete(oldestKey);
        this.dropped += 1;
      }
      entry = { chunks: new Array(parsed.total), total: parsed.total, at: now, createdAt: now, rid: parsed.rid };
      this.parts.set(key, entry);
    }
    if (entry.total !== parsed.total) return { kind: 'invalid', evicted, expired, evictedRids, expiredRids };
    // 后续片可能不带 rid（或带重复的）；带了就以它为准 —— 同一组只属于一条请求。
    if (parsed.rid !== '') entry.rid = parsed.rid;
    entry.chunks[parsed.seq] = parsed.chunk;
    entry.at = now;
    for (const chunk of entry.chunks) {
      if (chunk === undefined) return { kind: 'incomplete', evicted, expired, evictedRids, expiredRids };
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
      return { kind: 'complete', value: JSON.parse(new TextDecoder().decode(merged)), evicted, expired, evictedRids, expiredRids };
    } catch {
      return { kind: 'invalid', evicted, expired, evictedRids, expiredRids };
    }
  }
}
