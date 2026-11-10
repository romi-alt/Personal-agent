# ELEVARIQ worker-isolation security research (R2/R3)

Standalone security tooling and evidence for the Windows worker-isolation effort: PowerShell admin scripts and
Markdown/JSON evidence, NOT part of the Node application build. They live on this dedicated branch so a clone can include
them without touching the app branches.

## NOT production-approved

- R3 is a **reviewable candidate**, not an installation authorization.
- **OS-level worker isolation is NOT demonstrated** by anything here. The admin scripts default to dry-run and were
  never applied; no worker account, group, ACL change, or firewall rule was created.
- Pending gates: independent review of R3, elevated B1-fixed ACL re-sweep, and the real-token adversarial matrix.

## Layout

- `r3/admin-scripts-r3-20261110/` â€” the frozen R3 admin scripts, tests, and `REVIEW_SHA256SUMS`
  (frozen manifest identity `a4ccaababf552b7aa289d5856ef32df93ee83d726646cfbeb9b63804c5f10c9b`).
- `r3/r3-remediation-20261110/` â€” the 12 R3 remediation deliverables (finding matrix, blocker fix, etc.).
- `evidence/admin-scripts-r2-20261110/` â€” the REJECTED r2 scripts and the independent review.
- `evidence/permissions-assessment-20261110/`, `preflight-20261110/`, `trusted-execution-20261110-0249/`,
  `hardening-*`, `release-readiness/` â€” security research evidence.

## Excluded on purpose

Database snapshots (RESTRICTED; never committed), synthetic-secret test fixtures (would trip secret scanners),
`node_modules`, and `.git`. The approval-broker source code is in the app history on `feat/v21-trusted-execution`.
