# Test results

Recorded in the Linux build sandbox (Ubuntu 24.04, Node v22.23.4, npm 10.9.9). **Never run on Windows.**
Phase 1: 2026-11-06. Phase 1.5 (this document's current numbers): 2026-11-07.
All provider traffic was the deterministic mock or scripted SDK-shaped streams: **no paid or authenticated API request was made** (no API key was present in the session).

## Commands and outcomes (Phase 1.5, final run)

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`, strict + `noUncheckedIndexedAccess`, covers src/tests/scripts) | pass, 0 errors |
| `npm run lint` (ESLint 10 + typescript-eslint) | pass, 0 problems |
| `npm run format:check` (Prettier on src + tests) | pass |
| `npm run build` | pass; `node dist/cli/index.js provider:status` runs |
| `npm test` (`vitest run`) | **15 files, 183 tests, 183 passed, 0 failed** (~29 s) |
| `npm run test:unit` | 94 passed (9 files) |
| `npm run test:integration` | 71 passed (3 files) |
| `npm run test:e2e` | 18 passed (3 files: real `tsx` child processes, real SIGKILL, 4-process DB contention, every CLI command). **Run 3 times consecutively: 18/18 each time, no flakiness observed** |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit` (all) | 10 moderate - a single advisory (`minimatch` DoS) reached only through the ESLint/typescript-eslint dev toolchain; the suggested fix is a breaking ESLint downgrade, not applied; nothing ships at runtime |
| Secret scan (`git grep` for key/token/private-key patterns outside `tests/`) | none; no `.env`/database tracked or left untracked |
| `bash -n scripts/linux/install.sh scripts/github/protect-main.sh`, YAML parse of `ci.yml` | pass |
| `systemd-analyze verify scripts/linux/elevariq-agent.service` | parses (only complaint: `/usr/bin/node` absent in the sandbox) |
| PowerShell parse of `scripts/windows/*.ps1` | **NOT DONE** - no PowerShell in the sandbox; downloading one was refused by the sandbox execution policy and was not worked around. Only static string/structure guards ran (`tests/unit/windows-scripts.test.ts`) |
| `provider:verify --access`, `smoke:live`, `smoke:live-recovery` | **BLOCKED** - no `ANTHROPIC_API_KEY`/spend authorisation in the session; `smoke:live` correctly refuses |
| GitHub CI (`.github/workflows/ci.yml`) | **not yet run** (workflow added in this change) |

## Phase 1.5 requirements -> evidence

| Requirement | Test(s) | Strength |
|---|---|---|
| Restart recovery | `e2e/restart-recovery` (3: SIGKILL while waiting for capacity, SIGKILL mid-execution, singleton), `integration/supervisor › restart recovery` (6), `phase15-recovery › real-restart reconciliation` | real processes + SIGKILL, mock provider |
| Incomplete tool execution | `phase15-recovery › incomplete tool execution` (crash after a partial write -> dirty checkpoint, prompt lists the file and warns; hard crash -> recovery checkpoint from the *current* tree) | mock |
| Stale leases | `supervisor › sweep mode…`, `phase15-recovery › execution fencing` (lease reclaimed -> stale worker cannot heartbeat/transition/complete), live-in-process worker never reclaimed | unit/integration |
| Corrupted checkpoints | `phase15-recovery › checkpoint integrity` (tampered row skipped -> older valid used; all corrupt -> prompt warns; dangling commit flagged), legacy checkpoint accepted after migration | integration |
| Duplicated completion events | `phase15-recovery › a duplicated completion event is a no-op`, stale-worker late completion | integration |
| Escalation instead of infinite retries | `decide.test` (streak), `phase15-recovery › escalation` (crash-looping task blocked after N; network failures blocked then `unblock` resumes) | unit + integration |
| Database transactions | `e2e/concurrency` (4 processes x 60 tasks: 0 errors, 240 distinct claims, 240 executions, `integrity_check ok`), `unit/database` (atomic migration rollback), migration-from-Phase-1 test | real processes |
| Session persistence | session id stored at first message; resumed across supervisor restart in e2e; `readiness-and-hooks` (local session pre-check, `options.resume`) | mock + SDK-shaped |
| Permission enforcement vs real SDK semantics | `readiness-and-hooks › Claude adapter` (no `allowedTools`, `settingSources: []`, PreToolUse hook deny/allow, approvals, env sanitising) | SDK-shaped; **not live** |
| Provider readiness levels | `readiness-and-hooks` (15 tests) and `e2e/cli-commands › provider:status` | unit/e2e |
| Project assignment contract | `project-lifecycle › assignment contract` (rejections incl. production pre-approval, write integrations, duplicates, strictness), registration, durable context across a new `Store`, idempotent external id, workspace approval | integration |
| Project lifecycle | `project-lifecycle › project lifecycle…` (never auto-delivered, re-opened by new work, illegal jumps rejected, paused projects not executed) | integration |
| Independent verification | `phase15-recovery › verification gating` (claim with no changes fails; failing build blocks completion even though the provider said success; credentials not leaked to commands; unconfigured = unknown), `project-lifecycle › independent verification and owner acceptance` (7) | integration with real commands |
| Budget constraints | `project-lifecycle › project budget constraints` (maxExecutions, maxUsdTotal, per-assignment policy reaching the provider) | integration |
| CLI | `e2e/cli-commands` (14: every advertised command executed, including the new ones) | real processes |
| Windows scripts | `unit/windows-scripts` (static guards only) | **weak: static** |

Phase 1's 24-item coverage map (config, DB, queue ordering, transitions, locking, retries, auth/permission/budget handling, redaction, shutdown, duplicates, ERP/CRM mocks, path safety) is unchanged and still green.

## Defects found by the new tests while building Phase 1.5 (all fixed)

1. A failure-streak counter was computed by the decision logic but **never persisted** (two `return` objects lacked the field) - found by the escalation test.
2. A permission-policy edit (web-access approval) had been silently not applied - found by the hook test.
3. The secret redactor erased the key `credentialFingerprint` from readiness evidence (`credential` matches its key-name rule) - found by the readiness test.
4. `renderProjectContext` exceeded its length limit by one character - found by the lifecycle test.
5. Mock test double wrote a marker file even for "no change" steps, masking a failing `CHANGES_EXIST` - test-double bug.

(Plus the 14 audit findings in `docs/AUDIT_PHASE_1_5.md`, including the two critical SDK permission bypasses, which were found by code/doc review.)

## Unresolved limitations - what these results do NOT prove

* **No live Anthropic verification of anything.** The adapter's handling of real messages, rate-limit events, abort/interrupt behaviour and session resume-after-abort is verified only against SDK type definitions and official docs (some doc sections were unreachable) and scripted streams.
* **Windows is untested**, including all four PowerShell scripts (never parsed by PowerShell) and Windows path/symlink behaviour of the test suite.
* **systemd** unit never started under real systemd.
* Short leases/timeouts in tests; no soak test (hours/days), power-loss, clock-jump or sleep/resume test.
* Verification commands run model-written code **unsandboxed**; command screening is a guardrail, not a sandbox.
* Requirements-satisfied and security verification are **not implemented**; the delivery-readiness derivation can therefore never be fully `ready` without an explicit owner override.
* GitHub: the default-branch switch and branch protection could not be applied from this session (proxy blocks settings writes); CI has not yet run on GitHub.

---

# Phase 2 (stages 1-4) results - 2026-11-07

Linux sandbox, mock provider only. No real model or API request was involved.

| Command | Result |
|---|---|
| `npm run typecheck` / `lint` / `format:check` / `build` | all pass |
| `npm test` | **18 files, 226 tests, 226 passed, 0 failed** (~30 s) |
| `npm run test:unit` | 119 passed |
| `npm run test:integration` | 88 passed |
| `npm run test:e2e` | 19 passed |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Secret scan (outside `tests/`) | none |

New in Phase 2 (+43 tests): `unit/planning` (24: JSON extraction, schemas, every validator rule, property tests on 200 random DAGs and 200 injected cycles, read-only policy),
`integration/planning-workflow` (17), `e2e/planning-e2e` (1: real processes, SIGKILL during the architecture step, approval via CLI, all 3 planning + 3 coding tasks completed exactly once),
plus one Claude-adapter read-only test. Mutation check: disabling the coverage validator makes 3 tests fail.

Not covered: real model output, prompt quality, plan cost, Windows, GitHub CI (account-level runner problem, see PR #1).
