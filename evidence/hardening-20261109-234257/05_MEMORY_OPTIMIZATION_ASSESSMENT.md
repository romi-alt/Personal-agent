# 5. Memory optimisation assessment (P1)

**Rules followed:** read-only measurement; **no process was terminated**; no memory threshold was changed; nothing was lowered to force execution.

## 5.1 Host and gate facts
- **Physical memory:** 8,029 MB.
- **Commit limit:** 19,119 MB (RAM plus page file).
- **V2 memory gate (A9):** new claims pause when available physical memory (`os.freemem()`) is below `MIN_FREE_MEMORY_MB` = 1024, and resume at or above `RESUME_FREE_MEMORY_MB` = 1536. Running workers are never killed.
- **Production** uses these defaults: no override in `.env`.

## 5.2 Measurements

| When | Available RAM | Commit used / limit | Context | Source |
|---|---|---|---|---|
| 2026-11-09 18:14–18:40 (readiness) | 838–1,401 MB (typ. 970–980) | headroom 1.1–2.9 GB | idle host | readiness PERFORMANCE §1 |
| 2026-11-10 00:08 | **443 MB** | **17,754 / 19,119 MB (93 %)** | during `npm ci` of the branch regression (npm 697 MB WS) | `Win32_OperatingSystem` |
| Regression steps (2026-11-10) | min 398 MB (`npm ci`), 732 MB (unit, vitest 2 workers, tree 341 MB peak) | — | `logs/regression-693058c/summary.txt` | measured |
| Readiness regression | min **262 MB** (integration), 362 MB (browser; Edge tree 977 MB) | — | `release-readiness/.../summary.txt` | measured |

**Largest consumers at 00:08** (read-only `Get-Process`, grouped):

| Process group | Count | Working set | Private (commit) | Notes |
|---|---|---|---|---|
| Memory Compression | 1 | 2,063 MB | — | Windows compressing pages; a symptom of pressure |
| Chrome | 30 | 972 MB | **3,474 MB** | Browser tabs/extensions |
| **Claude desktop app** (`WindowsApps\Claude_…\claude.exe`) | 11 | ≈ 424 MB | **≈ 2.6–3.0 GB** (the `claude` group total of 3,009 MB includes the CLI session below) | Running since **2026-11-06 15:19**; largest renderer 292 MB WS |
| Claude Code CLI (interactive, `~\.local\bin\claude.exe`) | 1 | 345 MB | — | **This assessment session** (started 2026-11-07 05:57) |
| msedgewebview2 | 13 | 149 MB | 1,231 MB | WebView hosts (incl. the desktop app) |
| Production supervisor (node, pid 8992) | 1 | **19 MB** | — | V2 itself is small |
| Defender (MsMpEng) | 1 | 168 MB | 362 MB | |

**Finding:** the binding constraint is **commit charge plus physical availability on an 8 GB host running two Claude front-ends and ~30 browser processes**, not the agent. The supervisor uses 19–46 MB.

## 5.3 One-worker resource requirement

| Component | Value | Status |
|---|---|---|
| Claude Code CLI process (`claude -p`) | ~290–345 MB WS (interactive CLI sessions on this host) | **Proxy measurement.** A headless worker was **not** measured: that needs the owner's login, which is excluded by this assignment |
| Project test run (vitest, 2 workers) | 340–400 MB tree | measured |
| Browser QA (Playwright + Edge) | ~980 MB tree | measured |
| `npm ci` | ~700 MB | measured |
| **One worker, code + unit tests** | **≈ 0.7–0.8 GB** | estimate from the measured parts |
| **One worker + browser QA** | **≈ 1.3–1.7 GB** | estimate |

The default gate (pause < 1024, resume ≥ 1536) is therefore **correctly sized** for one worker: starting at 1,536 MB and consuming ~0.8–1.7 GB lands at 0–0.8 GB available. That is exactly the region where the pilot saw supervisor deaths and a 70 s stale heartbeat. **Lowering the thresholds would only move the failure into the run itself**, so it is not recommended (mandate: "do not lower memory safety limits merely to force execution").

## 5.4 Unnecessary processes (identified only; none terminated)

| Candidate | Reclaimable (est.) | Owner decision |
|---|---|---|
| Claude **desktop app** open since 11-06 | ≈ 2.6–3.0 GB commit, ≈ 0.4 GB+ WS (more once its compressed pages are counted) | Close it while the agent works (recommended) |
| Chrome (30 processes) | ~3.5 GB commit, ~1 GB WS | Close unused tabs/windows, or use Memory Saver |
| This interactive Claude Code session | ~345 MB | Ends when this assignment closes |
| Duplicate node processes | none found besides the supervisor and this regression | — |

## 5.5 Recommendations

| # | Recommendation | Type | Evidence |
|---|---|---|---|
| M-1 | **Keep `MIN/RESUME_FREE_MEMORY_MB` at 1024/1536** | Policy | §5.3 |
| M-2 | Keep `MAX_CONCURRENT_WORKERS=1` | Policy | 262 MB minimum with one workload |
| M-3 | **Operating practice:** close the Claude desktop app and unused Chrome windows during autonomous work. Expected availability ≈ 2–2.5 GB, so the gate opens with margin | Owner habit | §5.2 |
| M-4 | **Add a commit-charge check to the gate** (V2.1 code): pause when commit headroom < 2 GB. Measured headroom 1.36 GB at 00:08; physical availability alone does not show commit exhaustion, which makes allocations fail outright | Code (roadmap) | 93 % commit at 00:08 |
| M-5 | Per-worker **job-object memory cap** (e.g. 2.5 GB commit) so a runaway test run is killed instead of starving the supervisor | Code (needs a signed helper or addon; SAC) | AppContainer prototype supported `--mem-mb` |
| M-6 | Alert the owner when the gate stays closed > 1 h (`supervisor.resource_deferred`) | Code (small) | readiness OPS-1 |
| M-7 | Structural: 16 GB RAM, or a dedicated worker host / VM (also enables isolation option E) | Hardware | — |

**Unverified:**
- the memory footprint of a real headless Claude Code worker;
- the gate's behaviour with real workers over hours.

Both need an owner-authorized staging run with a real worker session.
