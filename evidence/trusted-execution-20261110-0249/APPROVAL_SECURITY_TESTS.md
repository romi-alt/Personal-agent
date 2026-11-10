# Approval security tests

**Status: A — implemented and locally tested (application level). The OS-level versions of these attacks are BLOCKED pending identity separation.**

Source: `tests/unit/broker-approval.test.ts` (24) and `tests/unit/broker-governance.test.ts` (2). 26 synthetic tests, all passing on commit `5574c6b`. No real credential, account, pipe or system object is used.

## Approval-attack coverage

| Attack (mandate §12.2) | Test | Result (application level) |
|---|---|---|
| Self-approval | broker "worker cannot approve its own request" | DENY — `decide` rejects a non-owner principal (`worker-1`, `owner-cli`) |
| Approval replay | broker "needs approval … consume once" + "replay denied" | DENY — atomic single-use; second consume rejected |
| Expired approval | grant "expires after its TTL" | DENY — consume after TTL fails |
| Changed arguments after approval | broker "one command does not authorize a different command" | DENY — fingerprint mismatch |
| Changed target after approval | canonical "any meaningful change diverges" (target) | DENY — different fingerprint |
| Approval from another worker | canonical (workerId) + broker validate (worker mismatch) | DENY |
| Forged approval response | grant "wrong nonce rejected" | DENY — nonce mismatch |
| Direct grant/store modification | — | **NOT testable at app level**; requires OS identity separation. Marked E. |
| Broker impersonation | ipc "caller SID mismatch rejected" | DENY (advisory until distinct SID; see IPC caveat) |
| Unrecognized consequential actions | broker "category the task did not pre-authorize" | DENY — default-deny capability |
| Duplicate request (request replay) | broker "duplicate requestId rejected" | DENY |
| Stale policy version | broker "mismatched policy denied" | DENY |

## Fail-closed coverage (IPC)
- Malformed JSON → error.
- Missing/invalid fields → error (each field checked).
- Oversized frame (> 64 KiB) → error.
- Timestamp outside skew window → error.
- Internal broker exception → **deny** (never allow).

## Governance evidence
- Every decision (allow/deny/needs-approval/consume/decide/revoke/reject) is appended to the signed chain.
- After a full mixed run the chain still verifies.
- A tampered chain makes `computeGovernanceMetrics` report `chainVerified=false`, flagging all metrics UNVERIFIED.

## What these tests do NOT prove
- They do not prove a worker running arbitrary code as the owner is stopped. At the OS level that worker can edit the grant store, call the owner CLI, or read the signing key (baseline 27/27). Those gates are **BLOCKED** and depend on the admin scripts.
- They do not exercise a real named pipe or a real distinct SID; the IPC caller check is validated logically, with the same-SID caveat documented.
