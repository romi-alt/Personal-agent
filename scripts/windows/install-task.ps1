<#
.SYNOPSIS
  Registers the supervisor as a Windows Task Scheduler task. No security feature is disabled or weakened.
.PARAMETER Trigger
  AtLogOn   (default) start when the current user signs in; runs in that user's session, hidden. This is the mode
            verified on Windows 11 with the Claude Code subscription login (the credential store of the signed-in
            user is readable there).
  AtStartup start at boot. Requires an elevated PowerShell and -RunWhetherLoggedOnOrNot. NOT verified with the
            claude-cli provider: a non-interactive logon may not be able to read the Claude Code login.
.PARAMETER RunWhetherLoggedOnOrNot
  Prompts for the Windows password; Task Scheduler stores it (this script never does).
.PARAMETER NodePath
  Full path of node.exe. Resolved NOW from PATH and embedded in the task, because Task Scheduler may not see
  the same PATH as your interactive shell (nvm/fnm/user-level installs).
.PARAMETER AgentHome
  Optional state directory (database, logs, workspaces). Default: %LOCALAPPDATA%\ElevariqAgent.
.PARAMETER EnvFile
  Optional configuration file. Default: <RepoPath>\.env. Contains configuration only; secrets never go in the task.
.NOTES
  Limits: nothing runs while the PC is off, asleep, hibernating or offline (see docs/WINDOWS_DEPLOYMENT.md).
  Use -WhatIf first, then scripts\windows\verify-install.ps1.
  Compatible with Windows PowerShell 5.1 and PowerShell 7.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'ElevariqPersonalAgent',
  [ValidateSet('AtLogOn', 'AtStartup')][string]$Trigger = 'AtLogOn',
  [switch]$RunWhetherLoggedOnOrNot,
  [string]$RepoPath = '',
  [string]$NodePath = '',
  [string]$AgentHome = '',
  [string]$EnvFile = '',
  # Keepalive: an extra trigger every N minutes. While the agent runs it is ignored (MultipleInstances IgnoreNew);
  # if the task's processes were terminated (crash of the whole tree, killed task), it restarts the agent.
  # 0 disables. A deliberate `stop --hold` is honoured by the wrapper (STOP-HOLD marker).
  [int]$KeepAliveMinutes = 5
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 leaves $PSScriptRoot empty inside param() defaults, so resolve it here.
if (-not $RepoPath) { $RepoPath = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path

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

# Paths only: never put secrets in task arguments (they are visible to anyone who can read the task).
$argLine = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$wrapper`" -RepoPath `"$RepoPath`" -NodePath `"$NodePath`""
if ($AgentHome) { $argLine += " -AgentHome `"$AgentHome`"" }
if ($EnvFile) { $argLine += " -EnvFile `"$EnvFile`"" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $RepoPath
if ($Trigger -eq 'AtStartup') { $trig = New-ScheduledTaskTrigger -AtStartup } else { $trig = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME" }
if ($KeepAliveMinutes -gt 0) {
  # Empty Repetition.Duration = repeat indefinitely (Windows PowerShell 5.1 default for -Once with an interval).
  $keep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $KeepAliveMinutes)
  $trig = @($trig, $keep)
}
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -Hidden

Write-Output "Task      : $TaskName ($Trigger, user $env:USERDOMAIN\$env:USERNAME)"
Write-Output "Execute   : powershell.exe $argLine"
Write-Output "WorkingDir: $RepoPath"
Write-Output "Node      : $NodePath ($nodeVersion)"
Write-Output "Keepalive: $(if ($KeepAliveMinutes -gt 0) { "every $KeepAliveMinutes min (no-op while running)" } else { 'off' })"
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
