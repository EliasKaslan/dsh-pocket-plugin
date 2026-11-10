/** Formatting helpers: time, numbers, model names, status words. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact relative time: 刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 11月2日. */
export function relTime(value, now = Date.now()) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = now - ts;
  if (diff < 0) return '刚刚';
  if (diff < 45_000) return '刚刚';
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
  const date = new Date(ts);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= midnight - DAY) return '昨天';
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 14:03 */
export function clock(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Collapse whitespace and clamp to `max` characters. */
export function oneLine(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Strip the Markdown scaffolding so a preview reads as prose.
 * `## 结论 **很好**` → `结论 很好`
 */
export function plainText(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gmu, '')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/#{2,6}\s*/gu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/~~([^~]+)~~/gu, '$1')
    .replace(/\|/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

/** `volcengine/deepseek-v4.1-flash` → `deepseek-v4.1-flash`. */
export function shortModel(model) {
  const text = String(model ?? '');
  if (text.length === 0) return '';
  const tail = text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text;
  return tail.length > 22 ? `${tail.slice(0, 21)}…` : tail;
}

/** Status words shared by the list chip, the card pill and the detail header. */
export const STATUS = {
  running: { label: '运行中', cls: 'running' },
  done: { label: '已完成', cls: 'done' },
  error: { label: '失败', cls: 'error' },
  cancelled: { label: '已中断', cls: 'cancelled' },
  idle: { label: '空闲', cls: 'idle' },
};

export function statusMeta(status) {
  return STATUS[status] ?? { label: '未知', cls: 'idle' };
}

/** Filter buckets. `done` deliberately means "finished without an error". */
export const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'done', label: '已完成' },
  { id: 'error', label: '失败' },
];

export function inFilter(task, filter) {
  switch (filter) {
    case 'running': return task.status === 'running';
    case 'done': return task.status === 'done' || task.status === 'idle' || task.status === 'cancelled';
    case 'error': return task.status === 'error';
    default: return true;
  }
}

export function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function todayLine(now = new Date()) {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return `${now.getMonth() + 1}月${now.getDate()}日 ${week}`;
}

/** 1024 → 1.0k */
export function compactNumber(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/u, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

/** XSS-safe absolute link check used by the markdown renderer too. */
export function safeHref(href) {
  try {
    const url = new URL(href, 'https://placeholder.invalid/');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
