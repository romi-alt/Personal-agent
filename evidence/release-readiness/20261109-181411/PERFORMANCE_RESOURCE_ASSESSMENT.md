# Windows Performance and Resource Safety: V2 `e60278f` on DESKTOP-QGGLG8D

**Host:**
- 8 logical CPUs, 8029 MB RAM, page-file-backed commit limit 19,119 MB.
- Windows 11 Pro 26300.

**Measured:** 2026-11-09 18:14–18:40.

All figures below are **measured** unless marked *estimate*. **No uncontrolled stress test was run.** Every load was bounded by a memory guard that would have stopped only the rehearsal's own processes, and that guard never triggered.

## 1. Measurements

| Metric | Value | Source |
|---|---|---|
| Host available RAM, idle | 838–1401 MB during the session; 970 MB (18:14), 980 MB (18:39) | `Win32_OperatingSystem` |
| Commit headroom | 1.1 GB (18:14) → 2.9 GB (18:39) | same |
| Background CPU (host) | 17–38 % (3 × 2 s samples, 18:39) | `\Processor(_Total)` |
| Process count | 261 | `Get-Process` |
| Largest non-agent consumers | Claude desktop renderer **1062 MB**, Memory Compression 876 MB, WebView2 614 MB, interactive Claude Code CLI 291 MB, Chrome ×4 ~490 MB | `Get-Process` |
| **Production supervisor (idle)** | WS 46 MB (18:14) / 28 MB (18:39), private 59 MB, 9 threads, 225 handles, 9.6 s of CPU in 32 min | pid 8992 |
| Staging V2 supervisor (idle → after processing 14 mock tasks) | 145 MB → 84 MB WS | rehearsal F4 |
| Supervisor + scheduler wrapper processes | 2 (node + powershell); workers are spawned per task | process tree |
| Child-process cleanup | 0 rehearsal-owned processes left after `stop` (checked by PID ×3). The killed supervisor's task was reconciled; the duplicate instance exited by itself. Production workers are put in a kill-on-close job object | rehearsal F10, R3; `cli-provider.ts:361-364` |
| Task start latency (queued → first execution) | 2.6–3.2 s for user tasks added before start (poll 300 ms); 22–47 ms for QA and correction tasks queued by a running supervisor | `F5-after-phase1.json` (`startLatencyMs`) |
| Recovery latency (kill → reconcile) | **3.4 s** with staging `LEASE_TTL_MS=3000`. *Estimate for production:* ≈ `LEASE_TTL_MS` (60 s), plus the wrapper restart delay (10 s → 5 min backoff) or the keepalive (≤ 5 min) | rehearsal F6 |
| DB contention | 1 supervisor writer plus short-lived CLI connections (WAL). Overlapping executions: **0**. CLI calls against the DB took 0.36–0.6 s, including Node start | rehearsal |
| Migration / backup / restore | 919 ms / 640 ms / 606 ms (7.7 MB DB) | DATABASE_MIGRATION_REHEARSAL.md |
| Dashboard responsiveness | Browser steps 0.19–7.4 s (the 7.4 s step includes a plan-approval round trip); suite 23.3 s | `10-browser.log` |
| Test workload peaks | vitest (2 workers) 337–376 MB tree; Playwright + Edge **977 MB** across 11 processes | regression `summary.txt` |
| **Lowest available RAM observed** | **262 MB** (integration suite), 276 MB (e2e), 362 MB (browser), 507 MB (`npm ci`) | regression `summary.txt` |
| Real Claude Code worker memory | **Not measured.** No live worker ran. The only reference point is the interactive Claude Code CLI on this host at **291 MB** WS. *Estimate:* one worker plus its `npm test` / Playwright children ≈ 0.3 GB + 0.4–1.0 GB | — |

## 2. Can things exhaust memory?
**Yes, the host is close to its limit.** Measured facts:
- The baseline already leaves only about 1 GB available.
- A workload equivalent to one worker running a project's tests (vitest with 2 workers) brought the host down to **262 MB available**.
- Browser QA (Edge) needs about **1 GB**.

Simultaneous Claude Code workers, development tools, browsers and the supervisor **would** exhaust physical memory and push the system into paging. That is the environment in which the pilot recorded two unclean supervisor deaths and a 70 s stale heartbeat (A9).

`MAX_CONCURRENT_WORKERS=1` in production is the main safeguard and **must stay at 1** on this host.

## 3. The V2 memory gate (A9): evaluation

| Aspect | Finding |
|---|---|
| Mechanism | Before claiming **new** work: if `os.freemem()` (available physical RAM) is below `MIN_FREE_MEMORY_MB` → pause; resume only when it is at or above `RESUME_FREE_MEMORY_MB` (hysteresis). Running workers are never killed. Events `supervisor.resource_deferred` / `resource_resumed` (`supervisor.ts:267-294`) |
| Verified | Tests `resource-gate` 3/3. Staging: forced gate → task deferred (QUEUED, 0 executions); gate lowered → it ran in 2.1 s |
| Live behaviour | Production logged `resource_deferred` at 18:07:58 and 18:14:28 and `resource_resumed` once between them. With 970–1400 MB typically available, the **1024 pause / 1536 resume defaults keep the gate closed most of the time**. Once it closes, 1536 MB is reached only briefly (max observed this session: 1521 MB) |
| Limits | (1) It gates only *new* claims; a running worker's own test runs are unbounded. (2) It ignores commit charge. (3) It also gates QA reviews, so a closed gate stalls verification as well as new work |

## 4. Recommendations (measurement-backed; **owner decision required**, nothing was changed)
1. **Keep `MAX_CONCURRENT_WORKERS=1`.** Measured: one test-heavy workload already reaches 262 MB available.
2. **Pick one memory policy for production.** Production currently has no explicit setting, so it inherits defaults that will stall it.
   - **(a) Free RAM and keep the defaults (recommended).** Close the Claude desktop app (renderer 1.06 GB) and unneeded browser windows while the agent works. On measured numbers that raises availability to about 2 GB, so the 1024/1536 defaults would let work start while keeping a real safety margin.
   - **(b) Lower the thresholds to about 768 / 1024 MB.** Work would start on the current host. Risk: a worker test run started at ~800 MB can drive the host to ~0 MB available (the 262 MB dip started from ~1050 MB).
   - **(c) Add RAM (16 GB).** This is the structural fix.
3. Leave `CLAUDE_CLI_MAX_CAPACITY_WAIT_MS` (30 min) and `HOST_SUSPEND_THRESHOLD_MS` (120 s) at their defaults. Both are covered by tests (A11/A12).
4. Monitor `supervisor.resource_deferred` events and heartbeat staleness for the first days of real work. Treat a deferral that lasts more than 1 h as an owner alert.
5. *Future:* add a commit-charge check and a per-worker job-object memory cap. Neither is implemented today.

## 5. Verdict
- **Supervisor footprint:** small (≈ 30–150 MB) and stable.
- **Recovery and latency:** good.
- **Main risk:** host memory, not V2 code. V2 adds a working, tested gate, but **with its default thresholds on this host it will defer almost all work**. The owner must choose (a), (b) or (c) before relying on V2 to make progress.
