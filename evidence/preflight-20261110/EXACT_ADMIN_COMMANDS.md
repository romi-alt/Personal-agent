# Exact administrator commands

The owner runs these from an **elevated** PowerShell after reviewing the dry-run reports. Each stage is individually reversible (see `ROLLBACK_AND_EMERGENCY_RECOVERY.md`). The **first authorized run uses staging/synthetic resources only.** The agent does not run any of these.

Scripts: `E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts\`.

## Stage 0 — Dry-run review (no elevation)
```powershell
cd E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts
powershell -File .\01-create-worker-account.ps1
powershell -File .\02-configure-acls.ps1
powershell -File .\03-firewall-rules.ps1
powershell -File .\04-worker-task-and-verify.ps1 -Mode verify
powershell -File .\04-worker-task-and-verify.ps1 -Mode register
powershell -File .\05-rollback.ps1
# Review every reports\*.json. Proceed only if the proposed changes match the plan.
```
Privilege: none. Changes: none. Failure: n/a.

## Stage 1 — Worker account + secured broker root
```powershell
.\01-create-worker-account.ps1 -Apply
```
- **Privilege:** Administrator (local account creation).
- **Changes:** creates standard user `elevariq-worker` (random password, PasswordNeverExpires, Users group only); creates `C:\ElevariqBroker`, ACLs it to owner+SYSTEM, writes `worker-cred.xml` (DPAPI, owner identity).
- **Files:** `C:\ElevariqBroker\worker-cred.xml`.
- **Before/after perms:** broker root goes from default inherited → owner USER SID + SYSTEM Full, inheritance off.
- **Verify:** `Get-LocalUser elevariq-worker`; `icacls C:\ElevariqBroker`.
- **Failure:** throws if not elevated, or if securing the broker root fails (icacls exit checked) — no credential is written on failure.

## Stage 2 — ACLs
```powershell
.\02-configure-acls.ps1 -Apply
```
- **Privilege:** Administrator.
- **Changes:** `C:\ElevariqWork` (worker Modify; owner+SYSTEM Full; inheritance off); `C:\ElevariqBroker` (worker DENY; owner+SYSTEM Full); DENY ACE for the worker on owner `.ssh/.aws/.claude/.config/.git-credentials`, `AppData\Roaming\GitHub CLI`, the production checkout and production agent home. Each target's ACL is **backed up** to `acl-backups\` first.
- **Aborts** if owner SID == worker SID (no separation).
- **Before/after perms:** see `WINDOWS_ACL_CONFIGURATION.md`.
- **Verify:** `icacls C:\ElevariqBroker`; `icacls E:\Agent\Personal-agent` (prior ACEs intact + a worker DENY).
- **Failure:** any icacls nonzero exit is recorded as a refusal; re-runnable (idempotent).

## Stage 3 — Firewall
```powershell
.\03-firewall-rules.ps1 -Apply
```
- **Privilege:** Administrator.
- **Changes:** three SID-scoped outbound rules (allow Anthropic, allow proxy, block other).
- **Verify:** `Get-NetFirewallRule -DisplayName 'ELEVARIQ-Worker-*'`.
- **Failure:** idempotent (removes same-named rules before create).

## Stage 4 — Batch-logon right (defect D9 prerequisite)
```powershell
# Confirm whether the worker already has it (Users often do NOT by default):
secedit /export /areas USER_RIGHTS /cfg "$env:TEMP\ur.inf"; (Select-String "$env:TEMP\ur.inf" SeBatchLogonRight).Line
# If elevariq-worker's SID is absent, grant it (merge, do not overwrite):
#   Create ur-grant.inf adding the worker SID to SeBatchLogonRight, then:
#   secedit /configure /db "$env:TEMP\ur.sdb" /cfg ur-grant.inf /areas USER_RIGHTS
```
- **Privilege:** Administrator.
- **Why:** the worker scheduled task logs on with a password; without `SeBatchLogonRight` it registers but fails to start (logon failure).
- **Verify:** re-export; confirm the worker SID is present.

## Stage 5 — Worker scheduled task
```powershell
.\04-worker-task-and-verify.ps1 -Mode register -Apply
.\04-worker-task-and-verify.ps1 -Mode verify
```
- **Privilege:** Administrator.
- **Changes:** registers `ElevariqWorker` under the worker identity (does **not** touch `ElevariqPersonalAgent`).
- **Verify:** `-Mode verify` gate matrix (G1–G9 subset).

## Stage 6 — Staging home + synthetic DB (owner, non-privileged)
```powershell
# As owner: create the staging agent home under the worker tree and seed a SYNTHETIC schema-only DB.
# Point a staging broker/supervisor at C:\ElevariqWork\staging-home and \\.\pipe\elevariq-broker-staging.
```

## Stage 7 — Acceptance (as the worker)
Run `ADVERSARIAL_ACCEPTANCE_MATRIX.md` and `WINDOWS_IDENTITY_AND_ACL_VALIDATION.md` as `elevariq-worker`. Gate: every A-row enforced by Windows/broker.

## Stage 8 — Real Claude CLI (if B5 done)
`CLAUDE_WORKER_AUTHENTICATION.md` method (1), then Tests A/B/C under isolation.

## Emergency stop (always available to the owner)
```powershell
Stop-ScheduledTask -TaskName ElevariqWorker
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*ElevariqWork*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
Owner > worker, so the worker cannot block this.
