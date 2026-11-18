# ============================================================
#  watchdog-zhixingli.ps1 — 职行力刷课 · 页面外监督者（v3.27）
#
#  页面内自愈覆盖不了的故障：整页连 Worker 一起冻死、Chrome 崩溃/被杀、
#  标签页被丢弃、Tampermonkey 注入失败——这些只有页外看得见。
#
#  原理：userscript 每 5 秒把心跳写进标签页标题——
#        职行力|<run|stop>|<state 或 login>|<unix 秒>
#  本监督者经专用实例的 CDP 端口读 /json（纯 HTTP，无需 WebSocket）：
#    - 标题心跳停走 > 阈值      → 整页冻结 → 杀进程重启浏览器（脚本自动续跑）
#    - u.exexm.com 标签消失     → 上次心跳仍是 run → 重启浏览器
#    - 标签在但心跳连续 2 拍缺失 → 脚本/Tampermonkey 没跑 → 重启浏览器
#    - state=halt / flag=login  → 只弹 Windows 通知叫人，不重启
#    - mode=stop                → 用户已停止，待命不动
#  防僵尸循环：重启有 15 分钟冷却；且"上次重启后必须先重新见到心跳"才允许
#  再次重启——反复拉起仍无心跳时发一条通知后待命，绝不无限拉起。
#
#  用法：register-zhixingli-watchdog.cmd 注册计划任务（每 5 分钟一拍）。
#  手动单拍（调试）：powershell -NoProfile -ExecutionPolicy Bypass -File watchdog-zhixingli.ps1
#  日志：%LocalAppData%\zhixingli-chrome\watchdog.log
# ============================================================
param(
  [int]$Port = 9223,
  [string]$Launcher = "$PSScriptRoot\launch-zhixingli-chrome.cmd",
  [string]$StateDir = "$env:LocalAppData\zhixingli-chrome",
  [int]$StaleSec = 600,           # 心跳过期阈值（秒）
  [int]$RestartCooldownSec = 900, # 重启冷却（秒）
  [int]$NotifyRepeatSec = 1800    # 同类通知去重窗口（秒）
)

$ErrorActionPreference = "SilentlyContinue"
$stateFile = Join-Path $StateDir "watchdog-state.json"
$logFile = Join-Path $StateDir "watchdog.log"
New-Item -ItemType Directory -Force $StateDir | Out-Null

# ---------- 状态（跨拍持久化） ----------
$st = [pscustomobject]@{
  seen = ""              # 最近一次读到的心跳 mode（run/stop/""）
  missStreak = 0         # 标签在但无心跳的连续拍数
  lastRestartAt = 0      # 上次重启时间（unix 秒）
  sawHbSinceRestart = $true # 上次重启后是否重新见过心跳（僵尸拉起熔断）
  lastNotifySig = ""
  lastNotifyAt = 0
}
if (Test-Path $stateFile) {
  try {
    $j = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($k in @("seen", "missStreak", "lastRestartAt", "sawHbSinceRestart", "lastNotifySig", "lastNotifyAt")) {
      if ($j.PSObject.Properties.Name -contains $k) { $st.$k = $j.$k }
    }
  } catch {}
}
function Save-State {
  $st | ConvertTo-Json -Compress | Set-Content -Path $stateFile -Encoding UTF8
}
function Log([string]$msg) {
  try {
    Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) -Encoding UTF8
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 200KB) {
      Move-Item -Force $logFile "$logFile.old"
    }
  } catch {}
}

# ---------- Windows 通知（无模块依赖的 WinRT Toast；失败退化为日志/控制台） ----------
function Send-Toast([string]$sig, [string]$msg) {
  $u = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  if ($sig -eq $st.lastNotifySig -and ($u - $st.lastNotifyAt) -lt $NotifyRepeatSec) { return }
  $st.lastNotifySig = $sig
  $st.lastNotifyAt = $u
  Log "通知：$msg"
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $t = $xml.GetElementsByTagName("text")
    [void]$t.Item(0).AppendChild($xml.CreateTextNode("职行力刷课监督者"))
    [void]$t.Item(1).AppendChild($xml.CreateTextNode($msg))
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    # 借 PowerShell 的 AUMID 弹通知（无需注册自定义 AppId）
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(
      "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    ).Show($toast)
  } catch { Write-Output $msg }
}

# ---------- 重启专用浏览器（杀干净再拉起，脚本从 localStorage 自动续跑） ----------
function Restart-Browser([string]$why) {
  $u = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  if ($u - $st.lastRestartAt -lt $RestartCooldownSec) {
    Log "重启冷却中，跳过：$why"
    return
  }
  if (-not $st.sawHbSinceRestart) {
    # 上次重启后从未见过心跳：Chrome 起不来 / Tampermonkey 坏了，重启无解
    Send-Toast "zombie" "浏览器反复拉起后仍无脚本心跳，监督者待命（人工恢复后自动继续值守）"
    return
  }
  $st.lastRestartAt = $u
  $st.sawHbSinceRestart = $false
  Save-State
  Log "重启专用浏览器：$why"
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like "*zhixingli-chrome*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  if (Test-Path $Launcher) {
    Start-Process -FilePath $Launcher -WorkingDirectory (Split-Path $Launcher)
    Send-Toast "restart-$u" ("已重启专用浏览器自动续跑：" + $why)
  } else {
    Log "启动器不存在：$Launcher"
    Send-Toast "no-launcher" ("找不到启动器，无法自动重启（" + $why + "）")
  }
}

# ---------- 主流程（单拍） ----------
$uNow = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$pages = @()
try {
  $tabs = @(Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/json" -f $Port) -TimeoutSec 5)
  $pages = @($tabs | Where-Object { $_.type -eq "page" -and $_.url -like "*u.exexm.com*" })
} catch {}

$hb = $null
foreach ($p in $pages) {
  if ($p.title -match '^职行力\|(run|stop)\|([^|]+)\|(\d{9,})$') {
    $hb = [pscustomobject]@{ mode = $Matches[1]; flag = $Matches[2]; epoch = [long]$Matches[3] }
    break
  }
}

if ($hb) {
  $st.seen = $hb.mode
  $st.missStreak = 0
  $st.sawHbSinceRestart = $true
  $age = $uNow - $hb.epoch
  if ($hb.flag -eq "halt") {
    # 熔断停机（mode 已是 stop，但必须先于 stop 分支判断）：重启无解，叫人
    Send-Toast "halt" "脚本已熔断停机，需人工处理（面板有状态说明）"
  } elseif ($hb.flag -eq "login") {
    Send-Toast "login" "登录已过期：请在专用浏览器重新登录，脚本会自动继续"
  } elseif ($hb.mode -eq "stop") {
    # 用户已停止：待命不动
  } elseif ($age -gt $StaleSec) {
    Restart-Browser ("整页冻结（心跳停走 {0} 分钟）" -f [math]::Round($age / 60.0))
  }
} elseif ($pages.Count -gt 0) {
  # 标签在、心跳没有：刚启动（宽限）/ Tampermonkey 没注入 / 脚本崩了。
  # 连续 2 拍缺失且此前在运行才重启（约 10 分钟，避开启动宽限与瞬时导航）
  if ($st.seen -eq "run") {
    $st.missStreak++
    if ($st.missStreak -ge 2) {
      $st.missStreak = 0
      Restart-Browser "标签页在但脚本心跳连续缺失（疑似 Tampermonkey/脚本未运行）"
    }
  } else {
    $st.missStreak = 0
  }
} else {
  # 没有 u.exexm.com 标签：Chrome 没开或标签丢失
  $st.missStreak = 0
  if ($st.seen -eq "run") {
    Restart-Browser "浏览器或标签页消失（上次心跳状态：运行中）"
  }
}
Save-State
