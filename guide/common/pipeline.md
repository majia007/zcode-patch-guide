# 部署流水线

总流程:**环境探测 → 解包 → 锚点抽查 → 注入打包 → 换装 → 验证**。机械部分 5~10 分钟(不含等待用户退出 ZCode)。全部命令在**仓库根**执行。

前置:先按 [environment.md](environment.md) 定位 `<resources>` 目录(下文以此代称)、核对版本。

## 1. 解包

```bash
# 重解包前先清旧的(升级后 bundle 全换,旧产物不可复用)
rm -rf unpack
npx --yes @electron/asar extract "<resources>/app.asar" unpack/app_extract
```

约 300MB、1~2 分钟。产物在 `unpack/app_extract/out/`(目录结构速览见 [method.md](method.md))。

幂等事实:若解包源是**已注入过的** app.asar,解出的 index.html 自带旧注入标记块(`<!-- zcode-xxx:begin/end -->`)——pack.mjs 会自动剥离重插,无害,不用手动清理。

## 2. 锚点抽查(注入依赖体检)

对解包产物 grep 所选功能的**锚点卡**全表(只装部分功能时只查所选;五张卡:[../tok-badge/facts.md](../tok-badge/facts.md)、[../block-esc/facts.md](../block-esc/facts.md)、[../quota-balance/facts.md](../quota-balance/facts.md)、[../request-marker/facts.md](../request-marker/facts.md)、[../project-tools/facts.md](../project-tools/facts.md)):

```bash
grep -c 'data-zcode-chat-loading-animate' unpack/app_extract/out/renderer/assets/styles-*.js
```

- 命中数 > 0 = 绿;按表逐条跑
- 某条 0 命中(MISS)→ 按 [method.md](method.md) 的 MISS 甄别流程处理,**甄别通过才继续**;真漂移(whole-bundle 0 命中且非噪音)不要硬部署
- 也可以不抽查直接打包——注入会成功但功能可能静默失效;抽查是为了在换装前发现问题

## 3. 注入 + 打包

```bash
node inject/pack.mjs                                  # 全量(五个功能都注入)
node inject/pack.mjs --scripts tok-badge,block-esc    # 只重注入所选(未选模块既有块保留)
```

模块名:`tok-badge` / `block-esc` / `quota-balance` / `request-marker` / `project-tools`(逗号分隔;`--scripts a,b` 与 `--scripts=a,b` 均可;重复声明/空清单/未知模块会显式报错退出,不会静默退化成全量或空选集)。用户只装部分功能时,按所选列表传 `--scripts`;注入块按模块表顺序落位,同一集合不同书写顺序产物一致。

主进程额度补丁归属 `quota-balance`:本轮选集含它才挂载/更新(`zcode-quota` 标记块 + `zcode-quota-main.cjs`);未选时保留既有挂载不动——首次只装其它功能不会顺带装一个用不到的轮询器。

做的事:把 `inject/` 脚本(全量或选集)注入 `unpack/app_extract/out/renderer/index.html` 的 head 闭合标签前(每脚本独立标记块包裹,幂等可重跑);另把 `quota-main.cjs` 拷到 `<resources>/zcode-quota-main.cjs`(不进 asar),并在 `unpack/app_extract/out/main/index.js` 尾部追加幂等标记块 `import("file://…/zcode-quota-main.cjs")`(主进程额度轮询器)→ 三重校验(round-trip 逐字节比对、标签计数、node --check)→ asar 打包到 `<resources>/app.asar.new`(约 1 分钟)。**不碰运行中的 app.asar**;任一校验失败立即中止、退出码非 0。

产物 SHA 复现规则(实测):
- 同一 `unpack/` 状态连跑,产物**逐字节一致**(可作部署自检:重跑一次比 SHA)
- 重新解包后 SHA 必变(asar 解包→重打包往返不保证字节稳定)——**SHA 只用于同轮连跑核对,不跨解包比对**

### 移除某个功能

`--scripts` 只负责注入/更新,不卸载——未选模块的既有标记块原样保留。要真正移除:

1. 用**未注入过的原始 app.asar** 重新解包(首次换装留在 `<resources>/app.asar.old` 的就是原始包),再按所需功能选集注入;或
2. 从当前 `unpack/app_extract/out/renderer/index.html` 手动删除该模块的 `<!-- zcode-<name>:begin -->` 到 `<!-- zcode-<name>:end -->` 整块(只删标记块,不碰其余内容),再跑 `--scripts <要保留的模块>` 重新打包;
3. 移除 `quota-balance` 时还要删 `out/main/index.js` 尾部的 `/* zcode-quota:begin */…/* zcode-quota:end */` 块(`<resources>/zcode-quota-main.cjs` 可留可删,无 import 不加载)。

注意:直接重解包**当前已注入**的 app.asar 会带回旧标记块——pack.mjs 只剥离本轮选中模块的旧块,其余块仍在,所以"重解包 + 选集"不能当卸载用。

## 4. 换装

```bash
node inject/pack.mjs --deploy
```

= 上一步全部 + 把换装监视器(`apply-update.mjs`)与防降级指纹(`app.asar.new.sha256`)拷入 resources 目录并后台启动(`zcode-quota-main.cjs` 已在打包时同步到同目录)。此后:

1. **由用户完全退出 ZCode**。win:右键**托盘图标**退出——点窗口 × 只是隐藏到托盘,进程不死、不触发换装
2. 监视器自动完成:等退出(1s 轮询)→ 复验 app.asar 仍是打包时指纹(等待期被官方升级覆盖则中止换装、新包改名 `.stale` 防降级)→ 换装(app.asar 改名保留为 `app.asar.old`)→ 按换装前抓取的启动参数自动重启 ZCode
3. 日志:`<resources>/zcode-inject.log`(含 captured/OK swapped/relaunched 各行)

⚠️ **agent 红线:不要替用户退出 ZCode**——agent 会话很可能就跑在 ZCode 进程里,杀它等于杀掉自己的会话。跑到这一步就停下,把「请完全退出 ZCode(托盘右键退出)」交给用户,换装+重启+回来自动发生。

### 监视器没存活(退出后没换装)

症状:完全退出 ZCode 后 `<resources>/zcode-inject.log` 停在 `captured:`,没有 `OK swapped`;`app.asar.new` 仍在、`app.asar` 时间戳未变。

原因:从 ZCode 内嵌 bash 工具(或其它会回收子进程 job 的宿主)跑 `--deploy` 时,detached 的换装监视器可能随命令 job 一起被回收。

处理(Windows):

1. 确认没有存活的监视器:`Get-CimInstance Win32_Process | Where-Object CommandLine -match 'apply-update'`
2. 重启:`pwsh -NoProfile -File tools/restart-watcher.ps1`(自定义安装位置用 `-Resources <resources>` 或环境变量 `ZCODE_RES`)
3. 预期输出:列出新 node 进程、`visible windows matching node/apply-update: 0`;日志新增 `start (wait)` 与 `captured:`,再让用户退出客户端

原理:计划任务的进程脱离调用方 job;任务动作是 `wscript.exe tools/hidden-run.vbs <node> <apply-update.mjs> wait`——wscript 是 GUI 宿主(无控制台),VBS 的 `Run(...,0)` 隐藏启动 node。计划任务直排 `node.exe` 或 WMI 直起都会弹终端窗口;WMI + `powershell -WindowStyle Hidden` 静默失败、WMI + wscript 实测不起 node。本脚本仅 Windows 可用;mac 请从独立终端启动监视器。

ZCode 本来就没在运行时,监视器会立刻换装并跳过重启(`no relaunch` 日志)。

## 5. 验证

见各功能 facts.md 的验证清单(tok-badge 需发一轮对话;block-esc 重启后控制台即见 armed;quota-balance 需本机 magpie 且选用第三方模型,打开上下文用量浮层看 `.zcode-quota-section`;request-marker 打开含工具调用的会话看组折叠头 `#min → #max` 区间标签、展开组内段首 `#N` 标签;project-tools 看侧栏「项目」分区标题 hover 的三个按钮、项目行「移到最上方」、运行中项目的 spinner 与空闲任务行的后台终端图标)。

## 6. 回滚

```bash
# 把 <resources>/app.asar.old 换回 app.asar,重启 ZCode
rm "<resources>/app.asar"        # 或先改名留档
mv "<resources>/app.asar.old" "<resources>/app.asar"
```

mac 重签见 environment.md。注入本身只动 index.html 与 main 入口尾部的标记块,回滚 = 恢复打包前的 asar 即可(`<resources>/zcode-quota-main.cjs` 可留:首次部署的 `.old` 是原始包、不含 import 标记块不会加载;`.old` 若是注入过的旧版本,额度段照常工作,同样无害)。

## 维护者注意:四个已修坑(改工具链时勿回退)

1. **剥块正则吞 END 后一个换行**(pack.mjs):否则每重跑一轮残留一个 `\n`,产物跨轮漂移、连跑不再幂等
2. **capture 排除 app-server 进程**(apply-update.mjs 的 captureMainCmdline):命令行含 `zcode.cjs`、无 `--type=` 的进程是 app-server,不排除的话换装后自动重启会拉起无 GUI 的 stdio 进程
3. **一切 spawn 加 `windowsHide: true`**(apply-update.mjs 的 run):无控制台的后台进程 spawn 控制台程序(tasklist/powershell)不加它,Windows Terminal 为默认终端时**每秒弹一个终端窗口**(实测踩坑)
4. **主进程入口注入「先剥旧标记块再追加」**(pack.mjs 的 QUOTA_BLOCK_RE):幂等与换 `ZCODE_RES` 后 file URL 更新都靠这条;直接 append 会叠出多份 import
5. **换装监视器要脱离调用方 job**(部署方式):`--deploy` 的 detached watcher 在 ZCode 内嵌 bash 工具里可能随命令 job 被回收——部署后用 `Get-CimInstance Win32_Process` 核对存活,已死用 `tools/restart-watcher.ps1` 经计划任务 + wscript 重启;不要用 WMI 直起 node(弹窗/不起)

## agent 红线汇总

- 对 ZCode 的修改只经 `inject/` 工具链落地;解包产物里 pack.mjs 只改 index.html 的注入标记块与 main 入口尾部的 `zcode-quota` 标记块
- 注入 JS 的注释与字符串不得含 script 开闭标签、head 闭合标签、HTML 注释开符号(pack.mjs 注入前断言,防 HTML 解析器把内容当真标签毁掉整页)
- 不替用户退出 ZCode;换装交给监视器,不手动 rename 正在运行的包
- 版本变了必须重解包,不能拿旧 unpack 打包(降级)
- 结论性判断(锚点是否漂移、功能是否正常)要有 grep/运行输出佐证,拿不准如实说未验证
