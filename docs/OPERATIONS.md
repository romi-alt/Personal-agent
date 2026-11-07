# Operations

## Install & first run (any OS)

```bash
npm ci
npm run build              # compiles to dist/ (used by the service scripts)
cp .env.example .env       # then edit; keep it untracked
npm run agent -- doctor
npm run agent -- project:add --name "Demo School ERP"
npm run agent -- task:add --project demo-school-erp --title "Scaffold" --instructions "Create a README"
npm run agent -- start     # foreground; or: start --detach
```

Default provider is `mock` (no network, no cost). With the mock provider you can rehearse everything:
`MOCK_SCENARIO_FILE=examples/mock-scenario.json` scripts the outcomes per task title. For the mock, a sibling file `*.capacity.json`
(`{"available": false, "mode": "quota", "resetsInMs": 60000}`) can flip global availability while the supervisor runs.

## Commands

`doctor` · `start [--detach]` · `stop` · `status [--json]` · `health` (exit 0 only if live + auth ready) · `projects` · `project:add` · `workspaces` · `workspace:approve` ·
`tasks` · `task:add|show|pause|resume|cancel|retry|unblock` · `approvals|approve|deny` · `logs [--task|--project|--app|--execution]` · `recovery [--run]` · `integrations` · `memory:set|get`.

## Startup, shutdown

* **Start:** foreground `npm run agent -- start`; background `start --detach` (survives the terminal; it is *not* a service - use the scripts below for restart-on-boot).
* **Stop (graceful):** `npm run agent -- stop` (works on every OS: it sets a DB flag the supervisor polls), or SIGINT/SIGTERM. The supervisor stops claiming, aborts running work, checkpoints,
  releases leases, and exits 0. If it exceeds `SHUTDOWN_GRACE_MS` the leases expire and startup recovery repairs the task.
* Exit codes: `0` graceful, `3` another supervisor is live, `2` invalid configuration, `1` other failure.

## Windows 11 (Task Scheduler) - scripts provided, **not executed in the build environment**

```powershell
npm ci; npm run build
powershell -ExecutionPolicy RemoteSigned -File scripts\windows\install-task.ps1 -WhatIf   # review first
powershell -ExecutionPolicy RemoteSigned -File scripts\windows\install-task.ps1             # starts at your logon
# optional boot-time start without login (elevated PowerShell; prompts for your Windows password, stored by Task Scheduler):
powershell -ExecutionPolicy RemoteSigned -File scripts\windows\install-task.ps1 -Trigger AtStartup -RunWhetherLoggedOnOrNot
Start-ScheduledTask -TaskName ElevariqPersonalAgent
```

`run-supervisor.ps1` restarts the supervisor after crashes (10 s → 5 min backoff) but not after a graceful stop. The task also has Task Scheduler restart settings, no time limit, and runs hidden.
No Defender/UAC/firewall setting is changed. Uninstall: `scripts\windows\uninstall-task.ps1`.

**Power, sleep and restart limits:** nothing runs while the PC is off, asleep, hibernating or offline. Set *Sleep: Never* (when plugged in) if you need uptime;
Windows Update reboots will stop the supervisor - with `AtLogOn` it comes back only after you sign in again, with `AtStartup` it comes back on boot. After any wake/reboot the supervisor reconciles interrupted
work automatically. For true 24/7 use, move to the Ubuntu VPS.

## Linux / Ubuntu VPS (systemd) - unit verified with `systemd-analyze verify`, never started under real systemd

```bash
sudo mkdir -p /opt/elevariq-personal-agent && sudo cp -r . /opt/elevariq-personal-agent
cd /opt/elevariq-personal-agent && npm ci && npm run build
sudo scripts/linux/install.sh            # creates user elevariq-agent, /var/lib/elevariq-agent, /etc/elevariq-agent/agent.env
sudoedit /etc/elevariq-agent/agent.env   # add settings/credentials
sudo systemctl enable --now elevariq-agent
journalctl -u elevariq-agent -f
```

Runs as non-root, `Restart=on-failure` (not after a graceful stop or exit 3), `TimeoutStopSec=60`, state in `/var/lib/elevariq-agent` (database, workspaces, logs). Check `command -v node` matches `ExecStart`.
Not deployed anywhere by this project.

## Monitoring

* `npm run agent -- status` (supervisor liveness/heartbeat age, current task, queue, waiting tasks with eligibility time, last checkpoint, last error, auth readiness, provider state).
* `npm run agent -- health` → exit code for external monitors; or `HEALTH_PORT=8787` → `GET http://127.0.0.1:8787/health` (200/503, loopback only).
* `npm run agent -- logs --task <id>` (activity events), `--app` (tail of application log), `--execution <id>` (per-execution JSONL transcript).
* Logs: `LOG_DIR/app/agent-YYYY-MM-DD.log` (JSON lines, size-rotated at `LOG_MAX_FILE_MB`, deleted after `LOG_RETENTION_DAYS`), `LOG_DIR/executions/<execution-id>.jsonl` (≤5 MB each, same retention).
  Activity events in the database are not pruned automatically in Phase 1.

## Backups

State = `AGENT_HOME`: `agent.db` (+ `-wal`, `-shm`), `workspaces/`, `logs/`. Back up with the supervisor stopped, or use SQLite's online backup:
`sqlite3 agent.db ".backup 'backup.db'"` (needs the sqlite3 CLI), or copy `agent.db`, `agent.db-wal` and `agent.db-shm` **together**. Project code is in git inside `workspaces/`; push backups of those repos manually (the agent never pushes).

## Troubleshooting

| Symptom | Check |
|---|---|
| `error: Invalid configuration` (exit 2) | the listed variable; `.env.example` documents each |
| `Another supervisor … is active` (exit 3) | `status`; a crashed one frees the lock after `LEASE_TTL_MS` or immediately if its pid is dead |
| Tasks stay `WAITING_FOR_AUTHENTICATION` | `status` shows the missing items (key, `ALLOW_PAID_API`, budget); fix `.env`. A changed `ANTHROPIC_API_KEY` in `.env` is picked up live; `ALLOW_PAID_API` / budget changes need a supervisor restart (config is loaded once at start) |
| Tasks stay `WAITING_FOR_CAPACITY` | expected until `next_eligible_at`; `recovery` shows provider state and the reason (provider reset vs conservative wait) |
| Task `BLOCKED` | `task:show` → last error; budget/continuation/workspace problems need the owner |
| `better-sqlite3` fails to install | needs a prebuilt binary or a C++ toolchain; use Node LTS x64 |
| Nothing happens | is the supervisor live (`health`)? is `daily budget reached` in `logs --app`? |

---

# Phase 1.5 addendum - new commands and notes

```bash
npm run agent -- assignment:add --file examples/assignment.example.json   # validate + register (no tasks are created)
npm run agent -- project:status <project>      # lifecycle, spend, delivery-readiness table
npm run agent -- project:verify <project>      # independent checks + evidence
npm run agent -- project:accept <project> [--acknowledge-unverified "why"]
npm run agent -- project:deliver <project> --reason "..."     # records only; deploys nothing
npm run agent -- provider:status               # SDK / credentials / API access / budget / live execution / live recovery
npm run agent -- provider:verify --access      # non-billable key check
```

* New settings: `MAX_INTERRUPTIONS`, `MAX_PROVIDER_FAILURE_STREAK`, `EVENT_RETENTION_DAYS`, `VERIFY_COMMAND_TIMEOUT_MS` (see `.env.example`).
* A `BLOCKED` task with a `task.escalated` event means the agent stopped retrying on purpose: read `task:show`, fix the cause, then `task:unblock`.
* Windows: follow `docs/WINDOWS_DEPLOYMENT.md` (exact steps + verification checklist; **not live-tested**).
* GitHub: `main` is the baseline branch; see `docs/GITHUB_SETUP.md` for the two settings only an admin can change (default branch, protection).

---

# Phase 2 addendum - planning commands

```bash
npm run agent -- plan:start <project>        # start analyse -> architect -> decompose (read-only planning tasks)
npm run agent -- workflow:list | workflow:show <run>
npm run agent -- workflow:answer <run> --question Q-1 --text "..."    # blocking clarification questions
npm run agent -- workflow:resume <run> --assume                       # continue using the analysis' assumptions
npm run agent -- workflow:cancel <run>
npm run agent -- approve <approval-id>       # approve the generated plan (PLAN_APPROVAL=required)
npm run agent -- plan:show <project>         # requirements <-> tasks coverage, milestones
```

New settings: `PLAN_APPROVAL` (`required`|`auto`), `MAX_PLAN_TASKS`, `MAX_PLAN_REPAIRS`. A run that `FAILED` (invalid output after the repairs, or a failed planning task) leaves the project `BLOCKED`;
read `workflow:show`, fix the cause (assignment wording, budget, provider), then `plan:start` again. Planning uses the same budgets/caps as coding tasks, so check `provider:status` first.

---

# Session 3 addendum (2026-11-07) - project intelligence, QA, command center, operations

## Assign work in plain language

```bash
npm run agent -- intake "Build a complete educational ERP for Pakistani institutions." --attach spec.md
npm run agent -- workflow:show <run>          # intake -> analyse -> research -> architect -> decompose -> review -> approval
npm run agent -- research:show <project>      # findings: verified (cited source actually retrieved) vs assumption
npm run agent -- architecture:show <project>  # 11 areas; diagrams + ADRs are also written to docs/ in the project repo
npm run agent -- adr:list <project>           # significant decisions need your approval together with the plan
npm run agent -- review:show <project>        # deterministic + independent model planning review rounds
npm run agent -- approve <approval-id>        # approve plan + significant ADRs -> coding tasks are created
npm run agent -- roadmap <project>            # milestones, epics, critical path, progress counted from evidence only
npm run agent -- qa <project>                 # independent review per completed task, corrections, escalations
```

Settings: `RESEARCH_WEB_ACCESS` (default true; never when the assignment requires `web_access` approval),
`WRITE_PLAN_DOCS`, `INDEPENDENT_REVIEW` (default true), `MAX_CORRECTION_ROUNDS` (default 2).
A `qa_escalation` approval means the independent reviewer could not confirm a task after the correction rounds:
approve to accept it anyway (recorded as an owner override), deny to keep its dependants blocked.

## Command center

```bash
npm run agent -- dashboard                    # http://127.0.0.1:4317/  (DASHBOARD_PORT)
npm run agent -- dashboard:token [--rotate]   # owner token (stored in AGENT_HOME/dashboard.token)
```

Loopback only by default. Remote use: VPN or `ssh -L 4317:127.0.0.1:4317 host`; never bind 0.0.0.0 without a TLS
proxy (`DASHBOARD_ALLOW_REMOTE=true`, `DASHBOARD_ALLOWED_HOSTS`, `DASHBOARD_SECURE_COOKIES=true`). Every owner action
(pause/resume/priority/cancel/approve/deny/assign) is an audit event with actor, channel and address.

## Backups, restore, notifications

```bash
npm run agent -- backup                       # online backup + verification (AGENT_HOME/backups)
npm run agent -- backup:list
npm run agent -- backup:verify [file]         # restore drill: checksum, integrity_check, row counts
npm run agent -- stop && npm run agent -- restore <file> --reason "why"   # old DB kept as *.pre-restore-*
```

The supervisor backs up every `BACKUP_INTERVAL_HOURS` (24; 0 = off) and keeps `BACKUP_RETENTION` (14). Back up
`AGENT_HOME/workspaces` (git repositories) and the env file separately; the owner token is intentionally not in backups.
Errors, escalations and approval requests go to `AGENT_HOME/notifications.jsonl` and, only if you set it,
`NOTIFY_WEBHOOK_URL` (payload: type, severity, short title, ids - no task output or credentials).

## Windows background operation (verified on the owner PC, 2026-11-07)

`scripts\windows\install-task.ps1` registers a logon trigger plus a keepalive trigger (`-KeepAliveMinutes`, default 5)
that restarts the agent if the whole task process tree ends. `npm run agent -- stop` stops it until the next keepalive;
`npm run agent -- stop --hold` keeps it stopped until you run `start` explicitly. Live acceptance:
`powershell -ExecutionPolicy Bypass -File scripts\windows\scheduler-acceptance.ps1 [-RealCli]` (isolated task + home).
**Not automatable here:** verify after a real reboot + sign-in that `status` shows a live supervisor within 2 minutes.

## Ubuntu VPS (prepared, never deployed by the agent)

`sudo scripts/linux/install.sh` installs `elevariq-agent.service` (non-root `elevariq-agent`, hardened, state in
`/var/lib/elevariq-agent`) and the loopback-only `elevariq-dashboard.service`. Firewall: `ufw default deny incoming;
ufw allow OpenSSH; ufw enable`. For `EXECUTION_PROVIDER=claude-cli` install Claude Code for the service user and log
in once interactively (`sudo -u elevariq-agent -H bash -lc claude`, then `/login`); confirm with
`sudo -u elevariq-agent -H node dist/cli/index.js provider:status`. Moving from Windows: stop the agent, `backup`,
copy the backup + workspaces, `restore` on the VPS, start the service.
# Final stabilization addendum (2026-11-07)

## Scoped scratch-directory cleanup (replaces `rm -rf` for throw-away directories)

Recursive deletes from a worker still need owner approval (`destructive_delete`). For the one routine case - a
throw-away directory the worker created itself - workers get a scoped tool (CLI provider, when `dist/` is built):

```
"$ELEVARIQ_NODE" "$ELEVARIQ_SCRATCH_CLEAN" .qa-mut          # worker, inside its workspace
npm run agent -- scratch:clean <project> .qa-mut [--dry-run]  # owner, same checks
```

It deletes exactly one directory named `.qa-*`, `.scratch-*` or `.tmp-*` strictly inside the project workspace and
refuses: the workspace root, parents, anything outside the workspace (e.g. `E:\elevariq-ui-tmp`), `..`/wildcards/
variables/`~`, `.git` internals, links/junctions (target, ancestors, or anywhere inside), protected paths, trees over
50 000 entries, and any call without a valid AGENT_HOME. A missing directory returns `absent` (repeats are harmless).
Every call appends to `<AGENT_HOME>\logs\scratch-cleanup.jsonl`; the intent line is written before deletion.

## Production scheduled task

**Installed 2026-11-07 15:40 with the owner's authorisation** and running (verify-install: all checks passed).
`.env` was switched to `EXECUTION_PROVIDER=claude-cli`, `ENVIRONMENT=production` (old file: `.env.bak-20261107`).

Updating the code the task runs (rebuild) without leaving a stray supervisor outside the task:

```
node dist\cli\index.js stop --hold        # graceful; keepalive will not restart it
npm run build
node dist\cli\index.js start --detach     # clears the hold (runs outside the task for a moment)
node dist\cli\index.js stop               # graceful, no hold
Start-ScheduledTask -TaskName ElevariqPersonalAgent
node dist\cli\index.js health
```

(Removing `%LOCALAPPDATA%\ElevariqAgent\STOP-HOLD` by hand and running `Start-ScheduledTask` is equivalent.)
Remove the task: `powershell -File scripts\windows\uninstall-task.ps1`.

Browser tests of the command center: `npm run test:browser` (Playwright + installed Edge; isolated temp home).

Original install procedure, for reference / reinstallation. Preview:

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1 -WhatIf
```

Before installing, set in `E:\Agent\Personal-agent\.env` (with `EXECUTION_PROVIDER=mock` the task would run the
mock provider, not Claude Code; done on 2026-11-07):

```
EXECUTION_PROVIDER=claude-cli
ENVIRONMENT=production
```

Then `npm run build` and install (no restart is triggered):

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1
Start-ScheduledTask -TaskName ElevariqPersonalAgent
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\verify-install.ps1
node dist\cli\index.js status
```

What the task is: user `<PC>\<owner>`, Interactive logon, Limited run level; action `powershell.exe -File
scripts\windows\run-supervisor.ps1 -RepoPath E:\Agent\Personal-agent -NodePath "C:\Program Files\nodejs\node.exe"`;
working dir = repo; triggers = at logon of the owner + keepalive every 5 min; restart 999 x 1 min; no time limit;
`IgnoreNew` (one instance); starts and keeps running on battery; hidden. State: `%LOCALAPPDATA%\ElevariqAgent`
(`agent.db`, `logs\wrapper.log`, `logs\supervisor-std*.log`, app logs, `workspaces\`). Duplicate prevention: Task
Scheduler `IgnoreNew` + the supervisor lease (a second supervisor exits with code 3 and its wrapper only monitors).
Watchdog variables come from the app config (defaults on) and are injected per worker, not via the task.
The task runs the build in the repo working tree: switching branches or rebuilding changes what runs - stop the agent
(`stop --hold`) before doing either.

## Manual reboot verification (owner; not performed by the agent)

1. `node dist\cli\index.js status` before rebooting; note running/queued tasks.
2. Reboot normally, sign in.
3. Within ~2 minutes: `Get-ScheduledTask ElevariqPersonalAgent | Get-ScheduledTaskInfo` -> LastRunTime after the
   sign-in, LastTaskResult 267009 (running).
4. `node dist\cli\index.js health` exits 0; `status` shows a live supervisor.
5. `claude auth status` -> `loggedIn: true`, `authMethod: claude.ai`; `node dist\cli\index.js provider:status` ready.
6. `node dist\cli\index.js projects` / `tasks` -> same projects and tasks as before.
7. A task that was RUNNING before the reboot is recovered (`task:show <id>`: `interrupted` then re-queued/completed).
8. Exactly one supervisor: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -match 'cli\\index\.js"? start'`
   returns one process; `logs\wrapper.log` shows one `supervisor launched` after the boot (or `monitoring`).

## Claude Code health (checked 2026-11-07)

`claude doctor`: native install 2.1.319 (= latest published), "No installation issues found", auto-updates enabled
(channel latest), **last update attempt failed (install_failed)**. Doctor gives no further reason. Most likely cause
(inference, not confirmed): on Windows the running `claude.exe` (this interactive session, started 05:57) locks the
file the updater must replace. No action is required now - nothing newer exists. If a later update fails again: close
all Claude Code sessions, `stop --hold` the agent, run `claude update`, then `start`. Do not reinstall; the
subscription login lives in `%USERPROFILE%\.claude` and is not touched by an update.
`claude auth status`: logged in, `claude.ai`, Max. `loginExpiresAt` = 2026-12-04 - check `claude auth status` before
that date; an expired login stops all CLI workers (`provider:status` reports it).
