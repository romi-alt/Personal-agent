# Security acceptance matrix

Gates from the production-hardening mandate (G1–G17). Verdict per gate: **PASS** (independently verifiable now), **APP-ONLY** (application control implemented and tested, not OS-enforced), **BLOCKED** (needs administrator or a genuine isolated CLI test), **NOT VERIFIED**.

| Gate | Requirement | Verdict | Evidence / why |
|---|---|---|---|
| G1 | Separate owner / supervisor / worker identities | **BLOCKED (C)** | Designed; scripts 01–04 unapplied. Worker still = owner. |
| G2 | Worker cannot access owner credentials | **BLOCKED (C,E)** | ACL DENY designed (script 02); same-user today → 6/6 credential reads succeed. |
| G3 | Worker cannot modify supervisor/broker | **APP-ONLY / BLOCKED** | Broker API gives no widen path (A); OS protection of broker root is C. Same-user → can edit state (E). |
| G4 | Worker cannot modify authoritative state | **APP-ONLY / BLOCKED** | Broker mediates writes (A); DB/grant store under broker identity is C. |
| G5 | Independent approval enforcement | **APP-ONLY** | `decide` rejects non-owner principals, worker cannot self-approve (A). "Independent" requires distinct OS identity (B/C). |
| G6 | Single-use, action-bound, expiring approvals | **PASS (app)** | `approval-grant.ts` + 24 tests: nonce, 5-min expiry, atomic consume, fingerprint binding, replay denied. Application-level, but fully verified here. |
| G7 | Protected production and owner files | **BLOCKED (C)** | DENY ACEs designed (script 02); not applied. |
| G8 | Filesystem traversal and link attacks blocked | **PARTIAL PASS / BLOCKED** | Path checks resolve realpath incl. junctions/symlinks and the heredoc-body bypass is fixed (commit `1d5bda9`, probes 0 bypasses) — application level. OS-ACL final boundary is C. Hard-link read residual noted. |
| G9 | Unauthorized network access blocked | **BLOCKED (C)** | SID-scoped rules designed (script 03); proxy enforcement gap documented. |
| G10 | Tamper-resistant authoritative audit | **APP-ONLY (tamper-evident) / BLOCKED (tamper-proof)** | `verifyChain` detects edit/delete/reorder/forge (A); tamper-proofing needs key under separate identity (C,E). |
| G11 | Complete tested secret-redaction paths | **PASS (from V2.1 assessment)** | Redaction before persistence, 20/20 byte-scan; brokered path removes pre-logger-stderr gap. |
| G12 | Real Claude CLI staging acceptance under worker identity | **BLOCKED (D)** | Needs a Claude login as `elevariq-worker`; copying owner creds forbidden. (A benign real-CLI run under the OWNER identity passed earlier, not under isolation.) |
| G13 | Adversarial security suite passes | **APP-ONLY** | 26 broker tests pass (A). OS-level adversarial suite requires the worker account (C). Previous same-user baseline reproduced: 27/27 succeed (E). |
| G14 | Full Windows regression passes | **PASS** | 572/572 unit on this branch; see PRODUCTION_READINESS_ASSESSMENT. |
| G15 | Backup, migration, rollback rehearsals | **NOT VERIFIED (this phase)** | Covered in the V2.1 assessment; no DB schema change here. |
| G16 | Independent security review | **BLOCKED (F)** | Required after OS controls applied. |
| G17 | Production operational readiness | **NOT APPLICABLE / unchanged** | Production untouched; no deploy. |

## Overall
**NOT READY.** Mandatory gates G1, G2, G7, G9, G12, G16 are BLOCKED; G3, G4, G5, G10, G13 are application-only and remain E (same-user) until G1 is applied. No gate was weakened to pass. Application controls that are fully verifiable now (G6, part of G8, G10-evidence, G11, G14) pass.
