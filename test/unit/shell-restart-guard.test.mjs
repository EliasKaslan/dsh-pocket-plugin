/**
 * C8（后半）：`restart()` 失败后，**已经失效的页面不许再排重连定时器**。
 *
 * 现场：`markSuperseded()`（新标签页/新手机接管）或 `stop()`（fatal 页 / 引导重跑）
 * 之后，`connect()` 的失败是晚到一步的 —— catch 照样会把 `fastRetryTimer` 排上。
 * 于是"死页"继续自我重建：它每次重建成功都会再抢一次主（把**新**页面顶掉），
 * 重建失败就再排一次，永远停不下来。旧实现的其余防乒乓（`superseded` 早退、
 * `disposed` 早退、`stop()` 里 clearTimeout）都在**入口**，唯独漏了 catch 里这一处。
 *
 * 为什么用 vm 切片真跑：`restart()` 的成功分支要真的连 MQTT，但**失败分支**可以
 * 用一个必然 reject 的假 `connect()` 走到；切出来在沙箱里跑，`setTimeout` 换成记账
 * 版本，就能直接断言"有没有排定时器"（对源码做正则只能证明那行还在，证明不了它
 * 在死页上也会被执行）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readRepoFile, runSlices, sliceConst, sliceMethod } from '../support/shell-source.mjs';

const SOURCE = readRepoFile('remote/remote.js');

/** 切出生产源码里的 `restart()`（含它依赖的三个硬兜底常量），并接管 setTimeout。 */
function loadRestart() {
  const scheduled = [];
  const slices = runSlices({
    declarations: [
      { name: 'HARD_RESET_AFTER', source: sliceConst(SOURCE, 'HARD_RESET_AFTER') },
      { name: 'HARD_RESET_MIN_DOWN_MS', source: sliceConst(SOURCE, 'HARD_RESET_MIN_DOWN_MS') },
      { name: 'HARD_RESET_MIN_GAP_MS', source: sliceConst(SOURCE, 'HARD_RESET_MIN_GAP_MS') },
      { name: 'restart', source: sliceMethod(SOURCE, 'restart') },
    ],
    globals: {
      setTimeout: (fn, ms) => { scheduled.push(ms); return 1; },
      clearTimeout: () => {},
      console: { warn() {}, debug() {}, log() {} },
    },
  });
  return { restart: slices.restart, scheduled };
}

/** `restart()` 会摸到的字段与方法；`connect()` 默认失败（要的就是 catch 分支）。 */
function fakeRelay(overrides = {}) {
  return {
    superseded: false,
    disposed: false,
    restarting: false,
    fastRetryTimer: undefined,
    restartCount: 0,
    lastRestartAt: 0,
    downSince: 0,
    ready: true,
    client: { end() {} },
    parts: { clear() {}, size: 0 },
    onstate() {},
    onpcStale() {},
    onhardreset() {},
    announce() {},
    resendPending() {},
    startStaleWatch() {},
    noteRelayOk() {},
    abortTransport() {},
    connect: async () => { throw new Error('broker 连不上'); },
    ...overrides,
  };
}

test('C8：页面被接管后，重建失败的 catch 不许再排 fastRetryTimer', async () => {
  const { restart, scheduled } = loadRestart();
  const page = fakeRelay();
  // `connect()` 要跑几秒才失败，这期间页面被新标签页接管了（真实的 markSuperseded）。
  page.connect = async () => {
    page.superseded = true;
    throw new Error('broker 连不上');
  };
  const ok = await restart.call(page, '用例：接管后重建失败');
  assert.equal(ok, false);
  assert.deepEqual(scheduled, [], '死页一次 setTimeout 都不该排（旧实现会排，然后自我重建把新页面顶掉）');
  assert.equal(page.fastRetryTimer, undefined, 'fastRetryTimer 不许被装上');
  assert.equal(page.restarting, false, 'finally 必须放开互斥标志，否则这个实例永远重建不了');
});

test('C8：界面收摊（stop/disposed）之后，重建失败的 catch 同样不许排定时器', async () => {
  const { restart, scheduled } = loadRestart();
  const page = fakeRelay();
  page.connect = async () => {
    page.disposed = true; // fatal 页 / 引导重跑：`stop()` 已经把计时器与客户端都收掉了
    throw new Error('broker 连不上');
  };
  const ok = await restart.call(page, '用例：收摊后重建失败');
  assert.equal(ok, false);
  assert.deepEqual(scheduled, [], '收摊的页面不许再排重连');
  assert.equal(page.fastRetryTimer, undefined);
});

test('C8：守卫不许过宽 —— 活着的页面重建失败必须继续排重连（自愈链不能断）', async () => {
  const { restart, scheduled } = loadRestart();
  const page = fakeRelay();
  const ok = await restart.call(page, '用例：普通重建失败');
  assert.equal(ok, false);
  assert.equal(scheduled.length, 1, '活页必须排下一次重连，否则"中继断开，正在重连…"其实没在连');
  // 第 1 次失败 → 1s×2¹ = 2 s 退避，叠 ±20% 抖动（防重连风暴）。
  assert.ok(scheduled[0] >= 1_600 && scheduled[0] <= 2_400, `退避要带抖动（实际 ${scheduled[0]}ms）`);
  assert.notEqual(page.fastRetryTimer, undefined);
  assert.equal(page.downSince > 0, true, '失败时要记下"从什么时候开始断"（硬兜底的判据）');
});
