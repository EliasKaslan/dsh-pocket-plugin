/* Desktop pairing page controller. All dynamic text is inserted with
 * textContent; nothing from the server is ever parsed as markup. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const codeEl = $('pair-code');
  const bar = $('countdown-bar');
  const countdownText = $('countdown-text');
  const usesEl = $('pair-uses');
  const deviceList = $('device-list');
  const deviceCount = $('device-count');
  const toastEl = $('toast');

  let state = { expiresAt: 0, ttlMs: 600000, uses: 0, maxUses: 10 };
  let stopped = false;
  let toastTimer;

  try {
    const raw = document.getElementById('pair-data')?.textContent;
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch { /* keep defaults */ }

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  function fmtRemaining(ms) {
    if (ms <= 0) return '已过期，正在刷新…';
    const total = Math.ceil(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `剩余 ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function tick() {
    const remaining = state.expiresAt - Date.now();
    const ratio = state.ttlMs > 0 ? Math.max(0, Math.min(1, remaining / state.ttlMs)) : 0;
    if (bar) bar.style.width = `${(ratio * 100).toFixed(2)}%`;
    if (countdownText) countdownText.textContent = fmtRemaining(remaining);
    if (bar) bar.style.background = ratio < 0.2
      ? 'linear-gradient(90deg,#fbbf24,#f87171)'
      : 'linear-gradient(90deg,#5b8cff,#8b5cf6)';
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
      empty.append(dot, document.createTextNode(' 还没有配对设备'));
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

  function apply(data) {
    if (!data || typeof data !== 'object') return;
    state = {
      expiresAt: Number(data.expiresAt) || 0,
      ttlMs: Number(data.ttlMs) || 600000,
      uses: Number(data.uses) || 0,
      maxUses: Number(data.maxUses) || 10,
    };
    if (codeEl && typeof data.code === 'string') codeEl.textContent = data.code;
    if (usesEl) usesEl.textContent = `已配对 ${state.uses} 次`;
    renderDevices(data.devices);
    tick();
  }

  async function refresh() {
    if (stopped) return;
    try {
      const response = await fetch('/api/v1/pairing', { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (response.status === 403) {
        stopped = true;
        toast('配对信息仅可在电脑本机查看');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body?.ok) apply(body.data);
    } catch (error) {
      if (!stopped) toast('与桥接服务的连接已断开，正在重试…');
    }
  }

  async function rotate() {
    const button = $('rotate');
    if (button) button.disabled = true;
    try {
      const response = await fetch('/api/v1/pairing/rotate', { method: 'POST', headers: { accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok || !body?.ok) throw new Error(body?.error?.message || '刷新失败');
      apply(body.data);
      toast('已生成新的配对码');
    } catch (error) {
      toast(error.message || '刷新失败');
    } finally {
      if (button) button.disabled = false;
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

  $('rotate')?.addEventListener('click', rotate);
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-copy-remote]')) {
      copy($('remote-url')?.textContent?.trim() || '');
    }
  });

  setInterval(tick, 1000);
  setInterval(refresh, 4000);
  setInterval(refreshRemote, 5000);
  refresh();
  refreshRemote();
})();
