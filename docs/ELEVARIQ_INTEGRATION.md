# ELEVARIQ ERP / CRM integration (foundation only)

**Status: SCAFFOLDED FOR FUTURE WORK.** Phase 1 contains typed contracts, error types, mocks, health-check interfaces and an event-mapping
specification (`src/integrations/`). There is **no live adapter**: no ERP/CRM URL, endpoint or auth model is assumed, and no network call is made.
`INTEGRATION_*_ENABLED=true` currently only logs a note that mocks are used. The ERP/CRM repositories were not inspected or modified.

> The interfaces below are *proposed internal contracts*, not claims about existing ELEVARIQ endpoints.

## Contracts (read-only)

`ElevariqErpAdapter`: `getProjects`, `getProjectDetails`, `getProjectTasks`, `getTeamMembers`, `getTeamAssignments`, `getProjectActivity(projectId, since)`,
`getUpcomingDeadlines(withinDays)`, `getBlockedTasks`, `healthCheck`.
`ElevariqCrmAdapter`: `getClients`, `getClientDetails`, `getClientProjects`, `getRecentInteractions`, `healthCheck`.
Errors: `IntegrationError(code, message, system, retryable)` with codes `NOT_CONFIGURED UNAUTHENTICATED FORBIDDEN NOT_FOUND RATE_LIMITED UNAVAILABLE TIMEOUT INVALID_RESPONSE NOT_IMPLEMENTED`.
`IntegrationAuthConfig` is a placeholder (`scheme: 'unspecified'`, secret referenced *by env-var name*, scopes list).

### Owner questions → methods

| Question | Methods |
|---|---|
| Which projects are active? | `getProjects({status:'active'})` |
| What did the team complete today? | `getProjectActivity(id, startOfDay)` filtered to `task_completed` |
| Which tasks are overdue? | `getUpcomingDeadlines(n)` where `overdue` |
| Which projects are blocked? | `getProjects` where `health='blocked'` + `getBlockedTasks` |
| Upcoming milestones? | `getProjectDetails(id).milestones`, `getUpcomingDeadlines` |
| Tasks per employee? | `getTeamAssignments(memberId?)` |
| What needs attention first? | derived from the above (Phase 2 reasoning layer) |
| What did the autonomous worker finish? | the **agent's own** `tasks`/`checkpoints` tables, not ERP |
| Which tasks need owner approval? | the agent's `approvals` table |

Verified by `tests/unit/integrations.test.ts` against **synthetic** mock data only.

## Event mapping (specification, `src/integrations/event-mapping.ts`)

Agent → ERP (write phase, *separately approved*): task COMPLETED → ERP task done + evidence link; BLOCKED/WAITING_FOR_APPROVAL → blocker raised; checkpoint → activity-feed summary (summaries only, never code/secrets).
ERP → agent (read phase): project/task assigned to agent → queued task with `dedupe_key = ERP task id` (idempotent); overdue/deadline signals → owner briefing.

## Future synchronisation design

1. **Discovery first (Phase 2 step 0):** inspect the real ERP/CRM codebase, API docs, auth model and the permissions the agent identity would hold. Only then write adapters.
2. **Read-only sync:** pull via polling with ETag/`updated_since` cursors (webhooks later); store cursors in the agent DB; never mirror whole tables.
3. **Idempotency:** `enqueueTask` already de-duplicates on `(project, dedupe_key)`; use the ERP task id as the key.
4. **Write-back phase:** a separate adapter interface, a separate scoped credential, and each write category goes through the existing `approvals` flow.
5. **Sensitive data:** financial, personnel and client-contract data stay out of prompts unless a specific authorised need is logged; adapters expose minimised DTOs.
6. **Failure handling:** `IntegrationError.retryable` feeds the same backoff utilities; an ERP outage must never block local coding tasks.
