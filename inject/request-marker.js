// 缺口: ZCode 会话步骤流按工具类型折叠(explore/terminal/changes), 一个 part 一行,
// 相邻工具、甚至同一行内折叠的多个工具都可能来自不同模型请求, UI 不暴露请求边界。
// 请求身份只存在于数据里: 一条 assistant message(行对象的 assistantResponseId) = 一次模型请求。
//
// 本脚本随 index.html 注入渲染进程(早于应用代码执行), 从 React fiber 的 memoizedProps 读出
// 行/折叠组/整轮的 rows, 按 assistantResponseId 分组, 给行与「已工作」标题打 data-zrq-*
// 属性; 内联 CSS 依据这些属性画标签与灰色竖条, 并处理折叠态(仅正文)的特殊样式。
// MutationObserver 负责虚拟滚动/流式渲染后的重打标(属性变更不触发, 只观察 childList)。
//
// 开关: localStorage.setItem('zcode:request-marker:enabled','0') 后刷新(默认开启)。
// 运行时停用: window.__zcodeRequestMarker.stop()(仅当前页面, 刷新后按开关恢复)。
// 依赖: data-v4-turn-unit / data-row-id / data-turn-id / data-history-open /
//       chat-assistant-history-{trigger,content} testid / assistantResponseId 行字段 /
//       React fiber 的 __reactFiber$ 与 memoizedProps。升级后按仓库 guide/request-marker/facts.md 锚点卡抽查。
//
// 标签画在行左侧空白带, apply() 会把承载行的 overflow:hidden 容器临时改成 visible
// (每轮先清 data-zrq-clip 再重标, 虚拟滚动/展开后旧容器不会滞留 overflow:visible)。
(() => {
  const W = window;
  if (W.__zcodeRequestMarker) W.__zcodeRequestMarker.stop();
  if (localStorage.getItem('zcode:request-marker:enabled') === '0') return;

  const STYLE_ID = 'zcode-request-marker-style';
  const ATTRS = [
    'data-zrq',
    'data-zrq-first',
    'data-zrq-last',
    'data-zrq-label',
    'data-zrq-plain',
    'data-zrq-head',
    'data-zrq-head-label',
  ];

  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
  };

  const collect = (el, out) => {
    let f = fiberOf(el);
    for (let i = 0; i < 24 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (!p) continue;
      if (Array.isArray(p.rows)) {
        for (const r of p.rows) if (r && r.rowId != null) out.set(r.rowId, r);
      }
      if (p.row && p.row.rowId != null) out.set(p.row.rowId, p.row);
      if (p.item && Array.isArray(p.item.rows)) {
        for (const r of p.item.rows) if (r && r.rowId != null) out.set(r.rowId, r);
      }
    }
  };

  // 行自身/折叠组包含的工具调用(可能跨多次请求); 只看本行 props, 不收集祖先整轮聚合
  const rowInfoOf = (el) => {
    let f = fiberOf(el);
    for (let i = 0; i < 24 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (!p) continue;
      if (p.item && Array.isArray(p.item.rows) && p.item.rows.length) {
        return p.item.rows.map((r) => ({
          rid: r.assistantResponseId,
          tool: r.kind === 'toolCall' ? r.toolName : '',
        }));
      }
      if (p.row && p.row.assistantResponseId) {
        return [
          {
            rid: p.row.assistantResponseId,
            tool: p.row.kind === 'toolCall' ? p.row.toolName : '',
          },
        ];
      }
    }
    return [];
  };

  const apply = () => {
    // 先清上一轮的裁剪解除: 承载行会随虚拟滚动/折叠展开更换, 旧容器滞留
    // data-zrq-clip 会永久放开 overflow(标签移位、布局异常), 每轮重算。
    document.querySelectorAll('[data-zrq-clip]').forEach((el) => el.removeAttribute('data-zrq-clip'));

    const rows = new Map();
    document.querySelectorAll('[data-v4-turn-unit]').forEach((el) => collect(el, rows));
    const domRows = [...document.querySelectorAll('[data-row-id]')].map((el) => {
      const id = Number(el.getAttribute('data-row-id'));
      const row = rows.get(id);
      const info = rowInfoOf(el);
      if (!info.length && row && row.assistantResponseId) {
        info.push({ rid: row.assistantResponseId, tool: row.kind === 'toolCall' ? row.toolName : '' });
      }
      return { el, id, info, row };
    });
    domRows.forEach(({ el }) => collect(el, rows));

    // rid -> 该行合并进来的其他请求/工具
    const merged = new Map();
    for (const d of domRows) {
      const rids = [...new Set(d.info.map((x) => x.rid).filter(Boolean))];
      if (rids.length < 2) continue;
      const m = merged.get(rids[0]) || { extras: [], tools: [] };
      m.extras.push(...rids.slice(1));
      m.tools.push(...d.info.filter((x) => x.rid !== rids[0] && x.tool).map((x) => x.tool));
      merged.set(rids[0], m);
    }

    const byRid = new Map();
    const add = (rid, rowId, row) => {
      if (!rid) return;
      if (!byRid.has(rid)) byRid.set(rid, { ids: [], names: {} });
      const g = byRid.get(rid);
      g.ids.push(rowId);
      if (row && row.kind === 'toolCall') {
        const n = row.toolName || '?';
        g.names[n] = (g.names[n] || 0) + 1;
      }
    };
    const seen = new Set();
    for (const r of rows.values()) {
      if (seen.has(r.rowId)) continue;
      seen.add(r.rowId);
      add(r.assistantResponseId, r.rowId, r);
    }
    for (const d of domRows) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      add(d.info[0] && d.info[0].rid, d.id, null);
    }

    const groups = [];
    for (const [rid, g] of byRid) {
      g.rid = rid;
      g.first = Math.min(...g.ids);
      g.last = Math.max(...g.ids);
      groups.push(g);
    }
    groups.sort((a, b) => a.first - b.first);
    groups.forEach((g, i) => {
      g.n = i + 1;
    });
    const gmap = new Map(groups.map((g) => [g.rid, g]));

    const labelOf = (g) => {
      const m = merged.get(g.rid) || { extras: [], tools: [] };
      const names = { ...g.names };
      for (const t of m.tools) names[t] = (names[t] || 0) + 1;
      let tools = Object.entries(names)
        .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
        .join(' ');
      if (tools.length > 40) tools = `${tools.slice(0, 39)}…`;
      const extras = m.extras.map((r) => gmap.get(r)).filter(Boolean);
      if (extras.length) {
        // 区间只标首尾: 同一行合并多个请求时只显示 #首 → #尾, 中间序号不出现在标签里
        const last = extras.reduce((a, e) => Math.max(a, e.n), g.n);
        const span = `#${g.n} → #${last}`;
        return tools ? `${span}\n${tools}` : span;
      }
      return `#${g.n}${tools ? ` · ${tools}` : ''}`;
    };

    const turnEls = [...document.querySelectorAll('[data-v4-turn-unit]')];
    const collapsedOf = (el) => {
      const turn = el.closest('[data-v4-turn-unit]');
      if (!turn) return false;
      const trig = turn.querySelector('[data-testid^="chat-assistant-history-trigger-"]');
      return !!trig && trig.getAttribute('data-history-open') === 'false';
    };

    let marked = 0;
    let firsts = 0;
    for (const { el, id, info } of domRows) {
      const rids = [...new Set(info.map((x) => x.rid).filter(Boolean))];
      const g = gmap.get(rids[0]);
      if (!g) {
        ATTRS.forEach((a) => el.removeAttribute(a));
        continue;
      }

      const inContent = !!el.closest('[data-testid^="chat-assistant-history-content-"]');
      const plain = !inContent && collapsedOf(el);

      if (plain) {
        // 折叠态: 只显示正文, 不画竖条/底色, 只留 #N 标签
        ATTRS.forEach((a) => el.removeAttribute(a));
        el.setAttribute('data-zrq-plain', '1');
        el.setAttribute('data-zrq-label', `#${g.n}`);
        marked++;
        continue;
      }

      el.setAttribute('data-zrq', '1');
      marked++;

      if (id === g.first) {
        el.setAttribute('data-zrq-first', '1');
        el.setAttribute('data-zrq-label', labelOf(g));
        firsts++;
        // 标签画在行左侧, 需要解除该行 overflow:hidden 祖先的裁剪
        let p = el.parentElement;
        for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.overflowX === 'hidden' || cs.overflowY === 'hidden') {
            p.setAttribute('data-zrq-clip', 'off');
            break;
          }
        }
      } else {
        el.removeAttribute('data-zrq-first');
        el.removeAttribute('data-zrq-label');
      }
      el.removeAttribute('data-zrq-plain');

      if (id === g.last) el.setAttribute('data-zrq-last', '1');
      else el.removeAttribute('data-zrq-last');
    }

    // 折叠态的「已工作」标题: 区间标签放到标题行左侧, 与普通标签同款
    for (const turn of turnEls) {
      const trig = turn.querySelector('[data-testid^="chat-assistant-history-trigger-"]');
      if (!trig) continue;
      const headEl = trig.parentElement;
      if (trig.getAttribute('data-history-open') !== 'false') {
        headEl.removeAttribute('data-zrq-head');
        headEl.removeAttribute('data-zrq-head-label');
        continue;
      }
      const turnId = turn.getAttribute('data-turn-id');
      // 区间只算折叠内容里的行(排除正文行本身); 正文请求若其思考段也在内容里, 会自然被算进去
      const outside = new Set(
        [...turn.querySelectorAll('[data-row-id]')]
          .filter((el) => !el.closest('[data-testid^="chat-assistant-history-content-"]'))
          .map((el) => Number(el.getAttribute('data-row-id')))
      );
      const rids = [...new Set([...rows.values()]
        .filter((r) => r.turnId === turnId && !outside.has(r.rowId))
        .map((r) => r.assistantResponseId)
        .filter(Boolean))];
      const gs = rids.map((rid) => gmap.get(rid)).filter(Boolean);
      if (!gs.length) {
        // 折叠内容已滚出/行数据未就绪: 清残留, 否则沿用上一轮区间标签
        headEl.removeAttribute('data-zrq-head');
        headEl.removeAttribute('data-zrq-head-label');
        continue;
      }
      const min = Math.min(...gs.map((g) => g.n));
      const max = Math.max(...gs.map((g) => g.n));
      headEl.setAttribute('data-zrq-head', '1');
      headEl.setAttribute('data-zrq-head-label', min === max ? `#${min}` : `#${min} → #${max}`);
    }

    return { groups: groups.length, marked, firsts };
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [data-zrq="1"] {
        position: relative;
      }
      [data-zrq="1"]::before {
        content: "";
        position: absolute;
        left: -4px;
        top: -8px;
        bottom: -8px;
        width: 1px;
        background: #e0e0e0;
      }
      [data-zrq-first="1"]::before { top: 0; }
      [data-zrq-last="1"]::before { bottom: 0; }
      [data-zrq-clip="off"] { overflow: visible !important; }

      [data-zrq-first="1"]::after,
      [data-zrq-plain="1"]::after {
        content: attr(data-zrq-label);
        position: absolute;
        right: calc(100% + 9px);
        top: 1px;
        width: max-content;
        max-width: 120px;
        padding: 1px 6px;
        font-size: 10px;
        line-height: 13px;
        font-weight: 500;
        letter-spacing: 0.02em;
        white-space: pre-line;
        overflow-wrap: anywhere;
        text-align: right;
        color: #5f6673;
        background: #f3f4f6;
        border: 1px solid #d8dce2;
        border-radius: 4px;
        pointer-events: none;
      }
      [data-zrq-plain="1"] {
        position: relative;
        background: none;
      }
      [data-zrq-plain="1"]::after { top: 4px; }
      [data-zrq-head="1"] { position: relative; }
      [data-zrq-head="1"]::after {
        content: attr(data-zrq-head-label);
        position: absolute;
        right: calc(100% + 9px);
        top: 1px;
        width: max-content;
        max-width: 120px;
        padding: 1px 6px;
        font-size: 10px;
        line-height: 13px;
        font-weight: 500;
        letter-spacing: 0.02em;
        white-space: pre-line;
        overflow-wrap: anywhere;
        text-align: right;
        color: #5f6673;
        background: #f3f4f6;
        border: 1px solid #d8dce2;
        border-radius: 4px;
        pointer-events: none;
      }
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

  const start = () => {
    if (!document.body) return;
    ensureStyle();
    apply();
    observer.observe(document.body, { childList: true, subtree: true });
  };

  const stop = () => {
    observer.disconnect();
    if (raf) cancelAnimationFrame(raf);
    document.querySelectorAll('[data-row-id]').forEach((el) => ATTRS.forEach((a) => el.removeAttribute(a)));
    document.querySelectorAll('[data-zrq-head]').forEach((el) => {
      el.removeAttribute('data-zrq-head');
      el.removeAttribute('data-zrq-head-label');
    });
    document.querySelectorAll('[data-zrq-clip]').forEach((el) => el.removeAttribute('data-zrq-clip'));
    const s = document.getElementById(STYLE_ID);
    if (s) s.remove();
    delete W.__zcodeRequestMarker;
  };

  W.__zcodeRequestMarker = { stop, apply, start };

  // 注入点在 head 末尾, 执行时 body 尚未解析; 等 DOM 就绪再挂 observer
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
