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

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  function renderDevices(devices) {
    if (!deviceList) return;
    deviceList.replaceChildren();
    if (deviceCount) deviceCount.textContent = String(devices.length);
    if (!Array.isArray(devices) || devices.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-devices';
      const dot = document.createElement('span');
      dot.className = 'dot dot-idle';
      empty.append(dot, document.createTextNode(' 还没有登记设备'));
      deviceList.append(empty);
      return;
    }
    for (const device of devices) {
      const row = document.createElement('div');
      row.className = 'device-row';
      const icon = document.createElement('div');
      icon.className = 'device-icon';
      icon.textContent = device.platform === 'harmonyos' ? '鸿' : '设';
      const main = document.createElement('div');
      main.className = 'device-main';
      const name = document.createElement('div');
      name.className = 'device-name';
      name.textContent = device.name || '未命名设备';
      const meta = document.createElement('div');
      meta.className = 'device-meta';
      const parts = [];
      if (device.platform) parts.push(device.platform);
      if (device.appVersion) parts.push(`v${device.appVersion}`);
      parts.push(device.lastIp || '未知地址');
      meta.textContent = parts.join(' · ');
      main.append(name, meta);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'ghost danger';
      revoke.textContent = '移除';
      revoke.addEventListener('click', () => revokeDevice(device.id, revoke));
      row.append(icon, main, revoke);
      deviceList.append(row);
    }
  }

  // 页面只关心设备列表：配对码已经不存在了（登录一次就自动登记设备）。
  function apply(data) {
    if (!data || typeof data !== 'object') return;
    renderDevices(data.devices);
  }

  async function refresh() {
    if (stopped) return;
    try {
      // 别改回那条老的配对接口路径：它已随配对码一起删除，现在会被鉴权闸
      // 直接回 401，页面就会每 4 秒弹一次「连接已断开」，设备列表再也不刷新。
      const response = await fetch('/api/v1/devices', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (response.status === 403) {
        stopped = true;
        toast('设备列表仅可在运行 DSH 的这台电脑上查看');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body?.ok) apply(body.data);
    } catch (error) {
      if (!stopped) toast('与桥接服务的连接已断开，正在重试…');
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
      await refresh();
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
    try {
      const response = await fetch('/cloud/status', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const body = await response.json();
      const data = body?.data;
      if (!data) return;
      const badge = $('remote-badge');
      if (badge) {
        const [label, tone] = REMOTE_BADGE[data.state] ?? ['未启用', 'soft'];
        badge.textContent = label;
        badge.className = `badge ${tone}`;
      }
      const stateEl = $('remote-state');
      if (stateEl) {
        stateEl.textContent = data.phone?.name
          ? `手机「${data.phone.name}」已接入中转`
          : '等待手机扫码接入';
      }
      const urlEl = $('remote-url');
      if (urlEl && typeof data.url === 'string' && data.url.length > 0) urlEl.textContent = data.url;
    } catch { /* the next tick retries */ }
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-copy-remote]')) {
      copy($('remote-url')?.textContent?.trim() || '');
    }
  });

  setInterval(refresh, 4000);
  setInterval(refreshRemote, 5000);
  refresh();
  refreshRemote();
})();
