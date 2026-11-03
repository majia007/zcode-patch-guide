#!/usr/bin/env node
// 注入打包器(node 版,pack.py 的等价移植):把 inject/ 脚本清单(tok-badge.js +
// block-esc.js + quota-balance.js + request-marker.js)注入解包产物的 index.html(每脚本独立标记块,幂等可重跑)
// → 三重校验 → asar 打包到 resources/app.asar.new
// 另:quota-main.cjs 拷到 <resources>/zcode-quota-main.cjs,并在 out/main/index.js 尾部
// 追加幂等标记块动态 import(主进程额度轮询器;换装不重打包也能更新)
// 用法: node inject/pack.mjs [--deploy]
//   默认: 注入 + 打包 app.asar.new(不碰运行中的 app.asar)
//   --deploy: 另把 apply-update.mjs 与打包时 app.asar 指纹(app.asar.new.sha256)
//             拷入 resources 目录并后台启动 wait 模式(客户端退出后自动换入,并按
//             换装前抓取的主进程命令行自动重启客户端;换装前复验 app.asar 仍是
//             打包时记录的指纹,等待期被官方升级覆盖则中止换装防降级)
// 资源目录定位: 环境变量 ZCODE_RES 显式指定;否则探测平台常见安装路径(见 detectRes)。
// 升级后流程: 版本变了先清掉 unpack/ 重新解包(bundle 全换),再跑本脚本。
//   解包: npx --yes @electron/asar extract "<resources>/app.asar" unpack/app_extract
//   (完整流程与锚点抽查见 ../guide/common/pipeline.md)
import { createHash } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const EXT = join(REPO, 'unpack', 'app_extract')
const INDEX = join(EXT, 'out', 'renderer', 'index.html')
// 同步白名单:仅 tok-badge / block-esc / quota-balance / request-marker(README「同步口径」)。
// 白名单外补丁不移植;新增注入物须先入白名单。
const SCRIPTS = [
  ['tok-badge', join(REPO, 'inject', 'tok-badge.js')],
  ['block-esc', join(REPO, 'inject', 'block-esc.js')],
  ['quota-balance', join(REPO, 'inject', 'quota-balance.js')],
  ['request-marker', join(REPO, 'inject', 'request-marker.js')],
]

const marker = (name) => ['<!-- zcode-' + name + ':begin -->', '<!-- zcode-' + name + ':end -->']
const S_OPEN = '<script>'
const S_CLOSE = '</script>'
// 硬红线:注入的 JS 内容不得含这些字样(HTML 解析器会把 script 内容里的它们当真标签/注释)
const FORBIDDEN = ['<script', '</head', '</script', '<!--']

const fail = (msg) => { console.error('ERROR: ' + msg); process.exit(1) }
const count = (s, sub) => s.split(sub).length - 1
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const readText = (p) => readFileSync(p, 'utf8').replace(/\r\n|\r/g, '\n')
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase()

const deploy = process.argv.includes('--deploy')
// 资源目录: ZCODE_RES 优先,否则探测平台常见安装路径(win: LOCALAPPDATA\Programs 与
// Program Files;mac: /Applications)。都没有则报错——自定义安装位置请设 ZCODE_RES。
const WIN_RES_CANDIDATES = [
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources') : '',
  'C:\\Program Files\\ZCode\\resources',
  'C:\\Program Files (x86)\\ZCode\\resources',
]
const MAC_RES_CANDIDATES = ['/Applications/ZCode.app/Contents/Resources']
const detectRes = () => {
  const cands = process.platform === 'win32' ? WIN_RES_CANDIDATES : MAC_RES_CANDIDATES
  for (const p of cands) if (p && existsSync(join(p, 'app.asar'))) return p
  fail('ZCode resources 目录未找到(已探测: ' + cands.filter(Boolean).join(' ; ') +
    ');自定义安装位置请设 ZCODE_RES=<安装目录>/resources')
}
const RES = process.env.ZCODE_RES || detectRes()
// 主进程额度轮询器:运行文件放 resources 根目录(不进 asar,换装不重打包也能更新),
// 由 out/main/index.js 尾部动态 import 绝对 file:// URL 引入。
const MAIN_ENTRY = join(EXT, 'out', 'main', 'index.js')
const QUOTA_MAIN_SRC = join(REPO, 'inject', 'quota-main.cjs')
const QUOTA_MAIN_DST = join(RES, 'zcode-quota-main.cjs')
const QUOTA_BLOCK_RE = /\n;\/\* zcode-quota:begin \*\/[\s\S]*?\/\* zcode-quota:end \*\/\n?/g
if (!existsSync(INDEX)) fail('unpack missing: ' + INDEX +
  ' (先解包: npx --yes @electron/asar extract "<resources>/app.asar" unpack/app_extract,流程见 guide/common/pipeline.md)')

let html = readText(INDEX)
if (count(html, '</head>') !== 1) fail('index.html 结构异常')
const blocks = []
for (const [name, src] of SCRIPTS) {
  const js = readText(src)
  const low = js.toLowerCase()
  for (const tok of FORBIDDEN) if (low.includes(tok)) fail(name + ' JS 内容含危险 token: ' + tok)
  const [BEGIN, END] = marker(name)
  if (count(html, BEGIN) !== count(html, END)) fail('index.html 标记块异常: ' + name)
  // 幂等:剥掉旧注入块再插(升级重注入、脚本改版都直接重跑);基数在剥离后统计
  // 剥时连同 END 后紧跟的一个换行一起吞——否则每重跑一轮残留一个 \n,产物跨轮次漂移
  html = html.replace(new RegExp(escapeRe(BEGIN) + '[\\s\\S]*?' + escapeRe(END) + '\\n?', 'g'), '')
  blocks.push([name, BEGIN, END, js])
}
const beforeScripts = count(html, S_OPEN)
let inject = ''
for (const [name, BEGIN, END, js] of blocks) {
  inject += BEGIN + '\n' + S_OPEN + '\n' + js + '\n' + S_CLOSE + '\n' + END + '\n'
}
// 用函数替换: 注入内容可能含 `$&`/`$'` 等 String.replace 的替换模式(如 request-marker 的
// `__reactFiber$'`), 直接传串会被展开成匹配上下文,与逐字节 round-trip 校验必然冲突。
html = html.replace('</head>', () => inject + '</head>')
writeFileSync(INDEX, html, 'utf8')

// 主进程额度轮询器:运行文件拷到 resources 根目录,再在主进程入口尾部追加动态 import。
// 幂等:先剥旧标记块再追加(换 ZCODE_RES/安装目录时 URL 自动更新);find 式补丁不适用,
// 因为入口是单行 ESM,尾部无稳定特征串。
{
  if (!existsSync(MAIN_ENTRY)) fail('main entry 不存在: ' + MAIN_ENTRY + ' (unpack 不完整?重新解包)')
  if (!existsSync(RES)) fail('resources 目录不存在: ' + RES)
  const chk = spawnSync('node', ['--check', QUOTA_MAIN_SRC], { stdio: 'inherit' })
  if (chk.status !== 0) fail('quota-main.cjs 语法检查失败')
  writeFileSync(QUOTA_MAIN_DST, readText(QUOTA_MAIN_SRC), 'utf8')
  const url = pathToFileURL(QUOTA_MAIN_DST).href
  const block = '\n;/* zcode-quota:begin */import(' + JSON.stringify(url) +
    ').catch((e)=>console.error("[zcode-quota] load failed",e));/* zcode-quota:end */\n'
  const mainSrc = readText(MAIN_ENTRY)
  const next = mainSrc.replace(QUOTA_BLOCK_RE, '') + block
  if (next !== mainSrc) writeFileSync(MAIN_ENTRY, next, 'utf8')
  if (count(readText(MAIN_ENTRY), '/* zcode-quota:begin */') !== 1) fail('main 注入标记异常(zcode-quota)')
  console.log('[0/2] main patch OK zcode-quota')
}

// 校验 1:注入块内容与源文件逐字节一致(round-trip)
for (const [name, BEGIN, END, js] of blocks) {
  const i = html.indexOf(BEGIN)
  const a = html.indexOf(S_OPEN, i) + S_OPEN.length
  const b = html.indexOf(S_CLOSE, a)
  if (html.slice(a, b) !== '\n' + js + '\n') fail(name + ' 注入 round-trip 不一致')
}
// 校验 2:裸 script 开标签只多脚本数个(双标签残留史坑)
if (count(html, S_OPEN) !== beforeScripts + SCRIPTS.length) fail('script 标签计数异常')
// 校验 3:JS 语法(逐脚本)
mkdirSync(join(REPO, 'tmp'), { recursive: true })
for (const [name, , , js] of blocks) {
  const chk = join(REPO, 'tmp', '_inject_check.js')
  writeFileSync(chk, js, 'utf8')
  const r = spawnSync('node', ['--check', chk], { stdio: 'inherit' })
  rmSync(chk, { force: true })
  if (r.status !== 0) fail(name + ' JS 语法检查失败')
  console.log('[1/2] inject OK ' + name + ', md5=' + createHash('md5').update(js).digest('hex').slice(0, 12))
}

// 防降级基线:app.asar.new 是「此刻安装目录 app.asar」的替换品,先取指纹供监视器换装前
// 复验——等待退出期间官方升级覆盖 app.asar 的话,换装等于把客户端降回旧版,失配即中止。
// 先取指纹再打包(打包约 1 分钟,取值时点朝保守侧闭合)
const asarPath = join(RES, 'app.asar')
const baseSha = existsSync(asarPath) ? sha256File(asarPath) : ''
if (deploy && !baseSha) console.log('warn: app.asar not found, downgrade guard inactive')

const out = join(RES, 'app.asar.new')
rmSync(out, { force: true })
const cmd = 'npx --yes @electron/asar pack "' + EXT + '" "' + out + '" --unpack-dir "**/{node-pty,ssh2}/**"'
const packR = spawnSync(cmd, { shell: true, cwd: REPO, stdio: 'inherit' })
if (packR.status !== 0) fail('asar pack 失败')
const size = statSync(out).size
if (size <= 200 * 1024 * 1024) fail('打包产物过小(源不完整?): ' + size)
console.log('[2/2] pack OK: app.asar.new ' + Math.round(size / 1048576) + ' MB')

if (deploy) {
  const applyMjs = join(RES, 'apply-update.mjs')
  copyFileSync(join(REPO, 'inject', 'apply-update.mjs'), applyMjs)
  writeFileSync(join(RES, 'app.asar.new.sha256'), baseSha, 'utf8')
  // 清 python/PS1 版监视器遗留,防双监视器并存
  rmSync(join(RES, 'apply-update.ps1'), { force: true })
  rmSync(join(RES, 'apply-update.bat'), { force: true })
  spawn(process.execPath, [applyMjs, 'wait'], { cwd: RES, detached: true, stdio: 'ignore', windowsHide: true }).unref()
  console.log('deploy: watcher started (waits for ZCode exit, verifies app.asar still matches pack-time sha256 '
    + (baseSha ? baseSha.slice(0, 12) + '..., aborts on mismatch' : 'guard off')
    + ', swaps, then relaunches ZCode with its original command line; log: resources/zcode-inject.log)')
} else {
  console.log('next: 完全退出 ZCode 后手动换装,或重跑本脚本加 --deploy')
}
