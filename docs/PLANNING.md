# Planning pipeline (Phase 2, stages 1-4)

Status: **implemented and tested with the mock provider and real supervisor processes; NOT verified against the live Anthropic API.**
No real model has ever produced a plan through this code: prompt quality, the model's ability to emit valid JSON, and cost per plan are unknown until the live gate
(`docs/PHASE_2_ROADMAP.md` stage 0) is passed.

```bash
npm run agent -- assignment:add --file examples/assignment.example.json
npm run agent -- plan:start school-management-erp      # creates the workflow run
npm run agent -- start                                  # the supervisor executes the planning steps
npm run agent -- workflow:show <run>                    # steps, blocking questions, what it is waiting for
npm run agent -- approve <approval-id>                  # approve the plan (PLAN_APPROVAL=required, the default)
npm run agent -- plan:show school-management-erp        # requirements, milestones, tasks, coverage
```

## Design

* **One deterministic orchestrator, bounded workflows.** `WorkflowEngine` (`src/workflows/engine.ts`) is a state machine over `workflow_runs` / `workflow_steps`.
  It holds nothing in memory: `advance()` is a pure function of the database, so it is safe to replay after any crash. It runs on every supervisor tick (local SQL only).
* **Every model call is an ordinary queue task** of kind `PLANNING` (`tasks.kind`, `tasks.read_only`). Claims, fenced leases, retries, rate-limit/quota waiting,
  authentication gating, budgets, checkpoints, session resume and restart reconciliation are inherited unchanged - nothing was re-implemented for planning.
* **Read-only by construction.** Planning tasks run with `readOnly`: the Claude adapter exposes only `Read/Glob/Grep`, the policy hook and `canUseTool` deny everything else,
  and the system prompt says so. (Mock provider writes no artifacts for read-only tasks.)
* **Model output is data.** Replies are parsed (`extractJson`, tolerant of a fence or prose, never guessing), validated by zod schemas (`src/planning/schemas.ts`) and then by
  deterministic validators (`src/planning/validate-plan.ts`). Invalid output goes back to the model with the validator's exact errors for a bounded number of repairs
  (`MAX_PLAN_REPAIRS`, default 2); after that the run `FAILED`, the project is `BLOCKED` and the owner is told. Nothing invalid is ever accepted or "fixed up" in code.

## Steps

| Step | Task title | Output (JSON) | Deterministic checks | Effects |
|---|---|---|---|---|
| `analyze` | `Plan: analyze` | refined requirements, assumptions, risks, questions | every assignment requirement id kept; new requirements only as `DR-*`; unique ids | `requirements` table + memory `requirements`; project `ANALYZING` |
| `clarify` (optional) | - | owner answers | blocking questions answered, or `workflow:resume --assume` | run `WAITING_FOR_OWNER` until answered |
| `architect` | `Plan: architect` | decisions, technology, components, data model | every requirement owned by >= 1 component; no unknown references | memory `architecture_decisions`, `technology_decisions`; project `PLANNING` |
| `decompose` | `Plan: decompose` | milestones + tasks (key, instructions, acceptance, deps, requirement ids, size, verify) | <= `MAX_PLAN_TASKS`; sizes S/M only; unique keys; deps exist; **acyclic**; no dependency on a later milestone; every milestone has tasks; **every requirement implemented by >= 1 task**; every task requires `CHANGES_EXIST` | validated plan stored |
| `approval` | - | owner decision | `PLAN_APPROVAL=required` (default) creates a `plan_approval` approval; `auto` skips it | `WAITING_FOR_OWNER` until `approve`/`deny` |
| materialise | - | - | re-validates the plan | milestones, plan links, **coding tasks** in topological order with mapped dependencies, milestone-ordered priority, per-task `verification_required`, idempotent keys `plan:<run>:<task key>`; project `IN_DEVELOPMENT`; memory `roadmap` |

A rejected plan cancels the run and creates nothing; `plan:start` again begins a fresh run (also from `BLOCKED`/`PAUSED`, by explicit owner action).

## Interaction with earlier phases

* Planning tasks never advance the project lifecycle on their own: `VERIFYING` is reached only when all **coding** tasks are terminal. After execution the
  Phase 1.5 verification/acceptance flow applies unchanged (`project:verify`, `project:accept`); delivery is never automatic.
* Each planned coding task carries `verification_required` from the plan (always `CHANGES_EXIST`; optionally build/tests), so the worker's post-run verification gate applies.
* The plan's tasks use the assignment's budgets, approval policy and verification commands exactly like manually added tasks.

## Data model (migration 3)

`tasks.kind/read_only` · `task_outputs` (full final reply) · `workflow_runs`, `workflow_steps` (unique per run/step/attempt) · `requirements` · `milestones` · `plan_tasks`.

## Tests

* Unit (`tests/unit/planning.test.ts`): JSON extraction, schemas, every validator rule (11 rejection cases), property tests on 200 random DAGs and 200 cycle injections, read-only policy.
* Integration (`tests/integration/planning-workflow.test.ts`, 17): happy path through to `VERIFYING`; prompts carry context; approval/rejection/clarification gates; repair loop, cycle/prose/fence handling,
  repair exhaustion -> `BLOCKED`; task failure; restart mid-workflow with no duplicates; rate-limit wait inside a step; idempotent materialisation; cancellation; denied-tool wait.
* End-to-end (`tests/e2e/planning-e2e.test.ts`): real processes - supervisor `SIGKILL`ed while the architecture step is running, restarted, approval via CLI, all 3 planning + 3 coding tasks completed exactly once.
* Mutation check: disabling the coverage validator makes 3 tests fail (so the tests are sensitive to it).

## Not implemented / known limits

* Quality of real model plans is unmeasured (no live run). Expect to tune prompts and schemas once the live gate is passed.
* No incremental re-planning: changing requirements later means a new planning run (existing tasks are not diffed/merged).
* The decomposition validator checks structure and coverage, not whether a task's instructions are *good*; the independent reviewer (stage 7) is still to be built.
* Progress is not yet derived from evidence per milestone (stage 5); `plan:show` reports task statuses only.
* One planning run per project at a time; planning prompts are bounded text, so very large assignments/repositories are not yet chunked.
