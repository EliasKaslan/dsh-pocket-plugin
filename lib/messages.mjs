/**
 * Turn a DSH event stream into a small, UI-friendly transcript.
 *
 * The plugin never invents content: reasoning, tool arguments and tool results
 * are only exposed when the underlying event carries them. Tool arguments are
 * clipped hard because a single shell command can be enormous and the phone
 * only needs enough to recognise the call.
 */
import { oneLine, truncate } from './util.mjs';

const INJECTED_SOURCES = new Set([
  'plugin', 'skill-catalog', 'runtime-context', 'time-context', 'goal-context',
  'todo-context', 'system', 'compaction',
]);
const INJECTED_RE = /(?:context|plugin|skill|system|compaction|catalog)/iu;
// Some hot paths hand us a surface where the original `source` was already
// dropped. These prefixes are written only by the runtime itself, so they are a
// safe second line of defence against leaking prompt scaffolding to the phone.
const INJECTED_TEXT_RE = /^(?:Time sampled while preparing\b|Current runtime context\b|A skill is a reusable set\b|<system-reminder>|Tokens prefixed with @|You are an AI agent powered by DeepSeek Harness\b|# AGENTS\b|Current working directory:)/u;

/** Upper bound on events normalised per request, keeps a 50k-turn log cheap. */
const MAX_SCAN_EVENTS = 2000;

/**
 * 单条消息正文的字符上限。
 *
 * 一条 shell 命令的输出动辄几百 KB，一次大文件的读取更是几 MB；只要有一条
 * 这样的消息，整份详情就能顶到几十 MB。而中继的发帧预算只有 64 片 × 64 KiB
 * （见 `lib/cloud.mjs` 的 `MAX_FRAME` / `MAX_FRAME_TOTAL`），超过就**根本发不出去**，
 * 手机端只能等到 RPC 超时、界面显示"连接中断"。
 *
 * 手机上本来也读不完那么多内容，所以按字符裁：保留开头（认得是哪条命令），
 * 追加一句明确的截断说明，其余请用户回电脑上看。
 */
const MAX_MESSAGE_CHARS = 6_000;

/** 整份详情的正文预算（字符）。超出时丢最旧的、保留最新的。 */
const MAX_TIMELINE_CHARS = 120_000;

const USAGE_KEYS = [
  'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'currency',
];

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n').trim();
}

export function contentReasoning(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part?.type === 'reasoning' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n').trim();
}

export function sourceKind(source) {
  if (source === null || typeof source !== 'object') return undefined;
  return typeof source.kind === 'string' ? source.kind : undefined;
}

export function isHumanPrompt(event) {
  if (event?.type !== 'user/message') return false;
  const text = contentText(event?.data?.content);
  if (text.length > 0 && INJECTED_TEXT_RE.test(text.slice(0, 400))) return false;
  const kind = sourceKind(event?.data?.source);
  if (kind === undefined) return true;
  if (INJECTED_SOURCES.has(kind) || INJECTED_RE.test(kind)) return false;
  return kind === 'user' || kind === 'user-question-reply' || kind === 'delegated' || kind === 'subagent';
}

/** Keep only scalar usage counters; the host may attach arbitrary objects. */
export function safeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined;
  const result = {};
  let kept = 0;
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
      kept += 1;
    } else if (typeof value === 'string' && value.length <= 8) {
      result[key] = value;
      kept += 1;
    }
    if (kept >= 8) break;
  }
  return kept === 0 ? undefined : result;
}

function toolArguments(raw) {
  if (typeof raw !== 'string') {
    try { return oneLine(JSON.stringify(raw ?? ''), 180); } catch { return ''; }
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      // Prefer the operation/path/command fields a human recognizes.
      for (const key of ['description', 'command', 'path', 'file_path', 'query', 'pattern', 'url']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim().length > 0) {
          return oneLine(parsed[key], 180);
        }
      }
      const keys = Object.keys(parsed).slice(0, 4);
      return keys.length > 0 ? oneLine(keys.join(', '), 180) : '';
    }
  } catch { /* not JSON */ }
  return oneLine(raw, 180);
}

export function normalizeEvent(event, context = {}) {
  if (event === null || typeof event !== 'object') return undefined;
  const at = typeof event.time === 'number' ? event.time : context.now ?? Date.now();
  const turn = event?.data?.turn;
  switch (event.type) {
    case 'user/message': {
      if (!isHumanPrompt(event) && context.includeInjected !== true) return undefined;
      const text = contentText(event?.data?.content);
      if (text.length === 0) return undefined;
      return {
        id: event?.data?.id ?? `u-${event.seq ?? at}`,
        role: 'user',
        text,
        at,
        turn,
        seq: event.seq,
      };
    }
    case 'assistant/message': {
      const message = event?.data?.message;
      const text = contentText(message?.content);
      const reasoning = contentReasoning(message?.content);
      if (text.length === 0 && reasoning.length === 0) return undefined;
      const source = message?.source;
      return {
        id: message?.id ?? `a-${event.seq ?? at}`,
        role: 'assistant',
        text,
        reasoning: reasoning.length > 0 ? truncate(reasoning, 6000) : undefined,
        at,
        turn,
        step: event?.data?.step,
        seq: event.seq,
        model: source !== null && typeof source === 'object' && typeof source.model === 'string'
          ? { provider: source.provider, model: source.model }
          : undefined,
        usage: safeUsage(event?.data?.usage),
      };
    }
    case 'tool/call': {
      const name = typeof event?.data?.name === 'string' ? event.data.name : 'tool';
      return {
        id: `t-${event?.data?.callId ?? event.seq ?? at}`,
        role: 'tool',
        text: '',
        at,
        turn,
        step: event?.data?.step,
        seq: event.seq,
        tool: {
          callId: event?.data?.callId,
          name,
          args: toolArguments(event?.data?.arguments),
          status: 'running',
        },
      };
    }
    case 'tool/result': {
      const callId = event?.data?.message?.toolCallId ?? event?.data?.toolCallId;
      const message = event?.data?.message;
      const text = truncate(contentText(message?.content), 1200);
      return {
        id: `tr-${callId ?? event.seq ?? at}`,
        role: 'tool-result',
        text,
        at,
        turn,
        seq: event.seq,
        tool: {
          callId,
          name: typeof event?.data?.name === 'string' ? event.data.name : undefined,
          status: message?.isError === true ? 'error' : 'done',
          isError: message?.isError === true,
        },
      };
    }
    case 'turn/end': {
      const reason = event?.data?.reason;
      const kind = reason !== null && typeof reason === 'object' ? reason.kind : 'unknown';
      return {
        id: `turn-${event.seq ?? at}`,
        role: 'divider',
        kind: 'turn-end',
        text: '',
        status: kind === 'completed' ? 'done' : kind === 'aborted' || kind === 'interrupted' ? 'stopped' : 'error',
        reason: reasonText(reason),
        at,
        turn,
        seq: event.seq,
      };
    }
    case 'turn/start':
      return { id: `turn-${event.seq ?? at}`, role: 'divider', kind: 'turn-start', text: '', at, turn, seq: event.seq };
    case 'session/error':
    case 'error': {
      const message = event?.data?.error?.message ?? event?.data?.message ?? '任务执行出错';
      return { id: `e-${event.seq ?? at}`, role: 'system', kind: 'error', text: String(message), at, turn, seq: event.seq };
    }
    default:
      return undefined;
  }
}

export function reasonText(reason) {
  if (reason === null || typeof reason !== 'object') return '状态未知';
  const map = {
    completed: '已完成',
    aborted: '已中断',
    interrupted: '已中断',
    error: '执行出错',
    'max-tokens': '达到 token 上限',
    blocked: '被策略拦下',
    forked: '已分叉',
    unknown: '状态未知',
  };
  const base = map[reason.kind] ?? String(reason.kind ?? '状态未知');
  const detail = reason.error?.message ?? reason.reason?.message;
  return typeof detail === 'string' && detail.length > 0 ? `${base}：${oneLine(detail, 160)}` : base;
}

/**
 * Build a transcript from an event list. Tool results are folded into the
 * matching call; consecutive assistant steps stay distinct so the UI can show
 * "思考 → 调用 → 结果" in order.
 *
 * Only the last MAX_SCAN_EVENTS events are normalised: a very long session must
 * not turn one GET into a multi-megabyte string-building exercise.
 */
/**
 * 把单条消息的正文裁到 `MAX_MESSAGE_CHARS`，并留下让人看得懂的说明。
 * 工具结果挂在 `tool.result` 上，单独裁一次。
 */
function clipMessage(message, stats) {
  const cut = (value) => {
    if (typeof value !== 'string' || value.length <= MAX_MESSAGE_CHARS) return value;
    const rest = value.length - MAX_MESSAGE_CHARS;
    if (stats !== undefined) stats.clipped += 1;
    return `${value.slice(0, MAX_MESSAGE_CHARS)}\n\n…（内容过长，已截断 ${rest.toLocaleString('en-US')} 个字符；完整内容请在电脑上查看）`;
  };
  message.text = cut(message.text);
  if (message.tool !== null && typeof message.tool === 'object') {
    message.tool.result = cut(message.tool.result);
  }
  return message;
}

/** 一条消息占的正文体量：气泡文本 + 工具结果。 */
function messageChars(message) {
  const text = typeof message?.text === 'string' ? message.text.length : 0;
  const result = typeof message?.tool?.result === 'string' ? message.tool.result.length : 0;
  return text + result;
}

/**
 * Turn a DSH event stream into a small, UI-friendly transcript.
 *
 * 四道闸按顺序生效，每一道都为了"这一次 GET 不会变成几 MB 的字符串"：
 *   1. 只扫最后 `MAX_SCAN_EVENTS` 个事件；
 *   2. 单条消息正文裁到 `MAX_MESSAGE_CHARS`；
 *   3. 条数裁到 `max`；
 *   4. 总量裁到 `budget`（丢最旧、留最新）。
 *
 * 第 3/4 道裁掉了东西时通过 `stats.dropped` 报给调用方，由它把 `truncated`
 * 透到详情里 —— 手机端看到 `truncated` 会显示「更早的消息已省略。」。
 *
 * @param {Array} events 事件流
 * @param {{max?: number, includeInjected?: boolean, budget?: number, stats?: {dropped: number, clipped: number}}} [options]
 * @returns {Array} UI 用的消息数组
 */
export function buildTranscript(events, {
  max = 400, includeInjected = false, budget = MAX_TIMELINE_CHARS, stats,
} = {}) {
  if (stats !== undefined) {
    if (!Number.isFinite(stats.dropped)) stats.dropped = 0;
    if (!Number.isFinite(stats.clipped)) stats.clipped = 0;
  }
  const list = Array.isArray(events) ? events : [];
  const scan = list.length > MAX_SCAN_EVENTS ? list.slice(-MAX_SCAN_EVENTS) : list;
  const messages = [];
  const toolIndex = new Map();
  for (const event of scan) {
    const normalized = normalizeEvent(event, { includeInjected });
    if (normalized === undefined) continue;
    if (normalized.role === 'tool') {
      toolIndex.set(normalized.tool.callId, normalized);
      messages.push(normalized);
      continue;
    }
    if (normalized.role === 'tool-result') {
      const target = toolIndex.get(normalized.tool.callId);
      if (target !== undefined) {
        target.tool.status = normalized.tool.status;
        target.tool.result = normalized.text;
        target.tool.isError = normalized.tool.isError;
        continue;
      }
      messages.push(normalized);
      continue;
    }
    messages.push(normalized);
  }

  for (const message of messages) clipMessage(message, stats);

  let trimmed = messages;
  if (messages.length > max) {
    trimmed = messages.slice(-max);
    if (stats !== undefined) stats.dropped += messages.length - trimmed.length;
  }

  // 总量预算：从最新往回累加，累到超预算就停，前面的整条丢弃。
  let total = 0;
  let start = trimmed.length;
  while (start > 0) {
    const size = messageChars(trimmed[start - 1]);
    if (total + size > budget) break;
    total += size;
    start -= 1;
  }
  if (start > 0) {
    if (stats !== undefined) stats.dropped += start;
    return trimmed.slice(start);
  }
  return trimmed;
}
