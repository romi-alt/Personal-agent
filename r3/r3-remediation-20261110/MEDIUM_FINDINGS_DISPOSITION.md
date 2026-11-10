# Medium findings disposition M1–M11 (r3, 2026-11-10)

Every medium finding from the independent review, with its disposition. The brief named six as a minimum; all eleven
are addressed. Nothing unaddressed is marked resolved.

## The six the brief named explicitly

| # | Brief wording | r3 |
|---|---|---|
| M1 | Correct command exit-code handling before output pipelines obscure failures | `Invoke-ElvIcacls` runs the native call under `EAP=Continue`, then checks `$LASTEXITCODE` and the "Failed processing N" line. The r2 bug was that `2>&1` under `EAP=Stop` threw on the first stderr line **before** the exit code was read. FIXED; tested (`M1: icacls failure … captured`). |
| M4 (reports) | Save structured reports on failure | Every script installs `trap { Save-ElvReport $report $_ ; break }`; `Initialize-ElvRun` saves before refusing. A failed `-Apply` now always leaves a JSON report with `error` set. FIXED; tested (`M1: trap saves the report …`). |
| M2 | Prevent reruns from destroying original ACL backups | `Backup-ElvAcl` keeps the **first** root SDDL as `baseline-root.sddl`, never overwritten; later runs add timestamped copies; the full `/save` exit is checked; `09` RB2 compares against the baseline. FIXED; tested (`M2: second backup run keeps the FIRST baseline …`). |
| M3 | Prevent AdditionalDenyPaths from concealing unreadable or malformed ACLs | Only `explicit-broad-allow` / `protected-with-broad-access` are coverable; `unlistable`/`unreadable`/`null-dacl` must be **resolved**; `Assert-DenyTarget` checks the entry is a coverable finding of the current sweep. FIXED; tested (`L1/M3 listed extra accepted ONLY when … coverable`). |
| M10 (+ M7) | Make cleanup and rollback reject junction/reparse-point escapes | `09` archives with `robocopy /E /XJ` (never follows junctions), unlinks reparse points under a folder before deleting it (`rmdir` on the link, never the target), refuses path components that are reparse points, and refuses any task that runs as the owner. FIXED (unexercised for the live run); the junction-safe walker is covered in §G. |
| M11 | Define enforceable worker disk, process and memory limits | **Disk:** `E:\$RECYCLE.BIN`/`F:\$RECYCLE.BIN` are DENY targets; `02 -VolumeQuotaMB` sets NTFS quotas per identity on every fixed NTFS volume; the staging VHDX caps the worker's main store. **Process/memory:** Windows has no per-user RAM quota without a Job Object; the admin-only worker launcher (`bin\run-worker.ps1`, not yet written) is the enforcement point, and `06` gate G9 requires `bin\` to be admin-only. Disk is FIXED; memory/process is DEFERRED to the Job Object launcher, stated plainly. |

## The other five

| # | Finding | Disposition | Test |
|---|---|---|---|
| M5 | No owner set/verified on the staging folders; a pre-existing empty folder accepted | FIXED (unexercised): `01` `/setowner Administrators` on both folders and the volume root; refuses a pre-existing reparse point, non-empty, or non-SYSTEM/Administrators-owned folder; `07` checks owners. | §L dry-run `01`; `07` C01.6/.7/.8 on the mounted volume. |
| M6 | Firewall replace not atomic | FIXED (unexercised for the live replace): `05` refuses while the worker is enabled or running; creates `<name>.new`, verifies, removes old, renames. | §L dry-run `05`; §I predicate. |
| M7 | `09` removed only three tasks; no process-gone check; firewall before account deletion | FIXED (unexercised for the live stop): `09` enumerates tasks by staging-identity principal, re-queries processes after Stop and throws if any remain, removes firewall **after** deleting the accounts. | §L dry-run `09`. |
| M8 | `09` did not know the applied deny paths or identity SIDs; rights removal unverified | FIXED: state records `deny-targets.json` (00) and `identities.json` (02); `09` reads both (deleted accounts' SIDs still match) and re-exports rights to assert no staging SID remains (RB0). | §G (chunk/state round-trip); §I. |
| M9 | `spool\requests W:(OI)(CI)` let the worker edit a request post-validation and plant junctions; broker confused-deputy | FIXED at the ACL level: worker = `WD-this` (add-file only) + OWNER RIGHTS `S-1-3-4:(OI)(IO)(RC)` (no implicit WRITE_DAC/read on own files); broker `RX+D` (consume) on approvals; broker `bin` admin-write-only. The broker's **own** move-before-parse, reparse-point rejection and approval-owner-SID check are code work items enforced by review of the broker release (stated in `04`). | §E spec; §G (`M9: creator can write a NEW request`, `… can NOT reopen … for write`, `… can NOT read it back`, `… can NOT change the DACL`, `… can NOT list the request directory`). |

## Items left open on purpose (DEFERRED), with reason

- **M9 broker-side enforcement.** The ACLs stop the worker from tampering with its own request through the filesystem,
  but the broker process must still open requests with reparse-point rejection, move each request into a broker-only
  directory before parsing, and verify the approval file-owner SID. There is no broker service entrypoint yet
  (`04` stops at release verification by design), so this is enforced by review of that release, not by r3.
- **M11 memory/process cap.** Needs a Job Object in the worker launcher, which is not written. Disk is capped; RAM and
  process count are not, and the review's residual stands.
- **I3 (info, related).** The production agent runs as the owner and can write `spool\approvals`; the broker's owner-SID
  check cannot distinguish it from the human owner. Recorded as an open broker design item.

## Not done, not hidden

No medium finding is marked resolved without either a passing test or an explicit "unexercised"/"deferred" label above.
The `-Apply` paths (ACL propagation, diskpart, secedit, account/task/firewall creation, the live archive and stop) have
not been executed; their fixes are proven by dry-runs, structured-report assertions, and synthetic fixtures only.
