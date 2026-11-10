# AI governance control register

Status legend: **A** implemented + locally tested · **B** implemented, awaiting OS-level verification · **C** requires administrator · **D** requires a genuine isolated Claude CLI test · **E** still vulnerable to same-user arbitrary code · **F** requires independent security review.

## Control register

| Governance principle | Control | Implementation | Status |
|---|---|---|---|
| Accountability | Every action attributable to worker, task, model, policy version | Action fingerprint binds all of these; audit event per decision | A, (B for worker=SID) |
| Human oversight | Independent, informed, single-use approval + revocation | `approval-grant.ts`, broker `decide`/`revoke`; dashboard fields designed | A (app), B/C (independence needs OS) |
| Least privilege | Task-scoped, default-deny capabilities | `capability.ts` | A (model), B/C (OS ACL enforces) |
| Transparency | Understandable action/decision history | Signed chain + governance metrics | A, E (same-user tamper) |
| Auditability | Tamper-evident evidence | `audit-chain.ts`, `verifyChain` | A (evidence), C/E (tamper-proof needs key under separate identity) |
| Data governance | Redaction before persistence; minimization | `redact.ts` (V2.1); broker stores redacted data | A |
| Security | Enforced identity and resource boundaries | Admin scripts 01–04 | C (not applied), E |
| Reliability | Recovery, monitoring, fail-safe | Broker fails closed; existing supervisor recovery | A (fail-closed), B (worker recovery under new identity) |
| Contestability | Owner can challenge/reject/stop | `decide` DENY, `revoke`, emergency stop (owner > worker) | A (app), C (OS stop) |
| Change management | Reviewed, recorded policy changes | Policy version in fingerprint; stale version denied | A |

## NIST AI RMF mapping (assessment structure, not a compliance claim)

- **GOVERN** — Roles separated by design (owner / supervisor-broker / worker). Policies: default-deny capability, single-use approval, append-only audit. *Gap:* role separation is not OS-enforced yet (C/E).
- **MAP** — Threats mapped in `WINDOWS_WORKER_ISOLATION_DESIGN.md` and the earlier threat model; same-user arbitrary code is the dominant unmitigated risk.
- **MEASURE** — `governance.ts` computes the 12 measures from the signed chain; `chainVerified` gates their trustworthiness.
- **MANAGE** — Admin scripts + runbooks for applying/rolling back controls; emergency stop; rollback script.

## The 12 measures (calculation + source)

| # | Measure | Calculation | Source event |
|---|---|---|---|
| 1 | Unauthorized requests | count of `broker.deny` | signed chain |
| 2 | Unauthorized execution success | 0 by construction (allow only after all checks) | signed chain |
| 3 | Approval bypass attempts | failed `consume` with "does not match" | `broker.approval_consume` |
| 4 | Approval replay attempts | failed `consume` with "already used/expired" | `broker.approval_consume` |
| 5 | False-positive denials | deny fingerprint later granted | `broker.deny` + `broker.decided` |
| 6 | Audit completeness | (allow+deny)/executions | chain |
| 7 | Secret leakage incidents | count `secret.leak` | chain (0 expected) |
| 8 | Privilege-escalation attempts | `capability.denied` + `acl.denied` | chain |
| 9 | Self-approval attempts | count `broker.decide_rejected` | chain |
| 10 | Human interventions | `broker.decided` + `broker.revoked` | chain |
| 11 | Recovery incidents | count `recovery.incident` | chain |
| — | Trust gate | `chainVerified` — false ⇒ all UNVERIFIED | `verifyChain` |

## Honest statement
Implemented (A) controls are application-level. They raise the bar against a cooperative or injected-but-non-code-executing worker and produce tamper-evident evidence. They are **not** a technically enforced boundary against same-user arbitrary code (E). The controls that make them a boundary (C) require administrator authorization and are delivered as dry-run scripts + runbooks, unapplied.
