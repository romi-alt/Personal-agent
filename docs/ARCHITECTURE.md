# Architecture

```
                         ┌──────────────────────────── CLI (npm run agent -- …) ───────────────────────────┐
                         │ doctor start stop status health projects tasks task:* approvals logs recovery … │
                         └───────────────┬───────────────────────────────────────────────────────────────┘
                                         │ all state changes go through the Store (SQLite, WAL)
┌────────────────────────────────────────▼───────────────────────────────────────────────────────────────┐
│ SQLite database: projects · tasks · task_transitions · executions · checkpoints · activity_events       │
│ provider_state · supervisor_state · approvals · workspaces · project_memory · schema_migrations         │
└──────▲───────────────────────────────▲──────────────────────────────────────────────▲──────────────────┘
       │ claim (IMMEDIATE tx)          │ heartbeat/lease                               │ reconcile
┌──────┴──────────────┐   ┌────────────┴─────────────┐                    ┌────────────┴───────────┐
│ Supervisor (process)│──▶│ TaskRunner (per execution)│──▶ ExecutionProvider│ Recovery               │
│ loop · gate · lock  │   │ prompt · heartbeat · ckpt │    ├─ mock (tests)   │ decide() · reconcile() │
│ graceful shutdown   │   │ applyDecision()           │    └─ claude (SDK)   └────────────────────────┘
└─────────────────────┘   └──────────────────────────┘
```

## Modules (`src/`)

| Module | Responsibility |
|---|---|
| `config/` | Zod-validated, environment-based configuration; `.env` is read but never written; secrets never appear in the config object (only `hasToken`). |
| `database/` | Connection (WAL, `foreign_keys`, `busy_timeout`) and append-only, transactional migrations. |
| `queue/` | `state-machine.ts` (the only transition table) and `store.ts` (all persistence: projects, tasks, atomic claim/lease, executions, checkpoints, events, approvals, memory, supervisor lock, provider state). |
| `supervisor/` | `Supervisor` loop, local-only `gate()`, status report, optional loopback health endpoint. |
| `workers/` | `TaskRunner`: one execution end-to-end (prompt → provider → checkpoint → durable decision). |
| `providers/` | `types.ts` (provider-neutral interface) · `mock/` (deterministic) · `claude/` (Agent SDK adapter, error mapping, credential source). |
| `recovery/` | `decide.ts` (pure failure policy) and `reconcile.ts` (startup/sweep reconciliation). |
| `scheduler/` | Exponential backoff with jitter and cap. |
| `checkpoints/`, `memory/` | Checkpoint writer (git ref + session ref) and recovery-prompt/project-memory support. |
| `workspaces/` | Path canonicalisation (symlink/`..` safe), approved-root registry, git state, branch isolation. |
| `security/` | Secret redaction and the tool-permission/approval policy. |
| `logging/` | Structured JSON logs with redaction, size rotation, age retention; per-execution transcripts. |
| `integrations/` | Typed read-only ERP/CRM contracts, mocks, event-mapping spec. |
| `cli/` | Management commands. |

Only the Claude adapter (`providers/claude`) knows about the Agent SDK; everything else sees `ExecutionProvider`
(`preflight()` + `run()` returning a normalised `RunOutcome`). A future backend implements those two methods.

## The supervisor

An independent Node process (`npm run agent -- start`). It never depends on an open Claude conversation.

* **Singleton lock** - a single `supervisor_state` row. A second supervisor is refused unless the holder's heartbeat is stale
  (> `LEASE_TTL_MS`) or its pid on this host is dead.
* **Loop** - heartbeat → (periodic lease sweep) → `tick()` → sleep. Sleep is `min(POLL_INTERVAL_MS, time to next eligible task)`
  and is interrupted by `wake()` (event-driven in-process). Idle cost is a few local SQLite reads; **no provider calls are made while idle**.
* **`gate()`** (all local): runs the provider's *local* preflight; honours `provider_state.blocked_until`; applies the daily
  estimated-spend limit. When credentials are missing it parks pending tasks in `WAITING_FOR_AUTHENTICATION`.
* **Claim** - `Store.claimNext` runs in one `BEGIN IMMEDIATE` transaction: pick the highest-priority eligible task (project
  priority, task priority, insertion order; dependencies must be `COMPLETED`; `scheduled_start`/`next_eligible_at` honoured; concurrency cap enforced),
  create the execution row, move the task to `RUNNING`, stamp `assigned_worker` + `lease_expires_at`. Two claimers can never win the same task.
* **Heartbeat** - the runner extends the lease every `HEARTBEAT_INTERVAL_MS`; if the extension fails (task cancelled/reclaimed) the provider is aborted and the result discarded.
* **Shutdown** - SIGINT/SIGTERM/SIGBREAK or `stop` (a DB flag, works on Windows): stop claiming, abort running work, wait up to
  `SHUTDOWN_GRACE_MS` for each worker to checkpoint, release the lock. Interrupted tasks return to `READY` without consuming a retry.

## State machine

States: `QUEUED ANALYZING PLANNING READY RUNNING CHECKPOINTING PAUSED WAITING_FOR_CAPACITY WAITING_FOR_AUTHENTICATION WAITING_FOR_APPROVAL RETRY_SCHEDULED BLOCKED COMPLETED FAILED CANCELLED`.

* `Store.transition()` is the only writer of `tasks.status`; it validates against `TRANSITIONS`, writes a `task_transitions` row
  (from, to, reason, execution id, timestamp) and an activity event in the same transaction.
* `COMPLETED` and `CANCELLED` are terminal; `FAILED` can only be manually re-queued.
* `ANALYZING`/`PLANNING` are defined and legal but unused in Phase 1 (they belong to the Phase 2 intelligence layer).
  Tasks are claimable from `QUEUED`, `READY`, `RETRY_SCHEDULED`, `WAITING_FOR_CAPACITY`, `WAITING_FOR_AUTHENTICATION`.

Typical execution: `QUEUED → RUNNING → CHECKPOINTING → COMPLETED`. The two-step finish (outcome + checkpoint committed atomically, then
the final state) is deliberate: a crash between the steps is repaired by reconciliation from the recorded outcome.

## Persistence

SQLite via `better-sqlite3` in WAL mode. All timestamps are epoch milliseconds. Writes that must be atomic (claim, finish, enqueue, lock) are transactions.
Migrations are append-only and each runs in its own transaction.
Large artefacts are *not* stored in the DB: code lives in the project git workspace; per-execution event transcripts are JSONL files referenced by `executions.log_ref`.

## Provider adapter

`ExecutionProvider.run(req)` receives the prompt, cwd, resume session id, limits, approved action types and an `AbortSignal`, and reports
via `onEvent`/`onSession` callbacks. It returns `completed | partial | failed(ProviderFailure)`. The provider classifies *what happened*
(`ErrorClass`, plus any server-provided `retryAfterMs`/`resetsAtMs`); the **recovery policy** (`decide.ts`) decides *what to do about it*.

The Claude adapter uses `query()` from `@anthropic-ai/claude-agent-sdk` with: `permissionMode: 'default'` (never `bypassPermissions`),
a `canUseTool` callback enforcing the workspace/approval policy, `maxTurns`, `maxBudgetUsd`, `abortController`, `settingSources: ['project']`
(global `~/.claude` settings are neither read nor changed), `resume` for session continuation, and an `env` that is the supervisor environment with the Console API key set and competing credential variables (OAuth/auth tokens, Bedrock/Vertex switches) removed.

## Recovery flow (summary - details in `docs/RECOVERY.md`)

1. Provider outcome → `decide()` → next status + eligibility time + provider-wide block.
2. `CHECKPOINTING` writes a checkpoint (session id + git HEAD/dirty + summaries).
3. On restart `reconcileOrphans('startup')` repairs anything left `RUNNING`/`CHECKPOINTING`; during operation a sweep reclaims expired leases.
4. The next claim resumes the stored session, or builds a recovery prompt from the last checkpoint, project memory and `git status`.

---

# Phase 1.5 addendum

* **Fencing:** `tasks.lease_execution_id` is the authoritative owner of a lease. Heartbeats, transitions (`fenceExecutionId`) and `applyDecision` all check it; stale/duplicate completions are recorded no-ops. The periodic sweep never reclaims an execution alive in the current process.
* **Write transactions** use `BEGIN IMMEDIATE` (multi-process safe, tested with 4 OS processes).
* **Project lifecycle** (`src/projects`) is independent of task statuses; **assignments** (`src/assignments`) persist the owner's contract; **verification** (`src/verification`) records append-only evidence and derives delivery readiness. See `docs/PROJECT_ASSIGNMENTS.md` and `docs/COMPLETION_VERIFICATION.md`.
* **Worker pipeline:** claim -> baseline fingerprint -> integrity-checked checkpoint + project context -> provider run -> (if success) evidence `CLAIMED_COMPLETE` + task verification -> finish transaction -> decision transaction. The heartbeat runs through verification.
* **Escalation counters** (`interruption_count`, `provider_failure_streak`) bound retries; `MAX_INTERRUPTIONS`, `MAX_PROVIDER_FAILURE_STREAK`.
* **Provider readiness** (`src/providers/readiness.ts`) with persisted, staleness-aware live-verification evidence.
* Schema migration 2 upgrades Phase 1 databases in place (tested).

---

# Phase 2 addendum

`src/planning/*` (schemas, JSON extraction, prompts, deterministic validators) and `src/workflows/*` (`WorkflowEngine`, `WorkflowRepository`) implement the planning pipeline on top of the existing queue:
planning steps are read-only `PLANNING` tasks, the engine advances on every supervisor tick, and plan materialisation creates ordinary coding tasks. See `docs/PLANNING.md`.

---

# Phase 2 stage 5 addendum

`src/progress/` computes evidence-based progress (`model.ts`), appends change-only snapshots (`snapshots.ts`, driven by the supervisor's `ProgressTracker`) and builds the owner inbox from durable state (`inbox.ts`).
Strict milestone gating is enforced inside `Store.claimNext` (`milestoneGateOpen`). Migration 11 adds `progress_snapshots` (shipped on main as migration 4; renumbered at the v2/main integration because version 4 already exists on the v1/v2 line). See `docs/PROGRESS_TRACKING.md`.
