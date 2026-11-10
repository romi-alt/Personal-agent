# R2 review finding-to-fix matrix (r3, 2026-11-10)

Every ID from `admin-scripts-r2-20261110\INDEPENDENT_REVIEW_R2.md` (1 blocker, 5 high, 11 medium, 12 low, 4 info),
with root cause, remediation in r3, the regression test that locks it, and residual risk. r3 scripts live in
`admin-scripts-r3-20261110\`; the frozen hashes are in that folder's `REVIEW_SHA256SUMS`.

**Disposition legend.** FIXED = corrected in code and covered by a passing test. FIXED (unexercised) = corrected, but
the `-Apply` path that would exercise it cannot run without admin + the live objects. DESIGN = resolved by a design
change + a recorded acceptance test that must be run on the real account. DEFERRED = not resolved in r3; documented and
left open with a reason. Nothing is silently marked resolved.

## Phase 1 — preserved evidence

The reviewed r2 artifacts are unchanged on disk. Their SHA-256 at r3 time (also in `EVIDENCE_MANIFEST.sha256`):

```
126d700c680db0bc6b6475b3e8a8d66f96967193426f7e45f589181e27fafec4  00-isolation-group-deny.ps1
7c966d07e8f6df45c0e08baa910812327f5fe08c7253e2eb82b46dcf79766475  _common.ps1
cb5f37e8e3e9b9501c3eb14a4fb8393b9477c495456e1376b347599c3edd43c8  tests\Test-R2.ps1
aab48cd43bb313f6ce6c3c65c12b6722d86ddff84b659fd33b3e34bbf059ae43  INDEPENDENT_REVIEW_R2.md
f9309df449055601276e4c7f06a8077bed7f48b8446c7ff670d254fd5b22c097  REVIEW_SHA256SUMS
```

(The full r2 list is in `EVIDENCE_MANIFEST.sha256`.) The independent review was not altered. r3 is a separate folder.

## BLOCKER

| ID | Root cause | Remediation (r3) | Regression test | Residual |
|---|---|---|---|---|
| B1 | The sweep's `$explicitBroad` filter had `-not $_.InheritOnly`, and the protected-DACL test used `Get-ElvEffectiveMask`, which skips inherit-only ACEs. An explicit `Everyone:(OI)(CI)(IO)F` on a folder (or a protected DACL whose only broad ACE is inherit-only) produced **no finding**, yet its children inherit that allow **ahead of** the root group DENY and are fully exposed. | `Get-ElvAclClassification` (pure, SDDL-testable) classifies on the DACL: any **non-inherited** broad ALLOW counts, **including inherit-only**; a protected DACL with **any** broad ALLOW (inherit-only included) counts; NULL DACL counts. The old `-not InheritOnly` filter is gone. | `Test-R3.ps1` §F: `B1 OLD filter misses…` reproduces the rejected behaviour; `B1 NEW classification flags it…`. §G on-disk: `sweep r3: X … -> explicit-broad-allow`, and the r2-baseline subprocess (r2's verbatim filter, hash `126d700c`) run on the same fixture shows **X NOT flagged** while r3 flags it. The reviewer's Full-access counterexample is `real\X\c.txt`: `V3: X\c.txt EXPOSED` and `REAL: real\X\c.txt open-for-read ALLOWED despite the ancestor DENY`, failing the old logic and passing the new. | A custom evaluator is **not** the Windows access check. r3 does not claim it is. Final acceptance requires real-token access checks under the worker identity (ADVERSARIAL_ACCEPTANCE_MATRIX.md). See BLOCKER_ROOT_CAUSE_AND_FIX.md and ACL_INHERITANCE_REGRESSION.md. |

## HIGH

| ID | Root cause | Remediation (r3) | Test | Disposition |
|---|---|---|---|---|
| H1 | Verification was sentinel-only (a DENY ACE on ~9 paths). Nothing re-evaluated every object after the DENY. | New `00 -Verify` / `-Verify -Finalize`: per-object pass (`Invoke-ElvObjectVerify`) requiring the modelled worker-token mask = 0 on every item, chunkable, state-recorded. `06` gate item **G5** requires a `verify-complete.json` that is complete and newer than the apply, matched to the apply `ref`. | §G `V3:*` (exposed/not-exposed per object); §K `06 gate … G5 … FAIL closed`. | FIXED; the full-tree run is FIXED (unexercised) until the elevated apply. |
| H2 | R-7 was self-attesting: `SHA256SUMS` beside the scripts, written by the same non-elevated process; `-ApprovedSums` optional; the frozen copy owner-writable (the production task runs as the owner, Limited). | Trust anchor is an **out-of-band** manifest hash (`-ApprovedManifestHash`, mandatory for `-Apply`). `Assert-ElvTrustedScriptLocation` requires the folder, every script and `SHA256SUMS` to be **admin-only writable** (owner SID counts as a writer) and owned by SYSTEM/Administrators, a **canonical** `SHA256SUMS`, and the out-of-band hash to match. `Freeze-AdminScripts.ps1` is elevated, mandatory `-ApprovedSums`, sets an admin-only DACL and `/setowner Administrators`. | §H (owner-writable copy → WARN in dry-run, refused for apply; missing/wrong hash recorded; tampered script → hash mismatch; non-canonical SUMS refused; Freeze refuses non-elevated). | FIXED. The scripts cannot verify themselves (the owner compares hashes by eye in the elevated shell before running); this is documented, not automated. |
| H3 | Per-SID firewall rules do not match egress delegated to system components (SMB redirector/System, WebDAV/WebClient, BITS/SYSTEM, loopback, DNS). | `05 -HostRules` adds **global** blocks for the SMB redirector (`Program=System`, 445/139) and WebDAV (`Service=WebClient`) to non-LAN; profiles-enforcing check added; BITS, DNS and loopback recorded as residuals with named acceptance tests (AT-H3-BITS, AT-73/78, AT-76). | NETWORK_DELEGATION_RISKS.md; §L dry-run of `05 -HostRules`; §I firewall-profile predicate. | DESIGN + DEFERRED: the global blocks are new global state needing their own authorization; BITS impersonation and loopback must be tested on the real account. |
| H4 | The `06` gate checked only firewall DisplayName + Enabled, not the current worker SID; "layout" was only `Test-Path work\`. | `Test-ElvWorkerFirewallRule` (pure) requires the `LocalUser` SDDL to name **exactly** the current worker SID, enabled, outbound, Block, with an exact address-set compare. Gate **G6** re-runs `Test-ElvLayout` (0 FAIL) and **G7** binds to the current SID and checks profiles enforcing. | §I (stale SID rejected, current accepted, substring rejected, exact address set); §K (gate FAIL closed). | FIXED. |
| H5 | Shadow copies of E:/F:/C:/D: keep the pre-DENY ACLs; r2 never looked. | `Get-ElvShadowCopies` (fail-closed: throws UNKNOWN when not elevated); `00 -ListShadows`, a pre-flight record in `00 -Apply`, and `06` gate **G8** fail closed on any DENY-target shadow older than the apply. | §I (`Get-ElvShadowCopies` throws UNKNOWN non-elevated; gate throws); §K (`06 gate … G8 … UNKNOWN`). | FIXED (unexercised): enumeration/deletion needs elevation; deleting shadows is a separate authorization. |

## MEDIUM

| ID | Root cause | Remediation (r3) | Test | Disposition |
|---|---|---|---|---|
| M1 | `& icacls … 2>&1` under `EAP=Stop` threw on the first stderr line before the exit code was read; no `try/finally` saved a report on failure. | `Invoke-ElvIcacls` sets `EAP=Continue` around the native call, then checks the exit code and "Failed processing N" count. Every script has `trap { Save-ElvReport $report $_ ; break }`; `Initialize-ElvRun` saves before refusing. | §G (`M1: icacls failure … captured`; `M1: trap saves the report …`). | FIXED. |
| M2 | ACL backups overwritten each run; full `/save` exit unchecked. | `Backup-ElvAcl`: timestamped copies; the **first** root SDDL kept as `baseline-root.sddl` and never overwritten; existence check; full `/save` exit checked. `09` RB2 compares against the baseline. | §G (`M2: second backup run keeps the FIRST baseline …`; `M2: full-tree backup failure … is an error`). | FIXED. |
| M3 | `-AdditionalDenyPaths` could "cover" any finding, including unlistable/unreadable/null-dacl. | Only `explicit-broad-allow` / `protected-with-broad-access` are coverable; `Assert-DenyTarget` now checks the entry is a coverable finding of the current sweep; unlistable/unreadable/null-dacl must be **resolved**. | §B (`L1/M3 listed extra accepted ONLY when … a coverable sweep finding`). | FIXED. |
| M4 | A pre-existing `elv-stg-worker`/`elv-stg-broker` was adopted without checking membership/origin; I1 was a check, not a gate. | `02` adopts a pre-existing account only if its description matches, it is disabled, and its groups are a subset of {Users, deny group}; else `-Apply` throws. `03`/`04`/`06` gate on "not an administrator, in the deny group". | §L dry-run of `02`; gates in §K. | FIXED (unexercised for the create path). |
| M5 | No owner set/verified on the staging folders; a pre-existing empty folder was accepted. | `01` sets `/setowner Administrators` on both folders and the volume root; refuses a pre-existing folder that is a reparse point, non-empty, or not owned by SYSTEM/Administrators; `07` checks owners. | §L dry-run `01`; `07` C01.6/.7/.8 (needs the mounted volume). | FIXED (unexercised). |
| M6 | Firewall replace removed all rules then recreated one by one. | `05` refuses while the worker is enabled or has processes; creates `<name>.new`, verifies, removes old, renames; profiles-enforcing check. | §L dry-run `05`; §I predicate. | FIXED (unexercised for the live replace). |
| M7 | `09` removed only three tasks; no check that processes were gone; firewall removed before account deletion. | `09` enumerates tasks by staging-identity principal, re-queries processes after Stop and throws if any remain, removes firewall **after** account deletion, refuses any task that runs as the owner. | §L dry-run `09` (both variants). | FIXED (unexercised for the live stop). |
| M8 | `09` did not know the applied `-AdditionalDenyPaths` or identity SIDs; no persisted state; user-rights removal unverified. | State records under `<AdminDir>\state`: `deny-targets.json` (00), `identities.json` (02); `09` reads both (so deleted accounts' SIDs still match) and re-exports rights to assert no staging SID remains. | §G (chunk record round-trip, coverage); §I. | FIXED. |
| M9 | `spool\requests` granted the worker `W:(OI)(CI)` (add-subdirectory, write-own-files, implicit WRITE_DAC as owner); the worker could edit a request after validation or plant junctions. | Layout: `spool\requests` worker = `WD-this` (add-file only, this folder) plus an inheritable OWNER RIGHTS `S-1-3-4:(OI)(IO)(RC)` ACE so creators get **no** implicit WRITE_DAC/read on their own files; broker = `M`; broker `bin` is admin-write-only; broker `RX+D` on approvals (consume). The broker contract (move-before-parse, reject reparse points, verify owner SID) is stated in `04`. | §E (spec semantics); §G on-disk (`M9: creator can write a NEW request`, `… can NOT reopen … for write`, `… can NOT read it back`, `… can NOT change the DACL`, `… can NOT list the request directory`). | FIXED at the ACL level. The broker's own open-with-reparse-reject and approval-owner-SID check are **code work in the broker release**, enforced by review of that release, not by these scripts. |
| M10 | `09` archived `broker\state` with `Copy-Item -Recurse`, which follows junctions. | `09` uses `robocopy /E /XJ` (never follows junctions); exit code checked. | Code; §L dry-run `09` names the robocopy path. | FIXED (unexercised for the live archive). |
| M11 | No worker disk/process/memory cap; `$RECYCLE.BIN` excluded from the sweep and the DENY. | `E:\$RECYCLE.BIN` / `F:\$RECYCLE.BIN` are DENY targets; `02 -VolumeQuotaMB` sets NTFS quotas per identity on every fixed NTFS volume; the worker launcher (admin-only `bin\`) is the place for a Job Object memory/process cap; `System Volume Information` is reported as a `skipped-root` row, never silently excluded. | §B (`$RECYCLE.BIN` accepted); §J (`$RECYCLE.BIN` grants Users add-subdir today); §L dry-run `02 -VolumeQuotaMB 2048`. | FIXED for disk (quotas) and the recycle bins. Memory/process cap is DEFERRED to the Job Object launcher (not yet written). |

## LOW

| ID | Root cause | Remediation (r3) | Test |
|---|---|---|---|
| L1 | `GetFullPath` accepted `\\?\`, `\\.\`, admin-share UNC; `-Additional` self-authorising. | `Get-ElvCanonicalPath` refuses UNC/device forms and non-drive paths; `Assert-ElvNoReparseInPath`; `-Additional` must be a coverable sweep finding. | §B (device/UNC refused; self-authorising C:\Windows refused). |
| L2 | `while ($set -contains $e) { $set.Remove($e) }` hangs on a case mismatch. | Removal rebuilds the list with a case-insensitive filter (terminates). | §D (`L2 remove with case mismatch terminates`, run in a timed job). |
| L3 | Empty-right line after removal not verified. | `Invoke-ElvRightsChange` re-exports after `/configure` and asserts every add/remove; `09` RB0 asserts no staging SID remains. | §D; §G (rights re-export in the mocked parse). |
| L4 | `Get-LocalGroupMember … -EA SilentlyContinue` fails open on orphaned SIDs. | `Get-ElvGroupMemberSids` via ADSI throws on any error (fail closed). | §I (`non-existent group THROWS`). |
| L5 | `BroadSids` omitted NTLM, asserted-identity, NETWORK, SERVICE, Guests, RDP SIDs. | Added all of them; `Get-ElvTokenSidSet` also folds in SIDs captured from the real worker's `whoami /groups`. | §F (`L5 broad SIDs include …`); §G (captured-token CSV adds SIDs, filters integrity SIDs). |
| L6 | `IPAddress.Parse` read `010` as octal; `0.0.0.0/0` gave an empty block set. | Strict CIDR regex (no leading zeros); empty complement refused. | §C (octal rejected; empty complement refused). |
| L7 | `Test-ElvSpec` could not tell `RX-this` from inheritable `RX`; inherit-only broad ACEs on containers ignored. | `Test-ElvLayout` adds **L0b** (no broad ACE of any kind, inherit-only included) and **L4** (each identity ACE carries the expected inheritance flags). | §G (`L7: Test-ElvLayout passes …` incl. the negative inherit-only case). |
| L8 | Ran `git.exe` elevated over the lower-integrity production repo. | `Get-ElvGitHead` reads `.git\HEAD`/refs/`packed-refs` directly; no git invocation. | §I (`I2/L8 … no git.exe`; `Get-ElvGitHead … e60278f`). |
| L9 | N3 passed with any ≥1 address; N2 substring SID match. | Exact address-set compare; exact `(A;;CC;;;<SID>)` token match. | §I (exact address set; substring SID rejected). |
| L10 | No `nodefaultdriveletter`; mountvol without a trailing backslash. | `01` adds `attributes volume set nodefaultdriveletter`, mounts/unmounts with a trailing backslash; `07`/`01` check the volume has no drive letter. | §L dry-run `01`; `07` C01.5 (needs the volume). |
| L11 | `Dismount-DiskImage -EA SilentlyContinue` hid a failed detach. | `09` detaches with `-ErrorAction Stop`. | Code; §L dry-run `09`. |
| L12 | Re-running `03` over worker-planted junctions. | `03` refuses when any reparse point exists under a worker-writable dir (`Get-ElvReparsePointsUnder`). | §L dry-run `03` (L12 check present). |

## INFO

| ID | Disposition |
|---|---|
| I1 | FIXED: `Get-ElvOwnerContext` resolves by the fixed expected owner SID (`…-1001`), never `$env:USERNAME`; a wrong SID throws. §I. |
| I2 | FIXED: the production supervisor is found by command line (`dist\cli\index.js`); no hard-coded PID. The PID is reported, not asserted. §I. |
| I3 | DOCUMENTED (THREAT_MODEL.md §5): the rest of D:\, `C:\Users\Public`, `C:\ProgramData` remain standard-user surface. The production agent (as the owner) can write `spool\approvals`; the broker's owner-SID check cannot distinguish it — recorded as an open broker design item in TRUSTED_INSTALLATION_CHAIN.md and `04`. |
| I4 | FIXED: the broker now gets `RX+D` (read + consume) on `spool\approvals`, not `M`. §E. |

## What is NOT claimed

- OS-level isolation is **not** demonstrated. Every "FIXED" above is a code/configuration fix proven by unit tests and
  synthetic fixtures, not by a real worker token. The gates fail closed, but a PASS from them means "configured as
  designed", never "Windows denies the worker".
- The `-Apply` path (DENY propagation over ~350k objects, diskpart, secedit, account/task/firewall creation, the real
  `00 -Verify` over the live volumes) has **not** been run. It needs admin authorization and a production-idle window.
- Final acceptance requires the real-token adversarial matrix on `elv-stg-worker`, independently reviewed.
