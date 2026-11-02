/*
 * zcode-quota-main：主进程额度轮询/推送器（由 app.asar 的 out/main/index.js 尾部
 * 动态 import 引入；运行文件在 <resources>/zcode-quota-main.cjs，换装不重打包也能更新）。
 *
 * 缺口：ZCode 原生上下文浮层只对内置 account:* 套餐显示剩余额度；自定义供应商
 * （本机 magpie 聚合器）没有余额数据。magpie 已提供本地只读接口 /v1/magpie/quotas
 * （含各上游 provider 的 balance / windows / resets），但渲染端直接 fetch 会被
 * CORS 拦（Origin 非空即 403），故由主进程查询后推送。
 *
 * 地址：不写死端口。优先读 ZCode 个人 provider 配置里 providerId=magpie 的
 * api.baseUrl（ZCode 自己就用它连 magpie，用户改端口后自动跟随）；环境变量
 * ZCODE_QUOTA_BASE_URL 可覆盖；都解析不到才回落到 127.0.0.1:3425。请求失败时
 * 重新解析并依次探测候选地址，成功地址缓存复用。
 *
 * 安全边界：只请求回环地址（127.0.0.1 / localhost / ::1）的本地只读 GET；不带任何
 * 宿主凭据；不读写密钥；查询失败静默降级（保留上一份成功快照并标 stale），不影响
 * 客户端主流程。
 */
"use strict";

if (globalThis.__zcodeQuotaMain) return;
globalThis.__zcodeQuotaMain = true;

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, webContents, net } = require("electron");

const DEFAULT_BASE = "http://127.0.0.1:3425";
const QUOTA_PATH = "/v1/magpie/quotas";
const POLL_MS = 60 * 1000;
const TIMEOUT_MS = 5000;
const LOG = (...a) => console.error("[zcode-quota]", ...a);

let last = { data: [], fetchedAt: 0, stale: true, error: "" };
let busy = false;
let timer = null;
/* 最近一次探测成功的 origin；失败后清空，下一轮重新解析候选地址。 */
let activeBase = "";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

/* provider_config.json：config.providerConfigRules.providerRules[] 里
   providerId=magpie 的 api.baseUrl。config.json：provider.<id>.options.baseURL
   （同一份配置的另一视图）。 */
function baseFromConfigFile(file) {
  const doc = readJson(file);
  if (!doc) return "";
  const cfg = doc.config || {};
  const rules = cfg.providerRules
    || (cfg.providerConfigRules && cfg.providerConfigRules.providerRules);
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!rule || rule.providerId !== "magpie") continue;
      const raw = rule.config && rule.config.api && rule.config.api.baseUrl;
      if (typeof raw === "string" && raw) return raw;
    }
  }
  const raw = doc.provider && doc.provider.magpie && doc.provider.magpie.options
    && doc.provider.magpie.options.baseURL;
  return typeof raw === "string" ? raw : "";
}

function configFiles() {
  const out = [];
  const add = (file) => {
    if (typeof file === "string" && file && out.indexOf(file) < 0) out.push(file);
  };
  add(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);
  const dataBase = process.env.ZCODE_DATA_BASE_DIR;
  if (dataBase) {
    add(path.join(dataBase, ".zcode", "v2", "provider_config.json"));
    add(path.join(dataBase, "v2", "provider_config.json"));
  }
  add(path.join(os.homedir(), ".zcode", "v2", "provider_config.json"));
  /* 同一目录的 config.json 是同源兜底；provider_config.json 缺失或结构变化时仍可解析。 */
  for (const file of out.slice()) {
    if (path.basename(file) === "provider_config.json") {
      add(path.join(path.dirname(file), "config.json"));
    }
  }
  return out;
}

function isLoopback(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/* 只取 origin：magpie 的额度接口固定在根路径 /v1/magpie/quotas；baseUrl 带路径
   （反向代理子路径）不支持，保持“只请求本机回环”边界。 */
function normalizeBase(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!isLoopback(u.hostname)) return "";
    return u.origin;
  } catch (e) {
    return "";
  }
}

/* 候选地址按优先级去重：环境变量 → provider 配置 → 默认端口。 */
function discoverBases() {
  const out = [];
  const add = (raw, from) => {
    const base = normalizeBase(raw);
    if (!base) return;
    for (const item of out) if (item.base === base) return;
    out.push({ base, from });
  };
  add(process.env.ZCODE_QUOTA_BASE_URL, "env ZCODE_QUOTA_BASE_URL");
  add(process.env.MAGPIE_BASE_URL, "env MAGPIE_BASE_URL");
  for (const file of configFiles()) add(baseFromConfigFile(file), file);
  add(DEFAULT_BASE, "default");
  return out;
}

function isMainWindow(wc) {
  try {
    if (!wc || wc.isDestroyed() || wc.getType() !== "window") return false;
    const url = String(wc.getURL() || "");
    return url.indexOf("/out/renderer/index.html") >= 0;
  } catch (e) {
    return false;
  }
}

/* 只透传展示所需字段：接口是本机数据，但仍不把任意形状对象塞进渲染端。 */
function sanitizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  const out = {
    provider: typeof e.provider === "string" ? e.provider : "",
    name: typeof e.name === "string" ? e.name : "",
    kind: typeof e.kind === "string" ? e.kind : "",
    plan: typeof e.plan === "string" ? e.plan : "",
    user: typeof e.user === "string" ? e.user : "",
    balance: typeof e.balance === "string" ? e.balance : "",
    readAt: typeof e.readAt === "string" ? e.readAt : "",
    resets: e.resets && typeof e.resets.count === "number" ? { count: e.resets.count } : null,
    quotaSummary: e.quotaSummary && typeof e.quotaSummary === "object"
      ? { remaining: e.quotaSummary.remaining, currency: e.quotaSummary.currency }
      : null,
    windows: [],
  };
  const ws = Array.isArray(e.windows) ? e.windows : [];
  for (const w of ws) {
    if (!w || typeof w !== "object") continue;
    out.windows.push({
      name: typeof w.name === "string" ? w.name : "",
      used: typeof w.used === "number" && isFinite(w.used) ? w.used : null,
      remaining: typeof w.remaining === "number" && isFinite(w.remaining) ? w.remaining : null,
      resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : "",
      display: typeof w.display === "string" ? w.display : "",
    });
    if (out.windows.length >= 8) break;
  }
  return out;
}

function push(wc) {
  if (!isMainWindow(wc)) return;
  const json = JSON.stringify(last).replace(/[\u2028\u2029]/g, (c) =>
    c === "\u2028" ? "\\u2028" : "\\u2029");
  Promise.resolve()
    .then(() => wc.executeJavaScript(
      "window.__zcodeQuotaUpdate && window.__zcodeQuotaUpdate(" + json + ")", true))
    .catch(() => { });
}

function pushAll() {
  for (const wc of webContents.getAllWebContents()) push(wc);
}

async function fetchQuota(base) {
  const ctl = new AbortController();
  const kill = setTimeout(() => { try { ctl.abort(); } catch (e) { } }, TIMEOUT_MS);
  try {
    /* 优先 Node 原生 fetch：本机回环请求，不经过 Chromium 代理栈；旧内核无全局
       fetch 时回退 electron.net.fetch。 */
    const fetcher = typeof fetch === "function" ? fetch : net.fetch;
    const res = await fetcher(base + QUOTA_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctl.signal,
    });
    if (!res || !res.ok) throw new Error("HTTP " + (res && res.status));
    const body = await res.json();
    const arr = body && Array.isArray(body.data) ? body.data : null;
    if (!arr) throw new Error("bad shape");
    return arr.map(sanitizeEntry).filter(Boolean);
  } finally {
    clearTimeout(kill);
  }
}

async function poll() {
  if (busy) return;
  busy = true;
  let data = null;
  let error = "";
  const preferred = activeBase;
  try {
    if (preferred) {
      try {
        data = await fetchQuota(preferred);
      } catch (e) {
        error = String((e && e.message) || e);
        activeBase = "";
      }
    }
    /* 缓存地址失效（magpie 换了端口/重启）或首次启动：重新解析并逐候选探测。
       跳过刚失败的地址，避免同一轮对同一个死端口重复超时两次。 */
    if (!data) {
      for (const cand of discoverBases()) {
        if (cand.base === preferred) continue;
        try {
          data = await fetchQuota(cand.base);
          activeBase = cand.base;
          error = "";
          LOG("quota base:", cand.base, "(" + cand.from + ")");
          break;
        } catch (e) {
          error = String((e && e.message) || e);
        }
      }
    }
    if (data) {
      last = { data, fetchedAt: Date.now(), stale: false, error: "" };
    } else {
      last = {
        data: last && Array.isArray(last.data) ? last.data : [],
        fetchedAt: last ? last.fetchedAt : 0,
        stale: true,
        error: error.slice(0, 120),
      };
    }
  } finally {
    busy = false;
    pushAll();
  }
}

/* 窗口创建时 URL 仍为空，不能在这里用 isMainWindow 过滤（会永远漏挂）；只按类型挂
   事件，真正推送时由 isMainWindow 二次校验。 */
function hook(wc) {
  try {
    if (!wc || wc.isDestroyed() || wc.getType() !== "window" || wc.__zcodeQuotaHooked) return;
    wc.__zcodeQuotaHooked = true;
    wc.on("dom-ready", () => push(wc));
    wc.on("did-finish-load", () => push(wc));
  } catch (e) { }
}

app.on("web-contents-created", (e, wc) => hook(wc));

app.whenReady().then(() => {
  poll();
  timer = setInterval(poll, POLL_MS);
  /* 模块在主入口尾部才加载，窗口可能已创建/已过 dom-ready：补挂事件并做几次迟到推送，
     覆盖首屏脚本尚未执行完的窗口（正常情况 dom-ready 推送一次即够）。 */
  for (const wc of webContents.getAllWebContents()) {
    hook(wc);
    push(wc);
  }
  [1500, 5000, 15000].forEach((ms) => setTimeout(pushAll, ms));
  LOG("quota poller started");
}).catch((e) => LOG("startup failed:", e && e.message));

app.on("before-quit", () => {
  if (timer) { clearInterval(timer); timer = null; }
});
