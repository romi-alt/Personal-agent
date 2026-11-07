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

---

# Phase 1.5 addendum - integration contract for the future ERP/CRM adapters

Still **design only**. No ERP/CRM endpoint is assumed, nothing was contacted, write-back is **not enabled** and cannot be requested by an assignment
(`requiredIntegrations[].access` accepts only `none|read`). Everything below is what a real adapter must satisfy once the actual ERP codebase, API docs,
auth model and permissions have been inspected (Phase 2, step 0). Field names on the ERP side are placeholders.

## 1. Identity mapping and duplicate prevention

| ERP/CRM concept | Agent concept | Key | Rule |
|---|---|---|---|
| ERP project | agent **project** (+ `assignments` row) | `assignments.source = {system:'erp', externalId:<ERP project id>}` | `registerAssignment` is idempotent on `(system, externalId)`: re-sync returns the existing project (`findByExternalId`, tested). |
| ERP task / CRM engineering request | agent **task** | `tasks.dedupe_key = "erp:<task id>"` (unique per project) | `enqueueTask` ignores duplicates and records `task.enqueue_duplicate`; ERP renames/edits never create a second task. |
| ERP milestone | checkpoint **group** + project `currentMilestone` | `erp-milestone:<id>` stored in memory section `milestones` | A milestone is "reached" in the ERP only when the project has the verification evidence the milestone's criteria require - never when a single task completes. |
| ERP team member | **assignee label** on tasks (metadata only) | ERP member id | The agent never maps people to OS accounts or permissions. Personnel data beyond display name/role stays out of prompts. |
| ERP activity record | agent **activity event** (inbound: informational; outbound: Phase 3) | `(source, external activity id)` | Stored with `correlation_id = external id`; duplicates ignored. |
| CRM client | project metadata (client display name only) | CRM client id | No contract, pricing or contact data enters prompts. |

Identifiers are opaque strings; the agent never parses or reorders them. A deleted/closed ERP item cancels the *queued* agent task (`CANCELLED`, reason "source closed"), it never deletes history.

## 2. Status mapping

| ERP status (placeholder) | Agent task status | Notes |
|---|---|---|
| backlog / todo | `QUEUED` (or no task yet) | Only items explicitly **assigned to the agent** are imported. |
| in progress | `RUNNING`, `CHECKPOINTING`, `READY`, `RETRY_SCHEDULED`, `WAITING_FOR_CAPACITY` | Provider waits are shown as "in progress - waiting for capacity", not as failures. |
| blocked | `BLOCKED`, `WAITING_FOR_APPROVAL`, `WAITING_FOR_AUTHENTICATION`, `PAUSED` | Reason string is exported; approvals surface the approval id. |
| in review | project lifecycle `VERIFYING` / `AWAITING_OWNER_APPROVAL` | |
| done | task `COMPLETED` **and** required verification evidence present | A bare provider success maps to "ready for review", not "done". |
| cancelled | `CANCELLED` | |
| (failed) | `FAILED` | Exported as blocked with the failure class; never as done. |

Project: ERP "active" ↔ lifecycle `IN_DEVELOPMENT`; "delivered/closed" is set **only** by the owner (`project:deliver`), never inferred.

## 3. Sync protocol (read-only first)

* **Direction:** ERP → agent only in Phase 2. Agent → ERP (status, activity summaries, blockers) is a separately approved Phase 3 adapter with its own credential.
* **Pagination:** cursor/`updated_since` based; page size configurable (default 100); the cursor is persisted per source in the agent database only *after* the page was fully processed (at-least-once, idempotent via the keys above). Never "list everything" on every run.
* **Retries:** `IntegrationError.retryable` drives exponential backoff with jitter (the same `computeBackoffMs`); honour `Retry-After`; `RATE_LIMITED`/`UNAVAILABLE`/`TIMEOUT` retry, `UNAUTHENTICATED`/`FORBIDDEN` stop and raise an owner-visible alert, `INVALID_RESPONSE` is quarantined with the raw (redacted) payload hash. An ERP outage must **never** block local coding tasks.
* **Duplicate-sync prevention:** (a) the idempotent keys above; (b) a per-source sync lock row (like the supervisor lock) so two sync runs cannot overlap; (c) events carry `correlation_id`; (d) imports are transactional - a page either fully applies or not at all.
* **Conflict policy:** the ERP is the source of truth for *what* to build and priority; the agent is the source of truth for *execution state*. If both changed the same field, the owner-visible "conflict" event is raised and the agent keeps working on its last accepted version.
* **Authorization:** a dedicated, **read-only** service identity per system (least privilege, scoped to the projects/teams the agent works on), token from the environment/secret store, never logged, never in the database (only `hasToken` booleans in config). Separate write-scoped credential in Phase 3, each write category behind `approvals`.
* **Data minimisation:** DTOs in `src/integrations/types.ts` omit financial, contract, compensation and personal data. Anything beyond them needs a named, logged, owner-authorised need before it can appear in a prompt.

## 4. Questions the integration must answer (and from where)

| Owner question | Source |
|---|---|
| Active projects, blocked projects, overdue tasks, upcoming milestones, tasks per person | ERP adapter (`getProjects`, `getBlockedTasks`, `getUpcomingDeadlines`, `getTeamAssignments`) |
| What did the team complete today? | `getProjectActivity(project, startOfDay)` |
| What did the autonomous worker finish? Which approvals are pending? | the **agent's own** tables (`tasks`, `verification_evidence`, `approvals`), not the ERP |
| What should the team prioritise? | Phase 2 reasoning over the above |

## 5. What is explicitly out of scope now

Live adapters, webhooks, write-back, user/permission mapping, financial data, and any production ERP/CRM access.
