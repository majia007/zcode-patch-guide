# block-esc 事实卡

功能:条件式拦截 ESC 键,堵 ZCode 无配置入口的两处高破坏性行为——**生成中按 ESC 中止会话**(composer 的 form onKeyDown)与**问答/计划审批面板打开时按 ESC 关闭/退回上一题**(面板容器 onKeyDown)。其余场景(弹窗/菜单/侧栏归档确认态)原样放行,保留原生行为。

脚本:`inject/block-esc.js`(单 IIFE 单监听,35 行,头注释即全量文档)。

## 注入依赖锚点卡

部署前对新解包产物 grep(均在 `renderer/assets/styles-*.js`;用 `grep -Fc '<字面串>' <文件>` 的固定字符串形式,防锚点内特殊字符被正则解析):

| 字面串 | 用途 |
|--------|------|
| `data-zcode-chat-loading-slot` | 生成中谓词:运行轮加载槽(api-retry 分支也在槽内) |
| `data-elicitation-dialog-card` | 面板开谓词:问答/审批面板卡(仅 pending 交互挂载,已答历史零残留) |

(`data-zcode-chat-loading-animate` 与 tok-badge 速度位同锚,作生成中谓词的补充;`role="dialog"` 是**放行守卫**不是拦截谓词,不在抽查表。)

## 机制最小结论

1. **谓词只认 DOM 存在性**,不依赖帧协议——依赖面极小,升级漂移面小(这就是它只有 2+1 条锚点的原因)
2. **注入时序是全部依靠**:脚本先于应用代码执行,window 捕获监听天然排在应用全部 keydown 处理(React 委托/Radix/容器级 onKeyDown)之前;命中即 `preventDefault + stopPropagation + stopImmediatePropagation` 三连,其余监听一律收不到
3. **只拦 keydown**,keyup 保持原生(两条目标链路都由 keydown 驱动)
4. **放行保护**:target 在 `[role="dialog"]` 内不拦——与应用自身的 ESC 守卫同款,生成中开弹窗仍可 ESC 关弹窗

## 验证清单(换装重启后)

1. DevTools 控制台应有 `[block-esc] armed`(注入即打,不依赖对话)
2. 生成中按 ESC:会话**不**中止(原生行为会中止)
3. 问答/审批面板打开时按 ESC:面板**不**关闭
4. 任意弹窗(如设置)打开时按 ESC:弹窗正常关闭(放行保护生效)

## 排障与开关

- ESC 行为异常先关它:`localStorage.setItem('zcode:block-esc:enabled','0')` 后刷新(默认开启)
- armed 不打印 = 脚本没注入(查换装日志);armed 在但不拦 = 谓词锚点漂移(抽查上表两条)
