# Dispatch, evidence-based progress and the owner inbox (Phase 2, stage 5)

Status: **implemented and tested with the mock provider and real processes; not run against a real model.**

```bash
npm run agent -- progress <project>            # verified vs claimed, milestones, tasks, requirements, blockers
npm run agent -- progress <project> --history  # snapshots over time
npm run agent -- inbox                         # everything waiting for YOUR decision, with the command that resolves it
npm run agent -- status                        # now includes "Owner inbox: N item(s)"
```

## 1. Progress is derived from evidence, never from claims (`src/progress/model.ts`)

Two numbers are always shown, and the headline is the lower one:

| Number | Meaning |
|---|---|
| **`verifiedPercent`** | weight of tasks whose *required* independent checks (`CHANGES_EXIST`, `BUILD_PASSES`, `TESTS_PASS`) all **PASSED** |
| `claimedPercent` | weight of tasks the provider reported complete (an upper bound, shown for transparency) |

Per task (`weight`: plan size S=1, M=2, L=3; unplanned tasks 1; cancelled tasks excluded):

| State | Rule |
|---|---|
| `VERIFIED` | `COMPLETED` and every required level's **latest** evidence is `PASSED` |
| `CLAIMED` | `COMPLETED` but no verification was required, or some required level is `NOT_CONFIGURED` / missing (the note says which) |
| `FAILED_VERIFICATION` | `COMPLETED` but the latest evidence for a required level is `FAILED` (e.g. a later re-check regressed) |
| `NOT_DONE` | anything else (a task that fails verification is not completed - it retries - and the note says why) |

* The latest evidence row per level wins: a later failure demotes a verified task, a later pass promotes it.
* A task with no required verification can **only ever be "claimed"**. The planner therefore requires `CHANGES_EXIST` on every planned task.
* **No ETA is produced** (there is no basis for one); the output says so.

Derived views: **milestones** (`NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `COMPLETE_UNVERIFIED`, `VERIFIED`), **requirements**
(`NO_TASK`, `NOT_STARTED`, `IN_PROGRESS`, `CLAIMED`, `TASKS_VERIFIED` - which means the tasks covering it passed their checks;
*requirement satisfaction itself is not independently reviewed yet*, that is stage 7), and **blockers** (blocked/failed/waiting tasks with their reasons).

## 2. Snapshots (`src/progress/snapshots.ts`)

`progress_snapshots` is an append-only history written by the supervisor on each tick, **only when something material changed** (task state, verification,
milestone or requirement state). Change detection uses a monotonic token (highest activity-event rowid), not a timestamp, so changes within the same
millisecond cannot be missed. Each recorded snapshot also refreshes `projects.progress_summary`, `projects.current_milestone` and `milestones.status`.
History is capped at 500 rows per project. (This replaced Phase 1's "Last completed: <task>" summary, which was a provider claim.)

## 3. Milestone-aware dispatch

Priority order already favoured earlier milestones (plan materialisation adds a milestone bonus). Stage 5 makes it a **rule**:

* `execution.milestoneGating` in the assignment (default **`strict`**): a planned task of milestone N is not started while *any* task of an earlier milestone is still open
  (not `COMPLETED`/`CANCELLED`). Even a much higher-priority later-milestone task waits, and if an earlier milestone has a failed/blocked task the later ones are not
  started on top of it - the owner sees the failure in the inbox. Set `off` to let dependencies and priority alone order the work.
* Enforced inside the atomic claim transaction (`Store.milestoneGateOpen`), so it holds with several supervisors. Tasks with no plan link (added manually) are never gated.

## 4. Owner inbox (`src/progress/inbox.ts`)

One place for every pending human decision, **derived from durable state** (nothing is stored separately, so it cannot go stale). Each item has a stable key, a severity and the exact commands that resolve it.

| Kind | Severity | Resolve with |
|---|---|---|
| `TASK_ESCALATION` (blocked: budget, repeated failures/crashes, continuation limit) | high | `task:show`, `task:unblock`, `task:cancel` |
| `TASK_FAILED` | high | `task:show`, `task:retry`, `task:cancel` |
| `WORKFLOW_FAILED`, `PROJECT_BLOCKED` | high | `workflow:show`, `plan:start` |
| `CREDENTIALS_NEEDED` (tasks waiting for authentication) | high | `provider:status`, `doctor` |
| `PLAN_APPROVAL`, `PERMISSION_APPROVAL` | medium | `approve <id>` / `deny <id>` |
| `CLARIFICATION_QUESTION` (blocks planning) | medium | `workflow:answer`, `workflow:resume --assume` |
| `PROJECT_ACCEPTANCE` | medium | `project:status`, `project:accept [--acknowledge-unverified "why"]` |
| `BUDGET_HELD` | medium | `assignment:show`, `project:status` |
| `PROJECT_VERIFICATION_NEEDED` (all tasks done) | low | `project:verify` |

Sorted by severity, then age. A failed planning run is shown once and cleared by a newer run; items disappear as soon as the underlying state resolves.

## Tests

`tests/integration/progress-dispatch.test.ts` (25) - verified-vs-claimed on the real planning pipeline (claimed 100% / verified 60%; failing check holds both at 40%; provider "success" with no changes
raises nothing; latest evidence wins; no ETA), milestone/requirement states, snapshots (automatic, change-only, monotonic in a clean run, bounded), gating (strict blocks later milestones behind a failed
earlier one, ignores a priority-99 later task, `off` lets it run, manual tasks ungated), and every inbox kind appearing and clearing. `tests/e2e/cli-commands` and `tests/e2e/planning-e2e` check the CLI output
with real processes. Mutation checks: counting unchecked tasks as verified, or leaving the gate always open, each make tests fail.

## Not implemented / limits

* `verifiedPercent` measures *checks passed*, not whether the right thing was built: requirement-level review (stage 7) and security checks (stage 9) are still missing, and requirement states say so.
* Weights are size-based only (no effort/cost model). Percentages are of *planned* work; scope added later changes them (the history shows it).
* Push notifications for inbox items are not implemented (pull via `inbox` / `status`).
* Gating is per project and sequential; parallel milestones need worktree isolation (stage 11).
