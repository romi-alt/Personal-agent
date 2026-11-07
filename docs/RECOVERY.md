# Recovery

Principle: **a saved conversation is not a saved filesystem.** Every execution persists both a provider session reference and a
repository reference (git branch@HEAD + dirty flag), and recovery verifies the real working tree before continuing.

## Failure classes (never collapsed into "rate limit")

Provider adapters classify; `src/recovery/decide.ts` applies policy. Unit-tested in `tests/unit/decide.test.ts`.

| Condition | Source of the signal (Claude adapter) | Task goes to | Timing | Consumes a retry? |
|---|---|---|---|---|
| Short-lived rate limit | `rate_limit` assistant error without a rejected plan window | `WAITING_FOR_CAPACITY` | server `retryAfterMs` if given, else exponential backoff + jitter (cap `BACKOFF_MAX_MS`) | no |
| Usage-quota exhaustion | `rate_limit_event` with `status:'rejected'` + `rateLimitType` (`five_hour`, `seven_day`, …); `billing_error` | `WAITING_FOR_CAPACITY` | provider `resetsAt` **exactly** (+`RESET_MARGIN_MS`); if absent, a conservative `QUOTA_MIN_WAIT_MS` floor with backoff - **no invented reset time** | no |
| Authentication expired/invalid | `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error`, or missing preflight | `WAITING_FOR_AUTHENTICATION` | until the credential **fingerprint changes** (or preflight turns ready) | no |
| Network interruption | thrown `ECONNRESET`/`ENOTFOUND`/`fetch failed`… | `RETRY_SCHEDULED` | backoff | no |
| Provider outage | `overloaded`, `server_error` | `RETRY_SCHEDULED` | backoff | no |
| CLI/SDK process crash | thrown "exited with code …", stream ended with no result | `RETRY_SCHEDULED` | backoff | **yes** |
| Invalid session reference | "No conversation found…" | `READY` | immediately, **session cleared**, new session built from persisted context; reason recorded | no (once) |
| Execution timeout | `WORKER_TIMEOUT_MS` abort | `RETRY_SCHEDULED` | backoff | yes |
| Permission denial | `canUseTool` deny of an approval-gated action | `WAITING_FOR_APPROVAL` + `approvals` row | until `approve`/`deny` | no |
| Budget exhaustion | `error_max_budget_usd` | `BLOCKED` | owner must raise budget → `task:unblock` | no |
| Actual task failure | `error_during_execution`, unclassified errors | `RETRY_SCHEDULED` → `FAILED` | backoff; after `max_retries` → `FAILED` | yes |
| Partial completion | `error_max_turns` | `READY` | immediately, same session | no (counts as a *continuation*, capped by `MAX_CONTINUATIONS`) |
| Supervisor shutdown | abort | `READY` | on next start | no |

Rate-limit/quota/outage/auth outcomes also set a **provider-wide** state (`provider_state`), so one task hitting a limit stops the supervisor from
launching *any* other task against the same limited provider. Nothing is polled while blocked; the only wake-ups are local timers.

## Backoff

`delay = min(BACKOFF_MAX_MS, BACKOFF_BASE_MS · 2^(n-1)) · (1 ± BACKOFF_JITTER)`, hard-capped at `BACKOFF_MAX_MS`, `n` = consecutive provider failures
(or the task's attempt count for task-level failures). Server guidance always wins over the formula.

## Usage-limit scenario, step by step

1. Task running → provider returns a limit. 2. Adapter classifies (`QUOTA_EXHAUSTED` + `resetsAtMs` when supplied).
3. Runner writes the execution outcome, `RUNNING → CHECKPOINTING`, and a checkpoint (session id + git state + summaries) in **one transaction**.
4. Decision applied: `CHECKPOINTING → WAITING_FOR_CAPACITY`, `next_eligible_at`, provider block recorded.
5. Supervisor idles (no provider calls). 6. At the eligible time the task is claimed; because `tasks.session_id` is stored the run **resumes that session**
with a prompt telling it to inspect existing files/`git status` first. 7. If the session is invalid, a new session is built from the last checkpoint, project memory and
current git status, and the reason is stored in the transition history.

Verified with the mock provider (`tests/integration/supervisor.test.ts`, `tests/e2e/restart-recovery.test.ts`). **Not verified against the live Anthropic API.**

## Restart reconciliation (`reconcileOrphans`)

On startup the supervisor first acquires the singleton lock. Because that proves no other supervisor is alive, every task still `RUNNING`/`CHECKPOINTING` is orphaned. For each:

1. Latest execution has a recorded outcome (crash between the two durable steps) → **re-apply** the outcome (`reapplied_outcome`).
2. Else the execution transcript's last `result` record says `completed` → mark `COMPLETED` with that evidence (`completed_from_evidence`); **never re-run finished work**.
3. Else genuinely interrupted → close the execution as `interrupted`, write a recovery checkpoint from the *current* working tree, and move the task to `READY`
   (retry budget untouched). The next run resumes `session_id` or rebuilds context.
4. If the project directory is missing/unapproved → `BLOCKED` (no fabricated workspace).
5. If an old worker pid on this host still exists it is logged (`recovery.stale_process_alive`); it is **not** killed - the lease is simply reclaimed.

During operation a periodic sweep reclaims only tasks whose lease has expired. Every action is stored as `recovery.task_reconciled`; `npm run agent -- recovery` lists them.

## Manual intervention

| Situation | Command |
|---|---|
| See what is waiting and why | `npm run agent -- recovery` / `status` / `task:show <id>` |
| Supervisor crashed and you do not want to restart it yet | `npm run agent -- recovery --run` (refuses if a supervisor is live) |
| Task `FAILED` and you fixed the cause | `task:retry <id>` (resets attempts) |
| Task `BLOCKED` (budget, continuation limit, missing workspace) | fix cause → `task:unblock <id>` |
| Approval needed | `approvals`, then `approve <id>` or `deny <id>` |
| Stuck session you want to abandon | `task:cancel <id>` and re-add the task (a new session is built from the checkpoint/memory) |
| Wait for a limit is too long and you legitimately have capacity | not bypassed automatically; edit the DB only if you are sure, or `task:retry` after the limit truly cleared |

Limits of recovery: SQLite runs in WAL mode with `synchronous=NORMAL`. This is durable across process crashes and `kill -9` (tested), and the database stays consistent after a power
loss, but the most recent transactions *may be rolled back* by an OS crash or power failure - recovery then simply sees the slightly older state and re-does that step. Work the model
did but never committed to git is only as durable as the working tree on disk.

---

# Phase 1.5 addendum - production-oriented recovery

| Requirement | Mechanism |
|---|---|
| Save state before and after execution boundaries | claim writes `RUNNING` + execution row (before); the finish transaction writes execution outcome + `CHECKPOINTING` + checkpoint atomically, then a second transaction writes the final state (after). A crash between them is repaired from the recorded outcome. |
| Preserve session ids and checkpoint refs | session id persisted on first SDK message; checkpoint = session ref + `branch@HEAD` + dirty flag + summaries + integrity hash. |
| Rate limits vs usage exhaustion | distinct classes (table above). Server retry guidance/reset times honoured exactly. |
| Wait without sending requests | provider-wide block in `provider_state`; the loop only reads local SQLite; credential preflight is local; nothing calls the API while idle. |
| Resume only with legitimate capacity | claims are gated by `blocked_until`, auth readiness (credential fingerprint must change after a rejection), the daily budget and per-project budgets. |
| Inspect repository changes before replaying | every resume/recovery prompt contains `git status` + changed files + last checkpoint + warnings ("files may be partially written"); checkpoint commit existence is verified; corrupt checkpoints are skipped. |
| Avoid duplicating completed steps | fenced leases (execution-id token), duplicate completions are no-ops, evidence-based completion recovery (transcript), session resume, prompt instructs to inspect before acting. |
| Stop safely without auth/budget | `WAITING_FOR_AUTHENTICATION` / provider gate closed; `BLOCKED` on budget exhaustion. |
| Escalate instead of looping | `MAX_INTERRUPTIONS` (crash loop) and `MAX_PROVIDER_FAILURE_STREAK` (network/outage/rate-limit) -> `BLOCKED` + `task.escalated` event; retries/continuations are capped; `task:unblock` resets counters. |

Tested scenarios (Linux; mock provider; real supervisor processes where noted): restart recovery with SIGKILL (real), incomplete tool execution (crash after a partial file write),
stale leases and sweep, a live in-process worker that missed heartbeats, corrupted checkpoint (tampered row), dangling checkpoint commit, duplicated completion event, stale-worker late completion,
poison task (crash loop), repeated network failures, schema migration from a Phase 1 database, 4-process database contention.
**Not tested:** real provider limits/abort behaviour, multi-hour waits, power loss, clock jumps, Windows.
