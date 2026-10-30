# tok-badge 事实卡

功能:给 ZCode 对话界面加 token 统计。两处 UI:**流式速度位**(回复生成中,加载动画 spin 图标右侧的 `t/s`)与 **turn 统计行**(每条回复下方:`共 N tok · 缓内 x% · 缓外 y% · 输出 z% · 首字 F.s · 平均 v t/s · N 次请求 · 总耗时 D(等待 W · 响应 R · 执行 E) · 累计 C tok`)。

脚本:`inject/tok-badge.js`(单文件,自注入自挂载;头部 60 行注释是全量设计文档,排障/改版先读它)。

## 注入依赖锚点卡

部署前对**新解包产物**逐条 grep(方法见 [../common/method.md](../common/method.md));全绿才打包。

```bash
# -F 固定字符串匹配(锚点含 [] 等正则元字符,不加 -F 会假阴性);按表内「文件通配名」列选 glob(.js 与 .css 两种都要查);含引号的字面串按原样带引号
grep -Fc 'data-zcode-chat-loading-animate' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc 'data-[state=inactive]:hidden' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc -- '--color-foreground-subtlest' unpack/app_extract/out/renderer/assets/styles-*.css
```

每条命中数 > 0 即绿;0 命中 = MISS → 按 method.md 甄别。

**DOM 宿主(6 条,均在 `renderer/assets/styles-*.js`)**

| 字面串 | 用途 |
|--------|------|
| `data-zcode-chat-loading-animate` | 速度位宿主(turn 加载槽 spin 图标) |
| `group/assistant-turn` | 统计条挂靠(段/组容器) |
| `data-v4-running-live-tail` | 运行中 turn 常驻容器 |
| `"data-turn-id"`(带引号) | turn 单元 id 属性(DOM 侧 msg_ 形态 id) |
| `"data-session-id"`(带引号) | 对话面板根的会话归属(多面板归属地基) |
| `data-[state=inactive]:hidden` | 侧板 tab 隐藏态(多面板可见性) |

**帧协议与 RPC(18 条)**

| 文件通配名 | 字面串 | 用途 |
|-----------|--------|------|
| styles-*.js | `usage.delta` | 遥测事实 kind(用量主源) |
| styles-*.js | `stream.chunk` | 遥测事实 kind(流式增量) |
| styles-*.js | `row.delta` | conversation 行级帧 op |
| styles-*.js | `turn.terminal` | 事实 kind(turn 终态) |
| styles-*.js | `inputText` | row.delta 的 path(工具输入流) |
| styles-*.js | `assistantMessageId` | stream.chunk 帧 id 体系 |
| styles-*.js | `subscriptionId` | conversation 完整帧信封字段 |
| styles-*.js | `logEpoch` | conversation 完整帧信封字段 |
| styles-*.js | `readSession` | RPC 方法(权威校正数据面) |
| styles-*.js | `readSessionDebug` | RPC 方法(rounds token 主源) |
| src-*.js | `zcode-session` | channel 名(readSession 宿主) |
| src-*.js | `zcode-agent` | channel 名(readSessionDebug 宿主) |
| styles-*.js | `cachedInputTokens` | rounds usage 缓存字段 |
| styles-*.js | `generationDurationMs` | rounds 生成段字段(渲染侧字面量可能退出,见 method.md 特例) |
| styles-*.js | `tokensPerSecond` | rounds 速度字段 |
| styles-*.js | `background_task` | readSession user 行 `info.source` 枚举（后台通知合成行；tok-badge 段切判据） |
| styles-*.css | `--color-foreground-subtlest` | 主题颜色变量 |
| styles-*.css | `--color-foreground-subtle` | 主题颜色变量 |

(信封字段注意:3.14.1 起 conversation 完整帧无 `wireVersion`/`kind` 字段——旁路过滤条件按现役字段集,帧识别靠 `payload.deltas` 数组形态。)

## 机制最小结论

排障与改版需要知道的(全量在脚本头注释):

1. **数据通道零侵入**:旁路 `addEventListener` 主 MessagePort(帧本来就广播给所有 listener),绝不 start/close port、不发包;解码 TLV+LEB128 二进制帧
2. **自呼 RPC 两条硬约束**:帧必须以 `Uint8Array` 形态 postMessage(`ArrayBuffer` 形态被 host 静默丢弃);参数必须是 `[arg]` 包装的两段 TLV(裸对象 spread 报 TypeError 被静默吞)
3. **双 ID 体系**:遥测事实头 turnId 是 `turn_` 前缀,DOM `section[data-turn-id]` 是 `msg_` 前缀(= stream.chunk 的 assistantMessageId)——归组用事实 turnId,DOM 定位用 msgId,靠 stream.chunk/行级帧桥接
4. **UI 归属只认面板 DOM**:每个对话面板根带 `data-session-id`,徽标合法性=所在面板会话 === turn 的 sid。**不要从帧或外呼嗅探取「显示中会话」信号**——后台会话的帧照推(实测 10s 内 11 帧),外呼会被子代理面板劫持,两者都出过显示串台/冻结事故
5. **权威校正**:turn 终态与会话打开时自呼双 RPC(`readSession`@zcode-session 给组归属+请求时长,`readSessionDebug`@zcode-agent 的 rounds 给 token 主源+生成段,与官方调试面板同源);`rounds` 是 agent 进程内存态,**重启后从 1 重编**——历史轮次的等待/平均/首字靠帧计持久化(localStorage)兜底
6. **token 口径**:`total = input + output` 恒成立;`cacheRead/cacheWrite ⊆ input`;三桶=缓存读/非缓存/输出
7. **部分视图防线**:快照落在 turn 中途或仍在流式时整组不写不锁 `authoritative`(否则中途值冻成终值);`authoritative` 置位后迟到/重放的 usage.delta 一律丢弃防重复计
8. **速度增量两路**:遥测 `stream.chunk`(channel 只有 thought/text)+ conversation `row.delta`(path=`inputText`,工具输入 JSON 流);`path=text` 与遥测重复不计,`output.text` 是工具执行结果不计
9. **段切(steer 段粒度)**:turn 中途收到后台任务通知时,渲染侧在通知行处切新可视卡(section id=通知行 msg id),官方卡头「已工作 X」显示的是**各卡段墙钟**而非整 turn 墙钟——tok-badge 500ms 扫 DOM 新增卡切段(detectSegSplit→steerSplit),旧 turn 后续帧经重定向落新卡;权威校正组键=段边界行 msg id(`info.source==='background_task'` 判通知合成行,锚点卡 background_task 条即此依赖)

## 验证清单(换装重启后)

1. DevTools 控制台打开(Ctrl+Shift+I),执行 `localStorage.setItem('zcode:tok-badge:debug','1')` 后**刷新页面**
2. 发一轮对话,console 应有 `[tok-badge] fact usage.delta / stream.chunk` 帧流
3. 回复下方出现统计行;生成中加载图标右侧出现 `t/s` 速度位
4. `window.__tokDbg` 存在且计数在涨(facts/hit 系列字段)
5. 同页 console 应有 `[block-esc] armed`(另一脚本,注入即打)

## 排障与开关

- 徽标不出现:查 `<resources>/zcode-inject.log` 确认换装发生 → DevTools 看 `[tok-badge]` 日志 → debug 开关下看事实帧是否到达(区分「注入没生效」与「协议漂移」)
- 协议漂移排查:debug 开关 + 帧形态对照锚点卡(帧 kind/信封字段/RPC 名哪个变了,按 method.md 重定位)
- 关闭:`localStorage.setItem('zcode:tok-badge:enabled','0')` 后刷新(默认开启)

## 已知局限

- `readSessionDebug.rounds` 每会话上限 200 轮:更早轮次无生成段(不计入平均/等待/首字;总耗时不受限)
- `readSession` messageLimit 400 条:更早消息不进权威校正
- 滚出虚拟化窗口且超出最近 12 turn 的旧行,统计不保(重贴面有限)
- host 换版改了通道/方法/帧形态时**静默不恢复**(不报错)——升级后按锚点卡抽查即为此设
