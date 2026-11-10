# Broker integration review (Phase 4)

Reviewed whether the application-level broker operates safely once the worker and broker run under **separate** Windows identities. Code: `src/security/broker/*` on `feat/v21-trusted-execution`. One defect fixed locally (D10); the rest are correct-as-designed with the dependencies called out.

## Review findings

| Area | Finding | Status |
|---|---|---|
| Authenticated worker requests | The broker trusts `req.workerId` only after the IPC layer's `verifyCaller` binds it to the connecting SID. Logic is correct; the binding is **real only over a pipe that exposes the client SID**, which needs a distinct worker account. | Correct; depends on S1+S5 |
| Independent supervisor authority | Capability is fetched via `capabilityFor(taskId)`, never taken from the worker; `decide` rejects any non-owner principal. | Correct (app); OS independence needs identity split |
| Exact action binding | `actionFingerprint` covers category, tool, canonical args, target, worker, task, project, execution, cwd, policy version. Change any → different fingerprint. Tested. | Correct |
| Single-use approvals | Nonce + atomic consume + CONSUMED state; replay denied. Tested. | Correct |
| Replay prevention | Two layers: consumed-grant check (durable once persisted) and a bounded `seenRequests` window (D10 fix). | Correct |
| Approval revocation | `revoke` (owner-only) invalidates a PENDING/APPROVED grant; supersession on re-request. Tested. | Correct |
| Broker-side argument validation | `validate()` checks task/project/worker/policy/expiry/duplicate before any effect; `canonicalArgsFor` normalizes. | Correct |
| Unknown privileged operations | Default-deny: a category not in the task's `approvalCategories` is denied; an unknown tool falls through to deny. The broker never "allows because unrecognized". | Correct |
| Protected signing keys | The HMAC key is injected; the broker never logs it. **Protection depends on `C:\ElevariqBroker` ACL (S2)** so the worker SID cannot read it. Until then (same-user) the key is readable. | App-level; needs S1+S2 |
| Protected authoritative state | Grant store + audit are injectable sinks; in production they live under the broker root. **Same-user, the worker can still edit them**; the ACL is the fix. | App-level; needs S1+S2 |

## Defect fixed locally
- **D10 (low):** `seenRequests` grew unbounded. Now FIFO-evicted at 10k entries (commit `5f07b85`). The durable anti-replay guard for consequential actions is the single-use grant, so bounding the recent-request window is safe. 26 broker tests still pass.

## Cross-identity concerns that are NOT code bugs (design dependencies)
1. **The broker must run as the identity that can read `C:\ElevariqBroker`.** With the D3 fix that is the owner USER SID. If the broker is moved to SYSTEM, the ACL and the DPAPI credential (D6) must be re-provisioned under SYSTEM.
2. **IPC caller-SID verification is advisory until the worker has a distinct SID.** The server-side check is implemented (`verifyCaller`), but same-SID it proves nothing (documented in `ipc.ts`).
3. **Persistence wiring is a follow-up (B8):** pointing the grant store and audit sink at `C:\ElevariqBroker` is a small, safe change deferred until the directory exists with the right ACL, so the test suite stays hermetic.

## Verdict
The broker is **ready as an application control** and is structurally correct for cross-identity operation. It becomes a security boundary only when S1 (worker account), S2 (broker-root ACL) and S5 (worker task over a real pipe) are applied. No further code defect blocks that step.
