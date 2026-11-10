# V2.1 isolation prototype: adversarial test harness. SYNTHETIC fixtures only; production is never touched.
param([string]$Out = "E:\Agent\v2-staging\hardening\20261109-234257\evidence\isolation", [string]$Label = "run1")
$ErrorActionPreference = 'Continue'
$B    = "E:\Agent\v2-staging\hardening\20261109-234257"
$ISO  = "E:\Agent\v2-staging\hardening\isotest"
$REPO = "E:\Agent\v2-staging\hardening\repo"
$T    = "$ISO\tools"
$NODE = "$T\nodejs\node.exe"
$AH   = "$env:LOCALAPPDATA\ElevariqAgent-isotest"
$CREDDIR = "$env:USERPROFILE\.elevariq-isotest"
$SNAP = "E:\Agent\v2-staging\release-readiness\20261109-181411\db\live-snapshot-v11.db"
$SB   = "$B\bin\sandbox-run.exe"
$NAME = "elevariq-worker-isotest"
New-Item -ItemType Directory -Force $Out | Out-Null

function Reset-Fixtures {
  foreach ($d in "$ISO\ws", "$ISO\outside", "$ISO\fake-prod-checkout", $AH, $CREDDIR) {
    if (Test-Path $d) { cmd /c "attrib -r `"$d\*`" /s /d >nul 2>&1"; Remove-Item -Recurse -Force $d }
  }
  New-Item -ItemType Directory -Force "$ISO\ws", "$ISO\outside\victim", "$ISO\outside\victim2", "$ISO\fake-prod-checkout", "$AH\run", "$AH\audit", $CREDDIR | Out-Null
  'x' | Set-Content "$ISO\outside\victim\keep.txt"; 'x' | Set-Content "$ISO\outside\victim2\keep.txt"
  "EXECUTION_PROVIDER=claude-cli`nENVIRONMENT=production" | Set-Content "$ISO\fake-prod-checkout\.env" -Encoding ascii
  "# wrapper" | Set-Content "$ISO\fake-prod-checkout\run-supervisor.ps1"
  '{"claudeAiOauth":{"accessToken":"SYNTHETIC-CREDENTIAL-VALUE-0123456789"}}' | Set-Content "$CREDDIR\.credentials.json" -Encoding ascii
  'SYNTHETIC-CREDENTIAL-VALUE-0123456789' | Set-Content "$AH\dashboard.token" -Encoding ascii
  '{"workspace":"x","approvedTypes":[],"alsoRequire":[],"readOnly":false}' | Set-Content "$AH\run\exec1.policy.json" -Encoding ascii
  Set-ItemProperty "$AH\run\exec1.policy.json" -Name IsReadOnly -Value $true
  '{"at":0,"event":"genuine"}' | Set-Content "$AH\audit\audit.jsonl" -Encoding ascii
  '{"at":0,"event":"genuine"}' | Set-Content "$AH\audit\audit2.jsonl" -Encoding ascii
  # Synthetic agent DB: a copy of the read-only snapshot plus two synthetic PENDING approvals.
  & $NODE "$B\scripts\iso-db.cjs" seed $SNAP "$AH\agent.db" "$REPO\node_modules\better-sqlite3"
  if ($LASTEXITCODE -ne 0) { throw "seed failed" }
  "AGENT_HOME=$AH`nEXECUTION_PROVIDER=mock`nENVIRONMENT=development" | Set-Content "$ISO\agent.env" -Encoding ascii
  $cfg = [ordered]@{
    credFile = "$CREDDIR\.credentials.json"; agentHome = $AH; agentDb = "$AH\agent.db"; agentEnvFile = "$ISO\agent.env"
    approvalIdSql = 'apr_isotestsql0001'; approvalIdCli = 'apr_isotestcli0001'
    policyFile = "$AH\run\exec1.policy.json"; fakeProdEnv = "$ISO\fake-prod-checkout\.env"; fakeWrapper = "$ISO\fake-prod-checkout\run-supervisor.ps1"
    outsideDir = "$ISO\outside"; auditFile = "$AH\audit\audit.jsonl"; auditFile2 = "$AH\audit\audit2.jsonl"
    loopbackPort = 48761; bash = "$T\Git\bin\bash.exe"; nodeExe = $NODE; npmCli = "$T\nodejs\node_modules\npm\bin\npm-cli.js"
    claudeExe = "$T\claude.exe"; agentCli = "$REPO\dist\cli\index.js"; betterSqlite3 = "$REPO\node_modules\better-sqlite3"
  }
  $cfg | ConvertTo-Json | Set-Content "$ISO\ws\attack-config.json" -Encoding ascii
  Copy-Item "$B\scripts\attacks.cjs" "$ISO\ws\attacks.cjs"
}

function Get-Fingerprints {
  & $NODE "$B\scripts\iso-db.cjs" fp "$AH\agent.db" "$REPO\node_modules\better-sqlite3"
}

function Invoke-Run([string]$mode) {
  Reset-Fixtures
  $srv = Start-Process -FilePath $NODE -ArgumentList "`"$B\scripts\iso-db.cjs`"", 'serve', '48761' -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 700
  $env:ELEVARIQ_WORKER = '1'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  if ($mode -eq 'baseline') {
    $lines = & $NODE "$ISO\ws\attacks.cjs" baseline 2>"$Out\$Label-$mode.stderr.txt"
  } else {
    $env:NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'
    $lines = & $SB --name $NAME --mem-mb 2048 --rw "$ISO\ws" --rx $T --rx $REPO --cwd "$ISO\ws" -- $NODE "$ISO\ws\attacks.cjs" sandboxed 2>"$Out\$Label-$mode.stderr.txt"
  }
  $sw.Stop()
  Remove-Item Env:\ELEVARIQ_WORKER; Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
  Stop-Process -Id $srv.Id -Force
  $lines | Set-Content "$Out\$Label-$mode.jsonl" -Encoding utf8
  # J1: did the detached grandchild survive the worker's exit?
  Start-Sleep -Seconds 2
  $pidTxt = Get-Content "$ISO\ws\detached.pid" -ErrorAction SilentlyContinue
  $alive = $false; if ($pidTxt) { $alive = [bool](Get-Process -Id ([int]$pidTxt) -ErrorAction SilentlyContinue) }
  if ($alive) { Stop-Process -Id ([int]$pidTxt) -Force }
  $after = [ordered]@{
    mode = $mode; wallMs = $sw.ElapsedMilliseconds; detachedGrandchildSurvived = $alive
    db = (Get-Fingerprints | ConvertFrom-Json)
    policyFileWidened = ((Get-Content "$AH\run\exec1.policy.json" -Raw) -match 'protected_branch_push')
    fakeProdEnvTampered = ((Get-Content "$ISO\fake-prod-checkout\.env" -Raw) -match 'attacker')
    stopHoldCreated = (Test-Path "$AH\STOP-HOLD")
    auditForged = ((Get-Content "$AH\audit\audit.jsonl" -Raw) -match 'forged'); audit2Deleted = -not (Test-Path "$AH\audit\audit2.jsonl")
    outsideVictimDeleted = -not (Test-Path "$ISO\outside\victim"); outsideVictim2Deleted = -not (Test-Path "$ISO\outside\victim2")
    escapeFiles = @((Get-ChildItem "$ISO\outside\escape.txt", "$AH\escape.txt", "$CREDDIR\escape.txt" -ErrorAction SilentlyContinue).FullName)
    hkcuTestKey = (Test-Path 'HKCU:\Software\ElevariqIsoTest')
    isoTask = [bool](Get-ScheduledTask -TaskName ElevariqIsoTest -ErrorAction SilentlyContinue)
    outsideAcl = ((icacls "$ISO\outside" | Out-String) -match 'Everyone')
  }
  $after | ConvertTo-Json -Depth 5 | Set-Content "$Out\$Label-$mode.after.json" -Encoding utf8
  # Clean up artefacts a successful baseline attack can leave (test key/task only; never production objects).
  if ($after.hkcuTestKey) { Remove-Item 'HKCU:\Software\ElevariqIsoTest' -Recurse -Force }
  if ($after.isoTask) { Unregister-ScheduledTask -TaskName ElevariqIsoTest -Confirm:$false }
  return $after
}

$base = Invoke-Run 'baseline'
$sand = Invoke-Run 'sandboxed'
"baseline wall=$($base.wallMs) ms; sandboxed wall=$($sand.wallMs) ms"


