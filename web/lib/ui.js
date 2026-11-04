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

function lockScroll(lock) {
  document.documentElement.classList.toggle('has-layer', lock);
}

/**
 * Mount a layer with backdrop, focus trap, Esc and Android back handling.
 * `build(close)` returns the panel element.
 */
export function layer(build, { onClose = null } = {}) {
  closeLayer();
  const root = $('#modal-root');
  if (root === null) return () => {};

  const backdrop = h('div', { class: 'layer-backdrop' });
  const panel = h('div', { class: 'layer-panel' });
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    root.removeEventListener('click', onBackdrop);
    window.removeEventListener('popstate', close);
    empty(root);
    root.classList.remove('active');
    lockScroll(false);
    openLayer = null;
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
  // Android hardware back closes the layer instead of leaving the page.
  history.pushState({ layer: true }, '');
  window.addEventListener('popstate', close, { once: true });
  lockScroll(true);
  openLayer = close;
  requestAnimationFrame(() => {
    const target = panel.querySelector('[data-autofocus]') ?? panel.querySelector('button, input, textarea');
    target?.focus({ preventScroll: true });
  });
  return close;
}

export function closeLayer() {
  if (openLayer !== null) openLayer();
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
