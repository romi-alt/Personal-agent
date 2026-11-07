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

**Run 5 (final): 45 PASS / 0 FAIL / 5 INFO** on battery power, evidence in `docs/evidence-scheduler-acceptance.json`
(machine/user names replaced by placeholders).

Run 4 (after commit `08abbb3`, keepalive + hold added): 38 PASS / 2 FAIL. The two FAILs were test-harness problems,
both fixed: (1) the probe task used Task Scheduler's default "do not start on battery" and stayed Queued (the PC was
on battery); (2) `Stop-ScheduledTask` killed the wrapper but not the `Start-Process`-launched supervisor, so the
"total failure" step now kills both by pid. New live PASSes in run 4: keepalive trigger restarts the agent after it
ended, `stop --hold` is honoured, all 4 watchdog variables in the spawn environment of the real claude worker,
`billing: subscription`.

Observed facts (do not re-derive):
- Task Scheduler's default settings refuse to START a task on battery power; the agent task sets
  `AllowStartIfOnBatteries` + `DontStopIfGoingOnBatteries` (now asserted by verify-install.ps1).
- Run 3: a supervisor and its wrapper vanished with no exit record while the machine was under heavy test load on
  battery; the TaskScheduler operational log is disabled here, so the cause is unknown. The keepalive trigger now
  recovers that situation within KeepAliveMinutes.
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

- Windows restart / sign-in trigger: cannot be automated safely here. Manual check in `docs/WINDOWS_DEPLOYMENT.md`.
- Real usage-limit wait output of the CLI: inferred from docs, never observed live (deliberately).
- Research with real WebSearch/WebFetch: not run live (the live pipeline ran with web disabled).
- Live pipeline (2026-11-07): planning + task 1 coding + independent QA PASSED on the real CLI; task 2 stopped at a
  `destructive_delete` approval (worker cleaned a scratch dir with `rm -rf`); owner decision pending in the sandbox.
- Playwright UI QA of generated products: not implemented (dependency + browser download = owner decision).

## Done since the last checkpoint

- Commit `4d840a5`: keepalive + stop --hold, ERP sync preparation, security verifier, requirement aggregation, ops docs.
- Command center checked in real Edge (`scripts/ui-browser-check.ts`): fixed Referrer-Policy/Origin null login
  refusal, CSP-blocked inline styles, layout overflow, evidence count. Screenshots in `docs/screenshots/`.
- `docs/ACCEPTANCE_REPORT.md` (Stage 8) with evidence per criterion and the list of tests not performed.

## Final stabilization (2026-11-07, session 4)

Branch `feat/windows-compat` is **6 commits ahead of `origin/claude/dreamy-edison-hiyq3n`** (not 3: `2b3975d`,
`4f68b96`, `f556f83`, `08abbb3`, `4d840a5`, `18da617`), 10 ahead of `origin/main`; nothing pushed. Working tree was
clean; `.env`, `dist/`, `node_modules/` ignored; no secrets in the diff (pattern scan: test fixtures only).

| Status | Item |
| --- | --- |
| Implemented + tested | Scoped scratch cleanup (`src/workspaces/scratch-cleanup.ts`, `scratch:clean`, worker entry) - 16 tests |
| Implemented + tested | Agent-control hard deny + protected paths in the policy hook (self-approval via shell closed) - 15 tests; full suite **333/333** (32 files), typecheck, lint, build, prettier clean |
| Live verified (this PC) | compiled scratch tool: real `.qa-*` dir deleted + audited, repeat = `absent`, `E:\elevariq-ui-tmp` / workspace root / parent refused; compiled hook on the real pending payload: still `destructive_delete`, `approve apr_...` and token read denied, scoped cleanup allowed |
| Live verified | `claude doctor` (2.1.319 = latest, no installation issues, last auto-update `install_failed`), `claude auth status` (claude.ai, Max, expires 2026-12-04) |
| Live verified (owner-authorised) | `.env` -> `claude-cli`/`production` (backup `.env.bak-20261107`); production task `ElevariqPersonalAgent` installed 15:40, verify-install all PASS, `health` 0, one supervisor, duplicate start ignored, graceful stop -> rebuild -> restart through the task |
| Implemented + tested (owner-authorised) | `@playwright/test@1.65.0` (npm only, installed Edge): `tests/browser/command-center.spec.ts` 9/9, 4 green runs, backend state asserted; fixed 3 UI defects it found (stale approvals badge, error view without navigation, 228 px phone overflow); doctor DEP0190 warning removed |
| Awaiting owner | decision on `apr_mw67xtxk4c1e992a8e` (sandbox); reboot check; ERP/CRM resources; PR/merge |
| Blocked | ERP/CRM live integration (resources) |

Observed facts:
- `apr_mw67xtxk4c1e992a8e` = sandbox task 2's QA mutation command (`rm -rf .qa-mut` before and after a mutant run).
  It never ran (the hook blocked it), `.qa-mut` does not exist; nothing needs deleting. Approving it would grant
  `destructive_delete` for the rest of that task; with the scoped tool a retry needs no approval. No new approval
  request was created because none is required.
- The production task runs the build in this working tree: rebuild/branch switches only via the procedure in
  `docs/OPERATIONS.md` ("Production scheduled task").
- ~90 `elevariq-*` temp directories in `%TEMP%` are left by test runs and smoke scripts (harmless; owner may delete).

## Next (in order)

1. Owner decisions listed in the final stabilization report (`docs/ACCEPTANCE_REPORT.md`, "Owner actions").
2. After the owner's reboot check: first real project through the production task (watch `capacity_wait`/`retry`
   events for the first real usage-limit wait).
3. Optional live run with web research enabled, then merge `feat/windows-compat` through a PR once reviewed.
