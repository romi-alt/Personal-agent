# Final security verdict: inherited E: drive permissions

**Verdict: NOT READY. The previous status "STAGING INSTALLATION READY FOR OWNER AUTHORIZATION" is WITHDRAWN.**
**OS-level isolation: NOT ACHIEVED and NOT DEMONSTRATED.**

Scope: read-only assessment, 2026-11-10. Production `e60278f` / PID 8992 untouched. No account, ACL, task, firewall rule or worker process was created or changed.

## 1. Why the status is withdrawn

A simulated standard worker token (`EFFECTIVE_PERMISSIONS_AUDIT.md`) would receive read, write and delete-or-rename access to:
- the production checkout, its `.env` policy, `.git`, `dist` and `node_modules`;
- **the script run by the production scheduled task as Roman** (E1, CRITICAL);
- **the admin scripts the owner will run elevated** (E2, CRITICAL);
- Claude Code and git configuration that runs automatically as the owner (E3);
- the broker's source code, every evidence package, and 29 DB snapshots of production state;
- all data on E:, F:, `D:\src` and `C:\Download`.

Roman is a local administrator, and UAC is not a security boundary. So **one worker logon is enough to reach the owner's identity and then administrator.** The earlier mitigation ("only supervised synthetic tasks") is an application-level control, which this review excludes by mandate.

Correctly protected today (simulation, not yet tested): owner Claude credentials, DPAPI, Credential Manager, the live production DB, backups, workspaces and logs. All of these sit inside `C:\Users\Roman`.

## 2. Additional defects found in the reviewed staging scripts

1. **F-10a:** `C:\ElevariqStaging` root inherits AU:Modify from `C:\`.
2. **F-10b:** the G3/G4 checks in `04` contain an interpolation bug (verified in PS 5.1: the second alternative becomes `\(N\)`, which matches any principal). They also check icacls text, not real access.
3. **F-10c:** `03` puts allow and block rules together, and in Windows Firewall a block overrides an allow. It also passes a host name as RemoteAddress and does not check errors.

Fixes are specified in `ISOLATION_IMPLEMENTATION_PLAN.md` §R. The scripts were not edited.

A further pre-existing risk does not depend on the worker: any Authenticated-Users principal (including service accounts) can use E1 and E2 today.

## 3. Recommendation

The safest practical architecture for this host is **scoped ACL isolation plus a size-capped VHDX staging volume, with a separately-identified broker and SID-scoped egress** (`SECURITY_ARCHITECTURE_COMPARISON.md`):

1. **Group DENY** for a new, initially empty group `ElevariqIsolatedIdentities` at `E:\`, `F:\`, `C:\Download`, `C:\Intel`, `D:\src` and `D:\Intel`. Before that: run a file-level sweep and remove the explicit `Everyone:FullControl` test residue. This has zero effect on existing principals and is reversible by removing one ACE per root.
2. **A VHDX volume** mounted at `C:\ElevariqStaging` with a clean, protected root ACL.
3. **A broker identity `elv-stg-broker`** that is neither the owner nor the worker. Its code is admin-write-only and hash-verified; its key is DPAPI-protected under its own identity. Owner approvals are accepted only when the file-owner SID is the owner's. The audit chain head is anchored in an owner-only location.
4. **A worker egress block** on everything except loopback, plus a loopback hostname-allowlist proxy.
5. **Enable no worker identity until 1–2 are applied**, and claim nothing until the adversarial matrix passes under the real account and is independently reviewed.

Keep a VM as the target state once RAM allows it (8.4 GB total, about 1.2 GB free today) or on separate hardware. Fix E1 for every principal (I9a) as a separate production change.

## 4. Administrator actions that require separate, explicit owner authorization

Each item is a distinct authorization. Approving one does not approve the next.

| # | Action | Touches production? |
|---|---|---|
| A1 | Revise admin scripts per §R, review them independently, and freeze them into an owner-only hash-verified copy (I0) | No (owner action, no elevation) |
| A2 | Back up E:/F:/C:/D: target ACLs and run the elevated file+dir sweep (I1 pre-checks) | Read-only |
| A3 | Remove the test-residue ACEs (`isotest\outside` Everyone:F; AppContainer SID ACEs) and the two HKCU AppContainer mappings | E: ACL (staging test dirs) |
| A4 | Create local group `ElevariqIsolatedIdentities` | Machine-wide object |
| **A5** | **Add an inheritable DENY for that group at `E:\` and `F:\`, and explicit DENY at `C:\Download`, `C:\Intel`, `D:\src`, `D:\Intel` and the swept paths** | **Yes: production volume ACLs** |
| A6 | Create, attach and format the VHDX; mount it at `C:\ElevariqStaging`; register the SYSTEM attach-at-boot task | No |
| A7 | Create `elv-stg-worker` and `elv-stg-broker` **disabled**, and add both to the deny group | Machine-wide accounts |
| A8 | Grant `SeBatchLogonRight` and the deny-logon rights through secedit | Local security policy |
| A9 | Install the broker (hash-verified) and register `ElevariqStagingBroker` | No |
| A10 | Create the SID-scoped worker egress rule and the proxy task | Firewall (new rules only) |
| A11 | Enable `elv-stg-worker`; do the one-time Claude login **with the worker's own login** (never a copy of the owner's); then apply its deny-interactive right | No |
| A12 | Register `ElevariqStagingWorker` and run the adversarial matrix (Phase 1, then Phase 2) | No |
| A13 | Independent review of the evidence; only then a status change | — |
| A14 (later) | Move production to an admin-write-only release directory (I9a) | **Yes: production task and deploy** |
| A15 (later, optional) | Replace `AU:M` / `Users:RX` on E:\ and F:\ with an owner-only allow-list (I9b) | **Yes: production volume ACLs** |
| A16 (later) | Move or delete DB snapshots and evidence packages on E: (I9c) | Data hygiene |

Push, merge and deploy are **not** part of any item above.

## 5. Statement

OS-level isolation of the worker from production has **not** been achieved and **has not been demonstrated**. The design above is expected to achieve it within the residual risks in `THREAT_MODEL.md` §5. That remains a hypothesis until AT-01…AT-96 pass on the real account and an independent reviewer accepts the evidence.
