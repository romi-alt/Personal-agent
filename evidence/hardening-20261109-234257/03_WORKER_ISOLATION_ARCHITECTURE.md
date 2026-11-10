# 3. Worker-isolation architecture (P0)

**Status: PROPOSED DESIGN, NOT IMPLEMENTED, NOT YET DEMONSTRATED.** Nothing in this document is claimed to be secure. §3 lists the adversarial acceptance tests that must pass before any such claim. The harness for them already exists (`scripts/attacks.cjs`, `scripts/run-isolation-tests.ps1`).

## 3.1 Options evaluated on this host

| Option | OS-enforced? | Admin needed | Prototyped here | Result on DESKTOP-QGGLG8D | Verdict |
|---|---|---|---|---|---|
| **A. Command filter (V2/V2.1)** | **No**: administrative guardrail | No | Yes (branch) | 33 → 0 text bypasses; class S remains | Keep as defence in depth; **never a boundary** |
| **B. Low integrity level (same user)** | Yes, for *writes* (no-write-up) | No | No (would need an unsigned helper; see SAC) | [CODE/docs] Blocks writes to medium-IL files (DB, `.env`, checkout, policy, audit) but **not reads**: credentials stay readable | Insufficient alone (fails R2) |
| **C. AppContainer (+ job object)** | Yes: deny by default for files, registry, network, loopback | No | **Yes**: `scripts/sandbox-run.cs` | (1) Deny-by-default confirmed: the sandboxed process could not even `lstat E:\`, and could not read the synthetic credential file (probe C1 BLOCKED). (2) **Node.js child processes with pipes do not work**: libuv's named-pipe creation is refused inside the container and node spins at 100 % CPU (`evidence/isolation/debug-stderr.txt`). Claude Code, git, npm and test runners all depend on piped children. (3) **Smart App Control (enforce mode)** blocked the rebuilt unsigned launcher (Code Integrity events 3033/3077/3118, 2026-11-10 00:06). A production launcher must be code-signed | Strong boundary, but **not viable for Node-based workers today** without a pipe-capable runtime and a signed launcher. Revisit later |
| **D. Dedicated low-privilege Windows account + NTFS ACLs + broker** | **Yes**: a different SID; every child process inherits it | **Once**, at provisioning (owner) | Not executable here (not admin; needs owner authorization) | Design below. Host finding: `E:\` grants **Authenticated Users: Modify**, inherited by `E:\Agent\Personal-agent` and its `.env`. **Without an ACL fix, a dedicated account could modify production**. The fix is part of the design | **Recommended for V2.1** |
| **E. Disposable VM / Windows Sandbox / Hyper-V** | Yes (strongest) | Yes (feature enablement, possibly reboot) | No | 8 GB RAM host with ~1 GB available: a VM per worker is not affordable today (see the memory assessment) | Target for V3 / after a RAM upgrade or on a separate machine |
| **F. Linux VPS / container worker** | Yes | n/a | No | Out of scope (Linux unverified by owner decision) | Future |

## 3.2 Recommended design (Option D): "two principals and a broker"

```
                         ┌───────────────────── trusted: user Roman (owner) ─────────────────────┐
 Owner CLI / dashboard ──▶ Supervisor (node)                                                     │
                         │   agent.db, approvals, policy, audit   (%LOCALAPPDATA%\ElevariqAgent) │
                         │   Broker: performs APPROVED capabilities itself                        │
                         │     (git push, publish, deploy, network fetches on allow-list)         │
                         └──────────────▲───────────────────────────────┬────────────────────────┘
                                        │ results / requests (spool,     │ job spec (spool, ACL:
                                        │  ACL: worker write-only)       │  worker read-only)
                         ┌──────────────┴───────────────────────────────▼────────────────────────┐
                         │ untrusted: local user  elevariq-worker  (standard user, no admin)      │
                         │   Worker runner (scheduled task "ElevariqWorker", runs as this user)    │
                         │     └─ claude.exe ─ Bash / node / git / npm … (all inherit the SID)     │
                         │   Access: C:\ElevariqWork\<project> (Modify) only; own profile;         │
                         │   own Claude inference token (claude setup-token), revocable            │
                         └───────────────────────────────────────────────────────────────────────┘
```

### 3.2.1 Identities and ACLs (provisioning, run once by the owner as administrator)

| Object | Owner (Roman) | `elevariq-worker` | Notes |
|---|---|---|---|
| `%USERPROFILE%` of Roman (incl. `.claude`, Git Credential Manager store, browser profiles) | Full | **No access** (default profile ACL; verified: grants only SYSTEM, Administrators, Roman) | R2, A7 |
| `%LOCALAPPDATA%\ElevariqAgent` (DB, policy, audit, token, STOP-HOLD) | Full | **No access** (inside Roman's profile) | R1, R3, R8, A9 |
| `E:\Agent` (production checkout, `.env`, staging) | Full | **Explicit Deny (Write, Delete, ChangePermissions)** or remove the inherited `Authenticated Users: Modify` | R6. **Required**: today any authenticated user can modify `.env` (M6) |
| `C:\ElevariqWork` (new workspace root outside `E:\Agent` and the profile; created by the owner with inheritance disabled; existing workspaces under `%LOCALAPPDATA%\ElevariqAgent\workspaces` must be migrated) | Full | Modify on `C:\ElevariqWork\<project>` only, granted per project | R7 deny-by-default elsewhere |
| Spool `…\ElevariqAgent\spool\<exec>\in` | Write | Read | Job spec (prompt, limits, allowed tools) |
| Spool `…\spool\<exec>\out` | Read | Write (create files only) | Requests and results; the supervisor validates everything |
| Task Scheduler | Roman's task unchanged | Own task `ElevariqWorker`; **no rights** on Roman's tasks | R6 |
| Registry HKCU | Roman's hive | Own hive only | Persistence stays inside the worker's own account |
| Network | — | Outbound HTTPS (Claude API, package registries). Loopback to the dashboard: denied by binding the dashboard to Roman + a token **not** readable by the worker | Egress allow-listing by FQDN is not native to Windows Firewall; residual risk TH-12 |

### 3.2.2 How the requirements are met (by construction, pending tests)

| Req | Mechanism | Pending test (§3.3) |
|---|---|---|
| R1 No DB write | The DB lives in Roman's profile; the worker SID has no ACE | IT-D1..D4 |
| R2 No owner credentials | Roman's profile is unreachable. The worker holds its **own** revocable inference token, scoped to inference, in its own profile. *It is still a token of the owner's subscription*; abuse is limited to inference quota, and it can be revoked without touching the owner's login | IT-C1..C6 |
| R3 Cannot change its own permissions | The policy, settings, hook and job spec are written by Roman into locations the worker can read but not write; the hook verifies the policy sha256 (already implemented) | IT-P1 |
| R4 Approvals through a trusted boundary | The worker has **no** push/publish/deploy credentials. Approval-gated actions become **broker requests** (`out/request-<n>.json`); the supervisor records them as approvals; after the owner decides, the **supervisor** performs the action in its own identity and logs it. The command filter stays as a usability layer that turns early refusals into requests | IT-D4, IT-G1 |
| R5 No bypass via scripts, subprocesses or env | All descendants inherit the worker SID; nothing depends on `ELEVARIQ_WORKER` any more | C5, W6 |
| R6 No supervisor or task modification | ACL fix on `E:\Agent`; separate task; no admin | IT-P2..P8 |
| R7 Deny by default | Only explicit grants (workspace, spool-in read) | W1..W4 |
| R8 Durable audit | Supervisor-side records (stream `tool_use` with redacted input: **implemented**) + broker request log, in the DB the worker cannot reach | A1, A2 |

### 3.2.3 Launch mechanism without custom native code
Smart App Control blocks unsigned helpers, so the design uses only built-in, signed components:
1. **Provisioning (admin, once):** `New-LocalUser elevariq-worker` (random password stored in Roman's DPAPI-protected store), ACL changes from §3.2.1, and `Register-ScheduledTask ElevariqWorker` running as `elevariq-worker` with "run whether user is logged on or not" and S4U where possible.
2. **Per execution:** the supervisor writes the job spec to `spool\<exec>\in` and starts the worker task (`Start-ScheduledTask`; Roman may start a task he registered). The worker runner (node, run as `elevariq-worker`) starts `claude -p …` in the workspace with the inline settings, hook and policy hash, streams events into `spool\<exec>\out\events.jsonl`, and exits.
3. The **supervisor** tails `out\`, validates it, records the evidence in its DB, and enforces timeouts by stopping the worker task. A job object inside the worker runner provides kill-on-close and a memory cap.

**Open engineering questions (unverified):**
- Does Claude Code's own credential flow work for a non-interactive account (`claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`)?
- Does S4U allow the outbound TLS the CLI needs?
- What latency does the spool add?

## 3.3 Acceptance criteria before any "secure" claim
Run `scripts/run-isolation-tests.ps1` with a third mode, `worker-user`: the same `attacks.cjs`, launched as `elevariq-worker`. Pass criteria:
- every probe in classes credentials, database, approval, self-permission, supervisor-config, privileged, escape and audit is **BLOCKED**;
- the **baseline control in the same run shows SUCCEEDED** for the same probes, which proves the probes are real;
- functional probes F1–F5 **WORK**;
- the post-run fingerprints show no change to the synthetic DB, policy, `.env`, wrapper, audit, `STOP-HOLD` or registry;
- network probes N1 (loopback dashboard) are BLOCKED; N2 (outbound) is documented as allowed, as accepted residual.

Until then, every approval remains **advisory against a hostile worker** (SG-1 stays open).

