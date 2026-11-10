# Windows V2 Test Results: release `e60278f` (independently re-executed 2026-11-09)

## Environment
- **Host:** Windows 11 Pro 10.0.26300, 8 logical CPUs, 8029 MB RAM (about 0.8–1.4 GB available).
- **Toolchain:** Node v26.13.0, npm 11.20.0.
- **Workspace:** isolated clean clone `E:\Agent\v2-staging\rr\v2-e60278f` (detached HEAD `e60278fcf6d6…`, working tree clean, no `.env`).
- **Isolation settings:**
  - `AGENT_HOME=E:\Agent\v2-staging\rr\home-regression`
  - `AGENT_ENV_FILE` set to a nonexistent file
  - `EXECUTION_PROVIDER=mock`
  - integrations off, no webhook

**Runner:** `scripts\regression.ps1`:
- runs the steps one after another, each with its own deadline;
- samples available RAM every 3 s;
- stops only its own process tree if available RAM stays below 350 MB for 4 samples in a row (this never triggered);
- checks that the production supervisor (pid 8992) is still alive after every step.

**Evidence:**
- logs: `logs\regression-e60278f\` (`summary.txt`, per-step `.log`, vitest `.json`, `per-file-summary.txt`, `all-test-titles.txt`);
- run time: 18:16:55 → 18:27:17.

**Tested commit relationship:**
- `e60278f` is the PR #4 merge. Parents: `f59d4ca` (previous main) and `fca3cd3` (integration head).
- Its tree is **byte-identical** to `fca3cd3` (both `b408a00a…`).
- Earlier evidence was gathered on `fca3cd3` and `8966e29`. **This run replaces it**: every suite was re-run on `e60278f` itself.

## Results

| # | Gate | Exact command | Exit | Result | Duration | Min. available RAM | Prod alive |
|---|---|---|---|---|---|---|---|
| 00 | Reproducible install | `npm ci --no-audit --no-fund` | 0 | PASS. Lockfile unchanged; working tree clean afterwards | 12.4 s | 507 MB | yes |
| 01 | Types | `npm run typecheck` | 0 | PASS | 5.6 s | 1084 | yes |
| 02 | Lint | `npm run lint` | 0 | PASS | 5.7 s | 1022 | yes |
| 03 | Format | `npm run format:check` | 0 | PASS | 4.5 s | 1149 | yes |
| 04 | Production build | `npm run build` | 0 | PASS | 4.7 s | 1100 | yes |
| 05 | Runtime dependency audit | `npm audit --omit=dev` | 0 | **PASS: 0 vulnerabilities** | 1.8 s | — | yes |
| 05b | Full audit (dev included; informational) | `npm audit` | 1 | **10 moderate**, all in dev tooling, none in runtime dependencies | 6.6 s | — | yes |
| 06 | Secret scan (CI regex over 145 tracked files, excluding `tests/`) | regex from `scripts/ci-local.mjs` | — | **PASS: 0 matches.** Including `tests/` there are 15 matches, all short synthetic fixtures (28–40 chars, low entropy; `evidence\secret-scan-test-fixtures.txt`) | — | — | yes |
| 07 | Unit | `npx vitest run tests/unit --maxWorkers=2` | 0 | **PASS: 23 files, 394/394, 0 failed, 0 skipped** | 26.2 s | 793 | yes |
| 08 | Integration | `npx vitest run tests/integration --maxWorkers=2` | 0 | **PASS: 18 files, 173/173, 0 failed, 0 skipped** | 361.0 s | **262** | yes |
| 09 | E2E / recovery | `npx vitest run tests/e2e --maxWorkers=1` | 0 | **PASS: 6 files, 27/27, 0 failed, 0 skipped** | 166.2 s | **276** | yes |
| 10 | Browser (Playwright 1.65, installed Edge, headless) | `npm run test:browser` | 0 | **PASS: 9/9** | 24.9 s | 362 | yes |

- **Vitest total: 594 discovered, 594 passed, 0 failed, 0 skipped.** Browser: 9 discovered, 9 passed.
- **Compared with the historical report** (394 / 173 / 27 / 9): the counts are identical. Those numbers were previously split across `8966e29` (unit and integration) and `fca3cd3` (e2e and browser). They are now all confirmed on the release SHA.

**Not run, or run differently:**
- **`npm run ci:local` was not run as-is.** It requires Node 22, writes `core.hooksPath` into the shared `.git` config (which would affect the production checkout), and posts GitHub commit statuses. Its steps were run individually instead (rows 00–10).
- **The `check-windows` job is covered by rows 00, 04 and 07–09.**
- **Linux: NOT VERIFIED.** Out of scope by owner decision. No WSL, no Docker, GitHub Actions off. This is **not** a pass.
- **Browser tests ran once on `e60278f`.** They passed three times on the identical tree `fca3cd3` earlier today (historical).

## End-to-end workflow coverage (mock provider, isolated homes)

| # | Workflow | Automated evidence (all passed in this run) | Staging rehearsal (see DATABASE_MIGRATION_REHEARSAL.md / STAGING_DEPLOYMENT_REHEARSAL.md) |
|---|---|---|---|
| 1 | Task intake and normalization | `planning`, `project-intelligence` (unit+int), `cli-commands` (CRLF task file) | F1–F3 |
| 2 | Project planning | `planning-workflow` (17), `planning-e2e` | (pilot DB already planned) |
| 3 | Requirement ownership | `qa-ownership` (unit 8 + int 1), `requirement-coverage` | — |
| 4 | Worker execution | `supervisor` (25), `phase15-recovery` (16) | F4 |
| 5 | Independent QA | `independent-qa`, `qa-review-atomic`, `qa-needs-evidence` | F4–F6 |
| 6 | QA rejection and correction | `independent-qa`, `progress-qa-integration` | F4 ("Review: Flaky B" rejects first, then a correction) |
| 7 | Owner approval handling | `dashboard` (8), browser 3–4, `cli-verification-v2` | F5 (worker approve refused; owner deny) |
| 8 | Requirement status calculation | `status-reconcile`, `progress-dispatch` (25) | E8 (pilot copy: 41 REVIEWED) |
| 9 | Milestone completion | `status-reconcile`, `progress-dispatch`, `project-lifecycle` (30) | E8 |
| 10 | Project verification configuration | `verification-v2` (6), `cli-verification-v2` (3) | F2, F7 |
| 11 | Persistent checkpoint recovery | `phase15-recovery`, `restart-recovery` (3) | F6 |
| 12 | Crash recovery | `orphan-worker` (3), `restart-recovery`, `concurrency` | F6 (supervisor killed mid-task) |
| 13 | Usage-limit handling | `cli-provider` (usage-limit wait), `claude-provider`, `decide`, `capacity-watchdog` | not reproducible with the mock provider |
| 14 | Long capacity wait | `capacity-sleep` (13), `capacity-v2` (5: A12 notify/block/24 h, restart while waiting) | — |
| 15 | Safe cleanup | `scratch-cleanup` (18) | F8 |
| 16 | Supervisor restart logic | `windows-scripts` (wrapper exit-code policy), `supervisor`, `capacity-v2` (restart while waiting) | F6 (duplicate start refused) |

**Browser/dashboard checks** (`tests/browser/command-center.spec.ts`, 9/9). The dashboard binds 127.0.0.1 on a random port in 43000–44500; production has no listening socket.
1. Login: a wrong token is refused and audited; the right token opens a hardened session.
2. Project creation in plain language starts planning.
3. Plan approval through the inbox, with an audit note.
4. A production deploy request is denied through the UI.
5. Pause and resume of a task and of a project.
6. Live status: a worker waiting for a usage reset is shown, then its completion.
7. Error states: stale approval, unknown project, missing CSRF, sign-out.
8. Responsive phone and tablet widths without overflow.
9. No JavaScript errors.

**Not covered:** refresh and reconnect after a dashboard *server* restart has no dedicated test (page reloads are covered).

## Resource observations from this run
- **Available RAM fell to 262 MB** during integration and 276 MB during e2e, with 2 vitest workers / 1 worker respectively. The guard needs 4 consecutive samples below 350 MB, so it did not fire. These were brief dips.
- Peak tree working set: vitest 337–376 MB; Playwright with Edge 977 MB (11 processes).
- The production supervisor stayed alive throughout.
- See PERFORMANCE_RESOURCE_ASSESSMENT.md for implications.
