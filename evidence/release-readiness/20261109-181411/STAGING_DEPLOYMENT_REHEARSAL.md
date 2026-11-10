# Staging Deployment Rehearsal: V2 `e60278f` on Windows 11

**When:** 2026-11-09 18:29–18:34 (+05:00), plus the QA re-run at 18:37.

**Scripts:**
- `scripts\migration-rehearsal.ps1` (phases F and G)
- `scripts\qa-correction-rerun.ps1`

**Logs:** `logs\rehearsal\`, `logs\rehearsal-qa-rerun\`.

**Failed harness attempt kept:** `logs\rehearsal-qa-rerun-attempt1-INVALID-no-git-on-PATH\`. My script left Git off PATH, so `assignment:add` failed with `spawn git ENOENT`. This was a harness error, not a product defect.

## Isolation (separate from production in every dimension)

| Dimension | Staging | Production |
|---|---|---|
| Code | `E:\Agent\v2-staging\rr\v2-e60278f\dist` (clean clone) | `E:\Agent\Personal-agent\dist` |
| Database / home | `E:\Agent\v2-staging\rr\stage\home` (a **copy** of the production pre-upgrade backup, migrated in staging) | `%LOCALAPPDATA%\ElevariqAgent` |
| Configuration | Environment only; `AGENT_ENV_FILE` points to a nonexistent file; cwd is the staging root (no `.env`) | `E:\Agent\Personal-agent\.env` |
| Provider | `mock` (scripted scenario; no Claude, no billing, no credentials) | `claude-cli` |
| Workspaces | `stage\workspaces` (the pilot project re-pointed to a clone of the pilot bundle) | `%LOCALAPPDATA%\ElevariqAgent\workspaces` |
| Ports | `HEALTH_PORT=0`; dashboard not started. Browser tests use 127.0.0.1:43000–44500 (random) | none listening |
| Scheduler | Supervisors launched with `start --detach`; **only recorded PIDs were ever stopped** | `ElevariqPersonalAgent` (untouched) |
| ERP/CRM | `INTEGRATION_ERP_ENABLED=false`, `INTEGRATION_CRM_ENABLED=false`; no adapters configured | disabled |

## Steps and observed behaviour

| # | Step | Command(s) | Observed |
|---|---|---|---|
| 1 | Staging startup and configuration validation | `doctor` (V2) | exit 0 |
| 2 | Configuration validation for a new project | `assignment:add`; `assignment:set-verification` without `--by`, then with it | exit 0; **exit 2** ("--by is required"); exit 0 with 1 `assignment.verification_changed` event |
| 3 | DB migration on staging data | `doctor` | v8 → v11 in 919 ms (DATABASE_MIGRATION_REHEARSAL.md) |
| 4 | Task intake policy | `task:add` without criteria; with criteria; duplicate key | **exit 2, no row** ("a coding task needs enforceable acceptance criteria"); exit 0; duplicate → `task.enqueue_duplicate`, not re-queued |
| 5 | Supervisor init | `start --detach` | pid 15748; idle working set **145 MB** |
| 6 | Worker processing | 5 tasks | Feature A COMPLETED (1 exec); Flaky B: PROCESS_CRASH → retry → ok; Fatal C: TASK_FAILURE ×2 → **FAILED** (max-retries 1; failure never reported as success); Deploy E: PERMISSION_DENIED → **WAITING_FOR_APPROVAL** (`publish_release`) |
| 7 | Independent QA | automatic review tasks | Feature A round 1 **PASSED**. Flaky B round 1 **FAILED** → correction task created → round-2 review (not scripted in my scenario: invalid output) → 2 repairs → **ESCALATED to the owner** (`qa_escalation` PENDING). Never passed without evidence. **Targeted re-run with the round-2 review scripted: round 1 FAILED → "Fix: Flaky B (QA round 1)" → round 2 PASSED** |
| 8 | Owner approval handling | worker env `approve` / `project:accept`; owner `deny` | **exit 2 / exit 2** ("owner-only command"); deny exit 0 → `publish_release:DENIED:owner-cli`; Deploy E → **BLOCKED**, never COMPLETED |
| 9 | Controlled failure and recovery | added Long D (hangs on attempt 1); **killed the rehearsal-owned supervisor pid 15748** while Long D was RUNNING | Long D stayed RUNNING (orphaned). Restart (pid 8368) → `recovery.task_reconciled` within **3.4 s** of the kill (staging `LEASE_TTL_MS=3000`) → INTERRUPTED → ok in the **same session**, 0 retries consumed → QA **PASSED** |
| 10 | Duplicate-supervisor prevention | second `start --detach` | Second instance (pid 12476) exited by itself; **0 overlapping executions** |
| 11 | Health | `status`, `health` | exit 0; `{"database":true,"supervisorLive":true,"authenticationReady":true,"providerState":"OK"}` |
| 12 | Project verification | `project:verify` | BUILD_PASSES / TESTS_PASS **PASSED** (exit 0); CHANGES_EXIST PASSED; SECURITY_CHECKS_PASS PASSED (0 findings); CLAIMED_COMPLETE **FAILED** (correct: one FAILED and one BLOCKED task); REQUIREMENTS_SATISFIED NOT_EVALUATED (no planned requirements); "delivery ready: NO" |
| 13 | Safe cleanup | `scratch:clean … .tmp-staging`; `scratch:clean … src` | removed; **refused (exit 1), `src` kept** |
| 14 | Memory gate | restart with `MIN/RESUME_FREE_MEMORY_MB=60000`, add Gate G; then restart with 0 | Gate G **QUEUED, 0 executions, 1 `supervisor.resource_deferred`** after 12 s; with the gate off it ran and was reviewed **PASSED in 2.1 s** |
| 15 | Shutdown | `stop --wait 30000` (×3) | exit 0 each time; no rehearsal-owned process left alive |
| 16 | Isolated rollback and restart | V1 `restore` → `doctor` / `status` → `start` → `health` → `stop` | all exit 0; DB equals the pre-upgrade baseline (DATABASE_MIGRATION_REHEARSAL.md R1–R4) |

**Final staging tallies (F11):**
- 14 new tasks, 5 QA rounds (3 PASSED, 1 FAILED, 1 ESCALATED);
- approvals `publish_release:DENIED`, `qa_escalation:PENDING`;
- 17 workers launched, 17 checkpoints created, 0 overlaps.

**Pre-existing production rows: all 15 history tables unchanged (F12).**

## Production non-interference (verified)

| Check | Evidence | Result |
|---|---|---|
| No production process stopped | Supervisor pid 8992 alive, same start time 18:07:57, before and after every regression step and at the end of the rehearsal | PASS |
| No production task consumed | Every staging supervisor used a staging `AGENT_HOME`; the live DB was only opened read-only, once, for inspection (18:15) | PASS |
| No production DB modified | The live DB was opened only with `readonly:true`; main-file size and mtime unchanged by that read | PASS |
| No ERP/CRM system changed | Integrations disabled in staging and production; no adapters configured | PASS (configuration-level; no network capture) |
| No production port taken | Production has no listening socket; staging health and dashboard were off; browser tests used 127.0.0.1:43000–44500 | PASS |
| No production scheduler change | `Export-ScheduledTask` XML identical at the start and end of the rehearsal; saved to `evidence\scheduled-task-export.xml` | PASS |

## Failures and deviations recorded
1. **F4 wait timed out after 180 s.** This was caused by my scenario: the round-2 review was not scripted, which led to the correct escalation. It was resolved by the targeted re-run (row 7).
2. **The QA re-run's first attempt was invalid** (Git missing from the harness PATH). It is kept, labelled INVALID.
3. **The R6 comparison printed `False` for 2 tables** because the comparison script was missing those baseline fingerprints. Re-checked: identical (DATABASE_MIGRATION_REHEARSAL.md).

No V2 product defect was found in staging.

## Not covered
- **Real Claude CLI workers.** The provider was mocked, so token usage, usage-limit messages and real worker memory were not exercised.
- **The real Windows Task Scheduler start path for V2.** That was exercised once in the 18:07 production deployment (`05-start-health.log`), not in staging.
- **A real host sleep and reboot.**
