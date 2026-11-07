# Security

## Local autonomous coding vs. authorised production operations

| | Local autonomous coding (allowed by default) | Authorised production operations (**owner approval required**) |
|---|---|---|
| Where | The project's own isolated directory under an approved workspace root | Anything outside it; any live/remote system |
| Examples | read/write project files, run tests/builds, `npm install`, local git commits on `agent/<slug>` | production deploys, publishing releases/packages, `git push`, deleting substantial data, live DB migrations, changing production credentials, messaging customers, payments, changing user access, modifying ELEVARIQ production records |
| Enforcement | `canUseTool` + path policy (`src/security/policy.ts`) | the same callback denies the call, creates an `approvals` row and parks the task in `WAITING_FOR_APPROVAL` |

Phase 1 performs **no deployments** and contacts **no production system**.

## Permission model

* `permissionMode: 'default'` - never `bypassPermissions`, never `allowDangerouslySkipPermissions`. Unrestricted execution is not configurable.
* Pre-approved tool list is small: `Read Glob Grep Edit Write Bash TodoWrite`. Everything else (including any MCP tool) is denied unless approved.
* File tools: the resolved path (symlinks followed, `..` collapsed) must be inside the project workspace.
* `Bash` commands are screened against approval categories (`production_deploy`, `publish_release`, `protected_branch_push`, `destructive_delete`,
  `live_database_migration`, `production_credentials`, `customer_communication`, `financial_transaction`, `access_change`, `system_modification`).
  Approval is per task and per category (`approve <id>` records it; the next run passes the category in `approvedActionTypes`).
* **Known limitation:** pattern screening of shell commands is a *guardrail, not a sandbox*. A determined or confused model can construct commands that evade regexes
  (e.g. via scripts it writes and then runs). Mitigations for real unattended use: run under a dedicated low-privilege OS account, use a dedicated VM/VPS or container,
  keep no production credentials on the host, and use a network egress allow-list. OS-level sandboxing (the SDK `sandbox` option) is a Phase 2 item.

## Workspace isolation

* `WORKSPACE_ROOT` (default `AGENT_HOME/workspaces`) is always approved; other directories must be approved explicitly with `workspace:approve <path>`.
* A project's `repo_path` is canonicalised (symlinks resolved on the deepest existing ancestor) and must be inside an approved root, checked at project creation **and** on every execution.
* Existing repositories: a dirty tree is refused unless `--allow-dirty`; work happens on a dedicated `agent/<slug>` branch and original changes are never discarded.
* The agent never edits any ELEVARIQ product repository; none is registered.

## Secrets

* Config via environment/`.env` (git-ignored). `.env.example` has placeholders only. No secret is stored in the database.
* `ANTHROPIC_API_KEY` is read at execution time, passed only to the SDK child process environment, and fingerprinted (SHA-256 prefix) for change detection.
* Redaction runs in the logger, in persisted activity events/approval payloads, execution transcripts and usage records (key-name and token-pattern based). Tested in `tests/unit/redact-and-paths.test.ts`.
* Integration tokens: only a boolean `hasToken` is held in the config object.
* Windows: restrict `.env` ACLs to your user. Linux: `0640 root:elevariq-agent` env file. Do not store keys in `package.json`, scripts, or Task Scheduler arguments.

## Data minimisation for model prompts

ERP/CRM adapters expose no financial, contract or personnel-compensation fields in Phase 1. Any future inclusion of such data in a prompt requires explicit, logged owner authorisation.

## Network surface

No inbound listener by default. `HEALTH_PORT` > 0 starts a **loopback-only** (`127.0.0.1`) read-only endpoint returning counts and states - no task text, no paths, no secrets.

## Budget controls (money is a security boundary)

Paid API use needs `ALLOW_PAID_API=true` and a positive per-execution cap. Optional rolling daily estimate limit. Estimated cost (SDK `total_cost_usd`) is stored separately from billed cost, which Phase 1 leaves empty because no reliable billed figure is available client-side.

## Unresolved risks

1. Command screening is bypassable (see above) - isolate the host.
2. Windows scripts and the systemd unit are unexecuted in a real target environment.
3. The live Claude adapter has never run against the real API; error mapping follows the SDK type definitions, not observed behaviour.
4. SQLite file is not encrypted; protect the data directory with OS permissions.
5. `npm audit`: one moderate dev-toolchain advisory (minimatch via ESLint); runtime dependencies are clean.

---

# Phase 1.5 addendum

## Corrected: permission enforcement was bypassable (Critical)

Phase 1 pre-approved `Bash/Write/Edit` via the SDK's `allowedTools`. Those tools are auto-approved and never reach `canUseTool`, so the approval policy did not run.
Now: the toolset is restricted with `tools`, decisions are made by a **PreToolUse hook** (hooks run before allow rules; a hook deny wins) plus `canUseTool` as a second layer, and
`settingSources: []` stops the workspace's own `.claude/settings.json` (writable by the model) from adding allow-rules, hooks or MCP servers. See `docs/AUDIT_PHASE_1_5.md`.
This is DOC-VERIFIED (SDK docs + type definitions), **not yet exercised against the live SDK**.

## Other additions

* Assignment `approvalPolicy.preApproved` can never include production-facing categories; integrations cannot request write access; delivery always needs owner approval.
* Verification commands never receive `ANTHROPIC_*`/`CLAUDE_CODE_*` variables. They do run model-written code unsandboxed (residual risk C2).
* Evidence and activity payloads are redacted; evidence output is truncated.
* Runtime dependency audit is part of CI (`npm audit --omit=dev`) along with a secret-pattern scan.

## Residual risks (unchanged or newly documented)

Regex command screening is not a sandbox; verification executes model-written code; abort/resume and rate-limit semantics unverified live; SQLite file unencrypted; session transcripts under `~/.claude` may contain prompts and file contents - protect the service user's home.

---

# Phase 2 addendum

* Planning tasks are **read-only**: toolset restricted to `Read/Glob/Grep` (SDK `tools`), enforced again by the PreToolUse hook and `canUseTool`, plus a read-only system prompt. A planning step can therefore not modify the repository even if the model tries.
* Model-produced plans are untrusted input: validated by schema and deterministic rules, bounded in size (`MAX_PLAN_TASKS`), never executed as code, and by default need the owner's explicit approval before any coding task is created (`PLAN_APPROVAL=required`).
* A plan cannot raise privileges: planned tasks inherit the assignment's approval policy and budgets; verification levels come from a fixed enum.
* Unverified: behaviour of the read-only toolset against the live SDK (DOC-VERIFIED only).
