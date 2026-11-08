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
  Since A2, rules about executable operations match a *normalized* Bash command (heredoc bodies, comments and quoted multi-word data removed;
  `src/security/shell-normalize.ts`), so `passwd` / `DROP TABLE` in a test file body or commit message no longer asks for approval. The raw
  command is used whenever quoted/heredoc text may be executed (shells, `eval`, `-c`/`-e`, SQL clients, interpreters fed inline code, `ssh`,
  `xargs`, ...), when parsing is not confident, for every PowerShell-tool command, and always for `customer_communication`,
  `financial_transaction`, the agent-control/agent-CLI hard denies and the protected-path check. `rm -r` stays gated whatever the target
  (use the scratch-clean tool). Write/Edit file content is never screened as a command (only the path).
* Direct agent CLI invocation (`node dist/cli/index.js <state-changing subcommand>`, `tsx src/cli/index.ts ...`, any relative path) is a hard
  deny, like `npm run agent` (`invokesAgentCli` in `src/security/policy.ts`).
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

---

# Final stabilization addendum (2026-11-07)

## Fixed in this pass (confirmed defects)

1. **Self-approval through the shell (High).** A worker's Bash/PowerShell command could call the agent's own CLI
   (`npm run agent -- approve apr_...`), read `dashboard.token`, edit `agent.db`, rewrite its per-execution
   `*.policy.json`, or remove `STOP-HOLD`; only the system prompt discouraged it. Now `AGENT_CONTROL_PATTERN` denies
   such commands outright - **not approvable**, no granted category unlocks them - and the CLI provider passes
   AGENT_HOME and the agent repository as protected paths: a command naming either (backslash, slash or Git Bash
   `/c/...` spelling) outside the project workspace is denied. The policy file is written read-only and its path is not
   exposed to the worker. Tests: `tests/unit/agent-control-policy.test.ts`, `tests/unit/cli-provider.test.ts`; checked
   with the compiled hook against the real pending payload.
2. **Over-broad destructive approval (Medium, design).** Approving a `destructive_delete` request grants the
   category for the rest of that task, not the one command. Routine scratch cleanup no longer needs it: scoped tool
   `src/workspaces/scratch-cleanup.ts` (see OPERATIONS). Tests: `tests/unit/scratch-cleanup.test.ts` (valid dir,
   parent, workspace root, outside dir, link escapes incl. junctions, missing dir, repeated cleanup, AGENT_HOME
   validation, dry run, size limit, worker entry).

## Audit results (2026-11-07)

| Area | Result |
| --- | --- |
| Workspace isolation | canonical paths, approved roots, file tools confined; unchanged, tests pass |
| Command policy / approvals | categories + per-task grants; agent-control hard deny added (above) |
| Self-approval prevention | store refuses re-deciding (`status = 'PENDING'` guard); worker shell path closed (above). A worker can still write and run its own program that does anything the OS user may do - guardrail, not a sandbox |
| Credential redaction | unchanged; tests pass. No secret in git history of this branch (pattern scan of the diff: only test fixtures) |
| `.env` | git-ignored, never committed; holds configuration only (no keys set) |
| Dashboard auth / sessions | 256-bit owner token, constant-time compare, server-side sessions 12 h, HttpOnly + SameSite=Strict cookie, CSRF header, Host allow-list, strict CSP, loopback bind (remote bind refused unless `DASHBOARD_ALLOW_REMOTE=true`) |
| Token file on Windows | `mode 0o600` has no effect on NTFS; the file inherits the profile ACL (owner, SYSTEM, Administrators) - acceptable under `%LOCALAPPDATA%`, do not move AGENT_HOME to a shared folder |
| Local network exposure | no listener by default; HEALTH_PORT=0 in `.env`; dashboard loopback only |
| Backups / restore | online backup + manifest checksum + integrity_check, restore keeps the old DB (tests pass) |
| Git protections | `git push` always needs approval; agent never pushes; work on `agent/<slug>` branches |
| Dependencies | `npm audit --omit=dev`: 0 vulnerabilities. Full tree: 10 moderate, all in the dev-only ESLint/typescript-eslint toolchain; not shipped, not fixed (would need `--force` major upgrades) |

## Remaining risks

- Regex screening is bypassable by a worker that writes a script and runs it (documented since Phase 1). For real
  unattended use: dedicated low-privilege Windows account or VM, no production credentials on the host.
- (Fixed 2026-11-07, later the same day) the SDK (paid API) provider now applies the same protected-path check as the
  CLI provider, in both its PreToolUse hook and `canUseTool` (`tests/unit/claude-provider.test.ts`).
- Scratch cleanup is offered only for workspaces inside the managed WORKSPACE_ROOT; projects in separately approved
  directories fall back to an owner approval.
