# Trusted approval broker

**Status: A — implemented and locally tested (application level). B — awaiting OS-level verification. E — still vulnerable to same-user arbitrary code until identity separation is applied.**

## Purpose
A single decision point between a worker's request and any privileged effect. A worker asks; the broker decides, using the task's capability grant and a single-use, action-bound owner approval for consequential actions. The worker never decides, and never supplies its own approval status.

## Where the code is
Branch `feat/v21-trusted-execution` in worktree `E:\Agent\v2-staging\v21-trusted-20261110-0223\repo`, not pushed:
- `src/security/broker/canonical.ts` — canonical serialization + action fingerprint.
- `src/security/broker/capability.ts` — task capability model.
- `src/security/broker/approval-grant.ts` — single-use, action-bound approvals.
- `src/security/broker/audit-chain.ts` — hash-chained signed audit.
- `src/security/broker/broker.ts` — the broker.
- `src/security/broker/ipc.ts` — transport-agnostic request validation.
- `src/security/broker/governance.ts` — metrics from the signed chain.
- Tests: `tests/unit/broker-approval.test.ts` (24), `tests/unit/broker-governance.test.ts` (2).

## Action binding (what an approval authorizes)
`actionFingerprint` is a sha256 over the canonical form of: category, tool, canonical arguments, target, worker id, task id, project id, execution id, cwd, policy version. Two descriptions of the same action hash equally; any meaningful change diverges. `canonicalArgsFor` normalizes a command through the same shell analyzer the policy uses, so whitespace differences do not force re-approval, while `--force`, a different remote, or a different branch do.

## Single-use approvals (`approval-grant.ts`)
- **Nonce:** 32 random bytes per grant.
- **Expiry:** default 5 minutes (`DEFAULT_GRANT_TTL_MS`), owner-configurable.
- **Atomic consumption:** the first successful `consume` moves the grant to CONSUMED; any later use is denied as a replay.
- **Binding check at consume:** the presented action's fingerprint must equal the bound one, and the nonce must match.
- **Supersession:** re-requesting the same action revokes the prior live grant, so approvals cannot be stockpiled.
- **Revocation:** the owner can revoke a PENDING or APPROVED grant.
- **Fail-closed:** any mismatch (missing, wrong state, wrong nonce, wrong fingerprint, expired) denies.

## Broker decision flow (`broker.ts`)
1. Look up the task capability (never taken from the worker). No grant → deny.
2. Validate every request field against the capability: task, project, worker id, policy version, expiry, duplicate request id. Any mismatch → deny (audited).
3. No category → allow (the action is governed by the capability's path/exec/network rules), audited.
4. Category not in the task's `approvalCategories` → deny.
5. Approval presented → consume atomically; match → allow, else deny.
6. No approval → create a bound single-use grant and return `needs_approval` for the owner.

`decide` rejects any principal that is not an owner principal — a worker cannot approve its own request, and the old `owner-cli` self-approval string is rejected.

## Tests that demonstrate the properties
- Needs-approval → owner approves → worker consumes once → replay denied.
- Worker cannot self-approve (`worker-1`, `owner-cli` both rejected).
- An approval for `git push origin main` does not authorize `git push --force origin main`.
- A category the task did not pre-authorize is denied.
- Duplicate request id rejected.
- Mismatched worker/policy/project denied, and the audit chain still verifies.

## Honest limitations
- **This is an application-level control.** The broker is a real boundary only when it runs under a **different Windows identity** from the worker, so the worker cannot call `decide` as the owner, edit the grant store or audit file, or debug/replace the broker process. On this machine the worker currently shares the owner's identity, so **same-user arbitrary code can still bypass it** (baseline: 27/27). The Windows isolation scripts (`admin-scripts/`) close this, and require administrator authorization.
- The IPC caller-SID check (`ipc.ts`) is only meaningful once the worker runs under a distinct SID; documented in `WINDOWS_WORKER_ISOLATION_DESIGN.md`.
- Persistence of the grant store and audit chain under a broker-only identity is designed (ACL script 02) but not applied.
