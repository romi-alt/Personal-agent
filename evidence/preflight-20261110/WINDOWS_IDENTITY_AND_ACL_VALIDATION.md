# Windows identity and ACL validation procedures

Read-only verification to run **after** the ACLs are applied (S2), most of it **as the worker account** so it tests the real token, not a simulation. None of this is run in this preflight (the worker account does not exist yet).

## Measured now (this machine, unprivileged)
- Owner `Roman`: SID `S-1-5-21-3837883729-3478098758-1729361560-1001`, split-token administrator.
- `BUILTIN\Administrators` in the owner token: **"Group used for deny only"** → confirms defect D3 (an Allow ACE for Administrators grants a non-elevated process nothing; the owner USER SID must be granted).
- `E:\` grants `Authenticated Users: Modify`, inherited by the production checkout.
- Secondary Logon service: Stopped/Manual (affects `runas` convenience, not the scheduled-task path).

## Verification procedure (post-apply)

### Identity and privileges (run AS the worker)
```
whoami /user          # expect the elevariq-worker SID
whoami /groups        # expect BUILTIN\Users; NOT Administrators
whoami /priv          # expect NO SeDebug/SeImpersonate/SeBackup/SeRestore/SeTakeOwnership/SeLoadDriver
```
Pass: standard user, no sensitive privileges.

### Effective access token (run AS the worker)
```
# Each of these MUST fail with Access Denied:
Get-Content C:\ElevariqBroker\audit\*.chain.jsonl
Get-Content C:\ElevariqBroker\worker-cred.xml
Get-Content $ownerProfile\.ssh\id_*               # owner SSH keys
Get-Content $ownerProfile\.claude\.credentials.json
Get-ChildItem E:\Agent\Personal-agent             # production checkout
# This MUST succeed:
New-Item C:\ElevariqWork\<task>\probe.txt
```

### NTFS inheritance and parent-write (run elevated, read-only)
```
icacls C:\ElevariqBroker    # expect: worker SID (N) deny; owner SID + SYSTEM (F); no Users/Authenticated Users
icacls C:\ElevariqWork      # expect: worker SID (M); owner SID + SYSTEM (F); inheritance disabled
icacls E:\Agent\Personal-agent   # expect: an added DENY for the worker SID; every prior ACE intact
```
Check the worker cannot write the PARENT of its workspace (so it cannot redirect a junction at the parent).

### Link handling (run AS the worker, synthetic targets)
- Create a junction and a symlink inside the workspace pointing at `C:\ElevariqBroker` and at the owner profile; confirm a read through them is **denied by NTFS** (the ACL follows the real object), not merely by the app path check.
- Create a hard link inside the workspace to an owner-only file; confirm the DENY ACE on the target blocks the read (a hard link shares the target's ACL, so the broker-root/owner DENY still applies — this is the OS-level answer to the app-level hard-link residual).

### Named-pipe ACL and caller auth (run AS the worker)
- Connect to `\\.\pipe\elevariq-broker-staging`; confirm the broker reads the client's SID via `GetNamedPipeClientProcessId`/token and **rejects** a request whose claimed `workerId` ≠ the connecting SID.
- Confirm a second process under a *different* SID cannot impersonate the worker.

### Broker / credential / audit-key isolation
- As the worker: attempt to read the signing key and the grant store under `C:\ElevariqBroker` → Access Denied.
- As the worker: attempt to write `C:\ElevariqBroker\audit\*.chain.jsonl` → Access Denied (so audit forgery is OS-blocked, upgrading tamper-evidence to tamper-resistance).

### Process ownership
```
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ... GetOwner()   # worker procs owned by elevariq-worker
```
Confirm worker processes run as `elevariq-worker`, broker/supervisor as the owner.

### Windows Firewall
See `FIREWALL_ENFORCEMENT_PLAN.md` for the egress tests.

## Pass criteria
A row passes **only** when Windows (ACL/token) or the broker enforces it — a model refusal or app-level path check does not count. Results feed `ADVERSARIAL_ACCEPTANCE_MATRIX.md`.
