# R3 readiness verdict (2026-11-10)

## Verdict

**REVIEWABLE R3 CANDIDATE — READY FOR INDEPENDENT REVIEW. NOT an installation authorization. OS-level isolation is NOT
demonstrated.**

The r2 blocker and all five high findings are corrected in code and covered by passing tests; the eleven mediums and
twelve lows are addressed or explicitly deferred with reasons. 182/182 offline checks pass, including a genuine Windows
access check of the reviewer's Full-access counterexample. No privileged change was made; production is untouched.

This is exactly the brief's target: *a reviewable r3 security candidate, not a production deployment.* READY is **not**
declared on passing unit tests or static ACL calculations — it is declared for **review**, and the readiness for
**installation** is gated on the real-token adversarial matrix and a fresh independent review, neither of which r3 can
perform.

## What changed since r2

- **B1 fixed:** the sweep and the layout checks no longer ignore inherit-only broad ACEs; classification is a pure,
  SDDL-testable function, reproduced failing on the exact r2 code and passing on r3, and confirmed by a real open.
- **H1–H5 fixed:** per-object post-DENY verification with coverage and a fail-closed `06` gate; an out-of-band trusted
  installation chain; delegated-egress handling with global SMB/WebDAV blocks and recorded residuals; firewall
  verification bound to the current worker SID; fail-closed shadow-copy gating.
- **Mediums:** exit-code/report-on-failure, non-destructive timestamped backups, coverable-finding-only additional denies,
  pre-existing-account gating, staging-folder ownership, atomic firewall replace, orphan-task rollback, persisted state,
  add-file-only request spool with OWNER RIGHTS, junction-safe rollback, recycle-bin denies + NTFS quotas.
- **Lows/info:** strict path and CIDR guards, terminating rights edits with verification, fail-closed group enumeration,
  widened broad-SID set, exact firewall matching, `.git\HEAD`-only HEAD read, owner-by-SID, supervisor-by-command-line.

## Phase 6 — release architecture reconsidered

The brief asks whether drive-wide group DENY is the safest solution, measured against a dedicated VM and narrowly
scoped production protections, recommending the smallest independently enforceable boundary that does not needlessly
risk production availability. Building on `SECURITY_ARCHITECTURE_COMPARISON.md`:

- **Dedicated VM (strongest boundary).** Separate kernel removes the shared-kernel residual. But this host has ~1.6 GB
  free RAM; a Windows guest needs ≥4 GB, a Linux guest ~2 GB, and the production memory gate already defers work. A VM
  would starve production — an availability regression the brief tells us to avoid. **Target state once the host has
  ≥16 GB, or on the Phase 6 Linux VPS / separate hardware.** Not now.
- **Drive-wide group DENY (r3's approach).** An inheritable DENY for an initially **empty** group has zero effect on
  existing principals and is reversible by removing one ACE per root, so its availability risk is low. Its weakness is
  the fail-open edge (B1), now mitigated by the corrected sweep **and** the independent per-object verification tripwire.
  It still shares the kernel and needs a re-sweep when new volumes appear.
- **Narrowly scoped allow-list (C′).** Replacing `AU:Modify` on E:/F: with an owner-only grant fails closed for all
  non-owner principals and also closes the pre-existing any-Authenticated-User exposure. It is a **bigger** production
  ACL change that could break other software reading E:, so it is recommended **later, as hardening**, not for the
  pilot.

**Recommendation (smallest independently enforceable boundary that protects production availability):** keep r3's
**group DENY + size-capped VHDX + separate broker identity + SID-scoped egress**, but install it against a **staging
root only** for the pilot, not against the live production ACLs, until the real-token matrix passes. Treat the drive-wide
production DENY (`A5`) and the allow-list hardening as separate, later authorizations. Hold the VM as the target state.
This is the same staging-first posture the earlier assessment reached, now with the B1 hole closed and a verification
tripwire behind it.

## Open owner-authorization requirements (unchanged in kind from the r2 verdict)

Each is a distinct authorization; approving one does not approve the next. None has been performed.

1. **A1** — independent review of r3 at the frozen hashes, then `Freeze-AdminScripts.ps1 -ApprovedSums` (elevated).
2. **A2 (read-only, elevated)** — `00 -Sweep` (chunked, B1-fixed) over the DENY targets incl. the two `IntelOptaneData`
   trees, then `00 -Sweep -Finalize`; production idle.
3. **A3** — `00a -Apply` (remove the `isotest\outside` Everyone:F and the two AppContainer ACEs).
4. **A4+A5 (production volume ACLs)** — `00 -Apply` with the sweep's coverable findings as `-AdditionalDenyPaths`; then
   the elevated `00 -Verify` chunks + `-Verify -Finalize`.
5. **A6–A12** — VHDX, identities, rights, broker, egress, worker enable, as in the r2 verdict, each separately.
6. **A13** — the real-token adversarial matrix (Phase 1 scripted + Phase 2 red-team), owner-side verified, independently
   reviewed. Only then may any "OS isolation demonstrated" claim be made.

## Safeguards that remain UNVERIFIED

- Everything behind `-Apply`: DENY propagation over ~350k objects; diskpart/VHDX; secedit; account/task/firewall
  creation; the elevated per-object `00 -Verify`; the live rollback.
- Shadow-copy exposure (non-elevated enumeration is denied here; gate fails closed until an elevated check clears it).
- The delegated-egress blocks (SMB/WebDAV/BITS/DNS/loopback) under a real worker token.
- The broker's own move-before-parse, reparse-rejection and approval-owner-SID checks (no broker service entrypoint yet).
- Worker memory/process caps (need a Job Object launcher, not written).

## Known r3 limitation to put to the reviewer

The gate's verification state (`verify-complete.json`, `deny-targets.json`, chunk records) lives under the owner profile
and is written by the owner **non-elevated**. The worker account cannot reach it (the profile DACL denies it), so it is
safe against the modelled adversary. But a malicious dependency running in the owner-context agent (the AP-9 / I3
confused-deputy class) could forge it to open the `06` gate. r3 does **not** yet ACL the state directory admin-only or
verify the state files are admin-owned at gate time. This is surfaced in `R3_INDEPENDENT_REVIEW_REQUEST.md` as the most
likely real r3 weakness; closing it (admin-only state dir + an admin-owned check in G5/G8) is a candidate change for the
next revision and is **not** claimed fixed here.

## Bottom line

r3 is a sound, honestly-bounded candidate to put in front of an independent reviewer. It does not authorize
installation, and it makes no OS-isolation claim. The next gate is review, then — only with the owner's separate
authorizations and a production-idle window — the elevated apply and the real-token matrix.
