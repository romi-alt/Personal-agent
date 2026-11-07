<#
.SYNOPSIS
  Runs the ELEVARIQ Personal Agent supervisor in the foreground and restarts it if it crashes.
.DESCRIPTION
  Exit-code policy (the supervisor's own codes):
    0  graceful stop (e.g. `node dist\cli\index.js stop`)      -> wrapper exits, NO restart
    2  invalid configuration                                    -> wrapper exits, NO restart (restarting cannot fix it)
    3  another supervisor is already live                       -> wrapper exits, NO restart
    other (crash, killed, non-zero)                             -> restart after a delay that doubles from 10 s up to 5 min
                                                                   (reset after 10 healthy minutes)
  Output handling: the supervisor writes rotated, redacted application logs to LOG_DIR itself. This wrapper only captures
  the child's stdout/stderr (startup/config errors that happen before the logger exists) into
  <AGENT_HOME>\logs\supervisor-stdout.log / supervisor-stderr.log, truncated when larger than 5 MB at each (re)start.
  Secrets: NOT stored here. Use user-level environment variables or the untracked .env in the repo folder.
  Compatible with Windows PowerShell 5.1 and PowerShell 7.
  NOTE: written without access to a Windows machine; verify with scripts\windows\verify-install.ps1.
#>
param(
  [string]$RepoPath = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$NodePath = ''
)
$ErrorActionPreference = 'Stop'

if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node.exe not found on PATH. Install Node.js 22.12+ or pass -NodePath.' }
  $NodePath = $cmd.Source
}
$entry = Join-Path $RepoPath 'dist\cli\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw "Build first: npm ci; npm run build  (missing $entry)" }

# Same default as the application (src/config): %LOCALAPPDATA%\ElevariqAgent unless AGENT_HOME is set.
$agentHome = $env:AGENT_HOME
if (-not $agentHome) { $agentHome = Join-Path $env:LOCALAPPDATA 'ElevariqAgent' }
$logDir = Join-Path $agentHome 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir 'supervisor-stdout.log'
$errLog = Join-Path $logDir 'supervisor-stderr.log'

# The app already writes structured logs to files; do not also stream them to an unbounded stderr capture.
if (-not $env:LOG_TO_CONSOLE) { $env:LOG_TO_CONSOLE = 'false' }

# The supervisor resolves ".env" relative to the working directory.
Set-Location -LiteralPath $RepoPath

$delay = 10
while ($true) {
  foreach ($f in @($outLog, $errLog)) {
    if ((Test-Path -LiteralPath $f) -and ((Get-Item -LiteralPath $f).Length -gt 5MB)) { Remove-Item -LiteralPath $f -Force }
  }
  $started = Get-Date
  # Start-Process avoids Windows PowerShell 5.1 turning native stderr output into terminating errors.
  $p = Start-Process -FilePath $NodePath -ArgumentList @("`"$entry`"", 'start') -WorkingDirectory $RepoPath `
        -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  $code = $p.ExitCode
  if ($code -eq 0) { Write-Output 'Supervisor stopped gracefully.'; exit 0 }
  if ($code -eq 2) { Write-Error "Invalid configuration (exit 2). See $errLog. Not restarting."; exit 2 }
  if ($code -eq 3) { Write-Output 'Another supervisor is already running; exiting.'; exit 0 }
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 10 } else { $delay = [Math]::Min($delay * 2, 300) }
  Write-Warning "Supervisor exited with code $code; restarting in $delay s (see $errLog)"
  Start-Sleep -Seconds $delay
}
