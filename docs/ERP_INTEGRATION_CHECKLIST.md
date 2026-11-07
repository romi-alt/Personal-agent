# ELEVARIQ ERP/CRM integration - readiness and checklist

Status: **BLOCKED on owner-provided resources.** No live adapter exists; no ERP/CRM endpoint, table or data model has
been assumed. Everything below the line "what is ready" runs against synthetic mock sources only.

## What is ready (implemented and tested with mocks)

| Area | Where | Tests |
| --- | --- | --- |
| Read-only adapter contracts (projects, details, tasks, team, assignments, activity, deadlines, blocked; CRM clients/interactions) | `src/integrations/types.ts` | `tests/unit/integrations.test.ts` |
| Paginated sync source contract (`Page<T>`, opaque cursor, `updatedSince`) | `src/integrations/contracts.ts` | `tests/integration/erp-sync.test.ts` |
| Authentication interfaces: bearer / API-key header from a named env variable, OAuth2 client credentials with token caching; secrets read at call time, never stored or logged | `contracts.ts` (`EnvCredentialSource`, `OAuth2ClientCredentials`) | same |
| Sync engine: idempotent upserts by (system, kind, external id) + content hash, cursor persisted per page in the same transaction, bounded runs, resume after failure | `src/integrations/sync.ts` | same (pagination, re-sync, change detection, rate-limit resume, bounded runs) |
| Audit: `sync_runs` row per run, `integration.synced` / `integration.sync_failed` events | migration v8 | same |
| Project synchronisation design: ERP project -> **draft** assignment with `source.externalId` (idempotent registration); never registered without owner review | `erpProjectToAssignmentDraft` | same |
| Employee assignment mapping: member id/display name/role only (no e-mail, phone, pay); role -> agent specialist role suggestion | `SyncEngine.syncMembers`, `suggestAgentRole` | same |
| Activity / task status write-back design: every write is a `WriteIntent` with an idempotency key and is refused by `WriteGate` in this phase | `contracts.ts` | same |
| Event mapping agent -> ERP concepts (documentation of intended write phase) | `src/integrations/event-mapping.ts` | existing |

## What the owner must provide (exact list)

1. **Repository access** (read-only) to the ELEVARIQ ERP and CRM source code, or the relevant subset:
   - API layer: route/controller files and their request/response serializers (e.g. `routes/`, `controllers/`, `api/`).
   - Authentication: how API clients authenticate (token type, issuer, scopes/roles, expiry, refresh).
   - Data model: schema/migrations for projects, tasks, milestones, team members, assignments, activity/comments,
     clients, interactions (e.g. `migrations/`, `schema.prisma`, `models/`).
   - Pagination and filtering conventions (cursor vs. page/offset, max page size, `updated_since` support).
   - Rate limits and error format.
2. **API documentation** if it exists (OpenAPI/Swagger file or equivalent), including the base URL of a **staging or
   read-only** environment.
3. **A dedicated read-only service identity** for the agent:
   - scope limited to read: projects, tasks, milestones, team members (id/name/role), assignments, activity;
     CRM clients and interactions only if needed;
   - no access to financial, payroll or HR-private fields; no write permission;
   - delivered as environment variables on the agent host (never in chat, git or the dashboard), e.g.
     `ELEVARIQ_ERP_BASE_URL`, `ELEVARIQ_ERP_API_TOKEN` (names finalised once the auth scheme is known).
4. **Data-handling decisions**: which client/employee fields may appear in model prompts and daily briefings; retention
   period for synced records; whether CRM data is needed at all in the first live phase.
5. **Write-phase authorisation** (later, separate decision): which agent events may update ERP records, through which
   endpoints, with what idempotency mechanism, and who approves each category.

## Live adapter work once the resources exist (estimated order)

1. Inspect the provided code/docs; write `docs/ERP_API_NOTES.md` with the verified endpoints, auth and pagination
   (source file + line for every claim).
2. Implement `LiveErpSyncSource implements ErpSyncSource` with the verified paths; contract tests against recorded
   staging responses (no production calls in tests).
3. Read-only staging run: `sync_runs` audit, record counts compared with the ERP UI by the owner.
4. Daily briefing generated only from synced records (never invented activity), owner review of the first briefings.
5. Only after a separate authorisation: write-back through `WriteGate` with idempotency keys.

## Status check (final stabilization, 2026-11-07)

- Still **BLOCKED on owner resources**; nothing in the code base names a real ELEVARIQ endpoint, table or field.
- Writes: `WriteGate` defaults to disabled and is never constructed enabled anywhere in `src/` - every write intent is
  refused. `INTEGRATION_ERP_ENABLED=false` / `INTEGRATION_CRM_ENABLED=false` in `.env`; only mock adapters run.
- No production database credentials are used or requested: the agent integrates through an API with a read-only
  service identity, never through a direct database connection.

### Owner request list (copy/paste)

1. Read-only access to the ERP/CRM source (or an export of): API routes/controllers + serializers, auth middleware,
   schema/migrations for projects, tasks, milestones, team members, assignments, activity, clients, interactions.
2. OpenAPI/Swagger (if any) and the base URL of a **staging or read-only** environment.
3. Auth scheme facts: token type (bearer/API key/OAuth2 client credentials), issuer/token URL, scopes/roles, expiry and
   refresh behaviour.
4. Pagination, filtering (`updated_since`?), rate limits, error format.
5. A dedicated **read-only** service identity limited to the entities in (1), no financial/payroll/HR-private fields,
   delivered as environment variables on the agent host (never in chat, git or the dashboard).
6. Data-handling decisions: which client/employee fields may enter model prompts and daily briefings; retention period;
   whether CRM data is needed in the first live phase.
7. (Later, separate decision) write-phase authorisation: which events may write, which endpoints, idempotency, approver.
