<#
.SYNOPSIS
  Runs INSIDE a Task Scheduler task and records what that context can see: user, session, PATH resolution, node,
  the Claude Code CLI version and whether its subscription login is readable. Writes a small JSON file.
  Never writes credentials: from `claude auth status --json` only loggedIn, authMethod, subscriptionType and
  loginExpiresAt are kept (no e-mail, organisation or token).
  Compatible with Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$RepoPath = '',
  [string]$NodePath = '',
  [string]$AgentHome = '',
  [string]$EnvFile = ''
)
$ErrorActionPreference = 'Continue'
if (-not $RepoPath) { $RepoPath = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if ($AgentHome) { $env:AGENT_HOME = $AgentHome }
if ($EnvFile) { $env:AGENT_ENV_FILE = $EnvFile }
$r = [ordered]@{
  at          = (Get-Date).ToString('o')
  user        = "$env:USERDOMAIN\$env:USERNAME"
  sessionId   = (Get-Process -Id $PID).SessionId
  interactive = [Environment]::UserInteractive
  cwd         = (Get-Location).Path
  localAppData = $env:LOCALAPPDATA
}
$claude = Get-Command claude -ErrorAction SilentlyContinue
$r.claudePath = $(if ($claude) { $claude.Source } else { $null })
if ($claude) {
  $r.claudeVersion = ((& $claude.Source --version) | Out-String).Trim()
  $raw = (& $claude.Source auth status --json) | Out-String
  try {
    $a = $raw | ConvertFrom-Json
    $r.auth = [ordered]@{ loggedIn = $a.loggedIn; authMethod = $a.authMethod; subscriptionType = $a.subscriptionType; loginExpiresAt = $a.loginExpiresAt }
  } catch { $r.auth = 'unparseable' }
}
if (-not $NodePath) { $n = Get-Command node -ErrorAction SilentlyContinue; if ($n) { $NodePath = $n.Source } }
$r.nodePath = $NodePath
if ($NodePath) {
  $r.nodeVersion = ((& $NodePath --version) | Out-String).Trim()
  Push-Location $RepoPath
  try {
    $env:EXECUTION_PROVIDER = 'claude-cli'
    $ps = (& $NodePath (Join-Path $RepoPath 'dist\cli\index.js') provider:status 2>&1) | Out-String
    $r.providerStatusExit = $LASTEXITCODE
    # Keep only lines that cannot carry personal data (readiness, version, variable NAMES).
    $r.providerStatus = @($ps -split "`r?`n" | Where-Object { $_ -match '(?i)ready|version|watchdog|stripped|CLAUDE_CODE_|provider' -and $_ -notmatch '@' })
  } finally { Pop-Location }
}
$r | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Out -Encoding UTF8
