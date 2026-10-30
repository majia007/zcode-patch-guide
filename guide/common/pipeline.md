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

对解包产物 grep 各功能的**锚点卡**全表([../tok-badge/facts.md](../tok-badge/facts.md)、[../block-esc/facts.md](../block-esc/facts.md)):

```bash
grep -c 'data-zcode-chat-loading-animate' unpack/app_extract/out/renderer/assets/styles-*.js
```

- 命中数 > 0 = 绿;按表逐条跑
- 某条 0 命中(MISS)→ 按 [method.md](method.md) 的 MISS 甄别流程处理,**甄别通过才继续**;真漂移(whole-bundle 0 命中且非噪音)不要硬部署
- 也可以不抽查直接打包——注入会成功但功能可能静默失效;抽查是为了在换装前发现问题

## 3. 注入 + 打包

```bash
node inject/pack.mjs
```

做的事:把 `inject/` 两个脚本注入 `unpack/app_extract/out/renderer/index.html` 的 head 闭合标签前(每脚本独立标记块包裹,幂等可重跑)→ 三重校验(round-trip 逐字节比对、标签计数、node --check)→ asar 打包到 `<resources>/app.asar.new`(约 1 分钟)。**不碰运行中的 app.asar**;任一校验失败立即中止、退出码非 0。

产物 SHA 复现规则(实测):
- 同一 `unpack/` 状态连跑,产物**逐字节一致**(可作部署自检:重跑一次比 SHA)
- 重新解包后 SHA 必变(asar 解包→重打包往返不保证字节稳定)——**SHA 只用于同轮连跑核对,不跨解包比对**

## 4. 换装

```bash
node inject/pack.mjs --deploy
```

= 上一步全部 + 把换装监视器(`apply-update.mjs`)与防降级指纹(`app.asar.new.sha256`)拷入 resources 目录并后台启动。此后:

1. **由用户完全退出 ZCode**。win:右键**托盘图标**退出——点窗口 × 只是隐藏到托盘,进程不死、不触发换装
2. 监视器自动完成:等退出(1s 轮询)→ 复验 app.asar 仍是打包时指纹(等待期被官方升级覆盖则中止换装、新包改名 `.stale` 防降级)→ 换装(app.asar 改名保留为 `app.asar.old`)→ 按换装前抓取的启动参数自动重启 ZCode
3. 日志:`<resources>/zcode-inject.log`(含 captured/OK swapped/relaunched 各行)

⚠️ **agent 红线:不要替用户退出 ZCode**——agent 会话很可能就跑在 ZCode 进程里,杀它等于杀掉自己的会话。跑到这一步就停下,把「请完全退出 ZCode(托盘右键退出)」交给用户,换装+重启+回来自动发生。

ZCode 本来就没在运行时,监视器会立刻换装并跳过重启(`no relaunch` 日志)。

## 5. 验证

见各功能 facts.md 的验证清单(tok-badge 需发一轮对话;block-esc 重启后控制台即见 armed)。

## 6. 回滚

```bash
# 把 <resources>/app.asar.old 换回 app.asar,重启 ZCode
rm "<resources>/app.asar"        # 或先改名留档
mv "<resources>/app.asar.old" "<resources>/app.asar"
```

mac 重签见 environment.md。注入本身只动 index.html 一个文件,回滚 = 恢复打包前的 asar 即可。

## 维护者注意:三个已修坑(改工具链时勿回退)

1. **剥块正则吞 END 后一个换行**(pack.mjs):否则每重跑一轮残留一个 `\n`,产物跨轮漂移、连跑不再幂等
2. **capture 排除 app-server 进程**(apply-update.mjs 的 captureMainCmdline):命令行含 `zcode.cjs`、无 `--type=` 的进程是 app-server,不排除的话换装后自动重启会拉起无 GUI 的 stdio 进程
3. **一切 spawn 加 `windowsHide: true`**(apply-update.mjs 的 run):无控制台的后台进程 spawn 控制台程序(tasklist/powershell)不加它,Windows Terminal 为默认终端时**每秒弹一个终端窗口**(实测踩坑)

## agent 红线汇总

- 对 ZCode 的修改只经 `inject/` 工具链落地;解包产物里只有 pack.mjs 允许改(标记块之间的内容)
- 注入 JS 的注释与字符串不得含 script 开闭标签、head 闭合标签、HTML 注释开符号(pack.mjs 注入前断言,防 HTML 解析器把内容当真标签毁掉整页)
- 不替用户退出 ZCode;换装交给监视器,不手动 rename 正在运行的包
- 版本变了必须重解包,不能拿旧 unpack 打包(降级)
- 结论性判断(锚点是否漂移、功能是否正常)要有 grep/运行输出佐证,拿不准如实说未验证
