/** Shared UI primitives: toast, bottom sheet, confirm dialog, empty states. */
import { $, empty, h, icon } from './dom.js';

/* ---------------- toast ---------------- */

let toastTimer = null;

export function toast(message, { tone = 'info', action = null, timeout = 2600 } = {}) {
  const root = $('#toast');
  if (root === null) return;
  empty(root);
  root.className = `toast show toast-${tone}`;
  root.append(h('span', { class: 'toast-text', text: String(message) }));
  if (action !== null) {
    root.append(h('button', {
      class: 'toast-action',
      type: 'button',
      text: action.label,
      on: { click: () => { hideToast(); action.run(); } },
    }));
  }
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, timeout);
}

export function hideToast() {
  const root = $('#toast');
  if (root === null) return;
  root.classList.remove('show');
  if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
}

/* ---------------- modal plumbing ---------------- */

let openLayer = null;

/**
 * 我们**自己**排了几次 `history.back()`，还没收到对应的 popstate。
 *
 * 为什么需要记账：弹层压进历史的那一条记录删不掉，只能靠 `history.back()` 退回去；
 * 而 back() 是异步的，它的 popstate 很可能在**下一个弹层打开之后**才落地。那时
 * 新弹层已经接管了返回键，会把这次"自己排的退栈"当成用户按了返回，把自己关掉 ——
 * 表现为对话框一闪而过（`openMenu()` → 选中「中断这个任务」→ `cancelTask()`
 * 弹确认框，正是这条路径）。
 */
let pendingSelfPops = 0;
/** 全局 popstate 监听是否已装（只装一次，装了就不摘）。 */
let watchingPopstate = false;

/**
 * 返回键的唯一入口。
 *
 * 两件事：① 先消化我们自己排的 back() 回声；② 其余才是用户按了返回 / 手势返回，
 * 转交给当前弹层。
 */
function onPopstate() {
  if (pendingSelfPops > 0) { pendingSelfPops -= 1; return; }
  const close = openLayer;
  if (close === null) return;
  close({ byPop: true });
}

function lockScroll(lock) {
  document.documentElement.classList.toggle('has-layer', lock);
}

/**
 * Mount a layer with backdrop, focus trap, Esc and Android back handling.
 * `build(close)` returns the panel element.
 */
export function layer(build, { onClose = null } = {}) {
  // 已经有一个弹层：这次是**换层**，复用同一条历史记录，别再压一条。
  // 先 close 再 push 会撞上 close 里那次异步 `history.back()`，把新压的记录顶掉。
  const reuseEntry = openLayer !== null;
  closeLayer({ keepHistory: reuseEntry });
  const root = $('#modal-root');
  if (root === null) return () => {};

  const backdrop = h('div', { class: 'layer-backdrop' });
  const panel = h('div', { class: 'layer-panel' });
  /**
   * @param {{byPop?: boolean, keepHistory?: boolean}} [options]
   *   byPop: 这次关闭是浏览器返回键触发的（历史已经退过了）；
   *   keepHistory: 历史里那条弹层记录要留给下一个弹层复用。
   */
  const close = ({ byPop = false, keepHistory = false } = {}) => {
    document.removeEventListener('keydown', onKey, true);
    root.removeEventListener('click', onBackdrop);
    empty(root);
    root.classList.remove('active');
    lockScroll(false);
    openLayer = null;
    // 幽灵历史条目的修复：只有「代码关掉」时才需要退栈 —— 用户按返回关掉的那次，
    // 浏览器已经把记录退掉了（byPop）。不退这一下，历史里就留一条幽灵记录：
    // 用户再按返回什么都不会发生（没有 popstate 监听、hash 也没变），看起来像
    // 返回键坏了；弹几次就攒几条，要按同样多次返回才退得出去。
    if (!byPop && !keepHistory && history.state?.layer === true) {
      pendingSelfPops += 1;
      history.back();
    }
    if (onClose !== null) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const onBackdrop = (event) => { if (event.target === backdrop) close(); };

  empty(root);
  root.className = 'layer-root active';
  root.append(backdrop, panel);
  build(panel, close);
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', onBackdrop);
  if (!watchingPopstate) {
    window.addEventListener('popstate', onPopstate);
    watchingPopstate = true;
  }
  // Android hardware back closes the layer instead of leaving the page.
  if (!reuseEntry) history.pushState({ layer: true }, '');
  lockScroll(true);
  openLayer = close;
  requestAnimationFrame(() => {
    const target = panel.querySelector('[data-autofocus]') ?? panel.querySelector('button, input, textarea');
    target?.focus({ preventScroll: true });
  });
  return close;
}

export function closeLayer(options) {
  if (openLayer !== null) openLayer(options);
}

/* ---------------- confirm dialog ---------------- */

export function confirmDialog({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    layer((panel, close) => {
      panel.className = 'layer-panel dialog';
      panel.append(
        h('h2', { class: 'dialog-title', text: title }),
        message ? h('p', { class: 'dialog-text', text: message }) : null,
        h('div', { class: 'dialog-actions' },
          h('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: cancelText,
            on: { click: () => { finish(false); close(); } },
          }),
          h('button', {
            class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
            type: 'button',
            text: confirmText,
            'data-autofocus': '',
            on: { click: () => { finish(true); close(); } },
          }),
        ),
      );
    }, { onClose: () => finish(false) });
  });
}

/* ---------------- bottom sheet ---------------- */

/**
 * @param {{title?: string, items: Array<{label: string, icon?: string, danger?: boolean, disabled?: boolean, run: Function}>}} spec
 */
export function actionSheet({ title, items }) {
  return new Promise((resolve) => {
    let picked = null;
    layer((panel, close) => {
      panel.className = 'layer-panel sheet';
      if (title) panel.append(h('div', { class: 'sheet-title', text: title }));
      const list = h('div', { class: 'sheet-list' });
      for (const item of items) {
        list.append(h('button', {
          class: `sheet-item${item.danger ? ' danger' : ''}`,
          type: 'button',
          disabled: item.disabled === true,
          on: {
            click: () => {
              if (item.disabled === true) return;
              picked = item;
              close();
            },
          },
        }, item.icon ? icon(item.icon, { size: 20 }) : null, h('span', { text: item.label })));
      }
      panel.append(list, h('button', {
        class: 'sheet-cancel',
        type: 'button',
        text: '取消',
        on: { click: close },
      }));
    }, { onClose: () => resolve(picked) });
  });
}

/* ---------------- empty state / skeleton ---------------- */

export function emptyState({ iconName = 'sparkles', title, desc = '', action = null }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, { size: 30 })),
    h('h3', { class: 'empty-title', text: title }),
    desc ? h('p', { class: 'empty-desc', text: desc }) : null,
    action ? h('button', {
      class: 'btn btn-ghost empty-action',
      type: 'button',
      text: action.label,
      on: { click: action.run },
    }) : null,
  );
}

export function skeletonCard() {
  return h('div', { class: 'skeleton-card' },
    h('div', { class: 'sk sk-pill' }),
    h('div', { class: 'sk sk-title' }),
    h('div', { class: 'sk sk-line' }),
    h('div', { class: 'sk sk-line short' }),
  );
}

/** Short vibration where supported; never throws, never blocks. */
export function haptic(pattern = 8) {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}
