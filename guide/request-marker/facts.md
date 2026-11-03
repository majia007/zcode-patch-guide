# request-marker 事实卡

功能:给对话步骤流标出**模型请求边界**。步骤流按工具类型折叠(explore/terminal/changes),一个 part 一行,同一行内折叠的多个工具、相邻工具行都可能来自不同模型请求,UI 本身不暴露边界。本功能按请求给行打标签(`#N` / `#N · 工具×次数`)并画灰色竖条,折叠态下「已工作」标题显示所含请求区间(`#min → #max`)。

脚本:`inject/request-marker.js`(单 IIFE,头注释即设计文档)。

## 注入依赖锚点卡

部署前对新解包产物逐条 grep(方法见 [../common/method.md](../common/method.md));全绿才打包。

```bash
# -F 固定字符串匹配;除最后一条外均在 renderer/assets/styles-*.js
grep -Fc 'data-v4-turn-unit' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc -- '"data-row-id"' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc -- '"data-turn-id"' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc 'data-history-open' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc 'chat-assistant-history-trigger' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc 'chat-assistant-history-content' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc 'assistantResponseId' unpack/app_extract/out/renderer/assets/styles-*.js
grep -Fc '__reactFiber$' unpack/app_extract/out/renderer/assets/pptxElementReference-*.js
```

每条命中数 > 0 即绿;0 命中 = MISS → 按 method.md 甄别。

| 文件通配名 | 字面串 | 用途 |
|-----------|--------|------|
| styles-*.js | `data-v4-turn-unit` | turn 单元(行对象的整轮 rows 来源) |
| styles-*.js | `"data-row-id"`(带引号) | 行元素 id 属性(打标目标) |
| styles-*.js | `"data-turn-id"`(带引号) | turn 单元 id(折叠标题归组) |
| styles-*.js | `data-history-open` | 折叠态判据(`false` = 折叠) |
| styles-*.js | `chat-assistant-history-trigger` | 折叠标题 testid 基串(运行时动态拼 `-<id>`) |
| styles-*.js | `chat-assistant-history-content` | 折叠内容 testid 基串 |
| styles-*.js | `assistantResponseId` | **分组键**:一条 assistant message = 一次请求 |
| pptxElementReference-*.js | `__reactFiber$` | React fiber 键前缀(数据入口,最脆弱的一条) |

锚点在 3.17.1 与 3.17.2 解包产物均逐条命中。

## 机制最小结论

1. **数据源是 React fiber,不走帧协议**:从 `[data-row-id]` 行的 `__reactFiber$` 向上最多 24 层读 `memoizedProps` 的 `rows` / `row` / `item.rows`;只认行对象 `assistantResponseId` 作分组键,不按 DOM 相邻关系分组
2. **请求编号**:同一时刻挂载的 turn 内按首行 id 升序编号 `#1..#N`;标签 = `#N · 工具名×次数`(工具计数超 40 字符截断)
3. **跨请求合并行**:一行/一个折叠组里的工具来自多个请求时,标签显示 `#a → #b/c` 并换行列出工具(`white-space: pre-line`,属性值含真实换行)
4. **折叠态**:折叠内容区内的行正常画条;内容区外、位于折叠态 turn 的正文行只留 `#N`(不画竖条/底色);「已工作」标题按折叠内容里的请求区间打 `#min → #max`(区间同号时只显示 `#N`),无组时清残留(防展开/滚动后沿用旧区间)
5. **裁剪解除只放开最近一个 `overflow:hidden` 祖先**,且每轮 apply 先清 `data-zrq-clip` 再重算——承载行随虚拟滚动/展开更换,旧容器滞留会永久放开 overflow 导致标签移位
6. **重打标**:body 上 `MutationObserver`(childList + subtree,rAF 去抖);属性变更不触发,只观察 childList
7. **注入时序**:脚本在 head 末尾、早于应用模块执行,必须等 `DOMContentLoaded`/body 就绪再挂 observer

DOM 锚点(排障/改版用):`data-zrq`(行有请求归属)、`data-zrq-first/-last`(竖条首尾)、`data-zrq-label`(标签文案)、`data-zrq-plain`(折叠态正文行)、`data-zrq-head(-label)`(折叠标题区间)、`data-zrq-clip`(overflow 解除标记);样式表 id `zcode-request-marker-style`。

## 验证清单(换装重启后)

1. DevTools 控制台(Ctrl+Shift+I)`window.__zcodeRequestMarker` 存在,且有 `stop` / `apply` / `start` 三个键(注入成功)
2. 打开一个含多工具调用的会话:工具行左侧出现 `#N` 标签与 1px 灰色竖条,首尾收口
3. `window.__zcodeRequestMarker.apply()` 返回 `{groups, marked, firsts}`,`groups > 0`、`marked > 0`
4. 同一行/折叠组含跨请求工具时,标签显示 `#1 → #2` 形态;折叠态「已工作」标题左侧显示区间标签
5. 滚动虚拟列表/切换会话后标签自动跟随(observer 重打);滚出的行消失属正常卸载
6. 同页 console 应有 `[block-esc] armed`(另一脚本,注入即打)

## 排障与开关

- 标签全无:先确认换装发生(查 `<resources>/zcode-inject.log`),再看 `index.html` 有 `zcode-request-marker:begin` 标记块、`window.__zcodeRequestMarker` 存在;存在但无标签 = 选择器/行属性漂移(抽查上表)
- 分组明显错乱(`#N` 数量与实际请求对不上):优先查 `assistantResponseId` 行字段与 fiber props 形态(`rows` / `row` / `item.rows`)
- 标签位置错位/布局异常:查 `data-zrq-clip` 是否标到了不该标的祖先(只应标最近一个 `overflow:hidden`)
- 关闭:`localStorage.setItem('zcode:request-marker:enabled','0')` 后刷新(默认开启);当前页立即撤销用 `window.__zcodeRequestMarker.stop()`

## 已知局限

- 依赖 React 内部 fiber 键(`__reactFiber$`)与 `memoizedProps` 形态、行对象字段命名——客户端升级可能静默失效(不报错);升级后按锚点卡抽查即为此设
- 只标注 DOM 中已挂载的行;虚拟化滚出的行滚回后由 MutationObserver 重打
- 标签画在行左侧空白带,靠临时放开一层 `overflow:hidden` 祖先避裁剪;更深层的裁剪容器不处理
