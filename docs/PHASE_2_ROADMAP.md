# Phase 2 roadmap (not implemented)

Goal: turn the Phase 1 runtime into an agent that can take an owner assignment ("build a school-management ERP") from idea to verified, milestone-based delivery.
Nothing below exists yet; each item lists its dependency on Phase 1 pieces.

## 0. Prerequisites (do first)
1. Create the Console API key + workspace spend limit; run `npm run smoke:live`; record the result in `TEST_RESULTS.md`. Compare real SDK error/rate-limit messages with the adapter's mapping and fix any divergence.
2. Run the Windows scripts on the owner's PC (or deploy the unit to an Ubuntu VPS) and test sleep/reboot recovery for real.
3. Inspect the actual ELEVARIQ ERP/CRM code, API docs, auth model and permissions (read-only) before any adapter work.

## 1. Assignment intake & project intelligence (uses `ANALYZING`/`PLANNING`/`READY`, project memory)
* `assignment:add` → creates a project + an *analysis task* whose output is written into `project_memory` (`requirements`, `architecture_decisions`, `technology_decisions`, `roadmap`, `milestones`).
* A planner stage decomposes the roadmap into milestone tasks with dependencies and acceptance criteria (the queue, dependencies and priority ordering already exist).
* Clarification requests become `approvals`/questions to the owner (new `WAITING_FOR_INPUT` use of the approval table).

## 2. Verification before completion
* Replace "provider said success" with independent checks: run the project's test/lint/build commands in the worker, store results in `checkpoints.test_results`, evaluate acceptance criteria, and only then `COMPLETED`.
* Reviewer pass (second session / subagent) producing defects → new tasks (`known_defects` memory).

## 3. Safer execution
* OS-level sandboxing (SDK `sandbox` option / container per project) to replace regex command screening; network egress allow-list.
* Git worktrees per task for parallel work; `MAX_CONCURRENT_WORKERS > 1` after worktree isolation + per-project locks.
* Signed approval flow (out-of-band: email/Slack/push) instead of CLI-only.

## 4. Memory & context
* Memory summarisation/compaction jobs, per-task context packs; (only then) retrieval/vector search if needed.

## 5. ELEVARIQ integration (read-only first)
* Real ERP/CRM read adapters behind the existing interfaces, cursors/sync, owner briefings ("what is overdue / blocked / needs me").
* Later, scoped write-back (task status, activity entries) with per-category approval.

## 6. Observability & owner interface
* Daily/weekly progress reports; budget dashboard (estimated vs billed cost - add billing reconciliation from the Console usage API if suitable);
  push notifications for approvals; optional local web UI; activity-event pruning.

## 7. Production-ops safety
* Deployment *preparation* tasks only (artifacts, runbooks, IaC diffs); production changes remain approval-gated with dry-run evidence.

Suggested order: 0 → 2 → 1 → 3 → 5 → 4 → 6 → 7.
