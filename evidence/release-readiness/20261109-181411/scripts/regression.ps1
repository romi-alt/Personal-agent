# Bounded, memory-guarded Windows regression of the release in an isolated clean clone.
# Never touches E:\Agent\Personal-agent or %LOCALAPPDATA%\ElevariqAgent. Isolated AGENT_HOME; no .env in the clone.
param([string]$Repo = 'E:\Agent\v2-staging\rr\v2-e60278f', [string]$Out, [int]$GuardMb = 350)
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;$env:Path"
$env:AGENT_HOME = 'E:\Agent\v2-staging\rr\home-regression'; $env:AGENT_ENV_FILE = 'E:\Agent\v2-staging\rr\none.env'
$env:EXECUTION_PROVIDER = 'mock'; $env:ENVIRONMENT = 'test'; $env:INTEGRATION_ERP_ENABLED = 'false'; $env:INTEGRATION_CRM_ENABLED = 'false'
Remove-Item env:NOTIFY_WEBHOOK_URL -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Out, $env:AGENT_HOME | Out-Null
$sum = "$Out\summary.txt"
function Rec([string]$s) { Add-Content -Encoding utf8 $sum $s; Write-Host $s }
Add-Type -Namespace R -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][R.P]::SetThreadExecutionState([uint32]'0x80000001')
Set-Location $Repo
$prodPid = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'Personal-agent\\dist\\cli\\index.js" start' } | Select-Object -First 1).ProcessId
Rec ("start {0:o} head={1} node={2} npm={3} prodSupervisorPid={4}" -f (Get-Date), (git rev-parse HEAD), (node -v), (npm -v), $prodPid)
function AvailMb { [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB) }
function TreeMb {
  $ps = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($Repo) -or ($_.Name -match 'msedge' -and $_.CommandLine -match 'playwright') }
  [pscustomobject]@{ mb = [math]::Round((($ps | Measure-Object WorkingSetSize -Sum).Sum) / 1MB); n = @($ps).Count }
}
function Step([string]$name, [string]$cmd, [int]$deadlineSec) {
  $t0 = Get-Date; $lf = "$Out\$name.log"
  $a0 = AvailMb; $min = $a0; $peakTree = 0; $peakN = 0; $low = 0; $state = $null
  $p = Start-Process cmd.exe -ArgumentList "/d /s /c `"$cmd > `"$lf`" 2>&1`"" -WorkingDirectory $Repo -NoNewWindow -PassThru
  $null = $p.Handle
  while (-not $p.WaitForExit(3000)) {
    $a = AvailMb; if ($a -lt $min) { $min = $a }
    $t = TreeMb; if ($t.mb -gt $peakTree) { $peakTree = $t.mb }; if ($t.n -gt $peakN) { $peakN = $t.n }
    if ($a -lt $GuardMb) { $low++ } else { $low = 0 }
    if ($low -ge 4) { $state = 'ABORTED-MEMORY-GUARD'; break }
    if (((Get-Date) - $t0).TotalSeconds -gt $deadlineSec) { $state = 'TIMEOUT'; break }
  }
  if ($state) { Get-Content $lf -Tail 40 | Out-File -Encoding utf8 "$Out\$name.abort-tail.txt"; & taskkill.exe /T /F /PID $p.Id | Out-Null; $c = $null }
  else { $c = $p.ExitCode; $state = if ($c -eq 0) { 'PASS' } else { 'FAIL' } }
  $tail = (Get-Content $lf -ErrorAction SilentlyContinue | Select-String -Pattern 'Test Files|Tests  |passed|failed|skipped|vulnerabilit' | Select-Object -Last 4 | ForEach-Object { $_.Line.Trim() }) -join ' | '
  $prodAlive = [bool](Get-Process -Id $prodPid -ErrorAction SilentlyContinue)
  Rec ("{0} {1} exit={2} s={3:N1} availMb start={4} min={5} end={6} peakTreeMb={7} peakProcs={8} prodAlive={9} [{10}] {11}" -f $name, $state, $c, ((Get-Date) - $t0).TotalSeconds, $a0, $min, (AvailMb), $peakTree, $peakN, $prodAlive, $cmd, $tail)
}
Step '00-npm-ci'        'npm ci --no-audit --no-fund' 900
Step '01-typecheck'     'npm run typecheck' 600
Step '02-lint'          'npm run lint' 600
Step '03-format-check'  'npm run format:check' 300
Step '04-build'         'npm run build' 600
Step '05-npm-audit-prod' 'npm audit --omit=dev' 300
Step '05b-npm-audit-all' 'npm audit' 300
# CI secret scan (same regex as scripts/ci-local.mjs) over tracked files excluding tests/
$re = 'sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH )?PRIVATE KEY'
$files = git ls-files -- . ':!tests'; $hits = @($files | Where-Object { Test-Path $_ -PathType Leaf } | Where-Object { Select-String -Path $_ -Pattern $re -Quiet })
$hitsAll = @(git ls-files | Where-Object { Test-Path $_ -PathType Leaf } | Where-Object { Select-String -Path $_ -Pattern $re -Quiet })
Rec ("06-secret-scan {0} files={1} matches={2} [{3}] matchesIncludingTests={4} [{5}]" -f $(if ($hits.Count -eq 0) { 'PASS' } else { 'FAIL' }), @($files).Count, $hits.Count, ($hits -join ','), $hitsAll.Count, ($hitsAll -join ','))
Step '07-unit'          "npx vitest run tests/unit --maxWorkers=2 --reporter=default --reporter=json --outputFile=`"$Out\07-unit.json`"" 1800
Step '08-integration'   "npx vitest run tests/integration --maxWorkers=2 --reporter=default --reporter=json --outputFile=`"$Out\08-integration.json`"" 2400
Step '09-e2e'           "npx vitest run tests/e2e --maxWorkers=1 --reporter=default --reporter=json --outputFile=`"$Out\09-e2e.json`"" 1800
Step '10-browser'       'npm run test:browser' 1200
Rec ("end {0:o}" -f (Get-Date))
[void][R.P]::SetThreadExecutionState([uint32]'0x80000000')
