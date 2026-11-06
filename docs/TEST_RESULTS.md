# Test results

Recorded 2026-11-06 in the Linux build sandbox (Ubuntu 24.04, Node v22.23.4, npm 10.9.9). **Not run on Windows.** All provider traffic was the deterministic mock: **no paid API request was made.**

## Commands and outcomes

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`, strict + `noUncheckedIndexedAccess`) | pass, 0 errors |
| `npm run lint` (ESLint 10 + typescript-eslint) | pass, 0 problems |
| `npm run format:check` (Prettier) | pass |
| `npm run build` (`tsc -p tsconfig.build.json`) | pass; `dist/cli/index.js` started/stopped a detached supervisor and answered `status`/`health`/`stop` |
| `npm test` (`vitest run`) | **10 files, 102 tests, 102 passed, 0 failed** (~13 s) |
| `npm run test:unit` | 65 passed (7 files) |
| `npm run test:integration` | 25 passed (1 file) |
| `npm run test:e2e` | 12 passed (2 files; spawn real `tsx` child processes, real SIGKILL) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (incl. dev) | 1 moderate (minimatch via ESLint toolchain); fix requires an ESLint downgrade - not applied |
| `systemd-analyze verify scripts/linux/elevariq-agent.service` | parses; only complaint is `/usr/bin/node` absent in the sandbox |
| `npm run smoke:live` | correctly **refuses** (provider not `claude`); not run live - no API key |

The E2E recovery suite was run 3 times in a row with no failure/flakiness observed.

## Required test coverage map

| # | Required | Test (file › name) |
|---|---|---|
| 1 | Configuration validation | `unit/config` (5 tests) |
| 2 | DB init & migrations | `unit/database` (WAL, FK, idempotent, atomic rollback) |
| 3 | Create project | `unit/store › creates an isolated, git-initialised project workspace` |
| 4 | Add task | `unit/store › adds a task in QUEUED…` |
| 5 | Queue ordering | `unit/store › orders the queue by project priority…`, dependencies, scheduled start |
| 6 | State transitions | `unit/store › state machine` (3) + `integration` history assertions |
| 7 | Worker locking | `unit/store › worker leasing` (race, concurrency cap, heartbeat ownership, singleton supervisor) |
| 8 | Successful mock execution | `integration › claims, executes and completes a task…` |
| 9 | Failed execution | `integration › failed execution: retries with backoff, then FAILS…`, crash test |
| 10 | Rate-limit simulation | `integration › rate limit: honours retry-after…`, quota tests |
| 11 | Retry scheduling | `integration › consecutive rate limits back off exponentially` (1000/2000/4000 ms), `unit/decide` |
| 12 | Interrupted execution | `integration › restart recovery` (6) + `e2e › recovers a task whose supervisor was SIGKILLed…` |
| 13 | Restart recovery | `e2e › resumes the partially-completed task after restart…`, `integration › waiting state survives a supervisor restart` |
| 14 | Checkpoint persistence | `integration` (checkpoint pairs session + `agent/<slug>@<sha>`), `e2e` (2 checkpoints survive SIGKILL) |
| 15 | Session ID persistence | `integration › …session id persistence`, `e2e` (resumed from stored session) |
| 16 | Authentication failure | `integration › authentication…` (2), `unit/claude-provider` preflight/credential-source tests |
| 17 | Permission-denied handling | `integration › permission denial creates an approval…`, `unit/claude-provider`, policy tests, `e2e/cli approve/deny` |
| 18 | Budget-limit handling | `integration › budget exhaustion BLOCKS…`, `daily budget gate…`, `unit/config` |
| 19 | Log redaction | `unit/redact-and-paths › log redaction` (4) |
| 20 | Graceful shutdown | `integration › graceful shutdown…`, `stop requested through the database`, `e2e` (exit 0 + `graceful:true`) |
| 21 | Duplicate-task protection | `unit/store › rejects duplicate tasks…`, `e2e/cli › duplicate protection`, singleton supervisor test |
| 22 | CRM mock connectivity | `unit/integrations › CRM mock adapter` |
| 23 | ERP mock connectivity | `unit/integrations › ERP mock adapter` |
| 24 | Safe workspace path validation | `unit/redact-and-paths › workspace path safety` (traversal, sibling prefix, symlink escape), policy tests |

## Mandatory end-to-end scenario (`tests/e2e/restart-recovery.test.ts`)

Real supervisor processes, real SQLite file, mock provider. Task 1 completes → Task 2 executes *partially* (writes `attendance/part1.txt`) → provider reports quota exhaustion with a reset 6 s ahead →
state `WAITING_FOR_CAPACITY` persisted with checkpoint and session id → **supervisor A `SIGKILL`ed** → supervisor B started while the provider is still exhausted
(verified idle: still 2 executions) → after the reset time Task 2 **resumes the saved session** and completes → Task 3 (depends on 2) completes.
Asserted: every task has exactly **one** `completed` execution; Task 2 outcomes `[partial, failed, completed]`; exact persisted transition sequence
`QUEUED→RUNNING→CHECKPOINTING→READY→RUNNING→CHECKPOINTING→WAITING_FOR_CAPACITY→RUNNING→CHECKPOINTING→COMPLETED`; marker log has no duplicate (task, attempt);
earlier artifacts untouched; `status --json` live; `stop` exits 0 and records `graceful:true`.
A second scenario `SIGKILL`s a supervisor *during* an execution and checks reconciliation (`interrupted` → resumed same session, retry budget untouched).

## Failures encountered while building (all fixed)

1. First integration run: quota test failed (`expected 5000 to be greater than 3590000`). Cause: the mock computed reset times from the real clock while the test used a fake clock.
   Fix: the mock provider takes an injectable `now`. Product behaviour was correct.
2. ESLint reported comma-expression statements in `store.ts` and `any` in tests - rewritten / test override added.
3. `systemd-analyze` flagged `StartLimit*` keys in the wrong section - moved to `[Unit]`.
4. CLI printed raw stacks for expected errors (illegal transition, unknown approval) - now a one-line `error:` message (`AGENT_DEBUG=1` restores stacks); covered by a test.

## Unresolved limitations (what these results do NOT prove)

* **No live Anthropic verification.** The Claude adapter is tested against scripted message streams shaped like the SDK's published type definitions. Real error strings, rate-limit events, `resetsAt` units
  (treated as seconds if < 1e12, else ms) and `apiKeySource` behaviour are unconfirmed until `npm run smoke:live` and real limit events are observed.
* **Windows is untested**: `install-task.ps1`, `run-supervisor.ps1`, `uninstall-task.ps1` were never run (no PowerShell in the sandbox); path/case handling for Windows is written but unexercised.
* **systemd** unit never started under a real init; the installer script was only syntax-checked (`bash -n`).
* Tests use short leases/timeouts; behaviour under multi-hour waits, sleep/resume of a laptop, or clock changes is not exercised (all scheduling uses epoch-ms comparisons against the wall clock).
* `MAX_CONCURRENT_WORKERS > 1` is enforced by the claim transaction (unit-tested for the cap) but multi-worker execution in one repository is not supported/tested (needs worktrees - Phase 2).
* Command screening in the permission policy is a guardrail, not a sandbox (see `docs/SECURITY.md`).
* Completion is "provider reported success"; acceptance criteria are not independently verified (Phase 2).
