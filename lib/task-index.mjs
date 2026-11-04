/**
 * The plugin's live task index.
 *
 * "Task" is DSH's logical Session: a top-level user session or a delegated
 * subagent session. The index is built from `sessionQuery.listSessions()` and
 * then kept current from the host's `session/*` events. Session logs are only
 * tail-read for cold sessions; no log is ever appended to.
 *
 * Host-service call shapes (`sessionQuery`, `agents`, `agentPresets`,
 * `agentDefaultModel`, `workspaceRegistry`, `sessions`) intentionally mirror the
 * DSH host API and must not be "improved" without checking the host source.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildTranscript, contentText, isHumanPrompt, normalizeEvent, reasonText } from './messages.mjs';
import { lastOfType, readTailEvents, scanSessionFiles } from './session-files.mjs';
import { oneLine } from './util.mjs';

const STATUS_RANK = { running: 0, error: 1, cancelled: 2, done: 3, idle: 4 };
const KNOWN_STATUS = new Set(Object.keys(STATUS_RANK));
const MAX_TASKS = 5000;
const TAIL_LIMIT = 400;
const MAX_DETAIL_CACHE = 20;
const MAX_CLIENT_IDS = 500;
const DETAIL_CACHE_TTL_MS = 20_000;

/** Placeholder stored in `byClientId` while a create is in flight. */
const PENDING = Symbol('pending-create');

function statusFromReason(reason) {
  const kind = reason !== null && typeof reason === 'object' ? reason.kind : undefined;
  if (kind === 'completed' || kind === 'forked') return 'done';
  if (kind === 'aborted' || kind === 'interrupted') return 'cancelled';
  if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens') return 'error';
  return 'idle';
}

function headerParent(header) {
  return header?.parentSession ?? header?.parentSessionId ?? header?.parent?.id;
}

function headerOrigin(header) {
  if (typeof header?.origin === 'string') return header.origin;
  if (headerParent(header) !== undefined) return 'subagent';
  return 'user';
}

function cwdName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '';
  const normalized = cwd.replace(/[\\/]+$/u, '');
  const base = normalized.split(/[\\/]/u).pop() ?? normalized;
  return base.length > 0 ? base : normalized;
}

function pathKey(value) {
  const normalized = String(value).replace(/[\\/]+/gu, path.sep).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Containment test based on `path.relative`, not on string prefixes. Handles
 * junctions/symlinks because callers pass already-realpath'ed values, and
 * `path.win32.relative` compares case-insensitively so `C:\A` covers `c:\a\b`.
 */
function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class TaskIndex {
  constructor({ logger, emit, state, config, services, home, dataDir }) {
    this.logger = logger;
    this.emit = emit;
    this.state = state;
    this.config = config;
    this.services = services;
    this.home = home;
    this.dataDir = dataDir ?? '';
    this.tasks = new Map();
    this.byClientId = new Map();
    this.loading = false;
    this.loadedAt = 0;
    this.loadError = undefined;
    this.loadPromise = undefined;
    this.pendingUpdates = new Map();
    this.summaryTimer = undefined;
    this.detailCache = new Map();
    this.agentLocks = new Map();
    this.maxTasksWarned = false;
  }

  setServices(services) {
    this.services = services;
  }

  get ready() {
    return this.services.sessionQuery !== undefined && this.services.agents !== undefined;
  }

  start() {
    if (this.loadPromise !== undefined) return this.loadPromise;
    const promise = this.load().catch((error) => {
      this.loadError = String(error?.message ?? error);
      this.logger.error('task index load failed', error);
      this.loading = false;
      this.emit('bridge.status', { ready: this.ready, loading: false, error: this.loadError, tasks: this.tasks.size });
    }).finally(() => {
      // Allow a later attempt: host services may arrive after the first try.
      if (this.loadError !== undefined) this.loadPromise = undefined;
    });
    this.loadPromise = promise;
    return promise;
  }

  async load() {
    this.loading = true;
    const started = Date.now();
    try {
      const sessionQuery = this.services.sessionQuery;
      if (sessionQuery === undefined) throw new Error('sessionQuery service is not available');
      const rows = await sessionQuery.listSessions();
      const files = scanSessionFiles(this.home);
      for (const row of rows) {
        // 宿主返回一行 null/undefined 不该把整个索引带下去：那个 TypeError 会抛在
        // `loading = false` 之前，索引从此永久卡在 loading，跟广播出去的
        // bridge.status.loading:false 自相矛盾，而且再也不会重试。
        if (row === null || typeof row !== 'object') continue;
        this.upsertRow(row, files.get(row.header?.id));
      }
      // Parent/child links must be rebuilt after every row exists: the host does
      // not promise parent-before-child ordering.
      this.rebuildChildren();
      this.loadedAt = Date.now();
      this.loadError = undefined;
      this.logger.info(`task index loaded ${this.tasks.size} sessions from ${rows.length} rows in ${Date.now() - started}ms`);
      this.emit('tasks.changed', { reason: 'loaded', count: this.tasks.size });
      this.emitSummary();
    } finally {
      // 无论成功还是抛错都要放开这个闸，理由同上。
      this.loading = false;
    }

    const ids = [...this.tasks.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((task) => task.id);
    // Titles are cheap enough to fill in the background; tails are bounded so a
    // huge historical corpus cannot stall the host at startup.
    void this.loadTitles(ids);
    void this.loadTails(ids.slice(0, TAIL_LIMIT));
    return this.tasks.size;
  }

  rebuildChildren() {
    for (const task of this.tasks.values()) task.children = [];
    for (const task of this.tasks.values()) {
      if (!task.isSubagent || task.parentId === undefined) continue;
      const parent = this.tasks.get(task.parentId);
      if (parent !== undefined && !parent.children.includes(task.id)) parent.children.push(task.id);
    }
  }

  upsertRow(row, file) {
    const header = row?.header;
    if (header === null || typeof header !== 'object' || typeof header.id !== 'string') return undefined;
    if (header.isSeeded === true && this.config.showSeeded !== true) return undefined;
    if (this.tasks.size >= MAX_TASKS && !this.tasks.has(header.id)) {
      if (!this.maxTasksWarned) {
        this.maxTasksWarned = true;
        this.logger.warn(`task index is full (${MAX_TASKS}); newer sessions will not be listed`);
      }
      return undefined;
    }
    const existing = this.tasks.get(header.id);
    const parentId = headerParent(header);
    const origin = headerOrigin(header);
    const isSubagent = origin === 'subagent' || parentId !== undefined;
    const createdAt = typeof header.createdAt === 'number' ? header.createdAt : Date.now();
    const task = existing ?? {
      id: header.id,
      title: '',
      titleSource: 'none',
      status: 'idle',
      statusReason: '',
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      cwdName: cwdName(header.cwd),
      createdAt,
      updatedAt: createdAt,
      turn: 0,
      model: undefined,
      preset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
      origin,
      parentId,
      isSubagent,
      live: false,
      persisted: false,
      blank: true,
      messageCount: 0,
      toolCount: 0,
      lastText: '',
      lastRole: '',
      children: [],
    };
    task.live = row.live === true || this.services.agents?.get?.(header.id) !== undefined;
    task.persisted = row.persisted === true;
    if (task.live) {
      const status = this.services.agents?.get?.(header.id)?.status;
      if (status === 'running') task.status = 'running';
    }
    if (file !== undefined) {
      task.updatedAt = Math.max(task.updatedAt, file.mtimeMs);
      task.file = file.file;
      task.fileMtime = file.mtimeMs;
    }
    this.tasks.set(task.id, task);
    if (task.isSubagent && task.parentId !== undefined) {
      const parent = this.tasks.get(task.parentId);
      if (parent !== undefined && !parent.children.includes(task.id)) parent.children.push(task.id);
    }
    return task;
  }

  async loadTitles(ids) {
    const sessionQuery = this.services.sessionQuery;
    if (sessionQuery === undefined) return;
    const chunkSize = 80;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      try {
        const results = await sessionQuery.readTitleSnapshots(chunk);
        let changed = 0;
        for (const result of results) {
          if (result?.status !== 'fulfilled') continue;
          const value = result.value;
          const id = value?.session?.id;
          const title = value?.title?.title ?? value?.title;
          if (typeof id !== 'string' || typeof title !== 'string' || title.trim().length === 0) continue;
          const task = this.tasks.get(id);
          if (task === undefined) continue;
          if (task.titleSource !== 'provider' || task.title !== title.trim()) {
            task.title = title.trim();
            task.titleSource = 'provider';
            task.blank = false;
            changed += 1;
          }
        }
        if (changed > 0) this.emit('tasks.changed', { reason: 'titles', count: changed });
      } catch (error) {
        this.logger.warn('title projection failed', error);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.emitSummary();
  }

  async loadTails(ids) {
    const concurrency = 6;
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        const id = ids[index];
        const task = this.tasks.get(id);
        if (task === undefined || task.live || task.file === undefined) continue;
        try {
          await this.applyTail(task);
        } catch (error) {
          this.logger.warn('tail read failed', id, error);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    this.emit('tasks.changed', { reason: 'tails', count: ids.length });
    this.emitSummary();
  }

  async applyTail(task) {
    if (task.fileMtime !== undefined && task.tailMtime === task.fileMtime) return;
    const events = await readTailEvents(task.file);
    if (events === undefined || events.length === 0) return;
    task.tailMtime = task.fileMtime;
    task.tailEvents = events;
    const title = lastOfType(events, 'session/title')?.data?.title;
    if (typeof title === 'string' && title.trim().length > 0 && task.titleSource !== 'provider') {
      task.title = title.trim();
      task.titleSource = 'provider';
      task.blank = false;
    }
    const descriptor = lastOfType(events, 'subagent/descriptor')?.data;
    if (task.title.length === 0 && typeof descriptor?.label === 'string') {
      task.title = descriptor.label;
      task.titleSource = 'descriptor';
      task.blank = false;
    }
    const end = lastOfType(events, 'turn/end');
    if (end !== undefined) {
      task.turn = typeof end?.data?.turn === 'number' ? end.data.turn : task.turn;
      task.status = statusFromReason(end?.data?.reason);
      task.statusReason = reasonText(end?.data?.reason);
    }
    const header = lastOfType(events, 'request/header')?.data?.header?.config;
    if (header !== null && typeof header === 'object' && typeof header.model === 'string') {
      task.model = { provider: header.provider ?? '', model: header.model };
    }
    let lastAssistant;
    let lastUser;
    let toolCount = 0;
    let messageCount = 0;
    for (const event of events) {
      if (event?.type === 'assistant/message') {
        lastAssistant = event;
        messageCount += 1;
      } else if (event?.type === 'user/message' && isHumanPrompt(event)) {
        lastUser = event;
        messageCount += 1;
      } else if (event?.type === 'tool/call') toolCount += 1;
    }
    if (lastAssistant !== undefined) {
      const message = lastAssistant?.data?.message;
      const text = contentText(message?.content);
      const source = message?.source;
      if (text.length > 0) {
        task.lastText = oneLine(text, 220);
        task.lastRole = 'assistant';
        task.blank = false;
      }
      if (source !== null && typeof source === 'object' && typeof source.model === 'string') {
        task.model = { provider: source.provider ?? '', model: source.model };
      }
      if (typeof lastAssistant.time === 'number') task.updatedAt = Math.max(task.updatedAt, lastAssistant.time);
    }
    if (task.lastText.length === 0 && lastUser !== undefined) {
      const text = contentText(lastUser?.data?.content);
      if (text.length > 0) {
        task.lastText = oneLine(text, 220);
        task.lastRole = 'user';
        task.blank = false;
      }
    }
    // Counts are exact only for the tail window; label them as recent.
    task.messageCount = Math.max(task.messageCount, messageCount);
    task.toolCount = Math.max(task.toolCount, toolCount);
    if (task.title.length === 0 && lastUser !== undefined) {
      const text = contentText(lastUser?.data?.content);
      if (text.length > 0) {
        task.title = oneLine(text, 42);
        task.titleSource = 'derived';
        task.blank = false;
      }
    }
    if (task.title.length === 0) {
      task.title = `未命名任务 · ${new Date(task.createdAt).toLocaleDateString('zh-CN')}`;
      task.titleSource = 'derived';
    }
  }

  handleSessionCreated(session) {
    const header = session?.header;
    if (header === null || typeof header !== 'object') return;
    const task = this.upsertRow({ header, live: true, persisted: true });
    if (task === undefined) return;
    task.live = true;
    this.emit('task.created', this.publicTask(task));
    this.emitSummary();
  }

  handleSessionDisposed(session) {
    const id = session?.id ?? session?.header?.id;
    const task = this.tasks.get(id);
    if (task === undefined) return;
    task.live = false;
    this.scheduleUpdate(task);
  }

  handleEvent(session, event) {
    const id = session?.id ?? session?.header?.id;
    if (typeof id !== 'string' || event === null || typeof event !== 'object') return;
    let task = this.tasks.get(id);
    if (task === undefined) {
      task = this.upsertRow({ header: session.header, live: true, persisted: true });
      if (task === undefined) return;
    }
    task.live = true;
    task.updatedAt = typeof event.time === 'number' ? Math.max(task.updatedAt, event.time) : Date.now();
    switch (event.type) {
      case 'turn/start':
        task.status = 'running';
        task.statusReason = '';
        if (typeof event?.data?.turn === 'number') task.turn = event.data.turn;
        break;
      case 'turn/end':
        task.status = statusFromReason(event?.data?.reason);
        task.statusReason = reasonText(event?.data?.reason);
        if (typeof event?.data?.turn === 'number') task.turn = event.data.turn;
        break;
      case 'session/title': {
        const title = event?.data?.title;
        if (typeof title === 'string' && title.trim().length > 0) {
          task.title = title.trim();
          task.titleSource = 'provider';
          task.blank = false;
        }
        break;
      }
      case 'assistant/message': {
        task.messageCount += 1;
        const message = event?.data?.message;
        const text = contentText(message?.content);
        const source = message?.source;
        if (text.length > 0) {
          task.lastText = oneLine(text, 220);
          task.lastRole = 'assistant';
          task.blank = false;
        }
        if (source !== null && typeof source === 'object' && typeof source.model === 'string') {
          task.model = { provider: source.provider ?? '', model: source.model };
        }
        break;
      }
      case 'user/message':
        if (isHumanPrompt(event)) {
          task.messageCount += 1;
          const text = contentText(event?.data?.content);
          if (text.length > 0) {
            task.lastText = oneLine(text, 220);
            task.lastRole = 'user';
            task.blank = false;
            if (task.title.length === 0) {
              task.title = oneLine(text, 42);
              task.titleSource = 'derived';
            }
          }
        }
        break;
      case 'tool/call':
        task.toolCount += 1;
        break;
      case 'session/error':
      case 'error':
        task.status = 'error';
        task.statusReason = oneLine(event?.data?.error?.message ?? event?.data?.message ?? '执行出错', 200);
        break;
      default:
        break;
    }
    const message = normalizeEvent(event);
    if (message !== undefined) {
      this.emit('task.message', { taskId: id, message });
    }
    this.scheduleUpdate(task);
  }

  scheduleUpdate(task) {
    if (this.pendingUpdates.has(task.id)) return;
    const timer = setTimeout(() => {
      this.pendingUpdates.delete(task.id);
      this.emit('task.updated', this.publicTask(task));
      this.emitSummary();
    }, 120);
    timer.unref?.();
    this.pendingUpdates.set(task.id, timer);
  }

  publicTask(task) {
    return {
      id: task.id,
      title: task.title || '未命名任务',
      status: task.status,
      statusReason: task.statusReason,
      cwd: task.cwd,
      cwdName: task.cwdName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      turn: task.turn,
      model: task.model,
      preset: task.preset,
      origin: task.origin,
      parentId: task.parentId,
      isSubagent: task.isSubagent,
      live: task.live,
      blank: task.blank,
      messageCount: task.messageCount,
      toolCount: task.toolCount,
      lastText: task.lastText,
      lastRole: task.lastRole,
      titleSource: task.titleSource,
      childCount: task.children.length,
    };
  }

  snapshot({ filter = 'all', q = '', includeSubagents = false, limit = 300, offset = 0 } = {}) {
    const query = typeof q === 'string' ? q.trim().toLowerCase() : '';
    let rows = [...this.tasks.values()];
    if (!includeSubagents) rows = rows.filter((task) => !task.isSubagent);
    if (filter === 'running') rows = rows.filter((task) => task.status === 'running');
    else if (filter === 'done') rows = rows.filter((task) => task.status === 'done' || task.status === 'idle' || task.status === 'cancelled');
    else if (filter === 'error') rows = rows.filter((task) => task.status === 'error');
    else if (filter === 'cancelled') rows = rows.filter((task) => task.status === 'cancelled');
    else if (filter === 'idle') rows = rows.filter((task) => task.status === 'idle');
    if (query.length > 0) {
      rows = rows.filter((task) => `${task.title}\n${task.cwd}\n${task.lastText}`.toLowerCase().includes(query));
    }
    rows.sort((left, right) => {
      const rank = (STATUS_RANK[left.status] ?? 9) - (STATUS_RANK[right.status] ?? 9);
      if (rank !== 0) return rank;
      return right.updatedAt - left.updatedAt;
    });
    const total = rows.length;
    const numericLimit = Number(limit);
    const pageSize = Number.isFinite(numericLimit) && numericLimit > 0
      ? Math.min(500, Math.floor(numericLimit))
      : 300;
    const numericOffset = Number(offset);
    const from = Number.isFinite(numericOffset) && numericOffset > 0 ? Math.floor(numericOffset) : 0;
    const page = rows.slice(from, from + pageSize).map((task) => this.publicTask(task));
    return {
      tasks: page,
      total,
      offset: from,
      limit: pageSize,
      hasMore: from + page.length < total,
      loading: this.loading,
      loadedAt: this.loadedAt,
      error: this.loadError,
    };
  }

  summary() {
    const rows = [...this.tasks.values()].filter((task) => !task.isSubagent);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const counts = { total: rows.length, running: 0, done: 0, error: 0, idle: 0, cancelled: 0, today: 0, subagents: 0 };
    for (const task of rows) {
      if (KNOWN_STATUS.has(task.status)) counts[task.status] += 1;
      if (task.updatedAt >= midnight.getTime()) counts.today += 1;
      counts.subagents += task.children.length;
    }
    counts.loading = this.loading;
    counts.updatedAt = Date.now();
    return counts;
  }

  emitSummary() {
    if (this.summaryTimer !== undefined) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = undefined;
      this.emit('summary', this.summary());
    }, 400);
    this.summaryTimer.unref?.();
  }

  getTask(id) {
    return this.tasks.get(id);
  }

  async detail(id) {
    const task = this.tasks.get(id);
    if (task === undefined) throw codedError('not_found', 'task not found');
    let messages;
    let capturedThroughSeq;
    let degraded = false;
    const cached = this.detailCache.get(id);
    // A running turn changes with every event; caching its surface makes the
    // phone look frozen. Cache only settled transcripts.
    if (cached !== undefined && task.status !== 'running' && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) {
      messages = cached.messages;
      capturedThroughSeq = cached.capturedThroughSeq;
      degraded = cached.degraded === true;
    } else {
      let events;
      if (task.live) {
        const session = this.services.sessions?.get?.(id);
        if (Array.isArray(session?.log)) events = session.log;
      }
      if (events === undefined) {
        try {
          const surface = await this.services.sessionQuery.readSurface(id);
          events = surface.events;
          capturedThroughSeq = surface.capturedThroughSeq;
        } catch (error) {
          // Strict corpus validation can reject a session the host is still
          // able to run (older logs, hand-made messages). Fall back to the tail
          // reader instead of showing a dead end on the phone.
          if (task.file !== undefined) {
            events = (await readTailEvents(task.file)) ?? [];
            degraded = true;
          } else {
            throw error;
          }
        }
      }
      messages = buildTranscript(events, { max: 400 });
      this.detailCache.set(id, { at: Date.now(), messages, capturedThroughSeq, degraded });
      if (this.detailCache.size > MAX_DETAIL_CACHE) {
        const oldest = [...this.detailCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest !== undefined) this.detailCache.delete(oldest[0]);
      }
    }
    const children = task.children
      .map((childId) => this.tasks.get(childId))
      .filter((child) => child !== undefined)
      .map((child) => this.publicTask(child));
    return {
      task: this.publicTask(task),
      messages,
      capturedThroughSeq: capturedThroughSeq ?? null,
      children,
      degraded,
    };
  }

  /** Map a cold task to a live agent before sending a follow-up. */
  async ensureAgent(id, { createIfMissing = false } = {}) {
    const agents = this.services.agents;
    if (agents === undefined) throw codedError('no_agent', 'agent service unavailable');
    const live = agents.get(id);
    if (live !== undefined) return live;
    if (!createIfMissing) throw codedError('not_running', '任务当前未运行，无法发送消息');
    const pending = this.agentLocks.get(id);
    if (pending !== undefined) return pending;
    const promise = this.resumeAgent(id, agents).finally(() => {
      if (this.agentLocks.get(id) === promise) this.agentLocks.delete(id);
    });
    this.agentLocks.set(id, promise);
    return promise;
  }

  async resumeAgent(id, agents) {
    const task = this.tasks.get(id);
    if (task === undefined) throw codedError('not_found', 'task not found');
    if (task.isSubagent) throw codedError('subagent_immutable', '子代理任务不能直接续聊');
    const agentOptions = this.defaultAgentOptions();
    const setup = await this.presetSetup(task.preset);
    const handle = await agents.resume({
      resumeSessionId: id,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(setup === undefined ? {} : { setup }),
    });
    return handle.agent;
  }

  defaultAgentOptions() {
    try {
      const service = this.services.agentDefaultModel;
      const selection = service?.currentSelection?.() ?? service?.current?.();
      if (selection !== null && typeof selection === 'object'
        && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return selection;
      }
    } catch (error) {
      this.logger.warn('default model selection failed', error);
    }
    return undefined;
  }

  async presetSetup(presetId) {
    const presets = this.services.agentPresets;
    if (presets === undefined) return undefined;
    let wanted = presetId;
    try {
      if (wanted === undefined) {
        const rows = await presets.list();
        if (rows.length === 0) return undefined;
        wanted = presets.defaultId ?? rows[0].id;
      }
      const resolved = await presets.resolve(wanted);
      if (resolved?.broken !== undefined) {
        const error = new Error(`agent preset "${wanted}" is unavailable: ${String(resolved.broken)}`);
        error.code = 'preset_broken';
        throw error;
      }
      return async (agentCtx) => { await presets.mount(agentCtx, resolved.id); };
    } catch (error) {
      if (error?.code === 'preset_broken') throw error;
      this.logger.warn('preset resolution failed', error);
      return undefined;
    }
  }

  /**
   * Allowed working directories.
   *
   * `config.allowedRoots` is authoritative when set. Otherwise the roots the
   * user actually opened in the DSH UI (workspaceRegistry) plus the plugin data
   * directory are allowed. When that derived set is empty nothing is allowed —
   * an empty list must never mean "anywhere".
   */
  computeAllowedRoots() {
    const explicit = Array.isArray(this.config.allowedRoots)
      ? this.config.allowedRoots.filter((root) => typeof root === 'string' && root.trim().length > 0)
      : [];
    if (explicit.length > 0) {
      return { mode: 'config', roots: [...new Set(explicit.map((root) => path.resolve(root.trim())))] };
    }
    const derived = [];
    const registry = this.services.workspaceRegistry;
    if (registry !== undefined) {
      try {
        const rows = registry.list();
        for (const row of Array.isArray(rows) ? rows : []) {
          if (typeof row?.path === 'string' && row.path.length > 0) derived.push(path.resolve(row.path));
        }
      } catch (error) {
        this.logger.warn('workspace list failed while resolving allowed roots', error);
      }
    }
    // The plugin's own data dir is deliberately *not* a derived root: a task
    // workdir inside the session store is never what the user meant, and
    // including it would make the fail-closed "no roots" mode unreachable.
    const roots = [...new Set(derived)];
    if (roots.length === 0) return { mode: 'closed', roots: [] };
    return { mode: 'derived', roots };
  }

  /** Safe-for-status summary: never leak absolute paths to the LAN. */
  allowedRootsStatus() {
    const roots = this.computeAllowedRoots();
    return { mode: roots.mode, count: roots.roots.length };
  }

  async resolveWorkdir(cwd) {
    const explicit = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : '';
    const roots = this.computeAllowedRoots();
    if (roots.roots.length === 0) {
      throw codedError('cwd_forbidden', '尚未允许任何工作目录：请先在 DSH 中打开一个工作区，或在插件配置里填写 allowedRoots');
    }
    const wanted = explicit.length > 0 ? explicit : roots.roots[0];
    if (wanted.includes('\0')) throw codedError('bad_cwd', '工作目录不合法');
    if (!path.isAbsolute(wanted)) throw codedError('bad_cwd', '工作目录必须是绝对路径');
    if (/^\\\\/u.test(wanted) || /^\/\//u.test(wanted)) {
      throw codedError('bad_cwd', '不支持网络路径（UNC）作为工作目录');
    }
    let real;
    try {
      real = await realpath(wanted);
    } catch {
      throw codedError('bad_cwd', `工作目录不存在：${wanted}`);
    }
    let info;
    try {
      info = await stat(real);
    } catch {
      throw codedError('bad_cwd', `工作目录不可访问：${wanted}`);
    }
    if (!info.isDirectory()) throw codedError('bad_cwd', `不是目录：${wanted}`);
    for (const root of roots.roots) {
      let realRoot;
      try {
        realRoot = await realpath(root);
      } catch {
        realRoot = path.resolve(root);
      }
      if (isInside(realRoot, real)) return real;
    }
    throw codedError('cwd_forbidden', '该目录不在允许的工作区范围内');
  }

  reserveClientId(key) {
    this.byClientId.set(key, PENDING);
    this.trimClientIds();
  }

  rememberClientId(key, sessionId) {
    this.byClientId.delete(key);
    this.byClientId.set(key, sessionId);
    this.trimClientIds();
  }

  trimClientIds() {
    while (this.byClientId.size > MAX_CLIENT_IDS) {
      let removed = false;
      for (const [key, value] of this.byClientId) {
        if (value === PENDING) continue;
        this.byClientId.delete(key);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  async createTask({ prompt, cwd, preset, clientTaskId, source = 'mobile' }) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (text.length === 0) throw codedError('empty_prompt', '任务内容不能为空');
    if (text.length > 20_000) throw codedError('prompt_too_long', '任务内容过长（上限 20000 字符）');
    const key = typeof clientTaskId === 'string' && clientTaskId.length > 0 ? clientTaskId.slice(0, 128) : '';
    if (key.length > 0) {
      const hit = this.byClientId.get(key);
      if (hit === PENDING) throw codedError('create_in_flight', '同一请求正在创建中，请稍候再试');
      if (typeof hit === 'string' && this.tasks.has(hit)) {
        return { task: this.publicTask(this.tasks.get(hit)), reused: true };
      }
      this.reserveClientId(key);
    }
    try {
      const workdir = await this.resolveWorkdir(cwd);
      const presetId = typeof preset === 'string' && preset.length > 0 ? preset : undefined;
      const agentOptions = this.defaultAgentOptions();
      const setup = await this.presetSetup(presetId);
      const sessionId = `session-${randomUUID()}`;
      const agents = this.services.agents;
      if (agents === undefined) throw codedError('no_agent', 'agent service unavailable');
      // The agent factory is registered by agent-loop's constructor; the plugin
      // can load first, so retry briefly instead of failing the first tap.
      let handle;
      let lastError;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          handle = await agents.create({
            sessionId,
            meta: { cwd: workdir, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
            ...(agentOptions === undefined ? {} : { agentOptions }),
            ...(setup === undefined ? {} : { setup }),
          });
          break;
        } catch (error) {
          lastError = error;
          if (!String(error?.message ?? '').includes('no agent factory registered')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (handle === undefined) throw lastError ?? new Error('agent factory unavailable');
      const task = this.tasks.get(sessionId) ?? this.upsertRow({
        header: handle.agent.header ?? { id: handle.agent.id ?? sessionId, cwd: workdir, createdAt: Date.now() },
        live: true,
        persisted: true,
      });
      if (task !== undefined) {
        task.title = oneLine(text, 42);
        task.titleSource = 'derived';
        task.blank = false;
        task.status = 'running';
        task.live = true;
        task.cwd = workdir;
        task.cwdName = cwdName(workdir);
        task.preset = presetId;
        task.origin = 'user';
        task.isSubagent = false;
        task.lastText = oneLine(text, 220);
        task.lastRole = 'user';
        task.updatedAt = Date.now();
      }
      // The idempotency key may only be committed **after** the prompt has
      // actually been delivered. `reused: true` is the phone's signal that its
      // first attempt succeeded and must not be retried, so committing the key
      // earlier would turn any followup() failure into a permanent black hole:
      // the retry would match the key, get 200/reused, and the prompt would
      // never be sent. Until then the key stays PENDING, which also keeps a
      // concurrent retry out (create_in_flight) and lets the catch below clear it.
      try {
        await handle.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user', client: source },
        });
      } catch (error) {
        if (task !== undefined) {
          task.status = 'error';
          task.statusReason = oneLine(error?.message ?? '发送失败', 200);
          this.scheduleUpdate(task);
        }
        throw error;
      }
      if (key.length > 0) this.rememberClientId(key, sessionId);
      if (task !== undefined) this.scheduleUpdate(task);
      return {
        task: task === undefined
          ? { id: sessionId, title: oneLine(text, 42), status: 'running', cwd: workdir }
          : this.publicTask(task),
        reused: false,
      };
    } catch (error) {
      if (key.length > 0 && this.byClientId.get(key) === PENDING) this.byClientId.delete(key);
      throw error;
    }
  }

  async promptTask(id, prompt, { source = 'mobile' } = {}) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (text.length === 0) throw codedError('empty_prompt', '消息不能为空');
    if (text.length > 20_000) throw codedError('prompt_too_long', '消息过长（上限 20000 字符）');
    const task = this.tasks.get(id);
    if (task === undefined) throw codedError('not_found', 'task not found');
    const agent = await this.ensureAgent(id, { createIfMissing: true });
    await agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', client: source },
    });
    task.status = 'running';
    task.lastText = oneLine(text, 220);
    task.lastRole = 'user';
    task.updatedAt = Date.now();
    this.scheduleUpdate(task);
    return this.publicTask(task);
  }

  async cancelTask(id) {
    const agents = this.services.agents;
    const agent = agents?.get?.(id);
    if (agent === undefined) throw codedError('not_running', '任务当前未运行');
    try {
      await agent.cancel?.({ kind: 'user' });
    } catch (error) {
      this.logger.warn('agent cancel failed', id, error);
    }
    const task = this.tasks.get(id);
    if (task !== undefined) {
      task.status = 'cancelled';
      task.statusReason = '已中断';
      this.scheduleUpdate(task);
    }
    return task === undefined ? { id, status: 'cancelled' } : this.publicTask(task);
  }

  async workspaces() {
    const registry = this.services.workspaceRegistry;
    if (registry === undefined) return [];
    const rows = registry.list();
    const seen = new Set();
    const result = [];
    for (const workspace of rows) {
      const workspacePath = workspace?.path;
      if (typeof workspacePath !== 'string') continue;
      const key = pathKey(workspacePath);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        id: String(workspace.id ?? workspacePath),
        path: workspacePath,
        title: workspace.title ?? cwdName(workspacePath),
        available: existsSync(workspacePath),
      });
    }
    // Recent session cwds that are not registered workspaces are still useful.
    for (const task of this.tasks.values()) {
      if (task.cwd.length === 0 || seen.has(pathKey(task.cwd)) || task.isSubagent) continue;
      if (result.length >= 30) break;
      seen.add(pathKey(task.cwd));
      result.push({
        id: task.cwd,
        path: task.cwd,
        title: task.cwdName,
        available: existsSync(task.cwd),
        recent: true,
      });
    }
    return result;
  }

  async presets() {
    const registry = this.services.agentPresets;
    if (registry === undefined) return { presets: [], defaultId: undefined };
    try {
      const rows = await registry.list();
      return {
        defaultId: registry.defaultId,
        presets: rows.map((row) => ({
          id: row.id,
          name: row.name ?? row.id,
          description: row.description ?? '',
          isDefault: row.id === registry.defaultId,
        })),
      };
    } catch (error) {
      this.logger.warn('preset list failed', error);
      return { presets: [], defaultId: undefined };
    }
  }

  dispose() {
    for (const timer of this.pendingUpdates.values()) clearTimeout(timer);
    this.pendingUpdates.clear();
    if (this.summaryTimer !== undefined) clearTimeout(this.summaryTimer);
    this.summaryTimer = undefined;
    this.detailCache.clear();
    this.agentLocks.clear();
  }
}
