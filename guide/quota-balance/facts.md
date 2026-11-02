# quota-balance 事实卡

功能:在原生「上下文容量」浮层(点 composer 的上下文用量圆环弹出)底部追加第三方「剩余额度」段。ZCode 原生只对内置 `account:*` 套餐显示剩余额度;本补丁从本机 magpie 聚合器的只读接口取数,按**当前模型**对应的 provider 渲染周期窗口(剩余百分比 + 重置时刻 + 进度条)或余额文本。

脚本:`inject/quota-balance.js`(渲染端,注入 `renderer/index.html`)+ `inject/quota-main.cjs`(主进程轮询/推送,由 `pack.mjs` 拷到 `<resources>/zcode-quota-main.cjs` 并挂到主进程入口)。两个文件头部注释即全量设计文档。

⚠️ **前提**:本功能的数据源是 magpie 聚合器的本地接口 `GET <base>/v1/magpie/quotas`,`<base>` 从 ZCode provider 配置解析(默认 `http://127.0.0.1:3425`,见「机制最小结论」第 3 条)。没跑 magpie、或模型不经过它时,该段**静默不显示**——不会报错,也不会影响其它功能。内置 `account:*` 套餐仍由原生段承载,本段不重复显示。

## 注入依赖锚点卡

部署前对新解包产物逐条 grep(方法见 [../common/method.md](../common/method.md));全绿才打包。

```bash
S=unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc '!w-80' $S
grep -Fc 'v4-model-config' $S
grep -Fc 'v4-session-pane' $S
grep -Fc 'chat-context-usage-trigger' $S
grep -Fc 'data-provider' $S
grep -Fc 'data-model' $S
grep -Fc 'hover-card-content' $S
grep -F 'data-slot' unpack/app_extract/out/renderer/assets/pptxElementReference-*.js | grep -c 'progress'
```

每条命中数 > 0 即绿;0 命中 = MISS → 按 method.md 甄别。

| 文件通配名 | 字面串 | 用途 |
|-----------|--------|------|
| styles-*.js | `!w-80` | 上下文浮层唯一宽度指纹(判段第一层) |
| styles-*.js | `v4-model-config` | composer 模型配置 testid(`data-provider`/`data-model` 的宿主节点) |
| styles-*.js | `data-provider` | 当前 provider 属性(内置 `account:*` 门控) |
| styles-*.js | `data-model` | 当前模型 id 属性(前缀映射 magpie provider) |
| styles-*.js | `v4-session-pane` | 面板 testid 常量;运行时为 `v4-session-pane-<id>`(脚本用前缀选择器) |
| styles-*.js | `chat-context-usage-trigger` | 上下文浮层触发器(几何最近归 pane) |
| styles-*.js | `hover-card-content` | hover-card 封装(`data-slot` 值) |
| pptxElementReference-*.js | ``data-slot":`progress` `` | Progress 组件(运行时 `data-slot="progress"`,浮层指纹第二层) |

运行时指纹第三层 `div.space-y-3` 是浮层内容根,对应的 bundle 字面串是 class `space-y-3`(太泛,不作硬锚点;脚本用 DOM 选择器匹配)。

## 机制最小结论

1. **为什么走主进程**:渲染端直接 `fetch` magpie 会带 `Origin`,magpie 返回 403;主进程 Node 请求无 Origin,正常 200。主脚本 `executeJavaScript` 调 `window.__zcodeQuotaUpdate(payload)` 推给各窗口,渲染端**不发网络请求**。
2. **主进程注入链**:`pack.mjs` 把 `quota-main.cjs` 写到 `<resources>/zcode-quota-main.cjs`(不进 asar,换装不重打包也能更新),再在 `out/main/index.js` 尾部追加标记块 `import("file://…/zcode-quota-main.cjs")`。幂等靠「先剥旧块再追加」;换安装目录时 file URL 自动更新。
3. **地址解析**:不写死端口。候选顺序:环境变量 `ZCODE_QUOTA_BASE_URL`/`MAGPIE_BASE_URL` → ZCode 个人 provider 配置(`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_DATA_BASE_DIR` / `~/.zcode` 下的 `provider_config.json` 中 `config.providerConfigRules.providerRules` 里 `providerId=magpie` 的 `config.api.baseUrl`,与 ZCode 连接 magpie 的是同一份;同目录 `config.json` 的 `provider.magpie.options.baseURL` 兜底)→ 默认 `http://127.0.0.1:3425`。只接受 http(s) 回环地址(`127.0.0.1`/`localhost`/`::1`),非回环一律忽略;配置都读不到时静默用默认端口。请求失败时清空缓存、重新解析并逐候选探测,成功地址缓存复用。
4. **数据边界**:主进程只透传展示字段(`provider/name/kind/plan/user/balance/readAt/windows≤8/resets.count/quotaSummary`),失败保留上一份成功快照并标 `stale`,不阻断客户端主流程。
5. **挂载幂等**:浮层由 Radix 按需挂载、关闭即整棵卸载。脚本用 body 级 `MutationObserver`(只盯直接子节点增删)+ 1.5s 轻量扫描;`!w-80` + `data-slot="progress"` + `div.space-y-3` 三条件识别浮层,按 `.zcode-quota-section` 存在性幂等插入,位置始终兜回内容根末尾。
6. **归属判定**:几何最近的 `chat-context-usage-trigger` → 所属 `v4-session-pane-*` → 该 pane 内第一个带 `data-provider` 的 `v4-model-config`。不看帧/全局 store,多面板不串台。
7. **展示范围**:只显示**当前模型**的 provider——模型 id 前缀(`opencode-go/...`、`zcode/...`、`deepseek/...`)与 magpie provider 名小写相等才显示,匹配不到整段不显示;`account:*` 直接跳过(避免与原生段重复)。周期限额复用原生「剩余额度」段结构与 Tailwind 类名;余额型替换为一枚放大等宽文本;不显示更新时间/页脚/magpie 标识/其它 provider 列表。

## 验证清单(换装重启后)

1. `node inject/pack.mjs` 输出应含 `[0/2] main patch OK zcode-quota` 与 `[1/2] inject OK quota-balance`
2. `<resources>/zcode-quota-main.cjs` 存在;解包产物 `out/main/index.js` 尾部有 `/* zcode-quota:begin */` 标记块
3. `curl <base>/v1/magpie/quotas` 返回 200 JSON(`<base>` 取 ZCode provider 配置里 magpie 的 baseUrl,默认 `http://127.0.0.1:3425`;无 magpie 则本功能不适用)
4. 选一个走 magpie 的第三方模型(provider 非 `account:*`),点开上下文用量浮层:底部出现「剩余额度」段,标题右侧显示 provider 名
5. DevTools 控制台:`typeof window.__zcodeQuotaUpdate === 'function'`、`document.querySelectorAll('.zcode-quota-section').length` 在浮层打开时为 1
6. 关闭浮层再打开:段仍在(挂载幂等);切到内置 `account:*` 套餐:段消失

## 排障与开关

- 段不出现:① 当前 provider 是 `account:*`(原生段接管,正常);② 模型 id 前缀与 magpie provider 不匹配(如 `xxx/...` 而接口里没有 `xxx`);③ magpie 没起或接口无数据;④ 浮层指纹漂移(按上表抽查);⑤ provider 配置里解析不到 magpie 地址且默认端口上没有 magpie(见「机制最小结论」第 3 条)
- 主进程模块是否加载:看 `<resources>/zcode-quota-main.cjs` 是否存在、`out/main/index.js` 尾部标记块是否在。**注意**:`[zcode-quota]` 日志打在主进程,不进 renderer DevTools——DevTools 里看不到是正常的,不要据此判定失败
- 关闭:`localStorage.setItem('zcode:quota-balance:enabled','0')` 后刷新(默认开启);主进程仍按 60s 轮询,仅 UI 不渲染。恢复:删键或置 `1`
- 回滚:换回 `app.asar.old` 即可。注意 `.old` 是**本次换装前**的包:首次部署时它是原始包(不含 import 标记块,额度段随回滚一起消失);此前已部署过注入版时,`.old` 也带标记块,配合 resources 里的 cjs 额度段会继续工作。`zcode-quota-main.cjs` 留着无害

## 已知局限

- **地址只接受回环**:从 ZCode provider 配置解析 magpie baseUrl,`ZCODE_QUOTA_BASE_URL` 可覆盖;非回环地址(含局域网 IP)一律忽略。主进程只认 `ZCODE_DATA_BASE_DIR` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 与 `~/.zcode/v2/` 下的配置——都读不到时静默回落默认 `127.0.0.1:3425`,若 magpie 实际不在默认端口则取不到数(需改配置或设环境变量);没有设置面板。聚合器标识 `providerId=magpie` 与接口路径 `/v1/magpie/quotas` 仍写死,换非 magpie 聚合器需改代码后重新打包
- 主进程快照带 `stale`/`error`/`fetchedAt`,但渲染端目前**不消费**——magpie 短暂失败时继续显示上一份数据,无「数据已过期」提示
- provider 映射只认模型 id 前缀;接口里 provider 名与模型前缀不一致时整段不显示(不回退成 provider 列表)
- 浮层识别依赖 `!w-80`/`data-slot="progress"`/`space-y-3` 三个 UI 指纹,升级后该类名变化会**静默失效**(需按锚点卡重定位)
- 关闭 UI 开关不减轮询;主进程每 60s 请求一次本机接口
