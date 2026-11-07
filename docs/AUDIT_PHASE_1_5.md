# Independent audit (Phase 1.5)

Method: re-read the source rather than the Phase 1 report; compare every claim with what the installed SDK type definitions and the
official SDK docs say; write a failing test for each suspected defect before fixing it; run everything with real processes where the
claim concerned crashes/concurrency. Evidence strength is labelled **TESTED** (automated test, real processes where relevant),
**DOC-VERIFIED** (SDK .d.ts / official docs only), or **UNVERIFIED** (could not be checked here).

## A. Confirmed defects (all fixed, each with a regression test)

| # | Severity | Finding | Why Phase 1's mocked tests missed it | Fix | Evidence |
|---|---|---|---|---|---|
| 1 | **Critical (security)** | The Claude adapter listed `Bash/Write/Edit/...` in `allowedTools`. Per the SDK type docs those tools are *"auto-allowed without prompting"* and, per the permissions docs, *"never reach `canUseTool`"*. The approval policy (no `git push`, no deploys, workspace-only writes) was therefore **not enforced** in real SDK runs. | The mock never goes through SDK permission evaluation; the unit test called `canUseTool` directly. | `allowedTools` removed; `tools` restricts the toolset; policy enforced by a **PreToolUse hook** (hooks run first and a hook deny wins over allow rules) with `canUseTool` as a second layer. | `tests/unit/readiness-and-hooks.test.ts`, `claude-provider.test.ts` (asserts `allowedTools` is absent). Real-SDK behaviour: DOC-VERIFIED, not live-run. |
| 2 | **Critical (security)** | `settingSources: ['project']` made the SDK honour the workspace's `.claude/settings.json`. The model can write that file, so it could add allow-rules, hooks (arbitrary shell) or MCP servers and escape the policy. | Not observable with a mock. | `settingSources: []` (SDK isolation mode). Context now comes from the supervisor prompt, not CLAUDE.md. | unit test asserts `[]`; DOC-VERIFIED. |
| 3 | High (race) | Fencing was by `assigned_worker`, which equals the *supervisor instance id*. A runner whose lease had been reclaimed and re-claimed by the same supervisor could finish the **newer** execution of the task, and the periodic sweep could reclaim a task whose worker was still alive in-process. | Tests used one execution at a time. | `tasks.lease_execution_id` fencing token on heartbeat/transition/finish; sweep skips executions alive in this process; late/duplicate completions are recorded no-ops. | `phase15-recovery › execution fencing` (3 tests). |
| 4 | High (false positive) | Any provider "success" became `COMPLETED`, and the last completed task made the project look done. | By design in Phase 1. | Task-level verification gate (`CHANGES_EXIST`, `BUILD_PASSES`, `TESTS_PASS`) with persisted evidence; independent **project lifecycle** (`VERIFYING` → owner approval → `READY_FOR_DELIVERY`), never auto-delivered; success with denied tool calls is flagged. | `phase15-recovery › verification gating`, `project-lifecycle` (30 tests). |
| 5 | Medium (concurrency) | Read-then-write transactions used deferred `BEGIN`; with several processes on one file a lock upgrade can raise `SQLITE_BUSY` immediately, ignoring `busy_timeout`. | Single-process tests. | Write paths (`transition`, `enqueueTask`, finish, lifecycle) use `BEGIN IMMEDIATE`. | `e2e/concurrency` - 4 OS processes x 60 tasks on one file: 0 errors, each task claimed exactly once, `integrity_check = ok`. |
| 6 | Medium (infinite loops) | Network/outage/rate-limit failures never consumed anything, and a task that **crashes the worker** was re-queued forever after every restart. | Not exercised. | Per-task counters: consecutive provider failures (`MAX_PROVIDER_FAILURE_STREAK`) and consecutive crash-interruptions (`MAX_INTERRUPTIONS`) escalate to `BLOCKED` + `task.escalated` event; counters reset on progress; `task:unblock` resets them. Quota waits are intentionally not escalated. | `decide.test`, `phase15-recovery › escalation`. |
| 7 | Medium | Checkpoints were trusted blindly. | n/a | SHA-256 integrity hash per checkpoint; corrupt ones skipped (falls back to an older valid one or none) and reported; a checkpoint whose commit no longer exists is flagged in the recovery prompt. Legacy rows without a hash are accepted as unchecked. | `phase15-recovery › checkpoint integrity`, migration test. |
| 8 | Medium | A duplicated completion event made `applyDecision` throw. | n/a | Idempotent: ignored + `worker.duplicate_completion_ignored` event. | fencing tests. |
| 9 | Medium (cost) | Resuming a session that no longer exists cost a real request before failing. | Mock. | Local pre-check with the SDK's documented `getSessionInfo`; missing session → `INVALID_SESSION` without a request, then a new session from persisted context. | unit test (query never called). |
| 10 | Low | Activity events grew without bound; WAL was never checkpointed explicitly. | n/a | `EVENT_RETENTION_DAYS` pruning (info/debug only) + `wal_checkpoint(PASSIVE)` in periodic maintenance. | covered by integration run; **long-run soak not performed**. |
| 11 | Low | An uncaught exception/rejection left the supervisor in an undefined state. | n/a | Logged, graceful stop (checkpoint + lease release), exit code 1 for the service manager. | code review; not crash-injected. |
| 12 | Medium (Windows) | Wrapper issues found by static review: Windows PowerShell 5.1 turns native stderr into terminating errors under `$ErrorActionPreference='Stop'`; unbounded console capture; restart-looping on invalid config; `node` resolved from a PATH Task Scheduler may not have; uninstall used `npm`. | Never run on Windows. | Rewritten (see `docs/WINDOWS_DEPLOYMENT.md`). | static guard tests only; **not executed**. |
| 13 | Low | Evidence detail key `credentialFingerprint` was destroyed by the secret redactor (`credential` matches the key-name rule), making readiness evidence always look stale. | Found by a new test. | Key renamed `fingerprint`. | `readiness-and-hooks`. |
| 14 | Low | `renderProjectContext` could exceed its own length limit. | Found by a new test. | Suffix accounted for. | `project-lifecycle`. |

Two further defects were introduced and caught **during** this phase by the tests (a decision field that was never persisted - the failure streak - and a
silently-unapplied permission-policy edit); they never shipped.

## B. Verified correct (re-inspected, no change needed)

* Atomic claim: one `BEGIN IMMEDIATE` transaction; dependency, schedule, concurrency and lifecycle filters inside it. TESTED (unit + 4-process e2e).
* Supervisor singleton lock with stale-heartbeat/dead-pid takeover; graceful stop via DB flag (works on Windows). TESTED (real processes, SIGKILL + restart).
* State machine is the only writer of `tasks.status`; every transition persisted with reason, execution id, timestamp. TESTED.
* Session id is persisted the moment the SDK reports it (`system/init` carries `session_id`), before any outcome. TESTED with SDK-shaped streams.
* Startup reconciliation handles: outcome persisted but state not advanced; success in transcript but queue not updated; genuinely interrupted; missing workspace. TESTED.
* Rate-limit vs quota vs auth vs network vs crash vs invalid-session vs timeout vs permission vs budget are classified separately and never collapsed. TESTED (mock + SDK-shaped streams).
* Server `resetsAt` is honoured exactly (+margin); without it a conservative floor is used - no invented timestamps. TESTED.
* CLI: every advertised command is executed by `tests/e2e/cli-commands`. TESTED.

## C. Architectural weaknesses that remain (documented, not fixed in this phase)

1. **Command screening is a guardrail, not a sandbox.** A model can write a script and run it. Mitigation is isolation (dedicated OS user/VM, no production credentials). OS sandboxing is a Phase 2 item.
2. **Verification runs model-written code.** `BUILD_PASSES`/`TESTS_PASS` execute owner-configured commands (e.g. `npm test`) inside the workspace; those commands run code the model produced, with the supervisor user's privileges. Provider credentials are stripped from the child environment, but this is not a sandbox either.
3. **Abort semantics unverified.** `Query.interrupt()` is documented as streaming-input-only; the adapter aborts via `abortController` + `close()`. The docs do not say whether a session remains resumable after an abort. If it is not, recovery falls back to a new session from persisted context (tested), but **real behaviour is UNVERIFIED**.
4. **Real rate-limit/usage-limit messages are UNVERIFIED.** The docs section describing `rate_limit_event` and assistant error values was unreachable; mapping follows the installed `.d.ts`. It must be confirmed with real limit events.
5. **Session storage is host-local.** Sessions live under the service user's `~/.claude/projects/...`; on an ephemeral host they vanish and recovery uses a new session built from the checkpoint (tested). Keep that directory on persistent storage.
6. **Wall-clock dependence.** Leases and eligibility use epoch-ms comparisons. Large clock jumps can expire leases early; fencing makes a stale worker's result harmless but cannot undo duplicate *file edits* it already made. Only one supervisor/worker is supported in Phase 1.
7. **SQLite must be on a local disk** (not a network share).
8. **No soak test.** Multi-hour/day behaviour (log rotation, WAL size, memory) has not been exercised.
9. **WebFetch/WebSearch** are not in the tool set by default; if enabled they can exfiltrate data via URLs. The assignment policy can force approval (`alsoRequire: ['web_access']`).
10. `ANALYZING`/`PLANNING` task and project states are defined but unused (Phase 2).

## D. Provider claims vs. reality

| Claim | Status |
|---|---|
| "Claude provider works" | **Not established.** SDK installs/imports and the adapter is exercised against scripted SDK-shaped streams only. No live call has been made. `provider:status` now says so explicitly (see `docs/AUTHENTICATION.md`). |
| "Approval policy is enforced" | Before this phase: **false** for the real SDK (defect 1). Now enforced by design via hook + `canUseTool`; DOC-VERIFIED, not live-run. |
| "Recovery works" | Mock provider + real supervisor processes + SIGKILL: TESTED. Against real provider limits: UNVERIFIED. |
