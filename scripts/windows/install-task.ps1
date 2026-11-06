<#
.SYNOPSIS
  Registers the supervisor as a Windows Task Scheduler task (no security features are disabled).
.PARAMETER Trigger
  AtLogOn   (default) start when the current user signs in. Runs in the user's session, hidden.
  AtStartup start at boot. Requires an elevated PowerShell and -RunWhetherLoggedOnOrNot.
.PARAMETER RunWhetherLoggedOnOrNot
  Prompts for the user's Windows password (kept by Task Scheduler's credential store, never by this script).
.NOTES
  Limitations: the task cannot run while the PC is off, asleep or hibernating. See docs/OPERATIONS.md.
  This script has NOT been executed in the Phase 1 build environment (Linux). Test on your machine with -WhatIf first.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'ElevariqPersonalAgent',
  [ValidateSet('AtLogOn', 'AtStartup')][string]$Trigger = 'AtLogOn',
  [switch]$RunWhetherLoggedOnOrNot,
  [string]$RepoPath = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)
$ErrorActionPreference = 'Stop'
$wrapper = Join-Path $RepoPath 'scripts\windows\run-supervisor.ps1'
if (-not (Test-Path $wrapper)) { throw "Wrapper not found: $wrapper" }
if (-not (Test-Path (Join-Path $RepoPath 'dist\cli\index.js'))) { throw 'Run "npm ci" and "npm run build" in the repo first.' }
$null = Get-Command node -ErrorAction Stop

if ($Trigger -eq 'AtStartup') {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { throw 'AtStartup requires an elevated (Administrator) PowerShell.' }
  if (-not $RunWhetherLoggedOnOrNot) { throw 'AtStartup requires -RunWhetherLoggedOnOrNot (the task must run without an interactive logon).' }
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$wrapper`" -RepoPath `"$RepoPath`"" `
  -WorkingDirectory $RepoPath
$trig = if ($Trigger -eq 'AtStartup') { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME }
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -Hidden

if ($PSCmdlet.ShouldProcess($TaskName, "Register scheduled task ($Trigger)")) {
  if ($RunWhetherLoggedOnOrNot) {
    $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password for the scheduled task (stored by Task Scheduler)'
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trig -Settings $settings `
      -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
  } else {
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trig -Settings $settings -Principal $principal -Force | Out-Null
  }
  Write-Output "Registered '$TaskName' ($Trigger). Start now: Start-ScheduledTask -TaskName $TaskName"
  Write-Output 'Status: npm run agent -- status     Stop: npm run agent -- stop'
}
