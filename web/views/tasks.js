/** Task list screen: overview, filters, search, card list, pull to refresh. */
import { $, debounce, h, icon, keyedList, raf } from '../lib/dom.js';
import { clock, oneLine, plainText, relTime, shortModel, statusMeta } from '../lib/format.js';
import { emptyState, haptic, skeletonCard } from '../lib/ui.js';
import { LIMITS, filterCounts, serverName, store, visibleTasks } from '../store.js';

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'done', label: '已完成' },
  { id: 'error', label: '失败' },
];

export function mountTasks(root, ctx) {
  const connDot = h('span', { class: 'live-dot' });
  const connText = h('span', { class: 'conn-text', text: '正在连接…' });
  const connBtn = h('button', {
    class: 'conn', type: 'button',
    on: { click: () => ctx.navigate('/settings') },
  }, connDot, connText);

  const statValues = {};
  const statCells = [
    ['running', '运行中'],
    ['today', '今日'],
    ['all', '全部'],
    ['error', '失败'],
  ].map(([key, label]) => {
    const value = h('span', { class: 'stat-value', text: '0' });
    statValues[key] = value;
    return h('div', { class: `stat stat-${key}` }, value, h('span', { class: 'stat-label', text: label }));
  });

  const counts = { all: 0, running: 0, done: 0, error: 0 };
  const chips = new Map();
  const chipRow = h('div', { class: 'filters', role: 'tablist' });
  for (const filter of FILTERS) {
    const badge = h('span', { class: 'chip-count', text: '0' });
    const chip = h('button', {
      class: 'chip', type: 'button', role: 'tab', 'data-filter': filter.id,
      on: { click: () => { haptic(); ctx.setFilter(filter.id); } },
    }, h('span', { text: filter.label }), badge);
    chips.set(filter.id, { el: chip, badge });
    chipRow.append(chip);
  }

  const searchInput = h('input', {
    class: 'search-input', type: 'search', placeholder: '搜索任务标题、内容或目录',
    autocomplete: 'off', enterkeyhint: 'search',
    on: {
      input: debounce((event) => ctx.setQuery(event.target.value), 180),
      keydown: (event) => { if (event.key === 'Escape') ctx.toggleSearch(false); },
    },
  });
  const searchBar = h('div', { class: 'search-bar', hidden: true },
    icon('search', { size: 18 }),
    searchInput,
    h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': '清空', on: { click: () => { searchInput.value = ''; ctx.setQuery(''); } } }, icon('close', { size: 18 })),
  );

  const pullHint = h('div', { class: 'pull-hint', text: '' });
  const list = h('div', { class: 'task-list', id: 'task-list' });
  const endNote = h('div', { class: 'list-end' });
  const scroll = h('div', { class: 'scroll', id: 'tasks-scroll' },
    h('div', { class: 'stats' }, statCells),
    h('div', { class: 'filters-wrap' }, chipRow, searchBar),
    pullHint,
    list,
    endNote,
  );

  const shell = h('div', { class: 'screen screen-tasks' },
    h('header', { class: 'topbar' },
        h('div', { class: 'topbar-lead' },
          h('div', { class: 'brand' }, icon('sparkles', { size: 20 })),
          h('div', { class: 'topbar-titles' },
            h('h1', { text: '任务' }),
            connBtn,
          ),
        ),
        h('div', { class: 'topbar-actions' },
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': '搜索', on: { click: () => ctx.toggleSearch() } }, icon('search')),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': '刷新', on: { click: () => ctx.refresh() } }, icon('refresh')),
        ),
      ),
      scroll,
      h('nav', { class: 'tabbar' },
        h('button', { class: 'tab active', type: 'button', 'aria-current': 'page' }, icon('tasks', { size: 20 }), h('span', { text: '任务' })),
        h('button', { class: 'fab', type: 'button', 'aria-label': '新建任务', on: { click: () => ctx.navigate('/new') } }, icon('plus', { size: 24 })),
        h('button', { class: 'tab', type: 'button', on: { click: () => ctx.navigate('/settings') } }, icon('settings', { size: 20 }), h('span', { text: '我的' })),
      ),
  );
  root.append(shell);

  /* ---------------- card ---------------- */

  function createCard(task) {
    const pill = h('span', { class: 'pill' }, h('i'), h('span', { class: 'pill-text' }));
    const time = h('span', { class: 'task-time' });
    const title = h('h3', { class: 'task-title' });
    const preview = h('p', { class: 'task-preview' });
    const metaDir = h('span', { class: 'meta' }, icon('folder', { size: 13 }), h('span', { class: 'meta-text' }));
    const metaModel = h('span', { class: 'meta' }, icon('cpu', { size: 13 }), h('span', { class: 'meta-text' }));
    const metaTurn = h('span', { class: 'meta' }, icon('refresh', { size: 13 }), h('span', { class: 'meta-text' }));
    const metaBadge = h('span', { class: 'meta meta-sub' }, icon('sparkles', { size: 13 }), h('span', { class: 'meta-text', text: '子任务' }));
    // 有提问待回答：卡片高亮 + 徽标，配合置顶让用户一眼看到。
    const askBadge = h('span', { class: 'ask-badge' }, h('span', { class: 'ask-dot' }), h('span', { text: '需要回答' }));
    askBadge.hidden = true;

    const el = h('article', {
      class: 'task', tabindex: '0', role: 'button',
      on: {
        click: () => ctx.openTask(task.id),
        keydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ctx.openTask(task.id); }
        },
      },
    },
    h('div', { class: 'task-head' }, pill, askBadge, time),
    title,
    preview,
    h('div', { class: 'task-meta' }, metaDir, metaModel, metaTurn, metaBadge),
    );

    let last = null;
    const update = (next) => {
      if (next === last) return;
      last = next;
      const meta = statusMeta(next.status);
      el.dataset.status = next.status;
      el.dataset.id = next.id;
      const awaiting = next.awaiting === true;
      el.classList.toggle('awaiting', awaiting);
      askBadge.hidden = !awaiting;
      pill.className = `pill ${meta.cls}`;
      pill.querySelector('.pill-text').textContent = meta.label;
      time.textContent = relTime(next.updatedAt);
      time.dataset.ts = String(Number(next.updatedAt) || 0);
      title.textContent = oneLine(next.title || '未命名任务', 80);
      const body = String(next.lastText ?? '').trim();
      preview.textContent = oneLine(plainText(body), 140);
      preview.hidden = body.length === 0;
      const dir = next.cwdName || next.cwd || '未知目录';
      metaDir.querySelector('.meta-text').textContent = dir;
      metaDir.hidden = dir.length === 0;
      const model = shortModel(next.model?.model ?? next.modelName ?? '');
      metaModel.querySelector('.meta-text').textContent = model;
      metaModel.hidden = model.length === 0;
      metaTurn.querySelector('.meta-text').textContent = next.turn ? `第 ${next.turn} 轮` : '';
      metaTurn.hidden = !next.turn;
      metaBadge.hidden = next.isSubagent !== true;
      if (next.status === 'error' && next.statusReason) {
        el.dataset.reason = oneLine(next.statusReason, 60);
      } else {
        delete el.dataset.reason;
      }
    };
    update(task);
    return { el, update };
  }

  /**
   * 需要用户回答的会话置顶。
   *
   * 这是列表里唯一「卡在等你」的状态：沉在几十条历史里等于没人处理。
   * 其余顺序保持后端给的顺序（已按更新时间排过），不重新发明排序规则。
   */
  function sortAwaitingFirst(items) {
    const first = [];
    const rest = [];
    for (const task of items) (task.awaiting === true ? first : rest).push(task);
    return first.length === 0 ? items : [...first, ...rest];
  }

  const listView = keyedList(list, (task) => task.id);
  const paint = raf(() => {
    const perf = globalThis.__POCKET_PERF__;
    const startedAt = perf === undefined ? 0 : perf.now();
    const items = sortAwaitingFirst(visibleTasks());
    listView.set(items, createCard);

    if (store.loading && items.length === 0) {
      if (list.querySelector('.skeleton-card') === null) {
        list.append(skeletonCard(), skeletonCard(), skeletonCard());
      }
    } else {
      for (const node of list.querySelectorAll('.skeleton-card')) node.remove();
    }

    if (!store.loading && items.length === 0) {
      if (list.querySelector('.empty') === null) {
        const filtered = store.query.length > 0 || store.filter !== 'all';
        list.append(emptyState({
          iconName: filtered ? 'search' : 'sparkles',
          title: store.loadError ? '读取失败' : (filtered ? '没有符合条件的任务' : '还没有任务'),
          desc: store.loadError || (filtered ? '换个筛选条件或清空搜索试试' : '点右下角的 ＋ 在电脑上开一个'),
          action: filtered ? { label: '清空筛选', run: () => ctx.clearFilters() } : { label: '新建任务', run: () => ctx.navigate('/new') },
        }));
      }
    } else {
      for (const node of list.querySelectorAll('.empty')) node.remove();
    }

    endNote.textContent = items.length > 0 && items.length >= store.order.length
      ? `共 ${store.order.length} 个任务`
      : '';
    updateChrome();
    if (perf !== undefined) perf.record('list.paint', startedAt, { cards: items.length });
  });

  /* ---------------- chrome ---------------- */

  const connLabels = {
    online: '实时同步中',
    connecting: '正在连接…',
    offline: '连接中断，正在重试',
    polling: '轮询同步中',
  };

  function updateChrome() {
    // One source of truth: the list the user is actually looking at. The host's
    // `total` also counts sub-agent sessions, which the list hides by default,
    // so mixing the two makes the numbers disagree with the cards.
    const local = filterCounts();
    let today = 0;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    for (const task of store.tasks.values()) {
      // 与「全部」保持同一集合（filterCounts 排除子代理），否则两个数字会自相矛盾。
      if (task.isSubagent === true) continue;
      if ((Number(task.createdAt) || 0) >= midnight.getTime()) today += 1;
    }
    counts.all = local.all;
    counts.running = local.running;
    counts.done = local.done;
    counts.error = local.error;

    statValues.running.textContent = String(local.running);
    statValues.today.textContent = String(today);
    statValues.all.textContent = String(local.all);
    statValues.error.textContent = String(local.error);
    statValues.error.parentElement.classList.toggle('is-danger', local.error > 0);

    for (const [id, entry] of chips) {
      entry.el.classList.toggle('active', store.filter === id);
      entry.el.setAttribute('aria-selected', String(store.filter === id));
      entry.badge.textContent = id === 'running' ? String(local.running)
        : id === 'done' ? String(local.done)
          : id === 'error' ? String(local.error)
            : String(local.all);
    }

    connText.textContent = `${serverName()} · ${connLabels[store.connState] ?? '连接中'}`;
    connDot.dataset.state = store.connState;
    document.title = `${local.running > 0 ? `(${local.running}) ` : ''}DSH 随行`;
  }

  /* ---------------- pull to refresh ---------------- */

  let startY = null;
  let pulled = 0;
  scroll.addEventListener('touchstart', (event) => {
    if (scroll.scrollTop > 0 || event.touches.length !== 1) return;
    startY = event.touches[0].clientY;
    pulled = 0;
  }, { passive: true });
  scroll.addEventListener('touchmove', (event) => {
    if (startY === null) return;
    pulled = Math.max(0, event.touches[0].clientY - startY);
    if (pulled > 8) {
      pullHint.style.height = `${Math.min(56, pulled * 0.6)}px`;
      pullHint.textContent = pulled > 64 ? '松开刷新' : '下拉刷新';
    }
  }, { passive: true });
  scroll.addEventListener('touchend', () => {
    if (startY === null) return;
    const shouldRefresh = pulled > 64;
    startY = null;
    pullHint.style.height = '0px';
    pullHint.textContent = '';
    if (shouldRefresh) { haptic(12); ctx.refresh(); }
  }, { passive: true });

  return {
    screen: shell,
    paint,
    destroy() { listView.clear(); },
    focusSearch() { searchBar.hidden = false; searchInput.focus(); },
    hideSearch() { searchBar.hidden = true; searchInput.value = ''; },
    scrollTop() { scroll.scrollTop = 0; },
  };
}

export { LIMITS };
