/** Pairing screen: deep link, 8-character code, recent servers. */
import { h, icon } from '../lib/dom.js';
import { normalizeBase } from '../lib/net.js';
import { haptic, toast } from '../lib/ui.js';
import { LIMITS, readJson, recentServers, store } from '../store.js';

const DEVICE_KEY = 'dsh.pocket.device.v1';

/** Decode `#pair=<base64url json>` produced by the desktop pair page. */
export function readPairFragment(hash) {
  const match = /[#&]pair=([A-Za-z0-9\-_=+/]+)/u.exec(String(hash ?? ''));
  if (match === null) return null;
  try {
    const binary = atob(match[1].replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload === null || typeof payload !== 'object') return null;
    return {
      baseUrl: typeof payload.u === 'string' ? payload.u : '',
      code: typeof payload.c === 'string' ? payload.c : '',
      name: typeof payload.n === 'string' ? payload.n : '',
      via: typeof payload.f === 'string' ? payload.f : '',
    };
  } catch { return null; }
}

export function mountConnect(root, ctx) {
  const codeInput = h('input', {
    class: 'code-input', id: 'pair-code', inputmode: 'text', autocapitalize: 'characters',
    autocomplete: 'off', spellcheck: 'false', maxlength: '12', placeholder: '输入配对码',
  });
  const nameInput = h('input', {
    class: 'text-input', id: 'device-name', maxlength: '24',
    placeholder: '这台手机的名字（可留空）', value: store.prefs.deviceName ?? '',
  });
  const submit = h('button', { class: 'btn btn-primary connect-submit', type: 'button' }, icon('link', { size: 18 }), h('span', { text: '连接' }));
  const errorLine = h('p', { class: 'connect-error', hidden: true });
  const recentBox = h('div', { class: 'recent-list' });
  const hint = h('p', { class: 'connect-hint' });

  const shellMode = globalThis.__POCKET_SHELL__?.mode === 'remote';
  hint.textContent = shellMode
    ? '在电脑上打开 DSH 随行的配对页，用同一串 8 位配对码连接。'
    : '配对码在电脑插件启动时输出，也可以打开电脑上的配对页查看。';

  const hero = h('div', { class: 'connect-hero' },
    h('div', { class: 'hero-mark' }, icon('sparkles', { size: 26 })),
    h('h1', { text: '连接你的电脑' }),
    hint,
  );

  const screen = h('div', { class: 'screen screen-connect' },
      h('div', { class: 'scroll connect-scroll' },
        hero,
        h('div', { class: 'connect-card' },
          h('label', { class: 'field-label', for: 'pair-code', text: '配对码' }),
          codeInput,
          h('label', { class: 'field-label', for: 'device-name', text: '设备名' }),
          nameInput,
          submit,
          errorLine,
        ),
        h('div', { class: 'recent-wrap' }, recentBox),
        h('p', { class: 'connect-foot', text: '所有数据都在你自己的电脑上；中继只转发密文，密钥不会离开这台手机和你的电脑。' }),
      ),
  );
  root.append(screen);

  codeInput.addEventListener('input', () => {
    // 电脑端生成的配对码形如 VX42-9NWA：连字符是格式的一部分，不能吃掉。
    codeInput.value = codeInput.value.replace(/[^0-9a-zA-Z-]/gu, '').toUpperCase().slice(0, 9);
    errorLine.hidden = true;
  });
  codeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') void connect(); });
  submit.addEventListener('click', () => void connect());
  nameInput.addEventListener('change', () => store.prefs.deviceName = nameInput.value.trim());

  function paintRecent() {
    const servers = recentServers();
    recentBox.replaceChildren();
    if (servers.length === 0) return;
    recentBox.append(h('div', { class: 'section-label', text: '最近连接过' }));
    const list = h('div', { class: 'settings-list' });
    for (const entry of servers) {
      list.append(h('button', {
        class: 'row row-button', type: 'button',
        on: { click: () => { fill(entry.baseUrl); } },
      },
      h('span', { class: 'row-icon' }, icon('server', { size: 18 })),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-label', text: entry.serverName || entry.baseUrl }),
        h('span', { class: 'row-hint', text: entry.baseUrl })),
      icon('chevron', { size: 18 }),
      ));
    }
    recentBox.append(list);
  }

  function fill(base) {
    ctx.useBase(base);
    codeInput.focus();
  }

  let busy = false;
  async function connect() {
    if (busy) return;
    const code = codeInput.value.trim();
    if (code.replace(/-/gu, '').length < 6) {
      errorLine.hidden = false;
      errorLine.textContent = '配对码不对，长度不够。';
      codeInput.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.querySelector('span').textContent = '连接中…';
    errorLine.hidden = true;
    try {
      const base = normalizeBase(ctx.currentBase());
      const deviceName = (nameInput.value.trim() || store.prefs.deviceName || '').slice(0, 24);
      const data = await ctx.api('/api/v1/pair', {
        method: 'POST',
        auth: false,
        base,
        timeout: 25_000,
        body: {
          code,
          name: deviceName || defaultDeviceName(),
          platform: platformName(),
          appVersion: ctx.appVersion,
          deviceId: readJson(DEVICE_KEY, null) ?? undefined,
        },
      });
      if (typeof data?.token !== 'string' || data.token.length === 0) {
        throw new Error('电脑没有返回设备令牌');
      }
      haptic(20);
      ctx.paired({
        token: data.token,
        baseUrl: base,
        deviceName: deviceName || data.device?.name || defaultDeviceName(),
        serverName: data.server?.name ?? '',
        pairedAt: Date.now(),
      });
      toast('已连接', { tone: 'ok' });
    } catch (error) {
      errorLine.hidden = false;
      errorLine.textContent = error?.message ?? '配对失败';
    } finally {
      busy = false;
      submit.disabled = false;
      submit.querySelector('span').textContent = '连接';
    }
  }

  paintRecent();
  return { screen, paint: paintRecent, destroy() {}, focusCode() { codeInput.focus(); } };
}

export function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/u.test(ua)) return 'iPhone';
  if (/iPad/u.test(ua)) return 'iPad';
  if (/HarmonyOS|OpenHarmony/u.test(ua)) return 'HarmonyOS 手机';
  if (/Android/u.test(ua)) return 'Android 手机';
  return '我的手机';
}

export function platformName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/u.test(ua)) return 'ios';
  if (/HarmonyOS|OpenHarmony/u.test(ua)) return 'harmony';
  if (/Android/u.test(ua)) return 'android';
  return 'web';
}

export { LIMITS };
