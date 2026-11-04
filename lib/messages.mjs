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
export function buildTranscript(events, { max = 400, includeInjected = false } = {}) {
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
  if (messages.length > max) return messages.slice(-max);
  return messages;
}
