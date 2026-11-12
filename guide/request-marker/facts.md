# request-marker 事实卡

功能:给对话步骤流标出**模型请求边界**。3.18.0 起步骤流把相邻思考/工具行收进**组级折叠**(`data-consecutive-summary-group`,默认收起,trigger 上是「已执行 N 命令,已修改 N 文件」一类统计文案),同一折叠体内的多个工具、相邻工具行都可能来自不同模型请求,UI 本身不暴露边界。本功能按请求给行/组头打标签:组头显示该组请求区间(`#min → #max`)与整组工具统计,展开组内每个请求段首行显示 `#N · 工具×次数`;turn 级「已工作」折叠头同款(区间 + 该 turn 工具统计)。

脚本:`inject/request-marker.js`(单 IIFE,头注释即设计文档)。

## 注入依赖锚点卡

部署前对新解包产物逐条 grep(方法见 [../common/method.md](../common/method.md));全绿才打包。

```bash
# 除 assistantResponseId / __reactFiber$ 外均在 renderer/assets/styles-*.js
for s in data-v4-turn-unit '"data-row-id"' '"data-turn-id"' data-history-open \
         chat-assistant-history-trigger chat-assistant-history-content \
         data-consecutive-summary-group data-summary-group-trigger \
         data-summary-group-scroll data-summary-group-statistics; do
  printf '%s ' "$s"; grep -oF -- "$s" unpack/app_extract/out/renderer/assets/styles-*.js | wc -l
done
grep -oF 'assistantResponseId' unpack/app_extract/out/renderer/assets/validation-*.js | wc -l
grep -oF 'assistantResponseId' unpack/app_extract/out/preload/index.cjs | wc -l
grep -oF '__reactFiber$' unpack/app_extract/out/renderer/assets/pptxElementReference-*.js | wc -l
```

每条命中数 > 0 即绿;0 命中 = MISS → 按 method.md 甄别。

| 文件通配名 | 字面串 | 用途 |
|-----------|--------|------|
| styles-*.js | `data-v4-turn-unit` | turn 单元(行对象的整轮 rows 来源) |
| styles-*.js | `"data-row-id"`(带引号) | 行元素 id 属性(打标目标) |
| styles-*.js | `"data-turn-id"`(带引号) | turn 单元 id(折叠标题归组) |
| styles-*.js | `data-history-open` | turn 折叠态判据(`false` = 折叠) |
| styles-*.js | `chat-assistant-history-trigger` | turn 折叠标题 testid 基串(运行时动态拼 `-<id>`) |
| styles-*.js | `chat-assistant-history-content` | turn 折叠内容 testid 基串 |
| styles-*.js | `data-consecutive-summary-group` | **3.18 组级折叠**组根(组头区间标签的遍历入口) |
| styles-*.js | `data-summary-group-trigger` | 组折叠 trigger(组头标签宿主;同时是装饰行排除判据) |
| styles-*.js | `data-summary-group-scroll` | 组展开内容滚动体(组内行打标/段首判定范围) |
| styles-*.js | `data-summary-group-statistics` | 组统计文案行(辅助锚;脚本未直接消费) |
| validation-*.js | `assistantResponseId` | **分组键**(一条 assistant message = 一次请求);3.18 起渲染侧 styles 已无此字面量,走 schema 旁路命中 |
| preload/index.cjs | `assistantResponseId` | 分组键的 bridge 镜像(旁路佐证) |
| pptxElementReference-*.js | `__reactFiber$` | React fiber 键前缀(数据入口,最脆弱的一条) |

3.18.0 解包产物实测计数(`grep -oF | wc -l`,styles 侧):`2 / 5 / 4 / 4 / 1 / 1 / 2 / 1 / 1 / 1`;`assistantResponseId` validation 3 + preload 3(styles 0),`__reactFiber$` 1。3.17.x 的旧锚点卡同样全绿;3.18.0 的 `assistantResponseId` 渲染侧字面量退出属**旁路命中**,不是协议漂移。3.18.1 复验同全绿(补丁级升级,白名单锚点未动)。

## 机制最小结论

1. **数据源是 React fiber,不走帧协议**:从 `[data-row-id]` 行的 `__reactFiber$` 向上最多 24 层读 `memoizedProps`,行对象来源有 `rows` / `items[].row` / `row` / `item.row` 多种形态(3.18.0 的 `items` 是 `{kind,row,key}` 包装数组);只认行对象 `assistantResponseId` 作分组键,不按 DOM 相邻关系分组
2. **组内行取数**:收起组的 trigger 里只有统计行,组内行要从组根 fiber 的 `memoizedProps.children` 元素数组取(`props.row` / `props.item.row`,实测 ≤8 跳命中);组头区间与整组工具统计都基于这份行列表
3. **请求编号**:同一时刻挂载的 turn 内按首行 id 升序编号 `#1..#N`;组内行与组外行共用同一编号空间(编号含折叠体内不可见行,跨组稳定)
4. **组头标签**:`data-consecutive-summary-group` 的 trigger 上打 `data-zrq-head-label`,内容 `#min → #max` + 换行 + 整组工具统计(`#min === #max` 时只显示 `#N`;统计先数组内行、再补齐本组出现过的请求在组外的工具名——同一请求可被组边界切开,只数组内行会漏掉它的工具);**收起/展开都显示**(展开后作为整组总览,用户要求)。宿主必须是 **trigger 元素**,不能挂 trigger 父元素/组根——探针实测部分组根比统计行高 12px,标签会整体偏上错位
5. **组内标记**:组滚动体(`data-summary-group-scroll`)内只在**同一滚动体内同一 rid 段的首行**画标记,内容 `#N · 工具×次数`,用块级 `::before` 独占一行排在行内容上方(流内排布,不悬浮、不被横向裁剪、随滚动);同段后续行无标记。段首判定用「滚动体内同 rid 段」(`segOf`),不沿用全局 first/last(同一请求的正文行可能在组外)。样式直接复用应用主题变量:`line-height:1.5`、`margin:0 0 calc(var(--spacing)*2)`、`font-size:var(--text-ui-caption)`、`color:var(--color-foreground-subtle)`;无首行特判
6. **组外行标签**:非组内行仍用左侧标签卡(`data-zrq` + `data-zrq-label`,`#N · 工具×次数`),上对齐行首(`top:2px`);`data-zrq-first/-last` 仍标记段首尾,但 **3.18 起不再绘制我们自己加的请求竖条**——段首标签承担请求边界,**应用自带的组内容竖线保持原样,不要隐藏**
7. **装饰行跳过**:组 trigger 内嵌的统计图标行 / iT 直播摘要行携带 `data-row-id` 但不是步骤流真实行,一律不打标——否则标签错位画到统计行,竖条在图标位出碎段
8. **turn 折叠态**:折叠内容区(`chat-assistant-history-content-*`)内的行正常打标;内容区外的折叠正文行只打 `data-zrq-plain=1` + `#N`(不画竖条/底色);「已工作」标题按折叠内容里的请求区间 + 该 turn 工具统计打 `data-zrq-head-label`。**plain 判据必须排除组内行**(组滚动体不在 turn 折叠内容容器内,误判会让组内首尾/标记全丢)
9. **裁剪解除**:只放开 turn 折叠内容包裹层(`chat-assistant-history-content-*`,overflow 双 hidden)的裁剪(`data-zrq-clip=off`);途中遇到滚动容器(overflow-y auto/scroll,如时间线滚动区、组滚动体)立即停手。**每轮 apply 先清 `data-zrq-clip` / 全部组头与 turn 标题标签,再重算**——承载行/组会随虚拟滚动/折叠展开更换
10. **展开动画高度校正**:组内标记插入会增大内容高度,而 Radix 的 `--radix-collapsible-content-height` 是打标前的测量值;`apply` 末尾对展开的 `[data-slot="collapsible-content"]` 把该变量设为 `content.scrollHeight`(实测 174px vs 实际 284px),否则动画停在旧高度、结束再跳变。幂等,差异 >1px 才设置
11. **重打标**:body 上 `MutationObserver`(childList + subtree,rAF 去抖);属性变更不触发,只观察 childList。虚拟滚动卸载的行随元素消失,无需显式清理
12. **注入时序**:脚本在 head 末尾、早于应用模块执行,必须等 `DOMContentLoaded`/body 就绪再挂 observer

DOM 锚点(排障/改版用):`data-zrq`(组外行宿主)、`data-zrq-row`(组内行宿主)、`data-zrq-label`(标签文案;组内行渲染为块级 `::before`)、`data-zrq-first/-last`(组外行段首尾;3.18 起仅整形、不画请求竖条)、`data-zrq-plain`(turn 折叠态正文行)、`data-zrq-head(-label)`(组头/turn 标题区间)、`data-zrq-clip`(overflow 解除标记);样式表 id `zcode-request-marker-style`。

## 验证清单(换装重启后)

1. DevTools 控制台(Ctrl+Shift+I)`window.__zcodeRequestMarker` 存在,且有 `stop` / `apply` / `start` 三个键(注入成功)
2. 打开一个含多工具调用的会话:收起组头左侧出现区间标签(如 `#51 → #57` + 换行工具统计);展开/收起都不消失
3. 展开一个组:每个请求段的首行内容上方出现 `#N · 工具×次数`;同段后续行无标记;组内不出现我们自己加的请求竖条,应用自带组内容竖线仍在
4. `window.__zcodeRequestMarker.apply()` 返回 `{groups, marked, firsts}`,`groups > 0`、`marked > 0`
5. 展开组时高度动画不再停在旧高度再跳变(标记插入后 `--radix-collapsible-content-height` 已被校正)
6. 滚动虚拟列表/切换会话/展开收起后标签自动跟随(observer 重打);滚出的行消失属正常卸载
7. 同页 console 应有 `[block-esc] armed`(另一脚本,注入即打)

页内快速核对(CDP evaluate):`[...document.querySelectorAll('[data-zrq-head-label]')].map(e => e.getAttribute('data-zrq-head-label'))` 应含 `#a → #b\n工具×次` 形态;展开组后 `[data-summary-group-scroll] [data-zrq-label]` 只应落在段首行。

## 排障与开关

- 标签全无:先确认换装发生(查 `<resources>/zcode-inject.log`),再看 `index.html` 有 `zcode-request-marker:begin` 标记块、`window.__zcodeRequestMarker` 存在;存在但无标签 = 选择器/行属性漂移(抽查上表)
- 组头区间标签不出现:优先查 `data-consecutive-summary-group` / `data-summary-group-trigger`,以及组根 fiber `memoizedProps.children` 的行形态(`props.row` / `props.item.row`);组根找不到 trigger 时该组自然跳过
- 组内标记不出现或错位:确认行在 `[data-summary-group-scroll]` 内、`segOf` 能取到同 rid 段;检查 `data-zrq-row` 是否打上
- 标签漂到视图左上角/被裁:检查 `[data-zrq="1"]` / `[data-zrq-row="1"]` 的 `position:relative` 与 `[data-zrq-clip="off"]` 规则是否还在(删竖条时不要连带删除这两条)
- 组内行只有 `#N`、没有段首/段尾:检查 plain 判据是否漏了 `!inGroupScroll`(组滚动体不在 turn 折叠内容容器内)
- 展开组动画跳变:确认 `apply` 末尾的高度变量校正未失效(元素需同时满足 `data-slot="collapsible-content"`、`data-state="open"`、含 `[data-summary-group-scroll]`)
- 分组明显错乱(`#N` 数量与实际请求对不上):优先查 `assistantResponseId` 行字段与 fiber props 形态(`rows` / `items` / `row` / `item.row` / `children`)
- 关闭:`localStorage.setItem('zcode:request-marker:enabled','0')` 后刷新(默认开启);当前页立即撤销用 `window.__zcodeRequestMarker.stop()`

## 已知局限

- 依赖 React 内部 fiber 键(`__reactFiber$`)与 `memoizedProps` 形态、行对象字段命名——客户端升级可能静默失效(不报错);升级后按锚点卡抽查即为此设
- 组内行取数依赖组根 fiber 的 `children` 元素数组形态;官方重构组件层级时可能失效,表现为组头无区间、组内无标记,但组外行仍工作
- 只标注 DOM 中已挂载的行;虚拟化滚出的行滚回后由 MutationObserver 重打
- 组内标记是流内插入,会改变内容高度;展开动画依赖对 Radix 高度变量的校正,若官方更换动画实现需重新核对
