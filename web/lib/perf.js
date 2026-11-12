/**
 * 手机端性能探针（轻量、常驻、可关闭）。
 *
 * 为什么需要它：桌面端的 CPU 成本已经量过、可以忽略（5000 会话时 snapshot 0.14ms /
 * summary 0.17ms），响应体也已经在走 gzip。剩下唯一没被量过的就是**手机端的渲染**
 * 与**中继往返**。没有这层数据，优化只能靠猜 —— 而猜错一次就要多一轮发布。
 *
 * 只记录"最近若干次的耗时分布"，不缓存任何内容，导出时也只给数字。
 */
const MAX_SAMPLES = 240;
/** 超过这个耗时就记一条 slow 记录（手机上 30ms 已经能感觉到）。 */
const SLOW_MS = 30;

function nowMs() {
  try {
    return globalThis.performance?.now?.() ?? Date.now();
  } catch {
    return Date.now();
  }
}

const buckets = new Map();

function bucketOf(name) {
  let bucket = buckets.get(name);
  if (bucket === undefined) {
    bucket = { count: 0, total: 0, max: 0, slow: 0, last: 0, samples: [] };
    buckets.set(name, bucket);
  }
  return bucket;
}

globalThis.__POCKET_PERF__ = {
  now: nowMs,

  /** 记录一次耗时；`meta` 只保留数字类字段，避免把内容带进统计。 */
  record(name, startedAt, meta) {
    if (typeof startedAt !== 'number' || startedAt <= 0) return;
    const elapsed = nowMs() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) return;
    const bucket = bucketOf(String(name));
    bucket.count += 1;
    bucket.total += elapsed;
    bucket.last = elapsed;
    if (elapsed > bucket.max) bucket.max = elapsed;
    if (elapsed >= SLOW_MS) bucket.slow += 1;
    bucket.samples.push(Math.round(elapsed));
    if (bucket.samples.length > MAX_SAMPLES) bucket.samples.shift();
    if (meta !== undefined && typeof meta === 'object' && bucket.meta === undefined) bucket.meta = meta;
  },

  /** 汇总成可直接贴给人看的行（诊断页用）。 */
  snapshot() {
    const lines = [];
    for (const [name, bucket] of [...buckets.entries()].sort()) {
      if (bucket.count === 0) continue;
      const sorted = [...bucket.samples].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      lines.push(`${name}: ${bucket.count} 次 · p50 ${p50}ms · p95 ${p95}ms · max ${Math.round(bucket.max)}ms · 慢(${SLOW_MS}ms+) ${bucket.slow} 次`);
    }
    return lines;
  },

  reset() {
    buckets.clear();
  },
};
