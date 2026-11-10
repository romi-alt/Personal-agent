# Remaining blockers

Each blocker names what it gates, why it is blocked, and the exact unblock action.

## B1 — Dedicated worker Windows account (gates G1, and therefore G2–G5, G7, G10)
- **Why blocked:** creating a local user and assigning it requires administrator; the agent is not authorized to create accounts.
- **Unblock:** owner runs `admin-scripts/01-create-worker-account.ps1 -Apply` (elevated). Review the dry-run report first.

## B2 — NTFS ACLs for worker/broker/owner/production (gates G2, G3, G4, G7)
- **Why blocked:** requires administrator and the worker SID (B1 first).
- **Unblock:** `02-configure-acls.ps1 -Apply`. Also decide the `E:\` `Authenticated Users: Modify` targeted fix (WINDOWS_ACL_CONFIGURATION.md).

## B3 — Firewall egress rules + proxy (gate G9)
- **Why blocked:** administrator; and complete control needs an owner-run authenticated egress proxy.
- **Unblock:** `03-firewall-rules.ps1 -Apply`; optionally stand up the proxy and force worker traffic through it.

## B4 — Worker scheduled task (gates G1 runtime, G13 OS-level)
- **Why blocked:** administrator; needs B1.
- **Unblock:** `04-worker-task-and-verify.ps1 -Mode register -Apply`, then `-Mode verify`.

## B5 — Claude Code login under the worker identity (gate G12, D)
- **Why blocked:** a subscription login must be established interactively as `elevariq-worker`; copying the owner's `~/.claude` is forbidden (it would re-expose the credential the isolation protects).
- **Unblock:** owner signs in to Claude Code once while logged on as (or runas) `elevariq-worker`. Then the real-CLI adversarial + legitimate staging tests (Tests A/B/C in the mandate) can run under isolation.

## B6 — OS-level adversarial verification (gate G13)
- **Why blocked:** needs B1–B4 applied, then the adversarial suite run **as the worker account**. Per the current authorization, the isolation harness and its sandboxed mode are **not** to be re-run by the agent.
- **Unblock:** after B1–B4, the owner (or an authorized session) runs the OS-level adversarial tests as the worker and confirms the 27 same-user successes become denials.

## B7 — Independent security review (gate G16, F)
- **Why blocked:** must follow the OS controls being applied; a reviewer must inspect the real Windows configuration and effective worker permissions, not share the implementer's assumptions.
- **Unblock:** commission a separate read-only review after B1–B5.

## B8 — Persist broker state under the broker identity (gates G3, G4, G10 tamper-proofing)
- **Why blocked:** the grant store and audit chain are currently in-process/file; their protection depends on B1+B2 so the worker SID cannot read the signing key or edit the store.
- **Unblock:** after B2, point the broker's persistence and signing key at `C:\ElevariqBroker` (worker-denied). Code hook exists (AuditSink/grant store are injectable); wiring is a follow-up once the identity exists.

## Standing constraints honored this phase
- Production V2 untouched (PID 8992 running, `e60278f`).
- Nothing pushed, merged, deployed or restarted.
- No account, ACL, firewall rule, registry key or scheduled task created.
- Isolation harness sandboxed mode not activated; only the same-user baseline (synthetic fixtures) was reproduced for evidence.
