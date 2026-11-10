# Phase E + F + G(gate): realistic migration, staging deployment and rollback rehearsal on a VERIFIED COPY of the
# production pre-upgrade backup. Never opens %LOCALAPPDATA%\ElevariqAgent\agent.db, never runs anything from
# E:\Agent\Personal-agent, never touches the production scheduled task. Mock provider, no .env, integrations off.
# Every supervisor started here is recorded by PID; only those PIDs are ever stopped.
param(
  [string]$V2 = 'E:\Agent\v2-staging\rr\v2-e60278f\dist\cli\index.js',
  [string]$V1 = 'E:\Agent\v2-staging\rr\v1-1b07468\dist\cli\index.js',
  [string]$S = 'E:\Agent\v2-staging\rr\stage',
  [string]$Ev
)
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;$env:Path"
if (Test-Path $S) { throw "refusing to reuse $S" }
$home2 = "$S\home"; $wsRoot = "$S\workspaces"
New-Item -ItemType Directory -Force $home2, $wsRoot, $Ev, "$S\golden" | Out-Null
$FP = 'E:\Agent\v2-staging\release-readiness\20261109-181411\scripts\fp.cjs'
$log = "$Ev\rehearsal.log"
function Rec([string]$s) { Add-Content -Encoding utf8 $log $s; Write-Host $s }
$PROD_BACKUP = "$env:LOCALAPPDATA\ElevariqAgent\backups\agent-2026-11-09T13-07-14-592Z.db"
$PROD_BACKUP_SHA = 'B7ED5834716D6B224C32D04D7C0884DAA7E4BF76B91E42DF120AA7EE4FE0ED22'
$LIVE_SNAPSHOT = 'E:\Agent\v2-staging\release-readiness\20261109-181411\db\live-snapshot-v11.db'
$bundle = 'E:\Agent\pilot-evidence\elevariq-retail-operations-portal\closeout\elevariq-retail-operations-portal.bundle'
$scenario = @{ tasks = @{
  'Feature A' = @(@{ type = 'success'; writes = @(@{ file = 'src/a.ts'; content = "// a`n// b`n// c`n" }) })
  'Review: Feature A' = @(@{ type = 'success'; summary = '{"criteria":[{"id":"AC1","met":true,"evidence":[{"file":"src/a.ts","line":2}],"note":"ok"}],"defects":[],"testsAssessment":"ok"}' })
  'Flaky B' = @('crash', @{ type = 'success'; writes = @(@{ file = 'src/b.ts'; content = "// b`n// b`n" }) })
  'Review: Flaky B' = @(@{ type = 'success'; summary = '{"criteria":[{"id":"AC1","met":false,"evidence":[],"note":"b.ts lacks the export"}],"defects":[{"severity":"medium","description":"missing export"}],"testsAssessment":"weak"}' }, @{ type = 'success'; summary = '{"criteria":[{"id":"AC1","met":true,"evidence":[{"file":"src/b.ts","line":1}],"note":"ok"}],"defects":[],"testsAssessment":"ok"}' })
  'Fatal C' = @('fatal')
  'Deploy E' = @('permission_denied')
  'Long D' = @('hang', @{ type = 'success'; writes = @(@{ file = 'src/d.ts'; content = "// d`n// d`n" }) })
  'Review: Long D' = @(@{ type = 'success'; summary = '{"criteria":[{"id":"AC1","met":true,"evidence":[{"file":"src/d.ts","line":1}],"note":"ok"}],"defects":[],"testsAssessment":"ok"}' })
  'Gate G' = @(@{ type = 'success'; writes = @(@{ file = 'src/g.ts'; content = "// g`n" }) })
  'Review: Gate G' = @(@{ type = 'success'; summary = '{"criteria":[{"id":"AC1","met":true,"evidence":[{"file":"src/g.ts","line":1}],"note":"ok"}],"defects":[],"testsAssessment":"ok"}' })
} }
$scenario | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 "$S\scenario.json"
$envs = @{
  AGENT_HOME = $home2; AGENT_ENV_FILE = "$S\none.env"; WORKSPACE_ROOT = $wsRoot; EXECUTION_PROVIDER = 'mock'
  MOCK_SCENARIO_FILE = "$S\scenario.json"; ENVIRONMENT = 'test'; LOG_TO_CONSOLE = 'false'; HEALTH_PORT = '0'
  DASHBOARD_PORT = '4419'; INTEGRATION_ERP_ENABLED = 'false'; INTEGRATION_CRM_ENABLED = 'false'; NODE_NO_WARNINGS = '1'
  POLL_INTERVAL_MS = '300'; HEARTBEAT_INTERVAL_MS = '500'; LEASE_TTL_MS = '3000'; BACKOFF_BASE_MS = '1000'
  BACKOFF_MAX_MS = '3000'; BACKOFF_JITTER = '0'; MIN_FREE_MEMORY_MB = '0'; RESUME_FREE_MEMORY_MB = '0'; BACKUP_INTERVAL_HOURS = '0'
}
foreach ($k in $envs.Keys) { Set-Item "env:$k" $envs[$k] }
Remove-Item env:NOTIFY_WEBHOOK_URL, env:ELEVARIQ_WORKER -ErrorAction SilentlyContinue
Set-Location $S
$prodSup = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'Personal-agent\\dist\\cli\\index.js" start' } | Select-Object -First 1
$prodPid = $prodSup.ProcessId; $prodStart = $prodSup.CreationDate
$prodTask0 = Get-ScheduledTask -TaskName ElevariqPersonalAgent | Export-ScheduledTask
$owned = New-Object System.Collections.ArrayList
function Agent([string]$name, [string]$cli, [string[]]$a, [int]$timeoutSec = 180) {
  $o = "$Ev\$name.txt"; $t0 = Get-Date
  $p = Start-Process node -ArgumentList (@("`"$cli`"") + $a) -WorkingDirectory $S -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError "$o.err"
  $null = $p.Handle
  if (-not $p.WaitForExit($timeoutSec * 1000)) { & taskkill /T /F /PID $p.Id | Out-Null; Rec "$name TIMEOUT"; return -1 }
  $ver = if ($cli -eq $V1) { 'V1' } else { 'V2' }
  Rec ("{0} exit={1} ms={2:N0} [{3} {4}]" -f $name, $p.ExitCode, ((Get-Date) - $t0).TotalMilliseconds, $ver, ($a -join ' '))
  return $p.ExitCode
}
function FP([string]$name, [string]$db = "$home2\agent.db", [string[]]$extra = @()) {
  node $FP $db @extra | Out-File -Encoding utf8 "$Ev\$name.json"; Get-Content "$Ev\$name.json" -Raw | ConvertFrom-Json
}
function StartSup([string]$name, [string]$cli = $V2) {
  Agent $name $cli @('start', '--detach') 60 | Out-Null
  $m = [regex]::Match((Get-Content "$Ev\$name.txt" -Raw), 'pid (\d+)'); $pidv = [int]$m.Groups[1].Value
  [void]$owned.Add($pidv); Rec "$name supervisor pid=$pidv (recorded, rehearsal-owned)"; return $pidv
}
function WaitFor([scriptblock]$cond, [int]$sec, [string]$what) {
  $t0 = Get-Date; $end = $t0.AddSeconds($sec)
  while ((Get-Date) -lt $end) { if (& $cond) { Rec ("  reached in {0:N1}s: {1}" -f ((Get-Date) - $t0).TotalSeconds, $what); return $true }; Start-Sleep -Milliseconds 700 }
  Rec "  TIMEOUT ($sec s) waiting for: $what"; return $false
}
function Poll { node $FP "$home2\agent.db" --limits "$Ev\limits.json" | ConvertFrom-Json }
function T([string]$title) { ((Poll).newTasks | Where-Object { $_.title -eq $title } | Select-Object -First 1).status }
function SupMb([int]$p) { $x = Get-Process -Id $p -ErrorAction SilentlyContinue; if ($x) { [math]::Round($x.WorkingSet64 / 1MB) } else { $null } }
function Cmp($a, $b, [string]$label, [string[]]$tables) {
  $ok = $true
  foreach ($t in $tables) { $eq = $a.fingerprints.$t -eq $b.fingerprints.$t; if (-not $eq) { $ok = $false }; Rec ("  {0} {1,-22} {2} vs {3} equal={4}" -f $label, $t, $a.fingerprints.$t, $b.fingerprints.$t, $eq) }
  return $ok
}
$HIST = 'projects','tasks','executions','checkpoints','approvals','qa_reviews','task_transitions','verification_evidence','assignments','plan_tasks','requirements','task_outputs','project_documents','adrs','workflow_runs','workflow_steps'
Rec ("start {0:o} V2={1} V1={2} prodSupervisorPid={3} started={4}" -f (Get-Date), (git -C (Split-Path (Split-Path (Split-Path $V2))) rev-parse --short HEAD), (git -C (Split-Path (Split-Path (Split-Path $V1))) rev-parse --short HEAD), $prodPid, $prodStart)

# ---------------- E1-E3: verified copy of the production pre-upgrade backup ----------------
$t0 = Get-Date; Copy-Item $PROD_BACKUP "$S\golden\v8-preupgrade.db"; $copyMs = ((Get-Date) - $t0).TotalMilliseconds
$h = (Get-FileHash "$S\golden\v8-preupgrade.db").Hash
Rec ("E1 golden copy of production pre-upgrade backup: sha256={0} expected={1} match={2} copyMs={3:N0}" -f $h, $PROD_BACKUP_SHA, ($h -eq $PROD_BACKUP_SHA), $copyMs)
if ($h -ne $PROD_BACKUP_SHA) { Rec 'ABORT: golden copy hash mismatch'; exit 2 }
$g = FP 'E2-golden-v8' "$S\golden\v8-preupgrade.db"
Rec ("E2 golden integrity={0} fk={1} versions={2} tasks={3} approvals={4} executions={5}" -f $g.integrity, $g.fkViolations, ($g.versions -join ' '), $g.counts.tasks, $g.counts.approvals, $g.counts.executions)
Copy-Item "$S\golden\v8-preupgrade.db" "$home2\agent.db"
# separate staging workspace for the pilot project (so nothing points at production paths)
git clone --quiet $bundle "$wsRoot\elevariq-retail-operations-portal" 2>$null
node -e "const D=require('module').createRequire('E:/Agent/pa-v2-integrate/package.json')('better-sqlite3');const d=new D(process.argv[1]);console.log('repointed',d.prepare('UPDATE projects SET repo_path=?').run(process.argv[2]).changes);console.log('supervisor_state neutralised',d.prepare('UPDATE supervisor_state SET pid=999999, heartbeat_at=0, status=?').run('STOPPED').changes);d.close()" "$home2\agent.db" "$wsRoot\elevariq-retail-operations-portal" | Out-File -Append -Encoding utf8 $log
$base = FP 'E3-baseline-v8' "$home2\agent.db" @('--save-limits', "$Ev\limits-v8.json")
Rec ("E3 staging baseline versions={0} schemaHash={1}" -f ($base.versions -join ' '), $base.schemaHash)

# ---------------- E4: pre-upgrade backup with V1's own tool (timed) ----------------
Agent 'E4-v1-backup' $V1 @('backup', '--path', "`"$home2\pre-v2-backup`"") 180 | Out-Null
$bk = Get-ChildItem "$home2\pre-v2-backup" -Filter *.db | Select-Object -First 1
Agent 'E4-v1-backup-verify' $V1 @('backup:verify', "`"$($bk.FullName)`"") | Out-Null
Rec "E4 pre-v2 backup $($bk.Name) bytes=$($bk.Length) sha256=$((Get-FileHash $bk.FullName).Hash)"

# ---------------- E5-E7: V2 migration (timed) + verification ----------------
Agent 'E5-v2-doctor-migrate' $V2 @('doctor') 180 | Out-Null
$mig = FP 'E5-after-migration'
Rec ("E5 versions={0} integrity={1} fk={2} dupNames={3} qa_review_tasks={4}" -f ($mig.versions -join ' '), $mig.integrity, $mig.fkViolations, @($mig.duplicateMigrationNames).Count, $mig.qaReviewTasks)
$newObjs = @($mig.objects | Where-Object { $base.objects -notcontains $_ }); $lostObjs = @($base.objects | Where-Object { $mig.objects -notcontains $_ })
Rec ("E6 schema objects added={0} removed={1}" -f ($newObjs -join ','), ($lostObjs -join ','))
$e7 = Cmp $base $mig 'E7 history' $HIST
Rec "E7 all history fingerprints intact after migration: $e7"
# fresh V2 install schema vs migrated schema vs live production snapshot schema
$freshHome = "$S\fresh-home"; New-Item -ItemType Directory -Force $freshHome | Out-Null
$env:AGENT_HOME = $freshHome; Agent 'E6-v2-fresh-doctor' $V2 @('doctor') | Out-Null; $env:AGENT_HOME = $home2
$fresh = FP 'E6-fresh-v2' "$freshHome\agent.db"
$live = FP 'E6-live-snapshot' $LIVE_SNAPSHOT
Rec ("E6 schemaHash migrated={0} fresh={1} liveProduction={2} migrated==fresh:{3} migrated==live:{4}" -f $mig.schemaHash, $fresh.schemaHash, $live.schemaHash, ($mig.schemaHash -eq $fresh.schemaHash), ($mig.schemaHash -eq $live.schemaHash))
# E8 existing records interpretable through V2 read paths
foreach ($c in @(@('E8-projects', @('projects')), @('E8-project-status', @('project:status', 'elevariq-retail-operations-portal')), @('E8-tasks', @('tasks')), @('E8-qa', @('qa')), @('E8-approvals', @('approvals')), @('E8-roadmap', @('roadmap', 'elevariq-retail-operations-portal')), @('E8-inbox', @('inbox')), @('E8-recovery', @('recovery')))) { Agent $c[0] $V2 $c[1] | Out-Null }
Rec ("E8 tasks listed={0} approvals listed={1} qa rows listed={2}" -f @(Select-String "$Ev\E8-tasks.txt" -Pattern 'tsk_').Count, @(Select-String "$Ev\E8-approvals.txt" -Pattern 'apr_').Count, @(Select-String "$Ev\E8-qa.txt" -Pattern 'tsk_').Count)

# ---------------- F: staging deployment with queue processing on the MIGRATED production copy ----------------
$null = FP 'F0-pre-workflow' "$home2\agent.db" @('--save-limits', "$Ev\limits.json")
$asg = Get-Content (Join-Path (Split-Path (Split-Path (Split-Path $V2))) 'examples\assignment.example.json') -Raw | ConvertFrom-Json
$asg.title = 'Staging Rehearsal'; $asg.verification = [pscustomobject]@{}
$asg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 "$S\assignment.json"
Agent 'F1-assignment-add' $V2 @('assignment:add', '--file', "`"$S\assignment.json`"") | Out-Null
$slug = 'staging-rehearsal'
Agent 'F2-setverif-unauthorised' $V2 @('assignment:set-verification', $slug, '--test', '"node --version"') | Out-Null
Agent 'F2-setverif' $V2 @('assignment:set-verification', $slug, '--by', 'staging-owner', '--reason', '"release-readiness rehearsal"', '--build', '"node --version"', '--test', '"node --version"') | Out-Null
Agent 'F3-task-no-criteria' $V2 @('task:add', '--project', $slug, '--title', '"No Criteria"', '--instructions', 'x') | Out-Null
Agent 'F3-task-A' $V2 @('task:add', '--project', $slug, '--title', '"Feature A"', '--instructions', 'x', '--criteria', '"src/a.ts exists"', '--key', 'feat-a', '--verify', 'CHANGES_EXIST') | Out-Null
Agent 'F3-task-A-duplicate' $V2 @('task:add', '--project', $slug, '--title', '"Feature A"', '--instructions', 'x', '--criteria', '"src/a.ts exists"', '--key', 'feat-a', '--verify', 'CHANGES_EXIST') | Out-Null
Agent 'F3-task-B' $V2 @('task:add', '--project', $slug, '--title', '"Flaky B"', '--instructions', 'x', '--criteria', '"src/b.ts exists"', '--verify', 'CHANGES_EXIST') | Out-Null
Agent 'F3-task-C' $V2 @('task:add', '--project', $slug, '--title', '"Fatal C"', '--instructions', 'x', '--criteria', 'x', '--max-retries', '1') | Out-Null
Agent 'F3-task-E' $V2 @('task:add', '--project', $slug, '--title', '"Deploy E"', '--instructions', 'x', '--criteria', 'x') | Out-Null
$supA = StartSup 'F4-start'
Start-Sleep -Seconds 3; Rec ("F4 staging supervisor idle WS MB={0}" -f (SupMb $supA))
$ok4 = WaitFor { $d = Poll; ($d.newTasks | ? { $_.title -eq 'Fatal C' }).status -eq 'FAILED' -and ($d.newTasks | ? { $_.title -eq 'Deploy E' }).status -eq 'WAITING_FOR_APPROVAL' -and @($d.newQa | ? { $_.status -eq 'PASSED' }).Count -ge 2 } 180 'A,B reviewed (B after a QA rejection + correction); C failed; E awaiting approval'
Rec ("F4 supervisor WS MB after work={0}" -f (SupMb $supA))
Agent 'F5-approvals' $V2 @('approvals') | Out-Null
$apr = [regex]::Match((Get-Content "$Ev\F5-approvals.txt" -Raw), '(apr_[a-z0-9]+)\s+tsk_\w+\s+\S+\s+PENDING').Groups[1].Value
$env:ELEVARIQ_WORKER = '1'; Agent 'F5-worker-approve-refused' $V2 @('approve', $apr) | Out-Null; Agent 'F5-worker-accept-refused' $V2 @('project:accept', $slug) | Out-Null; Remove-Item env:ELEVARIQ_WORKER
Agent 'F5-owner-deny' $V2 @('deny', $apr) | Out-Null
Start-Sleep -Seconds 3
$d5 = Poll; $d5 | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 "$Ev\F5-after-phase1.json"
Rec ("F5 statuses: " + (($d5.newTasks | % { "$($_.title)=$($_.status)/att$($_.a)/startLatencyMs=$($_.startLatencyMs)" }) -join '; '))
Rec ("F5 qa: " + (($d5.newQa | % { "$($_.title)#$($_.round)=$($_.status)" }) -join ', '))

# F6 controlled simulated crash during a RUNNING task, restart, recovery (only the rehearsal-owned PID is killed)
Agent 'F6-task-D' $V2 @('task:add', '--project', $slug, '--title', '"Long D"', '--instructions', 'x', '--criteria', '"src/d.ts exists"', '--verify', 'CHANGES_EXIST') | Out-Null
WaitFor { (T 'Long D') -eq 'RUNNING' } 60 'Long D RUNNING' | Out-Null
Stop-Process -Id $supA -Force; $crashAt = Get-Date; Rec "F6 killed rehearsal-owned supervisor pid=$supA (simulated crash); prod pid $prodPid alive=$([bool](Get-Process -Id $prodPid -ErrorAction SilentlyContinue))"
Start-Sleep -Seconds 1; Rec ("F6 after crash: Long D = " + (T 'Long D'))
$supB = StartSup 'F6-restart'
Agent 'F6-second-start' $V2 @('start', '--detach') 60 | Out-Null
$dupPid = [int][regex]::Match((Get-Content "$Ev\F6-second-start.txt" -Raw), 'pid (\d+)').Groups[1].Value; if ($dupPid) { [void]$owned.Add($dupPid) }
WaitFor { (T 'Long D') -ne 'RUNNING' } 60 'Long D reconciled after restart' | Out-Null
Rec ("F6 recovery latency from crash to reconciliation: {0:N1}s" -f ((Get-Date) - $crashAt).TotalSeconds)
WaitFor { $d = Poll; @($d.newQa | ? { $_.title -eq 'Long D' -and $_.status -eq 'PASSED' }).Count -eq 1 } 120 'Long D recovered, completed and independently reviewed' | Out-Null
Rec ("F6 duplicate supervisor pid=$dupPid still alive=$([bool](Get-Process -Id $dupPid -ErrorAction SilentlyContinue)) (expected False)")
Agent 'F6-status' $V2 @('status') | Out-Null; Agent 'F6-health' $V2 @('health') | Out-Null
Agent 'F7-project-verify' $V2 @('project:verify', $slug) 300 | Out-Null
$wsp = Get-ChildItem $wsRoot -Directory | Where-Object { $_.Name -like 'staging-rehearsal*' } | Select-Object -First 1
if ($wsp) {
  New-Item -ItemType Directory -Force "$($wsp.FullName)\.tmp-staging\x" | Out-Null; Set-Content "$($wsp.FullName)\.tmp-staging\x\f.txt" 'x'
  Agent 'F8-scratch-ok' $V2 @('scratch:clean', $slug, '.tmp-staging') | Out-Null
  Agent 'F8-scratch-refused-src' $V2 @('scratch:clean', $slug, 'src') | Out-Null
  Rec ("F8 .tmp-staging removed={0} src kept={1}" -f (-not (Test-Path "$($wsp.FullName)\.tmp-staging")), (Test-Path "$($wsp.FullName)\src"))
}
Agent 'F9-stop' $V2 @('stop', '--wait', '30000') 90 | Out-Null
Start-Sleep -Seconds 3

# ---------------- G: memory-pressure gate with controlled thresholds ----------------
$env:MIN_FREE_MEMORY_MB = '60000'; $env:RESUME_FREE_MEMORY_MB = '60000'
$supG = StartSup 'G1-start-gate-forced'
Agent 'G1-task-G' $V2 @('task:add', '--project', $slug, '--title', '"Gate G"', '--instructions', 'x', '--criteria', '"src/g.ts exists"', '--verify', 'CHANGES_EXIST') | Out-Null
Start-Sleep -Seconds 12
$g1 = Poll; Rec ("G1 threshold 60000 MB: Gate G status={0} executions={1} resource_deferred events={2}" -f (($g1.newTasks | ? { $_.title -eq 'Gate G' }).status), (($g1.newTasks | ? { $_.title -eq 'Gate G' }).n), $g1.newEvents.'supervisor.resource_deferred')
Agent 'G1-stop' $V2 @('stop', '--wait', '30000') 90 | Out-Null; Start-Sleep -Seconds 2
$env:MIN_FREE_MEMORY_MB = '0'; $env:RESUME_FREE_MEMORY_MB = '0'
$supG2 = StartSup 'G2-start-gate-off'
WaitFor { $d = Poll; @($d.newQa | ? { $_.title -eq 'Gate G' -and $_.status -eq 'PASSED' }).Count -eq 1 } 120 'Gate G ran after the gate was lowered' | Out-Null
Agent 'G2-stop' $V2 @('stop', '--wait', '30000') 90 | Out-Null; Start-Sleep -Seconds 3
$left = @($owned | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
Rec ("F10 rehearsal-owned processes still alive after stop: {0}" -f ($left -join ','))
foreach ($p in $left) { Stop-Process -Id $p -Force; Rec "  stopped leftover rehearsal-owned pid $p" }
$fin = FP 'F11-final' "$home2\agent.db" @('--limits', "$Ev\limits.json")
Rec ("F11 new tasks: " + (($fin.newTasks | % { "$($_.title)=$($_.status)/att$($_.a)/exec$($_.n)[$($_.classes)]/sessions$($_.sessions)" }) -join '; '))
Rec ("F11 qa: " + (($fin.newQa | % { "$($_.title)#$($_.round)=$($_.status)" }) -join ', ') + " approvals: " + (($fin.newApprovals | % { "$($_.action_type):$($_.status):$($_.decided_by)" }) -join ', ') + " overlaps=$($fin.overlappingExecutions)")
Rec ("F11 events: " + ($fin.newEvents | ConvertTo-Json -Compress))
$histAfterRun = FP 'F12-history-after-run' "$home2\agent.db" @('--limits', "$Ev\limits-v8.json")
$f12 = Cmp $base $histAfterRun 'F12 pilot history (rowid<=baseline)' ($HIST | Where-Object { $_ -ne 'projects' })
Rec "F12 pre-existing production history untouched by staging processing: $f12"

# ---------------- R1: rollback by restoring the pre-upgrade snapshot with V1 (timed) ----------------
$v11Copy = "$S\golden\v11-after-staging.db"; Copy-Item "$home2\agent.db" $v11Copy
Agent 'R1-v1-restore' $V1 @('restore', "`"$($bk.FullName)`"", '--reason', '"release-readiness rollback rehearsal"') 180 | Out-Null
$rb = FP 'R1-after-rollback'
Rec ("R1 versions after rollback={0} integrity={1} fk={2} schemaHash={3} equals pre-upgrade schema={4}" -f ($rb.versions -join ' '), $rb.integrity, $rb.fkViolations, $rb.schemaHash, ($rb.schemaHash -eq $base.schemaHash))
$r1 = Cmp $base $rb 'R1 rollback' $HIST
Rec ("R1 restored DB equals pre-upgrade baseline: {0}; tasks={1} statuses={2}" -f $r1, $rb.counts.tasks, ($rb.taskStatus | ConvertTo-Json -Compress))
Agent 'R2-v1-doctor' $V1 @('doctor') | Out-Null
Agent 'R2-v1-status' $V1 @('status') | Out-Null
Agent 'R2-v1-tasks' $V1 @('tasks') | Out-Null
$supR = StartSup 'R3-v1-start' $V1
Start-Sleep -Seconds 8
Agent 'R3-v1-health' $V1 @('health') | Out-Null
Agent 'R3-v1-second-start' $V1 @('start', '--detach') 60 | Out-Null
$dup2 = [int][regex]::Match((Get-Content "$Ev\R3-v1-second-start.txt" -Raw), 'pid (\d+)').Groups[1].Value; if ($dup2) { [void]$owned.Add($dup2) }
Agent 'R4-v1-stop' $V1 @('stop', '--wait', '30000') 90 | Out-Null; Start-Sleep -Seconds 3
$rbAfter = FP 'R4-after-v1-run'
Rec ("R4 V1 startup on restored DB: versions={0} history still equal baseline={1}" -f ($rbAfter.versions -join ' '), (Cmp $base $rbAfter 'R4' $HIST))

# ---------------- R5: forward-compatibility probe: V1 code on a V2 (v11) database, throwaway copies ----------------
foreach ($pair in @(@('R5-v1-on-v11-staging', $v11Copy), @('R5-v1-on-v11-liveSnapshot', $LIVE_SNAPSHOT))) {
  $ph = "$S\probe-$($pair[0])"; New-Item -ItemType Directory -Force $ph | Out-Null; Copy-Item $pair[1] "$ph\agent.db"
  $env:AGENT_HOME = $ph
  if ($pair[0] -like '*liveSnapshot') { node -e "const D=require('module').createRequire('E:/Agent/pa-v2-integrate/package.json')('better-sqlite3');const d=new D(process.argv[1]);d.prepare('UPDATE projects SET repo_path=?').run(process.argv[2]);d.prepare('UPDATE supervisor_state SET pid=999999, heartbeat_at=0, status=?').run('STOPPED');d.close()" "$ph\agent.db" "$wsRoot\elevariq-retail-operations-portal" }
  Agent "$($pair[0])-doctor" $V1 @('doctor') | Out-Null
  Agent "$($pair[0])-status" $V1 @('status') | Out-Null
  $sp = StartSup "$($pair[0])-start" $V1; Start-Sleep -Seconds 8
  Agent "$($pair[0])-health" $V1 @('health') | Out-Null
  Agent "$($pair[0])-stop" $V1 @('stop', '--wait', '30000') 90 | Out-Null; Start-Sleep -Seconds 2
  $pf = FP "$($pair[0])-after" "$ph\agent.db"
  Rec ("{0}: versions={1} integrity={2} tasks={3}" -f $pair[0], ($pf.versions -join ' '), $pf.integrity, ($pf.taskStatus | ConvertTo-Json -Compress))
  $env:AGENT_HOME = $home2
}

# ---------------- R6: what a restore-based rollback would lose: live production (v11 snapshot) vs pre-upgrade backup ----------------
$lv = FP 'R6-live-vs-preupgrade' $LIVE_SNAPSHOT @('--limits', "$Ev\limits-v8.json")
$lvFull = FP 'R6-live-full' $LIVE_SNAPSHOT
$gl = FP 'R6-golden' "$S\golden\v8-preupgrade.db"
foreach ($t in $HIST + 'activity_events','milestones') { Rec ("R6 {0,-22} rows preupgrade={1} liveNow={2} (new={3}) preexisting-rows-identical={4}" -f $t, $gl.counts.$t, $lvFull.counts.$t, ($lvFull.counts.$t - $gl.counts.$t), ($gl.fingerprints.$t -eq $lv.fingerprints.$t)) }

$left = @($owned | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }); foreach ($p in $left) { Stop-Process -Id $p -Force; Rec "  stopped leftover rehearsal-owned pid $p" }
$prodNow = Get-CimInstance Win32_Process -Filter "ProcessId=$prodPid"
$prodTask1 = Get-ScheduledTask -TaskName ElevariqPersonalAgent | Export-ScheduledTask
Rec ("end {0:o} production supervisor pid {1} alive={2} sameStart={3}; scheduled-task definition unchanged={4}" -f (Get-Date), $prodPid, [bool]$prodNow, ($prodNow.CreationDate -eq $prodStart), ($prodTask0 -eq $prodTask1))

