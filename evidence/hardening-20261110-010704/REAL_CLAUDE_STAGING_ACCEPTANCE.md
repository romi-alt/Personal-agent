# Phase G: real Claude Code staging acceptance

**Gate status: PASSED, with one finding fixed afterwards.**
- One genuine Claude Code task ran through the V2.1 candidate in an isolated staging home, followed by the independent QA lifecycle. It was not a mock.
- The run surfaced **one unexpected security denial**, a V2.1 false positive, and one accounting defect. Both are fixed in `1e5b7d4` and verified by replaying the real transcript. They were **not** re-verified by a second live run, because the mandate authorised one task.

## Setup
- **Candidate:** `dist` of `7de4d66` (built in regression step 04).
- **Driver:** `scripts\run-real-claude-staging.ps1`.
- **CLI:** Claude Code **2.1.321**, `claude.ai` (Max) login, used as-is. Login metadata came from `claude auth status --json`, which reports no token.
- **Model:** `sonnet` (staging setting).
- **Isolation from production:**

  | Resource | Staging | Production (untouched) |
  |---|---|---|
  | `AGENT_HOME` (database, queue, workspaces, logs, run files) | `staging\agent-home` | `%LOCALAPPDATA%\ElevariqAgent` |
  | Env file | `staging\staging.env` (no secrets; explicit `AGENT_ENV_FILE`) | `E:\Agent\Personal-agent\.env` |
  | Dashboard port | 4417 | Configuration default 4317 (not inspected, not changed) |
  | Backups and notification webhook | off | as configured |
  | Supervisor | pid 5820, started and stopped by the driver (`stop`, exit 0) | pid 8992, alive throughout (checked every 30 s) |
  | Workers | 1 (`MAX_CONCURRENT_WORKERS=1`) | — |
  | Memory gate | **staging only:** 450/600 MB (host had 0.7–1.4 GB free) | 1024/1536 unchanged |

- **Credential handling:**
  - Neither this harness nor the agent read, printed, copied or exported credential material.
  - The `claude` executable used its own stored login, which is the "already authenticated CLI session" the mandate permits.
  - The worker environment strips Claude session variables (names only: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …).
- **Caveat on "no production access":**
  - The staging worker's policy protects the *staging* agent home, the staging repository and the owner credential stores. It does **not** list the production checkout or the production agent home by name.
  - File tools are confined to the workspace. A same-user worker could still reach production through code (V2.2 scope).
  - Assurance is therefore **policy plus post-run verification**, not OS enforcement. Post-run verification: every tool call was audited (below); no reference to a production path; production state unchanged (`PRODUCTION_INTEGRITY_CHECK.md`).
- **Disposable repository:**
  - Created by `assignment:add` (managed workspace).
  - Verification commands: `node --check src/slugify.ts` (build) and `node --test` (tests).
  - TypeScript runs on Node 26's built-in type stripping (no `npm install`, no network).
  - **No `tsc` type-check** in the disposable repository: it has no dependencies.
- **Task:** `task:add --file staging\task.md`. The first `task:add` with inline `--instructions` failed: PowerShell 5.1 split the quoted argument. That was a harness issue, retried with `--file`, and logged in `driver.log`.
  - Task: implement `slugify` with tests (FR-1, FR-2), run the checks, commit with git, do not push.
  - Verification required: `CHANGES_EXIST`, `BUILD_PASSES`, `TESTS_PASS`, `REQUIREMENTS_SATISFIED` (independent review).

## Result (staging DB, read-only: `staging\staging-inspect.json`)
| Step | Evidence | Result |
|---|---|---|
| Coding execution | provider `claude-cli`, real session id, 40.9 s, 8 turns, `billing: subscription`, notional estimate 0.059 USD | COMPLETED |
| Changes exist | Working tree or HEAD differs from the baseline | PASSED |
| Build | `node --check src/slugify.ts` exit 0, 212 ms | PASSED |
| Tests | `node --test` exit 0, 569 ms (7 tests; re-run independently by me: 7/7) | PASSED |
| Independent QA review | Separate execution (provider `claude-cli`, 15.2 s, 4 turns, read-only tools: 3 × Read) | **QA round 1 PASSED:** all 4 criteria met with cited `file:line` evidence |
| Approvals | 0 requested | — |
| Git | Worker commit `78b9c43` on `agent/staging-slugify-utility`; no remote; no push attempted | Legitimate |
| Elapsed time | Task queued 01:40:25 → QA passed by 01:41:50 → staging supervisor stopped 01:41:53 | ~1.5 min |

Deliverable: `src/slugify.ts` (lower-case, `[^a-z0-9]+` → `-`, trims hyphens, `TypeError` for non-strings), `test/slugify.test.ts` and `package.json`.

## Legitimate Git operations

| Call | Policy decision | Outcome |
|---|---|---|
| `git add package.json src test && git commit -q -m "…Co-Authored-By…" && git log --oneline \| head -3` | ALLOW | Git refused: no identity configured in the managed workspace. This is a git error, not a policy denial. |
| `git -c user.name="ELEVARIQ Agent" -c user.email="agent@localhost" commit …` | ALLOW. `git -c user.*` is correctly **not** treated as alias or hooks indirection. | Committed |

Observation: managed workspaces have no git identity, so every worker commit costs an extra turn. Recommendation (not implemented): set a local `user.name`/`user.email` when the workspace is created.

## Unexpected security denials
**Count: 1** (the event `task.completed_with_denials`).

- **Denied call:** the worker's first Bash call. It used `mkdir -p src test && cat > package.json <<'EOF' … EOF` and similar heredocs for all three files.
- **Reason given:** "Commands that reference the agent home or the agent repository outside the project workspace are not permitted".
- **Root cause, established by replaying the transcript** (`scripts\replay-staging-denials.ts`, `staging\denial-replay.txt`):
  1. The test file's heredoc **body** contained `import { slugify } from '../src/slugify.ts'`.
  2. `reachesProtectedPath` (new in V2.1) tokenized the body as path arguments.
  3. It resolved `../src/slugify.ts` from the workspace to `<agent home>\workspaces\src\slugify.ts`, which is inside the protected agent home.
- **Classification:** **false positive, V2.1 regression.** Heredoc bodies written to files are data, and `../src` imports in tests are routine.
- **Impact here:** the worker recovered by using the Write tool (3 × Write, allowed) and completed. On a larger task this would cost turns, or end as `completed_with_denials` with work missing.
- **Fix:** `1e5b7d4`.
  - Heredoc bodies are removed before path resolution **only when** the shell analyzer classifies the heredoc as data.
  - Raw text is kept for heredocs fed to an interpreter, for unquoted bodies with substitutions, and for heredoc-written files executed in the same command.
  - The literal agent-path check still sees bodies.
  - Tests:
    - the exact worker pattern is now ALLOW;
    - `node <<EOF` reading `../../notes.txt` is DENY;
    - the redirect target `cat > ../../planted.txt <<EOF` is DENY;
    - an unquoted body with `$(cat ../../…)` is DENY;
    - a heredoc-written script run in the same command is DENY.
- **Replay after the fix** (`staging\denial-replay-after-fix.txt`): all 10 tool calls ALLOW.

## Other finding: token counts lost in usage accounting
- `executions.usage_json` stored `"inputTokens":"[REDACTED]","outputTokens":"[REDACTED]"`. The key-name redaction rule matches "token".
- This is pre-existing behaviour, also in production V2, and it silently destroys usage accounting.
- **Fixed in `1e5b7d4`:** numbers and booleans are not redacted by key name; string values still are. Unit test added.

## Audit-record completeness for this run
- **Supervisor-side `tool_use` records** (execution JSONL): 7 calls for coding and 3 for QA.
  - These match the replayed sequence one-to-one.
  - The hook's per-execution decisions file is deleted after each run, as designed. The denial survives as the `task.completed_with_denials` event and in the transcript.
- **Lifecycle events present:**
  - `worker.launched`/`worker.terminated` (2/2);
  - 6 `task.transition`;
  - 6 `verification.evidence`;
  - `qa.review_queued`, `qa.passed`;
  - 2 `checkpoint.created`;
  - `provider.rate_limit` (2, status `allowed`, five-hour window).
- **What is not recorded:** tool *results*. The CLI's own transcript under `~/.claude/projects` has them; it was not read (credential directory).

## What this does not prove
- **Security against a hostile worker.** The task was benign.
- **Long or complex tasks:** capacity waits, crash recovery and multi-round QA corrections were not exercised. They have mock-provider tests.
- **The `1e5b7d4` fixes under a live CLI.** Verified by transcript replay and unit tests only.
