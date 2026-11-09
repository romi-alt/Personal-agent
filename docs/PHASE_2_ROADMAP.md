# Phase 2 - technical implementation plan

> **Progress:** stages **1-5 are implemented** (workflow engine, requirement analysis, architecture, decomposition + plan validation + owner approval + materialisation; evidence-based progress, milestone gating, owner inbox) with the mock provider -
> see `docs/PLANNING.md` and `docs/PROGRESS_TRACKING.md`. Stages 6-12 are **not implemented**. Stage 0 (live verification, isolation decision) is **still open**: nothing in Phase 2 has run against a real model yet.

Goal: turn the Phase 1/1.5 runtime into a **project execution engine**: given a registered assignment it analyses, plans, decomposes, dispatches coding tasks,
inspects and verifies the result, creates correction tasks, survives interruptions, keeps accurate progress and surfaces approvals - until verified completion or a blocker.

**Design stance: one reliable orchestrator with specialised, bounded workflows** - not a swarm. Each workflow is a deterministic code path that makes
a small number of *structured-output* model calls, persists its result, and is individually testable with the mock provider. Multi-agent parallelism
is deferred until single-worker reliability is proven (Phase 3+).

## 0. Gate before any Phase 2 code (owner/environment actions)

1. Live verification: `provider:verify --access`, `npm run smoke:live`, `npm run smoke:live-recovery` pass; `provider:status` shows `operational: YES`. Confirm real rate-limit / abort / resume behaviour and fix the adapter mapping to what is observed.
2. Windows checklist (`docs/WINDOWS_DEPLOYMENT.md`) completed on the real PC, or the VPS deployed.
3. Read-only inspection of the actual ELEVARIQ ERP/CRM code and API docs (no production access).
4. Decide the isolation level for unattended coding (dedicated VM/VPS/container) - required before Stage 6.

## Stage overview (each stage ships behind its own tests; later stages never block earlier ones)

| Stage | Capability (maps to the 15 required abilities) | New modules | New tables / fields | Test strategy (no paid traffic) |
|---|---|---|---|---|
| **1. Workflow engine** | durable multi-step workflows on top of the queue (resume mid-workflow, idempotent steps) | `src/workflows/{engine,step,registry}.ts` | `workflow_runs`, `workflow_steps` (state, input/output hash, attempt) | step replay, crash between steps, duplicate step delivery (reuse fencing pattern) |
| **2. Requirement analysis** (1,2) | `analysis` workflow: assignment -> structured requirement model (ids, dependencies, ambiguities, risks); ambiguities become owner questions | `src/planning/analysis.ts`, `src/planning/schemas.ts` | `requirements` (id, text, priority, status, source), `questions` | schema validation of model output with canned responses; mock provider returns fixtures; invalid JSON retry/escalation |
| **3. Architecture & plan** (3) | `architecture` workflow -> decisions recorded in project memory (`architecture_decisions`, `technology_decisions`, `roadmap`); ADR files committed to the repo | `src/planning/architecture.ts` | memory sections already exist | golden-fixture tests; plan must reference every requirement id (coverage check is code, not model opinion) |
| **4. Decomposition** (4,5,6) | milestones -> tasks with dependencies, acceptance criteria, `verification_required`, priority; plan validated: acyclic, every requirement covered, size-bounded tasks | `src/planning/decompose.ts`, `src/planning/validate-plan.ts` | `milestones`, `tasks.milestone_id`, `tasks.requirement_ids` | property tests on the DAG validator; coverage report; enqueue is idempotent via `dedupe_key = plan:<hash>:<task key>` |
| **5. Dispatch & progress** (7,13,14) | already: claim -> provider. Add milestone-aware ordering, progress model (weighted by verified evidence, not by model claims), owner approval inbox | `src/progress/*` | `progress_snapshots` | progress is derived only from evidence rows; regression: provider claims never raise progress alone |
| **6. Inspect, build, test** (8,9) | post-execution inspector: diff summary, changed-file policy (no secrets, no out-of-scope paths), build/test runners with structured results, test-report parsing | `src/verification/inspect.ts`, `runners.ts` | evidence payloads | fixture repos (pass/fail/flaky) run for real; timeouts; output redaction |
| **7. Independent requirement checks** (10) | `review` workflow in a **separate** session that sees only requirements + diff + test results (never the implementer's reasoning) and returns per-requirement verdicts with cited files/lines; verdicts without citations are rejected | `src/verification/requirements.ts` | `requirement_verdicts` | canned verdicts; citation checker verifies cited lines exist in the repo |
| **8. Corrective loop** (11,12) | failed evidence/verdicts -> typed correction tasks (defect, missing requirement, failing test) with bounded attempts and escalation | `src/planning/corrections.ts` | `defects` | loop-bound tests (no infinite repair loops), dedupe of identical defects |
| **9. Security verification** | dependency audit, secret scan, SAST via local tools; findings become defects; policy for what blocks delivery | `src/verification/security.ts` | evidence | fixtures with seeded secrets/vulns |
| **10. Reporting & delivery** (15) | verified completion report (requirement -> evidence table), owner briefing, `READY_FOR_DELIVERY` only through existing `acceptProject` | `src/reporting/*` | `reports` | report contains only evidence-backed claims (test asserts every claim links to an evidence id) |
| **11. Isolation** | per-project sandbox (container/VM or SDK `sandbox` option) for provider tools and for build/test commands; network egress allow-list; replace regex screening as the primary control | `src/sandbox/*` | n/a | escape-attempt fixtures (write outside, curl to unlisted host, read `~/.ssh`) |
| **12. ERP read adapter** | live read-only adapters behind the existing interfaces, cursor sync, idempotent import, owner briefings | `src/integrations/elevariq-erp/live.ts` | `sync_cursors`, `sync_runs` | contract tests against a recorded/mock server; duplicate-page and retry tests |

Suggested order: **0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 11 -> 7 -> 8 -> 9 -> 10 -> 12** (isolation before the agent is trusted to run its own plans unattended).

## Key design rules

* **Model output is data, never control flow.** Every model response is parsed with a zod schema; failures retry with the validation error, then escalate. The orchestrator decides state transitions in code.
* **Progress and completion come from evidence** (`verification_evidence`), not from model statements.
* **Every workflow step is idempotent and resumable**: inputs hashed, outputs persisted before the next step, fenced by the same lease/execution-id mechanism as tasks.
* **Bounded autonomy:** per-project budgets (already enforced), attempt/continuation/interruption/failure-streak caps (already enforced), a maximum plan size, and an owner approval for plan changes above a threshold.
* **Owner in the loop at defined points:** ambiguous requirements, plan approval (configurable), any approval-gated action, acceptance. Notifications via the approvals table first; push/email later.
* **Memory:** keep project memory as structured sections + checkpoints; add summarisation jobs only when prompt size demands it; vector retrieval only if measured to be needed.
* **Context discipline:** each model call gets the assignment contract + only the slice of state it needs (rendered by `renderProjectContext` plus stage-specific inputs).

## Execution-engine data flow

```
assignment:add -> REGISTERED
  -> workflow: analyse  -> requirements (+ questions)          [ANALYZING]
  -> workflow: architect -> decisions/ADRs                      [PLANNING]
  -> workflow: decompose -> milestones + tasks (validated DAG)  [PLANNING -> IN_DEVELOPMENT]
  -> supervisor dispatches tasks (existing queue, leases, recovery)
       -> provider run -> inspect diff -> build/test -> task evidence
  -> all tasks done -> VERIFYING: project build/tests/security + independent requirement review
       -> failures -> correction tasks -> IN_DEVELOPMENT (bounded)
       -> all PASSED -> AWAITING_OWNER_APPROVAL -> owner accepts -> READY_FOR_DELIVERY
```

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plans that look plausible but miss requirements | coverage validation in code; independent reviewer session; owner plan approval |
| Runaway cost | existing per-execution/daily/project caps; workflow-level caps; estimated-vs-billed reconciliation (Console usage API) before raising limits |
| Model-written code attacking the host | Stage 11 sandbox before unattended use; dedicated host; no production credentials on the host |
| Silent quality decay over long runs | evidence-based progress, correction-loop bounds, periodic re-verification of earlier milestones |
| Provider/SDK changes | readiness levels go `STALE` when the SDK version changes; live smoke tests in a scheduled CI job with a tiny budget |

## Definition of done for Phase 2

A disposable demo assignment (e.g. a small CRUD service) is taken from `assignment:add` to `AWAITING_OWNER_APPROVAL` with: a validated plan covering every requirement,
tasks executed by the live provider, build and tests passing, an independent requirement review with citations, a security scan result, a report whose every claim links to evidence,
an interruption injected mid-run (SIGKILL) that resumes without duplicated work, and a total cost within the configured budget.
