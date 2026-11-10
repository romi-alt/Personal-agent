# Read-only ACL sweep: consolidated security report (2026-11-10)

> **CORRECTION (independent review, INDEPENDENT_REVIEW_R2.md, finding B1).** The sweep ignored **inherit-only** broad ALLOW ACEs, and protected DACLs whose only broad access is inherit-only. These reach child objects **ahead of** the inherited group DENY. "No other explicit broad allow / protected-with-broad-access" below is therefore **NOT established**. The 8 findings listed are real, but the list may be incomplete. The status is downgraded to **READ-ONLY AUDIT INCOMPLETE** until the sweep is re-run with the fixed logic. The coverage, stability and production figures still stand.

**Verdict: READ-ONLY AUDIT COMPLETE (scope below, non-elevated; 2 directories need an elevated recheck).**
**OS ISOLATION VERIFIED: NO.** No worker account exists. Nothing here was tested with a real restricted token.
Every statement below is **broad-group ACL exposure** evaluated over the DACL for these SIDs: Everyone, Users, Authenticated Users, This Organization, Local account, LOCAL, INTERACTIVE and BATCH. It is **not** proof that a real worker would be allowed or denied. That needs the real-account adversarial matrix (ADVERSARIAL_ACCEPTANCE_MATRIX.md) after provisioning.

No ACL, account, task, firewall rule or production service was changed. Nothing was pushed or deployed.

## 1. Coverage

| Scope | Result |
|---|---|
| DENY targets `E:\` `F:\` `C:\Download` `C:\Intel` `D:\src` `D:\Intel` | **39/39 chunks complete**, **347,509 items** (dirs + files), 0 timeouts, 0 kills, 0 aborts |
| Sensitive locations outside the targets (owner profile, credential stores, production DB/audit) | 31 paths checked (`evidence\sweep-20261110\sensitive-paths-20261110.csv`), walk capped at 3,000 items per path |
| Excluded by design | `$RECYCLE.BIN`, `System Volume Information`, the 6 target-root ACLs themselves (in the `icacls-*-root.txt` baselines) |
| **Not covered** | Contents of `C:\Intel\IntelOptaneData` and `D:\Intel\IntelOptaneData` (unlistable without elevation). Not in scope: the rest of `C:\`, `ProgramData`, the registry, services, named pipes. The escalation surface of those is in EFFECTIVE_PERMISSIONS_AUDIT.md. `%LOCALAPPDATA%\ElevariqAgent` walk hit the 3,000-item cap |

Per-chunk summaries (items, findings, unreadable, unlistable, reparse, seconds, peak MB, exit) are in `evidence\sweep-20261110\coverage.csv` and `driver.log`. `peak=0MB` means the chunk ended before the first 2-second sample.

## 2. Paths requiring protection BEFORE worker-account provisioning (prioritised)

| # | Priority | Path | Finding | Why it matters | Required action (authorization) |
|---|---|---|---|---|---|
| 1 | **P0** | `E:\` and `F:\` (whole volumes) | Every production item checked is **broad-writable**: `.env`, `.git\config`, `.git\hooks` (14/14), `.npmrc`, `scripts\windows\run-supervisor.ps1`, `dist` (194/194), `node_modules\better-sqlite3` (77/77), admin scripts r2 (132/132), broker source (7/7), `E:\Agent\.claude`, `v2-staging\hardening`, `pilot-evidence` | AU:Modify is inherited everywhere. `run-supervisor.ps1` runs **as the admin owner** from the production task, so a write there means privilege escalation | Group DENY on the targets via `00 -Apply` (**A2 + A4 + A5**) |
| 2 | **P0 (blocks the DENY)** | `E:\Agent\v2-staging\hardening\isotest\outside` | **Explicit** `Everyone:F` (0x1F01FF) | An explicit allow beats an inherited DENY, so this folder would stay fully open to the worker | Remove with `00a-remove-test-residue.ps1` (**A3**) |
| 3 | **P1 (blocks the DENY)** | `C:\Intel\GfxCPLBatchFiles` and `D:\Intel\GfxCPLBatchFiles` | **Explicit** `Authenticated Users` 0x1200E9 = **RX + Delete-child** | Same override. The worker could read and run these files and delete files inside the folder | Give each its own explicit DENY: `00 -Apply -AdditionalDenyPaths 'C:\Intel\GfxCPLBatchFiles','D:\Intel\GfxCPLBatchFiles'` (**A5**). An explicit DENY sorts before the explicit allow |
| 4 | **P1 (coverage gap)** | `C:\Intel\IntelOptaneData` and `D:\Intel\IntelOptaneData` | ACL unreadable and folder unlistable for the non-elevated owner | Probably restricted to SYSTEM/Admins (which would mean no worker exposure), but **unverified**. `00 -Apply` refuses while they are open | Elevated `00 -Sweep -SweepRoots` of these 2 paths from the frozen copy (**A2, read-only**) |
| 5 | P2 (review) | `E:\Agent\v2-staging\worker-isolation\fixtures\qa-deputy\ws\leakdir` | Junction pointing to `...\fixtures\qa-deputy\owner-only`, **inside** E:\ | Test fixture. Its target is under the E:\ DENY, so the DENY covers it. Not followed by the sweep | None required. Remove when the QA fixture is retired |
| — | OK | Owner profile: `.claude` (+ `.credentials.json`), `.claude.json`, `.claude\projects`, `%LOCALAPPDATA%\ElevariqAgent` (agent.db, backups, logs), DPAPI `Protect`, both `Credentials` stores, `Vault` | No broad read/write and no explicit broad allow. 0 broad-writable items walked | The protected profile ACL keeps broad groups out. These are not DENY targets, so they rely on staying that way | Keep the profile ACL unchanged. Re-run `Check-SensitivePaths.ps1` before enabling the worker |
| — | n/a | `.ssh`, `.git-credentials`, `.gitconfig`, `GitHub CLI`, `ElevariqAdmin` | Do not exist | `ElevariqAdmin` is created by `Freeze-AdminScripts.ps1` under the protected profile | — |

**File-level result:** the sweep looked at files as well as folders. Apart from #2 and #3, it found **no** explicit broad allow, **no** protected DACL that still grants broad access, and **no** NULL DACL anywhere in the 347,509 items.

## 3. Production stability during the audit

| Check | Result |
|---|---|
| Production supervisor | PID 8992 alive, task `Running`, heartbeat 0–2 s, status `IDLE`, 0 active or queued tasks, at every probe (before each chunk and every 60 s) |
| Sweep memory | Child peak working set **105–142 MB**. The driver is about 70 MB. Free RAM stayed between **702 and 1,450 MB**, so the 350 MB kill threshold was never reached |
| Memory gate | The production gate (pause below 1,024 / resume above 1,536 MB) **did defer** during the audit window (13:20 at 1,023 MB, 13:35 at 960 MB), as it already did before the audit (10:55 at 846 MB). With 0 queued tasks this held back **no work**. The driver would have paused the sweep while production had queued work. **The audit did add memory pressure.** Any future elevated rerun should be done with production idle |
| Aborted runs | Run 1 (unchunked) was killed by Claude Code for low memory. Run 2 was stopped by me after 1 chunk, to add controls. Neither run changed anything |

## 4. Sweep correctness controls (all verified)

- **Read-only:** `00 -Sweep` writes only `reports\*.csv/json`. `-SweepRoots` refuses `-Apply`, refuses without `-Sweep`, and refuses paths outside the DENY targets (3 tests). Test suite **70/70**.
- **Bounded:** findings stream to the CSV, so memory holds only path and issue. `[GC]::Collect()` runs every 20,000 items. Each chunk is its own process. Per-chunk limit 40 min. Pre-chunk free-RAM gate 600 MB. Kill below 350 MB. Production probe every 60 s. The driver kills only the child PID it started.
- **No overlap:** an exclusive lock file. A second driver was refused (tested).
- **Junctions and loops:** PowerShell 5.1 `-Recurse` does not descend into junctions or symlinks (tested with a self-loop junction: 4 items, no recursion). Reparse points are reported with their target and whether that target is inside a DENY target.
- **Silent errors removed:** enumeration failures are captured with `-ErrorVariable` and reported as `unlistable`. They used to vanish under `SilentlyContinue`. ACL read failures are reported as `unreadable`. `-Apply` refuses on either.
- **Single ACL read per item:** fixes the duplicate `Get-Acl` calls. NULL DACLs (`D:NO_ACCESS_CONTROL`) are now detected; before, they evaluated as "no access".
- **Edit during run (disclosed):** two behaviour-neutral edits to `00` (a whitespace fix, and removing an unreachable duplicate refusal) were saved while chunk 1 was running. Chunk 1 used the earlier text; chunks 2–39 used the final text (`REVIEW_SHA256SUMS`: `00` = `126d700c…`, `_common` = `7c966d07…`).

## 5. Administrator actions still requiring separate authorization (unchanged order)

1. **A1:** independent review of r2 (hashes in `REVIEW_SHA256SUMS`), then `Freeze-AdminScripts.ps1 -ApprovedSums`.
2. **A2 (read-only, elevated):** `00 -Sweep -SweepRoots 'C:\Intel\IntelOptaneData','D:\Intel\IntelOptaneData'` from the frozen copy.
3. **A3:** `00a-remove-test-residue.ps1 -Apply` (removes `isotest\outside` Everyone:F and the 2 AppContainer ACEs).
4. **A2 + A4 + A5 (production volume ACLs):** `00 -Apply -AdditionalDenyPaths 'C:\Intel\GfxCPLBatchFiles','D:\Intel\GfxCPLBatchFiles'` (plus IntelOptaneData if A2 shows broad access).
5. Then A6–A16 as in FINAL_SECURITY_VERDICT.md. **The worker must not be enabled before step 4 is verified.**

## 6. Evidence

`evidence\sweep-20261110\`:
- `driver.log`, `coverage.csv`, `findings-merged.csv`, `sensitive-paths-20261110.csv`;
- `Run-ChunkedSweep.ps1` (driver), `hb.cjs` (read-only production probe), `Check-SensitivePaths.ps1`.

Raw per-chunk CSVs and output are in `admin-scripts-r2-20261110\reports\chunked-sweep-20261110-133420\`. Hashes are in `SWEEP_MANIFEST.sha256`.
