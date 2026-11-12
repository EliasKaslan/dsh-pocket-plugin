/**
 * Pending `ask_user_question` state, normalized for the phone.
 *
 * Two sources, one shape:
 *   - the host projection (`session.projections.faceOf('userQuestions')`), which
 *     is authoritative while the host exposes it;
 *   - the `session/event` stream this plugin already subscribes to, which is the
 *     only source when the projection cannot be read (and the *only* source for
 *     blocking questions: the legacy tool declares no timeout, so a blocking
 *     call never enters the projection at all).
 *
 * Everything here is pure so it can be unit-tested without a host. The host's
 * blocking tool uses snake_case in its arguments (`multi_select`); the phone
 * contract is camelCase, so the normalization lives here and nowhere else.
 */
import { contentText } from './messages.mjs';

/** The only tool that asks the human and can be answered from the phone. */
export const QUESTION_TOOL_NAME = 'ask_user_question';

/** Unknown state: neither the projection nor a settled tool result told us. */
export const QUESTION_STATE_UNKNOWN = 'unknown';

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize one question item.
 *
 * @param {unknown} raw
 * @returns {{id: string, question: string, detail?: string, header?: string,
 *   options?: Array<{label: string, description?: string}>, multiSelect?: boolean, intent?: unknown} | undefined}
 */
export function normalizeQuestion(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const id = trimmed(raw.id);
  const question = trimmed(raw.question);
  if (id.length === 0 || question.length === 0) return undefined;
  const item = { id, question };
  const detail = trimmed(raw.detail);
  if (detail.length > 0) item.detail = detail;
  const header = trimmed(raw.header);
  if (header.length > 0) item.header = header;
  const options = [];
  for (const option of Array.isArray(raw.options) ? raw.options : []) {
    const label = trimmed(option?.label);
    if (label.length === 0) continue;
    const description = trimmed(option?.description);
    options.push(description.length > 0 ? { label, description } : { label });
  }
  if (options.length > 0) item.options = options;
  // 宿主阻塞式工具发的是 `multi_select`，投影里是 `multiSelect`：两种都要认。
  if (raw.multiSelect === true || raw.multi_select === true) item.multiSelect = true;
  if (raw.intent !== undefined && raw.intent !== null) item.intent = raw.intent;
  return item;
}

/**
 * Normalize a question list from a tool call, a projection row, or a test.
 *
 * @param {unknown} raw array, single item, or `{ questions: [...] }`
 * @returns {Array<ReturnType<typeof normalizeQuestion>>}
 */
export function normalizeQuestions(raw) {
  const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.questions) ? raw.questions : [raw]);
  const out = [];
  for (const item of source) {
    const question = normalizeQuestion(item);
    if (question !== undefined) out.push(question);
  }
  return out;
}

/**
 * Normalize one pending row (projection or event-derived) into the phone shape.
 *
 * `state` is always present: the host only knows `open` / `continued`, and the
 * event-derived path reports `unknown` until it can prove otherwise. A stable
 * key set matters more than an exact enum here — the phone must never have to
 * guess whether a card is answerable.
 *
 * @param {unknown} raw
 * @returns {{callId: string, questions: Array, state: string} | undefined}
 */
export function normalizePending(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const callId = trimmed(raw.callId);
  if (callId.length === 0) return undefined;
  const questions = normalizeQuestions(raw.questions);
  if (questions.length === 0) return undefined;
  const state = raw.state === 'open' || raw.state === 'continued' ? raw.state : QUESTION_STATE_UNKNOWN;
  return { callId, questions, state };
}

/**
 * `tool/call` → pending entry. Anything else returns `undefined`.
 *
 * @param {unknown} event a raw `session/event`
 * @returns {{callId: string, questions: Array, state: string} | undefined}
 */
export function questionsFromCall(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'tool/call') return undefined;
  if (event?.data?.name !== QUESTION_TOOL_NAME) return undefined;
  const callId = trimmed(event?.data?.callId);
  if (callId.length === 0) return undefined;
  let args = event?.data?.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  const questions = normalizeQuestions(args?.questions ?? args);
  if (questions.length === 0) return undefined;
  return { callId, questions, state: QUESTION_STATE_UNKNOWN };
}

/** `tool/result` → the call it settles. */
export function resultCallId(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'tool/result') return undefined;
  const callId = trimmed(event?.data?.message?.toolCallId ?? event?.data?.toolCallId);
  return callId.length === 0 ? undefined : callId;
}

/**
 * A timed question settles its tool call **before** the human answers: the tool
 * returns `{ pending: true, callId }` once the foreground window closes, and the
 * call stays answerable (host projection state `continued`) until the reply
 * lands. Removing the row on that result would hide a perfectly answerable
 * question, so this predicate keeps it and flips it to `continued`.
 */
export function resultIsPending(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'tool/result') return false;
  const text = contentText(event?.data?.message?.content);
  if (text.length === 0) return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && parsed.pending === true) return true;
  } catch { /* not JSON: fall through to the tolerant scan */ }
  return /"?pending"?\s*:\s*true/u.test(text);
}

/**
 * `user/message` whose source names the answered call.
 *
 * The host writes that reply as a user message with `source.kind ===
 * 'user-question-reply'`; it is also the record that closes the question.
 */
export function replyCallId(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'user/message') return undefined;
  const source = event?.data?.source;
  if (source === null || typeof source !== 'object' || source.kind !== 'user-question-reply') return undefined;
  const callId = trimmed(source.callId);
  return callId.length === 0 ? undefined : callId;
}

/**
 * Build the phone-facing pending list.
 *
 * @param {object} options
 * @param {Array|undefined} options.projected projection rows, or `undefined` when no projection is readable
 * @param {Array} options.tracked event-derived rows
 * @returns {Array<{callId: string, questions: Array, state: string, answerable: boolean, reason?: string}>}
 */
export function mergePending({ projected, tracked }) {
  const seen = new Set();
  const rows = [];
  for (const raw of Array.isArray(projected) ? projected : []) {
    const row = normalizePending(raw);
    if (row === undefined || seen.has(row.callId)) continue;
    seen.add(row.callId);
    // 只有 continued 能被 `userQuestions.answer()` 收下：`open` 表示前台计时
    // 等待还没让出（answer 会返回 false 且静默失败），必须先让用户看到原因。
    if (row.state === 'continued') rows.push({ ...row, answerable: true });
    else rows.push({ ...row, answerable: false, reason: 'open' });
  }
  for (const raw of Array.isArray(tracked) ? tracked : []) {
    const row = normalizePending(raw);
    if (row === undefined || seen.has(row.callId)) continue;
    seen.add(row.callId);
    if (row.state === 'continued') {
      // 事件流看到了 `{ pending: true }` 的 tool result：前台等待已让出，可答。
      rows.push({ ...row, answerable: true });
      continue;
    }
    // 投影可用却查不到这一条 → 阻塞式（legacy）提问：没有 timeout，永远不进投影，
    // 也不存在远程接答通道，只能由电脑端回答。
    if (Array.isArray(projected)) rows.push({ ...row, answerable: false, reason: 'desktop-only' });
    // 投影不可读时无法判断状态：允许尝试，服务端的拒绝会带回明确 code，绝不静默。
    else rows.push({ ...row, answerable: true });
  }
  return rows;
}
