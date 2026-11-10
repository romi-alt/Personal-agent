# Rollback and emergency recovery

## Emergency stop (seconds; always available; no data loss)
The worker cannot prevent this because the owner's identity outranks it.
```powershell
Stop-ScheduledTask -TaskName ElevariqWorker
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*ElevariqWork*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Optional: disable the account so it cannot be re-launched:
Disable-LocalUser -Name elevariq-worker
```
This stops staging only; the production supervisor (PID 8992, `ElevariqPersonalAgent`) is untouched.

## Staged rollback (reverses S1–S5, in safe order)
```powershell
cd E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts
.\05-rollback.ps1            # dry-run: review reports\*.json
.\05-rollback.ps1 -Apply     # elevated
```
`05-rollback.ps1 -Apply` does, in order:
1. Unregister `ElevariqWorker`.
2. Remove the three `ELEVARIQ-Worker-*` firewall rules.
3. **Restore each owner/production path's ACL from the SDDL backup** saved by script 02 (`acl-backups\*.acl.txt`); if no backup, remove only the worker DENY ACE.
4. Remove `C:\ElevariqWork` and `C:\ElevariqBroker` (after `Assert-NotProduction`).
5. Remove the `elevariq-worker` account.

Each step is logged to `reports\05-rollback-*.json` with applied/refused status.

## Partial-failure recovery
- The scripts are **idempotent**: re-running rollback after a partial failure is safe (ACE removal and rule removal tolerate "already gone"; account/dir removal skip if absent).
- If an ACL restore fails for one path, rollback records a refusal and continues; re-run after fixing (e.g. take ownership) to complete.
- The ACL backups let you restore a single path manually:
  ```powershell
  $sddl = (Get-Content -Raw .\acl-backups\E__Agent_Personal-agent.acl.txt).Trim()
  $acl = Get-Acl -LiteralPath 'E:\Agent\Personal-agent'
  $acl.SetSecurityDescriptorSddlForm($sddl); Set-Acl -LiteralPath 'E:\Agent\Personal-agent' -AclObject $acl
  ```

## Manual verification after rollback
```powershell
Get-LocalUser elevariq-worker -ErrorAction SilentlyContinue       # expect: none
Test-Path C:\ElevariqWork, C:\ElevariqBroker                      # expect: False, False
Get-NetFirewallRule -DisplayName 'ELEVARIQ-Worker-*' -ErrorAction SilentlyContinue  # expect: none
icacls E:\Agent\Personal-agent                                    # expect: no worker DENY ACE
(Get-Process -Id 8992 -ErrorAction SilentlyContinue) -ne $null    # expect: True (production unaffected)
```

## What rollback never touches
- Production supervisor PID 8992, the `ElevariqPersonalAgent` task, the production checkout *content*, the production DB, production `.env`, production memory thresholds, Windows itself (no reboot).
- `Assert-NotProduction` throws before any production path would be *modified*; the only production-path change ever made (a worker DENY ACE) is backed up and restored exactly.

## Production incident playbook (if production isolation is later deployed and misbehaves)
Not in scope for the staging pilot. The non-overwriting cutover keeps the old production installation recoverable through its acceptance period; a production rollback would re-point the scheduled task at the prior checkout and restore the pre-cutover DB backup — a separate runbook to be written at that stage.
