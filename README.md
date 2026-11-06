# ELEVARIQ Personal Agent - Phase 1

A persistent, crash-safe **supervisor + durable task queue** that can run coding assignments through Claude (Claude Agent SDK) in isolated project workspaces,
pause when the provider runs out of capacity, and resume unfinished work after interruptions - without relying on any single Claude conversation staying open.

Phase 1 is the *operational foundation* only. It does **not** yet analyse requirements, plan projects, verify acceptance criteria, deploy anything, or talk to the live ELEVARIQ ERP/CRM.

> Location note: the task asked for a repository named `elevariq-personal-agent`. This code lives in the repository this session was given (`personal-agent`); the npm package
> is named `elevariq-personal-agent`. It is a standalone runtime - it does not touch any ELEVARIQ product repository.

## Capability status

| Capability | Status |
|---|---|
| Durable SQLite queue, transactional claim/lease, state machine with persisted history | **IMPLEMENTED AND TESTED** |
| Supervisor (singleton lock, heartbeat, graceful stop, restart reconciliation) | **IMPLEMENTED AND TESTED** (real-process SIGKILL tests) |
| Failure classification, backoff, capacity waiting, resume after limits (mock provider) | **IMPLEMENTED AND TESTED** |
| Workspace isolation, path safety, approval-gated action policy | **IMPLEMENTED AND TESTED** (unit) |
| Redacted structured logging, retention, per-execution transcripts | **IMPLEMENTED AND TESTED** |
| CLI (`doctor start stop status health projects tasks task:* approvals logs recovery integrations`) | **IMPLEMENTED AND TESTED** (e2e covers start/stop/status/health/task:add/project:add; others smoke-tested manually) |
| Claude Agent SDK provider (auth preflight, session capture/resume, error mapping, permission callback) | **IMPLEMENTED BUT NOT LIVE-VERIFIED** (tested against scripted SDK-shaped streams; no API key was available) |
| Windows Task Scheduler scripts | **IMPLEMENTED BUT NOT EXECUTED** (no Windows/PowerShell in the build environment) |
| systemd unit + installer | **IMPLEMENTED BUT NOT RUN** (`systemd-analyze verify` only) |
| ERP / CRM adapter interfaces + mocks + event-mapping spec | **SCAFFOLDED** (mocks tested; no live adapter) |
| Project memory storage + checkpoint reader/writer | **IMPLEMENTED** (basic; no retrieval) |
| Requirement analysis, planning, independent verification, deployment, ERP write-back | **NOT IMPLEMENTED** (Phase 2, see `docs/PHASE_2_ROADMAP.md`) |
| Live-provider smoke test | **BLOCKED** - needs `ANTHROPIC_API_KEY` + spending authorisation |

## Requirements

Node.js >= 22.12, Git. (`better-sqlite3` uses a prebuilt binary on Windows/Linux x64.) Claude Code CLI is optional (diagnostics only).

## Quick start (mock provider - free, offline)

```bash
npm ci
npm run build
cp .env.example .env
npm run agent -- doctor
npm run agent -- project:add --name "Demo School ERP"
npm run agent -- task:add --project demo-school-erp --file examples/task-example.json
npm run agent -- start --detach
npm run agent -- status
npm run agent -- task:show <task-id>
npm run agent -- stop
```

To see the usage-limit recovery behaviour: `MOCK_SCENARIO_FILE=examples/mock-scenario.json npm run agent -- start`, with three tasks titled as in that file.

## Using the real Claude provider

Read `docs/AUTHENTICATION.md`. In short: Console API key in `.env`/environment, `EXECUTION_PROVIDER=claude`, `ALLOW_PAID_API=true`, `MAX_BUDGET_USD_PER_EXECUTION=<cap>`. The agent never uses your subscription login and never exceeds the caps.

## Scripts

`npm run check` (typecheck + lint + all tests) · `npm test` · `npm run test:unit|integration|e2e` · `npm run build` · `npm run format` · `npm run smoke:live` (optional, costs money).

## Configuration

All settings are environment variables validated at startup (`src/config/index.ts`); `.env.example` documents each. Invalid configuration fails immediately with the list of problems (exit 2).

## Documentation

| Doc | Content |
|---|---|
| `docs/ENVIRONMENT_AUDIT.md` | Actual machine diagnostics, blockers |
| `docs/ARCHITECTURE.md` | Modules, supervisor, state machine, persistence, provider adapter |
| `docs/AUTHENTICATION.md` | Credentials, setup, rotation, limitations |
| `docs/RECOVERY.md` | Failure classes, usage-limit handling, restart reconciliation, manual steps |
| `docs/SECURITY.md` | Permissions, isolation, secrets, approvals, residual risks |
| `docs/ELEVARIQ_INTEGRATION.md` | ERP/CRM contracts and future sync design |
| `docs/OPERATIONS.md` | Running as a service, monitoring, backups, troubleshooting |
| `docs/PHASE_2_ROADMAP.md` | Next stage (not implemented) |
| `docs/TEST_RESULTS.md` | Real commands and results |
