/**
 * `web/lib/rpc-budget.js`：一次 RPC 的**预算**与**等待文案**。
 *
 * 这一组数字是这次事故的根：外壳按同一 request id 重发的最坏耗时
 * （`Σ backoff + 最后一次 timeout`）**必须明显小于**应用侧的超时。旧值是
 * 24 400 ms vs 20 000 ms —— 先到点的永远是应用层，用户拿到笼统的「请求超时」，
 * 外壳的同 id 重放还没跑完就被取消，net.js 再换一个新 id 从头再来一轮。
 *
 * 这里钉住的是"算得对"和"两个数不越界"，值本身是产品决策（改值可以，改坏关系不行）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DECOMPRESS_TIMEOUT_MS, DETAIL_TIMEOUT_MS, RPC_ATTEMPTS, RPC_BACKOFF_MS, RPC_TIMEOUT_MS, STALL_HINT_AFTER_MS,
  detailFailureText, loadingText, rpcWorstCaseMs, waitText,
} from '../../web/lib/rpc-budget.js';

test('最坏耗时 = Σ backoff + 最后一次 timeout（不是 timeout × attempts）', () => {
  // 每次 attempt 都会 clearTimeout 上一个计时器，只有最后一次拿满 timeout。
  assert.equal(rpcWorstCaseMs(), 1_200 + 2_400 + 3_600 + 8_000);
  assert.equal(rpcWorstCaseMs(), 15_200);
  // 换成旧的那组值，正好是旧的实际预算（16 s 尾巴只算一次）。
  assert.equal(rpcWorstCaseMs({ attempts: 4, timeoutMs: 16_000, backoffMs: [1_200, 2_400, 4_800] }), 24_400);
  // 次数为 1 时只有 timeout 本身。
  assert.equal(rpcWorstCaseMs({ attempts: 1, timeoutMs: 500 }), 500);
  // backoff 缺项时外壳会 fallback 成 2 s，预算不能低估。
  assert.equal(rpcWorstCaseMs({ attempts: 3, timeoutMs: 100, backoffMs: [] }), 4_100);
  // 生产常量本身也要自洽：attempts 与 backoff 长度对得上（少一项就是少一次重发）。
  assert.equal(RPC_BACKOFF_MS.length, RPC_ATTEMPTS - 1);
});

test('预算必须落在应用侧超时之内，且留足余量（两个数不许越界）', () => {
  const budget = rpcWorstCaseMs();
  assert.ok(budget < DETAIL_TIMEOUT_MS,
    `外壳最坏 ${budget}ms 必须小于详情超时 ${DETAIL_TIMEOUT_MS}ms —— 否则先到点的永远是应用层，`
    + '用户看到的是「请求超时」，而不是外壳给出的真实原因');
  assert.ok(DETAIL_TIMEOUT_MS - budget >= 4_000,
    `余量 ${DETAIL_TIMEOUT_MS - budget}ms 太小：外壳判死到应用层放弃之间要留出收尾（读 body/解压）的空间`);
  // 反向也要有下限：预算太短会把"电脑端正在忙"误判成丢包（大响应 + 解压要时间）。
  assert.ok(RPC_TIMEOUT_MS >= 5_000, '最后一次 attempt 的预算至少 5 s，否则慢路由直接被砍');
});

test('C3：详情超时必须盖住「外壳最坏 + 解压上限」，否则 decompress 的原因永远显示不出来', () => {
  // 一条详情最坏能走多远（两段串行，不是并行的）：
  //   ① 外壳按同 id 重放，跑完自己的预算（15 200 ms）才判死 → 带 pocketCode；
  //   ② 回包到了还要解 gzip，这一步自己有 10 000 ms 的截止时刻 → pocketCode=decompress。
  // 应用侧超时必须比两者之和更晚到点，否则用户看到的永远是笼统的「请求超时」，
  // 手机还白跑一段 ≤10 s 的解压（旧值 20 000 < 25 200，实测就是这样）。
  const worstCase = rpcWorstCaseMs() + DECOMPRESS_TIMEOUT_MS;
  assert.equal(worstCase, 15_200 + 10_000);
  assert.ok(DETAIL_TIMEOUT_MS > worstCase,
    `详情超时 ${DETAIL_TIMEOUT_MS}ms 必须大于「外壳最坏 ${rpcWorstCaseMs()}ms + 解压上限 `
    + `${DECOMPRESS_TIMEOUT_MS}ms」= ${worstCase}ms，否则 decompress 这个原因到不了界面`);
  // 但也不许无限放大：多出来的只是收尾余量。
  assert.ok(DETAIL_TIMEOUT_MS - worstCase <= 5_000,
    `余量 ${DETAIL_TIMEOUT_MS - worstCase}ms 太大：用户要为空等买单`);
  // 解压上限本身要有意义（0 会让解压必然失败，比外壳预算还大就失去"截止"的意义）。
  assert.ok(DECOMPRESS_TIMEOUT_MS > 0 && DECOMPRESS_TIMEOUT_MS < rpcWorstCaseMs());
});

test('超过 3 秒才打扰用户，且文案带着"等多久 + 第几次重试"', () => {
  assert.equal(STALL_HINT_AFTER_MS, 3_000);
  assert.equal(waitText({ elapsedMs: 0 }), '');
  assert.equal(waitText({ elapsedMs: 2_999 }), '', '不够久就别打扰，静止的「加载中…」在 3 秒内是合理的');
  assert.equal(waitText({ elapsedMs: 3_000, tries: 1 }), '已等待 3 秒 · 还在等电脑端回包');
  assert.equal(waitText({ elapsedMs: 4_200, tries: 3 }), '已等待 4 秒 · 正在重试第 2 次');
  assert.equal(waitText({ elapsedMs: 15_900, tries: 5 }), '已等待 15 秒 · 正在重试第 4 次');
  // 没有外壳（局域网布局）时 tries 拿不到，不许编造"第 0 次重试"。
  assert.equal(waitText({ elapsedMs: 5_000 }), '已等待 5 秒 · 还在等电脑端回包');
  assert.equal(waitText({ elapsedMs: 5_000, tries: 0 }), '已等待 5 秒 · 还在等电脑端回包');
  // 脏输入不许抛（诊断/计时器路径上的异常会静默打断界面刷新）。
  assert.equal(waitText(), '');
  assert.equal(waitText({ elapsedMs: Number.NaN }), '');
  assert.equal(waitText({ elapsedMs: 9_000, tries: 'x' }), '已等待 9 秒 · 还在等电脑端回包');
});

test('加载占位行：进度文案优先，空的时候退回「加载中…」', () => {
  assert.equal(loadingText({ text: '加载中…' }), '加载中…');
  assert.equal(loadingText({ text: '加载中…', wait: '已等待 4 秒 · 正在重试第 2 次' }), '已等待 4 秒 · 正在重试第 2 次');
  assert.equal(loadingText({ text: '加载中…', wait: '   ' }), '加载中…', '空白进度文案不许把占位行变成空气');
  assert.equal(loadingText({}), '加载中…');
  assert.equal(loadingText(), '加载中…');
  assert.equal(loadingText({ wait: 'x'.repeat(3) }), 'xxx');
});

test('失败文案必须可操作：要么重试，要么返回列表，不能只说"失败了"', () => {
  const text = detailFailureText({ message: '中继请求超时（电脑端已按同一请求重放，回包没送到手机）', code: 'relay_timeout' });
  assert.match(text, /回包没送到手机/u, '外壳给的真实原因要透出来');
  assert.match(text, /重试/u);
  assert.match(text, /返回列表/u);
  assert.match(detailFailureText({ message: 'x' }), /可以点「重试」，或返回列表后再进来/u);
  // 空 message 也要成句，不能出现 "undefined。可以点…"
  assert.equal(detailFailureText({}), '读取会话失败。可以点「重试」，或返回列表后再进来。');
  // 用户自己取消的，别再劝他重试。
  assert.equal(detailFailureText({ message: 'x', code: 'aborted' }), '已取消读取这个会话。');
});
