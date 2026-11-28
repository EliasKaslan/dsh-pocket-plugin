/**
 * Node 版「手机端」中继客户端 —— 用来自动复现「手机连上中继，但应用的请求不被
 * 应答」这一类事故，并当成协议漂移的探测器。
 *
 * 为什么再写一遍而不 import `remote/remote.js`：那份是浏览器外壳（DOM、
 * WebCrypto、fetch/WebSocket shim 全都在里面），Node 里根本加载不起来；而且只有
 * **独立实现**才能在信封/帧格式漂移时把测试打红 —— 复用同一份实现等于自己证明
 * 自己。
 *
 * 线上协议（与 lib/cloud.mjs 对齐，均以代码为准）：
 *   - 主题：上行 `dshm/<room>/u`，下行 `dshm/<room>/d`；
 *   - 信封：`{"v":1,"n":<base64(iv 12B)>,"c":<base64(密文‖GCM tag 16B)>}`，
 *     `n`/`c` 是**标准 base64**（不是 urlsafe）；`k=` 里的密钥是 **base64url**；
 *   - AEAD：AES-256-GCM，**AAD = 主题字符串**（上行帧 = up 主题，下行帧 = down 主题）；
 *   - 上行帧：hello / auth / login / logout / req / ws.open / ws.msg / ws.close / part；
 *   - 下行帧：hello / beat / res / reject / auth / login / logout /
 *     ws.open / ws.msg / ws.close / ws.error / part；
 *   - `req`、`ws.open` 必须带严格递增 `seq`、±120 s 内 `ts`、8~32 位小写 hex 的 `sid`；
 *   - 鉴权：`req` 的 `token` 由电脑端 `CloudLink.authorized()` 交给 `Auth.check()`，
 *     只认**口令登录换来的会话令牌**（`login` 应答里的 `token`）。链接里的
 *     `t=dshb_...` 是设备令牌，走的是另一本账（`core.authenticateToken`）。
 *
 * 依赖：只依赖 `node:crypto` / `node:events` / `mqtt`（以及 Node 内建 `node:zlib`
 * 用于解 `enc:'gzip'` 的响应体，不是第三方包）。
 *
 * 离线边界（**造新用例时必须守住**）：
 *   - 注入 `transport` 时**永远不 import `mqtt`、不连网络**（`#resolveMqtt()` 只在给了
 *     `broker` 且没有 transport 时才会被调用）；`test/integration/relay-e2e.test.mjs`
 *     用的就是内存 broker + 注入 transport，所以整组用例断网也能跑；
 *   - 不读 `~/.dsh`、不读任何配置文件，`key`/`token`/`room` 只由调用方传入；
 *   - 需要真公网 broker 的只有 `test/support/live-probe.mjs`（手工运行，不进 CI）。
 *
 * 跨实现一致性：信封格式（AES-256-GCM / IV 12 B / AAD=主题 / `n`/`c` 标准 base64）
 * 与 `docs/remote.js` 的 `makeSealer()` 必须逐字节互通，由
 * `test/support/relay-client.interop.test.mjs` 用**外壳的真实代码**双向互开钉住；
 * 上行分片规则也与外壳 `send()` 一致（> MAX_FRAME 时拆 `part`，`id` 为 12 位小写 hex）。
 *
 * 安全：`key` 与 `token` 存在私有字段里，既不出现在 `toString`/`inspect`/`toJSON`
 * 里，也不进入任何 emit / 返回值的字段；`room` 可以显示（它本来就是主题的一部分，
 * 且没有密钥的 room 打不开任何东西）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';

/** 与 lib/cloud.mjs 的 SEAL_VERSION / CLOUD_PROTOCOL 对齐（协议常量，分开写是为了检测漂移）。 */
export const SEAL_VERSION = 1;
export const CLOUD_PROTOCOL = 2;
/** 单条 MQTT 消息里允许的明文上限；超过就要拆 `part`。 */
export const MAX_FRAME = 64 * 1024;
/** 一次重组允许的最大分片数。 */
export const PART_MAX_TOTAL = 64;
/**
 * 手机端默认 RPC 预算（`remote/remote.js` 的 `RPC_TIMEOUT_MS`）。
 *
 * 必须逐字跟随外壳：`relay-client.interop.test.mjs` 有"常量与外壳一致"的守卫，
 * 外壳改了这里不改就会红。它现在是 8s 而不是更早的 16s —— 单条请求的**绝对截止**
 * 是 `Σbackoff + 最后一次 timeout = 15.2s`（每次 attempt 都会重装计时器，不是叠加），
 * 这个截止必须小于应用层详情超时，否则用户会对着静止的「加载中…」干等。
 */
export const RPC_TIMEOUT_MS = 8_000;
/** hello 回声的限流窗口（电脑端 HELLO_MIN_GAP_MS）。 */
export const HELLO_MIN_GAP_MS = 10_000;
const PART_TTL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;

/** 上行 / 下行主题。 */
export function topicsOf(room) {
  return { up: `dshm/${room}/u`, down: `dshm/${room}/d` };
}

/**
 * 链接里的 `k=` 是 base64url；解码后必须正好 32 字节（AES-256）。
 * 长度不对时只报长度，绝不回显密钥本身。
 */
export function decodeKey(key) {
  const text = typeof key === 'string' ? key.trim() : '';
  if (text.length === 0) throw new Error('中继密钥为空');
  const raw = Buffer.from(text.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
  if (raw.length !== 32) throw new Error(`中继密钥长度不对（期望 32 字节，实际 ${raw.length} 字节）`);
  return raw;
}

/** 封一帧：IV 12 字节随机，AAD = 主题串，`n`/`c` 用标准 base64。 */
export function sealFrame(key, aad, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return JSON.stringify({
    v: SEAL_VERSION,
    n: iv.toString('base64'),
    c: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
  });
}

/** 解一帧；结构不合法与 GCM 校验失败都抛错。 */
export function openFrame(key, aad, envelope) {
  const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== SEAL_VERSION) throw new Error('bad envelope');
  const iv = Buffer.from(String(parsed.n ?? ''), 'base64');
  const blob = Buffer.from(String(parsed.c ?? ''), 'base64');
  if (iv.length !== 12 || blob.length <= 16) throw new Error('bad envelope body');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
}

/** 只含非敏感字段的帧摘要：`t`/`id`/体积/状态码，够诊断，不泄密。 */
export function describeFrame(frame, meta = {}) {
  const summary = { t: String(frame?.t ?? '?') };
  if (typeof frame?.id === 'string' && frame.id.length > 0) summary.id = frame.id;
  if (frame?.t === 'res') summary.status = Number(frame.status);
  if (frame?.t === 'reject') summary.code = String(frame.code ?? '');
  if (frame?.t === 'part') summary.part = `${Number(frame.seq) + 1}/${Number(frame.total)}`;
  if (meta.bytes !== undefined) summary.bytes = meta.bytes;
  return summary;
}

function toBufferBody(value) {
  if (value === undefined || value === null) return undefined;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export class RelayClient extends EventEmitter {
  /** 全程可读：房间号本来就出现在主题里，且没有密钥打不开任何东西。 */
  room;
  /** 电脑端名称（收到 hello 后填）。 */
  pcName = null;
  connected = false;
  /** 单调递增的上行序号（每次 attempt 都要新号，见线上防重放闸）。 */
  seq = 0;
  /** 本页面的会话 id：8 位小写 hex。 */
  sid = randomBytes(4).toString('hex');
  stats;

  #key;
  #token;
  #transport;
  #transportOwned;
  #closed = false;
  #pending = new Map();
  #parts = new Map();
  #rtts = [];
  #waiters = new Set();
  #timeoutMs;

  /**
   * @param {object} options
   * @param {string} options.room           链接 `#r=` 的房间 id
   * @param {string} options.key            链接 `#k=` 的 base64url 密钥（32 字节）
   * @param {string} [options.token]        `req` 用的令牌（口令登录换来的会话令牌）
   * @param {string} [options.broker]       broker URL（默认 transport 用它连 mqtt）
   * @param {string} [options.name]         手机名，hello 里自报
   * @param {object|Function} [options.transport] 注入的假 transport（测试用）
   * @param {number} [options.timeout]      单个 RPC 的超时（默认 16 s）
   */
  constructor({ room, key, token = '', broker, name = '手机', transport, timeout = RPC_TIMEOUT_MS } = {}) {
    super();
    if (typeof room !== 'string' || room.length === 0) throw new Error('RelayClient: room 必填');
    this.room = room;
    this.topics = topicsOf(room);
    this.#key = decodeKey(key);
    this.#token = typeof token === 'string' ? token : '';
    this.name = name;
    this.broker = typeof broker === 'string' ? broker : undefined;
    this.#transport = transport;
    this.#transportOwned = transport === undefined;
    this.#timeoutMs = timeout;
    this.stats = {
      tx: 0, rx: 0, txBytes: 0, rxBytes: 0, txParts: 0,
      res: 0, reject: 0, beat: 0, hello: 0, unauthorized: 0,
      partsSeen: 0, partsReassembled: 0, unsealErrors: 0, ackErrors: 0, timeouts: 0,
      connectedAt: 0, lastRxAt: 0, firstBeatAt: 0, rtts: this.#rtts,
    };
  }

  /** 有没有令牌（只回答布尔，不回显令牌）。 */
  get hasToken() {
    return this.#token.length > 0;
  }

  /** 语义同 remote.js 的 nextSeq()：每次上行都要新号。 */
  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  #createTransport() {
    const injected = this.#transport;
    if (typeof injected === 'function') return injected({ up: this.topics.up, down: this.topics.down, client: this });
    if (injected !== undefined && injected !== null) return injected;
    if (this.broker === undefined) throw new Error('RelayClient: 既没有注入 transport，也没有 broker');
    return {
      // 延迟到真正 connect 时再 import，测试里就不会因为没装 mqtt 而整文件失败。
      __needsMqtt: true,
    };
  }

  async #resolveMqtt() {
    const { default: mqtt } = await import('mqtt');
    return mqtt.connect(this.broker, {
      clientId: `pocket_probe_${randomBytes(6).toString('hex')}`,
      clean: true,
      keepalive: 40,
      reconnectPeriod: 0,
      connectTimeout: 15_000,
      protocolVersion: 4,
    });
  }

  /** 等 transport 就绪：真实的 mqtt client 会发 'connect'，内存假件直接 connected=true。 */
  #waitForConnect(transport, timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => done(new Error('中继连接超时')), timeoutMs);
      timer.unref?.();
      if (transport.connected === true) { done(); return; }
      if (typeof transport.on !== 'function') { done(); return; }
      transport.on('connect', () => done());
      transport.on('error', (error) => done(new Error(`中继连接失败：${error?.message ?? error}`)));
      transport.on('close', () => done(new Error('中继连接被关闭')));
    });
  }

  /**
   * 连上 broker、订阅下行主题、发一条 hello。返回 this。
   * @param {{announce?: boolean}} [options]
   */
  async connect({ announce = true } = {}) {
    if (this.connected) return this;
    if (this.#closed) throw new Error('RelayClient 已关闭');
    let transport = this.#createTransport();
    if (transport.__needsMqtt === true) transport = await this.#resolveMqtt();
    this.#transport = transport;
    this.stats.connectedAt = Date.now();

    transport.on('message', (topic, payload) => {
      if (String(topic) !== this.topics.down) return;
      this.#onPayload(payload);
    });
    transport.on('error', (error) => {
      this.emit('transport-error', new Error(`中继连接错误：${error?.message ?? error}`));
    });
    transport.on('close', () => {
      this.connected = false;
      this.emit('disconnect');
    });

    await this.#waitForConnect(transport);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        transport.subscribe(this.topics.down, { qos: 1 }, finish);
      } catch {
        finish();
      }
      // 假 transport 可能同步回调，也可能根本不回调：给一个兜底。
      const timer = setTimeout(finish, 2_000);
      timer.unref?.();
    });
    this.connected = true;
    if (announce) await this.announce(true);
    return this;
  }

  /** hello（10 s 限流，force 绕过）。字段与 remote.js 的 announce() 一致。 */
  async announce(force = false) {
    const now = Date.now();
    if (!force && now - (this.lastHelloAt ?? 0) < HELLO_MIN_GAP_MS) return false;
    this.lastHelloAt = now;
    await this.send({ t: 'hello', name: this.name, ver: CLOUD_PROTOCOL, ts: now });
    return true;
  }

  /**
   * 封一帧并 publish（QoS 1），返回信封的字节数。**只有这一个地方**碰 transport。
   * @param {object} object 明文帧
   * @returns {Promise<number>}
   */
  async #publish(object) {
    const envelope = sealFrame(this.#key, this.topics.up, JSON.stringify(object));
    const bytes = Buffer.byteLength(envelope, 'utf8');
    await new Promise((resolve, reject) => {
      try {
        this.#transport.publish(this.topics.up, envelope, { qos: 1 }, (error) => {
          if (error === undefined || error === null) { resolve(); return; }
          this.stats.ackErrors += 1;
          reject(new Error(`中继发送失败：${error?.message ?? error}`));
        });
      } catch (error) {
        this.stats.ackErrors += 1;
        reject(new Error(`中继发送失败：${error?.message ?? error}`));
      }
    });
    return bytes;
  }

  /**
   * 封一帧并 publish（QoS 1）。语义与 `docs/remote.js` 的 `send()` 一致：
   *
   * - 令牌只挂在 `auth` / `req` / `ws.*` 上（电脑端逐帧无状态校验，而 hello 之类的
   *   帧带上令牌既没有必要，也会在日志里多出一份敏感值）；
   * - 明文超过 `MAX_FRAME` 时拆成 `part` 帧（`{t:'part',id,seq,total,d}`），
   *   `id` 是 12 位小写 hex、`d` 是标准 base64 的分片明文；单帧硬发会被公共
   *   broker 静默丢弃（这是线上真实事故，外壳早已修好，探测器必须同规则）。
   *
   * @param {object} object 明文帧
   * @param {{token?: boolean}} [options] token=false 时不挂会话令牌（手工构造边界帧用）
   * @returns {Promise<{t: string, bytes: number, parts?: number}>}
   */
  async send(object, { token = true } = {}) {
    if (!this.connected || this.#transport === undefined) throw new Error('中继尚未就绪');
    const kind = String(object?.t ?? '');
    const needsSession = kind === 'auth' || kind === 'req' || kind.startsWith('ws.');
    const payload = token && needsSession && this.#token.length > 0 && object.token === undefined
      ? { ...object, token: this.#token }
      : { ...object };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    this.stats.tx += 1;
    if (raw.length <= MAX_FRAME) {
      const bytes = await this.#publish(payload);
      this.stats.txBytes += bytes;
      return { t: payload.t, bytes };
    }
    const chunkId = randomBytes(6).toString('hex');
    const total = Math.ceil(raw.length / MAX_FRAME);
    if (total > PART_MAX_TOTAL) throw new Error(`帧过大：${raw.length} 字节，需要 ${total} 片（上限 ${PART_MAX_TOTAL}）`);
    let bytes = 0;
    for (let index = 0; index < total; index += 1) {
      const slice = raw.subarray(index * MAX_FRAME, (index + 1) * MAX_FRAME);
      bytes += await this.#publish({ t: 'part', id: chunkId, seq: index, total, d: slice.toString('base64') });
    }
    this.stats.txBytes += bytes;
    this.stats.txParts += total;
    return { t: payload.t, bytes, parts: total };
  }

  #onPayload(payload) {
    const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
    let message;
    let envelopeBytes = raw.length;
    try {
      const plaintext = openFrame(this.#key, this.topics.down, raw.toString('utf8'));
      message = JSON.parse(plaintext.toString('utf8'));
    } catch (error) {
      this.stats.unsealErrors += 1;
      this.emit('unseal-error', new Error(`下行帧解不开：${error?.message ?? error}`));
      return;
    }
    if (message === null || typeof message !== 'object') return;
    this.stats.rx += 1;
    this.stats.rxBytes += envelopeBytes;
    this.stats.lastRxAt = Date.now();
    const meta = { bytes: envelopeBytes, at: Date.now() };

    if (message.t === 'part') {
      this.stats.partsSeen += 1;
      this.emit('part', message, meta);
      const merged = this.#collectPart(message);
      if (merged === null) return;
      this.stats.partsReassembled += 1;
      message = merged;
    }
    this.#dispatch(message, meta);
  }

  #collectPart(message) {
    const id = String(message.id ?? '');
    if (!/^[0-9a-f]{12}$/u.test(id)) return null;
    const seq = Number(message.seq);
    const total = Number(message.total);
    if (!Number.isInteger(seq) || !Number.isInteger(total)) return null;
    if (total < 1 || total > PART_MAX_TOTAL || seq < 0 || seq >= total) return null;
    const data = typeof message.d === 'string' ? message.d : '';
    if (data.length > Math.ceil((MAX_FRAME * 4) / 3) + 16) return null;
    const chunk = Buffer.from(data, 'base64');
    // 单片解出来不得超过 MAX_FRAME：与外壳 `_collectPart()` 同一条闸门
    // （否则对端一个超大分片就能让本端把几十 MB 拼进内存）。
    if (chunk.length > MAX_FRAME) return null;
    const now = Date.now();
    for (const [key, entry] of this.#parts) {
      if (now - entry.at > PART_TTL_MS) this.#parts.delete(key);
    }
    let entry = this.#parts.get(id);
    if (entry === undefined) {
      entry = { chunks: new Array(total), total, at: now };
      this.#parts.set(id, entry);
    }
    if (entry.total !== total) return null;
    entry.chunks[seq] = chunk;
    entry.at = now;
    for (const chunk of entry.chunks) if (chunk === undefined) return null;
    this.#parts.delete(id);
    try {
      return JSON.parse(Buffer.concat(entry.chunks).toString('utf8'));
    } catch {
      return null;
    }
  }

  #dispatch(message, meta) {
    this.emit('frame', message, meta);
    switch (message.t) {
      case 'hello':
        this.stats.hello += 1;
        if (typeof message.name === 'string' && message.name.length > 0) this.pcName = message.name;
        break;
      case 'beat':
        this.stats.beat += 1;
        if (this.stats.firstBeatAt === 0) this.stats.firstBeatAt = Date.now();
        if (typeof message.name === 'string' && message.name.length > 0) this.pcName = message.name;
        break;
      case 'res': {
        this.stats.res += 1;
        const id = String(message.id ?? '');
        const entry = this.#pending.get(id);
        if (entry === undefined) break;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        let body = Buffer.from(String(message.body ?? ''), 'base64');
        if (message.enc === 'gzip') {
          try {
            body = gunzipSync(body);
          } catch {
            // 解不开时保留原始字节：调用方看得到 enc='gzip' 就能自己判断。
          }
        }
        const reply = {
          id,
          status: Number(message.status) || 0,
          headers: message.headers ?? {},
          enc: String(message.enc ?? ''),
          body,
          ms: Number(message.ms) || 0,
          bytes: meta.bytes,
          at: meta.at,
          raw: message,
        };
        if (reply.status === 401) {
          this.stats.unauthorized += 1;
          this.emit('unauthorized', reply);
        }
        this.#rtts.push({
          id, method: entry.method, path: entry.path, status: reply.status,
          ms: entry.at === 0 ? 0 : meta.at - entry.at, desktopMs: reply.ms,
        });
        entry.resolve(reply);
        break;
      }
      case 'reject': {
        this.stats.reject += 1;
        const id = String(message.id ?? '');
        const entry = this.#pending.get(id);
        if (entry !== undefined) {
          this.#pending.delete(id);
          clearTimeout(entry.timer);
          const error = new Error(`中继拒绝了请求（${String(message.code ?? 'unknown')}）`);
          error.code = String(message.code ?? 'unknown');
          error.frame = message;
          entry.reject(error);
        }
        break;
      }
      case 'ws.open':
      case 'ws.close':
      case 'ws.error':
      case 'ws.msg':
        break;
      default:
        break;
    }
    this.emit(message.t, message, meta);
    for (const waiter of [...this.#waiters]) {
      if (waiter.done === true) continue;
      let matched = false;
      try { matched = waiter.predicate(message, meta) === true; } catch { matched = false; }
      if (!matched) continue;
      waiter.done = true;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve({ message, meta });
    }
  }

  /** 等一条满足谓词的下行帧；超时抛错。 */
  waitForFrame(predicate, timeout = 5_000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, done: false, timer: undefined };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        this.#waiters.delete(waiter);
        reject(new Error('等待中继下行帧超时'));
      }, timeout);
      waiter.timer.unref?.();
      this.#waiters.add(waiter);
    });
  }

  /**
   * 发一个 `req` 并等 `res`。
   *
   * - `seq`/`ts`/`sid` 每次都是新的（旧外壳不带，会被判 bad-seq）；
   * - 只做一次尝试，不自动重发：测试要能看见「超时」和「reject」本身；
   * - 返回 `{status, headers, body, enc, ms, raw}`，401 也算正常返回（与手机一致）。
   *
   * @param {string} method
   * @param {string} path
   * @param {{body?: string|Buffer|Uint8Array, headers?: object, gzip?: boolean, timeout?: number}} [options]
   */
  request(method, path, { body, headers, gzip, timeout } = {}) {
    const id = randomBytes(8).toString('hex');
    const methodText = String(method ?? 'GET').toUpperCase();
    const frame = {
      t: 'req',
      id,
      sid: this.sid,
      seq: this.nextSeq(),
      ts: Date.now(),
      method: methodText,
      path: String(path ?? ''),
    };
    if (headers !== undefined && headers !== null) frame.headers = headers;
    const encoded = toBufferBody(body);
    if (encoded !== undefined && encoded.length > 0) frame.body = encoded.toString('base64');
    if (gzip !== undefined) frame.gzip = gzip !== false;
    const budget = timeout ?? this.#timeoutMs;
    return new Promise((resolve, reject) => {
      const entry = { id, method: methodText, path: String(path ?? ''), resolve, reject, at: 0, timer: undefined };
      entry.timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        this.stats.timeouts += 1;
        const error = new Error(`中继请求超时（${budget}ms 内没有 res）`);
        error.code = 'timeout';
        reject(error);
      }, budget);
      entry.timer.unref?.();
      this.#pending.set(id, entry);
      entry.at = Date.now();
      this.send(frame).catch((error) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(entry.timer);
        reject(error);
      });
    });
  }

  /** 打开一条 WS 隧道：发 `ws.open` 并等 ack，返回隧道句柄。 */
  async openTunnel(path, { id, timeout = 5_000 } = {}) {
    const tunnelId = id ?? randomBytes(8).toString('hex');
    const ack = this.waitForFrame(
      (message) => (message.t === 'ws.open' && message.id === tunnelId) || (message.t === 'ws.error' && message.id === tunnelId),
      timeout,
    );
    await this.send({ t: 'ws.open', id: tunnelId, sid: this.sid, seq: this.nextSeq(), ts: Date.now(), path });
    const { message } = await ack;
    if (message.t === 'ws.error') {
      const error = new Error(`隧道打开被拒（${String(message.message ?? '')}）`);
      error.code = String(message.message ?? 'ws-error');
      throw error;
    }
    return { id: tunnelId, ack: message };
  }

  /** 隧道里发一条数据帧（`ws.msg`）。 */
  async sendWsMessage(id, data, { bin = false } = {}) {
    return this.send({
      t: 'ws.msg',
      id,
      data: bin ? Buffer.from(String(data), 'utf8').toString('base64') : String(data),
      bin,
      sid: this.sid,
      seq: this.nextSeq(),
      ts: Date.now(),
    });
  }

  /** 关隧道（`ws.close`）。 */
  async closeTunnel(id) {
    return this.send({ t: 'ws.close', id, sid: this.sid, seq: this.nextSeq(), ts: Date.now() }).catch(() => undefined);
  }

  /** 鉴权探测（`auth` 帧）：看电脑端到底要不要口令，以及它怎么评价我们的设备令牌。 */
  async checkAuth({ timeout = 8_000 } = {}) {
    const waiter = this.waitForFrame((message) => message.t === 'auth', timeout);
    await this.send({ t: 'auth', phone: this.name, platform: 'node' });
    return (await waiter).message;
  }

  /** 用口令换会话令牌（`login`）。只回 reason/ok，绝不把口令写进返回值。 */
  async login({ user, password, timeout = 15_000 } = {}) {
    const waiter = this.waitForFrame((message) => message.t === 'login', timeout);
    await this.send({ t: 'login', user, password, remember: true, phone: this.name, platform: 'node' });
    return (await waiter).message;
  }

  /** 关掉客户端：清 pending、清分片、断 transport。幂等。 */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('RelayClient 已关闭'));
    }
    this.#pending.clear();
    this.#parts.clear();
    for (const waiter of [...this.#waiters]) {
      waiter.done = true;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
    }
    this.connected = false;
    if (this.#transportOwned) {
      try { this.#transport?.end?.(true); } catch { /* 已经断了 */ }
    }
    this.#transport = undefined;
    this.removeAllListeners();
  }

  /** 只暴露房间号与计数：绝不含 key / token。 */
  toString() {
    return `RelayClient<room=${this.room} online=${this.connected} tx=${this.stats.tx} rx=${this.stats.rx}>`;
  }

  toJSON() {
    return { room: this.room, online: this.connected, stats: { ...this.stats, rtts: undefined } };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this.toString();
  }
}

/** 工厂：与交付文档里建议的 API 一致。 */
export function createRelayClient(options = {}) {
  return new RelayClient(options);
}
