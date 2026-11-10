# Permissions assessment 2026-11-10: inherited E: drive permissions (READ-ONLY)

Deliverables:
- FINAL_SECURITY_VERDICT.md (start here)
- EFFECTIVE_PERMISSIONS_AUDIT.md
- THREAT_MODEL.md
- SECURITY_ARCHITECTURE_COMPARISON.md
- ISOLATION_IMPLEMENTATION_PLAN.md
- ADVERSARIAL_ACCEPTANCE_MATRIX.md
- ROLLBACK_PLAN.md

Evidence (`evidence/`):
- root ACL baselines (`icacls-*-root.txt`)
- production task XML
- simulation script and CSV outputs
- inheritance and explicit-allow sweeps

Integrity: `EVIDENCE_MANIFEST.sha256`. A copy of the manifest is kept outside E:\, because E:\ is writable by every Authenticated User.

Nothing in this folder was executed against the system except read-only queries.
