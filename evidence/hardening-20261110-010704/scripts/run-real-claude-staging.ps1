# Phase G: ONE genuine Claude Code staging task through the V2.1 candidate (dist of the checked-out commit).
# Isolation from production: separate AGENT_HOME (own DB, workspaces, logs, run dir), separate env file, separate
# dashboard port, backups/notifications off, single worker. Uses the owner's existing Claude Code login AS-IS via the
# `claude` executable; this script never reads, prints or copies credential material, and does not touch the
# production DB, queue, checkout, scheduled task or supervisor (pid checked before/after).
param(
  [string]$Ev = 'E:\Agent\v2-staging\hardening\20261110-010704',
  [string]$Repo = 'E:\Agent\v2-staging\hardening\repo',
  [int]$ProdPid = 8992,
  [int]$TimeoutMin = 40
)
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:Path
$stg = Join-Path $Ev 'staging'
$agentHome = Join-Path $stg 'agent-home'
$log = Join-Path $stg 'driver.log'
if (Test-Path $agentHome) { throw "staging home already exists: $agentHome (refusing to reuse)" }
New-Item -ItemType Directory -Force $agentHome | Out-Null
function L($m) { $line = "$(Get-Date -Format o) $m"; Add-Content -Encoding utf8 $log $line; Write-Output $line }
# Process-scoped configuration (this PowerShell process and its children only).
$env:AGENT_HOME = $agentHome
$env:AGENT_ENV_FILE = Join-Path $stg 'staging.env'
$env:EXECUTION_PROVIDER = 'claude-cli'
$env:ENVIRONMENT = 'development'
$env:CLAUDE_MODEL = 'sonnet'
$env:DASHBOARD_PORT = '4417'
$env:HEALTH_PORT = '0'
$env:BACKUP_INTERVAL_HOURS = '0'
$env:MAX_CONCURRENT_WORKERS = '1'
$env:INDEPENDENT_REVIEW = 'true'
$env:LOG_TO_CONSOLE = 'false'
$env:MAX_TURNS_PER_EXECUTION = '40'
# STAGING ONLY (production keeps 1024/1536): this host has ~1.0-1.4 GB free, which would defer staging indefinitely.
$env:MIN_FREE_MEMORY_MB = '450'
$env:RESUME_FREE_MEMORY_MB = '600'
Remove-Item Env:NOTIFY_WEBHOOK_URL -ErrorAction SilentlyContinue
Set-Location $stg
$cli = Join-Path $Repo 'dist\cli\index.js'
L "head=$((git -C $Repo rev-parse HEAD).Trim()) prodAlive=$([bool](Get-Process -Id $ProdPid -ErrorAction SilentlyContinue)) home=$agentHome"
L "claude=$((Get-Command claude -ErrorAction SilentlyContinue).Source) version=$(claude --version 2>$null)"
node $cli provider:status *>> (Join-Path $stg 'provider-status.log'); L "provider:status exit=$LASTEXITCODE"
node $cli assignment:add --file (Join-Path $stg 'assignment.json') *>> (Join-Path $stg 'assignment-add.log'); L "assignment:add exit=$LASTEXITCODE"
$q = Join-Path $Ev 'scripts\staging-query.cjs'; $db = Join-Path $agentHome 'agent.db'
$proj = (node $q $db projects | ConvertFrom-Json) | Select-Object -First 1
if (-not $proj) { L 'no project registered'; throw 'no project' }
$pid0 = $proj.id; L "project=$pid0 repo=$($proj.repoPath)"
$instr = @'
Implement a small zero-dependency TypeScript utility in this repository (it may be empty).
1. package.json with {"name":"staging-slugify","private":true,"type":"module","scripts":{"test":"node --test"}}.
2. src/slugify.ts exporting `slugify(text: string): string`: lower-case; replace every run of characters that are not
   a-z or 0-9 with a single hyphen; trim leading and trailing hyphens. Throw a TypeError when the argument is not a string.
3. test/slugify.test.ts using node:test and node:assert/strict (import from '../src/slugify.ts'): normal text, repeated
   separators, leading/trailing punctuation, digits, empty string, and the TypeError case.
4. Run `node --test` and `node --check src/slugify.ts` and make sure both pass. Node 26 runs .ts files natively; do not
   install anything and do not use the network.
5. Commit your work with git on the current branch (git add, git commit). Do not push; there is no remote.
'@
$crit = 'slugify implemented per FR-1/FR-2; tests cover normal text, repeated separators, trimming, digits, empty string and TypeError; node --test passes; work committed'
node $cli task:add --project $pid0 --title 'Implement slugify utility with tests' --instructions $instr --criteria $crit *>> (Join-Path $stg 'task-add.log'); L "task:add exit=$LASTEXITCODE"
# Supervisor in the background (single worker).
$sup = Start-Process -FilePath 'node' -ArgumentList "`"$cli`"", 'start' -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stg 'supervisor.out.log') -RedirectStandardError (Join-Path $stg 'supervisor.err.log')
$null = $sup.Handle
L "staging supervisor pid=$($sup.Id)"
$deadline = (Get-Date).AddMinutes($TimeoutMin)
$final = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 30
  $free = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB)
  $tasks = node $q $db tasks | ConvertFrom-Json; $qa = node $q $db qa
  $summary = ($tasks | ForEach-Object { "$($_.title.Substring(0, [Math]::Min(30, $_.title.Length)))=$($_.status)" }) -join '; '
  L "freeMb=$free prodAlive=$([bool](Get-Process -Id $ProdPid -ErrorAction SilentlyContinue)) supAlive=$(-not $sup.HasExited) tasks: $summary qa: $qa"
  $open = @($tasks | Where-Object { $_.status -notin @('COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'WAITING_FOR_APPROVAL') })
  if ($tasks -and $open.Count -eq 0) { $final = $summary; break }
  if ($sup.HasExited) { L "supervisor exited code=$($sup.ExitCode)"; break }
}
L "final: $final"
node $cli stop --wait 60000 *>> (Join-Path $stg 'stop.log'); L "stop exit=$LASTEXITCODE"
$sup.WaitForExit(90000) | Out-Null
L "staging supervisor exited=$($sup.HasExited) code=$($sup.ExitCode) prodAlive=$([bool](Get-Process -Id $ProdPid -ErrorAction SilentlyContinue))"

