# ELEVARIQ Personal Agent v2: Release Candidate Report

> **Current release candidate: `050bd73` (2026-11-09 05:20–05:41 PKT).** The verification of record for the candidate is
> [`V2_EVIDENCE_MATRIX.md`](V2_EVIDENCE_MATRIX.md). Everything there was re-run against a clean clone of `050bd73` and its packaged artifact:
> - CI-equivalent checks;
> - 562/562 vitest tests;
> - browser 9/9 ×3;
> - staging from the artifact: fresh install, synthetic v1 upgrade, pilot-copy upgrade and rollback.
>
> Artifact: `E:\Agent\v2-staging\rc\elevariq-agent-v2-050bd73.zip`, SHA-256 `b61205ace474172262db415101cfcdfa9e6a9558f2d3e761563123a006ca653f`.
>
> `050bd73` differs from `f4eed90` by a configuration default (`HOST_SUSPEND_THRESHOLD_MS` 30 s → 120 s) and documentation. Sections 3 and 7 below therefore describe the earlier run (`a6604f8` / `f4eed90`) and are kept as history.
>
> **Production rollout from the artifact** (each step needs owner authorization):
> 1. Verify the checksum and extract to a new directory, for example `E:\Agent\Personal-agent-v2-release`.
> 2. `npm ci --omit=dev` there.
> 3. Copy production `.env` into it, choosing `MIN_FREE_MEMORY_MB` / `RESUME_FREE_MEMORY_MB` deliberately.
> 4. Take a v1 `backup` of the live DB.
> 5. `stop --hold` v1 (see OPERATIONS "Production scheduled task").
> 6. Point the scheduled task's repository path at the new directory and start it. Migration v10 applies.
> 7. Check `health`, `status`, `projects` and history counts against the backup.
> 8. Run one small `smoke:live` task.
>
> **Rollback:**
> 1. Stop.
> 2. Point the task back at `E:\Agent\Personal-agent`.
> 3. v1 `restore <backup> --reason ...`.
> 4. Start.
>
> The rollback was rehearsed in staging twice: once from the worktree build and once from the artifact. Both times the database came back to its exact pre-upgrade state and v1 ran normally on it.

- **Release candidate:** branch `feat/agent-v2-reliability` @ **`f4eed90`**, worktree `E:\Agent\Personal-agent-v2`.
- **Not pushed, not merged, not deployed.**
- **Production (v1):** `E:\Agent\Personal-agent` @ `1b07468`, scheduled task `ElevariqPersonalAgent` Running, supervisor pid 21040 healthy. Production was not modified at any point.
- **Date:** 2026-11-09.
- **Evidence:** `E:\Agent\v2-staging\evidence\` (regression logs, staging rehearsal), `E:\Agent\pilot-evidence\elevariq-retail-operations-portal\closeout\` (pilot backup, bundle, manifest).

## 1. v1 vs v2

| Concern | v1 (`1b07468`) | v2 (`f4eed90`) |
|---|---|---|
| Execution time limit | Wall-clock `setTimeout` and tick; host sleep counted as work | Active-time meter (`src/core/active-clock.ts`): a late tick is booked as host suspension; applied in the provider tick, the runner hard ceiling and the SDK provider; `host_resume` events |
| Usage-limit wait | Unbounded in-process wait (ceiling 0); relies on the CLI retry timer, which stalls while the host sleeps | In-process wait ends once the provider-reported reset (+60 s grace) passes on the wall clock. A reset more than 30 min away is handed to the durable queue (session kept, no retry consumed). Only a future reset of a *rejected* limit steers the wait |
| Long capacity streaks | Silent | `capacity.escalated` owner notification after 24 h (once per streak); `CAPACITY_ESCALATION=block` optional |
| Memory pressure | None | New claims pause below 1024 MB available and resume above 1536 MB (hysteresis). Running work is never killed |
| Manual tasks (`task:add`) | No QA, no criteria, no verification | Same independent QA as planned tasks; acceptance criteria required; configured build/test levels; audited review waiver |
| Verification commands | Fixed at intake; NOT_CONFIGURED forever | `assignment:set-verification` (owner, audited: who/why/before/after); derived from `package.json` at intake/verify unless the owner decided; browser suite part of TESTS_PASS; per-command exit codes recorded |
| QA scope | Every linked requirement must pass in every task | One owner task per requirement; reviews judge own criteria + owned requirements; others informational; project coverage counts only reviews that judged the id |
| High-severity findings | Any high defect failed the review | Confirmed (file:line or reproduction) → FAIL/correction. Unverifiable → **NEEDS_EVIDENCE** (never a pass): evidence requested (bounded), then owner |
| Owner acceptance | Recorded as REQUIREMENTS_SATISFIED **PASSED** (+ownerOverride) | Recorded as **OWNER_ACCEPTED**. Releases dependants but is never counted as verification; legacy rows read the same way |
| Requirement/milestone status | Never updated (OPEN/PLANNED forever) | Derived and idempotent: OPEN → IN_PROGRESS → IMPLEMENTED → REVIEWED → VERIFIED; ACCEPTED kept distinct |
| Review-task linkage | Superseded repair reviews orphaned | Atomic review task + round + link (`qa_review_tasks`, migration v10) |
| Security policy | Regex over raw text (heredoc/quoted false positives); relative agent-CLI invocation allowed | Normalizer, strict by default (data only for echo/printf/cat/tee/grep/rg/git-message commands; raw for interpreters, SQL clients, `-c`/`-e`, heredocs into non-data programs, unquoted heredoc substitutions, arithmetic, write-and-run scripts). Agent-CLI hard deny also on a de-quoted copy. CLI refuses owner-only commands inside workers (`ELEVARIQ_WORKER=1`) |
| Scratch cleanup | Refused trees with junctions (npm workspaces) | Links removed as links, never followed, audited; still only `.qa-*`/`.scratch-*`/`.tmp-*`, bounded size |
| Tests | 334 vitest + 9 browser | **562 vitest + 9 browser** |

## 2. Defect remediation matrix

| ID | Root cause (evidence) | Correction | Regression tests | Status |
|---|---|---|---|---|
| A10 | The CLI watchdog's retry timer does not advance during host sleep (exe_mw72qpdx: 70 min of delay left 14 h after the reset); the agent never rechecked | Wall-clock resume after reset + grace; handoff of far resets to the queue | `tests/unit/capacity-sleep.test.ts`, `tests/integration/capacity-v2.test.ts` | Fixed |
| A11 | Wall-clock budget charged sleep (exe_mw85pdo9: TIMEOUT 15 s after a 3h14m sleep, retry consumed) | Active-time meter in 3 places | capacity-sleep (mutation-checked: disabling detection fails the tests) | Fixed |
| A12 | `CLAUDE_CLI_MAX_CAPACITY_WAIT_MS=0` (unbounded) | 30 min in-process ceiling; 24 h escalation (notify/block) | capacity-sleep, capacity-v2 (24 h notification delivered once) | Fixed |
| A5 | Intake produced no commands | Derivation from package.json (audited, never over owner decisions) | `tests/integration/verification-v2.test.ts` | Fixed |
| A6 | `task:add` enqueued without verification | `manualTaskPolicy`: QA parity, criteria required, audited waiver | verification-v2, `tests/e2e/cli-verification-v2.test.ts` | Fixed |
| A7 | No amend path after intake | `assignment:set-verification` | verification-v2, cli-verification-v2 | Fixed |
| A1 | Reviewer judged every linked (cross-cutting) requirement (15 of 22 non-passing pilot rounds) | Ownership, scoped prompt/verdict, NEEDS_EVIDENCE, ownership-aware coverage | `tests/unit/qa-ownership.test.ts`, `tests/integration/qa-ownership.test.ts`, `qa-needs-evidence.test.ts`, `requirement-coverage.test.ts` | Fixed |
| A2 | Rules matched data text (5 owner approvals for false positives); agent CLI reachable by relative path | Strict-by-default normalizer + hard deny | `tests/unit/policy-normalize.test.ts`, `policy-v2-review.test.ts` | Fixed (guardrail, see §9) |
| A3 | Repair review overwrote `review_task_id` (orphan `tsk_mw6qev54ed00819a0c`) | Atomic link table + v10 backfill | `tests/integration/qa-review-atomic.test.ts` | Fixed |
| A4 | Nothing wrote requirement/milestone status | `status-reconcile.ts`, wired + start-up repair | `tests/unit/status-reconcile.test.ts`, qa-ownership | Fixed |
| A8 | Cleanup refused any link inside the tree | Unlink-without-follow + audit | `tests/unit/scratch-cleanup.test.ts` | Fixed |
| A9 | No resource gate (heartbeat stale at 0.83 GB free) | Memory hysteresis gate | `tests/integration/resource-gate.test.ts` | Fixed (operational caveat §9) |

**Owner decisions of 2026-11-09, implemented:**
- **A (NEEDS_EVIDENCE):** done.
- **B (scratch cleanup stays narrow):** guard test added; `rm -r` stays approval-gated.
- **C (REVIEWED/ACCEPTED distinct; acceptance ≠ verification):** done.
- **Memory hysteresis 1 GB / 1.5 GB:** done.

## 3. Full regression (final head; logs in `evidence/regression-final/`)

Bounded runner `scripts/rstep.ps1`:
- runs each step in the foreground with its own deadline;
- samples available memory every 5 s and kills only its own tree below 350 MB (`PAUSED_MEMORY`); this never triggered;
- runs vitest with 2 workers (1 for e2e);
- writes the summary line as a checkpoint after each step.

The `src` tree at `a6604f8` and `f4eed90` is identical. `f4eed90` adds one test-harness line, used by step 08b.

| Step | Command | Exit | Result | Min available RAM |
|---|---|---|---|---|
| 01 | `npm run typecheck` | 0 | PASS | 1366 MB |
| 02 | `npm run lint` | 0 | PASS | 1358 MB |
| 03 | `npm run format:check` | 0 | PASS | 1415 MB |
| 04 | `npm run build` | 0 | PASS | 1420 MB |
| 05 | `npx vitest run tests/unit --maxWorkers=2` | 0 | **23 files, 393/393** | 1085 MB |
| 06 | `npx vitest run tests/integration --maxWorkers=2` | 0 | **16 files, 144/144** | 854 MB |
| 07 | `npx vitest run tests/e2e --maxWorkers=1` (crash/restart recovery, orphan workers, CLI) | 0 | **6 files, 25/25** | 1152 MB |
| 08 | `npm run test:browser` | **1** | **FAIL: 2 passed, 1 failed, 6 not run.** "approval workflow: timed out waiting for plan approval request". Cause: the harness supervisor used the new 1024 MB default and paused at 960 MB available | 960 MB |
| 08b | `npm run test:browser` (harness `MIN_FREE_MEMORY_MB=0`, commit `f4eed90`) | 0 | **9/9** | 778 MB |

**Earlier attempts (kept, not counted as passes):**
- **Attempt 1:** reaped by Claude Code's low-memory guard during the full suite. Steps 1–4 had passed; the suite result is unknown.
- **Attempt 2:** e2e 1 failed, 23 passed. `planning-e2e` timed out because the spawned supervisor paused at 711 MB available (memory gate). The fix was to set `MIN_FREE_MEMORY_MB=0` in the e2e harness.

**Requested categories → covering tests (all in the passing runs above):**

| Category | Tests |
|---|---|
| Unit / integration | Steps 05 and 06 |
| Recovery, supervisor crash recovery | `e2e/restart-recovery`, `e2e/orphan-worker`, `integration/phase15-recovery`, `capacity-v2` (restart while waiting) |
| Sleep/wake | `unit/capacity-sleep` (A11, A10) |
| Capacity wait; multiple resets | `capacity-sleep`, `capacity-v2` (two consecutive resets, same session, 0 retries used, no overlap), `capacity-watchdog` |
| Security policy | `policy-normalize` (158), `policy-v2-review` (18), `agent-control-policy`, `redact-and-paths` |
| Independent QA workflow | `independent-qa`, `qa-ownership`, `qa-needs-evidence`, `qa-review-atomic` |
| Verification configuration | `verification-v2`, `cli-verification-v2`, `e2e/cli-commands` |
| Requirement mapping | `qa-ownership` (unit + integration), `requirement-coverage` |
| Progress reconciliation | `status-reconcile`, `qa-ownership` (A4 wiring) |
| Scratch cleanup | `scratch-cleanup` (18) |
| Memory policy | `resource-gate`: hysteresis band 1024–1536 MB, a single event per transition, a running worker not killed |

## 4. Independent security / code review

A separate read-only reviewer session checked `1b07468..d32228f`; it wrote nothing.

| Finding | Severity | Disposition |
|---|---|---|
| Unquoted heredoc body with `$(...)`/backticks hidden from rules | HIGH | Fixed (`a6604f8`): raw view; test |
| Arithmetic `<<` parsed as a heredoc, hiding later lines | HIGH | Fixed: arithmetic → raw view; test |
| Project-level coverage ignored ownership (contributor pass verified owner's requirement) | HIGH | Fixed: only reviews that judged the id count; test |
| Executed-argument programs (rebase -x, submodule foreach, concurrently, tar checkpoint-action, env -i, find -exec) | MEDIUM | Fixed by strict-by-default design; 6 tests |
| Heredoc-written script run in the same command | MEDIUM | Fixed: raw view; 3 tests |
| Agent-CLI deny defeated by quoting/escape/variable/PowerShell concat | MEDIUM | Fixed: de-quoted match + `$var:sub` + CLI worker guard; 6 tests |
| Stale/unrelated reset steering the wait; past reset → resume loop | MEDIUM | Fixed: only a future rejected reset; 2 tests |
| Owner "clear all commands" overridden by re-derivation | LOW | Fixed; test |
| Blocked event loop (>31 s) read as sleep | LOW | Open (known limitation) |
| `capacityPolicy` applied after the checkpoint transaction (crash window) | LOW | Open |
| NEEDS_EVIDENCE "withdraw" needs no justification | LOW | Open |
| Cross-cutting defect in contributor code may go unjudged (design) | MEDIUM | Open; mitigated: confirmed high defects always block wherever filed |
| Write-tool script + separate run; unauthenticated owner CLI | Inherent | Documented: guardrail, not a sandbox |
| Migration v10 | — | OK: additive only, single transaction, idempotent backfill, v9 gap tolerated |

**Reviewers cannot approve their own work.**
- Each QA review is a separate read-only PLANNING task in a fresh session (`independent-qa` asserts `[ro]`).
- Dependants wait for PASSED or OWNER_ACCEPTED evidence only.
- Workers cannot run `approve`, `project:accept`, `assignment:set-verification`, `task:unblock` or any other state-changing agent CLI command. Both the policy hook and the CLI worker guard enforce this (98 + 6 + 4 test cases).

## 5. Recovery results

All of the following pass in steps 05–07:
- **Capacity wait then resumption:** same session id; `consumesAttempt=false`.
- **Two consecutive resets with a simulated sleep:** 3 executions, never overlapping, attempt count 0.
- **Supervisor restart during WAITING_FOR_CAPACITY:** the new instance waits, then claims once; the old instance cannot claim.
- **SIGKILL crash recovery and orphan-worker identity checks:** existing e2e, passing.
- **Duplicate supervisor refused:** e2e, and the staging rehearsal (see §7).

## 6. Memory-pressure results

- **Hysteresis:** pause at 900 MB. Readings of 1100/1500/1000/1535/1200 MB stay paused, with one deferred event. At 1600 MB it resumes, with one resumed event. Inside the band it does not re-pause.
- **Running work:** a worker that was already running when memory dropped to 500 MB completed normally; the next task waited.
- **Observed on this host during the regression:** available RAM 711–1480 MB.
  - With the owner-specified 1024/1536 defaults, a v2 supervisor would have paused new work during parts of the test runs. Three harnesses (e2e, browser, integration helper) now disable the gate so test outcomes don't depend on host memory.

## 7. Staging rehearsal (`scripts/rehearsal.ps1`, evidence `evidence/`, log `evidence/rehearsal.log`)

**Isolation:**
- verified copy of the pilot closeout DB (sha256 `738684D1…86FA`, source = copy);
- separate `AGENT_HOME` `E:\Agent\v2-staging\home`;
- separate workspace (clone of the pilot bundle @ `1ae7d2f`; project `repo_path` repointed in the **copy only**);
- mock provider (no Claude, no billing);
- no `.env` and no credentials; ERP/CRM off; no webhook; health server off; dashboard port 4417 (not started);
- cwd outside production.

| Step | Result |
|---|---|
| S4: pre-migration backup with **v1** `backup` | exit 0, sha256 `EFC6F14E…ED29` |
| S5: v2 opens DB (`doctor`) → migration v10 | versions 1–8, 10; `qa_review_tasks` 66 (65 rounds + the A3 orphan) |
| History intact after migration (row fingerprints) | tasks, executions, checkpoints, approvals, qa_reviews, task_transitions, evidence, assignments, plan_tasks: **all identical**; counts 141 / 157 / 157 / 9 / 1 project unchanged |
| S6: projects accessible | `projects`, `project:status`, `tasks` (141 listed), `qa`, `approvals` (9 listed), `roadmap`: all exit 0 |
| S7: staging supervisor | `start --detach` → IDLE, pid 10516, health exit 0. A second `start` launched a child that exited: **exactly 1 staging supervisor**. `stop` → STOPPED, 0 processes. Production pid 21040 alive throughout |
| History intact after the supervisor run | all fingerprints identical; 0 RUNNING |
| A4 reconcile on pilot data | requirements 41 → REVIEWED (not VERIFIED: no build/test commands were configured in the pilot); milestones 5 REVIEWED + 2 ACCEPTED (M1, M7 contain owner-accepted T5/T44/T45) |
| v2 project-level coverage on pilot data | PASSED, all 41 judged met by passing reviews (consistent with the pilot traceability: 0 resting only on owner-accepted tasks) |
| S8: v1 against the v10 DB (throwaway copy) | `status` exit 0 (v1 tolerates the additive schema) |
| S9: rollback with **v1** `restore` | exit 0; versions back to 1–8; every history fingerprint equals the pre-v2 baseline; v1 `doctor` and `status` exit 0 |

**Notes:**
- **Attempt 1 is INVALID** and kept as `evidence-attempt1-INVALID-alias-bug`. My script function `Cli` collided with PowerShell's `Clear-Item` alias, so no CLI command ran. It is not counted.
- **Precondition for staging:** the copied DB carries production's supervisor record (pid 21040). Staging took over only because that heartbeat was stale (79 min). A future rehearsal should use a copy whose heartbeat is stale.

## 8. Migration and rollback

- **v10 (`qa_requirement_ownership_and_review_links`):**
  - adds `requirements.owner_task_id`, table `qa_review_tasks` and an index;
  - `INSERT OR IGNORE` backfill from `qa:<task>:<round>:<repair>` keys;
  - nothing destructive; one transaction; recorded in `schema_migrations`.
- **No other migration.** The new evidence statuses (`NEEDS_EVIDENCE`, `OWNER_ACCEPTED`) need no schema change, because `status` is unconstrained TEXT.
- **Rollback (rehearsed):**
  1. stop the v2 supervisor;
  2. v1 `restore <pre-v2 backup> --reason ...`, which keeps the replaced DB as `agent.db.pre-restore-*`;
  3. run the v1 code.

## 9. Remaining defects and limitations

1. **Memory defaults (operational, important).** 1024/1536 MB on this 7.8 GB host (typically 0.7–1.8 GB available) will often pause new work. Decide before deployment: keep them, lower them (e.g. 600/900), or free memory.
2. **Security policy is a guardrail, not a sandbox.**
   - A worker can still write a script with the Write tool and run it in a separate command.
   - It can unset `ELEVARIQ_WORKER`.
   - Owner CLI commands have no authentication.
   - The strict default may add approvals for quoted text passed to `curl`/`gh`.
3. **Open LOW items:**
   - an event loop blocked for more than 31 s is booked as sleep;
   - the escalation decision is applied after the checkpoint transaction;
   - NEEDS_EVIDENCE withdrawal needs no justification;
   - format repairs and evidence requests share one repair counter.
4. **Design:** a cross-cutting defect in contributor code may never be judged unless filed as a confirmed defect.
5. **Not verified:**
   - no live Claude run of v2 (sleep and capacity behaviour verified with deterministic simulation only; the real subscription was deliberately not exhausted);
   - Linux;
   - long soak operation of the v2 scheduled task.
6. **Migration numbering:** v9 is intentionally unused; a future v9 would run after v10 on existing databases.

## 10. Production deployment recommendation

**v2 is a verified release candidate.** I recommend deploying it to production **only after your explicit authorization**, with these conditions:

1. **Decide the memory thresholds** (§9.1).
2. **Deploy without touching the v1 checkout:**
   1. take a v1 `backup` of the live DB;
   2. `stop --hold` the production supervisor;
   3. point the scheduled task's repository path at the v2 worktree (built `dist`);
   4. start: migration v10 applies on the first open;
   5. verify `health`, `status`, `projects` and history counts.
3. **Rollback:**
   1. stop;
   2. point the task back to `E:\Agent\Personal-agent`;
   3. v1 `restore` of that backup;
   4. start.
4. **After deployment:** one small, real `smoke:live` task to confirm the live Claude CLI path under v2.
5. Push and merge remain separate decisions.

I made none of these changes.
