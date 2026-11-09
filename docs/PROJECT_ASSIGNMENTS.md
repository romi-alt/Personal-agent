# Project assignments and project lifecycle

An **assignment** is the owner's contract for a project. Phase 1.5 implements registration, validation, persistence and durable
context only. It does **not** analyse, plan or decompose (Phase 2).

```bash
npm run agent -- assignment:add --file examples/assignment.example.json
npm run agent -- assignment:show school-management-erp
npm run agent -- project:status school-management-erp
```

## Schema (`src/assignments/schema.ts`, zod, `schema_version` 1, unknown keys rejected)

| Field | Type | Notes |
|---|---|---|
| `title`, `description` | string | required |
| `businessObjectives` | string[] (>= 1) | required |
| `functionalRequirements` | `{id, text, priority: must|should|could}[]` (>= 1) | ids unique; referenced in prompts and later verification |
| `nonFunctionalRequirements` | same shape | default `[]` |
| `technicalConstraints` | string[] | default `[]`; stored in project memory `important_decisions` |
| `workspace` | `{type:'managed'}` or `{type:'existing', path, allowDirty?}` | existing paths must be inside an approved workspace root; dirty repos refused unless `allowDirty`; work happens on branch `agent/<slug>` |
| `expectedDeliverables` | string[] (>= 1) | required |
| `acceptanceCriteria` | `{id, text, verifiedBy: build|tests|review|manual}[]` (>= 1) | `build`/`tests` map to the verification commands; `review`/`manual` need Phase 2 / the owner |
| `priority` | int -100..100 | project priority in queue ordering |
| `budget` | `{maxUsdTotal?, maxUsdPerExecution?, maxExecutions?}` | enforced at claim time (total estimated spend, execution count) and per execution (min with the global cap). Estimates, not billing |
| `approvalPolicy` | `{preApproved: [...], alsoRequire: [...], deliveryRequiresOwnerApproval: true}` | `preApproved` may only contain `destructive_delete`, `system_modification`, `external_tool`. Production-facing categories (deploy, publish, push, live migration, credentials, customer messages, money, access control) **cannot** be pre-approved. `alsoRequire`: `web_access`, `external_tool`. Delivery approval is fixed to `true` |
| `requiredIntegrations` | `{system: erp|crm|github|other, access: none|read, purpose}[]` | **write access cannot be requested** in Phase 1.5 |
| `execution` | `{milestoneGating: strict|off}` | default `strict`: planned tasks of a milestone wait until all earlier milestones are finished (see `docs/PROGRESS_TRACKING.md`) |
| `verification` | `{buildCommand?, testCommand?}` | owner-configured commands run by the verifiers (see below) |
| `source` | `{system: manual|erp|crm, externalId?}` | `(system, externalId)` makes registration idempotent - re-registering returns the existing project |

Registration (`registerAssignment`) validates, creates or attaches the workspace, saves the contract in `assignments`, seeds project memory
(`assignment`, `requirements`, `important_decisions`), and records `assignment.registered`. All in one transaction apart from the git work.

## Durable project context

`buildProjectContext(store, projectId)` rebuilds everything from the database: project + lifecycle, the assignment, task counts/completed/open,
estimated spend, latest valid checkpoint, memory sections. `renderProjectContext` produces a bounded text block that the worker prepends to every
prompt (fresh, resume and recovery), so a new process or a new Claude session sees the contract without relying on conversation history.

## Project lifecycle (separate from task states and from the operational `projects.status`)

```
REGISTERED -> (ANALYZING -> PLANNING)* -> IN_DEVELOPMENT -> VERIFYING -> AWAITING_OWNER_APPROVAL -> READY_FOR_DELIVERY -> DELIVERED
                                              ^                 |                  |
                                              +-----------------+------------------+   (failed verification / new work re-opens)
PAUSED, BLOCKED, CANCELLED reachable from most states.   (* reserved for Phase 2)
```

* Adding a task to a project that is waiting on verification/approval/delivery moves it back to `IN_DEVELOPMENT`.
* When **every** task is `COMPLETED`/`CANCELLED` the project moves only to `VERIFYING`. A provider success, or even all of them, never completes a project.
* `project:verify` runs independent checks and records evidence; with nothing `FAILED` the project moves to `AWAITING_OWNER_APPROVAL`, otherwise back to `IN_DEVELOPMENT`.
* `project:accept` (owner) is refused when anything failed; unevaluated levels need an explicit `--acknowledge-unverified "<why>"`, which is stored as evidence. Result: `READY_FOR_DELIVERY`.
* `project:deliver --reason` records `DELIVERED`. It deploys nothing.
* `PAUSED/BLOCKED/CANCELLED/DELIVERED` projects are not executed by the supervisor. All transitions are validated centrally and stored in `project_transitions`.
