// 缺口说明：ZCode 的 ESC 键无任何配置入口，且有两处高破坏性行为——生成中按 ESC 中止会话
// （composer 的 form onKeyDown，e.key===Escape 且停止回调可用时调用之；该处理器自身检查
// e.defaultPrevented 与 target 在 [role="dialog"] 内两个守卫，styles-*.js grep 实证），以及
// 问答/计划审批面板（elicitation）打开时按 ESC 关闭/退回上一题（面板容器
// data-elicitation-dialog-card 的 onKeyDown，advanceKind 判定 Escape→previous/dismiss）。
// 本脚本条件式拦截：仅上述两种状态在场时吞掉 ESC，其余场景（弹窗/菜单/侧栏归档确认态等）
// 原样放行，保留原生行为。条件谓词全部走 DOM 存在性，不依赖帧协议：
//   生成中 = [data-zcode-chat-loading-slot]（运行轮加载槽，api-retry 分支也在槽内）或
//            [data-zcode-chat-loading-animate]（槽内 spin 图标，tok-badge 速度位宿主同锚）
//   面板开 = [data-elicitation-dialog-card]（仅 pending 交互挂载——CDP 实测已答历史轮次零残留）
// 机制：注入时序先于应用代码，window 捕获监听天然排在应用全部 keydown 处理（React 委托到
// root 容器、Radix 挂 document、composer form/面板容器的 React onKeyDown）之前；命中条件时
// preventDefault + stopPropagation + stopImmediatePropagation 三连，其余监听一律收不到。
// 放行保护：target 在 [role="dialog"] 内不拦——与应用自身的中止守卫同款，设置弹窗等 ESC 关闭
// 不受影响（生成中开弹窗的场景仍可正常 ESC 关弹窗）。
// 只拦 keydown：两条目标链路（中止/面板关闭）都由 keydown 驱动，keyup 保持原生。
// 开关：DevTools 控制台 localStorage.setItem('zcode:block-esc:enabled','0') 后刷新即关闭
// （默认开启），排查 ESC 行为异常时先关它。
(() => {
  if (localStorage.getItem('zcode:block-esc:enabled') === '0') {
    console.log('[block-esc] disabled by localStorage');
    return;
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const t = e.target;
    if (t instanceof Element && t.closest('[role="dialog"]')) return;
    if (!document.querySelector(
      '[data-zcode-chat-loading-slot],[data-zcode-chat-loading-animate],[data-elicitation-dialog-card]')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);
  console.log('[block-esc] armed');
})();
