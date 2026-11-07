<#
.SYNOPSIS
  Live acceptance test of Windows background operation through Task Scheduler. Run on the owner's Windows PC as the
  user who owns the Claude Code login. It registers a SEPARATE task (default 'ElevariqPersonalAgent-Acceptance') with
  an isolated agent home, exercises it, and unregisters it at the end. The owner's real task and agent home are not
  touched.

  Checks: task definition (trigger, absolute working dir, node path, principal, settings), what the task context can
  see (user, session, Claude CLI version, subscription login readable), supervisor startup, logs, persistent database,
  mock task execution, single-instance enforcement, restart after supervisor crash with task recovery, wrapper loss
  (supervisor survives; a new wrapper monitors and takes over), graceful stop, and optionally (-RealCli) one minimal
  task on the real Claude Code CLI under the subscription login, including the watchdog variables in the worker.

  Not covered (cannot be automated safely): Windows restart / sign-in. See docs/WINDOWS_DEPLOYMENT.md for the manual check.
  Compatible with Windows PowerShell 5.1 and PowerShell 7.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\scheduler-acceptance.ps1 -RealCli
#>
param(
  [string]$TaskName = 'ElevariqPersonalAgent-Acceptance',
  [string]$RepoPath = '',
  [string]$NodePath = '',
  [string]$AgentHome = '',
  [switch]$RealCli,
  [switch]$KeepTask
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not $RepoPath) { $RepoPath = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path
if (-not $NodePath) { $NodePath = (Get-Command node).Source }
if (-not $AgentHome) { $AgentHome = Join-Path $env:LOCALAPPDATA 'ElevariqAgent-acceptance' }
if ($TaskName -eq 'ElevariqPersonalAgent') { throw 'Refusing to use the production task name.' }
$entry = Join-Path $RepoPath 'dist\cli\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Run npm run build first.' }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if (Test-Path -LiteralPath $AgentHome) { Remove-Item -LiteralPath $AgentHome -Recurse -Force }
New-Item -ItemType Directory -Force -Path $AgentHome | Out-Null
$envFile = Join-Path $AgentHome 'acceptance.env'
$scenario = Join-Path $AgentHome 'scenario.json'
'{"tasks":{"sched long":["hang","success"]}}' | Set-Content -LiteralPath $scenario -Encoding ASCII
function Write-EnvFile([string]$provider) {
  @(
    "EXECUTION_PROVIDER=$provider",
    "MOCK_SCENARIO_FILE=$scenario",
    'CLAUDE_MODEL=haiku',
    'POLL_INTERVAL_MS=500',
    'HEARTBEAT_INTERVAL_MS=1000',
    'LEASE_TTL_MS=5000',
    'SHUTDOWN_GRACE_MS=8000',
    'LOG_TO_CONSOLE=false'
  ) | Set-Content -LiteralPath $envFile -Encoding ASCII
}
Write-EnvFile 'mock'
$env:AGENT_HOME = $AgentHome
$env:AGENT_ENV_FILE = $envFile
$env:LOG_TO_CONSOLE = 'false'
$db = Join-Path $AgentHome 'agent.db'

$results = New-Object System.Collections.ArrayList
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  [void]$results.Add([ordered]@{ check = $Name; ok = $Ok; detail = $Detail })
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Output ('{0}  {1}  {2}' -f $tag, $Name, $Detail)
}
function Info([string]$Name, [string]$Detail) {
  [void]$results.Add([ordered]@{ check = $Name; ok = $null; detail = $Detail })
  Write-Output ('INFO  {0}  {1}' -f $Name, $Detail)
}
function Agent([string[]]$a) {
  Push-Location $RepoPath
  try { $o = (& $NodePath $entry @a 2>$null) | Out-String; return @{ code = $LASTEXITCODE; out = $o } } finally { Pop-Location }
}
function Status() { try { return ((Agent @('status', '--json')).out | ConvertFrom-Json) } catch { return $null } }
function Query([string]$sql, [string]$arg = '') {
  $js = "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true,fileMustExist:true});const s=d.prepare(process.argv[2]);console.log(JSON.stringify(process.argv[3]?s.all(process.argv[3]):s.all()))"
  Push-Location $RepoPath
  try { return ((& $NodePath -e $js $db $sql $arg) | Out-String | ConvertFrom-Json) } finally { Pop-Location }
}
function TaskStatus([string]$id) { $r = Query 'SELECT status FROM tasks WHERE id = ?' $id; if ($r) { return $r[0].status } else { return $null } }
function WaitUntil([scriptblock]$cond, [int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  return $false
}
$homeArg = "-AgentHome `"$AgentHome`""
function Wrappers() {
  @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('run-supervisor.ps1') -and $_.CommandLine.Contains($homeArg) })
}
function Supervisors() {
  $w = @(Wrappers | ForEach-Object { $_.ProcessId })
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('dist\cli\index.js') -and $_.CommandLine -match ' start\s*$' -and ($w -contains $_.ParentProcessId) })
}
function LivePid() { $s = Status; if ($s -and $s.supervisor.live) { return [int]$s.supervisor.pid } else { return 0 } }
function TaskId([string]$text) { $m = [regex]::Match($text, 'tsk_[a-z0-9]+'); return $m.Value }

Write-Output "Acceptance home: $AgentHome"
# ---------------------------------------------------------------- 1. install + definition
& (Join-Path $RepoPath 'scripts\windows\install-task.ps1') -TaskName $TaskName -RepoPath $RepoPath -NodePath $NodePath -AgentHome $AgentHome -EnvFile $envFile -KeepAliveMinutes 1 | Out-Null
# From here on, a failing step is recorded as FAIL and the run continues (cleanup always happens).
$ErrorActionPreference = 'Continue'
$t = Get-ScheduledTask -TaskName $TaskName
$act = $t.Actions[0]
Check 'task registered' ($null -ne $t) $TaskName
Check 'action runs the wrapper with an absolute node path' (($act.Execute -eq 'powershell.exe') -and $act.Arguments.Contains((Join-Path $RepoPath 'scripts\windows\run-supervisor.ps1')) -and $act.Arguments.Contains("-NodePath `"$NodePath`"")) $act.Arguments
Check 'absolute working directory' ($act.WorkingDirectory -eq $RepoPath) $act.WorkingDirectory
Check 'logon trigger for this user' (($t.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') -and ($t.Triggers[0].UserId -like "*$env:USERNAME")) "$($t.Triggers[0].CimClass.CimClassName) $($t.Triggers[0].UserId)"
Check 'keepalive trigger (repeats indefinitely)' (($t.Triggers.Count -ge 2) -and ($t.Triggers[1].Repetition.Interval -eq 'PT1M') -and (-not $t.Triggers[1].Repetition.Duration)) "interval=$($t.Triggers[1].Repetition.Interval) duration='$($t.Triggers[1].Repetition.Duration)'"
Check 'runs as this user, interactive token, not elevated' (($t.Principal.UserId -like "*$env:USERNAME") -and ($t.Principal.LogonType -eq 'Interactive') -and ($t.Principal.RunLevel -eq 'Limited')) "$($t.Principal.UserId) $($t.Principal.LogonType) $($t.Principal.RunLevel)"
Check 'single instance (IgnoreNew), no time limit, restart on failure' (($t.Settings.MultipleInstances -eq 'IgnoreNew') -and ($t.Settings.ExecutionTimeLimit -eq 'PT0S') -and ($t.Settings.RestartCount -ge 1)) "$($t.Settings.MultipleInstances) $($t.Settings.ExecutionTimeLimit) restart=$($t.Settings.RestartCount)x$($t.Settings.RestartInterval)"
Check 'no secret in task arguments' (-not ($act.Arguments -match '(?i)(api[_-]?key|token|password|secret)')) 'paths only'
Check 'runs on battery power and is not stopped when unplugged' ((-not $t.Settings.DisallowStartIfOnBatteries) -and (-not $t.Settings.StopIfGoingOnBatteries)) "DisallowStartIfOnBatteries=$($t.Settings.DisallowStartIfOnBatteries) StopIfGoingOnBatteries=$($t.Settings.StopIfGoingOnBatteries)"
$power = [System.Windows.Forms.SystemInformation]::PowerStatus
Info 'power source during this run' "$($power.PowerLineStatus) (Offline = on battery)"

# ---------------------------------------------------------------- 2. what the task context can see
$probeName = "$TaskName-Probe"
$probeOut = Join-Path $AgentHome 'probe.json'
$probeArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $RepoPath 'scripts\windows\task-probe.ps1')`" -Out `"$probeOut`" -RepoPath `"$RepoPath`" -NodePath `"$NodePath`" -AgentHome `"$AgentHome`" -EnvFile `"$envFile`""
$pAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $probeArgs -WorkingDirectory $RepoPath
$pPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
# Battery flags matter: Task Scheduler's default is "do not start on battery power" (the task would stay Queued).
$pSettings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $probeName -Action $pAction -Principal $pPrincipal -Settings $pSettings -Force | Out-Null
Start-ScheduledTask -TaskName $probeName
$null = WaitUntil { Test-Path -LiteralPath $probeOut } 240
Start-Sleep -Seconds 1
Unregister-ScheduledTask -TaskName $probeName -Confirm:$false
$probe = $null
if (Test-Path -LiteralPath $probeOut) { $probe = Get-Content -LiteralPath $probeOut -Raw | ConvertFrom-Json }
Check 'probe ran inside Task Scheduler' ($null -ne $probe) $probeOut
if ($probe) {
  Check 'task context user = owner' ($probe.user -eq "$env:USERDOMAIN\$env:USERNAME") "$($probe.user) session=$($probe.sessionId)"
  Check 'task context working directory = repo' ($probe.cwd -eq $RepoPath) $probe.cwd
  Check 'task context node' ($probe.nodePath -eq $NodePath) "$($probe.nodePath) $($probe.nodeVersion)"
  Check 'claude CLI found in task context' ($null -ne $probe.claudePath) "$($probe.claudePath) $($probe.claudeVersion)"
  Check 'subscription login readable in task context' (($probe.auth.loggedIn -eq $true) -and ($probe.auth.authMethod -eq 'claude.ai')) "loggedIn=$($probe.auth.loggedIn) method=$($probe.auth.authMethod) plan=$($probe.auth.subscriptionType)"
  Check 'claude-cli provider ready in task context' ($probe.providerStatusExit -eq 0) (($probe.providerStatus | Select-Object -First 1) -join ' ')
}

# ---------------------------------------------------------------- 3. startup, logs, database
Start-ScheduledTask -TaskName $TaskName
$up = WaitUntil { (LivePid) -gt 0 } 90
$sup1 = LivePid
Check 'supervisor started by the task' $up "pid=$sup1"
$sp = @(Supervisors)
$wr = @(Wrappers)
Check 'supervisor is node.exe from the embedded path, child of the wrapper' (($sp.Count -eq 1) -and ($sp[0].ProcessId -eq $sup1) -and ($sp[0].ExecutablePath -eq $NodePath)) "supervisors=$($sp.Count) wrappers=$($wr.Count) exe=$(if ($sp.Count) { $sp[0].ExecutablePath })"
if ($wr.Count) { $owner = Invoke-CimMethod -InputObject $wr[0] -MethodName GetOwner; Check 'wrapper runs as owner' ("$($owner.Domain)\$($owner.User)" -eq "$env:USERDOMAIN\$env:USERNAME") "$($owner.Domain)\$($owner.User)" }
$st = Status
Check 'supervisor uses the configured agent home' ($null -ne $st) ''
Check 'persistent database created' (Test-Path -LiteralPath $db) $db
$logDir = Join-Path $AgentHome 'logs'
Check 'wrapper log written' ((Test-Path (Join-Path $logDir 'wrapper.log')) -and ((Get-Content (Join-Path $logDir 'wrapper.log') -Raw) -match 'supervisor launched')) (Join-Path $logDir 'wrapper.log')
$appLogs = @(Get-ChildItem -LiteralPath $logDir -File -Recurse | Where-Object { $_.Name -notmatch '^(wrapper|supervisor-std(out|err))\.log$' })
Check 'application logs written' ($appLogs.Count -gt 0) (($appLogs | Select-Object -First 3 | ForEach-Object { $_.Name }) -join ', ')

# ---------------------------------------------------------------- 4. mock task execution
$r = Agent @('project:add', '--name', 'Scheduler Acceptance')
$tq = TaskId (Agent @('task:add', '--project', 'scheduler-acceptance', '--title', 'sched quick', '--instructions', 'quick mock task')).out
$done = WaitUntil { (TaskStatus $tq) -eq 'COMPLETED' } 90
Check 'mock task executed to COMPLETED under the task' $done "$tq $(TaskStatus $tq)"

# ---------------------------------------------------------------- 5. single instance
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6
Check 'second task start ignored (one wrapper, one supervisor)' ((@(Wrappers).Count -eq 1) -and (@(Supervisors).Count -eq 1) -and ((LivePid) -eq $sup1)) "wrappers=$(@(Wrappers).Count) supervisors=$(@(Supervisors).Count)"
$second = Start-Process -FilePath $NodePath -ArgumentList @("`"$entry`"", 'start') -WorkingDirectory $RepoPath -NoNewWindow -PassThru -Wait -RedirectStandardOutput (Join-Path $AgentHome 'second-out.txt') -RedirectStandardError (Join-Path $AgentHome 'second-err.txt')
Check 'manually started second supervisor refused (exit 3)' ($second.ExitCode -eq 3) "exit=$($second.ExitCode)"

# ---------------------------------------------------------------- 6. supervisor crash -> wrapper restart -> task recovery
$tl = TaskId (Agent @('task:add', '--project', 'scheduler-acceptance', '--title', 'sched long', '--instructions', 'hangs until interrupted')).out
$null = WaitUntil { (TaskStatus $tl) -eq 'RUNNING' } 60
Stop-Process -Id $sup1 -Force -ErrorAction SilentlyContinue
$restarted = WaitUntil { $p = LivePid; ($p -gt 0) -and ($p -ne $sup1) } 120
$sup2 = LivePid
Check 'wrapper restarted the killed supervisor' $restarted "old=$sup1 new=$sup2"
$rec = WaitUntil { (TaskStatus $tl) -eq 'COMPLETED' } 120
$outs = @(Query 'SELECT outcome FROM executions WHERE task_id = ? ORDER BY started_at' $tl | ForEach-Object { $_.outcome })
Check 'interrupted task recovered and completed' ($rec -and (($outs -join ',') -eq 'interrupted,completed')) "$(TaskStatus $tl) executions=$($outs -join ',')"
Check 'restart recorded in wrapper log' ((Get-Content (Join-Path $logDir 'wrapper.log') -Raw) -match "pid=$sup1 exited code=") 'exit code + restart delay logged'

# ---------------------------------------------------------------- 7. wrapper lost while the supervisor survives
$w1 = @(Wrappers)
if ($w1.Count) { Stop-Process -Id $w1[0].ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Check 'supervisor survives loss of its wrapper' ((LivePid) -eq $sup2) "pid=$(LivePid)"
$tsRestarted = WaitUntil { @(Wrappers).Count -ge 1 } 150
Info 'Task Scheduler restarted the killed wrapper by itself' "$tsRestarted (RestartCount applies only to some failure kinds)"
if (-not $tsRestarted) { Start-ScheduledTask -TaskName $TaskName; $null = WaitUntil { @(Wrappers).Count -ge 1 } 30 }
$monitoring = WaitUntil { (Get-Content (Join-Path $logDir 'wrapper.log') -Raw) -match 'monitoring it' } 60
Check 'new wrapper monitors the surviving supervisor (no second supervisor)' ($monitoring -and ((LivePid) -eq $sup2)) "wrappers=$(@(Wrappers).Count)"
Stop-Process -Id $sup2 -Force -ErrorAction SilentlyContinue
$takeover = WaitUntil { $p = LivePid; ($p -gt 0) -and ($p -ne $sup2) } 120
$sup3 = LivePid
Check 'monitoring wrapper takes over after that supervisor dies' $takeover "old=$sup2 new=$sup3"

# ---------------------------------------------------------------- 8. graceful stop
$stop = Agent @('stop')
$ended = WaitUntil { ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') -and (@(Wrappers).Count -eq 0) } 60
$st = Status
Check 'graceful stop ends supervisor, wrapper and task' (($stop.code -eq 0) -and $ended -and ($st.supervisor.status -eq 'STOPPED')) "stop=$($stop.code) taskState=$((Get-ScheduledTask -TaskName $TaskName).State) supervisor=$($st.supervisor.status)"
Check 'wrapper logged the graceful stop' ((Get-Content (Join-Path $logDir 'wrapper.log') -Raw) -match 'graceful stop; wrapper exiting') ''

# ---------------------------------------------------------------- 8b. whole task tree terminated -> keepalive restarts
$back = WaitUntil { (LivePid) -gt 0 } 150
Check 'keepalive trigger restarts the agent after it ended' $back "pid=$(LivePid)"
$supK = LivePid
# Simulated total failure: wrapper AND supervisor killed (nothing left to restart anything locally).
foreach ($w in @(Wrappers)) { Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue }
if ($supK) { Stop-Process -Id $supK -Force -ErrorAction SilentlyContinue }
$gone = WaitUntil { (@(Wrappers).Count -eq 0) -and -not (Get-Process -Id $supK -ErrorAction SilentlyContinue) } 30
Check 'wrapper and supervisor both killed (simulated total failure)' $gone "wrappers=$(@(Wrappers).Count) supervisorAlive=$([bool](Get-Process -Id $supK -ErrorAction SilentlyContinue))"
$rec2 = WaitUntil { $p = LivePid; ($p -gt 0) -and ($p -ne $supK) } 150
Check 'keepalive recovers from total failure of the task process tree' $rec2 "old=$supK new=$(LivePid)"

# ---------------------------------------------------------------- 8c. stop --hold is honoured by keepalive
$hold = Agent @('stop', '--hold')
$null = WaitUntil { (LivePid) -eq 0 } 60
Start-Sleep -Seconds 100
Check 'stop --hold: keepalive does not restart the agent' (((LivePid) -eq 0) -and ((Get-Content (Join-Path $logDir 'wrapper.log') -Raw) -match 'STOP-HOLD present')) "stop=$($hold.code) live=$(LivePid)"
Remove-Item -LiteralPath (Join-Path $AgentHome 'STOP-HOLD') -Force -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- 9. real Claude Code CLI under the task (optional)
if ($RealCli) {
  Write-EnvFile 'claude-cli'
  Start-ScheduledTask -TaskName $TaskName
  $cliUp = WaitUntil { (LivePid) -gt 0 } 90
  Check 'claude-cli supervisor started by the task' $cliUp "pid=$(LivePid)"
  $instr = 'Do exactly two things using tools, then reply DONE. (1) Run this shell command once: ' +
    'printenv CLAUDE_CODE_RETRY_WATCHDOG CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS CLAUDE_CODE_RESUME_INTERRUPTED_TURN CLAUDE_CODE_RESUME_PROMPT > watchdog-env.txt ' +
    '(2) Create the file sched-cli.txt containing exactly: ok'
  $tc = TaskId (Agent @('task:add', '--project', 'scheduler-acceptance', '--title', 'sched real cli', '--instructions', $instr)).out
  $fin = WaitUntil { @('COMPLETED', 'BLOCKED', 'FAILED') -contains (TaskStatus $tc) } 420
  $repo = (Query 'SELECT repo_path FROM projects LIMIT 1')[0].repo_path
  Check 'real CLI task completed under the task' ((TaskStatus $tc) -eq 'COMPLETED') "$tc $(TaskStatus $tc)"
  $okFile = Join-Path $repo 'sched-cli.txt'
  Check 'real CLI worker wrote its artifact' ((Test-Path $okFile) -and ((Get-Content $okFile -Raw).Trim() -eq 'ok')) $okFile
  $envOut = Join-Path $repo 'watchdog-env.txt'
  $lines = @(); if (Test-Path $envOut) { $lines = @(Get-Content $envOut) }
  Info 'watchdog variables visible to the worker''s Bash tool' ((($lines | ForEach-Object { if ($_.Length -gt 40) { $_.Substring(0, 40) + '...' } else { $_ } }) -join ' | ') + ' (Claude Code decides what tool shells inherit)')
  $execLogs = @(Get-ChildItem -LiteralPath (Join-Path $AgentHome 'logs\executions') -File -Filter *.jsonl)
  $fmt = { param($v) if ($v) { "RETRY_WATCHDOG=$($v.CLAUDE_CODE_RETRY_WATCHDOG) RECHECK_MS=$($v.CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS) RESUME_INTERRUPTED_TURN=$($v.CLAUDE_CODE_RESUME_INTERRUPTED_TURN) RESUME_PROMPT set=$($null -ne $v.CLAUDE_CODE_RESUME_PROMPT)" } else { 'no record' } }
  $envRecs = @($execLogs | Select-String -Pattern '"kind":"worker_env"' | ForEach-Object { $_.Line | ConvertFrom-Json })
  $spawnVars = ($envRecs | Where-Object { $_.observedIn -like 'spawn*' } | Select-Object -Last 1).vars
  $hookVars = ($envRecs | Where-Object { $_.observedIn -like 'policy hook*' } | Select-Object -Last 1).vars
  Check 'all 4 watchdog variables in the environment handed to the claude worker' (($null -ne $spawnVars) -and ($spawnVars.CLAUDE_CODE_RETRY_WATCHDOG -eq '1') -and ($spawnVars.CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS -eq '300000') -and ($spawnVars.CLAUDE_CODE_RESUME_INTERRUPTED_TURN -eq '1') -and ("$($spawnVars.CLAUDE_CODE_RESUME_PROMPT)" -like 'Resume from the latest durable checkpoint*')) (& $fmt $spawnVars)
  Info 'watchdog variables inherited by claude''s own child processes (policy hook)' ((& $fmt $hookVars) + ' (Claude Code does not pass RESUME_* on to children)')
  $cred = @($execLogs | Select-String -Pattern '"billing":"([a-z_]+)"' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -Unique)
  Check 'worker used the subscription login (init credential source)' (($cred.Count -ge 1) -and (@($cred | Where-Object { $_ -ne 'subscription' }).Count -eq 0)) ($cred -join ',')
  $stop = Agent @('stop')
  $null = WaitUntil { ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') } 60
  Check 'claude-cli supervisor stopped gracefully' ($stop.code -eq 0) ''
}

# ---------------------------------------------------------------- 10. cleanup + report
if (-not $KeepTask) {
  & (Join-Path $RepoPath 'scripts\windows\uninstall-task.ps1') -TaskName $TaskName -RepoPath $RepoPath -AgentHome $AgentHome -EnvFile $envFile | Out-Null
  Check 'acceptance task unregistered' ($null -eq (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) ''
}
Info 'not covered' 'Windows restart / sign-in trigger: manual check, see docs/WINDOWS_DEPLOYMENT.md'
$report = Join-Path $AgentHome 'scheduler-acceptance.json'
[ordered]@{ at = (Get-Date).ToString('o'); machine = $env:COMPUTERNAME; user = "$env:USERDOMAIN\$env:USERNAME"; node = $NodePath; results = $results } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $report -Encoding UTF8
$failed = @($results | Where-Object { $_.ok -eq $false }).Count
Write-Output "`nReport: $report"
if ($failed) { Write-Output "$failed check(s) FAILED."; exit 1 } else { Write-Output 'All checks passed.'; exit 0 }
