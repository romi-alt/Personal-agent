# 04 — R3 security preservation

## What is preserved here (outside Git, by design)

`04-R3-SECURITY/admin-scripts-r3-20261110/` — the frozen R3 administrator scripts, `_common.ps1`, `Freeze-AdminScripts.ps1`,
the regression suite (`tests/Test-R3.ps1`, `Fixture-AclCases.ps1`, `r2-baseline-check.ps1`), the ACL test fixtures, the
reviewer counterexample reproduction, `REVIEW_SHA256SUMS`, the test output logs, and the dry-run reports.

`04-R3-SECURITY/r3-remediation-20261110/` — all 12 deliverables: `R2_REVIEW_FINDING_MATRIX.md`,
`BLOCKER_ROOT_CAUSE_AND_FIX.md`, `ACL_INHERITANCE_REGRESSION.md`, `HIGH_SEVERITY_REMEDIATIONS.md`,
`MEDIUM_FINDINGS_DISPOSITION.md`, `TRUSTED_INSTALLATION_CHAIN.md`, `NETWORK_DELEGATION_RISKS.md`, `ROLLBACK_SAFETY.md`,
`R3_TEST_RESULTS.md`, `R3_INDEPENDENT_REVIEW_REQUEST.md`, `R3_READINESS_VERDICT.md`, `EVIDENCE_MANIFEST.sha256`.

## Integrity verification performed

- `REVIEW_SHA256SUMS`: 1,060 bytes, SHA-256 `a4ccaababf552b7aa289d5856ef32df93ee83d726646cfbeb9b63804c5f10c9b`
  (matches the reported baseline).
- All 12 scripts verified against it: 0 mismatches, 0 unlisted. Per-file hashes in
  `R3_FROZEN_SECURITY_HASH_VERIFICATION.md`.
- The frozen scripts were **not modified**. The exported copy is byte-identical (covered by the package SHA-256
  manifest and re-checked by `10-VALIDATION-REPORTS/validate-package.ps1`).
- Original directory structure preserved. A separate portable copy was made and hashed; source and copy match.

## Integrity caveat (honest)

A SHA-256 manifest proves integrity against its own recorded values, not independent authenticity if both the files and
the manifest can be altered. The out-of-band manifest identity (`a4ccaab…c5f10c9b`) is recorded in the migration
verification instructions so the owner can confirm authenticity on the destination before trusting the scripts.

## Related security source IN Git

The approval-broker and trusted-execution **code** (`src/security/broker/*.ts`) is on `feat/v21-trusted-execution`
(`5f07b85`) inside `01-GIT-BUNDLES/security-hardening.bundle`, and the governance/audit-chain code with it. The R3 admin
scripts above are the **operational** layer and are intentionally outside Git; both are preserved.

## Status

Not production-approved. See `04_SECURITY_GATES_PENDING.md` and `04_SECURITY_REVIEW_HISTORY.md`.
