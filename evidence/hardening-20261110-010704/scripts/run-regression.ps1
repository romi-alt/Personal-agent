# Phase F: full Windows regression on the exact commit checked out in the isolated clone. Sequential; never terminates
# any process other than the steps it started; waits (does not kill) when free memory is low.
param(
  [string]$Repo = 'E:\Agent\v2-staging\hardening\repo',
  [string]$Out = 'E:\Agent\v2-staging\hardening\20261110-010704\logs\regression',
  [int]$ProdPid = 8992,
  [int]$MinFreeMbToStart = 700
)
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:Path
New-Item -ItemType Directory -Force $Out | Out-Null
Set-Location $Repo
$summary = Join-Path $Out 'summary.txt'
function FreeMb { [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB) }
function ProdAlive { [bool](Get-Process -Id $ProdPid -ErrorAction SilentlyContinue) }
$head = (git rev-parse HEAD).Trim()
$dirty = (git status --porcelain | Measure-Object).Count
"start $(Get-Date -Format o) head=$head dirtyFiles=$dirty node=$(node --version) npm=$(npm --version) prodPid=$ProdPid prodAlive=$(ProdAlive)" | Set-Content -Encoding utf8 $summary

$steps = @(
  @{ n = '01-typecheck'; c = 'npm run typecheck' },
  @{ n = '02-lint'; c = 'npm run lint' },
  @{ n = '03-format-check'; c = 'npm run format:check' },
  @{ n = '04-build'; c = 'npm run build' },
  @{ n = '05-npm-audit-prod'; c = 'npm audit --omit=dev' },
  @{ n = '05b-npm-audit-all'; c = 'npm audit' },
  @{ n = '06-secret-scan'; c = 'node E:\Agent\v2-staging\hardening\20261110-010704\scripts\secret-scan.mjs' },
  @{ n = '07-unit'; c = "npx vitest run tests/unit --maxWorkers=2 --reporter=default --reporter=json --outputFile=$Out\07-unit.json" },
  @{ n = '08-integration'; c = "npx vitest run tests/integration --maxWorkers=2 --reporter=default --reporter=json --outputFile=$Out\08-integration.json" },
  @{ n = '09-e2e'; c = "npx vitest run tests/e2e --maxWorkers=1 --reporter=default --reporter=json --outputFile=$Out\09-e2e.json" },
  @{ n = '10-browser'; c = 'npm run test:browser' },
  @{ n = '11-probes-69'; c = 'npx tsx E:\Agent\v2-staging\hardening\20261110-010704\scripts\probe-compare.ts' },
  @{ n = '12-rule-k-matrix'; c = 'npx tsx E:\Agent\v2-staging\hardening\20261110-010704\scripts\rule-k-matrix.ts final-provider provider' },
  @{ n = '13-pr5-review-probes'; c = 'npx tsx E:\Agent\v2-staging\hardening\20261110-010704\scripts\pr5-review-probes.ts' }
)
foreach ($s in $steps) {
  $waited = 0
  while ((FreeMb) -lt $MinFreeMbToStart -and $waited -lt 900) { Start-Sleep -Seconds 15; $waited += 15 }
  $log = Join-Path $Out "$($s.n).log"
  $start = FreeMb; $t0 = Get-Date
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', "$($s.c) > `"$log`" 2>&1" -PassThru -WindowStyle Hidden
  $null = $p.Handle  # PS 5.1: cache the handle or ExitCode stays null
  $min = $start
  while (-not $p.HasExited) { Start-Sleep -Seconds 3; $f = FreeMb; if ($f -lt $min) { $min = $f } }
  $p.WaitForExit()
  $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $code = $p.ExitCode
  $tail = (Get-Content $log -ErrorAction SilentlyContinue | Where-Object { $_ -match 'Tests\s+\d|Test Files|passed|failed|vulnerabilit|probes=|current:|matches=|error TS|problems' } | Select-Object -Last 4) -join ' | '
  "{0} {1} exit={2} s={3} waitedForMemS={4} freeMb start={5} min={6} end={7} prodAlive={8} [{9}] {10}" -f $s.n, $(if ($code -eq 0) { 'PASS' } else { 'FAIL' }), $code, $secs, $waited, $start, $min, (FreeMb), (ProdAlive), $s.c, $tail | Add-Content -Encoding utf8 $summary
}
"end $(Get-Date -Format o) head=$((git rev-parse HEAD).Trim())" | Add-Content -Encoding utf8 $summary
