# Isolation implementation plan (design only, nothing here has been executed)

Every command below is a **proposal** for the owner to review. Each stage is a separate administrator authorization (see `FINAL_SECURITY_VERDICT.md` §4). Placeholders: `<GSID>` = the SID of group `ElevariqIsolatedIdentities`, `<WSID>` = elv-stg-worker, `<BSID>` = elv-stg-broker, `<OSID>` = Roman (`S-1-5-21-3837883729-3478098758-1729361560-1001`).

## Stage order (it matters)

```
I0 freeze & verify scripts ─► I1 deny group + volume DENY ─► I2 staging VHDX ─► I3 identities (disabled)
   ─► I4 broker install ─► I5 egress ─► I6 enable worker, its own Claude login ─► I7 adversarial matrix
   ─► I8 independent review ─► (only then) any claim of OS isolation
Later, separately: I9 production hardening (relocate prod runtime; optional allow-list C′)
```

**Changed from the previous preflight:** the earlier plan deferred the E:\ exposure to a later PRODUCTION_ISOLATION_STAGE and allowed an enabled worker before that. That ordering is **withdrawn**. An enabled worker under today's ACLs can rewrite the production task's script and the admin scripts (E1/E2), which gives owner and then administrator compromise. I1 must come **before** any worker logon.

---

## I0. Freeze the privileged scripts (no admin needed; owner action)

Problem E2: the admin scripts sit in a directory every Authenticated User can write.

1. Revise the scripts per §R below. Review them in a separate session.
2. Copy the reviewed scripts to an owner-only location, for example `C:\Users\Roman\ElevariqAdmin\<date>\`, which inherits the protected profile ACL. Record their SHA-256 in an owner-only manifest.
3. Before every `-Apply`, from the elevated shell, re-hash the copies and compare them to the manifest. **Never run admin scripts from E:\.**

## I1. Deny group and volume DENY (admin; touches production ACLs; the owner must authorize it explicitly)

Pre-checks (elevated, read-only):
```powershell
# 1. Back up current ACLs (root only, then the full trees) - restore material for ROLLBACK_PLAN R1
icacls E:\ /save C:\Users\Roman\ElevariqAdmin\acl\E-root.acl
icacls F:\ /save C:\Users\Roman\ElevariqAdmin\acl\F-root.acl
icacls "E:\*" /save C:\Users\Roman\ElevariqAdmin\acl\E-full.acl /T /C /Q
icacls "F:\*" /save C:\Users\Roman\ElevariqAdmin\acl\F-full.acl /T /C /Q
foreach ($p in 'C:\Download','C:\Intel','D:\src','D:\Intel') { icacls $p /save "C:\Users\Roman\ElevariqAdmin\acl\$($p -replace '[:\\]','_').acl" /T /C /Q }
# 2. FILE + DIR sweep for explicit broad ALLOWs and protected DACLs (would defeat an inherited DENY)
#    (extend evidence\Invoke-WorkerAccessSim.ps1 sweep to files; run elevated so nothing is unreadable)
```
Known item to fix first: `E:\Agent\v2-staging\hardening\isotest\outside` has an explicit `Everyone:(OI)(CI)F` (test residue). Delete that test folder, or `icacls <path> /remove:g *S-1-1-0`. Also remove the AppContainer residue ACEs (P5) and the two HKCU AppContainer mappings noted in the earlier hardening work.

Apply:
```powershell
New-LocalGroup -Name ElevariqIsolatedIdentities -Description 'Worker/broker identities: denied all owner data volumes'
$g = (Get-LocalGroup ElevariqIsolatedIdentities).SID.Value
foreach ($root in 'E:\','F:\') {
  icacls $root /deny "*${g}:(OI)(CI)F"; if ($LASTEXITCODE) { throw "icacls $root failed" }
}
foreach ($p in 'C:\Download','C:\Intel','D:\src','D:\Intel') {   # AU-modifiable root folders (P3)
  icacls $p /deny "*${g}:(OI)(CI)F"; if ($LASTEXITCODE) { throw "icacls $p failed" }
}
# plus every protected/explicit-allow path the sweep found
```
- **Effect on existing principals: none.** The group is empty, and a DENY for an empty group matches no token.
- Propagation: icacls writes the inheritable ACE on the root, and Windows propagates the inherited copy to every child. This is a one-off metadata write over about 36.5k directories plus their files. Run it while production is idle. It changes no file contents.

Verify (elevated):
- `icacls E:\Agent\Personal-agent\scripts\windows\run-supervisor.ps1` shows `ElevariqIsolatedIdentities:(I)(DENY)(F)`. Spot-check about 20 random deep paths, and every path the sweep flagged.
- The owner can still read and write production. PID 8992 is alive. `git -C E:\Agent\Personal-agent status` works.
- Re-run the sweep: 0 explicit broad allows, 0 protected directories without the DENY.

## I2. Size-capped staging volume (VHDX) mounted at `C:\ElevariqStaging` (admin)

```powershell
New-Item -ItemType Directory C:\ElevariqStagingDisk, C:\ElevariqStaging
icacls C:\ElevariqStagingDisk /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls C:\ElevariqStaging     /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*<OSID>:(OI)(CI)F"
@'
create vdisk file="C:\ElevariqStagingDisk\elv-staging.vhdx" maximum=40960 type=expandable
attach vdisk
create partition primary
format fs=ntfs label=ELVSTG quick
assign mount="C:\ElevariqStaging"
'@ | Set-Content -Encoding ascii C:\Users\Roman\ElevariqAdmin\vhdx.txt
diskpart /s C:\Users\Roman\ElevariqAdmin\vhdx.txt
# A freshly formatted volume root carries EXPLICIT AU:M / Users:RX / CREATOR OWNER ACEs: strip them (not just /inheritance:r)
icacls C:\ElevariqStaging /inheritance:r /remove:g *S-1-5-11 *S-1-5-32-545 *S-1-3-0 *S-1-1-0
icacls C:\ElevariqStaging /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*<OSID>:(OI)(CI)F"
```
- A cap of 40 GB means a runaway worker can fill only this volume.
- Attaching it at boot needs a SYSTEM startup task (`Mount-DiskImage -ImagePath … -NoDriveLetter`). Confirm after a reboot that the mount point survives.
- This replaces the plain folder in the current scripts and fixes F-10a, where the root would inherit AU:M from C:\.

Layout inside the volume (applied by the revised 02, all `/inheritance:r`):

| Dir | Worker | Broker | Owner | SYSTEM/Admins |
|---|---|---|---|---|
| `work\`, `home\` | M | — | F | F |
| `broker\bin\` (broker code, hash-verified) | — | RX | F | F |
| `broker\state\` (approvals db, audit chain, config) | **explicit DENY** | M | F | F |
| `spool\requests\` | W (create/write own files) | M | F | F |
| `spool\approvals\` | **explicit DENY** | RX + D (consume) | M | F |
| `spool\decisions\` | RX | M | F | F |
| `decoys\` (synthetic look-alikes) | **explicit DENY** | — | F | F |

## I3. Identities, created disabled (admin)

```powershell
New-LocalUser elv-stg-worker -Password (Read-Host -AsSecureString) -AccountNeverExpires -UserMayNotChangePassword -Disabled
New-LocalUser elv-stg-broker -Password (Read-Host -AsSecureString) -AccountNeverExpires -UserMayNotChangePassword -Disabled
Add-LocalGroupMember ElevariqIsolatedIdentities -Member elv-stg-worker, elv-stg-broker
# Verify membership BEFORE enabling either account.
```
User rights (`secedit /export` → edit → `/configure /areas USER_RIGHTS`; keep the exported INF for rollback):
- `SeBatchLogonRight` += `<WSID>`, `<BSID>`
- `SeDenyRemoteInteractiveLogonRight`, `SeDenyNetworkLogonRight` += both
- `SeDenyInteractiveLogonRight` += `<BSID>` now, and += `<WSID>` **after** the worker's one-time Claude login (I6)

## I4. Broker under its own identity (admin to install; revises preflight D6)

- **Identity:** `elv-stg-broker`. It is not the owner (an administrator) and not the worker. Even a compromised broker then has no admin rights and no owner credentials.
- **Code:** a release build copied into `broker\bin\`, verified by SHA-256 against the reviewed commit. Only Administrators can write there; the broker has RX. **The broker cannot modify its own code.**
- **Runtime:** `C:\Program Files\nodejs\node.exe`, which only Administrators can write. The task is `ElevariqStagingBroker` (run as `<BSID>`, batch). Its XML lives in `C:\Windows\System32\Tasks`, which is admin-only.
- **Signing key:** generated on first start inside the broker's own context and stored with DPAPI CurrentUser protection under `elv-stg-broker`. Node has no DPAPI, so a small PowerShell wrapper running as the broker unprotects the key and passes it to node on stdin. The worker cannot read the broker profile or `broker\state\`.
- **Approvals:** the owner writes approval files to `spool\approvals\`, which only the owner and admins can write. The broker accepts a file **only if its NTFS owner SID equals `<OSID>`**. A worker cannot create files owned by another SID without SeRestorePrivilege. Approvals stay single-use and action-bound (`approval-grant.ts`).
- **Audit:** append-only through the broker, HMAC-chained, under `broker\state\`. An owner-side task copies the chain head (sequence and hash) to an owner-only location so that truncation is detectable.
- **Transport:** file spool, not a named pipe. Node cannot set a DACL on `\\.\pipe\…` servers, and the default pipe DACL gives Everyone read access.

## I5. Egress for the worker SID (admin)

Corrections to the existing `03-firewall-rules.ps1` (finding F-10c):
- Windows Defender Firewall **block rules take precedence over allow rules**. `Allow-Anthropic` plus `Block-Any` therefore blocks everything.
- `-RemoteAddress` takes IPs, ranges or keywords, not host names, so `api.anthropic.com` is expected to be rejected.
- `New-NetFirewallRule` errors are not checked, so the report could say "created" when nothing was created.

Corrected design:
1. A **single block rule** for `-LocalUser "D:(A;;CC;;;<WSID>)"`, outbound, with `RemoteAddress` = every IPv4 range **except 127.0.0.0/8**, plus all IPv6 except `::1`. Verify with `Get-NetFirewallRule … | Get-NetFirewallAddressFilter` and with `-ErrorAction Stop`.
2. A **loopback egress proxy** running as `elv-stg-broker`, so it is not subject to the worker rule, with a hostname allowlist: the Anthropic API and the auth endpoints the Claude CLI actually uses, captured during I6. The worker gets `HTTPS_PROXY=http://127.0.0.1:<port>`. Direct egress fails at the firewall whether or not the worker honours the variable.
3. **Residuals to record:**
   - DNS queries are made by the Dnscache service (NETWORK SERVICE), not the worker SID, so low-bandwidth DNS exfiltration stays possible.
   - The firewall does not filter loopback; that is confirmed or refuted by AT-76.

## I6. Enable the worker and give it its own Claude login (admin + owner)

1. `Enable-LocalUser elv-stg-worker`.
2. `runas /user:elv-stg-worker cmd`, then `claude` login with the worker's **own** login (G12). **Never copy `C:\Users\Roman\.claude`.**
3. Add `<WSID>` to `SeDenyInteractiveLogonRight`.
4. Register `ElevariqStagingWorker` (batch, Limited, `<WSID>`). Its action points to code in `C:\ElevariqStaging\work\bin`, which the worker may write. That is acceptable because the task runs **as the worker**.
5. The supervisor launches worker processes inside a **Job Object** with a memory cap (residual AP-10). This is a code change, tracked separately.

## I7–I8. Adversarial matrix and independent review

Run `ADVERSARIAL_ACCEPTANCE_MATRIX.md` under the real account. A different session or person reviews the raw result files. Only then may the verdict say "OS-level isolation demonstrated (staging scope)".

## I9. Later, separate authorization: production hardening

- **I9a. Fix E1 for all principals, not only the worker.** Install production releases to `C:\Program Files\ElevariqAgent\releases\<commit>`, where only Administrators can write. Point the task action there. Keep the DB in the owner profile. This closes the pre-existing T3 path.
- **I9b. Optional C′ allow-list.** Replace `AU:M` and `Users:RX` at E:\ and F:\ with `<OSID>:F`. This fails closed for every future identity.
- **I9c.** Move evidence packages and DB snapshots off E:\ or behind the owner-only ACL, and delete DB copies that are no longer needed (29 today).

---

## §R. Required revisions to the existing admin scripts before any `-Apply`

| ID | Script | Defect | Required change |
|---|---|---|---|
| R-1 | (new) `00-isolation-group-deny.ps1` | The production DENY is missing and is now a prerequisite | I1, with sweep, backups, `$LASTEXITCODE` checks and verification |
| R-2 | `01` | `C:\ElevariqStaging` is created by `New-Item` and **never ACL'd**, so it inherits AU:Modify from `C:\` (F-10a) | Build the VHDX root per I2; strip explicit AU/Users/CREATOR OWNER ACEs |
| R-3 | `01` | Creates the account enabled, without group membership | Create disabled → add to the deny group → verify → enable only in I6 |
| R-4 | `04` | The G3/G4 regex `"$script:ElvWorkerAccount:\(N\)"` expands to `\(N\)` in PS 5.1 (**verified**), so it matches any principal with `(N)`. Both checks also read icacls **text** rather than testing access | Use `${script:ElvWorkerAccount}` and replace both with real access probes under the worker token (AT matrix) |
| R-5 | `03` | Block-overrides-allow; host name in `RemoteAddress`; unchecked errors (F-10c). The header comment describes image-based rules, but the code uses SID rules | I5 design |
| R-6 | `02`, `_common` | The broker runs as the owner (D6) | Use the `elv-stg-broker` identity and the I2 layout |
| R-7 | all | Run from E:\, which is AU-writable | Run only from an owner-only, hash-verified copy (I0) |
| R-8 | `05` | Does not know about the deny group, the VHDX, the broker identity or the user rights | Extend per `ROLLBACK_PLAN.md` |

These defects are documented here. **I did not edit the scripts**, because that would invalidate their earlier hash manifest and review. The revision should be done and reviewed as its own step.
