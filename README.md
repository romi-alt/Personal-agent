# ELEVARIQ Personal Agent - Phase 2 (in progress: planning pipeline)

A persistent, crash-safe **supervisor + durable task queue** that can run coding assignments through Claude (Claude Agent SDK) in isolated project workspaces,
pause when the provider runs out of capacity, and resume unfinished work after interruptions - without relying on any single Claude conversation staying open.

Phase 1.5 = Phase 1 foundation + an independent audit (14 defects fixed, two of them critical security issues), a project-assignment contract with its own lifecycle, completion-verification evidence, a provider-readiness report, and Windows/GitHub/ERP preparation. It is still the *operational foundation*. It does **not** yet analyse requirements, plan projects, verify acceptance criteria, deploy anything, or talk to the live ELEVARIQ ERP/CRM.

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
| Fencing, escalation, checkpoint integrity, duplicate-completion safety, multi-process DB safety (Phase 1.5) | **IMPLEMENTED AND TESTED** (incl. 4 real processes on one DB file) |
| Project assignments (validated contract, durable context) and project lifecycle that never auto-completes | **IMPLEMENTED AND TESTED** |
| Verification evidence: `CHANGES_EXIST`, `BUILD_PASSES`, `TESTS_PASS`, owner acceptance | **IMPLEMENTED AND TESTED** |
| Verification of requirements satisfied / security checks | **NOT IMPLEMENTED** (always `NOT_EVALUATED`; Phase 2) |
| Provider readiness report (SDK / credentials / API access / budget / live execution / live recovery) | **IMPLEMENTED AND TESTED**; live levels are **NOT VERIFIED** |
| Phase 2 planning pipeline: analyse -> architect -> decompose -> owner approval -> tasks (read-only planning tasks, validated structured output, bounded repair loop) | **IMPLEMENTED AND TESTED** with the mock provider + real-process SIGKILL e2e; **not run with a real model** |
| Evidence-based progress (verified vs claimed), milestone gating, snapshots, owner inbox (Phase 2 stage 5) | **IMPLEMENTED AND TESTED** (mock + real processes) |
| Live-provider verification (`provider:verify --access`, `smoke:live`, `smoke:live-recovery`) | **BLOCKED** - needs `ANTHROPIC_API_KEY` + spending authorisation in the running environment |
| Windows scripts | static review + string guards only; **never parsed or run by PowerShell**; checklist in `docs/WINDOWS_DEPLOYMENT.md` |
| GitHub `main` created; default-branch switch and branch protection | `main` **DONE**; default branch + protection **BLOCKED** by the session proxy - owner steps in `docs/GITHUB_SETUP.md` |

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

`npm run check` (typecheck + lint + all tests) · `npm run smoke:live-recovery` · `npm test` · `npm run test:unit|integration|e2e` · `npm run build` · `npm run format` · `npm run smoke:live` (optional, costs money).

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
| `docs/PLANNING.md` | Phase 2 planning pipeline (stages 1-4) |
| `docs/PROGRESS.md` | Evidence-based progress, milestone gating, owner inbox (stage 5) |
| `docs/AUDIT_PHASE_1_5.md` | Independent audit: defects, fixes, residual weaknesses |
| `docs/PROJECT_ASSIGNMENTS.md` | Assignment schema, durable context, project lifecycle |
| `docs/COMPLETION_VERIFICATION.md` | Verification ladder, interfaces, evidence |
| `docs/WINDOWS_DEPLOYMENT.md` | Windows 11 install + verification checklist (not live-tested) |
| `docs/GITHUB_SETUP.md` | Branch setup and the admin-only settings |

## CI is local (GitHub Actions is off)

This repository is private and GitHub Actions is disabled for it (no paid Actions minutes). The CI is
`scripts/ci-local.mjs`: it runs the same steps as `.github/workflows/ci.yml` on your own machine, in a clean temporary
checkout of the commit.

- **Before pushing a branch that deploys (`main`), the full run must pass.** The pre-push hook in `.githooks/`
  (switched on by `npm install` through the `prepare` script) runs it automatically; other branches get a quick check.
  Running `npm run ci:local` by hand first is fine: a passed commit is remembered, so the push doesn't rerun it.
- Needs Node 22. On Windows the `check-windows` job runs too.
- Emergency only: `CI_LOCAL_SKIP=1 git push` (or `git push --no-verify`) skips it. Say so to the team.
- With the GitHub CLI (`gh`) logged in, results appear on the commit as `local/<job>` statuses.
- When `.github/workflows/ci.yml` changes, change `CONFIG` at the top of `scripts/ci-local.mjs` the same way.
- Claude Code sessions: run `npm run ci:local` before pushing a deploy branch. If the environment can't run it (no
  Docker or database), push a different branch and open a PR so a person runs it.
