/** Task detail: transcript, collapsible tool calls, composer, keyboard handling. */
import { $, h, icon, keyedList, raf } from '../lib/dom.js';
import { clock, oneLine, relTime, shortModel, statusMeta } from '../lib/format.js';
import { renderMarkdown } from '../lib/markdown.js';
import { actionSheet, confirmDialog, haptic, toast } from '../lib/ui.js';
import { LIMITS, store } from '../store.js';

const FINE_POINTER = window.matchMedia('(hover: hover) and (pointer: fine)');

/**
 * Flatten the backend transcript into renderable entries, pairing each tool call
 * with its result so the UI shows one row per call instead of two.
 */
export function buildEntries(messages) {
  const entries = [];
  const byCall = new Map();
  for (const message of messages) {
    if (message?.role === 'tool') {
      const entry = { kind: 'tool', key: `c:${message.id}`, call: message, result: null, at: message.at };
      const callId = message.tool?.callId;
      if (typeof callId === 'string') byCall.set(callId, entry);
      entries.push(entry);
      continue;
    }
    if (message?.role === 'tool-result') {
      const entry = byCall.get(message.tool?.callId);
      if (entry !== undefined) { entry.result = message; continue; }
      entries.push({ kind: 'tool', key: `c:${message.id}`, call: message, result: message, at: message.at });
      continue;
    }
    entries.push({ kind: message?.role ?? 'system', key: `m:${message?.id}`, message, at: message?.at });
  }
  return entries;
}

export function mountDetail(root, ctx) {
  const screen = h('div', { class: 'screen screen-detail' });
  const titleEl = h('h1', { class: 'detail-title', text: '任务详情' });
  const statusEl = h('span', { class: 'pill' }, h('i'), h('span', { class: 'pill-text', text: '读取中' }));
  const timeEl = h('span', { class: 'detail-time', text: '' });
  const menuBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '更多操作' }, icon('more'));

  const metaRow = h('div', { class: 'detail-meta' });
  const noticeRow = h('div', { class: 'detail-notice' });
  const chat = h('div', { class: 'chat', id: 'chat' });
  // 「更早的记录」提示条 + 列表宿主。
  // 为什么要有 listHost：滚动容器 `chat` 里除了消息还要放这条提示，而
  // keyedList 会重排它的直接子节点。`.chat-list { display: contents }` 让这层
  // 包装在布局上透明，于是消息仍然是 `chat` 的 flex 项，提示条也能待在最上面。
  const olderHint = h('div', { class: 'older-hint', id: 'older-hint' });
  const listHost = h('div', { class: 'chat-list' });
  chat.append(olderHint, listHost);
  const jumpBtn = h('button', {
    class: 'jump-bottom', type: 'button', 'aria-label': '回到最新',
    on: { click: () => { scrollToBottom(true); } },
  }, icon('down', { size: 20 }));

  const input = h('textarea', {
    class: 'composer-input', id: 'chat-input', rows: '1',
    placeholder: '继续这个任务…', maxlength: String(LIMITS.promptChars), enterkeyhint: 'enter',
  });
  const sendBtn = h('button', {
    class: 'send-btn', type: 'button', 'aria-label': '发送',
    on: { click: () => void send() },
  }, icon('send', { size: 20 }));
  const composerHint = h('div', { class: 'composer-hint', text: '' });
  const composer = h('div', { class: 'composer', id: 'composer' },
    h('div', { class: 'composer-box' }, input, sendBtn),
    composerHint,
  );

  const header = h('header', { class: 'detail-header' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '返回', on: { click: () => ctx.back() } }, icon('back')),
    h('div', { class: 'detail-heading' }, titleEl, h('div', { class: 'detail-sub' }, statusEl, timeEl)),
    menuBtn,
  );

  screen.append(header, metaRow, noticeRow, chat, jumpBtn, composer);
  root.append(screen);

  menuBtn.addEventListener('click', () => void openMenu());

  /* ---------------- composer behaviour ---------------- */

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }
  input.addEventListener('input', autoGrow);

  // 「回到底部」按钮靠 --composer-h 避开输入框。输入框会随换行长高，所以这里
  // 实时量真实高度写进去；不量的话按钮会压在输入框上。
  // （同一处曾经还写过 --vvh，但没有任何样式读它，已删除。）
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      if (composer.isConnected !== true) { observer.disconnect(); return; }
      const height = Math.round(composer.getBoundingClientRect().height);
      if (height > 0) document.documentElement.style.setProperty('--composer-h', `${height}px`);
    });
    observer.observe(composer);
  }

  input.addEventListener('keydown', (event) => {
    // Never send while an IME is composing — that is how half-typed Chinese
    // sentences used to启动 a real Agent turn on the host.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    if (!FINE_POINTER.matches) return; // touch keyboard Enter must insert a newline
    event.preventDefault();
    void send();
  });

  const viewport = window.visualViewport;
  function fitViewport() {
    if (viewport === null || viewport === undefined) return;
    // 只把「键盘顶起来多少」写进 --kb；--vvh 无人读取，别再写。
    const kb = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  }
  viewport?.addEventListener('resize', fitViewport);
  viewport?.addEventListener('scroll', fitViewport);
  fitViewport();

  input.addEventListener('focus', () => {
    setTimeout(() => { scrollToBottom(false); fitViewport(); }, 260);
  });

  async function send() {
    const text = input.value.trim();
    if (text.length === 0 || store.sending) return;
    const task = store.detail?.task;
    if (task === undefined || task === null) return;
    store.sending = true;
    sendBtn.disabled = true;
    const pending = { id: `pending-${Date.now()}`, role: 'user', text, at: Date.now(), pending: true };
    const list = store.detail.messages ?? [];
    list.push(pending);
    input.value = '';
    autoGrow();
    paintChat();
    scrollToBottom(true);
    haptic();
    try {
      await ctx.api(`/api/v1/tasks/${encodeURIComponent(task.id)}/prompt`, {
        method: 'POST',
        body: { prompt: text },
      });
      const index = list.indexOf(pending);
      if (index >= 0) list.splice(index, 1);
      toast('已发送，电脑端会继续这个会话', { tone: 'ok' });
      ctx.refreshDetailSoon();
    } catch (error) {
      input.value = text;
      autoGrow();
      toast(error?.message ?? '发送失败', { tone: 'danger' });
      const index = list.indexOf(pending);
      if (index >= 0) list.splice(index, 1);
      paintChat();
    } finally {
      store.sending = false;
      sendBtn.disabled = false;
      updateComposer();
    }
  }

  async function openMenu() {
    const task = store.detail?.task;
    if (task === undefined || task === null) return;
    const picked = await actionSheet({
      title: oneLine(task.title || '任务', 40),
      items: [
        { label: '复制任务 ID', icon: 'copy', run: () => { void navigator.clipboard?.writeText(task.id); toast('已复制任务 ID', { tone: 'ok' }); } },
        { label: '复制会话摘要', icon: 'copy', run: () => { void navigator.clipboard?.writeText(summaryText(task)); toast('已复制摘要', { tone: 'ok' }); } },
        {
          label: task.status === 'running' ? '中断这个任务' : '任务已结束，无法中断',
          icon: 'stop',
          danger: true,
          disabled: task.status !== 'running',
          run: () => void cancelTask(task),
        },
        { label: '刷新会话内容', icon: 'refresh', run: () => ctx.reloadDetail() },
      ],
    });
    if (picked !== null) picked.run();
  }

  function summaryText(task) {
    return [
      `任务：${task.title ?? ''}`,
      `状态：${statusMeta(task.status).label}`,
      `目录：${task.cwd ?? ''}`,
      `ID：${task.id}`,
    ].join('\n');
  }

  async function cancelTask(task) {
    const ok = await confirmDialog({
      title: '中断任务？',
      message: '电脑端正在执行的工作会被停止，已经产生的输出会保留。',
      confirmText: '中断',
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.api(`/api/v1/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' });
      toast('已请求中断', { tone: 'ok' });
      ctx.refreshDetailSoon();
    } catch (error) {
      toast(error?.message ?? '中断失败', { tone: 'danger' });
    }
  }

  /* ---------------- scrolling ---------------- */

  /** 距顶部多近就预取更早的一页。给一屏的高度，滑动时不会等。 */
  const LOAD_OLDER_AT_PX = 320;
  let loadingOlder = false;
  let autoFillBudget = 6;

  /**
   * 往上翻一页。
   *
   * 关键：插入更早消息会把内容顶上去，如果不管滚动位置，画面会"跳"。所以
   * 前后各记一次 `scrollHeight`，把差值补进 `scrollTop`，视觉上原地不动。
   *
   * @param {{auto?: boolean}} [options] auto=true 表示这是"内容不足一屏时的自动补齐"
   */
  async function loadOlderHere({ auto = false } = {}) {
    if (loadingOlder) return 0;
    const detail = store.detail;
    if (detail === null || detail === undefined || detail.hasMore !== true) return 0;
    if (typeof ctx.loadOlder !== 'function' || store.detailId === null) return 0;
    loadingOlder = true;
    updateOlderHint();
    const beforeHeight = chat.scrollHeight;
    const beforeTop = chat.scrollTop;
    try {
      const added = await ctx.loadOlder(store.detailId);
      if (added < 0) {
        // 游标失效：服务端已经把列表重置成尾部一页，回到最新位置。
        paintChat();
        scrollToBottom(true);
        return added;
      }
      if (added > 0) {
        paintChat();
        if (!auto) chat.scrollTop = beforeTop + (chat.scrollHeight - beforeHeight);
      }
      return added;
    } catch (error) {
      toast(error?.message ?? '加载更早的记录失败，请稍后再试', { tone: 'danger' });
      return 0;
    } finally {
      loadingOlder = false;
      updateOlderHint();
    }
  }

  /** 内容不足一屏时自动补更早的页（有预算上限，避免无限拉）。 */
  async function autoFill() {
    if (autoFillBudget <= 0) return;
    autoFillBudget -= 1;
    const added = await loadOlderHere({ auto: true });
    if (added > 0 && chat.scrollHeight <= chat.clientHeight + 8) void autoFill();
  }

  /** 顶部提示条：加载中 / 还能往上翻 / 已经到最早。 */
  function updateOlderHint() {
    const detail = store.detail;
    if (detail === null || detail === undefined) { olderHint.hidden = true; return; }
    if (loadingOlder) {
      olderHint.hidden = false;
      olderHint.textContent = '正在加载更早的记录…';
      return;
    }
    if (detail.hasMore === true) {
      olderHint.hidden = false;
      olderHint.textContent = '往上翻看更早的记录';
      return;
    }
    const total = Number(detail.total) || 0;
    olderHint.hidden = total === 0;
    olderHint.textContent = total > 0 ? '已经到最早的记录了' : '';
  }

  function nearBottom() {
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 96;
  }

  function scrollToBottom(force) {
    if (!force && !store.chatAuto) return;
    chat.scrollTop = chat.scrollHeight;
    store.chatAuto = true;
    jumpBtn.classList.remove('show');
  }

  chat.addEventListener('scroll', () => {
    store.chatAuto = nearBottom();
    jumpBtn.classList.toggle('show', !store.chatAuto && chat.scrollHeight > chat.clientHeight + 240);
    // 翻到接近顶部：补更早的一页。
    if (chat.scrollTop < LOAD_OLDER_AT_PX) void loadOlderHere();
  }, { passive: true });

  /* ---------------- transcript rendering ---------------- */

  function messageNode(entry) {
    switch (entry.kind) {
      case 'user': {
        const bubble = h('div', { class: 'bubble' });
        const body = h('div', { class: 'bubble-text' });
        const meta = h('div', { class: 'msg-meta' });
        const el = h('div', { class: 'msg msg-user' }, bubble, meta);
        let lastText = null;
        let lastAt = 0;
        const update = (next) => {
          if (next.message.text !== lastText) {
            lastText = next.message.text;
            body.replaceChildren(...renderMarkdown(next.message.text).childNodes);
            bubble.replaceChildren(body);
          }
          if (next.message.at !== lastAt) {
            lastAt = next.message.at;
            meta.textContent = next.message.pending ? '发送中…' : clock(next.message.at);
          }
          el.classList.toggle('pending', next.message.pending === true);
        };
        update(entry);
        return { el, update };
      }
      case 'assistant': {
        const body = h('div', { class: 'markdown' });
        const modelTag = h('span', { class: 'msg-model' });
        const reasoningWrap = h('details', { class: 'reasoning' });
        const reasoningBody = h('div', { class: 'reasoning-body' });
        reasoningWrap.append(h('summary', null, icon('sparkles', { size: 14 }), h('span', { text: '思考过程' })), reasoningBody);
        const el = h('div', { class: 'msg msg-assistant' },
          h('div', { class: 'assistant-card' }, reasoningWrap, body, h('div', { class: 'msg-foot' }, modelTag)),
        );
        let lastText = null;
        let lastReason = null;
        const card = el.querySelector('.assistant-card');
        const update = (next) => {
          const message = next.message;
          if (message.text !== lastText) {
            lastText = message.text;
            body.replaceChildren(...(message.text.length > 0 ? renderMarkdown(message.text).childNodes : [h('span', { class: 'muted', text: '（没有文本输出）' })]));
          }
          if (message.reasoning !== lastReason) {
            lastReason = message.reasoning;
            reasoningWrap.hidden = !message.reasoning;
            if (message.reasoning) reasoningBody.textContent = message.reasoning;
          }
          // A step that only produced reasoning does not deserve a full card.
          card.classList.toggle('compact', message.text.trim().length === 0 && Boolean(message.reasoning));
          modelTag.textContent = shortModel(message.model?.model ?? '');
          modelTag.hidden = !message.model?.model;
          el.dataset.at = String(Number(message.at) || 0);
        };
        update(entry);
        return { el, update };
      }
      case 'tool': {
        const summary = h('summary', { class: 'tool-head' },
          h('span', { class: 'tool-dot' }),
          h('span', { class: 'tool-name' }),
          h('span', { class: 'tool-args' }),
        );
        const argsBody = h('pre', { class: 'tool-body' });
        const resultBody = h('pre', { class: 'tool-body tool-result' });
        const el = h('details', { class: 'tool' }, summary, argsBody, resultBody);
        let lastSig = '';
        const update = (next) => {
          const name = next.call.tool?.name ?? '工具调用';
          const args = next.call.tool?.args;
          const argsText = typeof args === 'string' ? args : JSON.stringify(args ?? {}, null, 2);
          const resultText = next.result?.text ?? '';
          const status = next.result?.tool?.status ?? next.call.tool?.status ?? 'running';
          const sig = `${name}\u0000${argsText}\u0000${resultText}\u0000${status}`;
          if (sig === lastSig) return;
          lastSig = sig;
          el.dataset.status = status;
          summary.querySelector('.tool-name').textContent = name;
          summary.querySelector('.tool-args').textContent = oneLine(firstLine(argsText), 60);
          argsBody.textContent = argsText;
          argsBody.hidden = argsText.trim().length === 0 || argsText.trim() === '{}';
          resultBody.textContent = resultText;
          resultBody.hidden = resultText.length === 0;
          resultBody.dataset.error = String(next.result?.tool?.isError === true);
        };
        update(entry);
        return { el, update };
      }
      case 'divider': {
        const el = h('div', { class: 'divider' });
        const update = (next) => {
          const message = next.message;
          const kind = message.kind;
          if (kind === 'turn-start') {
            el.className = 'divider turn-start';
            el.textContent = message.turn ? `第 ${message.turn} 轮` : '新一轮';
            return;
          }
          const map = { done: '本轮完成', stopped: '本轮被中断', error: '本轮出错' };
          el.className = `divider turn-end ${message.status ?? ''}`;
          el.textContent = `${map[message.status] ?? '本轮结束'}${message.reason ? ` · ${oneLine(message.reason, 40)}` : ''}`;
        };
        update(entry);
        return { el, update };
      }
      default: {
        const el = h('div', { class: 'msg msg-system' }, icon('alert', { size: 16 }), h('span'));
        const update = (next) => { el.querySelector('span').textContent = oneLine(next.message?.text ?? '出错了', 400); };
        update(entry);
        return { el, update };
      }
    }
  }

  const chatList = keyedList(listHost, (entry) => entry.key);
  const paint = raf(() => paintChatNow());
  function paintChat() { paint(); }

  function paintChatNow() {
    const detail = store.detail;
    if (detail === null || detail === undefined) {
      chatList.set([], messageNode);
      updateOlderHint();
      return;
    }
    const entries = buildEntries(detail.messages ?? []);
    if (detail.degraded === true && entries.length > 0) {
      entries.unshift({ kind: 'system', key: 'm:degraded', message: { text: '该会话日志较长，只载入了最近的部分。' }, at: 0 });
    }
    if (detail.truncated === true && entries.length > 0) {
      entries.unshift({ kind: 'system', key: 'm:truncated', message: { text: '更早的消息已省略。' }, at: 0 });
    }
    chatList.set(entries, messageNode);
    updateOlderHint();
    // 内容还不够一屏、但服务端说还有更早的：自动补齐，别让用户对着一屏空白。
    if (detail.hasMore === true && chat.scrollHeight <= chat.clientHeight + 8) void autoFill();
  }

  /* ---------------- chrome ---------------- */

  function updateComposer() {
    const task = store.detail?.task;
    const running = task?.status === 'running';
    const subagent = task?.isSubagent === true;
    composer.hidden = subagent;
    if (subagent) return;
    input.placeholder = running ? '任务运行中，消息会排队…' : '继续这个任务…';
    composerHint.textContent = running ? 'DSH 正在执行，新消息会在当前轮结束后处理' : '发送后电脑端会继续这个会话';
  }

  function updateHeader() {
    const task = store.detail?.task ?? (store.detailId !== null ? store.tasks.get(store.detailId) : undefined);
    if (task === undefined || task === null) {
      titleEl.textContent = '任务详情';
      return;
    }
    titleEl.textContent = oneLine(task.title || '未命名任务', 120);
    const meta = statusMeta(task.status);
    statusEl.className = `pill ${meta.cls}`;
    statusEl.querySelector('.pill-text').textContent = meta.label;
    timeEl.textContent = relTime(task.updatedAt);
    timeEl.dataset.ts = String(Number(task.updatedAt) || 0);

    metaRow.replaceChildren();
    const pill = (iconName, text) => h('span', { class: 'meta-pill' }, icon(iconName, { size: 13 }), h('span', { text }));
    const dir = task.cwdName || task.cwd;
    if (dir) metaRow.append(pill('folder', dir));
    const model = shortModel(task.model?.model ?? '');
    if (model) metaRow.append(pill('cpu', model));
    if (task.turn) metaRow.append(pill('refresh', `第 ${task.turn} 轮`));
    if (task.status === 'error' && task.statusReason) metaRow.append(pill('alert', oneLine(task.statusReason, 60)));

    noticeRow.replaceChildren();
    if (store.detailError) {
      noticeRow.append(h('div', { class: 'notice danger' }, icon('alert', { size: 16 }),
        h('span', { text: store.detailError }),
        h('button', { class: 'notice-action', type: 'button', text: '重试', on: { click: () => ctx.reloadDetail() } })));
    }
    updateComposer();
  }

  return {
    screen,
    paint() { updateHeader(); paintChat(); },
    paintChat,
    updateHeader,
    scrollToBottom,
    destroy() {
      viewport?.removeEventListener('resize', fitViewport);
      viewport?.removeEventListener('scroll', fitViewport);
      chatList.clear();
    },
  };
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').find((entry) => entry.trim().length > 0) ?? '';
  return line.trim();
}
