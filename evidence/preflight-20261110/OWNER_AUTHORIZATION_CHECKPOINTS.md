# Owner authorization checkpoints (one per privileged step)

Each privileged step is a separate checkpoint. Authorize them one at a time; each is individually reversible. The agent runs none of these. All run from `E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts\`, elevated.

Pre-req for every step: you reviewed `STAGING_ISOLATION_REDESIGN.md`, `INDEPENDENT_SCRIPT_REVIEW.md`, and the dry-run `reports/*.json`. Default mode is `-StagingOnly $true`.

---
## Checkpoint 1 — Create staging account + secured broker root
- **Command:** `.\01-create-worker-account.ps1 -Apply`
- **Privilege:** Administrator (local account creation).
- **System changes:** new standard user `elv-stg-worker`; `C:\ElevariqStaging\` + `C:\ElevariqStaging\broker` created; broker root ACL = owner USER SID + SYSTEM Full; `worker-cred.xml` (DPAPI, owner).
- **Production impact:** none (guarded; verified).
- **Verify:** `Get-LocalUser elv-stg-worker`; `icacls C:\ElevariqStaging\broker`.
- **Rollback:** `.\05-rollback.ps1 -Apply`.
- [ ] **Authorize Checkpoint 1** — signature/date: __________

## Checkpoint 2 — Staging ACLs + synthetic decoys
- **Command:** `.\02-configure-acls.ps1 -Apply`
- **Privilege:** Administrator.
- **System changes:** ACLs on `work` (worker Modify), `broker` (worker DENY), `home` (worker Modify), `decoys` (worker DENY) — **all under `C:\ElevariqStaging`**; synthetic decoy files created.
- **Production impact:** **none** — no production or owner path is read-for-modify or written; `Assert-StagingPath` throws otherwise.
- **Verify:** `icacls C:\ElevariqStaging\broker` (worker DENY); `icacls C:\ElevariqStaging\decoys` (worker DENY); `icacls E:\Agent\Personal-agent` shows **no** `elv-stg-worker` ACE.
- **Rollback:** `.\05-rollback.ps1 -Apply`.
- [ ] **Authorize Checkpoint 2** — signature/date: __________

## Checkpoint 3 — Staging firewall rules
- **Command:** `.\03-firewall-rules.ps1 -Apply`
- **Privilege:** Administrator.
- **System changes:** three SID-scoped outbound rules `ELEVARIQ-STG-Worker-*`. **Global default outbound unchanged.**
- **Production impact:** none (rules match only the worker SID).
- **Verify:** `Get-NetFirewallRule -DisplayName 'ELEVARIQ-STG-Worker-*'`.
- **Rollback:** `.\05-rollback.ps1 -Apply` (removes the rules).
- [ ] **Authorize Checkpoint 3** — signature/date: __________

## Checkpoint 4 — Grant SeBatchLogonRight to the staging worker (manual, merge only)
- **Command:** export `USER_RIGHTS`; add **only** the `elv-stg-worker` SID to `SeBatchLogonRight`; re-import that area (never a blanket overwrite). Exact snippet in `EXACT_ADMIN_COMMANDS.md`.
- **Privilege:** Administrator.
- **System changes:** one SID added to one user right (machine policy).
- **Production impact:** none (supervisor logs on as the owner).
- **Verify:** re-export; confirm the worker SID present.
- **Rollback:** remove the worker SID from the right.
- [ ] **Authorize Checkpoint 4** — signature/date: __________

## Checkpoint 5 — Register the staging worker task
- **Command:** `.\04-worker-task-and-verify.ps1 -Mode register -Apply` then `-Mode verify`.
- **Privilege:** Administrator.
- **System changes:** new task `ElevariqStagingWorker` under the worker identity. **Not** the production task (name-collision guarded).
- **Production impact:** none.
- **Verify:** `-Mode verify` — expect G1/G2/G3/G9 pass and **P0 production task = Running, P1 pid 8992 alive**.
- **Rollback:** `.\04-...-Mode rollback -Apply` or `.\05-rollback.ps1 -Apply`.
- [ ] **Authorize Checkpoint 5** — signature/date: __________

## Checkpoint 6 — Staging home + synthetic DB (owner, non-privileged)
- Create `C:\ElevariqStaging\home` content and seed a **synthetic schema-only** SQLite DB; point a staging broker/supervisor at it and `\\.\pipe\elevariq-broker-staging`.
- **Production impact:** none.
- [ ] **Authorize Checkpoint 6** — signature/date: __________

## Checkpoint 7 — Acceptance as the worker
- Run `ADVERSARIAL_ACCEPTANCE_MATRIX.md` (synthetic decoys) and `WINDOWS_IDENTITY_AND_ACL_VALIDATION.md` **as `elv-stg-worker`**.
- Gate: A-rows enforced by Windows/broker; L-rows succeed.
- [ ] **Authorize Checkpoint 7** — signature/date: __________

## Checkpoint 8 — Real Claude CLI under the worker (BLOCKED until login)
- Needs the worker's own `claude /login` (`CLAUDE_WORKER_AUTHENTICATION.md`). No owner credential copy.
- [ ] **Authorize Checkpoint 8** — signature/date: __________

---
## Emergency stop (any time, no authorization needed)
```
Stop-ScheduledTask -TaskName ElevariqStagingWorker
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*ElevariqStaging*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Disable-LocalUser -Name elv-stg-worker
```
Does not affect production (PID 8992 / `ElevariqPersonalAgent`).

## Production isolation is a SEPARATE future authorization
Closing the `E:\ Authenticated Users: Modify` exposure (so the worker cannot reach real production) is **not** in this pilot. It is authorized separately, only after Checkpoints 1–7 pass and an independent review.
