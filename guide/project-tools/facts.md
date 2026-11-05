# project-tools 事实卡

功能:增强左侧侧栏的**「项目」分区**——分区标题 hover 操作区加「名称排序 / 最近更新时间排序 / 项目名筛选」,每个项目行的动作组加「移到最上方」,项目下有任务运行中时项目名称右侧显示与任务行同款的加载图标。

脚本:`inject/project-tools.js`(单 IIFE,头注释即设计文档)。

## 注入依赖锚点卡

部署前对新解包产物逐条 grep(方法见 [../common/method.md](../common/method.md));全绿才打包。

```bash
# 除最后一条外均在 renderer/assets/styles-*.js
for s in data-project-id data-project-name data-project-host project-section \
         virtual-project-toggle virtual-project-actions data-purpose-section-list \
         __zcodeSessionActivity zcode-project-sidebar-preferences; do
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
| styles-*.js | `zcode-project-sidebar-preferences` | 应用自身的项目顺序/视图持久化 localStorage 键(「移到最上方」写它) |
| pptxElementReference-*.js | `__reactFiber$` | React fiber 键前缀(读 `memoizedProps.project/tasks`) |

锚点在上游仓库 3.17.2 解包产物逐条命中;本仓库现存的 3.17.1 解包产物同样逐条命中(计数 9 / 4 / 2 / 1 / 2 / 1 / 1 / 2 / 2,`__reactFiber$` 1)。

## 机制最小结论

1. **排序是视觉覆盖**:给项目列表容器加 `data-zqp-list`(CSS 改 flex 列),给 `section[data-project-id]` 写行内 `style.order`——**不改写** `zcode-project-sidebar-preferences.order`(用户手动顺序),取消排序即清 `style.order` 复原
2. **两种排序**:名称三态循环 **正序 → 倒序 → 取消**(正/倒序图标不同,比较用 `localeCompare('zh-CN', { numeric: true })`);时间只有 **新→旧 ↔ 取消** 两态(不提供旧→新,激活态沿用「新→旧」图标)。更新时间取该项目下任务 `updatedAt` 最大值,无任务 = 0 排最后
3. **筛选**:按 `data-project-name` 不区分大小写包含匹配,命中保留、其余打 `data-zqp-hidden`(`display:none`);筛选行挂在分区标题下,分区收起时自动隐藏,无匹配显示「无匹配项目」。清除按钮**清空关键字并收起输入框**(生成中 ESC 会被 block-esc 吞掉,不能只靠 ESC)
4. **移到最上方**:只把该项目键 `JSON.stringify([hostId, id])` 移到 `localStorage['zcode-project-sidebar-preferences'].order` 中**同父容器(同组)首槽**,再合成 `StorageEvent('storage')` 让应用 store 立刻采用——与应用自身拖拽排序同一条持久化路径;不改 `pinned`。排序视图下点击顺带回到手动顺序
5. **运行中图标**:从项目行 `section` 的 React fiber 向上找 `memoizedProps.project/tasks`,按 `tasks[].__zcodeSessionActivity.phase`(`running`/`prewarming`,兜底 `status==='running'`)判定;命中给 section 打 `data-zqp-running=1`,spinner 挂到项目名称容器末尾(图标盒的后兄弟 span;水平间距沿用原生 `gap-2`,基线容器内 `align-self:center` 垂直居中),原图标不动。**与任务行「正在工作」标记同款**:lucide `loader`(8 段,`stroke-width 1.5`)+ Tailwind `animate-spin`。折叠的项目也能判(不依赖任务行 DOM)
6. **列表改 flex 前过 `canFlex`**:只允许容器内「全是项目行 + 不影响布局的占位」——dnd-kit 的无障碍活区(`display:none` 或 rect ≤ 1px)忽略,出现其它可见兄弟节点就放弃排序,免得打乱布局
7. **跟随重渲染**:标题操作区、筛选行、行内按钮与图标位都是 React 管理的节点,注入必须幂等;body 上 `MutationObserver`(childList + subtree,rAF 去抖)+ 1.5s 周期扫描补回,`stop()` 只清本脚本自己的 `data-zqp-*`

DOM 锚点(排障/改版用):`data-zqp-actions`(标题操作区)、`data-zqp-action`(name/updated/filter/clear-filter/top)、`data-zqp-state`(排序按钮 off/1/-1)、`data-zqp-active`(激活态)、`data-zqp-filter-row` / `data-zqp-filter-input` / `data-zqp-open` / `data-zqp-empty`(筛选行)、`data-zqp-list`(排序视图容器)、`data-zqp-hidden`(被筛掉的项目行)、`data-zqp-running` / `data-zqp-spinner`(运行中图标);样式表 id `zcode-project-tools-style`;排序视图持久化键 `zcode:project-tools:sort`。

## 验证清单(换装重启后)

1. DevTools 控制台(Ctrl+Shift+I)`window.__zcodeProjectTools` 存在,且有 `stop` / `apply` / `start` 三个键(注入成功);侧栏处于「按项目」视图
2. 分区标题 hover 出现三个按钮(名称排序 / 时间排序 / 筛选),按钮样式与原生按钮一致、间距 2px
3. 名称按钮点三次:正序(A→Z 图标)→ 倒序(Z→A 图标)→ 取消(中性图标,项目回到手动顺序);时间按钮两次:新→旧(时钟下箭头图标)↔ 取消
4. 点筛选按钮:输入框展开并自动 focus;输入关键字只留命中的项目,无匹配显示「无匹配项目」;点清除按钮**清空并收起**
5. 项目行「…」菜单左侧出现「移到最上方」;点击后 `zcode-project-sidebar-preferences.order` 里该项目在同组首位,DOM 首行同步;排序视图下点击会回到手动顺序
6. 项目下有任务运行时,项目名称右侧出现 spinner(8 段线 + 旋转动画),与任务行「正在工作」图标逐字节同款(CDP 比 `svg` 与 `getComputedStyle(...).animation`;另确认名称→spinner 水平间距 = 原生 gap-2 8px、spinner 垂直居中)
7. 等待 ≥5s / 触发重渲染后按钮与 spinner 不丢(observer + 1.5s 扫描生效)

上游仓库已在 3.17.2 实机经 CDP 验证:排序三态/两态与图标、筛选聚焦与清除收起、移顶后 prefs order 与 DOM 首行、运行中 spinner 的 svg/animation 与任务行一致、重渲染 5s 后不丢。名称右侧挂载(2026-11-04 改)同页复验:spinner 落名称容器末尾、名称→spinner 间距 = 原生 gap-2 8px、垂直居中偏差 0、animate-spin 计算值 `spin 1s`(注入后 0.3s/1.9s 两次复测);视觉呈现用户验收中。注意:页面 reload 后应用 `<link>` 样式表加载完成前,computed `animationName` 会短暂全页为 `none`(内联注入样式不受影响)——CDP 断言动画须避开该窗口。

## 排障与开关

- 按钮全无:先确认换装发生(`<resources>/zcode-inject.log`)、`index.html` 有 `zcode-project-tools:begin` 标记块、`window.__zcodeProjectTools` 存在;存在但按钮不出现 = 当前不在「按项目」视图,或标题操作区选择器漂移(抽查上表)
- 排序不生效:控制台跑 `window.__zcodeProjectTools.apply()`,检查三角容器是否命中 `canFlex` 条件(出现可见兄弟节点会主动放弃排序)、`[data-zqp-list]` 是否存在
- 移到最上方无效:确认 `localStorage['zcode-project-sidebar-preferences']` 里 `order` 已更新、且应用监听了 `storage` 事件(应用自身拖拽同一路径);组内只有一个项目时脚本直接返回
- spinner 不出现/不消失:检查 `data-zqp-running` 是否随任务状态变化;运行态来自 fiber 的 `__zcodeSessionActivity`,字段漂移按上表抽查
- 关闭:`localStorage.setItem('zcode:project-tools:enabled','0')` 后刷新(默认开启);当前页立即撤销用 `window.__zcodeProjectTools.stop()`

## 已知局限

- 依赖 React 内部 fiber 键(`__reactFiber$`)与 `memoizedProps.project/tasks` 形态、项目侧 testid/属性命名——客户端升级可能静默失效;升级后按锚点卡抽查即为此设
- 排序只在 `canFlex` 通过的列表容器生效;未来若列表容器新增可见兄弟节点(如「显示更多」),排序会主动放弃
- 「移到最上方」只作用于同组(同父容器)且不改变 pinned;置顶仍走应用原生 pinned
- 未验证边角:pinned 项目运行中时,项目行 hover 可能同时出现原生 pin 图标与本脚本 spinner
