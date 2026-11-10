/**
 * Tiny DOM toolkit for the DSH Pocket phone app.
 *
 * Everything here builds real nodes — no template strings are ever assigned to
 * `innerHTML` for data that came from the host. That removes the whole class of
 * injection bugs instead of trying to escape them one by one.
 */

/** Create an element. `attrs` understands class, text, dataset, style, on*. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs !== null && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style') Object.assign(el.style, value);
      else if (key === 'on') for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

/** Append children, flattening arrays and skipping empty values. */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** `<svg><use href="#i-name"></use></svg>` from the sprite in index.html. */
export function icon(name, { size = 22, cls = '' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Remove every child without touching the element itself. */
export function empty(el) {
  while (el.firstChild !== null) el.removeChild(el.firstChild);
  return el;
}

/**
 * Keyed list reconciler.
 *
 * `create(item)` returns `{ el, update(item) }`; `set(items)` then reuses every
 * element whose key is unchanged, creates only the new ones, drops the removed
 * ones, and reorders by move instead of rebuilding. This is what keeps a
 * 300-row task list from re-rendering (and re-animating) on every keystroke.
 */
export function keyedList(parent, keyOf) {
  /** @type {Map<string, {el: Element, update: Function}>} */
  let rows = new Map();

  return {
    set(items, create) {
      const seen = new Set();
      let cursor = parent.firstChild;
      for (const item of items) {
        const key = String(keyOf(item));
        seen.add(key);
        let row = rows.get(key);
        if (row === undefined) {
          row = create(item);
          rows.set(key, row);
        } else {
          row.update(item);
        }
        if (row.el === cursor) {
          cursor = cursor.nextSibling;
        } else {
          parent.insertBefore(row.el, cursor);
        }
      }
      for (const [key, row] of rows) {
        if (seen.has(key)) continue;
        row.el.remove();
        rows.delete(key);
      }
    },
    clear() {
      for (const row of rows.values()) row.el.remove();
      rows = new Map();
    },
    get size() {
      return rows.size;
    },
  };
}

/** Debounce that also exposes `flush()` for keydown/blur paths. */
export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.flush = (...args) => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    fn(...args);
  };
  wrapped.cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

/** Coalesce calls into one animation frame. */
export function raf(fn) {
  let handle = 0;
  return () => {
    if (handle !== 0) return;
    handle = requestAnimationFrame(() => { handle = 0; fn(); });
  };
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
