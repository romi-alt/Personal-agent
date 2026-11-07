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
  <AGENT_HOME>\logs\supervisor-stdout.log / supervisor-stderr.log, truncated when larger than 5 MB at each (re)start,
  and records its own start/exit/restart decisions in <AGENT_HOME>\logs\wrapper.log.
  Secrets: NOT stored here. Use user-level environment variables or the untracked .env in the repo folder.
  Compatible with Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [string]$RepoPath = '',
  [string]$NodePath = '',
  [string]$AgentHome = '',
  [string]$EnvFile = ''
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 leaves $PSScriptRoot empty inside param() defaults, so resolve it here.
if (-not $RepoPath) { $RepoPath = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }

if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'node.exe not found on PATH. Install Node.js 22.12+ or pass -NodePath.' }
  $NodePath = $cmd.Source
}
$entry = Join-Path $RepoPath 'dist\cli\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw "Build first: npm ci; npm run build  (missing $entry)" }

if ($AgentHome) { $env:AGENT_HOME = $AgentHome }
if ($EnvFile) { $env:AGENT_ENV_FILE = $EnvFile }
# Same default as the application (src/config): %LOCALAPPDATA%\ElevariqAgent unless AGENT_HOME is set.
$agentHome = $env:AGENT_HOME
if (-not $agentHome) { $agentHome = Join-Path $env:LOCALAPPDATA 'ElevariqAgent' }
$logDir = Join-Path $agentHome 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir 'supervisor-stdout.log'
$errLog = Join-Path $logDir 'supervisor-stderr.log'
$wrapLog = Join-Path $logDir 'wrapper.log'
function Log([string]$msg) {
  $line = '{0} [wrapper pid {1}] {2}' -f (Get-Date).ToString('o'), $PID, $msg
  Add-Content -LiteralPath $wrapLog -Value $line -Encoding UTF8
}

# The app already writes structured logs to files; do not also stream them to an unbounded stderr capture.
if (-not $env:LOG_TO_CONSOLE) { $env:LOG_TO_CONSOLE = 'false' }

# The supervisor resolves ".env" relative to the working directory.
Set-Location -LiteralPath $RepoPath
Log "start repo=$RepoPath node=$NodePath home=$agentHome user=$env:USERDOMAIN\$env:USERNAME"

$holdFile = Join-Path $agentHome 'STOP-HOLD'
$delay = 10
while ($true) {
  # The owner stopped the agent with `stop --hold`: do not restart it (keepalive/logon triggers included).
  if (Test-Path -LiteralPath $holdFile) { Log "STOP-HOLD present ($holdFile); not starting"; exit 0 }
  foreach ($f in @($outLog, $errLog)) {
    if ((Test-Path -LiteralPath $f) -and ((Get-Item -LiteralPath $f).Length -gt 5MB)) { Remove-Item -LiteralPath $f -Force }
  }
  if ((Test-Path -LiteralPath $wrapLog) -and ((Get-Item -LiteralPath $wrapLog).Length -gt 5MB)) { Remove-Item -LiteralPath $wrapLog -Force }
  $started = Get-Date
  # Start-Process avoids Windows PowerShell 5.1 turning native stderr output into terminating errors.
  $p = Start-Process -FilePath $NodePath -ArgumentList @("`"$entry`"", 'start') -WorkingDirectory $RepoPath `
        -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  # Caching the handle is required in Windows PowerShell 5.1, otherwise ExitCode can be empty after WaitForExit.
  $null = $p.Handle
  Log "supervisor launched pid=$($p.Id)"
  $p.WaitForExit()
  $code = $p.ExitCode
  Log "supervisor pid=$($p.Id) exited code=$code"
  if ($code -eq 0) { Log 'graceful stop; wrapper exiting'; exit 0 }
  if ($code -eq 2) { Log "invalid configuration; not restarting (see $errLog)"; exit 2 }
  if ($code -eq 3) {
    # Another supervisor holds the lease (e.g. this wrapper's predecessor was killed but its supervisor survived).
    # Keep watching it so a later crash is still restarted; exit only when it stops gracefully.
    Log 'another supervisor is already live; monitoring it'
    while ($true) {
      Start-Sleep -Seconds 30
      $json = & $NodePath $entry status --json 2>$null | Out-String
      try { $s = $json | ConvertFrom-Json } catch { $s = $null }
      if ($s -and -not $s.supervisor.live) {
        if ($s.supervisor.status -eq 'STOPPED') { Log 'monitored supervisor stopped gracefully; wrapper exiting'; exit 0 }
        Log "monitored supervisor is gone (status=$($s.supervisor.status)); taking over"
        break
      }
    }
    $delay = 10
    continue
  }
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 10 } else { $delay = [Math]::Min($delay * 2, 300) }
  Log "restarting in $delay s"
  Start-Sleep -Seconds $delay
}
