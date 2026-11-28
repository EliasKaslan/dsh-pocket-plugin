/**
 * DSH Pocket — Cordis plugin entry.
 *
 * Mounts a loopback-only HTTP/WebSocket listener beside the DSH host, pairs phones with a
 * one-time code, mirrors the host's Session list as "tasks", and dispatches new
 * tasks through the same agent services the desktop UI uses. Cross-network
 * access is an outbound-only encrypted relay: nothing here listens on the WAN.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Auth } from './auth.mjs';
import { CloudService } from './cloud-service.mjs';
import { BridgeCore, resolvePaths } from './core.mjs';
import { BridgeServer } from './server.mjs';
import { ensureDir, FileLogger, isPlainObject, PLUGIN_VERSION } from './util.mjs';

/**
 * 构建标记：**只在本模块首次求值**时生成一次。
 *
 * 为什么需要它：`bootId` 每次 apply 都会变（新的 BridgeCore 而已），所以
 * 「关掉再打开插件」之后 bootId 变了**并不能**证明新代码生效 —— 宿主把
 * 模块从 ESM 缓存里取出来再 apply 一次，bootId 同样会变。
 *
 * Node 的 ESM 缓存按 URL 命中，模块顶层代码只跑一次；只有宿主真的把该 URL
 * 从缓存里摘掉（dsh-hmr 的 evict）并重新 import，下面三个常量才会重新求值。
 * 因此 `health.build.evalId` / `evalAt` 是本进程内判断「新代码到底跑没跑」
 * 的唯一硬标记：
 *   - evalId 变了 → 模块被重新求值 = 新的 lib/** 已在跑；
 *   - evalId 没变、bootId 变了 → 只是又 apply 了一遍旧模块，代码没换。
 *
 * `processStartedAt` 是 DSH/host 进程启动时刻（同一进程内恒定），与
 * `evalAt` 一起就能看出「模块比进程晚求值了多少」。
 */
const BUILD_EVAL_ID = randomBytes(4).toString('hex');
const BUILD_EVAL_AT = new Date().toISOString();
const BUILD_PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

export const build = Object.freeze({
  version: PLUGIN_VERSION,
  evalId: BUILD_EVAL_ID,
  evalAt: BUILD_EVAL_AT,
  processStartedAt: BUILD_PROCESS_STARTED_AT,
  pid: process.pid,
});

// 必须与 package.json 的 "name"、cordis.patch.yml 里的 `name` 完全一致：
// 宿主按包名从 profile 的 node_modules 解析插件，导出名与它对不上时日志、
// 去重和补丁回滚都会指向错误的身份。
export const name = 'dsh-pocket-plugin';
export const inject = [];

export function apply(ctx, config) {
  const raw = isPlainObject(config) ? config : {};
  const paths = resolvePaths(raw);
  try {
    ensureDir(paths.dataDir);
  } catch (error) {
    // Without a writable data dir there is no state file, no pairing and no
    // log; refuse loudly instead of running with half a configuration.
    console.error('[dsh-pocket] 数据目录不可用：', paths.dataDir, error);
    return;
  }

  const logger = new FileLogger(path.join(paths.dataDir, 'bridge.log'), { maxBytes: 2 * 1024 * 1024 });
  logger.info(`plugin loading; data=${paths.dataDir} pid=${process.pid} node=${process.versions.node}`);
  // 每次 apply 都打这一行。同一进程内 evalId 不变 = 还是那份旧模块（ESM 缓存
  // 命中）；evalId 变了 = 模块真的被重新求值过，lib/** 的改动已经生效。
  logger.info(`build v${build.version} eval=${build.evalId} evalAt=${build.evalAt} processStartedAt=${build.processStartedAt}（evalId 变了才代表模块被重新求值）`);

  let core;
  let server;
  let cloud;
  try {
    core = new BridgeCore(ctx, raw, logger, build);
    // 每次 apply 换一个 bootId：在 DSH 里把本插件关掉再打开即可热重载，
    // 用 `health` 的 bootId 就能确认"确实换了一份新实例"。注意 bootId 只证明
    // 换了实例、不证明换了代码 —— 后者看 build.evalId。
    logger.info(`桥接实例已创建 boot=${core.bootId}（关掉再打开本插件即可重载实例；换没换代码看 health.build.evalId）`);
    server = new BridgeServer(core, {
      logger,
      webRoot: path.join(import.meta.dirname, '..', 'web'),
      downloadDirs: [
        path.join(paths.dataDir, 'downloads'),
        path.join(import.meta.dirname, '..', 'downloads'),
      ],
    });

    const auth = new Auth({
      credentialsFile: path.join(paths.dataDir, 'auth.json'),
      sessionsFile: path.join(paths.dataDir, 'sessions.json'),
      logger,
      required: core.config.authRequired === true,
    });
    if (auth.configured && !auth.required) {
      logger.warn('已存在 auth.json，但配置里 auth.required=false，中继将按无口令模式处理');
    }
    // HTTP 层（配对页上的「账号与口令」卡片）拿不到这个实例就没法读账号、
    // 改口令、reload，所以显式交给 core；不这么做 server.mjs 只能再 new 一个，
    // 那会出现两份互不同步的凭据状态。
    core.attachAuth(auth);

    cloud = new CloudService(core, {
      logger,
      dataDir: paths.dataDir,
      config: raw.cloud,
      auth,
      authRequired: core.config.authRequired === true,
    });
  } catch (error) {
    logger.error('plugin init failed', error?.stack ?? error);
    try { server?.close(); } catch { /* not opened */ }
    try { core?.dispose(); } catch { /* not opened */ }
    return;
  }

  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    logger.info('plugin disposing');
    try { cloud.stop(); } catch (error) { logger.warn('cloud stop failed', error); }
    try { server.close(); } catch (error) { logger.warn('server close failed', error); }
    try { core.dispose(); } catch (error) { logger.warn('core dispose failed', error); }
  };
  ctx.effect(() => dispose, 'pocket.lifecycle');

  const start = () => {
    if (closed || core.started || core.startPromise !== undefined) return;
    core.start().catch((error) => {
      logger.error('bridge start failed', error);
    });
  };

  // Each service is bound independently: a composition without one of them
  // should still expose the rest instead of silently never applying the plugin.
  const bind = (serviceName, key = serviceName) => {
    ctx.inject([serviceName], (child) => {
      const service = child[key];
      if (service === undefined) return;
      core.bindService(key, service);
      logger.info(`service bound: ${key}`);
      child.effect(() => () => {
        if (core.services[key] === service) delete core.services[key];
      }, `pocket.service(${key})`);
      if (key === 'sessionQuery' && !core.started) start();
    });
  };

  bind('sessionQuery');
  bind('agents');
  bind('sessions');
  // `ask_user_question` 的答卷通道。老版本 DSH 没有这个服务时会自然不绑定，
  // core.services.userQuestions 保持 undefined —— HTTP 层据此走 501 unsupported。
  bind('userQuestions');
  bind('agentPresets');
  bind('agentDefaultModel');
  bind('workspaceRegistry');
  bind('sessionPersistence');

  // The HTTP listener should come up even when one optional service is absent;
  // four seconds is enough for the normal composition and still leaves the
  // pairing page reachable on a partial one.
  const fallback = setTimeout(() => {
    if (!core.started) {
      logger.warn('starting bridge without all services');
      start();
    }
  }, 4000);
  fallback.unref?.();

  ctx.effect(() => () => clearTimeout(fallback), 'pocket.start-timer');

  const onCreated = (session) => {
    try { core.index.handleSessionCreated(session); } catch (error) { logger.warn('session/created handler failed', error); }
  };
  const onEvent = (session, event) => {
    try { core.index.handleEvent(session, event); } catch (error) { logger.warn('session/event handler failed', error); }
  };
  const onDisposed = (session) => {
    try { core.index.handleSessionDisposed(session); } catch (error) { logger.warn('session/disposed handler failed', error); }
  };
  ctx.effect(() => ctx.on('session/created', onCreated, { global: true }), 'pocket.on-created');
  ctx.effect(() => ctx.on('session/event', onEvent, { global: true }), 'pocket.on-event');
  ctx.effect(() => ctx.on('session/disposed', onDisposed, { global: true }), 'pocket.on-disposed');

  // The relay needs the real listening port, so it starts from the status
  // event (the port may be 47901+n after a conflict) rather than from config.
  core.subscribe((frame) => {
    if (closed || frame.type !== 'bridge.status') return;
    const payload = frame.payload ?? {};
    if (payload.started !== true || !(payload.port > 0)) return;
    logger.info(`pairing page: http://127.0.0.1:${payload.port}/pair · 二维码文件 ${core.qrWriter.enabled ? core.qrWriter.file : '（已关闭，仅页面可见）'}`);
    try {
      cloud.start(payload.port);
    } catch (error) {
      logger.error('cloud relay start failed', error);
    }
    // 链接是 cloud.start 之后才有的，所以这里补写一次，别等下一轮轮询。
    try { core.syncQrFile(); } catch (error) { logger.warn('二维码文件同步失败', error); }
  });

  // 二维码文件跟着中继链接走。中继没有对外发状态事件，而链接会在重连、
  // 身份轮换、切换 broker 之后变化，所以做一次很轻的轮询：只读
  // `cloud.status().url`，链接没变 QrFileWriter 直接跳过，不写盘。
  const qrTimer = setInterval(() => {
    if (closed) return;
    try { core.syncQrFile(); } catch (error) { logger.warn('二维码文件同步失败', error); }
  }, 5000);
  qrTimer.unref?.();
  ctx.effect(() => () => clearInterval(qrTimer), 'pocket.qr-file-timer');

  // Cover a listener that was already up before the subscription existed.
  if (core.started && core.port > 0) {
    try { cloud.start(core.port); } catch (error) { logger.error('cloud relay start failed', error); }
  }
}
