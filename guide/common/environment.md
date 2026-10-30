# 环境探测

部署前确认三件事:**ZCode 装在哪、什么版本、node 工具链可用**。全部只读操作,不改安装目录。

## ZCode 的形态(Electron 应用)

```
<安装目录>/
├── ZCode.exe                     # 主程序(win;mac 为 ZCode.app)
└── resources/
    ├── app.asar                  # 主资源包:全部 UI/主进程/host 代码,约 300MB
    ├── app.asar.unpacked/        # 原生模块伴生目录(node-pty/ssh2/sharp 的 .node/.dll)
    └── glm/zcode.cjs             # 内置 agent 运行时(无需关心,锚点旁路会用到)
```

⚠️ **app.asar 与 app.asar.unpacked 必须成对**。asar 内对 unpacked 文件只存元数据,实体文件在伴生目录——只复制 asar 主文件去做 `asar extract` 会直接 ENOENT 报错(实测:node-pty/sharp 的 dll 全部读不到)。解包、备份、换装都不要拆散这对。

官方自动更新 = 整体替换 app.asar(+unpacked),注入随之丢失——这就是每次升级后要重跑部署流水线的原因。

## 找安装目录

按序探测(pack.mjs 内置同一候选表):

| 平台 | 候选路径 |
|------|---------|
| win | `%LOCALAPPDATA%\Programs\ZCode\resources` |
| win | `C:\Program Files\ZCode\resources` |
| win | `C:\Program Files (x86)\ZCode\resources` |
| mac | `/Applications/ZCode.app/Contents/Resources` |

判定标准:目录下存在 `app.asar`。候选全落空 → 按序降级:

```bash
# 1. ZCode 正在运行:从进程拿可执行文件路径(最可靠;agent 部署时 ZCode 通常开着)
pwsh -NoProfile -Command '(Get-Process ZCode -ErrorAction SilentlyContinue | Select-Object -First 1).Path'
# mac(推断未实测): ps ax -o command= | grep ZCode.app
# 2. 开始菜单快捷方式:右键快捷方式看属性里的"目标"位置
# 3. 直接询问用户
```

**找到的路径若不在候选表,后续所有命令用 `ZCODE_RES` 环境变量传入**(pack.mjs 探测不到会报错并列出已试路径):

```bash
ZCODE_RES="<安装目录>/resources" node inject/pack.mjs --deploy
```

## 版本核对

```bash
# win
pwsh -NoProfile -Command '(Get-Item "<安装目录>/ZCode.exe").VersionInfo.FileVersion'
# mac(未实测,推断):读 Info.plist 的 CFBundleShortVersionString
```

为什么要核对:**版本号变了 = bundle 文件全体更换**(所有 bundle 文件名带内容哈希,每次升级全换名)。此时必须清掉 `unpack/` 重新解包并重跑锚点抽查,绝不能拿旧解包产物直接打包——那会把旧版代码打进去,等于降级客户端(换装监视器的防降级指纹也会拦下这种包)。版本没变、只是改了注入脚本重部署,则无需重解包。

## 工具链要求

- node ≥ 18(开发实测 24.x);`npx` 首次运行会联网拉取 `@electron/asar`
- 磁盘:解包产物 ~700MB + 打包产物 ~350MB,峰值 ~1.5GB,放在仓库 `unpack/`(已 gitignore)

## macOS 注意(experimental,未实测)

修改已签名 app 的 asar 会使 code signature 失效,Gatekeeper 可能直接 kill 进程。通行解法是 ad-hoc 重签:

```bash
codesign --force --deep --sign - /Applications/ZCode.app
```

本仓库 mac 路径的进程探测(pgrep/ps 分支)已写进工具链但**完全未实测**;mac 出任何问题先按 pipeline.md 回滚。
