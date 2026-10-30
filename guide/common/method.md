# 锚点定位法(渔)

为什么需要这套方法:ZCode 的 bundle 全部是 **minified 单行文件**,且文件名带内容哈希、每次版本升级全体换名。定位任何代码都不能靠文件名/行号,只能靠「特征串锚点」。本文是给鱼(锚点卡)之外的渔:锚点怎么选、漂移了怎么办。

## minified 阅读法

- `grep -n` 行号无意义(整文件一行)。用 `grep -bo '特征串' <file>` 拿**字节偏移**,再切片读上下文:

```python
i = <字节偏移>
print(open(f, encoding='utf-8', errors='replace').read()[i-300:i+500])
```

- 字节偏移只用于当次导航,**不写入文档**——跨版本必漂移
- 大 bundle(UI 主件 styles-*.js 约 5~6MB)读切片足够;不要整读

## 锚点规范

一条锚点 = **文件通配名 + 可 grep 字面串**,例:`renderer/assets/styles-*.js` + `data-zcode-chat-loading-animate`。

选串优先级(稳定性从高到低):
1. i18n 文案(`IntlProvider-*.js` 里反查得到组件用词)
2. `data-testid` / `data-*` 属性值
3. 协议层字面量:zod schema 字段名、RPC channel/method 名、帧 kind 枚举值
4. 语义强的常量名 / CSS 自定义属性名(如主题变量 `--color-foreground-subtlest`)
5. 稳定 class 名

**禁止作锚点**:带哈希的 bundle 文件名、字节偏移、minified 内部变量名(压缩名跨版本必变)。

## 稳定性判据(3.14~3.17 五轮升级实测)

- **实测很稳**:i18n 文案、data-testid、协议 schema 字段、RPC channel/method 名(`zcode-session`/`zcode-agent`/`readSession` 全程未变)
- **必变**:压缩内部变量名
- **易死**:日志前缀串(比它修饰的枚举值死得快——先例:`tab type:` 前缀消失,19 种枚举裸值全稳;锚点按裸值改写即可)、CSS 原子类
- **特例——渲染侧字面量退出 ≠ 协议漂移**:bundle 渲染代码不再含某字段字面量(如 `generationDurationMs` 3.14.4 起退出 styles 渲染侧),但协议 schema(`src-*.js`/host chunk)还在 = 线上协议没变,功能不受影响。判定要看 schema 侧,不要只看渲染侧

## MISS 甄别流程(锚点 0 命中时)

1. **旁路**:扩大扫描到全目录(不只锚点卡的通配名目标)+ `<resources>/glm/zcode.cjs`——schema/产出侧命中即「线上协议在」,降级为旁路命中,不算漂移
2. **换形**:锚点串本身变了?
   - 前缀串死了 → 换裸值(见上)
   - testid 族改名/拆分(先例:`v4-workspace-hook-pending-banner` 拆成五件套+镜像族)→ 找到族内新名,按新形态改写锚点
   - 文件换名(先例:`imeComposition-*.js` 消失,内容并入 `pptxElementReference-*.js`)→ 新旧文件清单 diff 找后继,锚点指向新通配名
3. **真漂移**:whole-bundle 0 命中且非以上噪音 → 该功能的依赖面真的断了。重定位(下一节)或如实报告该功能在本版本不可用,不要硬部署

## 漂移重定位

从语义近邻入手,不要盲搜:
- i18n 文案反查:`IntlProvider-*.js` 里 grep 相关文案 → 拿到文案 key/组件线索 → 回主 bundle 定位
- testid 族内其他成员:同前缀的其他 testid 还在,说明组件在、属性改名
- 同一帧/RPC 的其他字段:帧的其他字段锚点还绿,说明帧还在、只是某字段重命名
- **新旧 bundle 文件清单 diff**:哈希变化无意义,看**新增/消失的文件**(新模块/裁撤信号)
- 找到后继 → 改写锚点卡 → 重跑抽查全表确认

## 解包产物结构速览

`unpack/app_extract/out/` 下:

| 路径 | 角色 |
|------|------|
| `renderer/index.html` | 唯一页面入口(**注入点**:脚本插在 head 闭合标签前) |
| `renderer/assets/styles-*.js` | UI 主 bundle——名字叫 styles 实为最大件(全部组件+store+渲染侧 schema,5~6MB) |
| `renderer/assets/src-*.js` | 共享协议层(RPC client、zod schema、过程名表) |
| `renderer/assets/IntlProvider-*.js` | i18n 文案(文案反查组件的捷径) |
| `main/index.js` + `main/chunk-*.js` | Electron 主进程(窗口、IPC、updater) |
| `preload/index.cjs` | bridge(contextBridge 暴露 + MessagePort 转发) |
| `host/index.js` + `host/chunk-*.js` | host 进程(renderer 消费的全部服务在此实现) |
| `scheduler/index.js` | 后台调度进程(不在对话链路上) |

进程链:ZCode.exe(Electron main)→ 渲染进程(index.html)↔ preload bridge ↔ host 进程(utilityProcess,44 个 channel 服务)。tok-badge 旁路监听的就是 renderer↔host 的 MessagePort 帧。
