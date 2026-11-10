# Production Cutover Runbook: V1 (`1b07468`, schema v8) → V2 (`e60278f`, schema v11)

**Status: WRITTEN, NOT EXECUTED by this assignment.**

> **Important:** this cutover was **already performed once**, on 2026-11-09 at 18:06–18:10 (+05:00), with the owner's authorization, in an earlier session. Record: `E:\Agent\v2-staging\deploy\20261109-180656\DEPLOYMENT_RECORD.md`.

Use this runbook:
- (a) to audit that deployment step by step (the "Done 18:07" column); or
- (b) to re-deploy V2 after a rollback; or
- (c) as the template for later releases.

Every step requires the owner's explicit authorization at the time it is run.

**Conventions:**
- **Shell:** PowerShell 5.1. Prepend `C:\Program Files\nodejs;C:\Program Files\Git\cmd` to PATH first.
- **Paths:** `$H = "$env:LOCALAPPDATA\ElevariqAgent"`, `$P = "E:\Agent\Personal-agent"`, `$CLI = "node $P\dist\cli\index.js"`.
- **Record:** create `$D = E:\Agent\v2-staging\deploy\<yyyyMMdd-HHmmss>` and log every step's output there.

## 1. Predeployment

| # | Item | Command / check | Pass criterion | Done 18:07 |
|---|---|---|---|---|
| 1.1 | Maintenance window | Pick a time with no RUNNING task and no owner work planned; ~15 min | Agreed by the owner | yes (implicit) |
| 1.2 | Owner authorization | Written "deploy V2 `e60278f`", naming the SHA | On record | yes ("deploy V2") |
| 1.3 | Release pinned | `git -C $P fetch; git rev-parse origin/main` = `e60278fcf6d6…`; tree = `b408a00a…` | exact SHA | yes |
| 1.4 | Release evidence current | WINDOWS_V2_TEST_RESULTS.md: 594/594 + 9/9 on `e60278f`; the migration rehearsal passed | present | regression re-done afterwards (this assessment) |
| 1.5 | Quiescence | `$CLI status`: queue 0 and no RUNNING / CHECKPOINTING task. If one is running, wait, or `task:pause <id>` and confirm a checkpoint (`task:show`) | 0 running | yes (queue 0, IDLE) |
| 1.6 | Credentials | `$CLI health` → `authenticationReady:true`; expiry more than 7 days away (currently 2026-12-04) | ready | yes |
| 1.7 | Disk space | `Get-PSDrive C,E`: at least 2 GB free on each | ok | C 310 GB, E 384 GB |
| 1.8 | Memory policy decided | Owner chooses `MIN/RESUME_FREE_MEMORY_MB` (PERFORMANCE §4). Otherwise the defaults stall work | decision recorded | **NO: still open** |
| 1.9 | Rollback artifacts ready | V1 SHA `1b07468` is in the repo (`git cat-file -t 1b07468` = commit); `V1_ROLLBACK_RUNBOOK.md` reviewed | ok | yes |

## 2. Deployment sequence

| # | Step | Command | Verify |
|---|---|---|---|
| 2.1 | Safe V1 suspension | `$CLI stop --hold` | exit 0; "supervisor stopped"; `$H\STOP-HOLD` exists; `wrapper.log` shows "exited code=0 … graceful stop"; no `node … index.js start` process left |
| 2.2 | DB backup (V1 tool) | `$CLI backup` | "… schema v8 verified"; note the file name and counts |
| 2.3 | Backup verification | `$CLI backup:verify "$H\backups\<file>"`, `Get-FileHash`, then copy the raw DB (the supervisor is stopped, so the WAL is checkpointed) to `$D\raw-db\` together with `SHA256SUMS.txt` | OK; hashes recorded |
| 2.4 | Record the baseline | Read-only fingerprint script (`scripts\fp.cjs`) → `$D\before.json` | saved |
| 2.5 | Activate the release | `git -C $P checkout -B deploy/v2 e60278f` (the working tree must be clean; `.env` is untracked and untouched) | `git rev-parse HEAD` = `e60278f…` |
| 2.6 | Dependencies | `package-lock.json` unchanged from V1, so **no install is needed**. If it ever changes: `npm ci` (with `.npmrc` `ignore-scripts=true`) | — |
| 2.7 | Build | `npm run build` (in `$P`) | exit 0 |
| 2.8 | Environment changes | Only if the owner decided 1.8: edit `$P\.env` (`MIN_FREE_MEMORY_MB`, `RESUME_FREE_MEMORY_MB`) after backing it up to `.env.bak-<date>`. No other variable is required; the new V2 variables have safe defaults | diff recorded |
| 2.9 | DB migration order | Automatic. When V2 first opens the DB it applies **v10, then v11** in one transaction each (`runMigrations`). There is no manual SQL | — |
| 2.10 | Scheduled-task switch | **None needed**: the task already runs `run-supervisor.ps1` from `$P`, so the code switch is the checkout. Do **not** edit the task | `Export-ScheduledTask` identical to `evidence\scheduled-task-export.xml` |
| 2.11 | Supervisor start | `Remove-Item $H\STOP-HOLD`, then `Start-ScheduledTask -TaskName ElevariqPersonalAgent` | `wrapper.log` "supervisor launched pid=…" |
| 2.12 | Health checks | wait 20 s; `$CLI health` (exit 0); `$CLI status` | one supervisor, IDLE / RUNNING, provider OK |
| 2.13 | Migration verification | fingerprint script → `$D\after.json` | versions 1–8,10,11; history fingerprints equal `before.json`; integrity ok |
| 2.14 | Queue verification | `$CLI tasks`, `$CLI approvals`, `$CLI inbox` | counts equal the baseline; no unexpected PENDING |
| 2.15 | Logging verification | `$H\logs\app\agent-<date>.log` has `supervisor.started`; `supervisor-stderr.log` is empty | ok |

## 3. Postdeployment validation (first 24 h)

| Check | How | Expected |
|---|---|---|
| Agent startup | `health` | exit 0 |
| Queue restoration | `tasks` | the same tasks and statuses as the baseline |
| Checkpoint recovery | `status` "Last checkpoint" | the same id as before (`chk_mw8df2ugc015f6a248` for the 18:07 deployment) |
| Worker execution | The owner enqueues one small, low-risk CODING task with `--criteria` | executes; `worker.launched` / `worker.terminated` |
| Independent QA | `qa` | the review task runs; PASSED or FAILED with citations |
| Dashboard | `dashboard` (owner only; local 127.0.0.1) | loads; inbox matches the CLI |
| Owner notifications | `inbox`, `notifications.jsonl` | events delivered once |
| Approval controls | Any consequential action → `approvals` shows it PENDING; the owner decides | not auto-approved |
| DB integrity | read-only `PRAGMA quick_check` | ok |
| Resource usage | `resource_deferred` events; supervisor WS | WS under 200 MB; deferral understood (1.8) |

## 4. Rollback triggers (any one → execute V1_ROLLBACK_RUNBOOK.md)
1. DB integrity failure: `quick_check` not ok, FK violations, or the migration not recorded as 10 and 11.
2. Loss of task state: any history fingerprint differs from the baseline, or tasks, approvals or executions are missing.
3. Failed checkpoint recovery: an interrupted task is not reconciled within 10 min, or resumes in a new session when the old one was available.
4. Repeated supervisor crashes: 3 or more non-zero exits in `wrapper.log` within 1 h, or a heartbeat stale for more than 5 min while the process is alive.
5. Unauthorized worker actions: any approval decided by something other than the owner, any write outside the workspace, any production `.env` / DB change attributed to a worker.
6. Critical permission violations: owner-only commands succeeding from a worker; policy-file tampering.
7. Unacceptable resources: host available RAM below 200 MB for more than 5 min attributable to the agent, or the supervisor's WS above 1 GB.
8. An owner-visible defect that blocks the owner's work and has no workaround.

**Not a trigger:** `resource_deferred` caused by low host memory. That is the A9 gate working as designed; address it with the 1.8 decision.
