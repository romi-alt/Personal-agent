# V2 Requirement-to-Evidence Matrix (release candidate `050bd73`)

**Candidate**

| | |
|---|---|
| Branch | `feat/agent-v2-reliability` |
| Source commit (tested, packaged) | **`050bd7375965107b9d0f3ce82042d54e06c483e8`** |
| Artifact | `E:\Agent\v2-staging\rc\elevariq-agent-v2-050bd73.zip` |
| Artifact SHA-256 | `b61205ace474172262db415101cfcdfa9e6a9558f2d3e761563123a006ca653f` |
| Build | Clean clone at 050bd73 → `npm ci` (lockfile unchanged) → `npm run build` → package `dist/ scripts/ examples/ docs/ package*.json .npmrc .env.example README.md BUILD-INFO.txt` |
| Install | Verify the checksum → extract → `npm ci --omit=dev` (`.npmrc` `ignore-scripts=true` uses the bundled better-sqlite3 prebuilds) |
| Environment | Windows 11 Pro 10.0.26300, Node v26.13.0, PowerShell 5.1, 7.84 GB RAM (0.73–1.67 GB available during the runs) |
| Configuration | Mock provider, no credentials (no `.env`), integrations off, no webhook, health server off, `MIN_FREE_MEMORY_MB=0` only in test harnesses and staging |

Commits after `050bd73` change documentation only (this file and V2_RELEASE_REPORT.md). Tests and the artifact correspond to `050bd73`.

**Evidence root:** `E:\Agent\v2-staging\rc\`

| Folder | Contents |
|---|---|
| `regression\` | `summary.txt` + per-step logs |
| `fresh\evidence\` | Fresh-install workflows |
| `upgrade-pilot\evidence\` | Pilot-copy upgrade and rollback |
| `upgrade-synthetic\evidence\` | v1 → v2 synthetic upgrade |
| `v1-baseline-*.json` | v1 baseline before and after |

All timestamps are 2026-11-09 PKT.

## 1. Regression against `050bd73`

Runner `E:\Agent\v2-staging\scripts\rstep.ps1`: foreground steps, each with its own deadline, memory sampled every 5 s, and only its own process tree stopped when available memory falls below 350 MB (never triggered).

| Check | Command | Exit | Result | Duration | Min available RAM |
|---|---|---|---|---|---|
| Install and lockfile | `npm ci --no-audit --no-fund` (clean clone) | 0 | PASS; working tree unchanged afterwards | 9 s | 735 MB |
| Types | `npm run typecheck` | 0 | PASS | 4 s | 1366 MB |
| Lint | `npm run lint` | 0 | PASS | 5 s | 1394 MB |
| Format | `npm run format:check` | 0 | PASS | 3 s | 1363 MB |
| Build | `npm run build` | 0 | PASS | 4 s | 1392 MB |
| Runtime dependency audit | `npm audit --omit=dev` | 0 | PASS (0 vulnerabilities) | 1 s | — |
| Secret scan (CI regex, tracked files, excluding tests) | `git grep -nIE ...` | 1 (no match) | PASS (0 matches) | — | — |
| Unit | `npx vitest run tests/unit --maxWorkers=2` | 0 | PASS, 23 files, **393/393** | 17 s | 1192 MB |
| Integration | `npx vitest run tests/integration --maxWorkers=2` | 0 | PASS, 16 files, **144/144** | 216 s | 874 MB |
| E2E / recovery | `npx vitest run tests/e2e --maxWorkers=1` | 0 | PASS, 6 files, **25/25** | 220 s | 1357 MB |
| Browser (×3, bounded repeat) | `npm run test:browser` | 0, 0, 0 | PASS, **9/9 each run** | 33 / 23 / 31 s | 742 / 818 / 777 MB |
| Artifact install | `npm ci --omit=dev` in the extracted artifact | 1, then 0 | **Attempt 1 FAIL**: my package omitted `.npmrc`, so npm ran node-gyp and needed Python. Packaging was fixed (`.npmrc` included) and the artifact rebuilt. Attempt 2 PASS. The failed artifact is kept as `*.ATTEMPT1-missing-npmrc.zip` | 12 s | 858 MB |

## 2. V2 scope: defects and owner decisions

| ID | Requirement / defect | Status | Evidence |
|---|---|---|---|
| A10 | Resume after a capacity reset that happens across host sleep | Implemented and verified | `capacity-sleep` (A10 tests), `capacity-v2` (multiple resets, same session); regression rows unit and integration |
| A11 | Execution time limit counts active time only | Implemented and verified | `capacity-sleep` (mutation-checked); default threshold 120 s since 050bd73 |
| A12 | Bounded capacity waits + escalation | Implemented and verified | `capacity-sleep` (30 min handoff, ceiling, opt-out), `capacity-v2` (24 h default notification delivered once, block policy) |
| A5 | Verification commands derived when none are set | Implemented and verified | `verification-v2`; staging W7 (`project:verify` executed `node --version`: BUILD_PASSES and TESTS_PASS PASSED with exit 0) |
| A6 | Manual tasks get QA and need criteria | Implemented and verified | `verification-v2`, `cli-verification-v2`; staging W3 (no criteria → exit 2, nothing created), W4–W6 (manual tasks reviewed: 3 QA rounds PASSED) |
| A7 | Audited configuration after intake | Implemented and verified | `verification-v2`, `cli-verification-v2`; staging W2 (no `--by` → exit 2; set → `assignment.verification_changed` ×1) |
| A1 | Requirement ownership and scoped review | Implemented and verified | `qa-ownership` (unit + integration), `requirement-coverage` |
| A2 | Shell-text false positives; agent-CLI bypass | Implemented and verified (guardrail limits, §4) | `policy-normalize` (158), `policy-v2-review` (18), `agent-control-policy` |
| A3 | Atomic review links | Implemented and verified | `qa-review-atomic`; pilot-copy migration `qa_review_tasks`=66 |
| A4 | Derived requirement and milestone status | Implemented and verified | `status-reconcile`; pilot copy after the staging run: 41 REVIEWED, milestones 5 REVIEWED + 2 ACCEPTED |
| A8 | Scratch cleanup of trees containing links | Implemented and verified | `scratch-cleanup` (18); staging W8 (`.tmp-staging` deleted, `src` refused, exit 1) |
| A9 | Memory gate with hysteresis 1024/1536 MB, running work kept | Implemented and verified | `resource-gate` (3) |
| Decision A | NEEDS_EVIDENCE for unverifiable high-severity findings | Implemented and verified | `qa-needs-evidence` (3), `qa-ownership` |
| Decision B | Destructive operations stay gated; scratch cleanup narrow | Implemented and verified | `policy-normalize` #5, `scratch-cleanup` guard test, staging W8 |
| Decision C | REVIEWED and ACCEPTED distinct; acceptance is never verification | Implemented and verified | `qa-needs-evidence`, `requirement-coverage`, `independent-qa` (OWNER_ACCEPTED), `status-reconcile` |
| Independent review findings | 3 HIGH, 6 MEDIUM, 1 LOW fixed | Implemented and verified | `policy-v2-review`, `requirement-coverage`, `capacity-sleep` (stale reset), `verification-v2` (clear-all), `cli-verification-v2` (worker guard) |
| Documentation | v2 behaviour in `.env.example`, OPERATIONS, COMPLETION_VERIFICATION | Implemented (050bd73) | — |

## 3. Previously reported issues: applicability to this repository

| Reported issue | Origin | Applies to V2 agent? | Status |
|---|---|---|---|
| Legacy demo accounts without forced password change | Portal S1-F1 (`elevariq-retail-operations-portal`) | **No** (portal code) | Fixed and verified in the pilot: `pilot-evidence\...\REVIEW_S1F1_D4.md`, legacy-DB check 41/41 at portal `1ae7d2f` |
| Timing-sensitive browser test under memory pressure | Portal D4 | No (portal) | Pilot: fixed for the reported condition, residual risk documented |
| Timing-sensitive browser test under memory pressure | V2 agent (`test:browser` failed once when the memory gate paused the harness) | Yes | Fixed (harness opts out of the host-memory gate). Verified by 3 consecutive 9/9 runs at 742–818 MB minimum available, which would otherwise have paused it |
| Requirements linked to the wrong tasks | Agent A1 | Yes | Fixed (§2) |
| Security policy flagging harmless content | Agent A2 | Yes | Fixed (§2) |
| Manual tasks without QA | Agent A6 | Yes | Fixed |
| `project:verify` NOT_CONFIGURED with no way to configure | Agent A5/A7 | Yes | Fixed |
| Temporary-folder cleanup rejecting legitimate folders | Agent A8 | Yes | Fixed |
| Inconsistent API ID types | Portal D2 | **No** (portal API) | Open in the portal (Low); outside V2 scope |
| Stale evidence / inaccurate documentation | Portal S1-F2/F3 (pilot) and agent docs | Portal: no. Agent docs: yes | Portal: recorded in pilot evidence. Agent: fixed in 050bd73 (stale `.env.example`, `task:add` example, verification statuses) |
| Linux behaviour unverified | Pilot L1; agent v2 | Yes | **BLOCKED**: no Linux environment on this host (no WSL, no Docker); the CI Linux job runs only on push or PR to `main`, which needs owner authorization. Verified on Windows only |
| A1–A9 (pilot backlog) | Agent | Yes | All fixed (§2); A10–A12 also fixed |

## 4. Critical workflows in isolated staging (from the artifact)

| Workflow | Procedure | Observed persisted outcome | Status |
|---|---|---|---|
| Fresh install / initialization | `fresh` W1: `doctor` on an empty home; `assignment:add` | DB created at v10; project registered | PASS |
| Upgrade from a representative v1 schema | `upgrade-synthetic`: v1 code builds the DB (1 completed, 1 queued task); the v2 artifact opens it | v8 → v1–8,10; all history fingerprints identical; the queued v1 task completed under v2 | PASS |
| Upgrade from the pilot DB copy | `upgrade-pilot` S1–S7 | v1–8,10; 141 tasks / 157 executions / 157 checkpoints / 9 approvals / 65 QA rows identical; all projects, tasks and approvals listed | PASS |
| Authentication / session (dashboard owner token) | Browser suite ×3 | Wrong token refused and audited; hardened session | PASS (browser) |
| User roles / password-change enforcement | — | The agent has a single owner and no user accounts | NOT APPLICABLE (portal feature, verified in the pilot) |
| Task creation paths and policy | W3 | No criteria → exit 2, no row; duplicate key ignored; 5 `task.verification_policy` events | PASS |
| QA assignment and execution | W4–W6 | 3 manual tasks each reviewed in a separate session: 3× `qa.passed` | PASS |
| Build/test configuration and `project:verify` | W2, W7 | BUILD/TESTS PASSED (exit 0); CLAIMED_COMPLETE FAILED (correct: one task FAILED, one BLOCKED); REQUIREMENTS_SATISFIED NOT_EVALUATED (no planned requirements) | PASS |
| Approval gate and denial | W5 | `publish_release` approval PENDING → `deny` → DENIED; task BLOCKED, never COMPLETED | PASS |
| Bounded retries; failure is never success | W4 | Flaky B: PROCESS_CRASH → ok (attempts 1). Fatal C: TASK_FAILURE ×2 → FAILED (max-retries 1) | PASS |
| Crash, interruption and restart recovery | W6 | The recorded supervisor PID was killed during "Long D" (RUNNING). Restart: `recovery.task_reconciled`; INTERRUPTED → ok; 1 session (resumed); attempts 0 | PASS |
| Duplicate-action prevention | W6, S7 | Second supervisor exited by itself (pid 4936 gone); 0 overlapping executions; single staging supervisor in S7 | PASS |
| Concurrent updates / data integrity | Unit and integration suites (lease fencing, duplicate completion ignored) + staging overlap check | 0 overlaps | PASS (tests) |
| Cleanup within allowed paths | W8 | `.tmp-staging` removed; `src` refused, kept | PASS |
| Worker cannot run owner commands | W9 | `project:accept`, `approve` with `ELEVARIQ_WORKER=1` → exit 2 | PASS |
| Health and diagnostics | W1, W6, S7 | `doctor`, `status`, `health` exit 0, consistent with DB state | PASS |
| UI/API consistency | Browser suite ×3 (asserts backend state) | 9/9 ×3 | PASS |
| Backup and restore | W10; S4/S9 | `backup` + `backup:verify` OK; v1 `restore` of the pre-upgrade backup → v1–8, fingerprints = baseline; v1 runs | PASS |
| No real outbound actions | Configuration + observation | Mock provider (no Claude), no `.env`/credentials, integrations off, no webhook; the only notification was local (`approval.required` ×1) | PASS (configuration-level; no network capture) |
| Secrets in logs / evidence | Pattern scan of 216 evidence/log files | 0 hits; no dashboard token issued | PASS |

## 5. V1 isolation

`v1-baseline-before.json` (05:20:55) and `v1-baseline-after.json`, after all staging:

| | Before | After |
|---|---|---|
| Checkout | `1b07468…` (clean) | `1b07468…` (clean) |
| Health | exit 0 | exit 0 |
| Supervisor | pid 21040, started 2026-11-08 22:48:35, IDLE | pid 21040, started 2026-11-08 22:48:35, IDLE |
| Supervisor processes | 21040 only | 21040 only |
| Queue | 0 | 0 |
| Scheduled task | Running | Running |

The task's last-run time advanced (05:16 → 05:36) from its repeating keepalive trigger. That is normal production activity.

The v1 `dist` was only executed with staging `AGENT_HOME` values and a cwd outside production, and never against the live database.
