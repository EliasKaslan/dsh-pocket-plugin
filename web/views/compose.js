/** New task screen: prompt, quick starts, working directory, preset. */
import { $, debounce, h, icon } from '../lib/dom.js';
import { oneLine } from '../lib/format.js';
import { actionSheet, haptic, toast } from '../lib/ui.js';
import { LIMITS, store } from '../store.js';

const QUICK = [
  { icon: 'search', label: '看一遍当前项目', text: '先浏览当前工作目录，用中文总结这个项目是做什么的、主要目录各自负责什么。' },
  { icon: 'alert', label: '排查一个报错', text: '我遇到一个报错，先帮我定位原因再修：\n\n' },
  { icon: 'edit', label: '写一个小功能', text: '帮我实现一个小功能：\n\n要求：\n- \n' },
  { icon: 'terminal', label: '跑一遍测试', text: '跑一遍项目里的测试，把失败的用例逐个定位并修复。' },
];

export function mountCompose(root, ctx) {
  const prompt = h('textarea', {
    class: 'prompt-input', id: 'prompt-input', rows: '4',
    placeholder: '想让电脑做什么？写清楚目标、范围和不许动的东西。',
    maxlength: String(LIMITS.promptChars),
  });
  const counter = h('span', { class: 'counter', text: `0 / ${LIMITS.promptChars}` });
  const quickRow = h('div', { class: 'quick-row' });
  const cwdValue = h('span', { class: 'field-value', text: '选择目录' });
  const presetValue = h('span', { class: 'field-value', text: '默认预设' });
  const submit = h('button', { class: 'btn btn-primary create-btn', type: 'button' }, icon('send', { size: 18 }), h('span', { text: '下发到电脑' }));

  const fieldCwd = h('button', { class: 'field', type: 'button', on: { click: () => void pickWorkspace() } },
    h('span', { class: 'field-icon' }, icon('folder', { size: 18 })),
    h('span', { class: 'field-main' }, h('span', { class: 'field-label', text: '工作目录' }), cwdValue),
    icon('chevron', { size: 18 }),
  );
  const fieldPreset = h('button', { class: 'field', type: 'button', on: { click: () => void pickPreset() } },
    h('span', { class: 'field-icon' }, icon('sparkles', { size: 18 })),
    h('span', { class: 'field-main' }, h('span', { class: 'field-label', text: 'Agent 预设' }), presetValue),
    icon('chevron', { size: 18 }),
  );

  const screen = h('div', { class: 'screen screen-compose' },
      h('header', { class: 'compose-header' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '返回', on: { click: () => ctx.back() } }, icon('back')),
        h('h1', { text: '新建任务' }),
        h('span', { class: 'compose-spacer' }),
      ),
      h('div', { class: 'scroll compose-scroll' },
        h('div', { class: 'prompt-card' }, prompt, h('div', { class: 'prompt-foot' }, counter)),
        h('div', { class: 'section-label', text: '快速开始' }),
        quickRow,
        h('div', { class: 'section-label', text: '运行位置' }),
        fieldCwd,
        fieldPreset,
        h('p', { class: 'compose-note', text: '任务在电脑上执行，手机只是遥控器。目录决定它能改哪些文件。' }),
        h('div', { class: 'create-spacer' }),
      ),
      h('div', { class: 'create-bar' }, submit),
  );
  root.append(screen);

  for (const item of QUICK) {
    quickRow.append(h('button', {
      class: 'quick-chip', type: 'button',
      on: { click: () => { haptic(); prompt.value = item.text; prompt.focus(); prompt.setSelectionRange(prompt.value.length, prompt.value.length); syncCounter(); } },
    }, icon(item.icon, { size: 16 }), h('span', { text: item.label })));
  }

  function syncCounter() {
    const length = prompt.value.length;
    counter.textContent = `${length} / ${LIMITS.promptChars}`;
    counter.classList.toggle('warn', length > LIMITS.promptChars * 0.9);
    submit.disabled = prompt.value.trim().length === 0 || store.draft.cwd.length === 0;
  }

  prompt.addEventListener('input', debounce(() => { store.draft.text = prompt.value; syncCounter(); }, 120));
  prompt.addEventListener('input', syncCounter);

  function paintFields() {
    cwdValue.textContent = store.draft.cwd || '选择目录';
    cwdValue.classList.toggle('placeholder', store.draft.cwd.length === 0);
    const preset = store.presets.find((item) => item.id === store.draft.preset);
    presetValue.textContent = preset?.name ?? '默认预设';
    presetValue.classList.toggle('placeholder', preset === undefined);
    submit.disabled = prompt.value.trim().length === 0 || store.draft.cwd.length === 0;
  }

  async function pickWorkspace() {
    const items = store.workspaces.map((workspace) => ({
      // recent = 只在历史会话里出现过、但 DSH 里没有对应工作区的目录。
      // 选它新建任务，电脑端会归到「未分组」——必须让用户看得见这个后果。
      label: `${workspace.title || workspace.name || workspace.path}`
        + `${workspace.recent === true ? '（未注册工作区·会归到未分组）' : ''}`
        + `${workspace.available === false ? '（不可用）' : ''}`,
      icon: 'folder',
      disabled: workspace.available === false,
      run: () => { store.draft.cwd = workspace.path; paintFields(); },
    }));
    if (items.length === 0) { toast('电脑上还没有可用目录', { tone: 'danger' }); return; }
    const picked = await actionSheet({ title: '选择工作目录', items });
    if (picked !== null) picked.run();
  }

  async function pickPreset() {
    const items = [{ label: '默认预设', icon: 'sparkles', run: () => { store.draft.preset = ''; paintFields(); } }];
    for (const preset of store.presets) {
      items.push({ label: preset.name ?? preset.id, icon: 'sparkles', run: () => { store.draft.preset = preset.id; paintFields(); } });
    }
    const picked = await actionSheet({ title: '选择 Agent 预设', items });
    if (picked !== null) picked.run();
  }

  submit.addEventListener('click', () => void create());

  async function create() {
    const text = prompt.value.trim();
    if (text.length === 0) { toast('先写点任务内容', { tone: 'danger' }); prompt.focus(); return; }
    if (store.draft.cwd.length === 0) { toast('请选择工作目录', { tone: 'danger' }); void pickWorkspace(); return; }
    if (store.creating === true) return;
    store.creating = true;
    submit.disabled = true;
    submit.querySelector('span').textContent = '正在下发…';
    // Reuse the same clientTaskId across retries so a flaky link cannot create
    // two tasks for one tap.
    if (!store.draft.clientTaskId) store.draft.clientTaskId = `ct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      const data = await ctx.api('/api/v1/tasks', {
        method: 'POST',
        body: {
          prompt: text,
          cwd: store.draft.cwd,
          preset: store.draft.preset || undefined,
          clientTaskId: store.draft.clientTaskId,
        },
      });
      const task = data?.task;
      haptic(16);
      toast('任务已下发', { tone: 'ok' });
      prompt.value = '';
      store.draft.text = '';
      store.draft.clientTaskId = '';
      ctx.savedCwd(store.draft.cwd);
      if (task?.id) ctx.navigate(`/task/${encodeURIComponent(task.id)}`);
      else ctx.navigate('/tasks');
    } catch (error) {
      toast(error?.message ?? '下发失败', { tone: 'danger' });
    } finally {
      store.creating = false;
      submit.querySelector('span').textContent = '下发到电脑';
      submit.disabled = false;
      syncCounter();
    }
  }

  return {
    screen,
    paint() {
      // 输入框正在被编辑时绝不回写：input 有 120ms 防抖，用旧的 draft 覆盖会把
    // 刚敲进去还没落盘的字符吞掉，并让光标跳到末尾（用户看到的是「真丢字」）。
    if (document.activeElement !== prompt && prompt.value !== store.draft.text) prompt.value = store.draft.text;
      syncCounter();
      paintFields();
    },
    destroy() {},
    focusPrompt() { prompt.focus(); },
  };
}
