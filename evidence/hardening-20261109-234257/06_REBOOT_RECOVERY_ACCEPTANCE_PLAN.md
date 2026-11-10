# 6. Reboot-recovery acceptance plan (P1, persistence)

**Status:** audit done read-only; the procedure is **written, not executed**. Windows was **not** restarted.

## 6.1 Audit of the current startup and recovery design (read-only, 2026-11-10 00:10)

| Item | Observed | Source | Assessment |
|---|---|---|---|
| Task | `ElevariqPersonalAgent`, hidden, user task | `scheduled-task-export.xml` (readiness evidence) | OK |
| Triggers | (1) **LogonTrigger** for `DESKTOP-QGGLG8D\Roman`; (2) **TimeTrigger** repeating every **5 min** (keepalive) | same | OK; the keepalive also restarts a dead wrapper |
| Principal | `InteractiveToken`, default (limited) run level | same | **Runs only while Roman is logged on.** After a reboot, nothing runs until Roman logs on |
| Auto-logon | `AutoAdminLogon=0` | registry (read) | Confirms: **no agent between boot and logon** |
| Multiple instances | `IgnoreNew` | XML | Keepalive starts while the wrapper runs are refused (`0x800710E0`), as expected |
| Restart on failure | 999 × every 1 min | XML | OK (wrapper-level backoff 10 s → 5 min in addition) |
| Execution limit | none (`PT0S`) | XML | OK for a long-running supervisor |
| Battery | runs on battery, not stopped on battery | XML | OK |
| StartWhenAvailable | true | XML | Missed keepalives run once the session is available |
| Wrapper | `run-supervisor.ps1`: exit 0 = graceful (no restart), 2 = config error (no restart), 3 = duplicate supervisor; otherwise restart with backoff; **`STOP-HOLD` present → do not start** | `scripts/windows/run-supervisor.ps1:6,58-98` | OK. **Security note:** any process running as Roman, including a worker today, can create `STOP-HOLD` and stop all automatic restarts (verified in the isolation baseline, P4). P0 removes this |
| Fast Startup | `HiberbootEnabled=1` | registry (read) | "Shut down" hibernates the kernel and logs the user off; the logon trigger still fires at the next logon. "Restart" is a full boot. Both must be tested |
| Last boot | 2026-11-05 03:44, **before** the task was installed (2026-11-07) | WMI | **The boot/logon path has never run for real** |
| Sleep | S3 and hibernate available | `powercfg /a` | Host sleep is handled by V2 (A11, unit-tested only) |
| Supervisor state | alive pid 8992, started 2026-11-09 18:07:57; last task result `0x800710E0` (IgnoreNew) | read-only | Healthy |

**Design gaps:**
1. No agent before logon (by design: InteractiveToken). If unattended operation after power loss is required, it needs either auto-logon (a security trade-off) or a "run whether user is logged on or not" task. The latter changes the token, and Claude Code's login in the user profile must then still be usable. **Unverified.**
2. The `STOP-HOLD` DoS by a worker (P0).
3. No alert to the owner when the agent did not come back after a reboot.

## 6.2 Controlled reboot acceptance procedure (owner-executed)

**Preconditions (all must hold; abort otherwise):**

| # | Check | Command (PowerShell, Node and Git on PATH; `$CLI = "node E:\Agent\Personal-agent\dist\cli\index.js"`) | Expected |
|---|---|---|---|
| P1 | No running work | `& $CLI status` | queue 0, no RUNNING/CHECKPOINTING task (or a checkpoint recorded) |
| P2 | Health | `& $CLI health; $LASTEXITCODE` | 0 |
| P3 | Baseline captured | `& $CLI status > R\00-status.txt`; `Get-ScheduledTaskInfo ElevariqPersonalAgent > R\00-task.txt`; `Export-ScheduledTask -TaskName ElevariqPersonalAgent > R\00-task.xml`; read-only DB fingerprint (`scripts\fp.cjs`) → `R\00-db.json`; copy the tail of `wrapper.log` | saved |
| P4 | Backup | `& $CLI backup` | "verified" |
| P5 | No `STOP-HOLD` | `Test-Path $env:LOCALAPPDATA\ElevariqAgent\STOP-HOLD` | False |
| P6 | Owner available | — | the owner logs on right after boot |

**Procedure and checkpoints** (record the clock time at each step):

| Step | Action | Checkpoint | Pass | Fail → |
|---|---|---|---|---|
| R1 | **Restart** (Start → Restart) at T0 | — | — | — |
| R2 | Log on as Roman | T_logon | — | — |
| R3 | Within 2 min of logon | `Get-ScheduledTaskInfo ElevariqPersonalAgent` | LastRunTime ≥ T_logon | F1 |
| R4 | Within 3 min | `Get-Content $env:LOCALAPPDATA\ElevariqAgent\logs\wrapper.log -Tail 20` | "supervisor launched pid=…" after T_logon; **no** "exited code=…" restart loop | F2 |
| R5 | Within 5 min | `& $CLI health; $LASTEXITCODE` | 0, exactly one supervisor, heartbeat age < 60 s | F3 |
| R6 | | `& $CLI status` vs `00-status.txt` | same task counts; same last checkpoint id | F4 |
| R7 | | read-only DB fingerprint vs `00-db.json` | history fingerprints equal; `quick_check` ok; migrations 1–8,10,11 | F4 |
| R8 | | `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` | exactly one `index.js start` | F5 |
| R9 | 10 min after logon | `Get-ScheduledTaskInfo` | LastTaskResult `0` or `0x800710E0` (keepalive refused while running) | F2 |
| R10 | Repeat R1–R9 with **Shut down + power on** (Fast Startup path) | as above | as above | as above |
| R11 (optional) | Sleep 10 min, then wake | `status`; app log `supervisor.host_suspended`/resume events | no false TIMEOUT; resumes | F6 |

**Failure criteria and response:**

| Id | Symptom | Likely cause | Response |
|---|---|---|---|
| F1 | Task did not run at logon | Trigger disabled; logon trigger not firing after Fast Startup | Start it manually (`Start-ScheduledTask`); collect the `Microsoft-Windows-TaskScheduler/Operational` log; check the trigger |
| F2 | Wrapper restart loop / exit 2 | Config error, Node path, build missing | Read `supervisor-stderr.log`; the agent is down until fixed |
| F3 | Health not 0 after 5 min | Stale lease from before the reboot, DB lock | Wait one `LEASE_TTL_MS` (60 s) + keepalive (≤ 5 min); then investigate |
| F4 | State differs | Data loss | **Rollback trigger** (cutover runbook §4) |
| F5 | Two supervisors | Duplicate guard failure | Rollback trigger 4 (repeated crashes / duplication) |
| F6 | False TIMEOUT after wake | A11 regression | Record; not a reboot failure |

**Evidence to keep:** the `R\` folder, `wrapper.log`, the app log of the day, the Task Scheduler operational log export (`wevtutil epl Microsoft-Windows-TaskScheduler/Operational R\ts.evtx`; may need an elevated shell, and the log may be disabled by default: if empty, record that), and the times T0, T_logon, launch and health.

**Acceptance:** R3–R9 pass for **both** restart and shutdown/power-on. Record the measured time from logon to health. The expected bound is ≤ 5 min, set by the keepalive.
