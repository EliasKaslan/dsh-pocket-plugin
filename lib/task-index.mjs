/**
 * The plugin's live task index.
 *
 * "Task" is DSH's logical Session: a top-level user session or a delegated
 * subagent session. The index is built from `sessionQuery.listSessions()` and
 * then kept current from the host's `session/*` events. Session logs are only
 * tail-read for cold sessions; no log is ever appended to.
 *
 * Host-service call shapes (`sessionQuery`, `agents`, `agentPresets`,
 * `agentDefaultModel`, `workspaceRegistry`, `sessions`) intentionally mirror the
 * DSH host API and must not be "improved" without checking the host source.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  buildTranscriptAsync, clipMessage, contentText, isHumanPrompt, messageChars, normalizeEvent, reasonText,
} from './messages.mjs';
import {
  mergePending, normalizePending, questionsFromCall, replyCallId, resultCallId, resultIsPending,
} from './question-state.mjs';
import { lastOfType, readTailEvents, scanSessionFiles } from './session-files.mjs';
import { oneLine, sliceCodePoints } from './util.mjs';

const STATUS_RANK = { running: 0, error: 1, cancelled: 2, done: 3, idle: 4 };
const KNOWN_STATUS = new Set(Object.keys(STATUS_RANK));
const MAX_TASKS = 5000;
const TAIL_LIMIT = 400;
const MAX_CLIENT_IDS = 500;
/** 同时保留待答状态的任务上限（事件兜底只用于正在跑的会话，无需无限增长）。 */
const MAX_QUESTION_SESSIONS = 200;

/** 手机端首屏默认给多少条、单页最多给多少条。 */
export const PAGE_DEFAULT = 40;
export const PAGE_MAX = 80;
/** 单页正文预算（字符）。让每次响应都远低于中继 4 MiB 的分片预算。 */
export const PAGE_CHARS = 48_000;
/** 首屏至少带出最近几条用户输入（用户要的是最近几次我发了什么）。 */
export const MIN_USER_MESSAGES = 3;
/**
 * 列表里每条会话带的预览长度。
 *
 * 内部转录保留 220 字（服务端搜索要用），但**发给手机**的只有 96 字 ——
 * 卡片本来就是两行截断显示。实测列表 300 条从 166 KB 降到 ~90 KB。
 */
export const LIST_PREVIEW_CHARS = 96;
/** 完整转录的条数上限（内存闸）；超出的部分按 truncated 如实告知。 */
const MAX_TRANSCRIPT = 5_000;
/**
 * 单次**全量重建**允许扫描的事件数上限。
 *
 * 依据（都是实测，不是拍的）：
 * - 本机真实语料里最大的那份会话日志是 6.63 MB（zstd）/ 6,414 条事件，
 *   正文合计 3.6 M 字符（UTF-16 约 7.2 MB）；
 * - 2 万条事件的纯重建 **21.4 ms**，且成本随事件数线性（2k → 2万 正好 ×20）；
 * - 详情接口在手机首屏与流式 `?after=` 轮询的热路径上：中继一次 RTT 300~800 ms，
 *   30 ms 级的构建占首屏 < 5%，而一旦重建逼近 relay / 服务端的双 30 s 超时，
 *   就变成"详情页永远打不开 + 每次超时重试再烧一次全量重建"。
 *
 * 取 2 万条 = 真实最大会话的 3.1 倍，正常会话永不触发降级；再长就只给尾部窗口。
 */
const MAX_SCAN_EVENTS = 20_000;
/**
 * 单次全量重建允许扫描的事件正文上限（按 UTF-16 堆字节估算）。
 *
 * 单条事件正文均值约 563 字符 ≈ 1.1 KB 堆；24 MiB ≈ 2 万条真实语料的体量，
 * 正好把"事件数闸"和"字节闸"对齐在同一量级（真实最大会话 7.2 MB 的 3.3 倍）。
 * 防的是"事件不多、单条巨大"的会话（一次贴进几 MB 的命令输出）。
 */
const MAX_SCAN_BYTES = 24 * 1024 * 1024;
/** 转录缓存：会话不再变化时留久一点，运行中的会话短一点。 */
const TRANSCRIPT_CACHE_MAX = 8;
/**
 * 转录缓存的**字节**预算。
 *
 * 只有条数闸（8 条）挡不住体积：单条消息上限 6000 字、单份转录最多 5000 条，
 * 理论上 8 × 5000 × 6000 字符 ≈ 240 MB 常驻，够把宿主的内存打满。取 64 MiB
 * 的依据是中继的响应量级：单次响应的帧预算是 4 MiB 级（见 `lib/cloud.mjs` 的
 * `MAX_FRAME` / `MAX_FRAME_TOTAL`），64 MiB ≈ 16 个满页 —— 够 8 个"正在翻"的
 * 会话各自保留一份完整转录，又给宿主留出余量。超预算按最久未用淘汰。
 */
const TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024;
/** 每条消息的结构开销估算（id / role / 时间戳 / 工具字段），与正文分开算。 */
const MESSAGE_OVERHEAD_BYTES = 64;
const TRANSCRIPT_TTL_MS = 10 * 60_000;
/**
 * 运行中会话的转录缓存 TTL。
 *
 * 只决定"多久允许看一眼新数据"，**不再决定成本**：过期后走的是增量拼接
 * （只处理上次之后新增的事件），不是整份重建。0.8 s 换来"最多每分钟 75 次
 * 便宜追加"，观感仍是实时。
 */
const TRANSCRIPT_RUNNING_TTL_MS = 800;

/** Placeholder stored in `byClientId` while a create is in flight. */
const PENDING = Symbol('pending-create');

function statusFromReason(reason) {
  const kind = reason !== null && typeof reason === 'object' ? reason.kind : undefined;
  if (kind === 'completed' || kind === 'forked') return 'done';
  if (kind === 'aborted' || kind === 'interrupted') return 'cancelled';
  if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens') return 'error';
  return 'idle';
}

function headerParent(header) {
  return header?.parentSession ?? header?.parentSessionId ?? header?.parent?.id;
}

function headerOrigin(header) {
  if (typeof header?.origin === 'string') return header.origin;
  if (headerParent(header) !== undefined) return 'subagent';
  return 'user';
}

function cwdName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '';
  const normalized = cwd.replace(/[\\/]+$/u, '');
  const base = normalized.split(/[\\/]/u).pop() ?? normalized;
  return base.length > 0 ? base : normalized;
}

function pathKey(value) {
  const normalized = String(value).replace(/[\\/]+/gu, path.sep).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Containment test based on `path.relative`, not on string prefixes. Handles
 * junctions/symlinks because callers pass already-realpath'ed values, and
 * `path.win32.relative` compares case-insensitively so `C:\A` covers `c:\a\b`.
 *
 * 判据是**路径段**而不是字符前缀：`..` 与 `..<sep>x` 才是逃逸，根目录里名字就叫
 * `..cache` 的兄弟目录仍然是「根内」。`lib/util.mjs` 的 `safeJoin` 用同一套判据
 * （两边各有一组边界用例：`..` / `../x` / `..cache` / `.hidden` / 绝对路径 / 盘符 / NUL）。
 */
function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 这个会话的事件兜底表里，有没有"宿主确认过正在等人回答"的行。
 *
 * `state === 'continued'` 来自 `{pending:true}` 的 tool result（语义见
 * `question-state.mjs` 的 `resultIsPending`：工具让出前台等待、问题转为可答）；
 * `unknown` 只表示"看到过 tool/call，还没等到任何确认"，信息量最低。
 */
function bucketHasConfirmedQuestion(bucket) {
  for (const row of bucket.values()) if (row?.state === 'continued') return true;
  return false;
}

/**
 * 估算一份转录的常驻体量（字节）。
 *
 * 日常文本在 V8 里约 2 字节/码元（双字节表示），再加每条消息的 id / role /
 * 时间戳等对象开销。这是缓存预算闸，不是精确计量 —— 量级对得上就够。
 */
function transcriptBytes(messages) {
  let total = 0;
  for (const message of messages) total += messageChars(message) * 2 + MESSAGE_OVERHEAD_BYTES;
  return total;
}

/**
 * 已滑出保留窗口的工具调用占位符。
 *
 * 增量拼接时，`toolIndex` 里那条 tool/call 可能已经被 `MAX_TRANSCRIPT` 裁掉。
 * 这时后来的 `tool/result` 若单独成条，会与全量重建的结果不一致（全量重建会把
 * 结果折进那条即将被裁掉的 call，然后一起消失）。占位符把两种情况对齐成"看不见"。
 */
const EVICTED_TOOL = Symbol('evicted-tool');

/** 估算一段正文的堆字节：字符串按 UTF-16 两个字节/码元，多段内容（text part）累加。 */
function textHeapBytes(value) {
  if (typeof value === 'string') return value.length * 2;
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const part of value) {
    if (typeof part?.text === 'string') total += part.text.length * 2;
  }
  return total;
}

/**
 * 单条事件的体量估算（**不序列化**，只统计真正占体积的字符串）。
 *
 * 为什么不用 `JSON.stringify(event).length`：6 MB 级的日志光是序列化就要几十毫秒，
 * 等于把"省下来的重建时间"又花回去。这里只走几个固定字段，O(1)。
 */
function eventTextBytes(event) {
  if (event === null || typeof event !== 'object') return 16;
  let total = 48;
  const data = event.data;
  if (data === null || typeof data !== 'object') return total;
  total += textHeapBytes(data.content);
  total += textHeapBytes(data.arguments);
  total += textHeapBytes(data.title);
  const message = data.message;
  if (message !== null && typeof message === 'object') {
    total += textHeapBytes(message.content);
    total += textHeapBytes(message.text);
  }
  return total;
}

/**
 * 校验手机端提交的 `answers` 批次（宿主侧还会再校验一次，这里先给出可读的中文错误）。
 *
 * 契约：数组，每个问题恰好一条 `{ id, selected: string[], custom?: string }`；
 * `selected` 是**选项 label**；单选自定义时 `selected` 必须是空数组。
 */
export function normalizeAnswers(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw codedError('bad_answer', '缺少 answers（每个问题一条）');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (item === null || typeof item !== 'object') throw codedError('bad_answer', 'answers 的每一项都必须是对象');
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id.length === 0) throw codedError('bad_answer', 'answers 里缺少问题 id');
    if (seen.has(id)) throw codedError('bad_answer', `问题 ${id} 出现了多次`);
    seen.add(id);
    const selected = item.selected === undefined ? [] : item.selected;
    if (!Array.isArray(selected) || selected.some((label) => typeof label !== 'string' || label.trim().length === 0)) {
      throw codedError('bad_answer', 'selected 必须是选项 label 的字符串数组');
    }
    if (item.custom !== undefined && typeof item.custom !== 'string') {
      throw codedError('bad_answer', 'custom 必须是字符串');
    }
    const answer = { id, selected: [...selected] };
    const custom = typeof item.custom === 'string' ? item.custom.trim() : '';
    if (custom.length > 0) answer.custom = custom;
    out.push(answer);
  }
  return out;
}

/** 每条回答都对得上一个真实问题，且数量、label 与题型一致。 */
function assertAnswerBatch(answers, questions) {
  if (answers.length !== questions.length) {
    throw codedError('bad_answer', `这次提问有 ${questions.length} 个问题，但收到了 ${answers.length} 条回答`);
  }
  const byId = new Map(answers.map((item) => [item.id, item]));
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (answer === undefined) throw codedError('bad_answer', `问题「${question.question}」没有回答`);
    const labels = Array.isArray(question.options) ? question.options.map((option) => option.label) : [];
    const unknown = answer.selected.find((label) => labels.length > 0 && !labels.includes(label));
    if (unknown !== undefined) throw codedError('bad_answer', `选项 ${unknown} 不属于问题 ${question.id}`);
    if (question.multiSelect !== true) {
      if (answer.selected.length > 1) throw codedError('bad_answer', `问题 ${question.id} 是单选，只能选一个选项`);
      if (answer.selected.length > 0 && answer.custom !== undefined) {
        throw codedError('bad_answer', `问题 ${question.id} 单选自定义时 selected 必须为空`);
      }
    }
  }
}

/** 把宿主的 `UserQuestionError` code 翻译成手机端能懂的错误码。 */
function mapAnswerError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const detail = typeof error?.message === 'string' && error.message.length > 0 ? error.message : undefined;
  if (code === 'BAD_ANSWER') return codedError('bad_answer', detail ?? '回答内容不合法');
  if (code === 'REPLY_QUEUED') return codedError('reply_queued', '已经有一条答复在排队，请稍候再试');
  if (code === 'CALLER_NOT_LIVE') return codedError('not_running', '任务当前未运行，无法回答提问');
  if (code === 'DELEGATED_CALLER') return codedError('desktop_only', '子代理任务不能由手机回答');
  if (code === 'NO_PROVIDER') return codedError('question_open', '电脑端仍在等待答复，请稍后刷新再试');
  const wrapped = new Error(detail ?? '回答失败');
  wrapped.code = 'answer_failed';
  return wrapped;
}

/**
 * 从完整转录里切出一页（手机端往上翻的单位）。
 *
 * 契约：
 * - 不带 `before`：从**尾部**取一页，并保证至少包含最近 `MIN_USER_MESSAGES`
 *   条用户输入（用户最先想看的是"我最近说了什么"）。
 * - 带 `before=<消息 id>`：取这条消息**之前**的一页。游标用的是某条消息自己的
 *   id，所以相邻两页不会重叠、也不会漏。
 * - 每页受 `cap` 条数与 `PAGE_CHARS` 字符双重约束；单条都远小于预算，
 *   所以"至少一条"永远成立。
 * - 游标在转录里找不到（缓存重建 / 会话被改写）：返回尾部一页并置
 *   `cursorLost`，让手机端把列表重置成这一页，而不是空转。
 *
 * @param {Array} messages 完整转录（按时间正序）
 * @param {{before?: string, limit?: number}} [options]
 */
export function slicePage(messages, { before = '', limit = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  // 调用方显式给了 limit 就是硬要求（手机翻页时永远是显式的 40）；
  // 没给才是"给我一屏合适的内容"——只有这种情况才允许为凑齐用户输入而扩窗。
  const explicitLimit = Number.isFinite(limit) && limit > 0;
  const cap = explicitLimit ? Math.min(PAGE_MAX, Math.floor(limit)) : PAGE_DEFAULT;
  const cursor = typeof before === 'string' ? before.trim() : '';

  if (total === 0) {
    return { messages: [], total: 0, offset: 0, hasMore: false, nextBefore: '', cursorLost: cursor.length > 0 };
  }

  let end = total;
  let cursorLost = false;
  if (cursor.length > 0) {
    const at = list.findIndex((message) => message?.id === cursor);
    if (at < 0) cursorLost = true;
    else end = at;
  }

  if (end === 0) {
    // 游标指向第一条：再往前确实没有了。
    return { messages: [], total, offset: 0, hasMore: false, nextBefore: '', cursorLost };
  }

  let start = end;
  let chars = 0;
  let users = 0;
  while (start > 0 && end - start < cap) {
    const message = list[start - 1];
    const size = messageChars(message);
    // 至少收一条：否则一条超大消息会让这一页永远是空的。
    if (start < end && chars + size > PAGE_CHARS) break;
    chars += size;
    start -= 1;
    if (message?.role === 'user') users += 1;
  }

  /**
   * 首屏要"最近几次用户输入"都在：窗口里 user 太少就往前扩。
   *
   * 两个硬边界，缺一个都会出事（曾经缺过，一页能拉回整个会话）：
   *   1. 只对**首屏**做（无游标、未显式 limit）；翻页请求必须严格遵守游标；
   *   2. 扩窗后总条数不得超过 2×cap，且仍要守住 `PAGE_CHARS` 字节预算。
   */
  if (!explicitLimit && cursor.length === 0 && users < MIN_USER_MESSAGES) {
    // 只为了凑够 MIN_USER_MESSAGES 条用户输入；2×cap（80 条）在长回合里等于
    // 首屏 112 KB，而多出来的信息价值有限。收到 cap+20。
    const extendCap = cap + 20;
    while (users < MIN_USER_MESSAGES && start > 0 && end - start < extendCap) {
      const message = list[start - 1];
      const size = messageChars(message);
      if (chars + size > PAGE_CHARS) break;
      chars += size;
      start -= 1;
      if (message?.role === 'user') users += 1;
    }
  }

  const hasMore = start > 0;
  return {
    messages: list.slice(start, end),
    total,
    offset: start,
    hasMore,
    nextBefore: hasMore ? String(list[start]?.id ?? '') : '',
    cursorLost,
  };
}

/**
 * 从完整转录里取「某条消息之后」的一页 —— 流式输出时的增量通道。
 *
 * 与 [`slicePage`] 对称：那个往更早翻，这个往更新追。
 * - 带游标：取它**之后**的消息，受 `cap` 条数与 `PAGE_CHARS` 字符双重约束；
 * - 游标在转录里找不到（缓存重建/会话被改写）：返回尾部一页并置 `reset`，
 *   调用方应改成整页重载，而不是把两段拼在一起。
 *
 * @param {Array} messages 完整转录（按时间正序）
 * @param {{after?: string, limit?: number}} [options]
 */
export function sliceAfter(messages, { after = '', limit = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(PAGE_MAX, Math.floor(limit)) : PAGE_DEFAULT;
  const cursor = typeof after === 'string' ? after.trim() : '';

  if (total === 0) {
    return {
      messages: [], total: 0, reset: cursor.length > 0, hasMore: false,
    };
  }

  let start;
  let reset = false;
  if (cursor.length === 0) {
    start = Math.max(0, total - cap);
  } else {
    const at = list.findIndex((message) => message?.id === cursor);
    if (at < 0) {
      reset = true;
      start = Math.max(0, total - cap);
    } else {
      start = at + 1;
    }
  }

  let end = start;
  let chars = 0;
  while (end < total && end - start < cap) {
    const size = messageChars(list[end]);
    // 至少收一条，避免一条超长消息把增量窗口永远卡空。
    if (end > start && chars + size > PAGE_CHARS) break;
    chars += size;
    end += 1;
  }

  return {
    messages: list.slice(start, end),
    total,
    reset,
    // 还有更新的没取完（说明这一批被预算截断了），调用方可以再要一次。
    hasMore: end < total,
  };
}

/**
 * 把 `core.createWsTicket()` 的返回值收成可以随详情下发的形状。
 *
 * 只放行 `{ticket, expiresAt}` 两个字段：票是凭据，多余字段（以后 core 若加了
 * 内部标记）不该跟着详情一起出门；形状不合法就当作"没有票"，客户端退回现取。
 *
 * @param {{ticket?: string, expiresAt?: number}|null|undefined} value
 * @returns {{ticket: string, expiresAt: number}|null}
 */
export function wsTicketPayload(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const ticket = typeof value.ticket === 'string' ? value.ticket : '';
  const expiresAt = Number(value.expiresAt);
  if (ticket.length === 0 || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return { ticket, expiresAt };
}

export class TaskIndex {
  constructor({ logger, emit, state, config, services, home, dataDir }) {
    this.logger = logger;
    this.emit = emit;
    this.state = state;
    this.config = config;
    this.services = services;
    this.home = home;
    this.dataDir = dataDir ?? '';
    this.tasks = new Map();
    this.byClientId = new Map();
    this.loading = false;
    this.loadedAt = 0;
    this.loadError = undefined;
    this.loadPromise = undefined;
    this.pendingUpdates = new Map();
    this.summaryTimer = undefined;
    this.transcripts = new Map();
    /** 转录缓存当前占用的估算字节（与 `transcripts` 同步增减）。 */
    this.transcriptBytes = 0;
    /** sessionId -> 正在跑的构建 promise：同一 id 并发只构建一次（单飞）。 */
    this.transcriptFlights = new Map();
    /**
     * 转录扫描计量。热路径成本只靠"感觉"是修不动的，所以把每次构建真正处理了
     * 多少事件/多少字节记下来，测试与线上诊断都能直接看：
     * `{ builds, fullBuilds, incrementalBuilds, eventsScanned, bytesScanned }`。
     */
    this.transcriptMeter = {
      builds: 0,
      fullBuilds: 0,
      incrementalBuilds: 0,
      eventsScanned: 0,
      bytesScanned: 0,
    };
    /**
     * 全量重建的扫描上限。默认 2 万条 / 24 MiB（依据见文件顶部的
     * `MAX_SCAN_EVENTS` / `MAX_SCAN_BYTES`）；测试用 `config.maxScanEvents`
     * 调小，才能在几十条事件的规模上真的走到"降级成尾部窗口"。
     */
    const configuredScanEvents = Number(config?.maxScanEvents);
    this.maxScanEvents = Number.isFinite(configuredScanEvents) && configuredScanEvents >= 1
      ? Math.floor(configuredScanEvents)
      : MAX_SCAN_EVENTS;
    const configuredScanBytes = Number(config?.maxScanBytes);
    this.maxScanBytes = Number.isFinite(configuredScanBytes) && configuredScanBytes > 0
      ? configuredScanBytes
      : MAX_SCAN_BYTES;
    /**
     * 字节预算。默认 64 MiB，测试可以用 `config.transcriptCacheBytes` 调小来
     * 在几十条消息的规模上验证淘汰顺序（不必真造 64 MiB）。
     */
    const configuredBytes = Number(config?.transcriptCacheBytes);
    this.transcriptCacheBytes = Number.isFinite(configuredBytes) && configuredBytes > 0
      ? configuredBytes
      : TRANSCRIPT_CACHE_BYTES;
    /**
     * 任务表上限。默认 5000；测试用 `config.maxTasks` 调到个位数，才能在几十条
     * 数据的规模上真实走到「索引已满」分支（那条分支决定了幂等键还灵不灵）。
     */
    const configuredMaxTasks = Number(config?.maxTasks);
    this.maxTasks = Number.isFinite(configuredMaxTasks) && configuredMaxTasks >= 1
      ? Math.floor(configuredMaxTasks)
      : MAX_TASKS;
    this.agentLocks = new Map();
    this.maxTasksWarned = false;
    /** 无日志文件可降级时只告警一次，别让手机的每次轮询都刷一行。 */
    this.surfaceFallbackWarned = false;
    /** sessionId -> Map<callId, {callId, questions, state}>：投影读不到时的兜底状态。 */
    this.questionCalls = new Map();
    /** 投影读取失败只告警一次，别让每条详情都刷一行日志。 */
    this.questionWarned = false;
  }

  setServices(services) {
    this.services = services;
  }

  get ready() {
    return this.services.sessionQuery !== undefined && this.services.agents !== undefined;
  }

  start() {
    if (this.loadPromise !== undefined) return this.loadPromise;
    const promise = this.load().catch((error) => {
      this.loadError = String(error?.message ?? error);
      this.logger.error('task index load failed', error);
      this.loading = false;
      this.emit('bridge.status', { ready: this.ready, loading: false, error: this.loadError, tasks: this.tasks.size });
    }).finally(() => {
      // Allow a later attempt: host services may arrive after the first try.
      if (this.loadError !== undefined) this.loadPromise = undefined;
    });
    this.loadPromise = promise;
    return promise;
  }

  async load() {
    this.loading = true;
    const started = Date.now();
    try {
      const sessionQuery = this.services.sessionQuery;
      if (sessionQuery === undefined) throw new Error('sessionQuery service is not available');
      const rows = await sessionQuery.listSessions();
      const files = scanSessionFiles(this.home);
      for (const row of rows) {
        // 宿主返回一行 null/undefined 不该把整个索引带下去：那个 TypeError 会抛在
        // `loading = false` 之前，索引从此永久卡在 loading，跟广播出去的
        // bridge.status.loading:false 自相矛盾，而且再也不会重试。
        if (row === null || typeof row !== 'object') continue;
        this.upsertRow(row, files.get(row.header?.id));
      }
      // Parent/child links must be rebuilt after every row exists: the host does
      // not promise parent-before-child ordering.
      this.rebuildChildren();
      this.loadedAt = Date.now();
      this.loadError = undefined;
      this.logger.info(`task index loaded ${this.tasks.size} sessions from ${rows.length} rows in ${Date.now() - started}ms`);
      this.emit('tasks.changed', { reason: 'loaded', count: this.tasks.size });
      this.emitSummary();
    } finally {
      // 无论成功还是抛错都要放开这个闸，理由同上。
      this.loading = false;
    }

    const ids = [...this.tasks.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((task) => task.id);
    // Titles are cheap enough to fill in the background; tails are bounded so a
    // huge historical corpus cannot stall the host at startup.
    void this.loadTitles(ids);
    void this.loadTails(ids.slice(0, TAIL_LIMIT));
    return this.tasks.size;
  }

  rebuildChildren() {
    for (const task of this.tasks.values()) task.children = [];
    for (const task of this.tasks.values()) {
      if (!task.isSubagent || task.parentId === undefined) continue;
      const parent = this.tasks.get(task.parentId);
      if (parent !== undefined && !parent.children.includes(task.id)) parent.children.push(task.id);
    }
  }

  upsertRow(row, file) {
    const header = row?.header;
    if (header === null || typeof header !== 'object' || typeof header.id !== 'string') return undefined;
    if (header.isSeeded === true && this.config.showSeeded !== true) return undefined;
    if (this.tasks.size >= this.maxTasks && !this.tasks.has(header.id)) {
      if (!this.maxTasksWarned) {
        this.maxTasksWarned = true;
        this.logger.warn(`task index is full (${this.maxTasks}); newer sessions will not be listed`);
      }
      return undefined;
    }
    const existing = this.tasks.get(header.id);
    const parentId = headerParent(header);
    const origin = headerOrigin(header);
    const isSubagent = origin === 'subagent' || parentId !== undefined;
    const createdAt = typeof header.createdAt === 'number' ? header.createdAt : Date.now();
    const task = existing ?? {
      id: header.id,
      title: '',
      titleSource: 'none',
      status: 'idle',
      statusReason: '',
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      cwdName: cwdName(header.cwd),
      createdAt,
      updatedAt: createdAt,
      turn: 0,
      model: undefined,
      preset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
      origin,
      parentId,
      isSubagent,
      live: false,
      persisted: false,
      blank: true,
      messageCount: 0,
      toolCount: 0,
      lastText: '',
      lastRole: '',
      children: [],
    };
    task.live = row.live === true || this.services.agents?.get?.(header.id) !== undefined;
    task.persisted = row.persisted === true;
    if (task.live) {
      const status = this.services.agents?.get?.(header.id)?.status;
      if (status === 'running') task.status = 'running';
    }
    if (file !== undefined) {
      task.updatedAt = Math.max(task.updatedAt, file.mtimeMs);
      task.file = file.file;
      task.fileMtime = file.mtimeMs;
    }
    this.tasks.set(task.id, task);
    if (task.isSubagent && task.parentId !== undefined) {
      const parent = this.tasks.get(task.parentId);
      if (parent !== undefined && !parent.children.includes(task.id)) parent.children.push(task.id);
    }
    return task;
  }

  async loadTitles(ids) {
    const sessionQuery = this.services.sessionQuery;
    if (sessionQuery === undefined) return;
    const chunkSize = 80;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      try {
        const results = await sessionQuery.readTitleSnapshots(chunk);
        let changed = 0;
        for (const result of results) {
          if (result?.status !== 'fulfilled') continue;
          const value = result.value;
          const id = value?.session?.id;
          const title = value?.title?.title ?? value?.title;
          if (typeof id !== 'string' || typeof title !== 'string' || title.trim().length === 0) continue;
          const task = this.tasks.get(id);
          if (task === undefined) continue;
          if (task.titleSource !== 'provider' || task.title !== title.trim()) {
            task.title = title.trim();
            task.titleSource = 'provider';
            task.blank = false;
            changed += 1;
          }
        }
        if (changed > 0) this.emit('tasks.changed', { reason: 'titles', count: changed });
      } catch (error) {
        this.logger.warn('title projection failed', error);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.emitSummary();
  }

  async loadTails(ids) {
    const concurrency = 6;
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        const id = ids[index];
        const task = this.tasks.get(id);
        if (task === undefined || task.live || task.file === undefined) continue;
        try {
          await this.applyTail(task);
        } catch (error) {
          this.logger.warn('tail read failed', id, error);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    this.emit('tasks.changed', { reason: 'tails', count: ids.length });
    this.emitSummary();
  }

  async applyTail(task) {
    if (task.fileMtime !== undefined && task.tailMtime === task.fileMtime) return;
    const events = await readTailEvents(task.file);
    if (events === undefined || events.length === 0) return;
    task.tailMtime = task.fileMtime;
    task.tailEvents = events;
    const title = lastOfType(events, 'session/title')?.data?.title;
    if (typeof title === 'string' && title.trim().length > 0 && task.titleSource !== 'provider') {
      task.title = title.trim();
      task.titleSource = 'provider';
      task.blank = false;
    }
    const descriptor = lastOfType(events, 'subagent/descriptor')?.data;
    if (task.title.length === 0 && typeof descriptor?.label === 'string') {
      task.title = descriptor.label;
      task.titleSource = 'descriptor';
      task.blank = false;
    }
    const end = lastOfType(events, 'turn/end');
    if (end !== undefined) {
      task.turn = typeof end?.data?.turn === 'number' ? end.data.turn : task.turn;
      task.status = statusFromReason(end?.data?.reason);
      task.statusReason = reasonText(end?.data?.reason);
    }
    const header = lastOfType(events, 'request/header')?.data?.header?.config;
    if (header !== null && typeof header === 'object' && typeof header.model === 'string') {
      task.model = { provider: header.provider ?? '', model: header.model };
    }
    let lastAssistant;
    let lastUser;
    let toolCount = 0;
    let messageCount = 0;
    for (const event of events) {
      if (event?.type === 'assistant/message') {
        lastAssistant = event;
        messageCount += 1;
      } else if (event?.type === 'user/message' && isHumanPrompt(event)) {
        lastUser = event;
        messageCount += 1;
      } else if (event?.type === 'tool/call') toolCount += 1;
    }
    if (lastAssistant !== undefined) {
      const message = lastAssistant?.data?.message;
      const text = contentText(message?.content);
      const source = message?.source;
      if (text.length > 0) {
        task.lastText = oneLine(text, 220);
        task.lastRole = 'assistant';
        task.blank = false;
      }
      if (source !== null && typeof source === 'object' && typeof source.model === 'string') {
        task.model = { provider: source.provider ?? '', model: source.model };
      }
      if (typeof lastAssistant.time === 'number') task.updatedAt = Math.max(task.updatedAt, lastAssistant.time);
    }
    if (task.lastText.length === 0 && lastUser !== undefined) {
      const text = contentText(lastUser?.data?.content);
      if (text.length > 0) {
        task.lastText = oneLine(text, 220);
        task.lastRole = 'user';
        task.blank = false;
      }
    }
    // Counts are exact only for the tail window; label them as recent.
    task.messageCount = Math.max(task.messageCount, messageCount);
    task.toolCount = Math.max(task.toolCount, toolCount);
    if (task.title.length === 0 && lastUser !== undefined) {
      const text = contentText(lastUser?.data?.content);
      if (text.length > 0) {
        task.title = oneLine(text, 42);
        task.titleSource = 'derived';
        task.blank = false;
      }
    }
    if (task.title.length === 0) {
      task.title = `未命名任务 · ${new Date(task.createdAt).toLocaleDateString('zh-CN')}`;
      task.titleSource = 'derived';
    }
  }

  handleSessionCreated(session) {
    const header = session?.header;
    if (header === null || typeof header !== 'object') return;
    const task = this.upsertRow({ header, live: true, persisted: true });
    if (task === undefined) return;
    task.live = true;
    this.emit('task.created', this.publicTask(task));
    this.emitSummary();
  }

  handleSessionDisposed(session) {
    const id = session?.id ?? session?.header?.id;
    const task = this.tasks.get(id);
    // 会话被关掉时它的提问也一并作废：留着只会在手机上产出一张永远提交不了的卡。
    if (typeof id === 'string') this.questionCalls.delete(id);
    if (task === undefined) return;
    task.live = false;
    this.scheduleUpdate(task);
  }

  handleEvent(session, event) {
    const id = session?.id ?? session?.header?.id;
    if (typeof id !== 'string' || event === null || typeof event !== 'object') return;
    // 待答提问与任务状态无关：事件一进来就记，别等 upsertRow 成功。
    this.trackQuestionEvent(id, event);
    let task = this.tasks.get(id);
    if (task === undefined) {
      task = this.upsertRow({ header: session.header, live: true, persisted: true });
      if (task === undefined) return;
    }
    task.live = true;
    task.updatedAt = typeof event.time === 'number' ? Math.max(task.updatedAt, event.time) : Date.now();
    switch (event.type) {
      case 'turn/start':
        task.status = 'running';
        task.statusReason = '';
        if (typeof event?.data?.turn === 'number') task.turn = event.data.turn;
        break;
      case 'turn/end':
        task.status = statusFromReason(event?.data?.reason);
        task.statusReason = reasonText(event?.data?.reason);
        if (typeof event?.data?.turn === 'number') task.turn = event.data.turn;
        break;
      case 'session/title': {
        const title = event?.data?.title;
        if (typeof title === 'string' && title.trim().length > 0) {
          task.title = title.trim();
          task.titleSource = 'provider';
          task.blank = false;
        }
        break;
      }
      case 'assistant/message': {
        task.messageCount += 1;
        const message = event?.data?.message;
        const text = contentText(message?.content);
        const source = message?.source;
        if (text.length > 0) {
          task.lastText = oneLine(text, 220);
          task.lastRole = 'assistant';
          task.blank = false;
        }
        if (source !== null && typeof source === 'object' && typeof source.model === 'string') {
          task.model = { provider: source.provider ?? '', model: source.model };
        }
        break;
      }
      case 'user/message':
        if (isHumanPrompt(event)) {
          task.messageCount += 1;
          const text = contentText(event?.data?.content);
          if (text.length > 0) {
            task.lastText = oneLine(text, 220);
            task.lastRole = 'user';
            task.blank = false;
            if (task.title.length === 0) {
              task.title = oneLine(text, 42);
              task.titleSource = 'derived';
            }
          }
        }
        break;
      case 'tool/call':
        task.toolCount += 1;
        break;
      case 'session/error':
      case 'error':
        task.status = 'error';
        task.statusReason = oneLine(event?.data?.error?.message ?? event?.data?.message ?? '执行出错', 200);
        break;
      default:
        break;
    }
    const message = normalizeEvent(event);
    if (message !== undefined) {
      // live 事件走的是旁路，不经过 buildTranscript —— 不在这里裁，一条 100k
      // 字符的正文（桌面粘贴、模型整篇输出）就会以原始体积进中继，超过单消息
      // 64 帧 × 64 KiB 的预算根本发不出去。复用同一个 clip，别再造一份规则。
      this.emit('task.message', { taskId: id, message: clipMessage(message) });
    }
    this.scheduleUpdate(task);
  }

  /**
   * 跟踪 `ask_user_question` 的待答状态（事件兜底）。
   *
   * 入 active：`tool/call`（name 必须是 `ask_user_question`，参数是 snake_case）；
   * 出 active：同一 callId 的 `user-question-reply` 用户消息（宿主用它关闭问题），
   * 或一条**不带** `{pending:true}` 的 `tool/result`。
   *
   * 计时提问的 tool result 会先于人的回答落地（工具把前台等待让出后立刻返回
   * `{pending:true}`，问题转为 continued）。如果这时把行删掉，用户会看到
   * "问题消失了"，所以 `pending` 结果只把状态改成 continued。
   */
  trackQuestionEvent(id, event) {
    const call = questionsFromCall(event);
    if (call !== undefined) {
      let bucket = this.questionCalls.get(id);
      if (bucket === undefined) {
        bucket = new Map();
        this.questionCalls.set(id, bucket);
      }
      bucket.set(call.callId, call);
      this.trimQuestionCalls();
      return;
    }
    const callId = resultCallId(event) ?? replyCallId(event);
    if (callId === undefined) return;
    const bucket = this.questionCalls.get(id);
    if (bucket === undefined) return;
    if (resultIsPending(event)) {
      const row = bucket.get(callId);
      if (row !== undefined) bucket.set(callId, { ...row, state: 'continued' });
      return;
    }
    bucket.delete(callId);
    if (bucket.size === 0) this.questionCalls.delete(id);
  }

  /**
   * 会话级淘汰：`questionCalls` 只按会话数计上限。
   *
   * 淘汰顺序不能只按插入顺序：待答卡片一被淘汰，用户在手机上就再也看不到这个
   * 问题（只能回电脑端），而按插入顺序淘汰时，最先丢的恰好是最早那些会话 ——
   * 其中一个很可能正挂着等回答的卡片。
   *
   * 所以优先淘汰"没在等答复"的会话（判据见 `questionBucketAwaiting`）；
   * 只有全部都在等答复时才退回丢最早那个。
   */
  trimQuestionCalls() {
    while (this.questionCalls.size > MAX_QUESTION_SESSIONS) {
      let firstIdle;
      let firstAny;
      for (const [sessionId, bucket] of this.questionCalls) {
        if (firstAny === undefined) firstAny = sessionId;
        if (!this.questionBucketAwaiting(bucket, sessionId)) {
          firstIdle = sessionId;
          break;
        }
      }
      const victim = firstIdle ?? firstAny;
      if (victim === undefined) return;
      this.questionCalls.delete(victim);
    }
  }

  /**
   * 这个会话的兜底待答表还"值得留"吗 —— 两条判据取并集：
   *   - 宿主确认过在等人回答（`state === 'continued'`，来自 `{pending:true}`）；
   *   - 会话**还在运行**：阻塞式（legacy）提问永远不进投影，只能靠事件兜底，
   *     它的行一直是 `unknown`，但会话还在跑就意味着卡片可能还挂着。
   */
  questionBucketAwaiting(bucket, sessionId) {
    if (bucketHasConfirmedQuestion(bucket)) return true;
    return this.tasks.get(sessionId)?.status === 'running';
  }

  /**
   * 读宿主的 `session.projections.faceOf('userQuestions')`。
   *
   * `undefined` 表示"没有投影可读"（宿主没组合 sessionProjections、或插件拿不到
   * `sessions.binding`），**不是**"没有待答问题"——调用方据此回退到事件推导。
   * 投影是加分项，任何异常都吞掉并只告警一次，不能把详情接口打成 500。
   */
  projectedQuestions(id) {
    const sessions = this.services.sessions;
    if (sessions === undefined || typeof sessions.binding !== 'function') return undefined;
    try {
      const binding = sessions.binding(id);
      const face = binding?.session?.projections?.faceOf?.('userQuestions');
      const view = typeof face?.getSnapshot === 'function' ? face.getSnapshot() : undefined;
      if (view === null || typeof view !== 'object' || !Array.isArray(view.active)) return undefined;
      return view.active;
    } catch (error) {
      if (this.questionWarned !== true) {
        this.questionWarned = true;
        this.logger.warn('userQuestions projection unavailable, falling back to session events', error);
      }
      return undefined;
    }
  }

  /**
   * 待答问题（手机端详情用）。
   *
   * 形状恒为数组：`[{ callId, questions, state, answerable, reason? }]`。
   * - `userQuestions` 服务不存在（老版本 DSH）→ 恒 `[]`，绝不抛；
   * - 投影优先，事件兜底；阻塞式提问不在投影里，靠事件兜底显示成
   *   `answerable:false, reason:'desktop-only'`（只能电脑端回答）。
   */
  pendingQuestions(id) {
    if (this.services.userQuestions === undefined) return [];
    const projected = this.projectedQuestions(id);
    const bucket = this.questionCalls.get(id);
    const tracked = bucket === undefined ? [] : [...bucket.values()];
    return mergePending({ projected, tracked });
  }

  /**
   * 回答一次 `ask_user_question`。
   *
   * 走进程内 `ctx.userQuestions.answer(agent, callId, { answers })`。这条路径
   * **只对投影里 state === 'continued' 的调用有效**：前台计时等待还没让出的
   * `open` 提问只能由认领了 waterfall 的客户端（桌面端）回答，`answer()` 会
   * 返回 false。所以这里把情况分清楚，绝不让手机端"点了没反应"：
   *   - `open`        → 409 `question_open`（文案说明稍后重试）
   *   - 仅电脑端可答  → 409 `desktop_only`
   *   - 已不在 active → 404 `question_not_found`
   */
  async answerQuestion(id, body) {
    const service = this.services.userQuestions;
    if (service === undefined || typeof service.answer !== 'function') {
      throw codedError('unsupported', '当前 DSH 版本不支持在手机上回答提问');
    }
    const task = this.tasks.get(id);
    if (task === undefined) throw codedError('not_found', 'task not found');
    const callId = typeof body?.callId === 'string' ? body.callId.trim() : '';
    if (callId.length === 0) throw codedError('bad_answer', '缺少 callId');
    const answers = normalizeAnswers(body?.answers);

    const projected = this.projectedQuestions(id);
    let questions;
    if (projected !== undefined) {
      const row = projected
        .map((item) => normalizePending(item))
        .find((item) => item !== undefined && item.callId === callId);
      if (row === undefined) {
        // 投影里没有：可能是阻塞式提问（不在投影里），也可能是已经落定。
        if (this.questionCalls.get(id)?.has(callId) === true) {
          throw codedError('desktop_only', '这个提问只能在电脑端回答（阻塞式提问没有远程接答通道）');
        }
        throw codedError('question_not_found', '这个问题已经回答或已失效，请刷新后重试');
      }
      if (row.state === 'open') {
        throw codedError('question_open', '电脑端仍在前台计时等待，请稍后刷新再试');
      }
      questions = row.questions;
    } else {
      questions = this.questionCalls.get(id)?.get(callId)?.questions;
    }
    if (questions !== undefined) assertAnswerBatch(answers, questions);

    const agents = this.services.agents;
    const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined;
    if (agent === undefined) throw codedError('not_running', '任务当前未运行，无法回答提问');

    let accepted;
    try {
      accepted = await service.answer(agent, callId, { answers });
    } catch (error) {
      throw mapAnswerError(error);
    }
    if (accepted === false) {
      throw codedError('question_open', '电脑端仍在计时等待，答复暂未被收下，请稍后刷新再试');
    }
    const bucket = this.questionCalls.get(id);
    if (bucket !== undefined) {
      bucket.delete(callId);
      if (bucket.size === 0) this.questionCalls.delete(id);
    }
    return { task: this.publicTask(task), pendingQuestions: this.pendingQuestions(id) };
  }

  scheduleUpdate(task) {
    if (this.pendingUpdates.has(task.id)) return;
    const timer = setTimeout(() => {
      this.pendingUpdates.delete(task.id);
      this.emit('task.updated', this.publicTask(task));
      this.emitSummary();
    }, 120);
    timer.unref?.();
    this.pendingUpdates.set(task.id, timer);
  }

  /**
   * 列表行用的「待回答」信号。
   *
   * 只对可能挂起提问的会话计算：先看事件兜底表（O(1)），否则仅 running 的会话才去读投影，
   * 避免列表 300 行每行都查一次投影。
   */
  hasPendingQuestion(task) {
    if (this.services.userQuestions === undefined) return false;
    if (this.questionCalls.has(task.id)) return true;
    if (task.status !== 'running') return false;
    return this.pendingQuestions(task.id).length > 0;
  }

  /**
   * 合成一份「索引里没有、但必须回给手机」的任务视图。
   *
   * 幂等命中是最常见的触发场景：索引已满（`upsertRow` 拒收新行）时命中的 id
   * 在 `this.tasks` 里根本没有行。手机端拿到 id 就够了（它会跳 `/task/<id>`），
   * 但字段集合必须与 `publicTask` 一致，别让客户端去猜缺了哪些键。
   */
  syntheticTask(id, { cwd = '', preset, title = '', status = 'running' } = {}) {
    const now = Date.now();
    return {
      id,
      title: title.length > 0 ? title : '未命名任务',
      status,
      statusReason: '',
      cwd,
      cwdName: cwdName(cwd),
      createdAt: now,
      updatedAt: now,
      turn: 0,
      model: undefined,
      preset,
      origin: 'user',
      isSubagent: false,
      messageCount: 0,
      toolCount: 0,
      lastText: '',
      lastRole: '',
      titleSource: title.length > 0 ? 'derived' : 'none',
      childCount: 0,
    };
  }

  publicTask(task, extra) {
    return {
      id: task.id,
      title: task.title || '未命名任务',
      status: task.status,
      statusReason: task.statusReason,
      cwd: task.cwd,
      cwdName: task.cwdName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      turn: task.turn,
      model: task.model,
      preset: task.preset,
      origin: task.origin,
      isSubagent: task.isSubagent,
      messageCount: task.messageCount,
      toolCount: task.toolCount,
      // 预览也按码点切：96 个码元可能正好切在 emoji 的代理对中间，手机端显示 �。
      lastText: typeof task.lastText === 'string' && task.lastText.length > LIST_PREVIEW_CHARS
        ? `${sliceCodePoints(task.lastText, LIST_PREVIEW_CHARS)}…`
        : task.lastText,
      lastRole: task.lastRole,
      titleSource: task.titleSource,
      childCount: task.children.length,
      // 去掉的只有这三个字段：手机端从未读取，也没有契约测试依赖它们。
      // （parentId / live / blank —— 列表 300 条约省 9%。）
      ...(extra ?? {}),
    };
  }

  snapshot({ filter = 'all', q = '', includeSubagents = false, limit = 300, offset = 0 } = {}) {
    const query = typeof q === 'string' ? q.trim().toLowerCase() : '';
    let rows = [...this.tasks.values()];
    if (!includeSubagents) rows = rows.filter((task) => !task.isSubagent);
    if (filter === 'running') rows = rows.filter((task) => task.status === 'running');
    else if (filter === 'done') rows = rows.filter((task) => task.status === 'done' || task.status === 'idle' || task.status === 'cancelled');
    else if (filter === 'error') rows = rows.filter((task) => task.status === 'error');
    else if (filter === 'cancelled') rows = rows.filter((task) => task.status === 'cancelled');
    else if (filter === 'idle') rows = rows.filter((task) => task.status === 'idle');
    if (query.length > 0) {
      rows = rows.filter((task) => `${task.title}\n${task.cwd}\n${task.lastText}`.toLowerCase().includes(query));
    }
        // 纯时间序：最近的会话排在最前。
    //
    // 以前这里是"先按状态分组、组内再按时间"（running 永远排最前），于是
    // 一个很早就开始、仍在跑的老会话会压在"刚刚结束"的新会话上面 —— 与用户
    // 对"列表按时间倒序"的直觉不符。状态仍然靠每张卡片上的 pill 表达。
    rows.sort((left, right) => {
      const byUpdate = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      if (byUpdate !== 0) return byUpdate;
      const byCreated = (right.createdAt ?? 0) - (left.createdAt ?? 0);
      if (byCreated !== 0) return byCreated;
      // 最后用 id 兜底，保证同一毫秒内的顺序稳定（分页不会抖动）。
      return String(left.id).localeCompare(String(right.id));
    });
    const total = rows.length;
    const numericLimit = Number(limit);
    const pageSize = Number.isFinite(numericLimit) && numericLimit > 0
      ? Math.min(500, Math.floor(numericLimit))
      : 300;
    const numericOffset = Number(offset);
    const from = Number.isFinite(numericOffset) && numericOffset > 0 ? Math.floor(numericOffset) : 0;
    const page = rows.slice(from, from + pageSize).map((task) => this.publicTask(task, {
      awaiting: this.hasPendingQuestion(task),
    }));
    return {
      tasks: page,
      total,
      offset: from,
      limit: pageSize,
      hasMore: from + page.length < total,
      loading: this.loading,
      loadedAt: this.loadedAt,
      error: this.loadError,
    };
  }

  summary() {
    const rows = [...this.tasks.values()].filter((task) => !task.isSubagent);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const counts = { total: rows.length, running: 0, done: 0, error: 0, idle: 0, cancelled: 0, today: 0, subagents: 0 };
    for (const task of rows) {
      if (KNOWN_STATUS.has(task.status)) counts[task.status] += 1;
      if (task.updatedAt >= midnight.getTime()) counts.today += 1;
      counts.subagents += task.children.length;
    }
    counts.loading = this.loading;
    counts.updatedAt = Date.now();
    return counts;
  }

  emitSummary() {
    if (this.summaryTimer !== undefined) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = undefined;
      this.emit('summary', this.summary());
    }, 400);
    this.summaryTimer.unref?.();
  }

  getTask(id) {
    return this.tasks.get(id);
  }

  /**
   * 取这个任务的**完整**转录（已按单条裁剪），带缓存。
   *
   * 分页只在这个数组上切片，**不会为每一页重新解析整份日志**。构建走异步
   * 分片（`buildTranscriptAsync`），每 250 条让出一次事件循环 —— 这样一次
   * "翻到最早"的重活也不会把心跳堵住（心跳一停，手机就判离线）。
   *
   * 三条热路径规则，分别对应"用久了不流畅"的三个根：
   *   1. **增量拼接**：运行中的会话只把上次之后新增的事件并进去（`appendTranscriptEntry`）；
   *   2. **硬上限**：全量重建最多扫 `maxScanEvents` 条 / `maxScanBytes` 字节，超了只给尾部
   *      窗口并把 `truncated` 置真（`scanEventWindow`）；
   *   3. **单飞**：同一个 sessionId 并发构建只跑一次，其余等同一个 promise
   *      （`transcriptFlights`）。
   *
   * @returns {Promise<{messages: Array, degraded: boolean, truncated: boolean, capturedThroughSeq: number|undefined}>}
   */
  async transcript(id, task) {
    const now = Date.now();
    const cached = this.transcripts.get(id);
    // 缓存命中就不必构建。TTL 只决定"多久允许看一眼新数据"——运行中的会话
    // 过期后走的是增量追加，不是整份重建，所以 0.8 s 是便宜的。
    const ttl = task.status === 'running' ? TRANSCRIPT_RUNNING_TTL_MS : TRANSCRIPT_TTL_MS;
    if (cached !== undefined
      && now - cached.at < ttl
      && cached.fileMtime === task.fileMtime
      && cached.status === task.status
      ) {
      // LRU：命中的挪到队尾，淘汰时先丢最久没用的。
      this.transcripts.delete(id);
      this.transcripts.set(id, cached);
      return cached;
    }

    // 单飞：同一 sessionId 的并发构建只跑一次。手机端流式轮询（220 ms 一次）
    // 加上 12 s 的 pollTimer，很容易在同一毫秒里排出两三个请求；没有单飞时
    // 它们会各自整份重建一次，把成本成倍放大。
    const inFlight = this.transcriptFlights.get(id);
    if (inFlight !== undefined) return inFlight;
    let promise;
    promise = this.buildTranscriptEntry(id, task, cached).finally(() => {
      if (this.transcriptFlights.get(id) === promise) this.transcriptFlights.delete(id);
    });
    this.transcriptFlights.set(id, promise);
    return promise;
  }

  /**
   * 一次真正的构建：能增量就增量，否则全量（全量带扫描上限）。
   *
   * 只有"宿主把整份事件流放在内存里"的 live 会话才可能增量 —— 那是流式轮询
   * 唯一的热路径。磁盘 surface / 尾巴降级都读的是另一份数据，语义不同，一律全量。
   */
  async buildTranscriptEntry(id, task, cached) {
    this.transcriptMeter.builds += 1;
    const now = Date.now();
    const liveLog = task.live ? this.services.sessions?.get?.(id)?.log : undefined;
    if (Array.isArray(liveLog) && this.canAppendTranscript(cached, liveLog)) {
      return this.appendTranscriptEntry(id, task, cached, liveLog, now);
    }
    return this.rebuildTranscriptEntry(id, task, now, Array.isArray(liveLog) ? liveLog : undefined);
  }

  /**
   * 还能不能安全地增量拼接。三条都要成立，任一条不成立就退回全量：
   *   - 缓存就是从这个**内存日志**拼出来的，并且带着可续拼的索引
   *     （`source === 'live'` 且 `state` 在）：
   *   - 日志只追加（`log.length >= eventCount`）；
   *   - 上次消费的最后一条**还是同一个事件**（对象同一，或 seq 相同）：日志被
   *     截断 / 重建 / 换过 DSH_HOME，就必须整份重来，绝不能拼出半份转录。
   *
   * 注意：**被上限截断的会话也允许增量**。这是最要紧的一条 —— 长会话（超过
   * `MAX_TRANSCRIPT` 条消息或超过扫描上限）恰恰是"越用越卡"的受害者，如果截断
   * 之后每轮都退回全量，就等于"最长的会话最慢"。代价是一个可接受的偏差：某条
   * `tool/result` 的 `tool/call` 若刚滑出事件窗口、但消息还在保留区，增量会把它
   * 折进那条 call（更正确），而全新全量重建会把它当孤儿消息 —— 两者只在"结果比
   * 调用晚了几千条消息才到"这种不现实的情况下才不同。
   */
  canAppendTranscript(cached, log) {
    if (cached === undefined || cached.source !== 'live' || cached.state === undefined) return false;
    const count = Number(cached.eventCount);
    if (!Number.isFinite(count) || count < 0) return false;
    if (log.length < count) return false;
    const last = count === 0 ? undefined : log[count - 1];
    if (last !== cached.lastEvent) {
      // 宿主可能重建过数组（对象换了）：seq 一致才认，否则当成被截断。
      if (typeof last?.seq !== 'number' || typeof cached.lastEvent?.seq !== 'number') return false;
      if (last.seq !== cached.lastEvent.seq) return false;
    }
    return true;
  }

  /**
   * 增量拼接：只把 `cached.eventCount` 之后的新事件并进已有转录。
   *
   * 规则必须与全量重建**逐字节一致**：
   *   - 用同一个 `normalizeEvent` + `clipMessage`（不复制裁剪逻辑）；
   *   - `tool/result` 折进对应的 `tool/call`，找不到才单独成条（与 `messages.mjs`
   *     的 `applyEvent` 同一条规则）；对应的 call 已滑出保留窗口时丢弃
   *     （全量重建会先折进那条即将被裁掉的 call，结果同样是"看不见"）；
   *   - 条数闸 `MAX_TRANSCRIPT` 与全量重建的 `finalize` 一致：只留最近 5000 条。
   */
  appendTranscriptEntry(id, task, cached, log, now) {
    const fresh = log.slice(cached.eventCount);
    const state = cached.state ?? { toolIndex: new Map(), retained: new Set() };
    const stats = { dropped: 0, clipped: 0 };
    let bytes = 0;
    const appended = [];
    for (const event of fresh) {
      bytes += eventTextBytes(event);
      const normalized = normalizeEvent(event);
      if (normalized === undefined) continue;
      if (normalized.role === 'tool') {
        const callId = normalized.tool?.callId;
        cached.messages.push(normalized);
        appended.push(normalized);
        state.retained.add(normalized);
        if (callId !== undefined && callId !== null && callId !== '') state.toolIndex.set(callId, normalized);
        continue;
      }
      if (normalized.role === 'tool-result') {
        const target = state.toolIndex.get(normalized.tool?.callId);
        if (target === EVICTED_TOOL) continue;
        if (target !== undefined) {
          target.tool.status = normalized.tool.status;
          target.tool.result = normalized.text;
          target.tool.isError = normalized.tool.isError;
          continue;
        }
        cached.messages.push(normalized);
        appended.push(normalized);
        state.retained.add(normalized);
        continue;
      }
      cached.messages.push(normalized);
      appended.push(normalized);
      state.retained.add(normalized);
    }
    for (const message of appended) clipMessage(message, stats);
    this.trimTranscript(cached.messages, state, stats);

    this.transcriptMeter.incrementalBuilds += 1;
    this.transcriptMeter.eventsScanned += fresh.length;
    this.transcriptMeter.bytesScanned += bytes;

    const entry = {
      at: now,
      messages: cached.messages,
      degraded: false,
      // 只有"整条被丢掉"才需要横幅；单条被裁的说明在正文里。
      truncated: cached.truncated === true || stats.dropped > 0,
      capturedThroughSeq: cached.capturedThroughSeq,
      fileMtime: task.fileMtime,
      status: task.status,
      bytes: transcriptBytes(cached.messages),
      source: 'live',
      eventCount: log.length,
      lastEvent: log[log.length - 1],
      state,
    };
    this.storeTranscript(id, entry);
    return entry;
  }

  /** 与 `messages.mjs` 的 `finalize` 同一条规则：只留最近 `MAX_TRANSCRIPT` 条。 */
  trimTranscript(messages, state, stats) {
    if (messages.length <= MAX_TRANSCRIPT) return;
    const overflow = messages.length - MAX_TRANSCRIPT;
    const removed = messages.splice(0, overflow);
    for (const message of removed) {
      state.retained.delete(message);
      const callId = message?.tool?.callId;
      if (callId !== undefined && callId !== null && callId !== ''
        && state.toolIndex.get(callId) === message) {
        state.toolIndex.set(callId, EVICTED_TOOL);
      }
    }
    if (stats !== undefined) stats.dropped += overflow;
  }

  /**
   * 施加全量扫描上限：先按事件数切尾窗，再按估算字节从尾往前收。
   *
   * `capped` 为真表示丢掉了更早的事件 —— 调用方必须把 `truncated` 置真，手机端
   * 会显示"更早的消息已省略"。分页契约（`before`/`after`/`hasMore`/`nextBefore`/
   * `cursorLost`/`limit`）一个字段都不变，只是在更小的窗口上切片。
   */
  scanEventWindow(events) {
    const list = Array.isArray(events) ? events : [];
    const total = list.length;
    if (total === 0) return { events: list, capped: false, bytes: 0 };
    const maxEvents = Number.isFinite(this.maxScanEvents) ? Math.max(1, this.maxScanEvents) : total;
    const first = Math.max(0, total - maxEvents);
    let bytes = 0;
    let from = total;
    while (from > first) {
      const size = eventTextBytes(list[from - 1]);
      if (from < total && bytes + size > this.maxScanBytes) break;
      bytes += size;
      from -= 1;
    }
    if (from === 0) return { events: list, capped: false, bytes };
    return { events: list.slice(from), capped: true, bytes };
  }

  /** 全量重建（带扫描上限），并记下可增量续拼的状态。 */
  async rebuildTranscriptEntry(id, task, now, liveLog) {
    let events = liveLog;
    let capturedThroughSeq;
    let degraded = false;
    let source = events === undefined ? undefined : 'live';
    if (events === undefined) {
      try {
        const surface = await this.services.sessionQuery.readSurface(id);
        events = surface.events;
        capturedThroughSeq = surface.capturedThroughSeq;
        source = 'surface';
      } catch (error) {
        // Strict corpus validation can reject a session the host is still able
        // to run (older logs, hand-made messages). Fall back to the tail reader
        // instead of showing a dead end on the phone.
        if (task.file !== undefined) {
          events = (await readTailEvents(task.file)) ?? [];
          degraded = true;
          source = 'tail';
        } else {
          // 没有映射到日志文件（日志被清理 / 换过 DSH_HOME / cwd 目录名不匹配 /
          // 会话目录是符号链接 —— `Dirent.isDirectory()` 对 symlink 为 false），
          // 而宿主又严格拒绝了这份日志。这时把错误抛到路由层，手机端整页打不开，
          // 连标题、子任务、待答卡片一起消失；降级成"空正文 + degraded"更有用。
          if (this.surfaceFallbackWarned !== true) {
            this.surfaceFallbackWarned = true;
            this.logger.warn('readSurface failed and no log file is mapped; detail degrades to empty', id, error);
          }
          events = [];
          degraded = true;
          source = 'none';
        }
      }
    }

    // 硬上限：分页需要尽量完整的历史，但"完整"不能等于"无上限"。
    const scan = this.scanEventWindow(events);
    const stats = { dropped: 0, clipped: 0 };
    // 窗口已经由 scanEventWindow 施加，这里不再重复截断；总量预算仍然不设，
    // 页面的字节预算在 slicePage 里逐页施加。
    const messages = await buildTranscriptAsync(scan.events, {
      max: MAX_TRANSCRIPT,
      budget: Number.POSITIVE_INFINITY,
      maxScan: Number.POSITIVE_INFINITY,
      stats,
    });

    this.transcriptMeter.fullBuilds += 1;
    this.transcriptMeter.eventsScanned += scan.events.length;
    this.transcriptMeter.bytesScanned += scan.bytes;

    // live 来源要把「拼到哪一条」记下来，下一轮只追加新事件；被上限截断也照样记
    // （见 `canAppendTranscript` 的说明：最长的会话才最需要增量）。
    const appendable = source === 'live' && Array.isArray(liveLog);
    let state;
    if (appendable) {
      state = { toolIndex: new Map(), retained: new Set() };
      for (const message of messages) {
        state.retained.add(message);
        if (message?.role !== 'tool') continue;
        const callId = message.tool?.callId;
        if (callId !== undefined && callId !== null && callId !== '') state.toolIndex.set(callId, message);
      }
    }

    const entry = {
      at: now,
      messages,
      degraded,
      // 只有"整条被丢掉"才需要横幅；单条被裁的说明在正文里。
      // 超上限降级成尾部窗口也算"更早的消息已省略"，所以同样置真。
      truncated: stats.dropped > 0 || scan.capped === true,
      capturedThroughSeq,
      fileMtime: task.fileMtime,
      status: task.status,
      bytes: transcriptBytes(messages),
      source,
      // eventCount 记的是**整份日志**消费到哪（不是窗口长度）：窗口只是这一轮
      // 扫描的起点，下一轮要接着日志末尾往后走。
      eventCount: appendable ? liveLog.length : undefined,
      lastEvent: appendable ? liveLog[liveLog.length - 1] : undefined,
      state,
    };
    this.storeTranscript(id, entry);
    return entry;
  }

  /**
   * 写入转录缓存：条数闸（8）与字节预算（默认 64 MiB）同时生效，超了都按
   * 最久未用淘汰（Map 的插入顺序就是 LRU 顺序，命中时会把条目挪到队尾）。
   *
   * 为什么必须有字节闸：单条消息上限 6000 字、单份转录最多 5000 条，光靠
   * "8 条" 上限，理论常驻可以到 240 MB —— 那已经够把宿主拖垮了。
   * 单条一次性超过整个预算时仍然保留它（否则大会话永远建不出缓存），
   * 所以预算的判断带上 `size > 1`。
   */
  storeTranscript(id, entry) {
    const existing = this.transcripts.get(id);
    if (existing !== undefined) this.transcriptBytes -= existing.bytes ?? 0;
    this.transcripts.delete(id);
    this.transcripts.set(id, entry);
    this.transcriptBytes += entry.bytes ?? 0;
    while (this.transcripts.size > TRANSCRIPT_CACHE_MAX
      || (this.transcriptBytes > this.transcriptCacheBytes && this.transcripts.size > 1)) {
      const oldestKey = this.transcripts.keys().next().value;
      const oldest = this.transcripts.get(oldestKey);
      this.transcripts.delete(oldestKey);
      this.transcriptBytes -= oldest?.bytes ?? 0;
    }
    if (this.transcriptBytes < 0) this.transcriptBytes = 0;
  }

  /**
   * 会话详情（**分页**）。
   *
   * - 不带 `before`：返回尾部一页（默认 40 条），并保证至少带出最近
   *   `MIN_USER_MESSAGES` 条用户输入；同时给出 `hasMore` / `nextBefore`。
   * - 带 `before=<某条消息 id>`：返回它**之前**的一页，供手机往上翻。
   *
   * 每一页都受 `PAGE_CHARS` 字符预算约束，所以无论会话多长，单次响应都很小。
   *
   * `wsTicket`（可选）：**首屏那一页**顺带下发的实时通道票，由 `lib/server.mjs`
   * 用 `core.createWsTicket(device)` 签发后传进来 —— 手机端因此不必为"进入实时"
   * 再单独跑一次 `POST /api/v1/ws-ticket`（少一次往返）。可以传 `{ticket, expiresAt}`，
   * 也可以传一个 thunk（服务端用它做到"真的组装出这一页之后才签票"）。
   * 它是增量字段：不传时返回对象与以前逐字段相同；增量模式（`after`）**绝不带它**，
   * 因为增量应答的契约只有 `messages/total/reset/hasMoreAfter` 四项。
   */
  async detail(id, { before = '', after = '', limit = 0, wsTicket = null } = {}) {
    const task = this.tasks.get(id);
    if (task === undefined) throw codedError('not_found', 'task not found');
    const entry = await this.transcript(id, task);
    // `after` 与 `before` 互斥：前者追新（流式），后者翻旧（历史）。
    const page = typeof after === 'string' && after.length > 0
      ? sliceAfter(entry.messages, { after, limit })
      : slicePage(entry.messages, { before, limit });
    const children = task.children
      .map((childId) => this.tasks.get(childId))
      .filter((child) => child !== undefined)
      .map((child) => this.publicTask(child));
    // 票只在首屏那一页下发；增量模式的应答契约里没有这个字段。
    const ticketPayload = typeof after === 'string' && after.length > 0
      ? null
      : wsTicketPayload(typeof wsTicket === 'function' ? wsTicket() : wsTicket);
    return {
      task: this.publicTask(task),
      messages: page.messages,
      total: page.total,
      offset: page.offset,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore ?? '',
      // 游标失效（缓存重建/会话被清理）：让手机端把列表重置成这一页。
      cursorLost: page.cursorLost === true,
      // 仅 after 模式有意义：游标找不到时要求整页重载，别把两段拼在一起。
      reset: page.reset === true,
      hasMoreAfter: page.hasMore === true,
      capturedThroughSeq: entry.capturedThroughSeq ?? null,
      children,
      // 形状稳定：永远有这一项（无待答 / 老版本宿主时是空数组），手机端不用猜。
      pendingQuestions: this.pendingQuestions(id),
      degraded: entry.degraded === true,
      truncated: entry.truncated === true,
      // 一次性实时票：只在**首屏**（无游标）那一页带，增量模式一律不带。
      ...(ticketPayload === null ? {} : { wsTicket: ticketPayload }),
    };
  }

  /** Map a cold task to a live agent before sending a follow-up. */
  async ensureAgent(id, { createIfMissing = false } = {}) {
    const agents = this.services.agents;
    if (agents === undefined) throw codedError('no_agent', 'agent service unavailable');
    const live = agents.get(id);
    if (live !== undefined) return live;
    if (!createIfMissing) throw codedError('not_running', '任务当前未运行，无法发送消息');
    const pending = this.agentLocks.get(id);
    if (pending !== undefined) return pending;
    const promise = this.resumeAgent(id, agents).finally(() => {
      if (this.agentLocks.get(id) === promise) this.agentLocks.delete(id);
    });
    this.agentLocks.set(id, promise);
    return promise;
  }

  async resumeAgent(id, agents) {
    const task = this.tasks.get(id);
    if (task === undefined) throw codedError('not_found', 'task not found');
    if (task.isSubagent) throw codedError('subagent_immutable', '子代理任务不能直接续聊');
    const agentOptions = this.defaultAgentOptions();
    const setup = await this.presetSetup(task.preset);
    const handle = await agents.resume({
      resumeSessionId: id,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(setup === undefined ? {} : { setup }),
    });
    return handle.agent;
  }

  defaultAgentOptions() {
    try {
      const service = this.services.agentDefaultModel;
      const selection = service?.currentSelection?.() ?? service?.current?.();
      if (selection !== null && typeof selection === 'object'
        && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return selection;
      }
    } catch (error) {
      this.logger.warn('default model selection failed', error);
    }
    return undefined;
  }

  async presetSetup(presetId) {
    const presets = this.services.agentPresets;
    if (presets === undefined) return undefined;
    let wanted = presetId;
    try {
      if (wanted === undefined) {
        const rows = await presets.list();
        if (rows.length === 0) return undefined;
        wanted = presets.defaultId ?? rows[0].id;
      }
      const resolved = await presets.resolve(wanted);
      if (resolved?.broken !== undefined) {
        const error = new Error(`agent preset "${wanted}" is unavailable: ${String(resolved.broken)}`);
        error.code = 'preset_broken';
        throw error;
      }
      return async (agentCtx) => { await presets.mount(agentCtx, resolved.id); };
    } catch (error) {
      if (error?.code === 'preset_broken') throw error;
      this.logger.warn('preset resolution failed', error);
      return undefined;
    }
  }

  /**
   * Allowed working directories.
   *
   * `config.allowedRoots` is authoritative when set. Otherwise the roots the
   * user actually opened in the DSH UI (workspaceRegistry) plus the plugin data
   * directory are allowed. When that derived set is empty nothing is allowed —
   * an empty list must never mean "anywhere".
   */
  computeAllowedRoots() {
    const explicit = Array.isArray(this.config.allowedRoots)
      ? this.config.allowedRoots.filter((root) => typeof root === 'string' && root.trim().length > 0)
      : [];
    if (explicit.length > 0) {
      return { mode: 'config', roots: [...new Set(explicit.map((root) => path.resolve(root.trim())))] };
    }
    const derived = [];
    const registry = this.services.workspaceRegistry;
    if (registry !== undefined) {
      try {
        const rows = registry.list();
        for (const row of Array.isArray(rows) ? rows : []) {
          if (typeof row?.path === 'string' && row.path.length > 0) derived.push(path.resolve(row.path));
        }
      } catch (error) {
        this.logger.warn('workspace list failed while resolving allowed roots', error);
      }
    }
    // The plugin's own data dir is deliberately *not* a derived root: a task
    // workdir inside the session store is never what the user meant, and
    // including it would make the fail-closed "no roots" mode unreachable.
    const roots = [...new Set(derived)];
    if (roots.length === 0) return { mode: 'closed', roots: [] };
    return { mode: 'derived', roots };
  }

  /** Safe-for-status summary: never leak absolute paths to the LAN. */
  allowedRootsStatus() {
    const roots = this.computeAllowedRoots();
    return { mode: roots.mode, count: roots.roots.length };
  }

  async resolveWorkdir(cwd) {
    const explicit = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : '';
    const roots = this.computeAllowedRoots();
    if (roots.roots.length === 0) {
      throw codedError('cwd_forbidden', '尚未允许任何工作目录：请先在 DSH 中打开一个工作区，或在插件配置里填写 allowedRoots');
    }
    const wanted = explicit.length > 0 ? explicit : roots.roots[0];
    if (wanted.includes('\0')) throw codedError('bad_cwd', '工作目录不合法');
    if (!path.isAbsolute(wanted)) throw codedError('bad_cwd', '工作目录必须是绝对路径');
    if (/^\\\\/u.test(wanted) || /^\/\//u.test(wanted)) {
      throw codedError('bad_cwd', '不支持网络路径（UNC）作为工作目录');
    }
    let real;
    try {
      real = await realpath(wanted);
    } catch {
      throw codedError('bad_cwd', `工作目录不存在：${wanted}`);
    }
    let info;
    try {
      info = await stat(real);
    } catch {
      throw codedError('bad_cwd', `工作目录不可访问：${wanted}`);
    }
    if (!info.isDirectory()) throw codedError('bad_cwd', `不是目录：${wanted}`);
    for (const root of roots.roots) {
      let realRoot;
      try {
        realRoot = await realpath(root);
      } catch {
        realRoot = path.resolve(root);
      }
      if (isInside(realRoot, real)) return real;
    }
    throw codedError('cwd_forbidden', '该目录不在允许的工作区范围内');
  }

  reserveClientId(key) {
    if (!this.byClientId.has(key)) {
      this.trimClientIds(MAX_CLIENT_IDS - 1);
      if (this.byClientId.size >= MAX_CLIENT_IDS) return false;
    }
    this.byClientId.set(key, PENDING);
    return true;
  }

  rememberClientId(key, result) {
    this.byClientId.delete(key);
    this.byClientId.set(key, result);
    this.trimClientIds();
  }

  trimClientIds(limit = MAX_CLIENT_IDS) {
    while (this.byClientId.size > limit) {
      let removed = false;
      for (const [key, value] of this.byClientId) {
        if (value === PENDING) continue;
        this.byClientId.delete(key);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  async createTask({ prompt, cwd, preset, clientTaskId, source = 'mobile' }) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (text.length === 0) throw codedError('empty_prompt', '任务内容不能为空');
    if (text.length > 20_000) throw codedError('prompt_too_long', '任务内容过长（上限 20000 字符）');
    const key = typeof clientTaskId === 'string' && clientTaskId.length > 0 ? clientTaskId.slice(0, 128) : '';
    const hit = key ? this.byClientId.get(key) : undefined;
    if (key.length > 0) {
      if (hit === PENDING) throw codedError('create_in_flight', '同一请求正在创建中，请稍候再试');
      // 命中即复用：**不再**要求 `this.tasks.has(hit)`。索引满（或该行已被清理）时
      // 命中拿不到真实任务行，但幂等键必须照样生效 —— 否则同一次点击（失败重试 /
      // 成功后重放）会建出第二份会话，手机上出现两条一模一样的任务。
      if (typeof hit === 'string') {
        const existing = this.tasks.get(hit);
        return {
          task: existing === undefined ? this.syntheticTask(hit) : this.publicTask(existing),
          reused: true,
        };
      }
      if (!this.reserveClientId(key)) throw codedError('unavailable', '正在创建的任务过多，请稍后再试');
    }
    try {
      if (hit?.message) {
        // 上一次 create 已经把会话建好、只是 followup 失败：只重投那条消息，
        // 绝不再建第二份会话。`ensureAgent` 会优先拿活 agent、否则按 sessionId
        // 续建；连索引里都没有那一行（索引满）时它抛 not_found —— 宁可报错，
        // 也不允许一次点击变成两份会话。
        const agent = await this.ensureAgent(hit.id, { createIfMissing: true });
        return await this.sendCreatedTask(agent, this.tasks.get(hit.id), hit.id, hit.message, {
          key, reused: true, cwd: hit.cwd ?? '',
        });
      }
      const workdir = await this.resolveWorkdir(cwd);
      const presetId = typeof preset === 'string' && preset.length > 0 ? preset : undefined;
      const agentOptions = this.defaultAgentOptions();
      const setup = await this.presetSetup(presetId);
      const sessionId = `session-${randomUUID()}`;
      const agents = this.services.agents;
      if (agents === undefined) throw codedError('no_agent', 'agent service unavailable');
      // The agent factory is registered by agent-loop's constructor; the plugin
      // can load first, so retry briefly instead of failing the first tap.
      let handle;
      let lastError;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          handle = await agents.create({
            sessionId,
            meta: { cwd: workdir, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
            ...(agentOptions === undefined ? {} : { agentOptions }),
            ...(setup === undefined ? {} : { setup }),
          });
          break;
        } catch (error) {
          lastError = error;
          if (!String(error?.message ?? '').includes('no agent factory registered')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (handle === undefined) throw lastError ?? new Error('agent factory unavailable');
      const task = this.tasks.get(sessionId) ?? this.upsertRow({
        header: handle.agent.header ?? { id: handle.agent.id ?? sessionId, cwd: workdir, createdAt: Date.now() },
        live: true,
        persisted: true,
      });
      if (task !== undefined) {
        task.title = oneLine(text, 42);
        task.titleSource = 'derived';
        task.blank = false;
        task.status = 'running';
        task.live = true;
        task.cwd = workdir;
        task.cwdName = cwdName(workdir);
        task.preset = presetId;
        task.origin = 'user';
        task.isSubagent = false;
        task.lastText = oneLine(text, 220);
        task.lastRole = 'user';
        task.updatedAt = Date.now();
      }
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', client: source },
      };
      const id = task?.id ?? handle.agent?.header?.id ?? handle.agent?.id ?? sessionId;
      return await this.sendCreatedTask(handle.agent, task, id, message, { key, cwd: workdir });
    } catch (error) {
      if (key && this.byClientId.get(key) === PENDING) {
        if (hit?.message) this.rememberClientId(key, hit);
        else this.byClientId.delete(key);
      }
      throw error;
    }
  }

  async sendCreatedTask(agent, task, id, message, {
    key, reused = false, cwd = task?.cwd ?? '', preset = task?.preset,
  } = {}) {
    if (task && reused) {
      task.status = 'running';
      task.statusReason = '';
    }
    try {
      await agent.followup(message);
    } catch (error) {
      if (task) {
        task.status = 'error';
        task.statusReason = oneLine(error?.message ?? '发送失败', 200);
        this.scheduleUpdate(task);
      }
      // 这一行**必须**在 `if (task)` 之外：索引满（5000 条）时 upsertRow 拿不到行，
      // `task` 是 undefined，但「会话已建好、只差重投」这个事实仍然要记住，否则
      // 手机的失败重试会再 create 一份会话（一次点击两条任务）。
      if (key) this.rememberClientId(key, { id, message, cwd });
      throw error;
    }
    if (key) this.rememberClientId(key, id);
    if (task) this.scheduleUpdate(task);
    return {
      task: task
        ? this.publicTask(task)
        : this.syntheticTask(id, { cwd, preset, title: oneLine(message.content[0].text, 42) }),
      reused,
    };
  }

  async promptTask(id, prompt, { source = 'mobile' } = {}) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (text.length === 0) throw codedError('empty_prompt', '消息不能为空');
    if (text.length > 20_000) throw codedError('prompt_too_long', '消息过长（上限 20000 字符）');
    const task = this.tasks.get(id);
    if (task === undefined) throw codedError('not_found', 'task not found');
    const agent = await this.ensureAgent(id, { createIfMissing: true });
    await agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', client: source },
    });
    task.status = 'running';
    task.lastText = oneLine(text, 220);
    task.lastRole = 'user';
    task.updatedAt = Date.now();
    this.scheduleUpdate(task);
    return this.publicTask(task);
  }

  async cancelTask(id) {
    const agents = this.services.agents;
    const agent = agents?.get?.(id);
    if (agent === undefined) throw codedError('not_running', '任务当前未运行');
    if (typeof agent.cancel !== 'function') throw codedError('unsupported', '宿主不支持中断这个任务');
    try {
      await agent.cancel({ kind: 'user' });
    } catch (error) {
      this.logger.warn('agent cancel failed', id, error);
      // 语义收紧（中断失败不再假装 cancelled）之后，宿主那句原始报错就是唯一的
      // 排障线索：别只留一行 warn，挂到 cause 上一起交给上层日志/诊断接口。
      const failure = codedError('cancel_failed', '宿主未能中断任务');
      failure.cause = error;
      failure.taskId = id;
      throw failure;
    }
    const task = this.tasks.get(id);
    if (task !== undefined) {
      task.status = 'cancelled';
      task.statusReason = '已中断';
      this.scheduleUpdate(task);
    }
    return task === undefined ? { id, status: 'cancelled' } : this.publicTask(task);
  }

  async workspaces() {
    const registry = this.services.workspaceRegistry;
    if (registry === undefined) return [];
    const rows = registry.list();
    const seen = new Set();
    const result = [];
    for (const workspace of rows) {
      const workspacePath = workspace?.path;
      if (typeof workspacePath !== 'string') continue;
      const key = pathKey(workspacePath);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: String(workspace.id ?? workspacePath),
        path: workspacePath,
        title: workspace.title ?? cwdName(workspacePath),
        available: existsSync(workspacePath),
      });
    }
    // Recent session cwds that are not registered workspaces are still useful.
    for (const task of this.tasks.values()) {
      if (task.cwd.length === 0 || seen.has(pathKey(task.cwd)) || task.isSubagent) continue;
      if (result.length >= 30) break;
      seen.add(pathKey(task.cwd));
      result.push({
        id: task.cwd,
        path: task.cwd,
        title: task.cwdName,
        available: existsSync(task.cwd),
        recent: true,
      });
    }
    return result;
  }

  async presets() {
    const registry = this.services.agentPresets;
    if (registry === undefined) return { presets: [], defaultId: undefined };
    try {
      const rows = await registry.list();
      return {
        defaultId: registry.defaultId,
        presets: rows.map((row) => ({
          id: row.id,
          name: row.name ?? row.id,
          description: row.description ?? '',
          isDefault: row.id === registry.defaultId,
        })),
      };
    } catch (error) {
      this.logger.warn('preset list failed', error);
      return { presets: [], defaultId: undefined };
    }
  }

  dispose() {
    for (const timer of this.pendingUpdates.values()) clearTimeout(timer);
    this.pendingUpdates.clear();
    if (this.summaryTimer !== undefined) clearTimeout(this.summaryTimer);
    this.summaryTimer = undefined;
    this.transcripts.clear();
    this.transcriptBytes = 0;
    this.agentLocks.clear();
  }
}
