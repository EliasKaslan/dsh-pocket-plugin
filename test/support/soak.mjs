#!/usr/bin/env node
/**
 * 手工压测（soak）：更长时间 / 更全矩阵的故障注入，输出一张表。
 *
 * ⚠️ **手工运行，禁止改名成 `*.test.mjs`**。
 *    一次完整矩阵要跑几十秒（长黑障场景每个都 ≥ 12 s），放进 `node --test` 的
 *    门禁里会把 CI 拖成"随机超时"，而且它没有硬判据 —— 它的用途是**看分布和长尾**，
 *    门禁的判断在 `test/domain/bench-baseline.test.mjs` 里。
 *
 *   node test/support/soak.mjs                 # 完整矩阵：600 次请求，约 50 s
 *   node test/support/soak.mjs --quick         # 跳过两个长黑障场景，约 30 s（验证脚本本身）
 *   node test/support/soak.mjs --requests=200  # 放大单个场景的请求数
 *   node test/support/soak.mjs --seed=2024     # 换 PRNG 种子（丢帧/黑障时序跟着变）
 *   node test/support/soak.mjs --latency=150   # 单向延迟（默认 300 ms ⇒ RTT 600 ms）
 *
 * 覆盖的故障组合：无故障 / 双向 2%、5% 随机丢帧 / 只打下行 10% / 精确丢分片 /
 * **弱网 + 丢片（唯一能逼出 `nack` 补片通路的组合）** / 短黑障（3 s，靠 RPC 退避
 * 重发自愈）/ 长黑障（8 s，靠 10 s 静默重建自愈）/ 黑障 + 丢帧叠加。
 *
 * 退出码：0 = 跑完且每个场景都达到自己的 `floor`（预期成功率下限）；
 *         1 = 有场景低于 floor（更像"基准本身坏了"或"链路回归"）；2 = 参数错误。
 *
 * 为什么合并场景的 floor 只有 0.75：黑障 5 s 期间前 3 次尝试（0 / 1.2 / 3.6 s）
 * 必然被吞，只剩第 4 次（7.2 s）落在黑障之后，两腿各 10% 丢包 ⇒ 理论成功率 ≈ 81%。
 * 这是真实的"预算没有第五次"边界，不是抖动 —— 写成 floor 而不是让它随机报警。
 */
import {
  DEFAULT_ONE_WAY_MS,
  PAYLOAD_PATHS,
  createBenchEnv,
  formatTable,
  mulberry32,
  runScenario,
  summarize,
} from './bench-harness.mjs';

/** 解析 `--k=v` 形式的参数。 */
function parseArgs(argv) {
  const options = { seed: 2024, latency: DEFAULT_ONE_WAY_MS, requests: 0, quick: false };
  for (const raw of argv) {
    if (raw === '--quick') { options.quick = true; continue; }
    const match = /^--([a-z]+)=(.*)$/u.exec(raw);
    if (match === null) throw new Error(`未知参数：${raw}`);
    const [, key, value] = match;
    if (key === 'seed') options.seed = Number(value);
    else if (key === 'latency') options.latency = Number(value);
    else if (key === 'requests') options.requests = Number(value);
    else throw new Error(`未知参数：--${key}`);
    if (!Number.isFinite(options[key === 'latency' ? 'latency' : 'seed'])) throw new Error(`参数不是数字：${raw}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const scale = options.quick ? 0.5 : 1;
const bulk = options.requests > 0 ? options.requests : 0;

/**
 * 矩阵定义。
 *   - `faults(env, rng)` 在发请求前装故障；
 *   - `requests` 会被 `--requests` 覆盖（给了就全场景统一用它，便于横向比）；
 *   - `floor` 是该场景的**预期成功率下限**（低于它就 exit 1）：无故障类必须 100%，
 *     弱网类按"理论成功率"留一点余量，合并场景按上面注释里的 81% 理论值取 0.75；
 *   - `quickSkip`：`--quick` 跳过（省掉 20 s 的长黑障）。`--quick` 本来只是"验证
 *     脚本本身还能跑"，不是完整矩阵。
 */
const MATRIX = [
  {
    name: '无故障/2KB',
    payload: PAYLOAD_PATHS.small,
    requests: 80,
    concurrency: 40,
    floor: 1,
    faults: null,
  },
  {
    name: '无故障/45KB',
    payload: PAYLOAD_PATHS.detail,
    requests: 60,
    concurrency: 30,
    floor: 1,
    faults: null,
  },
  {
    name: '无故障/58KB·2片',
    payload: PAYLOAD_PATHS.frag,
    requests: 60,
    concurrency: 30,
    floor: 1,
    faults: null,
  },
  {
    name: '丢2%双向/2KB',
    payload: PAYLOAD_PATHS.small,
    requests: 100,
    concurrency: 40,
    floor: 0.98,
    faults: (env) => env.faults.setDropRate({ up: 0.02, down: 0.02 }),
  },
  {
    name: '丢5%双向/2KB',
    payload: PAYLOAD_PATHS.small,
    requests: 120,
    concurrency: 40,
    floor: 0.98,
    faults: (env) => env.faults.setDropRate({ up: 0.05, down: 0.05 }),
  },
  {
    name: '丢10%下行/45KB',
    payload: PAYLOAD_PATHS.detail,
    requests: 60,
    concurrency: 30,
    floor: 0.98,
    faults: (env) => env.faults.setDropRate({ up: 0, down: 0.1 }),
  },
  {
    name: '精确丢片/58KB',
    payload: PAYLOAD_PATHS.frag,
    requests: 60,
    concurrency: 30,
    floor: 1,
    // 每 10 条里丢 1 条响应的第 2 片：命中"分片半包 + 自救"的最长路径。
    faults: (env, rng) => env.faults.partDrop({ seq: 1, total: 2, times: Math.max(1, Math.round(6 * (rng() * 0.5 + 0.75))) }),
  },
  {
    name: '弱网丢片/58KB',
    payload: PAYLOAD_PATHS.frag,
    requests: 40,
    concurrency: 20,
    floor: 0.95,
    // **唯一能逼出 `nack` 补片通路的场景**：只精确丢片时，1.2 s 的同 id 重发总是
    // 先到（桌面命中幂等缓存整份重放），2 s 的 nack 根本轮不上（bench 里
    // `nackRepairs` 恒为 0）。叠加 15% 下行丢帧后重放的两片也可能再丢，半包才会
    // 卡到 2 s ⇒ 手机发 `nack` ⇒ 桌面从分片缓存补片（实测 nackRepairs>0）。
    faults: (env) => {
      env.faults.setDropRate({ up: 0.02, down: 0.15 });
      env.faults.partDrop({ seq: 1, total: 2, times: 3 });
    },
  },
  {
    name: '短黑障3s/2KB',
    payload: PAYLOAD_PATHS.small,
    requests: 20,
    concurrency: 20,
    warm: true,
    floor: 1,
    // 3 s < 10 s 静默阈值：重建不会触发，恢复全靠 RPC 退避重发（1.2/2.4/3.6 s）。
    faults: (env, rng) => env.faults.blackout({ afterMs: 50 + Math.round(rng() * 250), durationMs: 3_000 }),
  },
  {
    name: '长黑障8s/2KB',
    payload: PAYLOAD_PATHS.small,
    requests: 20,
    concurrency: 20,
    warm: true,
    floor: 1,
    quickSkip: true,
    // 8 s 足够长：过了 8 s 之后仍在等在途请求，就会撞上 v1.0.7 那条
    // "请求在途 + 下行静默 10 s ⇒ 重建连接"的自愈（`RPC_STALL_REBUILD_MS`）。
    faults: (env, rng) => env.faults.blackout({ afterMs: 50 + Math.round(rng() * 250), durationMs: 8_000 }),
  },
  {
    name: '黑障5s+丢10%/2KB',
    payload: PAYLOAD_PATHS.small,
    requests: 20,
    concurrency: 20,
    warm: true,
    floor: 0.75,
    quickSkip: true,
    faults: (env, rng) => {
      env.faults.setDropRate({ up: 0.1, down: 0.1 });
      env.faults.blackout({ afterMs: 100 + Math.round(rng() * 300), durationMs: 5_000 });
    },
  },
];

const rows = [];
const startedAt = Date.now();
process.stdout.write(
  `soak：单向 ${options.latency} ms（RTT ≈ ${options.latency * 2} ms），seed=${options.seed}`
  + `${options.quick ? '，--quick' : ''}${bulk > 0 ? `，--requests=${bulk}` : ''}\n\n`,
);

for (const item of MATRIX) {
  if (options.quick && item.quickSkip === true) {
    process.stdout.write(`  - ${item.name.padEnd(16)} 跳过（--quick）\n`);
    continue;
  }
  const requests = bulk > 0 ? bulk : Math.max(4, Math.round(item.requests * scale));
  const concurrency = Math.min(item.concurrency, requests);
  // 每个场景一个独立 env：故障、种子、手机会话都不共享（一个场景跑崩不会污染下一个）。
  const env = await createBenchEnv({ seed: options.seed, latencyMs: options.latency });
  const rng = mulberry32(options.seed + rows.length * 977 + 1);
  try {
    if (item.warm === true) await env.warmPhone();
    const row = await runScenario(env, {
      name: item.name,
      path: item.payload,
      requests,
      concurrency,
      prepare: (target) => {
        if (typeof item.faults === 'function') item.faults(target, rng);
      },
    });
    const report = row.report;
    rows.push({
      ...row,
      scenario: item,
      extra: {
        bridgeCalls: report.bridgeCalls,
        replays: report.link.replays,
        nackRepairs: report.link.nackRepairs,
        rebuilds: report.phone.rebuilds,
        partsLost: report.phone.partsLost,
        drops: report.faults.reasons,
      },
    });
    process.stdout.write(`  ✓ ${item.name.padEnd(16)} n=${row.summary.n} p95=${row.summary.p95}ms max=${row.summary.max}ms\n`);
  } catch (error) {
    rows.push({ name: item.name, summary: summarize([]), error: String(error?.message ?? error), extra: {}, scenario: item });
    process.stdout.write(`  ✗ ${item.name.padEnd(16)} 跑失败：${error?.message ?? error}\n`);
  } finally {
    await env.close();
  }
}

const totalMs = Date.now() - startedAt;
process.stdout.write('\n场景                  n      p50      p95      p99      max       成功率      均重试\n');
process.stdout.write('--------------  -----  -------  -------  -------  -------  --------  -------\n');
process.stdout.write(`${formatTable(rows).split('\n').slice(2).join('\n')}\n`);

process.stdout.write('\n每个场景的链路诊断（丢帧原因 / 自愈动作）：\n');
for (const row of rows) {
  const drops = row.extra?.drops ?? {};
  process.stdout.write(
    `  ${String(row.name).padEnd(16)} 随机丢=${drops['random-drop'] ?? 0} 黑障丢=${drops.blackout ?? 0}`
    + ` 精确丢片=${drops['part-drop'] ?? 0} | 重建=${row.extra?.rebuilds ?? 0}`
    + ` nack补救=${row.extra?.nackRepairs ?? 0} 分片判失=${row.extra?.partsLost ?? 0}`
    + ` 回放=${row.extra?.replays ?? 0} 桥调用=${row.extra?.bridgeCalls ?? 0}`
    + ` 治愈=${row.summary.healed}/${row.summary.n}\n`,
  );
}

const belowFloor = rows.filter((row) => row.summary.n > 0 && row.summary.ok / row.summary.n < (row.scenario?.floor ?? 1));
const clean = rows.filter((row) => row.summary.n > 0);
const totalRequests = clean.reduce((sum, row) => sum + row.summary.n, 0);
const totalOk = clean.reduce((sum, row) => sum + row.summary.ok, 0);
const worst = clean
  .filter((row) => row.summary.n > 0)
  .sort((left, right) => right.summary.p95 - left.summary.p95)[0];

process.stdout.write(
  `\n合计 ${totalRequests} 次请求，成功 ${totalOk}（${((totalOk / Math.max(1, totalRequests)) * 100).toFixed(2)}%），`
  + `墙钟 ${(totalMs / 1000).toFixed(1)} s。最慢的场景：${worst?.name ?? '-'}（p95 ${worst?.summary.p95 ?? 0} ms）。\n`,
);

if (belowFloor.length > 0) {
  process.stdout.write(`\n⚠️  成功率低于各自 floor 的场景：\n`);
  for (const row of belowFloor) {
    const rate = row.summary.ok / row.summary.n;
    process.stdout.write(
      `  ${row.name}：${(rate * 100).toFixed(1)}% < floor ${((row.scenario?.floor ?? 1) * 100).toFixed(0)}%`
      + `；失败样本 ${JSON.stringify(row.summary.failed.slice(0, 3))}\n`,
    );
  }
  process.exit(1);
}
process.stdout.write('每个场景都达到了自己的 floor（成功率下限）。\n');
process.exit(0);
