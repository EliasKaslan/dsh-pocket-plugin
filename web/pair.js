/* Desktop pairing page controller. All dynamic text is inserted with
 * textContent; nothing from the server is ever parsed as markup. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const deviceList = $('device-list');
  const deviceCount = $('device-count');
  const toastEl = $('toast');

  let stopped = false;
  let toastTimer;
  /**
   * 两个轮询定时器全部登记在这里，`stopTimers()` 一次清干净（D4）。
   *
   * 旧代码是裸的两行 `setInterval(...)`：配对页放着不管就永远每 4 s / 5 s 打一次
   * 服务、整表重建一次 DOM，切到后台、最小化、息屏都照跑，24 h = 21600 次。
   */
  const timers = [];
  /** 每类请求各自的「在途」标记：慢网络下两拍撞在一起时不许再叠一个请求。 */
  const busy = { devices: false, remote: false };
  /**
   * 纯逻辑模块（`web/lib/pair-diff.js`：行模型 / 差异计划 / 轮询门）。
   *
   * 这一页是 `<script src="/pair/pair.js" defer>` 的经典脚本，不能写静态 import，
   * 所以用动态 `import()` 取同源模块（CSP `script-src 'self'` 允许）。取不到就保持
   * 服务端渲染好的那张列表不动，并把设备轮询停掉 —— 绝不退回整表重建。
   */
  let pure = null;
  /**
   * 这一拍要不要真的去请求。
   *
   * 判据在 `web/lib/pair-diff.js` 的 `shouldPoll`（Node 单测覆盖）；这里只负责喂
   * 状态。模块没加载出来时至少保住最重要的那道门：页面不可见就不发请求。
   */
  function allowPoll(kind) {
    if (stopped) return false;
    const state = {
      stopped,
      busy: busy[kind] === true,
      hidden: typeof document !== 'undefined' && document.hidden === true,
      visibility: typeof document !== 'undefined' ? document.visibilityState : 'visible',
    };
    if (pure !== null) return pure.shouldPoll(state);
    return state.busy !== true && state.hidden !== true;
  }

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  /* ------------------------------------------------ 设备列表（差异更新） */

  /** 上一轮真的写进 DOM 的行模型：id -> model。差异更新的判据。 */
  let renderedDevices = new Map();
  /** id -> { row, icon, name, meta, action, model }：DOM 句柄，只增删必要的行。 */
  const deviceRowsById = new Map();
  let emptyRow;
  /** 服务端渲染的初始行是否已经被摘掉（只做一次，见 adoptServerRows）。 */
  let adoptedServerRows = false;

  function buildEmptyRow() {
    const empty = document.createElement('div');
    empty.className = 'empty-devices';
    const dot = document.createElement('span');
    dot.className = 'dot dot-idle';
    empty.append(dot, document.createTextNode(' 还没有登记设备'));
    return empty;
  }

  /** 建一行（只建一次；之后一律走 updateRow 增量改文本）。 */
  function createRow(model) {
    const row = document.createElement('div');
    row.className = 'device-row';
    row.dataset.deviceId = model.id;
    const icon = document.createElement('div');
    icon.className = 'device-icon';
    const main = document.createElement('div');
    main.className = 'device-main';
    const name = document.createElement('div');
    name.className = 'device-name';
    const meta = document.createElement('div');
    meta.className = 'device-meta';
    main.append(name, meta);
    row.append(icon, main);
    const entry = { row, icon, name, meta, action: null, actionKind: '', model: null };
    updateRow(entry, model);
    return entry;
  }

  /**
   * 只写变了的字段。
   *
   * 关键是**比对后再写**：`textContent =` 会清掉子节点并让布局失效，每 4 s 对整张
   * 表无条件写一遍等于每 4 s 让浏览器重排一次（旧代码 `replaceChildren` 更狠）。
   * 右侧动作元素只在「中继 ↔ 手机」这条性质变了时才换。
   */
  function updateRow(entry, model) {
    if (!entry) return;
    if (entry.icon.textContent !== model.icon) entry.icon.textContent = model.icon;
    if (entry.name.textContent !== model.name) entry.name.textContent = model.name;
    if (entry.meta.textContent !== model.meta) entry.meta.textContent = model.meta;
    const actionKind = model.relay ? 'tag' : 'revoke';
    if (entry.actionKind !== actionKind) {
      entry.action?.remove();
      if (model.relay) {
        // 中继不是手机：给它「移除」只会让你自己的二维码失效、手机被踢下线。
        const tag = document.createElement('span');
        tag.className = 'device-tag';
        tag.textContent = '本机 · 不可移除';
        entry.row.append(tag);
        entry.action = tag;
      } else {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'ghost danger';
        revoke.textContent = '移除';
        revoke.addEventListener('click', () => revokeDevice(model.id, revoke));
        entry.row.append(revoke);
        entry.action = revoke;
      }
      entry.actionKind = actionKind;
    }
    entry.model = model;
  }

  function setEmptyPlaceholder(visible) {
    if (!deviceList) return;
    if (visible && emptyRow === undefined) {
      emptyRow = buildEmptyRow();
      deviceList.append(emptyRow);
    } else if (!visible && emptyRow !== undefined) {
      emptyRow.remove();
      emptyRow = undefined;
    }
  }

  /**
   * 服务端渲染的那张初始列表只摘一次。
   *
   * `lib/pair-page.mjs` 已经把设备行写进了 HTML（首屏不用等 JS）。差异更新按 id
   * 管理节点，认不出这些没有 `data-device-id` 的旧行 —— 不摘掉它们，第一次刷新
   * 就会在旧行下面再渲染一整套（界面变成两倍）。只摘一次，之后一切走差异更新。
   */
  function adoptServerRows() {
    if (adoptedServerRows || !deviceList) return;
    adoptedServerRows = true;
    for (const child of [...deviceList.children]) {
      if (child.dataset?.deviceId !== undefined) continue; // 自己建的行（理论上不会有）
      child.remove();
    }
    emptyRow = undefined;
  }

  /** 差异更新：删消失的、建新的、只改变化了的文本、顺序真变了才重排。 */
  function applyDeviceRows(models) {
    if (!deviceList) return;
    adoptServerRows();
    const plan = pure.planDeviceRows(renderedDevices, models);
    for (const id of plan.remove) {
      deviceRowsById.get(id)?.row.remove();
      deviceRowsById.delete(id);
    }
    for (const id of plan.create) {
      const entry = createRow(plan.next.get(id));
      deviceRowsById.set(id, entry);
      deviceList.append(entry.row);
    }
    for (const id of plan.update) updateRow(deviceRowsById.get(id), plan.next.get(id));
    const current = [...deviceList.children]
      .filter((child) => child !== emptyRow)
      .map((child) => child.dataset?.deviceId ?? '');
    if (!pure.sameOrder(plan.order, current)) {
      // append 会把已有节点移到末尾：按期望顺序走一遍即完成重排。
      for (const id of plan.order) {
        const entry = deviceRowsById.get(id);
        if (entry) deviceList.append(entry.row);
      }
    }
    setEmptyPlaceholder(plan.order.length === 0);
    renderedDevices = plan.next;
    if (deviceCount && deviceCount.textContent !== String(plan.order.length)) {
      deviceCount.textContent = String(plan.order.length);
    }
  }

  function renderDevices(devices) {
    // 模块没加载出来时保持服务端渲染的那张列表不动（它本来就是对的），
    // 也不再做整表重建 —— 这正是 D4 要拆掉的那条路。
    if (pure === null) return;
    applyDeviceRows(pure.deviceModels(devices));
  }

  // 页面只关心设备列表：配对码已经不存在了（登录一次就自动登记设备）。
  function apply(data) {
    if (!data || typeof data !== 'object') return;
    renderDevices(data.devices);
  }

  async function refresh({ force = false } = {}) {
    if (stopped || busy.devices) return;
    // D4：页面不可见（后台/最小化/息屏）时这一拍直接跳过，一个请求都不发。
    if (!force && !allowPoll('devices')) return;
    busy.devices = true;
    try {
      // 别改回那条老的配对接口路径：它已随配对码一起删除，现在会被鉴权闸
      // 直接回 401，页面就会每 4 秒弹一次「连接已断开」，设备列表再也不刷新。
      const response = await fetch('/api/v1/devices', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (response.status === 403) {
        // 权限结论不会自己变回来：把两个定时器一起停掉，别再每 4 s 撞一次墙。
        stopTimers();
        toast('设备列表仅可在运行 DSH 的这台电脑上查看');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body?.ok) apply(body.data);
    } catch (error) {
      if (!stopped) toast('与桥接服务的连接已断开，正在重试…');
    } finally {
      busy.devices = false;
    }
  }

  async function revokeDevice(id, button) {
    if (!id) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/v1/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: { accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok || !body?.ok) throw new Error(body?.error?.message || '移除失败');
      toast('设备已移除，令牌立即失效');
      await refresh({ force: true });
    } catch (error) {
      toast(error.message || '移除失败');
      button.disabled = false;
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      try { document.execCommand('copy'); toast('已复制'); } catch { toast('复制失败，请手动选择'); }
      area.remove();
    }
  }

  /* ------------------------------------------------ 账号与口令卡片 */

  // CSRF 只从 <meta name="pocket-csrf"> 取：这个值每次页面加载都是一样的
  // 进程级令牌，不写进 URL、也不拼进 query，避免它出现在历史与日志里。
  const csrfMeta = document.querySelector('meta[name="pocket-csrf"]');
  const csrfToken = csrfMeta ? (csrfMeta.getAttribute('content') || '') : '';

  function accountStatus(message) {
    const statusEl = $('account-status');
    if (statusEl) statusEl.textContent = message;
  }

  async function saveAccount(event) {
    event.preventDefault();
    const userInput = $('account-user');
    const passwordInput = $('account-password');
    const confirmInput = $('account-password2');
    const button = $('account-save');

    const user = userInput ? userInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const confirm = confirmInput ? confirmInput.value : '';

    const fail = (message) => {
      accountStatus(message);
      toast(message);
      if (button) button.disabled = false;
    };

    if (user.length === 0) { fail('请填写账号'); return; }
    if (password.length < 8) { fail('口令至少 8 个字符'); return; }
    if (password !== confirm) { fail('两次输入的口令不一致'); return; }

    if (button) button.disabled = true;
    accountStatus('正在保存…');
    try {
      const response = await fetch('/api/v1/account', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-pocket-csrf': csrfToken,
        },
        body: JSON.stringify({ user, password }),
      });
      let body;
      try { body = await response.json(); } catch { body = undefined; }
      if (!response.ok || !body?.ok) {
        // 后端拒绝时只展示它给的那句话（例如「口令至少 8 个字符」），
        // 不把请求体或任何输入回显到页面。
        throw new Error((body && body.error && body.error.message) || `保存失败（HTTP ${response.status}）`);
      }
      // 口令已经在服务端换掉：本页不再需要它，先清空再刷新，别留在内存里。
      if (passwordInput) passwordInput.value = '';
      if (confirmInput) confirmInput.value = '';
      accountStatus('已保存：所有手机需要用新口令重新登录');
      toast('账号与口令已更新，正在刷新…');
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      fail((error && error.message) || '保存失败，请重试');
    }
  }

  const accountForm = $('account-form');
  if (accountForm) accountForm.addEventListener('submit', saveAccount);

  // 中继状态词表与 lib/pair-page.mjs 保持一致：两处都渲染同一个 #remote-badge，
  // 词表不一致会让 5 秒一次的轮询把服务端刚写好的正确标签覆盖成错的。
  const REMOTE_BADGE = {
    online: ['已连通', 'ok'],
    connecting: ['连接中', 'soft'],
    starting: ['启动中', 'soft'],
    idle: ['待启动', 'soft'],
    reconnecting: ['重连中', 'warn'],
    offline: ['连不上', 'warn'],
    disabled: ['已暂停', 'soft'],
    unconfigured: ['未配置', 'warn'],
    blocked: ['缺少口令', 'warn'],
    error: ['中转异常', 'warn'],
  };

  async function refreshRemote() {
    if (stopped || busy.remote) return;
    if (!allowPoll('remote')) return;
    busy.remote = true;
    try {
      const response = await fetch('/cloud/status', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const body = await response.json();
      const data = body?.data;
      if (!data) return;
      const badge = $('remote-badge');
      if (badge) {
        const [label, tone] = REMOTE_BADGE[data.state] ?? ['未启用', 'soft'];
        if (badge.textContent !== label) badge.textContent = label;
        const className = `badge ${tone}`;
        if (badge.className !== className) badge.className = className;
      }
      const stateEl = $('remote-state');
      if (stateEl) {
        const text = data.phone?.name
          ? `手机「${data.phone.name}」已接入中转`
          : '等待手机扫码接入';
        if (stateEl.textContent !== text) stateEl.textContent = text;
      }
      const urlEl = $('remote-url');
      if (urlEl && typeof data.url === 'string' && data.url.length > 0 && urlEl.textContent !== data.url) {
        urlEl.textContent = data.url;
      }
    } catch { /* the next tick retries */ } finally {
      busy.remote = false;
    }
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-copy-remote]')) {
      copy($('remote-url')?.textContent?.trim() || '');
    }
  });

  /* ------------------------------------------------ 定时器：登记 + 可清理 */

  function startTimers() {
    // 全部经 timers.push 登记：pagehide / beforeunload 才有东西可清。
    timers.push(setInterval(() => { if (allowPoll('devices')) void refresh(); }, 4000));
    timers.push(setInterval(() => { if (allowPoll('remote')) void refreshRemote(); }, 5000));
  }

  /**
   * 卸载清理：页面要走了 / 已经不可见时，把两个定时器彻底清掉（D4）。
   *
   * `pagehide` 覆盖"进入往返缓存 / 关闭标签页 / 移动端切走"；`beforeunload` 是给
   * 老浏览器与 `pagehide` 没派发的场景兜底（重复调用是幂等的）。
   */
  function stopTimers() {
    stopped = true;
    for (const timer of timers.splice(0, timers.length)) clearInterval(timer);
    clearTimeout(toastTimer);
  }

  window.addEventListener('pagehide', stopTimers);
  window.addEventListener('beforeunload', stopTimers);

  // 回到前台立刻刷一次，而不是干等下一个 4 s 拍子（后台期间的那几拍是被门挡掉的）。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    void refresh();
    void refreshRemote();
  });

  // 先加载纯逻辑模块，再起定时器：这样第一拍起就走差异更新与 shouldPoll 门。
  // 加载失败也不能白屏 —— 服务端已经把设备列表渲染进 HTML 了，保持它不动即可。
  void (async () => {
    pure = await import('/app/lib/pair-diff.js').catch(() => null);
    startTimers();
    void refresh({ force: true });
    void refreshRemote();
  })();
})();
