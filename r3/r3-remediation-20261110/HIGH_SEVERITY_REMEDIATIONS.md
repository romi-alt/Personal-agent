# High-severity remediations H1–H5 (r3, 2026-11-10)

Detail for each HIGH finding: what the brief required, what r3 does, and what remains for real-account acceptance.

## H1 — exhaustive policy coverage, not sample-only verification

**Brief:** replace sample-only verification with an exhaustive policy-coverage inventory plus representative real-token
access tests.

**r3:**
- `00 -Verify [-VerifyRoots]` walks **every** object under the DENY targets (not a sentinel sample) and requires the
  modelled worker-token effective mask to be 0. Rows: `exposed` (mask != 0), `unreadable`, `unlistable`,
  `reparse-point` (not followed), `skipped-root`. It is chunkable (one process per top-level folder) and writes a chunk
  record under `<AdminDir>\state`.
- `00 -Verify -Finalize` merges the chunk records since the last apply, checks **coverage** against the live top level
  of every target (`Test-ElvChunkCoverage`), checks each target root directly, requires every chunk ran **elevated**,
  and writes `verify-complete.json`.
- `06` gate **G5** refuses to enable the worker unless `verify-complete.json` is `complete`, newer than the apply, and
  matched to the apply `ref`.
- The **representative real-token** half is the adversarial matrix (AT-10..21, AT-96): real open/rename/delete probes
  under `elv-stg-worker`, owner-side verified. r3 cannot run it (no account yet); it is specified, not claimed.

**Tests:** §G per-object `V3:*` on the synthetic fixture (exposed vs not-exposed, nested, protected, unreadable,
junction-not-followed); §K `06 gate … G5 FAIL closed`; coverage unit test (`H1: chunk coverage …`).

**Residual:** the elevated full-tree `-Verify` over the live volumes has not run (needs admin + production idle). The
model is a configuration inventory, not a Windows access check.

## H2 — mandatory trusted source + independent hash verification

**Brief:** make a trusted installation source and independent hash verification mandatory for elevated operations; a
hash manifest stored beside worker-writable scripts is not a trust anchor.

**r3 (full chain in TRUSTED_INSTALLATION_CHAIN.md):**
- The trust anchor is an **out-of-band** value: `-ApprovedManifestHash` (SHA-256 of the canonical `SHA256SUMS`), typed
  by the owner from the review hand-back. It is **mandatory** for every `-Apply`.
- `Assert-ElvTrustedScriptLocation` requires: the folder, every `*.ps1`, and `SHA256SUMS` are writable by **nobody but
  SYSTEM/Administrators** (the owner SID counts as a writer, because the production task runs as the owner, Limited)
  and owned by SYSTEM/Administrators; `SHA256SUMS` is complete, matching, and in **canonical** form; and its SHA-256
  equals the out-of-band hash.
- `Freeze-AdminScripts.ps1` is elevated and mandatory-`-ApprovedSums`; it writes the copy under
  `<owner>\ElevariqAdmin\trusted\`, sets `/inheritance:r SYSTEM:F Administrators:F owner:RX` and
  `/setowner Administrators /T`, re-hashes, and re-checks the admin-only predicate.

**Tests:** §H — owner-writable copy → R7 **WARN** in dry-run and **refused** for apply even with the right hash; missing
/ wrong `-ApprovedManifestHash` recorded; tampered script → hash mismatch; non-canonical `SHA256SUMS` refused; `Freeze`
refuses non-elevated and `-ApprovedSums` is a mandatory parameter; every stage script exposes `-ApprovedManifestHash`.

**Residual (honest):** the scripts cannot cryptographically verify themselves (H2(b) in the review). The owner compares
the frozen hashes against the out-of-band list **by eye** in the elevated shell before running anything. This is a
procedure, documented in `Freeze-AdminScripts.ps1` and TRUSTED_INSTALLATION_CHAIN.md, not an automated guarantee.

## H3 — network requests delegated to system services

**Brief:** identify requests delegated to system services; design explicit prevention or a documented, independently
tested restriction for each.

**r3 (full table in NETWORK_DELEGATION_RISKS.md):**
- Per-SID worker rules do not match delegated egress. `05 -HostRules` adds **global** outbound blocks for the SMB
  redirector (`Program=System`, TCP 445/139 to non-LAN) and WebDAV (`Service=WebClient` to non-LAN). These change
  global state and are a **separate authorization**.
- `05` now also checks all three firewall profiles are Enabled and honour local rules; refuses otherwise.
- BITS (SYSTEM svchost; worker-token impersonation unverified), DNS (Dnscache/NETWORK SERVICE), and loopback (not
  filtered by Windows Firewall) are recorded as residuals with named acceptance tests: AT-H3-BITS, AT-73/AT-78, AT-76.

**Tests:** §L dry-run of `05 -HostRules`; §I the firewall-rule and profile predicates.

**Residual:** the host-level blocks and the BITS/loopback behaviour must be tested under the real worker token before
any claim. A loopback egress proxy with a host-name allow-list is still unimplemented; without it the worker has no
host-name allow-listing, only IP ranges.

## H4 — firewall verification bound to the current worker SID, fail closed

**Brief:** bind firewall verification to the actual current worker SID and fail closed for stale identities.

**r3:**
- `Test-ElvWorkerFirewallRule` (pure) requires the rule's `LocalUser` SDDL to contain the exact token
  `(A;;CC;;;<current worker SID>)`, be Enabled, Outbound, Block, with an **exact** address-set compare (L9).
- `06` gate **G7** calls it for both worker rules against the **current** worker SID and checks profiles enforcing.
  **G6** re-runs `Test-ElvLayout` (0 FAIL) so the gate covers the layout ACLs, not just `Test-Path work\`.
- `05` verification (N2/N3) uses the exact SID token and exact address set.

**Tests:** §I — stale SID rejected, current accepted, substring SID (`…-100` vs `…-1001`) rejected, disabled/allow/
inbound rejected, exact address set required, missing rule rejected (fail closed); §K gate FAIL closed.

**Residual:** none at the predicate level. The live rule creation (`05 -Apply`) has not run.

## H5 — shadow-copy exposure, real-token validation, plausible vs demonstrated

**Brief:** investigate shadow-copy exposure and design real-token validation; distinguish plausible risks from
demonstrated access.

**r3:**
- `Get-ElvShadowCopies` enumerates shadow copies of the DENY-target volumes and **fails closed**: it throws `UNKNOWN`
  when not elevated, so a non-elevated run can never report "no shadows".
- `00 -ListShadows` (elevated) lists them; `00 -Apply` records them in `deny-targets.json`; `06` gate **G8** refuses to
  enable the worker if any shadow of a DENY-target volume predates the apply (`Test-ElvNoPreDenyShadows`), or if the
  check cannot run (UNKNOWN = FAIL).
- **Plausible vs demonstrated:** on this host, non-elevated enumeration is denied (`Win32_ShadowCopy`: initialization
  failure; `vssadmin`: access denied). So shadow-copy exposure is **plausible, not demonstrated**. r3 says so and makes
  the gate fail closed until an elevated check clears it. The real-token validation is AT (open a DENY-target file
  through `\\?\GLOBALROOT\…` as the worker), owner-side verified.

**Tests:** §I `Get-ElvShadowCopies` throws UNKNOWN non-elevated; the gate throws; deny-target drive derivation; §K
`06 gate … G8 … UNKNOWN`.

**Residual:** whether any pre-DENY shadow exists, and whether the worker can read one, is unverified until an elevated
`00 -ListShadows` and the AT probe run. Deleting shadows (`vssadmin delete shadows`) is a separate authorization.
