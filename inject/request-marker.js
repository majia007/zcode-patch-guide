// 缺口: ZCode 会话步骤流按请求折叠展示——turn 级「已工作」折叠(chat-assistant-history-*)
// + 3.18.0 起组级 summaryGroup 折叠(相邻思考/工具行收进 data-consecutive-summary-group
// 折叠体, 默认收起, trigger 上是统计文案如「已执行 3 命令,已修改 1 文件」), 同一折叠体内
// 的多个工具可能来自不同模型请求, UI 不暴露请求边界。
// 请求身份只存在于数据里: 一条 assistant message(行对象的 assistantResponseId) = 一次模型请求。
//
// 本脚本随 index.html 注入渲染进程(早于应用代码执行), 从 React fiber 的 memoizedProps 读出
// 行/整轮的 rows, 按 assistantResponseId 分组, 给行打 data-zrq-* 属性; 内联 CSS 依据这些
// 属性画标签(组外行左侧标签卡、组内行段首块级前缀、组头/「已工作」标题区间标签)并处理折叠态
// (仅正文)。我们加的请求竖条已整体移除——段首标签承担请求边界, 应用自带的组内容竖线保持原样。
// MutationObserver 负责虚拟滚动/流式渲染后的重打标(属性变更不触发, 只观察 childList)。
//
// 组折叠细节(3.18.0 CDP 实测):
// - 收起组的 trigger 内嵌一个装饰行(统计图标=组内优先工具行的真实渲染;运行中组=iT 直播摘要
//   行), 携带 data-row-id 但不是步骤流的真实行, 一律跳过不打标——否则标签错位画到统计行,
//   竖条在图标位出碎段;
// - 展开组的内容区在 data-summary-group-scroll 滚动体内(overflow-y:auto 使 overflow-x 计算为
//   auto), 悬浮 ::after 标签会被横向裁剪——组内行改用块级 ::before 前缀独占一行排在行内容上方
//   (流内排布不被裁剪), 且只在请求段首行画「#N · 工具×次数」, 同段后续行无标记;
//   组的请求区间由组头 data-zrq-head-label 承载(如「#51 → #57」), 数据取自组根 fiber 的
//   memoizedProps.children(组内行元素数组, props.row / props.item.row 各含 assistantResponseId);
//   组头工具统计先数组内行(与原生统计同口径), 再补齐本组出现过的请求在组外的工具名——同一请求
//   可被组边界切开(尾部思考行在本组、工具行在下一组或独立行), 只数组内行会漏掉该请求的工具;
// - turn 级折叠行为不变: 收起时只渲染正文行(plain 态), 区间标签放「已工作」标题行左侧。
//
// 开关: localStorage.setItem('zcode:request-marker:enabled','0') 后刷新(默认开启)。
// 运行时停用: window.__zcodeRequestMarker.stop()(仅当前页面, 刷新后按开关恢复)。
// 依赖: data-v4-turn-unit / data-row-id / data-turn-id / data-history-open /
//       chat-assistant-history-{trigger,content} testid / data-consecutive-summary-group /
//       data-summary-group-{trigger,scroll} / assistantResponseId 行字段 /
//       React fiber 的 __reactFiber$ 与 memoizedProps(rows/items/row/item.row/children)。
//       升级后按 maps/anchors.md 抽查。
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
    'data-zrq-row',
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
      // 3.18.0: PEn 的 items = 行对象包装数组({kind,row,key}), 行字段在 .row 上
      if (Array.isArray(p.items)) {
        for (const it of p.items) if (it && it.row && it.row.rowId != null) out.set(it.row.rowId, it.row);
      }
      if (p.row && p.row.rowId != null) out.set(p.row.rowId, p.row);
    }
  };

  // 行自身 props 里的行(单行=单请求; 3.17 的 p.item.rows 多行折叠线已废,
  // 3.18.0 组级折叠由组根 fiber children 承载, 见 groupRowsOf)
  const rowInfoOf = (el) => {
    let f = fiberOf(el);
    for (let i = 0; i < 24 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (!p) continue;
      if (p.item && p.item.row && p.item.row.rowId != null) {
        return [
          {
            rid: p.item.row.assistantResponseId,
            tool: p.item.row.kind === 'toolCall' ? p.item.row.toolName : '',
          },
        ];
      }
      if (p.row && p.row.rowId != null) {
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

  // 收起组根 → 组内全部行(fiber children 数组; 实测 ≤8 跳命中 b1e 的 props.children)
  const groupRowsOf = (root) => {
    let f = fiberOf(root);
    for (let i = 0; i < 12 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      const ch = p && p.children;
      if (
        Array.isArray(ch) &&
        ch.some((c) => c && c.props && (c.props.row || (c.props.item && c.props.item.row)))
      ) {
        return ch
          .map((c) => {
            const r = c.props.row || (c.props.item && c.props.item.row);
            return r
              ? { rid: r.assistantResponseId, tool: r.kind === 'toolCall' ? r.toolName : '' }
              : null;
          })
          .filter(Boolean);
      }
    }
    return [];
  };

  // 标签(行首/组头/turn 标题)要伸进行左侧留白带, 需解除途中 overflow:hidden 的裁剪。
  // 3.18 只允许解除 turn 折叠内容包裹层(chat-assistant-history-content, overflow 双 hidden);
  // 途中遇到滚动容器(overflow-y auto/scroll, 如时间线滚动区 overflow-x:hidden、组滚动体)立即
  // 停手——不放开它们, 标签几何上本就落在其盒内留白带, 误放开会破坏滚动/裁剪。
  const unclip = (el) => {
    let p = el.parentElement;
    for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') break;
      const tid = p.getAttribute && p.getAttribute('data-testid');
      if (
        (cs.overflowX === 'hidden' || cs.overflowY === 'hidden') &&
        tid &&
        tid.startsWith('chat-assistant-history-content')
      ) {
        p.setAttribute('data-zrq-clip', 'off');
        break;
      }
    }
  };

  const apply = () => {
    // 先清上一轮的裁剪解除与标题/组头标签: 承载行/组会随虚拟滚动/折叠展开更换,
    // 旧容器滞留会永久放开 overflow 或残留过期区间, 每轮全清再重打。
    document.querySelectorAll('[data-zrq-clip]').forEach((el) => el.removeAttribute('data-zrq-clip'));
    document.querySelectorAll('[data-zrq-head]').forEach((el) => {
      el.removeAttribute('data-zrq-head');
      el.removeAttribute('data-zrq-head-label');
    });
    // 组内标签已改为行内容内的块级前缀(流内独占一行), 不再需要左侧标签带, 清理历史 gutter
    document.querySelectorAll('[data-zrq-gutter]').forEach((el) => el.removeAttribute('data-zrq-gutter'));

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

    // 组内行按「同一滚动体内同一 rid」的首尾整形(请求段在组内独立收口): 同一请求的正文行可能
    // 在组外, 沿用全局 first/last 会让组内段竖条上下溢出、段与段不分离。
    const segOf = new Map();
    {
      const seg = new Map(); // scrollEl -> Map(rid -> {min,max})
      for (const d of domRows) {
        const sc = d.el.closest('[data-summary-group-scroll]');
        const rid = d.info[0] && d.info[0].rid;
        if (!sc || !rid) continue;
        if (!seg.has(sc)) seg.set(sc, new Map());
        const m = seg.get(sc);
        const e = m.get(rid) || { min: Infinity, max: -Infinity };
        e.min = Math.min(e.min, d.id);
        e.max = Math.max(e.max, d.id);
        m.set(rid, e);
      }
      for (const d of domRows) {
        const sc = d.el.closest('[data-summary-group-scroll]');
        const rid = d.info[0] && d.info[0].rid;
        const e = sc && rid ? seg.get(sc)?.get(rid) : null;
        if (e) segOf.set(d.el, e);
      }
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
      let tools = Object.entries(g.names)
        .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
        .join(' ');
      if (tools.length > 40) tools = `${tools.slice(0, 39)}…`;
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
      // 组 trigger 内嵌的统计图标行/iT 直播摘要行是装饰渲染, 不打标(防标签错位、竖条碎段)
      if (el.closest('[data-summary-group-trigger]')) {
        ATTRS.forEach((a) => el.removeAttribute(a));
        continue;
      }
      const rids = [...new Set(info.map((x) => x.rid).filter(Boolean))];
      const g = gmap.get(rids[0]);
      if (!g) {
        ATTRS.forEach((a) => el.removeAttribute(a));
        continue;
      }

      const inContent = !!el.closest('[data-testid^="chat-assistant-history-content-"]');
      const inGroupScroll = !!el.closest('[data-summary-group-scroll]');
      const seg = segOf.get(el);
      const isFirst = seg ? id === seg.min : id === g.first; // 组内=段首, 其余=请求全局首
      const isLast = seg ? id === seg.max : id === g.last;
      const plain = !inContent && !inGroupScroll && collapsedOf(el); // 组内行展开后可见, 不走折叠正文分支

      if (plain) {
        // turn 折叠态: 只显示正文, 不画竖条/底色, 只留 #N 标签
        ATTRS.forEach((a) => el.removeAttribute(a));
        el.setAttribute('data-zrq-plain', '1');
        el.setAttribute('data-zrq-label', `#${g.n}`);
        marked++;
        continue;
      }

      if (inGroupScroll) {
        // 展开组内: 段首行标签以块级 ::before 独占一行、排在行内容之前(在流内, 不悬浮不裁剪);
        // 同段后续行无标签; 组内不再画请求竖条(原生组内容竖线已提供分组视觉)
        ATTRS.forEach((a) => el.removeAttribute(a));
        el.setAttribute('data-zrq-row', '1');
        if (isFirst) el.setAttribute('data-zrq-label', labelOf(g));
        marked++;
        continue;
      }

      el.setAttribute('data-zrq', '1');
      marked++;

      if (isFirst) {
        el.setAttribute('data-zrq-label', labelOf(g));
        unclip(el);
      } else {
        el.removeAttribute('data-zrq-label');
      }

      if (isFirst) {
        el.setAttribute('data-zrq-first', '1');
        firsts++;
      } else {
        el.removeAttribute('data-zrq-first');
      }
      el.removeAttribute('data-zrq-plain');

      if (isLast) el.setAttribute('data-zrq-last', '1');
      else el.removeAttribute('data-zrq-last');
    }

    // 组头区间标签: 收起/展开都显示(用户要求展开后不隐藏, 作整组总览)。
    // 宿主必须是 trigger 而非组根: 探针实测部分组根比统计行高 12px(内容区残留/上缘空白),
    // 标签相对组根定位会整体偏上, 与统计文案行错位。
    for (const root of document.querySelectorAll('[data-consecutive-summary-group]')) {
      const trig = root.querySelector('[data-summary-group-trigger]');
      if (!trig) continue;
      const headEl = trig;
      const groupRows = groupRowsOf(root);
      const rids = [...new Set(groupRows.map((x) => x.rid).filter(Boolean))];
      const gs = rids.map((rid) => gmap.get(rid)).filter(Boolean);
      if (!gs.length) continue; // 行数据未就绪(开头已全清, 无残留风险)
      const min = Math.min(...gs.map((g) => g.n));
      const max = Math.max(...gs.map((g) => g.n));
      // 组内工具统计: 先按组内行计数(与原生统计同口径), 再补齐「本组出现过的请求」在
      // 组外行上的工具名——同一请求可被组边界切开(尾部思考行落本组, 工具行落下一组或
      // 独立行), 只数组内行会把该请求的工具整体漏掉(3.18.0 实测: #162 的 TodoWrite/Bash
      // 都不在上组 children 里, 组头只剩 Read Edit)。补齐只加缺席的工具名、不改已有计数,
      // 避免跨组把同一次调用数两遍、与原生「已执行 N 命令」对不上。
      const names = {};
      for (const r of groupRows) if (r.tool) names[r.tool] = (names[r.tool] || 0) + 1;
      for (const g of gs) {
        for (const [n, c] of Object.entries(g.names)) {
          if (!names[n]) names[n] = c;
        }
      }
      let tools = Object.entries(names)
        .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
        .join(' ');
      if (tools.length > 40) tools = `${tools.slice(0, 39)}…`;
      const span = min === max ? `#${min}` : `#${min} → #${max}`;
      headEl.setAttribute('data-zrq-head', '1');
      headEl.setAttribute('data-zrq-head-label', tools ? `${span}\n${tools}` : span);
      unclip(headEl); // 组头在 turn 折叠内容包裹层内, 同样要解除其横向裁剪
    }

    // turn 折叠态的「已工作」标题: 区间标签放到标题行左侧, 与普通标签同款
    for (const turn of turnEls) {
      const trig = turn.querySelector('[data-testid^="chat-assistant-history-trigger-"]');
      if (!trig) continue;
      if (trig.getAttribute('data-history-open') !== 'false') continue; // 开头已全清
      const headEl = trig; // 与组头同口径: 宿主取 trigger, 避免包装层的 padding/border 致垂直错位
      const turnId = turn.getAttribute('data-turn-id');
      // 区间与统计只算折叠内容里的行(排除正文行本身); 正文请求若其思考段也在内容里, 会自然被算进去
      const outside = new Set(
        [...turn.querySelectorAll('[data-row-id]')]
          .filter((el) => !el.closest('[data-testid^="chat-assistant-history-content-"]'))
          .map((el) => Number(el.getAttribute('data-row-id')))
      );
      const turnRows = [...rows.values()].filter((r) => r.turnId === turnId && !outside.has(r.rowId));
      const rids = [...new Set(turnRows.map((r) => r.assistantResponseId).filter(Boolean))];
      const gs = rids.map((rid) => gmap.get(rid)).filter(Boolean);
      if (!gs.length) continue; // 折叠内容已滚出/行数据未就绪: 开头已全清
      const min = Math.min(...gs.map((g) => g.n));
      const max = Math.max(...gs.map((g) => g.n));
      // turn 头区间标签也带工具统计(与组头同款, 换行): 折叠内容里该 turn 的工具类型×次数
      const names = {};
      for (const r of turnRows) {
        if (r.kind === 'toolCall' && r.toolName) names[r.toolName] = (names[r.toolName] || 0) + 1;
      }
      let tools = Object.entries(names)
        .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
        .join(' ');
      if (tools.length > 40) tools = `${tools.slice(0, 39)}…`;
      const span = min === max ? `#${min}` : `#${min} → #${max}`;
      headEl.setAttribute('data-zrq-head', '1');
      headEl.setAttribute('data-zrq-head-label', tools ? `${span}\n${tools}` : span);
      unclip(headEl);
    }

    // 组内标记(块级 ::before)插入会改变内容高度, 但 Radix 的展开动画目标高度是打标前的
    // 测量值(--radix-collapsible-content-height): 动画会停在旧高度、结束再跳变到实际高度
    // (实测测量 174px vs 实际 284px)。打标后把变量校正为 content.scrollHeight, 让动画目标
    // 与最终渲染高度一致。幂等, 仅差异 >1px 时设置; React 重渲染覆盖后会由下一轮 apply 再校正。
    for (const content of document.querySelectorAll('[data-slot="collapsible-content"]')) {
      if (content.getAttribute('data-state') !== 'open') continue;
      if (!content.querySelector('[data-summary-group-scroll]')) continue;
      const h = content.scrollHeight;
      const cur = parseFloat(content.style.getPropertyValue('--radix-collapsible-content-height'));
      if (Number.isFinite(cur) && Math.abs(cur - h) > 1) {
        content.style.setProperty('--radix-collapsible-content-height', `${h}px`);
      }
    }

    return { groups: groups.length, marked, firsts };
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* 层级收敛: 去掉我们加的请求竖条(折叠层级多, 段首标签已表达请求边界);
         应用自带的组内容竖线(b1e before:border-l)保持原样。
         注意: 下面两条 position:relative 与 clip 规则必须保留 —— 行标签 ::after 以行
         为定位基准, 删掉会让标签相对最近定位祖先漂到错误位置; unclip 依赖 clip 规则 */
      [data-zrq="1"] {
        position: relative;
      }
      [data-zrq-row="1"] {
        position: relative;
      }
      [data-zrq-clip="off"] { overflow: visible !important; }

      /* 组内标记: 轻量文字前缀(非 tag 卡片), 独占一行排在行内容上方;
         样式与应用正文一致(主题 caption 字号/弱化前景色/spacing 变量间距) */
      [data-zrq-row="1"][data-zrq-label]::before {
        content: attr(data-zrq-label);
        display: block;
        width: fit-content;
        line-height: 1.5;
        margin: 0 0 calc(var(--spacing) * 2);
        font-size: var(--text-ui-caption);
        color: var(--color-foreground-subtle);
        white-space: pre-line;
        overflow-wrap: anywhere;
      }

      /* 行标签 ::after 以 label 属性存在为前提(无 label 只画竖条, 不得出空框); 上对齐行首 */
      [data-zrq="1"][data-zrq-label]::after,
      [data-zrq-plain="1"][data-zrq-label]::after {
        content: attr(data-zrq-label);
        position: absolute;
        right: calc(100% + 9px);
        top: 2px;
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
      [data-zrq-plain="1"][data-zrq-label]::after { top: 2px; }
      [data-zrq-head="1"] { position: relative; }
      [data-zrq-head="1"][data-zrq-head-label]::after {
        content: attr(data-zrq-head-label);
        position: absolute;
        right: calc(100% + 9px);
        top: 2px;
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
    document.querySelectorAll('[data-zrq-gutter]').forEach((el) => el.removeAttribute('data-zrq-gutter'));
    const s = document.getElementById(STYLE_ID);
    if (s) s.remove();
    delete W.__zcodeRequestMarker;
  };

  W.__zcodeRequestMarker = { stop, apply, start };

  // 注入点在 head 末尾, 执行时 body 尚未解析; 等 DOM 就绪再挂 observer
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
