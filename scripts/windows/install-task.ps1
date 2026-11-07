<#
.SYNOPSIS
  Registers the supervisor as a Windows Task Scheduler task. No security feature is disabled or weakened.
.PARAMETER Trigger
  AtLogOn   (default) start when the current user signs in; runs in that user's session, hidden.
  AtStartup start at boot. Requires an elevated PowerShell and -RunWhetherLoggedOnOrNot.
.PARAMETER RunWhetherLoggedOnOrNot
  Prompts for the Windows password; Task Scheduler stores it (this script never does).
.PARAMETER NodePath
  Full path of node.exe. Resolved NOW from PATH and embedded in the task, because Task Scheduler may not see
  the same PATH as your interactive shell (nvm/fnm/user-level installs).
.NOTES
  Limits: nothing runs while the PC is off, asleep, hibernating or offline (see docs/WINDOWS_DEPLOYMENT.md).
  Written and statically reviewed WITHOUT a Windows machine. Use -WhatIf first, then scripts\windows\verify-install.ps1.
  Compatible with Windows PowerShell 5.1 and PowerShell 7.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'ElevariqPersonalAgent',
  [ValidateSet('AtLogOn', 'AtStartup')][string]$Trigger = 'AtLogOn',
  [switch]$RunWhetherLoggedOnOrNot,
  [string]$RepoPath = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$NodePath = ''
)
$ErrorActionPreference = 'Stop'

$wrapper = Join-Path $RepoPath 'scripts\windows\run-supervisor.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) { throw "Wrapper not found: $wrapper" }
if (-not (Test-Path -LiteralPath (Join-Path $RepoPath 'dist\cli\index.js'))) { throw 'Run "npm ci" and "npm run build" in the repo first.' }
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node.exe not found on PATH. Install Node.js 22.12+ or pass -NodePath.' }
  $NodePath = $cmd.Source
}
$nodeVersion = (& $NodePath --version).Trim()
if ([version]($nodeVersion.TrimStart('v')) -lt [version]'22.12.0') { throw "Node $nodeVersion is too old; 22.12 or newer is required." }

if ($Trigger -eq 'AtStartup') {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { throw 'AtStartup requires an elevated (Administrator) PowerShell.' }
  if (-not $RunWhetherLoggedOnOrNot) { throw 'AtStartup requires -RunWhetherLoggedOnOrNot (the task must run without an interactive logon).' }
}

$argLine = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$wrapper`" -RepoPath `"$RepoPath`" -NodePath `"$NodePath`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $RepoPath
if ($Trigger -eq 'AtStartup') { $trig = New-ScheduledTaskTrigger -AtStartup } else { $trig = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME" }
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -Hidden

if ($PSCmdlet.ShouldProcess($TaskName, "Register scheduled task ($Trigger) using $NodePath ($nodeVersion)")) {
  if ($RunWhetherLoggedOnOrNot) {
    $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password for the scheduled task (stored by Task Scheduler, not by this script)'
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trig -Settings $settings `
      -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
  } else {
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trig -Settings $settings -Principal $principal -Force | Out-Null
  }
  Write-Output "Registered '$TaskName' ($Trigger). Start now:  Start-ScheduledTask -TaskName $TaskName"
  Write-Output 'Then verify:  powershell -File scripts\windows\verify-install.ps1'
  Write-Output 'Status:       node dist\cli\index.js status          Stop gracefully:  node dist\cli\index.js stop'
}
