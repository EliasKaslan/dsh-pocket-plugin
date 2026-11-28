/**
 * 假定时器 + 假时钟（`test/relay` 的自适应心跳用例共用）。
 *
 * 为什么需要它：自适应心跳的两档是 8 s / 30 s，空闲档量化要跑一整天。真 sleep
 * 既慢又不稳定，而"切档立即生效"只能靠观察**定时器被重建**来断言。所以把
 * `setInterval` / `clearInterval` / `Date.now` 换成一个可控的登记表：
 *
 *   - `register(fn, ms)` / `clear(id)`：给 `node:vm` 沙箱注入用（外壳看门狗
 *     跑在 vm 里，但它必须和电脑端的心跳共用同一条时间线）；
 *   - `advance(ms)`：按到期顺序逐个触发，回调里 clear 掉自己再 set 一个新的
 *     也能跟上（`applyBeatTier()` 就是这么换档的）；
 *   - `periods()`：当前还活着的定时器周期，用来断言"档位切换立即生效"。
 *
 * 只接管 `setInterval`：被测代码的 `setTimeout` 分支（重连退避、订阅超时）在
 * 这些用例里都不该被触发，真定时器反而能暴露"意外走到那条路"。
 */

/**
 * 装上假定时器。
 * @param {number} startAt 假时钟起点（毫秒时间戳）
 * @returns {{now: number, intervals: Map<number, object>, register: Function,
 *   clear: Function, periods: Function, advance: Function, restore: Function}}
 */
export function installFakeTimers(startAt) {
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    now: Date.now,
  };
  let now = startAt;
  const intervals = new Map();
  let nextId = 1;

  const fake = {
    intervals,
    register(fn, ms) {
      const id = nextId;
      nextId += 1;
      intervals.set(id, { id, fn, ms, nextAt: now + ms });
      return id;
    },
    clear(id) { intervals.delete(id); },
    /** 当前还活着的定时器周期（按注册顺序）。 */
    periods() { return [...intervals.values()].map((timer) => timer.ms); },
    advance(ms) {
      const target = now + ms;
      let fired = 0;
      for (;;) {
        let due = null;
        for (const timer of intervals.values()) {
          if (timer.nextAt > target) continue;
          if (due === null || timer.nextAt < due.nextAt) due = timer;
        }
        if (due === null) break;
        fired += 1;
        if (fired > 500_000) throw new Error('定时器推进次数异常：像是出现了 0 间隔自激');
        now = due.nextAt;
        due.nextAt = now + Math.max(1, due.ms);
        if (!intervals.has(due.id)) continue; // 回调里把自己 clear 掉了
        due.fn();
      }
      now = target;
      return now;
    },
    restore() {
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
      Date.now = real.now;
    },
  };
  Object.defineProperty(fake, 'now', { get: () => now, enumerable: true });
  globalThis.setInterval = (fn, ms) => fake.register(fn, ms);
  globalThis.clearInterval = (id) => fake.clear(id);
  Date.now = () => now;
  return fake;
}
