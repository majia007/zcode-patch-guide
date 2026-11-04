// 缺口: 左侧任务列表的「项目」分区只能按手动拖拽顺序排列, 没有名称/更新时间排序,
// 也没有项目名筛选; 项目行图标无法体现"该项目下有任务正在运行"; 项目行操作组没有
// "移到最上方"的快捷入口(置顶会移到独立列表, 与拖拽到顶部不是一回事)。
//
// 本脚本随 index.html 注入渲染进程(早于应用代码执行), 全部基于 DOM + React fiber:
//   1. 分区标题右侧 hover 操作区加三个按钮: 名称排序 / 最近更新时间排序 / 筛选项目。
//      排序用 CSS order 做视觉覆盖(不改写用户手动顺序), 筛选按项目名过滤。
//   2. 项目行右侧动作组("..." 菜单旁)加"移到最上方": 复用应用自身的顺序持久化
//      (localStorage zcode-project-sidebar-preferences 的 order 数组 + 合成 storage 事件),
//      等价于手动拖拽到顶部, 不改 pinned。
//   3. 项目下存在运行中任务时, 项目行左侧文件夹图标换成旋转加载图标。
//     运行态从 React fiber 的 memoizedProps.tasks[].__zcodeSessionActivity.phase 读取
//     折叠项目也拿得到, 不依赖任务行是否渲染)。
//
// 开关: localStorage.setItem('zcode:project-tools:enabled','0') 后刷新(默认开启)。
// 运行时停用: window.__zcodeProjectTools.stop()。
// 依赖: section[data-project-id] / data-project-host / data-project-name /
//       data-testid=project-section / virtual-project-toggle(-all) / virtual-project-actions /
//       __zcodeSessionActivity / zcode-project-sidebar-preferences / React fiber。
//       升级后按 maps/anchors.md 抽查。
(() => {
  const W = window;
  if (W.__zcodeProjectTools) W.__zcodeProjectTools.stop();
  if (localStorage.getItem('zcode:project-tools:enabled') === '0') return;

  const STYLE_ID = 'zcode-project-tools-style';
  const PREFS_KEY = 'zcode-project-sidebar-preferences';
  const SORT_KEY = 'zcode:project-tools:sort';

  // name: 名称正序/倒序; updated: 最近任务更新时间 新→旧(仅此一档); manual: 应用原有手动顺序
  const loadSort = () => {
    try {
      const v = JSON.parse(localStorage.getItem(SORT_KEY) || '');
      // 时间排序只有 新→旧 一档, 历史值 dir=1 也归一到倒序
      if (v && v.mode === 'updated') return { mode: 'updated', dir: -1 };
      if (v && v.mode === 'name' && (v.dir === 1 || v.dir === -1)) return { mode: 'name', dir: v.dir };
    } catch (e) {}
    return { mode: 'manual', dir: 1 };
  };
  const saveSort = () => {
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(sort));
    } catch (e) {}
  };

  let sort = loadSort();
  const filter = { open: false, q: '' };

  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  };

  // 项目行 section 的 fiber 上层带 MCt/NCt 的 props: {project, tasks}
  const projectDataOf = (sec) => {
    let f = fiberOf(sec);
    for (let i = 0; i < 16 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && Array.isArray(p.tasks) && p.project) return { project: p.project, tasks: p.tasks };
    }
    return null;
  };

  const isRunning = (task) => {
    const act = task && task.__zcodeSessionActivity;
    if (act && (act.phase === 'running' || act.phase === 'prewarming')) return true;
    return !!task && task.status === 'running';
  };

  const metaOf = (sec) => {
    const data = projectDataOf(sec);
    const tasks = data ? data.tasks : [];
    let latest = 0;
    let running = false;
    for (const t of tasks) {
      if (!t) continue;
      if ((t.updatedAt || 0) > latest) latest = t.updatedAt || 0;
      if (isRunning(t)) running = true;
    }
    const project = data && data.project;
    return {
      host: sec.getAttribute('data-project-host') || (project && project.hostId) || 'local',
      id: sec.getAttribute('data-project-id') || (project && project.id) || '',
      name: sec.getAttribute('data-project-name') || (project && project.name) || '',
      latest,
      running,
    };
  };

  // 正序/倒序用不同图标区分; off=未启用(手动顺序)时用中性图标
  const ICON_NAME_OFF =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><path d="m21 16-4 4-4-4"></path><path d="M17 20V4"></path><path d="m3 8 4-4 4 4"></path><path d="M7 4v16"></path></svg>';
  const ICON_NAME_ASC =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><path d="m3 16 4 4 4-4"></path><path d="M7 20V4"></path><path d="M20 8h-5"></path><path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10"></path><path d="M15 14h5l-5 6h5"></path></svg>';
  const ICON_NAME_DESC =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><path d="m3 8 4-4 4 4"></path><path d="M7 4v16"></path><path d="M15 4h5l-5 6h5"></path><path d="M15 20v-3.5a2.5 2.5 0 0 1 5 0V20"></path><path d="M20 18h-5"></path></svg>';
  const ICON_CLOCK_OFF =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>';
  const ICON_CLOCK_DESC =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><path d="M12 6v6l2 1"></path><path d="M12.337 21.994a10 10 0 1 1 9.588-8.767"></path><path d="m14 18 4 4 4-4"></path><path d="M18 14v8"></path></svg>';

  const SORT_ICONS = {
    name: { off: ICON_NAME_OFF, 1: ICON_NAME_ASC, '-1': ICON_NAME_DESC },
    // 时间排序只有 新→旧 一个档位, 正反两值共用倒序图标
    updated: { off: ICON_CLOCK_OFF, 1: ICON_CLOCK_DESC, '-1': ICON_CLOCK_DESC },
  };
  const SORT_TITLES = {
    name: { off: '按项目名称排序', 1: '名称正序（A→Z）；点击切换倒序', '-1': '名称倒序（Z→A）；点击取消排序' },
    updated: { off: '按最近更新时间排序', 1: '时间倒序（新→旧）；点击取消排序', '-1': '时间倒序（新→旧）；点击取消排序' },
  };

  const ICON_FILTER =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg>';
  const ICON_TOP =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><path d="M5 3h14"></path><path d="m18 13-6-6-6 6"></path><path d="M12 7v14"></path></svg>';
  // 与任务行的运行标记同款: lucide loader(8 段放射线) + animate-spin(1s linear)
  const ICON_SPINNER =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader size-4 text-foreground-subtle" aria-hidden="true"><path d="M12 2v4"></path><path d="m16.2 7.8 2.9-2.9"></path><path d="M18 12h4"></path><path d="m16.2 16.2 2.9 2.9"></path><path d="M12 18v4"></path><path d="m4.9 19.1 2.9-2.9"></path><path d="M2 12h4"></path><path d="m4.9 4.9 2.9 2.9"></path></svg>';

  const ICON_CLEAR =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';

  // 按钮样式直接从应用现有按钮复制: 主题类名跨版本会变, 复制实态最稳
  const btnClass = (root, selector) => {
    const el = root.querySelector(selector);
    return el ? el.className : '';
  };

  const makeButton = (cls, action, title, svg) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.setAttribute('data-zqp-action', action);
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
    btn.innerHTML = svg;
    return btn;
  };

  const makeFilterRow = () => {
    const row = document.createElement('div');
    row.setAttribute('data-zqp-filter-row', '1');
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-zqp-filter-input', '1');
    input.setAttribute('placeholder', '按项目名称筛选');
    input.setAttribute('spellcheck', 'false');
    row.appendChild(input);
    // ESC 在生成中会被 block-esc 吞掉, 清空入口必须有可点的按钮
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'zqp-filter-clear';
    clear.setAttribute('data-zqp-action', 'clear-filter');
    clear.setAttribute('title', '清除并收起筛选');
    clear.setAttribute('aria-label', '清除并收起筛选');
    clear.innerHTML = ICON_CLEAR;
    row.appendChild(clear);
    return row;
  };

  // 排序按钮三态: off(手动)/1(正序)/-1(倒序), 图标与提示随状态切换
  const syncSortButton = (btn, mode) => {
    if (!btn) return;
    const state = sort.mode === mode ? String(sort.dir) : 'off';
    if (btn.getAttribute('data-zqp-state') !== state) {
      btn.setAttribute('data-zqp-state', state);
      btn.innerHTML = SORT_ICONS[mode][state];
      const title = SORT_TITLES[mode][state];
      btn.setAttribute('title', title);
      btn.setAttribute('aria-label', title);
    }
    btn.setAttribute('data-zqp-active', state === 'off' ? '0' : '1');
  };

  // 分区标题: 加入三个按钮与筛选输入行(React 重建后由周期扫描补回)
  const syncSectionChrome = (sec) => {
    const col = sec.firstElementChild;
    if (!col || col.getAttribute('data-slot') !== 'collapsible') return;
    const headerRow = col.children[0];
    const actions = headerRow && headerRow.children[1];
    if (!actions) return;
    actions.setAttribute('data-zqp-actions', '1');

    if (!actions.querySelector('[data-zqp-action="name"]')) {
      const cls = btnClass(actions, 'button');
      const frag = document.createDocumentFragment();
      frag.appendChild(makeButton(cls, 'name', SORT_TITLES.name.off, ICON_NAME_OFF));
      frag.appendChild(makeButton(cls, 'updated', SORT_TITLES.updated.off, ICON_CLOCK_OFF));
      frag.appendChild(makeButton(cls, 'filter', '筛选项目', ICON_FILTER));
      actions.insertBefore(frag, actions.firstChild);
    }
    syncSortButton(actions.querySelector('[data-zqp-action="name"]'), 'name');
    syncSortButton(actions.querySelector('[data-zqp-action="updated"]'), 'updated');
    const filterBtn = actions.querySelector('[data-zqp-action="filter"]');
    if (filterBtn) filterBtn.setAttribute('data-zqp-active', filter.open ? '1' : '0');

    let row = col.querySelector(':scope > [data-zqp-filter-row]');
    if (!row) {
      row = makeFilterRow();
      col.insertBefore(row, headerRow.nextSibling);
    }
    row.setAttribute('data-zqp-open', filter.open ? '1' : '0');
    const input = row.querySelector('[data-zqp-filter-input]');
    if (input && input.value !== filter.q) input.value = filter.q;
  };

  // 项目行: 右侧动作组加"移到最上方", 左侧图标位按运行态换 spinner
  const syncRowChrome = (sec, meta) => {
    const actions = sec.querySelector(':scope > [data-testid="virtual-project-row"] [data-testid="virtual-project-actions"]');
    if (actions && !actions.querySelector('[data-zqp-action="top"]')) {
      const cls = btnClass(actions, 'button');
      actions.insertBefore(makeButton(cls, 'top', '移到最上方', ICON_TOP), actions.firstChild);
    }

    const iconBox = sec.querySelector(':scope > [data-testid="virtual-project-row"] button[data-testid="virtual-project-toggle"] > span[aria-hidden="true"]');
    if (iconBox) {
      iconBox.setAttribute('data-zqp-icon', '1');
      let spin = iconBox.querySelector('[data-zqp-spinner]');
      if (!spin) {
        spin = document.createElement('span');
        spin.setAttribute('data-zqp-spinner', '1');
        spin.className = 'zqp-spinner animate-spin';
        spin.innerHTML = ICON_SPINNER;
        iconBox.appendChild(spin);
      }
    }
    sec.setAttribute('data-zqp-running', meta.running ? '1' : '0');
  };

  const byName = (a, b) =>
    a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });

  // 列表容器改成 flex 列才能用 order 视觉排序; 只允许"全是项目行 + 不影响布局的占位"
  // 的容器(dnd-kit 会塞 display:none / 1px sr-only 活区), 出现别的可见兄弟节点
  // (未来的"显示更多"等)就放弃排序, 免得打乱布局。
  const flexCache = new WeakMap();
  const canFlex = (parent) => {
    const now = Date.now();
    const c = flexCache.get(parent);
    if (c && c.n === parent.children.length && now - c.t < 1000) return c.ok;
    let ok = true;
    for (const el of parent.children) {
      if (el.matches('section[data-project-id]')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 1 || r.width <= 1) continue;
      ok = false;
      break;
    }
    flexCache.set(parent, { n: parent.children.length, t: now, ok });
    return ok;
  };

  const apply = () => {
    const sections = [...document.querySelectorAll('section[data-project-id]')];
    const groups = new Map();
    for (const sec of sections) {
      const parent = sec.parentElement;
      if (!parent) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(sec);
    }

    const q = filter.q.trim().toLocaleLowerCase();
    let visible = 0;
    for (const [parent, list] of groups) {
      const metas = list.map((sec) => ({ sec, meta: metaOf(sec) }));

      for (const { sec, meta } of metas) {
        syncRowChrome(sec, meta);
        const hit = !q || meta.name.toLocaleLowerCase().includes(q);
        if (hit) visible++;
        if (hit) sec.removeAttribute('data-zqp-hidden');
        else sec.setAttribute('data-zqp-hidden', '1');
      }

      if (sort.mode === 'manual' || !canFlex(parent)) {
        parent.removeAttribute('data-zqp-list');
        for (const { sec } of metas) {
          if (sec.style.order) sec.style.order = '';
        }
      } else {
        const dir = sort.dir;
        metas.sort((a, b) => {
          if (sort.mode === 'name') return dir * byName(a.meta, b.meta);
          return dir * ((a.meta.latest || 0) - (b.meta.latest || 0)) || byName(a.meta, b.meta);
        });
        parent.setAttribute('data-zqp-list', '1');
        metas.forEach((m, i) => {
          m.sec.style.order = String(i + 1);
        });
      }
    }

    // 筛选无结果提示(挂在筛选行上)
    document.querySelectorAll('[data-zqp-filter-row]').forEach((row) => {
      row.setAttribute('data-zqp-empty', filter.open && q && !visible ? '1' : '0');
    });

    applyChrome();
  };

  const applyChrome = () => {
    const sec = document.querySelector('[data-testid="project-section"]');
    if (sec) syncSectionChrome(sec);
  };

  // ---- 交互 ----
  // 名称: 正序 → 倒序 → 取消; 时间: 新→旧 ↔ 取消 两态
  const toggleSort = (mode) => {
    if (mode === 'updated') {
      sort = sort.mode === 'updated' ? { mode: 'manual', dir: 1 } : { mode: 'updated', dir: -1 };
    } else if (sort.mode !== mode) sort = { mode, dir: 1 };
    else if (sort.dir === 1) sort = { mode, dir: -1 };
    else sort = { mode: 'manual', dir: 1 };
    saveSort();
    apply();
  };

  const openFilter = () => {
    filter.open = true;
    // 分区收起时筛选行被 CSS 隐藏, 先展开分区, 否则输入框不可见
    const sec = document.querySelector('[data-testid="project-section"]');
    const col = sec && sec.firstElementChild;
    if (col && col.getAttribute('data-state') !== 'open') {
      const trig = col.querySelector('[data-slot="collapsible-trigger"]');
      if (trig) trig.click();
    }
    apply();
    const focus = () => {
      const input = document.querySelector('[data-zqp-filter-input]');
      if (input) {
        input.focus();
        input.select();
      }
    };
    focus();
    requestAnimationFrame(focus);
  };

  const closeFilter = () => {
    filter.open = false;
    filter.q = '';
    apply();
  };

  // 等价于把项目手动拖到同组第一格: 只改 zcode-project-sidebar-preferences.order,
  // 再合成 storage 事件让应用自身 store 立刻采用(不触碰 pinned)
  const moveToTop = (sec) => {
    if (!sec) return;
    const host = sec.getAttribute('data-project-host') || 'local';
    const id = sec.getAttribute('data-project-id') || '';
    const key = JSON.stringify([host, id]);
    const parent = sec.parentElement;
    if (!parent) return;
    const groupKeys = [...parent.children]
      .filter((el) => el.matches && el.matches('section[data-project-id]'))
      .map((el) => JSON.stringify([el.getAttribute('data-project-host') || 'local', el.getAttribute('data-project-id') || '']));
    if (groupKeys.length < 2) return;

    let prefs = {};
    try {
      prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '') || {};
    } catch (e) {
      prefs = {};
    }
    const order = Array.isArray(prefs.order) ? prefs.order.slice() : [];
    const gset = new Set(groupKeys);
    const cur = order.filter((k) => gset.has(k));
    for (const k of groupKeys) if (!cur.includes(k)) cur.push(k);
    const nextGroup = [key, ...cur.filter((k) => k !== key)];
    // 应用侧 Nht/oF 的等价实现: 组内槽位整体换成新顺序, 组外条目原位不动
    const union = [...new Set([...order, ...groupKeys])];
    let gi = 0;
    const nextOrder = union.map((k) => (gset.has(k) ? nextGroup[gi++] : k));
    const nextPrefs = { ...prefs, order: nextOrder };
    const val = JSON.stringify(nextPrefs);
    try {
      localStorage.setItem(PREFS_KEY, val);
    } catch (e) {
      return;
    }
    // 排序视图下移顶看不到效果, 顺带回到手动顺序
    sort = { mode: 'manual', dir: 1 };
    saveSort();
    try {
      W.dispatchEvent(new StorageEvent('storage', { key: PREFS_KEY, newValue: val, url: location.href }));
    } catch (e) {}
    apply();
  };

  const onClick = (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-zqp-action]') : null;
    if (!btn) return;
    const action = btn.getAttribute('data-zqp-action');
    e.preventDefault();
    e.stopPropagation();
    if (action === 'name' || action === 'updated') toggleSort(action);
    else if (action === 'filter') {
      if (filter.open) closeFilter();
      else openFilter();
    } else if (action === 'clear-filter') {
      // 清除即收起输入框
      closeFilter();
    } else if (action === 'top') moveToTop(btn.closest('section[data-project-id]'));
  };

  const onInput = (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches('[data-zqp-filter-input]')) return;
    filter.q = t.value;
    apply();
  };

  const onKeyDown = (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches('[data-zqp-filter-input]')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFilter();
    }
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [data-zqp-list="1"] { display: flex !important; flex-direction: column; }
      /* 操作区原生按钮紧贴(间距只靠图标内缩), 激活态背景会连成一片; 显式补 2px 间隙 */
      [data-zqp-actions="1"] { gap: 2px; }
      [data-zqp-hidden="1"] { display: none !important; }
      [data-zqp-active="1"] { color: var(--color-foreground) !important; background-color: var(--color-hover) !important; }
      [data-zqp-filter-row] { display: none; position: relative; margin: 0 0 4px 8px; }
      [data-zqp-filter-row][data-zqp-open="1"] { display: block; }
      [data-slot="collapsible"][data-state="closed"] [data-zqp-filter-row] { display: none !important; }
      [data-zqp-filter-input] {
        width: 100%; height: 28px; box-sizing: border-box; padding: 0 28px 0 8px;
        font: inherit; font-size: var(--text-ui-sm); color: var(--color-foreground);
        background: var(--color-surface-hover); border: 1px solid var(--color-border);
        border-radius: 8px; outline: none;
      }
      [data-zqp-filter-input]:focus { border-color: var(--color-border-hover); }
      [data-zqp-filter-input]::placeholder { color: var(--color-foreground-subtle); }
      .zqp-filter-clear {
        position: absolute; right: 2px; top: 2px; display: flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
        color: var(--color-foreground-subtle); background: transparent; cursor: pointer;
      }
      .zqp-filter-clear:hover { color: var(--color-foreground); background: var(--color-hover); }
      [data-zqp-filter-row][data-zqp-empty="1"]::after {
        content: "无匹配项目"; display: block; padding: 4px 8px 0;
        font-size: var(--text-ui-sm); color: var(--color-foreground-subtle);
      }
      [data-zqp-running="1"] [data-zqp-icon] > span.inline-flex { display: none !important; }
      [data-zqp-icon] .zqp-spinner { display: none; align-items: center; justify-content: center; }
      [data-zqp-running="1"] [data-zqp-icon] .zqp-spinner { display: inline-flex; }
    `;
    document.head.appendChild(style);
  };

  let raf = 0;
  const observer = new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      apply();
    });
  });
  let timer = 0;

  const start = () => {
    if (!document.body) return;
    ensureStyle();
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    applyChrome();
    apply();
    observer.observe(document.body, { childList: true, subtree: true });
    timer = setInterval(apply, 1500);
  };

  const stop = () => {
    observer.disconnect();
    if (raf) cancelAnimationFrame(raf);
    if (timer) clearInterval(timer);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.querySelectorAll('[data-zqp-action]').forEach((el) => el.remove());
    document.querySelectorAll('[data-zqp-filter-row]').forEach((el) => el.remove());
    document.querySelectorAll('[data-zqp-spinner]').forEach((el) => el.remove());
    document.querySelectorAll('[data-zqp-icon]').forEach((el) => el.removeAttribute('data-zqp-icon'));
    const sections = document.querySelectorAll('[data-project-id]');
    for (const sec of sections) {
      sec.removeAttribute('data-zqp-running');
      sec.removeAttribute('data-zqp-hidden');
      if (sec.style.order) sec.style.order = '';
    }
    document.querySelectorAll('[data-zqp-list]').forEach((el) => el.removeAttribute('data-zqp-list'));
    document.querySelectorAll('[data-zqp-actions]').forEach((el) => el.removeAttribute('data-zqp-actions'));
    const s = document.getElementById(STYLE_ID);
    if (s) s.remove();
    delete W.__zcodeProjectTools;
  };

  W.__zcodeProjectTools = { stop, apply, start };

  // 注入点在 head 末尾, 执行时 body 尚未解析; 等 DOM 就绪再启动
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
