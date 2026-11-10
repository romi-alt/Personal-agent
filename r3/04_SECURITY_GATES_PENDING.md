# 04 — Security gates pending (R3 is NOT production-approved)

Carried forward verbatim in intent. R3 is a reviewable candidate only.

| Gate | State | Owner / reviewer action |
|---|---|---|
| Independent review of R3 at the frozen hashes | **PENDING** | hand `R3_INDEPENDENT_REVIEW_REQUEST.md` + the frozen scripts to a separate reviewer |
| Freeze into an admin-only copy | pending (after review) | `Freeze-AdminScripts.ps1 -ApprovedSums` (elevated) |
| Elevated, B1-fixed chunked ACL re-sweep | **PENDING** | the earlier 347,509-item sweep used the rejected filter → incomplete; re-run elevated, production idle |
| Production-volume DENY + per-object verify | pending | `00 -Apply` then elevated `00 -Verify -Finalize` |
| Staging VHDX / identities / broker / egress | pending | scripts 01–05, each separately authorized |
| Enable worker + real-token adversarial matrix | **PENDING** | 06 + `ADVERSARIAL_ACCEPTANCE_MATRIX.md`, owner-run, independently reviewed |
| Broker + filesystem OS boundaries | **NOT OS-VERIFIED** | needs the real worker token |
| Real isolated Claude Code acceptance | **PENDING** | run under `elv-stg-worker` |
| Production deployment of worker isolation | **NOT AUTHORIZED** | — |

## Known open R3 weakness (surfaced, not fixed)

The gate's verification state files (`verify-complete.json`, `deny-targets.json`, chunk records) are owner-writable
non-elevated; a malicious owner-context dependency could forge them to open the `06` gate (AP-9 confused-deputy class).
Fix candidate (admin-only state dir + admin-owned check in the gate) is not implemented. Carry this into the review.

## Host-specificity note for the destination

The R3 scripts hard-code host constants (expected owner SID `S-1-5-21-…-1001`, production paths, the production commit).
On the new PC these must be re-derived before any elevated use. The non-elevated test suite (`Test-R3.ps1`, 182/182)
runs anywhere and is the safe way to confirm the logic migrated intact.

See the full status in `r3-remediation-20261110/R3_READINESS_VERDICT.md`.
