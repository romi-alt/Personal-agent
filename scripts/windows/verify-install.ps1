<#
.SYNOPSIS
  Verifies a Windows installation of the ELEVARIQ Personal Agent and prints PASS/FAIL per check.
  Read-only: it starts nothing and changes nothing (the supervisor is only queried).
  Compatible with Windows PowerShell 5.1 and PowerShell 7. Written without access to Windows: run it, and report any FAIL.
#>
param(
  [string]$TaskName = 'ElevariqPersonalAgent',
  [string]$RepoPath = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)
$ErrorActionPreference = 'Continue'
$script:fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { Write-Output ("PASS  {0}  {1}" -f $Name, $Detail) } else { $script:fail++; Write-Output ("FAIL  {0}  {1}" -f $Name, $Detail) }
}

$node = Get-Command node -ErrorAction SilentlyContinue
Check 'node on PATH' ($null -ne $node) $(if ($node) { $node.Source } else { 'install Node.js 22.12+' })
if ($node) {
  $v = (& $node.Source --version).Trim()
  Check 'node >= 22.12' ([version]($v.TrimStart('v')) -ge [version]'22.12.0') $v
}
$git = Get-Command git -ErrorAction SilentlyContinue
Check 'git on PATH' ($null -ne $git) $(if ($git) { $git.Source } else { 'install Git for Windows' })
$entry = Join-Path $RepoPath 'dist\cli\index.js'
Check 'build output present' (Test-Path -LiteralPath $entry) $entry
Check '.env or environment key (optional)' $true $(if (Test-Path -LiteralPath (Join-Path $RepoPath '.env')) { '.env present' } else { 'no .env (mock provider needs none)' })

if ($node -and (Test-Path -LiteralPath $entry)) {
  Push-Location $RepoPath
  try {
    $doctor = & $node.Source $entry doctor 2>&1 | Out-String
    Check 'agent doctor (no FAIL rows)' ($LASTEXITCODE -eq 0) 'run `node dist\cli\index.js doctor` for the table'
    Write-Output $doctor
    $health = & $node.Source $entry health 2>&1 | Out-String
    Check 'supervisor live (health exit 0)' ($LASTEXITCODE -eq 0) $health.Trim()
  } finally { Pop-Location }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Check "scheduled task '$TaskName' registered" ($null -ne $task) $(if ($task) { "state=$($task.State)" } else { 'run install-task.ps1' })
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Check 'task last result is OK or still running' (($info.LastTaskResult -eq 0) -or ($info.LastTaskResult -eq 267009) -or ($info.LastTaskResult -eq 267011)) ("LastTaskResult=$($info.LastTaskResult) LastRun=$($info.LastRunTime)")
  Check 'task has no execution time limit' ($task.Settings.ExecutionTimeLimit -eq 'PT0S') "$($task.Settings.ExecutionTimeLimit)"
  Check 'task ignores duplicate starts' ($task.Settings.MultipleInstances -eq 'IgnoreNew') "$($task.Settings.MultipleInstances)"
}

$power = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Out-String)
Write-Output "INFO  power plan sleep settings (AC value must be 0x00000000 for 24/7 operation):"
Write-Output $power
if ($script:fail -gt 0) { Write-Output "`n$($script:fail) check(s) FAILED."; exit 1 } else { Write-Output "`nAll checks passed."; exit 0 }
