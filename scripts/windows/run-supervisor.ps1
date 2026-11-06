<#
.SYNOPSIS
  Runs the ELEVARIQ Personal Agent supervisor in the foreground and restarts it if it crashes.
.DESCRIPTION
  - Graceful stop (exit code 0, e.g. `npm run agent -- stop`)  -> wrapper exits, no restart.
  - Another supervisor already live (exit code 3)              -> wrapper exits, no restart.
  - Any other exit (crash, kill)                               -> restart after a delay that backs off up to 5 minutes.
  The supervisor itself reconciles interrupted work on every start (see docs/RECOVERY.md).
  Secrets are NOT stored here: put them in the repo's untracked .env or in user-level environment variables.
#>
param(
  [string]$RepoPath = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$NodePath = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
Set-Location $RepoPath
$entry = Join-Path $RepoPath 'dist\cli\index.js'
if (-not (Test-Path $entry)) { throw "Build first: npm ci; npm run build  (missing $entry)" }

$delay = 10
while ($true) {
  $started = Get-Date
  & $NodePath $entry start
  $code = $LASTEXITCODE
  if ($code -eq 0) { Write-Output 'Supervisor stopped gracefully.'; exit 0 }
  if ($code -eq 3) { Write-Output 'Another supervisor is already running; exiting.'; exit 0 }
  # Reset the delay if the process had been healthy for a while.
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 10 } else { $delay = [Math]::Min($delay * 2, 300) }
  Write-Warning "Supervisor exited with code $code; restarting in $delay s"
  Start-Sleep -Seconds $delay
}
