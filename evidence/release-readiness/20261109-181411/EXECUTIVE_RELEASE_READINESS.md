# Personal Agent V2: Windows Production Readiness, Executive Summary

**Assessment window:** 2026-11-09 18:13–18:45 (+05:00).
**Host:** DESKTOP-QGGLG8D, Windows 11 Pro 26300.
**Evidence root:** `E:\Agent\v2-staging\release-readiness\20261109-181411\`.

## Verdict: **CONDITIONAL GO (Windows production candidate)**

V2 `e60278f` passed every mandatory Windows gate that could be executed safely:
- **594/594** vitest tests and **9/9** browser tests, run on the release SHA itself;
- clean install, types, lint, format and build;
- 0 runtime vulnerabilities and 0 committed secrets;
- a migration rehearsal on the exact pre-upgrade production data;
- a rollback-to-V1 rehearsal;
- a staging deployment with crash recovery.

**No V2 defect was found.** The release is conditional because four owner decisions and acceptances (§6) remain open. None of them is a V2 code defect.

### First: the assignment's premise does not hold
The assignment says production is still V1. **It is not.**
- The owner authorized a V2 deployment, and it was carried out at **18:06–18:10 today**: `E:\Agent\v2-staging\deploy\20261109-180656\DEPLOYMENT_RECORD.md`.
- `E:\Agent\Personal-agent` is on `deploy/v2` @ `e60278f`.
- The live DB is at schema v11.
- The scheduled task runs the V2 supervisor (pid 8992).

This assessment did **not** cause, change or reverse that deployment. Everything here was read-only towards production. The verdict therefore answers two questions:
1. Is V2 fit to *remain* in production on Windows?
2. Is rollback to V1 ready if the owner prefers it?

## 1. Release manifest

| Item | Value |
|---|---|
| Release SHA | `e60278fcf6d609c28fbd4c247cee4b6a9571e22d` = `origin/main` (PR #4 merge, 2026-11-09 17:48 +05:00) |
| Parents | `f59d4ca` (previous `main`), `fca3cd3` (`integrate/v2-main`) |
| Tested-commit relationship | Tree `b408a00a…` is **identical** to `fca3cd3`. All suites were **re-run on `e60278f`** in this assessment |
| Source branch | `integrate/v2-main` (worktree `E:\Agent\pa-v2-integrate`, clean) |
| Diff from the running V1 (`1b07468`) | 37 commits; 84 files (+6979/−170), of which 36 are `src/` files (+2969/−137). V1 is an ancestor of V2. List: `evidence\v1-to-v2-changed-files.txt` |
| Node.js | `engines >=22.12`; tested on **v26.13.0** (npm 11.20.0). Node 22 itself was not tested on this host |
| Runtime dependencies | `@anthropic-ai/claude-agent-sdk ^0.3.319`, `better-sqlite3 ^13.0.3` (prebuilt binaries; `.npmrc ignore-scripts=true`), `zod ^4.6.7`. **`package-lock.json` is unchanged from V1** |
| External runtime | Claude Code CLI 2.1.319 with a claude.ai (max) login that expires **2026-12-04**; Git; PowerShell 5.1 |
| DB schema | v11. Sequence **1–8, 10, 11** (v9 reserved by design; main's stage-5 migration renumbered from 4 to 11). Migrations are additive only: 2 tables, 2 indexes, 1 column |
| New configuration (all optional, defaults safe) | `CLAUDE_CLI_MAX_CAPACITY_WAIT_MS=1800000`, `CAPACITY_RESUME_GRACE_MS=60000`, `HOST_SUSPEND_THRESHOLD_MS=120000`, `CAPACITY_ESCALATE_AFTER_MS=86400000`, `CAPACITY_ESCALATION=notify`, `MIN_FREE_MEMORY_MB=1024`, `RESUME_FREE_MEMORY_MB=1536` |
| Release artifacts | The git commit (the deploy builds `dist/` in place). The earlier RC zip `rc\elevariq-agent-v2-050bd73.zip` is **not** this release |
| Production-specific config committed? | No. `.env` is untracked; the secret scan found 0 matches in 145 tracked files outside `tests/`; the test fixtures are synthetic |
| Known incompatibilities | (1) DBs created by main's stage-5 code (its own v1–4 numbering) are not a supported upgrade source; none is known to exist. (2) `npm run ci:local` needs Node 22, writes `core.hooksPath` into the shared `.git` config and posts GitHub statuses, so it was not run as-is. (3) **Linux: unverified** (out of scope by owner decision) |

## 2. Results at a glance

| Gate | Result | Evidence class |
|---|---|---|
| Reproducible install, typecheck, lint, format, build | PASS | **Verified now** |
| `npm audit --omit=dev` | 0 vulnerabilities (the full audit shows 10 moderate, all dev-only) | Verified now |
| Secret scan | 0 matches | Verified now |
| Unit / Integration / E2E | **394/394, 173/173, 27/27**: 0 failed, 0 skipped | Verified now |
| Browser (Edge) | **9/9** | Verified now (×1; ×3 historically on the identical tree) |
| A1–A12 regression | All fixed and verified (A10/A11/A12 by tests only) | Verified now |
| Migration v8→v11 on the production pre-upgrade copy | PASS: history 16/16 identical; schema = fresh install = live | Verified now |
| Rollback (V1 restore) | PASS: v8 baseline restored exactly; V1 healthy. V1 also runs on v11 | Verified now (isolated) |
| Staging deployment + crash recovery + QA + approvals + memory gate | PASS. One harness deviation, re-run and resolved | Verified now (mock provider) |
| Production health | Healthy and idle; integrity ok; 0 pending | Verified now (read-only) |
| Security | No V2-introduced defect. Pre-existing **SG-1** (approvals advisory against a hostile worker; no OS isolation) | Verified now (code audit + 67 probes) |
| Linux | **NOT VERIFIED.** Out of scope | — |

## 3. Evidence classes
- **Verified evidence (this assessment):** everything marked "Verified now" above, with logs and exit codes under `logs\` and `evidence\`.
- **Previously reported evidence (not re-done):**
  - mutation checks of A11 and the stage-5 QA tests;
  - 3× browser runs on `fca3cd3`;
  - the RC artifact install test (`050bd73`);
  - the 18:07 production deployment logs. I read them; I did not repeat the deployment.
- **Assumptions:**
  - The `0x800710E0` scheduler result is the IgnoreNew refusal. This is inferred from the live wrapper and pid; Microsoft documents the code's meaning.
  - Worker memory estimate of about 0.3 GB, based on the interactive CLI.
  - Production recovery latency of about `LEASE_TTL_MS` (60 s), extrapolated from staging's 3.4 s at a 3 s TTL.
- **Untested claims:**
  - behaviour with real Claude workers (usage-limit messages, real memory);
  - a real host sleep and Windows reboot (**the logon-trigger path has never run since installation**);
  - the scheduled-task part of a rollback;
  - Node 22;
  - Linux;
  - dashboard reconnection after a server restart;
  - V2 re-upgrade after a Mode-B rollback.

## 4. Unresolved defects and risks

| ID | Severity | Item | Owner action |
|---|---|---|---|
| SG-1 | **High, pre-existing** (V1 and V2) | Owner approvals, protected paths and the agent-control deny are **advisory** against a misbehaving or prompt-injected worker: script files, encoding, indirection, `env -u ELEVARIQ_WORKER`, direct `agent.db` writes. No OS isolation; workers run as the production user and can read `~/.claude/.credentials.json` | **Accept in writing** for the limited configuration, or require M0 (separate Windows user) |
| M1 | Medium | Accidental-bypass gaps: `rm --recursive`, `rd /s`, `rmSync`, git aliases | Small code fix (future release) |
| M2 | Medium | Verification commands run worker-written code without `ELEVARIQ_WORKER`; the owner check relies on the environment only | Small code fix |
| M6 | Medium | `E:\Agent\Personal-agent\.env` has `Authenticated Users: Modify` (inherited) | Owner to tighten the ACL (not done: production change) |
| OPS-1 | **High (operational)** | With the defaults 1024/1536 and about 1 GB available, **production defers almost all new work and QA** (live `resource_deferred` events) | Choose option (a), (b) or (c) in PERFORMANCE §4 |
| OPS-2 | Medium | Reboot recovery unverified; the task is Interactive, so the agent is down until `Roman` logs on | Owner-scheduled reboot check |
| OPS-3 | Medium | Claude login expires 2026-12-04 | Renew before then |
| OPS-4 | Low | Pilot project shows "0% verified (100% claimed)" under V2's stricter evidence model | Owner awareness; `project:accept` remains the owner's call |
| L-1 | Info | Linux unverified | Recorded as excluded |

## 5. Performance (measured)
- **Supervisor:** 28–46 MB idle in production; 84–145 MB in staging.
- **Latency:** task start 2.6–3.2 s; crash→reconcile 3.4 s in staging.
- **Migration:** under 1 s. Restore: 0.6 s.
- **Host memory:** the test-heavy workload of one worker drove available RAM to **262 MB**, and browser QA needs about 1 GB. **Keep `MAX_CONCURRENT_WORKERS=1`.**

## 6. Remaining actions before production is considered final
1. **Owner decision: keep V2 or roll back.**
   - **Recommendation:** keep V2. It is healthy, every gate passed, and rollback is rehearsed and ready (V1_ROLLBACK_RUNBOOK.md).
   - If rolling back, do it **before V2 does real work**. Today a restore loses only 5 operational events.
2. **Owner: written acceptance of SG-1** for the limited configuration:
   - single owner;
   - `MAX_CONCURRENT_WORKERS=1`;
   - ERP/CRM disabled and no write credentials on the host;
   - `PLAN_APPROVAL=required`;
   - owner-provided repositories only.

   Otherwise schedule M0.
3. **Owner: memory-policy decision** (OPS-1). Without it, V2 will not reliably start work on this host.
4. **Owner: tighten the `.env` ACL (M6)** and plan M1/M2 for the next release.
5. **Owner-scheduled reboot verification** (OPS-2): reboot, log on, confirm `health` within 5 min.
6. **Renew the Claude login** before 2026-12-04.
7. Monitor for the first 24–72 h with the checks in PRODUCTION_CUTOVER_RUNBOOK.md §3. Roll back on any trigger in §4.

**Do not** deploy, switch the task or change `.env` as part of this assessment. Each of the above requires the owner's own authorization.

## 7. Deliverables
All files are in `E:\Agent\v2-staging\release-readiness\20261109-181411\`:
- `EXECUTIVE_RELEASE_READINESS.md` (this file)
- `WINDOWS_V2_TEST_RESULTS.md`
- `V1_PRODUCTION_HEALTH.md` (current production = V2, plus V1 rollback readiness)
- `A1-A12_REGRESSION_MATRIX.md`
- `DATABASE_MIGRATION_REHEARSAL.md`
- `STAGING_DEPLOYMENT_REHEARSAL.md`
- `SECURITY_GOVERNANCE_ASSESSMENT.md`
- `PERFORMANCE_RESOURCE_ASSESSMENT.md`
- `PRODUCTION_CUTOVER_RUNBOOK.md`
- `V1_ROLLBACK_RUNBOOK.md`
- `EVIDENCE_MANIFEST.sha256`
- `logs\`, `evidence\`, `scripts\`, `db\live-snapshot-v11.db` (read-only snapshot; contains production task data, so keep it private)
