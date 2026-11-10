# Admin scripts r2 (2026-11-10): revision per ISOLATION_IMPLEMENTATION_PLAN.md §R (A1)

**Status: REVISED and TESTED OFFLINE (dry-run). Not yet independently reviewed. Not frozen. Nothing applied.**
The r1 scripts in `E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts\` are **unchanged** and
**superseded: do not run them.**

## Run order (each `-Apply` is a separate owner authorization, elevated, from the FROZEN copy)

| Script | Authorization | What it does |
|---|---|---|
| `Freeze-AdminScripts.ps1` | A1, after review; owner, non-elevated | Copies the scripts to `%USERPROFILE%\ElevariqAdmin\scripts-r2-<ts>\` and writes `SHA256SUMS` there |
| `00-isolation-group-deny.ps1 -Sweep` | A2 (read-only) | File and directory sweep for anything that would defeat an inherited DENY |
| `00a-remove-test-residue.ps1` | A3 | Removes exactly 3 residue ACEs (Everyone:F on `isotest\outside`; AppContainer SID on 2 directories) |
| `00-isolation-group-deny.ps1 -Apply` | A2 + A4 + **A5 (production volume ACLs)** | ACL backups, mandatory sweep, empty group, explicit inheritable DENY on `E:\ F:\ C:\Download C:\Intel D:\src D:\Intel`, verification |
| `01-staging-volume.ps1` | A6 | 40 GB expandable VHDX mounted at `C:\ElevariqStaging`; protected root; SYSTEM attach-at-boot task |
| `02-identities-and-rights.ps1` | A7 + A8 | `elv-stg-worker` and `elv-stg-broker` created **disabled** with unstored random passwords; Users + deny group; user rights |
| `03-staging-layout.ps1` | A6/A9 prep | work/home/broker/spool/decoys ACLs, verified per SID |
| `04-broker-install.ps1 -ReleaseDir …` | A9 | Hash-verified broker release copied into `broker\bin`; task registered under `elv-stg-broker` (not started) |
| `05-firewall-egress.ps1 [-AllowIPv4Cidrs …]` | A10 | Worker-SID block on everything except loopback and approved CIDRs (IPv4 and IPv6) |
| `06-worker-enable.ps1 -Mode enable-for-login` → `lockdown` → `register-task` | A11 + A12 | **Hard isolation gate**, then the worker's own Claude login, deny-interactive, then the S4U task (not started) |
| `07-verify-config.ps1` | read-only | Configuration checks. **Not access tests.** |
| `09-rollback.ps1 [-IncludeProductionDeny]` | rollback | Reverse of everything. Removing the production DENY is opt-in and runs after the identities are deleted |

Prerequisites are enforced in code. Each script refuses `-Apply` unless the previous stage is in place, and `06` refuses to enable or run the worker unless the group DENY, group membership, layout and firewall rules are all present.

## §R items, and where each is fixed

| ID | r1 defect | r2 fix |
|---|---|---|
| R-1 | No production DENY; the worker could be enabled while E:\ was AU-writable | `00`: group-based, idempotent, with sweep, backups and verification. `06` gate blocks enabling the worker without it |
| R-2 | `C:\ElevariqStaging` was a plain folder inheriting **AU:Modify** from `C:\` | `01`: VHDX volume. Mount folder and volume root are both protected; the explicit broad ACEs a fresh format adds are stripped; check that no broad group has **any** access |
| R-3 | Account created **enabled**, outside any deny group; owner-DPAPI credential file | `02`: both identities **disabled**, in the group before any enable, passwords never stored |
| R-4 | G3/G4 regex `"$script:X:\(N\)"` → `\(N\)` (matches any principal); icacls-text checks | `03`/`07`: ACEs parsed by SID and evaluated per token SID set; labelled configuration-only. The bug is reproduced in a test |
| R-5 | Block-beats-allow made all egress fail; host name in `RemoteAddress`; errors unchecked | `05`: block only on the complement; CIDRs validated; `-ErrorAction Stop`; rule and filter verification |
| R-6 | Broker ran as the owner (admin) | `04`: broker runs as `elv-stg-broker`; code dir is admin-write-only; Password logon so its own DPAPI key works |
| R-7 | Scripts ran from AU-writable E:\ | `Initialize-ElvRun` → `Assert-ElvTrustedScriptLocation`: `-Apply` throws unless no broad group can write the folder or any script **and** every file matches `SHA256SUMS`. `Freeze-AdminScripts.ps1` produces such a copy |
| R-8 | Rollback ignored group, DENY, VHDX, broker, rights | `09`: all of these; audit chain archived; compares the root SDDL with the `00` backup |

Also fixed: the D2 idempotency rules (no stacked ACEs or rules on re-run); icacls exit codes checked everywhere; staging-path guards, now covering the disk dir; production, owner `.claude` and production home refused in every script.

## Chunked sweep (added after the first full `-Sweep` was killed for low system memory)

`00 -Sweep -SweepRoots <paths>` sweeps only the given paths. It is read-only and refuses `-Apply`, refuses without `-Sweep`, and refuses any path not under a DENY target. Each chunk root is checked as well as everything below it. Findings now stream to the CSV instead of being held in memory. A chunk sweep is evidence only: `-Apply` still runs the full mandatory sweep itself.
The sweep also reports `null-dacl`, `unlistable` (a directory whose contents could not be enumerated; formerly hidden by `SilentlyContinue`) and `reparse-point` (junctions and symlinks are not followed; reported with their target). The first two block `-Apply`; reparse points are a WARN for review.
Full run 2026-11-10: 39/39 chunks, 347,509 items, 8 findings. See `permissions-assessment-20261110\SWEEP_REPORT_20261110.md`.

## Tests (`tests\Test-R2.ps1`, non-elevated, no system changes): **70/70 PASS** (67 + 3 `-SweepRoots` guards)

The suite covers:
- path guards, including the `C:\ElevariqStagingEvil` prefix trap, `..` escape, production, owner `.claude` and production-home paths;
- deny-target allow-list;
- IPv4 complement maths (merge, unaligned, invalid, host name);
- user-rights INF add, remove and idempotency;
- spec semantics;
- R-4 bug reproduction;
- R-7 refusal from E:\;
- parsing of every script, and dry-runs of every script and mode;
- a **before/after system snapshot**: users, groups, Elevariq tasks, ELEVARIQ firewall rules, `E:\` SDDL, staging dirs, all unchanged;
- production untouched (task Running, PID 8992, HEAD `e60278f`).

Output: `tests\test-r2-output.txt`. Dry-run logs: `tests\dryrun-logs\`.

## Known limits (honest)

- **No elevated or `-Apply` path has been executed.** The following run only under `-Apply` and are therefore unexercised: secedit configure, diskpart, `New-NetFirewallRule`, account creation, task registration.
- **`04` cannot succeed yet, by design.** The repo has the broker *library* but no service entrypoint, spool transport, DPAPI key wrapper or egress proxy. Those are code work items that need their own review.
- **With no `-AllowIPv4Cidrs` and no proxy, the worker has no internet.** The Claude CLI then cannot work. The provider's ranges must be verified from its published list at apply time.
- **The VHDX mount point after a reboot needs confirming** (`07` `C01.1` after a restart).
- **`07` PASS means "configured as designed", not "Windows denies the worker".** OS-level isolation is still **not demonstrated**. That needs the real-account adversarial matrix and an independent review.
