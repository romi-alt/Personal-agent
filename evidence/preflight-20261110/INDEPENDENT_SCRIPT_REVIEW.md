# Independent script review (side-effect inspection)

A second read of the redesigned scripts, focused on side effects that could affect the existing V2 supervisor, as the mandate requires. Result: **no side effect reaches production**; the residual machine-wide effects are enumerated and bounded.

## Account creation (`New-LocalUser`, `Add-LocalGroupMember Users`)
- **Machine-wide effect:** a new enabled local account exists; it is an Authenticated User and a member of `Users`.
- **Could it affect the V2 supervisor?** The supervisor runs as the owner; a new standard account does not change the owner's token, the supervisor process, its task, or its files. **No.**
- **Residual:** the account inherits `Authenticated Users: Modify` on `E:\` (pre-existing grant) → could reach production content at the OS level. Documented; mitigated by keeping the account disabled except during supervised runs; closed only in the separate production-isolation stage.
- **Idempotent:** 01 no-ops if the account exists.

## ACLs (`icacls` on `C:\ElevariqStaging\*` only)
- **Effect:** ACLs set on newly created staging directories only. `/grant:r` replaces per-principal ACEs (idempotent); `/inheritance:r` affects only the staging dir.
- **Production impact:** none — `Assert-StagingPath` throws before icacls runs on anything outside `C:\ElevariqStaging`; verified by the guard test.
- **Exit codes checked** (`Invoke-ElvIcacls`), so a partial failure is a recorded refusal, not a false success.

## Firewall (`New-NetFirewallRule`, SID-scoped, staging prefix)
- **Effect:** three new outbound rules named `ELEVARIQ-STG-Worker-*`, scoped to the worker SID via `-LocalUser`.
- **Global default changed?** **No** — the machine's default outbound action is not modified; only per-SID rules are added.
- **Could it affect the supervisor?** The rules are scoped to the worker SID; the owner/supervisor traffic is not matched. **No.**
- **Idempotent:** removes same-named rules before create.
- **Caveat (unverified on this build):** whether a SID-scoped outbound rule actually constrains *every* child process of the worker cannot be confirmed without applying it and testing as the worker. Marked UNVERIFIED in `FIREWALL_ENFORCEMENT_PLAN.md`; an explicit apply-time test is specified.

## Scheduled task (`Register-ScheduledTask ElevariqStagingWorker`)
- **Effect:** a new task under the worker identity. **Guarded:** 04 and 05 throw if the staging task name equals the production task name.
- **Production task touched?** **No** — different name; `ElevariqPersonalAgent` is never referenced for write.
- **Logon-right dependency (D9):** the task logs on with a password → needs `SeBatchLogonRight` for the worker. This is a **user-right assignment** side effect (machine policy). It is granted narrowly by **adding** the worker SID to the right (merge via `secedit`), never overwriting the policy. Documented as a distinct authorized step; reversible by removing the SID.

## User-right assignment (`SeBatchLogonRight`, manual step)
- **Effect:** machine-wide local policy gains one SID on one right.
- **Risk if done wrong:** overwriting `USER_RIGHTS` could disrupt other logons. The procedure **exports, edits to add only the worker SID, and re-imports just that right** — never a blanket overwrite. Verify by re-export.
- **Supervisor impact:** the supervisor logs on as the owner (interactive/at-boot), unaffected by a batch-logon grant to a different SID. **No.**

## DPAPI credential (`Export-Clixml` under owner)
- Encrypted under the installing (owner) identity; the broker must run as that same identity to decrypt (D6). No production interaction.

## Deletion paths (`Remove-Item -Recurse` in 05)
- Only `C:\ElevariqStaging` after `Assert-StagingPath`. Cannot target production (guard throws). `Assert-NotProduction`/`Assert-StagingPath` both reject prod paths.

## Overall
No reviewed command writes to, deletes, or re-ACLs any production or owner object. The only machine-wide footprints are: one local account, three SID-scoped firewall rules, one scheduled task, and (manual) one user-right SID addition — each named/scoped to staging and individually reversible, none touching the V2 supervisor's identity, process, files, task, DB or env.
