# V1 Rollback Runbook: V2 `e60278f` (v11) → V1 `1b07468` (v8)

**Status: WRITTEN, NOT EXECUTED in production.**

**Rehearsed** on isolated copies of the production data on 2026-11-09 18:33 (DATABASE_MIGRATION_REHEARSAL.md R1–R5): **PASS**.
- V1 restore took 606 ms.
- The restored DB equals the pre-upgrade baseline in 16/16 history tables.
- V1 starts and reports healthy.

**Executing this runbook requires the owner's explicit authorization.**

**Conventions:**
- `$H = "$env:LOCALAPPDATA\ElevariqAgent"`, `$P = "E:\Agent\Personal-agent"`, `$CLI = "node $P\dist\cli\index.js"`.
- Prepend Node and Git to PATH.
- Log everything to a new `E:\Agent\v2-staging\deploy\<ts>-rollback\`.

## 0. Choose the rollback mode

| Mode | When | Data consequence |
|---|---|---|
| **A: restore the pre-upgrade snapshot (default)** | Shortly after the upgrade, while V2 has produced no work worth keeping. As of 18:15 there are only 5 operational events (R6) | **Everything written after 18:07:14 is lost**: tasks, executions, approvals, owner decisions, QA and evidence. The V2 DB is kept automatically as `agent.db.pre-restore-<ts>` for forensics or re-entry |
| **B: code-only rollback (V1 on the v11 DB)** | V2 has already done real work that must be kept | No data loss. V1 runs on v11 without errors (rehearsal R5). V2-only structures (`qa_review_tasks`, `requirements.owner_task_id`, progress snapshots, A4 status ownership) go **stale**. A later re-upgrade must be re-validated |

## 1. Rollback artifacts (verified 2026-11-09 18:2x)

| Artifact | Location | Integrity |
|---|---|---|
| Pre-upgrade backup (V1 `backup`, schema v8) | `$H\backups\agent-2026-11-09T13-07-14-592Z.db` | sha256 `b7ed5834716d6b224c32d04d7c0884daa7e4bf76b91e42df120aa7ee4fe0ed22` = the `.json` manifest |
| Raw copy (supervisor stopped) | `E:\Agent\v2-staging\deploy\20261109-180656\raw-db\agent.db` | sha256 `325783bde6617885e9ac05134bb328222ebfe6e39b2b3b862f8136b04b3a89c8` = `SHA256SUMS.txt` |
| V1 code | commit `1b0746862fc1…` (branch `feat/windows-compat`) in `$P` | `git cat-file -t 1b07468` = commit |
| V1 configuration | `$P\.env` (unchanged by the V2 deploy) | `.env` is untracked |
| Scheduled task | unchanged across versions | `evidence\scheduled-task-export.xml` |

## 2. Procedure: Mode A (restore)

| # | Step | Command | Verify |
|---|---|---|---|
| 1 | Record the state | `$CLI status > $D\00-status.txt`; read-only fingerprint (`scripts\fp.cjs $H\agent.db`) → `$D\00-v2-final.json` | saved |
| 2 | Stop V2 and hold | `$CLI stop --hold` | exit 0; `$H\STOP-HOLD` exists; no `index.js start` process; `wrapper.log` "graceful stop" |
| 3 | Preserve V2 evidence | `$CLI backup --path "$D\v2-final-backup"` (V2 tool, schema v11, verified); copy `$H\logs` to `$D\logs-v2` | backup verified |
| 4 | Verify the rollback artifact | `(Get-FileHash $H\backups\agent-2026-11-09T13-07-14-592Z.db).Hash` | = `B7ED5834…ED22` |
| 5 | Switch the code to V1 | `git -C $P checkout feat/windows-compat` (= `1b07468`; working tree must be clean); `npm run build` | `git rev-parse HEAD` = `1b07468…`; build exit 0 |
| 6 | Restore with V1 | `$CLI restore "$H\backups\agent-2026-11-09T13-07-14-592Z.db" --reason "v2 rollback: <trigger>"` | "restored …"; "previous database kept at …pre-restore-<ts>" |
| 6b | Fallback if step 6 fails | With the supervisor stopped: rename `$H\agent.db*` to `agent.db.failed-<ts>*`, copy `raw-db\agent.db` to `$H\agent.db`, and check its hash against `SHA256SUMS.txt` | hash matches |
| 7 | Verify the DB | fingerprint → `$D\07-restored.json` | versions **1–8**; integrity ok; history fingerprints equal the pre-upgrade baseline (`deploy\20261109-180656\06-before.json`) |
| 8 | Restart under the scheduler | `Remove-Item $H\STOP-HOLD`; `Start-ScheduledTask -TaskName ElevariqPersonalAgent` | `wrapper.log` "supervisor launched" |
| 9 | Health | after 20 s: `$CLI health` (exit 0), `$CLI status` | one supervisor; queue matches the baseline (0 queued, 141 COMPLETED) |
| 10 | Record | Write `ROLLBACK_RECORD.md` in `$D` (trigger, times, hashes, data lost: list of rows newer than 18:07:14 from `00-v2-final.json`) | saved |

## 3. Procedure: Mode B (code only)
Run steps 1, 2, 3 and 5 as in Mode A. **Skip 4, 6 and 7.** Then:
- run `$CLI doctor` (V1 on v11: exit 0 in rehearsal R5);
- continue with steps 8–10.

V1 leaves `schema_migrations` at 1–8, 10, 11. That is expected.

## 4. Database compatibility notes
- V1's migration runner only *adds* missing versions 1–8. It never downgrades and ignores 10 and 11. There is **no down-migration**: reversing v10/v11 by SQL is not supported and must not be attempted.
- Mode A gets back to v8 **only** by replacing the file through `restore`.
- **Re-upgrading after Mode A** is the normal cutover (V2 re-applies v10 and v11).
- **Re-upgrading after Mode B:** V2 sees v10 and v11 already applied and does not re-run the backfill. So `qa_review_tasks` will lack links for reviews created while V1 ran. **How V2 behaves on such a DB is UNVERIFIED** (it was not rehearsed). Run the regression and a migration rehearsal on a copy before re-upgrading.

## 5. Supervisor configuration
- Unchanged: the same task, wrapper, `.env` and `AGENT_HOME`.
- The only code switch is the git checkout plus the build in `$P`.

## 6. Recovery evidence to keep (never delete)
- `$D\*`
- `agent.db.pre-restore-<ts>`
- `$H\backups\*`
- `deploy\20261109-180656\raw-db\*`
- `wrapper.log`
- the app logs
