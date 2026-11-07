# Build progress and checkpoint

Durable checkpoint for the full-build mandate (owner brief of 2026-11-07). Any new session or context continues
from here: read this file, `git log`, then pick the first unchecked item.

## Environment (owner machine)

* Windows 11 Pro, PowerShell 5.1, Node 26.13 (winget `OpenJS.NodeJS.LTS`), Git 2.56 (winget `Git.Git`).
* Claude Code 2.1.319 at `C:\Users\<owner>\.local\bin\claude.exe`; subscription login (`authMethod: claude.ai`, Max).
* Repository branch for this work: `feat/windows-compat` (based on `claude/dreamy-edison-hiyq3n`). Never force-push.

## Done (verified)

| Item | Evidence |
|---|---|
| Suite runs on Windows | 248/248 tests on Windows 11 (`npm test`, 2026-11-07); typecheck, lint, format clean |
| Windows fixes: CRLF/BOM input, `.gitattributes`, single-spawn `gitState`, test cleanup on file locks | commit `2b3975d` |
| PowerShell scripts parse under real Windows PowerShell 5.1 | parser check: 0 errors in all 4 scripts, ASCII only |
| B1 native Claude Code CLI provider (`EXECUTION_PROVIDER=claude-cli`) | `src/providers/claude-cli/*`, `tests/unit/cli-provider.test.ts` (15) |
| Watchdog env verified present in 2.1.319 and injected per worker; parent `CLAUDE_CODE_*`/`ANTHROPIC_*` stripped | `provider:status` output; unit test asserts worker env |
| Policy enforced by fail-closed PreToolUse hook command | `tests/unit/cli-provider.test.ts › policy hook command` (exit 2 on failure) |
| **Acceptance test 5 (real CLI smoke)**: 8/8 live checks PASS | `npx tsx scripts/cli-smoke.ts`: apiKeySource=none (subscription), write allowed, `git push` denied as `protected_branch_push`, session persisted before launch, `--resume` continued the same conversation |
| **Acceptance test 4 (simulated usage limit)** | `tests/integration/capacity-watchdog.test.ts`: task stays RUNNING / `WAITING_FOR_USAGE_RESET`, lease kept by heartbeats, 1 execution + 1 request, resumes when capacity returns |
| B2: capacity wait suspends execution timeout; stall detection outside waits; orphan CLI worker stopped on recovery (pid-reuse safe) | `cli-provider.test.ts`, `tests/unit/process-tree.test.ts` (real processes) |
| Worker state for command center (`RUNNING`, `WAITING_FOR_USAGE_RESET`, ...) | `deriveWorkerState` in `src/supervisor/status.ts` |

## Facts established (do not re-derive)

* Docs: `CLAUDE_CODE_RETRY_WATCHDOG` (>=2.1.186) retries 429/529 indefinitely, waits until reset when the response
  has a reset time; spend-limit 429s fail immediately (>=2.1.239). `..._USAGE_LIMIT_RECHECK_MS` valid 60000..10800000
  (>=2.1.305). `..._MAX_USAGE_LIMIT_WAIT_MS` and `..._SCOPE` exist in the binary but are **undocumented**: not used.
* In `-p` mode an exported `ANTHROPIC_API_KEY` always wins over the subscription: it must be stripped (done).
* `system/init.apiKeySource` is `none` for the subscription login (observed live).
* Hook exit code 2 blocks; other non-zero codes do NOT block, so the hook maps every error to 2.
* Process spawns cost ~150 ms on this machine; keep git/process calls per task low.

## Not yet verified / open

* Real usage-limit wait output of the CLI (shape of messages during a watchdog wait) is inferred from docs
  (`api_retry` error `rate_limit`, `rate_limit_event` status `rejected`); not observed live (deliberately: the real
  subscription is not exhausted for testing).
* `claude-cli` under Windows Task Scheduler (non-interactive logon) not yet run (G1).

## Next (in order)

1. Phase 1.5 wrap-up: e2e with `claude-cli` + SIGKILL of the supervisor mid-run against the real CLI (small task),
   verify orphan stop + `--resume` (acceptance test 6 on the real provider).
2. Phase 2 remainder: intake of free-text assignments into the existing assignment contract; research step; ADR files.
3. Phase 3: dispatch with roles, inspect/build/test runners, independent review, corrective loop, Playwright UI QA.
4. Phase 4: ERP/CRM read adapters (needs the ERP repository / API docs from the owner: **external blocker**).
5. Phase 5: command center web app (local-only, authenticated) on top of `buildStatus` + store.
6. Phase 6: Task Scheduler verification on this PC; VPS packaging (no public deployment without approval).
