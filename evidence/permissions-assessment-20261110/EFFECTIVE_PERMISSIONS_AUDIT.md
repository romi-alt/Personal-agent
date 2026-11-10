# Effective permissions audit: what a new standard worker account would receive

Assessment date: 2026-11-10. Mode: **READ-ONLY**. No ACL, account, task, firewall rule, process or production object was created or changed.
Baseline: production V2 `e60278f`, supervisor PID 8992 (node, parent powershell 13380 started by task `ElevariqPersonalAgent`), staging worker `elv-stg-worker` **does not exist**, `C:\ElevariqStaging` **does not exist**.

## 1. Method and its limits

The worker account does not exist yet, so its access cannot be measured directly. I **simulated** it:

1. A new enabled standard local account gets these group SIDs in its token. They are automatic and cannot be removed from the account:
   - `Everyone` S-1-1-0
   - `BUILTIN\Users` S-1-5-32-545 (default membership; this one can be removed)
   - `Authenticated Users` S-1-5-11
   - `This Organization` S-1-5-15
   - `Local account` S-1-5-113
   - `LOCAL` S-1-2-0
   - plus `BATCH` S-1-5-3 for a scheduled task, or `INTERACTIVE` S-1-5-4 and `CONSOLE LOGON` for runas or console use.
2. For every target, `Get-Acl` read the real DACL, and the script evaluated the ACEs in order (first match wins per access bit, inherit-only ACEs skipped, generic rights expanded) against that SID set. Delete-or-rename = `DELETE` on the object **or** `FILE_DELETE_CHILD` on its parent.
3. Both token variants (batch and interactive) gave **identical** results on every target.

Script: `evidence/Invoke-WorkerAccessSim.ps1`. Raw output: `evidence/*.csv`.

**Limits, stated plainly.** This is a DACL simulation, not an OS access check. It does not model:
- ACEs naming the future worker SID (none can exist yet);
- privileges (a standard user holds none that bypass DACLs);
- integrity labels beyond recording them;
- SMB, registry or object-manager access.

It shows which **inherited grants exist**. It does **not** prove that any denial works. Every claim of denial must be confirmed by the real-account tests in `ADVERSARIAL_ACCEPTANCE_MATRIX.md`.

## 2. Inherited permission sources (root causes)

| ID | Source | ACE(s) | Reaches |
|---|---|---|---|
| **P1** | `E:\` volume root | `Authenticated Users:(M)` + `(OI)(CI)(IO)(M)`; `Users:(RX)` + `(OI)(CI)(IO)(GR,GE)` | Everything on E:, including all of `E:\Agent`. No directory on E: breaks inheritance except system folders (sweep, §5). |
| **P2** | `F:\` volume root | Identical to E:\ | All F:\ data folders |
| **P3** | `C:\` and `D:\` roots (Windows default) | `Authenticated Users:(AD)` (create folders at root) + `(OI)(CI)(IO)(M)` | **Any folder created at the root of C: or D: inherits AU:Modify**: `C:\Download`, `C:\Intel`, `D:\src`, `D:\Intel`, and the planned `C:\ElevariqStaging` root itself |
| **P4** | Test residue | Explicit `Everyone:(OI)(CI)FullControl` on `E:\Agent\v2-staging\hardening\isotest\outside` | Overrides any future **inherited** DENY (explicit allow is evaluated before inherited deny) |
| P5 | Test residue | Explicit AppContainer SID `S-1-15-2-2956649102-…` RX on `hardening\repo` and `hardening\isotest\tools` | AppContainer test profile only; harmless to the worker, but should be cleaned up |

The worker is an Authenticated User **by construction**. Removing it from `BUILTIN\Users` does not help, because P1 grants Modify to Authenticated Users.

## 3. Effective access of the simulated worker

Legend: **R** read/list, **W** write/create, **D** delete or rename, **DAC** change permissions/owner. "—" = no access.

### 3.1 Production and E:\Agent (all via P1, nothing protected)

| Target | R | W | D | DAC | Consequence |
|---|---|---|---|---|---|
| `E:\Agent` | ✔ | ✔ | ✔ | — | Can create, rename or replace any child, including the whole production checkout |
| `E:\Agent\Personal-agent` (prod checkout, `deploy/v2`@e60278f) | ✔ | ✔ | ✔ | — | Full source/working-tree tampering |
| `…\.env` (production policy) | ✔ | ✔ | ✔ | — | Read **and change** `PLAN_APPROVAL`, `ALLOW_PAID_API`, budgets, `EXECUTION_PROVIDER`, `ENVIRONMENT` |
| `…\.env.bak-20261107` | ✔ | ✔ | ✔ | — | Same |
| `…\.git`, `.git\config`, `.git\hooks` | ✔ | ✔ | ✔ | — | Rewrite history, set `core.fsmonitor` or hooks. **Code runs as whoever next runs git there** (the owner) |
| `…\dist` (the supervisor runs `dist\cli\index.js`) | ✔ | ✔ | ✔ | — | **Code execution as Roman** at the next supervisor start |
| `…\node_modules` | ✔ | ✔ | ✔ | — | Same (dependency planting) |
| `…\scripts\windows\run-supervisor.ps1` (**the action of the production scheduled task**) | ✔ | ✔ | ✔ | — | **Code execution as Roman** at the next logon or time trigger. See §4 |
| `…\package.json`, `.npmrc` | ✔ | ✔ | ✔ | — | npm script hijack |
| `E:\Agent\.claude`, `…\Personal-agent\.claude` (Claude Code settings/hooks) | ✔ | ✔ | ✔ | — | **Code execution as Roman** when the owner opens Claude Code in E:\Agent |
| Other checkouts (`Personal-agent-merge`, `-v2`, `pa-v2-*`) | ✔ | ✔ | ✔ | — | Tamper with code that may later be pushed |
| `E:\Agent\v2-staging\v21-trusted-…\repo\src\security\broker` (**broker source**) | ✔ | ✔ | ✔ | — | **Worker can modify its own approval broker** before it is built or installed |
| `E:\Agent\v2-staging\trusted-execution-…\admin-scripts\*.ps1` | ✔ | ✔ | ✔ | — | **The owner will run these elevated** → worker → administrator. See §4 |
| `E:\Agent\pilot-evidence`, `v2-staging\{deploy,release-readiness,hardening,worker-isolation,rc}` | ✔ | ✔ | ✔ | — | Evidence, manifests and release ZIPs can be forged or deleted |
| **29 SQLite database copies** under E:\Agent (`evidence/e-agent-sensitive-files.csv`), including `release-readiness\…\live-snapshot-v11.db`, `deploy\…\raw-db\agent.db`, `rr\stage\golden\v8-preupgrade.db`, `pilot-evidence\…\closeout\agent-…db` | ✔ | ✔ | ✔ | — | Snapshots of production state (projects, approvals, audit, events) are readable. Rollback baselines can be altered |

All 144 files under `E:\Agent` matching sensitive-name patterns (`.env*`, `*.db`, `*credential*`, `*.pem`, `*token*`, …) are worker **R/W/D** (the file is in evidence).

Secrets in production `.env`: **only the key names were output** (34 keys; none is an API key or token by name). The exposure is **policy integrity**, not credential theft. One example: a worker that sets `PLAN_APPROVAL` off disables owner plan approval.

### 3.2 Other volumes and root folders

| Target | R | W | D | Note |
|---|---|---|---|---|
| `E:\` root and all 18 top-level E: folders/files (business, personal and client data) | ✔ | ✔ | ✔ | P1 |
| `F:\` root and all 17 top-level F: folders | ✔ | ✔ | ✔ | P2 |
| `D:\src`, `D:\Intel` | ✔ | ✔ | ✔ | P3 |
| `C:\Download` (protected ACL, orphaned owner SID from an earlier Windows install) | ✔ | ✔ | ✔ | Holds personal and business documents, a file whose name says it contains **account backup codes**, and **installer .exe files the owner may run** (binary-replacement → code execution as the owner) |
| `C:\Intel` | ✔ | ✔ | ✔ | P3 |
| `C:\ProgramData` | ✔ | create | — | Windows default; worker can create its own subfolders |
| `C:\Users\Public` | ✔ | create | — | Windows default |
| `C:\` / `D:\` root | list | create folders | — | P3 |

### 3.3 Correctly protected today (simulated **NONE**)

These are protected by the **owner profile** ACL `C:\Users\Roman`, which is protected and grants only SYSTEM, Administrators and Roman:

| Target | Worker |
|---|---|
| `C:\Users\Roman` | — |
| `C:\Users\Roman\.claude`, `.claude\.credentials.json`, `.claude.json` (**owner Claude credentials**) | — |
| `AppData\Roaming\Microsoft\Protect` (DPAPI master keys), `…\Credentials` (Roaming + Local) | — |
| `AppData\Local\ElevariqAgent` (**production home**): `agent.db`, `-wal`, `-shm`, `backups\`, `workspaces\`, `logs\`, `run\`, `notifications.*` | — |
| `C:\Users\Roman\.local\bin` (on the owner's PATH) | — |
| `C:\Program Files\nodejs`, `node.exe`, `C:\Program Files\Git\cmd`, `WindowsPowerShell\v1.0` | read/execute only |

`.ssh`, `.gitconfig`, `.git-credentials` and `AppData\Roaming\npm` do not exist. Git uses the system `credential.helper manager` (Windows Credential Manager, per-user and DPAPI-protected), which is not readable cross-user.

## 4. Privilege-escalation surface (higher-privileged code reading worker-writable files)

The scan covered **204 scheduled tasks**, all services, HKLM/HKCU Run keys, and machine and user PATH (`evidence/escalation-surface.csv`).

| ID | Finding | Severity |
|---|---|---|
| **E1** | Task `\ElevariqPersonalAgent` runs as **Roman** (a local administrator; RunLevel Limited; logon and time triggers; state Running). Its action is `powershell.exe -File E:\Agent\Personal-agent\scripts\windows\run-supervisor.ps1`, and both the file and its directory are worker-writable. The script then starts `node E:\…\dist\cli\index.js`, also worker-writable. UAC is at the default `ConsentPromptBehaviorAdmin=5`, and Microsoft does not treat UAC as a security boundary. **Code running as Roman is effectively administrator.** | **CRITICAL** |
| **E2** | The 5 privileged admin scripts (`01`…`05`, `_common.ps1`) are worker-writable, and the plan is for the **owner to run them elevated**. | **CRITICAL** |
| E3 | Owner tooling auto-executes worker-writable configuration: `.claude\settings*.json` hooks, `.git\config` (`core.fsmonitor`, `core.hooksPath`), `.git\hooks\*`, and `package.json` scripts. Git's `safe.directory` check does **not** help, because the files stay owned by Roman after the worker modifies them. | HIGH |
| E4 | Installers in `C:\Download` are worker-replaceable. | MEDIUM |
| — | Services with worker-writable binaries: **none**. Writable PATH directories: **none**. `AlwaysInstallElevated`: not set. Unquoted service paths outside `C:\Windows`: none. Smart App Control state = 1 (enforced; blocks unsigned executables but not scripts). | info |

Note: E1–E3 do not depend on the worker. **Any** principal holding Authenticated Users can use them today. Windows service accounts such as LOCAL SERVICE and NETWORK SERVICE normally carry Authenticated Users too (confirm with `whoami /groups` in such a context). This is a **pre-existing local privilege-escalation path**.

## 5. Sweeps for exceptions

- `E:\Agent` objects with explicit or protected ACLs: 3 (`evidence/e-agent-acl-exceptions.csv`), namely P4 and P5.
- Directory sweep of `E:\`, `F:\`, `D:\src` and `C:\Download`: **36,558 directories**. Explicit broad allows (Everyone/Users/AU/Interactive/Batch/Local account) were found only on `E:\$RECYCLE.BIN`, `F:\$RECYCLE.BIN` (Users, system default) and **`…\hardening\isotest\outside` (Everyone Full, P4)**. 16 directories were unreadable to the non-elevated owner: System Volume Information, and recycle-bin folders of 12 old SIDs from earlier Windows installs.
- **Not swept:** explicit ACEs on individual **files**. The implementation plan requires a file-level sweep (elevated) before any DENY is relied on.

## 6. Answer to the assignment's question

A newly created standard worker account **would** inherit read, write, delete and rename access to:
- the production checkout, production `.env`, the production repository, the supervisor's executable code, and the production task's action script;
- the admin scripts, the broker source code, and every evidence package and DB snapshot on E:;
- all user data on E:, F:, `D:\src` and `C:\Download`.

That gives it **two direct paths to the owner's identity, and from there to administrator** (E1, E2).

It would **not** reach the owner's Claude credentials, DPAPI keys, Credential Manager, the live production DB, or production backups/workspaces/logs, all of which sit inside `C:\Users\Roman`. That is a simulation result and still needs real-account confirmation.

This violates the least-privilege requirement. **No worker account should be enabled on this machine until P1–P4 are neutralized for that identity.**
