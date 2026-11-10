# Phase F: full Windows regression on the exact final local commit

## Run conditions
- **Final commit:** `1e5b7d48cfeb8fe06839db05e4efc96b68c7be34` (`fix/pr5-review-findings`). The working tree was clean (`dirtyFiles=0`), and HEAD was re-checked at the end of the run.
- **Window:** 2026-11-10 01:45:30 → 02:03:21 (+05:00).
- **Earlier run:** a full run on `7de4d66` (01:21:33 → 01:38:44) also passed every step. It is kept in `logs\regression-7de4d66\`. `1e5b7d4` was created afterwards from the Phase G findings, so the whole suite was **re-run** on it.
- **Host:** Windows 11 Pro, Node v26.13.0, npm 11.20.0, isolated clone `E:\Agent\v2-staging\hardening\repo`.
- **Runner:** `scripts\run-regression.ps1`. Steps run **sequentially**. Before each step it waits (never kills) if free memory is under 700 MB; it never had to wait. Free memory is sampled every 3 s. The production supervisor pid 8992 is checked after every step. No process was terminated, and no production threshold was changed.
- **Dependencies:** `npm ci` was **not re-run**. `package.json` and `package-lock.json` are byte-identical to `e60278f` (`git diff --quiet` exit 0). `node_modules` came from `npm ci` on that lockfile (2026-11-10 00:08).

## Results on `1e5b7d4`

| Step | Command | Exit | Result | Duration (s) | Free MB start / min / end | Production alive |
|---|---|---|---|---|---|---|
| Typecheck | `npm run typecheck` | 0 | PASS | 13.0 | 991 / 618 / 1032 | yes |
| Lint | `npm run lint` | 0 | PASS | 12.7 | 1035 / 652 / 1018 | yes |
| Format check | `npm run format:check` | 0 | PASS | 12.8 | 1014 / 718 / 971 | yes |
| Build | `npm run build` | 0 | PASS | 12.7 | 972 / 574 / 930 | yes |
| Runtime dependency audit | `npm audit --omit=dev` | 0 | PASS: **0 vulnerabilities** | 3.2 | 933 / 933 / 945 | yes |
| Full audit (information) | `npm audit` | 1 | 10 moderate, **dev only**: minimatch ReDoS GHSA-g3hv-75wg-m249 via eslint 10 / typescript-eslint. The fix is a breaking eslint downgrade, so it was not applied. Unchanged from earlier runs. | 9.5 | 944 / 760 / 984 | yes |
| Secret scan | `scripts\secret-scan.mjs` | 0 | PASS: 206 tracked files, **0 matches**, 22 synthetic test fixtures | 3.2 | — | yes |
| Unit | `vitest run tests/unit --maxWorkers=2` | 0 | **545 / 545** (27 files) | 41.1 | 978 / 667 / 922 | yes |
| Integration | `vitest run tests/integration --maxWorkers=2` | 0 | **198 / 198** (20 files) | 617.9 | 923 / 508 / 908 | yes |
| End-to-end | `vitest run tests/e2e --maxWorkers=1` | 0 | **27 / 27** (6 files) | 294.0 | 909 / 536 / 1458 | yes |
| Browser (Playwright, installed Edge) | `npm run test:browser` | 0 | **9 / 9** | 35.1 | 1459 / 631 / 1386 | yes |
| Security probes (69) | `scripts\probe-compare.ts` | 0 | V2.1 bypasses **0** / 52; residual not text-decidable 15; legitimate regressions 0 | 3.2 | — | yes |
| Rule K matrix (120) | `scripts\rule-k-matrix.ts final-provider provider` | 0 | FN **0**, FP 4 (accepted) | 3.2 | — | yes |
| PR #5 review probes (52) | `scripts\pr5-review-probes.ts` | 0 | R1–R20 blocked (R11 informational); L27 accepted FP | 3.2 | — | yes |

**Totals:**
- **779 automated tests pass**: 545 + 198 + 27 vitest (770) + 9 browser.
- **0 failures.**
- 241 classification probes (69 + 120 + 52).

The `7de4d66` run gave 541 + 198 + 27 + 9 = 775. The difference is the 4 Phase G unit tests added in `1e5b7d4`.

Compared with the V2.1 PR head (`693058c`/`4d07438`, 2026-11-10 00:26: 477 + 173 + 27 + 9 = 686), that is **+93 tests**:
- `c447cdb`: +24 unit;
- this session: +44 unit (`phase-bde-v21`) and +25 integration (`audit-redaction-v21` 20, `approval-semantics-v21` 5).

## Memory observations
- Lowest free memory: **508 MB** (integration step). Before the run, free memory was already around 0.99 GB, after the Phase G staging run.
- During these runs the production memory gate deferred and resumed scheduling (`supervisor.resource_deferred`/`resumed` events). Production was idle with no queued tasks.
- The gate behaved as designed. It confirms that heavy local test load on this 8 GB host pauses production scheduling.

## Evidence
`logs\regression\` (final commit) and `logs\regression-7de4d66\`. Each holds:
- `summary.txt`;
- one `NN-*.log` per step;
- vitest JSON reports (`07-unit.json`, `08-integration.json`, `09-e2e.json`) with every test name and status.

Probe outputs:
- `evidence\probe-compare\`;
- `evidence\rule-k\final-provider\`;
- `evidence\pr5-review-probes.tsv`.

## Not covered
- **Linux:** skipped by owner decision (2026-11-09). It is recorded as skipped, not passed.
- **GitHub Actions:** off, and CI needs a push, which is not authorized.
- **OS-isolation acceptance tests (V2.2):** not run, because the architecture is not implemented.
