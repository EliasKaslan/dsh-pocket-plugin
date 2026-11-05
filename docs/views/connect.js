/** Pairing screen: the 8-character code plus a device name. The relay shell is the only way in. */
import { h, icon } from '../lib/dom.js';
import { haptic, toast } from '../lib/ui.js';
import { baseUrl, isRelayShell, readJson, store } from '../store.js';

const DEVICE_KEY = 'dsh.pocket.device.v1';

/** 没有中继外壳就没有任何可用的连接方式 —— 这句提示必须原样出现。 */
export const RELAY_REQUIRED_MESSAGE = '本页面必须从中继外壳打开';

/**
 * Decode `#pair=<base64url json>` produced by the desktop pair page.
 *
 * 直连删除后这里**不再**返回 `baseUrl`：老二维码里即使还带着局域网地址字段
 * `u`，也只会被静默忽略（不抛错、不回退），连接目标一律由中继外壳决定。
 */
export function readPairFragment(hash) {
  const match = /[#&]pair=([A-Za-z0-9\-_=+/]+)/u.exec(String(hash ?? ''));
  if (match === null) return null;
  try {
    const binary = atob(match[1].replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (payload === null || typeof payload !== 'object') return null;
    return {
      code: typeof payload.c === 'string' ? payload.c : '',
      name: typeof payload.n === 'string' ? payload.n : '',
      via: typeof payload.f === 'string' ? payload.f : '',
    };
  } catch { return null; }
}

export function mountConnect(root, ctx) {
  const relay = isRelayShell();
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
  const hint = h('p', { class: 'connect-hint' });
  hint.textContent = relay
    ? '在电脑上打开 DSH 随行的配对页，把上面的 8 位配对码填进来。'
    : '局域网直连已经删除，这个页面不再能直接连到电脑。';

  const hero = h('div', { class: 'connect-hero' },
    h('div', { class: 'hero-mark' }, icon('sparkles', { size: 26 })),
    h('h1', { text: '连接你的电脑' }),
    hint,
  );

  const notice = h('div', { class: 'connect-notice', role: 'alert', hidden: relay },
    icon('alert', { size: 18 }),
    h('div', { class: 'connect-notice-text' },
      h('strong', { text: RELAY_REQUIRED_MESSAGE }),
      h('span', { text: '手机只能通过中继外壳（静态站点 + 加密中继）访问电脑，请从那个地址打开，再输入配对码。' }),
    ),
  );

  const screen = h('div', { class: 'screen screen-connect' },
      h('div', { class: 'scroll connect-scroll' },
        hero,
        notice,
        h('div', { class: 'connect-card' },
          h('label', { class: 'field-label', for: 'pair-code', text: '配对码' }),
          codeInput,
          h('label', { class: 'field-label', for: 'device-name', text: '设备名' }),
          nameInput,
          submit,
          errorLine,
        ),
        h('p', { class: 'connect-foot', text: '所有数据都在你自己的电脑上；中继只转发密文，密钥不会离开这台手机和你的电脑。' }),
      ),
  );
  root.append(screen);

  if (!relay) {
    // 明确认输，而不是偷偷按 location.origin 直连。
    codeInput.disabled = true;
    nameInput.disabled = true;
    submit.disabled = true;
  }

  codeInput.addEventListener('input', () => {
    // 电脑端生成的配对码形如 VX42-9NWA：连字符是格式的一部分，不能吃掉。
    codeInput.value = codeInput.value.replace(/[^0-9a-zA-Z-]/gu, '').toUpperCase().slice(0, 9);
    errorLine.hidden = true;
  });
  codeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') void connect(); });
  submit.addEventListener('click', () => void connect());
  nameInput.addEventListener('change', () => store.prefs.deviceName = nameInput.value.trim());

  function fail(message) {
    errorLine.hidden = false;
    errorLine.textContent = message;
  }

  let busy = false;
  async function connect() {
    if (busy) return;
    if (!isRelayShell()) {
      fail(RELAY_REQUIRED_MESSAGE);
      return;
    }
    const code = codeInput.value.trim();
    // 8 位（VX42-9NWA 的连字符不算）：它只是认领凭据，不含任何地址。
    if (code.replace(/-/gu, '').length !== 8) {
      fail('配对码是 8 位，形如 VX42-9NWA。');
      codeInput.focus();
      return;
    }
    const base = baseUrl();
    if (base.length === 0) {
      fail('中继外壳没有提供连接地址，请从正确的入口重新打开。');
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.querySelector('span').textContent = '连接中…';
    errorLine.hidden = true;
    try {
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
      fail(error?.message ?? '配对失败');
    } finally {
      busy = false;
      submit.disabled = false;
      submit.querySelector('span').textContent = '连接';
    }
  }

  return {
    screen,
    paint() {},
    destroy() {},
    focusCode() { if (!codeInput.disabled) codeInput.focus(); },
  };
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
