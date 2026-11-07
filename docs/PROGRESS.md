# Build progress and checkpoint

Durable checkpoint for the full-build mandate (owner briefs of 2026-11-07). Any new session or context continues
from here: read this file, `git log`, `git status`, then pick the first unchecked item in **Next**.

## Environment (owner machine)

- Windows 11 Pro, PowerShell 5.1, Node 26.13 (winget `OpenJS.NodeJS.LTS`), Git 2.56 (winget `Git.Git`).
- Claude Code 2.1.319 at `C:\Users\<owner>\.local\bin\claude.exe`; subscription login (`authMethod: claude.ai`, Max).
- Repository branch for this work: `feat/windows-compat` (based on `claude/dreamy-edison-hiyq3n`). Never force-push.
- Old shells need `$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH`.

## Done (verified)

| Item | Evidence |
| --- | --- |
| Suite runs on Windows; Windows fixes (CRLF/BOM, `.gitattributes`, single-spawn `gitState`, file-lock cleanup) | commit `2b3975d` |
| B1 native Claude Code CLI provider; watchdog env per worker; ANTHROPIC_*/parent CLAUDE_CODE_* stripped; fail-closed policy hook | `src/providers/claude-cli/*`, `tests/unit/cli-provider.test.ts` |
| Acceptance test 5 (real CLI smoke) 8/8, test 6 (real CLI recovery) 7/7, test 4 (usage-limit, mock) | `scripts/cli-smoke.ts`, `scripts/cli-recovery-smoke.ts`, `tests/integration/capacity-watchdog.test.ts` |
| **Stage 1 Windows Task Scheduler, run live on this PC** | `scripts/windows/scheduler-acceptance.ps1 -RealCli`: 39 PASS in the first run (details below) |
| PS 5.1 bug fixed: `$PSScriptRoot` empty in `param()` defaults broke all 4 scripts before they did anything | scripts now resolve it in the body; static guard in `tests/unit/windows-scripts.test.ts` |
| Wrapper: logs to `<AGENT_HOME>\logs\wrapper.log`; on exit 3 it monitors the live supervisor and takes over when it dies | live checks "new wrapper monitors ..." and "monitoring wrapper takes over ..." PASS |
| Orphan worker handling by OS identity (image + creation time), pid-reuse safe; replacement deferred while a matching worker lives | `src/workers/process-tree.ts`; `tests/unit/process-tree.test.ts` (real processes); `tests/e2e/orphan-worker.test.ts` (3: stop exact worker + resume from checkpoint, pid reuse left alone, Windows job-object behaviour) |
| Phase 2: intake, research (citation-checked), architecture sections + Mermaid, ADR rows+files, epics/subtasks/testing, critical path, verified progress, planning review (deterministic + model, bounded revise loop to architect/decompose), owner review of significant ADRs | `tests/integration/project-intelligence.test.ts` (9), `tests/unit/project-intelligence.test.ts` (12), planning suites updated |
| Phase 3: repository scan before planning, 10 bounded roles, independent QA (fresh read-only session, citation-checked verdicts, corrections, escalation, dependants gated on review) | `tests/integration/independent-qa.test.ts` (3) |
| Phase 5: command center (`dashboard`), owner-token login, sessions, CSRF, Host allow-list, strict CSP, owner controls + audit trail, approval inbox | `tests/integration/dashboard.test.ts` (7) |

### Stage 1 live results (2026-11-07, this PC, task `ElevariqPersonalAgent-Acceptance`, isolated agent home)

PASS: task definition (logon trigger for the owner, absolute working dir, embedded node path, Interactive/Limited
principal, IgnoreNew, no time limit, restart 999x1min, no secrets in arguments); inside the task context: owner user,
session 4, repo cwd, node path, `claude` 2.1.319 found, **subscription login readable (loggedIn, claude.ai, max)**,
claude-cli provider ready; supervisor started by the task (node from the embedded path, child of the wrapper, owner);
database + wrapper/app logs written; mock task COMPLETED; second `Start-ScheduledTask` ignored; manual second
supervisor refused (exit 3); killed supervisor restarted by the wrapper and the interrupted task recovered
(`interrupted,completed`); supervisor survives loss of its wrapper; new wrapper monitors, then takes over; graceful
stop ends supervisor/wrapper/task; **real CLI task under the task COMPLETED** (haiku, artifact written).

Observed facts (do not re-derive):
- Task Scheduler did NOT restart a force-killed wrapper by itself (RestartCount does not cover that case); the
  monitoring wrapper design covers it.
- On Windows a non-detached child is in libuv's kill-on-close job object: the whole `claude` worker tree dies with a
  killed supervisor (explains the earlier live observation). Orphans matter on Linux (children are reparented).
- Inside the worker, the Bash tool and the policy hook (children of `claude`) see `CLAUDE_CODE_RETRY_WATCHDOG=1` and
  `..._USAGE_LIMIT_RECHECK_MS=300000` but NOT `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` / `..._RESUME_PROMPT`: Claude Code
  does not pass those two on to its children. The spawn environment of `claude` itself is now recorded per execution
  (`worker_env` event) as evidence that all four are handed to the worker.
- The log redactor masks keys named like `apiKey*`/`credential*`: the init credential source is recorded as
  `billing: "subscription"` for evidence.

## Facts established earlier (do not re-derive)

- Docs: `CLAUDE_CODE_RETRY_WATCHDOG` (>=2.1.186) retries 429/529 indefinitely, waits until reset when the response
  has a reset time; spend-limit 429s fail immediately (>=2.1.239). `..._USAGE_LIMIT_RECHECK_MS` valid 60000..10800000
  (>=2.1.305). `..._MAX_USAGE_LIMIT_WAIT_MS` and `..._SCOPE` are **undocumented**: not used.
- In `-p` mode an exported `ANTHROPIC_API_KEY` always wins over the subscription: it must be stripped (done).
- Hook exit code 2 blocks; other non-zero codes do NOT block, so the hook maps every error to 2.
- Process spawns cost ~150 ms on this machine; keep git/process calls per task low.

## Not yet verified / open

- Re-run `scheduler-acceptance.ps1 -RealCli` after the evidence-field fixes (`worker_env` spawn record, `billing`):
  the two remaining FAILs of run 2 were evidence-recording problems, not behaviour (see facts above).
- Windows restart / sign-in trigger: cannot be automated safely here. Manual check in `docs/WINDOWS_DEPLOYMENT.md`.
- Real usage-limit wait output of the CLI: inferred from docs, never observed live (deliberately).
- Command-center UI has not been rendered in a real browser in this environment (API, auth and script syntax are
  tested); Playwright is not installed.
- Research with real WebSearch/WebFetch and the QA reviewer against the real CLI: only mock-tested so far.

## Next (in order)

1. Commit Stage 1 + Phase 2 + Phase 3 + Phase 5 (this checkpoint), re-run the scheduler acceptance.
2. Phase 6: backups + restore test, `systemd` unit + non-root install script, health/error notifications, operations docs.
3. Phase 4 preparation: typed adapter contracts, auth interfaces, sync designs, idempotency, pagination, audit, mock tests,
   integration checklist (real integration stays blocked until the ERP repo/API docs and read-only credentials arrive).
4. Phase 3 remainder: Playwright UI QA runner (needs `@playwright/test` + browser download: owner network decision),
   security verifier (secret scan) for `SECURITY_CHECKS_PASS`, project-level `REQUIREMENTS_SATISFIED` aggregation.
5. Live run of the full pipeline on the real CLI with a tiny assignment (intake -> plan -> approve -> code -> QA).
6. Final acceptance report (Stage 8) with exact evidence and the list of real-world tests not performed.
