# Targeted re-run: QA rejection -> correction task -> round-2 review PASS (fresh isolated home, mock provider).
# Reason: in the main rehearsal the scenario did not script the round-2 review title, so V2 escalated (correct fail-safe).
param([string]$V2 = 'E:\Agent\v2-staging\rr\v2-e60278f\dist\cli\index.js', [string]$S = 'E:\Agent\v2-staging\rr\stage-qa', [string]$Ev)
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;$env:Path"
if (Test-Path $S) { throw "refusing to reuse $S" }
New-Item -ItemType Directory -Force "$S\home", "$S\workspaces", $Ev | Out-Null
$log = "$Ev\qa-correction-rerun.log"; function Rec([string]$s) { Add-Content -Encoding utf8 $log $s; Write-Host $s }
$pass = '{"criteria":[{"id":"AC1","met":true,"evidence":[{"file":"src/b.ts","line":1}],"note":"ok"}],"defects":[],"testsAssessment":"ok"}'
$fail = '{"criteria":[{"id":"AC1","met":false,"evidence":[],"note":"b.ts lacks the export"}],"defects":[{"severity":"medium","description":"missing export"}],"testsAssessment":"weak"}'
@{ tasks = @{
  'Flaky B' = @(@{ type = 'success'; writes = @(@{ file = 'src/b.ts'; content = "// b`n// b`n" }) })
  'Review: Flaky B' = @(@{ type = 'success'; summary = $fail })
  'Fix: Flaky B (QA round 1)' = @(@{ type = 'success'; writes = @(@{ file = 'src/b.ts'; content = "// b fixed`nexport const b = 1;`n" }) })
  'Review: Flaky B (round 2)' = @(@{ type = 'success'; summary = $pass })
} } | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 "$S\scenario.json"
$envs = @{ AGENT_HOME = "$S\home"; AGENT_ENV_FILE = "$S\none.env"; WORKSPACE_ROOT = "$S\workspaces"; EXECUTION_PROVIDER = 'mock'; MOCK_SCENARIO_FILE = "$S\scenario.json"
  ENVIRONMENT = 'test'; LOG_TO_CONSOLE = 'false'; HEALTH_PORT = '0'; INTEGRATION_ERP_ENABLED = 'false'; INTEGRATION_CRM_ENABLED = 'false'; NODE_NO_WARNINGS = '1'
  POLL_INTERVAL_MS = '300'; HEARTBEAT_INTERVAL_MS = '500'; LEASE_TTL_MS = '3000'; MIN_FREE_MEMORY_MB = '0'; RESUME_FREE_MEMORY_MB = '0'; BACKUP_INTERVAL_HOURS = '0' }
foreach ($k in $envs.Keys) { Set-Item "env:$k" $envs[$k] }
Set-Location $S
function Agent([string]$name, [string[]]$a) { $o = "$Ev\$name.txt"; $p = Start-Process node -ArgumentList (@("`"$V2`"") + $a) -WorkingDirectory $S -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError "$o.err"; $null = $p.Handle; [void]$p.WaitForExit(120000); Rec "$name exit=$($p.ExitCode) [$($a -join ' ')]" }
$asg = Get-Content 'E:\Agent\v2-staging\rr\v2-e60278f\examples\assignment.example.json' -Raw | ConvertFrom-Json; $asg.title = 'QA Rerun'; $asg.verification = [pscustomobject]@{}
$asg | ConvertTo-Json -Depth 10 | Out-File -Encoding utf8 "$S\assignment.json"
Agent 'Q1-assignment' @('assignment:add', '--file', "`"$S\assignment.json`"")
Agent 'Q2-task-B' @('task:add', '--project', 'qa-rerun', '--title', '"Flaky B"', '--instructions', 'x', '--criteria', '"src/b.ts exports b"', '--verify', 'CHANGES_EXIST')
Agent 'Q3-start' @('start', '--detach'); $sup = [int][regex]::Match((Get-Content "$Ev\Q3-start.txt" -Raw), 'pid (\d+)').Groups[1].Value
$end = (Get-Date).AddSeconds(120); $q = ''
while ((Get-Date) -lt $end) { $q = node -e "const D=require('module').createRequire('E:/Agent/pa-v2-integrate/package.json')('better-sqlite3');const d=new D(process.argv[1],{readonly:true});console.log(d.prepare('SELECT round,status FROM qa_reviews ORDER BY rowid').all().map(r=>r.round+'='+r.status).join(','));d.close()" "$S\home\agent.db"; if ($q -match '2=PASSED') { break }; Start-Sleep -Milliseconds 800 }
Rec "Q4 qa rounds: $q"
Agent 'Q5-qa' @('qa'); Agent 'Q5-tasks' @('tasks'); Agent 'Q6-stop' @('stop', '--wait', '30000'); Start-Sleep 2
if (Get-Process -Id $sup -ErrorAction SilentlyContinue) { Stop-Process -Id $sup -Force; Rec "stopped leftover pid $sup" }
Rec "Q7 tasks: $((Get-Content "$Ev\Q5-tasks.txt") -join ' | ')"

