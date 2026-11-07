# Environment Audit

Audit date: 2026-11-06. Everything in the "Detected" column was produced by read-only commands run in the build session
(`uname`, `node -v`, `claude --version`, `claude auth status`, `docker --version`, `curl` HEAD-style probes, etc.).
A dependency is labelled **Verified** only when a command succeeded; otherwise it is labelled **Not verified**.

> **Important context:** the Phase 1 build ran in a *Linux cloud sandbox* (Ubuntu 24.04), **not** on the owner's Windows 11
> machine. Findings below describe that sandbox. The Windows-specific items (Task Scheduler scripts, native Windows paths,
> WSL2) are listed as **Not verified on Windows** and must be re-checked on the target PC with `npm run agent -- doctor`.

## 1. Machine capabilities (sandbox where the code was built and tested)

| Item | Detected | Status |
|---|---|---|
| OS | Ubuntu 24.04.5 LTS, Linux 6.18 | Verified |
| CPU / arch | 4 vCPU, x86_64 | Verified |
| RAM | 16 GB total, ~15.5 GB free | Verified |
| Storage | 252 GB volume, ~29 GB available (writable allowance is session-limited) | Verified |
| Shell | bash | Verified |
| Node.js | v22.23.4 (project requires >= 22.12) | Verified |
| npm | 10.9.9 | Verified |
| pnpm / yarn | pnpm 10.28.0, yarn 1.22.22 present (not used; project uses npm) | Verified |
| Python | 3.13 (not required by the project) | Verified |
| Git | 2.43.0 | Verified |
| Claude Code CLI | 2.1.319 | Verified (`claude --version`) |
| Claude Code auth | `loggedIn: true`, `authMethod: oauth_token` (a subscription-style OAuth login that belongs to the sandbox session) | Verified; **left untouched** |
| `ANTHROPIC_API_KEY` | not set | Verified (absent) |
| Existing Claude config | `~/.claude` exists (plugins, sessions, cache); no `settings.json` | Verified; **not modified** |
| Docker | 29.9.2, Compose v5.6.1 installed (not used by this project) | Verified |
| WSL2 | not applicable (Linux host) | N/A |
| Process managers | `systemctl` binary present but systemd is **not PID 1** (`is-system-running: offline`); pm2 absent | Verified |
| Listening TCP ports | none detected via `/proc/net/tcp` | Verified |
| Network: npm registry | HTTPS 200 | Verified |
| Network: api.anthropic.com | reachable (HTTP 404 on `/`, i.e. TCP/TLS path works through the sandbox proxy) | Verified reachability only; no authenticated call was made |
| Existing dev directories | only this repository (`/home/user/Personal-agent`), initially empty | Verified |

## 2. Detected dependencies vs. requirements

| Requirement | Needed for | Result |
|---|---|---|
| Node >= 22.12 | runtime, `util.parseEnv`, `better-sqlite3` 13 (`engines >= 22`) | OK |
| Git | workspace isolation, checkpoints | OK |
| C toolchain / prebuilt binary for `better-sqlite3` | persistence | OK - installed and ran (`sqlite 3.53.4`) |
| Claude Code CLI | diagnostics only (`doctor`) | OK (optional) |
| `@anthropic-ai/claude-agent-sdk` | unattended provider | Installed 0.3.319; type definitions inspected; **no live call made** |
| Console API key | live provider | **MISSING** (blocker for live verification) |

## 3. Missing requirements / blockers

1. **Anthropic Console API key** (`ANTHROPIC_API_KEY`) - absent. Required for the unattended `claude` provider. Live-provider
   verification is therefore **BLOCKED** (see `docs/AUTHENTICATION.md` for setup).
2. **Explicit spending authorisation** - `ALLOW_PAID_API=true` and `MAX_BUDGET_USD_PER_EXECUTION > 0` are not configured (by design: default off).
3. **Windows 11 target machine** - not available in this session. Windows scripts exist but were never executed.
4. **Persistent host** - the sandbox is ephemeral and cannot run a 24/7 service (and systemd is not running in it).

## 4. Compatibility issues

* The existing Claude Code login is a subscription-type OAuth identity. Per the operating rules, the agent **does not** use it
  for unattended work; the SDK adapter strips `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_AUTH_TOKEN` from the child environment and
  aborts if the CLI reports any credential source other than `ANTHROPIC_API_KEY`.
* `node:sqlite` exists in this Node but is still experimental, so `better-sqlite3` was chosen (stable, synchronous, WAL).
  `better-sqlite3` ships prebuilt binaries for Windows x64 and Linux x64; on exotic platforms it compiles from source and needs
  a C++ toolchain (Visual Studio Build Tools on Windows).
* `npm audit`: **0 vulnerabilities in production dependencies**; 1 moderate advisory (minimatch DoS) reachable only through the
  ESLint dev-toolchain. The suggested fix downgrades ESLint (breaking), so it was not applied. It does not ship in the runtime.
* TypeScript 5.9 was chosen over TypeScript 7 because `typescript-eslint` 8.x targets the 5.x API.

## 5. Actual installations performed

Only project-local npm packages were installed (nothing global, no system packages, no changes to existing tools):

* runtime: `@anthropic-ai/claude-agent-sdk@0.3.319`, `better-sqlite3@13.0.3`, `zod@4.6.7`
* dev: `typescript@5.9.3`, `vitest@5.1.0`, `tsx@4.23.15`, `eslint@10.14`, `typescript-eslint@8.72`, `prettier@3.9`, `@types/*`

## 6. Recommended changes

* On the Windows 11 PC: install Node 22 LTS (or newer) and Git for Windows; run `npm ci && npm run build && npm run agent -- doctor`.
* Create a Console API key with a **workspace spend limit** in the Anthropic Console and set `MAX_BUDGET_USD_PER_EXECUTION` + `DAILY_BUDGET_USD`.
* Disable sleep/hibernate while plugged in (or run on an always-on Ubuntu VPS) - see `docs/OPERATIONS.md`.

## 7. Manual intervention required

* Provide the API key (owner action; never pasted into chat or committed).
* Review and run `scripts/windows/install-task.ps1 -WhatIf` on the Windows machine.

## 8. Suitability for local persistent operation

* **Sandbox:** NOT suitable (ephemeral container, no init system). Used for build and automated testing only.
* **Windows 11 PC:** Suitable *in principle* - the code is platform-neutral (path handling, no POSIX signals required for stop, detached launch uses `windowsHide`) -
  but **Not verified on Windows**. It will only run while the PC is on, awake, and online.
* **Ubuntu VPS:** Intended long-term target; the systemd unit passes `systemd-analyze verify` apart from the sandbox's missing `/usr/bin/node`, but was never started under a real systemd.

---

# Phase 1.5 re-check (2026-11-07)

* Same Linux sandbox class (Ubuntu 24.04, Node v22.23.4). `ANTHROPIC_API_KEY`, `EXECUTION_PROVIDER`, `ALLOW_PAID_API` and `MAX_BUDGET_USD_PER_EXECUTION` were **still absent from the session environment** after you added them to the cloud environment settings (those only reach *new* sessions). Live-provider verification therefore remains **BLOCKED**; no paid or API request was made.
* The sandbox's credential form refuses `api.anthropic.com` (Anthropic hosts are authenticated by the session), so the key has to be supplied as an environment variable at session start or used on your own machine.
* PowerShell is **not installed**; an attempt to obtain it was refused by the sandbox's execution policy and was not worked around. Windows scripts remain statically reviewed only.
* GitHub: repository admin permission is available, but the session proxy blocks repository-settings and branch-protection writes. `main` was created through a normal ref push.
