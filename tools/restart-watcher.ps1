# 重启 ZCode asar 换装监视器(apply-update.mjs wait)。
# 为什么不用 --deploy 的 detached watcher:从 ZCode 内嵌 bash 工具(或其它会回收子进程
# job 的宿主)跑命令时,detached watcher 可能随命令 job 一起被回收——退出客户端后不换装
# (日志停在 captured:、app.asar.new 仍在)。
# 本脚本用计划任务(ZCodeInjectSwap)承载,任务动作 = wscript.exe + hidden-run.vbs:
#   计划任务让进程脱离调用方 job;
#   wscript 是 GUI 宿主(无 console),VBS 的 Run(...,0) 隐藏启动 node,不弹终端窗口。
#   (计划任务直接排 node.exe 会分配可见 console;WMI 直起 node 同理会弹窗;
#    WMI + powershell -WindowStyle Hidden 静默失败;WMI + wscript 实测不起 node。)
# 幂等:/F 覆盖同名任务,/End 先清旧实例再 /Run。
# 用法: pwsh -NoProfile -File tools/restart-watcher.ps1 [-Resources <resources>]
#   资源目录默认取 ZCODE_RES,否则探测常见安装路径;先跑过 node inject/pack.mjs --deploy
#   才会在 resources 下生成 apply-update.mjs。
param(
  [string]$Resources = $env:ZCODE_RES
)
$ErrorActionPreference = 'Stop'

if (-not $Resources) {
  $cands = @(
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\ZCode\resources' }),
    'C:\Program Files\ZCode\resources',
    'C:\Program Files (x86)\ZCode\resources'
  ) | Where-Object { $_ }
  $Resources = $cands | Where-Object { Test-Path (Join-Path $_ 'app.asar') } | Select-Object -First 1
}
if (-not $Resources) {
  throw '未找到 ZCode resources 目录;自定义安装位置请设 ZCODE_RES=<安装目录>\resources,或传 -Resources'
}
$apply = Join-Path $Resources 'apply-update.mjs'
if (-not (Test-Path $apply)) {
  throw "监视器脚本不存在: $apply (先跑 node inject/pack.mjs --deploy 生成)"
}
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) {
  throw "node.exe 未找到(已查 PATH 与 $node)"
}
$vbs = Join-Path $PSScriptRoot 'hidden-run.vbs'
if (-not (Test-Path $vbs)) {
  throw "hidden-run.vbs 不存在: $vbs"
}

$tn = 'ZCodeInjectSwap'
$tr = 'wscript.exe "' + $vbs + '" "' + $node + '" "' + $apply + '" wait'
Write-Output ("resources: " + $Resources)
Write-Output ("action:    " + $tr)
schtasks /Create /TN $tn /TR $tr /SC ONCE /ST 23:59 /F 2>&1 | Out-String
schtasks /End /TN $tn 2>$null | Out-Null
schtasks /Run /TN $tn 2>&1 | Out-String
Start-Sleep -Seconds 5
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'apply-update\.mjs' }
$procs | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine |
  Format-List | Out-String -Width 300

# 可见窗口探测:标题含 node/apply-update 的顶层可见窗口(为空=无弹窗)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ZCodeWatcherWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$found = New-Object System.Collections.ArrayList
$cb = [ZCodeWatcherWin+EnumWindowsProc]{
  param($h, $l)
  if ([ZCodeWatcherWin]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][ZCodeWatcherWin]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    if ($t -match 'node|apply-update') { [void]$found.Add($t) }
  }
  return $true
}
[void][ZCodeWatcherWin]::EnumWindows($cb, [IntPtr]::Zero)
"visible windows matching node/apply-update: " + $found.Count
$found | ForEach-Object { "  - " + $_ }
