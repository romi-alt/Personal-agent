# Rollback safety (r3, 2026-11-10)

How `09-rollback.ps1` reverses the installation without following junction/reparse escapes, without losing the original
ACL backups, and without leaving orphaned persistence. Addresses M2, M7, M8, M10, L11.

## Order (reverse of install; each step idempotent)

1. **Emergency stop.** Disable both identities; stop their processes; **re-query** and throw if any process remains
   (M7). A still-running worker must not survive into later steps.
2. **Tasks.** Remove the three known tasks **and** every scheduled task whose principal is a staging identity (M7:
   a standard user can register its own tasks). Refuse any task that runs as the owner or is the production task. Assert
   none remains with a staging-identity principal.
3. **User rights.** Remove both identities (SID **and** name forms; SIDs also read from `identities.json`, so a
   deleted account still matches, M8) from the five rights; re-export and assert no staging SID remains (RB0, L3).
4. **Staging volume.** Archive `broker\state` with `robocopy /E /XJ` (never follows junctions, M10); remove the mount
   point with a trailing backslash (L10); detach with `-ErrorAction Stop` (L11); delete the VHDX; delete the staging
   folders, **unlinking any reparse point inside first** (`rmdir` on the junction, which removes the link and never the
   target).
5. **Identities.** Leave the deny group; delete the two accounts and their profiles (only these two SIDs).
6. **Firewall.** Remove every rule under both prefixes, **after** the accounts are gone (M7 ordering: no window where a
   running process has lost its egress restriction but still exists).
7. **Production DENY (opt-in, `-IncludeProductionDeny`, separately authorized).** Only after step 5, and only if the
   deny group has no members. Remove the group's DENY ACE from every target recorded in `deny-targets.json` (M8; the
   built-in list is a fallback only). Compare each root SDDL against the never-overwritten `baseline-root.sddl` from 00
   (M2, RB2). Delete the group.

## Why each escape is closed

- **Junction/reparse escape (M10).** The r2 archive used `Copy-Item -Recurse`, which follows junctions; a compromised
  broker could plant a loop junction (fills the disk) or a junction to admin-readable data (copied into the owner
  profile). r3 uses `robocopy /XJ`. Folder deletion unlinks reparse points before `Remove-Item`, and PS 5.1
  `Remove-Item -Recurse` does not follow a junction as a child or as the item itself (verified in the r2 review and kept
  in r3). `Assert-StagingPath` refuses a path whose components include a reparse point.
- **Backup loss (M2).** The first pre-change root SDDL is `baseline-root.sddl` and is never overwritten; RB2 compares
  against it, not against a possibly-DENY-bearing later copy. A failed full `/save` is an error, not silent.
- **Orphaned persistence (M7).** Tasks are enumerated by principal, not just by the three known names; processes are
  re-checked after Stop; firewall removal is after account deletion.
- **Stale state (M8).** `09` reads `deny-targets.json` and `identities.json`, so it removes exactly what 00/02 applied,
  including any `-AdditionalDenyPaths` and the SIDs of already-deleted accounts.
- **Hidden detach failure (L11).** `Dismount-DiskImage -ErrorAction Stop`; a failed detach stops the rollback with a
  recorded error instead of a later "in use" surprise.

## Fail-safe properties

- Every step is guarded by `Assert-StagingPath` / `Assert-DenyTarget`; the production task name is refused everywhere.
- `trap { Save-ElvReport $report $_ ; break }` means a mid-rollback failure still writes a structured report with the
  error and the applied/again-pending steps.
- RB1/RB2 verify the production DENY removal and the restored baseline when `-IncludeProductionDeny` runs.

## Tested (dry-run, non-elevated)

- §L: `09` and `09 -IncludeProductionDeny` dry-run cleanly, write a dry-run report, record no applied change, and leave
  the system unchanged (users, groups, tasks, firewall count, E:\ and F:\ root SDDL, `.env` SDDL all identical before
  and after).
- The junction-safe archive path (`robocopy /XJ`) and the reparse-unlink-before-delete are named in the dry-run change
  log.

## Not exercised

The live rollback (stopping real processes, deleting accounts/tasks/firewall rules, removing the production DENY and
restoring the baseline) has not run; it needs admin and a real installation to reverse. The dry-run proves the ordering,
the guards, and that nothing is applied without `-Apply`.
