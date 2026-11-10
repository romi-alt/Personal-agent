# Production Health Assessment (read-only)

**Inspected:** 2026-11-09 18:13–18:25 (+05:00), on host DESKTOP-QGGLG8D.

## 0. Critical correction to the assignment's premise

The assignment says "production remains V1". **That is not the current state.** I verified this directly:

| Fact | Evidence |
|---|---|
| `E:\Agent\Personal-agent` is on local branch `deploy/v2` @ `e60278fcf6d6…` (= `main` = PR #4 merge). Working tree clean | `git rev-parse`, `git status` (`evidence\release-integrity.txt`) |
| V2 was deployed into production on **2026-11-09 18:06–18:10 (+05:00)**, authorized by the owner ("deploy V2"), in an earlier session | `E:\Agent\v2-staging\deploy\20261109-180656\DEPLOYMENT_RECORD.md` and step logs 01–06 |
| The live DB already has migrations **1–8, 10, 11** (applied at 1794229678308 = 18:07:58 +05:00) | `evidence\live-db-inspection.json` |
| The running supervisor (pid 8992, started 18:07:57) executes `E:\Agent\Personal-agent\dist\cli\index.js` built from `e60278f` | process inspection (`evidence\processes.txt`), `04-build.log` |
| The previous V1 (`1b07468`, branch `feat/windows-compat`) was stopped gracefully (`stop --hold`, exit 0) and backed up before the switch | `01-stop-hold.log`, `02-backup.log` |

So this document assesses **the production agent as it runs now (V2 `e60278f`)** and the **readiness of a rollback to V1**. Nothing in this assignment changed production. Every check below is read-only.

## 1. Supervisor and processes

| Check | Observation | Verdict |
|---|---|---|
| Supervisor | `node.exe` pid **8992**, cmd `…\Personal-agent\dist\cli\index.js start`, started 18:07:57, working set 46 MB | Healthy |
| Parent | `powershell.exe` pid 13380 (`run-supervisor.ps1 -RepoPath E:\Agent\Personal-agent`), started 18:07:55, launched by the scheduled task | Expected |
| DB supervisor row | instance `sup_63ce8e39`, pid 8992, status **IDLE**, `stop_requested=0`, no current task, no `last_error`, heartbeat 1 s old | Healthy |
| Workers | None running. 0 open executions, 0 leased tasks | Expected: the queue is empty |
| Stale or duplicate supervisors | Only one supervisor process and one wrapper | Healthy |
| Wrapper history (`wrapper.log`) | All exits since 11-07 16:14 were graceful (code 0) except one. **Wrapper 10644 / supervisor 21692 (11-07 17:05) has no exit record**, and a new wrapper started at 17:31. This matches the earlier "unclean death under memory pressure" incident (A9). It was recovered by the 5-minute keepalive trigger | One historical unclean death, recovered automatically |
| Host | 8029 MB RAM; **970 MB available** and ~1.1 GB commit headroom at 18:14; 261 processes. Largest consumers: Claude desktop renderer 1.06 GB, Memory Compression 0.88 GB, WebView2 0.6 GB, Claude Code CLI 0.29 GB | **Memory-constrained** (see §5) |
| Last boot | 2026-11-05 03:44. There have been sleep/wake cycles since (Kernel-Power 42, Power-Troubleshooter 1), with no Kernel-Power 41/6008 (unexpected shutdown) in the last 4 days | The supervisor survived sleep/resume |

## 2. Windows Task Scheduler: `ElevariqPersonalAgent` (not modified; definition exported to `evidence\scheduled-task-export.xml`)

| Setting | Value |
|---|---|
| Triggers | (1) At logon of `DESKTOP-QGGLG8D\Roman`; (2) time trigger from 2026-11-07 15:41:48, **repeating every 5 min** (keepalive), no end |
| Action | `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "E:\Agent\Personal-agent\scripts\windows\run-supervisor.ps1" -RepoPath "E:\Agent\Personal-agent" -NodePath "C:\Program Files\nodejs\node.exe"` |
| Working directory | `E:\Agent\Personal-agent` (the supervisor loads `.env` from here) |
| Principal | `Roman`, LogonType **Interactive** (runs only while the user is logged on), RunLevel **Limited** (not elevated) |
| MultipleInstances | **IgnoreNew** |
| Restart on failure | 999 × every 1 min. Execution time limit: none. StartWhenAvailable: true. Battery restrictions: off |
| Last run / result | 18:11:49, **0x800710E0** ("The operator or administrator has refused the request") |
| Next run | 18:16:48 (5-minute keepalive) |

**Interpreting 0x800710E0:** this is what the scheduler records when a trigger fires while an instance is already running and `MultipleInstances=IgnoreNew` refuses the new one. The wrapper pid 13380 is alive and running, so the code means the keepalive found the agent already running. **It is not an operational fault.** The application has its own duplicate protection as a second layer: the supervisor lease, exit code 3, and wrapper monitoring.

**Environment and configuration loading:** the wrapper sets `LOG_TO_CONSOLE=false` and `cd`s into the repo, and the app reads `.env` from there. Production `.env` (values shown, secrets redacted; none are present):
- `ENVIRONMENT=production`
- `EXECUTION_PROVIDER=claude-cli`
- `ALLOW_PAID_API=false`
- `MAX_BUDGET_USD_PER_EXECUTION=0` and `DAILY_BUDGET_USD=0`
- `MAX_CONCURRENT_WORKERS=1`
- `PLAN_APPROVAL=required`
- `WORKER_TIMEOUT_MS=1800000`
- `HEALTH_PORT=0` (no listener; pid 8992 has 0 listening sockets)
- `INTEGRATION_ERP_ENABLED=false` and `INTEGRATION_CRM_ENABLED=false`

`MIN_FREE_MEMORY_MB` and `RESUME_FREE_MEMORY_MB` are **not set**, so the V2 defaults of 1024 and 1536 apply.

## 3. Persistent state (read-only connection plus online-backup snapshot)

The DB was opened with `readonly:true, fileMustExist:true`. A consistent snapshot was taken with the SQLite online-backup API (not a raw file copy of a WAL database). The main file's size and mtime were the same before and after.

| Item | Value |
|---|---|
| Journal mode | WAL |
| `PRAGMA quick_check` (live) / `integrity_check` (snapshot) | ok / ok |
| Foreign-key violations | 0 |
| Schema versions | 1–8, 10, 11 (v9 is reserved and intentionally absent) |
| Tasks | 141, all COMPLETED. Pending, running, waiting, blocked: **0** |
| Executions / checkpoints | 157 / 157. **Interrupted (open) executions: 0** |
| Approvals | 9, all APPROVED: access_change 3, destructive_delete 1, live_database_migration 1, plan_approval 1, qa_escalation 3. **Pending: 0** |
| QA reviews | 65 (PASSED 43, FAILED 19, OWNER_ACCEPTED 3). 66 `qa_review_tasks` links (A3 backfill) |
| Project | ELEVARIQ Retail Operations Portal, lifecycle **VERIFYING**, status ACTIVE. Progress "0% verified (100% claimed); 0/69 tasks verified" (V2's stricter evidence model; see deployment record) |
| Requirements / milestones | 41 REVIEWED / 2 ACCEPTED + 5 REVIEWED (A4 reconciliation) |
| Workflow runs | 1 (plan_project, COMPLETED) |
| Last checkpoint | `chk_mw8df2ugc015f6a248`, pilot repo @ `1ae7d2fe` |
| Outstanding owner decisions | Inbox: 1 item, "All tasks finished - verification needed" (project acceptance). There is no pending approval row |
| Recent warnings | `supervisor.resource_deferred` at 18:07:58 and 18:14:28 (memory gate closed, with one `resource_resumed` between them). Earlier `auth.not_ready` ×7 (11-08 ~19:00–20:00 UTC), followed by `auth.ready`. `provider.rate_limit` ×5 during the pilot |

Snapshot: `db\live-snapshot-v11.db`, 7,720,960 bytes, sha256 `75f00d6b34a31d49ff7b28164368cce5b38e2b6a9c8ebffd2a2b580c7b1ae290`, taken in 58 ms. It is stored outside the production directory and used only for the rehearsals.

## 4. Credential safety
- Claude Code CLI 2.1.319 is installed at `%USERPROFILE%\.local\bin\claude.exe`.
- `%USERPROFILE%\.claude\.credentials.json` is **present**. I checked only its existence, size and mtime, never its contents.
- The agent's own readiness check reports "ready - claude.ai login (max), expires **2026-12-04T23:36Z**" (deployment `05-start-health.log`). It does this without printing tokens; `provider_state` stores only a credential *fingerprint*.
- The secret scan of tracked files found 0 matches (`logs\regression-e60278f\summary.txt`, step 06).
- **Risk:** the login expires in about 25 days and must be renewed by the owner before then. Workers can read the credential file (see SECURITY_GOVERNANCE_ASSESSMENT.md §2).

## 5. Recovery capability (evidence-based; nothing was crashed, suspended or restarted)

| Scenario | Evidence | Assessment |
|---|---|---|
| Supervisor process crash | The wrapper restarts it on any non-0/2/3 exit with 10 s → 5 min backoff (`run-supervisor.ps1`). Staging rehearsal F6 killed a supervisor during a RUNNING task: it was reconciled and resumed (DATABASE_MIGRATION_REHEARSAL.md) | Verified in staging |
| Wrapper and supervisor both die | 5-minute keepalive trigger + IgnoreNew. Real incident 11-07 17:05 → 17:31 recovered (`wrapper.log`) | Verified by a real incident |
| Host sleep/resume | Several sleep cycles 11-08/11-09; the supervisor stayed alive. A10/A11 sleep-aware timers are unit-tested | Verified (observation + tests) |
| Windows reboot | Logon trigger. **No reboot has happened since the task was installed (last boot 11-05), so it has never been observed.** Because the task is Interactive, the agent does **not** run after a reboot until `Roman` logs on | **Unverified.** A manual reboot check is still open |
| STOP-HOLD | The wrapper exits without starting while `%LOCALAPPDATA%\ElevariqAgent\STOP-HOLD` exists. Used in the 18:06 deployment | Verified (deployment logs) |

## 6. Verdict

**Production (V2 `e60278f`) is healthy and idle.**
- One supervisor, fresh heartbeat, provider OK.
- DB integrity ok; 0 pending, running or blocked tasks; 0 pending approvals; 0 open executions.
- History counts identical to the pre-upgrade baseline.
- Scheduler status code 0x800710E0 is the expected IgnoreNew refusal.

**Operational concern:** with ~0.8–1.4 GB typically available and the V2 defaults of 1024 / 1536 MB, the memory gate is **closed most of the time**. New work (including QA reviews) would be deferred, so the agent cannot be relied on to make progress until the owner sets thresholds that suit this host or frees memory. This is the open owner decision from the deployment.

**V1** no longer runs in production. Its rollback artifacts are intact:
- pre-upgrade backup `agent-2026-11-09T13-07-14-592Z.db`, sha256 `b7ed5834…ed22`, matching its `.json` manifest;
- raw copy `raw-db\agent.db`, sha256 `325783bd…89c8`, matching `SHA256SUMS.txt`;
- commit `1b07468`, which remains in the repository.
