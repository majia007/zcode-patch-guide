# project-tools 事实卡

功能:增强左侧侧栏的**「项目」分区**——分区标题 hover 操作区加「名称排序 / 最近更新时间排序」与项目名筛选(宽时输入框常驻并自适应吃满富余宽度,窄时退回按钮点击展开);每个项目行的动作组加「移到最上方」;项目下有任务运行中时项目名称右侧显示与任务行同款的加载图标;会话空闲但后台任务仍在跑的任务行,行首状态格显示静态终端图标;项目展开区的任务行相对时间按「实际活跃时刻」刷新(不再随冻结的 updatedAt 漂旧),列表按同口径新→旧排序、悬停冻结。

脚本:`inject/project-tools.js`(单 IIFE,头注释即设计文档)。

## 注入依赖锚点卡

部署前对新解包产物逐条 grep(方法见 [../common/method.md](../common/method.md));全绿才打包。

```bash
# 除最后一条外均在 renderer/assets/styles-*.js
for s in data-project-id data-project-name data-project-host project-section \
         virtual-project-toggle virtual-project-actions data-purpose-section-list \
         __zcodeSessionActivity zcode-project-sidebar-preferences \
         data-task-item-key hasBackgroundWork \
         lastActivityAt data-task-row-metadata data-task-list-show-more task-new-button; do
  printf '%s ' "$s"; grep -oF -- "$s" unpack/app_extract/out/renderer/assets/styles-*.js | wc -l
done
grep -oF '__reactFiber$' unpack/app_extract/out/renderer/assets/pptxElementReference-*.js | wc -l
```

每条命中数 > 0 即绿;0 命中 = MISS → 按 method.md 甄别。

| 文件通配名 | 字面串 | 用途 |
|-----------|--------|------|
| styles-*.js | `data-project-id` | 项目行 `section` 的 id 属性(定位与分组) |
| styles-*.js | `data-project-name` | 项目行名称属性(排序键 + 筛选匹配) |
| styles-*.js | `data-project-host` | 项目行 host 属性(顺序持久化键) |
| styles-*.js | `project-section` | 分区标题 testid(`data-testid=project-section`,按钮/筛选行注入点) |
| styles-*.js | `virtual-project-toggle` | 项目行折叠触发器 testid 基串(图标位宿主,含 `-all`) |
| styles-*.js | `virtual-project-actions` | 项目行动作组 testid(「移到最上方」注入点) |
| styles-*.js | `data-purpose-section-list` | 分区列表容器属性 |
| styles-*.js | `__zcodeSessionActivity` | 任务活动对象挂载键(`phase` = running/prewarming,运行态判据) |
| styles-*.js | `data-task-item-key` | 任务行 `li` 键属性(后台标记行定位;分组视图 div 行不消费) |
| styles-*.js | `hasBackgroundWork` | `__zcodeSessionActivity` 的后台工作字段(后台标记判据;原生指示器不消费,仅活跃排序消费) |
| styles-*.js + host/index.js + host/chunk-*.js | `lastActivityAt` | 活动时刻字段(任务时间/排序「实际活跃时刻」= max(updatedAt, lastActivityAt) 的数据源;updatedAt 运行期冻结在 ingest 时刻) |
| styles-*.js | `data-task-row-metadata` | 任务行元信息行(时间改写节点=其末子节点) |
| styles-*.js | `data-task-list-show-more` | 项目任务列表尾部「显示更多」按钮(任务排序容器 guard 识别) |
| styles-*.js | `task-new-button` | task-list testid 族常量块成员(旁证 `data-testid=task-list` 基串仍在——任务包装层定位) |
| styles-*.js | `zcode-project-sidebar-preferences` | 应用自身的项目顺序/视图持久化 localStorage 键(「移到最上方」写它) |
| pptxElementReference-*.js | `__reactFiber$` | React fiber 键前缀(读 `memoizedProps.project/tasks`) |

锚点在上游仓库 3.17.2 解包产物逐条命中;本仓库现存的 3.17.1 解包产物同样逐条命中(旧 9 项计数 9 / 4 / 2 / 1 / 2 / 1 / 1 / 2 / 2,`__reactFiber$` 1;后台标记两项 `data-task-item-key` / `hasBackgroundWork` 各 3,2026-11-05 补验;2026-11-12 增补四项在 3.17.1 实测 `lastActivityAt` 7(host index 6 / host chunk 5)、`data-task-row-metadata` 2、`data-task-list-show-more` 2、`task-new-button` 1,上游 3.18.1 解包产物同样逐条命中)。

## 机制最小结论

1. **排序是视觉覆盖**:给项目列表容器加 `data-zqp-list`(CSS 改 flex 列),给 `section[data-project-id]` 写行内 `style.order`——**不改写** `zcode-project-sidebar-preferences.order`(用户手动顺序),取消排序即清 `style.order` 复原
2. **两种排序**:名称三态循环 **正序 → 倒序 → 取消**(正/倒序图标不同,比较用 `localeCompare('zh-CN', { numeric: true })`);时间只有 **新→旧 ↔ 取消** 两态(不提供旧→新,激活态沿用「新→旧」图标)。更新时间取该项目下任务**实际活跃时刻** `max(updatedAt, activity.lastActivityAt)` 的最大值,无任务 = 0 排最后
3. **筛选(双形态,2026-11-12)**:按 `data-project-name` 不区分大小写包含匹配,命中保留、其余打 `data-zqp-hidden`(`display:none`),输入即筛。**宽**(标题行富余 ≥112px):输入框常驻标题操作区最前(随操作区 hover/focus-within 一起显隐——actions 容器原生 `opacity-0` + `group-*` 类自带,输入中因聚焦保持可见),无边框深色背景 + placeholder,自适应吃满富余宽度(标题退内容宽、actions 参与 grow);有内容时框内右侧出 ×,**只清空不收起**。**窄**:退回「筛选」按钮,点击在标题下方展开输入行(同款样式,收起的分区先展开并 focus),×/ESC **清除并收起**(生成中 ESC 会被 block-esc 吞掉,所以必须有可点的清除入口)。富余宽度判据 = 行宽 − 标题自然宽(按子元素 rect 求和;`scrollWidth` 在拉伸态失真不可用)− 按钮组宽;窄形态按钮在场使切换带 ~26px 滞后、边界不抖;`ResizeObserver` 拖侧栏即时响应 + 1.5s 轮询兜底;**宽→窄切换时若已有筛选词,窄形态展开行自动打开**(否则列表仍被过滤但界面无可见指示)
4. **移到最上方**:只把该项目键 `JSON.stringify([hostId, id])` 移到 `localStorage['zcode-project-sidebar-preferences'].order` 中**同父容器(同组)首槽**,再合成 `StorageEvent('storage')` 让应用 store 立刻采用——与应用自身拖拽排序同一条持久化路径;不改 `pinned`。排序视图下点击顺带回到手动顺序
5. **运行中图标**:从项目行 `section` 的 React fiber 向上找 `memoizedProps.project/tasks`,按 `tasks[].__zcodeSessionActivity.phase`(`running`/`prewarming`,兜底 `status==='running'`)判定;命中给 section 打 `data-zqp-running=1`,spinner 挂到项目名称容器末尾(图标盒的后兄弟 span;水平间距沿用原生 `gap-2`,基线容器内 `align-self:center` 垂直居中),原图标不动。**与任务行「正在工作」标记同款**:lucide `loader`(8 段,`stroke-width 1.5`)+ Tailwind `animate-spin`。折叠的项目也能判(不依赖任务行 DOM)
6. **列表改 flex 前过 `canFlex`**:只允许容器内「全是项目行 + 不影响布局的占位」——dnd-kit 的无障碍活区(`display:none` 或 rect ≤ 1px)忽略,出现其它可见兄弟节点就放弃排序,免得打乱布局
7. **跟随重渲染**:标题操作区、筛选行、行内按钮与图标位都是 React 管理的节点,注入必须幂等;body 上 `MutationObserver`(childList + subtree,rAF 去抖)+ 1.5s 周期扫描补回,`stop()` 只清本脚本自己的 `data-zqp-*`
8. **后台任务标记(2026-11-05)**:任务行 `li[data-task-item-key]` 沿 fiber 取 `props.task.__zcodeSessionActivity`,`hasBackgroundWork===true` 且 phase 非 running/prewarming(会话空闲但后台 Bash/agent 未结束)时行打 `data-zqp-bg=1`,行首状态格(原生指示器位,空闲时空)补**静态**终端图标(lucide `terminal`,size-3.5 不旋转——与前台运行的旋转 loader 图形/尺寸双区分),hover 提示「后台任务运行中」。前台运行中不叠加(原生 spinner 已表达),error 圆点可并存,置顶是原生活跃排序自带;分组视图 div 行无独立状态格暂不标记;activity 变化不必然伴随 DOM 变化,1.5s 轮询是主刷新通道,observer 只管行重建补图标
9. **任务时间改写(2026-11-12)**:任务行右侧相对时间原生只按 `task.updatedAt` 计算,该字段运行期冻结在 ingest 时刻(CDP 实证:流式中的会话恒停在 turn 开始前不推进),显示持续漂旧。脚本按**实际活跃时刻** `max(updatedAt, activity.lastActivityAt)` 改写(后者随每个 step 的发送/响应/响应结束实时推送,流式中 0~3s 级新鲜),文案复刻原生 `taskList.justNow/minutesAgo/hoursAgo/daysAgo` 分桶(<1min/分/时/天),五语言(zh/en/ja/ru/ko)随 `html lang` 切换;只写 `[data-task-row-metadata]` 末子节点文本(裸文本或纯文本包裹 span;末位是复合节点则不动,防误伤)
10. **任务排序与悬停冻结(2026-11-12)**:项目展开区任务列表按同一实际时刻 **新→旧** 视觉排序(容器 `data-zqp-tasklist` flex + 任务包装层 `style.order`,不动 DOM 结构与原生数据);容器 guard = 子节点全为任务包装层或尾部 BUTTON(显示更多等),否则整组放弃排序;指针悬停列表期间冻结 order(React 怎么重排 DOM 视觉序都不变,冻结期新建任务追加尾部),移出后 mouseout 即时重排(不等 1.5s 轮询);尾部 BUTTON 恒排最后。首屏每项目只渲染前 5 个任务(原生截断),排序只在已渲染行内生效。任务行 fiber 取 `props.task` 上溯放宽到 28 跳(3.18.x 行外包 HoverCard/Popper 层把 task 推深到 ~17-19 跳,16 跳取不到 = 后台标记在该版失效的根因)

DOM 锚点(排障/改版用):`data-zqp-actions`(标题操作区)、`data-zqp-action`(name/updated/filter/clear-filter/top)、`data-zqp-state`(排序按钮 off/1/-1)、`data-zqp-active`(激活态)、`data-zqp-filtermode`(标题行 wide/narrow 形态)、`data-zqp-title`(标题按钮)、`data-zqp-filter-box` / `data-zqp-filled`(宽形态常驻框/有内容)、`data-zqp-filter-row` / `data-zqp-open`(窄形态展开行/打开)、`data-zqp-filter-input`(输入框,两形态共用)、`data-zqp-empty`(无匹配提示)、`data-zqp-list`(项目排序视图容器)、`data-zqp-hidden`(被筛掉的项目行)、`data-zqp-running` / `data-zqp-spinner`(运行中图标)、`data-zqp-bg` / `data-zqp-bgmark`(后台任务标记)、`data-zqp-tasklist`(任务排序容器);样式表 id `zcode-project-tools-style`;持久化键 `zcode:project-tools:sort`(排序视图)、`zcode:project-tools:tasktime`(任务时间/排序冻结开关)。

## 验证清单(换装重启后)

1. DevTools 控制台(Ctrl+Shift+I)`window.__zcodeProjectTools` 存在,且有 `stop` / `apply` / `start` 三个键(注入成功);侧栏处于「按项目」视图
2. 分区标题 hover 出现排序按钮(名称排序 / 时间排序);侧栏足够宽时另有常驻筛选输入框(无边框深色背景,占满标题行富余宽度),不足宽时出现「筛选」按钮;按钮样式与原生按钮一致、间距 2px
3. 名称按钮点三次:正序(A→Z 图标)→ 倒序(Z→A 图标)→ 取消(中性图标,项目回到手动顺序);时间按钮两次:新→旧(时钟下箭头图标)↔ 取消
4. 筛选:宽形态输入框在标题与排序按钮之间、输入即筛,有内容时框内右侧出现 ×(点击只清空、框不收起);窄形态点「筛选」按钮展开输入行并自动 focus,× 清除并收起;无匹配显示「无匹配项目」
5. 项目行「…」菜单左侧出现「移到最上方」;点击后 `zcode-project-sidebar-preferences.order` 里该项目在同组首位,DOM 首行同步;排序视图下点击会回到手动顺序
6. 项目下有任务运行时,项目名称右侧出现 spinner(8 段线 + 旋转动画),与任务行「正在工作」图标逐字节同款(CDP 比 `svg` 与 `getComputedStyle(...).animation`;另确认名称→spinner 水平间距 = 原生 gap-2 8px、spinner 垂直居中)
7. 会话空闲但后台任务在跑的任务行:行首状态格出现静态终端图标(不旋转),hover 提示「后台任务运行中」;`window.__zcodeProjectTools.apply()` 后目标 `li` 带 `data-zqp-bg="1"`;前台运行中行不叠加
8. 等待 ≥5s / 触发重渲染后按钮与 spinner 不丢(observer + 1.5s 扫描生效)
9. 任务行时间:流式中的会话任务行应恒显「刚刚」(原生口径会漂到「1分」起,这是本功能生效的直观判据);`window.__zcodeProjectTools.apply()` 后检查目标行 `[data-task-row-metadata]` 末子节点文本
10. 任务排序与冻结:项目展开区任务按实际活跃时刻新→旧排列(容器 `[data-zqp-tasklist]`,包装层有 `style.order`);鼠标悬停列表期间行位置不动,移出后立即恢复排序;关闭开关 `zcode:project-tools:tasktime=0` 后下一拍容器属性与 order 清空、时间回原生 updatedAt 口径

上游仓库已在 3.17.2 实机经 CDP 验证:排序三态/两态与图标、筛选聚焦与清除收起、移顶后 prefs order 与 DOM 首行、运行中 spinner 的 svg/animation 与任务行一致、重渲染 5s 后不丢。名称右侧挂载(2026-11-04 改)同页复验:spinner 落名称容器末尾、名称→spinner 间距 = 原生 gap-2 8px、垂直居中偏差 0、animate-spin 计算值 `spin 1s`(注入后 0.3s/1.9s 两次复测);视觉呈现用户验收中。注意:页面 reload 后应用 `<link>` 样式表加载完成前,computed `animationName` 会短暂全页为 `none`(内联注入样式不受影响)——CDP 断言动画须避开该窗口。后台任务标记(2026-11-05)上游已随包部署、锚点逐条 grep 实证,图标呈现待实机按清单复验。

## 排障与开关

- 按钮全无:先确认换装发生(`<resources>/zcode-inject.log`)、`index.html` 有 `zcode-project-tools:begin` 标记块、`window.__zcodeProjectTools` 存在;存在但按钮不出现 = 当前不在「按项目」视图,或标题操作区选择器漂移(抽查上表)
- 排序不生效:控制台跑 `window.__zcodeProjectTools.apply()`,检查三角容器是否命中 `canFlex` 条件(出现可见兄弟节点会主动放弃排序)、`[data-zqp-list]` 是否存在
- 移到最上方无效:确认 `localStorage['zcode-project-sidebar-preferences']` 里 `order` 已更新、且应用监听了 `storage` 事件(应用自身拖拽同一路径);组内只有一个项目时脚本直接返回
- spinner 不出现/不消失:检查 `data-zqp-running` 是否随任务状态变化;运行态来自 fiber 的 `__zcodeSessionActivity`,字段漂移按上表抽查
- 后台标记不出现:先确认该行会话**空闲**(前台运行中原生 spinner 已表达,本标记只在空闲时显示;行被原生活跃排序置顶即 `hasBackgroundWork` 在场的旁证);控制台 `window.__zcodeProjectTools.apply()` 后查目标行 `data-zqp-bg` 与行首 `[data-zqp-bgmark]`;分组视图 div 行不标记属预期
- 任务时间不刷新/顺序不动:控制台跑 `window.__zcodeProjectTools.apply()`;仍异常按锚点卡抽查 `data-task-row-metadata`(时间节点)、`lastActivityAt`(活跃时刻字段)、`task-list` testid(包装层定位,走 `task-new-button` 常量块旁证);流式中行应恒显「刚刚」
- 筛选形态不对:宽形态应有 `[data-zqp-filter-box]`、无 `[data-zqp-action="filter"]` 按钮;窄形态反之。形态由标题行富余宽度判定,拖宽/拖窄侧栏应即时切换;切换边界附近有 ~26px 滞后属预期(窄形态按钮占宽)
- 关闭:`localStorage.setItem('zcode:project-tools:enabled','0')` 后刷新(默认开启);当前页立即撤销用 `window.__zcodeProjectTools.stop()`;任务时间/排序单独关:`localStorage.setItem('zcode:project-tools:tasktime','0')`

## 已知局限

- 依赖 React 内部 fiber 键(`__reactFiber$`)与 `memoizedProps.project/tasks` 形态、项目侧 testid/属性命名——客户端升级可能静默失效;升级后按锚点卡抽查即为此设
- 排序只在 `canFlex` 通过的列表容器生效;未来若列表容器新增可见兄弟节点(如「显示更多」),排序会主动放弃
- 「移到最上方」只作用于同组(同父容器)且不改变 pinned;置顶仍走应用原生 pinned
- 未验证边角:pinned 项目运行中时,项目行 hover 可能同时出现原生 pin 图标与本脚本 spinner
- 后台任务标记只覆盖列表视图 li 行;分组视图 div 行无独立状态格,不标记
- 任务排序只在已渲染行内生效(首屏每项目只渲染前 5 个任务,原生「显示更多」之后才包含其余);`updatedAt` 与 `lastActivityAt` 都不是「任务最后完成时间」,勿再引入第三口径
- 筛选双形态切换带 ~26px 滞后(窄形态「筛选」按钮占据的宽度计入按钮组),边界附近来回拖侧栏时不会抖动,但也不是逐像素精确
