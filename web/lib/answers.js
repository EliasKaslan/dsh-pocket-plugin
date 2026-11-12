/**
 * Pure helpers for answering `ask_user_question` from the phone.
 *
 * No DOM here on purpose: the answer batch shape is the part most likely to
 * break, and it must stay unit-testable in Node.
 *
 * The host contract (validated again by `ctx.userQuestions.answer`):
 *   - one item per question of the call, `{ id, selected: string[], custom? }`;
 *   - `selected` carries option **labels**, not ids;
 *   - single-select + custom text ⇒ `selected` must be empty, only `custom`;
 *   - multi-select may combine `selected` with `custom`.
 */

/** A fresh draft for one question. */
export function emptyDraft() {
  return { selected: [], custom: '' };
}

/** Keep only rows the UI can render (defensive: server data is not trusted). */
export function questionsOf(pending) {
  const questions = Array.isArray(pending?.questions) ? pending.questions : [];
  return questions.filter((question) => question !== null
    && typeof question === 'object'
    && typeof question.id === 'string'
    && typeof question.question === 'string'
    && question.question.length > 0);
}

/** Read a draft without leaking the stored object into the renderer. */
export function draftOf(drafts, questionId) {
  const hit = drafts?.[questionId];
  if (hit === undefined || hit === null) return emptyDraft();
  return {
    selected: Array.isArray(hit.selected) ? [...hit.selected] : [],
    custom: typeof hit.custom === 'string' ? hit.custom : '',
  };
}

/** Tap an option: multi-select toggles, single-select replaces (tap again clears). */
export function toggleChoice(question, draft, label) {
  const current = Array.isArray(draft?.selected) ? draft.selected : [];
  if (question?.multiSelect === true) {
    const next = new Set(current);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    return { selected: [...next], custom: typeof draft?.custom === 'string' ? draft.custom : '' };
  }
  // 单选：点了选项就以选项为准。custom 必须清空 —— 否则 buildAnswers 见到非空
  // custom 会丢弃 selected，用户看到选项高亮、提交出去的却是旧的自定义文本（静默送错答案）。
  return {
    selected: current.length === 1 && current[0] === label ? [] : [label],
    custom: '',
  };
}

/**
 * Type custom text. On a single-select question a non-empty custom answer owns
 * the question, so the option highlight is dropped right away (the batch the
 * host receives must carry `selected: []`).
 */
export function setCustom(question, draft, text) {
  const custom = typeof text === 'string' ? text : '';
  const selected = Array.isArray(draft?.selected) ? draft.selected : [];
  if (question?.multiSelect === true || custom.trim().length === 0) {
    return { selected: [...selected], custom };
  }
  return { selected: [], custom };
}

/** Which questions still have neither a choice nor custom text. */
export function unanswered(questions, drafts) {
  const missing = [];
  for (const question of questionsOf({ questions })) {
    const draft = draftOf(drafts, question.id);
    const custom = draft.custom.trim();
    if (draft.selected.length === 0 && custom.length === 0) missing.push(question.id);
  }
  return missing;
}

/**
 * Build the `answers` array for one question call.
 *
 * @returns {{ok: true, answers: Array} | {ok: false, error: string}}
 */
export function buildAnswers(questions, drafts) {
  const list = questionsOf({ questions });
  if (list.length === 0) return { ok: false, error: '这次提问没有可回答的问题' };
  const missing = unanswered(list, drafts);
  if (missing.length > 0) {
    const first = list.find((question) => question.id === missing[0]);
    return { ok: false, error: `请先回答「${first?.question ?? missing[0]}」` };
  }
  const answers = [];
  for (const question of list) {
    const draft = draftOf(drafts, question.id);
    const custom = draft.custom.trim();
    // 单选 + 自定义：只发 custom，selected 必须是空数组（宿主会校验）。
    if (custom.length > 0 && question.multiSelect !== true) {
      answers.push({ id: question.id, selected: [], custom });
      continue;
    }
    const answer = { id: question.id, selected: [...draft.selected] };
    if (custom.length > 0) answer.custom = custom;
    answers.push(answer);
  }
  return { ok: true, answers };
}

/** Request body for `POST /api/v1/tasks/:id/answer`. */
export function answerPayload(callId, answers) {
  return { callId, answers };
}
