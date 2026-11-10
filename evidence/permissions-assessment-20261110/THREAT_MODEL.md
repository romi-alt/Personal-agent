# Threat model: ELEVARIQ V2.1 trusted execution on this Windows host

## 1. System and trust boundaries

```
 ┌──────────────── Owner identity: Roman (local admin, filtered token, Medium IL) ───────────────┐
 │ Production supervisor (task ElevariqPersonalAgent → run-supervisor.ps1 → node dist\cli)       │
 │ Owner Claude creds (~\.claude), DPAPI, Credential Manager, prod home (agent.db, backups)      │
 │ Owner's interactive tools: Claude Code sessions in E:\Agent, git, npm, elevated admin scripts │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
          ▲ approvals (owner only)                         ▲ TB-3: owner tooling reading worker output
 ┌─ Broker identity (PROPOSED: elv-stg-broker) ─┐          │
 │ broker code (admin-write only), signing key, │◄── TB-2 ─┤ request spool (worker create-only)
 │ approval state, signed audit chain           │          │
 └──────────────────────────────────────────────┘          │
 ┌─ Worker identity: elv-stg-worker (standard user, Medium IL) ─────────────────────────────────┐
 │ Claude CLI + node + git + npm + arbitrary dependency code, under the worker's own Claude login│
 │ Writable: its work/home only (TARGET). TODAY: also all of E:, F:, D:\src, C:\Download (P1–P4) │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
     TB-1: worker ↔ everything else on the host (NTFS DACLs, privileges, tokens)
     TB-4: worker ↔ network (SID-scoped firewall + egress proxy)
```

The **only** OS-enforced boundary between the worker and the owner is the Windows security identity: tokens, DACLs and privileges. Application-level policy (shell normalizer, capability checks, the broker's checks) runs **inside** or **alongside** the worker. It is a second layer and is never the boundary.

## 2. Assets

| Asset | Location | Property |
|---|---|---|
| A1 Owner credentials (Claude OAuth, Git Credential Manager, DPAPI) | `C:\Users\Roman\…` | Confidentiality |
| A2 Production code and task action | `E:\Agent\Personal-agent` (+ `dist`, `node_modules`, `scripts\windows`) | Integrity (it runs as the owner) |
| A3 Production policy | `E:\Agent\Personal-agent\.env` | Integrity, confidentiality |
| A4 Production DB and backups | `%LOCALAPPDATA%\ElevariqAgent` | C/I/A |
| A5 DB snapshots and evidence | 29 DBs and evidence packages under `E:\Agent\v2-staging`, `pilot-evidence` | C/I |
| A6 Broker code, configuration, signing key, approval state | Today: source on E:. Target: `C:\ElevariqStaging` (VHDX) | Integrity, key confidentiality |
| A7 Authoritative audit chain | Broker state dir (target) | Integrity, availability |
| A8 Privileged admin scripts | `E:\Agent\v2-staging\trusted-execution-…\admin-scripts` | Integrity (they run elevated) |
| A9 Owner personal and business data | E:, F:, `D:\src`, `C:\Download` | C/I |
| A10 Host availability (≈8 GB RAM, ≈1.2 GB free; prod memory gate already defers) | — | Availability |

## 3. Threat actors

| Actor | Capability assumed |
|---|---|
| T1 Misaligned or prompt-injected worker agent | Arbitrary code execution as the worker identity: shell, node, raw Win32 APIs through PowerShell/.NET, sockets |
| T2 Malicious dependency or repo content (npm `postinstall`, test fixtures, `.git/config` in a cloned repo) | The same as T1, possibly without the agent "intending" it |
| T3 Any other Authenticated-Users principal (compromised low-privilege service, future local account) | Same file access as T1 under today's ACLs |
| T4 Owner error (running worker-produced code as owner, approving misleading requests) | Confused deputy |

Out of scope, accepted residual risk: Windows kernel or driver zero-days; physical access; a compromised owner account (the owner is the root of trust).

## 4. Attack paths against the required properties: today, and after the plan

| # | Property the worker must NOT have | Attack path (T1/T2) | Today (simulated) | Control in the plan | After the plan (to be proven) |
|---|---|---|---|---|---|
| AP-1 | Read owner credentials | Open `C:\Users\Roman\.claude\.credentials.json`; dump DPAPI; read Credential Manager; read the memory of owner processes | **Blocked** by the profile ACL; process memory needs OpenProcess on Roman's processes (default DACL denies) | Unchanged + tests AT-01..05, AT-35 | Blocked, **once tested** |
| AP-1b | Same, indirectly | Hijack owner code (AP-3/AP-8), then read the credentials as the owner | **Possible** (E1/E2/E3) | Group DENY on E:/F:; admin scripts run from a verified admin-only copy | Blocked, once tested |
| AP-2 | Modify production repositories | Write `E:\Agent\Personal-agent\**`; rewrite `.git`; rename the checkout and plant a replacement | **Possible** (P1) | Group DENY on E:\ (inherited) + removal of explicit broad allows | Blocked |
| AP-3 | Read or modify production environment and policy | Read/edit `.env` (`PLAN_APPROVAL`, `ALLOW_PAID_API`, budgets) | **Possible** (P1) | Same | Blocked |
| AP-4 | Modify its own approval broker | Edit broker source on E: before build; edit installed broker code or config; read the HMAC key and forge approvals or audit entries; replace node.exe for the broker; edit the broker's scheduled task | Source **writable today**; no installed broker yet | Broker under a **separate identity** `elv-stg-broker`; code in an admin-write-only directory, hash-verified; key DPAPI-protected under the broker identity; worker DENY on broker dirs; task XML is admin-only | Blocked, once tested |
| AP-5 | Change security policies | Firewall rules, user rights, ACLs, local policy, task definitions, app policy files | OS policy needs admin (blocked); **app policy files writable** (AP-3) | No admin rights or WRITE_DAC; app policy behind the DENY; broker policy in the broker dir | Blocked |
| AP-6 | Tamper with authoritative audit records | Edit, truncate or delete the audit file; forge chain entries; delete evidence on E: | Prod DB in the owner profile is blocked; **evidence on E: writable** | Audit written only by the broker identity; worker DENY; periodic export of chain-head hashes to an owner-only location; evidence moves behind the DENY | Blocked, once tested |
| AP-7 | Reach unauthorized network destinations | Direct TCP/UDP, DNS exfiltration, IPv6, child processes, loopback services, SMB | **Unrestricted** (default outbound Allow) | SID-scoped block for the worker (complement of the allowlist, IPv4+IPv6) + loopback egress proxy with a hostname allowlist; loopback exposure inventoried | Restricted. Loopback behaviour **must be tested** |
| AP-8 | Create a process with greater privileges | (a) Plant code that a higher-privileged identity runs: the prod task script, `dist`, `node_modules`, `.claude` hooks, `.git` hooks, admin scripts, installers; (b) privilege abuse (SeImpersonate etc.); (c) token theft; (d) `schtasks /run` on owner tasks; (e) UAC bypass (needs admin group membership, which the worker lacks) | (a) **Possible: E1, E2, E3, E4**; (b)–(e) not available to a standard user (to be confirmed) | DENY removes (a); separately, the prod runtime moves to an admin-write-only directory (also fixes T3); tests AT-80..89 | Blocked, once tested |
| AP-9 | Confused deputy through worker output | The owner (or supervisor) runs `npm test`, `git`, or Claude Code **as the owner** inside a worker-written tree, and worker-planted scripts or config execute as the owner | Design risk in V2: verification commands run as the supervisor identity | **Rule:** worker-produced trees are only ever executed **as the worker** (or as a separate verifier identity), never as the owner. The owner inspects as data. Git `safe.directory` must stay unset for worker trees | Process control plus tests |
| AP-10 | Denial of service against production | Fill disks, exhaust RAM, kill PID 8992, `schtasks /end` | Disks E:/F: writable, so it can fill them; it cannot kill owner processes (to test) | Worker writes only to a size-capped VHDX; DENY on E:/F:; memory is **not capped by Windows per user** (residual: the supervisor should launch the worker under a Job Object memory limit) | Partially mitigated |
| AP-11 | Misleading approval requests | The worker asks for approval of an action described innocuously | App-level | The broker renders the **canonical action** (from `canonical.ts`), not the worker's text; approvals are single-use and action-bound | App layer (not OS) |

## 5. Residual risks after the recommended plan

1. **Shared kernel.** A Windows local privilege-escalation vulnerability breaks every non-VM design. Patch cadence is the mitigation. Only a VM removes this risk.
2. **Standard-user surface.** The worker can still write `C:\ProgramData\<new>`, `C:\Users\Public`, its own `%TEMP%`, and can reach loopback listeners and RPC (135). No owner or high-privilege component may load files from those locations (static review: none found today).
3. **Fail-open DENY.** An inherited DENY is overridden by any **explicit** allow for a broad group on a child, and does not reach children with protected DACLs. Mitigations: a pre-apply sweep (dirs **and files**), removal of P4, a periodic re-sweep test (AT-96), and the later allow-list hardening.
4. **New storage.** New volumes or USB drives get default ACLs that grant Authenticated Users access. Owner process: any new data volume receives the same group DENY.
5. **Memory starvation.** There is no per-user RAM quota without Job Objects.
6. **Network allowlisting is IP-based** unless the proxy is used. Firewall rules do not filter loopback (to be confirmed by AT-76).
7. **Owner as approver.** The worker can socially engineer approvals. This is mitigated, not eliminated, by canonical rendering.
