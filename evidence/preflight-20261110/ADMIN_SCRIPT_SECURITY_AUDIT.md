# Admin script security audit

Audited: `E:\Agent\v2-staging\trusted-execution-20261110-0249\admin-scripts\` (01–05 + `_common.ps1`). Parsing clean was not treated as safe. Each script was read line by line against the mandate's 10 checks. **Defects found are fixed in place and re-dry-run verified; no script was executed in Apply mode.**

## Defects found and fixed

| # | Severity | Script | Defect | Fix |
|---|---|---|---|---|
| D1 | **High** | 02, 05 | `& icacls … \| Out-Null` never checks the native exit code. icacls does not throw, so a failed ACL change was recorded as `applied=true`. Partial failure = silent, and the report would falsely claim success. | New `Invoke-ElvIcacls` runs icacls, checks `$LASTEXITCODE`, records a refusal on nonzero, returns success/failure. |
| D2 | **Medium** | 02 | Not idempotent: `icacls /deny` appends an ACE each run, so re-running stacks duplicate DENY ACEs. | New `Clear-ElvPrincipalAces` removes the principal's prior grant/deny ACEs before (re)adding. |
| D3 | **High** | 02 | Broker root granted only `SYSTEM` + `BUILTIN\Administrators`. **Confirmed empirically:** `Administrators` is *"Group used for deny only"* in the owner's standard token, so an Allow ACE for it grants a non-elevated broker **nothing** — the broker would be locked out of its own signing key and approvals. | Grant the owner's **user SID** explicitly (`Get-ElvOwnerContext` resolves it); abort if owner SID == worker SID (no separation). |
| D4 | **Medium-High** | 02 | Owner paths taken from ambient `$env:USERPROFILE`/`$env:APPDATA`. If a *different* administrator runs the script, these resolve to that admin's profile, so the DENY lands on the wrong profile and the owner's real `.ssh`/`.claude` stay unprotected. | Resolve the owner's profile from `ProfileList\<SID>` in the registry, by SID, not ambient env. |
| D5 | **Medium** | 02, 05 | No backup of existing ACLs before applying DENY, so rollback could only approximate the prior state. | `Backup-ElvAcl` saves each target's SDDL before change; rollback restores the exact SDDL, falling back to ACE removal only if no backup exists. |
| D7 | **Medium** | 01 | `worker-cred.xml` (recoverable worker password) was written to `C:\ElevariqBroker` **before** script 02 locked that directory, leaving a window under default inherited ACLs. | 01 now resets the broker-root ACL to owner+SYSTEM *before* writing the credential, and checks the icacls exit code. |

## Defects found and DOCUMENTED (not auto-fixed; owner action or inherently manual)

| # | Severity | Where | Issue | Disposition |
|---|---|---|---|---|
| D6 | High | 01 / design | DPAPI credential is encrypted under the identity that runs script 01. If the broker later runs as a *different* identity (e.g. SYSTEM) it cannot decrypt it. | Documented constraint: the broker must run as the **same owner identity** that created the credential, or re-encrypt the cred under the broker identity. Stated in `CLAUDE_WORKER_AUTHENTICATION.md` and the install guide. |
| D9 | High | 01/04 | The worker scheduled task logs on with a password, which requires the **"Log on as a batch job"** right (`SeBatchLogonRight`). Nothing grants it. On a machine where `BUILTIN\Users` lacks it, the task registers but fails to start (logon failure 2147943785). `secedit /export` needs elevation, so the current right could not be read in this unprivileged preflight. | Added as an explicit **prerequisite + verification step** in `EXACT_ADMIN_COMMANDS.md` (grant via `secedit`/`ntrights`) and a gate in the owner checklist. |
| D10 | Low | broker.ts | `seenRequests` set grows unbounded over a long-running broker (memory, not security). | Noted in `BROKER_INTEGRATION_REVIEW.md`; bounded-set fix proposed, low priority. |
| D11 | Low | 03 | Firewall allow-list is address-based; DNS→IP resolved at apply time can drift. | Already documented in `FIREWALL_ENFORCEMENT_PLAN.md`; the real fix is the egress proxy. |

## The 10 mandated checks — result per check

1. **Commands & resources affected** — enumerated in `EXACT_ADMIN_COMMANDS.md` (accounts, `C:\ElevariqWork`, `C:\ElevariqBroker`, owner profile DENY ACEs, production-checkout DENY ACE, firewall rules, scheduled task).
2. **Dry-run cannot modify** — verified: every script's dry-run path only calls `Add-ElvChange`; the Apply branches are gated on `-Apply`/elevation. Re-run after fixes: 0 system objects created, 0 ACL backups written.
3. **Elevated operations inspected** — account creation, icacls, firewall, task registration; each requires elevation and is listed with its exact effect.
4. **Identities & SIDs** — worker SID resolved via `Get-LocalUser`; owner SID `S-1-5-21-3837883729-3478098758-1729361560-1001`; SYSTEM `S-1-5-18`; Administrators `S-1-5-32-544` (confirmed deny-only in the owner token → D3).
5. **Unintended inheritance / broad permissions** — `/inheritance:r` only on the two agent-created trees; DENY ACEs scoped to the worker principal; **the broad `E:\ Authenticated Users: Modify` grant is reported, not touched** (a drive-wide change is out of scope); targeted production-checkout DENY is the compensating control.
6. **Risks to production V2** — `Assert-NotProduction` throws before any path under the production checkout or agent home is *modified*; the only production touch is adding a worker-DENY ACE to the checkout (worker cannot reach it), with the ACL backed up first. No production file content, process, task or DB is changed.
7. **Idempotency** — fixed (D2): ACEs cleared before re-adding; `New-Item -Force` and `Remove-NetFirewallRule` before create make 03/04 idempotent.
8. **Rollback fidelity** — fixed (D5): exact SDDL restore; 05 removes only objects these scripts created, by name/SID, and refuses production paths.
9. **Error handling / partial failure** — fixed (D1): icacls exit codes checked; 01 throws if it cannot secure the broker root before writing the credential; firewall/task use try/remove-before-create.
10. **Independent auditability** — every script writes a timestamped JSON report (`reports/*.json`) listing each change, whether applied, and refusals; ACL backups under `acl-backups/`.

## Verification performed in this preflight (unprivileged, read-only)
- Re-parsed all scripts: 0 parse errors.
- Dry-ran 01, 02, 03, 04 (verify + register), 05: logs in `evidence/dryrun-*.log`, reports in `evidence/*.json`.
- Confirmed afterward: no worker account, no `C:\ElevariqWork`, no `C:\ElevariqBroker`, no `ElevariqWorker` task, no ACL backups — i.e. dry-run changed nothing.
- Confirmed the D3 filtered-token behavior directly (`whoami /groups` → Administrators "deny only").
