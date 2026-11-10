# Windows worker isolation design

**Status: C — requires administrator authorization. The design is complete; nothing is applied.**

## Goal
Make the broker, capability model and audit chain into real security boundaries by running the worker under a Windows identity that is distinct from, and weaker than, the owner.

## Measured baseline (this machine, read-only)
- Owner account `Roman`: split-token administrator (member of Administrators, deny-only in the standard token; Medium IL).
- Worker today runs as the owner → same-user. Executed baseline: **27/27 attacks succeed** (credentials, DB writes, self-approval, policy widening, audit forge/delete, workspace escape, network).
- `E:\` grants **Authenticated Users: Modify**, inherited by the production checkout — any second local account could modify production until fixed.
- Outbound firewall default: Allow (NotConfigured) on all profiles.
- Smart App Control: **Enforced** — blocks unsigned locally compiled executables. (It does allow PowerShell's in-box C# compiler and .NET P/Invoke, so Job Objects and named pipes need no new binary.)
- `seclogon` (Secondary Logon) service: Stopped/Manual.
- Disposable-VM / Hyper-V feature state: needs elevation to query (not determined).

## Chosen mechanism and why
| Mechanism | Guarantee | Fit here | Decision |
|---|---|---|---|
| **Dedicated standard local user** + NTFS ACLs | OS-enforced identity and file boundary | Works on this SKU; no new signed binary needed | **Primary** |
| Windows Job Object | Resource caps, kill-on-close, child containment | Available via P/Invoke from PowerShell/Node; **not a security sandbox** on its own | **Supporting** (limits + child kill) |
| AppContainer | Deny-by-default capability sandbox | Prototyped earlier: Node piped child processes spin; SAC blocked the unsigned launcher | **Rejected** for Node workers |
| Windows Sandbox / Hyper-V | Strong VM isolation | Feature state unknown (needs elevation); heavy for per-task | **Optional future**, documented not chosen |
| Restricted/AppContainer token via `CreateProcessAsUser` | Drops privileges/groups | Needs `SeAssignPrimaryToken`/`SeImpersonate`; brittle | **Rejected** in favor of a real account |

Primary design: a **dedicated standard user `elevariq-worker`**, launched by a scheduled task under its own credentials, with NTFS ACLs that deny it the owner profile, credentials, broker root, production checkout and agent home; a Job Object for resource/child limits; and SID-scoped firewall rules.

## Identities
- **Owner (`Roman`):** approves, deploys, can stop the worker. Holds personal files and credentials.
- **Supervisor / broker (owner or SYSTEM):** owns `C:\ElevariqBroker` (approvals, audit, signing key), the authoritative DB, policy. The worker cannot modify it.
- **Worker (`elevariq-worker`, standard):** no admin, no owner profile, no broker access, confined to `C:\ElevariqWork\<task>`.

## Worker privilege removal (script 01 reports; a rights step applies)
Deny to the worker: SeDebug, SeImpersonate, SeAssignPrimaryToken, SeBackup, SeRestore, SeTakeOwnership, SeLoadDriver, SeCreateGlobal, SeCreateService, SeSystemtime, Se(Remote)Shutdown. A standard user lacks most already; the rights step makes it explicit via `secedit`/`ntrights` (documented in the installation guide).

## Separate profile and environment
Worker gets its own `USERPROFILE`, `APPDATA`, `TEMP`, Claude config dir, git config and cache under `C:\ElevariqWork`. The launcher builds an **allowlist** environment: it does not inherit the owner's env wholesale, and it strips credential-helper config, SSH agent vars, `CLAUDE_CONFIG_DIR`/token vars, and owner-specific paths.

## Claude CLI under the worker identity — BLOCKED gate (D)
Provisioning a Claude Code subscription login under `elevariq-worker` through a supported mechanism is **not possible without an interactive login as that account**, and copying the owner's `~/.claude` credentials into the worker profile is explicitly forbidden (it would re-expose the credential the isolation exists to protect). Therefore **real-CLI execution under the worker identity is BLOCKED** until the owner performs a supported login as the worker account. Do not work around this.

## Process and network containment
- **Job Object:** max active processes, memory cap, kill-on-job-close so orphaned children die with the worker; wall-clock enforced by the supervisor.
- **Network:** SID-scoped outbound firewall rules (script 03) allowing only the provider API and an owner-run egress proxy, blocking the rest. Honest gap: image-based rules miss arbitrary child images; complete control needs the traffic forced through the authenticated proxy.

## Emergency stop
Always available to the owner: `Stop-ScheduledTask ElevariqWorker` + `Stop-Process` of the worker tree's processes. Owner > worker, so the worker cannot prevent it. Independent of the broker.
