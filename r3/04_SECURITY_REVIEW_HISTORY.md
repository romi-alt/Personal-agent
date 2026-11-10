# 04 — Security review history

Chronological record of the worker-isolation security effort, as preserved in this package.

1. **Permissions assessment + full sweep** (`05-SECURITY-EVIDENCE/permissions-assessment-20261110`). Read-only audit of
   E:/F:/C:/D: ACLs; a chunked sweep of 347,509 items found 8 findings. Later downgraded to AUDIT INCOMPLETE because the
   sweep filter had the B1 defect.

2. **Trusted-execution design + broker** (`05-SECURITY-EVIDENCE/trusted-execution-20261110-0249`; code on
   `feat/v21-trusted-execution` @ 5f07b85). Application-level approval broker, capability model, signed audit chain.
   Same-user baseline still reproduced (no OS isolation).

3. **R2 administrator scripts** (`05-SECURITY-EVIDENCE/admin-scripts-r2-20261110`). First full admin-script set.
   **Independently reviewed and REJECTED** (`INDEPENDENT_REVIEW_R2.md`): 1 blocker, 5 high, 11 medium, 12 low, 4 info.

4. **R3 administrator scripts** (`04-R3-SECURITY/admin-scripts-r3-20261110`). Corrected candidate; every R2 finding
   addressed or deferred-with-reason; 182/182 offline tests; frozen manifest `a4ccaab…c5f10c9b`. Verdict: reviewable
   candidate, NOT an installation authorization, OS isolation NOT demonstrated.

## Independent review artifacts preserved

- `05-SECURITY-EVIDENCE/admin-scripts-r2-20261110/INDEPENDENT_REVIEW_R2.md` — the rejection, with every finding.
- `04-R3-SECURITY/r3-remediation-20261110/R2_REVIEW_FINDING_MATRIX.md` — finding-to-fix mapping.
- `04-R3-SECURITY/r3-remediation-20261110/R3_INDEPENDENT_REVIEW_REQUEST.md` — the request for the next review.

## Original vs corrected scanner results

- Original (r2) sweep logic: reproduced on disk by `r2-baseline-check.ps1`, shown blind to inherit-only broad ALLOWs.
- Corrected (r3) classifier: `Get-ElvAclClassification`, flags them; proven by a real Windows open of the counterexample.
- Both results are preserved in the R3 test logs and `BLOCKER_ROOT_CAUSE_AND_FIX.md`.

## Next

Independent review of R3 is the pending gate (`04_SECURITY_GATES_PENDING.md`). The destination's ACLs/SIDs differ, so the
elevated sweep/verify and the real-token matrix must be re-run there regardless of this migration.
