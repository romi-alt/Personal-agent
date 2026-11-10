# Windows admin installation guide

**Status: C — requires administrator authorization. These steps are for the owner; the agent does not run them.**

All scripts live in `admin-scripts/`. Every script defaults to `-DryRun $true` (prints proposed changes, makes none), supports `-Apply` (requires elevation), and writes a JSON report to `admin-scripts/reports/`. None modifies production (PID 8992, `E:\Agent\Personal-agent`, the live DB, the `ElevariqPersonalAgent` task).

## Order
1. **Dry-run everything first** (no elevation needed):
   ```
   powershell -File admin-scripts\01-create-worker-account.ps1
   powershell -File admin-scripts\02-configure-acls.ps1
   powershell -File admin-scripts\03-firewall-rules.ps1
   powershell -File admin-scripts\04-worker-task-and-verify.ps1 -Mode verify
   ```
   Review each `reports\*.json`. Confirm the proposed changes are what you want.

2. **Apply, elevated**, in order (each needs an elevated PowerShell):
   ```
   01-create-worker-account.ps1 -Apply        # creates elevariq-worker (standard), stores its cred DPAPI in C:\ElevariqBroker
   02-configure-acls.ps1 -Apply               # worker tree, broker-root DENY, owner/prod DENY for the worker
   03-firewall-rules.ps1 -Apply               # SID-scoped outbound allow/block
   04-worker-task-and-verify.ps1 -Mode register -Apply   # scheduled task under the worker identity
   04-worker-task-and-verify.ps1 -Mode verify            # read-only gate matrix
   ```

3. **Verify** (read-only, any time): `04-...-Mode verify`. It checks the account exists, is not an administrator, the broker root denies the worker, owner `.ssh` denies the worker, and the egress block rule exists. The dry-run of this on the current machine reports all isolation gates **not yet in place** (expected before Apply).

## Rollback
```
admin-scripts\05-rollback.ps1            # dry-run
admin-scripts\05-rollback.ps1 -Apply     # elevated: removes task, firewall rules, DENY ACEs, worker tree, broker root, account
```
Rollback removes only objects these scripts created (by name/SID) and refuses production paths.

## What you still must do by hand (cannot be scripted safely)
- **Claude Code login as `elevariq-worker`:** sign in interactively as the worker account once, so the provider has a subscription login under that identity. Do **not** copy the owner's `~/.claude`. Until this is done, real-CLI execution under the worker is BLOCKED.
- **E:\ ACL:** decide whether to remove `Authenticated Users: Modify` from `E:\` (recommended, targeted — not done by these scripts because a broad E:\ change is risky). The scripts instead add explicit DENY for the worker on the production paths.
- **Egress proxy:** if you want complete per-identity network control, stand up the authenticated outbound proxy referenced by script 03 and point the worker's traffic through it.

## Pre-flight safety checks the scripts enforce
- Apply refuses to run without elevation.
- `Assert-NotProduction` throws before touching any path under the production checkout or the production agent home.
- The worker credential is written DPAPI-protected to the broker root, never echoed to the console or logs.
