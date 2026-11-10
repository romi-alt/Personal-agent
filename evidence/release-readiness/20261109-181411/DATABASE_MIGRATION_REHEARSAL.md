# Database Migration and Rollback Rehearsal: V1 (v8) → V2 `e60278f` (v11) → V1

**When:** 2026-11-09 18:29:11 – 18:33:53 (+05:00).

**Script:** `scripts\migration-rehearsal.ps1`.

**Log and outputs:** `logs\rehearsal\` (`rehearsal.log`, one `.txt` per CLI call, one `.json` fingerprint per stage).

**Isolation:**
- Staging root `E:\Agent\v2-staging\rr\stage`, with its own `AGENT_HOME`, workspaces and mock provider.
- No `.env`, integrations off, health server off.
- Builds: V2 from the clean clone `rr\v2-e60278f`; V1 from the clean clone `rr\v1-1b07468` (`npm ci` + build, exit 0).
- The live DB was **never opened by the rehearsal**. The production pre-upgrade backup file was only **read** (copied).

**Production undisturbed:**
- At the end the production supervisor was the same pid 8992 with the same start time (18:07:57).
- The exported scheduled-task XML was identical before and after (`end` line in the log).

## Context
**The live production DB was already migrated to v11** at 18:07:58 today, in the owner-authorized deployment. This rehearsal therefore serves two purposes:
1. an **independent re-verification** of that migration on the **exact pre-upgrade production data**;
2. a full **rollback-to-V1 rehearsal**, which is the only change still pending a possible owner decision.

## E. Migration rehearsal

| Step | Action | Result | Time |
|---|---|---|---|
| E1 | Copy the production pre-upgrade backup `agent-2026-11-09T13-07-14-592Z.db` (made by V1 `backup` at 18:07:14 just before the switch) to `stage\golden\` | sha256 `B7ED5834…ED22` = the value in its `.json` manifest: **match** | 13 ms |
| — | Independent fallback artifact `deploy\20261109-180656\raw-db\agent.db` | sha256 `325783bd…89c8` = `SHA256SUMS.txt`: **match** | — |
| E2 | Integrity of the golden copy | `integrity_check` ok, 0 FK violations, versions 1–8, 141 tasks / 157 executions / 9 approvals | — |
| E3 | Staging copy. The project `repo_path` was re-pointed to a staging clone of the pilot bundle. `supervisor_state.pid` was neutralized so that no staging process could refer to a production PID | Baseline schema hash `3eee365e…`; history fingerprints recorded (`E3-baseline-v8.json`) | — |
| E4 | Pre-upgrade backup with **V1's own tool** (`backup`, then `backup:verify`) | exit 0 / exit 0; 7,684,096 bytes | **640 ms** backup, 468 ms verify |
| E5 | **V2 opens the DB** (`doctor`) → migrations applied | exit 0. Versions 1–8, **10, 11**. `integrity_check` ok, 0 FK violations, 0 duplicate migration names | **919 ms** (including process start) |
| E6 | Schema objects | **Added:** `table:qa_review_tasks`, `index:idx_qa_review_tasks_task`, `table:progress_snapshots`, `index:idx_progress_project`; column `requirements.owner_task_id`. **Removed:** none | — |
| E6 | Schema equivalence | Schema hash migrated = **fresh V2 install** = **live production** = `94805f79…`. The upgrade path produces exactly the release schema | — |
| E7 | History intact (v8-column fingerprints of 16 tables: projects*, tasks, executions, checkpoints, approvals, qa_reviews, task_transitions, verification_evidence, assignments, plan_tasks, requirements†, task_outputs, project_documents, adrs, workflow_runs, workflow_steps) | **16/16 identical** | — |
| E8 | Existing records interpretable through V2 read paths (`projects`, `project:status`, `tasks`, `qa`, `approvals`, `roadmap`, `inbox`, `recovery`) | All exit 0. Tasks listed **141**, approvals **9**, QA rows **65** | 0.4–0.6 s each |
| E9 | Backfill | `qa_review_tasks` = **66** (65 rounds + 1 repair re-dispatch) | — |
| E10 | Migration identifiers | Versions are unique (`schema_migrations.version` is the PRIMARY KEY), names are unique, and the sequence is 1–8, 10, 11. **v9 is intentionally reserved** (comment in `migrations.ts:489-490`). Main's stage-5 migration was renumbered from 4 to 11 during integration | — |

\* projects: the columns V2 recomputes (`updated_at`, `current_milestone`, `progress_summary`) are excluded.
† requirements: `status` is excluded because V2 reconciles it (A4).

### Queue operations on the migrated production copy (details in STAGING_DEPLOYMENT_REHEARSAL.md)
- A new project was registered, 14 tasks were processed and 5 QA rounds run, including:
  - a crash and recovery;
  - an approval denial;
  - a memory-gate deferral.
- **Afterwards all 15 history tables of the pre-existing production rows were still identical** (F12, fingerprinted with `rowid <=` baseline).
- Execution overlaps: **0**.

## R. Rollback rehearsal

### R1–R4: rollback by restoring the pre-upgrade snapshot (the documented procedure)

| Step | Action | Result | Time |
|---|---|---|---|
| R0 | V2 staging supervisor stopped (`stop --wait`); no rehearsal-owned process left | ok | — |
| R1 | **V1** `restore <pre-v2-backup> --reason …` | exit 0. The previous (v11) DB is kept automatically as `agent.db.pre-restore-<ts>` | **606 ms** |
| R1 | Restored schema | Versions **1–8**. Schema hash `3eee365e…` = the pre-upgrade schema. integrity ok, 0 FK violations | — |
| R1 | Data | **16/16 history fingerprints = pre-upgrade baseline**. 141 tasks, all COMPLETED | — |
| R2 | V1 `doctor`, `status`, `tasks` | exit 0, 0, 0 | 0.4–0.7 s |
| R3 | V1 supervisor `start --detach` → `health` | started (pid 18468). `health` → `{"database":true,"supervisorLive":true,"authenticationReady":true,"providerState":"OK"}` | 0.4 s start |
| R3 | Duplicate V1 start | Second instance (pid 13264) exited by itself; no leftover process at the end | — |
| R4 | V1 `stop`; re-fingerprint | exit 0. History is still equal to the baseline after V1 ran on it | 1.0 s |

### R5: forward-compatibility probe (V1 code on a V2 v11 database, throwaway copies)

| Copy | V1 doctor / status / start / health / stop | Result |
|---|---|---|
| Staging DB after V2 processing (v11; 155 tasks including 1 BLOCKED and 1 FAILED created by V2) | all exit 0 | integrity ok; versions are still 1–8, 10, 11 (V1 ignores the unknown tables and columns) |
| **Live production snapshot** (v11, taken 18:15) | all exit 0 | integrity ok; 141 COMPLETED |

**Meaning:** V1 can run on a v11 database without errors. So **rolling back the code alone, without restoring the DB, is technically possible**. It is *not* the recommended path:
- V1 does not maintain the V2-only structures: the `qa_review_tasks` links, `requirements.owner_task_id`, A4 status ownership and progress snapshots.
- Any later re-upgrade to V2 would then find those structures stale.
- Restoring the snapshot is cleaner when nothing important has been written since the upgrade.

### R6: what a restore-based rollback would lose *today*
Comparison of the live production snapshot (18:15) with the pre-upgrade backup (18:07). Pre-existing rows were compared like for like; the re-check is in this document's evidence.

| Table | Pre-upgrade | Live now | New since upgrade | Pre-existing rows identical |
|---|---|---|---|---|
| projects, tasks, executions, checkpoints, approvals, qa_reviews, task_transitions, verification_evidence, assignments, plan_tasks, requirements (v8 cols), task_outputs, project_documents, adrs, workflow_runs, workflow_steps | — | — | **0 in every table** | yes |
| activity_events | 2276 | 2281 | **5** (supervisor start/stop, `roadmap.status_reconciled`, 2 memory-gate events) | yes (re-checked with matching filters: `e72cac52…` = `e72cac52…`) |
| milestones | 7 | 7 | 0 (statuses reconciled by V2: PLANNED → 2 ACCEPTED + 5 REVIEWED) | yes for the v8 columns |
| progress_snapshots, qa_review_tasks | (do not exist in v8) | 1, 66 | V2-derived | — |

The first R6 run printed `preexisting-rows-identical=False` for `activity_events` and `milestones`. That was a defect in my comparison script: the baseline omitted those two fingerprints. Re-run with the same filters on both sides, they are identical. The original log line is preserved.

**So, as of 18:15, a restore-based rollback loses only:**
- 5 operational events;
- V2-derived status and progress data that V2 would recompute anyway.

**No owner decisions, tasks, approvals or execution records have been created since the upgrade.**

**Future data-loss exposure.** Every write made after the upgrade is lost by a snapshot restore:
- new tasks, executions, checkpoints, approvals and owner decisions;
- QA reviews and evidence.

This exposure grows from the moment V2 starts real work.
- To roll back after V2 has done real work, either:
  - (a) run V1 on the v11 DB (R5: technically possible, V2 structures go stale), or
  - (b) restore the snapshot and **re-enter** what is missing from an export of the post-upgrade rows. The `agent.db.pre-restore-*` copy that `restore` keeps makes this possible.
- I recommend deciding rollback within the first 24 h, before production work resumes, or accepting option (a).

## Durations (observed on this host)

| Operation | Duration |
|---|---|
| Online-backup snapshot of the live DB (7.7 MB, read-only connection) | 58 ms |
| File copy of the backup | 13 ms |
| V1 `backup` + verify | 640 ms + 468 ms |
| V2 migration v8 → v11 (`doctor`, including Node start) | 919 ms |
| V1 `restore` (including the safety copy) | 606 ms |
| V1 supervisor start after restore → healthy | under 9 s (health was checked after 8 s) |

## Verdict
- **Migration rehearsal: PASS.**
  - The exact pre-upgrade production data migrated cleanly.
  - The schema is identical to a fresh install and to live production.
  - All history is intact and readable.
  - Queue operations work on the migrated data.
- **Rollback rehearsal: PASS.**
  - The V1 restore of the pre-upgrade snapshot reproduces the exact v8 baseline.
  - V1 starts and reports healthy on it.
  - V1 also runs on v11 (forward-compatible).
- **Not rehearsed:**
  - Rollback **in the production paths** (the real `%LOCALAPPDATA%`, the real scheduled task and the production checkout). Executing it is not authorized.
  - The **scheduled-task** part of the rollback: there is only one production task, and it was not touched.
  - Rollback after significant new V2 production writes. That data-loss trade-off is documented above.
