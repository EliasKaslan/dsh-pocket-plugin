/** Settings / account screen. Every value here is live, including the link path. */
import { h, icon } from '../lib/dom.js';
import { relTime } from '../lib/format.js';
import { confirmDialog, toast } from '../lib/ui.js';
import { applyTheme, baseUrl, resolvedTheme, savePrefs, serverName, store } from '../store.js';

// 项目主页。这里只放项目自身的公开地址，不放任何个人账号 / 个人主页 /
// 个人静态托管域名 —— 手机端展示的东西要能被任何使用者看到。
const REPO = 'https://github.com/EliasKaslan/dsh-pocket-plugin';

export function mountSettings(root, ctx) {
  const connPill = h('span', { class: 'pill' }, h('i'), h('span', { class: 'pill-text' }));
  const serverValue = h('span', { class: 'row-value' });
  const addressValue = h('span', { class: 'row-value mono' });
  const latencyValue = h('span', { class: 'row-value' });
  const versionValue = h('span', { class: 'row-value' });
  const shellVersionValue = h('span', { class: 'row-value' });
  const deviceValue = h('span', { class: 'row-value' });

  const themeButtons = new Map();
  const themeRow = h('div', { class: 'segment' });
  for (const [id, label] of [['auto', '跟随系统'], ['dark', '深色'], ['light', '浅色']]) {
    const button = h('button', {
      class: 'segment-item', type: 'button', text: label,
      on: {
        click: () => {
          savePrefs({ theme: id });
          applyTheme();
          paintTheme();
          ctx.repaintAll();
        },
      },
    });
    themeButtons.set(id, button);
    themeRow.append(button);
  }

  const subagentToggle = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false' },
    h('span', { class: 'switch-knob' }));
  subagentToggle.addEventListener('click', () => {
    const next = store.prefs.showSubagents !== true;
    savePrefs({ showSubagents: next });
    paintToggles();
    ctx.reloadTasks();
  });

  const notifyToggle = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false' },
    h('span', { class: 'switch-knob' }));
  notifyToggle.addEventListener('click', () => {
    const next = store.prefs.notify !== true;
    savePrefs({ notify: next });
    paintToggles();
    if (next) void ctx.requestNotifications();
  });

  const row = (iconName, label, value, extra = null) => h('div', { class: 'row' },
    h('span', { class: 'row-icon' }, icon(iconName, { size: 18 })),
    h('span', { class: 'row-label', text: label }),
    value ?? null,
    extra,
  );

  const buttonRow = (iconName, label, onClick, { danger = false, hint = '' } = {}) => h('button', {
    class: `row row-button${danger ? ' danger' : ''}`, type: 'button',
    on: { click: onClick },
  },
  h('span', { class: 'row-icon' }, icon(iconName, { size: 18 })),
  h('span', { class: 'row-main' }, h('span', { class: 'row-label', text: label }), hint ? h('span', { class: 'row-hint', text: hint }) : null),
  icon('chevron', { size: 18 }),
  );

  const screen = h('div', { class: 'screen screen-settings' },
      h('header', { class: 'topbar simple' }, h('h1', { text: '我的' })),
      h('div', { class: 'scroll settings-scroll' },

        h('section', { class: 'settings-card status-card' },
          h('div', { class: 'status-head' },
            h('div', { class: 'status-mark' }, icon('server', { size: 20 })),
            h('div', { class: 'status-title' }, h('h2', { text: serverName() }), connPill),
          ),
        ),
        h('div', { class: 'settings-list' },
          row('link', '连接地址', addressValue),
          row('wifi', '延迟', latencyValue),
          row('phone', '本机设备', deviceValue),
          row('info', '插件版本', versionValue),
    // 必须单独显示"前端版本"：以前只有「插件版本」，那是**电脑端**的版本号，
    // 手机加载的外壳是哪一版完全看不出来 —— 排查"改了没生效"时一直在盲猜。
    row('info', '前端版本', shellVersionValue),
        ),

        h('div', { class: 'section-label', text: '连接' }),
        h('div', { class: 'settings-list' },
          buttonRow('refresh', '重新连接', () => ctx.reconnect(), { hint: '断线或卡住时点一下' }),
          buttonRow('copy', '复制诊断信息', () => ctx.copyDiagnostics(), { hint: '排查问题时贴给电脑端' }),
          buttonRow('scan', '换一台电脑', () => void unpair('切换'), { danger: false }),
        ),

        h('div', { class: 'section-label', text: '外观' }),
        h('div', { class: 'settings-list' }, h('div', { class: 'row segment-row' },
          h('span', { class: 'row-icon' }, icon('moon', { size: 18 })),
          h('span', { class: 'row-label', text: '主题' }),
          themeRow,
        )),

        h('div', { class: 'section-label', text: '任务列表' }),
        h('div', { class: 'settings-list' },
          h('div', { class: 'row' },
            h('span', { class: 'row-icon' }, icon('sparkles', { size: 18 })),
            h('span', { class: 'row-main' },
              h('span', { class: 'row-label', text: '显示子任务' }),
              h('span', { class: 'row-hint', text: '子代理并行时会多出很多条目' })),
            subagentToggle,
          ),
          h('div', { class: 'row' },
            h('span', { class: 'row-icon' }, icon('bell', { size: 18 })),
            h('span', { class: 'row-main' },
              h('span', { class: 'row-label', text: '任务完成时提醒' }),
              h('span', { class: 'row-hint', text: '需要授权浏览器通知；不支持后台推送' })),
            notifyToggle,
          ),
        ),

        h('div', { class: 'section-label', text: '关于' }),
        h('div', { class: 'settings-list' },
          buttonRow('shield', '安全模型', () => void explainSecurity()),
          buttonRow('external', '开源仓库', () => window.open(REPO, '_blank', 'noopener')),
        ),
        h('p', { class: 'about-note' },
          // 别写"密钥都留在电脑上"：房间密钥确实也从不上传，但本机存着那条
          // 含密钥的配对链接（见「安全模型」第 2 条），这句口号会给人错误印象。
          'DSH 随行 · 手机只是遥控器，代码与数据都留在你自己的电脑上。',
        ),
        h('div', { class: 'settings-spacer' }),
      ),
      h('nav', { class: 'tabbar' },
        h('button', { class: 'tab', type: 'button', on: { click: () => ctx.navigate('/tasks') } }, icon('tasks', { size: 20 }), h('span', { text: '任务' })),
        h('button', { class: 'fab', type: 'button', 'aria-label': '新建任务', on: { click: () => ctx.navigate('/new') } }, icon('plus', { size: 24 })),
        h('button', { class: 'tab active', type: 'button', 'aria-current': 'page' }, icon('settings', { size: 20 }), h('span', { text: '我的' })),
      ),
  );
  root.append(screen);

  async function unpair(mode) {
    const ok = await confirmDialog({
      title: mode === '切换' ? '换一台电脑？' : '断开连接？',
      message: '这台手机上的登录信息会被清除，之后需要重新用电脑上的账号 + 口令登录。',
      confirmText: mode === '切换' ? '去配对' : '断开',
      danger: true,
    });
    if (!ok) return;
    ctx.unpair();
  }

  async function explainSecurity() {
    const { actionSheet } = await import('../lib/ui.js');
    await actionSheet({
      title: '安全模型',
      items: [
        { label: '手机与电脑之间是端到端加密：中继只转发密文，房间密钥从来不上传。', run: () => {} },
        // 如实写，别写"密钥只存在于链接片段里"：为了让 PWA 从桌面图标直接进，
        // 外壳会把整条配对链接（含房间密钥）明文存在本机 localStorage
        // （见 remote/remote.js 的 storeLink()）。同源的任何脚本都读得到。
        { label: '但这台手机的浏览器里存着那条配对链接（含房间密钥），用来免扫码直接进。本页同源的任何脚本都读得到它，所以外壳不加载任何第三方脚本。', run: () => {} },
        { label: '配对链接只负责建立加密通道，本身不是访问凭据：进面板还需要电脑上设置的账号 + 口令。即便如此也别外传。', run: () => {} },
        { label: '手机只能操作任务，不能读写任意文件；所有动作都在电脑端由 DSH 的权限策略决定。', run: () => {} },
        { label: '想让那条链接彻底作废：在电脑端「重置链接」一次 —— 房间换了，旧链接连房间都进不去（只删手机上那份只是本机不再记住）。', run: () => {} },
        { label: '想立即作废某台手机的访问：在电脑配对页把它移除，它的设备令牌立刻失效、且不会因为重新登录自动复活。', run: () => {} },
      ],
    });
  }

  function paintTheme() {
    const active = store.prefs.theme ?? 'auto';
    for (const [id, button] of themeButtons) {
      button.classList.toggle('active', id === active);
      button.setAttribute('aria-pressed', String(id === active));
    }
  }

  function paintToggles() {
    subagentToggle.setAttribute('aria-checked', String(store.prefs.showSubagents === true));
    subagentToggle.classList.toggle('on', store.prefs.showSubagents === true);
    notifyToggle.setAttribute('aria-checked', String(store.prefs.notify === true));
    notifyToggle.classList.toggle('on', store.prefs.notify === true);
  }

  const labels = { online: '已连接', connecting: '连接中', offline: '已断开', polling: '轮询中', stale: '电脑可能已离线' };

  function paint() {
    const state = store.connState;
    connPill.className = `pill ${state === 'online' ? 'done' : state === 'stale' || state === 'offline' ? 'warn' : 'idle'}`;
    connPill.querySelector('.pill-text').textContent = labels[state] ?? '连接中';

    serverValue.textContent = serverName();
    addressValue.textContent = baseUrl() || location.origin;
    latencyValue.textContent = store.latency > 0 ? `${store.latency} ms` : '—';
    versionValue.textContent = store.bridge?.version ? `v${store.bridge.version}` : '—';
    // 前端版本 = 这台手机实际加载的那份 JS；与上面那行（电脑端）不同步是正常的。
    shellVersionValue.textContent = globalThis.__POCKET_APP_VERSION__
      ? `v${globalThis.__POCKET_APP_VERSION__}`
      : '—';
    deviceValue.textContent = store.session?.deviceName || '本机';
    paintTheme();
    paintToggles();
  }

  paint();
  return { screen, paint, destroy() {} };
}
