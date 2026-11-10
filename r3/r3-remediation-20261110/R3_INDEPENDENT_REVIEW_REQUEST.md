# R3 independent review request (2026-11-10)

For a separate session/person. Read-only. The goal is a decision on whether r3 is a sound **reviewable candidate** — not
an installation authorization, which remains the owner's and is out of scope here.

## Scope and ground rules

- Review **only** the r3 scripts and tests at the frozen hashes below. Do not run any `-Apply`, nothing elevated, and no
  ACL/account/task/firewall/secedit/diskpart/mountvol change. Do not sweep E:\ or F:\ recursively.
- Permitted: SHA-256 hashing; `tests\Test-R3.ps1` (non-elevated); pure-function experiments dot-sourcing `_common.ps1`
  against synthetic SDDL; junction experiments inside your own scratch dir; read-only ACL/task/firewall/listener queries.
- Treat the r2 review as the baseline; confirm each r2 ID is addressed as `R2_REVIEW_FINDING_MATRIX.md` claims, and hunt
  for **new** defects introduced by r3.

## Hashes under review

The per-file list is `admin-scripts-r3-20261110\REVIEW_SHA256SUMS`. Verify every `*.ps1` matches it, then verify the
manifest hash:

```
MANIFEST_HASH (SHA-256 of SHA256SUMS) = a4ccaababf552b7aa289d5856ef32df93ee83d726646cfbeb9b63804c5f10c9b
```

Obtain this hash from this document (the hand-back), **not** from any file on E:\. `REVIEW_SHA256SUMS` and these docs sit
on E:\, which every Authenticated User can write; compare against the list you were handed, not against the files.

Also under review: `tests\Test-R3.ps1`, `tests\Fixture-AclCases.ps1`, `tests\r2-baseline-check.ps1` (hashes in
`EVIDENCE_MANIFEST.sha256`).

## What to check hardest

1. **B1 is actually fixed, not just relabelled.** Confirm `Get-ElvAclClassification` flags inherit-only broad ALLOWs and
   protected-with-inherit-only-broad DACLs, with your own synthetic SDDL. Confirm the `r2-baseline-check.ps1` child
   reproduces the **old** blindness on the same fixture. Try to construct an exposing ACL the r3 classifier still
   misses (e.g. conditional ACEs, callback ACEs, unusual generic-right encodings, SIDs outside the broad set that a
   real worker token would carry).
2. **The model is honestly bounded.** Verify r3 never claims the custom evaluator equals the Windows access check, and
   that the `06` gate's G5 requires the per-object verification, not the sentinel sample. Check the gate fails closed on
   every missing input (no deny-targets.json, no verify-complete.json, stale verify, shadow UNKNOWN, stale firewall SID,
   layout FAIL).
3. **H2 trust anchor.** Confirm `-Apply` cannot succeed from an owner-writable copy or without the correct out-of-band
   manifest hash, and that the canonical-manifest check blocks a reordered/CRLF `SHA256SUMS`. Look for a path that
   reaches a privileged action before `Assert-ElvTrustedScriptLocation`.
4. **New r3 surface.** The new code paths are: the state records (`deny-targets.json`, `identities.json`,
   `verify-complete.json`, chunk records) consumed by the gate and rollback — can a non-administrator forge one to open
   the gate? (They live under the owner profile; the owner writes them non-elevated. Assess.) The `-HostRules` global
   firewall blocks. The OWNER RIGHTS ACE on `spool\requests`. The `Invoke-ElvWalk` junction handling.
5. **Residuals are residuals.** Confirm H3 (BITS/DNS/loopback), M9 broker-side enforcement, M11 memory/process cap, and
   I3 (agent-as-owner can write approvals) are left open and labelled, not quietly closed.

## Known limits r3 states about itself (do not treat as defects unless mis-stated)

- No `-Apply` path has run; all fixes are proven by unit tests and synthetic fixtures.
- OS-level isolation is not demonstrated; acceptance needs the real worker token.
- The scripts cannot self-verify (the owner eye-compares hashes in the elevated shell).
- The state records are owner-writable non-elevated — assess whether the gate should additionally require the state dir
  be admin-only, and whether a non-elevated owner process could forge `verify-complete.json`. (This is the most likely
  real r3 weakness; call it if you see it.)

## Deliver

A verdict (candidate sound / changes required), counts by severity, and a finding table in the r2 format (ID, severity,
location, defect, failure scenario, fix, C/P). Hand back your approved `SHA256SUMS` and manifest hash out of band so the
owner can freeze against them.
