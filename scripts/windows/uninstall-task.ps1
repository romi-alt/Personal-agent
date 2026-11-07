<#
.SYNOPSIS
  Gracefully stops the supervisor (so in-flight work is checkpointed) and unregisters the scheduled task.
  Compatible with Windows PowerShell 5.1 and PowerShell 7. Not executed in the Phase 1.5 build environment.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'ElevariqPersonalAgent',
  [string]$RepoPath = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)
$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Output "Task '$TaskName' not found."; exit 0 }

if ($PSCmdlet.ShouldProcess($TaskName, 'Gracefully stop the supervisor, then unregister the task')) {
  $entry = Join-Path $RepoPath 'dist\cli\index.js'
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node -and (Test-Path -LiteralPath $entry)) {
    Push-Location $RepoPath
    try {
      # `stop` sets a flag in the database, which works on Windows (no POSIX signals needed).
      $p = Start-Process -FilePath $node.Source -ArgumentList @("`"$entry`"", 'stop') -NoNewWindow -Wait -PassThru
      if ($p.ExitCode -ne 0) { Write-Warning "stop returned exit code $($p.ExitCode); the supervisor may not have been running." }
    } finally { Pop-Location }
  } else { Write-Warning 'node or dist\cli\index.js not found; skipping graceful stop.' }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed '$TaskName'."
}
