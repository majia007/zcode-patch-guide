#!/usr/bin/env node
// ZCode asar swap watcher (node cross-platform port of apply-update.ps1; ASCII-only by
// policy, same as the ps1 it replaces - comments and log lines stay English).
// Run: node apply-update.mjs [wait|now]
//   wait: swap after client exits, then relaunch ZCode with its original command line.
//   now : swap immediately.
// Old asar kept as app.asar.old on success; rolled back on failure. Aborts without
// swapping when app.asar no longer matches the pack-time fingerprint (official update
// during the wait). Fingerprint file: app.asar.new.sha256 written by pack.mjs --deploy
// (absent/empty = guard off). Log: zcode-inject.log (in this script's directory).
import { createHash } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.chdir(dirname(fileURLToPath(import.meta.url)))

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const pad = (n) => String(n).padStart(2, '0')
const ts = () => {
  const d = new Date()
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}
const log = (m) => appendFileSync('zcode-inject.log', '[' + ts() + '] ' + m + '\n')
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase()
// windowsHide (CREATE_NO_WINDOW) is mandatory here: this watcher runs detached without a
// console, so any console-subsystem child (tasklist/powershell) spawned without it gets a
// fresh console allocated - with Windows Terminal as the default host that pops a visible
// window on every 1s poll.
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
// rename with Move-Item -Force semantics (node rename fails when destination exists on win)
const renameForce = (from, to) => { rmSync(to, { force: true }); renameSync(from, to) }

const isWin = process.platform === 'win32'

// ZCode running? win: tasklist name filter (no-match message is localized, matching the
// image name instead keeps it locale-proof); mac: pgrep -x (exact process name).
function zcodeRunning() {
  if (isWin) {
    const r = run('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/FO', 'CSV', '/NH'])
    return (r.stdout || '').includes('ZCode.exe')
  }
  return run('pgrep', ['-x', 'ZCode']).status === 0
}

// capture the MAIN process command line while ZCode still runs (children carry --type=;
// app-server processes run ZCode.exe zcode.cjs app-server --stdio without --type=, exclude
// them too or the relaunch may start a headless stdio process instead of the GUI)
function captureMainCmdline() {
  if (isWin) {
    const r = run('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='ZCode.exe'\" | Where-Object { $_.CommandLine -and ($_.CommandLine -notmatch '--type=') -and ($_.CommandLine -notmatch 'zcode\\.cjs') } | Select-Object -First 1 -ExpandProperty CommandLine"])
    return (r.stdout || '').trim()
  }
  const r = run('ps', ['-axo', 'command='])
  const line = (r.stdout || '').split('\n').map((s) => s.trim())
    .find((l) => l.includes('ZCode.app/Contents/MacOS') && !l.includes('--type=') && !l.includes('zcode.cjs'))
  return line || ''
}

const mode = process.argv[2] || 'wait'
log('apply-update start (' + mode + ')')
const relaunch = captureMainCmdline()
if (relaunch) log('captured: ' + relaunch)

if (mode !== 'now') {
  while (zcodeRunning()) sleep(1000)
  sleep(2000)
  while (zcodeRunning()) sleep(1000)
}

if (!existsSync('app.asar.new')) { log('ERR app.asar.new not found'); process.exit(1) }
if (!existsSync('app.asar')) { log('ERR app.asar not found'); process.exit(1) }

// anti-downgrade guard: app.asar.new was built against the app.asar snapshot hashed at
// pack time; if the official updater replaced app.asar while we waited, swapping now
// would roll the client back - rename the new package to .stale and abort instead.
const baseSha = existsSync('app.asar.new.sha256') ? readFileSync('app.asar.new.sha256', 'utf8').trim().toUpperCase() : ''
const curSha = sha256File('app.asar')
const newSha = sha256File('app.asar.new')
if (curSha === newSha) { log('already applied (app.asar == app.asar.new), nothing to do'); process.exit(0) }
if (baseSha && curSha !== baseSha) {
  renameForce('app.asar.new', 'app.asar.new.stale')
  log('ERR app.asar changed since pack (official update during wait?); swap aborted to avoid downgrade; base=' + baseSha + ' cur=' + curSha)
  process.exit(1)
}

let moved = false
for (let i = 0; i < 5 && !moved; i++) {
  try { renameForce('app.asar', 'app.asar.old'); moved = true } catch { sleep(1000) }
}
if (!moved) { log('ERR cannot move app.asar (still locked?)'); process.exit(1) }
try {
  renameForce('app.asar.new', 'app.asar')
} catch {
  renameForce('app.asar.old', 'app.asar')
  log('ERR swap app.asar.new failed, rolled back')
  process.exit(1)
}
if (existsSync('app.asar.new.unpacked')) {
  cpSync('app.asar.new.unpacked', 'app.asar.unpacked', { recursive: true })
  rmSync('app.asar.new.unpacked', { recursive: true, force: true })
}
log('OK swapped')

// relaunch ZCode with the captured command line (skipped when it was not running)
if (relaunch) {
  try {
    let exePath
    let exeArgs
    if (relaunch.startsWith('"')) {
      const q = relaunch.indexOf('"', 1)
      exePath = relaunch.slice(1, q)
      exeArgs = relaunch.slice(q + 1).trim()
    } else {
      const sp = relaunch.indexOf(' ')
      if (sp < 0) { exePath = relaunch; exeArgs = '' }
      else { exePath = relaunch.slice(0, sp); exeArgs = relaunch.slice(sp + 1).trim() }
    }
    const argv = exeArgs ? (exeArgs.match(/"[^"]*"|\S+/g) || []) : []
    spawn(exePath, argv, { detached: true, stdio: 'ignore', cwd: dirname(exePath), windowsHide: true }).unref()
    log('relaunched: ' + exePath + ' ' + exeArgs)
  } catch (e) { log('ERR relaunch failed: ' + e) }
} else { log('no relaunch (ZCode was not running)') }
