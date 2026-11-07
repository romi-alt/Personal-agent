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
