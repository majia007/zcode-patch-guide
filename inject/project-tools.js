// 缺口: 左侧任务列表的「项目」分区只能按手动拖拽顺序排列, 没有名称/更新时间排序,
// 也没有项目名筛选; 项目行图标无法体现"该项目下有任务正在运行"; 项目行操作组没有
// "移到最上方"的快捷入口(置顶会移到独立列表, 与拖拽到顶部不是一回事); 任务行状态
// 指示器只认 phase, 不消费 __zcodeSessionActivity.hasBackgroundWork —— 会话空闲但
// 后台任务仍在跑的行虽被原生活跃排序置顶, 外观上却无任何标记; 任务行右侧相对时间
// 只按 task.updatedAt 计算 —— 该字段运行期冻结在 ingest 时刻(2026-11-12 CDP 实证:
// 流式中的会话 updatedAt 恒停在 turn 开始前不推进), 流式进行时时间显示持续漂旧;
// 任务顺序随 updatedAt 变化实时跳变, 鼠标悬停期间行会在指针下移位。
//
// 本脚本随 index.html 注入渲染进程(早于应用代码执行), 全部基于 DOM + React fiber:
//   1. 分区标题的项目名筛选, 双形态按标题行富余宽度自动切换:
//      宽(富余容纳最小输入框) — 输入框常驻操作区最前(标题与排序按钮之间, 随操作区
//      hover/focus-within 显隐, 原生 actions 容器 opacity-0 + group-* 类自带该行为),
//      占据标题行全部富余宽度(标题退到内容宽, actions 参与 grow), 输入即筛, 有内容
//      时框内右侧出 × 清空;
//      窄 — 退回按钮形态(操作区最前"筛选"按钮), 点击在标题下方展开输入行(同款
//      无边框深色样式), ×/ESC 清除并收起。
//      操作区另加两个排序按钮: 名称排序 / 最近更新时间排序, 排序用 CSS order 做视觉
//      覆盖(不改写用户手动顺序)。
//   2. 项目行右侧动作组("..." 菜单旁)加"移到最上方": 复用应用自身的顺序持久化
//      (localStorage zcode-project-sidebar-preferences 的 order 数组 + 合成 storage 事件),
//      等价于手动拖拽到顶部, 不改 pinned。
//   3. 项目下存在运行中任务时, 项目名称右侧追加旋转加载图标(挂名称容器末尾, 间距沿用原生 gap-2)。
//     运行态从 React fiber 的 memoizedProps.tasks[].__zcodeSessionActivity.phase 读取
//     折叠项目也拿得到, 不依赖任务行是否渲染)。
//   4. 任务行(li[data-task-item-key])沿 fiber 读 props.task 的 __zcodeSessionActivity:
//      hasBackgroundWork===true 且 phase 非 running/prewarming(会话空闲但后台任务在跑)
//      时行打 data-zqp-bg, 行首状态格(原生指示器位, 空闲时为空位)补静态终端图标 ——
//      与前台运行的旋转 loader 图形/尺寸双区分; 前台运行中不叠加(原生 spinner 已表达),
//      error 圆点可并存。分组视图行(div)无独立状态格, 暂不标记。activity 变化不必然
//      伴随 DOM 变化, 轮询是主刷新通道, observer 只管行重建补图标。
//   5. 项目展开区任务列表(数据链实证: 每个任务独占一套 包装层>div[data-testid=task-list]>
//      ...>li 子树, 排序单位是包装层; 容器子节点全为任务包装层或尾部「显示更多」
//      BUTTON; 首屏只渲染前 5 个任务, fiber tasks 数多于渲染行数):
//      (a) 行右侧时间按"实际活跃时刻"改写 = max(updatedAt, activity.lastActivityAt) ——
//          lastActivityAt 随每个 step 的发送/响应/响应结束实时推进(agent 运行时
//          session facts 推送, CDP 实证流式中 0~3s 级新鲜), 原生只消费冻结的 updatedAt;
//          文案复刻原生 taskList.justNow/minutesAgo/hoursAgo/daysAgo 分桶(<1min/分/时/天),
//          五语言随 html lang 切换, 只写元信息行末子节点的文本(裸文本或纯文本包裹 span);
//      (b) 任务按同一实际时刻 新→旧 视觉排序(容器 flex 化 + 包装层 style.order, 不动
//          DOM 结构), 指针悬停列表期间冻结位置(不重算 order, 冻结期新行追加尾部),
//          移出后立即(mouseout 触发, 不等轮询)恢复按实际时刻排序; React 重渲染写回的
//          旧时间文本由下一拍周期/变更扫描重贴。项目排序(updated 模式)的"最近更新时间"
//          同口径取 max(updatedAt, lastActivityAt)。
//
// 开关: localStorage.setItem('zcode:project-tools:enabled','0') 后刷新(默认开启)。
// 任务时间/排序单独关: localStorage.setItem('zcode:project-tools:tasktime','0') 后刷新
// (关闭后下一拍还原容器排序态并把时间文本改回原生 updatedAt 口径)。
// 运行时停用: window.__zcodeProjectTools.stop()。
// 依赖: section[data-project-id] / data-project-host / data-project-name /
//       data-testid=project-section / virtual-project-toggle(-all) / virtual-project-actions /
//       __zcodeSessionActivity(含 hasBackgroundWork/lastActivityAt 字段) / li[data-task-item-key] /
//       data-task-row-metadata(时间节点=其末子节点) / data-testid=task-list(任务包装层) /
//       data-task-list-show-more(列表尾部按钮, 容器 guard 识别) /
//       zcode-project-sidebar-preferences / React fiber。
//       升级后按 maps/anchors.md 抽查。
(() => {
  const W = window;
  if (W.__zcodeProjectTools) W.__zcodeProjectTools.stop();
  if (localStorage.getItem('zcode:project-tools:enabled') === '0') return;

  const STYLE_ID = 'zcode-project-tools-style';
  const PREFS_KEY = 'zcode-project-sidebar-preferences';
  const SORT_KEY = 'zcode:project-tools:sort';
  const TASKTIME_KEY = 'zcode:project-tools:tasktime';

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

  // 任务实际活跃时刻: updatedAt 运行期冻结在 ingest 时刻(仅 host mirror ingest 推进),
  // activity.lastActivityAt 随每个 step 的发送/响应/响应结束实时推送推进; 取大值 =
  // 任务时间显示与任务/项目排序的统一口径
  const effTimeOf = (task) => {
    const act = task && task.__zcodeSessionActivity;
    return Math.max((task && task.updatedAt) || 0, (act && act.lastActivityAt) || 0);
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
      // 项目"最近更新"同任务口径: 实际活跃时刻(见 effTimeOf), 流式中的项目不漂旧
      if (effTimeOf(t) > latest) latest = effTimeOf(t);
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

  // 任务行(li)组件链上有不止一层组件 props 带 task, 取第一个命中即可:
  // activity 挂在 task 对象上, 与命中层级无关。3.18.x 行外新包 HoverCard/Popper 层,
  // props.task 推深到 ~17-19 跳(16 跳取不到 = 后台标记在该版失效的根因), 放宽到 28
  const taskOf = (li) => {
    let f = fiberOf(li);
    for (let i = 0; i < 28 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && p.task && typeof p.task === 'object') return p.task;
    }
    return null;
  };

  // 会话空闲 = phase 非 running/prewarming; 后台有活 = hasBackgroundWork===true
  // (error 圆点与后台图标可并存, 各说各的事; 前台运行中原生 spinner 已表达, 不叠加)
  const bgIdle = (task) => {
    const act = task && task.__zcodeSessionActivity;
    if (!act || act.hasBackgroundWork !== true) return false;
    return act.phase !== 'running' && act.phase !== 'prewarming';
  };

  // 任务行后台标记: 行打 data-zqp-bg, 空闲+后台有活时行首状态格(空闲时为空位)补图标
  const applyTaskMarks = () => {
    for (const li of document.querySelectorAll('[data-task-item-key]')) {
      if (li.tagName !== 'LI') continue; // 分组视图 div 行无独立状态格, 暂不标记
      const bg = bgIdle(taskOf(li));
      li.setAttribute('data-zqp-bg', bg ? '1' : '0');
      if (!bg) continue;
      const slot = li.firstElementChild; // 状态格 = 原生指示器与 pin 按钮所在(relative flex size-4)
      if (!slot || slot.tagName !== 'DIV') continue;
      if (!slot.querySelector('[data-zqp-bgmark]')) {
        const mark = document.createElement('span');
        mark.setAttribute('data-zqp-bgmark', '1');
        mark.className = 'zqp-bgmark';
        mark.setAttribute('title', '后台任务运行中');
        mark.setAttribute('aria-label', '后台任务运行中');
        mark.innerHTML = ICON_TERMINAL;
        slot.appendChild(mark);
      }
    }
  };

  // ---- 任务列表: 实际活跃时刻排序 + 悬停冻结 + 时间改写 ----

  // 原生 kM 分桶(<1min/分/时/天)与 taskList.* 文案复刻(IntlProvider 当版实测, 五语言)
  const REL_TIME = {
    zh: ['刚刚', '{n}分', '{n}小时', '{n}天'],
    en: ['now', '{n}m', '{n}h', '{n}d'],
    ja: ['たった今', '{n} 分前', '{n} 時間前', '{n} 日前'],
    ru: ['сейчас', '{n} мин', '{n} ч', '{n} дн.'],
    ko: ['지금', '{n}분', '{n}시간', '{n}일'],
  };
  const relLang = () => {
    const l = ((document.documentElement && document.documentElement.lang) || navigator.language || 'en').toLowerCase();
    for (const k of ['zh', 'en', 'ja', 'ru', 'ko']) if (l.startsWith(k)) return k;
    return 'en';
  };
  const fmtRel = (t) => {
    const tab = REL_TIME[relLang()];
    const m = Math.floor((Date.now() - t) / 6e4);
    if (m < 1) return tab[0];
    if (m < 60) return tab[1].replace('{n}', m);
    if (m < 1440) return tab[2].replace('{n}', Math.floor(m / 60));
    return tab[3].replace('{n}', Math.floor(m / 1440));
  };

  // 时间节点 = data-task-row-metadata 的末子节点(两变体都以时间收尾: 裸文本或纯文本
  // 包裹 span); 末位若是复合节点(未来形态变化)不动, 防误伤其它内容
  const setRowTime = (li, t) => {
    const meta = li.querySelector('[data-task-row-metadata]');
    const node = meta && meta.lastChild;
    if (!node) return;
    if (node.nodeType === 1 && node.firstElementChild) return;
    const txt = fmtRel(t);
    if (node.textContent !== txt) node.textContent = txt;
  };

  const applyTaskLists = () => {
    const on = localStorage.getItem(TASKTIME_KEY) !== '0';
    const containers = new Map();
    for (const li of document.querySelectorAll('section[data-project-id] li[data-task-item-key]')) {
      const task = taskOf(li);
      if (task) setRowTime(li, on ? effTimeOf(task) : task.updatedAt || 0);
      if (!on) continue;
      const listEl = li.closest('[data-testid="task-list"]');
      const wrap = listEl && listEl.parentElement; // 任务包装层 = 排序单位
      const cont = wrap && wrap.parentElement; // 列表容器(包装层 + 尾部按钮的共同父)
      if (!cont) continue;
      let g = containers.get(cont);
      if (!g) containers.set(cont, (g = { rows: [], ok: true }));
      if (g.rows.every((r) => r.wrap !== wrap)) g.rows.push({ wrap, task, key: li.getAttribute('data-task-item-key') || '' });
    }
    if (!on) {
      // 键切到关闭后的清残留(容器排序态还原, 时间文本已按原生 updatedAt 口径改写)
      for (const cont of document.querySelectorAll('[data-zqp-tasklist]')) {
        cont.removeAttribute('data-zqp-tasklist');
        for (const child of cont.children) if (child.style.order) child.style.order = '';
      }
      return;
    }
    for (const [cont, g] of containers) {
      // 容器 guard: 子节点必须全是任务包装层或 BUTTON(显示更多等), 出现其它节点放弃
      // 排序防打乱布局
      for (const child of cont.children) {
        if (child.tagName === 'BUTTON' || g.rows.some((r) => r.wrap === child)) continue;
        g.ok = false;
        break;
      }
      if (!g.ok) {
        cont.removeAttribute('data-zqp-tasklist');
        for (const r of g.rows) if (r.wrap.style.order) r.wrap.style.order = '';
        // guard 失败前可能给尾部 BUTTON 写过 order, 一并清(否则 stop() 也清不到的残留)
        for (const child of cont.children) if (child.tagName === 'BUTTON' && child.style.order) child.style.order = '';
        continue;
      }
      cont.setAttribute('data-zqp-tasklist', '1');
      if (cont.matches(':hover')) {
        // 悬停冻结: 不动既有 order(React 怎么重排 DOM, 视觉序都不变); 无 order 的新
        // 包装层(冻结期新建任务)追加到现有最大 order 之后
        let max = 0;
        for (const child of cont.children) {
          const o = parseInt(child.style.order, 10) || 0;
          if (o > max) max = o;
        }
        for (const r of g.rows) if (!r.wrap.style.order) r.wrap.style.order = String(++max);
        // 尾部按钮同拍抬到末位: 首拍即悬停(全无 order)或冻结期新建行时, 不让
        // 默认 order:0 的按钮跳到任务行上方/被新行挤到后面
        for (const child of cont.children) {
          if (child.tagName === 'BUTTON') child.style.order = String(max + 1);
        }
      } else {
        g.rows.sort((a, b) => effTimeOf(b.task) - effTimeOf(a.task) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        g.rows.forEach((r, i) => {
          r.wrap.style.order = String(i + 1);
        });
        // 尾部按钮(显示更多等)恒排最后, 不掺和任务序
        for (const child of cont.children) {
          if (child.tagName === 'BUTTON') child.style.order = String(g.rows.length + 1);
        }
      }
    }
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

  // 后台任务标记: 静态终端图标(size-3.5), 与任务行原生旋转 loader(size-4)图形/尺寸双区分
  const ICON_TERMINAL =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide size-3.5" aria-hidden="true"><path d="m4 17 6-6-6-6"></path><path d="M12 19h8"></path></svg>';

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

  // 常驻筛选框: DOM 一直挂在 actions 最前(不再点击展开), 随 actions 的 hover/
  // focus-within opacity 一起显隐(原生类自带); 有内容(data-zqp-filled)时框内右侧出 ×
  const makeFilterBox = () => {
    const box = document.createElement('div');
    box.setAttribute('data-zqp-filter-box', '1');
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-zqp-filter-input', '1');
    input.setAttribute('placeholder', '筛选项目');
    input.setAttribute('spellcheck', 'false');
    box.appendChild(input);
    // ESC 在生成中会被 block-esc 吞掉, 清空入口必须有可点的按钮
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'zqp-filter-clear';
    clear.setAttribute('data-zqp-action', 'clear-filter');
    clear.setAttribute('title', '清空筛选');
    clear.setAttribute('aria-label', '清空筛选');
    clear.innerHTML = ICON_CLEAR;
    box.appendChild(clear);
    return box;
  };

  // 窄形态展开行: 点击筛选按钮后在标题下方展开(同款输入框样式), ×/ESC 清除并收起
  const makeFilterRow = () => {
    const row = document.createElement('div');
    row.setAttribute('data-zqp-filter-row', '1');
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-zqp-filter-input', '1');
    input.setAttribute('placeholder', '筛选项目');
    input.setAttribute('spellcheck', 'false');
    row.appendChild(input);
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

  // title 的内容自然宽: 拉伸态 scrollWidth 失真(flex-1 拉满后 scrollWidth=被拉宽,
  // 收缩截断时才是内容宽), 改按子元素 rect 求和 + padding/gap —— title 子项在主轴
  // 不被拉伸, 任何形态下都稳定
  const titleNaturalW = (title) => {
    if (!title) return 0;
    const cs = getComputedStyle(title);
    let kids = 0;
    let n = 0;
    for (const c of title.children) {
      kids += c.getBoundingClientRect().width;
      n++;
    }
    if (!n) return title.scrollWidth;
    const gap = (parseFloat(cs.columnGap) || parseFloat(cs.gap) || 0) * Math.max(0, n - 1);
    return kids + gap + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  };

  // 分区标题: 加入排序按钮与筛选框(React 重建后由周期扫描补回)。筛选双形态按标题行
  // 富余宽度切换: 富余 = 行宽 − 标题内容宽 − 按钮组宽, 够容纳最小输入框(112px)走
  // 常驻框, 否则退回"筛选按钮 + 下方展开行"。测量只取 scrollWidth/按钮 offsetWidth,
  // 与当前形态无关, 切换不会来回抖
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
      actions.insertBefore(frag, actions.firstChild);
    }
    syncSortButton(actions.querySelector('[data-zqp-action="name"]'), 'name');
    syncSortButton(actions.querySelector('[data-zqp-action="updated"]'), 'updated');

    const title = headerRow.children[0];
    if (title) title.setAttribute('data-zqp-title', '1');
    const btns = [...actions.children].filter((k) => k.tagName === 'BUTTON');
    const btnsW = btns.reduce((s, b) => s + b.offsetWidth, 0) + btns.length * 2;
    const wide = headerRow.clientWidth - titleNaturalW(title) - btnsW >= 112;
    headerRow.setAttribute('data-zqp-filtermode', wide ? 'wide' : 'narrow');
    // 侧栏拖宽窄/React 重建 headerRow 时重挂观察目标(旧节点不 unobserve 会被 RO 强引用)
    if (roTarget !== headerRow) {
      if (roTarget) ro.unobserve(roTarget);
      roTarget = headerRow;
      ro.observe(headerRow);
    }

    const syncInput = (host) => {
      host.setAttribute('data-zqp-filled', filter.q ? '1' : '0');
      const input = host.querySelector('[data-zqp-filter-input]');
      if (input && input.value !== filter.q) input.value = filter.q;
    };

    if (wide) {
      // 常驻框: 挂操作区最前, 清掉窄形态物(筛选按钮/展开行)
      const oldBtn = actions.querySelector(':scope > [data-zqp-action="filter"]');
      if (oldBtn) oldBtn.remove();
      const oldRow = col.querySelector(':scope > [data-zqp-filter-row]');
      if (oldRow) oldRow.remove();
      filter.open = false;
      let box = actions.querySelector(':scope > [data-zqp-filter-box]');
      if (!box) actions.insertBefore((box = makeFilterBox()), actions.firstChild);
      syncInput(box);
    } else {
      // 宽→窄切换时若已有筛选词, 自动展开行——否则列表仍被过滤但界面无任何可见指示
      if (filter.q) filter.open = true;
      // 按钮形态: 操作区最前"筛选"按钮, 点击在标题下方展开输入行
      const oldBox = actions.querySelector(':scope > [data-zqp-filter-box]');
      if (oldBox) oldBox.remove();
      if (!actions.querySelector(':scope > [data-zqp-action="filter"]')) {
        actions.insertBefore(makeButton(btnClass(actions, 'button'), 'filter', '筛选项目', ICON_FILTER), actions.firstChild);
      }
      const filterBtn = actions.querySelector('[data-zqp-action="filter"]');
      if (filterBtn) filterBtn.setAttribute('data-zqp-active', filter.open ? '1' : '0');
      let row = col.querySelector(':scope > [data-zqp-filter-row]');
      if (filter.open && !row) {
        row = makeFilterRow();
        col.insertBefore(row, headerRow.nextSibling);
      }
      if (!filter.open && row) row.remove();
      if (row) {
        row.setAttribute('data-zqp-open', '1');
        syncInput(row);
      }
    }
  };

  // 项目行: 右侧动作组加"移到最上方", 项目名称右侧追加运行态 spinner(原图标不动)
  const syncRowChrome = (sec, meta) => {
    const actions = sec.querySelector(':scope > [data-testid="virtual-project-row"] [data-testid="virtual-project-actions"]');
    if (actions && !actions.querySelector('[data-zqp-action="top"]')) {
      const cls = btnClass(actions, 'button');
      actions.insertBefore(makeButton(cls, 'top', '移到最上方', ICON_TOP), actions.firstChild);
    }

    // 名称容器 = 折叠按钮内图标盒(aria-hidden span)的下一个兄弟; spinner 挂其末尾,
    // 水平间距沿用容器原生 gap-2, 基线容器内用 align-self:center 垂直居中
    const nameBox = sec.querySelector(':scope > [data-testid="virtual-project-row"] button[data-testid="virtual-project-toggle"] > span[aria-hidden="true"] + span');
    if (nameBox) {
      let spin = nameBox.querySelector('[data-zqp-spinner]');
      if (!spin) {
        spin = document.createElement('span');
        spin.setAttribute('data-zqp-spinner', '1');
        spin.className = 'zqp-spinner animate-spin';
        spin.innerHTML = ICON_SPINNER;
        nameBox.appendChild(spin);
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

    // 筛选无结果提示(挂在常驻框/展开行上)
    document.querySelectorAll('[data-zqp-filter-box], [data-zqp-filter-row]').forEach((host) => {
      host.setAttribute('data-zqp-empty', q && !visible ? '1' : '0');
    });

    applyTaskLists();
    applyChrome();
    applyTaskMarks();
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

  // 宽形态(常驻框): 只清空关键字; 窄形态(展开行)的开合走 openFilter/closeFilter
  const clearFilter = () => {
    filter.q = '';
    apply();
  };

  // 窄形态开合: 打开时收起的分区先展开(否则展开行被 CSS 隐藏), 并 focus 输入框
  const openFilter = () => {
    filter.open = true;
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
      // 窄形态: 筛选按钮开合展开行
      if (filter.open) closeFilter();
      else openFilter();
    } else if (action === 'clear-filter') {
      // 展开行内 × 清除并收起; 常驻框内 × 只清空
      if (btn.closest('[data-zqp-filter-row]')) closeFilter();
      else clearFilter();
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
      if (t.closest('[data-zqp-filter-row]')) closeFilter();
      else clearFilter();
    }
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [data-zqp-list="1"] { display: flex !important; flex-direction: column; }
      /* 任务列表容器: 同款 flex 化让包装层 style.order 生效(排序/冻结均为视觉覆盖) */
      [data-zqp-tasklist="1"] { display: flex !important; flex-direction: column; }
      /* 操作区原生按钮紧贴(间距只靠图标内缩), 激活态背景会连成一片; 显式补 2px 间隙 */
      [data-zqp-actions="1"] { gap: 2px; }
      [data-zqp-hidden="1"] { display: none !important; }
      [data-zqp-active="1"] { color: var(--color-foreground) !important; background-color: var(--color-hover) !important; }
      /* 宽形态: 筛选框常驻 actions 最前(随操作区 hover/focus-within 显隐), 标题退到
         内容宽、actions 参与 grow, 富余宽度全部喂给筛选框 */
      [data-zqp-filtermode="wide"] > [data-zqp-title] { flex: 0 1 auto; }
      [data-zqp-filtermode="wide"] > [data-zqp-actions="1"] { flex: 1 1 auto; min-width: 0; }
      [data-zqp-filtermode="wide"] [data-zqp-filter-box] { flex: 1 1 0; min-width: 112px; }
      [data-zqp-filter-box] { position: relative; flex: 0 0 auto; display: flex; align-items: center; }
      /* 窄形态展开行: 点击筛选按钮后在标题下方展开, 分区收起时隐藏 */
      [data-zqp-filter-row] { position: relative; display: none; margin: 0 0 4px 8px; }
      [data-zqp-filter-row][data-zqp-open="1"] { display: flex; }
      [data-slot="collapsible"][data-state="closed"] [data-zqp-filter-row] { display: none !important; }
      [data-zqp-filter-input] {
        width: 100%; height: 24px; box-sizing: border-box; padding: 0 26px 0 8px;
        font: inherit; font-size: var(--text-ui-sm); color: var(--color-foreground);
        background: var(--color-surface-hover); border: none; border-radius: 6px; outline: none;
      }
      [data-zqp-filter-input]:focus { background: var(--color-hover); }
      [data-zqp-filter-input]::placeholder { color: var(--color-foreground-subtle); }
      /* 清空按钮只随内容出现(filled), 绝对定位在输入框内右侧 */
      .zqp-filter-clear {
        position: absolute; right: 3px; top: 50%; transform: translateY(-50%);
        display: none; align-items: center; justify-content: center;
        width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px;
        color: var(--color-foreground-subtle); background: transparent; cursor: pointer;
      }
      [data-zqp-filled="1"] .zqp-filter-clear { display: inline-flex; }
      .zqp-filter-clear:hover { color: var(--color-foreground); background: var(--color-hover); }
      [data-zqp-empty="1"]::after {
        content: "无匹配项目"; margin-left: 6px; white-space: nowrap;
        font-size: var(--text-ui-sm); color: var(--color-foreground-subtle);
      }
      /* 运行态: spinner 挂项目名称容器末尾(原生 gap-2 控距), 基线容器内垂直居中 */
      .zqp-spinner { display: none; align-items: center; justify-content: center; align-self: center; }
      [data-zqp-running="1"] .zqp-spinner { display: inline-flex; }
      /* 后台任务标记: 行首状态格空闲位, 静态终端图标 */
      .zqp-bgmark { display: none; align-items: center; justify-content: center; color: var(--color-foreground-subtle); }
      [data-zqp-bg="1"] .zqp-bgmark { display: inline-flex; }
    `;
    document.head.appendChild(style);
  };

  let raf = 0;
  const scheduleApply = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      apply();
    });
  };
  const observer = new MutationObserver(scheduleApply);
  // 悬停冻结的解除要跟手: 指针离开任务列表立即重排, 不等 1.5s 轮询
  const onMouseOut = (e) => {
    if (!(e.target instanceof Element)) return;
    const cont = e.target.closest('[data-zqp-tasklist]');
    if (!cont) return;
    const to = e.relatedTarget;
    if (to instanceof Node && cont.contains(to)) return; // 列表内部移动不算离开
    scheduleApply();
  };
  let timer = 0;
  // 侧栏拖宽窄 → 标题行富余宽度变化, 立即重算筛选形态(不等 1.5s 轮询)
  const ro = new ResizeObserver(scheduleApply);
  let roTarget = null;

  const start = () => {
    if (!document.body) return;
    ensureStyle();
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mouseout', onMouseOut, true);
    applyChrome();
    apply();
    observer.observe(document.body, { childList: true, subtree: true });
    timer = setInterval(apply, 1500);
  };

  const stop = () => {
    observer.disconnect();
    ro.disconnect();
    roTarget = null;
    if (raf) cancelAnimationFrame(raf);
    if (timer) clearInterval(timer);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.querySelectorAll('[data-zqp-action]').forEach((el) => el.remove());
    document.querySelectorAll('[data-zqp-filter-box], [data-zqp-filter-row]').forEach((el) => el.remove());
    document.querySelectorAll('[data-zqp-spinner]').forEach((el) => el.remove());
    document.querySelectorAll('[data-zqp-bgmark]').forEach((el) => el.remove());
    document.querySelectorAll('[data-zqp-bg]').forEach((el) => el.removeAttribute('data-zqp-bg'));
    // 任务列表态撤销: 容器属性/order 还原, 时间文本回原生 updatedAt 口径
    for (const cont of document.querySelectorAll('[data-zqp-tasklist]')) {
      cont.removeAttribute('data-zqp-tasklist');
      for (const child of cont.children) if (child.style.order) child.style.order = '';
    }
    for (const li of document.querySelectorAll('section[data-project-id] li[data-task-item-key]')) {
      const task = taskOf(li);
      if (task && task.updatedAt) setRowTime(li, task.updatedAt);
    }
    const sections = document.querySelectorAll('[data-project-id]');
    for (const sec of sections) {
      sec.removeAttribute('data-zqp-running');
      sec.removeAttribute('data-zqp-hidden');
      if (sec.style.order) sec.style.order = '';
    }
    document.querySelectorAll('[data-zqp-list]').forEach((el) => el.removeAttribute('data-zqp-list'));
    document.querySelectorAll('[data-zqp-actions]').forEach((el) => el.removeAttribute('data-zqp-actions'));
    document.querySelectorAll('[data-zqp-filtermode]').forEach((el) => el.removeAttribute('data-zqp-filtermode'));
    document.querySelectorAll('[data-zqp-title]').forEach((el) => el.removeAttribute('data-zqp-title'));
    const s = document.getElementById(STYLE_ID);
    if (s) s.remove();
    delete W.__zcodeProjectTools;
  };

  W.__zcodeProjectTools = { stop, apply, start };

  // 注入点在 head 末尾, 执行时 body 尚未解析; 等 DOM 就绪再启动
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
