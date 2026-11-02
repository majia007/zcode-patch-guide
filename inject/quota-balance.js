/*
 * zcode-quota-balance：原生「上下文容量」浮层内的第三方「剩余额度」段（渲染端注入脚本）。
 *
 * 缺口：ZCode 3.17.1 的上下文浮层对自定义供应商（本机为 magpie 聚合器）只显示上下文
 * 占比与来源拆解，没有账号余额/套餐窗口。原生「剩余额度」段只服务内置 account:* 套餐。
 *
 * 设计（2026-11-02 用户确认）：
 *   - 只显示当前模型对应 provider 的额度（模型 id 前缀映射 provider），匹配不到整段不显示；
 *   - 周期限额：直接复用原生 GLM 套餐「剩余额度」段的 DOM 结构与 Tailwind 类名——
 *     标题行 + grid gap-2 grid-cols-3 + 每列（标签 / 剩余百分比 + 重置时刻 / 进度条）；
 *     opencode 三列为「5 小时额度 / 周额度 / 总额度」；
 *   - 余额型（balance 或单窗口 display）：标题不变，三列区替换为一枚放大的余额文本；
 *   - 不显示更新时间/页脚/magpie 标识/重置卡徽标/其它 provider 列表。
 *
 * 数据：主进程脚本 zcode-quota-main.cjs 轮询 magpie 的 /v1/magpie/quotas，经
 * window.__zcodeQuotaUpdate(payload) 推入本脚本；本脚本不在渲染端发网络请求。
 *
 * 挂载：浮层由 Radix 按需挂载（无 forceMount），关闭即整棵卸载；本脚本用 body 级
 * MutationObserver（挂载即扫）+ 1.5s 轻量扫描兜底，按 DOM 存在性幂等重注入。插入点是
 * 浮层内容根 div.space-y-3 的末尾（宿主缓存命中率行之后），节点类名自带标识，重复
 * 挂载不会堆积。React 只原地 patch、不清理外来兄弟节点；被清掉时下一拍补回。
 */
(function () {
  /* 代际守卫：热重注入/探针重跑时先释放上一代，旧 interval 靠代际号罢工，避免两份
     脚本互相覆盖同一节点的内容。正常页面加载只会执行一次。 */
  if (window.__zcodeQuotaDispose) { try { window.__zcodeQuotaDispose(); } catch (e) { } }
  if (window.__zcodeQuotaBalance) return;
  window.__zcodeQuotaBalance = true;
  var MY_GEN = (window.__zcodeQuotaGen = (window.__zcodeQuotaGen || 0) + 1);
  function alive() { return MY_GEN === window.__zcodeQuotaGen; }

  var ENABLE_KEY = "zcode:quota-balance:enabled";
  var STYLE_ID = "zcode-quota-balance-style";
  var CSS_VERSION = "3";
  var POP_SEL = '[data-slot="hover-card-content"]';
  var TRIGGER_SEL = '[data-testid="chat-context-usage-trigger"]';
  var MODEL_SEL = '[data-testid="v4-model-config"]';
  var SECTION_CLASS = "zcode-quota-section";

  var state = { data: [], fetchedAt: 0, stale: false, error: "" };
  var scanTimer = 0, scanQueued = false, observer = null;

  function enabled() {
    try { return localStorage.getItem(ENABLE_KEY) !== "0"; } catch (e) { return true; }
  }

  function labelOf(name) {
    var n = String(name || "").toLowerCase();
    if (n.indexOf("mcp") >= 0) return "ZCode MCP";
    if (n.indexOf("5 hour") >= 0 || n.indexOf("5小时") >= 0 || n === "fivehour") return "5 小时额度";
    if (n.indexOf("7 day") >= 0 || n.indexOf("week") >= 0 || n.indexOf("7天") >= 0) return "周额度";
    if (n.indexOf("month") >= 0 || n.indexOf("月") >= 0) return "总额度";
    if (n.indexOf("credit") >= 0) return "额度";
    return String(name || "");
  }

  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  function windowPct(w) {
    var r = num(w && w.remaining);
    if (r != null) return Math.max(0, Math.min(100, r));
    var u = num(w && w.used);
    if (u != null) return Math.max(0, Math.min(100, 100 - u));
    return null;
  }

  function windowText(w) {
    if (!w) return "";
    var r = num(w.remaining);
    if (r != null) return Math.round(r) + "%";
    if (w.display) return String(w.display);
    var u = num(w.used);
    if (u != null) return "已用 " + Math.round(u) + "%";
    return "";
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function fmtReset(v) {
    var t;
    if (typeof v === "number" && isFinite(v)) t = v;
    else t = Date.parse(String(v || ""));
    if (!isFinite(t)) return "";
    var d = new Date(t);
    var now = new Date();
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }
    return (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  function balanceText(e) {
    if (!e) return "";
    if (typeof e.balance === "string" && e.balance) return e.balance;
    var ws = Array.isArray(e.windows) ? e.windows : [];
    if (ws.length === 1 && ws[0] && ws[0].display) return String(ws[0].display);
    if (e.quotaSummary && num(e.quotaSummary.remaining) != null) {
      var cur = e.quotaSummary.currency ? " " + e.quotaSummary.currency : "";
      return String(e.quotaSummary.remaining) + cur;
    }
    return "";
  }

  function ensureStyle() {
    var st = document.getElementById(STYLE_ID);
    if (st && st.getAttribute("data-v") === CSS_VERSION) return;
    if (!st) {
      st = document.createElement("style");
      st.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(st);
    }
    st.setAttribute("data-v", CSS_VERSION);
    /* 其余排版全部复用宿主 Tailwind 类（见 renderColumns/headRow）；这里只补余额字号，
       原生没有对应变体。 */
    st.textContent =
      ".zcode-quota-section .zq-balance{font-size:calc(var(--ui-font-size,14px) + 6px);" +
      "line-height:1.25;font-weight:600;color:var(--color-foreground,#e9edf4);overflow-wrap:anywhere}";
  }

  function buildSection() {
    var sec = document.createElement("div");
    sec.className = SECTION_CLASS + " border-t border-border pt-2";
    sec.setAttribute("data-zcode-quota", "1");
    return sec;
  }

  function headRow(providerName) {
    var head = document.createElement("div");
    head.className = "flex min-w-0 items-center mb-2 gap-3";
    var left = document.createElement("div");
    left.className = "flex min-w-0 flex-1 items-center gap-1";
    var title = document.createElement("span");
    title.className = "min-w-0 truncate text-ui-base font-medium text-foreground";
    title.textContent = "剩余额度";
    left.appendChild(title);
    head.appendChild(left);
    /* 原生右侧是「额度已更新」绿色 check；第三方段改显示当前 provider 名称，信息量更大。 */
    if (providerName) {
      var name = document.createElement("span");
      name.className = "shrink-0 text-ui-sm text-foreground-subtle";
      name.textContent = providerName;
      head.appendChild(name);
    }
    return head;
  }

  function valueLine(w) {
    var vrow = document.createElement("div");
    vrow.className = "relative min-w-0 overflow-hidden whitespace-nowrap text-ui-sm tabular-nums";
    var val = document.createElement("span");
    val.className = "font-mono text-foreground";
    val.textContent = windowText(w);
    vrow.appendChild(val);
    var reset = fmtReset(w.resetsAt);
    if (reset) {
      var t = document.createElement("span");
      t.className = "text-ui-xs text-foreground-subtle";
      t.textContent = " · " + reset;
      vrow.appendChild(t);
    }
    return vrow;
  }

  function barNode(w, colorVar) {
    var bar = document.createElement("div");
    bar.className = "h-1.5 overflow-hidden rounded-full bg-surface-hover";
    var pct = windowPct(w);
    if (pct != null) {
      var fill = document.createElement("div");
      fill.className = "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none min-w-1.5";
      fill.style.backgroundColor = colorVar;
      fill.style.width = pct + "%";
      bar.appendChild(fill);
    }
    return bar;
  }

  function columnNode(w, idx) {
    var col = document.createElement("div");
    col.className = "min-w-0 space-y-1.5";
    var box = document.createElement("div");
    box.className = "min-w-0 space-y-0.5 text-ui-sm";
    var lrow = document.createElement("div");
    lrow.className = "flex min-h-5 min-w-0 items-center gap-1";
    var label = document.createElement("span");
    label.className = "min-w-0 truncate text-foreground-subtle";
    label.textContent = labelOf(w.name);
    lrow.appendChild(label);
    box.appendChild(lrow);
    box.appendChild(valueLine(w));
    col.appendChild(box);
    col.appendChild(barNode(w, "var(--color-usage-chart-" + (idx + 1) + ")"));
    var title = [labelOf(w.name)];
    if (num(w.used) != null) title.push("已用 " + Math.round(w.used * 10) / 10 + "%");
    if (num(w.remaining) != null) title.push("剩余 " + Math.round(w.remaining * 10) / 10 + "%");
    if (w.display) title.push(w.display);
    var reset = fmtReset(w.resetsAt);
    if (reset) title.push("重置 " + reset);
    col.title = title.join(" · ");
    return col;
  }

  function mcpRow(w) {
    var row = document.createElement("div");
    row.className = "mt-1 flex min-w-0 items-center gap-2 border-t border-border pt-1.5 text-ui-sm";
    row.style.gridColumn = "1 / -1";
    var left = document.createElement("span");
    left.className = "shrink-0";
    var inner = document.createElement("span");
    inner.className = "flex min-w-0 items-center gap-1";
    var label = document.createElement("span");
    label.className = "min-w-0 truncate text-foreground-subtle";
    label.textContent = labelOf(w.name);
    inner.appendChild(label);
    left.appendChild(inner);
    row.appendChild(left);
    var right = document.createElement("span");
    right.className = "ml-auto min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap";
    var wrap = document.createElement("span");
    wrap.className = "min-w-0 truncate whitespace-nowrap tabular-nums";
    var val = document.createElement("span");
    val.className = "font-mono text-foreground";
    val.textContent = windowText(w);
    wrap.appendChild(val);
    var reset = fmtReset(w.resetsAt);
    if (reset) {
      var t = document.createElement("span");
      t.className = "text-ui-xs text-foreground-subtle";
      t.textContent = " · " + reset;
      wrap.appendChild(t);
    }
    right.appendChild(wrap);
    row.appendChild(right);
    var bar = document.createElement("div");
    bar.className = "h-1.5 min-w-10 overflow-hidden rounded-full bg-surface-hover shrink-0";
    bar.style.width = "calc(33.3333% - 0.333333rem)";
    var pct = windowPct(w);
    if (pct != null) {
      var fill = document.createElement("div");
      fill.className = "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none min-w-1.5";
      fill.style.backgroundColor = "var(--color-usage-chart-5)";
      fill.style.width = pct + "%";
      bar.appendChild(fill);
    }
    row.appendChild(bar);
    return row;
  }

  function renderColumns(sec, entry) {
    var ws = Array.isArray(entry.windows) ? entry.windows : [];
    var mcp = null, primary = [];
    for (var i = 0; i < ws.length; i++) {
      if (!mcp && /mcp/i.test(String((ws[i] || {}).name || ""))) mcp = ws[i];
      else if (primary.length < 3) primary.push(ws[i]);
    }
    var grid = document.createElement("div");
    if (primary.length === 3) {
      grid.className = "grid gap-2 grid-cols-3";   // 与原生 GLM 三列完全同构
    } else {
      grid.className = "grid gap-2";
      grid.style.gridTemplateColumns = "repeat(" + Math.max(primary.length, 1) + ",minmax(0,1fr))";
    }
    for (var j = 0; j < primary.length; j++) grid.appendChild(columnNode(primary[j], j));
    if (mcp) grid.appendChild(mcpRow(mcp));
    sec.appendChild(grid);
  }

  function renderBalance(sec, text) {
    var el = document.createElement("div");
    el.className = "zq-balance font-mono";
    el.textContent = text;
    sec.appendChild(el);
  }

  function currentEntry(model) {
    var id = modelProviderId(model).toLowerCase();
    if (!id) return null;
    var arr = Array.isArray(state.data) ? state.data : [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].provider || "").toLowerCase() === id) return arr[i];
    }
    return null;
  }

  function updateSection(sec, provider, model) {
    if (!provider || provider.indexOf("account:") === 0) { sec.remove(); return; }
    var entry = currentEntry(model);
    if (!entry) { sec.remove(); return; }   // 当前模型没有对应额度：整段不显示
    var bal = balanceText(entry);
    var ws = Array.isArray(entry.windows) ? entry.windows : [];
    var mode = bal && (String(entry.kind || "") === "balance" || ws.length <= 1) ? "balance" : "columns";
    var pname = String(entry.name || entry.provider || "");
    var sig = JSON.stringify([model, entry, mode]);
    if (sec.__zqSig === sig) return;
    sec.__zqSig = sig;
    while (sec.firstChild) sec.removeChild(sec.firstChild);
    sec.appendChild(headRow(pname));
    if (mode === "balance") renderBalance(sec, bal);
    else if (ws.length) renderColumns(sec, entry);
    else if (bal) renderBalance(sec, bal);
    else sec.remove();
  }

  function modelProviderId(model) {
    var m = String(model || "");
    var i = m.indexOf("/");
    return i > 0 ? m.slice(0, i) : "";
  }

  function nearestTrigger(pop) {
    var list = [];
    try { list = document.querySelectorAll(TRIGGER_SEL); } catch (e) { return null; }
    var r0 = pop.getBoundingClientRect();
    var cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    var best = null, bd = Infinity;
    for (var i = 0; i < list.length; i++) {
      var r = null;
      try { r = list[i].getBoundingClientRect(); } catch (e) { }
      if (!r || r.width <= 0 || r.height <= 0) continue;
      var dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best;
  }

  function selectionOf(pop) {
    var trig = nearestTrigger(pop);
    if (!trig) return null;
    var pane = null;
    try { pane = trig.closest('[data-testid^="v4-session-pane-"]'); } catch (e) { }
    if (!pane) return null;
    var nodes = pane.querySelectorAll(MODEL_SEL);
    if (!nodes.length) return null;
    /* v4-model-config 是挂在 composer 上的数据标记节点（实测 rect 全 0），不能用可见性
       过滤；同一 pane 内取第一个带 data-provider 的节点，避免误取空配置。 */
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      if (String(nodes[i].getAttribute("data-provider") || "")) { best = nodes[i]; break; }
    }
    if (!best) best = nodes[0];
    return {
      provider: String(best.getAttribute("data-provider") || ""),
      model: String(best.getAttribute("data-model") || ""),
    };
  }

  function scan() {
    scanQueued = false;
    if (!alive()) return;
    if (!enabled()) {
      var old = document.querySelectorAll("." + SECTION_CLASS);
      for (var k = 0; k < old.length; k++) old[k].remove();
      return;
    }
    var pops = [];
    try { pops = document.querySelectorAll(POP_SEL); } catch (e) { return; }
    for (var i = 0; i < pops.length; i++) {
      var pop = pops[i];
      try {
        if (!pop.classList || pop.className.indexOf("!w-80") < 0) continue;
        if (!pop.querySelector('[data-slot="progress"]')) continue;
      } catch (e) { continue; }
      var body = pop.querySelector("div.space-y-3");
      if (!body) continue;
      var sel = selectionOf(pop);
      var provider = sel ? sel.provider : "";
      var model = sel ? sel.model : "";
      var sec = null;
      for (var j = body.children.length - 1; j >= 0; j--) {
        if (body.children[j] && body.children[j].classList &&
            body.children[j].classList.contains(SECTION_CLASS)) { sec = body.children[j]; break; }
      }
      if (!provider || provider.indexOf("account:") === 0) {
        if (sec) sec.remove();   // 内置套餐由原生「剩余额度」段承载，不重复
        continue;
      }
      if (!sec) {
        sec = buildSection();
        body.appendChild(sec);
      } else if (sec !== body.lastElementChild) {
        body.appendChild(sec);   // 位置兜回：始终在浮层内容末尾
      }
      ensureStyle();
      updateSection(sec, provider, model);
    }
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scan, 80);
  }

  window.__zcodeQuotaUpdate = function (payload) {
    if (!payload || typeof payload !== "object") return;
    state = {
      data: Array.isArray(payload.data) ? payload.data : [],
      fetchedAt: typeof payload.fetchedAt === "number" ? payload.fetchedAt : 0,
      stale: !!payload.stale,
      error: typeof payload.error === "string" ? payload.error : "",
    };
    scheduleScan();
  };

  function startObserver() {
    try {
      if (!document.body) return false;
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true });   // Radix 浮层直接挂 body，只监听直接子节点增删
      return true;
    } catch (e) { return false; }
  }
  if (!startObserver()) {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }
  scanTimer = setInterval(scan, 1500);
  window.__zcodeQuotaDispose = function () {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = 0; }
    if (observer) { try { observer.disconnect(); } catch (e) { } observer = null; }
    try {
      document.querySelectorAll("." + SECTION_CLASS).forEach(function (el) { el.remove(); });
    } catch (e) { }
    window.__zcodeQuotaBalance = false;
  };
  window.addEventListener("beforeunload", function () {
    if (window.__zcodeQuotaDispose) window.__zcodeQuotaDispose();
  }, { once: true });
  scan();
})();
