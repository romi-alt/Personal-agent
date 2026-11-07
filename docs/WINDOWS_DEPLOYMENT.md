# Windows 11 deployment

> **Status: NOT LIVE-TESTED.** The scripts below were reviewed statically and guarded by string/structure tests
> (`tests/unit/windows-scripts.test.ts`). **No PowerShell was available in the build environment** (an attempt to obtain
> one was blocked by the sandbox's security policy), so nothing has been parsed or executed by PowerShell, and no
> Windows machine has run this code. Treat Windows support as *unverified* until you complete the checklist at the end
> and report the results.

## What was reviewed and what changed

| Concern | Finding | Resolution |
|---|---|---|
| PowerShell syntax | Cannot be machine-checked here. Hand-reviewed for Windows PowerShell 5.1 compatibility: no `&&`, `??`, ternary; balanced braces/quotes (static test). | `verify-install.ps1` and `-WhatIf` let you check on the machine. |
| Working directory | The supervisor reads `.env` relative to the working directory. | Wrapper does `Set-Location $RepoPath`; the task also sets `-WorkingDirectory`. |
| Node detection | Task Scheduler may not see your interactive `PATH` (nvm/fnm/user installs). | Installer resolves `node.exe` once, checks it is >= 22.12, and embeds the **full path** in the task (`-NodePath`). |
| Logging paths | App logs go to `LOG_DIR` (default `%LOCALAPPDATA%\ElevariqAgent\logs\app`, rotated, redacted). Early failures (bad config) happen before the logger exists. | Wrapper captures child stdout/stderr to `...\logs\supervisor-stdout.log` / `supervisor-stderr.log` (truncated at 5 MB per restart) and sets `LOG_TO_CONSOLE=false` to avoid unbounded duplication. |
| Native stderr under `$ErrorActionPreference='Stop'` | In Windows PowerShell 5.1 this turns child stderr into terminating errors. | Child is launched with `Start-Process -RedirectStandard*` and the exit code is read. |
| Credential injection | Secrets must never be in the task definition. | Use user-level environment variables (`setx`) or the untracked `.env` (owner-only ACL). The task runs as you, so both are visible to it. For "run whether logged on or not", Windows loads your user environment too. |
| Startup/restart | Crash loops, invalid config. | Exit code policy: `0` graceful, `2` invalid config, `3` duplicate - **no restart**; any other exit restarts after 10 s doubling to 5 min (reset after 10 healthy minutes). Task Scheduler restart settings (999 x 1 min) are a second layer. |
| Duplicate supervisors | Two starts must not run work twice. | Three layers: Task Scheduler `MultipleInstances IgnoreNew`; the supervisor's database singleton lock (second start exits 3); atomic task claims (a second process could not double-run a task even if the lock failed). |
| Safe shutdown | Task Scheduler "End" is a hard kill; Windows has no POSIX `SIGTERM`. | `node dist\cli\index.js stop` sets a database flag the supervisor polls: it stops claiming, aborts the running work, checkpoints, releases leases, exits 0. `uninstall-task.ps1` does this before unregistering. After a hard kill/power loss, startup reconciliation resumes interrupted tasks (tested on Linux with SIGKILL). |
| Sleep / power | A sleeping or powered-off PC runs nothing. | See limits below; `verify-install.ps1` prints the AC sleep timeout. |

## Prerequisites

* Windows 11, Node.js **22.12 or newer** (x64), Git for Windows, this repository.
* `better-sqlite3` ships a prebuilt Windows x64 binary; if `npm ci` tries to compile it you need Visual Studio Build Tools.
* Keep the data folder (`AGENT_HOME`) on a **local NTFS disk** - not a network share or OneDrive-synced folder (SQLite WAL is unsafe there).
  Prefer a path outside OneDrive, e.g. `setx AGENT_HOME "C:\ElevariqAgent"`.

## Exact installation steps (PowerShell, normal user)

```powershell
# 0. Get the code (avoid zip downloads: they carry a "downloaded from the internet" mark that blocks scripts)
git clone https://github.com/romi-alt/Personal-agent.git C:\elevariq\personal-agent
cd C:\elevariq\personal-agent
# If you did download a zip:  Get-ChildItem -Recurse scripts | Unblock-File

# 1. Install and build
npm ci
npm run build

# 2. Configure (mock provider needs nothing; the real one needs the key and authorisation)
Copy-Item .env.example .env
icacls .env /inheritance:r /grant:r "$($env:USERNAME):(R,W)"      # owner-only
notepad .env      # set ANTHROPIC_API_KEY, EXECUTION_PROVIDER=claude, ALLOW_PAID_API=true, MAX_BUDGET_USD_PER_EXECUTION

# 3. Check the environment BEFORE installing the service
node dist\cli\index.js doctor
node dist\cli\index.js provider:status

# 4. Preview, then register the task (starts at your logon)
powershell -ExecutionPolicy RemoteSigned -File scripts\windows\install-task.ps1 -WhatIf
powershell -ExecutionPolicy RemoteSigned -File scripts\windows\install-task.ps1
Start-ScheduledTask -TaskName ElevariqPersonalAgent

# 5. Verify
powershell -ExecutionPolicy RemoteSigned -File scripts\windows\verify-install.ps1
```

Boot-time start without signing in (elevated PowerShell; prompts for your Windows password, which Task Scheduler stores):

```powershell
powershell -ExecutionPolicy RemoteSigned -File scripts\windows\install-task.ps1 -Trigger AtStartup -RunWhetherLoggedOnOrNot
```

## Verification checklist (please run and report each result)

| # | Step | Expected |
|---|---|---|
| 1 | `verify-install.ps1` | every line `PASS` |
| 2 | `node dist\cli\index.js status` | `Supervisor : IDLE`, heartbeat age a few seconds |
| 3 | `node dist\cli\index.js project:add --name Win Test` then `task:add ...` | task reaches `COMPLETED` with the mock provider |
| 4 | Start the task again via the scheduler: `Start-ScheduledTask` while running | no second supervisor (`Get-Process node` shows one agent process; second start exits quietly) |
| 5 | `node dist\cli\index.js stop` | supervisor exits; `status` shows `STOPPED`; the scheduled task does **not** restart it |
| 6 | `Start-ScheduledTask`, queue a slow mock task (`examples\mock-scenario.json` with a `hang` step), then `Stop-Process -Name node -Force` | task shows `RUNNING` until restart; after the wrapper restarts the supervisor (~10 s) `recovery` lists a `requeued_interrupted` action and the task resumes |
| 7 | Reboot / sign out and in | supervisor is running again (AtLogOn: after sign-in; AtStartup: after boot) and `status` shows recovered work |
| 8 | Put the PC to sleep for a few minutes, wake it | no task lost; `status` heartbeat resumes; tasks that were mid-run are reconciled |
| 9 | `npm test` on Windows | report failures: the suite was developed on Linux (symlink and signal tests may need adaptation) |
| 10 | Remove: `scripts\windows\uninstall-task.ps1` | graceful stop, task removed |

The repository's CI also contains an **experimental** `check-windows` job (build + tests on `windows-latest`, non-blocking). It exercises the
TypeScript code on Windows but **not** the Task Scheduler scripts.

## Operating limits

* The supervisor only works while the PC is **on, awake and online**. Set *Settings > System > Power > Screen and sleep* to "Never" on AC, and avoid hibernation, if you need uptime.
  Windows Update reboots will stop it (it comes back at logon/boot as configured).
* AtLogOn tasks stop when you **sign out**; use AtStartup + stored credentials for background operation across sign-outs.
* Hard stops (power loss, forced kill, Task Scheduler End) lose in-flight model work but never queue state; reconciliation resumes from the last checkpoint on the next start.
* No script disables Defender, UAC, the firewall or execution-policy protections; `RemoteSigned` is used per invocation only.
* For 24/7 reliability move the same code to the Ubuntu VPS (systemd unit in `scripts/linux`).
