/**
 * Small, safe Markdown renderer.
 *
 * It builds DOM nodes directly instead of producing an HTML string, so a reply
 * that contains `<img onerror=…>` stays text. Only these constructs are
 * supported: headings, fenced code, lists (ordered/unordered, one nesting
 * level), blockquotes, tables, rules, and inline bold/italic/strike/code/link.
 * Anything else falls through as a paragraph, which is always safe.
 */
import { h } from './dom.js';
import { safeHref } from './format.js';

const cache = new Map();
const CACHE_LIMIT = 120;

/** Render `source` into a DocumentFragment (memoised by source text). */
export function renderMarkdown(source) {
  const text = String(source ?? '');
  const cached = cache.get(text);
  if (cached !== undefined) return cached.cloneNode(true);

  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().length === 0) { i += 1; continue; }

    const fence = /^(\s*)(```|~~~)\s*([\w+#-]*)\s*$/u.exec(line);
    if (fence !== null) {
      const marker = fence[2];
      const lang = fence[3];
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) { body.push(lines[i]); i += 1; }
      i += 1;
      frag.append(codeBlock(body.join('\n'), lang));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      const level = Math.min(6, heading[1].length);
      const el = h(`h${Math.max(3, level)}`, { class: `md-h md-h${level}` });
      inline(el, heading[2]);
      frag.append(el);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      frag.append(h('hr', { class: 'md-hr' }));
      i += 1;
      continue;
    }

    if (/^\s*>\s?/u.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/u.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/u, ''));
        i += 1;
      }
      const quote = h('blockquote', { class: 'md-quote' });
      quote.append(renderMarkdown(body.join('\n')));
      frag.append(quote);
      continue;
    }

    if (isTableStart(lines, i)) {
      const { table, next } = buildTable(lines, i);
      frag.append(table);
      i = next;
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u.exec(line);
    if (bullet !== null) {
      const ordered = /\d/u.test(bullet[2]);
      const list = h(ordered ? 'ol' : 'ul', { class: 'md-list' });
      while (i < lines.length) {
        const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u.exec(lines[i]);
        if (item === null || /\d/u.test(item[2]) !== ordered) break;
        const li = h('li');
        inline(li, item[3]);
        list.append(li);
        i += 1;
        // A plain indented line continues the current item.
        while (i < lines.length && /^\s{2,}\S/u.test(lines[i]) && !/^\s*([-*+]|\d{1,9}[.)])\s+/u.test(lines[i])) {
          li.append(document.createTextNode(' '));
          inline(li, lines[i].trim());
          i += 1;
        }
      }
      frag.append(list);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim().length > 0 && !isBlockStart(lines, i)) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length === 0) { i += 1; continue; }
    const p = h('p');
    inline(p, para.join('\n'));
    frag.append(p);
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(text, frag.cloneNode(true));
  return frag;
}

function isBlockStart(lines, i) {
  const line = lines[i];
  return /^\s*(```|~~~)/u.test(line)
    || /^#{1,6}\s/u.test(line)
    || /^\s*>\s?/u.test(line)
    || /^\s*([-*+]|\d{1,9}[.)])\s+/u.test(line)
    || isTableStart(lines, i);
}

function codeBlock(code, lang) {
  const wrap = h('div', { class: 'md-code' });
  if (lang) wrap.append(h('span', { class: 'md-code-lang', text: lang }));
  wrap.append(h('pre', null, h('code', { text: code })));
  return wrap;
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  return lines[i].includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/u.test(lines[i + 1]);
}

function splitRow(line) {
  return line.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map((cell) => cell.trim());
}

function buildTable(lines, start) {
  const head = splitRow(lines[start]);
  const table = h('table', { class: 'md-table' });
  const thead = h('thead');
  const headRow = h('tr');
  for (const cell of head) {
    const th = h('th');
    inline(th, cell);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = h('tbody');
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim().length > 0) {
    const tr = h('tr');
    for (const cell of splitRow(lines[i])) {
      const td = h('td');
      inline(td, cell);
      tr.append(td);
    }
    tbody.append(tr);
    i += 1;
  }
  table.append(tbody);
  const wrap = h('div', { class: 'md-table-wrap' }, table);
  return { table: wrap, next: i };
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/u;

/** Append inline-formatted content of `text` into `parent`. */
function inline(parent, text) {
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (match === null) { parent.append(document.createTextNode(rest)); break; }
    if (match.index > 0) parent.append(document.createTextNode(rest.slice(0, match.index)));
    const token = match[0];
    rest = rest.slice(match.index + token.length);

    if (token.startsWith('`')) {
      parent.append(h('code', { class: 'md-inline-code', text: token.slice(1, -1) }));
    } else if (token.startsWith('**') || token.startsWith('__')) {
      parent.append(h('strong', { text: token.slice(2, -2) }));
    } else if (token.startsWith('*') || token.startsWith('_')) {
      parent.append(h('em', { text: token.slice(1, -1) }));
    } else if (token.startsWith('~~')) {
      parent.append(h('del', { text: token.slice(2, -2) }));
    } else if (token.startsWith('[')) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      const safe = safeHref(href);
      if (safe === null) parent.append(document.createTextNode(label || href));
      else parent.append(h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text: label || safe }));
    } else {
      const href = safeHref(token);
      if (href === null) parent.append(document.createTextNode(token));
      else parent.append(h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: token }));
    }
  }
  return parent;
}
