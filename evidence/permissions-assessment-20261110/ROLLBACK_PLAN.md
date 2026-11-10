# Rollback plan

Every stage in `ISOLATION_IMPLEMENTATION_PLAN.md` can be reversed on its own, in reverse order. All rollback commands need an elevated shell and run from the owner-only, hash-verified script copy (I0). Nothing here has been executed.

## Emergency stop (any time, about 1 minute)

1. `Disable-LocalUser elv-stg-worker`: no new logons.
2. `Disable-ScheduledTask -TaskName ElevariqStagingWorker`
3. Stop every process whose owner is elv-stg-worker: `Get-Process -IncludeUserName | ? UserName -like '*\elv-stg-worker' | Stop-Process -Force`
4. Network kill switch, scoped to the worker SID: `New-NetFirewallRule -DisplayName 'ELEVARIQ-STG-Worker-EMERGENCY' -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;<WSID>)"`. This rule has no RemoteAddress filter, so it blocks all non-loopback egress for the worker.
5. Check production: PID 8992 is alive, and `git -C E:\Agent\Personal-agent rev-parse HEAD` returns `e60278f…`.

None of these steps touches production.

## Per-stage rollback (reverse order)

| Stage | Rollback | Verify |
|---|---|---|
| I6 worker enabled and task | `Unregister-ScheduledTask ElevariqStagingWorker -Confirm:$false`; `Disable-LocalUser elv-stg-worker` | Task gone; account disabled |
| I5 egress | `Get-NetFirewallRule -DisplayName 'ELEVARIQ-STG-*' \| Remove-NetFirewallRule`; stop the proxy task | No `ELEVARIQ-STG` rules remain. Global profile defaults are unchanged (they were never changed) |
| I4 broker | `Unregister-ScheduledTask ElevariqStagingBroker`; export the audit chain and state to the owner profile for the record, then delete `broker\` | Task gone; audit archived |
| I3 identities and rights | `secedit /configure /db %temp%\rb.sdb /cfg <exported-pre-I3.inf> /areas USER_RIGHTS`; `Remove-LocalUser elv-stg-worker, elv-stg-broker`; delete their profiles with `Get-CimInstance Win32_UserProfile \| ? LocalPath -match 'elv-stg-' \| Remove-CimInstance` | `Get-LocalUser` shows neither account; the rights INF matches the pre-I3 export |
| I2 VHDX | Disable the attach-at-boot task. Remove the mount point (`mountvol C:\ElevariqStaging /D`), then `Dismount-DiskImage -ImagePath C:\ElevariqStagingDisk\elv-staging.vhdx`, then delete the file and both folders | Folders gone; C: free space restored |
| **I1 group DENY (production ACLs)** | First remove both accounts from the group. Then `icacls E:\ /remove:d *<GSID>` and `icacls F:\ /remove:d *<GSID>` (Windows propagates the removal of the inherited copies), and the same for the explicit DENY on `C:\Download`, `C:\Intel`, `D:\src`, `D:\Intel` and any swept paths. Finally `Remove-LocalGroup ElevariqIsolatedIdentities` | `icacls E:\` matches `evidence\icacls-E-root.txt` exactly (same for F:, C:, D:). Sample deep paths have no orphaned SID ACE. The sim script output matches the baseline CSV |
| I1 last-resort restore | **Only if** `/remove:d` fails: `icacls E:\ /restore C:\Users\Roman\ElevariqAdmin\acl\E-full.acl /C`. This rewrites every DACL on the volume, so it is slow; use it only on failure | As above |
| I1 test-residue cleanup (P4/P5) | Not rolled back. It was test residue, and its removal is recorded | — |
| I9 production relocation | `Register-ScheduledTask -Xml (Get-Content evidence\prod-task-ElevariqPersonalAgent.xml -Raw) -TaskName ElevariqPersonalAgent -Force` (asks for the owner's password if required), then start it per `docs/OPERATIONS.md` | The task action points back to E:\; the supervisor restarts |

## Rollback design principles

- **Group, not user, in production ACLs.** Removing one group ACE removes every worker or broker entry. No orphaned per-user SIDs are left in volume ACLs.
- **Remove before restore.** Removing a specific ACE is precise and fast. A full-volume `/restore` is the fallback only.
- **Baselines exist now.** Root ACLs (`evidence\icacls-*-root.txt`), the production task XML, the per-target effective-access CSV and the sweep results were captured **before** any change. They are the comparison set for every rollback verification.
- **Nothing that changes shared global state.** No firewall profile defaults, no UAC or SAC changes, no changes to the Users or Authenticated Users memberships.
- **Production continuity.** No stage stops, restarts or rebuilds the production supervisor, except I9, which has its own rollback above.

Caveat: the baseline files are stored on E:\, which is worker-writable until I1 is applied. Copy `evidence\` and `EVIDENCE_MANIFEST.sha256` to an owner-only location before I1, and check them against the manifest before relying on them.
