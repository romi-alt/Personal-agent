# 1. Security threat model: ELEVARIQ Personal Agent V2 → V2.1

**Date:** 2026-11-09/10. **Scope:** Windows 11 host DESKTOP-QGGLG8D; production V2 `e60278f` (unchanged by this work); hardening branch `feat/v2.1-hardening` @ `693058c` (local only, not pushed).

**Evidence labels used throughout:**
- **[VERIFIED]**: demonstrated in this assignment, with logs.
- **[CODE]**: read from source, not exercised.
- **[ASSUMED]**: not verified.

## 1.1 Assets

| # | Asset | Where (production) | Why it matters |
|---|---|---|---|
| A1 | Owner's Claude login (full account OAuth credential) | `%USERPROFILE%\.claude\.credentials.json` | Account takeover, subscription abuse |
| A2 | Agent database: approvals, tasks, audit history | `%LOCALAPPDATA%\ElevariqAgent\agent.db` | Writing to it = deciding the owner's approvals |
| A3 | Supervisor code and configuration | `E:\Agent\Personal-agent` (checkout, `dist\`, `.env`, `scripts\windows\run-supervisor.ps1`) | Code execution as the owner on every restart |
| A4 | Scheduled task `ElevariqPersonalAgent` | Task Scheduler (user task) | Persistence and availability |
| A5 | Per-execution policy file and decisions log | `%LOCALAPPDATA%\ElevariqAgent\run\*.policy.json` / `*.decisions.jsonl` | Widening own permissions; erasing denial evidence |
| A6 | Dashboard token / local API | `%LOCALAPPDATA%\ElevariqAgent\dashboard.token`, `127.0.0.1` | Owner-equivalent API access |
| A7 | Owner's other files, repositories, browser profiles | user profile, `E:\` | Data loss / theft |
| A8 | Git push credentials (Git Credential Manager) | Windows Credential Manager (user) | Publishing to GitHub as the owner |
| A9 | `STOP-HOLD` file | agent home | A worker creating it stops all automatic restarts (DoS) |

## 1.2 Trust boundaries (current V2)

```
 Owner (interactive)          Supervisor (node, user Roman)         Worker = claude.exe (user Roman)
 ─ CLI / dashboard ──────────▶ agent.db, approvals, scheduler ─────▶ Bash / Write / Edit / Read tools
                                        ▲                                  │ every child process,
                                        │  PreToolUse hook (text policy)   │ script and interpreter
                                        └──────────────────────────────────┘ runs as user Roman too
```

**There is exactly one OS security principal: user `Roman`, medium integrity.** Supervisor, workers, verification commands, the hook and the owner's own tools all share it **[VERIFIED: acl-check.txt, whoami, isolation baseline]**. Every "boundary" between owner and worker in V2 is therefore enforced by the agent's own code, not by Windows.

| Control | Type | Holds against | Fails against |
|---|---|---|---|
| `--tools` allow-list (no PowerShell, Agent or MCP tools) | Enforced by the Claude Code CLI | The model calling an unlisted tool | Nothing on the host: Bash is enough |
| Read/Write/Edit path checks | Hook, path-based | The file tools leaving the workspace | Bash `cat`, interpreters, scripts |
| Bash command policy (approval categories, agent-control deny, protected paths) | **Administrative text filter** | Literal, direct commands typed by a cooperative model | Script files, interpreters, indirection, encoding **[VERIFIED: 33 text bypasses in V2]** |
| `ELEVARIQ_WORKER` guard in the agent CLI | Environment variable | An accidental `approve` | `env -u`, or any script **[VERIFIED: baseline D4 recorded `decided_by=owner-cli`]** |
| Policy file `0o444` | File attribute (the owner may change it) | Accidental overwrite | `chmod` **[VERIFIED: baseline P1]** |
| libuv kill-on-close job | OS lifecycle | Orphaned worker trees when the supervisor dies | Not a security control |

**Distinction required by the mandate.** The Bash policy, the env guard and the 0o444 attribute are **administrative guardrails**. They reduce mistakes by a cooperative model. They are **not** security boundaries: the worker's OS identity has every right the owner has. A security boundary must be enforced by Windows (a different SID, an AppContainer, a VM), and must still hold when the worker runs arbitrary code.

## 1.3 Threat actors and entry points

| Actor | Capability | Entry point |
|---|---|---|
| T1 Cooperative model making a mistake | Types a destructive command in an unusual spelling | Bash tool |
| T2 Prompt-injected worker | Follows instructions planted in repository files, intake attachments, web pages (research), earlier task outputs, dependency READMEs | Any content the worker reads |
| T3 Malicious dependency | Code that runs during `npm install`/`npm test`/`npx` | Verification commands, worker test runs |
| T4 Local unprivileged user / malware as another user | `Authenticated Users: Modify` on `E:\` (inherited by the production checkout and `.env`) | Filesystem **[VERIFIED: icacls]** |

## 1.4 Threats (STRIDE), current exposure and V2.1 status

| ID | Threat | Actor | V2 exposure | V2.1 branch (implemented) | Needs OS isolation? |
|---|---|---|---|---|---|
| TH-1 | Worker self-approves by SQL on `agent.db` | T2/T3 | **Exploitable** [VERIFIED baseline D3] | Text: `agent.db` (also when concatenated) is denied; a script still works | **Yes** |
| TH-2 | Worker approves through the agent CLI with the env guard removed | T2 | **Exploitable**; recorded as `owner-cli` [VERIFIED baseline D4] | Text: `env -u`/`unset`/assignments of `ELEVARIQ_*` denied; globbed CLI path denied | **Yes** (a script can still do it) |
| TH-3 | Worker reads the owner's Claude credentials / exfiltrates them | T2/T3 | **Exploitable** via fs, cmd, bash, PowerShell, generated script [VERIFIED baseline C1–C5] | Text: `.credentials`, `~/.claude`, token variables and env dumps denied; Write/Edit content checked | **Yes** |
| TH-4 | Worker widens its own policy file | T2 | **Exploitable** [VERIFIED baseline P1] | **Mitigated:** the hook verifies the sha256 passed on its command line and fails closed; settings passed inline | No (integrity check) |
| TH-5 | Worker edits supervisor code / `.env` / wrapper | T2/T3/T4 | **Exploitable** [VERIFIED baseline P2/P3 on equivalent ACL] | Text: protected paths incl. globs/relative/cd; T4 needs the ACL fix | **Yes** + ACL fix |
| TH-6 | Worker stops the agent (`STOP-HOLD`) or registers persistence (Run key / task) | T2 | **Exploitable** [VERIFIED baseline P4, P7] | Text: `STOP-H*` globs, `schtasks`, `reg add`, `setx` need approval or are denied | **Yes** |
| TH-7 | Worker tampers with audit evidence | T2 | **Exploitable** [VERIFIED baseline A1/A2] | **Partially mitigated:** the supervisor records every tool call (redacted input) from its own stream view, so evidence no longer depends on the worker-writable decisions file. The DB itself is still writable by worker scripts | **Yes** |
| TH-8 | Destructive delete outside the workspace | T1/T2 | **Exploitable** [VERIFIED baseline W5/W6]; 7 spellings unflagged in V2 | Text: all recursive spellings need approval | **Yes** for scripts |
| TH-9 | Push / publish without approval | T1/T2 | `git -c alias`, `git config alias`, `npm run release` passed [VERIFIED probes] | Text: closed; package.json bodies evaluated | Credential-free worker identity |
| TH-10 | Approval for one category unlocks a combined command (rule-order short-circuit) | T1/T2 | `git push origin main && rm -rf ~` **allowed** once only `protected_branch_push` is approved; `npm publish && rm -rf ~` likewise [VERIFIED against V2 code: `evidence/approval-shortcircuit-check.txt`] | **Fixed:** every matching category must be approved | No |
| TH-11 | Owner-only CLI from verification commands (worker-written `npm test`) | T3 | Guard absent: verification env lacked `ELEVARIQ_WORKER` [CODE] | **Fixed (advisory):** `ELEVARIQ_WORKER=1`, control variables and `CLAUDE_CONFIG_DIR` stripped | **Yes** (env guard is advisory) |
| TH-12 | Network exfiltration (outbound HTTPS, loopback dashboard) | T2/T3 | Open [VERIFIED baseline N1/N2] | Not addressed by text policy | **Yes** + egress control |
| TH-13 | Escaping the job (detached grandchild outlives the worker) | T2 | Survived in baseline (not in a job when launched by the harness) [VERIFIED J1]. In production, workers sit in libuv's kill-on-close job [CODE] | No change | Job object with breakaway disabled |
| TH-14 | Prompt injection into the QA reviewer (diff and files passed verbatim) | T2 | [CODE] `qa.ts:711-731` | Not addressed (roadmap) | No (prompt fencing) |
| TH-15 | Local user T4 modifies `E:\Agent\Personal-agent\.env` | T4 | `Authenticated Users:(I)(M)` **[VERIFIED]** | Not changed (production change; owner action) | ACL fix |

## 1.5 Security objectives for V2.1 (from the mandate) and what can satisfy them

| Objective | A text policy can satisfy it? | Requires |
|---|---|---|
| R1 No direct write to the production DB | No | Different OS identity without access to `%LOCALAPPDATA%\ElevariqAgent` |
| R2 No access to the owner's Claude credentials | No | Different OS identity; the worker uses a separate, revocable inference token, or a broker holds it |
| R3 Cannot modify its own permissions | Partly (hash check) | Policy and hook outside the worker's write access |
| R4 Approvals pass a trusted boundary | No | Approval-gated capabilities (push, publish, deploy) performed by the supervisor on the worker's behalf; the worker has no credentials for them |
| R5 No bypass via scripts, subprocesses, env | No | The OS identity is inherited by every child process |
| R6 Cannot modify supervisor or scheduled task | No | OS identity + ACLs (`E:\` currently grants all authenticated users Modify) |
| R7 Deny by default | No | Allow-list ACL grants to the worker identity only |
| R8 Durable audit | Partly | Supervisor-side records (implemented) in a store the worker cannot write |

**Conclusion:** R1, R2, R4, R5, R6 and R7 **cannot** be met by any command filter. V2.1 hardening reduces accidental and low-effort bypasses. The architecture in `03_WORKER_ISOLATION_ARCHITECTURE.md` is required for the security properties, and it is **not yet demonstrated** on this host (see §3 of that document and `07_ADVERSARIAL_TEST_EVIDENCE.md`).
