/**
 * 手机端"流畅度"故障注入基准：**可复现**的坏网络 × 真 CloudLink × 真外壳常量。
 *
 * 存在理由
 * --------
 * "手机端点进去要等多久""一片丢了要多久才自愈"以前只能靠人肉感觉。这个文件把它
 * 变成**可判定的数字**：内存 transport 上按可配置的故障（丢帧 / 单向延迟 / 下行
 * 黑障 / 精确丢某一片）跑真实链路，输出每次请求的
 * `{path, ok, ms, bytes, retries, healed}` 与汇总 `{n, ok, p50, p95, p99, max, failRate}`。
 *
 * 三个"真"字（别改成假的，否则数字没有意义）
 * ------------------------------------------
 *   1. 电脑端 = `lib/cloud.mjs` 的真 `CloudLink`：真 `onFrame()` → 真 `dispatch()` →
 *      真 `handleRequest()` → 真 `fetch()` 打 127.0.0.1 上的真 HTTP 桥；
 *   2. 手机端 = `test/support/relay-client.mjs`（独立实现）负责封装/拆帧/收发；
 *      **协议行为**（同 id 重发、分片 nack、8 s 判失、10 s 半死重建）直接复用外壳
 *      自己的模块：`web/lib/rpc-budget.js`、`web/lib/shell-parts.js`、
 *      `web/lib/shell-retry.js`——外壳改常量，这里跟着变（漂移探测器）。
 *   3. broker = 本文件的内存假件：两个假 mqtt client 互相投递，QoS 1 的 PUBACK 在
 *      `process.nextTick` 里回，**不连公网、不开真端口**（本地 HTTP 桥用
 *      127.0.0.1:0 随机端口）。
 *
 * 故障注入语义（全部可配、可复现）
 * --------------------------------
 *   - `dropRate`：按帧随机丢弃。可以是数字（双向同值）或 `{up, down}` 分方向配。
 *     决策在**发送时刻**做（一次丢包），PRNG 由 `seed` 固定。
 *   - `latencyMs`：**单向**延迟。数字 = 双向同值；`{up, down}` 分方向；
 *     每侧可以是 `{mean, sd}` 走正态（Box-Muller，同一个 PRNG）。所以
 *     `latencyMs: 300` ⇒ RTT ≈ 600 ms。
 *   - `blackout({afterMs, durationMs})`：模拟半死/断网 —— 从 `afterMs` 起
 *     `durationMs` 内**下行全丢**，上行照常（这才是真实的半死形态：手机还在发，
 *     回包进不来）。判据在**投递时刻**做，且只作用于**当时那个 transport 会话**：
 *     手机重建连接（新 mqtt 会话 = 新 TCP）后恢复，这与线上重建拿到新 broker 节点等价。
 *   - `partDrop(list)`：精确丢弃某个 chunkId 的第 N 片。规则
 *     `{seq, total?, chunkId?, times = 1}`；不写 `chunkId` 时按 `(seq,total)` 匹配
 *     （调用方一般拿不到 chunkId —— 它在加密信封里）。本文件里 broker 用共享密钥
 *     解开下行信封来匹配，**只读不改**，且解码只在有 partDrop 规则时发生。
 *
 * 时钟
 * ----
 * 真 `CloudLink` / 真 `relay-client` 内部用 `Date.now()` + `setTimeout`，假时钟无法
 * 整体穿透（要穿就得改 lib/，那是禁改范围）。所以这里的可注入时钟只覆盖**本文件
 * 自己**的时间：故障判据（黑障窗口）、延迟采样、统计口径。用例一律事件驱动，
 * `sleep()` 只出现在 `waitFor()` 兜底里，单次 ≤ 10 ms。
 *
 * 离线边界（硬性）
 * ----------------
 *   - 不连 broker（`wss://memory-broker.invalid/mqtt`，RFC 2606 保留域，永不解析）；
 *   - 不读 `~/.dsh`、不读任何配置文件：`identity` 全在本文件里造；
 *   - 临时目录一律 `mkdtemp`，env 关闭时删掉；
 *   - `link.start()` / `link.retry()` 一次都不调用（它们会 `mqtt.connect`）。
 *
 * 使用方式
 * --------
 *   ```js
 *   const env = await createBenchEnv({ seed: 7, latencyMs: 300 });
 *   env.faults.blackout({ afterMs: 200, durationMs: 8_000 });
 *   const rows = await runScenario(env, { name: 'S-blackout', path: '/api/v1/tasks', requests: 30 });
 *   console.log(formatTable([rows]));
 *   await env.close();
 *   ```
 */
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { CloudLink } from '../../lib/cloud.mjs';
// 外壳自己的协议常量与半包表：基准**必须**跟着它们走，否则量出来的不是线上行为。
import { RPC_ATTEMPTS, RPC_BACKOFF_MS, RPC_TIMEOUT_MS, rpcWorstCaseMs } from '../../web/lib/rpc-budget.js';
import { PART_NACK_GAP_MS, PART_STALL_MS, PartTable } from '../../web/lib/shell-parts.js';
import { RPC_STALL_REBUILD_MS } from '../../web/lib/shell-retry.js';
import { createRelayClient, openFrame } from './relay-client.mjs';
/* ------------------------------- 常量 ----------------------------------- */

/** 默认单向延迟：300 ms ⇒ RTT ≈ 600 ms（4G / 公共 broker 的典型量级）。 */
export const DEFAULT_ONE_WAY_MS = 300;
/** 外壳看门狗节拍（`remote/remote.js` 的 `setInterval(..., 2_000)`）。 */
export const WATCHDOG_MS = 2_000;
/** 重建冷却（`remote/remote.js` 的 `RESTART_COOLDOWN_MS`）。 */
export const RESTART_COOLDOWN_MS = 15_000;
/** 心跳到达时"卡了多久"才允许重发同 id（`BEAT_RESEND_AFTER_MS`）。 */
export const BEAT_RESEND_AFTER_MS = 4_000;
/** 一次请求的绝对预算：Σbackoff + 最后一次 timeout = 15 200 ms（与外壳同义）。 */
export const RPC_BUDGET_MS = rpcWorstCaseMs({ attempts: RPC_ATTEMPTS, timeoutMs: RPC_TIMEOUT_MS, backoffMs: RPC_BACKOFF_MS });
/** 只在本文件复用的诊断字段上限。 */
const MAX_EVENTS = 4_000;

/* ------------------------------- 时钟 ----------------------------------- */

/**
 * 可注入时钟。默认真实时间；`now` 可换成假时钟做纯逻辑验证。
 * 见文件头"时钟"一节：真实现内部用的是真实定时器，这里只覆盖本文件自己的判据。
 */
export function createClock({ now = () => Date.now() } = {}) {
  const clock = {
    now,
    startedAt: now(),
    since(at) { return clock.now() - Number(at || 0); },
  };
  return clock;
}

/* -------------------------------- PRNG ---------------------------------- */

/** mulberry32：小而快、跨平台逐位一致，保证 `seed` 决定丢帧序列。 */
export function mulberry32(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------- 故障注入器 -------------------------------- */

/** 把 `300` / `{mean,sd}` 归一成 `{kind,mean,sd}`。 */
function normalizeOneWay(value, fallbackMean) {
  if (value === undefined || value === null) return { kind: 'fixed', mean: fallbackMean, sd: 0 };
  if (typeof value === 'number') {
    const mean = Math.max(0, Number(value) || 0);
    return { kind: 'fixed', mean, sd: 0 };
  }
  const mean = Math.max(0, Number(value.mean ?? fallbackMean) || 0);
  const sd = Math.max(0, Number(value.sd ?? 0) || 0);
  return { kind: sd > 0 ? 'normal' : 'fixed', mean, sd };
}

/** 方向配置：数字 = 双向同值；对象 = 分方向。 */
function directional(value, fallback) {
  if (value === undefined || value === null) return { up: fallback, down: fallback };
  if (typeof value === 'number') return { up: Number(value) || 0, down: Number(value) || 0 };
  return { up: Number(value.up ?? fallback) || 0, down: Number(value.down ?? fallback) || 0 };
}

/**
 * 故障注入器：所有判据都在这里，broker 只负责"问一句、照做"。
 *
 * 设计原则：**判据与传输分离**。这样单测可以只喂"某个时刻某一方向的一帧"来验证
 * 丢/不丢，不用起整条链路。
 */
export class Faults {
  /**
   * @param {object} [options]
   * @param {number} [options.seed]            PRNG 种子（同种子 ⇒ 同丢帧序列）
   * @param {number|object} [options.latencyMs] 单向延迟：数字 / {up, down} / 每侧 {mean, sd}
   * @param {number|object} [options.dropRate]  丢帧概率：数字 / {up, down}
   * @param {ReturnType<createClock>} [options.clock]
   */
  constructor({ seed = 1, latencyMs = 0, dropRate = 0, clock = createClock() } = {}) {
    this.clock = clock;
    this.seed = seed;
    this.latency = { up: normalizeOneWay(latencyMs?.up ?? latencyMs, 0), down: normalizeOneWay(latencyMs?.down ?? latencyMs, 0) };
    this.drop = directional(dropRate, 0);
    this.blackouts = [];
    this.partRules = [];
    /** 当前"手机"会话的提供者（broker 建好后注入），用于把黑障绑到登记时的会话上。 */
    this.sessionProvider = null;
    /** 逐次事件的可诊断记录（教科书式的"哪个场景、哪一帧、为什么丢"）。 */
    this.events = [];
    this.counts = { up: { sent: 0, dropped: 0, delivered: 0 }, down: { sent: 0, dropped: 0, delivered: 0 } };
    this.reasons = { blackout: 0, 'part-drop': 0, 'random-drop': 0 };
    this.rng = mulberry32(seed);
  }

  /** broker 注入"当前手机会话"的读法（重建连接会换会话）。 */
  bindSession(provider) {
    this.sessionProvider = typeof provider === 'function' ? provider : null;
    return this;
  }

  /** 换种子重来（同一 env 里跑多轮时用；不重置已登记的规则）。 */
  reseed(seed = this.seed) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    return this;
  }

  /**
   * 运行中改丢包率（场景之间复用同一个 env 时用）。
   * @param {number|{up?: number, down?: number}} rate
   */
  setDropRate(rate) {
    this.drop = directional(rate, 0);
    return this;
  }

  /**
   * 运行中改单向延迟。
   * @param {number|{up?: any, down?: any}} latency
   */
  setLatency(latency) {
    this.latency = {
      up: normalizeOneWay(latency?.up ?? latency, 0),
      down: normalizeOneWay(latency?.down ?? latency, 0),
    };
    return this;
  }

  /** 清空所有注入（场景之间不会互相污染）。 */
  clear() {
    this.blackouts = [];
    this.partRules = [];
    this.events = [];
    this.counts = { up: { sent: 0, dropped: 0, delivered: 0 }, down: { sent: 0, dropped: 0, delivered: 0 } };
    this.reasons = { blackout: 0, 'part-drop': 0, 'random-drop': 0 };
    return this;
  }

  /** 有 partDrop 规则时才需要解开下行信封看片号。 */
  get needsPartInspection() {
    return this.partRules.length > 0;
  }

  /** 是否配了延迟（决定 broker 要不要排队投递）。 */
  get hasLatency() {
    return this.latency.up.mean > 0 || this.latency.up.sd > 0 || this.latency.down.mean > 0 || this.latency.down.sd > 0;
  }

  /**
   * 登记一段下行黑障。
   *
   * 语义（三条都别改，改了就测不出 v1.0.7 那条自愈）：
   *   1. 只打**下行**：上行照常通（这才是"半死"的真实形态：手机还在发，回包进不来）；
   *   2. 判据在**投递时刻**做：黑障开始前发出、黑障期间才投递的帧也算丢（物理上就该丢）；
   *   3. 默认**绑登记时的手机 transport 会话**：手机重建连接（新 mqtt 会话 ≈ 换 broker
   *      节点）后恢复。不绑会话的话"重建自愈"永远测不出来 —— 重建前后丢包窗口照旧吃帧。
   *
   * @param {object} options
   * @param {number} [options.afterMs=0]    从**调用这一刻**起算，多久后开始
   * @param {number} options.durationMs     持续多久
   * @param {string|null} [options.session] 指定会话；不传 = 绑当前手机会话；
   *                                        显式传 null = 对所有会话生效（"永远死"）
   * @returns {object} 窗口句柄（含 `drops` 计数、`session`）
   */
  blackout({ afterMs = 0, durationMs = 0, session = undefined, label = 'down' } = {}) {
    const startedAt = this.clock.now() + Math.max(0, Number(afterMs) || 0);
    const bound = session === undefined
      ? (typeof this.sessionProvider === 'function' ? this.sessionProvider() : null)
      : session;
    const window = {
      label,
      direction: 'down', // 半死形态：上行还通，所以只打下行
      startedAt,
      endsAt: startedAt + Math.max(0, Number(durationMs) || 0),
      session: bound,
      drops: 0,
    };
    this.blackouts.push(window);
    return window;
  }

  /**
   * 登记一条"精确丢某一片"的规则。
   *
   * @param {{seq: number, total?: number, chunkId?: string, times?: number, direction?: string}} rule
   * @returns {object} 规则句柄（`times` 用尽后自动失效）
   */
  partDrop(rule) {
    const entry = {
      seq: Number(rule?.seq),
      total: rule?.total === undefined ? undefined : Number(rule.total),
      chunkId: typeof rule?.chunkId === 'string' && rule.chunkId.length > 0 ? rule.chunkId : undefined,
      direction: rule?.direction === 'up' ? 'up' : 'down',
      times: Number.isFinite(Number(rule?.times)) ? Number(rule.times) : 1,
      dropped: 0,
    };
    if (!Number.isInteger(entry.seq)) throw new Error('partDrop: seq 必须是整数');
    this.partRules.push(entry);
    return entry;
  }

  /** 从事件记录里挑出指定原因的条目（断言用）。 */
  eventsOf(reason) {
    return this.events.filter((event) => event.reason === reason);
  }

  #push(event) {
    if (this.events.length < MAX_EVENTS) this.events.push({ at: this.clock.now(), ...event });
  }

  #sample(kind) {
    const side = this.latency[kind];
    if (side.kind !== 'normal' || side.sd <= 0) return Math.round(side.mean);
    // Box-Muller（用同一个 PRNG，种子固定 ⇒ 序列固定）。
    const u1 = Math.max(1e-9, this.rng());
    const u2 = this.rng();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(side.mean + normal * side.sd));
  }

  /**
   * 发送时刻的决策：这一帧是"在网络上丢了"，还是"照常投递、延迟多久"。
   *
   * @param {{direction: 'up'|'down', session?: string|null, part?: {chunkId: string, seq: number, total: number}|null}} input
   * @returns {{drop: boolean, reason?: string, latencyMs: number}}
   */
  decideSend({ direction, part = null } = {}) {
    this.counts[direction].sent += 1;
    if (part !== null && this.partRules.length > 0) {
      const rule = this.#matchPart(part, direction);
      if (rule !== null) {
        rule.times -= 1;
        rule.dropped += 1;
        this.counts[direction].dropped += 1;
        this.reasons['part-drop'] += 1;
        this.#push({ event: 'drop', reason: 'part-drop', direction, ...part, remaining: rule.times });
        return { drop: true, reason: 'part-drop', latencyMs: 0 };
      }
    }
    const rate = this.drop[direction];
    if (rate > 0 && this.rng() < rate) {
      this.counts[direction].dropped += 1;
      this.reasons['random-drop'] += 1;
      this.#push({ event: 'drop', reason: 'random-drop', direction, seq: part?.seq ?? null, chunkId: part?.chunkId ?? null });
      return { drop: true, reason: 'random-drop', latencyMs: 0 };
    }
    return { drop: false, latencyMs: this.#sample(direction) };
  }

  /**
   * 投递时刻的判据：此刻这条下行通路是不是死的（黑障）。
   *
   * @param {{direction: 'up'|'down', session?: string|null, at?: number}} input
   * @returns {object|null} 命中的窗口
   */
  decideDelivery({ direction, session = null, at = this.clock.now() } = {}) {
    for (const window of this.blackouts) {
      if (window.direction !== direction) continue;
      if (at < window.startedAt || at >= window.endsAt) continue;
      if (window.session !== null && window.session !== session) continue;
      return window;
    }
    return null;
  }

  /** 记一次"投递时刻被黑障吞掉"。 */
  noteBlackoutDrop(window, { direction, part = null } = {}) {
    if (window === null) return;
    window.drops += 1;
    this.counts[direction].dropped += 1;
    this.reasons.blackout += 1;
    this.#push({ event: 'drop', reason: 'blackout', direction, blackout: window.label, seq: part?.seq ?? null, chunkId: part?.chunkId ?? null });
  }

  noteDelivered(direction) {
    this.counts[direction].delivered += 1;
  }

  #matchPart(part, direction) {
    for (const rule of this.partRules) {
      if (rule.times <= 0) continue;
      if (rule.direction !== direction) continue;
      if (rule.seq !== part.seq) continue;
      if (rule.total !== undefined && rule.total !== part.total) continue;
      if (rule.chunkId !== undefined && rule.chunkId !== part.chunkId) continue;
      return rule;
    }
    return null;
  }

  /** 一份可贴进交付/日志的摘要（不含密钥、不含正文）。 */
  summary() {
    return {
      seed: this.seed,
      latencyMs: { up: this.latency.up, down: this.latency.down },
      dropRate: { ...this.drop },
      blackouts: this.blackouts.map((window) => ({
        label: window.label, startedAt: window.startedAt, endsAt: window.endsAt, drops: window.drops,
      })),
      partRules: this.partRules.map((rule) => ({ ...rule })),
      counts: { up: { ...this.counts.up }, down: { ...this.counts.down } },
      reasons: { ...this.reasons },
    };
  }
}

/* --------------------------- 内存 broker --------------------------------- */

/**
 * 最小 MQTT：`publish` / `subscribe` / `on('message')` / PUBACK，**外加故障注入**。
 *
 * 与 `test/integration/relay-e2e.test.mjs` 里的 `MemoryBroker` 的差别：
 *   - 投递可以延迟（`latencyMs`），所以这里用真 `setTimeout` 排队，而不是 nextTick；
 *   - 投递前过 `Faults`（丢帧 / 黑障 / 精确丢片）；
 *   - 丢帧时**回 PUBACK 成功**：这正是线上最难查的丢法（broker 收下了、订阅方没收到，
 *     电脑侧 `publishRetries/publishLost` 全 0，只有收方发 `nack` 能救）。
 *
 * 每个 client 是一个"会话"：`session` 是自增字符串，手机重建连接 = 新会话
 * （黑障绑定会话，重建后恢复，与线上换 broker 节点等价）。
 */
export class MemoryBenchBroker {
  /**
   * @param {object} options
   * @param {Faults} options.faults
   * @param {{up: string, down: string}} options.topics
   * @param {Buffer} [options.key] 下行信封的共享密钥（只有配了 partDrop 才会用到）
   * @param {ReturnType<createClock>} [options.clock]
   */
  constructor({ faults, topics, key, clock = createClock() }) {
    this.faults = faults;
    this.topics = topics;
    this.key = key ?? null;
    this.clock = clock;
    this.clients = [];
    this.deliveries = [];
    this.timers = new Set();
    this.sessionSeq = 0;
    this.stats = { published: 0, delivered: 0, dropped: 0, decodeErrors: 0, queued: 0 };
  }

  /** 当前"手机"会话（黑障默认绑它；`createClient` 时由 role 决定）。 */
  get phoneSession() {
    return this.currentPhoneSession ?? null;
  }

  createClient(label, { role = 'generic' } = {}) {
    const broker = this;
    this.sessionSeq += 1;
    const session = `s${this.sessionSeq}`;
    const listeners = new Map();
    const client = {
      label,
      role,
      session,
      connected: false,
      ended: false,
      subscriptions: new Set(),
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return client;
      },
      off(event, handler) {
        listeners.get(event)?.delete(handler);
        return client;
      },
      emit(event, ...args) {
        for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
      },
      subscribe(topic, options, callback) {
        client.subscriptions.add(String(topic));
        process.nextTick(() => callback?.(null));
      },
      unsubscribe(topic, callback) {
        client.subscriptions.delete(String(topic));
        process.nextTick(() => callback?.(null));
      },
      publish(topic, payload, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        broker.publish({ client, topic: String(topic), payload, cb });
        return true;
      },
      end() {
        if (client.ended) return;
        client.ended = true;
        client.connected = false;
        client.subscriptions.clear();
        const index = broker.clients.indexOf(client);
        if (index >= 0) broker.clients.splice(index, 1);
        if (broker.currentPhoneSession === session) broker.currentPhoneSession = null;
        process.nextTick(() => client.emit('close'));
      },
    };
    if (role === 'phone') broker.currentPhoneSession = session;
    this.clients.push(client);
    // 与真实 mqtt 一样：CONNECT 是异步完成的，监听器一定先挂上。
    process.nextTick(() => {
      if (client.ended) return;
      client.connected = true;
      client.emit('connect');
    });
    return client;
  }

  /** 一条 publish：判故障 → 回 PUBACK → 到点投递（或吞掉）。 */
  publish({ client, topic, payload, cb }) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
    const direction = topic === this.topics.down ? 'down' : 'up';
    const part = this.#inspect(topic, body, direction);
    const decision = this.faults.decideSend({ direction, part });
    this.stats.published += 1;
    this.deliveries.push({ from: client.label, topic, bytes: body.length, at: this.clock.now(), dropped: decision.drop, reason: decision.reason ?? '' });
    // PUBACK：**丢帧也回成功**（见类头注释）。
    process.nextTick(() => cb?.(null));
    if (decision.drop) {
      this.stats.dropped += 1;
      return;
    }
    this.stats.queued += 1;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.#deliver({ from: client, topic, body, direction, part });
    }, decision.latencyMs);
    this.timers.add(timer);
  }

  /**
   * 到点投递：先过黑障（"此刻这条下行还通不通"），再投给此刻订阅了该主题的别的 client。
   *
   * 注意两处细节：
   *   - 黑障按**目标会话**逐个判（同一个下行帧可能同时投给几台手机，各自的链路状态不同）；
   *   - 判据用**投递时刻**的时钟，不是发送时刻：发送时还通、投递时已经断了，那帧就该丢。
   */
  #deliver({ from, topic, body, direction, part }) {
    // MQTT 不回送自己；订阅关系按**投递时刻**取值（重建中的会话还没订阅就收不到）。
    const targets = this.clients.filter((peer) => peer !== from && !peer.ended && peer.subscriptions.has(topic));
    const now = this.clock.now();
    for (const peer of targets) {
      const window = this.faults.decideDelivery({ direction, session: peer.session, at: now });
      if (window !== null) {
        this.faults.noteBlackoutDrop(window, { direction, part });
        this.stats.dropped += 1;
        continue;
      }
      peer.emit('message', topic, Buffer.from(body));
      this.stats.delivered += 1;
      this.faults.noteDelivered(direction);
    }
    this.stats.lastDeliveryAt = now;
  }

  /**
   * 解开下行信封看片号 —— 只为了 `partDrop` 的精确匹配。
   * 没有规则时**一次都不解**（不浪费 CPU，也不给基准引入 AES 噪声）。
   */
  #inspect(topic, body, direction) {
    if (direction !== 'down' || this.key === null || !this.faults.needsPartInspection) return null;
    let frame;
    try {
      frame = JSON.parse(openFrame(this.key, topic, body.toString('utf8')).toString('utf8'));
    } catch {
      this.stats.decodeErrors += 1;
      return null;
    }
    if (frame === null || typeof frame !== 'object' || frame.t !== 'part') return null;
    return { chunkId: String(frame.id ?? ''), seq: Number(frame.seq), total: Number(frame.total), rid: String(frame.rid ?? '') };
  }

  /** 关掉所有排队中的投递（env 关闭时调用，避免定时器把进程吊住）。 */
  close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const client of [...this.clients]) client.end();
    this.clients.length = 0;
  }
}

/* ----------------------------- 本地假桥 ---------------------------------- */

/**
 * 电脑端 `handleRequest()` 会真的 `fetch('http://127.0.0.1:<port>' + path)`，
 * 所以必须有一个真实监听的 HTTP server。响应体按"gzip 后体积"造：
 *   - `/api/v1/tasks`              ≈ 2 KB 明文（手机端列表页量级）
 *   - `/api/v1/tasks/session-45k`  gzip ≈ 45 KB（单帧，详情页量级）
 *   - `/api/v1/tasks/session-58k`  gzip ≈ 58 KB（**两片**，逼出分片路径）
 *
 * 体量用**不可压缩**的随机 base64 造：gzip 后接近原始熵，才能稳定命中目标片数
 * （用可压缩正文时 45 KB 原始体能压到 2 KB，根本触发不了分片）。
 */
export const PAYLOAD_PATHS = Object.freeze({
  small: '/api/v1/tasks',
  detail: '/api/v1/tasks/session-45k',
  frag: '/api/v1/tasks/session-58k',
});

/** 造 `size` 个随机 base64 字符（不可压缩：gzip 后≈0.75×字符数）。 */
function randomBlob(size, rng) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chars = new Array(size);
  for (let index = 0; index < size; index += 1) chars[index] = alphabet[(rng() * alphabet.length) | 0];
  return chars.join('');
}

/** gzip 后体积落在 target ±2% 的 JSON 正文（随机 base64，不可压缩）。 */
export function makeGzipBody(targetBytes, { seed = 1, id = 'session' } = {}) {
  const rng = mulberry32(seed);
  const build = (size) => JSON.stringify({ ok: true, data: { id, blob: randomBlob(size, rng) } });
  let size = Math.max(64, Math.round(targetBytes * 1.4));
  for (let round = 0; round < 6; round += 1) {
    const body = build(size);
    const gzipped = gzipSync(Buffer.from(body, 'utf8')).length;
    if (Math.abs(gzipped - targetBytes) / targetBytes <= 0.02) return { body, gzipBytes: gzipped, rawBytes: Buffer.byteLength(body) };
    size = Math.max(64, Math.round((size * targetBytes) / Math.max(1, gzipped)));
  }
  const body = build(size);
  return { body, gzipBytes: gzipSync(Buffer.from(body, 'utf8')).length, rawBytes: Buffer.byteLength(body) };
}

function createBridge({ seed = 1 } = {}) {
  // 列表页量级：真 2 KB。低于 1 200 B 桌面端不会 gzip，量出来的路径就不一样了。
  const smallBody = JSON.stringify({
    ok: true,
    data: { tasks: [{ id: 'session-45k', title: '基准 A', blob: randomBlob(1980, mulberry32(seed + 5)) }] },
  });
  const small = { body: smallBody, rawBytes: Buffer.byteLength(smallBody), gzipBytes: gzipSync(Buffer.from(smallBody, 'utf8')).length };
  const detail = makeGzipBody(45 * 1024, { seed: seed + 11, id: 'session-45k' });
  const frag = makeGzipBody(58 * 1024, { seed: seed + 23, id: 'session-58k' });
  const payloads = new Map([
    [PAYLOAD_PATHS.small, { ...small, kind: 'small' }],
    [PAYLOAD_PATHS.detail, { ...detail, kind: 'detail' }],
    [PAYLOAD_PATHS.frag, { ...frag, kind: 'frag' }],
  ]);
  const calls = [];

  const server = createHttpServer((request, response) => {
    const path = String(request.url ?? '');
    const entry = payloads.get(path);
    calls.push({ method: String(request.method ?? 'GET'), path, at: Date.now(), hit: entry !== undefined });
    const finish = (status, text) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(text);
    };
    if (entry !== undefined) return finish(200, entry.body);
    return finish(404, '{"ok":false,"error":{"code":"not_found"}}');
  });

  return {
    server,
    calls,
    payloads,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ------------------------------ 手机端模型 ------------------------------- */

function toBufferBody(message) {
  let body = Buffer.from(String(message?.body ?? ''), 'base64');
  const enc = String(message?.enc ?? '');
  if (enc === 'gzip') {
    try { body = gunzipSync(body); } catch { /* 与 relay-client 一致：解不开就保留原始字节 */ }
  }
  return body;
}

/**
 * 手机端：`relay-client`（独立实现的传输/封装）+ **外壳自己的协议行为**。
 *
 * 为什么不能直接用 `client.request()`：它每次请求新 id、只发一次、超时就抛。
 * 那测不出"同 id 重放""丢片 nack""半死重建"——而这三种自救正是"手机端流畅"
 * 的全部内容。所以这里按 `remote/remote.js` 的 `request()` 重写调度：
 *
 *   - attempt 1/2/3 各等 `RPC_BACKOFF_MS`（1 200 / 2 400 / 3 600 ms），
 *     attempt 4 等满 `RPC_TIMEOUT_MS`（8 000 ms）⇒ 总预算 15 200 ms；
 *   - 重发**同 id、新 seq/ts**（桌面命中幂等缓存 ⇒ 回放而不是重跑）；
 *   - 分片用 `web/lib/shell-parts.js` 的 `PartTable`：卡 2 s 发 `nack` 补片，
 *     8 s 没齐判 `parts_lost`；
 *   - 看门狗每 2 s 一拍：有请求在途 + 下行静默 > 10 s ⇒ 重建连接（半死自愈，
 *     这就是 v1.0.7 那条修复），重建后同 id 重发在途请求；
 *   - 收到 beat/hello：对卡 > 4 s 的在途请求同 id 重发。
 */
export class BenchPhone {
  /**
   * @param {object} options
   * @param {MemoryBenchBroker} options.broker
   * @param {object} options.identity  `{room, key, token}`
   * @param {ReturnType<createClock>} [options.clock]
   * @param {number} [options.timeout]     最后一次 attempt 的预算（默认外壳的 8 s）
   * @param {number} [options.attempts]    最多发几次（默认外壳的 4）
   * @param {number[]} [options.backoff]   每次重发前的等待（默认外壳的 1.2/2.4/3.6 s）
   * @param {number} [options.watchdogMs]  看门狗节拍（默认外壳的 2 s）
   */
  constructor({
    broker,
    identity,
    clock = createClock(),
    timeout = RPC_TIMEOUT_MS,
    attempts = RPC_ATTEMPTS,
    backoff = RPC_BACKOFF_MS,
    watchdogMs = WATCHDOG_MS,
    name = '基准手机',
  } = {}) {
    this.broker = broker;
    this.identity = identity;
    this.clock = clock;
    this.timeout = timeout;
    this.attempts = attempts;
    this.backoff = backoff;
    this.watchdogMs = watchdogMs;
    this.name = name;
    /** 页面实例 id / 上行序号：重建连接**不重置**（与外壳一致，否则会被判 replay）。 */
    this.sid = randomBytes(4).toString('hex');
    this.seq = 0;
    this.pending = new Map();
    this.client = null;
    this.transport = null;
    this.generation = 0;
    this.ready = false;
    this.readyAt = 0;
    this.pcSeenAt = 0;
    this.lastRebuildAt = 0;
    this.parts = new PartTable({ now: () => this.clock.now() });
    this.groupBytes = new Map();
    /** chunkId → {total, seen}：门禁用它验证"45 KB 真的是 1 片 / 58 KB 真的是 2 片"。 */
    this.partGroups = new Map();
    this.timer = null;
    this.stats = {
      connects: 0, rebuilds: 0, requests: 0, attempts: 0, heals: 0, nacks: 0,
      partsSeen: 0, partsReassembled: 0, partsLost: 0, expired: 0, lateRes: 0, rejects: 0,
      gzipResponses: 0,
    };
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  /** 连上（并起看门狗）。幂等。 */
  async connect() {
    if (this.client !== null) return this;
    await this.#openTransport();
    this.timer ??= setInterval(() => this.#tick(), this.watchdogMs);
    this.timer.unref?.();
    return this;
  }

  async #openTransport() {
    this.generation += 1;
    const transport = this.broker.createClient(`phone-${this.generation}`, { role: 'phone' });
    const client = createRelayClient({
      room: this.identity.room,
      key: this.identity.key,
      name: this.name,
      transport,
    });
    this.#wire(client);
    this.transport = transport;
    this.client = client;
    await client.connect();
    this.ready = true;
    this.readyAt = this.clock.now();
    this.stats.connects += 1;
    return client;
  }

  #wire(client) {
    client.on('part', (message, meta) => this.#onPart(client, message, meta));
    client.on('res', (message, meta) => this.#onRes(client, message, meta));
    client.on('reject', (message) => this.#onReject(client, message));
    client.on('beat', () => { this.pcSeenAt = this.clock.now(); this.#resendStalledOnBeat(); });
    client.on('hello', () => { this.pcSeenAt = this.clock.now(); this.#resendStalledOnBeat(); });
    client.on('unseal-error', () => { /* 丢帧场景里不会出现；出现也不该打断基准 */ });
  }

  get lastRxAt() {
    return Number(this.client?.stats?.lastRxAt ?? 0);
  }

  /** 发一行 `req`/`nack`；未就绪时等一个连接周期。 */
  async #send(frame) {
    const client = this.client;
    if (client === null) throw new Error('BenchPhone 尚未连接');
    return client.send(frame);
  }

  /**
   * 发一条请求并等回包（失败也 resolve，不抛 —— 基准要统计失败率）。
   *
   * @param {string} method
   * @param {string} path
   * @returns {Promise<{path: string, ok: boolean, status: number, ms: number, bytes: number,
   *   retries: number, healed: boolean, attempts: number, nacks: number, enc: string,
   *   bodyBytes: number, error?: string}>}
   */
  request(method, path) {
    const id = randomBytes(8).toString('hex');
    const entry = {
      id,
      method: String(method ?? 'GET').toUpperCase(),
      path: String(path ?? ''),
      startedAt: this.clock.now(),
      at: 0,
      attempts: 0,
      heals: 0,
      nacks: 0,
      settled: false,
      timer: null,
      resolve: null,
    };
    this.stats.requests += 1;
    const promise = new Promise((resolve) => { entry.resolve = resolve; });
    this.pending.set(id, entry);
    this.#attemptOnce(entry, 'initial');
    return promise;
  }

  /** 一次尝试：同 id、新 seq/ts（桌面的重放闸要求 seq 严格递增）。 */
  #attemptOnce(entry, reason) {
    if (entry.settled) return;
    entry.attempts += 1;
    entry.at = this.clock.now();
    this.stats.attempts += 1;
    if (entry.timer !== null) clearTimeout(entry.timer);
    const index = entry.attempts;
    const delay = index < this.attempts ? (this.backoff[index - 1] ?? 2_000) : this.timeout;
    entry.timer = setTimeout(() => this.#onAttemptTimeout(entry, reason), delay);
    entry.timer.unref?.();
    const frame = {
      t: 'req',
      id: entry.id,
      sid: this.sid,
      seq: this.nextSeq(),
      ts: Date.now(),
      method: entry.method,
      path: entry.path,
    };
    this.#send(frame).catch((error) => this.#settle(entry.id, { ok: false, status: 0, error: `send: ${error?.message ?? error}` }));
  }

  #onAttemptTimeout(entry) {
    if (entry.settled) return;
    if (entry.attempts < this.attempts) {
      this.#attemptOnce(entry, 'backoff');
      return;
    }
    this.#settle(entry.id, { ok: false, status: 0, error: 'timeout' });
  }

  /** 同 id 重发（`heal()`）：外壳用它救"回包被丢/半包卡住"但预算还没烧完的请求。 */
  invokeHeal(entry) {
    if (entry === undefined || entry.settled) return false;
    if (entry.heals >= 1) return false; // 外壳的自救额度：每条请求一次
    entry.heals += 1;
    this.stats.heals += 1;
    this.#attemptOnce(entry, 'heal');
    return true;
  }

  #resendStalledOnBeat() {
    const now = this.clock.now();
    for (const entry of this.pending.values()) {
      if (entry.settled) continue;
      if (now - entry.at <= BEAT_RESEND_AFTER_MS) continue;
      this.invokeHeal(entry);
    }
  }

  /* ------------------------------ 下行处理 ------------------------------ */

  #onPart(client, message, meta) {
    if (client !== this.client) return;
    this.stats.partsSeen += 1;
    const chunkId = String(message?.id ?? '');
    const group = this.groupBytes.get(chunkId) ?? { bytes: 0, parts: 0 };
    group.bytes += Number(meta?.bytes ?? 0);
    group.parts += 1;
    this.groupBytes.set(chunkId, group);
    const known = this.partGroups.get(chunkId);
    if (known === undefined) this.partGroups.set(chunkId, { total: Number(message?.total ?? 0), seen: 1 });
    else known.seen += 1;
    const result = this.parts.add(message);
    if (result.kind === 'complete') {
      this.stats.partsReassembled += 1;
      this.groupBytes.delete(chunkId);
      const frame = result.value;
      if (frame !== null && typeof frame === 'object' && frame.t === 'res') this.#deliverRes(frame, { bytes: group.bytes });
    }
  }

  #onRes(client, message, meta) {
    if (client !== this.client) return;
    this.#deliverRes(message, { bytes: Number(meta?.bytes ?? 0) });
  }

  #deliverRes(message, { bytes }) {
    const id = String(message?.id ?? '');
    const entry = this.pending.get(id);
    if (entry === undefined || entry.settled) {
      // 迟到的 / 重复的回包（nack 补片与同 id 重放会各来一份）：忽略但记账。
      this.stats.lateRes += 1;
      return;
    }
    if (String(message?.enc ?? '') === 'gzip') this.stats.gzipResponses += 1;
    this.#settle(id, {
      ok: Number(message?.status) >= 200 && Number(message?.status) < 300,
      status: Number(message?.status) || 0,
      enc: String(message?.enc ?? ''),
      desktopMs: Number(message?.ms) || 0,
      bytes,
      bodyBytes: toBufferBody(message).length,
    });
  }

  #onReject(client, message) {
    if (client !== this.client) return;
    this.stats.rejects += 1;
    const code = String(message?.code ?? 'unknown');
    if (code === 'replay' || code === 'bad-seq') this.seq += 256; // 与外壳一致：跳号自救
    this.#settle(String(message?.id ?? ''), { ok: false, status: 0, error: `reject:${code}` });
  }

  /** 收口一条请求：算耗时、判是否"靠自救才回来"、清计时器。 */
  #settle(id, outcome) {
    const entry = this.pending.get(id);
    if (entry === undefined || entry.settled) return false;
    entry.settled = true;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.pending.delete(id);
    const now = this.clock.now();
    const ms = now - entry.startedAt;
    const healed = entry.heals > 0 || entry.nacks > 0 || entry.attempts > 1;
    entry.resolve({
      id,
      path: entry.path,
      method: entry.method,
      startedAt: entry.startedAt,
      finishedAt: now,
      ok: outcome.ok === true,
      status: outcome.status ?? 0,
      ms,
      bytes: Number(outcome.bytes ?? 0),
      bodyBytes: Number(outcome.bodyBytes ?? 0),
      enc: outcome.enc ?? '',
      desktopMs: Number(outcome.desktopMs ?? 0),
      attempts: entry.attempts,
      retries: Math.max(0, entry.attempts - 1),
      heals: entry.heals,
      nacks: entry.nacks,
      healed,
      error: outcome.error ?? '',
    });
    return true;
  }

  /* ------------------------------- 看门狗 ------------------------------- */

  /** 每 2 s 一拍：半包（nack/判失）→ 半死链路重建。顺序与外壳 `watch()` 一致。 */
  #tick() {
    const now = this.clock.now();
    this.sweepParts(now);
    this.#checkHalfDead(now);
  }

  /** 半包处理：过期 → 判失 → （就绪时）nack + 自救。语义照 `remote.js#sweepParts`。 */
  sweepParts(now = this.clock.now()) {
    this.stats.expired += this.parts.expire(now).length;
    for (const id of this.parts.lost(now)) {
      const rid = this.parts.ridOf(id);
      if (!this.parts.drop(id)) continue;
      this.stats.partsLost += 1;
      if (rid !== '') this.#settle(rid, { ok: false, status: 0, error: 'parts_lost' });
    }
    if (this.ready !== true || this.client === null) return;
    // 判据显式取自外壳的常量（`web/lib/shell-parts.js`）：外壳改了阈值，这里跟着变，
    // 不会出现"基准以为在测 2 s 节拍、其实已经被改成别的值"这种静默漂移。
    const due = this.parts.nackDue(now, { stallMs: PART_STALL_MS, gapMs: PART_NACK_GAP_MS });
    for (const id of due) {
      const rid = this.parts.ridOf(id);
      this.parts.markNacked(id, now);
      this.stats.nacks += 1;
      const entry = rid === '' ? undefined : this.pending.get(rid);
      if (entry !== undefined) entry.nacks += 1;
      this.#send({
        t: 'nack',
        id,
        ...(rid === '' ? {} : { rid }),
        sid: this.sid,
        seq: this.nextSeq(),
        ts: Date.now(),
      }).catch(() => undefined);
    }
    if (due.length > 0) this.#healOnce(due);
  }

  /** 一个 tick 只自救一条，且优先救"持有最老半包"的那条请求（外壳 `healOnce`）。 */
  #healOnce(ids) {
    const rid = this.parts.oldestRid(ids);
    if (rid !== '') {
      this.invokeHeal(this.pending.get(rid));
      return;
    }
    let oldest = null;
    for (const entry of this.pending.values()) {
      if (oldest === null || entry.at < oldest.at) oldest = entry;
    }
    this.invokeHeal(oldest ?? undefined);
  }

  /**
   * 半死自愈（F1 / v1.0.7 的修复点）：有请求在途、且"请求发出之后一帧下行都没收到"
   * 超过 `RPC_STALL_REBUILD_MS`（10 s）⇒ 重建连接，随后同 id 重发在途请求。
   *
   * 条件与 `remote/remote.js#watch()` 逐条对齐（含 `oldestPendingAt > lastDownAt`
   * 这条"不误伤慢请求"的判据）。
   */
  #checkHalfDead(now) {
    if (this.ready !== true || this.pending.size === 0) return;
    const lastDownAt = Math.max(this.lastRxAt, this.pcSeenAt, this.readyAt);
    const silentFor = now - lastDownAt;
    if (silentFor <= RPC_STALL_REBUILD_MS) return;
    let oldestPendingAt = 0;
    for (const entry of this.pending.values()) {
      if (entry.startedAt > 0 && (oldestPendingAt === 0 || entry.startedAt < oldestPendingAt)) oldestPendingAt = entry.startedAt;
    }
    if (oldestPendingAt !== 0 && oldestPendingAt <= lastDownAt) return;
    if (now - this.lastRebuildAt <= RESTART_COOLDOWN_MS) return;
    this.stats.rebuilds += 1;
    this.lastRebuildAt = now;
    void this.#rebuild('请求在途但下行静默');
  }

  /** 重建传输（= 线上重连拿到新会话）。在途请求用**同一个 id** 重发。 */
  async #rebuild() {
    const previous = this.client;
    const previousTransport = this.transport;
    this.ready = false;
    this.client = null;
    this.transport = null;
    this.parts.clear();
    this.groupBytes.clear();
    try { previous?.close(); } catch { /* 已经关了 */ }
    try { previousTransport?.end(); } catch { /* 已经断了 */ }
    await this.#openTransport();
    for (const entry of [...this.pending.values()]) this.#attemptOnce(entry, 'reconnect');
  }

  /** 关掉：清计时器、丢在途、断开传输。幂等。 */
  close() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.pending.values()) {
      entry.settled = true;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.resolve({ id: entry.id, path: entry.path, startedAt: entry.startedAt, finishedAt: this.clock.now(), ok: false, status: 0, ms: 0, bytes: 0, bodyBytes: 0, retries: 0, healed: false, attempts: entry.attempts, nacks: entry.nacks, heals: entry.heals, enc: '', desktopMs: 0, error: 'closed' });
    }
    this.pending.clear();
    this.parts.clear();
    try { this.client?.close(); } catch { /* ignore */ }
    try { this.transport?.end(); } catch { /* ignore */ }
    this.client = null;
    this.transport = null;
    this.ready = false;
  }
}

/* -------------------------------- 环境 ---------------------------------- */

function makeLogger(lines, { verbose = false } = {}) {
  const push = (level) => (...args) => {
    const text = `${level} ${args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`;
    if (lines.length < 2_000) lines.push(text);
    if (verbose) process.stderr.write(`${text}\n`);
  };
  return { info: push('info'), warn: push('warn'), error: push('error') };
}

/**
 * 造一套完整环境：真 `CloudLink` + 内存 broker（带故障注入）+ 真本地桥 + 手机模型。
 *
 * @param {object} [options]
 * @param {number} [options.seed=1]             PRNG 种子
 * @param {number|object} [options.latencyMs]    单向延迟（默认 0；基准用 300 ⇒ RTT 600）
 * @param {number|object} [options.dropRate]     丢帧概率（默认 0）
 * @param {boolean} [options.verbose=false]      把电脑端日志打到 stderr
 * @param {string} [options.name]                电脑端名字
 * @returns {Promise<object>} env
 */
export async function createBenchEnv({
  seed = 1,
  latencyMs = 0,
  dropRate = 0,
  verbose = false,
  name = '基准电脑',
  connectPhone = true,
} = {}) {
  const clock = createClock();
  const logLines = [];
  const logger = makeLogger(logLines, { verbose });
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pocket-bench-'));
  const bridge = createBridge({ seed });
  const port = await bridge.listen();

  const identity = {
    room: randomBytes(12).toString('hex'),
    key: Buffer.alloc(32, 0x5a).toString('base64url'),
    token: 'dshb_bench_device_token_0001',
    deviceId: 'dev_bench',
  };
  // 无口令模式：基准只量"传输 + 协议"，不量 scrypt。allowAnonymous 必须显式给。
  const link = new CloudLink({
    localPort: port,
    identity,
    broker: 'wss://memory-broker.invalid/mqtt',
    name,
    auth: null,
    allowAnonymous: true,
    logger,
  });

  const faults = new Faults({ seed, latencyMs, dropRate, clock });
  const broker = new MemoryBenchBroker({ faults, topics: link.topics, key: link.key, clock });
  // 黑障要绑"登记时那台手机的会话"：手机重建连接会换会话，黑障随之不再吃帧
  // （线上等价于重连拿到另一个 broker 节点）—— v1.0.7 的半死自愈靠这条才测得出来。
  faults.bindSession(() => broker.phoneSession);

  /**
   * 电脑端接线：复刻 `CloudLink.connect()` 的 `'connect'` / `'message'` 两个分支。
   *
   * 不能调 `link.start()`：它会 `mqtt.connect(wss://memory-broker.invalid/mqtt)`，
   * 而基准必须离线（`mqtt` 的默认导出是只读命名空间，打不了补丁，见 relay-e2e
   * 的同类注释）。被检的仍然是真实的 `publish()` / `onFrame()` / `dispatch()` /
   * `handleRequest()` / `respond()`。
   */
  const desktop = broker.createClient('desktop', { role: 'desktop' });
  link.state = 'connecting';
  link.client = desktop;
  desktop.on('message', (_topic, payload) => {
    try {
      link.onFrame(payload);
    } catch (error) {
      link.stats.errors += 1;
      link.lastError = String(error?.message ?? error);
    }
  });
  desktop.on('connect', () => {
    link.stats.connects += 1;
    link.noteLinkUp(desktop);
    link.state = 'online';
    desktop.subscribe(link.topics.up, { qos: 1 });
    link.sayHello(true);
    link.startBeat();
    // **故意不调 `link.startLinkWatch()`**：它判死后会调 `retry()` → 真 `mqtt.connect`。
    // 基准只量手机端自愈（这正是 v1.0.7 改的那条路径）；电脑端重建无法离线复现。
  });

  await waitFor(() => link.state === 'online', { timeout: 3_000, step: 5 });

  const phone = new BenchPhone({ broker, identity, clock });
  if (connectPhone) await phone.connect();

  const env = {
    link, broker, bridge, faults, phone, identity, clock, dir, logLines, logger, port,
    /**
     * 预热：等电脑端第一条下行（hello 回声）到手机。
     *
     * 为什么基准需要它：外壳的 F1 判据里有一条"`oldestPendingAt > lastDownAt`"——
     * 只有**请求发出之后**一帧下行都没收到才重建（不误伤慢请求）。请求早于第一条
     * 下行就发出去时该条件永远不成立，半死自愈会被正确地"防误伤"挡掉 —— 那不是
     * 被测代码的问题，是基准的时序不合理（真实用户点开时链路早已热了）。
     */
    async warmPhone({ timeout = 2_000 } = {}) {
      await waitFor(() => phone.pcSeenAt > 0, { timeout, step: 5 });
      if (phone.pcSeenAt <= 0) return false;
      // 外壳的判据是**严格**的 `oldestPendingAt > lastDownAt`：请求必须晚于最后一条
      // 下行（毫秒级即可）。warmPhone 返回与 request() 调用可能落在同一毫秒里，所以
      // 这里等到时钟严格越过最后一条下行（通常 1~2 ms，最多 50 ms）。
      const lastDownAt = Math.max(phone.lastRxAt, phone.pcSeenAt);
      await waitFor(() => env.clock.now() > lastDownAt, { timeout: 50, step: 1 });
      return env.clock.now() > lastDownAt;
    },
    /** 一键读出"这套环境发生了什么"（不含密钥/令牌/正文）。 */
    report() {
      return {
        bridgeCalls: bridge.calls.length,
        link: { state: link.state, rpc: link.stats.rpc, replays: link.stats.replays, errors: link.stats.errors, publishRetries: link.stats.publishRetries, publishLost: link.stats.publishLost, nackRepairs: link.stats.nackRepairs, nackDropped: link.stats.nackDropped, partGone: link.stats.partGone, stale: link.stats.stale, unauthorized: link.stats.unauthorized },
        broker: { ...broker.stats },
        faults: faults.summary(),
        phone: {
          ...phone.stats,
          pending: phone.pending.size,
          partGroups: phone.partGroups.size,
          groupsOfTwo: [...phone.partGroups.values()].filter((group) => group.total === 2 && group.seen === 2).length,
        },
      };
    },
    async close() {
      phone.close();
      link.stop();
      broker.close();
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return env;
}

/** 轮询等待：只在建链/收尾用，步长 ≤ 10 ms，总时长由调用方给。 */
export async function waitFor(predicate, { timeout = 3_000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, step); });
  }
}

/* ------------------------------- 统计 ----------------------------------- */

/** 最近秩百分位（nearest-rank）：小样本下比插值更保守、更好解释。 */
export function percentile(sortedMs, p) {
  if (!Array.isArray(sortedMs) || sortedMs.length === 0) return 0;
  const rank = Math.ceil(Math.max(0, Math.min(1, p)) * sortedMs.length);
  return sortedMs[Math.max(0, Math.min(sortedMs.length - 1, rank - 1))];
}

const round1 = (value) => Math.round(Number(value) * 10) / 10;

/**
 * 汇总一批结果。口径写死在这里，别在用例里各算各的：
 *   - `n` / `ok` / `failRate`：总数、成功数、失败率；
 *   - `p50/p95/p99/max`：**耗时分布**（ms，只统计成功的请求 —— 失败请求的耗时是
 *     "等满预算"，混进来会把 p95 变成超时预算的同义词）；
 *   - `avgRetries`：平均重发次数（含 heal）；`healed`：靠自救才回来的条数。
 */
export function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  const okList = list.filter((item) => item.ok === true);
  const ms = okList.map((item) => item.ms).sort((left, right) => left - right);
  const allMs = list.map((item) => item.ms).sort((left, right) => left - right);
  const retries = list.map((item) => Number(item.retries) || 0);
  return {
    n: list.length,
    ok: okList.length,
    failRate: list.length === 0 ? 0 : round1((1 - okList.length / list.length) * 100) / 100,
    p50: percentile(ms, 0.5),
    p95: percentile(ms, 0.95),
    p99: percentile(ms, 0.99),
    max: ms.length > 0 ? ms[ms.length - 1] : (allMs[allMs.length - 1] ?? 0),
    avgMs: ms.length === 0 ? 0 : Math.round(ms.reduce((sum, value) => sum + value, 0) / ms.length),
    avgRetries: retries.length === 0 ? 0 : round1(retries.reduce((sum, value) => sum + value, 0) / retries.length),
    healed: list.filter((item) => item.healed === true).length,
    failed: list.filter((item) => item.ok !== true).map((item) => ({ path: item.path, error: item.error, status: item.status })),
  };
}

/* ------------------------------- 跑场景 --------------------------------- */

/**
 * 跑一个场景：维持 `concurrency` 条在途请求的**连接池**（不是分批等待），
 * 一条回包就补一条上去。
 *
 * 为什么不是串行/批量：30 条 × 600 ms RTT 串行就是 18 s，门禁用例会超时；而"分批
 * 等待"会被单条重试拖住（弱网场景里偶发一条 attempt 3 的请求，整批都要陪它等 4 s，
 * 200 条能拖到 10 s）。连接池的墙钟 ≈ 总工作量 / 并发 + 最慢那条的尾巴。
 *
 * 并发上限的现实约束来自电脑端 `MAX_PENDING = 96`（超了会回 503 busy），
 * 所以默认 30，压测（N=200）时用 80。
 *
 * @param {object} env
 * @param {{name: string, path: string, requests?: number, concurrency?: number, method?: string, prepare?: Function}} options
 */
export async function runScenario(env, {
  name,
  path,
  requests = 30,
  concurrency = 30,
  method = 'GET',
  prepare,
} = {}) {
  const startedAt = env.clock.now();
  if (typeof prepare === 'function') await prepare(env);
  const results = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= requests) return;
      results.push(await env.phone.request(method, path));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests)) }, worker));
  // 结果按开始时刻排序：并发下完成顺序是乱的，统计不应该依赖顺序。
  results.sort((left, right) => left.startedAt - right.startedAt);
  const summary = summarize(results);
  return {
    name,
    path,
    results,
    summary,
    wallMs: env.clock.now() - startedAt,
    report: env.report(),
  };
}

/* ------------------------------- 输出 ----------------------------------- */

const COLUMNS = [
  { key: 'name', label: '场景', align: 'left' },
  { key: 'n', label: 'n', align: 'right' },
  { key: 'p50', label: 'p50', align: 'right' },
  { key: 'p95', label: 'p95', align: 'right' },
  { key: 'p99', label: 'p99', align: 'right' },
  { key: 'max', label: 'max', align: 'right' },
  { key: 'success', label: '成功率', align: 'right' },
  { key: 'avgRetries', label: '均重试', align: 'right' },
];

/**
 * 终端显示宽度：CJK 全角字符占 2 列。
 * 不这么算的话中文场景名会把整张表顶歪（`padEnd` 只数字符数）。
 */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 把 `runScenario()` 的返回（或它们的数组）打成一张等宽表。
 * @param {object|object[]} rows
 * @returns {string}
 */
export function formatTable(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).map((row) => {
    const summary = row.summary;
    return {
      name: String(row.name),
      n: summary.n,
      p50: summary.p50,
      p95: summary.p95,
      p99: summary.p99,
      max: summary.max,
      success: `${summary.n === 0 ? 0 : Math.round((summary.ok / summary.n) * 1000) / 10}%`,
      avgRetries: summary.avgRetries,
    };
  });
  const widths = COLUMNS.map((column) => Math.max(
    displayWidth(column.label),
    ...list.map((row) => displayWidth(row[column.key])),
  ));
  const cell = (column, width, value) => {
    const text = String(value);
    const pad = ' '.repeat(Math.max(0, width - displayWidth(text)));
    return column.align === 'left' ? `${text}${pad}` : `${pad}${text}`;
  };
  const head = COLUMNS.map((column, index) => cell(column, widths[index], column.label)).join('  ');
  const rule = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = list.map((row) => COLUMNS.map((column, index) => cell(column, widths[index], row[column.key])).join('  '));
  return [head, rule, ...body].join('\n');
}
